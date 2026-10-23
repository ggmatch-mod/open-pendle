/** Network-free regression checks for the Hyperliquid → Boros hedge prototype. */

import { strict as assert } from 'node:assert'
import {
  borosPreviewFreshness,
  fetchBorosHyperliquidBtcMarkets,
  simulateBorosHedge,
} from '../src/lib/boros.ts'
import {
  buildFundingHedgePlan,
  calculateFundingHedgeEconomics,
  recommendedBorosMarkets,
} from '../src/lib/fundingHedge.ts'
import { fetchHyperliquidBtcPositions } from '../src/lib/hyperliquid.ts'

const CONNECTED = '0x1111111111111111111111111111111111111111'
const MASTER = '0x2222222222222222222222222222222222222222'
const SUBACCOUNT = '0x3333333333333333333333333333333333333333'
const NOW = Math.floor(Date.now() / 1_000)

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  }
}

function position(szi, overrides = {}) {
  return {
    type: 'oneWay',
    position: {
      coin: 'BTC',
      szi,
      entryPx: '40000',
      positionValue: '999999', // must not drive funding notional
      unrealizedPnl: '120',
      liquidationPx: null,
      marginUsed: '1000',
      leverage: { type: 'cross', value: 5 },
      cumFunding: { sinceOpen: '-15' },
      ...overrides,
    },
  }
}

console.log('Agent wallets resolve to the principal; BTC funding notional uses oracle price')
const hyperliquidBodies = []
const hyperliquidSnapshot = await fetchHyperliquidBtcPositions(CONNECTED, {
  fetcher: async (_url, init) => {
    const body = JSON.parse(init.body)
    hyperliquidBodies.push(body)
    if (body.type === 'userRole') {
      return response({ role: 'agent', data: { user: MASTER } })
    }
    if (body.type === 'clearinghouseState') {
      assert.equal(body.user, MASTER)
      return response({ assetPositions: [position('1.25')], time: 1_785_514_000_000 })
    }
    if (body.type === 'subAccounts') {
      assert.equal(body.user, MASTER)
      return response([{
        name: 'Carry',
        subAccountUser: SUBACCOUNT,
        clearinghouseState: {
          assetPositions: [position('-0.25')],
          time: 1_785_514_001_000,
        },
      }])
    }
    if (body.type === 'metaAndAssetCtxs') {
      return response([
        { universe: [{ name: 'ETH' }, { name: 'BTC' }] },
        [{ oraclePx: '1800' }, { oraclePx: '50000' }],
      ])
    }
    throw new Error(`Unexpected Hyperliquid request: ${body.type}`)
  },
})
assert.equal(hyperliquidSnapshot.rootAddress, MASTER)
assert.equal(hyperliquidSnapshot.positions.length, 2)
assert.equal(hyperliquidSnapshot.positions[0].notionalUsd, 62_500)
assert.equal(hyperliquidSnapshot.positions[0].direction, 'long')
assert.equal(hyperliquidSnapshot.positions[1].direction, 'short')
assert.equal(hyperliquidSnapshot.oraclePrice, 50_000)
assert.equal(hyperliquidSnapshot.sourceTimestamp, 1_785_514_000_000)
assert(hyperliquidBodies.some((body) => body.type === 'userRole'))

function market(tokenId, marketId, overrides = {}) {
  return {
    marketId,
    tokenId,
    imData: {
      name: 'Hyperliquid BTC 28 Aug 2026',
      symbol: 'HYPERLIQUID-BTC-28AUG2026',
      maturity: NOW + 27 * 86_400,
    },
    config: { status: 2 },
    extConfig: { ammId: marketId * 10, settleFeeRate: '1000000000000000' },
    metadata: {
      underlyingSymbol: 'BTC',
      fundingRateSymbol: 'hyperliquid-btc',
      isUiWhitelisted: true,
    },
    platform: { name: 'Hyperliquid' },
    data: {
      markApr: 0.064,
      midApr: 0.061,
      bestBid: 0.059,
      bestAsk: tokenId === 1 ? 0.063 : 0.065,
      floatingApr: 0.1095,
      notionalOI: tokenId === 1 ? 50 : 250000,
      volume24h: 100,
      rateSensitivity: 0.0007,
    },
    ...overrides,
  }
}

