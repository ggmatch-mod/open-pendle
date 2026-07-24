#!/usr/bin/env node

/**
 * Execute the production TypeScript looping compiler against a local Anvil
 * fork. The source RPC is read-only: every state-changing request is guarded
 * to the loopback Anvil endpoint.
 */

import { spawn } from 'node:child_process'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbiParameters,
  toHex,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, mainnet, monad } from 'viem/chains'
import { loopingErc20Abi } from '../src/lib/loopingAbi.ts'
import {
  buildSignedLoopingDecreaseBundle,
  buildSignedLoopingEntryBundle,
  buildSignedLoopingExitBundle,
  buildSignedLoopingIncreaseBundle,
  buildUnsignedLoopingDecreaseSimulation,
  buildUnsignedLoopingEntrySimulation,
  buildUnsignedLoopingExitSimulation,
  buildUnsignedLoopingIncreaseSimulation,
  LoopingExecutionError,
  prepareDirectLoopingRescue,
  prepareLoopingDecreaseExecution,
  prepareLoopingEntryExecution,
  prepareLoopingExitExecution,
  prepareLoopingIncreaseExecution,
  revalidateSignedLoopingDecrease,
  revalidateSignedLoopingEntry,
  revalidateSignedLoopingExit,
  revalidateSignedLoopingIncrease,
  simulateUnsignedLoopingIntent,
  verifyLoopingDecreaseReceiptState,
  verifyLoopingEntryReceiptState,
  verifyLoopingExitReceiptState,
  verifyLoopingIncreaseReceiptState,
} from '../src/lib/loopingExecution.ts'
import {
  ARBITRUM_LOOPING_CANARY,
  ARBITRUM_LOOPING_CHAIN_ID,
  ETHEREUM_LOOPING_CHAIN_ID,
  ETHEREUM_LOOPING_REUSD,
  MONAD_LOOPING_AUSD,
  MONAD_LOOPING_CHAIN_ID,
} from '../src/lib/loopingRegistry.ts'

const TEST_PRIVATE_KEY =
  '0x00000000000000000000000000000000000000000000000000000000000a11ce'
const DEFAULT_ANVIL_PORT = 18_545
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const mappingSlotParameters = parseAbiParameters('address owner, uint256 slot')
const LOCAL_GAS_MARGIN_BPS = 3_000n
const LOCAL_GAS_FIXED_MARGIN = 100_000n
const BPS = 10_000n
const WAD = 10n ** 18n
const ORACLE_PRICE_SCALE = 10n ** 36n
const MORPHO_VIRTUAL_ASSETS = 1n
const MORPHO_VIRTUAL_SHARES = 1_000_000n
const INCREASE_STEP_WAD = WAD / 5n
const PENDLE_PREPARE_RETRY_DELAYS_MS = Object.freeze([
  5_000,
  15_000,
  45_000,
])

const COMPILER_FORK_TARGETS = Object.freeze({
  [ETHEREUM_LOOPING_CHAIN_ID]: Object.freeze({
    name: 'Ethereum',
    chain: mainnet,
    market: ETHEREUM_LOOPING_REUSD,
    hardfork: 'osaka',
  }),
  [MONAD_LOOPING_CHAIN_ID]: Object.freeze({
    name: 'Monad',
    chain: monad,
    market: MONAD_LOOPING_AUSD,
    hardfork: 'osaka',
  }),
  [ARBITRUM_LOOPING_CHAIN_ID]: Object.freeze({
    name: 'Arbitrum',
    chain: arbitrum,
    market: ARBITRUM_LOOPING_CANARY,
    hardfork: 'osaka',
  }),
})

function fail(message) {
  throw new Error(message)
}

function isRetryablePendleQuoteHttpError(error) {
  if (!(error instanceof LoopingExecutionError)) return false
  const retryableQuoteFailure =
    /^Pendle quote returned HTTP (?:429|5\d\d)(?:[.:]|$)/
  if (error.code === 'INVALID_QUOTE') {
    return retryableQuoteFailure.test(error.message)
  }
  if (error.code !== 'ROUTE_NOT_ALLOWED') return false

  const combinedFailurePrefix =
    'Pendle returned no strictly valid mint route: '
  if (!error.message.startsWith(combinedFailurePrefix)) return false
  const failures = error.message
    .slice(combinedFailurePrefix.length)
    .split(' | ')
  return failures.length > 0 && failures.every((failure) =>
    /^(?:direct|aggregated): Pendle quote returned HTTP (?:429|5\d\d)(?:[.:]|$)/.test(
      failure,
    ),
  )
}

