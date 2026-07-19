/**
 * Defensive browser storage for wagmi.
 *
 * Wagmi hydrates its store before the React shell mounts. A stale but
 * JSON-valid payload whose `connections` field is no longer a serialized Map
 * can therefore throw during `useAccount()` and leave the entire app blank.
 * Use an OpenPendle-owned, versioned key and validate revived state before
 * wagmi's persistence middleware sees it. Within this wagmi adapter,
 * storage-denied reads degrade to an empty wallet session instead of failing
 * during config creation.
 */

import { deserialize } from 'wagmi'

export const WAGMI_STORAGE_PREFIX = 'openpendle.wagmi.v1'

type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type StorageResolver = () => BrowserStorage | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Revive wagmi values, rejecting a store whose `connections` is not a Map. */
export function deserializeWagmiStorage<type>(raw: string): type | unknown {
  try {
    const value: unknown = deserialize(raw)

    // The same deserializer is also used for simple values such as the recent
    // connector id. Only a Zustand persist envelope requires store validation.
    if (!isRecord(value) || !('state' in value) || !('version' in value)) return value
    if (typeof value.version !== 'number') return null

    const state = value.state
    if (!isRecord(state)) return null
    if (state.current !== null && state.current !== undefined && typeof state.current !== 'string') {
      return null
    }
    if (state.chainId !== undefined && typeof state.chainId !== 'number') return null

    const connections = state.connections
    if (!(connections instanceof Map)) return null
    for (const [key, connection] of connections) {
      if (typeof key !== 'string' || !isRecord(connection)) return null
    }

    return value
  } catch {
    return null
  }
}

function defaultStorageResolver(): BrowserStorage | null {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

/**
 * Base storage passed into wagmi's `createStorage`.
 *
 * Reads, writes, and removals are guarded because merely accessing
 * `window.localStorage` can throw in privacy-restricted contexts.
 */
export function createSafeWagmiBaseStorage(
  resolveStorage: StorageResolver = defaultStorageResolver,
): BrowserStorage {
  return {
    getItem(key) {
      try {
        const storage = resolveStorage()
        if (storage === null) return null
        return storage.getItem(key)
      } catch {
        return null
      }
    },
    setItem(key, value) {
      try {
        resolveStorage()?.setItem(key, value)
      } catch {
        // Wallet persistence is optional; the live tab remains authoritative.
      }
    },
    removeItem(key) {
      try {
        resolveStorage()?.removeItem(key)
      } catch {
        // Treat storage-denied browsers as ephemeral sessions.
      }
    },
  }
}
