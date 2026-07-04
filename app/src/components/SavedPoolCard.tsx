/**
 * SavedPoolCard — one remembered pool on the home screen (PLAN §3.3, M8
 * cross-chain). Label + short address + expiry from the localStorage display
 * cache; live quick stats (implied APY, TVL) come from the shared registry
 * sweep — ONE multicall PER CHAIN for the whole grid (useRegistrySweep in
 * Home), not a full snapshot per card.
 *
 * M8: pools span networks. Each card shows a small chain badge
 * (supportedChain(pool.chainId).shortName). A card on the ACTIVE chain opens
 * directly (a market only loads on the active chain). A card on a DIFFERENT
 * chain can't be opened as-is — it offers a one-click "Switch to <chain>"
 * (setChainId, then navigate to it) so the market loads on its own network.
 * Forget is chain-explicit: forgetOn(pool.chainId, pool.market).
 */

import { useNavigate } from 'react-router-dom'
import type { QueryStatus, SavedPool } from '../lib/types'
import type { RegistrySweepEntry } from '../lib/market'
import { vintageFromFactory } from '../lib/market'
import { supportedChain } from '../lib/addresses'
import { useActiveChain, useRegistry } from '../lib/hooks'
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
  const navigate = useNavigate()
  const { chainId: activeChainId, setChainId } = useActiveChain()
  // Chain-explicit forget: a card may belong to a non-active chain.
  const { forgetOn } = useRegistry()
  const matured = stats ? stats.isExpired : pool.expiry * 1000 < Date.now()

  const poolChain = supportedChain(pool.chainId)
  const chainShort = poolChain?.shortName ?? `#${pool.chainId}`
  const chainName = poolChain?.name ?? `chain ${pool.chainId}`
  const onActiveChain = pool.chainId === activeChainId

  // Opening a market loads it on the ACTIVE chain, so a cross-chain card must
  // first switch the active chain, then navigate to the market on its own chain.
  const open = () => {
    if (!onActiveChain) setChainId(pool.chainId)
    navigate(`/market/${pool.market}`)
  }

  return (
    <div className="relative rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition hover:border-zinc-700">
      {/* Whole card is click-through; the checkbox + explicit buttons sit above it. */}
      <button
        type="button"
        onClick={open}
        className="absolute inset-0 rounded-xl"
        aria-label={
          onActiveChain
            ? `Open ${clampLabel(pool.label)}`
            : `Switch to ${chainName} and open ${clampLabel(pool.label)}`
        }
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-zinc-100">
              {clampLabel(pool.label)}
            </p>
            <span
              className="relative z-10 shrink-0 rounded-full border border-zinc-700 bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-300"
              title={`On ${chainName}`}
            >
              {chainShort}
            </span>
          </div>
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
            onChange={() => forgetOn(pool.chainId, pool.market)}
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

      {!onActiveChain && (
        <button
          type="button"
          onClick={open}
          className="relative z-10 mt-3 inline-flex items-center gap-1.5 rounded-md border border-emerald-800 bg-emerald-950/40 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:border-emerald-600 hover:text-emerald-200"
        >
          Switch to {chainName} to open →
        </button>
      )}
    </div>
  )
}
