/**
 * ProtocolStatusPage — /status. "Protocol Status & Contracts": the live Pendle
 * wiring on EVERY supported network, one card per chain (active chain first).
 * Each card reuses the ProtocolStatus component (live reads for its own chain).
 * Moved off Home; linked from the footer.
 */
import { Link } from 'react-router-dom'
import { SUPPORTED_CHAINS } from '../lib/addresses'
import { useActiveChain } from '../lib/hooks'
import { ProtocolStatus } from '../components/ProtocolStatus'
import { useDocumentTitle } from '../components/useDocumentTitle'

export default function ProtocolStatusPage() {
  useDocumentTitle('Protocol status & contracts')
  const { chainId: activeChainId } = useActiveChain()
  // Active chain first, then the rest in SUPPORTED_CHAINS display order.
  const chains = [
    ...SUPPORTED_CHAINS.filter((c) => c.id === activeChainId),
    ...SUPPORTED_CHAINS.filter((c) => c.id !== activeChainId),
  ]

  return (
    <div className="py-8">
      <Link to="/" className="text-sm text-muted hover:text-fg">
        ← Home
      </Link>

      <header className="mt-4">
        <h1 className="text-[28px] font-bold tracking-[-.03em] text-fg">
          Protocol Status &amp; Contracts
        </h1>
        <p className="mt-3 max-w-[72ch] text-sm leading-relaxed text-muted">
          The live Pendle wiring on every supported network. Active factories are
          resolved from commonDeploy's immutables at runtime; fee parameters are
          governance-mutable and read live from the chain, never hardcoded — no wallet
          needed. Each contract links to its block explorer.
        </p>
      </header>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {chains.map((c) => (
          <ProtocolStatus key={c.id} chainId={c.id} />
        ))}
      </div>
    </div>
  )
}
