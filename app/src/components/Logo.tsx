/** OpenPendle wordmark + split (SY→PT+YT) logomark. Links home. */
import { Link } from 'react-router-dom'

export function Logo() {
  return (
    <Link to="/" className="flex flex-shrink-0 items-center gap-[11px] no-underline">
      <span
        className="relative flex h-7 w-7 items-center justify-center rounded-[9px]"
        style={{
          background: 'linear-gradient(135deg, var(--op-accent) 0 50%, var(--op-accent-strong) 50% 100%)',
          boxShadow: '0 3px 11px -2px rgba(var(--op-accent-rgb),.55)',
        }}
      >
        <span className="h-2 w-2 rounded-full" style={{ background: 'var(--op-accent-fg)', opacity: 0.92 }} />
      </span>
      <span className="text-[17.5px] font-bold tracking-[-.025em] text-fg">
        <span className="text-accent-ink">Open</span>Pendle
      </span>
    </Link>
  )
}
