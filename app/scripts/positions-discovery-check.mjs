/** Network-free regression checks for official Pendle position discovery. */

import { strict as assert } from 'node:assert'
import {
  OFFICIAL_POSITIONS_MAX_REQUEST_TIMEOUT_MS,
  fetchOfficialPositionMarkets,
  normalizeOfficialPositionDiscovery,
  normalizeOfficialPositionMarkets,
} from '../src/lib/officialPositions.ts'

const USER = `0x${'a'.repeat(40)}`
const MARKET = `0x${'b'.repeat(40)}`
const CLAIM_ONLY_MARKET = `0x${'c'.repeat(40)}`
const ACTIVE_LP_MARKET = `0x${'d'.repeat(40)}`
const ZERO_MARKET = `0x${'e'.repeat(40)}`
const MIXED_SIGN_MARKET = `0x${'9'.repeat(40)}`
const REWARD = `0x${'f'.repeat(40)}`

function mixedCase(address) {
  return `0x${address.slice(2).toUpperCase()}`
}

function role(overrides = {}) {
  return {
    balance: '0',
    valuation: 0,
    claimTokenAmounts: [],
    ...overrides,
  }
}

function market(chainId, address, overrides = {}) {
  return {
    marketId: `${chainId}-${address}`,
    pt: role(),
    yt: role(),
    lp: role(),
    crossPtPositions: [],
    ...overrides,
  }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

const fixture = {
  positions: [
    {
      chainId: 1,
      openPositions: [
        market(1, mixedCase(MARKET), { pt: role({ balance: '7', valuation: 7 }) }),
        market(1, MARKET, {
          pt: role({ balance: '5', valuation: 5 }),
          lp: role({ activeBalance: '2', valuation: 2 }),
        }),
        market(1, CLAIM_ONLY_MARKET, {
          yt: role({
            claimTokenAmounts: [{ token: `1-${REWARD}`, amount: '4' }],
          }),
        }),
        market(1, ACTIVE_LP_MARKET, {
          lp: role({ activeBalance: '9', valuation: 9 }),
        }),
        market(1, MIXED_SIGN_MARKET, {
          pt: role({ balance: '12', valuation: 12 }),
          yt: role({ balance: '-4', valuation: -4 }),
          lp: role({ balance: '-8', activeBalance: '-2', valuation: -8 }),
        }),
        market(1, ZERO_MARKET),
        market(56, MARKET, { pt: role({ balance: '1' }) }),
        { ...market(1, `0x${'1'.repeat(39)}`), marketId: 'not-a-market-id' },
        market(1, `0x${'1'.repeat(40)}`, { pt: role({ balance: '-1' }) }),
        market(1, `0x${'2'.repeat(40)}`, { yt: role({ valuation: Infinity }) }),
        market(1, `0x${'3'.repeat(40)}`, {
          lp: role({ claimTokenAmounts: { token: 'bad', amount: '1' } }),
        }),
        null,
      ],
      closedPositions: [
        market(1, MARKET, {
          yt: role({
            claimTokenAmounts: [
              { token: `1-${mixedCase(REWARD)}`, amount: '3' },
              { token: `1-${REWARD}`, amount: '2' },
              { token: '', amount: '999' },
              { token: `1-${REWARD}`, amount: 'not-an-amount' },
            ],
          }),
        }),
      ],
      syPositions: [],
    },
    {
      chainId: 56,
      openPositions: [
        market(56, MARKET, { lp: role({ activeBalance: '11', valuation: 11 }) }),
      ],
      closedPositions: [],
      syPositions: [],
    },
    {
      chainId: 10,
      openPositions: [market(10, MARKET, { pt: role({ balance: '100' }) })],
      closedPositions: [],
    },
    { chainId: '1', openPositions: [], closedPositions: [] },
    {
      chainId: 42161,
      openPositions: 'malformed',
      closedPositions: [],
      errorMessage: 'upstream index unavailable',
    },
  ],
}

console.log('Normalization is independent of saved pools and retains PT/YT/LP discovery signals')
const savedPools = []
const discovery = normalizeOfficialPositionDiscovery(fixture)
const normalized = normalizeOfficialPositionMarkets(fixture)
assert.equal(savedPools.length, 0)
assert.deepEqual(discovery.failedChainIds, [42161])
assert.deepEqual(discovery.markets, normalized)
assert.equal(normalized.length, 5)
assert.deepEqual(
  normalized.map(({ key }) => key),
  [
    `1:${MIXED_SIGN_MARKET}`,
    `1:${MARKET}`,
    `1:${CLAIM_ONLY_MARKET}`,
    `1:${ACTIVE_LP_MARKET}`,
    `56:${MARKET}`,
  ],
)

console.log('Open/closed duplicates merge case-insensitively without double-counting')
const merged = normalized.find(
  ({ chainId, market: address }) => chainId === 1 && address === MARKET,
)
assert(merged !== undefined)
assert.equal(merged.chainId, 1)
assert.equal(merged.market, MARKET)
assert.deepEqual(merged.sources, ['open', 'closed'])
assert.equal(merged.roles.pt.balance, 7n)
assert.equal(merged.roles.lp.activeBalance, 2n)
assert.equal(merged.roles.yt.claimableAmounts[0].amount, 3n)
assert.equal(merged.roles.yt.claimableAmounts.length, 1)

console.log('Claimable-only and LP activeBalance-only rows remain discoverable')
const claimOnly = normalized.find(({ market: address }) => address === CLAIM_ONLY_MARKET)
assert(claimOnly !== undefined)
assert.equal(claimOnly.roles.yt.balance, 0n)
assert.equal(claimOnly.roles.yt.claimableAmounts[0].amount, 4n)
const activeLp = normalized.find(({ market: address }) => address === ACTIVE_LP_MARKET)
assert(activeLp !== undefined)
assert.equal(activeLp.roles.lp.balance, 0n)
assert.equal(activeLp.roles.lp.activeBalance, 9n)

const mixedSign = normalized.find(({ market: address }) => address === MIXED_SIGN_MARKET)
assert(mixedSign !== undefined)
assert.equal(mixedSign.roles.pt.balance, 12n)
assert.equal(mixedSign.roles.yt.balance, 0n)
assert.equal(mixedSign.roles.lp.balance, 0n)
assert.equal(mixedSign.roles.lp.activeBalance, 0n)
assert.equal(mixedSign.roles.lp.valuationUsd, 0)

console.log('The same address on another supported chain remains a distinct market')
const sameAddress = normalized.filter(({ market: address }) => address === MARKET)
assert.deepEqual(sameAddress.map(({ chainId }) => chainId), [1, 56])

console.log('Fetching uses GET, filterUsd=0, no credentials, and injectable endpoint/fetch')
const calls = []
const fetched = await fetchOfficialPositionMarkets(mixedCase(USER), {
  endpoint: 'https://positions.test/core/v1/dashboard/positions/database/',
  fetcher: async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return response(fixture)
  },
})
assert.equal(fetched.length, normalized.length)
assert.equal(calls.length, 1)
assert.equal(calls[0].url.pathname, `/core/v1/dashboard/positions/database/${USER}`)
assert.equal(calls[0].url.searchParams.get('filterUsd'), '0')
assert.equal(calls[0].init?.method, 'GET')
assert.equal(calls[0].init?.credentials, 'omit')
assert.equal(calls[0].init?.headers?.accept, 'application/json')
assert(calls[0].init?.signal instanceof AbortSignal)

