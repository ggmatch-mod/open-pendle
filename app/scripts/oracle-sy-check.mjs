import assert from 'node:assert/strict'
import { decodeDeployData, encodeAbiParameters, encodeEventTopics, getAbiItem } from 'viem'
import {
  buildOracleSyDeployment,
  decodeOracleSyDeployment,
  inspectOracleSySource,
  oracleSyOracleAbi,
  readOracleSyReadiness,
  verifyOracleSyDeployment,
} from '../src/lib/oracleSy.ts'
import { ORACLE_SY_BOOTSTRAP_ABI, ORACLE_SY_BOOTSTRAP_BYTECODE } from '../src/generated/oracleSyArtifact.ts'

const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const ZERO = address(0)
const receipt = address(1)
const vault = address(2)
const asset = address(3)
const feed = address(4)
const reporter = address(5)
const owner = address(6)
const sy = address(7)
const oracle = address(8)
const bootstrap = address(9)
const attacker = address(10)
const deployment = { sy, oracle }
const v1 = { version: 'shift-v1', receipt, source: receipt, accountingAsset: asset, maxAge: 100, reporter: ZERO, name: 'Standardized Shift', symbol: 'SY-SHIFT', syOwner: owner }
const v2 = { ...v1, version: 'shift-v2', source: vault, reporter }

/** All reads assert a common block so a source cannot mix pre/post-update data. */
function mockClient(config = v1, overrides = {}) {
  const state = {
    chainId: 42161,
    selectedChain: 42161,
    blockNumber: 100n,
    now: 1_000n,
    receiptDecimals: 18,
    assetDecimals: 6,
    feedDecimals: 6,
    sourceTimestamp: 950n,
    tvlValue: 1_000_000_000n,
    supplySnapshot: 1_000n * 10n ** 18n,
    price: 1_234_567n,
    observedAt: 950n,
    observedPrice: 1_234_567n,
    receiptVault: vault,
    vaultShare: receipt,
    accountingAsset: asset,
    syOwner: owner,
    paused: false,
    syOracle: oracle,
    oracleSource: config.source,
    oracleReporter: config.reporter,
    oracleKind: config.version === 'shift-v1' ? 1 : 2,
    oracleMaxAge: config.maxAge,
    oracleFeed: config.version === 'shift-v1' ? feed : ZERO,
    tokensIn: [receipt],
    tokensOut: [receipt],
    noCode: [],
    ...overrides,
  }
  const rate = () => state.price * 10n ** BigInt(state.assetDecimals) / 10n ** BigInt(config.version === 'shift-v1' ? state.feedDecimals : state.assetDecimals)
  const reads = []
  return {
    state,
    reads,
    chain: { id: state.selectedChain },
    getChainId: async () => state.chainId,
    getBlockNumber: async (options) => {
      assert.deepEqual(options, { cacheTime: 0 }, 'Source and deployment snapshots must bypass viem block-number cache')
      return state.blockNumber
    },
    getBlock: async ({ blockNumber }) => {
      assert.equal(blockNumber, state.blockNumber)
      return { timestamp: state.now }
    },
    getBytecode: async ({ address: target, blockNumber }) => {
      assert.equal(blockNumber, state.blockNumber)
      return state.noCode.includes(target) ? '0x' : '0x6000'
    },
    readContract: async ({ address: target, functionName, args, blockNumber }) => {
      assert.equal(blockNumber, state.blockNumber)
      reads.push({ target, functionName, blockNumber })
      if (target === receipt) {
        switch (functionName) {
          case 'decimals': return state.receiptDecimals
          case 'symbol': return 'SHIFT'
          case 'vault': return state.receiptVault
          case 'baseToken': return state.accountingAsset
          case 'tvlFeed': return feed
          case 'getSharePrice': return state.price
        }
      }
      if (target === feed) {
        switch (functionName) {
          case 'decimals': return state.feedDecimals
          case 'getLastTvl': return [state.tvlValue, state.sourceTimestamp, state.supplySnapshot]
        }
      }
      if (target === vault) {
        switch (functionName) {
          case 'share': return state.vaultShare
          case 'asset': return state.accountingAsset
          case 'latestSharePrice': return state.price
          case 'convertToAssets':
            assert.deepEqual(args, [10n ** 18n])
            return state.converted ?? state.price
        }
      }
      if (target === asset) {
        switch (functionName) {
          case 'decimals': return state.assetDecimals
          case 'symbol': return 'TOKEN' // No symbol-based USDC assumption.
        }
      }
      if (target === sy) {
        switch (functionName) {
          case 'yieldToken': return receipt
          case 'assetInfo': return [0, state.accountingAsset, state.assetDecimals]
          case 'decimals': return 18
          case 'name': return config.name
          case 'symbol': return config.symbol
          case 'owner': return state.syOwner
          case 'paused': return state.paused
          case 'getTokensIn': return state.tokensIn
          case 'getTokensOut': return state.tokensOut
          case 'exchangeRateOracle': return state.syOracle
          case 'exchangeRate': return state.syRate ?? rate()
        }
      }
      if (target === oracle) {
        switch (functionName) {
          case 'sourceKind': return state.oracleKind
          case 'receipt': return receipt
          case 'source': return state.oracleSource
          case 'accountingAsset': return state.accountingAsset
          case 'maxAge': return state.oracleMaxAge
          case 'reporter': return state.oracleReporter
          case 'accountingDecimals': return state.assetDecimals
          case 'feedDecimals': return config.version === 'shift-v1' ? state.feedDecimals : state.assetDecimals
          case 'tvlFeed': return state.oracleFeed
          case 'lastObservedAt': return state.observedAt
          case 'lastObservedPrice': return state.observedPrice
          case 'getExchangeRate': return state.oracleRate ?? rate()
        }
      }
      throw new Error(`Unexpected contract read ${target}.${functionName}`)
    },
  }
}

