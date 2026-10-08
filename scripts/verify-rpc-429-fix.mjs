// POST-FIX VERIFICATION: exercises the EXACT current app-side RPC read path
// (lib/solana/program-transactions.ts loadRecentProgramTransactions) used by
// TVL History + On-Chain Activity against the RPC configured in .env.local:
//   getLatestBlockhash                          -> health check (createBrowserConnection)
//   getSignaturesForAddress(STAKING_PROGRAM_ID, limit 100)
//   per-signature getTransaction(commitment: confirmed, version 0)
//       with a bounded 6-worker concurrency    -> replaces the ONE batched
//          getTransactions call that froze on HTTP 429 (public devnet) and
//          HTTP 403/413 (Helius free tier rejects JSON-RPC batch arrays;
//          confirmed 2026-09-21 with raw JSON-RPC probes).
// Then re-runs the pool account read (totalStaked) used by pool stats.
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire(import.meta.url)
const { Connection, PublicKey } = require('@solana/web3.js')
const { AnchorProvider, Program } = require('@coral-xyz/anchor')

const PROGRAM_ID = 'BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs'
const POOL = '7f7Q78AY7BooQCJRg4ZEeT8uwZb6jNCBszFiTPP5rdxw'
const CONCURRENCY = 6 // must match lib/solana/program-transactions.ts

let RPC = null
for (const l of fs.readFileSync('C:/Users/olhad/pumpswap/.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*NEXT_PUBLIC_SOLANA_RPC_URL\s*=\s*(.+?)\s*$/)
  if (m) RPC = m[1]
}
if (!RPC) { console.error('No RPC in .env.local'); process.exit(1) }

const out = 'C:/Users/olhad/pumpswap/scripts/verify-rpc-429-fix-out.txt'
const log = (...a) => fs.appendFileSync(out, a.join(' ') + '\n', 'utf8')
fs.writeFileSync(
  out,
  `RPC: ${RPC}\nProgram: ${PROGRAM_ID}\nPool: ${POOL}\n` +
    `Path: getSignaturesForAddress(limit 100) + per-signature getTransaction (concurrency ${CONCURRENCY})\n`,
  'utf8',
)

const connection = new Connection(RPC, { commitment: 'confirmed', disableRetryOnRateLimit: false })

// 1) getLatestBlockhash (createBrowserConnection health check)
try {
  const bh = await connection.getLatestBlockhash('confirmed')
  log(`getLatestBlockhash: OK blockhash=${String(bh.blockhash).slice(0, 16)}...`)
} catch (e) { log(`getLatestBlockhash: FAILED ${e.name}: ${e.message}`); }

// 2) getSignaturesForAddress for the staking program
let signatures = []
try {
  signatures = await connection.getSignaturesForAddress(new PublicKey(PROGRAM_ID), { limit: 100 })
  log(`getSignaturesForAddress: OK count=${signatures.length}`)
} catch (e) { log(`getSignaturesForAddress: FAILED ${e.name}: ${e.message}`); }

// 3) Per-signature getTransaction with bounded concurrency - the EXACT pattern
//    of loadRecentProgramTransactions. Any rejection propagates (no retry loop)
//    and is logged truthfully, exactly like the app surfaces it.
if (signatures.length > 0) {
  const txs = new Array(signatures.length)
  let next = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, signatures.length) }, async () => {
    while (next < signatures.length) {
      const i = next++
      txs[i] = await connection.getTransaction(signatures[i].signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
    }
  })
  try {
    await Promise.all(workers)
    const present = txs.filter((t) => t && t.transaction).length
    log(`getTransaction (single, concurrency ${CONCURRENCY}): OK fetched=${txs.length} present=${present}`)
  } catch (e) {
    log(`getTransaction (single, concurrency ${CONCURRENCY}): FAILED ${e.name}: ${String(e.message).split('\n')[0]}`)
  }
}

// 4) Pool account read (totalStaked) via Anchor Program - used by pool stats.
//    The on-chain value is the source of truth (it grew across test runs), so
//    no stale constant is asserted.
try {
  const idl = JSON.parse(fs.readFileSync('C:/Users/olhad/pumpswap/lib/solana/idl/pumpswap_staking.json', 'utf8'))
  const dummy = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }
  const provider = new AnchorProvider(connection, dummy, { commitment: 'confirmed' })
  const program = new Program(idl, provider)
  const pool = await program.account.pool.fetch(new PublicKey(POOL))
  log(`pool.fetch(${POOL.slice(0, 8)}...): OK totalStaked=${pool.totalStaked.toString()}`)
} catch (e) { log(`pool.fetch: FAILED ${e.name}: ${e.message}`); }

log('DONE')
process.exit(0)