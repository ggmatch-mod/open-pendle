#!/usr/bin/env node

/** Local safety regression: no public network or real wallet is involved. */
import { strict as assert } from 'node:assert'
import { createServer } from 'node:net'
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters } from 'viem'
import { assertCompilerForkHead, assertCompilerForkPortAvailable } from './looping-compiler-fork.mjs'
import { assertPendleSwapFlow } from './looping-swap-flow-proof.mjs'

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

const token = '0x000000000000000000000000000000000000000a'
const swap = '0x000000000000000000000000000000000000000b'
const sender = '0x000000000000000000000000000000000000000c'
const externalRouter = '0x000000000000000000000000000000000000000d'
const receiver = '0x1fccc097db89a86bfc474a1028f93958295b1fb7'
const abi = parseAbi([
  'event SwapSingle(uint8 indexed swapType,address indexed tokenIn,uint256 amountIn)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
const log = (address, eventName, args, value) => ({
  address, topics: encodeEventTopics({ abi, eventName, args }),
  data: encodeAbiParameters(parseAbiParameters('uint256'), [value]),
})
const proof = (swept, used, receiverDelta = swept) => ({
  market: { contracts: { pendleSwap: swap } },
  before: { refundReceiver: receiver, balances: { [token]: { swap: 7n, receiver: 100n } } },
  after: { refundReceiver: receiver, balances: { [token]: { swap: 0n, receiver: 100n + receiverDelta } } },
  receipt: { logs: [
    log(token, 'Transfer', { from: sender, to: swap }, 100n),
    log(token, 'Transfer', { from: swap, to: externalRouter }, used),
    log(token, 'Transfer', { from: swap, to: receiver }, swept),
    log(swap, 'SwapSingle', { swapType: 1, tokenIn: token }, 100n),
  ] },
})
assert.deepEqual(assertPendleSwapFlow(proof(7n, 100n)), [{
  token, amountIn: '100', preexistingDustSwept: '7', transactionInputSwept: '0',
}])
// All cases end with an empty swap balance. Emptiness alone must never make
// transaction-input loss or a fabricated recipient-transfer report pass.
assert.throws(() => assertPendleSwapFlow(proof(8n, 99n)), /No transaction input may be swept/)
assert.throws(() => assertPendleSwapFlow(proof(7n, 99n)), /reconcile/)
assert.throws(() => assertPendleSwapFlow(proof(7n, 100n, 6n)), /actual fixed-recipient balance delta/)
console.log('Swap flow proof reconciles exact input and actual recipient deltas; empty balances cannot hide input loss')
