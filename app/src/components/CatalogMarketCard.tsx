import { Link } from 'react-router-dom'
import type { CatalogMarket } from '../lib/catalog'
import {
  catalogMarketDisplayTvl,
  currentCatalogMarketLifecycle,
} from '../lib/catalog'
import { supportedChain } from '../lib/addresses'
import { marketPath } from '../lib/routes'
import { clampLabel, formatCompact, formatDate, formatPercent, shortAddress } from './format'

function lifecycleLabel(market: CatalogMarket, now: number): 'Live' | 'Matured' | 'Unknown' {
  const lifecycle = currentCatalogMarketLifecycle(market, now)
  if (lifecycle === 'matured') return 'Matured'
  if (lifecycle === 'live') return 'Live'
  return 'Unknown'
}

export function CatalogMarketCard({
  market,
  listingCoverageComplete,
  now = Math.floor(Date.now() / 1000),
}: {
  market: CatalogMarket
  listingCoverageComplete: boolean
  now?: number
}) {
  const chain = supportedChain(market.chainId)
  const listed = market.sources.includes('pendle-listed')
  const factoryIndexed = market.sources.includes('factory-indexed')
  const community = factoryIndexed && !listed && listingCoverageComplete
  const listingLabel = listed
    ? market.pendleStatus === 'inactive'
      ? 'Pendle-listed · inactive'
      : 'Pendle-listed'
    : community
      ? 'Community / unlisted'
      : 'Listing unknown'
  const lifecycle = lifecycleLabel(market, now)
  const tvl = catalogMarketDisplayTvl(market, now)
  const metadataIncomplete =
    lifecycle === 'Unknown' || market.pt === null || market.yt === null || market.sy === null
  const marketName = clampLabel(market.name || 'Unnamed market', 160)
  const protocolName = clampLabel(market.protocol || 'Unknown protocol', 120)
  const chainName = clampLabel(chain?.name ?? `chain ${market.chainId}`, 64)

  return (
    <Link
      to={marketPath(market.address, market.chainId)}
      className="group relative flex min-h-[238px] flex-col overflow-hidden rounded-[16px] border border-hairline bg-surface p-4 text-fg no-underline transition duration-200 hover:-translate-y-0.5 hover:border-hairline-strong hover:shadow-[0_16px_40px_rgba(0,0,0,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transform-none motion-reduce:transition-none"
      aria-label={`Open ${marketName} on ${chainName}; ${listingLabel}; ${lifecycle === 'Unknown' ? 'lifecycle unknown' : lifecycle}`}
    >
      <div
        className="absolute inset-x-0 top-0 h-[3px] opacity-80 transition group-hover:opacity-100 motion-reduce:transition-none"
        style={{
          background: listed
            ? 'linear-gradient(90deg, var(--op-accent) 0 68%, var(--op-accent-strong) 68% 100%)'
            : community
              ? 'linear-gradient(90deg, var(--op-warn) 0 42%, var(--op-accent) 42% 100%)'
              : 'linear-gradient(90deg, var(--op-faint), var(--op-border-strong))',
        }}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-hairline bg-surface-2 text-[11px] font-bold tracking-wide text-accent-ink"
          >
            PT
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-fg" title={marketName}>
              {clampLabel(marketName, 56)}
            </h2>
            <p className="mt-0.5 truncate text-xs text-muted" title={protocolName}>
              {clampLabel(protocolName, 38)}
            </p>
          </div>
        </div>
        <span
          className="shrink-0 rounded-full border border-hairline-strong bg-surface-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
          title={chainName}
        >
          {chain?.shortName ?? `#${market.chainId}`}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <span
          className={
            listed
              ? 'rounded-full border border-[rgba(var(--op-accent-rgb),0.35)] bg-[rgba(var(--op-accent-rgb),0.09)] px-2 py-0.5 text-[10px] font-medium text-accent-ink'
              : community
                ? 'rounded-full border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-2 py-0.5 text-[10px] font-medium text-warn'
                : 'rounded-full border border-hairline-strong bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted'
          }
          title={
            listed && market.pendleStatus !== null
              ? `Pendle catalog status: ${market.pendleStatus}`
              : undefined
          }
        >
          {listingLabel}
        </span>
        <span
          className={
            lifecycle === 'Live'
              ? 'rounded-full border border-[rgba(var(--op-accent-rgb),0.28)] px-2 py-0.5 text-[10px] font-medium text-accent-ink'
              : lifecycle === 'Unknown'
                ? 'rounded-full border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-2 py-0.5 text-[10px] font-medium text-warn'
                : 'rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium text-faint'
          }
        >
          {lifecycle === 'Unknown' ? 'Lifecycle unknown' : lifecycle}
        </span>
        {metadataIncomplete && (
          <span
            className="rounded-full border border-hairline bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-faint"
            title="Some optional token or lifecycle metadata could not be hydrated. Open the market for live checks."
          >
            Metadata incomplete
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 border-y border-hairline py-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.08em] text-faint">TVL</p>
          <p
            className="mt-1 truncate text-sm font-semibold tabular-nums text-fg"
            title={
              lifecycle === 'Matured'
                ? 'Expired-market USD valuations are not shown because they can be stale.'
                : undefined
            }
          >
            {tvl === null ? '—' : `$${formatCompact(tvl)}`}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.08em] text-faint">Implied APY</p>
          <p className="mt-1 truncate text-sm font-semibold tabular-nums text-accent-ink">
            {market.impliedApy === null || lifecycle === 'Matured'
              ? '—'
              : formatPercent(market.impliedApy, 2)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.08em] text-faint">Maturity</p>
          <p className="mt-1 truncate text-xs font-medium text-fg">
            {market.expiry === null ? '—' : formatDate(market.expiry)}
          </p>
        </div>
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 pt-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.08em] text-faint">Market</p>
          <p className="mt-0.5 font-mono text-xs text-muted" title={market.address}>
            {shortAddress(market.address)}
          </p>
        </div>
        <span className="shrink-0 text-xs font-semibold text-accent-ink transition group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none">
          Open market →
        </span>
      </div>
    </Link>
  )
}
