"use client"

import { useEffect } from "react"

import { usePoolOptional } from "@/lib/pool-context"
import { useWhiteLabelConfig } from "@/lib/white-label"

/**
 * Applies the SELECTED pool's white-label brand color to the existing theme.
 *
 * The design system reads its palette from CSS custom properties (--primary,
 * --ring, --sidebar-primary, --chart-1, ... mapped through Tailwind v4's
 * @theme inline). This component rewrites those variables on <html> from the
 * pool-scoped white-label config, so the configured color visibly affects
 * primary buttons, links, selected/active states, borders and highlights -
 * without replacing or redesigning the design system.
 *
 * - For admin pages pass no prop: the selected pool's brand is used.
 * - For the staking portal pass the URL's pool address explicitly so branding
 *   follows the pool being viewed, not the console selection.
 */
export function BrandTheme({ poolAddress }: { poolAddress?: string }) {
  const { poolAddress: selectedPool } = usePoolOptional() ?? { poolAddress: null }
  const key = poolAddress ?? (selectedPool ? selectedPool.toBase58() : undefined)
  const brand = useWhiteLabelConfig(key)

  useEffect(() => {
    const color = brand.color?.trim()
    if (!color) return
    const root = document.documentElement
    root.style.setProperty("--primary", color)
    root.style.setProperty("--ring", color)
    root.style.setProperty("--sidebar-primary", color)
    root.style.setProperty("--chart-1", color)
  }, [brand.color])

  return null
}