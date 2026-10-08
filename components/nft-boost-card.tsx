"use client"

import { useCallback, useEffect, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { PublicKey } from "@solana/web3.js"
import { Check, Loader2, Percent, Sparkles } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CopyAddress } from "@/components/ui/copy-address"

import { useStakingProgram } from "@/lib/solana/use-staking-program"
import { usePoolOptional } from "@/lib/pool-context"
import { fetchPool, setPoolBoost, type PoolAccount } from "@/lib/solana/ops"
import { invalidatePoolStats } from "@/lib/solana/use-pool-stats"
import { getUserFacingTxError } from "@/lib/solana/errors"
import { shortenAddress, tryParsePublicKey } from "@/lib/solana/format"
import { getConfiguredNetwork } from "@/lib/solana/network"

/**
 * Must match `MAX_NFT_BOOST_BPS` in programs/pumpswap-staking/src/lib.rs:
 * 10_000 bps = +100% extra rewards (the on-chain maximum).
 */
const MAX_NFT_BOOST_BPS = 10_000

/** Format on-chain basis points as a human percentage (2500 -> "+25%"). */
function formatBoostPercent(boostBps: number): string {
  const text = (boostBps / 100).toFixed(2).replace(/\.?0+$/, "") || "0"
  return `+${text}%`
}

/**
 * Parse the admin's boost percentage entry into whole on-chain basis points.
 *
 * Accepts an integer percentage or up to two decimals (25 -> 2500 bps,
 * 12.5 -> 1250 bps) so the conversion is EXACT - nothing is silently rounded.
 * Returns null whenever the value cannot be represented on-chain (not a
 * number, negative, or more than 100%), so callers can reject the input
 * instead of sending a doomed transaction.
 */
function percentToBoostBps(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const boostBps = Math.round(Number(trimmed) * 100)
  if (!Number.isInteger(boostBps) || boostBps < 0 || boostBps > MAX_NFT_BOOST_BPS) {
    return null
  }
  return boostBps
}

