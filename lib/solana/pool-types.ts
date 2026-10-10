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
  /**
   * Display decimals for the staking mint. When the mint read failed this
   * holds a display-only fallback (9) so token-unit labels (TVL, balances,
   * stake input) keep working unchanged. APY math must NOT use this value -
   * it must use `stakingMintDecimals` below.
   */
  stakingDecimals: number
  /**
   * Display decimals for the reward mint; see `stakingDecimals`.
   */
  rewardDecimals: number
  /**
   * EXACT staking-mint decimals read from the mint account (works for both
   * classic SPL Token and Token-2022 mints). `null` = the read failed or has
   * not completed yet, i.e. the decimals are UNKNOWN. APY calculations must
   * treat `null` as unavailable and never substitute a guess.
   */
  stakingMintDecimals: number | null
  /**
   * EXACT reward-mint decimals read from the mint account; `null` = unknown.
   * See `stakingMintDecimals`.
   */
  rewardMintDecimals: number | null
  /** Total staking tokens currently locked (base units). */
  totalStaked: BN
  /** Reward emission in base units per second. */
  rewardRatePerSecond: BN
  /** Lock duration in seconds (0 = flexible). */
  lockDuration: BN
  status: PoolStatus
}
