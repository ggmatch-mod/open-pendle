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
    <section className="rounded-xl border border-dashed border-hairline bg-surface p-6">
      <h2 className="text-base font-semibold text-fg">No remembered pools yet</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        The paste box on the home page is the way in — OpenPendle has no listing
        page by design. Load a market by address, tick{' '}
        <span className="text-accent-ink">Remember this pool</span> on its page,
        and it will live here (stored locally in your browser, nowhere else).
      </p>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        <span className="text-fg">Where do I find a market address?</span>{' '}
        Community pool creators share their market (PLP) address — in Discord, on
        X, or as a block-explorer link. It's the address of the{' '}
        <span className="font-mono text-xs">PendleMarket</span> contract itself,
        not the PT, YT or SY. If you paste a PT, YT or SY we'll tell you which it
        is, so you can ask the pool creator for the market address.
      </p>
    </section>
  )
}
