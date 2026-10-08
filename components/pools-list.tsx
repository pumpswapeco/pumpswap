"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { PublicKey } from "@solana/web3.js"
import type { BN } from "@coral-xyz/anchor"
import { X, Copy, Check, Coins, Percent, Calendar, CirclePlus, Loader2, Layers, Link2, ExternalLink, ShieldCheck } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { PoolStatusBadge } from "@/components/pool-status"
import { usePoolOptional } from "@/lib/pool-context"
import { usePoolStats } from "@/lib/solana/use-pool-stats"
import { shortenAddress } from "@/lib/solana/format"
import { baseUnitsToTokens, formatLockDurationSeconds, formatRewardEmission, stakingUrlForPool } from "@/lib/solana/display"
import { CopyAddress } from "@/components/ui/copy-address"

type Status = "Active" | "Paused" | "Frozen"

/** One on-chain Pool account plus its resolved mint metadata. */
interface PoolRow {
  address: string
  authority: string
  poolId: string
  stakingMint: PublicKey
  rewardMint: PublicKey
  stakingSymbol: string
  rewardSymbol: string
  stakingImage?: string
  rewardImage?: string
  stakingDecimals: number
  rewardDecimals: number
  totalStaked: BN
  lockDuration: BN
  rewardRatePerSecond: BN
  status: Status
}

/** Compact human label for a lock duration in seconds (0 = Flexible). */
function formatLockDuration(seconds: BN): string {
  return formatLockDurationSeconds(seconds)
}

/** Human reward emission string for a row, using the reward mint decimals. */
function emissionLabel(p: PoolRow): string {
  return formatRewardEmission(p.rewardRatePerSecond, p.rewardDecimals, p.rewardSymbol)
}

/** Human total-staked amount using the staking mint decimals. */
function poolDisplayName(p: PoolRow): string {
  return `${p.stakingSymbol} Staking`
}
function totalStakedLabel(p: PoolRow): string {
  return baseUnitsToTokens(p.totalStaked, p.stakingDecimals).toLocaleString(undefined, { maximumFractionDigits: 4 })
}

