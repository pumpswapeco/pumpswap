import { fetchMetadataFromSeeds, mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata"
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults"
import { publicKey as umiPublicKey, type Umi } from "@metaplex-foundation/umi"
import type { Connection, PublicKey } from "@solana/web3.js"

import { getClientRpcEndpoint } from "@/lib/solana/network"
import { fetchMintAccount } from "@/lib/solana/token"

/**
 * Shared on-chain token metadata resolver.
 *
 * A single lazily-created Umi client (pointed at the project RPC) is shared by
 * every metadata consumer – pool stats, pools list, staking portal, pool
 * creation wizard – and on-chain Metaplex metadata + SPL mint decimals lookups
 * are cached with a short TTL. Previously each consumer created its own Umi
 * HTTP client and re-issued the same `fetchMetadataFromSeeds` / `getMint` RPC
 * calls, multiplying identical RPC traffic (a direct cause of HTTP 429s).
 */

export interface ResolvedTokenMeta {
  name: string
  symbol: string
  image?: string
}

let umiClient: Umi | null = null

/** Shared Umi client. Never creates a second RPC transport for metadata. */
export function getUmi(): Umi {
  if (!umiClient) umiClient = createUmi(getClientRpcEndpoint()).use(mplTokenMetadata())
  return umiClient
}

/** Strip null-padding and spaces from on-chain fixed-size strings. */
function clean(value: string): string {
  return value.replace(/\u0000/g, "").replace(/ /g, "").trim()
}

/** Only http(s) image links are rendered; anything else is dropped for safety. */
function isSafeImageUri(uri: string | undefined): uri is string {
  if (!uri) return false
  try {
    const protocol = new URL(uri).protocol
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

/**
 * Convert an ipfs:// reference to a fetchable https gateway URL.
 * Uses the Pinata gateway: ipfs.io is fronted by a Cloudflare browser
 * challenge and returns 403 to plain fetch() calls.
 */
function toGatewayUri(uri: string): string {
  if (uri.startsWith("ipfs://")) {
    return `https://gateway.pinata.cloud/ipfs/${uri.slice("ipfs://".length)}`
  }
  return uri
}

/** Fetch the off-chain metadata JSON and pull out a safe, loadable image URL. */
export async function resolveImageFromUri(uri: string): Promise<string | undefined> {
  const trimmed = clean(uri)
  if (!trimmed) return undefined
  const metadataUrl = toGatewayUri(trimmed)
  if (!isSafeImageUri(metadataUrl)) return undefined
  try {
    const res = await fetch(metadataUrl)
    if (!res.ok) return undefined
    const json = (await res.json()) as { image?: string }
    const image = json.image?.trim()
    if (!image) return undefined
    const loadable = toGatewayUri(image)
    return isSafeImageUri(loadable) ? loadable : undefined
  } catch {
    return undefined
  }
}

const METADATA_TTL_MS = 60_000
const metadataCache = new Map<string, { at: number; promise: Promise<ResolvedTokenMeta> }>()

/**
 * Resolves a mint's Metaplex name/symbol (and off-chain image) with request
 * deduplication: concurrent and recent callers share a single RPC + off-chain
 * metadata fetch. Rejects when the mint has no usable metadata so callers can
 * fall back to a shortened address.
 */
export function resolveTokenMeta(mint: PublicKey): Promise<ResolvedTokenMeta> {
  const key = mint.toBase58()
  const cached = metadataCache.get(key)
  if (cached && Date.now() - cached.at < METADATA_TTL_MS) return cached.promise

  const promise = (async (): Promise<ResolvedTokenMeta> => {
    const meta = await fetchMetadataFromSeeds(getUmi(), { mint: umiPublicKey(key) })
    const name = clean(meta.name)
    const symbol = clean(meta.symbol)
    if (!name && !symbol) throw new Error(`No metadata found for mint ${key}`)
    const image = await resolveImageFromUri(meta.uri)
    return { name: name || symbol, symbol: symbol || name, image }
  })()

  metadataCache.set(key, { at: Date.now(), promise })
  return promise
}

const MINT_DECIMALS_TTL_MS = 60_000
const mintDecimalsCache = new Map<string, { at: number; promise: Promise<number | null> }>()

/**
 * Cached SPL mint decimals read through the supplied (shared) Connection.
 *
 * The mint is unpacked with the token program that ACTUALLY owns it (classic
 * SPL Token or Token-2022), detected from the account itself - decimals for a
 * Token-2022 mint are never read through the legacy program.
 */
export function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number | null> {
  const key = `${connection.rpcEndpoint}|${mint.toBase58()}`
  const cached = mintDecimalsCache.get(key)
  if (cached && Date.now() - cached.at < MINT_DECIMALS_TTL_MS) return cached.promise

  const promise = fetchMintAccount(connection, mint)
    .then(({ mint: mintAccount }) => mintAccount.decimals)
    .catch(() => null)

  mintDecimalsCache.set(key, { at: Date.now(), promise })
  return promise
}