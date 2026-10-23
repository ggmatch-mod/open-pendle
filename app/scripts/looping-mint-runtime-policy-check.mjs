#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { getAbiItem, getAddress, toFunctionSelector } from 'viem'
import {
  LOCAL_LOOPING_MINT_POLICY_MAX_MARKETS,
  resolveLocalLoopingMintPolicyMarkets,
} from '../vite.config.ts'
import { pendleLoopingRouterAbi } from '../src/lib/loopingAbi.ts'
import {
  LOOPING_ENTRY_EXECUTION_REGISTRY,
  PENDLE_MINT_PY_FROM_TOKEN_SELECTOR,
  PENDLE_MINT_PY_FROM_TOKEN_SELECTOR_STORAGE_SLOT,
} from '../src/lib/loopingRegistry.ts'
import {
  LOOPING_MINT_RUNTIME_POLICY_MAX_MARKETS,
  LOOPING_MINT_RUNTIME_POLICY_PATH,
  LOOPING_MINT_RUNTIME_POLICY_SCHEMA,
  LOOPING_MINT_RUNTIME_POLICY_TIMEOUT_MS,
  LoopingMintRuntimePolicyError,
  assertLoopingMintRuntimeActionEnabled,
} from '../src/lib/loopingMintRuntimePolicy.ts'
import {
  LOOPING_MARKET_CANDIDATE_MANIFEST,
} from '../src/lib/loopingMarketManifest.ts'

const betaSource = readFileSync(
  new URL('../src/lib/loopingBeta.ts', import.meta.url),
  'utf8',
)
const mintPolicySource = readFileSync(
  new URL('../public/looping-mint-execution-policy.v2.json', import.meta.url),
  'utf8',
)
const mintPolicy = JSON.parse(mintPolicySource)
const headersSource = readFileSync(
  new URL('../public/_headers', import.meta.url),
  'utf8',
)
const marketPolicy = JSON.parse(readFileSync(
  new URL('../public/looping-execution-policy.v2.json', import.meta.url),
  'utf8',
))

assert.match(
  betaSource,
  /LOOPING_MINT_BETA_ENABLED\s*=\s*\n?\s*import\.meta\.env\.VITE_LOOPING_MINT_BETA_ENABLED === 'true'/,
)
assert.doesNotMatch(
  betaSource,
  /VITE_LOOPING_MINT_BETA_ENABLED\s*!==\s*'false'/,
)

assert.equal(LOOPING_MINT_RUNTIME_POLICY_PATH, '/looping-mint-execution-policy.v2.json')
assert.equal(mintPolicy.schema, LOOPING_MINT_RUNTIME_POLICY_SCHEMA)
assert.ok(mintPolicy.revision >= 1)
assert.equal(typeof mintPolicy.mint.entry.enabled, 'boolean')
assert.deepEqual(mintPolicy.mint.increase, {
  enabled: false,
  markets: [],
})
assert.ok(Buffer.byteLength(mintPolicySource, 'utf8') <= 8_192)
assert.match(
  headersSource,
  /\/looping-mint-execution-policy\.v2\.json\n\s+Cache-Control: no-store, no-cache, must-revalidate, max-age=0\n\s+Cloudflare-CDN-Cache-Control: no-store\n\s+CDN-Cache-Control: no-store/,
)

// Market Mode and Mint capabilities remain independently scoped.
assert.deepEqual(Object.keys(marketPolicy).sort(), ['entry', 'revision', 'schema'])
assert.deepEqual(
  Object.keys(marketPolicy.entry).sort(),
  ['enabled', 'markets'],
)

const mintAbiItem = getAbiItem({
  abi: pendleLoopingRouterAbi,
  name: 'mintPyFromToken',
})
assert.equal(toFunctionSelector(mintAbiItem), PENDLE_MINT_PY_FROM_TOKEN_SELECTOR)

