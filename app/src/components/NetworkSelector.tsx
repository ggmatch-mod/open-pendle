/**
 * NetworkSelector (M8) — the app's active-network dropdown, in the header.
 *
 * The active chain is the SINGLE source every data hook reads (useActiveChain,
 * localStorage `openpendle.chain`, cross-tab synced). Selecting a chain here
 * calls setChainId, which reloads EVERYTHING the app shows on the new chain —
 * paste box, market pages, protocol status, the create wizards. This is NOT the
 * wallet's network (that's the wrong-network banner's job); it's what the app is
 * pointed at for reads and where a tx will be sent.
 *
 * Styled to match the dark header (RpcSettings / ConnectButton): a bordered
 * pill button + an outside-click popover listing SUPPORTED_CHAINS.
 */

import { useEffect, useRef, useState } from 'react'
import { SUPPORTED_CHAINS } from '../lib/addresses'
import { useActiveChain } from '../lib/hooks'

export function NetworkSelector() {
  const { chainId, setChainId, chain } = useActiveChain()
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900"
        title="Active network — switches what the whole app reads"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
        <span className="max-w-[7.5rem] truncate">{chain.name}</span>
        <span aria-hidden="true" className="text-zinc-500">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Select active network"
          className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/50"
        >
          <p className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-500">
            Active network — reads & transactions
          </p>
          <ul className="py-1">
            {SUPPORTED_CHAINS.map((c) => {
              const isActive = c.id === chainId
              return (
                <li key={c.id}>
                  <button
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => {
                      setChainId(c.id)
                      setOpen(false)
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                      isActive
                        ? 'bg-emerald-950/40 text-emerald-300'
                        : 'text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-100'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          isActive ? 'bg-emerald-400' : 'bg-zinc-600'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="truncate">{c.name}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-zinc-500">
                      {c.nativeSymbol}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
