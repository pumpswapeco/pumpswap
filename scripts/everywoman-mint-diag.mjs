/**
 * READ-ONLY devnet diagnostics for the Everywoman pool-creation flow.
 * Usage: pnpm exec node scripts/everywoman-mint-diag.mjs
 *
 * Checks, for each exact mint address configured by this project's scripts:
 *  - account exists, owner program (legacy SPL Token vs Token-2022 vs other)
 *  - whether the account unpacks as a valid mint (decimals, supply, authorities)
 *  - Token-2022 TLV extension types present on the mint
 *  - platform PDA initialization state
 * Nothing is signed or sent.
 */
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadRpcUrl() {
  const envLocal = path.join(__dirname, '..', '.env.local')
  try {
    const match = fs.readFileSync(envLocal, 'utf8').match(/^SOLANA_RPC_URL=(.+)$/m)
    if (match) return match[1].trim()
  } catch {}
  return clusterApiUrl('devnet')
}

const RPC = loadRpcUrl()
const connection = new Connection(RPC, 'confirmed')

// Exact mint addresses from this repo's own scripts (NOT guessed):
//   scripts/create-woman-metadata.mjs -> "Every Woman" staking token (WOMAN)
//   scripts/create-rwm-metadata.mjs   -> "REW Woman"   reward token  (RWM)
//   scripts/repair-psc-metadata.mjs / scripts/fix-rewards-metadata.mjs -> PSC pair (working reference)
const MINTS = [
  { label: 'WOMAN (Every Woman, staking)', mint: 'EUudw8Fg5qALMLgFGE5sgSSsUkmQ5nPV3v2GEke9MUYZ' },
  { label: 'RWM (REW Woman, reward)', mint: 'FwDWHAdw8y7pYw5VFUVNiE1ZMr9UK7w5rMHx7pL5YS4Q' },
  { label: 'PSC (reference staking)', mint: 'E63EXv9SCMucdHsLirpWD8JvwCWL2ujzsJ6ScajgES1a' },
  { label: 'REWARDS (reference reward)', mint: '4Tg7tVodPwCEhPnsq9Cy98qhsqg52swsKc3BQjJvwzAq' },
]

const PROGRAM_ID = new PublicKey('BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs')

// Targeted retry probe for the WOMAN mint: same RPC repeatedly, then the
// public devnet endpoint, then getMultipleAccountsInfo alongside a known-good
// mint — isolates "bad RPC call" from "bad account" from "transient network".
const WOMAN = new PublicKey('EUudw8Fg5qALMLgFGE5sgSSsUkmQ5nPV3v2GEke9MUYZ')
const GOOD = new PublicKey('FwDWHAdw8y7pYw5VFUVNiE1ZMr9UK7w5rMHx7pL5YS4Q')

console.log('=== WOMAN mint retry probe ===')
for (let i = 1; i <= 3; i++) {
  try {
    const info = await connection.getAccountInfo(WOMAN, 'confirmed')
    console.log(`  helius attempt ${i}: OK exists=${!!info} owner=${info?.owner.toBase58() ?? '-'} dataLen=${info?.data.length ?? '-'}`)
    break
  } catch (e) {
    console.log(`  helius attempt ${i}: FAIL ${e.constructor?.name ?? ''} :: ${e.message}`)
    if (e.cause) console.log(`    cause: ${e.cause.constructor?.name ?? ''} ${e.cause.message ?? e.cause} ${e.cause.code ? `(code=${e.cause.code})` : ''}`)
    if (e.cause?.cause) console.log(`    cause2: ${e.cause.cause.constructor?.name ?? ''} ${e.cause.cause.message ?? e.cause.cause}`)
  }
}

try {
  const pub = new Connection(clusterApiUrl('devnet'), 'confirmed')
  const info = await pub.getAccountInfo(WOMAN, 'confirmed')
  console.log(`  public devnet: OK exists=${!!info} owner=${info?.owner.toBase58() ?? '-'} dataLen=${info?.data.length ?? '-'}`)
} catch (e) {
  console.log(`  public devnet: FAIL ${e.message}`)
  if (e.cause) console.log(`    cause: ${e.cause.constructor?.name ?? ''} ${e.cause.message ?? e.cause} ${e.cause.code ? `(code=${e.cause.code})` : ''}`)
}

try {
  const [a, b] = await connection.getMultipleAccountsInfo([WOMAN, GOOD], 'confirmed')
  console.log(`  helius getMultipleAccountsInfo([WOMAN, RWM]): WOMAN exists=${!!a} owner=${a?.owner.toBase58() ?? '-'} dataLen=${a?.data.length ?? '-'} | RWM exists=${!!b}`)
} catch (e) {
  console.log(`  helius getMultipleAccountsInfo: FAIL ${e.message}`)
}


