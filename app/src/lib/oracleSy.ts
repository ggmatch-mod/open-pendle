/** Shift receipt -> accounting-asset SY deployment. No wallet or React state. */
import {
  decodeEventLog,
  encodeDeployData,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
} from 'viem'
import type { Address, Hex, PublicClient } from 'viem'
import { ORACLE_SY_BOOTSTRAP_ABI, ORACLE_SY_BOOTSTRAP_BYTECODE } from '../generated/oracleSyArtifact.ts'

const ZERO = '0x0000000000000000000000000000000000000000'
const UINT32_MAX = 4_294_967_295
const UINT256_MAX = (1n << 256n) - 1n

export interface OracleSyConfig {
  version: 'shift-v1' | 'shift-v2'
  receipt: Address
  source: Address
  accountingAsset: Address
  maxAge: number
  reporter: Address
  name: string
  symbol: string
  syOwner: Address
}

export interface OracleSyDeployment { sy: Address; oracle: Address }
export interface OracleSyReadiness { ready: boolean; rate?: bigint; error?: string }
export interface OracleSySourceInspection {
  version: OracleSyConfig['version']
  receipt: Address
  source: Address
  accountingAsset: Address
  receiptDecimals: number
  assetDecimals: number
  assetSymbol: string
  receiptSymbol: string
  /** Raw accounting units per whole 18-decimal receipt; USDC typically has 6. */
  rate: bigint
  rateDisplay: string
  sourceTimestamp: bigint | null
  blockNumber: bigint
  blockTimestamp: bigint
  chainId: number
  warnings: string[]
}

export const oracleSyOracleAbi = parseAbi([
  'function sourceKind() view returns (uint8)',
  'function source() view returns (address)',
  'function receipt() view returns (address)',
  'function accountingAsset() view returns (address)',
  'function tvlFeed() view returns (address)',
  'function reporter() view returns (address)',
  'function maxAge() view returns (uint32)',
  'function accountingDecimals() view returns (uint8)',
  'function feedDecimals() view returns (uint8)',
  'function lastObservedAt() view returns (uint64)',
  'function lastObservedPrice() view returns (uint256)',
  'function getExchangeRate() view returns (uint256)',
  'function attestNav(uint256 price, uint64 observedAt)',
])

const tokenAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])
const v1Abi = parseAbi([
  'function baseToken() view returns (address)',
  'function tvlFeed() view returns (address)',
  'function getSharePrice() view returns (uint256)',
])
const feedAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function getLastTvl() view returns (uint256 value, uint256 timestamp, uint256 supplySnapshot)',
])
const v2ReceiptAbi = parseAbi(['function vault() view returns (address)'])
const v2VaultAbi = parseAbi([
  'function share() view returns (address)',
  'function asset() view returns (address)',
  'function latestSharePrice() view returns (uint256)',
  'function convertToAssets(uint256 amount) view returns (uint256)',
])
const syAbi = parseAbi([
  'function yieldToken() view returns (address)',
  'function assetInfo() view returns (uint8 assetType,address assetAddress,uint8 assetDecimals)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function getTokensIn() view returns (address[])',
  'function getTokensOut() view returns (address[])',
  'function exchangeRateOracle() view returns (address)',
  'function exchangeRate() view returns (uint256)',
])

function validAddress(value: unknown, label: string, allowZero = false): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || (!allowZero && value.toLowerCase() === ZERO)) {
    throw new Error(`${label} must be a valid ${allowZero ? '' : 'nonzero '}address.`)
  }
  return getAddress(value)
}

