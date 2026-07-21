/**
 * MaturedPanel (M5) — the actions area for VALIDATED, EXPIRED markets
 * (replaces ActionTabs there; unvalidated markets keep the red no-tx state).
 * Post-expiry the protocol disables swaps/mints/LP-adds, so the panel offers
 * the market flows that remain plus direct access to the underlying SY:
 *
 * - Redeem PT: router redeemPyToSy/redeemPyToToken — NO YT needed after
 *   expiry (lib/actions' plans already skip the YT approval). Quotes via
 *   quoteRedeemPyToSy (exact at the current PY index), chained through
 *   SY.previewRedeem for token targets (MintRedeemPanel convention).
 * - Exit LP: one-click exitPostExpToSy/ToToken — burns LP pro-rata and
 *   redeems the PT leg (optionally folding in loose wallet PT) at the stored
 *   index. No swap, no price impact; useExitPreview is exact math, rendered
 *   as a three-line decomposition (SY from burn / PT redeemed / total).
 * - Claimables: PositionsCard already owns the claim flow (it works
 *   post-expiry) — this panel only points there, and only when something is
 *   (or may be) claimable.
 * - Wrap / unwrap SY: SY.deposit / SY.redeem are independent of market expiry,
 *   so they remain available in a dedicated tab whenever the SY exposes
 *   tokensIn / tokensOut.
 *
 * Matured PT/LP min-outs: the only drift is index accrual, so the user's
 * slippage setting is applied CAPPED at 0.05% (tighter settings are respected
 * as-is). Direct SY wrapping uses the user's full slippage setting.
 *
 * Depeg guard (useDepegInfo): when SY.exchangeRate < pyIndexStored, each PT
 * still redeems at the stored index but the SY received is worth less than
 * par when unwrapped — prominent amber banner, never hidden.
 *
 * Legacy graceful failure: a SIMULATION failure (nothing was sent) on a
 * legacy vintage renders the honest can't-redeem notice alongside the
 * decoded revert (rescue paths are §7 non-goals).
 *
 * Conventions as everywhere: each section its own useActionFlow; inputs and
 * selects freeze while a send is in flight (busy also lifts up to disable
 * SlippageControl); failed flows refetch their quote/preview (onRetry);
 * data-layer skeletons that still throw render as disabled buttons — never
 * crashes, quotes show "—".
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import type {
  ActionPlan,
  DepegInfo,
  MarketSnapshot,
  Positions,
} from '../lib/types'
import { useActionFlow, useActiveChain, useDepegInfo, useExitPreview } from '../lib/hooks'
import {
  planRedeemPyToSy,
  planRedeemPyToToken,
  quoteRedeemPyToSy,
  quoteUnwrap,
} from '../lib/actions'
import { planExitPostExpToSy, planExitPostExpToToken } from '../lib/maturity'
import { SLIPPAGE_MOVED_MSG } from '../lib/txflow'
import { AmountInput } from './AmountInput'
import { parseAmount } from './parseAmount'
import { IndicativeQuote, TxStatus } from './TxStatus'
import { TxButton } from './TxButton'
import { SlippageControl } from './SlippageControl'
import { WrapUnwrapPanel } from './WrapUnwrapPanel'
import { clampLabel, formatAmount, formatPercent, shortAddress } from './format'
import { applySlippage, useSlippage } from './prefs'
import type { TokenMeta } from './tokens'
import { sameAddress, useTokenMetas } from './tokens'
import { useDebouncedValue } from './useDebouncedValue'

/** Select value: the SY itself, or a tokensOut address. */
const SY_CHOICE = 'sy'
/** Pendle market LP is a standard 18-decimals ERC-20 (PendleERC20). */
const LP_DECIMALS = 18
const LP_SYMBOL = 'LP'

type MaturedTab = 'redeem-exit' | 'wrap'

const MATURED_TABS: Array<{ id: MaturedTab; label: string }> = [
  { id: 'redeem-exit', label: 'Redeem / Exit' },
  { id: 'wrap', label: 'Wrap / Unwrap' },
]

