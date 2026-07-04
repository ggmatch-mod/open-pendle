/**
 * UI transaction preferences (M2), persisted in localStorage:
 * - `openpendle.slippage` — slippage tolerance as a fraction (default 0.005 = 0.5%).
 *   minOut passed into plan builders = quote × (1 − slippage), via applySlippage.
 * - `openpendle.approvals` — 'exact' (default; approval capped at the amount
 *   being traded) or 'infinite' (max-uint approvals, fewer txs, more exposure).
 *   The data layer's approve() reads the SAME key to size the approval tx.
 *
 * Owned by the UI layer; a tiny external store so every panel re-renders when
 * the SlippageControl popover writes a new value.
 */

import { useSyncExternalStore } from 'react'

export const SLIPPAGE_STORAGE_KEY = 'openpendle.slippage'
export const APPROVALS_STORAGE_KEY = 'openpendle.approvals'

export const DEFAULT_SLIPPAGE = 0.005
export const SLIPPAGE_PRESETS = [0.001, 0.005, 0.01] as const

export type ApprovalMode = 'exact' | 'infinite'

const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readSlippage(): number {
  try {
    const raw = window.localStorage.getItem(SLIPPAGE_STORAGE_KEY)
    if (raw !== null) {
      const v = Number(raw)
      // Sane band: 0–50%. Anything else falls back to the default.
      if (Number.isFinite(v) && v >= 0 && v <= 0.5) return v
    }
  } catch {
    // localStorage unavailable — default.
  }
  return DEFAULT_SLIPPAGE
}

export function writeSlippage(fraction: number): void {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 0.5) return
  try {
    window.localStorage.setItem(SLIPPAGE_STORAGE_KEY, String(fraction))
  } catch {
    // ignore — the in-memory value still updates via emit()
  }
  emit()
}

export function readApprovalMode(): ApprovalMode {
  try {
    if (window.localStorage.getItem(APPROVALS_STORAGE_KEY) === 'infinite') {
      return 'infinite'
    }
  } catch {
    // fall through
  }
  return 'exact'
}

export function writeApprovalMode(mode: ApprovalMode): void {
  try {
    window.localStorage.setItem(APPROVALS_STORAGE_KEY, mode)
  } catch {
    // ignore
  }
  emit()
}

/** Current slippage fraction + setter; re-renders on any prefs write. */
export function useSlippage(): [number, (fraction: number) => void] {
  const value = useSyncExternalStore(subscribe, readSlippage, () => DEFAULT_SLIPPAGE)
  return [value, writeSlippage]
}

export function useApprovalMode(): [ApprovalMode, (mode: ApprovalMode) => void] {
  const value = useSyncExternalStore(subscribe, readApprovalMode, () => 'exact' as const)
  return [value, writeApprovalMode]
}

/**
 * quote × (1 − slippage), bigint-safe (basis-point precision).
 * Used for every minOut handed to the plan builders.
 */
export function applySlippage(amount: bigint, slippageFraction: number): bigint {
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.round(slippageFraction * 10_000))))
  return (amount * (10_000n - bps)) / 10_000n
}
