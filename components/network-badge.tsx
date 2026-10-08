"use client"

import { usePool } from "@/lib/pool-context"

export function NetworkBadge() {
  const {
    networkLabel,
    rpcStatus,
    rpcError,
    walletConnected,
    isWrongNetwork,
  } = usePool()

  let statusText = "Checking network…"
  let tone: "ok" | "warn" | "error" | "idle" = "idle"

  if (rpcStatus === "error") {
    statusText = rpcError ?? "Network unavailable"
    tone = "error"
  } else if (isWrongNetwork) {
    statusText = "Wrong wallet network"
    tone = "warn"
  } else if (rpcStatus === "checking") {
    statusText = "Checking network…"
    tone = "idle"
  } else if (walletConnected) {
    statusText = "Wallet connected"
    tone = "ok"
  } else {
    statusText = "Wallet not connected"
    tone = "idle"
  }

  const dotClass =
    tone === "ok"
      ? "bg-accent"
      : tone === "warn"
        ? "bg-warning"
        : tone === "error"
          ? "bg-destructive"
          : "bg-muted-foreground"

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5"
      title={rpcStatus === "error" ? rpcError ?? undefined : undefined}
    >
      <span className="relative flex size-2" aria-hidden>
        {tone === "ok" && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
        )}
        <span className={`relative inline-flex size-2 rounded-full ${dotClass}`} />
      </span>
      <span className="text-xs font-medium text-foreground">{networkLabel}</span>
      <span className="hidden text-xs text-muted-foreground sm:inline">{statusText}</span>
    </div>
  )
}
