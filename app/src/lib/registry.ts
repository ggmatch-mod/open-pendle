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
import type { MarketSnapshot, SavedPool } from './types.ts'
import { ARBITRUM_CHAIN_ID } from './addresses.ts'

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

function isSavedPool(value: unknown): value is SavedPool {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    p.chainId === ARBITRUM_CHAIN_ID &&
    isAddressString(p.market) &&
    typeof p.savedAt === 'number' &&
    typeof p.label === 'string' &&
    isAddressString(p.sy) &&
    isAddressString(p.pt) &&
    isAddressString(p.yt) &&
    typeof p.expiry === 'number' &&
    isAddressString(p.factory) &&
    // Optional home-grid sweep cache (older saves simply lack these).
    (p.assetDecimals === undefined || typeof p.assetDecimals === 'number') &&
    (p.assetSymbol === undefined || typeof p.assetSymbol === 'string')
  )
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
    const pools = (parsed as { pools: unknown[] }).pools.filter(isSavedPool)
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

/** Is this market already remembered? (case-insensitive address compare). */
export function isPoolSaved(market: Address): boolean {
  const needle = market.toLowerCase()
  return loadPools().some((p) => p.market.toLowerCase() === needle)
}

/**
 * Remember a pool. Derives the SavedPool display cache from a loaded
 * snapshot (label = displayName); upserts by market address.
 */
export function savePool(snapshot: MarketSnapshot): SavedPool {
  // Hard gate, not just UI: a market no known Pendle factory validates must
  // never enter the registry (PLAN §3.4 — the home grid re-renders saved
  // pools from cache, which would launder an unvalidated market).
  if (!snapshot.validated) {
    throw new Error(`Refusing to remember unvalidated market ${snapshot.address}`)
  }
  const pool: SavedPool = {
    chainId: ARBITRUM_CHAIN_ID,
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
  const needle = pool.market.toLowerCase()
  const next = loadPools().filter((p) => p.market.toLowerCase() !== needle)
  next.push(pool)
  writeEnvelope(next)
  return pool
}

/** Forget a pool by market address. No-op when not saved. */
export function forgetPool(market: Address): void {
  const needle = market.toLowerCase()
  const current = loadPools()
  const next = current.filter((p) => p.market.toLowerCase() !== needle)
  if (next.length === current.length) return
  writeEnvelope(next)
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
