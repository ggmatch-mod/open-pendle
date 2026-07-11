import { SUPPORTED_CHAINS } from '../lib/addresses'
import type { SavedPool, SupportedChainId } from '../lib/types'

/** Group saved pools by their own chainId, active chain first, then SUPPORTED_CHAINS order. */
export function groupPoolsByChain(
  pools: SavedPool[],
  activeChainId: SupportedChainId,
): { chainId: SupportedChainId; pools: SavedPool[] }[] {
  const byChain = new Map<SupportedChainId, SavedPool[]>()
  for (const pool of pools) {
    const chainPools = byChain.get(pool.chainId)
    if (chainPools) chainPools.push(pool)
    else byChain.set(pool.chainId, [pool])
  }

  const order = [
    activeChainId,
    ...SUPPORTED_CHAINS.map((chain) => chain.id).filter((id) => id !== activeChainId),
  ]

  return order
    .filter((id) => byChain.has(id))
    .map((chainId) => ({
      chainId,
      pools: (byChain.get(chainId) ?? []).sort((a, b) => b.savedAt - a.savedAt),
    }))
}

/** Most-recently-saved first, across all chains (for the Home preview slice). */
export function poolsByRecency(pools: SavedPool[]): SavedPool[] {
  return [...pools].sort((a, b) => b.savedAt - a.savedAt)
}
