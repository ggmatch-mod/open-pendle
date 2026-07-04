/**
 * LiquidityPanel (M4) — add/remove pool liquidity through the router.
 * Two-axis mode: Add | Remove × Balanced | Zap.
 *
 * - Balanced add: two LINKED inputs (pay side: SY or a tokensIn entry; PT
 *   side). The last-edited side is the "fixed" one fed to useDualAddPreview;
 *   the other renders the derived amount with an "auto" tag. Token pay legs
 *   wrap via previewDeposit (token → SY) and can't be inverted client-side
 *   (PT → token units), so with a token selected the PT side is derived-only.
 *   Pro-rata math — no swap, no price impact. Needs BOTH balances.
 * - Zap in: single token (SY or tokensIn) via useZapQuote('in'); the "Keep YT"
 *   checkbox switches to the KeepYt router variants (LP + YT out). minYtOut
 *   is undefined-safe: only set when keepYt and the quote carries ytOut.
 * - Balanced remove: LP in → SY + PT pro-rata (previewDualRemove, pure sync,
 *   try/caught while the data-layer skeleton throws). Targets SY — unwrap to
 *   tokens on the Wrap / Unwrap tab.
 * - Zap out: LP in → single token (SY or tokensOut) via useZapQuote('out').
 *
 * Zap quotes reuse TradePanel's conventions: price-impact severity tiers,
 * netSyFee line, effectiveSlippage with the 0.05% floor on every min-out
 * (PARITY.md haircut rule), quote-failure banner with the decoded error
 * verbatim. All flows drive useActionFlow: plans build only for valid,
 * positive, ≤-balance inputs with a live quote/preview; plan builders may
 * throw (skeletons until integration) — caught and rendered as a disabled
 * button. Inputs freeze while a send is in flight (onBusyChange). Removes
 * approve the LP token (= the market address) — the approval button shows
 * whatever symbol the data layer resolves for it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import type {
  ActionPlan,
  DualRemovePreview,
  MarketSnapshot,
  Positions,
  SwapQuote,
} from '../lib/types'
import { useActionFlow, useDualAddPreview, useZapQuote } from '../lib/hooks'
import {
  planDualAdd,
  planDualRemove,
  planZapIn,
  planZapOut,
  previewDualRemove,
} from '../lib/liquidity'
import { AmountInput } from './AmountInput'
import { parseAmount } from './parseAmount'
import { TxStatus } from './TxStatus'
import { TxButton } from './TxButton'
import { clampLabel, formatAmount, formatPercent, shortAddress } from './format'
import { applySlippage, useSlippage } from './prefs'
import type { TokenMeta } from './tokens'
import { findWalletBalance, isNativeEth, sameAddress, useTokenMetas } from './tokens'

type LiquidityMode = 'add' | 'remove'
type SubMode = 'balanced' | 'zap'

/** Select value: the SY itself, or a tokensIn/tokensOut address. */
const SY_CHOICE = 'sy'
/** Pendle market LP is a standard 18-decimals ERC-20 (PendleERC20). */
const LP_DECIMALS = 18
const LP_SYMBOL = 'LP'
/**
 * Effective slippage floor on static-derived min-outs (PARITY.md haircut
 * rule) — same 0.05% the TradePanel enforces.
 */
const SLIPPAGE_FLOOR = 0.0005

const MODE_COPY: Record<`${LiquidityMode}-${SubMode}`, string> = {
  'add-balanced':
    "Deposits both sides at the pool's current ratio — no swap involved, so balanced adds have no price impact.",
  'add-zap':
    'Deposits a single token — the router mints and swaps internally to build the LP position, so price impact applies.',
  'remove-balanced':
    'Burns LP for its pro-rata share of both sides (SY + PT) — no swap involved, so no price impact.',
  'remove-zap':
    'Burns LP into a single token — the PT side is sold through the pool, so price impact applies.',
}

/**
 * Zap-in explainer when Keep YT is ticked — the KeepYt path does NO AMM swap
 * (part of the deposit is minted into PT + YT and dual-added at the pool
 * ratio), so the generic 'add-zap' price-impact copy would be wrong for it.
 */
const ADD_ZAP_KEEP_YT_COPY =
  'Deposits a single token — part of it is minted into PT + YT and both sides are added at ' +
  "the pool's current ratio. No AMM swap, so no price impact; you keep the YT alongside your LP."

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

interface FormProps {
  snapshot: MarketSnapshot
  positions?: Positions
  refetchPositions: () => void
  onBusyChange: (busy: boolean) => void
}

function useEffectiveSlippage(): { effectiveSlippage: number; slippageFloored: boolean } {
  const [slippage] = useSlippage()
  return {
    effectiveSlippage: Math.max(slippage, SLIPPAGE_FLOOR),
    slippageFloored: slippage < SLIPPAGE_FLOOR,
  }
}

/** Report the in-flight-send freeze upward (ActionTabs + panel toggles). */
function useBusyFreeze(
  flow: ReturnType<typeof useActionFlow>,
  onBusyChange: (busy: boolean) => void,
): boolean {
  const flowBusy =
    flow.phase === 'approving' || flow.phase === 'signing' || flow.phase === 'pending'
  useEffect(() => {
    onBusyChange(flowBusy)
    return () => onBusyChange(false)
  }, [flowBusy, onBusyChange])
  return flowBusy
}

