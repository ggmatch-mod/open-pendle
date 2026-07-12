/**
 * Cross-chain Pendle market catalog.
 *
 * Factory snapshots are the canonical membership source. Pendle's public API
 * enriches those rows and provides an explicitly incomplete bootstrap when a
 * factory snapshot (or one of its chains) is unavailable. Catalog data is
 * discovery metadata only; pool pages still validate contracts on-chain.
 */

import type { Address } from 'viem'
import {
  addressBookFor,
  isSupportedChainId,
  SUPPORTED_CHAINS,
} from './addresses.ts'
import type { FactoryGeneration } from './addresses.ts'
import type { SupportedChainId } from './types.ts'

export const PENDLE_MARKET_CATALOG_ENDPOINT =
  'https://api-v2.pendle.finance/core/v2/markets/all'
const APP_BASE_URL = typeof import.meta.env?.BASE_URL === 'string'
  ? import.meta.env.BASE_URL
  : '/'
export const FACTORY_MARKET_SNAPSHOT_ENDPOINT =
  `${APP_BASE_URL.endsWith('/') ? APP_BASE_URL : `${APP_BASE_URL}/`}catalog/factory-markets.v1.json`
export const FACTORY_MARKET_SNAPSHOT_SCHEMA_VERSION = 1 as const
export const FACTORY_MARKET_SNAPSHOT_DATASET = 'openpendle-factory-markets' as const
export const FACTORY_MARKET_EVENT_TOPICS = {
  v1: '0x166ae5f55615b65bbd9a2496e98d4e4d78ca15bd6127c0fe2dc27b76f6c03143',
  v3Plus: '0xae811fae25e2770b6bd1dcb1475657e8c3a976f91d1ebf081271db08eef920af',
} as const
export const PENDLE_MARKET_CATALOG_PAGE_SIZE = 100
export const MARKET_CATALOG_REQUEST_TIMEOUT_MS = 20_000

export type CatalogMarketKey = `${SupportedChainId}:${Address}`
export type CatalogMarketSource = 'pendle-listed' | 'factory-indexed'
export type CatalogMarketLifecycle = 'live' | 'matured' | 'unknown'
export type PendleListingStatus = 'active' | 'inactive' | null

export interface CatalogMarket {
  /** Stable cross-chain identity. Addresses alone are not globally unique. */
  key: CatalogMarketKey
  chainId: SupportedChainId
  address: Address
  name: string
  protocol: string | null
  /** Unix seconds. */
  expiry: number | null
  pt: Address | null
  yt: Address | null
  sy: Address | null
  icon: string | null
  /** USD value reported by Pendle. Not reliable as a current metric after maturity. */
  tvl: number | null
  /** Decimal APY: 0.05 means 5%. */
  impliedApy: number | null
  /** Unix seconds. */
  createdAt: number | null
  /** On-chain time lifecycle; independent from Pendle frontend listing state. */
  lifecycle: CatalogMarketLifecycle
  /** Null means unlisted only when both Pendle catalog slices have coverage. */
  pendleStatus: PendleListingStatus
  /** A market can be factory-discovered and present in Pendle's catalog. */
  sources: CatalogMarketSource[]
}

export type CatalogMembershipCoverage = 'complete' | 'partial' | 'bootstrap'
export type FactorySnapshotCoverageStatus = 'complete' | 'partial' | 'unavailable'

export interface MarketCatalog {
  markets: CatalogMarket[]
  byKey: Record<string, CatalogMarket>
  coverage: {
    /** Complete only when every configured chain has canonical factory coverage. */
    complete: boolean
    /** `bootstrap` means membership currently comes only from Pendle's list. */
    membership: CatalogMembershipCoverage
    pendle: {
      active: boolean
      inactive: boolean
    }
    factory: {
      status: FactorySnapshotCoverageStatus
      indexedChains: SupportedChainId[]
      completeChains: SupportedChainId[]
      totalChains: number
      marketCount: number
      quarantinedLogCount: number
      /** Finalized block timestamp for each chain's last successful scan. */
      indexedAt: Partial<Record<SupportedChainId, number>>
      /** Indexer-reported failures, keyed by decimal chain id. */
      errors: Partial<Record<SupportedChainId, string[]>>
      /** Snapshot request/schema failure. Null for a normal 404 bootstrap. */
      requestError: string | null
    }
  }
}

export type CatalogFetch = typeof fetch

export interface FetchMarketCatalogOptions {
  /** Injectable so parsing and pagination can be tested without the network. */
  fetcher?: CatalogFetch
  signal?: AbortSignal
  pendleEndpoint?: string
  /** Null explicitly disables the factory snapshot and enters bootstrap mode. */
  factorySnapshotEndpoint?: string | null
  /** Per-request timeout; configurable for deterministic tests. */
  requestTimeoutMs?: number
}

export interface FetchFactoryMarketSnapshotOptions {
  fetcher?: CatalogFetch
  signal?: AbortSignal
  endpoint?: string
  requestTimeoutMs?: number
}

export interface FactorySnapshotProvenanceV1 {
  source: 'pendle-market-factory-events'
  factoryConfig: 'app/src/lib/addresses.ts'
  eventSignatures: {
    v1: 'CreateNewMarket(address,address,int256,int256)'
    v3Plus: 'CreateNewMarket(address,address,int256,int256,uint256)'
  }
  eventTopics: {
    v1: typeof FACTORY_MARKET_EVENT_TOPICS.v1
    v3Plus: typeof FACTORY_MARKET_EVENT_TOPICS.v3Plus
  }
}

export interface FactorySnapshotCoverageV1 {
  complete: boolean
  completeChains: SupportedChainId[]
  totalChains: number
  marketCount: number
  quarantinedLogCount: number
}

export interface FactorySnapshotReorgAnchorV1 {
  blockNumber: number
  blockHash: `0x${string}`
}

