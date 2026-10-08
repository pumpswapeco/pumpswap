"use client"

import Link from "next/link"
import { PublicKey } from "@solana/web3.js"
import { CirclePlus, ChartColumn, Layers, ExternalLink, Coins, Users, Percent, Gift, ArrowRight, Check } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import { MetricCard } from "@/components/metric-card"
import { PoolLockBanner } from "@/components/pool-lock-banner"
import { ActivityTable } from "@/components/activity-table"
import { PoolStatusBadge } from "@/components/pool-status"
import { Card } from "@/components/ui/card"
import { usePoolStats } from "@/lib/solana/use-pool-stats"
import { useUserRewards } from "@/lib/solana/use-user-rewards"
import { useRecentActivity } from "@/lib/solana/use-recent-activity"
import { usePoolOptional } from "@/lib/pool-context"
import { buildActivityRows, formatTokenUnitAmount } from "@/lib/solana/activity-display"
import { baseUnitsToTokens, formatLockDurationSeconds } from "@/lib/solana/display"
import { shortenAddress } from "@/lib/solana/format"

const quickActions = [
  { href: "/create-pool", label: "Create Pool", icon: CirclePlus },
  { href: "/analytics", label: "View Analytics", icon: ChartColumn },
  { href: "/pools", label: "Manage Pools", icon: Layers },
  { href: "/stake", label: "Staking Portal", icon: ExternalLink },
]

