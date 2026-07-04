/**
 * WrapUnwrapPanel (M2) — SY.deposit / SY.redeem. Direction toggle, token
 * select from sy.tokensIn (wrap) / sy.tokensOut (unwrap) with address(0)
 * rendered as ETH, AmountInput with wallet balance + Max, debounced indicative
 * quote via quoteWrap/quoteUnwrap, minOut = quote × (1 − slippage), plan via
 * planWrap/planUnwrap, TxButton driving the approve→simulate→confirm flow.
 *
 * Wire-up rules: a plan is built ONLY for a valid, positive, ≤-balance amount
 * with a live quote; otherwise plan=null and TxButton shows the reason.
 * Quote/plan builders may throw (stubs until the data layer lands) — caught
 * and rendered as "quote unavailable" / a disabled button, never a crash.
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount, usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import type { ActionPlan, MarketSnapshot, Positions } from '../lib/types'
import { useActionFlow, useActiveChain } from '../lib/hooks'
import { planUnwrap, planWrap, quoteUnwrap, quoteWrap } from '../lib/actions'
import { AmountInput } from './AmountInput'
import { parseAmount } from './parseAmount'
import { IndicativeQuote, TxStatus } from './TxStatus'
import { TxButton } from './TxButton'
import { clampLabel, shortAddress } from './format'
import { applySlippage, useSlippage } from './prefs'
import { findWalletBalance, isNativeEth, sameAddress, useTokenMetas } from './tokens'
import { useDebouncedValue } from './useDebouncedValue'

type Direction = 'wrap' | 'unwrap'

export function WrapUnwrapPanel({
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
  // M8: quotes must read the ACTIVE chain, not the wagmi default (Ethereum).
  const { chainId: activeChainId } = useActiveChain()
  const client = usePublicClient({ chainId: activeChainId })
  const [slippage] = useSlippage()

  const [direction, setDirection] = useState<Direction>('wrap')
  const [tokenChoice, setTokenChoice] = useState<Partial<Record<Direction, Address>>>({})
  const [amountText, setAmountText] = useState('')

  const tokenList = direction === 'wrap' ? sy.tokensIn : sy.tokensOut
  const metas = useTokenMetas([...sy.tokensIn, ...sy.tokensOut])

  const chosen = tokenChoice[direction]
  const token = tokenList.find((t) => sameAddress(t, chosen)) ?? tokenList[0]
  const tokenMeta = token !== undefined ? metas[token.toLowerCase()] : undefined
  const tokenSymbol =
    tokenMeta?.symbol ?? (token !== undefined ? shortAddress(token) : '—')

  // Input side: wrap spends `token`, unwrap spends SY.
  const inSymbol = direction === 'wrap' ? tokenSymbol : sy.symbol
  const inDecimals = direction === 'wrap' ? tokenMeta?.decimals : sy.decimals
  const inIsNative = direction === 'wrap' && token !== undefined && isNativeEth(token)
  const balance =
    direction === 'wrap'
      ? token !== undefined
        ? findWalletBalance(positions, token)
        : undefined
      : positions?.sy
  // Output side framing (quotes/minOut are denominated here).
  const outSymbol = direction === 'wrap' ? sy.symbol : tokenSymbol
  const outDecimals = direction === 'wrap' ? sy.decimals : tokenMeta?.decimals

  const parsed = inDecimals !== undefined ? parseAmount(amountText, inDecimals) : {}
  const amount = parsed.amount

  // Debounced indicative quote (PLAN §3.2 — pre-approval quotes are indicative).
  const debouncedKey = useDebouncedValue(amount?.toString() ?? '', 350)
  const debouncedAmount = debouncedKey !== '' ? BigInt(debouncedKey) : undefined
  const quoteEnabled =
    client !== undefined &&
    token !== undefined &&
    debouncedAmount !== undefined &&
    debouncedAmount > 0n
  const quoteQuery = useQuery({
    queryKey: [
      'm2-quote-wrap-unwrap',
      activeChainId,
      snapshot.address.toLowerCase(),
      direction,
      token?.toLowerCase() ?? null,
      debouncedKey,
    ],
    queryFn: () =>
      direction === 'wrap'
        ? quoteWrap(client!, sy, token!, debouncedAmount!)
        : quoteUnwrap(client!, sy, token!, debouncedAmount!),
    enabled: quoteEnabled,
    retry: false,
    staleTime: 15_000,
  })
  const quoteStale =
    amount !== undefined && amount > 0n && amount.toString() !== debouncedKey
  const quote = !quoteStale && quoteQuery.status === 'success' ? quoteQuery.data : undefined
  const quoteLoading = quoteEnabled && (quoteStale || quoteQuery.status === 'pending')
  const quoteUnavailable = !quoteStale && quoteQuery.status === 'error'
  const minOut = quote !== undefined ? applySlippage(quote, slippage) : undefined

  // Build the plan only when every wire-up rule passes.
  const { plan, reason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (token === undefined) return { plan: null, reason: 'No tokens available' }
    if (!isConnected || user === undefined) return { plan: null, reason: null } // TxButton → Connect wallet
    if (inDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    // Output token metadata unknown (unwrap to an unreadable token): refuse to
    // plan rather than displaying min-out/quotes with a guessed 18 decimals.
    if (outDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    if (parsed.error) return { plan: null, reason: 'Fix the amount' }
    if (amount === undefined || amount === 0n) return { plan: null, reason: 'Enter an amount' }
    if (balance === undefined) return { plan: null, reason: 'Loading balances…' }
    if (amount > balance) return { plan: null, reason: `Insufficient ${clampLabel(inSymbol, 16)}` }
    if (quoteLoading) return { plan: null, reason: 'Fetching quote…' }
    if (quoteUnavailable || minOut === undefined) return { plan: null, reason: 'Quote unavailable' }
    try {
      const built =
        direction === 'wrap'
          ? planWrap(sy, token, tokenSymbol, inDecimals, amount, minOut, user)
          : planUnwrap(sy, token, tokenSymbol, outDecimals, amount, minOut, user)
      return { plan: built, reason: null }
    } catch {
      // Data-layer skeletons still throw — disabled, not broken.
      return { plan: null, reason: 'Action unavailable' }
    }
  }, [
    token, isConnected, user, inDecimals, outDecimals, parsed.error, amount, balance,
    inSymbol, quoteLoading, quoteUnavailable, minOut, direction, sy, tokenSymbol,
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

  const onDone = () => {
    flow.reset()
    refetchPositions()
    setAmountText('')
  }

  if (sy.tokensIn.length === 0 && sy.tokensOut.length === 0) {
    return (
      <p className="text-sm text-faint">
        This SY reports no deposit or withdrawal tokens — wrap/unwrap isn't
        possible through the standard interface.
      </p>
    )
  }

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="inline-flex rounded-lg border border-hairline bg-bg-2 p-0.5">
          {(
            [
              ['wrap', 'Wrap · token → SY'],
              ['unwrap', 'Unwrap · SY → token'],
            ] as const
          ).map(([dir, label]) => (
            <button
              key={dir}
              type="button"
              disabled={flowBusy}
              onClick={() => {
                setDirection(dir)
                setAmountText('')
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                direction === dir
                  ? 'bg-surface-2 text-fg'
                  : 'text-muted hover:text-fg'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tokenList.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-faint">
            {direction === 'wrap' ? 'Deposit token' : 'Receive token'}
            <select
              value={token ?? ''}
              disabled={flowBusy}
              onChange={(e) => {
                setTokenChoice((prev) => ({ ...prev, [direction]: e.target.value as Address }))
                setAmountText('')
              }}
              className="rounded-md border border-hairline-strong bg-bg px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
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
        )}
      </div>

      {tokenList.length === 0 ? (
        <p className="text-sm text-faint">
          This SY reports no {direction === 'wrap' ? 'deposit (tokensIn)' : 'withdrawal (tokensOut)'}{' '}
          tokens for this direction.
        </p>
      ) : (
        <>
          <AmountInput
            label={direction === 'wrap' ? 'You wrap' : 'You unwrap'}
            value={amountText}
            onChange={setAmountText}
            symbol={inSymbol}
            decimals={inDecimals}
            balance={balance}
            isNative={inIsNative}
            disabled={flowBusy}
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
              slippage={slippage}
              note="Estimated from the SY's preview call — the binding number is simulated before you confirm."
            />
          )}

          <TxButton
            flow={flow}
            actionLabel={direction === 'wrap' ? 'wrap' : 'unwrap'}
            disabledReason={reason}
            onDone={onDone}
          />
          <TxStatus
            flow={flow}
            out={
              outDecimals !== undefined
                ? { symbol: outSymbol, decimals: outDecimals, minOut }
                : undefined
            }
          />
        </>
      )}
    </div>
  )
}
