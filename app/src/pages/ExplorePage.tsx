import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  catalogMarketDisplayTvl,
  currentCatalogMarketLifecycle,
} from '../lib/catalog'
import type { CatalogMarket } from '../lib/catalog'
import type { SupportedChainId } from '../lib/types'
import { isSupportedChainId, SUPPORTED_CHAINS } from '../lib/addresses'
import { CatalogMarketCard } from '../components/CatalogMarketCard'
import { useMarketCatalog } from '../components/useMarketCatalog'
import { useDocumentTitle } from '../components/useDocumentTitle'

const PAGE_SIZE = 24
const FACTORY_SNAPSHOT_STALE_AFTER_SECONDS = 48 * 60 * 60
const EMPTY_MARKETS: CatalogMarket[] = []

type LifecycleFilter = 'all' | 'live' | 'matured' | 'unknown'
type SourceFilter = 'all' | 'listed' | 'community'
type SortKey = 'tvl' | 'apy' | 'expiry' | 'newest'
type ChainFilter = SupportedChainId | 'all'
type DirectoryUpdate = Partial<{
  query: string
  chain: ChainFilter
  lifecycle: LifecycleFilter
  source: SourceFilter
  sort: SortKey
  page: number
}>

const selectClass =
  'h-11 w-full rounded-[10px] border border-hairline bg-surface px-3 text-sm text-fg outline-none transition hover:border-hairline-strong focus:border-[rgba(var(--op-accent-rgb),0.7)] focus:ring-2 focus:ring-[rgba(var(--op-accent-rgb),0.12)]'

const lifecycleOptions: Array<{ value: LifecycleFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'matured', label: 'Matured' },
  { value: 'unknown', label: 'Unknown' },
]

const sourceOptions: Array<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: 'All sources' },
  { value: 'listed', label: 'Pendle-listed' },
  { value: 'community', label: 'Community' },
]

function chainFromParams(value: string | null): ChainFilter {
  if (value === null || !/^\d+$/.test(value)) return 'all'
  const chainId = Number(value)
  return isSupportedChainId(chainId) ? chainId : 'all'
}

function lifecycleFromParams(value: string | null): LifecycleFilter {
  if (value === 'live' || value === 'matured' || value === 'unknown') return value
  // Preserve the intent of early Explore links that used `status=active`.
  if (value === 'active') return 'live'
  return 'all'
}

function sourceFromParams(value: string | null): SourceFilter {
  return value === 'listed' || value === 'community' ? value : 'all'
}

function sortFromParams(value: string | null): SortKey {
  return value === 'apy' || value === 'expiry' || value === 'newest' ? value : 'tvl'
}

function pageFromParams(value: string | null): number {
  if (value === null || !/^[1-9]\d{0,4}$/.test(value)) return 1
  return Number(value)
}

