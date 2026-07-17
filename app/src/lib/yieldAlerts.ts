/**
 * Read-only 24-hour Pendle market-implied-APY movers.
 *
 * The active Pendle catalog discovers listed candidates and applies a current
 * liquidity gate before the historical requests. Final eligibility also
 * requires every hourly pool-liquidity (`tvl`) observation in one exact,
 * UTC-aligned 24-hour window to pass. Total TVL is deliberately never used as
 * a liquidity substitute.
 */

import type { Address } from 'viem'
import { isSupportedChainId } from './addresses.ts'
import type { SupportedChainId } from './types.ts'

export const YIELD_ALERTS_MARKETS_ENDPOINT =
  'https://api-v2.pendle.finance/core/v2/markets/all'
export const YIELD_ALERTS_HISTORY_ENDPOINT_BASE =
  'https://api-v2.pendle.finance/core/v3'
export const YIELD_ALERTS_MIN_LIQUIDITY_USD = 1_000_000
export const YIELD_ALERTS_WINDOW_HOURS = 24
export const YIELD_ALERTS_HISTORY_POINT_COUNT = YIELD_ALERTS_WINDOW_HOURS + 1
export const YIELD_ALERTS_INGESTION_BUFFER_MS = 15 * 60_000
export const YIELD_ALERTS_PAGE_SIZE = 100
export const YIELD_ALERTS_CONCURRENCY = 4
export const YIELD_ALERTS_REQUEST_TIMEOUT_MS = 20_000
export const YIELD_ALERTS_MAX_RETRIES = 1
export const YIELD_ALERTS_RETRY_DELAY_MS = 500

const HOUR_MS = 60 * 60_000
const HOUR_SECONDS = HOUR_MS / 1_000
const NEAR_EXPIRY_SECONDS = 72 * HOUR_SECONDS
const MATERIAL_BPS = 50
const MATERIAL_RELATIVE_CHANGE = 0.1
const MAX_CATALOG_PAGES = 1_000
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DISPLAY_CONTROL_CHARACTERS =
  /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu
const MIN_PLAUSIBLE_UNIX_SECONDS = Date.UTC(2020, 0, 1) / 1_000
const MAX_PLAUSIBLE_UNIX_SECONDS = Date.UTC(2200, 0, 1) / 1_000

export type YieldAlertMarketKey = `${SupportedChainId}:${Address}`
export type YieldAlertDirection = 'increase' | 'decrease' | 'unchanged'
export type YieldAlertsFetch = typeof fetch

export interface YieldAlertsWindow {
  windowStart: string
  windowEnd: string
}

export interface YieldAlertMarket {
  key: YieldAlertMarketKey
  chainId: SupportedChainId
  address: Address
  name: string
  protocol: string | null
  /** ISO-8601 UTC timestamp. */
  expiry: string
  /** Current AMM liquidity from `details.liquidity`; used only as a prefilter. */
  currentLiquidity: number
}

export interface YieldAlertHistoryPoint {
  timestamp: string
  /** Decimal APY: 0.05 means 5%. */
  impliedApy: number
  /** Pendle AMM pool liquidity in USD. */
  tvl: number
  /** Informational only; never used for the liquidity threshold. */
  totalTvl: number | null
}

export interface YieldAlert extends YieldAlertMarket {
  /** Minimum hourly pool liquidity across the exact 24-hour window. */
  liquidity: number
  startApy: number
  endApy: number
  /** Signed APY change in basis points. */
  deltaBps: number
  /** Signed fraction relative to start APY, or null when start APY is non-positive. */
  relativeChange: number | null
  direction: YieldAlertDirection
  nearExpiry: boolean
  material: boolean
}

export interface YieldAlertFailure {
  key: YieldAlertMarketKey
  chainId: SupportedChainId
  address: Address
  name: string
  message: string
}

