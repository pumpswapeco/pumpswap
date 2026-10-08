"use client"

import { useEffect, useState } from "react"
import { useConnection } from "@solana/wallet-adapter-react"
import { PublicKey } from "@solana/web3.js"
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token"
import {
  findMetadataPda,
  safeFetchAllMetadata,
} from "@metaplex-foundation/mpl-token-metadata"
import { isSome, publicKey as umiPublicKey } from "@metaplex-foundation/umi"

import { getUmi, resolveImageFromUri } from "@/lib/solana/metadata"
import type { PoolAccount } from "@/lib/solana/ops"

/**
 * A wallet-owned NFT whose Metaplex metadata declares a VERIFIED collection
 * membership matching the pool's on-chain `nftCollection` field.
 *
 * The `tokenAccount` is the account holding the NFT. `stake` receives this
 * account together with the NFT's `metadata` account for VERIFICATION ONLY
 * (token account owner = signer, amount >= 1, verified collection = the pool's
 * `nftCollection`). The NFT itself is never transferred to the program, and the
 * pool's boost is snapshotted onto the position as `nftBoostBps`.
 */
export type WalletNft = {
  mint: PublicKey
  tokenAccount: PublicKey
  metadata: PublicKey
  name: string
  image?: string
}

export type WalletNftsState = {
  /**
   * - `disconnected`: no wallet connected
   * - `disabled`: pool has no NFT boost collection configured (all-zeros / System Program)
   * - `loading`: scanning wallet token accounts + metadata
   * - `ready`: scan finished (nfts may still be empty)
   * - `error`: RPC failure
   */
  status: "disconnected" | "disabled" | "loading" | "ready" | "error"
  nfts: WalletNft[]
  error: string | null
}

const IDLE_STATE: WalletNftsState = {
  status: "disconnected",
  nfts: [],
  error: null,
}

/** getMultipleAccounts limit (Solana RPC caps at 100 keys per call). */
const METADATA_BATCH = 100

type ParsedTokenInfo = {
  mint?: string
  tokenAmount?: { amount?: string; decimals?: number }
}

/**
 * Detects the connected wallet's NFTs owned from the pool's configured
 * NFT collection, mirroring the on-chain eligibility rules in
 * `programs/pumpswap-staking/src/lib.rs`:
 *
 * 1. token account amount >= 1,
 * 2. canonical Metaplex metadata account exists for the mint,
 * 3. metadata `collection.key` equals the pool's `nftCollection`,
 * 4. metadata `collection.verified` is true.
 *
 * Detection is read-only: it issues no transactions and does not itself
 * apply any boost — the program records the pool's configured boost on the
 * position at stake time (it does not re-derive a boost from the NFT later).
 */
export function useWalletNfts({
  wallet,
  pool,
}: {
  /** Connected wallet — `publicKey` is null while no wallet is connected. */
  wallet: { publicKey: PublicKey | null } | null
  /** On-chain pool account; the boost collection is read from `pool.nftCollection`. */
  pool: Pick<PoolAccount, "nftCollection"> | null
}): WalletNftsState {
  const { connection } = useConnection()
  const [state, setState] = useState<WalletNftsState>(IDLE_STATE)

  const owner = wallet?.publicKey ?? null
  const nftCollection = pool?.nftCollection ?? null

  useEffect(() => {
    if (!owner) {
      setState(IDLE_STATE)
      return
    }

    // All-zeros pubkey == System Program address == "boost unset" on-chain.
    if (!nftCollection || nftCollection.equals(PublicKey.default)) {
      setState({ status: "disabled", nfts: [], error: null })
      return
    }

    let cancelled = false
    setState({ status: "loading", nfts: [], error: null })

    void (async () => {
      try {
        // Scan every token account the owner controls across both token programs.
        const [legacy, token2022] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(owner, {
            programId: TOKEN_PROGRAM_ID,
          }),
          connection.getParsedTokenAccountsByOwner(owner, {
            programId: TOKEN_2022_PROGRAM_ID,
          }),
        ])

        if (cancelled) return

        // Candidates: mints with at least 1 base unit in some account
        // (on-chain rule: `nft_token.amount >= 1`). One entry per mint; the
        // first holding token account is recorded for a future stake call.
        const candidates = new Map<string, string>()
        for (const { pubkey, account } of [
          ...legacy.value,
          ...token2022.value,
        ]) {
          const data = account.data
          if (typeof data === "string" || Buffer.isBuffer(data)) continue
          const info = (data as { parsed?: { info?: ParsedTokenInfo } })
            .parsed?.info
          const mint = info?.mint
          const amount = info?.tokenAmount?.amount
          if (!mint || !amount) continue
          if (BigInt(amount) < BigInt(1)) continue
          if (!candidates.has(mint)) candidates.set(mint, pubkey.toBase58())
        }

        if (candidates.size === 0) {
          setState({ status: "ready", nfts: [], error: null })
          return
        }

        // Batch-fetch canonical metadata PDAs and keep only verified members
        // of the pool's collection.
        const umi = getUmi()
        const collectionKey = nftCollection.toBase58()
        const mints = [...candidates.keys()]
        const matches: WalletNft[] = []

        for (let i = 0; i < mints.length; i += METADATA_BATCH) {
          const chunk = mints.slice(i, i + METADATA_BATCH)
          const pdas = chunk.map((mint) =>
            findMetadataPda(umi, { mint: umiPublicKey(mint) }),
          )
          const metas = await safeFetchAllMetadata(umi, pdas)
          if (cancelled) return

          for (const meta of metas) {
            // Metaplex stores the collection as a Rust-style Option: the
            // membership must be present (`Some`) before it can be checked.
            const collection = meta.collection
            if (!isSome(collection)) continue
            if (!collection.value.verified) continue
            if (collection.value.key !== collectionKey) continue

            const mint = meta.mint
            const tokenAccount = candidates.get(mint)
            if (!tokenAccount) continue

            matches.push({
              mint: new PublicKey(mint),
              tokenAccount: new PublicKey(tokenAccount),
              metadata: new PublicKey(meta.publicKey),
              name: meta.name.replace(/\u0000/g, "").trim(),
              image: await resolveImageFromUri(meta.uri),
            })
            if (cancelled) return
          }
        }

        if (!cancelled) {
          setState({ status: "ready", nfts: matches, error: null })
        }
      } catch (e) {
        if (!cancelled) {
          setState({
            status: "error",
            nfts: [],
            error:
              e instanceof Error
                ? e.message
                : "Could not load wallet NFTs.",
          })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [connection, owner, nftCollection])

  return state
}
