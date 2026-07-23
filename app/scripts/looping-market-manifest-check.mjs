#!/usr/bin/env node

import { encodeAbiParameters, getAddress, keccak256 } from 'viem'
import { morphoMarketIdParameters } from '../src/lib/loopingAbi.ts'
import { LOOPING_MARKET_CANDIDATE_MANIFEST } from '../src/lib/loopingMarketManifest.ts'
import {
  ARBITRUM_LOOPING_USDT0_USDAI,
  LOOPING_ENTRY_EXECUTION_REGISTRY,
  LOOPING_EXECUTION_REGISTRY,
  PENDLE_MINT_PY_FROM_TOKEN_SELECTOR,
  PENDLE_MINT_PY_FROM_TOKEN_SELECTOR_STORAGE_SLOT,
  getLoopingExecutionCandidateMarket,
  isLoopingExecutionCandidateSupported,
} from '../src/lib/loopingRegistry.ts'

const EXPECTED_COUNTS = new Map([
  [1, 20],
  [143, 1],
  [42_161, 1],
])
const EXCLUDED_ARBITRUM_DUST_MARKET =
  '0x6433f5db2936ca728ef720b2e97e111f04f2c276d78b89eb19d7939bda93cd6e'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertChecksummed(address, label) {
  assert(getAddress(address) === address, `${label} is not checksummed: ${address}`)
}

const seen = new Set()
const counts = new Map()
const pendleIdentities = new Map()

for (const market of LOOPING_MARKET_CANDIDATE_MANIFEST) {
  const key = `${market.chainId}:${market.marketId}`
  assert(!seen.has(key), `Duplicate manifest identity: ${key}`)
  seen.add(key)
  counts.set(market.chainId, (counts.get(market.chainId) ?? 0) + 1)

  const params = market.morphoMarketParams
  const derivedMarketId = keccak256(
    encodeAbiParameters(morphoMarketIdParameters, [
      params.loanToken,
      params.collateralToken,
      params.oracle,
      params.irm,
      params.lltv,
    ]),
  )
  assert(derivedMarketId === market.marketId, `${key} derives ${derivedMarketId}`)
  assert(
    market.principalToken === params.collateralToken,
    `${key} principalToken does not equal Morpho collateralToken`,
  )
  assert(market.pendleMarketExpiry > 0n, `${key} has no Pendle expiry`)
  assert(
    Number.isInteger(market.loanTokenDecimals) && market.loanTokenDecimals >= 0,
    `${key} has invalid loan-token decimals`,
  )
  assert(
    Number.isInteger(market.collateralTokenDecimals) &&
      market.collateralTokenDecimals >= 0,
    `${key} has invalid collateral-token decimals`,
  )
  assert(
    Number.isInteger(market.yieldTokenDecimals) &&
      market.yieldTokenDecimals >= 0,
    `${key} has invalid yield-token decimals`,
  )
  assert(
    market.yieldTokenDecimals === market.collateralTokenDecimals,
    `${key} has mismatched PT/YT decimals`,
  )
  assert(market.syTokensIn.length > 0, `${key} has no SY input token`)
  assert(market.syTokensOut.length > 0, `${key} has no SY output token`)
  assert(
    market.audit.observedBorrowLiquidityUsd >= market.audit.minimumBorrowLiquidityUsd,
    `${key} was below its audit liquidity cutoff`,
  )

  assertChecksummed(params.loanToken, `${key} loanToken`)
  assertChecksummed(params.collateralToken, `${key} collateralToken`)
  assertChecksummed(params.oracle, `${key} oracle`)
  assertChecksummed(params.irm, `${key} irm`)
  assertChecksummed(market.principalToken, `${key} principalToken`)
  assertChecksummed(market.pendleMarket, `${key} pendleMarket`)
  assertChecksummed(market.standardizedYield, `${key} standardizedYield`)
  assertChecksummed(market.yieldToken, `${key} yieldToken`)
  market.syTokensIn.forEach((address, index) =>
    assertChecksummed(address, `${key} syTokensIn[${index}]`))
  market.syTokensOut.forEach((address, index) =>
    assertChecksummed(address, `${key} syTokensOut[${index}]`))

  const directoryCandidate = {
    morpho: {
      chainId: market.chainId,
      marketId: market.marketId,
      tuple: market.morphoMarketParams,
      loanAsset: {
        address: market.morphoMarketParams.loanToken,
        decimals: market.loanTokenDecimals,
      },
      collateralAsset: {
        address: market.morphoMarketParams.collateralToken,
        decimals: market.collateralTokenDecimals,
      },
    },
    pendle: {
      chainId: market.chainId,
      market: market.pendleMarket,
      pt: market.principalToken,
      expiry: Number(market.pendleMarketExpiry),
    },
  }
  const executable = getLoopingExecutionCandidateMarket(directoryCandidate)
  assert(executable.marketId === market.marketId, `${key} is not resolvable`)
  assert(
    executable.yieldToken === market.yieldToken,
    `${key} executable YT does not match the manifest`,
  )
  assert(
    executable.yieldTokenDecimals === market.yieldTokenDecimals,
    `${key} executable YT decimals do not match the manifest`,
  )
  assert(
    executable.mintRouteUpgradePolicy.pendleRouter.selector ===
      PENDLE_MINT_PY_FROM_TOKEN_SELECTOR,
    `${key} has the wrong Mint Router selector`,
  )
  assert(
    executable.mintRouteUpgradePolicy.pendleRouter.selectorStorageSlot ===
      PENDLE_MINT_PY_FROM_TOKEN_SELECTOR_STORAGE_SLOT,
    `${key} has the wrong Mint Router selector storage slot`,
  )
  assert(isLoopingExecutionCandidateSupported(directoryCandidate), `${key} is not entry reviewed`)
  assert(
    !Object.prototype.hasOwnProperty.call(executable.launchPolicy, 'betaCaps'),
    `${key} retained the retired fixed-size execution cap`,
  )

  const pendleKey = `${market.chainId}:${market.pendleMarket.toLowerCase()}`
  const pendleIdentity = [
    market.standardizedYield.toLowerCase(),
    market.principalToken.toLowerCase(),
    market.yieldToken.toLowerCase(),
    market.yieldTokenDecimals.toString(),
    market.pendleMarketExpiry.toString(),
  ].join(':')
  const previousPendleIdentity = pendleIdentities.get(pendleKey)
  assert(
    previousPendleIdentity === undefined || previousPendleIdentity === pendleIdentity,
    `${pendleKey} has conflicting SY/PT/YT/expiry identity`,
  )
  pendleIdentities.set(pendleKey, pendleIdentity)
}

