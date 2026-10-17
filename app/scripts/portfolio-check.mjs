/** Network-free regression checks for the Smart Yield Portfolio Builder. */

import { strict as assert } from 'node:assert'
import {
  MAX_MARKET_WEIGHT,
  MARKET_LIQUIDITY_ALLOCATION_RATIO,
  buildPortfolioRecommendation,
  fetchPendleAssetPrices,
  isLowRiskPortfolioMarket,
  parsePendleAssetPrices,
  portfolioPriceAssetIds,
} from '../src/lib/portfolio.ts'

const NOW = 1_785_000_000
const A = {
  market: '0x1111111111111111111111111111111111111111',
  pt: '0x2222222222222222222222222222222222222222',
  underlying: '0x3333333333333333333333333333333333333333',
  accounting: '0x4444444444444444444444444444444444444444',
}
const ETHENA = {
  usde: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  susde: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
}

function market(overrides = {}) {
  const chainId = overrides.chainId ?? 1
  const address = overrides.address ?? A.market
  return {
    key: `${chainId}:${address}`,
    chainId,
    address,
    name: 'Test market',
    protocol: 'Protocol A',
    expiry: NOW + 60 * 24 * 60 * 60,
    pt: A.pt,
    yt: null,
    sy: null,
    icon: null,
    tvl: 3_000_000,
    liquidity: 2_000_000,
    impliedApy: 0.12,
    underlyingApy: 0.05,
    underlyingAsset: A.underlying,
    accountingAsset: A.accounting,
    conversionRate: 1.2,
    categoryIds: ['stables'],
    isPrime: true,
    isVolatile: false,
    createdAt: NOW - 1_000,
    lifecycle: 'live',
    pendleStatus: 'active',
    sources: ['pendle-listed'],
    ...overrides,
  }
}

const input = {
  sizeUsd: 100_000,
  risk: 'any',
  chainIds: [1],
  maturity: 'any',
}

console.log('Asset-price parsing fails closed and ignores zero or malformed values')
assert.deepEqual(
  parsePendleAssetPrices({
    prices: {
      '1-0xabc': 1.01,
      '1-0xdef': 0,
      '1-0xghi': '1',
    },
  }),
  { '1-0xabc': 1.01 },
)
assert.throws(() => parsePendleAssetPrices({ results: {} }), /invalid response/)

console.log('Price fetching uses one all-prices request and filters locally')
let requestedUrl = null
const fetchedPrices = await fetchPendleAssetPrices(
  [`1-${A.underlying}`, `1-${A.accounting}`],
  {
    fetcher: async (url) => {
      requestedUrl = String(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          prices: {
            [`1-${A.underlying}`]: 1.2,
            [`1-${A.accounting}`]: 1,
            '1-0x9999999999999999999999999999999999999999': 50,
          },
        }),
      }
    },
  },
)
assert.equal(new URL(requestedUrl).searchParams.has('ids'), false)
assert.deepEqual(fetchedPrices, {
  [`1-${A.underlying}`]: 1.2,
  [`1-${A.accounting}`]: 1,
})

console.log('Stable price requests are deduplicated and limited to stable exposures')
assert.deepEqual(
  portfolioPriceAssetIds([
    market(),
    market({ address: '0x5555555555555555555555555555555555555555' }),
    market({
      address: '0x6666666666666666666666666666666666666666',
      categoryIds: ['eth'],
    }),
  ]),
  [`1-${A.underlying}`, `1-${A.accounting}`],
)

console.log('Higher APY leads, while a distinct protocol receives the final 10%')
const top = market()
const second = market({
  address: '0x5555555555555555555555555555555555555555',
  name: 'Second market',
  protocol: 'Protocol B',
  categoryIds: ['eth'],
  impliedApy: 0.08,
})
const recommendation = buildPortfolioRecommendation(
  [second, top],
  {
    [`1-${A.underlying}`]: 1.2,
    [`1-${A.accounting}`]: 1,
  },
  input,
  NOW,
)
assert.equal(recommendation.allocations.length, 2)
assert.equal(recommendation.allocations[0].market.name, 'Test market')
assert.equal(recommendation.allocations[0].amountUsd, input.sizeUsd * MAX_MARKET_WEIGHT)
assert.equal(recommendation.allocations[1].amountUsd, 10_000)
assert.equal(recommendation.unallocatedUsd, 0)

