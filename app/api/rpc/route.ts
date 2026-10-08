import { getServerRpcEndpoint } from "@/lib/solana/network"
import { createRpcTimeoutFetch } from "@/lib/solana/transport"

/**
 * Same-origin JSON-RPC proxy.
 *
 * The browser talks to this route instead of a credentialed provider URL, so
 * the server-only endpoint (SOLANA_RPC_URL) and its API key never leave the
 * server. Only POST is accepted, an Origin header (when the browser sends one)
 * must match this app, and the upstream request is bounded by a hard timeout.
 * The endpoint URL and its credential are never echoed back in a response or in
 * an error.
 */

export const dynamic = "force-dynamic"

/** Upper bound (ms) for one upstream JSON-RPC round trip. */
const UPSTREAM_TIMEOUT_MS = 30_000

/** Bounded upstream transport, reusing the app-wide RPC timeout wrapper. */
const upstreamFetch = createRpcTimeoutFetch(UPSTREAM_TIMEOUT_MS)

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
} as const

/** Nothing but POST is valid here (and nothing may be cached). */
function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { ...JSON_HEADERS, allow: "POST" },
  })
}

export function GET(): Response {
  return methodNotAllowed()
}

export function HEAD(): Response {
  return methodNotAllowed()
}

export function PUT(): Response {
  return methodNotAllowed()
}

export function PATCH(): Response {
  return methodNotAllowed()
}

export function DELETE(): Response {
  return methodNotAllowed()
}

export function OPTIONS(): Response {
  return methodNotAllowed()
}

/**
 * The app origin the request must have come from, derived from the forwarded
 * host/proto when a proxy (or `next dev`) supplies them so it matches the
 * origin the browser used for `new URL("/api/rpc", window.location.origin)`.
 * Returns null when the Host header is missing.
 */
function appOrigin(request: Request): string | null {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  if (!host) return null
  const forwardedProto = request.headers.get("x-forwarded-proto")
  const proto =
    forwardedProto?.split(",")[0]?.trim() || new URL(request.url).protocol.replace(/:$/, "")
  return `${proto}://${host.split(",")[0].trim()}`
}

export async function POST(request: Request): Promise<Response> {
  // Same-origin only: a cross-origin page must not be able to spend the
  // server's RPC credential through this proxy.
  const origin = request.headers.get("origin")
  if (origin) {
    const expected = appOrigin(request)
    if (!expected || origin !== expected) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: JSON_HEADERS,
      })
    }
  }

  let payload: string
  try {
    payload = await request.text()
  } catch {
    return new Response(JSON.stringify({ error: "Unreadable request body" }), {
      status: 400,
      headers: JSON_HEADERS,
    })
  }

  // The body is forwarded byte-for-byte (never re-serialized); this check only
  // rejects traffic that is not a JSON-RPC request, e.g. a stray form post.
  try {
    const parsed = JSON.parse(payload) as { method?: unknown }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.method !== "string") {
      throw new Error("not a JSON-RPC request")
    }
  } catch {
    return new Response(JSON.stringify({ error: "Expected a JSON-RPC request body" }), {
      status: 400,
      headers: JSON_HEADERS,
    })
  }

  const upstreamUrl = getServerRpcEndpoint()

  try {
    const upstream = await upstreamFetch(upstreamUrl, {
      method: "POST",
      // Only the JSON content type is forwarded: no cookies, no Authorization
      // header, and no other client-controlled header reaches the provider.
      headers: { "content-type": "application/json" },
      body: payload,
      cache: "no-store",
    })

    const body = await upstream.text()
    return new Response(redact(body, upstreamUrl), {
      status: upstream.status,
      headers: {
        ...JSON_HEADERS,
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    })
  } catch (error) {
    // Deliberately opaque to the caller: the response below never contains the
    // upstream URL, its query string or an API key (the thrown error can
    // contain the request URL). The cause is only written to the server log,
    // and it is stringified because the dev-mode structured log renders a
    // second object argument as "{}", which would discard every field.
    console.error("[RPC proxy] upstream request failed", JSON.stringify(upstreamFailureDetails(error, upstreamUrl)))
    return new Response(JSON.stringify({ error: "RPC upstream request failed" }), {
      status: 502,
      headers: JSON_HEADERS,
    })
  }
}

/**
 * A `…key=…` / `…token=…` / `…secret=…` pair inside free-form error text. Some
 * failures (e.g. an invalid upstream URL) echo the whole URL, credential
 * included, back inside the message, so the text is scrubbed before logging.
 */
const CREDENTIAL_IN_TEXT = /[-_.a-z0-9]*(?:key|token|secret|password)[-_.a-z0-9]*=[^\s&,;"']*/gi

/**
 * The only fields ever written to the server log for a failed upstream call:
 * name, message and (when present) the cause code. The endpoint is removed
 * from every value, so neither it nor its credential can be logged even when
 * the error text quotes it.
 */
function upstreamFailureDetails(
  error: unknown,
  endpoint: string,
): { name: string; message: string; causeCode?: string } {
  const scrub = (text: string) => redact(text, endpoint).replace(CREDENTIAL_IN_TEXT, "[redacted]")

  const cause: unknown =
    typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined
  const code: unknown =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { code?: unknown }).code
      : cause

  const details: { name: string; message: string; causeCode?: string } = {
    name: error instanceof Error ? error.name : typeof error,
    message: scrub(error instanceof Error ? error.message : String(error)),
  }

  if (typeof code === "string" || typeof code === "number") {
    details.causeCode = scrub(String(code))
  }

  return details
}

/** Defensive scrub so an upstream body can never leak the credential. */
function redact(body: string, endpoint: string): string {
  return body.includes(endpoint) ? body.split(endpoint).join("[redacted]") : body
}
