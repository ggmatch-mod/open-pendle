/**
 * Minimal persistence for an unresolved looping operation.
 *
 * This record is recovery metadata, not a resumable signed payload. Signatures,
 * calldata, transaction requests, and arbitrary extension fields are rejected
 * so they cannot be written accidentally. Records are stored under a key scoped
 * to the exact chain, owner, and Morpho market.
 */

import { getAddress } from 'viem'
import type { Address, Hex } from 'viem'

export const LOOPING_PENDING_VERSION = 1 as const
export const LOOPING_PENDING_STORAGE_PREFIX = 'openpendle.looping.pending.v1'
export const LOOPING_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const LOOPING_PENDING_FUTURE_SKEW_MS = 5 * 60 * 1_000

const MAX_UINT256 = (1n << 256n) - 1n
const MAX_SERIALIZED_RECORD_LENGTH = 2_048
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/
const UINT_PATTERN = /^(?:0|[1-9][0-9]{0,77})$/
const OPERATIONS = new Set<LoopingPendingOperationKind>([
  'entry',
  'exit',
  'allowance-cleanup',
  'metadata-cleanup',
  'recovery',
  'rescue',
])

const RECORD_REQUIRED_KEYS = new Set([
  'version',
  'operation',
  'chainId',
  'owner',
  'marketId',
  'startingMorphoNonce',
  'authorizationDeadline',
  'createdAt',
])
const RECORD_OPTIONAL_KEYS = new Set([
  'txHash',
  'walletTxNonce',
  'expectedPosition',
])
const POSITION_KEYS = new Set([
  'supplyShares',
  'minBorrowShares',
  'maxBorrowShares',
  'minCollateral',
  'maxCollateral',
])

export type LoopingPendingOperationKind =
  | 'entry'
  | 'exit'
  | 'allowance-cleanup'
  | 'metadata-cleanup'
  | 'recovery'
  | 'rescue'

export interface LoopingExpectedPositionBounds {
  /** Looping never permits a Morpho supply position in the same market. */
  supplyShares: '0'
  minBorrowShares: string
  maxBorrowShares: string
  minCollateral: string
  maxCollateral: string
}

export interface LoopingPendingOperation {
  version: typeof LOOPING_PENDING_VERSION
  operation: LoopingPendingOperationKind
  chainId: number
  owner: Address
  marketId: Hex
  txHash?: Hex
  /** EOA transaction nonce, encoded as a canonical unsigned decimal string. */
  walletTxNonce?: string
  /** Morpho authorization nonce before the paired signatures are consumed. */
  startingMorphoNonce: string
  /** Morpho authorization deadline in Unix seconds. */
  authorizationDeadline: string
  /** Record creation time in Unix milliseconds. */
  createdAt: number
  expectedPosition?: LoopingExpectedPositionBounds
}

export interface LoopingPendingScope {
  chainId: number
  owner: Address | string
  marketId: Hex | string
}

export type LoopingPendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface ReadLoopingPendingOptions {
  storage?: LoopingPendingStorage | null
  nowMs?: number
  maxAgeMs?: number
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set(),
): boolean {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => required.has(key) || optional.has(key))) return false
  return [...required].every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function canonicalAddress(value: unknown): Address {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    throw new TypeError('Looping pending owner must be a 20-byte address.')
  }
  try {
    return getAddress(value)
  } catch {
    throw new TypeError('Looping pending owner has an invalid checksum.')
  }
}

function canonicalBytes32(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !BYTES32_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a 32-byte hex string.`)
  }
  return value.toLowerCase() as Hex
}

function canonicalUint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UINT_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical unsigned decimal string.`)
  }
  if (BigInt(value) > MAX_UINT256) {
    throw new TypeError(`${label} exceeds uint256.`)
  }
  return value
}

function canonicalChainId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError('Looping pending chainId must be a positive safe integer.')
  }
  return Number(value)
}

function canonicalCreatedAt(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError('Looping pending createdAt must be a positive Unix-millisecond integer.')
  }
  return Number(value)
}

function canonicalExpectedPosition(value: unknown): LoopingExpectedPositionBounds {
  if (!isPlainRecord(value) || !hasExactKeys(value, POSITION_KEYS)) {
    throw new TypeError('Looping pending expectedPosition has an invalid shape.')
  }
  const supplyShares = canonicalUint(value.supplyShares, 'expectedPosition.supplyShares')
  if (supplyShares !== '0') {
    throw new TypeError('Looping pending expected supply shares must be zero.')
  }
  const minBorrowShares = canonicalUint(
    value.minBorrowShares,
    'expectedPosition.minBorrowShares',
  )
  const maxBorrowShares = canonicalUint(
    value.maxBorrowShares,
    'expectedPosition.maxBorrowShares',
  )
  const minCollateral = canonicalUint(
    value.minCollateral,
    'expectedPosition.minCollateral',
  )
  const maxCollateral = canonicalUint(
    value.maxCollateral,
    'expectedPosition.maxCollateral',
  )
  if (BigInt(minBorrowShares) > BigInt(maxBorrowShares)) {
    throw new TypeError('Looping pending borrow-share bounds are inverted.')
  }
  if (BigInt(minCollateral) > BigInt(maxCollateral)) {
    throw new TypeError('Looping pending collateral bounds are inverted.')
  }
  return {
    supplyShares: '0',
    minBorrowShares,
    maxBorrowShares,
    minCollateral,
    maxCollateral,
  }
}

