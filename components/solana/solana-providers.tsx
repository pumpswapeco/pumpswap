'use client'

import { useMemo } from 'react'
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare'
import { getClientRpcEndpoint, getConfiguredNetwork } from '@/lib/solana/network'
import { rpcConnectionConfig } from '@/lib/solana/connection'

import '@solana/wallet-adapter-react-ui/styles.css'

function networkToAdapterNetwork(network: ReturnType<typeof getConfiguredNetwork>): WalletAdapterNetwork {
  switch (network) {
    case 'mainnet-beta':
      return WalletAdapterNetwork.Mainnet
    case 'testnet':
      return WalletAdapterNetwork.Testnet
    default:
      return WalletAdapterNetwork.Devnet
  }
}

export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const network = useMemo(() => getConfiguredNetwork(), [])
  const endpoint = useMemo(() => getClientRpcEndpoint(network), [network])
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter({ network: networkToAdapterNetwork(network) }),
      new SolflareWalletAdapter({ network: networkToAdapterNetwork(network) }),
    ],
    [network],
  )

  return (
    <ConnectionProvider endpoint={endpoint} config={rpcConnectionConfig}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