export interface YieldAlertsResult extends YieldAlertsWindow {
  /** Raw rows received across every active-catalog page. */
  marketsScanned: number
  /** Markets that passed both the current and full-window liquidity gates. */
  marketsEligible: number
  /** Markets above the current-liquidity prefilter before history requests. */
  candidateMarkets: number
  /** Complete, schema-valid 25-point histories, including those below the gate. */
  successfulHistories: number
  /** Complete histories excluded because one or more hourly TVLs were below the gate. */
  excludedForLiquidity: number
  invalidMarkets: number
  unsupportedMarkets: number
  failedHistories: YieldAlertFailure[]
  alerts: YieldAlert[]
}

export interface FetchYieldAlertsOptions {
  fetcher?: YieldAlertsFetch
  signal?: AbortSignal
  /** Deterministic clock injection. Defaults to the time the fetch begins. */
  now?: Date
  marketsEndpoint?: string
  historyEndpointBase?: string
  minLiquidityUsd?: number
  concurrency?: number
  requestTimeoutMs?: number
  pageSize?: number
  maxRetries?: number
  retryDelayMs?: number
}

/** Error used when candidates exist but not one history could be validated. */
export class YieldAlertsUnavailableError extends Error {
  readonly failures: YieldAlertFailure[]

  constructor(message: string, failures: YieldAlertFailure[]) {
    super(message)
    this.name = 'YieldAlertsUnavailableError'
    this.failures = failures
  }
}

interface CatalogPage {
  rows: unknown[]
  total: number | null
}

interface CatalogLoad {
  rows: unknown[]
}

interface HistorySuccess {
  ok: true
  alert: YieldAlert | null
}

interface HistoryFailure {
  ok: false
  failure: YieldAlertFailure
}

interface RequestSettings {
  fetcher: YieldAlertsFetch
  signal: AbortSignal | undefined
  requestTimeoutMs: number
  maxRetries: number
  retryDelayMs: number
}

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

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
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
  if (!Number.isFinite(milliseconds) || milliseconds % 1_000 !== 0) return null
  const seconds = milliseconds / 1_000
  return seconds >= MIN_PLAUSIBLE_UNIX_SECONDS && seconds <= MAX_PLAUSIBLE_UNIX_SECONDS
    ? seconds
    : null
}

function address(value: unknown): Address | null {
  const raw = text(value)
  return raw !== null && HEX_ADDRESS.test(raw) && BigInt(raw) !== 0n
    ? (raw.toLowerCase() as Address)
    : null
}

function marketKey(
  chainId: SupportedChainId,
  marketAddress: Address,
): YieldAlertMarketKey {
  return `${chainId}:${marketAddress.toLowerCase()}` as YieldAlertMarketKey
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1_000).toISOString()
}

function windowSeconds(window: YieldAlertsWindow): { start: number; end: number } {
  const start = unixSeconds(window.windowStart)
  const end = unixSeconds(window.windowEnd)
  if (
    start === null ||
    end === null ||
    start % HOUR_SECONDS !== 0 ||
    end % HOUR_SECONDS !== 0 ||
    end - start !== YIELD_ALERTS_WINDOW_HOURS * HOUR_SECONDS
  ) {
    throw new Error('Yield alerts window must be an exact UTC-aligned 24-hour interval')
  }
  return { start, end }
}

/**
 * Exact UTC-hour window, advanced only 15 minutes after a new hour begins so
 * Pendle's just-opened history bucket has time to appear.
 */
export function yieldAlertsWindow(now: Date = new Date()): YieldAlertsWindow {
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new Error('Yield alerts clock is invalid')
  const endMs = Math.floor(
    (nowMs - YIELD_ALERTS_INGESTION_BUFFER_MS) / HOUR_MS,
  ) * HOUR_MS
  const startMs = endMs - YIELD_ALERTS_WINDOW_HOURS * HOUR_MS
  return {
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
  }
}

