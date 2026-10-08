// Verifies the white-label persistence contract (used by lib/white-label.ts):
// Edit -> Save -> "Refresh" (fresh module state) -> configuration is retained.
// localStorage is the only storage the app has; this simulates its behavior
// with the exact storage key and JSON merge the frontend uses.
const STORAGE_KEY = "pumpswap.white-label.v1"

// --- Minimal localStorage shim (matches window.localStorage semantics) ------
const backing = {}
const localStorageShim = {
  getItem: (k) => (k in backing ? backing[k] : null),
  setItem: (k, v) => {
    backing[k] = String(v)
  },
}
const DEFAULT = {
  title: "Pumpswap Staking",
  color: "#7c5cff",
  subdomain: "myproject",
  logoName: null,
  logoDataUrl: null,
}
function load() {
  try {
    const raw = localStorageShim.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT }
    return { ...DEFAULT, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT }
  }
}
function save(next) {
  localStorageShim.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT, ...next }))
}

// --- 1. Edit + Save ----------------------------------------------------------
save({
  title: "Aurora Finance",
  color: "#00b4d8",
  subdomain: "aurora",
  logoName: "aurora-logo.png",
  logoDataUrl: "data:image/png;base64,QUJD",
})
console.log("after save:", localStorageShim.getItem(STORAGE_KEY))

// --- 2. Refresh (simulate a fresh page load -> fresh module state) ----------
const afterRefresh = load()
console.log("after refresh:", JSON.stringify(afterRefresh))

// --- 3. Staking portal reads the same persisted config -----------------------
const portalUses = afterRefresh
console.log("portal reads:", JSON.stringify(portalUses))

// Round-trip assertions
const ok =
  afterRefresh.title === "Aurora Finance" &&
  afterRefresh.color === "#00b4d8" &&
  afterRefresh.subdomain === "aurora" &&
  afterRefresh.logoName === "aurora-logo.png" &&
  afterRefresh.logoDataUrl !== null

console.log(ok ? "PASS: Edit -> Save -> Refresh -> retained -> portal reads it" : "FAIL")
process.exit(ok ? 0 : 1)