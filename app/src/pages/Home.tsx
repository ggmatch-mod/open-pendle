/**
 * Home — paste-an-address front and center (PLAN M1 first-visit state), the
 * remembered-pools registry grid, a static starter list of active community
 * pools, and the protocol status card collapsed at the bottom.
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getAddress, isAddress } from 'viem'
import { useClassifyAddress, useRegistry, useRegistrySweep } from '../lib/hooks'
import { ProtocolStatus } from '../components/ProtocolStatus'
import { SavedPoolCard } from '../components/SavedPoolCard'
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
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400 align-[-2px]"
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

  if (input.length === 0 || status.status === 'idle') {
    return (
      <p className="text-sm text-zinc-500">
        Paste any Pendle V2 market (PLP) address on Arbitrum — it loads straight
        from the chain.
      </p>
    )
  }

  if (status.status === 'loading') {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-zinc-400">
        <Spinner /> checking address on-chain…
      </p>
    )
  }

  if (status.status === 'error') {
    return (
      <p className="text-sm text-red-400">
        Couldn't check that address — the RPC may be rate-limiting.{' '}
        {status.error ? <span className="text-red-500/80">({status.error})</span> : null}
      </p>
    )
  }

  const c = status.classification
  if (!c) return null

  switch (c.kind) {
    case 'invalid':
      return (
        <p className="text-sm text-red-400">
          {c.message || 'That is not a valid address (0x + 40 hex characters).'}
        </p>
      )
    case 'eoa':
      return (
        <p className="text-sm text-red-400">
          {c.message || "That's a wallet address, not a contract."}
        </p>
      )
    case 'pt':
    case 'yt':
    case 'sy':
      return (
        <div className="mx-auto max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-left">
          <p className="text-sm text-zinc-200">
            {c.message}
            {c.symbol && !c.message.includes(c.symbol) && (
              <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-400">
                {clampLabel(c.symbol)}
              </span>
            )}
          </p>
          {c.resolvedMarket && (
            <button
              onClick={() => navigate(`/market/${c.resolvedMarket}`)}
              className="mt-2.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Open its market →
            </button>
          )}
        </div>
      )
    case 'contract':
      if (c.unvalidatedMarketShape) {
        return (
          <div className="mx-auto max-w-lg rounded-lg border border-amber-900/60 bg-amber-950/40 p-3 text-left">
            <p className="text-sm text-amber-300">{c.message}</p>
          </div>
        )
      }
      return <p className="text-sm text-red-400">{c.message}</p>
    case 'market':
      return (
        <p className="flex items-center justify-center gap-2 text-sm text-emerald-400">
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
    <div className="mx-auto w-full max-w-xl">
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
        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3.5 font-mono text-sm text-zinc-100 placeholder-zinc-500 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
      />
      <div aria-live="polite" className="mt-2.5 min-h-5">
        <ClassificationFeedback status={classify} input={trimmed} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Saved pools (registry)
// ---------------------------------------------------------------------------

function RegistryEmptyState() {
  return (
    <section className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-6">
      <h2 className="text-base font-semibold text-zinc-100">No remembered pools yet</h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        The paste box above is the way in — OpenPendle has no listing page by
        design. Load a market by address, tick{' '}
        <span className="text-emerald-400">Remember this pool</span> on its page,
        and it will live here (stored locally in your browser, nowhere else).
      </p>
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        <span className="text-zinc-200">Where do I find a market address?</span>{' '}
        Community pool creators share their market (PLP) address — in Discord, on
        X, or as an Arbiscan link. It's the address of the{' '}
        <span className="font-mono text-xs">PendleMarket</span> contract itself,
        not the PT, YT or SY. If you paste a PT, YT or SY we'll tell you which it
        is, so you can ask the pool creator for the market address.
      </p>
    </section>
  )
}

function SavedPools() {
  const { pools } = useRegistry()
  // ONE multicall sweep for the whole grid (PLAN §3.3) instead of a full
  // market snapshot per card.
  const sweep = useRegistrySweep(pools)

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-zinc-100">Your pools</h2>
        {pools.length > 0 && (
          <span className="text-xs text-zinc-500">
            {pools.length} remembered · stored locally
          </span>
        )}
      </div>
      {pools.length === 0 ? (
        <RegistryEmptyState />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {[...pools]
            .sort((a, b) => b.savedAt - a.savedAt)
            .map((pool) => (
              <SavedPoolCard
                key={pool.market}
                pool={pool}
                sweepStatus={sweep.status}
                stats={sweep.stats[pool.market.toLowerCase()]}
              />
            ))}
        </div>
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
      <h2 className="text-lg font-semibold text-zinc-100">Examples</h2>
      <p className="mb-3 mt-0.5 text-xs text-zinc-500">
        Active community pools (unvetted)
        {list?.generatedAt ? `, as of ${list.generatedAt}` : ''} — listed for
        convenience, not endorsement.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {active.map((m) => (
          <Link
            key={m.address}
            to={`/market/${m.address}`}
            className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 transition hover:border-zinc-700"
          >
            <p className="truncate text-sm font-medium text-zinc-100">{m.name}</p>
            <p className="mt-1 font-mono text-xs text-zinc-500" title={m.address}>
              {shortAddress(m.address)}
            </p>
            <p className="mt-1.5 text-xs text-zinc-400">
              Expiry {formatDate(m.expiry)}
              {m.assetSymbol ? ` · ${m.assetSymbol}` : ''}
            </p>
          </Link>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Protocol status — collapsed by default, mounts (and reads the RPC) on open
// ---------------------------------------------------------------------------

function CollapsedProtocolStatus() {
  const [open, setOpen] = useState(false)

  return (
    <details
      className="group rounded-xl border border-zinc-800 bg-zinc-900/40"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none px-5 py-4 text-sm font-medium text-zinc-300 hover:text-zinc-100">
        Protocol status — live from Arbitrum
      </summary>
      <div className="px-3 pb-3">{open && <ProtocolStatus />}</div>
    </details>
  )
}

// ---------------------------------------------------------------------------

export default function Home() {
  useDocumentTitle()

  return (
    <div className="pb-14">
      <section className="py-12 text-center sm:py-14">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Pendle community pools, <span className="text-emerald-400">no whitelist</span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-zinc-400 sm:text-base">
          Load any Pendle V2 market on Arbitrum by address. No backend, no
          curation — just the chain.
        </p>
        <div className="mt-8">
          <MarketPasteBox />
        </div>
      </section>

      <div className="space-y-10">
        <SavedPools />
        <StarterMarkets />
        <CollapsedProtocolStatus />
      </div>
    </div>
  )
}
