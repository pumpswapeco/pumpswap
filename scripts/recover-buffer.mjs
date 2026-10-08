// Recovers the ephemeral buffer keypair printed by a failed `solana program deploy`.
// solana-keygen derives such keypairs as PBKDF2-HMAC-SHA512(mnemonic, "mnemonic"+passphrase, 2048, 64)
// and uses the first 32 bytes as the ed25519 secret seed (no BIP44 path).
//
// Usage:
//   node scripts/recover-buffer.mjs "<12-word seed phrase from the deploy error>" [output-file]
import crypto from 'node:crypto'
import fs from 'node:fs'
import { Keypair } from '@solana/web3.js'

const phrase = process.argv[2]?.trim()
const outFile = process.argv[3] ?? 'recovered-buffer-keypair.json'

if (!phrase || phrase.split(/\s+/).length < 12) {
  console.error('Usage: node scripts/recover-buffer.mjs "<12-word seed phrase>" [output-file]')
  process.exit(1)
}

const passphrase = ''

const seed = crypto.pbkdf2Sync(
  phrase.normalize('NFKD'),
  ('mnemonic' + passphrase).normalize('NFKD'),
  2048,
  64,
  'sha512',
)

const keypair = Keypair.fromSeed(seed.subarray(0, 32))
fs.writeFileSync(outFile, JSON.stringify(Array.from(keypair.secretKey)))
console.log('Recovered buffer keypair:', keypair.publicKey.toBase58())
console.log('Written to:', outFile)
