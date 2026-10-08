import type { ActivityRow } from "@/lib/solana/activity-display"
import { CopyAddress } from "@/components/ui/copy-address"

const actionStyles: Record<ActivityRow["action"], string> = {
  Stake: "text-accent",
  Claim: "text-primary",
  Unstake: "text-warning",
  Fund: "text-primary",
}

function signatureShort(signature: string): string {
  return signature.length > 17
    ? `${signature.slice(0, 8)}…${signature.slice(-8)}`
    : signature
}

export function ActivityTable({ rows }: { rows: ActivityRow[] }) {
  return (
    <div>
      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-lg border border-border sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Wallet</th>
              <th className="px-4 py-2.5 font-medium">Amount</th>
              <th className="px-4 py-2.5 font-medium">Pool</th>
              <th className="px-4 py-2.5 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className={`px-4 py-3 font-medium ${actionStyles[r.action]}`}>
                  {r.action}
                  {r.signature && (
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground" title={r.signature}>
                      {signatureShort(r.signature)}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
  <div className="flex min-w-0 items-center gap-1.5">
    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{r.wallet}</span>
    {r.walletAddress && <CopyAddress value={r.walletAddress} label="wallet address" />}
  </div>
</td>
<td className="px-4 py-3 tabular-nums">{r.amount}</td>
<td className="px-4 py-3">
  <div className="flex min-w-0 items-center gap-1.5">
    <span className="min-w-0 truncate text-xs text-muted-foreground">{r.pool}</span>
    {r.poolAddress && <CopyAddress value={r.poolAddress} label="pool address" />}
  </div>
</td>
                <td className="px-4 py-3 text-right text-muted-foreground">{r.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="flex flex-col gap-2 sm:hidden">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <span className={`text-sm font-medium ${actionStyles[r.action]}`}>{r.action}</span>
              <span className="text-xs text-muted-foreground">{r.time}</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-sm">
              <span className="tabular-nums">{r.amount}</span>
              <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
                <span className="min-w-0 truncate">{r.wallet}</span>
                {r.walletAddress && <CopyAddress value={r.walletAddress} label="wallet address" />}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">{r.pool}</span>
              {r.poolAddress && <CopyAddress value={r.poolAddress} label="pool address" />}
            </div>
            {r.signature && (
              <div className="mt-1 font-mono text-[10px] text-muted-foreground" title={r.signature}>
                {signatureShort(r.signature)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
