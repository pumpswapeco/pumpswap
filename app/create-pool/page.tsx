import { AppShell } from "@/components/app-shell"
import { PoolCreationWizard } from "@/components/pool-creation-wizard"
import { PoolLockBanner } from "@/components/pool-lock-banner"

export default function CreatePoolPage() {
  return (
    <AppShell title="Create Pool" description="Deploy a no-code staking pool in three steps">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <PoolLockBanner />
        <PoolCreationWizard />
      </div>
    </AppShell>
  )
}