export default function DashboardPage() {
  const stats = usePoolStats()
  const rewards = useUserRewards()
  const activity = useRecentActivity()
  const { poolAddress, selectPool } = usePoolOptional() ?? {}

  const totalStakedDisplay = stats.loading
    ? "…"
    : (() => {
        const total = stats.pools.reduce(
          (acc, p) => acc + baseUnitsToTokens(p.totalStaked, p.stakingDecimals),
          0,
        )
        return total.toLocaleString(undefined, { maximumFractionDigits: 4 })
      })()

  const stakersDisplay = stats.loading
    ? "…"
    : stats.totalStakers === null
      ? "Staker totals unavailable"
      : stats.totalStakers.toLocaleString()

  const apyDisplay = stats.loading
  ? "…"
  : (() => {
      const activePools = stats.pools.filter(
        (p) =>
          BigInt(p.totalStaked.toString()) > BigInt(0) &&
          BigInt(p.rewardRatePerSecond.toString()) > BigInt(0),
      )

      if (activePools.length === 0) return "—"

      const apys = activePools
        .map((p) => {
          const totalStakedRaw = BigInt(p.totalStaked.toString())
          const rewardRateRaw = BigInt(p.rewardRatePerSecond.toString())

          const annualRewardTokens =
            (Number(rewardRateRaw) / Math.pow(10, p.rewardDecimals)) *
            (365 * 24 * 60 * 60)

          const totalStakedTokens =
            Number(totalStakedRaw) / Math.pow(10, p.stakingDecimals)

          if (
            !Number.isFinite(annualRewardTokens) ||
            !Number.isFinite(totalStakedTokens) ||
            totalStakedTokens <= 0
          ) {
            return null
          }

          return (annualRewardTokens / totalStakedTokens) * 100
        })
        .filter(
          (value): value is number =>
            value !== null && Number.isFinite(value),
        )

      if (apys.length === 0) return "—"

      const averageApy =
        apys.reduce((sum, value) => sum + value, 0) / apys.length

      return `${averageApy.toFixed(2)}%`
    })()

  const rewardsValue = rewards.loading
    ? "…"
    : !rewards.poolAddress
      ? "Select a pool"
      : !rewards.ready
        ? "—"
        : `${formatTokenUnitAmount(rewards.pendingTokens)} ${rewards.rewardSymbol ?? "tokens"}`

  const rewardsDelta = rewards.loading
    ? "Loading on-chain position…"
    : !rewards.poolAddress
      ? "Pick a pool on the /pools page"
      : !rewards.ready
        ? rewards.connected
          ? "Unable to read on-chain position"
          : "Connect a wallet to see your rewards"
        : rewards.poolAddress
          ? `Selected pool ${shortenAddress(rewards.poolAddress, 6)}`
          : "Live from your on-chain position"

  const activityRows = buildActivityRows(activity.rows, stats.pools)

  return (
    <AppShell title="Overview" description="Monitor your deployed staking pools at a glance">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <PoolLockBanner />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Total Value Locked"
            value={totalStakedDisplay}
            delta="Token units · USD pending price feed"
            deltaTone="neutral"
            icon={Coins}
          />
          <MetricCard
            label="Active Stakers"
            value={stakersDisplay}
            delta="Across all pools"
            deltaTone="neutral"
            icon={Users}
          />
          <MetricCard
          label="Current APY"
          value={apyDisplay}
          delta="Based on current pool emission"
          deltaTone="neutral"
          icon={Percent}
/>
          <MetricCard
            label="Pending Rewards"
            value={rewardsValue}
            delta={rewardsDelta}
            deltaTone="neutral"
            icon={Gift}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {quickActions.map((a) => {
            const Icon = a.icon
            return (
              <Link
                key={a.href}
                href={a.href}
                className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted"
              >
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="size-5 text-primary" aria-hidden />
                </div>
                <span className="text-sm font-medium">{a.label}</span>
              </Link>
            )
          })}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="p-5 lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Recent Activity</h2>
              <Link href="/analytics" className="text-xs font-medium text-primary hover:underline">
                View all
              </Link>
            </div>
            {activity.loading ? (
              <p className="text-sm text-muted-foreground">Loading recent activity…</p>
            ) : activity.error ? (
              <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-10 text-center">
                <p className="text-sm font-medium text-destructive">Couldn&apos;t load recent activity</p>
                <p className="text-xs text-muted-foreground">{activity.error}</p>
              </div>
            ) : activity.rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-10 text-center">
                <p className="text-sm font-medium text-muted-foreground">No on-chain activity yet.</p>
                <p className="text-xs text-muted-foreground">
                  Stake, unstake, claim, or fund rewards on the selected pool to see pool-wide activity here.
                </p>
              </div>
            ) : (
              <ActivityTable rows={activityRows} />
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Pool Status</h2>
              <Link href="/pools" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                Manage <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="flex flex-col gap-3">
              {stats.loading ? (
                <p className="text-sm text-muted-foreground">Loading on-chain pools…</p>
              ) : stats.pools.length === 0 ? (
                <p className="text-sm text-muted-foreground">No on-chain pools yet.</p>
              ) : (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    Click a pool to make it the selected pool for admin actions, Fund Rewards, activity, and TVL.
                  </p>
                  {stats.pools.map((p) => {
                    const tvl = baseUnitsToTokens(p.totalStaked, p.stakingDecimals).toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })
                    const isSelected = poolAddress !== null && poolAddress !== undefined && poolAddress.toBase58() === p.address
                    return (
                      <button
                        key={p.address}
                        type="button"
                        onClick={() => selectPool?.(new PublicKey(p.address))}
                        aria-pressed={isSelected}
                        className={`flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/40 ${
                          isSelected
                            ? "border-primary/60 bg-primary/10"
                            : "border-border"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {isSelected && (
                              <span className="mr-1.5 inline-flex size-4 items-center justify-center rounded-full bg-primary/20 text-primary">
                                <Check className="size-3" aria-hidden />
                              </span>
                            )}
                            {p.name}
                            <span className="ml-1.5 text-[10px] font-medium uppercase text-primary/80">
                              {isSelected ? "Selected" : "Select"}
                            </span>
                          </div>
                          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                            {tvl} {p.stakingSymbol} · {formatLockDurationSeconds(p.lockDuration)}
                          </div>
                        </div>
                        <PoolStatusBadge status={p.status} />
                      </button>
                    )
                  })}
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
