import { BN } from "@coral-xyz/anchor"

/** Human-friendly label for a lock duration in seconds (0 = Flexible). */
export function formatLockDurationSeconds(seconds: number | bigint | BN): string {
  const s = typeof seconds === "object" && seconds !== null ? Number(seconds.toString()) : Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return "Flexible"

  const MINUTE = 60
  const HOUR = 3600
  const DAY = 86400
  const WEEK = 604800
  const MONTH = 2592000 // 30 days

  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`

  if (s % MONTH === 0) return plural(s / MONTH, "month")
  if (s % WEEK === 0) return plural(s / WEEK, "week")
  if (s % DAY === 0) return plural(s / DAY, "day")
  if (s % HOUR === 0) return plural(s / HOUR, "hour")
  if (s % MINUTE === 0) return plural(s / MINUTE, "minute")
  return plural(s, "second")
}

/** Convert a raw base-unit amount to a human token amount using mint decimals. */
export function baseUnitsToTokens(amount: number | bigint | BN, decimals: number): number {
  const raw = typeof amount === "object" && amount !== null ? amount.toString() : amount.toString()
  const value = BigInt(raw)
  const factor = Math.pow(10, decimals)
  return Number(value) / factor
}

/**
 * Format an on-chain reward rate (base units / second) as a human emission
 * string, e.g. "1.2500/day". Uses the reward mint's decimals.
 */
export function formatRewardEmission(
  rewardRatePerSecond: number | bigint | BN,
  rewardDecimals: number,
  symbol?: string,
): string {
  const perSecond = baseUnitsToTokens(rewardRatePerSecond, rewardDecimals)
  const perDay = perSecond * 86400
  const perHour = perSecond * 3600

  const fmt = (n: number) =>
    n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toLocaleString(undefined, { maximumFractionDigits: 6 })

  let body: string
  if (perDay >= 1) body = `${fmt(perDay)}/day`
  else if (perHour >= 1) body = `${fmt(perHour)}/hour`
  else body = `${fmt(perSecond)}/second`

  const suffix = symbol && symbol.trim() ? ` ${symbol.trim()}` : " tokens"
  return `${body}${suffix}`
}

/** Build the public staking URL for a pool. Uses the pool address as the stable id. */
export function stakingUrlForPool(poolAddress: string): string {
  return `/stake/${poolAddress}`
}

/**
 * Render a raw base-unit balance as an exact decimal string (no exponent,
 * no commas). Used for MAX buttons so the value round-trips through
 * `parseAmountToBaseUnits` without float drift.
 */
export function baseUnitsToDecimalString(base: bigint | number | BN, decimals: number): string {
  const value = BigInt(typeof base === "object" ? base.toString() : base.toString())
  const negative = value < BigInt(0)
  const abs = negative ? -value : value
  const s = abs.toString().padStart(decimals + 1, "0")
  const whole = s.slice(0, s.length - decimals) || "0"
  const frac = decimals > 0 ? s.slice(s.length - decimals) : ""
  const body = decimals > 0 ? `${whole}.${frac}`.replace(/\.?0+$/, "") : whole
  return negative ? `-${body}` : body
}

/**
 * Parse a human-entered decimal amount ("12.5", ".25", "1000") into exact
 * on-chain base units using the mint's decimals.
 *
 * String-based on purpose: float arithmetic (`amount * 10 ** decimals`)
 * loses integer precision for large balances (typical meme-token supplies)
 * and `new BN()` rejects integers beyond 2^53, which crashed MAX-stake for
 * balances above ~9e6 tokens at 9 decimals.
 *
 * Rules:
 *  - only digits with an optional single "." are accepted (no exponents,
 *    signs, or separators); anything else returns null ("invalid amount").
 *  - fractional digits beyond the mint's decimals are TRUNCATED (never
 *    rounded up), so the result can never exceed what the user typed.
 *  - a value that parses to zero base units returns null (zero is handled
 *    by the callers' own `> 0` checks).
 */
export function parseAmountToBaseUnits(input: string, decimals: number): BN | null {
  const trimmed = input.trim()
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") return null

  const [wholeRaw = "0", fracRaw = ""] = trimmed.split(".")
  const whole = wholeRaw === "" ? "0" : wholeRaw
  const frac = decimals > 0 ? fracRaw.slice(0, decimals).padEnd(decimals, "0") : ""
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, "")

  const bn = new BN(digits === "" ? "0" : digits, 10)
  return bn.isZero() ? null : bn
}
