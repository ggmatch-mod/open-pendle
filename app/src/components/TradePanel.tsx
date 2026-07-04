/**
 * TradePanel (M3) — buy/sell PT & YT through the router. Two-axis mode:
 * Buy/Sell × PT/YT. Buys pay with SY or any sy.tokensIn entry (address(0)
 * rendered as ETH); sells spend PT/YT (assetDecimals, Max from positions) and
 * receive SY or a sy.tokensOut entry.
 *
 * Quotes come from useSwapQuote (RouterStatic statics, debounced in the hook;
 * indicative — the binding number is always the pre-sign simulation in
 * useActionFlow). The quote card shows expected out, price impact with
 * severity tiers, implied-APY-after-trade and the market swap fee (netSyFee,
 * SY units).
 *
 * minOut = quote.amountOut × (1 − max(slippage, 0.05%)) — the 0.05% floor
 * absorbs the fork-observed static over-quote on YT-direction quotes
 * (fork-tests/PARITY.md haircut rule); the UI notes "(min 0.05%)" when the
 * user's setting sits below the floor. The same effective slippage is
 * threaded into useSwapQuote so the synthesized ApproxParams bounds scale
 * with the user's tolerance.
 *
 * Cap-risk directions (YT buys, PT sells — both push PT INTO the pool) run a
 * projected post-trade PT-proportion pre-check: > 0.90 warns, > 0.96 (the
 * AMM's hard cap) blocks the plan outright.
 *
 * Wire-up rules mirror the M2 panels: a plan is built ONLY for a valid,
 * positive, ≤-balance amount with a successful quote; plan builders may throw
 * (stubs until the data layer lands) — caught and rendered as a disabled
 * button, never a crash. Inputs freeze while a send is in flight
 * (onBusyChange → ActionTabs blocks tab switches / slippage edits).
 */

