/** Editorial section header: mono index + title + hairline rule + optional meta. */
import type { ReactNode } from 'react'

export function SectionHeader({
  index,
  title,
  meta,
}: {
  index: string
  title: string
  meta?: ReactNode
}) {
  return (
    <div className="mb-5 flex items-center gap-3.5">
      <span className="font-mono text-[12px] font-semibold text-accent-ink">{index}</span>
      <h2 className="text-[21px] font-bold tracking-[-.02em] text-fg">{title}</h2>
      <span className="h-px flex-1 bg-hairline" />
      {meta ? <span className="font-mono text-[11.5px] text-faint">{meta}</span> : null}
    </div>
  )
}
