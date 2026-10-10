/**
 * Tests for lib/solana/rewards-calc.ts - the pure APR / emission math shared by
 * the dashboard's Average Estimated APR, the Create Pool wizard and the
 * Reward Settings card.
 *
 * Run with: npm test  (node --test tests/rewards-calc.test.ts)
 *
 * This module is deliberately dependency-free (plain bigint base units, no
 * anchor BN, no web3) so the EXACT shipped code is what gets tested here.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  BPS_DENOMINATOR,
  REWARD_SCALE,
  SECONDS_PER_YEAR,
  aprPercentToBps,
  bpsToPercentString,
  computeAverageEstimatedApr,
  emissionPerSecondForTargetApr,
  estimatedAprBps,
  formatApproxDuration,
  fundingSustainSeconds,
  projectRewardPerToken,
  requiredRewardBudgetBase,
  validateRewardFunding,
  type AprAveragePoolInput,
} from "../lib/solana/rewards-calc.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("constants match the on-chain program", () => {
  assert.equal(SECONDS_PER_YEAR, 31_536_000n, "365-day year in seconds")
  assert.equal(BPS_DENOMINATOR, 10_000n, "10_000 bps = 100%")
  // Must stay in lockstep with REWARD_SCALE in programs/pumpswap-staking/src/lib.rs
  assert.equal(REWARD_SCALE, 1_000_000_000_000_000_000n, "fixed-point scale")
})

// ---------------------------------------------------------------------------
// aprPercentToBps
// ---------------------------------------------------------------------------

test("aprPercentToBps converts a percentage to exact whole basis points", () => {
  assert.equal(aprPercentToBps(12.5), 1250n)
  assert.equal(aprPercentToBps(100), 10_000n)
  assert.equal(aprPercentToBps(0.01), 1n)
  assert.equal(aprPercentToBps(0.125), 13n, "12.5 bps rounds to 13 bps")
})

test("aprPercentToBps rejects values it cannot represent truthfully", () => {
  assert.equal(aprPercentToBps(0), null, "zero APR is not a rate")
  assert.equal(aprPercentToBps(-5), null, "negative APR is invalid")
  assert.equal(aprPercentToBps(Number.NaN), null)
  assert.equal(aprPercentToBps(Number.POSITIVE_INFINITY), null)
  assert.equal(aprPercentToBps(0.001), null, "rounds below 1 bps")
  assert.equal(aprPercentToBps(100_001), null, "above the 100_000% guard rail")
  assert.equal(aprPercentToBps(100_000), 10_000_000n, "the guard rail itself is allowed")
})

// ---------------------------------------------------------------------------
// emissionPerSecondForTargetApr
// ---------------------------------------------------------------------------

test("emissionPerSecondForTargetApr derives an emission for equal decimals", () => {
  // 1000 tokens staked (9 decimals) at 100% APR -> 1000 reward tokens/year.
  const emission = emissionPerSecondForTargetApr({
    aprPercent: 100,
    referenceStakeBase: 1_000n * 10n ** 9n,
    stakingDecimals: 9,
    rewardDecimals: 9,
  })
  // 1000e9 / 31_536_000 = 31709.79... -> floored, never over-emits.
  assert.equal(emission, 31709n)
  assert.ok(emission! > 0n)
})

test("emissionPerSecondForTargetApr converts across differing decimals", () => {
  // Staking 9 decimals, reward 6 decimals: the same 1000-token stake at 100%
  // APR must emit 1000 REWARD tokens/year in 6-decimal base units.
  const emission = emissionPerSecondForTargetApr({
    aprPercent: 100,
    referenceStakeBase: 1_000n * 10n ** 9n,
    stakingDecimals: 9,
    rewardDecimals: 6,
  })
  assert.equal(emission, 31n, "1000e6 / 31_536_000 = 31.7 -> floored to 31")

  // Mirror case: staking 6 decimals, reward 9 decimals.
  const mirror = emissionPerSecondForTargetApr({
    aprPercent: 100,
    referenceStakeBase: 1_000n * 10n ** 6n,
    stakingDecimals: 6,
    rewardDecimals: 9,
  })
  assert.equal(mirror, 31709n, "1000e9 / 31_536_000 = 31709.79 -> floored to 31709")
})

test("emissionPerSecondForTargetApr returns null for invalid inputs", () => {
  const base = { aprPercent: 10, referenceStakeBase: 1_000n, stakingDecimals: 9, rewardDecimals: 9 }
  assert.equal(emissionPerSecondForTargetApr({ ...base, aprPercent: 0 }), null)
  assert.equal(emissionPerSecondForTargetApr({ ...base, aprPercent: -1 }), null)
  assert.equal(emissionPerSecondForTargetApr({ ...base, referenceStakeBase: 0n }), null)
  assert.equal(emissionPerSecondForTargetApr({ ...base, referenceStakeBase: -5n }), null)
  assert.equal(emissionPerSecondForTargetApr({ ...base, stakingDecimals: -1 }), null)
  assert.equal(emissionPerSecondForTargetApr({ ...base, rewardDecimals: 31 }), null)
  assert.equal(emissionPerSecondForTargetApr({ ...base, stakingDecimals: 1.5 }), null)
})

test("emissionPerSecondForTargetApr returns 0n when the target is below 1 base unit/sec", () => {
  // The on-chain program requires rate > 0, so 0n must be treated by the
  // caller as "target too small" - it is NOT a valid emission.
  const emission = emissionPerSecondForTargetApr({
    aprPercent: 0.01,
    referenceStakeBase: 1n,
    stakingDecimals: 0,
    rewardDecimals: 0,
  })
  assert.equal(emission, 0n)
})


// ---------------------------------------------------------------------------
// estimatedAprBps
// ---------------------------------------------------------------------------

test("estimatedAprBps computes a non-compounding APR at the current stake", () => {
  // 1 base unit/sec for a year against 31_536_000 staked = exactly 100%.
  assert.equal(
    estimatedAprBps({
      emissionPerSecond: 1n,
      totalStakedBase: 31_536_000n,
      stakingDecimals: 0,
      rewardDecimals: 0,
    }),
    10_000n,
  )
  assert.equal(
    estimatedAprBps({
      emissionPerSecond: 2n,
      totalStakedBase: 31_536_000n,
      stakingDecimals: 0,
      rewardDecimals: 0,
    }),
    20_000n,
    "200% for double the emission",
  )
})

test("estimatedAprBps moves inversely with the total stake", () => {
  const args = { emissionPerSecond: 1n, stakingDecimals: 0, rewardDecimals: 0 } as const
  assert.equal(estimatedAprBps({ ...args, totalStakedBase: 31_536_000n }), 10_000n)
  assert.equal(
    estimatedAprBps({ ...args, totalStakedBase: 63_072_000n }),
    5_000n,
    "same emission, double stake -> half the APR",
  )
})

test("estimatedAprBps converts across differing mint decimals", () => {
  // Reward mint 6 decimals, staking mint 9 decimals: 1 reward token/sec for a
  // year against 1000 staking tokens = 31536x = 3_153_600% = 315_360_000 bps.
  assert.equal(
    estimatedAprBps({
      emissionPerSecond: 10n ** 6n,
      totalStakedBase: 1_000n * 10n ** 9n,
      stakingDecimals: 9,
      rewardDecimals: 6,
    }),
    315_360_000n,
  )
})

test("estimatedAprBps returns null when the APR is genuinely undefined", () => {
  const base = {
    emissionPerSecond: 1n,
    totalStakedBase: 1_000n,
    stakingDecimals: 9,
    rewardDecimals: 9,
  }
  assert.equal(estimatedAprBps({ ...base, totalStakedBase: 0n }), null, "no stake -> undefined")
  assert.equal(estimatedAprBps({ ...base, totalStakedBase: -1n }), null)
  assert.equal(estimatedAprBps({ ...base, emissionPerSecond: -1n }), null)
  assert.equal(estimatedAprBps({ ...base, stakingDecimals: null as unknown as number }), null)
  assert.equal(estimatedAprBps({ ...base, rewardDecimals: null as unknown as number }), null)
})

test("target APR round-trips back to (approximately) the requested APR", () => {
  // Owner asks for 100% against 1000 staked -> the derived emission, read back
  // at that same stake, must land within 1 bps of 100%. The floor in the
  // emission step means it may be a hair UNDER, never over.
  const stake = 1_000n * 10n ** 9n
  const emission = emissionPerSecondForTargetApr({
    aprPercent: 100,
    referenceStakeBase: stake,
    stakingDecimals: 9,
    rewardDecimals: 9,
  })!
  const realized = estimatedAprBps({
    emissionPerSecond: emission,
    totalStakedBase: stake,
    stakingDecimals: 9,
    rewardDecimals: 9,
  })!
  assert.ok(realized <= 10_000n, "must never over-emit vs. the target")
  assert.ok(realized >= 9_999n, `expected ~10000 bps, got ${realized}`)
})


// ---------------------------------------------------------------------------
// computeAverageEstimatedApr - the dashboard's Average Estimated APR
// ---------------------------------------------------------------------------

/**
 * Convenience builder for an eligible same-mint pool with known decimals.
 * Decimals default to 0/0 so the expected APRs are exact whole numbers.
 */
