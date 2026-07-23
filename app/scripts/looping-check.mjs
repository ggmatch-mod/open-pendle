#!/usr/bin/env node
/** Offline regression checks for PT/Morpho discovery and scenario math. */

import assert from 'node:assert/strict'
import {
  MorphoMarketValidationError,
  calculateLoopingEntryHealth,
  calculateLoopingEntrySizing,
  calculateLoopingLeverageCap,
  calculateLoopingScenario,
  calculateMintLoopingPresentation,
  fetchLoopingMarkets,
  joinMorphoMarketsToPendlePts,
  loopingCatalogFingerprint,
  morphoMarketIdFromTuple,
  parseMorphoMarketsResponse,
  selectMaximumSafeMintBorrowQuote,
} from '../src/lib/looping.ts'
import {
  DEFAULT_LOOPING_PREVIEW_FEATURE_FLAGS,
  LoopingPreviewValidationError,
  buildLoopingTransactionPreview,
} from '../src/lib/loopingPreview.ts'

const NOW = 1_784_304_299
const LOAN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const PT = '0xeCfaFdC7741323a945A163ed068B5a3C43483957'
const OTHER_PT = '0x1111111111111111111111111111111111111111'
const ORACLE = '0x217d6DdCDB95112C51657F6270e8C079CFDB51f0'
const OTHER_ORACLE = '0x2222222222222222222222222222222222222222'
const IRM = '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC'
const MORPHO_LTV = 915000000000000000n

const BASE_TUPLE = {
  loanToken: LOAN,
  collateralToken: PT,
  oracle: ORACLE,
  irm: IRM,
  lltv: MORPHO_LTV,
}

// Current official Pendle PT-reUSD/USDC Morpho pairing, used only as a realistic
// fixture (never as a permanent allowlist). Keeping the expected hash literal
// makes this check independent from the fixture builder below.
const EXPECTED_MARKET_ID =
  '0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64'

function marketRow(overrides = {}) {
  const tuple = {
    ...BASE_TUPLE,
    loanToken: overrides.loanAsset?.address ?? BASE_TUPLE.loanToken,
    collateralToken: overrides.collateralAsset?.address ?? BASE_TUPLE.collateralToken,
    oracle: overrides.oracle?.address ?? BASE_TUPLE.oracle,
    irm: overrides.irmAddress ?? BASE_TUPLE.irm,
    lltv: overrides.lltv === undefined ? BASE_TUPLE.lltv : BigInt(overrides.lltv),
  }
  return {
    marketId: morphoMarketIdFromTuple(tuple),
    chain: { id: 1, network: 'Ethereum' },
    listed: true,
    lltv: tuple.lltv.toString(),
    oracle: { address: tuple.oracle },
    irmAddress: tuple.irm,
    loanAsset: { address: tuple.loanToken, symbol: 'USDC', decimals: 6 },
    collateralAsset: {
      address: tuple.collateralToken,
      symbol: 'PT-reUSD-10DEC2026',
      decimals: 6,
    },
    state: {
      borrowAssets: 34_641_744_114_124,
      borrowAssetsUsd: 34_636_847.27037275,
      supplyAssets: 38_955_364_987_203,
      supplyAssetsUsd: 38_949_858.38410049,
      liquidityAssets: 4_313_620_873_079,
      liquidityAssetsUsd: 4_313_011.113727739,
      borrowApy: 0.08270683094439098,
      utilization: 0.8892676047446599,
      fee: 0,
      timestamp: NOW,
    },
    ...overrides,
  }
}

function response(items, pageInfo = { count: items.length, countTotal: items.length }) {
  return {
    data: { markets: { items, pageInfo } },
    extensions: { complexity: 123 },
  }
}

function expectValidation(fn, path) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof MorphoMarketValidationError)
    assert.equal(error.path, path)
    return true
  })
}

function expectPreviewValidation(fn, path) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof LoopingPreviewValidationError)
    assert.equal(error.path, path)
    return true
  })
}

function pendleMarket(overrides = {}) {
  return {
    key: '1:0x3333333333333333333333333333333333333333',
    chainId: 1,
    address: '0x3333333333333333333333333333333333333333',
    name: 'PT-reUSD 10DEC2026',
    protocol: 'reUSD',
    expiry: 1_796_860_800,
    pt: PT,
    yt: '0x4444444444444444444444444444444444444444',
    sy: '0x5555555555555555555555555555555555555555',
    icon: null,
    tvl: 10_000_000,
    impliedApy: 0.1,
    createdAt: NOW - 100_000,
    lifecycle: 'live',
    pendleStatus: 'active',
    sources: ['factory-indexed', 'pendle-listed'],
    ...overrides,
  }
}

console.log('Morpho market id commits to the complete immutable tuple')
assert.equal(morphoMarketIdFromTuple(BASE_TUPLE), EXPECTED_MARKET_ID)
assert.notEqual(
  morphoMarketIdFromTuple({ ...BASE_TUPLE, oracle: OTHER_ORACLE }),
  EXPECTED_MARKET_ID,
)

