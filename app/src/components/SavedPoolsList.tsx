/**
 * Shared rendering for the remembered-pools registry, used in two places:
 *  - the Home landing preview (a short flat grid, capped to a couple of cards)
 *  - the dedicated /pools page (the full view, grouped + badged by network)
 *
 * Both consumers own their own useRegistry + useRegistrySweep so each sweeps
 * exactly the pools it renders (the preview sweeps only the 2 it shows). The
 * grouping (active chain first, then SUPPORTED_CHAINS order) lives here so the
 * two views stay in sync (PLAN §3.3, M8 cross-chain registry).
 */

import { Link } from 'react-router-dom'
import { supportedChain } from '../lib/addresses'
import { sweepKey } from '../lib/market'
import type { RegistrySweepResult } from '../lib/market'
import type { QueryStatus, SavedPool, SupportedChainId } from '../lib/types'
import { SavedPoolCard } from './SavedPoolCard'
import { groupPoolsByChain } from './savedPools'

/** The slice of a useRegistrySweep() result these views need. */
export type SweepView = { status: QueryStatus; stats: RegistrySweepResult }

/**
 * Flat grid, no chain-group headers — each card badges its own chain. Used by
 * the Home preview where only a couple of cards show and grouping would be noise.
 */
export function SavedPoolGrid({ pools, sweep }: { pools: SavedPool[]; sweep: SweepView }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {pools.map((pool) => (
        <SavedPoolCard
          key={`${pool.chainId}:${pool.market}`}
          pool={pool}
          sweepStatus={sweep.status}
          stats={sweep.stats[sweepKey(pool.chainId, pool.market)]}
        />
      ))}
    </div>
  )
}

/** Full view: cards grouped under a per-network header (used on /pools). */
export function SavedPoolGroups({
  pools,
  activeChainId,
  sweep,
}: {
  pools: SavedPool[]
  activeChainId: SupportedChainId
  sweep: SweepView
}) {
  const groups = groupPoolsByChain(pools, activeChainId)
  return (
    <div className="space-y-5">
      {groups.map(({ chainId, pools: chainPools }) => {
        const chain = supportedChain(chainId)
        const isActive = chainId === activeChainId
        return (
          <div key={chainId}>
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-accent' : 'bg-[var(--op-faint)]'}`}
                aria-hidden="true"
              />
              <h3 className="text-sm font-medium text-muted">
                {chain?.name ?? `Chain ${chainId}`}
              </h3>
              <span className="text-xs text-faint">
                {chainPools.length} pool{chainPools.length === 1 ? '' : 's'}
                {isActive ? ' · active' : ''}
              </span>
            </div>
            <SavedPoolGrid pools={chainPools} sweep={sweep} />
          </div>
        )
      })}
    </div>
  )
}

/** First-visit / nothing-remembered explainer, shared by both views. */
export function RegistryEmptyState() {
  return (
    <section className="rounded-xl border border-dashed border-hairline bg-surface p-6 text-center">
      <h2 className="text-base font-semibold text-fg">No saved pools yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
        Find a market, open it, and tick "Remember this pool".
      </p>
      <Link
        to="/explore"
        className="mt-4 inline-block rounded-[10px] bg-accent px-4 py-2 text-sm font-semibold text-accent-fg no-underline hover:brightness-110"
      >
        Explore markets →
      </Link>
      <details className="mx-auto mt-4 max-w-lg text-left">
        <summary className="cursor-pointer text-xs font-medium text-muted hover:text-fg">
          Where do I find a market address?
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Pool creators share their market (PLP) address — the{' '}
          <span className="font-mono">PendleMarket</span> contract itself, not the PT, YT or SY.
          If you only have a PT or YT, paste it on the home page and follow its pool link. An SY
          can back several maturities, so it can't identify one market.
        </p>
      </details>
    </section>
  )
}
