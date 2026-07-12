/**
 * TxButton (M2) — the single action button driven by useActionFlow's phase
 * (approve → simulate → confirm lifecycle, PLAN §3.2). Full phase map:
 *
 *   (not connected) / needs-wallet → "Connect wallet" (RainbowKit modal)
 *   wrong-network                  → "Switch to <active chain>" (M8)
 *   checking                       → spinner "Checking balances & allowances…"
 *   needs-approval                 → "Approve {pendingApproval.symbol}" → approve()
 *   approving                      → spinner "Approving {symbol}…"
 *   simulating                     → spinner "Simulating…"
 *   ready                          → "Confirm {action}" → execute()
 *                                    (TxStatus shows the binding quote)
 *   signing                        → spinner "Confirm in your wallet…"
 *   pending                        → spinner "Transaction pending…"
 *   confirmed                      → "Done" → onDone (reset + refetch + clear)
 *   failed                         → "Retry" → onRetry ?? reset()  (error text
 *                                    in TxStatus; panels use onRetry to also
 *                                    refresh their quote before re-arming)
 *   idle                           → disabled; shows disabledReason (no plan:
 *                                    "Enter an amount" / "Insufficient X") or
 *                                    the action label while the flow stub/plan
 *                                    hasn't produced a phase yet.
 *
 * User-rejected signatures return to 'ready' silently inside the hook.
 */

import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useIsMutating } from '@tanstack/react-query'
import { useAccount, useSwitchChain } from 'wagmi'
import { useActiveChain } from '../lib/hooks'
import type { useActionFlow } from '../lib/hooks'
import { clampLabel } from './format'

export type ActionFlowState = ReturnType<typeof useActionFlow>

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-hairline-strong border-t-fg"
    />
  )
}

const BASE =
  'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors'
const PRIMARY = `${BASE} bg-accent text-white hover:brightness-110`
const DISABLED = `${BASE} cursor-not-allowed bg-surface-2 text-faint`
const BUSY = `${BASE} cursor-wait bg-surface-2 text-muted`

export function TxButton({
  flow,
  actionLabel,
  disabledReason,
  onDone,
  onRetry,
}: {
  flow: ActionFlowState
  /** e.g. "Wrap", "Mint PT + YT" — used for "Confirm {actionLabel}". */
  actionLabel: string
  /** Why no plan was built (wire-up rules) — rendered as the disabled label. */
  disabledReason?: string | null
  /** Confirmed-state "Done": reset the flow, refetch positions, clear inputs. */
  onDone: () => void
  /** Failed-state "Retry" — defaults to flow.reset (panels add quote refreshes). */
  onRetry?: () => void
}) {
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { switchChain, isPending } = useSwitchChain()
  const switchMutationsPending = useIsMutating({ mutationKey: ['switchChain'] })
  const isSwitching = isPending || switchMutationsPending > 0
  // M8: switch the wallet to the app's ACTIVE chain (was hardcoded Arbitrum).
  const { chainId: activeChainId, chain: activeChain } = useActiveChain()

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

  // Network selection updates the active read client synchronously, while the
  // action-flow effect reclassifies an old ready/approval phase after render.
  // Suppress every actionable state during that gap so an A-chain simulation
  // can never be confirmed against the newly selected B-chain context.
  if (isSwitching) {
    return (
      <button type="button" disabled className={BUSY}>
        <Spinner /> Switching network…
      </button>
    )
  }

  const approvalSymbol = clampLabel(flow.pendingApproval?.symbol ?? 'token', 16)

  switch (flow.phase) {
    case 'wrong-network':
      return (
        <button
          type="button"
          onClick={() => switchChain({ chainId: activeChainId })}
          className={`${BASE} bg-warn text-white hover:bg-warn`}
        >
          Switch to {activeChain.name}
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
          className={`${BASE} border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink hover:bg-[rgba(var(--op-accent-rgb),0.12)]`}
        >
          Done
        </button>
      )
    case 'failed':
      return (
        <button
          type="button"
          onClick={onRetry ?? flow.reset}
          className={`${BASE} border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] text-warn hover:bg-amber-900/50`}
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
