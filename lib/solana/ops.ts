import { AnchorProvider, BN } from '@coral-xyz/anchor'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
  unpackAccount,
} from '@solana/spl-token'
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js'

import { findPoolPda, findPlatformPda, findRewardVaultPda, findStakingVaultPda, findUserPositionPda } from '@/lib/solana/pda'
import type { StakingProgram } from '@/lib/solana/program'
import { isSupportedTokenProgram, resolveMintTokenProgram } from '@/lib/solana/token'
import { withRpcRetry } from '@/lib/solana/transport'

/** Must match REWARD_SCALE in programs/pumpswap-staking/src/lib.rs */
const REWARD_SCALE = BigInt('1000000000000000000')

/** Mirrors on-chain `update_pool_rewards`. */
export function computeUpdatedRewardPerToken(
  pool: {
    rewardPerToken: BN
    lastUpdateTimestamp: BN
    totalStaked: BN
    rewardRatePerSecond: BN
  },
  nowUnixSeconds: number,
): bigint {
  const rpt = BigInt(pool.rewardPerToken.toString())
  const last = BigInt(pool.lastUpdateTimestamp.toString())
  const totalStaked = BigInt(pool.totalStaked.toString())
  const rate = BigInt(pool.rewardRatePerSecond.toString())

  const now = BigInt(nowUnixSeconds)
  const elapsed = now - last
  if (elapsed <= BigInt(0) || totalStaked === BigInt(0)) return rpt
  return rpt + (elapsed * rate * REWARD_SCALE) / totalStaked
}

/**
 * Mirrors on-chain `settle_user_rewards`: returns accrued claimable rewards.
 *
 * The newly settled portion goes through the same NFT-boost math the program
 * applies in `calculate_reward_accrual`, using the boost STORED ON THIS
 * UserPosition (`nftBoostBps`, written by the on-chain `stake` instruction) -
 * never the UI's currently selected NFT:
 *
 *   boosted = baseReward * (10_000 + nftBoostBps) / 10_000
 *
 * `accruedRewards` already contains boosts applied by past settles, so the
 * boost is applied ONLY to the new delta - exactly like the program - and never
 * re-applied to the stored accrual. When `nftBoostBps` is 0 the calculation is
 * the original unboosted arithmetic, untouched.
 */
export function computePendingRewards(
  position: {
    amount: BN
    rewardDebt: BN
    accruedRewards: BN
    /** Boost recorded on-chain by `stake` (basis points; 0 = no NFT boost). */
    nftBoostBps?: number
  },
  updatedRewardPerToken: bigint,
): bigint {
  const debt = BigInt(position.rewardDebt.toString())
  const amount = BigInt(position.amount.toString())
  const accrued = BigInt(position.accruedRewards.toString())
  const delta = updatedRewardPerToken > debt ? updatedRewardPerToken - debt : BigInt(0)
  const pending = delta > BigInt(0) && amount > BigInt(0) ? (amount * delta) / REWARD_SCALE : BigInt(0)

  // Stored on-chain boost (u16 bps), not any UI-selected NFT state.
  const boostBps = position.nftBoostBps ?? 0
  if (boostBps > 0) {
    // Matches on-chain `calculate_reward_accrual` integer math:
    // base * (BPS_DIVISOR + boost_bps) / BPS_DIVISOR.
    return accrued + (pending * BigInt(10_000 + boostBps)) / BigInt(10_000)
  }
  return accrued + pending
}

export type PoolAccount = {
  authority: PublicKey
  poolId: BN
  stakingMint: PublicKey
  rewardMint: PublicKey
  stakingVault: PublicKey
  rewardVault: PublicKey
  lockDuration: BN
  rewardRatePerSecond: BN
  totalStaked: BN
  rewardPerToken: BN
  lastUpdateTimestamp: BN
  paused: boolean
  frozen: boolean
  bump: number
  /** NFT boost collection (System Program / all-zeros when unset on-chain). */
  nftCollection: PublicKey
  /** NFT boost reward multiplier in basis points (0 when boost disabled). */
  nftBoostBps: number
}

export type UserPositionAccount = {
  owner: PublicKey
  pool: PublicKey
  amount: BN
  lockedUntil: BN
  rewardDebt: BN
  accruedRewards: BN
  totalClaimed: BN
  bump: number
  /** NFT boost recorded on-chain at stake time (u16 bps; 0 = no boost). */
  nftBoostBps: number
}

/**
 * Anchor 0.30.1 converts the IDL to camelCase while it builds the runtime
 * `program.account` namespace (`Pool` -> `pool`, `UserPosition` ->
 * `userPosition`), but the generated IDL *types* keep the raw IDL names. As a
 * result `program.account.Pool` type-checks and is nevertheless `undefined` at
 * runtime ("Cannot read properties of undefined (reading 'fetch')").
 *
 * Read-side code must therefore address the camelCase clients the Program
 * actually exposes. The namespace is cast through `unknown` - the same pattern
 * already used for the account results cast to `PoolAccount` /
 * `UserPositionAccount` below.
 */
type RuntimeAccountNamespace = {
  pool: { fetch(address: PublicKey): Promise<PoolAccount> }
  userPosition: { fetch(address: PublicKey): Promise<UserPositionAccount> }
}

