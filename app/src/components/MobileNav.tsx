/**
 * MobileNav (M12 responsive) — the header's navigation on screens below `xl`,
 * where the inline nav pills are hidden and the desktop network/RPC controls
 * collapse. A hamburger opens a dropdown holding the product and personal
 * links plus a compact network switcher, so a phone user can still navigate
 * and change chains. Disconnected users reach RPC overrides on desktop;
 * connected users also get them in the Profile menu on mobile. Closes on
 * outside click, Escape, or selecting an item.
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { NetworkPicker } from './NetworkPicker'

const NAV: { to: string; label: string; glyph: string; external?: boolean }[] = [
  { to: '/explore', label: 'Explore', glyph: '◇' },
  { to: '/looping', label: 'Looping', glyph: '↻' },
  { to: '/alerts', label: 'Alerts', glyph: '↕' },
  { to: '/positions', label: 'Positions', glyph: '◈' },
  { to: '/pools', label: 'Saved pools', glyph: '★' },
  { to: '/create', label: 'Create pool', glyph: '＋' },
  {
    to: 'https://docs.openpendle.com/introduction/quickstart',
    label: 'Docs',
    glyph: '?',
    external: true,
  },
]

const MOBILE_NAV_PANEL_ID = 'openpendle-mobile-nav-panel'

export function MobileNav() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
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
    <div ref={ref} className="relative lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls={MOBILE_NAV_PANEL_ID}
        onClick={() => setOpen((o) => !o)}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-hairline bg-surface text-fg hover:bg-surface-2"
      >
        <span aria-hidden className="text-[15px] leading-none">
          {open ? '✕' : '☰'}
        </span>
      </button>

      {open && (
        <div
          id={MOBILE_NAV_PANEL_ID}
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[236px] overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[var(--op-shadow-lg)]"
        >
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
            <NetworkPicker onSelect={close} />
          </div>
        </div>
      )}
    </div>
  )
}
