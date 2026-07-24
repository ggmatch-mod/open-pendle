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
  'authorization-cleanup',
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
  'authorizationCleanupStage',
  'acquisitionMode',
  'mintDelivery',
])
const POSITION_KEYS = new Set([
  'supplyShares',
  'minBorrowShares',
  'maxBorrowShares',
  'minCollateral',
  'maxCollateral',
])
const MINT_DELIVERY_REQUIRED_KEYS = new Set([
  'yieldToken',
  'minimumYtOut',
])
const MINT_DELIVERY_OPTIONAL_KEYS = new Set(['transactionHash'])

export type LoopingPendingAcquisitionMode = 'market' | 'mint'
export type LoopingAuthorizationCleanupStage =
  | 'signature-requested'
  | 'submitted'
  | 'allowance-ready'
  | 'allowance-submitting'
  | 'allowance-submitted'

export interface LoopingPendingMintDelivery {
  yieldToken: Address
  minimumYtOut: string
  /** Original Mint Mode bundle hash, retained across later rescue transactions. */
  transactionHash?: Hex
}

export type LoopingPendingOperationKind =
  | 'entry'
  | 'exit'
  | 'allowance-cleanup'
  | 'metadata-cleanup'
  | 'authorization-cleanup'
  | 'recovery'
  | 'rescue'

export interface LoopingExpectedPositionBounds {
  /** Nonzero only for permission cleanup of an imported conflicting position. */
  supplyShares: string
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
  /** Present only for imported-authorization cleanup recovery. */
  authorizationCleanupStage?: LoopingAuthorizationCleanupStage
  /** Absent only on legacy and risk-reducing records. */
  acquisitionMode?: LoopingPendingAcquisitionMode
  /** Minimal receipt-recovery evidence; never contains quote calldata. */
  mintDelivery?: LoopingPendingMintDelivery
}

export type LoopingAuthorizationCleanupRecheck =
  | 'start'
  | 'proven'
  | 'wait-for-mined-state'
  | 'roll-forward'

export function classifyLoopingAuthorizationCleanupRecheck(args: {
  record: Pick<
    LoopingPendingOperation,
    'startingMorphoNonce' | 'txHash'
  > | undefined
  currentMorphoNonce: bigint
  adapterAuthorized: boolean
  receiptMined: boolean
}): LoopingAuthorizationCleanupRecheck {
  if (args.record === undefined) return 'start'
  const requiredNonce = BigInt(args.record.startingMorphoNonce) + 1n
  if (!args.adapterAuthorized && args.currentMorphoNonce >= requiredNonce) {
    return 'proven'
  }
  if (args.record.txHash === undefined || !args.receiptMined) {
    return 'wait-for-mined-state'
  }
  return 'roll-forward'
}

export type LoopingAuthorizationAllowanceCleanupRecheck =
  | 'proven'
  | 'stage-ready'
  | 'submit'
  | 'wait-for-mined-state'
  | 'roll-forward'

