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
          OpenPendle is a free, open-source, static interface to Pendle V2's{' '}
          <span className="text-fg">permissionless community pools</span> — the markets anyone can
          create, that Pendle's own app doesn't list. Core market state comes straight from the chain;
          transactions are simulated before signing, while limit orders use separately validated typed data.{' '}
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
            opt-in that leaves a standing allowance and increases exposure. For supported PT limit
            orders, it independently checks the typed-data domain, every signed field, the signer,
            and the Limit Router's on-chain hash before sending the order to Pendle's service.
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
            limit-order fees, and so on — enforced by Pendle's contracts, not by this interface.
            Limit-order fees are separate from AMM swap fees and can change. You can read Pendle's
            factory and AMM fee values live on the{' '}
            <Link to="/status" className="text-accent-ink hover:underline">
              Protocol Status &amp; Contracts
            </Link>{' '}
            page.
          </p>
        </Section>

        <Section title="Your data & privacy">
          <p>
            There is no request-time OpenPendle app server or account system. The hosted site uses
            Cloudflare Web Analytics. The pools you remember live only in your browser's local storage;
            any custom RPC you set stays local too. Explore inventory comes from a same-origin static
            snapshot generated on a schedule from recognized factory events. Pendle's API supplies
            listing/display data, Alerts history, the hosted limit-order service, and Official-pool
            discovery for My positions. Alerts send no wallet address. Opening My positions sends
            Pendle the connected wallet address to discover relevant Official markets; balances and
            claims are then read from the relevant chains. Generating, submitting, and reading your
            limit orders sends Pendle your wallet address, chain, market/YT, token, amount, target rate,
            expiry, and signed order. A signed order can remain executable until it fills, expires, or
            an on-chain cancellation is confirmed. Other outbound requests go to configured blockchain
            RPCs, DefiLlama and CoinGecko for the header ticker, available Blockscout indexes for token
            lookup, and Merkl when a connected user opens My positions. Merkl receives the wallet
            address and supported chain IDs.
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
