import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatUnits } from 'viem'
import type { Address } from 'viem'
import { useAccount, useSwitchChain } from 'wagmi'
import { addressBookFor } from '../lib/addresses'
import { useActionFlow, useActiveChain } from '../lib/hooks'
import {
  apyFromLnImpliedRate,
  buildCancelSingleLimitOrderPlan,
  type LimitOrderBookEntry,
  type LimitOrderRecord,
  type PtSyLimitOrderType,
} from '../lib/limitOrders'
import { limitRouterAbi } from '../lib/pendleAbi'
import type { MarketSnapshot, Positions } from '../lib/types'
import { AmountInput } from './AmountInput'
import { clampLabel, formatAmount, formatPercent, shortAddress } from './format'
import { parseAmount } from './parseAmount'
import { TxButton } from './TxButton'
import { TxStatus } from './TxStatus'
import {
  PT_FOR_TOKEN,
  TOKEN_FOR_PT,
  type LimitOrderDraft,
  useLimitOrders,
} from './useLimitOrders'

const DAY_SECONDS = 86_400n
const DURATION_OPTIONS = [1, 7, 30] as const
type DurationDays = (typeof DURATION_OPTIONS)[number]

function formatDate(unixSeconds: bigint | number): string {
  const seconds = typeof unixSeconds === 'bigint' ? Number(unixSeconds) : unixSeconds
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(seconds * 1_000))
  } catch {
    return '—'
  }
}

function parseApyPercent(value: string): { value?: number; error?: string } {
  const trimmed = value.trim().replace(',', '.')
  if (trimmed === '') return {}
  if (!/^\d+(?:\.\d*)?$/.test(trimmed)) return { error: 'Enter a valid APY.' }
  const percent = Number(trimmed)
  if (!Number.isFinite(percent) || percent < 0) return { error: 'Enter a valid APY.' }
  return { value: percent / 100 }
}

