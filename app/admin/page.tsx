import { AppShell } from "@/components/app-shell"
import { PoolLockBanner } from "@/components/pool-lock-banner"
import { CircuitBreaker } from "@/components/circuit-breaker"
import { FundRewardsCard } from "@/components/fund-rewards-card"
import { NftBoostCard } from "@/components/nft-boost-card"

export default function AdminPage() {
  return (
    <AppShell
      title="Institutional Admin Control Center"
      description="Emergency controls for the deployed staking pool"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <PoolLockBanner />
        <FundRewardsCard />
        <NftBoostCard />
        <CircuitBreaker />
      </div>
    </AppShell>
  )
}