console.log('GraphQL parsing normalizes exact fields and lossless integer quantities')
const parsed = parseMorphoMarketsResponse(response([marketRow()]))
assert.equal(parsed.markets.length, 1)
assert.deepEqual(parsed.pageInfo, { count: 1, countTotal: 1 })
assert.equal(parsed.markets[0].marketId, EXPECTED_MARKET_ID)
assert.equal(parsed.markets[0].key, `1:${EXPECTED_MARKET_ID}`)
assert.equal(parsed.markets[0].tuple.lltv, MORPHO_LTV)
assert.equal(parsed.markets[0].state.borrowAssets, 34_641_744_114_124n)
assert.equal(parsed.markets[0].state.supplyAssets, 38_955_364_987_203n)
assert.equal(parsed.markets[0].loanAsset.symbol, 'USDC')
assert.equal(parsed.markets[0].chainNetwork, 'Ethereum')

const huge = parseMorphoMarketsResponse(
  response([
    marketRow({
      state: {
        ...marketRow().state,
        borrowAssets: '9007199254740993',
        supplyAssets: '9007199254740995',
        liquidityAssets: '2',
      },
    }),
  ]),
)
assert.equal(huge.markets[0].state.borrowAssets, 9_007_199_254_740_993n)

console.log('GraphQL errors, nulls, unsafe numbers, bad ranges, and bad ids fail closed')
expectValidation(
  () => parseMorphoMarketsResponse({ data: { markets: { items: [] } }, errors: [{}] }),
  'response.errors',
)
expectValidation(
  () => parseMorphoMarketsResponse(response([{ ...marketRow(), oracle: null }])),
  'response.data.markets.items[0].oracle',
)
expectValidation(
  () =>
    parseMorphoMarketsResponse(
      response([
        marketRow({
          state: { ...marketRow().state, supplyAssets: Number.MAX_SAFE_INTEGER + 1 },
        }),
      ]),
    ),
  'response.data.markets.items[0].state.supplyAssets',
)
expectValidation(
  () => parseMorphoMarketsResponse(response([{ ...marketRow(), lltv: '1000000000000000000' }])),
  'response.data.markets.items[0].lltv',
)
expectValidation(
  () =>
    parseMorphoMarketsResponse(
      response([{ ...marketRow(), marketId: `0x${'ab'.repeat(32)}` }]),
    ),
  'response.data.markets.items[0].marketId',
)
expectValidation(
  () => parseMorphoMarketsResponse(response([marketRow(), marketRow()])),
  'response.data.markets.items',
)
expectValidation(
  () =>
    parseMorphoMarketsResponse(
      response([marketRow({ state: { ...marketRow().state, utilization: 1.01 } })]),
    ),
  'response.data.markets.items[0].state.utilization',
)
expectValidation(
  () =>
    parseMorphoMarketsResponse(
      response([
        marketRow({
          state: { ...marketRow().state, borrowAssets: 38_955_364_987_204 },
        }),
      ]),
    ),
  'response.data.markets.items[0].state.borrowAssets',
)
expectValidation(
  () => parseMorphoMarketsResponse(response([marketRow()], { count: 0, countTotal: 1 })),
  'response.data.markets.pageInfo.count',
)

console.log('PT joins use exact chain+collateral provenance and retain distinct tuples')
const baseMorpho = parsed.markets[0]
const secondTuple = { ...BASE_TUPLE, oracle: OTHER_ORACLE }
const secondMorpho = parseMorphoMarketsResponse(
  response([
    marketRow({
      marketId: morphoMarketIdFromTuple(secondTuple),
      oracle: { address: OTHER_ORACLE },
      listed: false,
    }),
  ]),
).markets[0]
const good = pendleMarket()
const secondPendle = pendleMarket({
  key: '1:0x6666666666666666666666666666666666666666',
  address: '0x6666666666666666666666666666666666666666',
  name: 'PT-USR alternate market',
})
const candidates = joinMorphoMarketsToPendlePts(
  [baseMorpho, secondMorpho],
  [
    good,
    secondPendle,
    pendleMarket({ chainId: 8453, key: '8453:wrong-chain' }),
    pendleMarket({
      key: '1:matured',
      address: '0x7777777777777777777777777777777777777777',
      expiry: NOW,
      lifecycle: 'matured',
    }),
    pendleMarket({
      key: '1:api-only',
      address: '0x8888888888888888888888888888888888888888',
      sources: ['pendle-listed'],
    }),
    pendleMarket({
      key: '1:wrong-pt',
      address: '0x9999999999999999999999999999999999999999',
      pt: OTHER_PT,
    }),
  ],
  NOW,
)
assert.equal(candidates.length, 4)
assert.equal(new Set(candidates.map((candidate) => candidate.morpho.marketId)).size, 2)
assert.equal(new Set(candidates.map((candidate) => candidate.pendle.market)).size, 2)
assert.equal(candidates.filter((candidate) => candidate.morpho.listed).length, 2)
assert.equal(candidates.filter((candidate) => !candidate.morpho.listed).length, 2)
assert.ok(candidates.every((candidate) => candidate.pendle.chainId === candidate.morpho.chainId))
assert.ok(
  candidates.every(
    (candidate) =>
      candidate.pendle.pt.toLowerCase() ===
      candidate.morpho.tuple.collateralToken.toLowerCase(),
  ),
)
assert.equal(
  joinMorphoMarketsToPendlePts([baseMorpho], [good, good], NOW).length,
  1,
)

