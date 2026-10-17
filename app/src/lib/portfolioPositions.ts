/**
 * Wallet portfolio valuation and action derivation.
 *
 * Balances and claimables come from direct RPC reads. USD values are
 * indicative snapshots built from Pendle's asset-price service plus the
 * market's current on-chain PT/YT/LP state. There is deliberately no cost
 * basis, realised P&L, or acquisition APY in this module: those require
 * indexed wallet history that the static app does not currently have.
 */

import { formatUnits } from 'viem'
import type { Address } from 'viem'
import { previewDualRemove } from './liquidity.ts'
import { pendleAssetId } from './portfolio.ts'
import {
  hasClaimablePositionRewards,
  splitStandardPositionRows,
} from './positionView.ts'
import type { StandardPositionBalance } from './positionView.ts'
import type { MarketSnapshot, Positions, SupportedChainId } from './types.ts'

export interface PortfolioPositionItem {
  target: {
    chainId: SupportedChainId
    market: Address
    label?: string
  }
  snapshot?: MarketSnapshot
  positions?: Positions
  error?: string
}

export interface PortfolioHolding {
  id: string
  chainId: SupportedChainId
  market: Address
  token: Address
  role: StandardPositionBalance['role']
  symbol: string
  amount: bigint
  decimals: number
  marketName: string
  expiry: number
  isExpired: boolean
  validated: boolean
  impliedApy: number
  currentValueUsd: number | null
  maturityValueUsd: number | null
  remainingPtValueUsd: number | null
}

export interface PortfolioOverview {
  holdings: PortfolioHolding[]
  currentValueUsd: number
  pricedHoldingCount: number
  unpricedHoldingCount: number
  principalAtMaturityUsd: number
  remainingPtValueUsd: number
  nearestMaturity: number | null
  chainCount: number
  claimableMarketCount: number
  degradedMarketCount: number
}

export type PortfolioActionKind = 'matured' | 'maturity' | 'claim' | 'risk'
export type PortfolioActionSeverity = 'critical' | 'warning' | 'info'

export interface PortfolioAction {
  id: string
  kind: PortfolioActionKind
  severity: PortfolioActionSeverity
  chainId: SupportedChainId
  market: Address
  marketName: string
  title: string
  detail: string
  dueAt?: number
}

const DAY_SECONDS = 24 * 60 * 60

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function units(value: bigint, decimals: number): number | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null
  try {
    return finite(Number(formatUnits(value, decimals)))
  } catch {
    return null
  }
}

function assetPrice(
  snapshot: MarketSnapshot,
  chainId: SupportedChainId,
  prices: Readonly<Record<string, number>>,
): number | null {
  const price = prices[pendleAssetId(chainId, snapshot.sy.assetAddress)]
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null
}

function syAssetUnits(snapshot: MarketSnapshot, rawSy: bigint): number | null {
  // EIP-5115 exchangeRate converts raw SY to raw accounting-asset units.
  // Formatting SY first loses the decimal adjustment when the two differ.
  // Legacy snapshots retain a placeholder rate after a failed read. It is
  // suitable only for their explicitly approximate display, not USD totals.
  if (
    snapshot.sy.exchangeRate <= 0n ||
    snapshot.degraded.some((note) => note.startsWith('SY exchangeRate() unavailable'))
  ) return null
  const assetRaw = rawSy * snapshot.sy.exchangeRate / 10n ** 18n
  return units(assetRaw, snapshot.sy.assetDecimals)
}

function currentHoldingValueUsd(
  balance: StandardPositionBalance,
  snapshot: MarketSnapshot,
  priceUsd: number | null,
): number | null {
  if (priceUsd === null) return null
  if (balance.role === 'PT' || balance.role === 'YT') {
    const tokenUnits = units(balance.amount, balance.decimals)
    const assetRate = balance.role === 'PT'
      ? snapshot.metrics.ptPriceAsset
      : snapshot.metrics.ytPriceAsset
    if (tokenUnits === null || !Number.isFinite(assetRate) || assetRate < 0) return null
    return finite(tokenUnits * assetRate * priceUsd)
  }

  const removed = previewDualRemove(snapshot, balance.amount)
  const syUnits = syAssetUnits(snapshot, removed.syOut)
  const ptUnits = units(removed.ptOut, snapshot.sy.assetDecimals)
  if (
    syUnits === null ||
    ptUnits === null ||
    !Number.isFinite(snapshot.metrics.ptPriceAsset) ||
    snapshot.metrics.ptPriceAsset < 0
  ) {
    return null
  }
  return finite((syUnits + ptUnits * snapshot.metrics.ptPriceAsset) * priceUsd)
}

