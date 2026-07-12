import type { SupportedChainId } from './types.ts'

export type NetworkSelectionOutcome =
  | 'browse-only'
  | 'already-synced'
  | 'wallet-switched'
  | 'wallet-switch-failed'

/**
 * Apply one explicit network selection. The read network changes immediately;
 * wallet rejection never rolls it back, so browsing remains available.
 */
export async function selectNetwork({
  targetChainId,
  isConnected,
  walletChainId,
  setPreferredChainId,
  updateRouteChainId,
  switchWalletChain,
}: {
  targetChainId: SupportedChainId
  isConnected: boolean
  walletChainId?: number
  setPreferredChainId: (chainId: SupportedChainId) => void
  updateRouteChainId: (chainId: SupportedChainId) => void
  switchWalletChain: (chainId: SupportedChainId) => Promise<unknown>
}): Promise<NetworkSelectionOutcome> {
  setPreferredChainId(targetChainId)
  updateRouteChainId(targetChainId)

  if (!isConnected) return 'browse-only'
  if (walletChainId === targetChainId) return 'already-synced'

  try {
    await switchWalletChain(targetChainId)
    return 'wallet-switched'
  } catch {
    return 'wallet-switch-failed'
  }
}