function catalogFixture(markets = [good]) {
  return {
    markets,
    byKey: Object.fromEntries(markets.map((market) => [market.key, market])),
    coverage: {
      complete: true,
      membership: 'complete',
      pendle: { active: true, inactive: true },
      factory: {
        status: 'complete',
        indexedChains: [1, 143, 8453, 42161],
        completeChains: [1, 143, 8453, 42161],
        totalChains: 6,
        marketCount: markets.length,
        quarantinedLogCount: 0,
        indexedAt: {
          1: NOW - 60,
          143: NOW - 50,
          8453: NOW - 40,
          42161: NOW - 30,
        },
        errors: {},
        requestError: null,
      },
    },
  }
}

function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

console.log('Morpho fetcher posts exact PT filters and exposes source coverage')
const requestBodies = []
const fetched = await fetchLoopingMarkets({
  catalog: catalogFixture(),
  now: NOW,
  fetcher: async (input, init) => {
    assert.equal(String(input), 'https://api.morpho.org/graphql')
    assert.equal(init.method, 'POST')
    assert.equal(init.credentials, 'omit')
    assert.ok(init.signal instanceof AbortSignal)
    const body = JSON.parse(init.body)
    requestBodies.push(body)
    assert.match(body.query, /collateralAssetAddress_in/)
    assert.match(body.query, /chain\s*\{\s*id network\s*\}/)
    assert.deepEqual(body.variables.chainIds, [1])
    assert.deepEqual(body.variables.collateralAssets, [PT])
    return responseJson(response([marketRow()]))
  },
})
assert.equal(requestBodies.length, 1)
assert.equal(fetched.candidates.length, 1)
assert.equal(fetched.morphoMarketCount, 1)
assert.equal(fetched.fetchedAt, NOW)
assert.equal(fetched.coverage.requestedPtCount, 1)
assert.equal(fetched.coverage.requestCount, 1)
assert.deepEqual(fetched.coverage.queriedChainIds, [1])
assert.deepEqual(fetched.coverage.unsupportedChainIds, [56, 9745])
assert.equal(fetched.coverage.completeForMorphoApiChains, true)
assert.equal(fetched.coverage.complete, false)
assert.equal(fetched.coverage.morphoOldestStateAt, NOW)
assert.equal(fetched.coverage.morphoLatestStateAt, NOW)
assert.equal(fetched.coverage.factoryIndexedAt[1], NOW - 60)

console.log('Nullable Morpho USD metrics remain unavailable rather than becoming zero')
const unpriced = parseMorphoMarketsResponse(
  response([
    marketRow({
      state: {
        ...marketRow().state,
        borrowAssetsUsd: null,
        supplyAssetsUsd: null,
        liquidityAssetsUsd: null,
      },
    }),
  ]),
)
assert.equal(unpriced.markets[0].state.borrowAssetsUsd, null)
assert.equal(unpriced.markets[0].state.supplyAssetsUsd, null)
assert.equal(unpriced.markets[0].state.liquidityAssetsUsd, null)

console.log('Fetcher paginates consistently and retains distinct Morpho tuples')
const paginatedRows = [marketRow(), marketRow({
  marketId: morphoMarketIdFromTuple(secondTuple),
  oracle: { address: OTHER_ORACLE },
})]
let paginationRequests = 0
const paginated = await fetchLoopingMarkets({
  catalog: catalogFixture(),
  now: NOW,
  pageSize: 1,
  fetcher: async (_input, init) => {
    const variables = JSON.parse(init.body).variables
    assert.equal(variables.first, 1)
    paginationRequests += 1
    return responseJson(
      response(
        [paginatedRows[variables.skip]],
        { count: 1, countTotal: 2 },
      ),
    )
  },
})
assert.equal(paginationRequests, 2)
assert.equal(paginated.morphoMarketCount, 2)
assert.equal(paginated.candidates.length, 2)
assert.equal(paginated.coverage.requestCount, 2)

console.log('GraphQL errors and filter-provenance violations reject the whole load')
await assert.rejects(
  () => fetchLoopingMarkets({
    catalog: catalogFixture(),
    now: NOW,
    fetcher: async () => responseJson({
      data: { markets: { items: [] } },
      errors: [{ message: 'unavailable' }],
    }),
  }),
  (error) => error instanceof MorphoMarketValidationError && error.path === 'response.errors',
)
await assert.rejects(
  () => fetchLoopingMarkets({
    catalog: catalogFixture(),
    now: NOW,
    fetcher: async () => responseJson(response([
      marketRow({
        collateralAsset: {
          address: OTHER_PT,
          symbol: 'PT-other',
          decimals: 18,
        },
      }),
    ])),
  }),
  (error) =>
    error instanceof MorphoMarketValidationError &&
    error.path.endsWith('.collateralToken'),
)