export interface FactorySnapshotFactoryV1 {
  generation: FactoryGeneration['gen']
  address: Address
  eventVersion: 'v1' | 'v3+'
  deploymentBlock: number
  startBlockSource: 'derived-code-binary-search' | 'configured' | 'checkpoint'
  indexedThrough: number | null
  logCount: number
}

export interface FactorySnapshotMarketV1 {
  key: CatalogMarketKey
  chainId: SupportedChainId
  address: Address
  pt: Address
  factory: Address
  factoryGeneration: FactoryGeneration['gen']
  eventVersion: 'v1' | 'v3+'
  blockNumber: number
  blockHash: `0x${string}`
  transactionHash: `0x${string}`
  logIndex: number
  scalarRoot: string
  initialAnchor: string
  lnFeeRateRoot: string | null
  /** Optional future enrichment; absent from the event-only v1 generator. */
  name?: string
  expiry?: number
  yt?: Address
  sy?: Address
  createdAt?: number
}

export interface FactorySnapshotChainV1 {
  chainId: SupportedChainId
  complete: boolean
  indexedThrough: number | null
  indexedThroughHash: `0x${string}` | null
  /** Unix seconds for indexedThrough. Null on legacy/unindexed checkpoints. */
  indexedThroughTimestamp: number | null
  reorgAnchor: FactorySnapshotReorgAnchorV1 | null
  factories: FactorySnapshotFactoryV1[]
  marketCount: number
  quarantinedLogCount: number
  errors: string[]
  markets: FactorySnapshotMarketV1[]
}

export interface FactoryMarketSnapshotV1 {
  schemaVersion: typeof FACTORY_MARKET_SNAPSHOT_SCHEMA_VERSION
  dataset: typeof FACTORY_MARKET_SNAPSHOT_DATASET
  provenance: FactorySnapshotProvenanceV1
  coverage: FactorySnapshotCoverageV1
  chains: FactorySnapshotChainV1[]
}

interface PendleCoverage {
  active: boolean
  inactive: boolean
}

interface BuildMarketCatalogOptions {
  factorySnapshot: FactoryMarketSnapshotV1 | null
  pendleMarkets: readonly CatalogMarket[]
  pendleCoverage: PendleCoverage
  factoryRequestError?: string | null
  now?: number
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/
const DECIMAL_INTEGER = /^-?\d+$/
const MAX_PAGES_PER_STATUS = 1_000
const MAX_MARKETS_PER_CHAIN = 100_000
const MAX_CHAIN_ERRORS = 1_000
const MIN_PLAUSIBLE_UNIX_SECONDS = Date.UTC(2020, 0, 1) / 1_000
const MAX_PLAUSIBLE_UNIX_SECONDS = Date.UTC(2200, 0, 1) / 1_000
const DISPLAY_CONTROL_CHARACTERS =
  /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu
const FACTORY_SNAPSHOT_NOT_FOUND = Symbol('factory-snapshot-not-found')

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function displayText(value: unknown, maxLength: number): string | null {
  const parsed = text(value)
  if (parsed === null) return null
  const cleaned = parsed.replace(DISPLAY_CONTROL_CHARACTERS, '').trim()
  return cleaned.length === 0 ? null : cleaned.slice(0, maxLength)
}

function firstValid<T>(
  values: readonly unknown[],
  parse: (value: unknown) => T | null,
): T | null {
  for (const value of values) {
    const parsed = parse(value)
    if (parsed !== null) return parsed
  }
  return null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function strictNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

function unixSeconds(value: unknown): number | null {
  const numeric = finiteNumber(value)
  if (numeric !== null) {
    const seconds = Math.floor(numeric >= 1_000_000_000_000 ? numeric / 1_000 : numeric)
    return seconds >= MIN_PLAUSIBLE_UNIX_SECONDS && seconds <= MAX_PLAUSIBLE_UNIX_SECONDS
      ? seconds
      : null
  }
  const raw = text(value)
  if (raw === null) return null
  const milliseconds = Date.parse(raw)
  const seconds = Math.floor(milliseconds / 1_000)
  return Number.isFinite(milliseconds) &&
    seconds >= MIN_PLAUSIBLE_UNIX_SECONDS &&
    seconds <= MAX_PLAUSIBLE_UNIX_SECONDS
    ? seconds
    : null
}

function strictUnixSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? unixSeconds(value)
    : null
}

function address(value: unknown): Address | null {
  const raw = text(value)
  return raw !== null && HEX_ADDRESS.test(raw) && BigInt(raw) !== 0n
    ? (raw.toLowerCase() as Address)
    : null
}

function hash(value: unknown): `0x${string}` | null {
  const raw = text(value)
  return raw !== null && HEX_HASH.test(raw) ? (raw.toLowerCase() as `0x${string}`) : null
}

function required<T>(value: T | null, path: string): T {
  if (value === null) throw new Error(`Factory market snapshot has invalid ${path}`)
  return value
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unexpected !== undefined) {
    throw new Error(`Factory market snapshot has unsupported ${path}.${unexpected}`)
  }
}

/** Pendle asset ids are normally `${chainId}-${address}`. */
function assetAddress(value: unknown, expectedChainId: SupportedChainId): Address | null {
  const object = record(value)
  const explicitChainId = finiteNumber(object?.chainId)
  if (
    explicitChainId !== null &&
    (!Number.isInteger(explicitChainId) || explicitChainId !== expectedChainId)
  ) {
    return null
  }

  const candidates = object === null ? [value] : [object.address, object.id]
  for (const candidate of candidates) {
    const raw = text(candidate)
    if (raw === null) continue
    const direct = address(raw)
    if (direct !== null) return direct

    const separator = raw.indexOf('-')
    if (separator <= 0) continue
    const assetChainId = Number(raw.slice(0, separator))
    if (!Number.isInteger(assetChainId) || assetChainId !== expectedChainId) continue
    const parsed = address(raw.slice(separator + 1))
    if (parsed !== null) return parsed
  }
  return null
}

