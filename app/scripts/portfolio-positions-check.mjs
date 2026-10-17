/** Network-free regression checks for Portfolio OS valuation and actions. */

import { strict as assert } from 'node:assert'
import {
  buildPortfolioOverview,
  derivePortfolioActions,
  portfolioPositionPriceIds,
} from '../src/lib/portfolioPositions.ts'

const NOW = 2_000_000_000
const DAY = 24 * 60 * 60
const address = (digit) => `0x${digit.repeat(40)}`
const MARKET_A = address('1')
const MARKET_B = address('2')
const MARKET_C = address('3')
const PT = address('4')
const YT = address('5')
const SY = address('6')
const ASSET = address('7')
const USER = address('8')
const REWARD = address('9')
const FACTORY = address('a')

function snapshot(market, overrides = {}) {
  return {
    address: market,
    pt: overrides.pt ?? PT,
    yt: overrides.yt ?? YT,
    ptSymbol: 'PT-USD',
    ytSymbol: 'YT-USD',
    displayName: `USD ${market.slice(-4)}`,
    expiry: NOW + 6 * DAY,
    isExpired: false,
    factory: FACTORY,
    validated: true,
    vintage: 'active',
    sy: {
      address: SY,
      name: 'Standardized USD',
      symbol: 'SY-USD',
      decimals: 18,
      assetType: 0,
      assetAddress: ASSET,
      assetDecimals: 6,
      assetSymbol: 'USD',
      yieldToken: ASSET,
      tokensIn: [ASSET],
      tokensOut: [ASSET],
      exchangeRate: 10n ** 6n,
    },
    state: {
      totalPt: 100n * 10n ** 6n,
      totalSy: 100n * 10n ** 18n,
      totalLp: 100n * 10n ** 18n,
      treasury: address('b'),
      scalarRoot: 0n,
      lnFeeRateRoot: 0n,
      reserveFeePercent: 0n,
      lastLnImpliedRate: 0n,
    },
    metrics: {
      impliedApy: 0.1,
      ptPriceAsset: 0.9,
      ptPriceSy: 0.9,
      ytPriceAsset: 0.1,
      tvlAsset: 200,
      feeTier: 0.01,
      ptProportion: 0.5,
      nearRangeEdge: false,
    },
    trust: {
      syIsProxy: false,
      notes: [],
    },
    degraded: [],
    ...overrides,
  }
}

function positions(overrides = {}) {
  return {
    user: USER,
    pt: 0n,
    yt: 0n,
    lp: 0n,
    sy: 0n,
    walletTokens: [],
    ytClaimableInterestSy: 0n,
    ytClaimableRewards: [],
    lpClaimableRewards: [],
    syClaimableRewards: [],
    degraded: [],
    ...overrides,
  }
}

const items = [
  {
    target: { chainId: 1, market: MARKET_A },
    snapshot: snapshot(MARKET_A),
    positions: positions({
      pt: 10n * 10n ** 6n,
      yt: 5n * 10n ** 6n,
      lp: 10n * 10n ** 18n,
      ytClaimableRewards: [{ token: REWARD, amount: 1n, symbol: 'RWD', decimals: 18 }],
    }),
  },
  {
    target: { chainId: 1, market: MARKET_B },
    snapshot: snapshot(MARKET_B),
    positions: positions({
      pt: 10n * 10n ** 6n,
      yt: 5n * 10n ** 6n,
      lp: 20n * 10n ** 18n,
    }),
  },
]
const priceId = `1-${ASSET}`

console.log('Portfolio price requests de-duplicate accounting assets')
assert.deepEqual(portfolioPositionPriceIds(items), [priceId])

console.log('Shared PT/YT balances de-duplicate while LP remains market-specific')
const overview = buildPortfolioOverview(items, { [priceId]: 1 })
assert.equal(overview.holdings.length, 4)
assert.deepEqual(overview.holdings.map(({ role }) => role), ['PT', 'YT', 'LP', 'LP'])
assert.equal(overview.currentValueUsd, 66.5)
assert.equal(overview.principalAtMaturityUsd, 10)
assert.equal(overview.remainingPtValueUsd, 1)
assert.equal(overview.pricedHoldingCount, 4)
assert.equal(overview.unpricedHoldingCount, 0)
assert.equal(overview.chainCount, 1)
assert.equal(overview.claimableMarketCount, 1)

