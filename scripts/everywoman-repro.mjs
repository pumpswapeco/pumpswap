/**
 * READ-ONLY reproduction of the Everywoman pool-creation flow.
 * Usage: pnpm exec node scripts/everywoman-repro.mjs
 *
 * A) Scans recent program transactions for actual CreatePool failures/logs.
 * B) Builds the EXACT transaction lib/solana/ops.ts createPool() would send
 *    (same IDL, same accountsPartial, same token-program detection, same
 *    fresh-blockhash handling) for the Everywoman mints and SIMULATES it
 *    (sigVerify:false) — nothing is signed or sent.
 * Exit code 0 regardless; results are for diagnosis.
 */
import anchorPkg from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, Transaction, clusterApiUrl } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { BorshAccountsCoder, BN, Program, AnchorProvider, web3 } = anchorPkg

/* Incremental file log: pipeline buffering can hide progress, so every line is
   appended to a file as soon as it is produced. */
const LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'everywoman-repro-output.txt')
try { fs.writeFileSync(LOG_FILE, `run started ${new Date().toISOString()}\n`) } catch {}
const _log = console.log.bind(console)
console.log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  _log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
}

/**
 * Bounded fetch — the SAME pattern the app applies (lib/solana/transport.ts
 * createRpcTimeoutFetch), with a tighter 15s bound so an unresponsive RPC hop
 * surfaces as a captured error instead of hanging this diagnostic for minutes.
 */
