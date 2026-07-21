#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const RAY = 10n ** 27n
const MORPHO_VIRTUAL_ASSETS = 1n
const MORPHO_VIRTUAL_SHARES = 1_000_000n
const BORROW_SHARE_BUFFER_BPS = 50n
const BPS = 10_000n
const MORPHO_MARKET_SELECTOR = '0x5c60e39a'
const PENDLE_READ_TOKENS_SELECTOR = '0x2c8ce6bc'
const SY_GET_TOKENS_IN_SELECTOR = '0x213cae63'
const SY_GET_TOKENS_OUT_SELECTOR = '0x071bc3c9'
const MAX_QUOTE_ROUTES = 16

const CHAINS = {
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    defaultRpc: 'https://ethereum-rpc.publicnode.com',
    rpcEnvs: ['OPENPENDLE_ETH_RPC_URL', 'ETH_RPC_URL'],
    evmVersion: 'osaka',
    lltv: 915_000_000_000_000_000n,
    ptDecimals: 6,
    ptExpiry: 1_796_860_800n,
    aggregators: new Set(['kyberswap', 'odos']),
    addresses: {
      adapter: '0x4a6c312ec70e8747a587ee860a0353cd42be0ae0',
      bundler3: '0x6566194141eefa99af43bb5aa71460ca2dc90245',
      irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc',
      market: '0x13285bcbc27f92b47b4edb99d744c07b48c977c0',
      marketId: '0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64',
      morpho: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
      oracle: '0x217d6ddcdb95112c51657f6270e8c079cfdb51f0',
      pendleSwap: '0xd4f480965d2347d421f1bec7f545682e5ec2151d',
      pt: '0xecfafdc7741323a945a163ed068b5a3c43483957',
      router: '0x888888888889758f76e7103c6cbf23abbf58f946',
      mintSyTokens: ['0x5086bf358635b81d8c47c66d1c8b9e567db70c72'],
      redeemSyTokens: ['0x5086bf358635b81d8c47c66d1c8b9e567db70c72'],
      kyberswapRouter: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
      usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    },
  },
  monad: {
    name: 'Monad',
    chainId: 143,
    defaultRpc: 'https://rpc.monad.xyz',
    rpcEnvs: ['OPENPENDLE_MONAD_RPC_URL', 'MONAD_RPC_URL'],
    evmVersion: 'osaka',
    lltv: 915_000_000_000_000_000n,
    ptDecimals: 6,
    ptExpiry: 1_791_417_600n,
    aggregators: new Set(['kyberswap']),
    addresses: {
      adapter: '0x725ab8cad931bcb80fdbf10955a806765cce00e5',
      bundler3: '0x82b684483e844422fd339df0b67b3b111f02c66e',
      irm: '0x09475a3d6ea8c314c592b1a3799bde044e2f400f',
      market: '0x6f99cf00ee7290ae78a072bb6910ef72d1129fe7',
      marketId: '0x93a7a013b5501cee5d9bee0d29bb3fca790196134c4c7058365e5bc6d2ad80a2',
      morpho: '0xd5d960e8c380b724a48ac59e2dff1b2cb4a1eaee',
      oracle: '0x436ca3263b1aaa57d286823a42e35d8c228e85a2',
      pendleSwap: '0xd4f480965d2347d421f1bec7f545682e5ec2151d',
      pt: '0x9fc74f8ed616b5baf52a170caa97d6d3898602d1',
      router: '0x888888888889758f76e7103c6cbf23abbf58f946',
      mintSyTokens: ['0x00000000efe302beaa2b3e6e1b18d08d69a9012a'],
      redeemSyTokens: ['0x00000000efe302beaa2b3e6e1b18d08d69a9012a'],
      kyberswapRouter: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
      usdc: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
    },
  },
  arbitrum: {
    name: 'Arbitrum',
    chainId: 42161,
    defaultRpc: 'https://arb1.arbitrum.io/rpc',
    rpcEnvs: ['OPENPENDLE_ARB_RPC_URL', 'ARB_RPC_URL'],
    evmVersion: 'osaka',
    lltv: 915_000_000_000_000_000n,
    ptDecimals: 18,
    ptExpiry: 1_792_022_400n,
    aggregators: new Set(['kyberswap']),
    addresses: {
      adapter: '0x9954afb60bb5a222714c478ac86990f221788b88',
      bundler3: '0x1fa4431bc113d308bee1d46b0e98cb805fb48c13',
      irm: '0x66f30587fb8d4206918deb78eca7d5ebbafd06da',
      market: '0xa8a0dea40174cfc30fea9e3a77f182ab33f46e25',
      marketId: '0x97cb4b88a7a5e8e9c039b106374124e642395437ffc0ef93f2799343ad022985',
      morpho: '0x6c247b1f6182318877311737bac0844baa518f5e',
      oracle: '0xaae5194036306a14b6bfe51a255001bd75f315b1',
      pendleSwap: '0xd4f480965d2347d421f1bec7f545682e5ec2151d',
      pt: '0xc9d24ad0bb25f34098e226a8c5192dea7bacccae',
      router: '0x888888888889758f76e7103c6cbf23abbf58f946',
      mintSyTokens: [
        '0x46850ad61c2b7d64d08c9c754f45254596696984',
        '0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef',
      ],
      redeemSyTokens: ['0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef'],
      kyberswapRouter: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
      usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    },
  },
}

