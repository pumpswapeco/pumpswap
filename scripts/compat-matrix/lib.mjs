// Shared helpers for the Token-program compatibility matrix.
// Mirrors lib/solana/{token,pda}.ts on the client side: the token program is
// always DETECTED from the mint account owner, never assumed.
import fs from 'node:fs'
import { createRequire } from 'node:module'

export const ROOT = 'C:/Users/olhad/pumpswap'
const require = createRequire(`${ROOT}/package.json`)
const anchor = require('@coral-xyz/anchor')
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js')
const spl = require('@solana/spl-token')

export const BN = anchor.BN
export const PROGRAM = new PublicKey('BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs')
export const TOKEN = spl.TOKEN_PROGRAM_ID            // TokenkegQfeZyi...
export const T22 = spl.TOKEN_2022_PROGRAM_ID          // TokenzQdBNbLqP5...
export const ATA_PROGRAM = spl.ASSOCIATED_TOKEN_PROGRAM_ID

export const rpcUrl = (() => {
  for (const line of fs.readFileSync(`${ROOT}/.env.local`, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*SOLANA_RPC_URL\s*=\s*(.+?)\s*$/)
    if (m) return m[1]
  }
  return 'https://api.devnet.solana.com'
})()

export const conn = new Connection(rpcUrl, 'confirmed', { commitment: 'confirmed' })

/**
 * Wraps an RPC call with bounded retries. The devnet RPC intermittently drops
 * connections ("fetch failed"); without this a whole matrix run aborts on a
 * transient blip instead of the actual on-chain result.
 */
export async function rpcRetry(fn, label = 'rpc', attempts = 5) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|429|Too Many Requests|network/i.test(msg)
      if (!transient || i === attempts - 1) throw e
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
  throw lastErr
}

// The real devnet authority wallet (same keypair the working pools use).
export const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync('C:/Users/olhad/.config/solana/id.json', 'utf8'))),
)
export const AUTH = authority.publicKey

const idl = JSON.parse(fs.readFileSync(`${ROOT}/lib/solana/idl/pumpswap_staking.json`, 'utf8'))
if (idl.address !== PROGRAM.toBase58()) throw new Error('IDL address mismatch')

// Real local wallet: partialSign is a genuine signature, exactly what Phantom
// does after the user approves. No mock signer, no fabricated signature.
export const wallet = {
  publicKey: AUTH,
  signTransaction: async (tx) => { tx.partialSign(authority); return tx },
  signAllTransactions: async (txs) => txs.map((t) => { t.partialSign(authority); return t }),
}

export const program = new anchor.Program(
  idl, new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' }),
)

const pub = (d, o) => new PublicKey(d.subarray(o, o + 32)).toBase58()

/** ---- token program DETECTION (never assume) ---- */
export function kindOfTokenProgram(pk) {
  if (pk.equals(TOKEN)) return 'legacy-SPL'
  if (pk.equals(T22)) return 'Token-2022'
  return `UNSUPPORTED(${pk.toBase58()})`
}

/** Reads the OWNING program of an account straight from the chain. */
export async function ownerProgramOf(pk) {
  const info = await conn.getAccountInfo(pk, 'confirmed')
  if (!info) return { ok: false, reason: 'account not found' }
  const kind = kindOfTokenProgram(info.owner)
  if (kind.startsWith('UNSUPPORTED')) return { ok: false, reason: kind, owner: info.owner }
  return { ok: true, owner: info.owner, kind, account: info }
}

/** The token program that owns `mint`, validated to be a supported one. */
export async function detectMintTokenProgram(mint) {
  const r = await ownerProgramOf(mint)
  if (!r.ok) throw new Error(`mint ${mint.toBase58()}: ${r.reason}`)
  const d = r.account.data
  return {
    program: r.owner,
    kind: r.kind,
    decimals: d[44],
    size: r.account.data.length,
    mintAuthority: new PublicKey(d.subarray(4, 36)).toBase58(),
  }
}

/** ATA derived with the ACTUAL mint owner, never hardcoded to legacy. */
export function ataOf(mint, owner, tokenProgram) {
  return spl.getAssociatedTokenAddressSync(mint, owner, false, tokenProgram, ATA_PROGRAM)
}

/** ---- raw decoders (offsets from programs/pumpswap-staking/src/lib.rs) ---- */
export function decodePool(d) {
  return {
    authority: pub(d, 8),
    poolId: d.readBigUInt64LE(40).toString(),
    stakingMint: pub(d, 48),
    rewardMint: pub(d, 80),
    stakingVault: pub(d, 112),
    rewardVault: pub(d, 144),
    lockDuration: Number(d.readBigInt64LE(176)),
    rewardRatePerSecond: d.readBigUInt64LE(184).toString(),
    totalStaked: d.readBigUInt64LE(192).toString(),
    rewardPerToken: d.readBigUInt64LE(200).toString(),
    lastUpdate: Number(d.readBigInt64LE(216)),
    paused: d[224] === 1,
    frozen: d[225] === 1,
    bump: d[226],
    stakingVaultBump: d[227],
    rewardVaultBump: d[228],
    nftCollection: pub(d, 229),
    nftBoostBps: d.readUInt16LE(261),
    bytes: d.length,
  }
}

