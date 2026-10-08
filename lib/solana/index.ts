export {
  getConfiguredNetwork,
  getNetworkLabel,
  getClientRpcEndpoint,
  getServerRpcEndpoint,
  type SolanaNetworkId,
} from '@/lib/solana/network'
export { createBrowserConnection, createServerConnection, checkRpcHealth } from '@/lib/solana/connection'
export {
  fetchTokenMintInfo,
  validateSplTokenMint,
  enrichTokenMetadata,
  type TokenMintInfo,
  type TokenMintValidationResult,
  type TokenMetadataExtension,
} from '@/lib/solana/token'
export {
  getUserFacingWalletError,
  getUserFacingMintError,
  getUserFacingTxError,
  getInsufficientSolMessage,
} from '@/lib/solana/errors'
export { shortenAddress, formatSolBalance, tryParsePublicKey, copyTextToClipboard } from '@/lib/solana/format'
export {
  STAKING_PROGRAM_ID,
  createStakingProgram,
  createReadOnlyStakingProgram,
  type StakingProgram,
} from '@/lib/solana/program'
export {
  findPlatformPda,
  findPoolPda,
  findStakingVaultPda,
  findRewardVaultPda,
  findUserPositionPda,
  type PdaResult,
} from '@/lib/solana/pda'
export { useStakingProgram, type UseStakingProgramResult } from '@/lib/solana/use-staking-program'
export { getDefaultPoolAddress } from '@/lib/solana/config'
export {
  fetchPool,
  fetchUserPosition,
  ensureAta,
  stake,
  unstake,
  claimRewards,
  fetchTokenAccountBalance,
  fundRewards,
  computeUpdatedRewardPerToken,
  computePendingRewards,
  initializePlatform,
  createPool,
  platformExists,
  derivePoolAddress,
  type PoolAccount,
  type UserPositionAccount,
} from '@/lib/solana/ops'
