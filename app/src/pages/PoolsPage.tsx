/**
 * Saved pools — the dedicated home for the remembered-pools registry, reachable
 * from the header tab. The landing page shows only a couple of saved pools to
 * stay uncluttered; this page shows ALL of them, grouped + badged by network
 * (PLAN §3.3, M8 cross-chain registry). Same local storage, nothing on a server.
 *
 * M9: export/import (JSON backup) + a shareable link (?import=<token>) so a
 * saved set survives a cleared browser / different gateway and can be shared.
 */

import { useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useActiveChain, useRegistry, useRegistrySweep } from '../lib/hooks'
import { PageHeader } from '../components/PageHeader'
import { RegistryEmptyState, SavedPoolGroups } from '../components/SavedPoolsList'
import {
  decodePoolsShare,
  encodePoolsShare,
  exportPoolsJson,
  importPools,
} from '../lib/registry'
import { useDocumentTitle } from '../components/useDocumentTitle'

function downloadJson(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const btn =
  'rounded-[10px] border border-hairline bg-surface px-3 py-1.5 text-sm text-muted transition hover:text-fg hover:border-hairline-strong'

export default function PoolsPage() {
  useDocumentTitle('Saved pools')
  const { pools } = useRegistry()
  const { chainId: activeChainId } = useActiveChain()
  // ONE multicall sweep PER CHAIN for the whole registry (PLAN §3.3).
  const sweep = useRegistrySweep(pools)

  const [searchParams, setSearchParams] = useSearchParams()
  const [status, setStatus] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // A share token in the URL (?import=…) → offer to add those pools.
  const shareToken = searchParams.get('import')
  const sharedCount = useMemo(() => {
    if (!shareToken) return 0
    try {
      const arr = JSON.parse(decodePoolsShare(shareToken))
      return Array.isArray(arr) ? arr.length : 0
    } catch {
      return 0
    }
  }, [shareToken])

  const say = (r: { imported: number; skipped: number }, verb: string) =>
    setStatus(
      `${verb} ${r.imported} pool${r.imported === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} skipped` : ''}.`,
    )

  const onExport = () => downloadJson('openpendle-pools.json', exportPoolsJson())

  const onImportFile = (file: File) => {
    void file.text().then((text) => say(importPools(text), 'Imported'))
  }

  const onCopyShare = () => {
    const url = `${window.location.origin}/#/pools?import=${encodePoolsShare(pools)}`
    void navigator.clipboard.writeText(url).then(
      () => setStatus('Share link copied to clipboard.'),
      () => setStatus("Couldn't copy — grab the URL from the address bar."),
    )
  }

  const clearShare = () => {
    searchParams.delete('import')
    setSearchParams(searchParams, { replace: true })
  }
  const onAcceptShared = () => {
    if (shareToken) say(importPools(decodePoolsShare(shareToken)), 'Added')
    clearShare()
  }

  return (
    <div className="pb-16">
      <PageHeader
        title="Saved pools"
        lede="Pools you've saved, stored only in this browser."
        actions={
          pools.length > 0 ? (
            <span className="shrink-0 text-xs text-faint">{pools.length} saved</span>
          ) : undefined
        }
      />

      {sharedCount > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.09)] p-4">
          <p className="text-sm text-fg">
            Someone shared{' '}
            <span className="font-medium text-accent-ink">
              {sharedCount} pool{sharedCount === 1 ? '' : 's'}
            </span>{' '}
            with you.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onAcceptShared}
              className="rounded-[10px] bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:brightness-110"
            >
              Add {sharedCount === 1 ? 'it' : 'them'}
            </button>
            <button type="button" onClick={clearShare} className="px-2 py-1.5 text-sm text-muted hover:text-fg">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Backup / restore / share toolbar. Import shows even when empty (restore a backup). */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {pools.length > 0 && (
          <>
            <button type="button" onClick={onExport} className={btn}>
              Export JSON
            </button>
            <button type="button" onClick={onCopyShare} className={btn}>
              Copy share link
            </button>
          </>
        )}
        <button type="button" onClick={() => fileRef.current?.click()} className={btn}>
          Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onImportFile(f)
            e.target.value = ''
          }}
        />
        <span role="status" className="text-xs text-faint">
          {status}
        </span>
      </div>

      {pools.length === 0 ? (
        <RegistryEmptyState />
      ) : (
        <SavedPoolGroups pools={pools} activeChainId={activeChainId} sweep={sweep} />
      )}
    </div>
  )
}
