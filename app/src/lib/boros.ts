/** Live Boros market discovery and anonymous execution simulation. */

export const BOROS_API_BASE = 'https://api-boros.pendle.finance/apis/v1'
export const BOROS_APP_BASE = 'https://boros.pendle.finance'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_SOURCE_AGE_MS = 120_000
const MAX_QUOTE_AGE_MS = 45_000

type JsonRecord = Record<string, unknown>

export interface BorosCollateralAsset {
  tokenId: number
  id: string
  name: string
  symbol: string
  decimals: number
  usdPrice: number
  unit: 'btc' | 'usd'
}

export interface BorosHedgeMarket {
  marketId: number
  tokenId: number
  name: string
  symbol: string
  maturity: number
  status: number
  ammId?: number
  collateral: BorosCollateralAsset
  markApr: number
  midApr: number
  bestBidApr: number | null
  bestAskApr: number | null
  floatingApr: number
  settlementFeeApr: number
  notionalOpenInterest: number
  volume24h: number
  rateSensitivity: number
  syncTimestamp: number
}

export interface BorosHedgeUniverse {
  markets: BorosHedgeMarket[]
  syncTimestamp: number
  fetchedAt: number
}

export interface BorosHedgeQuote {
  marketId: number
  side: 'long' | 'short'
  requestedSizeX18: string
  matchedSizeX18: string
  matchedRate: number
  matchedCostX18: string
  marginRequiredX18: string
  priceImpact: number
  takerFeeX18: string | null
  takerFeeUsd: number | null
  quotedAt: number
}

export function borosPreviewFreshness(
  syncTimestamp: number | undefined,
  quotedAt: number | undefined,
  now = Date.now(),
  /** Milliseconds; undefined skips wallet freshness only for sample exposure. */
  exposureSourceTimestamp?: number | null,
): { sourceAgeSeconds: number | null; quoteAgeSeconds: number | null; exposureAgeSeconds: number | null; isFresh: boolean } {
  const age = (timestamp: number | null | undefined): number | null => {
    if (timestamp === undefined || timestamp === null || !Number.isFinite(timestamp) || timestamp <= 0) return null
    const elapsed = now - timestamp
    // Allow small clock skew, but never describe a distant future date as fresh.
    return elapsed < -5_000 ? null : Math.max(0, elapsed)
  }
  const sourceAge = age(syncTimestamp === undefined ? undefined : syncTimestamp * 1_000)
  const quoteAge = age(quotedAt)
  const exposureAge = age(exposureSourceTimestamp)
  return {
    sourceAgeSeconds: sourceAge === null ? null : Math.floor(sourceAge / 1_000),
    quoteAgeSeconds: quoteAge === null ? null : Math.floor(quoteAge / 1_000),
    exposureAgeSeconds: exposureAge === null ? null : Math.floor(exposureAge / 1_000),
    isFresh: sourceAge !== null && quoteAge !== null &&
      sourceAge <= MAX_SOURCE_AGE_MS && quoteAge <= MAX_QUOTE_AGE_MS &&
      (exposureSourceTimestamp === undefined ||
        exposureAge !== null && exposureAge <= MAX_SOURCE_AGE_MS),
  }
}

interface FetchOptions {
  fetcher?: typeof fetch
  apiBase?: string
  signal?: AbortSignal
}

export interface BorosSimulationRequest {
  marketId: number
  ammId?: number
  side: 'long' | 'short'
  sizeX18: string
  /** Absolute APR tolerance. `0.005` permits up to 50 bps from mid. */
  slippage?: number
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = finiteNumber(value)
  if (parsed === null) throw new Error(`Boros returned an invalid ${field}`)
  return parsed
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  return finiteNumber(value)
}

function bigintText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`Boros returned an invalid ${field}`)
  }
  return value
}

function signedBigintText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`Boros returned an invalid ${field}`)
  }
  return value
}

