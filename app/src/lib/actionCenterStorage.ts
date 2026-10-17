/**
 * Closed, versioned device-local persistence for the Action Center.
 *
 * Only user preferences, explicitly tracked market identities, and
 * non-sensitive transaction metadata are stored. Signed payloads, signatures,
 * calldata, approvals, amounts and private account data are never accepted by
 * this schema.
 */

import { getAddress, isAddress } from 'viem'
import type { Address, Hex } from 'viem'
import { isSupportedChainId } from './addresses.ts'
import type { SupportedChainId } from './types.ts'

export const ACTION_CENTER_STORAGE_KEY = 'openpendle.action-center.v1'
export const ACTION_CENTER_SCHEMA_VERSION = 1 as const
export const ACTION_CENTER_MAX_TRACKED_MARKETS = 100
export const ACTION_CENTER_MAX_ACTIVITY = 100

export type ActionCenterMaturityLeadDays = 7 | 30 | 90

export interface ActionCenterPreferences {
  maturityLeadDays: ActionCenterMaturityLeadDays
  yieldMoveBps: number
  showClaimable: boolean
}

export const DEFAULT_ACTION_CENTER_PREFERENCES: Readonly<ActionCenterPreferences> = {
  maturityLeadDays: 30,
  yieldMoveBps: 50,
  showClaimable: true,
}

export interface TrackedActionMarket {
  chainId: SupportedChainId
  market: Address
  label: string
  trackedAt: number
  /** Minimum current implied APY, in basis points. Undefined disables the target. */
  targetApyBps?: number
}

export type ActionActivityKind = 'approval' | 'transaction' | 'limit-order'

// Persist categories only: plan descriptions and token symbols may contain
// amounts or other account-specific text. Unknown/new calls use a safe fallback.
const TRANSACTION_LABELS_BY_FUNCTION = new Map<string, string>([
  ['deposit', 'Wrap SY'],
  ['redeem', 'Unwrap SY'],
  ['mintPyFromSy', 'Mint PT + YT'],
  ['mintPyFromToken', 'Mint PT + YT'],
  ['redeemPyToSy', 'Redeem PT + YT'],
  ['redeemPyToToken', 'Redeem PT + YT'],
  ['swapExactSyForPt', 'Buy PT'],
  ['swapExactTokenForPt', 'Buy PT'],
  ['swapExactPtForSy', 'Sell PT'],
  ['swapExactPtForToken', 'Sell PT'],
  ['swapExactSyForYt', 'Buy YT'],
  ['swapExactTokenForYt', 'Buy YT'],
  ['swapExactYtForSy', 'Sell YT'],
  ['swapExactYtForToken', 'Sell YT'],
  ['addLiquidityDualSyAndPt', 'Add liquidity'],
  ['addLiquidityDualTokenAndPt', 'Add liquidity'],
  ['addLiquiditySingleSy', 'Add liquidity'],
  ['addLiquiditySingleToken', 'Add liquidity'],
  ['addLiquiditySingleSyKeepYt', 'Add liquidity'],
  ['addLiquiditySingleTokenKeepYt', 'Add liquidity'],
  ['removeLiquidityDualSyAndPt', 'Remove liquidity'],
  ['removeLiquidityDualTokenAndPt', 'Remove liquidity'],
  ['removeLiquiditySingleSy', 'Remove liquidity'],
  ['removeLiquiditySingleToken', 'Remove liquidity'],
  ['exitPostExpToSy', 'Redeem matured position'],
  ['exitPostExpToToken', 'Redeem matured position'],
  ['redeemDueInterestAndRewards', 'Claim interest and rewards'],
  ['claim', 'Claim rewards'],
  ['deploy5115MarketAndSeedLiquidity', 'Create pool'],
  ['deployCommonMarketById', 'Create pool'],
  ['deploySY', 'Deploy SY'],
  ['deployUpgradableSY', 'Deploy SY'],
])
const TRANSACTION_ACTIVITY_LABELS = new Set([
  'Transaction',
  ...TRANSACTION_LABELS_BY_FUNCTION.values(),
])

export function actionActivityLabelForFunction(functionName: string): string {
  return TRANSACTION_LABELS_BY_FUNCTION.get(functionName) ?? 'Transaction'
}

export type ActionActivityStatus =
  | 'active'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'unconfirmed'
  | 'cancelled'
  | 'filled'
  | 'expired'
  | 'unknown'

export interface ActionActivity {
  id: string
  owner: Address
  chainId: SupportedChainId
  kind: ActionActivityKind
  label: string
  status: ActionActivityStatus
  createdAt: number
  updatedAt: number
  hash?: Hex
  orderId?: Hex
  market?: Address
  expiry?: number
}

