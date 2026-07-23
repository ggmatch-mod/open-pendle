#!/usr/bin/env node

import assert from 'node:assert/strict'

import {
  LOOPING_PENDING_FUTURE_SKEW_MS,
  LOOPING_PENDING_MAX_AGE_MS,
  LOOPING_PENDING_STORAGE_PREFIX,
  LOOPING_PENDING_VERSION,
  clearLoopingPendingOperation,
  loopingPendingStorageKey,
  parseLoopingPendingOperation,
  readLoopingPendingOperation,
  serializeLoopingPendingOperation,
  writeLoopingPendingOperation,
} from '../src/lib/loopingPending.ts'

const NOW = 1_800_000_000_000
const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER_OWNER = '0x2222222222222222222222222222222222222222'
const MARKET = `0x${'aa'.repeat(32)}`
const OTHER_MARKET = `0x${'bb'.repeat(32)}`
const HASH = `0x${'cc'.repeat(32)}`
const YT = '0x3333333333333333333333333333333333333333'

const valid = {
  version: LOOPING_PENDING_VERSION,
  operation: 'entry',
  chainId: 42161,
  owner: OWNER,
  marketId: MARKET,
  txHash: HASH,
  walletTxNonce: '17',
  startingMorphoNonce: '8',
  authorizationDeadline: '1800000120',
  createdAt: NOW,
  expectedPosition: {
    supplyShares: '0',
    minBorrowShares: '1',
    maxBorrowShares: '500000',
    minCollateral: '900000000000000000',
    maxCollateral: '1000000000000000000',
  },
}
const increaseFamily = {
  ...valid,
  operation: 'entry',
  expectedPosition: {
    supplyShares: '0',
    minBorrowShares: '500001',
    maxBorrowShares: '650000',
    minCollateral: '1100000000000000000',
    maxCollateral: '1100000000000000000',
  },
}
const mintIncreaseFamily = {
  ...increaseFamily,
  acquisitionMode: 'mint',
  mintDelivery: {
    yieldToken: YT,
    minimumYtOut: '123456789',
    transactionHash: HASH,
  },
}
const decreaseFamily = {
  ...valid,
  operation: 'exit',
  expectedPosition: {
    supplyShares: '0',
    minBorrowShares: '250000',
    maxBorrowShares: '250000',
    minCollateral: '700000000000000000',
    maxCollateral: '700000000000000000',
  },
}

function createMemoryStorage() {
  const values = new Map()
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  }
}

console.log('Pending records round-trip only through their exact scope')
const memory = createMemoryStorage()
assert.equal(writeLoopingPendingOperation(valid, memory.storage), true)
const expectedKey = `${LOOPING_PENDING_STORAGE_PREFIX}.42161.${OWNER}.${MARKET}`
assert.equal(loopingPendingStorageKey(valid), expectedKey)
assert.equal(memory.values.size, 1)
assert.deepEqual(
  readLoopingPendingOperation(valid, { storage: memory.storage, nowMs: NOW }),
  valid,
)
for (const adjustmentRecord of [increaseFamily, mintIncreaseFamily, decreaseFamily]) {
  const serializedRecord = serializeLoopingPendingOperation(adjustmentRecord)
  assert.deepEqual(JSON.parse(serializedRecord), adjustmentRecord)
  assert.deepEqual(parseLoopingPendingOperation(JSON.parse(serializedRecord)), adjustmentRecord)
}

for (const wrongScope of [
  { chainId: 1, owner: OWNER, marketId: MARKET },
  { chainId: 42161, owner: OTHER_OWNER, marketId: MARKET },
  { chainId: 42161, owner: OWNER, marketId: OTHER_MARKET },
]) {
  assert.equal(
    readLoopingPendingOperation(wrongScope, { storage: memory.storage, nowMs: NOW }),
    undefined,
  )
  assert.equal(clearLoopingPendingOperation(wrongScope, memory.storage), false)
  assert.equal(memory.values.has(expectedKey), true)
}

console.log('Malformed, stale, future, and copied records fail closed')
const malformedValues = [
  null,
  [],
  { ...valid, version: 2 },
  { ...valid, operation: 'approve' },
  { ...valid, operation: 'increase' },
  { ...valid, operation: 'decrease' },
  { ...valid, chainId: '42161' },
  { ...valid, owner: '0xdead' },
  { ...valid, marketId: '0xbeef' },
  { ...valid, txHash: '0xbeef' },
  { ...valid, walletTxNonce: '01' },
  { ...valid, startingMorphoNonce: '-1' },
  { ...valid, authorizationDeadline: '1e9' },
  { ...valid, createdAt: String(NOW) },
  { ...valid, unexpected: true },
  { ...valid, expectedPosition: { ...valid.expectedPosition, supplyShares: '1' } },
  { ...valid, expectedPosition: { ...valid.expectedPosition, minBorrowShares: '500001' } },
  { ...valid, expectedPosition: { ...valid.expectedPosition, minCollateral: '1000000000000000001' } },
  { ...valid, expectedPosition: { ...valid.expectedPosition, maxBorrowShares: `${1n << 256n}` } },
  { ...valid, expectedPosition: { ...valid.expectedPosition, maxCollateral: `${1n << 256n}` } },
  { ...valid, expectedPosition: { ...valid.expectedPosition, signature: `0x${'11'.repeat(65)}` } },
  { ...valid, acquisitionMode: 'hybrid' },
  { ...valid, acquisitionMode: 'mint' },
  { ...valid, acquisitionMode: 'market', mintDelivery: mintIncreaseFamily.mintDelivery },
  { ...valid, mintDelivery: mintIncreaseFamily.mintDelivery },
  {
    ...valid,
    acquisitionMode: 'mint',
    mintDelivery: { ...mintIncreaseFamily.mintDelivery, yieldToken: '0xdead' },
  },
  {
    ...valid,
    acquisitionMode: 'mint',
    mintDelivery: { ...mintIncreaseFamily.mintDelivery, minimumYtOut: '0' },
  },
  {
    ...valid,
    acquisitionMode: 'mint',
    mintDelivery: { ...mintIncreaseFamily.mintDelivery, transactionHash: '0xdead' },
  },
  {
    ...valid,
    acquisitionMode: 'mint',
    mintDelivery: { ...mintIncreaseFamily.mintDelivery, calldata: '0x1234' },
  },
]
for (const malformed of malformedValues) {
  assert.equal(parseLoopingPendingOperation(malformed), undefined)
}
assert.equal(parseLoopingPendingOperation(JSON.parse(serializeLoopingPendingOperation(valid))).owner, OWNER)

