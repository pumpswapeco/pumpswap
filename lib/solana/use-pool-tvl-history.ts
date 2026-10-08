"use client"

import { useEffect, useMemo, useState } from "react"
import { useConnection } from "@solana/wallet-adapter-react"
import type { Connection } from "@solana/web3.js"

import { usePoolOptional } from "@/lib/pool-context"
import type { PublicKey } from "@solana/web3.js"
import { baseUnitsToTokens } from "@/lib/solana/display"
import { STAKING_PROGRAM_ID } from "@/lib/solana/program"
import { loadRecentProgramTransactions } from "@/lib/solana/program-transactions"
import { usePoolStats } from "@/lib/solana/use-pool-stats"
import {
  actionFromDiscriminator,
  actionFromLogs,
  base58Decode,
  instructionProgramId,
  u64Le,
  type StakingAction,
} from "@/lib/solana/use-recent-activity"

export interface TvlHistoryPoint {
  signature: string
  action: Exclude<StakingAction, "Claim">
  /** Unix seconds when the event landed (null when the RPC omitted it). */
  blockTime: number | null
  /** Slot the event landed in (null when the RPC omitted it). */
  slot: number | null
  /** Signed delta in base units (+ stake / - unstake). */
  deltaBase: bigint
  /** Cumulative total staked in base units after this event. */
  tvlBase: bigint
  /** Cumulative total staked in token units (staking mint decimals). */
  tvlTokens: number
}

export interface TvlHistoryState {
  loading: boolean
  /** Chronological TVL points reconstructed from real stake/unstake txs. */
  points: TvlHistoryPoint[]
  /** Number of real stake/unstake events captured on-chain. */
  eventsScanned: number
  /**
   * Truthful RPC/load error. Null when the scan succeeded. Distinct from an
   * empty `points` list: no points + no error means the pool genuinely has no
   * on-chain stake/unstake history yet.
   */
  error: string | null
  stakingSymbol: string | null
  stakingDecimals: number
  /** Current on-chain total staked in token units (for cross-check). */
  currentTvlTokens: number | null
}

const EMPTY_STATE: TvlHistoryState = {
  loading: false,
  points: [],
  eventsScanned: 0,
  error: null,
  stakingSymbol: null,
  stakingDecimals: 9,
  currentTvlTokens: null,
}

/** Raw stake/unstake event extracted from real on-chain transactions. */
interface RawHistoryEvent {
  signature: string
  action: Exclude<StakingAction, "Claim">
  amountBase: bigint
  slot: number | null
  blockTime: number | null
}

/**
 * Raw on-chain stake/unstake events for the selected pool, cached with a short
 * TTL. Concurrent and recent scans share one RPC payload: the transaction page
 * comes from the shared program-transactions loader for THIS pool (ONE
 * pool-scoped getSignaturesForAddress + per-signature getTransaction fetches
 * with bounded concurrency, up to 100 signatures, shared with Recent Activity -
 * batched getTransactions is avoided because the free Helius tier rejects
 * JSON-RPC batch arrays and public devnet responds 429), keyed by endpoint + pool
 * address, so re-mounting a page inside the TTL costs zero RPC calls. Only real
 * events are returned - if the scan succeeds with no stake/unstake on this pool,
 * the caller shows a truthful empty state.
 */
const HISTORY_TTL_MS = 20_000
const historyCache = new Map<string, { at: number; events: RawHistoryEvent[] }>()
const historyInFlight = new Map<string, Promise<RawHistoryEvent[]>>()