// Match the executable Arbitrum beta caps. Larger research fixtures must not
// masquerade as coverage of the production compiler.
const DEFAULT_INITIAL_USDC = 1_000_000n
const DEFAULT_LOOP_USDC = 500_000n
function fail(message) {
  throw new Error(message)
}

function lower(value) {
  return String(value).toLowerCase()
}

function normalizeRpcUrl(value) {
  const candidate = String(value).includes('://') ? String(value) : `https://${value}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    fail('Configured RPC endpoint is not a valid URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    fail('Configured RPC endpoint must use HTTP(S)')
  }
  return parsed.href
}

function divUp(numerator, denominator) {
  if (denominator <= 0n) fail('division denominator must be positive')
  return (numerator + denominator - 1n) / denominator
}

function repaymentCapAssets(borrowAssets) {
  // Permit at most 1% more than the borrowed principal plus two raw USDC
  // units for Morpho's documented round-up behavior.
  return divUp(borrowAssets * 101n, 100n) + 2n
}

function decodeUintWords(data, count, label) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) fail(`${label} returned malformed hex`)
  const body = data.slice(2)
  if (body.length !== count * 64) fail(`${label} returned ${body.length / 64} words instead of ${count}`)
  return Array.from({ length: count }, (_, index) =>
    BigInt(`0x${body.slice(index * 64, (index + 1) * 64)}`),
  )
}

function decodeAddressWord(word, label) {
  if (!/^[0-9a-fA-F]{64}$/.test(word) || !/^0{24}$/i.test(word.slice(0, 24))) fail(`${label} returned a malformed address word`)
  return lower(`0x${word.slice(24)}`)
}

function decodeAddressArray(data, label) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) fail(`${label} returned malformed hex`)
  const body = data.slice(2)
  if (body.length < 128 || body.length % 64 !== 0) fail(`${label} returned malformed dynamic data`)
  const offsetBytes = Number(BigInt(`0x${body.slice(0, 64)}`))
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes !== 32) fail(`${label} returned an unexpected array offset`)
  const length = Number(BigInt(`0x${body.slice(64, 128)}`))
  if (!Number.isSafeInteger(length) || length <= 0 || body.length !== 128 + length * 64) fail(`${label} returned an invalid array length`)
  return Array.from({ length }, (_, index) => decodeAddressWord(body.slice(128 + index * 64, 192 + index * 64), `${label}[${index}]`))
}

async function readSyRouteTokens(rpcUrl, blockTag, chain) {
  const encodedMarketTokens = await jsonRpc(rpcUrl, 'eth_call', [{ to: chain.addresses.market, data: PENDLE_READ_TOKENS_SELECTOR }, blockTag])
  const body = String(encodedMarketTokens).slice(2)
  if (body.length !== 192) fail('Pendle market readTokens() returned malformed data')
  const sy = decodeAddressWord(body.slice(0, 64), 'Pendle SY')
  const pt = decodeAddressWord(body.slice(64, 128), 'Pendle PT')
  if (pt !== chain.addresses.pt) fail(`Pendle market returned unexpected PT ${pt}`)
  const [tokensInData, tokensOutData] = await Promise.all([
    jsonRpc(rpcUrl, 'eth_call', [{ to: sy, data: SY_GET_TOKENS_IN_SELECTOR }, blockTag]),
    jsonRpc(rpcUrl, 'eth_call', [{ to: sy, data: SY_GET_TOKENS_OUT_SELECTOR }, blockTag]),
  ])
  const tokensIn = decodeAddressArray(tokensInData, 'SY getTokensIn()')
  const tokensOut = decodeAddressArray(tokensOutData, 'SY getTokensOut()')
  for (const token of chain.addresses.mintSyTokens) {
    if (!tokensIn.includes(token)) fail(`SY no longer supports allowlisted mint token ${token}`)
  }
  for (const token of chain.addresses.redeemSyTokens) {
    if (!tokensOut.includes(token)) fail(`SY no longer supports allowlisted redeem token ${token}`)
  }
  return { sy, tokensIn, tokensOut }
}

async function morphoBorrowBounds(rpcUrl, blockHex, chain, borrowAssets) {
  const callData = `${MORPHO_MARKET_SELECTOR}${chain.addresses.marketId.slice(2)}`
  const encoded = await jsonRpc(rpcUrl, 'eth_call', [
    { to: chain.addresses.morpho, data: callData },
    blockHex,
  ])
  const [, , totalBorrowAssets, totalBorrowShares, lastUpdate] = decodeUintWords(
    encoded,
    6,
    'Morpho market()',
  )
  if (totalBorrowAssets === 0n || totalBorrowShares === 0n) fail('Morpho borrow market is empty')

  // Morpho will accrue interest immediately before borrowing. Using the
  // stored totals therefore overestimates debt shares when interest is
  // positive; the additional 50 bp share buffer remains an explicit cap.
  const observedBorrowShares = divUp(
    borrowAssets * (totalBorrowShares + MORPHO_VIRTUAL_SHARES),
    totalBorrowAssets + MORPHO_VIRTUAL_ASSETS,
  )
  const maxBorrowShares =
    divUp(observedBorrowShares * (BPS + BORROW_SHARE_BUFFER_BPS), BPS) + 2n
  const minBorrowSharePriceE27 =
    (borrowAssets * RAY) / (maxBorrowShares + 1n) + 1n
  const repaymentCapUsdc = repaymentCapAssets(borrowAssets)

  // This is the largest finite adapter share-price bound whose exact integer
  // rounding cannot authorize more than repaymentCapUsdc for maxBorrowShares.
  const maxRepaySharePriceE27 =
    ((repaymentCapUsdc + 1n) * RAY - 1n) / maxBorrowShares
  const maxAuthorizedRepay = (maxBorrowShares * maxRepaySharePriceE27) / RAY

  const observedBorrowPriceE27 = (borrowAssets * RAY) / observedBorrowShares
  const observedRepayAssets = divUp(
    observedBorrowShares * (totalBorrowAssets + borrowAssets + MORPHO_VIRTUAL_ASSETS),
    totalBorrowShares + observedBorrowShares + MORPHO_VIRTUAL_SHARES,
  )
  const observedRepayPriceE27 = divUp(observedRepayAssets * RAY, observedBorrowShares)
  if (observedBorrowPriceE27 < minBorrowSharePriceE27) {
    fail('Fresh Morpho borrow would exceed the finite debt-share cap')
  }
  if (observedRepayPriceE27 > maxRepaySharePriceE27) {
    fail('Fresh Morpho full repay would exceed the 1% plus two-unit cap')
  }
  if (maxAuthorizedRepay > repaymentCapUsdc) fail('Repay share-price bound exceeds its asset cap')

  return {
    lastUpdate,
    observedBorrowShares,
    maxBorrowShares,
    minBorrowSharePriceE27,
    maxRepaySharePriceE27,
    repaymentCapUsdc,
    maxAuthorizedRepay,
  }
}

function parseUsdc(value, name, fallback) {
  if (value === null) return fallback
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) {
    fail(`${name} must be a positive USDC amount with at most 6 decimals`)
  }
  const [whole, fraction = ''] = value.split('.')
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  if (units <= 1n) fail(`${name} is too small`)
  return units
}

function formatUsdc(units) {
  const whole = units / 1_000_000n
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function formatUnits(units, decimals) {
  const scale = 10n ** BigInt(decimals)
  const whole = units / scale
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

async function jsonRpc(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) fail(`RPC ${method} returned HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.error) fail(`RPC ${method} failed: ${payload.error.message}`)
  return payload.result
}