function timeoutFetch(timeoutMs = 15_000, baseFetch = globalThis.fetch) {
  return (input, init) => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`RPC request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const external = init?.signal
    const onAbort = () => controller.abort(external?.reason)
    if (external) {
      external.aborted ? controller.abort(external.reason) : external.addEventListener('abort', onAbort, { once: true })
    }
    return baseFetch(input, { ...init, signal: controller.signal })
      .catch((e) => {
        if (timedOut) throw new Error(`RPC request timed out after ${timeoutMs}ms`)
        throw e
      })
      .finally(() => {
        clearTimeout(timer)
        external?.removeEventListener('abort', onAbort)
      })
  }
}
const boundedFetch = timeoutFetch(15_000)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

function loadRpcUrl() {
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').match(/^SOLANA_RPC_URL=(.+)$/m)
    if (m) return m[1].trim()
  } catch {}
  return clusterApiUrl('devnet')
}

const RPC = loadRpcUrl()
const connection = new Connection(RPC, { commitment: 'confirmed', fetch: boundedFetch, disableRetryOnRateLimit: false })

const IDL = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'solana', 'idl', 'pumpswap_staking.json'), 'utf8'))
const PROGRAM_ID = new PublicKey(IDL.address)
const DEFAULT_POOL = new PublicKey('Gi94NEwd5F85wWZCy2REdCn3kpQbKpiewvsBCLAGqEpZ')
const STAKING_MINT = new PublicKey('EUudw8Fg5qALMLgFGE5sgSSsUkmQ5nPV3v2GEke9MUYZ') // Every Woman (WOMAN)
const REWARD_MINT = new PublicKey('FwDWHAdw8y7pYw5VFUVNiE1ZMr9UK7w5rMHx7pL5YS4Q') // REW Woman (RWM)

/** One getAccountInfo with full cause-chain capture (no masking). */
async function probeOne(conn, pk, label) {
  try {
    const info = await conn.getAccountInfo(pk, 'confirmed')
    return { ok: true, exists: !!info }
  } catch (e) {
    let cause = e.cause
    let chain = []
    while (cause) {
      chain.push(`${cause.constructor?.name ?? ''}(${cause.code ?? ''}): ${cause.message ?? cause}`)
      cause = cause.cause
    }
    console.log(`  FAIL [${label}] ${e.message}${chain.length ? ' || cause: ' + chain.join(' <- ') : ''}`)
    return { ok: false }
  }
}

/* ---- transient network failures are the phenomenon under test; retry ONLY
   in this diagnostic so a flaky hop cannot abort the run mid-way ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function withRetry(fn, attempts = 3, delayMs = 400) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) await sleep(delayMs * (i + 1))
    }
  }
  throw lastErr
}

/* ---- flakiness probe: N sequential identical calls, two endpoints --------- */
console.log('\n=== 0) RPC flakiness probe (identical getAccountInfo x15 each) ===')
const N = 15
for (const [name, conn] of [
  ['helius', connection],
  ['public devnet', new Connection(clusterApiUrl('devnet'), { commitment: 'confirmed', fetch: boundedFetch })],
]) {
  const results = []
  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    const r = await probeOne(conn, STAKING_MINT, `${name} #${i + 1}`)
    results.push(r.ok)
  }
  const fails = results.filter((x) => !x).length
  console.log(`  ${name}: ${fails}/${N} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}


console.log('RPC:', RPC.replace(/api-key=[^&\s]+/, 'api-key=***'))
console.log('program:', PROGRAM_ID.toBase58())

/* ---------------- Part A: recent on-chain CreatePool evidence ------------- */
console.log('\n=== A) recent program transactions (limit 25) ===')
try {
  const sigs = await withRetry(() => connection.getSignaturesForAddress(PROGRAM_ID, { limit: 25 }))
  let shown = 0
  for (const s of sigs) {
    const tx = await withRetry(() => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }))
    if (!tx || !tx.meta) continue
    const logs = tx.meta.logMessages ?? []
    const isCreate = logs.some((l) => /Instruction:\s*(CreatePool|create_pool)/i.test(l))
    if (!isCreate && !tx.meta.err) continue
    if (!isCreate && tx.meta.err) continue
    console.log(
      `  ${new Date(tx.blockTime * 1000).toISOString()} sig=${s.signature} err=${JSON.stringify(tx.meta.err)} createPool=${isCreate}`,
    )
    if (tx.meta.err) for (const l of logs) console.log('    ' + l)
    shown++
    if (shown >= 10) break
  }
  if (shown === 0) console.log('  no CreatePool transactions (success or failure) in the last 25 program txs')
} catch (e) {
  console.log('  scan failed:', e.message)
}

/* ---------------- Part B: build + simulate the exact createPool tx -------- */
// Mirrors lib/solana/ops.ts createPool() faithfully:
//  1. platformExists check (platform IS initialized on devnet -> no prepend)
//  2. resolveMintTokenProgram for BOTH mints (owner read from chain)
//  3. .createPool(poolId, lockDuration, rewardRate).accountsPartial({authority,
//     stakingMint, rewardMint, stakingTokenProgram, rewardTokenProgram})
//  4. fresh blockhash pinned right before (simulated) signing
async function buildAndSimulate(label, authority) {
  console.log(`\n=== B) simulate createPool [${label}] authority=${authority.toBase58()} ===`)

  // token-program detection, exactly like resolveMintTokenProgram()
  const detect = async (mint, name) => {
    const info = await withRetry(() => connection.getAccountInfo(mint, 'confirmed'))
    if (!info) throw new Error(`${name}: Could not find account`)
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error(`${name}: Account is not an SPL Token mint`)
    }
    console.log(`  ${name} mint owner: ${info.owner.toBase58()}`)
    return info.owner
  }
  const [stakingTokenProgram, rewardTokenProgram] = await Promise.all([
    detect(STAKING_MINT, 'staking'),
    detect(REWARD_MINT, 'reward'),
  ])

  const wallet = { publicKey: authority, signTransaction: async (t) => t, signAllTransactions: async (t) => t }
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' })
  const program = new Program(IDL, provider)

  // platform state, exactly like platformExists()
  const [platformPda] = PublicKey.findProgramAddressSync([Buffer.from('platform')], PROGRAM_ID)
  const platformInfo = await withRetry(() => connection.getAccountInfo(platformPda, 'confirmed'))
  console.log('  platform initialized:', platformInfo !== null, '(initialize_platform prepend:', platformInfo ? 'NO' : 'YES' + ')')

  // wizard inputs: poolId = Date.now(), lock = 0, rewardPerDay = 1 -> base units/s
  const poolId = new BN(Date.now())
  const lockDurationSeconds = new BN(0)
  const rewardRatePerSecond = new BN(Math.max(1, Math.round((1 * Math.pow(10, 9)) / 86400)))

  const [poolAddress] = PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from(poolId.toArrayLike(Buffer, 'le', 8))],
    PROGRAM_ID,
  )
  console.log('  poolId:', poolId.toString(), ' predicted pool PDA:', poolAddress.toBase58())
  const existingPool = await withRetry(() => connection.getAccountInfo(poolAddress, 'confirmed'))
  console.log('  pool PDA already exists:', existingPool !== null)

  const tx = new Transaction()
  tx.add(
    await program.methods
      .createPool(poolId, lockDurationSeconds, rewardRatePerSecond)
      .accountsPartial({
        authority,
        stakingMint: STAKING_MINT,
        rewardMint: REWARD_MINT,
        stakingTokenProgram,
        rewardTokenProgram,
      })
      .instruction(),
  )
  tx.feePayer = authority
  const { blockhash } = await withRetry(() => connection.getLatestBlockhash('confirmed'))
  tx.recentBlockhash = blockhash

  console.log('  instruction account keys:')
  for (const k of tx.instructions[0].keys) {
    console.log(`    ${k.pubkey.toBase58()} signer=${k.isSigner} writable=${k.writable}`)
  }

  // web3.js 1.98 Transaction overload: second arg must be a signers ARRAY (not
  // an options object). No signers => it fetches a fresh blockhash itself and
  // serializes unsigned; RPC simulateTransaction verifies signatures OFF by
  // default (sigVerify defaults to false), exactly like preflight-without-send.
  const sim = await withRetry(() => connection.simulateTransaction(tx))
  console.log('  SIMULATION err:', JSON.stringify(sim.value.err))
  console.log('  SIMULATION logs:')
  for (const l of sim.value.logs ?? []) console.log('    ' + l)
  if (sim.value.err) {
    console.log('  >>> REPRODUCED FAILURE (simulation) — see err/logs above')
  } else {
    console.log('  >>> simulation SUCCEEDED — on-chain path is valid for these mints')
  }
  return sim.value.err
}

// Authority taken from the project's DEFAULT pool account (the working pool's
// authority — i.e. the real founder wallet), decoded via the real IDL coder.
let authority = null
try {
  const poolInfo = await withRetry(() => connection.getAccountInfo(DEFAULT_POOL, 'confirmed'))
  if (poolInfo) {
    const coder = new BorshAccountsCoder(IDL)
    const decoded = coder.decode('Pool', poolInfo.data)
    authority = decoded.authority
    console.log('\ndefault pool authority (decoded via IDL):', authority.toBase58())
    const bal = await connection.getBalance(authority, 'confirmed')
    console.log('authority SOL balance:', (bal / web3.LAMPORTS_PER_SOL).toFixed(4))
  }
} catch (e) {
  console.log('default pool decode failed, falling back to bytes 8..40:', e.message)
  try {
    const poolInfo = await connection.getAccountInfo(DEFAULT_POOL, 'confirmed')
    authority = new PublicKey(poolInfo.data.subarray(8, 40))
    console.log('authority (raw offset):', authority.toBase58())
  } catch {}
}

const errs = []
if (authority) errs.push(await buildAndSimulate('default-pool authority', authority))
errs.push(await buildAndSimulate('fresh random keypair (control)', Keypair.generate().publicKey))

console.log('\n=== SUMMARY ===')
console.log('simulation failures:', errs.filter(Boolean).length, 'of', errs.length)

