import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import {
  decodeEventLog,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import {
  useAccount,
  useSendTransaction,
  useSignTypedData,
  useSwitchChain,
  useWalletClient,
  useWriteContract,
} from 'wagmi'
import {
  deriveLoopingBorrowAssets,
  type LoopingMarketCandidate,
} from '../lib/looping'
import { evaluateLoopingRiskIncreaseEligibility } from '../lib/loopingEligibility'
import { loopingErc20Abi } from '../lib/loopingAbi'
import {
  LOOPING_EXECUTION_BETA_ENABLED,
  LOOPING_EXIT_BETA_ENABLED,
  LOOPING_MINT_BETA_ENABLED,
} from '../lib/loopingBeta'
import { assertLoopingMintRuntimeActionEnabled } from '../lib/loopingMintRuntimePolicy'
import { assertLoopingRuntimeEntryEnabled } from '../lib/loopingRuntimePolicy'
import {
  buildLoopingAuthorizationRecoveryIntent,
  buildLoopingAuthorizationNonceBurnIntent,
  buildSignedLoopingDecreaseBundle,
  buildSignedLoopingEntryBundle,
  buildSignedLoopingExitBundle,
  buildSignedLoopingIncreaseBundle,
  buildUnsignedLoopingDecreaseSimulation,
  buildUnsignedLoopingEntrySimulation,
  buildUnsignedLoopingExitSimulation,
  buildUnsignedLoopingIncreaseSimulation,
  classifyExposedLoopingAuthorization,
  decodeExposedLoopingAuthorizationPair,
  prepareDirectLoopingAuthorizationRevoke,
  prepareDirectLoopingRescue,
  prepareLoopingAdjustmentExecution,
  prepareLoopingAuthorizationNonceBurn,
  prepareLoopingEntryExecution,
  prepareLoopingExitExecution,
  readExposedLoopingAuthorizationRecoveryState,
  readExposedLoopingAuthorizationPairFromTransaction,
  readPersistedLoopingMintDeliveryFromTransaction,
  readLoopingExecutionPosition,
  revalidateSignedLoopingDecrease,
  revalidateSignedLoopingEntry,
  revalidateSignedLoopingExit,
  revalidateSignedLoopingIncrease,
  simulateUnsignedLoopingIntent,
  verifyLoopingDecreaseReceiptState,
  verifyLoopingEntryReceiptState,
  verifyLoopingExitReceiptState,
  verifyLoopingIncreaseReceiptState,
  type ExposedLoopingAuthorizationPair,
  type LoopingDecreaseExecutionPreview,
  type LoopingAcquisitionMode,
  type LoopingEntryExecutionPreview,
  type LoopingBroadcastReadiness,
  type LoopingExitExecutionPreview,
  type LoopingIncreaseExecutionPreview,
  type LoopingPositionSnapshot,
  type LoopingUnsignedSimulationEvidence,
  type SignedLoopingEntryBundle,
  type SignedLoopingExitBundle,
  type SignedLoopingDecreaseBundle,
  type SignedLoopingIncreaseBundle,
} from '../lib/loopingExecution'
import { parseLoopingTargetLeverageWad } from '../lib/loopingAdjustmentMath'
import { useTransactionGuard } from '../lib/hooks'
import {
  LOOPING_PENDING_VERSION,
  clearLoopingPendingOperation,
  readLoopingPendingOperation,
  writeLoopingPendingOperation,
  type LoopingExpectedPositionBounds,
  type LoopingPendingAcquisitionMode,
  type LoopingPendingMintDelivery,
  type LoopingPendingOperation,
  type LoopingPendingOperationKind,
} from '../lib/loopingPending'
import {
  createLoopingWalletReadClient,
} from '../lib/loopingRpc'
import {
  getLoopingExecutionCandidateMarket,
  type LoopingExecutionMarket,
} from '../lib/loopingRegistry'
import { isUserRejection } from '../lib/txflow'

export type LoopingExecutionOperation = 'entry' | 'exit'
export type LoopingExecutionIntent = 'auto' | 'adjust' | 'full-exit'
export type LoopingExecutionPreview =
  | LoopingEntryExecutionPreview
  | LoopingExitExecutionPreview
  | LoopingIncreaseExecutionPreview
  | LoopingDecreaseExecutionPreview

export interface LoopingRiskAcceptance {
  highLiquidationRiskAccepted?: boolean
}

export type LoopingExecutionPhase =
  | 'idle'
  | 'needs-wallet'
  | 'wrong-network'
  | 'checking'
  | 'ready'
  | 'clearing-allowance'
  | 'approving'
  | 'simulating'
  | 'signing-authorize'
  | 'signing-revoke'
  | 'revalidating'
  | 'submitting'
  | 'pending'
  | 'verifying'
  | 'recovering'
  | 'ambiguous'
  | 'confirmed'
  | 'blocked'
  | 'error'

interface LoopingExecutionState {
  phase: Exclude<LoopingExecutionPhase, 'needs-wallet' | 'wrong-network'>
  fingerprint: string
  operation?: LoopingExecutionOperation
  preview?: LoopingExecutionPreview
  position?: LoopingPositionSnapshot
  message?: string
  notice?: string
  noticeTone?: 'success' | 'danger'
  txHash?: Hash
  pendingRecord?: LoopingPendingOperation
}

interface OperationContext {
  fingerprint: string
  owner: Address
  chainId: LoopingExecutionMarket['chainId']
  marketId: Hex
  walletClientUid: string
}

interface LoopingExecutionLease {
  assertOwned: () => void
  release: () => void
}

interface LeaseMessage {
  type: 'claim' | 'held' | 'release'
  scope: string
  token: string
}

type SignedLoopingBundle =
  | SignedLoopingEntryBundle
  | SignedLoopingExitBundle
  | SignedLoopingIncreaseBundle
  | SignedLoopingDecreaseBundle

interface InMemoryRecovery {
  preview: LoopingExecutionPreview
  bundle: SignedLoopingBundle
  pair: ExposedLoopingAuthorizationPair
}

export interface UseLoopingExecutionResult {
  phase: LoopingExecutionPhase
  intent: LoopingExecutionIntent
  acquisitionMode: LoopingAcquisitionMode
  operation?: LoopingExecutionOperation
  supported: boolean
  entryEnabled: boolean
  exitEnabled: boolean
  market?: Readonly<LoopingExecutionMarket>
  borrowAssets?: bigint
  preview?: LoopingExecutionPreview
  position?: LoopingPositionSnapshot
  message?: string
  notice?: string
  noticeTone?: 'success' | 'danger'
  txHash?: Hash
  pendingRecord?: LoopingPendingOperation
  busy: boolean
  canPrepare: boolean
  canExecute: boolean
  canRecover: boolean
  prepare: () => Promise<void>
  execute: (acceptance?: LoopingRiskAcceptance) => Promise<void>
  recover: () => Promise<void>
  connectWallet: () => void
  switchToMarketChain: () => void
}

const EXIT_QUOTE_DISCOVERY_FLOOR = 1n
const LOOPING_RECEIPT_CONFIRMATIONS = 2
const MIN_QUOTE_FRESHNESS_BEFORE_SIGNATURE_MS = 30_000
const MIN_QUOTE_FRESHNESS_BEFORE_SUBMISSION_MS = 10_000
const LOOPING_TRANSFER_EVENT_ABI = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
const LEASE_STORAGE_PREFIX = 'openpendle.looping.execution-lease.v1'
const LEASE_CHANNEL_NAME = 'openpendle.looping.execution-lease.v1'
const LEASE_TTL_MS = 30 * 60 * 1_000
const LEASE_HEARTBEAT_MS = 10_000
const BUSY_PHASES = new Set<LoopingExecutionPhase>([
  'clearing-allowance',
  'approving',
  'simulating',
  'signing-authorize',
  'signing-revoke',
  'revalidating',
  'submitting',
  'pending',
  'verifying',
  'recovering',
])

class LoopingUiSafetyError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LoopingUiSafetyError'
    this.code = code
  }
}

function leaseScope(owner: Address, market: Readonly<LoopingExecutionMarket>): string {
  return `${market.chainId}:${owner.toLowerCase()}:${market.marketId.toLowerCase()}`
}

function leaseStorageKey(scope: string): string {
  return `${LEASE_STORAGE_PREFIX}.${scope}`
}

function randomLeaseToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function readFallbackLease(scope: string): { token: string; expiresAt: number } | undefined {
  try {
    const raw = window.localStorage.getItem(leaseStorageKey(scope))
    if (raw === null || raw.length > 256) return undefined
    const parsed = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown }
    if (
      typeof parsed.token !== 'string' ||
      parsed.token.length < 8 ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      Number(parsed.expiresAt) <= Date.now()
    ) return undefined
    return { token: parsed.token, expiresAt: Number(parsed.expiresAt) }
  } catch {
    return undefined
  }
}

function writeFallbackLease(scope: string, token: string): void {
  window.localStorage.setItem(
    leaseStorageKey(scope),
    JSON.stringify({ token, expiresAt: Date.now() + LEASE_TTL_MS }),
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function acquireFallbackLease(scope: string): Promise<LoopingExecutionLease | undefined> {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage === 'undefined' ||
    typeof BroadcastChannel === 'undefined' ||
    typeof crypto === 'undefined' ||
    typeof crypto.getRandomValues !== 'function'
  ) return undefined

  const existing = readFallbackLease(scope)
  if (existing !== undefined) return undefined
  const token = randomLeaseToken()
  let released = false
  let acquired = false
  let conflict = false
  const channel = new BroadcastChannel(LEASE_CHANNEL_NAME)
  const send = (type: LeaseMessage['type']): void => {
    channel.postMessage({ type, scope, token } satisfies LeaseMessage)
  }
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<LeaseMessage> | null
    if (
      message === null ||
      message.scope !== scope ||
      message.token === token ||
      (message.type !== 'claim' && message.type !== 'held' && message.type !== 'release')
    ) return
    if (message.type === 'claim' && acquired) {
      send('held')
      return
    }
    if (message.type === 'held') conflict = true
    if (
      message.type === 'claim' &&
      !acquired &&
      typeof message.token === 'string' &&
      message.token.localeCompare(token) < 0
    ) conflict = true
  }

  try {
    send('claim')
    await delay(120)
    if (conflict || readFallbackLease(scope) !== undefined) {
      channel.close()
      return undefined
    }
    writeFallbackLease(scope, token)
    send('claim')
    await delay(80)
    const written = readFallbackLease(scope)
    if (conflict || written?.token !== token) {
      if (readFallbackLease(scope)?.token === token) {
        window.localStorage.removeItem(leaseStorageKey(scope))
      }
      channel.close()
      return undefined
    }
    acquired = true
  } catch {
    channel.close()
    return undefined
  }

  const heartbeat = window.setInterval(() => {
    if (released) return
    try {
      if (readFallbackLease(scope)?.token !== token) {
        conflict = true
        return
      }
      writeFallbackLease(scope, token)
    } catch {
      conflict = true
    }
  }, LEASE_HEARTBEAT_MS)

  return {
    assertOwned() {
      if (released || conflict || readFallbackLease(scope)?.token !== token) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'This looping execution lease was lost to another tab.',
        )
      }
    },
    release() {
      if (released) return
      released = true
      window.clearInterval(heartbeat)
      try {
        if (readFallbackLease(scope)?.token === token) {
          window.localStorage.removeItem(leaseStorageKey(scope))
        }
        send('release')
      } finally {
        channel.close()
      }
    },
  }
}