for (const market of LOOPING_ENTRY_EXECUTION_REGISTRY) {
  assert.equal(getAddress(market.yieldToken), market.yieldToken)
  const mintRouter = market.mintRouteUpgradePolicy.pendleRouter
  assert.equal(mintRouter.selector, PENDLE_MINT_PY_FROM_TOKEN_SELECTOR)
  assert.equal(
    mintRouter.selectorStorageSlot,
    PENDLE_MINT_PY_FROM_TOKEN_SELECTOR_STORAGE_SLOT,
  )
  assert.match(mintRouter.facetRuntimeCodeHash, /^0x[0-9a-f]{64}$/)
  assert.equal(mintRouter.facet, '0x1266261289d815650A6bcdb308766BE36efA8149')
  assert.equal(
    mintRouter.facetRuntimeCodeHash,
    '0xa38c335d383c1ac060df1f3f4687917a6da673bbf6e37a3b5241b49760194d6d',
  )
}

const policyNow = Date.parse('2026-07-23T08:00:00.000Z')
const manifestMarkets = LOOPING_MARKET_CANDIDATE_MANIFEST.map((candidate) => ({
  chainId: candidate.chainId,
  morphoMarketId: candidate.marketId.toLowerCase(),
}))
const manifestMarketIdentities = manifestMarkets.map(
  ({ chainId, morphoMarketId }) => `${chainId}:${morphoMarketId}`,
)
const registryMarkets = LOOPING_ENTRY_EXECUTION_REGISTRY.map(
  ({ chainId, marketId }) => ({
    chainId,
    morphoMarketId: marketId.toLowerCase(),
  }),
)
const registryMarketIdentities = registryMarkets.map(
  ({ chainId, morphoMarketId }) => `${chainId}:${morphoMarketId}`,
)
assert.deepEqual(Object.keys(mintPolicy.mint.entry).sort(), ['enabled', 'markets'])
assert.equal(mintPolicy.mint.entry.enabled, mintPolicy.mint.entry.markets.length > 0)
const baseEntryScopes = new Set(marketPolicy.entry.markets.map(
  ({ chainId, morphoMarketId }) => `${chainId}:${morphoMarketId}`,
))
for (const scoped of mintPolicy.mint.entry.markets) {
  const key = `${scoped.chainId}:${scoped.morphoMarketId}`
  assert.ok(baseEntryScopes.has(key), 'Mint entry must also be covered by base entry.')
  const candidate = LOOPING_ENTRY_EXECUTION_REGISTRY.find((market) =>
    market.chainId === scoped.chainId && market.marketId.toLowerCase() === scoped.morphoMarketId)
  assert.ok(candidate, 'Production Mint scope must be reviewed.')
  assert.ok(candidate.pendleMarketExpiry > BigInt(Math.floor(Date.now() / 1_000)),
    'Production Mint scope must not contain a matured market.')
}
const legacyMintPolicy = JSON.parse(readFileSync(
  new URL('../public/looping-mint-execution-policy.v1.json', import.meta.url), 'utf8',
))
assert.equal(legacyMintPolicy.schema, 'openpendle.looping-mint-execution-policy.v1')
for (const action of ['entry', 'increase']) {
  assert.deepEqual(legacyMintPolicy.mint[action], {
    enabled: false, validUntil: null, markets: [],
  })
}

assert.equal(
  LOCAL_LOOPING_MINT_POLICY_MAX_MARKETS,
  LOOPING_MINT_RUNTIME_POLICY_MAX_MARKETS,
  'The local policy generator and runtime parser must share the same limit.',
)
assert.equal(
  manifestMarkets.length,
  LOOPING_ENTRY_EXECUTION_REGISTRY.length,
  'The all-markets policy must contain every reviewed entry market.',
)
assert.equal(
  manifestMarkets.length <= LOOPING_MINT_RUNTIME_POLICY_MAX_MARKETS,
  true,
  'The complete reviewed manifest must fit in one Mint capability.',
)
assert.equal(
  new Set(manifestMarketIdentities).size,
  manifestMarkets.length,
  'The all-markets Mint policy must not contain duplicate identities.',
)
assert.deepEqual(
  [...new Set(manifestMarkets.map(({ chainId }) => chainId))].sort(
    (left, right) => left - right,
  ),
  [1, 143, 42_161],
)
assert.deepEqual(
  [...manifestMarketIdentities].sort(),
  [...registryMarketIdentities].sort(),
  'The local all-markets Mint policy must cover exactly the entry registry.',
)