export async function prepareWithPendleQuoteRetry(
  label,
  prepare,
  options = {},
) {
  const retryDelaysMs =
    options.retryDelaysMs ?? PENDLE_PREPARE_RETRY_DELAYS_MS
  const wait = options.wait ?? (
    (delay) => new Promise((resolve) => setTimeout(resolve, delay))
  )
  const warn = options.warn ?? console.warn
  for (
    let attempt = 0;
    attempt <= retryDelaysMs.length;
    attempt += 1
  ) {
    try {
      return await prepare()
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt]
      if (!isRetryablePendleQuoteHttpError(error) || retryDelayMs === undefined) {
        throw error
      }
      warn(
        `  Pendle quote service interrupted ${label}; retrying the complete preparation in ${retryDelayMs / 1_000}s`,
      )
      await wait(retryDelayMs)
    }
  }
  fail(`Unreachable Pendle retry state for ${label}`)
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) fail('Cannot divide by a non-positive denominator')
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n
}

function deriveVerifiedLeverageWad(verified) {
  const { position, accrued } = verified
  if (
    position.classification !== 'open-loop' ||
    position.supplyShares !== 0n ||
    position.borrowShares <= 0n ||
    position.collateral <= 0n
  ) {
    fail('Expected a clean open loop while deriving fork leverage')
  }
  const debtAssets = ceilDiv(
    position.borrowShares * (accrued.totalBorrowAssets + MORPHO_VIRTUAL_ASSETS),
    accrued.totalBorrowShares + MORPHO_VIRTUAL_SHARES,
  )
  const collateralLoanValue =
    position.collateral * accrued.oraclePrice / ORACLE_PRICE_SCALE
  if (collateralLoanValue <= debtAssets) {
    fail('Fork position has no positive equity')
  }
  return collateralLoanValue * WAD / (collateralLoanValue - debtAssets)
}

function assertLoopback(url) {
  const parsed = new URL(url)
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    fail(`Refusing a state-changing fork request to non-loopback host ${parsed.hostname}`)
  }
}

