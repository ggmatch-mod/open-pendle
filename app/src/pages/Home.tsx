/**
 * Home — paste-an-address front and center (PLAN M1 first-visit state), the
 * remembered-pools registry grid, a static starter list of active community
 * pools, and the protocol status card collapsed at the bottom.
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getAddress, isAddress } from 'viem'
import { useActiveChain, useClassifyAddress, useRegistry, useRegistrySweep } from '../lib/hooks'
import {
  poolsByRecency,
  RegistryEmptyState,
  SavedPoolGrid,
} from '../components/SavedPoolsList'
import { MarketAnatomyCard } from '../components/MarketAnatomyCard'
import { SectionHeader } from '../components/SectionHeader'
import { clampLabel, formatDate, shortAddress } from '../components/format'
import { loadStarterList, type StarterList } from '../components/starterList'
import { useDocumentTitle } from '../components/useDocumentTitle'

// ---------------------------------------------------------------------------
// Paste box — wired to the on-chain classifier
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-hairline-strong border-t-accent align-[-2px]"
    />
  )
}

function ClassificationFeedback({
  status,
  input,
}: {
  status: ReturnType<typeof useClassifyAddress>
  input: string
}) {
  const navigate = useNavigate()
  const { chain } = useActiveChain()

  if (input.length === 0 || status.status === 'idle') {
    return (
      <p className="text-sm text-faint">
        Paste any Pendle V2 market (PLP) address on {chain.name} — it loads
        straight from the chain.
      </p>
    )
  }

  if (status.status === 'loading') {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> checking address on-chain…
      </p>
    )
  }

  if (status.status === 'error') {
    return (
      <p className="text-sm text-danger">
        Couldn't check that address — the RPC may be rate-limiting.{' '}
        {status.error ? <span className="text-danger">({status.error})</span> : null}
      </p>
    )
  }

  const c = status.classification
  if (!c) return null

  switch (c.kind) {
    case 'invalid':
      return (
        <p className="text-sm text-danger">
          {c.message || 'That is not a valid address (0x + 40 hex characters).'}
        </p>
      )
    case 'eoa':
      return (
        <p className="text-sm text-danger">
          {c.message || "That's a wallet address, not a contract."}
        </p>
      )
    case 'pt':
    case 'yt':
      return (
        <div className="mx-auto max-w-lg rounded-lg border border-hairline-strong bg-surface p-3 text-left">
          <p className="text-sm text-fg">
            {c.message}
            {c.symbol && !c.message.includes(c.symbol) && (
              <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
                {clampLabel(c.symbol)}
              </span>
            )}
          </p>
          <button
            onClick={() => navigate(`/token/${getAddress(input)}`)}
            className="mt-2.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
          >
            View &amp; act on this token →
          </button>
        </div>
      )
    case 'sy':
      return (
        <div className="mx-auto max-w-lg rounded-lg border border-hairline-strong bg-surface p-3 text-left">
          <p className="text-sm text-fg">
            {c.message}
            {c.symbol && !c.message.includes(c.symbol) && (
              <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
                {clampLabel(c.symbol)}
              </span>
            )}
          </p>
        </div>
      )
    case 'contract':
      if (c.unvalidatedMarketShape) {
        return (
          <div className="mx-auto max-w-lg rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] p-3 text-left">
            <p className="text-sm text-warn">{c.message}</p>
          </div>
        )
      }
      return <p className="text-sm text-danger">{c.message}</p>
    case 'market':
      return (
        <p className="flex items-center justify-center gap-2 text-sm text-accent-ink">
          <Spinner /> Valid Pendle market — opening…
        </p>
      )
  }
}

function MarketPasteBox() {
  const [input, setInput] = useState('')
  const navigate = useNavigate()
  const trimmed = input.trim()
  const classify = useClassifyAddress(trimmed)
  const { classification } = classify

  // Auto-open validated markets.
  useEffect(() => {
    if (
      classification?.kind === 'market' &&
      isAddress(trimmed, { strict: false })
    ) {
      navigate(`/market/${getAddress(trimmed)}`)
    }
  }, [classification, trimmed, navigate])

  return (
    <div className="w-full">
      <label htmlFor="market-address" className="sr-only">
        Market address
      </label>
      <input
        id="market-address"
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Paste a Pendle market (PLP) address — 0x…"
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded-[15px] border border-hairline-strong bg-surface px-4 py-3.5 font-mono text-sm text-fg placeholder-[color:var(--op-faint)] outline-none transition focus:border-accent focus:ring-2 focus:ring-[rgba(var(--op-accent-rgb),0.2)]"
      />
      <div aria-live="polite" className="mt-2.5 min-h-5">
        <ClassificationFeedback status={classify} input={trimmed} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Saved pools (registry) — landing preview: the most recent couple of pools,
// with a link to the dedicated /pools tab for the full grouped list. Keeping
// the whole registry off the landing page avoids clutter (user request).
// ---------------------------------------------------------------------------

/** How many remembered pools the landing page previews before the "See all" link. */
const PREVIEW_COUNT = 2

