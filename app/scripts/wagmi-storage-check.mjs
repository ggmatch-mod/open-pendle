import assert from 'node:assert/strict'

import {
  WAGMI_STORAGE_PREFIX,
  WAGMI_STORE_STORAGE_KEY,
  createSafeWagmiBaseStorage,
  deserializeWagmiStorage,
} from '../src/lib/wagmiStorage.ts'
import {
  RAINBOWKIT_RECENT_KEY,
  RAINBOWKIT_TRANSACTIONS_KEY,
  prepareBrowserStorage,
  sanitizeRainbowKitStorage,
} from '../src/lib/rainbowKitStorage.ts'

function validStore(connections = []) {
  return JSON.stringify({
    state: {
      chainId: 42161,
      connections: { __type: 'Map', value: connections },
      current: connections[0]?.[0] ?? null,
    },
    version: 2,
  })
}

const revivedEmpty = deserializeWagmiStorage(validStore())
assert.equal(revivedEmpty.state.connections instanceof Map, true)

const revivedConnection = deserializeWagmiStorage(
  validStore([
    [
      'connector-1',
      {
        accounts: ['0x0000000000000000000000000000000000000001'],
        chainId: 42161,
        connector: { id: 'injected', name: 'Injected', type: 'injected', uid: 'connector-1' },
      },
    ],
  ]),
)
assert.equal(revivedConnection.state.connections instanceof Map, true)
assert.equal(revivedConnection.state.connections.has('connector-1'), true)

assert.equal(deserializeWagmiStorage('{broken'), null)
assert.equal(
  deserializeWagmiStorage(
    JSON.stringify({
      state: { chainId: 42161, connections: {}, current: 'stale-connector' },
      version: 2,
    }),
  ),
  null,
)
for (const connection of [
  {},
  { accounts: ['0x0000000000000000000000000000000000000001'], chainId: 42161 },
  {
    accounts: [],
    chainId: 42161,
    connector: { id: 'injected', name: 'Injected', type: 'injected', uid: 'connector-1' },
  },
  {
    accounts: ['not-an-address'],
    chainId: 42161,
    connector: { id: 'injected', name: 'Injected', type: 'injected', uid: 'connector-1' },
  },
  {
    accounts: ['0x0000000000000000000000000000000000000001'],
    chainId: '42161',
    connector: { id: 'injected', name: 'Injected', type: 'injected', uid: 'connector-1' },
  },
  {
    accounts: ['0x0000000000000000000000000000000000000001'],
    chainId: 42161,
    connector: { id: 'injected', name: 'Injected', type: 'injected', uid: 'wrong-uid' },
  },
]) {
  assert.equal(deserializeWagmiStorage(validStore([['connector-1', connection]])), null)
}
assert.equal(
  deserializeWagmiStorage(
    JSON.stringify({
      state: {
        chainId: 42161,
        connections: { __type: 'Map', value: [] },
        current: 'ghost',
      },
      version: 2,
    }),
  ),
  null,
)
assert.equal(deserializeWagmiStorage(JSON.stringify('injected')), 'injected')
assert.equal(deserializeWagmiStorage(JSON.stringify(true)), true)
assert.equal(deserializeWagmiStorage(JSON.stringify({ unexpected: true })), null)
assert.equal(WAGMI_STORAGE_PREFIX, 'openpendle.wagmi.v2')
assert.equal(WAGMI_STORE_STORAGE_KEY, 'openpendle.wagmi.v2.store')

const values = new Map()
const memoryStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
}
const safeStorage = createSafeWagmiBaseStorage(() => memoryStorage)

safeStorage.setItem('test.key', 'test-value')
assert.equal(safeStorage.getItem('test.key'), 'test-value')
safeStorage.removeItem('test.key')
assert.equal(safeStorage.getItem('test.key'), null)

