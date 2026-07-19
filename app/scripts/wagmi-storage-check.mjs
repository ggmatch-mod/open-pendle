import assert from 'node:assert/strict'

import {
  WAGMI_STORAGE_PREFIX,
  createSafeWagmiBaseStorage,
  deserializeWagmiStorage,
} from '../src/lib/wagmiStorage.ts'

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
assert.equal(deserializeWagmiStorage(JSON.stringify('injected')), 'injected')
assert.equal(WAGMI_STORAGE_PREFIX, 'openpendle.wagmi.v1')

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

const deniedStorage = createSafeWagmiBaseStorage(() => {
  throw new Error('storage denied')
})
assert.equal(deniedStorage.getItem('test.key'), null)
assert.doesNotThrow(() => deniedStorage.setItem('test.key', validStore()))
assert.doesNotThrow(() => deniedStorage.removeItem('test.key'))

console.log('wagmi storage checks passed')
