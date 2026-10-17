import type { Address } from 'viem'
import type { CatalogMarket } from './catalog.ts'
import { currentCatalogMarketLifecycle } from './catalog.ts'
import type { SupportedChainId } from './types.ts'

export const PENDLE_ASSET_PRICES_ENDPOINT =
  'https://api-v2.pendle.finance/core/v1/prices/assets'
export const STABLE_PARITY_TOLERANCE = 0.03
export const MARKET_LIQUIDITY_ALLOCATION_RATIO = 0.1
export const MAX_MARKET_WEIGHT = 0.9
export const MAX_PORTFOLIO_POSITIONS = 6
export const LOW_RISK_POLICY_SUMMARY = 'Ethereum USDe and sUSDe only'

const REQUEST_TIMEOUT_MS = 20_000
const MONTH_SECONDS = (365.25 / 12) * 24 * 60 * 60
const ETHEREUM_USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3' as Address
const ETHEREUM_SUSDE = '0x9d39a5de30e57443bff2a8307a4256c8797a3497' as Address
const LOW_RISK_UNDERLYING_ASSET_IDS = new Set<PendleAssetId>([
  pendleAssetId(1, ETHEREUM_USDE),
  pendleAssetId(1, ETHEREUM_SUSDE),
])
const LOW_RISK_ACCOUNTING_ASSET_ID = pendleAssetId(1, ETHEREUM_USDE)

export type PortfolioRisk = 'any' | 'low'
export type PortfolioMaturity = 'any' | '6m' | '3m'
export type PendleAssetId = `${SupportedChainId}-${Address}`

export interface PortfolioInput {
  sizeUsd: number
  risk: PortfolioRisk
  chainIds: readonly SupportedChainId[]
  maturity: PortfolioMaturity
}

export interface PortfolioAllocation {
  market: CatalogMarket
  amountUsd: number
  weight: number
  liquidityShare: number
  stableParityRatio: number | null
}

export interface PortfolioRecommendation {
  allocations: PortfolioAllocation[]
  deployedUsd: number
  unallocatedUsd: number
  weightedApy: number
  eligibleMarketCount: number
  checkedStableMarketCount: number
  excludedDepeggedCount: number
  excludedUnpricedStableCount: number
}

type AssetPrices = Readonly<Record<string, number>>

interface Candidate {
  market: CatalogMarket
  capacityUsd: number
  stableParityRatio: number | null
}

interface StableCheck {
  eligible: boolean
  parityRatio: number | null
  reason: 'healthy' | 'depegged' | 'unpriced'
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function pendleAssetId(
  chainId: SupportedChainId,
  address: Address,
): PendleAssetId {
  return `${chainId}-${address.toLowerCase()}` as PendleAssetId
}

export function portfolioPriceAssetIds(
  markets: readonly CatalogMarket[],
): PendleAssetId[] {
  const ids = new Set<PendleAssetId>()
  for (const market of markets) {
    if (!market.categoryIds.includes('stables')) continue
    if (market.underlyingAsset !== null) {
      ids.add(pendleAssetId(market.chainId, market.underlyingAsset))
    }
    if (market.accountingAsset !== null) {
      ids.add(pendleAssetId(market.chainId, market.accountingAsset))
    }
  }
  return [...ids]
}

export function portfolioPriceAssetIdsForInput(
  markets: readonly CatalogMarket[],
  input: PortfolioInput,
  now = Math.floor(Date.now() / 1_000),
): PendleAssetId[] {
  const selectedChains = new Set(input.chainIds)
  return portfolioPriceAssetIds(
    markets.filter((market) =>
      isBaseEligible(market, input, selectedChains, now),
    ),
  )
}

export function parsePendleAssetPrices(value: unknown): Record<string, number> {
  const body = record(value)
  const rawPrices = record(body?.prices)
  if (rawPrices === null) {
    throw new Error('Pendle asset-price service returned an invalid response')
  }

  const prices: Record<string, number> = {}
  for (const [rawId, rawPrice] of Object.entries(rawPrices)) {
    const price = finitePositive(rawPrice)
    if (price !== null) prices[rawId.toLowerCase()] = price
  }
  return prices
}

function requestUrl(endpoint: string): URL {
  const browserLocation = globalThis.location?.href
  return new URL(endpoint, browserLocation ?? 'http://localhost/')
}

async function fetchAllAssetPrices(
  fetcher: typeof fetch,
  endpoint: string,
  outerSignal?: AbortSignal,
): Promise<Record<string, number>> {
  if (outerSignal?.aborted) {
    throw outerSignal.reason ?? new Error('Pendle asset-price request was aborted')
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort(outerSignal?.reason)
  outerSignal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new Error('Pendle asset-price request timed out')),
    REQUEST_TIMEOUT_MS,
  )