function runtimeAccountNamespace(program: StakingProgram): RuntimeAccountNamespace {
  return program.account as unknown as RuntimeAccountNamespace
}

/** In-flight deduplication for account reads (same promise shared per key). */
const poolFetchInFlight = new Map<string, Promise<PoolAccount>>()
const positionFetchInFlight = new Map<string, Promise<UserPositionAccount | null>>()

/** Fetches a Pool account by address (concurrent calls share one RPC request). */
export function fetchPool(program: StakingProgram, poolAddress: PublicKey): Promise<PoolAccount> {
  const key = `${program.programId.toBase58()}|${poolAddress.toBase58()}`
  const active = poolFetchInFlight.get(key)
  if (active) return active

  const promise = runtimeAccountNamespace(program)
    .pool
    .fetch(poolAddress)
    .then((account) => account as unknown as PoolAccount)
    .finally(() => {
      poolFetchInFlight.delete(key)
    })

  poolFetchInFlight.set(key, promise)
  return promise
}

/** Fetches the user's position PDA for a pool, or null if it does not exist. */
export function fetchUserPosition(
  program: StakingProgram,
  poolAddress: PublicKey,
  user: PublicKey,
): Promise<UserPositionAccount | null> {
  const [positionPda] = findUserPositionPda(poolAddress, user, program.programId)
  const key = `${program.programId.toBase58()}|${positionPda.toBase58()}`
  const active = positionFetchInFlight.get(key)
  if (active) return active

  const promise = (async (): Promise<UserPositionAccount | null> => {
    const accountInfo = await program.provider.connection.getAccountInfo(positionPda)
    if (!accountInfo) return null
    return (await runtimeAccountNamespace(program).userPosition.fetch(positionPda)) as unknown as UserPositionAccount
  })().finally(() => {
    positionFetchInFlight.delete(key)
  })

  positionFetchInFlight.set(key, promise)
  return promise
}

/**
 * Returns the associated token account address, and whether it must be created.
 *
 * An ATA address is derived from seeds [owner, tokenProgram, mint], so it
 * depends on the token program that OWNS the mint. That program is detected from
 * the mint account (classic SPL Token or Token-2022) and returned so callers can
 * reuse it for the instruction and for account reads instead of re-detecting -
 * classic SPL Token is never assumed.
 *
 * Only a GENUINE absence (`TokenAccountNotFoundError` - the ATA has never been
 * created) yields `needsCreation: true`. Any other read failure (RPC error,
 * HTTP 429, timeout, malformed account) propagates to the caller instead of
 * being misread as "missing": a transient read error must never cause the
 * caller to prepend an ATA-creation instruction for an account that already
 * exists, which would make the whole transaction fail on-chain.
 */
export async function ensureAta(
  program: StakingProgram,
  mint: PublicKey,
  owner: PublicKey,
): Promise<{ address: PublicKey; needsCreation: boolean; tokenProgramId: PublicKey }> {
  const connection = program.provider.connection
  const tokenProgramId = await resolveMintTokenProgram(connection, mint)
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID)
  try {
    await getAccount(connection, ata, 'confirmed', tokenProgramId)
    return { address: ata, needsCreation: false, tokenProgramId }
  } catch (error) {
    if (error instanceof TokenAccountNotFoundError) {
      return { address: ata, needsCreation: true, tokenProgramId }
    }
    throw error
  }
}

