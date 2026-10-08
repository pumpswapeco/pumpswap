"use client"

import { useCallback, useEffect, useState } from "react"
import { BN } from "@coral-xyz/anchor"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { PublicKey } from "@solana/web3.js"
import {
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import { Check, Coins, Landmark, Loader2, Wallet } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { useStakingProgram } from "@/lib/solana/use-staking-program"
import { usePoolOptional } from "@/lib/pool-context"
import { findRewardVaultPda } from "@/lib/solana/pda"
import { getMintDecimals, resolveTokenMeta } from "@/lib/solana/metadata"
import { resolveMintTokenProgram } from "@/lib/solana/token"
import {
  fetchPool,
  fetchTokenAccountBalance,
  fundRewards,
  type PoolAccount,
} from "@/lib/solana/ops"
import { getUserFacingTxError } from "@/lib/solana/errors"
import { shortenAddress } from "@/lib/solana/format"
import { getConfiguredNetwork } from "@/lib/solana/network"
import { baseUnitsToTokens, parseAmountToBaseUnits } from "@/lib/solana/display"
import { CopyAddress } from "@/components/ui/copy-address"

/** Convert a human token amount (decimal string) to raw base units. */
function toBaseUnits(amount: string, decimals: number): BN {
  // Exact string-based parsing (never float): values beyond Number.MAX_SAFE_INTEGER
  // and sub-base-unit fractional digits are handled deterministically.
  return parseAmountToBaseUnits(amount, decimals) ?? new BN(0)
}

/** Render a raw base-unit balance as an exact decimal string (no commas). */
function baseUnitsToDecimalString(base: bigint, decimals: number): string {
  const s = base.toString().padStart(decimals + 1, "0")
  const whole = s.slice(0, s.length - decimals) || "0"
  const frac = s.slice(s.length - decimals)
  return `${whole}.${frac}`.replace(/\.?0+$/, "")
}

export function FundRewardsCard() {
  const { connection } = useConnection()
  const { publicKey, connected } = useWallet()
  const { program, readOnlyProgram, canTransact } = useStakingProgram()

  // Fund the currently selected pool (from PoolProvider) - never silently the
  // env-default pool when another pool is selected.
  const { poolAddress: poolKey } = usePoolOptional() ?? { poolAddress: null }

  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), [])

  const [pool, setPool] = useState<PoolAccount | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)
  const [rewardDecimals, setRewardDecimals] = useState<number | null>(null)
  // Token program that actually OWNs this pool's reward mint (classic SPL Token
  // or Token-2022), detected from the mint account - never assumed. Every ATA
  // derivation and balance read below uses it.
  const [rewardTokenProgram, setRewardTokenProgram] = useState<PublicKey | null>(null)
  const [rewardSymbol, setRewardSymbol] = useState("")
  const [rewardMintAddress, setRewardMintAddress] = useState("")
  const [vaultAddress, setVaultAddress] = useState("")
  const [vaultBalance, setVaultBalance] = useState<bigint>(BigInt(0))
  const [walletBalance, setWalletBalance] = useState<bigint>(BigInt(0))
  const [loading, setLoading] = useState(true)

  const [amount, setAmount] = useState("")
  const [pending, setPending] = useState(false)
  const [txError, setTxError] = useState<string | null>(null)
  const [txSuccess, setTxSuccess] = useState<{
    message: string
    signature: string
  } | null>(null)

  const funderRewardAta =
    poolKey && publicKey && pool && rewardTokenProgram
      ? getAssociatedTokenAddressSync(
          pool.rewardMint,
          publicKey,
          false,
          rewardTokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        )
      : null

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const load = async () => {
      if (!poolKey) {
        // No pool selected: show an explicit "Select a pool" state and never
        // construct a funding transaction (and never silently target the
        // env-default pool).
        if (!cancelled) {
          setPool(null)
          setPoolError(null)
          setRewardTokenProgram(null)
          setLoading(false)
        }
        return
      }

      try {
        const loadedPool = await fetchPool(readOnlyProgram, poolKey)
        if (cancelled) return

        const rewardMint = loadedPool.rewardMint
        const [rewardVaultPda] = findRewardVaultPda(poolKey, readOnlyProgram.programId)
        // The reward mint's token program (classic SPL Token or Token-2022) is
        // detected from the mint account; decimals, the funder ATA and the vault
        // balance all follow it.
        const [tokenProgramId, resolvedDecimals, resolvedMeta] = await Promise.all([
          resolveMintTokenProgram(connection, rewardMint),
          getMintDecimals(connection, rewardMint),
          resolveTokenMeta(rewardMint).catch(() => null),
        ])
        if (cancelled) return

        const funderAta =
          publicKey && rewardMint
            ? getAssociatedTokenAddressSync(
                rewardMint,
                publicKey,
                false,
                tokenProgramId,
                ASSOCIATED_TOKEN_PROGRAM_ID,
              )
            : null

        const [vault, wallet] = await Promise.all([
          fetchTokenAccountBalance(readOnlyProgram, rewardVaultPda),
          funderAta
            ? fetchTokenAccountBalance(readOnlyProgram, funderAta)
            : Promise.resolve(BigInt(0)),
        ])

        if (cancelled) return

        setPool(loadedPool)
        setPoolError(null)
        setRewardTokenProgram(tokenProgramId)
        setRewardDecimals(resolvedDecimals ?? 9)
        setRewardSymbol(
          resolvedMeta?.symbol?.trim() || shortenAddress(rewardMint.toBase58(), 6),
        )
        setRewardMintAddress(rewardMint.toBase58())
        setVaultAddress(rewardVaultPda.toBase58())
        setVaultBalance(vault)
        setWalletBalance(wallet)
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
  }, [poolKey, readOnlyProgram, connection, publicKey, refreshTick])

  const decimals = rewardDecimals ?? 9
  const vaultFormatted = baseUnitsToTokens(vaultBalance, decimals).toLocaleString(undefined, {
    maximumFractionDigits: Math.min(decimals, 6),
  })
  const walletFormatted = baseUnitsToTokens(walletBalance, decimals).toLocaleString(undefined, {
    maximumFractionDigits: Math.min(decimals, 6),
  })

  const amountBase = toBaseUnits(amount, decimals)
  const numericAmount = Number.parseFloat(amount) || 0
  const amountInvalid =
    amountBase.lte(new BN(0)) || amountBase.gt(new BN(walletBalance.toString()))
  const canFund =
    connected &&
    canTransact &&
    !!pool &&
    !!funderRewardAta &&
    !loading &&
    !pending &&
    !amountInvalid

  const handleSetMax = () => {
    if (walletBalance > BigInt(0)) {
      setAmount(baseUnitsToDecimalString(walletBalance, decimals))
    } else {
      setAmount("")
    }
  }

  const handleFund = async () => {
    if (!program || !canTransact || !publicKey || !poolKey || !pool || !funderRewardAta) return

    if (amountBase.lte(new BN(0))) {
      setTxError("Enter an amount greater than zero.")
      return
    }
    if (amountBase.gt(new BN(walletBalance.toString()))) {
      setTxError(`Amount exceeds the ${rewardSymbol || "reward"} balance in your wallet.`)
      return
    }

    setPending(true)
    setTxError(null)
    setTxSuccess(null)

    try {
      const signature = await fundRewards(program, {
        poolAddress: poolKey,
        pool,
        funder: publicKey,
        amount: amountBase,
      })

      setTxSuccess({
        message: `Funded ${numericAmount.toLocaleString(undefined, {
          maximumFractionDigits: Math.min(decimals, 6),
        })} ${rewardSymbol || "reward"} tokens into the reward vault.`,
        signature,
      })
      setAmount("")
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
            <Coins className="size-5" aria-hidden />
          </div>
          <div>
            <h2 className="text-base font-semibold">Fund Rewards</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Deposit reward tokens into the pool&apos;s reward vault so stakers can claim.
            </p>
          </div>
        </div>
      </div>

      {!poolKey && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm font-medium text-muted-foreground">Select a pool</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Pick a pool on the /pools page before funding its reward vault.
          </p>
        </div>
      )}

      {poolError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <div>{poolError}</div>
          {/* Always name the pool the failed read targeted: without it the
              admin cannot tell whether the console is stuck on a stale or
              legacy pool. Address only - never RPC / credential details. */}
          {poolKey && (
            <div className="mt-1.5 flex min-w-0 items-start gap-1.5">
              <span className="shrink-0 text-xs opacity-80">Pool:</span>
              <span className="min-w-0 break-all font-mono text-xs">
                {poolKey.toBase58()}
              </span>
              <CopyAddress value={poolKey.toBase58()} label="failed pool address" />
            </div>
          )}
        </div>
      )}

      {poolKey && !poolError && (
        <>
          {/* Balances overview */}
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
            <div className="bg-card p-3">
              <div className="text-xs text-muted-foreground">Selected Pool</div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5">
                <div className="min-w-0 truncate font-mono text-sm font-semibold tabular-nums">
                  {poolKey ? shortenAddress(poolKey.toBase58(), 8) : "—"}
                </div>
                {poolKey && (
                  <CopyAddress value={poolKey.toBase58()} label="pool address" />
                )}
              </div>
              {poolKey && (
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {poolKey.toBase58()}
                </div>
              )}
            </div>

            <div className="bg-card p-3">
              <div className="text-xs text-muted-foreground">Reward Token</div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5">
                <div className="min-w-0 truncate font-mono text-sm font-semibold tabular-nums">
                  {rewardSymbol ||
                    (rewardMintAddress ? shortenAddress(rewardMintAddress, 6) : "…")}
                </div>
                {rewardMintAddress && (
                  <CopyAddress value={rewardMintAddress} label="reward mint address" />
                )}
              </div>
              {rewardMintAddress && (
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {shortenAddress(rewardMintAddress, 8)} · {decimals} decimals
                </div>
              )}
            </div>

            <div className="bg-card p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Landmark className="size-3.5" aria-hidden /> Reward Vault Balance
              </div>
              <div className="mt-1 truncate font-mono text-sm font-semibold tabular-nums text-primary">
                {loading ? "Loading…" : `${vaultFormatted} ${rewardSymbol || "tokens"}`}
              </div>
              {vaultAddress && (
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                    {shortenAddress(vaultAddress, 8)}
                  </span>
                  <CopyAddress value={vaultAddress} label="reward vault address" />
                </div>
              )}
            </div>

            <div className="bg-card p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Wallet className="size-3.5" aria-hidden /> Admin Wallet Balance
              </div>
              <div className="mt-1 truncate font-mono text-sm font-semibold tabular-nums">
                {!connected
                  ? "Wallet not connected"
                  : loading
                    ? "Loading…"
                    : `${walletFormatted} ${rewardSymbol || "tokens"}`}
              </div>
              {connected && publicKey && (
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                    {shortenAddress(publicKey.toBase58(), 8)}
                  </span>
                  <CopyAddress value={publicKey.toBase58()} label="admin wallet address" />
                </div>
              )}
            </div>
          </div>

          {/* Amount input */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="fund-amount">Amount to Fund</Label>
            <div className="relative">
              <Input
                id="fund-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                disabled={!connected || loading || pending}
                onChange={(e) => setAmount(e.target.value)}
                className="pr-16 font-mono"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                {rewardSymbol || "TOKEN"}
              </span>
            </div>
            {connected && walletBalance > BigInt(0) && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  Available:{" "}
                  <span className="font-mono">
                    {walletFormatted} {rewardSymbol || "tokens"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={handleSetMax}
                  disabled={!connected || loading || pending}
                  className="text-xs font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  MAX
                </button>
              </div>
            )}
            {!connected && (
              <p className="text-xs text-muted-foreground">
                Connect the wallet that holds reward tokens to fund this pool.
              </p>
            )}
          </div>

          {/* Action + states */}
          <Button onClick={() => void handleFund()} disabled={!canFund}>
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Funding…
              </>
            ) : (
              <>
                <Coins className="size-4" aria-hidden /> Fund Rewards
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