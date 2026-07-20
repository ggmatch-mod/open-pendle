/**
 * Read-only Pendle PT / Morpho market discovery and scenario math.
 *
 * This module owns the read-only, abortable Morpho GraphQL fetcher, but has no
 * wallet code, contract writes/calls, or React state. It validates every API
 * market against the full immutable Morpho tuple, joins collateral to
 * factory-indexed Pendle PTs by chain and address only, and produces explicitly
 * estimated (not executable) scenarios.
 */

import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
} from 'viem'
import type { Address, Hex } from 'viem'
import { SUPPORTED_CHAINS } from './addresses.ts'
import type {
  CatalogMarket,
  CatalogMembershipCoverage,
  FactorySnapshotCoverageStatus,
  MarketCatalog,
  PendleListingStatus,
} from './catalog.ts'
import type { SupportedChainId } from './types.ts'

export const MORPHO_GRAPHQL_ENDPOINT = 'https://api.morpho.org/graphql'
export const MORPHO_MARKETS_PAGE_SIZE = 100
export const MORPHO_PT_ADDRESS_BATCH_SIZE = 50
export const MORPHO_REQUEST_TIMEOUT_MS = 20_000

/**
 * Intersection of OpenPendle's configured chains and Morpho API's documented
 * supported networks (verified against the official API docs on 2026-07-19).
 * Unsupported OpenPendle chains remain explicit in result coverage.
 */
export const MORPHO_API_OPENPENDLE_CHAIN_IDS = [1, 143, 8453, 42161] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const WAD = 10n ** 18n
const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/
const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/
const DISPLAY_CONTROL_CHARACTERS =
  /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu

export type MorphoMarketId = Hex
export type MorphoMarketKey = `${number}:${MorphoMarketId}`

export class MorphoMarketValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'MorphoMarketValidationError'
    this.path = path
  }
}

export interface MorphoAsset {
  address: Address
  symbol: string
  decimals: number
}

/** Morpho Blue's immutable MarketParams tuple. */
export interface MorphoMarketTuple {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  /** WAD fraction; 0.915e18 means 91.5%. */
  lltv: bigint
}

export interface MorphoMarketState {
  borrowAssets: bigint
  /** Null when Morpho has no USD price for the loan asset. */
  borrowAssetsUsd: number | null
  supplyAssets: bigint
  /** Null when Morpho has no USD price for the loan asset. */
  supplyAssetsUsd: number | null
  liquidityAssets: bigint
  /** Null when Morpho has no USD price for the loan asset. */
  liquidityAssetsUsd: number | null
  /** Decimal fraction; 0.08 means 8% APY. */
  borrowApy: number
  /** Decimal fraction in [0, 1]. */
  utilization: number
  /** Decimal fraction in [0, 1]. */
  fee: number
  /** Unix seconds reported by Morpho's indexed state. */
  timestamp: number
}

export interface MorphoMarket {
  key: MorphoMarketKey
  marketId: MorphoMarketId
  chainId: number
  chainNetwork: string
  listed: boolean
  tuple: MorphoMarketTuple
  loanAsset: MorphoAsset
  collateralAsset: MorphoAsset
  state: MorphoMarketState
}

export interface MorphoMarketsPage {
  markets: MorphoMarket[]
  /** Present only when the GraphQL selection includes pageInfo. */
  pageInfo?: {
    count: number
    countTotal: number
  }
  /** Number of official API deprecation warnings attached to this response. */
  deprecationWarningCount: number
}

export interface PendlePtMatch {
  chainId: SupportedChainId
  market: Address
  pt: Address
  name: string
  expiry: number
  impliedApy: number | null
  pendleStatus: PendleListingStatus
}

export interface LoopingMarketCandidate {
  /** Morpho market plus the exact Pendle market used for PT metadata/APY. */
  key: string
  morpho: MorphoMarket
  pendle: PendlePtMatch
}

export interface LoopingMarketsCoverage {
  /** False while any OpenPendle chain is outside Morpho API coverage. */
  complete: boolean
  /** Whether every Morpho-API chain has complete factory and Pendle enrichment. */
  completeForMorphoApiChains: boolean
  morphoApiChainIds: SupportedChainId[]
  /** API-supported chains for which at least one live factory PT was queried. */
  queriedChainIds: SupportedChainId[]
  /** OpenPendle chains omitted because Morpho does not document API support. */
  unsupportedChainIds: SupportedChainId[]
  requestedPtCount: number
  requestCount: number
  morphoEndpoint: string
  /** Indexed Morpho state timestamps, in Unix seconds. */
  morphoOldestStateAt: number | null
  morphoLatestStateAt: number | null
  deprecationWarningCount: number
  catalogMembership: CatalogMembershipCoverage
  pendleEnrichmentComplete: boolean
  factoryStatus: FactorySnapshotCoverageStatus
  factoryCompleteChainIds: SupportedChainId[]
  incompleteMorphoApiChainIds: SupportedChainId[]
  /** Finalized factory-index timestamps, in Unix seconds, by chain. */
  factoryIndexedAt: Partial<Record<SupportedChainId, number>>
  factoryMarketCount: number
  catalogMarketCount: number
}

