/**
 * READ-ONLY devnet verification for the pumpswap-staking program.
 *
 * Uses only getAccountInfo / getSignaturesForAddress / getTransaction. It never
 * signs, sends, or mutates anything.
 *
 * Verifies:
 *   1. Program executable + Platform singleton state.
 *   2. Every Pool account, with authority, mints, vaults, lock, reward rate,
 *      pause/freeze flags and NFT boost config.
 *   3. PDA / bump re-derivation for each pool and its two vaults.
 *   4. Vault authority (must be the pool PDA) and vault mint == pool mint.
 *   5. Token program per mint: legacy SPL Token vs Token-2022.
 *   6. Multi-pool independence (no shared/global pool state).
 *
 * Usage: node scripts/verify-onchain-state.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { PublicKey } from "@solana/web3.js"
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token"

const ROOT = process.cwd()
const PROGRAM_ID = new PublicKey("BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs")
// sha256("global:create_pool")[0..8] — the Anchor instruction discriminator.
const DISCRIMINATOR_CREATE_POOL = Buffer.from([233, 146, 209, 142, 207, 104, 64, 188])
// sha256("account:Pool")[0..8] — the Anchor Pool account discriminator.
const DISCRIMINATOR_POOL = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188])

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) continue
    for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
      if (!m) continue
      const value = m[2].trim().replace(/^["']|["']$/g, "")
      if (!process.env[m[1]]) process.env[m[1]] = value
    }
  }
}

loadEnv()
const RPC = process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL
const DEFAULT_POOL = process.env.NEXT_PUBLIC_DEFAULT_POOL_ADDRESS

if (!RPC) {
  console.error("No SOLANA_RPC_URL found in .env.local / .env")
  process.exit(1)
}

let idc = 0
/**
 * JSON-RPC call with a bounded retry. A transient socket error / 429 must never
 * abort a verification run, so the same request is retried a few times.
 */
async function rpc(method, params, attempt = 0) {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++idc, method, params }),
    })
    const json = await res.json()
    if (json.error) {
      // Rate limiting is retryable; a real RPC error is not worth spinning on.
      if (attempt < 4 && /429|Too Many|rate limit/i.test(JSON.stringify(json.error))) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
        return rpc(method, params, attempt + 1)
      }
      throw new Error(`${method}: ${JSON.stringify(json.error)}`)
    }
    return json.result
  } catch (error) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      return rpc(method, params, attempt + 1)
    }
    throw error
  }
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
function b58decode(s) {
  const bytes = [0n]
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) throw new Error("bad base58 character")
    let carry = BigInt(v)
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58n
      bytes[i] = carry & 0xffn
      carry >>= 8n
    }
    while (carry > 0n) {
      bytes.push(carry & 0xffn)
      carry >>= 8n
    }
  }
  for (let i = 0; i < s.length && s[i] === "1"; i++) bytes.push(0n)
  return Buffer.from(bytes.reverse().map((b) => Number(b)))
}

/**
 * Unwrap the JSON-RPC `getAccountInfo` envelope.
 *
 * The raw response carries `owner` as a base58 STRING and `data` as a base64
 * string; `@solana/spl-token`'s unpackers expect a real `AccountInfo<Buffer>`
 * with `owner: PublicKey` and `data: Buffer`. Normalize once, here, so every
 * consumer gets the shape the unpackers need.
 */
async function getAccount(pubkey) {
  const res = await rpc("getAccountInfo", [pubkey.toBase58(), { encoding: "base64" }])
  const value = res?.value
  if (!value) return null
  return {
    ...value,
    owner: new PublicKey(value.owner),
    data: Buffer.from(value.data[0], "base64"),
  }
}

/**
 * Pool layout after the 8-byte Anchor discriminator:
 *  authority 32 | pool_id 8 | staking_mint 32 | reward_mint 32 |
 *  staking_vault 32 | reward_vault 32 | lock_duration 8 | reward_rate 8 |
 *  total_staked 8 | reward_per_token 16 | last_update 8 |
 *  paused 1 | frozen 1 | bump 1 | staking_vault_bump 1 | reward_vault_bump 1 |
 *  nft_collection 32 | nft_boost_bps 2
 *
 * A pool created BEFORE the NFT-boost upgrade is 34 bytes shorter and has no
 * trailing nft_collection / nft_boost_bps. Those fields are read defensively so
 * an older pool still reports its real state instead of crashing the audit.
 */
