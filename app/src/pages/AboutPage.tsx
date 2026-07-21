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
    <div className="mx-auto max-w-[760px] pt-8 pb-16 sm:pt-10">
      <Link to="/" className="text-[13px] font-medium text-muted hover:text-fg">
        ← Home
      </Link>

      <header className="mt-4">
        <h1 className="text-[26px] font-bold tracking-tight text-fg sm:text-[30px]">
          About OpenPendle
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          OpenPendle is a free, open-source, static interface to Pendle V2's{' '}
          <span className="text-fg">permissionless community pools</span> — the markets anyone can
          create, that Pendle's own app doesn't list. Market state comes straight from the chain,
          and every transaction is simulated before you sign.
        </p>
      </header>

      {/* Canonical risk callout (M9) */}
      <div
        role="note"
        className="mt-6 rounded-md border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-[12.5px] leading-relaxed text-warn"
      >
        <span className="font-semibold">Experimental — use at your own risk.</span> Unaudited
        software for a permissionless protocol. Anyone can create a community pool; interacting
        with one can lose you funds. OpenPendle is not affiliated with or operated by Pendle
        Finance, offers no financial advice, and comes with no warranty.
      </div>

      <div className="mt-8 space-y-8">
        <Section title="What community pools are">
          <p>
            Anyone can create a Pendle V2 market for any yield-bearing asset — no whitelist, no
            approval. OpenPendle loads any market by its address; there is no listing or curation
            here by design.
          </p>
        </Section>

        <Section title="What OpenPendle checks — and what it can't">
          <p>
            <span className="text-fg">It checks:</span> that the market was created by a Pendle
            factory OpenPendle recognizes before it lets you save or transact; it simulates every
            transaction against the chain before you sign; and it defaults to exact-amount token
            approvals. Unlimited approval is an explicit opt-in in transaction settings that
            leaves a standing allowance and increases exposure. For PT limit orders, it verifies
            everything you sign against the Limit Router's on-chain hash before submitting the
            order.
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
            OpenPendle adds no fee of its own. Pendle's protocol fees still apply (the swap-fee
            cap, the YT interest fee, and limit-order fees), enforced by Pendle's contracts rather
            than this interface. Limit-order fees are separate from AMM swap fees and can change.
            Read the live values on the{' '}
            <Link to="/status" className="text-accent-ink hover:underline">
              Protocol status
            </Link>{' '}
            page.
          </p>
        </Section>

        <Section title="Your data & privacy">
          <p>
            OpenPendle has no server and no accounts. Saved pools and any custom RPC you set stay
            in your browser's local storage, and the Explore list is a static snapshot bundled
            with the site, refreshed on a schedule. What leaves your browser:
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <span className="text-fg">Pendle API</span> — listing and display data, alerts
              history, and the limit-order service. Opening My positions sends your connected
              wallet address to find official markets; alerts send no address. Submitting a limit
              order sends your wallet address, chain, market, token, amount, target rate, expiry,
              and the signed order.
            </li>
            <li>
              <span className="text-fg">Blockchain RPCs</span> — market state, balances, and
              claims, read from your configured endpoints.
            </li>
            <li>
              <span className="text-fg">DefiLlama and CoinGecko</span> — price requests for the
              header ticker.
            </li>
            <li>
              <span className="text-fg">Blockscout</span> — token lookups.
            </li>
            <li>
              <span className="text-fg">Merkl</span> — your wallet address and supported chain IDs
              when you open My positions.
            </li>
            <li>
              <span className="text-fg">Cloudflare Web Analytics</span> — on the hosted site.
            </li>
          </ul>
          <p>
            A signed limit order can remain executable until it fills, expires, or is cancelled
            on-chain.
          </p>
        </Section>

        <Section title="Open source">
          <p>
            OpenPendle is released under <span className="text-fg">GPL-3.0-or-later</span>. It
            calls Pendle's deployed contracts directly and ships no smart contracts of its own.
            Built by{' '}
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

      <p className="mt-10">
        <Link to="/" className="text-[13px] font-medium text-muted hover:text-fg">
          ← Home
        </Link>
      </p>
    </div>
  )
}
