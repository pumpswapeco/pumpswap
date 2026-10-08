"use client"

import { useEffect, useState } from "react"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"

import { usePoolOptional } from "@/lib/pool-context"
import type { PublicKey } from "@solana/web3.js"
import { shortenAddress } from "@/lib/solana/format"
import { getMintDecimals, resolveTokenMeta } from "@/lib/solana/metadata"
import {
  computePendingRewards,
  computeUpdatedRewardPerToken,
  fetchPool,
  fetchUserPosition,
} from "@/lib/solana/ops"
import { useStakingProgram } from "@/lib/solana/use-staking-program"

export interface UserRewardsState {
  /** True while the on-chain reward state is being fetched. */
  loading: boolean
  /**
   * True once the real on-chain UserPosition (or its confirmed absence) has
   * been read for the connected wallet and the configured pool.
   */
  ready: boolean
  /** True when a wallet is connected. */
  connected: boolean
  /** Default pool address the pending rewards were read from. */
  poolAddress: string | null
  /** Pending/accrued rewards in base units (from the live UserPosition). */
  pendingBaseUnits: bigint
  /** Pending rewards converted to token units using the reward mint decimals. */
  pendingTokens: number
  /** Reward token symbol resolved from on-chain Metaplex metadata. */
  rewardSymbol: string | null
  /** Reward mint decimals (base-10) read from the on-chain mint. */
  rewardDecimals: number
  error: string | null
}

const INITIAL_STATE: UserRewardsState = {
  loading: true,
  ready: false,
  connected: false,
  poolAddress: null,
  pendingBaseUnits: BigInt(0),
  pendingTokens: 0,
  rewardSymbol: null,
  rewardDecimals: 9,
  error: null,
}

const IDLE_STATE: UserRewardsState = {
  ...INITIAL_STATE,
  loading: false,
}

/**
 * Reads the connected wallet's REAL on-chain UserPosition for the configured
 * staking pool and computes the current pending/accrued reward amount using
 * the same accounting as the Anchor program (`update_pool_rewards` +
 * `settle_user_rewards` via `computeUpdatedRewardPerToken` /
 * `computePendingRewards`). No price feed is required to show the token amount;
 * the value is purely on-chain (pool accounting state + reward mint decimals)
 * and the reward symbol comes from the on-chain Metaplex metadata.
 *
 * - No wallet / no configured pool -> `ready = false` (UI shows "—").
 * - Wallet connected but no position (or a zero amount) -> genuinely zero
 *   pending rewards (`ready = true`, `pendingTokens = 0`).
 */
export function useUserRewards(poolArg?: PublicKey | null): UserRewardsState {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const { readOnlyProgram } = useStakingProgram()
  // Pending rewards are read for the currently selected pool. Callers may pass
  // an explicit pool address; otherwise the app-wide selected pool from
  // PoolProvider is used. This never silently falls back to the env-default
  // pool once another pool is selected.
  const { poolAddress: contextPool } = usePoolOptional() ?? { poolAddress: null }
  const poolKey = poolArg ?? contextPool

  const [state, setState] = useState<UserRewardsState>(INITIAL_STATE)

  useEffect(() => {
    if (!publicKey) {
      setState({ ...IDLE_STATE, connected: false, poolAddress: null })
      return
    }

    const walletKey = publicKey.toBase58()
    if (!poolKey) {
      setState({ ...IDLE_STATE, connected: true, poolAddress: null })
      return
    }

    const address = poolKey.toBase58()
    setState((s) => ({
      ...s,
      loading: true,
      connected: true,
      poolAddress: address,
      error: null,
    }))

    let cancelled = false

    void (async () => {
      try {
        const pool = await fetchPool(readOnlyProgram, poolKey)
        const position = await fetchUserPosition(readOnlyProgram, poolKey, publicKey)
        // Reward symbol / decimals come from THIS pool's on-chain reward mint,
        // never from a hardcoded symbol or from another pool's metadata.
        const [resolvedDecimals, resolvedMeta] = await Promise.all([
          getMintDecimals(connection, pool.rewardMint),
          resolveTokenMeta(pool.rewardMint).catch(() => null),
        ])

        const now = Math.floor(Date.now() / 1000)
        const hasStaked = position !== null && BigInt(position.amount.toString()) > BigInt(0)
        const pendingBaseUnits = hasStaked
          ? computePendingRewards(position, computeUpdatedRewardPerToken(pool, now))
          : BigInt(0)

        if (cancelled) return
        setState({
          loading: false,
          ready: true,
          connected: true,
          poolAddress: address,
          pendingBaseUnits,
          pendingTokens: 0,
          rewardSymbol:
            resolvedMeta?.symbol?.trim() || shortenAddress(pool.rewardMint.toBase58()),
          rewardDecimals: resolvedDecimals ?? 9,
          error: null,
        })
      } catch (e) {
        if (cancelled) return
        setState({
          loading: false,
          ready: false,
          connected: true,
          poolAddress: address,
          pendingBaseUnits: BigInt(0),
          pendingTokens: 0,
          rewardSymbol: null,
          rewardDecimals: 9,
          error: e instanceof Error ? e.message : "Failed to load the user's rewards",
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [connection, readOnlyProgram, publicKey, poolKey])

  // Reward display fields (decimals/symbol/token amount) come from the reward
  // mint of the SELECTED pool (resolved in the effect above). Keeping them out
  // of the effect means the pool/position fetch only ever runs when the wallet,
  // program, or selected pool changes.
  const rewardDecimals = state.rewardDecimals
  const rewardSymbol = state.rewardSymbol
  const pendingTokens = state.ready
    ? Number(state.pendingBaseUnits) / Math.pow(10, rewardDecimals)
    : 0

  return { ...state, rewardDecimals, rewardSymbol, pendingTokens }
}