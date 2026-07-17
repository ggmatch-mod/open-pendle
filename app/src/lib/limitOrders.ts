/**
 * Pendle PT limit orders — framework-free data, validation, and API helpers.
 *
 * Signed scope is deliberately narrow:
 * - PT <-> SY only (`TOKEN_FOR_PT` / `PT_FOR_TOKEN`);
 * - EOA signatures (65-byte ECDSA) only;
 * - no permit payloads (`permit` must be `0x`);
 * - every API response is runtime-validated before it can reach typed-data
 *   signing or transaction construction.
 *
 * The API helpers accept an injected `fetchFn`, which keeps the safety suite
 * network-free and lets the UI attach an AbortSignal without global state.
 */

import { getAddress, hashDomain, hashTypedData, isAddress } from 'viem'
import type { Address, Hex } from 'viem'
import type { ActionPlan } from './types.ts'

export const PENDLE_CORE_API_BASE = 'https://api-v2.pendle.finance/core'

export const TOKEN_FOR_PT = 0 as const
export const PT_FOR_TOKEN = 1 as const
export type PtSyLimitOrderType = typeof TOKEN_FOR_PT | typeof PT_FOR_TOKEN

export const LIMIT_ORDER_SALT_DIVISOR = 12_421n
export const PENDLE_LIMIT_ORDER_DOMAIN_NAME = 'Pendle Limit Order Protocol'
export const PENDLE_LIMIT_ORDER_DOMAIN_VERSION = '1'
export const DEFAULT_LIMIT_ORDER_APY_TOLERANCE = 1e-9

export const PENDLE_LIMIT_ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'orderType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'YT', type: 'address' },
    { name: 'maker', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'makingAmount', type: 'uint256' },
    { name: 'lnImpliedRate', type: 'uint256' },
    { name: 'failSafeRate', type: 'uint256' },
    { name: 'permit', type: 'bytes' },
  ],
} as const

const EIP712_DOMAIN_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
} as const

const UINT256_MAX = (1n << 256n) - 1n

const LIMIT_ORDER_STATUSES = [
  'FILLABLE',
  'PARTIAL_FILLABLE',
  'FAILED_TRANSFER_TOKEN',
  'EMPTY_MAKER_BALANCE',
  'CANCELLED',
  'FULLY_FILLED',
  'EXPIRED',
] as const

export type LimitOrderStatus = (typeof LIMIT_ORDER_STATUSES)[number]
export type LimitOrderApiErrorKind = 'network' | 'http' | 'invalid-response'

export class LimitOrderValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'LimitOrderValidationError'
    this.path = path
  }
}

export class LimitOrderApiError extends Error {
  readonly kind: LimitOrderApiErrorKind
  readonly httpStatus?: number

  constructor(kind: LimitOrderApiErrorKind, message: string, httpStatus?: number) {
    super(message)
    this.name = 'LimitOrderApiError'
    this.kind = kind
    this.httpStatus = httpStatus
  }
}

export interface LimitOrderSupport {
  id: string
  chainId: number
  yt: Address
  market: Address
  sy: Address
  name: string
  tokenIns: Address[]
  tokenOuts: Address[]
  lnFeeRateRoot: bigint
}

export interface LimitOrderBookEntry {
  impliedApy: number
  limitOrderSize: bigint
  ammSize?: bigint
  incentiveQualifiedPySize?: bigint
}

export interface LimitOrderBook {
  longYieldEntries: LimitOrderBookEntry[]
  shortYieldEntries: LimitOrderBookEntry[]
}

export interface LimitOrderMarketContext {
  chainId: number
  market: Address
  yt: Address
  sy: Address
}

export interface PtSyLimitOrderIntent extends LimitOrderMarketContext {
  maker: Address
  token: Address
  orderType: PtSyLimitOrderType
  makingAmount: bigint
  impliedApy: number
  expiry: bigint
  marketExpiry: bigint
  nonce: bigint
}

export interface GenerateLimitOrderRequest {
  chainId: number
  YT: Address
  orderType: PtSyLimitOrderType
  token: Address
  maker: Address
  makingAmount: string
  impliedApy: number
  expiry: string
}

export interface GeneratedLimitOrder {
  chainId: number
  YT: Address
  salt: bigint
  expiry: bigint
  nonce: bigint
  token: Address
  orderType: PtSyLimitOrderType
  failSafeRate: bigint
  maker: Address
  receiver: Address
  makingAmount: bigint
  permit: Hex
  lnImpliedRate: bigint
}

export interface LimitOrderStruct {
  salt: bigint
  expiry: bigint
  nonce: bigint
  orderType: PtSyLimitOrderType
  token: Address
  YT: Address
  maker: Address
  receiver: Address
  makingAmount: bigint
  lnImpliedRate: bigint
  failSafeRate: bigint
  permit: Hex
}

export interface CreateLimitOrderDto {
  chainId: number
  signature: Hex
  salt: string
  expiry: string
  nonce: string
  type: PtSyLimitOrderType
  token: Address
  yt: Address
  maker: Address
  receiver: Address
  makingAmount: string
  lnImpliedRate: string
  failSafeRate: string
  permit: Hex
}

export interface LimitOrderFilledStatus {
  netInputFromMaker: bigint
  netOutputToMaker: bigint
  feeAmount: bigint
  notionalVolume: bigint
}