function parseOptions(argv) {
  const optionValue = (name) => {
    const index = argv.indexOf(name)
    if (index < 0) return null
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`${name} requires a value`)
    return value
  }

  const chainKey = lower(optionValue('--chain') ?? 'arbitrum')
  const chain = CHAINS[chainKey]
  if (!chain) fail(`Unknown chain ${chainKey}; choose ${Object.keys(CHAINS).join(', ')}`)

  const aggregator = lower(optionValue('--aggregator') ?? 'kyberswap')
  if (!chain.aggregators.has(aggregator)) {
    fail(`Untested ${chain.name} aggregator ${aggregator}; choose ${[...chain.aggregators].join(', ')}`)
  }

  const initialUsdc = parseUsdc(
    optionValue('--initial-usdc'),
    '--initial-usdc',
    DEFAULT_INITIAL_USDC,
  )
  const loopUsdc = parseUsdc(
    optionValue('--loop-usdc'),
    '--loop-usdc',
    DEFAULT_LOOP_USDC,
  )
  const maturityLoopUsdc = parseUsdc(
    optionValue('--maturity-loop-usdc'),
    '--maturity-loop-usdc',
    loopUsdc,
  )
  if (maturityLoopUsdc > loopUsdc) {
    fail('--maturity-loop-usdc cannot exceed --loop-usdc')
  }

  return {
    aggregator,
    chain,
    compilerOnly: argv.includes('--compiler-only'),
    initialUsdc,
    loopUsdc,
    maturityLoopUsdc,
    matchTest: optionValue('--match-test'),
    trace: argv.includes('--trace'),
  }
}