import { useEffect, useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import type { ActionPlan, MarketSnapshot, Positions } from '../lib/types'
import { useActionFlow, useSwapQuote } from '../lib/hooks'
import { estimatePostTradeProportion, planBuy, planSell } from '../lib/swaps'
import type { SwapSide } from '../lib/swaps'
import { AmountInput } from './AmountInput'
import { parseAmount } from './parseAmount'
import { TxStatus } from './TxStatus'
import { TxButton } from './TxButton'
import { clampLabel, formatAmount, formatPercent, shortAddress } from './format'
import { applySlippage, useSlippage } from './prefs'
import { findWalletBalance, isNativeEth, sameAddress, useTokenMetas } from './tokens'

type TradeAction = 'buy' | 'sell'
/** Select value: the SY itself, or a tokensIn/tokensOut address. */
const SY_CHOICE = 'sy'

/**
 * Effective slippage floor on static-derived min-out (PARITY.md: YT-direction
 * statics over-quote within approx-search noise; ≥ 0.01% haircut required —
 * we enforce 0.05%, matching lib/swaps' documented rule).
 */
const SLIPPAGE_FLOOR = 0.0005
/** Pre-emptive shallow-pool warning above this fraction of pool TVL. */
const LARGE_TRADE_TVL_FRACTION = 0.2
/** Amber warning above this projected post-trade PT proportion. */
const PROPORTION_WARN = 0.9
/** The AMM's hard PT-proportion cap — block the plan past it. */
const PROPORTION_CAP = 0.96
/** Guard for the /ytPrice pre-quote fallbacks: skip when YT is priced ~0. */
const MIN_YT_PRICE = 1e-6

/** Price-impact severity tiers (fraction thresholds). */
type ImpactTier = 'neutral' | 'amber-text' | 'amber-banner' | 'red-banner'

function impactTierOf(impact: number): ImpactTier {
  const abs = Math.abs(impact)
  if (abs < 0.005) return 'neutral'
  if (abs < 0.01) return 'amber-text'
  if (abs <= 0.05) return 'amber-banner'
  return 'red-banner'
}

const MODE_COPY: Record<`${TradeAction}-${SwapSide}`, string> = {
  'buy-pt':
    'Buying PT locks in the current implied rate — each PT redeems for 1 unit of the accounting asset at maturity.',
  'buy-yt':
    'Buying YT is a leveraged bet on yield — YT collects the underlying yield until expiry, then expires worthless.',
  'sell-pt':
    'Selling PT swaps it back through the pool at the current implied rate, before maturity.',
  'sell-yt':
    'Selling YT exits the yield position through the pool, before expiry.',
}

export function TradePanel({
  snapshot,
  positions,
  refetchPositions,
  onBusyChange,
}: {
  snapshot: MarketSnapshot
  positions?: Positions
  refetchPositions: () => void
  /** Reports the in-flight-send freeze (approving/signing/pending) upward — ActionTabs disables SlippageControl with it. */
  onBusyChange?: (busy: boolean) => void
}) {
  const { sy } = snapshot
  const { address: user, isConnected } = useAccount()
  const [slippage] = useSlippage()

  const [action, setAction] = useState<TradeAction>('buy')
  const [side, setSide] = useState<SwapSide>('pt')
  const [choiceByAction, setChoiceByAction] = useState<Partial<Record<TradeAction, string>>>({})
  const [amountText, setAmountText] = useState('')

  // Token select: buys pay with SY or a tokensIn entry; sells receive SY or a
  // tokensOut entry. Choice is remembered per action (like M2's per-direction).
  const tokenList = action === 'buy' ? sy.tokensIn : sy.tokensOut
  const metas = useTokenMetas([...sy.tokensIn, ...sy.tokensOut])
  const rawChoice = choiceByAction[action] ?? SY_CHOICE
  const choiceIsSy =
    rawChoice === SY_CHOICE || !tokenList.some((t) => sameAddress(t, rawChoice))
  const token = choiceIsSy ? undefined : (rawChoice as Address)
  const tokenMeta = token !== undefined ? metas[token.toLowerCase()] : undefined
  const tokenSymbol =
    tokenMeta?.symbol ?? (token !== undefined ? shortAddress(token) : sy.symbol)

  // PT/YT amounts are raw at assetDecimals (M2 pyDecimals rule).
  const pySymbol = side === 'pt' ? snapshot.ptSymbol || 'PT' : snapshot.ytSymbol || 'YT'
  const pyDecimals = sy.assetDecimals

  // The "pay with"/"receive" token side (SY or a tokensIn/Out entry).
  const paySymbol = choiceIsSy ? sy.symbol : tokenSymbol
  const payDecimals = choiceIsSy ? sy.decimals : tokenMeta?.decimals

  // Input side: buys spend the pay token; sells spend PT/YT.
  const inSymbol = action === 'buy' ? paySymbol : pySymbol
  const inDecimals = action === 'buy' ? payDecimals : pyDecimals
  const inIsNative = action === 'buy' && token !== undefined && isNativeEth(token)
  const balance = (() => {
    if (action === 'sell') {
      // Single source with PositionsCard: usePositions' pt/yt balances.
      if (positions === undefined) return undefined
      return side === 'pt' ? positions.pt : positions.yt
    }
    if (choiceIsSy) return positions?.sy
    return token !== undefined ? findWalletBalance(positions, token) : undefined
  })()

  // Output side: buys receive PT/YT; sells receive the chosen token.
  const outSymbol = action === 'buy' ? pySymbol : paySymbol
  const outDecimals = action === 'buy' ? pyDecimals : payDecimals

  const parsed = inDecimals !== undefined ? parseAmount(amountText, inDecimals) : {}
  const amount = parsed.amount

  // Effective slippage with the 0.05% floor (see header) — shapes minOut AND
  // the quote's synthesized ApproxParams bounds (guessMin scales with it, so
  // a pool move within tolerance can't strand the on-chain approx search).
  const effectiveSlippage = Math.max(slippage, SLIPPAGE_FLOOR)
  const slippageFloored = slippage < SLIPPAGE_FLOOR

  // Quote via the hook contract (debounce lives inside; SY variants take the
  // SY address; undefined inputs → 'idle').
  const quoteToken = choiceIsSy ? sy.address : token
  const quoteAmount = amount !== undefined && amount > 0n ? amount : undefined
  const {
    status: quoteStatus,
    quote,
    error: quoteError,
    refetch: refetchQuote,
  } = useSwapQuote(snapshot, side, action, quoteToken, quoteAmount, effectiveSlippage)
  const quoteLoading = quoteAmount !== undefined && quoteStatus === 'loading'
  const quoteUnavailable = quoteAmount !== undefined && quoteStatus === 'error'

  // minOut with the floored slippage. Noted in the UI when the user's
  // setting is below the floor.
  const minOut = quote !== undefined ? applySlippage(quote.amountOut, effectiveSlippage) : undefined

  // Pre-emptive shallow-pool guard: approximate the trade's face size in
  // accounting-asset terms and compare against pool TVL. Face value (not
  // price-weighted) on purpose — YT swaps move an equivalent PT face amount
  // through the pool, so face size is what stresses the proportion cap.
  const largeTradeRatio = useMemo((): number | undefined => {
    const tvl = snapshot.metrics.tvlAsset
    if (!Number.isFinite(tvl) || tvl <= 0) return undefined
    let faceAsset: number | undefined
    if (action === 'sell') {
      if (amount !== undefined && amount > 0n) {
        faceAsset = Number(formatUnits(amount, pyDecimals))
      }
    } else if (quote !== undefined) {
      faceAsset = Number(formatUnits(quote.amountOut, pyDecimals))
    } else if (choiceIsSy && amount !== undefined && amount > 0n) {
      // No quote yet, but SY converts to asset terms directly (same raw-first
      // convention as PositionsCard's ≈-asset line). A YT buy moves
      // ~payValue/ytPrice of PT face through the pool, so scale it up
      // (guarding near-zero YT prices).
      const payAsset = Number(
        formatUnits((amount * sy.exchangeRate) / 10n ** 18n, sy.assetDecimals),
      )
      if (side === 'yt') {
        const ytPrice = snapshot.metrics.ytPriceAsset
        faceAsset =
          Number.isFinite(ytPrice) && ytPrice > MIN_YT_PRICE ? payAsset / ytPrice : undefined
      } else {
        faceAsset = payAsset
      }
    }
    if (faceAsset === undefined || !Number.isFinite(faceAsset)) return undefined
    return faceAsset / tvl
  }, [snapshot.metrics.tvlAsset, snapshot.metrics.ytPriceAsset, action, side, amount, quote, choiceIsSy, pyDecimals, sy.exchangeRate, sy.assetDecimals])
  const largeTrade =
    largeTradeRatio !== undefined && largeTradeRatio > LARGE_TRADE_TVL_FRACTION

  // Projected post-trade PT proportion for the cap-risk directions: YT buys
  // and PT sells both ADD ~PT-face to the pool, and the AMM hard-reverts past
  // the 0.96 proportion cap. Buys approximate the PT flow with the quoted
  // YT out (pre-quote SY fallback: payValue/ytPrice, guarding tiny prices);
  // PT sells use the input amount directly.
  const projectedProportion = useMemo((): number | undefined => {
    const capRisk = (action === 'buy' && side === 'yt') || (action === 'sell' && side === 'pt')
    if (!capRisk) return undefined
    let amountPyApprox: bigint | undefined
    if (action === 'sell') {
      if (amount !== undefined && amount > 0n) amountPyApprox = amount
    } else if (quote !== undefined) {
      amountPyApprox = quote.amountOut
    } else if (choiceIsSy && amount !== undefined && amount > 0n) {
      const ytPrice = snapshot.metrics.ytPriceAsset
      if (Number.isFinite(ytPrice) && ytPrice > MIN_YT_PRICE) {
        const assetRaw = (amount * sy.exchangeRate) / 10n ** 18n
        amountPyApprox = (assetRaw * 1_000_000n) / BigInt(Math.round(ytPrice * 1e6))
      }
    }
    if (amountPyApprox === undefined || amountPyApprox <= 0n) return undefined
    return estimatePostTradeProportion(snapshot, side, action, amountPyApprox)
  }, [action, side, amount, quote, choiceIsSy, snapshot, sy.exchangeRate])
  const capBlocked = projectedProportion !== undefined && projectedProportion > PROPORTION_CAP

  const impactTier = quote !== undefined ? impactTierOf(quote.priceImpact) : undefined

  // Build the plan only when every wire-up rule passes (M2 convention).
  const { plan, reason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (!isConnected || user === undefined) return { plan: null, reason: null } // TxButton → Connect wallet
    if (inDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    // Output token metadata unknown (sell to an unreadable token): refuse to
    // plan rather than displaying min-out/quotes with a guessed 18 decimals.
    if (outDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    if (parsed.error) return { plan: null, reason: 'Fix the amount' }
    if (amount === undefined || amount === 0n) return { plan: null, reason: 'Enter an amount' }
    if (balance === undefined) return { plan: null, reason: 'Loading balances…' }
    if (amount > balance) {
      return { plan: null, reason: `Insufficient ${clampLabel(inSymbol, 16)}` }
    }
    // Cap pre-check (before the quote gates: the pre-quote projection blocks
    // even while a doomed quote is still loading or has already failed).
    if (capBlocked) {
      return { plan: null, reason: "Exceeds the pool's 0.96 PT-proportion cap — reduce the size" }
    }
    if (quoteLoading) return { plan: null, reason: 'Fetching quote…' }
    // Covers quote errors AND the pre-integration 'idle' stub — disabled, not broken.
    if (quote === undefined || minOut === undefined) {
      return { plan: null, reason: 'Quote unavailable' }
    }
    try {
      const tradeToken = choiceIsSy ? sy.address : token!
      const tradeTokenSymbol = choiceIsSy ? sy.symbol : tokenSymbol
      const built =
        action === 'buy'
          ? planBuy(
              snapshot, side, tradeToken, tradeTokenSymbol, payDecimals!,
              amount, minOut, quote.approx, user,
            )
          : planSell(
              snapshot, side, tradeToken, tradeTokenSymbol, payDecimals!,
              amount, minOut, user,
            )
      return { plan: built, reason: null }
    } catch {
      // Data-layer skeletons still throw — disabled, not broken.
      return { plan: null, reason: 'Action unavailable' }
    }
  }, [
    isConnected, user, inDecimals, outDecimals, parsed.error, amount, balance, inSymbol,
    capBlocked, quoteLoading, quote, minOut, choiceIsSy, sy.address, sy.symbol, token,
    tokenSymbol, action, side, snapshot, payDecimals,
  ])

  const flow = useActionFlow(plan)

  // Belt-and-braces for the send latch in useActionFlow: freeze every input
  // that could rebuild the plan while a transaction is being signed/mined.
  const flowBusy =
    flow.phase === 'approving' || flow.phase === 'signing' || flow.phase === 'pending'
  useEffect(() => {
    onBusyChange?.(flowBusy)
    return () => onBusyChange?.(false)
  }, [flowBusy, onBusyChange])

  // A failed flow usually means the pool moved from under the quote (stale
  // ApproxParams / min-out) — refresh it so the rebuilt plan simulates
  // against current state. refetchQuote is identity-stable (hook contract),
  // so this fires once per entry into 'failed'.
  useEffect(() => {
    if (flow.phase === 'failed') refetchQuote()
  }, [flow.phase, refetchQuote])

  const onDone = () => {
    flow.reset()
    refetchPositions() // market snapshot refetch rides useActionFlow's ['market'] invalidation
    setAmountText('')
  }

  const toggleClass = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
      active ? 'rounded-[8px] bg-surface shadow-[var(--op-shadow)] text-fg' : 'text-muted hover:text-fg'
    }`

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-[10px] bg-surface-2 p-0.5">
            {(
              [
                ['buy', 'Buy'],
                ['sell', 'Sell'],
              ] as const
            ).map(([a, label]) => (
              <button
                key={a}
                type="button"
                disabled={flowBusy}
                onClick={() => {
                  setAction(a)
                  setAmountText('')
                }}
                className={toggleClass(action === a)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-[10px] bg-surface-2 p-0.5">
            {(
              [
                ['pt', 'PT'],
                ['yt', 'YT'],
              ] as const
            ).map(([s, label]) => (
              <button
                key={s}
                type="button"
                disabled={flowBusy}
                onClick={() => {
                  setSide(s)
                  setAmountText('')
                }}
                className={toggleClass(side === s)}
                title={s === 'pt' ? snapshot.ptSymbol : snapshot.ytSymbol}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-faint">
          {action === 'buy' ? 'Pay with' : 'Receive'}
          <select
            value={choiceIsSy ? SY_CHOICE : token}
            disabled={flowBusy}
            onChange={(e) => {
              setChoiceByAction((prev) => ({ ...prev, [action]: e.target.value }))
              setAmountText('')
            }}
            className="rounded-md border border-hairline-strong bg-bg px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value={SY_CHOICE}>{clampLabel(sy.symbol, 24)} (SY)</option>
            {tokenList.map((t) => {
              const m = metas[t.toLowerCase()]
              return (
                <option key={t} value={t}>
                  {clampLabel(m?.symbol ?? shortAddress(t), 24)}
                </option>
              )
            })}
          </select>
        </label>
      </div>

      <p className="text-xs leading-relaxed text-faint">{MODE_COPY[`${action}-${side}`]}</p>

      <AmountInput
        label={action === 'buy' ? 'You pay' : 'You sell'}
        value={amountText}
        onChange={setAmountText}
        symbol={inSymbol}
        decimals={inDecimals}
        balance={balance}
        isNative={inIsNative}
        disabled={flowBusy}
        error={parsed.error}
      />

      {/* No quote card when the output token's decimals are unknown — a
          fallback of 18 would render confidently wrong numbers. */}
      {outDecimals !== undefined && (
        <div className="rounded-lg border border-hairline bg-bg-2 px-3 py-2.5 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-faint">You receive (estimated)</span>
            <span className="font-medium text-fg">
              {quoteLoading ? (
                <span className="text-faint">…</span>
              ) : quoteUnavailable ? (
                <span className="text-warn">quote unavailable</span>
              ) : quote !== undefined ? (
                `~${formatAmount(quote.amountOut, outDecimals)} ${clampLabel(outSymbol, 16)}`
              ) : (
                '—'
              )}
            </span>
          </div>

          <div className="mt-1 flex items-baseline justify-between gap-3">
            <span className="text-faint">
              Min after {formatPercent(effectiveSlippage)} slippage
              {slippageFloored && <span className="text-faint"> (min 0.05%)</span>}
            </span>
            <span className="text-muted">
              {!quoteLoading && !quoteUnavailable && minOut !== undefined
                ? `${formatAmount(minOut, outDecimals)} ${clampLabel(outSymbol, 16)}`
                : '—'}
            </span>
          </div>

          {quote !== undefined && (
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <span className="text-faint">Price impact</span>
              <span
                className={
                  impactTier === 'neutral'
                    ? 'text-muted'
                    : impactTier === 'red-banner'
                      ? 'font-medium text-danger'
                      : 'font-medium text-warn'
                }
              >
                {formatPercent(quote.priceImpact)}
              </span>
            </div>
          )}

          {quote?.impliedApyAfter !== undefined && (
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <span className="text-faint">Implied APY after trade</span>
              <span className="text-muted">
                {formatPercent(snapshot.metrics.impliedApy)}{' '}
                <span aria-hidden className="text-faint">→</span>{' '}
                <span className="text-muted">{formatPercent(quote.impliedApyAfter)}</span>
              </span>
            </div>
          )}

          {quote !== undefined && (
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <span className="text-faint">Market swap fee</span>
              <span className="text-muted">
                {formatAmount(quote.netSyFee, sy.decimals)} {clampLabel(sy.symbol, 16)}
              </span>
            </div>
          )}

          <p className="mt-1.5 text-[11px] leading-snug text-faint">
            Estimated from RouterStatic — the final number is simulated before you confirm.
            {slippageFloored &&
              ' Your slippage setting is below the 0.05% floor applied to static-derived minimums.'}
          </p>
        </div>
      )}

      {/* Quote errors run through decodePendleError in useSwapQuote, so the
          revert families arrive pre-translated (e.g. "Trade too large… or the
          quote went stale" from 'search range overflow' / APPROX_EXHAUSTED). */}
      {quoteUnavailable && quoteError && (
        <div className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs text-warn">
          <span className="font-semibold text-warn">Quote failed:</span> {quoteError}
        </div>
      )}

      {/* PT-proportion cap projection (primary guard); the TVL-fraction note
          below stays as a secondary heuristic. */}
      {projectedProportion !== undefined && projectedProportion > PROPORTION_WARN && (
        <div className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs text-warn">
          {capBlocked ? (
            <>
              <span className="font-semibold text-warn">
                Exceeds the pool's PT-proportion cap:
              </span>{' '}
              this trade would push the pool's PT share to ~
              {formatPercent(Math.min(projectedProportion, 1))}, past the 0.96 hard cap the AMM
              enforces. Reduce the size.
            </>
          ) : (
            <>
              <span className="font-semibold text-warn">
                Approaching the pool's PT-proportion cap:
              </span>{' '}
              this trade would push the pool's PT share to ~{formatPercent(projectedProportion)},
              near the 0.96 cap where trades start reverting. Consider a smaller size.
            </>
          )}
        </div>
      )}

      {largeTrade && largeTradeRatio !== undefined && (
        <div className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs text-warn">
          <span className="font-semibold text-warn">
            Large trade for this pool's liquidity
          </span>{' '}
          — roughly {formatPercent(Math.min(largeTradeRatio, 9.99))} of pool TVL. Expect heavy
          price impact or a failed quote; consider splitting it into smaller trades.
        </div>
      )}

      {impactTier === 'amber-banner' && quote !== undefined && (
        <div className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs text-warn">
          <span className="font-semibold text-warn">High price impact:</span> this trade
          moves the pool price by {formatPercent(quote.priceImpact)}. Consider a smaller size.
        </div>
      )}

      {impactTier === 'red-banner' && quote !== undefined && (
        <div className="rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-3 py-2 text-xs text-red-200/90">
          <span className="font-semibold text-danger">
            Very high price impact ({formatPercent(quote.priceImpact)}):
          </span>{' '}
          you will likely lose money to price impact. Reduce the trade size — this pool is too
          shallow for it.
        </div>
      )}

      <TxButton
        flow={flow}
        actionLabel={`${action} ${side === 'pt' ? 'PT' : 'YT'}`}
        disabledReason={reason}
        onDone={onDone}
        onRetry={() => {
          // Retry against a FRESH quote — the failure usually means the pool
          // moved from under the one the failed plan was built on.
          refetchQuote()
          flow.reset()
        }}
      />
      <TxStatus
        flow={flow}
        out={
          outDecimals !== undefined
            ? { symbol: outSymbol, decimals: outDecimals, minOut }
            : undefined
        }
      />
    </div>
  )
}
