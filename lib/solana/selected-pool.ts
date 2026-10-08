"use client"

/**
 * Persistence for the user's explicitly-selected staking pool.
 *
 * The selected pool is an app-wide, user-level concept independent of the
 * connected wallet. It is persisted in localStorage (versioned key) so it
 * survives navigation and full page reloads. PoolProvider reads this on
 * hydration, validates the address still exists on-chain, and only then uses
 * it as the active pool; otherwise it falls back to the bootstrap default.
 *
 * Never tie this to the wallet address - the wallet and the selected pool are
 * separate concepts.
 */
const STORAGE_KEY = "pumpswap.selected-pool.v1"

export function loadSelectedPoolAddress(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // Storage unavailable - treat as no explicit selection.
    return null
  }
}

export function saveSelectedPoolAddress(address: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (address) {
      window.localStorage.setItem(STORAGE_KEY, address)
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Storage unavailable (private mode / quota) - keep in-memory only.
  }
}

export function clearSelectedPoolAddress(): void {
  saveSelectedPoolAddress(null)
}