/** Token logo with a graceful fallback to the symbol's initial letter. */
function TokenBadge({ image, symbol, size = 5 }: { image?: string; symbol: string; size?: 4 | 5 | 6 }) {
  const [failed, setFailed] = useState(false)
  const dim = size === 6 ? "size-6" : size === 4 ? "size-4" : "size-5"
  if (!image || failed) {
    return (
      <span
        aria-hidden
        className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-full bg-muted font-medium uppercase text-muted-foreground text-[10px]`}
      >
        {symbol.slice(0, 1)}
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

/** Compact "TOKEN → TOKEN" pair with logos. */
function TokenPair({
  stakingSymbol,
  rewardSymbol,
  stakingImage,
  rewardImage,
  size = 5,
}: {
  stakingSymbol: string
  rewardSymbol: string
  stakingImage?: string
  rewardImage?: string
  size?: 4 | 5 | 6
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TokenBadge image={stakingImage} symbol={stakingSymbol} size={size} />
      <span>{stakingSymbol}</span>
      <span className="text-muted-foreground">→</span>
      <TokenBadge image={rewardImage} symbol={rewardSymbol} size={size} />
      <span>{rewardSymbol}</span>
    </span>
  )
}

export function PoolsList() {
  // Rows come from the shared usePoolStats store (the same on-chain pools the
  // dashboard/analytics/rewards/admin read). This deliberately reuses the
  // module-wide cache instead of issuing an independent program.account.pool.all()
  // + metadata fetch on every /pools visit (a duplicate-RPC / 429 source).
  const stats = usePoolStats()
  const { selectPool } = usePoolOptional() ?? {}
  const [selected, setSelected] = useState<PoolRow | null>(null)

  /** Selecting a row makes it the app's active pool (never the env default). */
  const handleSelect = (p: PoolRow) => {
    selectPool?.(new PublicKey(p.address))
    setSelected(p)
  }

  const rows: PoolRow[] = stats.pools.map((p) => ({
    address: p.address,
    authority: p.authority,
    poolId: p.poolId,
    stakingMint: p.stakingMint,
    rewardMint: p.rewardMint,
    stakingSymbol: p.stakingSymbol,
    rewardSymbol: p.rewardSymbol,
    stakingImage: p.stakingImage,
    rewardImage: p.rewardImage,
    stakingDecimals: p.stakingDecimals,
    rewardDecimals: p.rewardDecimals,
    totalStaked: p.totalStaked,
    lockDuration: p.lockDuration,
    rewardRatePerSecond: p.rewardRatePerSecond,
    status: p.status,
  }))

  return (
    <>
      <ListHeader count={rows.length} loading={stats.loading} />
      {stats.loading ? (
        <LoadingState />
      ) : stats.error ? (
        <ErrorState message={stats.error} />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <PoolTables rows={rows} onSelect={handleSelect} />
      )}
      {selected && <PoolDetail pool={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

/** Deployed-pool counter + create button (previously lived in the page). */
function ListHeader({ count, loading }: { count: number; loading: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-muted-foreground">
        {loading ? "Loading pools…" : `${count} deployed pool${count === 1 ? "" : "s"}`}
      </p>
      <Link href="/create-pool">
        <Button className="gap-1.5">
          <CirclePlus className="size-4" /> Create Pool
        </Button>
      </Link>
    </div>
  )
}

function LoadingState() {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 p-12 text-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Fetching on-chain pools…</p>
    </Card>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <Card className="flex flex-col items-center justify-center gap-2 p-12 text-center">
      <p className="text-sm font-medium text-destructive">Couldn&apos;t load on-chain pools</p>
      <p className="text-xs text-muted-foreground">{message}</p>
    </Card>
  )
}

function EmptyState() {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 p-12 text-center">
      <Layers className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">No on-chain pools yet.</p>
      <Link href="/create-pool">
        <Button className="gap-1.5">
          <CirclePlus className="size-4" /> Create your first pool
        </Button>
      </Link>
    </Card>
  )
}

function PoolTables({ rows, onSelect }: { rows: PoolRow[]; onSelect: (p: PoolRow) => void }) {
  return (
    <>
      {/* Desktop table */}
      <Card className="hidden overflow-hidden p-0 lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 font-medium">Pool</th>
              <th className="px-4 py-3 font-medium">Tokens</th>
              <th className="px-4 py-3 font-medium">Total Staked</th>
              <th className="px-4 py-3 font-medium">Lock</th>
              <th className="px-4 py-3 font-medium">Reward / sec</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Pool ID</th>
            </tr>
          </thead>
          <tbody>
  {rows.map((p) => (
    <tr
      key={p.address}
      onClick={() => onSelect(p)}
      className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/30"
    >
      <td className="px-4 py-3">
        <div className="font-medium">{poolDisplayName(p)}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {shortenAddress(p.address)}
          </span>
          {/* Stop the copy button's activation from bubbling into the row's select handler. */}
          <span
            className="contents"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <CopyAddress value={p.address} label="pool address" />
          </span>
        </div>
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        <TokenPair
          stakingSymbol={p.stakingSymbol}
          rewardSymbol={p.rewardSymbol}
          stakingImage={p.stakingImage}
          rewardImage={p.rewardImage}
          size={4}
        />
      </td>
      <td className="px-4 py-3 tabular-nums">
        {totalStakedLabel(p)}
      </td>
      <td className="px-4 py-3 tabular-nums">
        {formatLockDuration(p.lockDuration)}
      </td>
      <td className="px-4 py-3 tabular-nums">
        {emissionLabel(p)}
      </td>
      <td className="px-4 py-3">
        <PoolStatusBadge status={p.status} />
      </td>
      <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">
        {p.poolId}
      </td>
    </tr>
  ))}
</tbody>
        </table>
      </Card>

      {/* Mobile / tablet cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:hidden">
        {rows.map((p) => (
          <Card
            key={p.address}
            role="button"
            tabIndex={0}
            aria-label={`Open ${poolDisplayName(p)} details`}
            onClick={() => onSelect(p)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onSelect(p)
              }
            }}
            className="cursor-pointer select-none p-4 transition-colors outline-none hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium">{poolDisplayName(p)}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {shortenAddress(p.address)}
                  </span>
                  {/* Stop the copy button's activation from bubbling into the card's select handler. */}
                  <span
                    className="contents"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <CopyAddress value={p.address} label="pool address" />
                  </span>
                </div>
              </div>
              <PoolStatusBadge status={p.status} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <Stat label="Total Staked" value={totalStakedLabel(p)} />
              <Stat label="Lock" value={formatLockDuration(p.lockDuration)} />
              <Stat label="Reward Rate" value={emissionLabel(p)} />
              <StatTokens
                label="Tokens"
                stakingSymbol={p.stakingSymbol}
                rewardSymbol={p.rewardSymbol}
                stakingImage={p.stakingImage}
                rewardImage={p.rewardImage}
              />
            </div>
          </Card>
        ))}
      </div>
    </>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 tabular-nums ${accent ? "font-medium text-primary" : ""}`}>{value}</div>
    </div>
  )
}

