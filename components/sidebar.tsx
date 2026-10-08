"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  CirclePlus,
  Layers,
  ChartColumn,
  Gift,
  Palette,
  ShieldAlert,
  ExternalLink,
} from "lucide-react"
import { useWhiteLabelConfig } from "@/lib/white-label"

const adminNav = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/create-pool", label: "Create Pool", icon: CirclePlus },
  { href: "/pools", label: "Pools", icon: Layers },
  { href: "/analytics", label: "Analytics", icon: ChartColumn },
  { href: "/rewards", label: "Rewards", icon: Gift },
  { href: "/white-label", label: "White Label", icon: Palette },
  { href: "/admin", label: "Circuit Breaker", icon: ShieldAlert },
]

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const brand = useWhiteLabelConfig()

  return (
    <div className="flex h-full flex-col gap-1">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div
          className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg"
          style={{ backgroundColor: brand.color }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={brand.logoDataUrl ?? "/apple-icon.png"}
            alt={`${brand.title} logo`}
            className="size-full object-cover"
          />
        </div>
        <div className="leading-tight">
          <div className="font-mono text-sm font-semibold tracking-tight">{brand.title}</div>
          <div className="text-xs text-muted-foreground">Staking Console</div>
        </div>
      </div>

      <div className="px-4 pb-2 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Founder Console
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        {adminNav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/")
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className={`size-4 ${active ? "text-primary" : ""}`} aria-hidden />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="mt-auto p-3">
        <Link
          href="/stake"
          onClick={onNavigate}
          className="flex items-center justify-between rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-muted"
        >
          <div className="leading-tight">
            <div className="text-sm font-medium">Staking Portal</div>
            <div className="text-xs text-muted-foreground">End-user view</div>
          </div>
          <ExternalLink className="size-4 text-muted-foreground" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
