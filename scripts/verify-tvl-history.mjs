// Mirrors lib/solana/use-pool-tvl-history.ts: reconstruct the pool's TVL over
// time from REAL on-chain Stake/Unstake transactions (paginated signature
// history + base58 instruction parsing) and cross-check the final running
// total against the pool account's on-chain totalStaked.
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire(import.meta.url)
const { Connection, PublicKey } = require('@solana/web3.js')
const { Program, AnchorProvider } = require('@coral-xyz/anchor')

const PROGRAM_ID = 'BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs'
const POOL = '7f7Q78AY7BooQCJRg4ZEeT8uwZb6jNCBszFiTPP5rdxw'

let RPC = 'https://api.devnet.solana.com'
try {
  for (const l of fs.readFileSync('C:/Users/olhad/pumpswap/.env.local', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*NEXT_PUBLIC_SOLANA_RPC_URL\s*=\s*(.+?)\s*$/)
    if (m) RPC = m[1]
  }
} catch {}

const out = 'C:/Users/olhad/pumpswap/scripts/verify-tvl-out.txt'
const log = (...a) => fs.appendFileSync(out, a.join(' ') + '\n', 'utf8')
fs.writeFileSync(out, `RPC: ${RPC}\nPool: ${POOL}\n`, 'utf8')

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Decode(input) {
  const bytes = [0n]
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char)
    if (value < 0) throw new Error('invalid base58 char: ' + char)
    let carry = BigInt(value)
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58n
      bytes[j] = carry & 0xffn
      carry >>= 8n
    }
    while (carry > 0n) { bytes.push(carry & 0xffn); carry >>= 8n }
  }
  for (let i = 0; i < input.length && input[i] === '1'; i++) bytes.push(0n)
  bytes.reverse()
  return new Uint8Array(bytes.map(Number))
}
function u64Le(bytes, offset) {
  let v = 0n
  for (let i = offset + 7; i >= offset; i--) v = (v << 8n) | BigInt(bytes[i])
  return v
}
function actionFromLogs(logs) {
  for (const line of logs || []) {
    if (line.includes('Instruction: Unstake')) return 'Unstake'
    if (line.includes('Instruction: Stake')) return 'Stake'
  }
  return null
}
function programIdOf(ix, keys) {
  if (typeof ix.programId === 'string') return ix.programId
  if (typeof ix.programIdIndex === 'number') return keys[ix.programIdIndex]
  return null
}

const connection = new Connection(RPC, 'confirmed')

// Paginated signature history (same as the hook: limit 100, oldest via before).
const signatures = []
let before
for (let page = 0; page < 5; page++) {
  const batch = await connection.getSignaturesForAddress(new PublicKey(PROGRAM_ID), { limit: 100, before })
  signatures.push(...batch)
  if (batch.length < 100) break
  before = batch[batch.length - 1].signature
}
log(`Signatures fetched (paginated): ${signatures.length}`)

const events = []
for (const s of signatures) {
  let tx
  try {
    tx = await connection.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  } catch { continue }
  if (!tx || !tx.transaction) continue
  const msg = tx.transaction.message
  const keys = msg.accountKeys.map((k) => String(k).replace(/["'\s]/g, ''))

  for (const ix of msg.instructions) {
    if (programIdOf(ix, keys) !== PROGRAM_ID) continue
    const acct = ix.accounts || []
    if (keys[acct[1]] !== POOL) continue
    let bytes
    try { bytes = base58Decode(ix.data) } catch { continue }
    const action = actionFromLogs(tx.meta?.logMessages)
    if ((action !== 'Stake' && action !== 'Unstake') || bytes.length < 16) continue
    events.push({ signature: s.signature, action, amount: u64Le(bytes, 8), slot: s.slot, blockTime: s.blockTime })
    break
  }
}

events.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))

const fmtTokens = (base) => (Number(base) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })

log('')
log('Chronological TVL events:')
let running = 0n
const points = []
for (const e of events) {
  const delta = e.action === 'Stake' ? e.amount : -e.amount
  running += delta
  points.push({ ...e, tvl: running })
  log(`  ${e.action.padEnd(8)} ${e.signature.slice(0, 12)}…  delta ${fmtTokens(delta)}  →  TVL ${fmtTokens(running)}  @ slot ${e.slot}  (${e.blockTime ? new Date(e.blockTime * 1000).toISOString() : 'n/a'})`)
}

log('')
log(`Reconstructed final TVL : ${fmtTokens(running)} tokens`)

// Cross-check against the on-chain pool account totalStaked.
const idl = JSON.parse(fs.readFileSync('C:/Users/olhad/pumpswap/lib/solana/idl/pumpswap_staking.json', 'utf8'))
const dummy = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }
const provider = new AnchorProvider(connection, dummy, { commitment: 'confirmed' })
const program = new Program(idl, provider)
const pool = await program.account.pool.fetch(new PublicKey(POOL))
log(`On-chain totalStaked    : ${fmtTokens(pool.totalStaked)} tokens (from pool account)`)
log(`Cross-check             : ${BigInt(pool.totalStaked.toString()) === running ? 'MATCH ✓' : `MISMATCH (delta ${BigInt(pool.totalStaked.toString()) - running})`}`)