/**
 * Fail-closed compiler for the reviewed PT/Morpho looping markets.
 *
 * This module can fetch and validate quotes, read pending on-chain state,
 * construct EIP-712 requests, assemble signed Bundler3 calldata, and expose
 * signature-free simulation/recovery intents. It deliberately contains no
 * wallet write or broadcast path.
 */

import {
  concatHex,
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  hashTypedData,
  keccak256,
  maxUint256,
  parseAbi,
  parseAbiParameters,
  parseSignature,
  recoverAddress,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import type { Address, Hex, Log, PublicClient } from 'viem'
import {
  bundler3Abi,
  bundler3CallArrayParameters,
  generalAdapter1Abi,
  loopingErc20Abi,
  loopingMulticall3Abi,
  loopingStandardizedYieldAbi,
  loopingYieldTokenAbi,
  morphoBlueAbi,
  morphoMarketIdParameters,
  morphoOracleAbi,
  pendleLoopingMarketAbi,
  pendleLoopingRouterAbi,
} from './loopingAbi.ts'
import { routerActionsAbi } from './pendleAbi.ts'
import {
  getLoopingExecutionMarket,
  requireLoopingKyberExecutor,
  requireLoopingRouteAddress,
} from './loopingRegistry.ts'
import type {
  LoopingExecutionMarket,
  LoopingRuntimeCodePolicy,
} from './loopingRegistry.ts'

const PENDLE_CORE_API = 'https://api-v2.pendle.finance/core'
const BPS = 10_000n
const WAD = 10n ** 18n
const RAY = 10n ** 27n
const ORACLE_PRICE_SCALE = 10n ** 36n
const VIRTUAL_SHARES = 1_000_000n
const VIRTUAL_ASSETS = 1n
const MAX_APPROX_ITERATIONS = 64n
const MAX_APPROX_EPS = 100_000_000_000_000n
/** Pendle may quote a looser value for low-decimal PTs; it is never executed as-is. */
const MAX_QUOTED_APPROX_EPS = 1_000_000_000_000_000n
const MAX_QUOTE_ROUTES = 16
const MAX_ADJUSTMENT_QUOTE_ATTEMPTS = 4
const MAX_ADJUSTMENT_FIXED_POINT_STEPS = 32
const ADJUSTMENT_TARGET_TOLERANCE_WAD = 20_000_000_000_000_000n
const PENDLE_QUOTE_TRANSPORT_ATTEMPTS = 2
const PENDLE_QUOTE_RETRY_DELAY_MS = 250
const MORPHO_IS_AUTHORIZED_MAPPING_SLOT = 6n
const preparedEntryPreviews = new WeakSet<object>()
const preparedExitPreviews = new WeakSet<object>()
const preparedIncreasePreviews = new WeakSet<object>()
const preparedDecreasePreviews = new WeakSet<object>()
const preparedSimulationIntents = new WeakSet<object>()
const verifiedSimulationEvidence = new WeakSet<object>()
const preparedBroadcastReadiness = new WeakSet<object>()
const preparedNonceBurnPreviews = new WeakSet<object>()

const authorizationHashParameters = parseAbiParameters(
  'bytes32,address,address,bool,uint256,uint256',
)
const domainHashParameters = parseAbiParameters('bytes32,uint256,address')
const nestedAddressMappingParameters = parseAbiParameters('address,uint256')
const nestedAddressMappingSlotParameters = parseAbiParameters('address,bytes32')
const simulationFingerprintParameters = parseAbiParameters(
  'uint256,address,bytes32,uint8,address,bytes,bytes32,bytes32',
)
const implementationStorageParameters = parseAbiParameters('address')
const authorizationTypeHash = keccak256(
  toHex(
    'Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)',
  ),
)
const eip712DomainTypeHash = keccak256(
  toHex('EIP712Domain(uint256 chainId,address verifyingContract)'),
)

/** Exact deployed Kyber MetaAggregationRouterV2 tuple used by fresh routes. */
const kyberMetaAggregationRouterV2Abi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount,uint256 gasUsed)',
])
const erc20TransferEventAbi = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])

export type LoopingExecutionErrorCode =
  | 'INVALID_INPUT'
  | 'NO_OP'
  | 'UNSUPPORTED_CHAIN'
  | 'UNSAFE_WIRING'
  | 'INVALID_QUOTE'
  | 'ROUTE_NOT_ALLOWED'
  | 'STATE_CONFLICT'
  | 'POSITION_UNSAFE'
  | 'QUOTE_EXPIRED'
  | 'INVALID_SIGNATURE'
  | 'SIMULATION_FAILED'

export class LoopingExecutionError extends Error {
  readonly code: LoopingExecutionErrorCode

  constructor(
    code: LoopingExecutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'LoopingExecutionError'
    this.code = code
  }
}

export type LoopingFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

function defaultLoopingFetcher(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Some embedded browsers require the native fetch receiver to remain Window.
  return globalThis.fetch(input, init)
}

export interface LoopingWiringSnapshot {
  blockTimestamp: bigint
  domainSeparator: Hex
  nonce: bigint
  adapterAuthorized: boolean
  adapterAllowance: bigint
  morphoAllowance: bigint
  ownerLoanBalance: bigint
  tokensIn: readonly Address[]
  tokensOut: readonly Address[]
  kyberExecutorCodeHashes: Readonly<Record<string, Hex>>
}

function canonicalExecutionMarket(
  market: Readonly<LoopingExecutionMarket>,
): Readonly<LoopingExecutionMarket> {
  try {
    return getLoopingExecutionMarket(market.chainId, market.marketId)
  } catch (error) {
    fail('UNSUPPORTED_CHAIN', 'Looping execution market is not allowlisted.', error)
  }
}

export interface ValidatedLoopingBuyRoute {
  kind: 'buy-pt'
  calldata: Hex
  minPtOut: bigint
  expectedPtOut: bigint
  mintSyToken: Address
  kyberExecutor: Address | null
  kyberMinReturn: bigint
}

export type LoopingAcquisitionMode = 'market' | 'mint'

function resolveLoopingAcquisitionMode(value: unknown): LoopingAcquisitionMode {
  if (value === undefined || value === 'market') return 'market'
  if (value === 'mint') return 'mint'
  fail(
    'INVALID_INPUT',
    'Looping acquisition mode must be exactly "market" or "mint".',
  )
}

export interface ValidatedLoopingMintRoute {
  kind: 'mint-pt-yt'
  calldata: Hex
  /** PT collateral floor alias retained for shared Market/Mint consumers. */
  minPtOut: bigint
  /** Expected PT alias retained for shared Market/Mint consumers. */
  expectedPtOut: bigint
  minPyOut: bigint
  expectedPyOut: bigint
  yieldToken: Address
  mintSyToken: Address
  kyberExecutor: Address | null
  kyberMinReturn: bigint
}

export type ValidatedLoopingAcquisitionRoute =
  | ValidatedLoopingBuyRoute
  | ValidatedLoopingMintRoute

export interface ValidatedLoopingExitRoute {
  kind: 'sell-pt'
  calldata: Hex
  exactPtIn: bigint
  minLoanTokenOut: bigint
  expectedLoanTokenOut: bigint
  redeemSyToken: Address
  kyberExecutor: Address | null
  kyberMinReturn: bigint
}

export interface ValidatedLoopingMaturedExitRoute {
  kind: 'redeem-matured-pt'
  calldata: Hex
  exactPtIn: bigint
  estimatedSyIn: bigint
  minLoanTokenOut: bigint
  expectedLoanTokenOut: bigint
  redeemSyToken: Address
  yieldToken: Address
  kyberExecutor: Address | null
  kyberMinReturn: bigint
}

interface RouteValidationBase {
  route: unknown
  market: Readonly<LoopingExecutionMarket>
  wiring: Pick<
    LoopingWiringSnapshot,
    'tokensIn' | 'tokensOut' | 'kyberExecutorCodeHashes'
  >
}

function fail(
  code: LoopingExecutionErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new LoopingExecutionError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizedTransportDetail(error: unknown): string {
  if (!(error instanceof Error)) return ''
  return error.message.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function delayMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_QUOTE', `${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('INVALID_QUOTE', `${label} must be an array.`)
  return value
}

function asUnsignedBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) fail('INVALID_QUOTE', `${label} must be unsigned.`)
    return value
  }
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return BigInt(value)
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value)
  }
  fail('INVALID_QUOTE', `${label} must be an unsigned integer.`)
}

function asHex(value: unknown, label: string, allowEmpty = false): Hex {
  if (
    typeof value !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
    (!allowEmpty && value.length <= 2)
  ) {
    fail('INVALID_QUOTE', `${label} must be even-length 0x-prefixed bytes.`)
  }
  return value as Hex
}

function asAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string') {
    fail('INVALID_QUOTE', `${label} must be an address.`)
  }
  try {
    return getAddress(value)
  } catch (error) {
    fail('INVALID_QUOTE', `${label} is not a valid address.`, error)
  }
}