function eligiblePool(args: {
  totalStakedBase: bigint
  emissionPerSecond: bigint
  stakingDecimals?: number | null
  rewardDecimals?: number | null
  sameMint?: boolean
}): AprAveragePoolInput {
  return {
    sameMint: args.sameMint ?? true,
    stakingDecimals: args.stakingDecimals === undefined ? 0 : args.stakingDecimals,
    rewardDecimals: args.rewardDecimals === undefined ? 0 : args.rewardDecimals,
    totalStakedBase: args.totalStakedBase,
    emissionPerSecond: args.emissionPerSecond,
  }
}

test("average is the ARITHMETIC MEAN of every eligible pool's APR", () => {
  // Two same-mint pools, decimals 0/0 for exact math:
  //   A: 1/sec against 31_536_000 staked -> 100%
  //   B: 2/sec against 31_536_000 staked -> 200%
  // The mean is 150% - NOT A's APR, NOT B's APR, and NOT the stake-weighted
  // rate (which would be ~0.0000048%).
  const result = computeAverageEstimatedApr([
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n }),
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 2n }),
  ])

  assert.equal(result.includedCount, 2)
  assert.equal(result.excludedCount, 0)
  assert.deepEqual(result.excludedReasons, [])
  assert.equal(result.averageAprPercent, 150)
})

