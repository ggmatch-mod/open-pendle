/** Pure Action Center item derivation from live portfolio/yield evidence. */

import type { Address } from 'viem'
import type {
  ActionActivity,
  ActionCenterPreferences,
  TrackedActionMarket,
} from './actionCenterStorage.ts'
import type {
  PortfolioAction,
  PortfolioHolding,
} from './portfolioPositions.ts'
import { marketPath } from './routes.ts'
import type { SupportedChainId } from './types.ts'
import type { YieldAlert } from './yieldAlerts.ts'

export type ActionCenterItemKind =
  | PortfolioAction['kind']
  | 'yield-move'
  | 'apy-target'
  | 'transaction'
  | 'order-expiry'
  | 'order-update'
  | 'data-stale'

export type ActionCenterSeverity = 'critical' | 'warning' | 'info'

export interface ActionCenterItem {
  id: string
  kind: ActionCenterItemKind
  severity: ActionCenterSeverity
  title: string
  detail: string
  href?: string
  chainId?: SupportedChainId
  market?: Address
  dueAt?: number
  observedAt: number
}

export interface BuildActionCenterItemsInput {
  portfolioActions: readonly PortfolioAction[]
  holdings: readonly PortfolioHolding[]
  yieldAlerts: readonly YieldAlert[]
  trackedMarkets: readonly TrackedActionMarket[]
  activity: readonly ActionActivity[]
  preferences: ActionCenterPreferences
  yieldWindowEnd?: string
  yieldCoverageUnavailable?: boolean
  portfolioCoverageUnavailable?: boolean
  now?: number
}

const HOUR_MS = 60 * 60_000
const DAY_SECONDS = 24 * 60 * 60

function trackedKey(chainId: number, market: Address): string {
  return `${chainId}:${market.toLowerCase()}`
}

function formatBps(value: number): string {
  const rounded = Math.round(Math.abs(value))
  return `${rounded.toLocaleString('en-US')} bps`
}

function portfolioItem(action: PortfolioAction, now: number): ActionCenterItem {
  return {
    id: action.id,
    kind: action.kind,
    severity: action.severity,
    title: action.title,
    detail: `${action.marketName} · ${action.detail}`,
    href: marketPath(action.market, action.chainId),
    chainId: action.chainId,
    market: action.market,
    ...(action.dueAt === undefined ? {} : { dueAt: action.dueAt }),
    observedAt: now,
  }
}

function activityItems(activity: readonly ActionActivity[], now: number): ActionCenterItem[] {
  const items: ActionCenterItem[] = []
  for (const entry of activity) {
    if (entry.kind === 'limit-order' && entry.status === 'active' && entry.expiry !== undefined) {
      const remaining = entry.expiry - Math.floor(now / 1_000)
      if (remaining <= 0) {
        items.push({
          id: `order-update:${entry.id}:expiry-passed`,
          kind: 'order-update',
          severity: 'warning',
          title: 'Limit order expiry reached',
          detail: `${entry.label} · Open the market to refresh its final Pendle status.`,
          ...(entry.market === undefined
            ? {}
            : {
                market: entry.market,
                href: marketPath(entry.market, entry.chainId),
              }),
          chainId: entry.chainId,
          observedAt: now,
        })
      } else if (remaining <= 7 * DAY_SECONDS) {
        const days = Math.max(1, Math.ceil(remaining / DAY_SECONDS))
        items.push({
          id: `order-expiry:${entry.id}`,
          kind: 'order-expiry',
          severity: days <= 1 ? 'warning' : 'info',
          title: `Limit order expires in ${days} day${days === 1 ? '' : 's'}`,
          detail: entry.label,
          ...(entry.market === undefined
            ? {}
            : {
                market: entry.market,
                href: marketPath(entry.market, entry.chainId),
              }),
          chainId: entry.chainId,
          dueAt: entry.expiry,
          observedAt: now,
        })
      }
      continue
    }
    if (
      entry.kind === 'limit-order' &&
      ['filled', 'expired', 'failed'].includes(entry.status) &&
      now - entry.updatedAt <= 7 * DAY_SECONDS * 1_000
    ) {
      items.push({
        id: `order-update:${entry.id}:${entry.status}`,
        kind: 'order-update',
        severity: entry.status === 'failed' ? 'warning' : 'info',
        title: entry.status === 'filled'
          ? 'Limit order filled'
          : entry.status === 'expired'
            ? 'Limit order expired'
            : 'Limit order needs review',
        detail: entry.label,
        ...(entry.market === undefined
          ? {}
          : {
              market: entry.market,
              href: marketPath(entry.market, entry.chainId),
            }),
        chainId: entry.chainId,
        observedAt: entry.updatedAt,
      })
      continue
    }
    if (entry.kind !== 'limit-order' && ['pending', 'unconfirmed', 'failed'].includes(entry.status)) {
      items.push({
        id: `transaction:${entry.id}`,
        kind: 'transaction',
        severity: entry.status === 'failed' ? 'warning' : 'critical',
        title: entry.status === 'unconfirmed'
          ? 'Transaction still unconfirmed'
          : entry.status === 'pending'
            ? 'Transaction pending'
            : 'Transaction needs review',
        detail: entry.label,
        chainId: entry.chainId,
        observedAt: entry.updatedAt,
      })
    }
  }
  return items
}

