/**
 * Cross-chain market discovery for the connected wallet's Pendle positions.
 *
 * Pendle's dashboard response is discovery metadata only. Callers must still
 * load and validate each market on-chain before displaying balances or
 * building transactions. This module deliberately has no saved-pool input:
 * official-position discovery remains useful when the local registry is empty.
 */

import type { Address } from 'viem'
import { isSupportedChainId } from './addresses.ts'
import type { SupportedChainId } from './types.ts'

export const PENDLE_OFFICIAL_POSITIONS_ENDPOINT =
  'https://api-v2.pendle.finance/core/v1/dashboard/positions/database'
export const OFFICIAL_POSITIONS_REQUEST_TIMEOUT_MS = 15_000
export const OFFICIAL_POSITIONS_MAX_REQUEST_TIMEOUT_MS = 60_000

const UINT256_MAX = (1n << 256n) - 1n
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i
const MARKET_ID_PATTERN = /^(0|[1-9][0-9]*)-(0x[0-9a-f]{40})$/i
const POSITION_SOURCES = ['open', 'closed'] as const

export type OfficialPositionSource = (typeof POSITION_SOURCES)[number]
export type OfficialPositionRole = 'pt' | 'yt' | 'lp'
export type OfficialPositionMarketKey = `${SupportedChainId}:${Address}`
export type OfficialPositionsFetch = typeof fetch

export interface OfficialClaimableAmount {
  /** Pendle token id. It is retained only as discovery metadata. */
  token: string
  amount: bigint
}

export interface OfficialRolePosition {
  balance: bigint
  /** Present for LP positions in Pendle's schema. */
  activeBalance: bigint | null
  valuationUsd: number
  /** Positive, structurally valid claimables only. */
  claimableAmounts: OfficialClaimableAmount[]
}

export interface OfficialPositionMarket {
  /** Stable identity; an EVM address alone is not globally unique. */
  key: OfficialPositionMarketKey
  chainId: SupportedChainId
  /** Lowercase market address parsed from Pendle's chainId-address marketId. */
  market: Address
  roles: Record<OfficialPositionRole, OfficialRolePosition>
  /** A duplicate can legitimately be present in both dashboard collections. */
  sources: OfficialPositionSource[]
}

export interface OfficialPositionDiscovery {
  markets: OfficialPositionMarket[]
  /** Supported chains that Pendle explicitly reported as incomplete. */
  failedChainIds: SupportedChainId[]
}

export interface FetchOfficialPositionMarketsOptions {
  /** Injectable for deterministic, network-free tests. */
  fetcher?: OfficialPositionsFetch
  /** Base endpoint without the final user-address path segment. */
  endpoint?: string
  signal?: AbortSignal
  /** Must remain bounded so an unavailable discovery service cannot hang UI. */
  requestTimeoutMs?: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeAddress(value: unknown): Address | null {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) return null
  return value.toLowerCase() as Address
}

function normalizeAmount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null
  // uint256 values have at most 78 decimal digits. Check before BigInt so an
  // untrusted response cannot force parsing of an arbitrarily large integer.
  if (value.length > 78) return null
  const amount = BigInt(value)
  return amount <= UINT256_MAX ? amount : null
}

/**
 * Pendle's historical index can retain negative sibling-role metadata while
 * another role on the same market is positive. Negative values are not valid
 * wallet balances, but they must not make us discard the whole market before
 * the authoritative on-chain reread.
 */
function normalizePositionAmount(value: unknown): bigint | null {
  if (typeof value === 'string' && /^-(0|[1-9][0-9]*)$/.test(value)) {
    return value.length <= 79 ? 0n : null
  }
  return normalizeAmount(value)
}

function normalizeClaimables(value: unknown): OfficialClaimableAmount[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null

  const byToken = new Map<string, bigint>()
  for (const candidate of value) {
    const item = record(candidate)
    const token = typeof item?.token === 'string' ? item.token.trim().toLowerCase() : ''
    const amount = normalizeAmount(item?.amount)
    if (token.length === 0 || token.length > 256 || amount === null || amount === 0n) continue
    const previous = byToken.get(token)
    if (previous === undefined || amount > previous) byToken.set(token, amount)
  }

  return [...byToken]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([token, amount]) => ({ token, amount }))
}

