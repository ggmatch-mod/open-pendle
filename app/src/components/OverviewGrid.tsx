/**
 * OverviewGrid — the pool overview card (PLAN M1): implied APY, PT/YT prices,
 * TVL in accounting asset, maturity countdown, fee tier, PT proportion, plus
 * the out-of-range warning when the pool is pinned at its rate-band edge.
 */

import type { ReactNode } from 'react'
import type { MarketSnapshot } from '../lib/types'
import {
  clampLabel,
  formatCompact,
  formatDate,
  formatPercent,
  formatPrice,
  formatRelative,
} from './format'

function Stat({
  label,
  children,
  sub,
  title,
}: {
  label: string
  children: ReactNode
  sub?: ReactNode
  title?: string
}) {
  return (
    <div
      className="rounded-xl border border-hairline bg-surface p-4"
      title={title}
    >
      <p className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold text-fg tabular-nums">{children}</p>
      {sub !== undefined && <p className="mt-0.5 text-xs text-faint">{sub}</p>}
    </div>
  )
}

export function OverviewGrid({ snapshot }: { snapshot: MarketSnapshot }) {
  const { metrics, sy, expiry, isExpired } = snapshot
  const assetSymbol = sy.assetSymbol ? clampLabel(sy.assetSymbol) : 'asset'
  const proportionPct = Math.min(Math.max(metrics.ptProportion, 0), 1) * 100

  return (
    <div className="space-y-4">
      {metrics.nearRangeEdge && (
        <div
          role="status"
          className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] p-4"
        >
          <p className="text-sm font-medium text-warn">Near rate-range edge</p>
          <p className="mt-1 text-xs leading-relaxed text-warn">
            This pool is near the edge of its immutable rate range — trading may
            be constrained or one-sided.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Implied APY"
          sub={isExpired ? 'not meaningful after maturity' : undefined}
        >
          {isExpired ? '—' : formatPercent(metrics.impliedApy, 2)}
        </Stat>

        <Stat
          label={`PT price (${assetSymbol})`}
          sub={`${formatPrice(metrics.ptPriceSy)} SY per PT`}
          title={`PT price in SY terms: ${formatPrice(metrics.ptPriceSy)} SY per PT`}
        >
          {formatPrice(metrics.ptPriceAsset)}
        </Stat>

        <Stat label={`YT price (${assetSymbol})`}>
          {formatPrice(metrics.ytPriceAsset)}
        </Stat>

        <Stat
          label="Maturity"
          sub={
            isExpired ? (
              <>
                <span className="text-muted">Matured</span> ·{' '}
                {formatRelative(expiry)}
              </>
            ) : (
              formatRelative(expiry)
            )
          }
        >
          {formatDate(expiry)}
        </Stat>
      </div>

      <div className="flex flex-wrap items-center gap-x-7 gap-y-2 rounded-xl border border-hairline bg-surface px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">TVL</span>
          <span className="text-sm font-semibold tabular-nums text-fg">
            {formatCompact(metrics.tvlAsset)} {assetSymbol}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">Fee</span>
          <span className="text-sm font-semibold tabular-nums text-fg">
            {formatPercent(metrics.feeTier)}
          </span>
        </div>
        <div
          className="flex min-w-[160px] flex-1 items-center gap-2"
          title="Share of the pool held as PT (trades cap at 96%)"
        >
          <span className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">
            PT share
          </span>
          <span className="text-sm font-semibold tabular-nums text-fg">
            {formatPercent(metrics.ptProportion, 1)}
          </span>
          <span className="block h-1.5 min-w-[60px] flex-1 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-accent/80"
              style={{ width: `${proportionPct}%` }}
            />
          </span>
        </div>
      </div>
    </div>
  )
}
