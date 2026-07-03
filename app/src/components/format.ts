/**
 * Display-formatting helpers owned by the UI layer (NOT lib/ — the data agent
 * owns lib/). Pure functions only; safe to unit-test without a DOM.
 */

import type { Address } from 'viem'

/** 0x1234…abcd */
export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * On-chain string hygiene for display boundaries (names/symbols read from
 * arbitrary contracts): strips bidi & zero-width control characters that can
 * visually reorder or hide text, and truncates with an ellipsis. Apply at the
 * point of rendering, never to data used for logic.
 */
export function clampLabel(s: string, max = 48): string {
  const cleaned = s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

export function arbiscanAddressUrl(addr: Address | string): string {
  return `https://arbiscan.io/address/${addr}`
}

/**
 * Compact human number for TVL-ish values: 1.23M, 45.6K, 1.2B.
 * Below 1000 shows 2 decimals (or fewer for integers); tiny non-zero values
 * render "<0.01" instead of a misleading 0.
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs > 0 && abs < 0.01) return value > 0 ? '<0.01' : '>-0.01'
  if (abs < 1000) {
    return trimTrailingZeros(value.toFixed(2))
  }
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [threshold, suffix] of units) {
    if (abs >= threshold) {
      const scaled = value / threshold
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
      return `${trimTrailingZeros(scaled.toFixed(digits))}${suffix}`
    }
  }
  return trimTrailingZeros(value.toFixed(2))
}

/**
 * Fraction → percent string. 0.0512 → "5.12%". Uses more precision for tiny
 * fees (0.0008 → "0.08%") and clamps absurd values readably.
 */
export function formatPercent(fraction: number, decimals = 2): string {
  if (!Number.isFinite(fraction)) return '—'
  const pct = fraction * 100
  const abs = Math.abs(pct)
  const dp = abs !== 0 && abs < 0.1 ? 3 : decimals
  return `${trimTrailingZeros(pct.toFixed(dp))}%`
}

/** Price-style number (PT/YT in asset terms), 4 significant decimals. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return trimTrailingZeros(value.toFixed(4))
}

/** Unix seconds → "25 Feb 2027". */
export function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Relative time to/since a unix-seconds timestamp:
 * future → "in 32 days", past → "142 days ago".
 */
export function formatRelative(unixSeconds: number, nowMs = Date.now()): string {
  const diffSec = unixSeconds - nowMs / 1000
  const abs = Math.abs(diffSec)
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'always' })
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 86400 * 60) return rtf.format(Math.round(diffSec / 86400), 'day')
  if (abs < 86400 * 365 * 2) return rtf.format(Math.round(diffSec / (86400 * 30)), 'month')
  return rtf.format(Math.round(diffSec / (86400 * 365)), 'year')
}

function trimTrailingZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}