function eventLog(emitter = bootstrap, overrides = {}) {
  const event = getAbiItem({ abi: ORACLE_SY_BOOTSTRAP_ABI, name: 'OracleSyDeployed' })
  const args = { sy, oracle, sourceKind: 1, receipt, accountingAsset: asset, ...overrides }
  return {
    address: emitter,
    topics: encodeEventTopics({ abi: ORACLE_SY_BOOTSTRAP_ABI, eventName: 'OracleSyDeployed', args }),
    data: encodeAbiParameters(event.inputs.filter((input) => !input.indexed), [args.sourceKind, args.receipt, args.accountingAsset]),
  }
}
const txReceipt = (logs = [eventLog()], overrides = {}) => ({ status: 'success', contractAddress: bootstrap, logs, ...overrides })

// Creation is a real constructor payload, with exact raw accounting units and
// version-specific source/reporter bindings. No factory address is assumed.
for (const config of [v1, v2]) {
  const data = buildOracleSyDeployment(config)
  assert.equal(typeof data, 'string')
  assert.ok(data.startsWith(ORACLE_SY_BOOTSTRAP_BYTECODE))
  const decoded = decodeDeployData({ abi: ORACLE_SY_BOOTSTRAP_ABI, bytecode: ORACLE_SY_BOOTSTRAP_BYTECODE, data })
  assert.equal(decoded.args[0], config.version === 'shift-v1' ? 1 : 2)
  assert.equal(decoded.args[1].toLowerCase(), config.receipt)
  assert.equal(decoded.args[2].toLowerCase(), config.source)
  assert.equal(decoded.args[3].toLowerCase(), config.accountingAsset)
  assert.equal(decoded.args[4], config.maxAge)
  assert.equal(decoded.args[5].toLowerCase(), config.reporter)
}
for (const override of [
  { version: 'other' }, { receipt: ZERO }, { source: ZERO }, { accountingAsset: ZERO }, { syOwner: ZERO },
  { receipt: 'bad' }, { maxAge: 0 }, { maxAge: -1 }, { maxAge: 1.5 }, { maxAge: 2 ** 32 },
  { source: vault }, { reporter }, { name: ' ' }, { symbol: '' },
]) assert.throws(() => buildOracleSyDeployment({ ...v1, ...override }))
assert.throws(() => buildOracleSyDeployment({ ...v2, reporter: ZERO }))
assert.throws(() => buildOracleSyDeployment({ ...v2, source: receipt }))

let inspection = await inspectOracleSySource(mockClient(), { version: 'shift-v1', receipt, maxAge: 100 })
assert.equal(inspection.source, receipt)
assert.equal(inspection.rate, 1_234_567n)
assert.equal(inspection.rateDisplay, '1.234567')
assert.equal(inspection.assetSymbol, 'TOKEN')
assert.equal(inspection.sourceTimestamp, 950n)
assert.equal(inspection.chainId, 42161)
assert.equal(inspection.blockNumber, 100n)

// V1 feed units are explicitly converted to accounting units. A 1e18 USDC
// scaling error changes the economic split and must never pass silently.
inspection = await inspectOracleSySource(mockClient(v1, { feedDecimals: 18, price: 1_234_567_000_000_000_000n }), v1)
assert.equal(inspection.rate, 1_234_567n)
inspection = await inspectOracleSySource(mockClient(v1, { assetDecimals: 18 }), v1)
assert.equal(inspection.rate, 1_234_567_000_000_000_000n)
assert.equal(inspection.rateDisplay, '1.234567')