function ownerName(owner) {
  if (owner.equals(TOKEN_PROGRAM_ID)) return 'legacy SPL Token'
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return 'Token-2022'
  return 'OTHER (not a supported token program)'
}

/** Manual Token-2022 TLV walk after the fixed 82-byte mint layout. */
function listTlvExtensions(data) {
  const out = []
  let offset = 82
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset)
    const length = data.readUInt16LE(offset + 2)
    out.push({ type, length })
    offset += 4 + length
    if (length === 0) break
  }
  return out
}

const EXTENSION_NAMES = {
  0: 'TransferFeeConfig', 1: 'TransferFeeAmount', 2: 'MintCloseAuthority',
  4: 'PermanentDelegate', 5: 'NonTransferable', 6: 'InterestBearingConfig',
  7: 'DefaultAccountState', 8: 'ImmutableOwner', 9: 'MemoTransfer', 10: 'CpiGuard',
  12: 'TransferHook', 14: 'ConfidentialTransferMint', 17: 'MetadataPointer',
  18: 'TokenMetadata', 19: 'GroupPointer', 20: 'Group', 21: 'MemberPointer', 22: 'Member',
}

console.log('RPC:', RPC.replace(/api-key=[^&\s]+/, 'api-key=***'))
console.log('')

for (const { label, mint } of MINTS) {
  console.log(`=== ${label}: ${mint} ===`)
  let info
  try {
    info = await connection.getAccountInfo(new PublicKey(mint), 'confirmed')
  } catch (e) {
    console.log(`  RPC ERROR: ${e.message}`)
    console.log('')
    continue
  }
  if (!info) {
    console.log('  EXISTS: NO (account not found on this cluster)')
    console.log('')
    continue
  }
  console.log(`  EXISTS: yes   lamports=${info.lamports}  dataLen=${info.data.length}`)
  console.log(`  OWNER : ${info.owner.toBase58()} (${ownerName(info.owner)})`)

  const isLegacy = info.owner.equals(TOKEN_PROGRAM_ID)
  const isT22 = info.owner.equals(TOKEN_2022_PROGRAM_ID)
  if (!isLegacy && !isT22) {
    console.log('  VERDICT: account is NOT owned by SPL Token or Token-2022.')
    console.log('')
    continue
  }

  try {
    const mintAcc = unpackMint(new PublicKey(mint), info, info.owner)
    console.log(`  VALID MINT: yes   decimals=${mintAcc.decimals}  supply=${mintAcc.supply.toString()}`)
    console.log(`  mintAuthority   : ${mintAcc.mintAuthority?.toBase58() ?? 'none (fixed supply)'}`)
    console.log(`  freezeAuthority : ${mintAcc.freezeAuthority?.toBase58() ?? 'none'}`)
  } catch (e) {
    console.log(`  VALID MINT: NO - unpackMint failed: ${e.message}`)
    console.log('')
    continue
  }

  if (isT22) {
    try {
      const exts = listTlvExtensions(info.data)
      if (exts.length === 0) {
        console.log('  T22 extensions: none (plain Token-2022 mint)')
      } else {
        console.log('  T22 extensions:')
        for (const e of exts) {
          console.log(`    - type ${e.type} (${EXTENSION_NAMES[e.type] ?? 'unknown'}) len=${e.length}`)
        }
      }
    } catch (e) {
      console.log(`  T22 extension parse failed: ${e.message}`)
    }
  }
  console.log('')
}

// Platform singleton state (createPool prepends initialize_platform only when missing)
try {
  const [platformPda] = PublicKey.findProgramAddressSync([Buffer.from('platform')], PROGRAM_ID)
  const platformInfo = await connection.getAccountInfo(platformPda, 'confirmed')
  console.log(`=== platform PDA ${platformPda.toBase58()} ===`)
  console.log(platformInfo ? `  initialized: yes (owner ${platformInfo.owner.toBase58()}, dataLen ${platformInfo.data.length})` : '  initialized: NO')
} catch (e) {
  console.log(`platform PDA check failed: ${e.message}`)
}

// Reference: existing working pool account
try {
  const pool = new PublicKey('7f7Q78AY7BooQCJRg4ZEeT8uwZb6jNCBszFiTPP5rdxw')
  const poolInfo = await connection.getAccountInfo(pool, 'confirmed')
  console.log(`\n=== known working pool 7f7Q78AY7BooQCJRg4ZEeT8uwZb6jNCBszFiTPP5rdxw ===`)
  console.log(poolInfo ? `  exists: yes (owner ${poolInfo.owner.toBase58()}, dataLen ${poolInfo.data.length})` : '  exists: NO')
} catch (e) {
  console.log(`pool reference check failed: ${e.message}`)
}

