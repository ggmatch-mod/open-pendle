import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { formatCompact, formatDate, formatPercent } from '../components/format'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { useMarketCatalog } from '../components/useMarketCatalog'
import { SUPPORTED_CHAINS } from '../lib/addresses'
import {
  buildPortfolioRecommendation,
  fetchPendleAssetPrices,
  LOW_RISK_POLICY_SUMMARY,
  portfolioPriceAssetIdsForInput,
} from '../lib/portfolio'
import type {
  PortfolioInput,
  PortfolioMaturity,
  PortfolioRecommendation,
  PortfolioRisk,
} from '../lib/portfolio'
import { marketPath } from '../lib/routes'
import type { SupportedChainId } from '../lib/types'
import { PortfolioPositionsSection } from '../components/PortfolioPositionsSection'
import { usePortfolioOverview } from '../components/usePortfolioOverview'

type BuilderState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'success'
      recommendation: PortfolioRecommendation
      generatedAt: number
    }

const ALL_CHAIN_IDS = SUPPORTED_CHAINS.map((chain) => chain.id)
const fieldsetClass = 'rounded-xl border border-hairline bg-surface p-4 sm:p-5'
const optionClass =
  'rounded-[9px] border px-3 py-2 text-[13px] font-medium transition'

function currency(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1_000 ? 2 : 0,
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' && error ? error : 'The allocation could not be elaborated.'
}

function parseSize(value: string): number {
  return Number(value.replace(/[$,\s]/g, ''))
}

function OptionButton<T extends string>({
  value,
  selected,
  label,
  description,
  onSelect,
}: {
  value: T
  selected: boolean
  label: string
  description: string
  onSelect: (value: T) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(value)}
      className={`${optionClass} ${
        selected
          ? 'border-[rgba(var(--op-accent-rgb),0.5)] bg-[rgba(var(--op-accent-rgb),0.12)] text-accent-ink'
          : 'border-hairline bg-bg text-muted hover:border-hairline-strong hover:text-fg'
      }`}
    >
      <span className="block">{label}</span>
      <span className="mt-0.5 block text-[11px] font-normal text-faint">{description}</span>
    </button>
  )
}

