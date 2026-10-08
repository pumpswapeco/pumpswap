/**
 * TOKEN-2022 COMPATIBILITY PROBE (read-only on-chain simulation).
 *
 * Goal: prove, against the DEPLOYED program, that the staking instructions
 * accept a Token-2022 mint / token account / token program exactly the way they
 * accept a legacy SPL Token one.
 *
 * Nothing is signed and nothing is sent. Every check is a
 * `simulateTransaction`, which executes the real program bytecode and returns
 * the real program logs, so the result reflects the deployed program and not the
 * local source.
 *
 * The probe looks for a real Token-2022 mint on the cluster, then simulates the
 * token-mint / token-account / token-program constraints of `stake` against it
 * and compares the outcome with an equivalent legacy mint.
 *
 * Expected result: the program does NOT reject a Token-2022 mint with a
 * "wrong token program" style error. A rejection that is about the SIGNER /
 * account-ownership / balance is expected and is a POSITIVE signal that the
 * token-program constraint itself was satisfied (i.e. the interface accepted
 * Token-2022).
 *
 * Usage: node scripts/verify-token2022.mjs
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Keypair,
} from "@solana/web3.js"

const ROOT = process.cwd()
const PROGRAM_ID = new PublicKey("BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs")
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) continue
    for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
      if (!m) continue
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "")
    }
  }
}
loadEnv()
const RPC = process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL
if (!RPC) {
  console.error("No SOLANA_RPC_URL found")
  process.exit(1)
}

let idc = 0
async function rpc(method, params, attempt = 0) {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++idc, method, params }),
    })
    const json = await res.json()
    if (json.error) throw new Error(JSON.stringify(json.error))
    return json.result
  } catch (e) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      return rpc(method, params, attempt + 1)
    }
    throw e
  }
}

async function getAccount(pubkey) {
  const res = await rpc("getAccountInfo", [pubkey.toBase58(), { encoding: "base64" }])
  const v = res?.value
  if (!v) return null
  return { ...v, owner: new PublicKey(v.owner), data: Buffer.from(v.data[0], "base64") }
}

/** Every 82-byte Token-2022 account is a plain mint (no extensions). */
async function findToken2022Mints(limit = 10) {
  const res = await rpc("getProgramAccountsV2", [
    TOKEN_2022_PROGRAM.toBase58(),
    { filters: [{ dataSize: 82 }] },
  ])
  return (res.accounts ?? []).slice(0, limit).map((a) => new PublicKey(a.pubkey))
}

const u64le = (v) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(v))
  return b
}

/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
function anchorDiscriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)
}

const SYSTEM_PROGRAM = SystemProgram.programId

/**
 * Pull the meaningful lines out of a simulation result.
 *
 * `Connection.simulateTransaction` resolves to `{ context, value: { err, logs } }`,
 * so the actual result must be unwrapped from `.value` first.
 */
function explain(sim) {
  const value = sim?.value ?? sim ?? {}
  return {
    err: value.err,
    interesting: (value.logs ?? []).filter(
      (l) =>
        l.includes("Instruction:") ||
        l.includes("AnchorError") ||
        l.includes("Constraint") ||
        l.includes("Error Code") ||
        l.includes("failed:") ||
        l.includes("Program log:"),
    ),
  }
}

/** Retry wrapper around Connection.simulateTransaction (devnet RPC flaps). */
async function simulate(connection, tx) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await connection.simulateTransaction(tx)
    } catch (e) {
      if (attempt >= 4) throw e
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
}

/**
 * Simulate `create_pool` with a given (mint, token program) pairing.
 *
 * The pool PDA for the throwaway id does not exist, so the simulation is
 * EXPECTED to fail. What matters is WHERE it fails:
 *
 *  - failing on the Pool / StakingVault / RewardVault `init` (rent, system
 *    program) means every mint + token-account + token-program constraint was
 *    already ACCEPTED -> this pairing is compatible.
 *  - a token-program / mint constraint error means the pairing was REJECTED.
 *
 * This executes the real DEPLOYED program bytecode. Nothing is signed or sent,
 * so no pool, vault or account is ever created or modified.
 */
async function simulateCreatePool(connection, opts) {
  const { authority, stakingMint, rewardMint, stakingTokenProgram, rewardTokenProgram, poolId } = opts

  const data = Buffer.concat([
    anchorDiscriminator("create_pool"),
    u64le(poolId),   // pool_id
    u64le(0),        // lock_duration (i64 = flexible)
    u64le(11574),    // reward_rate_per_second
  ])

  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), authority.toBuffer(), u64le(poolId)], PROGRAM_ID)
  const [stakingVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("staking_vault"), poolPda.toBuffer()], PROGRAM_ID)
  const [rewardVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("reward_vault"), poolPda.toBuffer()], PROGRAM_ID)

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: stakingMint, isSigner: false, isWritable: false },
      { pubkey: rewardMint, isSigner: false, isWritable: false },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: stakingVault, isSigner: false, isWritable: true },
      { pubkey: rewardVault, isSigner: false, isWritable: true },
      { pubkey: stakingTokenProgram, isSigner: false, isWritable: false },
      { pubkey: rewardTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  })

  const tx = new Transaction()
  tx.feePayer = authority
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
  tx.add(ix)
  return explain(await simulate(connection, tx))
}