export interface ActionCenterProfile {
  preferences: ActionCenterPreferences
  trackedMarkets: TrackedActionMarket[]
  activity: ActionActivity[]
}

interface PersistedActionCenterState {
  version: typeof ACTION_CENTER_SCHEMA_VERSION
  profiles: Record<string, ActionCenterProfile>
}

export interface ActionCenterStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const listeners = new Set<() => void>()
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const CONTROL_RE = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu

function emptyState(): PersistedActionCenterState {
  return { version: ACTION_CENTER_SCHEMA_VERSION, profiles: {} }
}

function defaultProfile(): ActionCenterProfile {
  return {
    preferences: { ...DEFAULT_ACTION_CENTER_PREFERENCES },
    trackedMarkets: [],
    activity: [],
  }
}

function browserStorage(): ActionCenterStorage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined'
      ? undefined
      : globalThis.localStorage
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(CONTROL_RE, '').trim()
  return cleaned.length === 0 ? null : cleaned.slice(0, maxLength)
}

function safeAddress(value: unknown): Address | null {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) return null
  return getAddress(value)
}

function safeHash(value: unknown): Hex | null {
  return typeof value === 'string' && HASH_RE.test(value)
    ? value.toLowerCase() as Hex
    : null
}

function safeChainId(value: unknown): SupportedChainId | null {
  return typeof value === 'number' && isSupportedChainId(value) ? value : null
}

function parsePreferences(value: unknown): ActionCenterPreferences {
  const parsed = record(value)
  if (parsed === null) return { ...DEFAULT_ACTION_CENTER_PREFERENCES }
  const maturityLeadDays = parsed.maturityLeadDays === 7 ||
    parsed.maturityLeadDays === 30 ||
    parsed.maturityLeadDays === 90
    ? parsed.maturityLeadDays
    : DEFAULT_ACTION_CENTER_PREFERENCES.maturityLeadDays
  const yieldMoveBps = typeof parsed.yieldMoveBps === 'number' &&
    Number.isInteger(parsed.yieldMoveBps) &&
    parsed.yieldMoveBps >= 25 &&
    parsed.yieldMoveBps <= 1_000
    ? parsed.yieldMoveBps
    : DEFAULT_ACTION_CENTER_PREFERENCES.yieldMoveBps
  return {
    maturityLeadDays,
    yieldMoveBps,
    showClaimable: typeof parsed.showClaimable === 'boolean'
      ? parsed.showClaimable
      : DEFAULT_ACTION_CENTER_PREFERENCES.showClaimable,
  }
}

function parseTrackedMarket(value: unknown): TrackedActionMarket | null {
  const parsed = record(value)
  if (parsed === null) return null
  const chainId = safeChainId(parsed.chainId)
  const market = safeAddress(parsed.market)
  const label = safeText(parsed.label, 120)
  const trackedAt = safeTimestamp(parsed.trackedAt)
  const targetApyBps = parsed.targetApyBps === undefined
    ? null
    : typeof parsed.targetApyBps === 'number' &&
        Number.isInteger(parsed.targetApyBps) &&
        parsed.targetApyBps >= 1 &&
        parsed.targetApyBps <= 100_000
      ? parsed.targetApyBps
      : null
  if (
    chainId === null ||
    market === null ||
    label === null ||
    trackedAt === null ||
    (parsed.targetApyBps !== undefined && targetApyBps === null)
  ) return null
  return {
    chainId,
    market,
    label,
    trackedAt,
    ...(targetApyBps === null ? {} : { targetApyBps }),
  }
}

const ACTIVITY_KINDS: readonly ActionActivityKind[] = ['approval', 'transaction', 'limit-order']
const ACTIVITY_STATUSES: readonly ActionActivityStatus[] = [
  'active',
  'pending',
  'confirmed',
  'failed',
  'unconfirmed',
  'cancelled',
  'filled',
  'expired',
  'unknown',
]

