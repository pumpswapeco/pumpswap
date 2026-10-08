"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"

import { copyTextToClipboard } from "@/lib/solana/format"

const COPIED_RESET_MS = 1500

/**
 * Small copy control for displayed Solana addresses.
 *
 * IMPORTANT: `value` must always be the FULL underlying address/key — never a
 * truncated display form. The shortened text shown next to this button is
 * display-only; this control always writes the complete `value` to the
 * clipboard so users can save the whole address.
 */
export function CopyAddress({
  value,
  label = "address",
  className,
}: {
  /** Full address/string to copy — never a shortened display form. */
  value: string
  /** What this button copies, used for the accessible label/tooltip. */
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  const handleCopy = async () => {
    if (!value) return
    const ok = await copyTextToClipboard(value)
    if (!ok) return
    setCopied(true)
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS)
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      disabled={!value}
      aria-label={copied ? "Copied to clipboard" : `Copy ${label}`}
      title={copied ? "Copied to clipboard" : `Copy ${label}`}
      className={`flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-1 text-xs transition-colors hover:bg-muted ${
        copied ? "border-accent/40 bg-accent/10 text-accent" : ""
      } ${className ?? ""}`}
    >
      {copied ? (
        <>
          <Check className="size-3.5 shrink-0 text-accent" aria-hidden />
          <span>Copied</span>
        </>
      ) : (
        <Copy className="size-3.5 shrink-0" aria-hidden />
      )}
    </button>
  )
}