export function catalogMarketKey(
  chainId: SupportedChainId,
  marketAddress: Address,
): CatalogMarketKey {
  return `${chainId}:${marketAddress.toLowerCase()}` as CatalogMarketKey
}

export function catalogMarketLifecycle(
  expiry: number | null,
  now = Math.floor(Date.now() / 1_000),
): CatalogMarketLifecycle {
  if (expiry === null) return 'unknown'
  return expiry <= now ? 'matured' : 'live'
}

/** Refresh a catalog row's lifecycle without requiring a catalog refetch at maturity. */
export function currentCatalogMarketLifecycle(
  market: Pick<CatalogMarket, 'expiry' | 'lifecycle'>,
  now = Math.floor(Date.now() / 1_000),
): CatalogMarketLifecycle {
  return market.expiry === null ? market.lifecycle : catalogMarketLifecycle(market.expiry, now)
}

/**
 * Pendle's inactive catalog can retain stale or broken USD valuations after
 * expiry (especially for dust LP balances). Do not present those values as
 * current TVL; keep the raw field available for diagnostics and enrichment.
 */
export function catalogMarketDisplayTvl(
  market: Pick<CatalogMarket, 'expiry' | 'lifecycle' | 'tvl'>,
  now = Math.floor(Date.now() / 1_000),
): number | null {
  return currentCatalogMarketLifecycle(market, now) === 'matured' ? null : market.tvl
}

/**
 * Normalize one untrusted Pendle API row. Unsupported chains and corrupt
 * identities are skipped; malformed enrichment fields degrade to null.
 */
export function normalizeCatalogMarket(
  value: unknown,
  pendleStatus: Exclude<PendleListingStatus, null>,
  now = Math.floor(Date.now() / 1_000),
): CatalogMarket | null {
  const row = record(value)
  if (row === null) return null

  const chainNumber = finiteNumber(row.chainId)
  const chainId =
    chainNumber !== null && Number.isInteger(chainNumber) && isSupportedChainId(chainNumber)
      ? chainNumber
      : null
  if (chainId === null) return null

  const marketAddress = firstValid([row.address, row.marketAddress], (candidate) =>
    assetAddress(candidate, chainId),
  )
  if (marketAddress === null) return null

  const details = record(row.details)
  const expiry = firstValid([row.expiry, row.expiryTimestamp], unixSeconds)
  return {
    key: catalogMarketKey(chainId, marketAddress),
    chainId,
    address: marketAddress,
    name:
      firstValid([row.name, row.displayName], (candidate) => displayText(candidate, 160)) ??
      'Pendle market',
    protocol: firstValid([row.protocol, row.protocolName], (candidate) =>
      displayText(candidate, 120),
    ),
    expiry,
    pt: firstValid([row.pt, row.ptAddress], (candidate) => assetAddress(candidate, chainId)),
    yt: firstValid([row.yt, row.ytAddress], (candidate) => assetAddress(candidate, chainId)),
    sy: firstValid([row.sy, row.syAddress], (candidate) => assetAddress(candidate, chainId)),
    icon: firstValid([row.icon, row.iconUrl], (candidate) => displayText(candidate, 2_048)),
    tvl: firstValid([details?.totalTvl, row.totalTvl, row.tvl], nonNegativeNumber),
    impliedApy: firstValid([details?.impliedApy, row.impliedApy], finiteNumber),
    createdAt: firstValid([row.timestamp, row.createdAt], unixSeconds),
    lifecycle: catalogMarketLifecycle(expiry, now),
    pendleStatus,
    sources: ['pendle-listed'],
  }
}

function parseProvenance(value: unknown): FactorySnapshotProvenanceV1 {
  const source = required(record(value), 'provenance')
  exactKeys(source, ['source', 'factoryConfig', 'eventSignatures', 'eventTopics'], 'provenance')
  if (
    source.source !== 'pendle-market-factory-events' ||
    source.factoryConfig !== 'app/src/lib/addresses.ts'
  ) {
    throw new Error('Factory market snapshot has invalid provenance source')
  }
  const signatures = required(record(source.eventSignatures), 'provenance.eventSignatures')
  exactKeys(signatures, ['v1', 'v3Plus'], 'provenance.eventSignatures')
  if (
    signatures.v1 !== 'CreateNewMarket(address,address,int256,int256)' ||
    signatures.v3Plus !== 'CreateNewMarket(address,address,int256,int256,uint256)'
  ) {
    throw new Error('Factory market snapshot has invalid provenance event signatures')
  }
  const topics = required(record(source.eventTopics), 'provenance.eventTopics')
  exactKeys(topics, ['v1', 'v3Plus'], 'provenance.eventTopics')
  if (
    topics.v1 !== FACTORY_MARKET_EVENT_TOPICS.v1 ||
    topics.v3Plus !== FACTORY_MARKET_EVENT_TOPICS.v3Plus
  ) {
    throw new Error('Factory market snapshot has invalid provenance event topics')
  }
  return {
    source: 'pendle-market-factory-events',
    factoryConfig: 'app/src/lib/addresses.ts',
    eventSignatures: {
      v1: 'CreateNewMarket(address,address,int256,int256)',
      v3Plus: 'CreateNewMarket(address,address,int256,int256,uint256)',
    },
    eventTopics: {
      v1: FACTORY_MARKET_EVENT_TOPICS.v1,
      v3Plus: FACTORY_MARKET_EVENT_TOPICS.v3Plus,
    },
  }
}

