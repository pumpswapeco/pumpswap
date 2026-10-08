"use client"

import { useEffect, useState } from "react"
import { usePoolOptional } from "@/lib/pool-context"

/**
 * White-label branding configuration for the customer-facing staking portal.
 *
 * The project has no backend/database, so the smallest persistence mechanism
 * that matches the existing architecture is the browser's localStorage. The
 * editor writes here, and the staking portal (and the app chrome) reads here.
 *
 * Branding is POOL-SCOPED: every pool keeps its own logo / brand color / title
 * / subdomain, keyed by the pool address:
 *
 *   pumpswap.white-label.v1.<poolAddress>
 *
 * The legacy single-global key (pumpswap.white-label.v1) recorded NO pool
 * association, so it is deliberately NEVER auto-migrated into a pool key:
 * copying it into every unconfigured pool would stamp the same branding onto
 * all pools (cross-pool contamination). The legacy value is left untouched in
 * storage but is never read; per-pool keys are the sole source of truth. This
 * module is presentation-only: it never replaces or fakes on-chain pool data.
 * The staking pool, reward math, and all transactions remain 100% on-chain.
 */

export interface WhiteLabelConfig {
  /** Brand title shown in the sidebar and staking portal. */
  title: string
  /** Primary brand color (hex) used for accent surfaces. */
  color: string
  /** Preferred portal subdomain (display-only; no infra exists to host it). */
  subdomain: string
  /** Uploaded logo file name (for the editor). */
  logoName: string | null
  /** Uploaded logo as a data URL so it survives reloads without a backend. */
  logoDataUrl: string | null
}

export const DEFAULT_WHITE_LABEL_CONFIG: WhiteLabelConfig = {
  title: "Pumpswap Staking",
  color: "#7c5cff",
  subdomain: "myproject",
  logoName: null,
  logoDataUrl: null,
}

/**
 * Legacy single-global key (pre multi-pool). Never read and never copied into
 * a pool key: it has no pool association, so any automatic migration could
 * assign one pool's branding to another. Retained only so this constant keeps
 * documenting the old key's name.
 */
export const LEGACY_STORAGE_KEY = "pumpswap.white-label.v1"

export function whiteLabelStorageKey(poolAddress: string): string {
  return `pumpswap.white-label.v1.${poolAddress}`
}

/** In-memory copy per pool so saving updates already-mounted components live. */
const currentConfigs = new Map<string, WhiteLabelConfig>()
const listeners = new Set<{ pool: string; listener: () => void }>()

function emit(pool: string): void {
  for (const entry of listeners) {
    if (entry.pool === pool) entry.listener()
  }
}

/**
 * Legacy migration is intentionally disabled: the old global key carried no
 * pool association, so copying it would propagate one configuration to every
 * unconfigured pool. Per-pool storage is the only source of truth.
 */

export function loadWhiteLabelConfig(poolAddress: string): WhiteLabelConfig {
  if (typeof window === "undefined") return { ...DEFAULT_WHITE_LABEL_CONFIG }
  try {
    const raw = window.localStorage.getItem(whiteLabelStorageKey(poolAddress))
    if (!raw) return { ...DEFAULT_WHITE_LABEL_CONFIG }
    const parsed = JSON.parse(raw) as Partial<WhiteLabelConfig>
    return { ...DEFAULT_WHITE_LABEL_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_WHITE_LABEL_CONFIG }
  }
}

/** Current in-memory config for a pool (initialized from storage on first read). */
export function getWhiteLabelConfig(poolAddress: string): WhiteLabelConfig {
  if (!currentConfigs.has(poolAddress)) {
    currentConfigs.set(poolAddress, loadWhiteLabelConfig(poolAddress))
  }
  return currentConfigs.get(poolAddress)!
}

/** Persist the configuration for a specific pool. */
export function saveWhiteLabelConfig(poolAddress: string, next: WhiteLabelConfig): void {
  const merged = { ...DEFAULT_WHITE_LABEL_CONFIG, ...next }
  currentConfigs.set(poolAddress, merged)
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(whiteLabelStorageKey(poolAddress), JSON.stringify(merged))
    } catch {
      // Storage unavailable (private mode / quota) - keep in-memory only.
    }
  }
  emit(poolAddress)
}

export function resetWhiteLabelConfig(poolAddress: string): void {
  saveWhiteLabelConfig(poolAddress, { ...DEFAULT_WHITE_LABEL_CONFIG })
}

export function subscribeWhiteLabel(pool: string, listener: () => void): () => void {
  const entry = { pool, listener }
  listeners.add(entry)
  return () => {
    listeners.delete(entry)
  }
}

/**
 * Reactive pool-scoped white-label config for client components. Reads
 * localStorage after mount (never during render) so SSR/first paint always
 * matches the defaults and persisted values apply immediately after hydration
 * without a flash of the wrong brand.
 *
 * When no pool address is given, the app-wide selected pool from PoolProvider
 * is used (the founder console / sidebar follow the selected pool).
 */
export function useWhiteLabelConfig(poolAddress?: string): WhiteLabelConfig {
  const { poolAddress: selectedPool } = usePoolOptional() ?? { poolAddress: null }
  const key = poolAddress ?? (selectedPool ? selectedPool.toBase58() : "")
  const [config, setConfig] = useState<WhiteLabelConfig>(DEFAULT_WHITE_LABEL_CONFIG)

  useEffect(() => {
    if (!key) {
      setConfig(DEFAULT_WHITE_LABEL_CONFIG)
      return
    }
    getWhiteLabelConfig(key)
    setConfig(currentConfigs.get(key)!)
    return subscribeWhiteLabel(key, () => setConfig(currentConfigs.get(key) ?? DEFAULT_WHITE_LABEL_CONFIG))
  }, [key])

  return config
}