const POOL_LEN_WITH_NFT = 8 + 255
const POOL_LEN_LEGACY = POOL_LEN_WITH_NFT - 34

function decodePool(buf) {
  let o = 8
  const pub = () => {
    const v = new PublicKey(buf.subarray(o, o + 32))
    o += 32
    return v
  }
  const authority = pub()
  const poolId = readU64(buf, o); o += 8
  const stakingMint = pub()
  const rewardMint = pub()
  const stakingVault = pub()
  const rewardVault = pub()
  const lockDuration = buf.readBigInt64LE(o); o += 8
  const rewardRatePerSecond = readU64(buf, o); o += 8
  const totalStaked = readU64(buf, o); o += 8
  const rewardPerToken = readU128(buf, o); o += 16
  const lastUpdateTimestamp = buf.readBigInt64LE(o); o += 8
  const paused = buf[o] === 1; o += 1
  const frozen = buf[o] === 1; o += 1
  const bump = buf[o]; o += 1
  const stakingVaultBump = buf[o]; o += 1
  const rewardVaultBump = buf[o]; o += 1

  const legacyLayout = buf.length < POOL_LEN_WITH_NFT
  const nftCollection = legacyLayout
    ? new PublicKey(new Uint8Array(32))
    : pub()
  const nftBoostBps = legacyLayout ? 0 : buf.readUInt16LE(o)

  return {
    authority, poolId, stakingMint, rewardMint, stakingVault, rewardVault,
    lockDuration, rewardRatePerSecond, totalStaked, rewardPerToken,
    lastUpdateTimestamp, paused, frozen, bump, stakingVaultBump,
    rewardVaultBump, nftCollection, nftBoostBps,
    accountBytes: buf.length,
    legacyLayout,
  }
}

/** UserPosition: owner 32 | pool 32 | amount 8 | locked_until 8 | reward_debt 16 | accrued 8 | claimed 8 | bump 1 | boost_bps 2 */
function decodeUserPosition(buf) {
  let o = 8
  const owner = new PublicKey(buf.subarray(o, o + 32)); o += 32
  const pool = new PublicKey(buf.subarray(o, o + 32)); o += 32
  const amount = readU64(buf, o); o += 8
  const lockedUntil = buf.readBigInt64LE(o); o += 8
  const rewardDebt = readU128(buf, o); o += 16
  const accruedRewards = readU64(buf, o); o += 8
  const totalClaimed = readU64(buf, o); o += 8
  const bump = buf[o]; o += 1
  const nftBoostBps = buf.readUInt16LE(o); o += 2
  return { owner, pool, amount, lockedUntil, rewardDebt, accruedRewards, totalClaimed, bump, nftBoostBps }
}

export { decodePool, decodeUserPosition, b58decode, leBytes, getAccount, decode, readU64, readU128 }

const tokenProgramName = (id) =>
  id.equals(TOKEN_PROGRAM_ID) ? "SPL Token (legacy)" : id.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "UNKNOWN"

async function readTokenAccount(pubkey) {
  const info = await getAccount(pubkey)
  if (!info) return null
  const owner = new PublicKey(info.owner)
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) return null
  return unpackAccount(pubkey, info, owner)
}

async function readMint(pubkey) {
  const info = await getAccount(pubkey)
  if (!info) return null
  const owner = new PublicKey(info.owner)
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) return null
  return { ...unpackMint(pubkey, info, owner), tokenProgram: owner }
}

const human = (amount, decimals) =>
  (Number(amount) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 6 })