function parseActivity(value: unknown, expectedOwner: Address): ActionActivity | null {
  const parsed = record(value)
  if (parsed === null) return null
  const id = safeText(parsed.id, 180)
  const owner = safeAddress(parsed.owner)
  const chainId = safeChainId(parsed.chainId)
  const rawLabel = safeText(parsed.label, 160)
  // Normalize legacy amount-bearing descriptions on read as well as write.
  // The next profile write consequently removes them from stored history.
  const label = parsed.kind === 'approval'
    ? 'Token approval'
    : parsed.kind === 'transaction'
      ? rawLabel !== null && TRANSACTION_ACTIVITY_LABELS.has(rawLabel)
        ? rawLabel
        : 'Transaction'
      : rawLabel
  const createdAt = safeTimestamp(parsed.createdAt)
  const updatedAt = safeTimestamp(parsed.updatedAt)
  if (
    id === null ||
    owner === null ||
    owner.toLowerCase() !== expectedOwner.toLowerCase() ||
    chainId === null ||
    label === null ||
    createdAt === null ||
    updatedAt === null ||
    !ACTIVITY_KINDS.includes(parsed.kind as ActionActivityKind) ||
    !ACTIVITY_STATUSES.includes(parsed.status as ActionActivityStatus)
  ) {
    return null
  }
  const hash = parsed.hash === undefined ? null : safeHash(parsed.hash)
  const orderId = parsed.orderId === undefined ? null : safeHash(parsed.orderId)
  const market = parsed.market === undefined ? null : safeAddress(parsed.market)
  const expiry = parsed.expiry === undefined ? null : safeTimestamp(parsed.expiry)
  if (
    (parsed.hash !== undefined && hash === null) ||
    (parsed.orderId !== undefined && orderId === null) ||
    (parsed.market !== undefined && market === null) ||
    (parsed.expiry !== undefined && expiry === null)
  ) {
    return null
  }
  return {
    id,
    owner,
    chainId,
    kind: parsed.kind as ActionActivityKind,
    label,
    status: parsed.status as ActionActivityStatus,
    createdAt,
    updatedAt,
    ...(hash === null ? {} : { hash }),
    ...(orderId === null ? {} : { orderId }),
    ...(market === null ? {} : { market }),
    ...(expiry === null ? {} : { expiry }),
  }
}

function parseProfile(value: unknown, owner: Address): ActionCenterProfile {
  const parsed = record(value)
  if (parsed === null) return defaultProfile()
  const trackedMarkets = Array.isArray(parsed.trackedMarkets)
    ? parsed.trackedMarkets
        .slice(0, ACTION_CENTER_MAX_TRACKED_MARKETS * 2)
        .map(parseTrackedMarket)
        .filter((item): item is TrackedActionMarket => item !== null)
    : []
  const activity = Array.isArray(parsed.activity)
    ? parsed.activity
        .slice(0, ACTION_CENTER_MAX_ACTIVITY * 2)
        .map((entry) => parseActivity(entry, owner))
        .filter((entry): entry is ActionActivity => entry !== null)
    : []
  const trackedByKey = new Map<string, TrackedActionMarket>()
  for (const item of trackedMarkets) {
    trackedByKey.set(`${item.chainId}:${item.market.toLowerCase()}`, item)
  }
  const activityById = new Map<string, ActionActivity>()
  for (const item of activity) {
    const previous = activityById.get(item.id)
    if (previous === undefined || previous.updatedAt < item.updatedAt) activityById.set(item.id, item)
  }
  return {
    preferences: parsePreferences(parsed.preferences),
    trackedMarkets: [...trackedByKey.values()]
      .sort((left, right) => right.trackedAt - left.trackedAt)
      .slice(0, ACTION_CENTER_MAX_TRACKED_MARKETS),
    activity: [...activityById.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, ACTION_CENTER_MAX_ACTIVITY),
  }
}

export function readActionCenterState(
  storage: ActionCenterStorage | undefined = browserStorage(),
): PersistedActionCenterState {
  if (storage === undefined) return emptyState()
  try {
    const raw = storage.getItem(ACTION_CENTER_STORAGE_KEY)
    if (raw === null || raw.length > 250_000) return emptyState()
    const parsed = record(JSON.parse(raw) as unknown)
    if (parsed?.version !== ACTION_CENTER_SCHEMA_VERSION) return emptyState()
    const rawProfiles = record(parsed.profiles)
    if (rawProfiles === null) return emptyState()
    const profiles: Record<string, ActionCenterProfile> = {}
    for (const [rawOwner, rawProfile] of Object.entries(rawProfiles).slice(0, 25)) {
      const owner = safeAddress(rawOwner)
      if (owner === null) continue
      profiles[owner.toLowerCase()] = parseProfile(rawProfile, owner)
    }
    return { version: ACTION_CENTER_SCHEMA_VERSION, profiles }
  } catch {
    return emptyState()
  }
}

