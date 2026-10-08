"use client"

import { useEffect, useState } from "react"
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { useConnection } from "@solana/wallet-adapter-react"

import { usePoolOptional } from "@/lib/pool-context"
import type { PublicKey } from "@solana/web3.js"
import { STAKING_PROGRAM_ID } from "@/lib/solana/program"
import { loadRecentProgramTransactions } from "@/lib/solana/program-transactions"

/**
 * Pool-wide activity actions for the selected pool: user stakes, user
 * unstakes, user claims AND pool funding (reward deposits by the founder).
 */
export type StakingAction = "Stake" | "Unstake" | "Claim" | "Fund"

export interface StakingActivityRow {
  /** On-chain transaction signature (base58). */
  signature: string
  action: StakingAction
  /** The on-chain signer / position owner that performed the action. */
  wallet: string
  /** Pool address the transaction targeted. */
  poolAddress: string
  /** Action amount in base units; null when it cannot be read from the tx. */
  amountBase: bigint | null
  /** Slot the transaction landed in (null when the RPC omitted it). */
  slot: number | null
  /** Unix timestamp seconds (null when the RPC omitted it). */
  blockTime: number | null
}

export interface RecentActivityState {
  loading: boolean
  /** The selected pool's real staking/funding transactions, newest first. */
  rows: StakingActivityRow[]
  /**
   * Truthful RPC/load error (shown instead of infinite loading). Null when the
   * last load succeeded or nothing is loaded yet.
   */
  error: string | null
}

/** Solana base58 alphabet (matches bs58 / the instruction wire encoding). */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

export function base58Decode(input: string): Uint8Array {
  const bytes: bigint[] = [BigInt(0)]
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char)
    if (value < 0) throw new Error(`Invalid base58 character: ${char}`)
    let carry = BigInt(value)
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * BigInt(58)
      bytes[j] = carry & BigInt(0xff)
      carry >>= BigInt(8)
    }
    while (carry > BigInt(0)) {
      bytes.push(carry & BigInt(0xff))
      carry >>= BigInt(8)
    }
  }
  for (let i = 0; i < input.length && input[i] === "1"; i++) bytes.push(BigInt(0))
  bytes.reverse()
  return new Uint8Array(bytes.map((b) => Number(b)))
}

/** Little-endian u64 at `offset` inside `bytes`. */
export function u64Le(bytes: Uint8Array, offset: number): bigint {
  let value = BigInt(0)
  for (let i = offset + 7; i >= offset; i--) {
    value = (value << BigInt(8)) | BigInt(bytes[i])
  }
  return value
}

