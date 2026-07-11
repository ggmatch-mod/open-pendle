/**
 * M12 "Go to the pool" — resolve the market (PLP) for a pasted PT/YT so the
 * token-action page can link straight to the full pool (trade / LP / save).
 *
 * There is NO on-chain PT->market getter (a PT can even back more than one
 * market), so we resolve two ways, best reliability first:
 *   1. Pendle's public all-markets API — paginated and filtered by chain, so
 *      both active and expired LISTED pools resolve. Read-only and keyless.
 *      Community pools aren't indexed by Pendle, so this misses them.
 *   2. A keyless indexed-log API where available, queried by factory + PT
 *      topic. This covers community pools without an unbounded RPC scan.
 *   3. A best-effort direct event scan for chains without that index (or when
 *      it is unavailable). Default public RPCs often refuse the wide range,
 *      so this final fallback may still return [].
 * Never throws; returns [] when nothing resolves (the page then keeps its
 * market-less actions + "paste the market" note).
 */

import type { Address, PublicClient } from 'viem'
import { parseAbiItem, toEventSelector } from 'viem'
import { addressBookFor } from './addresses.ts'

const PENDLE_API = 'https://api-v2.pendle.finance/core'
const PENDLE_PAGE_SIZE = 100
const HEX40 = /^0x[0-9a-fA-F]{40}$/

/** Per-instance Blockscout APIs are keyless. Other chains keep the RPC fallback. */
const INDEXED_LOG_API: Partial<Record<number, string>> = {
  1: 'https://eth.blockscout.com/api',
  8453: 'https://base.blockscout.com/api',
  42161: 'https://arbitrum.blockscout.com/api',
}

/** Pendle API ids look like "42161-0x…"; take the address segment, lower-cased. */
function lastSeg(v: unknown): string {
  return typeof v === 'string' ? (v.split('-').pop() ?? '').toLowerCase() : ''
}

async function viaPendleApi(chainId: number, pt: Address, yt: Address): Promise<Address[]> {
  const found: Address[] = []
  let skip = 0
  try {
    const p = pt.toLowerCase()
    const y = yt.toLowerCase()

    while (true) {
      const url = new URL(`${PENDLE_API}/v2/markets/all`)
      url.searchParams.set('chainId', String(chainId))
      url.searchParams.set('limit', String(PENDLE_PAGE_SIZE))
      url.searchParams.set('skip', String(skip))
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) break

      const data: unknown = await res.json()
      const list: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as { results?: unknown }).results)
          ? (data as { results: unknown[] }).results
          : Array.isArray((data as { markets?: unknown }).markets)
            ? (data as { markets: unknown[] }).markets
            : []

      for (const entry of list) {
        const market = entry as { pt?: unknown; yt?: unknown; address?: unknown }
        if (lastSeg(market.pt) === p || lastSeg(market.yt) === y) {
          const address = lastSeg(market.address)
          if (HEX40.test(address)) found.push(address as Address)
        }
      }

      const total =
        typeof (data as { total?: unknown }).total === 'number'
          ? (data as { total: number }).total
          : undefined
      skip += list.length
      if (
        list.length === 0 ||
        list.length < PENDLE_PAGE_SIZE ||
        (total !== undefined && skip >= total)
      ) break
    }
  } catch {
    // network/shape error — fall through to the event scan
  }
  return [...new Set(found)]
}

const CREATE_MARKET_EVENT = parseAbiItem(
  'event CreateNewMarket(address indexed market, address indexed PT, int256 scalarRoot, int256 initialAnchor, uint256 lnFeeRateRoot)',
)
const CREATE_MARKET_TOPIC = toEventSelector(CREATE_MARKET_EVENT)

async function viaIndexedLogs(
  client: PublicClient,
  pt: Address,
): Promise<Address[]> {
  const base = INDEXED_LOG_API[client.chain?.id ?? 0]
  if (!base) return []

  const ptTopic = `0x${pt.slice(2).toLowerCase().padStart(64, '0')}`
  const found: Address[] = []
  try {
    const factories = addressBookFor(client).marketFactories.map((f) => f.marketFactory)
    for (const factory of factories) {
      const url = new URL(base)
      url.searchParams.set('module', 'logs')
      url.searchParams.set('action', 'getLogs')
      url.searchParams.set('fromBlock', '0')
      url.searchParams.set('toBlock', 'latest')
      url.searchParams.set('address', factory)
      url.searchParams.set('topic0', CREATE_MARKET_TOPIC)
      url.searchParams.set('topic2', ptTopic)
      url.searchParams.set('topic0_2_opr', 'and')
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) continue
      const body = (await response.json()) as { result?: unknown }
      if (!Array.isArray(body.result)) continue
      for (const entry of body.result) {
        const topics = (entry as { topics?: unknown }).topics
        if (
          !Array.isArray(topics) ||
          typeof topics[0] !== 'string' ||
          topics[0].toLowerCase() !== CREATE_MARKET_TOPIC.toLowerCase() ||
          typeof topics[1] !== 'string'
        ) continue
        const address = `0x${topics[1].slice(-40)}`
        if (HEX40.test(address)) found.push(address.toLowerCase() as Address)
      }
    }
  } catch {
    // Indexed service unavailable — fall through to the direct RPC scan.
  }
  return [...new Set(found)]
}

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
 * Resolve the market(s) for a token's PT — Pendle's API first (active or
 * expired listed pools), then indexed factory logs where supported, then a
 * best-effort direct event scan. Returns [] when nothing resolves. `client`
 * and `chainId` must be the same (active) chain.
 */
export async function resolveMarketsForToken(
  client: PublicClient,
  chainId: number,
  pt: Address,
  yt: Address,
): Promise<Address[]> {
  const api = await viaPendleApi(chainId, pt, yt)
  if (api.length > 0) return api
  const indexed = await viaIndexedLogs(client, pt)
  if (indexed.length > 0) return indexed
  return viaEvents(client, pt)
}
