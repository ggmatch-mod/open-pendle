import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { SupportedChainId } from '../lib/types'
import type { YieldAlert } from '../lib/yieldAlerts'
import { isSupportedChainId, SUPPORTED_CHAINS, supportedChain } from '../lib/addresses'
import { marketPath } from '../lib/routes'
import { clampLabel, formatCompact, formatPercent } from '../components/format'
import { PageHeader } from '../components/PageHeader'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { useActionCenter } from '../components/useActionCenter'
import { ActionCenterForYou } from '../components/ActionCenterForYou'

type ChainFilter = SupportedChainId | 'all'
type DirectionFilter = 'all' | 'up' | 'down'
type ScopeFilter = 'significant' | 'all'
type SortKey = 'move' | 'increase' | 'decrease' | 'liquidity'

const selectClass =
  'h-10 rounded-[10px] border border-hairline bg-surface px-3 text-sm text-fg outline-none transition hover:border-hairline-strong focus:border-[rgba(var(--op-accent-rgb),0.7)] focus:ring-2 focus:ring-[rgba(var(--op-accent-rgb),0.12)]'

function chainFromParam(value: string | null): ChainFilter {
  if (value === null || !/^\d+$/.test(value)) return 'all'
  const chainId = Number(value)
  return isSupportedChainId(chainId) ? chainId : 'all'
}

function directionFromParam(value: string | null): DirectionFilter {
  return value === 'up' || value === 'down' ? value : 'all'
}

function scopeFromParam(value: string | null): ScopeFilter {
  return value === 'significant' ? 'significant' : 'all'
}

function sortFromParam(value: string | null): SortKey {
  if (value === 'increase' || value === 'decrease' || value === 'liquidity') return value
  return 'move'
}

function formatUtc(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}

function formatIsoDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function formatBps(value: number): string {
  const rounded = Math.round(value)
  return `${value > 0 ? '+' : ''}${rounded.toLocaleString('en-US')} bps`
}

function alertDirection(alert: YieldAlert): 'up' | 'down' | 'flat' {
  if (alert.deltaBps > 0) return 'up'
  if (alert.deltaBps < 0) return 'down'
  return 'flat'
}

function SummaryStat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-[.05em] text-faint">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-fg">{value}</span>
      {note ? <span className="text-xs text-muted">{note}</span> : null}
    </div>
  )
}

function AlertsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading yield alerts">
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-xl bg-surface" />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-xl bg-surface" />
    </div>
  )
}