test("average uses each pool's OWN emission, stake and decimals", () => {
  // Same emission, different stake and different decimals: the mean must
  // reflect each pool individually rather than any shared assumption.
  const result = computeAverageEstimatedApr([
    // 1 reward token/sec (6 dec) vs 1000 staking tokens (9 dec) = 3_153_600%
    eligiblePool({
      totalStakedBase: 1_000n * 10n ** 9n,
      emissionPerSecond: 10n ** 6n,
      stakingDecimals: 9,
      rewardDecimals: 6,
    }),
    // 1 base unit/sec vs 31_536_000 staked (0 dec) = 100%
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n }),
  ])

  assert.equal(result.includedCount, 2)
  assert.equal(result.excludedCount, 0)
  assert.equal(result.averageAprPercent, (3_153_600 + 100) / 2)
})

test("cross-token pools are EXCLUDED from the average (no price feed)", () => {
  // A cross-token pool whose raw-token "APR" looks enormous must never enter
  // the mean: comparing 1 reward base unit against 1 staked base unit of a
  // DIFFERENT token is not a comparable valuation.
  const result = computeAverageEstimatedApr([
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n }),
    eligiblePool({
      sameMint: false,
      totalStakedBase: 1n,
      emissionPerSecond: 10n ** 30n,
    }),
  ])

  assert.equal(result.includedCount, 1, "only the same-mint pool contributes")
  assert.equal(result.excludedCount, 1)
  assert.deepEqual(result.excludedReasons, [{ reason: "cross-token", count: 1 }])
  assert.equal(result.averageAprPercent, 100, "mean of the one eligible pool only")
})