export interface LoopingMarketsResult {
  candidates: LoopingMarketCandidate[]
  morphoMarkets: MorphoMarket[]
  morphoMarketCount: number
  /** Local successful-fetch completion time, in Unix seconds. */
  fetchedAt: number
  coverage: LoopingMarketsCoverage
}

export type MorphoMarketsFetch = typeof fetch

export interface FetchLoopingMarketsOptions {
  catalog: MarketCatalog
  fetcher?: MorphoMarketsFetch
  signal?: AbortSignal
  endpoint?: string
  requestTimeoutMs?: number
  pageSize?: number
  ptAddressBatchSize?: number
  /** Deterministic Unix-second clock injection for tests. */
  now?: number
}

export interface LoopingScenarioInput {
  /** Total PT exposure per 1 unit of user equity; 1 means no debt. */
  leverage: number
  /** Current Pendle market-implied PT APY, as a decimal fraction. */
  ptApy: number
  /** Current Morpho borrow APY, as a decimal fraction. */
  borrowApy: number
  /** Morpho market LLTV, WAD-scaled. */
  lltv: bigint
  /** Expected holding period used only to annualize one-time costs. */
  holdingPeriodYears: number
  /** Absolute collateral-value decline used in the risk stress. */
  collateralPriceDrop?: number
  /** Fractional buffer below LLTV; 0.1 keeps 10% of LLTV unused. */
  lltvBuffer?: number
  /** Absolute APY increase added to the current borrow APY. */
  borrowApyIncrease?: number
  /** Absolute APY haircut subtracted from the current PT APY. */
  ptApyHaircut?: number
  /** One-time entry cost as a fraction of gross PT exposure. */
  entryCostRate?: number
  /** One-time exit cost as a fraction of gross PT exposure. */
  exitCostRate?: number
  /** Gas/relayer/aggregator estimate as a fraction of initial equity. */
  fixedCostOnEquity?: number
}

export interface LoopingScenario {
  /** All values below are normalized to 1 unit of initial user equity. */
  equity: 1
  collateralExposure: number
  debt: number
  lltv: number
  conservativeLltv: number
  currentLtv: number
  stressedCollateralValue: number
  stressedLtv: number
  stressedHealthFactor: number | null
  conservativeHealthFactor: number | null
  protocolMaxLeverage: number
  conservativeMaxLeverage: number
  withinProtocolLltv: boolean
  withinConservativeLimit: boolean
  /** Fractional collateral-value fall from the initial state to LLTV. */
  priceDropToLiquidation: number | null
  /** ptApy * leverage - borrowApy * debt; excludes all one-time costs. */
  headlineLoopApy: number
  stressedPtApy: number
  stressedBorrowApy: number
  annualizedOneTimeCosts: number
  /** Stress-adjusted estimate after annualized one-time costs. */
  conservativeNetApy: number
}

function fail(path: string, message: string): never {
  throw new MorphoMarketValidationError(path, message)
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(path, 'expected an object')
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') return fail(path, 'expected a string')
  const cleaned = value.replace(DISPLAY_CONTROL_CHARACTERS, '').trim()
  if (cleaned.length === 0) return fail(path, 'must not be empty')
  if (cleaned.length > 80) return fail(path, 'is too long')
  return cleaned
}

function asAddress(value: unknown, path: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    return fail(path, 'expected an EVM address')
  }
  const normalized = getAddress(value)
  if (normalized.toLowerCase() === ZERO_ADDRESS) {
    return fail(path, 'zero address is not a borrowable market component')
  }
  return normalized
}

function asMarketId(value: unknown, path: string): MorphoMarketId {
  if (typeof value !== 'string' || !HEX_32_BYTES.test(value)) {
    return fail(path, 'expected a 32-byte hex market id')
  }
  return value.toLowerCase() as MorphoMarketId
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return fail(path, 'expected a boolean')
  return value
}

function asSafeInteger(
  value: unknown,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return fail(path, `expected a safe integer from ${minimum} to ${maximum}`)
  }
  return value
}

function asUint(value: unknown, path: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return fail(path, 'numeric integer is negative, fractional, or unsafe')
    }
    return BigInt(value)
  }
  if (typeof value !== 'string' || !DECIMAL_UINT.test(value)) {
    return fail(path, 'expected a non-negative decimal integer string or safe integer')
  }
  return BigInt(value)
}

function asWad(value: unknown, path: string): bigint {
  // Morpho exposes LLTV as a string. Refuse JSON numbers even when they happen
  // to be safe: accepting both would make a later >2^53 value silently lossy.
  if (typeof value !== 'string' || !DECIMAL_UINT.test(value)) {
    return fail(path, 'expected a WAD decimal integer string')
  }
  const parsed = BigInt(value)
  if (parsed <= 0n || parsed >= WAD) {
    return fail(path, 'must be strictly between 0 and 1e18')
  }
  return parsed
}

