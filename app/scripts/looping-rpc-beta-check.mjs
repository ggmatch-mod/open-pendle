#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createPublicClient, custom } from 'viem'
import { arbitrum, base, bsc } from 'viem/chains'
import {
  OPENPENDLE_CLOUDFLARE_HOST,
  resolveLoopingReleaseFlags,
} from '../vite.config.ts'
import { morphoBlueAbi } from '../src/lib/loopingAbi.ts'
import {
  ARBITRUM_LOOPING_USDT0_USDAI,
  LOOPING_ENTRY_EXECUTION_REGISTRY,
} from '../src/lib/loopingRegistry.ts'
import {
  LOOPING_RPC_POLICY,
  LOOPING_WALLET_RPC_CHAINS,
  LOOPING_WALLET_RPC_READ_METHODS,
  createLoopingWalletReadClient,
  mayUseLoopingWalletReadFallback,
} from '../src/lib/loopingRpc.ts'
import {
  LOOPING_RUNTIME_ENTRY_POLICY_MAX_VALIDITY_MS,
  LOOPING_RUNTIME_ENTRY_POLICY_MAX_MARKETS,
  LOOPING_RUNTIME_ENTRY_POLICY_MIN_REMAINING_MS,
  LOOPING_RUNTIME_ENTRY_POLICY_PATH,
  LOOPING_RUNTIME_ENTRY_POLICY_SCHEMA,
  LoopingRuntimePolicyError,
  assertLoopingRuntimeEntryEnabled,
} from '../src/lib/loopingRuntimePolicy.ts'

const betaSource = readFileSync(
  new URL('../src/lib/loopingBeta.ts', import.meta.url),
  'utf8',
)
const viteConfigSource = readFileSync(
  new URL('../vite.config.ts', import.meta.url),
  'utf8',
)
const rpcSource = readFileSync(
  new URL('../src/lib/loopingRpc.ts', import.meta.url),
  'utf8',
)
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const hookSource = readFileSync(
  new URL('../src/components/useLoopingExecution.ts', import.meta.url),
  'utf8',
)
const panelSource = readFileSync(
  new URL('../src/components/LoopingExecutionPanel.tsx', import.meta.url),
  'utf8',
)
const pageSource = readFileSync(
  new URL('../src/pages/LoopingPage.tsx', import.meta.url),
  'utf8',
)
const headersSource = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
const committedPolicySource = readFileSync(
  new URL('../public/looping-execution-policy.v1.json', import.meta.url),
  'utf8',
)
const committedPolicy = JSON.parse(committedPolicySource)