async function acquireExecutionLease(
  owner: Address,
  market: Readonly<LoopingExecutionMarket>,
): Promise<LoopingExecutionLease | undefined> {
  const scope = leaseScope(owner, market)
  if (typeof navigator !== 'undefined' && navigator.locks !== undefined) {
    return new Promise((resolve) => {
      let settled = false
      void navigator.locks.request(
        `${LEASE_STORAGE_PREFIX}.${scope}`,
        { mode: 'exclusive', ifAvailable: true },
        (lock) => {
          if (lock === null) {
            settled = true
            resolve(undefined)
            return undefined
          }
          let released = false
          let releaseLock: (() => void) | undefined
          const hold = new Promise<void>((release) => {
            releaseLock = release
          })
          settled = true
          resolve({
            assertOwned() {
              if (released) {
                throw new LoopingUiSafetyError(
                  'STATE_CONFLICT',
                  'This looping execution lease was already released.',
                )
              }
            },
            release() {
              if (released) return
              released = true
              releaseLock?.()
            },
          })
          return hold
        },
      ).catch(() => {
        if (!settled) resolve(undefined)
      })
    })
  }
  return acquireFallbackLease(scope)
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'The looping operation could not be completed safely.'
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : ''
}

function looksLikeSafetyBlock(error: unknown): boolean {
  return /INPUT|UNSUPPORTED|CAP|BOUND|BUFFER|HEALTH|ALLOW|ROUTE|QUOTE|MARKET|POSITION|WIRING|STATE|STALE|SIGNATURE|SIMULATION|POLICY/i.test(
    errorCode(error),
  )
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function previewOperation(
  preview: Readonly<LoopingExecutionPreview>,
): LoopingExecutionOperation {
  switch (preview.kind) {
    case 'entry-preview':
    case 'increase-preview':
      return 'entry'
    case 'exit-preview':
    case 'decrease-preview':
      return 'exit'
    default:
      throw new LoopingUiSafetyError(
        'STATE_CONFLICT',
        'The prepared looping operation is not recognized.',
      )
  }
}

function isRiskIncreasingPreview(
  preview: Readonly<LoopingExecutionPreview>,
): preview is LoopingEntryExecutionPreview | LoopingIncreaseExecutionPreview {
  return preview.kind === 'entry-preview' || preview.kind === 'increase-preview'
}

function riskIncreaseBuildEnabled(
  preview: Readonly<LoopingEntryExecutionPreview | LoopingIncreaseExecutionPreview>,
): boolean {
  return LOOPING_EXECUTION_BETA_ENABLED &&
    (preview.acquisitionMode === 'market' || LOOPING_MINT_BETA_ENABLED)
}

async function assertRiskIncreaseRuntimeEnabled(
  preview: Readonly<LoopingEntryExecutionPreview | LoopingIncreaseExecutionPreview>,
): Promise<void> {
  await assertLoopingRuntimeEntryEnabled({
    chainId: preview.market.chainId,
    marketId: preview.market.marketId,
  })
  if (preview.acquisitionMode === 'mint') {
    await assertLoopingMintRuntimeActionEnabled({
      action: preview.kind === 'entry-preview' ? 'entry' : 'increase',
      chainId: preview.market.chainId,
      marketId: preview.market.marketId,
    })
  }
}

export function requiresLoopingHighRiskConfirmation(
  preview: Readonly<LoopingExecutionPreview>,
): boolean {
  const liquidationBufferBps = preview.kind === 'entry-preview'
    ? preview.health.liquidationBufferBps
    : preview.kind === 'increase-preview'
      ? preview.conservativePost.liquidationBufferBps
      : undefined
  return liquidationBufferBps !== undefined &&
    liquidationBufferBps < BigInt(preview.market.launchPolicy.minLiquidationBufferBps)
}

function buildUnsignedSimulationForPreview(
  preview: Readonly<LoopingExecutionPreview>,
) {
  switch (preview.kind) {
    case 'entry-preview':
      return buildUnsignedLoopingEntrySimulation(preview)
    case 'increase-preview':
      return buildUnsignedLoopingIncreaseSimulation(preview)
    case 'decrease-preview':
      return buildUnsignedLoopingDecreaseSimulation(preview)
    case 'exit-preview':
      return buildUnsignedLoopingExitSimulation(preview)
    default:
      throw new LoopingUiSafetyError('STATE_CONFLICT', 'Unsigned operation is unsupported.')
  }
}

async function buildSignedBundleForPreview(
  preview: Readonly<LoopingExecutionPreview>,
  authorizeSignature: Hex,
  revokeSignature: Hex,
): Promise<SignedLoopingBundle> {
  switch (preview.kind) {
    case 'entry-preview':
      return buildSignedLoopingEntryBundle(
        preview,
        authorizeSignature,
        revokeSignature,
      )
    case 'increase-preview':
      return buildSignedLoopingIncreaseBundle(
        preview,
        authorizeSignature,
        revokeSignature,
      )
    case 'decrease-preview':
      return buildSignedLoopingDecreaseBundle(
        preview,
        authorizeSignature,
        revokeSignature,
      )
    case 'exit-preview':
      return buildSignedLoopingExitBundle(
        preview,
        authorizeSignature,
        revokeSignature,
      )
    default:
      throw new LoopingUiSafetyError('STATE_CONFLICT', 'Signed operation is unsupported.')
  }
}

async function revalidateSignedBundleForPreview(args: {
  client: PublicClient
  preview: Readonly<LoopingExecutionPreview>
  bundle: Readonly<SignedLoopingBundle>
  simulation: Readonly<LoopingUnsignedSimulationEvidence>
}): Promise<LoopingBroadcastReadiness> {
  const { preview, bundle } = args
  if (preview.kind === 'entry-preview' && bundle.kind === 'signed-entry-bundle') {
    return revalidateSignedLoopingEntry({
      client: args.client,
      preview,
      bundle,
      simulation: args.simulation,
    })
  }
  if (
    preview.kind === 'increase-preview' &&
    bundle.kind === 'signed-increase-bundle'
  ) {
    return revalidateSignedLoopingIncrease({
      client: args.client,
      preview,
      bundle,
      simulation: args.simulation,
    })
  }
  if (
    preview.kind === 'decrease-preview' &&
    bundle.kind === 'signed-decrease-bundle'
  ) {
    return revalidateSignedLoopingDecrease({
      client: args.client,
      preview,
      bundle,
      simulation: args.simulation,
    })
  }
  if (preview.kind === 'exit-preview' && bundle.kind === 'signed-exit-bundle') {
    return revalidateSignedLoopingExit({
      client: args.client,
      preview,
      bundle,
      simulation: args.simulation,
    })
  }
  throw new LoopingUiSafetyError('STATE_CONFLICT', 'Signed bundle operation changed.')
}

async function verifyReceiptForPreview(args: {
  client: PublicClient
  preview: Readonly<LoopingExecutionPreview>
  bundle: Readonly<SignedLoopingBundle>
  readiness: Readonly<LoopingBroadcastReadiness>
  transactionHash: Hash
}): Promise<{ postExecutionRiskWarning: boolean }> {
  const { preview, bundle } = args
  if (preview.kind === 'entry-preview' && bundle.kind === 'signed-entry-bundle') {
    const verification = await verifyLoopingEntryReceiptState({
      client: args.client,
      preview,
      bundle,
      readiness: args.readiness,
      transactionHash: args.transactionHash,
    })
    return {
      postExecutionRiskWarning:
        verification.belowModelBuffer === true ||
        verification.belowEntryValueFloor === true,
    }
  }
  if (
    preview.kind === 'increase-preview' &&
    bundle.kind === 'signed-increase-bundle'
  ) {
    const verification = await verifyLoopingIncreaseReceiptState({
      client: args.client,
      preview,
      bundle,
      readiness: args.readiness,
      transactionHash: args.transactionHash,
    })
    return { postExecutionRiskWarning: verification.belowModelBuffer }
  }
  if (
    preview.kind === 'decrease-preview' &&
    bundle.kind === 'signed-decrease-bundle'
  ) {
    await verifyLoopingDecreaseReceiptState({
      client: args.client,
      preview,
      bundle,
      readiness: args.readiness,
      transactionHash: args.transactionHash,
    })
    return { postExecutionRiskWarning: false }
  }
  if (preview.kind === 'exit-preview' && bundle.kind === 'signed-exit-bundle') {
    await verifyLoopingExitReceiptState({
      client: args.client,
      preview,
      bundle,
      readiness: args.readiness,
      transactionHash: args.transactionHash,
    })
    return { postExecutionRiskWarning: false }
  }
  throw new LoopingUiSafetyError('STATE_CONFLICT', 'Receipt operation changed.')
}

function resolveMarket(
  candidate: LoopingMarketCandidate,
): Readonly<LoopingExecutionMarket> | undefined {
  try {
    return getLoopingExecutionCandidateMarket(candidate)
  } catch {
    return undefined
  }
}

function exactPositionBounds(
  position: Readonly<LoopingPositionSnapshot>,
): LoopingExpectedPositionBounds {
  return {
    supplyShares: '0',
    minBorrowShares: position.borrowShares.toString(),
    maxBorrowShares: position.borrowShares.toString(),
    minCollateral: position.collateral.toString(),
    maxCollateral: position.collateral.toString(),
  }
}

function positionMatchesBounds(
  position: Readonly<LoopingPositionSnapshot>,
  bounds: Readonly<LoopingExpectedPositionBounds>,
): boolean {
  const minBorrowShares = BigInt(bounds.minBorrowShares)
  const maxBorrowShares = BigInt(bounds.maxBorrowShares)
  const minCollateral = BigInt(bounds.minCollateral)
  const maxCollateral = BigInt(bounds.maxCollateral)
  return position.supplyShares === BigInt(bounds.supplyShares) &&
    position.borrowShares >= minBorrowShares &&
    position.borrowShares <= maxBorrowShares &&
    position.collateral >= minCollateral &&
    position.collateral <= maxCollateral
}

function expectedPostOperationBounds(
  preview: Readonly<LoopingExecutionPreview>,
  bundle: Readonly<SignedLoopingBundle>,
): LoopingExpectedPositionBounds {
  if (preview.kind === 'exit-preview' && bundle.kind === 'signed-exit-bundle') {
    return {
      supplyShares: '0',
      minBorrowShares: '0',
      maxBorrowShares: '0',
      minCollateral: '0',
      maxCollateral: '0',
    }
  }
  if (preview.kind === 'entry-preview' && bundle.kind === 'signed-entry-bundle') {
    return {
      supplyShares: '0',
      minBorrowShares: '1',
      maxBorrowShares: bundle.maxBorrowShares.toString(),
      minCollateral: bundle.minimumCollateral.toString(),
      maxCollateral: bundle.minimumCollateral.toString(),
    }
  }
  if (
    preview.kind === 'increase-preview' &&
    bundle.kind === 'signed-increase-bundle'
  ) {
    return {
      supplyShares: '0',
      minBorrowShares: (bundle.startingBorrowShares + 1n).toString(),
      maxBorrowShares: (
        bundle.startingBorrowShares + bundle.maxAddedBorrowShares
      ).toString(),
      minCollateral: (
        bundle.startingCollateral + bundle.minimumAddedCollateral
      ).toString(),
      maxCollateral: (
        bundle.startingCollateral + bundle.minimumAddedCollateral
      ).toString(),
    }
  }
  if (
    preview.kind === 'decrease-preview' &&
    bundle.kind === 'signed-decrease-bundle'
  ) {
    const remainingBorrowShares =
      bundle.startingBorrowShares - bundle.exactRepayShares
    const remainingCollateral =
      bundle.startingCollateral - bundle.exactCollateralToSell
    return {
      supplyShares: '0',
      minBorrowShares: remainingBorrowShares.toString(),
      maxBorrowShares: remainingBorrowShares.toString(),
      minCollateral: remainingCollateral.toString(),
      maxCollateral: remainingCollateral.toString(),
    }
  }
  throw new LoopingUiSafetyError('STATE_CONFLICT', 'Signed bundle and preview operation differ.')
}

function expectedPostPreviewBounds(
  preview: Readonly<LoopingExecutionPreview>,
): LoopingExpectedPositionBounds {
  if (preview.kind === 'exit-preview') {
    return {
      supplyShares: '0',
      minBorrowShares: '0',
      maxBorrowShares: '0',
      minCollateral: '0',
      maxCollateral: '0',
    }
  }
  if (preview.kind === 'entry-preview') {
    return {
      supplyShares: '0',
      minBorrowShares: '1',
      maxBorrowShares: preview.bounds.maxBorrowShares.toString(),
      minCollateral: preview.quotes.minimumCollateral.toString(),
      maxCollateral: preview.quotes.minimumCollateral.toString(),
    }
  }
  if (preview.kind === 'increase-preview') {
    const collateral = preview.position.collateral + preview.quote.minPtOut
    return {
      supplyShares: '0',
      minBorrowShares: (preview.position.borrowShares + 1n).toString(),
      maxBorrowShares: (
        preview.position.borrowShares + preview.bounds.maxBorrowShares
      ).toString(),
      minCollateral: collateral.toString(),
      maxCollateral: collateral.toString(),
    }
  }
  if (preview.kind === 'decrease-preview') {
    const borrowShares = preview.position.borrowShares - preview.repayShares
    const collateral = preview.position.collateral - preview.collateralToSell
    return {
      supplyShares: '0',
      minBorrowShares: borrowShares.toString(),
      maxBorrowShares: borrowShares.toString(),
      minCollateral: collateral.toString(),
      maxCollateral: collateral.toString(),
    }
  }
  throw new LoopingUiSafetyError('STATE_CONFLICT', 'Prepared preview kind is unsupported.')
}

interface LoopingPendingAcquisitionMetadata {
  acquisitionMode?: LoopingPendingAcquisitionMode
  mintDelivery?: LoopingPendingMintDelivery
}

function pendingAcquisitionMetadataForPreview(
  preview: Readonly<LoopingExecutionPreview>,
  transactionHash?: Hash,
): LoopingPendingAcquisitionMetadata {
  if (!isRiskIncreasingPreview(preview)) return {}
  if (preview.acquisitionMode === 'market') {
    return { acquisitionMode: 'market' }
  }
  return {
    acquisitionMode: 'mint',
    mintDelivery: {
      yieldToken: preview.yieldToken,
      minimumYtOut: preview.minimumYtOut.toString(),
      ...(transactionHash === undefined ? {} : { transactionHash }),
    },
  }
}

function pendingAcquisitionMetadataForRecord(
  record: Readonly<LoopingPendingOperation> | undefined,
): LoopingPendingAcquisitionMetadata {
  if (record?.acquisitionMode === undefined) return {}
  if (record.acquisitionMode === 'market') {
    return { acquisitionMode: 'market' }
  }
  return {
    acquisitionMode: 'mint',
    mintDelivery: record.mintDelivery,
  }
}

async function verifyPersistedMintDelivery(args: {
  client: PublicClient
  delivery: Readonly<LoopingPendingMintDelivery>
  transactionHash?: Hash
  owner: Address
  market: Readonly<LoopingExecutionMarket>
}): Promise<void> {
  if (
    args.delivery.transactionHash !== undefined &&
    args.transactionHash !== undefined &&
    args.delivery.transactionHash.toLowerCase() !==
      args.transactionHash.toLowerCase()
  ) {
    throw new LoopingUiSafetyError(
      'STATE_CONFLICT',
      'The persisted Mint Mode transaction hashes do not match.',
    )
  }
  const transactionHash = args.delivery.transactionHash ?? args.transactionHash
  if (transactionHash === undefined) {
    throw new LoopingUiSafetyError(
      'STATE_CONFLICT',
      'The Mint Mode transaction hash or YT delivery bound is unavailable.',
    )
  }
  const [receipt, transactionEvidence] = await Promise.all([
    args.client.getTransactionReceipt({
      hash: transactionHash,
    }),
    readPersistedLoopingMintDeliveryFromTransaction({
      client: args.client,
      transactionHash,
      owner: args.owner,
      market: args.market,
    }),
  ])
  if (
    receipt.status !== 'success' ||
    receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
    receipt.from.toLowerCase() !== args.owner.toLowerCase() ||
    receipt.to === null ||
    receipt.to.toLowerCase() !== args.market.contracts.bundler3.toLowerCase()
  ) {
    throw new LoopingUiSafetyError(
      'STATE_CONFLICT',
      'The persisted Mint Mode transaction could not be matched to a successful bundle.',
    )
  }
  const yieldTokenDecimals = await args.client.readContract({
    address: args.market.yieldToken,
    abi: loopingErc20Abi,
    functionName: 'decimals',
    blockNumber: receipt.blockNumber,
  })
  if (
    yieldTokenDecimals !== args.market.yieldTokenDecimals ||
    yieldTokenDecimals !== args.market.collateralTokenDecimals
  ) {
    throw new LoopingUiSafetyError(
      'STATE_CONFLICT',
      'The persisted Mint Mode YT decimals no longer match the reviewed market.',
    )
  }
  if (
    args.delivery.yieldToken.toLowerCase() !==
      args.market.yieldToken.toLowerCase() ||
    args.delivery.yieldToken.toLowerCase() !==
      transactionEvidence.yieldToken.toLowerCase() ||
    BigInt(args.delivery.minimumYtOut) !== transactionEvidence.minimumYtOut
  ) {
    throw new LoopingUiSafetyError(
      'STATE_CONFLICT',
      'Browser recovery metadata does not match the original Mint Mode bundle.',
    )
  }
  let deliveredYt = 0n
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !==
        transactionEvidence.yieldToken.toLowerCase()
    ) {
      continue
    }
    try {
      const decoded = decodeEventLog({
        abi: LOOPING_TRANSFER_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      })
      if (
        decoded.eventName === 'Transfer' &&
        decoded.args.from.toLowerCase() ===
          args.market.contracts.generalAdapter1.toLowerCase() &&
        decoded.args.to.toLowerCase() === args.owner.toLowerCase()
      ) {
        deliveredYt += decoded.args.value
      }
    } catch {
      // Ignore unrelated events emitted by the reviewed YT contract.
    }
  }
  if (deliveredYt < transactionEvidence.minimumYtOut) {
    throw new LoopingUiSafetyError(
      'STATE_CONFLICT',
      'The persisted Mint Mode transaction delivered less YT than guaranteed.',
    )
  }
}

