#!/usr/bin/env node
/**
 * M8 polish logic-check (network-free) for the three minor fixes:
 *   FIX 1 — sweepRegistryPools keys by `${chainId}:${market}` (not market-only),
 *           so the same market saved on two chains stays two distinct entries.
 *   FIX 2 — positions' native symbol resolves per chain (ETH/BNB/MON/XPL),
 *           via supportedChain(chainId).nativeSymbol + knownMeta(nativeSymbol).
 *   FIX 3 — nativeGasBuffer(chainId): larger on Ethereum mainnet, small on L2s.
 *
 * Uses a FAKE PublicClient (canned multicall results) — no anvil, no RPC.
 *   node --experimental-strip-types scripts/m8-polish-check.mjs
 */

import { sweepRegistryPools, sweepKey } from '../src/lib/market.ts'
import { knownMeta } from '../src/lib/positions.ts'
import { supportedChain, SUPPORTED_CHAINS } from '../src/lib/addresses.ts'
import { nativeGasBuffer } from '../src/components/parseAmount.ts'

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`)
  } else {
    console.log(`  FAIL  ${msg}`)
    failures++
  }
}

// A market address that we deliberately reuse across TWO chains (the exact
// collision FIX 1 guards against).
const SHARED_MARKET = '0x1111111111111111111111111111111111111111'
const SY = '0x2222222222222222222222222222222222222222'

function savedPool(chainId) {
  return {
    chainId,
    market: SHARED_MARKET,
    savedAt: 0,
    label: 'L',
    sy: SY,
    pt: '0x3333333333333333333333333333333333333333',
    yt: '0x4444444444444444444444444444444444444444',
    expiry: Math.floor(Date.now() / 1000) + 86_400,
    factory: '0x5555555555555555555555555555555555555555',
    assetDecimals: 18,
    assetSymbol: 'ASSET',
  }
}

// Fake client: canned multicall (readState / isExpired / exchangeRate) so the
// sweep runs its real key-building + stats math with no network. chain.id must
// be a SUPPORTED chain (addressBookFor resolves the router from it).
function fakeClient(chainId) {
  return {
    chain: { id: chainId },
    async multicall({ contracts }) {
      // 3 calls per pool: readState, isExpired, exchangeRate.
      const out = []
      for (let i = 0; i < contracts.length; i += 3) {
        out.push({
          status: 'success',
          result: {
            totalPt: 1_000_000000000000000000n,
            totalSy: 1_000_000000000000000000n,
            expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
            lastLnImpliedRate: 50000000000000000n,
          },
        })
        out.push({ status: 'success', result: false })
        out.push({ status: 'success', result: 10n ** 18n })
      }
      return out
    },
  }
}

console.log('FIX 1 — sweep result keyed by (chainId, market):')
{
  // Same market on Ethereum (1) and Arbitrum (42161).
  const ethOut = await sweepRegistryPools(fakeClient(1), [savedPool(1)])
  const arbOut = await sweepRegistryPools(fakeClient(42161), [savedPool(42161)])

  const ethKey = sweepKey(1, SHARED_MARKET)
  const arbKey = sweepKey(42161, SHARED_MARKET)

  assert(ethKey === `1:${SHARED_MARKET.toLowerCase()}`, `sweepKey(1) = ${ethKey}`)
  assert(Object.keys(ethOut)[0] === ethKey, `Ethereum sweep key is composite: ${Object.keys(ethOut)[0]}`)
  assert(Object.keys(arbOut)[0] === arbKey, `Arbitrum sweep key is composite: ${Object.keys(arbOut)[0]}`)
  assert(!(SHARED_MARKET.toLowerCase() in ethOut), 'result is NOT keyed by market-only anymore')

  // The crux: merging both chains' results (as useRegistrySweep does) keeps
  // BOTH entries — the shared market no longer overwrites itself.
  const merged = Object.assign({}, ethOut, arbOut)
  assert(Object.keys(merged).length === 2, `merged result has 2 distinct entries (was 1 with market-only keys): ${Object.keys(merged).length}`)
  assert(ethKey in merged && arbKey in merged, 'both chain entries survive the merge')
}

console.log('\nFIX 2 — native symbol resolves per chain:')
{
  const expected = { 1: 'ETH', 56: 'BNB', 143: 'MON', 8453: 'ETH', 9745: 'XPL', 42161: 'ETH' }
  for (const c of SUPPORTED_CHAINS) {
    const sym = supportedChain(c.id)?.nativeSymbol
    assert(sym === expected[c.id], `chain ${c.id} (${c.shortName}) nativeSymbol = ${sym}`)
  }
  // knownMeta native branch uses the passed symbol + fixed 18 decimals.
  const NATIVE = '0x0000000000000000000000000000000000000000'
  const snap = { sy: { address: SY, assetAddress: SY, symbol: '', assetSymbol: '', decimals: 18, assetDecimals: 18 }, pt: '0x0', yt: '0x0', ptSymbol: '', ytSymbol: '' }
  const bnb = knownMeta(snap, NATIVE, 'BNB')
  const mon = knownMeta(snap, NATIVE, 'MON')
  const dflt = knownMeta(snap, NATIVE)
  assert(bnb.symbol === 'BNB' && bnb.decimals === 18, `knownMeta native (BNB) = ${bnb.symbol}/${bnb.decimals}`)
  assert(mon.symbol === 'MON' && mon.decimals === 18, `knownMeta native (MON) = ${mon.symbol}/${mon.decimals}`)
  assert(dflt.symbol === 'ETH' && dflt.decimals === 18, `knownMeta native default = ${dflt.symbol}/${dflt.decimals}`)
}

console.log('\nFIX 3 — native gas buffer is chain-aware:')
{
  const eth = nativeGasBuffer(1)
  const arb = nativeGasBuffer(42161)
  assert(eth === 10_000_000_000_000_000n, `Ethereum buffer = 0.01 ETH (${eth})`)
  assert(arb === 500_000_000_000_000n, `Arbitrum buffer = 0.0005 (${arb})`)
  assert(eth > arb, 'mainnet reserves strictly more than the L2s')
  for (const id of [56, 143, 8453, 9745, 42161]) {
    assert(nativeGasBuffer(id) === 500_000_000_000_000n, `L2 chain ${id} keeps small buffer`)
  }
  assert(nativeGasBuffer(undefined) === 500_000_000_000_000n, 'undefined chainId falls back to small buffer')
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