/** Normalize one untrusted active-market row. */
export function normalizeYieldAlertMarket(
  value: unknown,
  windowEnd: string,
): YieldAlertMarket | null {
  const row = record(value)
  if (row === null) return null

  const chainNumber = finiteNumber(row.chainId)
  if (
    chainNumber === null ||
    !Number.isInteger(chainNumber) ||
    !isSupportedChainId(chainNumber)
  ) {
    return null
  }
  const chainId = chainNumber
  const marketAddress = address(row.address)
  if (marketAddress === null) return null

  const end = unixSeconds(windowEnd)
  const expiry = unixSeconds(row.expiry)
  if (end === null || expiry === null || expiry <= end) return null

  const details = record(row.details)
  const currentLiquidity = nonNegativeNumber(details?.liquidity)
  if (currentLiquidity === null) return null

  return {
    key: marketKey(chainId, marketAddress),
    chainId,
    address: marketAddress,
    name: displayText(row.name, 160) ?? 'Pendle market',
    protocol: displayText(row.protocol, 120),
    expiry: isoFromSeconds(expiry),
    currentLiquidity,
  }
}

/**
 * Parse one history response and require all 25 distinct hourly observations,
 * including the exact requested endpoints. Results may arrive out of order.
 */
export function parseYieldAlertHistory(
  value: unknown,
  window: YieldAlertsWindow,
): YieldAlertHistoryPoint[] {
  const { start, end } = windowSeconds(window)
  const body = record(value)
  if (body === null) throw new Error('Pendle market history returned an invalid response')

  const responseStart = unixSeconds(body.timestamp_start)
  const responseEnd = unixSeconds(body.timestamp_end)
  if (responseStart !== start || responseEnd !== end) {
    throw new Error('Pendle market history returned a different time window')
  }

  if (nonNegativeInteger(body.total) !== YIELD_ALERTS_HISTORY_POINT_COUNT) {
    throw new Error(
      `Pendle market history must report exactly ${YIELD_ALERTS_HISTORY_POINT_COUNT} points`,
    )
  }
  if (
    !Array.isArray(body.results) ||
    body.results.length !== YIELD_ALERTS_HISTORY_POINT_COUNT
  ) {
    throw new Error(
      `Pendle market history must contain exactly ${YIELD_ALERTS_HISTORY_POINT_COUNT} points`,
    )
  }

  const byTimestamp = new Map<number, YieldAlertHistoryPoint>()
  for (const rawPoint of body.results) {
    const point = record(rawPoint)
    if (point === null) throw new Error('Pendle market history contains an invalid point')
    const timestamp = unixSeconds(point.timestamp)
    const impliedApy = finiteNumber(point.impliedApy)
    const tvl = nonNegativeNumber(point.tvl)
    const totalTvl = point.totalTvl === null || point.totalTvl === undefined
      ? null
      : nonNegativeNumber(point.totalTvl)
    if (
      timestamp === null ||
      timestamp < start ||
      timestamp > end ||
      timestamp % HOUR_SECONDS !== 0 ||
      impliedApy === null ||
      tvl === null ||
      (point.totalTvl !== null && point.totalTvl !== undefined && totalTvl === null)
    ) {
      throw new Error('Pendle market history contains malformed point data')
    }
    if (byTimestamp.has(timestamp)) {
      throw new Error('Pendle market history contains a duplicate hourly observation')
    }
    byTimestamp.set(timestamp, {
      timestamp: isoFromSeconds(timestamp),
      impliedApy,
      tvl,
      totalTvl,
    })
  }

  const points: YieldAlertHistoryPoint[] = []
  for (let index = 0; index < YIELD_ALERTS_HISTORY_POINT_COUNT; index += 1) {
    const expectedTimestamp = start + index * HOUR_SECONDS
    const point = byTimestamp.get(expectedTimestamp)
    if (point === undefined) {
      throw new Error('Pendle market history is missing an hourly observation')
    }
    points.push(point)
  }
  return points
}

