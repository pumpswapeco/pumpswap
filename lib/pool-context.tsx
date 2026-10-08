'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { WalletAdapterNetwork, type WalletError } from '@solana/wallet-adapter-base'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { checkRpcHealth } from '@/lib/solana/connection'
import { getUserFacingWalletError, getUserFacingTxError} from '@/lib/solana/errors'
import { formatSolBalance, shortenAddress, tryParsePublicKey } from '@/lib/solana/format'
import { getConfiguredNetwork, getNetworkLabel } from '@/lib/solana/network'
import { useStakingProgram } from "@/lib/solana/use-staking-program"
import { getDefaultPoolAddress } from '@/lib/solana/config'
import { emergencyFreeze, fetchPool, pausePool } from '@/lib/solana/ops'
import {
  loadSelectedPoolAddress,
  saveSelectedPoolAddress,
} from '@/lib/solana/selected-pool'
import { invalidatePoolStats, usePoolStats } from '@/lib/solana/use-pool-stats'


export type LockState = 'active' | 'paused' | 'frozen'

/** A confirmed admin (pool-authority) transaction, shown with an explorer link. */
export type AdminTxRecord = { label: string; signature: string }

type RpcStatus = 'checking' | 'ok' | 'error'

type PoolContextValue = {
  lockState: LockState
  isLocked: boolean
  lockReason: string | null
  pauseGlobal: () => void
  triggerFreeze: () => void
  restore: () => void
  /**
   * Confirmed pause / freeze / restore transactions from this session, newest
   * first. Only populated AFTER the transaction confirms on-chain, so the
   * admin UI can link each one to Solana Explorer. Cleared when the selected
   * pool changes.
   */
  lastAdminTxs: AdminTxRecord[] | null
  /** The currently selected pool (null when none selected yet). */
  poolAddress: PublicKey | null
  /** Selects the active pool used by every pool-scoped operation. */
  selectPool: (pool: PublicKey | null) => void
  walletConnected: boolean
  walletAddress: string
  solBalanceLamports: number | null
  solBalanceFormatted: string | null
  solBalanceLoading: boolean
  walletError: string | null
  clearWalletError: () => void
  connectWallet: () => Promise<void>
  disconnectWallet: () => Promise<void>
  networkLabel: string
  rpcStatus: RpcStatus
  rpcError: string | null
  isWrongNetwork: boolean
  walletReady: boolean
}

const PoolContext = createContext<PoolContextValue | null>(null)

function expectedAdapterNetwork(): WalletAdapterNetwork {
  switch (getConfiguredNetwork()) {
    case 'mainnet-beta':
      return WalletAdapterNetwork.Mainnet
    case 'testnet':
      return WalletAdapterNetwork.Testnet
    default:
      return WalletAdapterNetwork.Devnet
  }
}