console.log('Timeout and caller abort both stop Morpho requests')
let timedSignal
await assert.rejects(
  () => fetchLoopingMarkets({
    catalog: catalogFixture(),
    now: NOW,
    requestTimeoutMs: 5,
    fetcher: async (_input, init) => {
      timedSignal = init.signal
      return await new Promise(() => {})
    },
  }),
  /timed out/,
)
assert.equal(timedSignal.aborted, true)
const abortController = new AbortController()
abortController.abort(new Error('caller stopped'))
let abortedFetchCalls = 0
await assert.rejects(
  () => fetchLoopingMarkets({
    catalog: catalogFixture(),
    now: NOW,
    signal: abortController.signal,
    fetcher: async () => {
      abortedFetchCalls += 1
      return responseJson(response([]))
    },
  }),
  /caller stopped/,
)
assert.equal(abortedFetchCalls, 0)

console.log('No live factory PT means a source-complete zero-request result')
const emptyDiscovery = await fetchLoopingMarkets({
  catalog: catalogFixture([pendleMarket({ expiry: NOW, lifecycle: 'matured' })]),
  now: NOW,
  fetcher: async () => {
    throw new Error('must not fetch')
  },
})
assert.equal(emptyDiscovery.morphoMarketCount, 0)
assert.equal(emptyDiscovery.candidates.length, 0)
assert.equal(emptyDiscovery.coverage.requestCount, 0)
assert.deepEqual(emptyDiscovery.coverage.queriedChainIds, [])

console.log('Catalog fingerprint is stable by content and changes with PT provenance or APY')
assert.equal(
  loopingCatalogFingerprint(catalogFixture()),
  loopingCatalogFingerprint(catalogFixture()),
)
assert.notEqual(
  loopingCatalogFingerprint(catalogFixture()),
  loopingCatalogFingerprint(catalogFixture([
    pendleMarket({ pt: OTHER_PT }),
  ])),
)
assert.notEqual(
  loopingCatalogFingerprint(catalogFixture()),
  loopingCatalogFingerprint(catalogFixture([
    pendleMarket({ impliedApy: 0.11 }),
  ])),
)

console.log('Mode-aware sizing counts only binding PT and keeps Mint YT outside collateral')
const marketEntrySizing = calculateLoopingEntrySizing({
  mode: 'market',
  equityAssets: 1_000_000n,
  borrowAssets: 500_000n,
  initialMinPtOut: 1_050_000n,
  loopMinPtOut: 520_000n,
})
assert.equal(marketEntrySizing.grossCapitalAssets, 1_500_000n)
assert.equal(marketEntrySizing.capitalMultipleWad, 1_500_000_000_000_000_000n)
assert.equal(marketEntrySizing.guaranteedPtCollateral, 1_570_000n)
assert.equal(marketEntrySizing.guaranteedYtToWallet, 0n)

const mintEntrySizing = calculateLoopingEntrySizing({
  mode: 'mint',
  equityAssets: 1_000_000n,
  borrowAssets: 500_000n,
  initialMinPyOut: 970_000n,
  loopMinPyOut: 480_000n,
})
assert.equal(mintEntrySizing.grossCapitalAssets, 1_500_000n)
assert.equal(mintEntrySizing.capitalMultipleWad, 1_500_000_000_000_000_000n)
assert.equal(mintEntrySizing.guaranteedPtCollateral, 1_450_000n)
assert.equal(mintEntrySizing.guaranteedYtToWallet, 1_450_000n)

console.log('Guaranteed Mint PT health rounds collateral down and worst-case debt LTV up')
const mintEntryHealth = calculateLoopingEntryHealth({
  entry: {
    mode: 'mint',
    equityAssets: 1_000_000n,
    borrowAssets: 500_000n,
    initialMinPyOut: 970_000n,
    loopMinPyOut: 480_000n,
  },
  oraclePrice: 10n ** 36n,
  lltv: 860_000_000_000_000_000n,
  maximumDebtAssets: 505_000n,
  minimumLiquidationBufferBps: 1_000,
})
assert.equal(mintEntryHealth.collateralLoanValueAssets, 1_450_000n)
assert.equal(mintEntryHealth.protocolMaxDebtAssets, 1_247_000n)
assert.equal(mintEntryHealth.bufferedMaxDebtAssets, 1_122_300n)
assert.equal(mintEntryHealth.maximumDebtLtvWad, 348_275_862_068_965_518n)
assert.equal(mintEntryHealth.liquidationBufferBps, 5_950n)
assert.equal(mintEntryHealth.withinProtocolLltv, true)
assert.equal(mintEntryHealth.withinConfiguredBuffer, true)

const belowConfiguredBuffer = calculateLoopingEntryHealth({
  entry: {
    mode: 'mint',
    equityAssets: 1_000_000n,
    borrowAssets: 500_000n,
    initialMinPyOut: 970_000n,
    loopMinPyOut: 480_000n,
  },
  oraclePrice: 10n ** 36n,
  lltv: 860_000_000_000_000_000n,
  maximumDebtAssets: 1_130_000n,
  minimumLiquidationBufferBps: 1_000,
})
assert.equal(belowConfiguredBuffer.withinProtocolLltv, true)
assert.equal(belowConfiguredBuffer.withinConfiguredBuffer, false)

