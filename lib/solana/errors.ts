import { WalletError, WalletNotReadyError, WalletSignTransactionError } from '@solana/wallet-adapter-base'
import { isTransientRpcError } from '@/lib/solana/transport'

export function getUserFacingWalletError(error: unknown): string {
  if (error instanceof WalletNotReadyError) {
    return 'No Solana wallet was detected. Install Phantom or Solflare, then try again.'
  }

  if (error instanceof WalletSignTransactionError) {
    return 'The wallet declined the request. No changes were made.'
  }

  if (error instanceof WalletError) {
    const message = error.message ?? ''
    if (/user rejected|rejected/i.test(message)) {
      return 'Connection was cancelled in your wallet.'
    }
    if (/not installed|not found/i.test(message)) {
      return 'No Solana wallet was detected. Install Phantom or Solflare, then try again.'
    }
    return message || 'Something went wrong with your wallet. Please try again.'
  }

  if (error instanceof Error) {
    if (/user rejected|rejected/i.test(error.message)) {
      return 'Connection was cancelled in your wallet.'
    }
    return error.message
  }

  return 'Something went wrong with your wallet. Please try again.'
}

export function getUserFacingMintError(error: unknown): string {
  if (error instanceof Error) {
    if (/invalid public key/i.test(error.message)) {
      return 'That mint address is not valid. Paste a full Solana token mint address.'
    }
    if (/could not find account|account does not exist/i.test(error.message)) {
      return 'No token mint was found at that address on this network.'
    }
  }
  return 'We could not validate that token mint. Check the address and network, then try again.'
}

export function getInsufficientSolMessage(): string {
  return 'Your wallet does not have enough SOL on this network to pay transaction fees.'
}

/** Custom program error codes from programs/pumpswap-staking/src/lib.rs (6000-based). */
const STAKING_ERROR_MESSAGES: Record<number, string> = {
  6000: 'This pool is paused. New staking deposits are temporarily disabled — unstaking and claiming rewards are still available.',
  6001: 'This pool is emergency frozen. New staking deposits are disabled — unstaking and claiming rewards are still available.',
  6002: 'The amount entered is not valid.',
  6003: 'Invalid lock duration.',
  6004: 'Invalid reward rate.',
  6005: 'Invalid platform fee.',
  6006: 'You do not have enough staked to unstake that amount.',
  6007: 'Your stake is still locked. The lock duration has not been met yet.',
  6008: 'There are no rewards available to claim yet.',
  6009: 'The pool reward vault does not have enough funds to pay rewards right now.',
  6010: 'A math overflow occurred. Please try a smaller amount.',
  6011: 'You are not authorized to perform this action on this pool.',
  6012: 'The token mint does not match this pool.',
  6013: 'The token account is not owned by the expected wallet.',
  6014: 'The account does not belong to this pool.',
  6015: 'Only the pool authority can change this pool’s NFT boost settings.',
  6016: 'The NFT boost value is not valid. Enter a boost of at most 10000 basis points (100%), and provide a collection address whenever the boost is greater than 0.',
  6017: 'This pool has an NFT boost enabled, so staking requires an NFT. Select an NFT from your wallet and try again.',
  6018: 'The NFT token account provided for this NFT is not valid. Re-select the NFT and try again.',
  6019: 'The selected NFT does not belong to the wallet that is staking. Switch to the wallet that owns the NFT, or select an NFT you own.',
  6020: 'The selected NFT token account is empty — it holds no tokens. Select an NFT you actually hold in your wallet.',
  6021: 'The NFT metadata does not match the selected NFT. Re-select the NFT so its own metadata is used.',
  6022: 'The selected NFT has no collection in its metadata, so it cannot earn this pool’s NFT boost. Choose an NFT that belongs to this pool’s collection.',
  6023: 'The selected NFT’s collection is not verified. The collection authority must verify the NFT’s collection before it can earn this pool’s NFT boost.',
  6024: 'The selected NFT belongs to a different collection than this pool requires. Choose an NFT from this pool’s collection.',
}

/**
 * Maps an Anchor/transaction error from a staking instruction to a
 * user-facing message. Falls back to the wallet error mapper for rejections.
 */
export function getUserFacingTxError(error: unknown): string {
  const anchorCode = (error as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code
  if (anchorCode) {
    const normalized = anchorCode.toLowerCase()
    const match = Object.entries(STAKING_ERROR_MESSAGES).find(([code]) => {
      const enumName = STAKING_ERROR_ENUM[Number(code)]
      return enumName?.toLowerCase() === normalized
    })
    if (match) return match[1]
  }

  // `SendTransactionError` from @solana/web3.js: call getLogs() (the message
  // only embeds the last 10 lines) and preserve the full original message so
  // the underlying failure is never hidden.
  if (error instanceof Error && typeof (error as { getLogs?: unknown }).getLogs === 'function') {
    const message = error.message
    try {
      const logs = (error as unknown as { getLogs: () => string[] }).getLogs()
      if (logs && logs.length > 0) {
        return `${message}\n\nProgram logs:\n${logs.join('\n')}`
      }
    } catch {
      // Logs unavailable — fall through and keep the original message.
    }
    return message
  }

  if (error instanceof Error) {
    const codeMatch = error.message.match(/custom program error:\s*0x([0-9a-f]+)/i)
    if (codeMatch) {
      const code = Number.parseInt(codeMatch[1], 16)
      const mapped = STAKING_ERROR_MESSAGES[code]
      if (mapped) return mapped
    }
    if (/user rejected|rejected/i.test(error.message)) {
      return 'Transaction was cancelled in your wallet.'
    }
    if (/insufficient funds|0x1$/i.test(error.message)) {
      return getInsufficientSolMessage()
    }
    // A transport-level RPC failure (connection dropped, timeout, proxy 502,
    // rate limited) happened BEFORE anything reached the chain. Say that
    // plainly instead of letting a raw `TypeError: fetch failed` stand alone —
    // and keep the technical detail so the real reason is never hidden.
    if (isTransientRpcError(error)) {
      return (
        'Could not reach the Solana network — the RPC request failed before the transaction was sent. ' +
        'This is a connectivity issue, not a problem with your inputs. Please try again in a moment.' +
        `\n\nTechnical details: ${error.message}`
      )
    }
    return error.message
  }

  return 'The transaction failed. Please try again.'
}

/** Enum-name lookup for the same error codes, used when Anchor returns camelCase names. */
const STAKING_ERROR_ENUM: Record<number, string> = {
  6000: 'PoolPaused',
  6001: 'PoolFrozen',
  6002: 'InvalidAmount',
  6003: 'InvalidLockDuration',
  6004: 'InvalidRewardRate',
  6005: 'InvalidFeeBps',
  6006: 'InsufficientStakedAmount',
  6007: 'LockDurationNotMet',
  6008: 'NoRewardsToClaim',
  6009: 'InsufficientRewardVaultBalance',
  6010: 'MathOverflow',
  6011: 'Unauthorized',
  6012: 'InvalidMint',
  6013: 'InvalidOwner',
  6014: 'InvalidPool',
  6015: 'UnauthorizedNftBoostUpdate',
  6016: 'InvalidNftBoost',
  6017: 'NftBoostRequiresNft',
  6018: 'InvalidNftTokenAccount',
  6019: 'NftNotOwnedByUser',
  6020: 'NftNoBalance',
  6021: 'NftMetadataMismatch',
  6022: 'NftCollectionMissing',
  6023: 'NftCollectionUnverified',
  6024: 'WrongNftCollection',
}
