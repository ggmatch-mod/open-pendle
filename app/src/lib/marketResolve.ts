/**
 * M12 "Go to the pool" — resolve the market (PLP) for a pasted PT/YT so the
 * token-action page can link straight to the full pool (trade / LP / save).
 *
 * There is NO on-chain PT->market getter (a PT can even back more than one
 * market), so we resolve two ways, best reliability first:
 *   1. Pendle's public API — instant for LISTED pools. Read-only, keyless
 *      (same category as the DefiLlama/CoinGecko ticker; you opted into it).
 *      Community pools aren't indexed by Pendle, so this misses them.
 *   2. A best-effort event scan of the chain's market factories, filtered on
 *      the PT (an indexed topic of CreateNewMarket). This covers community
 *      pools too — but the default public RPCs REFUSE a wide getLogs range
 *      (verified), so it only succeeds on a user's own capable RPC (Alchemy/
 *      dRPC). It fails closed (returns []) otherwise.
 * Never throws; returns [] when nothing resolves (the page then keeps its
 * market-less actions + "paste the market" note).
 */

import type { Address, PublicClient } from 'viem'
import { parseAbiItem } from 'viem'
import { addressBookFor } from './addresses.ts'

const PENDLE_API = 'https://api-v2.pendle.finance/core/v1'
const HEX40 = /^0x[0-9a-fA-F]{40}$/

/** Pendle API ids look like "42161-0x…"; take the address segment, lower-cased. */
function lastSeg(v: unknown): string {
  return typeof v === 'string' ? (v.split('-').pop() ?? '').toLowerCase() : ''
}

async function viaPendleApi(chainId: number, pt: Address, yt: Address): Promise<Address | undefined> {
  try {
    const res = await fetch(`${PENDLE_API}/${chainId}/markets/active`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return undefined
    const data: unknown = await res.json()
    const list: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { markets?: unknown }).markets)
        ? (data as { markets: unknown[] }).markets
        : Array.isArray((data as { results?: unknown }).results)
          ? (data as { results: unknown[] }).results
          : []
    const p = pt.toLowerCase()
    const y = yt.toLowerCase()
    for (const entry of list) {
      const m = entry as { pt?: unknown; yt?: unknown; address?: unknown }
      if (lastSeg(m.pt) === p || lastSeg(m.yt) === y) {
        const a = lastSeg(m.address)
        if (HEX40.test(a)) return a as Address
      }
    }
  } catch {
    // network/shape error — fall through to the event scan
  }
  return undefined
}

const CREATE_MARKET_EVENT = parseAbiItem(
  'event CreateNewMarket(address indexed market, address indexed PT, int256 scalarRoot, int256 initialAnchor, uint256 lnFeeRateRoot)',
)

async function viaEvents(client: PublicClient, pt: Address): Promise<Address[]> {
  try {
    const factories = addressBookFor(client).marketFactories.map((f) => f.marketFactory)
    const logs = await client.getLogs({
      address: factories,
      event: CREATE_MARKET_EVENT,
      args: { PT: pt },
      fromBlock: 'earliest',
      toBlock: 'latest',
    })
    return [...new Set(logs.map((l) => l.args.market as Address))]
  } catch {
    // Public RPCs refuse a wide getLogs range — silently give up (the page
    // falls back to "paste the market"). A capable custom RPC will succeed.
    return []
  }
}

/**
 * Resolve the market(s) for a token's PT — Pendle's API first (listed pools),
 * then a best-effort event scan (community pools, capable RPCs only). Returns []
 * when nothing resolves. `client` and `chainId` must be the same (active) chain.
 */
export async function resolveMarketsForToken(
  client: PublicClient,
  chainId: number,
  pt: Address,
  yt: Address,
): Promise<Address[]> {
  const api = await viaPendleApi(chainId, pt, yt)
  if (api) return [api]
  return viaEvents(client, pt)
}
