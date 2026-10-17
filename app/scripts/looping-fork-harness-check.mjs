#!/usr/bin/env node

/** Local safety regression: no public network or real wallet is involved. */
import { strict as assert } from 'node:assert'
import { createServer } from 'node:net'
import { assertCompilerForkHead, assertCompilerForkPortAvailable } from './looping-compiler-fork.mjs'

const sourceBlock = { number: '0x7b', hash: `0x${'ab'.repeat(32)}` }
const localBlock = { number: 123n, hash: sourceBlock.hash }
await assertCompilerForkHead({ getBlock: async () => localBlock }, sourceBlock)
for (const changed of [
  { ...localBlock, number: 124n },
  { ...localBlock, hash: `0x${'cd'.repeat(32)}` },
  { ...localBlock, hash: null },
]) {
  await assert.rejects(assertCompilerForkHead({ getBlock: async () => changed }, sourceBlock), /refusing fixture mutations/)
}

const existing = createServer()
await new Promise((resolve, reject) => {
  existing.once('error', reject)
  existing.listen({ host: '127.0.0.1', port: 0 }, resolve)
})
const port = existing.address().port
try {
  await assert.rejects(assertCompilerForkPortAvailable(port), /occupied or unavailable local Anvil port/)
} finally {
  await new Promise((resolve) => existing.close(resolve))
}
await assertCompilerForkPortAvailable(port)
console.log('Compiler fork rejects occupied ports and mismatched block numbers/hashes before fixture mutations')