/**
 * Post-expiry min-out cap: no swap can move these numbers — only index drift
 * between quote and execution (tiny) — so the user's slippage setting applies
 * capped at 0.05%. A tighter user setting is respected unchanged.
 */
const INDEX_DRIFT_SLIPPAGE_CAP = 0.0005

function useMaturedSlippage(): { effectiveSlippage: number; capped: boolean } {
  const [slippage] = useSlippage()
  return {
    effectiveSlippage: Math.min(slippage, INDEX_DRIFT_SLIPPAGE_CAP),
    capped: slippage > INDEX_DRIFT_SLIPPAGE_CAP,
  }
}

/** Report the in-flight-send freeze upward (panel disables SlippageControl). */
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

/**
 * The honest legacy notice — shown only when a redeem/exit SIMULATION hit a
 * genuine CONTRACT REVERT on a legacy vintage (nothing was sent: flow.txHash
 * is still unset). Gating rules, tightened so it no longer over-fires:
 * - flow.reverted: the failure must be a decoded on-chain revert, NOT a
 *   transient RPC/transport error (those are retryable, not un-redeemability).
 * - the decoded reason must not be the recoverable slippage message (a min-out
 *   revert is retryable — refreshing the quote fixes it).
 * Copy is softened: it no longer asserts PERMANENT un-redeemability while a
 * Retry button is showing. The decoded reason stays visible underneath via
 * TxStatus's failed strip.
 */
function LegacyCantRedeemNotice({
  flow,
  vintage,
}: {
  flow: ReturnType<typeof useActionFlow>
  vintage: MarketSnapshot['vintage']
}) {
  const recoverableSlippage = flow.error === SLIPPAGE_MOVED_MSG
  const show =
    flow.phase === 'failed' &&
    flow.txHash === undefined &&
    flow.reverted &&
    !recoverableSlippage &&
    vintage !== 'active'
  if (!show) return null
  return (
    <div className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2.5 text-xs leading-relaxed text-warn">
      <span className="font-semibold text-warn">Legacy market:</span> redemption isn't supported
      here. Nothing was sent — your tokens are untouched.
    </div>
  )
}

/** Prominent depeg banner — the redemption index outruns the SY's live rate. */
function DepegBanner({
  info,
  assetLabel,
}: {
  info?: DepegInfo
  assetLabel: string
}) {
  if (info === undefined || !info.depegged) return null
  return (
    <div role="alert" className="mt-3 rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] p-4">
      <p className="text-sm font-semibold text-warn">
        SY exchange rate below the redemption index
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-warn">
        Each PT still redeems at the stored index, but the SY you receive is worth less than 1{' '}
        {assetLabel} when unwrapped — check the unwrap quote before valuing it at par.
      </p>
    </div>
  )
}

interface SectionProps {
  snapshot: MarketSnapshot
  positions?: Positions
  refetchPositions: () => void
  onBusyChange: (busy: boolean) => void
  /**
   * True when the OTHER section's flow is busy (approving/signing/pending).
   * RedeemPtSection (Max = loose PT) and ExitLpSection ("Include my loose PT")
   * both claim the SAME wallet PT, so while one is mid-send the other must
   * freeze its inputs + Confirm to avoid double-arming the same balance.
   */
  siblingBusy: boolean
}

// ---------------------------------------------------------------------------
// Redeem PT — router redeemPyToSy/ToToken, no YT needed post-expiry
// ---------------------------------------------------------------------------