const resolvedAllMarkets = resolveLocalLoopingMintPolicyMarkets({
  OPENPENDLE_LOCAL_MINT_POLICY_ALL: 'true',
})
assert.equal(Object.isFrozen(resolvedAllMarkets), true)
assert.equal(
  resolvedAllMarkets.every((policyMarket) => Object.isFrozen(policyMarket)),
  true,
)
assert.deepEqual(resolvedAllMarkets, registryMarkets)
assert.deepEqual(resolveLocalLoopingMintPolicyMarkets({}), [])
assert.deepEqual(
  resolveLocalLoopingMintPolicyMarkets({
    OPENPENDLE_LOCAL_MINT_POLICY_ALL: '',
  }),
  [],
)
assert.deepEqual(
  resolveLocalLoopingMintPolicyMarkets({
    OPENPENDLE_LOCAL_MINT_POLICY_ALL: 'false',
  }),
  [],
)

const mixedCaseMarketId =
  `0x${manifestMarkets[0].morphoMarketId.slice(2).toUpperCase()}`
assert.deepEqual(
  resolveLocalLoopingMintPolicyMarkets({
    OPENPENDLE_LOCAL_MINT_POLICY_ALL: 'false',
    OPENPENDLE_LOCAL_MINT_POLICY_MARKET:
      `${manifestMarkets[0].chainId}:${mixedCaseMarketId}`,
  }),
  [manifestMarkets[0]],
)
assert.throws(
  () => resolveLocalLoopingMintPolicyMarkets({
    OPENPENDLE_LOCAL_MINT_POLICY_ALL: 'true',
    OPENPENDLE_LOCAL_MINT_POLICY_MARKET:
      `${manifestMarkets[0].chainId}:${manifestMarkets[0].morphoMarketId}`,
  }),
  /Set only one/,
)
for (const invalidAllValue of ['TRUE', '1', ' true', 'true ']) {
  assert.throws(
    () => resolveLocalLoopingMintPolicyMarkets({
      OPENPENDLE_LOCAL_MINT_POLICY_ALL: invalidAllValue,
    }),
    /must be true, false, or empty/,
  )
}

const allMarketsCapability = {
  enabled: true,
  markets: resolvedAllMarkets,
}
const allMarketsPolicy = {
  schema: LOOPING_MINT_RUNTIME_POLICY_SCHEMA,
  revision: 2,
  mint: {
    entry: allMarketsCapability,
    increase: allMarketsCapability,
  },
}

assert.deepEqual(
  Object.keys(allMarketsPolicy).sort(),
  ['mint', 'revision', 'schema'],
)
assert.deepEqual(
  Object.keys(allMarketsPolicy.mint).sort(),
  ['entry', 'increase'],
)
for (const action of ['entry', 'increase']) {
  assert.deepEqual(
    Object.keys(allMarketsPolicy.mint[action]).sort(),
    ['enabled', 'markets'],
  )
  for (const policyMarket of allMarketsPolicy.mint[action].markets) {
    assert.deepEqual(
      Object.keys(policyMarket).sort(),
      ['chainId', 'morphoMarketId'],
    )
  }
}
assert.ok(
  Buffer.byteLength(JSON.stringify(allMarketsPolicy), 'utf8') <= 8_192,
  'The complete all-markets policy must fit the runtime response limit.',
)

const market = LOOPING_ENTRY_EXECUTION_REGISTRY[0]
const enabledCapability = {
  enabled: true,
  markets: [{
    chainId: market.chainId,
    morphoMarketId: market.marketId.toLowerCase(),
  }],
}
const enabledPolicy = {
  schema: LOOPING_MINT_RUNTIME_POLICY_SCHEMA,
  revision: 2,
  mint: {
    entry: enabledCapability,
    increase: enabledCapability,
  },
}
const disabledPolicy = {
  schema: LOOPING_MINT_RUNTIME_POLICY_SCHEMA,
  revision: 1,
  mint: {
    entry: { enabled: false, markets: [] },
    increase: { enabled: false, markets: [] },
  },
}