console.log('LP valuation converts raw SY to accounting units in both decimal directions')
const reverseDecimalSnapshot = snapshot(MARKET_C)
reverseDecimalSnapshot.sy = {
  ...reverseDecimalSnapshot.sy,
  decimals: 8,
  assetDecimals: 18,
  exchangeRate: 10n ** 28n,
}
reverseDecimalSnapshot.state = {
  ...reverseDecimalSnapshot.state,
  totalPt: 100n * 10n ** 18n,
  totalSy: 100n * 10n ** 8n,
}
const reverseDecimals = buildPortfolioOverview([{
  target: { chainId: 1, market: MARKET_C },
  snapshot: reverseDecimalSnapshot,
  positions: positions({ lp: 10n * 10n ** 18n }),
}], { [priceId]: 1 })
assert.equal(reverseDecimals.currentValueUsd, 19)

console.log('Unreadable SY exchange rates remain unpriced instead of using legacy placeholders')
const missingRateSnapshot = snapshot(MARKET_C, {
  degraded: ['SY exchangeRate() unavailable (legacy SCY?) — assuming 1.0; asset-terms metrics are approximate.'],
})
missingRateSnapshot.sy = { ...missingRateSnapshot.sy, exchangeRate: 10n ** 18n }
const missingRate = buildPortfolioOverview([{
  target: { chainId: 1, market: MARKET_C },
  snapshot: missingRateSnapshot,
  positions: positions({ lp: 10n * 10n ** 18n }),
}], { [priceId]: 1 })
assert.equal(missingRate.holdings[0].currentValueUsd, null)
assert.equal(missingRate.currentValueUsd, 0)
assert.equal(missingRate.unpricedHoldingCount, 1)
assert.equal(missingRate.degradedMarketCount, 1)

console.log('Missing asset prices fail closed without hiding balances')
const unpriced = buildPortfolioOverview(items, {})
assert.equal(unpriced.holdings.length, 4)
assert.equal(unpriced.currentValueUsd, 0)
assert.equal(unpriced.pricedHoldingCount, 0)
assert.equal(unpriced.unpricedHoldingCount, 4)
assert.equal(unpriced.principalAtMaturityUsd, 0)

console.log('Maturity, claim, and changed-risk evidence become review actions')
const liveRiskSnapshot = snapshot(MARKET_A, {
  metrics: { ...snapshot(MARKET_A).metrics, nearRangeEdge: true },
})
const expiredSnapshot = snapshot(MARKET_C, {
  pt: address('c'),
  yt: address('d'),
  expiry: NOW - 1,
  isExpired: true,
})
const actions = derivePortfolioActions([
  {
    target: { chainId: 1, market: MARKET_A },
    snapshot: liveRiskSnapshot,
    positions: positions({
      pt: 1n,
      ytClaimableInterestSy: 1n,
    }),
  },
  {
    target: { chainId: 1, market: MARKET_C },
    snapshot: expiredSnapshot,
    positions: positions({ pt: 1n }),
  },
], 30, NOW)
assert.deepEqual(
  actions.map(({ kind }) => kind),
  ['matured', 'maturity', 'risk', 'claim'],
)
assert.equal(actions.find(({ kind }) => kind === 'maturity')?.severity, 'warning')
assert.equal(actions.find(({ kind }) => kind === 'risk')?.detail, 'pool is near its rate-range edge')

console.log('Maturity transitions follow the clock even before the next RPC snapshot')
const crossedMaturity = {
  target: { chainId: 1, market: MARKET_C },
  snapshot: snapshot(MARKET_C, {
    expiry: NOW,
    isExpired: false,
    metrics: { ...snapshot(MARKET_C).metrics, nearRangeEdge: true },
  }),
  positions: positions({ pt: 1n }),
}
assert.deepEqual(derivePortfolioActions([crossedMaturity], 30, NOW).map(({ kind }) => kind), ['matured'])
const maturedOverview = buildPortfolioOverview([crossedMaturity], {}, NOW)
assert.equal(maturedOverview.holdings[0].isExpired, true)
assert.equal(maturedOverview.nearestMaturity, null)

console.log('Portfolio OS position checks passed.')
