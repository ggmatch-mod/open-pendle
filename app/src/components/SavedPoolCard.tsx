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
import { useActiveChain } from '../lib/hooks'
import { useForgetWithUndo } from './ForgetUndo'
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
        <span className="h-3.5 w-20 animate-pulse rounded bg-surface-2" />
        <span className="h-3.5 w-24 animate-pulse rounded bg-surface-2" />
      </div>
    )
  }

  // Whole sweep errored, or this market's reads failed inside the batch —
  // render '—' placeholders, never crash the card.
  if (sweepStatus === 'error' || !stats) {
    return <p className="text-xs text-faint">live stats unavailable — open the pool to retry</p>
  }

  // Legacy is a provenance fact — key it off the validated factory's vintage
  // only (pools are only saveable when validated), never off probe failures.
  const vintage = vintageFromFactory(pool.factory)
  const isLegacy = vintage !== undefined && vintage !== 'active'
  const assetSymbol = pool.assetSymbol ? clampLabel(pool.assetSymbol) : 'asset'

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="text-muted">
        APY{' '}
        <span className="font-medium text-accent-ink">
          {stats.isExpired ? '—' : formatPercent(stats.impliedApy, 2)}
        </span>
      </span>
      <span className="text-muted">
        TVL{' '}
        <span className="font-medium text-fg">
          {stats.tvlAsset !== undefined
            ? `${formatCompact(stats.tvlAsset)} ${assetSymbol}`
            : '—'}
        </span>
      </span>
      {isLegacy && <span className="text-warn">legacy — limited support</span>}
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
  // Forgetting goes through the app-level undo toast; pass the card's own
  // chainId since it may belong to a non-active chain.
  const forgetWithUndo = useForgetWithUndo()
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
    <div className="relative overflow-hidden rounded-[16px] border border-hairline bg-surface p-4 transition hover:-translate-y-0.5 hover:border-hairline-strong">
      <div
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: 'linear-gradient(90deg, var(--op-accent) 0 60%, var(--op-accent-strong) 60% 100%)' }}
      />
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
            <p className="truncate text-sm font-semibold text-fg">
              {clampLabel(pool.label)}
            </p>
            <span
              className="relative z-10 shrink-0 rounded-full border border-hairline-strong bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
              title={`On ${chainName}`}
            >
              {chainShort}
            </span>
          </div>
          <p className="mt-0.5 font-mono text-xs text-faint" title={pool.market}>
            {shortAddress(pool.market)}
          </p>
        </div>
        <button
          type="button"
          title="Click to forget this pool"
          onClick={(e) => {
            e.stopPropagation()
            forgetWithUndo(pool.chainId, pool.market)
          }}
          className="relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] px-2.5 py-1 text-xs font-medium text-accent-ink"
        >
          <span className="inline-flex h-[14px] w-[14px] items-center justify-center rounded-sm bg-accent text-accent-fg">
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 6.5 5 9l4.5-5.5" />
            </svg>
          </span>
          Remembered
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        <span>Expiry {formatDate(pool.expiry)}</span>
        {matured && (
          <span className="rounded-full border border-hairline-strong bg-surface-2 px-2 py-0.5 text-muted">
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
          className="relative z-10 mt-3 inline-flex items-center gap-1.5 rounded-md border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] px-2.5 py-1 text-xs font-medium text-accent-ink hover:border-[rgba(var(--op-accent-rgb),0.4)] hover:text-accent-ink"
        >
          Switch to {chainName} to open →
        </button>
      )}
    </div>
  )
}
