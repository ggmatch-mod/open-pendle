/**
 * MarketPage — /market/:address. Loads a full market snapshot via
 * useMarketSnapshot: header (name, vintage, matured badge, remember toggle),
 * overview grid, trust panel, disabled action placeholders (or MaturedNotice
 * post-expiry), and the PT/YT/SY token strip. Legacy probe failures render
 * the DegradedBanner instead of failing the page (PLAN M1).
 */

import { Link, useParams } from 'react-router-dom'
import { getAddress, isAddress } from 'viem'
import type { Address } from 'viem'
import type { MarketSnapshot, Vintage } from '../lib/types'
import { useMarketSnapshot } from '../lib/hooks'
import { AddressChip } from '../components/AddressChip'
import { DegradedBanner } from '../components/DegradedBanner'
import { clampLabel } from '../components/format'
import { MaturedNotice } from '../components/MaturedNotice'
import { OverviewGrid } from '../components/OverviewGrid'
import { RememberToggle } from '../components/RememberToggle'
import { TrustPanel } from '../components/TrustPanel'
import { useDocumentTitle } from '../components/useDocumentTitle'

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function VintageBadge({ vintage, validated }: { vintage: Vintage; validated: boolean }) {
  if (!validated || vintage === 'unvalidated') {
    return (
      <span
        title="No known Pendle factory recognizes this address — possibly fake, or a newer factory generation than this build knows"
        className="rounded-full border border-red-800 bg-red-950/70 px-2.5 py-0.5 text-xs font-semibold text-red-400"
      >
        not validated
      </span>
    )
  }
  const isActive = vintage === 'active'
  return (
    <span
      title={
        isActive
          ? 'Created through the active factory generation'
          : `Legacy factory generation (${vintage}) — loads best-effort`
      }
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        isActive
          ? 'border-emerald-900 bg-emerald-950/60 text-emerald-400'
          : 'border-zinc-700 bg-zinc-800/80 text-zinc-400'
      }`}
    >
      {isActive ? 'active gen' : `legacy ${vintage}`}
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
    <div role="alert" className="rounded-xl border border-red-800 bg-red-950/50 p-4">
      <p className="text-sm font-semibold text-red-300">
        Not validated by any Pendle factory
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-red-200/80">
        No known Pendle factory recognizes this address. It may be a fake
        market built to look real, or a newer factory generation than this
        build knows about. Nothing shown on this page can be trusted — the
        numbers below come from the contract itself and may be fabricated. Do
        not interact with it unless you fully trust whoever gave you this
        address. If Pendle has shipped a new factory generation, check for an
        updated OpenPendle build.
      </p>
    </div>
  )
}

function MaturedBadge() {
  return (
    <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
      Matured
    </span>
  )
}

function ActionsPlaceholder() {
  const tabs = [
    { label: 'Mint / Redeem', arrives: 'arrives in M2' },
    { label: 'Trade PT & YT', arrives: 'arrives in M3' },
    { label: 'Liquidity', arrives: 'arrives in M4' },
  ]
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="text-base font-semibold text-zinc-100">Actions</h2>
      <p className="mt-1 text-xs text-zinc-500">
        M1 is read-only on purpose — transaction flows land milestone by milestone.
      </p>
      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        {tabs.map((tab) => (
          <div
            key={tab.label}
            aria-disabled="true"
            className="cursor-not-allowed rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3.5 text-center"
          >
            <p className="text-sm font-medium text-zinc-500">{tab.label}</p>
            <p className="mt-0.5 text-xs text-zinc-600">{tab.arrives}</p>
          </div>
        ))}
      </div>
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
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
        {tokens.map((t) => (
          <div key={t.role} className="flex items-center gap-2">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-semibold text-zinc-400">
              {t.role}
            </span>
            <span className="text-sm text-zinc-200">{t.symbol ? clampLabel(t.symbol) : '—'}</span>
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
    <div className="space-y-5 py-8" aria-busy="true" aria-label="Loading market">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2.5">
          <div className="h-6 w-64 max-w-[60vw] animate-pulse rounded bg-zinc-800" />
          <div className="h-3.5 w-40 animate-pulse rounded bg-zinc-800" />
        </div>
        <div className="h-10 w-44 animate-pulse rounded-xl bg-zinc-800" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-zinc-900" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-xl bg-zinc-900" />
    </div>
  )
}

function BadAddress({ raw }: { raw: string }) {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold text-zinc-100">Not a valid address</h1>
      <p className="mx-auto mt-2 max-w-md break-all text-sm text-zinc-400">
        <span className="font-mono text-xs text-zinc-500">{raw || '(empty)'}</span>{' '}
        isn't a valid Ethereum address, so there's no market to load.
      </p>
      <Link
        to="/"
        className="mt-6 inline-block rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
      >
        ← Back home
      </Link>
    </div>
  )
}

function LoadError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="rounded-xl border border-red-900/60 bg-red-950/40 p-5 text-center">
        <h1 className="text-base font-semibold text-red-300">Couldn't load this market</h1>
        <p className="mt-2 text-sm text-red-200/80">
          {message ||
            'The RPC read failed — public endpoints rate-limit. Retrying usually fixes it, or set a custom RPC in settings.'}
        </p>
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            onClick={onRetry}
            className="rounded-md border border-red-800 px-4 py-1.5 text-sm text-red-300 hover:bg-red-900/40"
          >
            Retry
          </button>
          <Link to="/" className="text-sm text-zinc-400 hover:text-zinc-200">
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

  useDocumentTitle(snapshot?.displayName)

  if (status === 'error') return <LoadError message={error} onRetry={refetch} />
  // 'idle' with a defined address means the query hasn't kicked off yet —
  // render the same skeleton rather than a flash of nothing.
  if (status === 'idle' || status === 'loading' || !snapshot) return <PageSkeleton />

  return (
    <div className="space-y-5 py-8">
      <Link to="/" className="inline-block text-sm text-zinc-400 hover:text-zinc-200">
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
            <h1 className="min-w-0 max-w-full break-words text-xl font-bold tracking-tight text-zinc-100 sm:text-2xl">
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

      <OverviewGrid snapshot={snapshot} />

      <TrustPanel
        market={snapshot.address}
        sy={snapshot.sy.address}
        trust={snapshot.trust}
      />

      {snapshot.isExpired ? <MaturedNotice /> : <ActionsPlaceholder />}

      <TokenStrip snapshot={snapshot} />
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