export function decodePosition(d) {
  return {
    owner: pub(d, 8),
    pool: pub(d, 40),
    amount: d.readBigUInt64LE(72).toString(),
    lockedUntil: Number(d.readBigInt64LE(80)),
    rewardDebt: d.readBigUInt64LE(88).toString(),
    accruedRewards: d.readBigUInt64LE(104).toString(),
    totalClaimed: d.readBigUInt64LE(112).toString(),
    bump: d[120],
    nftBoostBps: d.readUInt16LE(121),
    bytes: d.length,
  }
}

export async function poolAccount(address) {
  const info = await conn.getAccountInfo(address, 'confirmed')
  return info ? { address: address.toBase58(), owner: info.owner.toBase58(), ...decodePool(info.data) } : null
}

export async function positionAccount(pool, user) {
  const pda = pdas.position(pool, user)
  const info = await conn.getAccountInfo(pda, 'confirmed')
  return info ? { address: pda.toBase58(), owner: info.owner.toBase58(), ...decodePosition(info.data) } : null
}

/** Token account read that reports the OWNER program instead of guessing. */
export async function tokenInfo(address) {
  const info = await conn.getAccountInfo(address, 'confirmed')
  if (!info) return { exists: false }
  const kind = kindOfTokenProgram(info.owner)
  const isToken = !kind.startsWith('UNSUPPORTED')
  return {
    exists: true,
    ownerProgram: info.owner.toBase58(),
    tokenKind: kind,
    mint: isToken ? pub(info.data, 0) : null,
    authority: isToken ? pub(info.data, 32) : null,
    amount: isToken ? info.data.readBigUInt64LE(64) : null,
    bytes: info.data.length,
  }
}

const idSeed = (id) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(id)); return b }

export const pdas = {
  pool: (auth, id) => PublicKey.findProgramAddressSync([Buffer.from('pool'), auth.toBuffer(), idSeed(id)], PROGRAM)[0],
  stakingVault: (pool) => PublicKey.findProgramAddressSync([Buffer.from('staking_vault'), pool.toBuffer()], PROGRAM)[0],
  rewardVault: (pool) => PublicKey.findProgramAddressSync([Buffer.from('reward_vault'), pool.toBuffer()], PROGRAM)[0],
  position: (pool, user) => PublicKey.findProgramAddressSync([Buffer.from('user_position'), pool.toBuffer(), user.toBuffer()], PROGRAM)[0],
  platform: PublicKey.findProgramAddressSync([Buffer.from('platform')], PROGRAM)[0],
}

/**
   * Sends a real, signed transaction and waits for on-chain confirmation.
   * `extraSigners` are real keypairs (e.g. a freshly created mint) that must sign
   * alongside the authority wallet - exactly like a wallet adapter would.
   */
export async function send(label, instructions, extraSigners = []) {
  const tx = new Transaction()
  for (const ix of instructions) tx.add(ix)
  const bh = await rpcRetry(() => conn.getLatestBlockhash('confirmed'), 'blockhash')
  tx.recentBlockhash = bh.blockhash
  tx.lastValidBlockHeight = bh.lastValidBlockHeight
  tx.feePayer = AUTH
  for (const s of extraSigners) tx.partialSign(s)
  tx.partialSign(authority)
  const sig = await rpcRetry(() => conn.sendRawTransaction(tx.serialize()), 'sendRaw')
  const res = await conn.confirmTransaction(
    { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed')
  if (res.value.err) {
    const logs = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      .then((t) => (t?.meta?.logMessages ?? []).slice(-14).join(' | ')).catch(() => 'no logs')
    throw new Error(`${label} FAILED on-chain: ${JSON.stringify(res.value.err)} :: ${logs}`)
  }
  return sig
}

/** Sends and REPORTS failure instead of throwing (negative tests). */
export async function expectFail(label, build) {
  try {
    const built = await build()
    const sig = await send(label, Array.isArray(built) ? built : [built])
    return { label, rejected: false, detail: `UNEXPECTED SUCCESS ${sig}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { label, rejected: /FAILED on-chain/.test(msg), detail: msg.slice(0, 260) }
  }
}

export const out = []
export function log(...a) {
  const line = a.join(' ').replace(/api-key=[^&\s"']*/gi, 'api-key=***')
  out.push(line); console.log(line)
}
export function save(file) { fs.writeFileSync(file, out.join('\n') + '\n') }
export function check(label, pass, detail = '') {
  log(`${pass ? '[PASS]' : '[FAIL]'} ${label}${detail ? ' :: ' + detail : ''}`)
  return pass
}

export { spl, PublicKey, Keypair, Transaction, anchor, require, fs }