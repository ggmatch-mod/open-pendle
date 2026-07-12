/**
 * M12 "Go to the pool" — resolve the market (PLP) for a pasted PT/YT so the
 * token-action page can link straight to the full pool (trade / LP / save).
 *
 * There is NO on-chain PT->market getter (a PT can even back more than one
 * market), so we resolve two ways, best reliability first:
 *   1. Pendle's public all-markets API — paginated and filtered by chain, so
 *      both active and expired LISTED pools resolve. Read-only and keyless.
 *      Community pools aren't indexed by Pendle, so this misses them.
 *   2. OpenPendle's bundled factory snapshot — canonical across every
 *      supported chain and inclusive of community-created markets.
 *   3. A keyless indexed-log API where available, queried by factory + PT
 *      topic. This covers community pools without an unbounded RPC scan.
 *   4. A best-effort direct event scan for chains without that index (or when
 *      it is unavailable). Default public RPCs often refuse the wide range,
 *      so this final fallback may still return [].
 * Never throws; returns [] when nothing resolves (the page then keeps its
 * market-less actions + "paste the market" note).
 */

import type { Address, PublicClient } from 'viem'
import { parseAbiItem, toEventSelector } from 'viem'
import { addressBookFor } from './addresses.ts'
import { fetchFactoryMarketSnapshot } from './catalog.ts'

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

async function viaFactorySnapshot(
  chainId: number,
  pt: Address,
  yt: Address,
): Promise<{ markets: Address[]; complete: boolean; indexedThrough: number | null }> {
  try {
    const snapshot = await fetchFactoryMarketSnapshot()
    const chain = snapshot?.chains.find((entry) => entry.chainId === chainId)
    if (chain === undefined) return { markets: [], complete: false, indexedThrough: null }
    const p = pt.toLowerCase()
    const y = yt.toLowerCase()
    return {
      markets: chain.markets
        .filter((market) => market.pt === p || market.yt === y)
        .map((market) => market.address),
      complete: chain.complete,
      indexedThrough: chain.indexedThrough,
    }
  } catch {
    // A missing/stale deployment artifact must not suppress live fallbacks.
    return { markets: [], complete: false, indexedThrough: null }
  }
}

function uniqueAddresses(...groups: Address[][]): Address[] {
  return [...new Set(groups.flat().map((address) => address.toLowerCase() as Address))]
}

const CREATE_MARKET_V1_EVENT = parseAbiItem(
  'event CreateNewMarket(address indexed market, address indexed PT, int256 scalarRoot, int256 initialAnchor)',
)
const CREATE_MARKET_V3_PLUS_EVENT = parseAbiItem(
  'event CreateNewMarket(address indexed market, address indexed PT, int256 scalarRoot, int256 initialAnchor, uint256 lnFeeRateRoot)',
)
const CREATE_MARKET_V1_TOPIC = toEventSelector(CREATE_MARKET_V1_EVENT)
const CREATE_MARKET_V3_PLUS_TOPIC = toEventSelector(CREATE_MARKET_V3_PLUS_EVENT)

async function viaIndexedLogs(
  client: PublicClient,
  pt: Address,
  fromBlock = 0,
): Promise<{ markets: Address[]; complete: boolean }> {
  const base = INDEXED_LOG_API[client.chain?.id ?? 0]
  if (!base) return { markets: [], complete: false }

  const ptTopic = `0x${pt.slice(2).toLowerCase().padStart(64, '0')}`
  const found: Address[] = []
  let complete = true
  const factories = addressBookFor(client).marketFactories
  for (const factory of factories) {
    try {
      const topic =
        factory.gen === 'v1' ? CREATE_MARKET_V1_TOPIC : CREATE_MARKET_V3_PLUS_TOPIC
      const url = new URL(base)
      url.searchParams.set('module', 'logs')
      url.searchParams.set('action', 'getLogs')
      url.searchParams.set('fromBlock', String(fromBlock))
      url.searchParams.set('toBlock', 'latest')
      url.searchParams.set('address', factory.marketFactory)
      url.searchParams.set('topic0', topic)
      url.searchParams.set('topic2', ptTopic)
      url.searchParams.set('topic0_2_opr', 'and')
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        complete = false
        continue
      }
      const body = (await response.json()) as { result?: unknown }
      if (!Array.isArray(body.result)) {
        complete = false
        continue
      }
      for (const entry of body.result) {
        const topics = (entry as { topics?: unknown }).topics
        if (
          !Array.isArray(topics) ||
          typeof topics[0] !== 'string' ||
          topics[0].toLowerCase() !== topic.toLowerCase() ||
          typeof topics[1] !== 'string'
        ) continue
        const address = `0x${topics[1].slice(-40)}`
        if (HEX40.test(address)) found.push(address.toLowerCase() as Address)
      }
    } catch {
      complete = false
    }
  }
  return { markets: [...new Set(found)], complete }
}

async function viaEvents(
  client: PublicClient,
  pt: Address,
  fromBlock: bigint | 'earliest' = 'earliest',
): Promise<Address[]> {
  const factories = addressBookFor(client).marketFactories
  const v1Factories = factories
    .filter((factory) => factory.gen === 'v1')
    .map((factory) => factory.marketFactory)
  const modernFactories = factories
    .filter((factory) => factory.gen !== 'v1')
    .map((factory) => factory.marketFactory)

  // The original factory omits lnFeeRateRoot from CreateNewMarket because its
  // fee is factory-global. Query both deployed event ABIs; using only the
  // modern topic silently loses every V1 market.
  const scans: Array<Promise<Address[]>> = []
  if (v1Factories.length > 0) {
    scans.push(
      client
        .getLogs({
          address: v1Factories,
          event: CREATE_MARKET_V1_EVENT,
          args: { PT: pt },
          fromBlock,
          toBlock: 'latest',
        })
        .then((logs) => logs.map((log) => log.args.market as Address))
        .catch(() => []),
    )
  }
  if (modernFactories.length > 0) {
    scans.push(
      client
        .getLogs({
          address: modernFactories,
          event: CREATE_MARKET_V3_PLUS_EVENT,
          args: { PT: pt },
          fromBlock,
          toBlock: 'latest',
        })
        .then((logs) => logs.map((log) => log.args.market as Address))
        .catch(() => []),
    )
  }

  // Public RPCs often refuse these wide ranges. Each event generation fails
  // independently so one provider limitation cannot discard the other.
  return [...new Set((await Promise.all(scans)).flat())]
}

/**
 * Resolve the market(s) for a token's PT — Pendle's API first (active or
 * expired listed pools), then the bundled six-chain factory snapshot, indexed
 * logs where supported, and finally a best-effort direct event scan. Returns
 * [] when nothing resolves. `client` and `chainId` must be the same chain.
 */
export async function resolveMarketsForToken(
  client: PublicClient,
  chainId: number,
  pt: Address,
  yt: Address,
): Promise<Address[]> {
  const [api, snapshot] = await Promise.all([
    viaPendleApi(chainId, pt, yt),
    viaFactorySnapshot(chainId, pt, yt),
  ])
  const canonical = uniqueAddresses(api, snapshot.markets)
  const deltaStart = snapshot.complete && snapshot.indexedThrough !== null
    ? snapshot.indexedThrough + 1
    : 0
  const indexed = await viaIndexedLogs(client, pt, deltaStart)
  if (indexed.complete) return uniqueAddresses(canonical, indexed.markets)
  return uniqueAddresses(
    canonical,
    indexed.markets,
    await viaEvents(client, pt, deltaStart === 0 ? 'earliest' : BigInt(deltaStart)),
  )
}