/** ATA creation instruction bound to the mint's OWN token program. */
function ataCreationInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
) {
  return createAssociatedTokenAccountInstruction(
    payer,
    ata,
    owner,
    mint,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
}

/**
 * Real wallet accounts needed by the program's optional NFT-boost accounts.
 * Both are `optional` in the deployed IDL (`user_nft_token_account`,
 * `nft_metadata_account`). They must come from the wallet scan
 * (`useWalletNfts`): never a mint, never a frontend-supplied collection.
 */
export type StakeNftAccounts = {
  /** SPL token account holding the NFT; the program requires owner === user and amount >= 1. */
  tokenAccount: PublicKey
  /** Metaplex `Metadata` PDA for the NFT mint; the program verifies mint + verified collection. */
  metadata: PublicKey
}

/**
 * Send an unsigned staking transaction through a fresh-blockhash boundary.
 *
 * Anchor's `provider.sendAndConfirm()` (ATA-creation branch) and `builder.rpc()`
 * (plain branch) both set `recentBlockhash` immediately before the wallet popup
 * opens — but they do NOT pin `lastValidBlockHeight`, and they confirm with the
 * deprecated signature-based `confirmTransaction(signature, commitment)`. While
 * Solflare waits for the user to approve (an arbitrary delay) that unpinned
 * blockhash can age past its ~150-slot validity window, so when the signed
 * transaction finally reaches the RPC the preflight simulation rejects it with
 * "Transaction simulation failed: Blockhash not found."
 *
 * This is the SAME send path already proven by `createPool` / `fundRewards` /
 * `pausePool`: a brand-new `getLatestBlockhash` is fetched at the last possible
 * moment (immediately before `wallet.signTransaction`), BOTH `recentBlockhash`
 * and `lastValidBlockHeight` are pinned, the transaction is submitted with a
 * real preflight (never `skipPreflight`), and confirmation reuses that exact
 * `blockhash`/`lastValidBlockHeight` so the signed blockhash governs the whole
 * submit → confirm lifecycle.
 */
async function sendWithFreshBlockhash(
  program: StakingProgram,
  tx: Transaction,
): Promise<string> {
  const provider = program.provider as AnchorProvider

  tx.feePayer = tx.feePayer ?? provider.publicKey
  // Fetched at 'confirmed' so the pinned blockhash is already published across
  // the cluster (including every load-balanced RPC backend) before preflight.
  const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash(
    provider.opts.preflightCommitment ?? 'confirmed',
  )
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight

  // Solflare popup opens here: the blockhash is as fresh as possible right
  // before the (arbitrary-duration) user approval.
  const signedTx = await provider.wallet.signTransaction(tx)
  const rawTx = signedTx.serialize()

  let signature: string
  try {
    // SAME app-configured Connection/RPC that served getLatestBlockhash above,
    // single attempt, real preflight (never skipPreflight).
    signature = await provider.connection.sendRawTransaction(rawTx, {
      preflightCommitment: 'confirmed',
      skipPreflight: false,
    })
  } catch (error) {
    console.error('[stake] sendRawTransaction FAILED', describeTxError(error), error)
    throw error
  }

  // Confirmation reuses the exact blockhash/lastValidBlockHeight that was signed.
  try {
    const confirmation = await provider.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    if (confirmation.value.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
    }
  } catch (error) {
    console.error('[stake] confirmTransaction FAILED', describeTxError(error), error)
    throw error
  }

  return signature
}

/**
 * Stake `amount` base units of the pool's staking mint.
 *
 * The account set mirrors the deployed IDL's `stake` instruction exactly:
 * user, pool, user_position, staking_mint, user_staking_token_account,
 * staking_vault, staking_token_program, system_program, and the two OPTIONAL
 * NFT-boost accounts (`userNftTokenAccount`, `nftMetadataAccount`).
 *
 * The pool drives everything token-related: `pool.stakingMint` is the mint the
 * program validates against `pool.staking_mint`, and `staking_token_program` is
 * the program that actually OWNS that mint (classic SPL Token or Token-2022) -
 * never assumed to be the legacy program. The user's staking ATA is derived with
 * the same program, so a Token-2022 pool gets its Token-2022 ATA.
 *
 * `nft` omitted / null  -> both NFT accounts are sent as empty (null): the
 *                         program runs its normal, unboosted path.
 * `nft` provided        -> the program re-verifies the NFT on-chain (token
 *                         account owner = user, amount >= 1, metadata matches
 *                         the mint, collection verified and equal to
 *                         pool.nftCollection) and applies the boost STORED IN
 *                         THE POOL. No boost value is sent or trusted here.
 *
 * The NFT is PROOF OF ELIGIBILITY AT STAKE TIME ONLY: it is never transferred to
 * the program, and the boost the pool configures is SNAPSHOTTED onto the
 * position by `stake` (`UserPosition.nftBoostBps`). Because rewards are computed
 * from that stored value, transferring the NFT away afterwards does NOT change
 * the accrued boost of this position. `unstake` / `claim_rewards` never take the
 * NFT accounts at all.
 */
export async function stake(
  program: StakingProgram,
  opts: {
    poolAddress: PublicKey
    pool: PoolAccount
    user: PublicKey
    amount: BN
    /** Real NFT accounts from the wallet scan, or null/omitted for a normal stake. */
    nft?: StakeNftAccounts | null
  },
): Promise<string> {
  // TEMPORARY development diagnostic (dev only, no functional change):
  // first statement of the staking client's stake() function.
  if (process.env.NODE_ENV !== 'production') {
    console.log('[stake-debug] STAKE_CLIENT_REACHED', {
      pool: opts.poolAddress.toBase58(),
      user: opts.user.toBase58(),
      amount: opts.amount.toString(),
      hasNft: !!opts.nft,
      programId: program.programId.toBase58(),
    })
  }

  const { poolAddress, pool, user, amount, nft } = opts
  const {
    address: userStakingAta,
    needsCreation,
    tokenProgramId: stakingTokenProgram,
  } = await ensureAta(program, pool.stakingMint, user)
  const [userPositionPda] = findUserPositionPda(poolAddress, user, program.programId)
  const [stakingVaultPda] = findStakingVaultPda(poolAddress, program.programId)

  const builder = program.methods.stake(amount).accountsPartial({
    user,
    pool: poolAddress,
    userPosition: userPositionPda,
    stakingMint: pool.stakingMint,
    userStakingTokenAccount: userStakingAta,
    stakingVault: stakingVaultPda,
    stakingTokenProgram,
    systemProgram: SystemProgram.programId,
    // Optional in the IDL: null keeps the stake unboosted.
    userNftTokenAccount: nft ? nft.tokenAccount : null,
    nftMetadataAccount: nft ? nft.metadata : null,
  })

  let tx: Transaction
  if (needsCreation) {
    tx = new Transaction().add(
      ataCreationInstruction(user, userStakingAta, user, pool.stakingMint, stakingTokenProgram),
      await builder.instruction(),
    )
    // TEMPORARY development diagnostic (dev only): immediately before the
    // transaction is signed/sent by the provider (ATA-creation path).
    if (process.env.NODE_ENV !== 'production') {
      console.log('[stake-debug] BEFORE_SEND', { path: 'sendAndConfirm', pool: poolAddress.toBase58(), user: user.toBase58() })
    }
    const signature = await sendWithFreshBlockhash(program, tx)
    // TEMPORARY development diagnostic (dev only): send/sign succeeded.
    if (process.env.NODE_ENV !== 'production') {
      console.log('[stake-debug] AFTER_SEND', { path: 'sendAndConfirm', signature })
    }
    return signature
  }
  // TEMPORARY development diagnostic (dev only): immediately before the
  // transaction is signed/sent by Anchor's .rpc() (plain stake path).
  if (process.env.NODE_ENV !== 'production') {
    console.log('[stake-debug] BEFORE_SEND', { path: 'rpc', pool: poolAddress.toBase58(), user: user.toBase58() })
  }
  tx = await builder.transaction()
  const signature = await sendWithFreshBlockhash(program, tx)
  // TEMPORARY development diagnostic (dev only): send/sign succeeded.
  if (process.env.NODE_ENV !== 'production') {
    console.log('[stake-debug] AFTER_SEND', { path: 'rpc', signature })
  }
  return signature
}

/**
 * Unstake `amount` base units of the pool's staking mint.
 *
 * The account set mirrors the deployed IDL's `unstake` instruction exactly:
 * user, pool, user_position, staking_mint, user_staking_token_account,
 * staking_vault, staking_token_program (the program derives nothing implicitly
 * and Anchor rejects the call with "Account `stakingMint` not provided." when
 * any of them is missing).
 *
 * Pool data comes from the real on-chain `Pool` account (`pool.stakingMint`),
 * and the staking vault is the pool's `staking_vault` PDA - the same accounts
 * plus the SAME token program the mint is actually owned by (classic SPL Token
 * or Token-2022, detected from the mint account - never assumed) that the
 * program validates:
 *   - `staking_mint.key() == pool.staking_mint`
 *   - `staking_vault` = PDA(["staking_vault", pool]) holding pool authority
 *   - `staking_token_program` = mint's owner program
 *
 * Creates the user's staking ATA first if it was closed, since the program
 * requires an owned token account to receive the returned funds.
 */
export async function unstake(
  program: StakingProgram,
  opts: { poolAddress: PublicKey; pool: PoolAccount; user: PublicKey; amount: BN },
): Promise<string> {
  const { poolAddress, pool, user, amount } = opts
  const [userPositionPda] = findUserPositionPda(poolAddress, user, program.programId)
  const {
    address: userStakingAta,
    needsCreation,
    tokenProgramId: stakingTokenProgram,
  } = await ensureAta(program, pool.stakingMint, user)
  const [stakingVaultPda] = findStakingVaultPda(poolAddress, program.programId)

  const builder = program.methods.unstake(amount).accountsPartial({
    user,
    pool: poolAddress,
    userPosition: userPositionPda,
    stakingMint: pool.stakingMint,
    userStakingTokenAccount: userStakingAta,
    stakingVault: stakingVaultPda,
    stakingTokenProgram,
  })

  if (needsCreation) {
    const tx = new Transaction().add(
      ataCreationInstruction(user, userStakingAta, user, pool.stakingMint, stakingTokenProgram),
      await builder.instruction(),
    )
    return program.provider.sendAndConfirm!(tx)
  }
  return builder.rpc()
}

/**
 * Claim accrued rewards. Creates the user's reward ATA first if needed, since
 * the program requires an owned token account to receive reward funds.
 *
 * The deployed `claim_rewards` account set is user, pool, user_position,
 * reward_mint, user_reward_token_account, reward_vault, reward_token_program -
 * all of them are supplied explicitly here. `reward_mint` and
 * `reward_token_program` come from THIS pool (`pool.rewardMint`) and from the
 * program that actually owns that mint (classic SPL Token or Token-2022,
 * detected - never assumed), and the user's reward ATA is derived with the same
 * program.
 */
export async function claimRewards(
  program: StakingProgram,
  opts: { poolAddress: PublicKey; pool: PoolAccount; user: PublicKey },
): Promise<string> {
  const { poolAddress, pool, user } = opts
  const [userPositionPda] = findUserPositionPda(poolAddress, user, program.programId)
  const [rewardVaultPda] = findRewardVaultPda(poolAddress, program.programId)
  const {
    address: userRewardAta,
    needsCreation,
    tokenProgramId: rewardTokenProgram,
  } = await ensureAta(program, pool.rewardMint, user)

  const builder = program.methods.claimRewards().accountsPartial({
    user,
    pool: poolAddress,
    userPosition: userPositionPda,
    rewardMint: pool.rewardMint,
    userRewardTokenAccount: userRewardAta,
    rewardVault: rewardVaultPda,
    rewardTokenProgram,
  })

  if (needsCreation) {
    const tx = new Transaction().add(
      ataCreationInstruction(user, userRewardAta, user, pool.rewardMint, rewardTokenProgram),
      await builder.instruction(),
    )
    return program.provider.sendAndConfirm!(tx)
  }
  return builder.rpc()
}

/**
 * Read a token account's raw balance (base units).
 *
 * Returns 0n ONLY for a genuine zero: the account does not exist
 * (`getAccountInfo` resolved to null - e.g. a reward ATA that was never
 * funded) or it is not owned by a supported token program. RPC/network/read
 * failures are NOT converted into 0n: a rejected `getAccountInfo` (network
 * error, HTTP 429, timeout) and a failing `unpackAccount` (unreadable account
 * data) propagate to the caller, so the UI can show an error state instead of
 * a fabricated zero balance.
 *
 * The token program is taken from the ACCOUNT ITSELF (`accountInfo.owner`),
 * which is the program that owns every token account - classic SPL Token or
 * Token-2022 - so a Token-2022 vault/ATA reads correctly. The account data is
 * unpacked from the single `getAccountInfo` response (no second RPC).
 */
export async function fetchTokenAccountBalance(
  program: StakingProgram,
  tokenAccount: PublicKey,
): Promise<bigint> {
  const accountInfo = await program.provider.connection.getAccountInfo(tokenAccount, 'confirmed')
  if (!accountInfo || !isSupportedTokenProgram(accountInfo.owner)) return BigInt(0)
  const account = unpackAccount(tokenAccount, accountInfo, accountInfo.owner)
  return BigInt(account.amount.toString())
}

/**
 * Fund the pool's reward vault with `amount` base units of the pool's reward
 * mint. The funder's reward associated token account is derived on-chain and
 * created first (in the SAME transaction) when missing, then the signed
 * `fund_rewards` instruction transfers from that ATA into the reward vault PDA.
 *
 * This follows the SAME fresh-blockhash send path already proven by
 * `pausePool()` (NOT Anchor's black-box `.rpc()`): the transaction is stamped
 * with a brand-new `getLatestBlockhash` result immediately before the wallet is
 * asked to sign — never a cached or previously-set blockhash — and both
 * `recentBlockhash` and `lastValidBlockHeight` are pinned, then the signed
 * transaction is sent/confirmed through the raw RPC path with full diagnostics.
 *
 * `reward_token_program` is the program that actually OWNS `pool.rewardMint`
 * (classic SPL Token or Token-2022, detected - never assumed), and the funder's
 * reward ATA is derived/created with that same program.
 */
export async function fundRewards(
  program: StakingProgram,
  opts: { poolAddress: PublicKey; pool: PoolAccount; funder: PublicKey; amount: BN },
): Promise<string> {
  const { poolAddress, pool, funder, amount } = opts
  const [rewardVaultPda] = findRewardVaultPda(poolAddress, program.programId)
  const {
    address: funderRewardAta,
    needsCreation,
    tokenProgramId: rewardTokenProgram,
  } = await ensureAta(program, pool.rewardMint, funder)

  // The wallet-backed provider carries the connected wallet and the same
  // ConfirmOptions that methods.rpc() would have used. Casting to AnchorProvider
  // (instead of the generic Provider interface) gives typed access to `wallet`
  // and `opts`, which the interface does not expose.
  const provider = program.provider as AnchorProvider

  // --- (1) Transaction construction ---------------------------------------
  // Mirrors MethodsBuilder into a Transaction (unsigned, no fee payer /
  // blockhash yet).
  const tx = await program.methods
    .fundRewards(amount)
    .accountsPartial({
      funder,
      pool: poolAddress,
      rewardMint: pool.rewardMint,
      funderRewardTokenAccount: funderRewardAta,
      rewardVault: rewardVaultPda,
      rewardTokenProgram,
    })
    .transaction()

  if (needsCreation) {
    // The funder has no reward ATA yet: create it in the SAME transaction,
    // before the `fund_rewards` transfer, so the wallet signs exactly once.
    tx.instructions.unshift(
      ataCreationInstruction(funder, funderRewardAta, funder, pool.rewardMint, rewardTokenProgram),
    )
  }

  // AnchorProvider.sendAndConfirm() did this internally inside .rpc(); doing it
  // here lets us fetch a FRESH blockhash immediately before wallet signing and
  // pin it (recentBlockhash + lastValidBlockHeight) so no cached or stale
  // blockhash can ever reach the wire.
  tx.feePayer = tx.feePayer ?? provider.publicKey
  const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash(
    provider.opts.preflightCommitment ?? 'confirmed',
  )
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight

  // --- (2) Wallet signing (Solflare popup opens here) ----------------------
  const signedTx = await provider.wallet.signTransaction(tx)

  // --- (3) Transaction submission (raw RPC sendTransaction call) -----------
  const rawTx = signedTx.serialize()

  let signature: string
  try {
    signature = await provider.connection.sendRawTransaction(rawTx, provider.opts)
  } catch (error) {
    console.error('[fundRewards] sendRawTransaction FAILED', describeTxError(error), error)
    throw error
  }

  // --- (4) Transaction confirmation ---------------------------------------
  try {
    const confirmation = await provider.connection.confirmTransaction(
      signature,
      provider.opts.commitment ?? 'confirmed',
    )
    if (confirmation.value.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
    }
  } catch (error) {
    console.error('[fundRewards] confirmTransaction FAILED', describeTxError(error), error)
    throw error
  }

  return signature
}

/** Precompute the pool PDA that `createPool` will initialize. */
export function derivePoolAddress(
  program: StakingProgram,
  authority: PublicKey,
  poolId: BN,
): PublicKey {
  return findPoolPda(authority, poolId, program.programId)[0]
}

/** Returns true when the platform singleton PDA has already been initialized. */
export async function platformExists(program: StakingProgram): Promise<boolean> {
  const [platformPda] = findPlatformPda(program.programId)
  // This read decides whether `initialize_platform` must be prepended to the
  // create-pool transaction, so a dropped connection must not abort an
  // otherwise-valid deployment: transient transport failures are retried.
  // Both real outcomes (exists / missing) are returned without retry.
  const accountInfo = await withRpcRetry(() => program.provider.connection.getAccountInfo(platformPda))
  return accountInfo !== null
}

/**
 * One-time platform setup. No-op (returns null) when already initialized.
 *
 * W5 finding - `fee_bps` is intentionally RETAINED and currently UNUSED:
 * `fee_bps` is the only platform field besides `admin` (the program's
 * `initialize_platform` also validates it <= 10_000 and emits it in
 * `PlatformInitialized`). Nothing reads it: no app code decodes the Platform
 * account beyond its existence (`platformExists` below), the on-chain
 * stake / unstake / claim / fund paths never touch it, and the program exposes
 * no instruction that could change it after initialization. The deployed devnet
 * Platform PDA (3J5W5sdeh1Wj56Keozrx7XSe7E62VtiZhVcxafBxf2nB) stores
 * `fee_bps = 0`.
 *
 * It is deliberately NOT removed: dropping the field would change the on-chain
 * `Platform` layout (32 + 2 + 1) and the IDL, which would require a program
 * migration / re-deploy and would not decode the existing 43-byte account
 * (8-byte discriminator + 35 bytes). It is kept solely for account-layout and
 * IDL compatibility. No protocol fee is, or should be, derived from it.
 *
 * W6 finding - platform initialization is FIRST-COME-FIRST-SERVED, by design:
 * the `platform` PDA is seeded only by `[b"platform"]`, so whichever wallet
 * calls `initialize_platform` first becomes the stored `Platform.admin`. The
 * program has no compile-time deployment authority: `InitializePlatform` takes a
 * plain `Signer` as `admin`, and the only authority the server runtime holds is
 * the server-only `SOLANA_RPC_URL` - an RPC endpoint, not a keypair. The app
 * holds no admin keypair and no config field names one, so there is no canonical
 * authority to constrain this with.
 *
 * This is an intentional architectural limitation, not a bug:
 *   - PRIVILEGED POOL OPERATIONS ARE AUTHORIZED BY THE POOL AUTHORITY, NOT BY
 *     THE PLATFORM ADMIN: `set_pool_boost`, `set_paused`/pause and
 *     `emergency_freeze` each `require!(authority.key() == pool.authority)` on
 *     the pool being touched. `Platform.admin` authorizes nothing today.
 *   - The platform singleton only records `admin` / `fee_bps` / `bump`. It does
 *     NOT gate pool creation (any wallet may create its own pool, and Pool #2's
 *     authority is unaffected), and no app path reads it beyond
 *     `platformExists()` above, which only decides whether this helper's
 *     `initialize_platform` instruction is prepended to a create-pool
 *     transaction.
 *
 * Because a prerequisite (a canonical deployment authority) genuinely does not
 * exist here, none is invented and the on-chain program is left unchanged. If a
 * canonical admin is ever introduced, the minimal safe fix belongs on-chain (a
 * constraint on `InitializePlatform.admin`) rather than in this client.
 */
export async function initializePlatform(
  program: StakingProgram,
  admin: PublicKey,
  feeBps: number,
): Promise<string | null> {
  if (await platformExists(program)) return null
  return program.methods
    .initializePlatform(feeBps)
    .accountsPartial({ admin })
    .rpc()
}

/**
 * Creates a staking pool. When the platform singleton has not been set up yet,
 * its `initialize_platform` instruction is prepended to the SAME transaction so
 * the wallet is asked to sign exactly once (avoiding a stale-blockhash window
 * between two separate round-trips). Returns the pool PDA and signature.
 *
 * Both token programs are detected from the mint accounts that are being passed
 * in (classic SPL Token or Token-2022 - never assumed) and are sent explicitly
 * as the `staking_token_program` / `reward_token_program` accounts. The on-chain
 * instruction requires `mint::token_program = <token program>` for each mint, so
 * these two accounts are exactly the mints' owner programs; any of the four
 * staking/reward token-program combinations is supported.
 */
export async function createPool(
  program: StakingProgram,
  opts: {
    authority: PublicKey
    stakingMint: PublicKey
    rewardMint: PublicKey
    poolId: BN
    lockDurationSeconds: BN
    rewardRatePerSecond: BN
    feeBps?: number
  },
): Promise<{ poolAddress: PublicKey; signature: string }> {
  const { authority, stakingMint, rewardMint, poolId, lockDurationSeconds, rewardRatePerSecond } = opts

  const poolAddress = derivePoolAddress(program, authority, poolId)
  const needsPlatformInit = !(await platformExists(program))

  // Detect (never assume) the program that owns each mint. This throws a
  // user-facing error before anything is signed when an address is not a mint.
  const [stakingTokenProgram, rewardTokenProgram] = await Promise.all([
    resolveMintTokenProgram(program.provider.connection, stakingMint),
    resolveMintTokenProgram(program.provider.connection, rewardMint),
  ])

  const tx = new Transaction()
  if (needsPlatformInit) {
    tx.add(
      await program.methods
        .initializePlatform(opts.feeBps ?? 0)
        .accountsPartial({ admin: authority })
        .instruction(),
    )
  }
  tx.add(
    await program.methods
      .createPool(poolId, lockDurationSeconds, rewardRatePerSecond)
      .accountsPartial({
        authority,
        stakingMint,
        rewardMint,
        stakingTokenProgram,
        rewardTokenProgram,
      })
      .instruction(),
  )

  // --- Fresh-blockhash send path (same approach as fundRewards) ------------
  // AnchorProvider.sendAndConfirm() did this internally inside .rpc(); doing it
  // here lets us fetch a FRESH blockhash immediately before wallet signing and
  // pin it (recentBlockhash + lastValidBlockHeight) so no cached or stale
  // blockhash can ever reach the wire.
  const provider = program.provider as AnchorProvider

  tx.feePayer = tx.feePayer ?? provider.publicKey
  // Fetch at 'confirmed' so the pinned blockhash is already published across the
  // cluster (including every load-balanced RPC backend) before preflight runs.
  const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight

  // --- Wallet signing (Solflare popup opens here) --------------------------
  const signedTx = await provider.wallet.signTransaction(tx)

  // --- Transaction submission (raw RPC sendTransaction call) ---------------
  const rawTx = signedTx.serialize()

  // Immediate preflight-health checks, all on the SAME provider.connection so
  // no other RPC can be involved. Results are not consumed here; the checks
  // remain so the RPC call pattern is unchanged and failures are logged.
  try {
    await provider.connection.getBlockHeight('confirmed')
  } catch (error) {
    console.error('[createPool] getBlockHeight FAILED', describeTxError(error), error)
  }
  try {
    await provider.connection.isBlockhashValid(blockhash, { commitment: 'confirmed' })
  } catch (error) {
    console.error('[createPool] isBlockhashValid FAILED', describeTxError(error), error)
  }

  let signature: string
  try {
    // SAME app-configured Connection/RPC that served getLatestBlockhash above,
    // single attempt, real preflight (never skipPreflight).
    signature = await provider.connection.sendRawTransaction(rawTx, {
      preflightCommitment: 'confirmed',
      skipPreflight: false,
    })
  } catch (error) {
    console.error('[createPool] sendRawTransaction FAILED', describeTxError(error), error)
    throw error
  }

  // --- Transaction confirmation (blockhash + lastValidBlockHeight) ---------
  try {
    const confirmation = await provider.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    if (confirmation.value.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
    }
  } catch (error) {
    console.error('[createPool] confirmTransaction FAILED', describeTxError(error), error)
    throw error
  }

  return { poolAddress, signature }
}
/** Pause or unpause a pool on-chain. */

/**
 * Diagnostic-only helper: flatten every useful field of an error (web3.js
 * `SendTransactionError`, Anchor's `translateError` wrapper, or a plain
 * `Error`) into a serializable object. For a `SendTransactionError` the full
 * `getLogs()` payload is fetched explicitly (the error message itself tells
 * callers to do this) so simulation/program logs always show up in the console
 * diagnostics. The original error is always logged separately and rethrown so
 * nothing is swallowed.
 */
function describeTxError(error: unknown): Record<string, unknown> {
  const description: Record<string, unknown> = {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  }
  if (error instanceof Error && error.stack) description.stack = error.stack
  if (error && typeof error === 'object') {
    const details = error as Record<string, unknown>
    for (const key of [
      "code",
      "data",
      "logs",
      "action",
      "transactionMessage",
      "transactionLogs",
      "signature",
      "cause",
      "error",
    ]) {
      if (key in details) description[key] = details[key]
    }
    // `SendTransactionError` does not expose the logs via a plain property
    // (`logs` is undefined); it stores them on `transactionLogs` and provides
    // `getLogs()`. Call it so future failures expose the full log list.
    if (typeof (error as { getLogs?: unknown }).getLogs === 'function') {
      try {
        description.logs = (error as { getLogs: () => unknown }).getLogs()
      } catch {
        // keep whatever was already copied (data.logs / transactionLogs)
      }
    }
  }
  return description
}

export async function pausePool(
  program: StakingProgram,
  opts: { poolAddress: PublicKey; authority: PublicKey; paused: boolean },
): Promise<string> {
  // The wallet-backed provider carries the connected wallet and the same
  // ConfirmOptions that methods.rpc() would have used. Casting to AnchorProvider
  // (instead of the generic Provider interface) gives typed access to
  // `wallet` and `opts`, which the interface does not expose.
  const provider = program.provider as AnchorProvider

  // --- (1) Transaction construction ---------------------------------------
  // Mirrors MethodsBuilder into a Transaction (unsigned, no fee payer /
  // blockhash yet) before any RPC/signing happens.
  const tx = await program.methods
    .pausePool(opts.paused)
    .accountsPartial({
      authority: opts.authority,
      pool: opts.poolAddress,
    })
    .transaction()

  // AnchorProvider.sendAndConfirm() did this internally inside .rpc(); doing it
  // here pins a fresh blockhash before asking the wallet to sign.
  tx.feePayer = tx.feePayer ?? provider.publicKey
  const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash(
    provider.opts.preflightCommitment ?? 'confirmed',
  )
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight

  // --- (2) Wallet signing (Solflare popup opens here; hangs land here) ----
  const signedTx = await provider.wallet.signTransaction(tx)

  // --- (3) Transaction submission (raw RPC sendTransaction call) ----------
  const rawTx = signedTx.serialize()

  // provider.opts (ConfirmOptions) is structurally assignable to SendOptions,
  // so the same options object used for .rpc() can be passed to
  // Connection.sendRawTransaction below.

  let signature: string
  try {
    signature = await provider.connection.sendRawTransaction(rawTx, provider.opts)
  } catch (error) {
    console.error("[pausePool] sendRawTransaction FAILED", describeTxError(error), error)
    throw error
  }

  // --- (4) Transaction confirmation ---------------------------------------
  let confirmation: Awaited<ReturnType<typeof provider.connection.confirmTransaction>>
  try {
    confirmation = await provider.connection.confirmTransaction(
      signature,
      provider.opts.commitment ?? 'confirmed',
    )
  } catch (error) {
    console.error("[pausePool] confirmTransaction FAILED", describeTxError(error), error)
    throw error
  }
  if (confirmation.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
  }

  // Post-confirmation on-chain read of the pool we just paused.
  //
  // This used to be `program.account.Pool.fetch(opts.poolAddress)`. Anchor 0.30.1
  // camelCases the runtime account namespace (see `runtimeAccountNamespace`
  // above), so `program.account.Pool` is `undefined` and this line threw
  // `Cannot read properties of undefined (reading 'fetch')` AFTER the pause
  // transaction had already been confirmed - the admin UI therefore reported a
  // successful Pause as a failure. `fetchPool` performs the same read through the
  // camelCase client.
  await fetchPool(program, opts.poolAddress)

  return signature
}

/** Freeze or unfreeze a pool on-chain. */
export async function emergencyFreeze(
  program: StakingProgram,
  opts: { poolAddress: PublicKey; authority: PublicKey; frozen: boolean },
): Promise<string> {
  return program.methods
    .emergencyFreeze(opts.frozen)
    .accountsPartial({
      authority: opts.authority,
      pool: opts.poolAddress,
    })
    .rpc()
}

/**
 * Must match `MAX_NFT_BOOST_BPS` in programs/pumpswap-staking/src/lib.rs:
 * 10_000 bps = +100% extra rewards (the on-chain maximum).
 */
const MAX_NFT_BOOST_BPS = 10_000

/**
 * Configure (or clear) a pool's NFT boost on-chain via the deployed
 * `set_pool_boost` instruction.
 *
 * Instruction (verified against lib/solana/idl/pumpswap_staking.json):
 *   name:        set_pool_boost   (typed IDL: `setPoolBoost`)
 *   args:        collection: Pubkey, boost_bps: u16 (typed: boostBps)
 *   accounts:    authority (signer) - must equal `pool.authority` on-chain
 *                pool (writable)
 *
 * The connected wallet signs exactly like the other admin helpers
 * (pausePool / emergencyFreeze). Values are pre-validated here so an
 * out-of-range boost never reaches the chain: `boostBps` must be an integer
 * in [0, MAX_NFT_BOOST_BPS], and a positive boost requires a non-default
 * collection - the same rules `normalize_boost` enforces on-chain
 * (StakingError::InvalidNftBoost). Throws on validation failure or when the
 * transaction fails; returns the transaction signature only on confirmation.
 */
export async function setPoolBoost(
  program: StakingProgram,
  opts: {
    poolAddress: PublicKey
    authority: PublicKey
    collection: PublicKey
    boostBps: number
  },
): Promise<string> {
  if (
    !Number.isInteger(opts.boostBps) ||
    opts.boostBps < 0 ||
    opts.boostBps > MAX_NFT_BOOST_BPS
  ) {
    throw new Error(
      `NFT boost must be a whole number of basis points between 0 and ${MAX_NFT_BOOST_BPS} (+100%).`,
    )
  }
  if (opts.boostBps > 0 && opts.collection.equals(PublicKey.default)) {
    throw new Error(
      'A valid NFT collection address is required when the boost is enabled.',
    )
  }

  return program.methods
    .setPoolBoost(opts.collection, opts.boostBps)
    .accountsPartial({
      authority: opts.authority,
      pool: opts.poolAddress,
    })
    .rpc()
}