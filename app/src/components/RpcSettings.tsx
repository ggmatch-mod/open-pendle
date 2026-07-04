/**
 * RpcSettings (M8) — per-chain RPC override for the ACTIVE network.
 *
 * Each supported chain has its own RPC override (localStorage
 * `openpendle.rpc.<chainId>`, Arbitrum also honoring the legacy un-suffixed
 * key). This panel shows/edits the ACTIVE chain's endpoint: read via
 * getChainRpcUrl(activeChainId), save via setChainRpcUrl(activeChainId, url),
 * reset to DEFAULT_RPCS[activeChainId]. The wagmi transports read these at
 * startup, so applying a change reloads the page.
 */

import { useEffect, useRef, useState } from 'react'
import { DEFAULT_RPCS, getChainRpcUrl, setChainRpcUrl } from '../lib/addresses'
import { useActiveChain } from '../lib/hooks'

export function RpcSettings() {
  const { chainId, chain } = useActiveChain()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)

  const defaultUrl = DEFAULT_RPCS[chainId]

  // Load the active chain's current RPC when opening (or when the active chain
  // changes while open).
  useEffect(() => {
    if (open) setValue(getChainRpcUrl(chainId))
  }, [open, chainId])

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
  // A dot marks a non-default (custom) endpoint for the active chain.
  const isCustom = getChainRpcUrl(chainId) !== defaultUrl

  const save = () => {
    if (!isValidUrl) return
    setChainRpcUrl(chainId, trimmed)
    window.location.reload()
  }

  const reset = () => {
    // Empty string clears the override back to the default (per the lib helper).
    setChainRpcUrl(chainId, '')
    window.location.reload()
  }

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-sm text-muted hover:border-hairline-strong hover:bg-surface"
        title={`RPC settings (${chain.name})`}
      >
        <span aria-hidden="true">⚙</span>
        RPC
        {isCustom && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-accent"
            title={`Custom ${chain.name} RPC active`}
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="RPC settings"
          className="absolute right-0 z-20 mt-2 w-80 rounded-xl border border-hairline bg-surface p-4 shadow-xl shadow-black/50"
        >
          <h3 className="text-sm font-semibold text-fg">
            Custom RPC endpoint — {chain.name}
          </h3>
          <p className="mt-1 text-xs text-faint">
            All {chain.name} reads go through this RPC. Public endpoints
            rate-limit; a personal endpoint (Alchemy, Infura, dRPC…) is smoother.
            Each network has its own override. Saving reloads the app.
          </p>
          <input
            type="url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
            placeholder={defaultUrl}
            spellCheck={false}
            className="mt-3 w-full rounded-md border border-hairline-strong bg-bg px-3 py-2 font-mono text-xs text-fg placeholder-[color:var(--op-faint)] outline-none focus:border-accent"
          />
          {!isValidUrl && trimmed.length > 0 && (
            <p className="mt-1 text-xs text-danger">Must be an http(s) URL.</p>
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              onClick={reset}
              className="rounded-md px-2 py-1.5 text-xs text-muted hover:text-fg"
            >
              Reset to default
            </button>
            <button
              onClick={save}
              disabled={!isValidUrl}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save &amp; reload
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