function sameAddress(left: Address | string, right: Address | string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function sameNullableAddress(
  left: Address | null,
  right: Address | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameAddress(left, right)
}

function sameHex(left: Hex | string, right: Hex | string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function hexByteLength(value: Hex): number {
  return (value.length - 2) / 2
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) fail('INVALID_INPUT', 'Cannot divide by zero.')
  return (numerator + denominator - 1n) / denominator
}

function assertEmptyLimitOrderData(value: {
  limitRouter: Address
  epsSkipMarket: bigint
  normalFills: readonly unknown[]
  flashFills: readonly unknown[]
  optData: Hex
}, label: string): void {
  if (
    !sameAddress(value.limitRouter, zeroAddress) ||
    value.epsSkipMarket !== 0n ||
    value.normalFills.length !== 0 ||
    value.flashFills.length !== 0 ||
    value.optData !== '0x'
  ) {
    fail(
      'ROUTE_NOT_ALLOWED',
      `${label} unexpectedly contains Pendle limit-order data.`,
    )
  }
}

function assertAddressArrayContains(
  values: readonly Address[],
  candidate: Address,
  label: string,
): void {
  if (!values.some((value) => sameAddress(value, candidate))) {
    fail('ROUTE_NOT_ALLOWED', `${label} is not supported by the live SY.`)
  }
}

function resolveAllowedRouteAddress(
  market: Readonly<LoopingExecutionMarket>,
  kind: 'externalRouter' | 'mintSyToken' | 'redeemSyToken',
  candidate: string,
): Address {
  try {
    return requireLoopingRouteAddress(market, kind, candidate)
  } catch (error) {
    fail(
      'ROUTE_NOT_ALLOWED',
      `${kind} is not allowlisted for this looping market.`,
      error,
    )
  }
}

interface ValidatedKyberEnvelope {
  executor: Address
  minReturnAmount: bigint
}

function decodeKyberSwapCalldata(calldata: Hex) {
  try {
    return decodeFunctionData({
      abi: kyberMetaAggregationRouterV2Abi,
      data: calldata,
    })
  } catch (error) {
    fail(
      'ROUTE_NOT_ALLOWED',
      'Nested Kyber calldata is not the reviewed MetaAggregationRouterV2 swap tuple.',
      error,
    )
  }
}

function decodePendleLoopingCalldata(calldata: Hex) {
  try {
    return decodeFunctionData({ abi: pendleLoopingRouterAbi, data: calldata })
  } catch (error) {
    fail('INVALID_QUOTE', 'Pendle route calldata is not decodable.', error)
  }
}

function decodePendleMintCalldata(calldata: Hex) {
  try {
    return decodeFunctionData({ abi: routerActionsAbi, data: calldata })
  } catch (error) {
    fail('INVALID_QUOTE', 'Pendle mint route calldata is not decodable.', error)
  }
}

function validateNestedKyberCalldata(args: {
  market: Readonly<LoopingExecutionMarket>
  wiring: Pick<LoopingWiringSnapshot, 'kyberExecutorCodeHashes'>
  calldata: Hex
  expectedSourceToken: Address
  expectedDestinationToken: Address
  expectedAmount?: bigint
  label: string
}): ValidatedKyberEnvelope {
  const decoded = decodeKyberSwapCalldata(args.calldata)
  if (decoded.functionName !== 'swap') {
    fail('ROUTE_NOT_ALLOWED', `${args.label} Kyber selector changed.`)
  }

  const execution = decoded.args[0]
  const executor = getAddress(execution.callTarget)
  const runtimeCodeHash =
    args.wiring.kyberExecutorCodeHashes[executor.toLowerCase()]
  if (!runtimeCodeHash) {
    fail(
      'ROUTE_NOT_ALLOWED',
      `${args.label} Kyber executor has no verified pending-state code hash.`,
    )
  }
  try {
    requireLoopingKyberExecutor(args.market, executor, runtimeCodeHash)
  } catch (error) {
    fail(
      'ROUTE_NOT_ALLOWED',
      `${args.label} Kyber executor or runtime code changed.`,
      error,
    )
  }

  const { desc } = execution
  if (!sameAddress(execution.approveTarget, zeroAddress)) {
    fail(
      'ROUTE_NOT_ALLOWED',
      `${args.label} nested Kyber approval target changed.`,
    )
  }
  if (
    !sameAddress(desc.srcToken, args.expectedSourceToken) ||
    !sameAddress(desc.dstToken, args.expectedDestinationToken)
  ) {
    fail('ROUTE_NOT_ALLOWED', `${args.label} nested Kyber tokens changed.`)
  }
  if (!sameAddress(desc.dstReceiver, args.market.contracts.pendleRouter)) {
    fail('ROUTE_NOT_ALLOWED', `${args.label} nested Kyber destination changed.`)
  }
  if (
    desc.srcReceivers.length === 0 ||
    desc.srcReceivers.length >
      args.market.routePolicy.kyber.maxSourceReceivers ||
    desc.srcReceivers.length !== desc.srcAmounts.length ||
    desc.srcReceivers.some((receiver) => sameAddress(receiver, zeroAddress)) ||
    desc.srcAmounts.some((amount) => amount <= 0n)
  ) {
    fail(
      'ROUTE_NOT_ALLOWED',
      `${args.label} nested Kyber receiver/amount structure changed.`,
    )
  }
  const totalSourceAmount = desc.srcAmounts.reduce(
    (total, amount) => total + amount,
    0n,
  )
  if (
    desc.amount <= 0n ||
    totalSourceAmount !== desc.amount ||
    (args.expectedAmount !== undefined && desc.amount !== args.expectedAmount)
  ) {
    fail('ROUTE_NOT_ALLOWED', `${args.label} nested Kyber input amount changed.`)
  }
  if (desc.minReturnAmount <= 0n) {
    fail('ROUTE_NOT_ALLOWED', `${args.label} nested Kyber output floor is invalid.`)
  }
  if (desc.flags !== args.market.routePolicy.kyber.expectedFlags) {
    fail('ROUTE_NOT_ALLOWED', `${args.label} nested Kyber flags changed.`)
  }
  if (desc.feeReceivers.length !== 0 || desc.feeAmounts.length !== 0) {
    fail('ROUTE_NOT_ALLOWED', `${args.label} nested Kyber fees changed.`)
  }
  if (desc.permit !== '0x') {
    fail('ROUTE_NOT_ALLOWED', `${args.label} nested Kyber permit changed.`)
  }
  if (
    execution.targetData === '0x' ||
    hexByteLength(execution.targetData) >
      args.market.routePolicy.kyber.maxTargetDataBytes ||
    hexByteLength(execution.clientData) >
      args.market.routePolicy.kyber.maxClientDataBytes
  ) {
    fail(
      'ROUTE_NOT_ALLOWED',
      `${args.label} nested Kyber payload is empty or exceeds reviewed byte bounds.`,
    )
  }

  const roundTrip = encodeFunctionData({
    abi: kyberMetaAggregationRouterV2Abi,
    functionName: 'swap',
    args: [execution],
  })
  if (!sameHex(roundTrip, args.calldata)) {
    fail(
      'ROUTE_NOT_ALLOWED',
      `${args.label} nested Kyber calldata failed ABI round-trip validation.`,
    )
  }
  return { executor, minReturnAmount: desc.minReturnAmount }
}

function validateRouteEnvelope(
  routeValue: unknown,
  market: Readonly<LoopingExecutionMarket>,
  expectedMethod:
    | 'swapExactTokenForPt'
    | 'mintPyFromToken'
    | 'swapExactPtForToken'
    | 'redeemSyToToken',
): {
  route: Record<string, unknown>
  calldata: Hex
  outputs: readonly unknown[]
} {
  const route = asRecord(routeValue, 'Pendle route')
  const tx = asRecord(route.tx, 'Pendle route transaction')
  const contractParamInfo = asRecord(
    route.contractParamInfo,
    'Pendle contract parameter info',
  )
  const data = asRecord(route.data, 'Pendle route data')
  if (contractParamInfo.method !== expectedMethod) {
    fail(
      'INVALID_QUOTE',
      `Pendle returned ${String(contractParamInfo.method)}, expected ${expectedMethod}.`,
    )
  }
  const target = asAddress(tx.to, 'Pendle route target')
  const sender = asAddress(tx.from, 'Pendle route sender')
  if (
    !sameAddress(target, market.contracts.pendleRouter) ||
    !sameAddress(sender, market.contracts.generalAdapter1)
  ) {
    fail('ROUTE_NOT_ALLOWED', 'Pendle route sender or target changed.')
  }
  if (asUnsignedBigInt(tx.value ?? 0, 'Pendle native value') !== 0n) {
    fail('ROUTE_NOT_ALLOWED', 'Pendle route unexpectedly transfers native value.')
  }
  if (
    expectedMethod !== 'redeemSyToToken' &&
    expectedMethod !== 'mintPyFromToken' &&
    String(data.aggregatorType ?? '').toLowerCase() !== 'kyberswap'
  ) {
    fail('ROUTE_NOT_ALLOWED', 'Pendle did not return a KyberSwap route.')
  }
  const calldata = asHex(tx.data, 'Pendle route calldata')
  return {
    route,
    calldata,
    outputs: asArray(route.outputs, 'Pendle route outputs'),
  }
}

function assertMintPyQuoteFloor(args: {
  market: Readonly<LoopingExecutionMarket>
  minPyOut: bigint
  expectedPyOut: bigint
}): void {
  const slippageBps = BigInt(
    Math.ceil(args.market.launchPolicy.quoteSlippage * Number(BPS)),
  )
  if (
    slippageBps <= 0n ||
    slippageBps >= BPS ||
    (args.minPyOut + 1n) * BPS <
      args.expectedPyOut * (BPS - slippageBps)
  ) {
    fail(
      'INVALID_QUOTE',
      'Pendle mint minimum is weaker than the configured quote slippage.',
    )
  }
}

export function validateLoopingBuyRoute(
  args: RouteValidationBase & { amountIn: bigint },
): ValidatedLoopingBuyRoute {
  if (args.amountIn <= 0n) {
    fail('INVALID_INPUT', 'Buy-route input amount must be positive.')
  }
  const envelope = validateRouteEnvelope(
    args.route,
    args.market,
    'swapExactTokenForPt',
  )
  const decoded = decodePendleLoopingCalldata(envelope.calldata)
  if (decoded.functionName !== 'swapExactTokenForPt') {
    fail('INVALID_QUOTE', 'Pendle buy-route selector changed.')
  }
  const [receiver, pendleMarket, minPtOut, guess, input, limit] =
    decoded.args
  const mintSyToken = resolveAllowedRouteAddress(
    args.market,
    'mintSyToken',
    input.tokenMintSy,
  )
  assertAddressArrayContains(args.wiring.tokensIn, mintSyToken, 'Mint SY token')
  if (
    !sameAddress(receiver, args.market.contracts.generalAdapter1) ||
    !sameAddress(pendleMarket, args.market.pendleMarket) ||
    !sameAddress(input.tokenIn, args.market.morphoMarketParams.loanToken) ||
    input.netTokenIn !== args.amountIn ||
    minPtOut <= 0n ||
    guess.guessMin > guess.guessOffchain ||
    guess.guessOffchain > guess.guessMax ||
    guess.maxIteration <= 0n ||
    guess.maxIteration > MAX_APPROX_ITERATIONS ||
    guess.eps <= 0n ||
    guess.eps > MAX_QUOTED_APPROX_EPS
  ) {
    fail(
      'ROUTE_NOT_ALLOWED',
      'Pendle buy route changed its receiver, market, token, amount, approximation, or swap policy.',
    )
  }
  assertEmptyLimitOrderData(limit, 'Pendle buy route')

  let kyberExecutor: Address | null = null
  let kyberMinReturn = 0n
  const isDirectMint =
    input.swapData.swapType === 0 &&
    sameAddress(input.swapData.extRouter, zeroAddress) &&
    input.swapData.extCalldata === '0x' &&
    input.swapData.needScale === false &&
    sameAddress(input.pendleSwap, zeroAddress) &&
    sameAddress(mintSyToken, args.market.morphoMarketParams.loanToken)
  if (!isDirectMint) {
    const externalRouter = resolveAllowedRouteAddress(
      args.market,
      'externalRouter',
      input.swapData.extRouter,
    )
    if (
      !sameAddress(input.pendleSwap, args.market.contracts.pendleSwap) ||
      input.swapData.swapType !== args.market.routePolicy.swapType ||
      !sameAddress(input.swapData.extRouter, externalRouter) ||
      input.swapData.needScale !== args.market.routePolicy.entryNeedScale
    ) {
      fail('ROUTE_NOT_ALLOWED', 'Pendle buy route swap policy changed.')
    }
    const kyber = validateNestedKyberCalldata({
      market: args.market,
      wiring: args.wiring,
      calldata: input.swapData.extCalldata,
      expectedSourceToken: args.market.morphoMarketParams.loanToken,
      expectedDestinationToken: mintSyToken,
      expectedAmount: args.amountIn,
      label: 'Pendle buy route',
    })
    kyberExecutor = kyber.executor
    kyberMinReturn = kyber.minReturnAmount
  }

  if (envelope.outputs.length !== 1) {
    fail('INVALID_QUOTE', 'Pendle buy route must return exactly one output.')
  }
  const output = asRecord(envelope.outputs[0], 'Pendle buy route output')
  const expectedPtOut = asUnsignedBigInt(
    output.amount,
    'Pendle expected PT output',
  )
  if (
    !sameAddress(
      asAddress(output.token, 'Pendle PT output token'),
      args.market.morphoMarketParams.collateralToken,
    ) ||
    expectedPtOut < minPtOut
  ) {
    fail('INVALID_QUOTE', 'Pendle output does not cover its promised PT minimum.')
  }
  const quotedRoundTrip = encodeFunctionData({
    abi: pendleLoopingRouterAbi,
    functionName: 'swapExactTokenForPt',
    args: decoded.args,
  })
  if (!sameHex(quotedRoundTrip, envelope.calldata)) {
    fail('INVALID_QUOTE', 'Pendle buy calldata failed ABI round-trip validation.')
  }
  const executableCalldata = guess.eps > MAX_APPROX_EPS
    ? encodeFunctionData({
        abi: pendleLoopingRouterAbi,
        functionName: 'swapExactTokenForPt',
        args: [
          receiver,
          pendleMarket,
          minPtOut,
          { ...guess, eps: MAX_APPROX_EPS },
          input,
          limit,
        ],
      })
    : envelope.calldata
  return {
    kind: 'buy-pt',
    calldata: executableCalldata,
    minPtOut,
    expectedPtOut,
    mintSyToken,
    kyberExecutor,
    kyberMinReturn,
  }
}

export function validateLoopingMintRoute(
  args: RouteValidationBase & {
    amountIn: bigint
    yieldToken: Address
  },
): ValidatedLoopingMintRoute {
  if (args.amountIn <= 0n) {
    fail('INVALID_INPUT', 'Mint-route input amount must be positive.')
  }
  const yieldToken = getAddress(args.yieldToken)
  if (!sameAddress(yieldToken, args.market.yieldToken)) {
    fail('ROUTE_NOT_ALLOWED', 'Mint route YT is not the reviewed market YT.')
  }
  const envelope = validateRouteEnvelope(
    args.route,
    args.market,
    'mintPyFromToken',
  )
  const decoded = decodePendleMintCalldata(envelope.calldata)
  if (decoded.functionName !== 'mintPyFromToken') {
    fail('INVALID_QUOTE', 'Pendle mint-route selector changed.')
  }
  const [receiver, quotedYieldToken, minPyOut, input] = decoded.args
  const mintSyToken = resolveAllowedRouteAddress(
    args.market,
    'mintSyToken',
    input.tokenMintSy,
  )
  assertAddressArrayContains(args.wiring.tokensIn, mintSyToken, 'Mint SY token')
  if (
    !sameAddress(receiver, args.market.contracts.generalAdapter1) ||
    !sameAddress(quotedYieldToken, yieldToken) ||
    !sameAddress(input.tokenIn, args.market.morphoMarketParams.loanToken) ||
    input.netTokenIn !== args.amountIn ||
    minPyOut <= 0n
  ) {
    fail(
      'ROUTE_NOT_ALLOWED',
      'Pendle mint route changed its receiver, YT, token, amount, or PY floor.',
    )
  }

  const routeData = asRecord(envelope.route.data, 'Pendle mint route data')
  const aggregatorType = String(
    routeData.aggregatorType ?? '',
  ).toLowerCase()
  let kyberExecutor: Address | null = null
  let kyberMinReturn = 0n
  const isDirectMint =
    input.swapData.swapType === 0 &&
    sameAddress(input.swapData.extRouter, zeroAddress) &&
    input.swapData.extCalldata === '0x' &&
    input.swapData.needScale === false &&
    sameAddress(input.pendleSwap, zeroAddress) &&
    sameAddress(mintSyToken, args.market.morphoMarketParams.loanToken)
  if (isDirectMint) {
    if (aggregatorType !== 'void') {
      fail(
        'ROUTE_NOT_ALLOWED',
        'Pendle direct mint route changed its VOID aggregator metadata.',
      )
    }
  } else {
    const externalRouter = resolveAllowedRouteAddress(
      args.market,
      'externalRouter',
      input.swapData.extRouter,
    )
    if (
      aggregatorType !== 'kyberswap' ||
      !sameAddress(input.pendleSwap, args.market.contracts.pendleSwap) ||
      input.swapData.swapType !== args.market.routePolicy.swapType ||
      !sameAddress(input.swapData.extRouter, externalRouter) ||
      input.swapData.needScale !== args.market.routePolicy.entryNeedScale
    ) {
      fail('ROUTE_NOT_ALLOWED', 'Pendle mint route swap policy changed.')
    }
    const kyber = validateNestedKyberCalldata({
      market: args.market,
      wiring: args.wiring,
      calldata: input.swapData.extCalldata,
      expectedSourceToken: args.market.morphoMarketParams.loanToken,
      expectedDestinationToken: mintSyToken,
      expectedAmount: args.amountIn,
      label: 'Pendle mint route',
    })
    kyberExecutor = kyber.executor
    kyberMinReturn = kyber.minReturnAmount
  }

  if (envelope.outputs.length !== 2) {
    fail('INVALID_QUOTE', 'Pendle mint route must return exactly PT and YT.')
  }
  const ptOutput = asRecord(envelope.outputs[0], 'Pendle mint PT output')
  const ytOutput = asRecord(envelope.outputs[1], 'Pendle mint YT output')
  const expectedPtOut = asUnsignedBigInt(
    ptOutput.amount,
    'Pendle expected mint PT output',
  )
  const expectedYtOut = asUnsignedBigInt(
    ytOutput.amount,
    'Pendle expected mint YT output',
  )
  if (
    !sameAddress(
      asAddress(ptOutput.token, 'Pendle mint PT output token'),
      args.market.morphoMarketParams.collateralToken,
    ) ||
    !sameAddress(
      asAddress(ytOutput.token, 'Pendle mint YT output token'),
      yieldToken,
    ) ||
    expectedPtOut !== expectedYtOut ||
    expectedPtOut < minPyOut
  ) {
    fail(
      'INVALID_QUOTE',
      'Pendle mint outputs must be equal PT and YT covering minPyOut.',
    )
  }
  assertMintPyQuoteFloor({
    market: args.market,
    minPyOut,
    expectedPyOut: expectedPtOut,
  })
  const roundTrip = encodeFunctionData({
    abi: routerActionsAbi,
    functionName: 'mintPyFromToken',
    args: decoded.args,
  })
  if (!sameHex(roundTrip, envelope.calldata)) {
    fail('INVALID_QUOTE', 'Pendle mint calldata failed ABI round-trip validation.')
  }
  return {
    kind: 'mint-pt-yt',
    calldata: envelope.calldata,
    minPtOut: minPyOut,
    expectedPtOut,
    minPyOut,
    expectedPyOut: expectedPtOut,
    yieldToken,
    mintSyToken,
    kyberExecutor,
    kyberMinReturn,
  }
}

export function validateLoopingExitRoute(
  args: RouteValidationBase & {
    collateral: bigint
    repaymentCapAssets: bigint
    minimumReturnedAssets: bigint
  },
): ValidatedLoopingExitRoute {
  if (
    args.collateral <= 0n ||
    args.repaymentCapAssets <= 0n ||
    args.minimumReturnedAssets <= 0n
  ) {
    fail(
      'INVALID_INPUT',
      'Exit collateral, repayment cap, and minimum returned assets must be positive.',
    )
  }
  const envelope = validateRouteEnvelope(
    args.route,
    args.market,
    'swapExactPtForToken',
  )
  const decoded = decodePendleLoopingCalldata(envelope.calldata)
  if (decoded.functionName !== 'swapExactPtForToken') {
    fail('INVALID_QUOTE', 'Pendle exit-route selector changed.')
  }
  const [receiver, pendleMarket, exactPtIn, outputParams, limit] =
    decoded.args
  const redeemSyToken = resolveAllowedRouteAddress(
    args.market,
    'redeemSyToken',
    outputParams.tokenRedeemSy,
  )
  assertAddressArrayContains(
    args.wiring.tokensOut,
    redeemSyToken,
    'Redeem SY token',
  )
  if (
    !sameAddress(receiver, args.market.contracts.generalAdapter1) ||
    !sameAddress(pendleMarket, args.market.pendleMarket) ||
    exactPtIn !== args.collateral ||
    !sameAddress(
      outputParams.tokenOut,
      args.market.morphoMarketParams.loanToken,
    ) ||
    outputParams.minTokenOut <
      args.repaymentCapAssets + args.minimumReturnedAssets
  ) {
    fail(
      'ROUTE_NOT_ALLOWED',
      'Pendle exit route changed its receiver, market, token, amount, output floor, or swap policy.',
    )
  }
  assertEmptyLimitOrderData(limit, 'Pendle exit route')

  let kyberExecutor: Address | null = null
  let kyberMinReturn = 0n
  const isDirectRedeem =
    outputParams.swapData.swapType === 0 &&
    sameAddress(outputParams.swapData.extRouter, zeroAddress) &&
    outputParams.swapData.extCalldata === '0x' &&
    outputParams.swapData.needScale === false &&
    sameAddress(outputParams.pendleSwap, zeroAddress) &&
    sameAddress(redeemSyToken, args.market.morphoMarketParams.loanToken)
  if (!isDirectRedeem) {
    const externalRouter = resolveAllowedRouteAddress(
      args.market,
      'externalRouter',
      outputParams.swapData.extRouter,
    )
    if (
      !sameAddress(outputParams.pendleSwap, args.market.contracts.pendleSwap) ||
      outputParams.swapData.swapType !== args.market.routePolicy.swapType ||
      !sameAddress(outputParams.swapData.extRouter, externalRouter) ||
      outputParams.swapData.needScale !== args.market.routePolicy.exitNeedScale
    ) {
      fail('ROUTE_NOT_ALLOWED', 'Pendle exit route swap policy changed.')
    }
    const kyber = validateNestedKyberCalldata({
      market: args.market,
      wiring: args.wiring,
      calldata: outputParams.swapData.extCalldata,
      expectedSourceToken: redeemSyToken,
      expectedDestinationToken: args.market.morphoMarketParams.loanToken,
      label: 'Pendle exit route',
    })
    kyberExecutor = kyber.executor
    kyberMinReturn = kyber.minReturnAmount
  }

  if (envelope.outputs.length !== 1) {
    fail('INVALID_QUOTE', 'Pendle exit route must return exactly one output.')
  }
  const output = asRecord(envelope.outputs[0], 'Pendle exit route output')
  const expectedLoanTokenOut = asUnsignedBigInt(
    output.amount,
    'Pendle expected loan-token output',
  )
  if (
    !sameAddress(
      asAddress(output.token, 'Pendle exit output token'),
      args.market.morphoMarketParams.loanToken,
    ) ||
    expectedLoanTokenOut < outputParams.minTokenOut
  ) {
    fail(
      'INVALID_QUOTE',
      'Pendle exit output does not cover its promised loan-token minimum.',
    )
  }
  const roundTrip = encodeFunctionData({
    abi: pendleLoopingRouterAbi,
    functionName: 'swapExactPtForToken',
    args: decoded.args,
  })
  if (!sameHex(roundTrip, envelope.calldata)) {
    fail('INVALID_QUOTE', 'Pendle exit calldata failed ABI round-trip validation.')
  }
  return {
    kind: 'sell-pt',
    calldata: envelope.calldata,
    exactPtIn,
    minLoanTokenOut: outputParams.minTokenOut,
    expectedLoanTokenOut,
    redeemSyToken,
    kyberExecutor,
    kyberMinReturn,
  }
}

export function validateLoopingMaturedExitRoute(
  args: RouteValidationBase & {
    collateral: bigint
    estimatedSyIn: bigint
    yieldToken: Address
    repaymentCapAssets: bigint
    minimumReturnedAssets: bigint
  },
): ValidatedLoopingMaturedExitRoute {
  if (
    args.collateral <= 0n ||
    args.estimatedSyIn <= 0n ||
    args.repaymentCapAssets <= 0n ||
    args.minimumReturnedAssets <= 0n
  ) {
    fail(
      'INVALID_INPUT',
      'Matured exit collateral, SY estimate, repayment cap, and minimum return must be positive.',
    )
  }
  const envelope = validateRouteEnvelope(
    args.route,
    args.market,
    'redeemSyToToken',
  )
  const decoded = decodePendleLoopingCalldata(envelope.calldata)
  if (decoded.functionName !== 'redeemSyToToken') {
    fail('INVALID_QUOTE', 'Pendle matured exit-route selector changed.')
  }
  const [receiver, standardizedYield, netSyIn, outputParams] = decoded.args
  const redeemSyToken = resolveAllowedRouteAddress(
    args.market,
    'redeemSyToken',
    outputParams.tokenRedeemSy,
  )
  assertAddressArrayContains(
    args.wiring.tokensOut,
    redeemSyToken,
    'Matured redeem SY token',
  )
  if (!sameAddress(receiver, args.market.contracts.generalAdapter1)) {
    fail('ROUTE_NOT_ALLOWED', 'Pendle matured exit route changed its receiver.')
  }
  if (!sameAddress(standardizedYield, args.market.standardizedYield)) {
    fail('ROUTE_NOT_ALLOWED', 'Pendle matured exit route changed its SY.')
  }
  if (netSyIn !== args.estimatedSyIn) {
    fail('ROUTE_NOT_ALLOWED', 'Pendle matured exit route changed its exact SY amount.')
  }
  if (!sameAddress(
    outputParams.tokenOut,
    args.market.morphoMarketParams.loanToken,
  )) {
    fail('ROUTE_NOT_ALLOWED', 'Pendle matured exit route changed its output token.')
  }
  if (
    outputParams.minTokenOut <
      args.repaymentCapAssets + args.minimumReturnedAssets
  ) {
    fail('ROUTE_NOT_ALLOWED', 'Pendle matured exit route cannot cover the bounded debt repayment and minimum wallet return.')
  }

  let kyberExecutor: Address | null = null
  let kyberMinReturn = 0n
  const isDirectRedeem =
    outputParams.swapData.swapType === 0 &&
    sameAddress(outputParams.swapData.extRouter, zeroAddress) &&
    outputParams.swapData.extCalldata === '0x' &&
    outputParams.swapData.needScale === false &&
    sameAddress(outputParams.pendleSwap, zeroAddress) &&
    sameAddress(redeemSyToken, args.market.morphoMarketParams.loanToken)
  if (!isDirectRedeem) {
    const routeData = asRecord(envelope.route.data, 'Pendle matured route data')
    if (String(routeData.aggregatorType ?? '').toLowerCase() !== 'kyberswap') {
      fail('ROUTE_NOT_ALLOWED', 'Pendle matured exit did not return a KyberSwap route.')
    }
    const externalRouter = resolveAllowedRouteAddress(
      args.market,
      'externalRouter',
      outputParams.swapData.extRouter,
    )
    if (
      !sameAddress(outputParams.pendleSwap, args.market.contracts.pendleSwap) ||
      outputParams.swapData.swapType !== args.market.routePolicy.swapType ||
      !sameAddress(outputParams.swapData.extRouter, externalRouter) ||
      outputParams.swapData.needScale !== args.market.routePolicy.exitNeedScale
    ) {
      fail('ROUTE_NOT_ALLOWED', 'Pendle matured exit swap policy changed.')
    }
    const kyber = validateNestedKyberCalldata({
      market: args.market,
      wiring: args.wiring,
      calldata: outputParams.swapData.extCalldata,
      expectedSourceToken: redeemSyToken,
      expectedDestinationToken: args.market.morphoMarketParams.loanToken,
      label: 'Pendle matured exit route',
    })
    kyberExecutor = kyber.executor
    kyberMinReturn = kyber.minReturnAmount
  }

  if (envelope.outputs.length !== 1) {
    fail('INVALID_QUOTE', 'Pendle matured exit route must return exactly one output.')
  }
  const output = asRecord(envelope.outputs[0], 'Pendle matured exit route output')
  const expectedLoanTokenOut = asUnsignedBigInt(
    output.amount,
    'Pendle matured expected loan-token output',
  )
  if (
    !sameAddress(
      asAddress(output.token, 'Pendle matured exit output token'),
      args.market.morphoMarketParams.loanToken,
    ) ||
    expectedLoanTokenOut < outputParams.minTokenOut
  ) {
    fail(
      'INVALID_QUOTE',
      'Pendle matured exit output does not cover its promised loan-token minimum.',
    )
  }
  const quotedRoundTrip = encodeFunctionData({
    abi: pendleLoopingRouterAbi,
    functionName: 'redeemSyToToken',
    args: decoded.args,
  })
  if (!sameHex(quotedRoundTrip, envelope.calldata)) {
    fail('INVALID_QUOTE', 'Pendle matured SY calldata failed ABI round-trip validation.')
  }
  const calldata = encodeFunctionData({
    abi: pendleLoopingRouterAbi,
    functionName: 'redeemPyToToken',
    args: [
      args.market.contracts.generalAdapter1,
      args.yieldToken,
      args.collateral,
      outputParams,
    ],
  })
  return {
    kind: 'redeem-matured-pt',
    calldata,
    exactPtIn: args.collateral,
    estimatedSyIn: args.estimatedSyIn,
    minLoanTokenOut: outputParams.minTokenOut,
    expectedLoanTokenOut,
    redeemSyToken,
    yieldToken: getAddress(args.yieldToken),
    kyberExecutor,
    kyberMinReturn,
  }
}

interface FetchQuoteArgs {
  market: Readonly<LoopingExecutionMarket>
  wiring: Pick<
    LoopingWiringSnapshot,
    'tokensIn' | 'tokensOut' | 'kyberExecutorCodeHashes'
  >
  amountIn: bigint
  fetcher?: LoopingFetcher
  now?: () => number
}

interface PendleQuoteEnvelope {
  quotedAtMs: number
  routes: readonly unknown[]
}

async function fetchPendleQuoteEnvelope(args: {
  market: Readonly<LoopingExecutionMarket>
  tokenIn: Address
  tokenOut: Address | readonly Address[]
  amountIn: bigint
  needScale: boolean
  fetcher: LoopingFetcher
  now: () => number
  expectedAction?: 'swap' | 'mint-py' | 'redeem-sy'
  enableAggregator?: boolean
  requireApproval?: boolean
}): Promise<PendleQuoteEnvelope> {
  if (args.amountIn <= 0n) fail('INVALID_INPUT', 'Quote amount must be positive.')
  const quotedAtMs = args.now()
  const enableAggregator = args.enableAggregator ?? true
  const outputs = Array.isArray(args.tokenOut)
    ? args.tokenOut
    : [args.tokenOut]
  const request = () => args.fetcher(
    `${PENDLE_CORE_API}/v3/sdk/${args.market.chainId}/convert`,
    {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        receiver: args.market.contracts.generalAdapter1,
        slippage: args.market.launchPolicy.quoteSlippage,
        enableAggregator,
        ...(enableAggregator
          ? { aggregators: [args.market.routePolicy.aggregator] }
          : {}),
        inputs: [{ token: args.tokenIn, amount: args.amountIn.toString() }],
        outputs,
        redeemRewards: false,
        needScale: args.needScale,
        useLimitOrder: false,
      }),
    },
  )
  let response: Response | undefined
  let transportError: unknown
  for (let attempt = 0; attempt < PENDLE_QUOTE_TRANSPORT_ATTEMPTS; attempt += 1) {
    try {
      response = await request()
      break
    } catch (error) {
      transportError = error
      if (attempt + 1 < PENDLE_QUOTE_TRANSPORT_ATTEMPTS) {
        await delayMs(PENDLE_QUOTE_RETRY_DELAY_MS)
      }
    }
  }
  if (response === undefined) {
    const detail = sanitizedTransportDetail(transportError)
    fail(
      'INVALID_QUOTE',
      `Could not reach the Pendle quote service after one retry${detail ? `: ${detail}` : ''}. No wallet action was taken.`,
      transportError,
    )
  }
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {
      // Preserve the status even if the response body is unreadable.
    }
    fail(
      'INVALID_QUOTE',
      `Pendle quote returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
    )
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    fail('INVALID_QUOTE', 'Pendle quote response is not JSON.', error)
  }
  const root = asRecord(body, 'Pendle quote response')
  const expectedAction = args.expectedAction ?? 'swap'
  if (root.action !== expectedAction) {
    fail('INVALID_QUOTE', `Pendle quote action must be ${expectedAction}.`)
  }
  const inputs = asArray(root.inputs, 'Pendle quote inputs')
  if (inputs.length !== 1) {
    fail('INVALID_QUOTE', 'Pendle quote must echo exactly one input.')
  }
  const echoedInput = asRecord(inputs[0], 'Pendle echoed input')
  if (
    !sameAddress(asAddress(echoedInput.token, 'Pendle echoed input token'), args.tokenIn) ||
    asUnsignedBigInt(echoedInput.amount, 'Pendle echoed input amount') !==
      args.amountIn
  ) {
    fail('INVALID_QUOTE', 'Pendle quote did not echo the exact requested input.')
  }
  if (root.requiredApprovals === undefined && args.requireApproval) {
    fail('INVALID_QUOTE', 'Pendle mint quote omitted required approval metadata.')
  }
  if (root.requiredApprovals !== undefined) {
    const approvals = asArray(
      root.requiredApprovals,
      'Pendle quote required approvals',
    )
    if (approvals.length !== 1) {
      fail('INVALID_QUOTE', 'Pendle quote approval metadata changed shape.')
    }
    const approval = asRecord(approvals[0], 'Pendle quote approval')
    if (
      !sameAddress(
        asAddress(approval.token, 'Pendle quote approval token'),
        args.tokenIn,
      ) ||
      asUnsignedBigInt(approval.amount, 'Pendle quote approval amount') !==
        args.amountIn
    ) {
      fail('INVALID_QUOTE', 'Pendle quote approval metadata changed.')
    }
  }
  const routes = asArray(root.routes, 'Pendle quote routes')
  if (routes.length === 0 || routes.length > MAX_QUOTE_ROUTES) {
    fail(
      'INVALID_QUOTE',
      `Pendle quote must contain between 1 and ${MAX_QUOTE_ROUTES} routes.`,
    )
  }
  return { quotedAtMs, routes }
}

export async function fetchPendleLoopingMintRoute(
  args: FetchQuoteArgs & { yieldToken: Address },
): Promise<{ quotedAtMs: number; route: ValidatedLoopingMintRoute }> {
  const fetcher = args.fetcher ?? defaultLoopingFetcher
  const now = args.now ?? Date.now
  const directSupported = args.wiring.tokensIn.some((token) =>
    sameAddress(token, args.market.morphoMarketParams.loanToken)
  ) && args.market.routePolicy.mintSyTokenAllowlist.some((token) =>
    sameAddress(token, args.market.morphoMarketParams.loanToken)
  )
  const attempts = directSupported ? [false, true] as const : [true] as const
  const failures: string[] = []
  for (const enableAggregator of attempts) {
    let envelope: PendleQuoteEnvelope
    try {
      envelope = await fetchPendleQuoteEnvelope({
        market: args.market,
        tokenIn: args.market.morphoMarketParams.loanToken,
        tokenOut: [
          args.market.morphoMarketParams.collateralToken,
          args.yieldToken,
        ],
        amountIn: args.amountIn,
        needScale: args.market.routePolicy.entryNeedScale,
        fetcher,
        now,
        expectedAction: 'mint-py',
        enableAggregator,
        requireApproval: true,
      })
    } catch (error) {
      failures.push(
        `${enableAggregator ? 'aggregated' : 'direct'}: ${messageOf(error)}`,
      )
      continue
    }
    for (const route of envelope.routes) {
      try {
        return {
          quotedAtMs: envelope.quotedAtMs,
          route: validateLoopingMintRoute({
            route,
            market: args.market,
            wiring: args.wiring,
            amountIn: args.amountIn,
            yieldToken: args.yieldToken,
          }),
        }
      } catch (error) {
        failures.push(
          `${enableAggregator ? 'aggregated' : 'direct'}: ${messageOf(error)}`,
        )
      }
    }
  }
  fail(
    'ROUTE_NOT_ALLOWED',
    `Pendle returned no strictly valid mint route: ${failures.join(' | ')}`,
  )
}

export async function fetchPendleLoopingBuyRoute(
  args: FetchQuoteArgs,
): Promise<{ quotedAtMs: number; route: ValidatedLoopingBuyRoute }> {
  const envelope = await fetchPendleQuoteEnvelope({
    market: args.market,
    tokenIn: args.market.morphoMarketParams.loanToken,
    tokenOut: args.market.morphoMarketParams.collateralToken,
    amountIn: args.amountIn,
    needScale: args.market.routePolicy.entryNeedScale,
    fetcher: args.fetcher ?? defaultLoopingFetcher,
    now: args.now ?? Date.now,
  })
  const failures: string[] = []
  for (const route of envelope.routes) {
    try {
      return {
        quotedAtMs: envelope.quotedAtMs,
        route: validateLoopingBuyRoute({ ...args, route }),
      }
    } catch (error) {
      failures.push(messageOf(error))
    }
  }
  fail(
    'ROUTE_NOT_ALLOWED',
    `Pendle returned no strictly valid buy route: ${failures.join(' | ')}`,
  )
}

export async function fetchPendleLoopingExitRoute(
  args: FetchQuoteArgs & {
    repaymentCapAssets: bigint
    minimumReturnedAssets: bigint
  },
): Promise<{ quotedAtMs: number; route: ValidatedLoopingExitRoute }> {
  const envelope = await fetchPendleQuoteEnvelope({
    market: args.market,
    tokenIn: args.market.morphoMarketParams.collateralToken,
    tokenOut: args.market.morphoMarketParams.loanToken,
    amountIn: args.amountIn,
    needScale: args.market.routePolicy.exitNeedScale,
    fetcher: args.fetcher ?? defaultLoopingFetcher,
    now: args.now ?? Date.now,
  })
  const failures: string[] = []
  for (const route of envelope.routes) {
    try {
      return {
        quotedAtMs: envelope.quotedAtMs,
        route: validateLoopingExitRoute({
          route,
          market: args.market,
          wiring: args.wiring,
          collateral: args.amountIn,
          repaymentCapAssets: args.repaymentCapAssets,
          minimumReturnedAssets: args.minimumReturnedAssets,
        }),
      }
    } catch (error) {
      failures.push(messageOf(error))
    }
  }
  fail(
    'ROUTE_NOT_ALLOWED',
    `Pendle returned no strictly valid exit route: ${failures.join(' | ')}`,
  )
}

export async function fetchPendleLoopingMaturedExitRoute(
  args: FetchQuoteArgs & {
    collateral: bigint
    yieldToken: Address
    repaymentCapAssets: bigint
    minimumReturnedAssets: bigint
  },
): Promise<{ quotedAtMs: number; route: ValidatedLoopingMaturedExitRoute }> {
  const envelope = await fetchPendleQuoteEnvelope({
    market: args.market,
    tokenIn: args.market.standardizedYield,
    tokenOut: args.market.morphoMarketParams.loanToken,
    amountIn: args.amountIn,
    needScale: args.market.routePolicy.exitNeedScale,
    fetcher: args.fetcher ?? defaultLoopingFetcher,
    now: args.now ?? Date.now,
    expectedAction: 'redeem-sy',
  })
  const failures: string[] = []
  for (const route of envelope.routes) {
    try {
      return {
        quotedAtMs: envelope.quotedAtMs,
        route: validateLoopingMaturedExitRoute({
          route,
          market: args.market,
          wiring: args.wiring,
          collateral: args.collateral,
          estimatedSyIn: args.amountIn,
          yieldToken: args.yieldToken,
          repaymentCapAssets: args.repaymentCapAssets,
          minimumReturnedAssets: args.minimumReturnedAssets,
        }),
      }
    } catch (error) {
      failures.push(messageOf(error))
    }
  }
  fail(
    'ROUTE_NOT_ALLOWED',
    `Pendle returned no strictly valid matured exit route: ${failures.join(' | ')}`,
  )
}

export interface LoopingPositionSnapshot {
  supplyShares: bigint
  borrowShares: bigint
  collateral: bigint
  classification: 'empty' | 'open-loop' | 'conflicting-supply'
}

export interface LoopingPositionInventorySnapshot {
  kind: 'loop-position-inventory'
  owner: Address
  marketId: Hex
  blockNumber: bigint
  blockHash: Hex
  blockTimestamp: bigint
  position: Readonly<LoopingPositionSnapshot>
  accruedDebtAssets: bigint
  collateralLoanValue: bigint
  /** Null only for an anomalous debt position with zero oracle-valued collateral. */
  ltvBps: bigint | null
  /** Zero at or beyond liquidation; 10_000 when no debt is present. */
  liquidationBufferBps: bigint
}

export interface LoopingAccruedMarketSnapshot {
  totalSupplyAssets: bigint
  totalSupplyShares: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
  lastUpdate: bigint
  fee: bigint
  oraclePrice: bigint
}

export interface LoopingEntryBorrowBounds {
  observedBorrowShares: bigint
  maxBorrowShares: bigint
  minBorrowSharePriceE27: bigint
  observedBorrowSharePriceE27: bigint
}

export interface LoopingEntryHealthSnapshot {
  borrowAssets: bigint
  collateralLoanValue: bigint
  maxBorrowAssets: bigint
  liquidationBufferBps: bigint
  oraclePrice: bigint
}

export interface LoopingApprovalSnapshot {
  token: Address
  spender: Address
  current: bigint
  required: bigint
  needed: boolean
}

export interface LoopingAuthorizationMessage {
  authorizer: Address
  authorized: Address
  isAuthorized: boolean
  nonce: bigint
  deadline: bigint
}

export interface LoopingAuthorizationRequest {
  purpose:
    | 'authorize-entry'
    | 'revoke-entry'
    | 'authorize-exit'
    | 'revoke-exit'
    | 'burn-authorization-nonce'
  domain: Readonly<{
    chainId: number
    verifyingContract: Address
  }>
  types: Readonly<{
    Authorization: readonly [
      Readonly<{ name: 'authorizer'; type: 'address' }>,
      Readonly<{ name: 'authorized'; type: 'address' }>,
      Readonly<{ name: 'isAuthorized'; type: 'bool' }>,
      Readonly<{ name: 'nonce'; type: 'uint256' }>,
      Readonly<{ name: 'deadline'; type: 'uint256' }>,
    ]
  }>
  primaryType: 'Authorization'
  message: Readonly<LoopingAuthorizationMessage>
  digest: Hex
}

type LoopingAcquisitionModeInput =
  | Readonly<{ acquisitionMode?: 'market' }>
  | Readonly<{ acquisitionMode: 'mint' }>

export type LoopingEntryExecutionInput = Readonly<{
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  equityAssets: bigint
  borrowAssets: bigint
  fetcher?: LoopingFetcher
  now?: () => number
}> & LoopingAcquisitionModeInput

export type LoopingIncreaseExecutionInput = Readonly<{
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  targetLeverageWad: bigint
  fetcher?: LoopingFetcher
  now?: () => number
}> & LoopingAcquisitionModeInput

export type LoopingAdjustmentExecutionInput = LoopingIncreaseExecutionInput

interface LoopingEntryExecutionPreviewBase {
  kind: 'entry-preview'
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  equityAssets: bigint
  borrowAssets: bigint
  quotedAtMs: number
  validUntilMs: number
  approval: Readonly<LoopingApprovalSnapshot>
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  bounds: Readonly<LoopingEntryBorrowBounds>
  health: Readonly<LoopingEntryHealthSnapshot>
  authorizationRequests: readonly [
    Readonly<LoopingAuthorizationRequest>,
    Readonly<LoopingAuthorizationRequest>,
  ]
  wiring: Readonly<LoopingWiringSnapshot>
}

export type LoopingEntryExecutionPreview =
  | (LoopingEntryExecutionPreviewBase & Readonly<{
      acquisitionMode: 'market'
      yieldToken: null
      minimumYtOut: 0n
      expectedYtOut: 0n
      quotes: Readonly<{
        initial: ValidatedLoopingBuyRoute
        loop: ValidatedLoopingBuyRoute
        minimumCollateral: bigint
        expectedCollateral: bigint
      }>
    }>)
  | (LoopingEntryExecutionPreviewBase & Readonly<{
      acquisitionMode: 'mint'
      yieldToken: Address
      minimumYtOut: bigint
      expectedYtOut: bigint
      quotes: Readonly<{
        initial: ValidatedLoopingMintRoute
        loop: ValidatedLoopingMintRoute
        minimumCollateral: bigint
        expectedCollateral: bigint
      }>
    }>)

export interface LoopingBundlerCall {
  to: Address
  data: Hex
  value: bigint
  skipRevert: boolean
  callbackHash: Hex
}

export interface SignedLoopingEntryBundle {
  kind: 'signed-entry-bundle'
  acquisitionMode: LoopingAcquisitionMode
  yieldToken: Address | null
  minimumYtOut: bigint
  expectedYtOut: bigint
  owner: Address
  marketId: Hex
  to: Address
  data: Hex
  value: 0n
  calls: readonly LoopingBundlerCall[]
  startingNonce: bigint
  deadline: bigint
  quotedAtMs: number
  validUntilMs: number
  minimumCollateral: bigint
  maxBorrowShares: bigint
}

export interface LoopingExitRepaymentBounds {
  borrowShares: bigint
  accruedDebtAssets: bigint
  repaymentCapAssets: bigint
  maxRepaySharePriceE27: bigint
  maxAuthorizedRepayAssets: bigint
  observedRepaySharePriceE27: bigint
}

export interface LoopingExitExecutionPreview {
  kind: 'exit-preview'
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  quotedAtMs: number
  validUntilMs: number
  requestedMinimumReturnedAssets: bigint
  minimumReturnedAssets: bigint
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  bounds: Readonly<LoopingExitRepaymentBounds>
  quote: Readonly<ValidatedLoopingExitRoute | ValidatedLoopingMaturedExitRoute>
  authorizationRequests: readonly [
    Readonly<LoopingAuthorizationRequest>,
    Readonly<LoopingAuthorizationRequest>,
  ]
  wiring: Readonly<LoopingWiringSnapshot>
}

export interface SignedLoopingExitBundle {
  kind: 'signed-exit-bundle'
  owner: Address
  marketId: Hex
  to: Address
  data: Hex
  value: 0n
  calls: readonly LoopingBundlerCall[]
  startingNonce: bigint
  deadline: bigint
  quotedAtMs: number
  validUntilMs: number
  exactBorrowShares: bigint
  exactCollateral: bigint
  repaymentCapAssets: bigint
  minimumReturnedAssets: bigint
}

export interface LoopingLeverageSnapshot {
  collateral: bigint
  borrowShares: bigint
  debtAssets: bigint
  collateralLoanValue: bigint
  equityAssets: bigint
  leverageWad: bigint
  maxBorrowAssets: bigint
  liquidationBufferBps: bigint
  oraclePrice: bigint
}

interface LoopingIncreaseExecutionPreviewBase {
  kind: 'increase-preview'
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  targetLeverageWad: bigint
  borrowAssets: bigint
  quotedAtMs: number
  validUntilMs: number
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  bounds: Readonly<LoopingEntryBorrowBounds>
  current: Readonly<LoopingLeverageSnapshot>
  conservativePost: Readonly<LoopingLeverageSnapshot>
  authorizationRequests: readonly [
    Readonly<LoopingAuthorizationRequest>,
    Readonly<LoopingAuthorizationRequest>,
  ]
  wiring: Readonly<LoopingWiringSnapshot>
}

export type LoopingIncreaseExecutionPreview =
  | (LoopingIncreaseExecutionPreviewBase & Readonly<{
      acquisitionMode: 'market'
      yieldToken: null
      minimumYtOut: 0n
      expectedYtOut: 0n
      quote: Readonly<ValidatedLoopingBuyRoute>
    }>)
  | (LoopingIncreaseExecutionPreviewBase & Readonly<{
      acquisitionMode: 'mint'
      yieldToken: Address
      minimumYtOut: bigint
      expectedYtOut: bigint
      quote: Readonly<ValidatedLoopingMintRoute>
    }>)

export interface SignedLoopingIncreaseBundle {
  kind: 'signed-increase-bundle'
  acquisitionMode: LoopingAcquisitionMode
  yieldToken: Address | null
  minimumYtOut: bigint
  expectedYtOut: bigint
  owner: Address
  marketId: Hex
  to: Address
  data: Hex
  value: 0n
  calls: readonly LoopingBundlerCall[]
  startingNonce: bigint
  deadline: bigint
  quotedAtMs: number
  validUntilMs: number
  targetLeverageWad: bigint
  borrowAssets: bigint
  startingBorrowShares: bigint
  startingCollateral: bigint
  minimumAddedCollateral: bigint
  maxAddedBorrowShares: bigint
}

export interface LoopingDecreaseExecutionPreview {
  kind: 'decrease-preview'
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  targetLeverageWad: bigint
  repayShares: bigint
  collateralToSell: bigint
  quotedAtMs: number
  validUntilMs: number
  minimumReturnedAssets: bigint
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  bounds: Readonly<LoopingExitRepaymentBounds>
  quote: Readonly<ValidatedLoopingExitRoute>
  current: Readonly<LoopingLeverageSnapshot>
  conservativePost: Readonly<LoopingLeverageSnapshot>
  authorizationRequests: readonly [
    Readonly<LoopingAuthorizationRequest>,
    Readonly<LoopingAuthorizationRequest>,
  ]
  wiring: Readonly<LoopingWiringSnapshot>
}

export interface SignedLoopingDecreaseBundle {
  kind: 'signed-decrease-bundle'
  owner: Address
  marketId: Hex
  to: Address
  data: Hex
  value: 0n
  calls: readonly LoopingBundlerCall[]
  startingNonce: bigint
  deadline: bigint
  quotedAtMs: number
  validUntilMs: number
  targetLeverageWad: bigint
  startingBorrowShares: bigint
  startingCollateral: bigint
  exactRepayShares: bigint
  exactCollateralToSell: bigint
  repaymentCapAssets: bigint
  minimumReturnedAssets: bigint
}

export interface LoopingIncreaseReceiptVerification {
  kind: 'increase-receipt-verified'
  operation: 'entry'
  acquisitionMode: LoopingAcquisitionMode
  yieldToken: Address | null
  minimumYtOut: bigint
  deliveredYtOut: bigint
  owner: Address
  marketId: Hex
  transactionHash: Hex
  blockNumber: bigint
  blockHash: Hex
  nonce: bigint
  adapterAuthorized: false
  adapterAllowance: bigint
  morphoAllowance: bigint
  ownerLoanBalance: bigint
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  achieved: Readonly<LoopingLeverageSnapshot>
  belowModelBuffer: boolean
}

export interface LoopingDecreaseReceiptVerification {
  kind: 'decrease-receipt-verified'
  operation: 'exit'
  owner: Address
  marketId: Hex
  transactionHash: Hex
  blockNumber: bigint
  blockHash: Hex
  nonce: bigint
  adapterAuthorized: false
  adapterAllowance: bigint
  morphoAllowance: bigint
  ownerLoanBalance: bigint
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  achieved: Readonly<LoopingLeverageSnapshot>
}

export interface LoopingStateOverrideIntent {
  address: Address
  stateDiff: readonly [Readonly<{ slot: Hex; value: Hex }>]
}

export interface UnsignedLoopingSimulationIntent {
  kind: 'unsigned-entry-simulation' | 'unsigned-exit-simulation'
  operation: 'entry' | 'exit'
  acquisitionMode: LoopingAcquisitionMode | null
  chainId: number
  owner: Address
  account: Address
  marketId: Hex
  to: Address
  data: Hex
  value: 0n
  calls: readonly LoopingBundlerCall[]
  startingNonce: bigint
  quotedAtMs: number
  validUntilMs: number
  stateOverride: readonly [Readonly<LoopingStateOverrideIntent>]
  authorizationProbe: Readonly<{
    to: Address
    data: Hex
    expectedResult: Hex
  }>
  requiredRuntimeCodeHashes: Readonly<LoopingRuntimeCodePolicy>
}

export interface LoopingUnsignedSimulationEvidence {
  kind: 'verified-unsigned-entry-simulation' | 'verified-unsigned-exit-simulation'
  operation: 'entry' | 'exit'
  acquisitionMode: LoopingAcquisitionMode | null
  owner: Address
  marketId: Hex
  intentFingerprint: Hex
  blockNumber: bigint
  blockHash: Hex
  actionResult: Hex
  requiredRuntimeCodeHashes: Readonly<LoopingRuntimeCodePolicy>
}

export interface ExposedLoopingAuthorizationPair {
  kind: 'exposed-authorization-pair'
  operation: 'entry' | 'exit'
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  startingNonce: bigint
  deadline: bigint
  authorizeCall: Readonly<LoopingBundlerCall>
  revokeCall: Readonly<LoopingBundlerCall>
}

export type ExposedAuthorizationRecoveryClassification =
  | Readonly<{ action: 'consume-pair'; reason: string }>
  | Readonly<{ action: 'consume-revoke'; reason: string }>
  | Readonly<{ action: 'direct-revoke'; reason: string }>
  | Readonly<{ action: 'none'; reason: string }>
  | Readonly<{ action: 'blocked'; reason: string }>

export interface LoopingRecoveryTransactionIntent {
  kind: 'authorization-signature-recovery' | 'direct-authorization-revoke'
  owner: Address
  marketId: Hex
  to: Address
  data: Hex
  value: 0n
  calls?: readonly LoopingBundlerCall[]
}

export interface ExposedAuthorizationRecoveryState {
  blockTimestamp: bigint
  nonce: bigint
  adapterAuthorized: boolean
  position: Readonly<LoopingPositionSnapshot>
}

export interface LoopingAuthorizationNonceBurnPreview {
  kind: 'authorization-nonce-burn-preview'
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  blockNumber: bigint
  blockHash: Hex
  blockTimestamp: bigint
  startingNonce: bigint
  adapterAuthorized: boolean
  request: Readonly<LoopingAuthorizationRequest>
}

export interface LoopingAuthorizationNonceBurnIntent {
  kind: 'authorization-nonce-burn'
  owner: Address
  marketId: Hex
  to: Address
  data: Hex
  value: 0n
  startingNonce: bigint
  deadline: bigint
  expectedPostconditions: Readonly<{
    nonce: bigint
    adapterAuthorized: false
  }>
}

export interface LoopingBroadcastReadiness {
  kind: 'entry-broadcast-ready' | 'exit-broadcast-ready'
  operation: 'entry' | 'exit'
  owner: Address
  marketId: Hex
  checkedAtMs: number
  blockNumber: bigint
  blockHash: Hex
  blockTimestamp: bigint
  nonce: bigint
  adapterAuthorized: false
  adapterAllowance: bigint
  morphoAllowance: bigint
  ownerLoanBalance: bigint
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  entryHealth?: Readonly<LoopingEntryHealthSnapshot>
  entryBorrowBounds?: Readonly<LoopingEntryBorrowBounds>
  exitRepaymentBounds?: Readonly<LoopingExitRepaymentBounds>
  simulation: Readonly<LoopingUnsignedSimulationEvidence>
}

export interface LoopingReceiptVerification {
  kind: 'entry-receipt-verified' | 'exit-receipt-verified'
  operation: 'entry' | 'exit'
  owner: Address
  marketId: Hex
  transactionHash: Hex
  blockNumber: bigint
  blockHash: Hex
  nonce: bigint
  adapterAuthorized: false
  adapterAllowance: bigint
  morphoAllowance: bigint
  ownerLoanBalance: bigint
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  acquisitionMode?: LoopingAcquisitionMode
  yieldToken?: Address | null
  minimumYtOut?: bigint
  deliveredYtOut?: bigint
  entryHealth?: Readonly<LoopingEntryHealthSnapshot>
  belowModelBuffer?: boolean
  belowEntryValueFloor?: boolean
}

export interface LoopingDirectRescueTransactionIntent {
  step:
    | 'revoke-adapter'
    | 'clear-adapter-allowance'
    | 'clear-morpho-allowance-before'
    | 'approve-exact-repayment'
    | 'repay-exact-shares'
    | 'clear-morpho-allowance-after'
    | 'withdraw-exact-collateral'
  to: Address
  data: Hex
  value: 0n
}

export interface LoopingDirectRescuePlan {
  kind: 'direct-rescue-plan'
  phase: LoopingDirectRescueTransactionIntent['step'] | 'complete'
  owner: Address
  marketId: Hex
  blockNumber: bigint
  blockHash: Hex
  position: Readonly<LoopingPositionSnapshot>
  bounds?: Readonly<LoopingExitRepaymentBounds>
  ownerLoanBalance: bigint
  startingState: Readonly<{
    adapterAuthorized: boolean
    adapterAllowance: bigint
    morphoAllowance: bigint
  }>
  /** At most one bounded next transaction. Reprepare from chain state after it mines. */
  intents: readonly [] | readonly [Readonly<LoopingDirectRescueTransactionIntent>]
  requiresReprepareAfterEachStep: true
  expectedPostconditions: Readonly<{
    adapterAuthorized: false
    adapterAllowance: 0n
    morphoAllowance: 0n
    position: 'empty'
    collateralReturnedAssets: bigint
  }>
}

const loopingAuthorizationTypes = Object.freeze({
  Authorization: Object.freeze([
    Object.freeze({ name: 'authorizer', type: 'address' }),
    Object.freeze({ name: 'authorized', type: 'address' }),
    Object.freeze({ name: 'isAuthorized', type: 'bool' }),
    Object.freeze({ name: 'nonce', type: 'uint256' }),
    Object.freeze({ name: 'deadline', type: 'uint256' }),
  ]),
}) as LoopingAuthorizationRequest['types']

function hasRuntimeCode(value: Hex | undefined): value is Hex {
  return value !== undefined && value !== '0x'
}

const LOOPING_WALLET_READ_CONCURRENCY = 4

/**
 * Injected-wallet RPCs commonly proxy each read through a rate-limited remote
 * endpoint. Keep independent reads bounded instead of launching dozens at
 * once; every result is still pinned to the same explicit block.
 */
async function mapLoopingReadsInBatches<T, R>(
  values: readonly T[],
  read: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (
    let offset = 0;
    offset < values.length;
    offset += LOOPING_WALLET_READ_CONCURRENCY
  ) {
    results.push(...await Promise.all(
      values
        .slice(offset, offset + LOOPING_WALLET_READ_CONCURRENCY)
        .map(read),
    ))
  }
  return results
}

async function readRuntimeCodeHash(args: {
  client: PublicClient
  address: Address
  knownCode?: Hex
  blockNumber?: bigint
}): Promise<Hex> {
  try {
    const proof = await args.client.getProof({
      address: args.address,
      storageKeys: [],
      ...(args.blockNumber === undefined
        ? { blockTag: 'latest' as const }
        : { blockNumber: args.blockNumber }),
    })
    return proof.codeHash
  } catch {
    const code = args.knownCode ?? await args.client.getBytecode({
      address: args.address,
      ...(args.blockNumber === undefined
        ? { blockTag: 'latest' as const }
        : { blockNumber: args.blockNumber }),
    })
    if (!hasRuntimeCode(code)) {
      fail('UNSAFE_WIRING', `Required looping contract has no code: ${args.address}.`)
    }
    return keccak256(code)
  }
}

async function assertPinnedRuntimeCodeHashes(args: {
  client: PublicClient
  market: Readonly<LoopingExecutionMarket>
  blockNumber?: bigint
  includeMint?: boolean
}): Promise<void> {
  const blockNumber = args.blockNumber ?? await (async () => {
    const block = await args.client.getBlock({ blockTag: 'latest' })
    if (block.number === null || block.hash === null) {
      fail('UNSAFE_WIRING', 'Looping route validation could not pin a canonical block.')
    }
    return block.number
  })()
  const pinnedContracts: readonly (
    readonly [keyof LoopingRuntimeCodePolicy, Address]
  )[] = [
    ['morpho', args.market.contracts.morpho],
    ['bundler3', args.market.contracts.bundler3],
    ['generalAdapter1', args.market.contracts.generalAdapter1],
    ['pendleRouter', args.market.contracts.pendleRouter],
    [
      'pendleRouterImplementation',
      args.market.routeUpgradePolicy.pendleRouter.implementation,
    ],
    [
      'pendleRouterRedeemImplementation',
      args.market.routeUpgradePolicy.pendleRouter.redeemImplementation,
    ],
    ['pendleSwap', args.market.contracts.pendleSwap],
    [
      'pendleSwapImplementation',
      args.market.routeUpgradePolicy.pendleSwap.implementation,
    ],
    ['kyberRouter', args.market.routeUpgradePolicy.kyberRouter.address],
    ['multicall3', args.market.contracts.multicall3],
  ]
  const pinnedRuntimeHashes = await mapLoopingReadsInBatches(
    pinnedContracts,
    ([, address]) => readRuntimeCodeHash({
      client: args.client,
      address,
      blockNumber,
    }),
  )
  pinnedContracts.forEach(([name], index) => {
    if (!sameHex(
      pinnedRuntimeHashes[index],
      args.market.runtimeCodePolicy[name],
    )) {
      fail('UNSAFE_WIRING', `${name} runtime code changed.`)
    }
  })

  const expectedPendleRouterImplementation = encodeAbiParameters(
    implementationStorageParameters,
    [args.market.routeUpgradePolicy.pendleRouter.implementation],
  )
  const expectedPendleRouterRedeemImplementation = encodeAbiParameters(
    implementationStorageParameters,
    [args.market.routeUpgradePolicy.pendleRouter.redeemImplementation],
  )
  const expectedPendleSwapImplementation = encodeAbiParameters(
    implementationStorageParameters,
    [args.market.routeUpgradePolicy.pendleSwap.implementation],
  )
  let routerImplementationWords: readonly (Hex | undefined)[]
  let pendleSwapImplementationWord: Hex | undefined
  try {
    ;[routerImplementationWords, pendleSwapImplementationWord] = await Promise.all([
      Promise.all(
        args.market.routeUpgradePolicy.pendleRouter.selectorImplementationSlots
          .map(({ storageSlot }) => args.client.getStorageAt({
            address: args.market.contracts.pendleRouter,
            slot: storageSlot,
            blockNumber,
          })),
      ),
      args.client.getStorageAt({
        address: args.market.contracts.pendleSwap,
        slot: args.market.routeUpgradePolicy.pendleSwap.implementationStorageSlot,
        blockNumber,
      }),
    ])
  } catch (error) {
    fail('UNSAFE_WIRING', 'Looping route implementation storage could not be read.', error)
  }
  routerImplementationWords.forEach((value, index) => {
    const selector = args.market.routeUpgradePolicy.pendleRouter
      .selectorImplementationSlots[index].selector
    const expected = selector === '0x47f1de22'
      ? expectedPendleRouterRedeemImplementation
      : expectedPendleRouterImplementation
    if (
      value === undefined ||
      !sameHex(value, expected)
    ) {
      fail(
        'UNSAFE_WIRING',
        `Pendle Router implementation changed for selector ${selector}.`,
      )
    }
  })
  if (
    pendleSwapImplementationWord === undefined ||
    !sameHex(pendleSwapImplementationWord, expectedPendleSwapImplementation)
  ) {
    fail('UNSAFE_WIRING', 'PendleSwap proxy implementation changed.')
  }
  if (args.includeMint) {
    const mintPolicy = args.market.mintRouteUpgradePolicy.pendleRouter
    let mintFacetCodeHash: Hex
    let mintFacetWord: Hex | undefined
    try {
      ;[mintFacetCodeHash, mintFacetWord] = await Promise.all([
        readRuntimeCodeHash({
          client: args.client,
          address: mintPolicy.facet,
          blockNumber,
        }),
        args.client.getStorageAt({
          address: args.market.contracts.pendleRouter,
          slot: mintPolicy.selectorStorageSlot,
          blockNumber,
        }),
      ])
    } catch (error) {
      fail(
        'UNSAFE_WIRING',
        'Pendle Mint Router facet pin could not be read.',
        error,
      )
    }
    const expectedMintFacet = encodeAbiParameters(
      implementationStorageParameters,
      [mintPolicy.facet],
    )
    if (
      !sameHex(mintFacetCodeHash, mintPolicy.facetRuntimeCodeHash) ||
      mintFacetWord === undefined ||
      !sameHex(mintFacetWord, expectedMintFacet)
    ) {
      fail(
        'UNSAFE_WIRING',
        `Pendle Mint Router implementation changed for selector ${mintPolicy.selector}.`,
      )
    }
  }
}

async function assertMorphoRuntimeCodeHash(args: {
  client: PublicClient
  market: Readonly<LoopingExecutionMarket>
  blockNumber?: bigint
}): Promise<void> {
  const codeHash = await readRuntimeCodeHash({
    client: args.client,
    address: args.market.contracts.morpho,
    blockNumber: args.blockNumber,
  })
  if (!sameHex(codeHash, args.market.runtimeCodePolicy.morpho)) {
    fail('UNSAFE_WIRING', 'Morpho runtime code changed.')
  }
}

function classifyPosition(
  value: readonly [bigint, bigint, bigint],
): LoopingPositionSnapshot {
  const [supplyShares, borrowShares, collateral] = value
  return {
    supplyShares,
    borrowShares,
    collateral,
    classification: supplyShares !== 0n
      ? 'conflicting-supply'
      : borrowShares === 0n && collateral === 0n
        ? 'empty'
        : 'open-loop',
  }
}

function marketParamsTuple(
  market: Readonly<LoopingExecutionMarket>,
): readonly [Address, Address, Address, Address, bigint] {
  const params = market.morphoMarketParams
  return [
    params.loanToken,
    params.collateralToken,
    params.oracle,
    params.irm,
    params.lltv,
  ]
}

function assertMarketTuple(
  actual: readonly [Address, Address, Address, Address, bigint],
  market: Readonly<LoopingExecutionMarket>,
): void {
  const expected = marketParamsTuple(market)
  if (
    !sameAddress(actual[0], expected[0]) ||
    !sameAddress(actual[1], expected[1]) ||
    !sameAddress(actual[2], expected[2]) ||
    !sameAddress(actual[3], expected[3]) ||
    actual[4] !== expected[4]
  ) {
    fail('UNSAFE_WIRING', 'The live Morpho market tuple changed.')
  }
  const derivedId = keccak256(
    encodeAbiParameters(morphoMarketIdParameters, expected),
  )
  if (!sameHex(derivedId, market.marketId)) {
    fail('UNSAFE_WIRING', 'The reviewed Morpho tuple no longer derives its market id.')
  }
}

function expectedMorphoDomainSeparator(
  market: Readonly<LoopingExecutionMarket>,
): Hex {
  return keccak256(
    encodeAbiParameters(domainHashParameters, [
      eip712DomainTypeHash,
      BigInt(market.chainId),
      market.contracts.morpho,
    ]),
  )
}

function authorizationDigest(
  domainSeparator: Hex,
  authorization: Readonly<LoopingAuthorizationMessage>,
): Hex {
  const structHash = keccak256(
    encodeAbiParameters(authorizationHashParameters, [
      authorizationTypeHash,
      authorization.authorizer,
      authorization.authorized,
      authorization.isAuthorized,
      authorization.nonce,
      authorization.deadline,
    ]),
  )
  return keccak256(concatHex(['0x1901', domainSeparator, structHash]))
}

function makeAuthorizationRequest(args: {
  market: Readonly<LoopingExecutionMarket>
  owner: Address
  nonce: bigint
  deadline: bigint
  isAuthorized: boolean
  operation: 'entry' | 'exit' | 'nonce-burn'
}): LoopingAuthorizationRequest {
  const message = Object.freeze({
    authorizer: args.owner,
    authorized: args.market.contracts.generalAdapter1,
    isAuthorized: args.isAuthorized,
    nonce: args.nonce,
    deadline: args.deadline,
  })
  const domain = Object.freeze({
    chainId: args.market.chainId,
    verifyingContract: args.market.contracts.morpho,
  })
  const digest = authorizationDigest(
    expectedMorphoDomainSeparator(args.market),
    message,
  )
  const viemDigest = hashTypedData({
    domain,
    types: loopingAuthorizationTypes,
    primaryType: 'Authorization',
    message,
  })
  if (!sameHex(digest, viemDigest)) {
    fail('UNSAFE_WIRING', 'Morpho authorization typed-data digest changed.')
  }
  return {
    purpose: args.operation === 'nonce-burn'
      ? 'burn-authorization-nonce'
      : `${args.isAuthorized ? 'authorize' : 'revoke'}-${args.operation}`,
    domain,
    types: loopingAuthorizationTypes,
    primaryType: 'Authorization',
    message,
    digest,
  }
}

async function readStaticLoopingWiring(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  blockNumber?: bigint
  allowMatured?: boolean
  includeMint?: boolean
}): Promise<{
  blockNumber: bigint
  blockHash: Hex
  pendleYieldToken: Address
  wiring: LoopingWiringSnapshot
  position: LoopingPositionSnapshot
}> {
  const { client, owner, market } = args
  const params = market.morphoMarketParams
  // Initial preflight deliberately uses one mined latest block, not `pending`.
  // Every route pin and wallet/market state read must describe the same
  // canonical snapshot; post-sign simulation/revalidation catches later drift.
  const pinnedBlock = await client.getBlock(args.blockNumber === undefined
    ? { blockTag: 'latest' }
    : { blockNumber: args.blockNumber })
  if (pinnedBlock.number === null || pinnedBlock.hash === null) {
    fail('UNSAFE_WIRING', 'Looping preflight could not pin a canonical block.')
  }
  const blockNumber = pinnedBlock.number
  const block = { blockNumber }
  const codeAddresses = [
    ...Object.values(market.contracts),
    market.pendleMarket,
    market.standardizedYield,
    params.loanToken,
    params.collateralToken,
    params.oracle,
    params.irm,
    market.routeUpgradePolicy.pendleRouter.implementation,
    market.routeUpgradePolicy.pendleRouter.redeemImplementation,
    market.routeUpgradePolicy.pendleSwap.implementation,
    ...market.routePolicy.externalRouterAllowlist,
    ...market.routePolicy.kyber.executorAllowlist.map((item) => item.address),
    ...market.routePolicy.mintSyTokenAllowlist,
    ...market.routePolicy.redeemSyTokenAllowlist,
    ...(args.includeMint
      ? [
          market.yieldToken,
          market.mintRouteUpgradePolicy.pendleRouter.facet,
        ]
      : []),
  ]
  const uniqueCodeAddresses = [...new Map(
    codeAddresses.map((address) => [address.toLowerCase(), address]),
  ).values()]

  const [chainId, ownerCode] = await Promise.all([
    client.getChainId(),
    client.getBytecode({ address: owner, ...block }),
  ])
  if (chainId !== market.chainId) {
    fail(
      'UNSUPPORTED_CHAIN',
      `RPC chain mismatch: expected ${market.chainId}, received ${chainId}.`,
    )
  }
  if (hasRuntimeCode(ownerCode)) {
    fail('STATE_CONFLICT', 'Looping execution currently supports EOA wallets only.')
  }

  const runtimeCodes = await mapLoopingReadsInBatches(
    uniqueCodeAddresses,
    (address) => client.getBytecode({ address, ...block }),
  )
  uniqueCodeAddresses.forEach((address, index) => {
    const code = runtimeCodes[index]
    if (!hasRuntimeCode(code)) {
      fail('UNSAFE_WIRING', `Required looping contract has no code: ${address}.`)
    }
  })

  const [adapterBundler, adapterMorpho, marketTokens, marketExpiry] =
    await Promise.all([
    client.readContract({
      address: market.contracts.generalAdapter1,
      abi: generalAdapter1Abi,
      functionName: 'BUNDLER3',
      ...block,
    }),
    client.readContract({
      address: market.contracts.generalAdapter1,
      abi: generalAdapter1Abi,
      functionName: 'MORPHO',
      ...block,
    }),
    client.readContract({
      address: market.pendleMarket,
      abi: pendleLoopingMarketAbi,
      functionName: 'readTokens',
      ...block,
    }),
    client.readContract({
      address: market.pendleMarket,
      abi: pendleLoopingMarketAbi,
      functionName: 'expiry',
      ...block,
    }),
  ])
  const [tokensIn, tokensOut, liveMarketParams, loanDecimals] = await Promise.all([
    client.readContract({
      address: market.standardizedYield,
      abi: loopingStandardizedYieldAbi,
      functionName: 'getTokensIn',
      ...block,
    }),
    client.readContract({
      address: market.standardizedYield,
      abi: loopingStandardizedYieldAbi,
      functionName: 'getTokensOut',
      ...block,
    }),
    client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'idToMarketParams',
      args: [market.marketId],
      ...block,
    }),
    client.readContract({
      address: params.loanToken,
      abi: loopingErc20Abi,
      functionName: 'decimals',
      ...block,
    }),
  ])
  const [
    collateralDecimals,
    yieldTokenDecimals,
    domainSeparator,
    nonce,
    adapterAuthorized,
  ] =
    await Promise.all([
    client.readContract({
      address: params.collateralToken,
      abi: loopingErc20Abi,
      functionName: 'decimals',
      ...block,
    }),
    args.includeMint
      ? client.readContract({
          address: market.yieldToken,
          abi: loopingErc20Abi,
          functionName: 'decimals',
          ...block,
        })
      : Promise.resolve(market.yieldTokenDecimals),
    client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'DOMAIN_SEPARATOR',
      ...block,
    }),
    client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'nonce',
      args: [owner],
      ...block,
    }),
    client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'isAuthorized',
      args: [owner, market.contracts.generalAdapter1],
      ...block,
    }),
  ])
  const [
    adapterAllowance,
    morphoAllowance,
    ownerLoanBalance,
    rawPosition,
  ] = await Promise.all([
    client.readContract({
      address: params.loanToken,
      abi: loopingErc20Abi,
      functionName: 'allowance',
      args: [owner, market.contracts.generalAdapter1],
      ...block,
    }),
    client.readContract({
      address: params.loanToken,
      abi: loopingErc20Abi,
      functionName: 'allowance',
      args: [owner, market.contracts.morpho],
      ...block,
    }),
    client.readContract({
      address: params.loanToken,
      abi: loopingErc20Abi,
      functionName: 'balanceOf',
      args: [owner],
      ...block,
    }),
    client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'position',
      args: [market.marketId, owner],
      ...block,
    }),
  ])
  const bundlerInitiator = await client.readContract({
    address: market.contracts.bundler3,
    abi: bundler3Abi,
    functionName: 'initiator',
    ...block,
  })
  await assertPinnedRuntimeCodeHashes({
    client,
    market,
    blockNumber,
    includeMint: args.includeMint,
  })
  if (
    !sameAddress(adapterBundler, market.contracts.bundler3) ||
    !sameAddress(adapterMorpho, market.contracts.morpho)
  ) {
    fail('UNSAFE_WIRING', 'GeneralAdapter1 immutable wiring changed.')
  }
  if (
    !sameAddress(marketTokens[0], market.standardizedYield) ||
    !sameAddress(marketTokens[1], params.collateralToken) ||
    !sameAddress(marketTokens[2], market.yieldToken) ||
    marketExpiry !== market.pendleMarketExpiry
  ) {
    fail('UNSAFE_WIRING', 'Pendle market token wiring or expiry changed.')
  }
  if (!args.allowMatured && pinnedBlock.timestamp >= marketExpiry) {
    fail('UNSAFE_WIRING', 'The Pendle market has matured; new looping actions are disabled.')
  }
  assertMarketTuple(liveMarketParams, market)
  if (
    loanDecimals !== market.loanTokenDecimals ||
    collateralDecimals !== market.collateralTokenDecimals ||
    (
      args.includeMint &&
      (
        yieldTokenDecimals !== market.yieldTokenDecimals ||
        yieldTokenDecimals !== collateralDecimals
      )
    )
  ) {
    fail('UNSAFE_WIRING', 'Looping token decimals changed.')
  }
  if (!sameHex(domainSeparator, expectedMorphoDomainSeparator(market))) {
    fail('UNSAFE_WIRING', 'Morpho authorization domain separator changed.')
  }
  for (const token of market.routePolicy.mintSyTokenAllowlist) {
    assertAddressArrayContains(tokensIn, token, `Allowlisted mint token ${token}`)
  }
  for (const token of market.routePolicy.redeemSyTokenAllowlist) {
    assertAddressArrayContains(tokensOut, token, `Allowlisted redeem token ${token}`)
  }
  if (adapterAuthorized) {
    fail('STATE_CONFLICT', 'GeneralAdapter1 is already authorized for this wallet.')
  }
  if (!sameAddress(bundlerInitiator, zeroAddress)) {
    fail('STATE_CONFLICT', 'Bundler3 has a nonzero transient initiator.')
  }

  const kyberExecutorCodeHashes: Record<string, Hex> = {}
  for (const executor of market.routePolicy.kyber.executorAllowlist) {
    const index = uniqueCodeAddresses.findIndex((address) =>
      sameAddress(address, executor.address),
    )
    const code = runtimeCodes[index]
    if (!hasRuntimeCode(code)) {
      fail('UNSAFE_WIRING', `Kyber executor has no code: ${executor.address}.`)
    }
    const codeHash = keccak256(code)
    try {
      requireLoopingKyberExecutor(market, executor.address, codeHash)
    } catch (error) {
      fail('UNSAFE_WIRING', 'Kyber executor runtime code changed.', error)
    }
    kyberExecutorCodeHashes[executor.address.toLowerCase()] = codeHash
  }

  return {
    blockNumber,
    blockHash: pinnedBlock.hash,
    pendleYieldToken: getAddress(marketTokens[2]),
    wiring: {
      blockTimestamp: pinnedBlock.timestamp,
      domainSeparator,
      nonce,
      adapterAuthorized,
      adapterAllowance,
      morphoAllowance,
      ownerLoanBalance,
      tokensIn,
      tokensOut,
      kyberExecutorCodeHashes,
    },
    position: classifyPosition(rawPosition),
  }
}

export async function readLoopingExecutionPosition(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  blockNumber?: bigint
}): Promise<LoopingPositionSnapshot> {
  const market = canonicalExecutionMarket(args.market)
  const chainId = await args.client.getChainId()
  if (chainId !== market.chainId) {
    fail('UNSUPPORTED_CHAIN', 'Cannot read a looping position from the wrong chain.')
  }
  const position = await args.client.readContract({
    address: market.contracts.morpho,
    abi: morphoBlueAbi,
    functionName: 'position',
    args: [market.marketId, args.owner],
    ...(args.blockNumber === undefined
      ? { blockTag: 'pending' as const }
      : { blockNumber: args.blockNumber }),
  })
  return classifyPosition(position)
}

async function readAccruedLoopingSnapshot(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  blockNumber: bigint
  includeOracle?: boolean
}): Promise<{
  accrued: LoopingAccruedMarketSnapshot
  position: LoopingPositionSnapshot
}> {
  const includeOracle = args.includeOracle ?? true
  const calls = [
    {
      target: args.market.contracts.morpho,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'accrueInterest',
        args: [args.market.morphoMarketParams],
      }),
    },
    {
      target: args.market.contracts.morpho,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'market',
        args: [args.market.marketId],
      }),
    },
    {
      target: args.market.contracts.morpho,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'position',
        args: [args.market.marketId, args.owner],
      }),
    },
    ...(includeOracle
      ? [{
          target: args.market.morphoMarketParams.oracle,
          allowFailure: false,
          callData: encodeFunctionData({
            abi: morphoOracleAbi,
            functionName: 'price',
          }),
        }]
      : []),
  ] as const
  const data = encodeFunctionData({
    abi: loopingMulticall3Abi,
    functionName: 'aggregate3',
    args: [calls],
  })
  let result: Awaited<ReturnType<PublicClient['call']>>
  try {
    result = await args.client.call({
      account: args.owner,
      to: args.market.contracts.multicall3,
      data,
      value: 0n,
      blockNumber: args.blockNumber,
    })
  } catch (error) {
    fail('SIMULATION_FAILED', 'Pinned Morpho accrual snapshot failed.', error)
  }
  if (!result.data) {
    fail('SIMULATION_FAILED', 'Pinned Morpho accrual snapshot returned no data.')
  }
  const aggregateResults = decodeFunctionResult({
    abi: loopingMulticall3Abi,
    functionName: 'aggregate3',
    data: result.data,
  })
  if (
    aggregateResults.length !== (includeOracle ? 4 : 3) ||
    aggregateResults.some((item) => !item.success)
  ) {
    fail('SIMULATION_FAILED', 'Pinned Morpho accrual snapshot was incomplete.')
  }
  const liveMarket = decodeFunctionResult({
    abi: morphoBlueAbi,
    functionName: 'market',
    data: aggregateResults[1].returnData,
  })
  const rawPosition = decodeFunctionResult({
    abi: morphoBlueAbi,
    functionName: 'position',
    data: aggregateResults[2].returnData,
  })
  const oraclePrice = includeOracle
    ? decodeFunctionResult({
        abi: morphoOracleAbi,
        functionName: 'price',
        data: aggregateResults[3].returnData,
      })
    : 0n
  return {
    accrued: {
      totalSupplyAssets: liveMarket[0],
      totalSupplyShares: liveMarket[1],
      totalBorrowAssets: liveMarket[2],
      totalBorrowShares: liveMarket[3],
      lastUpdate: liveMarket[4],
      fee: liveMarket[5],
      oraclePrice,
    },
    position: classifyPosition(rawPosition),
  }
}

/**
 * Read one allowlisted Morpho loop position at a single canonical block.
 * `accrueInterest` runs only inside the pinned `eth_call`; this function does
 * not fetch a route, construct a signature, or expose a wallet write.
 */
export async function readLoopingPositionInventory(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
}): Promise<LoopingPositionInventorySnapshot> {
  const market = canonicalExecutionMarket(args.market)
  const owner = getAddress(args.owner)
  const [chainId, block] = await Promise.all([
    args.client.getChainId(),
    args.client.getBlock({ blockTag: 'latest' }),
  ])
  if (chainId !== market.chainId) {
    fail('UNSUPPORTED_CHAIN', 'Cannot read looping inventory on the wrong chain.')
  }
  if (block.number === null || block.hash === null) {
    fail('STATE_CONFLICT', 'Looping inventory could not pin a canonical block.')
  }
  await assertMorphoRuntimeCodeHash({
    client: args.client,
    market,
    blockNumber: block.number,
  })
  const snapshot = await readAccruedLoopingSnapshot({
    client: args.client,
    owner,
    market,
    blockNumber: block.number,
  })
  const accruedDebtAssets = snapshot.position.borrowShares === 0n
    ? 0n
    : ceilDiv(
        snapshot.position.borrowShares *
          (snapshot.accrued.totalBorrowAssets + VIRTUAL_ASSETS),
        snapshot.accrued.totalBorrowShares + VIRTUAL_SHARES,
      )
  const collateralLoanValue =
    snapshot.position.collateral * snapshot.accrued.oraclePrice /
      ORACLE_PRICE_SCALE
  const ltvBps = collateralLoanValue === 0n
    ? accruedDebtAssets === 0n ? 0n : null
    : accruedDebtAssets * BPS / collateralLoanValue
  const maxBorrowAssets =
    collateralLoanValue * market.morphoMarketParams.lltv / WAD
  const liquidationBufferBps = accruedDebtAssets === 0n
    ? BPS
    : maxBorrowAssets <= accruedDebtAssets
      ? 0n
      : (maxBorrowAssets - accruedDebtAssets) * BPS / maxBorrowAssets
  return Object.freeze({
    kind: 'loop-position-inventory',
    owner,
    marketId: market.marketId,
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    position: Object.freeze({ ...snapshot.position }),
    accruedDebtAssets,
    collateralLoanValue,
    ltvBps,
    liquidationBufferBps,
  })
}

function deriveEntryBorrowBounds(
  accrued: Readonly<LoopingAccruedMarketSnapshot>,
  borrowAssets: bigint,
  market: Readonly<LoopingExecutionMarket>,
): LoopingEntryBorrowBounds {
  if (accrued.totalSupplyAssets < accrued.totalBorrowAssets + borrowAssets) {
    fail('POSITION_UNSAFE', 'Morpho lacks the requested loan-token liquidity.')
  }
  const observedBorrowShares = ceilDiv(
    borrowAssets * (accrued.totalBorrowShares + VIRTUAL_SHARES),
    accrued.totalBorrowAssets + VIRTUAL_ASSETS,
  )
  const maxBorrowShares = ceilDiv(
    observedBorrowShares *
      (BPS + BigInt(market.launchPolicy.borrowShareBufferBps)),
    BPS,
  ) + 2n
  const minBorrowSharePriceE27 =
    borrowAssets * RAY / (maxBorrowShares + 1n) + 1n
  const observedBorrowSharePriceE27 =
    borrowAssets * RAY / observedBorrowShares
  if (
    observedBorrowShares <= 0n ||
    maxBorrowShares <= observedBorrowShares ||
    observedBorrowSharePriceE27 < minBorrowSharePriceE27
  ) {
    fail('POSITION_UNSAFE', 'Finite Morpho borrow-share bounds are invalid.')
  }
  return {
    observedBorrowShares,
    maxBorrowShares,
    minBorrowSharePriceE27,
    observedBorrowSharePriceE27,
  }
}

function calculateEntryHealth(args: {
  market: Readonly<LoopingExecutionMarket>
  collateral: bigint
  borrowAssets: bigint
  oraclePrice: bigint
}): LoopingEntryHealthSnapshot {
  const collateralLoanValue =
    args.collateral * args.oraclePrice / ORACLE_PRICE_SCALE
  const maxBorrowAssets =
    collateralLoanValue * args.market.morphoMarketParams.lltv / WAD
  const liquidationBufferBps = args.borrowAssets === 0n
    ? BPS
    : maxBorrowAssets <= args.borrowAssets
      ? 0n
      : (maxBorrowAssets - args.borrowAssets) * BPS / maxBorrowAssets
  return {
    borrowAssets: args.borrowAssets,
    collateralLoanValue,
    maxBorrowAssets,
    liquidationBufferBps,
    oraclePrice: args.oraclePrice,
  }
}

function deriveEntryHealth(args: {
  market: Readonly<LoopingExecutionMarket>
  acquisitionMode: LoopingAcquisitionMode
  collateral: bigint
  equityAssets: bigint
  borrowAssets: bigint
  oraclePrice: bigint
}): LoopingEntryHealthSnapshot {
  if (
    args.collateral <= 0n ||
    args.equityAssets <= 0n ||
    args.borrowAssets <= 0n ||
    args.oraclePrice <= 0n
  ) {
    fail('POSITION_UNSAFE', 'Entry collateral, equity, debt, and oracle price must be positive.')
  }
  const health = calculateEntryHealth(args)
  const grossEntryAssets = args.equityAssets + args.borrowAssets
  if (
    args.acquisitionMode === 'market' &&
    health.collateralLoanValue * BPS <
      grossEntryAssets * BigInt(args.market.launchPolicy.minEntryValueBps)
  ) {
    fail(
      'POSITION_UNSAFE',
      'Quoted entry collateral is worth less than 90% of supplied equity plus debt.',
    )
  }
  if (health.maxBorrowAssets <= args.borrowAssets) {
    fail('POSITION_UNSAFE', 'Quoted entry would be liquidatable at the current oracle price.')
  }
  if (
    health.liquidationBufferBps <
      BigInt(args.market.launchPolicy.modelMinLiquidationBufferBps)
  ) {
    fail(
      'POSITION_UNSAFE',
      `Quoted entry leaves only ${health.liquidationBufferBps} bps of liquidation headroom.`,
    )
  }
  return health
}

function samePosition(
  left: Readonly<LoopingPositionSnapshot>,
  right: Readonly<LoopingPositionSnapshot>,
): boolean {
  return left.supplyShares === right.supplyShares &&
    left.borrowShares === right.borrowShares &&
    left.collateral === right.collateral
}

function deriveExitRepaymentBounds(
  accrued: Readonly<LoopingAccruedMarketSnapshot>,
  borrowShares: bigint,
  market: Readonly<LoopingExecutionMarket>,
): LoopingExitRepaymentBounds {
  if (borrowShares <= 0n || accrued.totalBorrowShares <= 0n) {
    fail('POSITION_UNSAFE', 'A full exit requires positive live debt shares.')
  }
  const accruedDebtAssets = ceilDiv(
    borrowShares * (accrued.totalBorrowAssets + VIRTUAL_ASSETS),
    accrued.totalBorrowShares + VIRTUAL_SHARES,
  )
  const repaymentCapAssets = ceilDiv(
    accruedDebtAssets * (BPS + BigInt(market.launchPolicy.repayDriftBps)),
    BPS,
  ) + 2n
  const maxRepaySharePriceE27 =
    ((repaymentCapAssets + 1n) * RAY - 1n) / borrowShares
  const maxAuthorizedRepayAssets =
    borrowShares * maxRepaySharePriceE27 / RAY
  const observedRepaySharePriceE27 = ceilDiv(
    accruedDebtAssets * RAY,
    borrowShares,
  )
  if (
    accruedDebtAssets <= 0n ||
    repaymentCapAssets <= accruedDebtAssets ||
    maxAuthorizedRepayAssets > repaymentCapAssets ||
    observedRepaySharePriceE27 > maxRepaySharePriceE27 ||
    maxRepaySharePriceE27 >= maxUint256
  ) {
    fail('POSITION_UNSAFE', 'Finite Morpho exit repayment bounds are invalid.')
  }
  return {
    borrowShares,
    accruedDebtAssets,
    repaymentCapAssets,
    maxRepaySharePriceE27,
    maxAuthorizedRepayAssets,
    observedRepaySharePriceE27,
  }
}

function debtAssetsForShares(
  accrued: Readonly<LoopingAccruedMarketSnapshot>,
  borrowShares: bigint,
): bigint {
  if (borrowShares === 0n) return 0n
  if (borrowShares < 0n || accrued.totalBorrowShares <= 0n) {
    fail('POSITION_UNSAFE', 'Looping debt shares or market totals are invalid.')
  }
  return ceilDiv(
    borrowShares * (accrued.totalBorrowAssets + VIRTUAL_ASSETS),
    accrued.totalBorrowShares + VIRTUAL_SHARES,
  )
}

function deriveLeverageSnapshot(args: {
  market: Readonly<LoopingExecutionMarket>
  collateral: bigint
  borrowShares: bigint
  debtAssets: bigint
  oraclePrice: bigint
}): LoopingLeverageSnapshot {
  if (
    args.collateral <= 0n ||
    args.borrowShares <= 0n ||
    args.debtAssets <= 0n ||
    args.oraclePrice <= 0n
  ) {
    fail('POSITION_UNSAFE', 'A leverage adjustment requires positive collateral and debt.')
  }
  const collateralLoanValue =
    args.collateral * args.oraclePrice / ORACLE_PRICE_SCALE
  if (collateralLoanValue <= args.debtAssets) {
    fail('POSITION_UNSAFE', 'The looping position has no positive oracle-valued equity.')
  }
  const equityAssets = collateralLoanValue - args.debtAssets
  const leverageWad = ceilDiv(collateralLoanValue * WAD, equityAssets)
  const maxBorrowAssets =
    collateralLoanValue * args.market.morphoMarketParams.lltv / WAD
  if (maxBorrowAssets <= args.debtAssets) {
    fail('POSITION_UNSAFE', 'The adjusted position would not be healthy.')
  }
  const liquidationBufferBps =
    (maxBorrowAssets - args.debtAssets) * BPS / maxBorrowAssets
  return {
    collateral: args.collateral,
    borrowShares: args.borrowShares,
    debtAssets: args.debtAssets,
    collateralLoanValue,
    equityAssets,
    leverageWad,
    maxBorrowAssets,
    liquidationBufferBps,
    oraclePrice: args.oraclePrice,
  }
}

function deriveCurrentLeverage(args: {
  market: Readonly<LoopingExecutionMarket>
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
}): LoopingLeverageSnapshot {
  return deriveLeverageSnapshot({
    market: args.market,
    collateral: args.position.collateral,
    borrowShares: args.position.borrowShares,
    debtAssets: debtAssetsForShares(args.accrued, args.position.borrowShares),
    oraclePrice: args.accrued.oraclePrice,
  })
}

function assertAdjustmentTarget(
  targetLeverageWad: bigint,
  currentLeverageWad: bigint,
  direction: 'increase' | 'decrease',
): void {
  if (targetLeverageWad <= WAD) {
    fail(
      'INVALID_INPUT',
      direction === 'decrease'
        ? 'Use full exit for a 1x target; partial leverage must remain above 1x.'
        : 'Increased leverage must remain above 1x.',
    )
  }
  if (
    direction === 'increase'
      ? targetLeverageWad <= currentLeverageWad
      : targetLeverageWad >= currentLeverageWad
  ) {
    fail('INVALID_INPUT', `The target must ${direction} the current leverage.`)
  }
}

function assertAdjustmentOutcome(args: {
  market: Readonly<LoopingExecutionMarket>
  targetLeverageWad: bigint
  current: Readonly<LoopingLeverageSnapshot>
  post: Readonly<LoopingLeverageSnapshot>
  direction: 'increase' | 'decrease'
}): void {
  if (args.post.leverageWad > args.targetLeverageWad) {
    fail('POSITION_UNSAFE', 'The conservative adjusted leverage exceeds the target.')
  }
  if (
    args.direction === 'increase'
      ? args.post.leverageWad <= args.current.leverageWad
      : args.post.leverageWad >= args.current.leverageWad
  ) {
    fail('POSITION_UNSAFE', `The adjustment does not ${args.direction} leverage.`)
  }
  if (
    args.direction === 'increase' &&
    args.post.liquidationBufferBps <
      BigInt(args.market.launchPolicy.modelMinLiquidationBufferBps)
  ) {
    fail(
      'POSITION_UNSAFE',
      'The adjusted position would be inside the live liquidation-buffer limit.',
    )
  }
  if (
    args.direction === 'increase'
      ? args.post.liquidationBufferBps >= args.current.liquidationBufferBps
      : args.post.liquidationBufferBps <= args.current.liquidationBufferBps
  ) {
    fail('POSITION_UNSAFE', `The adjustment does not improve the requested risk direction.`)
  }
}

function deriveIncreasePost(args: {
  market: Readonly<LoopingExecutionMarket>
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  borrowAssets: bigint
  maxBorrowShares: bigint
  minimumAddedCollateral: bigint
}): LoopingLeverageSnapshot {
  const postBorrowShares = args.position.borrowShares + args.maxBorrowShares
  const postTotalBorrowAssets =
    args.accrued.totalBorrowAssets + args.borrowAssets
  const postTotalBorrowShares =
    args.accrued.totalBorrowShares + args.maxBorrowShares
  const worstDebtAssets = ceilDiv(
    postBorrowShares * (postTotalBorrowAssets + VIRTUAL_ASSETS),
    postTotalBorrowShares + VIRTUAL_SHARES,
  )
  return deriveLeverageSnapshot({
    market: args.market,
    collateral: args.position.collateral + args.minimumAddedCollateral,
    borrowShares: postBorrowShares,
    debtAssets: worstDebtAssets,
    oraclePrice: args.accrued.oraclePrice,
  })
}

function deriveDecreasePost(args: {
  market: Readonly<LoopingExecutionMarket>
  position: Readonly<LoopingPositionSnapshot>
  accrued: Readonly<LoopingAccruedMarketSnapshot>
  repayShares: bigint
  collateralToSell: bigint
  maxRepaySharePriceE27: bigint
}): LoopingLeverageSnapshot {
  const remainingBorrowShares = args.position.borrowShares - args.repayShares
  const remainingCollateral = args.position.collateral - args.collateralToSell
  const worstDebtAssets = ceilDiv(
    remainingBorrowShares * args.maxRepaySharePriceE27,
    RAY,
  )
  return deriveLeverageSnapshot({
    market: args.market,
    collateral: remainingCollateral,
    borrowShares: remainingBorrowShares,
    debtAssets: worstDebtAssets,
    oraclePrice: args.accrued.oraclePrice,
  })
}

function assertCleanOpenAdjustmentPosition(
  position: Readonly<LoopingPositionSnapshot>,
): void {
  if (
    position.classification !== 'open-loop' ||
    position.supplyShares !== 0n ||
    position.borrowShares <= 0n ||
    position.collateral <= 0n
  ) {
    fail('STATE_CONFLICT', 'A leverage adjustment requires one clean debt-and-collateral position.')
  }
}

export async function prepareLoopingEntryExecution(
  args: LoopingEntryExecutionInput,
): Promise<LoopingEntryExecutionPreview> {
  const market = canonicalExecutionMarket(args.market)
  const now = args.now ?? Date.now
  const owner = getAddress(args.owner)
  const acquisitionMode = resolveLoopingAcquisitionMode(args.acquisitionMode)
  if (args.equityAssets <= 0n || args.borrowAssets <= 0n) {
    fail('INVALID_INPUT', 'Looping equity and debt must both be positive.')
  }

  let staticSnapshot: Awaited<ReturnType<typeof readStaticLoopingWiring>>
  try {
    staticSnapshot = await readStaticLoopingWiring({
      client: args.client,
      owner,
      market,
      includeMint: acquisitionMode === 'mint',
    })
  } catch (error) {
    if (error instanceof LoopingExecutionError) throw error
    fail(
      'UNSAFE_WIRING',
      'The RPC could not complete the pinned looping contract-state reads. No wallet action was taken; retry once.',
      error,
    )
  }
  const { wiring } = staticSnapshot
  if (staticSnapshot.position.classification !== 'empty') {
    fail('STATE_CONFLICT', 'The wallet already has a position in this Morpho market.')
  }
  if (wiring.ownerLoanBalance < args.equityAssets) {
    fail('STATE_CONFLICT', 'The wallet loan-token balance is below the requested equity.')
  }
  const accruedSnapshot = await readAccruedLoopingSnapshot({
    client: args.client,
    owner,
    market,
    blockNumber: staticSnapshot.blockNumber,
  })
  if (accruedSnapshot.position.classification !== 'empty') {
    fail('STATE_CONFLICT', 'The accrued position snapshot is not empty.')
  }
  const bounds = deriveEntryBorrowBounds(
    accruedSnapshot.accrued,
    args.borrowAssets,
    market,
  )
  const quoteWiring = {
    tokensIn: wiring.tokensIn,
    tokensOut: wiring.tokensOut,
    kyberExecutorCodeHashes: wiring.kyberExecutorCodeHashes,
  }
  let acquisitionQuotes:
    | Readonly<{
        acquisitionMode: 'market'
        initialQuote: Awaited<ReturnType<typeof fetchPendleLoopingBuyRoute>>
        loopQuote: Awaited<ReturnType<typeof fetchPendleLoopingBuyRoute>>
      }>
    | Readonly<{
        acquisitionMode: 'mint'
        initialQuote: Awaited<ReturnType<typeof fetchPendleLoopingMintRoute>>
        loopQuote: Awaited<ReturnType<typeof fetchPendleLoopingMintRoute>>
      }>
  if (acquisitionMode === 'mint') {
    const [initialQuote, loopQuote] = await Promise.all([
      fetchPendleLoopingMintRoute({
        market,
        wiring: quoteWiring,
        amountIn: args.equityAssets,
        yieldToken: staticSnapshot.pendleYieldToken,
        fetcher: args.fetcher,
        now,
      }),
      fetchPendleLoopingMintRoute({
        market,
        wiring: quoteWiring,
        amountIn: args.borrowAssets,
        yieldToken: staticSnapshot.pendleYieldToken,
        fetcher: args.fetcher,
        now,
      }),
    ])
    acquisitionQuotes = {
      acquisitionMode: 'mint',
      initialQuote,
      loopQuote,
    }
  } else {
    const [initialQuote, loopQuote] = await Promise.all([
      fetchPendleLoopingBuyRoute({
        market,
        wiring: quoteWiring,
        amountIn: args.equityAssets,
        fetcher: args.fetcher,
        now,
      }),
      fetchPendleLoopingBuyRoute({
        market,
        wiring: quoteWiring,
        amountIn: args.borrowAssets,
        fetcher: args.fetcher,
        now,
      }),
    ])
    acquisitionQuotes = {
      acquisitionMode: 'market',
      initialQuote,
      loopQuote,
    }
  }
  const { initialQuote, loopQuote } = acquisitionQuotes
  const quotedAtMs = Math.max(initialQuote.quotedAtMs, loopQuote.quotedAtMs)
  const oldestQuoteMs = Math.min(initialQuote.quotedAtMs, loopQuote.quotedAtMs)
  const validUntilMs = oldestQuoteMs + market.launchPolicy.quoteValidityMs
  if (!Number.isFinite(quotedAtMs) || now() >= validUntilMs) {
    fail('QUOTE_EXPIRED', 'Pendle entry quotes expired during preflight.')
  }
  const minimumCollateral =
    initialQuote.route.minPtOut + loopQuote.route.minPtOut
  const expectedCollateral =
    initialQuote.route.expectedPtOut + loopQuote.route.expectedPtOut
  const health = deriveEntryHealth({
    market,
    acquisitionMode,
    collateral: minimumCollateral,
    equityAssets: args.equityAssets,
    borrowAssets: args.borrowAssets,
    oraclePrice: accruedSnapshot.accrued.oraclePrice,
  })
  const deadline =
    wiring.blockTimestamp + market.launchPolicy.authorizationLifetimeSeconds
  const authorizationRequests = Object.freeze([
    Object.freeze(makeAuthorizationRequest({
      market,
      owner,
      nonce: wiring.nonce,
      deadline,
      isAuthorized: true,
      operation: 'entry',
    })),
    Object.freeze(makeAuthorizationRequest({
      market,
      owner,
      nonce: wiring.nonce + 1n,
      deadline,
      isAuthorized: false,
      operation: 'entry',
    })),
  ]) as LoopingEntryExecutionPreview['authorizationRequests']

  const previewBase: LoopingEntryExecutionPreviewBase = {
    kind: 'entry-preview',
    owner,
    market,
    equityAssets: args.equityAssets,
    borrowAssets: args.borrowAssets,
    quotedAtMs,
    validUntilMs,
    approval: Object.freeze({
      token: market.morphoMarketParams.loanToken,
      spender: market.contracts.generalAdapter1,
      current: wiring.adapterAllowance,
      required: args.equityAssets,
      needed: wiring.adapterAllowance !== args.equityAssets,
    }),
    position: Object.freeze(accruedSnapshot.position),
    accrued: Object.freeze(accruedSnapshot.accrued),
    bounds: Object.freeze(bounds),
    health: Object.freeze(health),
    authorizationRequests,
    wiring: Object.freeze({
      ...wiring,
      tokensIn: Object.freeze([...wiring.tokensIn]),
      tokensOut: Object.freeze([...wiring.tokensOut]),
      kyberExecutorCodeHashes: Object.freeze({
        ...wiring.kyberExecutorCodeHashes,
      }),
    }),
  }
  const preview: LoopingEntryExecutionPreview =
    acquisitionQuotes.acquisitionMode === 'mint'
      ? {
          ...previewBase,
          acquisitionMode: 'mint',
          yieldToken: staticSnapshot.pendleYieldToken,
          minimumYtOut:
            acquisitionQuotes.initialQuote.route.minPyOut +
            acquisitionQuotes.loopQuote.route.minPyOut,
          expectedYtOut:
            acquisitionQuotes.initialQuote.route.expectedPyOut +
            acquisitionQuotes.loopQuote.route.expectedPyOut,
          quotes: Object.freeze({
            initial: Object.freeze(acquisitionQuotes.initialQuote.route),
            loop: Object.freeze(acquisitionQuotes.loopQuote.route),
            minimumCollateral,
            expectedCollateral,
          }),
        }
      : {
          ...previewBase,
          acquisitionMode: 'market',
          yieldToken: null,
          minimumYtOut: 0n,
          expectedYtOut: 0n,
          quotes: Object.freeze({
            initial: Object.freeze(acquisitionQuotes.initialQuote.route),
            loop: Object.freeze(acquisitionQuotes.loopQuote.route),
            minimumCollateral,
            expectedCollateral,
          }),
        }
  Object.freeze(preview)
  preparedEntryPreviews.add(preview)
  return preview
}

export async function prepareLoopingExitExecution(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  minimumReturnedAssets: bigint
  fetcher?: LoopingFetcher
  now?: () => number
}): Promise<LoopingExitExecutionPreview> {
  const market = canonicalExecutionMarket(args.market)
  const now = args.now ?? Date.now
  const owner = getAddress(args.owner)
  if (args.minimumReturnedAssets <= 0n) {
    fail('INVALID_INPUT', 'The guaranteed loan-token return must be positive.')
  }

  let staticSnapshot: Awaited<ReturnType<typeof readStaticLoopingWiring>>
  try {
    staticSnapshot = await readStaticLoopingWiring({
      client: args.client,
      owner,
      market,
      allowMatured: true,
    })
  } catch (error) {
    if (error instanceof LoopingExecutionError) throw error
    fail(
      'UNSAFE_WIRING',
      'The RPC could not complete the pinned looping exit-state reads. No wallet action was taken; retry once.',
      error,
    )
  }
  const { wiring, position } = staticSnapshot
  if (
    position.classification !== 'open-loop' ||
    position.supplyShares !== 0n ||
    position.borrowShares <= 0n ||
    position.collateral <= 0n
  ) {
    fail('STATE_CONFLICT', 'A full exit requires one exact debt-and-collateral position.')
  }
  const accruedSnapshot = await readAccruedLoopingSnapshot({
    client: args.client,
    owner,
    market,
    blockNumber: staticSnapshot.blockNumber,
    includeOracle: false,
  })
  if (!samePosition(position, accruedSnapshot.position)) {
    fail('STATE_CONFLICT', 'The looping position changed during exit preflight.')
  }
  const bounds = deriveExitRepaymentBounds(
    accruedSnapshot.accrued,
    position.borrowShares,
    market,
  )
  const quoteWiring = {
    tokensIn: wiring.tokensIn,
    tokensOut: wiring.tokensOut,
    kyberExecutorCodeHashes: wiring.kyberExecutorCodeHashes,
  }
  const matured = wiring.blockTimestamp >= market.pendleMarketExpiry
  let quoteResult:
    | Awaited<ReturnType<typeof fetchPendleLoopingExitRoute>>
    | Awaited<ReturnType<typeof fetchPendleLoopingMaturedExitRoute>>
  if (matured) {
    let exchangeRate: bigint
    let pyIndexStored: bigint
    let yieldTokenCode: Hex | undefined
    try {
      [exchangeRate, pyIndexStored, yieldTokenCode] = await Promise.all([
        args.client.readContract({
          address: market.standardizedYield,
          abi: loopingStandardizedYieldAbi,
          functionName: 'exchangeRate',
          blockNumber: staticSnapshot.blockNumber,
        }),
        args.client.readContract({
          address: staticSnapshot.pendleYieldToken,
          abi: loopingYieldTokenAbi,
          functionName: 'pyIndexStored',
          blockNumber: staticSnapshot.blockNumber,
        }),
        args.client.getBytecode({
          address: staticSnapshot.pendleYieldToken,
          blockNumber: staticSnapshot.blockNumber,
        }),
      ])
    } catch (error) {
      fail(
        'UNSAFE_WIRING',
        'The RPC could not read the matured PT redemption index. No wallet action was taken; retry once.',
        error,
      )
    }
    if (!hasRuntimeCode(yieldTokenCode)) {
      fail('UNSAFE_WIRING', 'The matured PT yield token has no runtime code.')
    }
    const pyIndex = exchangeRate > pyIndexStored ? exchangeRate : pyIndexStored
    if (pyIndex <= 0n) {
      fail('UNSAFE_WIRING', 'The matured PT redemption index is unavailable.')
    }
    const estimatedSyIn = position.collateral * WAD / pyIndex
    if (estimatedSyIn <= 0n) {
      fail('INVALID_INPUT', 'The matured PT position is below SY redemption precision.')
    }
    quoteResult = await fetchPendleLoopingMaturedExitRoute({
      market,
      wiring: quoteWiring,
      amountIn: estimatedSyIn,
      collateral: position.collateral,
      yieldToken: staticSnapshot.pendleYieldToken,
      repaymentCapAssets: bounds.repaymentCapAssets,
      minimumReturnedAssets: args.minimumReturnedAssets,
      fetcher: args.fetcher,
      now,
    })
  } else {
    quoteResult = await fetchPendleLoopingExitRoute({
      market,
      wiring: quoteWiring,
      amountIn: position.collateral,
      repaymentCapAssets: bounds.repaymentCapAssets,
      minimumReturnedAssets: args.minimumReturnedAssets,
      fetcher: args.fetcher,
      now,
    })
  }
  const validUntilMs = quoteResult.quotedAtMs + market.launchPolicy.quoteValidityMs
  if (!Number.isFinite(quoteResult.quotedAtMs) || now() >= validUntilMs) {
    fail('QUOTE_EXPIRED', 'Pendle exit quote expired during preflight.')
  }
  const minimumReturnedAssets =
    quoteResult.route.minLoanTokenOut - bounds.repaymentCapAssets
  if (minimumReturnedAssets < args.minimumReturnedAssets) {
    fail('ROUTE_NOT_ALLOWED', 'Pendle exit route weakened the requested net return.')
  }

  const deadline =
    wiring.blockTimestamp + market.launchPolicy.authorizationLifetimeSeconds
  const authorizationRequests = Object.freeze([
    Object.freeze(makeAuthorizationRequest({
      market,
      owner,
      nonce: wiring.nonce,
      deadline,
      isAuthorized: true,
      operation: 'exit',
    })),
    Object.freeze(makeAuthorizationRequest({
      market,
      owner,
      nonce: wiring.nonce + 1n,
      deadline,
      isAuthorized: false,
      operation: 'exit',
    })),
  ]) as LoopingExitExecutionPreview['authorizationRequests']

  const preview: LoopingExitExecutionPreview = {
    kind: 'exit-preview',
    owner,
    market,
    quotedAtMs: quoteResult.quotedAtMs,
    validUntilMs,
    requestedMinimumReturnedAssets: args.minimumReturnedAssets,
    minimumReturnedAssets,
    position: Object.freeze({ ...position }),
    accrued: Object.freeze({ ...accruedSnapshot.accrued }),
    bounds: Object.freeze(bounds),
    quote: Object.freeze(quoteResult.route),
    authorizationRequests,
    wiring: Object.freeze({
      ...wiring,
      tokensIn: Object.freeze([...wiring.tokensIn]),
      tokensOut: Object.freeze([...wiring.tokensOut]),
      kyberExecutorCodeHashes: Object.freeze({
        ...wiring.kyberExecutorCodeHashes,
      }),
    }),
  }
  Object.freeze(preview)
  preparedExitPreviews.add(preview)
  return preview
}

interface LoopingAdjustmentPreflight {
  market: Readonly<LoopingExecutionMarket>
  owner: Address
  staticSnapshot: Awaited<ReturnType<typeof readStaticLoopingWiring>>
  accruedSnapshot: Awaited<ReturnType<typeof readAccruedLoopingSnapshot>>
  current: Readonly<LoopingLeverageSnapshot>
}

async function readLoopingAdjustmentPreflight(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  includeMint?: boolean
}): Promise<LoopingAdjustmentPreflight> {
  const market = canonicalExecutionMarket(args.market)
  const owner = getAddress(args.owner)
  let staticSnapshot: Awaited<ReturnType<typeof readStaticLoopingWiring>>
  try {
    staticSnapshot = await readStaticLoopingWiring({
      client: args.client,
      owner,
      market,
      includeMint: args.includeMint,
    })
  } catch (error) {
    if (error instanceof LoopingExecutionError) throw error
    fail(
      'UNSAFE_WIRING',
      'The RPC could not complete the pinned looping adjustment-state reads. No wallet action was taken; retry once.',
      error,
    )
  }
  assertCleanOpenAdjustmentPosition(staticSnapshot.position)
  const accruedSnapshot = await readAccruedLoopingSnapshot({
    client: args.client,
    owner,
    market,
    blockNumber: staticSnapshot.blockNumber,
  })
  if (!samePosition(staticSnapshot.position, accruedSnapshot.position)) {
    fail('STATE_CONFLICT', 'The looping position changed during adjustment preflight.')
  }
  return {
    market,
    owner,
    staticSnapshot,
    accruedSnapshot,
    current: deriveCurrentLeverage({
      market,
      position: accruedSnapshot.position,
      accrued: accruedSnapshot.accrued,
    }),
  }
}

async function prepareLoopingIncreaseExecutionCore(
  args: LoopingIncreaseExecutionInput,
  preflight?: LoopingAdjustmentPreflight,
): Promise<LoopingIncreaseExecutionPreview> {
  const acquisitionMode = resolveLoopingAcquisitionMode(args.acquisitionMode)
  const loaded = preflight ?? await readLoopingAdjustmentPreflight({
    ...args,
    includeMint: acquisitionMode === 'mint',
  })
  const { market, owner, staticSnapshot, accruedSnapshot, current } = loaded
  const now = args.now ?? Date.now
  if (preflight !== undefined && acquisitionMode === 'mint') {
    await assertPinnedRuntimeCodeHashes({
      client: args.client,
      market,
      blockNumber: staticSnapshot.blockNumber,
      includeMint: true,
    })
  }
  assertAdjustmentTarget(args.targetLeverageWad, current.leverageWad, 'increase')
  const idealTargetDebt =
    current.equityAssets * (args.targetLeverageWad - WAD) / WAD
  if (idealTargetDebt <= current.debtAssets) {
    fail('INVALID_INPUT', 'The leverage target is too close to the current position.')
  }
  let borrowAssets = idealTargetDebt - current.debtAssets
  const availableBorrowAssets =
    accruedSnapshot.accrued.totalSupplyAssets -
      accruedSnapshot.accrued.totalBorrowAssets
  if (borrowAssets > availableBorrowAssets) {
    fail('INVALID_INPUT', 'The leverage increase exceeds available debt liquidity.')
  }
  let lowerBorrowAssets = 1n
  let upperBorrowAssets = borrowAssets * 2n
  if (upperBorrowAssets > availableBorrowAssets) {
    upperBorrowAssets = availableBorrowAssets
  }
  let finalQuote:
    | {
        quotedAtMs: number
        route: ValidatedLoopingAcquisitionRoute
      }
    | undefined
  let finalBounds: LoopingEntryBorrowBounds | undefined
  let finalPost: LoopingLeverageSnapshot | undefined
  for (
    let attempt = 0;
    attempt < MAX_ADJUSTMENT_QUOTE_ATTEMPTS;
    attempt += 1
  ) {
    if (borrowAssets <= 0n) break
    const bounds = deriveEntryBorrowBounds(
      accruedSnapshot.accrued,
      borrowAssets,
      market,
    )
    const quoteArgs = {
      market,
      wiring: {
        tokensIn: staticSnapshot.wiring.tokensIn,
        tokensOut: staticSnapshot.wiring.tokensOut,
        kyberExecutorCodeHashes:
          staticSnapshot.wiring.kyberExecutorCodeHashes,
      },
      amountIn: borrowAssets,
      fetcher: args.fetcher,
      now,
    }
    const quoteResult = acquisitionMode === 'mint'
      ? await fetchPendleLoopingMintRoute({
          ...quoteArgs,
          yieldToken: staticSnapshot.pendleYieldToken,
        })
      : await fetchPendleLoopingBuyRoute(quoteArgs)
    const addedCollateralValue =
      quoteResult.route.minPtOut * accruedSnapshot.accrued.oraclePrice /
        ORACLE_PRICE_SCALE
    if (
      acquisitionMode === 'market' &&
      addedCollateralValue * BPS <
        borrowAssets * BigInt(market.launchPolicy.minEntryValueBps)
    ) {
      fail(
        'POSITION_UNSAFE',
        'The guaranteed PT purchase is worth too little versus the added debt.',
      )
    }
    const post = deriveIncreasePost({
      market,
      position: accruedSnapshot.position,
      accrued: accruedSnapshot.accrued,
      borrowAssets,
      maxBorrowShares: bounds.maxBorrowShares,
      minimumAddedCollateral: quoteResult.route.minPtOut,
    })
    const targetGap = post.leverageWad <= args.targetLeverageWad
      ? args.targetLeverageWad - post.leverageWad
      : 0n
    if (
      post.leverageWad <= args.targetLeverageWad &&
      targetGap <= ADJUSTMENT_TARGET_TOLERANCE_WAD &&
      post.liquidationBufferBps >=
        BigInt(market.launchPolicy.modelMinLiquidationBufferBps)
    ) {
      assertAdjustmentOutcome({
        market,
        targetLeverageWad: args.targetLeverageWad,
        current,
        post,
        direction: 'increase',
      })
      finalQuote = quoteResult
      finalBounds = bounds
      finalPost = post
      break
    }
    if (post.leverageWad > args.targetLeverageWad) {
      if (borrowAssets === 0n) break
      upperBorrowAssets = borrowAssets - 1n
    } else {
      lowerBorrowAssets = borrowAssets + 1n
    }
    if (lowerBorrowAssets > upperBorrowAssets) break
    let nextBorrowAssets =
      (lowerBorrowAssets + upperBorrowAssets) / 2n
    if (post.leverageWad > current.leverageWad) {
      const proportional = borrowAssets *
        (args.targetLeverageWad - current.leverageWad) /
        (post.leverageWad - current.leverageWad)
      if (
        proportional >= lowerBorrowAssets &&
        proportional <= upperBorrowAssets
      ) {
        nextBorrowAssets = proportional
      }
    }
    if (nextBorrowAssets === borrowAssets) {
      nextBorrowAssets = post.leverageWad > args.targetLeverageWad
        ? borrowAssets - 1n
        : borrowAssets + 1n
    }
    borrowAssets = nextBorrowAssets
  }
  if (finalQuote === undefined || finalBounds === undefined || finalPost === undefined) {
    fail(
      'POSITION_UNSAFE',
      'A conservative leverage increase could not be quoted within four attempts.',
    )
  }
  const validUntilMs =
    finalQuote.quotedAtMs + market.launchPolicy.quoteValidityMs
  if (!Number.isFinite(finalQuote.quotedAtMs) || now() >= validUntilMs) {
    fail('QUOTE_EXPIRED', 'Pendle increase quote expired during preflight.')
  }
  const deadline = staticSnapshot.wiring.blockTimestamp +
    market.launchPolicy.authorizationLifetimeSeconds
  const authorizationRequests = Object.freeze([
    Object.freeze(makeAuthorizationRequest({
      market,
      owner,
      nonce: staticSnapshot.wiring.nonce,
      deadline,
      isAuthorized: true,
      operation: 'entry',
    })),
    Object.freeze(makeAuthorizationRequest({
      market,
      owner,
      nonce: staticSnapshot.wiring.nonce + 1n,
      deadline,
      isAuthorized: false,
      operation: 'entry',
    })),
  ]) as LoopingIncreaseExecutionPreview['authorizationRequests']
  const previewBase: LoopingIncreaseExecutionPreviewBase = {
    kind: 'increase-preview',
    owner,
    market,
    targetLeverageWad: args.targetLeverageWad,
    borrowAssets,
    quotedAtMs: finalQuote.quotedAtMs,
    validUntilMs,
    position: Object.freeze({ ...accruedSnapshot.position }),
    accrued: Object.freeze({ ...accruedSnapshot.accrued }),
    bounds: Object.freeze(finalBounds),
    current: Object.freeze(current),
    conservativePost: Object.freeze(finalPost),
    authorizationRequests,
    wiring: Object.freeze({
      ...staticSnapshot.wiring,
      tokensIn: Object.freeze([...staticSnapshot.wiring.tokensIn]),
      tokensOut: Object.freeze([...staticSnapshot.wiring.tokensOut]),
      kyberExecutorCodeHashes: Object.freeze({
        ...staticSnapshot.wiring.kyberExecutorCodeHashes,
      }),
    }),
  }
  let preview: LoopingIncreaseExecutionPreview
  if (acquisitionMode === 'mint') {
    if (finalQuote.route.kind !== 'mint-pt-yt') {
      fail('STATE_CONFLICT', 'Mint increase quote changed acquisition mode.')
    }
    preview = {
      ...previewBase,
      acquisitionMode: 'mint',
      yieldToken: staticSnapshot.pendleYieldToken,
      minimumYtOut: finalQuote.route.minPyOut,
      expectedYtOut: finalQuote.route.expectedPyOut,
      quote: Object.freeze(finalQuote.route),
    }
  } else {
    if (finalQuote.route.kind !== 'buy-pt') {
      fail('STATE_CONFLICT', 'Market increase quote changed acquisition mode.')
    }
    preview = {
      ...previewBase,
      acquisitionMode: 'market',
      yieldToken: null,
      minimumYtOut: 0n,
      expectedYtOut: 0n,
      quote: Object.freeze(finalQuote.route),
    }
  }
  Object.freeze(preview)
  preparedIncreasePreviews.add(preview)
  return preview
}

async function prepareLoopingDecreaseExecutionCore(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  targetLeverageWad: bigint
  fetcher?: LoopingFetcher
  now?: () => number
}, preflight?: LoopingAdjustmentPreflight): Promise<LoopingDecreaseExecutionPreview> {
  const loaded = preflight ?? await readLoopingAdjustmentPreflight(args)
  const { market, owner, staticSnapshot, accruedSnapshot, current } = loaded
  const now = args.now ?? Date.now
  assertAdjustmentTarget(args.targetLeverageWad, current.leverageWad, 'decrease')
  const targetDebt =
    current.equityAssets * (args.targetLeverageWad - WAD) / WAD
  if (targetDebt >= current.debtAssets) {
    fail('INVALID_INPUT', 'The leverage target is too close to the current position.')
  }
  const effectiveBorrowAssets =
    accruedSnapshot.accrued.totalBorrowAssets + VIRTUAL_ASSETS
  const effectiveBorrowShares =
    accruedSnapshot.accrued.totalBorrowShares + VIRTUAL_SHARES
  let repayShares = ceilDiv(
    (current.debtAssets - targetDebt) * effectiveBorrowShares,
    effectiveBorrowAssets,
  )
  if (repayShares >= accruedSnapshot.position.borrowShares) {
    repayShares = accruedSnapshot.position.borrowShares - 1n
  }
  if (repayShares <= 0n) {
    fail('INVALID_INPUT', 'The leverage decrease is below Morpho share precision.')
  }
  let collateralToSell = 0n
  let finalQuote:
    | Awaited<ReturnType<typeof fetchPendleLoopingExitRoute>>
    | undefined
  let finalBounds: LoopingExitRepaymentBounds | undefined
  let finalPost: LoopingLeverageSnapshot | undefined
  for (
    let attempt = 0;
    attempt < MAX_ADJUSTMENT_QUOTE_ATTEMPTS;
    attempt += 1
  ) {
    const bounds = deriveExitRepaymentBounds(
      accruedSnapshot.accrued,
      repayShares,
      market,
    )
    const requiredLoanOut = bounds.repaymentCapAssets + 1n
    const oracleCollateral = ceilDiv(
      requiredLoanOut * ORACLE_PRICE_SCALE,
      accruedSnapshot.accrued.oraclePrice,
    )
    if (collateralToSell < oracleCollateral) collateralToSell = oracleCollateral
    if (
      collateralToSell <= 0n ||
      collateralToSell >= accruedSnapshot.position.collateral
    ) {
      break
    }
    const quoteResult = await fetchPendleLoopingExitRoute({
      market,
      wiring: {
        tokensIn: staticSnapshot.wiring.tokensIn,
        tokensOut: staticSnapshot.wiring.tokensOut,
        kyberExecutorCodeHashes:
          staticSnapshot.wiring.kyberExecutorCodeHashes,
      },
      amountIn: collateralToSell,
      repaymentCapAssets: 1n,
      minimumReturnedAssets: 1n,
      fetcher: args.fetcher,
      now,
    })
    if (quoteResult.route.minLoanTokenOut < requiredLoanOut) {
      collateralToSell = ceilDiv(
        collateralToSell * requiredLoanOut * (BPS + 100n),
        quoteResult.route.minLoanTokenOut * BPS,
      ) + 1n
      continue
    }
    const soldCollateralValue =
      collateralToSell * accruedSnapshot.accrued.oraclePrice /
        ORACLE_PRICE_SCALE
    if (
      quoteResult.route.minLoanTokenOut * BPS <
        soldCollateralValue * BigInt(market.launchPolicy.minEntryValueBps)
    ) {
      fail(
        'POSITION_UNSAFE',
        'The guaranteed PT sale is worth too little versus the withdrawn collateral.',
      )
    }
    const post = deriveDecreasePost({
      market,
      position: accruedSnapshot.position,
      accrued: accruedSnapshot.accrued,
      repayShares,
      collateralToSell,
      maxRepaySharePriceE27: bounds.maxRepaySharePriceE27,
    })
    if (post.leverageWad <= args.targetLeverageWad) {
      assertAdjustmentOutcome({
        market,
        targetLeverageWad: args.targetLeverageWad,
        current,
        post,
        direction: 'decrease',
      })
      finalQuote = quoteResult
      finalBounds = bounds
      finalPost = post
      break
    }
    const maximumTargetDebt =
      post.collateralLoanValue * (args.targetLeverageWad - WAD) /
        args.targetLeverageWad
    const maximumRemainingShares =
      maximumTargetDebt * RAY / bounds.maxRepaySharePriceE27
    let nextRepayShares =
      accruedSnapshot.position.borrowShares - maximumRemainingShares
    let nextCollateralToSell = collateralToSell
    // A larger exact-share repayment also needs a larger PT sale. Refine both
    // together using only the already-validated quote's guaranteed rate, then
    // request a fresh exact-amount route on the next outer attempt. This avoids
    // spending two API calls on every fixed-point step while the fresh quote
    // and conservative post-state checks remain authoritative.
    for (
      let refinement = 0;
      refinement < MAX_ADJUSTMENT_FIXED_POINT_STEPS;
      refinement += 1
    ) {
      if (
        nextRepayShares <= repayShares ||
        nextRepayShares >= accruedSnapshot.position.borrowShares
      ) {
        break
      }
      const nextBounds = deriveExitRepaymentBounds(
        accruedSnapshot.accrued,
        nextRepayShares,
        market,
      )
      nextCollateralToSell = ceilDiv(
        collateralToSell * (nextBounds.repaymentCapAssets + 1n) * (BPS + 100n),
        quoteResult.route.minLoanTokenOut * BPS,
      ) + 1n
      if (nextCollateralToSell >= accruedSnapshot.position.collateral) break
      const nextCollateralLoanValue =
        (accruedSnapshot.position.collateral - nextCollateralToSell) *
          accruedSnapshot.accrued.oraclePrice /
          ORACLE_PRICE_SCALE
      const refinedMaximumTargetDebt =
        nextCollateralLoanValue * (args.targetLeverageWad - WAD) /
          args.targetLeverageWad
      const refinedMaximumRemainingShares =
        refinedMaximumTargetDebt * RAY / nextBounds.maxRepaySharePriceE27
      const refinedRepayShares =
        accruedSnapshot.position.borrowShares - refinedMaximumRemainingShares
      if (refinedRepayShares <= nextRepayShares) break
      nextRepayShares = refinedRepayShares
    }
    if (
      nextRepayShares <= repayShares ||
      nextRepayShares >= accruedSnapshot.position.borrowShares ||
      nextCollateralToSell >= accruedSnapshot.position.collateral
    ) {
      break
    }
    repayShares = nextRepayShares
    collateralToSell = nextCollateralToSell
  }
  if (finalQuote === undefined || finalBounds === undefined || finalPost === undefined) {
    fail(
      'POSITION_UNSAFE',
      'A conservative leverage decrease could not be quoted within four attempts.',
    )
  }
  const validUntilMs =
    finalQuote.quotedAtMs + market.launchPolicy.quoteValidityMs
  if (!Number.isFinite(finalQuote.quotedAtMs) || now() >= validUntilMs) {
    fail('QUOTE_EXPIRED', 'Pendle decrease quote expired during preflight.')
  }
  const minimumReturnedAssets =
    finalQuote.route.minLoanTokenOut - finalBounds.repaymentCapAssets
  if (minimumReturnedAssets <= 0n) {
    fail('ROUTE_NOT_ALLOWED', 'The decrease route does not cover its repayment bound.')
  }
  const deadline = staticSnapshot.wiring.blockTimestamp +
    market.launchPolicy.authorizationLifetimeSeconds
  const authorizationRequests = Object.freeze([
    Object.freeze(makeAuthorizationRequest({
      market,
      owner,
      nonce: staticSnapshot.wiring.nonce,
      deadline,
      isAuthorized: true,
      operation: 'exit',
    })),
    Object.freeze(makeAuthorizationRequest({
      market,
      owner,
      nonce: staticSnapshot.wiring.nonce + 1n,
      deadline,
      isAuthorized: false,
      operation: 'exit',
    })),
  ]) as LoopingDecreaseExecutionPreview['authorizationRequests']
  const preview: LoopingDecreaseExecutionPreview = {
    kind: 'decrease-preview',
    owner,
    market,
    targetLeverageWad: args.targetLeverageWad,
    repayShares,
    collateralToSell,
    quotedAtMs: finalQuote.quotedAtMs,
    validUntilMs,
    minimumReturnedAssets,
    position: Object.freeze({ ...accruedSnapshot.position }),
    accrued: Object.freeze({ ...accruedSnapshot.accrued }),
    bounds: Object.freeze(finalBounds),
    quote: Object.freeze(finalQuote.route),
    current: Object.freeze(current),
    conservativePost: Object.freeze(finalPost),
    authorizationRequests,
    wiring: Object.freeze({
      ...staticSnapshot.wiring,
      tokensIn: Object.freeze([...staticSnapshot.wiring.tokensIn]),
      tokensOut: Object.freeze([...staticSnapshot.wiring.tokensOut]),
      kyberExecutorCodeHashes: Object.freeze({
        ...staticSnapshot.wiring.kyberExecutorCodeHashes,
      }),
    }),
  }
  Object.freeze(preview)
  preparedDecreasePreviews.add(preview)
  return preview
}

export async function prepareLoopingIncreaseExecution(
  args: LoopingIncreaseExecutionInput,
): Promise<LoopingIncreaseExecutionPreview> {
  return prepareLoopingIncreaseExecutionCore(args)
}

export async function prepareLoopingDecreaseExecution(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  targetLeverageWad: bigint
  fetcher?: LoopingFetcher
  now?: () => number
}): Promise<LoopingDecreaseExecutionPreview> {
  return prepareLoopingDecreaseExecutionCore(args)
}

export async function prepareLoopingAdjustmentExecution(
  args: LoopingAdjustmentExecutionInput,
): Promise<LoopingIncreaseExecutionPreview | LoopingDecreaseExecutionPreview> {
  resolveLoopingAcquisitionMode(args.acquisitionMode)
  const preflight = await readLoopingAdjustmentPreflight(args)
  if (args.targetLeverageWad === preflight.current.leverageWad) {
    fail('NO_OP', 'The requested leverage already matches the live position.')
  }
  return args.targetLeverageWad > preflight.current.leverageWad
    ? prepareLoopingIncreaseExecutionCore(args, preflight)
    : prepareLoopingDecreaseExecutionCore(args, preflight)
}

function bundlerCall(
  to: Address,
  data: Hex,
  callbackData?: Hex,
): LoopingBundlerCall {
  return {
    to,
    data,
    value: 0n,
    skipRevert: false,
    callbackHash: callbackData === undefined
      ? zeroHash
      : keccak256(callbackData),
  }
}

async function parseAndVerifyAuthorizationSignature(args: {
  request: Readonly<LoopingAuthorizationRequest>
  signature: Hex
  owner: Address
}): Promise<{ v: number; r: Hex; s: Hex }> {
  let recovered: Address
  try {
    recovered = await recoverAddress({
      hash: args.request.digest,
      signature: args.signature,
    })
  } catch (error) {
    fail('INVALID_SIGNATURE', 'Morpho authorization signature is malformed.', error)
  }
  if (!sameAddress(recovered, args.owner)) {
    fail('INVALID_SIGNATURE', 'Morpho authorization signature has the wrong signer.')
  }
  const parsed = parseSignature(args.signature)
  if (parsed.v === undefined) {
    fail('INVALID_SIGNATURE', 'Morpho authorization signature has no v value.')
  }
  return { v: Number(parsed.v), r: parsed.r, s: parsed.s }
}

function assertBundleShape(
  data: Hex,
  expectedTargets: readonly Address[],
  callbackIndexes: readonly number[],
): void {
  const decoded = decodeFunctionData({ abi: bundler3Abi, data })
  if (
    decoded.functionName !== 'multicall' ||
    decoded.args[0].length !== expectedTargets.length
  ) {
    fail('UNSAFE_WIRING', 'Looping bundle outer shape changed.')
  }
  decoded.args[0].forEach((item, index) => {
    const expectsCallback = callbackIndexes.includes(index)
    if (
      !sameAddress(item.to, expectedTargets[index]) ||
      item.value !== 0n ||
      item.skipRevert ||
      (expectsCallback
        ? sameHex(item.callbackHash, zeroHash)
        : !sameHex(item.callbackHash, zeroHash))
    ) {
      fail('UNSAFE_WIRING', `Looping bundle call ${index} changed shape.`)
    }
  })
  const roundTrip = encodeFunctionData({
    abi: bundler3Abi,
    functionName: 'multicall',
    args: [decoded.args[0]],
  })
  if (!sameHex(roundTrip, data)) {
    fail('UNSAFE_WIRING', 'Looping bundle failed ABI round-trip validation.')
  }
}

function decodeBundleCalls(data: Hex): readonly LoopingBundlerCall[] {
  let decoded: ReturnType<typeof decodeFunctionData<typeof bundler3Abi>>
  try {
    decoded = decodeFunctionData({ abi: bundler3Abi, data })
  } catch (error) {
    fail('UNSAFE_WIRING', 'Looping bundle calldata is malformed.', error)
  }
  if (decoded.functionName !== 'multicall') {
    fail('UNSAFE_WIRING', 'Looping transaction is not a Bundler3 multicall.')
  }
  return decoded.args[0].map((call) => ({
    to: getAddress(call.to),
    data: call.data,
    value: call.value,
    skipRevert: call.skipRevert,
    callbackHash: call.callbackHash,
  }))
}

function sameBundlerCall(
  left: Readonly<LoopingBundlerCall>,
  right: Readonly<LoopingBundlerCall>,
): boolean {
  return sameAddress(left.to, right.to) &&
    sameHex(left.data, right.data) &&
    left.value === right.value &&
    left.skipRevert === right.skipRevert &&
    sameHex(left.callbackHash, right.callbackHash)
}

function assertExactCalls(
  actual: readonly Readonly<LoopingBundlerCall>[],
  expected: readonly Readonly<LoopingBundlerCall>[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((call, index) => !sameBundlerCall(call, expected[index]))
  ) {
    fail('UNSAFE_WIRING', `${label} calldata no longer matches its signed preview.`)
  }
}

function assertAuthorizationPair(
  requests: readonly [
    Readonly<LoopingAuthorizationRequest>,
    Readonly<LoopingAuthorizationRequest>,
  ],
  operation: 'entry' | 'exit',
): void {
  const [authorizeRequest, revokeRequest] = requests
  if (
    authorizeRequest.purpose !== `authorize-${operation}` ||
    revokeRequest.purpose !== `revoke-${operation}` ||
    !authorizeRequest.message.isAuthorized ||
    revokeRequest.message.isAuthorized ||
    revokeRequest.message.nonce !== authorizeRequest.message.nonce + 1n ||
    revokeRequest.message.deadline !== authorizeRequest.message.deadline
  ) {
    fail('UNSAFE_WIRING', 'Morpho authorization nonce pair changed shape.')
  }
}

function buildEntryActionCalls(
  preview: Readonly<LoopingEntryExecutionPreview>,
): readonly LoopingBundlerCall[] {
  const market = preview.market
  const params = market.morphoMarketParams
  const callback = [
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'morphoBorrow',
        args: [
          params,
          preview.borrowAssets,
          0n,
          preview.bounds.minBorrowSharePriceE27,
          market.contracts.bundler3,
        ],
      }),
    ),
    bundlerCall(
      params.loanToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, preview.borrowAssets],
      }),
    ),
    bundlerCall(market.contracts.pendleRouter, preview.quotes.loop.calldata),
    bundlerCall(
      params.loanToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, 0n],
      }),
    ),
  ]
  const callbackData = encodeAbiParameters(
    bundler3CallArrayParameters,
    [callback],
  )
  return [
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'erc20TransferFrom',
        args: [params.loanToken, market.contracts.bundler3, preview.equityAssets],
      }),
    ),
    bundlerCall(
      params.loanToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, preview.equityAssets],
      }),
    ),
    bundlerCall(market.contracts.pendleRouter, preview.quotes.initial.calldata),
    bundlerCall(
      params.loanToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, 0n],
      }),
    ),
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'morphoSupplyCollateral',
        args: [params, preview.quotes.minimumCollateral, preview.owner, callbackData],
      }),
      callbackData,
    ),
    ...(preview.acquisitionMode === 'mint'
      ? [
          bundlerCall(
            market.contracts.generalAdapter1,
            encodeFunctionData({
              abi: generalAdapter1Abi,
              functionName: 'erc20Transfer',
              args: [preview.yieldToken, preview.owner, maxUint256],
            }),
          ),
        ]
      : []),
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'erc20Transfer',
        args: [params.collateralToken, preview.owner, maxUint256],
      }),
    ),
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'erc20Transfer',
        args: [params.loanToken, preview.owner, maxUint256],
      }),
    ),
    bundlerCall(
      params.collateralToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, 0n],
      }),
    ),
  ]
}

function buildExitActionCalls(
  preview: Readonly<LoopingExitExecutionPreview>,
): readonly LoopingBundlerCall[] {
  const market = preview.market
  const params = market.morphoMarketParams
  const callback = [
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'morphoWithdrawCollateral',
        args: [params, preview.position.collateral, market.contracts.bundler3],
      }),
    ),
    bundlerCall(
      params.collateralToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, preview.position.collateral],
      }),
    ),
    bundlerCall(market.contracts.pendleRouter, preview.quote.calldata),
    bundlerCall(
      params.collateralToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, 0n],
      }),
    ),
  ]
  const callbackData = encodeAbiParameters(
    bundler3CallArrayParameters,
    [callback],
  )
  return [
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'morphoRepay',
        args: [
          params,
          0n,
          preview.position.borrowShares,
          preview.bounds.maxRepaySharePriceE27,
          preview.owner,
          callbackData,
        ],
      }),
      callbackData,
    ),
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'erc20Transfer',
        args: [params.loanToken, preview.owner, maxUint256],
      }),
    ),
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'erc20Transfer',
        args: [params.collateralToken, preview.owner, maxUint256],
      }),
    ),
  ]
}

function buildIncreaseActionCalls(
  preview: Readonly<LoopingIncreaseExecutionPreview>,
): readonly LoopingBundlerCall[] {
  const market = preview.market
  const params = market.morphoMarketParams
  const callback = [
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'morphoBorrow',
        args: [
          params,
          preview.borrowAssets,
          0n,
          preview.bounds.minBorrowSharePriceE27,
          market.contracts.bundler3,
        ],
      }),
    ),
    bundlerCall(
      params.loanToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, preview.borrowAssets],
      }),
    ),
    bundlerCall(market.contracts.pendleRouter, preview.quote.calldata),
    bundlerCall(
      params.loanToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, 0n],
      }),
    ),
  ]
  const callbackData = encodeAbiParameters(
    bundler3CallArrayParameters,
    [callback],
  )
  return [
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'morphoSupplyCollateral',
        args: [params, preview.quote.minPtOut, preview.owner, callbackData],
      }),
      callbackData,
    ),
    ...(preview.acquisitionMode === 'mint'
      ? [
          bundlerCall(
            market.contracts.generalAdapter1,
            encodeFunctionData({
              abi: generalAdapter1Abi,
              functionName: 'erc20Transfer',
              args: [preview.yieldToken, preview.owner, maxUint256],
            }),
          ),
        ]
      : []),
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'erc20Transfer',
        args: [params.collateralToken, preview.owner, maxUint256],
      }),
    ),
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'erc20Transfer',
        args: [params.loanToken, preview.owner, maxUint256],
      }),
    ),
    bundlerCall(
      params.collateralToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, 0n],
      }),
    ),
  ]
}

function buildDecreaseActionCalls(
  preview: Readonly<LoopingDecreaseExecutionPreview>,
): readonly LoopingBundlerCall[] {
  const market = preview.market
  const params = market.morphoMarketParams
  const callback = [
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'morphoWithdrawCollateral',
        args: [params, preview.collateralToSell, market.contracts.bundler3],
      }),
    ),
    bundlerCall(
      params.collateralToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, preview.collateralToSell],
      }),
    ),
    bundlerCall(market.contracts.pendleRouter, preview.quote.calldata),
    bundlerCall(
      params.collateralToken,
      encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.pendleRouter, 0n],
      }),
    ),
  ]
  const callbackData = encodeAbiParameters(
    bundler3CallArrayParameters,
    [callback],
  )
  return [
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'morphoRepay',
        args: [
          params,
          0n,
          preview.repayShares,
          preview.bounds.maxRepaySharePriceE27,
          preview.owner,
          callbackData,
        ],
      }),
      callbackData,
    ),
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'erc20Transfer',
        args: [params.loanToken, preview.owner, maxUint256],
      }),
    ),
    bundlerCall(
      market.contracts.generalAdapter1,
      encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: 'erc20Transfer',
        args: [params.collateralToken, preview.owner, maxUint256],
      }),
    ),
  ]
}

function encodeBundle(calls: readonly LoopingBundlerCall[]): Hex {
  return encodeFunctionData({
    abi: bundler3Abi,
    functionName: 'multicall',
    args: [calls],
  })
}

export function getLoopingAuthorizationStorageSlot(
  owner: Address,
  market: Readonly<LoopingExecutionMarket>,
): Hex {
  const canonical = canonicalExecutionMarket(market)
  const innerSlot = keccak256(
    encodeAbiParameters(nestedAddressMappingParameters, [
      getAddress(owner),
      MORPHO_IS_AUTHORIZED_MAPPING_SLOT,
    ]),
  )
  return keccak256(
    encodeAbiParameters(nestedAddressMappingSlotParameters, [
      canonical.contracts.generalAdapter1,
      innerSlot,
    ]),
  )
}

function makeUnsignedSimulationIntent(args: {
  operation: 'entry' | 'exit'
  acquisitionMode?: LoopingAcquisitionMode
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  calls: readonly LoopingBundlerCall[]
  startingNonce: bigint
  quotedAtMs: number
  validUntilMs: number
}): UnsignedLoopingSimulationIntent {
  const slot = getLoopingAuthorizationStorageSlot(args.owner, args.market)
  const authorizedValue = toHex(1n, { size: 32 })
  const expectedResult = toHex(1n, { size: 32 })
  const data = encodeBundle(args.calls)
  const authorizationProbe = encodeFunctionData({
    abi: morphoBlueAbi,
    functionName: 'isAuthorized',
    args: [args.owner, args.market.contracts.generalAdapter1],
  })
  const intent = Object.freeze({
    kind: `unsigned-${args.operation}-simulation`,
    operation: args.operation,
    acquisitionMode: args.acquisitionMode ?? null,
    chainId: args.market.chainId,
    owner: args.owner,
    account: args.owner,
    marketId: args.market.marketId,
    to: args.market.contracts.bundler3,
    data,
    value: 0n,
    calls: Object.freeze([...args.calls]),
    startingNonce: args.startingNonce,
    quotedAtMs: args.quotedAtMs,
    validUntilMs: args.validUntilMs,
    stateOverride: Object.freeze([
      Object.freeze({
        address: args.market.contracts.morpho,
        stateDiff: Object.freeze([
          Object.freeze({ slot, value: authorizedValue }),
        ]) as LoopingStateOverrideIntent['stateDiff'],
      }),
    ]) as UnsignedLoopingSimulationIntent['stateOverride'],
    authorizationProbe: Object.freeze({
      to: args.market.contracts.morpho,
      data: authorizationProbe,
      expectedResult,
    }),
    requiredRuntimeCodeHashes: Object.freeze({
      ...args.market.runtimeCodePolicy,
    }),
  }) as UnsignedLoopingSimulationIntent
  preparedSimulationIntents.add(intent)
  return intent
}

function fingerprintUnsignedSimulationIntent(
  intent: Readonly<UnsignedLoopingSimulationIntent>,
): Hex {
  const override = intent.stateOverride[0]
  const stateDiff = override.stateDiff[0]
  return keccak256(encodeAbiParameters(simulationFingerprintParameters, [
    BigInt(intent.chainId),
    intent.account,
    intent.marketId,
    intent.acquisitionMode === 'market'
      ? 0
      : intent.acquisitionMode === 'mint'
        ? 1
        : 2,
    intent.to,
    intent.data,
    stateDiff.slot,
    stateDiff.value,
  ]))
}

export async function simulateUnsignedLoopingIntent(args: {
  client: PublicClient
  intent: Readonly<UnsignedLoopingSimulationIntent>
  blockNumber?: bigint
}): Promise<LoopingUnsignedSimulationEvidence> {
  if (!preparedSimulationIntents.has(args.intent)) {
    fail('STATE_CONFLICT', 'Unsigned simulation requires this compiler\'s live intent.')
  }
  const market = getLoopingExecutionMarket(args.intent.chainId, args.intent.marketId)
  if (
    !sameAddress(args.intent.owner, args.intent.account) ||
    !sameAddress(args.intent.to, market.contracts.bundler3)
  ) {
    fail('UNSAFE_WIRING', 'Unsigned simulation sender or target changed.')
  }
  const [chainId, block] = await Promise.all([
    args.client.getChainId(),
    args.client.getBlock(args.blockNumber === undefined
      ? { blockTag: 'latest' }
      : { blockNumber: args.blockNumber }),
  ])
  if (chainId !== market.chainId || block.number === null || block.hash === null) {
    fail('UNSUPPORTED_CHAIN', 'Unsigned simulation could not pin the reviewed chain block.')
  }
  await assertPinnedRuntimeCodeHashes({
    client: args.client,
    market,
    blockNumber: block.number,
    includeMint: args.intent.acquisitionMode === 'mint',
  })
  const stateOverride = args.intent.stateOverride.map((override) => ({
    address: override.address,
    stateDiff: override.stateDiff.map((item) => ({ ...item })),
  }))
  let probeResult: Awaited<ReturnType<PublicClient['call']>>
  let actionResult: Awaited<ReturnType<PublicClient['call']>>
  try {
    ;[probeResult, actionResult] = await Promise.all([
      args.client.call({
        account: args.intent.account,
        to: args.intent.authorizationProbe.to,
        data: args.intent.authorizationProbe.data,
        value: 0n,
        stateOverride,
        blockNumber: block.number,
      }),
      args.client.call({
        account: args.intent.account,
        to: args.intent.to,
        data: args.intent.data,
        value: args.intent.value,
        stateOverride,
        blockNumber: block.number,
      }),
    ])
  } catch (error) {
    fail('SIMULATION_FAILED', 'Unsigned looping action simulation reverted.', error)
  }
  if (
    probeResult.data === undefined ||
    !sameHex(probeResult.data, args.intent.authorizationProbe.expectedResult)
  ) {
    fail('SIMULATION_FAILED', 'State-override simulation did not prove adapter authorization.')
  }
  // viem represents a successful `eth_call` whose EVM return is `0x` as
  // `{ data: undefined }`. Bundler3.multicall returns no value, so normalize
  // that successful void result without weakening the authorization probe.
  const normalizedActionResult = actionResult.data ?? '0x'
  const evidence = Object.freeze({
    kind: `verified-unsigned-${args.intent.operation}-simulation`,
    operation: args.intent.operation,
    acquisitionMode: args.intent.acquisitionMode,
    owner: args.intent.owner,
    marketId: args.intent.marketId,
    intentFingerprint: fingerprintUnsignedSimulationIntent(args.intent),
    blockNumber: block.number,
    blockHash: block.hash,
    actionResult: normalizedActionResult,
    requiredRuntimeCodeHashes: Object.freeze({
      ...args.intent.requiredRuntimeCodeHashes,
    }),
  }) as LoopingUnsignedSimulationEvidence
  verifiedSimulationEvidence.add(evidence)
  return evidence
}

export function buildUnsignedLoopingEntrySimulation(
  preview: Readonly<LoopingEntryExecutionPreview>,
  now: () => number = Date.now,
): UnsignedLoopingSimulationIntent {
  if (!preparedEntryPreviews.has(preview)) {
    fail(
      'STATE_CONFLICT',
      'Unsigned entry simulation requires an in-memory preview produced by this compiler.',
    )
  }
  const market = canonicalExecutionMarket(preview.market)
  if (now() >= preview.validUntilMs) {
    fail('QUOTE_EXPIRED', 'Cannot simulate an entry from expired quotes.')
  }
  if (preview.approval.needed || preview.approval.current !== preview.equityAssets) {
    fail(
      'STATE_CONFLICT',
      'Refresh preflight after the exact adapter allowance is confirmed.',
    )
  }
  assertAuthorizationPair(preview.authorizationRequests, 'entry')
  const calls = buildEntryActionCalls(preview)
  const params = market.morphoMarketParams
  const data = encodeBundle(calls)
  assertBundleShape(
    data,
    [
      market.contracts.generalAdapter1,
      params.loanToken,
      market.contracts.pendleRouter,
      params.loanToken,
      market.contracts.generalAdapter1,
      ...(preview.acquisitionMode === 'mint'
        ? [market.contracts.generalAdapter1]
        : []),
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      params.collateralToken,
    ],
    [4],
  )
  return makeUnsignedSimulationIntent({
    operation: 'entry',
    acquisitionMode: preview.acquisitionMode,
    owner: preview.owner,
    market,
    calls,
    startingNonce: preview.authorizationRequests[0].message.nonce,
    quotedAtMs: preview.quotedAtMs,
    validUntilMs: preview.validUntilMs,
  })
}

export function buildUnsignedLoopingExitSimulation(
  preview: Readonly<LoopingExitExecutionPreview>,
  now: () => number = Date.now,
): UnsignedLoopingSimulationIntent {
  if (!preparedExitPreviews.has(preview)) {
    fail(
      'STATE_CONFLICT',
      'Unsigned exit simulation requires an in-memory preview produced by this compiler.',
    )
  }
  const market = canonicalExecutionMarket(preview.market)
  if (now() >= preview.validUntilMs) {
    fail('QUOTE_EXPIRED', 'Cannot simulate an exit from an expired quote.')
  }
  assertAuthorizationPair(preview.authorizationRequests, 'exit')
  const calls = buildExitActionCalls(preview)
  const data = encodeBundle(calls)
  assertBundleShape(
    data,
    [
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
    ],
    [0],
  )
  return makeUnsignedSimulationIntent({
    operation: 'exit',
    owner: preview.owner,
    market,
    calls,
    startingNonce: preview.authorizationRequests[0].message.nonce,
    quotedAtMs: preview.quotedAtMs,
    validUntilMs: preview.validUntilMs,
  })
}

export function buildUnsignedLoopingIncreaseSimulation(
  preview: Readonly<LoopingIncreaseExecutionPreview>,
  now: () => number = Date.now,
): UnsignedLoopingSimulationIntent {
  if (!preparedIncreasePreviews.has(preview)) {
    fail(
      'STATE_CONFLICT',
      'Unsigned increase simulation requires this compiler\'s live preview.',
    )
  }
  const market = canonicalExecutionMarket(preview.market)
  if (now() >= preview.validUntilMs) {
    fail('QUOTE_EXPIRED', 'Cannot simulate an increase from an expired quote.')
  }
  assertAuthorizationPair(preview.authorizationRequests, 'entry')
  const calls = buildIncreaseActionCalls(preview)
  const data = encodeBundle(calls)
  assertBundleShape(
    data,
    [
      market.contracts.generalAdapter1,
      ...(preview.acquisitionMode === 'mint'
        ? [market.contracts.generalAdapter1]
        : []),
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      market.morphoMarketParams.collateralToken,
    ],
    [0],
  )
  return makeUnsignedSimulationIntent({
    operation: 'entry',
    acquisitionMode: preview.acquisitionMode,
    owner: preview.owner,
    market,
    calls,
    startingNonce: preview.authorizationRequests[0].message.nonce,
    quotedAtMs: preview.quotedAtMs,
    validUntilMs: preview.validUntilMs,
  })
}

export function buildUnsignedLoopingDecreaseSimulation(
  preview: Readonly<LoopingDecreaseExecutionPreview>,
  now: () => number = Date.now,
): UnsignedLoopingSimulationIntent {
  if (!preparedDecreasePreviews.has(preview)) {
    fail(
      'STATE_CONFLICT',
      'Unsigned decrease simulation requires this compiler\'s live preview.',
    )
  }
  const market = canonicalExecutionMarket(preview.market)
  if (now() >= preview.validUntilMs) {
    fail('QUOTE_EXPIRED', 'Cannot simulate a decrease from an expired quote.')
  }
  assertAuthorizationPair(preview.authorizationRequests, 'exit')
  const calls = buildDecreaseActionCalls(preview)
  const data = encodeBundle(calls)
  assertBundleShape(
    data,
    [
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
    ],
    [0],
  )
  return makeUnsignedSimulationIntent({
    operation: 'exit',
    owner: preview.owner,
    market,
    calls,
    startingNonce: preview.authorizationRequests[0].message.nonce,
    quotedAtMs: preview.quotedAtMs,
    validUntilMs: preview.validUntilMs,
  })
}

/**
 * Assemble the reviewed entry transaction entirely offline.
 *
 * Never send the resulting signed calldata to an RPC for `eth_call`: the two
 * Morpho signatures are independently usable. Simulate only the signature-free
 * intent, revalidate its branded evidence, then hand this bundle directly to
 * the connected wallet for immediate final broadcast.
 */
export async function buildSignedLoopingEntryBundle(
  preview: Readonly<LoopingEntryExecutionPreview>,
  authorizeSignature: Hex,
  revokeSignature: Hex,
  now: () => number = Date.now,
): Promise<SignedLoopingEntryBundle> {
  if (!preparedEntryPreviews.has(preview)) {
    fail(
      'STATE_CONFLICT',
      'Signed entry bundles require an in-memory preview produced by this compiler.',
    )
  }
  const market = canonicalExecutionMarket(preview.market)
  if (now() >= preview.validUntilMs) {
    fail('QUOTE_EXPIRED', 'Cannot assemble an entry bundle from expired quotes.')
  }
  if (preview.approval.needed || preview.approval.current !== preview.equityAssets) {
    fail(
      'STATE_CONFLICT',
      'Refresh preflight after the exact adapter allowance is confirmed.',
    )
  }
  const [authorizeRequest, revokeRequest] = preview.authorizationRequests
  assertAuthorizationPair(preview.authorizationRequests, 'entry')
  const [authorize, revoke] = await Promise.all([
    parseAndVerifyAuthorizationSignature({
      request: authorizeRequest,
      signature: authorizeSignature,
      owner: preview.owner,
    }),
    parseAndVerifyAuthorizationSignature({
      request: revokeRequest,
      signature: revokeSignature,
      owner: preview.owner,
    }),
  ])
  const params = market.morphoMarketParams
  const actionCalls = buildEntryActionCalls(preview)
  const calls = [
    bundlerCall(
      market.contracts.morpho,
      encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorizationWithSig',
        args: [authorizeRequest.message, authorize],
      }),
    ),
    ...actionCalls,
    bundlerCall(
      market.contracts.morpho,
      encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorizationWithSig',
        args: [revokeRequest.message, revoke],
      }),
    ),
  ] as const
  const data = encodeBundle(calls)
  assertBundleShape(
    data,
    [
      market.contracts.morpho,
      market.contracts.generalAdapter1,
      params.loanToken,
      market.contracts.pendleRouter,
      params.loanToken,
      market.contracts.generalAdapter1,
      ...(preview.acquisitionMode === 'mint'
        ? [market.contracts.generalAdapter1]
        : []),
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      params.collateralToken,
      market.contracts.morpho,
    ],
    [5],
  )
  return {
    kind: 'signed-entry-bundle',
    acquisitionMode: preview.acquisitionMode,
    yieldToken: preview.yieldToken,
    minimumYtOut: preview.minimumYtOut,
    expectedYtOut: preview.expectedYtOut,
    owner: preview.owner,
    marketId: market.marketId,
    to: market.contracts.bundler3,
    data,
    value: 0n,
    calls,
    startingNonce: authorizeRequest.message.nonce,
    deadline: authorizeRequest.message.deadline,
    quotedAtMs: preview.quotedAtMs,
    validUntilMs: preview.validUntilMs,
    minimumCollateral: preview.quotes.minimumCollateral,
    maxBorrowShares: preview.bounds.maxBorrowShares,
  }
}

export async function buildSignedLoopingExitBundle(
  preview: Readonly<LoopingExitExecutionPreview>,
  authorizeSignature: Hex,
  revokeSignature: Hex,
  now: () => number = Date.now,
): Promise<SignedLoopingExitBundle> {
  if (!preparedExitPreviews.has(preview)) {
    fail(
      'STATE_CONFLICT',
      'Signed exit bundles require an in-memory preview produced by this compiler.',
    )
  }
  const market = canonicalExecutionMarket(preview.market)
  if (now() >= preview.validUntilMs) {
    fail('QUOTE_EXPIRED', 'Cannot assemble an exit bundle from an expired quote.')
  }
  assertAuthorizationPair(preview.authorizationRequests, 'exit')
  const [authorizeRequest, revokeRequest] = preview.authorizationRequests
  const [authorize, revoke] = await Promise.all([
    parseAndVerifyAuthorizationSignature({
      request: authorizeRequest,
      signature: authorizeSignature,
      owner: preview.owner,
    }),
    parseAndVerifyAuthorizationSignature({
      request: revokeRequest,
      signature: revokeSignature,
      owner: preview.owner,
    }),
  ])
  const actionCalls = buildExitActionCalls(preview)
  const calls = [
    bundlerCall(
      market.contracts.morpho,
      encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorizationWithSig',
        args: [authorizeRequest.message, authorize],
      }),
    ),
    ...actionCalls,
    bundlerCall(
      market.contracts.morpho,
      encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorizationWithSig',
        args: [revokeRequest.message, revoke],
      }),
    ),
  ] as const
  const data = encodeBundle(calls)
  assertBundleShape(
    data,
    [
      market.contracts.morpho,
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      market.contracts.morpho,
    ],
    [1],
  )
  return {
    kind: 'signed-exit-bundle',
    owner: preview.owner,
    marketId: market.marketId,
    to: market.contracts.bundler3,
    data,
    value: 0n,
    calls,
    startingNonce: authorizeRequest.message.nonce,
    deadline: authorizeRequest.message.deadline,
    quotedAtMs: preview.quotedAtMs,
    validUntilMs: preview.validUntilMs,
    exactBorrowShares: preview.position.borrowShares,
    exactCollateral: preview.position.collateral,
    repaymentCapAssets: preview.bounds.repaymentCapAssets,
    minimumReturnedAssets: preview.minimumReturnedAssets,
  }
}

export async function buildSignedLoopingIncreaseBundle(
  preview: Readonly<LoopingIncreaseExecutionPreview>,
  authorizeSignature: Hex,
  revokeSignature: Hex,
  now: () => number = Date.now,
): Promise<SignedLoopingIncreaseBundle> {
  if (!preparedIncreasePreviews.has(preview)) {
    fail(
      'STATE_CONFLICT',
      'Signed increase bundles require this compiler\'s live preview.',
    )
  }
  const market = canonicalExecutionMarket(preview.market)
  if (now() >= preview.validUntilMs) {
    fail('QUOTE_EXPIRED', 'Cannot assemble an increase bundle from an expired quote.')
  }
  assertAuthorizationPair(preview.authorizationRequests, 'entry')
  const [authorizeRequest, revokeRequest] = preview.authorizationRequests
  const [authorize, revoke] = await Promise.all([
    parseAndVerifyAuthorizationSignature({
      request: authorizeRequest,
      signature: authorizeSignature,
      owner: preview.owner,
    }),
    parseAndVerifyAuthorizationSignature({
      request: revokeRequest,
      signature: revokeSignature,
      owner: preview.owner,
    }),
  ])
  const actionCalls = buildIncreaseActionCalls(preview)
  const calls = [
    bundlerCall(
      market.contracts.morpho,
      encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorizationWithSig',
        args: [authorizeRequest.message, authorize],
      }),
    ),
    ...actionCalls,
    bundlerCall(
      market.contracts.morpho,
      encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorizationWithSig',
        args: [revokeRequest.message, revoke],
      }),
    ),
  ] as const
  const data = encodeBundle(calls)
  assertBundleShape(
    data,
    [
      market.contracts.morpho,
      market.contracts.generalAdapter1,
      ...(preview.acquisitionMode === 'mint'
        ? [market.contracts.generalAdapter1]
        : []),
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      market.morphoMarketParams.collateralToken,
      market.contracts.morpho,
    ],
    [1],
  )
  return {
    kind: 'signed-increase-bundle',
    acquisitionMode: preview.acquisitionMode,
    yieldToken: preview.yieldToken,
    minimumYtOut: preview.minimumYtOut,
    expectedYtOut: preview.expectedYtOut,
    owner: preview.owner,
    marketId: market.marketId,
    to: market.contracts.bundler3,
    data,
    value: 0n,
    calls,
    startingNonce: authorizeRequest.message.nonce,
    deadline: authorizeRequest.message.deadline,
    quotedAtMs: preview.quotedAtMs,
    validUntilMs: preview.validUntilMs,
    targetLeverageWad: preview.targetLeverageWad,
    borrowAssets: preview.borrowAssets,
    startingBorrowShares: preview.position.borrowShares,
    startingCollateral: preview.position.collateral,
    minimumAddedCollateral: preview.quote.minPtOut,
    maxAddedBorrowShares: preview.bounds.maxBorrowShares,
  }
}

export async function buildSignedLoopingDecreaseBundle(
  preview: Readonly<LoopingDecreaseExecutionPreview>,
  authorizeSignature: Hex,
  revokeSignature: Hex,
  now: () => number = Date.now,
): Promise<SignedLoopingDecreaseBundle> {
  if (!preparedDecreasePreviews.has(preview)) {
    fail(
      'STATE_CONFLICT',
      'Signed decrease bundles require this compiler\'s live preview.',
    )
  }
  const market = canonicalExecutionMarket(preview.market)
  if (now() >= preview.validUntilMs) {
    fail('QUOTE_EXPIRED', 'Cannot assemble a decrease bundle from an expired quote.')
  }
  assertAuthorizationPair(preview.authorizationRequests, 'exit')
  const [authorizeRequest, revokeRequest] = preview.authorizationRequests
  const [authorize, revoke] = await Promise.all([
    parseAndVerifyAuthorizationSignature({
      request: authorizeRequest,
      signature: authorizeSignature,
      owner: preview.owner,
    }),
    parseAndVerifyAuthorizationSignature({
      request: revokeRequest,
      signature: revokeSignature,
      owner: preview.owner,
    }),
  ])
  const actionCalls = buildDecreaseActionCalls(preview)
  const calls = [
    bundlerCall(
      market.contracts.morpho,
      encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorizationWithSig',
        args: [authorizeRequest.message, authorize],
      }),
    ),
    ...actionCalls,
    bundlerCall(
      market.contracts.morpho,
      encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorizationWithSig',
        args: [revokeRequest.message, revoke],
      }),
    ),
  ] as const
  const data = encodeBundle(calls)
  assertBundleShape(
    data,
    [
      market.contracts.morpho,
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      market.contracts.generalAdapter1,
      market.contracts.morpho,
    ],
    [1],
  )
  return {
    kind: 'signed-decrease-bundle',
    owner: preview.owner,
    marketId: market.marketId,
    to: market.contracts.bundler3,
    data,
    value: 0n,
    calls,
    startingNonce: authorizeRequest.message.nonce,
    deadline: authorizeRequest.message.deadline,
    quotedAtMs: preview.quotedAtMs,
    validUntilMs: preview.validUntilMs,
    targetLeverageWad: preview.targetLeverageWad,
    startingBorrowShares: preview.position.borrowShares,
    startingCollateral: preview.position.collateral,
    exactRepayShares: preview.repayShares,
    exactCollateralToSell: preview.collateralToSell,
    repaymentCapAssets: preview.bounds.repaymentCapAssets,
    minimumReturnedAssets: preview.minimumReturnedAssets,
  }
}

async function assertSignedEntryBundleBindsPreview(
  preview: Readonly<LoopingEntryExecutionPreview>,
  bundle: Readonly<SignedLoopingEntryBundle>,
): Promise<void> {
  const market = canonicalExecutionMarket(preview.market)
  if (
    bundle.kind !== 'signed-entry-bundle' ||
    bundle.acquisitionMode !== preview.acquisitionMode ||
    !sameNullableAddress(bundle.yieldToken, preview.yieldToken) ||
    bundle.minimumYtOut !== preview.minimumYtOut ||
    bundle.expectedYtOut !== preview.expectedYtOut ||
    !sameAddress(bundle.owner, preview.owner) ||
    !sameHex(bundle.marketId, market.marketId) ||
    !sameAddress(bundle.to, market.contracts.bundler3) ||
    bundle.value !== 0n ||
    bundle.startingNonce !== preview.authorizationRequests[0].message.nonce ||
    bundle.deadline !== preview.authorizationRequests[0].message.deadline ||
    bundle.quotedAtMs !== preview.quotedAtMs ||
    bundle.validUntilMs !== preview.validUntilMs ||
    bundle.minimumCollateral !== preview.quotes.minimumCollateral ||
    bundle.maxBorrowShares !== preview.bounds.maxBorrowShares
  ) {
    fail('STATE_CONFLICT', 'Signed entry metadata no longer matches its preview.')
  }
  const pair = await decodeExposedLoopingAuthorizationPair({
    market,
    owner: preview.owner,
    bundleData: bundle.data,
  })
  if (
    pair.operation !== 'entry' ||
    pair.startingNonce !== bundle.startingNonce ||
    pair.deadline !== bundle.deadline
  ) {
    fail('STATE_CONFLICT', 'Signed entry authorization pair changed.')
  }
  const decodedCalls = decodeBundleCalls(bundle.data)
  assertExactCalls(decodedCalls, bundle.calls, 'Signed entry bundle')
  assertExactCalls(
    decodedCalls.slice(1, -1),
    buildEntryActionCalls(preview),
    'Signed entry action',
  )
}

async function assertSignedExitBundleBindsPreview(
  preview: Readonly<LoopingExitExecutionPreview>,
  bundle: Readonly<SignedLoopingExitBundle>,
): Promise<void> {
  const market = canonicalExecutionMarket(preview.market)
  if (
    bundle.kind !== 'signed-exit-bundle' ||
    !sameAddress(bundle.owner, preview.owner) ||
    !sameHex(bundle.marketId, market.marketId) ||
    !sameAddress(bundle.to, market.contracts.bundler3) ||
    bundle.value !== 0n ||
    bundle.startingNonce !== preview.authorizationRequests[0].message.nonce ||
    bundle.deadline !== preview.authorizationRequests[0].message.deadline ||
    bundle.quotedAtMs !== preview.quotedAtMs ||
    bundle.validUntilMs !== preview.validUntilMs ||
    bundle.exactBorrowShares !== preview.position.borrowShares ||
    bundle.exactCollateral !== preview.position.collateral ||
    bundle.repaymentCapAssets !== preview.bounds.repaymentCapAssets ||
    bundle.minimumReturnedAssets !== preview.minimumReturnedAssets
  ) {
    fail('STATE_CONFLICT', 'Signed exit metadata no longer matches its preview.')
  }
  const pair = await decodeExposedLoopingAuthorizationPair({
    market,
    owner: preview.owner,
    bundleData: bundle.data,
  })
  if (
    pair.operation !== 'exit' ||
    pair.startingNonce !== bundle.startingNonce ||
    pair.deadline !== bundle.deadline
  ) {
    fail('STATE_CONFLICT', 'Signed exit authorization pair changed.')
  }
  const decodedCalls = decodeBundleCalls(bundle.data)
  assertExactCalls(decodedCalls, bundle.calls, 'Signed exit bundle')
  assertExactCalls(
    decodedCalls.slice(1, -1),
    buildExitActionCalls(preview),
    'Signed exit action',
  )
}

async function assertSignedIncreaseBundleBindsPreview(
  preview: Readonly<LoopingIncreaseExecutionPreview>,
  bundle: Readonly<SignedLoopingIncreaseBundle>,
): Promise<void> {
  const market = canonicalExecutionMarket(preview.market)
  if (
    bundle.kind !== 'signed-increase-bundle' ||
    bundle.acquisitionMode !== preview.acquisitionMode ||
    !sameNullableAddress(bundle.yieldToken, preview.yieldToken) ||
    bundle.minimumYtOut !== preview.minimumYtOut ||
    bundle.expectedYtOut !== preview.expectedYtOut ||
    !sameAddress(bundle.owner, preview.owner) ||
    !sameHex(bundle.marketId, market.marketId) ||
    !sameAddress(bundle.to, market.contracts.bundler3) ||
    bundle.value !== 0n ||
    bundle.startingNonce !== preview.authorizationRequests[0].message.nonce ||
    bundle.deadline !== preview.authorizationRequests[0].message.deadline ||
    bundle.quotedAtMs !== preview.quotedAtMs ||
    bundle.validUntilMs !== preview.validUntilMs ||
    bundle.targetLeverageWad !== preview.targetLeverageWad ||
    bundle.borrowAssets !== preview.borrowAssets ||
    bundle.startingBorrowShares !== preview.position.borrowShares ||
    bundle.startingCollateral !== preview.position.collateral ||
    bundle.minimumAddedCollateral !== preview.quote.minPtOut ||
    bundle.maxAddedBorrowShares !== preview.bounds.maxBorrowShares
  ) {
    fail('STATE_CONFLICT', 'Signed increase metadata no longer matches its preview.')
  }
  const pair = await decodeExposedLoopingAuthorizationPair({
    market,
    owner: preview.owner,
    bundleData: bundle.data,
  })
  if (
    pair.operation !== 'entry' ||
    pair.startingNonce !== bundle.startingNonce ||
    pair.deadline !== bundle.deadline
  ) {
    fail('STATE_CONFLICT', 'Signed increase authorization pair changed.')
  }
  const decodedCalls = decodeBundleCalls(bundle.data)
  assertExactCalls(decodedCalls, bundle.calls, 'Signed increase bundle')
  assertExactCalls(
    decodedCalls.slice(1, -1),
    buildIncreaseActionCalls(preview),
    'Signed increase action',
  )
}

async function assertSignedDecreaseBundleBindsPreview(
  preview: Readonly<LoopingDecreaseExecutionPreview>,
  bundle: Readonly<SignedLoopingDecreaseBundle>,
): Promise<void> {
  const market = canonicalExecutionMarket(preview.market)
  if (
    bundle.kind !== 'signed-decrease-bundle' ||
    !sameAddress(bundle.owner, preview.owner) ||
    !sameHex(bundle.marketId, market.marketId) ||
    !sameAddress(bundle.to, market.contracts.bundler3) ||
    bundle.value !== 0n ||
    bundle.startingNonce !== preview.authorizationRequests[0].message.nonce ||
    bundle.deadline !== preview.authorizationRequests[0].message.deadline ||
    bundle.quotedAtMs !== preview.quotedAtMs ||
    bundle.validUntilMs !== preview.validUntilMs ||
    bundle.targetLeverageWad !== preview.targetLeverageWad ||
    bundle.startingBorrowShares !== preview.position.borrowShares ||
    bundle.startingCollateral !== preview.position.collateral ||
    bundle.exactRepayShares !== preview.repayShares ||
    bundle.exactCollateralToSell !== preview.collateralToSell ||
    bundle.repaymentCapAssets !== preview.bounds.repaymentCapAssets ||
    bundle.minimumReturnedAssets !== preview.minimumReturnedAssets
  ) {
    fail('STATE_CONFLICT', 'Signed decrease metadata no longer matches its preview.')
  }
  const pair = await decodeExposedLoopingAuthorizationPair({
    market,
    owner: preview.owner,
    bundleData: bundle.data,
  })
  if (
    pair.operation !== 'exit' ||
    pair.startingNonce !== bundle.startingNonce ||
    pair.deadline !== bundle.deadline
  ) {
    fail('STATE_CONFLICT', 'Signed decrease authorization pair changed.')
  }
  const decodedCalls = decodeBundleCalls(bundle.data)
  assertExactCalls(decodedCalls, bundle.calls, 'Signed decrease bundle')
  assertExactCalls(
    decodedCalls.slice(1, -1),
    buildDecreaseActionCalls(preview),
    'Signed decrease action',
  )
}

function decodeExposedAuthorizationCall(
  call: Readonly<LoopingBundlerCall>,
  market: Readonly<LoopingExecutionMarket>,
  owner: Address,
  expectedAuthorized: boolean,
): {
  message: LoopingAuthorizationMessage
  signature: { v: bigint; r: Hex; s: Hex }
} {
  if (
    !sameAddress(call.to, market.contracts.morpho) ||
    call.value !== 0n ||
    call.skipRevert ||
    !sameHex(call.callbackHash, zeroHash)
  ) {
    fail('UNSAFE_WIRING', 'Exposed authorization is not a direct Morpho call.')
  }
  let decoded: ReturnType<typeof decodeFunctionData<typeof morphoBlueAbi>>
  try {
    decoded = decodeFunctionData({ abi: morphoBlueAbi, data: call.data })
  } catch (error) {
    fail('UNSAFE_WIRING', 'Exposed authorization calldata is malformed.', error)
  }
  if (decoded.functionName !== 'setAuthorizationWithSig') {
    fail('UNSAFE_WIRING', 'Exposed bundle does not contain signed Morpho authorization.')
  }
  const [message, signature] = decoded.args
  if (
    !sameAddress(message.authorizer, owner) ||
    !sameAddress(message.authorized, market.contracts.generalAdapter1) ||
    message.isAuthorized !== expectedAuthorized
  ) {
    fail('UNSAFE_WIRING', 'Exposed authorization identity or value changed.')
  }
  return {
    message: {
      authorizer: getAddress(message.authorizer),
      authorized: getAddress(message.authorized),
      isAuthorized: message.isAuthorized,
      nonce: message.nonce,
      deadline: message.deadline,
    },
    signature: { v: BigInt(signature.v), r: signature.r, s: signature.s },
  }
}

export async function decodeExposedLoopingAuthorizationPair(args: {
  market: Readonly<LoopingExecutionMarket>
  owner: Address
  bundleData: Hex
}): Promise<ExposedLoopingAuthorizationPair> {
  const market = canonicalExecutionMarket(args.market)
  const owner = getAddress(args.owner)
  let decoded: ReturnType<typeof decodeFunctionData<typeof bundler3Abi>>
  try {
    decoded = decodeFunctionData({ abi: bundler3Abi, data: args.bundleData })
  } catch (error) {
    fail('UNSAFE_WIRING', 'Reverted transaction is not Bundler3 calldata.', error)
  }
  if (decoded.functionName !== 'multicall') {
    fail('UNSAFE_WIRING', 'Reverted transaction is not a Bundler3 multicall.')
  }
  const decodedCalls = decoded.args[0]
  const operation =
    decodedCalls.length === 10 ||
    decodedCalls.length === 11 ||
    decodedCalls.length === 6 ||
    decodedCalls.length === 7
    ? 'entry'
    : decodedCalls.length === 5
      ? 'exit'
      : undefined
  if (operation === undefined) {
    fail('UNSAFE_WIRING', 'Reverted looping bundle has an unknown call count.')
  }
  const params = market.morphoMarketParams
  const expectedTargets =
    decodedCalls.length === 10 || decodedCalls.length === 11
    ? [
        market.contracts.morpho,
        market.contracts.generalAdapter1,
        params.loanToken,
        market.contracts.pendleRouter,
        params.loanToken,
        market.contracts.generalAdapter1,
        ...(decodedCalls.length === 11
          ? [market.contracts.generalAdapter1]
          : []),
        market.contracts.generalAdapter1,
        market.contracts.generalAdapter1,
        params.collateralToken,
        market.contracts.morpho,
      ]
    : decodedCalls.length === 6 || decodedCalls.length === 7
      ? [
          market.contracts.morpho,
          market.contracts.generalAdapter1,
          ...(decodedCalls.length === 7
            ? [market.contracts.generalAdapter1]
            : []),
          market.contracts.generalAdapter1,
          market.contracts.generalAdapter1,
          params.collateralToken,
          market.contracts.morpho,
        ]
      : [
          market.contracts.morpho,
          market.contracts.generalAdapter1,
          market.contracts.generalAdapter1,
          market.contracts.generalAdapter1,
          market.contracts.morpho,
        ]
  assertBundleShape(
    args.bundleData,
    expectedTargets,
    decodedCalls.length === 10 || decodedCalls.length === 11 ? [5] : [1],
  )
  const calls = decodedCalls.map((call) => ({
    to: getAddress(call.to),
    data: call.data,
    value: call.value,
    skipRevert: call.skipRevert,
    callbackHash: call.callbackHash,
  }))
  const authorizeCall = calls[0]
  const revokeCall = calls[calls.length - 1]
  const authorize = decodeExposedAuthorizationCall(
    authorizeCall,
    market,
    owner,
    true,
  )
  const revoke = decodeExposedAuthorizationCall(
    revokeCall,
    market,
    owner,
    false,
  )
  if (
    revoke.message.nonce !== authorize.message.nonce + 1n ||
    revoke.message.deadline !== authorize.message.deadline
  ) {
    fail('UNSAFE_WIRING', 'Exposed authorization pair is not sequential.')
  }
  const authorizeRequest = makeAuthorizationRequest({
    market,
    owner,
    nonce: authorize.message.nonce,
    deadline: authorize.message.deadline,
    isAuthorized: true,
    operation,
  })
  const revokeRequest = makeAuthorizationRequest({
    market,
    owner,
    nonce: revoke.message.nonce,
    deadline: revoke.message.deadline,
    isAuthorized: false,
    operation,
  })
  const [authorizeSigner, revokeSigner] = await Promise.all([
    recoverAddress({ hash: authorizeRequest.digest, signature: authorize.signature }),
    recoverAddress({ hash: revokeRequest.digest, signature: revoke.signature }),
  ])
  if (!sameAddress(authorizeSigner, owner) || !sameAddress(revokeSigner, owner)) {
    fail('INVALID_SIGNATURE', 'Exposed Morpho authorization has the wrong signer.')
  }
  return Object.freeze({
    kind: 'exposed-authorization-pair',
    operation,
    owner,
    market,
    startingNonce: authorize.message.nonce,
    deadline: authorize.message.deadline,
    authorizeCall: Object.freeze(authorizeCall),
    revokeCall: Object.freeze(revokeCall),
  })
}

export async function readExposedLoopingAuthorizationPairFromTransaction(args: {
  client: PublicClient
  market: Readonly<LoopingExecutionMarket>
  owner: Address
  transactionHash: Hex
}): Promise<ExposedLoopingAuthorizationPair> {
  const market = canonicalExecutionMarket(args.market)
  const owner = getAddress(args.owner)
  const [chainId, transaction] = await Promise.all([
    args.client.getChainId(),
    args.client.getTransaction({ hash: args.transactionHash }),
  ])
  if (chainId !== market.chainId) {
    fail('UNSUPPORTED_CHAIN', 'Cannot recover exposed authorization on the wrong chain.')
  }
  if (
    !sameHex(transaction.hash, args.transactionHash) ||
    !sameAddress(transaction.from, owner) ||
    transaction.to === null ||
    !sameAddress(transaction.to, market.contracts.bundler3) ||
    transaction.value !== 0n
  ) {
    fail('UNSAFE_WIRING', 'Transaction identity does not match a looping bundle.')
  }
  return decodeExposedLoopingAuthorizationPair({
    market,
    owner,
    bundleData: transaction.input,
  })
}

export interface PersistedLoopingMintDeliveryEvidence {
  transactionHash: Hex
  operation: 'entry' | 'increase'
  yieldToken: Address
  minimumYtOut: bigint
}

function assertPlainBundlerCall(
  call: Readonly<LoopingBundlerCall>,
  target: Address,
  label: string,
): void {
  if (
    !sameAddress(call.to, target) ||
    call.value !== 0n ||
    call.skipRevert ||
    !sameHex(call.callbackHash, zeroHash)
  ) {
    fail('UNSAFE_WIRING', `${label} changed its Bundler3 call shape.`)
  }
}

function decodePersistedErc20Approval(args: {
  call: Readonly<LoopingBundlerCall>
  token: Address
  spender: Address
  amount: bigint
  label: string
}): void {
  assertPlainBundlerCall(args.call, args.token, args.label)
  let decoded: ReturnType<typeof decodeFunctionData<typeof loopingErc20Abi>>
  try {
    decoded = decodeFunctionData({
      abi: loopingErc20Abi,
      data: args.call.data,
    })
  } catch (error) {
    fail('UNSAFE_WIRING', `${args.label} calldata is malformed.`, error)
  }
  if (
    decoded.functionName !== 'approve' ||
    !sameAddress(decoded.args[0], args.spender) ||
    decoded.args[1] !== args.amount
  ) {
    fail('UNSAFE_WIRING', `${args.label} changed its spender or amount.`)
  }
}

function decodePersistedAdapterTransfer(args: {
  call: Readonly<LoopingBundlerCall>
  market: Readonly<LoopingExecutionMarket>
  token: Address
  receiver: Address
  amount: bigint
  label: string
}): void {
  assertPlainBundlerCall(
    args.call,
    args.market.contracts.generalAdapter1,
    args.label,
  )
  let decoded: ReturnType<typeof decodeFunctionData<typeof generalAdapter1Abi>>
  try {
    decoded = decodeFunctionData({
      abi: generalAdapter1Abi,
      data: args.call.data,
    })
  } catch (error) {
    fail('UNSAFE_WIRING', `${args.label} calldata is malformed.`, error)
  }
  if (
    decoded.functionName !== 'erc20Transfer' ||
    !sameAddress(decoded.args[0], args.token) ||
    !sameAddress(decoded.args[1], args.receiver) ||
    decoded.args[2] !== args.amount
  ) {
    fail('UNSAFE_WIRING', `${args.label} changed its token, receiver, or amount.`)
  }
}

function decodePersistedMintRoute(args: {
  call: Readonly<LoopingBundlerCall>
  market: Readonly<LoopingExecutionMarket>
  label: string
}): Readonly<{ amountIn: bigint; minimumYtOut: bigint }> {
  assertPlainBundlerCall(
    args.call,
    args.market.contracts.pendleRouter,
    args.label,
  )
  const decoded = decodePendleMintCalldata(args.call.data)
  if (decoded.functionName !== 'mintPyFromToken') {
    fail('UNSAFE_WIRING', `${args.label} is not a Pendle PT+YT mint.`)
  }
  const [receiver, yieldToken, minimumYtOut, input] = decoded.args
  const mintSyToken = resolveAllowedRouteAddress(
    args.market,
    'mintSyToken',
    input.tokenMintSy,
  )
  if (
    !sameAddress(receiver, args.market.contracts.generalAdapter1) ||
    !sameAddress(yieldToken, args.market.yieldToken) ||
    !sameAddress(input.tokenIn, args.market.morphoMarketParams.loanToken) ||
    input.netTokenIn <= 0n ||
    minimumYtOut <= 0n ||
    !args.market.routePolicy.mintSyTokenAllowlist.some((token) =>
      sameAddress(token, mintSyToken))
  ) {
    fail(
      'UNSAFE_WIRING',
      `${args.label} changed its receiver, YT, input token, amount, or floor.`,
    )
  }
  const isDirectMint =
    input.swapData.swapType === 0 &&
    sameAddress(input.swapData.extRouter, zeroAddress) &&
    input.swapData.extCalldata === '0x' &&
    input.swapData.needScale === false &&
    sameAddress(input.pendleSwap, zeroAddress) &&
    sameAddress(mintSyToken, args.market.morphoMarketParams.loanToken)
  if (!isDirectMint) {
    const externalRouter = resolveAllowedRouteAddress(
      args.market,
      'externalRouter',
      input.swapData.extRouter,
    )
    if (
      !sameAddress(input.pendleSwap, args.market.contracts.pendleSwap) ||
      input.swapData.swapType !== args.market.routePolicy.swapType ||
      !sameAddress(input.swapData.extRouter, externalRouter) ||
      input.swapData.needScale !== args.market.routePolicy.entryNeedScale
    ) {
      fail('UNSAFE_WIRING', `${args.label} changed its swap policy.`)
    }
    validateNestedKyberCalldata({
      market: args.market,
      wiring: {
        kyberExecutorCodeHashes: Object.fromEntries(
          args.market.routePolicy.kyber.executorAllowlist.map((executor) => [
            executor.address.toLowerCase(),
            executor.runtimeCodeHash,
          ]),
        ),
      },
      calldata: input.swapData.extCalldata,
      expectedSourceToken: args.market.morphoMarketParams.loanToken,
      expectedDestinationToken: mintSyToken,
      expectedAmount: input.netTokenIn,
      label: args.label,
    })
  }
  const roundTrip = encodeFunctionData({
    abi: routerActionsAbi,
    functionName: 'mintPyFromToken',
    args: decoded.args,
  })
  if (!sameHex(roundTrip, args.call.data)) {
    fail('UNSAFE_WIRING', `${args.label} failed ABI round-trip validation.`)
  }
  return {
    amountIn: input.netTokenIn,
    minimumYtOut,
  }
}

function decodePersistedMintSupplyCallback(args: {
  call: Readonly<LoopingBundlerCall>
  market: Readonly<LoopingExecutionMarket>
  owner: Address
  initialMinimumCollateral: bigint
}): bigint {
  const label = 'Persisted Mint Mode collateral callback'
  if (
    !sameAddress(args.call.to, args.market.contracts.generalAdapter1) ||
    args.call.value !== 0n ||
    args.call.skipRevert ||
    sameHex(args.call.callbackHash, zeroHash)
  ) {
    fail('UNSAFE_WIRING', `${label} changed its Bundler3 call shape.`)
  }
  let decodedSupply:
    ReturnType<typeof decodeFunctionData<typeof generalAdapter1Abi>>
  try {
    decodedSupply = decodeFunctionData({
      abi: generalAdapter1Abi,
      data: args.call.data,
    })
  } catch (error) {
    fail('UNSAFE_WIRING', `${label} calldata is malformed.`, error)
  }
  if (decodedSupply.functionName !== 'morphoSupplyCollateral') {
    fail('UNSAFE_WIRING', `${label} no longer supplies Morpho collateral.`)
  }
  const [params, collateral, onBehalf, callbackData] = decodedSupply.args
  assertMarketTuple([
    params.loanToken,
    params.collateralToken,
    params.oracle,
    params.irm,
    params.lltv,
  ], args.market)
  if (
    !sameAddress(onBehalf, args.owner) ||
    callbackData === '0x' ||
    !sameHex(args.call.callbackHash, keccak256(callbackData))
  ) {
    fail(
      'UNSAFE_WIRING',
      `${label} changed its collateral, owner, or callback hash.`,
    )
  }
  let callbackCalls:
    ReturnType<typeof decodeAbiParameters<typeof bundler3CallArrayParameters>>[0]
  try {
    callbackCalls = decodeAbiParameters(
      bundler3CallArrayParameters,
      callbackData,
    )[0]
  } catch (error) {
    fail('UNSAFE_WIRING', `${label} payload is malformed.`, error)
  }
  if (
    callbackCalls.length !== 4 ||
    !sameHex(
      encodeAbiParameters(bundler3CallArrayParameters, [callbackCalls]),
      callbackData,
    )
  ) {
    fail('UNSAFE_WIRING', `${label} payload changed shape.`)
  }
  const calls = callbackCalls.map((call) => ({
    to: getAddress(call.to),
    data: call.data,
    value: call.value,
    skipRevert: call.skipRevert,
    callbackHash: call.callbackHash,
  }))
  assertPlainBundlerCall(
    calls[0],
    args.market.contracts.generalAdapter1,
    `${label} borrow`,
  )
  let decodedBorrow:
    ReturnType<typeof decodeFunctionData<typeof generalAdapter1Abi>>
  try {
    decodedBorrow = decodeFunctionData({
      abi: generalAdapter1Abi,
      data: calls[0].data,
    })
  } catch (error) {
    fail('UNSAFE_WIRING', `${label} borrow calldata is malformed.`, error)
  }
  if (decodedBorrow.functionName !== 'morphoBorrow') {
    fail('UNSAFE_WIRING', `${label} no longer borrows from Morpho.`)
  }
  const [
    borrowParams,
    borrowAssets,
    borrowShares,
    minimumSharePrice,
    borrowReceiver,
  ] = decodedBorrow.args
  assertMarketTuple([
    borrowParams.loanToken,
    borrowParams.collateralToken,
    borrowParams.oracle,
    borrowParams.irm,
    borrowParams.lltv,
  ], args.market)
  if (
    borrowAssets <= 0n ||
    borrowShares !== 0n ||
    minimumSharePrice <= 0n ||
    !sameAddress(borrowReceiver, args.market.contracts.bundler3)
  ) {
    fail('UNSAFE_WIRING', `${label} changed its bounded Morpho borrow.`)
  }
  const mint = decodePersistedMintRoute({
    call: calls[2],
    market: args.market,
    label: `${label} route`,
  })
  if (
    mint.amountIn !== borrowAssets ||
    collateral !== args.initialMinimumCollateral + mint.minimumYtOut
  ) {
    fail(
      'UNSAFE_WIRING',
      `${label} mint input or supplied collateral no longer matches its debt.`,
    )
  }
  decodePersistedErc20Approval({
    call: calls[1],
    token: args.market.morphoMarketParams.loanToken,
    spender: args.market.contracts.pendleRouter,
    amount: borrowAssets,
    label: `${label} approval`,
  })
  decodePersistedErc20Approval({
    call: calls[3],
    token: args.market.morphoMarketParams.loanToken,
    spender: args.market.contracts.pendleRouter,
    amount: 0n,
    label: `${label} approval cleanup`,
  })
  return mint.minimumYtOut
}

/**
 * Re-derives Mint Mode delivery bounds from the mined transaction itself.
 * Browser storage is treated only as a cache and must match this evidence.
 */
export async function readPersistedLoopingMintDeliveryFromTransaction(args: {
  client: PublicClient
  market: Readonly<LoopingExecutionMarket>
  owner: Address
  transactionHash: Hex
}): Promise<PersistedLoopingMintDeliveryEvidence> {
  const market = canonicalExecutionMarket(args.market)
  const owner = getAddress(args.owner)
  const [chainId, transaction] = await Promise.all([
    args.client.getChainId(),
    args.client.getTransaction({ hash: args.transactionHash }),
  ])
  if (
    chainId !== market.chainId ||
    !sameHex(transaction.hash, args.transactionHash) ||
    !sameAddress(transaction.from, owner) ||
    transaction.to === null ||
    !sameAddress(transaction.to, market.contracts.bundler3) ||
    transaction.value !== 0n
  ) {
    fail(
      'UNSAFE_WIRING',
      'Persisted Mint Mode transaction identity does not match this wallet and market.',
    )
  }
  const pair = await decodeExposedLoopingAuthorizationPair({
    market,
    owner,
    bundleData: transaction.input,
  })
  const calls = decodeBundleCalls(transaction.input)
  if (
    pair.operation !== 'entry' ||
    (calls.length !== 11 && calls.length !== 7)
  ) {
    fail('UNSAFE_WIRING', 'Persisted transaction is not a Mint Mode entry or increase.')
  }

  let minimumYtOut: bigint
  let operation: PersistedLoopingMintDeliveryEvidence['operation']
  if (calls.length === 11) {
    operation = 'entry'
    const initialMint = decodePersistedMintRoute({
      call: calls[3],
      market,
      label: 'Persisted Mint Mode equity route',
    })
    assertPlainBundlerCall(
      calls[1],
      market.contracts.generalAdapter1,
      'Persisted Mint Mode equity transfer',
    )
    let decodedTransfer:
      ReturnType<typeof decodeFunctionData<typeof generalAdapter1Abi>>
    try {
      decodedTransfer = decodeFunctionData({
        abi: generalAdapter1Abi,
        data: calls[1].data,
      })
    } catch (error) {
      fail(
        'UNSAFE_WIRING',
        'Persisted Mint Mode equity transfer calldata is malformed.',
        error,
      )
    }
    if (
      decodedTransfer.functionName !== 'erc20TransferFrom' ||
      !sameAddress(
        decodedTransfer.args[0],
        market.morphoMarketParams.loanToken,
      ) ||
      !sameAddress(decodedTransfer.args[1], market.contracts.bundler3) ||
      decodedTransfer.args[2] !== initialMint.amountIn
    ) {
      fail('UNSAFE_WIRING', 'Persisted Mint Mode equity transfer changed.')
    }
    decodePersistedErc20Approval({
      call: calls[2],
      token: market.morphoMarketParams.loanToken,
      spender: market.contracts.pendleRouter,
      amount: initialMint.amountIn,
      label: 'Persisted Mint Mode equity approval',
    })
    decodePersistedErc20Approval({
      call: calls[4],
      token: market.morphoMarketParams.loanToken,
      spender: market.contracts.pendleRouter,
      amount: 0n,
      label: 'Persisted Mint Mode equity approval cleanup',
    })
    const borrowedMinimumYtOut = decodePersistedMintSupplyCallback({
      call: calls[5],
      market,
      owner,
      initialMinimumCollateral: initialMint.minimumYtOut,
    })
    minimumYtOut = initialMint.minimumYtOut + borrowedMinimumYtOut
  } else {
    operation = 'increase'
    minimumYtOut = decodePersistedMintSupplyCallback({
      call: calls[1],
      market,
      owner,
      initialMinimumCollateral: 0n,
    })
  }
  const sweepIndex = calls.length === 11 ? 6 : 2
  const collateralSweepIndex = sweepIndex + 1
  const loanSweepIndex = sweepIndex + 2
  decodePersistedAdapterTransfer({
    call: calls[sweepIndex],
    market,
    token: market.yieldToken,
    receiver: owner,
    amount: maxUint256,
    label: 'Persisted Mint Mode YT sweep',
  })
  decodePersistedAdapterTransfer({
    call: calls[collateralSweepIndex],
    market,
    token: market.morphoMarketParams.collateralToken,
    receiver: owner,
    amount: maxUint256,
    label: 'Persisted Mint Mode PT sweep',
  })
  decodePersistedAdapterTransfer({
    call: calls[loanSweepIndex],
    market,
    token: market.morphoMarketParams.loanToken,
    receiver: owner,
    amount: maxUint256,
    label: 'Persisted Mint Mode loan-token sweep',
  })
  decodePersistedErc20Approval({
    call: calls[loanSweepIndex + 1],
    token: market.morphoMarketParams.collateralToken,
    spender: market.contracts.pendleRouter,
    amount: 0n,
    label: 'Persisted Mint Mode PT approval cleanup',
  })
  return Object.freeze({
    transactionHash: args.transactionHash,
    operation,
    yieldToken: market.yieldToken,
    minimumYtOut,
  })
}

export function classifyExposedLoopingAuthorization(args: {
  pair: Readonly<ExposedLoopingAuthorizationPair>
  state: Readonly<ExposedAuthorizationRecoveryState>
}): ExposedAuthorizationRecoveryClassification {
  const { pair, state } = args
  if (state.blockTimestamp > pair.deadline) {
    return state.adapterAuthorized
      ? Object.freeze({
          action: 'direct-revoke',
          reason: 'The exposed signatures expired, but the adapter remains authorized.',
        })
      : Object.freeze({
          action: 'none',
          reason: 'The exposed signatures expired and the adapter is revoked.',
        })
  }
  if (state.nonce === pair.startingNonce) {
    return Object.freeze({
      action: 'consume-pair',
      reason: 'Both exposed signatures are still live.',
    })
  }
  if (state.nonce === pair.startingNonce + 1n) {
    return Object.freeze({
      action: 'consume-revoke',
      reason: 'Only the exposed revoke signature remains live.',
    })
  }
  if (state.nonce >= pair.startingNonce + 2n && !state.adapterAuthorized) {
    return Object.freeze({
      action: 'none',
      reason: 'The exposed nonce pair is already invalidated.',
    })
  }
  if (state.adapterAuthorized) {
    return Object.freeze({
      action: 'direct-revoke',
      reason: 'The nonce moved unexpectedly and the adapter remains authorized.',
    })
  }
  return Object.freeze({
    action: 'blocked',
    reason: 'The exposed authorization nonce cannot be classified safely.',
  })
}

export function buildLoopingAuthorizationRecoveryIntent(args: {
  pair: Readonly<ExposedLoopingAuthorizationPair>
  classification: Readonly<ExposedAuthorizationRecoveryClassification>
}): LoopingRecoveryTransactionIntent | undefined {
  const market = canonicalExecutionMarket(args.pair.market)
  if (args.classification.action === 'none') return undefined
  if (args.classification.action === 'blocked') {
    fail('STATE_CONFLICT', args.classification.reason)
  }
  if (args.classification.action === 'direct-revoke') {
    return Object.freeze({
      kind: 'direct-authorization-revoke',
      owner: args.pair.owner,
      marketId: market.marketId,
      to: market.contracts.morpho,
      data: encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorization',
        args: [market.contracts.generalAdapter1, false],
      }),
      value: 0n,
    })
  }
  const calls = args.classification.action === 'consume-pair'
    ? [args.pair.authorizeCall, args.pair.revokeCall]
    : [args.pair.revokeCall]
  const data = encodeBundle(calls)
  assertBundleShape(
    data,
    calls.map(() => market.contracts.morpho),
    [],
  )
  return Object.freeze({
    kind: 'authorization-signature-recovery',
    owner: args.pair.owner,
    marketId: market.marketId,
    to: market.contracts.bundler3,
    data,
    value: 0n,
    calls: Object.freeze([...calls]),
  })
}

export async function prepareDirectLoopingAuthorizationRevoke(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
}): Promise<LoopingRecoveryTransactionIntent | undefined> {
  const market = canonicalExecutionMarket(args.market)
  const owner = getAddress(args.owner)
  const [chainId, adapterAuthorized] = await Promise.all([
    args.client.getChainId(),
    args.client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'isAuthorized',
      args: [owner, market.contracts.generalAdapter1],
      blockTag: 'pending',
    }),
  ])
  if (chainId !== market.chainId) {
    fail('UNSUPPORTED_CHAIN', 'Cannot prepare authorization cleanup on the wrong chain.')
  }
  await assertMorphoRuntimeCodeHash({ client: args.client, market })
  if (!adapterAuthorized) return undefined
  return Object.freeze({
    kind: 'direct-authorization-revoke',
    owner,
    marketId: market.marketId,
    to: market.contracts.morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: 'setAuthorization',
      args: [market.contracts.generalAdapter1, false],
    }),
    value: 0n,
  })
}

export async function prepareLoopingAuthorizationNonceBurn(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
}): Promise<LoopingAuthorizationNonceBurnPreview> {
  const market = canonicalExecutionMarket(args.market)
  const owner = getAddress(args.owner)
  const block = await args.client.getBlock({ blockTag: 'latest' })
  if (block.number === null || block.hash === null) {
    fail('STATE_CONFLICT', 'Authorization nonce cleanup could not pin a block.')
  }
  const [chainId, ownerCode, nonce, adapterAuthorized] = await Promise.all([
    args.client.getChainId(),
    args.client.getBytecode({ address: owner, blockNumber: block.number }),
    args.client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'nonce',
      args: [owner],
      blockNumber: block.number,
    }),
    args.client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'isAuthorized',
      args: [owner, market.contracts.generalAdapter1],
      blockNumber: block.number,
    }),
  ])
  if (chainId !== market.chainId) {
    fail('UNSUPPORTED_CHAIN', 'Cannot prepare nonce cleanup on the wrong chain.')
  }
  if (hasRuntimeCode(ownerCode)) {
    fail('STATE_CONFLICT', 'Signed authorization nonce cleanup supports EOA wallets only.')
  }
  await assertMorphoRuntimeCodeHash({
    client: args.client,
    market,
    blockNumber: block.number,
  })
  const request = Object.freeze(makeAuthorizationRequest({
    market,
    owner,
    nonce,
    deadline:
      block.timestamp + market.launchPolicy.authorizationLifetimeSeconds,
    isAuthorized: false,
    operation: 'nonce-burn',
  }))
  const preview = Object.freeze({
    kind: 'authorization-nonce-burn-preview',
    owner,
    market,
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    startingNonce: nonce,
    adapterAuthorized,
    request,
  }) as LoopingAuthorizationNonceBurnPreview
  preparedNonceBurnPreviews.add(preview)
  return preview
}

export async function buildLoopingAuthorizationNonceBurnIntent(args: {
  client: PublicClient
  preview: Readonly<LoopingAuthorizationNonceBurnPreview>
  signature: Hex
}): Promise<LoopingAuthorizationNonceBurnIntent> {
  if (!preparedNonceBurnPreviews.has(args.preview)) {
    fail('STATE_CONFLICT', 'Nonce cleanup requires this compiler\'s live preview.')
  }
  const market = canonicalExecutionMarket(args.preview.market)
  if (
    args.preview.request.purpose !== 'burn-authorization-nonce' ||
    args.preview.request.message.isAuthorized ||
    args.preview.request.message.nonce !== args.preview.startingNonce
  ) {
    fail('UNSAFE_WIRING', 'Authorization nonce cleanup request changed shape.')
  }
  const authorization = await parseAndVerifyAuthorizationSignature({
    request: args.preview.request,
    signature: args.signature,
    owner: args.preview.owner,
  })
  const block = await args.client.getBlock({ blockTag: 'latest' })
  if (block.number === null || block.hash === null) {
    fail('STATE_CONFLICT', 'Authorization nonce cleanup could not refresh state.')
  }
  const [chainId, nonce] = await Promise.all([
    args.client.getChainId(),
    args.client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'nonce',
      args: [args.preview.owner],
      blockNumber: block.number,
    }),
  ])
  if (chainId !== market.chainId) {
    fail('UNSUPPORTED_CHAIN', 'Cannot build nonce cleanup on the wrong chain.')
  }
  await assertMorphoRuntimeCodeHash({
    client: args.client,
    market,
    blockNumber: block.number,
  })
  if (
    nonce !== args.preview.startingNonce ||
    block.timestamp >= args.preview.request.message.deadline
  ) {
    fail('STATE_CONFLICT', 'Authorization nonce changed or cleanup signature expired.')
  }
  return Object.freeze({
    kind: 'authorization-nonce-burn',
    owner: args.preview.owner,
    marketId: market.marketId,
    to: market.contracts.morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: 'setAuthorizationWithSig',
      args: [args.preview.request.message, authorization],
    }),
    value: 0n,
    startingNonce: args.preview.startingNonce,
    deadline: args.preview.request.message.deadline,
    expectedPostconditions: Object.freeze({
      nonce: args.preview.startingNonce + 1n,
      adapterAuthorized: false,
    }),
  })
}

export async function prepareDirectLoopingRescue(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
}): Promise<LoopingDirectRescuePlan> {
  const market = canonicalExecutionMarket(args.market)
  const owner = getAddress(args.owner)
  const block = await args.client.getBlock({ blockTag: 'latest' })
  if (block.number === null || block.hash === null) {
    fail('STATE_CONFLICT', 'Direct rescue could not pin a canonical block.')
  }
  const [
    chainId,
    adapterAuthorized,
    adapterAllowance,
    morphoAllowance,
    ownerLoanBalance,
    accruedSnapshot,
  ] = await Promise.all([
    args.client.getChainId(),
    args.client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'isAuthorized',
      args: [owner, market.contracts.generalAdapter1],
      blockNumber: block.number,
    }),
    args.client.readContract({
      address: market.morphoMarketParams.loanToken,
      abi: loopingErc20Abi,
      functionName: 'allowance',
      args: [owner, market.contracts.generalAdapter1],
      blockNumber: block.number,
    }),
    args.client.readContract({
      address: market.morphoMarketParams.loanToken,
      abi: loopingErc20Abi,
      functionName: 'allowance',
      args: [owner, market.contracts.morpho],
      blockNumber: block.number,
    }),
    args.client.readContract({
      address: market.morphoMarketParams.loanToken,
      abi: loopingErc20Abi,
      functionName: 'balanceOf',
      args: [owner],
      blockNumber: block.number,
    }),
    readAccruedLoopingSnapshot({
      client: args.client,
      owner,
      market,
      blockNumber: block.number,
      includeOracle: false,
    }),
  ])
  if (chainId !== market.chainId) {
    fail('UNSUPPORTED_CHAIN', 'Cannot prepare direct rescue on the wrong chain.')
  }
  await assertMorphoRuntimeCodeHash({
    client: args.client,
    market,
    blockNumber: block.number,
  })
  const position = accruedSnapshot.position
  const params = market.morphoMarketParams
  const bounds =
    !adapterAuthorized &&
    adapterAllowance === 0n &&
    position.supplyShares === 0n &&
    position.borrowShares > 0n
    ? deriveExitRepaymentBounds(
        accruedSnapshot.accrued,
        position.borrowShares,
        market,
      )
    : undefined
  let phase: LoopingDirectRescuePlan['phase'] = 'complete'
  let nextIntent: LoopingDirectRescueTransactionIntent | undefined
  if (adapterAuthorized) {
    phase = 'revoke-adapter'
    nextIntent = {
      step: 'revoke-adapter',
      to: market.contracts.morpho,
      data: encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'setAuthorization',
        args: [market.contracts.generalAdapter1, false],
      }),
      value: 0n,
    }
  } else if (adapterAllowance !== 0n) {
    phase = 'clear-adapter-allowance'
    nextIntent = {
      step: 'clear-adapter-allowance',
      to: params.loanToken,
      data: encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.generalAdapter1, 0n],
      }),
      value: 0n,
    }
  } else if (position.supplyShares !== 0n) {
    fail('STATE_CONFLICT', 'Direct rescue does not support a conflicting Morpho supply position.')
  } else if (
    bounds !== undefined &&
    morphoAllowance !== 0n &&
    morphoAllowance !== bounds.repaymentCapAssets
  ) {
    phase = 'clear-morpho-allowance-before'
    nextIntent = {
      step: 'clear-morpho-allowance-before',
      to: params.loanToken,
      data: encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.morpho, 0n],
      }),
      value: 0n,
    }
  } else if (
    bounds !== undefined &&
    morphoAllowance !== bounds.repaymentCapAssets
  ) {
    if (ownerLoanBalance < bounds.repaymentCapAssets) {
      fail(
        'STATE_CONFLICT',
        `Direct rescue needs ${formatUnits(bounds.repaymentCapAssets, market.loanTokenDecimals)} units of the market's loan token in the wallet.`,
      )
    }
    phase = 'approve-exact-repayment'
    nextIntent = {
      step: 'approve-exact-repayment',
      to: params.loanToken,
      data: encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.morpho, bounds.repaymentCapAssets],
      }),
      value: 0n,
    }
  } else if (bounds !== undefined) {
    if (ownerLoanBalance < bounds.repaymentCapAssets) {
      fail(
        'STATE_CONFLICT',
        `Direct rescue needs ${formatUnits(bounds.repaymentCapAssets, market.loanTokenDecimals)} units of the market's loan token in the wallet.`,
      )
    }
    phase = 'repay-exact-shares'
    nextIntent = {
      step: 'repay-exact-shares',
      to: market.contracts.morpho,
      data: encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'repay',
        args: [params, 0n, position.borrowShares, owner, '0x'],
      }),
      value: 0n,
    }
  } else if (morphoAllowance !== 0n) {
    phase = 'clear-morpho-allowance-after'
    nextIntent = {
      step: 'clear-morpho-allowance-after',
      to: params.loanToken,
      data: encodeFunctionData({
        abi: loopingErc20Abi,
        functionName: 'approve',
        args: [market.contracts.morpho, 0n],
      }),
      value: 0n,
    }
  } else if (position.collateral > 0n) {
    phase = 'withdraw-exact-collateral'
    nextIntent = {
      step: 'withdraw-exact-collateral',
      to: market.contracts.morpho,
      data: encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'withdrawCollateral',
        args: [params, position.collateral, owner, owner],
      }),
      value: 0n,
    }
  }
  const intents = nextIntent === undefined
    ? Object.freeze([]) as readonly []
    : Object.freeze([Object.freeze(nextIntent)]) as readonly [
        Readonly<LoopingDirectRescueTransactionIntent>,
      ]
  return Object.freeze({
    kind: 'direct-rescue-plan',
    phase,
    owner,
    marketId: market.marketId,
    blockNumber: block.number,
    blockHash: block.hash,
    position: Object.freeze({ ...position }),
    ...(bounds === undefined ? {} : { bounds: Object.freeze(bounds) }),
    ownerLoanBalance,
    startingState: Object.freeze({
      adapterAuthorized,
      adapterAllowance,
      morphoAllowance,
    }),
    intents,
    requiresReprepareAfterEachStep: true,
    expectedPostconditions: Object.freeze({
      adapterAuthorized: false,
      adapterAllowance: 0n,
      morphoAllowance: 0n,
      position: 'empty',
      collateralReturnedAssets: position.collateral,
    }),
  })
}

