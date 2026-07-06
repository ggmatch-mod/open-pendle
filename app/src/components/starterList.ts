/**
 * Starter-list loader — UI-owned wrapper around src/lib/starterMarkets.json.
 *
 * The JSON file is produced by the data layer and may not exist yet (or ever,
 * on a fresh checkout). `import.meta.glob` degrades gracefully: no file → no
 * match → empty list, with zero build-time errors. The shape is also treated
 * as untrusted — entries are validated field-by-field and bad ones dropped.
 */

import { isAddress, getAddress } from 'viem'
import type { Address } from 'viem'
import type { SupportedChainId } from '../lib/types'
import { isSupportedChainId } from '../lib/addresses'

export interface StarterMarket {
  address: Address
  name: string
  /** Unix seconds. */
  expiry: number
  /** The network this market lives on — opening it switches the active chain. */
  chainId: SupportedChainId
  assetSymbol?: string
}

export interface StarterList {
  /** Human-readable "as of" stamp from the JSON (best-effort). */
  generatedAt?: string
  markets: StarterMarket[]
}

// Lazy glob: resolves to {} when the data agent hasn't generated the file yet.
const matches = import.meta.glob('../lib/starterMarkets.json')

export async function loadStarterList(): Promise<StarterList> {
  const loader = Object.values(matches)[0]
  if (!loader) return { markets: [] }
  try {
    const mod = (await loader()) as { default?: unknown }
    return parseStarterList(mod.default ?? mod)
  } catch {
    return { markets: [] }
  }
}

function parseStarterList(raw: unknown): StarterList {
  if (raw === null || typeof raw !== 'object') return { markets: [] }

  // Accept either a bare array or { generatedAt, markets: [...] }.
  const obj = raw as Record<string, unknown>
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(obj.markets)
      ? obj.markets
      : Array.isArray(obj.pools)
        ? obj.pools
        : []

  const markets: StarterMarket[] = []
  for (const entry of list) {
    const parsed = parseEntry(entry)
    if (parsed) markets.push(parsed)
  }

  return { generatedAt: parseGeneratedAt(obj.generatedAt), markets }
}

function parseEntry(entry: unknown): StarterMarket | null {
  if (entry === null || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>

  const rawAddr = firstString(e.address, e.market)
  if (!rawAddr || !isAddress(rawAddr, { strict: false })) return null

  const expiry = parseUnixSeconds(e.expiry)
  if (expiry === undefined) return null

  const address = getAddress(rawAddr)
  const name =
    firstString(e.name, e.label, e.displayName, e.symbol) ?? shortFallbackName(address)
  const assetSymbol = firstString(e.assetSymbol)

  return { address, name, expiry, chainId: parseChainId(e.chainId), ...(assetSymbol ? { assetSymbol } : {}) }
}

/**
 * Starter markets are historically Arbitrum; honor a per-entry chainId if the
 * data ever spans chains, otherwise default to Arbitrum (42161).
 */
function parseChainId(v: unknown): SupportedChainId {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return isSupportedChainId(n) ? n : 42161
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  }
  return undefined
}

function parseUnixSeconds(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  // Tolerate millisecond timestamps.
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function parseGeneratedAt(v: unknown): string | undefined {
  // Normalize to a date-only label ("2026-07-03") — a raw ISO timestamp is
  // noise in the "as of …" copy.
  if (typeof v === 'string' && v.trim().length > 0) {
    const d = new Date(v.trim())
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    return v.trim()
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  return undefined
}

function shortFallbackName(address: Address): string {
  return `Market ${address.slice(0, 6)}…${address.slice(-4)}`
}