const decode = (info) => info.data
const readU64 = (b, o) => b.readBigUInt64LE(o)
const readU128 = (b, o) => (b.readBigUInt64LE(o) << 64n) | b.readBigUInt64LE(o + 8)
const leBytes = (v) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(v)
  return b
}
/** Find every Pool PDA this program created on this cluster, from tx logs. */
async function discoverPools() {
  const sigs = await rpc("getSignaturesForAddress", [PROGRAM_ID.toBase58(), { limit: 1000 }])
  const found = new Set()
  let logMatched = 0

  for (const s of sigs) {
    let tx
    try {
      tx = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "json" }])
    } catch {
      continue
    }
    const logs = tx?.meta?.logMessages ?? []
    // Anchor emits the Rust fn name: "Instruction: CreatePool".
    if (logs.some((l) => /Instruction:\s*CreatePool\b/.test(l))) logMatched++

    const msg = tx?.transaction?.message
    if (!msg) continue
    const keys = msg.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey))
    const programIdx = keys.indexOf(PROGRAM_ID.toBase58())
    if (programIdx < 0) continue

    for (const rel of msg.instructions) {
      if (rel.programIdIndex !== programIdx) continue
      let data
      try {
        data = rel.data ? b58decode(rel.data) : null
      } catch {
        continue
      }
      if (!data || data.length < 8) continue
      if (!data.subarray(0, 8).equals(DISCRIMINATOR_CREATE_POOL)) continue
      // create_pool accounts: authority, staking_mint, reward_mint, pool, ...
      const poolKey = rel.accounts?.[3]
      if (poolKey !== undefined && keys[poolKey]) found.add(keys[poolKey])
    }
  }
  return { found, signatureCount: sigs.length, logMatched }
}

async function loadPool(address) {
  const key = new PublicKey(address)
  const info = await getAccount(key)
  if (!info || !info.owner.equals(PROGRAM_ID)) return null
  const buf = decode(info)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(DISCRIMINATOR_POOL)) return null
  return { address: key, decoded: decodePool(buf), lamports: info.lamports }
}