console.log('Looping entry and exit require independent explicit public release flags')
assert.match(
  betaSource,
  /LOOPING_EXECUTION_BETA_ENABLED\s*=\s*\n?\s*import\.meta\.env\.VITE_LOOPING_EXECUTION_BETA_ENABLED === 'true'/,
)
assert.match(
  betaSource,
  /LOOPING_EXIT_BETA_ENABLED\s*=\s*\n?\s*import\.meta\.env\.VITE_LOOPING_EXIT_BETA_ENABLED === 'true'/,
)
assert.doesNotMatch(betaSource, /import\.meta\.env\.DEV/)
assert.doesNotMatch(betaSource, /VITE_LOOPING_EXECUTION_BETA_ENABLED\s*!==\s*'false'/)
assert.doesNotMatch(betaSource, /VITE_LOOPING_EXIT_BETA_ENABLED\s*!==\s*'false'/)
assert.match(
  betaSource,
  /same-origin, no-store runtime policy[\s\S]*?already-open tab can be stopped/,
)
assert.deepEqual(
  envExample.match(/^VITE_LOOPING_(?:EXECUTION|EXIT)_BETA_ENABLED=.*$/gm),
  [
    'VITE_LOOPING_EXECUTION_BETA_ENABLED=false',
    'VITE_LOOPING_EXIT_BETA_ENABLED=false',
  ],
)
assert.deepEqual(resolveLoopingReleaseFlags({}), {
  entry: false,
  exit: false,
})
assert.deepEqual(resolveLoopingReleaseFlags({
  VITE_LOOPING_EXECUTION_BETA_ENABLED: 'true',
  VITE_LOOPING_EXIT_BETA_ENABLED: 'true',
}), {
  entry: true,
  exit: true,
})
assert.match(
  viteConfigSource,
  /'import\.meta\.env\.VITE_LOOPING_EXECUTION_BETA_ENABLED': JSON\.stringify\([\s\S]*?loopingReleaseFlags\.entry/,
)
assert.match(
  viteConfigSource,
  /'import\.meta\.env\.VITE_LOOPING_EXIT_BETA_ENABLED': JSON\.stringify\([\s\S]*?loopingReleaseFlags\.exit/,
)
assert.deepEqual(resolveLoopingReleaseFlags({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'preview-branch',
  CF_PAGES_URL: `https://preview.${OPENPENDLE_CLOUDFLARE_HOST}`,
  VITE_LOOPING_EXECUTION_BETA_ENABLED: 'true',
  VITE_LOOPING_EXIT_BETA_ENABLED: 'true',
}), {
  entry: false,
  exit: false,
})
assert.deepEqual(resolveLoopingReleaseFlags({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'main',
  CF_PAGES_URL: 'https://preview.self-hosted-fork.pages.dev',
  VITE_LOOPING_EXECUTION_BETA_ENABLED: 'true',
  VITE_LOOPING_EXIT_BETA_ENABLED: 'true',
}), {
  entry: false,
  exit: false,
})
assert.deepEqual(resolveLoopingReleaseFlags({
  CF_PAGES: '1',
  CF_PAGES_BRANCH: 'main',
  CF_PAGES_URL: `https://production.${OPENPENDLE_CLOUDFLARE_HOST}`,
  VITE_LOOPING_EXECUTION_BETA_ENABLED: 'false',
  VITE_LOOPING_EXIT_BETA_ENABLED: 'false',
}), {
  entry: true,
  exit: true,
})
assert.doesNotMatch(envExample, /VITE_LOOPING_UNCAPPED_TESTING_ENABLED/)
assert.doesNotMatch(hookSource, /LOOPING_UNCAPPED_TESTING_ENABLED/)
assert.doesNotMatch(hookSource, /betaCaps|enforceBetaCaps/)
assert.doesNotMatch(panelSource, /Beta caps:|temporary amount cap/)
assert.match(panelSource, /no beta-size amount cap/)

console.log('The live entry switch is same-origin, no-store, scoped, and fail-closed')
assert.equal(LOOPING_RUNTIME_ENTRY_POLICY_PATH, '/looping-execution-policy.v1.json')
const expectedCommittedPolicyMarkets = LOOPING_ENTRY_EXECUTION_REGISTRY
  .map((market) => ({
    chainId: market.chainId,
    morphoMarketId: market.marketId.toLowerCase(),
  }))
  .sort((left, right) =>
    left.chainId - right.chainId ||
    left.morphoMarketId.localeCompare(right.morphoMarketId))
assert.equal(committedPolicy.schema, LOOPING_RUNTIME_ENTRY_POLICY_SCHEMA)
assert.equal(committedPolicy.revision, 2)
assert.equal(committedPolicy.entry.enabled, true)
assert.equal(typeof committedPolicy.entry.validUntil, 'string')
assert.deepEqual(committedPolicy.entry.markets, expectedCommittedPolicyMarkets)
assert.ok(
  Buffer.byteLength(committedPolicySource, 'utf8') <= 4_096,
  'The committed runtime entry policy must fit its response-size limit.',
)
const committedPolicyRemainingMs =
  Date.parse(committedPolicy.entry.validUntil) - Date.now()
assert.ok(
  committedPolicyRemainingMs >= LOOPING_RUNTIME_ENTRY_POLICY_MIN_REMAINING_MS,
  'The committed runtime entry policy must still be live.',
)
assert.ok(
  committedPolicyRemainingMs <= LOOPING_RUNTIME_ENTRY_POLICY_MAX_VALIDITY_MS,
  'The committed runtime entry policy must not exceed seven days.',
)
assert.match(
  headersSource,
  /\/looping-execution-policy\.v1\.json\n\s+Cache-Control: no-store, no-cache, must-revalidate, max-age=0\n\s+Cloudflare-CDN-Cache-Control: no-store\n\s+CDN-Cache-Control: no-store/,
)
assert.equal(hookSource.includes('assertLoopingRuntimeEntryEnabled'), true)

const policyNow = Date.parse('2026-07-20T14:00:00.000Z')
const disabledPolicy = {
  schema: LOOPING_RUNTIME_ENTRY_POLICY_SCHEMA,
  revision: 1,
  entry: {
    enabled: false,
    validUntil: null,
    markets: [],
  },
}
const enabledPolicy = {
  schema: LOOPING_RUNTIME_ENTRY_POLICY_SCHEMA,
  revision: 7,
  entry: {
    enabled: true,
    validUntil: new Date(
      policyNow + LOOPING_RUNTIME_ENTRY_POLICY_MAX_VALIDITY_MS,
    ).toISOString(),
    markets: [{
      chainId: 42161,
      morphoMarketId:
        '0x97cb4b88a7a5e8e9c039b106374124e642395437ffc0ef93f2799343ad022985',
    }],
  },
}
const policyResponse = (value, init = {}) => new Response(
  typeof value === 'string' ? value : JSON.stringify(value),
  {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json; charset=utf-8' },
  },
)
const policyResponseFor = (input, value, init = {}) => {
  const response = policyResponse(value, init)
  Object.defineProperty(response, 'url', {
    value: init.url ?? String(input),
  })
  if (init.redirected === true) {
    Object.defineProperty(response, 'redirected', { value: true })
  }
  return response
}
const policyRequests = []
const fetchEnabledPolicy = async (input, init) => {
  policyRequests.push({ url: String(input), init })
  return policyResponseFor(input, enabledPolicy)
}
const assertedPolicy = await assertLoopingRuntimeEntryEnabled({
  chainId: 42161,
  marketId: enabledPolicy.entry.markets[0].morphoMarketId,
  origin: 'https://openpendle.com',
  fetchPolicy: fetchEnabledPolicy,
  clock: () => policyNow,
})
assert.equal(assertedPolicy.revision, 7)
assert.equal(LOOPING_RUNTIME_ENTRY_POLICY_MAX_MARKETS, 32)
for (const market of committedPolicy.entry.markets) {
  await assertLoopingRuntimeEntryEnabled({
    chainId: market.chainId,
    marketId: market.morphoMarketId,
    origin: 'https://openpendle.com',
    fetchPolicy: async (input) => policyResponseFor(input, committedPolicy),
  })
}
await assertLoopingRuntimeEntryEnabled({
  chainId: 42161,
  marketId: enabledPolicy.entry.markets[0].morphoMarketId,
  origin: 'https://openpendle.com',
  fetchPolicy: fetchEnabledPolicy,
  clock: () => policyNow,
})
assert.equal(policyRequests.length, 2)
assert.notEqual(policyRequests[0].url, policyRequests[1].url)
for (const request of policyRequests) {
  const url = new URL(request.url)
  assert.equal(url.origin, 'https://openpendle.com')
  assert.equal(url.pathname, LOOPING_RUNTIME_ENTRY_POLICY_PATH)
  assert.equal(url.searchParams.has('check'), true)
  assert.equal(request.init.method, 'GET')
  assert.equal(request.init.cache, 'no-store')
  assert.equal(request.init.credentials, 'same-origin')
  assert.equal(request.init.redirect, 'error')
  assert.equal(request.init.referrerPolicy, 'no-referrer')
  assert.deepEqual(request.init.headers, { accept: 'application/json' })
}

const maximumPolicyMarkets = Array.from(
  { length: LOOPING_RUNTIME_ENTRY_POLICY_MAX_MARKETS },
  (_, index) => ({
    chainId: 1,
    morphoMarketId: `0x${index.toString(16).padStart(64, '0')}`,
  }),
)
await assertLoopingRuntimeEntryEnabled({
  chainId: 1,
  marketId: maximumPolicyMarkets[0].morphoMarketId,
  origin: 'https://openpendle.com',
  clock: () => policyNow,
  fetchPolicy: async (input) => policyResponseFor(input, {
    ...enabledPolicy,
    entry: { ...enabledPolicy.entry, markets: maximumPolicyMarkets },
  }),
})

const expectPolicyFailure = async (overrides, message) => {
  await assert.rejects(
    assertLoopingRuntimeEntryEnabled({
      chainId: 42161,
      marketId: enabledPolicy.entry.markets[0].morphoMarketId,
      origin: 'https://openpendle.com',
      clock: () => policyNow,
      fetchPolicy: async (input) => policyResponseFor(input, enabledPolicy),
      ...overrides,
    }),
    (error) =>
      error instanceof LoopingRuntimePolicyError &&
      new RegExp(message, 'i').test(error.message),
  )
}
await expectPolicyFailure({
  chainId: 1,
  marketId: maximumPolicyMarkets[0].morphoMarketId,
  fetchPolicy: async (input) => policyResponseFor(input, {
    ...enabledPolicy,
    entry: {
      ...enabledPolicy.entry,
      markets: [
        ...maximumPolicyMarkets,
        { chainId: 1, morphoMarketId: `0x${'ff'.repeat(32)}` },
      ],
    },
  }),
}, 'invalid')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(input, disabledPolicy),
}, 'paused')
await expectPolicyFailure({
  chainId: ARBITRUM_LOOPING_USDT0_USDAI.chainId,
  marketId: ARBITRUM_LOOPING_USDT0_USDAI.marketId,
  clock: Date.now,
  fetchPolicy: async (input) => policyResponseFor(input, committedPolicy),
}, 'does not cover')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(
    input,
    { ...enabledPolicy, extra: true },
  ),
}, 'invalid')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(input, {
    ...enabledPolicy,
    entry: { ...enabledPolicy.entry, validUntil: '2026-07-20T13:59:59.000Z' },
  }),
}, 'expired')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(input, {
    ...enabledPolicy,
    entry: {
      ...enabledPolicy.entry,
      validUntil: new Date(
        policyNow + LOOPING_RUNTIME_ENTRY_POLICY_MIN_REMAINING_MS - 1,
      ).toISOString(),
    },
  }),
}, 'expired')
let policyClockCalls = 0
await expectPolicyFailure({
  clock: () => {
    policyClockCalls += 1
    return policyClockCalls === 1
      ? policyNow
      : policyNow + LOOPING_RUNTIME_ENTRY_POLICY_MAX_VALIDITY_MS
  },
}, 'expired')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(
    input,
    enabledPolicy,
    { status: 503 },
  ),
}, 'unavailable')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(
    input,
    enabledPolicy,
    { contentType: 'text/html' },
  ),
}, 'invalid')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(input, '{bad-json'),
}, 'invalid')
await expectPolicyFailure({
  chainId: 1,
}, 'does not cover')
await expectPolicyFailure({
  fetchPolicy: async () => {
    throw new TypeError('network unavailable')
  },
}, 'could not be verified')
await expectPolicyFailure({
  fetchPolicy: async (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    ), { once: true })
  }),
  timeoutMs: 5,
}, 'could not be verified')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(input, enabledPolicy, {
    url: 'https://example.com/looping-execution-policy.v1.json',
  }),
}, 'invalid')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(input, enabledPolicy, {
    url: 'https://openpendle.com/looping-execution-policy.v1.json',
  }),
}, 'invalid')
await expectPolicyFailure({
  fetchPolicy: async (input) => policyResponseFor(input, enabledPolicy, {
    redirected: true,
  }),
}, 'invalid')

