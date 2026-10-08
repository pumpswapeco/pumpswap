
"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { BN } from "@coral-xyz/anchor"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { PublicKey } from "@solana/web3.js"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
} from "@solana/spl-token"
import {
  ArrowLeft,
  Calendar,
  Check,
  Coins,
  Gift,
  ImageOff,
  Loader2,
  Lock,
  Percent,
  ShieldAlert,
  Sparkles,
  Wallet,
} from "lucide-react"

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NetworkBadge } from "@/components/network-badge"
import { WalletButton } from "@/components/wallet-button"
import { PoolStatusBadge } from "@/components/pool-status"
import { useStakingProgram } from "@/lib/solana/use-staking-program"
import { useTokenMetadata } from "@/lib/solana/use-token-metadata"
import {
  useWalletNfts,
  type WalletNft,
  type WalletNftsState,
} from "@/lib/solana/use-wallet-nfts"
import { getMintDecimals } from "@/lib/solana/metadata"
import { resolveMintTokenProgram } from "@/lib/solana/token"
import { useWhiteLabelConfig } from "@/lib/white-label"
import { BrandTheme } from "@/components/brand-theme"

import {
  fetchPool,
  fetchUserPosition,
  stake as stakeOnChain,
  unstake as unstakeOnChain,
  claimRewards,
  computePendingRewards,
  computeUpdatedRewardPerToken,
  type PoolAccount,
  type UserPositionAccount,
} from "@/lib/solana/ops"

import { getUserFacingTxError } from "@/lib/solana/errors"
import { shortenAddress, tryParsePublicKey } from "@/lib/solana/format"
import { getConfiguredNetwork } from "@/lib/solana/network"
import {
  formatLockDurationSeconds,
  formatRewardEmission,
  baseUnitsToTokens,
  baseUnitsToDecimalString,
  parseAmountToBaseUnits,
} from "@/lib/solana/display"
import { formatTokenUnitAmount } from "@/lib/solana/activity-display"
import { CopyAddress } from "@/components/ui/copy-address"

