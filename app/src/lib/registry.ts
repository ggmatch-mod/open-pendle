/**
 * M1 pool registry — localStorage-backed remember/forget store (PLAN §3.3).
 *
 * Pure, framework-free, erasable TypeScript (importable under
 * `node --experimental-strip-types`; degrades to an in-memory no-op store
 * when localStorage is unavailable). React coupling lives in hooks.ts, which
 * drives this via useSyncExternalStore — hence the stable-reference snapshot
 * cache and the subscribe/emit mechanism (local emitter + cross-tab
 * `storage` events).
 *
 * Storage schema: key `openpendle.pools.v1`, versioned envelope
 * `{ version: 1, pools: SavedPool[] }`. Corrupt or missing storage reads as
 * an empty registry, never throws.
 */

import type { Address } from 'viem'
import type { MarketSnapshot, SavedPool, SupportedChainId } from './types.ts'
import { ARBITRUM_CHAIN_ID, isSupportedChainId } from './addresses.ts'

export const REGISTRY_STORAGE_KEY = 'openpendle.pools.v1'

interface RegistryEnvelope {
  version: 1
  pools: SavedPool[]
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

type Listener = () => void

const listeners = new Set<Listener>()

/** Reference-stable snapshot (useSyncExternalStore requirement). */
let cache: SavedPool[] | null = null

const EMPTY_POOLS: SavedPool[] = []

let storageListenerInstalled = false

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    // Privacy mode / storage disabled.
  }
  return null
}

function emit(): void {
  for (const listener of listeners) listener()
}

function invalidate(): void {
  cache = null
  emit()
}

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

function isAddressString(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

/**
 * (chainId, market) composite key — lowercased market so it is
 * case-insensitive. A pool is unique per (chain, market): the same market
 * address CANNOT collide across chains in practice, but keying by both is the
 * correct M8 identity and lets the home grid group by chain.
 */
function poolKey(chainId: SupportedChainId, market: Address): string {
  return `${chainId}:${market.toLowerCase()}`
}

/**
 * Parse + MIGRATE one stored entry. M8: chainId is now any supported chain.
 * Migration (v1 store, unreleased schema): a pre-M8 entry may have chainId ===
 * 42161 already (the old shape hardcoded it) OR — defensively — be missing
 * chainId entirely; both resolve to Arbitrum. Returns a normalized SavedPool or
 * undefined for genuinely-corrupt entries. Schema stays version 1 (chainId was
 * always in the shape, so no envelope bump).
 */
function parseSavedPool(value: unknown): SavedPool | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const p = value as Record<string, unknown>
  // chainId: accept any supported chain; migrate a missing one to Arbitrum.
  const rawChainId = p.chainId
  const chainId: SupportedChainId =
    rawChainId === undefined
      ? ARBITRUM_CHAIN_ID
      : typeof rawChainId === 'number' && isSupportedChainId(rawChainId)
        ? rawChainId
        : (NaN as unknown as SupportedChainId)
  if (!isSupportedChainId(chainId)) return undefined
  if (
    !isAddressString(p.market) ||
    typeof p.savedAt !== 'number' ||
    typeof p.label !== 'string' ||
    !isAddressString(p.sy) ||
    !isAddressString(p.pt) ||
    !isAddressString(p.yt) ||
    typeof p.expiry !== 'number' ||
    !isAddressString(p.factory) ||
    // Optional home-grid sweep cache (older saves simply lack these).
    !(p.assetDecimals === undefined || typeof p.assetDecimals === 'number') ||
    !(p.assetSymbol === undefined || typeof p.assetSymbol === 'string')
  ) {
    return undefined
  }
  return {
    chainId,
    market: p.market,
    savedAt: p.savedAt,
    label: p.label,
    sy: p.sy,
    pt: p.pt,
    yt: p.yt,
    expiry: p.expiry,
    factory: p.factory,
    ...(p.assetDecimals !== undefined ? { assetDecimals: p.assetDecimals as number } : {}),
    ...(p.assetSymbol !== undefined ? { assetSymbol: p.assetSymbol as string } : {}),
  }
}

