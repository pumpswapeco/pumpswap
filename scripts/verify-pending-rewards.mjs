// Reads the REAL on-chain Pool + UserPosition for the Devnet wallet and runs
// the SAME pending-reward math as lib/solana/use-user-rewards.ts /
// lib/solana/ops.ts (computeUpdatedRewardPerToken + computePendingRewards,
// including the position's stored NFT boost),
// then resolves the reward mint decimals + Metaplex symbol on-chain.
//
// NOTE: the pool must be a CURRENT-layout account (263 bytes, with the
// nft_collection / nft_boost_bps fields). The pre-upgrade pool
// 7f7Q78AY7BooQCJRg4ZEeT8uwZb6jNCBszFiTPP5rdxw (229 bytes) cannot be decoded
// by the current IDL and must not be used here.
import fs from 'node:fs'
import { Program, AnchorProvider } from '@coral-xyz/anchor'
import { Connection, PublicKey } from '@solana/web3.js'
import { getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { publicKey as umiPublicKey } from '@metaplex-foundation/umi'
import { fetchMetadataFromSeeds, mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata'

const projectRoot = 'C:/Users/olhad/pumpswap'
const idl = JSON.parse(fs.readFileSync(projectRoot + '/lib/solana/idl/pumpswap_staking.json', 'utf8'))

let rpc = 'https://api.devnet.solana.com'
for (const l of fs.readFileSync(projectRoot + '/.env.local', 'utf8').split(/\r?\n/)) {
  // Prefer the server-side Helius endpoint; the NEXT_PUBLIC proxy URL is empty.
  const m = l.match(/^\s*SOLANA_RPC_URL\s*=\s*(.+?)\s*$/)
  if (m && m[1]) rpc = m[1]
}

const PROGRAM_ID = 'BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs'
// The wallet holding the position in the NFT-boost pool.
const WALLET = '2pGydyPFaZQJ8ZbGCBBim4w6fBv5qEb3h8eByaabo5ij'
// The NFT-boost pool (current layout, boost 3500 bps).
const POOL = 'Gi94NEwd5F85wWZCy2REdCn3kpQbKpiewvsBCLAGqEpZ'
const REWARD_SCALE = BigInt('1000000000000000000')

const out = 'C:/Users/olhad/pumpswap/scripts/verify-pending-out.txt'
const log = (...a) => fs.appendFileSync(out, a.join(' ') + '\n', 'utf8')
fs.writeFileSync(out, `RPC: ${rpc}\n`, 'utf8')

// ---- same math as ops.ts -------------------------------------------------
function computeUpdatedRewardPerToken(pool, nowUnixSeconds) {
  const rpt = BigInt(pool.rewardPerToken.toString())
  const last = BigInt(pool.lastUpdateTimestamp.toString())
  const totalStaked = BigInt(pool.totalStaked.toString())
  const rate = BigInt(pool.rewardRatePerSecond.toString())
  const now = BigInt(nowUnixSeconds)
  const elapsed = now - last
  if (elapsed <= BigInt(0) || totalStaked === BigInt(0)) return rpt
  return rpt + (elapsed * rate * REWARD_SCALE) / totalStaked
}
function computePendingRewards(position, updatedRewardPerToken) {
  const debt = BigInt(position.rewardDebt.toString())
  const amount = BigInt(position.amount.toString())
  const accrued = BigInt(position.accruedRewards.toString())
  const delta = updatedRewardPerToken > debt ? updatedRewardPerToken - debt : BigInt(0)
  const pending = delta > BigInt(0) && amount > BigInt(0) ? (amount * delta) / REWARD_SCALE : BigInt(0)
  // Same NFT-boost handling as ops.ts: boost applies to the NEW delta only.
  const boostBps = position.nftBoostBps ?? 0
  if (boostBps > 0) {
    return accrued + (pending * BigInt(10_000 + boostBps)) / BigInt(10_000)
  }
  return accrued + pending
}

const dummy = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }
const connection = new Connection(rpc, 'confirmed')
const provider = new AnchorProvider(connection, dummy, { commitment: 'confirmed' })
const program = new Program(idl, provider)

const pool = await program.account.pool.fetch(new PublicKey(POOL))
log('POOL')
log('  totalStaked        :', pool.totalStaked.toString())
log('  rewardRatePerSecond:', pool.rewardRatePerSecond.toString())
log('  rewardMint         :', pool.rewardMint.toBase58())
log('  lastUpdateTimestamp:', pool.lastUpdateTimestamp.toString())
log('  rewardPerToken     :', pool.rewardPerToken.toString())

const [positionPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('user_position'), new PublicKey(POOL).toBuffer(), new PublicKey(WALLET).toBuffer()],
  new PublicKey(PROGRAM_ID),
)
const accountInfo = await connection.getAccountInfo(positionPda)
log('UserPosition PDA   :', positionPda.toBase58(), accountInfo ? '(EXISTS on-chain)' : '(not found)')

let pendingBase = BigInt(0)
if (accountInfo) {
  const position = await program.account.userPosition.fetch(positionPda)
  log('POSITION')
  log('  owner            :', position.owner.toBase58())
  log('  amount (staked)  :', position.amount.toString())
  log('  accruedRewards   :', position.accruedRewards.toString())
  log('  totalClaimed     :', position.totalClaimed.toString())
  const now = Math.floor(Date.now() / 1000)
  const updated = computeUpdatedRewardPerToken(pool, now)
  pendingBase = computePendingRewards(position, updated)
  log('  updatedRewardPerToken:', updated.toString())
} else {
  log('POSITION: none -> genuinely zero pending rewards')
}

// ---- resolve reward mint decimals + on-chain Metaplex symbol ------------
let decimals = 9
let symbol = null
try {
  const mint = await getMint(connection, pool.rewardMint, 'confirmed', TOKEN_PROGRAM_ID)
  decimals = mint.decimals
  log('Reward mint decimals :', decimals)
} catch (e) {
  log('getMint failed:', e.message)
}
try {
  const umi = createUmi(rpc).use(mplTokenMetadata())
  const meta = await fetchMetadataFromSeeds(umi, { mint: umiPublicKey(pool.rewardMint.toBase58()) })
  symbol = meta.symbol.replace(/ /g, '')
  log('Reward token symbol  :', JSON.stringify(symbol))
} catch (e) {
  log('metadata lookup failed:', e.message)
}

log('')
log(`PENDING REWARDS = ${pendingBase.toString()} base units`)
log(`  = ${Number(pendingBase) / Math.pow(10, decimals)} ${symbol ?? '(symbol unavailable)'} @ ${decimals} decimals`)
log(`  (value displayed on the dashboard card: ${(Number(pendingBase) / Math.pow(10, decimals)).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${symbol ?? 'tokens'})`)