function sameAddress(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase() }
function requireSame(a: string, b: string, label: string): void {
  if (!sameAddress(a, b)) throw new Error(`${label} does not match the selected configuration.`)
}
function validMaxAge(maxAge: number): void {
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > UINT32_MAX) {
    throw new Error('NAV maximum age must be a positive uint32 number of seconds.')
  }
}
function sourceKind(version: OracleSyConfig['version']): 1 | 2 {
  if (version === 'shift-v1') return 1
  if (version === 'shift-v2') return 2
  throw new Error('Select Shift V1 or Shift V2.')
}
function validConfig(config: OracleSyConfig): void {
  sourceKind(config.version)
  validMaxAge(config.maxAge)
  for (const key of ['receipt', 'source', 'accountingAsset', 'syOwner'] as const) validAddress(config[key], key)
  validAddress(config.reporter, 'reporter', config.version === 'shift-v1')
  if (config.version === 'shift-v1') {
    requireSame(config.source, config.receipt, 'V1 price source')
    if (!sameAddress(config.reporter, ZERO)) throw new Error('V1 uses the feed timestamp and must use a zero reporter.')
  } else if (sameAddress(config.source, config.receipt)) {
    throw new Error('The V2 vault source must differ from its receipt token.')
  }
  if (!config.name.trim() || !config.symbol.trim()) throw new Error('SY name and symbol are required.')
}
function positiveRate(rate: bigint): void {
  if (rate <= 0n) throw new Error('The source share price must be positive.')
  if (rate > UINT256_MAX) throw new Error('The source share price exceeds uint256 accounting units.')
}
function freshTimestamp(timestamp: bigint, now: bigint, maxAge: number): void {
  if (timestamp <= 0n) throw new Error('The NAV observation timestamp is missing.')
  if (timestamp > now) throw new Error('The NAV observation timestamp is in the future.')
  if (now - timestamp > BigInt(maxAge)) throw new Error('The NAV observation is stale. Refresh Shift NAV before continuing.')
}
async function requireCode(client: PublicClient, address: Address, blockNumber: bigint, label: string): Promise<void> {
  const code = await client.getBytecode({ address, blockNumber })
  if (!code || code === '0x') throw new Error(`${label} has no contract code on the selected chain.`)
}
async function snapshot(client: PublicClient) {
  // A cached pre-signing block can precede the deployment just mined. Force a
  // fresh block before pinning readback, source bindings and readiness checks.
  const [blockNumber, chainId] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), client.getChainId()])
  if (client.chain && chainId !== client.chain.id) throw new Error('RPC chain does not match the selected chain.')
  const block = await client.getBlock({ blockNumber })
  return { blockNumber, blockTimestamp: block.timestamp, chainId }
}

/** Probe and bind the actual source at one block. Never infer units from symbols. */
export async function inspectOracleSySource(
  client: PublicClient,
  input: { version: OracleSyConfig['version']; receipt: Address; source?: Address; maxAge: number },
): Promise<OracleSySourceInspection> {
  sourceKind(input.version)
  validMaxAge(input.maxAge)
  const receipt = validAddress(input.receipt, 'Receipt')
  const snap = await snapshot(client)
  const { blockNumber } = snap
  await requireCode(client, receipt, blockNumber, 'Receipt')
  const [receiptDecimals, receiptSymbol] = await Promise.all([
    client.readContract({ address: receipt, abi: tokenAbi, functionName: 'decimals', blockNumber }),
    client.readContract({ address: receipt, abi: tokenAbi, functionName: 'symbol', blockNumber }),
  ])
  if (receiptDecimals !== 18) throw new Error('This adapter requires an 18-decimal Shift receipt.')
  let source: Address
  let accountingAsset: Address
  let rawRate: bigint
  let feedDecimals: number | null = null
  let sourceTimestamp: bigint | null = null
  const warnings: string[] = []
  if (input.version === 'shift-v1') {
    source = input.source ? validAddress(input.source, 'Source') : receipt
    requireSame(source, receipt, 'V1 price source')
    const [asset, feed, price] = await Promise.all([
      client.readContract({ address: source, abi: v1Abi, functionName: 'baseToken', blockNumber }),
      client.readContract({ address: source, abi: v1Abi, functionName: 'tvlFeed', blockNumber }),
      client.readContract({ address: source, abi: v1Abi, functionName: 'getSharePrice', blockNumber }),
    ])
    accountingAsset = validAddress(asset, 'Accounting asset')
    const tvlFeed = validAddress(feed, 'TVL feed')
    await requireCode(client, tvlFeed, blockNumber, 'TVL feed')
    const [decimals, tvl] = await Promise.all([
      client.readContract({ address: tvlFeed, abi: feedAbi, functionName: 'decimals', blockNumber }),
      client.readContract({ address: tvlFeed, abi: feedAbi, functionName: 'getLastTvl', blockNumber }),
    ])
    if (decimals > 18) throw new Error('TVL feed decimals exceed the adapter limit of 18.')
    feedDecimals = decimals
    sourceTimestamp = tvl[1]
    freshTimestamp(sourceTimestamp, snap.blockTimestamp, input.maxAge)
    if (tvl[0] === 0n || tvl[2] === 0n) throw new Error('The NAV sample must have a positive TVL and share supply snapshot.')
    rawRate = price
  } else {
    const vault = validAddress(await client.readContract({ address: receipt, abi: v2ReceiptAbi, functionName: 'vault', blockNumber }), 'V2 vault')
    source = input.source ? validAddress(input.source, 'Source') : vault
    requireSame(source, vault, 'Receipt vault')
    await requireCode(client, source, blockNumber, 'V2 vault')
    const [share, asset, price, converted] = await Promise.all([
      client.readContract({ address: source, abi: v2VaultAbi, functionName: 'share', blockNumber }),
      client.readContract({ address: source, abi: v2VaultAbi, functionName: 'asset', blockNumber }),
      client.readContract({ address: source, abi: v2VaultAbi, functionName: 'latestSharePrice', blockNumber }),
      client.readContract({ address: source, abi: v2VaultAbi, functionName: 'convertToAssets', args: [10n ** 18n], blockNumber }),
    ])
    requireSame(share, receipt, 'Vault share')
    accountingAsset = validAddress(asset, 'Accounting asset')
    rawRate = price
    if (converted !== price) throw new Error('The V2 share price is not expressed in raw accounting units per whole receipt.')
    warnings.push('Shift V2 does not expose a NAV observation timestamp. The configured reporter must attest the actual source price and observation time before the SY is ready for a pool.')
  }
  await requireCode(client, accountingAsset, blockNumber, 'Accounting asset')
  const [assetDecimals, assetSymbol] = await Promise.all([
    client.readContract({ address: accountingAsset, abi: tokenAbi, functionName: 'decimals', blockNumber }),
    client.readContract({ address: accountingAsset, abi: tokenAbi, functionName: 'symbol', blockNumber }),
  ])
  if (assetDecimals < 1 || assetDecimals > 18) throw new Error('Accounting asset decimals must be between 1 and 18.')
  positiveRate(rawRate)
  const rate = feedDecimals === null ? rawRate : rawRate * 10n ** BigInt(assetDecimals) / 10n ** BigInt(feedDecimals)
  positiveRate(rate)
  return { version: input.version, receipt, source, accountingAsset, receiptDecimals, assetDecimals, receiptSymbol, assetSymbol, rate, rateDisplay: formatUnits(rate, assetDecimals), sourceTimestamp, ...snap, warnings }
}

