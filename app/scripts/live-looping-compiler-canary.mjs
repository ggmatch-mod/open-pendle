#!/usr/bin/env node

/**
 * Guarded Arbitrum burner runner for the exact production looping compiler.
 *
 * Default mode is read-only and never opens the local secrets file. Live modes
 * require both an explicit flag and OPENPENDLE_LIVE_E2E acknowledgement:
 *
 *   --round-trip             exact approval -> entry -> later block -> full exit
 *   --exit                   freshly compile and close an existing canary loop
 *   --live-preflight         load reviewed burner/RPC and compile without signing
 *   --recover-reverted HASH  invalidate authorizations exposed by a reverted bundle
 *   --cancel-ambiguous HASH   replace an unresolved raw transaction and burn auth
 *   --rescue                 submit one freshly compiled direct-rescue step
 *   --reconcile HASH         read-only transaction and permission reconciliation
 *   --clear-stale-lock       remove a lock only after proving its process is dead
 *
 * Signed Morpho authorization calldata is never sent to eth_call or
 * eth_estimateGas. Entry and exit use fixed, fork-reviewed gas limits, are
 * signed locally, journaled without secrets, and broadcast exactly once.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { loopingErc20Abi, morphoBlueAbi } from '../src/lib/loopingAbi.ts'
import {
  buildLoopingAuthorizationRecoveryIntent,
  buildLoopingAuthorizationNonceBurnIntent,
  buildSignedLoopingEntryBundle,
  buildSignedLoopingExitBundle,
  buildUnsignedLoopingEntrySimulation,
  buildUnsignedLoopingExitSimulation,
  classifyExposedLoopingAuthorization,
  prepareDirectLoopingRescue,
  prepareLoopingEntryExecution,
  prepareLoopingExitExecution,
  prepareLoopingAuthorizationNonceBurn,
  readExposedLoopingAuthorizationPairFromTransaction,
  readExposedLoopingAuthorizationRecoveryState,
  readLoopingExecutionPosition,
  revalidateSignedLoopingEntry,
  revalidateSignedLoopingExit,
  simulateUnsignedLoopingIntent,
  verifyLoopingEntryReceiptState,
  verifyLoopingExitReceiptState,
} from '../src/lib/loopingExecution.ts'
import {
  ARBITRUM_LOOPING_CANARY,
  ARBITRUM_LOOPING_CHAIN_ID,
} from '../src/lib/loopingRegistry.ts'
import {
  LOOPING_1RPC_ARBITRUM_URL,
  mayUseLoopingWalletReadFallback,
} from '../src/lib/loopingRpc.ts'

export const LIVE_CANARY_ACKNOWLEDGEMENT =
  'ARBITRUM_BURNER_PRODUCTION_COMPILER_LOOP'

const BURNER_ADDRESS = getAddress('0x24BC6b3F217f379C0e8e09ec090eA23541B30155')
const PUBLIC_ARBITRUM_READ_FALLBACK = 'https://arb1.arbitrum.io/rpc'
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/
const JOURNAL_SCHEMA = 'openpendle.live-looping-compiler-canary.v2'
const JOURNAL_PATH = fileURLToPath(
  new URL('../.live-looping-compiler-canary-recovery.json', import.meta.url),
)
const JOURNAL_TEMP_PATH = `${JOURNAL_PATH}.tmp`
const LOCK_PATH = fileURLToPath(
  new URL('../.live-looping-compiler-canary.lock', import.meta.url),
)
const LOCK_SCHEMA = 'openpendle.live-looping-compiler-canary.lock.v1'
const CORRUPT_LOCK_GRACE_MS = 60_000
const LOCAL_ENV_PATH = fileURLToPath(new URL('../../.env.local', import.meta.url))
const RECEIPT_CONFIRMATIONS = 2n
const POLL_INTERVAL_MS = 3_000
const MAX_RECEIPT_POLLS = 40
const MAX_FEE_PER_GAS = 500_000_000n
const CANCELLATION_MAX_FEE_PER_GAS = 750_000_000n

// Fresh fork proof: 2,231,244 entry gas and 1,274,219 exit gas after padding.
const ENTRY_GAS = 2_750_000n
const EXIT_GAS = 1_750_000n
const APPROVAL_GAS = 300_000n
const RECOVERY_GAS = 1_000_000n
const RESCUE_GAS = 1_000_000n
const ENTRY_MAX_NETWORK_COST = 1_500_000_000_000_000n
const EXIT_MAX_NETWORK_COST = 1_000_000_000_000_000n
const AUXILIARY_MAX_NETWORK_COST = 500_000_000_000_000n
const CANCELLATION_MAX_NETWORK_COST = 1_000_000_000_000_000n
const MINIMUM_REPLACEMENT_PRIORITY_FEE = 1_000_000n
const MAX_CANCELLATION_ATTEMPTS_PER_NONCE = 8

const market = ARBITRUM_LOOPING_CANARY
// Reviewed burner-canary fixture sizes. They keep the operational proof small
// and are deliberately independent from browser execution policy.
const EQUITY_ASSETS = 1_000_000n
const BORROW_ASSETS = 500_000n
const MINIMUM_EXIT_RETURN = EQUITY_ASSETS * 9_000n / 10_000n
const MINIMUM_ENTRY_COLLATERAL_LOAN_VALUE =
  (EQUITY_ASSETS + BORROW_ASSETS) * 9_000n / 10_000n
const REQUIRED_RESCUE_RESERVE =
  BORROW_ASSETS *
  (10_000n + BigInt(market.launchPolicy.borrowShareBufferBps) +
    BigInt(market.launchPolicy.repayDriftBps) + 300n) /
  10_000n
const REQUIRED_LIFECYCLE_ETH_RESERVE =
  AUXILIARY_MAX_NETWORK_COST +
  ENTRY_MAX_NETWORK_COST +
  EXIT_MAX_NETWORK_COST +
  AUXILIARY_MAX_NETWORK_COST +
  4n * AUXILIARY_MAX_NETWORK_COST

const JOURNAL_KEYS = Object.freeze([
  'authorization',
  'bounds',
  'chainId',
  'marketId',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'operation',
  'owner',
  'priorTransactions',
  'rootTransaction',
  'schema',
  'sourceTransactionHash',
  'transactionHash',
  'walletNonce',
])
const AUTHORIZATION_KEYS = Object.freeze(['deadline', 'startingNonce'])
const BOUNDS_KEYS = Object.freeze([
  'borrowAssets',
  'equityAssets',
  'exactBorrowShares',
  'exactCollateral',
  'maxBorrowShares',
  'minimumCollateral',
  'minimumReturnedAssets',
  'repaymentCapAssets',
])
const OPERATIONS = new Set([
  'approval',
  'entry',
  'exit',
  'permission-recovery',
  'nonce-cancellation',
  'rescue',
])
const BASE_JOURNAL_KEYS = Object.freeze(
  JOURNAL_KEYS.filter((key) =>
    key !== 'priorTransactions' && key !== 'rootTransaction'),
)

function fail(message) {
  throw new Error(message)
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

function sameHex(left, right) {
  return left.toLowerCase() === right.toLowerCase()
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
}

function decimalString(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
}

function nullableDecimalString(value) {
  return value === null || decimalString(value)
}

function emptyBounds() {
  return {
    borrowAssets: null,
    equityAssets: null,
    exactBorrowShares: null,
    exactCollateral: null,
    maxBorrowShares: null,
    minimumCollateral: null,
    minimumReturnedAssets: null,
    repaymentCapAssets: null,
  }
}

function validateBaseRecoveryJournal(value) {
  if (!exactKeys(value, BASE_JOURNAL_KEYS)) {
    fail('Recovery journal transaction metadata has an unknown shape.')
  }
  if (
    value.schema !== JOURNAL_SCHEMA ||
    value.chainId !== ARBITRUM_LOOPING_CHAIN_ID ||
    value.owner !== BURNER_ADDRESS ||
    !sameHex(value.marketId, market.marketId) ||
    !OPERATIONS.has(value.operation) ||
    !Number.isSafeInteger(value.walletNonce) ||
    value.walletNonce < 0 ||
    !HASH_PATTERN.test(value.transactionHash) ||
    !decimalString(value.maxFeePerGas) ||
    !decimalString(value.maxPriorityFeePerGas) ||
    (value.sourceTransactionHash !== null &&
      !HASH_PATTERN.test(value.sourceTransactionHash))
  ) {
    fail('Recovery journal identity or transaction metadata is invalid.')
  }
  if (
    value.authorization !== null &&
    (!exactKeys(value.authorization, AUTHORIZATION_KEYS) ||
      !decimalString(value.authorization.startingNonce) ||
      !decimalString(value.authorization.deadline))
  ) {
    fail('Recovery journal authorization metadata is invalid.')
  }
  if (
    !exactKeys(value.bounds, BOUNDS_KEYS) ||
    !BOUNDS_KEYS.every((key) => nullableDecimalString(value.bounds[key]))
  ) {
    fail('Recovery journal execution bounds are invalid.')
  }
  if (
    value.operation === 'entry' &&
    (value.authorization === null ||
      !decimalString(value.bounds.maxBorrowShares) ||
      !decimalString(value.bounds.minimumCollateral))
  ) {
    fail('Entry recovery journal bounds are incomplete.')
  }
  if (
    value.operation === 'exit' &&
    (value.authorization === null ||
      !decimalString(value.bounds.exactBorrowShares) ||
      !decimalString(value.bounds.exactCollateral) ||
      !decimalString(value.bounds.repaymentCapAssets) ||
      !decimalString(value.bounds.minimumReturnedAssets))
  ) {
    fail('Exit recovery journal bounds are incomplete.')
  }
  if (
    value.operation === 'permission-recovery' &&
    (value.authorization === null || value.sourceTransactionHash === null)
  ) {
    fail('Permission-recovery journal metadata is incomplete.')
  }
  if (
    value.operation === 'nonce-cancellation' &&
    value.sourceTransactionHash === null
  ) {
    fail('Nonce-cancellation journal source is missing.')
  }
  return Object.freeze({
    ...value,
    authorization: value.authorization === null
      ? null
      : Object.freeze({ ...value.authorization }),
    bounds: Object.freeze({ ...value.bounds }),
  })
}

function baseRecoveryJournal(value) {
  return validateBaseRecoveryJournal(Object.fromEntries(
    BASE_JOURNAL_KEYS.map((key) => [key, value[key]]),
  ))
}

export function validateRecoveryJournal(value) {
  if (!exactKeys(value, JOURNAL_KEYS)) fail('Recovery journal has an unknown shape.')
  const base = baseRecoveryJournal(value)
  if (base.operation !== 'nonce-cancellation') {
    if (
      value.rootTransaction !== null ||
      !Array.isArray(value.priorTransactions) ||
      value.priorTransactions.length !== 0
    ) {
      fail('Only a nonce cancellation may retain prior transaction metadata.')
    }
    return Object.freeze({
      ...base,
      rootTransaction: null,
      priorTransactions: Object.freeze([]),
    })
  }
  if (value.rootTransaction === null || !Array.isArray(value.priorTransactions)) {
    fail('Nonce cancellation root transaction metadata is missing.')
  }
  const rootTransaction = validateBaseRecoveryJournal(value.rootTransaction)
  const priorTransactions = value.priorTransactions.map((transaction) =>
    validateBaseRecoveryJournal(transaction))
  if (priorTransactions.length > MAX_CANCELLATION_ATTEMPTS_PER_NONCE) {
    fail('Nonce cancellation replacement history exceeds its fixed safety cap.')
  }
  if (rootTransaction.operation === 'nonce-cancellation') {
    fail('Nonce cancellation root metadata must identify the original operation.')
  }
  if (rootTransaction.authorization !== null && base.authorization === null) {
    fail('Nonce cancellation must burn the original signed authorization nonce.')
  }
  if (
    rootTransaction.authorization !== null &&
    BigInt(base.authorization.startingNonce) <
      BigInt(rootTransaction.authorization.startingNonce)
  ) {
    fail('Nonce cancellation cannot burn an earlier authorization nonce.')
  }
  if (
    rootTransaction.authorization !== null &&
    priorTransactions.some((transaction) =>
      transaction.operation === 'nonce-cancellation' &&
      transaction.authorization === null)
  ) {
    fail('Retained nonce cancellations must bind their nonce-burn authorization.')
  }
  const rootHash = rootTransaction.sourceTransactionHash ??
    rootTransaction.transactionHash
  if (
    base.sourceTransactionHash === null ||
    !sameHex(base.sourceTransactionHash, rootHash)
  ) {
    fail('Nonce cancellation is not bound to its original transaction.')
  }
  if (priorTransactions.some((transaction) =>
    transaction.walletNonce !== base.walletNonce)) {
    fail('Every retained nonce replacement must use the same wallet nonce.')
  }
  const attempts = [...priorTransactions, base]
  const normalizedHashes = attempts.map((transaction) =>
    transaction.transactionHash.toLowerCase())
  if (new Set(normalizedHashes).size !== normalizedHashes.length) {
    fail('Nonce cancellation replacement hashes must be unique.')
  }
  for (let index = 1; index < attempts.length; index += 1) {
    const previous = attempts[index - 1]
    const current = attempts[index]
    if (
      BigInt(current.maxFeePerGas) <= BigInt(previous.maxFeePerGas) ||
      BigInt(current.maxPriorityFeePerGas) <=
        BigInt(previous.maxPriorityFeePerGas)
    ) {
      fail('Every retained nonce replacement must strictly bump both fee caps.')
    }
  }
  return Object.freeze({
    ...base,
    rootTransaction,
    priorTransactions: Object.freeze(priorTransactions),
  })
}

function readJournal() {
  if (!existsSync(JOURNAL_PATH)) return undefined
  const mode = statSync(JOURNAL_PATH).mode & 0o777
  if (mode !== 0o600) fail('Recovery journal permissions must be 0600.')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'))
  } catch {
    fail('Recovery journal is not valid JSON.')
  }
  return validateRecoveryJournal(parsed)
}

function writeJournal(value) {
  const journal = validateRecoveryJournal(value)
  const descriptor = openSync(JOURNAL_TEMP_PATH, 'w', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(journal)}\n`, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  chmodSync(JOURNAL_TEMP_PATH, 0o600)
  renameSync(JOURNAL_TEMP_PATH, JOURNAL_PATH)
  chmodSync(JOURNAL_PATH, 0o600)
}

function clearJournal() {
  if (existsSync(JOURNAL_PATH)) unlinkSync(JOURNAL_PATH)
  if (existsSync(JOURNAL_TEMP_PATH)) unlinkSync(JOURNAL_TEMP_PATH)
}

async function withCanaryLock(task) {
  let descriptor
  try {
    descriptor = openSync(LOCK_PATH, 'wx', 0o600)
  } catch {
    fail('Another live canary process or stale lock is present. Use --clear-stale-lock only after a crash.')
  }
  writeFileSync(descriptor, `${JSON.stringify({
    schema: LOCK_SCHEMA,
    pid: process.pid,
    startedAtMs: Date.now(),
  })}\n`, 'utf8')
  fsyncSync(descriptor)
  try {
    return await task()
  } finally {
    closeSync(descriptor)
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH)
  }
}

function readCanaryLockMetadata() {
  const stat = statSync(LOCK_PATH)
  if ((stat.mode & 0o777) !== 0o600) {
    fail('The live canary lock permissions must be 0600.')
  }
  let value
  try {
    value = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  } catch {
    if (Date.now() - stat.mtimeMs < CORRUPT_LOCK_GRACE_MS) {
      fail('The live canary lock is incomplete and still within its safety grace period.')
    }
    return undefined
  }
  if (
    !exactKeys(value, ['pid', 'schema', 'startedAtMs']) ||
    value.schema !== LOCK_SCHEMA ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isSafeInteger(value.startedAtMs) ||
    value.startedAtMs <= 0 ||
    value.startedAtMs > Date.now()
  ) {
    if (Date.now() - stat.mtimeMs < CORRUPT_LOCK_GRACE_MS) {
      fail('The live canary lock metadata is invalid and still within its safety grace period.')
    }
    return undefined
  }
  return Object.freeze(value)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function clearStaleCanaryLock() {
  if (!existsSync(LOCK_PATH)) {
    emit('LIVE_LOOPING_COMPILER_STALE_LOCK', { status: 'absent' })
    return { status: 'absent' }
  }
  const metadata = readCanaryLockMetadata()
  if (metadata !== undefined && processIsAlive(metadata.pid)) {
    fail(`Live canary process ${metadata.pid} still owns the lock.`)
  }
  unlinkSync(LOCK_PATH)
  const status = metadata === undefined ? 'cleared-corrupt-stale' : 'cleared-dead-process'
  emit('LIVE_LOOPING_COMPILER_STALE_LOCK', { status })
  return { status }
}

function emit(label, payload) {
  const encoded = JSON.stringify(payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value)
  console.log(`${label} ${encoded}`)
}

function recursivelyContainsSensitiveCalldata(value, sensitiveCalldata) {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    return [...sensitiveCalldata].some((candidate) =>
      normalized.includes(candidate.toLowerCase()))
  }
  if (Array.isArray(value)) {
    return value.some((entry) =>
      recursivelyContainsSensitiveCalldata(entry, sensitiveCalldata))
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((entry) =>
      recursivelyContainsSensitiveCalldata(entry, sensitiveCalldata))
  }
  return false
}

export function assertRpcPayloadDoesNotSimulateSensitiveCalldata(
  method,
  params,
  sensitiveCalldata,
) {
  if (
    (method === 'eth_call' || method === 'eth_estimateGas') &&
    recursivelyContainsSensitiveCalldata(params, sensitiveCalldata)
  ) {
    fail(`Refusing ${method} with signed Morpho authorization calldata.`)
  }
}

export function createRequestLimiter(maxConcurrency) {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) {
    fail('RPC request concurrency must be a positive safe integer.')
  }
  let active = 0
  const pending = []
  function drain() {
    while (active < maxConcurrency && pending.length > 0) {
      const item = pending.shift()
      active += 1
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1
          drain()
        })
    }
  }
  return (task) => new Promise((resolveTask, rejectTask) => {
    pending.push({ task, resolve: resolveTask, reject: rejectTask })
    drain()
  })
}

function guardedHttp(url, sensitiveCalldata, maxConcurrency, requestDelayMs = 0) {
  const transport = http(url, { retryCount: 0, timeout: 20_000 })
  return (config) => {
    const base = transport(config)
    const schedule = maxConcurrency === undefined
      ? (task) => task()
      : createRequestLimiter(maxConcurrency)
    return {
      ...base,
      request: (request, options) => schedule(async () => {
        if (requestDelayMs > 0) await sleep(requestDelayMs)
        assertRpcPayloadDoesNotSimulateSensitiveCalldata(
          request.method,
          request.params,
          sensitiveCalldata,
        )
        return base.request(request, options)
      }),
    }
  }
}

function makeClient(
  url,
  sensitiveCalldata = new Set(),
  maxConcurrency,
  requestDelayMs,
) {
  return createPublicClient({
    chain: arbitrum,
    transport: guardedHttp(
      url,
      sensitiveCalldata,
      maxConcurrency,
      requestDelayMs,
    ),
  })
}

function parseLocalEnvironment(contents) {
  const values = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

function resolvePrivateRpcUrl(values) {
  const apiKey = values.OPENPENDLE_1RPC_API_KEY ?? ''
  let rpcUrl = values['1RPC_API_URL_ARBITRUM'] ?? ''
  rpcUrl = rpcUrl
    .replaceAll('${OPENPENDLE_1RPC_API_KEY}', apiKey)
    .replaceAll('$OPENPENDLE_1RPC_API_KEY', apiKey)
  if (rpcUrl.startsWith('1rpc.io/')) rpcUrl = `https://${rpcUrl}`
  let parsed
  try {
    parsed = new URL(rpcUrl)
  } catch {
    fail('1RPC_API_URL_ARBITRUM is missing or invalid.')
  }
  if (
    apiKey.length === 0 ||
    parsed.protocol !== 'https:' ||
    parsed.hostname !== '1rpc.io' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== `/${apiKey}/arb`
  ) {
    fail('The live canary requires the exact private 1RPC Arbitrum endpoint.')
  }
  return parsed.toString()
}

function loadBurnerRuntime() {
  const mode = statSync(LOCAL_ENV_PATH).mode & 0o777
  if (mode !== 0o600) fail('The local secrets file permissions must be 0600.')
  const values = parseLocalEnvironment(readFileSync(LOCAL_ENV_PATH, 'utf8'))
  const privateKey = values.OPENPENDLE_TEST_WALLET_PRIVATE_KEY
  if (!PRIVATE_KEY_PATTERN.test(privateKey ?? '')) {
    fail('OPENPENDLE_TEST_WALLET_PRIVATE_KEY is missing or malformed.')
  }
  const configuredAddress = getAddress(values.OPENPENDLE_TEST_WALLET_ADDRESS ?? '')
  const account = privateKeyToAccount(privateKey)
  if (configuredAddress !== BURNER_ADDRESS || account.address !== BURNER_ADDRESS) {
    fail('The configured key does not match the reviewed Arbitrum burner.')
  }
  const sensitiveCalldata = new Set()
  const privateRpcUrl = resolvePrivateRpcUrl(values)
  const client = makeClient(privateRpcUrl, sensitiveCalldata)
  const privateReadClient = makeClient(privateRpcUrl, sensitiveCalldata, 1, 100)
  const officialReadClient = makeClient(
    PUBLIC_ARBITRUM_READ_FALLBACK,
    sensitiveCalldata,
    1,
    100,
  )
  return Object.freeze({
    account,
    client,
    readClients: Object.freeze([
      officialReadClient,
      privateReadClient,
    ]),
    readFallbackClient: officialReadClient,
    sensitiveCalldata,
  })
}

export async function withRuntimeReadFallback(runtime, task) {
  // The whole task is safe to repeat because every compiler simulation and
  // validation is unsigned. Safety/contract errors remain final; only an
  // explicit transport, capability, or rate-limit failure reaches the next
  // reviewed RPC. guardedHttp still blocks signed authorization calldata.
  let lastError
  for (let index = 0; index < runtime.readClients.length; index += 1) {
    try {
      return {
        value: await task(runtime.readClients[index]),
        fallbackUsed: index > 0,
      }
    } catch (error) {
      lastError = error
      if (
        index === runtime.readClients.length - 1 ||
        !mayUseLoopingWalletReadFallback(error)
      ) {
        throw error
      }
    }
  }
  throw lastError
}

export function parseCanaryMode(argv) {
  const valueFlags = [
    '--round-trip',
    '--exit',
    '--rescue',
    '--live-preflight',
    '--clear-stale-lock',
  ]
  for (const flag of [
    ...valueFlags,
    '--reconcile',
    '--recover-reverted',
    '--cancel-ambiguous',
  ]) {
    if (argv.filter((argument) => argument === flag).length > 1) {
      fail(`Duplicate canary mode flag: ${flag}`)
    }
  }
  const selectedValueFlags = valueFlags.filter((flag) => argv.includes(flag))
  const reconcileIndex = argv.indexOf('--reconcile')
  const recoveryIndex = argv.indexOf('--recover-reverted')
  const cancellationIndex = argv.indexOf('--cancel-ambiguous')
  const compoundModes = [
    ...selectedValueFlags,
    ...(reconcileIndex >= 0 ? ['--reconcile'] : []),
    ...(recoveryIndex >= 0 ? ['--recover-reverted'] : []),
    ...(cancellationIndex >= 0 ? ['--cancel-ambiguous'] : []),
  ]
  if (compoundModes.length > 1) fail('Choose exactly one canary mode.')

  function hashAfter(index, flag) {
    if (index < 0) return undefined
    const value = argv[index + 1]
    if (!HASH_PATTERN.test(value ?? '')) fail(`${flag} requires one transaction hash.`)
    return value
  }

  const reconcileHash = hashAfter(reconcileIndex, '--reconcile')
  const recoveryHash = hashAfter(recoveryIndex, '--recover-reverted')
  const cancellationHash = hashAfter(cancellationIndex, '--cancel-ambiguous')
  const consumed = new Set([
    ...selectedValueFlags,
    ...(reconcileHash === undefined ? [] : ['--reconcile', reconcileHash]),
    ...(recoveryHash === undefined ? [] : ['--recover-reverted', recoveryHash]),
    ...(cancellationHash === undefined
      ? []
      : ['--cancel-ambiguous', cancellationHash]),
  ])
  const unknown = argv.filter((argument) => !consumed.has(argument))
  if (unknown.length > 0) fail(`Unknown argument(s): ${unknown.join(', ')}`)

  if (reconcileHash !== undefined) {
    return Object.freeze({ kind: 'reconcile', hash: reconcileHash })
  }
  if (recoveryHash !== undefined) {
    return Object.freeze({ kind: 'recover-reverted', hash: recoveryHash })
  }
  if (cancellationHash !== undefined) {
    return Object.freeze({ kind: 'cancel-ambiguous', hash: cancellationHash })
  }
  if (selectedValueFlags[0] === '--round-trip') return Object.freeze({ kind: 'round-trip' })
  if (selectedValueFlags[0] === '--exit') return Object.freeze({ kind: 'exit' })
  if (selectedValueFlags[0] === '--rescue') return Object.freeze({ kind: 'rescue' })
  if (selectedValueFlags[0] === '--live-preflight') {
    return Object.freeze({ kind: 'live-preflight' })
  }
  if (selectedValueFlags[0] === '--clear-stale-lock') {
    return Object.freeze({ kind: 'clear-stale-lock' })
  }
  return Object.freeze({ kind: 'read-only' })
}

async function readOverview(client) {
  const [chainId, ethBalance, loanBalance, morphoNonce, position, rescue] =
    await Promise.all([
      client.getChainId(),
      client.getBalance({ address: BURNER_ADDRESS }),
      client.readContract({
        address: market.morphoMarketParams.loanToken,
        abi: loopingErc20Abi,
        functionName: 'balanceOf',
        args: [BURNER_ADDRESS],
      }),
      client.readContract({
        address: market.contracts.morpho,
        abi: morphoBlueAbi,
        functionName: 'nonce',
        args: [BURNER_ADDRESS],
      }),
      readLoopingExecutionPosition({ client, owner: BURNER_ADDRESS, market }),
      prepareDirectLoopingRescue({ client, owner: BURNER_ADDRESS, market }),
    ])
  if (chainId !== ARBITRUM_LOOPING_CHAIN_ID) fail('The canary RPC is not Arbitrum.')
  return Object.freeze({ ethBalance, loanBalance, morphoNonce, position, rescue })
}

async function runReadOnlyMode() {
  let overview
  let rpc = '1rpc'
  try {
    overview = await readOverview(makeClient(LOOPING_1RPC_ARBITRUM_URL))
  } catch {
    rpc = 'arbitrum-public-read-fallback'
    overview = await readOverview(makeClient(PUBLIC_ARBITRUM_READ_FALLBACK))
  }
  const journal = readJournal()
  emit('LIVE_LOOPING_COMPILER_READ_ONLY', {
    owner: BURNER_ADDRESS,
    chainId: ARBITRUM_LOOPING_CHAIN_ID,
    marketId: market.marketId,
    eth: formatEther(overview.ethBalance),
    loanToken: formatUnits(overview.loanBalance, market.loanTokenDecimals),
    morphoNonce: overview.morphoNonce,
    position: overview.position.classification,
    borrowShares: overview.position.borrowShares,
    collateral: overview.position.collateral,
    rescuePhase: overview.rescue.phase,
    unresolvedJournal: journal?.transactionHash ?? null,
    rpc,
  })
  return overview
}

async function receiptOrUndefined(client, hash) {
  try {
    return await client.getTransactionReceipt({ hash })
  } catch {
    return undefined
  }
}

async function twoConfirmedReceiptOrUndefined(client, hash) {
  const receipt = await receiptOrUndefined(client, hash)
  if (receipt === undefined) return undefined
  const head = await client.getBlockNumber()
  if (head + 1n < receipt.blockNumber + RECEIPT_CONFIRMATIONS) {
    fail(`Transaction ${hash} is mined but does not yet have two confirmations.`)
  }
  return receipt
}

async function transactionOrUndefined(client, hash) {
  try {
    return await client.getTransaction({ hash })
  } catch {
    return undefined
  }
}

async function runReconcileMode(hash) {
  let client = makeClient(LOOPING_1RPC_ARBITRUM_URL)
  try {
    await client.getChainId()
  } catch {
    client = makeClient(PUBLIC_ARBITRUM_READ_FALLBACK)
  }
  const [receipt, transaction, position] = await Promise.all([
    receiptOrUndefined(client, hash),
    transactionOrUndefined(client, hash),
    readLoopingExecutionPosition({ client, owner: BURNER_ADDRESS, market }),
  ])
  let authorizationAction = null
  if (receipt?.status === 'reverted' && transaction !== undefined) {
    try {
      const pair = await readExposedLoopingAuthorizationPairFromTransaction({
        client,
        market,
        owner: BURNER_ADDRESS,
        transactionHash: hash,
      })
      const state = await readExposedLoopingAuthorizationRecoveryState({ client, pair })
      authorizationAction = classifyExposedLoopingAuthorization({ pair, state }).action
    } catch {
      authorizationAction = 'not-a-looping-bundle'
    }
  }
  emit('LIVE_LOOPING_COMPILER_RECONCILIATION', {
    hash,
    transactionVisible: transaction !== undefined,
    status: receipt?.status ?? (transaction === undefined ? 'unknown' : 'pending'),
    blockNumber: receipt?.blockNumber ?? null,
    position: position.classification,
    borrowShares: position.borrowShares,
    collateral: position.collateral,
    authorizationAction,
    journalMatches: readJournal()?.transactionHash === hash,
  })
  return { receipt, transaction, position, authorizationAction }
}

async function waitForTwoConfirmations(client, hash) {
  for (let attempt = 0; attempt < MAX_RECEIPT_POLLS; attempt += 1) {
    const receipt = await receiptOrUndefined(client, hash)
    if (receipt !== undefined) {
      const head = await client.getBlockNumber()
      if (head + 1n >= receipt.blockNumber + RECEIPT_CONFIRMATIONS) return receipt
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return undefined
}

class AmbiguousBroadcastError extends Error {
  constructor(hash) {
    super(`Broadcast status is unresolved for ${hash}. Run --reconcile before any retry.`)
    this.name = 'AmbiguousBroadcastError'
    this.hash = hash
  }
}

class ConfirmedRevertError extends Error {
  constructor(hash) {
    super(`The confirmed transaction ${hash} reverted. Do not retry its signed bundle.`)
    this.name = 'ConfirmedRevertError'
    this.hash = hash
  }
}

function makeJournal({
  operation,
  walletNonce,
  transactionHash,
  sourceTransactionHash,
  maxFeePerGas,
  maxPriorityFeePerGas,
  authorization,
  bounds,
  rootTransaction,
  priorTransactions,
}) {
  return validateRecoveryJournal({
    schema: JOURNAL_SCHEMA,
    chainId: ARBITRUM_LOOPING_CHAIN_ID,
    owner: BURNER_ADDRESS,
    marketId: market.marketId,
    operation,
    rootTransaction: rootTransaction ?? null,
    priorTransactions: priorTransactions ?? [],
    walletNonce,
    transactionHash,
    sourceTransactionHash: sourceTransactionHash ??
      (authorization === undefined ? null : transactionHash),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    authorization: authorization === undefined
      ? null
      : {
          startingNonce: authorization.startingNonce.toString(),
          deadline: authorization.deadline.toString(),
        },
    bounds: {
      ...emptyBounds(),
      ...Object.fromEntries(
        Object.entries(bounds ?? {}).map(([key, value]) => [
          key,
          value === null || value === undefined ? null : value.toString(),
        ]),
      ),
    },
  })
}

async function signAndBroadcastOnce({
  runtime,
  intent,
  operation,
  gas,
  maxNetworkCost,
  authorization,
  bounds,
  validUntilMs,
  sourceTransactionHash,
  walletNonceOverride,
  minimumMaxFeePerGas = 0n,
  minimumMaxPriorityFeePerGas = 0n,
  maxFeePerGasCap = MAX_FEE_PER_GAS,
  rootTransaction,
  priorTransactions,
}) {
  if (validUntilMs !== undefined && Date.now() >= validUntilMs) {
    fail('The compiler quote expired before transaction signing.')
  }
  const { account, client } = runtime
  const feeSnapshot = (await withRuntimeReadFallback(runtime, (readClient) =>
    Promise.all([
      readClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      readClient.estimateFeesPerGas({ type: 'eip1559' }),
      readClient.getBalance({ address: account.address }),
    ]))).value
  const [pendingWalletNonce, fees, ethBalance] = feeSnapshot
  const walletNonce = walletNonceOverride ?? pendingWalletNonce
  if (walletNonceOverride !== undefined) {
    const latestWalletNonce = (await withRuntimeReadFallback(
      runtime,
      (readClient) => readClient.getTransactionCount({
        address: account.address,
        blockTag: 'latest',
      }),
    )).value
    if (latestWalletNonce !== walletNonceOverride) {
      fail('The ambiguous wallet nonce has already been consumed. Reconcile first.')
    }
  }
  const quotedMaxFeePerGas = fees.maxFeePerGas
  const quotedMaxPriorityFeePerGas = fees.maxPriorityFeePerGas
  const maxFeePerGas = quotedMaxFeePerGas === undefined
    ? undefined
    : quotedMaxFeePerGas > minimumMaxFeePerGas
      ? quotedMaxFeePerGas
      : minimumMaxFeePerGas
  const maxPriorityFeePerGas = quotedMaxPriorityFeePerGas === undefined
    ? undefined
    : quotedMaxPriorityFeePerGas > minimumMaxPriorityFeePerGas
      ? quotedMaxPriorityFeePerGas
      : minimumMaxPriorityFeePerGas
  if (
    maxFeePerGas === undefined ||
    maxPriorityFeePerGas === undefined ||
    maxFeePerGas < maxPriorityFeePerGas ||
    maxFeePerGas > maxFeePerGasCap
  ) {
    fail('The current Arbitrum EIP-1559 fee quote is outside the canary cap.')
  }
  const maximumCost = gas * maxFeePerGas
  if (maximumCost > maxNetworkCost || ethBalance < maximumCost) {
    fail('The transaction fee bound exceeds the per-step cap or burner balance.')
  }
  if (validUntilMs !== undefined && Date.now() >= validUntilMs) {
    fail('The compiler quote expired before local transaction signing.')
  }

  const serializedTransaction = await account.signTransaction({
    chainId: ARBITRUM_LOOPING_CHAIN_ID,
    type: 'eip1559',
    nonce: walletNonce,
    to: intent.to,
    data: intent.data,
    value: intent.value,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  const expectedHash = keccak256(serializedTransaction)
  writeJournal(makeJournal({
    operation,
    walletNonce,
    transactionHash: expectedHash,
    sourceTransactionHash,
    maxFeePerGas,
    maxPriorityFeePerGas,
    authorization,
    bounds,
    rootTransaction,
    priorTransactions,
  }))
  if (validUntilMs !== undefined && Date.now() >= validUntilMs) {
    // Nothing was published, so the locally held raw transaction and Morpho
    // signatures can be discarded without leaving external recovery work.
    clearJournal()
    fail('The compiler quote expired before raw transaction broadcast.')
  }

  let publishedHash
  try {
    publishedHash = await client.sendRawTransaction({ serializedTransaction })
  } catch {
    const receipt = await waitForTwoConfirmations(
      runtime.readFallbackClient,
      expectedHash,
    )
    if (receipt === undefined) throw new AmbiguousBroadcastError(expectedHash)
    if (receipt.status !== 'success') throw new ConfirmedRevertError(expectedHash)
    return { hash: expectedHash, receipt }
  }
  if (!sameHex(publishedHash, expectedHash)) {
    throw new AmbiguousBroadcastError(expectedHash)
  }
  const receipt = await waitForTwoConfirmations(
    runtime.readFallbackClient,
    expectedHash,
  )
  if (receipt === undefined) throw new AmbiguousBroadcastError(expectedHash)
  if (receipt.status !== 'success') throw new ConfirmedRevertError(expectedHash)
  emit('LIVE_LOOPING_COMPILER_TRANSACTION', {
    operation,
    hash: expectedHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  })
  return { hash: expectedHash, receipt }
}

async function readJournalVerificationState(runtime) {
  return (await withRuntimeReadFallback(runtime, async (readClient) => {
    const block = await readClient.getBlock({ blockTag: 'latest' })
    if (block.number === null || block.hash === null) {
      fail('Journal verification could not pin an Arbitrum block.')
    }
    const [position, morphoNonce, adapterAuthorized, adapterAllowance] =
      await Promise.all([
        readLoopingExecutionPosition({
          client: readClient,
          owner: runtime.account.address,
          market,
          blockNumber: block.number,
        }),
        readClient.readContract({
          address: market.contracts.morpho,
          abi: morphoBlueAbi,
          functionName: 'nonce',
          args: [runtime.account.address],
          blockNumber: block.number,
        }),
        readClient.readContract({
          address: market.contracts.morpho,
          abi: morphoBlueAbi,
          functionName: 'isAuthorized',
          args: [runtime.account.address, market.contracts.generalAdapter1],
          blockNumber: block.number,
        }),
        readClient.readContract({
          address: market.morphoMarketParams.loanToken,
          abi: loopingErc20Abi,
          functionName: 'allowance',
          args: [runtime.account.address, market.contracts.generalAdapter1],
          blockNumber: block.number,
        }),
      ])
    return {
      blockTimestamp: block.timestamp,
      position,
      morphoNonce,
      adapterAuthorized,
      adapterAllowance,
    }
  })).value
}

async function verifyConfirmedJournal(runtime, journal) {
  const state = await readJournalVerificationState(runtime)
  if (state.adapterAuthorized) {
    fail('A confirmed journal transaction left the adapter authorized.')
  }
  const startingNonce = journal.authorization === null
    ? undefined
    : BigInt(journal.authorization.startingNonce)
  const deadline = journal.authorization === null
    ? undefined
    : BigInt(journal.authorization.deadline)
  if (journal.operation === 'entry') {
    if (
      startingNonce === undefined ||
      state.morphoNonce < startingNonce + 2n ||
      state.adapterAllowance !== 0n ||
      state.position.classification !== 'open-loop' ||
      state.position.supplyShares !== 0n ||
      state.position.borrowShares <= 0n ||
      state.position.borrowShares > BigInt(journal.bounds.maxBorrowShares) ||
      state.position.collateral < BigInt(journal.bounds.minimumCollateral)
    ) {
      fail('Confirmed entry journal does not match the bounded live position.')
    }
  } else if (journal.operation === 'exit') {
    if (
      startingNonce === undefined ||
      state.morphoNonce < startingNonce + 2n ||
      state.position.classification !== 'empty'
    ) {
      fail('Confirmed exit journal does not match an empty live position.')
    }
  } else if (journal.operation === 'permission-recovery') {
    if (
      startingNonce === undefined ||
      deadline === undefined ||
      (state.morphoNonce < startingNonce + 2n &&
        state.blockTimestamp <= deadline)
    ) {
      fail('Confirmed permission recovery did not invalidate the exposed pair.')
    }
  } else if (
    journal.operation === 'nonce-cancellation' &&
    startingNonce !== undefined &&
    state.morphoNonce <= startingNonce
  ) {
    fail('Confirmed nonce cancellation did not burn the exposed Morpho nonce.')
  }
  return state
}

async function resolveExistingJournal(runtime, allowedRevertedHash) {
  const journal = readJournal()
  if (journal === undefined) return
  const receipt = await twoConfirmedReceiptOrUndefined(
    runtime.readFallbackClient,
    journal.transactionHash,
  )
  if (receipt === undefined) {
    fail(`Recovery journal ${journal.transactionHash} is unresolved. Run --reconcile first.`)
  }
  if (receipt.status === 'success') {
    const state = await verifyConfirmedJournal(runtime, journal)
    clearJournal()
    return {
      status: journal.operation === 'nonce-cancellation' &&
          state.position.classification === 'empty' &&
          state.adapterAllowance !== 0n
        ? 'confirmed-success-cleanup-required'
        : 'confirmed-success',
      journal,
      state,
    }
  }
  if (receipt.status === 'reverted' && journal.authorization !== null) {
    const sourceHash = journal.sourceTransactionHash ?? journal.transactionHash
    if (journal.operation === 'nonce-cancellation') {
      fail(`Reverted nonce cancellation requires --cancel-ambiguous ${sourceHash}.`)
    }
    if (
      allowedRevertedHash === undefined ||
      !sameHex(allowedRevertedHash, sourceHash)
    ) {
      fail(`Reverted signed bundle ${sourceHash} requires --recover-reverted.`)
    }
    return { status: 'confirmed-revert', journal }
  }
  clearJournal()
  return { status: 'confirmed-revert-no-authorization', journal }
}

async function approveEntryEquity(runtime) {
  const { account } = runtime
  const allowance = (await withRuntimeReadFallback(runtime, (readClient) =>
    readClient.readContract({
    address: market.morphoMarketParams.loanToken,
    abi: loopingErc20Abi,
    functionName: 'allowance',
    args: [account.address, market.contracts.generalAdapter1],
    }))).value
  if (allowance === EQUITY_ASSETS) return
  if (allowance !== 0n) {
    fail('An unexpected adapter allowance exists. Run one --rescue step first.')
  }
  const intent = {
    to: market.morphoMarketParams.loanToken,
    data: encodeFunctionData({
      abi: loopingErc20Abi,
      functionName: 'approve',
      args: [market.contracts.generalAdapter1, EQUITY_ASSETS],
    }),
    value: 0n,
  }
  await signAndBroadcastOnce({
    runtime,
    intent,
    operation: 'approval',
    gas: APPROVAL_GAS,
    maxNetworkCost: AUXILIARY_MAX_NETWORK_COST,
  })
  const refreshed = (await withRuntimeReadFallback(runtime, (readClient) =>
    readClient.readContract({
    address: market.morphoMarketParams.loanToken,
    abi: loopingErc20Abi,
    functionName: 'allowance',
    args: [account.address, market.contracts.generalAdapter1],
    }))).value
  if (refreshed !== EQUITY_ASSETS) fail('Exact entry approval postcondition failed.')
  clearJournal()
}

async function signAuthorizationPair(account, requests) {
  return Promise.all(requests.map((request) => account.sign({ hash: request.digest })))
}

function registerSensitiveBundleCalldata(sensitiveCalldata, bundle) {
  sensitiveCalldata.add(bundle.data)
  sensitiveCalldata.add(bundle.calls[0].data)
  sensitiveCalldata.add(bundle.calls.at(-1).data)
}

async function executeEntry(runtime) {
  const { account, sensitiveCalldata } = runtime
  const preflight = await withRuntimeReadFallback(runtime, async (readClient) => {
    const preview = await prepareLoopingEntryExecution({
      client: readClient,
      owner: account.address,
      market,
      equityAssets: EQUITY_ASSETS,
      borrowAssets: BORROW_ASSETS,
    })
    await simulateUnsignedLoopingIntent({
      client: readClient,
      intent: buildUnsignedLoopingEntrySimulation(preview),
    })
    return preview
  })
  const preview = preflight.value
  if (
    preview.health.liquidationBufferBps <
      BigInt(market.launchPolicy.minLiquidationBufferBps)
  ) {
    fail('The fresh entry is below the live beta liquidation buffer.')
  }
  if (preview.health.collateralLoanValue < MINIMUM_ENTRY_COLLATERAL_LOAN_VALUE) {
    fail('The fresh entry route loses more than the canary economic bound.')
  }
  const [authorizeSignature, revokeSignature] = await signAuthorizationPair(
    account,
    preview.authorizationRequests,
  )
  const bundle = await buildSignedLoopingEntryBundle(
    preview,
    authorizeSignature,
    revokeSignature,
  )
  registerSensitiveBundleCalldata(sensitiveCalldata, bundle)
  const finalValidation = await withRuntimeReadFallback(
    runtime,
    async (readClient) => {
      const simulation = await simulateUnsignedLoopingIntent({
        client: readClient,
        intent: buildUnsignedLoopingEntrySimulation(preview),
      })
      return revalidateSignedLoopingEntry({
        client: readClient,
        preview,
        bundle,
        simulation,
      })
    },
  )
  const readiness = finalValidation.value
  const sent = await signAndBroadcastOnce({
    runtime,
    intent: bundle,
    operation: 'entry',
    gas: ENTRY_GAS,
    maxNetworkCost: ENTRY_MAX_NETWORK_COST,
    validUntilMs: bundle.validUntilMs,
    authorization: {
      startingNonce: bundle.startingNonce,
      deadline: bundle.deadline,
    },
    bounds: {
      equityAssets: preview.equityAssets,
      borrowAssets: preview.borrowAssets,
      maxBorrowShares: bundle.maxBorrowShares,
      minimumCollateral: bundle.minimumCollateral,
    },
  })
  const verified = (await withRuntimeReadFallback(runtime, (readClient) =>
    verifyLoopingEntryReceiptState({
      client: readClient,
      preview,
      bundle,
      readiness,
      transactionHash: sent.hash,
    }))).value
  clearJournal()
  return { ...sent, verified }
}

async function executeExit(runtime) {
  const { account, sensitiveCalldata } = runtime
  const preflight = await withRuntimeReadFallback(runtime, async (readClient) => {
    const preview = await prepareLoopingExitExecution({
      client: readClient,
      owner: account.address,
      market,
      minimumReturnedAssets: MINIMUM_EXIT_RETURN,
    })
    await simulateUnsignedLoopingIntent({
      client: readClient,
      intent: buildUnsignedLoopingExitSimulation(preview),
    })
    return preview
  })
  const preview = preflight.value
  const [authorizeSignature, revokeSignature] = await signAuthorizationPair(
    account,
    preview.authorizationRequests,
  )
  const bundle = await buildSignedLoopingExitBundle(
    preview,
    authorizeSignature,
    revokeSignature,
  )
  registerSensitiveBundleCalldata(sensitiveCalldata, bundle)
  const finalValidation = await withRuntimeReadFallback(
    runtime,
    async (readClient) => {
      const simulation = await simulateUnsignedLoopingIntent({
        client: readClient,
        intent: buildUnsignedLoopingExitSimulation(preview),
      })
      return revalidateSignedLoopingExit({
        client: readClient,
        preview,
        bundle,
        simulation,
      })
    },
  )
  const readiness = finalValidation.value
  const sent = await signAndBroadcastOnce({
    runtime,
    intent: bundle,
    operation: 'exit',
    gas: EXIT_GAS,
    maxNetworkCost: EXIT_MAX_NETWORK_COST,
    validUntilMs: bundle.validUntilMs,
    authorization: {
      startingNonce: bundle.startingNonce,
      deadline: bundle.deadline,
    },
    bounds: {
      exactBorrowShares: bundle.exactBorrowShares,
      exactCollateral: bundle.exactCollateral,
      repaymentCapAssets: bundle.repaymentCapAssets,
      minimumReturnedAssets: bundle.minimumReturnedAssets,
    },
  })
  const verified = (await withRuntimeReadFallback(runtime, (readClient) =>
    verifyLoopingExitReceiptState({
      client: readClient,
      preview,
      bundle,
      readiness,
      transactionHash: sent.hash,
    }))).value
  clearJournal()
  return { ...sent, verified }
}

async function waitForBlockAfter(client, blockNumber) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const head = await client.getBlockNumber()
    if (head > blockNumber) return head
    await sleep(POLL_INTERVAL_MS)
  }
  fail('No later Arbitrum block arrived before the exit preflight.')
}

async function runRoundTripMode(runtime) {
  const resolved = await resolveExistingJournal(runtime)
  if (resolved?.status === 'confirmed-success-cleanup-required') {
    fail('A confirmed cancellation needs one --rescue allowance-cleanup step.')
  }
  if (
    resolved?.status === 'confirmed-success' &&
    resolved.journal.operation === 'exit'
  ) {
    emit('LIVE_LOOPING_COMPILER_ROUND_TRIP_ALREADY_CLOSED', {
      exitHash: resolved.journal.transactionHash,
      finalPosition: resolved.state.position.classification,
    })
    return { recoveredExit: resolved.journal.transactionHash }
  }
  const before = (await withRuntimeReadFallback(
    runtime,
    (readClient) => readOverview(readClient),
  )).value
  if (before.position.classification !== 'empty') {
    fail('The burner already has a Morpho position. Use --exit or --rescue.')
  }
  if (before.loanBalance < EQUITY_ASSETS + REQUIRED_RESCUE_RESERVE) {
    fail('The burner lacks the retained USDC reserve required for direct rescue.')
  }
  if (before.ethBalance < REQUIRED_LIFECYCLE_ETH_RESERVE) {
    fail(
      'The burner lacks the capped ETH reserve for approval, entry, a failed exit, permission cleanup, and four rescue steps.',
    )
  }
  const [latestWalletNonce, pendingWalletNonce] = (await withRuntimeReadFallback(
    runtime,
    (readClient) => Promise.all([
      readClient.getTransactionCount({
        address: runtime.account.address,
        blockTag: 'latest',
      }),
      readClient.getTransactionCount({
        address: runtime.account.address,
        blockTag: 'pending',
      }),
    ]),
  )).value
  if (latestWalletNonce !== pendingWalletNonce) {
    fail('The burner has a pre-existing pending transaction.')
  }
  await approveEntryEquity(runtime)
  const entry = await executeEntry(runtime)
  await waitForBlockAfter(runtime.readFallbackClient, entry.receipt.blockNumber)
  const rescuePlan = (await withRuntimeReadFallback(runtime, (readClient) =>
    prepareDirectLoopingRescue({
      client: readClient,
      owner: runtime.account.address,
      market,
    }))).value
  if (rescuePlan.phase !== 'approve-exact-repayment') {
    fail('The freshly opened position does not have the expected direct-rescue path.')
  }
  const exit = await executeExit(runtime)
  const after = (await withRuntimeReadFallback(
    runtime,
    (readClient) => readOverview(readClient),
  )).value
  if (after.position.classification !== 'empty' || after.rescue.phase !== 'complete') {
    fail('The full-exit postcondition is not clean.')
  }
  const maximumCanaryLoss = EQUITY_ASSETS - MINIMUM_EXIT_RETURN
  if (after.loanBalance + maximumCanaryLoss < before.loanBalance) {
    fail('The round trip lost more loan token than the canary economic bound.')
  }
  emit('LIVE_LOOPING_COMPILER_ROUND_TRIP_COMPLETE', {
    entryHash: entry.hash,
    exitHash: exit.hash,
    entryBlock: entry.receipt.blockNumber,
    exitBlock: exit.receipt.blockNumber,
    finalLoanToken: formatUnits(after.loanBalance, market.loanTokenDecimals),
    finalPosition: after.position.classification,
  })
  return { entry, exit, after }
}

async function runExitMode(runtime) {
  const resolved = await resolveExistingJournal(runtime)
  if (resolved?.status === 'confirmed-success-cleanup-required') {
    fail('A confirmed cancellation needs one --rescue allowance-cleanup step.')
  }
  const position = (await withRuntimeReadFallback(runtime, (readClient) =>
    readLoopingExecutionPosition({
      client: readClient,
      owner: runtime.account.address,
      market,
    }))).value
  if (position.classification !== 'open-loop') fail('No exact canary loop is open.')
  const exit = await executeExit(runtime)
  emit('LIVE_LOOPING_COMPILER_EXIT_COMPLETE', {
    hash: exit.hash,
    blockNumber: exit.receipt.blockNumber,
    finalPosition: exit.verified.position.classification,
  })
  return exit
}

async function runLivePreflightMode(runtime) {
  const privateRpcChainId = await runtime.client.getChainId()
  if (privateRpcChainId !== ARBITRUM_LOOPING_CHAIN_ID) {
    fail('The configured private 1RPC endpoint is not Arbitrum.')
  }
  const resolved = await resolveExistingJournal(runtime)
  if (resolved?.status === 'confirmed-success-cleanup-required') {
    fail('Live preflight requires one --rescue allowance-cleanup step first.')
  }
  const overviewResult = await withRuntimeReadFallback(
    runtime,
    (readClient) => readOverview(readClient),
  )
  const overview = overviewResult.value
  if (overview.position.classification !== 'empty') {
    fail('Live entry preflight requires an empty canary position.')
  }
  if (overview.ethBalance < REQUIRED_LIFECYCLE_ETH_RESERVE) {
    fail('Live preflight lacks the capped ETH lifecycle reserve.')
  }
  if (overview.loanBalance < EQUITY_ASSETS + REQUIRED_RESCUE_RESERVE) {
    fail('Live preflight lacks the retained direct-rescue loan-token reserve.')
  }
  const [latestWalletNonce, pendingWalletNonce] = (await withRuntimeReadFallback(
    runtime,
    (readClient) => Promise.all([
      readClient.getTransactionCount({
        address: runtime.account.address,
        blockTag: 'latest',
      }),
      readClient.getTransactionCount({
        address: runtime.account.address,
        blockTag: 'pending',
      }),
    ]),
  )).value
  if (latestWalletNonce !== pendingWalletNonce) {
    fail('Live preflight found a pending burner transaction.')
  }
  const previewResult = await withRuntimeReadFallback(runtime, (readClient) =>
    prepareLoopingEntryExecution({
      client: readClient,
      owner: runtime.account.address,
      market,
      equityAssets: EQUITY_ASSETS,
      borrowAssets: BORROW_ASSETS,
    }))
  const preview = previewResult.value
  const authorizationLifetime =
    preview.authorizationRequests[0].message.deadline - preview.wiring.blockTimestamp
  if (authorizationLifetime !== market.launchPolicy.authorizationLifetimeSeconds) {
    fail('Live preflight authorization lifetime differs from production policy.')
  }
  if (preview.health.collateralLoanValue < MINIMUM_ENTRY_COLLATERAL_LOAN_VALUE) {
    fail('Live preflight entry route is below the canary economic floor.')
  }
  emit('LIVE_LOOPING_COMPILER_PREFLIGHT', {
    owner: runtime.account.address,
    chainId: market.chainId,
    marketId: market.marketId,
    position: overview.position.classification,
    eth: formatEther(overview.ethBalance),
    loanToken: formatUnits(overview.loanBalance, market.loanTokenDecimals),
    equityAssets: preview.equityAssets,
    borrowAssets: preview.borrowAssets,
    minimumCollateral: preview.quotes.minimumCollateral,
    liquidationBufferBps: preview.health.liquidationBufferBps,
    collateralLoanValue: preview.health.collateralLoanValue,
    approvalNeeded: preview.approval.needed,
    currentAdapterAllowance: preview.approval.current,
    authorizationLifetime,
    validUntilMs: preview.validUntilMs,
    signaturesCreated: false,
    transactionCreated: false,
    primaryRpcFallbackUsed:
      overviewResult.fallbackUsed || previewResult.fallbackUsed,
    unsignedSimulation: preview.approval.needed
      ? 'requires-exact-approval'
      : 'not-run-by-read-only-preflight',
  })
  return { overview, preview }
}

async function runRecoverRevertedMode(runtime, hash) {
  await resolveExistingJournal(runtime, hash)
  const receipt = await twoConfirmedReceiptOrUndefined(
    runtime.readFallbackClient,
    hash,
  )
  if (receipt?.status !== 'reverted') {
    fail('Authorization recovery requires a confirmed-reverted looping transaction.')
  }
  const pair = (await withRuntimeReadFallback(runtime, (readClient) =>
    readExposedLoopingAuthorizationPairFromTransaction({
      client: readClient,
      market,
      owner: runtime.account.address,
      transactionHash: hash,
    }))).value
  const state = (await withRuntimeReadFallback(runtime, (readClient) =>
    readExposedLoopingAuthorizationRecoveryState({
      client: readClient,
      pair,
    }))).value
  const classification = classifyExposedLoopingAuthorization({ pair, state })
  const intent = buildLoopingAuthorizationRecoveryIntent({ pair, classification })
  if (intent === undefined) {
    clearJournal()
    emit('LIVE_LOOPING_COMPILER_PERMISSION_RECOVERY', {
      sourceHash: hash,
      action: 'none',
      reason: classification.reason,
    })
    return classification
  }
  runtime.sensitiveCalldata.add(intent.data)
  for (const call of intent.calls ?? []) runtime.sensitiveCalldata.add(call.data)
  const sent = await signAndBroadcastOnce({
    runtime,
    intent,
    operation: 'permission-recovery',
    gas: RECOVERY_GAS,
    maxNetworkCost: AUXILIARY_MAX_NETWORK_COST,
    sourceTransactionHash: hash,
    authorization: {
      startingNonce: pair.startingNonce,
      deadline: pair.deadline,
    },
  })
  const finalState = (await withRuntimeReadFallback(runtime, (readClient) =>
    readExposedLoopingAuthorizationRecoveryState({
      client: readClient,
      pair,
    }))).value
  const finalClassification = classifyExposedLoopingAuthorization({
    pair,
    state: finalState,
  })
  if (finalState.adapterAuthorized || finalClassification.action !== 'none') {
    fail('The recovery transaction did not invalidate the exposed authorization pair.')
  }
  clearJournal()
  emit('LIVE_LOOPING_COMPILER_PERMISSION_RECOVERY', {
    sourceHash: hash,
    recoveryHash: sent.hash,
    action: classification.action,
    finalAction: finalClassification.action,
  })
  return finalClassification
}

export function replacementFeeFloors(journal) {
  const previousMaxFeePerGas = BigInt(journal.maxFeePerGas)
  const previousPriorityFeePerGas = BigInt(journal.maxPriorityFeePerGas)
  const minimumMaxPriorityFeePerGas = previousPriorityFeePerGas === 0n
    ? MINIMUM_REPLACEMENT_PRIORITY_FEE
    : previousPriorityFeePerGas * 12n / 10n + 1n
  const bumpedMaxFeePerGas = previousMaxFeePerGas * 12n / 10n + 1n
  return Object.freeze({
    minimumMaxFeePerGas: bumpedMaxFeePerGas > minimumMaxPriorityFeePerGas
      ? bumpedMaxFeePerGas
      : minimumMaxPriorityFeePerGas,
    minimumMaxPriorityFeePerGas,
  })
}

async function finalizeConfirmedCancellation({
  runtime,
  sourceHash,
  cancellationHash,
  winnerTransaction,
  status,
}) {
  const state = await verifyConfirmedJournal(runtime, winnerTransaction)
  if (
    state.position.classification === 'empty' &&
    state.adapterAllowance !== 0n
  ) {
    const plan = (await withRuntimeReadFallback(runtime, (readClient) =>
      prepareDirectLoopingRescue({
        client: readClient,
        owner: runtime.account.address,
        market,
      }))).value
    if (
      plan.phase !== 'clear-adapter-allowance' ||
      plan.intents.length !== 1 ||
      plan.intents[0].step !== plan.phase
    ) {
      fail('A confirmed cancellation left an unexpected adapter allowance state.')
    }
    const cleanup = await signAndBroadcastOnce({
      runtime,
      intent: plan.intents[0],
      operation: 'rescue',
      gas: RESCUE_GAS,
      maxNetworkCost: AUXILIARY_MAX_NETWORK_COST,
    })
    const refreshed = (await withRuntimeReadFallback(runtime, (readClient) =>
      prepareDirectLoopingRescue({
        client: readClient,
        owner: runtime.account.address,
        market,
      }))).value
    if (refreshed.phase !== 'complete') {
      fail('Cancellation allowance cleanup did not reach a clean empty state.')
    }
    clearJournal()
    emit('LIVE_LOOPING_COMPILER_CANCELLATION_ALLOWANCE_CLEANUP', {
      sourceHash,
      cleanupHash: cleanup.hash,
    })
  } else {
    clearJournal()
  }
  emit('LIVE_LOOPING_COMPILER_AMBIGUITY_CANCELLED', {
    sourceHash,
    cancellationHash,
    winningHash: winnerTransaction.transactionHash,
    status,
  })
}

async function runCancelAmbiguousMode(runtime, hash) {
  const journal = readJournal()
  if (journal === undefined) fail('No unresolved recovery journal exists.')
  const sourceHash = journal.sourceTransactionHash ?? journal.transactionHash
  if (!sameHex(hash, sourceHash)) {
    fail(`Ambiguous cancellation must reference source transaction ${sourceHash}.`)
  }
  const rootTransaction = journal.operation === 'nonce-cancellation'
    ? journal.rootTransaction
    : baseRecoveryJournal(journal)
  if (rootTransaction === null) {
    fail('Ambiguous cancellation is missing its original transaction metadata.')
  }
  const priorTransactions = journal.operation === 'nonce-cancellation'
    ? journal.priorTransactions
    : []
  const currentTransaction = baseRecoveryJournal(journal)
  const currentGeneration = [...priorTransactions, currentTransaction]
  const receiptRecords = [rootTransaction, ...currentGeneration].filter(
    (transaction, index, transactions) =>
      transactions.findIndex((candidate) =>
        sameHex(candidate.transactionHash, transaction.transactionHash)) === index,
  )
  const head = await runtime.readFallbackClient.getBlockNumber()
  const receiptResults = await Promise.all(receiptRecords.map(async (transaction) => {
    const receipt = await receiptOrUndefined(
      runtime.readFallbackClient,
      transaction.transactionHash,
    )
    const confirmed = receipt !== undefined &&
      head + 1n >= receipt.blockNumber + RECEIPT_CONFIRMATIONS
    return { transaction, receipt, confirmed }
  }))
  if (receiptResults.some((result) =>
    result.receipt !== undefined && !result.confirmed)) {
    fail('A cancellation candidate is mined but does not yet have two confirmations.')
  }
  const generationResults = currentGeneration.map((transaction) => {
    const result = receiptResults.find((candidate) =>
      sameHex(candidate.transaction.transactionHash, transaction.transactionHash))
    if (result === undefined) fail('Cancellation receipt history is incomplete.')
    return result
  })
  const confirmedWinners = generationResults.filter((result) => result.confirmed)
  if (confirmedWinners.length > 1) {
    fail('More than one same-nonce cancellation candidate appears mined.')
  }
  const winner = confirmedWinners[0]
  if (winner?.receipt?.status === 'success') {
    await finalizeConfirmedCancellation({
      runtime,
      sourceHash,
      cancellationHash: journal.transactionHash,
      status: winner.transaction.operation === 'nonce-cancellation'
        ? 'cancellation-confirmed'
        : 'source-operation-confirmed',
      winnerTransaction: winner.transaction,
    })
    return
  }
  if (winner?.receipt?.status === 'reverted') {
    if (
      sameHex(
        winner.transaction.transactionHash,
        rootTransaction.transactionHash,
      ) &&
      rootTransaction.authorization !== null
    ) {
      writeJournal({
        ...rootTransaction,
        rootTransaction: null,
        priorTransactions: [],
      })
      fail(
        `The original signed operation reverted. Use --recover-reverted ${sourceHash}.`,
      )
    }
    if (rootTransaction.authorization === null) {
      clearJournal()
      emit('LIVE_LOOPING_COMPILER_AMBIGUITY_CANCELLED', {
        sourceHash,
        cancellationHash: journal.transactionHash,
        winningHash: winner.transaction.transactionHash,
        status: 'confirmed-revert-without-authorization',
      })
      return
    }
  }

  const latestWalletNonce = await runtime.readFallbackClient.getTransactionCount({
    address: runtime.account.address,
    blockTag: 'latest',
  })
  const replacingPendingTransaction = winner === undefined
  if (
    winner?.receipt?.status === 'reverted' &&
    latestWalletNonce <= journal.walletNonce
  ) {
    fail('A confirmed revert did not advance the wallet nonce as expected.')
  }
  if (replacingPendingTransaction && latestWalletNonce > journal.walletNonce) {
    fail(
      'The wallet nonce advanced but no retained cancellation candidate has a confirmed receipt.',
    )
  }
  if (replacingPendingTransaction && latestWalletNonce < journal.walletNonce) {
    fail('The recovery journal wallet nonce is ahead of the chain nonce.')
  }
  const nextPriorTransactions = replacingPendingTransaction
    ? [...priorTransactions, currentTransaction]
    : []
  if (
    nextPriorTransactions.length > MAX_CANCELLATION_ATTEMPTS_PER_NONCE
  ) {
    fail('The same-nonce cancellation attempt cap has been reached.')
  }

  let intent = {
    to: runtime.account.address,
    data: '0x',
    value: 0n,
  }
  let authorization
  if (journal.authorization !== null) {
    const burnPreview = (await withRuntimeReadFallback(runtime, (readClient) =>
      prepareLoopingAuthorizationNonceBurn({
        client: readClient,
        owner: runtime.account.address,
        market,
      }))).value
    const burnSignature = await runtime.account.sign({
      hash: burnPreview.request.digest,
    })
    intent = (await withRuntimeReadFallback(runtime, (readClient) =>
      buildLoopingAuthorizationNonceBurnIntent({
        client: readClient,
        preview: burnPreview,
        signature: burnSignature,
      }))).value
    runtime.sensitiveCalldata.add(intent.data)
    authorization = {
      startingNonce: intent.startingNonce,
      deadline: intent.deadline,
    }
  }

  if (replacingPendingTransaction && latestWalletNonce !== journal.walletNonce) {
    fail('The ambiguous wallet nonce cannot be replaced safely.')
  }
  const replacementFees = replacingPendingTransaction
    ? replacementFeeFloors(journal)
    : {
        minimumMaxFeePerGas: 0n,
        minimumMaxPriorityFeePerGas: 0n,
      }
  const sent = await signAndBroadcastOnce({
    runtime,
    intent,
    operation: 'nonce-cancellation',
    gas: RECOVERY_GAS,
    maxNetworkCost: CANCELLATION_MAX_NETWORK_COST,
    sourceTransactionHash: sourceHash,
    walletNonceOverride: replacingPendingTransaction
      ? journal.walletNonce
      : undefined,
    minimumMaxFeePerGas: replacementFees.minimumMaxFeePerGas,
    minimumMaxPriorityFeePerGas: replacementFees.minimumMaxPriorityFeePerGas,
    maxFeePerGasCap: CANCELLATION_MAX_FEE_PER_GAS,
    authorization,
    rootTransaction,
    priorTransactions: nextPriorTransactions,
  })
  const confirmedJournal = readJournal()
  if (
    confirmedJournal === undefined ||
    !sameHex(confirmedJournal.transactionHash, sent.hash)
  ) {
    fail('The confirmed cancellation journal is missing or mismatched.')
  }
  await finalizeConfirmedCancellation({
    runtime,
    sourceHash,
    cancellationHash: sent.hash,
    status: 'confirmed',
    winnerTransaction: confirmedJournal,
  })
}

async function runRescueMode(runtime) {
  await resolveExistingJournal(runtime)
  const plan = (await withRuntimeReadFallback(runtime, (readClient) =>
    prepareDirectLoopingRescue({
      client: readClient,
      owner: runtime.account.address,
      market,
    }))).value
  if (plan.phase === 'complete') {
    clearJournal()
    emit('LIVE_LOOPING_COMPILER_RESCUE', { phase: 'complete', transactionHash: null })
    return plan
  }
  if (plan.intents.length !== 1 || plan.intents[0].step !== plan.phase) {
    fail('The direct-rescue compiler did not return one phase-matched step.')
  }
  const intent = plan.intents[0]
  const sent = await signAndBroadcastOnce({
    runtime,
    intent,
    operation: 'rescue',
    gas: RESCUE_GAS,
    maxNetworkCost: AUXILIARY_MAX_NETWORK_COST,
    bounds: {
      exactBorrowShares: plan.position.borrowShares,
      exactCollateral: plan.position.collateral,
      repaymentCapAssets: plan.bounds?.repaymentCapAssets,
    },
  })
  clearJournal()
  const next = (await withRuntimeReadFallback(runtime, (readClient) =>
    prepareDirectLoopingRescue({
      client: readClient,
      owner: runtime.account.address,
      market,
    }))).value
  emit('LIVE_LOOPING_COMPILER_RESCUE', {
    completedPhase: plan.phase,
    transactionHash: sent.hash,
    nextPhase: next.phase,
  })
  return next
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  loadBurnerRuntime,
  readOnly: runReadOnlyMode,
  reconcile: runReconcileMode,
  roundTrip: runRoundTripMode,
  exit: runExitMode,
  livePreflight: runLivePreflightMode,
  recoverReverted: runRecoverRevertedMode,
  cancelAmbiguous: runCancelAmbiguousMode,
  rescue: runRescueMode,
  clearStaleLock: clearStaleCanaryLock,
  withLock: withCanaryLock,
})

export async function runCanary({
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = DEFAULT_DEPENDENCIES,
} = {}) {
  const mode = parseCanaryMode(argv)
  if (mode.kind === 'read-only') return dependencies.readOnly()
  if (mode.kind === 'reconcile') return dependencies.reconcile(mode.hash)
  if (mode.kind === 'clear-stale-lock') return dependencies.clearStaleLock()
  if (env.OPENPENDLE_LIVE_E2E !== LIVE_CANARY_ACKNOWLEDGEMENT) {
    fail(
      `Set OPENPENDLE_LIVE_E2E=${LIVE_CANARY_ACKNOWLEDGEMENT} for ${mode.kind}.`,
    )
  }
  const runtime = dependencies.loadBurnerRuntime()
  return dependencies.withLock(async () => {
    if (mode.kind === 'round-trip') return dependencies.roundTrip(runtime)
    if (mode.kind === 'exit') return dependencies.exit(runtime)
    if (mode.kind === 'live-preflight') return dependencies.livePreflight(runtime)
    if (mode.kind === 'recover-reverted') {
      return dependencies.recoverReverted(runtime, mode.hash)
    }
    if (mode.kind === 'cancel-ambiguous') {
      return dependencies.cancelAmbiguous(runtime, mode.hash)
    }
    return dependencies.rescue(runtime)
  })
}

function sanitizedMessage(error) {
  const messages = []
  const seen = new Set()
  let cursor = error
  while (
    cursor !== null &&
    typeof cursor === 'object' &&
    !seen.has(cursor) &&
    messages.length < 8
  ) {
    seen.add(cursor)
    const name = typeof cursor.name === 'string' ? cursor.name : 'Error'
    const code = cursor.code === undefined ? '' : ` [${String(cursor.code)}]`
    const message = typeof cursor.message === 'string'
      ? cursor.message
      : 'Unknown canary failure.'
    messages.push(`${name}${code}: ${message}`)
    cursor = cursor.cause
  }
  if (messages.length === 0) messages.push('Unknown canary failure.')
  return messages.join(' <- caused by: ')
    .replace(/https?:\/\/[^\s)]+/giu, '[RPC endpoint]')
    .replace(/0x[0-9a-f]{128,}/giu, '[hex payload]')
}

const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    await runCanary()
  } catch (error) {
    console.error(`LIVE_LOOPING_COMPILER_STOPPED ${sanitizedMessage(error)}`)
    process.exitCode = 1
  }
}