assert(
  LOOPING_MARKET_CANDIDATE_MANIFEST.length === 22,
  `Expected 22 reviewed candidates, got ${LOOPING_MARKET_CANDIDATE_MANIFEST.length}`,
)
for (const [chainId, expected] of EXPECTED_COUNTS) {
  assert(
    counts.get(chainId) === expected,
    `Expected ${expected} candidates on chain ${chainId}, got ${counts.get(chainId) ?? 0}`,
  )
}
assert(
  !LOOPING_MARKET_CANDIDATE_MANIFEST.some(
    (market) => market.marketId === EXCLUDED_ARBITRUM_DUST_MARKET,
  ),
  'Arbitrum dust USDT0 market must remain excluded',
)
assert(
  LOOPING_ENTRY_EXECUTION_REGISTRY.length === 22,
  `Expected 22 entry identities, got ${LOOPING_ENTRY_EXECUTION_REGISTRY.length}`,
)
assert(
  LOOPING_EXECUTION_REGISTRY.length === 23,
  `Expected 23 managed identities, got ${LOOPING_EXECUTION_REGISTRY.length}`,
)
assert(
  LOOPING_EXECUTION_REGISTRY.includes(ARBITRUM_LOOPING_USDT0_USDAI) &&
    !LOOPING_ENTRY_EXECUTION_REGISTRY.includes(ARBITRUM_LOOPING_USDT0_USDAI),
  'Legacy Arbitrum USDT0 must remain manageable but not entry enabled',
)

console.log(
  'looping market manifest: 22 entry identities plus 1 legacy management-only identity verified',
)
