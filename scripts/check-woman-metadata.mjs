// READ-ONLY diagnostic: fetch both Project #2 token Metadata accounts on Devnet.
// Prints the Metadata PDA, current name/symbol/uri, and update authority.
// Does NOT write anything to the chain.
//
// Usage: pnpm exec node scripts/check-woman-metadata.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi'
import {
  fetchMetadataFromSeeds,
  mplTokenMetadata,
  findMetadataPda,
} from '@metaplex-foundation/mpl-token-metadata'

const RPC = 'https://api.devnet.solana.com'
const EXPECTED_AUTHORITY = 'GSKDWBZiNQiyfKak2bBmxuVNhSnYDJssTaFxNYK6jh5n'

const TOKENS = [
  { label: 'WOMAN', mint: 'EUudw8Fg5qALMLgFGE5sgSSsUkmQ5nPV3v2GEke9MUYZ' },
  { label: 'RWM', mint: 'FwDWHAdw8y7pYw5VFUVNiE1ZMr9UK7w5rMHx7pL5YS4Q' },
]

const walletPath = path.join(os.homedir(), '.config', 'solana', 'project2-authority.json')
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8')))

const umi = createUmi(RPC).use(mplTokenMetadata())
const signer = umi.eddsa.createKeypairFromSecretKey(secretKey)
umi.use(keypairIdentity(signer))

const clean = (v) => v.replace(/\u0000/g, '').trim()

console.log('RPC:', RPC)
console.log('Signer public key:', signer.publicKey)
console.log('Expected authority:', EXPECTED_AUTHORITY)
console.log('Signer matches expected:', signer.publicKey === EXPECTED_AUTHORITY)

for (const t of TOKENS) {
  const mint = publicKey(t.mint)
  const pda = findMetadataPda(umi, { mint })
  console.log(`\n=== ${t.label} (${t.mint}) ===`)
  console.log('Metadata PDA:', pda[0])
  try {
    const meta = await fetchMetadataFromSeeds(umi, { mint })
    console.log('  name:', clean(meta.name))
    console.log('  symbol:', clean(meta.symbol))
    console.log('  uri:', clean(meta.uri))
    console.log('  updateAuthority:', meta.updateAuthority)
    console.log('  mint:', meta.mint)
    console.log('  sellerFeeBasisPoints:', meta.sellerFeeBasisPoints)
    console.log('  creators:', meta.creators ? JSON.stringify(meta.creators) : meta.creators)
    console.log('  isMutable:', meta.isMutable)
    console.log('  primarySaleHappened:', meta.primarySaleHappened)
    console.log('  collection:', meta.collection ? JSON.stringify(meta.collection) : meta.collection)
    console.log('  uses:', meta.uses ? JSON.stringify(meta.uses) : meta.uses)
    console.log('  updateAuthority === expected:', meta.updateAuthority === EXPECTED_AUTHORITY)
    console.log('  mint === token mint:', meta.mint === t.mint)
  } catch (e) {
    console.log('  ERROR fetching metadata:', e.message)
  }
}