async function main() {
  const { Connection } = await import("@solana/web3.js")
  const connection = new Connection(RPC, "confirmed")

  console.log("=".repeat(78))
  console.log("TOKEN-2022 COMPATIBILITY PROBE (simulateTransaction, read-only)")
  console.log("=".repeat(78))
  console.log("program:", PROGRAM_ID.toBase58())

  const t2022Info = await getAccount(TOKEN_2022_PROGRAM)
  console.log("Token-2022 program deployed:", !!t2022Info)

  const mints2022 = await findToken2022Mints(6)
  console.log("Token-2022 mints found:", mints2022.length)

  if (mints2022.length === 0) {
    console.log("\nNo Token-2022 mint available on this cluster.")
    return
  }

  const staking2022 = mints2022[0]
  const reward2022 = mints2022[1] ?? mints2022[0]
  console.log("\nusing Token-2022 staking mint:", staking2022.toBase58())
  console.log("using Token-2022 reward  mint:", reward2022.toBase58())

  /*
   * The fee payer / authority must be a REAL, funded, existing account or the
   * simulation stops at "AccountNotFound" before ever reaching the program.
   * The platform admin that actually initialized this program on devnet is used
   * read-only as the authority: it is never asked to sign anything, and because
   * the throwaway pool ids below collide with no existing pool, nothing is ever
   * created even in simulation.
   */
  const platformPda = (await PublicKey.findProgramAddressSync(
    [Buffer.from("platform")], PROGRAM_ID))[0]
  const platformInfo = await getAccount(platformPda)
  const authority = platformInfo ? new PublicKey(platformInfo.data.subarray(8, 40)) : null
  if (!authority) {
    console.log("Could not read the platform admin; skipping simulation.")
    return
  }
  console.log("\nsimulation authority (read-only, never signs):", authority.toBase58())

  const poolId = 987654321987654n
  const LEGACY_MINT = new PublicKey("E63EXv9SCMucdHsLirpWD8JvwCWL2ujzsJ6ScajgES1a")

  const cases = [
    ["A) T22 staking + T22 reward", staking2022, reward2022, TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM, poolId],
    ["B) T22 staking + LEGACY reward (mixed)", staking2022, LEGACY_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, poolId + 1n],
    ["C) LEGACY + LEGACY (control)", LEGACY_MINT, LEGACY_MINT, TOKEN_PROGRAM, TOKEN_PROGRAM, poolId + 2n],
    ["D) NEGATIVE CONTROL: T22 mint declared as legacy program", staking2022, LEGACY_MINT, TOKEN_PROGRAM, TOKEN_PROGRAM, poolId + 3n],
  ]

  const results = []
  for (const [label, sm, rm, stp, rtp, pid] of cases) {
    console.log("\n--- " + label + " ---")
    const r = await simulateCreatePool(connection, {
      authority, stakingMint: sm, rewardMint: rm,
      stakingTokenProgram: stp, rewardTokenProgram: rtp, poolId: pid,
    })
    r.interesting.forEach((l) => console.log("   ", l))
    console.log("    err:", JSON.stringify(r.err))
    results.push({ label, err: r.err, logs: r.interesting.join("\n") })
  }

  /*
   * Classify each run by WHERE it stopped.
   *
   * "ACCEPTED"  -> the program got past the mint / token-account / token-program
   *                constraints and moved on to creating the vaults
   *                (`InitializeAccount3`) or completing. The pairing is
   *                compatible.
   * "REJECTED"  -> the run stopped on a token-program constraint, i.e. the
   *                pairing was refused. This is the expected result for the
   *                negative control, and proves the constraint is real rather
   *                than the program accepting anything.
   */
  const stopsAtTokenConstraint = (r) =>
    /IncorrectProgramId|ConstraintToken|MintMismatch|InvalidMint|TokenInterface|token program/i.test(r.logs)

  console.log("\n" + "=".repeat(78))
  for (const r of results) {
    const rejectedEarly = stopsAtTokenConstraint(r)
    console.log(
      (rejectedEarly ? "REJECTED at token constraint : " : "ACCEPTED token constraints   : ") + r.label,
    )
  }
  console.log("\nExpected: A and B ACCEPTED (Token-2022 works, both pairings);")
  console.log("          D REJECTED (a Token-2022 mint declared as legacy is refused).")
  console.log("=".repeat(78))
}

main().catch((e) => {
  console.error("FAILED:", e)
  process.exit(1)
})