export async function readExposedLoopingAuthorizationRecoveryState(args: {
  client: PublicClient
  pair: Readonly<ExposedLoopingAuthorizationPair>
}): Promise<ExposedAuthorizationRecoveryState> {
  const market = canonicalExecutionMarket(args.pair.market)
  const [chainId, block, nonce, adapterAuthorized, rawPosition] =
    await Promise.all([
      args.client.getChainId(),
      args.client.getBlock({ blockTag: 'pending' }),
      args.client.readContract({
        address: market.contracts.morpho,
        abi: morphoBlueAbi,
        functionName: 'nonce',
        args: [args.pair.owner],
        blockTag: 'pending',
      }),
      args.client.readContract({
        address: market.contracts.morpho,
        abi: morphoBlueAbi,
        functionName: 'isAuthorized',
        args: [args.pair.owner, market.contracts.generalAdapter1],
        blockTag: 'pending',
      }),
      args.client.readContract({
        address: market.contracts.morpho,
        abi: morphoBlueAbi,
        functionName: 'position',
        args: [market.marketId, args.pair.owner],
        blockTag: 'pending',
      }),
    ])
  if (chainId !== market.chainId) {
    fail('UNSUPPORTED_CHAIN', 'Cannot classify exposed authorization on the wrong chain.')
  }
  await assertMorphoRuntimeCodeHash({ client: args.client, market })
  return Object.freeze({
    blockTimestamp: block.timestamp,
    nonce,
    adapterAuthorized,
    position: Object.freeze(classifyPosition(rawPosition)),
  })
}

