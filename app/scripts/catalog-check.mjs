/** Network-free regression checks for the v2 all-markets catalog. */

import { strict as assert } from 'node:assert'
import { addressBookFor, SUPPORTED_CHAINS } from '../src/lib/addresses.ts'
import {
  FACTORY_MARKET_EVENT_TOPICS,
  PENDLE_MARKET_CATALOG_PAGE_SIZE,
  buildMarketCatalog,
  catalogMarketDisplayTvl,
  catalogMarketKey,
  currentCatalogMarketLifecycle,
  fetchFactoryMarketSnapshot,
  fetchMarketCatalog,
  normalizeCatalogMarket,
  parseFactoryMarketSnapshot,
} from '../src/lib/catalog.ts'

const NOW = 1_780_000_000
const INDEXED_THROUGH = 1_000
const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`
const HASH_C = `0x${'cc'.repeat(32)}`
const A = {
  market: '0x1111111111111111111111111111111111111111',
  pt: '0x2222222222222222222222222222222222222222',
  yt: '0x3333333333333333333333333333333333333333',
  sy: '0x4444444444444444444444444444444444444444',
}

function pendleRow(overrides = {}) {
  return {
    chainId: 42161,
    address: A.market,
    name: 'USD Test',
    protocol: 'Test protocol',
    icon: 'https://example.test/icon.svg',
    expiry: '2027-02-25T00:00:00.000Z',
    timestamp: '2026-06-15T12:34:56.000Z',
    pt: `42161-${A.pt}`,
    yt: `42161-${A.yt}`,
    sy: `42161-${A.sy}`,
    details: {
      totalTvl: 123_456.78,
      impliedApy: 0.071,
      underlyingApy: 0.052,
    },
    ...overrides,
  }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function provenance() {
  return {
    source: 'pendle-market-factory-events',
    factoryConfig: 'app/src/lib/addresses.ts',
    eventSignatures: {
      v1: 'CreateNewMarket(address,address,int256,int256)',
      v3Plus: 'CreateNewMarket(address,address,int256,int256,uint256)',
    },
    eventTopics: FACTORY_MARKET_EVENT_TOPICS,
  }
}

function factoryRows(chainId, indexedThrough, logFactory) {
  return addressBookFor(chainId).marketFactories.map((factory) => ({
    generation: factory.gen,
    address: factory.marketFactory.toLowerCase(),
    eventVersion: factory.gen === 'v1' ? 'v1' : 'v3+',
    deploymentBlock: 1,
    startBlockSource: 'configured',
    indexedThrough,
    logCount: factory.marketFactory.toLowerCase() === logFactory ? 1 : 0,
  }))
}

function placeholderChain(chainId, errors = ['not indexed in this fixture']) {
  return {
    chainId,
    complete: false,
    indexedThrough: null,
    indexedThroughHash: null,
    indexedThroughTimestamp: null,
    reorgAnchor: null,
    factories: [],
    marketCount: 0,
    quarantinedLogCount: 0,
    errors,
    markets: [],
  }
}

function emptyCompleteChain(chainId) {
  return {
    chainId,
    complete: true,
    indexedThrough: INDEXED_THROUGH,
    indexedThroughHash: HASH_C,
    indexedThroughTimestamp: NOW,
    reorgAnchor: { blockNumber: 900, blockHash: HASH_B },
    factories: factoryRows(chainId, INDEXED_THROUGH, ''),
    marketCount: 0,
    quarantinedLogCount: 0,
    errors: [],
    markets: [],
  }
}

function snapshot({
  completeArbitrum = false,
  marketAddress = A.market,
  marketHydration = {},
} = {}) {
  const chainId = 42161
  const firstFactory = addressBookFor(chainId).marketFactories[0]
  const factory = firstFactory.marketFactory.toLowerCase()
  const market = {
    key: `${chainId}:${marketAddress.toLowerCase()}`,
    chainId,
    address: marketAddress.toLowerCase(),
    pt: A.pt,
    factory,
    factoryGeneration: firstFactory.gen,
    eventVersion: 'v1',
    blockNumber: 500,
    blockHash: HASH_A,
    transactionHash: HASH_B,
    logIndex: 3,
    scalarRoot: '-123',
    initialAnchor: '456',
    lnFeeRateRoot: null,
    ...marketHydration,
  }
  const arbitrum = {
    chainId,
    complete: completeArbitrum,
    indexedThrough: INDEXED_THROUGH,
    indexedThroughHash: HASH_C,
    indexedThroughTimestamp: NOW,
    reorgAnchor: { blockNumber: 900, blockHash: HASH_B },
    factories: factoryRows(chainId, INDEXED_THROUGH, factory),
    marketCount: 1,
    quarantinedLogCount: 0,
    errors: [],
    markets: [market],
  }
  const chains = SUPPORTED_CHAINS.map((chain) =>
    chain.id === chainId ? arbitrum : placeholderChain(chain.id),
  )
  return {
    schemaVersion: 1,
    dataset: 'openpendle-factory-markets',
    provenance: provenance(),
    coverage: {
      complete: false,
      completeChains: completeArbitrum ? [chainId] : [],
      totalChains: SUPPORTED_CHAINS.length,
      marketCount: 1,
      quarantinedLogCount: 0,
    },
    chains,
  }
}

console.log('Pendle enrichment normalization keeps listing and lifecycle separate')
const normalized = normalizeCatalogMarket(pendleRow(), 'active', NOW)
assert(normalized !== null)
assert.equal(normalized.key, `42161:${A.market}`)
assert.equal(normalized.pt, A.pt)
assert.equal(normalized.yt, A.yt)
assert.equal(normalized.sy, A.sy)
assert.equal(normalized.expiry, Date.parse('2027-02-25T00:00:00.000Z') / 1_000)
assert.equal(normalized.tvl, 123_456.78)
assert.equal(normalized.impliedApy, 0.071)
assert.equal(normalized.underlyingApy, 0.052)
assert.equal(normalized.lifecycle, 'live')
assert.equal(normalized.pendleStatus, 'active')
assert.deepEqual(normalized.sources, ['pendle-listed'])
assert.equal(catalogMarketKey(42161, A.market), normalized.key)

const activeButMatured = normalizeCatalogMarket(
  pendleRow({ expiry: '2021-01-01T00:00:00.000Z' }),
  'active',
  NOW,
)
assert.equal(activeButMatured?.lifecycle, 'matured')
assert.equal(activeButMatured?.pendleStatus, 'active')
assert.equal(activeButMatured?.tvl, 123_456.78)
assert.equal(currentCatalogMarketLifecycle(activeButMatured, NOW), 'matured')
assert.equal(catalogMarketDisplayTvl(activeButMatured, NOW), null)
const inactiveButLive = normalizeCatalogMarket(pendleRow(), 'inactive', NOW)
assert.equal(inactiveButLive?.lifecycle, 'live')
assert.equal(inactiveButLive?.pendleStatus, 'inactive')
assert.equal(catalogMarketDisplayTvl(inactiveButLive, NOW), 123_456.78)

const sanitized = normalizeCatalogMarket(
  pendleRow({ name: '\u202E spoofed\nmarket ', protocol: '\u200BProtocol\u0000' }),
  'active',
  NOW,
)
assert.equal(sanitized?.name, 'spoofedmarket')
assert.equal(sanitized?.protocol, 'Protocol')
const malformed = normalizeCatalogMarket(
  pendleRow({
    expiry: 'not a date',
    timestamp: -1,
    pt: '42161-not-an-address',
    yt: `1-${A.yt}`,
    sy: {},
    icon: '',
    details: { totalTvl: -1, impliedApy: 'NaN', underlyingApy: 'NaN' },
  }),
  'active',
  NOW,
)
assert(malformed !== null)
assert.deepEqual(
  [
    malformed.expiry,
    malformed.createdAt,
    malformed.pt,
    malformed.yt,
    malformed.sy,
    malformed.icon,
    malformed.tvl,
    malformed.impliedApy,
    malformed.underlyingApy,
  ],
  [null, null, null, null, null, null, null, null, null],
)
assert.equal(
  normalizeCatalogMarket(
    pendleRow({ details: { underlyingApy: -1.01 } }),
    'active',
    NOW,
  )?.underlyingApy,
  null,
)
assert.equal(
  normalizeCatalogMarket(
    pendleRow({ details: { underlyingApy: 100.01 } }),
    'active',
    NOW,
  )?.underlyingApy,
  null,
)
assert.equal(normalizeCatalogMarket(pendleRow({ chainId: 10 }), 'active', NOW), null)
assert.equal(normalizeCatalogMarket(pendleRow({ address: 'bad' }), 'active', NOW), null)

console.log('Strict factory snapshot schema and placeholder support')
const parsed = parseFactoryMarketSnapshot(
  snapshot({
    completeArbitrum: true,
    marketHydration: {
      name: 'Hydrated market',
      yt: A.yt,
      sy: A.sy,
      expiry: 1_803_513_600,
      createdAt: 1_780_000_000,
    },
  }),
)
assert.equal(parsed.schemaVersion, 1)
assert.deepEqual(parsed.coverage.completeChains, [42161])
assert.equal(parsed.chains.length, SUPPORTED_CHAINS.length)
assert.equal(parsed.chains.find((chain) => chain.chainId === 42161)?.markets[0].sy, A.sy)

const completeSnapshot = structuredClone(snapshot({ completeArbitrum: true }))
completeSnapshot.chains = completeSnapshot.chains.map((chain) =>
  chain.chainId === 42161 ? chain : emptyCompleteChain(chain.chainId),
)
completeSnapshot.coverage.complete = true
completeSnapshot.coverage.completeChains = SUPPORTED_CHAINS.map((chain) => chain.id)
const parsedComplete = parseFactoryMarketSnapshot(completeSnapshot)
assert.equal(parsedComplete.coverage.complete, true)

const placeholder = {
  schemaVersion: 1,
  dataset: 'openpendle-factory-markets',
  provenance: provenance(),
  coverage: {
    complete: false,
    completeChains: [],
    totalChains: SUPPORTED_CHAINS.length,
    marketCount: 0,
    quarantinedLogCount: 0,
  },
  chains: SUPPORTED_CHAINS.map((chain) => placeholderChain(chain.id)),
}
assert.equal(parseFactoryMarketSnapshot(placeholder).coverage.marketCount, 0)

assert.throws(
  () => parseFactoryMarketSnapshot({ ...snapshot(), schemaVersion: 2 }),
  /Unsupported.*schema version/,
)
assert.throws(
  () => parseFactoryMarketSnapshot({ ...snapshot(), unexpected: true }),
  /unsupported root\.unexpected/,
)
const badAggregate = structuredClone(snapshot())
badAggregate.coverage.marketCount = 999
assert.throws(() => parseFactoryMarketSnapshot(badAggregate), /inconsistent aggregate coverage/)
const badFactoryCount = structuredClone(snapshot())
badFactoryCount.chains.find((chain) => chain.chainId === 42161).factories[0].logCount = 2
assert.throws(() => parseFactoryMarketSnapshot(badFactoryCount), /factory logCount/)
const missingChain = structuredClone(snapshot())
missingChain.chains.pop()
missingChain.coverage.totalChains -= 1
assert.throws(() => parseFactoryMarketSnapshot(missingChain), /invalid chains/)

console.log('Factory inventory is canonical; Pendle data only enriches or bootstraps gaps')
const factorySnapshot = parseFactoryMarketSnapshot(snapshot({ completeArbitrum: true }))
const listedMatch = normalizeCatalogMarket(pendleRow(), 'active', NOW)
const listedArbitrumOnly = normalizeCatalogMarket(
  pendleRow({ address: '0x5555555555555555555555555555555555555555' }),
  'active',
  NOW,
)
const listedBaseBootstrap = normalizeCatalogMarket(
  pendleRow({ chainId: 8453, address: '0x6666666666666666666666666666666666666666' }),
  'inactive',
  NOW,
)
assert(listedMatch && listedArbitrumOnly && listedBaseBootstrap)
const merged = buildMarketCatalog({
  factorySnapshot,
  pendleMarkets: [listedMatch, listedArbitrumOnly, listedBaseBootstrap],
  pendleCoverage: { active: true, inactive: true },
  now: NOW,
})
assert.equal(merged.markets.length, 2)
assert.equal(merged.byKey[listedArbitrumOnly.key], undefined)
assert.deepEqual(merged.byKey[listedMatch.key].sources, ['factory-indexed', 'pendle-listed'])
assert.equal(merged.byKey[listedMatch.key].pendleStatus, 'active')
assert.equal(merged.byKey[listedMatch.key].underlyingApy, 0.052)
assert.deepEqual(merged.byKey[listedBaseBootstrap.key].sources, ['pendle-listed'])
assert.equal(merged.coverage.complete, false)
assert.equal(merged.coverage.membership, 'partial')
assert.equal(merged.coverage.factory.status, 'partial')
assert.deepEqual(merged.coverage.factory.completeChains, [42161])
assert.equal(merged.coverage.factory.indexedAt[42161], NOW)

const bootstrap = buildMarketCatalog({
  factorySnapshot: null,
  pendleMarkets: [listedMatch],
  pendleCoverage: { active: true, inactive: false },
  now: NOW,
})
assert.equal(bootstrap.markets.length, 1)
assert.equal(bootstrap.coverage.membership, 'bootstrap')
assert.equal(bootstrap.coverage.complete, false)
assert.deepEqual(bootstrap.coverage.pendle, { active: true, inactive: false })

const factoryOnly = buildMarketCatalog({
  factorySnapshot,
  pendleMarkets: [],
  pendleCoverage: { active: false, inactive: false },
  now: NOW,
})
assert.equal(factoryOnly.markets[0].pendleStatus, null)
assert.equal(factoryOnly.markets[0].lifecycle, 'unknown')
assert.equal(factoryOnly.markets[0].underlyingApy, null)
assert.deepEqual(factoryOnly.markets[0].sources, ['factory-indexed'])

console.log('Snapshot fetcher handles valid, absent, and invalid snapshots')
assert.equal(
  await fetchFactoryMarketSnapshot({ fetcher: async () => response(null, 404) }),
  null,
)
assert.equal(
  (await fetchFactoryMarketSnapshot({ fetcher: async () => response(snapshot()) }))?.coverage
    .marketCount,
  1,
)
await assert.rejects(
  fetchFactoryMarketSnapshot({ fetcher: async () => response({ schemaVersion: 1 }) }),
  /unsupported root|invalid dataset/,
)

console.log('Pendle pagination and source-level partial failure semantics')
const calls = []
const paginatedFetch = async (input) => {
  const url = new URL(String(input))
  calls.push(url)
  if (url.pathname === '/catalog/factory-markets.v1.json') return response(null, 404)
  const active = url.searchParams.get('isActive') === 'true'
  const skip = Number(url.searchParams.get('skip'))
  if (!active) {
    return response({ total: 1, results: [pendleRow({ address: '0x7777777777777777777777777777777777777777' })] })
  }
  if (skip === 0) {
    return response({
      total: 101,
      results: Array.from({ length: PENDLE_MARKET_CATALOG_PAGE_SIZE }, (_, index) =>
        pendleRow({ address: `0x${(index + 10).toString(16).padStart(40, '0')}` }),
      ),
    })
  }
  return response({
    total: 101,
    results: [pendleRow({ address: '0x8888888888888888888888888888888888888888' })],
  })
}
const paginated = await fetchMarketCatalog({ fetcher: paginatedFetch })
assert.equal(calls.length, 4)
assert.equal(paginated.markets.length, 102)
assert.equal(paginated.coverage.membership, 'bootstrap')
assert.deepEqual(paginated.coverage.pendle, { active: true, inactive: true })

const factorySurvivesPendleOutage = await fetchMarketCatalog({
  fetcher: async (input) => {
    const url = new URL(String(input))
    return url.pathname === '/catalog/factory-markets.v1.json'
      ? response(snapshot())
      : response({ error: 'down' }, 503)
  },
})
assert.equal(factorySurvivesPendleOutage.markets.length, 1)
assert.deepEqual(factorySurvivesPendleOutage.coverage.pendle, {
  active: false,
  inactive: false,
})

const invalidFactoryFallsBack = await fetchMarketCatalog({
  fetcher: async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/catalog/factory-markets.v1.json') return response({ bad: true })
    const active = url.searchParams.get('isActive') === 'true'
    return active ? response({ results: [pendleRow()] }) : response({ error: 'down' }, 503)
  },
})
assert.equal(invalidFactoryFallsBack.markets.length, 1)
assert.equal(invalidFactoryFallsBack.coverage.membership, 'bootstrap')
assert.match(invalidFactoryFallsBack.coverage.factory.requestError ?? '', /snapshot/)

const timedPartial = await fetchMarketCatalog({
  requestTimeoutMs: 5,
  fetcher: async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/catalog/factory-markets.v1.json') return response(null, 404)
    const active = url.searchParams.get('isActive') === 'true'
    return active ? response({ results: [pendleRow()] }) : new Promise(() => {})
  },
})
assert.equal(timedPartial.markets.length, 1)
assert.deepEqual(timedPartial.coverage.pendle, { active: true, inactive: false })

await assert.rejects(
  fetchMarketCatalog({ fetcher: async () => response({ error: 'down' }, 503) }),
  /could not be loaded/,
)

console.log('ALL CATALOG CHECKS PASSED')