export interface LimitOrderRecord {
  id: Hex
  signature: Hex
  chainId: number
  salt: bigint
  expiry: bigint
  nonce: bigint
  type: PtSyLimitOrderType
  token: Address
  yt: Address
  maker: Address
  receiver: Address
  makingAmount: bigint
  currentMakingAmount: bigint
  lnImpliedRate: bigint
  failSafeRate: bigint
  permit: Hex
  orderFilledStatus: LimitOrderFilledStatus
  isActive: boolean
  isCanceled: boolean
  createdAt: string
  fullyExecutedTimestamp?: string
  canceledTimestamp?: string
  latestEventTimestamp?: string
  sy: Address
  pt: Address
  makerBalance: bigint
  failedMintSy: boolean
  failedMintSyReason: string
  orderBookBalance: bigint
  makingToken: Address
  takingToken: Address
  status: LimitOrderStatus
}

export interface MakerLimitOrdersResponse {
  total: number
  limit: number
  skip: number
  results: LimitOrderRecord[]
}

export interface LimitOrderApiOptions {
  baseUrl?: string
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

export type LimitOrderSupportResult =
  | { status: 'supported'; support: LimitOrderSupport }
  | { status: 'unsupported' }
  | { status: 'unavailable'; error: string; httpStatus?: number }

export type SubmitLimitOrderResult =
  | { status: 'submitted'; order: LimitOrderRecord }
  | { status: 'rejected'; error: string; httpStatus: number }
  | { status: 'ambiguous'; error: string; httpStatus?: number }

export type ReconcileLimitOrderResult =
  | { status: 'found'; order: LimitOrderRecord }
  | { status: 'not-found'; definitive: false }
  | { status: 'unavailable'; error: string; httpStatus?: number }

export interface MakerLimitOrdersQuery {
  chainId: number
  maker: Address
  yt: Address
  /** Direct-SY MVP context; conversion-token orders must not enter the UI. */
  sy: Address
  /** Verifying contract used to prove each API row's id matches its signed struct. */
  limitRouter: Address
  orderType: PtSyLimitOrderType
  isActive?: boolean
  skip?: number
  limit?: number
}

export interface LimitOrderBookQuery {
  chainId: number
  market: Address
  precisionDecimal?: number
  includeAmm?: boolean
  limit?: number
}

export interface ValidateGeneratedLimitOrderOptions {
  nowUnixSeconds?: bigint
  apyTolerance?: number
}

export interface LimitRouterPlanInputs {
  limitRouter: Address
  abi: readonly unknown[]
  maker: Address
  sy: Address
}

function fail(path: string, message: string): never {
  throw new LimitOrderValidationError(path, message)
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'expected an object')
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    return fail(path, allowEmpty ? 'expected a string' : 'expected a non-empty string')
  }
  return value
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return fail(path, 'expected a boolean')
  return value
}

function asSafeInteger(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    return fail(path, `expected a safe integer from ${min} to ${max}`)
  }
  return value as number
}

function asFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(path, 'expected a finite number')
  }
  return value
}

function asUintString(value: unknown, path: string): { raw: string; value: bigint } {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return fail(path, 'expected a canonical unsigned decimal string')
  }
  const parsed = BigInt(value)
  if (parsed > UINT256_MAX) return fail(path, 'exceeds uint256')
  return { raw: value, value: parsed }
}

function asBookSize(value: unknown, path: string): bigint {
  if (typeof value === 'string') return asUintString(value, path).value
  if (Number.isSafeInteger(value) && (value as number) >= 0) return BigInt(value as number)
  return fail(path, 'expected a non-negative bigint string or safe integer')
}

function asAddress(value: unknown, path: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    return fail(path, 'expected an EVM address')
  }
  return getAddress(value)
}

function asHex(value: unknown, path: string, bytes?: number): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    return fail(path, 'expected a 0x-prefixed even-length hex string')
  }
  if (bytes !== undefined && value.length !== 2 + bytes * 2) {
    return fail(path, `expected exactly ${bytes} bytes`)
  }
  return value as Hex
}

function asIsoTimestamp(value: unknown, path: string): string {
  const timestamp = asString(value, path)
  if (!Number.isFinite(Date.parse(timestamp))) return fail(path, 'expected a valid timestamp')
  return timestamp
}

function optionalIsoTimestamp(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return asIsoTimestamp(value, path)
}

function asRecordSignature(value: unknown, path: string): Hex {
  const signature = asHex(value, path)
  // Pendle's API also exposes pre-signed on-chain orders with an empty
  // signature. Newly submitted EOA maker orders still require 65 bytes in
  // createLimitOrderDto; history parsing may safely retain either form.
  if (signature !== '0x' && signature.length !== 2 + 65 * 2) {
    return fail(path, 'expected an empty pre-signed signature or exactly 65 bytes')
  }
  return signature
}

function asPtSyOrderType(value: unknown, path: string): PtSyLimitOrderType {
  if (value !== TOKEN_FOR_PT && value !== PT_FOR_TOKEN) {
    return fail(path, 'expected PT order type 0 (TOKEN_FOR_PT) or 1 (PT_FOR_TOKEN)')
  }
  return value
}

function asStatus(value: unknown, path: string): LimitOrderStatus {
  if (typeof value !== 'string' || !LIMIT_ORDER_STATUSES.includes(value as LimitOrderStatus)) {
    return fail(path, 'unknown limit-order status')
  }
  return value as LimitOrderStatus
}

