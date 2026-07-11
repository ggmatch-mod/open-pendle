/**
 * Forget-with-undo — a global ~4s undo toast for forgetting a saved pool.
 *
 * Forgetting removes the pool immediately (the card disappears / the market-page
 * toggle unticks), but the toast holds the removed SavedPool so "Undo" restores
 * it exactly (savedAt preserved). Both forget entry points — the SavedPoolCard
 * pill and the market-page RememberToggle — call the shared forgetWithUndo. The
 * toast is app-level (fixed), so it survives route changes for the full window.
 */
import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SavedPool } from '../lib/types'
import { findPool, forgetPool, restorePool } from '../lib/registry'
import { clampLabel } from './format'
import { ForgetUndoCtx } from './forgetUndoContext'
import type { ForgetFn } from './forgetUndoContext'

const UNDO_MS = 4000

export function ForgetUndoProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<SavedPool | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const forgetWithUndo = useCallback<ForgetFn>(
    (chainId, market) => {
      const pool = findPool(chainId, market)
      if (!pool) return
      forgetPool(chainId, market)
      clearTimer()
      setPending(pool)
      timer.current = setTimeout(() => {
        timer.current = null
        setPending(null)
      }, UNDO_MS)
    },
    [clearTimer],
  )

  const undo = useCallback(() => {
    clearTimer()
    // Restore in the handler (NOT inside a setState updater) — restorePool emits
    // to the registry's external store, which would otherwise fire subscribers'
    // setState during this component's render (setState-in-render warning).
    if (pending) restorePool(pending)
    setPending(null)
  }, [clearTimer, pending])

  const dismiss = useCallback(() => {
    clearTimer()
    setPending(null)
  }, [clearTimer])

  return (
    <ForgetUndoCtx.Provider value={forgetWithUndo}>
      {children}
      {pending && <ForgetToast pool={pending} onUndo={undo} onDismiss={dismiss} />}
    </ForgetUndoCtx.Provider>
  )
}

function ForgetToast({
  pool,
  onUndo,
  onDismiss,
}: {
  pool: SavedPool
  onUndo: () => void
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-[12px] border border-hairline bg-surface px-4 py-2.5 shadow-[var(--op-shadow-lg)]"
      style={{ animation: 'op-pop .2s ease-out' }}
    >
      <span className="text-sm text-muted">
        Forgot <span className="font-medium text-fg">{clampLabel(pool.label)}</span>
      </span>
      <button
        type="button"
        onClick={onUndo}
        className="rounded-[8px] bg-[rgba(var(--op-accent-rgb),0.12)] px-2.5 py-1 text-sm font-semibold text-accent-ink hover:bg-[rgba(var(--op-accent-rgb),0.2)]"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-lg leading-none text-faint hover:text-fg"
      >
        ×
      </button>
    </div>
  )
}
