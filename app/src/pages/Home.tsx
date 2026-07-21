import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getAddress, isAddress } from 'viem'
import { clampLabel } from '../components/format'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { useActiveChain, useClassifyAddress } from '../lib/hooks'
import { marketPath, tokenPath } from '../lib/routes'

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-hairline-strong border-t-accent align-[-2px]"
    />
  )
}

function ClassificationFeedback({
  status,
  input,
}: {
  status: ReturnType<typeof useClassifyAddress>
  input: string
}) {
  const navigate = useNavigate()
  const { chain, chainId } = useActiveChain()

  if (input.length === 0 || status.status === 'idle') {
    return (
      <p className="text-sm text-faint">
        Paste a Pendle V2 market, PT, or YT address on {chain.name}. Search by name in Explore.
      </p>
    )
  }

  if (status.status === 'loading') {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> checking address on-chain…
      </p>
    )
  }

  if (status.status === 'error') {
    return (
      <p className="text-sm text-danger">
        Couldn't check that address — the RPC may be rate-limiting.{' '}
        {status.error ? <span className="text-danger">({status.error})</span> : null}
      </p>
    )
  }

  const classification = status.classification
  if (!classification) return null

  switch (classification.kind) {
    case 'invalid':
      return (
        <p className="text-sm text-danger">
          {classification.message || 'That is not a valid address (0x + 40 hex characters).'}
        </p>
      )
    case 'eoa':
      return (
        <p className="text-sm text-danger">
          {classification.message || "That's a wallet address, not a contract."}
        </p>
      )
    case 'pt':
    case 'yt':
      return (
        <div className="mx-auto max-w-lg rounded-lg border border-hairline-strong bg-surface p-3 text-left">
          <p className="text-sm text-fg">
            {classification.message}
            {classification.symbol && !classification.message.includes(classification.symbol) && (
              <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
                {clampLabel(classification.symbol)}
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => navigate(tokenPath(getAddress(input), chainId))}
            className="mt-2.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
          >
            View this token →
          </button>
        </div>
      )
    case 'sy':
      return (
        <div className="mx-auto max-w-lg rounded-lg border border-hairline-strong bg-surface p-3 text-left">
          <p className="text-sm text-fg">
            {classification.message}
            {classification.symbol && !classification.message.includes(classification.symbol) && (
              <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
                {clampLabel(classification.symbol)}
              </span>
            )}
          </p>
        </div>
      )
    case 'contract':
      if (classification.unvalidatedMarketShape) {
        return (
          <div className="mx-auto max-w-lg rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] p-3 text-left">
            <p className="text-sm text-warn">{classification.message}</p>
          </div>
        )
      }
      return <p className="text-sm text-danger">{classification.message}</p>
    case 'market':
      return (
        <p className="flex items-center justify-center gap-2 text-sm text-accent-ink">
          <Spinner /> Valid Pendle market — opening…
        </p>
      )
  }
}

function MarketPasteBox() {
  const [input, setInput] = useState('')
  const navigate = useNavigate()
  const trimmed = input.trim()
  const classify = useClassifyAddress(trimmed)
  const { classification } = classify
  const { chainId } = useActiveChain()

  useEffect(() => {
    if (classification?.kind === 'market' && isAddress(trimmed, { strict: false })) {
      navigate(marketPath(getAddress(trimmed), chainId))
    }
  }, [chainId, classification, navigate, trimmed])

  return (
    <div className="w-full">
      <label htmlFor="market-address" className="sr-only">
        Pendle market, PT, or YT address
      </label>
      <input
        id="market-address"
        type="search"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        placeholder="Paste a market, PT, or YT address — 0x…"
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded-[15px] border border-hairline-strong bg-surface px-4 py-3.5 font-mono text-sm text-fg placeholder-[color:var(--op-faint)] outline-none transition focus:border-accent focus:ring-2 focus:ring-[rgba(var(--op-accent-rgb),0.2)]"
      />
      <div aria-live="polite" className="mt-2.5 min-h-5 text-center">
        <ClassificationFeedback status={classify} input={trimmed} />
      </div>
    </div>
  )
}

type GuideCard = {
  badge: string
  description: string
  glyph: string
  primaryLabel: string
  title: string
  to: string
  secondary?: { label: string; to: string }
  featured?: boolean
}

const GUIDE_CARDS: GuideCard[] = [
  {
    badge: 'Reviewed beta',
    description:
      'Match reviewed Pendle PT collateral with Morpho markets, compare leveraged APY and liquidation distance, and manage supported loops from your wallet.',
    glyph: '↻',
    primaryLabel: 'Open Looping',
    title: 'Loop a Pendle PT',
    to: '/looping',
    featured: true,
  },
  {
    badge: 'No wallet needed',
    description:
      'See meaningful 24-hour fixed-yield changes across liquid Pendle pools without subscribing to notifications.',
    glyph: '↕',
    primaryLabel: 'View Yield alerts',
    title: 'Spot fixed-yield moves',
    to: '/alerts',
    featured: true,
  },
  {
    badge: 'Six networks',
    description:
      'Search factory-created markets by name, protocol, or address while keeping listed and community provenance visible.',
    glyph: '◇',
    primaryLabel: 'Explore markets',
    title: 'Find a market',
    to: '/explore',
  },
  {
    badge: 'Inside each market',
    description:
      "Swap PT or YT now, or set a target APY with a PT ↔ SY limit order where Pendle's live service supports it.",
    glyph: '⇄',
    primaryLabel: 'Find a market',
    title: 'Trade now or set a target',
    to: '/explore',
  },
  {
    badge: 'Wallet + local registry',
    description:
      'Review balances and claimable rewards across pools you saved. Your saved-pool list stays in this browser.',
    glyph: '◈',
    primaryLabel: 'View positions',
    title: 'Track positions and rewards',
    to: '/positions',
    secondary: { label: 'Saved pools', to: '/pools' },
  },
  {
    badge: 'Permissionless',
    description:
      'Deploy a Pendle community market from an existing SY, or create a basic SY adapter before launching the pool.',
    glyph: '+',
    primaryLabel: 'Create a pool',
    title: 'Launch a community market',
    to: '/create',
    secondary: { label: 'Create an SY', to: '/create-sy' },
  },
]

