/**
 * MintRedeemPanel (M2) — router mintPyFromSy/mintPyFromToken and
 * redeemPyToSy/redeemPyToToken. Minting splits SY into equal PT + YT;
 * redeeming pre-expiry needs equal amounts of both.
 *
 * Quotes: quoteMintPyFromSy / quoteRedeemPyToSy are the indicative source.
 * Token variants chain through the wrap/unwrap quote (quoteWrap →
 * quoteMintPyFromSy, quoteRedeemPyToSy → quoteUnwrap) and are labeled as
 * rough estimates. Same wire-up rules as WrapUnwrapPanel: plan only for
 * valid, positive, ≤-balance input with a live quote; stub throws are caught.
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount, usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import type { ActionPlan, MarketSnapshot, Positions } from '../lib/types'
import { useActionFlow, useActiveChain } from '../lib/hooks'
import {
  planMintPyFromSy,
  planMintPyFromToken,
  planRedeemPyToSy,
  planRedeemPyToToken,
  quoteMintPyFromSy,
  quoteRedeemPyToSy,
  quoteUnwrap,
  quoteWrap,
} from '../lib/actions'
import { AmountInput } from './AmountInput'
import { parseAmount } from './parseAmount'
import { IndicativeQuote, TxStatus } from './TxStatus'
import { TxButton } from './TxButton'
import { clampLabel, shortAddress } from './format'
import { applySlippage, useSlippage } from './prefs'
import { findWalletBalance, isNativeEth, sameAddress, useTokenMetas } from './tokens'
import { useDebouncedValue } from './useDebouncedValue'

type Direction = 'mint' | 'redeem'
/** Select value: the SY itself, or a tokensIn/tokensOut address. */
const SY_CHOICE = 'sy'

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