function asFiniteNumber(
  value: unknown,
  path: string,
  minimum = 0,
  maximum = Number.MAX_VALUE,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    return fail(path, `expected a finite number from ${minimum} to ${maximum}`)
  }
  return value
}

function asNullableFiniteNumber(
  value: unknown,
  path: string,
  minimum = 0,
  maximum = Number.MAX_VALUE,
): number | null {
  return value === null ? null : asFiniteNumber(value, path, minimum, maximum)
}

function deprecationWarningCount(
  value: unknown,
  path: string,
): number {
  if (value === undefined) return 0
  const extensions = asObject(value, path)
  if (extensions.warnings === undefined) return 0
  if (!Array.isArray(extensions.warnings)) {
    return fail(`${path}.warnings`, 'expected an array')
  }
  let count = 0
  for (let index = 0; index < extensions.warnings.length; index += 1) {
    const warningPath = `${path}.warnings[${index}]`
    const warning = asObject(extensions.warnings[index], warningPath)
    const type = asString(warning.type, `${warningPath}.type`)
    if (type === 'DEPRECATED_FIELD') count += 1
  }
  return count
}

function parseAsset(value: unknown, path: string): MorphoAsset {
  const object = asObject(value, path)
  return {
    address: asAddress(object.address, `${path}.address`),
    symbol: asString(object.symbol, `${path}.symbol`),
    decimals: asSafeInteger(object.decimals, `${path}.decimals`, 0, 255),
  }
}

/** Recompute Morpho's `keccak256(abi.encode(MarketParams))` identifier. */
export function morphoMarketIdFromTuple(tuple: MorphoMarketTuple): MorphoMarketId {
  const loanToken = asAddress(tuple.loanToken, 'tuple.loanToken')
  const collateralToken = asAddress(tuple.collateralToken, 'tuple.collateralToken')
  const oracle = asAddress(tuple.oracle, 'tuple.oracle')
  const irm = asAddress(tuple.irm, 'tuple.irm')
  if (typeof tuple.lltv !== 'bigint' || tuple.lltv <= 0n || tuple.lltv >= WAD) {
    return fail('tuple.lltv', 'must be a bigint strictly between 0 and 1e18')
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [loanToken, collateralToken, oracle, irm, tuple.lltv],
    ),
  )
}

function parseMarket(value: unknown, path: string): MorphoMarket {
  const object = asObject(value, path)
  const chain = asObject(object.chain, `${path}.chain`)
  const chainId = asSafeInteger(chain.id, `${path}.chain.id`, 1)
  const loanAsset = parseAsset(object.loanAsset, `${path}.loanAsset`)
  const collateralAsset = parseAsset(object.collateralAsset, `${path}.collateralAsset`)
  const oracle = asObject(object.oracle, `${path}.oracle`)
  const tuple: MorphoMarketTuple = {
    loanToken: loanAsset.address,
    collateralToken: collateralAsset.address,
    oracle: asAddress(oracle.address, `${path}.oracle.address`),
    irm: asAddress(object.irmAddress, `${path}.irmAddress`),
    lltv: asWad(object.lltv, `${path}.lltv`),
  }
  const marketId = asMarketId(object.marketId, `${path}.marketId`)
  const computedMarketId = morphoMarketIdFromTuple(tuple)
  if (marketId !== computedMarketId) {
    return fail(`${path}.marketId`, 'does not match the immutable market tuple')
  }

  const stateObject = asObject(object.state, `${path}.state`)
  const borrowAssets = asUint(stateObject.borrowAssets, `${path}.state.borrowAssets`)
  const supplyAssets = asUint(stateObject.supplyAssets, `${path}.state.supplyAssets`)
  const liquidityAssets = asUint(
    stateObject.liquidityAssets,
    `${path}.state.liquidityAssets`,
  )
  if (borrowAssets > supplyAssets) {
    return fail(`${path}.state.borrowAssets`, 'cannot exceed supplyAssets')
  }
  if (liquidityAssets > supplyAssets) {
    return fail(`${path}.state.liquidityAssets`, 'cannot exceed supplyAssets')
  }

  const state: MorphoMarketState = {
    borrowAssets,
    borrowAssetsUsd: asNullableFiniteNumber(
      stateObject.borrowAssetsUsd,
      `${path}.state.borrowAssetsUsd`,
    ),
    supplyAssets,
    supplyAssetsUsd: asNullableFiniteNumber(
      stateObject.supplyAssetsUsd,
      `${path}.state.supplyAssetsUsd`,
    ),
    liquidityAssets,
    liquidityAssetsUsd: asNullableFiniteNumber(
      stateObject.liquidityAssetsUsd,
      `${path}.state.liquidityAssetsUsd`,
    ),
    borrowApy: asFiniteNumber(stateObject.borrowApy, `${path}.state.borrowApy`),
    utilization: asFiniteNumber(
      stateObject.utilization,
      `${path}.state.utilization`,
      0,
      1,
    ),
    fee: asFiniteNumber(stateObject.fee, `${path}.state.fee`, 0, 1),
    timestamp: asSafeInteger(
      stateObject.timestamp,
      `${path}.state.timestamp`,
      1,
    ),
  }

  return {
    key: `${chainId}:${marketId}` as MorphoMarketKey,
    marketId,
    chainId,
    chainNetwork: asString(chain.network, `${path}.chain.network`),
    listed: asBoolean(object.listed, `${path}.listed`),
    tuple,
    loanAsset,
    collateralAsset,
    state,
  }
}

