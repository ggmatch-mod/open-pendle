#!/usr/bin/env node
/** Network-free regression checks for the combined My Positions flow. */

import './positions-discovery-check.mjs'
import { strict as assert } from 'node:assert'
import { planClaimAll } from '../src/lib/actions.ts'
import {
  mapPositionMarketsBounded,
  mergePositionMarketTargets,
} from '../src/lib/positionMarkets.ts'
import {
  dedupeClaimablePositionRows,
  hasStandardPosition,
  splitStandardPositionRows,
  validatedClaimableSnapshots,
} from '../src/lib/positionView.ts'

const A = `0x${'1'.repeat(40)}`
const B = `0x${'2'.repeat(40)}`
const PT = `0x${'3'.repeat(40)}`
const YT = `0x${'4'.repeat(40)}`
const SY = `0x${'5'.repeat(40)}`
const USER = `0x${'6'.repeat(40)}`

function savedPool(chainId, market, label) {
  return {
    chainId,
    market,
    savedAt: 1,
    label,
    sy: SY,
    pt: PT,
    yt: YT,
    expiry: 2_000_000_000,
    factory: `0x${'7'.repeat(40)}`,
  }
}

console.log('Saved and Official candidates merge without inventing Saved Pool records')
const mixedCaseA = `0x${A.slice(2).toUpperCase()}`
const targets = mergePositionMarketTargets(
  [savedPool(1, mixedCaseA, 'Saved A')],
  [
    { chainId: 1, market: A },
    { chainId: 56, market: A },
    { chainId: 1, market: B },
  ],
)
assert.equal(targets.length, 3)
assert.deepEqual(targets[0].sources, ['saved', 'official'])
assert.equal(targets[0].label, 'Saved A')
assert.equal(targets[1].chainId, 56)
assert.equal(targets[2].market, B)
assert.equal('savedAt' in targets[2], false)

console.log('Market hydration is concurrency-bounded and preserves result order')
let active = 0
let maxActive = 0
const mapped = await mapPositionMarketsBounded([0, 1, 2, 3, 4, 5], async (value) => {
  active += 1
  maxActive = Math.max(maxActive, active)
  await new Promise((resolve) => setTimeout(resolve, 2))
  active -= 1
  return value * 2
}, 2)
assert.deepEqual(mapped, [0, 2, 4, 6, 8, 10])
assert.equal(maxActive, 2)

function snapshot(address, validated = true) {
  return {
    address,
    pt: PT,
    yt: YT,
    ptSymbol: 'PT-SIX',
    ytSymbol: 'YT-SIX',
    displayName: `Market ${address.slice(-4)}`,
    validated,
    sy: {
      address: SY,
      symbol: 'SY-SIX',
      decimals: 18,
      assetDecimals: 6,
    },
  }
}

function positions(overrides = {}) {
  return {
    user: USER,
    pt: 0n,
    yt: 0n,
    lp: 0n,
    sy: 0n,
    walletTokens: [],
    ytClaimableInterestSy: 0n,
    ytClaimableRewards: [],
    lpClaimableRewards: [],
    syClaimableRewards: [],
    degraded: [],
    ...overrides,
  }
}

console.log('Standard positions split into PT/YT/LP and shared PY balances de-duplicate')
const split = splitStandardPositionRows([
  { snapshot: snapshot(A), positions: positions({ pt: 11n, yt: 22n, lp: 33n }) },
  { snapshot: snapshot(B), positions: positions({ pt: 11n, yt: 22n, lp: 44n }) },
])
assert.equal(split.PT.length, 1)
assert.equal(split.YT.length, 1)
assert.equal(split.LP.length, 2)
assert.equal(split.PT[0].balance.decimals, 6)
assert.equal(split.YT[0].balance.decimals, 6)
assert.equal(split.LP[0].balance.decimals, 18)

console.log('Shared YT/SY claims render once while LP rewards remain market-specific')
const reward = { token: `0x${'8'.repeat(40)}`, symbol: 'RWD', decimals: 18, amount: 5n }
const claimRows = dedupeClaimablePositionRows([
  {
    snapshot: snapshot(A),
    positions: positions({
      ytClaimableInterestSy: 1n,
      ytClaimableRewards: [reward],
      syClaimableRewards: [reward],
      lpClaimableRewards: [reward],
    }),
  },
  {
    snapshot: snapshot(B),
    positions: positions({
      ytClaimableInterestSy: 1n,
      ytClaimableRewards: [reward],
      syClaimableRewards: [reward],
      lpClaimableRewards: [reward],
    }),
  },
])
assert.equal(claimRows.length, 2)
assert.deepEqual(
  claimRows.map(({ includeYt, includeSy }) => ({ includeYt, includeSy })),
  [
    { includeYt: true, includeSy: true },
    { includeYt: false, includeSy: false },
  ],
)

console.log('Claimable-only rows remain visible but unvalidated markets stay read-only')
const claimOnly = positions({ ytClaimableInterestSy: 1n })
assert.equal(hasStandardPosition(claimOnly), true)
const safeClaims = validatedClaimableSnapshots([
  { snapshot: snapshot(A, true), positions: claimOnly },
  { snapshot: snapshot(B, false), positions: claimOnly },
])
assert.deepEqual(safeClaims.map(({ address }) => address), [A])

console.log('Claim-all de-duplicates shared SY and YT addresses without dropping LP markets')
const plan = planClaimAll(USER, [snapshot(A), snapshot(B)])
const [, sys, yts, markets] = plan.call.args
assert.deepEqual(sys, [SY])
assert.deepEqual(yts, [YT])
assert.deepEqual(markets, [A, B])

console.log('positions check passed')
