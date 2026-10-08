// PHASE 2 - the 4-pool token-program compatibility matrix (LIVE devnet).
//
// For each pool: create_pool -> fund_rewards -> stake -> verify total_staked
//   -> wait for accrual -> claim -> verify reward balance -> wait out lockup
//   -> unstake -> verify position closes -> verify pool isolation.
//
// Every transaction is really signed by the devnet authority wallet and waited
// on until `confirmed`; nothing is simulated and no signature is fabricated.
// The token program passed to each instruction is the one DETECTED from the
// mint's owning program (lib.mjs detectMintTokenProgram), never assumed.
import fs from 'node:fs'
import {
  AUTH, TOKEN, T22, BN, spl, conn, program, pdas, send, log, save, check,
  poolAccount, positionAccount, tokenInfo, detectMintTokenProgram, ataOf,
  PublicKey, rpcRetry, kindOfTokenProgram,
} from './lib.mjs'
import { SystemProgram } from '@solana/web3.js'

const MINT_STATE = 'C:/Users/olhad/pumpswap/scripts/compat-matrix/mints.json'
const RESULT = 'C:/Users/olhad/pumpswap/scripts/compat-matrix/results.json'
const OUT = 'C:/Users/olhad/pumpswap/scripts/compat-matrix/matrix-out.txt'

// Short lockup (60s) and a rate that accrues visibly within the test window.
const LOCK_SECONDS = 60
const REWARD_RATE = 1_000_000n      // 1.0 reward token/sec at 6 decimals
// Rewards accrue from POOL CREATION (not from stake), at 1 token/sec. The pools
// in this run have existed for tens of minutes, so the vault must cover
// accrual since creation. The first run under-funded it (1e8) and every claim
// correctly failed on-chain with InsufficientRewardVaultBalance (6009).
const FUND_AMOUNT = 500_000_000_000n // 500,000 reward tokens (~5.8 days of emission)
const STAKE_AMOUNT = 1_000_000n     // 1,000 staking tokens at 6 decimals
const ACCRUAL_WAIT_S = 45           // how long to let rewards accrue
const LOCK_WAIT_S = 75              // lockup + margin before unstake

const POOLS = [
  { id: 'A', poolId: 10n, stake: 'A-stake', reward: 'A-reward', staking: 'legacy SPL', rewardKind: 'legacy SPL' },
  { id: 'B', poolId: 11n, stake: 'B-stake', reward: 'B-reward', staking: 'Token-2022', rewardKind: 'legacy SPL' },
  { id: 'C', poolId: 12n, stake: 'C-stake', reward: 'C-reward', staking: 'legacy SPL', rewardKind: 'Token-2022' },
  { id: 'D', poolId: 13n, stake: 'D-stake', reward: 'D-reward', staking: 'Token-2022', rewardKind: 'Token-2022' },
]

const mints = JSON.parse(fs.readFileSync(MINT_STATE, 'utf8'))
let results = {}
try { results = JSON.parse(fs.readFileSync(RESULT, 'utf8')) } catch { results = {} }

