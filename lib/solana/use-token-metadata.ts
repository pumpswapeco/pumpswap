"use client"

import { useEffect, useRef, useState } from "react"

import { tryParsePublicKey } from "@/lib/solana/format"
import { resolveTokenMeta } from "@/lib/solana/metadata"

export interface TokenMetadataInfo {
  /** On-chain Metaplex name (trimmed). */
  name: string
  /** On-chain Metaplex symbol (trimmed). */
  symbol: string
  /** Resolved off-chain image/logo URI, when available. */
  image?: string
}

export interface TokenMetadataState {
  loading: boolean
  /** Detected metadata for the current mint value, or null when unavailable. */
  metadata: TokenMetadataInfo | null
  /** True when the mint is a valid public key but no usable metadata was found. */
  notFound: boolean
  /** The trimmed mint address currently being looked up / displayed. */
  mint: string | null
}


/**
 * Dynamically detect SPL token metadata for ANY mint address the user types.
 *
 * - Validates the address before hitting the network (debounced, so we don't
 *   fetch on every keystroke).
 * - Reads the Metaplex metadata PDA on-chain via Umi, then the off-chain JSON.
 * - Clears stale results immediately when the mint value changes so a previous
 *   token's metadata is never shown for a new address.
 * - Never throws: every failure surfaces as `notFound` (non-blocking).
 */
export function useTokenMetadata(mintValue: string): TokenMetadataState {
  const [state, setState] = useState<TokenMetadataState>({
    loading: false,
    metadata: null,
    notFound: false,
    mint: null,
  })
  // Bumped on every value change; lets async work detect it became stale.
  const requestRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestRef.current

    // Reset synchronously so old metadata is never shown for the new input.
    setState({ loading: false, metadata: null, notFound: false, mint: null })

    const mintKey = tryParsePublicKey(mintValue)
    if (!mintKey) {
      // Not a valid public key (includes empty input): nothing to look up.
      return
    }
    const trimmed = mintValue.trim()

    const timer = setTimeout(() => {
      void (async () => {
        setState({ loading: true, metadata: null, notFound: false, mint: trimmed })
        try {
          // Shared cached resolver (single Umi client + TTL) -> metadata for
          // this mint is fetched once app-wide and reused by pool stats/pools.
          const meta = await resolveTokenMeta(mintKey).catch(() => null)

          if (requestRef.current !== requestId) return

          if (!meta) {
            setState({ loading: false, metadata: null, notFound: true, mint: trimmed })
            return
          }

          if (requestRef.current !== requestId) return
          setState({
            loading: false,
            metadata: { name: meta.name, symbol: meta.symbol, image: meta.image },
            notFound: false,
            mint: trimmed,
          })
        } catch {
          if (requestRef.current !== requestId) return
          setState({ loading: false, metadata: null, notFound: true, mint: trimmed })
        }
      })()
    }, 500)

    return () => {
      clearTimeout(timer)
    }
  }, [mintValue])

  return state
}
