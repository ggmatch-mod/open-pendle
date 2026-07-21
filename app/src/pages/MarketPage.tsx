/**
 * MarketPage — /market/:address. Loads a full market snapshot via
 * useMarketSnapshot: header (name, vintage, matured badge, remember toggle),
 * then a two-column body at lg: (left: overview grid, trust panel, positions,
 * token strip; right: sticky actions card). Below lg the actions card sits
 * directly after the stat grid. Validated live markets get ActionTabs;
 * validated expired markets the M5 MaturedPanel; unvalidated markets a
 * disabled placeholder. Legacy probe failures render the DegradedBanner
 * instead of failing the page (PLAN M1).
 */

import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getAddress, isAddress } from 'viem'
import type { Address } from 'viem'
import type { MarketSnapshot, Vintage } from '../lib/types'
import { useActiveChain, useMarketSnapshot, usePositions } from '../lib/hooks'
import { refreshPoolCache } from '../lib/registry'
import { ActionTabs } from '../components/ActionTabs'
import { AddressChip } from '../components/AddressChip'
import { DegradedBanner } from '../components/DegradedBanner'
import { clampLabel } from '../components/format'
import { MaturedPanel } from '../components/MaturedPanel'
import { OverviewGrid } from '../components/OverviewGrid'
import { PositionsCard } from '../components/PositionsCard'
import { RememberToggle } from '../components/RememberToggle'
import { TrustPanel } from '../components/TrustPanel'
import { useDocumentTitle } from '../components/useDocumentTitle'

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Badge for abnormal provenance only — the normal (active, validated) case renders nothing. */
function VintageBadge({ vintage, validated }: { vintage: Vintage; validated: boolean }) {
  if (!validated || vintage === 'unvalidated') {
    return (
      <span
        title="Not recognized by any Pendle factory"
        className="rounded-full border border-[var(--op-danger-bd)] bg-red-950/70 px-2.5 py-0.5 text-xs font-semibold text-danger"
      >
        Not validated
      </span>
    )
  }
  if (vintage === 'active') return null
  return (
    <span
      title={`Older Pendle factory (${vintage})`}
      className="rounded-full border border-hairline-strong bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-muted"
    >
      Legacy {vintage}
    </span>
  )
}

/**
 * Prominent red banner for markets NO known Pendle factory validates
 * (PLAN §3.4 — deep links share the same gate as the paste box). Rendered
 * above the metrics; the amber DegradedBanner suppresses itself in this state.
 */
function UnvalidatedBanner() {
  return (
    <div role="alert" className="rounded-xl border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-4">
      <p className="text-sm font-semibold text-danger">
        Not validated by any Pendle factory
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-red-200/80">
        No Pendle factory recognizes this address — it may be fake. The numbers
        below come from the contract itself and can't be trusted. Transactions
        are disabled.
      </p>
    </div>
  )
}

function MaturedBadge() {
  return (
    <span className="rounded-full border border-hairline-strong bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-muted">
      Matured
    </span>
  )
}

/**
 * Kept for UNVALIDATED (non-expired) markets only — the red-state page never
 * offers transaction UI (PLAN §3.4). Validated live markets get ActionTabs.
 */
function ActionsPlaceholder() {
  return (
    <section aria-disabled="true" className="rounded-xl border border-hairline bg-surface p-5">
      <h2 className="text-base font-semibold text-fg">Actions</h2>
      <p className="mt-2 text-sm text-faint">Disabled for unvalidated markets.</p>
    </section>
  )
}

