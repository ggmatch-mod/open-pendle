/** Standard page top: optional back link, title, one-line lede, right-side actions. */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export function PageHeader({
  title,
  lede,
  actions,
  back = false,
  children,
}: {
  title: ReactNode
  lede?: ReactNode
  actions?: ReactNode
  back?: boolean
  children?: ReactNode
}) {
  return (
    <div className="mb-6 pt-8 sm:pt-10">
      {back ? (
        <Link
          to="/"
          className="mb-3 inline-block text-[13px] font-medium text-muted no-underline hover:text-fg"
        >
          ← Home
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-bold tracking-tight text-fg sm:text-[30px]">{title}</h1>
          {lede ? <p className="mt-1.5 max-w-[64ch] text-[14px] leading-relaxed text-muted">{lede}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div> : null}
      </div>
      {children}
    </div>
  )
}
