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

export const WAGMI_STORAGE_PREFIX = 'openpendle.wagmi.v2'
export const WAGMI_STORE_STORAGE_KEY = `${WAGMI_STORAGE_PREFIX}.store`

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type StorageResolver = () => BrowserStorage | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPersistedConnection(uid: string, value: unknown): boolean {
  if (!isRecord(value)) return false

  const { accounts, chainId, connector } = value
  if (
    !Array.isArray(accounts) ||
    accounts.length === 0 ||
    !accounts.every((account) => typeof account === 'string' && ADDRESS_PATTERN.test(account))
  ) {
    return false
  }
  // A connected wallet may legitimately be on a network OpenPendle does not
  // support yet. Preserve that state so the Wrong Network UI can explain it.
  if (!Number.isSafeInteger(chainId) || Number(chainId) <= 0) return false
  if (!isRecord(connector)) return false

  return (
    isNonEmptyString(connector.id) &&
    isNonEmptyString(connector.name) &&
    isNonEmptyString(connector.type) &&
    connector.uid === uid
  )
}

/** Revive wagmi values, rejecting a store whose `connections` is not a Map. */
export function deserializeWagmiStorage<type>(raw: string): type | unknown {
  try {
    const value: unknown = deserialize(raw)

    // The same deserializer is also used for simple values such as the recent
    // connector id and injected-connector flags. Do not revive arbitrary
    // objects outside the Zustand store envelope.
    if (!isRecord(value) || !('state' in value) || !('version' in value)) {
      return typeof value === 'string' || typeof value === 'boolean' ? value : null
    }
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
      if (!isNonEmptyString(key) || !isPersistedConnection(key, connection)) return null
    }
    if (connections.size === 0 && state.current !== null) return null
    if (connections.size > 0 && (typeof state.current !== 'string' || !connections.has(state.current))) {
      return null
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
      // Reconnecting injected wallets does not require hydrating the previous
      // connection objects. Keeping this volatile removes an entire class of
      // pre-React crashes caused by dependency schema drift or corrupted state.
      if (key === WAGMI_STORE_STORAGE_KEY) return null
      try {
        const storage = resolveStorage()
        if (storage === null) return null
        return storage.getItem(key)
      } catch {
        return null
      }
    },
    setItem(key, value) {
      if (key === WAGMI_STORE_STORAGE_KEY) return
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