function asAddressArray(value: unknown, path: string): Address[] {
  if (!Array.isArray(value)) return fail(path, 'expected an address array')
  const parsed = value.map((entry, index) => asAddress(entry, `${path}[${index}]`))
  const unique = new Set(parsed.map((address) => address.toLowerCase()))
  if (unique.size !== parsed.length) return fail(path, 'duplicate address')
  return parsed
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function containsAddress(addresses: readonly Address[], target: Address): boolean {
  return addresses.some((address) => sameAddress(address, target))
}

function assertChainId(value: number, path = 'chainId'): void {
  asSafeInteger(value, path, 1)
}

function normalizeAddressInput(value: Address, path: string): Address {
  return asAddress(value, path)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nowUnixSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000))
}

function apiUrl(path: string, options: LimitOrderApiOptions): URL {
  const base = (options.baseUrl ?? PENDLE_CORE_API_BASE).replace(/\/+$/, '')
  return new URL(`${base}/${path.replace(/^\/+/, '')}`)
}

function apiFetch(options: LimitOrderApiOptions): typeof fetch {
  if (options.fetchFn) return options.fetchFn
  if (typeof globalThis.fetch !== 'function') {
    throw new LimitOrderApiError('network', 'Fetch is unavailable in this environment.')
  }
  // Do not return Window.fetch unbound: Safari and the in-app browser enforce
  // its receiver and throw "Illegal invocation" when it loses `window`.
  return (input, init) => globalThis.fetch(input, init)
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.trim() === '') throw new LimitOrderValidationError('response', 'empty JSON body')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new LimitOrderValidationError('response', 'invalid JSON body')
  }
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = asObject(await responseJson(response), 'errorResponse')
    const message = body.message
    if (typeof message === 'string' && message.length > 0) return message
    const error = body.error
    if (typeof error === 'string' && error.length > 0) return error
  } catch {
    // Status text is the safe fallback for malformed/empty error bodies.
  }
  return response.statusText || `HTTP ${response.status}`
}

async function strictApiJson(
  url: URL,
  init: RequestInit,
  options: LimitOrderApiOptions,
): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(options)(url, { ...init, signal: options.signal })
  } catch (error) {
    throw new LimitOrderApiError('network', errorMessage(error))
  }
  if (!response.ok) {
    throw new LimitOrderApiError(
      'http',
      await responseError(response),
      response.status,
    )
  }
  try {
    return await responseJson(response)
  } catch (error) {
    throw new LimitOrderApiError('invalid-response', errorMessage(error), response.status)
  }
}

export function parseLimitOrderSupport(value: unknown): LimitOrderSupport {
  const object = asObject(value, 'support')
  const chainId = asSafeInteger(object.chainId, 'support.chainId', 1)
  const yt = asAddress(object.yt, 'support.yt')
  const lnFeeRateRoot = asUintString(object.lnFeeRateRoot, 'support.lnFeeRateRoot').value
  if (lnFeeRateRoot <= 0n) return fail('support.lnFeeRateRoot', 'must be positive')

  return {
    id: asString(object.id, 'support.id'),
    chainId,
    yt,
    market: asAddress(object.market, 'support.market'),
    sy: asAddress(object.sy, 'support.sy'),
    name: asString(object.name, 'support.name'),
    tokenIns: asAddressArray(object.tokenIns, 'support.tokenIns'),
    tokenOuts: asAddressArray(object.tokenOuts, 'support.tokenOuts'),
    lnFeeRateRoot,
  }
}

function parseLimitOrderBookEntry(value: unknown, path: string): LimitOrderBookEntry {
  const object = asObject(value, path)
  const parsed: LimitOrderBookEntry = {
    impliedApy: asFiniteNumber(object.impliedApy, `${path}.impliedApy`),
    limitOrderSize: asBookSize(object.limitOrderSize, `${path}.limitOrderSize`),
  }
  if (object.ammSize !== undefined && object.ammSize !== null) {
    parsed.ammSize = asBookSize(object.ammSize, `${path}.ammSize`)
  }
  if (object.incentiveQualifiedPySize !== undefined && object.incentiveQualifiedPySize !== null) {
    parsed.incentiveQualifiedPySize = asBookSize(
      object.incentiveQualifiedPySize,
      `${path}.incentiveQualifiedPySize`,
    )
  }
  return parsed
}

export function parseLimitOrderBook(value: unknown): LimitOrderBook {
  const object = asObject(value, 'orderBook')
  if (!Array.isArray(object.longYieldEntries)) {
    return fail('orderBook.longYieldEntries', 'expected an array')
  }
  if (!Array.isArray(object.shortYieldEntries)) {
    return fail('orderBook.shortYieldEntries', 'expected an array')
  }
  return {
    longYieldEntries: object.longYieldEntries.map((entry, index) =>
      parseLimitOrderBookEntry(entry, `orderBook.longYieldEntries[${index}]`),
    ),
    shortYieldEntries: object.shortYieldEntries.map((entry, index) =>
      parseLimitOrderBookEntry(entry, `orderBook.shortYieldEntries[${index}]`),
    ),
  }
}

export function parseGeneratedLimitOrder(value: unknown): GeneratedLimitOrder {
  const object = asObject(value, 'generatedOrder')
  return {
    chainId: asSafeInteger(object.chainId, 'generatedOrder.chainId', 1),
    YT: asAddress(object.YT, 'generatedOrder.YT'),
    salt: asUintString(object.salt, 'generatedOrder.salt').value,
    expiry: asUintString(object.expiry, 'generatedOrder.expiry').value,
    nonce: asUintString(object.nonce, 'generatedOrder.nonce').value,
    token: asAddress(object.token, 'generatedOrder.token'),
    orderType: asPtSyOrderType(object.orderType, 'generatedOrder.orderType'),
    failSafeRate: asUintString(object.failSafeRate, 'generatedOrder.failSafeRate').value,
    maker: asAddress(object.maker, 'generatedOrder.maker'),
    receiver: asAddress(object.receiver, 'generatedOrder.receiver'),
    makingAmount: asUintString(object.makingAmount, 'generatedOrder.makingAmount').value,
    permit: asHex(object.permit, 'generatedOrder.permit'),
    // The live OpenAPI marks this as integer/int64 while its own description
    // says bigint string. A JSON number would already have lost precision.
    lnImpliedRate: asUintString(object.lnImpliedRate, 'generatedOrder.lnImpliedRate').value,
  }
}