export function NftBoostCard() {
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

  // Draft form values. Seeded from the LIVE on-chain configuration whenever the
  // selected pool (or this card after a save) reloads.
  const [collectionInput, setCollectionInput] = useState("")
  const [percentInput, setPercentInput] = useState("")

  const [pending, setPending] = useState(false)
  const [txError, setTxError] = useState<string | null>(null)
  const [txSuccess, setTxSuccess] = useState<{
    message: string
    signature: string
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const load = async () => {
      if (!poolKey) {
        // No pool selected: show an explicit "Select a pool" state and never
        // construct a boost transaction (and never silently target the
        // env-default pool).
        if (!cancelled) {
          setPool(null)
          setPoolError(null)
          setCollectionInput("")
          setPercentInput("")
          setLoading(false)
        }
        return
      }

      try {
        const loadedPool = await fetchPool(readOnlyProgram, poolKey)
        if (cancelled) return

        setPool(loadedPool)
        setPoolError(null)
        // Seed the form from on-chain truth so the inputs and the summary
        // always agree, including right after a save.
        setCollectionInput(
          loadedPool.nftCollection.equals(PublicKey.default)
            ? ""
            : loadedPool.nftCollection.toBase58(),
        )
        setPercentInput(String(loadedPool.nftBoostBps / 100))
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
  }, [poolKey, readOnlyProgram, refreshTick])

  // Live on-chain values shown in the summary.
  const collectionBase58 =
    pool && !pool.nftCollection.equals(PublicKey.default) ? pool.nftCollection.toBase58() : ""
  const boostActive = !!pool && pool.nftBoostBps > 0
  // `set_pool_boost` is signed by the pool authority on-chain; a mismatched
  // wallet would always fail, so saving is gated on it.
  const isAuthority = !!(pool && publicKey && pool.authority.equals(publicKey))

  const canSave =
    connected &&
    canTransact &&
    !!program &&
    !!poolKey &&
    !!pool &&
    !loading &&
    !pending &&
    isAuthority


  const handleSave = async () => {
    if (!program || !publicKey || !poolKey || !pool) return

    // --- Validation BEFORE any transaction -------------------------------
    const boostBps = percentToBoostBps(percentInput)
    if (boostBps === null) {
      setTxError(
        `Boost must be a whole percentage from 0% to 100% (0-${MAX_NFT_BOOST_BPS} basis points).`,
      )
      return
    }

    let collection: PublicKey
    if (boostBps === 0) {
      // Clearing the boost. On-chain `normalize_boost` stores the default
      // (all-zeros) collection together with 0 bps, so send the same
      // placeholder the pool starts with. No collection is required here.
      collection = PublicKey.default
    } else {
      const parsed = tryParsePublicKey(collectionInput)
      if (!parsed) {
        setTxError("Enter a valid NFT collection address to enable the boost.")
        return
      }
      if (parsed.equals(PublicKey.default)) {
        setTxError(
          "The default/system placeholder is not a real NFT collection. Enter the collection address, or set the boost to 0% to disable it.",
        )
        return
      }
      collection = parsed
    }

    setPending(true)
    setTxError(null)
    setTxSuccess(null)

    try {
      const signature = await setPoolBoost(program, {
        poolAddress: poolKey,
        authority: publicKey,
        collection,
        boostBps,
      })

      setTxSuccess({
        message:
          boostBps === 0
            ? "NFT Boost disabled for this pool - stakers earn base rewards only."
            : `NFT Boost set to ${formatBoostPercent(boostBps)} for this pool.`,
        signature,
      })

      // Refresh the shared pool-stats store AND this card's own live read so
      // the displayed collection / boost update immediately.
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
          <div className="flex size-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Sparkles className="size-5" aria-hidden />
          </div>
          <div>
            <h2 className="text-base font-semibold">NFT Boost</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Set the NFT collection and reward multiplier for the selected pool. Holders of a
              verified collection NFT earn boosted rewards - up to +100%.
            </p>
          </div>
        </div>
        {pool && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              boostActive
                ? "border-accent/25 bg-accent/10 text-accent"
                : "border-border bg-muted text-muted-foreground"
            }`}
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {boostActive ? "Active" : "Off"}
          </span>
        )}
      </div>

      {!poolKey && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm font-medium text-muted-foreground">Select a pool</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Pick a pool on the /pools page before configuring its NFT Boost.
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
          {/* Live on-chain configuration */}
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
            <div className="bg-card p-3">
              <div className="text-xs text-muted-foreground">Current NFT Collection</div>
              {loading ? (
                <div className="mt-1 truncate font-mono text-sm text-muted-foreground">
                  Loading…
                </div>
              ) : collectionBase58 ? (
                <>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5">
                    <div className="min-w-0 truncate font-mono text-sm font-semibold tabular-nums">
                      {shortenAddress(collectionBase58, 8)}
                    </div>
                    <CopyAddress value={collectionBase58} label="NFT collection address" />
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {collectionBase58}
                  </div>
                </>
              ) : (
                <div className="mt-1 text-sm font-semibold text-muted-foreground">
                  Not set - boost disabled
                </div>
              )}
            </div>

            <div className="bg-card p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Percent className="size-3.5" aria-hidden /> Current Boost
              </div>
              {loading ? (
                <div className="mt-1 truncate font-mono text-sm text-muted-foreground">
                  Loading…
                </div>
              ) : boostActive && pool ? (
                <div className="mt-1 truncate font-mono text-sm font-semibold tabular-nums text-primary">
                  {formatBoostPercent(pool.nftBoostBps)}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    ({pool.nftBoostBps} bps)
                  </span>
                </div>
              ) : (
                <div className="mt-1 text-sm font-semibold text-muted-foreground">
                  Off - stakers earn base rewards only
                </div>
              )}
            </div>
          </div>


          {/* NFT collection address */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="nft-collection">NFT Collection Address</Label>
            <Input
              id="nft-collection"
              placeholder="Collection mint address"
              value={collectionInput}
              disabled={!connected || loading || pending}
              onChange={(e) => setCollectionInput(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Required when the boost is greater than 0%. Leave empty to keep the boost disabled.
            </p>
          </div>

          {/* Boost percentage */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="nft-boost-percent">Boost Percentage</Label>
            <div className="relative">
              <Input
                id="nft-boost-percent"
                inputMode="decimal"
                placeholder="0"
                value={percentInput}
                disabled={!connected || loading || pending}
                onChange={(e) => setPercentInput(e.target.value)}
                className="pr-16 font-mono"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                %
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              0% clears and disables the boost. Maximum 100% (10,000 basis points).
            </p>
          </div>

          {!connected && (
            <p className="text-xs text-muted-foreground">
              Connect the pool authority wallet to configure NFT Boost.
            </p>
          )}

          {connected && pool && publicKey && !isAuthority && (
            <div
              role="alert"
              className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
            >
              The connected wallet is not this pool&apos;s authority, so it cannot change NFT Boost.
              Switch to the pool authority wallet.
            </div>
          )}

          <Button onClick={() => void handleSave()} disabled={!canSave}>
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Saving…
              </>
            ) : (
              <>
                <Sparkles className="size-4" aria-hidden /> Save NFT Boost
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

