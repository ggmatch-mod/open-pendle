/**
 * Home — paste-an-address front and center (PLAN M1 first-visit state), the
 * remembered-pools registry grid, a static starter list of active community
 * pools, and the protocol status card collapsed at the bottom.
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getAddress, isAddress } from 'viem'
import { useActiveChain, useClassifyAddress, useRegistry, useRegistrySweep } from '../lib/hooks'
import { ProtocolStatus } from '../components/ProtocolStatus'
import {
  poolsByRecency,
  RegistryEmptyState,
  SavedPoolGrid,
} from '../components/SavedPoolsList'
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
          {c.resolvedMarket && (
            <button
              onClick={() => navigate(`/market/${c.resolvedMarket}`)}
              className="mt-2.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
            >
              Open its market →
            </button>
          )}
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
        className="w-full rounded-xl border border-hairline-strong bg-surface px-4 py-3.5 font-mono text-sm text-fg placeholder-[color:var(--op-faint)] outline-none transition focus:border-accent focus:ring-2 focus:ring-[rgba(var(--op-accent-rgb),0.2)]"
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
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-fg">Your pools</h2>
        {pools.length > 0 && (
          <span className="text-xs text-faint">
            {pools.length} remembered · stored locally
          </span>
        )}
      </div>
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
      <h2 className="text-lg font-semibold text-fg">Examples</h2>
      <p className="mb-3 mt-0.5 text-xs text-faint">
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

// ---------------------------------------------------------------------------
// Protocol status — collapsed by default, mounts (and reads the RPC) on open
// ---------------------------------------------------------------------------

function CollapsedProtocolStatus() {
  const [open, setOpen] = useState(false)
  const { chain } = useActiveChain()

  return (
    <details
      className="group rounded-xl border border-hairline bg-surface"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none px-5 py-4 text-sm font-medium text-muted hover:text-fg">
        Protocol status — live from {chain.name}
      </summary>
      <div className="px-3 pb-3">{open && <ProtocolStatus />}</div>
    </details>
  )
}

// ---------------------------------------------------------------------------

export default function Home() {
  useDocumentTitle()
  const { chain } = useActiveChain()

  return (
    <div className="pb-14">
      <section className="py-12 text-center sm:py-14">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Pendle community pools, <span className="text-accent-ink">no whitelist</span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-muted sm:text-base">
          Load any Pendle V2 market on {chain.name} by address. No backend, no
          curation — just the chain.
        </p>
        <div className="mt-8">
          <MarketPasteBox />
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm text-faint">
          <span>Want your own pool?</span>
          <Link
            to="/create"
            className="rounded-md border border-[rgba(var(--op-accent-rgb),0.4)] px-3 py-1.5 font-medium text-accent-ink transition hover:border-[rgba(var(--op-accent-rgb),0.4)] hover:text-accent-ink"
          >
            Create a community pool →
          </Link>
          <Link
            to="/create-sy"
            className="rounded-md border border-hairline-strong px-3 py-1.5 font-medium text-muted transition hover:border-[rgba(var(--op-accent-rgb),0.4)] hover:text-accent-ink"
          >
            Create an SY adapter →
          </Link>
        </div>
      </section>

      <div className="space-y-10">
        <SavedPoolsPreview />
        <StarterMarkets />
        <CollapsedProtocolStatus />
      </div>
    </div>
  )
}
