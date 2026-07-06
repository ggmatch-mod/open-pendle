/**
 * Merkl (by Angle) rewards — claim a wallet's incentive rewards without any
 * backend of ours (M12-B). Merkl keeps ONE Merkle root per chain and its claim
 * takes every reward at once, so this surfaces ALL of the connected wallet's
 * claimable Merkl rewards on a chain (every protocol, not just Pendle — there is
 * no Pendle-only slice), exactly as other Merkl UIs do.
 *
 * Flow (fully client-side): fetch the wallet's rewards + Merkle proofs from
 * Merkl's public, keyless API (same category as the DefiLlama/CoinGecko ticker
 * calls), then claim through the Merkl Distributor. Proofs come ONLY from the
 * API (not computable client-side) and rotate ~every 4h, so fetch-then-claim
 * promptly. The Distributor credits the `users[]` param (not msg.sender), and
 * the wallet claims its OWN rewards, so no operator approval is needed.
 *
 * Response shape confirmed against api.merkl.xyz/docs/json (v4):
 *   GET /v4/users/{address}/rewards?chainId={id}
 *     -> Array<{ chain, rewards: Array<{ token:{address,symbol,decimals},
 *                amount, claimed, pending, proofs:string[] }> }>
 * `amount`/`claimed` are CUMULATIVE; claimable-now = amount - claimed, and the
 * Distributor is passed the cumulative `amount` (the proof is for that total).
 */

import type { Address } from 'viem'
import type { ActionPlan } from './types.ts'

/** Merkl Distributor — the SAME address on every chain Merkl supports. */
export const MERKL_DISTRIBUTOR: Address = '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae'

/** Minimal Merkl Distributor ABI: claim(users, tokens, amounts, proofs). */
export const merklDistributorAbi = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'users', type: 'address[]' },
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'proofs', type: 'bytes32[][]' },
    ],
    outputs: [],
  },
] as const

export interface MerklReward {
  token: Address
  symbol: string
  decimals: number
  /** Cumulative total earned (raw units). */
  amount: bigint
  /** Cumulative amount already claimed on-chain (raw units). */
  claimed: bigint
  /** Claimable now = amount - claimed (raw units); always > 0 for entries we keep. */
  claimable: bigint
  /** Merkle proof for the cumulative `amount` — from the API, not derivable locally. */
  proofs: `0x${string}`[]
}

const MERKL_API = 'https://api.merkl.xyz/v4'
const HEX40 = /^0x[0-9a-fA-F]{40}$/

function toBigInt(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) {
    try {
      return BigInt(v.trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * A wallet's claimable Merkl rewards on ONE chain (all protocols). Read-only,
 * keyless. Returns only rewards with something new to claim (amount > claimed).
 * NEVER throws — a network/API error or unexpected shape yields [] so the
 * positions page degrades gracefully (like the ticker).
 */
export async function fetchMerklRewards(chainId: number, user: Address): Promise<MerklReward[]> {
  let data: unknown
  try {
    const res = await fetch(`${MERKL_API}/users/${user}/rewards?chainId=${chainId}`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return []
    data = await res.json()
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []

  const out: MerklReward[] = []
  for (const group of data) {
    const rewards = (group as { rewards?: unknown } | null)?.rewards
    if (!Array.isArray(rewards)) continue
    for (const raw of rewards) {
      const r = raw as {
        token?: { address?: unknown; symbol?: unknown; decimals?: unknown }
        amount?: unknown
        claimed?: unknown
        proofs?: unknown
      }
      const tokenAddr = r.token?.address
      if (typeof tokenAddr !== 'string' || !HEX40.test(tokenAddr)) continue
      const amount = toBigInt(r.amount)
      const claimed = toBigInt(r.claimed) ?? 0n
      if (amount === undefined) continue
      const claimable = amount > claimed ? amount - claimed : 0n
      if (claimable <= 0n) continue
      const proofs = Array.isArray(r.proofs)
        ? r.proofs.filter((p): p is `0x${string}` => typeof p === 'string' && p.startsWith('0x'))
        : []
      // A reward with no proof cannot be claimed — skip it rather than build a
      // call that would revert.
      if (proofs.length === 0) continue
      out.push({
        token: tokenAddr as Address,
        symbol: typeof r.token?.symbol === 'string' ? r.token.symbol : '?',
        decimals: typeof r.token?.decimals === 'number' ? r.token.decimals : 18,
        amount,
        claimed,
        claimable,
        proofs,
      })
    }
  }
  return out
}

/**
 * Build the Merkl Distributor claim for a user's rewards on ONE chain: a single
 * claim(users[], tokens[], amounts[], proofs[][]). The Distributor credits the
 * user and nets off what's already been claimed on-chain, so each `amounts[i]`
 * is the CUMULATIVE `amount` (matching its proof), NOT amount - claimed. No
 * approvals. All rewards MUST be on the same chain as the sending client.
 */
export function planMerklClaim(user: Address, rewards: readonly MerklReward[]): ActionPlan {
  const n = rewards.length
  return {
    describe: `Claim ${n} Merkl reward${n === 1 ? '' : 's'}`,
    approvals: [],
    call: {
      address: MERKL_DISTRIBUTOR,
      abi: merklDistributorAbi,
      functionName: 'claim',
      args: [
        rewards.map(() => user),
        rewards.map((r) => r.token),
        rewards.map((r) => r.amount),
        rewards.map((r) => r.proofs),
      ],
    },
  }
}