export default function AlertsPage() {
  useDocumentTitle('Action Center')
  const actionCenter = useActionCenter()
  const query = actionCenter.yieldQuery
  const [searchParams, setSearchParams] = useSearchParams()
  const view = searchParams.get('view') === 'market' ? 'market' : 'for-you'
  const chain = chainFromParam(searchParams.get('chain'))
  const direction = directionFromParam(searchParams.get('direction'))
  const scope = scopeFromParam(searchParams.get('scope'))
  const sort = sortFromParam(searchParams.get('sort'))

  const updateParam = (key: string, value: string, defaultValue: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === defaultValue) next.delete(key)
    else next.set(key, value)
    setSearchParams(next, { replace: true })
  }

  const visible = useMemo(() => {
    const alerts = query.data?.alerts ?? []
    return alerts
      .filter((alert) => chain === 'all' || alert.chainId === chain)
      .filter((alert) => direction === 'all' || alertDirection(alert) === direction)
      .filter((alert) => scope === 'all' || alert.material)
      .sort((a, b) => {
        if (sort === 'increase') return b.deltaBps - a.deltaBps
        if (sort === 'decrease') return a.deltaBps - b.deltaBps
        if (sort === 'liquidity') return b.liquidity - a.liquidity
        return Math.abs(b.deltaBps) - Math.abs(a.deltaBps)
      })
  }, [chain, direction, query.data?.alerts, scope, sort])

  const materialCount = query.data?.alerts.filter((alert) => alert.material).length ?? 0
  const biggestIncrease = query.data?.alerts.filter((alert) => alert.deltaBps > 0).reduce<YieldAlert | undefined>(
    (best, alert) => (best === undefined || alert.deltaBps > best.deltaBps ? alert : best),
    undefined,
  )
  const biggestDecrease = query.data?.alerts.filter((alert) => alert.deltaBps < 0).reduce<YieldAlert | undefined>(
    (best, alert) => (best === undefined || alert.deltaBps < best.deltaBps ? alert : best),
    undefined,
  )

  return (
    <div className="space-y-6 pb-16">
      <PageHeader
        title="Action Center"
        lede={
          <>
            Your positions, maturities, tracked yield moves and OpenPendle activity in one review queue.
          </>
        }
        actions={
          <button
            type="button"
            onClick={() => {
              void query.refetch()
              actionCenter.portfolio.refetch()
            }}
            disabled={query.isFetching || actionCenter.portfolio.status === 'loading'}
            className="rounded-[10px] border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-fg hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
          >
            {query.isFetching || actionCenter.portfolio.status === 'loading' ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      <div className="flex gap-1 rounded-[11px] border border-hairline bg-bg-2 p-1" role="tablist" aria-label="Action Center views">
        {[
          { id: 'for-you', label: 'For you' },
          { id: 'market', label: 'Market movers' },
        ].map((tab) => {
          const active = view === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => updateParam('view', tab.id, 'for-you')}
              className={`flex-1 rounded-[8px] px-4 py-2 text-sm font-semibold transition sm:flex-none ${active ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'}`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {view === 'for-you' ? (
        <ActionCenterForYou state={actionCenter} />
      ) : query.isPending ? (
        <AlertsSkeleton />
      ) : query.data === undefined ? (
        <section role="alert" className="rounded-xl border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-5">
          <h2 className="font-semibold text-danger">Yield alerts are temporarily unavailable</h2>
          <p className="mt-1.5 text-sm text-muted">{query.error?.message ?? 'Pendle historical data could not be loaded.'}</p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="mt-4 rounded-[10px] border border-[var(--op-danger-bd)] px-3.5 py-2 text-sm font-medium text-danger hover:bg-[var(--op-danger-soft)]"
          >
            Try again
          </button>
        </section>
      ) : (
        <>
          {query.isError && (
            <div role="status" className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-sm text-warn">
              Refresh failed — showing the last snapshot.
            </div>
          )}

          <section
            aria-label="Alert summary"
            className="flex flex-wrap items-center gap-x-7 gap-y-2 rounded-lg border border-hairline bg-surface px-4 py-3"
          >
            <SummaryStat
              label="Significant moves"
              value={materialCount.toLocaleString('en-US')}
              note={`of ${query.data.marketsEligible.toLocaleString('en-US')} pools`}
            />
            <SummaryStat
              label="Largest increase"
              value={biggestIncrease === undefined ? '—' : formatBps(biggestIncrease.deltaBps)}
              note={biggestIncrease === undefined ? undefined : clampLabel(biggestIncrease.name, 28)}
            />
            <SummaryStat
              label="Largest decrease"
              value={biggestDecrease === undefined ? '—' : formatBps(biggestDecrease.deltaBps)}
              note={biggestDecrease === undefined ? undefined : clampLabel(biggestDecrease.name, 28)}
            />
          </section>

          {query.data.failedHistories.length > 0 && (
            <div role="status" className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-sm text-warn">
              Partial coverage: {query.data.failedHistories.length.toLocaleString('en-US')} market {query.data.failedHistories.length === 1 ? 'history' : 'histories'} could not be loaded. Available markets are still shown.
            </div>
          )}

          <section className="overflow-hidden rounded-xl border border-hairline bg-surface">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-hairline p-4">
              <div>
                <h2 className="font-semibold text-fg">24-hour movers</h2>
                <p className="mt-1 text-xs text-faint">
                  {formatUtc(query.data.windowStart)} → {formatUtc(query.data.windowEnd)}
                </p>
              </div>
              <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                <label className="flex flex-col gap-1 text-[10.5px] font-medium uppercase tracking-[.05em] text-faint">
                  Network
                  <select
                    value={chain}
                    onChange={(event) => updateParam('chain', event.target.value, 'all')}
                    className={selectClass}
                  >
                    <option value="all">All networks</option>
                    {SUPPORTED_CHAINS.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[10.5px] font-medium uppercase tracking-[.05em] text-faint">
                  Direction
                  <select
                    value={direction}
                    onChange={(event) => updateParam('direction', event.target.value, 'all')}
                    className={selectClass}
                  >
                    <option value="all">Up &amp; down</option>
                    <option value="up">Increases</option>
                    <option value="down">Decreases</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[10.5px] font-medium uppercase tracking-[.05em] text-faint">
                  Show
                  <select
                    value={scope}
                    onChange={(event) => updateParam('scope', event.target.value, 'all')}
                    className={selectClass}
                  >
                    <option value="all">All qualified</option>
                    <option value="significant">Significant only</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[10.5px] font-medium uppercase tracking-[.05em] text-faint">
                  Sort
                  <select
                    value={sort}
                    onChange={(event) => updateParam('sort', event.target.value, 'move')}
                    className={selectClass}
                  >
                    <option value="move">Largest move</option>
                    <option value="increase">Largest increase</option>
                    <option value="decrease">Largest decrease</option>
                    <option value="liquidity">Liquidity</option>
                  </select>
                </label>
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <p className="font-medium text-fg">No yield moves match these filters</p>
                <p className="mt-1.5 text-sm text-muted">
                  Try “All qualified” to inspect smaller changes in the same 24-hour window.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] border-collapse text-left">
                  <thead className="bg-bg-2 text-[10.5px] uppercase tracking-[.05em] text-faint">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Market</th>
                      <th className="px-4 py-2.5 text-right font-medium">Window start</th>
                      <th className="px-4 py-2.5 text-right font-medium">Window end</th>
                      <th className="px-4 py-2.5 text-right font-medium">Change</th>
                      <th className="px-4 py-2.5 text-right font-medium">Liquidity</th>
                      <th className="px-4 py-2.5 text-right font-medium">Maturity</th>
                      {actionCenter.owner !== undefined && (
                        <th className="px-4 py-2.5 text-right font-medium">Follow</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((alert) => {
                      const move = alertDirection(alert)
                      const chainName = supportedChain(alert.chainId)?.name ?? `Chain ${alert.chainId}`
                      return (
                        <tr key={`${alert.chainId}-${alert.address}`} className="border-t border-hairline hover:bg-surface-2/50">
                          <td className="px-4 py-3.5">
                            <Link to={marketPath(alert.address, alert.chainId)} className="font-semibold text-fg no-underline hover:text-accent-ink">
                              {clampLabel(alert.name, 38)}
                            </Link>
                            <p className="mt-0.5 text-xs text-faint">{clampLabel(alert.protocol || chainName, 24)} · {chainName}</p>
                          </td>
                          <td className="px-4 py-3.5 text-right text-sm tabular-nums text-muted">{formatPercent(alert.startApy)}</td>
                          <td className="px-4 py-3.5 text-right text-sm font-medium tabular-nums text-fg">{formatPercent(alert.endApy)}</td>
                          <td className={`px-4 py-3.5 text-right text-sm font-semibold tabular-nums ${move === 'up' ? 'text-good' : move === 'down' ? 'text-danger' : 'text-muted'}`}>
                            {formatBps(alert.deltaBps)}
                            {alert.material && <span className="ml-1.5 rounded-full border border-hairline px-1.5 py-0.5 text-[9px] uppercase tracking-[.04em] text-accent-ink">alert</span>}
                          </td>
                          <td className="px-4 py-3.5 text-right text-sm tabular-nums text-muted">${formatCompact(alert.liquidity)}</td>
                          <td className="px-4 py-3.5 text-right text-sm text-muted">
                            {formatIsoDate(alert.expiry)}
                            {alert.nearExpiry && (
                              <span className="ml-1.5 rounded-full border border-[var(--op-warn-bd)] px-1.5 py-0.5 text-[9px] uppercase tracking-[.04em] text-warn">
                                &lt;72h
                              </span>
                            )}
                          </td>
                          {actionCenter.owner !== undefined && (
                            <td className="px-4 py-3.5 text-right">
                              <button
                                type="button"
                                aria-pressed={actionCenter.profileState.isTracked(alert.chainId, alert.address)}
                                onClick={() => actionCenter.profileState.toggleTracked(alert)}
                                className={`rounded-[8px] border px-2.5 py-1.5 text-[11px] font-semibold ${actionCenter.profileState.isTracked(alert.chainId, alert.address) ? 'border-[rgba(var(--op-accent-rgb),0.45)] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink' : 'border-hairline text-muted hover:border-hairline-strong hover:text-fg'}`}
                              >
                                {actionCenter.profileState.isTracked(alert.chainId, alert.address) ? 'Tracked' : 'Track'}
                              </button>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-3 text-[11px] text-faint">
              <span>
                {visible.length.toLocaleString('en-US')} shown of{' '}
                {query.data.marketsScanned.toLocaleString('en-US')} scanned
              </span>
              <span>Pendle API · refreshes hourly</span>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