inspection = await inspectOracleSySource(mockClient(v2), { version: 'shift-v2', receipt, maxAge: 100 })
assert.equal(inspection.source, vault)
assert.equal(inspection.rate, 1_234_567n)
assert.equal(inspection.sourceTimestamp, null)
assert.ok(inspection.warnings.some((warning) => warning.includes('reporter')))

for (const overrides of [
  { receiptDecimals: 6 }, { assetDecimals: 0 }, { assetDecimals: 19 }, { feedDecimals: 19 },
  { sourceTimestamp: 0n }, { sourceTimestamp: 899n }, { sourceTimestamp: 1_001n }, { price: 0n },
  { tvlValue: 0n }, { supplySnapshot: 0n }, { feedDecimals: 0, assetDecimals: 18, price: 2n ** 256n - 1n },
  { noCode: [receipt] }, { noCode: [asset] }, { noCode: [feed] }, { chainId: 1 },
]) await assert.rejects(() => inspectOracleSySource(mockClient(v1, overrides), v1))
await assert.rejects(() => inspectOracleSySource(mockClient(), { ...v1, source: vault }), /V1 price source/)
await assert.rejects(() => inspectOracleSySource(mockClient(v2, { receiptVault: attacker }), v2), /Receipt vault/)
await assert.rejects(() => inspectOracleSySource(mockClient(v2, { vaultShare: attacker }), v2), /Vault share/)
await assert.rejects(() => inspectOracleSySource(mockClient(v2, { noCode: [vault] }), v2), /no contract code/)
await assert.rejects(() => inspectOracleSySource(mockClient(v2, { price: 0n }), v2), /positive/)
await assert.rejects(() => inspectOracleSySource(mockClient(v2, { converted: 1_234_567n * 10n ** 12n }), v2), /raw accounting units/)
// At the boundary the source is fresh; it must not use local wall-clock time.
assert.equal((await inspectOracleSySource(mockClient(v1, { sourceTimestamp: 900n }), v1)).rate, 1_234_567n)

assert.deepEqual(decodeOracleSyDeployment(txReceipt(), v1), deployment)
assert.deepEqual(decodeOracleSyDeployment(txReceipt([eventLog(attacker, { sy: attacker }), eventLog()]), v1), deployment)
for (const logs of [
  [eventLog(attacker)], [eventLog(), eventLog()], [eventLog(bootstrap, { sourceKind: 2 })],
  [eventLog(bootstrap, { receipt: attacker })], [eventLog(bootstrap, { accountingAsset: attacker })],
  [eventLog(bootstrap, { sy: ZERO })], [eventLog(bootstrap, { oracle: ZERO })],
  [eventLog(bootstrap, { sy: oracle })], [eventLog(bootstrap, { sy: bootstrap })],
]) assert.throws(() => decodeOracleSyDeployment(txReceipt(logs), v1))
assert.throws(() => decodeOracleSyDeployment(txReceipt(undefined, { contractAddress: null }), v1))
assert.throws(() => decodeOracleSyDeployment(txReceipt(undefined, { status: 'reverted' }), v1))
assert.throws(() => decodeOracleSyDeployment(txReceipt(), { ...v1, accountingAsset: attacker }))

for (const config of [v1, v2]) {
  await verifyOracleSyDeployment(mockClient(config), deployment, config)
  assert.deepEqual(await readOracleSyReadiness(mockClient(config), deployment, config), { ready: true, rate: 1_234_567n })
}
for (const overrides of [
  { syOwner: attacker }, { syOracle: attacker }, { oracleSource: attacker }, { oracleReporter: attacker },
  { oracleKind: 2 }, { oracleMaxAge: 101 }, { tokensIn: [receipt, attacker] }, { tokensOut: [asset] },
  { oracleFeed: attacker },
  { noCode: [sy] }, { noCode: [oracle] },
]) {
  await assert.rejects(() => verifyOracleSyDeployment(mockClient(v1, overrides), deployment, v1))
  assert.equal((await readOracleSyReadiness(mockClient(v1, overrides), deployment, v1)).ready, Boolean(overrides.syOwner))
}
await verifyOracleSyDeployment(mockClient(v1, { syOwner: attacker }), deployment, v1, { verifyInitialOwner: false })
assert.equal((await readOracleSyReadiness(mockClient(v1, { paused: true }), deployment, v1)).ready, false)
for (const overrides of [
  { observedAt: 0n }, { observedAt: 899n }, { observedAt: 1_001n }, { observedPrice: 1_234_566n },
  { oracleRate: 1_234_568n }, { syRate: 1_234_568n }, { receiptVault: attacker },
  { converted: 1_234_567n * 10n ** 12n },
]) assert.equal((await readOracleSyReadiness(mockClient(v2, overrides), deployment, v2)).ready, false)
assert.equal((await readOracleSyReadiness(mockClient(v1, { sourceTimestamp: 899n }), deployment, v1)).ready, false)
assert.equal((await readOracleSyReadiness(mockClient(v2, { observedAt: 900n }), deployment, v2)).ready, true)

