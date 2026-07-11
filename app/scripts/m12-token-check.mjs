#!/usr/bin/env node
/**
 * M12 token-page logic checks (network-free).
 *
 * Covers transaction-critical synthetic-snapshot metadata and the marketless
 * positions read shape. Uses fake PublicClients, so no wallet, RPC, or anvil is
 * required.
 *
 *   node --experimental-strip-types scripts/m12-token-check.mjs
 */

import { loadPositions } from '../src/lib/positions.ts'
import { resolveMarketsForToken } from '../src/lib/marketResolve.ts'
import { resolveTokenSet } from '../src/lib/tokenSnapshot.ts'

let failures = 0

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`)
  } else {
    console.log(`  FAIL  ${message}`)
    failures++
  }
}

async function assertRejects(run, pattern, message) {
  try {
    await run()
    assert(false, message)
  } catch (error) {
    assert(pattern.test(error instanceof Error ? error.message : String(error)), message)
  }
}

const ADDR = {
  pt: '0x1111111111111111111111111111111111111111',
  yt: '0x2222222222222222222222222222222222222222',
  sy: '0x3333333333333333333333333333333333333333',
  asset: '0x4444444444444444444444444444444444444444',
  market: '0x5555555555555555555555555555555555555555',
  user: '0x6666666666666666666666666666666666666666',
}

function tokenClient({ failExpiry = false, failSyDecimals = false, failAssetInfo = false } = {}) {
  let round = 0
  return {
    chain: { id: 42161 },
    async multicall() {
      round++
      if (round === 1) {
        return [
          { status: 'success', result: ADDR.sy },
          { status: 'failure', error: new Error('PT() is absent on a PT') },
          { status: 'success', result: ADDR.yt },
          failExpiry
            ? { status: 'failure', error: new Error('expiry unavailable') }
            : { status: 'success', result: 2_000_000_000n },
        ]
      }
      return [
        { status: 'success', result: 'Six-decimal token set' },
        { status: 'success', result: 'SY-SIX' },
        failSyDecimals
          ? { status: 'failure', error: new Error('decimals unavailable') }
          : { status: 'success', result: 18 },
        failAssetInfo
          ? { status: 'failure', error: new Error('assetInfo unavailable') }
          : { status: 'success', result: [0, ADDR.asset, 6] },
        { status: 'success', result: 10n ** 18n },
        { status: 'success', result: [ADDR.asset] },
        { status: 'success', result: [ADDR.asset] },
        { status: 'success', result: ADDR.asset },
        { status: 'success', result: 'PT-SIX' },
        { status: 'success', result: 'YT-SIX' },
      ]
    },
    async readContract() {
      return 'SIX'
    },
  }
}

console.log('Critical synthetic-snapshot metadata:')
const tokenSnapshot = await resolveTokenSet(tokenClient(), ADDR.pt)
assert(tokenSnapshot !== null, 'valid PT resolves to a token snapshot')
assert(tokenSnapshot?.sy.decimals === 18, 'known SY decimals are preserved')
assert(tokenSnapshot?.sy.assetDecimals === 6, 'known PT/YT decimals come from assetInfo()')

await assertRejects(
  () => resolveTokenSet(tokenClient({ failExpiry: true }), ADDR.pt),
  /expiry\(\) unavailable/,
  'unreadable expiry fails closed instead of assuming a live token',
)
await assertRejects(
  () => resolveTokenSet(tokenClient({ failSyDecimals: true }), ADDR.pt),
  /decimals\(\) unavailable/,
  'unreadable SY decimals fail closed instead of assuming 18',
)
await assertRejects(
  () => resolveTokenSet(tokenClient({ failAssetInfo: true }), ADDR.pt),
  /assetInfo\(\) unavailable/,
  'unreadable assetInfo fails closed instead of reusing SY decimals for PT/YT',
)

function emptyPyInfo() {
  return {
    ptBalance: { token: ADDR.pt, amount: 0n },
    ytBalance: { token: ADDR.yt, amount: 0n },
    unclaimedInterest: { token: ADDR.sy, amount: 0n },
    unclaimedRewards: [],
  }
}

function emptySyInfo() {
  return {
    syBalance: { token: ADDR.sy, amount: 0n },
    unclaimedRewards: [],
  }
}

function positionsClient() {
  const calls = []
  const balances = new Map([
    [ADDR.pt.toLowerCase(), 11n],
    [ADDR.yt.toLowerCase(), 22n],
    [ADDR.sy.toLowerCase(), 33n],
    [ADDR.asset.toLowerCase(), 44n],
    [ADDR.market.toLowerCase(), 55n],
  ])
  return {
    calls,
    chain: { id: 42161 },
    async multicall({ contracts }) {
      calls.push(contracts)
      return contracts.map((contract) => ({
        status: 'success',
        result:
          contract.functionName === 'balanceOf'
            ? (balances.get(contract.address.toLowerCase()) ?? 0n)
            : contract.functionName === 'symbol'
              ? 'TOKEN'
              : 18,
      }))
    },
    async simulateContract({ functionName }) {
      if (functionName === 'getUserPYInfo') return { result: emptyPyInfo() }
      if (functionName === 'getUserMarketInfo') {
        return {
          result: {
            lpBalance: { token: ADDR.market, amount: 0n },
            ptBalance: { token: ADDR.pt, amount: 0n },
            syBalance: { token: ADDR.sy, amount: 0n },
            unclaimedRewards: [],
          },
        }
      }
      return { result: emptySyInfo() }
    },
  }
}

console.log('\nMarketless position reads:')
const tokenPositionsClient = positionsClient()
const tokenPositions = await loadPositions(
  tokenPositionsClient,
  tokenSnapshot,
  ADDR.user,
  { includeMarket: false },
)
const tokenBalanceTargets = tokenPositionsClient.calls[0]
  .filter((call) => call.functionName === 'balanceOf')
  .map((call) => call.address.toLowerCase())
assert(tokenBalanceTargets.length === 4, 'marketless read requests PT, YT, SY, and tokenIn only')
assert(
  tokenBalanceTargets.filter((address) => address === ADDR.pt.toLowerCase()).length === 1,
  'pasted PT is not read a second time as a fake LP token',
)
assert(
  tokenPositions.pt === 11n &&
    tokenPositions.yt === 22n &&
    tokenPositions.lp === 0n &&
    tokenPositions.sy === 33n &&
    tokenPositions.walletTokens[0]?.amount === 44n,
  'marketless balance indexes still map to PT/YT/SY/tokenIn correctly',
)

const marketPositionsClient = positionsClient()
const marketSnapshot = { ...tokenSnapshot, address: ADDR.market }
const marketPositions = await loadPositions(
  marketPositionsClient,
  marketSnapshot,
  ADDR.user,
  { includeMarket: true },
)
const marketBalanceTargets = marketPositionsClient.calls[0]
  .filter((call) => call.functionName === 'balanceOf')
  .map((call) => call.address.toLowerCase())
assert(
  marketBalanceTargets.includes(ADDR.market.toLowerCase()),
  'normal market reads retain the LP balance target',
)
assert(marketPositions.lp === 55n, 'normal market LP balance still maps correctly')

console.log('\nToken-to-pool resolution:')
const originalFetch = globalThis.fetch
try {
  const apiCalls = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    apiCalls.push(url)
    const skip = Number(url.searchParams.get('skip') ?? 0)
    return {
      ok: true,
      async json() {
        return skip === 0
          ? {
              total: 101,
              results: Array.from({ length: 100 }, () => ({
                address: ADDR.market,
                pt: '42161-0x7777777777777777777777777777777777777777',
                yt: '42161-0x8888888888888888888888888888888888888888',
              })),
            }
          : {
              total: 101,
              results: [
                {
                  address: ADDR.market,
                  pt: `42161-${ADDR.pt}`,
                  yt: `42161-${ADDR.yt}`,
                },
              ],
            }
      },
    }
  }
  const apiResolved = await resolveMarketsForToken(
    { chain: { id: 42161 }, getLogs: async () => [] },
    42161,
    ADDR.pt,
    ADDR.yt,
  )
  assert(apiResolved[0] === ADDR.market, 'expired listed pool resolves from the all-markets API')
  assert(apiCalls.length === 2, 'all-markets API pagination continues until the token is found')
  assert(
    apiCalls.every((url) => url.searchParams.get('chainId') === '42161'),
    'all-markets API requests are scoped to the active chain',
  )

  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'api-v2.pendle.finance') {
      return { ok: true, json: async () => ({ total: 0, results: [] }) }
    }
    const isActiveFactory =
      url.searchParams.get('address')?.toLowerCase() ===
      '0x49f2f7002669e0e4425fa0203975625ab4af3143'
    return {
      ok: true,
      json: async () => ({
        result: isActiveFactory
          ? [
              {
                topics: [
                  url.searchParams.get('topic0'),
                  `0x${ADDR.market.slice(2).padStart(64, '0')}`,
                  url.searchParams.get('topic2'),
                ],
              },
            ]
          : [],
      }),
    }
  }
  const communityResolved = await resolveMarketsForToken(
    { chain: { id: 42161 }, getLogs: async () => [] },
    42161,
    ADDR.pt,
    ADDR.yt,
  )
  assert(
    communityResolved[0] === ADDR.market,
    'unlisted community pool resolves from indexed factory logs',
  )
} finally {
  globalThis.fetch = originalFetch
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