function parseFilledStatus(value: unknown, path: string): LimitOrderFilledStatus {
  const object = asObject(value, path)
  return {
    netInputFromMaker: asUintString(object.netInputFromMaker, `${path}.netInputFromMaker`).value,
    netOutputToMaker: asUintString(object.netOutputToMaker, `${path}.netOutputToMaker`).value,
    feeAmount: asUintString(object.feeAmount, `${path}.feeAmount`).value,
    notionalVolume: asUintString(object.notionalVolume, `${path}.notionalVolume`).value,
  }
}

export function parseLimitOrderRecord(value: unknown): LimitOrderRecord {
  const object = asObject(value, 'limitOrder')
  const makingAmount = asUintString(object.makingAmount, 'limitOrder.makingAmount').value
  const currentMakingAmount = asUintString(
    object.currentMakingAmount,
    'limitOrder.currentMakingAmount',
  ).value
  if (currentMakingAmount > makingAmount) {
    return fail('limitOrder.currentMakingAmount', 'cannot exceed makingAmount')
  }

  return {
    id: asHex(object.id, 'limitOrder.id', 32),
    signature: asRecordSignature(object.signature, 'limitOrder.signature'),
    chainId: asSafeInteger(object.chainId, 'limitOrder.chainId', 1),
    salt: asUintString(object.salt, 'limitOrder.salt').value,
    expiry: asUintString(object.expiry, 'limitOrder.expiry').value,
    nonce: asUintString(object.nonce, 'limitOrder.nonce').value,
    type: asPtSyOrderType(object.type, 'limitOrder.type'),
    token: asAddress(object.token, 'limitOrder.token'),
    yt: asAddress(object.yt, 'limitOrder.yt'),
    maker: asAddress(object.maker, 'limitOrder.maker'),
    receiver: asAddress(object.receiver, 'limitOrder.receiver'),
    makingAmount,
    currentMakingAmount,
    lnImpliedRate: asUintString(object.lnImpliedRate, 'limitOrder.lnImpliedRate').value,
    failSafeRate: asUintString(object.failSafeRate, 'limitOrder.failSafeRate').value,
    permit: asHex(object.permit, 'limitOrder.permit'),
    orderFilledStatus: parseFilledStatus(object.orderFilledStatus, 'limitOrder.orderFilledStatus'),
    isActive: asBoolean(object.isActive, 'limitOrder.isActive'),
    isCanceled: asBoolean(object.isCanceled, 'limitOrder.isCanceled'),
    createdAt: asIsoTimestamp(object.createdAt, 'limitOrder.createdAt'),
    fullyExecutedTimestamp: optionalIsoTimestamp(
      object.fullyExecutedTimestamp,
      'limitOrder.fullyExecutedTimestamp',
    ),
    canceledTimestamp: optionalIsoTimestamp(object.canceledTimestamp, 'limitOrder.canceledTimestamp'),
    latestEventTimestamp: optionalIsoTimestamp(
      object.latestEventTimestamp,
      'limitOrder.latestEventTimestamp',
    ),
    sy: asAddress(object.sy, 'limitOrder.sy'),
    pt: asAddress(object.pt, 'limitOrder.pt'),
    makerBalance: asUintString(object.makerBalance, 'limitOrder.makerBalance').value,
    failedMintSy: asBoolean(object.failedMintSy, 'limitOrder.failedMintSy'),
    failedMintSyReason: asString(object.failedMintSyReason, 'limitOrder.failedMintSyReason', true),
    orderBookBalance: asUintString(object.orderBookBalance, 'limitOrder.orderBookBalance').value,
    makingToken: asAddress(object.makingToken, 'limitOrder.makingToken'),
    takingToken: asAddress(object.takingToken, 'limitOrder.takingToken'),
    status: asStatus(object.status, 'limitOrder.status'),
  }
}

export function parseMakerLimitOrdersResponse(
  value: unknown,
  expectedOrderType?: PtSyLimitOrderType,
): MakerLimitOrdersResponse {
  const object = asObject(value, 'makerOrders')
  if (!Array.isArray(object.results)) return fail('makerOrders.results', 'expected an array')
  const results = object.results.map((entry) => parseLimitOrderRecord(entry))
  if (expectedOrderType !== undefined) {
    const mismatch = results.find((order) => order.type !== expectedOrderType)
    if (mismatch) return fail('makerOrders.results', 'API returned an unexpected order type')
  }
  return {
    total: asSafeInteger(object.total, 'makerOrders.total'),
    limit: asSafeInteger(object.limit, 'makerOrders.limit'),
    skip: asSafeInteger(object.skip, 'makerOrders.skip'),
    results,
  }
}

