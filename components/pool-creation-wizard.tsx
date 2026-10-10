"use client"

import { useEffect, useState } from "react"
import {
  Check,
  ChevronDown,
  Sparkles,
  CircleCheckBig,
  Copy,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Link2,
  ExternalLink,
  Calendar,
  Percent,
  ShieldAlert,
} from "lucide-react"
import { BN } from "@coral-xyz/anchor"
import { useWallet } from "@solana/wallet-adapter-react"
import { PublicKey } from "@solana/web3.js"
import {
  getMint,
} from "@solana/spl-token"

import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createPool, ensureAta, fetchTokenAccountBalance, setPoolBoost } from "@/lib/solana/ops"
import { invalidatePoolStats } from "@/lib/solana/use-pool-stats"
import { useStakingProgram } from "@/lib/solana/use-staking-program"
import { getUserFacingTxError } from "@/lib/solana/errors"
import { shortenAddress, tryParsePublicKey } from "@/lib/solana/format"
import {
  baseUnitsToTokens,
  formatLockDurationSeconds,
  formatRewardEmission,
  parseAmountToBaseUnits,
  stakingUrlForPool,
} from "@/lib/solana/display"
import { getMintDecimals } from "@/lib/solana/metadata"
import {
  emissionPerSecondForTargetApr,
  formatApproxDuration,
  validateRewardFunding,
} from "@/lib/solana/rewards-calc"
import { resolveMintTokenProgram } from "@/lib/solana/token"
import { isTransientRpcError, withRpcRetry } from "@/lib/solana/transport"
import { getConfiguredNetwork } from "@/lib/solana/network"
import { useTokenMetadata, type TokenMetadataState } from "@/lib/solana/use-token-metadata"
import { CopyAddress } from "@/components/ui/copy-address"