function TokenStrip({ snapshot }: { snapshot: MarketSnapshot }) {
  const tokens: Array<{ role: string; symbol: string; address: Address }> = [
    { role: 'PT', symbol: snapshot.ptSymbol, address: snapshot.pt },
    { role: 'YT', symbol: snapshot.ytSymbol, address: snapshot.yt },
    { role: 'SY', symbol: snapshot.sy.symbol, address: snapshot.sy.address },
  ]
  return (
    <section className="rounded-xl border border-hairline bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
        {tokens.map((t) => (
          <div key={t.role} className="flex items-center gap-2">
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-semibold text-muted">
              {t.role}
            </span>
            <span className="text-sm text-fg">{t.symbol ? clampLabel(t.symbol) : '—'}</span>
            <AddressChip address={t.address} />
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Load states
// ---------------------------------------------------------------------------

function PageSkeleton() {
  return (
    <div className="space-y-5 pb-16 pt-8 sm:pt-10" aria-busy="true" aria-label="Loading market">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2.5">
          <div className="h-6 w-64 max-w-[60vw] animate-pulse rounded bg-surface-2" />
          <div className="h-3.5 w-40 animate-pulse rounded bg-surface-2" />
        </div>
        <div className="h-10 w-44 animate-pulse rounded-xl bg-surface-2" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-surface" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-xl bg-surface" />
    </div>
  )
}

function BadAddress({ raw }: { raw: string }) {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold text-fg">Not a valid address</h1>
      <p className="mx-auto mt-2 max-w-md break-all text-sm text-muted">
        <span className="font-mono text-xs text-faint">{raw || '(empty)'}</span>{' '}
        isn't a valid Ethereum address.
      </p>
      <Link
        to="/"
        className="mt-6 inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:brightness-110"
      >
        ← Back home
      </Link>
    </div>
  )
}

function LoadError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="rounded-xl border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-5 text-center">
        <h1 className="text-base font-semibold text-danger">Couldn't load this market</h1>
        <p className="mt-2 text-sm text-red-200/80">
          {message ||
            'The RPC read failed — public endpoints rate-limit. Retrying usually fixes it, or set a custom RPC in settings.'}
        </p>
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            onClick={onRetry}
            className="rounded-md border border-[var(--op-danger-bd)] px-4 py-1.5 text-sm text-danger hover:bg-[var(--op-danger-soft)]"
          >
            Retry
          </button>
          <Link to="/" className="text-sm text-muted hover:text-fg">
            ← Back home
          </Link>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function MarketView({ address }: { address: Address }) {
  const { status, snapshot, error, refetch } = useMarketSnapshot(address)
  // M2: positions load once the snapshot exists AND a wallet is connected
  // (hook contract: undefined snapshot / no wallet → 'idle').
  const {
    status: positionsStatus,
    positions,
    error: positionsError,
    refetch: refetchPositions,
  } = usePositions(snapshot)

  const { chainId } = useActiveChain()
  // Self-heal the saved-pool display cache from the fresh snapshot, so a card in
  // "Your pools" can never show a caption that's drifted from the live market.
  // No-op unless this pool is saved and something actually changed.
  useEffect(() => {
    if (snapshot?.validated) refreshPoolCache(chainId, snapshot)
  }, [chainId, snapshot])

  useDocumentTitle(snapshot?.displayName)

  if (status === 'error') return <LoadError message={error} onRetry={refetch} />
  // 'idle' with a defined address means the query hasn't kicked off yet —
  // render the same skeleton rather than a flash of nothing.
  if (status === 'idle' || status === 'loading' || !snapshot) return <PageSkeleton />

  return (
    <div className="space-y-5 pb-16 pt-8 sm:pt-10">
      <Link to="/" className="inline-block text-[13px] font-medium text-muted hover:text-fg">
        ← Home
      </Link>

      {!snapshot.validated && <UnvalidatedBanner />}
      <DegradedBanner
        degraded={snapshot.degraded}
        validated={snapshot.validated}
        vintage={snapshot.vintage}
      />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="min-w-0 max-w-full break-words text-[26px] font-bold tracking-tight text-fg sm:text-[30px]">
              {clampLabel(snapshot.displayName)}
            </h1>
            <VintageBadge vintage={snapshot.vintage} validated={snapshot.validated} />
            {snapshot.isExpired && <MaturedBadge />}
          </div>
          <div className="mt-1.5">
            <AddressChip address={snapshot.address} />
          </div>
        </div>
        <RememberToggle snapshot={snapshot} />
      </header>

      {/* Two-column at lg: (left: stats, trust, positions, tokens; right: sticky
          actions). Below lg the wrapper dissolves (display: contents) and the
          order-* utilities put Actions directly after the stat grid. */}
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="contents lg:flex lg:min-w-0 lg:flex-1 lg:flex-col lg:gap-5">
          <div className="order-1">
            <OverviewGrid snapshot={snapshot} />
          </div>

          <div className="order-3">
            <TrustPanel
              market={snapshot.address}
              sy={snapshot.sy.address}
              trust={snapshot.trust}
            />
          </div>

          {/* PositionsCard whenever the market is validated and a wallet is
              connected (the card gates on connection itself — claims stay valid
              on expired markets). */}
          {snapshot.validated && (
            <div className="order-4">
              <PositionsCard
                snapshot={snapshot}
                positions={positions}
                status={positionsStatus}
                error={positionsError}
                refetch={refetchPositions}
              />
            </div>
          )}

          <div className="order-5">
            <TokenStrip snapshot={snapshot} />
          </div>
        </div>

        <div className="order-2 lg:sticky lg:top-20 lg:w-[420px] lg:shrink-0">
          {/* Actions area: live tabs on validated non-expired markets; the M5
              MaturedPanel (redeem PT / exit LP) on validated expired ones.
              Unvalidated keeps the no-tx state, expired or not. */}
          {snapshot.validated && snapshot.isExpired ? (
            <MaturedPanel
              snapshot={snapshot}
              positions={positions}
              refetchPositions={refetchPositions}
            />
          ) : snapshot.validated ? (
            <ActionTabs
              snapshot={snapshot}
              positions={positions}
              refetchPositions={refetchPositions}
            />
          ) : (
            <ActionsPlaceholder />
          )}
        </div>
      </div>
    </div>
  )
}

export default function MarketPage() {
  const { address: raw = '' } = useParams()

  if (!isAddress(raw.trim(), { strict: false })) {
    return <BadAddress raw={raw} />
  }

  return <MarketView address={getAddress(raw.trim())} />
}