console.log('PASS: oracle SY creation encoding, raw accounting units, source bindings, NAV freshness, trusted deployment events, and readback readiness')

// Optional real-EVM smoke: start a disposable local Anvil chain, build the
// Solidity project, then run this file with --anvil. Never uses a real network.
if (process.argv.includes('--anvil')) {
  const { readFile } = await import('node:fs/promises')
  const { createPublicClient, createWalletClient, http } = await import('viem')
  const { foundry } = await import('viem/chains')
  const rpcUrl = process.env.ORACLE_SY_TEST_RPC ?? 'http://127.0.0.1:18547'
  const rpc = new URL(rpcUrl)
  assert.ok(rpc.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname), 'Smoke test only accepts a local HTTP test chain')
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), cacheTime: 0 })
  assert.equal(await publicClient.getChainId(), 31337, 'Smoke test requires a disposable chain with id 31337')
  const [account] = await publicClient.request({ method: 'eth_accounts' })
  assert.ok(account)
  const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) })
  const artifacts = {}
  async function artifact(name) {
    return artifacts[name] ??= JSON.parse(await readFile(new URL(`../../contracts/oracle-sy/out/MockShift.sol/${name}.json`, import.meta.url), 'utf8'))
  }
  async function deployMock(name, args = []) {
    const built = await artifact(name)
    const hash = await wallet.deployContract({ abi: built.abi, bytecode: built.bytecode.object, args })
    const mined = await publicClient.waitForTransactionReceipt({ hash })
    assert.equal(mined.status, 'success')
    assert.ok(mined.contractAddress)
    return mined.contractAddress
  }
  async function writeMock(name, target, functionName, args) {
    const { abi } = await artifact(name)
    const hash = await wallet.writeContract({ address: target, abi, functionName, args })
    assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success')
  }
  const realAsset = await deployMock('MockAccountingAsset', [6])
  const realFeed = await deployMock('MockTvlFeed', [6])
  const realV1 = await deployMock('MockShiftV1', [realAsset, realFeed])
  const observation = (await publicClient.getBlock({ blockTag: 'latest' })).timestamp
  await writeMock('MockTvlFeed', realFeed, 'setSample', [10_500_000n, observation, 10n * 10n ** 18n])
  await writeMock('MockShiftV1', realV1, 'setPrice', [1_050_000n])
  const realV2 = await deployMock('MockSyShare')
  const realVault = await deployMock('MockSyVault', [realV2, realAsset])
  await writeMock('MockSyShare', realV2, 'setVault', [realVault])
  await writeMock('MockSyVault', realVault, 'setPrice', [1_050_000n])
  const liveV1 = { ...v1, receipt: realV1, source: realV1, accountingAsset: realAsset, maxAge: 3_600, syOwner: account }
  const liveV2 = { ...liveV1, version: 'shift-v2', receipt: realV2, source: realVault, reporter: account }
  const liveDeployments = []
  for (const config of [liveV1, liveV2]) {
    assert.equal((await inspectOracleSySource(publicClient, config)).rate, 1_050_000n)
    const hash = await wallet.sendTransaction({ data: buildOracleSyDeployment(config) })
    const mined = await publicClient.waitForTransactionReceipt({ hash })
    const deployed = decodeOracleSyDeployment(mined, config)
    await verifyOracleSyDeployment(publicClient, deployed, config)
    liveDeployments.push(deployed)
    const initial = await readOracleSyReadiness(publicClient, deployed, config)
    assert.equal(initial.ready, config.version === 'shift-v1')
    if (config.version === 'shift-v2') {
      const hash = await wallet.writeContract({ address: deployed.oracle, abi: oracleSyOracleAbi, functionName: 'attestNav', args: [1_050_000n, observation] })
      assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success')
      assert.deepEqual(await readOracleSyReadiness(publicClient, deployed, config), { ready: true, rate: 1_050_000n })
    }
  }
  await writeMock('MockSyVault', realVault, 'setPrice', [1_060_000n])
  assert.equal((await readOracleSyReadiness(publicClient, liveDeployments[1], liveV2)).ready, false, 'Source price changes must require a new actual NAV observation')
  await writeMock('MockTvlFeed', realFeed, 'setSample', [10_500_000n, observation - 3_601n, 10n * 10n ** 18n])
  assert.equal((await readOracleSyReadiness(publicClient, liveDeployments[0], liveV1)).ready, false, 'V1 must reject a stale source sample on-chain and off-chain')
  console.log('PASS: generated constructor bytecode deployed on local Anvil for V1/V2, trusted events and readback verified, V2 attestation unlocks readiness, source updates and stale NAV close readiness')
}
