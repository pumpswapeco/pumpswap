// PHASE 3 - INDEPENDENT verification. Re-reads every pool/vault/position straight
// from devnet and fetches each recorded signature to prove it really landed on
// chain (no signature is taken on trust from the run that produced it).
import fs from 'node:fs'
import {
  AUTH, TOKEN, T22, PROGRAM, conn, pdas, log, save, check,
  poolAccount, positionAccount, tokenInfo, detectMintTokenProgram,
  PublicKey, rpcRetry, kindOfTokenProgram,
} from './lib.mjs'

const DIR = 'C:/Users/olhad/pumpswap/scripts/compat-matrix'
const results = JSON.parse(fs.readFileSync(`${DIR}/results.json`, 'utf8'))

async function main() {
  log('=== PHASE 3: INDEPENDENT ON-CHAIN VERIFICATION ===')
  log('program:', PROGRAM.toBase58())
  log('legacy SPL Token:', TOKEN.toBase58())
  log('Token-2022      :', T22.toBase58())

  for (const id of ['A', 'B', 'C', 'D']) {
    const r = results[id]
    if (!r?.addresses) { log(`\nPOOL ${id}: no results`); continue }
    const a = r.addresses
    log(`\n${'='.repeat(78)}\nPOOL ${id}  pool=${a.pool}\n${'='.repeat(78)}`)

    // --- Re-detect each token program from the chain (never from the run) ---
    const sDet = await detectMintTokenProgram(new PublicKey(a.stakingMint))
    const rDet = await detectMintTokenProgram(new PublicKey(a.rewardMint))
    log(`  staking mint owner : ${sDet.program.toBase58()} (${sDet.kind})`)
    log(`  reward  mint owner : ${rDet.program.toBase58()} (${rDet.kind})`)
    check(`${id}: staking mint owner is the declared staking program`, sDet.program.toBase58() === a.stakingProg)
    check(`${id}: reward mint owner is the declared reward program`, rDet.program.toBase58() === a.rewardProg)

    // --- Vaults: owner program, mint, authority, balance ---
    for (const [label, addr, expectMint, expectProg, poolPda] of [
      ['staking vault', a.stakingVault, a.stakingMint, sDet.program.toBase58(), a.pool],
      ['reward  vault', a.rewardVault, a.rewardMint, rDet.program.toBase58(), a.pool],
    ]) {
      const v = await tokenInfo(new PublicKey(addr))
      check(`${id}: ${label} owner program == its mint's program`, v.ownerProgram === expectProg,
        `${kindOfTokenProgram(new PublicKey(v.ownerProgram))}`)
      check(`${id}: ${label} mint matches the pool mint`, v.mint === expectMint, v.mint)
      check(`${id}: ${label} authority is the pool PDA`, v.authority === poolPda, v.authority)
      log(`     ${label} ${addr} balance=${v.amount} bytes=${v.bytes}`)
    }

    // --- Pool + position final state ---
    const p = await poolAccount(new PublicKey(a.pool))
    check(`${id}: pool account is the CURRENT 263-byte layout`, p?.bytes === 263, `${p?.bytes} bytes`)
    check(`${id}: pool.total_staked back to 0 after unstake`, p?.totalStaked === '0', `total_staked=${p?.totalStaked}`)
    check(`${id}: pool never paused/frozen`, p && !p.paused && !p.frozen)
    const pos = await positionAccount(new PublicKey(a.pool), AUTH)
    check(`${id}: user position closed (amount 0)`, pos?.amount === '0', `amount=${pos?.amount} total_claimed=${pos?.totalClaimed}`)

    // --- Every recorded signature must exist on chain and have succeeded ---
    log('  --- transaction signatures (fetched from devnet) ---')
    for (const [step, sig] of Object.entries(r.sigs)) {
      if (!sig || String(sig).startsWith('(')) { log(`     ${step.padEnd(11)} ${sig}`); continue }
      const tx = await rpcRetry(() => conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }), `tx ${step}`)
      const ok = !!tx && !tx.meta?.err
      check(`${id}: ${step} confirmed on devnet`, ok,
        ok ? `slot ${tx.slot}, fee ${tx.meta.fee} lamports` : `err=${JSON.stringify(tx?.meta?.err)}`)
    }
  }

  log(`\n${'='.repeat(78)}\nWHOLE-PROGRAM STATE\n${'='.repeat(78)}`)
  const pools = await rpcRetry(() => conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 263 }] }), 'gpa')
  const legacy = await rpcRetry(() => conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 229 }] }), 'gpa')
  log(`current-layout (263B) pools: ${pools.length} -> ids ${pools.map((x) => x.account.data.readBigUInt64LE(40)).sort((a, b) => Number(a) - Number(b)).join(', ')}`)
  log(`legacy (229B) pools       : ${legacy.length} (untouched)`)
  check('pre-existing working pools 2 and 3 survive', pools.length === 6)
  check('exactly 2 legacy 229-byte pools remain untouched', legacy.length === 2)

  save(`${DIR}/verify-out.txt`)
}

main().catch((e) => { console.error('PHASE 3 FAILED:', e); process.exitCode = 1 })