/**
 * Pure reward / APR math shared by the Create Pool wizard, the dashboard's
 * estimated-APR display and the owner emission controls.
 *
 * Design rules (see TARGET_APR.md for the full rationale):
 *
 * - APR, NOT APY. The on-chain program does not auto-compound rewards, so
 *   every figure produced here is a NON-COMPOUNDING annual percentage rate
 *   (estimated APR). Never label these values "APY".
 * - No invented valuations. Converting a target APR into an on-chain
 *   emission only makes sense when staking and reward tokens share one
 *   valuation (the same mint). This module has NO price-feed hook on
 *   purpose: when the tokens differ, callers must treat the APR as not
 *   computable instead of comparing raw token quantities.
 * - Dependency-free. No anchor BN, no web3: everything is plain `bigint`
 *   base units so the exact shipped code can run under `node --test`
 *   (Node type stripping) and under Next.js unchanged.
 * - Truthful nulls. Functions return `null` when a value genuinely cannot
 *   be computed (zero stake, unknown decimals, invalid inputs) - callers
 *   must render "not available" instead of guessing.
 */

/** Seconds in a 365-day year (the APR denominator). */
export const SECONDS_PER_YEAR = 31_536_000n

/** Basis-point denominator (10_000 bps = 100%). */
export const BPS_DENOMINATOR = 10_000n

/**
 * Must match `REWARD_SCALE` in programs/pumpswap-staking/src/lib.rs - the
 * fixed-point scale of the on-chain `reward_per_token` accumulator.
 */
export const REWARD_SCALE = 1_000_000_000_000_000_000n

/** Guard rail for user-entered APR percentages (100_000% = 1000x/year). */
const MAX_APR_PERCENT = 100_000

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent)
}

function isValidDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 30
}

/**
 * Parse a user-entered APR percentage (e.g. 12.5) into exact whole basis
 * points (1250). Returns null for anything that cannot be represented:
 * non-finite, zero, negative, or above the guard rail.
 */
export function aprPercentToBps(aprPercent: number): bigint | null {
  if (!Number.isFinite(aprPercent) || aprPercent <= 0 || aprPercent > MAX_APR_PERCENT) {
    return null
  }
  const bps = Math.round(aprPercent * 100)
  if (!Number.isSafeInteger(bps) || bps <= 0) return null
  return BigInt(bps)
}

/**
 * Owner-selected target APR -> on-chain emission rate
 * (`reward_rate_per_second`, REWARD-MINT base units per second).
 *
 *   emission = referenceStake * (targetApr / 100) / SECONDS_PER_YEAR
 *
 * with the staking->reward decimals conversion done in exact bigint math.
 *
 * Callers MUST only use this when staking and reward tokens share one
 * valuation (the same mint) - comparing raw quantities of two different
 * tokens is not a valid valuation. This function cannot check that for
 * you; the wizard and owner card gate it on mint equality.
 *
 * Returns null when the inputs are invalid (non-positive APR or stake,
 * bad decimals). Returns 0n when the mathematically correct emission
 * rounds below one reward base unit per second - the on-chain program
 * requires rate > 0, so callers must treat 0n as "target too small".
 */
export function emissionPerSecondForTargetApr(args: {
  aprPercent: number
  /** Reference (expected) total stake in STAKING-mint base units. */
  referenceStakeBase: bigint
  stakingDecimals: number
  rewardDecimals: number
}): bigint | null {
  const { aprPercent, referenceStakeBase, stakingDecimals, rewardDecimals } = args
  const aprBps = aprPercentToBps(aprPercent)
  if (aprBps === null) return null
  if (referenceStakeBase <= 0n) return null
  if (!isValidDecimals(stakingDecimals) || !isValidDecimals(rewardDecimals)) return null

  // stake base units -> reward base units (only valid for same-valuation
  // tokens; the caller guarantees that).
  const scaleUp = rewardDecimals >= stakingDecimals ? pow10(rewardDecimals - stakingDecimals) : 1n
  const scaleDown = stakingDecimals > rewardDecimals ? pow10(stakingDecimals - rewardDecimals) : 1n

  const numerator = referenceStakeBase * aprBps * scaleUp
  const denominator = BPS_DENOMINATOR * SECONDS_PER_YEAR * scaleDown
  return numerator / denominator // floor: never over-emit vs. the target
}

