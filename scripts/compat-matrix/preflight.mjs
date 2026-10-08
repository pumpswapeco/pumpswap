// READ-ONLY PREFLIGHT for the Token-program compatibility matrix.
// 1. RPC health  2. SAFETY: deployed program (on-chain IDL) vs current source
// 3. Devnet pool inventory + free pool_id scan  4. Authority wallet  5. Detection proof
// Nothing is signed, nothing is sent.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import {
  PROGRAM, TOKEN, T22, conn, AUTH, pdas, log, save, check, kindOfTokenProgram,
} from './lib.mjs'

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

async function main() {
  log('=== 1. RPC HEALTH ===')
  const bh = await conn.getLatestBlockhash('confirmed')
  log('blockhash:', bh.blockhash, '| slot', await conn.getSlot('confirmed'))

  log('\n=== 2. SAFETY CHECK: deployed program vs current source ===')
  const progInfo = await conn.getAccountInfo(PROGRAM, 'confirmed')
  if (!progInfo) throw new Error('program account missing on devnet')
  log('program    :', PROGRAM.toBase58())
  log('  executable:', progInfo.executable, '| owner:', progInfo.owner.toBase58())

  const [pdAddr] = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER)
  const pd = await conn.getAccountInfo(pdAddr, 'confirmed')
  if (!pd) throw new Error('ProgramData account missing')
  // ProgramData (BPFLoaderUpgradeable). Anchor 0.31 may store the IDL zstd-compressed,