function readEnvelope(): SavedPool[] {
  const storage = getStorage()
  if (!storage) return EMPTY_POOLS
  try {
    const raw = storage.getItem(REGISTRY_STORAGE_KEY)
    if (!raw) return EMPTY_POOLS
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { pools?: unknown }).pools)
    ) {
      return EMPTY_POOLS
    }
    const pools = (parsed as { pools: unknown[] }).pools
      .map(parseSavedPool)
      .filter((p): p is SavedPool => p !== undefined)
    return pools.length > 0 ? pools : EMPTY_POOLS
  } catch {
    // Corrupt JSON / storage read failure → empty registry.
    return EMPTY_POOLS
  }
}

function writeEnvelope(pools: SavedPool[]): void {
  const storage = getStorage()
  if (storage) {
    try {
      const envelope: RegistryEnvelope = { version: 1, pools }
      storage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(envelope))
    } catch {
      // Quota exceeded / storage disabled — keep the in-memory copy working.
    }
  }
  cache = pools
  emit()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Current saved pools. Reference-stable between mutations, so it is directly
 * usable as a useSyncExternalStore `getSnapshot`.
 */
export function loadPools(): SavedPool[] {
  if (cache === null) cache = readEnvelope()
  return cache
}

/** Server/SSR snapshot for useSyncExternalStore (always empty; app is client-only). */
export function getServerPools(): SavedPool[] {
  return EMPTY_POOLS
}

/**
 * Is this (chainId, market) pool already remembered? (case-insensitive market
 * compare). M8: keyed by (chainId, market) so the SAME market address on two
 * chains is two independent entries.
 */
export function isPoolSaved(chainId: SupportedChainId, market: Address): boolean {
  const needle = poolKey(chainId, market)
  return loadPools().some((p) => poolKey(p.chainId, p.market) === needle)
}

/**
 * Remember a pool on `chainId` (the ACTIVE chain). Derives the SavedPool
 * display cache from a loaded snapshot (label = displayName); upserts by
 * (chainId, market). The snapshot carries no chain id (it's a client-chain
 * concept), so the caller (useRegistry, which reads the active chain) stamps it.
 */
export function savePool(chainId: SupportedChainId, snapshot: MarketSnapshot): SavedPool {
  // Hard gate, not just UI: a market no known Pendle factory validates must
  // never enter the registry (PLAN §3.4 — the home grid re-renders saved
  // pools from cache, which would launder an unvalidated market).
  if (!snapshot.validated) {
    throw new Error(`Refusing to remember unvalidated market ${snapshot.address}`)
  }
  const pool: SavedPool = {
    chainId,
    market: snapshot.address,
    savedAt: Date.now(),
    label: snapshot.displayName,
    sy: snapshot.sy.address,
    pt: snapshot.pt,
    yt: snapshot.yt,
    expiry: snapshot.expiry,
    factory: snapshot.factory,
    // Cached so the home-grid sweep can compute TVL/label without a full
    // per-card snapshot load (re-verified on open, never trusted for txs).
    assetDecimals: snapshot.sy.assetDecimals,
    ...(snapshot.sy.assetSymbol !== undefined
      ? { assetSymbol: snapshot.sy.assetSymbol }
      : {}),
  }
  const needle = poolKey(chainId, pool.market)
  const next = loadPools().filter((p) => poolKey(p.chainId, p.market) !== needle)
  next.push(pool)
  writeEnvelope(next)
  return pool
}

/**
 * Refresh an ALREADY-saved pool's cached display fields (label, expiry, token
 * addresses, factory, assetSymbol/decimals) from a fresh snapshot, PRESERVING
 * savedAt (so it doesn't jump to the top of the recency list). No-op if the
 * pool isn't saved or nothing changed. Called on the market page after a
 * successful load so a "Your pools" card can never show a caption that's
 * drifted from the live market — the identity (chainId, market) is fixed; only
 * the cached display is reconciled.
 */
export function refreshPoolCache(chainId: SupportedChainId, snapshot: MarketSnapshot): void {
  if (!snapshot.validated) return
  const needle = poolKey(chainId, snapshot.address)
  const current = loadPools()
  const existing = current.find((p) => poolKey(p.chainId, p.market) === needle)
  if (!existing) return
  const refreshed: SavedPool = {
    ...existing,
    label: snapshot.displayName,
    sy: snapshot.sy.address,
    pt: snapshot.pt,
    yt: snapshot.yt,
    expiry: snapshot.expiry,
    factory: snapshot.factory,
    assetDecimals: snapshot.sy.assetDecimals,
    ...(snapshot.sy.assetSymbol !== undefined ? { assetSymbol: snapshot.sy.assetSymbol } : {}),
  }
  // Only write when something actually changed (avoids needless re-render churn).
  if (JSON.stringify(refreshed) === JSON.stringify(existing)) return
  writeEnvelope(current.map((p) => (poolKey(p.chainId, p.market) === needle ? refreshed : p)))
}

