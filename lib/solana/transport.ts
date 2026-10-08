/**
 * Bounded HTTP transport for Solana RPC requests.
 *
 * `@solana/web3.js` 1.98.4 does NOT expose a per-request `timeout` option in
 * `ConnectionConfig` (verified against the installed typings: only `fetch`,
 * `fetchMiddleware`, `httpAgent`, `httpHeaders`, `commitment`, `wsEndpoint`,
 * `disableRetryOnRateLimit`, and `confirmTransactionInitialTimeout` exist).
 * The supported hook for bounding request duration is the custom `fetch`
 * option — every JSON-RPC call (including `sendTransaction`) is routed through
 * `createRpcClient(url, httpHeaders, customFetch, ...)` and invoked as
 * `fetch(url, options)`. This wrapper adds an AbortController deadline so an
 * unresponsive RPC cannot make a request hang forever.
 */

/** Upper bound (milliseconds) for a single JSON-RPC HTTP request. */
export const RPC_HTTP_TIMEOUT_MS = 30_000

/**
 * Wraps `fetch` with a hard timeout. Any caller-supplied `AbortSignal` is
 * still honored (the internal controller aborts when either the deadline
 * fires or the external signal aborts).
 */
export function createRpcTimeoutFetch(
  timeoutMs: number = RPC_HTTP_TIMEOUT_MS,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const controller = new AbortController()
    const externalSignal = init?.signal

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`Solana RPC request timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const onExternalAbort = () => controller.abort(externalSignal?.reason)
    const cleanup = () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason)
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true })
      }
    }

    const requestInit: RequestInit = init
      ? { ...init, signal: controller.signal }
      : { signal: controller.signal }

    return baseFetch(input, requestInit)
      .catch((error: unknown) => {
        if (timedOut) {
          throw new Error(`Solana RPC request timed out after ${timeoutMs}ms`)
        }
        throw error
      })
      .finally(cleanup)
  }
}

/**
 * Matches the transport-level failures a JSON-RPC read can fail with when the
 * network hop itself breaks — NOT application/program errors:
 *
 *  - `TypeError: fetch failed` (undici/Node fetch: connection reset, DNS, TLS,
 *    socket closed by the peer) — the exact failure observed on devnet reads
 *  - the bounded-fetch timeout message from `createRpcTimeoutFetch`
 *  - the `/api/rpc` proxy's 502 body (`RPC upstream request failed`) and
 *    web3.js's `HTTP error (5xx)` wrapping of it
 *  - rate limiting (429 / "too many requests") and socket-level ECONN* errors
 *
 * Used to (a) decide whether an RPC read may be retried and (b) produce an
 * honest user-facing message that does NOT blame the caller's inputs for a
 * connectivity problem.
 */
const TRANSIENT_RPC_ERROR_PATTERN =
  /fetch failed|timed out|timeout|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed|upstream request failed|HTTP error \(5\d\d|status code 5\d\d|too many requests|HTTP error \(429|status code 429|failed to fetch/i

/** True when `error` is a transient RPC transport failure (safe to retry). */
export function isTransientRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return TRANSIENT_RPC_ERROR_PATTERN.test(error.message)
}

/**
 * Runs a single RPC READ, retrying transient transport failures with a short
 * exponential backoff.
 *
 * Scope: READS ONLY (`getAccountInfo` and friends) that are idempotent by
 * definition — this is deliberately never used around transaction signing or
 * submission, whose fresh-blockhash send path must stay single-attempt.
 * Non-transient errors (e.g. a malformed response) are rethrown immediately.
 */
export async function withRpcRetry<T>(
  read: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 400
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await read()
    } catch (error) {
      lastError = error
      if (!isTransientRpcError(error) || attempt === attempts - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt))
    }
  }
  throw lastError
}