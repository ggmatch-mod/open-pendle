/** Fork evidence for the reviewed fixed-receiver PendleSwap input sweep. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeEventLog, parseAbi } from 'viem'
import { loopingErc20Abi } from '../src/lib/loopingAbi.ts'

const REFUND_RECEIVER = '0x1fccc097db89a86bfc474a1028f93958295b1fb7'
const auditAbi = parseAbi([
  'function REFUND_RECEIVER() view returns (address)',
  'event SwapSingle(uint8 indexed swapType,address indexed tokenIn,uint256 amountIn)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
const same = (left, right) => left.toLowerCase() === right.toLowerCase()

export async function recordRedactedForkTrace(client, { hash, market, label }) {
  const directory = process.env.OPENPENDLE_FORK_TRACE_DIR
  if (!directory) return
  const trace = await client.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] })
  const frames = []
  const visit = (call, depth = 0) => {
    frames.push({ depth, type: call.type, from: call.from, to: call.to,
      selector: call.input?.slice(0, 10), error: call.error })
    for (const child of call.calls ?? []) visit(child, depth + 1)
  }
  visit(trace)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${market.chainId}-${label.replace(/[^a-z0-9]+/gi, '-')}-${hash}.json`)
  // Full calldata and authorization signatures must never enter proof logs.
  writeFileSync(path, `${JSON.stringify({ chainId: market.chainId, label, hash, frames }, null, 2)}\n`)
  console.log(`  Redacted fork call trace: ${path}`)
}

export async function capturePendleSwapFlow(client, market) {
  const refundReceiver = await client.readContract({
    address: market.contracts.pendleSwap, abi: auditAbi, functionName: 'REFUND_RECEIVER',
  })
  assert(same(refundReceiver, REFUND_RECEIVER), 'PendleSwap refund receiver must match the reviewed immutable')
  const tokens = [...new Set([
    market.morphoMarketParams.loanToken,
    ...market.routePolicy.mintSyTokenAllowlist,
    ...market.routePolicy.redeemSyTokenAllowlist,
  ].map((token) => token.toLowerCase()))]
  const balances = {}
  for (const token of tokens) {
    assert(!/^0x0{40}$/.test(token), 'This exact-input proof requires ERC-20 route tokens')
    const [swap, receiver] = await Promise.all([
      client.readContract({ address: token, abi: loopingErc20Abi, functionName: 'balanceOf', args: [market.contracts.pendleSwap] }),
      client.readContract({ address: token, abi: loopingErc20Abi, functionName: 'balanceOf', args: [refundReceiver] }),
    ])
    balances[token] = { swap, receiver }
  }
  return { refundReceiver, balances }
}

export function assertPendleSwapFlow({ market, before, after, receipt }) {
  assert(same(before.refundReceiver, after.refundReceiver), 'Refund recipient changed during the transaction')
  const swaps = []
  const transfers = []
  for (const log of receipt.logs) {
    let event
    try { event = decodeEventLog({ abi: auditAbi, data: log.data, topics: log.topics }) } catch { continue }
    if (event.eventName === 'SwapSingle' && same(log.address, market.contracts.pendleSwap)) {
      assert.equal(event.args.swapType, 1, 'Only the reviewed Kyber swap may execute')
      assert(event.args.amountIn > 0n, 'Swap input must be positive')
      assert(before.balances[event.args.tokenIn.toLowerCase()], 'Every actual swap input must be observed')
      swaps.push(event.args)
    } else if (event.eventName === 'Transfer') {
      transfers.push({ token: log.address.toLowerCase(), ...event.args })
    }
  }
  const evidence = []
  for (const [token, previous] of Object.entries(before.balances)) {
    const current = after.balances[token]
    const amountIn = swaps.filter((swap) => same(swap.tokenIn, token)).reduce((sum, swap) => sum + swap.amountIn, 0n)
    const tokenTransfers = transfers.filter((transfer) => transfer.token === token)
    const sum = (predicate) => tokenTransfers.filter(predicate).reduce((total, transfer) => total + transfer.value, 0n)
    const received = sum((transfer) => same(transfer.to, market.contracts.pendleSwap))
    const paid = sum((transfer) => same(transfer.from, market.contracts.pendleSwap))
    const swept = sum((transfer) => same(transfer.from, market.contracts.pendleSwap) && same(transfer.to, before.refundReceiver))
    assert.equal(previous.swap + received - paid, current.swap, 'Swap token transfers must reconcile to actual balance changes')
    assert.equal(current.receiver - previous.receiver, swept, 'Observe the actual fixed-recipient balance delta')
    if (amountIn > 0n) {
      assert.equal(received, amountIn, 'The swap must receive exactly its declared transaction input')
      assert.equal(swept, previous.swap, 'No transaction input may be swept to the fixed receiver')
      assert.equal(paid - swept, amountIn, 'The exact transaction input must reach the external route')
      assert.equal(current.swap, 0n, 'Used swap input must finish empty')
      evidence.push({ token, amountIn: String(amountIn), preexistingDustSwept: String(swept), transactionInputSwept: '0' })
    } else {
      assert.equal(received, 0n, 'An unquoted token must not enter PendleSwap')
      assert.equal(paid, 0n, 'An unquoted token must not leave PendleSwap')
    }
  }
  return evidence
}
