import { useCallback } from 'react'
import { useIsMutating } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAccount, useSwitchChain } from 'wagmi'
import type { SupportedChainId } from '../lib/types'
import { useActiveChain, useTransactionInFlight } from '../lib/hooks'
import { chainSearchForLocation } from '../lib/routes'
import { selectNetwork } from '../lib/networkSelection'

/** User-initiated app + wallet network selection shared by desktop and mobile. */
export function useNetworkSelection() {
  const activeChain = useActiveChain()
  const { isConnected, chainId: walletChainId } = useAccount()
  const { switchChainAsync, isPending } = useSwitchChain()
  const switchMutationsPending = useIsMutating({ mutationKey: ['switchChain'] })
  const isTransactionInFlight = useTransactionInFlight()
  const location = useLocation()
  const navigate = useNavigate()

  const selectChain = useCallback(
    (targetChainId: SupportedChainId) => {
      if (isPending || switchMutationsPending > 0 || isTransactionInFlight) {
        return Promise.resolve('selection-blocked' as const)
      }
      return selectNetwork({
        targetChainId,
        isConnected,
        walletChainId,
        setPreferredChainId: activeChain.setChainId,
        updateRouteChainId: (chainId) => {
          const search = chainSearchForLocation(location.pathname, location.search, chainId)
          if (search !== undefined && search !== location.search) {
            void navigate({ pathname: location.pathname, search }, { replace: true })
          }
        },
        switchWalletChain: (chainId) => switchChainAsync({ chainId }),
      })
    },
    [
      activeChain.setChainId,
      isConnected,
      isPending,
      isTransactionInFlight,
      location.pathname,
      location.search,
      navigate,
      switchChainAsync,
      switchMutationsPending,
      walletChainId,
    ],
  )

  return {
    ...activeChain,
    selectChain,
    isSelectionDisabled:
      isPending || switchMutationsPending > 0 || isTransactionInFlight,
    isTransactionInFlight,
  }
}
