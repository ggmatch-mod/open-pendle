/**
 * ProtocolStatusPage — /status. The protocol-status card lives here now
 * (moved off Home; linked from the footer). Reuses the existing ProtocolStatus
 * component (which owns the live reads) and shows it expanded on its own page.
 */
import { Link } from 'react-router-dom'
import { useActiveChain } from '../lib/hooks'
import { ProtocolStatus } from '../components/ProtocolStatus'
import { useDocumentTitle } from '../components/useDocumentTitle'

export default function ProtocolStatusPage() {
  useDocumentTitle('Protocol status')
  const { chain } = useActiveChain()

  return (
    <div className="py-8">
      <Link to="/" className="text-sm text-muted hover:text-fg">
        ← Home
      </Link>

      <header className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-[28px] font-bold tracking-[-.03em] text-fg">Protocol status</h1>
        <span
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium text-accent-ink"
          style={{ borderColor: 'rgba(var(--op-accent-rgb),.3)', background: 'rgba(var(--op-accent-rgb),.08)' }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--op-accent)', animation: 'op-pulse 2.4s ease-in-out infinite' }}
          />
          live from {chain.name}
        </span>
      </header>

      <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-muted">
        Active factories are resolved from commonDeploy's immutables at runtime; fee parameters are
        governance-mutable and read live, never hardcoded — no wallet needed.
      </p>

      <div className="mt-5">
        <ProtocolStatus />
      </div>
    </div>
  )
}
