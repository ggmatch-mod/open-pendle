/**
 * TxStatus (M2) — the info strip under a TxButton:
 * - ready:      binding quote from simulation — "expected {simulatedOut},
 *               min {minOut}" (minOut is already encoded in the plan)
 * - signing/pending: Arbiscan tx link as soon as the hash exists
 * - confirmed:  success note + Arbiscan link (button shows "Done")
 * - failed:     decoded error from the flow (button shows "Retry")
 *
 * Also exports IndicativeQuote — the pre-approval "estimated" quote row
 * (PLAN §3.2: quotes before approval are indicative, never binding).
 */

import type { ActionFlowState } from './TxButton'
import { arbiscanTxUrl, clampLabel, formatAmount, formatPercent } from './format'

function TxLink({ hash }: { hash: `0x${string}` }) {
  return (
    <a
      href={arbiscanTxUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-emerald-400 underline decoration-emerald-800 underline-offset-2 hover:text-emerald-300"
    >
      {hash.slice(0, 10)}…{hash.slice(-6)} ↗
    </a>
  )
}

export function TxStatus({
  flow,
  out,
}: {
  flow: ActionFlowState
  /** Output token framing for the binding quote (decimals/symbol + plan minOut). */
  out?: { symbol: string; decimals: number; minOut?: bigint }
}) {
  const { phase, simulatedOut, txHash, error } = flow
  const symbol = out ? clampLabel(out.symbol, 16) : ''

  if (phase === 'ready' && simulatedOut !== undefined && out) {
    return (
      <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200/90">
        <span className="font-semibold text-emerald-300">Binding quote (simulated):</span>{' '}
        expected {formatAmount(simulatedOut, out.decimals)} {symbol}
        {out.minOut !== undefined && (
          <>
            , min {formatAmount(out.minOut, out.decimals)} {symbol}
          </>
        )}
      </div>
    )
  }

  if ((phase === 'signing' || phase === 'pending') && txHash) {
    return (
      <p className="text-xs text-zinc-400">
        Transaction sent: <TxLink hash={txHash} />
      </p>
    )
  }

  if (phase === 'confirmed') {
    return (
      <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200/90">
        <span className="font-semibold text-emerald-300">Confirmed.</span>{' '}
        {txHash && <TxLink hash={txHash} />}
      </div>
    )
  }

  if (phase === 'failed') {
    return (
      <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200/90">
        <span className="font-semibold text-red-300">Failed:</span>{' '}
        {error || 'the transaction reverted (no decoded reason).'}
      </div>
    )
  }

  return null
}

/**
 * Pre-approval indicative quote row. The binding number always comes from the
 * simulation (TxStatus above) — this one is labeled "estimated" on purpose.
 */
export function IndicativeQuote({
  loading,
  unavailable,
  amount,
  decimals,
  symbol,
  minOut,
  slippage,
  note,
}: {
  loading?: boolean
  /** Quote call threw (stubs throw until integration; RPC hiccups later). */
  unavailable?: boolean
  amount?: bigint
  decimals: number
  symbol: string
  minOut?: bigint
  slippage: number
  note?: string
}) {
  const sym = clampLabel(symbol, 16)
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-zinc-500">You receive (estimated)</span>
        <span className="font-medium text-zinc-200">
          {loading ? (
            <span className="text-zinc-500">…</span>
          ) : unavailable ? (
            <span className="text-amber-400/90">quote unavailable</span>
          ) : amount !== undefined ? (
            `~${formatAmount(amount, decimals)} ${sym}`
          ) : (
            '—'
          )}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <span className="text-zinc-600">
          Min after {formatPercent(slippage)} slippage
        </span>
        <span className="text-zinc-400">
          {!loading && !unavailable && minOut !== undefined
            ? `${formatAmount(minOut, decimals)} ${sym}`
            : '—'}
        </span>
      </div>
      {note && <p className="mt-1.5 text-[11px] leading-snug text-zinc-600">{note}</p>}
    </div>
  )
}
