#!/usr/bin/env node

/** Network-free guardrails for the production-compiler burner runner. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LIVE_CANARY_ACKNOWLEDGEMENT,
  assertRpcPayloadDoesNotSimulateSensitiveCalldata,
  createRequestLimiter,
  parseCanaryMode,
  replacementFeeFloors,
  runCanary,
  validateRecoveryJournal,
  withRuntimeReadFallback,
} from './live-looping-compiler-canary.mjs'
import {
  ARBITRUM_LOOPING_CANARY,
  ARBITRUM_LOOPING_CHAIN_ID,
} from '../src/lib/loopingRegistry.ts'

const runnerSource = readFileSync(
  new URL('./live-looping-compiler-canary.mjs', import.meta.url),
  'utf8',
)
const failures = []
let checks = 0

function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`ok ${checks} - ${name}`)
    return
  }
  failures.push({ name, detail })
  console.error(`not ok ${checks} - ${name}`)
  console.error(`  ${detail}`)
}

function count(pattern) {
  return [...runnerSource.matchAll(pattern)].length
}

function rejects(callback) {
  try {
    callback()
    return false
  } catch {
    return true
  }
}

const hash = `0x${'12'.repeat(32)}`

console.log('# closed CLI modes')
check('empty argv is read-only', parseCanaryMode([]).kind === 'read-only', 'Default mode changed.')
check('round-trip is explicit', parseCanaryMode(['--round-trip']).kind === 'round-trip', 'Round-trip flag changed.')
check('exit is explicit', parseCanaryMode(['--exit']).kind === 'exit', 'Exit flag changed.')
check('rescue is explicit', parseCanaryMode(['--rescue']).kind === 'rescue', 'Rescue flag changed.')
check('live preflight is explicit', parseCanaryMode(['--live-preflight']).kind === 'live-preflight', 'Live preflight flag changed.')
check('stale-lock cleanup is explicit', parseCanaryMode(['--clear-stale-lock']).kind === 'clear-stale-lock', 'Stale-lock cleanup flag changed.')
check('reconcile binds its hash', parseCanaryMode(['--reconcile', hash]).hash === hash, 'Reconcile hash was not retained.')
check('recovery binds its hash', parseCanaryMode(['--recover-reverted', hash]).hash === hash, 'Recovery hash was not retained.')
check('ambiguous cancellation binds its source hash', parseCanaryMode(['--cancel-ambiguous', hash]).hash === hash, 'Cancellation source hash was not retained.')
check('conflicting modes reject', rejects(() => parseCanaryMode(['--exit', '--rescue'])), 'Conflicting modes were accepted.')
check('duplicate modes reject', rejects(() => parseCanaryMode(['--exit', '--exit'])), 'Duplicate modes were accepted.')
check('unknown arguments reject', rejects(() => parseCanaryMode(['--send'])), 'An unknown write-looking flag was accepted.')
check('hashless reconciliation rejects', rejects(() => parseCanaryMode(['--reconcile'])), 'Hashless reconciliation was accepted.')

function dependencyHarness({ readOnlyError } = {}) {
  const calls = {
    readOnly: 0,
    reconcile: 0,
    loadBurnerRuntime: 0,
    roundTrip: 0,
    exit: 0,
    recoverReverted: 0,
    cancelAmbiguous: 0,
    rescue: 0,
    livePreflight: 0,
    withLock: 0,
    clearStaleLock: 0,
  }
  const dependencies = {
    readOnly: async () => {
      calls.readOnly += 1
      if (readOnlyError) throw new Error('read failure')
      return 'read-only'
    },
    reconcile: async () => {
      calls.reconcile += 1
      return 'reconciled'
    },
    loadBurnerRuntime: () => {
      calls.loadBurnerRuntime += 1
      return Object.freeze({ fake: true })
    },
    roundTrip: async () => { calls.roundTrip += 1 },
    exit: async () => { calls.exit += 1 },
    recoverReverted: async () => { calls.recoverReverted += 1 },
    cancelAmbiguous: async () => { calls.cancelAmbiguous += 1 },
    rescue: async () => { calls.rescue += 1 },
    livePreflight: async () => { calls.livePreflight += 1 },
    clearStaleLock: async () => { calls.clearStaleLock += 1 },
    withLock: async (task) => {
      calls.withLock += 1
      return task()
    },
  }
  return { calls, dependencies }
}

console.log('# secret and write gate ordering')
{
  const harness = dependencyHarness()
  await runCanary({
    argv: [],
    env: {
      OPENPENDLE_LIVE_E2E: LIVE_CANARY_ACKNOWLEDGEMENT,
      OPENPENDLE_TEST_WALLET_PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
    },
    dependencies: harness.dependencies,
  })
  check('acknowledgement alone remains read-only', harness.calls.readOnly === 1, 'Default mode did not stay read-only.')
  check('read-only never loads the burner key', harness.calls.loadBurnerRuntime === 0, 'Default mode reached secret loading.')
  check('read-only invokes no value-moving handler',
    harness.calls.roundTrip + harness.calls.exit + harness.calls.recoverReverted +
      harness.calls.cancelAmbiguous + harness.calls.rescue +
      harness.calls.livePreflight === 0,
    'Default mode reached a write handler.')
}
{
  const harness = dependencyHarness({ readOnlyError: true })
  await assert.rejects(runCanary({ argv: [], env: {}, dependencies: harness.dependencies }))
  check('failed read-only still never loads secrets', harness.calls.loadBurnerRuntime === 0, 'A read failure reached secret loading.')
}
for (const argv of [
  ['--round-trip'],
  ['--exit'],
  ['--rescue'],
  ['--recover-reverted', hash],
  ['--cancel-ambiguous', hash],
  ['--live-preflight'],
]) {
  const harness = dependencyHarness()
  await assert.rejects(runCanary({ argv, env: {}, dependencies: harness.dependencies }))
  check(`${argv[0]} rejects before key loading without acknowledgement`,
    harness.calls.loadBurnerRuntime === 0,
    `${argv[0]} loaded secrets before its acknowledgement gate.`)
}
{
  const harness = dependencyHarness()
  await runCanary({
    argv: ['--round-trip'],
    env: { OPENPENDLE_LIVE_E2E: LIVE_CANARY_ACKNOWLEDGEMENT },
    dependencies: harness.dependencies,
  })
  check('exact live acknowledgement reaches one secret load', harness.calls.loadBurnerRuntime === 1, 'Acknowledged mode did not load exactly one runtime.')
  check('exact live acknowledgement reaches only its handler', harness.calls.roundTrip === 1, 'Acknowledged mode selected the wrong handler.')
}
{
  const harness = dependencyHarness()
  await runCanary({
    argv: ['--reconcile', hash],
    env: { OPENPENDLE_LIVE_E2E: LIVE_CANARY_ACKNOWLEDGEMENT },
    dependencies: harness.dependencies,
  })
  check('reconciliation remains keyless', harness.calls.loadBurnerRuntime === 0, 'Read-only reconciliation loaded the key.')
}
{
  const harness = dependencyHarness()
  await runCanary({ argv: ['--clear-stale-lock'], env: {}, dependencies: harness.dependencies })
  check('stale-lock cleanup remains keyless',
    harness.calls.clearStaleLock === 1 && harness.calls.loadBurnerRuntime === 0,
    'Local stale-lock cleanup loaded the burner key.')
}

console.log('# signed-calldata RPC firewall')
const sensitive = new Set(['0x1234abcd'])
check('signed data is blocked from eth_call',
  rejects(() => assertRpcPayloadDoesNotSimulateSensitiveCalldata(
    'eth_call', [{ to: '0x1', data: '0x1234abcd' }, 'latest'], sensitive)),
  'Signed calldata reached eth_call.')
check('signed data is blocked from eth_estimateGas',
  rejects(() => assertRpcPayloadDoesNotSimulateSensitiveCalldata(
    'eth_estimateGas', [{ data: '0x1234abcd' }], sensitive)),
  'Signed calldata reached eth_estimateGas.')
check('unsigned eth_call remains available',
  !rejects(() => assertRpcPayloadDoesNotSimulateSensitiveCalldata(
    'eth_call', [{ data: '0xdeadbeef' }], sensitive)),
  'The firewall blocked an unrelated unsigned simulation.')
check('raw broadcast remains available',
  !rejects(() => assertRpcPayloadDoesNotSimulateSensitiveCalldata(
    'eth_sendRawTransaction', ['0x001234abcd00'], sensitive)),
  'The firewall blocked the single intended raw broadcast.')

console.log('# unsigned read failover')
{
  const limit = createRequestLimiter(2)
  let active = 0
  let maximumActive = 0
  await Promise.all(Array.from({ length: 6 }, () => limit(async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    active -= 1
  })))
  check('read-only RPC concurrency is bounded',
    maximumActive === 2,
    'The live compiler could still burst every parallel read at one provider.')
}
{
  const clients = [{ name: 'rate-limited' }, { name: 'fallback' }]
  const calls = []
  const result = await withRuntimeReadFallback(
    { readClients: clients },
    async (client) => {
      calls.push(client.name)
      if (client.name === 'rate-limited') throw new Error('Too Many Requests 429')
      return 'ok'
    },
  )
  check('unsigned task retries after an explicit rate limit',
    result.value === 'ok' && result.fallbackUsed && calls.join(',') === 'rate-limited,fallback',
    'A classified transport failure did not reach the next reviewed read client.')
}
{
  const calls = []
  const safetyError = Object.assign(new Error('Pinned route wiring changed.'), {
    code: 'UNSAFE_WIRING',
  })
  await assert.rejects(withRuntimeReadFallback(
    { readClients: [{ name: 'primary' }, { name: 'fallback' }] },
    async (client) => {
      calls.push(client.name)
      throw safetyError
    },
  ))
  check('unsigned task never retries a compiler safety failure',
    calls.join(',') === 'primary',
    'A compiler safety failure reached another RPC.')
}
{
  const calls = []
  await assert.rejects(withRuntimeReadFallback(
    { readClients: [{ name: 'primary' }, { name: 'fallback' }] },
    async (client) => {
      calls.push(client.name)
      throw new Error('Contract function reverted: execution reverted')
    },
  ))
  check('unsigned task never retries a contract revert',
    calls.join(',') === 'primary',
    'A contract revert was masked by RPC failover.')
}

console.log('# closed recovery metadata')
const journal = {
  schema: 'openpendle.live-looping-compiler-canary.v2',
  chainId: ARBITRUM_LOOPING_CHAIN_ID,
  owner: '0x24BC6b3F217f379C0e8e09ec090eA23541B30155',
  marketId: ARBITRUM_LOOPING_CANARY.marketId,
  operation: 'entry',
  rootTransaction: null,
  priorTransactions: [],
  walletNonce: 7,
  transactionHash: hash,
  sourceTransactionHash: hash,
  maxFeePerGas: '100000000',
  maxPriorityFeePerGas: '0',
  authorization: { startingNonce: '6', deadline: '1800000000' },
  bounds: {
    borrowAssets: '500000',
    equityAssets: '1000000',
    exactBorrowShares: null,
    exactCollateral: null,
    maxBorrowShares: '510000000000',
    minimumCollateral: '1000000000000000000',
    minimumReturnedAssets: null,
    repaymentCapAssets: null,
  },
}
check('closed recovery journal accepts bounded metadata',
  validateRecoveryJournal(journal).operation === 'entry',
  'The reviewed journal shape was rejected.')
check('recovery journal rejects signatures',
  rejects(() => validateRecoveryJournal({ ...journal, signature: `0x${'11'.repeat(65)}` })),
  'A signature field was accepted.')
check('recovery journal rejects calldata',
  rejects(() => validateRecoveryJournal({ ...journal, calldata: '0x1234' })),
  'A calldata field was accepted.')
check('recovery journal rejects raw transactions',
  rejects(() => validateRecoveryJournal({ ...journal, rawTransaction: '0x1234' })),
  'A raw transaction field was accepted.')
const {
  rootTransaction: _discardedRootTransaction,
  priorTransactions: _discardedPriorTransactions,
  ...baseJournal
} = journal
const cancellationHash = `0x${'34'.repeat(32)}`
const cancellationJournal = {
  ...baseJournal,
  operation: 'nonce-cancellation',
  transactionHash: cancellationHash,
  sourceTransactionHash: hash,
  maxFeePerGas: '120000001',
  maxPriorityFeePerGas: '1000000',
  rootTransaction: baseJournal,
  priorTransactions: [baseJournal],
}
const validatedCancellation = validateRecoveryJournal(cancellationJournal)
check('nonce cancellation retains the original bounded journal',
  validatedCancellation.rootTransaction.transactionHash === hash &&
    validatedCancellation.priorTransactions[0].transactionHash === hash,
  'Cancellation discarded the original or replaced transaction metadata.')
check('nonce cancellation rejects missing original metadata',
  rejects(() => validateRecoveryJournal({
    ...cancellationJournal,
    rootTransaction: null,
  })),
  'Cancellation accepted no original transaction metadata.')
const {
  rootTransaction: _discardedCancellationRoot,
  priorTransactions: _discardedCancellationHistory,
  ...baseCancellation
} = cancellationJournal
const repeatedCancellation = validateRecoveryJournal({
  ...baseCancellation,
  transactionHash: `0x${'56'.repeat(32)}`,
  maxFeePerGas: '144000002',
  maxPriorityFeePerGas: '1200001',
  rootTransaction: baseJournal,
  priorTransactions: [baseJournal, baseCancellation],
})
check('repeated replacements retain append-only same-nonce history',
  repeatedCancellation.priorTransactions.length === 2 &&
    repeatedCancellation.priorTransactions[0].transactionHash === hash &&
    repeatedCancellation.priorTransactions[1].transactionHash === cancellationHash,
  'A later replacement discarded an earlier candidate hash.')
check('replacement history rejects a duplicate candidate hash',
  rejects(() => validateRecoveryJournal({
    ...repeatedCancellation,
    priorTransactions: [baseJournal, baseJournal],
  })),
  'Duplicate same-nonce candidates were accepted.')
const zeroTipReplacement = replacementFeeFloors({
  maxFeePerGas: '100000000',
  maxPriorityFeePerGas: '0',
})
check('zero-tip replacement receives a positive priority fee',
  zeroTipReplacement.minimumMaxPriorityFeePerGas > 0n &&
    zeroTipReplacement.minimumMaxFeePerGas >=
      zeroTipReplacement.minimumMaxPriorityFeePerGas,
  'A zero-tip transaction could not be replaced safely.')
const nonzeroTipReplacement = replacementFeeFloors({
  maxFeePerGas: '100000000',
  maxPriorityFeePerGas: '1000000',
})
check('nonzero replacement fees are strictly bumped',
  nonzeroTipReplacement.minimumMaxFeePerGas > 100000000n &&
    nonzeroTipReplacement.minimumMaxPriorityFeePerGas > 1000000n,
  'Replacement fee floors did not strictly increase both caps.')

console.log('# production compiler and broadcast structure')
for (const imported of [
  'prepareLoopingEntryExecution',
  'buildUnsignedLoopingEntrySimulation',
  'simulateUnsignedLoopingIntent',
  'buildSignedLoopingEntryBundle',
  'revalidateSignedLoopingEntry',
  'verifyLoopingEntryReceiptState',
  'prepareLoopingExitExecution',
  'buildUnsignedLoopingExitSimulation',
  'buildSignedLoopingExitBundle',
  'revalidateSignedLoopingExit',
  'verifyLoopingExitReceiptState',
  'prepareDirectLoopingRescue',
  'prepareLoopingAuthorizationNonceBurn',
  'buildLoopingAuthorizationNonceBurnIntent',
  'ARBITRUM_LOOPING_CANARY',
]) {
  check(`runner imports or invokes ${imported}`, runnerSource.includes(imported), `${imported} is missing.`)
}
for (const forbiddenBuilder of [
  'setAuthorizationWithSig',
  'morphoBorrow',
  'morphoSupplyCollateral',
  'morphoRepay',
  'swapExactTokenForPt',
]) {
  check(`runner does not hand-build ${forbiddenBuilder}`,
    !runnerSource.includes(forbiddenBuilder),
    `Runner contains the hand-built primitive ${forbiddenBuilder}.`)
}
check('runner never directly calls signed calldata', !runnerSource.includes('.call('), 'A direct RPC call primitive exists in the runner.')
check('runner never directly estimates signed calldata', !runnerSource.includes('.estimateGas('), 'A direct gas-estimation primitive exists in the runner.')
check('one local raw-transaction signer is centralized', count(/\.signTransaction\(/g) === 1, 'Expected exactly one local raw signer.')
check('one raw-broadcast call site is centralized', count(/\.sendRawTransaction\(/g) === 1, 'Expected exactly one raw-broadcast call site.')
check('wallet sendTransaction is absent', !runnerSource.includes('.sendTransaction('), 'Runner may invoke wallet-managed transaction sending.')
check('writeContract is absent', !runnerSource.includes('.writeContract('), 'Runner may invoke an unreviewed write primitive.')
check('transport retries are disabled', runnerSource.includes('retryCount: 0'), 'RPC transport could retry a raw broadcast.')
check('journal is mode 0600', count(/0o600/g) >= 4, 'Journal permission enforcement is missing.')
check('fixed canary size is an explicit reviewed fixture',
  runnerSource.includes('const EQUITY_ASSETS = 1_000_000n') &&
    runnerSource.includes('const BORROW_ASSETS = 500_000n') &&
    !runnerSource.includes('betaCaps'),
  'Canary size must remain explicit without imposing a browser execution cap.')
check('entry and exit use fixed reviewed gas',
  runnerSource.includes('gas: ENTRY_GAS') && runnerSource.includes('gas: EXIT_GAS'),
  'A signed bundle lacks an explicit fixed gas bound.')
check('canary entry and exit enforce 90% economic floors',
  runnerSource.includes('MINIMUM_EXIT_RETURN = EQUITY_ASSETS * 9_000n / 10_000n') &&
    runnerSource.includes('MINIMUM_ENTRY_COLLATERAL_LOAN_VALUE') &&
    runnerSource.includes('preview.health.collateralLoanValue <'),
  'A live canary leg lacks its explicit economic-loss bound.')
check('round-trip reserves the complete capped lifecycle gas budget',
  runnerSource.includes('REQUIRED_LIFECYCLE_ETH_RESERVE') &&
    runnerSource.includes('before.ethBalance < REQUIRED_LIFECYCLE_ETH_RESERVE') &&
    runnerSource.includes('EXIT_MAX_NETWORK_COST +') &&
    count(/AUXILIARY_MAX_NETWORK_COST \+/g) >= 2 &&
    runnerSource.includes('4n * AUXILIARY_MAX_NETWORK_COST'),
  'Entry could consume the ETH needed for exit or direct rescue.')
check('cancellation journal retains root and append-only transaction proofs',
  runnerSource.includes('rootTransaction,') &&
    runnerSource.includes('priorTransactions: nextPriorTransactions') &&
    runnerSource.includes('const currentGeneration = [...priorTransactions, currentTransaction]') &&
    runnerSource.includes('More than one same-nonce cancellation candidate appears mined.'),
  'A cancellation race could lose the transaction needed for reconciliation.')
check('restart reconciliation also requires two confirmations',
  count(/twoConfirmedReceiptOrUndefined\(/g) >= 3 &&
    runnerSource.includes('is mined but does not yet have two confirmations.'),
  'A restarted runner could act on a reorgable one-confirmation receipt.')
check('value-moving modes hold an exclusive local lock',
  runnerSource.includes("openSync(LOCK_PATH, 'wx', 0o600)") &&
    runnerSource.includes('return dependencies.withLock(async () =>'),
  'Concurrent runners could race the journal and wallet nonce.')
check('crashed lock has an explicit dead-process-only recovery path',
  runnerSource.includes("kind: 'clear-stale-lock'") &&
    runnerSource.includes('process.kill(pid, 0)') &&
    runnerSource.includes('clearStaleCanaryLock') &&
    runnerSource.includes('still owns the lock.'),
  'A crash could permanently block journal recovery or allow a live lock to be removed.')

const gateIndex = runnerSource.indexOf(
  'env.OPENPENDLE_LIVE_E2E !== LIVE_CANARY_ACKNOWLEDGEMENT',
)
const loaderIndex = runnerSource.indexOf('const runtime = dependencies.loadBurnerRuntime()')
check('acknowledgement gate precedes secret loading',
  gateIndex >= 0 && loaderIndex > gateIndex,
  'Secret loading moved before the live acknowledgement gate.')

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} live-canary safety checks failed.`)
  process.exitCode = 1
} else {
  console.log(`\nAll ${checks} live-canary safety checks passed.`)
}
