/**
 * bigint-safe amount parsing for the M2 panels — viem parseUnits under the
 * hood; NaN can never escape (invalid text yields an error string and no
 * amount). Lives outside AmountInput.tsx so that file only exports a
 * component (fast-refresh rule).
 */

import { parseUnits } from 'viem'

/** Max leaves this much ETH for gas (Arbitrum gas is cheap; buffer is safety). */
export const NATIVE_GAS_BUFFER_WEI = 500_000_000_000_000n // 0.0005 ETH

export interface ParsedAmount {
  /** Defined only for a valid, parseable amount. */
  amount?: bigint
  /** User-facing parse problem ("" input → neither amount nor error). */
  error?: string
}

/** "1234.56" → bigint at `decimals`, gracefully rejecting junk. */
export function parseAmount(raw: string, decimals: number): ParsedAmount {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  // A comma followed by exactly 3 trailing digits with no other separator
  // ("1,234") is ambiguous: thousands separator (1234) vs decimal comma
  // (1.234). Refuse to guess — silently reading it as 1.234 would move ~1000×
  // less money than a thousands-separator user intended. Plain decimal commas
  // ("1,5", "1,23", "1,2345") still convert below.
  if (/^\d+,\d{3}$/.test(trimmed)) {
    return { error: 'Remove thousands separators' }
  }
  const s = trimmed.replace(',', '.')
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) {
    return { error: 'Not a valid number' }
  }
  const frac = s.split('.')[1] ?? ''
  if (frac.length > decimals) {
    return {
      error:
        decimals === 0
          ? 'This token has no decimal places'
          : `Too many decimal places (max ${decimals})`,
    }
  }
  try {
    return { amount: parseUnits(s, decimals) }
  } catch {
    return { error: 'Not a valid number' }
  }
}