test("mixed eligible/ineligible pools: counts, reasons and mean are all reported", () => {
  const result = computeAverageEstimatedApr([
    // eligible -> 100%
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n }),
    // eligible -> 200%
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 2n }),
    // excluded: cross-token
    eligiblePool({ sameMint: false, totalStakedBase: 100n, emissionPerSecond: 100n }),
    // excluded: unknown staking decimals
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n, stakingDecimals: null }),
    // excluded: unknown reward decimals
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n, rewardDecimals: null }),
    // excluded: nothing staked
    eligiblePool({ totalStakedBase: 0n, emissionPerSecond: 1n }),
    // excluded: no emission
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 0n }),
  ])

  assert.equal(result.includedCount, 2)
  assert.equal(result.excludedCount, 5)

  // Every exclusion reason is surfaced so the number is never unexplained.
  assert.deepEqual(
    result.excludedReasons,
    [
      { reason: "cross-token", count: 1 },
      { reason: "unknown-decimals", count: 2 },
      { reason: "zero-emission", count: 1 },
      { reason: "zero-stake", count: 1 },
    ],
    "grouped by reason and sorted for stable display",
  )

  // The mean of the two ELIGIBLE pools - a single pool's APR is never
  // silently substituted for the set.
  assert.equal(result.averageAprPercent, 150)
})

test("exclusion reason precedence puts cross-token first", () => {
  // A pool that is cross-token AND has unknown decimals AND no stake is
  // reported as cross-token: that is the headline reason a comparable token
  // value cannot be computed at all.
  const result = computeAverageEstimatedApr([
    eligiblePool({
      sameMint: false,
      stakingDecimals: null,
      rewardDecimals: null,
      totalStakedBase: 0n,
      emissionPerSecond: 0n,
    }),
  ])
  assert.equal(result.includedCount, 0)
  assert.deepEqual(result.excludedReasons, [{ reason: "cross-token", count: 1 }])
})

test("a single eligible pool averages to its own APR and is labelled as such", () => {
  const result = computeAverageEstimatedApr([
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 3n }),
  ])
  assert.equal(result.includedCount, 1)
  assert.equal(result.excludedCount, 0)
  assert.deepEqual(result.excludedReasons, [])
  assert.equal(result.averageAprPercent, 300)
})


test("no eligible pool yields null - never a fabricated number", () => {
  const allExcluded = computeAverageEstimatedApr([
    eligiblePool({ sameMint: false, totalStakedBase: 100n, emissionPerSecond: 100n }),
    eligiblePool({ totalStakedBase: 0n, emissionPerSecond: 1n }),
    eligiblePool({ totalStakedBase: 100n, emissionPerSecond: 0n }),
  ])
  assert.equal(allExcluded.averageAprPercent, null)
  assert.equal(allExcluded.includedCount, 0)
  assert.equal(allExcluded.excludedCount, 3)
  assert.deepEqual(allExcluded.excludedReasons, [
    { reason: "cross-token", count: 1 },
    { reason: "zero-emission", count: 1 },
    { reason: "zero-stake", count: 1 },
  ])
})

test("an empty pool list is null with zero counts", () => {
  const result = computeAverageEstimatedApr([])
  assert.equal(result.averageAprPercent, null)
  assert.equal(result.includedCount, 0)
  assert.equal(result.excludedCount, 0)
  assert.deepEqual(result.excludedReasons, [])
})

test("an all-cross-token book never reports an APR", () => {
  const result = computeAverageEstimatedApr([
    eligiblePool({ sameMint: false, totalStakedBase: 31_536_000n, emissionPerSecond: 1n }),
    eligiblePool({ sameMint: false, totalStakedBase: 10n ** 9n, emissionPerSecond: 10n ** 6n }),
  ])
  assert.equal(result.averageAprPercent, null)
  assert.equal(result.includedCount, 0)
  assert.equal(result.excludedCount, 2)
  assert.deepEqual(result.excludedReasons, [{ reason: "cross-token", count: 2 }])
})

test("excluded pools do not dilute or shift the mean of eligible pools", () => {
  // Adding ineligible pools must leave the average of the eligible set
  // byte-for-byte identical.
  const onlyEligible = computeAverageEstimatedApr([
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n }),
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 2n }),
  ])
  const withNoise = computeAverageEstimatedApr([
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n }),
    eligiblePool({ sameMint: false, totalStakedBase: 1n, emissionPerSecond: 10n ** 30n }),
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 2n }),
    eligiblePool({ totalStakedBase: 0n, emissionPerSecond: 5n }),
  ])

  assert.equal(onlyEligible.averageAprPercent, 150)
  assert.equal(withNoise.averageAprPercent, onlyEligible.averageAprPercent)
  assert.equal(withNoise.includedCount, 2)
  assert.equal(withNoise.excludedCount, 2)
})