function StatusBanner({
  tone,
  children,
}: {
  tone: 'neutral' | 'warn' | 'danger' | 'success'
  children: React.ReactNode
}) {
  const style =
    tone === 'success'
      ? 'border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink'
      : tone === 'warn'
        ? 'border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] text-warn'
        : tone === 'danger'
          ? 'border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] text-danger'
          : 'border-hairline bg-bg-2 text-muted'
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${style}`}>{children}</div>
}

function BookSide({
  title,
  entries,
  decimals,
}: {
  title: string
  entries: LimitOrderBookEntry[]
  decimals: number
}) {
  return (
    <div className="min-w-0 rounded-lg border border-hairline bg-bg-2 p-3">
      <h4 className="text-xs font-semibold text-fg">{title}</h4>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs text-faint">No visible entries.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {entries.slice(0, 5).map((entry, index) => (
            <div
              key={`${entry.impliedApy}-${entry.limitOrderSize}-${index}`}
              className="flex items-baseline justify-between gap-3 text-xs"
            >
              <span className="font-medium text-fg">{formatPercent(entry.impliedApy)}</span>
              <span className="text-right text-muted">
                {formatAmount(entry.limitOrderSize, decimals)} limit
                {entry.ammSize !== undefined && entry.ammSize > 0n
                  ? ' · AMM depth'
                  : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CancelOrderButton({
  order,
  snapshot,
  maker,
  refetchOrders,
  refetchPositions,
  reportBusy,
}: {
  order: LimitOrderRecord
  snapshot: MarketSnapshot
  maker: Address
  refetchOrders: () => void
  refetchPositions: () => void
  reportBusy: (orderId: string, busy: boolean) => void
}) {
  const { chainId } = useActiveChain()
  const plan = useMemo(() => {
    try {
      return buildCancelSingleLimitOrderPlan(order, {
        limitRouter: addressBookFor(chainId).limitRouter,
        abi: limitRouterAbi,
        maker,
        sy: snapshot.sy.address,
      })
    } catch {
      return null
    }
  }, [chainId, maker, order, snapshot.sy.address])
  const flow = useActionFlow(plan)
  const busy =
    flow.phase === 'approving' || flow.phase === 'signing' || flow.phase === 'pending'
  useEffect(() => {
    reportBusy(order.id, busy)
    return () => reportBusy(order.id, false)
  }, [busy, order.id, reportBusy])

  const done = () => {
    flow.reset()
    refetchOrders()
    refetchPositions()
  }

  return (
    <div className="mt-2.5 space-y-2">
      <TxButton
        flow={flow}
        actionLabel="cancel order"
        disabledReason={plan ? undefined : 'Cancellation unavailable'}
        onDone={done}
        onRetry={() => {
          refetchOrders()
          flow.reset()
        }}
      />
      <TxStatus flow={flow} />
    </div>
  )
}

function OrderCard({
  order,
  snapshot,
  active,
  maker,
  refetchOrders,
  refetchPositions,
  reportBusy,
}: {
  order: LimitOrderRecord
  snapshot: MarketSnapshot
  active: boolean
  maker?: Address
  refetchOrders: () => void
  refetchPositions: () => void
  reportBusy: (orderId: string, busy: boolean) => void
}) {
  const isBuy = order.type === TOKEN_FOR_PT
  const decimals = isBuy ? snapshot.sy.decimals : snapshot.sy.assetDecimals
  const symbol = isBuy ? snapshot.sy.symbol : snapshot.ptSymbol || 'PT'
  const filled = order.makingAmount - order.currentMakingAmount
  const filledPercent =
    order.makingAmount > 0n ? Number((filled * 10_000n) / order.makingAmount) / 100 : 0
  let apy: number | undefined
  try {
    apy = apyFromLnImpliedRate(order.lnImpliedRate)
  } catch {
    apy = undefined
  }

  return (
    <div className="rounded-lg border border-hairline bg-bg-2 p-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-fg">{isBuy ? 'Buy PT' : 'Sell PT'}</p>
          <p className="mt-0.5 text-faint" title={order.id}>
            {shortAddress(order.id)}
          </p>
        </div>
        <span className="rounded-md border border-hairline px-2 py-0.5 text-[11px] font-medium text-muted">
          {order.status.replaceAll('_', ' ').toLowerCase()}
        </span>
      </div>
      <div className="mt-2 grid gap-1 sm:grid-cols-2">
        <p className="text-muted">
          Amount: {formatAmount(order.makingAmount, decimals)} {clampLabel(symbol, 14)}
        </p>
        <p className="text-muted">Target APY: {apy === undefined ? '—' : formatPercent(apy)}</p>
        <p className="text-muted">Filled: {filledPercent.toFixed(2)}%</p>
        <p className="text-muted">Expires: {formatDate(order.expiry)}</p>
      </div>
      {active && order.currentMakingAmount < order.makingAmount && (
        <p className="mt-2 text-warn">
          Partially filled: {formatAmount(filled, decimals)} of{' '}
          {formatAmount(order.makingAmount, decimals)} {clampLabel(symbol, 14)}.
        </p>
      )}
      {active && maker && (
        <CancelOrderButton
          order={order}
          snapshot={snapshot}
          maker={maker}
          refetchOrders={refetchOrders}
          refetchPositions={refetchPositions}
          reportBusy={reportBusy}
        />
      )}
    </div>
  )
}

export function LimitOrderPanel({
  snapshot,
  positions,
  refetchPositions,
  onBusyChange,
}: {
  snapshot: MarketSnapshot
  positions?: Positions
  refetchPositions: () => void
  onBusyChange?: (busy: boolean) => void
}) {
  const { address: user, chainId: walletChainId, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { switchChain } = useSwitchChain()
  const { chainId: activeChainId, chain: activeChain } = useActiveChain()
  const [orderType, setOrderType] = useState<PtSyLimitOrderType>(TOKEN_FOR_PT)
  const [amountText, setAmountText] = useState('')
  const [apyText, setApyText] = useState('')
  const [durationDays, setDurationDays] = useState<DurationDays>(7)
  const [reviewedDraft, setReviewedDraft] = useState<LimitOrderDraft | undefined>()
  const [cancelBusyIds, setCancelBusyIds] = useState<Set<string>>(() => new Set())

  const flow = useLimitOrders(snapshot, orderType)
  const isBuy = orderType === TOKEN_FOR_PT
  const spendSymbol = isBuy ? snapshot.sy.symbol : snapshot.ptSymbol || 'PT'
  const spendDecimals = isBuy ? snapshot.sy.decimals : snapshot.sy.assetDecimals
  const balance = isBuy ? positions?.sy : positions?.pt
  const parsedAmount = parseAmount(amountText, spendDecimals)
  const parsedApy = parseApyPercent(apyText)
  const nowSeconds = BigInt(Math.floor(Date.now() / 1_000))
  const proposedExpiry = nowSeconds + BigInt(durationDays) * DAY_SECONDS
  const durationFits = proposedExpiry < BigInt(snapshot.expiry)
  const amountTooHigh =
    parsedAmount.amount !== undefined && balance !== undefined && parsedAmount.amount > balance
  const placementUnavailable =
    snapshot.isExpired || !snapshot.validated || flow.eligibility.status !== 'supported'
  const formReason = (() => {
    if (snapshot.isExpired) return 'This market has matured'
    if (!snapshot.validated) return 'Market validation required'
    if (flow.eligibility.status === 'loading') return 'Checking Pendle support…'
    if (flow.eligibility.status === 'unsupported') return 'Limit orders are not supported here'
    if (flow.eligibility.status === 'unavailable') return 'Support verification unavailable'
    if (parsedAmount.error) return 'Fix the amount'
    if (parsedAmount.amount === undefined || parsedAmount.amount <= 0n) return 'Enter an amount'
    if (amountTooHigh) return `Insufficient ${clampLabel(spendSymbol, 16)}`
    if (parsedApy.error) return 'Fix the target APY'
    if (parsedApy.value === undefined) return 'Enter a target APY'
    if (!durationFits) return 'Choose a duration before market maturity'
    return undefined
  })()

  const clearReview = useCallback(() => {
    if (!flow.busy) flow.reset()
    setReviewedDraft(undefined)
  }, [flow])

  const changeOrderType = (next: PtSyLimitOrderType) => {
    if (flow.busy) return
    clearReview()
    setOrderType(next)
    setAmountText('')
  }

  const review = () => {
    if (
      formReason ||
      parsedAmount.amount === undefined ||
      parsedApy.value === undefined
    ) return
    const draft: LimitOrderDraft = {
      orderType,
      makingAmount: parsedAmount.amount,
      impliedApy: parsedApy.value,
      expiry: BigInt(Math.floor(Date.now() / 1_000)) + BigInt(durationDays) * DAY_SECONDS,
    }
    if (draft.expiry >= BigInt(snapshot.expiry)) return
    setReviewedDraft(draft)
    flow.prepare(draft)
  }

  const reportCancelBusy = useCallback((orderId: string, busy: boolean) => {
    setCancelBusyIds((current) => {
      const next = new Set(current)
      if (busy) next.add(orderId)
      else next.delete(orderId)
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current
      return next
    })
  }, [])
  const anyBusy = flow.busy || cancelBusyIds.size > 0
  useEffect(() => {
    onBusyChange?.(anyBusy)
    return () => onBusyChange?.(false)
  }, [anyBusy, onBusyChange])

  const lastAccepted = useRef<string | undefined>(undefined)
  useEffect(() => {
    const id = flow.submittedOrder?.id
    if (id && lastAccepted.current !== id) {
      lastAccepted.current = id
      refetchPositions()
    }
  }, [flow.submittedOrder, refetchPositions])

  const annualizedFeeParameter = useMemo(() => {
    if (flow.eligibility.status !== 'supported') return undefined
    const rate = Math.expm1(Number(flow.eligibility.onchainLnFeeRateRoot) / 1e18)
    return Number.isFinite(rate) && rate >= 0 ? rate : undefined
  }, [flow.eligibility])

  const primaryButton = (() => {
    const base =
      'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors'
    const primary = `${base} bg-accent text-white hover:brightness-110`
    const disabled = `${base} cursor-not-allowed bg-surface-2 text-faint`
    const busyClass = `${base} cursor-wait bg-surface-2 text-muted`

    if (placementUnavailable) {
      return <button type="button" disabled className={disabled}>{formReason ?? 'Limit orders unavailable'}</button>
    }
    if (!isConnected) {
      return (
        <button type="button" onClick={() => openConnectModal?.()} disabled={!openConnectModal} className={primary}>
          Connect wallet
        </button>
      )
    }
    if (walletChainId !== activeChainId || flow.phase === 'wrong-network') {
      return (
        <button type="button" onClick={() => switchChain({ chainId: activeChainId })} className={`${base} bg-warn text-white`}>
          Switch to {activeChain.name}
        </button>
      )
    }
    if (!reviewedDraft || flow.phase === 'idle' || flow.phase === 'needs-wallet') {
      return (
        <button type="button" onClick={review} disabled={Boolean(formReason)} className={formReason ? disabled : primary}>
          {formReason ?? 'Review order'}
        </button>
      )
    }
    if (flow.phase === 'checking') {
      return <button type="button" disabled className={busyClass}>Checking order…</button>
    }
    if (flow.phase === 'needs-approval') {
      return (
        <button type="button" onClick={flow.approve} className={primary}>
          Approve {clampLabel(flow.pendingApproval?.symbol ?? spendSymbol, 16)}
        </button>
      )
    }
    if (flow.phase === 'approving') {
      return <button type="button" disabled className={busyClass}>Approval pending…</button>
    }
    if (flow.phase === 'ready') {
      return <button type="button" onClick={flow.place} className={primary}>Sign &amp; place order</button>
    }
    if (flow.phase === 'generating') {
      return <button type="button" disabled className={busyClass}>Preparing order…</button>
    }
    if (flow.phase === 'signing') {
      return <button type="button" disabled className={busyClass}>Confirm in your wallet…</button>
    }
    if (flow.phase === 'submitting') {
      return <button type="button" disabled className={busyClass}>Sending exact signed order…</button>
    }
    if (flow.phase === 'ambiguous') {
      return (
        <div className="space-y-2">
          <button type="button" onClick={flow.retryExactSubmission} className={`${base} border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] text-warn`}>
            Retry exact signed order
          </button>
          <button type="button" onClick={flow.abandonAmbiguousRetry} className={`${base} border border-hairline bg-surface-2 text-muted hover:text-fg`}>
            Stop retrying locally
          </button>
          <p className="text-[11px] leading-relaxed text-warn">
            The order may already be live — check Your orders before creating another.
          </p>
        </div>
      )
    }
    if (flow.phase === 'confirmed') {
      return (
        <button
          type="button"
          onClick={() => {
            flow.reset()
            setReviewedDraft(undefined)
            setAmountText('')
          }}
          className={`${base} border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink`}
        >
          Create another order
        </button>
      )
    }
    return (
      <button
        type="button"
        onClick={() => {
          flow.reset()
          setReviewedDraft(undefined)
        }}
        className={`${base} border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] text-warn`}
      >
        Review again
      </button>
    )
  })()

  return (
    <div className="space-y-5">
      <div className="space-y-3.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-fg">PT limit order</h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
              Set a target fixed APY. The signed order stays off-chain until a taker fills it.
            </p>
          </div>
          <span className="rounded-md border border-hairline bg-bg-2 px-2 py-1 text-[11px] text-muted">
            {annualizedFeeParameter === undefined
              ? 'Fee unavailable'
              : `Fee: ${formatPercent(annualizedFeeParameter)}/yr`}
          </span>
        </div>

        {flow.eligibility.status === 'loading' && (
          <StatusBanner tone="neutral">Checking Pendle's live support and on-chain fee setting…</StatusBanner>
        )}
        {flow.eligibility.status === 'unsupported' && (
          <StatusBanner tone="warn">
            Limit orders aren't available for this market and direction.
          </StatusBanner>
        )}
        {flow.eligibility.status === 'unavailable' && (
          <StatusBanner tone="danger">
            Support could not be verified safely, so signing is disabled. {flow.eligibility.error}
          </StatusBanner>
        )}

        <div className="inline-flex rounded-[10px] bg-surface-2 p-0.5">
          <button
            type="button"
            disabled={anyBusy}
            onClick={() => changeOrderType(TOKEN_FOR_PT)}
            className={`px-3 py-1.5 text-xs font-medium ${isBuy ? 'rounded-[8px] bg-surface text-fg shadow-[var(--op-shadow)]' : 'text-muted'}`}
          >
            Buy PT
          </button>
          <button
            type="button"
            disabled={anyBusy}
            onClick={() => changeOrderType(PT_FOR_TOKEN)}
            className={`px-3 py-1.5 text-xs font-medium ${!isBuy ? 'rounded-[8px] bg-surface text-fg shadow-[var(--op-shadow)]' : 'text-muted'}`}
          >
            Sell PT
          </button>
        </div>

        <AmountInput
          label={isBuy ? 'SY to spend' : 'PT to sell'}
          value={amountText}
          onChange={(next) => {
            clearReview()
            setAmountText(next)
          }}
          symbol={spendSymbol}
          decimals={spendDecimals}
          balance={balance}
          disabled={anyBusy || placementUnavailable}
          error={parsedAmount.error ?? (amountTooHigh ? `Insufficient ${spendSymbol}` : undefined)}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-faint">Target fixed APY</span>
            <div className={`mt-1.5 flex items-center rounded-lg border bg-bg px-3 py-2.5 focus-within:border-accent ${parsedApy.error ? 'border-[var(--op-danger-bd)]' : 'border-hairline-strong'}`}>
              <input
                type="text"
                inputMode="decimal"
                value={apyText}
                disabled={anyBusy || placementUnavailable}
                onChange={(event) => {
                  const next = event.target.value
                  if (next === '' || /^\d*[.,]?\d*$/.test(next)) {
                    clearReview()
                    setApyText(next)
                  }
                }}
                placeholder="5.00"
                className="min-w-0 flex-1 bg-transparent text-base font-semibold text-fg outline-none disabled:cursor-not-allowed"
              />
              <span className="text-sm text-muted">%</span>
            </div>
            {parsedApy.error && <p className="mt-1 text-xs text-danger">{parsedApy.error}</p>}
          </label>

          <label className="block">
            <span className="text-xs text-faint">Order duration</span>
            <select
              value={durationDays}
              disabled={anyBusy || placementUnavailable}
              onChange={(event) => {
                clearReview()
                setDurationDays(Number(event.target.value) as DurationDays)
              }}
              className="mt-1.5 w-full rounded-lg border border-hairline-strong bg-bg px-3 py-2.5 text-sm font-medium text-fg outline-none focus:border-accent disabled:cursor-not-allowed"
            >
              {DURATION_OPTIONS.map((days) => (
                <option
                  key={days}
                  value={days}
                  disabled={nowSeconds + BigInt(days) * DAY_SECONDS >= BigInt(snapshot.expiry)}
                >
                  {days} day{days === 1 ? '' : 's'}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-faint">Must end before {formatDate(snapshot.expiry)}.</p>
          </label>
        </div>

        {reviewedDraft && (
          <div className="rounded-lg border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.06)] p-3 text-xs">
            <p className="font-semibold text-fg">Review</p>
            <div className="mt-2 grid gap-1 text-muted sm:grid-cols-2">
              <p>Direction: {reviewedDraft.orderType === TOKEN_FOR_PT ? 'Buy PT with SY' : 'Sell PT for SY'}</p>
              <p>Target APY: {formatPercent(reviewedDraft.impliedApy)}</p>
              <p>Amount: {formatUnits(reviewedDraft.makingAmount, spendDecimals)} {clampLabel(spendSymbol, 14)}</p>
              <p>Expires: {formatDate(reviewedDraft.expiry)}</p>
            </div>
          </div>
        )}

        {flow.notice && <StatusBanner tone={flow.phase === 'confirmed' ? 'success' : 'neutral'}>{flow.notice}</StatusBanner>}
        {flow.error && (
          <StatusBanner tone={flow.phase === 'ambiguous' ? 'warn' : 'danger'}>
            {flow.error}
            {flow.phase === 'ambiguous' && (
              <span className="mt-1 block">
                Retry re-submits the same signed order — it never creates a new one.
              </span>
            )}
          </StatusBanner>
        )}
        {primaryButton}

        <div className="space-y-1 text-[11px] leading-relaxed text-faint">
          <p>
            Funds aren't reserved — keep balance and allowance available until the order fills.
            Placing is gasless; approvals and cancellation cost gas.
          </p>
          <p>Smart-contract wallets aren't supported.</p>
        </div>
      </div>

      <section className="border-t border-hairline pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-fg">Order book</h3>
          </div>
          <span className="text-[11px] text-faint">refreshes about every 15s</span>
        </div>
        {flow.bookLoading ? (
          <p className="mt-3 text-xs text-muted">Loading order book…</p>
        ) : flow.bookError ? (
          <StatusBanner tone="warn">Order book unavailable: {flow.bookError}</StatusBanner>
        ) : flow.book ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <BookSide title="Long yield" entries={flow.book.longYieldEntries} decimals={snapshot.sy.assetDecimals} />
            <BookSide title="Short yield" entries={flow.book.shortYieldEntries} decimals={snapshot.sy.assetDecimals} />
          </div>
        ) : (
          <p className="mt-3 text-xs text-faint">No order-book data.</p>
        )}
      </section>

      <section className="border-t border-hairline pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-fg">Your orders</h3>
            <p className="mt-0.5 text-[11px] text-faint">Your orders for this market.</p>
          </div>
          <span className="text-[11px] text-faint">refreshes about every 20s</span>
        </div>
        {!user ? (
          <p className="mt-3 text-xs text-muted">Connect a wallet to see your orders.</p>
        ) : flow.ordersLoading ? (
          <p className="mt-3 text-xs text-muted">Loading your orders…</p>
        ) : flow.ordersError ? (
          <StatusBanner tone="warn">Orders unavailable: {flow.ordersError}</StatusBanner>
        ) : (
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold text-fg">Active</h4>
              <div className="mt-2 space-y-2">
                {flow.activeOrders.length === 0 ? (
                  <p className="text-xs text-faint">No active orders.</p>
                ) : (
                  flow.activeOrders.map((order) => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      snapshot={snapshot}
                      active
                      maker={user}
                      refetchOrders={flow.refetchOrders}
                      refetchPositions={refetchPositions}
                      reportBusy={reportCancelBusy}
                    />
                  ))
                )}
              </div>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-fg">History</h4>
              <div className="mt-2 space-y-2">
                {flow.historyOrders.length === 0 ? (
                  <p className="text-xs text-faint">No completed, cancelled, or expired orders.</p>
                ) : (
                  flow.historyOrders.map((order) => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      snapshot={snapshot}
                      active={false}
                      refetchOrders={flow.refetchOrders}
                      refetchPositions={refetchPositions}
                      reportBusy={reportCancelBusy}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}
        {flow.activeOrders.length > 0 && (
          <p className="mt-3 text-[11px] leading-relaxed text-warn">
            Cancellation is an on-chain transaction and can race a fill until it is mined.
          </p>
        )}
      </section>
    </div>
  )
}

export default LimitOrderPanel
