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
import { useActiveChain } from '../lib/hooks'
import { clampLabel, explorerTxUrl, formatAmount, formatPercent } from './format'

function TxLink({ hash }: { hash: `0x${string}` }) {
  const { chainId } = useActiveChain()
  return (
    <a
      href={explorerTxUrl(chainId, hash)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-accent-ink underline decoration-[rgba(var(--op-accent-rgb),0.5)] underline-offset-2 hover:text-accent-ink"
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
      <div className="rounded-lg border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] px-3 py-2 text-xs text-accent-ink/90">
        <span className="font-semibold text-accent-ink">Binding quote (simulated):</span>{' '}
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
      <p className="text-xs text-muted">
        Transaction sent: <TxLink hash={txHash} />
      </p>
    )
  }

  if (phase === 'confirmed') {
    return (
      <div className="rounded-lg border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] px-3 py-2 text-xs text-accent-ink/90">
        <span className="font-semibold text-accent-ink">Confirmed.</span>{' '}
        {txHash && <TxLink hash={txHash} />}
      </div>
    )
  }

  if (phase === 'failed') {
    return (
      <div className="rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-3 py-2 text-xs text-red-200/90">
        <span className="font-semibold text-danger">Failed:</span>{' '}
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
    <div className="rounded-lg border border-hairline bg-bg-2 px-3 py-2.5 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-faint">You receive (estimated)</span>
        <span className="font-medium text-fg">
          {loading ? (
            <span className="text-faint">…</span>
          ) : unavailable ? (
            <span className="text-warn">quote unavailable</span>
          ) : amount !== undefined ? (
            `~${formatAmount(amount, decimals)} ${sym}`
          ) : (
            '—'
          )}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <span className="text-faint">
          Min after {formatPercent(slippage)} slippage
        </span>
        <span className="text-muted">
          {!loading && !unavailable && minOut !== undefined
            ? `${formatAmount(minOut, decimals)} ${sym}`
            : '—'}
        </span>
      </div>
      {note && <p className="mt-1.5 text-[11px] leading-snug text-faint">{note}</p>}
    </div>
  )
}