console.log('Browser looping routes every chain read through the connected wallet RPC')
assert.match(
  hookSource,
  /const walletReadClient = useMemo[\s\S]*?createLoopingWalletReadClient\(walletClient\)/,
)
assert.match(
  hookSource,
  /const withWalletRead = useCallback[\s\S]*?walletReadClient === undefined[\s\S]*?task\(walletReadClient\)/,
)
assert.doesNotMatch(
  hookSource,
  /loopingPrimaryClient|loopingFinalValidationClient|mayUseLoopingWalletReadFallback|LOOPING_1RPC|public\.1rpc\.io|withReadFallback|withFinalUnsignedValidationFallback|LoopingReadFallbackPolicy|fallbackUsed/,
)
assert.doesNotMatch(pageSource, /\b1RPC\b|public\.1rpc\.io/i)
assert.doesNotMatch(panelSource, /\b1RPC\b|public\.1rpc\.io|fallbackUsed/i)
assert.equal(LOOPING_RPC_POLICY.walletRetryCount, 0)
assert.doesNotMatch(rpcSource, /OPENPENDLE_1RPC_API_KEY|process\.env|import\.meta\.env/)
assert.doesNotMatch(
  rpcSource,
  /SignedLooping|bundle\.data|privateKey|signTypedDataAsync|sendTransactionAsync|writeContractAsync/,
)