/** Contract creation calldata: callers send this WITHOUT a `to` address. */
export function buildOracleSyDeployment(config: OracleSyConfig): Hex {
  validConfig(config)
  return encodeDeployData({
    abi: ORACLE_SY_BOOTSTRAP_ABI,
    bytecode: ORACLE_SY_BOOTSTRAP_BYTECODE,
    args: [sourceKind(config.version), config.receipt, config.source, config.accountingAsset, config.maxAge, config.reporter, config.name, config.symbol, config.syOwner],
  })
}

interface DeploymentReceipt {
  status?: string
  contractAddress?: Address | null
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]
}

/** Only the bootstrap contract created by this transaction may announce addresses. */
export function decodeOracleSyDeployment(receipt: DeploymentReceipt, config: OracleSyConfig): OracleSyDeployment {
  validConfig(config)
  if (receipt.status !== 'success') throw new Error('Oracle SY deployment transaction did not succeed.')
  const emitter = validAddress(receipt.contractAddress, 'Deployment contract')
  let result: OracleSyDeployment | undefined
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, emitter)) continue
    let event
    try {
      event = decodeEventLog({ abi: ORACLE_SY_BOOTSTRAP_ABI, eventName: 'OracleSyDeployed', data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true })
    } catch { continue }
    if (result) throw new Error('Deployment emitted multiple OracleSyDeployed events.')
    const args = event.args
    if (args.sourceKind !== sourceKind(config.version)) throw new Error('Deployed source kind does not match the selected configuration.')
    requireSame(args.receipt, config.receipt, 'Deployed receipt')
    requireSame(args.accountingAsset, config.accountingAsset, 'Deployed accounting asset')
    const sy = validAddress(args.sy, 'Deployed SY')
    const oracle = validAddress(args.oracle, 'Deployed oracle')
    if (sameAddress(sy, oracle) || sameAddress(sy, emitter) || sameAddress(oracle, emitter)) throw new Error('Deployment returned overlapping contract addresses.')
    result = { sy, oracle }
  }
  if (!result) throw new Error('No trusted OracleSyDeployed event was found in the deployment receipt.')
  return result
}

