import { AnchorProvider, Program } from '@coral-xyz/anchor'
import type { Connection } from '@solana/web3.js'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import type { AnchorWallet } from '@solana/wallet-adapter-react'

import stakingIdl from '@/lib/solana/idl/pumpswap_staking.json'
import type { PumpswapStaking } from '@/lib/solana/idl/pumpswap-staking'

/** On-chain address of the deployed pumpswap-staking Anchor program. */
export const STAKING_PROGRAM_ID: PublicKey = new PublicKey(
  process.env.NEXT_PUBLIC_STAKING_PROGRAM_ID?.trim() || stakingIdl.address,
)

export type StakingProgram = Program<PumpswapStaking>

function buildIdl(): PumpswapStaking {
  // Allow the program id to be overridden per environment without rebuilding
  // the IDL artifact (e.g. a localnet clone with a different address).
  return {
    ...stakingIdl,
    address: STAKING_PROGRAM_ID.toBase58(),
  } as unknown as PumpswapStaking
}

/**
 * Wallet-backed program client. Use for instructions that require the user's
 * signature (stake, unstake, claim, create_pool, ...).
 */
export function createStakingProgram(connection: Connection, wallet: AnchorWallet): StakingProgram {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  })
  return new Program<PumpswapStaking>(buildIdl(), provider)
}

/** Minimal wallet shim that only supports reading; signing always rejects. */
const READ_ONLY_WALLET: AnchorWallet = {
  publicKey: PublicKey.default,
  signTransaction: async <T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> => {
    throw new Error('Read-only program cannot sign transactions')
  },
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
    throw new Error('Read-only program cannot sign transactions')
  },
}

/**
 * Read-only program client for fetching/deserializing accounts (pools,
 * positions, platform config) when no wallet is connected.
 */
export function createReadOnlyStakingProgram(connection: Connection): StakingProgram {
  const provider = new AnchorProvider(connection, READ_ONLY_WALLET, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  })
  return new Program<PumpswapStaking>(buildIdl(), provider)
}