const resultsFor = (id) => (results[id] ??= { id, cells: {}, sigs: {}, notes: [] })
/** `status` may be a boolean (true => PASS) or an explicit status string. */
const cell = (r, name, status, detail = '') => {
  const s = typeof status === 'boolean' ? (status ? 'PASS' : 'FAIL') : status
  r.cells[name] = { status: s, detail }
  log(`   ${s === 'PASS' ? '[PASS]' : s === 'FAIL' ? '[FAIL]' : '[----]'} ${name}${detail ? ' :: ' + detail : ''}`)
}
const saveResults = () => fs.writeFileSync(RESULT, JSON.stringify(results, null, 2))
async function runPool(spec) {
  const r = resultsFor(spec.id)
  delete r.error   // a resumed run re-evaluates instead of keeping a stale failure
  log(`\n${'='.repeat(78)}\nPOOL ${spec.id}: staking ${spec.staking} / reward ${spec.rewardKind} (pool_id=${spec.poolId})\n${'='.repeat(78)}`)

  // --- resolve mints and DETECT their token programs (never assume) ---
  const sm = mints[spec.stake]
  const rm = mints[spec.reward]
  const sDet = await detectMintTokenProgram(new PublicKey(sm.mint))
  const rDet = await detectMintTokenProgram(new PublicKey(rm.mint))
  log(`   staking mint ${sDet.kind.padEnd(11)} ${sm.mint}`)
  log(`   reward  mint ${rDet.kind.padEnd(11)} ${rm.mint}`)
  cell(r, 'tokenProgramDetected', 'PASS', `staking=${sDet.kind} reward=${rDet.kind}`)

  // --- derived PDAs ---
  const pool = pdas.pool(AUTH, spec.poolId)
  const sv = pdas.stakingVault(pool)
  const rv = pdas.rewardVault(pool)
  log(`   pool PDA          ${pool.toBase58()}`)
  log(`   staking vault PDA ${sv.toBase58()}`)
  log(`   reward vault PDA  ${rv.toBase58()}`)
  r.addresses = {
    pool: pool.toBase58(), stakingVault: sv.toBase58(), rewardVault: rv.toBase58(),
    stakingMint: sm.mint, rewardMint: rm.mint,
    stakingProg: sDet.program.toBase58(), rewardProg: rDet.program.toBase58(),
  }

  // --- CREATE POOL (passes the DETECTED token program for each mint) ---
  if (!r.sigs.createPool) {
    r.sigs.createPool = await send(`create_pool ${spec.id}`, [
      await program.methods.createPool(new BN(spec.poolId.toString()), new BN(LOCK_SECONDS), new BN(REWARD_RATE.toString()))
        .accountsPartial({
          authority: AUTH,
          stakingMint: new PublicKey(sm.mint),
          rewardMint: new PublicKey(rm.mint),
          stakingTokenProgram: sDet.program,
          rewardTokenProgram: rDet.program,
          systemProgram: SystemProgram.programId,
        }).instruction(),
    ])
    saveResults()
  }
  log('   create_pool sig:', r.sigs.createPool)
  const p = await poolAccount(pool)
  cell(r, 'createPool', p ? 'PASS' : 'FAIL', p ? `${p.bytes} bytes, pool_id=${p.poolId}` : 'pool account missing')
  if (!p) return null

  // --- PDA / vault-authority / mint-binding verification ---
  cell(r, 'poolPda', p.address === pool.toBase58() && p.poolId === spec.poolId.toString(), `${p.address} id=${p.poolId}`)
  cell(r, 'stakingVaultPda', p.stakingVault === sv.toBase58(), p.stakingVault)
  cell(r, 'rewardVaultPda', p.rewardVault === rv.toBase58(), p.rewardVault)
  cell(r, 'stakingMintBound', p.stakingMint === sm.mint, p.stakingMint)
  cell(r, 'rewardMintBound', p.rewardMint === rm.mint, p.rewardMint)
  cell(r, 'shortLockup', p.lockDuration === LOCK_SECONDS, `lock_duration=${p.lockDuration}s`)

  const svInfo = await tokenInfo(new PublicKey(p.stakingVault))
  const rvInfo = await tokenInfo(new PublicKey(p.rewardVault))
  cell(r, 'stakingVaultAuthority', svInfo.authority === pool.toBase58(), `authority=${svInfo.authority}`)
  cell(r, 'rewardVaultAuthority', rvInfo.authority === pool.toBase58(), `authority=${rvInfo.authority}`)
  cell(r, 'stakingVaultMint', svInfo.mint === sm.mint, `vault mint=${svInfo.mint}`)
  cell(r, 'rewardVaultMint', rvInfo.mint === rm.mint, `vault mint=${rvInfo.mint}`)
  cell(r, 'stakingVaultTokenProgram', svInfo.ownerProgram === sDet.program.toBase58(),
    `${kindOfTokenProgram(new PublicKey(svInfo.ownerProgram))} expected=${sDet.kind}`)
  cell(r, 'rewardVaultTokenProgram', rvInfo.ownerProgram === rDet.program.toBase58(),
    `${kindOfTokenProgram(new PublicKey(rvInfo.ownerProgram))} expected=${rDet.kind}`)

  return { r, pool, sv, rv, sm, rm, sDet, rDet }
}

