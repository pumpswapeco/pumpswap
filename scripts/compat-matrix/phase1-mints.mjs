// PHASE 1 - fresh devnet mints + funded ATAs for the 4-pool token matrix.
//
//   A: staking SPL   / reward SPL
//   B: staking T22   / reward SPL
//   C: staking SPL   / reward T22
//   D: staking T22   / reward T22
//
// Every mint is brand new (separate keypair), Token-2022 mints carry NO
// extensions, and the token program is DETECTED from the created account's
// owner rather than assumed. State is written to mints.json so the matrix run
// can resume instead of re-creating mints.
import {
  AUTH, TOKEN, T22, spl, conn, send, log, save, check, Keypair, PublicKey, rpcRetry,
} from './lib.mjs'
import { SystemProgram } from '@solana/web3.js'
import fs from 'node:fs'

const { getMint } = spl
const DECIMALS = 6
const MINT_AMOUNT = 1_000_000n * 10n ** BigInt(DECIMALS)   // 1,000,000 tokens
export const MINT_STATE = 'C:/Users/olhad/pumpswap/scripts/compat-matrix/mints.json'

const SPEC = [
  { pool: 'A', label: 'A-stake', kind: TOKEN }, { pool: 'A', label: 'A-reward', kind: TOKEN },
  { pool: 'B', label: 'B-stake', kind: T22 }, { pool: 'B', label: 'B-reward', kind: TOKEN },
  { pool: 'C', label: 'C-stake', kind: TOKEN }, { pool: 'C', label: 'C-reward', kind: T22 },
  { pool: 'D', label: 'D-stake', kind: T22 }, { pool: 'D', label: 'D-reward', kind: T22 },
]