console.log('Boros market discovery keeps same-symbol collateral pools separate')
const universe = await fetchBorosHyperliquidBtcMarkets({
  fetcher: async (url) => {
    if (String(url).includes('/assets')) {
      return response({ results: [
        { id: 'BTC', tokenId: 1, name: 'Wrapped BTC', symbol: 'WBTC', decimals: 8, usdPrice: '50000', isCollateral: true },
        { id: 'USDT', tokenId: 3, name: 'USD Tether', symbol: 'USD₮0', decimals: 6, usdPrice: '0.999', isCollateral: true },
      ] })
    }
    return response({
      results: [market(1, 171), market(3, 178)],
      syncStatus: { blockNumber: 123, timestamp: NOW },
    })
  },
})
assert.deepEqual(universe.markets.map((item) => item.marketId), [178, 171])
assert.equal(universe.markets[0].collateral.unit, 'usd')
assert.equal(universe.markets[1].collateral.unit, 'btc')
assert.equal(universe.markets[0].settlementFeeApr, 0.001)

console.log('Discovery follows opaque pagination and accepts markets without a deprecated AMM ID')
const discoveryUrls = []
const paginatedUniverse = await fetchBorosHyperliquidBtcMarkets({
  fetcher: async (url) => {
    const parsed = new URL(url)
    discoveryUrls.push(parsed)
    if (parsed.pathname.endsWith('/assets')) {
      return response({ results: [
        { id: 'BTC', tokenId: 1, symbol: 'WBTC', decimals: 8, usdPrice: '50000', isCollateral: true },
      ] })
    }
    if (!parsed.searchParams.has('resumeToken')) {
      return response({ results: [], resumeToken: 'next+/=', syncStatus: { timestamp: NOW } })
    }
    assert.equal(parsed.searchParams.get('resumeToken'), 'next+/=')
    return response({
      results: [market(1, 171, { extConfig: { settleFeeRate: '1000000000000000' } })],
      resumeToken: null,
      syncStatus: { timestamp: NOW - 10 },
    })
  },
})
assert.equal(paginatedUniverse.markets.length, 1)
assert.equal(paginatedUniverse.markets[0].ammId, undefined)
assert.equal(paginatedUniverse.syncTimestamp, NOW - 10)
assert.equal(discoveryUrls.filter((url) => url.pathname.endsWith('/markets')).length, 2)

console.log('Repeated pagination tokens fail instead of returning an incomplete universe')
await assert.rejects(
  fetchBorosHyperliquidBtcMarkets({
    fetcher: async (url) => String(url).includes('/assets')
      ? response({ results: [] })
      : response({ results: [], resumeToken: 'repeated', syncStatus: { timestamp: NOW } }),
  }),
  /invalid market pagination token/,
)

console.log('Recommendation picks the cheaper same-maturity rate, then sizes by collateral unit')
const detectedLong = hyperliquidSnapshot.positions[0]
const ranked = recommendedBorosMarkets(detectedLong, universe.markets, NOW)
assert.deepEqual(ranked.map((item) => item.marketId), [171, 178])
const btcPlan = buildFundingHedgePlan(detectedLong, ranked[0], 10_000, NOW)
assert.equal(btcPlan.side, 'long')
assert.equal(btcPlan.sizeX18, '1250000000000000000')
assert.equal(btcPlan.hedgedNotionalUsd, 62_500)

const usdPlan = buildFundingHedgePlan(detectedLong, ranked[1], 5_000, NOW)
assert.equal(usdPlan.side, 'long')
assert(Math.abs(usdPlan.sizeYu - (31_250 / 0.999)) < 0.000001)
assert.equal(usdPlan.uncoveredNotionalUsd, 31_250)

console.log('Short Hyperliquid exposure maps to short YU at the same hedge fraction')
const detectedShort = hyperliquidSnapshot.positions[1]
const shortPlan = buildFundingHedgePlan(detectedShort, ranked[0], 5_000, NOW)
assert.equal(shortPlan.side, 'short')
assert.equal(shortPlan.sizeX18, '125000000000000000')

