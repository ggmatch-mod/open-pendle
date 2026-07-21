#!/usr/bin/env node
/** Deterministic, network-free regression checks for the looping transaction builder. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ARBITRUM_LOOPING_CANARY,
  ARBITRUM_LOOPING_CHAIN_ID,
  ARBITRUM_LOOPING_USDT0_USDAI,
  ETHEREUM_LOOPING_CHAIN_ID,
  ETHEREUM_LOOPING_REUSD,
  MONAD_LOOPING_AUSD,
  MONAD_LOOPING_CHAIN_ID,
  LoopingRegistryError,
  getLoopingExecutionCandidateMarket,
  getLoopingExecutionMarket,
  isLoopingExecutionCandidateSupported,
  isLoopingExecutionMarketSupported,
  requireLoopingKyberExecutor,
  requireLoopingRouteAddress,
} from '../src/lib/loopingRegistry.ts'
import {
  bundler3Abi,
  bundler3CallArrayParameters,
  generalAdapter1Abi,
  loopingErc20Abi,
  loopingMulticall3Abi,
  morphoBlueAbi,
  pendleLoopingRouterAbi,
} from '../src/lib/loopingAbi.ts'
import {
  buildLoopingAuthorizationRecoveryIntent,
  buildLoopingAuthorizationNonceBurnIntent,
  buildSignedLoopingEntryBundle,
  buildSignedLoopingExitBundle,
  buildSignedLoopingIncreaseBundle,
  buildSignedLoopingDecreaseBundle,
  buildUnsignedLoopingEntrySimulation,
  buildUnsignedLoopingExitSimulation,
  buildUnsignedLoopingIncreaseSimulation,
  buildUnsignedLoopingDecreaseSimulation,
  classifyExposedLoopingAuthorization,
  decodeExposedLoopingAuthorizationPair,
  LoopingExecutionError,
  fetchPendleLoopingBuyRoute,
  fetchPendleLoopingExitRoute,
  getLoopingAuthorizationStorageSlot,
  prepareLoopingEntryExecution,
  prepareLoopingExitExecution,
  prepareLoopingAdjustmentExecution,
  prepareLoopingIncreaseExecution,
  prepareLoopingDecreaseExecution,
  prepareDirectLoopingAuthorizationRevoke,
  prepareDirectLoopingRescue,
  prepareLoopingAuthorizationNonceBurn,
  readExposedLoopingAuthorizationRecoveryState,
  readExposedLoopingAuthorizationPairFromTransaction,
  readLoopingPositionInventory,
  revalidateSignedLoopingEntry,
  revalidateSignedLoopingExit,
  revalidateSignedLoopingIncrease,
  revalidateSignedLoopingDecrease,
  simulateUnsignedLoopingIntent,
  validateLoopingBuyRoute,
  validateLoopingExitRoute,
  validateLoopingMaturedExitRoute,
  verifyLoopingEntryReceiptState,
  verifyLoopingExitReceiptState,
  verifyLoopingIncreaseReceiptState,
  verifyLoopingDecreaseReceiptState,
} from '../src/lib/loopingExecution.ts'
import * as loopingExecution from '../src/lib/loopingExecution.ts'
import { deriveLoopingBorrowAssets } from '../src/lib/looping.ts'
import { prepareWithPendleQuoteRateLimitRetry } from './looping-compiler-fork.mjs'
import { LOOPING_KYBER_EXECUTOR_RUNTIME } from './fixtures/looping-kyber-executor-runtime.ts'

const market = ARBITRUM_LOOPING_CANARY
const contracts = market.contracts
const policy = market.routePolicy
const upgradePolicy = market.routeUpgradePolicy
const USDC = market.morphoMarketParams.loanToken
const PT = market.morphoMarketParams.collateralToken
const MINT_SY = policy.mintSyTokenAllowlist[0]
const KYBER_ROUTER = policy.externalRouterAllowlist[0]
const KYBER_EXECUTOR = policy.kyber.executorAllowlist[0]
const DYNAMIC_KYBER_RECEIVER = getAddress(
  '0xFC43aAF89A71AcAa644842EE4219E8eB77657427',
)
const ROUTER_IMPLEMENTATION = upgradePolicy.pendleRouter.implementation
const ROUTER_REDEEM_IMPLEMENTATION =
  upgradePolicy.pendleRouter.redeemImplementation
const PENDLE_SWAP_IMPLEMENTATION = upgradePolicy.pendleSwap.implementation
const YT = getAddress('0x1111111111111111111111111111111111111111')
const routeWiring = {
  tokensIn: [...policy.mintSyTokenAllowlist],
  tokensOut: [...policy.redeemSyTokenAllowlist],
  kyberExecutorCodeHashes: {
    [KYBER_EXECUTOR.address.toLowerCase()]: KYBER_EXECUTOR.runtimeCodeHash,
  },
}

function executionCandidate(overrides = {}) {
  return executionCandidateForMarket(market, overrides)
}

function executionCandidateForMarket(executionMarket, overrides = {}) {
  return {
    morpho: {
      chainId: executionMarket.chainId,
      marketId: executionMarket.marketId,
      tuple: executionMarket.morphoMarketParams,
      loanAsset: {
        address: executionMarket.morphoMarketParams.loanToken,
        decimals: executionMarket.loanTokenDecimals,
      },
      collateralAsset: {
        address: executionMarket.morphoMarketParams.collateralToken,
        decimals: executionMarket.collateralTokenDecimals,
      },
      ...overrides.morpho,
    },
    pendle: {
      chainId: executionMarket.chainId,
      market: executionMarket.pendleMarket,
      pt: executionMarket.morphoMarketParams.collateralToken,
      expiry: Number(executionMarket.pendleMarketExpiry),
      ...overrides.pendle,
    },
  }
}

const kyberSwapAbi = parseAbi([
  'function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns (uint256 returnAmount,uint256 gasUsed)',
])

function emptyLimitOrderData() {
  return {
    limitRouter: zeroAddress,
    epsSkipMarket: 0n,
    normalFills: [],
    flashFills: [],
    optData: '0x',
  }
}

function nestedKyberCalldata({
  amountIn,
  srcToken = USDC,
  dstToken = MINT_SY,
  callTarget = KYBER_EXECUTOR.address,
  approveTarget = zeroAddress,
  srcReceivers = [callTarget],
  srcAmounts = [amountIn],
  feeReceivers = [],
  feeAmounts = [],
  dstReceiver = contracts.pendleRouter,
  minReturnAmount = 1n,
  flags = policy.kyber.expectedFlags,
  targetData = '0x12345678',
  permit = '0x',
  clientData = '0x',
} = {}) {
  return encodeFunctionData({
    abi: kyberSwapAbi,
    functionName: 'swap',
    args: [
      {
        callTarget,
        approveTarget,
        targetData,
        desc: {
          srcToken,
          dstToken,
          srcReceivers,
          srcAmounts,
          feeReceivers,
          feeAmounts,
          dstReceiver,
          amount: amountIn,
          minReturnAmount,
          flags,
          permit,
        },
        clientData,
      },
    ],
  })
}

function buyRoute(amountIn, overrides = {}) {
  const minPtOut = overrides.minPtOut ?? 990_000_000_000_000_000n
  const expectedPtOut = overrides.expectedPtOut ?? 1_000_000_000_000_000_000n
  const input = {
    tokenIn: USDC,
    netTokenIn: amountIn,
    tokenMintSy: MINT_SY,
    pendleSwap: contracts.pendleSwap,
    swapData: {
      swapType: policy.swapType,
      extRouter: KYBER_ROUTER,
      extCalldata: nestedKyberCalldata({ amountIn, ...overrides.kyber }),
      needScale: policy.entryNeedScale,
    },
    ...overrides.input,
  }
  const args = [
    contracts.generalAdapter1,
    market.pendleMarket,
    minPtOut,
    {
      guessMin: 1n,
      guessMax: expectedPtOut * 2n,
      guessOffchain: expectedPtOut,
      maxIteration: 32n,
      eps: 100_000_000_000_000n,
      ...overrides.guess,
    },
    input,
    overrides.limit ?? emptyLimitOrderData(),
  ]
  const data = encodeFunctionData({
    abi: pendleLoopingRouterAbi,
    functionName: 'swapExactTokenForPt',
    args,
  })
  return {
    action: 'swapExactTokenForPt',
    inputs: [{ token: USDC, amount: amountIn.toString() }],
    outputs: [{ token: PT, amount: expectedPtOut.toString() }],
    requiredApprovals: [],
    contractParamInfo: { method: 'swapExactTokenForPt' },
    data: { aggregatorType: 'kyberswap' },
    tx: {
      from: contracts.generalAdapter1,
      to: contracts.pendleRouter,
      data,
      ...overrides.tx,
    },
  }
}

function exitRoute(collateral, overrides = {}) {
  const intermediateSy = overrides.intermediateSy ?? 1_500_000_000_000_000_000n
  const minTokenOut = overrides.minTokenOut ?? 1_450_000n
  const expectedTokenOut = overrides.expectedTokenOut ?? 1_460_000n
  const output = {
    tokenOut: USDC,
    minTokenOut,
    tokenRedeemSy: policy.redeemSyTokenAllowlist[0],
    pendleSwap: contracts.pendleSwap,
    swapData: {
      swapType: policy.swapType,
      extRouter: KYBER_ROUTER,
      extCalldata: nestedKyberCalldata({
        amountIn: intermediateSy,
        srcToken: policy.redeemSyTokenAllowlist[0],
        dstToken: USDC,
        ...overrides.kyber,
      }),
      needScale: policy.exitNeedScale,
    },
    ...overrides.output,
  }
  const args = [
    contracts.generalAdapter1,
    market.pendleMarket,
    collateral,
    output,
    overrides.limit ?? emptyLimitOrderData(),
  ]
  const data = encodeFunctionData({
    abi: pendleLoopingRouterAbi,
    functionName: 'swapExactPtForToken',
    args,
  })
  return {
    action: 'swapExactPtForToken',
    inputs: [{ token: PT, amount: collateral.toString() }],
    outputs: [{ token: USDC, amount: expectedTokenOut.toString() }],
    requiredApprovals: [],
    contractParamInfo: { method: 'swapExactPtForToken' },
    data: { aggregatorType: 'kyberswap' },
    tx: {
      from: contracts.generalAdapter1,
      to: contracts.pendleRouter,
      data,
      ...overrides.tx,
    },
  }
}

function directBuyRoute(amountIn, overrides = {}) {
  const { input: inputOverrides = {}, swapData: swapDataOverrides = {} } =
    overrides
  return buyRoute(amountIn, {
    ...overrides,
    input: {
      tokenMintSy: USDC,
      pendleSwap: zeroAddress,
      ...inputOverrides,
      swapData: {
        swapType: 0,
        extRouter: zeroAddress,
        extCalldata: '0x',
        needScale: false,
        ...swapDataOverrides,
      },
    },
  })
}

function directExitRoute(collateral, overrides = {}) {
  const { output: outputOverrides = {}, swapData: swapDataOverrides = {} } =
    overrides
  return exitRoute(collateral, {
    ...overrides,
    output: {
      tokenRedeemSy: USDC,
      pendleSwap: zeroAddress,
      ...outputOverrides,
      swapData: {
        swapType: 0,
        extRouter: zeroAddress,
        extCalldata: '0x',
        needScale: false,
        ...swapDataOverrides,
      },
    },
  })
}

function maturedSyRoute(estimatedSyIn, overrides = {}) {
  const minTokenOut = overrides.minTokenOut ?? 1_450_000n
  const expectedTokenOut = overrides.expectedTokenOut ?? 1_460_000n
  const intermediateSy = overrides.intermediateSy ?? estimatedSyIn
  const direct = overrides.direct === true
  const redeemSyToken = direct ? USDC : policy.redeemSyTokenAllowlist[0]
  const output = direct
    ? {
        tokenOut: USDC,
        minTokenOut,
        tokenRedeemSy: USDC,
        pendleSwap: zeroAddress,
        swapData: {
          swapType: 0,
          extRouter: zeroAddress,
          extCalldata: '0x',
          needScale: false,
        },
      }
    : {
        tokenOut: USDC,
        minTokenOut,
        tokenRedeemSy: redeemSyToken,
        pendleSwap: contracts.pendleSwap,
        swapData: {
          swapType: policy.swapType,
          extRouter: KYBER_ROUTER,
          extCalldata: nestedKyberCalldata({
            amountIn: intermediateSy,
            srcToken: redeemSyToken,
            dstToken: USDC,
            ...overrides.kyber,
          }),
          needScale: policy.exitNeedScale,
        },
      }
  const data = encodeFunctionData({
    abi: pendleLoopingRouterAbi,
    functionName: 'redeemSyToToken',
    args: [
      contracts.generalAdapter1,
      market.standardizedYield,
      estimatedSyIn,
      output,
    ],
  })
  return {
    action: 'redeem-sy',
    inputs: [{ token: market.standardizedYield, amount: estimatedSyIn.toString() }],
    outputs: [{ token: USDC, amount: expectedTokenOut.toString() }],
    requiredApprovals: [],
    contractParamInfo: { method: 'redeemSyToToken' },
    data: overrides.omitAggregatorType
      ? {}
      : { aggregatorType: direct ? 'NONE' : 'kyberswap' },
    tx: {
      from: contracts.generalAdapter1,
      to: contracts.pendleRouter,
      data,
      ...overrides.tx,
    },
  }
}

function expectRegistryError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof LoopingRegistryError)
    assert.equal(error.code, code)
    return true
  })
}

function expectExecutionError(fn, code, message) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof LoopingExecutionError)
    assert.equal(error.code, code)
    if (message !== undefined) assert.match(error.message, message)
    return true
  })
}

async function expectExecutionRejection(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LoopingExecutionError)
    assert.equal(error.code, code)
    if (message !== undefined) assert.match(error.message, message)
    return true
  })
}

console.log('Execution registry accepts only the exact reviewed chain and market')
assert.equal(
  getLoopingExecutionMarket(ARBITRUM_LOOPING_CHAIN_ID, market.marketId),
  market,
)
assert.equal(
  isLoopingExecutionMarketSupported(ARBITRUM_LOOPING_CHAIN_ID, market.marketId),
  true,
)
assert.equal(
  getLoopingExecutionMarket(
    ARBITRUM_LOOPING_CHAIN_ID,
    ARBITRUM_LOOPING_USDT0_USDAI.marketId,
  ),
  ARBITRUM_LOOPING_USDT0_USDAI,
)
assert.equal(
  ARBITRUM_LOOPING_USDT0_USDAI.morphoMarketParams.loanToken,
  getAddress('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'),
)
assert.equal(
  ARBITRUM_LOOPING_USDT0_USDAI.routePolicy,
  market.routePolicy,
)
assert.equal(
  getLoopingExecutionMarket(
    ETHEREUM_LOOPING_CHAIN_ID,
    ETHEREUM_LOOPING_REUSD.marketId,
  ),
  ETHEREUM_LOOPING_REUSD,
)
assert.equal(
  isLoopingExecutionMarketSupported(
    ETHEREUM_LOOPING_CHAIN_ID,
    ETHEREUM_LOOPING_REUSD.marketId,
  ),
  true,
)
assert.equal(ETHEREUM_LOOPING_REUSD.loanTokenDecimals, 6)
assert.equal(ETHEREUM_LOOPING_REUSD.collateralTokenDecimals, 6)
assert.notEqual(
  ETHEREUM_LOOPING_REUSD.runtimeCodePolicy.morpho,
  market.runtimeCodePolicy.morpho,
)
assert.notEqual(
  ETHEREUM_LOOPING_REUSD.runtimeCodePolicy.generalAdapter1,
  market.runtimeCodePolicy.generalAdapter1,
)
assert.notEqual(
  ETHEREUM_LOOPING_REUSD.runtimeCodePolicy.pendleSwapImplementation,
  market.runtimeCodePolicy.pendleSwapImplementation,
)
assert.notEqual(
  ETHEREUM_LOOPING_REUSD.runtimeCodePolicy.kyberRouter,
  market.runtimeCodePolicy.kyberRouter,
)
assert.equal(
  getLoopingExecutionMarket(MONAD_LOOPING_CHAIN_ID, MONAD_LOOPING_AUSD.marketId),
  MONAD_LOOPING_AUSD,
)
assert.equal(
  isLoopingExecutionMarketSupported(
    MONAD_LOOPING_CHAIN_ID,
    MONAD_LOOPING_AUSD.marketId,
  ),
  true,
)
assert.equal(MONAD_LOOPING_AUSD.loanTokenDecimals, 6)
assert.equal(MONAD_LOOPING_AUSD.collateralTokenDecimals, 6)
assert.equal(
  MONAD_LOOPING_AUSD.contracts.morpho,
  getAddress('0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee'),
)
assert.equal(
  MONAD_LOOPING_AUSD.contracts.generalAdapter1,
  getAddress('0x725AB8CAd931BCb80Fdbf10955a806765cCe00e5'),
)
assert.equal(
  MONAD_LOOPING_AUSD.routeUpgradePolicy.pendleRouter.implementation,
  getAddress('0xbb0Dd79794e58795b08b599297ec55a6Afb6AB58'),
)
assert.equal(
  MONAD_LOOPING_AUSD.routeUpgradePolicy.pendleSwap.implementation,
  getAddress('0x7fbA4Da81B80a6BfFc337eF9D593047d6f84fe8C'),
)
assert.equal(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.morpho,
  '0xb7a6b485eae3ae09fa451369d5001078c2b5a0a409b7a5908ff080b54f68acce',
)
assert.equal(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.generalAdapter1,
  '0xc33e1de8456b2194f397dccb67f24290a8a5d2db896c892c42a7087196f45b08',
)
assert.equal(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.pendleRouter,
  '0xede7d999cb3da0979eaa44b51d5688f7e4185eab224cac8c295c1702350a12ed',
)
assert.equal(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.pendleRouterImplementation,
  '0x1f4fbfa10c4493836243d3325e486dd3e241cee5e715d00b68540ab8eed76181',
)
assert.equal(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.pendleSwap,
  '0x692d6f336da9d107e0eeb1d7844190b769d97c75ca4fe0d8f3ba655bb8eea8fa',
)
assert.equal(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.pendleSwapImplementation,
  '0xfb6d176d787231bdf5ee4c4a25e802dc1919f61988cbffb386f14a5400f726fa',
)
assert.equal(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.kyberRouter,
  '0x73055c10f463ef7d44c444ccae0b71ab4cacaf67aedbad2cd8af639d53cc6316',
)
assert.notEqual(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.morpho,
  market.runtimeCodePolicy.morpho,
)
assert.notEqual(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.generalAdapter1,
  market.runtimeCodePolicy.generalAdapter1,
)
assert.notEqual(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.pendleRouter,
  market.runtimeCodePolicy.pendleRouter,
)
assert.notEqual(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.pendleRouterImplementation,
  market.runtimeCodePolicy.pendleRouterImplementation,
)
assert.notEqual(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.pendleSwap,
  market.runtimeCodePolicy.pendleSwap,
)
assert.notEqual(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.pendleSwapImplementation,
  market.runtimeCodePolicy.pendleSwapImplementation,
)
assert.notEqual(
  MONAD_LOOPING_AUSD.runtimeCodePolicy.kyberRouter,
  market.runtimeCodePolicy.kyberRouter,
)
assert.equal(
  isLoopingExecutionMarketSupported(
    ARBITRUM_LOOPING_CHAIN_ID,
    MONAD_LOOPING_AUSD.marketId,
  ),
  false,
)
assert.equal(isLoopingExecutionMarketSupported(1, market.marketId), false)
assert.equal(
  isLoopingExecutionMarketSupported(
    ARBITRUM_LOOPING_CHAIN_ID,
    `0x${'11'.repeat(32)}`,
  ),
  false,
)
expectRegistryError(
  () => getLoopingExecutionMarket(ARBITRUM_LOOPING_CHAIN_ID, '0x1234'),
  'INVALID_MARKET_ID',
)
expectRegistryError(
  () => getLoopingExecutionMarket(1, market.marketId),
  'MARKET_NOT_ALLOWLISTED',
)
assert.equal(
  requireLoopingRouteAddress(market, 'externalRouter', KYBER_ROUTER),
  KYBER_ROUTER,
)
expectRegistryError(
  () =>
    requireLoopingRouteAddress(
      market,
      'externalRouter',
      getAddress('0x1111111111111111111111111111111111111111'),
    ),
  'ADDRESS_NOT_ALLOWLISTED',
)
assert.equal(
  requireLoopingKyberExecutor(
    market,
    KYBER_EXECUTOR.address,
    KYBER_EXECUTOR.runtimeCodeHash,
  ),
  KYBER_EXECUTOR,
)

console.log('Directory candidates require the exact reviewed Pendle and Morpho identity')
assert.equal(getLoopingExecutionCandidateMarket(executionCandidate()), market)
assert.equal(isLoopingExecutionCandidateSupported(executionCandidate()), true)
const monadExecutionCandidate = {
  morpho: {
    chainId: MONAD_LOOPING_CHAIN_ID,
    marketId:
      '0x93a7a013b5501cee5d9bee0d29bb3fca790196134c4c7058365e5bc6d2ad80a2',
    tuple: {
      loanToken: getAddress('0x754704Bc059F8C67012fEd69BC8A327a5aafb603'),
      collateralToken: getAddress('0x9FC74f8Ed616B5BaF52a170caa97d6d3898602d1'),
      oracle: getAddress('0x436CA3263B1AAA57d286823a42E35d8c228e85a2'),
      irm: getAddress('0x09475a3D6eA8c314c592b1a3799bDE044E2F400F'),
      lltv: 915_000_000_000_000_000n,
    },
    loanAsset: {
      address: getAddress('0x754704Bc059F8C67012fEd69BC8A327a5aafb603'),
      decimals: 6,
    },
    collateralAsset: {
      address: getAddress('0x9FC74f8Ed616B5BaF52a170caa97d6d3898602d1'),
      decimals: 6,
    },
  },
  pendle: {
    chainId: MONAD_LOOPING_CHAIN_ID,
    market: getAddress('0x6f99cf00ee7290ae78a072bb6910ef72d1129fe7'),
    pt: getAddress('0x9FC74f8Ed616B5BaF52a170caa97d6d3898602d1'),
    expiry: 1_791_417_600,
  },
}
assert.equal(
  getLoopingExecutionCandidateMarket(monadExecutionCandidate),
  MONAD_LOOPING_AUSD,
)
assert.equal(isLoopingExecutionCandidateSupported(monadExecutionCandidate), true)
assert.equal(
  isLoopingExecutionCandidateSupported(
    {
      ...monadExecutionCandidate,
      pendle: {
        ...monadExecutionCandidate.pendle,
        chainId: ARBITRUM_LOOPING_CHAIN_ID,
      },
    },
  ),
  false,
)
assert.equal(
  isLoopingExecutionCandidateSupported(executionCandidate({
    pendle: { market: getAddress('0x1111111111111111111111111111111111111111') },
  })),
  false,
)
assert.equal(
  isLoopingExecutionCandidateSupported(executionCandidate({
    pendle: { expiry: Number(market.pendleMarketExpiry) + 1 },
  })),
  false,
)
assert.equal(
  isLoopingExecutionCandidateSupported(executionCandidate({
    morpho: {
      loanAsset: {
        address: market.morphoMarketParams.loanToken,
        decimals: market.loanTokenDecimals + 1,
      },
    },
  })),
  false,
)
expectRegistryError(
  () => getLoopingExecutionCandidateMarket(executionCandidate({
    pendle: { pt: getAddress('0x1111111111111111111111111111111111111111') },
  })),
  'MARKET_NOT_ALLOWLISTED',
)

console.log('Route proxy, selector, implementation, and router pins are exact')
assert.equal(
  market.runtimeCodePolicy.pendleRouter,
  '0x6e7e96418259651300fbc9b9035c0613bfefc601ddbd840ab39a068ab3ee4293',
)
assert.deepEqual(
  upgradePolicy.pendleRouter.selectorImplementationSlots,
  [
    {
      selector: '0xc81f847a',
      storageSlot:
        '0xb820d981672246ed2ae2a03a3d77375d8c0576df8bfcece9761c680a952be441',
    },
    {
      selector: '0x594a88cc',
      storageSlot:
        '0x89ba60bec361b63cc61987f4256981640e7591ee7c9f24b02af2c6fb517cf783',
    },
    {
      selector: '0x47f1de22',
      storageSlot:
        '0x6734da2a1f646755e54dcb758d0c7e0fe931aba0c85863dd8c0a6bdec717cb9c',
    },
  ],
)
assert.equal(
  market.runtimeCodePolicy.pendleRouterImplementation,
  '0x5e98f3973c2fdabae1168b4afe928c16d4ca9d71803efeacd978fc3bb3898063',
)
assert.equal(
  market.runtimeCodePolicy.pendleRouterRedeemImplementation,
  '0x24634730bd528871bc7aada351e5332505c9a51746535b15f377b9978372aed9',
)
assert.equal(
  market.runtimeCodePolicy.pendleSwap,
  '0x114e0fcd5f3bdf77cbeefc2f92930a8d648fe71f3ba30b23248bde2507c2f266',
)
assert.equal(
  upgradePolicy.pendleSwap.implementationStorageSlot,
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
)
assert.equal(
  market.runtimeCodePolicy.pendleSwapImplementation,
  '0x5d9d2986245b2745643f17ad845576f72ba13ad28ad45a362e75470340e36894',
)
assert.equal(
  market.runtimeCodePolicy.kyberRouter,
  '0x7c53f923286b51431195fc137a16cb9461662b5ae2476353979a52daa527aeaa',
)
expectRegistryError(
  () =>
    requireLoopingKyberExecutor(
      market,
      KYBER_EXECUTOR.address,
      `0x${'22'.repeat(32)}`,
    ),
  'CODE_HASH_NOT_ALLOWLISTED',
)

// Keep the synthetic fixture honest before exercising the production parser.
const fixture = buyRoute(1_000_000n)
const decodedFixture = decodeFunctionData({
  abi: pendleLoopingRouterAbi,
  data: fixture.tx.data,
})
assert.equal(decodedFixture.functionName, 'swapExactTokenForPt')
assert.equal(
  fixture.tx.data.slice(0, 10),
  upgradePolicy.pendleRouter.selectorImplementationSlots[0].selector,
)
assert.equal(decodedFixture.args[4].netTokenIn, 1_000_000n)
const decodedExitFixture = decodeFunctionData({
  abi: pendleLoopingRouterAbi,
  data: exitRoute(1_500_000_000_000_000_000n).tx.data,
})
assert.equal(decodedExitFixture.functionName, 'swapExactPtForToken')
assert.equal(
  exitRoute(1_500_000_000_000_000_000n).tx.data.slice(0, 10),
  upgradePolicy.pendleRouter.selectorImplementationSlots[1].selector,
)
assert.equal(decodedExitFixture.args[2], 1_500_000_000_000_000_000n)

console.log('Strict route validation binds both Pendle and nested Kyber calldata')
const validatedBuy = validateLoopingBuyRoute({
  route: fixture,
  market,
  wiring: routeWiring,
  amountIn: 1_000_000n,
})
assert.equal(validatedBuy.kind, 'buy-pt')
assert.equal(validatedBuy.minPtOut, 990_000_000_000_000_000n)
assert.equal(validatedBuy.mintSyToken, MINT_SY)
assert.equal(validatedBuy.kyberExecutor, KYBER_EXECUTOR.address)

const directMarket = {
  ...market,
  routePolicy: {
    ...market.routePolicy,
    mintSyTokenAllowlist: [USDC],
    redeemSyTokenAllowlist: [USDC],
  },
}
const directWiring = {
  tokensIn: [USDC],
  tokensOut: [USDC],
  kyberExecutorCodeHashes: {},
}
const validatedDirectBuy = validateLoopingBuyRoute({
  route: directBuyRoute(1_000_000n),
  market: directMarket,
  wiring: directWiring,
  amountIn: 1_000_000n,
})
assert.equal(validatedDirectBuy.kind, 'buy-pt')
assert.equal(validatedDirectBuy.mintSyToken, USDC)
assert.equal(validatedDirectBuy.kyberExecutor, null)
assert.equal(validatedDirectBuy.kyberMinReturn, 0n)

const lowDecimalQuotedRoute = buyRoute(500_000n, {
  guess: { eps: 200_030_004_500_675n },
  kyber: { amountIn: 500_000n },
  input: { netTokenIn: 500_000n },
})
const lowDecimalQuotedCalldata = decodeFunctionData({
  abi: pendleLoopingRouterAbi,
  data: lowDecimalQuotedRoute.tx.data,
})
const lowDecimalValidatedBuy = validateLoopingBuyRoute({
  route: lowDecimalQuotedRoute,
  market,
  wiring: routeWiring,
  amountIn: 500_000n,
})
const lowDecimalExecutableCalldata = decodeFunctionData({
  abi: pendleLoopingRouterAbi,
  data: lowDecimalValidatedBuy.calldata,
})
assert.notEqual(lowDecimalValidatedBuy.calldata, lowDecimalQuotedRoute.tx.data)
assert.equal(
  lowDecimalExecutableCalldata.args[3].eps,
  100_000_000_000_000n,
)
assert.deepEqual(
  {
    ...lowDecimalExecutableCalldata.args[3],
    eps: lowDecimalQuotedCalldata.args[3].eps,
  },
  lowDecimalQuotedCalldata.args[3],
)
assert.deepEqual(
  [
    ...lowDecimalExecutableCalldata.args.slice(0, 3),
    ...lowDecimalExecutableCalldata.args.slice(4),
  ],
  [
    ...lowDecimalQuotedCalldata.args.slice(0, 3),
    ...lowDecimalQuotedCalldata.args.slice(4),
  ],
)

for (const eps of [0n, 1_000_000_000_000_001n]) {
  expectExecutionError(
    () =>
      validateLoopingBuyRoute({
        route: buyRoute(1_000_000n, { guess: { eps } }),
        market,
        wiring: routeWiring,
        amountIn: 1_000_000n,
      }),
    'ROUTE_NOT_ALLOWED',
  )
}

const dynamicReceiverBuy = validateLoopingBuyRoute({
  route: buyRoute(1_000_000n, {
    kyber: { srcReceivers: [DYNAMIC_KYBER_RECEIVER] },
  }),
  market,
  wiring: routeWiring,
  amountIn: 1_000_000n,
})
assert.equal(dynamicReceiverBuy.kind, 'buy-pt')

const splitReceiverBuy = validateLoopingBuyRoute({
  route: buyRoute(1_000_000n, {
    kyber: {
      srcReceivers: [DYNAMIC_KYBER_RECEIVER, KYBER_EXECUTOR.address],
      srcAmounts: [400_000n, 600_000n],
    },
  }),
  market,
  wiring: routeWiring,
  amountIn: 1_000_000n,
})
assert.equal(splitReceiverBuy.kind, 'buy-pt')

const COLLATERAL = 1_500_000_000_000_000_000n
const validatedExit = validateLoopingExitRoute({
  route: exitRoute(COLLATERAL),
  market,
  wiring: routeWiring,
  collateral: COLLATERAL,
  repaymentCapAssets: 1_400_000n,
  minimumReturnedAssets: 50_000n,
})
assert.equal(validatedExit.kind, 'sell-pt')
assert.equal(validatedExit.exactPtIn, COLLATERAL)
assert.equal(validatedExit.minLoanTokenOut, 1_450_000n)

const validatedDirectExit = validateLoopingExitRoute({
  route: directExitRoute(COLLATERAL),
  market: directMarket,
  wiring: directWiring,
  collateral: COLLATERAL,
  repaymentCapAssets: 1_400_000n,
  minimumReturnedAssets: 50_000n,
})
assert.equal(validatedDirectExit.kind, 'sell-pt')
assert.equal(validatedDirectExit.redeemSyToken, USDC)
assert.equal(validatedDirectExit.kyberExecutor, null)
assert.equal(validatedDirectExit.kyberMinReturn, 0n)

const directMarketWithMultipleSyTokens = {
  ...directMarket,
  routePolicy: {
    ...directMarket.routePolicy,
    mintSyTokenAllowlist: [USDC, MINT_SY],
    redeemSyTokenAllowlist: [USDC, MINT_SY],
  },
}
const directWiringWithMultipleSyTokens = {
  ...directWiring,
  tokensIn: [USDC, MINT_SY],
  tokensOut: [USDC, MINT_SY],
}
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: directBuyRoute(1_000_000n, {
        input: { tokenMintSy: MINT_SY },
      }),
      market: directMarketWithMultipleSyTokens,
      wiring: directWiringWithMultipleSyTokens,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)
expectExecutionError(
  () =>
    validateLoopingExitRoute({
      route: directExitRoute(COLLATERAL, {
        output: { tokenRedeemSy: MINT_SY },
      }),
      market: directMarketWithMultipleSyTokens,
      wiring: directWiringWithMultipleSyTokens,
      collateral: COLLATERAL,
      repaymentCapAssets: 1_400_000n,
      minimumReturnedAssets: 50_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)
for (const directRoute of [
  directBuyRoute(1_000_000n),
  directExitRoute(COLLATERAL),
]) {
  expectExecutionError(
    () =>
      directRoute.contractParamInfo.method === 'swapExactTokenForPt'
        ? validateLoopingBuyRoute({
            route: { ...directRoute, data: { aggregatorType: 'NONE' } },
            market: directMarket,
            wiring: directWiring,
            amountIn: 1_000_000n,
          })
        : validateLoopingExitRoute({
            route: { ...directRoute, data: { aggregatorType: 'NONE' } },
            market: directMarket,
            wiring: directWiring,
            collateral: COLLATERAL,
            repaymentCapAssets: 1_400_000n,
            minimumReturnedAssets: 50_000n,
          }),
    'ROUTE_NOT_ALLOWED',
  )
}

for (const swapData of [
  { swapType: 1 },
  { extRouter: KYBER_ROUTER },
  { extCalldata: '0x1234' },
  { needScale: true },
]) {
  expectExecutionError(
    () =>
      validateLoopingBuyRoute({
        route: directBuyRoute(1_000_000n, { swapData }),
        market: directMarket,
        wiring: directWiring,
        amountIn: 1_000_000n,
      }),
    'ROUTE_NOT_ALLOWED',
  )
  expectExecutionError(
    () =>
      validateLoopingExitRoute({
        route: directExitRoute(COLLATERAL, { swapData }),
        market: directMarket,
        wiring: directWiring,
        collateral: COLLATERAL,
        repaymentCapAssets: 1_400_000n,
        minimumReturnedAssets: 50_000n,
      }),
    'ROUTE_NOT_ALLOWED',
  )
}
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: directBuyRoute(1_000_000n, {
        input: { pendleSwap: contracts.pendleSwap },
      }),
      market: directMarket,
      wiring: directWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)
expectExecutionError(
  () =>
    validateLoopingExitRoute({
      route: directExitRoute(COLLATERAL, {
        output: { pendleSwap: contracts.pendleSwap },
      }),
      market: directMarket,
      wiring: directWiring,
      collateral: COLLATERAL,
      repaymentCapAssets: 1_400_000n,
      minimumReturnedAssets: 50_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)

const ESTIMATED_MATURED_SY = 1_400_000_000_000_000_000n
const validatedMaturedExit = validateLoopingMaturedExitRoute({
  route: maturedSyRoute(ESTIMATED_MATURED_SY),
  market,
  wiring: routeWiring,
  collateral: COLLATERAL,
  estimatedSyIn: ESTIMATED_MATURED_SY,
  yieldToken: YT,
  repaymentCapAssets: 1_400_000n,
  minimumReturnedAssets: 50_000n,
})
assert.equal(validatedMaturedExit.kind, 'redeem-matured-pt')
assert.equal(validatedMaturedExit.exactPtIn, COLLATERAL)
assert.equal(validatedMaturedExit.estimatedSyIn, ESTIMATED_MATURED_SY)
assert.equal(validatedMaturedExit.kyberExecutor, KYBER_EXECUTOR.address)
const decodedMaturedExit = decodeFunctionData({
  abi: pendleLoopingRouterAbi,
  data: validatedMaturedExit.calldata,
})
assert.equal(decodedMaturedExit.functionName, 'redeemPyToToken')
assert.equal(
  validatedMaturedExit.calldata.slice(0, 10),
  upgradePolicy.pendleRouter.selectorImplementationSlots[2].selector,
)
assert.equal(decodedMaturedExit.args[1], YT)
assert.equal(decodedMaturedExit.args[2], COLLATERAL)
expectExecutionError(
  () =>
    validateLoopingMaturedExitRoute({
      route: maturedSyRoute(ESTIMATED_MATURED_SY, {
        minTokenOut: 1_449_999n,
      }),
      market,
      wiring: routeWiring,
      collateral: COLLATERAL,
      estimatedSyIn: ESTIMATED_MATURED_SY,
      yieldToken: YT,
      repaymentCapAssets: 1_400_000n,
      minimumReturnedAssets: 50_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /bounded debt repayment and minimum wallet return/,
)

const directMaturityMarket = {
  ...market,
  routePolicy: {
    ...market.routePolicy,
    redeemSyTokenAllowlist: [USDC],
  },
}
for (const omitAggregatorType of [false, true]) {
  const directMaturedExit = validateLoopingMaturedExitRoute({
    route: maturedSyRoute(ESTIMATED_MATURED_SY, {
      direct: true,
      omitAggregatorType,
    }),
    market: directMaturityMarket,
    wiring: {
      ...routeWiring,
      tokensOut: [USDC],
    },
    collateral: COLLATERAL,
    estimatedSyIn: ESTIMATED_MATURED_SY,
    yieldToken: YT,
    repaymentCapAssets: 1_400_000n,
    minimumReturnedAssets: 50_000n,
  })
  assert.equal(directMaturedExit.kind, 'redeem-matured-pt')
  assert.equal(directMaturedExit.kyberExecutor, null)
  assert.equal(directMaturedExit.kyberMinReturn, 0n)
}

expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, { tx: { value: '1' } }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        limit: { ...emptyLimitOrderData(), epsSkipMarket: 1n },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)
assert.throws(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        input: {
          tokenMintSy: getAddress('0x1111111111111111111111111111111111111111'),
        },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  (error) =>
    (error instanceof LoopingExecutionError && error.code === 'ROUTE_NOT_ALLOWED') ||
    (error instanceof LoopingRegistryError &&
      error.code === 'ADDRESS_NOT_ALLOWLISTED'),
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, { kyber: { flags: 513n } }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /nested Kyber flags changed/,
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        kyber: {
          srcReceivers: [DYNAMIC_KYBER_RECEIVER, KYBER_EXECUTOR.address],
          srcAmounts: [1_000_000n],
        },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /receiver\/amount structure changed/,
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        kyber: { srcReceivers: [zeroAddress] },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /receiver\/amount structure changed/,
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        kyber: {
          srcReceivers: [DYNAMIC_KYBER_RECEIVER],
          srcAmounts: [0n],
        },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /receiver\/amount structure changed/,
)
for (const invalidTotal of [999_999n, 1_000_001n]) {
  expectExecutionError(
    () =>
      validateLoopingBuyRoute({
        route: buyRoute(1_000_000n, {
          kyber: {
            srcReceivers: [DYNAMIC_KYBER_RECEIVER],
            srcAmounts: [invalidTotal],
          },
        }),
        market,
        wiring: routeWiring,
        amountIn: 1_000_000n,
      }),
    'ROUTE_NOT_ALLOWED',
    /nested Kyber input amount changed/,
  )
}
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        kyber: {
          srcReceivers: Array(
            policy.kyber.maxSourceReceivers + 1,
          ).fill(DYNAMIC_KYBER_RECEIVER),
          srcAmounts: Array(policy.kyber.maxSourceReceivers + 1).fill(1n),
        },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /receiver\/amount structure changed/,
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        kyber: {
          srcToken: getAddress('0x1111111111111111111111111111111111111111'),
        },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /nested Kyber tokens changed/,
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        kyber: {
          dstReceiver: getAddress('0x1111111111111111111111111111111111111111'),
        },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /nested Kyber destination changed/,
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        kyber: {
          feeReceivers: [DYNAMIC_KYBER_RECEIVER],
          feeAmounts: [1n],
        },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /nested Kyber fees changed/,
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, { kyber: { permit: '0x1234' } }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
  /nested Kyber permit changed/,
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, { kyber: { targetData: '0x' } }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        kyber: {
          targetData: `0x${'11'.repeat(policy.kyber.maxTargetDataBytes + 1)}`,
        },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: buyRoute(1_000_000n, {
        kyber: {
          clientData: `0x${'22'.repeat(policy.kyber.maxClientDataBytes + 1)}`,
        },
      }),
      market,
      wiring: routeWiring,
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)
expectExecutionError(
  () =>
    validateLoopingBuyRoute({
      route: fixture,
      market,
      wiring: {
        ...routeWiring,
        kyberExecutorCodeHashes: {
          [KYBER_EXECUTOR.address.toLowerCase()]: `0x${'33'.repeat(32)}`,
        },
      },
      amountIn: 1_000_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)
expectExecutionError(
  () =>
    validateLoopingExitRoute({
      route: exitRoute(COLLATERAL, { minTokenOut: 1_399_999n }),
      market,
      wiring: routeWiring,
      collateral: COLLATERAL,
      repaymentCapAssets: 1_400_000n,
      minimumReturnedAssets: 50_000n,
    }),
  'ROUTE_NOT_ALLOWED',
)

console.log('The v3 POST is exact, accepts HTTP 201, and selects a later valid route')
let capturedUrl
let capturedInit
const buyFetcher = async (url, init) => {
  capturedUrl = String(url)
  capturedInit = init
  return new Response(
    JSON.stringify({
      action: 'swap',
      inputs: [{ token: USDC, amount: '1000000' }],
      requiredApprovals: [{ token: USDC, amount: '1000000' }],
      routes: [buyRoute(1_000_000n, { tx: { value: '1' } }), fixture],
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  )
}
const fetchedBuy = await fetchPendleLoopingBuyRoute({
  market,
  wiring: routeWiring,
  amountIn: 1_000_000n,
  fetcher: buyFetcher,
  now: () => 1_784_400_000_000,
})
assert.equal(fetchedBuy.quotedAtMs, 1_784_400_000_000)
assert.equal(fetchedBuy.route.calldata, fixture.tx.data)
assert.equal(
  capturedUrl,
  `https://api-v2.pendle.finance/core/v3/sdk/${market.chainId}/convert`,
)
assert.equal(capturedInit.method, 'POST')
assert.equal(capturedInit.cache, 'no-store')
assert.equal(capturedInit.credentials, 'omit')
const buyBody = JSON.parse(capturedInit.body)
assert.deepEqual(buyBody, {
  receiver: contracts.generalAdapter1,
  slippage: market.launchPolicy.quoteSlippage,
  enableAggregator: true,
  aggregators: ['kyberswap'],
  inputs: [{ token: USDC, amount: '1000000' }],
  outputs: [PT],
  redeemRewards: false,
  needScale: false,
  useLimitOrder: false,
})

const originalGlobalFetch = globalThis.fetch
let boundDefaultFetchCalls = 0
globalThis.fetch = async function boundFetch(_url, _init) {
  assert.equal(this, globalThis)
  boundDefaultFetchCalls += 1
  return new Response(
    JSON.stringify({
      action: 'swap',
      inputs: [{ token: USDC, amount: '1000000' }],
      requiredApprovals: [{ token: USDC, amount: '1000000' }],
      routes: [fixture],
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  )
}
try {
  const defaultFetchBuy = await fetchPendleLoopingBuyRoute({
    market,
    wiring: routeWiring,
    amountIn: 1_000_000n,
  })
  assert.equal(defaultFetchBuy.route.calldata, fixture.tx.data)
  assert.equal(boundDefaultFetchCalls, 1)
} finally {
  globalThis.fetch = originalGlobalFetch
}

let recoveredTransportAttempts = 0
const recoveredBuy = await fetchPendleLoopingBuyRoute({
  market,
  wiring: routeWiring,
  amountIn: 1_000_000n,
  fetcher: async () => {
    recoveredTransportAttempts += 1
    if (recoveredTransportAttempts === 1) throw new TypeError('Failed to fetch')
    return new Response(
      JSON.stringify({
        action: 'swap',
        inputs: [{ token: USDC, amount: '1000000' }],
        requiredApprovals: [{ token: USDC, amount: '1000000' }],
        routes: [fixture],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  },
})
assert.equal(recoveredTransportAttempts, 2)
assert.equal(recoveredBuy.route.calldata, fixture.tx.data)

let failedTransportAttempts = 0
await assert.rejects(
  fetchPendleLoopingBuyRoute({
    market,
    wiring: routeWiring,
    amountIn: 1_000_000n,
    fetcher: async () => {
      failedTransportAttempts += 1
      throw new TypeError('Failed to fetch')
    },
  }),
  (error) => {
    assert.ok(error instanceof LoopingExecutionError)
    assert.equal(error.code, 'INVALID_QUOTE')
    assert.match(error.message, /after one retry: Failed to fetch\. No wallet action was taken\./)
    return true
  },
)
assert.equal(failedTransportAttempts, 2)

const fetchedExit = await fetchPendleLoopingExitRoute({
  market,
  wiring: routeWiring,
  amountIn: COLLATERAL,
  repaymentCapAssets: 1_400_000n,
  minimumReturnedAssets: 50_000n,
  fetcher: async () =>
    new Response(
      JSON.stringify({
        action: 'swap',
        inputs: [{ token: PT, amount: COLLATERAL.toString() }],
        routes: [exitRoute(COLLATERAL)],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    ),
  now: () => 1_784_400_001_000,
})
assert.equal(fetchedExit.route.exactPtIn, COLLATERAL)

const LOSSLESS_AMOUNT = 9_007_199_254_740_993n
let losslessBody
await fetchPendleLoopingBuyRoute({
  market,
  wiring: routeWiring,
  amountIn: LOSSLESS_AMOUNT,
  fetcher: async (_url, init) => {
    losslessBody = JSON.parse(init.body)
    return new Response(
      JSON.stringify({
        action: 'swap',
        inputs: [{ token: USDC, amount: LOSSLESS_AMOUNT.toString() }],
        routes: [buyRoute(LOSSLESS_AMOUNT)],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  },
})
assert.equal(losslessBody.inputs[0].amount, '9007199254740993')

await expectExecutionRejection(
  fetchPendleLoopingBuyRoute({
    market,
    wiring: routeWiring,
    amountIn: 1_000_000n,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          action: 'swap',
          inputs: [{ token: USDC, amount: '1000000' }],
          routes: [buyRoute(1_000_000n, { tx: { value: '1' } })],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
  }),
  'ROUTE_NOT_ALLOWED',
)

const OWNER_ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const OTHER_ACCOUNT = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const PREFLIGHT_NOW_MS = 1_784_400_000_000
const PENDING_TIMESTAMP = 1_784_400_000n
const PINNED_BLOCK_NUMBER = 321_000_000n
const PINNED_BLOCK_HASH = `0x${'ab'.repeat(32)}`
const TEST_TRANSACTION_HASH = `0x${'cd'.repeat(32)}`
const SMALL_RUNTIME_CODE = '0x60006000'
assert.equal(
  keccak256(LOOPING_KYBER_EXECUTOR_RUNTIME),
  KYBER_EXECUTOR.runtimeCodeHash,
)
const domainSeparator = keccak256(
  encodeAbiParameters(parseAbiParameters('bytes32,uint256,address'), [
    keccak256(toHex('EIP712Domain(uint256 chainId,address verifyingContract)')),
    BigInt(market.chainId),
    market.contracts.morpho,
  ]),
)

function createPreflightClient({
  adapterAllowance = 1_000_000n,
  morphoAllowance = 0n,
  nonce = 7n,
  adapterAuthorized = false,
  ownerLoanBalance = 2_000_000n,
  totalSupplyAssets = 10_000_000n,
  totalBorrowAssets = 5_000_000n,
  totalBorrowShares = 5_000_000n,
  ownerPosition = [0n, 0n, 0n],
  accruedPosition = [0n, 0n, 0n],
  oraclePrice = 1_000_000_000_000_000_000_000_000n,
  pendingTimestamp = PENDING_TIMESTAMP,
  exchangeRate = 1_000_000_000_000_000_000n,
  pyIndexStored = 1_000_000_000_000_000_000n,
  transactionData = '0x',
  transactionHash = TEST_TRANSACTION_HASH,
  transactionStatus = 'success',
  transactionFrom = OWNER_ACCOUNT.address,
  transactionTo = contracts.bundler3,
  transactionValue = 0n,
  transactionBlockNumber = PINNED_BLOCK_NUMBER,
  transactionBlockHash = PINNED_BLOCK_HASH,
  receiptFrom = transactionFrom,
  receiptTo = transactionTo,
  receiptBlockNumber = PINNED_BLOCK_NUMBER,
  receiptBlockHash = PINNED_BLOCK_HASH,
  rejectOracleCall = false,
  morphoRuntimeHash = market.runtimeCodePolicy.morpho,
  pendleRouterRuntimeHash = market.runtimeCodePolicy.pendleRouter,
  pendleRouterImplementationRuntimeHash =
    market.runtimeCodePolicy.pendleRouterImplementation,
  pendleRouterRedeemImplementationRuntimeHash =
    market.runtimeCodePolicy.pendleRouterRedeemImplementation,
  pendleRouterBuyImplementation = ROUTER_IMPLEMENTATION,
  pendleRouterSellImplementation = ROUTER_IMPLEMENTATION,
  pendleRouterRedeemImplementation = ROUTER_REDEEM_IMPLEMENTATION,
  pendleSwapRuntimeHash = market.runtimeCodePolicy.pendleSwap,
  pendleSwapImplementationRuntimeHash =
    market.runtimeCodePolicy.pendleSwapImplementation,
  pendleSwapImplementation = PENDLE_SWAP_IMPLEMENTATION,
  kyberRouterRuntimeHash = market.runtimeCodePolicy.kyberRouter,
  multicall3RuntimeHash = market.runtimeCodePolicy.multicall3,
  rejectSharedResidueReads = true,
  requireExactPreflightReads = false,
  voidActionDataUndefined = false,
} = {}) {
  function assertExactPreflightRead({ blockNumber, blockTag }) {
    if (!requireExactPreflightReads) return
    assert.equal(blockNumber, PINNED_BLOCK_NUMBER)
    assert.equal(blockTag, undefined)
  }
  const emptyPosition = [0n, 0n, 0n]
  const marketReturnData = encodeFunctionResult({
    abi: morphoBlueAbi,
    functionName: 'market',
    result: [
      totalSupplyAssets,
      totalSupplyAssets,
      totalBorrowAssets,
      totalBorrowShares,
      pendingTimestamp,
      0n,
    ],
  })
  const positionReturnData = encodeFunctionResult({
    abi: morphoBlueAbi,
    functionName: 'position',
    result: accruedPosition,
  })
  const oracleReturnData = encodeFunctionResult({
    abi: parseAbi(['function price() view returns (uint256)']),
    functionName: 'price',
    result: oraclePrice,
  })
  return {
    async getChainId() {
      return market.chainId
    },
    async getBlock({ blockNumber, blockTag } = {}) {
      if (requireExactPreflightReads) {
        assert.equal(blockNumber, undefined)
        assert.equal(blockTag, 'latest')
      }
      return {
        timestamp: pendingTimestamp,
        number: PINNED_BLOCK_NUMBER,
        hash: PINNED_BLOCK_HASH,
      }
    },
    async getBytecode({ address, blockNumber, blockTag }) {
      assertExactPreflightRead({ blockNumber, blockTag })
      if (address.toLowerCase() === OWNER_ACCOUNT.address.toLowerCase()) return '0x'
      if (address.toLowerCase() === KYBER_EXECUTOR.address.toLowerCase()) {
        return LOOPING_KYBER_EXECUTOR_RUNTIME
      }
      return SMALL_RUNTIME_CODE
    },
    async getProof({ address, blockNumber, blockTag }) {
      assertExactPreflightRead({ blockNumber, blockTag })
      const normalized = address.toLowerCase()
      const isPinnedRouteAddress = [
        contracts.pendleRouter,
        ROUTER_IMPLEMENTATION,
        ROUTER_REDEEM_IMPLEMENTATION,
        contracts.pendleSwap,
        PENDLE_SWAP_IMPLEMENTATION,
        KYBER_ROUTER,
      ].some((candidate) => candidate.toLowerCase() === normalized)
      if (isPinnedRouteAddress) assert.equal(blockNumber, PINNED_BLOCK_NUMBER)
      const codeHash = normalized === contracts.morpho.toLowerCase()
        ? morphoRuntimeHash
        : normalized === contracts.bundler3.toLowerCase()
          ? market.runtimeCodePolicy.bundler3
          : normalized === contracts.generalAdapter1.toLowerCase()
            ? market.runtimeCodePolicy.generalAdapter1
            : normalized === contracts.pendleRouter.toLowerCase()
              ? pendleRouterRuntimeHash
              : normalized === ROUTER_IMPLEMENTATION.toLowerCase()
                ? pendleRouterImplementationRuntimeHash
                : normalized === ROUTER_REDEEM_IMPLEMENTATION.toLowerCase()
                  ? pendleRouterRedeemImplementationRuntimeHash
                : normalized === contracts.pendleSwap.toLowerCase()
                  ? pendleSwapRuntimeHash
                  : normalized === PENDLE_SWAP_IMPLEMENTATION.toLowerCase()
                    ? pendleSwapImplementationRuntimeHash
                    : normalized === KYBER_ROUTER.toLowerCase()
                      ? kyberRouterRuntimeHash
                      : normalized === contracts.multicall3.toLowerCase()
                        ? multicall3RuntimeHash
                      : keccak256(SMALL_RUNTIME_CODE)
      return { codeHash }
    },
    async getStorageAt({ address, slot, blockNumber, blockTag }) {
      assertExactPreflightRead({ blockNumber, blockTag })
      assert.equal(blockNumber, PINNED_BLOCK_NUMBER)
      const normalizedAddress = address.toLowerCase()
      const normalizedSlot = slot.toLowerCase()
      const [buySlot, sellSlot, redeemSlot] =
        upgradePolicy.pendleRouter.selectorImplementationSlots
      if (normalizedAddress === contracts.pendleRouter.toLowerCase()) {
        if (normalizedSlot === buySlot.storageSlot.toLowerCase()) {
          return encodeAbiParameters(
            parseAbiParameters('address'),
            [pendleRouterBuyImplementation],
          )
        }
        if (normalizedSlot === sellSlot.storageSlot.toLowerCase()) {
          return encodeAbiParameters(
            parseAbiParameters('address'),
            [pendleRouterSellImplementation],
          )
        }
        if (normalizedSlot === redeemSlot.storageSlot.toLowerCase()) {
          return encodeAbiParameters(
            parseAbiParameters('address'),
            [pendleRouterRedeemImplementation],
          )
        }
      }
      if (
        normalizedAddress === contracts.pendleSwap.toLowerCase() &&
        normalizedSlot ===
          upgradePolicy.pendleSwap.implementationStorageSlot.toLowerCase()
      ) {
        return encodeAbiParameters(
          parseAbiParameters('address'),
          [pendleSwapImplementation],
        )
      }
      throw new Error(`Unexpected storage read: ${address} ${slot}`)
    },
    async readContract({
      address,
      functionName,
      args = [],
      blockNumber,
      blockTag,
    }) {
      assertExactPreflightRead({ blockNumber, blockTag })
      switch (functionName) {
        case 'BUNDLER3':
          return contracts.bundler3
        case 'MORPHO':
          return contracts.morpho
        case 'readTokens':
          return [
            market.standardizedYield,
            market.morphoMarketParams.collateralToken,
            getAddress('0x3333333333333333333333333333333333333333'),
          ]
        case 'expiry':
          return market.pendleMarketExpiry
        case 'exchangeRate':
          return exchangeRate
        case 'pyIndexStored':
          return pyIndexStored
        case 'getTokensIn':
          return [...policy.mintSyTokenAllowlist]
        case 'getTokensOut':
          return [...policy.redeemSyTokenAllowlist]
        case 'idToMarketParams':
          return [
            market.morphoMarketParams.loanToken,
            market.morphoMarketParams.collateralToken,
            market.morphoMarketParams.oracle,
            market.morphoMarketParams.irm,
            market.morphoMarketParams.lltv,
          ]
        case 'decimals':
          return address.toLowerCase() === USDC.toLowerCase()
            ? market.loanTokenDecimals
            : market.collateralTokenDecimals
        case 'DOMAIN_SEPARATOR':
          return domainSeparator
        case 'nonce':
          return nonce
        case 'isAuthorized':
          return adapterAuthorized
        case 'allowance':
          if (args[0].toLowerCase() !== OWNER_ACCOUNT.address.toLowerCase()) {
            return 0n
          }
          if (args[1].toLowerCase() === contracts.generalAdapter1.toLowerCase()) {
            return adapterAllowance
          }
          if (args[1].toLowerCase() === contracts.morpho.toLowerCase()) {
            return morphoAllowance
          }
          return 0n
        case 'balanceOf':
          if (
            rejectSharedResidueReads &&
            args[0].toLowerCase() !== OWNER_ACCOUNT.address.toLowerCase()
          ) {
            throw new Error('Shared residue balance reads are forbidden')
          }
          return args[0].toLowerCase() === OWNER_ACCOUNT.address.toLowerCase()
            ? ownerLoanBalance
            : 0n
        case 'position':
          if (
            rejectSharedResidueReads &&
            args[1].toLowerCase() !== OWNER_ACCOUNT.address.toLowerCase()
          ) {
            throw new Error('Shared adapter positions are forbidden preflight gates')
          }
          return args[1].toLowerCase() === OWNER_ACCOUNT.address.toLowerCase()
            ? ownerPosition
            : emptyPosition
        case 'market':
          return [
            totalSupplyAssets,
            totalSupplyAssets,
            totalBorrowAssets,
            totalBorrowShares,
            pendingTimestamp,
            0n,
          ]
        case 'price':
          return oraclePrice
        case 'initiator':
          return zeroAddress
        default:
          throw new Error(`Unexpected readContract function: ${functionName}`)
      }
    },
    async call({
      to,
      data,
      account,
      stateOverride,
      blockNumber,
      blockTag,
    }) {
      assertExactPreflightRead({ blockNumber, blockTag })
      if (to.toLowerCase() === contracts.multicall3.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: loopingMulticall3Abi, data })
        if (
          rejectOracleCall &&
          decoded.args[0].some((item) =>
            item.target.toLowerCase() === market.morphoMarketParams.oracle.toLowerCase())
        ) {
          throw new Error('Oracle calls are forbidden in this test client')
        }
        const requested = decoded.args[0].length
        const allResults = [
          { success: true, returnData: '0x' },
          { success: true, returnData: marketReturnData },
          { success: true, returnData: positionReturnData },
          { success: true, returnData: oracleReturnData },
        ]
        return {
          data: encodeFunctionResult({
            abi: loopingMulticall3Abi,
            functionName: 'aggregate3',
            result: allResults.slice(0, requested),
          }),
        }
      }
      if (to.toLowerCase() === contracts.morpho.toLowerCase()) {
        assert.equal(account, OWNER_ACCOUNT.address)
        assert.ok(stateOverride)
        return { data: toHex(1n, { size: 32 }) }
      }
      if (to.toLowerCase() === contracts.bundler3.toLowerCase()) {
        assert.equal(account, OWNER_ACCOUNT.address)
        assert.ok(stateOverride)
        return { data: voidActionDataUndefined ? undefined : '0x' }
      }
      throw new Error(`Unexpected call target: ${to}`)
    },
    async getTransactionReceipt({ hash }) {
      assert.equal(hash, transactionHash)
      return {
        status: transactionStatus,
        transactionHash,
        from: receiptFrom,
        to: receiptTo,
        blockNumber: receiptBlockNumber,
        blockHash: receiptBlockHash,
      }
    },
    async getTransaction({ hash }) {
      assert.equal(hash, transactionHash)
      return {
        hash: transactionHash,
        from: transactionFrom,
        to: transactionTo,
        input: transactionData,
        value: transactionValue,
        blockNumber: transactionBlockNumber,
        blockHash: transactionBlockHash,
      }
    },
  }
}

function createEntryFetcher({
  minPtOut = 990_000_000_000_000_000n,
  expectedPtOut = 1_000_000_000_000_000_000n,
} = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    const amountIn = BigInt(body.inputs[0].amount)
    return new Response(
      JSON.stringify({
        action: 'swap',
        inputs: [{ token: USDC, amount: amountIn.toString() }],
        requiredApprovals: [{ token: USDC, amount: amountIn.toString() }],
        routes: [buyRoute(amountIn, { minPtOut, expectedPtOut })],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  }
}

function prepareEntry(overrides = {}) {
  return prepareLoopingEntryExecution({
    client: overrides.client ?? createPreflightClient(),
    owner: OWNER_ACCOUNT.address,
    market,
    equityAssets: overrides.equityAssets ?? 1_000_000n,
    borrowAssets: overrides.borrowAssets ?? 500_000n,
    fetcher: overrides.fetcher ?? createEntryFetcher(),
    now: overrides.now ?? (() => PREFLIGHT_NOW_MS),
  })
}

function createExitFetcher() {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    const amountIn = BigInt(body.inputs[0].amount)
    return new Response(
      JSON.stringify({
        action: 'swap',
        inputs: [{ token: PT, amount: amountIn.toString() }],
        routes: [exitRoute(amountIn)],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  }
}

function createMaturedExitFetcher() {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    const amountIn = BigInt(body.inputs[0].amount)
    assert.equal(
      body.inputs[0].token.toLowerCase(),
      market.standardizedYield.toLowerCase(),
    )
    return new Response(
      JSON.stringify({
        action: 'redeem-sy',
        inputs: [
          { token: market.standardizedYield, amount: amountIn.toString() },
        ],
        requiredApprovals: [
          { token: market.standardizedYield, amount: amountIn.toString() },
        ],
        routes: [maturedSyRoute(amountIn)],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  }
}

function prepareExit(overrides = {}) {
  const position = overrides.position ?? [0n, 500_000n, COLLATERAL]
  return prepareLoopingExitExecution({
    client: overrides.client ?? createPreflightClient({
      ownerPosition: position,
      accruedPosition: position,
      adapterAllowance: overrides.adapterAllowance ?? 0n,
    }),
    owner: OWNER_ACCOUNT.address,
    market,
    minimumReturnedAssets: overrides.minimumReturnedAssets ?? 1n,
    fetcher: overrides.fetcher ?? createExitFetcher(),
    now: overrides.now ?? (() => PREFLIGHT_NOW_MS),
  })
}

function createAdjustmentBuyFetcher(counter = { calls: 0 }) {
  return async (_url, init) => {
    counter.calls += 1
    const body = JSON.parse(init.body)
    const amountIn = BigInt(body.inputs[0].amount)
    const expectedPtOut = amountIn * 1_000_000_000_000n
    const minPtOut = expectedPtOut * 99n / 100n
    return new Response(
      JSON.stringify({
        action: 'swap',
        inputs: [{ token: USDC, amount: amountIn.toString() }],
        requiredApprovals: [{ token: USDC, amount: amountIn.toString() }],
        routes: [buyRoute(amountIn, { minPtOut, expectedPtOut })],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  }
}

function createAdjustmentSellFetcher(counter = { calls: 0 }) {
  return async (_url, init) => {
    counter.calls += 1
    const body = JSON.parse(init.body)
    const collateral = BigInt(body.inputs[0].amount)
    const oracleValue = collateral / 1_000_000_000_000n
    const minTokenOut = oracleValue * 98n / 100n
    const expectedTokenOut = oracleValue * 99n / 100n
    return new Response(
      JSON.stringify({
        action: 'swap',
        inputs: [{ token: PT, amount: collateral.toString() }],
        routes: [exitRoute(collateral, {
          intermediateSy: collateral,
          minTokenOut,
          expectedTokenOut,
        })],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  }
}

function enforceReadConcurrency(client, maximum) {
  const instrumentedMethods = new Set([
    'call',
    'getBlock',
    'getBytecode',
    'getChainId',
    'getProof',
    'getStorageAt',
    'readContract',
  ])
  let active = 0
  let peak = 0
  return {
    client: new Proxy(client, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof property !== 'string' ||
          !instrumentedMethods.has(property) ||
          typeof value !== 'function') return value
        return async (...args) => {
          active += 1
          peak = Math.max(peak, active)
          if (active > maximum) {
            active -= 1
            throw new Error(`Wallet RPC read concurrency exceeded ${maximum}`)
          }
          // Keep immediately resolved fake reads concurrently in flight so
          // this regression catches unbounded Promise.all fan-out.
          await Promise.resolve()
          try {
            return await value.apply(target, args)
          } finally {
            active -= 1
          }
        }
      },
    }),
    peak: () => peak,
  }
}

console.log('Read-only inventory accrues one pinned position without quotes or writes')
const inventoryPosition = [0n, 600_000n, COLLATERAL]
const inventory = await readLoopingPositionInventory({
  client: createPreflightClient({
    ownerPosition: inventoryPosition,
    accruedPosition: inventoryPosition,
    requireExactPreflightReads: true,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(Object.isFrozen(inventory), true)
assert.equal(Object.isFrozen(inventory.position), true)
assert.equal(inventory.kind, 'loop-position-inventory')
assert.equal(inventory.owner, OWNER_ACCOUNT.address)
assert.equal(inventory.marketId, market.marketId)
assert.equal(inventory.blockNumber, PINNED_BLOCK_NUMBER)
assert.equal(inventory.blockHash, PINNED_BLOCK_HASH)
assert.equal(inventory.blockTimestamp, PENDING_TIMESTAMP)
assert.deepEqual(inventory.position, {
  supplyShares: 0n,
  borrowShares: 600_000n,
  collateral: COLLATERAL,
  classification: 'open-loop',
})
assert.equal(inventory.accruedDebtAssets, 500_001n)
assert.equal(inventory.collateralLoanValue, 1_500_000n)
assert.equal(inventory.ltvBps, 3_333n)
assert.equal(inventory.liquidationBufferBps, 6_357n)

const emptyInventory = await readLoopingPositionInventory({
  client: createPreflightClient({ requireExactPreflightReads: true }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(emptyInventory.position.classification, 'empty')
assert.equal(emptyInventory.accruedDebtAssets, 0n)
assert.equal(emptyInventory.collateralLoanValue, 0n)
assert.equal(emptyInventory.ltvBps, 0n)
assert.equal(emptyInventory.liquidationBufferBps, 10_000n)

const conflictingInventoryPosition = [1n, 600_000n, COLLATERAL]
const conflictingInventory = await readLoopingPositionInventory({
  client: createPreflightClient({
    ownerPosition: conflictingInventoryPosition,
    accruedPosition: conflictingInventoryPosition,
    requireExactPreflightReads: true,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(conflictingInventory.position.classification, 'conflicting-supply')
assert.equal(conflictingInventory.accruedDebtAssets, 500_001n)

const zeroCollateralDebtPosition = [0n, 600_000n, 0n]
const zeroCollateralDebtInventory = await readLoopingPositionInventory({
  client: createPreflightClient({
    ownerPosition: zeroCollateralDebtPosition,
    accruedPosition: zeroCollateralDebtPosition,
    requireExactPreflightReads: true,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(zeroCollateralDebtInventory.accruedDebtAssets, 500_001n)
assert.equal(zeroCollateralDebtInventory.collateralLoanValue, 0n)
assert.equal(zeroCollateralDebtInventory.ltvBps, null)
assert.equal(zeroCollateralDebtInventory.liquidationBufferBps, 0n)

const wrongChainInventoryClient = createPreflightClient({ requireExactPreflightReads: true })
wrongChainInventoryClient.getChainId = async () => 1
await assert.rejects(
  readLoopingPositionInventory({
    client: wrongChainInventoryClient,
    owner: OWNER_ACCOUNT.address,
    market,
  }),
  /wrong chain/i,
)
await assert.rejects(
  readLoopingPositionInventory({
    client: createPreflightClient({
      morphoRuntimeHash: keccak256('0x1234'),
      requireExactPreflightReads: true,
    }),
    owner: OWNER_ACCOUNT.address,
    market,
  }),
  /Morpho runtime code changed/i,
)

const FORMER_BETA_EQUITY_ASSETS = 1_000_000n
const FORMER_BETA_BORROW_ASSETS = 500_000n

console.log('Fixed-point leverage and amounts above the former beta thresholds stay lossless')
assert.equal(deriveLoopingBorrowAssets(1_000_000n, '1.5'), 500_000n)
assert.equal(
  deriveLoopingBorrowAssets(9_007_199_254_740_993n, '1.000000000000000001'),
  0n,
)
assert.equal(deriveLoopingBorrowAssets(3n, '1.5'), 1n)
assert.throws(() => deriveLoopingBorrowAssets(1_000_000n, '1e1'))
assert.throws(() => deriveLoopingBorrowAssets(1_000_000n, '0.99'))
assert.throws(() =>
  deriveLoopingBorrowAssets(1_000_000n, '1.0000000000000000001'))

const noRpcClient = new Proxy(
  {},
  {
    get() {
      throw new Error('RPC must not be touched after canonical market validation fails')
    },
  },
)
const aboveFormerAmountThresholdPreview = await prepareEntry({
  client: createPreflightClient({
    adapterAllowance: FORMER_BETA_EQUITY_ASSETS + 1n,
  }),
  equityAssets: FORMER_BETA_EQUITY_ASSETS + 1n,
  borrowAssets: FORMER_BETA_BORROW_ASSETS + 1n,
})
assert.equal(
  aboveFormerAmountThresholdPreview.equityAssets,
  FORMER_BETA_EQUITY_ASSETS + 1n,
)
assert.equal(
  aboveFormerAmountThresholdPreview.borrowAssets,
  FORMER_BETA_BORROW_ASSETS + 1n,
)

let insufficientBalanceQuoteCalled = false
await expectExecutionRejection(
  prepareEntry({
    client: createPreflightClient({
      ownerLoanBalance: FORMER_BETA_EQUITY_ASSETS,
    }),
    equityAssets: FORMER_BETA_EQUITY_ASSETS + 1n,
    borrowAssets: 1n,
    fetcher: async () => {
      insufficientBalanceQuoteCalled = true
      throw new Error('Quote must not run before the wallet-balance check.')
    },
  }),
  'STATE_CONFLICT',
)
assert.equal(insufficientBalanceQuoteCalled, false)

console.log('Preflight pins every code, storage, and state read to one latest block')
const preview = await prepareEntry({
  client: createPreflightClient({ requireExactPreflightReads: true }),
})
const boundedWalletReads = enforceReadConcurrency(createPreflightClient(), 4)
await prepareEntry({ client: boundedWalletReads.client })
assert.equal(boundedWalletReads.peak(), 4)
console.log('Preflight derives finite debt-share, health, and authorization bounds')
assert.equal(preview.kind, 'entry-preview')
assert.equal(Object.isFrozen(preview), true)
assert.equal(preview.equityAssets, 1_000_000n)
assert.equal(preview.borrowAssets, 500_000n)
assert.equal(preview.approval.current, 1_000_000n)
assert.equal(preview.approval.needed, false)
assert.equal(preview.position.classification, 'empty')
assert.ok(preview.bounds.observedBorrowShares > 0n)
assert.ok(preview.bounds.maxBorrowShares > preview.bounds.observedBorrowShares)
assert.ok(
  preview.bounds.observedBorrowSharePriceE27 >=
    preview.bounds.minBorrowSharePriceE27,
)
assert.ok(
  preview.health.liquidationBufferBps >=
    BigInt(market.launchPolicy.minLiquidationBufferBps),
)

console.log('Risk-increasing preflight allows the acknowledged warning zone but keeps the 1% floor')
const highRiskEntryPreview = await prepareEntry({
  client: createPreflightClient({
    ownerLoanBalance: 2_000_000n,
    totalSupplyAssets: 20_000_000n,
  }),
  equityAssets: 1_000_000n,
  borrowAssets: 6_000_000n,
  fetcher: createAdjustmentBuyFetcher(),
})
assert.ok(
  highRiskEntryPreview.health.liquidationBufferBps >=
    BigInt(market.launchPolicy.modelMinLiquidationBufferBps),
)
assert.ok(
  highRiskEntryPreview.health.liquidationBufferBps <
    BigInt(market.launchPolicy.minLiquidationBufferBps),
)
await expectExecutionRejection(
  prepareEntry({
    client: createPreflightClient({
      ownerLoanBalance: 2_000_000n,
      totalSupplyAssets: 25_000_000n,
    }),
    equityAssets: 1_000_000n,
    borrowAssets: 8_700_000n,
    fetcher: createAdjustmentBuyFetcher(),
  }),
  'POSITION_UNSAFE',
  /liquidation headroom/i,
)
assert.ok(
  preview.health.collateralLoanValue * 10_000n >=
    (preview.equityAssets + preview.borrowAssets) *
      BigInt(market.launchPolicy.minEntryValueBps),
)
assert.equal(
  preview.quotes.minimumCollateral,
  1_980_000_000_000_000_000n,
)
assert.equal(preview.authorizationRequests[0].message.nonce, 7n)
assert.equal(preview.authorizationRequests[0].message.isAuthorized, true)
assert.equal(preview.authorizationRequests[1].message.nonce, 8n)
assert.equal(preview.authorizationRequests[1].message.isAuthorized, false)
assert.equal(
  preview.authorizationRequests[1].message.deadline,
  preview.authorizationRequests[0].message.deadline,
)
assert.equal(
  preview.authorizationRequests[0].message.deadline - PENDING_TIMESTAMP,
  market.launchPolicy.authorizationLifetimeSeconds,
)

console.log('Preflight rejects every pinned route upgrade surface change')
for (const unsafeRouteWiring of [
  { pendleRouterRuntimeHash: `0x${'31'.repeat(32)}` },
  { pendleRouterImplementationRuntimeHash: `0x${'32'.repeat(32)}` },
  { pendleRouterRedeemImplementationRuntimeHash: `0x${'36'.repeat(32)}` },
  { pendleRouterBuyImplementation: OTHER_ACCOUNT.address },
  { pendleRouterSellImplementation: OTHER_ACCOUNT.address },
  { pendleRouterRedeemImplementation: OTHER_ACCOUNT.address },
  { pendleSwapRuntimeHash: `0x${'33'.repeat(32)}` },
  { pendleSwapImplementationRuntimeHash: `0x${'34'.repeat(32)}` },
  { pendleSwapImplementation: OTHER_ACCOUNT.address },
  { kyberRouterRuntimeHash: `0x${'35'.repeat(32)}` },
]) {
  await expectExecutionRejection(
    prepareEntry({ client: createPreflightClient(unsafeRouteWiring) }),
    'UNSAFE_WIRING',
  )
}

console.log('Unsigned simulation omits exposed signatures and pins the owner override')
const entryIntent = buildUnsignedLoopingEntrySimulation(
  preview,
  () => PREFLIGHT_NOW_MS,
)
assert.equal(entryIntent.account, OWNER_ACCOUNT.address)
assert.equal(entryIntent.chainId, market.chainId)
assert.equal(entryIntent.calls.length, 8)
assert.equal(
  entryIntent.calls.some((call) =>
    call.to.toLowerCase() === contracts.morpho.toLowerCase()),
  false,
)
const innerAuthorizationSlot = keccak256(encodeAbiParameters(
  parseAbiParameters('address,uint256'),
  [OWNER_ACCOUNT.address, 6n],
))
const expectedAuthorizationSlot = keccak256(encodeAbiParameters(
  parseAbiParameters('address,bytes32'),
  [contracts.generalAdapter1, innerAuthorizationSlot],
))
assert.equal(
  getLoopingAuthorizationStorageSlot(OWNER_ACCOUNT.address, market),
  expectedAuthorizationSlot,
)
assert.equal(entryIntent.stateOverride[0].stateDiff[0].slot, expectedAuthorizationSlot)
assert.equal(entryIntent.stateOverride[0].stateDiff[0].value, toHex(1n, { size: 32 }))
assert.deepEqual(entryIntent.requiredRuntimeCodeHashes, market.runtimeCodePolicy)
const entrySimulation = await simulateUnsignedLoopingIntent({
  client: createPreflightClient(),
  intent: entryIntent,
})
assert.equal(entrySimulation.kind, 'verified-unsigned-entry-simulation')
assert.equal(entrySimulation.blockNumber, PINNED_BLOCK_NUMBER)
assert.equal(entrySimulation.blockHash, PINNED_BLOCK_HASH)
const viemVoidEntrySimulation = await simulateUnsignedLoopingIntent({
  client: createPreflightClient({ voidActionDataUndefined: true }),
  intent: entryIntent,
})
assert.equal(
  viemVoidEntrySimulation.actionResult,
  '0x',
  'a successful viem void call must normalize undefined data to 0x',
)
await expectExecutionRejection(
  simulateUnsignedLoopingIntent({
    client: createPreflightClient({
      pendleSwapImplementationRuntimeHash: `0x${'36'.repeat(32)}`,
    }),
    intent: entryIntent,
  }),
  'UNSAFE_WIRING',
)
await expectExecutionRejection(
  simulateUnsignedLoopingIntent({
    client: createPreflightClient(),
    intent: Object.freeze({ ...entryIntent }),
  }),
  'STATE_CONFLICT',
)

const staleApprovalPreview = await prepareEntry({
  client: createPreflightClient({
    adapterAllowance: 123n,
    morphoAllowance: 999n,
  }),
})
assert.equal(staleApprovalPreview.approval.needed, true)
assert.equal(staleApprovalPreview.approval.current, 123n)
assert.equal(staleApprovalPreview.wiring.morphoAllowance, 999n)
const directMorphoAllowancePreview = await prepareEntry({
  client: createPreflightClient({ morphoAllowance: 999n }),
})
assert.equal(directMorphoAllowancePreview.approval.needed, false)
assert.equal(directMorphoAllowancePreview.wiring.morphoAllowance, 999n)
expectExecutionError(
  () => buildUnsignedLoopingEntrySimulation(
    staleApprovalPreview,
    () => PREFLIGHT_NOW_MS,
  ),
  'STATE_CONFLICT',
)
const staleAuthorizeSignature = await OWNER_ACCOUNT.sign({
  hash: staleApprovalPreview.authorizationRequests[0].digest,
})
const staleRevokeSignature = await OWNER_ACCOUNT.sign({
  hash: staleApprovalPreview.authorizationRequests[1].digest,
})
await expectExecutionRejection(
  buildSignedLoopingEntryBundle(
    staleApprovalPreview,
    staleAuthorizeSignature,
    staleRevokeSignature,
    () => PREFLIGHT_NOW_MS,
  ),
  'STATE_CONFLICT',
)

await expectExecutionRejection(
  prepareEntry({
    client: createPreflightClient({ totalSupplyAssets: 5_499_999n }),
    fetcher: async () => {
      throw new Error('Quote must not be fetched for insufficient liquidity')
    },
  }),
  'POSITION_UNSAFE',
)
await expectExecutionRejection(
  prepareEntry({
    client: createPreflightClient({
      morphoRuntimeHash: `0x${'77'.repeat(32)}`,
    }),
    fetcher: async () => {
      throw new Error('Quote must not be fetched for changed runtime code')
    },
  }),
  'UNSAFE_WIRING',
)
await expectExecutionRejection(
  prepareEntry({
    fetcher: createEntryFetcher({
      minPtOut: 275_000_000_000_000_000n,
      expectedPtOut: 280_000_000_000_000_000n,
    }),
  }),
  'POSITION_UNSAFE',
)
await expectExecutionRejection(
  prepareEntry({
    borrowAssets: 50_000n,
    fetcher: createEntryFetcher({
      minPtOut: 300_000_000_000_000_000n,
      expectedPtOut: 310_000_000_000_000_000n,
    }),
  }),
  'POSITION_UNSAFE',
  /worth less than 90% of supplied equity plus debt/,
)

console.log('Authorization signatures recover to the owner and bind callback shapes')
const authorizeSignature = await OWNER_ACCOUNT.sign({
  hash: preview.authorizationRequests[0].digest,
})
const revokeSignature = await OWNER_ACCOUNT.sign({
  hash: preview.authorizationRequests[1].digest,
})
const wrongAuthorizeSignature = await OTHER_ACCOUNT.sign({
  hash: preview.authorizationRequests[0].digest,
})
await expectExecutionRejection(
  buildSignedLoopingEntryBundle(
    preview,
    wrongAuthorizeSignature,
    revokeSignature,
    () => PREFLIGHT_NOW_MS,
  ),
  'INVALID_SIGNATURE',
)
await expectExecutionRejection(
  buildSignedLoopingEntryBundle(
    preview,
    authorizeSignature,
    revokeSignature,
    () => preview.validUntilMs,
  ),
  'QUOTE_EXPIRED',
)
const bundle = await buildSignedLoopingEntryBundle(
  preview,
  authorizeSignature,
  revokeSignature,
  () => PREFLIGHT_NOW_MS,
)
assert.equal(bundle.kind, 'signed-entry-bundle')
assert.equal(bundle.to, contracts.bundler3)
assert.equal(bundle.value, 0n)
assert.equal(bundle.calls.length, 10)
assert.deepEqual(
  bundle.calls.map((item) => item.to),
  [
    contracts.morpho,
    contracts.generalAdapter1,
    USDC,
    contracts.pendleRouter,
    USDC,
    contracts.generalAdapter1,
    contracts.generalAdapter1,
    contracts.generalAdapter1,
    PT,
    contracts.morpho,
  ],
)
const decodedBundle = decodeFunctionData({ abi: bundler3Abi, data: bundle.data })
assert.equal(decodedBundle.functionName, 'multicall')
assert.equal(decodedBundle.args[0].length, 10)
const supplyCall = decodeFunctionData({
  abi: generalAdapter1Abi,
  data: decodedBundle.args[0][5].data,
})
assert.equal(supplyCall.functionName, 'morphoSupplyCollateral')
const callbackData = supplyCall.args[3]
const [callbackCalls] = decodeAbiParameters(
  bundler3CallArrayParameters,
  callbackData,
)
assert.equal(callbackCalls.length, 4)
assert.equal(decodedBundle.args[0][5].callbackHash, keccak256(callbackData))
assert.equal(
  callbackCalls.every(
    (item) =>
      item.value === 0n &&
      item.skipRevert === false &&
      item.callbackHash === `0x${'00'.repeat(32)}`,
  ),
  true,
)
const firstAuthorization = decodeFunctionData({
  abi: morphoBlueAbi,
  data: decodedBundle.args[0][0].data,
})
const lastAuthorization = decodeFunctionData({
  abi: morphoBlueAbi,
  data: decodedBundle.args[0][9].data,
})
assert.equal(firstAuthorization.functionName, 'setAuthorizationWithSig')
assert.equal(firstAuthorization.args[0].nonce, 7n)
assert.equal(firstAuthorization.args[0].isAuthorized, true)
assert.equal(lastAuthorization.functionName, 'setAuthorizationWithSig')
assert.equal(lastAuthorization.args[0].nonce, 8n)
assert.equal(lastAuthorization.args[0].isAuthorized, false)

console.log('Post-sign entry revalidation is tied to branded same-block simulation')
const entryReadiness = await revalidateSignedLoopingEntry({
  client: createPreflightClient(),
  preview,
  bundle,
  simulation: entrySimulation,
  now: () => PREFLIGHT_NOW_MS,
})
assert.equal(entryReadiness.kind, 'entry-broadcast-ready')
assert.equal(entryReadiness.blockNumber, PINNED_BLOCK_NUMBER)
assert.equal(entryReadiness.nonce, bundle.startingNonce)
assert.equal(entryReadiness.entryBorrowBounds.observedBorrowShares > 0n, true)
await expectExecutionRejection(
  revalidateSignedLoopingEntry({
    client: createPreflightClient({
      pendleRouterSellImplementation: OTHER_ACCOUNT.address,
    }),
    preview,
    bundle,
    simulation: entrySimulation,
    now: () => PREFLIGHT_NOW_MS,
  }),
  'UNSAFE_WIRING',
)
await expectExecutionRejection(
  revalidateSignedLoopingEntry({
    client: createPreflightClient({ nonce: 8n }),
    preview,
    bundle,
    simulation: entrySimulation,
    now: () => PREFLIGHT_NOW_MS,
  }),
  'STATE_CONFLICT',
)
await expectExecutionRejection(
  revalidateSignedLoopingEntry({
    client: createPreflightClient({
      oraclePrice: 100_000_000_000_000_000_000_000n,
    }),
    preview,
    bundle,
    simulation: entrySimulation,
    now: () => PREFLIGHT_NOW_MS,
  }),
  'POSITION_UNSAFE',
)
await expectExecutionRejection(
  revalidateSignedLoopingEntry({
    client: createPreflightClient({
      oraclePrice: 650_000_000_000_000_000_000_000n,
    }),
    preview,
    bundle,
    simulation: entrySimulation,
    now: () => PREFLIGHT_NOW_MS,
  }),
  'POSITION_UNSAFE',
  /worth less than 90% of supplied equity plus debt/,
)
await expectExecutionRejection(
  revalidateSignedLoopingEntry({
    client: createPreflightClient(),
    preview,
    bundle,
    simulation: Object.freeze({ ...entrySimulation }),
    now: () => PREFLIGHT_NOW_MS,
  }),
  'SIMULATION_FAILED',
)
await expectExecutionRejection(
  revalidateSignedLoopingEntry({
    client: createPreflightClient(),
    preview,
    bundle: {
      ...bundle,
      calls: bundle.calls.map((call, index) =>
        index === 2 ? { ...call, value: 1n } : call),
    },
    simulation: entrySimulation,
    now: () => PREFLIGHT_NOW_MS,
  }),
  'UNSAFE_WIRING',
)

console.log('Entry receipt checks bind the successful transaction and exact position')
const entryReceiptPosition = [
  0n,
  preview.bounds.observedBorrowShares,
  preview.quotes.minimumCollateral,
]
const entryReceiptState = {
  nonce: bundle.startingNonce + 2n,
  adapterAllowance: 0n,
  ownerPosition: entryReceiptPosition,
  accruedPosition: entryReceiptPosition,
  transactionData: bundle.data,
}
const entryReceiptClient = createPreflightClient({
  ...entryReceiptState,
  transactionBlockNumber: null,
  transactionBlockHash: null,
})
const entryReceiptCheck = await verifyLoopingEntryReceiptState({
  client: entryReceiptClient,
  preview,
  bundle,
  readiness: entryReadiness,
  transactionHash: TEST_TRANSACTION_HASH,
})
assert.equal(entryReceiptCheck.kind, 'entry-receipt-verified')
assert.equal(entryReceiptCheck.position.collateral, bundle.minimumCollateral)
assert.equal(entryReceiptCheck.adapterAuthorized, false)
for (const identityMismatch of [
  { transactionBlockNumber: PINNED_BLOCK_NUMBER + 1n },
  { transactionBlockHash: `0x${'ef'.repeat(32)}` },
  { receiptFrom: OTHER_ACCOUNT.address },
  { receiptTo: contracts.morpho },
]) {
  await expectExecutionRejection(
    verifyLoopingEntryReceiptState({
      client: createPreflightClient({
        ...entryReceiptState,
        ...identityMismatch,
      }),
      preview,
      bundle,
      readiness: entryReadiness,
      transactionHash: TEST_TRANSACTION_HASH,
    }),
    'STATE_CONFLICT',
    /identity does not match/i,
  )
}
await expectExecutionRejection(
  verifyLoopingEntryReceiptState({
    client: createPreflightClient({
      nonce: bundle.startingNonce + 2n,
      adapterAllowance: 0n,
      ownerPosition: entryReceiptPosition,
      accruedPosition: entryReceiptPosition,
      transactionData: bundle.data,
      transactionStatus: 'reverted',
    }),
    preview,
    bundle,
    readiness: entryReadiness,
    transactionHash: TEST_TRANSACTION_HASH,
  }),
  'STATE_CONFLICT',
)
const driftedEntryReceipt = await verifyLoopingEntryReceiptState({
  client: createPreflightClient({
    nonce: bundle.startingNonce + 2n,
    adapterAllowance: 0n,
    ownerPosition: entryReceiptPosition,
    accruedPosition: entryReceiptPosition,
    oraclePrice: 650_000_000_000_000_000_000_000n,
    transactionData: bundle.data,
  }),
  preview,
  bundle,
  readiness: entryReadiness,
  transactionHash: TEST_TRANSACTION_HASH,
})
assert.equal(driftedEntryReceipt.belowEntryValueFloor, true)
assert.equal(driftedEntryReceipt.belowModelBuffer, false)
const belowFloorEntryReceipt = await verifyLoopingEntryReceiptState({
  client: createPreflightClient({
    nonce: bundle.startingNonce + 2n,
    adapterAllowance: 0n,
    ownerPosition: entryReceiptPosition,
    accruedPosition: entryReceiptPosition,
    oraclePrice: 277_000_000_000_000_000_000_000n,
    transactionData: bundle.data,
  }),
  preview,
  bundle,
  readiness: entryReadiness,
  transactionHash: TEST_TRANSACTION_HASH,
})
assert.equal(belowFloorEntryReceipt.belowEntryValueFloor, true)
assert.equal(belowFloorEntryReceipt.belowModelBuffer, true)

console.log('Full exit binds exact shares, exact collateral, and net-return floor')
const exitPosition = [0n, 500_000n, COLLATERAL]
const maturedTimestamp = market.pendleMarketExpiry + 1n
const maturedNowMs = Number(maturedTimestamp) * 1_000
let maturedEntryQuoteCalled = false
await expectExecutionRejection(
  prepareEntry({
    client: createPreflightClient({ pendingTimestamp: maturedTimestamp }),
    fetcher: async (...args) => {
      maturedEntryQuoteCalled = true
      return createEntryFetcher()(...args)
    },
    now: () => maturedNowMs,
  }),
  'UNSAFE_WIRING',
  /matured.*new looping actions are disabled/i,
)
assert.equal(maturedEntryQuoteCalled, false)
const maturedExitPreview = await prepareExit({
  position: exitPosition,
  client: createPreflightClient({
    ownerPosition: exitPosition,
    accruedPosition: exitPosition,
    adapterAllowance: 0n,
    pendingTimestamp: maturedTimestamp,
    exchangeRate: 1_000_000_000_000_000_000n,
    pyIndexStored: 999_000_000_000_000_000n,
    rejectOracleCall: true,
  }),
  fetcher: createMaturedExitFetcher(),
  now: () => maturedNowMs,
})
assert.equal(maturedExitPreview.quote.kind, 'redeem-matured-pt')
assert.equal(maturedExitPreview.quote.exactPtIn, exitPosition[2])
assert.equal(maturedExitPreview.quote.estimatedSyIn, exitPosition[2])
assert.equal(
  maturedExitPreview.quote.yieldToken,
  getAddress('0x3333333333333333333333333333333333333333'),
)
const exitPreview = await prepareExit({
  position: exitPosition,
  client: createPreflightClient({
    ownerPosition: exitPosition,
    accruedPosition: exitPosition,
    adapterAllowance: 0n,
    rejectOracleCall: true,
  }),
})
assert.equal(exitPreview.kind, 'exit-preview')
assert.equal(exitPreview.requestedMinimumReturnedAssets, 1n)
assert.equal(
  exitPreview.minimumReturnedAssets,
  exitPreview.quote.minLoanTokenOut - exitPreview.bounds.repaymentCapAssets,
)
assert.equal(exitPreview.position.borrowShares, exitPosition[1])
assert.equal(exitPreview.position.collateral, exitPosition[2])
assert.equal(exitPreview.authorizationRequests[0].purpose, 'authorize-exit')
assert.equal(exitPreview.authorizationRequests[1].purpose, 'revoke-exit')
const exitAuthorizeSignature = await OWNER_ACCOUNT.sign({
  hash: exitPreview.authorizationRequests[0].digest,
})
const exitRevokeSignature = await OWNER_ACCOUNT.sign({
  hash: exitPreview.authorizationRequests[1].digest,
})
const exitBundle = await buildSignedLoopingExitBundle(
  exitPreview,
  exitAuthorizeSignature,
  exitRevokeSignature,
  () => PREFLIGHT_NOW_MS,
)
assert.equal(exitBundle.calls.length, 5)
assert.equal(exitBundle.exactBorrowShares, exitPosition[1])
assert.equal(exitBundle.exactCollateral, exitPosition[2])
const decodedExitBundle = decodeFunctionData({
  abi: bundler3Abi,
  data: exitBundle.data,
})
const repayCall = decodeFunctionData({
  abi: generalAdapter1Abi,
  data: decodedExitBundle.args[0][1].data,
})
assert.equal(repayCall.functionName, 'morphoRepay')
assert.equal(repayCall.args[1], 0n)
assert.equal(repayCall.args[2], exitPosition[1])
assert.equal(repayCall.args[3], exitPreview.bounds.maxRepaySharePriceE27)
const [exitCallbackCalls] = decodeAbiParameters(
  bundler3CallArrayParameters,
  repayCall.args[5],
)
assert.equal(exitCallbackCalls.length, 4)
const withdrawCall = decodeFunctionData({
  abi: generalAdapter1Abi,
  data: exitCallbackCalls[0].data,
})
assert.equal(withdrawCall.functionName, 'morphoWithdrawCollateral')
assert.equal(withdrawCall.args[1], exitPosition[2])

const exitIntent = buildUnsignedLoopingExitSimulation(
  exitPreview,
  () => PREFLIGHT_NOW_MS,
)
assert.equal(exitIntent.calls.length, 3)
assert.equal(
  exitIntent.calls.some((call) =>
    call.to.toLowerCase() === contracts.morpho.toLowerCase()),
  false,
)
const exitSimulation = await simulateUnsignedLoopingIntent({
  client: createPreflightClient({
    ownerPosition: exitPosition,
    accruedPosition: exitPosition,
    adapterAllowance: 0n,
  }),
  intent: exitIntent,
})
const exitReadiness = await revalidateSignedLoopingExit({
  client: createPreflightClient({
    ownerPosition: exitPosition,
    accruedPosition: exitPosition,
    adapterAllowance: 777n,
    ownerLoanBalance: 3_000_000n,
    rejectOracleCall: true,
  }),
  preview: exitPreview,
  bundle: exitBundle,
  simulation: exitSimulation,
  now: () => PREFLIGHT_NOW_MS,
})
assert.equal(exitReadiness.kind, 'exit-broadcast-ready')
assert.equal(exitReadiness.adapterAllowance, 777n)
assert.equal(exitReadiness.ownerLoanBalance, 3_000_000n)
await expectExecutionRejection(
  revalidateSignedLoopingExit({
    client: createPreflightClient({
      ownerPosition: [0n, 500_001n, COLLATERAL],
      accruedPosition: [0n, 500_001n, COLLATERAL],
    }),
    preview: exitPreview,
    bundle: exitBundle,
    simulation: exitSimulation,
    now: () => PREFLIGHT_NOW_MS,
  }),
  'STATE_CONFLICT',
)

console.log('Exit receipt checks require an exact successful bundle transaction')
const exitReceiptClient = createPreflightClient({
  nonce: exitBundle.startingNonce + 2n,
  adapterAllowance: 55n,
  ownerLoanBalance:
    exitReadiness.ownerLoanBalance + exitBundle.minimumReturnedAssets,
  ownerPosition: [0n, 0n, 0n],
  accruedPosition: [0n, 0n, 0n],
  transactionData: exitBundle.data,
  rejectOracleCall: true,
})
const exitReceiptCheck = await verifyLoopingExitReceiptState({
  client: exitReceiptClient,
  preview: exitPreview,
  bundle: exitBundle,
  readiness: exitReadiness,
  transactionHash: TEST_TRANSACTION_HASH,
})
assert.equal(exitReceiptCheck.kind, 'exit-receipt-verified')
assert.equal(exitReceiptCheck.position.classification, 'empty')
assert.equal(exitReceiptCheck.adapterAllowance, 55n)

console.log('Leverage increases conservatively approach the target in one atomic bundle')
const adjustmentPosition = [0n, 500_000n, COLLATERAL]
const aboveFormerDebtThresholdIncreasePreview = await prepareLoopingIncreaseExecution({
  client: createPreflightClient({
    ownerPosition: adjustmentPosition,
    accruedPosition: adjustmentPosition,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
  targetLeverageWad: 1_600_000_000_000_000_000n,
  fetcher: createAdjustmentBuyFetcher(),
  now: () => PREFLIGHT_NOW_MS,
})
assert.ok(
  aboveFormerDebtThresholdIncreasePreview.conservativePost.debtAssets >
    FORMER_BETA_BORROW_ASSETS,
)
const highRiskIncreasePreview = await prepareLoopingIncreaseExecution({
  client: createPreflightClient({
    ownerPosition: adjustmentPosition,
    accruedPosition: adjustmentPosition,
    totalSupplyAssets: 20_000_000n,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
  targetLeverageWad: 6_500_000_000_000_000_000n,
  fetcher: createAdjustmentBuyFetcher(),
  now: () => PREFLIGHT_NOW_MS,
})
assert.ok(
  highRiskIncreasePreview.conservativePost.liquidationBufferBps >=
    BigInt(market.launchPolicy.modelMinLiquidationBufferBps),
)
assert.ok(
  highRiskIncreasePreview.conservativePost.liquidationBufferBps <
    BigInt(market.launchPolicy.minLiquidationBufferBps),
)
const increaseQuoteCounter = { calls: 0 }
const increaseTargetLeverageWad = 1_450_000_000_000_000_000n
const increasePreview = await prepareLoopingIncreaseExecution({
  client: createPreflightClient({
    ownerPosition: adjustmentPosition,
    accruedPosition: adjustmentPosition,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
  targetLeverageWad: increaseTargetLeverageWad,
  fetcher: createAdjustmentBuyFetcher(increaseQuoteCounter),
  now: () => PREFLIGHT_NOW_MS,
})
assert.equal(increasePreview.kind, 'increase-preview')
assert.ok(increaseQuoteCounter.calls > 0 && increaseQuoteCounter.calls <= 4)
assert.ok(
  increasePreview.conservativePost.leverageWad > increasePreview.current.leverageWad,
)
assert.ok(increasePreview.conservativePost.leverageWad <= increaseTargetLeverageWad)
assert.ok(
  increaseTargetLeverageWad - increasePreview.conservativePost.leverageWad <=
    20_000_000_000_000_000n,
)
assert.ok(
  increasePreview.conservativePost.liquidationBufferBps <
    increasePreview.current.liquidationBufferBps,
)
assert.ok(
  increasePreview.conservativePost.liquidationBufferBps >=
    BigInt(market.launchPolicy.minLiquidationBufferBps),
)
const increaseAuthorizeSignature = await OWNER_ACCOUNT.sign({
  hash: increasePreview.authorizationRequests[0].digest,
})
const increaseRevokeSignature = await OWNER_ACCOUNT.sign({
  hash: increasePreview.authorizationRequests[1].digest,
})
const increaseBundle = await buildSignedLoopingIncreaseBundle(
  increasePreview,
  increaseAuthorizeSignature,
  increaseRevokeSignature,
  () => PREFLIGHT_NOW_MS,
)
assert.equal(increaseBundle.kind, 'signed-increase-bundle')
assert.equal(increaseBundle.calls.length, 6)
const decodedIncreaseBundle = decodeFunctionData({
  abi: bundler3Abi,
  data: increaseBundle.data,
})
const increaseSupplyCall = decodeFunctionData({
  abi: generalAdapter1Abi,
  data: decodedIncreaseBundle.args[0][1].data,
})
assert.equal(increaseSupplyCall.functionName, 'morphoSupplyCollateral')
assert.equal(increaseSupplyCall.args[1], increasePreview.quote.minPtOut)
const [increaseCallbackCalls] = decodeAbiParameters(
  bundler3CallArrayParameters,
  increaseSupplyCall.args[3],
)
assert.equal(increaseCallbackCalls.length, 4)
const increaseBorrowCall = decodeFunctionData({
  abi: generalAdapter1Abi,
  data: increaseCallbackCalls[0].data,
})
assert.equal(increaseBorrowCall.functionName, 'morphoBorrow')
assert.equal(increaseBorrowCall.args[1], increasePreview.borrowAssets)
assert.equal(increaseBorrowCall.args[2], 0n)
assert.equal(
  increaseBorrowCall.args[3],
  increasePreview.bounds.minBorrowSharePriceE27,
)
const increaseExposedPair = await decodeExposedLoopingAuthorizationPair({
  market,
  owner: OWNER_ACCOUNT.address,
  bundleData: increaseBundle.data,
})
assert.equal(increaseExposedPair.operation, 'entry')
const increaseIntent = buildUnsignedLoopingIncreaseSimulation(
  increasePreview,
  () => PREFLIGHT_NOW_MS,
)
assert.equal(increaseIntent.operation, 'entry')
assert.equal(increaseIntent.calls.length, 4)
const increaseSimulation = await simulateUnsignedLoopingIntent({
  client: createPreflightClient({
    ownerPosition: adjustmentPosition,
    accruedPosition: adjustmentPosition,
  }),
  intent: increaseIntent,
})
const increaseReadiness = await revalidateSignedLoopingIncrease({
  client: createPreflightClient({
    ownerPosition: adjustmentPosition,
    accruedPosition: adjustmentPosition,
  }),
  preview: increasePreview,
  bundle: increaseBundle,
  simulation: increaseSimulation,
  now: () => PREFLIGHT_NOW_MS,
})
assert.equal(increaseReadiness.operation, 'entry')
const actualAddedBorrowShares = increasePreview.bounds.observedBorrowShares
const increasedPosition = [
  0n,
  adjustmentPosition[1] + actualAddedBorrowShares,
  adjustmentPosition[2] + increasePreview.quote.minPtOut,
]
const increaseReceiptCheck = await verifyLoopingIncreaseReceiptState({
  client: createPreflightClient({
    nonce: increaseBundle.startingNonce + 2n,
    adapterAllowance: increasePreview.wiring.adapterAllowance,
    ownerPosition: increasedPosition,
    accruedPosition: increasedPosition,
    totalBorrowAssets: 5_000_000n + increasePreview.borrowAssets,
    totalBorrowShares: 5_000_000n + actualAddedBorrowShares,
    transactionData: increaseBundle.data,
  }),
  preview: increasePreview,
  bundle: increaseBundle,
  readiness: increaseReadiness,
  transactionHash: TEST_TRANSACTION_HASH,
})
assert.equal(increaseReceiptCheck.kind, 'increase-receipt-verified')
assert.ok(increaseReceiptCheck.achieved.leverageWad <= increaseTargetLeverageWad)

console.log('The adjustment selector reads one pinned state and rejects no-op targets')
const adjustmentSelectorClient = createPreflightClient({
  ownerPosition: adjustmentPosition,
  accruedPosition: adjustmentPosition,
})
const adjustmentSelectorGetBlock = adjustmentSelectorClient.getBlock
let adjustmentSelectorBlockReads = 0
adjustmentSelectorClient.getBlock = async (...args) => {
  adjustmentSelectorBlockReads += 1
  return adjustmentSelectorGetBlock(...args)
}
const selectedIncrease = await prepareLoopingAdjustmentExecution({
  client: adjustmentSelectorClient,
  owner: OWNER_ACCOUNT.address,
  market,
  targetLeverageWad: increaseTargetLeverageWad,
  fetcher: createAdjustmentBuyFetcher(),
  now: () => PREFLIGHT_NOW_MS,
})
assert.equal(selectedIncrease.kind, 'increase-preview')
assert.equal(adjustmentSelectorBlockReads, 1)
let noOpFetcherCalled = false
await expectExecutionRejection(
  prepareLoopingAdjustmentExecution({
    client: createPreflightClient({
      ownerPosition: adjustmentPosition,
      accruedPosition: adjustmentPosition,
    }),
    owner: OWNER_ACCOUNT.address,
    market,
    targetLeverageWad: increasePreview.current.leverageWad,
    fetcher: async () => {
      noOpFetcherCalled = true
      throw new Error('A no-op adjustment must not request a quote')
    },
    now: () => PREFLIGHT_NOW_MS,
  }),
  'NO_OP',
)
assert.equal(noOpFetcherCalled, false)

console.log('Leverage decreases repay exact shares and sell exact PT without a 10% gate')
const decreaseQuoteCounter = { calls: 0 }
const decreaseTargetLeverageWad = 1_200_000_000_000_000_000n
const decreasePreview = await prepareLoopingDecreaseExecution({
  client: createPreflightClient({
    ownerPosition: adjustmentPosition,
    accruedPosition: adjustmentPosition,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
  targetLeverageWad: decreaseTargetLeverageWad,
  fetcher: createAdjustmentSellFetcher(decreaseQuoteCounter),
  now: () => PREFLIGHT_NOW_MS,
})
assert.equal(decreasePreview.kind, 'decrease-preview')
assert.ok(decreaseQuoteCounter.calls > 0 && decreaseQuoteCounter.calls <= 4)
assert.ok(
  decreasePreview.conservativePost.leverageWad < decreasePreview.current.leverageWad,
)
assert.ok(decreasePreview.conservativePost.leverageWad <= decreaseTargetLeverageWad)
assert.ok(
  decreasePreview.conservativePost.liquidationBufferBps >
    decreasePreview.current.liquidationBufferBps,
)
const decreaseAuthorizeSignature = await OWNER_ACCOUNT.sign({
  hash: decreasePreview.authorizationRequests[0].digest,
})
const decreaseRevokeSignature = await OWNER_ACCOUNT.sign({
  hash: decreasePreview.authorizationRequests[1].digest,
})
const decreaseBundle = await buildSignedLoopingDecreaseBundle(
  decreasePreview,
  decreaseAuthorizeSignature,
  decreaseRevokeSignature,
  () => PREFLIGHT_NOW_MS,
)
assert.equal(decreaseBundle.kind, 'signed-decrease-bundle')
assert.equal(decreaseBundle.calls.length, 5)
const decodedDecreaseBundle = decodeFunctionData({
  abi: bundler3Abi,
  data: decreaseBundle.data,
})
const decreaseRepayCall = decodeFunctionData({
  abi: generalAdapter1Abi,
  data: decodedDecreaseBundle.args[0][1].data,
})
assert.equal(decreaseRepayCall.functionName, 'morphoRepay')
assert.equal(decreaseRepayCall.args[1], 0n)
assert.equal(decreaseRepayCall.args[2], decreasePreview.repayShares)
assert.equal(
  decreaseRepayCall.args[3],
  decreasePreview.bounds.maxRepaySharePriceE27,
)
const [decreaseCallbackCalls] = decodeAbiParameters(
  bundler3CallArrayParameters,
  decreaseRepayCall.args[5],
)
assert.equal(decreaseCallbackCalls.length, 4)
const decreaseWithdrawCall = decodeFunctionData({
  abi: generalAdapter1Abi,
  data: decreaseCallbackCalls[0].data,
})
assert.equal(decreaseWithdrawCall.functionName, 'morphoWithdrawCollateral')
assert.equal(decreaseWithdrawCall.args[1], decreasePreview.collateralToSell)
const decreaseIntent = buildUnsignedLoopingDecreaseSimulation(
  decreasePreview,
  () => PREFLIGHT_NOW_MS,
)
assert.equal(decreaseIntent.operation, 'exit')
assert.equal(decreaseIntent.calls.length, 3)
const decreaseSimulation = await simulateUnsignedLoopingIntent({
  client: createPreflightClient({
    ownerPosition: adjustmentPosition,
    accruedPosition: adjustmentPosition,
  }),
  intent: decreaseIntent,
})
const decreaseOracleDriftClient = createPreflightClient({
  ownerPosition: adjustmentPosition,
  accruedPosition: adjustmentPosition,
  oraclePrice: 1_100_000_000_000_000_000_000_000n,
})
const decreaseOracleDriftIntent = buildUnsignedLoopingDecreaseSimulation(
  decreasePreview,
  () => PREFLIGHT_NOW_MS,
)
const decreaseOracleDriftSimulation = await simulateUnsignedLoopingIntent({
  client: decreaseOracleDriftClient,
  intent: decreaseOracleDriftIntent,
})
await expectExecutionRejection(
  revalidateSignedLoopingDecrease({
    client: decreaseOracleDriftClient,
    preview: decreasePreview,
    bundle: decreaseBundle,
    simulation: decreaseOracleDriftSimulation,
    now: () => PREFLIGHT_NOW_MS,
  }),
  'POSITION_UNSAFE',
  /fresh oracle value/i,
)
const decreaseReadiness = await revalidateSignedLoopingDecrease({
  client: createPreflightClient({
    ownerPosition: adjustmentPosition,
    accruedPosition: adjustmentPosition,
  }),
  preview: decreasePreview,
  bundle: decreaseBundle,
  simulation: decreaseSimulation,
  now: () => PREFLIGHT_NOW_MS,
})
assert.equal(decreaseReadiness.operation, 'exit')
const repaidAssets =
  (decreasePreview.repayShares * 5_000_001n + 5_999_999n) / 6_000_000n
const decreasedPosition = [
  0n,
  adjustmentPosition[1] - decreasePreview.repayShares,
  adjustmentPosition[2] - decreasePreview.collateralToSell,
]
const decreaseReceiptCheck = await verifyLoopingDecreaseReceiptState({
  client: createPreflightClient({
    nonce: decreaseBundle.startingNonce + 2n,
    adapterAllowance: decreasePreview.wiring.adapterAllowance,
    ownerLoanBalance:
      decreaseReadiness.ownerLoanBalance + decreaseBundle.minimumReturnedAssets,
    ownerPosition: decreasedPosition,
    accruedPosition: decreasedPosition,
    totalBorrowAssets: 5_000_000n - repaidAssets,
    totalBorrowShares: 5_000_000n - decreasePreview.repayShares,
    transactionData: decreaseBundle.data,
  }),
  preview: decreasePreview,
  bundle: decreaseBundle,
  readiness: decreaseReadiness,
  transactionHash: TEST_TRANSACTION_HASH,
})
assert.equal(decreaseReceiptCheck.kind, 'decrease-receipt-verified')
assert.ok(decreaseReceiptCheck.achieved.leverageWad <= decreaseTargetLeverageWad)

const insideRedMarkerPosition = [0n, 1_500_000n, COLLATERAL]
const insideRedMarkerDecrease = await prepareLoopingDecreaseExecution({
  client: createPreflightClient({
    ownerPosition: insideRedMarkerPosition,
    accruedPosition: insideRedMarkerPosition,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
  targetLeverageWad: 5_800_000_000_000_000_000n,
  fetcher: createAdjustmentSellFetcher(),
  now: () => PREFLIGHT_NOW_MS,
})
assert.ok(
  insideRedMarkerDecrease.current.liquidationBufferBps <
    BigInt(market.launchPolicy.minLiquidationBufferBps),
)
assert.ok(
  insideRedMarkerDecrease.conservativePost.liquidationBufferBps >
    insideRedMarkerDecrease.current.liquidationBufferBps,
)
assert.ok(
  insideRedMarkerDecrease.conservativePost.liquidationBufferBps <
    BigInt(market.launchPolicy.minLiquidationBufferBps),
)

console.log('Authorization recovery decodes signatures and remains position-independent')
const exposedPair = await decodeExposedLoopingAuthorizationPair({
  market,
  owner: OWNER_ACCOUNT.address,
  bundleData: bundle.data,
})
assert.equal(exposedPair.operation, 'entry')
const reloadedPair = await readExposedLoopingAuthorizationPairFromTransaction({
  client: createPreflightClient({ transactionData: bundle.data }),
  market,
  owner: OWNER_ACCOUNT.address,
  transactionHash: TEST_TRANSACTION_HASH,
})
assert.equal(reloadedPair.startingNonce, exposedPair.startingNonce)
assert.equal(reloadedPair.deadline, exposedPair.deadline)
const exposedState = await readExposedLoopingAuthorizationRecoveryState({
  client: createPreflightClient(),
  pair: exposedPair,
})
const consumePair = classifyExposedLoopingAuthorization({
  pair: exposedPair,
  state: exposedState,
})
assert.equal(consumePair.action, 'consume-pair')
const consumeIntent = buildLoopingAuthorizationRecoveryIntent({
  pair: exposedPair,
  classification: consumePair,
})
assert.equal(consumeIntent.kind, 'authorization-signature-recovery')
assert.equal(consumeIntent.calls.length, 2)
const driftedRecovery = classifyExposedLoopingAuthorization({
  pair: exposedPair,
  state: {
    ...exposedState,
    position: {
      supplyShares: 0n,
      borrowShares: 1n,
      collateral: 1n,
      classification: 'open-loop',
    },
  },
})
assert.equal(driftedRecovery.action, 'consume-pair')
const directClassification = classifyExposedLoopingAuthorization({
  pair: exposedPair,
  state: {
    ...exposedState,
    blockTimestamp: exposedPair.deadline + 1n,
    adapterAuthorized: true,
  },
})
assert.equal(directClassification.action, 'direct-revoke')
const directRecovery = buildLoopingAuthorizationRecoveryIntent({
  pair: exposedPair,
  classification: directClassification,
})
const decodedDirectRecovery = decodeFunctionData({
  abi: morphoBlueAbi,
  data: directRecovery.data,
})
assert.equal(decodedDirectRecovery.functionName, 'setAuthorization')
assert.deepEqual(decodedDirectRecovery.args, [contracts.generalAdapter1, false])
assert.equal(
  await prepareDirectLoopingAuthorizationRevoke({
    client: createPreflightClient(),
    owner: OWNER_ACCOUNT.address,
    market,
  }),
  undefined,
)
const reloadRevoke = await prepareDirectLoopingAuthorizationRevoke({
  client: createPreflightClient({ adapterAuthorized: true }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(reloadRevoke.kind, 'direct-authorization-revoke')

console.log('A fresh signed false authorization burns a no-hash exposed nonce')
const nonceBurnPreview = await prepareLoopingAuthorizationNonceBurn({
  client: createPreflightClient(),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(nonceBurnPreview.request.purpose, 'burn-authorization-nonce')
assert.equal(nonceBurnPreview.request.message.isAuthorized, false)
assert.equal(nonceBurnPreview.startingNonce, 7n)
assert.equal(
  nonceBurnPreview.request.message.deadline - nonceBurnPreview.blockTimestamp,
  market.launchPolicy.authorizationLifetimeSeconds,
)
const nonceBurnSignature = await OWNER_ACCOUNT.sign({
  hash: nonceBurnPreview.request.digest,
})
const nonceBurnIntent = await buildLoopingAuthorizationNonceBurnIntent({
  client: createPreflightClient(),
  preview: nonceBurnPreview,
  signature: nonceBurnSignature,
})
const decodedNonceBurn = decodeFunctionData({
  abi: morphoBlueAbi,
  data: nonceBurnIntent.data,
})
assert.equal(decodedNonceBurn.functionName, 'setAuthorizationWithSig')
assert.equal(decodedNonceBurn.args[0].nonce, 7n)
assert.equal(decodedNonceBurn.args[0].isAuthorized, false)
assert.equal(nonceBurnIntent.expectedPostconditions.nonce, 8n)
await expectExecutionRejection(
  buildLoopingAuthorizationNonceBurnIntent({
    client: createPreflightClient({ nonce: 8n }),
    preview: nonceBurnPreview,
    signature: nonceBurnSignature,
  }),
  'STATE_CONFLICT',
)
await expectExecutionRejection(
  buildLoopingAuthorizationNonceBurnIntent({
    client: createPreflightClient(),
    preview: Object.freeze({ ...nonceBurnPreview }),
    signature: nonceBurnSignature,
  }),
  'STATE_CONFLICT',
)

console.log('Direct rescue is router- and oracle-independent and fully bounded')
const urgentAuthorizationCleanup = await prepareDirectLoopingRescue({
  client: createPreflightClient({
    adapterAuthorized: true,
    ownerPosition: [1n, 0n, 0n],
    accruedPosition: [1n, 0n, 0n],
    rejectOracleCall: true,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(urgentAuthorizationCleanup.phase, 'revoke-adapter')
const adapterCleanup = await prepareDirectLoopingRescue({
  client: createPreflightClient({
    ownerPosition: exitPosition,
    accruedPosition: exitPosition,
    rejectOracleCall: true,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(adapterCleanup.phase, 'clear-adapter-allowance')
assert.equal(adapterCleanup.intents.length, 1)
assert.equal(adapterCleanup.requiresReprepareAfterEachStep, true)
const repaymentApproval = await prepareDirectLoopingRescue({
  client: createPreflightClient({
    adapterAllowance: 0n,
    morphoAllowance: 0n,
    ownerPosition: exitPosition,
    accruedPosition: exitPosition,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(repaymentApproval.phase, 'approve-exact-repayment')
const exactApproval = decodeFunctionData({
  abi: loopingErc20Abi,
  data: repaymentApproval.intents[0].data,
})
assert.equal(exactApproval.functionName, 'approve')
assert.equal(exactApproval.args[1], repaymentApproval.bounds.repaymentCapAssets)
const directRescue = await prepareDirectLoopingRescue({
  client: createPreflightClient({
    adapterAllowance: 0n,
    morphoAllowance: repaymentApproval.bounds.repaymentCapAssets,
    ownerPosition: exitPosition,
    accruedPosition: exitPosition,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(directRescue.phase, 'repay-exact-shares')
const directRepay = decodeFunctionData({
  abi: morphoBlueAbi,
  data: directRescue.intents[0].data,
})
assert.equal(directRepay.functionName, 'repay')
assert.equal(directRepay.args[1], 0n)
assert.equal(directRepay.args[2], exitPosition[1])
const collateralOnly = [0n, 0n, COLLATERAL]
const allowanceCleanupAfterRepay = await prepareDirectLoopingRescue({
  client: createPreflightClient({
    adapterAllowance: 0n,
    morphoAllowance: 1n,
    ownerPosition: collateralOnly,
    accruedPosition: collateralOnly,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(allowanceCleanupAfterRepay.phase, 'clear-morpho-allowance-after')
assert.equal(allowanceCleanupAfterRepay.bounds, undefined)
const collateralWithdrawal = await prepareDirectLoopingRescue({
  client: createPreflightClient({
    adapterAllowance: 0n,
    morphoAllowance: 0n,
    ownerPosition: collateralOnly,
    accruedPosition: collateralOnly,
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(collateralWithdrawal.phase, 'withdraw-exact-collateral')
const directWithdraw = decodeFunctionData({
  abi: morphoBlueAbi,
  data: collateralWithdrawal.intents[0].data,
})
assert.equal(directWithdraw.functionName, 'withdrawCollateral')
assert.equal(directWithdraw.args[1], exitPosition[2])
assert.equal(directRescue.expectedPostconditions.position, 'empty')
const completedRescue = await prepareDirectLoopingRescue({
  client: createPreflightClient({
    adapterAllowance: 0n,
    morphoAllowance: 0n,
    ownerPosition: [0n, 0n, 0n],
    accruedPosition: [0n, 0n, 0n],
  }),
  owner: OWNER_ACCOUNT.address,
  market,
})
assert.equal(completedRescue.phase, 'complete')
assert.equal(completedRescue.intents.length, 0)

console.log('Forged markets and unbranded previews fail before RPC or signing')
await expectExecutionRejection(
  prepareLoopingEntryExecution({
    client: noRpcClient,
    owner: getAddress('0x1111111111111111111111111111111111111111'),
    market: { ...market, marketId: `0x${'44'.repeat(32)}` },
    equityAssets: 1n,
    borrowAssets: 1n,
  }),
  'UNSUPPORTED_CHAIN',
)
await expectExecutionRejection(
  buildSignedLoopingEntryBundle(
    Object.freeze({ kind: 'entry-preview', market }),
    `0x${'11'.repeat(65)}`,
    `0x${'22'.repeat(65)}`,
  ),
  'STATE_CONFLICT',
)

assert.equal(
  'simulateLoopingBundle' in loopingExecution,
  false,
  'signed bundle simulation must not be exposed to the browser',
)

console.log('Compiler forks retry only complete Pendle preparations rate-limited with HTTP 429')
let retryAttempts = 0
const retryWaits = []
const retryResult = await prepareWithPendleQuoteRateLimitRetry(
  'deterministic check',
  async () => {
    retryAttempts += 1
    if (retryAttempts < 3) {
      throw new LoopingExecutionError(
        'INVALID_QUOTE',
        'Pendle quote returned HTTP 429.',
      )
    }
    return { attempt: retryAttempts }
  },
  {
    retryDelaysMs: [5, 15],
    wait: async (delay) => retryWaits.push(delay),
    warn: () => {},
  },
)
assert.deepEqual(retryResult, { attempt: 3 })
assert.equal(retryAttempts, 3)
assert.deepEqual(retryWaits, [5, 15])

for (const nonRetryableError of [
  new LoopingExecutionError('INVALID_QUOTE', 'Pendle quote returned HTTP 500.'),
  new LoopingExecutionError('INVALID_QUOTE', 'Pendle route validation failed.'),
  new TypeError('fetch failed'),
]) {
  let nonRetryableAttempts = 0
  const nonRetryableWaits = []
  await assert.rejects(
    prepareWithPendleQuoteRateLimitRetry(
      'deterministic rejection check',
      async () => {
        nonRetryableAttempts += 1
        throw nonRetryableError
      },
      {
        retryDelaysMs: [5, 15],
        wait: async (delay) => nonRetryableWaits.push(delay),
        warn: () => {},
      },
    ),
    (error) => error === nonRetryableError,
  )
  assert.equal(nonRetryableAttempts, 1)
  assert.deepEqual(nonRetryableWaits, [])
}

const exhaustedRateLimit = new LoopingExecutionError(
  'INVALID_QUOTE',
  'Pendle quote returned HTTP 429: quota exhausted',
)
let exhaustedAttempts = 0
const exhaustedWaits = []
await assert.rejects(
  prepareWithPendleQuoteRateLimitRetry(
    'deterministic exhaustion check',
    async () => {
      exhaustedAttempts += 1
      throw exhaustedRateLimit
    },
    {
      retryDelaysMs: [5, 15],
      wait: async (delay) => exhaustedWaits.push(delay),
      warn: () => {},
    },
  ),
  (error) => error === exhaustedRateLimit,
)
assert.equal(exhaustedAttempts, 3)
assert.deepEqual(exhaustedWaits, [5, 15])

console.log('The browser-safe compiler contains no wallet write or broadcast primitive')
const coreSource = readFileSync(
  new URL('../src/lib/loopingExecution.ts', import.meta.url),
  'utf8',
)
for (const forbiddenPrimitive of [
  'writeContract',
  'sendTransaction',
  'sendRawTransaction',
  'signTransaction',
  'eth_sendTransaction',
  'eth_sendRawTransaction',
]) {
  assert.equal(
    coreSource.includes(forbiddenPrimitive),
    false,
    `looping execution core must not contain ${forbiddenPrimitive}`,
  )
}