/** Confirm all immutable bindings and ownership before accepting a new SY. */
export async function verifyOracleSyDeployment(
  client: PublicClient,
  deployment: OracleSyDeployment,
  config: OracleSyConfig,
  options: { verifyInitialOwner?: boolean } = {},
): Promise<void> {
  validConfig(config)
  const sy = validAddress(deployment.sy, 'SY')
  const oracle = validAddress(deployment.oracle, 'Oracle')
  if (sameAddress(sy, oracle)) throw new Error('SY and oracle addresses must differ.')
  const { blockNumber } = await snapshot(client)
  await Promise.all([requireCode(client, sy, blockNumber, 'SY'), requireCode(client, oracle, blockNumber, 'Oracle')])
  const [yieldToken, assetInfo, decimals, name, symbol, owner, tokensIn, tokensOut, syOracle, kind, receipt, source, asset, maxAge, reporter, accountingDecimals, tvlFeed, feedDecimals, actualAssetDecimals, actualReceiptDecimals] = await Promise.all([
    client.readContract({ address: sy, abi: syAbi, functionName: 'yieldToken', blockNumber }),
    client.readContract({ address: sy, abi: syAbi, functionName: 'assetInfo', blockNumber }),
    client.readContract({ address: sy, abi: syAbi, functionName: 'decimals', blockNumber }),
    client.readContract({ address: sy, abi: syAbi, functionName: 'name', blockNumber }),
    client.readContract({ address: sy, abi: syAbi, functionName: 'symbol', blockNumber }),
    client.readContract({ address: sy, abi: syAbi, functionName: 'owner', blockNumber }),
    client.readContract({ address: sy, abi: syAbi, functionName: 'getTokensIn', blockNumber }),
    client.readContract({ address: sy, abi: syAbi, functionName: 'getTokensOut', blockNumber }),
    client.readContract({ address: sy, abi: syAbi, functionName: 'exchangeRateOracle', blockNumber }),
    client.readContract({ address: oracle, abi: oracleSyOracleAbi, functionName: 'sourceKind', blockNumber }),
    client.readContract({ address: oracle, abi: oracleSyOracleAbi, functionName: 'receipt', blockNumber }),
    client.readContract({ address: oracle, abi: oracleSyOracleAbi, functionName: 'source', blockNumber }),
    client.readContract({ address: oracle, abi: oracleSyOracleAbi, functionName: 'accountingAsset', blockNumber }),
    client.readContract({ address: oracle, abi: oracleSyOracleAbi, functionName: 'maxAge', blockNumber }),
    client.readContract({ address: oracle, abi: oracleSyOracleAbi, functionName: 'reporter', blockNumber }),
    client.readContract({ address: oracle, abi: oracleSyOracleAbi, functionName: 'accountingDecimals', blockNumber }),
    client.readContract({ address: oracle, abi: oracleSyOracleAbi, functionName: 'tvlFeed', blockNumber }),
    client.readContract({ address: oracle, abi: oracleSyOracleAbi, functionName: 'feedDecimals', blockNumber }),
    client.readContract({ address: config.accountingAsset, abi: tokenAbi, functionName: 'decimals', blockNumber }),
    client.readContract({ address: config.receipt, abi: tokenAbi, functionName: 'decimals', blockNumber }),
  ])
  requireSame(yieldToken, config.receipt, 'SY yield token')
  requireSame(assetInfo[1], config.accountingAsset, 'SY accounting asset')
  if (options.verifyInitialOwner !== false) requireSame(owner, config.syOwner, 'SY owner')
  requireSame(syOracle, oracle, 'SY oracle')
  requireSame(receipt, config.receipt, 'Oracle receipt')
  requireSame(source, config.source, 'Oracle source')
  requireSame(asset, config.accountingAsset, 'Oracle accounting asset')
  requireSame(reporter, config.reporter, 'Oracle reporter')
  if (assetInfo[0] !== 0 || assetInfo[2] !== accountingDecimals || accountingDecimals !== actualAssetDecimals || accountingDecimals < 1 || accountingDecimals > 18 || decimals !== 18 || actualReceiptDecimals !== 18) throw new Error('Deployed SY accounting units do not match its oracle.')
  if (kind !== sourceKind(config.version) || maxAge !== config.maxAge) throw new Error('Deployed oracle profile does not match the selected configuration.')
  if (name !== config.name || symbol !== config.symbol) throw new Error('Deployed SY metadata does not match the selected configuration.')
  if (tokensIn.length !== 1 || tokensOut.length !== 1) throw new Error('The SY must accept and return only the Shift receipt.')
  requireSame(tokensIn[0], config.receipt, 'SY input token')
  requireSame(tokensOut[0], config.receipt, 'SY output token')
  if (config.version === 'shift-v1') {
    const [currentFeed, currentAsset] = await Promise.all([
      client.readContract({ address: config.source, abi: v1Abi, functionName: 'tvlFeed', blockNumber }),
      client.readContract({ address: config.source, abi: v1Abi, functionName: 'baseToken', blockNumber }),
    ])
    requireSame(currentFeed, tvlFeed, 'Oracle TVL feed')
    requireSame(currentAsset, config.accountingAsset, 'Current source accounting asset')
    const currentFeedDecimals = await client.readContract({ address: tvlFeed, abi: feedAbi, functionName: 'decimals', blockNumber })
    if (currentFeedDecimals !== feedDecimals || feedDecimals > 18) throw new Error('Oracle TVL feed units changed.')
  } else {
    const [currentVault, currentShare, currentAsset, currentPrice, converted] = await Promise.all([
      client.readContract({ address: config.receipt, abi: v2ReceiptAbi, functionName: 'vault', blockNumber }),
      client.readContract({ address: config.source, abi: v2VaultAbi, functionName: 'share', blockNumber }),
      client.readContract({ address: config.source, abi: v2VaultAbi, functionName: 'asset', blockNumber }),
      client.readContract({ address: config.source, abi: v2VaultAbi, functionName: 'latestSharePrice', blockNumber }),
      client.readContract({ address: config.source, abi: v2VaultAbi, functionName: 'convertToAssets', args: [10n ** 18n], blockNumber }),
    ])
    requireSame(currentVault, config.source, 'Current receipt vault')
    requireSame(currentShare, config.receipt, 'Current vault share')
    requireSame(currentAsset, config.accountingAsset, 'Current source accounting asset')
    if (converted !== currentPrice || currentPrice === 0n) throw new Error('The V2 source price does not match its receipt conversion units.')
    if (!sameAddress(tvlFeed, ZERO) || feedDecimals !== accountingDecimals) throw new Error('Oracle V2 accounting profile does not match the selected configuration.')
  }
}