export function validateSupportForPtSy(
  support: LimitOrderSupport,
  context: LimitOrderMarketContext,
  orderType: PtSyLimitOrderType,
): LimitOrderSupport {
  assertChainId(context.chainId, 'context.chainId')
  const market = normalizeAddressInput(context.market, 'context.market')
  const yt = normalizeAddressInput(context.yt, 'context.yt')
  const sy = normalizeAddressInput(context.sy, 'context.sy')
  asPtSyOrderType(orderType, 'orderType')

  if (support.chainId !== context.chainId) return fail('support.chainId', 'does not match context')
  if (!sameAddress(support.yt, yt)) return fail('support.yt', 'does not match context')
  if (!sameAddress(support.market, market)) return fail('support.market', 'does not match context')
  if (!sameAddress(support.sy, sy)) return fail('support.sy', 'does not match context')
  if (support.id.toLowerCase() !== `${context.chainId}-${yt.toLowerCase()}`) {
    return fail('support.id', 'does not identify the requested chain and YT')
  }
  const supportedTokens = orderType === TOKEN_FOR_PT ? support.tokenIns : support.tokenOuts
  if (!containsAddress(supportedTokens, sy)) {
    return fail(
      orderType === TOKEN_FOR_PT ? 'support.tokenIns' : 'support.tokenOuts',
      'SY is not supported for this PT order direction',
    )
  }
  return support
}

export function validatePtSyLimitOrderIntent(
  intent: PtSyLimitOrderIntent,
  now = nowUnixSeconds(),
): PtSyLimitOrderIntent {
  assertChainId(intent.chainId, 'intent.chainId')
  normalizeAddressInput(intent.market, 'intent.market')
  normalizeAddressInput(intent.yt, 'intent.yt')
  const sy = normalizeAddressInput(intent.sy, 'intent.sy')
  normalizeAddressInput(intent.maker, 'intent.maker')
  const token = normalizeAddressInput(intent.token, 'intent.token')
  asPtSyOrderType(intent.orderType, 'intent.orderType')
  if (!sameAddress(token, sy)) return fail('intent.token', 'PT limit-order MVP only supports SY')
  if (intent.makingAmount <= 0n) return fail('intent.makingAmount', 'must be positive')
  if (!Number.isFinite(intent.impliedApy) || intent.impliedApy < 0) {
    return fail('intent.impliedApy', 'must be a finite, non-negative decimal fraction')
  }
  if (intent.expiry <= now) return fail('intent.expiry', 'must be in the future')
  if (intent.marketExpiry <= intent.expiry) {
    return fail('intent.expiry', 'must be strictly below market maturity')
  }
  if (intent.nonce < 0n) return fail('intent.nonce', 'must be non-negative')
  return intent
}

export function apyFromLnImpliedRate(lnImpliedRate: bigint): number {
  if (lnImpliedRate < 0n) return fail('lnImpliedRate', 'must be non-negative')
  const scaled = Number(lnImpliedRate) / 1e18
  const apy = Math.expm1(scaled)
  if (!Number.isFinite(apy)) return fail('lnImpliedRate', 'does not encode a finite APY')
  return apy
}

export function validateGeneratedLimitOrder(
  order: GeneratedLimitOrder,
  intent: PtSyLimitOrderIntent,
  options: ValidateGeneratedLimitOrderOptions = {},
): GeneratedLimitOrder {
  const now = options.nowUnixSeconds ?? nowUnixSeconds()
  validatePtSyLimitOrderIntent(intent, now)

  if (order.chainId !== intent.chainId) return fail('generatedOrder.chainId', 'does not match intent')
  if (!sameAddress(order.YT, intent.yt)) return fail('generatedOrder.YT', 'does not match intent')
  if (!sameAddress(order.token, intent.token)) return fail('generatedOrder.token', 'does not match intent')
  if (order.orderType !== intent.orderType) {
    return fail('generatedOrder.orderType', 'does not match intent')
  }
  if (!sameAddress(order.maker, intent.maker)) {
    return fail('generatedOrder.maker', 'does not match intent')
  }
  if (!sameAddress(order.receiver, intent.maker)) {
    return fail('generatedOrder.receiver', 'must be the maker for the MVP')
  }
  if (order.makingAmount !== intent.makingAmount) {
    return fail('generatedOrder.makingAmount', 'does not match intent')
  }
  if (order.expiry !== intent.expiry) return fail('generatedOrder.expiry', 'does not match intent')
  if (order.expiry <= now || order.expiry >= intent.marketExpiry) {
    return fail('generatedOrder.expiry', 'must be future and strictly below market maturity')
  }
  if (order.nonce !== intent.nonce) return fail('generatedOrder.nonce', 'does not match live nonce')
  if (order.salt <= 0n || order.salt % LIMIT_ORDER_SALT_DIVISOR !== 0n) {
    return fail('generatedOrder.salt', `must be positive and divisible by ${LIMIT_ORDER_SALT_DIVISOR}`)
  }
  if (order.permit !== '0x') return fail('generatedOrder.permit', 'must be empty for the MVP')
  // Pendle currently emits a non-zero failSafeRate for some direct-SY orders.
  // The Limit Router bypasses that conversion guard when token === SY, which
  // this MVP enforces above. Preserve the API value exactly in the signed DTO;
  // do not invent a canonical value that would reject otherwise valid orders.

  const tolerance = options.apyTolerance ?? DEFAULT_LIMIT_ORDER_APY_TOLERANCE
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    return fail('apyTolerance', 'must be a finite non-negative number')
  }
  const signedApy = apyFromLnImpliedRate(order.lnImpliedRate)
  if (Math.abs(signedApy - intent.impliedApy) > tolerance) {
    return fail(
      'generatedOrder.lnImpliedRate',
      `signed APY ${signedApy} differs from requested APY ${intent.impliedApy}`,
    )
  }
  return order
}