/** A Stat whose value is the token pair (logos + symbols). */
function StatTokens({
  label,
  stakingSymbol,
  rewardSymbol,
  stakingImage,
  rewardImage,
}: {
  label: string
  stakingSymbol: string
  rewardSymbol: string
  stakingImage?: string
  rewardImage?: string
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5">
        <TokenPair
          stakingSymbol={stakingSymbol}
          rewardSymbol={rewardSymbol}
          stakingImage={stakingImage}
          rewardImage={rewardImage}
          size={4}
        />
      </div>
    </div>
  )
}

function PoolDetail({ pool, onClose }: { pool: PoolRow; onClose: () => void }) {
  const router = useRouter()
  const { selectPool } = usePoolOptional() ?? {}
  const [copied, setCopied] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)
  const stakingUrl = stakingUrlForPool(pool.address)

  /** Select this pool as the app-wide active pool, then open its admin view. */
  const handleManage = () => {
    selectPool?.(new PublicKey(pool.address))
    void router.push("/admin")
  }
  const absoluteStakingUrl = typeof window !== "undefined" ? `${window.location.origin}${stakingUrl}` : stakingUrl
  const stats = [
    { label: "Total Staked", value: totalStakedLabel(pool), icon: Coins },
    { label: "Reward Rate", value: emissionLabel(pool), icon: Percent },
    { label: "Lock-up Duration", value: formatLockDuration(pool.lockDuration), icon: Calendar },
    { label: "Pool ID", value: pool.poolId, icon: Layers },
  ]

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div>
  <h2 className="text-lg font-semibold">
    {poolDisplayName(pool)}
  </h2>
  <div className="mt-0.5 font-mono text-xs text-muted-foreground">
    {shortenAddress(pool.address)}
  </div>
</div>
              <PoolStatusBadge status={pool.status} />
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
              <TokenBadge image={pool.stakingImage} symbol={pool.stakingSymbol} size={4} />
              <span>{pool.stakingSymbol} staking</span>
              <span>·</span>
              <TokenBadge image={pool.rewardImage} symbol={pool.rewardSymbol} size={4} />
              <span>{pool.rewardSymbol} rewards</span>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-5 rounded-lg border border-border bg-muted/40 p-3">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Pool Address</div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <code className="truncate font-mono text-xs">{pool.address}</code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(pool.address)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            >
              {copied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
            </button>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Tokens &amp; Authority</div>
          <div className="mt-2 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">Staking mint</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <TokenBadge image={pool.stakingImage} symbol={pool.stakingSymbol} size={4} />
                <code className="min-w-0 truncate font-mono">
                  {shortenAddress(pool.stakingMint.toBase58())} ({pool.stakingSymbol})
                </code>
                <CopyAddress value={pool.stakingMint.toBase58()} label="staking mint address" />
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">Reward mint</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <TokenBadge image={pool.rewardImage} symbol={pool.rewardSymbol} size={4} />
                <code className="min-w-0 truncate font-mono">
                  {shortenAddress(pool.rewardMint.toBase58())} ({pool.rewardSymbol})
                </code>
                <CopyAddress value={pool.rewardMint.toBase58()} label="reward mint address" />
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">Authority</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 truncate font-mono">{shortenAddress(pool.authority)}</code>
                <CopyAddress value={pool.authority} label="pool authority address" />
              </span>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          {stats.map((s) => {
            const Icon = s.icon
            return (
              <div key={s.label} className="rounded-lg border border-border p-3">
                <Icon className="size-4 text-primary" aria-hidden />
                <div className="mt-2 font-mono text-lg font-semibold tabular-nums">{s.value}</div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
              </div>
            )
          })}
        </div>

        {/* Public staking URL — derived from the pool address, stable forever. */}
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-primary">
            <Link2 className="size-3.5" aria-hidden /> Staking URL
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <code className="truncate font-mono text-xs">{absoluteStakingUrl}</code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(absoluteStakingUrl)
                setUrlCopied(true)
                setTimeout(() => setUrlCopied(false), 1500)
              }}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            >
              {urlCopied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
            </button>
          </div>
          <Link href={stakingUrl} target="_blank" className="mt-2.5 inline-flex">
            <Button size="sm" variant="outline" className="gap-1.5">
              Open Staking Page <ExternalLink className="size-3.5" aria-hidden />
            </Button>
          </Link>
        </div>

        <div className="mt-auto flex flex-col gap-2 pt-6">
          <Button onClick={handleManage} className="gap-1.5">
            <ShieldCheck className="size-4" /> Manage Pool
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