function maturityHoldingValueUsd(
  balance: StandardPositionBalance,
  snapshot: MarketSnapshot,
  priceUsd: number | null,
): number | null {
  if (balance.role !== 'PT' || priceUsd === null) return null
  const tokenUnits = units(balance.amount, snapshot.sy.assetDecimals)
  return tokenUnits === null ? null : finite(tokenUnits * priceUsd)
}

function marketName(item: PortfolioPositionItem): string {
  return item.snapshot?.displayName || item.target.label || item.target.market
}

/** Asset-price ids required to value every hydrated wallet position. */
export function portfolioPositionPriceIds(
  items: readonly PortfolioPositionItem[],
): ReturnType<typeof pendleAssetId>[] {
  const ids = new Set<ReturnType<typeof pendleAssetId>>()
  for (const item of items) {
    if (item.snapshot !== undefined && item.positions !== undefined) {
      ids.add(pendleAssetId(item.target.chainId, item.snapshot.sy.assetAddress))
    }
  }
  return [...ids].sort()
}

/**
 * Build a cross-chain, de-duplicated PT/YT/LP view. PT/YT tokens shared by
 * multiple markets are counted once per chain; LP remains market-specific.
 */
export function buildPortfolioOverview(
  items: readonly PortfolioPositionItem[],
  prices: Readonly<Record<string, number>>,
  now = Math.floor(Date.now() / 1_000),
): PortfolioOverview {
  const byChain = new Map<SupportedChainId, PortfolioPositionItem[]>()
  for (const item of items) {
    const group = byChain.get(item.target.chainId)
    if (group) group.push(item)
    else byChain.set(item.target.chainId, [item])
  }

  const holdings: PortfolioHolding[] = []
  for (const [chainId, chainItems] of byChain) {
    const rows = splitStandardPositionRows(chainItems)
    for (const role of ['PT', 'YT', 'LP'] as const) {
      for (const { item, balance } of rows[role]) {
        const snapshot = item.snapshot
        if (snapshot === undefined) continue
        const priceUsd = assetPrice(snapshot, chainId, prices)
        const currentValueUsd = currentHoldingValueUsd(balance, snapshot, priceUsd)
        const maturityValueUsd = maturityHoldingValueUsd(balance, snapshot, priceUsd)
        const remainingPtValueUsd =
          currentValueUsd === null || maturityValueUsd === null
            ? null
            : finite(maturityValueUsd - currentValueUsd)
        holdings.push({
          id: `${chainId}:${role}:${balance.token.toLowerCase()}`,
          chainId,
          market: item.target.market,
          token: balance.token,
          role,
          symbol: balance.symbol,
          amount: balance.amount,
          decimals: balance.decimals,
          marketName: marketName(item),
          expiry: snapshot.expiry,
          isExpired: snapshot.isExpired || snapshot.expiry <= now,
          validated: snapshot.validated,
          impliedApy: snapshot.metrics.impliedApy,
          currentValueUsd,
          maturityValueUsd,
          remainingPtValueUsd,
        })
      }
    }
  }

  holdings.sort((left, right) => left.expiry - right.expiry || left.marketName.localeCompare(right.marketName))
  const priced = holdings.filter((holding) => holding.currentValueUsd !== null)
  const ptMaturity = holdings.filter((holding) => holding.maturityValueUsd !== null)
  const activeMaturities = holdings
    .filter((holding) => !holding.isExpired)
    .map((holding) => holding.expiry)

  return {
    holdings,
    currentValueUsd: priced.reduce((sum, holding) => sum + (holding.currentValueUsd ?? 0), 0),
    pricedHoldingCount: priced.length,
    unpricedHoldingCount: holdings.length - priced.length,
    principalAtMaturityUsd: ptMaturity.reduce(
      (sum, holding) => sum + (holding.maturityValueUsd ?? 0),
      0,
    ),
    remainingPtValueUsd: ptMaturity.reduce(
      (sum, holding) => sum + (holding.remainingPtValueUsd ?? 0),
      0,
    ),
    nearestMaturity: activeMaturities.length === 0 ? null : Math.min(...activeMaturities),
    chainCount: new Set(holdings.map((holding) => holding.chainId)).size,
    claimableMarketCount: items.filter(
      (item) => item.positions !== undefined && hasClaimablePositionRewards(item.positions),
    ).length,
    degradedMarketCount: items.filter(
      (item) =>
        item.error !== undefined ||
        (item.snapshot?.degraded.length ?? 0) > 0 ||
        (item.positions?.degraded.length ?? 0) > 0,
    ).length,
  }
}