test("the average never uses a reference stake (the Target APR card's input)", () => {
  // The dashboard helper has no reference-stake concept at all: a pool with a
  // tiny ACTUAL stake yields a huge APR, and no hypothetical reference amount
  // can soften it.
  const result = computeAverageEstimatedApr([
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n }),
    eligiblePool({ totalStakedBase: 315_360n, emissionPerSecond: 1n }),
  ])
  // 100% and 10_000% -> mean 5050%, driven purely by actual stake.
  assert.equal(result.averageAprPercent, (100 + 10_000) / 2)
})

test("a pool with unknown decimals never enters the average", () => {
  // Mirrors the real deployed program: pools whose mint decimals could not be
  // read must be excluded rather than guessed.
  const result = computeAverageEstimatedApr([
    eligiblePool({ totalStakedBase: 31_536_000n, emissionPerSecond: 1n }),
    eligiblePool({
      totalStakedBase: 10n ** 9n,
      emissionPerSecond: 10n ** 6n,
      stakingDecimals: 9,
      rewardDecimals: null,
    }),
  ])
  assert.equal(result.includedCount, 1)
  assert.equal(result.excludedCount, 1)
  assert.deepEqual(result.excludedReasons, [{ reason: "unknown-decimals", count: 1 }])
  assert.equal(result.averageAprPercent, 100)
})


// ---------------------------------------------------------------------------
// Reward budget / funding
// ---------------------------------------------------------------------------

test("requiredRewardBudgetBase multiplies emission by duration", () => {
  assert.equal(
    requiredRewardBudgetBase({ emissionPerSecond: 1_000n, durationSeconds: 31_536_000n }),
    31_536_000_000n,
  )
  assert.equal(requiredRewardBudgetBase({ emissionPerSecond: 1_000n, durationSeconds: 0n }), 0n)
  assert.equal(requiredRewardBudgetBase({ emissionPerSecond: 1_000n, durationSeconds: -1n }), null)
  assert.equal(requiredRewardBudgetBase({ emissionPerSecond: -1n, durationSeconds: 10n }), null)
})

test("fundingSustainSeconds reports how long a budget lasts", () => {
  assert.equal(
    fundingSustainSeconds({ budgetBase: 31_536_000_000n, emissionPerSecond: 1_000n }),
    31_536_000n,
    "exactly one year",
  )
  assert.equal(
    fundingSustainSeconds({ budgetBase: 500n, emissionPerSecond: 1_000n }),
    0n,
    "cannot cover even one second",
  )
  assert.equal(
    fundingSustainSeconds({ budgetBase: 1_000n, emissionPerSecond: 0n }),
    null,
    "no emission -> the question is meaningless",
  )
  assert.equal(fundingSustainSeconds({ budgetBase: -1n, emissionPerSecond: 1_000n }), null)
})

test("validateRewardFunding reports ok / shortfall / duration", () => {
  const emissionPerSecond = 1_000n
  const durationSeconds = 31_536_000n
  const required = 31_536_000_000n

  const funded = validateRewardFunding({ emissionPerSecond, durationSeconds, budgetBase: required })
  assert.equal(funded.ok, true)
  assert.equal(funded.requiredBudgetBase, required)
  assert.equal(funded.shortfallBase, 0n)
  assert.equal(funded.sustainSeconds, 31_536_000n)

  const underFunded = validateRewardFunding({
    emissionPerSecond,
    durationSeconds,
    budgetBase: 1_000_000_000n,
  })
  assert.equal(underFunded.ok, false)
  assert.equal(underFunded.shortfallBase, required - 1_000_000_000n)
  assert.equal(underFunded.sustainSeconds, 1_000_000n)

  const negativeBudget = validateRewardFunding({
    emissionPerSecond,
    durationSeconds,
    budgetBase: -5n,
  })
  assert.equal(negativeBudget.ok, false)
  assert.equal(negativeBudget.shortfallBase, required, "a negative budget is treated as zero")
})


