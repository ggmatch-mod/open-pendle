/** Network-free regression checks for the 24-hour Pendle yield-alert data layer. */

import { strict as assert } from 'node:assert'
import {
  YIELD_ALERTS_HISTORY_POINT_COUNT,
  YIELD_ALERTS_MIN_LIQUIDITY_USD,
  YieldAlertsUnavailableError,
  calculateYieldAlert,
  fetchYieldAlerts,
  normalizeYieldAlertMarket,
  parseYieldAlertHistory,
  yieldAlertsWindow,
} from '../src/lib/yieldAlerts.ts'

const NOW = new Date('2026-07-17T10:30:00.000Z')
const WINDOW = yieldAlertsWindow(NOW)

assert.equal(YIELD_ALERTS_MIN_LIQUIDITY_USD, 1_000_000)

function marketAddress(index) {
  return `0x${index.toString(16).padStart(40, '0')}`
}

function expiryAfter(window, hours) {
  return new Date(Date.parse(window.windowEnd) + hours * 60 * 60_000).toISOString()
}

function catalogRow(index, overrides = {}) {
  return {
    chainId: 42161,
    address: marketAddress(index),
    name: `PT Market ${index}`,
    protocol: 'Test protocol',
    expiry: expiryAfter(WINDOW, 240),
    details: {
      liquidity: 6_000_000,
      totalTvl: 100_000_000,
      impliedApy: 0.05,
    },
    ...overrides,
  }
}

