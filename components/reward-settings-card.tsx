"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { BN } from "@coral-xyz/anchor"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { Check, Gauge, Info, Loader2, Percent, TriangleAlert } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CopyAddress } from "@/components/ui/copy-address"

import { useStakingProgram } from "@/lib/solana/use-staking-program"
import { usePoolOptional } from "@/lib/pool-context"
import {
  fetchPool,
  fetchTokenAccountBalance,
  isSetRewardRateSupported,
  setRewardRate,
  type PoolAccount,
} from "@/lib/solana/ops"
import { invalidatePoolStats } from "@/lib/solana/use-pool-stats"
import { getMintDecimals, resolveTokenMeta } from "@/lib/solana/metadata"
import { getUserFacingTxError } from "@/lib/solana/errors"
import { shortenAddress } from "@/lib/solana/format"
import { getConfiguredNetwork } from "@/lib/solana/network"
import {
  baseUnitsToDecimalString,
  baseUnitsToTokens,
  formatRewardEmission,
  parseAmountToBaseUnits,
} from "@/lib/solana/display"
import {
  bpsToPercentString,
  emissionPerSecondForTargetApr,
  estimatedAprBps,
  formatApproxDuration,
  fundingSustainSeconds,
} from "@/lib/solana/rewards-calc"

const SECONDS_PER_DAY = 86_400n

/**
 * Two ways for the pool owner to pick a new on-chain `reward_rate_per_second`:
 *
 *  - "apr":    the owner states a TARGET APR and a REFERENCE staking amount. The
 *              emission is derived with `emissionPerSecondForTargetApr`. This is
 *              only a true APR when the staking and reward tokens share one
 *              valuation (the SAME mint) - comparing raw quantities of two
 *              different tokens is not a valid rate, and this app has no price
 *              feed. Cross-token pools therefore cannot use this mode.
 *  - "direct": the owner states the emission DIRECTLY in reward tokens per day.
 *              No APR is claimed, so it works for every pool, including
 *              cross-token pools (which have no reliable APR without a price
 *              conversion).
 *
 * Either mode produces the SAME on-chain value: `reward_rate_per_second` in
 * reward-mint base units per second, submitted through `setRewardRate()`.
 */
type RateMode = "apr" | "direct"

/**
 * Render an on-chain `reward_rate_per_second` (base units / second) as a human
 * emission string when the reward decimals are known, otherwise fall back to the
 * raw base-unit rate. Never invents decimals.
 */
function describeRate(ratePerSecond: bigint, rewardDecimals: number | null, symbol: string): string {
  if (rewardDecimals === null) return `${ratePerSecond.toString()} base units/sec`
  return formatRewardEmission(ratePerSecond, rewardDecimals, symbol || undefined)
}