console.log('Economics include taker and projected settlement fees without double-counting margin')
const quote = {
  marketId: btcPlan.market.marketId,
  side: btcPlan.side,
  requestedSizeX18: btcPlan.sizeX18,
  matchedSizeX18: btcPlan.sizeX18,
  matchedRate: 0.0635,
  matchedCostX18: '79375000000000000',
  marginRequiredX18: '003500000000000000',
  priceImpact: 0.001,
  takerFeeX18: '47000000000000',
  takerFeeUsd: 2.35,
  quotedAt: Date.now(),
}
const economics = calculateFundingHedgeEconomics(btcPlan, quote)
assert.equal(economics.fullFill, true)
assert.equal(economics.marginRequiredUsd, 175)
assert(economics.settlementFeeUsd > 4)
assert.equal(economics.totalFeeUsd, economics.takerFeeUsd + economics.settlementFeeUsd)
assert(economics.netFixedApr > economics.fixedApr)

console.log('A fresh local fetch cannot make an old upstream market snapshot current')
const previewNow = NOW * 1_000
assert.equal(borosPreviewFreshness(NOW - 30, previewNow - 5_000, previewNow).isFresh, true)
assert.equal(borosPreviewFreshness(NOW - 121, previewNow, previewNow).isFresh, false)
assert.equal(borosPreviewFreshness(NOW, previewNow - 46_000, previewNow).isFresh, false)
assert.equal(borosPreviewFreshness(NOW + 60, previewNow, previewNow).isFresh, false)
assert.equal(borosPreviewFreshness(NOW, undefined, previewNow).isFresh, false)

console.log('Stale or undated Hyperliquid subaccounts cannot be hidden by fresh Boros quotes')
for (const subaccountTime of [previewNow - 121_000, undefined, 0]) {
  const exposure = await fetchHyperliquidBtcPositions(CONNECTED, {
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.type === 'userRole') return response({ role: 'user' })
      if (body.type === 'clearinghouseState') {
        return response({ assetPositions: [position('1')], time: previewNow })
      }
      if (body.type === 'subAccounts') return response([{
        name: 'Old carry account', subAccountUser: SUBACCOUNT,
        clearinghouseState: { assetPositions: [position('-0.25')], time: subaccountTime },
      }])
      if (body.type === 'metaAndAssetCtxs') return response([
        { universe: [{ name: 'BTC' }] }, [{ oraclePx: '50000' }],
      ])
      throw new Error(`Unexpected request: ${body.type}`)
    },
  })
  assert.equal(exposure.positions.length, 2, 'Freshness must not hide discovered balances')
  assert.equal(exposure.sourceTimestamp, subaccountTime === undefined || subaccountTime === 0
    ? null : subaccountTime)
  assert.equal(borosPreviewFreshness(NOW, previewNow, previewNow, exposure.sourceTimestamp).isFresh, false)
}
assert.equal(borosPreviewFreshness(NOW, previewNow, previewNow, previewNow - 30_000).isFresh, true)
assert.equal(borosPreviewFreshness(NOW, previewNow, previewNow, null).isFresh, false)
assert.equal(borosPreviewFreshness(NOW, previewNow, previewNow, undefined).isFresh, true,
  'Clearly marked sample exposure requires only Boros source and quote freshness')

console.log('Negative fixed rates preserve the fixed-leg direction')
const negativeLongEconomics = calculateFundingHedgeEconomics(btcPlan, {
  ...quote,
  matchedRate: -0.01,
  matchedCostX18: '-12500000000000000',
})
assert(negativeLongEconomics.fixedTermCashflowUsd < 0)