/** Return null when an otherwise complete history fails the hourly liquidity gate. */
export function calculateYieldAlert(
  market: YieldAlertMarket,
  history: readonly YieldAlertHistoryPoint[],
  window: YieldAlertsWindow,
  minLiquidityUsd = YIELD_ALERTS_MIN_LIQUIDITY_USD,
): YieldAlert | null {
  if (history.length !== YIELD_ALERTS_HISTORY_POINT_COUNT) {
    throw new Error('A yield alert requires one complete 25-point history')
  }
  const threshold = positiveOrZero(minLiquidityUsd, 'minimum liquidity')
  const liquidity = Math.min(...history.map((point) => point.tvl))
  if (liquidity < threshold) return null

  const startApy = history[0].impliedApy
  const endApy = history[history.length - 1].impliedApy
  const deltaApy = endApy - startApy
  const rawDeltaBps = deltaApy * 10_000
  const deltaBps = Math.abs(rawDeltaBps) < 1e-12 ? 0 : rawDeltaBps
  const relativeChange = startApy > 0 ? deltaApy / startApy : null
  const direction: YieldAlertDirection = deltaBps > 0
    ? 'increase'
    : deltaBps < 0
      ? 'decrease'
      : 'unchanged'
  const { end } = windowSeconds(window)
  const expiry = unixSeconds(market.expiry)
  if (expiry === null || expiry <= end) {
    throw new Error('Yield alert market expiry is invalid for the requested window')
  }
  const nearExpiry = expiry - end <= NEAR_EXPIRY_SECONDS
  const material =
    !nearExpiry &&
    Math.abs(deltaBps) + 1e-9 >= MATERIAL_BPS &&
    relativeChange !== null &&
    Math.abs(relativeChange) + 1e-12 >= MATERIAL_RELATIVE_CHANGE

  return {
    ...market,
    liquidity,
    startApy,
    endApy,
    deltaBps,
    relativeChange,
    direction,
    nearExpiry,
    material,
  }
}

function parseCatalogPage(value: unknown, pageSize: number): CatalogPage {
  const body = record(value)
  if (body === null || !Array.isArray(body.results)) {
    throw new Error('Pendle active market catalog returned an invalid response')
  }
  if (body.results.length > pageSize) {
    throw new Error('Pendle active market catalog returned an oversized page')
  }
  const total = body.total === undefined || body.total === null
    ? null
    : nonNegativeInteger(body.total)
  if (body.total !== undefined && body.total !== null && total === null) {
    throw new Error('Pendle active market catalog returned an invalid total')
  }
  return { rows: body.results, total }
}

function requestUrl(endpoint: string): URL {
  const browserLocation = globalThis.location?.href
  try {
    return new URL(endpoint, browserLocation ?? 'http://localhost/')
  } catch {
    throw new Error('Yield alerts endpoint is invalid')
  }
}

async function fetchJsonAttempt(
  settings: RequestSettings,
  url: URL,
  label: string,
): Promise<{ response: Response; body: unknown }> {
  if (settings.signal?.aborted) {
    throw settings.signal.reason ?? new Error(`${label} request was aborted`)
  }

  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let onOuterAbort: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    const fail = (reason: unknown): void => {
      controller.abort(reason)
      reject(reason)
    }
    timeoutId = setTimeout(
      () => fail(new Error(`${label} request timed out`)),
      settings.requestTimeoutMs,
    )
    if (settings.signal !== undefined) {
      onOuterAbort = () => fail(
        settings.signal?.reason ?? new Error(`${label} request was aborted`),
      )
      settings.signal.addEventListener('abort', onOuterAbort, { once: true })
    }
  })

  try {
    return await Promise.race([
      (async () => {
        const response = await settings.fetcher(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'omit',
          signal: controller.signal,
        })
        const body = response.ok && response.status !== 204
          ? await response.json()
          : null
        return { response, body }
      })(),
      deadline,
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (onOuterAbort !== undefined) {
      settings.signal?.removeEventListener('abort', onOuterAbort)
    }
  }
}