const floorRoundedHealth = calculateLoopingEntryHealth({
  entry: {
    mode: 'mint',
    equityAssets: 1n,
    borrowAssets: 1n,
    initialMinPyOut: 2n,
    loopMinPyOut: 1n,
  },
  oraclePrice: 10n ** 36n - 1n,
  lltv: 500_000_000_000_000_000n,
})
assert.equal(floorRoundedHealth.collateralLoanValueAssets, 2n)
assert.equal(floorRoundedHealth.protocolMaxDebtAssets, 1n)
assert.equal(floorRoundedHealth.withinProtocolLltv, false)

console.log('Mint maximum selection evaluates exact quotes and share-rounded debt independently')
const mintCapacityInput = {
  equityAssets: 1_000n,
  initialMinimumPyOut: 800n,
  oraclePrice: 10n ** 36n,
  lltv: 800_000_000_000_000_000n,
  minimumLiquidationBufferBps: 1_000,
}
const mintCapacity = selectMaximumSafeMintBorrowQuote({
  ...mintCapacityInput,
  quotes: [
    { borrowAssets: 1_500n, minimumPyOut: 900n },
    { borrowAssets: 500n, minimumPyOut: 400n, maximumDebtAssets: 510n },
    { borrowAssets: 1_000n, minimumPyOut: 700n, maximumDebtAssets: 1_100n },
    { borrowAssets: 900n, minimumPyOut: 650n, maximumDebtAssets: 920n },
  ],
})
assert.ok(mintCapacity)
assert.equal(mintCapacity.borrowAssets, 900n)
assert.equal(mintCapacity.maximumDebtAssets, 920n)
assert.equal(mintCapacity.grossCapitalAssets, 1_900n)
assert.equal(mintCapacity.entry.guaranteedPtCollateral, 1_450n)
assert.equal(mintCapacity.entry.guaranteedYtToWallet, 1_450n)
assert.equal(mintCapacity.health.withinConfiguredBuffer, true)

const capacityWithoutShareOverhang = selectMaximumSafeMintBorrowQuote({
  ...mintCapacityInput,
  quotes: [
    { borrowAssets: 1_500n, minimumPyOut: 900n },
    { borrowAssets: 900n, minimumPyOut: 650n },
    { borrowAssets: 1_000n, minimumPyOut: 700n },
  ],
})
assert.ok(capacityWithoutShareOverhang)
assert.equal(capacityWithoutShareOverhang.borrowAssets, 1_000n)

console.log('Mint presentation omits return APY until a verified SY source is supplied')
const mintPresentationInput = {
  entry: {
    mode: 'mint',
    equityAssets: 1_000_000n,
    borrowAssets: 500_000n,
    initialMinPyOut: 970_000n,
    loopMinPyOut: 480_000n,
  },
  oraclePrice: 10n ** 36n,
  lltv: 860_000_000_000_000_000n,
  maximumDebtAssets: 505_000n,
  minimumLiquidationBufferBps: 1_000,
  borrowApy: 0.04,
  holdingPeriodYears: 0.5,
  entryCostRate: 0.001,
  exitCostRate: 0.001,
  fixedCostOnEquity: 0.002,
}
const mintPresentationWithoutYield = calculateMintLoopingPresentation(
  mintPresentationInput,
)
assert.equal(mintPresentationWithoutYield.returnEstimateBasis, 'unavailable')
assert.equal(mintPresentationWithoutYield.verifiedSyApy, null)
assert.equal(mintPresentationWithoutYield.grossSyYieldOnEquity, null)
assert.equal(mintPresentationWithoutYield.estimatedNetApy, null)
assert.ok(Math.abs(mintPresentationWithoutYield.borrowCostOnEquity - 0.0202) < 1e-12)
assert.ok(Math.abs(mintPresentationWithoutYield.annualizedOneTimeCosts - 0.01) < 1e-12)
assert.equal('headlineLoopApy' in mintPresentationWithoutYield, false)
assert.equal('ptApy' in mintPresentationWithoutYield, false)

const mintPresentationWithYield = calculateMintLoopingPresentation({
  ...mintPresentationInput,
  verifiedSyApy: 0.06,
})
assert.equal(mintPresentationWithYield.returnEstimateBasis, 'verified-sy-apy')
assert.ok(Math.abs(mintPresentationWithYield.grossSyYieldOnEquity - 0.09) < 1e-12)
assert.ok(Math.abs(mintPresentationWithYield.estimatedNetApy - 0.0598) < 1e-12)

expectValidation(
  () =>
    calculateLoopingEntryHealth({
      entry: {
        mode: 'mint',
        equityAssets: 1_000n,
        borrowAssets: 500n,
        initialMinPyOut: 900n,
        loopMinPyOut: 400n,
      },
      oraclePrice: 10n ** 36n,
      lltv: MORPHO_LTV,
      maximumDebtAssets: 499n,
    }),
  'entryHealth.maximumDebtAssets',
)
expectValidation(
  () =>
    selectMaximumSafeMintBorrowQuote({
      ...mintCapacityInput,
      quotes: [
        { borrowAssets: 500n, minimumPyOut: 400n },
        { borrowAssets: 500n, minimumPyOut: 399n },
      ],
    }),
  'mintCapacity.quotes[1].borrowAssets',
)