  try {
    const url = requestUrl(endpoint)
    const response = await fetcher(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Pendle asset-price request failed (${response.status})`)
    }
    return parsePendleAssetPrices(await response.json())
  } finally {
    clearTimeout(timeout)
    outerSignal?.removeEventListener('abort', onAbort)
  }
}

export async function fetchPendleAssetPrices(
  ids: readonly PendleAssetId[],
  options: {
    fetcher?: typeof fetch
    endpoint?: string
    signal?: AbortSignal
  } = {},
): Promise<Record<string, number>> {
  if (ids.length === 0) return {}
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation is available')

  const unique = [...new Set(ids.map((id) => id.toLowerCase() as PendleAssetId))]
  // Pendle recommends one all-prices request over per-market requests. Large
  // comma-separated `ids` queries are rejected, so fetch once and retain only
  // the stable-exposure prices needed by this elaboration.
  const allPrices = await fetchAllAssetPrices(
    fetcher,
    options.endpoint ?? PENDLE_ASSET_PRICES_ENDPOINT,
    options.signal,
  )
  const selected: Record<string, number> = {}
  for (const id of unique) {
    const price = allPrices[id]
    if (price !== undefined) selected[id] = price
  }
  return selected
}

function maturitySeconds(maturity: PortfolioMaturity): number | null {
  if (maturity === '3m') return 3 * MONTH_SECONDS
  if (maturity === '6m') return 6 * MONTH_SECONDS
  return null
}

/**
 * "Low" is an explicit OpenPendle exposure policy, not a synonym for
 * Pendle's Prime flag. Keep the allowlist narrow until each additional
 * underlying and chain has been reviewed.
 */
export function isLowRiskPortfolioMarket(market: CatalogMarket): boolean {
  if (
    market.underlyingAsset === null ||
    market.accountingAsset === null ||
    market.isVolatile !== false ||
    !market.categoryIds.includes('stables') ||
    !market.categoryIds.includes('ethena') ||
    market.protocol?.trim().toLowerCase() !== 'ethena'
  ) {
    return false
  }

  return (
    pendleAssetId(market.chainId, market.accountingAsset) ===
      LOW_RISK_ACCOUNTING_ASSET_ID &&
    LOW_RISK_UNDERLYING_ASSET_IDS.has(
      pendleAssetId(market.chainId, market.underlyingAsset),
    )
  )
}

function isBaseEligible(
  market: CatalogMarket,
  input: PortfolioInput,
  selectedChains: ReadonlySet<SupportedChainId>,
  now: number,
): boolean {
  if (
    market.pendleStatus !== 'active' ||
    !market.sources.includes('pendle-listed') ||
    currentCatalogMarketLifecycle(market, now) !== 'live' ||
    market.pt === null ||
    market.expiry === null ||
    market.impliedApy === null ||
    !Number.isFinite(market.impliedApy) ||
    market.impliedApy <= 0 ||
    market.liquidity === null ||
    !Number.isFinite(market.liquidity) ||
    market.liquidity <= 0 ||
    !selectedChains.has(market.chainId)
  ) {
    return false
  }

  const maxMaturity = maturitySeconds(input.maturity)
  if (maxMaturity !== null && market.expiry - now >= maxMaturity) return false
  return input.risk !== 'low' || isLowRiskPortfolioMarket(market)
}

function stableCheck(market: CatalogMarket, prices: AssetPrices): StableCheck {
  if (!market.categoryIds.includes('stables')) {
    return { eligible: true, parityRatio: null, reason: 'healthy' }
  }
  if (
    market.underlyingAsset === null ||
    market.accountingAsset === null ||
    market.conversionRate === null
  ) {
    return { eligible: false, parityRatio: null, reason: 'unpriced' }
  }

  const underlyingPrice = finitePositive(
    prices[pendleAssetId(market.chainId, market.underlyingAsset)],
  )
  const accountingPrice = finitePositive(
    prices[pendleAssetId(market.chainId, market.accountingAsset)],
  )
  if (underlyingPrice === null || accountingPrice === null) {
    return { eligible: false, parityRatio: null, reason: 'unpriced' }
  }

  const parityRatio = underlyingPrice / (accountingPrice * market.conversionRate)
  const accountingAtParity = Math.abs(accountingPrice - 1) <= STABLE_PARITY_TOLERANCE
  const wrapperAtParity =
    Number.isFinite(parityRatio) &&
    Math.abs(parityRatio - 1) <= STABLE_PARITY_TOLERANCE
  return {
    eligible: accountingAtParity && wrapperAtParity,
    parityRatio,
    reason: accountingAtParity && wrapperAtParity ? 'healthy' : 'depegged',
  }
}

function protocolKey(market: CatalogMarket): string {
  return market.protocol?.trim().toLowerCase() || market.key
}

function candidateOrder(a: Candidate, b: Candidate): number {
  return (
    Number(b.market.impliedApy ?? 0) - Number(a.market.impliedApy ?? 0) ||
    Number(b.market.liquidity ?? 0) - Number(a.market.liquidity ?? 0) ||
    a.market.name.localeCompare(b.market.name)
  )
}

export function buildPortfolioRecommendation(
  markets: readonly CatalogMarket[],
  prices: AssetPrices,
  input: PortfolioInput,
  now = Math.floor(Date.now() / 1_000),
): PortfolioRecommendation {
  if (!Number.isFinite(input.sizeUsd) || input.sizeUsd <= 0) {
    throw new Error('Portfolio size must be greater than zero')
  }
  const selectedChains = new Set(input.chainIds)
  if (selectedChains.size === 0) {
    throw new Error('Select at least one network')
  }

  let checkedStableMarketCount = 0
  let excludedDepeggedCount = 0
  let excludedUnpricedStableCount = 0
  const candidates: Candidate[] = []

  for (const market of markets) {
    if (!isBaseEligible(market, input, selectedChains, now)) continue
    const check = stableCheck(market, prices)
    if (market.categoryIds.includes('stables')) checkedStableMarketCount += 1
    if (!check.eligible) {
      if (check.reason === 'depegged') excludedDepeggedCount += 1
      if (check.reason === 'unpriced') excludedUnpricedStableCount += 1
      continue
    }
    candidates.push({
      market,
      capacityUsd: Number(market.liquidity) * MARKET_LIQUIDITY_ALLOCATION_RATIO,
      stableParityRatio: check.parityRatio,
    })
  }

  candidates.sort(candidateOrder)
  const maxPositionUsd =
    candidates.length > 1 ? input.sizeUsd * MAX_MARKET_WEIGHT : input.sizeUsd
  const maxProtocolUsd =
    candidates.length > 1 ? input.sizeUsd * MAX_MARKET_WEIGHT : input.sizeUsd
  const topProtocol = candidates[0] === undefined ? null : protocolKey(candidates[0].market)
  const ordered =
    candidates.length <= 1
      ? candidates
      : [
          candidates[0],
          ...candidates.slice(1).sort((a, b) => {
            const aDistinct = protocolKey(a.market) !== topProtocol
            const bDistinct = protocolKey(b.market) !== topProtocol
            return Number(bDistinct) - Number(aDistinct) || candidateOrder(a, b)
          }),
        ]

  let remaining = input.sizeUsd
  const protocolAmounts = new Map<string, number>()
  const rawAllocations: Array<{
    candidate: Candidate
    amountUsd: number
  }> = []

  for (const candidate of ordered) {
    if (remaining <= 0.005 || rawAllocations.length >= MAX_PORTFOLIO_POSITIONS) break
    const protocol = protocolKey(candidate.market)
    const protocolRoom = Math.max(0, maxProtocolUsd - (protocolAmounts.get(protocol) ?? 0))
    const amountUsd = Math.min(
      remaining,
      maxPositionUsd,
      protocolRoom,
      candidate.capacityUsd,
    )
    if (amountUsd <= 0.005) continue
    rawAllocations.push({ candidate, amountUsd })
    protocolAmounts.set(protocol, (protocolAmounts.get(protocol) ?? 0) + amountUsd)
    remaining -= amountUsd
  }

  const deployedUsd = input.sizeUsd - Math.max(0, remaining)
  const allocations = rawAllocations.map(({ candidate, amountUsd }) => ({
    market: candidate.market,
    amountUsd,
    weight: amountUsd / input.sizeUsd,
    liquidityShare: amountUsd / Number(candidate.market.liquidity),
    stableParityRatio: candidate.stableParityRatio,
  }))
  const weightedApy =
    input.sizeUsd === 0
      ? 0
      : allocations.reduce(
          (sum, allocation) =>
            sum + allocation.weight * Number(allocation.market.impliedApy),
          0,
        )

  return {
    allocations,
    deployedUsd,
    unallocatedUsd: Math.max(0, input.sizeUsd - deployedUsd),
    weightedApy,
    eligibleMarketCount: candidates.length,
    checkedStableMarketCount,
    excludedDepeggedCount,
    excludedUnpricedStableCount,
  }
}
