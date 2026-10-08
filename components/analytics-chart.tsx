"use client"

import { useMemo } from "react"
import { usePoolOptional } from "@/lib/pool-context"
import { usePoolStats } from "@/lib/solana/use-pool-stats"
import { useTvlHistory, type TvlHistoryPoint } from "@/lib/solana/use-pool-tvl-history"
import { baseUnitsToTokens } from "@/lib/solana/display"
import { shortenAddress } from "@/lib/solana/format"

/** Short "M/D HH:mm" label, falling back to the slot. */
function pointLabel(point: TvlHistoryPoint): string {
  if (point.blockTime !== null) {
    const d = new Date(point.blockTime * 1000)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getMonth() + 1}/${d.getDay()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return point.slot !== null ? `#${point.slot}` : "—"
}

export function AnalyticsChart() {
  const stats = usePoolStats()
  const { poolAddress } = usePoolOptional() ?? { poolAddress: null }
  const history = useTvlHistory(poolAddress)
  const noPoolSelected = poolAddress === null

  const tvl = useMemo(() => {
    if (stats.loading) return null

    return stats.pools.reduce(
      (acc, p) =>
        acc + baseUnitsToTokens(p.totalStaked, p.stakingDecimals),
      0,
    )
  }, [stats.loading, stats.pools])

  const displayValue =
    tvl === null
      ? "…"
      : tvl.toLocaleString(undefined, {
          maximumFractionDigits: 4,
        })

  const symbol = history.stakingSymbol ?? "tokens"

  return (
    <div>
      <div className="mb-4">
        <div className="text-sm text-muted-foreground">
          Total Value Locked · All Pools
        </div>

        <div className="font-mono text-2xl font-semibold tabular-nums">
          {displayValue}
        </div>

        <div className="mt-1 text-xs text-muted-foreground">
          Aggregate on-chain staking value across all pools (token units)
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
          Selected Pool TVL History (from on-chain transactions)
        </div>

        {poolAddress && (
          <p className="mb-2 text-xs text-muted-foreground">
            Selected pool:{" "}
            <span className="font-mono">{shortenAddress(poolAddress.toBase58(), 8)}</span>
          </p>
        )}

        {history.loading ? (
          <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-border sm:h-72">
            <p className="text-sm text-muted-foreground">
              Loading on-chain transaction history…
            </p>
          </div>
        ) : history.error ? (
          <div className="flex h-56 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-10 text-center sm:h-72">
            <p className="text-sm font-medium text-destructive">Couldn&apos;t load TVL history</p>
            <p className="max-w-md text-xs text-muted-foreground">{history.error}</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              The on-chain transaction history is temporarily unavailable. Nothing has been
              replaced with estimated or fabricated data.
            </p>
          </div>
        ) : history.points.length === 0 ? (
          <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-border sm:h-72">
            <div className="text-center">
              <div className="text-sm font-medium text-muted-foreground">
                {noPoolSelected
                  ? "Select a pool to view its TVL history"
                  : "No on-chain TVL history yet"}
              </div>

              <div className="mt-1 text-xs text-muted-foreground">
                {noPoolSelected
                  ? "Pick a pool on the /pools page to reconstruct its on-chain TVL history."
                  : "Stake or unstake tokens to start recording TVL history."}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            <ChartBars points={history.points} symbol={symbol} />

            <p className="mt-2 text-xs text-muted-foreground">
              Reconstructed from {history.eventsScanned} real on-chain
              stake/unstake transaction{history.eventsScanned === 1 ? "" : "s"} ·{" "}
              {symbol} token units
              {history.currentTvlTokens !== null
                ? ` · current on-chain total ${history.currentTvlTokens.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol}`
                : ""}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function ChartBars({
  points,
  symbol,
}: {
  points: TvlHistoryPoint[]
  symbol: string
}) {
  const maxTvl = Math.max(...points.map((p) => p.tvlTokens), 0)

  return (
    <>
      <div className="flex h-56 items-end gap-1.5 rounded-lg border border-border bg-muted/20 p-3 sm:h-72">
        {points.map((point) => {
          const pct = maxTvl > 0 ? Math.max((point.tvlTokens / maxTvl) * 100, 4) : 4
          const value = point.tvlTokens.toLocaleString(undefined, {
            maximumFractionDigits: 4,
          })
          return (
            <div
              key={point.signature}
              className="flex-1 rounded-t-md bg-primary/70 transition-colors hover:bg-primary"
              style={{ height: `${pct}%` }}
              title={`${point.action} → ${value} ${symbol} · ${pointLabel(point)}`}
            />
          )
        })}
      </div>

      <div className="mt-1 flex gap-1.5">
        {points.map((point) => (
          <span
            key={point.signature}
            className="flex-1 truncate text-center font-mono text-[9px] text-muted-foreground"
          >
            {pointLabel(point)}
          </span>
        ))}
      </div>
    </>
  )
}
