// One-off on-chain repair: fix ONLY the PSC (main) token's Metaplex metadata on Devnet.
//
//   Mint:            E63EXv9SCMucdHsLirpWD8JvwCWL2ujzsJ6ScajgES1a  (PSC / staking token)
//   Problem:         The pinned metadata JSON is TRUNCATED (ends mid-string, no closing
//                    brace), so resolvers throw on JSON.parse and the logo never renders.
//   Repair:          Pin a COMPLETE, VALID metadata JSON (same name/symbol, same image)
//                    to IPFS via Pinata, then updateV1 the metadata URI to the new CID.
//
// What this changes ON-CHAIN:  the metadata account's `uri` field ONLY.
// What this NEVER touches:
//   - name / symbol (re-sent unchanged, identical to current on-chain values)
//   - sellerFeeBasisPoints / creators (preserved verbatim from the live account)
//   - the PRC rewards mint or its metadata
//   - token mint authority, freeze authority, supply, decimals, or any token account
//   - the Anchor program, IDL, staking logic, wallet/provider, or pool deployment logic
//
// Safety:
//   * DRY-RUN by default. It pins the JSON, validates it round-trips, and prints the
//     exact updateV1 payload — but does NOT send any Solana transaction.
//   * The transaction is sent ONLY when you pass:  --apply
//   * Requires the metadata update authority keypair at ~/.config/solana/id.json and a
//     Pinata JWT via the PINATA_JWT environment variable (never hardcoded).
//
// Usage:
//   PINATA_JWT=<jwt> pnpm exec node scripts/repair-psc-metadata.mjs           # dry-run
//   PINATA_JWT=<jwt> pnpm exec node scripts/repair-psc-metadata.mjs --apply   # broadcast
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi'
import { base58 } from '@metaplex-foundation/umi/serializers'
import {
  fetchMetadataFromSeeds,
  mplTokenMetadata,
  updateV1,
} from '@metaplex-foundation/mpl-token-metadata'

// --- Fixed, verified constants ---------------------------------------------
const PSC_MINT = 'E63EXv9SCMucdHsLirpWD8JvwCWL2ujzsJ6ScajgES1a'
const PRC_MINT = '4Tg7tVodPwCEhPnsq9Cy98qhsqg52swsKc3BQjJvwzAq' // read-only reference, never written
const EXPECTED_UPDATE_AUTHORITY = '2pGydyPFaZQJ8ZbGCBBim4w6fBv5qEb3h8eByaabo5ij'

// The image is already pinned and serves HTTP 200 image/png via the Pinata gateway.
const PSC_IMAGE_CID = 'bafybeicyyn4kzyo7eckr43b3coeo4umzn6rphe6vdhptbp5lgemx5smawm'
const PSC_IMAGE_URI = `ipfs://${PSC_IMAGE_CID}`

// Complete, valid metadata JSON. Name/symbol match the current on-chain values exactly
// (verified via fetchMetadataFromSeeds). 181 bytes when serialized with 2-space indent.
const METADATA_JSON = {
  name: 'Pumpswap Devnet',
  symbol: 'PSC',
  description: 'Pumpswap Devnet staking token',
  image: PSC_IMAGE_URI,
}

const APPLY = process.argv.includes('--apply')
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const clean = (value) => value.replace(/ /g, '').trim()
function abort(message) {
  console.error(`ABORT: ${message}`)
  process.exit(1)
}


// --- RPC (never printed) ----------------------------------------------------
function getRpcUrl() {
  try {
    const envPath = path.join(projectRoot, '.env.local')
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*NEXT_PUBLIC_SOLANA_RPC_URL\s*=\s*(.+?)\s*$/)
      if (match) return match[1]
    }
  } catch {
    // fall through
  }
  return 'https://api.devnet.solana.com'
}