console.log('Top-level schema, request inputs, HTTP status, and timeout are fail-closed')
assert.throws(
  () => normalizeOfficialPositionMarkets(null),
  /invalid response/,
)
assert.throws(
  () => normalizeOfficialPositionMarkets({ positions: null }),
  /invalid response/,
)
await assert.rejects(
  fetchOfficialPositionMarkets('not-an-address', {
    fetcher: async () => response(fixture),
  }),
  /user address is invalid/,
)
await assert.rejects(
  fetchOfficialPositionMarkets(USER, {
    endpoint: 'https://positions.test/discovery',
    fetcher: async () => response(null, 503),
  }),
  /failed \(503\)/,
)
await assert.rejects(
  fetchOfficialPositionMarkets(USER, {
    endpoint: 'https://positions.test/discovery',
    requestTimeoutMs: OFFICIAL_POSITIONS_MAX_REQUEST_TIMEOUT_MS + 1,
    fetcher: async () => response(fixture),
  }),
  /timeout must be an integer/,
)

let timeoutAborted = false
await assert.rejects(
  fetchOfficialPositionMarkets(USER, {
    endpoint: 'https://positions.test/discovery',
    requestTimeoutMs: 5,
    fetcher: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        timeoutAborted = true
        reject(init.signal.reason)
      }, { once: true })
    }),
  }),
  /timed out/,
)
assert.equal(timeoutAborted, true)

const outerController = new AbortController()
outerController.abort(new Error('caller cancelled discovery'))
let abortedFetchCalled = false
await assert.rejects(
  fetchOfficialPositionMarkets(USER, {
    endpoint: 'https://positions.test/discovery',
    signal: outerController.signal,
    fetcher: async () => {
      abortedFetchCalled = true
      return response(fixture)
    },
  }),
  /caller cancelled discovery/,
)
assert.equal(abortedFetchCalled, false)

console.log(`positions discovery check passed (${normalized.length} candidates)`)
