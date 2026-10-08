import { clusterApiUrl, Connection, type ConnectionConfig } from '@solana/web3.js'
import { getClientRpcEndpoint, getConfiguredNetwork, getServerRpcEndpoint } from '@/lib/solana/network'
import { createRpcTimeoutFetch } from '@/lib/solana/transport'

/**
 * Credential-free PubSub (WebSocket) endpoint used by every app Connection.
 *
 * `@solana/web3.js` derives the WebSocket URL from the HTTP endpoint whenever
 * `wsEndpoint` is omitted (`_rpcWsEndpoint = wsEndpoint || makeWebsocketUrl(endpoint)`).
 * The browser HTTP endpoint is the same-origin `/api/rpc` JSON-RPC proxy, which is
 * POST-only and cannot complete a WebSocket handshake — so the derived
 * `ws://<origin>/api/rpc` connection always fails and logs `ws error: undefined`.
 *
 * The app has no application-level WebSocket subscriptions; the only internal
 * subscriber is web3.js's own `confirmTransaction` signature subscription. An
 * explicit `wsEndpoint` (the only supported override in `ConnectionConfig` — there
 * is no disable flag) keeps that path on the public cluster PubSub endpoint for the
 * configured network, which carries no credential, instead of `/api/rpc`.
 */
function getClusterWsEndpoint(): string {
  const url = new URL(clusterApiUrl(getConfiguredNetwork()))
  url.protocol = 'wss:'
  return url.toString()
}

/**
 * Shared Connection configuration for the app-facing Solana RPC.
 * Keeps the existing default commitment behavior and replaces the default
 * fetch with a bounded-timeout fetch so an unresponsive RPC request cannot
 * hang forever (e.g. `connection.sendRawTransaction`).
 */
export const rpcConnectionConfig: ConnectionConfig = {
  fetch: createRpcTimeoutFetch(),
  wsEndpoint: getClusterWsEndpoint(),
}

export function createBrowserConnection(): Connection {
  return new Connection(getClientRpcEndpoint(), {
    ...rpcConnectionConfig,
    commitment: 'confirmed',
    disableRetryOnRateLimit: false,
  })
}

export function createServerConnection(): Connection {
  return new Connection(getServerRpcEndpoint(), {
    ...rpcConnectionConfig,
    commitment: 'confirmed',
    disableRetryOnRateLimit: false,
  })
}

export async function checkRpcHealth(connection: Connection): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await connection.getLatestBlockhash('confirmed')
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: formatRpcFailure(error),
    }
  }
}

function formatRpcFailure(error: unknown): string {
  if (error instanceof Error) {
    if (/fetch failed|network|ECONNREFUSED|timeout/i.test(error.message)) {
      return 'Unable to reach the Solana network. Check your internet connection or try again shortly.'
    }
    return error.message
  }
  return 'Unable to reach the Solana network.'
}

export { getConfiguredNetwork, getClientRpcEndpoint }
