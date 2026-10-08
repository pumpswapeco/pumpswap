import fs from "fs"
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults"
import {
  mplTokenMetadata,
  createMetadataAccountV3,
  findMetadataPda,
} from "@metaplex-foundation/mpl-token-metadata"
import {
  createSignerFromKeypair,
  signerIdentity,
  publicKey,
} from "@metaplex-foundation/umi"

const RPC = "https://api.devnet.solana.com"
const MINT = "EUudw8Fg5qALMLgFGE5sgSSsUkmQ5nPV3v2GEke9MUYZ"
const KEYPAIR = `${process.env.USERPROFILE}\\.config\\solana\\project2-authority.json`

const secret = JSON.parse(fs.readFileSync(KEYPAIR, "utf8"))

const umi = createUmi(RPC).use(mplTokenMetadata())

const keypair = umi.eddsa.createKeypairFromSecretKey(
  new Uint8Array(secret)
)

const signer = createSignerFromKeypair(umi, keypair)

umi.use(signerIdentity(signer))

const mint = publicKey(MINT)
const metadata = findMetadataPda(umi, { mint })

const uri =
  "data:application/json;base64," +
  Buffer.from(
    JSON.stringify({
      name: "Every Woman",
      symbol: "WOMAN",
      description: "Every Woman staking token",
    })
  ).toString("base64")

console.log("Mint:", MINT)
console.log("Authority:", signer.publicKey.toString())
console.log("Metadata PDA:", metadata[0].toString())

await createMetadataAccountV3(umi, {
  metadata,
  mint,
  mintAuthority: signer,
  payer: signer,
  updateAuthority: signer,
  data: {
    name: "Every Woman",
    symbol: "WOMAN",
    uri,
    sellerFeeBasisPoints: 0,
    creators: null,
    collection: null,
    uses: null,
  },
  isMutable: true,
  collectionDetails: null,
}).sendAndConfirm(umi)

console.log("SUCCESS: Every Woman metadata created.")
console.log("Metadata PDA:", metadata[0].toString())