function assertBroadcastWindow(args: {
  quotedAtMs: number
  validUntilMs: number
  deadline: bigint
  blockTimestamp: bigint
  now: () => number
}): number {
  const checkedAtMs = args.now()
  if (
    !Number.isFinite(checkedAtMs) ||
    checkedAtMs < args.quotedAtMs ||
    checkedAtMs >= args.validUntilMs
  ) {
    fail('QUOTE_EXPIRED', 'The signed looping quote is no longer fresh.')
  }
  if (args.blockTimestamp >= args.deadline) {
    fail('QUOTE_EXPIRED', 'The signed Morpho authorization is no longer safely broadcastable.')
  }
  return checkedAtMs
}

function assertEntryBorrowFitsSignedBounds(args: {
  preview: Readonly<LoopingEntryExecutionPreview>
  fresh: Readonly<LoopingEntryBorrowBounds>
}): void {
  if (
    args.fresh.observedBorrowShares > args.preview.bounds.maxBorrowShares ||
    args.fresh.observedBorrowSharePriceE27 <
      args.preview.bounds.minBorrowSharePriceE27
  ) {
    fail('POSITION_UNSAFE', 'Fresh Morpho borrow shares exceed the signed entry bound.')
  }
}

function assertExitRepaymentFitsSignedBounds(args: {
  preview: Readonly<LoopingExitExecutionPreview>
  fresh: Readonly<LoopingExitRepaymentBounds>
}): void {
  if (
    args.fresh.borrowShares !== args.preview.position.borrowShares ||
    args.fresh.accruedDebtAssets > args.preview.bounds.repaymentCapAssets ||
    args.fresh.observedRepaySharePriceE27 >
      args.preview.bounds.maxRepaySharePriceE27
  ) {
    fail('POSITION_UNSAFE', 'Fresh Morpho debt exceeds the signed exit repayment bound.')
  }
}

