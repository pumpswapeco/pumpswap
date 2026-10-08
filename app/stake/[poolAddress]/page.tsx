import { PoolStakingClient } from "./pool-staking-client"

export default async function PoolStakingPage({ params }: { params: Promise<{ poolAddress: string }> }) {
  const { poolAddress } = await params
  return <PoolStakingClient poolAddress={poolAddress} />
}