async function pendleQuoteRoutes({ tokenIn, tokenOut, amountIn, aggregator, chain }) {
  const addresses = chain.addresses
  const url = new URL(`https://api-v2.pendle.finance/core/v2/sdk/${chain.chainId}/convert`)
  url.searchParams.set('receiver', addresses.adapter)
  url.searchParams.set('slippage', '0.01')
  url.searchParams.set('tokensIn', tokenIn)
  url.searchParams.set('tokensOut', tokenOut)
  url.searchParams.set('amountsIn', amountIn.toString())
  url.searchParams.set('enableAggregator', 'true')
  url.searchParams.set('aggregators', aggregator)

  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) fail(`Pendle quote returned HTTP ${response.status}: ${await response.text()}`)
  const payload = await response.json()
  const routes = payload.routes
  if (!Array.isArray(routes) || routes.length === 0 || routes.length > MAX_QUOTE_ROUTES) {
    fail(`Pendle quote must contain between 1 and ${MAX_QUOTE_ROUTES} routes`)
  }
  return routes
}

function validatePendleRoute(route, { method, aggregator, chain }) {
  const addresses = chain.addresses
  if (!route?.tx?.data || !route?.contractParamInfo) fail('Pendle quote contained no executable route')

  const params = route.contractParamInfo.contractCallParams
  if (route.contractParamInfo.method !== method) fail(`Unexpected Pendle method ${route.contractParamInfo.method}`)
  if (lower(route.tx.to) !== addresses.router) fail(`Unexpected Pendle target ${route.tx.to}`)
  if (lower(params?.[0]) !== addresses.adapter) fail(`Unexpected Pendle receiver ${params?.[0]}`)
  if (lower(params?.[1]) !== addresses.market) fail(`Unexpected Pendle market ${params?.[1]}`)
  if (lower(route.tx.from) !== addresses.adapter) fail(`Unexpected Pendle sender hint ${route.tx.from}`)
  if (BigInt(route.tx.value ?? 0) !== 0n) fail(`Unexpected Pendle native value ${route.tx.value}`)
  const expectedSelector = method === 'swapExactTokenForPt' ? '0xc81f847a' : '0x594a88cc'
  if (lower(route.tx.data.slice(0, 10)) !== expectedSelector) fail(`Unexpected Pendle selector ${route.tx.data.slice(0, 10)}`)

  const returnedAggregator = lower(route.data?.aggregatorType ?? '')
  if (returnedAggregator !== aggregator) {
    fail(`Pendle returned ${route.data?.aggregatorType ?? 'no aggregator'} instead of ${aggregator}`)
  }

  return route
}