console.log('A single protocol cannot exceed 90% when alternatives exist')
const sameProtocol = buildPortfolioRecommendation(
  [
    top,
    market({
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'Same protocol',
      categoryIds: ['eth'],
      impliedApy: 0.08,
    }),
  ],
  {
    [`1-${A.underlying}`]: 1.2,
    [`1-${A.accounting}`]: 1,
  },
  input,
  NOW,
)
assert.equal(sameProtocol.deployedUsd, 90_000)
assert.equal(sameProtocol.unallocatedUsd, 10_000)

console.log('Depegged and unpriced stable exposures are excluded fail-closed')
const depegged = market({
  address: '0x6666666666666666666666666666666666666666',
  name: 'Depegged',
  impliedApy: 0.5,
})
const unpriced = market({
  address: '0x7777777777777777777777777777777777777777',
  name: 'Unpriced',
  underlyingAsset: '0x8888888888888888888888888888888888888888',
})
const screened = buildPortfolioRecommendation(
  [depegged, unpriced, second],
  {
    [`1-${A.underlying}`]: 1,
    [`1-${A.accounting}`]: 1,
  },
  input,
  NOW,
)
assert.deepEqual(screened.allocations.map((allocation) => allocation.market.name), ['Second market'])
assert.equal(screened.excludedDepeggedCount, 1)
assert.equal(screened.excludedUnpricedStableCount, 1)

console.log('Low risk is an explicit USDe exposure policy, not Pendle Prime')
const approvedUsde = market({
  name: 'USDe',
  protocol: 'Ethena',
  underlyingAsset: ETHENA.usde,
  accountingAsset: ETHENA.usde,
  conversionRate: 1,
  categoryIds: ['stables', 'ethena', 'blue-chips'],
  isPrime: false,
})
const approvedSusde = market({
  address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  name: 'sUSDe',
  protocol: 'Ethena',
  underlyingAsset: ETHENA.susde,
  accountingAsset: ETHENA.usde,
  categoryIds: ['stables', 'ethena', 'blue-chips'],
})
const primeSusdai = market({
  address: '0xcccccccccccccccccccccccccccccccccccccccc',
  chainId: 42161,
  name: 'sUSDai',
  protocol: 'USD.AI',
  categoryIds: ['stables', 'rwa', 'points'],
  isPrime: true,
  isVolatile: false,
})
assert.equal(isLowRiskPortfolioMarket(approvedUsde), true)
assert.equal(isLowRiskPortfolioMarket(approvedSusde), true)
assert.equal(isLowRiskPortfolioMarket(primeSusdai), false)

console.log('Low risk, network, and maturity filters are hard constraints')
const filtered = buildPortfolioRecommendation(
  [
    primeSusdai,
    market({ name: 'Prime but unapproved' }),
    market({ ...approvedUsde, chainId: 42161, name: 'USDe on wrong chain' }),
    market({
      ...approvedUsde,
      address: '0xdddddddddddddddddddddddddddddddddddddddd',
      expiry: NOW + 200 * 24 * 60 * 60,
      name: 'USDe with too-long maturity',
    }),
    approvedUsde,
  ],
  {
    [`1-${ETHENA.susde}`]: 1.2,
    [`1-${ETHENA.usde}`]: 1,
  },
  { ...input, risk: 'low', maturity: '3m' },
  NOW,
)
assert.deepEqual(
  filtered.allocations.map((allocation) => allocation.market.name),
  ['USDe'],
)

console.log('Reported liquidity caps each proposed market allocation')
const thin = market({ liquidity: 100_000 })
const liquid = market({
  address: '0x9999999999999999999999999999999999999999',
  name: 'Liquid fallback',
  protocol: 'Protocol B',
  categoryIds: ['eth'],
  impliedApy: 0.08,
})
const liquidityAware = buildPortfolioRecommendation(
  [thin, liquid],
  {
    [`1-${A.underlying}`]: 1.2,
    [`1-${A.accounting}`]: 1,
  },
  input,
  NOW,
)
assert.equal(
  liquidityAware.allocations[0].amountUsd,
  thin.liquidity * MARKET_LIQUIDITY_ALLOCATION_RATIO,
)
assert.equal(liquidityAware.allocations[0].liquidityShare, MARKET_LIQUIDITY_ALLOCATION_RATIO)
assert.equal(liquidityAware.allocations[1].amountUsd, 90_000)

assert.throws(
  () => buildPortfolioRecommendation([top], {}, { ...input, sizeUsd: 0 }, NOW),
  /greater than zero/,
)
assert.throws(
  () => buildPortfolioRecommendation([top], {}, { ...input, chainIds: [] }, NOW),
  /at least one network/,
)

console.log('Portfolio builder checks passed.')
