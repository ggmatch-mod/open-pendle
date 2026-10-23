import { Link } from 'react-router-dom'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { supportedChain } from '../lib/addresses'
import { marketPath } from '../lib/routes'
import type { usePortfolioOverview } from './usePortfolioOverview'
import { clampLabel, formatAmount, formatDate, formatPercent } from './format'

type PortfolioState = ReturnType<typeof usePortfolioOverview>

function currency(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1_000 ? 2 : 0,
  })
}

function SummaryCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <p className="text-[10.5px] font-medium uppercase tracking-[.06em] text-faint">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-fg">{value}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-faint">{note}</p>
    </div>
  )
}

const severityClass = {
  critical: 'border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] text-danger',
  warning: 'border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] text-warn',
  info: 'border-hairline bg-bg-2 text-muted',
} as const

export function PortfolioPositionsSection({ state }: { state: PortfolioState }) {
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { overview } = state

  return (
    <section id="current-portfolio" className="mb-8 overflow-hidden rounded-[16px] border border-hairline bg-bg-2">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-5 py-4 sm:px-6">
        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-[.08em] text-accent-ink">Current portfolio</p>
          <h2 className="mt-1 text-lg font-semibold text-fg">Monitor what you already hold</h2>
          <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-muted">
            Direct-RPC balances with indicative current values, PT maturity value and review-first actions.
          </p>
        </div>
        {isConnected ? (
          <button
            type="button"
            onClick={state.refetch}
            className="rounded-[9px] border border-hairline bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:border-hairline-strong hover:text-fg"
          >
            Refresh
          </button>
        ) : null}
      </div>

      {isConnected && (state.officialDiscoveryError !== undefined || overview.degradedMarketCount > 0) ? (
        <p className="mx-5 mt-4 rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3.5 py-2.5 text-[12px] text-warn sm:mx-6">
          Position coverage is incomplete. {state.officialDiscoveryError ?? `${overview.degradedMarketCount} market${overview.degradedMarketCount === 1 ? '' : 's'} could not be fully checked.`} Refresh to retry missing data.
        </p>
      ) : null}

      {!isConnected ? (
        <div className="px-5 py-10 text-center sm:px-6">
          <p className="text-sm text-muted">Connect your wallet to turn the builder into your portfolio workspace.</p>
          <button
            type="button"
            onClick={() => openConnectModal?.()}
            disabled={!openConnectModal}
            className="mt-4 rounded-[9px] bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:brightness-110"
          >
            Connect wallet
          </button>
        </div>
      ) : state.status === 'loading' ? (
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4 sm:p-6" aria-busy="true">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-xl bg-surface" />
          ))}
        </div>
      ) : state.status === 'error' ? (
        <div className="px-5 py-8 text-center sm:px-6">
          <p className="text-sm text-danger">Your cross-chain positions could not be loaded.</p>
          <button type="button" onClick={state.refetch} className="mt-3 text-xs font-semibold text-accent-ink underline">
            Retry
          </button>
        </div>
      ) : overview.holdings.length === 0 ? (
        <div className="px-5 py-9 text-center sm:px-6">
          <p className="text-sm font-medium text-fg">No PT, YT or LP balances loaded</p>
          <p className="mt-1 text-xs text-muted">Build a new deployment below or inspect the full Positions page.</p>
          <Link to="/positions" className="mt-3 inline-block text-xs font-semibold text-accent-ink hover:underline">
            Open Positions →
          </Link>
        </div>
      ) : (
        <div className="space-y-5 p-5 sm:p-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              label="Indicative value"
              value={overview.pricedHoldingCount === 0 ? '—' : currency(overview.currentValueUsd)}
              note={`${overview.pricedHoldingCount}/${overview.holdings.length} holdings priced now`}
            />
            <SummaryCard
              label="PT at maturity"
              value={overview.principalAtMaturityUsd === 0 ? '—' : currency(overview.principalAtMaturityUsd)}
              note="Face value of priced PT balances; not profit"
            />
            <SummaryCard
              label="Remaining PT value"
              value={overview.principalAtMaturityUsd === 0 ? '—' : currency(overview.remainingPtValueUsd)}
              note="Maturity value minus today’s indicative PT value"
            />
            <SummaryCard
              label="Next maturity"
              value={overview.nearestMaturity === null ? '—' : formatDate(overview.nearestMaturity)}
              note={`${overview.chainCount} network${overview.chainCount === 1 ? '' : 's'} · ${overview.claimableMarketCount} claimable`}
            />
          </div>

          {state.pricesStatus === 'error' || overview.unpricedHoldingCount > 0 ? (
            <p className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3.5 py-2.5 text-[12px] text-warn">
              {state.pricesStatus === 'error'
                ? 'Price refresh failed. Any displayed values use the last available price snapshot. '
                : ''}
              {overview.unpricedHoldingCount > 0
                ? `${overview.unpricedHoldingCount} holding${overview.unpricedHoldingCount === 1 ? '' : 's'} could not be priced. `
                : ''}
              Balances and maturity actions remain available.
            </p>
          ) : null}

          {state.actions.length > 0 ? (
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-fg">Needs attention</h3>
                <Link to="/alerts" className="text-xs font-medium text-accent-ink hover:underline">Open Action Center →</Link>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {state.actions.slice(0, 4).map((action) => (
                  <Link
                    key={action.id}
                    to={marketPath(action.market, action.chainId)}
                    className={`rounded-[10px] border px-3.5 py-3 no-underline ${severityClass[action.severity]}`}
                  >
                    <p className="text-xs font-semibold">{action.title}</p>
                    <p className="mt-1 truncate text-[11px] opacity-80">{clampLabel(action.marketName, 44)}</p>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <section className="overflow-hidden rounded-xl border border-hairline bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
              <h3 className="text-sm font-semibold text-fg">Holdings</h3>
              <Link to="/positions" className="text-xs font-medium text-muted hover:text-fg">Full position tools →</Link>
            </div>
            <div className="divide-y divide-hairline">
              {overview.holdings.map((holding) => {
                const chain = supportedChain(holding.chainId)
                return (
                  <article key={holding.id} className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1.5fr)_minmax(120px,.7fr)_minmax(120px,.7fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-fg" title={holding.marketName}>{clampLabel(holding.marketName, 42)}</p>
                      <p className="mt-0.5 text-[11px] text-faint">{holding.role} · {chain?.name ?? holding.chainId} · {formatAmount(holding.amount, holding.decimals)} {clampLabel(holding.symbol, 14)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[.05em] text-faint">Current value</p>
                      <p className="mt-0.5 text-sm font-semibold tabular-nums text-fg">{holding.currentValueUsd === null ? '—' : currency(holding.currentValueUsd)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[.05em] text-faint">Maturity</p>
                      <p className="mt-0.5 text-xs font-medium text-fg">{formatDate(holding.expiry)}</p>
                      {!holding.isExpired && holding.role === 'PT' ? <p className="text-[10.5px] text-accent-ink">{formatPercent(holding.impliedApy)} current APY</p> : null}
                    </div>
                    <Link to={marketPath(holding.market, holding.chainId)} className="text-xs font-semibold text-accent-ink hover:underline">Review →</Link>
                  </article>
                )
              })}
            </div>
          </section>

          <p className="text-[11px] leading-relaxed text-faint">
            Values are current estimates, not cost basis or P&amp;L. Reward-token values, loops and unpriced assets are excluded from the total. Every action reopens the market for a fresh quote and simulation.
          </p>
        </div>
      )}
    </section>
  )
}