function assertSimulationEvidence(args: {
  intent: Readonly<UnsignedLoopingSimulationIntent>
  evidence: Readonly<LoopingUnsignedSimulationEvidence>
}): void {
  const requiredRuntimeKeys = Object.keys(
    args.intent.requiredRuntimeCodeHashes,
  ) as (keyof LoopingRuntimeCodePolicy)[]
  if (
    !verifiedSimulationEvidence.has(args.evidence) ||
    args.evidence.operation !== args.intent.operation ||
    args.evidence.acquisitionMode !== args.intent.acquisitionMode ||
    !sameAddress(args.evidence.owner, args.intent.owner) ||
    !sameHex(args.evidence.marketId, args.intent.marketId) ||
    !sameHex(
      args.evidence.intentFingerprint,
      fingerprintUnsignedSimulationIntent(args.intent),
    ) ||
    Object.keys(args.evidence.requiredRuntimeCodeHashes).length !==
      requiredRuntimeKeys.length ||
    requiredRuntimeKeys.some((key) => !sameHex(
      args.evidence.requiredRuntimeCodeHashes[key],
      args.intent.requiredRuntimeCodeHashes[key],
    ))
  ) {
    fail('SIMULATION_FAILED', 'Unsigned simulation evidence is missing or stale.')
  }
}