console.log('Scenario math separates headline yield, stress, costs, and liquidation headroom')
const scenario = calculateLoopingScenario({
  leverage: 2,
  ptApy: 0.1,
  borrowApy: 0.05,
  lltv: 860000000000000000n,
  holdingPeriodYears: 1,
  collateralPriceDrop: 0.1,
  lltvBuffer: 0.1,
  borrowApyIncrease: 0.02,
  ptApyHaircut: 0.01,
  entryCostRate: 0.001,
  exitCostRate: 0.001,
  fixedCostOnEquity: 0.002,
})
assert.equal(scenario.equity, 1)
assert.equal(scenario.collateralExposure, 2)
assert.equal(scenario.debt, 1)
assert.ok(Math.abs(scenario.currentLtv - 0.5) < 1e-12)
assert.ok(Math.abs(scenario.headlineLoopApy - 0.15) < 1e-12)
assert.ok(Math.abs(scenario.stressedPtApy - 0.09) < 1e-12)
assert.ok(Math.abs(scenario.stressedBorrowApy - 0.07) < 1e-12)
assert.ok(Math.abs(scenario.annualizedOneTimeCosts - 0.006) < 1e-12)
assert.ok(Math.abs(scenario.conservativeNetApy - 0.104) < 1e-12)
assert.ok(Math.abs(scenario.stressedHealthFactor - 1.548) < 1e-12)
assert.ok(Math.abs(scenario.conservativeMaxLeverage - 3.296) < 0.001)
assert.equal(scenario.withinProtocolLltv, true)
assert.equal(scenario.withinConservativeLimit, true)

const unlevered = calculateLoopingScenario({
  leverage: 1,
  ptApy: 0.08,
  borrowApy: 0.04,
  lltv: 860000000000000000n,
  holdingPeriodYears: 0.5,
})
assert.equal(unlevered.debt, 0)
assert.equal(unlevered.stressedHealthFactor, null)
assert.equal(unlevered.priceDropToLiquidation, null)
assert.equal(unlevered.withinProtocolLltv, true)

const unsafe = calculateLoopingScenario({
  leverage: 10,
  ptApy: 0.1,
  borrowApy: 0.05,
  lltv: 860000000000000000n,
  holdingPeriodYears: 1,
  collateralPriceDrop: 0.1,
  lltvBuffer: 0.1,
})
assert.equal(unsafe.withinProtocolLltv, false)
assert.equal(unsafe.withinConservativeLimit, false)
assert.equal(unsafe.priceDropToLiquidation, 0)

console.log('Leverage slider reaches the 1% liquidation buffer and marks 10% headroom')
const leverageCap = calculateLoopingLeverageCap(MORPHO_LTV)
assert.ok(Math.abs(leverageCap - 10.6) < 1e-12)
const atLeverageCap = calculateLoopingScenario({
  leverage: leverageCap,
  ptApy: 0.1,
  borrowApy: 0.05,
  lltv: MORPHO_LTV,
  holdingPeriodYears: 1,
  collateralPriceDrop: 0,
  lltvBuffer: 0.01,
})
const aboveLeverageCap = calculateLoopingScenario({
  leverage: leverageCap + 0.05,
  ptApy: 0.1,
  borrowApy: 0.05,
  lltv: MORPHO_LTV,
  holdingPeriodYears: 1,
  collateralPriceDrop: 0,
  lltvBuffer: 0.01,
})
assert.equal(atLeverageCap.withinConservativeLimit, true)
assert.equal(aboveLeverageCap.withinConservativeLimit, false)
assert.ok(atLeverageCap.priceDropToLiquidation >= 0.01)
assert.ok(aboveLeverageCap.priceDropToLiquidation < 0.01)

const eightySixPercentLltv = 860000000000000000n
const eightySixPercentMaximum = calculateLoopingLeverageCap(eightySixPercentLltv)
const eightySixPercentWarning = calculateLoopingLeverageCap(eightySixPercentLltv, {
  collateralPriceDrop: 0,
  lltvBuffer: 0.1,
  step: 0.05,
  absoluteCap: 100,
})
assert.ok(Math.abs(eightySixPercentMaximum - 6.7) < 1e-12)
assert.ok(Math.abs(eightySixPercentWarning - 4.4) < 1e-12)
assert.ok(eightySixPercentWarning < eightySixPercentMaximum)
assert.ok(Math.abs(calculateLoopingLeverageCap(750000000000000000n, {
  collateralPriceDrop: 0,
  lltvBuffer: 0,
  step: 0.05,
  absoluteCap: 10,
}) - 3.95) < 1e-12)

console.log('Estimated APY follows the PT-minus-borrow spread as leverage changes')
const estimateAt = (leverage, ptApy, borrowApy) => calculateLoopingScenario({
  leverage,
  ptApy,
  borrowApy,
  lltv: MORPHO_LTV,
  holdingPeriodYears: 1,
}).headlineLoopApy
assert.ok(Math.abs((estimateAt(2, 0.1, 0.04) - estimateAt(1, 0.1, 0.04)) - 0.06) < 1e-12)
assert.ok(Math.abs(estimateAt(2, 0.05, 0.05) - estimateAt(1, 0.05, 0.05)) < 1e-12)
assert.ok(estimateAt(2, 0.03, 0.05) < estimateAt(1, 0.03, 0.05))