function writeState(
  state: PersistedActionCenterState,
  storage: ActionCenterStorage | undefined = browserStorage(),
): void {
  if (storage === undefined) return
  try {
    storage.setItem(ACTION_CENTER_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage denied/full: keep the feature read-only for this session.
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

function ownerKey(owner: Address): string {
  return getAddress(owner).toLowerCase()
}

export function actionCenterProfile(
  owner: Address,
  storage: ActionCenterStorage | undefined = browserStorage(),
): ActionCenterProfile {
  return readActionCenterState(storage).profiles[ownerKey(owner)] ?? defaultProfile()
}

function updateProfile(
  owner: Address,
  updater: (profile: ActionCenterProfile) => ActionCenterProfile,
  storage: ActionCenterStorage | undefined = browserStorage(),
): void {
  const state = readActionCenterState(storage)
  const key = ownerKey(owner)
  state.profiles[key] = updater(state.profiles[key] ?? defaultProfile())
  writeState(state, storage)
  emit()
}

export function setActionCenterPreferences(
  owner: Address,
  preferences: ActionCenterPreferences,
  storage?: ActionCenterStorage,
): void {
  const safe = parsePreferences(preferences)
  updateProfile(owner, (profile) => ({ ...profile, preferences: safe }), storage)
}

export function trackActionMarket(
  owner: Address,
  market: Omit<TrackedActionMarket, 'trackedAt'> & { trackedAt?: number },
  storage?: ActionCenterStorage,
): void {
  const parsed = parseTrackedMarket({ ...market, trackedAt: market.trackedAt ?? Date.now() })
  if (parsed === null) return
  updateProfile(owner, (profile) => {
    const key = `${parsed.chainId}:${parsed.market.toLowerCase()}`
    const previous = profile.trackedMarkets.find(
      (item) => `${item.chainId}:${item.market.toLowerCase()}` === key,
    )
    const next = parsed.targetApyBps === undefined && previous?.targetApyBps !== undefined
      ? { ...parsed, targetApyBps: previous.targetApyBps }
      : parsed
    return {
      ...profile,
      trackedMarkets: [
        next,
        ...profile.trackedMarkets.filter(
          (item) => `${item.chainId}:${item.market.toLowerCase()}` !== key,
        ),
      ].slice(0, ACTION_CENTER_MAX_TRACKED_MARKETS),
    }
  }, storage)
}

export function setTrackedMarketTarget(
  owner: Address,
  chainId: SupportedChainId,
  market: Address,
  targetApyBps: number | null,
  storage?: ActionCenterStorage,
): void {
  if (
    targetApyBps !== null &&
    (!Number.isInteger(targetApyBps) || targetApyBps < 1 || targetApyBps > 100_000)
  ) return
  const key = `${chainId}:${market.toLowerCase()}`
  updateProfile(owner, (profile) => ({
    ...profile,
    trackedMarkets: profile.trackedMarkets.map((item) =>
      `${item.chainId}:${item.market.toLowerCase()}` !== key
        ? item
        : targetApyBps === null
          ? (({ targetApyBps: _target, ...rest }) => rest)(item)
          : { ...item, targetApyBps },
    ),
  }), storage)
}

export function untrackActionMarket(
  owner: Address,
  chainId: SupportedChainId,
  market: Address,
  storage?: ActionCenterStorage,
): void {
  const key = `${chainId}:${market.toLowerCase()}`
  updateProfile(owner, (profile) => ({
    ...profile,
    trackedMarkets: profile.trackedMarkets.filter(
      (item) => `${item.chainId}:${item.market.toLowerCase()}` !== key,
    ),
  }), storage)
}

export function recordActionActivity(
  activity: ActionActivity,
  storage?: ActionCenterStorage,
): void {
  const parsed = parseActivity(activity, activity.owner)
  if (parsed === null) return
  updateProfile(parsed.owner, (profile) => ({
    ...profile,
    activity: [
      parsed,
      ...profile.activity.filter((item) => item.id !== parsed.id),
    ]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, ACTION_CENTER_MAX_ACTIVITY),
  }), storage)
}

export function updateActionActivityStatus(
  owner: Address,
  id: string,
  status: ActionActivityStatus,
  options: { hash?: Hex; updatedAt?: number } = {},
  storage?: ActionCenterStorage,
): void {
  if (!ACTIVITY_STATUSES.includes(status)) return
  const hash = options.hash === undefined ? undefined : safeHash(options.hash)
  if (options.hash !== undefined && hash === null) return
  const updatedAt = safeTimestamp(options.updatedAt ?? Date.now()) ?? Date.now()
  updateProfile(owner, (profile) => ({
    ...profile,
    activity: profile.activity.map((item) =>
      item.id === id
        ? {
            ...item,
            status,
            updatedAt,
            ...(hash === undefined || hash === null ? {} : { hash }),
          }
        : item,
    ),
  }), storage)
}

export function subscribeActionCenter(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

if (typeof globalThis.window !== 'undefined') {
  globalThis.window.addEventListener('storage', (event) => {
    if (event.key === ACTION_CENTER_STORAGE_KEY) emit()
  })
}
