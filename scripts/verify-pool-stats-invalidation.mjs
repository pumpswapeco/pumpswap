// Simulates the exact store algorithm in lib/solana/use-pool-stats.ts
// (epoch + forceReload) to prove the admin-mutation invalidation race is fixed:
// a stale in-flight fetch that resolves AFTER invalidatePoolStats() can no
// longer overwrite the post-mutation snapshot.
const TTL = 30000

// --- module store ------------------------------------------------------------------
const store = {
  snapshot: { loading: true, pools: [], error: null },
  snapshotConnection: null,
  snapshotUpdatedAt: 0,
  inFlight: null,
  loadEpoch: 0,
  forceReload: false,
  lastProgram: null,
  fetchImpl: null,
}

function emit() {} // no-op in the simulation; snapshot writes are what we assert

async function loadPoolStats(program, connection, fetchImpl) {
  store.lastProgram = program
  store.fetchImpl = fetchImpl
  if (store.inFlight && !store.forceReload) return store.inFlight

  const cacheFresh =
    store.snapshotConnection === connection &&
    Date.now() - store.snapshotUpdatedAt < TTL
  if (cacheFresh && !store.forceReload) return

  store.forceReload = false

  if (store.snapshotConnection !== connection) {
    store.snapshotConnection = connection
    store.snapshot = { loading: true, pools: [], error: null }
  } else {
    store.snapshot = { ...store.snapshot, loading: true, error: null }
  }

  const epoch = ++store.loadEpoch
  store.inFlight = (async () => {
    try {
      const pools = await fetchImpl()
      if (epoch !== store.loadEpoch) return
      store.snapshot = { loading: false, pools, error: null }
      store.snapshotUpdatedAt = Date.now()
    } finally {
      if (epoch === store.loadEpoch) {
        store.inFlight = null
        emit()
      }
    }
  })()

  return store.inFlight
}

function invalidatePoolStats() {
  store.snapshotUpdatedAt = 0
  store.forceReload = true
  if (store.lastProgram && store.snapshotConnection) {
    void loadPoolStats(store.lastProgram, store.snapshotConnection, store.fetchImpl)
  }
}

// fetch simulator: returns a promise that resolves with the given payload after a delay
const simulateFetch = ({ payload, delayMs }) =>
  new Promise((resolve) => setTimeout(() => resolve(payload), delayMs))

let failures = 0
function assert(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}`)
  if (!condition) failures++
}

async function run() {
  const cnx = "shared-connection"

  // ---- Scenario 1: the regression -------------------------------------------
  // A page loads (pre-pause) -> fetch #1 starts and is SLOW (in flight while the
  // admin signs).
  let resolve1
  const fetch1 = new Promise((r) => (resolve1 = r)) // never resolves until we say so
  const p1 = loadPoolStats("program", cnx, () => fetch1)
  const inflight1 = store.inFlight
  assert("fetch #1 is in flight after initial load", inflight1 !== null)

  // The pause transaction confirms while fetch #1 (pre-mutation, 'Active') is
  // still in flight. Admin invalidation must force a fresh read.
  let resolve2
  const fetch2 = new Promise((r) => (resolve2 = r))
  store.fetchImpl = () => fetch2
  invalidatePoolStats()
  const p2 = store.inFlight
  assert("invalidatePoolStats started a SECOND fetch (did not join stale one)", p2 !== p1)

  // The fresh (post-pause) fetch resolves first with paused=true.
  resolve2(["PAUSED"])
  await p2
  assert("post-mutation snapshot shows PAUSED", store.snapshot.pools[0] === "PAUSED")

  // NOW the STALE pre-mutation fetch resolves (late) with Active.
  resolve1(["ACTIVE"])
  await new Promise((r) => setTimeout(r, 10))
  assert(
    "stale in-flight (Active) result did NOT overwrite the paused snapshot",
    store.snapshot.pools[0] === "PAUSED",
  )

  // ---- Scenario 2: normal dedup still works ---------------------------------
  store.inFlight = null
  store.snapshotUpdatedAt = 0 // expire cache so both calls actually fetch
  let calls = 0
  const slow = () => new Promise((r) => setTimeout(() => { calls++; r(["X"]) }, 20))
  await Promise.all([
    loadPoolStats("program", cnx, slow),
    loadPoolStats("program", cnx, slow),
  ])
  assert("two concurrent loads share ONE fetch (dedup preserved)", calls === 1)

  // ---- Scenario 3: TTL cache hit returns without a fetch --------------------
  const callsBefore = calls
  await loadPoolStats("program", cnx, slow)
  assert("load within TTL reuses the cached snapshot without a new fetch", calls === callsBefore)

  // ---- Scenario 4: invalidate then normal load (no in-flight) ----------------
  store.snapshotUpdatedAt = 0 // expire TTL like invalidate does
  let callsNow = calls
  await loadPoolStats("program", cnx, slow)
  assert("expired TTL triggers one fresh fetch", calls === callsNow + 1)

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error("SIMULATION ERROR", e)
  process.exit(1)
})