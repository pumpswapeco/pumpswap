import type { LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"

export function MetricCard({
  label,
  value,
  delta,
  deltaTone = "up",
  icon: Icon,
}: {
  label: string
  value: string
  delta?: string
  deltaTone?: "up" | "down" | "neutral"
  icon: LucideIcon
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="size-5 text-primary" aria-hidden />
        </div>
      </div>
      <div className="mt-3 font-mono text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {delta && (
        <div
          className={`mt-1 text-xs font-medium ${
            deltaTone === "up"
              ? "text-accent"
              : deltaTone === "down"
                ? "text-destructive"
                : "text-muted-foreground"
          }`}
        >
          {delta}
        </div>
      )}
    </Card>
  )
}