function searchableText(market: CatalogMarket): string {
  return [
    market.name,
    market.protocol,
    market.address,
    market.pt,
    market.yt,
    market.sy,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
}

function metricDescending(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' && error ? error : 'The catalog could not be loaded.'
}

export default function ExplorePage() {
  useDocumentTitle('Explore markets')
  const catalog = useMarketCatalog()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = (searchParams.get('q') ?? '').slice(0, 256)
  const chain = chainFromParams(searchParams.get('chain'))
  const lifecycleFilter = lifecycleFromParams(
    searchParams.get('lifecycle') ?? searchParams.get('status'),
  )
  const sourceFilter = sourceFromParams(searchParams.get('source'))
  const sort = sortFromParams(searchParams.get('sort'))
  const page = pageFromParams(searchParams.get('page'))
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const resultsRef = useRef<HTMLElement>(null)
  const focusAfterPagination = useRef(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!focusAfterPagination.current) return
    focusAfterPagination.current = false
    const results = resultsRef.current
    if (results === null) return
    results.scrollIntoView({ block: 'start' })
    const firstCard = results.querySelector<HTMLAnchorElement>('a[href]')
    if (firstCard !== null) firstCard.focus({ preventScroll: true })
    else results.focus({ preventScroll: true })
  }, [page])

  const updateDirectory = (updates: DirectoryUpdate) => {
    const next = new URLSearchParams(searchParams)

    if (updates.query !== undefined) {
      const value = updates.query.slice(0, 256)
      if (value.trim() === '') next.delete('q')
      else next.set('q', value)
    }
    if (updates.chain !== undefined) {
      if (updates.chain === 'all') next.delete('chain')
      else next.set('chain', String(updates.chain))
    }
    if (updates.lifecycle !== undefined) {
      next.delete('status')
      if (updates.lifecycle === 'all') next.delete('lifecycle')
      else next.set('lifecycle', updates.lifecycle)
    }
    if (updates.source !== undefined) {
      if (updates.source === 'all') next.delete('source')
      else next.set('source', updates.source)
    }
    if (updates.sort !== undefined) {
      if (updates.sort === 'tvl') next.delete('sort')
      else next.set('sort', updates.sort)
    }
    if (updates.page !== undefined) {
      if (updates.page <= 1) next.delete('page')
      else next.set('page', String(Math.floor(updates.page)))
    }

    setSearchParams(next, { replace: true })
  }

  const markets = catalog.data?.markets ?? EMPTY_MARKETS
  const pendleCoverageComplete =
    catalog.data?.coverage.pendle.active === true &&
    catalog.data.coverage.pendle.inactive === true
  const factoryCoverage = catalog.data?.coverage.factory
  const staleNetworkIds = factoryCoverage?.status === 'complete'
    ? SUPPORTED_CHAINS.filter((item) => {
        const indexedAt = factoryCoverage.indexedAt[item.id]
        return indexedAt === undefined ||
          indexedAt > now + 5 * 60 ||
          now - indexedAt > FACTORY_SNAPSHOT_STALE_AFTER_SECONDS
      }).map((item) => item.id)
    : []
  const staleNetworkNames = SUPPORTED_CHAINS.filter((item) =>
    staleNetworkIds.includes(item.id),
  ).map((item) => item.name)
  const factoryCoverageComplete =
    factoryCoverage?.status === 'complete' && staleNetworkIds.length === 0
  const incompleteNetworkNames =
    factoryCoverage?.status === 'complete'
      ? []
      : SUPPORTED_CHAINS.filter(
          (item) => !factoryCoverage?.completeChains.includes(item.id),
        ).map((item) => item.name)
  const selectedNetwork =
    chain === 'all' ? undefined : SUPPORTED_CHAINS.find((item) => item.id === chain)
  const selectedNetworkMembershipIncomplete =
    sourceFilter !== 'listed' &&
    chain !== 'all' &&
    (factoryCoverage?.completeChains.includes(chain) !== true || staleNetworkIds.includes(chain))
  const communityClassificationUnavailable =
    sourceFilter === 'community' && !pendleCoverageComplete
  const catalogCoverageHasWarnings =
    catalog.data !== undefined &&
    (!factoryCoverageComplete ||
      !pendleCoverageComplete ||
      (factoryCoverage?.quarantinedLogCount ?? 0) > 0)
  const factoryCoverageText = (() => {
    if (factoryCoverage === undefined) return ''
    if (factoryCoverage.status === 'unavailable') {
      return 'Factory snapshot unavailable — showing a Pendle-listed bootstrap only.'
    }
    const totalChains = factoryCoverage.totalChains || SUPPORTED_CHAINS.length
    if (factoryCoverage.status === 'partial') {
      const incompleteSuffix =
        incompleteNetworkNames.length > 0
          ? ` on ${incompleteNetworkNames.join(', ')}`
          : ' on uncovered networks'
      return `${factoryCoverage.completeChains.length}/${totalChains} network scans complete — community inventory may be missing${incompleteSuffix}.`
    }
    if (staleNetworkNames.length > 0) {
      return `Last-known-complete factory inventory is stale on ${staleNetworkNames.join(', ')} — newly created markets may be missing · ${factoryCoverage.marketCount.toLocaleString()} ${factoryCoverage.marketCount === 1 ? 'market' : 'markets'} indexed.`
    }
    return `Factory coverage complete across ${totalChains} networks · ${factoryCoverage.marketCount.toLocaleString()} ${factoryCoverage.marketCount === 1 ? 'market' : 'markets'} indexed.`
  })()
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const result = markets.filter((market) => {
      const lifecycle = currentCatalogMarketLifecycle(market, now)
      const lifecycleMatches =
        lifecycleFilter === 'all' || lifecycleFilter === lifecycle
      const listed = market.sources.includes('pendle-listed')
      const confidentlyCommunity =
        market.sources.includes('factory-indexed') && !listed && pendleCoverageComplete
      const sourceMatches =
        sourceFilter === 'all' ||
        (sourceFilter === 'listed' && listed) ||
        (sourceFilter === 'community' && confidentlyCommunity)

      return (
        (chain === 'all' || market.chainId === chain) &&
        lifecycleMatches &&
        sourceMatches &&
        (needle === '' || searchableText(market).includes(needle))
      )
    })

    return result.sort((a, b) => {
      let order = 0
      if (sort === 'tvl') {
        order = metricDescending(
          catalogMarketDisplayTvl(a, now),
          catalogMarketDisplayTvl(b, now),
        )
      }
      if (sort === 'apy') {
        const aApy = currentCatalogMarketLifecycle(a, now) === 'matured' ? null : a.impliedApy
        const bApy = currentCatalogMarketLifecycle(b, now) === 'matured' ? null : b.impliedApy
        order = metricDescending(aApy, bApy)
      }
      if (sort === 'expiry') {
        order =
          (a.expiry ?? Number.MAX_SAFE_INTEGER) -
          (b.expiry ?? Number.MAX_SAFE_INTEGER)
      }
      if (sort === 'newest') order = Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0)
      return order || a.name.localeCompare(b.name)
    })
  }, [chain, lifecycleFilter, markets, now, pendleCoverageComplete, query, sort, sourceFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const firstResult = filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1
  const lastResult = Math.min(currentPage * PAGE_SIZE, filtered.length)

  useEffect(() => {
    if (catalog.status !== 'success' || page === currentPage) return
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (currentPage <= 1) next.delete('page')
        else next.set('page', String(currentPage))
        return next
      },
      { replace: true },
    )
  }, [catalog.status, currentPage, page, setSearchParams])

  const clearFilters = () => {
    updateDirectory({
      query: '',
      chain: 'all',
      lifecycle: 'all',
      source: 'all',
      sort: 'tvl',
      page: 1,
    })
  }

  const showPage = (nextPage: number) => {
    focusAfterPagination.current = true
    updateDirectory({ page: nextPage })
  }

  return (
    <div className="py-8 sm:py-10">
      <div className="relative overflow-hidden rounded-[20px] border border-hairline bg-surface px-5 py-7 sm:px-8 sm:py-9">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full opacity-20 blur-3xl"
          style={{ background: 'var(--op-accent)' }}
        />
        <div className="relative max-w-3xl">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.15em] text-accent-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            V2 market directory
          </div>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            Factory-created markets, one directory
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted sm:text-base">
            Explore the factory-indexed universe across OpenPendle networks — including community
            pools absent from Pendle's frontend. The coverage notice shows which network scans are
            complete. Search by protocol, market name, or any market, PT, YT or SY address.
          </p>
        </div>
      </div>

      <aside className="mt-4 rounded-[14px] border border-hairline bg-surface px-4 py-3.5" aria-label="Catalog trust notice">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[rgba(var(--op-accent-rgb),0.35)] bg-[rgba(var(--op-accent-rgb),0.09)] text-xs font-bold text-accent-ink"
          >
            i
          </span>
          <p className="text-xs leading-5 text-muted">
            <span className="font-semibold text-fg">Factory-created does not mean safe.</span>{' '}
            Events establish market provenance; Pendle's catalog only adds listing and display
            metadata. Neither source reviews the underlying asset or SY. Always inspect the SY
            owner, pause controls, liquidity and contract addresses before transacting.
          </p>
        </div>
      </aside>

      <section className="mt-6" aria-label="Market directory filters">
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_190px_190px]">
          <label className="relative block">
            <span className="sr-only">Search markets</span>
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
            >
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4 4" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              maxLength={256}
              value={query}
              onChange={(event) => updateDirectory({ query: event.target.value, page: 1 })}
              placeholder="Search name, protocol or address…"
              className="h-11 w-full rounded-[10px] border border-hairline bg-surface pl-10 pr-4 text-sm text-fg outline-none transition placeholder:text-faint hover:border-hairline-strong focus:border-[rgba(var(--op-accent-rgb),0.7)] focus:ring-2 focus:ring-[rgba(var(--op-accent-rgb),0.12)]"
            />
          </label>

          <label>
            <span className="sr-only">Filter by network</span>
            <select
              value={chain}
              onChange={(event) => {
                const value = event.target.value
                updateDirectory({
                  chain: value === 'all' ? 'all' : (Number(value) as SupportedChainId),
                  page: 1,
                })
              }}
              className={selectClass}
            >
              <option value="all">All networks</option>
              {SUPPORTED_CHAINS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="sr-only">Sort markets</span>
            <select
              value={sort}
              onChange={(event) =>
                updateDirectory({ sort: event.target.value as SortKey, page: 1 })
              }
              className={selectClass}
            >
              <option value="tvl">Highest TVL</option>
              <option value="apy">Highest implied APY</option>
              <option value="expiry">Soonest maturity</option>
              <option value="newest">Newest created</option>
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-wrap gap-3">
            <div className="min-w-0">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-faint">
                Lifecycle
              </p>
              <div
                className="inline-flex max-w-full overflow-x-auto rounded-[10px] border border-hairline bg-surface p-1"
                role="group"
                aria-label="Filter by market lifecycle"
              >
                {lifecycleOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => updateDirectory({ lifecycle: option.value, page: 1 })}
                    aria-pressed={lifecycleFilter === option.value}
                    className={
                      lifecycleFilter === option.value
                        ? 'shrink-0 rounded-[7px] bg-[rgba(var(--op-accent-rgb),0.13)] px-3 py-1.5 text-xs font-semibold text-accent-ink'
                        : 'shrink-0 rounded-[7px] px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-surface-2 hover:text-fg'
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-w-0">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-faint">
                Source
              </p>
              <div
                className="inline-flex max-w-full overflow-x-auto rounded-[10px] border border-hairline bg-surface p-1"
                role="group"
                aria-label="Filter by market source"
              >
                {sourceOptions.map((option) => {
                  const unavailable = option.value === 'community' && !pendleCoverageComplete
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => updateDirectory({ source: option.value, page: 1 })}
                      aria-pressed={sourceFilter === option.value}
                      disabled={unavailable}
                      title={
                        unavailable
                          ? 'Community classification requires complete Pendle listing coverage.'
                          : undefined
                      }
                      className={
                        unavailable
                          ? 'shrink-0 cursor-not-allowed rounded-[7px] px-3 py-1.5 text-xs font-medium text-faint opacity-50'
                          : sourceFilter === option.value
                            ? 'shrink-0 rounded-[7px] bg-[rgba(var(--op-accent-rgb),0.13)] px-3 py-1.5 text-xs font-semibold text-accent-ink'
                            : 'shrink-0 rounded-[7px] px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-surface-2 hover:text-fg'
                      }
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {catalog.status === 'success' && (
            <p className="pb-2 text-xs tabular-nums text-faint" aria-live="polite">
              {filtered.length === 0
                ? 'No matching markets'
                : `${firstResult}–${lastResult} of ${filtered.length.toLocaleString()} ${filtered.length === 1 ? 'market' : 'markets'}`}
            </p>
          )}
        </div>
      </section>

      {catalog.status === 'success' && catalog.data !== undefined && (
        <div
          className={
            catalogCoverageHasWarnings
              ? 'mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-xs text-warn'
              : 'mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-hairline bg-surface px-4 py-3 text-xs text-muted'
          }
        >
          <div className="flex min-w-0 items-start gap-2.5" role="status">
            <span
              aria-hidden
              className={
                catalogCoverageHasWarnings
                  ? 'mt-1 h-2 w-2 shrink-0 rounded-full bg-warn'
                  : 'mt-1 h-2 w-2 shrink-0 rounded-full bg-good'
              }
            />
            <div className="min-w-0 leading-5">
              <p className={catalogCoverageHasWarnings ? 'font-medium text-warn' : 'font-medium text-fg'}>
                {factoryCoverageText}
              </p>
              {!pendleCoverageComplete && (
                <p>
                  Pendle listing enrichment is partial. Unmatched factory markets are labeled
                  “Listing unknown,” not community/unlisted.
                </p>
              )}
              {(factoryCoverage?.quarantinedLogCount ?? 0) > 0 && (
                <p>
                  {factoryCoverage?.quarantinedLogCount.toLocaleString()} undecodable factory{' '}
                  {factoryCoverage?.quarantinedLogCount === 1 ? 'log was' : 'logs were'} quarantined
                  from results.
                </p>
              )}
            </div>
          </div>
          {catalogCoverageHasWarnings && (
            <button
              type="button"
              onClick={() => void catalog.refetch()}
              disabled={catalog.isFetching}
              className="rounded-[8px] border border-hairline-strong bg-surface px-3 py-1.5 font-medium text-fg transition hover:bg-surface-2 disabled:cursor-wait disabled:opacity-50"
            >
              {catalog.isFetching ? 'Retrying…' : 'Retry now'}
            </button>
          )}
        </div>
      )}

      {catalog.isPending && <p className="sr-only" role="status">Loading markets…</p>}

      <section
        ref={resultsRef}
        tabIndex={-1}
        className="mt-5 scroll-mt-24 rounded-[16px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-4 focus-visible:ring-offset-bg"
        aria-label="Markets"
        aria-busy={catalog.isPending}
      >
        {catalog.isPending ? (
          <div aria-hidden className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 9 }, (_, index) => (
              <div key={index} className="h-[238px] animate-pulse rounded-[16px] border border-hairline bg-surface motion-reduce:animate-none">
                <div className="h-full rounded-[16px] bg-surface-2 opacity-40" />
              </div>
            ))}
          </div>
        ) : catalog.status === 'error' ? (
          <div role="alert" className="rounded-[16px] border border-hairline bg-surface px-6 py-12 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-lg text-danger" aria-hidden>
              !
            </div>
            <h2 className="mt-4 text-base font-semibold text-fg">Couldn't load the market directory</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-muted">{errorMessage(catalog.error)}</p>
            <button
              type="button"
              onClick={() => void catalog.refetch()}
              className="mt-5 rounded-[10px] bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:brightness-110"
            >
              Try again
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-[16px] border border-hairline bg-surface px-6 py-12 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[13px] border border-hairline bg-surface-2 text-accent-ink" aria-hidden>
              ◇
            </div>
            <h2 className="mt-4 text-base font-semibold text-fg">
              {markets.length === 0 ? 'No markets indexed yet' : 'No markets match these filters'}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              {markets.length === 0
                ? 'The directory is online, but its first catalog snapshot is still empty.'
                : communityClassificationUnavailable
                  ? 'Community classification is unavailable while Pendle listing enrichment is partial. Retry, or show all sources.'
                  : selectedNetworkMembershipIncomplete
                    ? `The factory scan for ${selectedNetwork?.name ?? 'this network'} is incomplete. An empty result does not prove that no matching community markets exist.`
                  : 'Try another network, lifecycle, or source, or search a different protocol or address.'}
            </p>
            {markets.length === 0 ? (
              <button
                type="button"
                onClick={() => void catalog.refetch()}
                className="mt-5 rounded-[10px] border border-hairline-strong px-4 py-2 text-sm font-medium text-fg hover:bg-surface-2"
              >
                Refresh catalog
              </button>
            ) : (
              <button
                type="button"
                onClick={clearFilters}
                className="mt-5 rounded-[10px] border border-hairline-strong px-4 py-2 text-sm font-medium text-fg hover:bg-surface-2"
              >
                Reset filters
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((market) => (
              <CatalogMarketCard
                key={`${market.chainId}:${market.address}`}
                market={market}
                listingCoverageComplete={pendleCoverageComplete}
                now={now}
              />
            ))}
          </div>
        )}
      </section>

      {catalog.status === 'success' && filtered.length > PAGE_SIZE && (
        <nav className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-5" aria-label="Market directory pages">
          <p className="text-xs text-faint">
            Page <span className="font-medium text-fg">{currentPage}</span> of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => showPage(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              className="rounded-[9px] border border-hairline bg-surface px-3 py-2 text-xs font-medium text-muted transition hover:border-hairline-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Previous
            </button>
            <button
              type="button"
              onClick={() => showPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
              className="rounded-[9px] border border-hairline bg-surface px-3 py-2 text-xs font-medium text-muted transition hover:border-hairline-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </nav>
      )}
    </div>
  )
}
