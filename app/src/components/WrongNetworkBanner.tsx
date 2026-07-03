/**
 * WrongNetworkBanner — shown when a connected wallet sits on a chain other
 * than Arbitrum One (42161). Browsing still works (reads use the RPC
 * transport, not the wallet); this banner gates future tx buttons and offers
 * a one-click switch.
 */

import { useAccount, useSwitchChain } from 'wagmi'
import { arbitrum } from 'wagmi/chains'

export function WrongNetworkBanner() {
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()

  if (!isConnected || chainId === arbitrum.id) return null

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-center gap-3 border-b border-amber-900/60 bg-amber-950/70 px-4 py-2.5 text-sm text-amber-200"
    >
      <span>
        Your wallet is on the wrong network — OpenPendle only works on Arbitrum One.
      </span>
      <button
        onClick={() => switchChain({ chainId: arbitrum.id })}
        disabled={isPending}
        className="rounded-md bg-amber-500 px-3 py-1 font-medium text-amber-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? 'Switching…' : 'Switch to Arbitrum'}
      </button>
    </div>
  )
}