/**
 * Parse the GraphQL `markets` envelope. Any GraphQL error, malformed row,
 * duplicate chain+market id, or tuple/id mismatch fails the whole page so a
 * caller can surface partial/unavailable coverage instead of silently lying.
 */
export function parseMorphoMarketsResponse(value: unknown): MorphoMarketsPage {
  const response = asObject(value, 'response')
  if (response.errors !== undefined) {
    if (!Array.isArray(response.errors)) return fail('response.errors', 'expected an array')
    if (response.errors.length > 0) return fail('response.errors', 'GraphQL returned errors')
  }
  const data = asObject(response.data, 'response.data')
  const marketsObject = asObject(data.markets, 'response.data.markets')
  if (!Array.isArray(marketsObject.items)) {
    return fail('response.data.markets.items', 'expected an array')
  }
  const markets = marketsObject.items.map((item, index) =>
    parseMarket(item, `response.data.markets.items[${index}]`),
  )
  const identities = new Set<string>()
  for (const market of markets) {
    if (identities.has(market.key)) {
      return fail('response.data.markets.items', `duplicate market identity ${market.key}`)
    }
    identities.add(market.key)
  }

  const result: MorphoMarketsPage = {
    markets,
    deprecationWarningCount: deprecationWarningCount(
      response.extensions,
      'response.extensions',
    ),
  }
  if (marketsObject.pageInfo !== undefined && marketsObject.pageInfo !== null) {
    const pageInfo = asObject(marketsObject.pageInfo, 'response.data.markets.pageInfo')
    const count = asSafeInteger(pageInfo.count, 'response.data.markets.pageInfo.count')
    const countTotal = asSafeInteger(
      pageInfo.countTotal,
      'response.data.markets.pageInfo.countTotal',
    )
    if (count !== markets.length) {
      return fail('response.data.markets.pageInfo.count', 'must equal the returned item count')
    }
    if (count > countTotal) {
      return fail('response.data.markets.pageInfo.countTotal', 'cannot be below count')
    }
    result.pageInfo = { count, countTotal }
  }
  return result
}

function ptJoinKey(chainId: number, pt: Address): string {
  return `${chainId}:${pt.toLowerCase()}`
}

/**
 * Join only factory-indexed, live, non-matured Pendle markets whose PT address
 * exactly equals Morpho collateral on the same chain. Symbols and names never
 * participate. Multiple Morpho tuples or Pendle markets remain separate.
 * This is discovery, not launch eligibility: `morpho.listed` is preserved and
 * callers must still apply liquidity, oracle, route, and execution allowlists.
 */
export function joinMorphoMarketsToPendlePts(
  morphoMarkets: readonly MorphoMarket[],
  pendleMarkets: readonly CatalogMarket[],
  nowUnixSeconds: number,
): LoopingMarketCandidate[] {
  asSafeInteger(nowUnixSeconds, 'nowUnixSeconds', 0)
  const pendleByPt = new Map<string, PendlePtMatch[]>()
  for (const market of pendleMarkets) {
    if (
      market.pt === null ||
      market.expiry === null ||
      market.expiry <= nowUnixSeconds ||
      market.lifecycle !== 'live' ||
      !market.sources.includes('factory-indexed')
    ) {
      continue
    }
    const match: PendlePtMatch = {
      chainId: market.chainId,
      market: market.address,
      pt: market.pt,
      name: market.name,
      expiry: market.expiry,
      impliedApy: market.impliedApy,
      pendleStatus: market.pendleStatus,
    }
    const key = ptJoinKey(match.chainId, match.pt)
    const existing = pendleByPt.get(key)
    if (existing) existing.push(match)
    else pendleByPt.set(key, [match])
  }

  const candidates: LoopingMarketCandidate[] = []
  const candidateKeys = new Set<string>()
  for (const morpho of morphoMarkets) {
    const matches = pendleByPt.get(ptJoinKey(morpho.chainId, morpho.tuple.collateralToken)) ?? []
    for (const pendle of matches) {
      const key = `${morpho.key}:${pendle.market.toLowerCase()}`
      if (candidateKeys.has(key)) continue
      candidateKeys.add(key)
      candidates.push({ key, morpho, pendle })
    }
  }
  return candidates.sort((a, b) => a.key.localeCompare(b.key))
}

