/** Network-free regression checks for personalized Action Center behavior. */

import { strict as assert } from 'node:assert'
import { buildActionCenterItems } from '../src/lib/actionCenter.ts'
import {
  ACTION_CENTER_MAX_TRACKED_MARKETS,
  ACTION_CENTER_STORAGE_KEY,
  actionActivityLabelForFunction,
  actionCenterProfile,
  recordActionActivity,
  setActionCenterPreferences,
  setTrackedMarketTarget,
  trackActionMarket,
  updateActionActivityStatus,
} from '../src/lib/actionCenterStorage.ts'

const address = (digit) => `0x${digit.repeat(40)}`
const OWNER_A = address('1')
const OWNER_B = address('2')
const MARKET = address('3')
const OTHER_MARKET = address('4')
const HASH = `0x${'a'.repeat(64)}`
const NOW = Date.parse('2033-05-18T03:33:20.000Z')

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    raw: () => values.get(ACTION_CENTER_STORAGE_KEY),
  }
}

const storage = memoryStorage()

console.log('Profiles, alert rules, and followed markets remain wallet-isolated')
setActionCenterPreferences(OWNER_A, {
  maturityLeadDays: 7,
  yieldMoveBps: 100,
  showClaimable: false,
}, storage)
trackActionMarket(OWNER_A, {
  chainId: 1,
  market: MARKET,
  label: '\u202E Tracked\nmarket ',
  trackedAt: NOW,
}, storage)
assert.equal(actionCenterProfile(OWNER_A, storage).preferences.maturityLeadDays, 7)
assert.equal(actionCenterProfile(OWNER_A, storage).trackedMarkets[0].label, 'Trackedmarket')
assert.equal(actionCenterProfile(OWNER_B, storage).trackedMarkets.length, 0)
setTrackedMarketTarget(OWNER_A, 1, MARKET, 550, storage)
trackActionMarket(OWNER_A, {
  chainId: 1,
  market: MARKET,
  label: 'Tracked market refreshed',
  trackedAt: NOW + 1,
}, storage)
assert.equal(actionCenterProfile(OWNER_A, storage).trackedMarkets[0].targetApyBps, 550)

console.log('The persistence schema discards sensitive or unrecognized activity fields')
recordActionActivity({
  id: 'transaction:1:test',
  owner: OWNER_A,
  chainId: 1,
  kind: 'transaction',
  label: 'Buy PT with 100.25 USDC',
  status: 'pending',
  createdAt: NOW,
  updatedAt: NOW,
  hash: HASH,
  signature: 'do-not-store',
  calldata: '0x1234',
  amount: '1000000',
}, storage)
const raw = storage.raw()
assert.equal(raw.includes('do-not-store'), false)
assert.equal(raw.includes('calldata'), false)
assert.equal(raw.includes('amount'), false)
assert.equal(raw.includes('100.25'), false)
assert.equal(raw.includes('Buy PT with'), false)
assert.equal(actionCenterProfile(OWNER_A, storage).activity[0].label, 'Transaction')
assert.equal(actionCenterProfile(OWNER_A, storage).activity[0].hash, HASH)

