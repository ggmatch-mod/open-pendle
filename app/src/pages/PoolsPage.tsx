/**
 * Saved pools — the dedicated home for the remembered-pools registry, reachable
 * from the header tab. The landing page shows only a couple of saved pools to
 * stay uncluttered; this page shows ALL of them, grouped + badged by network
 * (PLAN §3.3, M8 cross-chain registry). Same local storage, nothing on a server.
 */

import { Link } from 'react-router-dom'
import { useActiveChain, useRegistry, useRegistrySweep } from '../lib/hooks'
import { RegistryEmptyState, SavedPoolGroups } from '../components/SavedPoolsList'
import { useDocumentTitle } from '../components/useDocumentTitle'

export default function PoolsPage() {
  useDocumentTitle('Saved pools')
  const { pools } = useRegistry()
  const { chainId: activeChainId } = useActiveChain()
  // ONE multicall sweep PER CHAIN for the whole registry (PLAN §3.3).
  const sweep = useRegistrySweep(pools)

  return (
    <div className="py-8">
      <div className="mb-6 flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Saved pools</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Every pool you've remembered, across all networks — stored locally in
            your browser, nowhere else.
          </p>
        </div>
        {pools.length > 0 && (
          <span className="shrink-0 text-xs text-zinc-500">
            {pools.length} remembered
          </span>
        )}
      </div>

      {pools.length === 0 ? (
        <RegistryEmptyState />
      ) : (
        <SavedPoolGroups pools={pools} activeChainId={activeChainId} sweep={sweep} />
      )}

      <p className="mt-8 text-sm">
        <Link to="/" className="text-emerald-400 hover:text-emerald-300">
          ← Back home
        </Link>
      </p>
    </div>
  )
}
