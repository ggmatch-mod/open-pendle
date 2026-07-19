/**
 * MobileNav (M12 responsive) — the header's navigation on screens below `xl`,
 * where the inline nav pills are hidden and the desktop network/RPC controls
 * collapse. A hamburger opens a dropdown holding the nav links (Quick start /
 * Looping / Positions / Saved pools / Create pool) and a compact network switcher, so a phone
 * user can still navigate and change chains (the inline NetworkSelector +
 * RpcSettings are desktop-only; RPC overrides stay a desktop feature). Closes
 * on outside click, Escape, or selecting an item.
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SUPPORTED_CHAINS } from '../lib/addresses'
import { useNetworkSelection } from './useNetworkSelection'

const NAV: { to: string; label: string; glyph: string; external?: boolean }[] = [
  { to: '/quickstart', label: 'Quick start', glyph: '✦' },
  { to: '/explore', label: 'Explore markets', glyph: '◇' },
  { to: '/alerts', label: 'Yield alerts', glyph: '↕' },
  { to: '/looping', label: 'Looping', glyph: '↻' },
  { to: '/positions', label: 'Positions', glyph: '◈' },
  { to: '/pools', label: 'Saved pools', glyph: '★' },
  { to: '/create', label: 'Create pool', glyph: '＋' },
]

export function MobileNav() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { chainId, selectChain, isSelectionDisabled } = useNetworkSelection()

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <div ref={ref} className="relative xl:hidden">
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-hairline bg-surface text-fg hover:bg-surface-2"
      >
        <span aria-hidden className="text-[15px] leading-none">
          {open ? '✕' : '☰'}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-[236px] overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[var(--op-shadow-lg)]">
          <nav className="py-1">
            {NAV.map((item) =>
              item.external ? (
                <a
                  key={item.to}
                  href={item.to}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={close}
                  className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-fg no-underline hover:bg-surface-2"
                >
                  <span aria-hidden className="w-4 text-center text-[12px] text-accent-ink">
                    {item.glyph}
                  </span>
                  {item.label}
                </a>
              ) : (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={close}
                  className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-fg no-underline hover:bg-surface-2"
                >
                  <span aria-hidden className="w-4 text-center text-[12px] text-accent-ink">
                    {item.glyph}
                  </span>
                  {item.label}
                </Link>
              ),
            )}
          </nav>

          <div className="border-t border-hairline px-4 py-2.5">
            <p className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">Network</p>
            <div className="grid grid-cols-2 gap-1">
              {SUPPORTED_CHAINS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={isSelectionDisabled}
                  onClick={() => {
                    void selectChain(c.id)
                    close()
                  }}
                  className={`flex items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-left text-[12px] disabled:cursor-wait disabled:opacity-60 ${
                    c.id === chainId
                      ? 'bg-[rgba(var(--op-accent-rgb),0.12)] font-medium text-accent-ink'
                      : 'text-fg hover:bg-surface-2'
                  }`}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