interface MorphoDiscoveryTarget {
  chainId: SupportedChainId
  collateralTokens: Address[]
}

interface MorphoBatchLoad {
  markets: MorphoMarket[]
  requestCount: number
  deprecationWarningCount: number
}

const MORPHO_MARKETS_QUERY = `
  query OpenPendleLoopingMarkets(
    $first: Int!
    $skip: Int!
    $chainIds: [Int!]!
    $collateralAssets: [String!]!
  ) {
    markets(
      first: $first
      skip: $skip
      orderBy: SupplyAssetsUsd
      orderDirection: Desc
      where: {
        chainId_in: $chainIds
        collateralAssetAddress_in: $collateralAssets
      }
    ) {
      items {
        marketId
        chain { id network }
        listed
        lltv
        oracle { address }
        irmAddress
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals }
        state {
          borrowAssets
          borrowAssetsUsd
          supplyAssets
          supplyAssetsUsd
          liquidityAssets
          liquidityAssetsUsd
          borrowApy
          utilization
          fee
          timestamp
        }
      }
      pageInfo { count countTotal }
    }
  }
`

const MORPHO_MAX_PAGES_PER_BATCH = 1_000
const MORPHO_BATCH_CONCURRENCY = 4
const MORPHO_API_CHAIN_ID_SET = new Set<number>(MORPHO_API_OPENPENDLE_CHAIN_IDS)

function positiveIntegerSetting(
  value: number | undefined,
  fallback: number,
  maximum: number,
  path: string,
): number {
  if (value === undefined) return fallback
  return asSafeInteger(value, path, 1, maximum)
}

function loopingDiscoveryTargets(
  catalog: MarketCatalog,
  nowUnixSeconds: number,
): MorphoDiscoveryTarget[] {
  asSafeInteger(nowUnixSeconds, 'now', 0)
  const tokensByChain = new Map<SupportedChainId, Map<string, Address>>()
  for (let index = 0; index < catalog.markets.length; index += 1) {
    const market = catalog.markets[index]
    if (
      !MORPHO_API_CHAIN_ID_SET.has(market.chainId) ||
      market.pt === null ||
      market.expiry === null ||
      market.expiry <= nowUnixSeconds ||
      market.lifecycle !== 'live' ||
      !market.sources.includes('factory-indexed')
    ) {
      continue
    }
    const pt = asAddress(market.pt, `catalog.markets[${index}].pt`)
    let tokens = tokensByChain.get(market.chainId)
    if (tokens === undefined) {
      tokens = new Map<string, Address>()
      tokensByChain.set(market.chainId, tokens)
    }
    tokens.set(pt.toLowerCase(), pt)
  }
  return [...tokensByChain.entries()]
    .map(([chainId, tokens]) => ({
      chainId,
      collateralTokens: [...tokens.values()].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      ),
    }))
    .sort((a, b) => a.chainId - b.chainId)
}