function RecommendationView({
  recommendation,
  generatedAt,
  currentByMarket,
}: {
  recommendation: PortfolioRecommendation
  generatedAt: number
  currentByMarket: ReadonlyMap<string, number>
}) {
  if (recommendation.allocations.length === 0) {
    return (
      <section className="mt-6 rounded-xl border border-hairline bg-surface px-5 py-10 text-center">
        <h2 className="text-base font-semibold text-fg">No eligible allocation found</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted">
          No active, sufficiently liquid PT passed every selected constraint and the live
          stablecoin parity check. Try a broader maturity, more networks, or “Any” risk.
        </p>
      </section>
    )
  }

  return (
    <section className="mt-6" aria-live="polite">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <p className="text-[11px] font-medium uppercase tracking-[.06em] text-faint">
            Indicative fixed APY
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-accent-ink">
            {formatPercent(recommendation.weightedApy)}
          </p>
        </div>
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <p className="text-[11px] font-medium uppercase tracking-[.06em] text-faint">
            Proposed deployment
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">
            {currency(recommendation.deployedUsd)}
          </p>
        </div>
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <p className="text-[11px] font-medium uppercase tracking-[.06em] text-faint">
            Positions
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">
            {recommendation.allocations.length}
          </p>
        </div>
      </div>

      {recommendation.unallocatedUsd > 0.01 ? (
        <div className="mt-3 rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-[13px] text-warn">
          {currency(recommendation.unallocatedUsd)} remains unallocated because filling it would
          exceed the portfolio's concentration, six-position, or pool-liquidity limits.
        </div>
      ) : null}

      <div className="mt-4 overflow-hidden rounded-xl border border-hairline bg-surface">
        <div className="border-b border-hairline px-4 py-3 sm:px-5">
          <h2 className="text-[15px] font-semibold text-fg">Possible allocation</h2>
          <p className="mt-0.5 text-[12px] text-faint">
            Ranked by current implied APY, then constrained for concentration and liquidity.
          </p>
        </div>
        <div className="divide-y divide-hairline">
          {recommendation.allocations.map((allocation) => {
            const chain = SUPPORTED_CHAINS.find((item) => item.id === allocation.market.chainId)
            const currentValueUsd = currentByMarket.get(allocation.market.key) ?? 0
            const targetDeltaUsd = allocation.amountUsd - currentValueUsd
            return (
              <article
                key={allocation.market.key}
                className="grid gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(90px,0.7fr))] sm:items-center sm:px-5"
              >
                <div className="min-w-0">
                  <Link
                    to={marketPath(allocation.market.address, allocation.market.chainId)}
                    className="font-semibold text-fg no-underline hover:text-accent-ink hover:underline"
                  >
                    PT {allocation.market.name}
                  </Link>
                  <p className="mt-0.5 truncate text-[12px] text-muted">
                    {allocation.market.protocol ?? 'Unknown protocol'} · {chain?.name ?? allocation.market.chainId}
                  </p>
                  {allocation.stableParityRatio !== null ? (
                    <p className="mt-1 text-[11px] tabular-nums text-accent-ink">
                      Live peg ratio {formatPercent(allocation.stableParityRatio)}
                    </p>
                  ) : null}
                  <Link
                    to={marketPath(allocation.market.address, allocation.market.chainId)}
                    className="mt-1.5 inline-block text-[11.5px] font-semibold text-accent-ink no-underline hover:underline"
                  >
                    Review &amp; quote →
                  </Link>
                </div>
                <div>
                  <p className="text-[10.5px] uppercase tracking-[.05em] text-faint">Allocation</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-fg">
                    {currency(allocation.amountUsd)}
                  </p>
                  <p className="text-[11px] tabular-nums text-muted">
                    {formatPercent(allocation.weight)}
                  </p>
                  {currentValueUsd > 0 ? (
                    <p className="mt-1 text-[10.5px] tabular-nums text-faint">
                      {currency(currentValueUsd)} held · {targetDeltaUsd > 0 ? `${currency(targetDeltaUsd)} gap` : 'target covered'}
                    </p>
                  ) : null}
                </div>
                <div>
                  <p className="text-[10.5px] uppercase tracking-[.05em] text-faint">Implied APY</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-accent-ink">
                    {formatPercent(Number(allocation.market.impliedApy))}
                  </p>
                </div>
                <div>
                  <p className="text-[10.5px] uppercase tracking-[.05em] text-faint">Maturity</p>
                  <p className="mt-0.5 text-[13px] font-medium text-fg">
                    {formatDate(Number(allocation.market.expiry))}
                  </p>
                </div>
                <div>
                  <p className="text-[10.5px] uppercase tracking-[.05em] text-faint">Pool usage</p>
                  <p className="mt-0.5 text-[13px] font-medium tabular-nums text-fg">
                    {formatPercent(allocation.liquidityShare)}
                  </p>
                  <p className="text-[11px] text-muted">
                    of ${formatCompact(Number(allocation.market.liquidity))}
                  </p>
                </div>
              </article>
            )
          })}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-hairline bg-bg-2 px-4 py-3 text-[12px] leading-relaxed text-muted">
        Screened {recommendation.eligibleMarketCount} eligible markets and checked{' '}
        {recommendation.checkedStableMarketCount} Pendle-tagged stable exposures. Excluded{' '}
        {recommendation.excludedDepeggedCount} outside the 3% parity band and{' '}
        {recommendation.excludedUnpricedStableCount} without complete price data. Snapshot generated{' '}
        {new Date(generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
      </div>
    </section>
  )
}

export default function PortfolioPage() {
  useDocumentTitle('Portfolio OS')
  const catalog = useMarketCatalog()
  const portfolioState = usePortfolioOverview()
  const [size, setSize] = useState('100,000')
  const [risk, setRisk] = useState<PortfolioRisk>('any')
  const [maturity, setMaturity] = useState<PortfolioMaturity>('any')
  const [chainIds, setChainIds] = useState<SupportedChainId[]>(ALL_CHAIN_IDS)
  const [builder, setBuilder] = useState<BuilderState>({ status: 'idle' })
  const requestController = useRef<AbortController | null>(null)
  const currentByMarket = useMemo(() => {
    const values = new Map<string, number>()
    for (const holding of portfolioState.overview.holdings) {
      // The proposed allocations are PT positions. YT/LP exposure does not
      // satisfy a PT deployment target for the same market.
      if (holding.role !== 'PT' || holding.currentValueUsd === null) continue
      const key = `${holding.chainId}:${holding.market.toLowerCase()}`
      values.set(key, (values.get(key) ?? 0) + holding.currentValueUsd)
    }
    return values
  }, [portfolioState.overview.holdings])

  useEffect(
    () => () => {
      requestController.current?.abort()
    },
    [],
  )

  const invalidate = () => {
    requestController.current?.abort()
    setBuilder({ status: 'idle' })
  }

  const updateRisk = (value: PortfolioRisk) => {
    invalidate()
    setRisk(value)
  }
  const updateMaturity = (value: PortfolioMaturity) => {
    invalidate()
    setMaturity(value)
  }
  const toggleChain = (chainId: SupportedChainId) => {
    invalidate()
    setChainIds((current) =>
      current.includes(chainId)
        ? current.filter((candidate) => candidate !== chainId)
        : [...current, chainId],
    )
  }

  const elaborate = async () => {
    const sizeUsd = parseSize(size)
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
      setBuilder({ status: 'error', message: 'Enter a deployment size greater than zero.' })
      return
    }
    if (chainIds.length === 0) {
      setBuilder({ status: 'error', message: 'Select at least one network.' })
      return
    }
    if (catalog.data === undefined || catalog.data.coverage.pendle.active !== true) {
      setBuilder({
        status: 'error',
        message: 'Current active Pendle market data is unavailable. Retry the directory first.',
      })
      return
    }

    const input: PortfolioInput = { sizeUsd, risk, maturity, chainIds }
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    setBuilder({ status: 'loading' })
    try {
      const now = Math.floor(Date.now() / 1_000)
      const priceIds = portfolioPriceAssetIdsForInput(catalog.data.markets, input, now)
      const prices = await fetchPendleAssetPrices(priceIds, { signal: controller.signal })
      if (controller.signal.aborted) return
      const recommendation = buildPortfolioRecommendation(
        catalog.data.markets,
        prices,
        input,
        now,
      )
      setBuilder({
        status: 'success',
        recommendation,
        generatedAt: Date.now(),
      })
    } catch (error) {
      if (controller.signal.aborted) return
      setBuilder({ status: 'error', message: errorMessage(error) })
    } finally {
      if (requestController.current === controller) requestController.current = null
    }
  }

  return (
    <div className="pb-16">
      <PageHeader
        title="Portfolio OS"
        lede="Monitor current Pendle holdings, handle what needs attention, and elaborate a transparent PT deployment plan."
      />

      <PortfolioPositionsSection state={portfolioState} />

      <div className="mb-4">
        <p className="text-[10.5px] font-semibold uppercase tracking-[.08em] text-accent-ink">New deployment</p>
        <h2 className="mt-1 text-lg font-semibold text-fg">Build a PT allocation plan</h2>
        <p className="mt-1 text-[12.5px] text-muted">Set size and constraints, then review each market with a fresh quote before signing anything.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.65fr)]">
        <div className="space-y-4">
          <fieldset className={fieldsetClass}>
            <legend className="px-1 text-[13px] font-semibold text-fg">Deployment size</legend>
            <label className="mt-1 block">
              <span className="sr-only">Deployment size in US dollars</span>
              <div className="flex h-12 items-center rounded-[10px] border border-hairline-strong bg-bg px-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-[rgba(var(--op-accent-rgb),0.14)]">
                <span className="mr-2 text-lg text-faint">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={size}
                  onChange={(event) => {
                    invalidate()
                    setSize(event.target.value.slice(0, 24))
                  }}
                  className="min-w-0 flex-1 bg-transparent text-lg font-semibold tabular-nums text-fg outline-none"
                  placeholder="100,000"
                  autoComplete="off"
                />
              </div>
            </label>
          </fieldset>

          <fieldset className={fieldsetClass}>
            <legend className="px-1 text-[13px] font-semibold text-fg">Risk filter</legend>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              <OptionButton
                value="any"
                selected={risk === 'any'}
                label="Any"
                description="All eligible listed PT markets"
                onSelect={updateRisk}
              />
              <OptionButton
                value="low"
                selected={risk === 'low'}
                label="Low"
                description={LOW_RISK_POLICY_SUMMARY}
                onSelect={updateRisk}
              />
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
              “Low” is relative: it currently allows only PTs backed directly by Ethereum USDe or
              sUSDe, plus the live peg check. USDai/sUSDai and every other unreviewed exposure are
              excluded. It is not a guarantee of safety.
            </p>
          </fieldset>

          <fieldset className={fieldsetClass}>
            <div className="flex items-center justify-between gap-3">
              <legend className="px-1 text-[13px] font-semibold text-fg">Networks</legend>
              <button
                type="button"
                onClick={() => {
                  invalidate()
                  setChainIds(
                    chainIds.length === ALL_CHAIN_IDS.length ? [] : ALL_CHAIN_IDS,
                  )
                }}
                className="text-[11.5px] font-medium text-accent-ink hover:underline"
              >
                {chainIds.length === ALL_CHAIN_IDS.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {SUPPORTED_CHAINS.map((chain) => {
                const selected = chainIds.includes(chain.id)
                return (
                  <button
                    key={chain.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleChain(chain.id)}
                    className={`${optionClass} flex items-center gap-2 ${
                      selected
                        ? 'border-[rgba(var(--op-accent-rgb),0.5)] bg-[rgba(var(--op-accent-rgb),0.12)] text-accent-ink'
                        : 'border-hairline bg-bg text-muted hover:border-hairline-strong hover:text-fg'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`h-2 w-2 rounded-full ${selected ? 'bg-accent' : 'bg-[var(--op-faint)]'}`}
                    />
                    {chain.name}
                  </button>
                )
              })}
            </div>
          </fieldset>

          <fieldset className={fieldsetClass}>
            <legend className="px-1 text-[13px] font-semibold text-fg">Maximum maturity</legend>
            <div className="mt-1 grid gap-2 sm:grid-cols-3">
              <OptionButton
                value="any"
                selected={maturity === 'any'}
                label="Any"
                description="No maximum"
                onSelect={updateMaturity}
              />
              <OptionButton
                value="6m"
                selected={maturity === '6m'}
                label="< 6 months"
                description="Shorter duration"
                onSelect={updateMaturity}
              />
              <OptionButton
                value="3m"
                selected={maturity === '3m'}
                label="< 3 months"
                description="Shortest duration"
                onSelect={updateMaturity}
              />
            </div>
          </fieldset>
        </div>

        <aside className="h-fit rounded-xl border border-hairline bg-bg-2 p-5 lg:sticky lg:top-24">
          <h2 className="text-[15px] font-semibold text-fg">How it elaborates</h2>
          <ol className="mt-3 space-y-3 text-[13px] leading-relaxed text-muted">
            <li><span className="mr-2 font-mono text-accent-ink">1.</span>Apply network, maturity, and the disclosed exposure allowlist for Low risk.</li>
            <li><span className="mr-2 font-mono text-accent-ink">2.</span>Exclude Pendle-tagged stable exposures that are unpriced or more than 3% from live parity.</li>
            <li><span className="mr-2 font-mono text-accent-ink">3.</span>Prefer higher implied APY, using at most six positions and capping one market or protocol at 90%.</li>
            <li><span className="mr-2 font-mono text-accent-ink">4.</span>Cap each allocation at 10% of reported pool liquidity.</li>
          </ol>
          <button
            type="button"
            onClick={() => void elaborate()}
            disabled={catalog.isPending || builder.status === 'loading'}
            className="mt-5 w-full rounded-[10px] bg-accent px-4 py-3 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:cursor-wait disabled:opacity-55"
          >
            {catalog.isPending
              ? 'Loading markets…'
              : builder.status === 'loading'
                ? 'Elaborating…'
                : 'Elaborate'}
          </button>
          <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
            Read-only analysis. No transaction is prepared or submitted. APY, liquidity, prices,
            and risk can change before execution.
          </p>
        </aside>
      </div>

      {catalog.status === 'error' ? (
        <div className="mt-4 rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-4 py-3 text-sm text-danger">
          Current market data could not be loaded.{' '}
          <button type="button" onClick={() => void catalog.refetch()} className="font-semibold underline">
            Retry
          </button>
        </div>
      ) : null}
      {builder.status === 'error' ? (
        <div role="alert" className="mt-4 rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-4 py-3 text-sm text-danger">
          {builder.message}
        </div>
      ) : null}
      {builder.status === 'success' ? (
        <RecommendationView
          recommendation={builder.recommendation}
          generatedAt={builder.generatedAt}
          currentByMarket={currentByMarket}
        />
      ) : null}
    </div>
  )
}