function QuickStartCard({ card }: { card: GuideCard }) {
  return (
    <article
      className={`flex min-h-[230px] flex-col rounded-[18px] border p-5 transition hover:-translate-y-0.5 hover:shadow-[var(--op-shadow)] ${
        card.featured
          ? 'border-[rgba(var(--op-accent-rgb),0.35)] bg-[rgba(var(--op-accent-rgb),0.06)]'
          : 'border-hairline bg-surface'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-[rgba(var(--op-accent-rgb),0.12)] text-[17px] font-semibold text-accent-ink"
        >
          {card.glyph}
        </span>
        <span className="rounded-full border border-hairline bg-bg px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[.04em] text-faint">
          {card.badge}
        </span>
      </div>
      <h3 className="mt-5 text-[17px] font-semibold tracking-[-.01em] text-fg">{card.title}</h3>
      <p className="mt-2 flex-1 text-[13px] leading-relaxed text-muted">{card.description}</p>
      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] font-semibold">
        <Link to={card.to} className="text-accent-ink no-underline hover:underline">
          {card.primaryLabel} →
        </Link>
        {card.secondary ? (
          <Link to={card.secondary.to} className="text-muted no-underline hover:text-fg hover:underline">
            {card.secondary.label}
          </Link>
        ) : null}
      </div>
    </article>
  )
}

export default function Home() {
  useDocumentTitle()
  const { chain } = useActiveChain()

  return (
    <div className="pb-16">
      <section className="relative pb-8 pt-12 sm:pb-10 sm:pt-14">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-5 bottom-0"
          style={{
            backgroundImage: 'radial-gradient(var(--op-grid) 1px, transparent 1px)',
            backgroundSize: '26px 26px',
            WebkitMaskImage:
              'radial-gradient(ellipse 80% 70% at 50% 25%, #000 30%, transparent 75%)',
            maskImage:
              'radial-gradient(ellipse 80% 70% at 50% 25%, #000 30%, transparent 75%)',
          }}
        />
        <div className="relative mx-auto max-w-[780px] text-center">
          <span className="inline-flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-[.06em] text-muted">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: 'var(--op-accent)', animation: 'op-pulse 2.4s ease-in-out infinite' }}
            />
            Permissionless · on-chain
          </span>
          <h1 className="mt-[18px] text-[42px] font-extrabold leading-[1.03] tracking-[-.04em] text-fg sm:text-[56px]">
            Start with a market —{' '}
            <span className="text-accent-ink">or a goal.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-[60ch] text-[16px] leading-relaxed text-muted">
            Search an address directly, or choose what you want to do below. OpenPendle combines
            discovery, fixed-yield tools, alerts, and permissionless market actions in one interface.
          </p>

          <div className="mx-auto mt-8 max-w-[680px] text-left">
            <label className="mb-2 block font-mono text-[10.5px] uppercase tracking-[.08em] text-faint">
              Open an address on {chain.name}
            </label>
            <MarketPasteBox />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[13px]">
            <Link to="/explore" className="font-semibold text-accent-ink no-underline hover:underline">
              Search markets by name →
            </Link>
            <span aria-hidden className="text-faint">·</span>
            <a
              href="https://docs.openpendle.com/introduction/quickstart"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-muted no-underline hover:text-fg hover:underline"
            >
              Read the full Quickstart ↗
            </a>
          </div>

          <p className="mx-auto mt-5 max-w-[62ch] rounded-[12px] border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-[12px] leading-relaxed text-warn">
            OpenPendle is experimental. Permissionless pools are unreviewed; provenance validation is
            not an endorsement of the asset or SY contract.
          </p>
        </div>
      </section>

      <section aria-labelledby="quick-start-heading">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-hairline pb-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.08em] text-accent-ink">
              Quick start
            </p>
            <h2 id="quick-start-heading" className="mt-1 text-2xl font-bold tracking-tight text-fg">
              What do you want to do?
            </h2>
          </div>
          <p className="max-w-[48ch] text-right text-xs leading-relaxed text-faint sm:text-left">
            Browsing, Alerts, and Looping research work without connecting a wallet.
          </p>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {GUIDE_CARDS.map((card) => (
            <QuickStartCard key={card.title} card={card} />
          ))}
        </div>
      </section>

      <section className="mt-12 grid gap-3 rounded-[16px] border border-hairline bg-bg-2 p-4 text-[12px] text-muted sm:grid-cols-3 sm:p-5">
        <p><span className="font-semibold text-fg">No account.</span> Saved pools and settings stay in your browser.</p>
        <p><span className="font-semibold text-fg">Exact approvals.</span> Unlimited approval remains an explicit opt-in.</p>
        <p><span className="font-semibold text-fg">Simulate first.</span> On-chain actions are checked before signing.</p>
      </section>
    </div>
  )
}