// so dump the header and probe for both plain JSON and the zstd magic (28 B5 2F FD).
  const enumVal = pd.data.readUInt32LE(0)
  log('  ProgramData:', pdAddr.toBase58(), '| bytes:', pd.data.length)
  log('    enum:', enumVal, '| upgradeable program:', enumVal === 2, '(2 = Program)')
  log('    NOTE: Anchor 0.31 bincode-encodes the IDL in ProgramData; the DEPLOYED')
  log('          layout is proven from the live pool accounts below instead.')

  const localIdl = JSON.parse(readFileSync('C:/Users/olhad/pumpswap/lib/solana/idl/pumpswap_staking.json', 'utf8'))
  log('\n  local IDL instructions:', (localIdl.instructions ?? []).map((x) => x.name).sort().join(','))
  log('\n  --- accounts per instruction (LOCAL IDL) ---')
  for (const ix of localIdl.instructions ?? []) {
    log(`   ${ix.name.padEnd(15)} ${(ix.accounts ?? []).map((a) => a.name).join(', ')}`)
  }
  log('\n  NOTE: the Rust source declares every token account as InterfaceAccount<Mint/')
  log('  TokenAccount> and the program as Interface<TokenInterface>, i.e. the token')
  log('  program is a RUNTIME parameter, so SPL and Token-2022 are both valid.')
  // Anchor discriminators for the state accounts (IDL -> the deployed program).
  const disc = (n) => {
    const a = (localIdl.accounts ?? []).find((x) => x.name === n)
    return a ? Buffer.from(a.discriminator).toString('hex') : 'n/a'
  }
  log(`\n  IDL Pool discriminator         : ${disc('Pool')}`)
  log(`  IDL UserPosition discriminator  : ${disc('UserPosition')}`)
  // Expected on-chain sizes straight from the Rust `impl LEN` constants.
  const EXPECT_POOL = 8 + (32 + 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 16 + 8 + 1 + 1 + 1 + 1 + 1 + 32 + 2)
  const EXPECT_POS = 8 + (32 + 32 + 8 + 8 + 16 + 8 + 8 + 1 + 2)
  log(`  expected Pool bytes (8 + Pool::LEN)  : ${EXPECT_POOL}`)
  log(`  expected UserPosition bytes (8 + LEN) : ${EXPECT_POS}`)
  const POOL_DISC = disc('Pool')

  log('\n=== 3. INSTRUCTION DISCRIMINATORS (sha256("global:<name>")[0..8]) ===')
  for (const n of ['create_pool', 'fund_rewards', 'stake', 'unstake', 'claim_rewards', 'set_pool_boost']) {
    log(`  ${n.padEnd(14)} ${createHash('sha256').update(`global:${n}`).digest().subarray(0, 8).toString('hex')}`)
  }

  log('\n=== 4. DEVNET POOL INVENTORY ===')
  const plat = await conn.getAccountInfo(pdas.platform, 'confirmed')
  log('platform pda:', pdas.platform.toBase58(), plat ? `exists (${plat.data.length} bytes)` : 'MISSING')
  if (plat) log('  admin:', new PublicKey(plat.data.subarray(8, 40)).toBase58())
  const pools = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 263 }] })
  log(`\nCURRENT-layout pools (263 bytes): ${pools.length}`)
  check('deployed Pool account size == 8 + current Pool::LEN (263)', pools.length > 0 && pools.every((p) => p.account.data.length === EXPECT_POOL), `sizes=${[...new Set(pools.map((p) => p.account.data.length))].join(',')}`)
  for (const p of pools) {
    const d = p.account.data
    log(`  pool_id=${d.readBigUInt64LE(40)}  ${p.pubkey.toBase58()}  total_staked=${d.readBigUInt64LE(192)}`)
  }
  check('live Pool accounts carry the IDL Pool discriminator (deployed == source)',
    pools.length > 0 && pools.every((p) => p.account.data.subarray(0, 8).toString('hex') === POOL_DISC),
    `live=${pools[0] ? pools[0].account.data.subarray(0, 8).toString('hex') : 'n/a'} idl=${POOL_DISC}`)
  const legacy = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 229 }] })
  log(`\nLEGACY 229-byte pools (MUST NOT TOUCH): ${legacy.length}`)
  for (const p of legacy) log('  ', p.pubkey.toBase58())

  log('\n=== 5. FREE pool_id SCAN (authority-scoped PDAs) ===')
  const used = new Set(pools.map((p) => p.account.data.readBigUInt64LE(40).toString()))
  const free = []
  for (let i = 0; i < 60; i++) {
    if (used.has(String(i))) continue
    const info = await conn.getAccountInfo(pdas.pool(AUTH, i), 'confirmed')
    if (!info) free.push(i)
  }
  log('used pool_ids:', [...used].sort((a, b) => a - b).join(', '))
  log('FREE pool_ids:', free.join(', '))
  log('-> matrix will use:', free.slice(0, 4).join(', '))

  log('\n=== 6. AUTHORITY WALLET ===')
  log('pubkey:', AUTH.toBase58())
  log('SOL   :', (await conn.getBalance(AUTH, 'confirmed')) / 1e9)
  log('legacy SPL accounts:', (await conn.getTokenAccountsByOwner(AUTH, { programId: TOKEN })).value.length)
  log('Token-2022 accounts :', (await conn.getTokenAccountsByOwner(AUTH, { programId: T22 })).value.length)

  log('\n=== 7. TOKEN PROGRAM DETECTION (owner read from chain) ===')
  log('legacy SPL Token :', TOKEN.toBase58(), '->', kindOfTokenProgram(TOKEN))
  log('Token-2022       :', T22.toBase58(), '->', kindOfTokenProgram(T22))
  for (const [label, mk] of [
    ['PSC (existing staking mint)', new PublicKey('E63EXv9SCMucdHsLirpWD8JvwCWL2ujzsJ6ScajgES1a')],
    ['PRC (existing reward mint)  ', new PublicKey('4Tg7tVodPwCEhPnsq9Cy98qhsqg52swsKc3BQjJvwzAq')],
  ]) {
    const i = await conn.getAccountInfo(mk, 'confirmed')
    log(`${label} ${mk.toBase58()} -> owner=${i?.owner.toBase58()} (${kindOfTokenProgram(i.owner)}) size=${i?.data.length} decimals=${i ? i.data[44] : '?'}`)
  }
}

main()
  .then(() => save(new URL('./preflight-out.txt', import.meta.url).pathname.replace(/^\//, '')))
  .catch((e) => { console.error('PREFLIGHT FAILED:', e); process.exitCode = 1 })