import { PublicKey } from '@solana/web3.js'
import { STAKING_PROGRAM_ID } from '@/lib/solana/program'

const textEncoder = new TextEncoder()

function seed(value: string): Uint8Array {
  return textEncoder.encode(value)
}

function u64ToLeBytes(value: number | bigint): Uint8Array {
  let remaining = BigInt(value)
  if (remaining < BigInt(0) || remaining > BigInt('18446744073709551615')) {
    throw new RangeError(`Value ${value} does not fit into u64`)
  }
  const out = new Uint8Array(8)
  const byteMask = BigInt(0xff)
  for (let i = 0; i < 8; i++) {
    out[i] = Number(remaining & byteMask)
    remaining >>= BigInt(8)
  }
  return out
}

export type PdaResult = readonly [PublicKey, number]

/** seeds = [b"platform"] */
export function findPlatformPda(programId: PublicKey = STAKING_PROGRAM_ID): PdaResult {
  return PublicKey.findProgramAddressSync([seed('platform')], programId)
}

/** seeds = [b"pool", authority, pool_id (u64 LE)] */
export function findPoolPda(
  authority: PublicKey,
  poolId: number | bigint,
  programId: PublicKey = STAKING_PROGRAM_ID,
): PdaResult {
  return PublicKey.findProgramAddressSync(
    [seed('pool'), authority.toBytes(), u64ToLeBytes(poolId)],
    programId,
  )
}

/** seeds = [b"staking_vault", pool] */
export function findStakingVaultPda(pool: PublicKey, programId: PublicKey = STAKING_PROGRAM_ID): PdaResult {
  return PublicKey.findProgramAddressSync([seed('staking_vault'), pool.toBytes()], programId)
}

/** seeds = [b"reward_vault", pool] */
export function findRewardVaultPda(pool: PublicKey, programId: PublicKey = STAKING_PROGRAM_ID): PdaResult {
  return PublicKey.findProgramAddressSync([seed('reward_vault'), pool.toBytes()], programId)
}

/** seeds = [b"user_position", pool, user] */
export function findUserPositionPda(
  pool: PublicKey,
  user: PublicKey,
  programId: PublicKey = STAKING_PROGRAM_ID,
): PdaResult {
  return PublicKey.findProgramAddressSync(
    [seed('user_position'), pool.toBytes(), user.toBytes()],
    programId,
  )
}
