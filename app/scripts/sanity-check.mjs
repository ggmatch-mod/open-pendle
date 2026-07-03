#!/usr/bin/env node
/**
 * M1 live sanity check for the market reader (see PLAN M1 / data-layer spec):
 *   - active market 0x46f5… (PLP USDai 25FEB2027): APY plausible, ptPriceAsset
 *     in (0.9, 1), TVL right order of magnitude, vintage 'active'
 *   - expired market 0xd89A…: isExpired = true, ptPriceAsset = 1
 *   - legacy v1 market 0x9bC6…: loads with degraded[] allowed
 *
 * Also exercises classifyAddress on near-miss inputs (PT / SY / EOA / junk).
 *
 * Run from app/:
 *   node --experimental-strip-types scripts/sanity-check.mjs
 */

import { createPublicClient, http } from 'viem'
import { arbitrum } from 'viem/chains'
import { classifyAddress, loadMarketSnapshot, validateMarket } from '../src/lib/market.ts'

const RPC = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc'
const client = createPublicClient({
  chain: arbitrum,
  transport: http(RPC, { retryCount: 3, timeout: 30_000 }),
})

const TARGETS = [
  { label: 'active (PLP USDai 25FEB2027)', address: '0x46f545683D8494Ef4c54B7ea40cA762c620846eF' },
  { label: 'expired (active-gen)', address: '0xd89A6F5b5Be3ed4379CB4B8B76ED51551D3c4dbA' },
  { label: 'legacy v1', address: '0x9bC62257Ffe7D0f7c52A019E6Fc0AF3102F8F44E' },
]

function show(label, snap) {
  console.log(`\n--- ${label} — ${snap.address}`)
  console.log(`  displayName   : ${snap.displayName}`)
  console.log(`  vintage       : ${snap.vintage}   factory: ${snap.factory}`)
  console.log(`  expiry        : ${snap.expiry} (${new Date(snap.expiry * 1000).toISOString()})  expired: ${snap.isExpired}`)
  console.log(`  SY            : ${snap.sy.symbol} (${snap.sy.address}) dec=${snap.sy.decimals} assetDec=${snap.sy.assetDecimals} asset=${snap.sy.assetSymbol ?? '?'}`)
  console.log(`  PT / YT       : ${snap.ptSymbol} / ${snap.ytSymbol}`)
  console.log(`  impliedApy    : ${(snap.metrics.impliedApy * 100).toFixed(3)}%`)
  console.log(`  ptPriceAsset  : ${snap.metrics.ptPriceAsset.toFixed(6)}  ptPriceSy: ${snap.metrics.ptPriceSy.toFixed(6)}  ytPriceAsset: ${snap.metrics.ytPriceAsset.toFixed(6)}`)
  console.log(`  tvlAsset      : ${snap.metrics.tvlAsset.toLocaleString('en-US')} ${snap.sy.assetSymbol ?? ''}`)
  console.log(`  ptProportion  : ${snap.metrics.ptProportion.toFixed(4)}  feeTier: ${(snap.metrics.feeTier * 100).toFixed(4)}%  nearRangeEdge: ${snap.metrics.nearRangeEdge}`)
  console.log(`  totalPt/totalSy/totalLp: ${snap.state.totalPt} / ${snap.state.totalSy} / ${snap.state.totalLp}`)
  console.log(`  trust         : owner=${snap.trust.syOwner ?? '?'} pendleGov=${snap.trust.ownerIsPendleGovernance} paused=${snap.trust.syPaused} proxy=${snap.trust.syIsProxy} admin=${snap.trust.syProxyAdmin ?? '-'} pendleAdmin=${snap.trust.adminIsPendleProxyAdmin}`)
  for (const n of snap.trust.notes) console.log(`    note: ${n}`)
  for (const d of snap.degraded) console.log(`    degraded: ${d}`)
}

let failed = false
const check = (cond, msg) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failed = true
}

console.log(`RPC: ${RPC}`)

const snaps = {}
for (const t of TARGETS) {
  snaps[t.label] = await loadMarketSnapshot(client, t.address)
  show(t.label, snaps[t.label])
}

console.log('\n=== Assertions ===')
const active = snaps['active (PLP USDai 25FEB2027)']
check(active.vintage === 'active', `active market vintage 'active' (got '${active.vintage}')`)
check(
  active.metrics.impliedApy > 0.01 && active.metrics.impliedApy < 0.3,
  `implied APY plausible 1–30% (got ${(active.metrics.impliedApy * 100).toFixed(2)}%)`,
)
check(
  active.metrics.ptPriceAsset > 0.9 && active.metrics.ptPriceAsset < 1,
  `ptPriceAsset in (0.9, 1) (got ${active.metrics.ptPriceAsset.toFixed(6)})`,
)
check(
  active.metrics.tvlAsset > 10_000 && active.metrics.tvlAsset < 10_000_000,
  `TVL right order of magnitude (~39k SY) (got ${active.metrics.tvlAsset.toFixed(0)})`,
)

const expired = snaps['expired (active-gen)']
check(expired.isExpired === true, 'expired market isExpired = true')
check(expired.metrics.ptPriceAsset === 1, `expired ptPriceAsset = 1 (got ${expired.metrics.ptPriceAsset})`)

const legacy = snaps['legacy v1']
check(legacy.vintage === 'v1', `legacy vintage 'v1' (got '${legacy.vintage}')`)
console.log(`  info  legacy degraded count: ${legacy.degraded.length} (allowed)`)

console.log('\n=== classifyAddress spot checks ===')
const cases = [
  ['market (active)', active.address],
  ['PT of active market', active.pt],
  ['YT of active market', active.yt],
  ['SY of active market', active.sy.address],
  ['codeless address (EOA-like)', '0x0000000000000000000000000000000000000001'],
  ['plain contract (PENDLE token)', '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8'],
  ['junk string', 'not-an-address'],
]
for (const [label, input] of cases) {
  const c = await classifyAddress(client, input)
  console.log(`  ${label.padEnd(30)} → kind=${c.kind.padEnd(8)} ${c.symbol ? `symbol=${c.symbol} ` : ''}| ${c.message}`)
}
const v = await validateMarket(client, active.pt)
console.log(`  validateMarket(PT) → isMarket=${v.isMarket} (expect false)`)

console.log(failed ? '\nSANITY CHECK FAILED' : '\nSANITY CHECK PASSED')
process.exit(failed ? 1 : 0)