/** A deployment can be valid but unready while V2 awaits its first attestation. */
export async function readOracleSyReadiness(client: PublicClient, deployment: OracleSyDeployment, config: OracleSyConfig): Promise<OracleSyReadiness> {
  try {
    await verifyOracleSyDeployment(client, deployment, config, { verifyInitialOwner: false })
    const probe = await inspectOracleSySource(client, config)
    requireSame(probe.accountingAsset, config.accountingAsset, 'Current source accounting asset')
    const blockNumber = probe.blockNumber
    if (config.version === 'shift-v2') {
      const [observedAt, price] = await Promise.all([
        client.readContract({ address: deployment.oracle, abi: oracleSyOracleAbi, functionName: 'lastObservedAt', blockNumber }),
        client.readContract({ address: deployment.oracle, abi: oracleSyOracleAbi, functionName: 'lastObservedPrice', blockNumber }),
      ])
      freshTimestamp(observedAt, probe.blockTimestamp, config.maxAge)
      if (price !== probe.rate) throw new Error('The reporter must attest the current Shift V2 source price.')
    }
    const [rate, syRate, paused] = await Promise.all([
      client.readContract({ address: deployment.oracle, abi: oracleSyOracleAbi, functionName: 'getExchangeRate', blockNumber }),
      client.readContract({ address: deployment.sy, abi: syAbi, functionName: 'exchangeRate', blockNumber }),
      client.readContract({ address: deployment.sy, abi: syAbi, functionName: 'paused', blockNumber }),
    ])
    if (paused) throw new Error('The SY is paused. Its owner must unpause it before creating or seeding a pool.')
    positiveRate(rate)
    if (rate !== probe.rate || rate !== syRate) throw new Error('The SY exchange rate does not match the current source price.')
    return { ready: true, rate }
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) }
  }
}