export function MintRedeemPanel({
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

  const [direction, setDirection] = useState<Direction>('mint')
  const [choiceByDir, setChoiceByDir] = useState<Partial<Record<Direction, string>>>({})
  const [amountText, setAmountText] = useState('')

  const tokenList = direction === 'mint' ? sy.tokensIn : sy.tokensOut
  const metas = useTokenMetas([...sy.tokensIn, ...sy.tokensOut])

  const rawChoice = choiceByDir[direction] ?? SY_CHOICE
  const choiceIsSy =
    rawChoice === SY_CHOICE || !tokenList.some((t) => sameAddress(t, rawChoice))
  const token = choiceIsSy ? undefined : (rawChoice as Address)
  const tokenMeta = token !== undefined ? metas[token.toLowerCase()] : undefined
  const tokenSymbol =
    tokenMeta?.symbol ?? (token !== undefined ? shortAddress(token) : sy.symbol)

  const pySymbol = 'PT + YT'
  const pyDecimals = sy.assetDecimals

  // Input side: mint spends the source (SY or token); redeem spends PY units.
  const inSymbol = direction === 'mint' ? (choiceIsSy ? sy.symbol : tokenSymbol) : pySymbol
  const inDecimals =
    direction === 'mint' ? (choiceIsSy ? sy.decimals : tokenMeta?.decimals) : pyDecimals
  const inIsNative = direction === 'mint' && token !== undefined && isNativeEth(token)
  const balance = (() => {
    if (direction === 'redeem') {
      if (positions === undefined) return undefined
      return minBigint(positions.pt, positions.yt)
    }
    if (choiceIsSy) return positions?.sy
    return token !== undefined ? findWalletBalance(positions, token) : undefined
  })()

  // Output side: mint receives PY; redeem receives SY or a tokensOut entry.
  const outSymbol = direction === 'mint' ? pySymbol : choiceIsSy ? sy.symbol : tokenSymbol
  const outDecimals =
    direction === 'mint' ? pyDecimals : choiceIsSy ? sy.decimals : tokenMeta?.decimals

  const parsed = inDecimals !== undefined ? parseAmount(amountText, inDecimals) : {}
  const amount = parsed.amount

  const chained = !choiceIsSy // token variants estimate via wrap/unwrap chaining
  const debouncedKey = useDebouncedValue(amount?.toString() ?? '', 350)
  const debouncedAmount = debouncedKey !== '' ? BigInt(debouncedKey) : undefined
  const quoteEnabled =
    client !== undefined && debouncedAmount !== undefined && debouncedAmount > 0n
  const quoteQuery = useQuery({
    queryKey: [
      'm2-quote-mint-redeem',
      activeChainId,
      snapshot.address.toLowerCase(),
      direction,
      choiceIsSy ? SY_CHOICE : token?.toLowerCase(),
      debouncedKey,
    ],
    queryFn: async () => {
      if (direction === 'mint') {
        if (choiceIsSy) return quoteMintPyFromSy(client!, snapshot, debouncedAmount!)
        const syOut = await quoteWrap(client!, sy, token!, debouncedAmount!)
        return quoteMintPyFromSy(client!, snapshot, syOut)
      }
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
  const minOut = quote !== undefined ? applySlippage(quote, slippage) : undefined

  const { plan, reason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (!isConnected || user === undefined) return { plan: null, reason: null } // TxButton → Connect wallet
    if (inDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    // Output token metadata unknown (redeem to an unreadable token): refuse to
    // plan rather than displaying min-out/quotes with a guessed 18 decimals.
    if (outDecimals === undefined) return { plan: null, reason: 'Token metadata unavailable' }
    if (parsed.error) return { plan: null, reason: 'Fix the amount' }
    if (amount === undefined || amount === 0n) return { plan: null, reason: 'Enter an amount' }
    if (balance === undefined) return { plan: null, reason: 'Loading balances…' }
    if (amount > balance) {
      return {
        plan: null,
        reason: direction === 'redeem' ? 'Insufficient PT/YT' : `Insufficient ${clampLabel(inSymbol, 16)}`,
      }
    }
    if (quoteLoading) return { plan: null, reason: 'Fetching quote…' }
    if (quoteUnavailable || minOut === undefined) return { plan: null, reason: 'Quote unavailable' }
    try {
      let built: ActionPlan
      if (direction === 'mint') {
        built = choiceIsSy
          ? planMintPyFromSy(snapshot, amount, minOut, user)
          : planMintPyFromToken(snapshot, token!, tokenSymbol, inDecimals, amount, minOut, user)
      } else {
        built = choiceIsSy
          ? planRedeemPyToSy(snapshot, amount, minOut, user)
          : planRedeemPyToToken(snapshot, token!, tokenSymbol, outDecimals, amount, minOut, user)
      }
      return { plan: built, reason: null }
    } catch {
      return { plan: null, reason: 'Action unavailable' }
    }
  }, [
    isConnected, user, inDecimals, outDecimals, parsed.error, amount, balance, direction,
    inSymbol, quoteLoading, quoteUnavailable, minOut, choiceIsSy, snapshot, token,
    tokenSymbol,
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

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
          {(
            [
              ['mint', 'Mint PT + YT'],
              ['redeem', 'Redeem PT + YT'],
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
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-zinc-500">
          {direction === 'mint' ? 'Mint from' : 'Redeem to'}
          <select
            value={choiceIsSy ? SY_CHOICE : token}
            disabled={flowBusy}
            onChange={(e) => {
              setChoiceByDir((prev) => ({ ...prev, [direction]: e.target.value }))
              setAmountText('')
            }}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
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

      <p className="text-xs leading-relaxed text-zinc-500">
        Minting splits SY into <span className="text-zinc-300">equal amounts of PT and YT</span>;
        redeeming recombines them 1:1 back into SY.
      </p>

      <AmountInput
        label={direction === 'mint' ? 'You mint with' : 'You redeem'}
        value={amountText}
        onChange={setAmountText}
        symbol={inSymbol}
        decimals={inDecimals}
        balance={balance}
        isNative={inIsNative}
        disabled={flowBusy}
        error={parsed.error}
        balanceHint={
          direction === 'redeem'
            ? 'needs equal PT and YT — max = min(PT, YT) balance'
            : undefined
        }
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
          note={
            chained
              ? direction === 'mint'
                ? 'Rough estimate chained through wrap → mint — the binding number is simulated before you confirm.'
                : 'Rough estimate chained through redeem → unwrap — the binding number is simulated before you confirm.'
              : 'Estimated at the current PY index — the binding number is simulated before you confirm.'
          }
        />
      )}

      <TxButton
        flow={flow}
        actionLabel={direction === 'mint' ? 'mint' : 'redeem'}
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
    </div>
  )
}
