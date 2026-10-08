"use client"

import { useEffect, useState } from "react"
import { Upload, Sparkles, ExternalLink, Check, Loader2, Wallet } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { usePoolOptional } from "@/lib/pool-context"
import {
  loadWhiteLabelConfig,
  resetWhiteLabelConfig,
  saveWhiteLabelConfig,
} from "@/lib/white-label"

export function WhiteLabelEditor() {
  const { poolAddress } = usePoolOptional() ?? { poolAddress: null }
  // White-label branding is POOL-SCOPED: the editor writes the config for the
  // currently selected pool (keyed by the pool address), so changing one
  // pool's logo/color never affects another pool's branding.
  const poolKey = poolAddress ? poolAddress.toBase58() : null
  const [title, setTitle] = useState("Pumpswap Staking")
  const [color, setColor] = useState("#7c5cff")
  const [subdomain, setSubdomain] = useState("myproject")
  const [logoName, setLogoName] = useState<string | null>(null)
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [saved, setSaved] = useState(false)

  // Reopen with the previously saved configuration for the selected pool
  // (persisted in localStorage under pumpswap.white-label.v1.<pool>).
  useEffect(() => {
    if (!poolKey) return
    const persisted = loadWhiteLabelConfig(poolKey)
    setTitle(persisted.title)
    setColor(persisted.color)
    setSubdomain(persisted.subdomain)
    setLogoName(persisted.logoName)
    setLogoDataUrl(persisted.logoDataUrl)
  }, [poolKey])

  const domain = `${subdomain || "stakingsas"}.liquidpump.app`

  function handleFile(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setLogoName(file.name)
    // Persist the actual image (as a data URL) so it survives a page refresh
    // without needing a backend to upload to.
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") setLogoDataUrl(reader.result)
    }
    reader.readAsDataURL(file)
  }

  function save() {
    if (!poolKey) return
    saveWhiteLabelConfig(poolKey, {
      title: title.trim() || "Pumpswap Staking",
      color,
      subdomain: subdomain.toLowerCase(),
      logoName,
      logoDataUrl,
    })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2000)
  }

  function restoreDefaults() {
    if (!poolKey) return
    resetWhiteLabelConfig(poolKey)
    setTitle("Pumpswap Staking")
    setColor("#7c5cff")
    setSubdomain("myproject")
    setLogoName(null)
    setLogoDataUrl(null)
  }

  function generate() {
    setGenerating(true)
    setGenerated(false)
    setTimeout(() => {
      setGenerating(false)
      setGenerated(true)
    }, 1400)
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* Config */}
      <Card className="flex flex-col gap-5 p-6 lg:col-span-3">
        {!poolKey && (
          <div
            role="status"
            className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground"
          >
            Select a pool on the /pools page before editing its white-label
            branding. Branding is per pool: each pool keeps its own logo, brand
            color, title and subdomain.
          </div>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="brand-title">Brand Title</Label>
          <Input id="brand-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Your project name" disabled={!poolKey} />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Brand Logo</Label>
          <label
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              handleFile(e.dataTransfer.files)
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors ${
              dragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
            }`}
          >
            <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFile(e.target.files)} />
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
              {logoName ? <Check className="size-5 text-accent" /> : <Upload className="size-5 text-muted-foreground" />}
            </div>
            {logoName ? (
              <span className="text-sm font-medium">{logoName}</span>
            ) : (
              <>
                <span className="text-sm font-medium">Drop your logo here</span>
                <span className="text-xs text-muted-foreground">PNG or SVG, up to 2MB</span>
              </>
            )}
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="brand-color">Primary Brand Color</Label>
          <div className="flex items-center gap-3">
            <div className="relative size-10 overflow-hidden rounded-lg border border-border">
              <input
                id="brand-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="absolute inset-0 size-[150%] -translate-x-[15%] -translate-y-[15%] cursor-pointer border-0 bg-transparent p-0"
              />
            </div>
            <Input
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="max-w-32 font-mono uppercase"
            />
            <div className="h-10 flex-1 rounded-lg border border-border" style={{ backgroundColor: color }} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="subdomain">Custom Subdomain</Label>
          <div className="flex items-center overflow-hidden rounded-lg border border-border bg-background focus-within:border-ring">
            <input
              id="subdomain"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value.replace(/[^a-z0-9-]/gi, "").toLowerCase())}
              placeholder="myproject"
              className="w-full bg-transparent px-3 py-2 text-sm outline-none"
            />
            <span className="shrink-0 border-l border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              .liquidpump.app
            </span>
          </div>
          <p className="text-xs text-muted-foreground">Your portal will be available at {domain}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 self-start">
          <Button onClick={save} className="gap-1.5">
            {saved ? (
              <>
                <Check className="size-4" /> Saved
              </>
            ) : (
              <>Save Configuration</>
            )}
          </Button>
          <Button variant="outline" onClick={restoreDefaults} className="gap-1.5">
            Reset to Defaults
          </Button>
          <Button variant="outline" onClick={generate} disabled={generating} className="gap-1.5">
            {generating ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Generating...
              </>
            ) : (
              <>
                <Sparkles className="size-4" /> Generate Preview
              </>
            )}
          </Button>
        </div>
      </Card>

      {/* Preview */}
      <div className="lg:col-span-2">
        <div className="mb-3 text-sm font-medium text-muted-foreground">Live Preview</div>
        <Card className="overflow-hidden p-0">
          <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-2">
            <span className="size-2.5 rounded-full bg-muted-foreground/30" />
            <span className="size-2.5 rounded-full bg-muted-foreground/30" />
            <span className="size-2.5 rounded-full bg-muted-foreground/30" />
            <span className="ml-2 truncate font-mono text-xs text-muted-foreground">{domain}</span>
          </div>
          <div className="p-5">
            <div className="flex items-center gap-2.5">
              {logoDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoDataUrl}
                  alt={`${title} logo`}
                  className="size-9 shrink-0 rounded-lg border border-border object-cover"
                />
              ) : (
                <div className="flex size-9 items-center justify-center rounded-lg" style={{ backgroundColor: color }}>
                  <Wallet className="size-5 text-white" aria-hidden />
                </div>
              )}
              <span className="font-semibold">{title || "Your Brand"}</span>
            </div>
            <div className="mt-4 rounded-lg border border-border p-4">
              <div className="text-xs text-muted-foreground">Your staking portal</div>
              <div className="mt-2 text-2xl font-semibold" style={{ color }}>
                Stake &amp; Earn
              </div>
              <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-2/3 rounded-full" style={{ backgroundColor: color }} />
              </div>
              <button
                className="mt-4 w-full rounded-lg py-2 text-sm font-medium text-white"
                style={{ backgroundColor: color }}
              >
                Connect Wallet
              </button>
            </div>
          </div>
        </Card>

        {generated && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/10 p-3">
            <div className="flex items-center gap-2 text-sm">
              <Check className="size-4 text-accent" />
              <span>Preview is live</span>
            </div>
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              {domain} <ExternalLink className="size-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