async function loadRawHistoryEvents(
  connection: Connection,
  poolAddress: string,
): Promise<RawHistoryEvent[]> {
  const key = `${connection.rpcEndpoint}|${poolAddress}`

  const cached = historyCache.get(key)
  if (cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached.events

  const active = historyInFlight.get(key)
  if (active) return active

  const promise = (async (): Promise<RawHistoryEvent[]> => {
    // Shared, de-duplicated program transaction history for THIS pool: ONE
    // pool-scoped getSignaturesForAddress + per-signature getTransaction fetches
    // shared with Recent Activity, so the analytics page never issues two
    // identical heavy RPC payloads (public-devnet HTTP 429 source).
    const events: RawHistoryEvent[] = []

    for (const t of await loadRecentProgramTransactions(connection, poolAddress)) {
      const tx = t.tx
      if (!tx || !tx.transaction) continue
      const msg = tx.transaction.message
      const keys = msg.accountKeys.map((k) => String(k).replace(/["'\s]/g, ""))

      for (const ix of msg.instructions) {
        if (instructionProgramId(ix, keys) !== STAKING_PROGRAM_ID.toBase58()) continue
        const accountIdx = ix.accounts ?? []
        // Stake/Unstake both put the pool at account index 1. Filtering here
        // keeps ONLY this pool's stake/unstake events (never another pool's).
        if (keys[accountIdx[1]] !== poolAddress) continue

        let bytes: Uint8Array
        try {
          bytes = base58Decode(ix.data ?? "")
        } catch {
          continue
        }
        const action = actionFromLogs(tx.meta?.logMessages) ?? actionFromDiscriminator(bytes)
        if (action !== "Stake" && action !== "Unstake") continue
        if (bytes.length < 16) continue

        events.push({
          signature: t.signature,
          action,
          amountBase: u64Le(bytes, 8),
          slot: t.slot,
          blockTime: t.blockTime,
        })
        break
      }
    }

    events.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
    return events
  })()

  historyInFlight.set(key, promise)
  try {
    const events = await promise
    historyCache.set(key, { at: Date.now(), events })
    return events
  } finally {
    historyInFlight.delete(key)
  }
}

/**
 * Reconstructs the pool's Total Value Locked history over time from REAL
 * on-chain transactions: every Stake adds its amount and every Unstake
 * subtracts it, applied chronologically (oldest first) starting from the
 * earliest captured staking transaction. No external indexer and no fabricated
 * values - points only exist for real transactions, and the running total is
 * cross-checked against the pool's on-chain `totalStaked`.
 */
export function useTvlHistory(poolArg?: PublicKey | null): TvlHistoryState {
  const { connection } = useConnection()
  const stats = usePoolStats()
  // TVL history is reconstructed per pool. Callers may pass an explicit pool
  // address; otherwise the app-wide selected pool from PoolProvider is used.
  // It never silently falls back to the env-default pool once another pool is
  // selected.
  const { poolAddress: contextPool } = usePoolOptional() ?? { poolAddress: null }
  const poolKey = useMemo(() => poolArg ?? contextPool, [poolArg, contextPool])
  const [state, setState] = useState<TvlHistoryState>({
    ...EMPTY_STATE,
    loading: true,
  })

  // The pool metadata this chart depends on (decimals/symbol/current total) is
  // folded into one primitive key so the heavy signature/transaction scan never
  // re-runs when the shared pool-stats store merely refreshes its state identity.
  const statsMetaKey = useMemo(() => {
    if (!poolKey || stats.loading) return ""
    const meta = stats.pools.find((p) => p.address === poolKey.toBase58())
    if (!meta) return ""
    return `${meta.address}|${meta.stakingDecimals}|${meta.totalStaked.toString()}|${meta.stakingSymbol}`
  }, [poolKey, stats.pools, stats.loading])

  useEffect(() => {
    if (!poolKey) {
      setState(EMPTY_STATE)
      return
    }

    const poolAddress = poolKey.toBase58()
    setState((s) => ({ ...s, loading: true }))

    let cancelled = false

    void (async () => {
      try {
        // Cached by endpoint + pool: concurrent scans and re-renders share one
        // RPC payload for the signature history + transactions.
        const events = await loadRawHistoryEvents(connection, poolAddress)

        // Decimals come from the stats key when available; re-running this
        // effect after stats settle is cheap because the events are cached.
        const keyParts = statsMetaKey.split("|")
        const decimals = keyParts.length >= 2 ? Number(keyParts[1]) : 9

        // Apply each real delta chronologically starting from zero.
        let running = BigInt(0)
        const points: TvlHistoryPoint[] = []
        for (const event of events) {
          running =
            event.action === "Stake" ? running + event.amountBase : running - event.amountBase
          points.push({
            signature: event.signature,
            action: event.action,
            blockTime: event.blockTime,
            slot: event.slot,
            deltaBase: event.action === "Stake" ? event.amountBase : -event.amountBase,
            tvlBase: running,
            tvlTokens: Number(running) / Math.pow(10, decimals),
          })
        }

        if (cancelled) return
        setState({
          loading: false,
          points,
          eventsScanned: events.length,
          error: null,
          stakingSymbol: keyParts[3] ?? null,
          stakingDecimals: decimals,
          currentTvlTokens: null, // derived at render (below) from live stats
        })
      } catch (e) {
        // Surface real RPC errors (including 429) truthfully instead of hiding
        // them behind the "No on-chain TVL history yet" empty state. A pool with
        // genuinely no history has empty points with error === null.
        if (cancelled) return
        setState({
          ...EMPTY_STATE,
          error: e instanceof Error ? e.message : "Failed to load TVL history",
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [connection, poolKey, statsMetaKey])

  // The on-chain cross-check value + token label come from the live shared pool
  // stats at render time, so a pool-stats refresh never triggers another scan.
  const statsAddress = statsMetaKey.split("|")[0] ?? ""
  const liveMeta = statsAddress
    ? stats.pools.find((p) => p.address === statsAddress)
    : undefined
  const stakingSymbol = liveMeta?.stakingSymbol ?? state.stakingSymbol ?? null
  const currentTvlTokens = liveMeta
    ? baseUnitsToTokens(liveMeta.totalStaked, liveMeta.stakingDecimals)
    : state.currentTvlTokens

  return { ...state, stakingSymbol, currentTvlTokens }
}