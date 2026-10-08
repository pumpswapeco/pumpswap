"use client"

import { useEffect, useSyncExternalStore } from "react"
import { useConnection } from "@solana/wallet-adapter-react"
import type { Connection, PublicKey } from "@solana/web3.js"

import { getMintDecimals, resolveTokenMeta } from "@/lib/solana/metadata"
import type { PoolAccount, UserPositionAccount } from "@/lib/solana/ops"
import type { StakingProgram } from "@/lib/solana/program"
import { useStakingProgram } from "@/lib/solana/use-staking-program"
import { shortenAddress } from "@/lib/solana/format"
import type { PoolStatus, RealPool } from "@/lib/solana/pool-types"

export interface PoolAggregate {
  /** Number of UserPosition accounts (active stakers). */
  stakers: number
  /** Sum of totalClaimed across all positions (reward base units). */
  claimed: bigint
}

export interface PoolStats {
  loading: boolean
  error: string | null
  pools: RealPool[]
  /**
   * Aggregates keyed by pool address.
   *
   * `null` means the UserPosition aggregate READ FAILED (see
   * `aggregatesError`) and no staker/claimed number may be shown. This is
   * deliberately distinct from a successful read with no positions, which
   * produces a real entry per pool with zero counts.
   */
  aggregates: Record<string, PoolAggregate> | null
  /**
   * Explicit aggregate READ error, set ONLY when the UserPosition
   * getProgramAccounts/aggregation step failed. Pool discovery failures use
   * `error` instead and leave `pools` (and pool selection) untouched.
   */
  aggregatesError: string | null
  /** Total active stakers across all pools; null when the aggregate read failed. */
  totalStakers: number | null
  /**
   * Total rewards claimed across all pools (mixed-mint base units); null when
   * the aggregate read failed.
   */
  totalClaimed: bigint | null
}
const EMPTY_STATE: PoolStats = {
  loading: true,
  error: null,
  pools: [],
  aggregates: null,
  aggregatesError: null,
  totalStakers: null,
  totalClaimed: null,
}

/**
 * Pool stats are read-only on-chain data shared by the dashboard, analytics,
 * rewards pages, `useUserRewards` and `useTvlHistory`. Before this change every
 * `usePoolStats()` call created an independent hook instance with its own fetch
 * (analytics mounted 3, dashboard/rewards 2) -> the identical pool accounts,
 * mint metadata, mint decimals and user-position aggregations were requested
 * N times concurrently, overflowing the RPC's rate limit (HTTP 429s).
 *
 * This module keeps a single module-scoped store: the first subscriber starts
 * one fetch, every other concurrent/recent subscriber reuses it, and the result
 * is cached for a short TTL so a page visit within the TTL costs zero RPC calls.
 * There is no polling - on-chain data is refreshed at most once per navigation.
 */
const POOL_STATS_TTL_MS = 30_000

let snapshot: PoolStats = EMPTY_STATE
let snapshotConnection: Connection | null = null
let snapshotUpdatedAt = 0
let inFlight: Promise<void> | null = null
/**
 * Monotonic counter for every load issued against this store. Only the LATEST
 * load may write `snapshot`; a stale load that resolves after an admin
 * invalidation must never overwrite the post-mutation state.
 */
let loadEpoch = 0
/**
 * Set by invalidatePoolStats() (admin mutations: pause / freeze / restore).
 * Bypasses the TTL cache and avoids joining an already-running (possibly
 * pre-mutation) fetch, so the post-mutation on-chain state always wins.
 */
let forceReload = false
/** Last program used to load the store, needed by invalidatePoolStats() to reload. */
let lastProgram: StakingProgram | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): PoolStats {
  return snapshot
}

/** Derive a display label from the staking token's real metadata (never a fake name). */
function poolDisplayName(staking: { name: string; symbol: string }): string {
  if (staking.name && staking.name !== staking.symbol) return staking.name
  return `${staking.symbol} Staking`
}

/**
 * Minimal structural view of the Anchor `pool` account client. Its `coder` is
 * used for the raw scan in {@link loadAllPools}.
 */
interface AnchorPoolClient {
  programId: PublicKey
  provider: { connection: Connection }
  coder: {
    accounts: {
      /** `{ offset: 0, bytes: <base58 discriminator> }` for the account type. */
      memcmp(name: string): { offset: number; bytes: string }
      decode(name: string, data: unknown): PoolAccount
      /**
       * Encoded size of the account INCLUDING the 8-byte discriminator, so it
       * is directly comparable to `account.data.length`. Present in the
       * installed anchor version; optional so the guard degrades to
       * decode-success instead of breaking.
       */
      size?(name: string, account: PoolAccount): number
    }
  }
}

