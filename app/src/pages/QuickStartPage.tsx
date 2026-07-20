import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../components/useDocumentTitle'

export default function QuickStartPage() {
  useDocumentTitle('Quick start')

  return (
    <section className="mx-auto max-w-2xl py-16 sm:py-24">
      <p className="font-mono text-[10.5px] uppercase tracking-[.08em] text-accent-ink">
        Quick start moved
      </p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight text-fg sm:text-4xl">
        The complete guide now lives in the docs.
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-muted">
        The docs Quickstart is now the maintained version, with Looping, Yield alerts, PT limit
        orders, Positions, Saved pools, and market creation alongside the core market flow.
      </p>
      <div className="mt-7 flex flex-wrap gap-3">
        <a
          href="https://docs.openpendle.com/introduction/quickstart"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center rounded-[10px] bg-accent px-4 text-sm font-semibold text-white no-underline hover:brightness-110"
        >
          Open the Quickstart ↗
        </a>
        <Link
          to="/"
          className="inline-flex h-10 items-center rounded-[10px] border border-hairline bg-surface px-4 text-sm font-semibold text-fg no-underline hover:bg-surface-2"
        >
          Back to OpenPendle
        </Link>
      </div>
      <div className="mt-10 grid gap-3 sm:grid-cols-3">
        <Link to="/looping" className="rounded-xl border border-hairline bg-surface p-4 text-sm font-medium text-fg no-underline hover:border-hairline-strong">
          ↻ Looping preview
        </Link>
        <Link to="/alerts" className="rounded-xl border border-hairline bg-surface p-4 text-sm font-medium text-fg no-underline hover:border-hairline-strong">
          ↕ Yield alerts
        </Link>
        <Link to="/explore" className="rounded-xl border border-hairline bg-surface p-4 text-sm font-medium text-fg no-underline hover:border-hairline-strong">
          ◇ Explore markets
        </Link>
      </div>
    </section>
  )
}
