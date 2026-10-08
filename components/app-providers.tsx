'use client'

import dynamic from 'next/dynamic'
import { PoolProvider } from '@/lib/pool-context'

const SolanaProvidersDynamic = dynamic(
  () => import('@/components/solana/solana-providers').then((mod) => mod.SolanaProviders),
  { ssr: false }
)

export default function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <SolanaProvidersDynamic>
      <PoolProvider>{children}</PoolProvider>
    </SolanaProvidersDynamic>
  )
}