/** Live, recomputable actions; nothing here is persisted as authoritative. */
export function derivePortfolioActions(
  items: readonly PortfolioPositionItem[],
  maturityLeadDays: number,
  now = Math.floor(Date.now() / 1_000),
): PortfolioAction[] {
  const leadSeconds = Math.max(1, Math.min(365, Math.floor(maturityLeadDays))) * DAY_SECONDS
  const actions: PortfolioAction[] = []

  for (const item of items) {
    const { snapshot, positions } = item
    if (snapshot === undefined || positions === undefined) continue
    const name = marketName(item)
    const key = `${item.target.chainId}:${item.target.market.toLowerCase()}`
    const hasPtOrLp = positions.pt > 0n || positions.lp > 0n
    const hasPosition = hasPtOrLp || positions.yt > 0n
    const isExpired = snapshot.isExpired || snapshot.expiry <= now
    const nearRangeEdge = !isExpired && snapshot.metrics.nearRangeEdge

    if (isExpired && hasPtOrLp) {
      actions.push({
        id: `matured:${key}`,
        kind: 'matured',
        severity: 'critical',
        chainId: item.target.chainId,
        market: item.target.market,
        marketName: name,
        title: 'Matured position ready to exit',
        detail: 'Review PT redemption or the matured LP exit directly on the market.',
        dueAt: snapshot.expiry,
      })
    } else if (hasPosition && snapshot.expiry > now && snapshot.expiry - now <= leadSeconds) {
      const days = Math.max(1, Math.ceil((snapshot.expiry - now) / DAY_SECONDS))
      actions.push({
        id: `maturity:${key}`,
        kind: 'maturity',
        severity: days <= 7 ? 'warning' : 'info',
        chainId: item.target.chainId,
        market: item.target.market,
        marketName: name,
        title: `Matures in ${days} day${days === 1 ? '' : 's'}`,
        detail: 'Review the position and its exit path before maturity.',
        dueAt: snapshot.expiry,
      })
    }

    if (hasClaimablePositionRewards(positions)) {
      actions.push({
        id: `claim:${key}`,
        kind: 'claim',
        severity: 'info',
        chainId: item.target.chainId,
        market: item.target.market,
        marketName: name,
        title: 'Yield or rewards ready to claim',
        detail: 'Open the position to review claimable interest and reward tokens.',
      })
    }

    if (
      hasPosition &&
      (!snapshot.validated || snapshot.trust.syPaused === true || nearRangeEdge)
    ) {
      const evidence = [
        !snapshot.validated ? 'market validation unavailable' : null,
        snapshot.trust.syPaused === true ? 'SY is paused' : null,
        nearRangeEdge ? 'pool is near its rate-range edge' : null,
      ].filter((value): value is string => value !== null)
      actions.push({
        id: `risk:${key}`,
        kind: 'risk',
        severity: snapshot.trust.syPaused === true || !snapshot.validated ? 'critical' : 'warning',
        chainId: item.target.chainId,
        market: item.target.market,
        marketName: name,
        title: 'Position risk evidence changed',
        detail: evidence.join(' · '),
      })
    }
  }

  const order: Record<PortfolioActionSeverity, number> = { critical: 0, warning: 1, info: 2 }
  return actions.sort(
    (left, right) =>
      order[left.severity] - order[right.severity] ||
      (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER) ||
      left.title.localeCompare(right.title),
  )
}