export async function revalidateSignedLoopingEntry(args: {
  client: PublicClient
  preview: Readonly<LoopingEntryExecutionPreview>
  bundle: Readonly<SignedLoopingEntryBundle>
  simulation: Readonly<LoopingUnsignedSimulationEvidence>
  now?: () => number
}): Promise<LoopingBroadcastReadiness> {
  if (!preparedEntryPreviews.has(args.preview)) {
    fail('STATE_CONFLICT', 'Entry revalidation requires this compiler\'s live preview.')
  }
  await assertSignedEntryBundleBindsPreview(args.preview, args.bundle)
  const market = canonicalExecutionMarket(args.preview.market)
  const now = args.now ?? Date.now
  const intent = buildUnsignedLoopingEntrySimulation(args.preview, now)
  assertSimulationEvidence({ intent, evidence: args.simulation })
  const pinnedBlock = await args.client.getBlock({
    blockNumber: args.simulation.blockNumber,
  })
  if (pinnedBlock.hash === null || !sameHex(pinnedBlock.hash, args.simulation.blockHash)) {
    fail('STATE_CONFLICT', 'The simulated entry block is no longer canonical.')
  }
  const [staticSnapshot, accruedSnapshot] = await Promise.all([
    readStaticLoopingWiring({
      client: args.client,
      owner: args.preview.owner,
      market,
      blockNumber: args.simulation.blockNumber,
      includeMint: args.preview.acquisitionMode === 'mint',
    }),
    readAccruedLoopingSnapshot({
      client: args.client,
      owner: args.preview.owner,
      market,
      blockNumber: args.simulation.blockNumber,
    }),
  ])
  const { wiring, position } = staticSnapshot
  const checkedAtMs = assertBroadcastWindow({
    quotedAtMs: args.bundle.quotedAtMs,
    validUntilMs: args.bundle.validUntilMs,
    deadline: args.bundle.deadline,
    blockTimestamp: wiring.blockTimestamp,
    now,
  })
  if (
    wiring.nonce !== args.bundle.startingNonce ||
    wiring.adapterAuthorized ||
    wiring.adapterAllowance !== args.preview.equityAssets ||
    wiring.ownerLoanBalance < args.preview.equityAssets
  ) {
    fail('STATE_CONFLICT', 'Entry nonce, authorization, allowance, or balance changed after signing.')
  }
  if (
    !samePosition(position, args.preview.position) ||
    !samePosition(accruedSnapshot.position, args.preview.position)
  ) {
    fail('STATE_CONFLICT', 'The exact Morpho position changed after entry signing.')
  }
  const freshBounds = deriveEntryBorrowBounds(
    accruedSnapshot.accrued,
    args.preview.borrowAssets,
    market,
  )
  assertEntryBorrowFitsSignedBounds({ preview: args.preview, fresh: freshBounds })
  const entryHealth = deriveEntryHealth({
    market,
    acquisitionMode: args.preview.acquisitionMode,
    collateral: args.preview.quotes.minimumCollateral,
    equityAssets: args.preview.equityAssets,
    borrowAssets: args.preview.borrowAssets,
    oraclePrice: accruedSnapshot.accrued.oraclePrice,
  })
  const readiness = Object.freeze({
    kind: 'entry-broadcast-ready',
    operation: 'entry',
    owner: args.preview.owner,
    marketId: market.marketId,
    checkedAtMs,
    blockNumber: args.simulation.blockNumber,
    blockHash: args.simulation.blockHash,
    blockTimestamp: wiring.blockTimestamp,
    nonce: wiring.nonce,
    adapterAuthorized: false,
    adapterAllowance: wiring.adapterAllowance,
    morphoAllowance: wiring.morphoAllowance,
    ownerLoanBalance: wiring.ownerLoanBalance,
    position: Object.freeze({ ...accruedSnapshot.position }),
    accrued: Object.freeze({ ...accruedSnapshot.accrued }),
    entryHealth: Object.freeze(entryHealth),
    entryBorrowBounds: Object.freeze(freshBounds),
    simulation: args.simulation,
  })
  preparedBroadcastReadiness.add(readiness)
  return readiness
}

