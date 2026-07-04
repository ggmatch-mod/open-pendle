/**
 * AmountInput (M2) — big numeric amount field with token label, wallet
 * balance line and Max button. Parsing is bigint-safe via viem parseUnits
 * (components/parseAmount.ts); NaN can never escape — invalid text yields an
 * error string and no amount. Native Max keeps a chain-sized gas buffer
 * (nativeGasBuffer — larger on Ethereum mainnet, small on the L2s).
 */

import { formatUnits } from 'viem'
import { useActiveChain } from '../lib/hooks'
import { clampLabel, formatAmount } from './format'
import { nativeGasBuffer } from './parseAmount'

export function AmountInput({
  label,
  value,
  onChange,
  symbol,
  decimals,
  balance,
  isNative = false,
  disabled = false,
  error,
  balanceHint,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  symbol: string
  /** Undefined = token metadata still loading/failed — input disabled. */
  decimals?: number
  /** Undefined = wallet balance unknown (not connected / positions loading). */
  balance?: bigint
  isNative?: boolean
  disabled?: boolean
  /** Parse error computed by the panel (parseAmount(...).error). */
  error?: string
  /** Extra note after the balance, e.g. "min of PT and YT". */
  balanceHint?: string
}) {
  const inputDisabled = disabled || decimals === undefined

  // The native token shown here always belongs to the active chain (markets and
  // creation flows operate on the active chain), so the gas reserve is sized for
  // it — larger on Ethereum mainnet, small on the L2s.
  const { chainId } = useActiveChain()
  const gasBuffer = nativeGasBuffer(chainId)

  const maxAmount = (() => {
    if (balance === undefined || decimals === undefined) return undefined
    if (!isNative) return balance
    return balance > gasBuffer ? balance - gasBuffer : 0n
  })()

  const setMax = () => {
    if (maxAmount === undefined || decimals === undefined) return
    onChange(formatUnits(maxAmount, decimals))
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-xs text-zinc-500">{label}</label>
        <p className="text-xs text-zinc-500">
          Balance:{' '}
          <span className="text-zinc-400">
            {balance !== undefined && decimals !== undefined
              ? `${formatAmount(balance, decimals)} ${clampLabel(symbol, 16)}`
              : '—'}
          </span>
          {balanceHint && <span className="text-zinc-600"> · {balanceHint}</span>}
        </p>
      </div>

      <div
        className={`mt-1.5 flex items-center gap-2 rounded-lg border bg-zinc-950 px-3 py-2.5 focus-within:border-emerald-500 ${
          error ? 'border-red-800' : 'border-zinc-700'
        } ${inputDisabled ? 'opacity-60' : ''}`}
      >
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.0"
          value={value}
          disabled={inputDisabled}
          onChange={(e) => {
            // Keep commas VISIBLE (no eager ','→'.' rewrite): parseAmount
            // converts a plain decimal comma ("1,5") and rejects the ambiguous
            // thousands-separator shape ("1,234" — pasted) with an error,
            // which an eager rewrite would silently misread as 1.234.
            const next = e.target.value
            // Block anything that isn't a decimal-in-progress ('.' or ',').
            if (next === '' || /^\d*[.,]?\d*$/.test(next)) onChange(next)
          }}
          className="min-w-0 flex-1 bg-transparent text-xl font-semibold text-zinc-100 placeholder-zinc-600 outline-none disabled:cursor-not-allowed"
          aria-label={`${label} amount in ${symbol}`}
        />
        <span className="shrink-0 text-sm font-medium text-zinc-400" title={symbol}>
          {clampLabel(symbol, 16)}
        </span>
        <button
          type="button"
          onClick={setMax}
          disabled={inputDisabled || maxAmount === undefined}
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-300 hover:border-emerald-600 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Max
        </button>
      </div>

      {error ? (
        <p className="mt-1 text-xs text-red-400">{error}</p>
      ) : isNative ? (
        <p className="mt-1 text-xs text-zinc-600">
          Max leaves ~{formatUnits(gasBuffer, 18)} {clampLabel(symbol, 16)} for gas.
        </p>
      ) : decimals === undefined ? (
        <p className="mt-1 text-xs text-amber-400/80">
          Token metadata unavailable — cannot size amounts safely.
        </p>
      ) : null}
    </div>
  )
}
