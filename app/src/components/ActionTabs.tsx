/**
 * ActionTabs (M2) — the market page actions area. Two live tabs (Wrap/Unwrap,
 * Mint/Redeem) plus the M3/M4 placeholders. Rendered ONLY on validated,
 * non-expired markets — expired keeps MaturedNotice, unvalidated keeps the
 * red state (gating lives in MarketPage). SlippageControl in the header is
 * shared by both panels.
 */

import { useState } from 'react'
import type { MarketSnapshot, Positions } from '../lib/types'
import { MintRedeemPanel } from './MintRedeemPanel'
import { SlippageControl } from './SlippageControl'
import { WrapUnwrapPanel } from './WrapUnwrapPanel'

type TabId = 'wrap' | 'mint'

const LIVE_TABS: Array<{ id: TabId; label: string }> = [
  { id: 'wrap', label: 'Wrap / Unwrap' },
  { id: 'mint', label: 'Mint / Redeem' },
]

const PLACEHOLDER_TABS = [
  { label: 'Trade PT & YT', arrives: 'arrives in M3' },
  { label: 'Liquidity', arrives: 'arrives in M4' },
]

export function ActionTabs({
  snapshot,
  positions,
  refetchPositions,
}: {
  snapshot: MarketSnapshot
  positions?: Positions
  refetchPositions: () => void
}) {
  const [tab, setTab] = useState<TabId>('wrap')
  // True while the active panel has a send in flight (approving/signing/
  // pending) — freezes SlippageControl and tab switches so nothing can churn
  // the plan (or unmount the flow) under a signed transaction.
  const [flowBusy, setFlowBusy] = useState(false)

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-zinc-100">Actions</h2>
        <SlippageControl disabled={flowBusy} />
      </div>

      <div
        role="tablist"
        aria-label="Market actions"
        className="mt-3.5 flex flex-wrap items-center gap-1.5 border-b border-zinc-800 pb-2.5"
      >
        {LIVE_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            disabled={flowBusy && tab !== t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              tab === t.id
                ? 'bg-emerald-950/70 text-emerald-300'
                : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        ))}
        {PLACEHOLDER_TABS.map((t) => (
          <span
            key={t.label}
            aria-disabled="true"
            title={t.arrives}
            className="cursor-not-allowed rounded-md px-3 py-1.5 text-sm text-zinc-600"
          >
            {t.label}
            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-zinc-700">
              {t.arrives.replace('arrives in ', '')}
            </span>
          </span>
        ))}
      </div>

      <div className="pt-4">
        {tab === 'wrap' ? (
          <WrapUnwrapPanel
            snapshot={snapshot}
            positions={positions}
            refetchPositions={refetchPositions}
            onBusyChange={setFlowBusy}
          />
        ) : (
          <MintRedeemPanel
            snapshot={snapshot}
            positions={positions}
            refetchPositions={refetchPositions}
            onBusyChange={setFlowBusy}
          />
        )}
      </div>
    </section>
  )
}