function SavedPoolsPreview() {
  const { pools } = useRegistry()
  // Preview the most-recently-saved pools across all chains.
  const preview = poolsByRecency(pools).slice(0, PREVIEW_COUNT)
  // Sweep only what we render here — the /pools tab sweeps the full set.
  const sweep = useRegistrySweep(preview)
  const hidden = pools.length - preview.length

  return (
    <section>
      <SectionHeader
        index="01"
        title="Your pools"
        meta={pools.length > 0 ? `${pools.length} remembered · local` : undefined}
      />
      {pools.length === 0 ? (
        <RegistryEmptyState />
      ) : (
        <>
          <SavedPoolGrid pools={preview} sweep={sweep} />
          <div className="mt-4 text-sm">
            <Link
              to="/pools"
              className="font-medium text-accent-ink hover:text-accent-ink"
            >
              See all your saved Pools
              {hidden > 0 ? ` (${hidden} more)` : ''} →
            </Link>
          </div>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Starter list (static examples, unvetted)
// ---------------------------------------------------------------------------

function StarterMarkets() {
  const [list, setList] = useState<StarterList | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadStarterList().then((l) => {
      if (!cancelled) setList(l)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const nowSec = Date.now() / 1000
  const active = (list?.markets ?? []).filter((m) => m.expiry > nowSec)
  if (active.length === 0) return null

  return (
    <section>
      <SectionHeader index="02" title="Examples" meta="unvetted" />
      <p className="mb-3 text-xs text-faint">
        Active community pools (unvetted)
        {list?.generatedAt ? `, as of ${list.generatedAt}` : ''} — listed for
        convenience, not endorsement.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {active.map((m) => (
          <Link
            key={m.address}
            to={`/market/${m.address}`}
            className="rounded-xl border border-hairline bg-surface p-3.5 transition hover:border-hairline-strong"
          >
            <p className="truncate text-sm font-medium text-fg">{m.name}</p>
            <p className="mt-1 font-mono text-xs text-faint" title={m.address}>
              {shortAddress(m.address)}
            </p>
            <p className="mt-1.5 text-xs text-muted">
              Expiry {formatDate(m.expiry)}
              {m.assetSymbol ? ` · ${m.assetSymbol}` : ''}
            </p>
          </Link>
        ))}
      </div>
    </section>
  )
}

export default function Home() {
  useDocumentTitle()
  const { chain } = useActiveChain()

  return (
    <div className="pb-16">
      <section className="relative py-14 sm:py-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-5 bottom-0 z-0"
          style={{
            backgroundImage: 'radial-gradient(var(--op-grid) 1px, transparent 1px)',
            backgroundSize: '26px 26px',
            WebkitMaskImage: 'radial-gradient(ellipse 80% 70% at 40% 30%, #000 30%, transparent 75%)',
            maskImage: 'radial-gradient(ellipse 80% 70% at 40% 30%, #000 30%, transparent 75%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 left-[20%] z-0 h-[460px] w-[640px] max-w-[90%]"
          style={{
            background:
              'radial-gradient(ellipse 50% 50% at 50% 40%, rgba(var(--op-accent-rgb),var(--op-glow)), transparent 70%)',
          }}
        />
        <div className="relative z-[1] grid items-center gap-12 lg:grid-cols-[1.08fr_.92fr]">
          <div>
            <span className="inline-flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-[.06em] text-muted">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: 'var(--op-accent)', animation: 'op-pulse 2.4s ease-in-out infinite' }}
              />
              Permissionless · on-chain
            </span>
            <h1 className="mt-[18px] text-[44px] font-extrabold leading-[1.02] tracking-[-.04em] text-fg sm:text-[57px]">
              Pendle community pools,{' '}
              <span className="relative whitespace-nowrap text-accent-ink">
                no whitelist
                <span
                  className="absolute inset-x-0 bottom-[.02em] h-[.1em] rounded"
                  style={{ background: 'var(--op-accent)', opacity: 0.55 }}
                />
              </span>
            </h1>
            <p className="mt-5 max-w-[46ch] text-[16.5px] leading-relaxed text-muted">
              Load any Pendle V2 market on {chain.name} by address. No backend, no curation, no
              indexer — the interface reads straight from the chain and simulates every transaction
              before you sign.
            </p>
            <div className="mt-7">
              <label className="mb-2 block font-mono text-[10.5px] uppercase tracking-[.08em] text-faint">
                Load any market
              </label>
              <MarketPasteBox />
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13.5px]">
              <Link to="/create" className="font-semibold text-accent-ink no-underline">
                Create a community pool →
              </Link>
              <span className="text-faint">·</span>
              <Link to="/create-sy" className="font-semibold text-muted no-underline hover:text-fg">
                Create an SY adapter →
              </Link>
            </div>
            <div className="mt-[18px] flex flex-wrap gap-[7px]">
              {['Exact-amount approvals', 'Simulated before you sign', 'Registry stays on your device'].map(
                (c) => (
                  <span
                    key={c}
                    className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-[11px] py-1 text-[11.5px] text-muted"
                  >
                    <span className="text-accent-ink">✓</span>
                    {c}
                  </span>
                ),
              )}
            </div>
          </div>
          <div className="hidden lg:block">
            <MarketAnatomyCard />
          </div>
        </div>
      </section>

      <div className="space-y-12">
        <SavedPoolsPreview />
        <StarterMarkets />
      </div>
    </div>
  )
}