// ---------------------------------------------------------------------------
// projectRewardPerToken (mirrors on-chain settle-then-mutate semantics)
// ---------------------------------------------------------------------------

test("projectRewardPerToken advances with a steady emission", () => {
  // 10 base units/sec for 200s against 1000 staked, rate unchanged:
  //   200 * 10 * 1e18 / 1000 = 2e18
  assert.equal(
    projectRewardPerToken({
      rewardPerTokenBefore: 0n,
      totalStakedBase: 1_000n,
      rateBefore: 10n,
      rateAfter: 10n,
      lastUpdate: 0n,
      settleAt: 200n,
      now: 200n,
    }),
    2_000_000_000_000_000_000n,
  )
})

test("projectRewardPerToken preserves rewards accrued under the OLD rate", () => {
  // Old rate 10/sec for the first 100s, new rate 20/sec for the next 100s:
  //   segment 1: 100 * 10 * 1e18 / 1000 = 1e18
  //   segment 2: 100 * 20 * 1e18 / 1000 = 2e18
  assert.equal(
    projectRewardPerToken({
      rewardPerTokenBefore: 0n,
      totalStakedBase: 1_000n,
      rateBefore: 10n,
      rateAfter: 20n,
      lastUpdate: 0n,
      settleAt: 100n,
      now: 200n,
    }),
    3_000_000_000_000_000_000n,
  )
})

test("projectRewardPerToken never retroactively applies the new rate", () => {
  // Same 100s window, but the rate change is scheduled at the projection time
  // (settleAt === now): nothing has accrued under rateAfter yet.
  const beforeChange = projectRewardPerToken({
    rewardPerTokenBefore: 0n,
    totalStakedBase: 1_000n,
    rateBefore: 10n,
    rateAfter: 20n,
    lastUpdate: 0n,
    settleAt: 100n,
    now: 100n,
  })
  assert.equal(beforeChange, 1_000_000_000_000_000_000n, "only the pre-change segment counts")
})

test("projectRewardPerToken accrues nothing with zero stake", () => {
  assert.equal(
    projectRewardPerToken({
      rewardPerTokenBefore: 123n,
      totalStakedBase: 0n,
      rateBefore: 10n,
      rateAfter: 20n,
      lastUpdate: 0n,
      settleAt: 100n,
      now: 200n,
    }),
    123n,
    "only time passes; the accumulator is untouched",
  )
})

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

test("bpsToPercentString formats whole basis points without inventing precision", () => {
  assert.equal(bpsToPercentString(1250n), "12.5%")
  assert.equal(bpsToPercentString(10_000n), "100%")
  assert.equal(bpsToPercentString(50n), "0.5%")
  assert.equal(bpsToPercentString(5n), "0.05%")
  assert.equal(bpsToPercentString(0n), "0%")
  assert.equal(bpsToPercentString(-250n), "-2.5%")
  assert.equal(bpsToPercentString(12_555n), "125.55%")
})

test("bpsToPercentString honours a smaller maxFractionDigits cap", () => {
  assert.equal(bpsToPercentString(1250n, 0), "12%")
  assert.equal(bpsToPercentString(1250n, 1), "12.5%")
  assert.equal(bpsToPercentString(1255n, 1), "12.5%")
  assert.equal(bpsToPercentString(1250n, 9), "12.5%", "capped at 2 digits")
})

test("formatApproxDuration renders approximate human durations", () => {
  assert.equal(formatApproxDuration(0n), "0 seconds")
  assert.equal(formatApproxDuration(1n), "1 second")
  assert.equal(formatApproxDuration(59n), "59 seconds")
  assert.equal(formatApproxDuration(60n), "1 minutes")
  assert.equal(formatApproxDuration(3_600n), "1 hours")
  assert.equal(formatApproxDuration(86_400n), "1 days")
  assert.equal(formatApproxDuration(129_600n), "1.5 days")
  assert.equal(formatApproxDuration(7_776_000n), "90 days")
  assert.equal(formatApproxDuration(8_640_000n), "100 days", "whole days past 100")
  assert.equal(formatApproxDuration(8_726_400n), "101 days")
})

