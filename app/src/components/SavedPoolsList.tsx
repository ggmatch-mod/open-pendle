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

import { SUPPORTED_CHAINS, supportedChain } from '../lib/addresses'
import { sweepKey } from '../lib/market'
import type { RegistrySweepResult } from '../lib/market'
import type { QueryStatus, SavedPool, SupportedChainId } from '../lib/types'
import { SavedPoolCard } from './SavedPoolCard'

/** The slice of a useRegistrySweep() result these views need. */
export type SweepView = { status: QueryStatus; stats: RegistrySweepResult }

/** Group saved pools by their own chainId, active chain first, then SUPPORTED_CHAINS order. */
export function groupPoolsByChain(
  pools: SavedPool[],
  activeChainId: SupportedChainId,
): { chainId: SupportedChainId; pools: SavedPool[] }[] {
  const byChain = new Map<SupportedChainId, SavedPool[]>()
  for (const p of pools) {
    const arr = byChain.get(p.chainId)
    if (arr) arr.push(p)
    else byChain.set(p.chainId, [p])
  }
  // Order: active chain first, then the SUPPORTED_CHAINS display order.
  const order = [
    activeChainId,
    ...SUPPORTED_CHAINS.map((c) => c.id).filter((id) => id !== activeChainId),
  ]
  return order
    .filter((id) => byChain.has(id))
    .map((chainId) => ({
      chainId,
      pools: (byChain.get(chainId) ?? []).sort((a, b) => b.savedAt - a.savedAt),
    }))
}

/** Most-recently-saved first, across all chains (for the Home preview slice). */
export function poolsByRecency(pools: SavedPool[]): SavedPool[] {
  return [...pools].sort((a, b) => b.savedAt - a.savedAt)
}

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
                className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                aria-hidden="true"
              />
              <h3 className="text-sm font-medium text-zinc-300">
                {chain?.name ?? `Chain ${chainId}`}
              </h3>
              <span className="text-xs text-zinc-600">
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
    <section className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-6">
      <h2 className="text-base font-semibold text-zinc-100">No remembered pools yet</h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        The paste box on the home page is the way in — OpenPendle has no listing
        page by design. Load a market by address, tick{' '}
        <span className="text-emerald-400">Remember this pool</span> on its page,
        and it will live here (stored locally in your browser, nowhere else).
      </p>
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        <span className="text-zinc-200">Where do I find a market address?</span>{' '}
        Community pool creators share their market (PLP) address — in Discord, on
        X, or as a block-explorer link. It's the address of the{' '}
        <span className="font-mono text-xs">PendleMarket</span> contract itself,
        not the PT, YT or SY. If you paste a PT, YT or SY we'll tell you which it
        is, so you can ask the pool creator for the market address.
      </p>
    </section>
  )
}
