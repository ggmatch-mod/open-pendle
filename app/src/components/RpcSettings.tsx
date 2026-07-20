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
import {
  DEFAULT_RPCS,
  getChainRpcUrl,
  isAllowedRpcUrl,
  setChainRpcUrl,
} from '../lib/addresses'
import { useActiveChain } from '../lib/hooks'

export function RpcSettingsForm({ compact = false }: { compact?: boolean }) {
  const { chainId, chain } = useActiveChain()
  const defaultUrl = DEFAULT_RPCS[chainId]
  const [value, setValue] = useState(() => getChainRpcUrl(chainId))

  useEffect(() => {
    setValue(getChainRpcUrl(chainId))
  }, [chainId])

  const trimmed = value.trim()
  const isValidUrl = isAllowedRpcUrl(trimmed)

  const save = () => {
    if (!isValidUrl) return
    if (setChainRpcUrl(chainId, trimmed)) window.location.reload()
  }

  const reset = () => {
    // Empty string clears the override back to the default (per the lib helper).
    setChainRpcUrl(chainId, '')
    window.location.reload()
  }

  return (
    <div>
      <h3 className={`${compact ? 'text-xs' : 'text-sm'} font-semibold text-fg`}>
        Custom RPC endpoint — {chain.name}
      </h3>
      <p className={`mt-1 text-faint ${compact ? 'text-[11px] leading-relaxed' : 'text-xs'}`}>
        All {chain.name} reads use this endpoint. Each network keeps its own local override;
        saving reloads the app.
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
        aria-label={`Custom ${chain.name} RPC endpoint`}
        className="mt-3 w-full rounded-md border border-hairline-strong bg-bg px-3 py-2 font-mono text-xs text-fg placeholder-[color:var(--op-faint)] outline-none focus:border-accent"
      />
      {!isValidUrl && trimmed.length > 0 && (
        <p className="mt-1 text-xs text-danger">
          {window.location.protocol === 'https:'
            ? 'Must be an HTTPS URL on the hosted app.'
            : 'Must be an HTTP(S) URL.'}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-md px-2 py-1.5 text-xs text-muted hover:text-fg"
        >
          Reset to default
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!isValidUrl}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save &amp; reload
        </button>
      </div>
    </div>
  )
}

export function RpcSettings() {
  const { chainId, chain } = useActiveChain()
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const isCustom = getChainRpcUrl(chainId) !== DEFAULT_RPCS[chainId]

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

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
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
          className="absolute right-0 z-20 mt-2 w-80 rounded-[14px] border border-hairline bg-surface p-4 shadow-[var(--op-shadow-lg)]"
        >
          <RpcSettingsForm />
        </div>
      )}
    </div>
  )
}