async function pendleQuote(args) {
  const routes = await pendleQuoteRoutes(args)
  return validatePendleRoute(routes[0], args)
}

async function pendleExitQuote({
  exactPt,
  minimumRepay,
  onchainTokensOut,
  ...quoteArgs
}) {
  const routes = await pendleQuoteRoutes(quoteArgs)
  const failures = []
  for (const candidate of routes) {
    try {
      const route = validatePendleRoute(candidate, quoteArgs)
      return {
        route,
        validated: validateExit(
          route,
          exactPt,
          minimumRepay,
          quoteArgs.chain,
          onchainTokensOut,
        ),
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  fail(`Pendle returned no strictly valid exit route: ${failures.join(' | ')}`)
}

function validateBuy(route, amountIn, chain, onchainTokensIn) {
  const addresses = chain.addresses
  const params = route.contractParamInfo.contractCallParams
  const input = params[4]
  if (lower(input?.tokenIn) !== addresses.usdc) fail(`Unexpected buy token ${input?.tokenIn}`)
  if (BigInt(input?.netTokenIn) !== amountIn) fail(`Unexpected buy amount ${input?.netTokenIn}`)
  const mintSyToken = lower(input?.tokenMintSy)
  if (!addresses.mintSyTokens.includes(mintSyToken) || !onchainTokensIn.includes(mintSyToken)) {
    fail(`Unexpected or unsupported SY mint token ${input?.tokenMintSy}`)
  }
  validateSwapData(input, chain, lower(route.data?.aggregatorType))
  if (input?.swapData?.needScale !== false) fail('Buy route unexpectedly scales its fixed USDC input')
  validateEmptyLimitData(params[5])
  const minPt = BigInt(params[2])
  const expectedPt = BigInt(route.outputs?.[0]?.amount ?? 0)
  if (lower(route.outputs?.[0]?.token) !== addresses.pt) fail(`Unexpected buy output token ${route.outputs?.[0]?.token}`)
  if (minPt <= 0n || expectedPt < minPt) fail('Invalid PT output bounds')
  return { minPt, expectedPt, mintSyToken }
}

function validateExit(route, exactPt, minimumRepay, chain, onchainTokensOut) {
  const addresses = chain.addresses
  const params = route.contractParamInfo.contractCallParams
  if (BigInt(params[2]) !== exactPt) fail(`Unexpected exit PT amount ${params[2]}`)
  if (lower(params[3]?.tokenOut) !== addresses.usdc) fail(`Unexpected exit token ${params[3]?.tokenOut}`)
  const redeemSyToken = lower(params[3]?.tokenRedeemSy)
  if (!addresses.redeemSyTokens.includes(redeemSyToken) || !onchainTokensOut.includes(redeemSyToken)) {
    fail(`Unexpected or unsupported SY redemption token ${params[3]?.tokenRedeemSy}`)
  }
  validateSwapData(params[3], chain, lower(route.data?.aggregatorType))
  if (params[3]?.swapData?.needScale !== true) fail('Exit route must scale its runtime redemption output')
  validateEmptyLimitData(params[4])
  const minUsdc = BigInt(params[3]?.minTokenOut ?? 0)
  const expectedUsdc = BigInt(route.outputs?.[0]?.amount ?? 0)
  if (lower(route.outputs?.[0]?.token) !== addresses.usdc) fail(`Unexpected exit output token ${route.outputs?.[0]?.token}`)
  if (minUsdc < minimumRepay || expectedUsdc < minUsdc) fail('Exit quote cannot safely repay the bounded loop debt')
  return { minUsdc, expectedUsdc, redeemSyToken }
}

function validateSwapData(tokenIo, chain, aggregator) {
  const addresses = chain.addresses
  const swapData = tokenIo?.swapData
  if (lower(tokenIo?.pendleSwap) !== addresses.pendleSwap) {
    fail(`Unexpected PendleSwap ${tokenIo?.pendleSwap}`)
  }
  if (lower(swapData?.extRouter) === ZERO_ADDRESS) fail('External aggregator router is zero')
  if (aggregator === 'kyberswap' && lower(swapData?.extRouter) !== addresses.kyberswapRouter) {
    fail(`Unexpected KyberSwap router ${swapData?.extRouter}`)
  }
  if (aggregator === 'kyberswap' && lower(swapData?.swapType) !== '1') {
    fail(`Unexpected KyberSwap swap type ${swapData?.swapType}`)
  }
  const extCalldata = String(swapData?.extCalldata ?? '')
  if (!/^0x[0-9a-fA-F]+$/.test(extCalldata) || extCalldata.length <= 10) fail('Aggregator calldata is empty')
}

function validateEmptyLimitData(limit) {
  if (lower(limit?.limitRouter) !== ZERO_ADDRESS) fail(`Unexpected limit router ${limit?.limitRouter}`)
  if (!Array.isArray(limit?.normalFills) || limit.normalFills.length !== 0) fail('Normal limit fills are not empty')
  if (!Array.isArray(limit?.flashFills) || limit.flashFills.length !== 0) fail('Flash limit fills are not empty')
  if (lower(limit?.optData) !== '0x') fail('Limit-order optData is not empty')
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const chain = options.chain
  const addresses = chain.addresses
  const configuredRpcs = chain.rpcEnvs
    .map((name) => process.env[name])
    .filter((value) => typeof value === 'string' && value.length > 0)
  const rpcCandidates = [...new Set(
    [...configuredRpcs, chain.defaultRpc].map(normalizeRpcUrl),
  )]
  let rpcUrl
  let liveSyTokens
  let lastRpcError
  for (const candidate of rpcCandidates) {
    try {
      const candidateChainId = BigInt(await jsonRpc(candidate, 'eth_chainId'))
      if (candidateChainId !== BigInt(chain.chainId)) {
        fail(`RPC is chain ${candidateChainId}, expected ${chain.chainId}`)
      }
      liveSyTokens = await readSyRouteTokens(candidate, 'latest', chain)
      rpcUrl = candidate
      break
    } catch (error) {
      lastRpcError = error
      if (candidate !== rpcCandidates.at(-1)) {
        console.warn(`RPC host ${new URL(candidate).hostname} unavailable; trying fallback`)
      }
    }
  }
  if (!rpcUrl || !liveSyTokens) {
    throw lastRpcError ?? new Error(`No ${chain.name} RPC is available`)
  }
  const rpcHost = new URL(rpcUrl).hostname

  // The focused production-compiler proof obtains and validates its own fresh
  // Pendle routes. Do not make it depend on the separate Solidity fixture's
  // opaque route selection, which is intentionally tested only in the full
  // release-gating run below.
  if (options.compilerOnly) {
    const { runLoopingCompilerForkProof } = await import(
      '../../app/scripts/looping-compiler-fork.mjs'
    )
    await runLoopingCompilerForkProof({
      sourceRpcUrl: rpcUrl,
      initialUsdc: options.initialUsdc,
      loopUsdc: options.loopUsdc,
      maturityLoopUsdc: options.maturityLoopUsdc,
      chainId: chain.chainId,
    })
    return
  }

  const initialRoute = await pendleQuote({
    tokenIn: addresses.usdc,
    tokenOut: addresses.pt,
    amountIn: options.initialUsdc,
    method: 'swapExactTokenForPt',
    aggregator: options.aggregator,
    chain,
  })
  const initial = validateBuy(initialRoute, options.initialUsdc, chain, liveSyTokens.tokensIn)

  const loopRoute = await pendleQuote({
    tokenIn: addresses.usdc,
    tokenOut: addresses.pt,
    amountIn: options.loopUsdc,
    method: 'swapExactTokenForPt',
    aggregator: options.aggregator,
    chain,
  })
  const loop = validateBuy(loopRoute, options.loopUsdc, chain, liveSyTokens.tokensIn)

  // The position promises only the two slippage-protected minimums. Any PT
  // received above those values is swept back to the user as harmless dust.
  const collateral = initial.minPt + loop.minPt
  const repaymentCapUsdc = repaymentCapAssets(options.loopUsdc)
  const { route: exitRoute, validated: exit } = await pendleExitQuote({
    tokenIn: addresses.pt,
    tokenOut: addresses.usdc,
    amountIn: collateral,
    method: 'swapExactPtForToken',
    aggregator: options.aggregator,
    chain,
    exactPt: collateral,
    minimumRepay: repaymentCapUsdc,
    onchainTokensOut: liveSyTokens.tokensOut,
  })

  // Pin a block after all quotes so their external route signatures and the
  // protocol state are evaluated against one deterministic snapshot.
  const blockHex = await jsonRpc(rpcUrl, 'eth_blockNumber')
  const block = BigInt(blockHex)
  const blockData = await jsonRpc(rpcUrl, 'eth_getBlockByNumber', [blockHex, false])
  const timestamp = BigInt(blockData.timestamp)
  if (timestamp >= chain.ptExpiry) fail('The selected PT market has matured')
  const chainId = BigInt(await jsonRpc(rpcUrl, 'eth_chainId'))
  if (chainId !== BigInt(chain.chainId)) fail(`RPC is chain ${chainId}, expected ${chain.chainId}`)
  const pinnedSyTokens = await readSyRouteTokens(rpcUrl, blockHex, chain)
  validateBuy(initialRoute, options.initialUsdc, chain, pinnedSyTokens.tokensIn)
  validateBuy(loopRoute, options.loopUsdc, chain, pinnedSyTokens.tokensIn)
  validateExit(exitRoute, collateral, repaymentCapUsdc, chain, pinnedSyTokens.tokensOut)
  const debtBounds = await morphoBorrowBounds(rpcUrl, blockHex, chain, options.loopUsdc)
  if (debtBounds.repaymentCapUsdc !== repaymentCapUsdc) fail('Repayment cap changed during fixture construction')

  console.log('OpenPendle looping fork fixture')
  console.log(`  Chain: ${chain.name} (${chain.chainId})`)
  console.log(`  Aggregator: ${options.aggregator}`)
  console.log(`  RPC host: ${rpcHost}`)
  console.log(`  ${chain.name} block: ${block}`)
  console.log(
    `  Initial ${formatUsdc(options.initialUsdc)} USDC via ${initial.mintSyToken}: expected ${formatUnits(initial.expectedPt, chain.ptDecimals)} PT, minimum ${formatUnits(initial.minPt, chain.ptDecimals)} PT`,
  )
  console.log(
    `  Callback ${formatUsdc(options.loopUsdc)} USDC via ${loop.mintSyToken}: expected ${formatUnits(loop.expectedPt, chain.ptDecimals)} PT, minimum ${formatUnits(loop.minPt, chain.ptDecimals)} PT`,
  )
  console.log(`  Morpho collateral promise: ${formatUnits(collateral, chain.ptDecimals)} PT`)
  console.log(`  Full exit via ${exit.redeemSyToken}: expected ${formatUsdc(exit.expectedUsdc)} USDC, minimum ${formatUsdc(exit.minUsdc)} USDC`)
  console.log(
    `  Finite Morpho debt: at most ${debtBounds.maxBorrowShares} shares; repayment cap ${formatUsdc(debtBounds.repaymentCapUsdc)} USDC`,
  )

  const forkTestsDir = fileURLToPath(new URL('..', import.meta.url))
  const verbosity = options.trace ? '-vvvv' : '-vv'

  const forgeArgs = [
    'test',
    '--fork-url',
    rpcUrl,
    '--fork-block-number',
    block.toString(),
    '--evm-version',
    chain.evmVersion,
    '--match-path',
    'test/LoopingFork.t.sol',
  ]
  if (options.matchTest) forgeArgs.push('--match-test', options.matchTest)
  forgeArgs.push(verbosity)

  const result = spawnSync(
    'forge',
    forgeArgs,
    {
      cwd: forkTestsDir,
      env: {
        ...process.env,
        OPENPENDLE_LOOPING_FORK: 'true',
        OPENPENDLE_INITIAL_BUY_CALLDATA: initialRoute.tx.data,
        OPENPENDLE_LOOP_BUY_CALLDATA: loopRoute.tx.data,
        OPENPENDLE_FULL_EXIT_CALLDATA: exitRoute.tx.data,
        OPENPENDLE_INITIAL_MIN_PT: initial.minPt.toString(),
        OPENPENDLE_LOOP_MIN_PT: loop.minPt.toString(),
        OPENPENDLE_EXIT_MIN_USDC: exit.minUsdc.toString(),
        OPENPENDLE_INITIAL_USDC: options.initialUsdc.toString(),
        OPENPENDLE_LOOP_BORROW_USDC: options.loopUsdc.toString(),
        OPENPENDLE_MIN_BORROW_SHARE_PRICE_E27: debtBounds.minBorrowSharePriceE27.toString(),
        OPENPENDLE_MAX_REPAY_SHARE_PRICE_E27: debtBounds.maxRepaySharePriceE27.toString(),
        OPENPENDLE_MAX_BORROW_SHARES: debtBounds.maxBorrowShares.toString(),
        OPENPENDLE_REPAYMENT_CAP_USDC: debtBounds.repaymentCapUsdc.toString(),
        OPENPENDLE_MORPHO: addresses.morpho,
        OPENPENDLE_BUNDLER3: addresses.bundler3,
        OPENPENDLE_ADAPTER: addresses.adapter,
        OPENPENDLE_PENDLE_ROUTER: addresses.router,
        OPENPENDLE_LOAN_TOKEN: addresses.usdc,
        OPENPENDLE_COLLATERAL_TOKEN: addresses.pt,
        OPENPENDLE_ORACLE: addresses.oracle,
        OPENPENDLE_IRM: addresses.irm,
        OPENPENDLE_MARKET_ID: addresses.marketId,
        OPENPENDLE_LLTV: chain.lltv.toString(),
      },
      stdio: options.trace ? 'pipe' : 'inherit',
      encoding: options.trace ? 'utf8' : undefined,
      maxBuffer: options.trace ? 64 * 1024 * 1024 : undefined,
    },
  )

  if (result.error) throw result.error
  if (options.trace) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    // Full calldata traces are enormous. The tail contains Foundry's revert
    // backtrace and preserves the actionable failure without printing opaque
    // aggregator payloads into the terminal.
    console.log(output.split('\n').slice(-220).join('\n'))
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    return
  }

  const { runLoopingCompilerForkProof } = await import(
    '../../app/scripts/looping-compiler-fork.mjs'
  )
  await runLoopingCompilerForkProof({
    sourceRpcUrl: rpcUrl,
    initialUsdc: options.initialUsdc,
    loopUsdc: options.loopUsdc,
    maturityLoopUsdc: options.maturityLoopUsdc,
    chainId: chain.chainId,
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