function responseFor(requestUrl, policy, {
  responseUrl = requestUrl.toString(),
  status = 200,
  contentType = 'application/json',
  redirected = false,
} = {}) {
  const response = new Response(JSON.stringify(policy), {
    status,
    headers: { 'content-type': contentType },
  })
  Object.defineProperties(response, {
    redirected: { value: redirected },
    url: { value: responseUrl },
  })
  return response
}

function policyFetcher(policy, overrides, inspect) {
  return async (input, init) => {
    const requestUrl = input instanceof URL ? input : new URL(String(input))
    inspect?.(requestUrl, init)
    return responseFor(requestUrl, policy, overrides)
  }
}

function policyClock() {
  let calls = 0
  return () => policyNow + calls++
}

for (const action of ['entry', 'increase']) {
  for (const policyMarket of manifestMarkets) {
    const result = await assertLoopingMintRuntimeActionEnabled({
      action,
      chainId: policyMarket.chainId,
      marketId: policyMarket.morphoMarketId,
      origin: 'http://127.0.0.1:4174',
      fetchPolicy: policyFetcher(allMarketsPolicy),
      clock: policyClock(),
    })
    assert.equal(result.mint[action].enabled, true)
    assert.equal(
      result.mint[action].markets.length,
      LOOPING_MARKET_CANDIDATE_MANIFEST.length,
    )
  }
}
for (const policyMarket of mintPolicy.mint.entry.markets) {
  const result = await assertLoopingMintRuntimeActionEnabled({
    action: 'entry',
    chainId: policyMarket.chainId,
    marketId: policyMarket.morphoMarketId,
    origin: 'https://openpendle.com',
    fetchPolicy: policyFetcher(mintPolicy),
    clock: Date.now,
  })
  assert.equal(result.mint.entry.enabled, true)
}

await assert.rejects(
  assertLoopingMintRuntimeActionEnabled({
    action: 'entry',
    chainId: 10,
    marketId: manifestMarkets[0].morphoMarketId,
    origin: 'http://127.0.0.1:4174',
    fetchPolicy: policyFetcher(allMarketsPolicy),
    clock: policyClock(),
  }),
  (error) =>
    error instanceof LoopingMintRuntimePolicyError &&
    /does not cover this market/.test(error.message),
)

for (const action of ['entry', 'increase']) {
  let requestChecked = false
  const result = await assertLoopingMintRuntimeActionEnabled({
    action,
    chainId: market.chainId,
    marketId: market.marketId,
    origin: 'https://app.openpendle.example',
    fetchPolicy: policyFetcher(enabledPolicy, undefined, (requestUrl, init) => {
      requestChecked = true
      assert.equal(requestUrl.origin, 'https://app.openpendle.example')
      assert.equal(requestUrl.pathname, LOOPING_MINT_RUNTIME_POLICY_PATH)
      assert.ok(requestUrl.searchParams.get('check'))
      assert.equal(init.method, 'GET')
      assert.equal(init.cache, 'no-store')
      assert.equal(init.credentials, 'same-origin')
      assert.equal(init.redirect, 'error')
      assert.equal(init.referrerPolicy, 'no-referrer')
    }),
    clock: policyClock(),
  })
  assert.equal(requestChecked, true)
  assert.equal(result.mint[action].enabled, true)
}

await assert.rejects(
  assertLoopingMintRuntimeActionEnabled({
    action: 'entry',
    chainId: market.chainId,
    marketId: market.marketId,
    origin: 'https://app.openpendle.example',
    fetchPolicy: policyFetcher(disabledPolicy),
    clock: policyClock(),
  }),
  (error) =>
    error instanceof LoopingMintRuntimePolicyError &&
    /currently paused/.test(error.message),
)