/**
 * Reward budget (base units) that must be funded for the chosen emission
 * to run for `durationSeconds` without running dry:
 *
 *   required = emissionPerSecond * durationSeconds
 *
 * Returns null for invalid inputs (negative duration or emission).
 */
export function requiredRewardBudgetBase(args: {
  emissionPerSecond: bigint
  durationSeconds: bigint
}): bigint | null {
  const { emissionPerSecond, durationSeconds } = args
  if (emissionPerSecond < 0n || durationSeconds < 0n) return null
  return emissionPerSecond * durationSeconds
}

/**
 * How long (whole seconds, floor) a funded budget lasts at the given
 * emission. Returns null when there is no emission to divide by (the
 * question is meaningless), 0n when the budget cannot cover even one
 * second of emission (reward exhaustion).
 */
export function fundingSustainSeconds(args: {
  budgetBase: bigint
  emissionPerSecond: bigint
}): bigint | null {
  const { budgetBase, emissionPerSecond } = args
  if (budgetBase < 0n || emissionPerSecond <= 0n) return null
  return budgetBase / emissionPerSecond
}

/**
 * Estimated (realized) APR for a pool at its CURRENT total stake:
 *
 *   apr = (emission * SECONDS_PER_YEAR / totalStaked) * 100
 *
 * only when both sides are expressed in the same valuation (same mint).
 * Returns null when it genuinely cannot be computed:
 *   - totalStaked == 0 (no stake: rewards accrue to nobody; APR undefined)
 *   - negative inputs or invalid decimals
 *
 * The result is a non-compounding estimate - it moves inversely with
 * total stake, so a fixed emission yields a lower APR as stake grows.
 */
export function estimatedAprBps(args: {
  emissionPerSecond: bigint
  totalStakedBase: bigint
  stakingDecimals: number
  rewardDecimals: number
}): bigint | null {
  const { emissionPerSecond, totalStakedBase, stakingDecimals, rewardDecimals } = args
  if (emissionPerSecond < 0n || totalStakedBase <= 0n) return null
  if (!isValidDecimals(stakingDecimals) || !isValidDecimals(rewardDecimals)) return null

  // reward base units -> staking base units over one year, times bps.
  const scaleUp = stakingDecimals >= rewardDecimals ? pow10(stakingDecimals - rewardDecimals) : 1n
  const scaleDown = rewardDecimals > stakingDecimals ? pow10(rewardDecimals - stakingDecimals) : 1n

  const numerator = emissionPerSecond * SECONDS_PER_YEAR * BPS_DENOMINATOR * scaleUp
  const denominator = totalStakedBase * scaleDown
  return numerator / denominator
}

/**
 * Why a pool is excluded from the dashboard's Average Estimated APR. These
 * are the only reasons an otherwise-live pool cannot contribute a truthful,
 * comparable number - they are surfaced to the user so the average is never
 * a silently-substituted single-pool figure.
 */
export type AprExclusionReason =
  /** Staking and reward are different mints: raw quantities are not comparable without a price feed (this app has none). */
  | "cross-token"
  /** The exact staking/reward mint decimals could not be read from chain. */
  | "unknown-decimals"
  /** Nothing is staked, so a per-stake APR is undefined. */
  | "zero-stake"
  /** The pool emits no rewards, so its APR is 0 and there is nothing to average. */
  | "zero-emission"

/** Minimal, dependency-free view of one pool for the APR average. */
export interface AprAveragePoolInput {
  /** True only when staking and reward are the SAME mint (one shared valuation). */
  sameMint: boolean
  /** EXACT staking-mint decimals read from chain; null = unknown. */
  stakingDecimals: number | null
  /** EXACT reward-mint decimals read from chain; null = unknown. */
  rewardDecimals: number | null
  /** Current on-chain total stake, in staking-mint base units. */
  totalStakedBase: bigint
  /** Current on-chain reward emission, in reward-mint base units / second. */
  emissionPerSecond: bigint
}