/** Forget a pool by (chainId, market). No-op when not saved. */
export function forgetPool(chainId: SupportedChainId, market: Address): void {
  const needle = poolKey(chainId, market)
  const current = loadPools()
  const next = current.filter((p) => poolKey(p.chainId, p.market) !== needle)
  if (next.length === current.length) return
  writeEnvelope(next)
}

/** Look up a saved pool by (chainId, market) — used to capture it for undo. */
export function findPool(chainId: SupportedChainId, market: Address): SavedPool | undefined {
  const needle = poolKey(chainId, market)
  return loadPools().find((p) => poolKey(p.chainId, p.market) === needle)
}

/**
 * Re-insert a previously-removed pool exactly as it was (undo a forget). Upserts
 * by (chainId, market), preserving the pool's original savedAt so it returns to
 * its place in the recency order rather than jumping to the top.
 */
export function restorePool(pool: SavedPool): void {
  const needle = poolKey(pool.chainId, pool.market)
  const next = loadPools().filter((p) => poolKey(p.chainId, p.market) !== needle)
  next.push(pool)
  writeEnvelope(next)
}

// ---------------------------------------------------------------------------
// Export / import / share (M9) — portable backup + a shareable link. Both import
// paths go through parseSavedPool (shape validation); the market-page provenance
// gate still applies before any transaction, so importing never launders a
// market into a transactable state.
// ---------------------------------------------------------------------------

/** Serialize the current registry to a portable JSON string (the storage envelope). */
export function exportPoolsJson(): string {
  return JSON.stringify({ version: 1, pools: loadPools() }, null, 2)
}

/**
 * Merge pools from an exported/shared JSON string into the registry. Accepts the
 * `{ version, pools }` envelope or a bare SavedPool[]. Each entry is
 * shape-validated (malformed ones skipped); existing (chainId, market) entries
 * are kept (merge, not overwrite). Returns counts.
 */
export function importPools(raw: string): { imported: number; skipped: number; total: number } {
  const current = loadPools()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { imported: 0, skipped: 0, total: current.length }
  }
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { pools?: unknown }).pools)
      ? (parsed as { pools: unknown[] }).pools
      : []
  const valid = arr.map(parseSavedPool).filter((p): p is SavedPool => p !== undefined)
  const have = new Set(current.map((p) => poolKey(p.chainId, p.market)))
  const additions = valid.filter((p) => !have.has(poolKey(p.chainId, p.market)))
  if (additions.length > 0) writeEnvelope([...current, ...additions])
  return {
    imported: additions.length,
    skipped: arr.length - valid.length,
    total: current.length + additions.length,
  }
}

/** URL-safe base64 of a UTF-8 string. */
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Inverse of b64urlEncode; '' on failure. */
function b64urlDecode(t: string): string {
  try {
    const b64 = t.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return ''
  }
}

/** Encode pools into a compact, URL-safe share token (base64url of the JSON array). */
export function encodePoolsShare(pools: SavedPool[]): string {
  return b64urlEncode(JSON.stringify(pools))
}

/** Decode a share token back to a JSON string for importPools ('' if invalid). */
export function decodePoolsShare(token: string): string {
  return b64urlDecode(token)
}

/**
 * Subscribe to registry changes (local mutations + cross-tab `storage`
 * events). Returns an unsubscribe function; usable as a
 * useSyncExternalStore `subscribe`.
 */
export function subscribeRegistry(listener: Listener): () => void {
  if (!storageListenerInstalled && typeof window !== 'undefined') {
    storageListenerInstalled = true
    window.addEventListener('storage', (event: StorageEvent) => {
      // key === null means the whole store was cleared.
      if (event.key === null || event.key === REGISTRY_STORAGE_KEY) invalidate()
    })
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
