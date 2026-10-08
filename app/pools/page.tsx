import { AppShell } from "@/components/app-shell"
import { PoolsList } from "@/components/pools-list"
import { PoolLockBanner } from "@/components/pool-lock-banner"

export default function PoolsPage() {
  return (
    <AppShell title="Pools" description="Manage your deployed staking pools">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <PoolLockBanner />
        {/* PoolsList renders the live pool count, create button, and states. */}
        <PoolsList />
      </div>
    </AppShell>
  )
}
