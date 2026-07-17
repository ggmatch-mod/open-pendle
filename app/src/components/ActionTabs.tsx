/**
 * ActionTabs (M2/M3/M4/M12) — the shared action area. Market mode exposes five
 * live tabs (Wrap/Unwrap, Mint/Redeem, Trade PT & YT, PT Limits, Liquidity). Token mode is
 * used by the market-less PT/YT page and exposes only the actions its synthetic
 * snapshot can support without a market (Wrap/Unwrap and Mint/Redeem).
 * SlippageControl in the header is shared by every mounted panel.
 */

import { lazy, Suspense, useState } from 'react'
import type { MarketSnapshot, Positions } from '../lib/types'
import { LiquidityPanel } from './LiquidityPanel'
import { MintRedeemPanel } from './MintRedeemPanel'
import { SlippageControl } from './SlippageControl'
import { TradePanel } from './TradePanel'
import { WrapUnwrapPanel } from './WrapUnwrapPanel'

const LimitOrderPanel = lazy(() => import('./LimitOrderPanel'))

type TabId = 'wrap' | 'mint' | 'trade' | 'limit' | 'liquidity'

const LIVE_TABS: Array<{ id: TabId; label: string }> = [
  { id: 'wrap', label: 'Wrap / Unwrap' },
  { id: 'mint', label: 'Mint / Redeem' },
  { id: 'trade', label: 'Trade PT & YT' },
  { id: 'limit', label: 'PT Limits' },
  { id: 'liquidity', label: 'Liquidity' },
]

const TOKEN_TABS: Array<{ id: TabId; label: string }> = LIVE_TABS.filter(
  (tab) => tab.id === 'wrap' || tab.id === 'mint',
)

export function ActionTabs({
  snapshot,
  positions,
  refetchPositions,
  variant = 'market',
}: {
  snapshot: MarketSnapshot
  positions?: Positions
  refetchPositions: () => void
  /** Token mode must never expose market-dependent trade or liquidity panels. */
  variant?: 'market' | 'token'
}) {
  const [tab, setTab] = useState<TabId>('wrap')
  // True while the active panel has a send in flight (approving/signing/
  // pending) — freezes SlippageControl and tab switches so nothing can churn
  // the plan (or unmount the flow) under a signed transaction.
  const [flowBusy, setFlowBusy] = useState(false)
  const tabs = variant === 'token' ? TOKEN_TABS : LIVE_TABS

  return (
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-fg">
          {variant === 'token' ? 'Token actions' : 'Actions'}
        </h2>
        {tab !== 'limit' && <SlippageControl disabled={flowBusy} />}
      </div>

      <div
        role="tablist"
        aria-label={variant === 'token' ? 'Token actions' : 'Market actions'}
        className="mt-3.5 flex flex-wrap items-center gap-1.5 border-b border-hairline pb-2.5"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            disabled={flowBusy && tab !== t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              tab === t.id
                ? 'rounded-[10px] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink'
                : 'text-muted hover:text-fg'
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
        ) : tab === 'limit' ? (
          <Suspense fallback={<p className="text-sm text-muted">Loading PT limit orders…</p>}>
            <LimitOrderPanel
              snapshot={snapshot}
              positions={positions}
              refetchPositions={refetchPositions}
              onBusyChange={setFlowBusy}
            />
          </Suspense>
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
