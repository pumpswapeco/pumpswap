import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint, type Mint } from '@solana/spl-token'
import type { Connection } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import { getUserFacingMintError } from '@/lib/solana/errors'
import { tryParsePublicKey } from '@/lib/solana/format'
import { withRpcRetry } from '@/lib/solana/transport'

/** On-chain SPL mint fields used by pool setup and future APIs. */
export type TokenMintInfo = {
  address: string
  decimals: number
  supply: string
  mintAuthority: string | null
  freezeAuthority: string | null
  tokenProgramId: string
}

export type TokenMintValidationResult =
  | { ok: true; mint: TokenMintInfo }
  | { ok: false; error: string }

export type TokenMetadataExtension = {
  symbol?: string
  name?: string
  logoUri?: string
}

/**
 * The two token programs the deployed Anchor program accepts: its accounts are
 * declared with `token_interface`, so every pool may use classic SPL Token or
 * Token-2022 for its staking mint and/or its reward mint.
 */
export const SUPPORTED_TOKEN_PROGRAM_IDS: readonly PublicKey[] = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]

/** True when `programId` is one of the token programs the on-chain program supports. */
export function isSupportedTokenProgram(programId: PublicKey): boolean {
  return SUPPORTED_TOKEN_PROGRAM_IDS.some((supported) => supported.equals(programId))
}

const TOKEN_PROGRAM_TTL_MS = 5 * 60_000
const tokenProgramCache = new Map<string, { at: number; promise: Promise<PublicKey> }>()

/**
 * Detects the token program that OWNS a mint account.
 *
 * The owner is read from the chain and validated against the supported set -
 * classic SPL Token is never assumed, so a Token-2022 mint (whose ATA address,
 * account reads and transfers all require Token-2022) is handled correctly.
 * Results are cached with a short TTL because every transaction/read path needs
 * the same answer; a failed lookup is never cached, so the next caller retries.
 */
export function resolveMintTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const key = `${connection.rpcEndpoint}|${mint.toBase58()}`
  const cached = tokenProgramCache.get(key)
  if (cached && Date.now() - cached.at < TOKEN_PROGRAM_TTL_MS) return cached.promise

  const promise = (async (): Promise<PublicKey> => {
    // Retried on transient transport failures only (`fetch failed`, timeouts,
    // proxy 502, 429): a dropped connection while reading the mint owner must
    // not fail a flow that would otherwise succeed. A missing account returns
    // `null` (never an exception), so a genuine "not a mint" verdict is never
    // retried or masked.
    const accountInfo = await withRpcRetry(() => connection.getAccountInfo(mint, 'confirmed'))
    if (!accountInfo) {
      throw new Error('Could not find account')
    }
    if (!isSupportedTokenProgram(accountInfo.owner)) {
      throw new Error('Account is not an SPL Token mint')
    }
    return accountInfo.owner
  })()

  promise.catch(() => tokenProgramCache.delete(key))
  tokenProgramCache.set(key, { at: Date.now(), promise })
  return promise
}

/** A mint account read together with the token program that owns it. */
export type MintAccountRead = {
  mint: Mint
  tokenProgramId: PublicKey
}

/**
 * Reads a mint account in a single RPC round-trip and unpacks it with the token
 * program the account is ACTUALLY owned by (classic SPL Token or Token-2022).
 * Used by every decimals/metadata read so a Token-2022 mint is never unpacked
 * through the legacy program.
 */
export async function fetchMintAccount(connection: Connection, mint: PublicKey): Promise<MintAccountRead> {
  // Same transient-failure retry as resolveMintTokenProgram: a dropped
  // connection during this read must not masquerade as a bad mint.
  const accountInfo = await withRpcRetry(() => connection.getAccountInfo(mint, 'confirmed'))
  if (!accountInfo) {
    throw new Error('Could not find account')
  }
  if (!isSupportedTokenProgram(accountInfo.owner)) {
    throw new Error('Account is not an SPL Token mint')
  }
  return { mint: unpackMint(mint, accountInfo, accountInfo.owner), tokenProgramId: accountInfo.owner }
}

/**
 * Fetches SPL mint account data from the chain, including the token program
 * that owns it (classic SPL Token or Token-2022).
 * Compatible with swapping in Helius DAS / token metadata later via enrichTokenMetadata().
 */
export async function fetchTokenMintInfo(connection: Connection, mintAddress: string): Promise<TokenMintInfo> {
  const pubkey = tryParsePublicKey(mintAddress)
  if (!pubkey) {
    throw new Error('Invalid public key')
  }

  const { mint, tokenProgramId } = await fetchMintAccount(connection, pubkey)

  return {
    address: pubkey.toBase58(),
    decimals: mint.decimals,
    supply: mint.supply.toString(),
    mintAuthority: mint.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
    tokenProgramId: tokenProgramId.toBase58(),
  }
}

export async function validateSplTokenMint(
  connection: Connection,
  mintAddress: string,
): Promise<TokenMintValidationResult> {
  try {
    const mint = await fetchTokenMintInfo(connection, mintAddress)
    return { ok: true, mint }
  } catch (error) {
    return { ok: false, error: getUserFacingMintError(error) }
  }
}

/**
 * Optional metadata layer (off-chain / indexer). No-op in Phase 1 unless extended.
 */
export async function enrichTokenMetadata(
  mint: TokenMintInfo,
  _options?: { metadataProvider?: 'helius' | 'rpc' },
): Promise<TokenMintInfo & { metadata?: TokenMetadataExtension }> {
  return { ...mint, metadata: undefined }
}

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, PublicKey }