export interface AverageEstimatedApr {
  /**
   * Arithmetic mean of the ELIGIBLE pools' estimated APRs, in percent, or
   * null when no pool is eligible. Never a single pool's APR standing in for
   * the set, and never the Reward Settings card's reference-stake preview.
   */
  averageAprPercent: number | null
  /** How many pools contributed to the average. */
  includedCount: number
  /** How many pools were excluded (for any reason). */
  excludedCount: number
  /** Excluded pools grouped by reason (sorted by reason for stable display). */
  excludedReasons: { reason: AprExclusionReason; count: number }[]
}

/**
 * Compute the dashboard's Average Estimated APR as the ARITHMETIC MEAN of
 * every ELIGIBLE pool's current estimated APR.
 *
 * Each pool's estimated APR is `estimatedAprBps` at its CURRENT on-chain
 * emission and ACTUAL total stake, using the EXACT staking/reward decimals
 * read from chain. A pool is eligible only when all of these are truthful:
 *   - staking and reward are the SAME mint (cross-token pools have no price
 *     feed here, so a comparable token value cannot be computed - excluded);
 *   - both mint decimals are known;
 *   - there is stake and there is an emission.
 *
 * Returns the mean plus the included/excluded counts and the reason each
 * excluded pool was dropped, so the UI can show exactly what fed the number.
 */
export function computeAverageEstimatedApr(
  pools: AprAveragePoolInput[],
): AverageEstimatedApr {
  const includedPercents: number[] = []
  const excludedReasons: AprExclusionReason[] = []

  for (const pool of pools) {
    // Reason precedence: cross-token first (the headline exclusion), then
    // unknown decimals, then a degenerate pool with no stake / no emission.
    if (!pool.sameMint) {
      excludedReasons.push("cross-token")
      continue
    }
    if (pool.stakingDecimals === null || pool.rewardDecimals === null) {
      excludedReasons.push("unknown-decimals")
      continue
    }
    if (pool.totalStakedBase <= 0n) {
      excludedReasons.push("zero-stake")
      continue
    }
    if (pool.emissionPerSecond <= 0n) {
      excludedReasons.push("zero-emission")
      continue
    }

    const bps = estimatedAprBps({
      emissionPerSecond: pool.emissionPerSecond,
      totalStakedBase: pool.totalStakedBase,
      stakingDecimals: pool.stakingDecimals,
      rewardDecimals: pool.rewardDecimals,
    })
    // Defensive: an eligible-looking pool the math still cannot price must
    // never enter the average.
    if (bps === null) {
      excludedReasons.push("unknown-decimals")
      continue
    }
    includedPercents.push(Number(bps) / 100)
  }

  const counts = new Map<AprExclusionReason, number>()
  for (const reason of excludedReasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  const grouped = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => a.reason.localeCompare(b.reason))

  const averageAprPercent =
    includedPercents.length > 0
      ? includedPercents.reduce((sum, value) => sum + value, 0) / includedPercents.length
      : null

  return {
    averageAprPercent,
    includedCount: includedPercents.length,
    excludedCount: excludedReasons.length,
    excludedReasons: grouped,
  }
}

/**
 * Funding check for a chosen emission + budget + duration. Never promises
 * a return: it only reports whether the funded budget can sustain the
 * chosen emission for the chosen duration.
 */
export type FundingValidation = {
  /** True when the funded budget covers the whole chosen duration. */
  ok: boolean
  /** Emission * duration (base units). */
  requiredBudgetBase: bigint
  /** Max(0, required - budget): how much more must be funded. */
  shortfallBase: bigint
  /** Whole seconds the budget lasts at this emission; null without an emission. */
  sustainSeconds: bigint | null
}

