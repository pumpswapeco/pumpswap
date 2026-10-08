import { PublicKey } from '@solana/web3.js'

export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address
  return `${address.slice(0, chars)}...${address.slice(-chars)}`
}

export function formatSolBalance(lamports: number): string {
  const sol = lamports / 1_000_000_000
  if (sol === 0) return '0 SOL'
  if (sol < 0.0001) return '<0.0001 SOL'
  return `${sol.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`
}

export function tryParsePublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value.trim())
  } catch {
    return null
  }
}

/**
 * Copy arbitrary text to the system clipboard.
 *
 * Uses the modern async Clipboard API when available and falls back to the
 * legacy execCommand path for browsers/sandboxes where it is missing. Callers
 * should always pass the FULL underlying string (e.g. the complete base58
 * PublicKey) — never a shortened display form.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path below (e.g. permission denied).
  }

  try {
    if (typeof document !== "undefined") {
      const el = document.createElement("textarea")
      el.value = text
      el.setAttribute("readonly", "")
      el.style.position = "fixed"
      el.style.opacity = "0"
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand("copy")
      document.body.removeChild(el)
      return ok
    }
  } catch {
    // Clipboard unavailable in this context.
  }

  return false
}
