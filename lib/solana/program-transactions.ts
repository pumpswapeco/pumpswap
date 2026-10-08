import { PublicKey, type Connection } from "@solana/web3.js"

/**
 * Structural shape of the versioned transaction responses we inspect. Defined
 * locally so this module stays free of circular imports (the activity / TVL
 * consumers import the value loader from here, while they only ever pass these
 * objects through).
 */
export type ProgramTx = {
  transaction: {
    message: {
      accountKeys: Array<string | { toString(): string }>
      instructions: Array<{
        accounts?: number[] | undefined
        data?: string | undefined
        programId?: string | unknown | undefined
        programIdIndex?: number | undefined
      }>
    }
  }
  meta?: {
    logMessages?: string[]
    innerInstructions?: Array<{
      index: number
      instructions: Array<{
        accounts?: number[] | undefined
        data?: string | undefined
        programId?: string | unknown | undefined
        programIdIndex?: number | undefined
      }>
    }>
  } | null
} | null

/** A single recent on-chain transaction involving the staking program. */
export interface ProgramTransaction {
  signature: string
  slot: number | null
  blockTime: number | null
  tx: ProgramTx
}

/**
 * Recent on-chain STAKING-PROGRAM transactions that involve `poolAddress`,
 * shared and de-duplicated across every consumer (Recent Activity, TVL history,
 * ...). Keyed by RPC endpoint + pool address with a short TTL and in-flight
 * de-duplication, so concurrent mounts (e.g. the analytics page rendering both
 * Recent Activity and the TVL chart) issue ONE getSignaturesForAddress followed
 * by at most one getTransaction per signature (small bounded concurrency)
 * instead of each consumer firing its own identical requests - a direct source
 * of the public-devnet RPC 429s.
 *
 * The signature scan is scoped to the POOL, not to the whole program: every
 * instruction these consumers care about (Stake / Unstake / ClaimRewards /
 * FundRewards) lists the pool as its second account, so the pool's signature
 * list always contains the pool's staking-program transactions. The consumers'
 * filters (staking program id + `accounts[1] === pool`) are unchanged, so the
 * rows are exactly the same while the per-signature getTransaction calls now
 * cover only transactions that can possibly match this pool - scanning the
 * whole program paid for every OTHER pool's transactions and made this pool's
 * history compete for the same 100-signature cap.
 *
 * The limit stays at 100: it is the same historical window as before, it is the
 * page size the public devnet endpoint accepts without the "Too many requests
 * for a specific RPC call" rejection, and lowering it could silently drop real
 * stake/unstake history from the TVL chart.
 *
 * There is intentionally no polling and no retry loop here: the shared cache
 * already prevents duplicate pressure, a rejected scan is memoized briefly so
 * navigating cannot instantly re-fire it, and callers surface an RPC error
 * rather than hammering the endpoint.
 */
const TTL_MS = 30_000
const FAILURE_TTL_MS = 12_000
const cache = new Map<string, { at: number; items: ProgramTransaction[] }>()
const inFlight = new Map<string, Promise<ProgramTransaction[]>>()
/**
 * Memoized failures per endpoint + pool address. When the latest scan is rejected
 * (e.g. HTTP 429 on public devnet), the SAME truthful error is returned without
 * re-issuing the identical getSignaturesForAddress + getTransaction scan for a
 * short window. This is request de-duplication, NOT a retry: it stops
 * navigating away/back from instantly re-firing a known-rate-limited request
 * while keeping the error visible. After the window a single fresh attempt is
 * made.
 */
const failures = new Map<string, { at: number; message: string }>()

export async function loadRecentProgramTransactions(
  connection: Connection,
  poolAddress: string,
): Promise<ProgramTransaction[]> {
  const key = `${connection.rpcEndpoint}|${poolAddress}`

  const failure = failures.get(key)
  if (failure && Date.now() - failure.at < FAILURE_TTL_MS) {
    throw new Error(failure.message)
  }

  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.items

  const active = inFlight.get(key)
  if (active) return active

  const promise = (async (): Promise<ProgramTransaction[]> => {
    // Pool-scoped, limit 100 (unchanged): every Stake / Unstake / ClaimRewards /
    // FundRewards instruction passes the pool as accounts[1], so this list is a
    // superset of the transactions the consumers' filters accept. Pool-adjacent
    // admin transactions (create_pool / pause_pool / set_pool_boost / ...) are
    // also returned and discarded by the exact same filters as before.
    const signatures = await connection.getSignaturesForAddress(new PublicKey(poolAddress), {
      limit: 100,
    })
    if (signatures.length === 0) return []

    // Fetch each signature with its own getTransaction call. The public devnet
    // endpoint rejects large batched getTransactions payloads with HTTP 429
    // ("Too many requests for a specific RPC call"), and the dedicated Helius free
    // tier rejects JSON-RPC batch arrays outright (HTTP 403 "Batch requests are
    // only available for paid plans"). Single-object calls are allowed on both.
    // A small bounded concurrency keeps the fetch fast, and any rejection
    // propagates exactly once (no retry loop); as before, the same error is
    // memoized briefly so a re-mount cannot instantly re-fire the heavy scan.
    const CONCURRENCY = 6
    const txs: Array<ProgramTx | null> = new Array(signatures.length)
    let next = 0
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, signatures.length) },
      async () => {
        while (next < signatures.length) {
          const i = next++
          const s = signatures[i]
          const tx = await connection.getTransaction(s.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
          txs[i] = (tx as unknown as ProgramTx | null)
        }
      },
    )
    await Promise.all(workers)

    return signatures.map((s, i) => ({
      signature: s.signature,
      slot: s.slot ?? null,
      blockTime: s.blockTime ?? null,
      tx: txs[i] ?? null,
    }))
  })()

  inFlight.set(key, promise)
  try {
    const items = await promise
    failures.delete(key)
    cache.set(key, { at: Date.now(), items })
    return items
  } catch (e) {
    // Keep the truthful RPC error (e.g. "429") but memoize it briefly so the
    // same heavy scan is not re-issued on the very next mount.
    failures.set(key, {
      at: Date.now(),
      message: e instanceof Error ? e.message : "Failed to load on-chain transactions",
    })
    throw e
  } finally {
    inFlight.delete(key)
  }
}