export function createGenerateLimitOrderRequest(
  intent: PtSyLimitOrderIntent,
  now?: bigint,
): GenerateLimitOrderRequest {
  validatePtSyLimitOrderIntent(intent, now)
  return {
    chainId: intent.chainId,
    YT: getAddress(intent.yt),
    orderType: intent.orderType,
    token: getAddress(intent.token),
    maker: getAddress(intent.maker),
    makingAmount: intent.makingAmount.toString(),
    impliedApy: intent.impliedApy,
    expiry: intent.expiry.toString(),
  }
}

export function toLimitOrderStruct(order: GeneratedLimitOrder | LimitOrderRecord): LimitOrderStruct {
  return {
    salt: order.salt,
    expiry: order.expiry,
    nonce: order.nonce,
    orderType: 'orderType' in order ? order.orderType : order.type,
    token: order.token,
    YT: 'YT' in order ? order.YT : order.yt,
    maker: order.maker,
    receiver: order.receiver,
    makingAmount: order.makingAmount,
    lnImpliedRate: order.lnImpliedRate,
    failSafeRate: order.failSafeRate,
    permit: order.permit,
  }
}

export function buildLimitOrderDomain(chainId: number, limitRouter: Address) {
  assertChainId(chainId)
  return {
    name: PENDLE_LIMIT_ORDER_DOMAIN_NAME,
    version: PENDLE_LIMIT_ORDER_DOMAIN_VERSION,
    chainId,
    verifyingContract: normalizeAddressInput(limitRouter, 'limitRouter'),
  } as const
}

export function buildLimitOrderTypedData(
  order: GeneratedLimitOrder | LimitOrderRecord,
  chainId: number,
  limitRouter: Address,
) {
  if (order.chainId !== chainId) return fail('order.chainId', 'does not match typed-data domain')
  return {
    domain: buildLimitOrderDomain(chainId, limitRouter),
    types: PENDLE_LIMIT_ORDER_TYPES,
    primaryType: 'Order',
    message: toLimitOrderStruct(order),
  } as const
}

export function hashLimitOrderDomain(chainId: number, limitRouter: Address): Hex {
  const domain = buildLimitOrderDomain(chainId, limitRouter)
  return hashDomain({
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    types: EIP712_DOMAIN_TYPES,
  })
}

export function hashLimitOrder(
  order: GeneratedLimitOrder | LimitOrderRecord,
  chainId: number,
  limitRouter: Address,
): Hex {
  return hashTypedData(buildLimitOrderTypedData(order, chainId, limitRouter))
}

export function createLimitOrderDto(order: GeneratedLimitOrder, signature: Hex): CreateLimitOrderDto {
  const eoaSignature = asHex(signature, 'signature', 65)
  return {
    chainId: order.chainId,
    signature: eoaSignature,
    salt: order.salt.toString(),
    expiry: order.expiry.toString(),
    nonce: order.nonce.toString(),
    type: order.orderType,
    token: order.token,
    yt: order.YT,
    maker: order.maker,
    receiver: order.receiver,
    makingAmount: order.makingAmount.toString(),
    lnImpliedRate: order.lnImpliedRate.toString(),
    failSafeRate: order.failSafeRate.toString(),
    permit: order.permit,
  }
}

export function validateLimitOrderRecordAgainstDto(
  order: LimitOrderRecord,
  dto: CreateLimitOrderDto,
  expectedOrderHash?: Hex,
): LimitOrderRecord {
  const checks: Array<[boolean, string]> = [
    [order.chainId === dto.chainId, 'chainId'],
    [order.signature.toLowerCase() === dto.signature.toLowerCase(), 'signature'],
    [order.salt.toString() === dto.salt, 'salt'],
    [order.expiry.toString() === dto.expiry, 'expiry'],
    [order.nonce.toString() === dto.nonce, 'nonce'],
    [order.type === dto.type, 'type'],
    [sameAddress(order.token, dto.token), 'token'],
    [sameAddress(order.yt, dto.yt), 'yt'],
    [sameAddress(order.maker, dto.maker), 'maker'],
    [sameAddress(order.receiver, dto.receiver), 'receiver'],
    [order.makingAmount.toString() === dto.makingAmount, 'makingAmount'],
    [order.lnImpliedRate.toString() === dto.lnImpliedRate, 'lnImpliedRate'],
    [order.failSafeRate.toString() === dto.failSafeRate, 'failSafeRate'],
    [order.permit.toLowerCase() === dto.permit.toLowerCase(), 'permit'],
    [sameAddress(order.sy, dto.token), 'sy'],
  ]
  const mismatch = checks.find(([matches]) => !matches)
  if (mismatch) return fail(`limitOrder.${mismatch[1]}`, 'does not match submitted DTO')
  if (expectedOrderHash && order.id.toLowerCase() !== expectedOrderHash.toLowerCase()) {
    return fail('limitOrder.id', 'does not match locally computed order hash')
  }
  return order
}

export async function fetchLimitOrderSupport(
  context: LimitOrderMarketContext,
  orderType: PtSyLimitOrderType,
  options: LimitOrderApiOptions = {},
): Promise<LimitOrderSupportResult> {
  try {
    assertChainId(context.chainId, 'context.chainId')
    const yt = normalizeAddressInput(context.yt, 'context.yt')
    const url = apiUrl(
      `/v1/limit-orders/${context.chainId}/support-tokens/${yt.toLowerCase()}`,
      options,
    )
    let response: Response
    try {
      response = await apiFetch(options)(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: options.signal,
      })
    } catch (error) {
      return { status: 'unavailable', error: errorMessage(error) }
    }
    if (response.status === 404) return { status: 'unsupported' }
    if (!response.ok) {
      return {
        status: 'unavailable',
        error: await responseError(response),
        httpStatus: response.status,
      }
    }
    try {
      const support = validateSupportForPtSy(
        parseLimitOrderSupport(await responseJson(response)),
        context,
        orderType,
      )
      return { status: 'supported', support }
    } catch (error) {
      return { status: 'unavailable', error: errorMessage(error), httpStatus: response.status }
    }
  } catch (error) {
    return { status: 'unavailable', error: errorMessage(error) }
  }
}