/** Explorer link for a confirmed transaction signature (cluster-aware). */
function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${getConfiguredNetwork()}`
}

type StepId = 0 | 1 | 2
const steps = ["Pool Details", "Reward Configuration", "Review"]

/**
 * Maps the wizard's "+N%" APY multiplier to the exact on-chain `boost_bps`
 * basis points the deployed `set_pool_boost` instruction expects
 * (10_000 bps = +100%, matching MAX_NFT_BOOST_BPS in
 * programs/pumpswap-staking/src/lib.rs). Returns null when the value cannot
 * be represented on-chain so callers fail loudly instead of sending a
 * doomed transaction or silently disabling the boost.
 */
function multiplierToBoostBps(multiplier: number): number | null {
  if (!Number.isFinite(multiplier)) return null
  const boostBps = Math.round(multiplier * 100)
  if (boostBps < 1 || boostBps > 10_000) return null
  return boostBps
}

export function PoolCreationWizard() {
  const { publicKey } = useWallet()
  const { program, readOnlyProgram, canTransact } = useStakingProgram()

  const [step, setStep] = useState<StepId>(0)
  const [deploying, setDeploying] = useState(false)
  const [deployed, setDeployed] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [deployStage, setDeployStage] = useState<string | null>(null)
  const [deployedPoolAddress, setDeployedPoolAddress] = useState<string | null>(null)
  /**
   * REAL transaction signatures of the confirmed deployment flow, kept only
   * after each instruction confirms on-chain, so the success / partial-failure
   * screens can link to Solana Explorer (never an optimistic signature).
   */
  const [deployedTxSignatures, setDeployedTxSignatures] = useState<{
    create: string
    boost: string | null
  }>({ create: "", boost: null })
  const [copied, setCopied] = useState(false)
  /**
   * The pool was created on-chain but the second transaction
   * (`set_pool_boost`) failed. Keeps the created pool address and the REAL
   * error visible instead of claiming success or silently recreating the pool.
   */
  const [boostFailure, setBoostFailure] = useState<{
    poolAddress: string
    message: string
    /** Signature of the CONFIRMED create_pool transaction for this pool. */
    createSignature: string
  } | null>(null)
  const [retryingBoost, setRetryingBoost] = useState(false)

  const [name, setName] = useState("")
  const [stakingMint, setStakingMint] = useState("")
  const [rewardMint, setRewardMint] = useState("")
  // Lock-up duration, stored in SECONDS (the on-chain `lock_duration` unit).
  // 0 = Flexible (no lock). Surfaced via preset buttons + a custom field.
  const [lockSeconds, setLockSeconds] = useState(0)
  const [customLockDays, setCustomLockDays] = useState("")
  // --- Owner-selected target APR + budget/duration sizing ------------------
  // Target APR (%): the owner's chosen annual rate. The program does NOT
  // compound rewards, so every figure derived from it is an estimated
  // (non-compounding) APR - never an APY, never a guarantee.
  const [targetApr, setTargetApr] = useState("")
  // Reference (expected) total stake in whole staking tokens: the
  // assumption the target-APR -> emission conversion is based on.
  const [referenceStake, setReferenceStake] = useState("")
  // Total reward tokens the owner plans to fund and the emission duration
  // the budget must sustain (emission = budget / duration in budget mode).
  const [rewardBudget, setRewardBudget] = useState("")
  const [rewardDurationDays, setRewardDurationDays] = useState("30")

  // Dynamic, on-chain metadata detection for whichever mint is entered.
  // Separate state per token; the mint address remains the source of truth.
  const stakingMeta = useTokenMetadata(stakingMint)
  const rewardMeta = useTokenMetadata(rewardMint)
  const rewardSymbol = rewardMeta.metadata?.symbol || ""

  const [nftOpen, setNftOpen] = useState(false)
  const [nftEnabled, setNftEnabled] = useState(false)
  const [collectionId, setCollectionId] = useState("")
  const [multiplier, setMultiplier] = useState(25)

  const LOCK_PRESETS: { seconds: number; label: string }[] = [
    { seconds: 0, label: "Flexible" },
    { seconds: 86400, label: "1 day" },
    { seconds: 7 * 86400, label: "7 days" },
    { seconds: 30 * 86400, label: "30 days" },
    { seconds: 90 * 86400, label: "90 days" },
    { seconds: 180 * 86400, label: "180 days" },
  ]
  const isPreset = LOCK_PRESETS.some((p) => p.seconds === lockSeconds)

  // --- Target APR / emission sizing (see TARGET_APR.md) ---------------------
  const stakingMintKey = tryParsePublicKey(stakingMint.trim())
  const rewardMintKey = tryParsePublicKey(rewardMint.trim())
  // Same mint => staking and reward tokens share one valuation, so raw token
  // quantities are directly comparable and a target APR can be converted into
  // an emission WITHOUT inventing a USD price. Different mints => no truthful
  // conversion exists (there is no price feed), and we never pretend otherwise.
  const sameMint = !!(stakingMintKey && rewardMintKey && stakingMintKey.equals(rewardMintKey))

  // Exact decimals of both mints (classic SPL Token and Token-2022 alike);
  // null while unknown - a guess must never enter APR math.
  const [mintDecimals, setMintDecimals] = useState<{ staking: number | null; reward: number | null }>({
    staking: null,
    reward: null,
  })
  useEffect(() => {
    let cancelled = false
    const stakingKey = tryParsePublicKey(stakingMint.trim())
    const rewardKey = tryParsePublicKey(rewardMint.trim())
    if (!stakingKey || !rewardKey) {
      setMintDecimals({ staking: null, reward: null })
      return
    }
    void (async () => {
      const connection = readOnlyProgram.provider.connection
      const [staking, reward] = await Promise.all([
        getMintDecimals(connection, stakingKey),
        getMintDecimals(connection, rewardKey),
      ])
      if (!cancelled) setMintDecimals({ staking, reward })
    })()
    return () => {
      cancelled = true
    }
  }, [readOnlyProgram, stakingMint, rewardMint])

  // Available reward funding: the CONNECTED wallet's reward-mint balance.
  // null = not reliably known (disconnected or read failed) - never faked.
  const [availableRewardBase, setAvailableRewardBase] = useState<bigint | null>(null)
  useEffect(() => {
    let cancelled = false
    const rewardKey = tryParsePublicKey(rewardMint.trim())
    if (!program || !publicKey || !rewardKey) {
      setAvailableRewardBase(null)
      return
    }
    void (async () => {
      try {
        const { address, needsCreation } = await ensureAta(program, rewardKey, publicKey)
        const balance = needsCreation ? BigInt(0) : await fetchTokenAccountBalance(program, address)
        if (!cancelled) setAvailableRewardBase(balance)
      } catch {
        // Read failed -> UNKNOWN (null), never a fabricated 0.
        if (!cancelled) setAvailableRewardBase(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [program, publicKey, rewardMint])

  const aprNum = Number.parseFloat(targetApr)
  const referenceStakeNum = Number.parseFloat(referenceStake)
  const durationDaysNum = Number.parseFloat(rewardDurationDays)
  const budgetNum = Number.parseFloat(rewardBudget)

  const durationOk = Number.isFinite(durationDaysNum) && durationDaysNum > 0
  const durationSeconds = durationOk ? BigInt(Math.max(1, Math.round(durationDaysNum * 86_400))) : null

  const aprFieldsTouched = targetApr.trim() !== "" || referenceStake.trim() !== ""
  const aprInputsValid =
    targetApr.trim() !== "" &&
    referenceStake.trim() !== "" &&
    Number.isFinite(aprNum) &&
    aprNum > 0 &&
    Number.isFinite(referenceStakeNum) &&
    referenceStakeNum > 0
  // The APR conversion is only possible with one shared valuation AND known
  // decimals; otherwise the owner's APR is intent only (see funding panel).
  const aprConversionAvailable =
    sameMint && mintDecimals.staking !== null && mintDecimals.reward !== null
  const aprMode = aprInputsValid && durationOk && aprConversionAvailable

  const budgetOk = rewardBudget.trim() !== "" && Number.isFinite(budgetNum) && budgetNum > 0
  const budgetMode = budgetOk && durationSeconds !== null

  const detailsValid = name.trim().length > 2 && stakingMint.trim().length > 30
  const rewardValid =
    rewardMint.trim().length > 30 && durationSeconds !== null && (aprMode || budgetMode)

  // Emission that will be written on-chain as `reward_rate_per_second`
  // (reward-mint base units per second). null = not computable (yet).
  const emissionPerSecondPreview: bigint | null = (() => {
    if (durationSeconds === null) return null
    if (aprMode) {
      if (mintDecimals.staking === null || mintDecimals.reward === null) return null
      const stakeBase = parseAmountToBaseUnits(referenceStake, mintDecimals.staking)
      if (!stakeBase) return null
      return emissionPerSecondForTargetApr({
        aprPercent: aprNum,
        referenceStakeBase: BigInt(stakeBase.toString()),
        stakingDecimals: mintDecimals.staking,
        rewardDecimals: mintDecimals.reward,
      })
    }
    if (budgetMode) {
      if (mintDecimals.reward === null) return null
      const budgetBase = parseAmountToBaseUnits(rewardBudget, mintDecimals.reward)
      if (!budgetBase) return null
      return BigInt(budgetBase.toString()) / durationSeconds
    }
    return null
  })()

  const rewardBudgetBase =
    mintDecimals.reward !== null && rewardBudget.trim() !== ""
      ? parseAmountToBaseUnits(rewardBudget, mintDecimals.reward)
      : null
  const requiredBudgetBase =
    emissionPerSecondPreview !== null && durationSeconds !== null
      ? emissionPerSecondPreview * durationSeconds
      : null
  // In APR mode an empty budget field means "fund exactly what the target
  // requires"; otherwise the entered budget is what must sustain the emission.
  const effectiveBudgetBase =
    rewardBudgetBase ?? (aprMode && requiredBudgetBase !== null ? requiredBudgetBase : null)
  const funding =
    emissionPerSecondPreview !== null &&
    durationSeconds !== null &&
    effectiveBudgetBase !== null &&
    emissionPerSecondPreview > 0n
      ? validateRewardFunding({
          emissionPerSecond: emissionPerSecondPreview,
          budgetBase: BigInt(effectiveBudgetBase.toString()),
          durationSeconds,
        })
      : null

  // Truthful warnings - estimates only, never a promise of return.
  const fundingWarnings: string[] = []
  if (aprMode && emissionPerSecondPreview === 0n) {
    fundingWarnings.push(
      "The selected target rounds below 1 reward base unit per second on-chain. Increase the target APR or the reference stake.",
    )
  }
  if (
    funding &&
    !funding.ok &&
    requiredBudgetBase !== null &&
    effectiveBudgetBase !== null &&
    mintDecimals.reward !== null &&
    funding.sustainSeconds !== null &&
    durationSeconds !== null
  ) {
    fundingWarnings.push(
      `Budget is insufficient for the chosen duration: at this emission it covers ${formatApproxDuration(funding.sustainSeconds)} of ${formatApproxDuration(durationSeconds)} (shortfall ${baseUnitsToTokens(funding.shortfallBase, mintDecimals.reward)} ${rewardSymbol || "reward tokens"}). Fund at least ${baseUnitsToTokens(requiredBudgetBase, mintDecimals.reward)} ${rewardSymbol || "reward tokens"}.`,
    )
  }
  if (
    availableRewardBase !== null &&
    requiredBudgetBase !== null &&
    availableRewardBase < requiredBudgetBase &&
    mintDecimals.reward !== null
  ) {
    fundingWarnings.push(
      `Available reward funding in the connected wallet (${baseUnitsToTokens(availableRewardBase, mintDecimals.reward)} ${rewardSymbol || "tokens"}) is below the estimated requirement (${baseUnitsToTokens(requiredBudgetBase, mintDecimals.reward)} ${rewardSymbol || "tokens"}).`,
    )
  }
  if (aprFieldsTouched && !aprInputsValid) {
    fundingWarnings.push(
      "Fill BOTH Target APR and Reference stake with positive numbers to size the emission by APR — or clear both to size it by reward budget ÷ duration.",
    )
  }
  if (aprInputsValid && durationOk && !sameMint && stakingMintKey && rewardMintKey) {
    fundingWarnings.push(
      "Staking and reward tokens are different mints and no price feed is available, so the target APR cannot be converted into an emission (raw quantities of different tokens are not comparable). The emission will be sized by reward budget ÷ duration; the APR shown is your stated target only.",
    )
  }


  /**
   * Validate the wizard's NFT Boost inputs and apply them to `poolAddress`
   * on-chain via the deployed `set_pool_boost` instruction.
   *
   * Throws a user-facing error when an input is invalid or the transaction
   * fails — success is only ever reported after the instruction confirms on
   * chain, never optimistically. Returns the CONFIRMED transaction signature.
   */
  async function applyNftBoostOnChain(poolAddress: PublicKey): Promise<string> {
    if (!program || !publicKey) {
      throw new Error(
        "Connect the pool authority wallet to configure NFT Boost.",
      )
    }

    const collection = tryParsePublicKey(collectionId.trim())
    if (!collection) {
      throw new Error("The NFT collection ID is not a valid Solana address.")
    }

    const boostBps = multiplierToBoostBps(multiplier)
    if (boostBps === null) {
      throw new Error(
        "The APY multiplier is out of range. Select a value between 5% and 100%.",
      )
    }

    return setPoolBoost(program, {
      poolAddress,
      authority: publicKey,
      collection,
      boostBps,
    })
  }

  /**
   * Re-send ONLY the `set_pool_boost` transaction for the pool that already
   * exists on-chain. Never re-runs createPool, so the created pool is always
   * preserved — only the failed second transaction is retried.
   */
  async function retryBoostConfiguration() {
    if (!boostFailure || retryingBoost || !canTransact) return

    setRetryingBoost(true)
    try {
      const boostSignature = await applyNftBoostOnChain(
        new PublicKey(boostFailure.poolAddress),
      )
      setBoostFailure(null)
      setDeployStage(null)
      setDeployedTxSignatures((prev) => ({
        ...prev,
        boost: boostSignature,
      }))
      setDeployed(true)
      invalidatePoolStats()
    } catch (error) {
      setBoostFailure({
        poolAddress: boostFailure.poolAddress,
        message: getUserFacingTxError(error),
        createSignature: boostFailure.createSignature,
      })
    } finally {
      setRetryingBoost(false)
    }
  }

  async function deploy() {
    setDeployError(null)
    setBoostFailure(null)
    if (!canTransact || !program || !publicKey) {
      setDeployError("Connect your wallet to deploy a pool on-chain.")
      return
    }

    const stakingMintKey = tryParsePublicKey(stakingMint.trim())
    const rewardMintKey = tryParsePublicKey(rewardMint.trim())
    if (!stakingMintKey || !rewardMintKey) {
      setDeployError("One of the token mint addresses is not a valid Solana address.")
      return
    }

    // Validate the NFT Boost inputs BEFORE any transaction so an invalid
    // configuration can never leave behind a pool that silently missed its boost.
    if (nftEnabled) {
      if (!tryParsePublicKey(collectionId.trim())) {
        setDeployError(
          "NFT Boost is enabled but the collection ID is not a valid Solana address. Fix it before deploying.",
        )
        return
      }
      if (multiplierToBoostBps(multiplier) === null) {
        setDeployError(
          "NFT Boost is enabled but the APY multiplier is out of range. Select a value between 5% and 100%.",
        )
        return
      }
    }

    setDeploying(true)
    setDeployStage("Validating token mints")
    setDeployedTxSignatures({ create: "", boost: null })
    try {
      const connection = program.provider.connection

      // Detect the token program that actually owns each mint (classic SPL
      // Token or Token-2022) instead of assuming legacy. Both must be supported:
      // the on-chain accounts are declared with `token_interface`, so any of the
      // four staking/reward token-program combinations is valid.
      // The staking mint's program is resolved (and validated) here as well so
      // a bad staking mint fails with the same user-facing error; only the
      // reward program's result is needed below.
      const [stakingTokenProgram, rewardTokenProgram] = await Promise.all([
        resolveMintTokenProgram(connection, stakingMintKey),
        resolveMintTokenProgram(connection, rewardMintKey),
      ]).catch((error: unknown) => {
        // Never swallow the real reason. A transport failure (RPC unreachable,
        // connection dropped, proxy 502, rate limited) is NOT a problem with
        // the entered mint addresses — say so explicitly, and always keep the
        // technical detail so the actual failure is visible in the UI.
        console.error("[CreatePool] mint token-program detection failed:", error)
        const detail = error instanceof Error ? error.message : String(error)
        if (isTransientRpcError(error)) {
          throw new Error(
            "Could not reach the Solana network while checking your mint addresses — this is a connectivity issue, not a problem with the addresses you entered. Please try again in a moment." +
              `\n\nTechnical details: ${detail}`,
          )
        }
        throw new Error(
          "Both token mints must be classic SPL Token or Token-2022 mints on this network. Check the addresses and try again." +
            `\n\nTechnical details: ${detail}`,
        )
      })

      // Resolve BOTH mints' decimals (each read through its OWN token
      // program - classic SPL Token or Token-2022). Retried on transient
      // transport failures only — a dropped connection must not abort.
      const [stakingMintInfo, rewardMintInfo] = await Promise.all([
        withRpcRetry(() => getMint(connection, stakingMintKey, "confirmed", stakingTokenProgram)),
        withRpcRetry(() => getMint(connection, rewardMintKey, "confirmed", rewardTokenProgram)),
      ])
      const decimals = rewardMintInfo.decimals

      // Convert the owner's chosen configuration into the on-chain emission
      // (`reward_rate_per_second`, reward-mint base units per second).
      let rewardRatePerSecond: BN
      if (aprMode) {
        // APR mode: emission = reference stake x target APR / 1 year.
        // Validated on-chain side by rate > 0; validated HERE against the
        // freshly read decimals (never the possibly-stale preview state).
        const stakeBase = parseAmountToBaseUnits(referenceStake, stakingMintInfo.decimals)
        if (!stakeBase) {
          throw new Error(
            "The reference stake is not a valid token amount for this mint's decimals. Fix it before deploying.",
          )
        }
        const emission = emissionPerSecondForTargetApr({
          aprPercent: aprNum,
          referenceStakeBase: BigInt(stakeBase.toString()),
          stakingDecimals: stakingMintInfo.decimals,
          rewardDecimals: decimals,
        })
        if (emission === null) {
          throw new Error(
            "The target APR could not be converted to an emission. Check the target APR and reference stake.",
          )
        }
        if (emission === 0n) {
          throw new Error(
            "The selected target APR rounds below 1 reward base unit per second on-chain. Increase the target APR or the reference stake.",
          )
        }
        rewardRatePerSecond = new BN(emission.toString())
      } else {
        // Budget mode: emission = reward budget / duration. A target APR
        // entered for different mints stays owner intent only (no price
        // feed => no honest conversion; see the funding panel).
        const budgetBase = parseAmountToBaseUnits(rewardBudget, decimals)
        if (!budgetBase || durationSeconds === null) {
          throw new Error("Reward budget and emission duration are required to size the emission.")
        }
        const perSecond = BigInt(budgetBase.toString()) / durationSeconds
        if (perSecond < 1n) {
          throw new Error(
            "The chosen reward budget ÷ duration rounds below 1 reward base unit per second. Increase the budget or shorten the duration.",
          )
        }
        rewardRatePerSecond = new BN(perSecond.toString())
      }

      const poolId = new BN(Date.now())
      // On-chain lock_duration is in seconds; 0 means Flexible.
      const lockDurationSeconds = new BN(Math.max(0, Math.floor(lockSeconds)))

      setDeployStage("Requesting wallet signature")
      const { poolAddress, signature: createSignature } = await createPool(program, {
        authority: publicKey,
        stakingMint: stakingMintKey,
        rewardMint: rewardMintKey,
        poolId,
        lockDurationSeconds,
        rewardRatePerSecond,
      })

      // Surface the created pool address immediately: if the NFT Boost
      // configuration below fails, the founder must still be able to see and
      // keep track of the pool that now exists on-chain.
      setDeployedPoolAddress(poolAddress.toBase58())
      setDeployedTxSignatures({ create: createSignature, boost: null })

      // Second transaction: configure the NFT boost on the freshly created
      // pool via `set_pool_boost`. The final "Pool Ready" state is only shown
      // after BOTH createPool and setPoolBoost confirm on-chain.
      if (nftEnabled) {
        setDeployStage("Configuring NFT Boost (transaction 2 of 2)")
        try {
          const boostSignature = await applyNftBoostOnChain(poolAddress)
          setDeployedTxSignatures({ create: createSignature, boost: boostSignature })
        } catch (boostError) {
          // Do NOT recreate the pool and do NOT hide the failed transaction:
          // show the real error alongside the created pool address.
          setDeployStage(null)
          setBoostFailure({
            poolAddress: poolAddress.toBase58(),
            message: getUserFacingTxError(boostError),
            createSignature,
          })
          // The pool exists on-chain without its boost — refresh stats so it
          // still shows up everywhere even though configuration failed.
          invalidatePoolStats()
          return
        }
      }

      setDeployStage(null)
      setDeployed(true)
      // Make the shared pool-stats store pick up the new pool immediately.
      invalidatePoolStats()
    } catch (error) {
      // Surface the real error to the console and keep it visible in the UI.
      console.error("[CreatePool] Pool deployment failed:", error)
      setDeployStage(null)
      setDeployError(getUserFacingTxError(error))
    } finally {
      setDeploying(false)
    }
  }

  function copyText(value: string | null) {
    if (!value) return
    navigator.clipboard?.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const stakingUrl = deployedPoolAddress ? stakingUrlForPool(deployedPoolAddress) : null
  const absoluteStakingUrl =
    stakingUrl && typeof window !== "undefined" ? `${window.location.origin}${stakingUrl}` : stakingUrl

  /**
   * Pool created but `set_pool_boost` failed. Shows the created pool address
   * and the REAL transaction error — never claims success, never hides the
   * failed second transaction, and offers a retry that re-sends ONLY the boost
   * configuration (the pool itself is never recreated).
   */
  if (boostFailure) {
    return (
      <Card className="mx-auto max-w-xl p-8 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-destructive/10">
          <ShieldAlert className="size-7 text-destructive" aria-hidden />
        </div>
        <h2 className="mt-5 text-xl font-semibold">
          Pool created — NFT Boost configuration failed
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Your staking pool was created on-chain, but the second transaction that
          applies the NFT Boost settings did not succeed. The pool is live and{" "}
          <strong>running without an NFT boost</strong>. The pool was not
          recreated and nothing was applied silently.
        </p>

        <div className="mt-5 rounded-lg border border-border bg-muted/40 p-4 text-left">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Created pool address
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <code className="truncate font-mono text-sm">
              {boostFailure.poolAddress}
            </code>
            <CopyAddress
              value={boostFailure.poolAddress}
              label="created pool address"
            />
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Requested NFT Boost</span>
            <span className="truncate font-mono text-right">
              +{multiplier}% · {collectionId || "—"}
            </span>
          </div>
          {boostFailure.createSignature && (
            <div className="mt-3 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">create_pool transaction</span>
              <a
                href={explorerTxUrl(boostFailure.createSignature)}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate font-mono text-primary underline underline-offset-2"
              >
                {boostFailure.createSignature}
              </a>
            </div>
          )}
        </div>

        <p className="mt-4 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-left font-mono text-xs text-destructive">
          {boostFailure.message}
        </p>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button
            onClick={() => void retryBoostConfiguration()}
            disabled={retryingBoost || !canTransact}
          >
            {retryingBoost ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />{" "}
                Configuring NFT Boost…
              </>
            ) : (
              "Retry NFT Boost configuration"
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => (window.location.href = "/pools")}
          >
            Go to Pools
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Retry re-sends only the NFT Boost configuration for this pool — it
          never recreates the pool.
        </p>
      </Card>
    )
  }

  if (deployed) {
    return (
      <Card className="mx-auto max-w-xl p-8 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent/15">
          <CircleCheckBig className="size-7 text-accent" aria-hidden />
        </div>
        <h2 className="mt-5 text-xl font-semibold">Pool Ready</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {name || "Your staking pool"} has been deployed to Solana Devnet.
        </p>
        <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4 text-left">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Pool Address</div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <code className="truncate font-mono text-sm">{deployedPoolAddress ?? "—"}</code>
            <button
              onClick={() => copyText(deployedPoolAddress)}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
            >
              {copied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        {/* Confirmed on-chain transaction(s), linked to Solana Explorer. */}
        {deployedTxSignatures.create && (
          <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4 text-left">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              On-chain transactions
            </div>
            <div className="mt-2 flex flex-col gap-1.5 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-muted-foreground">create_pool</span>
                <a
                  href={explorerTxUrl(deployedTxSignatures.create)}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate font-mono text-primary underline underline-offset-2"
                >
                  {deployedTxSignatures.create}
                </a>
              </div>
              {deployedTxSignatures.boost && (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-muted-foreground">set_pool_boost</span>
                  <a
                    href={explorerTxUrl(deployedTxSignatures.boost)}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate font-mono text-primary underline underline-offset-2"
                  >
                    {deployedTxSignatures.boost}
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Custom staking URL — derived from the pool address, stable forever. */}
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4 text-left">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-primary">
            <Link2 className="size-3.5" aria-hidden /> Staking URL
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <code className="truncate font-mono text-sm">{absoluteStakingUrl ?? "—"}</code>
            <button
              onClick={() => copyText(absoluteStakingUrl)}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
            >
              {copied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Share this public page with your community. It is keyed to the pool address, so it never changes.
          </p>
          {stakingUrl && (
            <Link href={stakingUrl} target="_blank" className="mt-3 inline-flex">
              <Button size="sm" className="gap-1.5">
                Open Staking Page <ExternalLink className="size-3.5" aria-hidden />
              </Button>
            </Link>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button
            variant="outline"
            onClick={() => {
              setDeployed(false)
              setStep(0)
              setName("")
              setStakingMint("")
              setRewardMint("")
              setDeployedPoolAddress(null)
              setDeployedTxSignatures({ create: "", boost: null })
            }}
          >
            Deploy Another
          </Button>
          <Button onClick={() => (window.location.href = "/pools")}>Go to Pools</Button>
        </div>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-2xl">
      {/* Stepper */}
      <div className="mb-6 flex items-center">
        {steps.map((label, i) => {
          const done = i < step
          const active = i === step
          return (
            <div key={label} className="flex flex-1 items-center last:flex-none">
              <div className="flex items-center gap-2.5">
                <div
                  className={`flex size-8 items-center justify-center rounded-full border text-sm font-medium transition-colors ${
                    done
                      ? "border-accent bg-accent/15 text-accent"
                      : active
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border text-muted-foreground"
                  }`}
                >
                  {done ? <Check className="size-4" /> : i + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:inline ${
                    active ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div className={`mx-3 h-px flex-1 ${done ? "bg-accent/40" : "bg-border"}`} />
              )}
            </div>
          )
        })}
      </div>

      <Card className="p-6">
        {step === 0 && (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-base font-semibold">Pool Details</h2>
              <p className="text-sm text-muted-foreground">Name your pool and set the staking token.</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Pool Name</Label>
              <Input
                id="name"
                placeholder="e.g. LiquidPump Staking Hub"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="staking-mint">Staking Token Mint Address</Label>
              <Input
                id="staking-mint"
                placeholder="Enter token mint address (e.g. So111...1112)"
                value={stakingMint}
                onChange={(e) => setStakingMint(e.target.value)}
                className="font-mono text-sm"
                aria-invalid={stakingMint.length > 0 && stakingMint.length <= 30}
              />
              <TokenPreview state={stakingMeta} />
              <p className="text-xs text-muted-foreground">The token users will deposit to earn rewards.</p>
            </div>

            {/* Lock-up Duration — stored on-chain as `lock_duration` (seconds). */}
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <Label className="flex items-center gap-1.5">
                  <Calendar className="size-4 text-primary" aria-hidden /> Lock-up Duration
                </Label>
                <span className="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-sm font-semibold text-primary">
                  {formatLockDurationSeconds(lockSeconds)}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {LOCK_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      setLockSeconds(p.seconds)
                      setCustomLockDays("")
                    }}
                    className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                      lockSeconds === p.seconds && !customLockDays
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="custom-lock-days"
                  inputMode="decimal"
                  placeholder="Custom (days)"
                  value={customLockDays}
                  onChange={(e) => {
                    const v = e.target.value
                    setCustomLockDays(v)
                    const d = Number.parseFloat(v)
                    setLockSeconds(Number.isFinite(d) && d > 0 ? Math.round(d * 86400) : 0)
                  }}
                  className="w-40 font-mono text-sm"
                />
                {!isPreset && lockSeconds > 0 && (
                  <span className="text-sm text-muted-foreground">= {formatLockDurationSeconds(lockSeconds)}</span>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                How long deposited tokens stay locked before they can be unstaked. <strong>Flexible</strong> means no
                lock. This value is written on-chain and cannot be changed after deployment.
              </p>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-base font-semibold">Reward Configuration</h2>
              <p className="text-sm text-muted-foreground">
                Set the reward token, your target APR, and the reward budget and duration.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="reward-mint">Reward Token Mint Address</Label>
              <Input
                id="reward-mint"
                placeholder="Enter reward SPL token mint address"
                value={rewardMint}
                onChange={(e) => setRewardMint(e.target.value)}
                className="font-mono text-sm"
                aria-invalid={rewardMint.length > 0 && rewardMint.length <= 30}
              />
              <TokenPreview state={rewardMeta} />
            </div>

            {/* Target APR — the owner-selected rate. Converted to the
                on-chain `reward_rate_per_second` only when staking and reward
                tokens share one valuation (same mint); otherwise it is the
                owner's stated intent and the emission is sized by
                budget ÷ duration (see the funding panel below). */}
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="target-apr" className="flex items-center gap-1.5">
                  <Percent className="size-4 text-primary" aria-hidden /> Target APR
                </Label>
                {aprInputsValid && (
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-sm font-semibold text-primary">
                    {aprNum}% APR (estimated)
                  </span>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="target-apr">Target APR (%)</Label>
                  <div className="relative">
                    <Input
                      id="target-apr"
                      inputMode="decimal"
                      placeholder="e.g. 12.5"
                      value={targetApr}
                      onChange={(e) => setTargetApr(e.target.value)}
                      className="pr-10 font-mono"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                      %
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reference-stake">Reference Total Stake</Label>
                  <div className="relative">
                    <Input
                      id="reference-stake"
                      inputMode="decimal"
                      placeholder="e.g. 1000000"
                      value={referenceStake}
                      onChange={(e) => setReferenceStake(e.target.value)}
                      className="pr-28 font-mono"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                      {stakingMeta.metadata?.symbol || "tokens"}
                    </span>
                  </div>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                The on-chain emission is sized as <strong>reference stake × target APR ÷ 1 year</strong>. Rewards
                are paid linearly without compounding, so this is an estimated <strong>APR</strong> — not an APY,
                and not a guarantee. The realized APR follows actual stake (it falls as more is staked) and can be
                re-targeted later from the Admin page — accrued rewards are always settled at the old rate first.
                Leave both fields empty to size the emission by reward budget ÷ duration instead.
              </p>
            </div>

            {/* Reward budget, emission duration, and the funding check. */}
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="reward-budget" className="flex items-center gap-1.5">
                  <Percent className="size-4 text-primary" aria-hidden /> Reward Budget &amp; Duration
                </Label>
                {emissionPerSecondPreview !== null &&
                  emissionPerSecondPreview > 0n &&
                  mintDecimals.reward !== null && (
                    <span className="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-sm font-semibold text-primary">
                      {(
                        baseUnitsToTokens(emissionPerSecondPreview, mintDecimals.reward) * 86_400
                      ).toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
                      {rewardSymbol || "tokens"}/day
                    </span>
                  )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reward-duration">Emission Duration</Label>
                  <div className="relative">
                    <Input
                      id="reward-duration"
                      inputMode="decimal"
                      placeholder="e.g. 30"
                      value={rewardDurationDays}
                      onChange={(e) => setRewardDurationDays(e.target.value)}
                      className="pr-16 font-mono"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                      days
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reward-budget">Reward Budget (total to fund)</Label>
                  <div className="relative">
                    <Input
                      id="reward-budget"
                      inputMode="decimal"
                      placeholder={aprMode ? "optional: covers requirement" : "e.g. 50000"}
                      value={rewardBudget}
                      onChange={(e) => setRewardBudget(e.target.value)}
                      className="pr-28 font-mono"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                      {rewardSymbol || "tokens"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Funding check: requirement vs. budget vs. wallet balance.
                  Estimates only — never a promise of return. */}
              {emissionPerSecondPreview !== null &&
              emissionPerSecondPreview > 0n &&
              durationSeconds !== null &&
              requiredBudgetBase !== null &&
              mintDecimals.reward !== null ? (
                <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border text-xs">
                  <ReviewRow
                    label="Target rate"
                    value={
                      aprMode
                        ? `${aprNum}% APR (estimated, non-compounding)`
                        : aprInputsValid
                          ? `${aprNum}% APR — not convertible (different tokens)`
                          : "—"
                    }
                  />
                  <ReviewRow
                    label="Estimated funding requirement"
                    value={`${baseUnitsToTokens(requiredBudgetBase, mintDecimals.reward).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${rewardSymbol || "tokens"} over ${formatApproxDuration(durationSeconds)}`}
                  />
                  <ReviewRow
                    label="Available reward funding"
                    value={
                      availableRewardBase !== null
                        ? `${baseUnitsToTokens(availableRewardBase, mintDecimals.reward).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${rewardSymbol || "tokens"} (connected wallet)`
                        : publicKey
                          ? "Not readable right now"
                          : "Connect wallet to check"
                    }
                  />
                  <ReviewRow
                    label="Estimated funding duration"
                    value={
                      funding && funding.sustainSeconds !== null
                        ? formatApproxDuration(funding.sustainSeconds)
                        : "—"
                    }
                  />
                </dl>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The funding check appears once both mint addresses resolve and the target/budget inputs are
                  valid — exact mint decimals are required and are never guessed.
                </p>
              )}

              {fundingWarnings.length > 0 && (
                <ul
                  role="alert"
                  className="space-y-1.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
                >
                  {fundingWarnings.map((warning, index) => (
                    <li key={index} className="flex gap-1.5">
                      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="text-xs leading-relaxed text-muted-foreground">
                <strong>Assumptions:</strong> stake stays at the reference level; emission is linear
                (non-compounding, hence APR); the reward vault stays funded — on-chain claims can never
                distribute more than the vault holds, so rewards stop when funding runs out and are never
                guaranteed. NFT-boosted positions emit extra rewards on top and are not included here.
              </p>
            </div>

            {/* Advanced: NFT Staking Boost — the ONLY advanced section */}
            <div className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setNftOpen((o) => !o)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="size-4 text-primary" aria-hidden />
                  NFT Staking Boost
                </span>
                <ChevronDown
                  className={`size-4 text-muted-foreground transition-transform ${nftOpen ? "rotate-180" : ""}`}
                  aria-hidden
                />
              </button>
              {nftOpen && (
                <div className="flex flex-col gap-4 border-t border-border p-4">
                  <label className="flex items-center justify-between gap-3">
                    <span className="text-sm">Enable NFT boost multiplier</span>
                    <input
                      type="checkbox"
                      checked={nftEnabled}
                      onChange={(e) => setNftEnabled(e.target.checked)}
                      className="size-4 accent-[var(--primary)]"
                    />
                  </label>
                  <p className="rounded-md bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
                    Stakers holding an NFT from your verified Metaplex collection receive a boosted APY. The
                    multiplier is applied on top of the base pool rate.
                  </p>
                  {nftEnabled && (
                    <>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="collection">Verified Metaplex Collection ID</Label>
                        <Input
                          id="collection"
                          placeholder="Collection mint address"
                          value={collectionId}
                          onChange={(e) => setCollectionId(e.target.value)}
                          className="font-mono text-sm"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex items-end justify-between">
                          <Label htmlFor="multiplier">APY Multiplier</Label>
                          <span className="font-mono text-sm font-semibold text-accent">+{multiplier}%</span>
                        </div>
                        <input
                          id="multiplier"
                          type="range"
                          min={5}
                          max={100}
                          step={5}
                          value={multiplier}
                          onChange={(e) => setMultiplier(Number(e.target.value))}
                          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-[var(--accent)]"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-base font-semibold">Review</h2>
              <p className="text-sm text-muted-foreground">Confirm your configuration before deploying.</p>
            </div>
            <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              <ReviewRow label="Pool Name" value={name || "—"} />
              <ReviewRow label="Staking Token" value={stakingMint || "—"} mono />
              <ReviewRow label="Reward Token" value={rewardMint || "—"} mono />
              <ReviewRow label="Lock-up Duration" value={formatLockDurationSeconds(lockSeconds)} />
              <ReviewRow
                label="Emission Source"
                value={aprMode ? "Target APR" : budgetMode ? "Reward budget ÷ duration" : "—"}
              />
              <ReviewRow
                label="Target APR"
                value={
                  aprInputsValid
                    ? `${aprNum}%${sameMint ? "" : " (stated target — not convertible without a price feed)"}`
                    : "—"
                }
              />
              <ReviewRow
                label="Emission Duration"
                value={durationSeconds !== null ? formatApproxDuration(durationSeconds) : "—"}
              />
              <ReviewRow
                label="Reward Budget"
                value={
                  rewardBudgetBase !== null && mintDecimals.reward !== null
                    ? `${baseUnitsToTokens(rewardBudgetBase, mintDecimals.reward).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${rewardSymbol || "tokens"}`
                    : aprMode && requiredBudgetBase !== null && mintDecimals.reward !== null
                      ? `${baseUnitsToTokens(requiredBudgetBase, mintDecimals.reward).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${rewardSymbol || "tokens"} (auto: target requirement)`
                      : "—"
                }
              />
              <ReviewRow
                label="Est. Funding Requirement"
                value={
                  requiredBudgetBase !== null && mintDecimals.reward !== null
                    ? `${baseUnitsToTokens(requiredBudgetBase, mintDecimals.reward).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${rewardSymbol || "tokens"}`
                    : "—"
                }
              />
              <ReviewRow
                label="Emission"
                value={
                  emissionPerSecondPreview !== null &&
                  emissionPerSecondPreview > 0n &&
                  mintDecimals.reward !== null
                    ? formatRewardEmission(emissionPerSecondPreview, mintDecimals.reward, rewardSymbol)
                    : "—"
                }
              />
              <ReviewRow
                label="NFT Boost"
                value={nftEnabled ? `Enabled · +${multiplier}%` : "Disabled"}
              />
              {nftEnabled && <ReviewRow label="Collection ID" value={collectionId || "—"} mono />}
            </dl>
            {fundingWarnings.length > 0 && (
              <ul
                role="alert"
                className="space-y-1.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
              >
                {fundingWarnings.map((warning, index) => (
                  <li key={index} className="flex gap-1.5">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            )}
            {deployError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {deployError}
              </p>
            )}
          </div>
        )}

        {/* Footer nav */}
        <div className="mt-6 flex items-center justify-between border-t border-border pt-5">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1) as StepId)}
            disabled={step === 0 || deploying}
            className="gap-1.5"
          >
            <ArrowLeft className="size-4" /> Back
          </Button>

          {step < 2 ? (
            <Button
              onClick={() => setStep((s) => (s + 1) as StepId)}
              disabled={(step === 0 && !detailsValid) || (step === 1 && !rewardValid)}
              className="gap-1.5"
            >
              Continue <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Button onClick={deploy} disabled={deploying || !canTransact} className="gap-1.5">
              {deploying ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> {deployStage ?? "Deploying..."}
                </>
              ) : canTransact ? (
                "Deploy Pool"
              ) : (
                "Connect Wallet to Deploy"
              )}
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}

function ReviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 truncate text-right text-sm ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  )
}

/**
 * Compact token-preview row shown under a mint input. Reflects the detected
 * on-chain metadata for the current mint; never blocks the form.
 */
function TokenPreview({ state }: { state: TokenMetadataState }) {
  if (state.loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <span>Detecting token...</span>
      </div>
    )
  }

  if (state.metadata) {
    return (
      <div className="flex items-center gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-2">
        {state.metadata.image ? (
          // Off-chain logo URI resolved from the token's metadata JSON.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={state.metadata.image}
            alt={`${state.metadata.name || state.metadata.symbol} logo`}
            className="size-6 shrink-0 rounded-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none"
            }}
          />
        ) : (
          <div
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          >
            {(state.metadata.symbol || state.metadata.name || "?").slice(0, 2).toUpperCase()}
          </div>
        )}
        <span className="truncate text-sm font-medium">{state.metadata.name || "Unknown token"}</span>
        {state.metadata.symbol && (
          <span className="shrink-0 rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">
            {state.metadata.symbol}
          </span>
        )}
        {state.mint && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
            {shortenAddress(state.mint)}
            <CopyAddress value={state.mint} label="mint address" />
          </span>
        )}
      </div>
    )
  }

  if (state.notFound) {
    return (
      <p className="text-xs text-muted-foreground">
        Token metadata not found — you can still use this mint address.
      </p>
    )
  }

  return null
}
