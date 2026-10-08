import type { PublicKey } from "@solana/web3.js"
import type { BN } from "@coral-xyz/anchor"

/** Lifecycle status of a staking pool, derived from its on-chain flags. */
export type PoolStatus = "Active" | "Paused" | "Frozen"

/**
 * A single pool's real, on-chain state plus its resolved token metadata.
 * Every field comes from the blockchain (Anchor Pool account + SPL mint +
 * Metaplex metadata); nothing here is mock or hard-coded.
 */
export interface RealPool {
  /** Pool account address (base58). */
  address: string
  /** Pool authority (owner) address (base58). */
  authority: string
  /** On-chain pool id (u64, base-10 string). */
  poolId: string
  /** Display label derived from the staking token's metadata (e.g. "PSC Staking"). */
  name: string
  stakingMint: PublicKey
  rewardMint: PublicKey
  stakingSymbol: string
  rewardSymbol: string
  stakingImage?: string
  rewardImage?: string
  stakingDecimals: number
  rewardDecimals: number
  /** Total staking tokens currently locked (base units). */
  totalStaked: BN
  /** Reward emission in base units per second. */
  rewardRatePerSecond: BN
  /** Lock duration in seconds (0 = flexible). */
  lockDuration: BN
  status: PoolStatus
}