console.log('Scenario input validation rejects unsafe or meaningless assumptions')
expectValidation(
  () =>
    calculateLoopingScenario({
      leverage: 0.99,
      ptApy: 0.1,
      borrowApy: 0.05,
      lltv: 860000000000000000n,
      holdingPeriodYears: 1,
    }),
  'scenario.leverage',
)
expectValidation(
  () =>
    calculateLoopingScenario({
      leverage: 2,
      ptApy: 0.1,
      borrowApy: -0.01,
      lltv: 860000000000000000n,
      holdingPeriodYears: 1,
    }),
  'scenario.borrowApy',
)
expectValidation(
  () =>
    calculateLoopingScenario({
      leverage: 2,
      ptApy: 0.1,
      borrowApy: 0.05,
      lltv: 10n ** 18n,
      holdingPeriodYears: 1,
    }),
  'scenario.lltv',
)
expectValidation(
  () =>
    calculateLoopingScenario({
      leverage: 2,
      ptApy: 0.1,
      borrowApy: 0.05,
      lltv: 860000000000000000n,
      holdingPeriodYears: 0,
    }),
  'scenario.holdingPeriodYears',
)
expectValidation(
  () =>
    calculateLoopingScenario({
      leverage: 2,
      ptApy: 0.1,
      borrowApy: 0.05,
      lltv: 860000000000000000n,
      holdingPeriodYears: 1,
      collateralPriceDrop: 1,
    }),
  'scenario.collateralPriceDrop',
)

console.log('Preview planner remains inert and produces ordered entry/exit checklists')
const previewCandidate = candidates.find(
  (candidate) =>
    candidate.morpho.listed &&
    candidate.pendle.market.toLowerCase() === good.address.toLowerCase(),
)
assert.ok(previewCandidate)
const previewScenario = {
  leverage: 2,
  ptApy: 0.1,
  borrowApy: previewCandidate.morpho.state.borrowApy,
  lltv: previewCandidate.morpho.tuple.lltv,
  holdingPeriodYears: 0.25,
  collateralPriceDrop: 0.1,
  lltvBuffer: 0.1,
  borrowApyIncrease: 0.02,
  ptApyHaircut: 0.01,
}
const preview = buildLoopingTransactionPreview({
  candidate: previewCandidate,
  scenario: previewScenario,
  equityAssets: 1_000_001n,
  nowUnixSeconds: NOW,
})
assert.deepEqual(DEFAULT_LOOPING_PREVIEW_FEATURE_FLAGS, {
  previewEnabled: true,
  executionEnabled: false,
})
assert.equal(preview.mode, 'preview-only')
assert.equal(preview.previewEnabled, true)
assert.equal(preview.executionEnabled, false)
assert.equal(preview.executionStatus, 'disabled')
assert.deepEqual(preview.transactions.map((transaction) => transaction.id), ['entry', 'exit'])
assert.deepEqual(preview.transactions.map((transaction) => transaction.order), [1, 2])
assert.equal(preview.transactions[0].approvalIntent.policy, 'exact-only')
assert.equal(preview.transactions[0].approvalIntent.amount, 1_000_001n)
assert.equal(preview.transactions[0].approvalIntent.formattedAmount, '1.000001 USDC')
assert.equal(preview.transactions[0].approvalIntent.spenderRole, 'Morpho GeneralAdapter1')
assert.equal(preview.transactions[1].approvalIntent, null)
assert.ok(
  preview.transactions.every(
    (transaction) =>
      transaction.authorization.firstAction === 'authorize operator for this account' &&
      transaction.authorization.finalAction === 'revoke operator for this account' &&
      transaction.authorization.sameTransactionRequired === true,
  ),
)

console.log('Every execution-sensitive value is an unresolved, finite-only placeholder')
assert.deepEqual(
  preview.transactions[0].finiteBounds.map((bound) => bound.key),
  [
    'initialMinPtOut',
    'loopMinPtOut',
    'maxBorrowShares',
    'minBorrowSharePriceRay',
    'entryQuoteDeadline',
  ],
)
assert.deepEqual(
  preview.transactions[1].finiteBounds.map((bound) => bound.key),
  [
    'maxRepayAssets',
    'maxRepaySharePriceRay',
    'exitMinLoanAssetsOut',
    'exitQuoteDeadline',
  ],
)
assert.ok(
  preview.transactions
    .flatMap((transaction) => transaction.finiteBounds)
    .every(
      (bound) =>
        bound.status === 'unresolved' &&
        bound.unlimitedValueAllowed === false &&
        bound.placeholder.startsWith('<') &&
        bound.placeholder.endsWith('>'),
    ),
)
assert.ok(
  preview.blockers.some((item) => item.code === 'EXECUTION_FEATURE_DISABLED'),
)
assert.ok(
  preview.blockers.some((item) => item.code === 'VERIFIED_CONTRACT_REGISTRY_REQUIRED'),
)
assert.ok(preview.blockers.some((item) => item.code === 'VERIFIED_ENTRY_ROUTE_REQUIRED'))
assert.ok(preview.blockers.some((item) => item.code === 'VERIFIED_EXIT_ROUTE_REQUIRED'))
assert.ok(preview.blockers.some((item) => item.code === 'FINITE_BOUNDS_REQUIRED'))
assert.ok(
  preview.blockers.some((item) => item.code === 'PENDING_STATE_SIMULATION_REQUIRED'),
)
assert.equal(preview.unsupportedReasons.length, preview.blockers.length)
assert.equal(
  preview.safetyGates.find((item) => item.code === 'SCENARIO_WITHIN_CONSERVATIVE_LLTV')
    .status,
  'pass',
)
assert.equal(
  preview.safetyGates.find((item) => item.code === 'HOLDING_PERIOD_WITHIN_MATURITY')
    .status,
  'pass',
)