export function PoolProvider({ children }: { children: React.ReactNode }) {
  const [lockState, setLockState] = useState<LockState>('active')
  const [lastAdminTxs, setLastAdminTxs] = useState<AdminTxRecord[] | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [rpcStatus, setRpcStatus] = useState<RpcStatus>('checking')
  const [rpcError, setRpcError] = useState<string | null>(null)
  const [solBalanceLamports, setSolBalanceLamports] = useState<number | null>(null)
  const [solBalanceLoading, setSolBalanceLoading] = useState(false)
  const [walletReady, setWalletReady] = useState(false)

  const { connection } = useConnection()
  const { publicKey, connected, disconnect, wallet } = useWallet()
  const { setVisible } = useWalletModal()
  const { program, readOnlyProgram, canTransact } = useStakingProgram()
  /**
   * Source of truth for the "currently selected pool". Every pool-scoped
   * operation (pause / freeze / restore, fund rewards, pending rewards,
   * activity, TVL history) reads this address. NEXT_PUBLIC_DEFAULT_POOL_ADDRESS
   * is used only as the initial / fallback selection for backwards
   * compatibility - once a pool is explicitly selected on /pools, operations
   * never silently target the env-default pool.
   */
  const [poolAddress, setPoolAddress] = useState<PublicKey | null>(() => getDefaultPoolAddress())

  /**
   * Tracks the user's own deliberate selection (this session + wallet) so the
   * wallet -> owned-pool discovery below never overwrites a manual choice
   * (e.g. a founder who explicitly switches to a pool they do not own in order
   * to view it). A restored-from-storage selection or the bootstrap default is
   * NOT an explicit in-session pick.
   */
  const explicitSelectionRef = useRef<{ wallet: string; pool: string | null } | null>(null)

  /**
   * Internal setter (state + persistence). `userInitiated` marks manual picks;
   * auto-discovery passes `false` so a later wallet connect / page load can
   * still re-apply the wallet-ownership rules.
   */
  const applySelectedPool = useCallback(
    (pool: PublicKey | null, userInitiated: boolean) => {
      if (userInitiated) {
        explicitSelectionRef.current = {
          wallet: publicKey ? publicKey.toBase58() : "",
          pool: pool ? pool.toBase58() : null,
        }
      }
      setPoolAddress(pool)
      saveSelectedPoolAddress(pool ? pool.toBase58() : null)
    },
    [publicKey],
  )

  /**
   * Selects the active pool used by every pool-scoped operation AND persists
   * the selection so it survives navigation and full page reloads. The selected
   * pool is never silently replaced by the env default once the user has
   * explicitly picked one.
   */
  const selectPool = useCallback((pool: PublicKey | null) => {
    applySelectedPool(pool, true)
  }, [applySelectedPool])

  // Admin transaction records are pool-scoped: switching pools clears them so
  // explorer links never point at another pool's session.
  useEffect(() => {
    setLastAdminTxs(null)
  }, [poolAddress])

  /**
   * Hydration restore: re-apply the user's persisted pool selection. Runs only
   * on the client after mount (so SSR and the first client paint always match
   * the bootstrap default - no hydration mismatch). The persisted address is
   * validated against the on-chain program before being accepted; if it no
   * longer exists on-chain the bootstrap default is kept. Never select a pool
   * that does not exist on-chain, and never tie the selection to the wallet.
   */
  useEffect(() => {
    if (typeof window === "undefined") return
    const persisted = loadSelectedPoolAddress()
    if (!persisted) return
    const persistedKey = tryParsePublicKey(persisted)
    if (!persistedKey) return

    let cancelled = false
    void (async () => {
      try {
        await fetchPool(readOnlyProgram, persistedKey)
        if (!cancelled) setPoolAddress(persistedKey)
      } catch {
        // Persisted pool no longer exists on-chain: keep the bootstrap default.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [readOnlyProgram])

  const poolStats = usePoolStats()

  /**
   * WALLET -> OWNED-POOL DISCOVERY.
   *
   * Root cause of the "founder console still operates Pool #1": before this
   * effect the selected pool was only ever the bootstrap default
   * (NEXT_PUBLIC_DEFAULT_POOL_ADDRESS) or the localStorage-persisted value,
   * neither of which was reconciled with the connected wallet. So connecting
   * the Every Woman project wallet left the console silently operating Pool #1.
   *
   * Rules (only apply while a wallet is connected and the real on-chain pool
   * list is loaded):
   *   - exactly ONE pool whose Pool.authority == wallet  -> auto-select it
   *   - MULTIPLE owned pools -> keep the current selection only when it is one
   *     of the owned pools; otherwise clear to null so a pool selector is shown
   *   - ZERO owned pools -> never silently operate the env default; clear the
   *     bootstrap default (an explicit user pick is kept)
   * A user's explicit in-session pick (selectPool) is always authoritative and
   * is never overwritten by this effect.
   */
  const bootstrapDefaultPoolB58 = useMemo(() => {
    const fallback = getDefaultPoolAddress()
    return fallback ? fallback.toBase58() : null
  }, [])

  useEffect(() => {
    if (!publicKey) return
    if (poolStats.loading || poolStats.error) return

    const walletB58 = publicKey.toBase58()
    const currentB58 = poolAddress?.toBase58()
    const owned = poolStats.pools.filter((p) => p.authority === walletB58)

    const explicit = explicitSelectionRef.current
    const explicitForThisWallet =
      explicit !== null && explicit.wallet === walletB58 && explicit.pool === currentB58

    if (owned.length === 1) {
      // Founder with a single pool: operate that pool (unless the user just
      // explicitly overrode it this session).
      if (!explicitForThisWallet && currentB58 !== owned[0].address) {
        applySelectedPool(new PublicKey(owned[0].address), false)
      }
      return
    }

    if (owned.length > 1) {
      // Multi-pool founder: keep the selection only when it is an owned pool;
      // otherwise expose the selector instead of silently using the env default.
      const currentOwned = currentB58 !== null && owned.some((p) => p.address === currentB58)
      if (!currentOwned && !explicitForThisWallet) {
        applySelectedPool(null, false)
      }
      return
    }

    // Zero owned pools: never silently target the bootstrap default while a
    // wallet is connected. A user's explicit pick stays authoritative.
    if (explicitForThisWallet) return
    if (currentB58 !== null && currentB58 === bootstrapDefaultPoolB58) {
      applySelectedPool(null, false)
    }
  }, [
    publicKey,
    poolStats.loading,
    poolStats.error,
    poolStats.pools,
    poolAddress,
    applySelectedPool,
    bootstrapDefaultPoolB58,
  ])

  /**
   * When the selected pool changes, reset the local lock banner so the on-chain
   * sync effect below re-reads the newly selected pool's paused / frozen flags
   * instead of leaking the previous pool's lock state.
   */
  useEffect(() => {
    setLockState('active')
  }, [poolAddress?.toBase58() ?? ''])

  /**
   * Keep the local lock UI in sync with the real on-chain pool flags. The lock
   * is a genuinely on-chain property (Pool.paused / Pool.frozen), so after a
   * fresh RPC read the banner / circuit breaker must reflect it even after a
   * page refresh. Local state set by pause/freeze/restore is only ever
   * overridden here when it is still "active" (i.e. never fights a lock the
   * admin just applied).
   */
  useEffect(() => {
    if (poolStats.loading || poolStats.error) return
    const poolB58 = poolAddress?.toBase58()
    const onChain = poolB58
      ? poolStats.pools.find((p) => p.address === poolB58)?.status
      : undefined
    if (!onChain || onChain === "Active") return
    const onChainLock = onChain.toLowerCase() as LockState
    setLockState((prev) => (prev === "active" ? onChainLock : prev))
  }, [poolStats, poolAddress])

  useEffect(() => {
    setWalletReady(true)
  }, [])

  const networkLabel = useMemo(() => getNetworkLabel(getConfiguredNetwork()), [])

  useEffect(() => {
    let cancelled = false

    async function pingRpc() {
      setRpcStatus('checking')
      setRpcError(null)
      const result = await checkRpcHealth(connection)
      if (cancelled) return
      if (result.ok) {
        setRpcStatus('ok')
      } else {
        setRpcStatus('error')
        setRpcError(result.message)
      }
    }

    void pingRpc()
    const interval = setInterval(() => void pingRpc(), 60_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [connection])

  useEffect(() => {
    if (!publicKey) {
      setSolBalanceLamports(null)
      setSolBalanceLoading(false)
      return
    }

    const walletPublicKey = publicKey
    let cancelled = false

    async function loadBalance() {
      setSolBalanceLoading(true)
      try {
        const lamports = await connection.getBalance(walletPublicKey, 'confirmed')
        if (cancelled) return
        setSolBalanceLamports(lamports)
      } catch (error) {
        if (cancelled) return
        setSolBalanceLamports(null)
        setWalletError(getUserFacingWalletError(error))
      } finally {
        if (!cancelled) setSolBalanceLoading(false)
      }
    }

    void loadBalance()
    const interval = setInterval(() => void loadBalance(), 30_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [connection, publicKey])

  useEffect(() => {
    if (!wallet?.adapter) return
    const adapter = wallet.adapter

    const onError = (error: WalletError) => {
      setWalletError(getUserFacingWalletError(error))
    }
    const onDisconnect = () => {
      setSolBalanceLamports(null)
    }

    adapter.on('error', onError)
    adapter.on('disconnect', onDisconnect)
    return () => {
      adapter.off('error', onError)
      adapter.off('disconnect', onDisconnect)
    }
  }, [wallet])

  const isWrongNetwork = useMemo(() => {
    if (!connected || !wallet) return false
    // The base `Adapter` type does not declare `network`; read it defensively
    // since wallet adapters that target a specific cluster expose it.
    const adapterNetwork = (wallet.adapter as unknown as { network?: WalletAdapterNetwork })
      .network
    if (!adapterNetwork) return false
    return adapterNetwork !== expectedAdapterNetwork()
  }, [connected, wallet])

  useEffect(() => {
    if (isWrongNetwork) {
      setWalletError(
        `Your wallet is on a different network than PumpSwap (${networkLabel}). Switch your wallet to ${networkLabel} and reconnect.`,
      )
    }
  }, [isWrongNetwork, networkLabel])

 const pauseGlobal = useCallback(async () => {
  if (!program || !canTransact || !publicKey || !poolAddress) {
    setWalletError(
      "Connect the pool authority wallet and select the pool on /pools before pausing it.",
    )
    return
  }

  try {
    const signature = await pausePool(program, {
      poolAddress,
      authority: publicKey,
      paused: true,
    })
    setLastAdminTxs([{ label: 'pause_pool', signature }])
    setLockState("paused")
    invalidatePoolStats()
  } catch (error) {
    setWalletError(getUserFacingTxError(error))
  }
}, [program, canTransact, publicKey, poolAddress])
  const triggerFreeze = useCallback(async () => {
  if (!program || !canTransact || !publicKey || !poolAddress) {
    setWalletError(
      "Connect the pool authority wallet and select the pool on /pools before freezing it.",
    )
    return
  }

  try {
    const signature = await emergencyFreeze(program, {
      poolAddress,
      authority: publicKey,
      frozen: true,
    })
    setLastAdminTxs([{ label: 'emergency_freeze', signature }])
    setLockState("frozen")
    invalidatePoolStats()
  } catch (error) {
    setWalletError(getUserFacingTxError(error))
  }
}, [program, canTransact, publicKey, poolAddress])


const restore = useCallback(async () => {
  if (!program || !canTransact || !publicKey || !poolAddress) {
    setWalletError(
      "Connect the pool authority wallet and select the pool on /pools before restoring it.",
    )
    return
  }

  try {
    const unpauseSignature = await pausePool(program, {
      poolAddress,
      authority: publicKey,
      paused: false,
    })

    const unfreezeSignature = await emergencyFreeze(program, {
      poolAddress,
      authority: publicKey,
      frozen: false,
    })

    setLastAdminTxs([
      { label: 'emergency_freeze (unfreeze)', signature: unfreezeSignature },
      { label: 'pause_pool (unpause)', signature: unpauseSignature },
    ])
    setLockState("active")
    invalidatePoolStats()
  } catch (error) {
    setWalletError(getUserFacingTxError(error))
  }
}, [program, canTransact, publicKey, poolAddress])






  const clearWalletError = useCallback(() => setWalletError(null), [])

  const connectWallet = useCallback(async () => {
    setWalletError(null)
    try {
      setVisible(true)
    } catch (error) {
      setWalletError(getUserFacingWalletError(error))
    }
  }, [setVisible])

  const disconnectWallet = useCallback(async () => {
    setWalletError(null)
    try {
      await disconnect()
    } catch (error) {
      setWalletError(getUserFacingWalletError(error))
    }
  }, [disconnect])

  const walletConnected = connected && !!publicKey
  const walletAddress = publicKey ? shortenAddress(publicKey.toBase58()) : ''
  const solBalanceFormatted =
    solBalanceLamports !== null ? formatSolBalance(solBalanceLamports) : null

  const value = useMemo<PoolContextValue>(() => {
    const lockReason =
      lockState === 'paused'
        ? 'New staking deposits are temporarily disabled by the pool administrator. You can still unstake your position and claim accrued rewards.'
        : lockState === 'frozen'
          ? 'Emergency freeze active — new staking deposits are disabled pending administrator review. You can still unstake your position and claim accrued rewards.'
          : null

    return {
      lockState,
      isLocked: lockState !== 'active',
      lockReason,
      pauseGlobal,
      triggerFreeze,
      restore,
      lastAdminTxs,
      poolAddress,
      selectPool,
      walletConnected,
      walletAddress,
      solBalanceLamports,
      solBalanceFormatted,
      solBalanceLoading,
      walletError,
      clearWalletError,
      connectWallet,
      disconnectWallet,
      networkLabel,
      rpcStatus,
      rpcError,
      isWrongNetwork,
      walletReady,
    }
  }, [
    lockState,
    pauseGlobal,
    triggerFreeze,
    restore,
    lastAdminTxs,
    poolAddress,
    selectPool,
    walletConnected,
    walletAddress,
    solBalanceLamports,
    solBalanceFormatted,
    solBalanceLoading,
    walletError,
    clearWalletError,
    connectWallet,
    disconnectWallet,
    networkLabel,
    rpcStatus,
    rpcError,
    isWrongNetwork,
    walletReady,
  ])

  return <PoolContext.Provider value={value}>{children}</PoolContext.Provider>
}

export function usePool() {
  const ctx = useContext(PoolContext)
  if (!ctx) throw new Error('usePool must be used within a PoolProvider')
  return ctx
}

/** Safe hook when PoolProvider may render before wallet adapters hydrate. */
export function usePoolOptional() {
  return useContext(PoolContext)
}