/** Stable query-key fingerprint for the exact PT universe and displayed enrichment. */
export function loopingCatalogFingerprint(catalog: MarketCatalog): Hex {
  const rows = catalog.markets
    .filter((market) => market.sources.includes('factory-indexed'))
    .map((market) => [
      market.chainId,
      market.address.toLowerCase(),
      market.pt?.toLowerCase() ?? null,
      market.expiry,
      market.lifecycle,
      market.pendleStatus,
      market.impliedApy,
      market.name,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return keccak256(stringToHex(JSON.stringify(rows)))
}

function endpointUrl(endpoint: string): URL {
  let url: URL
  try {
    url = new URL(endpoint, globalThis.location?.href ?? undefined)
  } catch {
    return fail('endpoint', 'expected a valid URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return fail('endpoint', 'must not contain credentials')
  }
  const isLocalHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  if (url.protocol !== 'https:' && !isLocalHttp) {
    return fail('endpoint', 'must use HTTPS (except localhost tests)')
  }
  return url
}

function abortError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(reason === undefined ? fallback : String(reason))
}

async function fetchMorphoJson(
  fetcher: MorphoMarketsFetch,
  endpoint: URL,
  body: string,
  outerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  if (outerSignal?.aborted) {
    throw abortError(outerSignal.reason, 'Morpho market request was aborted')
  }
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let onOuterAbort: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    const stop = (error: Error): void => {
      controller.abort(error)
      reject(error)
    }
    timeoutId = setTimeout(
      () => stop(new Error('Morpho market request timed out')),
      timeoutMs,
    )
    if (outerSignal !== undefined) {
      onOuterAbort = () => stop(abortError(outerSignal.reason, 'Morpho market request was aborted'))
      outerSignal.addEventListener('abort', onOuterAbort, { once: true })
    }
  })
  try {
    const { response, json } = await Promise.race([
      (async () => {
        const response = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        const json = response.status === 204 ? null : await response.json()
        return { response, json }
      })(),
      deadline,
    ])
    if (!response.ok) {
      throw new Error(`Morpho market request failed (${response.status})`)
    }
    return json
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (onOuterAbort !== undefined) outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

async function fetchMorphoTargetBatch(
  fetcher: MorphoMarketsFetch,
  endpoint: URL,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  pageSize: number,
  target: MorphoDiscoveryTarget,
): Promise<MorphoBatchLoad> {
  const markets: MorphoMarket[] = []
  const identities = new Set<string>()
  const requestedTokens = new Set(target.collateralTokens.map((token) => token.toLowerCase()))
  let expectedTotal: number | null = null
  let requestCount = 0
  let warningCount = 0

  for (let page = 0; page < MORPHO_MAX_PAGES_PER_BATCH; page += 1) {
    const skip = markets.length
    requestCount += 1
    const body = await fetchMorphoJson(
      fetcher,
      endpoint,
      JSON.stringify({
        query: MORPHO_MARKETS_QUERY,
        variables: {
          first: pageSize,
          skip,
          chainIds: [target.chainId],
          collateralAssets: target.collateralTokens,
        },
      }),
      signal,
      timeoutMs,
    )
    const parsed = parseMorphoMarketsResponse(body)
    if (parsed.pageInfo === undefined) {
      return fail('response.data.markets.pageInfo', 'is required for safe pagination')
    }
    if (expectedTotal === null) expectedTotal = parsed.pageInfo.countTotal
    else if (parsed.pageInfo.countTotal !== expectedTotal) {
      return fail('response.data.markets.pageInfo.countTotal', 'changed while paginating')
    }
    warningCount += parsed.deprecationWarningCount

    for (const market of parsed.markets) {
      if (market.chainId !== target.chainId) {
        return fail(`morpho.${market.key}.chainId`, 'did not match the requested chain')
      }
      if (!requestedTokens.has(market.tuple.collateralToken.toLowerCase())) {
        return fail(
          `morpho.${market.key}.collateralToken`,
          'did not match an exact requested factory PT',
        )
      }
      if (identities.has(market.key)) {
        return fail('response.data.markets.items', `duplicate paginated market ${market.key}`)
      }
      identities.add(market.key)
      markets.push(market)
    }

    if (markets.length === expectedTotal) {
      return { markets, requestCount, deprecationWarningCount: warningCount }
    }
    if (markets.length > expectedTotal || parsed.markets.length === 0) {
      return fail('response.data.markets.pageInfo.countTotal', 'did not match paginated rows')
    }
  }
  return fail('response.data.markets', 'exceeded the pagination safety limit')
}

async function loadTargetsWithConcurrency(
  targets: readonly MorphoDiscoveryTarget[],
  load: (target: MorphoDiscoveryTarget) => Promise<MorphoBatchLoad>,
): Promise<MorphoBatchLoad[]> {
  const results = new Array<MorphoBatchLoad>(targets.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < targets.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await load(targets[index])
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(MORPHO_BATCH_CONCURRENCY, targets.length) },
      () => worker(),
    ),
  )
  return results
}

/**
 * Query only exact factory-indexed, live Pendle PT addresses, then verify every
 * returned Morpho row's complete immutable tuple and exact filter provenance.
 * Any failed page makes the whole result unavailable; partial discovery is
 * never represented as an empty or complete market set.
 */