function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('Yield alerts request was aborted')
  if (milliseconds <= 0) return
  await new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout>
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      clearTimeout(timeoutId)
      cleanup()
      reject(signal?.reason ?? new Error('Yield alerts request was aborted'))
    }
    timeoutId = setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function requestJson(
  settings: RequestSettings,
  url: URL,
  label: string,
): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
    let result: { response: Response; body: unknown }
    try {
      result = await fetchJsonAttempt(settings, url, label)
    } catch (error) {
      if (settings.signal?.aborted) throw settings.signal.reason ?? error
      lastError = error
      if (attempt === settings.maxRetries) throw error
      await abortableDelay(settings.retryDelayMs * 2 ** attempt, settings.signal)
      continue
    }
    if (result.response.ok) return result.body
    const error = new Error(`${label} request failed (${result.response.status})`)
    if (!retryableStatus(result.response.status) || attempt === settings.maxRetries) throw error
    lastError = error
    await abortableDelay(settings.retryDelayMs * 2 ** attempt, settings.signal)
  }
  throw lastError ?? new Error(`${label} request failed`)
}

async function fetchActiveCatalog(
  settings: RequestSettings,
  endpoint: string,
  pageSize: number,
): Promise<CatalogLoad> {
  const rows: unknown[] = []
  let skip = 0
  for (let pageNumber = 0; pageNumber < MAX_CATALOG_PAGES; pageNumber += 1) {
    const url = requestUrl(endpoint)
    url.searchParams.set('isActive', 'true')
    url.searchParams.set('limit', String(pageSize))
    url.searchParams.set('skip', String(skip))
    const body = await requestJson(settings, url, 'Pendle active market catalog')
    const page = parseCatalogPage(body, pageSize)
    rows.push(...page.rows)

    const nextSkip = skip + page.rows.length
    if (page.rows.length === 0 && page.total !== null && skip < page.total) {
      throw new Error(
        'Pendle active market catalog returned an empty page before its reported total',
      )
    }
    if (
      page.rows.length === 0 ||
      (page.total !== null ? nextSkip >= page.total : page.rows.length < pageSize)
    ) {
      return { rows }
    }
    skip = nextSkip
  }
  throw new Error('Pendle active market catalog exceeded the pagination safety limit')
}

function historyUrl(
  endpointBase: string,
  market: YieldAlertMarket,
  window: YieldAlertsWindow,
): URL {
  const base = endpointBase.endsWith('/') ? endpointBase.slice(0, -1) : endpointBase
  const url = requestUrl(
    `${base}/${market.chainId}/markets/${market.address}/historical-data`,
  )
  url.searchParams.set('time_frame', 'hour')
  url.searchParams.set('timestamp_start', window.windowStart)
  url.searchParams.set('timestamp_end', window.windowEnd)
  url.searchParams.set('fields', 'timestamp,impliedApy,tvl,totalTvl')
  return url
}

async function boundedMap<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return []
  const results = new Array<U>(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(items[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'The market history could not be loaded.'
  return displayText(message, 300) ?? 'The market history could not be loaded.'
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`Yield alerts ${label} must be a positive integer`)
  }
  return resolved
}

function nonNegativeIntegerOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`Yield alerts ${label} must be a non-negative integer`)
  }
  return resolved
}

function positiveOrZero(value: number | undefined, label: string): number {
  const resolved = value ?? YIELD_ALERTS_MIN_LIQUIDITY_USD
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`Yield alerts ${label} must be a non-negative number`)
  }
  return resolved
}

function rawChainClassification(value: unknown): 'supported' | 'unsupported' | 'invalid' {
  const row = record(value)
  const chainNumber = finiteNumber(row?.chainId)
  if (chainNumber === null || !Number.isInteger(chainNumber)) return 'invalid'
  return isSupportedChainId(chainNumber) ? 'supported' : 'unsupported'
}