function parseCollateral(value: unknown): BorosCollateralAsset | null {
  const asset = record(value)
  if (asset === null || asset.isCollateral !== true) return null
  const tokenId = requiredNumber(asset.tokenId, 'collateral token ID')
  const id = typeof asset.id === 'string' ? asset.id : ''
  const symbol = typeof asset.symbol === 'string' ? asset.symbol : ''
  let unit: BorosCollateralAsset['unit'] | null = null
  if (id.toUpperCase() === 'BTC' || symbol.toUpperCase() === 'WBTC') unit = 'btc'
  if (id.toUpperCase() === 'USDT' || symbol.toUpperCase().includes('USD')) unit = 'usd'
  if (unit === null) return null

  return {
    tokenId,
    id,
    name: typeof asset.name === 'string' ? asset.name : symbol,
    symbol,
    decimals: requiredNumber(asset.decimals, 'collateral decimals'),
    usdPrice: requiredNumber(asset.usdPrice, 'collateral price'),
    unit,
  }
}

async function requestJson(
  path: string,
  init: RequestInit,
  options: FetchOptions,
): Promise<unknown> {
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation is available')
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('Boros request was aborted')
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new Error('Boros request timed out')),
    REQUEST_TIMEOUT_MS,
  )

  try {
    const response = await fetcher(`${options.apiBase ?? BOROS_API_BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...init.headers,
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Boros request failed (${response.status})`)
    return await response.json()
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

async function fetchAllMarkets(options: FetchOptions): Promise<{
  results: unknown[]
  syncTimestamp: number
}> {
  const results: unknown[] = []
  const seenTokens = new Set<string>()
  let resumeToken: string | undefined
  let syncTimestamp = Number.POSITIVE_INFINITY

  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({
      isMatured: 'false',
      isUiWhitelisted: 'true',
      limit: '200',
    })
    if (resumeToken !== undefined) query.set('resumeToken', resumeToken)
    const body = record(await requestJson(`/markets?${query}`, {}, options))
    if (!Array.isArray(body?.results)) {
      throw new Error('Boros returned an invalid market response')
    }
    results.push(...body.results)
    const syncStatus = record(body.syncStatus)
    // The oldest page is the conservative freshness bound for the universe.
    syncTimestamp = Math.min(
      syncTimestamp,
      requiredNumber(syncStatus?.timestamp, 'market sync timestamp'),
    )
    if (body.resumeToken === undefined || body.resumeToken === null) {
      return { results, syncTimestamp }
    }
    if (
      typeof body.resumeToken !== 'string' ||
      body.resumeToken.length === 0 ||
      seenTokens.has(body.resumeToken)
    ) {
      throw new Error('Boros returned an invalid market pagination token')
    }
    resumeToken = body.resumeToken
    seenTokens.add(resumeToken)
  }
  throw new Error('Boros market pagination exceeded the supported page limit')
}

