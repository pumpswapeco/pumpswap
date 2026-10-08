"use client"

import { Coins, Users, Percent, Gift } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import { MetricCard } from "@/components/metric-card"
import { AnalyticsChart } from "@/components/analytics-chart"
import { PoolLockBanner } from "@/components/pool-lock-banner"
import { Card } from "@/components/ui/card"
import { ActivityTable } from "@/components/activity-table"
import { usePoolStats } from "@/lib/solana/use-pool-stats"
import { useRecentActivity } from "@/lib/solana/use-recent-activity"
import { buildActivityRows } from "@/lib/solana/activity-display"
import { baseUnitsToTokens } from "@/lib/solana/display"

export default function AnalyticsPage() {
  const stats = usePoolStats()
  const activity = useRecentActivity()

  const totalStakedDisplay = stats.loading
    ? "…"
    : stats.pools
        .reduce((acc, p) => acc + baseUnitsToTokens(p.totalStaked, p.stakingDecimals), 0)
        .toLocaleString(undefined, { maximumFractionDigits: 4 })

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

      // Calculate the emission-based APY for each pool.
      // This is a token-unit estimate, not a USD/price-based APY.
      const apys = activePools
        .map((p) => {
          const totalStakedRaw = BigInt(p.totalStaked.toString())
          const rewardRateRaw = BigInt(p.rewardRatePerSecond.toString())

          const annualRewardTokens =
            Number(rewardRateRaw) /
            Math.pow(10, p.rewardDecimals) *
            (365 * 24 * 60 * 60)

          const totalStakedTokens =
            Number(totalStakedRaw) /
            Math.pow(10, p.stakingDecimals)

          if (
            !Number.isFinite(annualRewardTokens) ||
            !Number.isFinite(totalStakedTokens) ||
            totalStakedTokens <= 0
          ) {
            return null
          }

          return (annualRewardTokens / totalStakedTokens) * 100
        })
        .filter((value): value is number => value !== null && Number.isFinite(value))

      if (apys.length === 0) return "—"

      const averageApy =
        apys.reduce((sum, value) => sum + value, 0) / apys.length

      return `${averageApy.toFixed(2)}%`
    })()




  const aggregates = stats.aggregates
  const claimedDisplay = stats.loading
    ? "…"
    : aggregates === null
      ? "Claimed totals unavailable"
      : (() => {
          // Sum claimed rewards per reward-mint decimals (mixed mints are shown in token units).
          const total = stats.pools.reduce((acc, p) => {
            const claimed = aggregates[p.address]?.claimed ?? BigInt(0)
            return acc + baseUnitsToTokens(claimed.toString(), p.rewardDecimals)
          }, 0)
          return total.toLocaleString(undefined, { maximumFractionDigits: 4 })
        })()

  const activityRows = buildActivityRows(activity.rows, stats.pools)

  return (
    <AppShell title="Analytics" description="Real-time on-chain metrics across all pools">
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
           label="Current Pool APY"
           value={apyDisplay}
           delta="Based on current pool emission"
           deltaTone="neutral"
           icon={Percent}
/>
          <MetricCard
            label="Total Rewards Claimed"
            value={claimedDisplay}
            delta="Token units"
            deltaTone="neutral"
            icon={Gift}
          />
        </div>

        <Card className="p-5">
          <AnalyticsChart />
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">On-Chain Activity</h2>
          {activity.loading ? (
            <p className="text-sm text-muted-foreground">Loading on-chain activity…</p>
          ) : activity.error ? (
            <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-10 text-center">
              <p className="text-sm font-medium text-destructive">Couldn&apos;t load on-chain activity</p>
              <p className="text-xs text-muted-foreground">{activity.error}</p>
            </div>
          ) : activityRows.length === 0 ? (
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
      </div>
    </AppShell>
  )
}