// Connection objects are intentionally volatile. Connector ids and injected
// flags may persist, but the Zustand connection store must never hydrate.
values.set(WAGMI_STORE_STORAGE_KEY, validStore())
assert.equal(safeStorage.getItem(WAGMI_STORE_STORAGE_KEY), null)
safeStorage.setItem(WAGMI_STORE_STORAGE_KEY, validStore())
assert.equal(values.get(WAGMI_STORE_STORAGE_KEY), validStore())
safeStorage.removeItem(WAGMI_STORE_STORAGE_KEY)
assert.equal(values.has(WAGMI_STORE_STORAGE_KEY), false)

const deniedStorage = createSafeWagmiBaseStorage(() => {
  throw new Error('storage denied')
})
assert.equal(deniedStorage.getItem('test.key'), null)
assert.doesNotThrow(() => deniedStorage.setItem('test.key', validStore()))
assert.doesNotThrow(() => deniedStorage.removeItem('test.key'))

function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    storage: {
      get length() {
        return data.size
      },
      clear: () => data.clear(),
      getItem: (key) => data.get(key) ?? null,
      key: (index) => [...data.keys()][index] ?? null,
      removeItem: (key) => data.delete(key),
      setItem: (key, value) => data.set(key, String(value)),
    },
  }
}

const validTransactionCache = JSON.stringify({
  '0x0000000000000000000000000000000000000001': {
    42161: [
      {
        hash: `0x${'a'.repeat(64)}`,
        description: 'Approve PT',
        status: 'confirmed',
      },
    ],
  },
})

for (const invalidTransactions of [
  '{broken',
  'null',
  '[]',
  JSON.stringify({ '0xaccount': { 42161: {} } }),
  JSON.stringify({ '0xaccount': { 42161: [{ hash: '0xdead', status: 'pending' }] } }),
]) {
  const { data, storage } = createMemoryStorage({
    [RAINBOWKIT_TRANSACTIONS_KEY]: invalidTransactions,
  })
  sanitizeRainbowKitStorage(() => storage)
  assert.equal(data.has(RAINBOWKIT_TRANSACTIONS_KEY), false)
}

const rainbowKitState = createMemoryStorage({
  [RAINBOWKIT_TRANSACTIONS_KEY]: validTransactionCache,
  [RAINBOWKIT_RECENT_KEY]: JSON.stringify(['injected']),
  'openpendle.wagmi.v1.store': validStore(),
  'wagmi.store': validStore(),
})
sanitizeRainbowKitStorage(() => rainbowKitState.storage)
assert.equal(rainbowKitState.data.get(RAINBOWKIT_TRANSACTIONS_KEY), validTransactionCache)
assert.equal(rainbowKitState.data.get(RAINBOWKIT_RECENT_KEY), JSON.stringify(['injected']))
assert.equal(rainbowKitState.data.has('openpendle.wagmi.v1.store'), false)
assert.equal(rainbowKitState.data.has('wagmi.store'), false)

const invalidRecent = createMemoryStorage({ [RAINBOWKIT_RECENT_KEY]: JSON.stringify({}) })
sanitizeRainbowKitStorage(() => invalidRecent.storage)
assert.equal(invalidRecent.data.has(RAINBOWKIT_RECENT_KEY), false)

assert.doesNotThrow(() =>
  sanitizeRainbowKitStorage(() => {
    throw new Error('storage denied')
  }),
)

const deniedWindow = {}
Object.defineProperty(deniedWindow, 'localStorage', {
  configurable: true,
  get: () => {
    throw new Error('storage denied')
  },
})
globalThis.window = deniedWindow
const ephemeralStorage = prepareBrowserStorage()
assert.ok(ephemeralStorage)
ephemeralStorage.setItem('ephemeral', 'yes')
assert.equal(ephemeralStorage.getItem('ephemeral'), 'yes')
assert.equal(window.localStorage, ephemeralStorage)
delete globalThis.window

console.log('wallet storage checks passed')