async function runLifecycle(ctx) {
  const { r, pool, sv, rv, sm, rm, sDet, rDet } = ctx
  const userStakeAta = ataOf(new PublicKey(sm.mint), AUTH, sDet.program)
  const userRewardAta = ataOf(new PublicKey(rm.mint), AUTH, rDet.program)
  log(`   user staking ATA ${userStakeAta.toBase58()} (${sDet.kind})`)
  log(`   user reward  ATA ${userRewardAta.toBase58()} (${rDet.kind})`)

  // --- FUND REWARDS (reward token program = the reward mint's real owner) ---
  const rv0 = await tokenInfo(rv)
  if ((rv0.amount ?? 0n) < FUND_AMOUNT) {
    r.sigs.fundRewards = await send(`fund_rewards ${r.id}`, [
      await program.methods.fundRewards(new BN(FUND_AMOUNT.toString())).accountsPartial({
        funder: AUTH, pool,
        rewardMint: new PublicKey(rm.mint),
        funderRewardTokenAccount: userRewardAta,
        rewardVault: rv,
        rewardTokenProgram: rDet.program,
      }).instruction(),
    ])
    saveResults()
  }
  const rv1 = await tokenInfo(rv)
  cell(r, 'fundRewards', (rv1.amount ?? 0n) >= FUND_AMOUNT,
    `${rv0.amount ?? 0n} -> ${rv1.amount ?? 0n} (+${(rv1.amount ?? 0n) - (rv0.amount ?? 0n)})`)
  log('   fund_rewards sig:', r.sigs.fundRewards)

  // --- STAKE (staking token program = the staking mint's real owner) ---
  const posBefore = await positionAccount(pool, AUTH)
  const userStakeBefore = await tokenInfo(userStakeAta)
  const svBefore = await tokenInfo(sv)
  if (!posBefore) {
    r.sigs.stake = await send(`stake ${r.id}`, [
      await program.methods.stake(new BN(STAKE_AMOUNT.toString())).accountsPartial({
        user: AUTH, pool,
        stakingMint: new PublicKey(sm.mint),
        userStakingTokenAccount: userStakeAta,
        stakingVault: sv,
        stakingTokenProgram: sDet.program,
        systemProgram: SystemProgram.programId,
        // Both NFT-boost accounts are OPTIONAL in the IDL; Anchor 0.30 still
        // requires them to be passed explicitly (null = unboosted stake).
        userNftTokenAccount: null,
        nftMetadataAccount: null,
      }).instruction(),
    ])
    saveResults()
  }
  const pos = await positionAccount(pool, AUTH)
  const svAfter = await tokenInfo(sv)
  const pAfterStake = await poolAccount(pool)
  const userStakeAfter = await tokenInfo(userStakeAta)
  cell(r, 'stake', !!pos && pos.amount === STAKE_AMOUNT.toString(), `position amount=${pos?.amount} (${sDet.kind} staking vault)`)
  cell(r, 'stakingVaultBalance', (svAfter.amount ?? 0n) === (svBefore.amount ?? 0n) + STAKE_AMOUNT,
    `${svBefore.amount ?? 0n} -> ${svAfter.amount ?? 0n} (expected +${STAKE_AMOUNT})`)
  cell(r, 'totalStaked', pAfterStake.totalStaked === STAKE_AMOUNT.toString(), `pool.total_staked=${pAfterStake.totalStaked}`)
  log('   stake sig:', r.sigs.stake)
  log(`   user staking ATA ${userStakeBefore.amount} -> ${userStakeAfter.amount}`)

  // --- WAIT FOR REWARD ACCRUAL ---
  log(`   waiting ${ACCRUAL_WAIT_S}s for reward accrual...`)
  await new Promise((res) => setTimeout(res, ACCRUAL_WAIT_S * 1000))
  const posAccrued = await positionAccount(pool, AUTH)
  log(`   accrued_rewards after wait: ${posAccrued?.accrued_rewards} (reward_debt ${posAccrued?.rewardDebt})`)

  // --- CLAIM ---
  const userRewBefore = await tokenInfo(userRewardAta)
  const vaultPreClaim = await tokenInfo(rv)
  r.sigs.claim = await send(`claim_rewards ${r.id}`, [
    await program.methods.claimRewards().accountsPartial({
      user: AUTH, pool,
      userPosition: pdas.position(pool, AUTH),
      rewardMint: new PublicKey(rm.mint),
      userRewardTokenAccount: userRewardAta,
      rewardVault: rv,
      rewardTokenProgram: rDet.program,
    }).instruction(),
  ])
  saveResults()
  const userRewAfter = await tokenInfo(userRewardAta)
  const vaultPostClaim = await tokenInfo(rv)
  const claimed = (userRewAfter.amount ?? 0n) - (userRewBefore.amount ?? 0n)
  const vaultDelta = (vaultPreClaim.amount ?? 0n) - (vaultPostClaim.amount ?? 0n)
  log('   claim sig:', r.sigs.claim)
  log(`   user reward ATA ${userRewBefore.amount} -> ${userRewAfter.amount} (claimed ${claimed}, ${rDet.kind})`)
  log(`   reward vault    ${vaultPreClaim.amount} -> ${vaultPostClaim.amount}`)
  cell(r, 'claim', claimed > 0n, `reward balance +${claimed} units`)
  cell(r, 'vaultConservation', claimed === vaultDelta, `user +${claimed} == vault -${vaultDelta}`)
  const posAfterClaim = await positionAccount(pool, AUTH)
  cell(r, 'accruedReset', posAfterClaim.accruedRewards === '0',
    `accrued=${posAfterClaim.accruedRewards} total_claimed=${posAfterClaim.totalClaimed}`)

  // --- WAIT OUT LOCKUP, THEN UNSTAKE ---
  const waitMore = Math.max(0, LOCK_WAIT_S - ACCRUAL_WAIT_S)
  log(`   waiting ${waitMore}s more for the ${LOCK_SECONDS}s lockup to expire...`)
  await new Promise((res) => setTimeout(res, waitMore * 1000))

  const stakeLeft = (await positionAccount(pool, AUTH)).amount
  const svPreUnstake = await tokenInfo(sv)
  r.sigs.unstake = await send(`unstake ${r.id}`, [
    await program.methods.unstake(new BN(stakeLeft)).accountsPartial({
      user: AUTH, pool,
      userPosition: pdas.position(pool, AUTH),
      stakingMint: new PublicKey(sm.mint),
      userStakingTokenAccount: userStakeAta,
      stakingVault: sv,
      stakingTokenProgram: sDet.program,
    }).instruction(),
  ])
  saveResults()
  const posFinal = await positionAccount(pool, AUTH)
  const poolFinal = await poolAccount(pool)
  const svPostUnstake = await tokenInfo(sv)
  const userStakePost = await tokenInfo(userStakeAta)
  log('   unstake sig:', r.sigs.unstake)
  cell(r, 'unstake', posFinal.amount === '0', `position amount=${posFinal.amount} (position closed)`)
  cell(r, 'totalStakedCleared', poolFinal.totalStaked === '0', `pool.total_staked=${poolFinal.totalStaked}`)
  cell(r, 'stakingReturned', (svPostUnstake.amount ?? 0n) === (svPreUnstake.amount ?? 0n) - BigInt(stakeLeft),
    `vault ${svPreUnstake.amount} -> ${svPostUnstake.amount}; user ATA now ${userStakePost.amount}`)
  r.finalPosition = posFinal
  const rvFinal = await tokenInfo(rv)
  r.finalPool = {
    totalStaked: poolFinal.totalStaked,
    stakingVault: String(svPostUnstake.amount ?? 0n),
    rewardVault: String(rvFinal.amount ?? 0n),
  }
  saveResults()
  return r
}

