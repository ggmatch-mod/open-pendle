/**
 * RpcSettings — small popover for the user-supplied RPC URL (PLAN §3.2).
 * Saves to localStorage (`openpendle.rpc`); the wagmi transport reads it at
 * startup, so applying a change reloads the page (fine for M0).
 */

import { useEffect, useRef, useState } from 'react'
import { DEFAULT_RPC_URL, RPC_STORAGE_KEY } from '../lib/addresses'
import { getRpcUrl } from '../lib/wagmi'

export function RpcSettings() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setValue(getRpcUrl())
  }, [open])

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

  const trimmed = value.trim()
  const isValidUrl = /^https?:\/\/.+/.test(trimmed)
  const isCustom = getRpcUrl() !== DEFAULT_RPC_URL

  const save = () => {
    if (!isValidUrl) return
    try {
      window.localStorage.setItem(RPC_STORAGE_KEY, trimmed)
    } catch {
      // localStorage unavailable — nothing to persist.
    }
    window.location.reload()
  }

  const reset = () => {
    try {
      window.localStorage.removeItem(RPC_STORAGE_KEY)
    } catch {
      // ignore
    }
    window.location.reload()
  }

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-1.5 rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900"
        title="RPC settings"
      >
        <span aria-hidden="true">⚙</span>
        RPC
        {isCustom && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-emerald-400"
            title="Custom RPC active"
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="RPC settings"
          className="absolute right-0 z-20 mt-2 w-80 rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-xl shadow-black/50"
        >
          <h3 className="text-sm font-semibold text-zinc-100">Custom RPC endpoint</h3>
          <p className="mt-1 text-xs text-zinc-500">
            All chain reads go through this Arbitrum One RPC. Public endpoints
            rate-limit; a personal endpoint (Alchemy, Infura, dRPC…) is smoother.
            Saving reloads the app.
          </p>
          <input
            type="url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
            placeholder={DEFAULT_RPC_URL}
            spellCheck={false}
            className="mt-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-emerald-500"
          />
          {!isValidUrl && trimmed.length > 0 && (
            <p className="mt-1 text-xs text-red-400">Must be an http(s) URL.</p>
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              onClick={reset}
              className="rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
            >
              Reset to default
            </button>
            <button
              onClick={save}
              disabled={!isValidUrl}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save &amp; reload
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
