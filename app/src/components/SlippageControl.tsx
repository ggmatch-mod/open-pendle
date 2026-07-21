/**
 * SlippageControl (M2) — small popover shared by the action panels:
 * slippage presets (0.1 / 0.5 / 1%) + custom value, and the exact-vs-unlimited
 * approvals toggle. Both persist to localStorage (components/prefs.ts) —
 * 'openpendle.slippage' and 'openpendle.approvals'.
 */

import { useEffect, useRef, useState } from 'react'
import {
  SLIPPAGE_PRESETS,
  readSlippage,
  useApprovalMode,
  useSlippage,
} from './prefs'
import { formatPercent } from './format'

function readIsPreset(): boolean {
  const v = readSlippage()
  return SLIPPAGE_PRESETS.some((p) => p === v)
}

export function SlippageControl({
  disabled = false,
}: {
  /** True while a send is in flight — changing slippage/approval mode then would rebuild plans under a signed tx. */
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [slippage, setSlippage] = useSlippage()
  const [approvalMode, setApprovalMode] = useApprovalMode()
  const [customText, setCustomText] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)

  const isPreset = SLIPPAGE_PRESETS.some((p) => p === slippage)

  // Close the popover if a send starts while it is open.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  // Seed the custom box from the persisted value each time the popover opens.
  useEffect(() => {
    if (open) setCustomText(readIsPreset() ? '' : String(readSlippage() * 100))
  }, [open])

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

  const applyCustom = (text: string) => {
    setCustomText(text)
    const pct = Number(text.trim().replace(',', '.'))
    if (Number.isFinite(pct) && pct >= 0 && pct <= 50) {
      setSlippage(pct / 100)
    }
  }
  const customInvalid =
    customText.trim().length > 0 &&
    !(Number.isFinite(Number(customText.trim().replace(',', '.'))) &&
      Number(customText.trim().replace(',', '.')) >= 0 &&
      Number(customText.trim().replace(',', '.')) <= 50)

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          disabled
            ? 'Locked while a transaction is in flight'
            : 'Slippage & approval settings'
        }
        className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-muted hover:border-hairline-strong hover:bg-surface hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-hairline disabled:hover:bg-transparent disabled:hover:text-muted"
      >
        <span aria-hidden>⚙</span>
        {formatPercent(slippage)} slippage
        {approvalMode === 'infinite' && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-amber-400"
            title="Unlimited approvals enabled"
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Transaction settings"
          className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-hairline bg-surface p-4 shadow-xl shadow-black/50"
        >
          <h3 className="text-sm font-semibold text-fg">Slippage tolerance</h3>
          <p className="mt-1 text-xs text-faint">
            Your transaction reverts if you'd receive less than the shown minimum.
          </p>
          <div className="mt-2.5 flex items-center gap-1.5">
            {SLIPPAGE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setSlippage(p)
                  setCustomText('')
                }}
                className={`rounded-md border px-2.5 py-1.5 text-xs font-medium ${
                  slippage === p
                    ? 'border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink'
                    : 'border-hairline-strong text-muted hover:border-hairline-strong'
                }`}
              >
                {formatPercent(p)}
              </button>
            ))}
            <div
              className={`flex flex-1 items-center rounded-md border bg-bg px-2 py-1.5 focus-within:border-accent ${
                customInvalid
                  ? 'border-[var(--op-danger-bd)]'
                  : !isPreset
                    ? 'border-[rgba(var(--op-accent-rgb),0.4)]'
                    : 'border-hairline-strong'
              }`}
            >
              <input
                type="text"
                inputMode="decimal"
                value={customText}
                onChange={(e) => applyCustom(e.target.value)}
                placeholder="custom"
                className="w-full min-w-0 bg-transparent text-right text-xs text-fg placeholder-[color:var(--op-faint)] outline-none"
                aria-label="Custom slippage percent"
              />
              <span className="ml-1 text-xs text-faint">%</span>
            </div>
          </div>
          {customInvalid && (
            <p className="mt-1 text-xs text-danger">Enter 0–50 (percent).</p>
          )}

          <div className="mt-4 border-t border-hairline pt-3.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-fg">Approvals</h3>
              <div className="inline-flex rounded-md border border-hairline-strong p-0.5">
                {(['exact', 'infinite'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setApprovalMode(mode)}
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      approvalMode === mode
                        ? mode === 'infinite'
                          ? 'bg-[var(--op-warn-soft)] text-warn'
                          : 'bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink'
                        : 'text-muted hover:text-fg'
                    }`}
                  >
                    {mode === 'exact' ? 'Exact' : 'Unlimited'}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-faint">
              <span className="text-muted">Exact</span> approves only what each action needs —
              safest, one extra approval tx. <span className="text-muted">Unlimited</span> saves
              gas but stays approved until you revoke it.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