console.log('The connected-wallet read client is execution-chain scoped and read-only')
assert.deepEqual(LOOPING_WALLET_RPC_READ_METHODS, [
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
])
assert.deepEqual(
  Object.keys(LOOPING_WALLET_RPC_CHAINS).map(Number).sort((a, b) => a - b),
  [1, 143, 8453, 42161],
)
const baseWalletClient = createLoopingWalletReadClient({
  chain: base,
  request: async () => '0x2105',
})
assert.equal(baseWalletClient.chain?.id, base.id)
const wrongChainWallet = { chain: bsc, request: async () => '0x38' }
assert.throws(
  () => createLoopingWalletReadClient(wrongChainWallet),
  /requires a supported execution-chain connection/,
)
assert.throws(
  () => createLoopingWalletReadClient({ request: async () => '0x' }),
  /requires a supported execution-chain connection/,
)

const forwardedMethods = []
const wallet = {
  chain: arbitrum,
  async request({ method }) {
    forwardedMethods.push(method)
    if (method === 'eth_chainId') return '0xa4b1'
    if (method === 'eth_call') return '0x'
    throw new Error(`Unexpected test RPC method: ${method}`)
  },
}
const walletReadClient = createLoopingWalletReadClient(wallet)
assert.equal(walletReadClient.chain?.id, arbitrum.id)
assert.equal(walletReadClient.account, undefined)
assert.equal(typeof walletReadClient.sendTransaction, 'undefined')
assert.equal(typeof walletReadClient.signTypedData, 'undefined')
assert.equal(typeof walletReadClient.writeContract, 'undefined')
assert.equal(await walletReadClient.getChainId(), arbitrum.id)
assert.equal(
  await walletReadClient.request({
    method: 'eth_call',
    params: [{ to: '0x0000000000000000000000000000000000000000', data: '0x' }, 'latest'],
  }),
  '0x',
)
assert.deepEqual(forwardedMethods, ['eth_chainId', 'eth_call'])

