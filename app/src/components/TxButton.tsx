/**
 * TxButton (M2) — the single action button driven by useActionFlow's phase
 * (approve → simulate → confirm lifecycle, PLAN §3.2). Full phase map:
 *
 *   (not connected) / needs-wallet → "Connect wallet" (RainbowKit modal)
 *   wrong-network                  → "Switch to Arbitrum"
 *   checking                       → spinner "Checking balances & allowances…"
 *   needs-approval                 → "Approve {pendingApproval.symbol}" → approve()
 *   approving                      → spinner "Approving {symbol}…"
 *   simulating                     → spinner "Simulating…"
 *   ready                          → "Confirm {action}" → execute()
 *                                    (TxStatus shows the binding quote)
 *   signing                        → spinner "Confirm in your wallet…"
 *   pending                        → spinner "Transaction pending…"
 *   confirmed                      → "Done" → onDone (reset + refetch + clear)
 *   failed                         → "Retry" → reset()  (error text in TxStatus)
 *   idle                           → disabled; shows disabledReason (no plan:
 *                                    "Enter an amount" / "Insufficient X") or
 *                                    the action label while the flow stub/plan
 *                                    hasn't produced a phase yet.
 *
 * User-rejected signatures return to 'ready' silently inside the hook.
 */

import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useSwitchChain } from 'wagmi'
import { ARBITRUM_CHAIN_ID } from '../lib/addresses'
import type { useActionFlow } from '../lib/hooks'
import { clampLabel } from './format'

export type ActionFlowState = ReturnType<typeof useActionFlow>

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-500 border-t-zinc-100"
    />
  )
}

const BASE =
  'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors'
const PRIMARY = `${BASE} bg-emerald-600 text-white hover:bg-emerald-500`
const DISABLED = `${BASE} cursor-not-allowed bg-zinc-800 text-zinc-500`
const BUSY = `${BASE} cursor-wait bg-zinc-800 text-zinc-300`

export function TxButton({
  flow,
  actionLabel,
  disabledReason,
  onDone,
}: {
  flow: ActionFlowState
  /** e.g. "Wrap", "Mint PT + YT" — used for "Confirm {actionLabel}". */
  actionLabel: string
  /** Why no plan was built (wire-up rules) — rendered as the disabled label. */
  disabledReason?: string | null
  /** Confirmed-state "Done": reset the flow, refetch positions, clear inputs. */
  onDone: () => void
}) {
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { switchChain, isPending: isSwitching } = useSwitchChain()

  if (!isConnected || flow.phase === 'needs-wallet') {
    return (
      <button
        type="button"
        onClick={() => openConnectModal?.()}
        disabled={!openConnectModal}
        className={PRIMARY}
      >
        Connect wallet
      </button>
    )
  }

  const approvalSymbol = clampLabel(flow.pendingApproval?.symbol ?? 'token', 16)

  switch (flow.phase) {
    case 'wrong-network':
      return (
        <button
          type="button"
          onClick={() => switchChain({ chainId: ARBITRUM_CHAIN_ID })}
          disabled={isSwitching}
          className={`${BASE} bg-amber-600 text-white hover:bg-amber-500 disabled:cursor-wait disabled:opacity-70`}
        >
          {isSwitching && <Spinner />}
          Switch to Arbitrum
        </button>
      )
    case 'checking':
      return (
        <button type="button" disabled className={BUSY}>
          <Spinner /> Checking balances &amp; allowances…
        </button>
      )
    case 'needs-approval':
      return (
        <button type="button" onClick={flow.approve} className={PRIMARY}>
          Approve {approvalSymbol}
        </button>
      )
    case 'approving':
      return (
        <button type="button" disabled className={BUSY}>
          <Spinner /> Approving {approvalSymbol}…
        </button>
      )
    case 'simulating':
      return (
        <button type="button" disabled className={BUSY}>
          <Spinner /> Simulating…
        </button>
      )
    case 'ready':
      return (
        <button type="button" onClick={flow.execute} className={PRIMARY}>
          Confirm {actionLabel}
        </button>
      )
    case 'signing':
      return (
        <button type="button" disabled className={BUSY}>
          <Spinner /> Confirm in your wallet…
        </button>
      )
    case 'pending':
      return (
        <button type="button" disabled className={BUSY}>
          <Spinner /> Transaction pending…
        </button>
      )
    case 'confirmed':
      return (
        <button
          type="button"
          onClick={onDone}
          className={`${BASE} border border-emerald-700 bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/60`}
        >
          Done
        </button>
      )
    case 'failed':
      return (
        <button
          type="button"
          onClick={flow.reset}
          className={`${BASE} border border-amber-800 bg-amber-950/50 text-amber-300 hover:bg-amber-900/50`}
        >
          Retry
        </button>
      )
    case 'idle':
    default:
      return (
        <button type="button" disabled className={DISABLED}>
          {disabledReason ?? actionLabel}
        </button>
      )
  }
}