function makePendingRecord(args: {
  operation: LoopingPendingOperationKind
  owner: Address
  market: Readonly<LoopingExecutionMarket>
  startingNonce: bigint
  deadline: bigint
  expectedPosition?: LoopingExpectedPositionBounds
  txHash?: Hash
  walletTxNonce?: number
  acquisitionMode?: LoopingPendingAcquisitionMode
  mintDelivery?: LoopingPendingMintDelivery
}): LoopingPendingOperation {
  return {
    version: LOOPING_PENDING_VERSION,
    operation: args.operation,
    chainId: args.market.chainId,
    owner: args.owner,
    marketId: args.market.marketId,
    ...(args.txHash === undefined ? {} : { txHash: args.txHash }),
    ...(args.walletTxNonce === undefined
      ? {}
      : { walletTxNonce: BigInt(args.walletTxNonce).toString() }),
    startingMorphoNonce: args.startingNonce.toString(),
    authorizationDeadline: args.deadline.toString(),
    createdAt: Date.now(),
    ...(args.expectedPosition === undefined
      ? {}
      : { expectedPosition: args.expectedPosition }),
    ...(args.acquisitionMode === undefined
      ? {}
      : { acquisitionMode: args.acquisitionMode }),
    ...(args.mintDelivery === undefined
      ? {}
      : { mintDelivery: args.mintDelivery }),
  }
}