const postMaturityPreview = buildLoopingTransactionPreview({
  candidate: previewCandidate,
  scenario: { ...previewScenario, holdingPeriodYears: 1 },
  equityAssets: 1_000_001n,
  nowUnixSeconds: NOW,
})
assert.equal(
  postMaturityPreview.safetyGates.find(
    (item) => item.code === 'HOLDING_PERIOD_WITHIN_MATURITY',
  ).status,
  'blocked',
)

console.log('Planner output never includes transaction requests, signatures, or calldata')
const forbiddenExecutableKeys = new Set([
  'broadcast',
  'calldata',
  'data',
  'rawTransaction',
  'signature',
  'transactionRequest',
  'walletClient',
])
function assertNoExecutableKeys(value) {
  if (value === null || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(forbiddenExecutableKeys.has(key), false, `unexpected executable key ${key}`)
    assertNoExecutableKeys(nested)
  }
}
assertNoExecutableKeys(preview)

console.log('Runtime flags cannot accidentally turn execution on')
expectPreviewValidation(
  () =>
    buildLoopingTransactionPreview(
      {
        candidate: previewCandidate,
        scenario: previewScenario,
        equityAssets: 1_000_000n,
        nowUnixSeconds: NOW,
      },
      { previewEnabled: true, executionEnabled: true },
    ),
  'featureFlags.executionEnabled',
)
const hiddenPreview = buildLoopingTransactionPreview(
  {
    candidate: previewCandidate,
    scenario: previewScenario,
    equityAssets: 1_000_000n,
    nowUnixSeconds: NOW,
  },
  { previewEnabled: false, executionEnabled: false },
)
assert.equal(hiddenPreview.previewEnabled, false)
assert.equal(
  hiddenPreview.safetyGates.find((item) => item.code === 'PREVIEW_FEATURE_ENABLED').status,
  'blocked',
)

console.log('Preview validation and static eligibility gates fail closed')
expectPreviewValidation(
  () =>
    buildLoopingTransactionPreview({
      candidate: previewCandidate,
      scenario: previewScenario,
      equityAssets: 0n,
      nowUnixSeconds: NOW,
    }),
  'input.equityAssets',
)
expectPreviewValidation(
  () =>
    buildLoopingTransactionPreview({
      candidate: previewCandidate,
      scenario: { ...previewScenario, lltv: previewScenario.lltv - 1n },
      equityAssets: 1_000_000n,
      nowUnixSeconds: NOW,
    }),
  'input.scenario.lltv',
)
expectPreviewValidation(
  () =>
    buildLoopingTransactionPreview({
      candidate: previewCandidate,
      scenario: previewScenario,
      equityAssets: 1_000_000n,
      nowUnixSeconds: NOW,
      maxMarketStateAgeSeconds: 0,
    }),
  'input.maxMarketStateAgeSeconds',
)

const degradedCandidate = {
  ...previewCandidate,
  morpho: {
    ...previewCandidate.morpho,
    listed: false,
    state: {
      ...previewCandidate.morpho.state,
      liquidityAssets: 0n,
      liquidityAssetsUsd: 0,
      timestamp: NOW - 301,
    },
  },
  pendle: {
    ...previewCandidate.pendle,
    expiry: NOW,
    pendleStatus: 'inactive',
  },
}
const degraded = buildLoopingTransactionPreview({
  candidate: degradedCandidate,
  scenario: previewScenario,
  equityAssets: 1_000_000n,
  nowUnixSeconds: NOW,
})
for (const code of [
  'MORPHO_MARKET_LISTED',
  'PENDLE_MARKET_ACTIVE',
  'PENDLE_MARKET_UNEXPIRED',
  'MORPHO_STATE_CURRENT',
  'MORPHO_LIQUIDITY_REPORTED',
]) {
  assert.equal(degraded.safetyGates.find((item) => item.code === code).status, 'blocked')
}

const unsafePreview = buildLoopingTransactionPreview({
  candidate: previewCandidate,
  scenario: { ...previewScenario, leverage: 20 },
  equityAssets: 1_000_000n,
  nowUnixSeconds: NOW,
})
assert.equal(
  unsafePreview.safetyGates.find((item) => item.code === 'SCENARIO_WITHIN_PROTOCOL_LLTV')
    .status,
  'blocked',
)
assert.equal(
  unsafePreview.safetyGates.find(
    (item) => item.code === 'SCENARIO_WITHIN_CONSERVATIVE_LLTV',
  ).status,
  'blocked',
)

console.log('All looping data-layer checks passed')