/**
 * bigint → plain input text for the DERIVED side of the linked inputs
 * (unformatted — no grouping, capped fraction so the field stays readable).
 * Display only: plans always use the raw preview bigint, never re-parse this.
 */
function displayUnits(amount: bigint | undefined, decimals: number): string {
  if (amount === undefined) return ''
  const s = formatUnits(amount, decimals)
  const dot = s.indexOf('.')
  if (dot === -1) return s
  const trimmed = s.slice(0, dot + 9).replace(/\.?0+$/, '')
  return trimmed === '' ? '0' : trimmed
}

/** Price-impact severity tiers — same thresholds/conventions as TradePanel. */
type ImpactTier = 'neutral' | 'amber-text' | 'amber-banner' | 'red-banner'

function impactTierOf(impact: number): ImpactTier {
  const abs = Math.abs(impact)
  if (abs < 0.005) return 'neutral'
  if (abs < 0.01) return 'amber-text'
  if (abs <= 0.05) return 'amber-banner'
  return 'red-banner'
}

function TokenSelect({
  label,
  value,
  onChange,
  tokens,
  metas,
  sySymbol,
  disabled,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  tokens: readonly Address[]
  metas: Record<string, TokenMeta>
  sySymbol: string
  disabled: boolean
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-faint">
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-hairline-strong bg-bg px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value={SY_CHOICE}>{clampLabel(sySymbol, 24)} (SY)</option>
        {tokens.map((t) => {
          const m = metas[t.toLowerCase()]
          return (
            <option key={t} value={t}>
              {clampLabel(m?.symbol ?? shortAddress(t), 24)}
            </option>
          )
        })}
      </select>
    </label>
  )
}

/** Amber "Quote failed: …" banner — decoded error string rendered verbatim. */
function QuoteFailedBanner({ label, error }: { label: string; error?: string }) {
  if (!error) return null
  return (
    <div className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs text-warn">
      <span className="font-semibold text-warn">{label}:</span> {error}
    </div>
  )
}

/** High/very-high price-impact banners (same tiers as TradePanel). */
function ImpactBanners({ quote }: { quote?: SwapQuote }) {
  if (quote === undefined) return null
  const tier = impactTierOf(quote.priceImpact)
  if (tier === 'amber-banner') {
    return (
      <div className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs text-warn">
        <span className="font-semibold text-warn">High price impact:</span> this zap moves
        the pool price by {formatPercent(quote.priceImpact)}. Consider a smaller size — or a
        balanced add/remove, which has none.
      </div>
    )
  }
  if (tier === 'red-banner') {
    return (
      <div className="rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-3 py-2 text-xs text-red-200/90">
        <span className="font-semibold text-danger">
          Very high price impact ({formatPercent(quote.priceImpact)}):
        </span>{' '}
        you will likely lose money to price impact. Reduce the size — or use the balanced flow,
        which has none.
      </div>
    )
  }
  return null
}

