"use client"

import { useState } from "react"
import { Pause, Snowflake, ShieldCheck, RotateCcw } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ConfirmationDialog } from "@/components/confirmation-dialog"
import { usePool } from "@/lib/pool-context"
import { getConfiguredNetwork } from "@/lib/solana/network"

type PendingAction = "pause" | "freeze" | "restore" | null

export function CircuitBreaker() {
  const { lockState, pauseGlobal, triggerFreeze, restore, lastAdminTxs } = usePool()
  const [pending, setPending] = useState<PendingAction>(null)

  const paused = lockState === "paused"
  const frozen = lockState === "frozen"

  function confirm() {
    if (pending === "pause") pauseGlobal()
    if (pending === "freeze") triggerFreeze()
    if (pending === "restore") restore()
    setPending(null)
  }

  const dialogCopy = {
    pause: {
      title: "Confirm Global Pool Pause",
      description:
        "This will pause new staking deposits across the deployed pool. Users will not be able to stake until you restore the pool — existing positions can still be unstaked and accrued rewards can still be claimed.",
      confirmLabel: "Pause Pool",
      tone: "warning" as const,
    },
    freeze: {
      title: "Trigger Emergency Freeze",
      description:
        "Emergency freeze stops new staking deposits immediately and flags the pool for administrator review. Users can still unstake existing positions and claim accrued rewards. Only use this in response to a suspected exploit or critical incident.",
      confirmLabel: "Trigger Freeze",
      tone: "danger" as const,
    },
    restore: {
      title: "Restore Pool Operations",
      description:
        "This will lift the current lock and re-enable new staking deposits for users on the portal. Unstaking and reward claims remained available the whole time the pool was locked.",
      confirmLabel: "Restore Pool",
      tone: "warning" as const,
    },
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Global Pool Pause */}
        <Card className="flex flex-col gap-4 p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-warning/15 text-warning">
              <Pause className="size-5" aria-hidden />
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                paused
                  ? "border-warning/25 bg-warning/15 text-warning"
                  : "border-border bg-muted text-muted-foreground"
              }`}
            >
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {paused ? "Active" : "Standby"}
            </span>
          </div>
          <div>
            <h2 className="text-base font-semibold">Global Pool Pause</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Temporarily disable new staking and deposits. Unstaking and reward claims remain available. Reversible — use for maintenance windows or planned upgrades.
            </p>
          </div>
          <Button
            variant="outline"
            className="mt-auto w-full"
            disabled={paused}
            onClick={() => setPending("pause")}
          >
            <Pause className="size-4" aria-hidden />
            Global Pool Pause
          </Button>
        </Card>

        {/* Emergency Freeze */}
        <Card className="flex flex-col gap-4 p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
              <Snowflake className="size-5" aria-hidden />
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                frozen
                  ? "border-destructive/25 bg-destructive/15 text-destructive"
                  : "border-border bg-muted text-muted-foreground"
              }`}
            >
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {frozen ? "Engaged" : "Standby"}
            </span>
          </div>
          <div>
            <h2 className="text-base font-semibold">Emergency Freeze</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Immediately stop new staking deposits in response to a suspected exploit or critical incident. Unstaking and reward claims remain available.
            </p>
          </div>
          <Button
            variant="destructive"
            className="mt-auto w-full"
            disabled={frozen}
            onClick={() => setPending("freeze")}
          >
            <Snowflake className="size-4" aria-hidden />
            Trigger Emergency Freeze
          </Button>
        </Card>
      </div>

      {/* Restore control */}
      <Card className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
              lockState === "active" ? "bg-accent/15 text-accent" : "bg-muted text-muted-foreground"
            }`}
          >
            <ShieldCheck className="size-5" aria-hidden />
          </div>
          <div>
            <h2 className="text-base font-semibold">Restore Pool Operations</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {lockState === "active"
                ? "The pool is operating normally. All user staking controls are enabled."
                : "Lift the active lock and re-enable new staking deposits on the portal. Unstaking and reward claims remained available throughout the lock."}
            </p>
          </div>
        </div>
        <Button
          className="w-full sm:w-auto"
          disabled={lockState === "active"}
          onClick={() => setPending("restore")}
        >
          <RotateCcw className="size-4" aria-hidden />
          Restore Pool
        </Button>
      </Card>

      {/* Confirmed admin transactions (present only after on-chain success),
          each linked to Solana Explorer for independent verification. */}
      {lastAdminTxs && lastAdminTxs.length > 0 && (
        <div className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-xs text-accent">
          <div className="font-medium">Confirmed on-chain:</div>
          <div className="mt-1.5 flex flex-col gap-1">
            {lastAdminTxs.map((tx) => (
              <div key={tx.signature} className="flex min-w-0 items-center gap-2">
                <span className="shrink-0">{tx.label}</span>
                <a
                  href={`https://explorer.solana.com/tx/${tx.signature}?cluster=${getConfiguredNetwork()}`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate font-mono underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                >
                  {tx.signature}
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmationDialog
        open={pending !== null}
        title={pending ? dialogCopy[pending].title : ""}
        description={pending ? dialogCopy[pending].description : ""}
        confirmLabel={pending ? dialogCopy[pending].confirmLabel : ""}
        tone={pending ? dialogCopy[pending].tone : "default"}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </>
  )
}
