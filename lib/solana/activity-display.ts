import { baseUnitsToTokens } from "@/lib/solana/display"
import { shortenAddress } from "@/lib/solana/format"
import type { RealPool } from "@/lib/solana/pool-types"
import type { StakingActivityRow } from "@/lib/solana/use-recent-activity"

/** A single recent-activity row rendered by the shared activity table. */
export type ActivityRow = {
  id: string
  action: "Stake" | "Unstake" | "Claim" | "Fund"
  wallet: string
  /** Full underlying wallet address (base58), copied verbatim by the UI. */
  walletAddress?: string
  amount: string
  pool: string
  /** Full underlying pool address (base58), copied verbatim by the UI. */
  poolAddress?: string
  time: string
  /** Full on-chain transaction signature (base58); shown as a tooltip/short ref. */
  signature?: string
}

/** Token-unit formatting for small accruing reward amounts (0 -> "0"). */
export function formatTokenUnitAmount(amount: number): string {
  const fractionDigits = amount === 0 ? 0 : amount >= 1 ? 4 : 8
  return amount.toLocaleString(undefined, { maximumFractionDigits: fractionDigits })
}

/** Human-friendly time from an on-chain block time; falls back to the slot. */
export function formatActivityTime(blockTime: number | null, slot: number | null): string {
  if (blockTime !== null) {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - blockTime)
    if (seconds < 60) return "just now"
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
    return new Date(blockTime * 1000).toLocaleDateString()
  }
  return slot !== null ? `slot ${slot}` : "—"
}

/**
 * Maps real on-chain staking activity rows to display rows using each pool's
 * resolved on-chain metadata (staking/reward decimals + symbols) for amounts.
 */
export function buildActivityRows(
  rows: StakingActivityRow[],
  pools: RealPool[],
): ActivityRow[] {
  return rows.map((row) => {
    const poolMeta = pools.find((p) => p.address === row.poolAddress)
    // Fund/Claim amounts are in reward-mint base units; stake/unstake in
    // staking-mint base units.
    const decimals =
      row.action === "Claim" || row.action === "Fund"
        ? poolMeta?.rewardDecimals
        : poolMeta?.stakingDecimals
    const symbol =
      row.action === "Claim" || row.action === "Fund"
        ? poolMeta?.rewardSymbol
        : poolMeta?.stakingSymbol
    const amount =
      row.amountBase !== null && decimals !== undefined
        ? `${baseUnitsToTokens(row.amountBase, decimals).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol ?? "tokens"}`
        : "—"
    return {
      id: row.signature,
      action: row.action,
      wallet: shortenAddress(row.wallet),
      walletAddress: row.wallet,
      amount,
      pool: poolMeta?.name ?? shortenAddress(row.poolAddress),
      poolAddress: row.poolAddress,
      time: formatActivityTime(row.blockTime, row.slot),
      signature: row.signature,
    }
  })
}