/** Zap quote card: out estimate, min after slippage, impact tier, fee line. */
function ZapQuoteCard({
  loading,
  unavailable,
  quote,
  outSymbol,
  outDecimals,
  minOut,
  effectiveSlippage,
  slippageFloored,
  sySymbol,
  syDecimals,
  ytRow,
}: {
  loading: boolean
  unavailable: boolean
  quote?: SwapQuote
  outSymbol: string
  outDecimals: number
  minOut?: bigint
  effectiveSlippage: number
  slippageFloored: boolean
  sySymbol: string
  syDecimals: number
  /** KeepYt zap-ins: the YT amount kept alongside LP. */
  ytRow?: { symbol: string; decimals: number }
}) {
  const impactTier = quote !== undefined ? impactTierOf(quote.priceImpact) : undefined
  return (
    <div className="rounded-lg border border-hairline bg-bg-2 px-3 py-2.5 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-faint">You receive (estimated)</span>
        <span className="font-medium text-fg">
          {loading ? (
            <span className="text-faint">…</span>
          ) : unavailable ? (
            <span className="text-warn">quote unavailable</span>
          ) : quote !== undefined ? (
            `~${formatAmount(quote.amountOut, outDecimals)} ${clampLabel(outSymbol, 16)}`
          ) : (
            '—'
          )}
        </span>
      </div>

      {ytRow && (
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-faint">YT kept (estimated)</span>
          <span className="font-medium text-fg">
            {!loading && !unavailable && quote?.ytOut !== undefined
              ? `~${formatAmount(quote.ytOut, ytRow.decimals)} ${clampLabel(ytRow.symbol, 16)}`
              : '—'}
          </span>
        </div>
      )}

      <div className="mt-1 flex items-baseline justify-between gap-3">
        <span className="text-faint">
          Min after {formatPercent(effectiveSlippage)} slippage
          {slippageFloored && <span className="text-faint"> (min 0.05%)</span>}
        </span>
        <span className="text-muted">
          {!loading && !unavailable && minOut !== undefined
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

      {quote !== undefined && (
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-faint">Market swap fee</span>
          <span className="text-muted">
            {formatAmount(quote.netSyFee, syDecimals)} {clampLabel(sySymbol, 16)}
          </span>
        </div>
      )}

      <p className="mt-1.5 text-[11px] leading-snug text-faint">
        Estimated from RouterStatic — the final number is simulated before you confirm.
        {slippageFloored &&
          ' Your slippage setting is below the 0.05% floor applied to static-derived minimums.'}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Balanced add — linked pay/PT inputs via useDualAddPreview
// ---------------------------------------------------------------------------

function BalancedAddForm({ snapshot, positions, refetchPositions, onBusyChange }: FormProps) {
  const { sy } = snapshot
  const { address: user, isConnected } = useAccount()
  const { effectiveSlippage, slippageFloored } = useEffectiveSlippage()

  const [payChoice, setPayChoice] = useState<string>(SY_CHOICE)
  const [payText, setPayText] = useState('')
  const [ptText, setPtText] = useState('')
  const [fixedSide, setFixedSide] = useState<'pay' | 'pt'>('pay')

  const metas = useTokenMetas(sy.tokensIn)
  const choiceIsSy =
    payChoice === SY_CHOICE || !sy.tokensIn.some((t) => sameAddress(t, payChoice))
  const token = choiceIsSy ? undefined : (payChoice as Address)
  const tokenMeta = token !== undefined ? metas[token.toLowerCase()] : undefined
  const paySymbol =
    token !== undefined ? (tokenMeta?.symbol ?? shortAddress(token)) : sy.symbol
  const payDecimals = choiceIsSy ? sy.decimals : tokenMeta?.decimals
  const payIsNative = token !== undefined && isNativeEth(token)
  const ptSymbol = snapshot.ptSymbol || 'PT'
  const ptDecimals = sy.assetDecimals

  // Token pay legs wrap via previewDeposit (token → SY) and can't be inverted
  // client-side (PT → token units), so the PT side is derived-only for token
  // pay; with SY both inputs are editable and the last-edited side is fixed.
  const ptEditable = choiceIsSy
  const effFixed: 'pay' | 'pt' = ptEditable && fixedSide === 'pt' ? 'pt' : 'pay'

  const parsedPay = payDecimals !== undefined ? parseAmount(payText, payDecimals) : {}
  const parsedPt = parseAmount(ptText, ptDecimals)
  const fixedParsed = effFixed === 'pay' ? parsedPay : parsedPt
  const fixedAmount =
    fixedParsed.amount !== undefined && fixedParsed.amount > 0n
      ? fixedParsed.amount
      : undefined

  const {
    status: previewStatus,
    preview,
    error: previewError,
  } = useDualAddPreview(
    snapshot,
    effFixed === 'pt' ? 'pt' : choiceIsSy ? 'sy' : 'token',
    token,
    fixedAmount,
  )
  const previewLoading = fixedAmount !== undefined && previewStatus === 'loading'
  const previewUnavailable = fixedAmount !== undefined && previewStatus === 'error'

  const derivedPay = effFixed === 'pt' ? preview?.syDesired : undefined
  const derivedPt = effFixed === 'pay' ? preview?.ptDesired : undefined
  const payAmount = effFixed === 'pay' ? fixedAmount : derivedPay
  const ptAmount = effFixed === 'pt' ? fixedAmount : derivedPt

  // The derived input renders the preview's amount (its own text state is
  // stale and ignored until the user edits it, which flips the fixed side).
  const payValue =
    effFixed === 'pay' ? payText : displayUnits(derivedPay, payDecimals ?? LP_DECIMALS)
  const ptValue = effFixed === 'pt' ? ptText : displayUnits(derivedPt, ptDecimals)

  const payBalance = choiceIsSy
    ? positions?.sy
    : token !== undefined
      ? findWalletBalance(positions, token)
      : undefined
  const ptBalance = positions?.pt

  const minLpOut =
    preview !== undefined ? applySlippage(preview.lpOutEstimate, effectiveSlippage) : undefined

  // Share-of-pool row: with the wallet's positions loaded, show the TRUE
  // post-add share ((your LP + new LP) / (total LP + new LP)); without a
  // wallet/positions, fall back to the deposit-only number — labeled
  // accordingly so neither reads as the other.
  const shareLabel =
    positions !== undefined ? 'Your share of pool after' : "This deposit's share of pool"
  const shareValue = useMemo((): number | undefined => {
    if (preview === undefined) return undefined
    if (positions === undefined) return preview.shareOfPoolAfter
    const den = snapshot.state.totalLp + preview.lpOutEstimate
    if (den <= 0n) return 0
    const share = Number(positions.lp + preview.lpOutEstimate) / Number(den)
    return Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0
  }, [preview, positions, snapshot.state.totalLp])

  const { plan, reason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (!isConnected || user === undefined) return { plan: null, reason: null } // TxButton → Connect wallet
    if (payDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    if (fixedParsed.error) return { plan: null, reason: 'Fix the amount' }
    if (fixedAmount === undefined) return { plan: null, reason: 'Enter an amount' }
    if (previewLoading) return { plan: null, reason: 'Computing the other side…' }
    // Covers preview errors AND the pre-integration 'idle' stub.
    if (
      preview === undefined ||
      payAmount === undefined ||
      ptAmount === undefined ||
      minLpOut === undefined
    ) {
      return { plan: null, reason: 'Preview unavailable' }
    }
    if (payAmount <= 0n || ptAmount <= 0n) return { plan: null, reason: 'Enter an amount' }
    // Dual adds need BOTH balances (pay side AND PT).
    if (payBalance === undefined || ptBalance === undefined) {
      return { plan: null, reason: 'Loading balances…' }
    }
    if (payAmount > payBalance) {
      return { plan: null, reason: `Insufficient ${clampLabel(paySymbol, 16)}` }
    }
    if (ptAmount > ptBalance) {
      return { plan: null, reason: `Insufficient ${clampLabel(ptSymbol, 16)}` }
    }
    try {
      const built = planDualAdd(
        snapshot,
        choiceIsSy ? sy.address : token!,
        paySymbol,
        payDecimals,
        payAmount,
        ptAmount,
        minLpOut,
        user,
      )
      return { plan: built, reason: null }
    } catch {
      // Data-layer skeletons still throw — disabled, not broken.
      return { plan: null, reason: 'Action unavailable' }
    }
  }, [
    isConnected, user, payDecimals, fixedParsed.error, fixedAmount, previewLoading, preview,
    payAmount, ptAmount, minLpOut, payBalance, ptBalance, paySymbol, ptSymbol, choiceIsSy,
    sy.address, token, snapshot,
  ])

  const flow = useActionFlow(plan)
  const flowBusy = useBusyFreeze(flow, onBusyChange)
  const queryClient = useQueryClient()

  // A failed flow usually means the pool ratio moved from under the preview
  // (stale derived side / min-LP-out) — the balanced "quote" is the market
  // snapshot itself, so refresh it (mirrors TradePanel's refetchQuote-on-
  // failed). The refetched snapshot re-keys useDualAddPreview via its state
  // fingerprint, so the rebuilt plan simulates against current numbers
  // instead of looping forever on the same stale ratio.
  useEffect(() => {
    if (flow.phase === 'failed') {
      void queryClient.invalidateQueries({ queryKey: ['market'] })
    }
  }, [flow.phase, queryClient])

  const onDone = () => {
    flow.reset()
    refetchPositions()
    setPayText('')
    setPtText('')
    setFixedSide('pay')
  }

  return (
    <div className="space-y-3.5">
      <div className="flex justify-end">
        <TokenSelect
          label="Pay with"
          value={choiceIsSy ? SY_CHOICE : payChoice}
          onChange={(next) => {
            setPayChoice(next)
            setPayText('')
            setPtText('')
            setFixedSide('pay')
          }}
          tokens={sy.tokensIn}
          metas={metas}
          sySymbol={sy.symbol}
          disabled={flowBusy}
        />
      </div>

      <AmountInput
        label={effFixed === 'pay' ? 'Pay side' : 'Pay side · auto'}
        value={payValue}
        onChange={(next) => {
          setPayText(next)
          setFixedSide('pay')
        }}
        symbol={paySymbol}
        decimals={payDecimals}
        balance={payBalance}
        isNative={payIsNative}
        disabled={flowBusy}
        error={effFixed === 'pay' ? parsedPay.error : undefined}
      />

      <AmountInput
        label={effFixed === 'pt' ? 'PT side' : 'PT side · auto'}
        value={ptValue}
        onChange={(next) => {
          if (!ptEditable) return
          setPtText(next)
          setFixedSide('pt')
        }}
        symbol={ptSymbol}
        decimals={ptDecimals}
        balance={ptBalance}
        disabled={flowBusy || !ptEditable}
        error={effFixed === 'pt' ? parsedPt.error : undefined}
        balanceHint={ptEditable ? undefined : 'auto — derived from the pay side'}
      />

      <div className="rounded-lg border border-hairline bg-bg-2 px-3 py-2.5 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-faint">LP out (estimated)</span>
          <span className="font-medium text-fg">
            {previewLoading ? (
              <span className="text-faint">…</span>
            ) : previewUnavailable ? (
              <span className="text-warn">preview unavailable</span>
            ) : preview !== undefined ? (
              `~${formatAmount(preview.lpOutEstimate, LP_DECIMALS)} ${LP_SYMBOL}`
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
            {!previewLoading && !previewUnavailable && minLpOut !== undefined
              ? `${formatAmount(minLpOut, LP_DECIMALS)} ${LP_SYMBOL}`
              : '—'}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-faint">{shareLabel}</span>
          <span className="text-muted">
            {!previewLoading && !previewUnavailable && shareValue !== undefined
              ? formatPercent(shareValue)
              : '—'}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-faint">
          Balanced adds have no price impact — both sides go in at the pool's current ratio.
        </p>
      </div>

      <QuoteFailedBanner label="Preview failed" error={previewUnavailable ? previewError : undefined} />

      <TxButton
        flow={flow}
        actionLabel="add liquidity"
        disabledReason={reason}
        onDone={onDone}
        onRetry={() => {
          // Retry against a FRESH snapshot — the preview's ratio derives from
          // it, and the failure usually means the pool moved from under it.
          void queryClient.invalidateQueries({ queryKey: ['market'] })
          flow.reset()
        }}
      />
      <TxStatus
        flow={flow}
        out={{ symbol: LP_SYMBOL, decimals: LP_DECIMALS, minOut: minLpOut }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Zap in — single token via useZapQuote('in'), optional KeepYt
// ---------------------------------------------------------------------------

function ZapInForm({
  snapshot,
  positions,
  refetchPositions,
  onBusyChange,
  keepYt,
  onKeepYtChange,
}: FormProps & {
  /** Lifted to LiquidityPanel so the mode explainer swaps with it (no-swap copy). */
  keepYt: boolean
  onKeepYtChange: (next: boolean) => void
}) {
  const { sy } = snapshot
  const { address: user, isConnected } = useAccount()
  const { effectiveSlippage, slippageFloored } = useEffectiveSlippage()

  const [choice, setChoice] = useState<string>(SY_CHOICE)
  const [amountText, setAmountText] = useState('')

  const metas = useTokenMetas(sy.tokensIn)
  const choiceIsSy = choice === SY_CHOICE || !sy.tokensIn.some((t) => sameAddress(t, choice))
  const token = choiceIsSy ? undefined : (choice as Address)
  const tokenMeta = token !== undefined ? metas[token.toLowerCase()] : undefined
  const inSymbol = token !== undefined ? (tokenMeta?.symbol ?? shortAddress(token)) : sy.symbol
  const inDecimals = choiceIsSy ? sy.decimals : tokenMeta?.decimals
  const inIsNative = token !== undefined && isNativeEth(token)
  const balance = choiceIsSy
    ? positions?.sy
    : token !== undefined
      ? findWalletBalance(positions, token)
      : undefined

  const parsed = inDecimals !== undefined ? parseAmount(amountText, inDecimals) : {}
  const amount = parsed.amount

  const quoteToken = choiceIsSy ? sy.address : token
  const quoteAmount = amount !== undefined && amount > 0n ? amount : undefined
  const {
    status: quoteStatus,
    quote,
    error: quoteError,
    refetch: refetchQuote,
  } = useZapQuote(snapshot, 'in', quoteToken, quoteAmount, keepYt, effectiveSlippage)
  const quoteLoading = quoteAmount !== undefined && quoteStatus === 'loading'
  const quoteUnavailable = quoteAmount !== undefined && quoteStatus === 'error'

  const minLpOut =
    quote !== undefined ? applySlippage(quote.amountOut, effectiveSlippage) : undefined
  // Undefined-safe: only bind a min-YT when keepYt AND the quote carries ytOut.
  const minYtOut =
    keepYt && quote?.ytOut !== undefined
      ? applySlippage(quote.ytOut, effectiveSlippage)
      : undefined

  const { plan, reason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (!isConnected || user === undefined) return { plan: null, reason: null } // TxButton → Connect wallet
    if (inDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    if (parsed.error) return { plan: null, reason: 'Fix the amount' }
    if (amount === undefined || amount === 0n) return { plan: null, reason: 'Enter an amount' }
    if (balance === undefined) return { plan: null, reason: 'Loading balances…' }
    if (amount > balance) {
      return { plan: null, reason: `Insufficient ${clampLabel(inSymbol, 16)}` }
    }
    if (quoteLoading) return { plan: null, reason: 'Fetching quote…' }
    // Covers quote errors AND the pre-integration 'idle' stub.
    if (quote === undefined || minLpOut === undefined) {
      return { plan: null, reason: 'Quote unavailable' }
    }
    try {
      const built = planZapIn(
        snapshot,
        choiceIsSy ? sy.address : token!,
        inSymbol,
        inDecimals,
        amount,
        minLpOut,
        minYtOut,
        quote.approx,
        keepYt,
        user,
      )
      return { plan: built, reason: null }
    } catch {
      // Data-layer skeletons still throw — disabled, not broken.
      return { plan: null, reason: 'Action unavailable' }
    }
  }, [
    isConnected, user, inDecimals, parsed.error, amount, balance, inSymbol, quoteLoading,
    quote, minLpOut, minYtOut, choiceIsSy, sy.address, token, keepYt, snapshot,
  ])

  const flow = useActionFlow(plan)
  const flowBusy = useBusyFreeze(flow, onBusyChange)

  // A failed flow usually means the pool moved from under the quote — refresh
  // it so the rebuilt plan simulates against current state.
  useEffect(() => {
    if (flow.phase === 'failed') refetchQuote()
  }, [flow.phase, refetchQuote])

  const onDone = () => {
    flow.reset()
    refetchPositions()
    setAmountText('')
  }

  return (
    <div className="space-y-3.5">
      <div className="flex justify-end">
        <TokenSelect
          label="Zap with"
          value={choiceIsSy ? SY_CHOICE : choice}
          onChange={(next) => {
            setChoice(next)
            setAmountText('')
          }}
          tokens={sy.tokensIn}
          metas={metas}
          sySymbol={sy.symbol}
          disabled={flowBusy}
        />
      </div>

      <AmountInput
        label="You deposit"
        value={amountText}
        onChange={setAmountText}
        symbol={inSymbol}
        decimals={inDecimals}
        balance={balance}
        isNative={inIsNative}
        disabled={flowBusy}
        error={parsed.error}
      />

      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={keepYt}
          disabled={flowBusy}
          onChange={(e) => onKeepYtChange(e.target.checked)}
          className="mt-0.5 accent-[var(--op-accent)] disabled:cursor-not-allowed"
        />
        <span className="leading-snug">
          <span className="font-medium text-muted">Keep YT</span>{' '}
          <span className="text-faint">
            — part of your deposit is minted into PT + YT; untick to sell the YT into more LP,
            tick to keep the YT position alongside your LP.
          </span>
        </span>
      </label>

      <ZapQuoteCard
        loading={quoteLoading}
        unavailable={quoteUnavailable}
        quote={quote}
        outSymbol={LP_SYMBOL}
        outDecimals={LP_DECIMALS}
        minOut={minLpOut}
        effectiveSlippage={effectiveSlippage}
        slippageFloored={slippageFloored}
        sySymbol={sy.symbol}
        syDecimals={sy.decimals}
        ytRow={
          keepYt
            ? { symbol: snapshot.ytSymbol || 'YT', decimals: sy.assetDecimals }
            : undefined
        }
      />

      <QuoteFailedBanner
        label="Quote failed"
        error={quoteUnavailable ? quoteError : undefined}
      />
      <ImpactBanners quote={quote} />

      <TxButton
        flow={flow}
        actionLabel={keepYt ? 'zap in (keep YT)' : 'zap in'}
        disabledReason={reason}
        onDone={onDone}
        onRetry={() => {
          refetchQuote()
          flow.reset()
        }}
      />
      <TxStatus
        flow={flow}
        out={{ symbol: LP_SYMBOL, decimals: LP_DECIMALS, minOut: minLpOut }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Balanced remove — LP → SY + PT pro-rata via previewDualRemove
// ---------------------------------------------------------------------------

function BalancedRemoveForm({ snapshot, positions, refetchPositions, onBusyChange }: FormProps) {
  const { sy } = snapshot
  const { address: user, isConnected } = useAccount()
  const { effectiveSlippage, slippageFloored } = useEffectiveSlippage()

  const [amountText, setAmountText] = useState('')
  const parsed = parseAmount(amountText, LP_DECIMALS)
  const amount = parsed.amount
  const balance = positions?.lp
  const ptSymbol = snapshot.ptSymbol || 'PT'

  // Pure sync pro-rata preview — try/caught while the skeleton still throws.
  const preview = useMemo((): DualRemovePreview | undefined => {
    if (amount === undefined || amount <= 0n) return undefined
    try {
      return previewDualRemove(snapshot, amount)
    } catch {
      return undefined
    }
  }, [snapshot, amount])

  const minSyOut =
    preview !== undefined ? applySlippage(preview.syOut, effectiveSlippage) : undefined
  const minPtOut =
    preview !== undefined ? applySlippage(preview.ptOut, effectiveSlippage) : undefined

  const { plan, reason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (!isConnected || user === undefined) return { plan: null, reason: null } // TxButton → Connect wallet
    if (parsed.error) return { plan: null, reason: 'Fix the amount' }
    if (amount === undefined || amount === 0n) return { plan: null, reason: 'Enter an amount' }
    if (balance === undefined) return { plan: null, reason: 'Loading balances…' }
    if (amount > balance) return { plan: null, reason: 'Insufficient LP' }
    // Covers the pre-integration throwing skeleton.
    if (preview === undefined || minSyOut === undefined || minPtOut === undefined) {
      return { plan: null, reason: 'Preview unavailable' }
    }
    try {
      const built = planDualRemove(
        snapshot,
        sy.address,
        sy.symbol,
        sy.decimals,
        amount,
        minSyOut,
        minPtOut,
        user,
      )
      return { plan: built, reason: null }
    } catch {
      // Data-layer skeletons still throw — disabled, not broken.
      return { plan: null, reason: 'Action unavailable' }
    }
  }, [
    isConnected, user, parsed.error, amount, balance, preview, minSyOut, minPtOut,
    sy.address, sy.symbol, sy.decimals, snapshot,
  ])

  const flow = useActionFlow(plan)
  const flowBusy = useBusyFreeze(flow, onBusyChange)
  const queryClient = useQueryClient()

  // A failed flow usually means the pool ratio moved from under the preview
  // (stale pro-rata min-outs) — the balanced "quote" is the market snapshot
  // itself, so refresh it (mirrors TradePanel's refetchQuote-on-failed). The
  // sync previewDualRemove recomputes from the refetched snapshot, so the
  // rebuilt plan simulates against current numbers instead of looping forever
  // on the same stale ratio.
  useEffect(() => {
    if (flow.phase === 'failed') {
      void queryClient.invalidateQueries({ queryKey: ['market'] })
    }
  }, [flow.phase, queryClient])

  const onDone = () => {
    flow.reset()
    refetchPositions()
    setAmountText('')
  }

  return (
    <div className="space-y-3.5">
      <AmountInput
        label="You remove"
        value={amountText}
        onChange={setAmountText}
        symbol={LP_SYMBOL}
        decimals={LP_DECIMALS}
        balance={balance}
        disabled={flowBusy}
        error={parsed.error}
      />

      <div className="rounded-lg border border-hairline bg-bg-2 px-3 py-2.5 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-faint">SY out (estimated)</span>
          <span className="font-medium text-fg">
            {preview !== undefined
              ? `~${formatAmount(preview.syOut, sy.decimals)} ${clampLabel(sy.symbol, 16)}`
              : '—'}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-faint">PT out (estimated)</span>
          <span className="font-medium text-fg">
            {preview !== undefined
              ? `~${formatAmount(preview.ptOut, sy.assetDecimals)} ${clampLabel(ptSymbol, 16)}`
              : '—'}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-faint">
            Min after {formatPercent(effectiveSlippage)} slippage
            {slippageFloored && <span className="text-faint"> (min 0.05%)</span>}
          </span>
          <span className="text-muted">
            {minSyOut !== undefined && minPtOut !== undefined
              ? `${formatAmount(minSyOut, sy.decimals)} SY · ${formatAmount(minPtOut, sy.assetDecimals)} PT`
              : '—'}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-faint">Share of pool burned</span>
          <span className="text-muted">
            {preview !== undefined ? formatPercent(preview.shareBurned) : '—'}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-faint">
          Pro-rata burn — no swap, no price impact. You receive SY + PT; unwrap the SY on the
          Wrap / Unwrap tab.
        </p>
      </div>

      <TxButton
        flow={flow}
        actionLabel="remove liquidity"
        disabledReason={reason}
        onDone={onDone}
        onRetry={() => {
          // Retry against a FRESH snapshot — the pro-rata preview derives from
          // it, and the failure usually means the pool moved from under it.
          void queryClient.invalidateQueries({ queryKey: ['market'] })
          flow.reset()
        }}
      />
      <TxStatus
        flow={flow}
        out={{ symbol: sy.symbol, decimals: sy.decimals, minOut: minSyOut }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Zap out — LP → single token via useZapQuote('out')
// ---------------------------------------------------------------------------

function ZapOutForm({ snapshot, positions, refetchPositions, onBusyChange }: FormProps) {
  const { sy } = snapshot
  const { address: user, isConnected } = useAccount()
  const { effectiveSlippage, slippageFloored } = useEffectiveSlippage()

  const [choice, setChoice] = useState<string>(SY_CHOICE)
  const [amountText, setAmountText] = useState('')

  const metas = useTokenMetas(sy.tokensOut)
  const choiceIsSy = choice === SY_CHOICE || !sy.tokensOut.some((t) => sameAddress(t, choice))
  const token = choiceIsSy ? undefined : (choice as Address)
  const tokenMeta = token !== undefined ? metas[token.toLowerCase()] : undefined
  const outSymbol = token !== undefined ? (tokenMeta?.symbol ?? shortAddress(token)) : sy.symbol
  const outDecimals = choiceIsSy ? sy.decimals : tokenMeta?.decimals

  const parsed = parseAmount(amountText, LP_DECIMALS)
  const amount = parsed.amount
  const balance = positions?.lp

  const quoteToken = choiceIsSy ? sy.address : token
  const quoteAmount = amount !== undefined && amount > 0n ? amount : undefined
  const {
    status: quoteStatus,
    quote,
    error: quoteError,
    refetch: refetchQuote,
  } = useZapQuote(snapshot, 'out', quoteToken, quoteAmount, false, effectiveSlippage)
  const quoteLoading = quoteAmount !== undefined && quoteStatus === 'loading'
  const quoteUnavailable = quoteAmount !== undefined && quoteStatus === 'error'

  const minOut =
    quote !== undefined ? applySlippage(quote.amountOut, effectiveSlippage) : undefined

  const { plan, reason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (!isConnected || user === undefined) return { plan: null, reason: null } // TxButton → Connect wallet
    // Output token metadata unknown: refuse to plan rather than displaying
    // min-out/quotes with a guessed 18 decimals.
    if (outDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    if (parsed.error) return { plan: null, reason: 'Fix the amount' }
    if (amount === undefined || amount === 0n) return { plan: null, reason: 'Enter an amount' }
    if (balance === undefined) return { plan: null, reason: 'Loading balances…' }
    if (amount > balance) return { plan: null, reason: 'Insufficient LP' }
    if (quoteLoading) return { plan: null, reason: 'Fetching quote…' }
    // Covers quote errors AND the pre-integration 'idle' stub.
    if (quote === undefined || minOut === undefined) {
      return { plan: null, reason: 'Quote unavailable' }
    }
    try {
      const built = planZapOut(
        snapshot,
        choiceIsSy ? sy.address : token!,
        outSymbol,
        outDecimals,
        amount,
        minOut,
        user,
      )
      return { plan: built, reason: null }
    } catch {
      // Data-layer skeletons still throw — disabled, not broken.
      return { plan: null, reason: 'Action unavailable' }
    }
  }, [
    isConnected, user, outDecimals, parsed.error, amount, balance, quoteLoading, quote,
    minOut, choiceIsSy, sy.address, token, outSymbol, snapshot,
  ])

  const flow = useActionFlow(plan)
  const flowBusy = useBusyFreeze(flow, onBusyChange)

  // A failed flow usually means the pool moved from under the quote — refresh
  // it so the rebuilt plan simulates against current state.
  useEffect(() => {
    if (flow.phase === 'failed') refetchQuote()
  }, [flow.phase, refetchQuote])

  const onDone = () => {
    flow.reset()
    refetchPositions()
    setAmountText('')
  }

  return (
    <div className="space-y-3.5">
      <div className="flex justify-end">
        <TokenSelect
          label="Receive"
          value={choiceIsSy ? SY_CHOICE : choice}
          onChange={(next) => {
            setChoice(next)
            setAmountText('')
          }}
          tokens={sy.tokensOut}
          metas={metas}
          sySymbol={sy.symbol}
          disabled={flowBusy}
        />
      </div>

      <AmountInput
        label="You remove"
        value={amountText}
        onChange={setAmountText}
        symbol={LP_SYMBOL}
        decimals={LP_DECIMALS}
        balance={balance}
        disabled={flowBusy}
        error={parsed.error}
      />

      {/* No quote card when the output token's decimals are unknown — a
          fallback of 18 would render confidently wrong numbers. */}
      {outDecimals !== undefined && (
        <ZapQuoteCard
          loading={quoteLoading}
          unavailable={quoteUnavailable}
          quote={quote}
          outSymbol={outSymbol}
          outDecimals={outDecimals}
          minOut={minOut}
          effectiveSlippage={effectiveSlippage}
          slippageFloored={slippageFloored}
          sySymbol={sy.symbol}
          syDecimals={sy.decimals}
        />
      )}

      <QuoteFailedBanner
        label="Quote failed"
        error={quoteUnavailable ? quoteError : undefined}
      />
      <ImpactBanners quote={quote} />

      <TxButton
        flow={flow}
        actionLabel="zap out"
        disabledReason={reason}
        onDone={onDone}
        onRetry={() => {
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

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function LiquidityPanel({
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
  const [mode, setMode] = useState<LiquidityMode>('add')
  const [addMode, setAddMode] = useState<SubMode>('balanced')
  const [removeMode, setRemoveMode] = useState<SubMode>('balanced')
  // Lifted from ZapInForm: the explainer paragraph below must swap to the
  // accurate no-swap copy while Keep YT is ticked.
  const [keepYt, setKeepYt] = useState(false)
  // Local mirror of the active form's busy state — freezes the mode toggles
  // here; the same signal is forwarded up to ActionTabs (SlippageControl/tabs).
  const [flowBusy, setFlowBusy] = useState(false)

  const handleBusy = useCallback(
    (busy: boolean) => {
      setFlowBusy(busy)
      onBusyChange?.(busy)
    },
    [onBusyChange],
  )

  const subMode = mode === 'add' ? addMode : removeMode
  const setSubMode = mode === 'add' ? setAddMode : setRemoveMode
  const subModes: Array<[SubMode, string]> =
    mode === 'add'
      ? [
          ['balanced', 'Balanced (SY/token + PT)'],
          ['zap', 'Zap (single token)'],
        ]
      : [
          ['balanced', 'Balanced (SY + PT)'],
          ['zap', 'Zap out (single token)'],
        ]

  const toggleClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
      active ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'
    }`

  const formProps: FormProps = {
    snapshot,
    positions,
    refetchPositions,
    onBusyChange: handleBusy,
  }

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-hairline bg-bg-2 p-0.5">
          {(
            [
              ['add', 'Add'],
              ['remove', 'Remove'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              disabled={flowBusy}
              onClick={() => setMode(m)}
              className={toggleClass(mode === m)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border border-hairline bg-bg-2 p-0.5">
          {subModes.map(([s, label]) => (
            <button
              key={s}
              type="button"
              disabled={flowBusy}
              onClick={() => setSubMode(s)}
              className={toggleClass(subMode === s)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs leading-relaxed text-faint">
        {mode === 'add' && subMode === 'zap' && keepYt
          ? ADD_ZAP_KEEP_YT_COPY
          : MODE_COPY[`${mode}-${subMode}`]}
      </p>

      {mode === 'add' ? (
        addMode === 'balanced' ? (
          <BalancedAddForm {...formProps} />
        ) : (
          <ZapInForm {...formProps} keepYt={keepYt} onKeepYtChange={setKeepYt} />
        )
      ) : removeMode === 'balanced' ? (
        <BalancedRemoveForm {...formProps} />
      ) : (
        <ZapOutForm {...formProps} />
      )}
    </div>
  )
}
