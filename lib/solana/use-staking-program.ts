'use client'

import { useEffect, useMemo } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import type { AnchorWallet } from '@solana/wallet-adapter-react'
import type { Transaction, VersionedTransaction } from '@solana/web3.js'

import {
  createReadOnlyStakingProgram,
  createStakingProgram,
  type StakingProgram,
} from '@/lib/solana/program'

export type UseStakingProgramResult = {
  /** Wallet-backed program when connected, otherwise a read-only client. */
  program: StakingProgram | null
  /** Read-only client that is always available (no wallet required). */
  readOnlyProgram: StakingProgram
  /** True when `program` can sign and send transactions. */
  canTransact: boolean
}

/**
 * Returns an Anchor program client for the deployed pumpswap-staking program.
 * While no wallet is connected, `program` is a read-only client that can fetch
 * and deserialize accounts but never sends transactions.
 *
 * Wallet detection is deliberately based on `useWallet()` rather than
 * `useAnchorWallet()`: that helper only returns a wallet when publicKey,
 * signTransaction AND signAllTransactions are all present. Wallet Standard
 * adapters (Solflare registers one, and `WalletProvider` prefers it over the
 * legacy `SolflareWalletAdapter`) publish `signTransaction` /
 * `signAllTransactions` only while the connected account advertises the
 * `solana:signTransaction` feature, and the adapter deletes the method
 * otherwise. That AND-gate made a genuinely connected wallet look absent and
 * silently downgraded every transaction path to the read-only client.
 *
 * The stake / unstake / claim path only ever calls `provider.sendAndConfirm`
 * (single transaction -> `wallet.signTransaction`), so `signTransaction` is the
 * only strictly required capability. When an adapter exposes
 * `signTransaction` without `signAllTransactions`, the batch signer is derived
 * from that same `signTransaction`, so Anchor always receives a complete
 * `AnchorWallet`. Nothing here fabricates a keypair: every signature still
 * goes through the user's own wallet.
 */
export function useStakingProgram(): UseStakingProgramResult {
  const { connection } = useConnection()
  const { connected, publicKey, signTransaction, signAllTransactions } = useWallet()

  const readOnlyProgram = useMemo(() => createReadOnlyStakingProgram(connection), [connection])

  const anchorWallet = useMemo<AnchorWallet | null>(() => {
    if (!connected || !publicKey || !signTransaction) return null

    const batchSigner =
      signAllTransactions ??
      (async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
        const signed: T[] = []
        for (const tx of txs) {
          signed.push(await signTransaction(tx))
        }
        return signed
      })

    return {
      publicKey,
      signTransaction: signTransaction as AnchorWallet['signTransaction'],
      signAllTransactions: batchSigner as AnchorWallet['signAllTransactions'],
    }
  }, [connected, publicKey, signTransaction, signAllTransactions])

  const program = useMemo(
    () => (anchorWallet ? createStakingProgram(connection, anchorWallet) : readOnlyProgram),
    [anchorWallet, connection, readOnlyProgram],
  )

  // TEMPORARY diagnostic (dev only, stripped from production builds).
  // Confirms the full wallet -> Anchor provider chain in the browser console.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    const provider = program?.provider as { wallet?: AnchorWallet } | undefined
    console.log('[staking-program] provider diagnostics', {
      walletConnected: connected,
      walletPublicKey: publicKey?.toBase58() ?? null,
      hasSignTransaction: !!signTransaction,
      hasSignAllTransactions: !!signAllTransactions,
      anchorWalletReady: !!anchorWallet,
      providerWalletPublicKey: provider?.wallet?.publicKey?.toBase58() ?? null,
      canTransact: !!anchorWallet,
      programMode: anchorWallet ? 'wallet' : 'read-only',
    })
  }, [
    connected,
    publicKey,
    signTransaction,
    signAllTransactions,
    anchorWallet,
    program,
  ])

  return { program, readOnlyProgram, canTransact: !!anchorWallet }
}
