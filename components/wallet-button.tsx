"use client"

import { Loader2, Wallet, LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePool } from "@/lib/pool-context"
import { getInsufficientSolMessage } from "@/lib/solana/errors"

export function WalletButton() {
  const {
    walletConnected,
    walletAddress,
    solBalanceFormatted,
    solBalanceLoading,
    solBalanceLamports,
    walletError,
    clearWalletError,
    connectWallet,
    disconnectWallet,
    walletReady,
  } = usePool()

  const lowSol =
    solBalanceLamports !== null && solBalanceLamports < 5_000_000

  if (walletConnected) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => void disconnectWallet()}
          className="group flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-muted"
          title={
            lowSol
              ? getInsufficientSolMessage()
              : solBalanceFormatted
                ? `${walletAddress} · ${solBalanceFormatted}`
                : "Disconnect wallet"
          }
        >
          <span className="size-2 rounded-full bg-accent" aria-hidden />
          <span className="font-mono text-xs">{walletAddress}</span>
          {solBalanceLoading ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
          ) : solBalanceFormatted ? (
            <span className="hidden text-xs text-muted-foreground sm:inline">{solBalanceFormatted}</span>
          ) : null}
          <LogOut className="size-3.5 text-muted-foreground group-hover:text-foreground" aria-hidden />
        </button>
        {lowSol && (
          <p className="max-w-[14rem] text-right text-[11px] leading-snug text-warning">{getInsufficientSolMessage()}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        onClick={() => {
          clearWalletError()
          void connectWallet()
        }}
        disabled={!walletReady}
        className="gap-2"
      >
        <Wallet className="size-4" aria-hidden />
        <span className="hidden sm:inline">Connect Wallet</span>
        <span className="sm:hidden">Connect</span>
      </Button>
      {walletError && (
        <p className="max-w-[14rem] text-right text-[11px] leading-snug text-destructive" role="alert">
          {walletError}
        </p>
      )}
    </div>
  )
}