export async function fetchLimitOrderBook(
  query: LimitOrderBookQuery,
  options: LimitOrderApiOptions = {},
): Promise<LimitOrderBook> {
  assertChainId(query.chainId, 'query.chainId')
  const market = normalizeAddressInput(query.market, 'query.market')
  // The live Core API rejects values above 3 despite the OpenAPI declaring an
  // unconstrained number, so keep the verified production ceiling here.
  const precisionDecimal = query.precisionDecimal ?? 3
  const limit = query.limit ?? 10
  asSafeInteger(precisionDecimal, 'query.precisionDecimal', 0, 3)
  asSafeInteger(limit, 'query.limit', 1, 100)
  const url = apiUrl(`/v2/limit-orders/book/${query.chainId}`, options)
  url.searchParams.set('market', market.toLowerCase())
  url.searchParams.set('precisionDecimal', String(precisionDecimal))
  url.searchParams.set('includeAmm', String(query.includeAmm ?? true))
  url.searchParams.set('limit', String(limit))
  const json = await strictApiJson(
    url,
    { method: 'GET', headers: { accept: 'application/json' } },
    options,
  )
  try {
    return parseLimitOrderBook(json)
  } catch (error) {
    throw new LimitOrderApiError('invalid-response', errorMessage(error))
  }
}

export async function generateLimitOrderData(
  intent: PtSyLimitOrderIntent,
  options: LimitOrderApiOptions & ValidateGeneratedLimitOrderOptions = {},
): Promise<GeneratedLimitOrder> {
  const body = createGenerateLimitOrderRequest(intent, options.nowUnixSeconds)
  const url = apiUrl('/v1/limit-orders/makers/generate-limit-order-data', options)
  const json = await strictApiJson(
    url,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    options,
  )
  try {
    return validateGeneratedLimitOrder(parseGeneratedLimitOrder(json), intent, options)
  } catch (error) {
    throw new LimitOrderApiError('invalid-response', errorMessage(error))
  }
}

export function isAmbiguousSubmissionHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

export async function submitLimitOrder(
  dto: CreateLimitOrderDto,
  expectedOrderHash: Hex,
  options: LimitOrderApiOptions = {},
): Promise<SubmitLimitOrderResult> {
  asHex(expectedOrderHash, 'expectedOrderHash', 32)
  const url = apiUrl('/v1/limit-orders/makers/limit-orders', options)
  let response: Response
  try {
    response = await apiFetch(options)(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(dto),
      signal: options.signal,
    })
  } catch (error) {
    return { status: 'ambiguous', error: errorMessage(error) }
  }

  if (!response.ok) {
    const error = await responseError(response)
    if (isAmbiguousSubmissionHttpStatus(response.status)) {
      return { status: 'ambiguous', error, httpStatus: response.status }
    }
    return { status: 'rejected', error, httpStatus: response.status }
  }

  try {
    const order = validateLimitOrderRecordAgainstDto(
      parseLimitOrderRecord(await responseJson(response)),
      dto,
      expectedOrderHash,
    )
    return { status: 'submitted', order }
  } catch (error) {
    // A malformed/mismatched success response is ambiguous: the backend may
    // have persisted the signed order before its response was lost or changed.
    return { status: 'ambiguous', error: errorMessage(error), httpStatus: response.status }
  }
}

export async function fetchMakerLimitOrders(
  query: MakerLimitOrdersQuery,
  options: LimitOrderApiOptions = {},
): Promise<MakerLimitOrdersResponse> {
  assertChainId(query.chainId, 'query.chainId')
  const maker = normalizeAddressInput(query.maker, 'query.maker')
  const yt = normalizeAddressInput(query.yt, 'query.yt')
  const sy = normalizeAddressInput(query.sy, 'query.sy')
  const limitRouter = normalizeAddressInput(query.limitRouter, 'query.limitRouter')
  const orderType = asPtSyOrderType(query.orderType, 'query.orderType')
  const skip = query.skip ?? 0
  const limit = query.limit ?? 50
  asSafeInteger(skip, 'query.skip', 0, 1_000)
  asSafeInteger(limit, 'query.limit', 1, 100)

  const url = apiUrl('/v1/limit-orders/makers/limit-orders', options)
  url.searchParams.set('chainId', String(query.chainId))
  url.searchParams.set('maker', maker.toLowerCase())
  url.searchParams.set('yt', yt.toLowerCase())
  url.searchParams.set('type', String(orderType))
  url.searchParams.set('skip', String(skip))
  url.searchParams.set('limit', String(limit))
  if (query.isActive !== undefined) url.searchParams.set('isActive', String(query.isActive))

  const json = await strictApiJson(
    url,
    { method: 'GET', headers: { accept: 'application/json' } },
    options,
  )
  try {
    const parsed = parseMakerLimitOrdersResponse(json, orderType)
    for (const order of parsed.results) {
      if (order.chainId !== query.chainId) {
        return fail('makerOrders.results.chainId', 'does not match the requested chain')
      }
      if (!sameAddress(order.maker, maker)) {
        return fail('makerOrders.results.maker', 'does not match the requested maker')
      }
      if (!sameAddress(order.yt, yt)) {
        return fail('makerOrders.results.yt', 'does not match the requested YT')
      }
    }
    // The endpoint cannot filter by token and may mix Pendle-UI orders that
    // convert an underlying token with this MVP's direct-SY orders. Ignore the
    // former without hiding otherwise valid direct-SY history.
    const results = parsed.results.filter(
      (order) => sameAddress(order.sy, sy) && sameAddress(order.token, sy),
    )
    for (const order of results) {
      const computedId = hashLimitOrder(order, query.chainId, limitRouter)
      if (computedId.toLowerCase() !== order.id.toLowerCase()) {
        return fail('makerOrders.results.id', 'does not match the EIP-712 order struct')
      }
    }
    return { ...parsed, total: results.length, results }
  } catch (error) {
    throw new LimitOrderApiError('invalid-response', errorMessage(error))
  }
}