/** Explorer link for a confirmed transaction signature (cluster-aware). */
function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${getConfiguredNetwork()}`
}

/** Confirmed-transaction banner data: message + signature for the explorer link. */
type TxSuccess = { message: string; signature: string }

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; pool: PoolAccount }

type Program = ReturnType<typeof useStakingProgram>["program"]
type Conn = ReturnType<typeof useConnection>["connection"]

export function PoolStakingClient({
  poolAddress,
}: {
  poolAddress: string
}) {
  const { connection } = useConnection()
  const { publicKey, connected } = useWallet()
  const { program, readOnlyProgram, canTransact } = useStakingProgram()

  const poolKey = useMemo(
    () => tryParsePublicKey(poolAddress),
    [poolAddress],
  )

  // White-label branding saved by the founder on /white-label (localStorage).
  // Pure presentation - the pool address, rewards, and all on-chain data stay
  // 100% real. Branding is POOL-SCOPED and follows the pool from the URL.
  const brand = useWhiteLabelConfig(poolKey ? poolKey.toBase58() : undefined)

  const [state, setState] = useState<LoadState>({
    status: "loading",
  })

  const [position, setPosition] =
    useState<UserPositionAccount | null>(null)

  /**
   * Set ONLY when the UserPosition READ failed (RPC error / HTTP 429).
   * Distinguishes "we could not read the position" from the legitimate
   * "this wallet has no position" (position === null), so an RPC failure
   * can never render as a fake zero-staked balance.
   */
  const [positionError, setPositionError] =
    useState<string | null>(null)

  const [refreshTick, setRefreshTick] = useState(0)

  // Transaction success message is owned by THIS component, not PoolBody:
  // right after a confirmed unstake, `onRefresh()` bumps `refreshTick`, the
  // pool-load effect flips the page to `status: "loading"`, and PoolBody
  // unmounts (rendered as LoadingCard instead). A message kept in PoolBody's
  // local state would be destroyed at that moment and the banner could never
  // reappear after the refetch. Keeping it here lets it survive the
  // unmount/remount cycle so the confirmed-unstake banner renders once the
  // pool is ready again.
  const [txSuccess, setTxSuccess] = useState<TxSuccess | null>(null)

  // The message belongs to the pool it happened on: switching pools clears
  // it (previously guaranteed by PoolBody unmounting when the pool changed).
  useEffect(() => {
    setTxSuccess(null)
  }, [poolAddress])

  const stakingMeta = useTokenMetadata(
    state.status === "ready"
      ? state.pool.stakingMint.toBase58()
      : "",
  )

  const rewardMeta = useTokenMetadata(
    state.status === "ready"
      ? state.pool.rewardMint.toBase58()
      : "",
  )

  /*
   * Real wallet NFTs, filtered by THIS pool's on-chain collection.
   *
   * The hook receives the connected wallet and the pool account that was just
   * loaded from the staking program, then reads the wallet's token accounts
   * plus their Metaplex metadata and keeps only NFTs whose VERIFIED collection
   * matches `pool.nftCollection`. It is read-only: no transactions are built,
   * no boost is computed, and nothing is mocked.
   */
  const nftState = useWalletNfts({
    wallet: { publicKey },
    pool: state.status === "ready" ? state.pool : null,
  })

  const stakingSymbol =
    stakingMeta.metadata?.symbol ||
    (state.status === "ready"
      ? shortenAddress(state.pool.stakingMint.toBase58())
      : "")

  const rewardSymbol =
    rewardMeta.metadata?.symbol ||
    (state.status === "ready"
      ? shortenAddress(state.pool.rewardMint.toBase58())
      : "")

  useEffect(() => {
    let cancelled = false

    if (!poolKey) {
      setState({
        status: "error",
        message: `"${poolAddress}" is not a valid Solana address.`,
      })
      return
    }

    setState({ status: "loading" })

    void (async () => {
      try {
        const pool = await fetchPool(
          readOnlyProgram,
          poolKey,
        )

        if (!cancelled) {
          setState({
            status: "ready",
            pool,
          })
        }
      } catch (e) {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              e instanceof Error
                ? e.message
                : "Could not load this pool from the program.",
          })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    poolKey,
    poolAddress,
    readOnlyProgram,
    refreshTick,
  ])

  useEffect(() => {
    let cancelled = false

    if (
      !poolKey ||
      !publicKey ||
      state.status !== "ready"
    ) {
      setPosition(null)
      setPositionError(null)
      return
    }

    void (async () => {
      try {
        // Resolves to `null` ONLY when the position account genuinely does
        // not exist. A rejected read (RPC failure / 429) lands in `catch`
        // below and is surfaced as an error instead of a fake zero balance.
        const pos = await fetchUserPosition(
          readOnlyProgram,
          poolKey,
          publicKey,
        )

        if (!cancelled) {
          setPosition(pos)
          setPositionError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setPosition(null)
          setPositionError(
            error instanceof Error
              ? error.message
              : "Could not read your position from the chain.",
          )
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    poolKey,
    publicKey,
    state.status,
    readOnlyProgram,
    refreshTick,
  ])

  const refresh = useCallback(
    () => setRefreshTick((t) => t + 1),
    [],
  )

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Apply the white-label brand theme for THIS pool (the one in the URL),
          not the console's selected pool. */}
      <BrandTheme poolAddress={poolKey ? poolKey.toBase58() : undefined} />
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3 md:px-6">
          <div className="flex items-center gap-2.5">
            <div
              className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg"
              style={{ backgroundColor: brand.color }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={brand.logoDataUrl ?? "/apple-icon.png"}
                alt={`${brand.title} logo`}
                className="size-full object-cover"
              />
            </div>

            <div className="leading-tight">
              <div className="font-mono text-sm font-semibold tracking-tight">
                {brand.title}
              </div>
              <div className="text-xs text-muted-foreground">
                Staking Portal
              </div>
            </div>
          </div>

          <div className="ml-auto hidden sm:block">
            <NetworkBadge />
          </div>

          <WalletButton />
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 md:px-6 md:py-8">
        <Link
          href="/pools"
          className="mb-4 inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft
            className="size-3.5"
            aria-hidden
          />
          Back to pools
        </Link>

        {state.status === "loading" && (
          <LoadingCard />
        )}

        {state.status === "error" && (
          <Card className="flex flex-col items-center gap-3 p-10 text-center">
            <ShieldAlert
              className="size-8 text-destructive"
              aria-hidden
            />

            <h1 className="text-lg font-semibold">
              Pool not found
            </h1>

            <p className="max-w-md text-sm text-muted-foreground">
              {state.message}
            </p>

            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
              {poolAddress}
            </code>
          </Card>
        )}

        {state.status === "ready" && (
          <PoolBody
            poolAddress={poolAddress}
            pool={state.pool}
            stakingSymbol={stakingSymbol}
            rewardSymbol={rewardSymbol}
            stakingImage={stakingMeta.metadata?.image}
            rewardImage={rewardMeta.metadata?.image}
            position={position}
            positionError={positionError}
            connected={connected}
            publicKey={publicKey}
            canTransact={canTransact}
            program={program}
            connection={connection}
            onRefresh={refresh}
            nftState={nftState}
            txSuccess={txSuccess}
            setTxSuccess={setTxSuccess}
          />
        )}
      </main>
    </div>
  )
}

function LoadingCard() {
  return (
    <Card className="flex flex-col items-center gap-3 p-12 text-center">
      <Loader2
        className="size-6 animate-spin text-muted-foreground"
        aria-hidden
      />

      <p className="text-sm text-muted-foreground">
        Loading pool from Solana…
      </p>
    </Card>
  )
}

function TokenLogo({
  image,
  symbol,
  size,
}: {
  image?: string
  symbol: string
  size: 6 | 8
}) {
  const dim = size === 8 ? "size-9" : "size-7"
  const [failed, setFailed] = useState(false)

  if (!image || failed) {
    return (
      <span
        aria-hidden
        className={`flex ${dim} shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold uppercase text-primary`}
      >
        {(symbol || "?").slice(0, 2)}
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image}
      alt={`${symbol} logo`}
      onError={() => setFailed(true)}
      className={`${dim} shrink-0 rounded-full border border-border bg-muted object-cover`}
    />
  )
}

function PairToken({
  label,
  symbol,
  image,
  mint,
}: {
  label: string
  symbol: string
  image?: string
  mint: PublicKey
}) {
  return (
    <div className="flex items-center gap-3">
      <TokenLogo
        image={image}
        symbol={symbol}
        size={8}
      />

      <div className="leading-tight">
        <div className="text-xs text-muted-foreground">
          {label}
        </div>

        <div className="text-sm font-semibold">
          {symbol || shortenAddress(mint.toBase58())}
        </div>

        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">{shortenAddress(mint.toBase58(), 5)}</span>
          <CopyAddress value={mint.toBase58()} label={`${label.toLowerCase()} address`} />
        </div>
      </div>
    </div>
  )
}

function MiniStat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div className="bg-card p-3">
      <div className="text-xs text-muted-foreground">
        {label}
      </div>

      <div
        className={`mt-1 truncate font-mono text-sm font-semibold tabular-nums ${
          accent ? "text-primary" : ""
        }`}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * NFT boost panel.
 *
 * Renders the pool's on-chain boost configuration (only when the pool is
 * actually configured for NFT boost) together with the real, wallet-owned
 * NFTs returned by `useWalletNfts`. Nothing here is mocked and nothing is
 * calculated: the boost shown is the pool's own `nftBoostBps`.
 */
function NftBoostPanel({
  enabled,
  boostPercent,
  collection,
  nftState,
  selectedMint,
  onSelect,
  onRetry,
}: {
  /** True when this pool has an NFT boost collection configured on-chain. */
  enabled: boolean
  /** Pool `nftBoostBps` expressed as a percentage (basis points / 100). */
  boostPercent: number
  /** The pool's on-chain collection key (`pool.nftCollection`). */
  collection: PublicKey
  /** Real wallet NFTs for this collection, from `useWalletNfts`. */
  nftState: WalletNftsState
  selectedMint: string | null
  onSelect: (mint: string) => void
  onRetry: () => void
}) {
  const selectedNft =
    nftState.nfts.find(
      (nft) => nft.mint.toBase58() === selectedMint,
    ) ?? null

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles
              className="size-5"
              aria-hidden
            />
          </div>

          <div className="leading-tight">
            <h2 className="text-sm font-semibold">
              NFT Staking Boost
            </h2>

            <div className="text-xs text-muted-foreground">
              {enabled
                ? "Eligible NFTs raise your staking rewards."
                : "This pool does not use an NFT boost collection."}
            </div>
          </div>
        </div>

        {/* The pool's authoritative on-chain boost, shown only when the
            pool is configured for NFT boost. */}
        {enabled && (
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 font-mono text-xs font-semibold text-primary">
            +{boostPercent}% boost
          </span>
        )}
      </div>

      {/* The configured collection, straight from pool.nftCollection. */}
      {enabled && (
        <p className="mt-3 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">
            Collection {shortenAddress(collection.toBase58(), 5)}
          </span>

          <CopyAddress
            value={collection.toBase58()}
            label="NFT collection address"
          />
        </p>
      )}

      {/* Boost disabled on-chain: no NFT options are offered, and the
          staking flow above keeps working exactly as before. */}
      {!enabled && (
        <p className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          NFT boosts are switched off for this pool, so no eligible
          NFTs are scanned. Normal staking stays available.
        </p>
      )}

      {enabled && nftState.status === "disconnected" && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Wallet
            className="size-4 shrink-0"
            aria-hidden
          />
          Connect your wallet to check it for eligible NFTs.
        </div>
      )}

      {enabled && nftState.status === "loading" && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Loader2
            className="size-4 shrink-0 animate-spin"
            aria-hidden
          />
          Scanning your wallet for NFTs in this collection…
        </div>
      )}

      {enabled && nftState.status === "error" && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <div className="flex items-start gap-2">
            <ShieldAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden
            />

            <div className="min-w-0">
              <p className="break-words">
                Could not read your wallet NFTs.{" "}
                {nftState.error ?? "The RPC request failed."}
              </p>

              <button
                type="button"
                onClick={onRetry}
                className="mt-2 font-semibold underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {enabled &&
        nftState.status === "ready" &&
        nftState.nfts.length === 0 && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <ImageOff
              className="size-4 shrink-0"
              aria-hidden
            />
            No eligible NFTs found in this wallet for this collection.
          </div>
        )}

      {enabled &&
        nftState.status === "ready" &&
        nftState.nfts.length > 0 && (
          <div className="mt-4">
            <div className="mb-3 text-xs text-muted-foreground">
              {nftState.nfts.length} eligible NFT
              {nftState.nfts.length === 1 ? "" : "s"} in this wallet.
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {nftState.nfts.map((nft) => (
                <NftTile
                  key={nft.mint.toBase58()}
                  nft={nft}
                  selected={selectedMint === nft.mint.toBase58()}
                  onSelect={() => onSelect(nft.mint.toBase58())}
                />
              ))}
            </div>

            {selectedNft && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs text-primary">
                <Check
                  className="size-4 shrink-0"
                  aria-hidden
                />

                <span className="min-w-0 truncate">
                  Selected{" "}
                  {selectedNft.name ||
                    shortenAddress(
                      selectedNft.mint.toBase58(),
                      4,
                    )}
                </span>
              </div>
            )}

            <p className="mt-3 text-xs text-muted-foreground">
              Only the token account and metadata of the selected NFT are sent,
              and only for verification. The boost is recorded on your position
              when you stake (snapshotted) — your NFT stays in your wallet and
              can be moved afterwards without changing that recorded boost.
            </p>
          </div>
        )}


    </Card>
  )
}

/**
 * One wallet-owned NFT whose verified Metaplex collection matches this pool.
 * Every displayed value (name, image, mint, token account, metadata account)
 * comes from `useWalletNfts` — nothing is mocked or hardcoded.
 */
function NftTile({
  nft,
  selected,
  onSelect,
}: {
  nft: WalletNft
  selected: boolean
  onSelect: () => void
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const mint = nft.mint.toBase58()

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-lg border transition-colors ${
        selected
          ? "border-primary ring-2 ring-primary/40"
          : "border-border"
      }`}
    >
      {/* Selection target. Kept as the only interactive element in the tile so
          the copy controls below stay outside it (no nested buttons). */}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="block w-full text-left"
      >
        <div className="relative aspect-square w-full bg-muted">
          {nft.image && !imageFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={nft.image}
              alt={nft.name || "Eligible NFT"}
              onError={() => setImageFailed(true)}
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-muted-foreground">
              <ImageOff
                className="size-6"
                aria-hidden
              />
            </span>
          )}

          {selected && (
            <span className="absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check
                className="size-3"
                aria-hidden
              />
            </span>
          )}
        </div>

        <div className="truncate px-2.5 py-2 text-xs font-medium">
          {nft.name || shortenAddress(mint, 5)}
        </div>
      </button>

      <div className="flex flex-col gap-1.5 border-t border-border px-2.5 py-2 font-mono text-[10px] text-muted-foreground">
        <NftRef
          label="Mint"
          value={mint}
        />
        <NftRef
          label="Token"
          value={nft.tokenAccount.toBase58()}
        />
        <NftRef
          label="Meta"
          value={nft.metadata.toBase58()}
        />
      </div>
    </div>
  )
}

