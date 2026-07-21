import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../components/useDocumentTitle'

export default function QuickStartPage() {
  useDocumentTitle('Quick start')

  return (
    <section className="mx-auto max-w-2xl py-16 sm:py-24">
      <h1 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">
        The quick start moved to the docs.
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-muted">
        It covers every feature, from trading to market creation.
      </p>
      <div className="mt-7 flex flex-wrap gap-3">
        <a
          href="https://docs.openpendle.com/introduction/quickstart"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center rounded-[10px] bg-accent px-4 text-sm font-semibold text-accent-fg no-underline hover:brightness-110"
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
    </section>
  )
}