console.log('Safe function categories survive while legacy descriptions are removed on the next write')
assert.equal(actionActivityLabelForFunction('swapExactTokenForPt'), 'Buy PT')
assert.equal(actionActivityLabelForFunction('addLiquiditySingleToken'), 'Add liquidity')
assert.equal(actionActivityLabelForFunction('unknownCallWith100USDC'), 'Transaction')
const legacyStorage = memoryStorage()
const legacyState = JSON.parse(raw)
legacyState.profiles[OWNER_A.toLowerCase()].activity[0] = {
  ...legacyState.profiles[OWNER_A.toLowerCase()].activity[0],
  label: 'Buy PT with 100.25 USDC',
  signature: 'legacy-signature-do-not-store',
  calldata: '0x1234',
  amount: '1000000',
}
legacyStorage.setItem(ACTION_CENTER_STORAGE_KEY, JSON.stringify(legacyState))
assert.equal(actionCenterProfile(OWNER_A, legacyStorage).activity[0].label, 'Transaction')
updateActionActivityStatus(OWNER_A, 'transaction:1:test', 'confirmed', {
  updatedAt: NOW + 1,
}, legacyStorage)
const migratedRaw = legacyStorage.raw()
assert.equal(migratedRaw.includes('100.25'), false)
assert.equal(migratedRaw.includes('legacy-signature-do-not-store'), false)
assert.equal(migratedRaw.includes('calldata'), false)
assert.equal(migratedRaw.includes('amount'), false)
recordActionActivity({
  id: 'transaction:1:safe-category',
  owner: OWNER_A,
  chainId: 1,
  kind: 'transaction',
  label: actionActivityLabelForFunction('swapExactTokenForPt'),
  status: 'confirmed',
  createdAt: NOW,
  updatedAt: NOW + 2,
  hash: HASH,
}, legacyStorage)
assert.equal(actionCenterProfile(OWNER_A, legacyStorage).activity[0].label, 'Buy PT')
recordActionActivity({
  id: 'approval:1:legacy',
  owner: OWNER_A,
  chainId: 1,
  kind: 'approval',
  label: 'Approve token symbol containing 100.25 USDC',
  status: 'confirmed',
  createdAt: NOW,
  updatedAt: NOW + 3,
  hash: HASH,
}, legacyStorage)
assert.equal(actionCenterProfile(OWNER_A, legacyStorage).activity[0].label, 'Token approval')
assert.equal(legacyStorage.raw().includes('100.25'), false)

console.log('Activity status updates are sanitized and preserve a usable journal')
updateActionActivityStatus(OWNER_A, 'transaction:1:test', 'confirmed', {
  updatedAt: NOW + 1,
}, storage)
assert.equal(actionCenterProfile(OWNER_A, storage).activity[0].status, 'confirmed')
updateActionActivityStatus(OWNER_A, 'transaction:1:test', 'failed', {
  hash: 'not-a-hash',
}, storage)
assert.equal(actionCenterProfile(OWNER_A, storage).activity[0].status, 'confirmed')

console.log('Tracked-market storage is bounded and malformed storage fails closed')
for (let index = 0; index < ACTION_CENTER_MAX_TRACKED_MARKETS + 5; index += 1) {
  trackActionMarket(OWNER_A, {
    chainId: 1,
    market: `0x${index.toString(16).padStart(40, '0')}`,
    label: `Market ${index}`,
    trackedAt: NOW + index + 1,
  }, storage)
}
assert.equal(actionCenterProfile(OWNER_A, storage).trackedMarkets.length, ACTION_CENTER_MAX_TRACKED_MARKETS)
const corrupt = memoryStorage()
corrupt.setItem(ACTION_CENTER_STORAGE_KEY, '{broken')
assert.equal(actionCenterProfile(OWNER_A, corrupt).trackedMarkets.length, 0)

function yieldAlert(market, deltaBps) {
  return {
    key: `1:${market}`,
    chainId: 1,
    address: market,
    name: market === MARKET ? 'Tracked USD' : 'Untracked USD',
    protocol: 'Protocol',
    expiry: '2034-01-01T00:00:00.000Z',
    currentLiquidity: 2_000_000,
    liquidity: 2_000_000,
    startApy: 0.05,
    endApy: 0.056,
    deltaBps,
    relativeChange: 0.12,
    direction: 'increase',
    nearExpiry: false,
    material: true,
  }
}

const portfolioAction = {
  id: 'claim:1:test',
  kind: 'claim',
  severity: 'info',
  chainId: 1,
  market: MARKET,
  marketName: 'Tracked USD',
  title: 'Yield or rewards ready to claim',
  detail: 'Review claimables.',
}
const holding = { chainId: 1, market: MARKET }
const activity = [
  {
    id: 'transaction:1:pending',
    owner: OWNER_A,
    chainId: 1,
    kind: 'transaction',
    label: 'Add liquidity',
    status: 'pending',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    hash: HASH,
  },
  {
    id: 'limit-order:1:active',
    owner: OWNER_A,
    chainId: 1,
    kind: 'limit-order',
    label: 'Buy PT · Tracked USD',
    status: 'active',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    orderId: HASH,
    market: MARKET,
    expiry: Math.floor(NOW / 1_000) + 2 * 24 * 60 * 60,
  },
  {
    id: 'limit-order:1:filled',
    owner: OWNER_A,
    chainId: 1,
    kind: 'limit-order',
    label: 'Sell PT · Tracked USD',
    status: 'filled',
    createdAt: NOW - 10_000,
    updatedAt: NOW - 2_000,
    orderId: `0x${'b'.repeat(64)}`,
    market: MARKET,
    expiry: Math.floor(NOW / 1_000) + 2 * 24 * 60 * 60,
  },
]

