/**
 * AboutPage — /about. The risk, fee & "how it works" disclosure (M9). Linked
 * from the footer. Plain, honest, no marketing: what community pools are, what
 * OpenPendle checks and can't check, the fee stance, and the privacy model.
 */
import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../components/useDocumentTitle'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-hairline pt-6">
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  )
}

export default function AboutPage() {
  useDocumentTitle('About, risks & fees')

  return (
    <div className="mx-auto max-w-[760px] py-8">
      <Link to="/" className="text-sm text-muted hover:text-fg">
        ← Home
      </Link>

      <header className="mt-4">
        <h1 className="text-[28px] font-bold tracking-[-.03em] text-fg">About OpenPendle</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          OpenPendle is a free, open-source, backend-free interface to Pendle V2's{' '}
          <span className="text-fg">permissionless community pools</span> — the markets anyone can
          create, that Pendle's own app doesn't list. It reads straight from the chain and simulates
          every transaction before you sign.{' '}
          <span className="text-accent-ink">It is a gift to Pendle's community and takes no fee of its own.</span>
        </p>
      </header>

      {/* Prominent risk callout */}
      <div
        role="note"
        className="mt-6 rounded-[16px] border p-5"
        style={{ borderColor: 'var(--op-warn-bd)', background: 'var(--op-warn-soft)' }}
      >
        <p className="text-sm font-semibold text-warn">Experimental — use at your own risk</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          This is novel, unaudited software for a permissionless protocol. Community pools are{' '}
          <span className="text-warn">unreviewed</span> and can be created by anyone; interacting
          with them can lose you funds. OpenPendle is <span className="text-fg">not affiliated with,
          endorsed by, or operated by Pendle Finance</span>. Nothing here is financial advice, and it
          comes with no warranty of any kind.
        </p>
      </div>

      <div className="mt-8 space-y-8">
        <Section title="What community pools are">
          <p>
            Anyone can permissionlessly create a Pendle V2 market for any yield-bearing asset —
            no whitelist, no approval. OpenPendle loads any market by its address; there is no
            listing or curation here by design. A market being loadable is <span className="text-fg">not</span>{' '}
            an endorsement of it.
          </p>
        </Section>

        <Section title="What OpenPendle checks — and what it can't">
          <p>
            <span className="text-fg">It checks:</span> that the market was created by a Pendle
            factory OpenPendle recognizes (a provenance gate) before it lets you save or transact;
            it simulates every transaction against the chain before you sign; and it defaults to
            exact-amount token approvals. Unlimited approval is an explicit transaction-setting
            opt-in that leaves a standing allowance and increases exposure.
          </p>
          <p>
            <span className="text-fg">It can't:</span> vouch for the underlying asset or the SY
            (Standardized Yield) contract a pool wraps. A factory-valid market can still wrap a
            malicious, broken, or exotic asset. Read the trust panel on each pool, and never
            interact with one unless you trust whoever created it and the assets underneath.
          </p>
        </Section>

        <Section title="Fees">
          <p>
            OpenPendle charges <span className="text-accent-ink">nothing</span> and adds no fee of
            its own. Pendle's own protocol fees still apply — the swap-fee cap, the YT interest fee,
            and so on — enforced by Pendle's contracts, not by this interface. You can read those
            live on the{' '}
            <Link to="/status" className="text-accent-ink hover:underline">
              Protocol Status &amp; Contracts
            </Link>{' '}
            page.
          </p>
        </Section>

        <Section title="Your data & privacy">
          <p>
            No backend, no accounts, no tracking, no analytics. The pools you remember live only in
            your browser's local storage; any custom RPC you set stays local too. Outbound requests
            go to your configured blockchain RPCs, DefiLlama and CoinGecko for the header ticker,
            Pendle's market API and, where available, Blockscout indexes when resolving a pasted
            PT/YT to its pool, and Merkl when a connected user opens My positions. Merkl receives the
            wallet address and chain ID needed to look up rewards. None of these calls are analytics
            or tracking.
          </p>
        </Section>

        <Section title="Open source">
          <p>
            OpenPendle is released under <span className="text-fg">GPL-3.0-or-later</span>. It calls
            Pendle's deployed contracts with hand-written ABIs and ships no smart contracts of its
            own. Built by{' '}
            <a
              href="https://x.com/ggmxbt"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-ink hover:underline"
            >
              ggmxbt
            </a>
            .
          </p>
        </Section>
      </div>

      <p className="mt-10 text-sm">
        <Link to="/" className="text-accent-ink hover:text-accent-ink">
          ← Back home
        </Link>
      </p>
    </div>
  )
}