export function classifyLoopingAuthorizationAllowanceCleanupRecheck(args: {
  record: Pick<
    LoopingPendingOperation,
    'authorizationCleanupStage' | 'txHash'
  > | undefined
  adapterAllowance: bigint
  receiptMined: boolean
}): LoopingAuthorizationAllowanceCleanupRecheck {
  if (args.adapterAllowance === 0n) return 'proven'
  if (args.record?.authorizationCleanupStage === 'allowance-ready') {
    return 'submit'
  }
  if (args.record?.authorizationCleanupStage === 'allowance-submitting') {
    return 'wait-for-mined-state'
  }
  if (args.record?.authorizationCleanupStage === 'allowance-submitted') {
    return args.receiptMined ? 'roll-forward' : 'wait-for-mined-state'
  }
  return 'stage-ready'
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

function canonicalExpectedPosition(
  value: unknown,
  allowSupplyShares: boolean,
): LoopingExpectedPositionBounds {
  if (!isPlainRecord(value) || !hasExactKeys(value, POSITION_KEYS)) {
    throw new TypeError('Looping pending expectedPosition has an invalid shape.')
  }
  const supplyShares = canonicalUint(value.supplyShares, 'expectedPosition.supplyShares')
  if (!allowSupplyShares && supplyShares !== '0') {
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
    supplyShares,
    minBorrowShares,
    maxBorrowShares,
    minCollateral,
    maxCollateral,
  }
}

function canonicalMintDelivery(value: unknown): LoopingPendingMintDelivery {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(
      value,
      MINT_DELIVERY_REQUIRED_KEYS,
      MINT_DELIVERY_OPTIONAL_KEYS,
    )
  ) {
    throw new TypeError('Looping pending mintDelivery has an invalid shape.')
  }
  const minimumYtOut = canonicalUint(
    value.minimumYtOut,
    'mintDelivery.minimumYtOut',
  )
  if (minimumYtOut === '0') {
    throw new TypeError('Looping pending minimum YT output must be positive.')
  }
  let yieldToken: Address
  try {
    yieldToken = getAddress(value.yieldToken as string)
  } catch {
    throw new TypeError('Looping pending yield token is invalid.')
  }
  return {
    yieldToken,
    minimumYtOut,
    ...(value.transactionHash === undefined
      ? {}
      : {
          transactionHash: canonicalBytes32(
            value.transactionHash,
            'mintDelivery.transactionHash',
          ),
        }),
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
    record.expectedPosition = canonicalExpectedPosition(
      value.expectedPosition,
      record.operation === 'authorization-cleanup',
    )
  }
  if (record.operation === 'authorization-cleanup') {
    if (record.expectedPosition === undefined) {
      throw new TypeError('Authorization cleanup requires an exact expected position.')
    }
    if (
      value.authorizationCleanupStage !== 'signature-requested' &&
      value.authorizationCleanupStage !== 'submitted' &&
      value.authorizationCleanupStage !== 'allowance-ready' &&
      value.authorizationCleanupStage !== 'allowance-submitting' &&
      value.authorizationCleanupStage !== 'allowance-submitted'
    ) {
      throw new TypeError('Authorization cleanup stage is invalid.')
    }
    const stageRequiresHash =
      value.authorizationCleanupStage === 'submitted' ||
      value.authorizationCleanupStage === 'allowance-submitted'
    if (
      stageRequiresHash !== (record.txHash !== undefined)
    ) {
      throw new TypeError('Authorization cleanup submission stage and hash do not match.')
    }
    record.authorizationCleanupStage = value.authorizationCleanupStage
  } else if (value.authorizationCleanupStage !== undefined) {
    throw new TypeError('Authorization cleanup stage requires its matching operation.')
  }
  if (
    value.acquisitionMode !== undefined &&
    value.acquisitionMode !== 'market' &&
    value.acquisitionMode !== 'mint'
  ) {
    throw new TypeError('Looping pending acquisition mode is invalid.')
  }
  if (value.acquisitionMode === 'mint') {
    if (value.mintDelivery === undefined) {
      throw new TypeError('Looping pending Mint Mode delivery metadata is missing.')
    }
    record.acquisitionMode = 'mint'
    record.mintDelivery = canonicalMintDelivery(value.mintDelivery)
  } else {
    if (value.mintDelivery !== undefined) {
      throw new TypeError('Looping pending mint delivery requires Mint Mode.')
    }
    if (value.acquisitionMode === 'market') record.acquisitionMode = 'market'
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

function sameRecord(
  left: LoopingPendingOperation,
  right: LoopingPendingOperation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function readStoredRecord(
  storage: LoopingPendingStorage,
  key: string,
): LoopingPendingOperation | undefined {
  const raw = storage.getItem(key)
  if (raw === null) return undefined
  if (raw.length > MAX_SERIALIZED_RECORD_LENGTH) {
    throw new TypeError('Looping pending record is too large.')
  }
  const record = parseLoopingPendingOperation(JSON.parse(raw))
  if (record === undefined) {
    throw new TypeError('Looping pending record is invalid.')
  }
  return record
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

/**
 * Authorization cleanup is global across every market that shares the same
 * chain-level Morpho deployment and adapter. Keep one owner+chain sentinel so
 * another market cannot submit a competing nonce burn after a reload.
 */
export function loopingAuthorizationCleanupStorageKey(
  scope: LoopingPendingScope,
): string {
  const canonical = canonicalScope(scope)
  return [
    LOOPING_PENDING_STORAGE_PREFIX,
    'authorization-cleanup',
    canonical.chainId,
    canonical.owner.toLowerCase(),
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
    const serialized = JSON.stringify(record)
    if (record.operation === 'authorization-cleanup') {
      const authorizationKey = loopingAuthorizationCleanupStorageKey(record)
      const currentAuthorization = readStoredRecord(storage, authorizationKey)
      if (currentAuthorization !== undefined) {
        return sameRecord(currentAuthorization, record)
      }
      const exactKey = loopingPendingStorageKey(record)
      const exactRecord = readStoredRecord(storage, exactKey)
      if (exactRecord?.operation === 'authorization-cleanup') {
        if (!sameRecord(exactRecord, record)) return false
        storage.setItem(authorizationKey, serialized)
        const currentExact = readStoredRecord(storage, exactKey)
        if (currentExact !== undefined && sameRecord(currentExact, record)) {
          storage.removeItem(exactKey)
        }
      } else {
        // Preserve an unrelated exact-market operation under the wallet-wide
        // sentinel so it can resume after permission cleanup completes.
        storage.setItem(authorizationKey, serialized)
      }
    } else {
      storage.setItem(loopingPendingStorageKey(record), serialized)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Replace one exact persisted generation. This compare-and-swap guard prevents
 * a stale tab from overwriting a newer cleanup stage or transaction hash.
 */
export function replaceLoopingPendingOperation(
  previousValue: unknown,
  nextValue: unknown,
  storage: LoopingPendingStorage | null = browserStorage(),
): boolean {
  if (storage === null) return false
  try {
    const previous = requireLoopingPendingOperation(previousValue)
    const next = requireLoopingPendingOperation(nextValue)
    let previousKey = previous.operation === 'authorization-cleanup'
      ? loopingAuthorizationCleanupStorageKey(previous)
      : loopingPendingStorageKey(previous)
    const nextKey = next.operation === 'authorization-cleanup'
      ? loopingAuthorizationCleanupStorageKey(next)
      : loopingPendingStorageKey(next)
    if (
      (previous.operation === 'authorization-cleanup') !==
        (next.operation === 'authorization-cleanup') ||
      previousKey !== nextKey ||
      !sameScope(next, canonicalScope(previous))
    ) {
      return false
    }
    let current = readStoredRecord(storage, previousKey)
    let migrateLegacyAuthorization = false
    if (
      current === undefined &&
      previous.operation === 'authorization-cleanup'
    ) {
      const exactKey = loopingPendingStorageKey(previous)
      const exactRecord = readStoredRecord(storage, exactKey)
      if (exactRecord?.operation === 'authorization-cleanup') {
        previousKey = exactKey
        current = exactRecord
        migrateLegacyAuthorization = true
      }
    }
    if (current === undefined || !sameRecord(current, previous)) return false
    if (migrateLegacyAuthorization) {
      const currentLegacy = readStoredRecord(storage, previousKey)
      if (
        readStoredRecord(
          storage,
          loopingAuthorizationCleanupStorageKey(previous),
        ) !== undefined ||
        currentLegacy === undefined ||
        !sameRecord(currentLegacy, previous)
      ) {
        return false
      }
      storage.setItem(nextKey, JSON.stringify(next))
      const legacyAfterWrite = readStoredRecord(storage, previousKey)
      if (
        legacyAfterWrite !== undefined &&
        sameRecord(legacyAfterWrite, previous)
      ) {
        storage.removeItem(previousKey)
      }
      return true
    }
    storage.setItem(nextKey, JSON.stringify(next))
    return true
  } catch {
    return false
  }
}

/**
 * Read the owner+chain authorization sentinel before the exact market scope.
 * The sentinel retains its originating market so every market remains blocked
 * until that wallet-wide cleanup is reconciled. It never ages out silently;
 * only exact-market operation metadata uses the bounded recovery window.
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

  const readKey = (
    key: string,
    enforceTimeBounds: boolean,
  ): LoopingPendingOperation | undefined => {
    const raw = storage.getItem(key)
    if (raw === null || raw.length > MAX_SERIALIZED_RECORD_LENGTH) {
      return undefined
    }
    const record = parseLoopingPendingOperation(JSON.parse(raw))
    if (!record) return undefined
    const boundedByTime =
      enforceTimeBounds &&
      record.operation !== 'authorization-cleanup'
    if (
      boundedByTime &&
      record.createdAt > Number(nowMs) + LOOPING_PENDING_FUTURE_SKEW_MS
    ) {
      return undefined
    }
    if (
      boundedByTime &&
      Number(nowMs) - record.createdAt > Number(maxAgeMs)
    ) return undefined
    return record
  }

  try {
    const authorizationRecord = readKey(
      loopingAuthorizationCleanupStorageKey(scope),
      false,
    )
    if (
      authorizationRecord?.operation === 'authorization-cleanup' &&
      authorizationRecord.chainId === scope.chainId &&
      authorizationRecord.owner.toLowerCase() === scope.owner.toLowerCase()
    ) {
      return authorizationRecord
    }
  } catch {
    // Invalid global metadata must not hide valid exact-market recovery state.
  }
  try {
    const exactRecord = readKey(loopingPendingStorageKey(scope), true)
    return exactRecord !== undefined && sameScope(exactRecord, scope)
      ? exactRecord
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Remove only the currently authoritative record for this scope. A wallet-wide
 * authorization sentinel wins over exact-market metadata; clearing it preserves
 * any unrelated exact-market operation for later recovery.
 */
export function clearLoopingPendingOperation(
  expectedValue: unknown,
  storage: LoopingPendingStorage | null = browserStorage(),
): boolean {
  if (storage === null) return false
  try {
    const expected = requireLoopingPendingOperation(expectedValue)
    const scope = canonicalScope(expected)
    let expectedKey = loopingPendingStorageKey(expected)

    if (expected.operation !== 'authorization-cleanup') {
      let authorizationRecord: LoopingPendingOperation | undefined
      try {
        authorizationRecord = readStoredRecord(
          storage,
          loopingAuthorizationCleanupStorageKey(expected),
        )
      } catch {
        // Invalid global metadata must not strand valid exact-market recovery.
      }
      if (
        authorizationRecord?.operation === 'authorization-cleanup' &&
        authorizationRecord.chainId === scope.chainId &&
        authorizationRecord.owner.toLowerCase() === scope.owner.toLowerCase()
      ) {
        return false
      }
    } else {
      const authorizationKey =
        loopingAuthorizationCleanupStorageKey(expected)
      const authorizationRecord = readStoredRecord(storage, authorizationKey)
      if (authorizationRecord !== undefined) {
        expectedKey = authorizationKey
      }
    }

    const current = readStoredRecord(storage, expectedKey)
    if (current === undefined || !sameRecord(current, expected)) return false

    storage.removeItem(expectedKey)
    if (expected.operation === 'authorization-cleanup') {
      const exactKey = loopingPendingStorageKey(expected)
      try {
        const currentLegacy = readStoredRecord(storage, exactKey)
        if (
          currentLegacy?.operation === 'authorization-cleanup' &&
          sameScope(currentLegacy, scope) &&
          sameRecord(currentLegacy, expected)
        ) {
          storage.removeItem(exactKey)
        }
      } catch {
        // A malformed exact-market value must never make the valid global
        // cleanup record look removable while returning a false failure.
      }
    }
    return true
  } catch {
    return false
  }
}