function parseFactoryEntry(
  value: unknown,
  chainId: SupportedChainId,
  path: string,
): FactorySnapshotFactoryV1 {
  const row = required(record(value), path)
  exactKeys(
    row,
    [
      'generation',
      'address',
      'eventVersion',
      'deploymentBlock',
      'startBlockSource',
      'indexedThrough',
      'logCount',
    ],
    path,
  )
  const factoryAddress = required(address(row.address), `${path}.address`)
  const configured = addressBookFor(chainId).marketFactories.find(
    (factory) => factory.marketFactory.toLowerCase() === factoryAddress,
  )
  if (configured === undefined || row.generation !== configured.gen) {
    throw new Error(`Factory market snapshot has an unrecognized ${path} factory generation`)
  }
  const indexedThrough =
    row.indexedThrough === null
      ? null
      : required(strictNonNegativeInteger(row.indexedThrough), `${path}.indexedThrough`)
  if (row.eventVersion !== 'v1' && row.eventVersion !== 'v3+') {
    throw new Error(`Factory market snapshot has invalid ${path}.eventVersion`)
  }
  if (
    row.startBlockSource !== 'derived-code-binary-search' &&
    row.startBlockSource !== 'configured' &&
    row.startBlockSource !== 'checkpoint'
  ) {
    throw new Error(`Factory market snapshot has invalid ${path}.startBlockSource`)
  }
  if ((configured.gen === 'v1') !== (row.eventVersion === 'v1')) {
    throw new Error(`Factory market snapshot has mismatched ${path}.eventVersion`)
  }
  return {
    generation: configured.gen,
    address: factoryAddress,
    eventVersion: row.eventVersion,
    deploymentBlock: required(
      strictNonNegativeInteger(row.deploymentBlock),
      `${path}.deploymentBlock`,
    ),
    startBlockSource: row.startBlockSource,
    indexedThrough,
    logCount: required(strictNonNegativeInteger(row.logCount), `${path}.logCount`),
  }
}

function optionalSnapshotAddress(
  value: unknown,
  path: string,
): Address | undefined {
  return value === undefined || value === null ? undefined : required(address(value), path)
}

function optionalSnapshotText(
  value: unknown,
  maxLength: number,
  path: string,
): string | undefined {
  return value === undefined || value === null
    ? undefined
    : required(displayText(value, maxLength), path)
}

function optionalSnapshotNumber(
  value: unknown,
  parse: (input: unknown) => number | null,
  path: string,
): number | undefined {
  return value === undefined || value === null ? undefined : required(parse(value), path)
}

function parseFactoryMarket(
  value: unknown,
  chainId: SupportedChainId,
  factories: readonly FactorySnapshotFactoryV1[],
  path: string,
): FactorySnapshotMarketV1 {
  const row = required(record(value), path)
  exactKeys(
    row,
    [
      'key',
      'chainId',
      'address',
      'pt',
      'factory',
      'factoryGeneration',
      'eventVersion',
      'blockNumber',
      'blockHash',
      'transactionHash',
      'logIndex',
      'scalarRoot',
      'initialAnchor',
      'lnFeeRateRoot',
      'name',
      'expiry',
      'yt',
      'sy',
      'createdAt',
    ],
    path,
  )
  if (row.chainId !== chainId) {
    throw new Error(`Factory market snapshot has mismatched ${path}.chainId`)
  }
  const marketAddress = required(address(row.address), `${path}.address`)
  const key = catalogMarketKey(chainId, marketAddress)
  if (row.key !== key) throw new Error(`Factory market snapshot has mismatched ${path}.key`)

  const factoryAddress = required(address(row.factory), `${path}.factory`)
  const factory = factories.find((candidate) => candidate.address === factoryAddress)
  if (
    factory === undefined ||
    row.factoryGeneration !== factory.generation ||
    row.eventVersion !== factory.eventVersion
  ) {
    throw new Error(`Factory market snapshot has invalid ${path} factory provenance`)
  }
  const scalarRoot = required(text(row.scalarRoot), `${path}.scalarRoot`)
  const initialAnchor = required(text(row.initialAnchor), `${path}.initialAnchor`)
  const lnFeeRateRoot =
    row.lnFeeRateRoot === null
      ? null
      : required(text(row.lnFeeRateRoot), `${path}.lnFeeRateRoot`)
  if (
    !DECIMAL_INTEGER.test(scalarRoot) ||
    !DECIMAL_INTEGER.test(initialAnchor) ||
    (lnFeeRateRoot !== null && !DECIMAL_INTEGER.test(lnFeeRateRoot))
  ) {
    throw new Error(`Factory market snapshot has invalid ${path} event parameters`)
  }
  if ((factory.eventVersion === 'v1') !== (lnFeeRateRoot === null)) {
    throw new Error(`Factory market snapshot has mismatched ${path}.lnFeeRateRoot`)
  }

  return {
    key,
    chainId,
    address: marketAddress,
    pt: required(address(row.pt), `${path}.pt`),
    factory: factoryAddress,
    factoryGeneration: factory.generation,
    eventVersion: factory.eventVersion,
    blockNumber: required(strictNonNegativeInteger(row.blockNumber), `${path}.blockNumber`),
    blockHash: required(hash(row.blockHash), `${path}.blockHash`),
    transactionHash: required(hash(row.transactionHash), `${path}.transactionHash`),
    logIndex: required(strictNonNegativeInteger(row.logIndex), `${path}.logIndex`),
    scalarRoot,
    initialAnchor,
    lnFeeRateRoot,
    name: optionalSnapshotText(row.name, 160, `${path}.name`),
    expiry: optionalSnapshotNumber(row.expiry, strictUnixSeconds, `${path}.expiry`),
    yt: optionalSnapshotAddress(row.yt, `${path}.yt`),
    sy: optionalSnapshotAddress(row.sy, `${path}.sy`),
    createdAt: optionalSnapshotNumber(row.createdAt, strictUnixSeconds, `${path}.createdAt`),
  }
}

