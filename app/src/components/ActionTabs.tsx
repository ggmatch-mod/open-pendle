/**
 * ActionTabs (M2/M3/M4) — the market page actions area. Four live tabs
 * (Wrap/Unwrap, Mint/Redeem, Trade PT & YT, Liquidity). Rendered ONLY on
 * validated, non-expired markets — expired gets the M5 MaturedPanel, unvalidated
 * keeps the red state (gating lives in MarketPage). SlippageControl in the
 * header is shared by all panels.
 */

import { useState } from 'react'
import type { MarketSnapshot, Positions } from '../lib/types'
import { LiquidityPanel } from './LiquidityPanel'
import { MintRedeemPanel } from './MintRedeemPanel'
import { SlippageControl } from './SlippageControl'
import { TradePanel } from './TradePanel'
import { WrapUnwrapPanel } from './WrapUnwrapPanel'

type TabId = 'wrap' | 'mint' | 'trade' | 'liquidity'

const LIVE_TABS: Array<{ id: TabId; label: string }> = [
  { id: 'wrap', label: 'Wrap / Unwrap' },
  { id: 'mint', label: 'Mint / Redeem' },
  { id: 'trade', label: 'Trade PT & YT' },
  { id: 'liquidity', label: 'Liquidity' },
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
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-fg">Actions</h2>
        <SlippageControl disabled={flowBusy} />
      </div>

      <div
        role="tablist"
        aria-label="Market actions"
        className="mt-3.5 flex flex-wrap items-center gap-1.5 border-b border-hairline pb-2.5"
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
                ? 'bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink'
                : 'text-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            {t.label}
          </button>
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
        ) : tab === 'mint' ? (
          <MintRedeemPanel
            snapshot={snapshot}
            positions={positions}
            refetchPositions={refetchPositions}
            onBusyChange={setFlowBusy}
          />
        ) : tab === 'trade' ? (
          <TradePanel
            snapshot={snapshot}
            positions={positions}
            refetchPositions={refetchPositions}
            onBusyChange={setFlowBusy}
          />
        ) : (
          <LiquidityPanel
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