/** One Pool account that decoded cleanly with the CURRENT on-chain layout. */
type LoadedPool = { publicKey: PublicKey; account: PoolAccount }

/**
 * Reads every Pool account in ONE getProgramAccounts call (account-discriminator
 * memcmp) and decodes the accounts INDIVIDUALLY.
 *
 * `program.account.pool.all()` cannot be used here: anchor decodes every
 * account inside a single `.map()`, so ONE account written by an older program
 * layout aborts the entire call. This deployed program really contains such
 * accounts - the two pre-NFT pools are 229 bytes and have no `nft_collection` /
 * `nft_boost_bps`, so decoding them with the current 263-byte layout runs past
 * the end of the buffer while reading `nftBoostBps` (surfaced in the browser as
 * "Trying to access beyond buffer length"). Verified live: `.all()` throws on
 * this program while the guarded scan below returns the real pools.
 *
 * Undecodable / differently-sized accounts are therefore OMITTED from the
 * usable list and logged with their byte length - never silently trusted, and
 * never filled in with fabricated fields. Current-layout pools (Pool #2) are
 * unaffected and keep the exact same statistics behaviour as before.
 */
async function loadAllPools(program: StakingProgram): Promise<LoadedPool[]> {
  const poolClient = runtimeAccounts(program).pool
  const coderAccounts = poolClient.coder.accounts
  const filter = coderAccounts.memcmp("pool")

  const raw = await poolClient.provider.connection.getProgramAccounts(
    poolClient.programId,
    {
      commitment: "confirmed",
      filters: [{ memcmp: filter }],
    },
  )

  const pools: LoadedPool[] = []

  for (const { pubkey, account } of raw) {
    const data = account.data
    let pool: PoolAccount
    try {
      pool = coderAccounts.decode("pool", data)
    } catch {
      // Legacy / incompatible account (e.g. a 229-byte pre-NFT pool): leave it
      // out of the list so it cannot take the whole program's pool list down.
      console.warn(
        `[pool-stats] skipped ${pubkey.toBase58()}: ${data.length}-byte Pool account is not decodable with the current Pool layout`,
      )
      continue
    }

    // Defensive second check: the coder derives the authoritative encoded size
    // (discriminator included) from the IDL, so an account that somehow
    // decodes at a different length is still not this layout. A failure to
    // derive the size must not take the pool list down: fall back to the
    // account length (i.e. accept the decoded account).
    let currentLayoutLength = data.length
    try {
      currentLayoutLength = coderAccounts.size?.("pool", pool) ?? data.length
    } catch {
      currentLayoutLength = data.length
    }
    if (data.length !== currentLayoutLength) {
      console.warn(
        `[pool-stats] skipped ${pubkey.toBase58()}: ${data.length}-byte Pool account does not match the current ${currentLayoutLength}-byte layout`,
      )
      continue
    }

    pools.push({ publicKey: pubkey, account: pool })
  }

  return pools
}

/** Minimal structural view of the Anchor userPosition account client. */
interface AnchorPositionClient {
  programId: PublicKey
  provider: { connection: Connection }
  coder: {
    accounts: {
      /** `{ offset: 0, bytes: <base58 discriminator> }` for the account type. */
      memcmp(name: string): { offset: number; bytes: string }
      decode(name: string, data: unknown): UserPositionAccount
    }
  }
}

/**
 * The camelCase account clients `program.account` really exposes. Mirrors
 * `RuntimeAccountNamespace` in `lib/solana/ops.ts`, extended with the `coder`
 * access the raw scans below need.
 */
type RuntimeAccounts = {
  pool: AnchorPoolClient
  userPosition: AnchorPositionClient
}

function runtimeAccounts(program: StakingProgram): RuntimeAccounts {
  return program.account as unknown as RuntimeAccounts
}