export function validateRewardFunding(args: {
  emissionPerSecond: bigint
  budgetBase: bigint
  durationSeconds: bigint
}): FundingValidation {
  const required = requiredRewardBudgetBase(args) ?? 0n
  const budget = args.budgetBase < 0n ? 0n : args.budgetBase
  const shortfall = required > budget ? required - budget : 0n
  return {
    ok: shortfall === 0n,
    requiredBudgetBase: required,
    shortfallBase: shortfall,
    sustainSeconds: fundingSustainSeconds(args),
  }
}

/**
 * Format exact basis points as a percentage string, e.g. 1250n -> "12.5%".
 * `maxFractionDigits` is capped at 2 because basis points are hundredths
 * of a percent - inventing more digits would fabricate precision.
 */
export function bpsToPercentString(bps: bigint, maxFractionDigits = 2): string {
  const sign = bps < 0n ? "-" : ""
  const abs = bps < 0n ? -bps : bps
  const whole = abs / 100n
  const digits = Math.max(0, Math.min(2, Math.floor(maxFractionDigits)))
  if (digits === 0) return `${sign}${whole}%`
  const frac = (abs % 100n).toString().padStart(2, "0").slice(0, digits).replace(/0+$/, "")
  return frac.length > 0 ? `${sign}${whole}.${frac}%` : `${sign}${whole}%`
}

/**
 * Approximate human duration for funding estimates: "90.5 days",
 * "12 hours", "45 minutes". Deliberately approximate - every use of this
 * value is an estimate based on a constant-emission assumption.
 */
export function formatApproxDuration(seconds: bigint): string {
  if (seconds <= 0n) return "0 seconds"
  if (seconds < 60n) return `${seconds} second${seconds === 1n ? "" : "s"}`
  if (seconds < 3_600n) return `${Number(seconds / 60n)} minutes`
  if (seconds < 86_400n) return `${Number(seconds / 3_600n)} hours`
  const days = Number(seconds) / 86_400
  return `${days >= 100 ? Math.floor(days) : Number(days.toFixed(1))} days`
}

/**
 * Project the on-chain `reward_per_token` accumulator across an emission
 * (rate) change, mirroring the settle-then-mutate semantics of the
 * `set_reward_rate` instruction:
 *
 *  1. advance the accumulator from `lastUpdate` to `settleAt` using
 *     `rateBefore` - all rewards accrued up to the change keep the OLD
 *     terms (preserved, never recalculated retroactively), then
 *  2. advance from `settleAt` to `now` using `rateAfter`.
 *
 * Like the on-chain `update_pool_rewards`, a zero total stake accrues
 * nothing (only time passes). This is the reference used by the owner
 * emission card and the tests; it intentionally mirrors the formula in
 * `computeUpdatedRewardPerToken` (lib/solana/ops.ts) because ops.ts pulls
 * in anchor/web3 and cannot run under plain `node --test`.
 *
 * Pass `rateAfter === rateBefore` (and `settleAt === now`) to model a
 * pool whose emission never changes.
 */
export function projectRewardPerToken(args: {
  rewardPerTokenBefore: bigint
  totalStakedBase: bigint
  rateBefore: bigint
  rateAfter: bigint
  /** pool.last_update_timestamp (unix seconds). */
  lastUpdate: bigint
  /** Unix second at which the new rate takes effect (settle point). */
  settleAt: bigint
  /** Unix second being projected to (>= settleAt). */
  now: bigint
}): bigint {
  const { rewardPerTokenBefore, totalStakedBase, rateBefore, rateAfter, lastUpdate, settleAt, now } = args
  let rpt = rewardPerTokenBefore

  const beforeElapsed = settleAt - lastUpdate
  if (beforeElapsed > 0n && totalStakedBase > 0n && rateBefore > 0n) {
    rpt += (beforeElapsed * rateBefore * REWARD_SCALE) / totalStakedBase
  }

  const afterElapsed = now - settleAt
  if (afterElapsed > 0n && totalStakedBase > 0n && rateAfter > 0n) {
    rpt += (afterElapsed * rateAfter * REWARD_SCALE) / totalStakedBase
  }

  return rpt
}




