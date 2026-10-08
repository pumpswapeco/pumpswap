// Reads the staking program's real on-chain transactions for the wallet+pools
// that were actually used on Devnet and runs the SAME parsing logic as
// lib/solana/use-recent-activity.ts (base58 instruction data, Anchor
// "Instruction:" logs, inner spl-token transfers). Proves the Recent Activity
// feature detects the existing real Stake/Unstake/Claim transactions.
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire(import.meta.url)
const { Connection, PublicKey } = require('@solana/web3.js')

const PROGRAM_ID = 'BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs'
const WALLET = '8sWRCcuQXuR7kfkN2JgFLopEoWdUffUBtxGF1pbKkXgB'
const POOL = '7f7Q78AY7BooQCJRg4ZEeT8uwZb6jNCBszFiTPP5rdxw'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

let RPC = 'https://api.devnet.solana.com'
try {
  for (const l of fs.readFileSync('C:/Users/olhad/pumpswap/.env.local', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*NEXT_PUBLIC_SOLANA_RPC_URL\s*=\s*(.+?)\s*$/)
    if (m) RPC = m[1]
  }
} catch {}

const out = 'C:/Users/olhad/pumpswap/scripts/verify-activity-out.txt'
const log = (...a) => fs.appendFileSync(out, a.join(' ') + '\n', 'utf8')
fs.writeFileSync(out, `RPC: ${RPC}\nWallet: ${WALLET}\nPool: ${POOL}\n`, 'utf8')

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
const DISCRIMINATORS = {
  Stake: [206, 176, 202, 18, 200, 209, 179, 108],
  Unstake: [90, 95, 107, 42, 205, 124, 50, 225],
  Claim: [4, 144, 132, 71, 116, 23, 151, 80],
}
const arrEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
function actionFromLogs(logs) {
  for (const line of logs || []) {
    if (line.includes('Instruction: ClaimRewards')) return 'Claim'
    if (line.includes('Instruction: Unstake')) return 'Unstake'
    if (line.includes('Instruction: Stake')) return 'Stake'
  }
  return null
}
function actionFromDisc(bytes) {
  if (bytes.length < 8) return null
  const head = Array.from(bytes.subarray(0, 8))
  for (const [a, d] of Object.entries(DISCRIMINATORS)) if (arrEq(head, d)) return a
  return null
}
function programIdOf(ix, keys) {
  if (typeof ix.programId === 'string') return ix.programId
  if (typeof ix.programIdIndex === 'number') return keys[ix.programIdIndex]
  return null
}

const connection = new Connection(RPC, 'confirmed')
const signatures = await connection.getSignaturesForAddress(new PublicKey(PROGRAM_ID), { limit: 25 })
log('Program transactions fetched:', signatures.length)

const rows = []
for (const s of signatures) {
  let tx
  try {
    tx = await connection.getTransaction(s.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
  } catch (e) {
    log('getTransaction ERR', s.signature, e.message)
    continue
  }
  if (!tx || !tx.transaction) continue
  const msg = tx.transaction.message
  const keys = msg.accountKeys.map((k) => String(k).replace(/["'\s]/g, ''))

  let action = null
  let amountBase = null
  for (const ix of msg.instructions) {
    if (programIdOf(ix, keys) !== PROGRAM_ID) continue
    const acct = ix.accounts || []
    if (keys[acct[0]] !== WALLET || keys[acct[1]] !== POOL) continue
    let bytes
    try { bytes = base58Decode(ix.data) } catch { continue }
    action = actionFromLogs(tx.meta?.logMessages) || actionFromDisc(bytes)
    if (!action) continue
    if ((action === 'Stake' || action === 'Unstake') && bytes.length >= 16) amountBase = u64Le(bytes, 8)
    break
  }
  if (!action) continue
  if (action === 'Claim') {
    for (const block of tx.meta?.innerInstructions || []) {
      for (const sub of block.instructions || []) {
        if (programIdOf(sub, keys) !== TOKEN_PROGRAM) continue
        try {
          const b = base58Decode(sub.data)
          if (b.length >= 9 && b[0] === 3) { amountBase = u64Le(b, 1); break }
        } catch {}
      }
      if (amountBase !== null) break
    }
  }
  rows.push({ signature: s.signature, action, amountBase, slot: s.slot, blockTime: s.blockTime })
}

rows.sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0))
log('')
log(`Detected staking transactions for wallet ${WALLET} on pool ${POOL}: ${rows.length}`)
for (const r of rows) {
  log('')
  log(`  ACTION    : ${r.action}`)
  log(`  SIGNATURE : ${r.signature}`)
  log(`  AMOUNT    : ${r.amountBase === null ? 'n/a' : BigInt(r.amountBase).toString() + ' base units (' + (Number(r.amountBase) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 }) + ' tokens @ 9 decimals)'}`)
  log(`  SLOT      : ${r.slot}`)
  log(`  BLOCK TIME: ${r.blockTime ? new Date(r.blockTime * 1000).toISOString() : 'n/a'}`)
}