export function useLoopingExecution({
  candidate,
  equityAssets,
  leverage,
  intent = 'auto',
  acquisitionMode = 'market',
}: {
  candidate: LoopingMarketCandidate
  equityAssets: bigint
  leverage: string
  intent?: LoopingExecutionIntent
  acquisitionMode?: LoopingAcquisitionMode
}): UseLoopingExecutionResult {
  const { address: owner, chainId: walletChainId, isConnected } = useAccount()
  const market = useMemo(() => resolveMarket(candidate), [candidate])
  const { data: walletClient } = useWalletClient({ chainId: market?.chainId })
  const walletReadClient = useMemo(() => {
    if (walletClient === undefined) return undefined
    return createLoopingWalletReadClient(walletClient) as PublicClient
  }, [walletClient])
  const { openConnectModal } = useConnectModal()
  const { switchChain } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()
  const { sendTransactionAsync } = useSendTransaction()
  const [eligibilityNow, setEligibilityNow] = useState(
    () => Math.floor(Date.now() / 1_000),
  )
  useEffect(() => {
    const timer = window.setInterval(
      () => setEligibilityNow(Math.floor(Date.now() / 1_000)),
      30_000,
    )
    return () => window.clearInterval(timer)
  }, [])
  const riskIncreaseEligibility = useMemo(
    () => evaluateLoopingRiskIncreaseEligibility(candidate, eligibilityNow),
    [candidate, eligibilityNow],
  )
  const assertRiskIncreaseEligible = useCallback((): void => {
    const eligibility = evaluateLoopingRiskIncreaseEligibility(candidate)
    if (!eligibility.eligible) {
      throw new LoopingUiSafetyError('LIQUIDITY_GATE', eligibility.message)
    }
  }, [candidate])
  const borrowResult = useMemo(() => {
    if (intent !== 'auto') return {}
    try {
      return { borrowAssets: deriveLoopingBorrowAssets(equityAssets, leverage) }
    } catch (error) {
      return { error: readableError(error) }
    }
  }, [equityAssets, intent, leverage])
  const borrowAssets = borrowResult.borrowAssets
  const entryInputBlock = useMemo(() => {
    if (!market) return undefined
    if (borrowResult.error) return borrowResult.error
    if (borrowAssets === undefined || borrowAssets <= 0n) {
      return 'Choose leverage above 1× to start a new loop.'
    }
    if (equityAssets <= 0n) return 'Enter a positive equity amount.'
    return undefined
  }, [borrowAssets, borrowResult.error, equityAssets, market])

  const fingerprint = [
    owner?.toLowerCase() ?? '',
    walletChainId ?? 0,
    candidate.morpho.chainId,
    candidate.morpho.marketId.toLowerCase(),
    candidate.pendle.market.toLowerCase(),
    intent,
    acquisitionMode,
    equityAssets.toString(),
    leverage,
    borrowAssets?.toString() ?? '',
    walletClient?.uid ?? '',
  ].join(':')

  const [state, setState] = useState<LoopingExecutionState>({
    phase: 'idle',
    fingerprint,
  })
  const contextRef = useRef({
    fingerprint,
    owner,
    walletChainId,
    market,
    walletClientUid: walletClient?.uid,
  })
  contextRef.current = {
    fingerprint,
    owner,
    walletChainId,
    market,
    walletClientUid: walletClient?.uid,
  }
  const sequenceRef = useRef(0)
  const activeRunRef = useRef<number | null>(null)
  const recoveryRef = useRef<InMemoryRecovery | undefined>(undefined)
  const unresolvedRef = useRef(false)

  useEffect(() => {
    // An unresolved signed operation owns this panel until it is reconciled.
    // Pending metadata cannot recreate its in-memory signatures, so even an
    // unexpected account/input event must not discard the recovery bundle.
    if (unresolvedRef.current) return
    sequenceRef.current += 1
    activeRunRef.current = null
    recoveryRef.current = undefined
    if (market !== undefined && owner !== undefined) {
      const pendingRecord = readLoopingPendingOperation({
        chainId: market.chainId,
        owner,
        marketId: market.marketId,
      })
      if (pendingRecord !== undefined) {
        unresolvedRef.current = true
        setState({
          phase: 'ambiguous',
          fingerprint,
          operation: pendingRecord.operation === 'exit' ? 'exit' :
            pendingRecord.operation === 'entry' ? 'entry' : undefined,
          txHash: pendingRecord.txHash,
          pendingRecord,
          message: pendingRecord.operation === 'allowance-cleanup'
            ? 'A previous attempt may have left an exact adapter allowance. Verify and clear it before trying again.'
            : pendingRecord.operation === 'metadata-cleanup'
              ? 'A previous unsigned attempt left browser recovery metadata that must be removed.'
              : 'A previous looping transaction is unresolved. It will not be retried automatically.',
        })
        return
      }
    }
    setState({ phase: 'idle', fingerprint })
  }, [fingerprint, market, owner])

  const boundState = useMemo<LoopingExecutionState>(() =>
    unresolvedRef.current || state.fingerprint === fingerprint
      ? state
      : { phase: 'idle', fingerprint },
  [fingerprint, state])
  const busy = BUSY_PHASES.has(boundState.phase)
  useTransactionGuard(busy || boundState.phase === 'ambiguous')

  const captureContext = useCallback((): OperationContext => {
    if (owner === undefined || market === undefined || walletClient === undefined) {
      throw new LoopingUiSafetyError('STATE_CONFLICT', 'Wallet RPC or market context is missing.')
    }
    return {
      fingerprint,
      owner,
      chainId: market.chainId,
      marketId: market.marketId,
      walletClientUid: walletClient.uid,
    }
  }, [fingerprint, market, owner, walletClient])

  const assertContext = useCallback((expected: Readonly<OperationContext>): void => {
    const current = contextRef.current
    if (
      current.fingerprint !== expected.fingerprint ||
      current.owner === undefined ||
      current.owner.toLowerCase() !== expected.owner.toLowerCase() ||
      current.walletChainId !== expected.chainId ||
      current.walletClientUid !== expected.walletClientUid ||
      current.market === undefined ||
      current.market.chainId !== expected.chainId ||
      !sameHex(current.market.marketId, expected.marketId)
    ) {
      throw new LoopingUiSafetyError(
        'STATE_CONFLICT',
        'The connected wallet, network, market, or amount changed. Start again.',
      )
    }
  }, [])

  const runIsCurrent = useCallback((run: number): boolean =>
    activeRunRef.current === run && contextRef.current.fingerprint === fingerprint,
  [fingerprint])

  const withWalletRead = useCallback(async <T,>(
    task: (client: PublicClient) => Promise<T>,
  ): Promise<{ value: T }> => {
    if (walletReadClient === undefined) {
      throw new LoopingUiSafetyError(
        'STATE_CONFLICT',
        "The connected wallet's selected-chain RPC is unavailable.",
      )
    }
    return { value: await task(walletReadClient) }
  }, [walletReadClient])

  const freshPreview = useCallback(async (): Promise<{
    preview: LoopingExecutionPreview
    position: LoopingPositionSnapshot
  }> => {
    if (owner === undefined || market === undefined) {
      throw new LoopingUiSafetyError('STATE_CONFLICT', 'Connect a wallet and select a supported looping market.')
    }
    const positionRead = await withWalletRead((client) =>
      readLoopingExecutionPosition({ client, owner, market }),
    )
    const position = positionRead.value
    if (position.classification === 'conflicting-supply') {
      throw new LoopingUiSafetyError(
        'STATE_CONFLICT',
        'This Morpho market also contains a supply position. Automatic looping is blocked.',
      )
    }
    if (position.classification === 'empty') {
      if (intent !== 'auto') {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          intent === 'adjust'
            ? 'This loop no longer exists, so there is no leverage to adjust.'
            : 'This loop is already fully closed.',
        )
      }
      if (entryInputBlock !== undefined || borrowAssets === undefined) {
        throw new LoopingUiSafetyError('INVALID_INPUT', entryInputBlock ?? 'Entry amount is invalid.')
      }
      assertRiskIncreaseEligible()
      const prepared = await withWalletRead((client) =>
        prepareLoopingEntryExecution({
          client,
          owner,
          market,
          equityAssets,
          borrowAssets,
          acquisitionMode,
        }),
      )
      return {
        preview: prepared.value,
        position,
      }
    }
    if (intent === 'adjust') {
      const targetLeverageWad = parseLoopingTargetLeverageWad(leverage)
      const prepared = await withWalletRead((client) =>
        prepareLoopingAdjustmentExecution({
          client,
          owner,
          market,
          targetLeverageWad,
          acquisitionMode,
        }),
      )
      if (isRiskIncreasingPreview(prepared.value)) assertRiskIncreaseEligible()
      return {
        preview: prepared.value,
        position,
      }
    }
    const prepared = await withWalletRead((client) =>
      prepareLoopingExitExecution({
        client,
        owner,
        market,
        minimumReturnedAssets: EXIT_QUOTE_DISCOVERY_FLOOR,
      }),
    )
    return {
      preview: prepared.value,
      position,
    }
  }, [acquisitionMode, assertRiskIncreaseEligible, borrowAssets, entryInputBlock,
    equityAssets, intent, leverage, market, owner, withWalletRead])

  const beginRun = useCallback((): number | undefined => {
    if (activeRunRef.current !== null) return undefined
    const run = ++sequenceRef.current
    activeRunRef.current = run
    return run
  }, [])

  const finishRun = useCallback((run: number): void => {
    if (activeRunRef.current === run) activeRunRef.current = null
  }, [])

  const prepare = useCallback(async (): Promise<void> => {
    if (
      market === undefined ||
      !isConnected ||
      owner === undefined ||
      walletReadClient === undefined ||
      walletChainId !== market.chainId ||
      boundState.phase === 'ambiguous'
    ) return
    const run = beginRun()
    if (run === undefined) return
    const operationContext = captureContext()
    const lease = await acquireExecutionLease(operationContext.owner, market)
    if (lease === undefined) {
      setState({
        phase: 'blocked',
        fingerprint,
        message: 'Another OpenPendle tab is already handling this wallet and market.',
      })
      finishRun(run)
      return
    }
    recoveryRef.current = undefined
    setState({ phase: 'checking', fingerprint })
    try {
      lease.assertOwned()
      assertContext(operationContext)
      const prepared = await freshPreview()
      if (!runIsCurrent(run)) return
      assertContext(operationContext)
      setState({
        phase: 'ready',
        fingerprint,
        operation: previewOperation(prepared.preview),
        preview: prepared.preview,
        position: prepared.position,
      })
    } catch (error) {
      setState({
        phase: looksLikeSafetyBlock(error) ? 'blocked' : 'error',
        fingerprint,
        message: readableError(error),
      })
    } finally {
      lease.release()
      finishRun(run)
    }
  }, [assertContext, beginRun, boundState.phase, captureContext, fingerprint,
    finishRun, freshPreview, isConnected, market, owner, runIsCurrent, walletChainId,
    walletReadClient])

  const waitForApprovalReceipt = useCallback(async (
    hash: Hash,
    operationContext: Readonly<OperationContext>,
  ): Promise<Hash> => {
    let effectiveHash = hash
    let unsafeReplacement: 'cancelled' | 'replaced' | undefined
    const waited = await withWalletRead(async (client) => {
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: LOOPING_RECEIPT_CONFIRMATIONS,
        onReplaced: (replacement) => {
          effectiveHash = replacement.transaction.hash
          if (replacement.reason !== 'repriced') unsafeReplacement = replacement.reason
        },
      })
      return receipt
    })
    assertContext(operationContext)
    if (unsafeReplacement !== undefined) {
      throw new LoopingUiSafetyError(
        'STATE_CONFLICT',
        `The approval transaction was ${unsafeReplacement}. Run a fresh check before continuing.`,
      )
    }
    if (waited.value.status !== 'success') {
      throw new LoopingUiSafetyError('STATE_CONFLICT', 'The allowance transaction reverted.')
    }
    return effectiveHash
  }, [assertContext, withWalletRead])

  const sendExactApproval = useCallback(async (args: {
    preview: LoopingEntryExecutionPreview
    amount: bigint
    operationContext: Readonly<OperationContext>
    onBeforeWrite?: () => void
  }): Promise<Hash> => {
    if (!riskIncreaseBuildEnabled(args.preview)) {
      throw new LoopingUiSafetyError(
        'STATE_CONFLICT',
        args.preview.acquisitionMode === 'mint'
          ? 'Mint Mode entry is disabled in this build.'
          : 'New-loop entry is disabled in this build.',
      )
    }
    if (args.amount > 0n) {
      await assertRiskIncreaseRuntimeEnabled(args.preview)
    }
    args.onBeforeWrite?.()
    assertContext(args.operationContext)
    const hash = await writeContractAsync({
      account: args.operationContext.owner,
      chainId: args.operationContext.chainId,
      address: args.preview.approval.token,
      abi: loopingErc20Abi,
      functionName: 'approve',
      args: [args.preview.approval.spender, args.amount],
    })
    assertContext(args.operationContext)
    return waitForApprovalReceipt(hash, args.operationContext)
  }, [assertContext, waitForApprovalReceipt, writeContractAsync])

  const refreshSameOperation = useCallback(async (
    previewKind: LoopingExecutionPreview['kind'],
  ): Promise<{
    preview: LoopingExecutionPreview
    position: LoopingPositionSnapshot
  }> => {
    const prepared = await freshPreview()
    if (prepared.preview.kind !== previewKind) {
      throw new LoopingUiSafetyError(
        'STATE_CONFLICT',
        'The Morpho position or adjustment direction changed while the looping flow was open.',
      )
    }
    return prepared
  }, [freshPreview])

  const persistMainPending = useCallback((args: {
    preview: LoopingExecutionPreview
    bundle: SignedLoopingBundle
    txHash?: Hash
    walletTxNonce?: number
  }): LoopingPendingOperation => {
    if (market === undefined || owner === undefined) {
      throw new LoopingUiSafetyError('STATE_CONFLICT', 'Pending-operation scope is unavailable.')
    }
    const record = makePendingRecord({
      operation: previewOperation(args.preview),
      owner,
      market,
      startingNonce: args.bundle.startingNonce,
      deadline: args.bundle.deadline,
      expectedPosition: expectedPostOperationBounds(args.preview, args.bundle),
      txHash: args.txHash,
      walletTxNonce: args.walletTxNonce,
      ...pendingAcquisitionMetadataForPreview(args.preview, args.txHash),
    })
    if (!writeLoopingPendingOperation(record)) {
      throw new LoopingUiSafetyError(
        'STATE_CONFLICT',
        'This browser cannot safely persist pending-operation metadata.',
      )
    }
    return record
  }, [market, owner])

  const markAmbiguous = useCallback((args: {
    operation: LoopingExecutionOperation
    preview: LoopingExecutionPreview
    bundle: SignedLoopingBundle
    message: string
    txHash?: Hash
    walletTxNonce?: number
  }): void => {
    unresolvedRef.current = true
    let pendingRecord: LoopingPendingOperation | undefined
    try {
      pendingRecord = persistMainPending({
        preview: args.preview,
        bundle: args.bundle,
        txHash: args.txHash,
        walletTxNonce: args.walletTxNonce,
      })
    } catch (persistError) {
      setState({
        phase: 'ambiguous',
        fingerprint,
        operation: args.operation,
        preview: args.preview,
        txHash: args.txHash,
        message: `${args.message} ${readableError(persistError)}`,
      })
      return
    }
    setState({
      phase: 'ambiguous',
      fingerprint,
      operation: args.operation,
      preview: args.preview,
      txHash: args.txHash,
      pendingRecord,
      message: args.message,
    })
  }, [fingerprint, persistMainPending])

  const execute = useCallback(async (
    acceptance: LoopingRiskAcceptance = {},
  ): Promise<void> => {
    const initialPreview = boundState.preview
    const operation = boundState.operation
    const preparedOperation = initialPreview === undefined
      ? undefined
      : previewOperation(initialPreview)
    if (
      initialPreview !== undefined &&
      operation !== undefined &&
      preparedOperation !== operation
    ) {
      setState({
        phase: 'blocked',
        fingerprint,
        message: 'The prepared looping operation is inconsistent. Run a fresh check.',
      })
      return
    }
    const operationEnabled = initialPreview === undefined
      ? false
      : isRiskIncreasingPreview(initialPreview)
        ? riskIncreaseBuildEnabled(initialPreview)
        : LOOPING_EXIT_BETA_ENABLED
    if (
      !operationEnabled ||
      initialPreview === undefined ||
      operation === undefined ||
      boundState.phase !== 'ready' ||
      market === undefined ||
      owner === undefined ||
      walletReadClient === undefined ||
      walletChainId !== market.chainId
    ) return
    if (
      requiresLoopingHighRiskConfirmation(initialPreview) &&
      acceptance.highLiquidationRiskAccepted !== true
    ) {
      setState((current) => current.fingerprint === fingerprint
        ? {
            ...current,
            message: 'Confirm that you accept the elevated liquidation risk before continuing.',
          }
        : current)
      return
    }
    const run = beginRun()
    if (run === undefined) return
    const operationContext = captureContext()
    const lease = await acquireExecutionLease(operationContext.owner, market)
    if (lease === undefined) {
      setState({
        phase: 'blocked',
        fingerprint,
        operation,
        preview: initialPreview,
        message: 'Another OpenPendle tab is already handling this wallet and market.',
      })
      finishRun(run)
      return
    }
    recoveryRef.current = undefined
    let preview = initialPreview
    let bundle: SignedLoopingBundle | undefined
    let readiness: LoopingBroadcastReadiness | undefined
    let firstAuthorizationSigned = false
    let adapterAllowanceRequiresCleanup = false
    let partialPendingRecord: LoopingPendingOperation | undefined
    let txHash: Hash | undefined
    let walletTxNonce: number | undefined
    try {
      // The API liquidity floor applies only to operations that add debt. Check
      // it before approval/signature side effects and again before signing.
      if (isRiskIncreasingPreview(preview)) assertRiskIncreaseEligible()
      if (preview.kind === 'entry-preview') {
        if (preview.approval.current !== 0n && preview.approval.current !== preview.approval.required) {
          setState({ phase: 'clearing-allowance', fingerprint, operation, preview })
          lease.assertOwned()
          await sendExactApproval({ preview, amount: 0n, operationContext })
          if (!runIsCurrent(run)) return
          const refreshed = await refreshSameOperation(preview.kind)
          preview = refreshed.preview
          if (preview.kind !== 'entry-preview' || preview.approval.current !== 0n) {
            throw new LoopingUiSafetyError('STATE_CONFLICT', 'The adapter allowance did not clear to zero.')
          }
        }
        if (preview.approval.current !== preview.approval.required) {
          setState({ phase: 'approving', fingerprint, operation, preview })
          lease.assertOwned()
          // Once the wallet is asked to set an adapter allowance, receipt/RPC
          // ambiguity must be treated as if the allowance may have landed.
          await sendExactApproval({
            preview,
            amount: preview.approval.required,
            operationContext,
            onBeforeWrite: () => {
              adapterAllowanceRequiresCleanup = true
            },
          })
          if (!runIsCurrent(run)) return
          const refreshed = await refreshSameOperation(preview.kind)
          preview = refreshed.preview
          if (
            preview.kind !== 'entry-preview' ||
            preview.approval.current !== preview.approval.required ||
            preview.approval.needed
          ) {
            throw new LoopingUiSafetyError(
              'STATE_CONFLICT',
              'The exact entry allowance was not confirmed on-chain.',
            )
          }
        }
        adapterAllowanceRequiresCleanup =
          preview.approval.required > 0n &&
          preview.approval.current === preview.approval.required
      }

      assertContext(operationContext)
      setState({ phase: 'simulating', fingerprint, operation, preview })
      const unsignedIntent = buildUnsignedSimulationForPreview(preview)
      await withWalletRead((client) =>
        simulateUnsignedLoopingIntent({ client, intent: unsignedIntent }),
      )
      if (!runIsCurrent(run)) return
      assertContext(operationContext)

      const [authorizeRequest, revokeRequest] = preview.authorizationRequests
      try {
        walletTxNonce = (await withWalletRead(
          (client) => client.getTransactionCount({ address: owner, blockTag: 'pending' }),
        )).value
      } catch {
        // Metadata remains valid without a wallet nonce, but recovery will stay
        // conservative if submission later becomes ambiguous without a hash.
      }
      if (
        preview.validUntilMs - Date.now() <
          MIN_QUOTE_FRESHNESS_BEFORE_SIGNATURE_MS
      ) {
        throw new LoopingUiSafetyError(
          'QUOTE_EXPIRED',
          'The quote is too close to expiry to request authorization signatures. Run a fresh check.',
        )
      }
      if (isRiskIncreasingPreview(preview)) {
        assertRiskIncreaseEligible()
        if (
          requiresLoopingHighRiskConfirmation(preview) &&
          acceptance.highLiquidationRiskAccepted !== true
        ) {
          throw new LoopingUiSafetyError(
            'RISK_CONFIRMATION',
            'The refreshed position crossed below the 10% warning buffer. Confirm the elevated liquidation risk on a fresh preview.',
          )
        }
      }
      partialPendingRecord = makePendingRecord({
        operation,
        owner,
        market,
        startingNonce: authorizeRequest.message.nonce,
        deadline: authorizeRequest.message.deadline,
        expectedPosition: expectedPostPreviewBounds(preview),
        walletTxNonce,
        ...pendingAcquisitionMetadataForPreview(preview),
      })
      if (!writeLoopingPendingOperation(partialPendingRecord)) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'This browser cannot persist recovery metadata, so no signature was requested.',
        )
      }
      unresolvedRef.current = true
      lease.assertOwned()
      assertContext(operationContext)
      if (isRiskIncreasingPreview(preview)) {
        await assertRiskIncreaseRuntimeEnabled(preview)
        if (!runIsCurrent(run)) {
          throw new LoopingUiSafetyError(
            'STATE_CONFLICT',
            'Wallet context changed during the live risk-increase policy check.',
          )
        }
        lease.assertOwned()
        assertContext(operationContext)
      }
      if (
        preview.validUntilMs - Date.now() <
          MIN_QUOTE_FRESHNESS_BEFORE_SIGNATURE_MS
      ) {
        throw new LoopingUiSafetyError(
          'QUOTE_EXPIRED',
          'The quote became too old during the live entry-policy check. Run a fresh check.',
        )
      }
      setState({
        phase: 'signing-authorize',
        fingerprint,
        operation,
        preview,
      })
      const authorizeSignature = await signTypedDataAsync({
        account: owner,
        domain: authorizeRequest.domain,
        types: authorizeRequest.types,
        primaryType: authorizeRequest.primaryType,
        message: authorizeRequest.message,
      })
      firstAuthorizationSigned = true
      if (!runIsCurrent(run)) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'Wallet context changed after the first authorization signature.',
        )
      }
      assertContext(operationContext)

      setState({ phase: 'signing-revoke', fingerprint, operation, preview })
      lease.assertOwned()
      const revokeSignature = await signTypedDataAsync({
        account: owner,
        domain: revokeRequest.domain,
        types: revokeRequest.types,
        primaryType: revokeRequest.primaryType,
        message: revokeRequest.message,
      })
      if (!runIsCurrent(run)) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'Wallet context changed after the second authorization signature.',
        )
      }
      assertContext(operationContext)

      bundle = await buildSignedBundleForPreview(
        preview,
        authorizeSignature,
        revokeSignature,
      )
      const pair = await decodeExposedLoopingAuthorizationPair({
        market,
        owner,
        bundleData: bundle.data,
      })
      recoveryRef.current = { preview, bundle, pair }

      setState({ phase: 'revalidating', fingerprint, operation, preview })
      // The two signatures and signed bundle remain local. Each attempt runs
      // the authorization-free simulation and its exact-block revalidation on
      // one client; only transport/capability failures may select the wallet's
      // read-only RPC for the complete second attempt.
      const signedPreview = preview
      const signedBundle = bundle
      const finalValidation = await withWalletRead(
        async (client) => {
          const finalUnsignedIntent = buildUnsignedSimulationForPreview(signedPreview)
          const finalSimulation = await simulateUnsignedLoopingIntent({
            client,
            intent: finalUnsignedIntent,
          })
          return revalidateSignedBundleForPreview({
            client,
            preview: signedPreview,
            bundle: signedBundle,
            simulation: finalSimulation,
          })
        },
      )
      readiness = finalValidation.value
      if (!runIsCurrent(run)) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'Wallet context changed during the final signed-state recheck.',
        )
      }
      assertContext(operationContext)

      // Persist only closed-schema metadata before the wallet sees signed calldata.
      try {
        walletTxNonce = (await withWalletRead(
          (client) => client.getTransactionCount({ address: owner, blockTag: 'pending' }),
        )).value
      } catch {
        // A missing wallet nonce does not justify exposing signed calldata to
        // another service; the strict no-hash state still remains blocked.
      }
      persistMainPending({ preview, bundle, walletTxNonce })
      unresolvedRef.current = true
      if (isRiskIncreasingPreview(preview)) {
        await assertRiskIncreaseRuntimeEnabled(preview)
        if (!runIsCurrent(run)) {
          throw new LoopingUiSafetyError(
            'STATE_CONFLICT',
            'Wallet context changed during the final live risk-increase policy check.',
          )
        }
        lease.assertOwned()
        assertContext(operationContext)
      }
      if (
        preview.validUntilMs - Date.now() <
          MIN_QUOTE_FRESHNESS_BEFORE_SUBMISSION_MS
      ) {
        throw new LoopingUiSafetyError(
          'QUOTE_EXPIRED',
          'The signed route is too close to expiry to submit safely.',
        )
      }
      setState({ phase: 'submitting', fingerprint, operation, preview })
      lease.assertOwned()
      assertContext(operationContext)
      txHash = await sendTransactionAsync({
        account: owner,
        chainId: operationContext.chainId,
        to: bundle.to,
        data: bundle.data,
        value: bundle.value,
      })
      if (!runIsCurrent(run)) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'Wallet context changed after transaction submission.',
        )
      }
      assertContext(operationContext)
      let pendingRecord = persistMainPending({ preview, bundle, txHash, walletTxNonce })
      setState({ phase: 'pending', fingerprint, operation, preview, txHash, pendingRecord })

      let unsafeReplacement: 'cancelled' | 'replaced' | undefined
      const receipt = (await withWalletRead(
        (client) => client.waitForTransactionReceipt({
          hash: txHash!,
          confirmations: LOOPING_RECEIPT_CONFIRMATIONS,
          onReplaced: (replacement) => {
            txHash = replacement.transaction.hash
            if (replacement.reason !== 'repriced') unsafeReplacement = replacement.reason
            try {
              pendingRecord = persistMainPending({
                preview,
                bundle: bundle!,
                txHash,
                walletTxNonce,
              })
            } catch {
              // The final state remains ambiguous if metadata storage fails.
            }
            setState({ phase: 'pending', fingerprint, operation, preview, txHash, pendingRecord })
          },
        }),
      )).value
      if (!runIsCurrent(run)) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'Wallet context changed while the transaction was pending.',
        )
      }
      lease.assertOwned()
      assertContext(operationContext)
      if (unsafeReplacement !== undefined) {
        markAmbiguous({
          operation,
          preview,
          bundle,
          txHash,
          walletTxNonce,
          message: `The signed transaction was ${unsafeReplacement}. OpenPendle will not retry it. Secure the exposed Morpho authorization pair.`,
        })
        return
      }
      if (receipt.status !== 'success') {
        markAmbiguous({
          operation,
          preview,
          bundle,
          txHash,
          walletTxNonce,
          message: 'The looping transaction reverted. Its authorization signatures were exposed; secure them before trying again.',
        })
        return
      }

      setState({ phase: 'verifying', fingerprint, operation, preview, txHash, pendingRecord })
      if (readiness === undefined) {
        throw new LoopingUiSafetyError('STATE_CONFLICT', 'Broadcast readiness evidence is missing.')
      }
      if (txHash === undefined) {
        throw new LoopingUiSafetyError('STATE_CONFLICT', 'Mined transaction hash is missing.')
      }
      if (bundle === undefined) {
        throw new LoopingUiSafetyError('STATE_CONFLICT', 'Signed bundle is missing.')
      }
      const verifiedReadiness = readiness
      const verifiedTransactionHash = txHash
      const verifiedBundle = bundle
      const receiptVerification = await withWalletRead((client) => verifyReceiptForPreview({
          client,
          preview,
          bundle: verifiedBundle,
          readiness: verifiedReadiness,
          transactionHash: verifiedTransactionHash,
        }))
      const pendingCleared = clearLoopingPendingOperation({
        chainId: market.chainId,
        owner,
        marketId: market.marketId,
      })
      if (!pendingCleared) {
        unresolvedRef.current = true
        setState({
          phase: 'ambiguous',
          fingerprint,
          operation,
          preview,
          txHash,
          pendingRecord,
          message: 'The transaction and on-chain position were verified, but browser recovery metadata could not be removed. Retry reconciliation before starting another operation.',
        })
        return
      }
      recoveryRef.current = undefined
      unresolvedRef.current = false
      setState({
        phase: 'confirmed',
        fingerprint,
        operation,
        txHash,
        noticeTone: receiptVerification.value.postExecutionRiskWarning
          ? 'danger'
          : 'success',
        notice: receiptVerification.value.postExecutionRiskWarning
          ? 'Transaction confirmed and permissions revoked, but the mined position is outside the preview safety policy. Reduce leverage or exit immediately.'
          : preview.kind === 'entry-preview'
            ? 'Loop opened and verified on-chain.'
            : preview.kind === 'increase-preview'
              ? 'Leverage increased and verified on-chain.'
              : preview.kind === 'decrease-preview'
                ? 'Leverage decreased and verified on-chain.'
                : 'Loop fully exited and verified on-chain.',
      })
    } catch (error) {
      if (firstAuthorizationSigned) {
        if (bundle !== undefined) {
          markAmbiguous({
            operation,
            preview,
            bundle,
            txHash,
            walletTxNonce,
            message: `${readableError(error)} Authorization signatures exist, so the operation stays blocked until they are invalidated.`,
          })
          return
        }
        unresolvedRef.current = true
        setState({
          phase: 'ambiguous',
          fingerprint,
          operation,
          preview,
          txHash,
          pendingRecord: partialPendingRecord,
          message: isUserRejection(error)
            ? 'The second signature or transaction was declined after an authorization signature existed. Invalidate its nonce before trying again.'
            : `${readableError(error)} The existing authorization nonce must be invalidated before trying again.`,
        })
        return
      }
      if (adapterAllowanceRequiresCleanup && preview.kind === 'entry-preview') {
        const authorizeRequest = preview.authorizationRequests[0]
        const cleanupRecord = makePendingRecord({
          operation: 'allowance-cleanup',
          owner,
          market,
          startingNonce: authorizeRequest.message.nonce,
          deadline: authorizeRequest.message.deadline,
          expectedPosition: exactPositionBounds(preview.position),
          walletTxNonce,
          ...pendingAcquisitionMetadataForPreview(preview),
        })
        const persisted = writeLoopingPendingOperation(cleanupRecord)
        recoveryRef.current = undefined
        unresolvedRef.current = true
        setState({
          phase: 'ambiguous',
          fingerprint,
          operation,
          preview,
          pendingRecord: cleanupRecord,
          message: isUserRejection(error)
            ? 'The signature was declined before any Morpho authorization was exposed. Clear the exact adapter allowance before trying again.'
            : `${readableError(error)} No Morpho authorization was exposed, but the exact adapter allowance must be cleared before trying again.${persisted ? '' : ' Keep this page open because browser storage is unavailable.'}`,
        })
        return
      }
      if (partialPendingRecord !== undefined) {
        const pendingCleared = clearLoopingPendingOperation({
          chainId: market.chainId,
          owner,
          marketId: market.marketId,
        })
        if (!pendingCleared) {
          const metadataRecord: LoopingPendingOperation = {
            ...partialPendingRecord,
            operation: 'metadata-cleanup',
            createdAt: Date.now(),
          }
          writeLoopingPendingOperation(metadataRecord)
          recoveryRef.current = undefined
          unresolvedRef.current = true
          setState({
            phase: 'ambiguous',
            fingerprint,
            operation,
            preview,
            pendingRecord: metadataRecord,
            message: 'No Morpho authorization signature was exposed, but browser recovery metadata could not be removed. Retry browser cleanup before starting another operation.',
          })
          return
        }
      }
      recoveryRef.current = undefined
      unresolvedRef.current = false
      if (!runIsCurrent(run)) return
      setState({
        phase: looksLikeSafetyBlock(error) ? 'blocked' : 'error',
        fingerprint,
        operation,
        preview,
        message: readableError(error),
      })
    } finally {
      lease.release()
      finishRun(run)
    }
  }, [assertContext, assertRiskIncreaseEligible, beginRun, boundState.operation, boundState.phase,
    boundState.preview, captureContext, fingerprint, finishRun, markAmbiguous,
    market, owner, persistMainPending, refreshSameOperation, runIsCurrent,
    sendExactApproval, sendTransactionAsync, signTypedDataAsync, walletChainId,
    walletReadClient,
    withWalletRead])

  const recover = useCallback(async (): Promise<void> => {
    if (
      boundState.phase !== 'ambiguous' ||
      market === undefined ||
      owner === undefined ||
      walletReadClient === undefined ||
      walletChainId !== market.chainId
    ) return
    const inMemoryRecovery = recoveryRef.current
    const storedPending = boundState.pendingRecord ?? readLoopingPendingOperation({
      chainId: market.chainId,
      owner,
      marketId: market.marketId,
    })
    if (inMemoryRecovery === undefined && storedPending === undefined) return
    if (
      inMemoryRecovery !== undefined &&
      (inMemoryRecovery.pair.owner.toLowerCase() !== owner.toLowerCase() ||
        inMemoryRecovery.pair.market.chainId !== market.chainId ||
        !sameHex(inMemoryRecovery.pair.market.marketId, market.marketId))
    ) {
      setState({
        ...boundState,
        message: 'Reconnect the original wallet and reselect its market before recovery.',
      })
      return
    }
    if (
      storedPending !== undefined &&
      (storedPending.owner.toLowerCase() !== owner.toLowerCase() ||
        storedPending.chainId !== market.chainId ||
        !sameHex(storedPending.marketId, market.marketId))
    ) {
      setState({
        ...boundState,
        message: 'Reconnect the wallet that created this pending operation before recovery.',
      })
      return
    }
    const run = beginRun()
    if (run === undefined) return
    const operationContext = captureContext()
    const lease = await acquireExecutionLease(operationContext.owner, market)
    if (lease === undefined) {
      setState({
        ...boundState,
        message: 'Another OpenPendle tab is already handling this wallet and market.',
      })
      finishRun(run)
      return
    }
    const operation = inMemoryRecovery?.pair.operation ??
      (storedPending?.operation === 'exit' ? 'exit' : 'entry')
    const cleanupOnly = storedPending?.operation === 'allowance-cleanup'
    const metadataOnly = storedPending?.operation === 'metadata-cleanup'
    const recoveryPreview = inMemoryRecovery?.preview
    const baseRecoveryAcquisitionMetadata =
      storedPending?.acquisitionMode === undefined
        ? recoveryPreview === undefined
          ? {}
          : pendingAcquisitionMetadataForPreview(recoveryPreview)
        : pendingAcquisitionMetadataForRecord(storedPending)
    const recoveryAcquisitionMetadata =
      baseRecoveryAcquisitionMetadata.acquisitionMode === 'mint' &&
      baseRecoveryAcquisitionMetadata.mintDelivery !== undefined &&
      baseRecoveryAcquisitionMetadata.mintDelivery.transactionHash === undefined &&
      boundState.txHash !== undefined
        ? {
            acquisitionMode: 'mint' as const,
            mintDelivery: {
              ...baseRecoveryAcquisitionMetadata.mintDelivery,
              transactionHash: boundState.txHash,
            },
          }
        : baseRecoveryAcquisitionMetadata
    const expectedRecoveryPosition = storedPending?.expectedPosition ??
      (inMemoryRecovery === undefined
        ? undefined
        : expectedPostOperationBounds(inMemoryRecovery.preview, inMemoryRecovery.bundle))
    setState({
      phase: 'recovering',
      fingerprint,
      operation,
      preview: recoveryPreview,
      txHash: boundState.txHash,
      pendingRecord: storedPending,
      message: 'Checking the exposed authorization pair before requesting a rescue transaction…',
    })
    let latestPending = storedPending
    let latestHash = boundState.txHash
    try {
      lease.assertOwned()
      assertContext(operationContext)
      if (metadataOnly) {
        const pendingCleared = clearLoopingPendingOperation({
          chainId: market.chainId,
          owner,
          marketId: market.marketId,
        })
        if (!pendingCleared) {
          throw new LoopingUiSafetyError(
            'STATE_CONFLICT',
            'Browser recovery metadata could not be removed.',
          )
        }
        recoveryRef.current = undefined
        unresolvedRef.current = false
        setState({
          phase: 'confirmed',
          fingerprint,
          operation,
          notice: 'Unsigned recovery metadata was removed. No Morpho authorization signature was exposed.',
        })
        return
      }
      if (!cleanupOnly) {
        let pair = inMemoryRecovery?.pair
        if (pair === undefined && storedPending?.txHash !== undefined) {
          try {
            pair = (await withWalletRead(
              (client) => readExposedLoopingAuthorizationPairFromTransaction({
                client,
                market,
                owner,
                transactionHash: storedPending.txHash!,
              }),
            )).value
          } catch {
            // A dropped/cancelled/replaced hash may have no looping calldata.
            // Continue into the nonce-burn path; never retry that transaction.
          }
        }

        if (pair !== undefined) {
        const recoveryState = (await withWalletRead(
          (client) => readExposedLoopingAuthorizationRecoveryState({ client, pair: pair! }),
        )).value
        assertContext(operationContext)
        const classification = classifyExposedLoopingAuthorization({
          pair,
          state: recoveryState,
        })
        if (classification.action !== 'none') {
          if (classification.action === 'blocked') {
            throw new LoopingUiSafetyError('STATE_CONFLICT', classification.reason)
          }
          const intent = buildLoopingAuthorizationRecoveryIntent({ pair, classification })
          if (intent === undefined) {
            throw new LoopingUiSafetyError('STATE_CONFLICT', 'No recovery transaction is required.')
          }
        let walletTxNonce: number | undefined
        try {
          walletTxNonce = (await withWalletRead(
            (client) => client.getTransactionCount({ address: owner, blockTag: 'pending' }),
          )).value
        } catch {
          // Keep the stricter pending record even when the RPC cannot quote a nonce.
        }
        const recoveryRecord = makePendingRecord({
          operation: intent.kind === 'direct-authorization-revoke' ? 'rescue' : 'recovery',
          owner,
          market,
          startingNonce: pair.startingNonce,
          deadline: pair.deadline,
          expectedPosition: expectedRecoveryPosition,
          walletTxNonce,
          ...recoveryAcquisitionMetadata,
        })
        if (!writeLoopingPendingOperation(recoveryRecord)) {
          throw new LoopingUiSafetyError('STATE_CONFLICT', 'Could not persist rescue metadata.')
        }
        latestPending = recoveryRecord
        lease.assertOwned()
        assertContext(operationContext)
        let rescueHash = await sendTransactionAsync({
          account: owner,
          chainId: operationContext.chainId,
          to: intent.to,
          data: intent.data,
          value: intent.value,
        })
        latestHash = rescueHash
        latestPending = { ...recoveryRecord, txHash: rescueHash }
        writeLoopingPendingOperation(latestPending)
        setState({
          phase: 'recovering',
          fingerprint,
          operation: pair.operation,
          preview: recoveryPreview,
          txHash: rescueHash,
          pendingRecord: latestPending,
          message: 'Waiting for the permission-rescue transaction…',
        })
        let unsafeReplacement: 'cancelled' | 'replaced' | undefined
        const receipt: TransactionReceipt = (await withWalletRead(
          (client) => client.waitForTransactionReceipt({
            hash: rescueHash,
            confirmations: LOOPING_RECEIPT_CONFIRMATIONS,
            onReplaced: (replacement) => {
              rescueHash = replacement.transaction.hash
              latestHash = rescueHash
              if (replacement.reason !== 'repriced') unsafeReplacement = replacement.reason
            },
          }),
        )).value
        if (!runIsCurrent(run)) {
          throw new LoopingUiSafetyError('STATE_CONFLICT', 'Wallet context changed during rescue.')
        }
        lease.assertOwned()
        assertContext(operationContext)
        if (unsafeReplacement !== undefined || receipt.status !== 'success') {
          throw new LoopingUiSafetyError(
            'STATE_CONFLICT',
            unsafeReplacement === undefined
              ? 'The permission-rescue transaction reverted.'
              : `The permission-rescue transaction was ${unsafeReplacement}.`,
          )
        }
        const finalState = (await withWalletRead(
          (client) => readExposedLoopingAuthorizationRecoveryState({ client, pair: pair! }),
        )).value
        const finalClassification = classifyExposedLoopingAuthorization({
          pair,
          state: finalState,
        })
          if (finalState.adapterAuthorized || finalClassification.action !== 'none') {
            throw new LoopingUiSafetyError(
              'STATE_CONFLICT',
              'Permission rescue did not invalidate the exposed authorization pair.',
            )
          }
        }
        } else {
        const pending = storedPending!
        const burnPreview = (await withWalletRead(
          (client) => prepareLoopingAuthorizationNonceBurn({ client, owner, market }),
        )).value
        const exposedStartingNonce = BigInt(pending.startingMorphoNonce)
        const exposedDeadline = BigInt(pending.authorizationDeadline)
        if (burnPreview.startingNonce < exposedStartingNonce) {
          throw new LoopingUiSafetyError(
            'STATE_CONFLICT',
            'The live Morpho nonce is below the persisted authorization nonce.',
          )
        }
        const exposedAuthorizeInvalid =
          burnPreview.startingNonce > exposedStartingNonce ||
          burnPreview.blockTimestamp > exposedDeadline

        if (exposedAuthorizeInvalid) {
          if (burnPreview.adapterAuthorized) {
            const directRevoke = (await withWalletRead(
              (client) => prepareDirectLoopingAuthorizationRevoke({ client, owner, market }),
            )).value
            if (directRevoke !== undefined) {
              let walletTxNonce: number | undefined
              try {
                walletTxNonce = (await withWalletRead(
                  (client) => client.getTransactionCount({ address: owner, blockTag: 'pending' }),
                )).value
              } catch {
                // The expired/advanced Morpho nonce remains the primary safety binding.
              }
              const revokeRecord = makePendingRecord({
                operation: 'rescue',
                owner,
                market,
                startingNonce: exposedStartingNonce,
                deadline: exposedDeadline,
                expectedPosition: pending.expectedPosition,
                walletTxNonce,
                ...pendingAcquisitionMetadataForRecord(pending),
              })
              if (!writeLoopingPendingOperation(revokeRecord)) {
                throw new LoopingUiSafetyError('STATE_CONFLICT', 'Could not persist revoke metadata.')
              }
              latestPending = revokeRecord
              lease.assertOwned()
              assertContext(operationContext)
              let revokeHash = await sendTransactionAsync({
                account: owner,
                chainId: operationContext.chainId,
                to: directRevoke.to,
                data: directRevoke.data,
                value: directRevoke.value,
              })
              latestHash = revokeHash
              latestPending = { ...revokeRecord, txHash: revokeHash }
              writeLoopingPendingOperation(latestPending)
              let unsafeReplacement: 'cancelled' | 'replaced' | undefined
              const receipt = (await withWalletRead(
                (client) => client.waitForTransactionReceipt({
                  hash: revokeHash,
                  confirmations: LOOPING_RECEIPT_CONFIRMATIONS,
                  onReplaced: (replacement) => {
                    revokeHash = replacement.transaction.hash
                    latestHash = revokeHash
                    if (replacement.reason !== 'repriced') unsafeReplacement = replacement.reason
                  },
                }),
              )).value
              lease.assertOwned()
              assertContext(operationContext)
              if (unsafeReplacement !== undefined || receipt.status !== 'success') {
                throw new LoopingUiSafetyError(
                  'STATE_CONFLICT',
                  unsafeReplacement === undefined
                    ? 'The direct permission revoke reverted.'
                    : `The direct permission revoke was ${unsafeReplacement}.`,
                )
              }
            }
          }
        } else {
          lease.assertOwned()
          assertContext(operationContext)
          setState({
            phase: 'recovering',
            fingerprint,
            operation,
            pendingRecord: pending,
            message: 'Sign one revoke-only Morpho message to invalidate the unlocated nonce.',
          })
          const burnRequest = burnPreview.request
          const burnSignature = await signTypedDataAsync({
            account: owner,
            domain: burnRequest.domain,
            types: burnRequest.types,
            primaryType: burnRequest.primaryType,
            message: burnRequest.message,
          })
          lease.assertOwned()
          assertContext(operationContext)
          // Signature parsing stays local; the selected RPC receives only the
          // fresh block, nonce, and runtime-code reads used by this builder.
          const burnIntent = (await withWalletRead(
            (client) => buildLoopingAuthorizationNonceBurnIntent({
              client,
              preview: burnPreview,
              signature: burnSignature,
            }),
          )).value
          let walletTxNonce: number | undefined
          try {
            walletTxNonce = (await withWalletRead(
              (client) => client.getTransactionCount({ address: owner, blockTag: 'pending' }),
            )).value
          } catch {
            // The nonce-burn intent remains bounded by its Morpho nonce/deadline.
          }
          const burnRecord = makePendingRecord({
            operation: 'recovery',
            owner,
            market,
            startingNonce: burnIntent.startingNonce,
            deadline: burnIntent.deadline,
            expectedPosition: pending.expectedPosition,
            walletTxNonce,
            ...pendingAcquisitionMetadataForRecord(pending),
          })
          if (!writeLoopingPendingOperation(burnRecord)) {
            throw new LoopingUiSafetyError('STATE_CONFLICT', 'Could not persist nonce-burn metadata.')
          }
          latestPending = burnRecord
          lease.assertOwned()
          assertContext(operationContext)
          let burnHash = await sendTransactionAsync({
            account: owner,
            chainId: operationContext.chainId,
            to: burnIntent.to,
            data: burnIntent.data,
            value: burnIntent.value,
          })
          latestHash = burnHash
          latestPending = { ...burnRecord, txHash: burnHash }
          writeLoopingPendingOperation(latestPending)
          let unsafeReplacement: 'cancelled' | 'replaced' | undefined
          const receipt = (await withWalletRead(
            (client) => client.waitForTransactionReceipt({
              hash: burnHash,
              confirmations: LOOPING_RECEIPT_CONFIRMATIONS,
              onReplaced: (replacement) => {
                burnHash = replacement.transaction.hash
                latestHash = burnHash
                if (replacement.reason !== 'repriced') unsafeReplacement = replacement.reason
              },
            }),
          )).value
          lease.assertOwned()
          assertContext(operationContext)
          const refreshedBurnState = (await withWalletRead(
            (client) => prepareLoopingAuthorizationNonceBurn({ client, owner, market }),
          )).value
          const oldAuthorizeNowInvalid =
            refreshedBurnState.startingNonce > exposedStartingNonce ||
            refreshedBurnState.blockTimestamp > exposedDeadline
          if (
            unsafeReplacement !== undefined ||
            refreshedBurnState.adapterAuthorized ||
            !oldAuthorizeNowInvalid ||
            (receipt.status !== 'success' &&
              refreshedBurnState.startingNonce < burnIntent.expectedPostconditions.nonce)
          ) {
            throw new LoopingUiSafetyError(
              'STATE_CONFLICT',
              unsafeReplacement === undefined
                ? 'The authorization nonce burn is not yet proven safe.'
                : `The authorization nonce-burn transaction was ${unsafeReplacement}.`,
            )
          }
        }
        }
      }

      // Authorization safety is not enough: an aborted entry can leave the
      // exact GeneralAdapter1 allowance in place. Execute only the compiler's
      // permission/adapter-allowance cleanup phases; position repayment and
      // collateral withdrawal remain a separate explicit last-resort flow.
      let cleanupComplete = false
      for (let cleanupStep = 0; cleanupStep < 3; cleanupStep += 1) {
        const cleanupResidue = (await withWalletRead(async (client) => {
          const [authorizationRevoke, adapterAllowance] = await Promise.all([
            prepareDirectLoopingAuthorizationRevoke({ client, owner, market }),
            client.readContract({
              address: market.morphoMarketParams.loanToken,
              abi: loopingErc20Abi,
              functionName: 'allowance',
              args: [owner, market.contracts.generalAdapter1],
              blockTag: 'pending',
            }),
          ])
          return { authorizationRevoke, adapterAllowance }
        })).value
        lease.assertOwned()
        assertContext(operationContext)
        if (
          cleanupResidue.authorizationRevoke === undefined &&
          cleanupResidue.adapterAllowance === 0n
        ) {
          cleanupComplete = true
          break
        }
        const cleanupPlan = (await withWalletRead(
          (client) => prepareDirectLoopingRescue({ client, owner, market }),
        )).value
        if (
          cleanupPlan.phase !== 'revoke-adapter' &&
          cleanupPlan.phase !== 'clear-adapter-allowance'
        ) {
          if (
            cleanupPlan.startingState.adapterAuthorized ||
            cleanupPlan.startingState.adapterAllowance !== 0n
          ) {
            throw new LoopingUiSafetyError(
              'STATE_CONFLICT',
              'Adapter permission or allowance cleanup remains incomplete.',
            )
          }
          cleanupComplete = true
          break
        }
        const cleanupIntent = cleanupPlan.intents[0]
        if (cleanupIntent === undefined) {
          throw new LoopingUiSafetyError('STATE_CONFLICT', 'Compiler cleanup intent is missing.')
        }
        let walletTxNonce: number | undefined
        try {
          walletTxNonce = (await withWalletRead(
            (client) => client.getTransactionCount({ address: owner, blockTag: 'pending' }),
          )).value
        } catch {
          // The compiler plan remains pinned; pending metadata stays conservative.
        }
        if (latestPending === undefined) {
          throw new LoopingUiSafetyError(
            'STATE_CONFLICT',
            'Persisted authorization metadata is required before allowance cleanup.',
          )
        }
        const cleanupRecord = makePendingRecord({
          operation: cleanupOnly ? 'allowance-cleanup' : 'rescue',
          owner,
          market,
          startingNonce: BigInt(latestPending.startingMorphoNonce),
          deadline: BigInt(latestPending.authorizationDeadline),
          expectedPosition: latestPending.expectedPosition,
          walletTxNonce,
          ...pendingAcquisitionMetadataForRecord(latestPending),
        })
        if (!writeLoopingPendingOperation(cleanupRecord)) {
          throw new LoopingUiSafetyError('STATE_CONFLICT', 'Could not persist allowance-cleanup metadata.')
        }
        latestPending = cleanupRecord
        lease.assertOwned()
        assertContext(operationContext)
        let cleanupHash = await sendTransactionAsync({
          account: owner,
          chainId: operationContext.chainId,
          to: cleanupIntent.to,
          data: cleanupIntent.data,
          value: cleanupIntent.value,
        })
        latestHash = cleanupHash
        latestPending = { ...cleanupRecord, txHash: cleanupHash }
        writeLoopingPendingOperation(latestPending)
        let unsafeReplacement: 'cancelled' | 'replaced' | undefined
        const cleanupReceipt = (await withWalletRead(
          (client) => client.waitForTransactionReceipt({
            hash: cleanupHash,
            confirmations: LOOPING_RECEIPT_CONFIRMATIONS,
            onReplaced: (replacement) => {
              cleanupHash = replacement.transaction.hash
              latestHash = cleanupHash
              if (replacement.reason !== 'repriced') unsafeReplacement = replacement.reason
            },
          }),
        )).value
        lease.assertOwned()
        assertContext(operationContext)
        if (unsafeReplacement !== undefined || cleanupReceipt.status !== 'success') {
          throw new LoopingUiSafetyError(
            'STATE_CONFLICT',
            unsafeReplacement === undefined
              ? 'The adapter cleanup transaction reverted.'
              : `The adapter cleanup transaction was ${unsafeReplacement}.`,
          )
        }
        // The compiler requires a fresh plan after every mined step.
      }
      if (!cleanupComplete) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'Adapter cleanup did not converge after the bounded rescue steps.',
        )
      }

      lease.assertOwned()
      assertContext(operationContext)
      const reconciledPosition = (await withWalletRead(
        (client) => readLoopingExecutionPosition({ client, owner, market }),
      )).value
      const expectedPosition = expectedRecoveryPosition ?? latestPending?.expectedPosition
      const expectedPositionMatches = expectedPosition !== undefined &&
        positionMatchesBounds(reconciledPosition, expectedPosition)
      if (
        expectedPositionMatches &&
        !cleanupOnly &&
        recoveryAcquisitionMetadata.acquisitionMode === 'mint' &&
        recoveryAcquisitionMetadata.mintDelivery !== undefined
      ) {
        await withWalletRead((client) => verifyPersistedMintDelivery({
          client,
          delivery: recoveryAcquisitionMetadata.mintDelivery!,
          transactionHash: boundState.txHash,
          owner,
          market,
        }))
        lease.assertOwned()
        assertContext(operationContext)
      }

      if (!expectedPositionMatches && reconciledPosition.classification === 'open-loop') {
        const exitPrepared = await withWalletRead(
          (client) => prepareLoopingExitExecution({
            client,
            owner,
            market,
            minimumReturnedAssets: EXIT_QUOTE_DISCOVERY_FLOOR,
          }),
        )
        const pendingCleared = clearLoopingPendingOperation({
          chainId: market.chainId,
          owner,
          marketId: market.marketId,
        })
        if (latestPending !== undefined && !pendingCleared) {
          throw new LoopingUiSafetyError(
            'STATE_CONFLICT',
            'The secured operation could not be removed from browser recovery storage.',
          )
        }
        recoveryRef.current = undefined
        unresolvedRef.current = false
        setState({
          phase: 'ready',
          fingerprint,
          operation: 'exit',
          preview: exitPrepared.value,
          position: reconciledPosition,
          notice: 'Permissions and adapter allowance are secured, but the Morpho position remains open. Review and execute this fresh full-exit quote.',
        })
        return
      }
      if (
        !expectedPositionMatches &&
        reconciledPosition.classification !== 'empty'
      ) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'The live Morpho position does not match the persisted bounds and cannot be exited automatically.',
        )
      }

      const pendingCleared = clearLoopingPendingOperation({
        chainId: market.chainId,
        owner,
        marketId: market.marketId,
      })
      if (latestPending !== undefined && !pendingCleared) {
        throw new LoopingUiSafetyError(
          'STATE_CONFLICT',
          'The secured operation could not be removed from browser recovery storage.',
        )
      }
      recoveryRef.current = undefined
      unresolvedRef.current = false
      setState({
        phase: 'confirmed',
        fingerprint,
        operation,
        txHash: latestHash,
        notice: cleanupOnly
          ? 'The unused adapter allowance was cleared. No Morpho authorization signature was exposed.'
          : expectedPositionMatches && reconciledPosition.classification === 'open-loop'
            ? 'The loop is open and the temporary Morpho permissions were secured.'
            : operation === 'exit'
              ? 'The loop is closed and the temporary Morpho permissions were secured.'
              : 'No loop remains open. Morpho permissions and adapter allowance were secured.',
      })
    } catch (error) {
      setState({
        phase: 'ambiguous',
        fingerprint,
        operation,
        preview: recoveryPreview,
        txHash: latestHash,
        pendingRecord: latestPending,
        message: isUserRejection(error)
          ? 'Permission rescue declined. The original operation remains unresolved.'
          : readableError(error),
      })
    } finally {
      lease.release()
      finishRun(run)
    }
  }, [assertContext, beginRun, boundState, captureContext, fingerprint, finishRun,
    market, owner, runIsCurrent, sendTransactionAsync, signTypedDataAsync, walletChainId,
    walletReadClient, withWalletRead])

  const externalPhase: LoopingExecutionPhase = (() => {
    if (market === undefined) return 'idle'
    if (!isConnected || owner === undefined) return 'needs-wallet'
    if (walletChainId !== market.chainId) return 'wrong-network'
    return boundState.phase
  })()
  const quoteFresh = boundState.preview !== undefined && Date.now() < boundState.preview.validUntilMs
  const selectedEntryBuildEnabled = LOOPING_EXECUTION_BETA_ENABLED &&
    (acquisitionMode === 'market' || LOOPING_MINT_BETA_ENABLED)

  const riskIncreaseMessage = boundState.preview !== undefined &&
    isRiskIncreasingPreview(boundState.preview) &&
    !riskIncreaseEligibility.eligible
      ? riskIncreaseEligibility.message
      : undefined

  return {
    phase: externalPhase,
    intent,
    acquisitionMode,
    operation: boundState.operation,
    supported: market !== undefined,
    entryEnabled: selectedEntryBuildEnabled && riskIncreaseEligibility.eligible,
    exitEnabled: LOOPING_EXIT_BETA_ENABLED,
    market,
    borrowAssets,
    preview: boundState.preview,
    position: boundState.position,
    message: boundState.message ?? riskIncreaseMessage,
    notice: boundState.notice,
    noticeTone: boundState.noticeTone,
    txHash: boundState.txHash,
    pendingRecord: boundState.pendingRecord,
    busy,
    canPrepare: Boolean(
      market && isConnected && owner &&
      walletReadClient &&
      walletChainId === market.chainId &&
      !busy && externalPhase !== 'ambiguous',
    ),
    canExecute: Boolean(
      (boundState.operation === 'entry'
        ? boundState.preview !== undefined &&
          isRiskIncreasingPreview(boundState.preview) &&
          riskIncreaseBuildEnabled(boundState.preview) &&
          riskIncreaseEligibility.eligible
        : boundState.operation === 'exit' && LOOPING_EXIT_BETA_ENABLED) &&
      boundState.phase === 'ready' &&
      boundState.preview && walletReadClient && quoteFresh && !busy,
    ),
    canRecover: Boolean(
      boundState.phase === 'ambiguous' &&
      walletReadClient &&
      (recoveryRef.current !== undefined || boundState.pendingRecord !== undefined) &&
      !busy,
    ),
    prepare,
    execute,
    recover,
    connectWallet: () => openConnectModal?.(),
    switchToMarketChain: () => {
      if (market !== undefined) switchChain({ chainId: market.chainId })
    },
  }
}