export async function revalidateSignedLoopingExit(args: {
  client: PublicClient
  preview: Readonly<LoopingExitExecutionPreview>
  bundle: Readonly<SignedLoopingExitBundle>
  simulation: Readonly<LoopingUnsignedSimulationEvidence>
  now?: () => number
}): Promise<LoopingBroadcastReadiness> {
  if (!preparedExitPreviews.has(args.preview)) {
    fail('STATE_CONFLICT', 'Exit revalidation requires this compiler\'s live preview.')
  }
  await assertSignedExitBundleBindsPreview(args.preview, args.bundle)
  const market = canonicalExecutionMarket(args.preview.market)
  const now = args.now ?? Date.now
  const intent = buildUnsignedLoopingExitSimulation(args.preview, now)
  assertSimulationEvidence({ intent, evidence: args.simulation })
  const pinnedBlock = await args.client.getBlock({
    blockNumber: args.simulation.blockNumber,
  })
  if (pinnedBlock.hash === null || !sameHex(pinnedBlock.hash, args.simulation.blockHash)) {
    fail('STATE_CONFLICT', 'The simulated exit block is no longer canonical.')
  }
  const [staticSnapshot, accruedSnapshot] = await Promise.all([
    readStaticLoopingWiring({
      client: args.client,
      owner: args.preview.owner,
      market,
      blockNumber: args.simulation.blockNumber,
      allowMatured: true,
    }),
    readAccruedLoopingSnapshot({
      client: args.client,
      owner: args.preview.owner,
      market,
      blockNumber: args.simulation.blockNumber,
      includeOracle: false,
    }),
  ])
  const { wiring, position } = staticSnapshot
  const maturedAtSimulation = wiring.blockTimestamp >= market.pendleMarketExpiry
  if (
    (args.preview.quote.kind === 'redeem-matured-pt') !== maturedAtSimulation ||
    (args.preview.quote.kind === 'redeem-matured-pt' &&
      !sameAddress(
        args.preview.quote.yieldToken,
        staticSnapshot.pendleYieldToken,
      ))
  ) {
    fail('STATE_CONFLICT', 'The Pendle market maturity state changed after exit preparation.')
  }
  const checkedAtMs = assertBroadcastWindow({
    quotedAtMs: args.bundle.quotedAtMs,
    validUntilMs: args.bundle.validUntilMs,
    deadline: args.bundle.deadline,
    blockTimestamp: wiring.blockTimestamp,
    now,
  })
  if (
    wiring.nonce !== args.bundle.startingNonce ||
    wiring.adapterAuthorized
  ) {
    fail('STATE_CONFLICT', 'Exit nonce or authorization changed after signing.')
  }
  if (
    !samePosition(position, args.preview.position) ||
    !samePosition(accruedSnapshot.position, args.preview.position)
  ) {
    fail('STATE_CONFLICT', 'The exact Morpho position changed after exit signing.')
  }
  const freshBounds = deriveExitRepaymentBounds(
    accruedSnapshot.accrued,
    args.preview.position.borrowShares,
    market,
  )
  assertExitRepaymentFitsSignedBounds({ preview: args.preview, fresh: freshBounds })
  const readiness = Object.freeze({
    kind: 'exit-broadcast-ready',
    operation: 'exit',
    owner: args.preview.owner,
    marketId: market.marketId,
    checkedAtMs,
    blockNumber: args.simulation.blockNumber,
    blockHash: args.simulation.blockHash,
    blockTimestamp: wiring.blockTimestamp,
    nonce: wiring.nonce,
    adapterAuthorized: false,
    adapterAllowance: wiring.adapterAllowance,
    morphoAllowance: wiring.morphoAllowance,
    ownerLoanBalance: wiring.ownerLoanBalance,
    position: Object.freeze({ ...accruedSnapshot.position }),
    accrued: Object.freeze({ ...accruedSnapshot.accrued }),
    exitRepaymentBounds: Object.freeze(freshBounds),
    simulation: args.simulation,
  })
  preparedBroadcastReadiness.add(readiness)
  return readiness
}

