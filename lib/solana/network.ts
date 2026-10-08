import { clusterApiUrl, type Cluster } from '@solana/web3.js'

export type SolanaNetworkId = 'devnet' | 'testnet' | 'mainnet-beta'

const NETWORK_IDS: SolanaNetworkId[] = ['devnet', 'testnet', 'mainnet-beta']

export function parseSolanaNetwork(value: string | undefined): SolanaNetworkId {
  if (value && NETWORK_IDS.includes(value as SolanaNetworkId)) {
    return value as SolanaNetworkId
  }
  return 'devnet'
}

export function getConfiguredNetwork(): SolanaNetworkId {
  return parseSolanaNetwork(process.env.NEXT_PUBLIC_SOLANA_NETWORK)
}

export function getNetworkLabel(network: SolanaNetworkId): string {
  switch (network) {
    case 'mainnet-beta':
      return 'Solana Mainnet'
    case 'testnet':
      return 'Solana Testnet'
    default:
      return 'Solana Devnet'
  }
}

export function getCluster(network: SolanaNetworkId): Cluster {
  return network
}

/**
 * RPC endpoint used by browser clients.
 *
 * The browser never receives a credentialed RPC URL: in the browser this
 * returns the absolute same-origin `/api/rpc` proxy, which forwards the
 * JSON-RPC request to the server-only endpoint (SOLANA_RPC_URL) without the URL
 * or its API key ever reaching the client. On the server - including the
 * prerender/SSR pass, where no browser origin exists - the server endpoint is
 * returned directly.
 */
export function getClientRpcEndpoint(network: SolanaNetworkId = getConfiguredNetwork()): string {
  if (typeof window === 'undefined') return getServerRpcEndpoint(network)
  return new URL('/api/rpc', window.location.origin).toString()
}

/**
 * Server-side RPC endpoint (Route Handlers, future indexer).
 * Prefer SOLANA_RPC_URL for paid providers; falls back to the public cluster
 * URL directly. It must not fall back to getClientRpcEndpoint(): in the browser
 * that resolves to the relative `/api/rpc` proxy, whose handler calls back into
 * this function, so an unset SOLANA_RPC_URL would recurse forever.
 */
export function getServerRpcEndpoint(network: SolanaNetworkId = getConfiguredNetwork()): string {
  const serverOverride = process.env.SOLANA_RPC_URL?.trim()
  if (serverOverride) return serverOverride
  return clusterApiUrl(getCluster(network))
}