for (const method of [
  'eth_requestAccounts',
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_sendUserOperation',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData_v4',
  'eth_estimateGas',
  'personal_sign',
  'anvil_setBalance',
  'debug_traceTransaction',
  'wallet_sendCalls',
  'wallet_switchEthereumChain',
]) {
  await assert.rejects(
    walletReadClient.request({ method }),
    new RegExp(`read-only; ${method} is not allowed`),
  )
}
assert.deepEqual(forwardedMethods, ['eth_chainId', 'eth_call'])

console.log('Standalone compiler-canary failover permits provider outages, never safety failures')
const nestedError = (cause) => Object.assign(
  new Error('Unsigned simulation failed.'),
  { code: 'SIMULATION_FAILED', cause },
)
assert.equal(mayUseLoopingWalletReadFallback(nestedError({
  name: 'HttpRequestError',
  message: 'HTTP status 429 from public.1rpc.io',
  code: 429,
})), true)
assert.equal(mayUseLoopingWalletReadFallback(Object.assign(
  new Error('Looping route implementation storage could not be read.'),
  {
    code: 'UNSAFE_WIRING',
    cause: {
      name: 'RpcRequestError',
      message: 'request limit exceeded on 1RPC',
      code: -32005,
    },
  },
)), true)
assert.equal(mayUseLoopingWalletReadFallback(Object.assign(
  new Error('Looping route implementation storage could not be read.'),
  {
    code: 'UNSAFE_WIRING',
    cause: {
      name: 'ContractFunctionExecutionError',
      message: 'execution reverted with revert data',
      code: -32000,
    },
  },
)), false)
assert.equal(mayUseLoopingWalletReadFallback(nestedError({
  name: 'RpcRequestError',
  message: 'rate limit exceeded',
  code: -32000,
})), true)
assert.equal(mayUseLoopingWalletReadFallback(nestedError({
  name: 'RpcRequestError',
  message: 'state override method not supported',
  code: -32601,
})), true)
const oneRpcFailureClient = createPublicClient({
  chain: arbitrum,
  transport: custom({
    async request({ method }) {
      if (method === 'eth_call') {
        throw Object.assign(new Error('Remote Error'), { code: -32603 })
      }
      if (method === 'eth_chainId') return '0xa4b1'
      throw new Error(`Unexpected test RPC method: ${method}`)
    },
  }, {
    retryCount: 0,
  }),
})
let oneRpcPositionError
await assert.rejects(async () => {
  try {
    await oneRpcFailureClient.readContract({
      address: '0x6c247b1F6182318877311737BaC0844bAa518F5e',
      abi: morphoBlueAbi,
      functionName: 'position',
      args: [
        '0x97cb4b88a7a5e8e9c039b106374124e642395437ffc0ef93f2799343ad022985',
        '0x2577Ab25A0a4dd3379Ed6e9D467E3eE26e909487',
      ],
    })
  } catch (error) {
    oneRpcPositionError = error
    throw error
  }
})
assert.ok(oneRpcPositionError)
assert.equal(mayUseLoopingWalletReadFallback(oneRpcPositionError), true)
assert.equal(mayUseLoopingWalletReadFallback(Object.assign(
  new Error('The position changed.'),
  { code: 'STATE_CONFLICT', cause: oneRpcPositionError },
)), false)
assert.equal(mayUseLoopingWalletReadFallback(Object.assign(
  new Error('Looping route implementation storage could not be read.'),
  { code: 'UNSAFE_WIRING', cause: oneRpcPositionError },
)), true)
assert.equal(mayUseLoopingWalletReadFallback(nestedError({
  name: 'RpcRequestError',
  message: 'Internal error',
  code: -32603,
})), false)
const oneRpcQuotaError = nestedError({
  name: 'RpcRequestError',
  message: "You've reached the usage limit for your current plan.",
  code: -32001,
})
assert.equal(mayUseLoopingWalletReadFallback(oneRpcQuotaError), true)
assert.equal(mayUseLoopingWalletReadFallback(Object.assign(
  new Error('The position changed.'),
  { code: 'STATE_CONFLICT', cause: oneRpcQuotaError },
)), false)
assert.equal(mayUseLoopingWalletReadFallback(nestedError({
  name: 'RpcRequestError',
  message: 'Unknown resource.',
  code: -32001,
})), false)
assert.equal(mayUseLoopingWalletReadFallback(nestedError({
  name: 'ContractFunctionExecutionError',
  message: 'The contract function reverted with execution reverted data.',
  code: -32000,
})), false)
assert.equal(mayUseLoopingWalletReadFallback(Object.assign(
  new Error('The position changed.'),
  { code: 'STATE_CONFLICT' },
)), false)
assert.equal(mayUseLoopingWalletReadFallback(Object.assign(
  new Error('The selected route is unsupported.'),
  { code: 'UNSUPPORTED_ROUTE' },
)), false)
assert.equal(mayUseLoopingWalletReadFallback(new Error('Unknown local failure.')), false)

console.log('looping RPC and beta policy checks passed')
