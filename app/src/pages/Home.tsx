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
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-hairline-strong border-t-accent align-[-2px] motion-reduce:animate-none"
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
  const { chainId } = useActiveChain()

  if (input.length === 0 || status.status === 'idle') {
    return null
  }

  if (status.status === 'loading') {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> Checking address…
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
            className="mt-2.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:brightness-110"
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
          <Spinner /> Opening market…
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
  description: string
  primaryLabel: string
  title: string
  to: string
  secondary?: { label: string; to: string }
}

const GUIDE_CARDS: GuideCard[] = [
  {
    description:
      'Leverage a PT against a Morpho market and compare looped APY and liquidation distance first.',
    primaryLabel: 'Open Looping',
    title: 'Loop a Pendle PT',
    to: '/looping',
  },
  {
    description: "See which pools' fixed yields moved most in the last 24 hours.",
    primaryLabel: 'View alerts',
    title: 'Spot fixed-yield moves',
    to: '/alerts',
  },
  {
    description:
      'Search every market by name, protocol, or address — listed and community pools are labeled.',
    primaryLabel: 'Explore markets',
    title: 'Find a market',
    to: '/explore',
  },
  {
    description:
      'Swap PT or YT, or set a limit order at your target APY on supported markets.',
    primaryLabel: 'Pick a market',
    title: 'Trade now or set a target',
    to: '/explore',
  },
  {
    description: 'Review balances and claimable rewards across pools you saved.',
    primaryLabel: 'View positions',
    title: 'Track positions and rewards',
    to: '/positions',
    secondary: { label: 'Saved pools', to: '/pools' },
  },
  {
    description: 'Deploy a community market from an existing SY, or create the SY first.',
    primaryLabel: 'Create a pool',
    title: 'Launch a community market',
    to: '/create',
    secondary: { label: 'Create an SY', to: '/create-sy' },
  },
]

function QuickStartCard({ card }: { card: GuideCard }) {
  return (
    <article className="flex flex-col rounded-lg border border-hairline bg-surface p-4 transition hover:-translate-y-0.5 hover:shadow-[var(--op-shadow)] sm:p-5">
      <h3 className="text-[15px] font-semibold tracking-[-.01em] text-fg">{card.title}</h3>
      <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-muted">{card.description}</p>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] font-semibold">
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
          <h1 className="text-balance text-[34px] font-extrabold leading-[1.05] tracking-[-.04em] text-fg sm:text-[46px]">
            The permissionless side of Pendle.
          </h1>
          <p className="mx-auto mt-4 max-w-[60ch] text-[16px] leading-relaxed text-muted">
            Paste an address, or pick a task below.
          </p>

          <div className="mx-auto mt-7 max-w-[680px] text-left">
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
              Quickstart docs ↗
            </a>
          </div>
        </div>
      </section>

      <section aria-labelledby="quick-start-heading">
        <div className="border-b border-hairline pb-4">
          <h2 id="quick-start-heading" className="text-2xl font-bold tracking-tight text-fg">
            What do you want to do?
          </h2>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {GUIDE_CARDS.map((card) => (
            <QuickStartCard key={card.title} card={card} />
          ))}
        </div>
      </section>

      <section className="mt-12 grid gap-x-6 gap-y-2 border-t border-hairline pt-5 text-[12.5px] text-muted sm:grid-cols-3">
        <p><span className="font-semibold text-fg">No account.</span> Saved pools and settings stay in your browser.</p>
        <p><span className="font-semibold text-fg">Exact approvals.</span> Unlimited approvals are opt-in.</p>
        <p><span className="font-semibold text-fg">Simulate first.</span> Transactions are simulated before you sign.</p>
      </section>
    </div>
  )
}