export async function reconcileLimitOrderSubmission(
  orderHash: Hex,
  dto?: CreateLimitOrderDto,
  options: LimitOrderApiOptions = {},
): Promise<ReconcileLimitOrderResult> {
  const hash = asHex(orderHash, 'orderHash', 32)
  const url = apiUrl(`/v1/limit-orders/orders/${hash.toLowerCase()}`, options)
  let response: Response
  try {
    response = await apiFetch(options)(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    })
  } catch (error) {
    return { status: 'unavailable', error: errorMessage(error) }
  }
  if (response.status === 404) {
    // The order index can be eventually consistent, so this is not proof that
    // a timed-out POST was never accepted.
    return { status: 'not-found', definitive: false }
  }
  if (!response.ok) {
    return {
      status: 'unavailable',
      error: await responseError(response),
      httpStatus: response.status,
    }
  }
  try {
    const parsed = parseLimitOrderRecord(await responseJson(response))
    const order = dto ? validateLimitOrderRecordAgainstDto(parsed, dto, hash) : parsed
    if (!dto && order.id.toLowerCase() !== hash.toLowerCase()) {
      return fail('limitOrder.id', 'does not match requested order hash')
    }
    return { status: 'found', order }
  } catch (error) {
    return { status: 'unavailable', error: errorMessage(error), httpStatus: response.status }
  }
}

function validatePlanInputs(inputs: LimitRouterPlanInputs): LimitRouterPlanInputs {
  normalizeAddressInput(inputs.limitRouter, 'inputs.limitRouter')
  normalizeAddressInput(inputs.maker, 'inputs.maker')
  normalizeAddressInput(inputs.sy, 'inputs.sy')
  if (!Array.isArray(inputs.abi) || inputs.abi.length === 0) {
    return fail('inputs.abi', 'expected a non-empty ABI')
  }
  return inputs
}

function validateCancelableOrder(
  order: GeneratedLimitOrder | LimitOrderRecord,
  inputs: LimitRouterPlanInputs,
): LimitOrderStruct {
  const struct = toLimitOrderStruct(order)
  if (!sameAddress(struct.maker, inputs.maker)) return fail('order.maker', 'does not match caller')
  if (!sameAddress(struct.token, inputs.sy)) return fail('order.token', 'PT limit-order MVP only supports SY')
  asPtSyOrderType(struct.orderType, 'order.orderType')
  return struct
}

function orderStructIdentity(order: LimitOrderStruct): string {
  return [
    order.salt,
    order.expiry,
    order.nonce,
    order.orderType,
    order.token.toLowerCase(),
    order.YT.toLowerCase(),
    order.maker.toLowerCase(),
    order.receiver.toLowerCase(),
    order.makingAmount,
    order.lnImpliedRate,
    order.failSafeRate,
    order.permit.toLowerCase(),
  ].join(':')
}

export function buildCancelSingleLimitOrderPlan(
  order: GeneratedLimitOrder | LimitOrderRecord,
  inputs: LimitRouterPlanInputs,
): ActionPlan {
  validatePlanInputs(inputs)
  const struct = validateCancelableOrder(order, inputs)
  return {
    describe: 'Cancel PT limit order',
    approvals: [],
    call: {
      address: inputs.limitRouter,
      abi: inputs.abi,
      functionName: 'cancelSingle',
      args: [struct],
    },
  }
}

export function buildCancelBatchLimitOrdersPlan(
  orders: readonly (GeneratedLimitOrder | LimitOrderRecord)[],
  inputs: LimitRouterPlanInputs,
): ActionPlan {
  validatePlanInputs(inputs)
  if (orders.length === 0 || orders.length > 20) {
    return fail('orders', 'batch cancellation requires 1 to 20 orders')
  }
  const structs = orders.map((order) => validateCancelableOrder(order, inputs))
  const identities = new Set(structs.map(orderStructIdentity))
  if (identities.size !== structs.length) {
    return fail('orders', 'batch cancellation cannot contain the same order twice')
  }
  return {
    describe: `Cancel ${orders.length} PT limit orders`,
    approvals: [],
    call: {
      address: inputs.limitRouter,
      abi: inputs.abi,
      functionName: 'cancelBatch',
      args: [structs],
    },
  }
}

export function buildCancelAllLimitOrdersPlan(inputs: LimitRouterPlanInputs): ActionPlan {
  validatePlanInputs(inputs)
  return {
    describe: 'Cancel all limit orders',
    approvals: [],
    call: {
      address: inputs.limitRouter,
      abi: inputs.abi,
      functionName: 'increaseNonce',
      args: [],
    },
  }
}