await assert.rejects(
  assertLoopingMintRuntimeActionEnabled({
    action: 'increase',
    chainId: market.chainId,
    marketId: market.marketId,
    origin: 'https://openpendle.com',
    fetchPolicy: policyFetcher(mintPolicy),
    clock: Date.now,
  }),
  (error) =>
    error instanceof LoopingMintRuntimePolicyError &&
    /currently paused/.test(error.message),
)

await assert.rejects(
  assertLoopingMintRuntimeActionEnabled({
    action: 'increase',
    chainId: market.chainId,
    marketId: `0x${'1'.repeat(64)}`,
    origin: 'https://app.openpendle.example',
    fetchPolicy: policyFetcher(enabledPolicy),
    clock: policyClock(),
  }),
  (error) =>
    error instanceof LoopingMintRuntimePolicyError &&
    /does not cover this market/.test(error.message),
)

const extraKeyPolicy = structuredClone(enabledPolicy)
extraKeyPolicy.mint.entry.unreviewed = true
await assert.rejects(
  assertLoopingMintRuntimeActionEnabled({
    action: 'entry',
    chainId: market.chainId,
    marketId: market.marketId,
    origin: 'https://app.openpendle.example',
    fetchPolicy: policyFetcher(extraKeyPolicy),
    clock: policyClock(),
  }),
  LoopingMintRuntimePolicyError,
)

await assert.rejects(
  assertLoopingMintRuntimeActionEnabled({
    action: 'entry',
    chainId: market.chainId,
    marketId: market.marketId,
    origin: 'https://app.openpendle.example',
    fetchPolicy: policyFetcher(enabledPolicy, {
      responseUrl: 'https://other.example/looping-mint-execution-policy.v2.json',
    }),
    clock: policyClock(),
  }),
  LoopingMintRuntimePolicyError,
)

for (const action of ['entry', 'increase']) {
  for (const clockDate of ['2026-10-17T00:00:00.000Z', '2100-01-01T00:00:00.000Z']) {
    await assertLoopingMintRuntimeActionEnabled({
      action, chainId: market.chainId, marketId: market.marketId,
      origin: 'https://app.openpendle.example',
      fetchPolicy: policyFetcher(enabledPolicy),
      clock: () => Date.parse(clockDate),
    })
  }
}
for (const invalidPolicy of [
  legacyMintPolicy,
  { ...enabledPolicy, mint: { ...enabledPolicy.mint,
    entry: { ...enabledCapability, validUntil: null } } },
]) {
  await assert.rejects(assertLoopingMintRuntimeActionEnabled({
    action: 'entry', chainId: market.chainId, marketId: market.marketId,
    origin: 'https://app.openpendle.example',
    fetchPolicy: policyFetcher(invalidPolicy), clock: policyClock(),
  }), LoopingMintRuntimePolicyError)
}
let emergencyDisabled = false
const emergencyFetch = async (url) => responseFor(
  url, emergencyDisabled ? disabledPolicy : enabledPolicy,
)
await assertLoopingMintRuntimeActionEnabled({
  action: 'entry', chainId: market.chainId, marketId: market.marketId,
  origin: 'https://app.openpendle.example',
  fetchPolicy: emergencyFetch, clock: policyClock(),
})
emergencyDisabled = true
await assert.rejects(assertLoopingMintRuntimeActionEnabled({
  action: 'entry', chainId: market.chainId, marketId: market.marketId,
  origin: 'https://app.openpendle.example',
  fetchPolicy: emergencyFetch, clock: policyClock(),
}), /currently paused/)

for (const hangBody of [false, true]) {
  await assert.rejects(assertLoopingMintRuntimeActionEnabled({
    action: 'entry', chainId: market.chainId, marketId: market.marketId,
    origin: 'https://app.openpendle.example', clock: policyClock(),
    timeoutMs: Math.min(5, LOOPING_MINT_RUNTIME_POLICY_TIMEOUT_MS),
    fetchPolicy: async (url) => {
      const never = new Promise(() => {})
      if (!hangBody) return never
      const response = responseFor(url, enabledPolicy)
      response.text = () => never
      return response
    },
  }), LoopingMintRuntimePolicyError)
}

console.log('Looping Mint durable v2 policy, safe v1 migration, live scopes, and emergency disable verified')
