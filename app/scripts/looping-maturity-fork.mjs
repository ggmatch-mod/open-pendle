#!/usr/bin/env node
/**
 * Current-state Arbitrum maturity management proof using a real public Morpho
 * position. Source RPCs are read-only. The owner is impersonated only inside
 * local Anvil; no token balances, positions, bytecode, or storage are invented.
 *
 * The full-exit action calls come from the production compiler. Local direct
 * Morpho authorization substitutes for the real owner's unavailable signature;
 * this test does not claim to exercise the signed authorization wrapper.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData,
  getAddress, http, parseAbi, toHex,
} from 'viem'
import { arbitrum } from 'viem/chains'
import { loopingErc20Abi, morphoBlueAbi } from '../src/lib/loopingAbi.ts'
import {
  buildUnsignedLoopingExitSimulation, prepareDirectLoopingRescue,
  prepareLoopingExitExecution,
} from '../src/lib/loopingExecution.ts'
import { ARBITRUM_LOOPING_CANARY as market } from '../src/lib/loopingRegistry.ts'
import { prepareWithPendleQuoteRetry } from './looping-compiler-fork.mjs'
import { assertPendleSwapFlow, capturePendleSwapFlow, recordRedactedForkTrace } from './looping-swap-flow-proof.mjs'

const PUBLIC_OWNERS = Object.freeze([
  '0x51FDbC5ca4949eEC514232e13B9d4ED091e5A8A8',
  '0xBAC70E2De3D883fcDc3b6e2e0841ea8bC067B4f5',
])
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber'])
const auditAbi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'event Repay(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)',
])

function assertLocal(url) {
  const parsed = new URL(url)
  assert(LOOPBACK.has(parsed.hostname), 'Every mutation must target local Anvil')
}

export async function assertForkPortAvailable(port) {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', (error) => reject(new Error(
      `Refusing occupied or unavailable local Anvil port ${port}: ${error.code}`,
    )))
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolve)
  })
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
}

async function rpc(url, method, params = []) {
  if (!READ_METHODS.has(method)) assertLocal(url)
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(120_000),
  })
  assert(response.ok, `RPC ${method} returned HTTP ${response.status}`)
  const result = await response.json()
  if (result.error) throw new Error(`${method}: ${result.error.message}`)
  return result.result
}

async function waitForAnvil(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode, null, 'Anvil must remain running')
    try {
      assert.equal(BigInt(await rpc(url, 'eth_chainId')), 42161n)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw new Error('Local Anvil did not start')
}

// Same local Anvil compatibility as looping-compiler-fork.mjs: no separate
// pending state and eth_getProof can retain stale fork code hashes.
function localCompatibility(client) {
  const mapped = new Set(['call', 'getBlock', 'getBytecode', 'readContract'])
  return new Proxy(client, {
    get(target, property, receiver) {
      const fn = Reflect.get(target, property, receiver)
      if (typeof fn !== 'function') return fn
      if (property === 'getProof') return async () => {
        throw new Error('Use canonical runtime bytecode for local Anvil')
      }
      if (!mapped.has(String(property))) return fn.bind(target)
      return (args = {}) => fn.call(target,
        args.blockTag === 'pending' ? { ...args, blockTag: 'latest' } : args)
    },
  })
}

async function sendLocal({ client, wallet, localUrl, owner, intent, label }) {
  assertLocal(localUrl)
  const estimate = await client.estimateGas({
    account: owner, to: intent.to, data: intent.data, value: intent.value ?? 0n,
  })
  const gas = estimate + estimate * 3n / 10n + 100_000n
  assert(gas < (await client.getBlock()).gasLimit, 'Gas margin must fit the local block')
  const hash = await wallet.sendTransaction({
    account: owner, chain: arbitrum, to: intent.to, data: intent.data,
    value: intent.value ?? 0n, gas,
  })
  const receipt = await client.waitForTransactionReceipt({ hash })
  assert.equal(receipt.status, 'success', `${label} must mine successfully`)
  console.log(`  ${label}: block ${receipt.blockNumber}, gas ${receipt.gasUsed}`)
  return receipt
}

async function state(client, owner) {
  const loan = market.morphoMarketParams.loanToken
  const pt = market.morphoMarketParams.collateralToken
  const read = (address, abi, functionName, args = []) =>
    client.readContract({ address, abi, functionName, args })
  const balance = (token, address) => read(token, loopingErc20Abi, 'balanceOf', [address])
  const allowance = (token, holder, spender) =>
    read(token, loopingErc20Abi, 'allowance', [holder, spender])
  const [position, totals, authorized, ownerLoan, ownerPt, morphoLoan, morphoPt,
    loanSupply, ptSupply, adapterAllowance, morphoAllowance, routerAllowance,
    adapterLoan, adapterPt, adapterSy, bundlerLoan, bundlerPt, bundlerSy] = await Promise.all([
    read(market.contracts.morpho, morphoBlueAbi, 'position', [market.marketId, owner]),
    read(market.contracts.morpho, morphoBlueAbi, 'market', [market.marketId]),
    read(market.contracts.morpho, morphoBlueAbi, 'isAuthorized', [owner, market.contracts.generalAdapter1]),
    balance(loan, owner), balance(pt, owner), balance(loan, market.contracts.morpho),
    balance(pt, market.contracts.morpho), read(loan, auditAbi, 'totalSupply'),
    read(pt, auditAbi, 'totalSupply'), allowance(loan, owner, market.contracts.generalAdapter1),
    allowance(loan, owner, market.contracts.morpho),
    allowance(pt, market.contracts.bundler3, market.contracts.pendleRouter),
    balance(loan, market.contracts.generalAdapter1), balance(pt, market.contracts.generalAdapter1),
    balance(market.standardizedYield, market.contracts.generalAdapter1),
    balance(loan, market.contracts.bundler3), balance(pt, market.contracts.bundler3),
    balance(market.standardizedYield, market.contracts.bundler3),
  ])
  return { position, totals, authorized, ownerLoan, ownerPt, morphoLoan, morphoPt,
    loanSupply, ptSupply, adapterAllowance, morphoAllowance, routerAllowance,
    adapterLoan, adapterPt, adapterSy, bundlerLoan, bundlerPt, bundlerSy }
}

function repaid(receipts, owner) {
  const repayments = receipts.flatMap((receipt) => receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== market.contracts.morpho.toLowerCase()) return []
    try {
      const decoded = decodeEventLog({ abi: auditAbi, data: log.data, topics: log.topics })
      return decoded.eventName === 'Repay' &&
        decoded.args.id.toLowerCase() === market.marketId.toLowerCase() &&
        decoded.args.onBehalf.toLowerCase() === owner.toLowerCase() ? [decoded.args] : []
    } catch { return [] }
  }))
  assert.equal(repayments.length, 1, 'Exactly one real Morpho repayment must occur')
  return repayments[0]
}

function assertSettled(before, after, repayment, mode, minimumReturn = 0n) {
  assert.deepEqual(after.position, [0n, 0n, 0n], 'Debt and collateral must both be zero')
  assert.equal(repayment.shares, before.position[1], 'Repayment must consume the exact owner debt shares')
  assert.equal(before.totals[3] - after.totals[3], repayment.shares, 'Global debt shares must decrease by exactly the retired owner shares')
  assert.equal(after.morphoLoan - before.morphoLoan, repayment.assets, 'Morpho must actually receive the repaid loan tokens')
  assert.equal(before.morphoPt - after.morphoPt, before.position[2], 'Collateral outflow must equal the real starting position')
  assert.equal(before.loanSupply, after.loanSupply, 'No loan tokens may be fabricated or burned')
  assert.equal(after.authorized, false, 'Adapter authorization must end revoked')
  for (const key of ['adapterAllowance', 'morphoAllowance', 'routerAllowance',
    'adapterLoan', 'adapterPt', 'adapterSy', 'bundlerLoan', 'bundlerPt', 'bundlerSy']) {
    assert.equal(after[key], 0n, `${key} must end empty`)
  }
  if (mode === 'exit') {
    assert.equal(before.ptSupply - after.ptSupply, before.position[2], 'Matured exit must burn exactly the position PT')
    assert.equal(after.ownerPt, before.ownerPt, 'Exit must not leave returned collateral in the wallet')
    assert(after.ownerLoan - before.ownerLoan >= minimumReturn, 'Wallet loan-token return must honor the compiler floor')
  } else {
    assert.equal(after.ptSupply, before.ptSupply, 'Direct rescue must not burn or fabricate PT')
    assert.equal(after.ownerPt - before.ownerPt, before.position[2], 'Direct rescue must return the exact collateral')
    assert.equal(before.ownerLoan - after.ownerLoan, repayment.assets, 'Wallet debit must equal exact repayment assets')
  }
}

function assertNoStartingCustodyDust(snapshot) {
  for (const key of ['adapterLoan', 'adapterPt', 'adapterSy', 'bundlerLoan', 'bundlerPt', 'bundlerSy']) {
    assert.equal(snapshot[key], 0n, `${key} must start empty; shared custody dust cannot fund the proof`)
  }
}

export async function runMaturityFork({
  sourceUrl = 'https://arb1.arbitrum.io/rpc', port = 18559, owner,
} = {}) {
  assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535)
  const candidates = owner === undefined ? PUBLIC_OWNERS : [getAddress(owner)]
  await assertForkPortAvailable(port)
  assert.equal(BigInt(await rpc(sourceUrl, 'eth_chainId')), 42161n)
  const sourceBlock = BigInt(await rpc(sourceUrl, 'eth_blockNumber'))
  const capturedSourceHead = await rpc(sourceUrl, 'eth_getBlockByNumber', [toHex(sourceBlock), false])
  assert(capturedSourceHead?.hash && BigInt(capturedSourceHead.number) === sourceBlock,
    'Source RPC must identify the exact canonical source block')
  const localUrl = `http://127.0.0.1:${port}`
  assertLocal(localUrl)
  const child = spawn('anvil', ['--fork-url', sourceUrl, '--fork-block-number', String(sourceBlock),
    '--chain-id', '42161', '--hardfork', 'osaka', '--port', String(port), '--accounts', '0', '--silent'],
  { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', () => {})
  try {
    await waitForAnvil(localUrl, child)
    const client = localCompatibility(createPublicClient({ chain: arbitrum, cacheTime: 0,
      transport: http(localUrl, { retryCount: 0, timeout: 120_000 }) }))
    const sourceHead = await client.getBlock()
    assert.equal(sourceHead.number, sourceBlock, 'Local Anvil head must equal the exact captured source block')
    assert.equal(sourceHead.hash?.toLowerCase(), capturedSourceHead.hash.toLowerCase(),
      'Local Anvil must contain the exact captured source block hash')
    assert(sourceHead.timestamp >= market.pendleMarketExpiry, 'Fixture must already be matured at the real source head')
    let initial
    for (const candidate of candidates) {
      const address = getAddress(candidate)
      const ownerCode = await client.getBytecode({ address })
      if (ownerCode && ownerCode !== '0x') continue
      const candidateState = await state(client, address)
      if (candidateState.position[0] !== 0n || candidateState.position[1] <= 0n ||
        candidateState.position[2] <= 0n || candidateState.ownerLoan <= 0n) continue
      owner = address
      initial = candidateState
      break
    }
    assert(initial, 'No genuine EOA borrower fixture remains; never fabricate a replacement position')
    assert.equal(initial.position[0], 0n)
    assert(initial.position[1] > 0n && initial.position[2] > 0n, 'A real funded debt-and-collateral position is required')
    assert.equal(initial.adapterAllowance, 0n)
    assert.equal(initial.morphoAllowance, 0n)
    assert.equal(child.exitCode, null, 'The Anvil child must own the running fork before any mutation')
    assert.equal((await client.getBlock()).number, sourceBlock, 'The fork must remain unmodified before impersonation')
    const wallet = createWalletClient({ account: owner, chain: arbitrum,
      transport: http(localUrl, { retryCount: 0, timeout: 120_000 }) })
    await rpc(localUrl, 'anvil_impersonateAccount', [owner])
    await rpc(localUrl, 'anvil_setBalance', [owner, toHex(10n ** 20n)])
    console.log(`Current-state Arbitrum matured management, source block ${sourceBlock}`)
    console.log(`  Real public owner ${owner}; only native gas funding is synthetic`)
    const send = (intent, label) => sendLocal({ client, wallet, localUrl, owner, intent, label })
    if (initial.authorized) {
      await assert.rejects(prepareLoopingExitExecution({ client, owner, market, minimumReturnedAssets: 1n }),
        (error) => error.code === 'ACTIVE_ADAPTER_AUTHORIZATION')
      const cleanup = await prepareDirectLoopingRescue({ client, owner, market })
      assert.equal(cleanup.phase, 'revoke-adapter')
      assert.equal(cleanup.intents.length, 1)
      await send(cleanup.intents[0], 'compiled existing-authorization recovery')
      const clean = await state(client, owner)
      assert.deepEqual(clean.position, initial.position, 'Authorization recovery must preserve the real position')
      assert.equal(clean.authorized, false)
    }
    const baseline = await rpc(localUrl, 'evm_snapshot')
    const beforeExit = await state(client, owner)
    assertNoStartingCustodyDust(beforeExit)
    const preview = await prepareWithPendleQuoteRetry('real matured exit', () =>
      prepareLoopingExitExecution({ client, owner, market, minimumReturnedAssets: 1n }))
    assert.equal(preview.quote.kind, 'redeem-matured-pt')
    const intent = buildUnsignedLoopingExitSimulation(preview)
    await send({ to: market.contracts.morpho, data: encodeFunctionData({ abi: morphoBlueAbi,
      functionName: 'setAuthorization', args: [market.contracts.generalAdapter1, true] }) },
    'local owner authorization for compiler action calls')
    assert(Date.now() < intent.validUntilMs, 'The real quote must remain fresh at submission')
    const swapFlowBefore = await capturePendleSwapFlow(client, market)
    const exitReceipt = await send(intent, 'production compiler matured exit action calls')
    const swapFlowAfter = await capturePendleSwapFlow(client, market)
    const swapFlowEvidence = assertPendleSwapFlow({ market, before: swapFlowBefore, after: swapFlowAfter, receipt: exitReceipt })
    console.log(`  Matured exit exact-input sweep proof: ${JSON.stringify(swapFlowEvidence)}`)
    await recordRedactedForkTrace(client, { hash: exitReceipt.transactionHash, market, label: 'matured-exit' })
    const cleanup = await prepareDirectLoopingRescue({ client, owner, market })
    assert.equal(cleanup.phase, 'revoke-adapter')
    await send(cleanup.intents[0], 'compiled post-exit authorization cleanup')
    const afterExit = await state(client, owner)
    const exitRepayment = repaid([exitReceipt], owner)
    assertSettled(beforeExit, afterExit, exitRepayment, 'exit', preview.minimumReturnedAssets)
    assert.equal(await rpc(localUrl, 'evm_revert', [baseline]), true)
    const beforeRescue = await state(client, owner)
    assertNoStartingCustodyDust(beforeRescue)
    assert.deepEqual(beforeRescue.position, beforeExit.position, 'Rescue branch must restore the same genuine position')
    const rescueReceipts = []
    const rescueSteps = []
    for (let step = 0; step < 12; step += 1) {
      const plan = await prepareDirectLoopingRescue({ client, owner, market })
      if (plan.phase === 'complete') {
        assert.equal(plan.intents.length, 0)
        break
      }
      assert.equal(plan.intents.length, 1)
      assert.equal(plan.intents[0].step, plan.phase)
      rescueReceipts.push(await send(plan.intents[0], `compiled direct rescue ${plan.phase}`))
      rescueSteps.push(plan.phase)
    }
    const afterRescue = await state(client, owner)
    const finalPlan = await prepareDirectLoopingRescue({ client, owner, market })
    assert.equal(finalPlan.phase, 'complete', 'Direct rescue must converge without skipping work')
    assertSettled(beforeRescue, afterRescue, repaid(rescueReceipts, owner), 'rescue')
    const summary = { observedAt: new Date().toISOString(), sourceBlock: String(sourceBlock),
      sourceBlockHash: sourceHead.hash,
      sourceTimestamp: String(sourceHead.timestamp), owner, marketId: market.marketId,
      borrowedShares: String(initial.position[1]), collateral: String(initial.position[2]),
      exitKind: preview.quote.kind, returnedLoanAssets: String(afterExit.ownerLoan - beforeExit.ownerLoan),
      minimumReturnedLoanAssets: String(preview.minimumReturnedAssets), rescueSteps,
      fixture: 'actual public position; local impersonation and native gas only',
      signedAuthorizationWrapperExercised: false, debtAndCollateralZero: true,
      tokenAndDebtShareConservation: true, authorizationsAndAllowancesCleared: true,
      swapInputConservation: swapFlowEvidence }
    console.log(JSON.stringify(summary, null, 2))
    return summary
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const arg = (key) => {
    const index = process.argv.indexOf(key)
    return index < 0 ? undefined : process.argv[index + 1]
  }
  await runMaturityFork({ sourceUrl: arg('--rpc-url'), owner: arg('--owner'),
    port: Number(arg('--port') ?? 18559) })
}
