/**
 * SavedPoolCard — one remembered pool on the home screen (PLAN §3.3).
 * Label + short address + expiry from the localStorage display cache; live
 * quick stats (implied APY, TVL) come from the shared registry sweep — ONE
 * multicall for the whole grid (useRegistrySweep in Home), not a full
 * snapshot per card. A ticked "Remembered" checkbox unticks to forget.
 */

import { Link } from 'react-router-dom'
import type { QueryStatus, SavedPool } from '../lib/types'
import type { RegistrySweepEntry } from '../lib/market'
import { vintageFromFactory } from '../lib/market'
import { useRegistry } from '../lib/hooks'
import { clampLabel, formatCompact, formatDate, formatPercent, shortAddress } from './format'

function StatLine({
  pool,
  sweepStatus,
  stats,
}: {
  pool: SavedPool
  sweepStatus: QueryStatus
  stats?: RegistrySweepEntry
}) {
  if (sweepStatus === 'idle' || sweepStatus === 'loading') {
    return (
      <div className="flex items-center gap-3" aria-busy="true" aria-label="Loading pool stats">
        <span className="h-3.5 w-20 animate-pulse rounded bg-zinc-800" />
        <span className="h-3.5 w-24 animate-pulse rounded bg-zinc-800" />
      </div>
    )
  }

  // Whole sweep errored, or this market's reads failed inside the batch —
  // render '—' placeholders, never crash the card.
  if (sweepStatus === 'error' || !stats) {
    return <p className="text-xs text-zinc-500">live stats unavailable — open the pool to retry</p>
  }

  // Legacy is a provenance fact — key it off the validated factory's vintage
  // only (pools are only saveable when validated), never off probe failures.
  const vintage = vintageFromFactory(pool.factory)
  const isLegacy = vintage !== undefined && vintage !== 'active'
  const assetSymbol = pool.assetSymbol ? clampLabel(pool.assetSymbol) : 'asset'

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="text-zinc-400">
        APY{' '}
        <span className="font-medium text-emerald-400">
          {stats.isExpired ? '—' : formatPercent(stats.impliedApy, 2)}
        </span>
      </span>
      <span className="text-zinc-400">
        TVL{' '}
        <span className="font-medium text-zinc-200">
          {stats.tvlAsset !== undefined
            ? `${formatCompact(stats.tvlAsset)} ${assetSymbol}`
            : '—'}
        </span>
      </span>
      {isLegacy && <span className="text-amber-400/90">legacy — limited support</span>}
    </div>
  )
}

export function SavedPoolCard({
  pool,
  sweepStatus,
  stats,
}: {
  pool: SavedPool
  sweepStatus: QueryStatus
  stats?: RegistrySweepEntry
}) {
  const { forget } = useRegistry()
  const matured = stats ? stats.isExpired : pool.expiry * 1000 < Date.now()

  return (
    <div className="relative rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition hover:border-zinc-700">
      {/* Whole card click-through; the checkbox sits above the overlay. */}
      <Link
        to={`/market/${pool.market}`}
        className="absolute inset-0 rounded-xl"
        aria-label={`Open ${clampLabel(pool.label)}`}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-100">
            {clampLabel(pool.label)}
          </p>
          <p className="mt-0.5 font-mono text-xs text-zinc-500" title={pool.market}>
            {shortAddress(pool.market)}
          </p>
        </div>
        <label
          className="relative z-10 flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border border-emerald-900/70 bg-emerald-950/40 px-2 py-1 text-xs text-emerald-400"
          title="Untick to forget this pool"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked
            onChange={() => forget(pool.market)}
            className="h-3.5 w-3.5 accent-emerald-500"
          />
          Remembered
        </label>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
        <span>Expiry {formatDate(pool.expiry)}</span>
        {matured && (
          <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-zinc-300">
            Matured
          </span>
        )}
      </div>

      <div className="mt-3">
        <StatLine pool={pool} sweepStatus={sweepStatus} stats={stats} />
      </div>
    </div>
  )
}
