import { AppShell } from "@/components/app-shell"
import { PoolLockBanner } from "@/components/pool-lock-banner"
import { WhiteLabelEditor } from "@/components/white-label-editor"

export default function WhiteLabelPage() {
  return (
    <AppShell
      title="White Label"
      description="Brand your customer-facing staking portal"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <PoolLockBanner />
        <WhiteLabelEditor />
      </div>
    </AppShell>
  )
}
