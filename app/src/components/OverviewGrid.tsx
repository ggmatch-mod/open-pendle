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
      <p className="text-xs text-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold text-fg">{children}</p>
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
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

        <Stat label="TVL" sub={`in ${assetSymbol} terms`}>
          {formatCompact(metrics.tvlAsset)}{' '}
          <span className="text-sm font-normal text-muted">{assetSymbol}</span>
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

        <Stat label="Fee tier">{formatPercent(metrics.feeTier)}</Stat>

        <Stat
          label="PT proportion"
          sub={
            <span className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <span
                className="block h-full rounded-full bg-accent/80"
                style={{ width: `${proportionPct}%` }}
              />
            </span>
          }
          title="Share of the pool held as PT (trades cap at 96%)"
        >
          {formatPercent(metrics.ptProportion, 1)}
        </Stat>
      </div>
    </div>
  )
}
