"use client"

import { Lock, Snowflake } from "lucide-react"
import { usePool } from "@/lib/pool-context"

export function PoolLockBanner() {
  const { lockState, lockReason } = usePool()
  if (lockState === "active") return null

  const frozen = lockState === "frozen"
  const Icon = frozen ? Snowflake : Lock

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-xl border p-4 ${
        frozen
          ? "border-destructive/30 bg-destructive/10"
          : "border-warning/30 bg-warning/10"
      }`}
    >
      <div
        className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
          frozen ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning"
        }`}
      >
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="min-w-0">
        <div className={`text-sm font-semibold ${frozen ? "text-destructive" : "text-warning"}`}>
          POOL LOCKED — {frozen ? "Emergency Freeze" : "Global Pause"} Active
        </div>
        <p className="mt-0.5 text-sm leading-relaxed text-foreground/80">{lockReason}</p>
      </div>
    </div>
  )
}