console.log('The review queue combines holdings, thresholds, orders, transactions, and staleness')
const items = buildActionCenterItems({
  portfolioActions: [portfolioAction],
  holdings: [holding],
  yieldAlerts: [yieldAlert(MARKET, 50), yieldAlert(OTHER_MARKET, 500)],
  trackedMarkets: [{
    chainId: 1,
    market: MARKET,
    label: 'Tracked USD',
    trackedAt: NOW,
    targetApyBps: 550,
  }],
  activity,
  preferences: { maturityLeadDays: 30, yieldMoveBps: 50, showClaimable: true },
  yieldWindowEnd: new Date(NOW - 3 * 60 * 60_000).toISOString(),
  now: NOW,
})
assert.deepEqual(
  items.map(({ kind }) => kind),
  ['transaction', 'data-stale', 'order-expiry', 'claim', 'apy-target', 'yield-move', 'order-update'],
)
assert.equal(items.filter(({ kind }) => kind === 'yield-move').length, 1)
assert.equal(items.some(({ id }) => id.includes(OTHER_MARKET)), false)

const passedExpiry = buildActionCenterItems({
  portfolioActions: [],
  holdings: [],
  yieldAlerts: [],
  trackedMarkets: [],
  activity: [{
    ...activity[1],
    id: 'limit-order:1:past-expiry',
    expiry: Math.floor(NOW / 1_000) - 1,
  }],
  preferences: { maturityLeadDays: 30, yieldMoveBps: 50, showClaimable: true },
  yieldWindowEnd: new Date(NOW).toISOString(),
  now: NOW,
})
assert.equal(passedExpiry[0].title, 'Limit order expiry reached')
assert.match(passedExpiry[0].detail, /refresh its final Pendle status/)

console.log('Claim alerts and sub-threshold moves respect user rules')
const filtered = buildActionCenterItems({
  portfolioActions: [portfolioAction],
  holdings: [holding],
  yieldAlerts: [yieldAlert(MARKET, 99)],
  trackedMarkets: [],
  activity: [],
  preferences: { maturityLeadDays: 30, yieldMoveBps: 100, showClaimable: false },
  yieldWindowEnd: new Date(NOW).toISOString(),
  now: NOW,
})
assert.deepEqual(filtered, [])

console.log('Missing wallet or partial yield coverage cannot report an all-clear queue')
const incompleteCoverage = buildActionCenterItems({
  portfolioActions: [],
  holdings: [],
  yieldAlerts: [],
  trackedMarkets: [],
  activity: [],
  preferences: { maturityLeadDays: 30, yieldMoveBps: 50, showClaimable: true },
  yieldWindowEnd: new Date(NOW).toISOString(),
  portfolioCoverageUnavailable: true,
  yieldCoverageUnavailable: true,
  now: NOW,
})
assert.deepEqual(incompleteCoverage.map(({ id }) => id), [
  'data-stale:wallet-positions',
  'data-stale:yield-alerts',
])
assert.equal(incompleteCoverage.every(({ severity }) => severity === 'warning'), true)
assert.match(incompleteCoverage[0].title, /incomplete/)
assert.match(incompleteCoverage[1].title, /incomplete/)

console.log('An APY target outside the mover dataset has explicit unavailable coverage')
const uncoveredTarget = buildActionCenterItems({
  portfolioActions: [],
  holdings: [],
  yieldAlerts: [],
  trackedMarkets: [{
    chainId: 1,
    market: MARKET,
    label: 'Low liquidity market',
    trackedAt: NOW,
    targetApyBps: 550,
  }],
  activity: [],
  preferences: { maturityLeadDays: 30, yieldMoveBps: 50, showClaimable: true },
  yieldWindowEnd: new Date(NOW).toISOString(),
  now: NOW,
})
assert.equal(uncoveredTarget.length, 1)
assert.equal(uncoveredTarget[0].id, 'data-stale:tracked-apy-targets')
assert.equal(uncoveredTarget[0].severity, 'warning')

console.log('Action Center checks passed.')