/** Anchor program discriminator (8-byte ix hash) per staking action. */
const ACTION_DISCRIMINATORS: Record<StakingAction, number[]> = {
  Stake: [206, 176, 202, 18, 200, 209, 179, 108],
  Unstake: [90, 95, 107, 42, 205, 124, 50, 225],
  Claim: [4, 144, 132, 71, 116, 23, 151, 80],
  Fund: [114, 64, 163, 112, 175, 167, 19, 121],
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function actionFromDiscriminator(bytes: Uint8Array): StakingAction | null {
  if (bytes.length < 8) return null
  const head = Array.from(bytes.subarray(0, 8))
  for (const [action, disc] of Object.entries(ACTION_DISCRIMINATORS)) {
    if (arraysEqual(head, disc)) return action as StakingAction
  }
  return null
}

/** Anchor logs `Program log: Instruction: <Name>` for each ix it runs. */
export function actionFromLogs(logMessages: string[] | undefined): StakingAction | null {
  for (const line of logMessages ?? []) {
    if (line.includes("Instruction: ClaimRewards")) return "Claim"
    if (line.includes("Instruction: Unstake")) return "Unstake"
    if (line.includes("Instruction: Stake")) return "Stake"
    if (line.includes("Instruction: FundRewards")) return "Fund"
  }
  return null
}

type InstructionLike = {
  accounts?: number[] | undefined
  data?: string | undefined
  programId?: string | unknown | undefined
  programIdIndex?: number | undefined
}

/** Structural shape of the versioned transaction responses we inspect. */
export type ActivityTx = {
  transaction: {
    message: {
      accountKeys: Array<string | { toString(): string }>
      instructions: InstructionLike[]
    }
  }
  meta?: {
    logMessages?: string[]
    innerInstructions?: Array<{ index: number; instructions: InstructionLike[] }>
  } | null
} | null
/**
 * Instruction `data` in the parsed JSON transaction is base58 (the Solana wire
 * encoding). Discovers the called program by looking up `programIdIndex` when
 * the `programId` field is not present on the partially-decoded instruction.
 */
export function instructionProgramId(ix: InstructionLike, keys: string[]): string | null {
  if (typeof ix.programId === "string") return ix.programId
  if (typeof ix.programIdIndex === "number") return keys[ix.programIdIndex]
  return null
}

/** Extracts the claim amount from the spl-token transfer made inside the ix. */
function claimAmountFromTransfers(
  innerInstructions: Array<{ index: number; instructions: InstructionLike[] }> | undefined,
  keys: string[],
): bigint | null {
  for (const block of innerInstructions ?? []) {
    for (const sub of block.instructions ?? []) {
      // Accept transfers issued by EITHER supported token program: classic SPL
      // Token and Token-2022 encode `Transfer` with the same discriminator (3)
      // and the same u64 LE amount, only the issuing program differs. Filtering
      // on the legacy program alone would hide the claim amount for a
      // Token-2022 reward vault.
      const transferProgram = instructionProgramId(sub, keys)
      if (
        transferProgram !== TOKEN_PROGRAM_ID.toBase58() &&
        transferProgram !== TOKEN_2022_PROGRAM_ID.toBase58()
      )
        continue
      try {
        const bytes = base58Decode(sub.data ?? "")
        // SPL transfer instruction: u8 discriminator 3 + u64 LE amount.
        if (bytes.length >= 9 && bytes[0] === 3) return u64Le(bytes, 1)
      } catch {
        // Not decodable; keep scanning.
      }
    }
  }
  return null
}

/**
 * Extracts one activity row from a transaction involving the staking program.
 * Founder Console activity is POOL-WIDE: any Stake / Unstake / Claim / Fund
 * transaction that targeted the selected pool is returned regardless of which
 * wallet performed it. Every field is read from the real on-chain transaction
 * (signature, instruction bytes, log messages, inner token transfers, slot and
 * block time).
 */
function extractActivityRow(
  tx: {
    transaction: {
      message: {
        accountKeys: Array<string | { toString(): string }>
        instructions: InstructionLike[]
      }
    }
    meta?: {
      logMessages?: string[]
      innerInstructions?: Array<{ index: number; instructions: InstructionLike[] }>
    } | null
  },
  sig: { signature: string; slot?: number | null; blockTime?: number | null },
  poolAddress: string,
): StakingActivityRow | null {
  const msg = tx.transaction.message
  const keys = msg.accountKeys.map((k) => String(k).replace(/["'\s]/g, ""))
  const programStr = STAKING_PROGRAM_ID.toBase58()

  let action: StakingAction | null = null
  let amountBase: bigint | null = null
  let actorKey = ""

  for (const ix of msg.instructions) {
    if (instructionProgramId(ix, keys) !== programStr) continue
    const accountIdx = ix.accounts ?? []
    // Every staking/funding instruction puts the signer at index 0 and the pool
    // at index 1. Filter ONLY on the pool: the founder console is pool-wide and
    // must show activity from every user + funding from any founder.
    if (accountIdx.length < 2 || keys[accountIdx[1]] !== poolAddress) continue

    let bytes: Uint8Array
    try {
      bytes = base58Decode(ix.data ?? "")
    } catch {
      continue
    }

    action = actionFromLogs(tx.meta?.logMessages) ?? actionFromDiscriminator(bytes)
    if (!action) continue
    actorKey = keys[accountIdx[0]] ?? ""

    if (action === "Stake" || action === "Unstake" || action === "Fund") {
      // Args for all three instructions are a single u64 amount.
      if (bytes.length >= 16) amountBase = u64Le(bytes, 8)
    }
    break
  }

  if (!action) return null

  if (action === "Claim") {
    amountBase = claimAmountFromTransfers(tx.meta?.innerInstructions, keys)
  }

  return {
    signature: sig.signature,
    action,
    wallet: actorKey,
    poolAddress,
    amountBase,
    slot: sig.slot ?? null,
    blockTime: sig.blockTime ?? null,
  }
}

/**
 * Recent SELECTED-POOL transactions (Stake / Unstake / Claim / Fund for ANY
 * user or founder), cached with a short TTL and de-duplicated in flight so
 * multiple mounts (e.g. navigating between dashboard/rewards/analytics) never
 * re-issue the same getSignaturesForAddress + getTransactions payload.
 */
const ACTIVITY_TTL_MS = 20_000
const activityCache = new Map<string, { at: number; rows: StakingActivityRow[] }>()
const activityInFlight = new Map<string, Promise<StakingActivityRow[]>>()

async function loadCachedActivityRows(
  connection: ReturnType<typeof useConnection>["connection"],
  poolAddress: string,
): Promise<StakingActivityRow[]> {
  const key = `${connection.rpcEndpoint}|${poolAddress}`

  const cached = activityCache.get(key)
  if (cached && Date.now() - cached.at < ACTIVITY_TTL_MS) return cached.rows

  const active = activityInFlight.get(key)
  if (active) return active

  const promise = (async (): Promise<StakingActivityRow[]> => {
    // Shared, de-duplicated program transaction history for THIS pool: one
    // pool-scoped getSignaturesForAddress + per-signature getTransaction fetches
    // with a bounded concurrency, shared across Recent Activity AND the TVL
    // chart, so concurrent mounts never re-issue the same heavy RPC payload.
    // Batched getTransactions is deliberately NOT used: it freezes on HTTP 429
    // (public devnet) and HTTP 403/413 (Helius free tier rejects JSON-RPC batch
    // arrays).
    const programTxs = await loadRecentProgramTransactions(connection, poolAddress)

    const rows: StakingActivityRow[] = []
    for (const t of programTxs) {
      if (!t.tx || !t.tx.transaction) continue
      const row = extractActivityRow(
        t.tx,
        { signature: t.signature, slot: t.slot, blockTime: t.blockTime },
        poolAddress,
      )
      if (row) rows.push(row)
    }

    rows.sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0))
    return rows.slice(0, 12)
  })()

  activityInFlight.set(key, promise)
  try {
    const rows = await promise
    activityCache.set(key, { at: Date.now(), rows })
    return rows
  } finally {
    activityInFlight.delete(key)
  }
}

/**
 * Loads the SELECTED pool's real on-chain transactions (Stake / Unstake /
 * Claim Rewards / Fund Rewards) by reading the program's recent transactions.
 * Founder Console activity is pool-wide: no connected wallet is required and no
 * wallet filter is applied - any user's stake/unstake/claim or any founder's
 * funding on the selected pool is shown. Nothing is fabricated: rows only exist
 * when a matching on-chain transaction is found, and their amounts/timestamps
 * come from the transaction itself (instruction args, spl-token transfers,
 * slot, block time).
 */
export function useRecentActivity(poolArg?: PublicKey | null): RecentActivityState {
  const { connection } = useConnection()
  // Activity is scoped to the currently selected pool. Callers may pass an
  // explicit pool address; otherwise the app-wide selected pool is used. It
  // never silently filters everything to the env-default pool.
  const { poolAddress: contextPool } = usePoolOptional() ?? { poolAddress: null }
  const poolKey = poolArg ?? contextPool
  const [state, setState] = useState<RecentActivityState>({
    loading: true,
    rows: [],
    error: null,
  })

  useEffect(() => {
    if (!poolKey) {
      setState({ loading: false, rows: [], error: null })
      return
    }

    const poolAddress = poolKey.toBase58()
    setState((s) => ({ ...s, loading: true, error: null }))

    let cancelled = false

    void (async () => {
      try {
        const rows = await loadCachedActivityRows(connection, poolAddress)
        if (!cancelled) setState({ loading: false, rows, error: null })
      } catch (e) {
        // Surface real RPC errors (including 429) truthfully instead of hanging
        // on "Loading".
        if (!cancelled) {
          setState({
            loading: false,
            rows: [],
            error: e instanceof Error ? e.message : "Failed to load recent activity",
          })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [connection, poolKey])

  return state
}