/** Fetch, validate, and rank one exact 24-hour set of yield movers. */
export async function fetchYieldAlerts(
  options: FetchYieldAlertsOptions = {},
): Promise<YieldAlertsResult> {
  // Window.fetch requires its receiver in some browsers. Keep the injectable
  // fetcher untouched, but call the platform default through a bound wrapper.
  const fetcher: YieldAlertsFetch = options.fetcher ?? ((input, init) =>
    globalThis.fetch(input, init))
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation is available')
  const window = yieldAlertsWindow(options.now ?? new Date())
  const minLiquidityUsd = positiveOrZero(options.minLiquidityUsd, 'minimum liquidity')
  const concurrency = positiveInteger(
    options.concurrency,
    YIELD_ALERTS_CONCURRENCY,
    'concurrency',
  )
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs,
    YIELD_ALERTS_REQUEST_TIMEOUT_MS,
    'request timeout',
  )
  const pageSize = positiveInteger(options.pageSize, YIELD_ALERTS_PAGE_SIZE, 'page size')
  const maxRetries = nonNegativeIntegerOption(
    options.maxRetries,
    YIELD_ALERTS_MAX_RETRIES,
    'retry count',
  )
  const retryDelayMs = nonNegativeIntegerOption(
    options.retryDelayMs,
    YIELD_ALERTS_RETRY_DELAY_MS,
    'retry delay',
  )
  const settings: RequestSettings = {
    fetcher,
    signal: options.signal,
    requestTimeoutMs,
    maxRetries,
    retryDelayMs,
  }

  const catalog = await fetchActiveCatalog(
    settings,
    options.marketsEndpoint ?? YIELD_ALERTS_MARKETS_ENDPOINT,
    pageSize,
  )

  let invalidMarkets = 0
  let unsupportedMarkets = 0
  const marketsByKey = new Map<YieldAlertMarketKey, YieldAlertMarket>()
  for (const rawMarket of catalog.rows) {
    const chainClassification = rawChainClassification(rawMarket)
    if (chainClassification === 'unsupported') {
      unsupportedMarkets += 1
      continue
    }
    const market = normalizeYieldAlertMarket(rawMarket, window.windowEnd)
    if (market === null || marketsByKey.has(market.key)) {
      invalidMarkets += 1
      continue
    }
    marketsByKey.set(market.key, market)
  }

  const candidates = [...marketsByKey.values()].filter(
    (market) => market.currentLiquidity >= minLiquidityUsd,
  )
  const outcomes = await boundedMap(candidates, concurrency, async (market) => {
    try {
      const body = await requestJson(
        settings,
        historyUrl(
          options.historyEndpointBase ?? YIELD_ALERTS_HISTORY_ENDPOINT_BASE,
          market,
          window,
        ),
        `${market.name} history`,
      )
      const history = parseYieldAlertHistory(body, window)
      return {
        ok: true,
        alert: calculateYieldAlert(market, history, window, minLiquidityUsd),
      } satisfies HistorySuccess
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error
      return {
        ok: false,
        failure: {
          key: market.key,
          chainId: market.chainId,
          address: market.address,
          name: market.name,
          message: errorMessage(error),
        },
      } satisfies HistoryFailure
    }
  })

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('Yield alerts request was aborted')
  }
  const successes = outcomes.filter((outcome): outcome is HistorySuccess => outcome.ok)
  const failures = outcomes
    .filter((outcome): outcome is HistoryFailure => !outcome.ok)
    .map((outcome) => outcome.failure)
  if (candidates.length > 0 && successes.length === 0) {
    throw new YieldAlertsUnavailableError(
      `No Pendle market history could be validated (${failures.length}/${candidates.length} failed)`,
      failures,
    )
  }

  const alerts = successes
    .map((outcome) => outcome.alert)
    .filter((alert): alert is YieldAlert => alert !== null)
    .sort((left, right) =>
      Math.abs(right.deltaBps) - Math.abs(left.deltaBps) ||
      left.chainId - right.chainId ||
      left.address.localeCompare(right.address),
    )

  return {
    ...window,
    marketsScanned: catalog.rows.length,
    marketsEligible: alerts.length,
    candidateMarkets: candidates.length,
    successfulHistories: successes.length,
    excludedForLiquidity: successes.length - alerts.length,
    invalidMarkets,
    unsupportedMarkets,
    failedHistories: failures,
    alerts,
  }
}
