/**
 * Startup storage hardening for RainbowKit.
 *
 * RainbowKit reads a handful of localStorage keys directly while its provider
 * mounts. A malformed transaction cache or a browser that throws on storage
 * access can otherwise fail before the OpenPendle shell is visible.
 */

type BrowserStorage = Pick<
  Storage,
  'clear' | 'getItem' | 'key' | 'length' | 'removeItem' | 'setItem'
>
type StorageResolver = () => BrowserStorage | null

export const RAINBOWKIT_TRANSACTIONS_KEY = 'rk-transactions'
export const RAINBOWKIT_RECENT_KEY = 'rk-recent'

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/
const WALLET_SESSION_KEYS = [
  RAINBOWKIT_TRANSACTIONS_KEY,
  RAINBOWKIT_RECENT_KEY,
  'rk-latest-id',
  'rk-version',
  'WALLETCONNECT_DEEPLINK_CHOICE',
  'wagmi.store',
  'wagmi.recentConnectorId',
  'openpendle.wagmi.v1.store',
  'openpendle.wagmi.v1.recentConnectorId',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredTransaction(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.hash !== 'string' || !TRANSACTION_HASH_PATTERN.test(value.hash)) return false
  if (typeof value.description !== 'string') return false
  if (!['pending', 'confirmed', 'failed'].includes(String(value.status))) return false
  return (
    value.confirmations === undefined ||
    (Number.isSafeInteger(value.confirmations) && Number(value.confirmations) > 0)
  )
}

function isTransactionCache(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.values(value).every(
    (chains) =>
      isRecord(chains) &&
      Object.values(chains).every(
        (transactions) =>
          Array.isArray(transactions) && transactions.every(isStoredTransaction),
      ),
  )
}

function isRecentWalletCache(value: unknown): boolean {
  return Array.isArray(value) && value.every((walletId) => typeof walletId === 'string')
}

function removeMalformedJson(
  storage: BrowserStorage,
  key: string,
  validate: (value: unknown) => boolean,
): void {
  const raw = storage.getItem(key)
  if (raw === null) return
  try {
    if (validate(JSON.parse(raw))) return
  } catch {
    // Remove invalid JSON below.
  }
  storage.removeItem(key)
}

/** Remove only dependency caches whose malformed shape can crash startup. */
export function sanitizeRainbowKitStorage(
  resolveStorage: StorageResolver = defaultStorageResolver,
): void {
  try {
    const storage = resolveStorage()
    if (storage === null) return
    removeMalformedJson(storage, RAINBOWKIT_TRANSACTIONS_KEY, isTransactionCache)
    removeMalformedJson(storage, RAINBOWKIT_RECENT_KEY, isRecentWalletCache)
    // Previous OpenPendle/wagmi schemas are intentionally not hydrated again.
    storage.removeItem('wagmi.store')
    storage.removeItem('openpendle.wagmi.v1.store')
  } catch {
    // Storage-denied browsers are handled by prepareBrowserStorage().
  }
}

function createMemoryStorage(seed?: BrowserStorage): BrowserStorage {
  const values = new Map<string, string>()
  if (seed) {
    try {
      for (let index = 0; index < seed.length; index += 1) {
        const key = seed.key(index)
        if (key === null) continue
        const value = seed.getItem(key)
        if (value !== null) values.set(key, value)
      }
    } catch {
      // Keep any values copied before the browser denied further reads.
    }
  }

  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, String(value))
    },
  }
}

function defaultStorageResolver(): BrowserStorage | null {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

/**
 * Ensure dependencies see a usable Storage object. If the browser exposes
 * localStorage but denies reads or writes, install an in-memory facade for this
 * tab. Nothing is persisted, preserving the browser's privacy restriction.
 */
export function prepareBrowserStorage(): BrowserStorage | null {
  if (typeof window === 'undefined') return null

  let nativeStorage: BrowserStorage | undefined
  try {
    nativeStorage = window.localStorage
    const probeKey = '__openpendle_storage_probe__'
    nativeStorage.setItem(probeKey, '1')
    nativeStorage.removeItem(probeKey)
    return nativeStorage
  } catch {
    const memoryStorage = createMemoryStorage(nativeStorage)
    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: memoryStorage,
      })
      return memoryStorage
    } catch {
      return null
    }
  }
}

/** Clear wallet/session caches without touching pool, RPC, or UI preferences. */
export function clearWalletSessionStorage(
  resolveStorage: StorageResolver = defaultStorageResolver,
): void {
  try {
    const storage = resolveStorage()
    if (storage === null) return
    for (const key of WALLET_SESSION_KEYS) storage.removeItem(key)
    const dynamicKeys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith('rk-ens-name-')) dynamicKeys.push(key)
      if (key?.startsWith('openpendle.wagmi.v2.')) dynamicKeys.push(key)
    }
    for (const key of dynamicKeys) storage.removeItem(key)
  } catch {
    // The recovery UI can still offer a normal reload when storage is denied.
  }
}