/** Fetch every live, UI-listed Hyperliquid BTC market with supported collateral. */
export async function fetchBorosHyperliquidBtcMarkets(
  options: FetchOptions = {},
): Promise<BorosHedgeUniverse> {
  const [marketsBody, assetsValue] = await Promise.all([
    fetchAllMarkets(options),
    requestJson('/assets?isCollateral=true', {}, options),
  ])
  const assetsBody = record(assetsValue)
  if (!Array.isArray(assetsBody?.results)) {
    throw new Error('Boros returned an invalid market response')
  }

  const assets = new Map<number, BorosCollateralAsset>()
  for (const value of assetsBody.results) {
    const asset = parseCollateral(value)
    if (asset !== null) assets.set(asset.tokenId, asset)
  }

  const syncTimestamp = marketsBody.syncTimestamp
  const now = Math.floor(Date.now() / 1_000)
  const markets: BorosHedgeMarket[] = []

  for (const value of marketsBody.results) {
    const market = record(value)
    const imData = record(market?.imData)
    const metadata = record(market?.metadata)
    const platform = record(market?.platform)
    const config = record(market?.config)
    const extConfig = record(market?.extConfig)
    const data = record(market?.data)
    if (
      market === null ||
      imData === null ||
      metadata === null ||
      platform === null ||
      config === null ||
      extConfig === null ||
      data === null ||
      String(platform.name).toLowerCase() !== 'hyperliquid' ||
      String(metadata.underlyingSymbol).toUpperCase() !== 'BTC' ||
      String(metadata.fundingRateSymbol).toLowerCase() !== 'hyperliquid-btc' ||
      metadata.isUiWhitelisted !== true
    ) continue

    const tokenId = requiredNumber(market.tokenId, 'market collateral token ID')
    const collateral = assets.get(tokenId)
    const maturity = requiredNumber(imData.maturity, 'market maturity')
    if (collateral === undefined || maturity <= now) continue

    markets.push({
      marketId: requiredNumber(market.marketId, 'market ID'),
      tokenId,
      name: typeof imData.name === 'string' ? imData.name : 'Hyperliquid BTC',
      symbol: typeof imData.symbol === 'string' ? imData.symbol : 'HYPERLIQUID-BTC',
      maturity,
      status: requiredNumber(config.status, 'market status'),
      // AMM routing is optional in the public API. New markets can omit the
      // deprecated extConfig.ammId; let the simulator choose its current AMM.
      ammId: extConfig.ammId === undefined || extConfig.ammId === null
        ? undefined
        : requiredNumber(extConfig.ammId, 'market AMM ID'),
      collateral,
      markApr: requiredNumber(data.markApr, 'mark APR'),
      midApr: requiredNumber(data.midApr, 'mid APR'),
      bestBidApr: optionalNumber(data.bestBid),
      bestAskApr: optionalNumber(data.bestAsk),
      floatingApr: requiredNumber(data.floatingApr, 'floating APR'),
      settlementFeeApr:
        requiredNumber(extConfig.settleFeeRate, 'settlement fee rate') / 1e18,
      notionalOpenInterest: requiredNumber(data.notionalOI, 'market open interest'),
      volume24h: requiredNumber(data.volume24h, 'market volume'),
      rateSensitivity: requiredNumber(data.rateSensitivity, 'rate sensitivity'),
      syncTimestamp,
    })
  }

  if (markets.length === 0) {
    throw new Error('No live Boros market currently matches Hyperliquid BTC')
  }
  markets.sort((a, b) => {
    if (a.collateral.unit !== b.collateral.unit) return a.collateral.unit === 'usd' ? -1 : 1
    return a.maturity - b.maturity
  })

  return { markets, syncTimestamp, fetchedAt: Date.now() }
}

/** Preview a fill against Boros's live book without requiring a Boros account. */
export async function simulateBorosHedge(
  request: BorosSimulationRequest,
  options: FetchOptions = {},
): Promise<BorosHedgeQuote> {
  if (!/^\d+$/.test(request.sizeX18) || BigInt(request.sizeX18) <= 0n) {
    throw new Error('Hedge size must be greater than zero')
  }
  const value = await requestJson(
    '/simulations/place-order-anonymous',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        marketId: request.marketId,
        side: request.side === 'long' ? 0 : 1,
        size: request.sizeX18,
        tif: 2,
        slippage: request.slippage ?? 0.005,
        ammId: request.ammId,
      }),
    },
    options,
  )

  const body = record(value)
  const matched = record(body?.matched)
  const feeBreakdown = record(body?.feeBreakdown)
  if (body === null || matched === null) {
    throw new Error('Boros returned an invalid hedge simulation')
  }

  return {
    marketId: request.marketId,
    side: request.side,
    requestedSizeX18: request.sizeX18,
    // Boros signs both size and annualized cost by side: long fills are
    // positive and short fills are negative.
    matchedSizeX18: signedBigintText(matched.size, 'matched size'),
    matchedRate: requiredNumber(matched.rate, 'matched rate'),
    matchedCostX18: signedBigintText(matched.cost, 'matched cost'),
    marginRequiredX18: bigintText(body.marginRequired, 'margin requirement'),
    priceImpact: requiredNumber(body.priceImpact, 'price impact'),
    takerFeeX18: feeBreakdown?.takerOtcFee === undefined || feeBreakdown.takerOtcFee === null
      ? null
      : bigintText(feeBreakdown.takerOtcFee, 'taker fee'),
    takerFeeUsd: optionalNumber(feeBreakdown?.takerOtcFeeInUSD),
    quotedAt: Date.now(),
  }
}

export function borosMarketUrl(marketId: number, side: 'long' | 'short'): string {
  return `${BOROS_APP_BASE}/markets/${marketId}?direction=${side}`
}