export async function fetchLoopingMarkets(
  options: FetchLoopingMarketsOptions,
): Promise<LoopingMarketsResult> {
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation is available')
  const now = asSafeInteger(
    options.now ?? Math.floor(Date.now() / 1_000),
    'now',
    0,
  )
  const timeoutMs = positiveIntegerSetting(
    options.requestTimeoutMs,
    MORPHO_REQUEST_TIMEOUT_MS,
    5 * 60_000,
    'requestTimeoutMs',
  )
  const pageSize = positiveIntegerSetting(
    options.pageSize,
    MORPHO_MARKETS_PAGE_SIZE,
    1_000,
    'pageSize',
  )
  const batchSize = positiveIntegerSetting(
    options.ptAddressBatchSize,
    MORPHO_PT_ADDRESS_BATCH_SIZE,
    500,
    'ptAddressBatchSize',
  )
  const endpoint = endpointUrl(options.endpoint ?? MORPHO_GRAPHQL_ENDPOINT)
  const discoveryTargets = loopingDiscoveryTargets(options.catalog, now)
  const targets = discoveryTargets.flatMap((target) => {
    const batches: MorphoDiscoveryTarget[] = []
    for (let offset = 0; offset < target.collateralTokens.length; offset += batchSize) {
      batches.push({
        chainId: target.chainId,
        collateralTokens: target.collateralTokens.slice(offset, offset + batchSize),
      })
    }
    return batches
  })

  const loads = await loadTargetsWithConcurrency(targets, (target) =>
    fetchMorphoTargetBatch(
      fetcher,
      endpoint,
      options.signal,
      timeoutMs,
      pageSize,
      target,
    ),
  )
  if (options.signal?.aborted) {
    throw abortError(options.signal.reason, 'Morpho market request was aborted')
  }

  const morphoMarkets = loads
    .flatMap((load) => load.markets)
    .sort((a, b) => a.key.localeCompare(b.key))
  const identities = new Set<string>()
  for (const market of morphoMarkets) {
    if (identities.has(market.key)) {
      return fail('morphoMarkets', `duplicate market identity ${market.key}`)
    }
    identities.add(market.key)
  }

  const fetchedAt = options.now === undefined
    ? Math.floor(Date.now() / 1_000)
    : now
  const candidates = joinMorphoMarketsToPendlePts(
    morphoMarkets,
    options.catalog.markets,
    now,
  )
  const stateTimestamps = morphoMarkets.map((market) => market.state.timestamp)
  const apiChainIds = [...MORPHO_API_OPENPENDLE_CHAIN_IDS] as SupportedChainId[]
  const unsupportedChainIds = SUPPORTED_CHAINS
    .map((chain) => chain.id)
    .filter((chainId) => !MORPHO_API_CHAIN_ID_SET.has(chainId))
  const factoryCompleteChainIds = [...options.catalog.coverage.factory.completeChains]
  const factoryCompleteSet = new Set<number>(factoryCompleteChainIds)
  const incompleteMorphoApiChainIds = apiChainIds.filter(
    (chainId) => !factoryCompleteSet.has(chainId),
  )
  const pendleEnrichmentComplete =
    options.catalog.coverage.pendle.active && options.catalog.coverage.pendle.inactive
  const completeForMorphoApiChains =
    incompleteMorphoApiChainIds.length === 0 && pendleEnrichmentComplete

  return {
    candidates,
    morphoMarkets,
    morphoMarketCount: morphoMarkets.length,
    fetchedAt,
    coverage: {
      complete: completeForMorphoApiChains && unsupportedChainIds.length === 0,
      completeForMorphoApiChains,
      morphoApiChainIds: apiChainIds,
      queriedChainIds: discoveryTargets.map((target) => target.chainId),
      unsupportedChainIds,
      requestedPtCount: discoveryTargets.reduce(
        (total, target) => total + target.collateralTokens.length,
        0,
      ),
      requestCount: loads.reduce((total, load) => total + load.requestCount, 0),
      morphoEndpoint: endpoint.toString(),
      morphoOldestStateAt: stateTimestamps.length === 0 ? null : Math.min(...stateTimestamps),
      morphoLatestStateAt: stateTimestamps.length === 0 ? null : Math.max(...stateTimestamps),
      deprecationWarningCount: loads.reduce(
        (total, load) => total + load.deprecationWarningCount,
        0,
      ),
      catalogMembership: options.catalog.coverage.membership,
      pendleEnrichmentComplete,
      factoryStatus: options.catalog.coverage.factory.status,
      factoryCompleteChainIds,
      incompleteMorphoApiChainIds,
      factoryIndexedAt: { ...options.catalog.coverage.factory.indexedAt },
      factoryMarketCount: options.catalog.coverage.factory.marketCount,
      catalogMarketCount: options.catalog.markets.length,
    },
  }
}

function scenarioNumber(
  value: number,
  path: string,
  minimum: number,
  maximum = Number.MAX_VALUE,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    return fail(path, `expected a finite number from ${minimum} to ${maximum}`)
  }
  return value
}

/**
 * UI leverage ceiling for the research slider. The default policy keeps 1% of
 * LLTV unused with no additional price stress, then floors the result below the
 * strict boundary to a complete slider step.
 */
export function calculateLoopingLeverageCap(
  lltv: bigint,
  options: {
    collateralPriceDrop?: number
    lltvBuffer?: number
    step?: number
    absoluteCap?: number
  } = {},
): number {
  if (typeof lltv !== 'bigint' || lltv <= 0n || lltv >= WAD) {
    return fail('leverageCap.lltv', 'must be a bigint strictly between 0 and 1e18')
  }
  const collateralPriceDrop = scenarioNumber(
    options.collateralPriceDrop ?? 0,
    'leverageCap.collateralPriceDrop',
    0,
    1 - Number.EPSILON,
  )
  const lltvBuffer = scenarioNumber(
    options.lltvBuffer ?? 0.01,
    'leverageCap.lltvBuffer',
    0,
    1 - Number.EPSILON,
  )
  const step = scenarioNumber(options.step ?? 0.05, 'leverageCap.step', Number.MIN_VALUE, 1)
  const absoluteCap = scenarioNumber(
    options.absoluteCap ?? 100,
    'leverageCap.absoluteCap',
    1,
  )
  const conservativeLltv = Number(lltv) / 1e18 * (1 - lltvBuffer)
  const strictBoundary = 1 / (1 - conservativeLltv * (1 - collateralPriceDrop))
  const stepped = Math.floor((strictBoundary - step * 1e-9) / step) * step
  return Math.max(1, Math.min(absoluteCap, stepped))
}

