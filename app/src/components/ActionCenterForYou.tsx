import { Link } from 'react-router-dom'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { supportedChain } from '../lib/addresses'
import { marketPath } from '../lib/routes'
import type { useActionCenter } from './useActionCenter'
import { explorerTxUrl } from './format'

type ActionCenterState = ReturnType<typeof useActionCenter>

const severityClass = {
  critical: 'border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)]',
  warning: 'border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)]',
  info: 'border-hairline bg-surface',
} as const

const severityDot = {
  critical: 'bg-danger',
  warning: 'bg-warn',
  info: 'bg-accent',
} as const

function when(timestamp: number): string {
  const delta = Date.now() - timestamp
  if (!Number.isFinite(delta) || delta < 0) return 'just now'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function ActionCenterForYou({ state }: { state: ActionCenterState }) {
  const { openConnectModal } = useConnectModal()
  const { owner, profileState, portfolio, items } = state
  const { profile } = profileState
  const criticalCount = items.filter((item) => item.severity === 'critical').length
  const warningCount = items.filter((item) => item.severity === 'warning').length
  const activeOrderCount = profile.activity.filter(
    (item) =>
      item.kind === 'limit-order' &&
      item.status === 'active' &&
      (item.expiry === undefined || item.expiry > Math.floor(Date.now() / 1_000)),
  ).length

  if (owner === undefined) {
    return (
      <section className="rounded-xl border border-hairline bg-surface px-5 py-10 text-center">
        <h2 className="text-base font-semibold text-fg">Your Action Center starts with your wallet</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted">
          Connect to match live positions, maturities, claimables, tracked yield moves and OpenPendle activity. Market movers remain wallet-free.
        </p>
        <button
          type="button"
          onClick={() => openConnectModal?.()}
          disabled={!openConnectModal}
          className="mt-4 rounded-[9px] bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:brightness-110"
        >
          Connect wallet
        </button>
      </section>
    )
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Action Center summary">
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <p className="text-[10.5px] uppercase tracking-[.06em] text-faint">Needs attention</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">{criticalCount + warningCount}</p>
          <p className="mt-1 text-[11px] text-faint">{criticalCount} urgent · {warningCount} review</p>
        </div>
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <p className="text-[10.5px] uppercase tracking-[.06em] text-faint">Tracked markets</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">{profile.trackedMarkets.length}</p>
          <p className="mt-1 text-[11px] text-faint">Plus markets in your wallet</p>
        </div>
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <p className="text-[10.5px] uppercase tracking-[.06em] text-faint">Tracked orders</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">{activeOrderCount}</p>
          <p className="mt-1 text-[11px] text-faint">Seen on this device</p>
        </div>
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <p className="text-[10.5px] uppercase tracking-[.06em] text-faint">Holdings loaded</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fg">{portfolio.overview.holdings.length}</p>
          <p className="mt-1 text-[11px] text-faint">Across {portfolio.overview.chainCount} network{portfolio.overview.chainCount === 1 ? '' : 's'}</p>
        </div>
      </section>

      <details className="rounded-xl border border-hairline bg-surface">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-fg">
          Alert rules <span className="ml-1 text-xs font-normal text-faint">Device-local</span>
        </summary>
        <div className="grid gap-4 border-t border-hairline px-4 py-4 sm:grid-cols-3">
          <label className="text-xs font-medium text-muted">
            Maturity notice
            <select
              value={profile.preferences.maturityLeadDays}
              onChange={(event) => profileState.setPreferences({
                ...profile.preferences,
                maturityLeadDays: Number(event.target.value) as 7 | 30 | 90,
              })}
              className="mt-1.5 h-10 w-full rounded-[9px] border border-hairline bg-bg px-3 text-sm text-fg outline-none focus:border-accent"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
          <label className="text-xs font-medium text-muted">
            Yield-move threshold
            <select
              value={profile.preferences.yieldMoveBps}
              onChange={(event) => profileState.setPreferences({
                ...profile.preferences,
                yieldMoveBps: Number(event.target.value),
              })}
              className="mt-1.5 h-10 w-full rounded-[9px] border border-hairline bg-bg px-3 text-sm text-fg outline-none focus:border-accent"
            >
              <option value={25}>25 bps</option>
              <option value={50}>50 bps</option>
              <option value={100}>100 bps</option>
              <option value={250}>250 bps</option>
            </select>
          </label>
          <label className="flex items-center gap-2 self-end rounded-[9px] border border-hairline bg-bg px-3 py-2.5 text-xs font-medium text-muted">
            <input
              type="checkbox"
              checked={profile.preferences.showClaimable}
              onChange={(event) => profileState.setPreferences({
                ...profile.preferences,
                showClaimable: event.target.checked,
              })}
              className="accent-[var(--op-accent)]"
            />
            Show claimable rewards
          </label>
        </div>
        <p className="border-t border-hairline px-4 py-3 text-[11px] leading-relaxed text-faint">
          Monitoring runs while OpenPendle is open. Reliable push, email or Telegram delivery requires a future opt-in backend; this device stores no signatures or calldata.
        </p>
      </details>

      <section className="overflow-hidden rounded-xl border border-hairline bg-bg-2">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-fg">For you</h2>
            <p className="mt-0.5 text-[11.5px] text-faint">Live evidence, recomputed from your wallet and followed markets.</p>
          </div>
          {(portfolio.status === 'loading' || state.yieldQuery.isFetching) && (
            <span className="text-[11px] text-faint">Checking live sources…</span>
          )}
        </div>
        {items.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-semibold text-fg">
              {portfolio.status === 'loading' || state.yieldQuery.isPending ? 'Checking your positions and yield sources…' : 'All clear'}
            </p>
            <p className="mt-1 text-xs text-muted">
              {portfolio.status === 'loading' || state.yieldQuery.isPending
                ? 'Actions will appear after the available evidence has been checked.'
                : 'No maturity, claim, tracked-yield or transaction action currently meets your rules.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-2.5 p-3 sm:p-4">
            {items.map((item) => {
              const content = (
                <>
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${severityDot[item.severity]}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-fg">{item.title}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">{item.detail}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">{item.href ? 'Review →' : when(item.observedAt)}</span>
                </>
              )
              const className = `flex items-start gap-3 rounded-[11px] border px-3.5 py-3 no-underline ${severityClass[item.severity]}`
              return item.href ? (
                <Link key={item.id} to={item.href} className={className}>{content}</Link>
              ) : (
                <div key={item.id} className={className}>{content}</div>
              )
            })}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-hairline bg-surface p-4">
          <h2 className="text-sm font-semibold text-fg">Tracked markets</h2>
          {profile.trackedMarkets.length === 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-muted">Use “Track” in Market movers. Markets with current wallet holdings are followed automatically.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {profile.trackedMarkets.slice(0, 8).map((market) => (
                <div key={`${market.chainId}:${market.market}`} className="rounded-[9px] border border-hairline bg-bg-2 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <Link to={marketPath(market.market, market.chainId)} className="min-w-0 truncate text-xs font-medium text-fg hover:text-accent-ink">{market.label}</Link>
                    <button type="button" onClick={() => profileState.untrack(market.chainId, market.market)} className="text-[11px] text-faint hover:text-danger">Remove</button>
                  </div>
                  <label className="mt-2 flex items-center justify-between gap-3 text-[10.5px] text-faint">
                    Minimum APY target
                    <span className="flex items-center gap-1">
                      <input
                        key={market.targetApyBps ?? 'disabled'}
                        type="number"
                        min="0.01"
                        max="1000"
                        step="0.01"
                        defaultValue={market.targetApyBps === undefined ? '' : market.targetApyBps / 100}
                        placeholder="Off"
                        aria-label={`Minimum APY target for ${market.label}`}
                        onBlur={(event) => {
                          const value = event.currentTarget.value.trim()
                          if (value === '') {
                            profileState.setTarget(market.chainId, market.market, null)
                            return
                          }
                          const percent = Number(value)
                          if (!Number.isFinite(percent) || percent < 0.01 || percent > 1_000) {
                            event.currentTarget.value = market.targetApyBps === undefined
                              ? ''
                              : String(market.targetApyBps / 100)
                            return
                          }
                          profileState.setTarget(
                            market.chainId,
                            market.market,
                            Math.round(percent * 100),
                          )
                        }}
                        className="h-8 w-24 rounded-[8px] border border-hairline bg-surface px-2 text-right text-xs tabular-nums text-fg outline-none focus:border-accent"
                      />
                      <span>%</span>
                    </span>
                  </label>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[10.5px] leading-relaxed text-faint">
            APY targets use the latest complete qualified Market movers window; they are not tick-by-tick price alerts.
          </p>
        </section>

        <section className="rounded-xl border border-hairline bg-surface p-4">
          <h2 className="text-sm font-semibold text-fg">Recent OpenPendle activity</h2>
          {profile.activity.length === 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-muted">Transactions and limit orders created or opened after this feature was enabled will appear here.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {profile.activity.slice(0, 8).map((activity) => {
                const chain = supportedChain(activity.chainId)
                const href = activity.hash !== undefined
                  ? explorerTxUrl(activity.chainId, activity.hash)
                  : activity.market !== undefined
                    ? `#${marketPath(activity.market, activity.chainId)}`
                    : undefined
                return (
                  <div key={activity.id} className="flex items-start justify-between gap-3 rounded-[9px] border border-hairline bg-bg-2 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-fg">{activity.label}</p>
                      <p className="mt-0.5 text-[10.5px] text-faint">{chain?.name ?? activity.chainId} · {when(activity.updatedAt)}</p>
                    </div>
                    {href === undefined ? (
                      <span className="text-[10.5px] font-semibold uppercase text-muted">{activity.status}</span>
                    ) : (
                      <a href={href} target={activity.hash === undefined ? undefined : '_blank'} rel={activity.hash === undefined ? undefined : 'noreferrer'} className="text-[10.5px] font-semibold uppercase text-accent-ink hover:underline">
                        {activity.kind === 'limit-order' &&
                        activity.status === 'active' &&
                        activity.expiry !== undefined &&
                        activity.expiry <= Math.floor(Date.now() / 1_000)
                          ? 'expiry passed'
                          : activity.status} ↗
                      </a>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <p className="mt-3 text-[10.5px] leading-relaxed text-faint">
            Expiry reminders are local. Fill and final status update after OpenPendle sees that order again on its market page.
          </p>
        </section>
      </div>
    </div>
  )
}
