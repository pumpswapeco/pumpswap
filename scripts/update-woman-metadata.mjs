// One-off on-chain fix: update ONLY the Every Woman token's Metaplex metadata on Devnet.
//
//   Mint:     EUudw8Fg5qALMLgFGE5sgSSsUkmQ5nPV3v2GEke9MUYZ
//   Name:     "Every Woman"
//   Symbol:   "WOMAN"
//   URI:      previous inline base64 data: URI -> GitHub raw JSON URI
//
// The REW Woman token (FwDWHAdw8y7pYw5VFUVNiE1ZMr9UK7w5rMHx7pL5YS4Q) is intentionally
// NOT touched (its metadata account does not exist yet and will be created separately).
// The mint, supply, decimals, and authorities are untouched.
//
// Pre-flight: aborts unless the metadata updateAuthority == the Project #2 signer
// GSKDWBZiNQiyfKak2bBmxuVNhSnYDJssTaFxNYK6jh5n.
//
// Usage: pnpm exec node scripts/update-woman-metadata.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi'
import { base58 } from '@metaplex-foundation/umi/serializers'
import {
  fetchMetadataFromSeeds,
  findMetadataPda,
  mplTokenMetadata,
  updateV1,
} from '@metaplex-foundation/mpl-token-metadata'

const MINT = 'EUudw8Fg5qALMLgFGE5sgSSsUkmQ5nPV3v2GEke9MUYZ'
const EXPECTED_UPDATE_AUTHORITY = 'GSKDWBZiNQiyfKak2bBmxuVNhSnYDJssTaFxNYK6jh5n'

const NEW_NAME = 'Every Woman'
const NEW_SYMBOL = 'WOMAN'
const NEW_URI =
  'https://raw.githubusercontent.com/pumpswapecosystem/pumpswap/main/public/token-metadata/every-woman.json'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Prefer the project's configured Devnet RPC from .env.local (never printed). */
function getRpcUrl() {
  try {
    const envPath = path.join(projectRoot, '.env.local')
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*NEXT_PUBLIC_SOLANA_RPC_URL\s*=\s*(.+?)\s*$/)
      if (match) return { url: match[1], source: 'NEXT_PUBLIC_SOLANA_RPC_URL (.env.local)' }
    }
  } catch {
    // fall through to public endpoint
  }
  return { url: 'https://api.devnet.solana.com', source: 'public devnet fallback' }
}

const clean = (value) => value.replace(/\u0000/g, '').trim()

function abort(message) {
  console.error(`ABORT: ${message}`)
  process.exit(1)
}

// --- RPC + signer -----------------------------------------------------------
const rpc = getRpcUrl()
console.log(`RPC: using ${rpc.source}`)

const walletPath = path.join(os.homedir(), '.config', 'solana', 'project2-authority.json')
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8')))

const umi = createUmi(rpc.url).use(mplTokenMetadata())
const signer = umi.eddsa.createKeypairFromSecretKey(secretKey)
umi.use(keypairIdentity(signer))

console.log(`Signer public key:     ${signer.publicKey}`)
if (signer.publicKey !== EXPECTED_UPDATE_AUTHORITY) {
  abort(`signer does not match expected metadata update authority ${EXPECTED_UPDATE_AUTHORITY}`)
}

// --- Pre-update verification ------------------------------------------------
const mint = publicKey(MINT)
const metadataPda = findMetadataPda(umi, { mint })
console.log(`Metadata PDA:          ${metadataPda[0]}`)

/** Fetch with retries so a transient RPC hiccup is not mistaken for "not found". */
async function fetchMetadataWithRetry(m, attempts = 4) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchMetadataFromSeeds(umi, { mint: m })
    } catch (e) {
      lastError = e
      if (e?.name === 'AccountDoesNotExistError' || /not found|does not exist/i.test(e?.message ?? '')) {
        return null
      }
    }
  }
  throw lastError
}

const before = await fetchMetadataWithRetry(mint).catch((e) =>
  abort(`RPC error fetching WOMAN metadata: ${e.message}`)
)
if (!before) abort('WOMAN metadata account not found on devnet')

console.log('\n--- BEFORE ---')
console.log(`  name="${clean(before.name)}" symbol="${clean(before.symbol)}"`)
console.log(`  uri="${clean(before.uri)}"`)
console.log(`  updateAuthority=${before.updateAuthority}`)
console.log(`  sellerFeeBasisPoints=${before.sellerFeeBasisPoints}`)

if (before.updateAuthority !== EXPECTED_UPDATE_AUTHORITY) {
  abort(`WOMAN metadata updateAuthority is ${before.updateAuthority}, not ${EXPECTED_UPDATE_AUTHORITY}`)
}
if (before.mint !== MINT) {
  abort(`metadata account mint mismatch: ${before.mint}`)
}

// --- Build the update -------------------------------------------------------
if (Buffer.byteLength(NEW_NAME, 'utf8') > 32) abort('new name exceeds 32 bytes')
if (Buffer.byteLength(NEW_SYMBOL, 'utf8') > 10) abort('new symbol exceeds 10 bytes')
if (Buffer.byteLength(NEW_URI, 'utf8') > 200) abort(`new URI exceeds 200 bytes: ${NEW_URI.length}`)

const alreadyCorrect =
  clean(before.name) === NEW_NAME && clean(before.symbol) === NEW_SYMBOL && clean(before.uri) === NEW_URI
if (alreadyCorrect) {
  console.log('\nWOMAN metadata already correct - nothing to do.')
  process.exit(0)
}

console.log('\nSending updateV1 for WOMAN mint...')
const { signature } = await updateV1(umi, {
  mint,
  authority: signer,
  data: {
    name: NEW_NAME,
    symbol: NEW_SYMBOL,
    uri: NEW_URI,
    sellerFeeBasisPoints: before.sellerFeeBasisPoints,
    creators: before.creators,
  },
}).sendAndConfirm(umi)

const sig = base58.deserialize(signature)[0]
console.log(`Transaction signature: ${sig}`)
console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`)

// --- Post-update verification -----------------------------------------------
const after = await fetchMetadataWithRetry(mint).catch((e) =>
  abort(`RPC error fetching WOMAN metadata after update: ${e.message}`)
)
if (!after) abort('WOMAN metadata account missing after update (unexpected)')

console.log('\n--- AFTER ---')
console.log(`  name="${clean(after.name)}" symbol="${clean(after.symbol)}"`)
console.log(`  uri="${clean(after.uri)}"`)
console.log(`  updateAuthority=${after.updateAuthority}`)

const ok =
  clean(after.name) === NEW_NAME &&
  clean(after.symbol) === NEW_SYMBOL &&
  clean(after.uri) === NEW_URI &&
  after.updateAuthority === EXPECTED_UPDATE_AUTHORITY

if (!ok) abort('post-update verification FAILED for WOMAN token')

console.log('\nSUCCESS: WOMAN token metadata updated.')
console.log(`Metadata PDA: ${metadataPda[0]}`)
console.log(`Signature:    ${sig}`)
console.log(`name="${clean(after.name)}" symbol="${clean(after.symbol)}" uri="${clean(after.uri)}"`)