function RedeemPtSection({
  snapshot,
  positions,
  refetchPositions,
  onBusyChange,
  siblingBusy,
}: SectionProps) {
  const { sy } = snapshot
  const { address: user, isConnected } = useAccount()
  // M8: quotes read the ACTIVE chain, not the wagmi default (Ethereum).
  const { chainId: activeChainId } = useActiveChain()
  const client = usePublicClient({ chainId: activeChainId })
  // SY-target redeem is EXACT at the PY index (only index drift moves it) → the
  // 0.05% index-drift cap. TOKEN-target redeem chains through previewRedeem
  // (SY→token), which can move more than index drift, so it uses the user's
  // FULL slippage — same as MintRedeemPanel's redeem-to-token.
  const { effectiveSlippage, capped } = useMaturedSlippage()
  const [fullSlippage] = useSlippage()

  const [choice, setChoice] = useState<string>(SY_CHOICE)
  const [amountText, setAmountText] = useState('')

  const metas = useTokenMetas(sy.tokensOut)
  const choiceIsSy = choice === SY_CHOICE || !sy.tokensOut.some((t) => sameAddress(t, choice))
  const token = choiceIsSy ? undefined : (choice as Address)
  const tokenMeta = token !== undefined ? metas[token.toLowerCase()] : undefined
  const outSymbol = token !== undefined ? (tokenMeta?.symbol ?? shortAddress(token)) : sy.symbol
  const outDecimals = choiceIsSy ? sy.decimals : tokenMeta?.decimals

  const ptSymbol = snapshot.ptSymbol || 'PT'
  const parsed = parseAmount(amountText, sy.assetDecimals)
  const amount = parsed.amount
  const balance = positions?.pt

  // Quote: exact at the current PY index (quoteRedeemPyToSy), chained through
  // SY.previewRedeem for token targets — MintRedeemPanel's convention.
  const debouncedKey = useDebouncedValue(amount?.toString() ?? '', 350)
  const debouncedAmount = debouncedKey !== '' ? BigInt(debouncedKey) : undefined
  const quoteEnabled =
    client !== undefined && debouncedAmount !== undefined && debouncedAmount > 0n
  const quoteQuery = useQuery({
    queryKey: [
      'm5-redeem-pt-quote',
      activeChainId,
      snapshot.address.toLowerCase(),
      choiceIsSy ? SY_CHOICE : token?.toLowerCase(),
      debouncedKey,
    ],
    queryFn: async () => {
      const syOut = await quoteRedeemPyToSy(client!, snapshot, debouncedAmount!)
      if (choiceIsSy) return syOut
      return quoteUnwrap(client!, sy, token!, syOut)
    },
    enabled: quoteEnabled,
    retry: false,
    staleTime: 15_000,
  })
  const quoteStale =
    amount !== undefined && amount > 0n && amount.toString() !== debouncedKey
  const quote = !quoteStale && quoteQuery.status === 'success' ? quoteQuery.data : undefined
  const quoteLoading = quoteEnabled && (quoteStale || quoteQuery.status === 'pending')
  const quoteUnavailable = !quoteStale && quoteQuery.status === 'error'
  // SY target: capped index-drift slippage (exact math). Token target: full
  // slippage (previewRedeem can move more than index drift). FIX 4.
  const appliedSlippage = choiceIsSy ? effectiveSlippage : fullSlippage
  const minOut = quote !== undefined ? applySlippage(quote, appliedSlippage) : undefined

  const { plan, reason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (!isConnected || user === undefined) return { plan: null, reason: null } // TxButton → Connect wallet
    // The sibling Exit LP section is mid-send against the SAME loose PT —
    // don't arm a redeem that would double-spend it. Null the plan so Confirm
    // can't fire (the sibling freeze also disables the inputs below).
    if (siblingBusy) return { plan: null, reason: 'Finishing the other action…' }
    // Output token metadata unknown: refuse to plan rather than displaying
    // min-out/quotes with a guessed 18 decimals.
    if (outDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    if (parsed.error) return { plan: null, reason: 'Fix the amount' }
    if (amount === undefined || amount === 0n) return { plan: null, reason: 'Enter an amount' }
    if (balance === undefined) return { plan: null, reason: 'Loading balances…' }
    if (amount > balance) {
      return { plan: null, reason: `Insufficient ${clampLabel(ptSymbol, 16)}` }
    }
    if (quoteLoading) return { plan: null, reason: 'Fetching quote…' }
    if (quoteUnavailable || minOut === undefined) return { plan: null, reason: 'Quote unavailable' }
    try {
      const built = choiceIsSy
        ? planRedeemPyToSy(snapshot, amount, minOut, user)
        : planRedeemPyToToken(snapshot, token!, outSymbol, outDecimals, amount, minOut, user)
      return { plan: built, reason: null }
    } catch {
      return { plan: null, reason: 'Action unavailable' }
    }
  }, [
    isConnected, user, siblingBusy, outDecimals, parsed.error, amount, balance, ptSymbol,
    quoteLoading, quoteUnavailable, minOut, choiceIsSy, snapshot, token, outSymbol,
  ])

  const flow = useActionFlow(plan)
  const flowBusy = useBusyFreeze(flow, onBusyChange)
  // Freeze inputs when THIS flow is busy OR the sibling section is mid-send
  // (they share the same loose PT balance).
  const inputsFrozen = flowBusy || siblingBusy

  // A failed flow refetches its quote (index may have drifted from under the
  // min-out) so the rebuilt plan simulates against current numbers.
  const refetchQuote = quoteQuery.refetch
  useEffect(() => {
    if (flow.phase === 'failed') void refetchQuote()
  }, [flow.phase, refetchQuote])

  const onDone = () => {
    flow.reset()
    refetchPositions()
    setAmountText('')
  }

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <h3 className="text-sm font-semibold text-fg">Redeem PT</h3>
        <TokenSelect
          label="Redeem to"
          value={choiceIsSy ? SY_CHOICE : choice}
          onChange={(next) => {
            setChoice(next)
            setAmountText('')
          }}
          tokens={sy.tokensOut}
          metas={metas}
          sySymbol={sy.symbol}
          disabled={inputsFrozen}
        />
      </div>

      <AmountInput
        label="You redeem"
        value={amountText}
        onChange={setAmountText}
        symbol={ptSymbol}
        decimals={sy.assetDecimals}
        balance={balance}
        disabled={inputsFrozen}
        error={parsed.error}
      />

      {/* No quote row when the output token's decimals are unknown — a
          fallback of 18 would render confidently wrong numbers. */}
      {outDecimals !== undefined && (
        <IndicativeQuote
          loading={quoteLoading}
          unavailable={quoteUnavailable}
          amount={quote}
          decimals={outDecimals}
          symbol={outSymbol}
          minOut={minOut}
          slippage={appliedSlippage}
          note={
            (choiceIsSy
              ? 'Exact at the current PY index — simulated before you sign.'
              : 'Exact at the current index via redeem → unwrap — simulated before you sign.') +
            // The cap note only applies to the SY path (exact math); the token
            // path uses full slippage (previewRedeem can move more).
            (choiceIsSy && capped
              ? ' Min-out uses your slippage setting capped at 0.05% — post-expiry only index drift can move it.'
              : '')
          }
        />
      )}

      <TxButton
        flow={flow}
        actionLabel="redeem PT"
        disabledReason={reason}
        onDone={onDone}
        onRetry={() => {
          void refetchQuote()
          flow.reset()
        }}
      />
      <LegacyCantRedeemNotice flow={flow} vintage={snapshot.vintage} />
      <TxStatus
        flow={flow}
        out={
          outDecimals !== undefined
            ? { symbol: outSymbol, decimals: outDecimals, minOut }
            : undefined
        }
      />
      <p className="text-[11px] leading-snug text-faint">
        No YT needed after maturity.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Exit LP — one-click exitPostExpToSy/ToToken (LP burn + PT redeem, no swap)
// ---------------------------------------------------------------------------

function ExitLpSection({
  snapshot,
  positions,
  refetchPositions,
  onBusyChange,
  siblingBusy,
}: SectionProps) {
  const { sy } = snapshot
  const { address: user, isConnected } = useAccount()
  // M8: quotes read the ACTIVE chain, not the wagmi default (Ethereum).
  const { chainId: activeChainId } = useActiveChain()
  const client = usePublicClient({ chainId: activeChainId })
  const queryClient = useQueryClient()
  // SY-target min-out is EXACT math (only index drift can move it) → the 0.05%
  // index-drift cap applies. TOKEN-target min-out comes from previewRedeem,
  // which can move more than index drift (the SY→token redemption itself), so
  // it uses the user's FULL slippage — same as MintRedeemPanel's redeem-to-token.
  const { effectiveSlippage, capped } = useMaturedSlippage()
  const [fullSlippage] = useSlippage()

  const [choice, setChoice] = useState<string>(SY_CHOICE)
  const [amountText, setAmountText] = useState('')
  const [includePt, setIncludePt] = useState(false)

  const metas = useTokenMetas(sy.tokensOut)
  const choiceIsSy = choice === SY_CHOICE || !sy.tokensOut.some((t) => sameAddress(t, choice))
  const token = choiceIsSy ? undefined : (choice as Address)
  const tokenMeta = token !== undefined ? metas[token.toLowerCase()] : undefined
  const outSymbol = token !== undefined ? (tokenMeta?.symbol ?? shortAddress(token)) : sy.symbol
  const outDecimals = choiceIsSy ? sy.decimals : tokenMeta?.decimals

  const ptSymbol = snapshot.ptSymbol || 'PT'
  const parsed = parseAmount(amountText, LP_DECIMALS)
  const amount = parsed.amount
  const balance = positions?.lp
  const loosePt = positions?.pt ?? 0n
  const ptIncluded = includePt ? loosePt : 0n

  const lpIn = amount !== undefined && amount > 0n ? amount : undefined
  // PT-only exit (FIX 6): the user leaves LP empty but arms "Include my loose
  // PT" — a legit flow (redeem loose PT through the exit path with lpIn = 0n;
  // the lib + LP approval-amount-0 both support it). effectiveLpIn feeds the
  // preview/plan: the entered LP, or 0n when it's a PT-only exit.
  const hasLp = lpIn !== undefined
  const ptOnly = !hasLp && ptIncluded > 0n
  const effectiveLpIn = hasLp ? lpIn : ptOnly ? 0n : undefined
  const {
    status: previewStatus,
    preview,
    error: previewError,
    refetch: refetchPreview,
  } = useExitPreview(snapshot, effectiveLpIn, ptIncluded)
  const previewLoading = effectiveLpIn !== undefined && previewStatus === 'loading'
  const previewUnavailable = effectiveLpIn !== undefined && previewStatus === 'error'

  const minSyOut =
    preview !== undefined ? applySlippage(preview.totalSyOut, effectiveSlippage) : undefined

  // Token targets: chain the exact totalSyOut through SY.previewRedeem for
  // the token estimate the min-out binds to (same chaining as Redeem PT).
  const totalSyKey = preview?.totalSyOut.toString() ?? ''
  const unwrapEnabled =
    client !== undefined && token !== undefined && preview !== undefined && preview.totalSyOut > 0n
  const unwrapQuery = useQuery({
    queryKey: [
      'm5-exit-unwrap',
      activeChainId,
      snapshot.address.toLowerCase(),
      token?.toLowerCase() ?? null,
      totalSyKey,
    ],
    queryFn: () => quoteUnwrap(client!, sy, token!, preview!.totalSyOut),
    enabled: unwrapEnabled,
    retry: false,
    staleTime: 15_000,
  })
  const tokenEstimate =
    token !== undefined && unwrapQuery.status === 'success' ? unwrapQuery.data : undefined
  const unwrapLoading = unwrapEnabled && unwrapQuery.status === 'pending'
  const unwrapUnavailable = unwrapEnabled && unwrapQuery.status === 'error'
  // FULL slippage on the token path (previewRedeem can move more than index
  // drift); the SY path (minSyOut above) keeps the 0.05% index-drift cap.
  const minTokenOut =
    tokenEstimate !== undefined ? applySlippage(tokenEstimate, fullSlippage) : undefined

  const { plan, reason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (!isConnected || user === undefined) return { plan: null, reason: null } // TxButton → Connect wallet
    // The sibling Redeem PT section is mid-send against the SAME loose PT —
    // don't arm an exit that folds in the same PT. Null the plan so Confirm
    // can't fire (the sibling freeze also disables the inputs below).
    if (siblingBusy) return { plan: null, reason: 'Finishing the other action…' }
    if (outDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    if (parsed.error) return { plan: null, reason: 'Fix the amount' }
    // Nothing to exit: neither LP entered nor loose PT folded in.
    if (effectiveLpIn === undefined) return { plan: null, reason: 'Enter an amount' }
    if (balance === undefined) return { plan: null, reason: 'Loading balances…' }
    if (hasLp && lpIn > balance) return { plan: null, reason: 'Insufficient LP' }
    if (previewLoading) return { plan: null, reason: 'Computing exit…' }
    // Covers preview errors AND the pre-integration 'idle' stub.
    if (preview === undefined || minSyOut === undefined) {
      return { plan: null, reason: 'Preview unavailable' }
    }
    if (!choiceIsSy) {
      if (unwrapLoading) return { plan: null, reason: 'Fetching unwrap quote…' }
      if (unwrapUnavailable || minTokenOut === undefined) {
        return { plan: null, reason: 'Quote unavailable' }
      }
    }
    try {
      // PT-only exit passes effectiveLpIn = 0n → exitApprovals lists the LP
      // approval at amount 0 (vacuously met, no extra tx) and only the PT
      // approval is actually required.
      const built = choiceIsSy
        ? planExitPostExpToSy(snapshot, effectiveLpIn, ptIncluded, minSyOut, user)
        : planExitPostExpToToken(
            snapshot,
            token!,
            outSymbol,
            outDecimals,
            effectiveLpIn,
            ptIncluded,
            minTokenOut!,
            user,
          )
      return { plan: built, reason: null }
    } catch {
      // Data-layer skeletons still throw — disabled, not broken.
      return { plan: null, reason: 'Action unavailable' }
    }
  }, [
    isConnected, user, siblingBusy, outDecimals, parsed.error, effectiveLpIn, hasLp, lpIn,
    balance, previewLoading, preview, minSyOut, choiceIsSy, unwrapLoading, unwrapUnavailable,
    minTokenOut, snapshot, token, outSymbol, ptIncluded,
  ])

  const flow = useActionFlow(plan)
  const flowBusy = useBusyFreeze(flow, onBusyChange)
  // Freeze inputs when THIS flow is busy OR the sibling section is mid-send
  // (both sections can claim the same loose PT).
  const inputsFrozen = flowBusy || siblingBusy

  // A failed flow refetches its preview: the exact math derives from the
  // market snapshot AND a live pyIndex read (the PT-redemption leg). Refreshing
  // the snapshot re-keys the preview on totalSy/Pt/Lp, but the preview key does
  // NOT include pyIndex — so also call refetchPreview() to re-read the drifting
  // stored index (FIX 5). The re-keyed preview/quote rebuild the plan against
  // current numbers (mirrors the balanced liquidity forms).
  const refetchUnwrap = unwrapQuery.refetch
  useEffect(() => {
    if (flow.phase === 'failed') {
      void queryClient.invalidateQueries({ queryKey: ['market'] })
      refetchPreview()
      if (token !== undefined) void refetchUnwrap()
    }
  }, [flow.phase, queryClient, token, refetchUnwrap, refetchPreview])

  const onDone = () => {
    flow.reset()
    refetchPositions()
    setAmountText('')
    setIncludePt(false)
  }

  const ptRedeemed =
    preview !== undefined ? preview.ptFromLpBurn + preview.ptIncluded : undefined
  const previewValue = (v: string): string =>
    previewLoading ? '…' : previewUnavailable ? '—' : preview !== undefined ? v : '—'

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <h3 className="text-sm font-semibold text-fg">Exit LP</h3>
        <TokenSelect
          label="Receive"
          value={choiceIsSy ? SY_CHOICE : choice}
          onChange={(next) => setChoice(next)}
          tokens={sy.tokensOut}
          metas={metas}
          sySymbol={sy.symbol}
          disabled={inputsFrozen}
        />
      </div>

      <p className="text-xs leading-relaxed text-faint">
        One transaction: burns your LP and redeems the PT — no swap, no price
        impact.
      </p>

      <AmountInput
        label="You exit"
        value={amountText}
        onChange={setAmountText}
        symbol={LP_SYMBOL}
        decimals={LP_DECIMALS}
        balance={balance}
        disabled={inputsFrozen}
        error={parsed.error}
      />

      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={includePt}
          disabled={inputsFrozen || positions === undefined || loosePt === 0n}
          onChange={(e) => setIncludePt(e.target.checked)}
          className="mt-0.5 accent-[var(--op-accent)] disabled:cursor-not-allowed"
        />
        <span className="leading-snug">
          <span className="font-medium text-muted">Include my loose PT</span>{' '}
          <span className="text-faint">
            — folds your wallet PT (
            {positions !== undefined
              ? `${formatAmount(loosePt, sy.assetDecimals)} ${clampLabel(ptSymbol, 16)}`
              : '—'}
            ) into the same redemption.
          </span>
        </span>
      </label>

      <div className="rounded-lg border border-hairline bg-bg-2 px-3 py-2.5 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-faint">SY from LP burn</span>
          <span className="font-medium text-fg">
            {previewValue(
              preview !== undefined
                ? `${formatAmount(preview.syFromLpBurn, sy.decimals)} SY`
                : '—',
            )}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-faint">
            PT redeemed at index
            {preview !== undefined && preview.ptIncluded > 0n && (
              <span className="text-faint">
                {' '}
                (incl. {formatAmount(preview.ptIncluded, sy.assetDecimals)} loose)
              </span>
            )}
          </span>
          <span className="font-medium text-fg">
            {previewValue(
              preview !== undefined && ptRedeemed !== undefined
                ? `${formatAmount(ptRedeemed, sy.assetDecimals)} PT → ${formatAmount(preview.syFromPtRedeem, sy.decimals)} SY`
                : '—',
            )}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-hairline pt-1">
          <span className="text-muted">Total SY out</span>
          <span className="font-semibold text-fg">
            {previewValue(
              preview !== undefined
                ? `${formatAmount(preview.totalSyOut, sy.decimals)} ${clampLabel(sy.symbol, 16)}`
                : '—',
            )}
          </span>
        </div>

        {!choiceIsSy && outDecimals !== undefined && (
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <span className="text-faint">After unwrap</span>
            <span className="font-medium text-fg">
              {unwrapLoading ? (
                <span className="text-faint">…</span>
              ) : unwrapUnavailable ? (
                <span className="text-warn">quote unavailable</span>
              ) : tokenEstimate !== undefined ? (
                `${formatAmount(tokenEstimate, outDecimals)} ${clampLabel(outSymbol, 16)}`
              ) : (
                '—'
              )}
            </span>
          </div>
        )}

        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-faint">
            {/* Label must match the slippage actually applied to the shown
                min-out: the SY path uses the capped index-drift slippage; the
                token path (previewRedeem can move more) uses full slippage. */}
            Min after {formatPercent(choiceIsSy ? effectiveSlippage : fullSlippage)} slippage
            {choiceIsSy && capped && (
              <span className="text-faint"> (capped — index drift only)</span>
            )}
          </span>
          <span className="text-muted">
            {choiceIsSy
              ? minSyOut !== undefined
                ? `${formatAmount(minSyOut, sy.decimals)} ${clampLabel(sy.symbol, 16)}`
                : '—'
              : minTokenOut !== undefined && outDecimals !== undefined
                ? `${formatAmount(minTokenOut, outDecimals)} ${clampLabel(outSymbol, 16)}`
                : '—'}
          </span>
        </div>

        <p className="mt-1.5 text-[11px] leading-snug text-faint">
          Exact — pro-rata LP burn plus PT redemption, no swap. Simulated before you sign.
        </p>
      </div>

      {previewUnavailable && previewError && (
        <div className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs text-warn">
          <span className="font-semibold text-warn">Preview failed:</span>{' '}
          {previewError}
        </div>
      )}

      <TxButton
        flow={flow}
        actionLabel="exit LP"
        disabledReason={reason}
        onDone={onDone}
        onRetry={() => {
          // Retry against a FRESH snapshot AND a fresh pyIndex read — the exact
          // preview derives from both, but its query key omits pyIndex, so
          // refetchPreview() is needed to re-read the drifting stored index (FIX 5).
          void queryClient.invalidateQueries({ queryKey: ['market'] })
          refetchPreview()
          if (token !== undefined) void refetchUnwrap()
          flow.reset()
        }}
      />
      <LegacyCantRedeemNotice flow={flow} vintage={snapshot.vintage} />
      <TxStatus
        flow={flow}
        out={
          outDecimals !== undefined
            ? {
                symbol: outSymbol,
                decimals: outDecimals,
                minOut: choiceIsSy ? minSyOut : minTokenOut,
              }
            : undefined
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function MaturedPanel({
  snapshot,
  positions,
  refetchPositions,
}: {
  snapshot: MarketSnapshot
  positions?: Positions
  refetchPositions: () => void
}) {
  const { isConnected } = useAccount()
  const [tab, setTab] = useState<MaturedTab>('redeem-exit')
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [exitBusy, setExitBusy] = useState(false)
  const [wrapBusy, setWrapBusy] = useState(false)
  const flowBusy = redeemBusy || exitBusy || wrapBusy

  const { info: depegInfo } = useDepegInfo(snapshot)

  const { sy } = snapshot
  const assetLabel = sy.assetSymbol ? clampLabel(sy.assetSymbol, 16) : 'accounting asset'

  const hasClaimables =
    positions !== undefined &&
    (positions.ytClaimableInterestSy > 0n ||
      [
        ...positions.ytClaimableRewards,
        ...positions.lpClaimableRewards,
        ...positions.syClaimableRewards,
      ].some((r) => r.amount > 0n))
  // Pointer renders while positions are unknown too (they may hold residuals);
  // omitted only when positions POSITIVELY show zero claimables — and when no
  // wallet is connected (PositionsCard, the claim home, isn't rendered then).
  const showClaimPointer = isConnected && (positions === undefined || hasClaimables)

  return (
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <h2 className="text-base font-semibold text-fg">Matured market</h2>
        </div>
        <SlippageControl disabled={flowBusy} />
      </div>

      <p className="mt-2 text-xs leading-relaxed text-faint">
        This market has matured — PT now redeems 1:1 for the accounting asset. Trading, minting
        and adding liquidity are closed; residual interest and rewards stay claimable.
      </p>

      <div
        role="tablist"
        aria-label="Matured market actions"
        className="mt-3.5 flex flex-wrap items-center gap-1.5 border-b border-hairline pb-2.5"
      >
        {MATURED_TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            disabled={flowBusy && tab !== item.id}
            onClick={() => setTab(item.id)}
            className={`px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              tab === item.id
                ? 'rounded-[10px] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink'
                : 'text-muted hover:text-fg'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'redeem-exit' ? (
        <>
          <DepegBanner info={depegInfo} assetLabel={assetLabel} />

          <div className="mt-4 space-y-5">
            <RedeemPtSection
              snapshot={snapshot}
              positions={positions}
              refetchPositions={refetchPositions}
              onBusyChange={setRedeemBusy}
              siblingBusy={exitBusy}
            />

            <div className="border-t border-hairline pt-4">
              <ExitLpSection
                snapshot={snapshot}
                positions={positions}
                refetchPositions={refetchPositions}
                onBusyChange={setExitBusy}
                siblingBusy={redeemBusy}
              />
            </div>

            {showClaimPointer && (
              <div className="border-t border-hairline pt-4">
                <h3 className="text-sm font-semibold text-fg">Claimables</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-faint">
                  Residual interest &amp; rewards are in{' '}
                  <span className="text-muted">Your positions</span> above —
                  claim from there.
                </p>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="pt-4">
          <WrapUnwrapPanel
            snapshot={snapshot}
            positions={positions}
            refetchPositions={refetchPositions}
            onBusyChange={setWrapBusy}
          />
        </div>
      )}
    </section>
  )
}
