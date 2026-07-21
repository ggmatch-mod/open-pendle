/**
 * ProtocolStatusPage — /status. "Protocol Status & Contracts": the live Pendle
 * wiring on EVERY supported network, one card per chain (active chain first).
 * Each card reuses the ProtocolStatus component (live reads for its own chain).
 * Moved off Home; linked from the footer.
 */
import { SUPPORTED_CHAINS } from '../lib/addresses'
import { useActiveChain } from '../lib/hooks'
import { PageHeader } from '../components/PageHeader'
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
    <div className="pb-16">
      <PageHeader
        back
        title="Protocol status"
        lede="Live Pendle contracts and fees per network, read from the chain — no wallet needed."
      />

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {chains.map((c) => (
          <ProtocolStatus key={c.id} chainId={c.id} />
        ))}
      </div>
    </div>
  )
}