console.log('Anonymous simulation is FOK, pins AMM routing, and uses a 50 bp APR guard')
let simulatedBody = null
const simulated = await simulateBorosHedge(
  { marketId: 171, ammId: 1710, side: 'long', sizeX18: '1000000000000000000' },
  {
    fetcher: async (_url, init) => {
      simulatedBody = JSON.parse(init.body)
      return response({
        matched: { size: '1000000000000000000', cost: '63500000000000000', rate: 0.0635 },
        marginRequired: '3500000000000000',
        priceImpact: 0.001,
        feeBreakdown: { takerOtcFee: '47000000000000', takerOtcFeeInUSD: 2.35 },
      })
    },
  },
)
assert.equal(simulated.matchedRate, 0.0635)
assert.deepEqual(simulatedBody, {
  marketId: 171,
  side: 0,
  size: '1000000000000000000',
  tif: 2,
  slippage: 0.005,
  ammId: 1710,
})

console.log('A missing optional AMM ID is omitted from the simulation body')
await simulateBorosHedge(
  { marketId: 171, side: 'long', sizeX18: '1000000000000000000' },
  {
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body)
      assert.equal(Object.hasOwn(body, 'ammId'), false)
      return response({
        matched: { size: '1000000000000000000', cost: '63500000000000000', rate: 0.0635 },
        marginRequired: '3500000000000000',
        priceImpact: 0.001,
        feeBreakdown: { takerOtcFee: '47000000000000', takerOtcFeeInUSD: 2.35 },
      })
    },
  },
)

console.log('Unavailable trading fees stay unknown through all after-fee economics')
const unavailableFeeQuote = await simulateBorosHedge(
  { marketId: btcPlan.market.marketId, side: 'long', sizeX18: btcPlan.sizeX18 },
  {
    fetcher: async () => response({
      matched: { size: btcPlan.sizeX18, cost: quote.matchedCostX18, rate: quote.matchedRate },
      marginRequired: quote.marginRequiredX18,
      priceImpact: 0.001,
    }),
  },
)
assert.equal(unavailableFeeQuote.takerFeeUsd, null)
assert.equal(unavailableFeeQuote.takerFeeX18, null)
const unknownFeeEconomics = calculateFundingHedgeEconomics(btcPlan, unavailableFeeQuote)
assert.equal(unknownFeeEconomics.totalFeeUsd, null)
assert.equal(unknownFeeEconomics.netFixedApr, null)
assert.equal(unknownFeeEconomics.comparisonToCurrentUsd, null)
assert.equal(unknownFeeEconomics.fullFill, true)
assert.equal(unknownFeeEconomics.fixedTermCashflowUsd, economics.fixedTermCashflowUsd)
const zeroFeeEconomics = calculateFundingHedgeEconomics(btcPlan, { ...quote, takerFeeUsd: 0 })
assert.equal(zeroFeeEconomics.takerFeeUsd, 0)
assert.equal(zeroFeeEconomics.totalFeeUsd, zeroFeeEconomics.settlementFeeUsd)

console.log('Short-side simulations preserve Boros signed size and cost')
const shortSimulation = await simulateBorosHedge(
  { marketId: 171, ammId: 1710, side: 'short', sizeX18: shortPlan.sizeX18 },
  {
    fetcher: async () => response({
      matched: {
        size: `-${shortPlan.sizeX18}`,
        cost: '-7450000000000000',
        rate: 0.0596,
      },
      marginRequired: '360000000000000',
      priceImpact: 0.0018,
      feeBreakdown: { takerOtcFee: '6000000000000', takerOtcFeeInUSD: 0.3 },
    }),
  },
)
assert.equal(shortSimulation.matchedSizeX18, `-${shortPlan.sizeX18}`)
assert.equal(shortSimulation.matchedCostX18, '-7450000000000000')
const shortEconomics = calculateFundingHedgeEconomics(shortPlan, shortSimulation)
assert.equal(shortEconomics.fullFill, true)
assert.equal(shortEconomics.matchedYu, 0.125)
assert(shortEconomics.fixedTermCashflowUsd > 0)
const negativeShortEconomics = calculateFundingHedgeEconomics(shortPlan, {
  ...shortSimulation,
  matchedRate: -0.01,
  matchedCostX18: '1250000000000000',
})
assert(negativeShortEconomics.fixedTermCashflowUsd < 0)

console.log('Boros hedge checks passed.')