/** Short, copyable on-chain reference for one NFT field. */
function NftRef({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate">
        {shortenAddress(value, 4)}
      </span>
      <CopyAddress
        value={value}
        label={`NFT ${label.toLowerCase()} address`}
      />
    </span>
  )
}

function PoolBody({
  poolAddress,
  pool,
  stakingSymbol,
  rewardSymbol,
  stakingImage,
  rewardImage,
  position,
  positionError,
  connected,
  publicKey,
  canTransact,
  program,
  connection,
  onRefresh,
  nftState,
  txSuccess,
  setTxSuccess,
}: {
  poolAddress: string
  pool: PoolAccount
  stakingSymbol: string
  rewardSymbol: string
  stakingImage?: string
  rewardImage?: string
  position: UserPositionAccount | null
  /** Position READ error (RPC failure); null when the read succeeded. */
  positionError: string | null
  connected: boolean
  publicKey: PublicKey | null
  canTransact: boolean
  program: Program
  connection: Conn
  onRefresh: () => void
  /** Real wallet NFTs for this pool's collection (from `useWalletNfts`). */
  nftState: WalletNftsState
  /**
   * Confirmed-transaction banner. Owned by PoolStakingClient (passed in
   * as props) so it survives PoolBody's unmount during the post-transaction
   * refresh — a local copy would be wiped by that remount.
   */
  txSuccess: TxSuccess | null
  setTxSuccess: (value: TxSuccess | null) => void
}) {
  const status: "Active" | "Paused" | "Frozen" =
    pool.frozen
      ? "Frozen"
      : pool.paused
        ? "Paused"
        : "Active"

  /*
   * NFT boost configuration, read straight off the pool account:
   *
   * - `nftCollection` decides whether this pool has NFT boost at all. The
   *   program stores "unset" as the all-zeros key (System Program address).
   * - `nftBoostBps` is the authoritative boost, stored in basis points. It is
   *   only DISPLAYED (converted from bps to a percentage for readability) and
   *   only when the pool is configured for NFT boost — the frontend never
   *   derives a boost from the NFT itself.
   */
  const nftBoostEnabled = !pool.nftCollection.equals(PublicKey.default)
  const nftBoostPercent = pool.nftBoostBps / 100

  // White-label branding saved by the founder on /white-label (localStorage).
  // POOL-SCOPED: read for the pool this staking page is showing.
  const brand = useWhiteLabelConfig(poolAddress)

  const [stakingDecimals, setStakingDecimals] =
    useState(9)

  const [rewardDecimals, setRewardDecimals] =
    useState(9)

  const [amount, setAmount] = useState("")

  /*
   * The amount input is cleared ONLY after the staking transaction has been
   * confirmed on-chain (the success path below), never optimistically on click
   * and never while the wallet is signing.
   *
   * The nonce is used as the input's React key: re-mounting the field is what
   * guarantees the visible value resets to the "0.00" placeholder even for a
   * native number input that still holds the previously typed amount.
   */
  const [amountResetNonce, setAmountResetNonce] =
    useState(0)

  const clearStakeAmount = useCallback(() => {
    setAmount("")
    setAmountResetNonce((nonce) => nonce + 1)
  }, [])

  /**
   * Wallet's staking-token balance in EXACT base units (read from the chain).
   * `null` = not loaded yet / read failed. Kept as bigint so the MAX button
   * and the stake amount conversion never go through float rounding.
   */
  const [walletBalanceBase, setWalletBalanceBase] =
    useState<bigint | null>(null)

  /**
   * Set ONLY when the balance READ failed (RPC error / HTTP 429), so a read
   * failure can never render as a fake zero balance. A genuinely empty ATA
   * is a real 0n with no error.
   */
  const [walletBalanceError, setWalletBalanceError] =
    useState<string | null>(null)

  const walletBalance =
    walletBalanceBase === null
      ? 0
      : baseUnitsToTokens(walletBalanceBase, stakingDecimals)

  const [pendingTx, setPendingTx] = useState<
    "stake" | "unstake" | "claim" | null
  >(null)

  const [txError, setTxError] =
    useState<string | null>(null)

  // Which eligible NFT the user picked from the live wallet scan.
  //
  // Only two accounts of the selected NFT are handed to the program for
  // VERIFICATION: its token account (`selectedNft.tokenAccount`) and its
  // Metaplex metadata account (`selectedNft.metadata`). The program checks that
  // the token account is owned by the signer and holds >= 1 unit and that the
  // metadata's VERIFIED collection equals `pool.nftCollection`.
  //
  // The NFT itself is NEVER transferred to the program - it stays in the wallet
  // and may be transferred afterwards - and the pool's configured boost is
  // recorded (snapshotted) on the position as `nftBoostBps` when the position is
  // created, which is the value rewards are later computed from.
  const [selectedNftMint, setSelectedNftMint] =
    useState<string | null>(null)

  const [now, setNow] = useState(() =>
    Math.floor(Date.now() / 1000),
  )

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [s, r] = await Promise.all([
          getMintDecimals(connection, pool.stakingMint),
          getMintDecimals(connection, pool.rewardMint),
        ])

        if (!cancelled) {
          setStakingDecimals(s ?? 9)
          setRewardDecimals(r ?? 9)
        }
      } catch {
        // Keep defaults if the RPC request fails.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    connection,
    pool.stakingMint,
    pool.rewardMint,
  ])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000))
    }, 1000)

    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false

    if (!publicKey) {
      setWalletBalanceBase(BigInt(0))
      setWalletBalanceError(null)
      return
    }

    void (async () => {
      try {
        // The pool's staking mint may be a classic SPL Token or a Token-2022
        // mint: the program that owns it is detected from the mint account, and
        // BOTH the wallet's ATA address (seeds include the token program) and
        // the account read use it. Legacy mints keep working unchanged.
        const tokenProgramId = await resolveMintTokenProgram(
          connection,
          pool.stakingMint,
        )

        const ata =
          getAssociatedTokenAddressSync(
            pool.stakingMint,
            publicKey,
            false,
            tokenProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          )

        const account = await getAccount(
          connection,
          ata,
          "confirmed",
          tokenProgramId,
        )

        if (!cancelled) {
          setWalletBalanceBase(BigInt(account.amount.toString()))
          setWalletBalanceError(null)
        }
      } catch (error) {
        if (cancelled) return

        if (error instanceof TokenAccountNotFoundError) {
          // The ATA genuinely does not exist yet: a real zero balance.
          setWalletBalanceBase(BigInt(0))
          setWalletBalanceError(null)
        } else {
          // RPC / read failure: keep the previous value (if any) and surface
          // the error instead of fabricating a zero balance.
          setWalletBalanceError(
            error instanceof Error
              ? error.message
              : "Could not read your token balance.",
          )
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    connection,
    publicKey,
    pool.stakingMint,
    stakingDecimals,
    onRefresh,
  ])

  // Forget a selection the latest wallet scan no longer returns (wallet
  // switched, NFT transferred away, or the pool's collection changed).
  useEffect(() => {
    if (!selectedNftMint) return

    const stillEligible = nftState.nfts.some(
      (nft) => nft.mint.toBase58() === selectedNftMint,
    )

    if (!stillEligible) setSelectedNftMint(null)
  }, [nftState.nfts, selectedNftMint])

  /*
   * The selected NFT resolved out of the LIVE `useWalletNfts` result.
   *
   * This is the only source for the accounts handed to the program: the token
   * account and the metadata PDA are the ones the wallet scan actually found,
   * so a stale or removed selection resolves to `null` instead of sending
   * addresses the wallet may no longer own.
   */
  const selectedNft = useMemo(() => {
    if (!selectedNftMint) return null

    return (
      nftState.nfts.find(
        (nft) => nft.mint.toBase58() === selectedNftMint,
      ) ?? null
    )
  }, [nftState.nfts, selectedNftMint])

  /*
   * The pool's on-chain boost makes an NFT mandatory (the program's optional
   * NFT accounts would otherwise land the user an unboosted position without
   * their knowledge). While the wallet scan is still running or failed, the
   * selection cannot be trusted yet, so staking stays blocked.
   */
  const nftBoostRequired =
    nftBoostEnabled &&
    (nftState.status === "loading" ||
      nftState.status === "error" ||
      selectedNft === null)

  const lockLabel = formatLockDurationSeconds(
    pool.lockDuration,
  )

  /*
   * LOCKUP — derived from the REAL on-chain position, never from the pool's
   * lock duration alone.
   *
   * The program's `unstake` handler requires `now >= user_position.locked_until`
   * and fails with `LockDurationNotMet` otherwise, so the program is the real
   * enforcement point. The UI must agree with it: mirroring the rule here means
   * a locked position shows an explicit "locked until" state and a disabled
   * Unstake button instead of letting the user sign a transaction that is
   * guaranteed to fail on-chain.
   *
   * `lockedUntil` is a unix timestamp in seconds written by `stake`
   * (now + pool.lock_duration, extended on every additional stake). A position
   * that does not exist yet, or whose lock has passed, is immediately unlocked.
   */
  const lockRemainingSeconds = position
    ? Math.max(0, Number(position.lockedUntil.toString()) - now)
    : 0

  const isPositionLocked = lockRemainingSeconds > 0

  /** Human countdown for the locked position, e.g. "2d 4h 13m". */
  const lockCountdown = useMemo(() => {
    if (!isPositionLocked) return null
    const d = Math.floor(lockRemainingSeconds / 86400)
    const h = Math.floor((lockRemainingSeconds % 86400) / 3600)
    const m = Math.floor((lockRemainingSeconds % 3600) / 60)
    const s = lockRemainingSeconds % 60
    if (d > 0) return `${d}d ${h}h ${m}m`
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }, [isPositionLocked, lockRemainingSeconds])

  const emission = formatRewardEmission(
    pool.rewardRatePerSecond,
    rewardDecimals,
    rewardSymbol,
  )

  const totalStakedHuman =
    baseUnitsToTokens(
      pool.totalStaked,
      stakingDecimals,
    ).toLocaleString(undefined, {
      maximumFractionDigits: 4,
    })

  /*
   * Estimated APY
   *
   * The staking program stores the reward emission
   * per second and total staked amount. APY is therefore
   * derived from those live on-chain values.
   *
   * If total staked is zero, APY is intentionally shown
   * as unavailable instead of displaying a fake percentage.
   */
  const estimatedApy = useMemo(() => {
    const totalStakedRaw = BigInt(
      pool.totalStaked.toString(),
    )

    const rewardRateRaw = BigInt(
      pool.rewardRatePerSecond.toString(),
    )

    if (
      totalStakedRaw <= BigInt(0) ||
      rewardRateRaw <= BigInt(0)
    ) {
      return null
    }

    const secondsPerYear =
      365 * 24 * 60 * 60

    const annualRewardTokens =
      Number(rewardRateRaw) /
      Math.pow(10, rewardDecimals) *
      secondsPerYear

    const totalStakedTokens =
      Number(totalStakedRaw) /
      Math.pow(10, stakingDecimals)

    if (
      !Number.isFinite(annualRewardTokens) ||
      !Number.isFinite(totalStakedTokens) ||
      totalStakedTokens <= 0
    ) {
      return null
    }

    const apy =
      (annualRewardTokens /
        totalStakedTokens) *
      100

    return Number.isFinite(apy)
      ? apy
      : null
  }, [
    pool.totalStaked,
    pool.rewardRatePerSecond,
    rewardDecimals,
    stakingDecimals,
  ])

  const updatedRpt = useMemo(
    () =>
      computeUpdatedRewardPerToken(
        pool,
        now,
      ),
    [pool, now],
  )

  const pendingRewardsRaw = position
    ? computePendingRewards(
        position,
        updatedRpt,
      )
    : BigInt(0)

  const pendingRewards = baseUnitsToTokens(
    pendingRewardsRaw,
    rewardDecimals,
  )

  const stakedAmount = position
    ? baseUnitsToTokens(
        position.amount,
        stakingDecimals,
      )
    : 0

  const numericAmount =
    Number(amount) || 0

  /**
   * Exact base-unit conversion of the typed amount (string math, never
   * float). null = the input is not a valid positive amount, or the balance
   * has not been read yet.
   */
  const stakeAmountBase = parseAmountToBaseUnits(amount, stakingDecimals)

  const canStake =
    connected &&
    canTransact &&
    status === "Active" &&
    stakeAmountBase !== null &&
    stakeAmountBase.gt(new BN(0)) &&
    walletBalanceBase !== null &&
    walletBalanceError === null &&
    // bn.js `lte` only accepts a BN: passing the raw `bigint` balance reads
    // `num.negative` (undefined) and returns false for EVERY amount, which
    // permanently disables Stake. Convert the balance to a BN for the compare.
    stakeAmountBase.lte(new BN(walletBalanceBase.toString())) &&
    !pendingTx &&
    !nftBoostRequired

  // TEMPORARY development diagnostic (dev only, no functional change).
  // Emitted immediately after the canStake calculation and prints EVERY input
  // the computation reads, so a disabled Stake button can be traced to the
  // exact term that turned `canStake` false.
  if (process.env.NODE_ENV !== "production") {
    console.log("[stake-debug] CAN_STAKE_INPUTS", {
      connected,
      canTransact,
      status,
      stakeAmountBase: stakeAmountBase?.toString() ?? null,
      walletBalanceBase: walletBalanceBase?.toString() ?? null,
      walletBalanceError,
      pendingTx,
      nftBoostRequired,
      canStake,
    })
  }

  /*
   * Unstake requires an existing position with a non-zero amount. It is also
   * blocked while the on-chain lockup is still running, mirroring the program's
   * `now >= locked_until` requirement so the button never offers a transaction
   * that would revert with `LockDurationNotMet`.
   */
  const canUnstake =
    connected &&
    canTransact &&
    !!position &&
    stakedAmount > 0 &&
    !isPositionLocked &&
    !pendingTx

  const canClaim =
    connected &&
    canTransact &&
    pendingRewards > 0 &&
    !pendingTx

  const handleStake = async () => {
    // TEMPORARY development diagnostic (dev only, no functional change).
    // FIRST line of the Stake button handler, emitted BEFORE the guard clauses
    // so a real click is visible even when a guard blocks the stake.
    if (process.env.NODE_ENV !== "production") {
      console.log("[stake-debug] BUTTON_HANDLER_REACHED", {
        poolAddress,
        user: publicKey?.toBase58() ?? null,
        canStake,
        hasProgram: !!program,
        pendingTx,
      })
    }

    if (
      !publicKey ||
      !pool ||
      !poolAddress ||
      !canStake
    ) {
      return
    }
if (!program) {
    setTxError("Staking program is not ready. Please reconnect your wallet and try again.")
    return
  }

    // This pool stores an NFT boost on-chain, so the boosted stake must carry
    // the user's real NFT accounts. Never fall back to a silent unboosted
    // stake when the user is expecting the boost.
    if (nftBoostEnabled && selectedNft === null) {
      setTxError(
        nftState.nfts.length > 0
          ? "Select one of your eligible NFTs to stake with the boost."
          : "This pool requires one of your NFTs from its boost collection. " +
            "Connect a wallet holding an eligible NFT, or stake on a pool without an NFT boost.",
      )

      return
    }

    if (nftBoostEnabled && nftState.status !== "ready") {
      setTxError(
        "Your eligible NFTs are still loading. Try again in a moment.",
      )

      return
    }

    setTxError(null)
    setTxSuccess(null)
    setPendingTx("stake")

    try {
      // Exact base-unit conversion of the typed decimal string. canStake
      // already guarantees a valid, in-balance amount; re-parse here so the
      // value sent on-chain is the string the user actually typed (never a
      // float-rounded approximation).
      const baseUnits = parseAmountToBaseUnits(amount, stakingDecimals)
      if (!baseUnits || baseUnits.lte(new BN(0))) {
        setTxError("Enter a valid amount to stake.")
        return
      }

      // TEMPORARY development diagnostic (dev only, no functional change):
      // immediately before calling the staking client's stake() function.
      if (process.env.NODE_ENV !== "production") {
        console.log("[stake-debug] CALLING_STAKE_CLIENT", {
          poolAddress,
          user: publicKey.toBase58(),
          amountBaseUnits: baseUnits.toString(),
          programMode: canTransact ? "wallet" : "read-only",
          withNft: nftBoostEnabled && !!selectedNft,
        })
      }

      const signature = await stakeOnChain(program, {
        poolAddress: new PublicKey(poolAddress),
        pool,
        user: publicKey,
        amount: baseUnits,
        // Real accounts from the wallet scan (`useWalletNfts`) for the NFT the
        // user picked: token account + Metaplex metadata PDA. The program
        // verifies them and applies the boost stored in the pool itself.
        // null when the pool has no NFT boost (normal path).
        nft:
          nftBoostEnabled && selectedNft
            ? {
                tokenAccount: selectedNft.tokenAccount,
                metadata: selectedNft.metadata,
              }
            : null,
      })

      // Confirmed on-chain: send the amount field back to 0.00.
      clearStakeAmount()
      setTxSuccess({
        message:
          nftBoostEnabled && selectedNft
            ? `Successfully staked ${numericAmount} ${stakingSymbol} with your NFT boost applied.`
            : `Successfully staked ${numericAmount} ${stakingSymbol}.`,
        signature,
      })

      onRefresh()
    } catch (error) {
      // TEMPORARY development diagnostic (dev only, no functional change).
      // The handler already has error handling (setTxError below): this only
      // makes the failure visible in the trace. The error is NOT swallowed,
      // re-wrapped or replaced - the existing reporting path is untouched.
      if (process.env.NODE_ENV !== "production") {
        console.error("[stake-debug] ERROR", error)
      }

      setTxError(
        getUserFacingTxError(error),
      )
    } finally {
      setPendingTx(null)
    }
  }

  const handleUnstake = async () => {
    if (
      !publicKey ||
      !position ||
      !canUnstake
    ) {
      return
    }
if (!program) {
    setTxError("Staking program is not ready. Please reconnect your wallet and try again.")
    return
  }
    setTxError(null)
    setTxSuccess(null)
    setPendingTx("unstake")

    // Unstake confirmation text (display only): the transaction returns just
    // the staked staking tokens. For a position that actually used an NFT,
    // state clearly that the NFT was eligibility/boost proof only — it is
    // never transferred or unstaked and stays in the wallet — and that its
    // boost stops applying to this position.
    //
    // Source of truth is the boost the program recorded on THIS position
    // (`UserPosition.nft_boost_bps`, e.g. 2500 = 25%). The generated account
    // type predates that field, so read it defensively: absent or 0 means no
    // NFT was used and the NFT-specific message is omitted entirely.
    const positionBoostPercent =
      ((position as UserPositionAccount & { nftBoostBps?: number })
        .nftBoostBps ?? 0) / 100

    // The exact amount this unstake returns, formatted like the position card.
    const unstakedAmountText = `${stakedAmount.toLocaleString(undefined, {
      maximumFractionDigits: 6,
    })} ${stakingSymbol}`

    try {
      const signature = await unstakeOnChain(program, {
        poolAddress: new PublicKey(poolAddress),
        pool,
        user: publicKey,
        amount: new BN(
          position.amount.toString(),
        ),
      })

      setTxSuccess({
        message:
          positionBoostPercent > 0
            ? `Unstaked ${unstakedAmountText}. Your ${positionBoostPercent}% NFT boost will no longer apply to this position. Your NFT remains in your wallet.`
            : `Unstaked ${unstakedAmountText}.`,
        signature,
      })

      onRefresh()
    } catch (error) {
      setTxError(
        getUserFacingTxError(error),
      )
    } finally {
      setPendingTx(null)
    }
  }

  const handleClaim = async () => {
    if (
      !publicKey ||
      !canClaim
    ) {
      return
    }
if (!program) {
    setTxError("Staking program is not ready. Please reconnect your wallet and try again.")
    return
  }
    setTxError(null)
    setTxSuccess(null)
    setPendingTx("claim")

    try {
      const signature = await claimRewards(program, {
        poolAddress: new PublicKey(poolAddress),
        pool,
        user: publicKey,
      })

      setTxSuccess({
        message: `Successfully claimed ${pendingRewards.toLocaleString(
          undefined,
          { maximumFractionDigits: 6 },
        )} ${rewardSymbol}.`,
        signature,
      })

      onRefresh()
    } catch (error) {
      setTxError(
        getUserFacingTxError(error),
      )
    } finally {
      setPendingTx(null)
    }
  }

  const setMaxAmount = () => {
    // Exact base-unit -> decimal string (no float rounding), so MAX stakes
    // the true full balance even for balances beyond Number.MAX_SAFE_INTEGER.
    setAmount(
      walletBalanceBase !== null && walletBalanceBase > BigInt(0)
        ? baseUnitsToDecimalString(walletBalanceBase, stakingDecimals)
        : "",
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* White-label brand (from /white-label; pure presentation, not mock data) */}
      <div className="flex items-center gap-2.5">
        {brand.logoDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brand.logoDataUrl}
            alt={`${brand.title} logo`}
            className="size-8 shrink-0 rounded-lg border border-border object-cover"
          />
        ) : (
          <div
            className="size-8 shrink-0 rounded-lg border border-border"
            style={{ backgroundColor: brand.color }}
            aria-hidden
          />
        )}
        <span className="truncate text-base font-semibold tracking-tight">{brand.title}</span>
      </div>

      {/* Pool header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TokenLogo
              image={stakingImage}
              symbol={stakingSymbol}
              size={6}
            />

            <h1 className="truncate text-2xl font-semibold tracking-tight">
              Stake {stakingSymbol || "tokens"} · Earn{" "}
              {rewardSymbol || "rewards"}
            </h1>
          </div>

          <p className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{shortenAddress(poolAddress, 6)}</span>
            <CopyAddress value={poolAddress} label="pool address" />
          </p>
        </div>

        <PoolStatusBadge status={status} />
      </div>

      {/* Live pool statistics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="flex flex-col gap-2 p-5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Calendar
              className="size-4 text-primary"
              aria-hidden
            />
            Lock-up Duration
          </div>

          <div className="font-mono text-xl font-semibold text-foreground">
            {lockLabel}
          </div>

          <div className="text-xs text-muted-foreground">
            Minimum time deposits stay locked.
          </div>
        </Card>

        <Card className="flex flex-col gap-2 p-5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Percent
              className="size-4 text-primary"
              aria-hidden
            />
            Reward Rate
          </div>

          <div className="font-mono text-xl font-semibold text-foreground">
            {emission}
          </div>

          <div className="text-xs text-muted-foreground">
            Total emission shared by all stakers.
          </div>
        </Card>

        <Card className="flex flex-col gap-2 p-5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Coins
              className="size-4 text-primary"
              aria-hidden
            />
            Total Staked
          </div>

          <div className="font-mono text-xl font-semibold text-foreground">
            {totalStakedHuman} {stakingSymbol}
          </div>

          <div className="text-xs text-muted-foreground">
            {stakingSymbol} currently locked.
          </div>
        </Card>

        {/* NEW APY CARD */}
        <Card className="flex flex-col gap-2 p-5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Percent
              className="size-4 text-primary"
              aria-hidden
            />
            Estimated APY
          </div>

          <div className="font-mono text-xl font-semibold text-primary">
            {estimatedApy === null
              ? "—"
              : `${estimatedApy.toFixed(2)}%`}
          </div>

          <div className="text-xs text-muted-foreground">
            {estimatedApy === null
              ? "Requires active stake"
              : "Based on current pool emission"}
          </div>
        </Card>
      </div>

      {/* Token pair */}
      <Card className="p-5">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <PairToken
            label="Staking token"
            symbol={stakingSymbol}
            image={stakingImage}
            mint={pool.stakingMint}
          />

          <PairToken
            label="Reward token"
            symbol={rewardSymbol}
            image={rewardImage}
            mint={pool.rewardMint}
          />
        </div>
      </Card>

      {/* NFT boost — the pool's on-chain collection decides whether the
          wallet's real NFTs are scanned and displayed. */}
      <NftBoostPanel
        enabled={nftBoostEnabled}
        boostPercent={nftBoostPercent}
        collection={pool.nftCollection}
        nftState={nftState}
        selectedMint={selectedNftMint}
        onSelect={(mint) =>
          setSelectedNftMint((current) =>
            current === mint ? null : mint,
          )
        }
        onRetry={onRefresh}
      />

      {/* Position / actions */}
      <Card className="overflow-hidden p-0">
        <div className="border-b border-border p-5">
          <div className="flex items-center gap-2">
            <Lock
              className="size-5 text-primary"
              aria-hidden
            />

            <h2 className="text-lg font-semibold">
              Your Position
            </h2>
          </div>
        </div>

        {/* Read-failure banner: an RPC error must never look like a zero
            balance. The retry re-runs the position read (refreshTick). */}
        {connected && positionError && (
          <div className="border-b border-border bg-destructive/10 p-4 text-xs text-destructive">
            Couldn&apos;t load your on-chain position ({positionError}). Staked
            and pending values are unavailable until the read succeeds.{" "}
            <button
              type="button"
              onClick={onRefresh}
              className="font-semibold underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <MiniStat
            label="Available"
            value={
              walletBalanceError !== null
                ? "Unavailable"
                : `${walletBalance.toLocaleString(
                    undefined,
                    { maximumFractionDigits: 6 },
                  )} ${stakingSymbol}`
            }
          />

          <MiniStat
            label={
              isPositionLocked
                ? "Staked (locked)"
                : "Staked"
            }
            value={
              positionError
                ? "—"
                : `${stakedAmount.toLocaleString(
                    undefined,
                    { maximumFractionDigits: 6 },
                  )} ${stakingSymbol}`
            }
          />

          <MiniStat
            label="Pending Rewards"
            value={
              positionError
                ? "—"
                // Small accruing amounts must not be truncated to "0": this
                // pool's emission can be a fraction of a base unit per second,
                // so the pending value is formatted with up to 8 fraction
                // digits below 1 token (same helper the dashboard uses).
                : `${formatTokenUnitAmount(pendingRewards)} ${rewardSymbol}`
            }
            accent
          />
        </div>

        {walletBalanceError !== null && (
          <p className="border-b border-border px-5 py-2 text-xs text-destructive">
            Couldn&apos;t read your token balance ({walletBalanceError}). Staking
            stays disabled until the read succeeds.
          </p>
        )}

        {/* Lockup notice: this position is still inside its on-chain lock window,
            so the program would reject an unstake with `LockDurationNotMet`.
            Unstake stays disabled until the countdown reaches zero. */}
        {connected && isPositionLocked && (
          <p className="border-b border-border bg-warning/10 px-5 py-2 text-xs text-warning">
            <Lock
              className="mr-1 inline size-3.5 align-text-bottom"
              aria-hidden
            />
            Your stake is locked for another{" "}
            <span className="font-mono font-semibold">{lockCountdown}</span>.
            Unstaking unlocks automatically when the timer ends — the program
            enforces this, so it cannot be withdrawn early.
          </p>
        )}

        <div className="p-5">
          <Label
            htmlFor="stake-amount"
            className="mb-2 block"
          >
            Amount to stake
          </Label>

          <div className="relative">
            <Input
              key={amountResetNonce}
              id="stake-amount"
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={(event) =>
                setAmount(event.target.value)
              }
              placeholder="0.00"
              disabled={
                !connected ||
                status !== "Active" ||
                !!pendingTx
              }
              className="pr-16 font-mono"
            />

            <button
              type="button"
              onClick={setMaxAmount}
              disabled={
                !connected ||
                walletBalanceBase === null ||
                walletBalanceBase <= BigInt(0) ||
                walletBalanceError !== null ||
                !!pendingTx
              }
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              MAX
            </button>
          </div>

          {!connected && (
            <p className="mt-2 text-xs text-muted-foreground">
              Connect your wallet to stake.
            </p>
          )}

          {connected &&
            status === "Paused" && (
              <p className="mt-2 text-xs text-yellow-500">
                This pool is paused. New deposits are temporarily disabled —
                you can still unstake and claim rewards.
              </p>
            )}

          {status === "Frozen" && (
            <p className="mt-2 text-xs text-destructive">
              This pool is frozen. New deposits are temporarily disabled
              pending administrator review — you can still unstake and claim
              rewards.
            </p>
          )}

          {/* NFT boost gating: an on-chain boost makes the NFT mandatory, so
              the Stake button stays disabled with an explicit reason instead of
              quietly submitting an unboosted stake. */}
          {connected &&
            status === "Active" &&
            nftBoostEnabled &&
            nftState.status === "loading" && (
              <p className="mt-2 text-xs text-muted-foreground">
                Checking your wallet for NFTs in this
                pool&rsquo;s boost collection…
              </p>
            )}

          {connected &&
            status === "Active" &&
            nftBoostEnabled &&
            nftState.status === "error" && (
              <p className="mt-2 text-xs text-yellow-500">
                Could not load your eligible NFTs (
                {nftState.error ?? "RPC error"}).{" "}
                <button
                  type="button"
                  onClick={onRefresh}
                  className="font-semibold underline underline-offset-2"
                >
                  Retry
                </button>
              </p>
            )}

          {connected &&
            status === "Active" &&
            nftBoostEnabled &&
            nftState.status === "ready" &&
            selectedNft === null && (
              <p className="mt-2 text-xs text-yellow-500">
                {nftState.nfts.length > 0
                  ? "Select one of your eligible NFTs above to stake with this pool\u2019s boost."
                  : "This pool\u2019s boost requires an NFT from its collection and your wallet holds none, so staking is blocked."}
              </p>
            )}

          {connected &&
            status === "Active" &&
            nftBoostEnabled &&
            selectedNft !== null && (
              <p className="mt-2 text-xs text-muted-foreground">
                Staking with NFT{" "}
                <span className="font-mono">
                  {shortenAddress(selectedNft.mint.toBase58())}
                </span>
                . The program verifies it at stake time, records this
                pool&rsquo;s +{nftBoostPercent}% boost on your position, and
                leaves the NFT in your wallet.
              </p>
            )}

          {txError && (
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {txError}
            </div>
          )}

          {txSuccess && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
              <Check
                className="mt-0.5 size-4 shrink-0"
                aria-hidden
              />
              <div className="min-w-0">
                <div>{txSuccess.message}</div>
                <div className="mt-1 truncate font-mono">
                  <a
                    href={explorerTxUrl(txSuccess.signature)}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                  >
                    {txSuccess.signature}
                  </a>
                </div>
              </div>
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Button
              onClick={handleStake}
              disabled={!canStake}
              className="w-full"
            >
              {pendingTx === "stake" ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Staking…
                </>
              ) : (
                <>
                  <Coins
                    className="mr-2 size-4"
                    aria-hidden
                  />
                  Stake
                </>
              )}
            </Button>

            <Button
              variant="outline"
              onClick={handleUnstake}
              disabled={!canUnstake}
              className="w-full"
            >
              {pendingTx === "unstake" ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Unstaking…
                </>
              ) : (
                <>
                  <Lock
                    className="mr-2 size-4"
                    aria-hidden
                  />
                  Unstake
                </>
              )}
            </Button>

            <Button
              variant="outline"
              onClick={handleClaim}
              disabled={!canClaim}
              className="w-full"
            >
              {pendingTx === "claim" ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Claiming…
                </>
              ) : (
                <>
                  <Gift
                    className="mr-2 size-4"
                    aria-hidden
                  />
                  Claim
                </>
              )}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}