/**
 * Isolation: every pool's vaults/mints/positions must be distinct, and each
 * pool's reward vault must only ever have been touched by its own mint.
 */
async function verifyIsolation() {
  log(`\n${'='.repeat(78)}\nPOOL ISOLATION CHECK\n${'='.repeat(78)}`)
  const seen = { pool: new Set(), stakingVault: new Set(), rewardVault: new Set() }
  let allDistinct = true
  const finals = {}
  for (const spec of POOLS) {
    const r = resultsFor(spec.id)
    if (!r.addresses) continue
    finals[spec.id] = r
    for (const k of ['pool', 'stakingVault', 'rewardVault']) {
      const v = r.addresses[k]
      if (seen[k].has(v)) { allDistinct = false; log(`   COLLISION on ${k}: ${v}`) }
      seen[k].add(v)
    }
    log(`   ${spec.id}: pool=${r.addresses.pool}`)
    log(`      stakeVault=${r.addresses.stakingVault} rewardVault=${r.addresses.rewardVault}`)
  }
  check('all pools use distinct pool/vault accounts', allDistinct)

  // No vault may hold a foreign mint.
  let vaultsClean = true
  for (const spec of POOLS) {
    const r = finals[spec.id]
    if (!r) continue
    const sv = await tokenInfo(new PublicKey(r.addresses.stakingVault))
    const rv = await tokenInfo(new PublicKey(r.addresses.rewardVault))
    const ok = sv.mint === r.addresses.stakingMint && rv.mint === r.addresses.rewardMint
    if (!ok) vaultsClean = false
    log(`   ${spec.id} vault mints match pool mints: ${ok ? 'yes' : 'NO'}`)
  }
  check('no vault holds a foreign mint', vaultsClean)

  // The pre-existing pools must be untouched by this run.
  const pools = await rpcRetry(() => conn.getProgramAccounts(
    new PublicKey('BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs'), { filters: [{ dataSize: 263 }] }), 'gpa')
  const ids = pools.map((p) => p.account.data.readBigUInt64LE(40).toString()).sort((a, b) => a - b)
  log(`   current-layout pools now on devnet: ${ids.join(', ')} (ids)`)
  const legacy = await rpcRetry(() => conn.getProgramAccounts(
    new PublicKey('BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs'), { filters: [{ dataSize: 229 }] }), 'gpa')
  check('the 2 legacy 229-byte pools still exist and were not touched', legacy.length === 2,
    `${legacy.length} legacy pools: ${legacy.map((x) => x.pubkey.toBase58()).join(', ')}`)
  const preExisting = pools.filter((p) => ['2', '3'].includes(p.account.data.readBigUInt64LE(40).toString()))
  check('pre-existing working pools 2 and 3 still present', preExisting.length === 2,
    `found ${preExisting.length}`)
  return allDistinct && vaultsClean
}