function historyBody(
  window,
  {
    startApy = 0.05,
    endApy = 0.055,
    tvl = YIELD_ALERTS_MIN_LIQUIDITY_USD,
    totalTvl = 50_000_000,
    reverse = false,
  } = {},
) {
  const start = Date.parse(window.windowStart)
  const results = Array.from({ length: YIELD_ALERTS_HISTORY_POINT_COUNT }, (_, index) => ({
    timestamp: new Date(start + index * 60 * 60_000).toISOString(),
    impliedApy:
      startApy + ((endApy - startApy) * index) / (YIELD_ALERTS_HISTORY_POINT_COUNT - 1),
    tvl: typeof tvl === 'function' ? tvl(index) : tvl,
    totalTvl,
  }))
  return {
    total: YIELD_ALERTS_HISTORY_POINT_COUNT,
    timestamp_start: window.windowStart,
    timestamp_end: window.windowEnd,
    results: reverse ? results.reverse() : results,
  }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

console.log('UTC alignment uses an exact 24-hour window and a 15-minute ingestion buffer')
assert.deepEqual(
  yieldAlertsWindow(new Date('2026-07-17T10:14:59.999Z')),
  {
    windowStart: '2026-07-16T09:00:00.000Z',
    windowEnd: '2026-07-17T09:00:00.000Z',
  },
)
assert.deepEqual(
  yieldAlertsWindow(new Date('2026-07-17T10:15:00.000Z')),
  {
    windowStart: '2026-07-16T10:00:00.000Z',
    windowEnd: '2026-07-17T10:00:00.000Z',
  },
)
assert.throws(() => yieldAlertsWindow(new Date('invalid')), /clock is invalid/)

console.log('Active-market parsing uses AMM liquidity, strict identity, and sanitized labels')
const normalized = normalizeYieldAlertMarket(
  catalogRow(1, {
    name: '\u202E PT\nMarket ',
    protocol: '\u200BProtocol\u0000',
    details: { liquidity: 6_000_000, totalTvl: 999_000_000 },
  }),
  WINDOW.windowEnd,
)
assert(normalized !== null)
assert.equal(normalized.currentLiquidity, 6_000_000)
assert.equal(normalized.name, 'PTMarket')
assert.equal(normalized.protocol, 'Protocol')
assert.equal(normalized.address, marketAddress(1))
assert.equal(
  normalizeYieldAlertMarket(catalogRow(2, { chainId: 10 }), WINDOW.windowEnd),
  null,
)
assert.equal(
  normalizeYieldAlertMarket(catalogRow(2, { address: 'bad' }), WINDOW.windowEnd),
  null,
)
assert.equal(
  normalizeYieldAlertMarket(
    catalogRow(2, { expiry: WINDOW.windowEnd }),
    WINDOW.windowEnd,
  ),
  null,
)
assert.equal(
  normalizeYieldAlertMarket(
    catalogRow(2, { details: { liquidity: -1, totalTvl: 999_000_000 } }),
    WINDOW.windowEnd,
  ),
  null,
)

console.log('Historical parsing requires 25 distinct exact hourly observations')
const reversed = parseYieldAlertHistory(historyBody(WINDOW, { reverse: true }), WINDOW)
assert.equal(reversed.length, YIELD_ALERTS_HISTORY_POINT_COUNT)
assert.equal(reversed[0].timestamp, WINDOW.windowStart)
assert.equal(reversed.at(-1).timestamp, WINDOW.windowEnd)

const missing = historyBody(WINDOW)
missing.total -= 1
missing.results.pop()
assert.throws(
  () => parseYieldAlertHistory(missing, WINDOW),
  /exactly 25 points/,
)

const duplicate = historyBody(WINDOW)
duplicate.results.at(-1).timestamp = duplicate.results.at(-2).timestamp
assert.throws(
  () => parseYieldAlertHistory(duplicate, WINDOW),
  /duplicate hourly observation/,
)

const malformedTvl = historyBody(WINDOW)
malformedTvl.results[4].tvl = -1
assert.throws(
  () => parseYieldAlertHistory(malformedTvl, WINDOW),
  /malformed point data/,
)

const wrongWindow = historyBody(WINDOW)
wrongWindow.timestamp_end = new Date(Date.parse(WINDOW.windowEnd) - 60 * 60_000).toISOString()
assert.throws(
  () => parseYieldAlertHistory(wrongWindow, WINDOW),
  /different time window/,
)

console.log('Alert calculation enforces hourly liquidity, materiality, and near-expiry rules')
const completeHistory = parseYieldAlertHistory(historyBody(WINDOW), WINDOW)
const materialMarket = normalizeYieldAlertMarket(catalogRow(1), WINDOW.windowEnd)
assert(materialMarket !== null)
const material = calculateYieldAlert(materialMarket, completeHistory, WINDOW)
assert(material !== null)
assert(Math.abs(material.deltaBps - 50) < 1e-9)
assert(Math.abs(material.relativeChange - 0.1) < 1e-12)
assert.equal(material.liquidity, YIELD_ALERTS_MIN_LIQUIDITY_USD)
assert.equal(material.direction, 'increase')
assert.equal(material.material, true)

const oneLowHour = parseYieldAlertHistory(
  historyBody(WINDOW, {
    tvl: (index) => index === 12 ? YIELD_ALERTS_MIN_LIQUIDITY_USD - 1 : 8_000_000,
  }),
  WINDOW,
)
assert.equal(calculateYieldAlert(materialMarket, oneLowHour, WINDOW), null)

const nearExpiryMarket = normalizeYieldAlertMarket(
  catalogRow(2, { expiry: expiryAfter(WINDOW, 72) }),
  WINDOW.windowEnd,
)
assert(nearExpiryMarket !== null)
const nearExpiry = calculateYieldAlert(nearExpiryMarket, completeHistory, WINDOW)
assert(nearExpiry !== null)
assert.equal(nearExpiry.nearExpiry, true)
assert.equal(nearExpiry.material, false)

const zeroStartHistory = parseYieldAlertHistory(
  historyBody(WINDOW, { startApy: 0, endApy: 0.01 }),
  WINDOW,
)
const zeroStart = calculateYieldAlert(materialMarket, zeroStartHistory, WINDOW)
assert(zeroStart !== null)
assert.equal(zeroStart.relativeChange, null)
assert.equal(zeroStart.material, false)

console.log('Fetching paginates, caps concurrency, sorts movers, and preserves partial failures')
const rows = [
  catalogRow(1),
  catalogRow(2, { details: { liquidity: 7_000_000, totalTvl: 70_000_000 } }),
  catalogRow(3, { details: { liquidity: 8_000_000, totalTvl: 80_000_000 } }),
  catalogRow(4, {
    details: {
      liquidity: YIELD_ALERTS_MIN_LIQUIDITY_USD - 1,
      totalTvl: 90_000_000,
    },
  }),
  catalogRow(5, { chainId: 10 }),
  catalogRow(6),
]
const catalogCalls = []
const historyCalls = []
let activeHistories = 0
let maximumActiveHistories = 0
const partialFetch = async (input, init) => {
  const url = new URL(String(input))
  assert.equal(init?.method, 'GET')
  assert.equal(init?.credentials, 'omit')
  if (url.hostname === 'markets.test') {
    catalogCalls.push(url)
    const skip = Number(url.searchParams.get('skip'))
    const limit = Number(url.searchParams.get('limit'))
    return response({ total: rows.length, results: rows.slice(skip, skip + limit) })
  }

  historyCalls.push(url)
  activeHistories += 1
  maximumActiveHistories = Math.max(maximumActiveHistories, activeHistories)
  await new Promise((resolve) => setTimeout(resolve, 5))
  activeHistories -= 1
  const match = url.pathname.match(/\/markets\/(0x[0-9a-f]{40})\/historical-data$/)
  assert(match !== null)
  const market = match[1]
  if (market === marketAddress(3)) return response(null, 404)
  if (market === marketAddress(2)) {
    return response(
      historyBody(WINDOW, {
        tvl: (index) =>
          index === 7 ? YIELD_ALERTS_MIN_LIQUIDITY_USD - 1 : 7_000_000,
      }),
    )
  }
  if (market === marketAddress(6)) {
    return response(historyBody(WINDOW, { startApy: 0.05, endApy: 0.051 }))
  }
  return response(historyBody(WINDOW))
}

const partial = await fetchYieldAlerts({
  fetcher: partialFetch,
  now: NOW,
  marketsEndpoint: 'https://markets.test/active',
  historyEndpointBase: 'https://history.test/core/v3',
  pageSize: 2,
  concurrency: 2,
  maxRetries: 1,
  retryDelayMs: 0,
})
assert.deepEqual(catalogCalls.map((url) => url.searchParams.get('skip')), ['0', '2', '4'])
assert(catalogCalls.every((url) => url.searchParams.get('isActive') === 'true'))
assert.equal(historyCalls.length, 4)
assert(historyCalls.every((url) => url.searchParams.get('time_frame') === 'hour'))
assert(historyCalls.every((url) => url.searchParams.get('timestamp_start') === WINDOW.windowStart))
assert(historyCalls.every((url) => url.searchParams.get('timestamp_end') === WINDOW.windowEnd))
assert(historyCalls.every(
  (url) => url.searchParams.get('fields') === 'timestamp,impliedApy,tvl,totalTvl',
))
assert.equal(maximumActiveHistories, 2)
assert.equal(partial.marketsScanned, 6)
assert.equal(partial.unsupportedMarkets, 1)
assert.equal(partial.invalidMarkets, 0)
assert.equal(partial.candidateMarkets, 4)
assert.equal(partial.successfulHistories, 3)
assert.equal(partial.excludedForLiquidity, 1)
assert.equal(partial.marketsEligible, 2)
assert.equal(partial.failedHistories.length, 1)
assert.equal(partial.failedHistories[0].address, marketAddress(3))
assert.deepEqual(partial.alerts.map((alert) => alert.address), [marketAddress(1), marketAddress(6)])
assert.equal(partial.alerts[0].liquidity, YIELD_ALERTS_MIN_LIQUIDITY_USD)

console.log('429 responses retry once, while non-retryable failures remain per-market')
let retryHistoryAttempts = 0
const retryFetch = async (input) => {
  const url = new URL(String(input))
  if (url.hostname === 'markets.test') {
    return response({ total: 1, results: [catalogRow(7)] })
  }
  retryHistoryAttempts += 1
  return retryHistoryAttempts === 1
    ? response(null, 429)
    : response(historyBody(WINDOW))
}
const retried = await fetchYieldAlerts({
  fetcher: retryFetch,
  now: NOW,
  marketsEndpoint: 'https://markets.test/active',
  historyEndpointBase: 'https://history.test/core/v3',
  maxRetries: 1,
  retryDelayMs: 0,
})
assert.equal(retryHistoryAttempts, 2)
assert.equal(retried.marketsEligible, 1)

console.log('All-history failure is not misreported as an empty successful result')
const allFailedFetch = async (input) => {
  const url = new URL(String(input))
  return url.hostname === 'markets.test'
    ? response({ total: 1, results: [catalogRow(8)] })
    : response(null, 503)
}
await assert.rejects(
  fetchYieldAlerts({
    fetcher: allFailedFetch,
    now: NOW,
    marketsEndpoint: 'https://markets.test/active',
    historyEndpointBase: 'https://history.test/core/v3',
    maxRetries: 0,
  }),
  (error) =>
    error instanceof YieldAlertsUnavailableError &&
    error.failures.length === 1 &&
    /No Pendle market history/.test(error.message),
)

console.log('Catalog truncation, timeout, and pre-abort fail closed')
await assert.rejects(
  fetchYieldAlerts({
    fetcher: async () => response({ total: 2, results: [] }),
    now: NOW,
    marketsEndpoint: 'https://markets.test/active',
    maxRetries: 0,
  }),
  /empty page before its reported total/,
)
await assert.rejects(
  fetchYieldAlerts({
    fetcher: async () => new Promise(() => {}),
    now: NOW,
    marketsEndpoint: 'https://markets.test/active',
    requestTimeoutMs: 5,
    maxRetries: 0,
  }),
  /timed out/,
)

const controller = new AbortController()
controller.abort(new Error('stop now'))
let abortedFetchCalls = 0
await assert.rejects(
  fetchYieldAlerts({
    fetcher: async () => {
      abortedFetchCalls += 1
      return response({ total: 0, results: [] })
    },
    signal: controller.signal,
    now: NOW,
    marketsEndpoint: 'https://markets.test/active',
  }),
  /stop now/,
)
assert.equal(abortedFetchCalls, 0)

console.log('The platform fetch keeps its browser receiver when no fetcher is injected')
const originalPlatformFetch = globalThis.fetch
let platformFetchCalls = 0
try {
  globalThis.fetch = function (input) {
    assert.equal(this, globalThis)
    platformFetchCalls += 1
    const url = new URL(String(input))
    assert.equal(url.hostname, 'markets.test')
    return Promise.resolve(response({ total: 0, results: [] }))
  }
  const empty = await fetchYieldAlerts({
    now: NOW,
    marketsEndpoint: 'https://markets.test/active',
    maxRetries: 0,
  })
  assert.equal(empty.marketsScanned, 0)
  assert.equal(platformFetchCalls, 1)
} finally {
  globalThis.fetch = originalPlatformFetch
}

console.log('ALL YIELD ALERT CHECKS PASSED')
