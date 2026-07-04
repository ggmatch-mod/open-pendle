/**
 * Pure config-math for the create-pool wizard (UI layer). Converts between the
 * human inputs (percent strings, a calendar date) and the PoolConfig shape the
 * lib/deploy contract expects (1e18-scaled rate bigints, a divisor-aligned unix
 * expiry). No DOM, no chain — safe to reason about in isolation.
 *
 * Rate scaling note: rates are 1e18-scaled APY fractions. 5% APY → 0.05e18.
 * We keep 1e14 precision (0.0001%) through a basis-of-1e18 integer conversion
 * so a typed "5.25" round-trips exactly without float drift in the low bits.
 */

const ONE_E18 = 10n ** 18n
const SECONDS_PER_DAY = 86400
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60

export interface PercentParse {
  /** 1e18-scaled fraction (e.g. "5" → 0.05e18). Absent on parse failure. */
  scaled?: bigint
  /** Fraction as a float, for visual math (e.g. 5 → 0.05). */
  fraction?: number
  error?: string
}

/**
 * Parse a percent string ("5", "5.25", "0.8") into a 1e18-scaled APY fraction.
 * Rejects junk, negatives and absurd magnitudes. Precision: 1e-6 fraction
 * (0.0001%), which is finer than any band edge users type.
 */
export function parsePercent(raw: string, maxPercent = 1000): PercentParse {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  const s = trimmed.replace(',', '.')
  if (!/^\d*\.?\d*$/.test(s) || s === '.' || s === '') {
    return { error: 'Enter a percentage' }
  }
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return { error: 'Enter a positive percentage' }
  if (n > maxPercent) return { error: `Too large (max ${maxPercent}%)` }
  // percent → fraction → 1e18-scaled, via a 1e6-precision integer to dodge
  // float drift: round(n/100 * 1e6) gives micro-fraction units, then × 1e12.
  const micro = BigInt(Math.round((n / 100) * 1_000_000))
  const scaled = micro * 10n ** 12n
  return { scaled, fraction: n / 100 }
}

/** 1e18-scaled fraction → percent number (0.05e18 → 5). */
export function scaledToPercent(scaled: bigint): number {
  return Number((scaled * 1_000_000n) / ONE_E18) / 10_000
}

/** 1e18-scaled fraction → float fraction (0.05e18 → 0.05). */
export function scaledToFraction(scaled: bigint): number {
  return Number((scaled * 1_000_000n) / ONE_E18) / 1_000_000
}

/**
 * Snap a unix-seconds timestamp DOWN to the nearest divisor boundary
 * (expiryDivisor = 86400 → midnight UTC). commonDeploy requires
 * expiry % expiryDivisor === 0.
 */
export function snapExpiry(unixSeconds: number, divisor: number): number {
  const d = divisor > 0 ? divisor : SECONDS_PER_DAY
  return Math.floor(unixSeconds / d) * d
}

/** True when the timestamp lands exactly on a divisor boundary. */
export function isExpiryAligned(unixSeconds: number, divisor: number): boolean {
  const d = divisor > 0 ? divisor : SECONDS_PER_DAY
  return unixSeconds % d === 0
}

/**
 * The next Thursday at 00:00 UTC, as unix seconds — Pendle's ecosystem
 * convention for expiries. If "today" is already Thursday we jump to the
 * following Thursday so the default is always safely in the future.
 */
export function nextThursdayUtc(nowMs = Date.now()): number {
  const now = new Date(nowMs)
  const midnightUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  const dow = new Date(midnightUtc).getUTCDay() // 0=Sun … 4=Thu
  let delta = (4 - dow + 7) % 7
  if (delta === 0) delta = 7 // already Thursday → next week
  return Math.floor((midnightUtc + delta * SECONDS_PER_DAY * 1000) / 1000)
}

/**
 * A <input type="date"> value (YYYY-MM-DD, interpreted as a UTC calendar day)
 * → unix seconds at 00:00 UTC of that day. Returns undefined on empty/garbage.
 */
export function dateInputToUnix(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(ms)) return undefined
  return Math.floor(ms / 1000)
}

/** unix seconds → YYYY-MM-DD (UTC) for the date input's value. */
export function unixToDateInput(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

/** unix seconds → "Thu 25 Feb 2027, 00:00 UTC" for the human confirmation line. */
export function formatUtcDateTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })}, 00:00 UTC`
}

/** Whole days from now until expiry (floored, min 0). */
export function daysToExpiry(unixSeconds: number, nowMs = Date.now()): number {
  return Math.max(0, Math.floor((unixSeconds - nowMs / 1000) / SECONDS_PER_DAY))
}

/** Years to expiry as a float (for the education panel's tenor line). */
export function yearsToExpiry(unixSeconds: number, nowMs = Date.now()): number {
  return Math.max(0, (unixSeconds - nowMs / 1000) / SECONDS_PER_YEAR)
}

/** The band midpoint as a 1e18-scaled rate — the default desired-APY. */
export function bandMidpoint(rateMin: bigint, rateMax: bigint): bigint {
  return (rateMin + rateMax) / 2n
}

/** Pendle's fee heuristic: default fee = rateMax / 25 (1e18-scaled). */
export function defaultFee(rateMax: bigint): bigint {
  return rateMax / 25n
}

/** ln(1.05) fee cap as a 1e18-scaled *rate-terms* fee (5% APY equivalent). */
export const FEE_CAP_SCALED = ONE_E18 / 20n // 0.05e18 = 5%