// --- Validate the JSON BEFORE anything network/on-chain happens --------------
const jsonString = JSON.stringify(METADATA_JSON, null, 2)
const jsonBytes = Buffer.byteLength(jsonString, 'utf8')
let roundTrip
try {
  roundTrip = JSON.parse(jsonString)
} catch (e) {
  abort(`metadata JSON failed to parse: ${e.message}`)
}
if (!roundTrip.name || !roundTrip.symbol || !roundTrip.image) {
  abort('metadata JSON is missing a required field (name/symbol/image)')
}
if (jsonBytes > 4096) abort(`metadata JSON unexpectedly large: ${jsonBytes} bytes`)

// --- Pinata auth --------------------------------------------------------------
const pinataJwt = process.env.PINATA_JWT?.trim()
if (!pinataJwt) {
  abort('PINATA_JWT env var is required to pin the metadata JSON. Set it and re-run.')
}

// --- Signer / update authority ------------------------------------------------
const walletPath = path.join(os.homedir(), '.config', 'solana', 'id.json')
if (!fs.existsSync(walletPath)) abort(`wallet not found at ${walletPath}`)
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8')))

const umi = createUmi(getRpcUrl()).use(mplTokenMetadata())
const signer = umi.eddsa.createKeypairFromSecretKey(secretKey)
umi.use(keypairIdentity(signer))

console.log(`Signer public key:     ${signer.publicKey}`)
if (signer.publicKey !== EXPECTED_UPDATE_AUTHORITY) {
  abort(`signer does not match expected update authority ${EXPECTED_UPDATE_AUTHORITY}`)
}

// --- Pre-update on-chain verification ----------------------------------------
const pscMint = publicKey(PSC_MINT)

async function fetchMetadataWithRetry(mint, attempts = 4) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchMetadataFromSeeds(umi, { mint })
    } catch (e) {
      lastError = e
      if (e?.name === 'AccountDoesNotExistError' || /not found|does not exist/i.test(e?.message ?? '')) return null
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw lastError
}

const pscBefore = await fetchMetadataWithRetry(pscMint).catch((e) =>
  abort(`RPC error fetching PSC metadata: ${e.message}`),
)
if (!pscBefore) abort('PSC metadata account not found on devnet')
if (pscBefore.updateAuthority !== signer.publicKey) {
  abort(`PSC metadata updateAuthority is ${pscBefore.updateAuthority}, not our signer`)
}
if (pscBefore.mint !== PSC_MINT) abort(`metadata account mint mismatch: ${pscBefore.mint}`)

const beforeName = clean(pscBefore.name)
const beforeSymbol = clean(pscBefore.symbol)
console.log('\n--- CURRENT ON-CHAIN (PSC) ---')
console.log(`  name="${beforeName}" symbol="${beforeSymbol}"`)
console.log(`  uri="${clean(pscBefore.uri)}"  <- truncated/invalid JSON`)
console.log(`  sellerFeeBasisPoints=${pscBefore.sellerFeeBasisPoints}`)
console.log(`  creators=${JSON.stringify(pscBefore.creators)}`)

// --- Pin the complete JSON to Pinata ------------------------------------------
console.log('\n--- NEW METADATA JSON TO PIN ---')
console.log(jsonString)

// Build the request as a plain object and serialize it ONCE with JSON.stringify.
// Never hand-assemble JSON text: manually built strings can leak raw newlines or other
// control characters (0x00-0x1F) into string literals — exactly what Pinata rejects
// with "HTTP 500 Bad control character in string literal".
// Request shape is exactly:  { pinataContent: <metadata object> }
const pinRequestBody = {
  pinataContent: roundTrip,
}
const serializedBody = JSON.stringify(pinRequestBody)

// Defensive: guarantee the outgoing body contains no raw control characters, so a
// malformed payload can never reach Pinata as an opaque 500.
for (let i = 0; i < serializedBody.length; i++) {
  if (serializedBody.charCodeAt(i) < 0x20) {
    abort(`serialized Pinata request body contains a control character at index ${i}; refusing to send`)
  }
}
console.log(`Pinata request body: ${serializedBody.length} bytes, control-char-free`)

