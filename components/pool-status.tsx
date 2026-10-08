/** Lifecycle status of a staking pool, derived from on-chain flags. */
export type PoolStatus = "Active" | "Paused" | "Frozen"

const styles: Record<PoolStatus, string> = {
  Active: "bg-accent/15 text-accent border-accent/25",
  Paused: "bg-warning/15 text-warning border-warning/25",
  Frozen: "bg-destructive/15 text-destructive border-destructive/25",
}

export function PoolStatusBadge({ status }: { status: PoolStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {status}
    </span>
  )
}