function parseFactoryChain(value: unknown, path: string): FactorySnapshotChainV1 {
  const row = required(record(value), path)
  exactKeys(
    row,
    [
      'chainId',
      'complete',
      'indexedThrough',
      'indexedThroughHash',
      'indexedThroughTimestamp',
      'reorgAnchor',
      'factories',
      'marketCount',
      'quarantinedLogCount',
      'errors',
      'markets',
    ],
    path,
  )
  const chainNumber = strictNonNegativeInteger(row.chainId)
  if (chainNumber === null || !isSupportedChainId(chainNumber)) {
    throw new Error(`Factory market snapshot has unsupported ${path}.chainId`)
  }
  if (typeof row.complete !== 'boolean') {
    throw new Error(`Factory market snapshot has invalid ${path}.complete`)
  }
  const indexedThrough =
    row.indexedThrough === null
      ? null
      : required(strictNonNegativeInteger(row.indexedThrough), `${path}.indexedThrough`)
  const indexedThroughHash =
    row.indexedThroughHash === null
      ? null
      : required(hash(row.indexedThroughHash), `${path}.indexedThroughHash`)
  const indexedThroughTimestamp =
    row.indexedThroughTimestamp === undefined || row.indexedThroughTimestamp === null
      ? null
      : required(
          strictUnixSeconds(row.indexedThroughTimestamp),
          `${path}.indexedThroughTimestamp`,
        )
  if ((indexedThrough === null) !== (indexedThroughHash === null)) {
    throw new Error(`Factory market snapshot has inconsistent ${path} indexed head`)
  }
  if (indexedThrough === null && indexedThroughTimestamp !== null) {
    throw new Error(`Factory market snapshot has a timestamp without an indexed ${path} head`)
  }

  let reorgAnchor: FactorySnapshotReorgAnchorV1 | null = null
  if (row.reorgAnchor !== null) {
    const anchor = required(record(row.reorgAnchor), `${path}.reorgAnchor`)
    exactKeys(anchor, ['blockNumber', 'blockHash'], `${path}.reorgAnchor`)
    reorgAnchor = {
      blockNumber: required(
        strictNonNegativeInteger(anchor.blockNumber),
        `${path}.reorgAnchor.blockNumber`,
      ),
      blockHash: required(hash(anchor.blockHash), `${path}.reorgAnchor.blockHash`),
    }
    if (indexedThrough !== null && reorgAnchor.blockNumber > indexedThrough) {
      throw new Error(`Factory market snapshot has future ${path}.reorgAnchor`)
    }
  }

  if (!Array.isArray(row.factories)) {
    throw new Error(`Factory market snapshot has invalid ${path}.factories`)
  }
  const factories = row.factories.map((factory, index) =>
    parseFactoryEntry(factory, chainNumber, `${path}.factories[${index}]`),
  )
  const uniqueFactories = new Set(factories.map((factory) => factory.address))
  if (uniqueFactories.size !== factories.length) {
    throw new Error(`Factory market snapshot has duplicate ${path}.factories`)
  }

  if (!Array.isArray(row.errors) || row.errors.length > MAX_CHAIN_ERRORS) {
    throw new Error(`Factory market snapshot has invalid ${path}.errors`)
  }
  const errors = row.errors.map((error, index) =>
    required(displayText(error, 500), `${path}.errors[${index}]`),
  )
  if (!Array.isArray(row.markets) || row.markets.length > MAX_MARKETS_PER_CHAIN) {
    throw new Error(`Factory market snapshot has invalid ${path}.markets`)
  }
  const markets = row.markets.map((market, index) =>
    parseFactoryMarket(market, chainNumber, factories, `${path}.markets[${index}]`),
  )
  if (new Set(markets.map((market) => market.key)).size !== markets.length) {
    throw new Error(`Factory market snapshot has duplicate ${path}.markets`)
  }
  for (const factory of factories) {
    const parsedLogCount = markets.filter(
      (market) => market.factory === factory.address,
    ).length
    if (factory.logCount !== parsedLogCount) {
      throw new Error(
        `Factory market snapshot has mismatched ${path} factory logCount`,
      )
    }
  }
  if (
    indexedThrough !== null &&
    markets.some((market) => market.blockNumber > indexedThrough)
  ) {
    throw new Error(`Factory market snapshot has a market beyond ${path}.indexedThrough`)
  }
  const marketCount = required(
    strictNonNegativeInteger(row.marketCount),
    `${path}.marketCount`,
  )
  const quarantinedLogCount = required(
    strictNonNegativeInteger(row.quarantinedLogCount),
    `${path}.quarantinedLogCount`,
  )
  if (marketCount !== markets.length) {
    throw new Error(`Factory market snapshot has mismatched ${path}.marketCount`)
  }

  const expectedFactories = addressBookFor(chainNumber).marketFactories.map((factory) =>
    factory.marketFactory.toLowerCase(),
  )
  if (row.complete) {
    if (
      indexedThrough === null ||
      reorgAnchor === null ||
      errors.length > 0 ||
      quarantinedLogCount > 0 ||
      expectedFactories.some((factory) => !uniqueFactories.has(factory as Address)) ||
      factories.some((factory) => factory.indexedThrough !== indexedThrough)
    ) {
      throw new Error(`Factory market snapshot falsely marks ${path} complete`)
    }
  }

  return {
    chainId: chainNumber,
    complete: row.complete,
    indexedThrough,
    indexedThroughHash,
    indexedThroughTimestamp,
    reorgAnchor,
    factories,
    marketCount,
    quarantinedLogCount,
    errors,
    markets,
  }
}

/**
 * Strict, all-or-nothing parser for the versioned factory inventory. Rejecting
 * a corrupt snapshot prevents malformed rows from being mistaken for complete
 * canonical coverage; the caller can safely fall back to Pendle bootstrap.
 */
