/**
 * WrongNetworkBanner (M8) — shown when a connected wallet sits on a chain other
 * than the app's ACTIVE network (useActiveChain). Browsing still works (reads
 * go through the per-chain RPC transport, not the wallet); this banner gates tx
 * buttons and offers a one-click switch to the active chain.
 *
 * Read-only browsing is unaffected: with no wallet, or a wallet on a different
 * chain, the app keeps reading the active chain — only transacting needs the
 * wallet on the active chain.
 */

import { useAccount, useSwitchChain } from 'wagmi'
import { useIsMutating } from '@tanstack/react-query'
import { supportedChain } from '../lib/addresses'
import { useActiveChain, useTransactionInFlight } from '../lib/hooks'

export function WrongNetworkBanner() {
  const { isConnected, chainId: walletChainId } = useAccount()
  const { chainId: activeChainId, chain: activeChain } = useActiveChain()
  const { switchChain, isPending } = useSwitchChain()
  const switchMutationsPending = useIsMutating({ mutationKey: ['switchChain'] })
  const isSwitching = isPending || switchMutationsPending > 0
  const isTransactionInFlight = useTransactionInFlight()

  // No wallet, or wallet already on the active chain → nothing to warn about.
  if (!isConnected || walletChainId === activeChainId) return null

  // A human name for the wallet's current chain when we recognize it.
  const walletChain = supportedChain(walletChainId)
  const walletChainLabel = walletChain ? walletChain.name : `chain ${walletChainId}`

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-center gap-3 border-b border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-2.5 text-sm text-warn"
    >
      <span>
        Your wallet is on {walletChainLabel} — switch to {activeChain.name} to
        transact. (Browsing still works.)
      </span>
      <button
        onClick={() => switchChain({ chainId: activeChainId })}
        disabled={isSwitching || isTransactionInFlight}
        className="rounded-md bg-warn px-3 py-1 font-medium text-amber-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isTransactionInFlight
          ? 'Transaction pending…'
          : isSwitching
            ? 'Switching…'
            : `Switch to ${activeChain.name}`}
      </button>
    </div>
  )
}