function normalizeRole(value: unknown): OfficialRolePosition | null {
  const item = record(value)
  if (item === null) return null
  const balance = normalizePositionAmount(item.balance)
  const activeBalance = item.activeBalance === undefined
    ? null
    : normalizePositionAmount(item.activeBalance)
  const valuationUsd = item.valuation
  const claimableAmounts = normalizeClaimables(item.claimTokenAmounts)
  if (
    balance === null ||
    activeBalance === null && item.activeBalance !== undefined ||
    typeof valuationUsd !== 'number' ||
    !Number.isFinite(valuationUsd) ||
    claimableAmounts === null
  ) {
    return null
  }
  return {
    balance,
    activeBalance,
    valuationUsd: Math.max(0, valuationUsd),
    claimableAmounts,
  }
}

function normalizeMarketIdentity(
  value: unknown,
  expectedChainId: SupportedChainId,
): Address | null {
  if (typeof value !== 'string') return null
  const match = MARKET_ID_PATTERN.exec(value)
  if (match === null) return null
  const chainId = Number(match[1])
  if (!Number.isSafeInteger(chainId) || chainId !== expectedChainId) return null
  return normalizeAddress(match[2])
}

function hasDiscoverySignal(role: OfficialRolePosition): boolean {
  return (
    role.balance > 0n ||
    (role.activeBalance ?? 0n) > 0n ||
    role.claimableAmounts.length > 0
  )
}

function normalizeMarketRow(
  value: unknown,
  chainId: SupportedChainId,
  source: OfficialPositionSource,
): OfficialPositionMarket | null {
  const row = record(value)
  if (row === null) return null
  const market = normalizeMarketIdentity(row.marketId, chainId)
  const pt = normalizeRole(row.pt)
  const yt = normalizeRole(row.yt)
  const lp = normalizeRole(row.lp)
  if (market === null || pt === null || yt === null || lp === null) return null
  if (![pt, yt, lp].some(hasDiscoverySignal)) return null
  return {
    key: `${chainId}:${market}` as OfficialPositionMarketKey,
    chainId,
    market,
    roles: { pt, yt, lp },
    sources: [source],
  }
}

function mergeClaimables(
  left: OfficialClaimableAmount[],
  right: OfficialClaimableAmount[],
): OfficialClaimableAmount[] {
  const byToken = new Map(left.map((item) => [item.token.toLowerCase(), item.amount]))
  for (const item of right) {
    const token = item.token.toLowerCase()
    const previous = byToken.get(token)
    if (previous === undefined || item.amount > previous) byToken.set(token, item.amount)
  }
  return [...byToken]
    .sort(([leftToken], [rightToken]) => leftToken.localeCompare(rightToken))
    .map(([token, amount]) => ({ token, amount }))
}

function mergeRole(
  left: OfficialRolePosition,
  right: OfficialRolePosition,
): OfficialRolePosition {
  let activeBalance: bigint | null = null
  for (const candidate of [left.activeBalance, right.activeBalance]) {
    if (candidate !== null && (activeBalance === null || candidate > activeBalance)) {
      activeBalance = candidate
    }
  }
  return {
    balance: left.balance > right.balance ? left.balance : right.balance,
    activeBalance,
    valuationUsd: Math.max(left.valuationUsd, right.valuationUsd),
    claimableAmounts: mergeClaimables(left.claimableAmounts, right.claimableAmounts),
  }
}

function mergeMarket(
  left: OfficialPositionMarket,
  right: OfficialPositionMarket,
): OfficialPositionMarket {
  const sourceSet = new Set([...left.sources, ...right.sources])
  return {
    ...left,
    roles: {
      pt: mergeRole(left.roles.pt, right.roles.pt),
      yt: mergeRole(left.roles.yt, right.roles.yt),
      lp: mergeRole(left.roles.lp, right.roles.lp),
    },
    sources: POSITION_SOURCES.filter((source) => sourceSet.has(source)),
  }
}

/**
 * Validate and normalize Pendle's untrusted cross-chain dashboard payload.
 * Malformed/unsupported rows are skipped, valid zero-only rows are omitted,
 * and duplicate markets are merged case-insensitively per chain.
 */