function requireLoopingPendingOperation(value: unknown): LoopingPendingOperation {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, RECORD_REQUIRED_KEYS, RECORD_OPTIONAL_KEYS)
  ) {
    throw new TypeError('Looping pending operation has an invalid shape.')
  }
  if (value.version !== LOOPING_PENDING_VERSION) {
    throw new TypeError('Looping pending operation has an unsupported version.')
  }
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation as LoopingPendingOperationKind)) {
    throw new TypeError('Looping pending operation kind is invalid.')
  }

  const record: LoopingPendingOperation = {
    version: LOOPING_PENDING_VERSION,
    operation: value.operation as LoopingPendingOperationKind,
    chainId: canonicalChainId(value.chainId),
    owner: canonicalAddress(value.owner),
    marketId: canonicalBytes32(value.marketId, 'Looping pending marketId'),
    startingMorphoNonce: canonicalUint(
      value.startingMorphoNonce,
      'Looping pending startingMorphoNonce',
    ),
    authorizationDeadline: canonicalUint(
      value.authorizationDeadline,
      'Looping pending authorizationDeadline',
    ),
    createdAt: canonicalCreatedAt(value.createdAt),
  }
  if (value.txHash !== undefined) {
    record.txHash = canonicalBytes32(value.txHash, 'Looping pending txHash')
  }
  if (value.walletTxNonce !== undefined) {
    record.walletTxNonce = canonicalUint(
      value.walletTxNonce,
      'Looping pending walletTxNonce',
    )
  }
  if (value.expectedPosition !== undefined) {
    record.expectedPosition = canonicalExpectedPosition(value.expectedPosition)
  }
  return record
}

function canonicalScope(scope: LoopingPendingScope): {
  chainId: number
  owner: Address
  marketId: Hex
} {
  if (typeof scope !== 'object' || scope === null) {
    throw new TypeError('Looping pending scope is required.')
  }
  return {
    chainId: canonicalChainId(scope.chainId),
    owner: canonicalAddress(scope.owner),
    marketId: canonicalBytes32(scope.marketId, 'Looping pending scope marketId'),
  }
}

function sameScope(
  record: LoopingPendingOperation,
  scope: ReturnType<typeof canonicalScope>,
): boolean {
  return record.chainId === scope.chainId &&
    record.owner.toLowerCase() === scope.owner.toLowerCase() &&
    record.marketId.toLowerCase() === scope.marketId.toLowerCase()
}

function browserStorage(): LoopingPendingStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

/** Parse and canonicalize an untrusted record without throwing. */
export function parseLoopingPendingOperation(value: unknown): LoopingPendingOperation | undefined {
  try {
    return requireLoopingPendingOperation(value)
  } catch {
    return undefined
  }
}

/**
 * Serialize only the closed schema above. Unknown fields—including signature or
 * calldata fields—throw before JSON serialization.
 */
export function serializeLoopingPendingOperation(value: unknown): string {
  return JSON.stringify(requireLoopingPendingOperation(value))
}

/** Deterministic storage key scoped to one owner, chain, and Morpho market. */
export function loopingPendingStorageKey(scope: LoopingPendingScope): string {
  const canonical = canonicalScope(scope)
  return [
    LOOPING_PENDING_STORAGE_PREFIX,
    canonical.chainId,
    canonical.owner.toLowerCase(),
    canonical.marketId.toLowerCase(),
  ].join('.')
}

/** Persist a validated operation; storage-denied browsers remain ephemeral. */
export function writeLoopingPendingOperation(
  value: unknown,
  storage: LoopingPendingStorage | null = browserStorage(),
): boolean {
  if (storage === null) return false
  try {
    const record = requireLoopingPendingOperation(value)
    storage.setItem(loopingPendingStorageKey(record), JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

/**
 * Read only the exact requested scope. Malformed, copied, stale, or future-dated
 * records are ignored and never adopted into another wallet context.
 */
export function readLoopingPendingOperation(
  scopeValue: LoopingPendingScope,
  options: ReadLoopingPendingOptions = {},
): LoopingPendingOperation | undefined {
  let scope: ReturnType<typeof canonicalScope>
  try {
    scope = canonicalScope(scopeValue)
  } catch {
    return undefined
  }
  const storage = options.storage === undefined ? browserStorage() : options.storage
  if (storage === null) return undefined
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? LOOPING_PENDING_MAX_AGE_MS
  if (
    !Number.isSafeInteger(nowMs) ||
    Number(nowMs) <= 0 ||
    !Number.isSafeInteger(maxAgeMs) ||
    Number(maxAgeMs) <= 0
  ) {
    return undefined
  }

  try {
    const raw = storage.getItem(loopingPendingStorageKey(scope))
    if (raw === null || raw.length > MAX_SERIALIZED_RECORD_LENGTH) return undefined
    const record = parseLoopingPendingOperation(JSON.parse(raw))
    if (!record || !sameScope(record, scope)) return undefined
    if (record.createdAt > Number(nowMs) + LOOPING_PENDING_FUTURE_SKEW_MS) return undefined
    if (Number(nowMs) - record.createdAt > Number(maxAgeMs)) return undefined
    return record
  } catch {
    return undefined
  }
}

/** Remove only a valid record belonging to the exact requested scope. */
export function clearLoopingPendingOperation(
  scopeValue: LoopingPendingScope,
  storage: LoopingPendingStorage | null = browserStorage(),
): boolean {
  if (storage === null) return false
  let scope: ReturnType<typeof canonicalScope>
  try {
    scope = canonicalScope(scopeValue)
    const key = loopingPendingStorageKey(scope)
    const raw = storage.getItem(key)
    if (raw === null || raw.length > MAX_SERIALIZED_RECORD_LENGTH) return false
    const record = parseLoopingPendingOperation(JSON.parse(raw))
    if (!record || !sameScope(record, scope)) return false
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}