async function main() {
  console.log("=".repeat(78))
  console.log("PUMPSWAP STAKING - READ-ONLY DEVNET VERIFICATION")
  console.log("=".repeat(78))
  console.log("program :", PROGRAM_ID.toBase58())
  console.log("rpc     :", RPC.replace(/(https?:\/\/[^/]+).*/, "$1/***"))

  const programInfo = await getAccount(PROGRAM_ID)
  console.log("\n[1] PROGRAM")
  if (!programInfo) {
    console.log("  !! program account NOT FOUND on this cluster")
  } else {
    console.log("  executable :", programInfo.executable)
    console.log("  owner      :", programInfo.owner)
    console.log("  lamports   :", programInfo.lamports / 1e9, "SOL")
  }

  const [platformPda] = PublicKey.findProgramAddressSync([Buffer.from("platform")], PROGRAM_ID)
  const platformInfo = await getAccount(platformPda)
  console.log("\n[2] PLATFORM  (seeds [\"platform\"])")
  console.log("  pda        :", platformPda.toBase58())
  if (!platformInfo) {
    console.log("  state      : NOT INITIALIZED (permissionless init remains open)")
  } else {
    const b = decode(platformInfo)
    console.log("  admin      :", new PublicKey(b.subarray(8, 40)).toBase58())
    console.log("  fee_bps    :", b.readUInt16LE(40))
    console.log("  NOTE       : Platform.admin authorizes NO instruction; pool.authority does.")
  }

  const { found, signatureCount, logMatched } = await discoverPools()
  console.log("\n[3] POOL DISCOVERY")
  console.log("  signatures scanned :", signatureCount)
  console.log("  create_pool by log :", logMatched)
  console.log("  pool PDAs decoded  :", found.size)

  const pools = []
  for (const addr of found) {
    const p = await loadPool(addr)
    if (p) pools.push(p)
  }
  if (DEFAULT_POOL) {
    try {
      const p = await loadPool(DEFAULT_POOL)
      if (p && !pools.some((x) => x.address.equals(p.address))) pools.push(p)
    } catch { /* invalid default pool env value */ }
  }
  console.log("  pools loaded       :", pools.length)
for (const p of pools) {
    const d = p.decoded
    console.log("\n  " + "-".repeat(72))
    console.log("  POOL", p.address.toBase58())
    console.log("    authority         :", d.authority.toBase58())
    console.log("    pool_id (u64 LE)  :", d.poolId.toString())
    console.log("    staking mint      :", d.stakingMint.toBase58())
    console.log("    reward  mint      :", d.rewardMint.toBase58())
    console.log("    lock_duration     :", d.lockDuration.toString(), "s")
    console.log("    reward_rate/sec   :", d.rewardRatePerSecond.toString())
    console.log("    total_staked      :", d.totalStaked.toString())
    console.log("    reward_per_token  :", d.rewardPerToken.toString())
    console.log("    last_update_ts    :", d.lastUpdateTimestamp.toString())
    console.log("    paused / frozen   :", d.paused, "/", d.frozen)
    console.log("    nft_collection    :", d.nftCollection.toBase58())
    console.log("    nft_boost_bps     :", d.nftBoostBps)
    console.log("    account bytes     :", d.accountBytes,
      d.legacyLayout ? "(LEGACY layout - no NFT boost fields)" : "(current layout)")

    const [expPool] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), d.authority.toBuffer(), leBytes(d.poolId)],
      PROGRAM_ID,
    )
    const [expSv] = PublicKey.findProgramAddressSync(
      [Buffer.from("staking_vault"), p.address.toBuffer()],
      PROGRAM_ID,
    )
    const [expRv] = PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), p.address.toBuffer()],
      PROGRAM_ID,
    )
    console.log("    pool PDA rederive :", expPool.equals(p.address) ? "OK" : "MISMATCH")
    console.log("    vault PDAs        :", expSv.equals(d.stakingVault) ? "staking OK" : "staking MISMATCH",
      "/", expRv.equals(d.rewardVault) ? "reward OK" : "reward MISMATCH")

    const sv = await readTokenAccount(d.stakingVault)
    const rv = await readTokenAccount(d.rewardVault)
    console.log("    staking vault     :", sv ? `amount=${sv.amount} mint=${sv.mint.toBase58()}` : "NOT A TOKEN ACCOUNT")
    console.log("    reward vault      :", rv ? `amount=${rv.amount} mint=${rv.mint.toBase58()}` : "NOT A TOKEN ACCOUNT")
    if (sv) {
      console.log("    vault authority   :", sv.owner.toBase58(),
        sv.owner.equals(p.address) ? "= pool PDA OK" : "NOT pool PDA - SECURITY ISSUE")
      console.log("    vault mint match  :", sv.mint.equals(d.stakingMint) ? "OK" : "MISMATCH")
    }
    if (rv) {
      console.log("    vault authority   :", rv.owner.toBase58(),
        rv.owner.equals(p.address) ? "= pool PDA OK" : "NOT pool PDA - SECURITY ISSUE")
      console.log("    vault mint match  :", rv.mint.equals(d.rewardMint) ? "OK" : "MISMATCH")
    }

    const sm = await readMint(d.stakingMint)
    const rm = await readMint(d.rewardMint)
    console.log("    staking mint prog:", sm ? tokenProgramName(sm.tokenProgram) : "UNREADABLE/NOT A MINT")
    console.log("    reward  mint prog:", rm ? tokenProgramName(rm.tokenProgram) : "UNREADABLE/NOT A MINT")
    if (sm) console.log("    staking decimals  :", sm.decimals, "supply:", sm.supply.toString())
    if (rm) {
      console.log("    reward  decimals  :", rm.decimals, "supply:", rm.supply.toString())
      if (rv) console.log("    reward vault bal  :", human(rv.amount, rm.decimals))
    }
    if (sm && sv) console.log("    staking vault bal :", human(sv.amount, sm.decimals))
    console.log("    total_staked check:", sv && sm ? (BigInt(sv.amount) >= d.totalStaked ? "vault covers total_staked OK" : `VAULT SHORT by ${d.totalStaked - BigInt(sv.amount)}`) : "n/a")
  }

  console.log("\n[4] MULTI-POOL INDEPENDENCE")
  if (pools.length < 2) {
    console.log("  Only 1 pool discovered - independence NOT demonstrated on-chain yet.")
  } else {
    const distinct = (arr) => new Set(arr.map(String)).size
    console.log("  pools                  :", pools.length)
    console.log("  distinct authorities   :", distinct(pools.map((p) => p.decoded.authority)))
    console.log("  distinct staking mints :", distinct(pools.map((p) => p.decoded.stakingMint)))
    console.log("  distinct reward mints  :", distinct(pools.map((p) => p.decoded.rewardMint)))
    console.log("  distinct staking vaults:", distinct(pools.map((p) => p.decoded.stakingVault)))
    console.log("  distinct reward vaults :", distinct(pools.map((p) => p.decoded.rewardVault)))
    const ids = pools.map((p) => p.decoded.poolId.toString())
    console.log("  pool_id collisions     :", ids.length - new Set(ids).size === 0 ? "none OK" : "COLLISION")
  }

  console.log("\n" + "=".repeat(78))
  console.log("END - read-only run, no transaction was signed or sent")
  console.log("=".repeat(78))
}

main().catch((e) => {
  console.error("FAILED:", e)
  process.exit(1)
})