export async function revalidateSignedLoopingIncrease(args: {
  client: PublicClient
  preview: Readonly<LoopingIncreaseExecutionPreview>
  bundle: Readonly<SignedLoopingIncreaseBundle>
  simulation: Readonly<LoopingUnsignedSimulationEvidence>
  now?: () => number
}): Promise<LoopingBroadcastReadiness> {
  if (!preparedIncreasePreviews.has(args.preview)) {
    fail('STATE_CONFLICT', 'Increase revalidation requires this compiler\'s live preview.')
  }
  await assertSignedIncreaseBundleBindsPreview(args.preview, args.bundle)
  const market = canonicalExecutionMarket(args.preview.market)
  const now = args.now ?? Date.now
  const intent = buildUnsignedLoopingIncreaseSimulation(args.preview, now)
  assertSimulationEvidence({ intent, evidence: args.simulation })
  const pinnedBlock = await args.client.getBlock({
    blockNumber: args.simulation.blockNumber,
  })
  if (pinnedBlock.hash === null || !sameHex(pinnedBlock.hash, args.simulation.blockHash)) {
    fail('STATE_CONFLICT', 'The simulated increase block is no longer canonical.')
  }
  const [staticSnapshot, accruedSnapshot] = await Promise.all([
    readStaticLoopingWiring({
      client: args.client,
      owner: args.preview.owner,
      market,
      blockNumber: args.simulation.blockNumber,
      includeMint: args.preview.acquisitionMode === 'mint',
    }),
    readAccruedLoopingSnapshot({
      client: args.client,
      owner: args.preview.owner,
      market,
      blockNumber: args.simulation.blockNumber,
    }),
  ])
  const { wiring, position } = staticSnapshot
  const checkedAtMs = assertBroadcastWindow({
    quotedAtMs: args.bundle.quotedAtMs,
    validUntilMs: args.bundle.validUntilMs,
    deadline: args.bundle.deadline,
    blockTimestamp: wiring.blockTimestamp,
    now,
  })
  if (wiring.nonce !== args.bundle.startingNonce || wiring.adapterAuthorized) {
    fail('STATE_CONFLICT', 'Increase nonce or authorization changed after signing.')
  }
  if (
    !samePosition(position, args.preview.position) ||
    !samePosition(accruedSnapshot.position, args.preview.position)
  ) {
    fail('STATE_CONFLICT', 'The exact Morpho position changed after increase signing.')
  }
  const freshBounds = deriveEntryBorrowBounds(
    accruedSnapshot.accrued,
    args.preview.borrowAssets,
    market,
  )
  if (
    freshBounds.observedBorrowShares > args.preview.bounds.maxBorrowShares ||
    freshBounds.observedBorrowSharePriceE27 <
      args.preview.bounds.minBorrowSharePriceE27
  ) {
    fail('POSITION_UNSAFE', 'Fresh Morpho borrow shares exceed the signed increase bound.')
  }
  const addedCollateralValue =
    args.preview.quote.minPtOut * accruedSnapshot.accrued.oraclePrice /
      ORACLE_PRICE_SCALE
  if (
    args.preview.acquisitionMode === 'market' &&
    addedCollateralValue * BPS <
      args.preview.borrowAssets * BigInt(market.launchPolicy.minEntryValueBps)
  ) {
    fail('POSITION_UNSAFE', 'Fresh oracle value no longer supports the PT increase quote.')
  }
  const current = deriveCurrentLeverage({
    market,
    position: accruedSnapshot.position,
    accrued: accruedSnapshot.accrued,
  })
  const post = deriveIncreasePost({
    market,
    position: accruedSnapshot.position,
    accrued: accruedSnapshot.accrued,
    borrowAssets: args.preview.borrowAssets,
    maxBorrowShares: args.preview.bounds.maxBorrowShares,
    minimumAddedCollateral: args.preview.quote.minPtOut,
  })
  assertAdjustmentTarget(args.preview.targetLeverageWad, current.leverageWad, 'increase')
  assertAdjustmentOutcome({
    market,
    targetLeverageWad: args.preview.targetLeverageWad,
    current,
    post,
    direction: 'increase',
  })
  if (
    args.preview.targetLeverageWad - post.leverageWad >
      ADJUSTMENT_TARGET_TOLERANCE_WAD
  ) {
    fail('POSITION_UNSAFE', 'Fresh conservative leverage is outside the target tolerance.')
  }
  const readiness = Object.freeze({
    kind: 'entry-broadcast-ready',
    operation: 'entry',
    owner: args.preview.owner,
    marketId: market.marketId,
    checkedAtMs,
    blockNumber: args.simulation.blockNumber,
    blockHash: args.simulation.blockHash,
    blockTimestamp: wiring.blockTimestamp,
    nonce: wiring.nonce,
    adapterAuthorized: false,
    adapterAllowance: wiring.adapterAllowance,
    morphoAllowance: wiring.morphoAllowance,
    ownerLoanBalance: wiring.ownerLoanBalance,
    position: Object.freeze({ ...accruedSnapshot.position }),
    accrued: Object.freeze({ ...accruedSnapshot.accrued }),
    entryHealth: Object.freeze({
      borrowAssets: post.debtAssets,
      collateralLoanValue: post.collateralLoanValue,
      maxBorrowAssets: post.maxBorrowAssets,
      liquidationBufferBps: post.liquidationBufferBps,
      oraclePrice: post.oraclePrice,
    }),
    entryBorrowBounds: Object.freeze(freshBounds),
    simulation: args.simulation,
  }) satisfies LoopingBroadcastReadiness
  preparedBroadcastReadiness.add(readiness)
  return readiness
}

export async function revalidateSignedLoopingDecrease(args: {
  client: PublicClient
  preview: Readonly<LoopingDecreaseExecutionPreview>
  bundle: Readonly<SignedLoopingDecreaseBundle>
  simulation: Readonly<LoopingUnsignedSimulationEvidence>
  now?: () => number
}): Promise<LoopingBroadcastReadiness> {
  if (!preparedDecreasePreviews.has(args.preview)) {
    fail('STATE_CONFLICT', 'Decrease revalidation requires this compiler\'s live preview.')
  }
  await assertSignedDecreaseBundleBindsPreview(args.preview, args.bundle)
  const market = canonicalExecutionMarket(args.preview.market)
  const now = args.now ?? Date.now
  const intent = buildUnsignedLoopingDecreaseSimulation(args.preview, now)
  assertSimulationEvidence({ intent, evidence: args.simulation })
  const pinnedBlock = await args.client.getBlock({
    blockNumber: args.simulation.blockNumber,
  })
  if (pinnedBlock.hash === null || !sameHex(pinnedBlock.hash, args.simulation.blockHash)) {
    fail('STATE_CONFLICT', 'The simulated decrease block is no longer canonical.')
  }
  const [staticSnapshot, accruedSnapshot] = await Promise.all([
    readStaticLoopingWiring({
      client: args.client,
      owner: args.preview.owner,
      market,
      blockNumber: args.simulation.blockNumber,
    }),
    readAccruedLoopingSnapshot({
      client: args.client,
      owner: args.preview.owner,
      market,
      blockNumber: args.simulation.blockNumber,
    }),
  ])
  const { wiring, position } = staticSnapshot
  const checkedAtMs = assertBroadcastWindow({
    quotedAtMs: args.bundle.quotedAtMs,
    validUntilMs: args.bundle.validUntilMs,
    deadline: args.bundle.deadline,
    blockTimestamp: wiring.blockTimestamp,
    now,
  })
  if (wiring.nonce !== args.bundle.startingNonce || wiring.adapterAuthorized) {
    fail('STATE_CONFLICT', 'Decrease nonce or authorization changed after signing.')
  }
  if (
    !samePosition(position, args.preview.position) ||
    !samePosition(accruedSnapshot.position, args.preview.position)
  ) {
    fail('STATE_CONFLICT', 'The exact Morpho position changed after decrease signing.')
  }
  const freshBounds = deriveExitRepaymentBounds(
    accruedSnapshot.accrued,
    args.preview.repayShares,
    market,
  )
  if (
    freshBounds.borrowShares !== args.preview.repayShares ||
    freshBounds.accruedDebtAssets > args.preview.bounds.repaymentCapAssets ||
    freshBounds.observedRepaySharePriceE27 >
      args.preview.bounds.maxRepaySharePriceE27
  ) {
    fail('POSITION_UNSAFE', 'Fresh Morpho debt exceeds the signed decrease repayment bound.')
  }
  if (
    args.preview.quote.minLoanTokenOut <
      args.preview.bounds.repaymentCapAssets + args.preview.minimumReturnedAssets
  ) {
    fail('ROUTE_NOT_ALLOWED', 'The signed decrease route no longer covers repayment.')
  }
  const freshSoldCollateralValue =
    args.preview.collateralToSell * accruedSnapshot.accrued.oraclePrice /
      ORACLE_PRICE_SCALE
  if (
    args.preview.quote.minLoanTokenOut * BPS <
      freshSoldCollateralValue * BigInt(market.launchPolicy.minEntryValueBps)
  ) {
    fail(
      'POSITION_UNSAFE',
      'The fresh oracle value no longer supports the signed PT sale.',
    )
  }
  const current = deriveCurrentLeverage({
    market,
    position: accruedSnapshot.position,
    accrued: accruedSnapshot.accrued,
  })
  const post = deriveDecreasePost({
    market,
    position: accruedSnapshot.position,
    accrued: accruedSnapshot.accrued,
    repayShares: args.preview.repayShares,
    collateralToSell: args.preview.collateralToSell,
    maxRepaySharePriceE27: args.preview.bounds.maxRepaySharePriceE27,
  })
  assertAdjustmentTarget(args.preview.targetLeverageWad, current.leverageWad, 'decrease')
  assertAdjustmentOutcome({
    market,
    targetLeverageWad: args.preview.targetLeverageWad,
    current,
    post,
    direction: 'decrease',
  })
  const readiness = Object.freeze({
    kind: 'exit-broadcast-ready',
    operation: 'exit',
    owner: args.preview.owner,
    marketId: market.marketId,
    checkedAtMs,
    blockNumber: args.simulation.blockNumber,
    blockHash: args.simulation.blockHash,
    blockTimestamp: wiring.blockTimestamp,
    nonce: wiring.nonce,
    adapterAuthorized: false,
    adapterAllowance: wiring.adapterAllowance,
    morphoAllowance: wiring.morphoAllowance,
    ownerLoanBalance: wiring.ownerLoanBalance,
    position: Object.freeze({ ...accruedSnapshot.position }),
    accrued: Object.freeze({ ...accruedSnapshot.accrued }),
    exitRepaymentBounds: Object.freeze(freshBounds),
    simulation: args.simulation,
  }) satisfies LoopingBroadcastReadiness
  preparedBroadcastReadiness.add(readiness)
  return readiness
}

async function readLoopingReceiptSnapshot(args: {
  client: PublicClient
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  blockNumber: bigint
  includeOracle: boolean
  includeMint: boolean
}): Promise<{
  nonce: bigint
  adapterAuthorized: boolean
  adapterAllowance: bigint
  morphoAllowance: bigint
  ownerLoanBalance: bigint
  position: LoopingPositionSnapshot
  accrued: LoopingAccruedMarketSnapshot
}> {
  const market = canonicalExecutionMarket(args.market)
  const owner = getAddress(args.owner)
  const [
    chainId,
    yieldTokenDecimals,
    nonce,
    adapterAuthorized,
    adapterAllowance,
    morphoAllowance,
    ownerLoanBalance,
    accruedSnapshot,
  ] = await Promise.all([
    args.client.getChainId(),
    args.includeMint
      ? args.client.readContract({
          address: market.yieldToken,
          abi: loopingErc20Abi,
          functionName: 'decimals',
          blockNumber: args.blockNumber,
        })
      : Promise.resolve(market.yieldTokenDecimals),
    args.client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'nonce',
      args: [owner],
      blockNumber: args.blockNumber,
    }),
    args.client.readContract({
      address: market.contracts.morpho,
      abi: morphoBlueAbi,
      functionName: 'isAuthorized',
      args: [owner, market.contracts.generalAdapter1],
      blockNumber: args.blockNumber,
    }),
    args.client.readContract({
      address: market.morphoMarketParams.loanToken,
      abi: loopingErc20Abi,
      functionName: 'allowance',
      args: [owner, market.contracts.generalAdapter1],
      blockNumber: args.blockNumber,
    }),
    args.client.readContract({
      address: market.morphoMarketParams.loanToken,
      abi: loopingErc20Abi,
      functionName: 'allowance',
      args: [owner, market.contracts.morpho],
      blockNumber: args.blockNumber,
    }),
    args.client.readContract({
      address: market.morphoMarketParams.loanToken,
      abi: loopingErc20Abi,
      functionName: 'balanceOf',
      args: [owner],
      blockNumber: args.blockNumber,
    }),
    readAccruedLoopingSnapshot({
      client: args.client,
      owner,
      market,
      blockNumber: args.blockNumber,
      includeOracle: args.includeOracle,
    }),
  ])
  if (chainId !== market.chainId) {
    fail('UNSUPPORTED_CHAIN', 'Cannot verify a looping receipt on the wrong chain.')
  }
  if (
    args.includeMint &&
    (
      yieldTokenDecimals !== market.yieldTokenDecimals ||
      yieldTokenDecimals !== market.collateralTokenDecimals
    )
  ) {
    fail('UNSAFE_WIRING', 'Looping YT decimals changed at the receipt block.')
  }
  await assertPinnedRuntimeCodeHashes({
    client: args.client,
    market,
    blockNumber: args.blockNumber,
    includeMint: args.includeMint,
  })
  return {
    nonce,
    adapterAuthorized,
    adapterAllowance,
    morphoAllowance,
    ownerLoanBalance,
    position: accruedSnapshot.position,
    accrued: accruedSnapshot.accrued,
  }
}

function sumMintYieldTokenDelivery(args: {
  logs: readonly Log[]
  yieldToken: Address
  adapter: Address
  owner: Address
}): bigint {
  let delivered = 0n
  for (const log of args.logs) {
    if (!sameAddress(log.address, args.yieldToken)) continue
    try {
      const decoded = decodeEventLog({
        abi: erc20TransferEventAbi,
        data: log.data,
        topics: log.topics,
      })
      if (
        decoded.eventName === 'Transfer' &&
        sameAddress(decoded.args.from, args.adapter) &&
        sameAddress(decoded.args.to, args.owner)
      ) {
        delivered += decoded.args.value
      }
    } catch {
      // The YT contract can emit non-Transfer events in the same receipt.
    }
  }
  return delivered
}

async function assertSuccessfulLoopingTransaction(args: {
  client: PublicClient
  transactionHash: Hex
  owner: Address
  to: Address
  data: Hex
}): Promise<{
  blockNumber: bigint
  blockHash: Hex
  logs: readonly Log[]
}> {
  const [receipt, transaction] = await Promise.all([
    args.client.getTransactionReceipt({ hash: args.transactionHash }),
    args.client.getTransaction({ hash: args.transactionHash }),
  ])
  const transactionBlockMetadataMatches =
    transaction.blockNumber === null && transaction.blockHash === null
      ? true
      : transaction.blockNumber !== null &&
        transaction.blockHash !== null &&
        transaction.blockNumber === receipt.blockNumber &&
        sameHex(transaction.blockHash, receipt.blockHash)
  if (
    receipt.status !== 'success' ||
    !sameHex(receipt.transactionHash, args.transactionHash) ||
    !sameAddress(receipt.from, args.owner) ||
    receipt.to === null ||
    !sameAddress(receipt.to, args.to) ||
    !sameHex(transaction.hash, args.transactionHash) ||
    !transactionBlockMetadataMatches ||
    !sameAddress(transaction.from, args.owner) ||
    transaction.to === null ||
    !sameAddress(transaction.to, args.to) ||
    !sameHex(transaction.input, args.data) ||
    transaction.value !== 0n
  ) {
    fail('STATE_CONFLICT', 'Receipt or transaction identity does not match the looping bundle.')
  }
  return {
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    logs: receipt.logs,
  }
}

export async function verifyLoopingEntryReceiptState(args: {
  client: PublicClient
  preview: Readonly<LoopingEntryExecutionPreview>
  bundle: Readonly<SignedLoopingEntryBundle>
  readiness: Readonly<LoopingBroadcastReadiness>
  transactionHash: Hex
}): Promise<LoopingReceiptVerification> {
  if (!preparedEntryPreviews.has(args.preview)) {
    fail('STATE_CONFLICT', 'Entry receipt verification requires this compiler\'s preview.')
  }
  if (
    !preparedBroadcastReadiness.has(args.readiness) ||
    args.readiness.operation !== 'entry' ||
    !sameAddress(args.readiness.owner, args.preview.owner) ||
    !sameHex(args.readiness.marketId, args.bundle.marketId)
  ) {
    fail('STATE_CONFLICT', 'Entry receipt requires its branded broadcast readiness.')
  }
  await assertSignedEntryBundleBindsPreview(args.preview, args.bundle)
  const market = canonicalExecutionMarket(args.preview.market)
  const mined = await assertSuccessfulLoopingTransaction({
    client: args.client,
    transactionHash: args.transactionHash,
    owner: args.preview.owner,
    to: args.bundle.to,
    data: args.bundle.data,
  })
  const snapshot = await readLoopingReceiptSnapshot({
    client: args.client,
    owner: args.preview.owner,
    market,
    blockNumber: mined.blockNumber,
    includeOracle: true,
    includeMint: args.preview.acquisitionMode === 'mint',
  })
  const deliveredYtOut = args.preview.acquisitionMode === 'mint'
    ? sumMintYieldTokenDelivery({
        logs: mined.logs,
        yieldToken: args.preview.yieldToken,
        adapter: market.contracts.generalAdapter1,
        owner: args.preview.owner,
      })
    : 0n
  if (deliveredYtOut < args.bundle.minimumYtOut) {
    fail('STATE_CONFLICT', 'Entry receipt returned less YT than guaranteed.')
  }
  if (
    snapshot.nonce !== args.bundle.startingNonce + 2n ||
    snapshot.adapterAuthorized ||
    snapshot.adapterAllowance !== 0n
  ) {
    fail('STATE_CONFLICT', 'Entry receipt left an unexpected nonce, authorization, or allowance.')
  }
  if (
    snapshot.position.classification !== 'open-loop' ||
    snapshot.position.supplyShares !== 0n ||
    snapshot.position.borrowShares <= 0n ||
    snapshot.position.borrowShares > args.bundle.maxBorrowShares ||
    snapshot.position.collateral !== args.bundle.minimumCollateral
  ) {
    fail('STATE_CONFLICT', 'Entry receipt did not create the bounded Morpho position.')
  }
  const debtAssets = ceilDiv(
    snapshot.position.borrowShares *
      (snapshot.accrued.totalBorrowAssets + VIRTUAL_ASSETS),
    snapshot.accrued.totalBorrowShares + VIRTUAL_SHARES,
  )
  const entryHealth = calculateEntryHealth({
    market,
    collateral: snapshot.position.collateral,
    borrowAssets: debtAssets,
    oraclePrice: snapshot.accrued.oraclePrice,
  })
  const belowModelBuffer = entryHealth.liquidationBufferBps <
    BigInt(market.launchPolicy.modelMinLiquidationBufferBps)
  const belowEntryValueFloor = args.preview.acquisitionMode === 'market'
    ? entryHealth.collateralLoanValue * BPS <
      (args.preview.equityAssets + debtAssets) *
        BigInt(market.launchPolicy.minEntryValueBps)
    : undefined
  return Object.freeze({
    kind: 'entry-receipt-verified',
    operation: 'entry',
    acquisitionMode: args.preview.acquisitionMode,
    yieldToken: args.preview.yieldToken,
    minimumYtOut: args.preview.minimumYtOut,
    deliveredYtOut,
    owner: args.preview.owner,
    marketId: market.marketId,
    transactionHash: args.transactionHash,
    blockNumber: mined.blockNumber,
    blockHash: mined.blockHash,
    nonce: snapshot.nonce,
    adapterAuthorized: false,
    adapterAllowance: snapshot.adapterAllowance,
    morphoAllowance: snapshot.morphoAllowance,
    ownerLoanBalance: snapshot.ownerLoanBalance,
    position: Object.freeze({ ...snapshot.position }),
    accrued: Object.freeze({ ...snapshot.accrued }),
    entryHealth: Object.freeze(entryHealth),
    belowModelBuffer,
    belowEntryValueFloor,
  })
}

export async function verifyLoopingExitReceiptState(args: {
  client: PublicClient
  preview: Readonly<LoopingExitExecutionPreview>
  bundle: Readonly<SignedLoopingExitBundle>
  readiness: Readonly<LoopingBroadcastReadiness>
  transactionHash: Hex
}): Promise<LoopingReceiptVerification> {
  if (!preparedExitPreviews.has(args.preview)) {
    fail('STATE_CONFLICT', 'Exit receipt verification requires this compiler\'s preview.')
  }
  if (
    !preparedBroadcastReadiness.has(args.readiness) ||
    args.readiness.operation !== 'exit' ||
    !sameAddress(args.readiness.owner, args.preview.owner) ||
    !sameHex(args.readiness.marketId, args.bundle.marketId)
  ) {
    fail('STATE_CONFLICT', 'Exit receipt requires its branded broadcast readiness.')
  }
  await assertSignedExitBundleBindsPreview(args.preview, args.bundle)
  const market = canonicalExecutionMarket(args.preview.market)
  const mined = await assertSuccessfulLoopingTransaction({
    client: args.client,
    transactionHash: args.transactionHash,
    owner: args.preview.owner,
    to: args.bundle.to,
    data: args.bundle.data,
  })
  const snapshot = await readLoopingReceiptSnapshot({
    client: args.client,
    owner: args.preview.owner,
    market,
    blockNumber: mined.blockNumber,
    includeOracle: false,
    includeMint: false,
  })
  if (
    snapshot.nonce !== args.bundle.startingNonce + 2n ||
    snapshot.adapterAuthorized
  ) {
    fail('STATE_CONFLICT', 'Exit receipt left an unexpected nonce or authorization.')
  }
  if (snapshot.position.classification !== 'empty') {
    fail('STATE_CONFLICT', 'Exit receipt did not fully close the Morpho position.')
  }
  if (
    snapshot.ownerLoanBalance <
      args.readiness.ownerLoanBalance + args.bundle.minimumReturnedAssets
  ) {
    fail('STATE_CONFLICT', 'Exit receipt returned less loan token than guaranteed.')
  }
  return Object.freeze({
    kind: 'exit-receipt-verified',
    operation: 'exit',
    owner: args.preview.owner,
    marketId: market.marketId,
    transactionHash: args.transactionHash,
    blockNumber: mined.blockNumber,
    blockHash: mined.blockHash,
    nonce: snapshot.nonce,
    adapterAuthorized: false,
    adapterAllowance: snapshot.adapterAllowance,
    morphoAllowance: snapshot.morphoAllowance,
    ownerLoanBalance: snapshot.ownerLoanBalance,
    position: Object.freeze({ ...snapshot.position }),
    accrued: Object.freeze({ ...snapshot.accrued }),
  })
}

export async function verifyLoopingIncreaseReceiptState(args: {
  client: PublicClient
  preview: Readonly<LoopingIncreaseExecutionPreview>
  bundle: Readonly<SignedLoopingIncreaseBundle>
  readiness: Readonly<LoopingBroadcastReadiness>
  transactionHash: Hex
}): Promise<LoopingIncreaseReceiptVerification> {
  if (!preparedIncreasePreviews.has(args.preview)) {
    fail('STATE_CONFLICT', 'Increase receipt verification requires this compiler\'s preview.')
  }
  if (
    !preparedBroadcastReadiness.has(args.readiness) ||
    args.readiness.operation !== 'entry' ||
    !sameAddress(args.readiness.owner, args.preview.owner) ||
    !sameHex(args.readiness.marketId, args.bundle.marketId)
  ) {
    fail('STATE_CONFLICT', 'Increase receipt requires its branded broadcast readiness.')
  }
  await assertSignedIncreaseBundleBindsPreview(args.preview, args.bundle)
  const market = canonicalExecutionMarket(args.preview.market)
  const mined = await assertSuccessfulLoopingTransaction({
    client: args.client,
    transactionHash: args.transactionHash,
    owner: args.preview.owner,
    to: args.bundle.to,
    data: args.bundle.data,
  })
  const snapshot = await readLoopingReceiptSnapshot({
    client: args.client,
    owner: args.preview.owner,
    market,
    blockNumber: mined.blockNumber,
    includeOracle: true,
    includeMint: args.preview.acquisitionMode === 'mint',
  })
  const deliveredYtOut = args.preview.acquisitionMode === 'mint'
    ? sumMintYieldTokenDelivery({
        logs: mined.logs,
        yieldToken: args.preview.yieldToken,
        adapter: market.contracts.generalAdapter1,
        owner: args.preview.owner,
      })
    : 0n
  if (deliveredYtOut < args.bundle.minimumYtOut) {
    fail('STATE_CONFLICT', 'Increase receipt returned less YT than guaranteed.')
  }
  if (
    snapshot.nonce !== args.bundle.startingNonce + 2n ||
    snapshot.adapterAuthorized ||
    snapshot.adapterAllowance !== args.preview.wiring.adapterAllowance
  ) {
    fail('STATE_CONFLICT', 'Increase receipt left an unexpected nonce, authorization, or allowance.')
  }
  const addedBorrowShares =
    snapshot.position.borrowShares - args.bundle.startingBorrowShares
  if (
    snapshot.position.classification !== 'open-loop' ||
    snapshot.position.supplyShares !== 0n ||
    addedBorrowShares <= 0n ||
    addedBorrowShares > args.bundle.maxAddedBorrowShares ||
    snapshot.position.collateral !==
      args.bundle.startingCollateral + args.bundle.minimumAddedCollateral
  ) {
    fail('STATE_CONFLICT', 'Increase receipt did not create the bounded Morpho adjustment.')
  }
  const achieved = deriveCurrentLeverage({
    market,
    position: snapshot.position,
    accrued: snapshot.accrued,
  })
  if (
    achieved.leverageWad > args.bundle.targetLeverageWad ||
    achieved.leverageWad <= args.preview.current.leverageWad
  ) {
    fail('STATE_CONFLICT', 'Increase receipt did not achieve the bounded leverage direction.')
  }
  const belowModelBuffer = achieved.liquidationBufferBps <
    BigInt(market.launchPolicy.modelMinLiquidationBufferBps)
  return Object.freeze({
    kind: 'increase-receipt-verified',
    operation: 'entry',
    acquisitionMode: args.preview.acquisitionMode,
    yieldToken: args.preview.yieldToken,
    minimumYtOut: args.preview.minimumYtOut,
    deliveredYtOut,
    owner: args.preview.owner,
    marketId: market.marketId,
    transactionHash: args.transactionHash,
    blockNumber: mined.blockNumber,
    blockHash: mined.blockHash,
    nonce: snapshot.nonce,
    adapterAuthorized: false,
    adapterAllowance: snapshot.adapterAllowance,
    morphoAllowance: snapshot.morphoAllowance,
    ownerLoanBalance: snapshot.ownerLoanBalance,
    position: Object.freeze({ ...snapshot.position }),
    accrued: Object.freeze({ ...snapshot.accrued }),
    achieved: Object.freeze(achieved),
    belowModelBuffer,
  })
}

export async function verifyLoopingDecreaseReceiptState(args: {
  client: PublicClient
  preview: Readonly<LoopingDecreaseExecutionPreview>
  bundle: Readonly<SignedLoopingDecreaseBundle>
  readiness: Readonly<LoopingBroadcastReadiness>
  transactionHash: Hex
}): Promise<LoopingDecreaseReceiptVerification> {
  if (!preparedDecreasePreviews.has(args.preview)) {
    fail('STATE_CONFLICT', 'Decrease receipt verification requires this compiler\'s preview.')
  }
  if (
    !preparedBroadcastReadiness.has(args.readiness) ||
    args.readiness.operation !== 'exit' ||
    !sameAddress(args.readiness.owner, args.preview.owner) ||
    !sameHex(args.readiness.marketId, args.bundle.marketId)
  ) {
    fail('STATE_CONFLICT', 'Decrease receipt requires its branded broadcast readiness.')
  }
  await assertSignedDecreaseBundleBindsPreview(args.preview, args.bundle)
  const market = canonicalExecutionMarket(args.preview.market)
  const mined = await assertSuccessfulLoopingTransaction({
    client: args.client,
    transactionHash: args.transactionHash,
    owner: args.preview.owner,
    to: args.bundle.to,
    data: args.bundle.data,
  })
  const snapshot = await readLoopingReceiptSnapshot({
    client: args.client,
    owner: args.preview.owner,
    market,
    blockNumber: mined.blockNumber,
    includeOracle: true,
    includeMint: false,
  })
  if (
    snapshot.nonce !== args.bundle.startingNonce + 2n ||
    snapshot.adapterAuthorized ||
    snapshot.adapterAllowance !== args.preview.wiring.adapterAllowance
  ) {
    fail('STATE_CONFLICT', 'Decrease receipt left an unexpected nonce, authorization, or allowance.')
  }
  if (
    snapshot.position.classification !== 'open-loop' ||
    snapshot.position.supplyShares !== 0n ||
    snapshot.position.borrowShares !==
      args.bundle.startingBorrowShares - args.bundle.exactRepayShares ||
    snapshot.position.collateral !==
      args.bundle.startingCollateral - args.bundle.exactCollateralToSell
  ) {
    fail('STATE_CONFLICT', 'Decrease receipt did not create the exact Morpho adjustment.')
  }
  if (
    snapshot.ownerLoanBalance <
      args.readiness.ownerLoanBalance + args.bundle.minimumReturnedAssets
  ) {
    fail('STATE_CONFLICT', 'Decrease receipt returned less loan token than guaranteed.')
  }
  const achieved = deriveCurrentLeverage({
    market,
    position: snapshot.position,
    accrued: snapshot.accrued,
  })
  if (
    achieved.leverageWad > args.bundle.targetLeverageWad ||
    achieved.leverageWad >= args.preview.current.leverageWad ||
    achieved.liquidationBufferBps <=
      args.preview.current.liquidationBufferBps
  ) {
    fail('STATE_CONFLICT', 'Decrease receipt did not achieve the safer leverage direction.')
  }
  return Object.freeze({
    kind: 'decrease-receipt-verified',
    operation: 'exit',
    owner: args.preview.owner,
    marketId: market.marketId,
    transactionHash: args.transactionHash,
    blockNumber: mined.blockNumber,
    blockHash: mined.blockHash,
    nonce: snapshot.nonce,
    adapterAuthorized: false,
    adapterAllowance: snapshot.adapterAllowance,
    morphoAllowance: snapshot.morphoAllowance,
    ownerLoanBalance: snapshot.ownerLoanBalance,
    position: Object.freeze({ ...snapshot.position }),
    accrued: Object.freeze({ ...snapshot.accrued }),
    achieved: Object.freeze(achieved),
  })
}