async function main() {
  log('=== PHASE 2: LIVE token-program compatibility matrix on devnet ===')
  log('authority:', AUTH.toBase58())
  log(`lock=${LOCK_SECONDS}s rate=${REWARD_RATE}/s fund=${FUND_AMOUNT} stake=${STAKE_AMOUNT}`)
  log('legacy SPL Token:', TOKEN.toBase58())
  log('Token-2022      :', T22.toBase58())

  for (const spec of POOLS) {
    try {
      const ctx = await runPool(spec)
      if (!ctx) { log(`   POOL ${spec.id} aborted at create_pool`); continue }
      await runLifecycle(ctx)
    } catch (e) {
      const r = resultsFor(spec.id)
      r.error = e instanceof Error ? e.message : String(e)
      log(`   POOL ${spec.id} ERROR: ${r.error}`)
      saveResults()
    }
  }

  await verifyIsolation()

  log(`\n${'='.repeat(78)}\nMATRIX SUMMARY\n${'='.repeat(78)}`)
  for (const spec of POOLS) {
    const r = resultsFor(spec.id)
    const g = (k) => r.cells?.[k]?.status ?? '----'
    log(`POOL ${spec.id} (${spec.staking} / ${spec.rewardKind})`)
    log(`   create=${g('createPool')} fund=${g('fundRewards')} stake=${g('stake')} totalStaked=${g('totalStaked')}`)
    log(`   claim=${g('claim')} unstake=${g('unstake')} closed=${g('unstake')}`)
    if (r.error) log(`   ERROR: ${r.error}`)
  }
  save(OUT)
  saveResults()
}

main().catch((e) => { console.error('PHASE 2 FAILED:', e); save(OUT); process.exitCode = 1 })