const staleMemory = createMemoryStorage()
const stale = { ...valid, createdAt: NOW - LOOPING_PENDING_MAX_AGE_MS - 1 }
assert.equal(writeLoopingPendingOperation(stale, staleMemory.storage), true)
assert.equal(
  readLoopingPendingOperation(stale, { storage: staleMemory.storage, nowMs: NOW }),
  undefined,
)
assert.equal(clearLoopingPendingOperation(stale, staleMemory.storage), true)

const futureMemory = createMemoryStorage()
const future = { ...valid, createdAt: NOW + LOOPING_PENDING_FUTURE_SKEW_MS + 1 }
assert.equal(writeLoopingPendingOperation(future, futureMemory.storage), true)
assert.equal(
  readLoopingPendingOperation(future, { storage: futureMemory.storage, nowMs: NOW }),
  undefined,
)

const copiedMemory = createMemoryStorage()
const copiedKey = loopingPendingStorageKey(valid)
copiedMemory.values.set(copiedKey, JSON.stringify({ ...valid, owner: OTHER_OWNER }))
assert.equal(
  readLoopingPendingOperation(valid, { storage: copiedMemory.storage, nowMs: NOW }),
  undefined,
)
assert.equal(clearLoopingPendingOperation(valid, copiedMemory.storage), false)
assert.equal(copiedMemory.values.has(copiedKey), true)

const malformedStorage = createMemoryStorage()
malformedStorage.values.set(copiedKey, '{broken')
assert.equal(
  readLoopingPendingOperation(valid, { storage: malformedStorage.storage, nowMs: NOW }),
  undefined,
)
assert.equal(clearLoopingPendingOperation(valid, malformedStorage.storage), false)
assert.equal(malformedStorage.values.has(copiedKey), true)

console.log('Signatures, calldata, and arbitrary payloads cannot be serialized')
for (const sensitive of [
  { ...valid, signature: `0x${'11'.repeat(65)}` },
  { ...valid, authorizeSignature: `0x${'22'.repeat(65)}` },
  { ...valid, revokeSignature: `0x${'33'.repeat(65)}` },
  { ...valid, calldata: '0x1234' },
  { ...valid, data: '0x1234' },
  { ...valid, signedBundle: { data: '0x1234' } },
  { ...valid, transactionRequest: { to: OWNER, data: '0x1234' } },
  { ...valid, previewKind: 'increase-preview' },
  { ...valid, targetLeverageWad: '2000000000000000000' },
  { ...valid, repayShares: '100' },
  { ...valid, collateralToSell: '100' },
  { ...valid, borrowAssets: '100' },
  { ...valid, quote: { minOut: '100' } },
  { ...valid, privateKey: `0x${'44'.repeat(32)}` },
]) {
  assert.throws(() => serializeLoopingPendingOperation(sensitive), TypeError)
  assert.equal(writeLoopingPendingOperation(sensitive, memory.storage), false)
}
const serialized = serializeLoopingPendingOperation(valid)
assert.equal(
  /signature|calldata|signedBundle|transactionRequest|privateKey|previewKind|targetLeverageWad|repayShares|collateralToSell|borrowAssets|quote/.test(serialized),
  false,
)
const serializedMint = serializeLoopingPendingOperation(mintIncreaseFamily)
assert.deepEqual(parseLoopingPendingOperation(JSON.parse(serializedMint)), mintIncreaseFamily)
assert.equal(/calldata|signature|quote|transactionRequest/.test(serializedMint), false)

console.log('Optional fields remain optional and storage failures are non-fatal')
const minimal = {
  version: LOOPING_PENDING_VERSION,
  operation: 'rescue',
  chainId: 42161,
  owner: OWNER,
  marketId: MARKET,
  startingMorphoNonce: '10',
  authorizationDeadline: '0',
  createdAt: NOW,
}
assert.deepEqual(parseLoopingPendingOperation(minimal), minimal)
assert.equal(writeLoopingPendingOperation(minimal, null), false)
assert.equal(readLoopingPendingOperation(minimal, { storage: null, nowMs: NOW }), undefined)
assert.equal(clearLoopingPendingOperation(minimal, null), false)

const deniedStorage = {
  getItem: () => { throw new Error('denied') },
  setItem: () => { throw new Error('denied') },
  removeItem: () => { throw new Error('denied') },
}
assert.equal(writeLoopingPendingOperation(minimal, deniedStorage), false)
assert.equal(readLoopingPendingOperation(minimal, { storage: deniedStorage, nowMs: NOW }), undefined)
assert.equal(clearLoopingPendingOperation(minimal, deniedStorage), false)

assert.equal(clearLoopingPendingOperation(valid, memory.storage), true)
assert.equal(memory.values.has(expectedKey), false)

console.log('looping pending-operation checks passed')