/**
 * Loads every UserPosition account in ONE getProgramAccounts call using the
 * account discriminator memcmp (offset 0 - only user positions match), then
 * groups staker count + claimed rewards per pool client-side.
 *
 * Previously each pool issued its own `getProgramAccounts` (memcmp on the pool
 * field at offset 40), so with N pools the identical heavy RPC was fired N
 * times concurrently - a direct contributor to the public-devnet HTTP 429s.
 * This single-call variant returns the same per-pool aggregates (verified
 * against the live devnet program: same counts and claimed totals as the
 * per-pool memcmp method).
 *
 * RPC/read failures PROPAGATE to the caller: loadPoolStats() records them as
 * `aggregatesError` (with the aggregate fields nulled) instead of receiving an
 * empty map that would be presented as zero stakers / zero claimed. Only a
 * single undecodable position account is skipped locally - that is a data
 * anomaly for one account, not a failed read.
 */
async function loadAllUserPositionAggregates(
  program: StakingProgram,
): Promise<Map<string, { stakers: number; claimed: bigint }>> {
  const result = new Map<string, { stakers: number; claimed: bigint }>()
  const positionClient = runtimeAccounts(program).userPosition
  const coderAccounts = positionClient.coder.accounts
  const filter = coderAccounts.memcmp("userPosition")

  const raw = await positionClient.provider.connection.getProgramAccounts(
    positionClient.programId,
    {
      commitment: "confirmed",
      filters: [{ memcmp: filter }],
    },
  )

  for (const accountEntry of raw) {
    try {
      const pos = coderAccounts.decode(
        "userPosition",
        accountEntry.account.data,
      ) as UserPositionAccount
      const poolB58 = pos.pool.toBase58()
      const current = result.get(poolB58) ?? { stakers: 0, claimed: BigInt(0) }
      current.stakers += 1
      current.claimed += BigInt(pos.totalClaimed.toString())
      result.set(poolB58, current)
    } catch {
      // A single undecodable account must not fail the whole aggregate.
      continue
    }
  }
  return result
}