export function parseFactoryMarketSnapshot(value: unknown): FactoryMarketSnapshotV1 {
  const root = required(record(value), 'root')
  exactKeys(root, ['schemaVersion', 'dataset', 'provenance', 'coverage', 'chains'], 'root')
  if (root.schemaVersion !== FACTORY_MARKET_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported factory market snapshot schema version: ${String(root.schemaVersion)}`)
  }
  if (root.dataset !== FACTORY_MARKET_SNAPSHOT_DATASET) {
    throw new Error('Factory market snapshot has an invalid dataset')
  }
  const provenance = parseProvenance(root.provenance)

  const rawCoverage = required(record(root.coverage), 'coverage')
  exactKeys(
    rawCoverage,
    ['complete', 'completeChains', 'totalChains', 'marketCount', 'quarantinedLogCount'],
    'coverage',
  )
  if (typeof rawCoverage.complete !== 'boolean' || !Array.isArray(rawCoverage.completeChains)) {
    throw new Error('Factory market snapshot has invalid coverage')
  }
  const completeChains = rawCoverage.completeChains.map((value, index) => {
    const id = strictNonNegativeInteger(value)
    if (id === null || !isSupportedChainId(id)) {
      throw new Error(`Factory market snapshot has invalid coverage.completeChains[${index}]`)
    }
    return id
  })
  if (new Set(completeChains).size !== completeChains.length) {
    throw new Error('Factory market snapshot has duplicate coverage.completeChains')
  }
  const coverage: FactorySnapshotCoverageV1 = {
    complete: rawCoverage.complete,
    completeChains,
    totalChains: required(strictNonNegativeInteger(rawCoverage.totalChains), 'coverage.totalChains'),
    marketCount: required(strictNonNegativeInteger(rawCoverage.marketCount), 'coverage.marketCount'),
    quarantinedLogCount: required(
      strictNonNegativeInteger(rawCoverage.quarantinedLogCount),
      'coverage.quarantinedLogCount',
    ),
  }

  if (!Array.isArray(root.chains) || root.chains.length !== SUPPORTED_CHAINS.length) {
    throw new Error('Factory market snapshot has invalid chains')
  }
  const chains = root.chains.map((chain, index) => parseFactoryChain(chain, `chains[${index}]`))
  if (new Set(chains.map((chain) => chain.chainId)).size !== chains.length) {
    throw new Error('Factory market snapshot has duplicate chains')
  }
  if (SUPPORTED_CHAINS.some((supported) => !chains.some((chain) => chain.chainId === supported.id))) {
    throw new Error('Factory market snapshot is missing a configured chain')
  }

  const derivedCompleteChains = chains
    .filter((chain) => chain.complete)
    .map((chain) => chain.chainId)
    .sort((a, b) => a - b)
  const statedCompleteChains = [...completeChains].sort((a, b) => a - b)
  const derivedMarketCount = chains.reduce((total, chain) => total + chain.marketCount, 0)
  const derivedQuarantined = chains.reduce(
    (total, chain) => total + chain.quarantinedLogCount,
    0,
  )
  const allConfiguredChainsComplete = SUPPORTED_CHAINS.every((supported) =>
    derivedCompleteChains.includes(supported.id),
  )
  if (
    coverage.totalChains !== chains.length ||
    coverage.marketCount !== derivedMarketCount ||
    coverage.quarantinedLogCount !== derivedQuarantined ||
    statedCompleteChains.join(',') !== derivedCompleteChains.join(',') ||
    coverage.complete !== allConfiguredChainsComplete
  ) {
    throw new Error('Factory market snapshot has inconsistent aggregate coverage')
  }

  return {
    schemaVersion: FACTORY_MARKET_SNAPSHOT_SCHEMA_VERSION,
    dataset: FACTORY_MARKET_SNAPSHOT_DATASET,
    provenance,
    coverage,
    chains,
  }
}

interface CatalogPage {
  rows: unknown[]
  total: number | null
}

function parsePage(value: unknown): CatalogPage | null {
  if (Array.isArray(value)) return { rows: value, total: null }
  const body = record(value)
  if (body === null) return null
  const rows = Array.isArray(body.results)
    ? body.results
    : Array.isArray(body.markets)
      ? body.markets
      : null
  if (rows === null) return null
  return { rows, total: nonNegativeNumber(body.total) }
}

function requestUrl(endpoint: string): URL {
  const browserLocation = globalThis.location?.href
  return new URL(endpoint, browserLocation ?? 'http://localhost/')
}

async function fetchJsonWithTimeout(
  fetcher: CatalogFetch,
  url: URL,
  init: RequestInit,
  outerSignal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<{ response: Response; body: unknown }> {
  if (outerSignal?.aborted) {
    throw outerSignal.reason ?? new Error(`${label} request was aborted`)
  }

  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let onOuterAbort: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    const fail = (reason: unknown): void => {
      controller.abort(reason)
      reject(reason)
    }
    timeoutId = setTimeout(() => fail(new Error(`${label} request timed out`)), timeoutMs)
    if (outerSignal !== undefined) {
      onOuterAbort = () => fail(outerSignal.reason ?? new Error(`${label} request was aborted`))
      outerSignal.addEventListener('abort', onOuterAbort, { once: true })
    }
  })

  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { ...init, signal: controller.signal })
        const body = response.ok && response.status !== 204 ? await response.json() : null
        return { response, body }
      })(),
      deadline,
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (onOuterAbort !== undefined) outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

async function fetchStatusPages(
  pendleStatus: Exclude<PendleListingStatus, null>,
  fetcher: CatalogFetch,
  endpoint: string,
  signal: AbortSignal | undefined,
  requestTimeoutMs: number,
): Promise<unknown[]> {
  const allRows: unknown[] = []
  let skip = 0
  const isActive = pendleStatus === 'active'

  for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_STATUS; pageNumber += 1) {
    const url = requestUrl(endpoint)
    url.searchParams.set('isActive', String(isActive))
    url.searchParams.set('limit', String(PENDLE_MARKET_CATALOG_PAGE_SIZE))
    url.searchParams.set('skip', String(skip))

    const { response, body } = await fetchJsonWithTimeout(
      fetcher,
      url,
      { headers: { accept: 'application/json' } },
      signal,
      requestTimeoutMs,
      `Pendle ${pendleStatus} market catalog`,
    )
    if (!response.ok) {
      throw new Error(`Pendle ${pendleStatus} market catalog request failed (${response.status})`)
    }

    const page = parsePage(body)
    if (page === null) {
      throw new Error(`Pendle ${pendleStatus} market catalog returned an invalid response`)
    }
    allRows.push(...page.rows)

    const nextSkip = skip + page.rows.length
    if (page.rows.length === 0 && page.total !== null && skip < page.total) {
      throw new Error(
        `Pendle ${pendleStatus} market catalog returned an empty page before its reported total`,
      )
    }
    if (
      page.rows.length === 0 ||
      (page.total !== null
        ? nextSkip >= page.total
        : page.rows.length < PENDLE_MARKET_CATALOG_PAGE_SIZE)
    ) {
      return allRows
    }
    skip = nextSkip
  }

  throw new Error(`Pendle ${pendleStatus} market catalog exceeded the pagination safety limit`)
}

/** Fetch and validate the canonical v1 factory inventory. A 404/204 means not published yet. */
export async function fetchFactoryMarketSnapshot(
  options: FetchFactoryMarketSnapshotOptions = {},
): Promise<FactoryMarketSnapshotV1 | null> {
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation is available')
  const requestTimeoutMs = normalizeTimeout(options.requestTimeoutMs)
  const { response, body } = await fetchJsonWithTimeout(
    fetcher,
    requestUrl(options.endpoint ?? FACTORY_MARKET_SNAPSHOT_ENDPOINT),
    { headers: { accept: 'application/json' } },
    options.signal,
    requestTimeoutMs,
    'Factory market snapshot',
  )
  if (response.status === 404 || response.status === 204) return null
  if (!response.ok) throw new Error(`Factory market snapshot request failed (${response.status})`)
  return parseFactoryMarketSnapshot(body)
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : MARKET_CATALOG_REQUEST_TIMEOUT_MS
}

function mergePendleRows(
  existing: CatalogMarket,
  incoming: CatalogMarket,
  now: number,
): CatalogMarket {
  const preferred = incoming.pendleStatus === 'active' && existing.pendleStatus !== 'active'
    ? incoming
    : existing
  const fallback = preferred === existing ? incoming : existing
  const expiry = preferred.expiry ?? fallback.expiry
  return {
    ...preferred,
    name: preferred.name !== 'Pendle market' ? preferred.name : fallback.name,
    protocol: preferred.protocol ?? fallback.protocol,
    expiry,
    pt: preferred.pt ?? fallback.pt,
    yt: preferred.yt ?? fallback.yt,
    sy: preferred.sy ?? fallback.sy,
    icon: preferred.icon ?? fallback.icon,
    tvl: preferred.tvl ?? fallback.tvl,
    impliedApy: preferred.impliedApy ?? fallback.impliedApy,
    createdAt: preferred.createdAt ?? fallback.createdAt,
    lifecycle: catalogMarketLifecycle(expiry, now),
    pendleStatus:
      existing.pendleStatus === 'active' || incoming.pendleStatus === 'active'
        ? 'active'
        : 'inactive',
  }
}

function factoryCatalogMarket(
  market: FactorySnapshotMarketV1,
  now: number,
): CatalogMarket {
  const expiry = market.expiry ?? null
  return {
    key: market.key,
    chainId: market.chainId,
    address: market.address,
    name: market.name ?? 'Permissionless Pendle market',
    protocol: null,
    expiry,
    pt: market.pt,
    yt: market.yt ?? null,
    sy: market.sy ?? null,
    icon: null,
    tvl: null,
    impliedApy: null,
    createdAt: market.createdAt ?? null,
    lifecycle: catalogMarketLifecycle(expiry, now),
    pendleStatus: null,
    sources: ['factory-indexed'],
  }
}

function enrichFactoryMarket(
  factory: CatalogMarket,
  pendle: CatalogMarket,
  now: number,
): CatalogMarket {
  const expiry = factory.expiry ?? pendle.expiry
  return {
    ...factory,
    name: pendle.name !== 'Pendle market' ? pendle.name : factory.name,
    protocol: pendle.protocol ?? factory.protocol,
    expiry,
    pt: factory.pt ?? pendle.pt,
    yt: factory.yt ?? pendle.yt,
    sy: factory.sy ?? pendle.sy,
    icon: pendle.icon ?? factory.icon,
    tvl: pendle.tvl ?? factory.tvl,
    impliedApy: pendle.impliedApy ?? factory.impliedApy,
    createdAt: factory.createdAt ?? pendle.createdAt,
    lifecycle: catalogMarketLifecycle(expiry, now),
    pendleStatus: pendle.pendleStatus,
    sources: ['factory-indexed', 'pendle-listed'],
  }
}

function sortMarkets(a: CatalogMarket, b: CatalogMarket): number {
  const lifecycleRank = { live: 0, unknown: 1, matured: 2 } as const
  const lifecycleDifference = lifecycleRank[a.lifecycle] - lifecycleRank[b.lifecycle]
  if (lifecycleDifference !== 0) return lifecycleDifference
  if (a.chainId !== b.chainId) return a.chainId - b.chainId
  const expiryDifference =
    (a.expiry ?? Number.MAX_SAFE_INTEGER) - (b.expiry ?? Number.MAX_SAFE_INTEGER)
  if (expiryDifference !== 0) return expiryDifference
  return a.name.localeCompare(b.name) || a.address.localeCompare(b.address)
}

/**
 * Pure merge of canonical factory membership and Pendle enrichment. On a
 * complete factory-covered chain, Pendle-only rows cannot assert membership.
 * Missing/incomplete chains admit listed rows as an explicit bootstrap.
 */
export function buildMarketCatalog({
  factorySnapshot,
  pendleMarkets,
  pendleCoverage,
  factoryRequestError = null,
  now = Math.floor(Date.now() / 1_000),
}: BuildMarketCatalogOptions): MarketCatalog {
  const listedByKey = new Map<string, CatalogMarket>()
  for (const market of pendleMarkets) {
    const existing = listedByKey.get(market.key)
    listedByKey.set(
      market.key,
      existing === undefined ? market : mergePendleRows(existing, market, now),
    )
  }

  const keyed = new Map<string, CatalogMarket>()
  const completeChains = new Set<SupportedChainId>()
  if (factorySnapshot !== null) {
    for (const chain of factorySnapshot.chains) {
      if (chain.complete) completeChains.add(chain.chainId)
      for (const entry of chain.markets) {
        const factoryMarket = factoryCatalogMarket(entry, now)
        const enrichment = listedByKey.get(entry.key)
        keyed.set(
          entry.key,
          enrichment === undefined
            ? factoryMarket
            : enrichFactoryMarket(factoryMarket, enrichment, now),
        )
      }
    }
  }

  for (const market of listedByKey.values()) {
    if (keyed.has(market.key)) continue
    // A complete chain's factory inventory is canonical. An unavailable or
    // incomplete chain may use Pendle rows, but coverage remains incomplete.
    if (factorySnapshot !== null && completeChains.has(market.chainId)) continue
    keyed.set(market.key, market)
  }

  const markets = [...keyed.values()].sort(sortMarkets)
  const byKey: Record<string, CatalogMarket> = {}
  for (const market of markets) byKey[market.key] = market

  const indexedChains =
    factorySnapshot?.chains
      .filter((chain) => chain.indexedThrough !== null)
      .map((chain) => chain.chainId) ?? []
  const indexedAt: Partial<Record<SupportedChainId, number>> = {}
  for (const chain of factorySnapshot?.chains ?? []) {
    if (chain.indexedThroughTimestamp !== null) {
      indexedAt[chain.chainId] = chain.indexedThroughTimestamp
    }
  }
  const canonicalComplete = factorySnapshot?.coverage.complete === true
  const membership: CatalogMembershipCoverage = canonicalComplete
    ? 'complete'
    : factorySnapshot === null
      ? 'bootstrap'
      : 'partial'
  const errors: Partial<Record<SupportedChainId, string[]>> = {}
  for (const chain of factorySnapshot?.chains ?? []) {
    if (chain.errors.length > 0) errors[chain.chainId] = [...chain.errors]
  }

  return {
    markets,
    byKey,
    coverage: {
      complete: canonicalComplete,
      membership,
      pendle: { ...pendleCoverage },
      factory: {
        status: canonicalComplete
          ? 'complete'
          : factorySnapshot === null
            ? 'unavailable'
            : 'partial',
        indexedChains,
        completeChains: factorySnapshot?.coverage.completeChains ?? [],
        totalChains: factorySnapshot?.coverage.totalChains ?? 0,
        marketCount: factorySnapshot?.coverage.marketCount ?? 0,
        quarantinedLogCount: factorySnapshot?.coverage.quarantinedLogCount ?? 0,
        indexedAt,
        errors,
        requestError: factoryRequestError,
      },
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Load factory inventory plus active/inactive Pendle enrichment. Every source
 * fails independently. The function throws only when no usable membership
 * source remains, allowing query retry without turning partial data into a
 * false empty catalog.
 */
export async function fetchMarketCatalog(
  options: FetchMarketCatalogOptions = {},
): Promise<MarketCatalog> {
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation is available')
  const requestTimeoutMs = normalizeTimeout(options.requestTimeoutMs)
  const pendleEndpoint = options.pendleEndpoint ?? PENDLE_MARKET_CATALOG_ENDPOINT
  const factoryEndpoint =
    options.factorySnapshotEndpoint === undefined
      ? FACTORY_MARKET_SNAPSHOT_ENDPOINT
      : options.factorySnapshotEndpoint

  const factoryPromise = factoryEndpoint === null
    ? Promise.resolve(FACTORY_SNAPSHOT_NOT_FOUND)
    : fetchFactoryMarketSnapshot({
        fetcher,
        signal: options.signal,
        endpoint: factoryEndpoint,
        requestTimeoutMs,
      }).then((snapshot) => snapshot ?? FACTORY_SNAPSHOT_NOT_FOUND)

  const [factoryResult, activeResult, inactiveResult] = await Promise.allSettled([
    factoryPromise,
    fetchStatusPages('active', fetcher, pendleEndpoint, options.signal, requestTimeoutMs),
    fetchStatusPages('inactive', fetcher, pendleEndpoint, options.signal, requestTimeoutMs),
  ])

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('Market catalog request was aborted')
  }

  const factorySnapshot =
    factoryResult.status === 'fulfilled' && factoryResult.value !== FACTORY_SNAPSHOT_NOT_FOUND
      ? factoryResult.value
      : null
  if (
    factorySnapshot === null &&
    activeResult.status === 'rejected' &&
    inactiveResult.status === 'rejected'
  ) {
    const reasons = [activeResult.reason, inactiveResult.reason]
    if (factoryResult.status === 'rejected') reasons.unshift(factoryResult.reason)
    throw new AggregateError(reasons, 'Market catalog could not be loaded')
  }

  const pendleMarkets: CatalogMarket[] = []
  const addPendleRows = (
    rows: unknown[],
    status: Exclude<PendleListingStatus, null>,
  ): void => {
    for (const row of rows) {
      const market = normalizeCatalogMarket(row, status)
      if (market !== null) pendleMarkets.push(market)
    }
  }
  if (activeResult.status === 'fulfilled') addPendleRows(activeResult.value, 'active')
  if (inactiveResult.status === 'fulfilled') addPendleRows(inactiveResult.value, 'inactive')

  return buildMarketCatalog({
    factorySnapshot,
    pendleMarkets,
    pendleCoverage: {
      active: activeResult.status === 'fulfilled',
      inactive: inactiveResult.status === 'fulfilled',
    },
    factoryRequestError:
      factoryResult.status === 'rejected' ? errorMessage(factoryResult.reason) : null,
  })
}