export function normalizeOfficialPositionDiscovery(value: unknown): OfficialPositionDiscovery {
  const body = record(value)
  if (body === null || !Array.isArray(body.positions)) {
    throw new Error('Pendle official positions returned an invalid response')
  }

  const byKey = new Map<string, OfficialPositionMarket>()
  const failedChainIds = new Set<SupportedChainId>()
  for (const chainCandidate of body.positions) {
    const chain = record(chainCandidate)
    if (chain === null) continue
    const chainIdValue = chain.chainId
    if (
      typeof chainIdValue !== 'number' ||
      !Number.isSafeInteger(chainIdValue) ||
      !isSupportedChainId(chainIdValue)
    ) {
      continue
    }
    const chainId = chainIdValue
    if (typeof chain.errorMessage === 'string' && chain.errorMessage.trim().length > 0) {
      failedChainIds.add(chainId)
    }

    for (const source of POSITION_SOURCES) {
      const collection = chain[`${source}Positions`]
      if (!Array.isArray(collection)) continue
      for (const row of collection) {
        const market = normalizeMarketRow(row, chainId, source)
        if (market === null) continue
        const existing = byKey.get(market.key)
        byKey.set(market.key, existing === undefined ? market : mergeMarket(existing, market))
      }
    }
  }

  return {
    markets: [...byKey.values()].sort(
      (left, right) => left.chainId - right.chainId || left.market.localeCompare(right.market),
    ),
    failedChainIds: [...failedChainIds].sort((left, right) => left - right),
  }
}

/** Backward-compatible market-only projection for pure callers and checks. */
export function normalizeOfficialPositionMarkets(value: unknown): OfficialPositionMarket[] {
  return normalizeOfficialPositionDiscovery(value).markets
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? OFFICIAL_POSITIONS_REQUEST_TIMEOUT_MS
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > OFFICIAL_POSITIONS_MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `Official positions request timeout must be an integer from 1 to ${OFFICIAL_POSITIONS_MAX_REQUEST_TIMEOUT_MS} ms`,
    )
  }
  return timeout
}

function officialPositionsUrl(endpoint: string, user: Address): URL {
  const browserLocation = globalThis.location?.href
  let url: URL
  try {
    url = new URL(endpoint, browserLocation ?? 'http://localhost/')
  } catch {
    throw new Error('Pendle official positions endpoint is invalid')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${user}`
  url.searchParams.set('filterUsd', '0')
  url.hash = ''
  return url
}

async function fetchJsonWithTimeout(
  fetcher: OfficialPositionsFetch,
  url: URL,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ response: Response; body: unknown }> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Pendle official positions request was aborted')
  }

  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    const fail = (reason: unknown): void => {
      controller.abort(reason)
      reject(reason)
    }
    timeoutId = setTimeout(
      () => fail(new Error('Pendle official positions request timed out')),
      timeoutMs,
    )
    if (signal !== undefined) {
      onAbort = () => fail(
        signal.reason ?? new Error('Pendle official positions request was aborted'),
      )
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })

  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'omit',
          signal: controller.signal,
        })
        const body = response.ok && response.status !== 204 ? await response.json() : null
        return { response, body }
      })(),
      deadline,
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

/** Fetch Pendle's cross-chain dashboard solely to discover candidate markets. */
export async function fetchOfficialPositionDiscovery(
  user: Address,
  options: FetchOfficialPositionMarketsOptions = {},
): Promise<OfficialPositionDiscovery> {
  const normalizedUser = normalizeAddress(user)
  if (normalizedUser === null) throw new Error('Official positions user address is invalid')
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation is available')
  const timeoutMs = normalizeTimeout(options.requestTimeoutMs)
  const url = officialPositionsUrl(
    options.endpoint ?? PENDLE_OFFICIAL_POSITIONS_ENDPOINT,
    normalizedUser,
  )
  const { response, body } = await fetchJsonWithTimeout(
    fetcher,
    url,
    options.signal,
    timeoutMs,
  )
  if (!response.ok) {
    throw new Error(`Pendle official positions request failed (${response.status})`)
  }
  return normalizeOfficialPositionDiscovery(body)
}

/** Market-only convenience wrapper. */
export async function fetchOfficialPositionMarkets(
  user: Address,
  options: FetchOfficialPositionMarketsOptions = {},
): Promise<OfficialPositionMarket[]> {
  return (await fetchOfficialPositionDiscovery(user, options)).markets
}
