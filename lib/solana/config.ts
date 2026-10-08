import { tryParsePublicKey } from '@/lib/solana/format'
import type { PublicKey } from '@solana/web3.js'

/**
 * Optional initial / fallback "selected pool", used ONLY to bootstrap the
 * selected-pool state in PoolProvider (lib/pool-context.tsx) for backwards
 * compatibility.
 *
 * This is deliberately NOT a source of truth for pool-scoped operations: once
 * a user picks a pool on /pools, the selected pool in PoolProvider overrides
 * this value everywhere (fund rewards, pause / freeze / restore, pending
 * rewards, activity, TVL history). Set NEXT_PUBLIC_DEFAULT_POOL_ADDRESS to the
 * deployed pool's PDA so first-time visitors get a sensible selection.
 */
export function getDefaultPoolAddress(): PublicKey | null {
  const value = process.env.NEXT_PUBLIC_DEFAULT_POOL_ADDRESS?.trim()
  if (!value) return null
  return tryParsePublicKey(value)
}