/**
 * Conservative, normalized estimate only. It assumes debt stays constant under
 * the price stress, costs scale with gross PT exposure, and no rewards offset
 * borrow costs. It is not a quote, oracle valuation, or liquidation guarantee.
 */
export function calculateLoopingScenario(input: LoopingScenarioInput): LoopingScenario {
  const leverage = scenarioNumber(input.leverage, 'scenario.leverage', 1)
  const ptApy = scenarioNumber(input.ptApy, 'scenario.ptApy', -1)
  const borrowApy = scenarioNumber(input.borrowApy, 'scenario.borrowApy', 0)
  const holdingPeriodYears = scenarioNumber(
    input.holdingPeriodYears,
    'scenario.holdingPeriodYears',
    Number.MIN_VALUE,
  )
  if (typeof input.lltv !== 'bigint' || input.lltv <= 0n || input.lltv >= WAD) {
    return fail('scenario.lltv', 'must be a bigint strictly between 0 and 1e18')
  }
  const collateralPriceDrop = scenarioNumber(
    input.collateralPriceDrop ?? 0,
    'scenario.collateralPriceDrop',
    0,
    1 - Number.EPSILON,
  )
  const lltvBuffer = scenarioNumber(
    input.lltvBuffer ?? 0,
    'scenario.lltvBuffer',
    0,
    1 - Number.EPSILON,
  )
  const borrowApyIncrease = scenarioNumber(
    input.borrowApyIncrease ?? 0,
    'scenario.borrowApyIncrease',
    0,
  )
  const ptApyHaircut = scenarioNumber(
    input.ptApyHaircut ?? 0,
    'scenario.ptApyHaircut',
    0,
  )
  const entryCostRate = scenarioNumber(
    input.entryCostRate ?? 0,
    'scenario.entryCostRate',
    0,
    1,
  )
  const exitCostRate = scenarioNumber(
    input.exitCostRate ?? 0,
    'scenario.exitCostRate',
    0,
    1,
  )
  const fixedCostOnEquity = scenarioNumber(
    input.fixedCostOnEquity ?? 0,
    'scenario.fixedCostOnEquity',
    0,
    1,
  )

  const lltv = Number(input.lltv) / 1e18
  const conservativeLltv = lltv * (1 - lltvBuffer)
  const collateralExposure = leverage
  const debt = leverage - 1
  const currentLtv = debt / collateralExposure
  const stressedCollateralValue = collateralExposure * (1 - collateralPriceDrop)
  const stressedLtv = debt === 0 ? 0 : debt / stressedCollateralValue
  const stressedHealthFactor = debt === 0
    ? null
    : (lltv * stressedCollateralValue) / debt
  const conservativeHealthFactor = debt === 0
    ? null
    : (conservativeLltv * stressedCollateralValue) / debt
  const protocolMaxLeverage = 1 / (1 - lltv)
  const conservativeMaxLeverage =
    1 / (1 - conservativeLltv * (1 - collateralPriceDrop))
  const priceDropToLiquidation = debt === 0
    ? null
    : Math.max(0, 1 - currentLtv / lltv)

  const headlineLoopApy = ptApy * collateralExposure - borrowApy * debt
  const stressedPtApy = Math.max(-1, ptApy - ptApyHaircut)
  const stressedBorrowApy = borrowApy + borrowApyIncrease
  const oneTimeCosts =
    (entryCostRate + exitCostRate) * collateralExposure + fixedCostOnEquity
  const annualizedOneTimeCosts = oneTimeCosts / holdingPeriodYears
  const conservativeNetApy =
    stressedPtApy * collateralExposure -
    stressedBorrowApy * debt -
    annualizedOneTimeCosts

  const finiteOutputs = [
    lltv,
    conservativeLltv,
    collateralExposure,
    debt,
    currentLtv,
    stressedCollateralValue,
    stressedLtv,
    protocolMaxLeverage,
    conservativeMaxLeverage,
    headlineLoopApy,
    stressedPtApy,
    stressedBorrowApy,
    annualizedOneTimeCosts,
    conservativeNetApy,
  ]
  if (finiteOutputs.some((value) => !Number.isFinite(value))) {
    return fail('scenario', 'inputs produce a non-finite result')
  }

  return {
    equity: 1,
    collateralExposure,
    debt,
    lltv,
    conservativeLltv,
    currentLtv,
    stressedCollateralValue,
    stressedLtv,
    stressedHealthFactor,
    conservativeHealthFactor,
    protocolMaxLeverage,
    conservativeMaxLeverage,
    withinProtocolLltv: stressedLtv < lltv,
    withinConservativeLimit: leverage < conservativeMaxLeverage,
    priceDropToLiquidation,
    headlineLoopApy,
    stressedPtApy,
    stressedBorrowApy,
    annualizedOneTimeCosts,
    conservativeNetApy,
  }
}