export function RewardSettingsCard() {
  const { connection } = useConnection()
  const { publicKey, connected } = useWallet()
  const { program, readOnlyProgram, canTransact } = useStakingProgram()

  // Configure the currently selected pool (from PoolProvider) - never silently
  // the env-default pool when another pool is selected.
  const { poolAddress: poolKey } = usePoolOptional() ?? { poolAddress: null }

  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), [])

  const [pool, setPool] = useState<PoolAccount | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Reward-token metadata + the reward-vault balance that bounds how long a new
  // emission can be sustained. Both are read from the selected pool.
  const [rewardDecimals, setRewardDecimals] = useState<number | null>(null)
  const [stakingDecimals, setStakingDecimals] = useState<number | null>(null)
  const [rewardSymbol, setRewardSymbol] = useState("")
  const [vaultBalance, setVaultBalance] = useState<bigint>(BigInt(0))

  // Whether the DEPLOYED program actually knows `set_reward_rate`. null = the
  // probe is still running; false = the deployed build predates the instruction
  // (saving is disabled with a clear explanation instead of a doomed tx).
  const [supported, setSupported] = useState<boolean | null>(null)

  // Draft form values. The reference stake is seeded from the pool's current
  // total stake (once per selected pool) so a same-mint APR starts from reality.
  const [mode, setMode] = useState<RateMode>("apr")
  const [aprInput, setAprInput] = useState("")
  const [referenceStakeInput, setReferenceStakeInput] = useState("")
  const [directPerDayInput, setDirectPerDayInput] = useState("")

  const [pending, setPending] = useState(false)
  const [txError, setTxError] = useState<string | null>(null)
  const [txSuccess, setTxSuccess] = useState<{ message: string; signature: string } | null>(null)

  // Tracks the pool we last seeded the form from, so a refresh after a save
  // never clobbers what the owner has typed.
  const seededPoolRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const load = async () => {
      if (!poolKey) {
        if (!cancelled) {
          setPool(null)
          setPoolError(null)
          setSupported(null)
          setLoading(false)
        }
        return
      }

      try {
        const loadedPool = await fetchPool(readOnlyProgram, poolKey)
        if (cancelled) return

        const rewardMint = loadedPool.rewardMint
        const [resolvedRewardDecimals, resolvedStakingDecimals, resolvedMeta, vault] =
          await Promise.all([
            getMintDecimals(connection, rewardMint),
            getMintDecimals(connection, loadedPool.stakingMint),
            resolveTokenMeta(rewardMint).catch(() => null),
            fetchTokenAccountBalance(readOnlyProgram, loadedPool.rewardVault),
          ])
        if (cancelled) return

        // Probe the deployed program for `set_reward_rate` support. Uses the
        // pool authority as the simulated signer (always a valid key); any
        // result other than a missing-instruction error counts as supported.
        const supportedResult = await isSetRewardRateSupported(readOnlyProgram, {
          poolAddress: poolKey,
          authority: loadedPool.authority,
        })
        if (cancelled) return

        const sameMint = loadedPool.stakingMint.equals(rewardMint)
        const symbol = resolvedMeta?.symbol?.trim() || shortenAddress(rewardMint.toBase58(), 6)

        setPool(loadedPool)
        setPoolError(null)
        setRewardDecimals(resolvedRewardDecimals)
        setStakingDecimals(resolvedStakingDecimals)
        setRewardSymbol(symbol)
        setVaultBalance(vault)
        setSupported(supportedResult)

        // Seed the draft ONCE per selected pool: default the reference stake to
        // the current total stake, and fall back to direct mode for cross-token
        // pools (which have no truthful APR without a price feed).
        if (seededPoolRef.current !== poolKey.toBase58()) {
          seededPoolRef.current = poolKey.toBase58()
          setMode(sameMint ? "apr" : "direct")
          setAprInput("")
          setDirectPerDayInput("")
          const totalStaked = BigInt(loadedPool.totalStaked.toString())
          if (totalStaked > BigInt(0) && resolvedStakingDecimals !== null) {
            setReferenceStakeInput(
              baseUnitsToDecimalString(loadedPool.totalStaked, resolvedStakingDecimals),
            )
          } else {
            setReferenceStakeInput("")
          }
        }
      } catch (e) {
        if (!cancelled) {
          setPoolError(
            e instanceof Error ? e.message : "Could not load the pool from the program.",
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [poolKey, readOnlyProgram, connection, refreshTick])

  // `set_reward_rate` is signed by the pool authority on-chain; a mismatched
  // wallet would always fail, so saving is gated on it.
  const isAuthority = !!(pool && publicKey && pool.authority.equals(publicKey))
  const sameMint = !!pool && pool.stakingMint.equals(pool.rewardMint)

  const currentRate = pool ? BigInt(pool.rewardRatePerSecond.toString()) : null
  const currentTotalStaked = pool ? BigInt(pool.totalStaked.toString()) : null

  // --- Derive the new on-chain emission (reward base units / second) ---------
  const { emissionPerSecond, emissionError } = (() => {
    if (mode === "apr") {
      if (stakingDecimals === null || rewardDecimals === null) {
        return { emissionPerSecond: null as bigint | null, emissionError: "Token decimals are still loading." }
      }
      const refBase = parseAmountToBaseUnits(referenceStakeInput, stakingDecimals)
      if (!refBase || refBase.lte(new BN(0))) {
        return {
          emissionPerSecond: null,
          emissionError: "Enter a reference staking amount greater than zero.",
        }
      }
      const aprPercent = Number.parseFloat(aprInput)
      const emission = emissionPerSecondForTargetApr({
        aprPercent,
        referenceStakeBase: BigInt(refBase.toString()),
        stakingDecimals,
        rewardDecimals,
      })
      if (emission === null) {
        return {
          emissionPerSecond: null,
          emissionError: "Enter a valid target APR greater than zero.",
        }
      }
      if (emission === 0n) {
        return {
          emissionPerSecond: null,
          emissionError:
            "That target is too small to emit even 1 reward base unit per second. Increase the APR or the reference staking amount.",
        }
      }
      return { emissionPerSecond: emission, emissionError: null }
    }

    // direct mode
    if (rewardDecimals === null) {
      return { emissionPerSecond: null as bigint | null, emissionError: "Reward token decimals are still loading." }
    }
    const perDay = parseAmountToBaseUnits(directPerDayInput, rewardDecimals)
    if (!perDay || perDay.lte(new BN(0))) {
      return {
        emissionPerSecond: null,
        emissionError: "Enter a daily reward emission greater than zero.",
      }
    }
    const emission = BigInt(perDay.toString()) / SECONDS_PER_DAY
    if (emission === 0n) {
      return {
        emissionPerSecond: null,
        emissionError:
          "That daily amount rounds to zero reward base units per second. Enter a larger daily emission.",
      }
    }
    return { emissionPerSecond: emission, emissionError: null }
  })()

  // Estimated APR at the reference stake (same-mint only; truthful estimate).
  const referenceStakeBaseForApr =
    mode === "apr" && stakingDecimals !== null
      ? parseAmountToBaseUnits(referenceStakeInput, stakingDecimals)
      : null
  const estimatedApr =
    sameMint &&
    emissionPerSecond !== null &&
    referenceStakeBaseForApr !== null &&
    stakingDecimals !== null &&
    rewardDecimals !== null
      ? estimatedAprBps({
          emissionPerSecond,
          totalStakedBase: BigInt(referenceStakeBaseForApr.toString()),
          stakingDecimals,
          rewardDecimals,
        })
      : null

  // How long the CURRENTLY funded reward vault sustains the new emission.
  const sustainSeconds =
    emissionPerSecond !== null
      ? fundingSustainSeconds({ budgetBase: vaultBalance, emissionPerSecond })
      : null

  // Current realized APR at the pool's CURRENT total stake (same-mint only).
  const currentAprBps =
    sameMint &&
    currentRate !== null &&
    currentTotalStaked !== null &&
    currentTotalStaked > BigInt(0) &&
    stakingDecimals !== null &&
    rewardDecimals !== null
      ? estimatedAprBps({
          emissionPerSecond: currentRate,
          totalStakedBase: currentTotalStaked,
          stakingDecimals,
          rewardDecimals,
        })
      : null

  const decimalsReady = stakingDecimals !== null && rewardDecimals !== null

  const canSave =
    connected &&
    canTransact &&
    !!program &&
    !!poolKey &&
    !!pool &&
    !loading &&
    !pending &&
    isAuthority &&
    supported === true &&
    decimalsReady &&
    emissionPerSecond !== null &&
    emissionPerSecond > BigInt(0)

  const handleSave = async () => {
    if (!program || !publicKey || !poolKey || !pool) return
    if (!isAuthority) {
      setTxError("Only the pool authority can update the reward rate.")
      return
    }
    if (supported !== true) {
      setTxError(
        supported === false
          ? "The deployed program does not yet support updating the reward rate. This requires a program upgrade."
          : "Still checking whether the deployed program supports updating the reward rate.",
      )
      return
    }
    if (emissionPerSecond === null || emissionPerSecond <= BigInt(0)) {
      setTxError(emissionError ?? "Enter a valid reward emission.")
      return
    }

    setPending(true)
    setTxError(null)
    setTxSuccess(null)

    try {
      const signature = await setRewardRate(program, {
        poolAddress: poolKey,
        authority: publicKey,
        rewardRatePerSecond: new BN(emissionPerSecond.toString()),
      })

      const newEmissionText = describeRate(emissionPerSecond, rewardDecimals, rewardSymbol)
      setTxSuccess({
        message: `Reward emission updated to ${newEmissionText}. Rewards already accrued keep their terms; the new rate applies going forward.`,
        signature,
      })

      // Refresh the shared pool-stats store AND this card's own live read so the
      // displayed reward rate / APR update immediately after confirmation.
      invalidatePoolStats()
      refresh()
    } catch (e) {
      setTxError(getUserFacingTxError(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Gauge className="size-5" aria-hidden />
          </div>
          <div>
            <h2 className="text-base font-semibold">Reward Settings / Target APR</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Set the pool&apos;s on-chain reward emission. Rewards already accrued keep their
              terms — the new rate applies going forward.
            </p>
          </div>
        </div>
        {pool && currentRate !== null && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {currentAprBps !== null
              ? `${bpsToPercentString(currentAprBps)} APR`
              : describeRate(currentRate, rewardDecimals, rewardSymbol)}
          </span>
        )}
      </div>

      {!poolKey && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm font-medium text-muted-foreground">Select a pool</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Pick a pool on the /pools page before configuring its reward settings.
          </p>
        </div>
      )}

      {poolError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <div>{poolError}</div>
          {poolKey && (
            <div className="mt-1.5 flex min-w-0 items-start gap-1.5">
              <span className="shrink-0 text-xs opacity-80">Pool:</span>
              <span className="min-w-0 break-all font-mono text-xs">{poolKey.toBase58()}</span>
              <CopyAddress value={poolKey.toBase58()} label="failed pool address" />
            </div>
          )}
        </div>
      )}

      {poolKey && !poolError && loading && (
        <p className="text-sm text-muted-foreground">Loading on-chain reward configuration…</p>
      )}

      {poolKey && !poolError && !loading && pool && (
        <>
          {/* Current on-chain state */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">Current emission</p>
              <p className="mt-1 font-mono text-sm font-semibold">
                {currentRate === null ? "—" : describeRate(currentRate, rewardDecimals, rewardSymbol)}
              </p>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {currentRate === null ? "" : `${currentRate.toString()} base units/sec`}
              </p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">Current APR (at total stake)</p>
              <p className="mt-1 font-mono text-sm font-semibold">
                {currentAprBps !== null ? bpsToPercentString(currentAprBps) : "Not available"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {currentAprBps !== null
                  ? "Estimated, non-compounding"
                  : sameMint
                    ? "No stake yet"
                    : "Cross-token pool — no price feed"}
              </p>
            </div>
          </div>

          {supported === false && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                The deployed program on this network does not yet support updating the reward rate (
                <code className="font-mono">set_reward_rate</code>). This control is read-only until
                the program is upgraded.
              </div>
            </div>
          )}
          {/* Mode selector */}
          <div className="flex flex-col gap-2">
            <Label>How do you want to set the emission?</Label>
            <div className="inline-flex w-fit gap-1 rounded-lg border border-border p-1">
              <Button
                type="button"
                size="sm"
                variant={mode === "apr" ? "default" : "ghost"}
                disabled={!sameMint || pending}
                onClick={() => setMode("apr")}
                title={
                  sameMint
                    ? "Derive the emission from a target APR"
                    : "Target APR needs a price feed for cross-token pools"
                }
              >
                <Percent className="size-4" aria-hidden /> Target APR
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "direct" ? "default" : "ghost"}
                disabled={pending}
                onClick={() => setMode("direct")}
              >
                <Gauge className="size-4" aria-hidden /> Direct reward rate
              </Button>
            </div>
            {!sameMint && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                This pool stakes and rewards with different tokens, so a reliable APR cannot be
                computed without a price conversion (this app has no price feed). Use{" "}
                <strong>Direct reward rate</strong> to manage the emission directly.
              </p>
            )}
          </div>

          {/* Inputs */}
          {mode === "apr" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="reward-target-apr">Target APR (%)</Label>
                <div className="relative">
                  <Input
                    id="reward-target-apr"
                    inputMode="decimal"
                    placeholder="e.g. 12.5"
                    value={aprInput}
                    disabled={!isAuthority || pending || supported !== true}
                    onChange={(e) => setAprInput(e.target.value)}
                    className="pr-10 font-mono"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                    %
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Annual, non-compounding. The realized APR moves with the actual total stake.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="reward-reference-stake">Reference staking amount</Label>
                <div className="relative">
                  <Input
                    id="reward-reference-stake"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={referenceStakeInput}
                    disabled={!isAuthority || pending || supported !== true}
                    onChange={(e) => setReferenceStakeInput(e.target.value)}
                    className="pr-16 font-mono"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                    staked
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  The expected total stake the target APR is sized against. Seeded from the current
                  total stake.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="reward-direct-rate">Reward emission (tokens / day)</Label>
              <div className="relative">
                <Input
                  id="reward-direct-rate"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={directPerDayInput}
                  disabled={!isAuthority || pending || supported !== true}
                  onChange={(e) => setDirectPerDayInput(e.target.value)}
                  className="pr-16 font-mono"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                  {rewardSymbol || "tokens"}/day
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Total reward tokens emitted across all stakers each day. Converted to the on-chain
                rate using the reward token&apos;s decimals ({rewardDecimals ?? "?"}). No APR is
                claimed for this emission.
              </p>
            </div>
          )}
          {/* Live preview of the resulting on-chain value + budget duration */}
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Info className="size-3.5" aria-hidden /> Preview
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">New emission</p>
                <p className="mt-0.5 font-mono text-sm font-semibold">
                  {emissionPerSecond !== null
                    ? describeRate(emissionPerSecond, rewardDecimals, rewardSymbol)
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">On-chain rate</p>
                <p className="mt-0.5 font-mono text-sm font-semibold">
                  {emissionPerSecond !== null ? `${emissionPerSecond.toString()} /sec` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  {mode === "apr" ? "APR at reference stake" : "Reward-budget duration"}
                </p>
                <p className="mt-0.5 font-mono text-sm font-semibold">
                  {mode === "apr"
                    ? estimatedApr !== null
                      ? bpsToPercentString(estimatedApr)
                      : "—"
                    : sustainSeconds !== null
                      ? formatApproxDuration(sustainSeconds)
                      : "—"}
                </p>
              </div>
            </div>
            {mode === "direct" && (
              <p className="text-xs text-muted-foreground">
                {vaultBalance === BigInt(0)
                  ? "The reward vault is empty — fund it to sustain any emission."
                  : sustainSeconds !== null
                    ? `The current vault balance (${baseUnitsToTokens(vaultBalance, rewardDecimals ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${rewardSymbol || "tokens"}) sustains this emission for ~${formatApproxDuration(sustainSeconds)}.`
                    : "Fund the reward vault to sustain this emission."}
              </p>
            )}
            {emissionError && (
              <p className="text-xs text-warning" role="alert">
                {emissionError}
              </p>
            )}
          </div>

          {!connected && (
            <p className="text-xs text-muted-foreground">
              Connect the pool authority wallet to update the reward rate.
            </p>
          )}

          {connected && !isAuthority && (
            <div
              role="alert"
              className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
            >
              The connected wallet is not this pool&apos;s authority, so it cannot change the reward
              rate. Switch to the pool authority wallet.
            </div>
          )}

          <Button onClick={() => void handleSave()} disabled={!canSave}>
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Updating…
              </>
            ) : (
              <>
                <Gauge className="size-4" aria-hidden /> Update Reward Rate
              </>
            )}
          </Button>

          {txError && (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {txError}
            </div>
          )}

          {txSuccess && !pending && (
            <div className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/10 p-3 text-xs text-accent">
              <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="min-w-0">
                <div>{txSuccess.message}</div>
                <div className="mt-1 truncate font-mono">
                  <a
                    href={`https://explorer.solana.com/tx/${txSuccess.signature}?cluster=${getConfiguredNetwork()}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                  >
                    {txSuccess.signature}
                  </a>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  )
}