export async function loadPoolStats(
  program: StakingProgram,
  connection: Connection,
): Promise<void> {
  lastProgram = program

  // A fetch is already running for this store -> join it (no duplicate RPCs).
  // When an admin mutation fired invalidatePoolStats() first, the in-flight
  // fetch may hold PRE-mutation data, so it is skipped and a fresh load starts.
  if (inFlight && !forceReload) return inFlight

  // Fresh cached result for the same connection -> nothing to do.
  // NOTE: we key on the shared Connection (one object app-wide), never on the
  // Anchor Program instance, because every useStakingProgram()/usePoolStats()
  // call site memoizes its OWN Program wrapper around the same Connection.
  const cacheFresh =
    snapshotConnection === connection &&
    Date.now() - snapshotUpdatedAt < POOL_STATS_TTL_MS
  if (cacheFresh && !forceReload) return

  // Consume the invalidation flag: this call now performs the reload.
  forceReload = false

  // Connection changed (wallet client recreated) -> reset and load from scratch.
  // Otherwise just mark the existing snapshot as (re)loading.
  if (snapshotConnection !== connection) {
    snapshotConnection = connection
    snapshot = EMPTY_STATE
    emit()
  } else {
    snapshot = { ...snapshot, loading: true, error: null }
    emit()
  }

  // Only the newest load may write the store. If a stale in-flight load settles
  // after a more recent load was issued, its result is discarded so a snapshot
  // taken BEFORE an admin mutation can never overwrite the post-mutation state.
  const epoch = ++loadEpoch

  inFlight = (async () => {
    try {
      // Real pools from the Anchor program. Decoded per account on purpose (see
      // loadAllPools) so a legacy 229-byte pool cannot blank the whole list.
      const poolAccounts = await loadAllPools(program)

      const pools: RealPool[] = await Promise.all(
        poolAccounts.map(async ({ publicKey: address, account }) => {
          const pool = account as unknown as PoolAccount
          const stakingFallback = {
            name: "",
            symbol: shortenAddress(pool.stakingMint.toBase58()),
            image: undefined,
          } as const
          const rewardFallback = {
            name: "",
            symbol: shortenAddress(pool.rewardMint.toBase58()),
            image: undefined,
          } as const
          const [stakingMeta, rewardMeta, stakingDecimals, rewardDecimals] = await Promise.all([
            resolveTokenMeta(pool.stakingMint).catch(() => stakingFallback),
            resolveTokenMeta(pool.rewardMint).catch(() => rewardFallback),
            getMintDecimals(connection, pool.stakingMint),
            getMintDecimals(connection, pool.rewardMint),
          ])
          return {
            address: address.toBase58(),
            authority: pool.authority.toBase58(),
            poolId: pool.poolId.toString(),
            name: poolDisplayName(stakingMeta),
            stakingMint: pool.stakingMint,
            rewardMint: pool.rewardMint,
            stakingSymbol: stakingMeta.symbol,
            rewardSymbol: rewardMeta.symbol,
            stakingImage: stakingMeta.image,
            rewardImage: rewardMeta.image,
            stakingDecimals: stakingDecimals ?? 9,
            rewardDecimals: rewardDecimals ?? 9,
            totalStaked: pool.totalStaked,
            rewardRatePerSecond: pool.rewardRatePerSecond,
            lockDuration: pool.lockDuration,
            status: (pool.frozen ? "Frozen" : pool.paused ? "Paused" : "Active") as PoolStatus,
          }
        }),
      )

      // Real per-pool aggregates from UserPosition accounts.
      // ONE getProgramAccounts (discriminator memcmp) fetches every position;
      // grouping happens client-side. This replaces one getProgramAccounts per
      // pool (memcmp on the pool field at offset 40), which fired the same heavy
      // RPC N times concurrently with N pools - a direct 429 contributor.
      //
      // This read is isolated on purpose: pool discovery above already
      // succeeded, so a FAILURE here must not blank the pools (or turn into
      // zero aggregates). The aggregate fields stay null and the error is
      // propagated explicitly via `aggregatesError`, letting the UI show
      // "staker totals unavailable" instead of a fabricated 0.
      let aggregates: Record<string, PoolAggregate> | null = null
      let totalStakers: number | null = null
      let totalClaimed: bigint | null = null
      let aggregatesError: string | null = null
      try {
        const positionCounts = await loadAllUserPositionAggregates(program)
        const aggregateEntries = pools.map((p) => {
          const agg = positionCounts.get(p.address)
          return [p.address, agg ?? { stakers: 0, claimed: BigInt(0) }] as const
        })

        aggregates = Object.fromEntries(aggregateEntries)
        totalStakers = aggregateEntries.reduce((n, [, a]) => n + a.stakers, 0)
        totalClaimed = aggregateEntries.reduce((sum, [, a]) => sum + a.claimed, BigInt(0))
      } catch (e) {
        aggregatesError =
          e instanceof Error ? e.message : "Failed to read staker totals"
      }

      pools.sort((a, b) => a.address.localeCompare(b.address))
      if (epoch !== loadEpoch) return
      snapshot = {
        loading: false,
        error: null,
        pools,
        aggregates,
        aggregatesError,
        totalStakers,
        totalClaimed,
      }
      snapshotUpdatedAt = Date.now()
    } catch (e) {
      if (epoch !== loadEpoch) return
      // Whole-load failure (pool discovery itself failed): `error` carries the
      // message and every on-chain-derived figure is null - never a fake 0.
      snapshot = {
        loading: false,
        error: e instanceof Error ? e.message : "Failed to load pools",
        pools: [],
        aggregates: null,
        aggregatesError: null,
        totalStakers: null,
        totalClaimed: null,
      }
      snapshotUpdatedAt = Date.now()
    } finally {
      // Only the newest load owns `inFlight` and notifies subscribers.
      if (epoch === loadEpoch) {
        inFlight = null
        emit()
      }
    }
  })()

  return inFlight
}

/**
 * Invalidates the cached pool snapshot immediately and re-fetches on-chain.
 * Called after on-chain mutations that change pool accounts (admin pause /
 * freeze / restore) so every subscriber sees the new state right away instead
 * of waiting for the 30s TTL. This is a targeted invalidation - it does NOT
 * disable or shorten the general caching.
 */
export function invalidatePoolStats(): void {
  // Force the next load to bypass the TTL cache AND to skip an already-running
  // (possibly pre-mutation) fetch, so the post-mutation on-chain state wins.
  snapshotUpdatedAt = 0
  forceReload = true
  if (lastProgram && snapshotConnection) {
    void loadPoolStats(lastProgram, snapshotConnection)
  }
}

/**
 * Loads all real, on-chain staking pools plus per-pool staker/claimed
 * aggregates. Shared by the dashboard, analytics, and rewards pages so they all
 * read from the same live source instead of mock data. Read-only; works without
 * a wallet.
 *
 * Every caller subscribes to the single module-scoped store above, so multiple
 * hooks on the same page share exactly one on-chain fetch.
 */
export function usePoolStats(): PoolStats {
  const { connection } = useConnection()
  const { readOnlyProgram } = useStakingProgram()
  const stats = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    void loadPoolStats(readOnlyProgram, connection)
  }, [readOnlyProgram, connection])

  return stats
}