async function ensureAta(mint, tokenProgram) {
  const ata = spl.getAssociatedTokenAddressSync(mint, AUTH, false, tokenProgram, spl.ASSOCIATED_TOKEN_PROGRAM_ID)
  if (!(await rpcRetry(() => conn.getAccountInfo(ata, 'confirmed'), 'ata'))) {
    // createAssociatedTokenAccountInstruction takes POSITIONAL args in spl-token 0.4:
    // (payer, associatedToken, owner, mint, tokenProgram, associatedTokenProgram).
    // The instruction (not the async action) is used so this goes through the same
    // real send-and-confirm path as every other transaction in this run.
    await send(`create ATA ${ata.toBase58().slice(0, 8)}`, [
      spl.createAssociatedTokenAccountInstruction(
        AUTH, ata, AUTH, mint, tokenProgram, spl.ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    ])
    log('   created ATA', ata.toBase58(), '| token program:', tokenProgram.toBase58())
  }
  return ata
}

async function main() {
  log('=== PHASE 1: fresh devnet mints for the token matrix ===')
  log('authority:', AUTH.toBase58(), '| SOL:', (await rpcRetry(() => conn.getBalance(AUTH, 'confirmed'))) / 1e9)
  log('decimals:', DECIMALS, '| mint amount:', MINT_AMOUNT.toString(), 'units per mint')

  const ORPHANS = {
      // Mints created on devnet by earlier interrupted runs of this same script.
      // Reused so they are not wasted; no supply was ever minted to them.
      'A-stake': { mint: 'HgRDD5NkSFsco6q3QTpfLw3hs2n96c9Vxb2KgQwPX9NA', tokenProgram: TOKEN.toBase58(), kind: 'legacy-SPL', decimals: DECIMALS, sigCreateMint: 'created in an interrupted run', done: false },
    }

    let state = {}
    try { state = JSON.parse(fs.readFileSync(MINT_STATE, 'utf8')) } catch { state = {} }
    for (const [k, v] of Object.entries(ORPHANS)) if (!state[k]?.done) state[k] = { ...v, ...(state[k] ?? {}) }

  for (const spec of SPEC) {
    if (state[spec.label]?.done) { log(`\n[${spec.label}] already complete, reusing:`, state[spec.label].mint); continue }

    // Resume path: the mint already exists on-chain (earlier interrupted run).
    let mint, detected, sig = state[spec.label]?.sigCreateMint ?? '(pre-existing)'
    if (state[spec.label]?.mint) {
      mint = new PublicKey(state[spec.label].mint)
      log(`\n[${spec.label}] resuming existing mint ${mint.toBase58()}`)
    } else {
      log(`\n[${spec.label}] creating ${spec.kind === TOKEN ? 'legacy SPL' : 'Token-2022'} mint (no extensions)`)
      const kp = Keypair.generate()
      const wantProgram = spec.kind
      // Rent for the 82-byte mint must be in the createAccount instruction itself.
      const rent = await rpcRetry(() => spl.getMinimumBalanceForRentExemptMint(conn), 'rent')
      sig = await send(`createMint ${spec.label}`, [
        SystemProgram.createAccount({
          fromPubkey: AUTH, newAccountPubkey: kp.publicKey, lamports: rent, space: 82, programId: wantProgram,
        }),
        spl.createInitializeMint2Instruction(kp.publicKey, DECIMALS, AUTH, null, wantProgram),
      ], [kp])
      mint = kp.publicKey
    }

    const info = await rpcRetry(() => conn.getAccountInfo(mint, 'confirmed'), 'mint')
    detected = info.owner
    const kindLabel = detected.equals(T22) ? 'Token-2022' : detected.equals(TOKEN) ? 'legacy SPL' : 'UNSUPPORTED'
    check(`${spec.label}: mint owner is a supported token program`,
      kindLabel !== 'UNSUPPORTED', `owner=${detected.toBase58()} (${kindLabel})`)
    check(`${spec.label}: mint is 82 bytes (no Token-2022 extensions)`, info.data.length === 82, `size=${info.data.length}`)

    const m = await rpcRetry(() => getMint(conn, mint, 'confirmed', detected), 'getMint')
    log(`   mint ${mint.toBase58()} decimals=${m.decimals} supply=${m.supply} owner=${detected.toBase58()}`)

    // Persist the mint the moment it exists so a later failure never orphans it.
    state[spec.label] = {
      mint: mint.toBase58(), tokenProgram: detected.toBase58(), kind: detected.equals(T22) ? 'Token-2022' : 'legacy-SPL',
      decimals: m.decimals, sigCreateMint: sig, done: false,
    }
    fs.writeFileSync(MINT_STATE, JSON.stringify(state, null, 2))

    const ata = await ensureAta(mint, detected)
    const sigMint = await send(`mintTo ${spec.label}`, [
      spl.createMintToInstruction(mint, ata, AUTH, MINT_AMOUNT, [], detected),
    ])
    const ataBal = (await rpcRetry(() => conn.getTokenAccountBalance(ata, 'confirmed'))).value.amount
    check(`${spec.label}: authority ATA funded`, BigInt(ataBal) === MINT_AMOUNT, `${ataBal} units`)
    log(`   ATA ${ata.toBase58()} balance=${ataBal}`)

    state[spec.label].ata = ata.toBase58()
    state[spec.label].sigMintTo = sigMint
    state[spec.label].done = true
    fs.writeFileSync(MINT_STATE, JSON.stringify(state, null, 2))
  }

  log('\n=== PHASE 1 SUMMARY ===')
  for (const s of SPEC) {
    const r = state[s.label]
    log(`  ${s.label.padEnd(9)} ${r.mint}  ${r.kind.padEnd(11)} prog=${r.tokenProgram}  ata=${r.ata}`)
  }
  log('\ntoken programs used:')
  log('  legacy SPL :', TOKEN.toBase58())
  log('  Token-2022 :', T22.toBase58())
  save('C:/Users/olhad/pumpswap/scripts/compat-matrix/phase1-out.txt')
}

main().catch((e) => { console.error('PHASE 1 FAILED:', e); process.exitCode = 1 })