async function jsonRpc(url, method, params = []) {
  if (method.startsWith('anvil_') || method.startsWith('evm_')) assertLoopback(url)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) fail(`Local RPC ${method} returned HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.error) fail(`Local RPC ${method} failed: ${payload.error.message}`)
  return payload.result
}

async function waitForAnvil(localRpcUrl, child, expectedChainId) {
  let lastError
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      fail(`Anvil exited before becoming ready (status ${child.exitCode})`)
    }
    try {
      const chainId = BigInt(await jsonRpc(localRpcUrl, 'eth_chainId'))
      if (chainId !== BigInt(expectedChainId)) {
        fail(`Local fork has chain ${chainId}, expected ${expectedChainId}`)
      }
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw lastError ?? new Error('Anvil did not become ready')
}

async function stopAnvil(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

/**
 * Anvil 1.7 returns an empty fork account for `eth_getCode(..., "pending")`.
 * The browser RPCs support pending reads, but a local auto-mining fork has no
 * distinct pending state. Map the preflight read helpers to latest so the
 * production compiler sees the local fork's canonical auto-mined head.
 * Anvil also returns a stale/empty `eth_getProof` code hash for forked
 * contracts after it mines a local block, so force the compiler's equivalent
 * runtime-bytecode hash fallback.
 */
function withAnvilPendingCompatibility(client) {
  const mappedMethods = new Set(['call', 'getBlock', 'getBytecode', 'readContract'])
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (property === 'getProof') {
        return async () => {
          throw new Error('Anvil fork proof code hashes are stale after local mining')
        }
      }
      if (!mappedMethods.has(String(property))) return value.bind(target)
      return (args = {}) => {
        if (
          property === 'call' &&
          args.blockNumber !== undefined &&
          args.stateOverride !== undefined
        ) {
          const { blockNumber: _blockNumber, ...rest } = args
          return value.call(target, { ...rest, blockTag: 'latest' })
        }
        return value.call(
          target,
          args.blockTag === 'pending'
            ? { ...args, blockTag: 'latest' }
            : args,
        )
      }
    },
  })
}

function balanceStorageKey(owner, slot) {
  return keccak256(
    encodeAbiParameters(mappingSlotParameters, [owner, BigInt(slot)]),
  )
}

async function setForkErc20Balance({
  localRpcUrl,
  publicClient,
  token,
  owner,
  balance,
}) {
  const marker = 0x5a17_0f0fn
  const markerHex = toHex(marker, { size: 32 })
  const preferredSlots = [9, 10, 11, 0, 1, 2, 3, 4, 5, 6, 7, 8]
  const remainingSlots = Array.from({ length: 128 }, (_, slot) => slot)
    .filter((slot) => !preferredSlots.includes(slot))
  for (const slot of [...preferredSlots, ...remainingSlots]) {
    const key = balanceStorageKey(owner, slot)
    const original = await publicClient.getStorageAt({ address: token, slot: key })
    await jsonRpc(localRpcUrl, 'anvil_setStorageAt', [token, key, markerHex])
    const observed = await publicClient.readContract({
      address: token,
      abi: loopingErc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    })
    await jsonRpc(localRpcUrl, 'anvil_setStorageAt', [
      token,
      key,
      original ?? zeroHash,
    ])
    if (observed !== marker) continue

    await jsonRpc(localRpcUrl, 'anvil_setStorageAt', [
      token,
      key,
      toHex(balance, { size: 32 }),
    ])
    const finalBalance = await publicClient.readContract({
      address: token,
      abi: loopingErc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    })
    if (finalBalance !== balance) fail('Local ERC-20 balance fixture did not persist')
    return slot
  }
  fail('Could not locate the forked loan token balance mapping')
}

function readTokenBalance(publicClient, token, owner) {
  return publicClient.readContract({
    address: token,
    abi: loopingErc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })
}

async function signPair(account, requests) {
  return Promise.all(requests.map((request) => account.sign({ hash: request.digest })))
}

function selector(value) {
  return typeof value === 'string' && value.length >= 10
    ? value.slice(0, 10)
    : '0x'
}

async function printRedactedLocalTrace(localRpcUrl, hash) {
  try {
    const trace = await jsonRpc(localRpcUrl, 'debug_traceTransaction', [
      hash,
      { tracer: 'callTracer' },
    ])
    const rows = []
    const visit = (call, depth = 0) => {
      rows.push({
        depth,
        type: call.type,
        from: call.from,
        to: call.to,
        inputSelector: selector(call.input),
        outputSelector: selector(call.output),
        error: call.error,
        revertReason: call.revertReason,
        gasUsed: call.gasUsed,
      })
      for (const child of call.calls ?? []) visit(child, depth + 1)
    }
    visit(trace)
    console.error(`Redacted local call trace: ${JSON.stringify(rows)}`)
  } catch (error) {
    const detail = error?.message ?? String(error)
    console.error(`Redacted local call trace unavailable: ${detail}`)
  }
}

async function sendLocalTransaction({
  walletClient,
  publicClient,
  account,
  intent,
  localRpcUrl,
  label = 'local transaction',
}) {
  assertLoopback(localRpcUrl)
  const estimate = await publicClient.estimateGas({
    account: account.address,
    to: intent.to,
    data: intent.data,
    value: intent.value,
  })
  const gas =
    estimate + estimate * LOCAL_GAS_MARGIN_BPS / BPS + LOCAL_GAS_FIXED_MARGIN
  const latestBlock = await publicClient.getBlock({ blockTag: 'latest' })
  if (gas <= estimate || gas > latestBlock.gasLimit) {
    fail(
      `${label} local gas margin is invalid: estimate ${estimate}, padded ${gas}, block limit ${latestBlock.gasLimit}`,
    )
  }
  console.log(`  ${label} gas: estimate ${estimate}, padded ${gas}`)
  const hash = await walletClient.sendTransaction({
    account,
    chain: walletClient.chain,
    to: intent.to,
    data: intent.data,
    value: intent.value,
    gas,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
    console.error(
      `${label} reverted at local block ${receipt.blockNumber} (timestamp ${block.timestamp})`,
    )
    await printRedactedLocalTrace(localRpcUrl, hash)
    fail(`${label} ${hash} reverted`)
  }
  return hash
}

async function assertSignedBundleCallsLocally({ publicClient, account, bundle, label }) {
  try {
    await publicClient.call({
      account: account.address,
      to: bundle.to,
      data: bundle.data,
      value: bundle.value,
      blockTag: 'latest',
    })
  } catch (error) {
    const detail = error?.shortMessage ?? error?.message ?? String(error)
    fail(`${label} failed before local broadcast: ${detail}`)
  }
}

async function approveExact({
  walletClient,
  publicClient,
  account,
  token,
  spender,
  amount,
  localRpcUrl,
}) {
  const current = await publicClient.readContract({
    address: token,
    abi: loopingErc20Abi,
    functionName: 'allowance',
    args: [account.address, spender],
  })
  if (current !== 0n && current !== amount) {
    await sendLocalTransaction({
      walletClient,
      publicClient,
      account,
      localRpcUrl,
      intent: {
        to: token,
        data: encodeFunctionData({
          abi: loopingErc20Abi,
          functionName: 'approve',
          args: [spender, 0n],
        }),
        value: 0n,
      },
      label: 'adapter allowance clear',
    })
  }
  if (current !== amount) {
    await sendLocalTransaction({
      walletClient,
      publicClient,
      account,
      localRpcUrl,
      intent: {
        to: token,
        data: encodeFunctionData({
          abi: loopingErc20Abi,
          functionName: 'approve',
          args: [spender, amount],
        }),
        value: 0n,
      },
      label: 'exact adapter approval',
    })
  }
}

/**
 * Anvil 1.7 ignores the EIP-1898 state override used by viem's `eth_call` on
 * this fork. Apply and restore the exact compiler-produced slot locally around
 * the same unsigned simulation. The 1RPC override path is covered separately;
 * this adapter exists only so the production action calldata can execute on
 * the local fork.
 */
async function simulateUnsignedOnAnvil({ localRpcUrl, publicClient, intent }) {
  if (intent.stateOverride.length !== 1) {
    fail('Compiler simulation must contain exactly one local state override')
  }
  const override = intent.stateOverride[0]
  if (override.stateDiff.length !== 1) {
    fail('Compiler simulation must contain exactly one local storage diff')
  }
  const diff = override.stateDiff[0]
  const original = await publicClient.getStorageAt({
    address: override.address,
    slot: diff.slot,
  })
  await jsonRpc(localRpcUrl, 'anvil_setStorageAt', [
    override.address,
    diff.slot,
    diff.value,
  ])
  try {
    const probe = await publicClient.call({
      account: intent.account,
      to: intent.authorizationProbe.to,
      data: intent.authorizationProbe.data,
      value: 0n,
      blockTag: 'latest',
    })
    if (
      probe.data?.toLowerCase() !==
        intent.authorizationProbe.expectedResult.toLowerCase()
    ) {
      fail('Local authorization-slot fixture did not take effect')
    }
    try {
      return await simulateUnsignedLoopingIntent({ client: publicClient, intent })
    } catch (error) {
      const summaries = []
      let cursor = error
      for (let depth = 0; depth < 6 && cursor instanceof Error; depth += 1) {
        const shortMessage = typeof cursor.shortMessage === 'string'
          ? cursor.shortMessage
          : cursor.message
        summaries.push(shortMessage.replace(/\s+/g, ' ').slice(0, 320))
        cursor = cursor.cause
      }
      console.error(`  Redacted unsigned-simulation failure: ${summaries.join(' <- ')}`)
      throw error
    }
  } finally {
    await jsonRpc(localRpcUrl, 'anvil_setStorageAt', [
      override.address,
      diff.slot,
      original ?? zeroHash,
    ])
  }
}

async function executeCompiledEntry({
  publicClient,
  walletClient,
  account,
  market,
  initialUsdc,
  loopUsdc,
  acquisitionMode,
  localRpcUrl,
}) {
  const walletPtBefore = await readTokenBalance(
    publicClient,
    market.morphoMarketParams.collateralToken,
    account.address,
  )
  await approveExact({
    walletClient,
    publicClient,
    account,
    token: market.morphoMarketParams.loanToken,
    spender: market.contracts.generalAdapter1,
    amount: initialUsdc,
    localRpcUrl,
  })
  const preview = await prepareWithPendleQuoteRetry(
    'compiled entry',
    () => prepareLoopingEntryExecution({
      client: publicClient,
      owner: account.address,
      market,
      equityAssets: initialUsdc,
      borrowAssets: loopUsdc,
      acquisitionMode,
    }),
  )
  const preSignIntent = buildUnsignedLoopingEntrySimulation(preview)
  await simulateUnsignedOnAnvil({
    localRpcUrl,
    publicClient,
    intent: preSignIntent,
  })
  const [authorizeSignature, revokeSignature] = await signPair(
    account,
    preview.authorizationRequests,
  )
  const bundle = await buildSignedLoopingEntryBundle(
    preview,
    authorizeSignature,
    revokeSignature,
  )
  const postSignIntent = buildUnsignedLoopingEntrySimulation(preview)
  const evidence = await simulateUnsignedOnAnvil({
    localRpcUrl,
    publicClient,
    intent: postSignIntent,
  })
  const readiness = await revalidateSignedLoopingEntry({
    client: publicClient,
    preview,
    bundle,
    simulation: evidence,
  })
  await assertSignedBundleCallsLocally({
    publicClient,
    account,
    bundle,
    label: 'compiled signed entry',
  })
  const transactionHash = await sendLocalTransaction({
    walletClient,
    publicClient,
    account,
    localRpcUrl,
    intent: bundle,
    label: 'compiled signed entry',
  })
  const verified = await verifyLoopingEntryReceiptState({
    client: publicClient,
    preview,
    bundle,
    readiness,
    transactionHash,
  })
  const [walletPtAfter, adapterPtAfter] = await Promise.all([
    readTokenBalance(
      publicClient,
      market.morphoMarketParams.collateralToken,
      account.address,
    ),
    readTokenBalance(
      publicClient,
      market.morphoMarketParams.collateralToken,
      market.contracts.generalAdapter1,
    ),
  ])
  if (walletPtAfter !== walletPtBefore || adapterPtAfter !== 0n) {
    fail('Compiled entry did not deposit all transaction PT as collateral')
  }
  if (
    preview.acquisitionMode !== acquisitionMode ||
    bundle.acquisitionMode !== acquisitionMode ||
    verified.acquisitionMode !== acquisitionMode
  ) {
    fail('Compiled entry changed acquisition mode')
  }
  if (
    acquisitionMode === 'mint' &&
    (
      preview.minimumYtOut <= 0n ||
      verified.deliveredYtOut < preview.minimumYtOut ||
      bundle.calls.length !== 11
    )
  ) {
    fail('Compiled Mint entry did not prove its YT delivery and reviewed call shape')
  }
  return { preview, bundle, verified }
}

async function executeCompiledIncrease({
  publicClient,
  walletClient,
  account,
  market,
  targetLeverageWad,
  acquisitionMode,
  localRpcUrl,
}) {
  const walletPtBefore = await readTokenBalance(
    publicClient,
    market.morphoMarketParams.collateralToken,
    account.address,
  )
  const preview = await prepareWithPendleQuoteRetry(
    'compiled leverage increase',
    () => prepareLoopingIncreaseExecution({
      client: publicClient,
      owner: account.address,
      market,
      targetLeverageWad,
      acquisitionMode,
    }),
  )
  const preSignIntent = buildUnsignedLoopingIncreaseSimulation(preview)
  await simulateUnsignedOnAnvil({
    localRpcUrl,
    publicClient,
    intent: preSignIntent,
  })
  const [authorizeSignature, revokeSignature] = await signPair(
    account,
    preview.authorizationRequests,
  )
  const bundle = await buildSignedLoopingIncreaseBundle(
    preview,
    authorizeSignature,
    revokeSignature,
  )
  const postSignIntent = buildUnsignedLoopingIncreaseSimulation(preview)
  const evidence = await simulateUnsignedOnAnvil({
    localRpcUrl,
    publicClient,
    intent: postSignIntent,
  })
  const readiness = await revalidateSignedLoopingIncrease({
    client: publicClient,
    preview,
    bundle,
    simulation: evidence,
  })
  await assertSignedBundleCallsLocally({
    publicClient,
    account,
    bundle,
    label: 'compiled signed leverage increase',
  })
  const transactionHash = await sendLocalTransaction({
    walletClient,
    publicClient,
    account,
    localRpcUrl,
    intent: bundle,
    label: 'compiled signed leverage increase',
  })
  const verified = await verifyLoopingIncreaseReceiptState({
    client: publicClient,
    preview,
    bundle,
    readiness,
    transactionHash,
  })
  const [walletPtAfter, adapterPtAfter] = await Promise.all([
    readTokenBalance(
      publicClient,
      market.morphoMarketParams.collateralToken,
      account.address,
    ),
    readTokenBalance(
      publicClient,
      market.morphoMarketParams.collateralToken,
      market.contracts.generalAdapter1,
    ),
  ])
  if (walletPtAfter !== walletPtBefore || adapterPtAfter !== 0n) {
    fail('Compiled leverage increase did not deposit all transaction PT')
  }
  if (
    preview.acquisitionMode !== acquisitionMode ||
    bundle.acquisitionMode !== acquisitionMode ||
    verified.acquisitionMode !== acquisitionMode
  ) {
    fail('Compiled leverage increase changed acquisition mode')
  }
  if (
    acquisitionMode === 'mint' &&
    (
      preview.minimumYtOut <= 0n ||
      verified.deliveredYtOut < preview.minimumYtOut ||
      bundle.calls.length !== 7
    )
  ) {
    fail('Compiled Mint increase did not prove its YT delivery and reviewed call shape')
  }
  return { preview, bundle, verified }
}

async function executeCompiledDecrease({
  publicClient,
  walletClient,
  account,
  market,
  targetLeverageWad,
  localRpcUrl,
}) {
  const preview = await prepareWithPendleQuoteRetry(
    'compiled partial leverage decrease',
    () => prepareLoopingDecreaseExecution({
      client: publicClient,
      owner: account.address,
      market,
      targetLeverageWad,
    }),
  )
  const preSignIntent = buildUnsignedLoopingDecreaseSimulation(preview)
  await simulateUnsignedOnAnvil({
    localRpcUrl,
    publicClient,
    intent: preSignIntent,
  })
  const [authorizeSignature, revokeSignature] = await signPair(
    account,
    preview.authorizationRequests,
  )
  const bundle = await buildSignedLoopingDecreaseBundle(
    preview,
    authorizeSignature,
    revokeSignature,
  )
  const postSignIntent = buildUnsignedLoopingDecreaseSimulation(preview)
  const evidence = await simulateUnsignedOnAnvil({
    localRpcUrl,
    publicClient,
    intent: postSignIntent,
  })
  const readiness = await revalidateSignedLoopingDecrease({
    client: publicClient,
    preview,
    bundle,
    simulation: evidence,
  })
  await assertSignedBundleCallsLocally({
    publicClient,
    account,
    bundle,
    label: 'compiled signed partial leverage decrease',
  })
  const transactionHash = await sendLocalTransaction({
    walletClient,
    publicClient,
    account,
    localRpcUrl,
    intent: bundle,
    label: 'compiled signed partial leverage decrease',
  })
  const verified = await verifyLoopingDecreaseReceiptState({
    client: publicClient,
    preview,
    bundle,
    readiness,
    transactionHash,
  })
  return { preview, bundle, verified }
}

async function executeCompiledExit({
  publicClient,
  walletClient,
  account,
  market,
  localRpcUrl,
}) {
  const preview = await prepareWithPendleQuoteRetry(
    'compiled exit',
    () => prepareLoopingExitExecution({
      client: publicClient,
      owner: account.address,
      market,
      minimumReturnedAssets: 1n,
    }),
  )
  const preSignIntent = buildUnsignedLoopingExitSimulation(preview)
  await simulateUnsignedOnAnvil({
    localRpcUrl,
    publicClient,
    intent: preSignIntent,
  })
  const [authorizeSignature, revokeSignature] = await signPair(
    account,
    preview.authorizationRequests,
  )
  const bundle = await buildSignedLoopingExitBundle(
    preview,
    authorizeSignature,
    revokeSignature,
  )
  const postSignIntent = buildUnsignedLoopingExitSimulation(preview)
  const evidence = await simulateUnsignedOnAnvil({
    localRpcUrl,
    publicClient,
    intent: postSignIntent,
  })
  const readiness = await revalidateSignedLoopingExit({
    client: publicClient,
    preview,
    bundle,
    simulation: evidence,
  })
  await assertSignedBundleCallsLocally({
    publicClient,
    account,
    bundle,
    label: 'compiled signed exit',
  })
  const transactionHash = await sendLocalTransaction({
    walletClient,
    publicClient,
    account,
    localRpcUrl,
    intent: bundle,
    label: 'compiled signed exit',
  })
  const verified = await verifyLoopingExitReceiptState({
    client: publicClient,
    preview,
    bundle,
    readiness,
    transactionHash,
  })
  return { preview, bundle, verified }
}

async function executeCompiledRescue({
  publicClient,
  walletClient,
  account,
  market,
  localRpcUrl,
}) {
  const steps = []
  for (let index = 0; index < 12; index += 1) {
    const plan = await prepareDirectLoopingRescue({
      client: publicClient,
      owner: account.address,
      market,
    })
    if (plan.phase === 'complete') {
      if (plan.intents.length !== 0) fail('Complete rescue returned a transaction')
      return steps
    }
    if (plan.intents.length !== 1 || plan.intents[0].step !== plan.phase) {
      fail('Rescue compiler did not return exactly one phase-matched transaction')
    }
    const intent = plan.intents[0]
    await sendLocalTransaction({
      walletClient,
      publicClient,
      account,
      localRpcUrl,
      intent,
      label: `compiled rescue ${intent.step}`,
    })
    steps.push(intent.step)
  }
  fail('Direct rescue did not converge after twelve re-prepared steps')
}

export async function runLoopingCompilerForkProof({
  sourceRpcUrl,
  initialUsdc,
  loopUsdc,
  maturityLoopUsdc = loopUsdc,
  acquisitionMode = 'market',
  chainId = ARBITRUM_LOOPING_CHAIN_ID,
  anvilPort = Number(process.env.OPENPENDLE_ANVIL_PORT ?? DEFAULT_ANVIL_PORT),
}) {
  const target = COMPILER_FORK_TARGETS[chainId]
  if (target === undefined) {
    fail(
      `Production compiler fork proof does not support chain ${chainId}; choose ${Object.keys(COMPILER_FORK_TARGETS).join(', ')}`,
    )
  }
  const { chain, market, name: chainName, hardfork } = target
  if (market.chainId !== chain.id || market.chainId !== chainId) {
    fail(`Compiler fork target registry mismatch for chain ${chainId}`)
  }
  if (
    chainId === ETHEREUM_LOOPING_CHAIN_ID &&
    market.collateralTokenDecimals !== 6
  ) {
    fail('Ethereum compiler proof must exercise the reviewed 6-decimal PT')
  }
  if (market.yieldTokenDecimals !== market.collateralTokenDecimals) {
    fail('Compiler fork target PT and YT decimals must match')
  }
  if (initialUsdc <= 0n || loopUsdc <= 0n) {
    fail('Fork equity and borrow fixtures must be positive')
  }
  if (acquisitionMode !== 'market' && acquisitionMode !== 'mint') {
    fail('Compiler fork acquisition mode must be market or mint')
  }
  if (
    maturityLoopUsdc <= 1n ||
    maturityLoopUsdc > loopUsdc
  ) {
    fail('Fork maturity borrow must be positive and no larger than the tested borrow')
  }
  if (!Number.isInteger(anvilPort) || anvilPort < 1024 || anvilPort > 65_535) {
    fail('OPENPENDLE_ANVIL_PORT must be an unprivileged TCP port')
  }

  const [sourceChainIdHex, freshBlockHex] = await Promise.all([
    jsonRpc(sourceRpcUrl, 'eth_chainId'),
    jsonRpc(sourceRpcUrl, 'eth_blockNumber'),
  ])
  const sourceChainId = BigInt(sourceChainIdHex)
  if (sourceChainId !== BigInt(chainId)) {
    fail(`Compiler fork source is chain ${sourceChainId}, expected ${chainName}`)
  }
  const blockNumber = BigInt(freshBlockHex)
  const localRpcUrl = `http://127.0.0.1:${anvilPort}`
  assertLoopback(localRpcUrl)
  const anvil = spawn(
    'anvil',
    [
      '--fork-url',
      sourceRpcUrl,
      '--fork-block-number',
      blockNumber.toString(),
      '--chain-id',
      String(chainId),
      '--hardfork',
      hardfork,
      '--port',
      String(anvilPort),
      '--silent',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  try {
    await waitForAnvil(localRpcUrl, anvil, chainId)
    const account = privateKeyToAccount(TEST_PRIVATE_KEY)
    const basePublicClient = createPublicClient({
      chain,
      transport: http(localRpcUrl, { retryCount: 0, timeout: 120_000 }),
    })
    const publicClient = withAnvilPendingCompatibility(basePublicClient)
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(localRpcUrl, { retryCount: 0, timeout: 120_000 }),
    })
    await jsonRpc(localRpcUrl, 'anvil_setBalance', [
      account.address,
      toHex(10n ** 20n),
    ])
    const seedBalance = initialUsdc * 4n + loopUsdc * 2n
    const balanceSlot = await setForkErc20Balance({
      localRpcUrl,
      publicClient,
      token: market.morphoMarketParams.loanToken,
      owner: account.address,
      balance: seedBalance,
    })
    const morphoCode = await basePublicClient.getBytecode({
      address: market.contracts.morpho,
      blockTag: 'latest',
    })
    const morphoCodeHash = morphoCode === undefined ? zeroHash : keccak256(morphoCode)
    if (morphoCodeHash.toLowerCase() !== market.runtimeCodePolicy.morpho.toLowerCase()) {
      fail(
        `Local Morpho runtime mismatch: bytecode ${morphoCodeHash}, expected ${market.runtimeCodePolicy.morpho}`,
      )
    }
    console.log('TypeScript compiler fork proof')
    console.log(`  Local Anvil: ${localRpcUrl}`)
    console.log(`  Fresh ${chainName} block: ${blockNumber}`)
    console.log(`  Acquisition mode: ${acquisitionMode}`)
    console.log(`  Collateral decimals: ${market.collateralTokenDecimals}`)
    console.log(`  Yield-token decimals: ${market.yieldTokenDecimals}`)
    console.log(`  Loan-token balance slot: ${balanceSlot}`)
    const baselineSnapshot = await jsonRpc(localRpcUrl, 'evm_snapshot')

    const entry = await executeCompiledEntry({
      publicClient,
      walletClient,
      account,
      market,
      initialUsdc,
      loopUsdc,
      acquisitionMode,
      localRpcUrl,
    })
    const entryLeverageWad = deriveVerifiedLeverageWad(entry.verified)
    const increaseTargetLeverageWad = entryLeverageWad + INCREASE_STEP_WAD
    const increase = await executeCompiledIncrease({
      publicClient,
      walletClient,
      account,
      market,
      targetLeverageWad: increaseTargetLeverageWad,
      acquisitionMode,
      localRpcUrl,
    })
    const increasedLeverageWad = deriveVerifiedLeverageWad(increase.verified)
    if (
      increasedLeverageWad <= entryLeverageWad ||
      increase.verified.position.borrowShares <= entry.verified.position.borrowShares ||
      increase.verified.position.collateral <= entry.verified.position.collateral
    ) {
      fail('Compiled leverage increase did not increase debt, collateral, and leverage')
    }
    const decreaseTargetLeverageWad =
      WAD + (increasedLeverageWad - WAD) * 2n / 3n
    const decrease = await executeCompiledDecrease({
      publicClient,
      walletClient,
      account,
      market,
      targetLeverageWad: decreaseTargetLeverageWad,
      localRpcUrl,
    })
    const decreasedLeverageWad = deriveVerifiedLeverageWad(decrease.verified)
    if (
      decreasedLeverageWad >= increasedLeverageWad ||
      decrease.verified.position.borrowShares >= increase.verified.position.borrowShares ||
      decrease.verified.position.collateral >= increase.verified.position.collateral ||
      decrease.verified.position.borrowShares <= 0n ||
      decrease.verified.position.collateral <= 0n
    ) {
      fail('Compiled partial decrease did not reduce debt, collateral, and leverage')
    }
    const exit = await executeCompiledExit({
      publicClient,
      walletClient,
      account,
      market,
      localRpcUrl,
    })
    if (exit.verified.position.classification !== 'empty') {
      fail('Compiled signed exit left a Morpho position')
    }
    const revertedToBaseline = await jsonRpc(localRpcUrl, 'evm_revert', [
      baselineSnapshot,
    ])
    if (revertedToBaseline !== true) {
      fail('Local fork could not restore the initial lifecycle snapshot')
    }
    const rescueBaselineSnapshot = await jsonRpc(localRpcUrl, 'evm_snapshot')

    await executeCompiledEntry({
      publicClient,
      walletClient,
      account,
      market,
      initialUsdc,
      loopUsdc,
      acquisitionMode,
      localRpcUrl,
    })
    const rescueSteps = await executeCompiledRescue({
      publicClient,
      walletClient,
      account,
      market,
      localRpcUrl,
    })
    const expectedRescueSteps = [
      'approve-exact-repayment',
      'repay-exact-shares',
      'clear-morpho-allowance-after',
      'withdraw-exact-collateral',
    ]
    if (JSON.stringify(rescueSteps) !== JSON.stringify(expectedRescueSteps)) {
      fail(`Unexpected compiled rescue sequence: ${rescueSteps.join(', ')}`)
    }
    const revertedToRescueBaseline = await jsonRpc(localRpcUrl, 'evm_revert', [
      rescueBaselineSnapshot,
    ])
    if (revertedToRescueBaseline !== true) {
      fail('Local fork could not restore the rescue lifecycle snapshot')
    }

    // Keep the post-expiry proof economically conservative. The main lifecycle
    // and rescue above already test the requested borrow size; warping months
    // forward can legitimately make that higher-leverage position insolvent
    // from accrued interest alone. This separate fixture proves that a
    // still-solvent position can use the production matured-redemption path.
    await executeCompiledEntry({
      publicClient,
      walletClient,
      account,
      market,
      initialUsdc,
      loopUsdc: maturityLoopUsdc,
      acquisitionMode,
      localRpcUrl,
    })
    const maturedTimestamp = market.pendleMarketExpiry + 1n
    await jsonRpc(localRpcUrl, 'evm_setNextBlockTimestamp', [
      Number(maturedTimestamp),
    ])
    await jsonRpc(localRpcUrl, 'evm_mine')
    const maturedBlock = await publicClient.getBlock({ blockTag: 'latest' })
    if (maturedBlock.timestamp !== maturedTimestamp) {
      fail(
        `Local maturity warp landed at ${maturedBlock.timestamp}, expected ${maturedTimestamp}`,
      )
    }
    const maturedExit = await executeCompiledExit({
      publicClient,
      walletClient,
      account,
      market,
      localRpcUrl,
    })
    if (maturedExit.preview.quote.kind !== 'redeem-matured-pt') {
      fail('Post-expiry compiler did not select the matured PT redemption path')
    }
    if (maturedExit.verified.position.classification !== 'empty') {
      fail('Compiled post-expiry exit left a Morpho position')
    }

    console.log(`  Signed entry calls: ${entry.bundle.calls.length}`)
    console.log(
      `  Increase leverage: ${entryLeverageWad} -> ${increasedLeverageWad} WAD (${increase.bundle.calls.length} calls)`,
    )
    console.log(
      `  Partial decrease: ${increasedLeverageWad} -> ${decreasedLeverageWad} WAD (${decrease.bundle.calls.length} calls)`,
    )
    console.log(`  Signed exit calls: ${exit.bundle.calls.length}`)
    console.log(`  Re-prepared rescue: ${rescueSteps.join(' -> ')}`)
    console.log(
      `  Post-expiry signed exit: ${maturedExit.preview.quote.kind} at ${maturedTimestamp} with ${maturityLoopUsdc} loan-token base units borrowed (${maturedExit.bundle.calls.length} calls)`,
    )
    console.log(
      `TypeScript-compiled ${acquisitionMode} entry, leverage increase, partial decrease, exit, rescue, and post-expiry exit passed on the ${chainName} fork`,
    )
  } finally {
    await stopAnvil(anvil)
  }
}