export function buildActionCenterItems(input: BuildActionCenterItemsInput): ActionCenterItem[] {
  const now = input.now ?? Date.now()
  const followed = new Set(
    [
      ...input.holdings.map((holding) => trackedKey(holding.chainId, holding.market)),
      ...input.trackedMarkets.map((market) => trackedKey(market.chainId, market.market)),
    ],
  )
  const items = input.portfolioActions
    .filter((action) => input.preferences.showClaimable || action.kind !== 'claim')
    .map((action) => portfolioItem(action, now))

  for (const alert of input.yieldAlerts) {
    const tracked = input.trackedMarkets.find(
      (market) => trackedKey(market.chainId, market.market) === trackedKey(alert.chainId, alert.address),
    )
    if (
      tracked?.targetApyBps !== undefined &&
      alert.endApy * 10_000 + 1e-9 >= tracked.targetApyBps
    ) {
      items.push({
        id: `apy-target:${alert.key}:${tracked.targetApyBps}:${input.yieldWindowEnd ?? 'latest'}`,
        kind: 'apy-target',
        severity: 'info',
        title: `APY target reached: ${(tracked.targetApyBps / 100).toFixed(2)}%`,
        detail: `${alert.name} is at ${(alert.endApy * 100).toFixed(2)}% current implied APY.`,
        href: marketPath(alert.address, alert.chainId),
        chainId: alert.chainId,
        market: alert.address,
        observedAt: now,
      })
    }
    if (
      !followed.has(trackedKey(alert.chainId, alert.address)) ||
      Math.abs(alert.deltaBps) < input.preferences.yieldMoveBps
    ) {
      continue
    }
    const rising = alert.deltaBps > 0
    items.push({
      id: `yield-move:${alert.key}:${input.yieldWindowEnd ?? 'latest'}`,
      kind: 'yield-move',
      severity: Math.abs(alert.deltaBps) >= input.preferences.yieldMoveBps * 2
        ? 'warning'
        : 'info',
      title: `Tracked yield ${rising ? 'rose' : 'fell'} ${formatBps(alert.deltaBps)}`,
      detail: `${alert.name} moved from ${(alert.startApy * 100).toFixed(2)}% to ${(alert.endApy * 100).toFixed(2)}% implied APY.`,
      href: marketPath(alert.address, alert.chainId),
      chainId: alert.chainId,
      market: alert.address,
      observedAt: now,
    })
  }

  items.push(...activityItems(input.activity, now))

  const monitoredMarkets = new Set(
    input.yieldAlerts.map((alert) => trackedKey(alert.chainId, alert.address)),
  )
  const uncoveredTargets = input.trackedMarkets.filter(
    (market) => market.targetApyBps !== undefined &&
      !monitoredMarkets.has(trackedKey(market.chainId, market.market)),
  )
  if (uncoveredTargets.length > 0) {
    items.push({
      id: 'data-stale:tracked-apy-targets',
      kind: 'data-stale',
      severity: 'warning',
      title: 'Some APY targets could not be checked',
      detail: `${uncoveredTargets.length} tracked market${uncoveredTargets.length === 1 ? ' is' : 's are'} outside the available liquidity/history coverage. Review the market directly for its current APY.`,
      observedAt: now,
    })
  }

  if (input.portfolioCoverageUnavailable === true) {
    items.push({
      id: 'data-stale:wallet-positions',
      kind: 'data-stale',
      severity: 'warning',
      title: 'Wallet monitoring coverage is incomplete',
      detail: 'Some wallet positions or claimables could not be checked. Refresh your portfolio to review missing data.',
      href: '/portfolio',
      observedAt: now,
    })
  }

  const windowEnd = input.yieldWindowEnd === undefined
    ? NaN
    : Date.parse(input.yieldWindowEnd)
  if (
    input.yieldCoverageUnavailable === true ||
    (Number.isFinite(windowEnd) && now - windowEnd > 2 * HOUR_MS)
  ) {
    items.push({
      id: 'data-stale:yield-alerts',
      kind: 'data-stale',
      severity: 'warning',
      title: input.yieldCoverageUnavailable === true
        ? 'Yield monitoring coverage is incomplete'
        : 'Yield monitoring coverage is stale',
      detail: 'OpenPendle could not confirm a recent complete yield window. Other live wallet actions remain available.',
      observedAt: now,
    })
  }

  const rank: Record<ActionCenterSeverity, number> = { critical: 0, warning: 1, info: 2 }
  const byId = new Map<string, ActionCenterItem>()
  for (const item of items) byId.set(item.id, item)
  return [...byId.values()].sort(
    (left, right) =>
      rank[left.severity] - rank[right.severity] ||
      (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER) ||
      right.observedAt - left.observedAt,
  )
}
