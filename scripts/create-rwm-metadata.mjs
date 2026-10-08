// One-off on-chain fix: create the Metaplex metadata account for the Project #2
// REW Woman reward token on Solana Devnet.
//
//   Mint:     FwDWHAdw8y7pYw5VFUVNiE1ZMr9UK7w5rMHx7pL5YS4Q
//   PDA:      3T29SMZHJLLSA8YgBrXC7JL2Q4WkigdWCZGbdZQRUcUm
//   Name:     "REW Woman"
//   Symbol:   "RWM"
//   URI:      GitHub raw JSON URI
//
// Authorized by Project #2 authority GSKDWBZiNQiyfKak2bBmxuVNhSnYDJssTaFxNYK6jh5n
// (also the mint authority, so createMetadataAccountV3 may proceed).
//
// Pre-flight:
//   - aborts unless the signer == Project #2 authority
//   - aborts unless the RWM metadata PDA does NOT currently exist
//   - aborts unless the derived PDA matches the expected PDA above
//
// Does NOT create a mint, does NOT change mint authority or supply, and does NOT
// touch application code.
//
// Usage: pnpm exec node scripts/create-rwm-metadata.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi'
import { base58 } from '@metaplex-foundation/umi/serializers'
import {
  createMetadataAccountV3,
  fetchMetadataFromSeeds,
  findMetadataPda,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata'

const MINT = 'FwDWHAdw8y7pYw5VFUVNiE1ZMr9UK7w5rMHx7pL5YS4Q'
const EXPECTED_PDA = '3T29SMZHJLLSA8YgBrXC7JL2Q4WkigdWCZGbdZQRUcUm'
const EXPECTED_AUTHORITY = 'GSKDWBZiNQiyfKak2bBmxuVNhSnYDJssTaFxNYK6jh5n'

const NEW_NAME = 'REW Woman'
const NEW_SYMBOL = 'RWM'
const NEW_URI =
  'https://raw.githubusercontent.com/pumpswapecosystem/pumpswap/main/public/token-metadata/rew-woman.json'

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
if (signer.publicKey !== EXPECTED_AUTHORITY) {
  abort(`signer does not match Project #2 authority ${EXPECTED_AUTHORITY}`)
}

// --- Pre-flight: PDA derivation + must-not-exist ----------------------------
const mint = publicKey(MINT)
const metadataPda = findMetadataPda(umi, { mint })
const pdaAddress = metadataPda[0]
console.log(`Derived Metadata PDA:  ${pdaAddress}`)
if (pdaAddress !== EXPECTED_PDA) {
  abort(`derived PDA ${pdaAddress} does not match expected ${EXPECTED_PDA}`)
}

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

const existing = await fetchMetadataWithRetry(mint).catch((e) =>
  abort(`RPC error checking RWM metadata: ${e.message}`)
)
if (existing) {
  abort(`RWM metadata account already exists at ${pdaAddress}; refusing to create a duplicate`)
}
console.log('RWM metadata PDA does not currently exist - safe to create.')

// --- Build + send createMetadataAccountV3 ------------------------------------
if (Buffer.byteLength(NEW_NAME, 'utf8') > 32) abort('name exceeds 32 bytes')
if (Buffer.byteLength(NEW_SYMBOL, 'utf8') > 10) abort('symbol exceeds 10 bytes')
if (Buffer.byteLength(NEW_URI, 'utf8') > 200) abort(`URI exceeds 200 bytes: ${NEW_URI.length}`)

console.log(`Creating Metadata account for RWM mint...`)
console.log(`  name="${NEW_NAME}" symbol="${NEW_SYMBOL}"`)
console.log(`  uri="${NEW_URI}"`)

const { signature } = await createMetadataAccountV3(umi, {
  metadata: metadataPda,
  mint,
  mintAuthority: signer,
  payer: signer,
  updateAuthority: signer,
  data: {
    name: NEW_NAME,
    symbol: NEW_SYMBOL,
    uri: NEW_URI,
    sellerFeeBasisPoints: 0,
    creators: null,
    collection: null,
    uses: null,
  },
  isMutable: true,
  collectionDetails: null,
}).sendAndConfirm(umi)

const sig = base58.deserialize(signature)[0]
console.log(`Transaction signature: ${sig}`)
console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`)

// --- Read back + verify ------------------------------------------------------
const after = await fetchMetadataWithRetry(mint).catch((e) =>
  abort(`RPC error fetching RWM metadata after creation: ${e.message}`)
)
if (!after) abort('RWM metadata account missing after creation (unexpected)')

console.log('\n--- READ-BACK FROM CHAIN ---')
console.log(`  name="${clean(after.name)}" symbol="${clean(after.symbol)}"`)
console.log(`  uri="${clean(after.uri)}"`)
console.log(`  updateAuthority=${after.updateAuthority}`)
console.log(`  mint=${after.mint}`)
console.log(`  isMutable=${after.isMutable}`)

const ok =
  clean(after.name) === NEW_NAME &&
  clean(after.symbol) === NEW_SYMBOL &&
  clean(after.uri) === NEW_URI &&
  after.updateAuthority === EXPECTED_AUTHORITY &&
  after.mint === MINT

if (!ok) abort('post-creation verification FAILED for RWM token')

console.log('\nSUCCESS: RWM token metadata created.')
console.log(`Metadata PDA: ${pdaAddress}`)
console.log(`Signature:    ${sig}`)
console.log(`name="${clean(after.name)}" symbol="${clean(after.symbol)}" uri="${clean(after.uri)}"`)