const pinRes = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${pinataJwt}`,
    'Content-Type': 'application/json',
  },
  body: serializedBody,
})
if (!pinRes.ok) {
  abort(`Pinata pinJSONToIPFS failed: HTTP ${pinRes.status} ${await pinRes.text().catch(() => '')}`)
}
const pinBody = await pinRes.json()
const newCid = pinBody?.IpfsHash
if (!newCid) abort('Pinata response did not include IpfsHash')
const newUri = `ipfs://${newCid}`
console.log(`Pinned CID: ${newCid}`)
console.log(`New URI:    ${newUri}`)

// Verify the pinned content round-trips as valid JSON via the Pinata gateway BEFORE we
// point the on-chain URI at it. (Poll briefly; gateway propagation can lag the pin.)
console.log('\n--- VERIFY PINNED CONTENT VIA GATEWAY ---')
let gatewayJson = null
for (let i = 0; i < 6; i++) {
  try {
    const r = await fetch(`https://gateway.pinata.cloud/ipfs/${newCid}`)
    if (r.ok) {
      gatewayJson = JSON.parse(await r.text()) // throws if truncated/invalid
      break
    }
  } catch {
    // retry
  }
  await new Promise((r) => setTimeout(r, 2000))
}
if (!gatewayJson) abort('pinned JSON did not round-trip as valid JSON via the Pinata gateway')
if (gatewayJson.image !== PSC_IMAGE_URI) abort(`gateway image mismatch: ${gatewayJson.image}`)
if (gatewayJson.name !== METADATA_JSON.name || gatewayJson.symbol !== METADATA_JSON.symbol) {
  abort('gateway name/symbol mismatch')
}
console.log('Gateway JSON is VALID and matches name/symbol/image.')

// --- Build the exact updateV1 payload (uri ONLY; everything else preserved) ---
const updateArgs = {
  mint: pscMint,
  authority: signer,
  data: {
    name: pscBefore.name, // unchanged
    symbol: pscBefore.symbol, // unchanged
    uri: newUri, // <-- the ONLY on-chain change
    sellerFeeBasisPoints: pscBefore.sellerFeeBasisPoints, // preserved
    creators: pscBefore.creators, // preserved
  },
}

console.log('\n--- PLANNED updateV1 PAYLOAD ---')
console.log(`  mint:      ${PSC_MINT}`)
console.log(`  authority: ${signer.publicKey}`)
console.log(`  data.uri:  ${newUri}   <-- ONLY field changing`)
console.log('  (name, symbol, sellerFeeBasisPoints, creators: preserved verbatim)')

if (!APPLY) {
  console.log('\nDRY-RUN: no transaction sent.')
  console.log('Re-run with --apply to broadcast the metadata URI update.')
  process.exit(0)
}

// --- Send the update -----------------------------------------------------------
console.log('\nSending updateV1 (PSC metadata URI only)...')
const { signature } = await updateV1(umi, updateArgs).sendAndConfirm(umi)
const sig = base58.deserialize(signature)[0]
console.log(`Transaction signature: ${sig}`)
console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`)

// --- Post-update verification ---------------------------------------------------
const pscAfter = await fetchMetadataWithRetry(pscMint)
const prcAfter = await fetchMetadataWithRetry(publicKey(PRC_MINT)).catch(() => null)
if (!pscAfter) abort('PSC metadata missing after update (unexpected)')

const uriOk = clean(pscAfter.uri) === newUri
const nameOk = clean(pscAfter.name) === beforeName
const symbolOk = clean(pscAfter.symbol) === beforeSymbol

console.log('\n--- AFTER ---')
console.log(`  PSC name="${clean(pscAfter.name)}" symbol="${clean(pscAfter.symbol)}" uri="${clean(pscAfter.uri)}"`)
if (prcAfter) {
  console.log(`  PRC name="${clean(prcAfter.name)}" symbol="${clean(prcAfter.symbol)}" uri="${clean(prcAfter.uri)}" (unchanged)`)
}

if (!uriOk) abort('post-update verification FAILED: uri did not update')
if (!nameOk || !symbolOk) abort('post-update verification FAILED: name/symbol changed unexpectedly')
console.log('\nSUCCESS: PSC metadata URI repaired; name/symbol and PRC metadata unchanged.')
