"use client"

import { Gift, Coins, CircleCheckBig, Activity } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import { MetricCard } from "@/components/metric-card"
import { PoolLockBanner } from "@/components/pool-lock-banner"
import { Card } from "@/components/ui/card"
import { ActivityTable } from "@/components/activity-table"
import { usePoolStats } from "@/lib/solana/use-pool-stats"
import { useUserRewards } from "@/lib/solana/use-user-rewards"
import { useRecentActivity } from "@/lib/solana/use-recent-activity"
import { buildActivityRows, formatTokenUnitAmount } from "@/lib/solana/activity-display"
import { baseUnitsToTokens } from "@/lib/solana/display"
import { shortenAddress } from "@/lib/solana/format"

export default function RewardsPage() {
  const stats = usePoolStats()
  const rewards = useUserRewards()
  const activity = useRecentActivity()

  const aggregates = stats.aggregates
  const claimedDisplay = stats.loading
    ? "..."
    : aggregates === null
      ? "Claimed totals unavailable"
      : stats.pools
          .reduce((acc, p) => {
            const claimed = aggregates[p.address]?.claimed ?? BigInt(0)
            return (
              acc +
              baseUnitsToTokens(claimed.toString(), p.rewardDecimals)
            )
          }, 0)
          .toLocaleString(undefined, {
            maximumFractionDigits: 4,
          })

  const emissionPerDayDisplay = stats.loading
    ? "..."
    : stats.pools
        .reduce(
          (acc, p) =>
            acc +
            baseUnitsToTokens(
              p.rewardRatePerSecond,
              p.rewardDecimals
            ) *
              86400,
          0
        )
        .toLocaleString(undefined, {
          maximumFractionDigits: 4,
        })

  const pendingRewardsValue = rewards.loading
    ? "…"
    : !rewards.poolAddress
      ? "Select a pool"
      : !rewards.ready
        ? "—"
        : `${formatTokenUnitAmount(rewards.pendingTokens)} ${rewards.rewardSymbol ?? "tokens"}`

  const pendingRewardsDelta = rewards.loading
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

  const claimRows = buildActivityRows(
    activity.rows.filter((row) => row.action === "Claim"),
    stats.pools,
  )

  return (
    <AppShell
      title="Rewards"
      description="Track reward distribution and emissions"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <PoolLockBanner />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Total Rewards Distributed"
            value={claimedDisplay}
            delta="Token units"
            deltaTone="neutral"
            icon={Gift}
          />

          <MetricCard
            label="Pending Rewards"
            value={pendingRewardsValue}
            delta={pendingRewardsDelta}
            deltaTone="neutral"
            icon={Coins}
          />

          <MetricCard
            label="Rewards Claimed"
            value={claimedDisplay}
            delta="Token units"
            deltaTone="neutral"
            icon={CircleCheckBig}
          />

          <MetricCard
            label="Emission Rate"
            value={`${emissionPerDayDisplay} / day`}
            delta="Reward token units"
            deltaTone="neutral"
            icon={Activity}
          />
        </div>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Rewards History</h2>

          {activity.loading ? (
            <p className="text-sm text-muted-foreground">Loading rewards history…</p>
          ) : activity.error ? (
            <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-10 text-center">
              <p className="text-sm font-medium text-destructive">Couldn&apos;t load rewards history</p>
              <p className="text-xs text-muted-foreground">{activity.error}</p>
            </div>
          ) : claimRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-10 text-center">
              <p className="text-sm font-medium text-muted-foreground">
                No rewards claimed yet.
              </p>

              <p className="text-xs text-muted-foreground">
                Claimed rewards from your on-chain transactions will appear here.
              </p>
            </div>
          ) : (
            <ActivityTable rows={claimRows} />
          )}
        </Card>
      </div>
    </AppShell>
  )
}