#!/usr/bin/env node
/**
 * Build the static v1 directory of every market emitted by OpenPendle's known
 * Pendle MarketFactory deployments.
 *
 * Inventory comes only from CreateNewMarket logs. Pendle's public API is not
 * used here; the browser joins it later as optional listing/metric enrichment.
 * The job is incremental, rewinds a bounded reorg window, and publishes chain
 * coverage explicitly so a failed scan can never masquerade as an empty chain.
 *
 * Usage (from app/):
 *   npm run index:factory-markets
 *   npm run index:factory-markets -- --chain 42161
 *   npm run check:factory-markets
 *
 * Reliable initial history needs archive/log-capable RPC URLs:
 *   ETHEREUM_RPC_URL, BSC_RPC_URL, MONAD_RPC_URL,
 *   BASE_RPC_URL, PLASMA_RPC_URL, ARBITRUM_RPC_URL
 * Optional Etherscan-compatible history endpoints use the same prefixes with
 * LOG_API_URL (notably BSC_LOG_API_URL and MONAD_LOG_API_URL).
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  numberToHex,
} from 'viem'
import {
  ADDRESS_BOOKS,
  FALLBACK_RPCS,
  SUPPORTED_CHAINS,
  isSupportedChainId,
} from '../src/lib/addresses.ts'
import {
  FACTORY_MARKET_EVENT_TOPICS,
  FACTORY_MARKET_SNAPSHOT_DATASET,
  FACTORY_MARKET_SNAPSHOT_SCHEMA_VERSION,
  parseFactoryMarketSnapshot,
} from '../src/lib/catalog.ts'
import { commonDeployAbi, marketReadAbi } from '../src/lib/pendleAbi.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUTPUT = resolve(SCRIPT_DIR, '../public/catalog/factory-markets.v1.json')
const REORG_WINDOW_BLOCKS = 256
const RPC_TIMEOUT_MS = 30_000
const RPC_RETRY_ROUNDS = 4
const RPC_RETRY_BASE_DELAY_MS = 250
const RPC_LOG_CONCURRENCY = 8
const RPC_LOG_RANGE_RETRY_ROUNDS = 2
const INDEXED_PROXY_MIN_INTERVAL_MS = 350
const LOG_CHUNK_SIZES = [10_000_000, 1_000_000, 100_000, 50_000, 10_000, 2_000]
const HYDRATION_CONCURRENCY = 4
const MAX_PUBLIC_ERRORS = 100
const INDEXED_LOG_PAGE_SIZE = 1_000
const MAX_INDEXED_LOG_PAGES = 100

const INDEXED_LOG_API = {
  1: 'https://eth.blockscout.com/api',
  8453: 'https://base.blockscout.com/api',
  9745: 'https://api.routescan.io/v2/network/mainnet/evm/9745/etherscan/api',
  42161: 'https://arbitrum.blockscout.com/api',
}

const RPC_ENV = {
  1: 'ETHEREUM_RPC_URL',
  56: 'BSC_RPC_URL',
  143: 'MONAD_RPC_URL',
  8453: 'BASE_RPC_URL',
  9745: 'PLASMA_RPC_URL',
  42161: 'ARBITRUM_RPC_URL',
}

const LOG_API_ENV = {
  1: 'ETHEREUM_LOG_API_URL',
  56: 'BSC_LOG_API_URL',
  143: 'MONAD_LOG_API_URL',
  8453: 'BASE_LOG_API_URL',
  9745: 'PLASMA_LOG_API_URL',
  42161: 'ARBITRUM_LOG_API_URL',
}

// Conservative enough for a daily discovery artifact; callers can override
// per chain with OPENPENDLE_CONFIRMATIONS_<chainId>.
const DEFAULT_CONFIRMATIONS = {
  1: 24,
  56: 64,
  143: 64,
  8453: 120,
  9745: 64,
  42161: 120,
}

const PROVENANCE = {
  source: 'pendle-market-factory-events',
  factoryConfig: 'app/src/lib/addresses.ts',
  eventSignatures: {
    v1: 'CreateNewMarket(address,address,int256,int256)',
    v3Plus: 'CreateNewMarket(address,address,int256,int256,uint256)',
  },
  eventTopics: {
    v1: FACTORY_MARKET_EVENT_TOPICS.v1,
    v3Plus: FACTORY_MARKET_EVENT_TOPICS.v3Plus,
  },
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function parseArgs(argv) {
  const options = {
    check: false,
    requireComplete: false,
    reset: false,
    output: DEFAULT_OUTPUT,
    chains: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--require-complete') options.requireComplete = true
    else if (arg === '--reset') options.reset = true
    else if (arg === '--output') {
      const value = argv[index + 1]
      if (!value) throw new Error('--output requires a path')
      options.output = resolve(process.cwd(), value)
      index += 1
    } else if (arg === '--chain') {
      const value = argv[index + 1]
      const chainId = Number(value)
      if (!Number.isInteger(chainId) || !isSupportedChainId(chainId)) {
        throw new Error(`Unsupported --chain value: ${String(value)}`)
      }
      options.chains ??= []
      options.chains.push(chainId)
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (options.requireComplete && !options.check) {
    throw new Error('--require-complete can only be used with --check')
  }
  if (options.chains !== null) options.chains = [...new Set(options.chains)]
  return options
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<rpc>')
    .replace(/((?:api[_-]?key|token|secret|auth)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'Unknown indexing error'
}

function lowerAddress(value, label = 'address') {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value) || BigInt(value) === 0n) {
    throw new Error(`Invalid ${label}`)
  }
  return getAddress(value).toLowerCase()
}

function hash(value, label = 'hash') {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value.toLowerCase()
}

function quantity(value, label = 'quantity') {
  if (value === '0x') return 0 // Some Etherscan-compatible APIs encode zero this way.
  if (typeof value !== 'string' || !/^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Unsafe ${label}`)
  return number
}

function confirmationsFor(chainId) {
  const configured = Number(process.env[`OPENPENDLE_CONFIRMATIONS_${chainId}`])
  return Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_CONFIRMATIONS[chainId]
}

function rpcUrlsFor(chainId) {
  const envName = RPC_ENV[chainId]
  const configured = process.env[envName]?.trim()
  if (configured) {
    const urls = configured.split(',').map((url) => url.trim()).filter(Boolean)
    if (urls.length > 0) return urls
  }
  return [...FALLBACK_RPCS[chainId]]
}

function indexedLogApiFor(chainId) {
  return process.env[LOG_API_ENV[chainId]]?.trim() || INDEXED_LOG_API[chainId]
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function indexedProxyRequestUrl(endpoint, method, params) {
  const url = new URL(endpoint)
  for (const key of [
    'module',
    'action',
    'fromBlock',
    'toBlock',
    'address',
    'topic0',
    'page',
    'offset',
    'tag',
    'boolean',
    'to',
    'data',
  ]) {
    url.searchParams.delete(key)
  }
  url.searchParams.set('module', 'proxy')
  url.searchParams.set('action', method)

  if (method === 'eth_blockNumber') return url
  if (method === 'eth_getBlockByNumber') {
    url.searchParams.set('tag', String(params[0]))
    url.searchParams.set('boolean', String(params[1] === true))
    return url
  }
  if (method === 'eth_getCode') {
    url.searchParams.set('address', String(params[0]))
    url.searchParams.set('tag', String(params[1]))
    return url
  }
  if (method === 'eth_call') {
    const call = params[0]
    if (call === null || typeof call !== 'object') {
      throw new Error('Invalid eth_call proxy parameters')
    }
    url.searchParams.set('to', String(call.to))
    url.searchParams.set('data', String(call.data))
    url.searchParams.set('tag', String(params[1]))
    return url
  }
  throw new Error(`Unsupported indexed proxy method: ${method}`)
}

function parseIndexedProxyPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Indexed proxy returned an invalid response')
  }
  if (payload.error) {
    const code = Number(payload.error.code)
    throw new Error(
      Number.isSafeInteger(code)
        ? `Indexed proxy failed with code ${code}`
        : 'Indexed proxy request failed',
    )
  }
  if (
    payload.status !== undefined &&
    payload.status !== '1' &&
    payload.status !== 1
  ) {
    // Etherscan returns rate limits, invalid keys, and other gateway failures
    // as HTTP 200 with status=0 and a remote-controlled result.
    throw new Error('Indexed proxy returned an error envelope')
  }
  if (!Object.hasOwn(payload, 'result')) {
    throw new Error('Indexed proxy response has no result')
  }
  return payload.result
}

class RpcClient {
  constructor(chainId, urls, indexedProxyEndpoint = null) {
    this.chainId = chainId
    this.urls = urls
    this.indexedProxyEndpoint = indexedProxyEndpoint
    this.indexedProxyQueue = Promise.resolve()
    this.indexedProxyNextAt = 0
    this.nextId = 1
  }

  async request(method, params) {
    let lastError
    if (
      this.indexedProxyEndpoint !== null &&
      ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(method)
    ) {
      for (let round = 0; round < RPC_RETRY_ROUNDS; round += 1) {
        try {
          return await this.requestIndexedProxy(method, params)
        } catch (error) {
          lastError = error
          if (round < RPC_RETRY_ROUNDS - 1) {
            await delay(RPC_RETRY_BASE_DELAY_MS * (2 ** round))
          }
        }
      }
    }

    for (let round = 0; round < RPC_RETRY_ROUNDS; round += 1) {
      for (const url of this.urls) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: this.nextId++,
              method,
              params,
            }),
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          if (payload === null || typeof payload !== 'object') {
            throw new Error('Invalid JSON-RPC response')
          }
          if (payload.error) {
            // RPC error messages are remote-controlled and have been observed
            // to echo credential-bearing endpoint fragments. Persist only the
            // public numeric code; never copy a provider's message into the
            // generated artifact or workflow log.
            const code = Number(payload.error.code)
            throw new Error(
              Number.isSafeInteger(code)
                ? `JSON-RPC request failed with code ${code}`
                : 'JSON-RPC request failed',
            )
          }
          return payload.result
        } catch (error) {
          lastError = error
        } finally {
          clearTimeout(timeout)
        }
      }
      if (round < RPC_RETRY_ROUNDS - 1) {
        await delay(RPC_RETRY_BASE_DELAY_MS * (2 ** round))
      }
    }
    throw new Error(`${method} failed on chain ${this.chainId}: ${safeError(lastError)}`)
  }

  async requestIndexedProxy(method, params) {
    const execute = async () => {
      const url = indexedProxyRequestUrl(this.indexedProxyEndpoint, method, params)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Indexed proxy returned HTTP ${response.status}`)
        const payload = await response.json()
        return parseIndexedProxyPayload(payload)
      } finally {
        clearTimeout(timeout)
      }
    }

    return this.scheduleIndexedRequest(execute)
  }

  async scheduleIndexedRequest(execute) {
    const scheduled = this.indexedProxyQueue.then(async () => {
      const wait = Math.max(0, this.indexedProxyNextAt - Date.now())
      if (wait > 0) await delay(wait)
      this.indexedProxyNextAt = Date.now() + INDEXED_PROXY_MIN_INTERVAL_MS
      return execute()
    })
    this.indexedProxyQueue = scheduled.catch(() => undefined)
    return scheduled
  }
}

async function blockAt(client, blockNumber) {
  const raw = await client.request('eth_getBlockByNumber', [numberToHex(blockNumber), false])
  if (raw === null || typeof raw !== 'object') throw new Error(`Block ${blockNumber} unavailable`)
  return {
    number: quantity(raw.number, 'block number'),
    hash: hash(raw.hash, 'block hash'),
    timestamp: quantity(raw.timestamp, 'block timestamp'),
  }
}

async function findDeploymentBlock(client, address, high) {
  // Verify against the same finalized head the snapshot will claim. Historical
  // binary search is an optimization only: many otherwise log-capable RPCs
  // prune old state, so failure falls back to the safe genesis lower bound.
  const safeCode = await client.request('eth_getCode', [address, numberToHex(high)])
  if (typeof safeCode !== 'string' || safeCode === '0x') {
    throw new Error(`Configured factory ${address} has no code at the safe head`)
  }

  try {
    let low = 0
    let upper = high
    while (low < upper) {
      const middle = Math.floor((low + upper) / 2)
      const code = await client.request('eth_getCode', [address, numberToHex(middle)])
      if (typeof code !== 'string') throw new Error('Invalid eth_getCode response')
      if (code === '0x') low = middle + 1
      else upper = middle
    }
    return low
  } catch {
    return null
  }
}

async function scanFactoryLogs(client, factory, topic, fromBlock, toBlock) {
  if (fromBlock > toBlock) return []

  // Indexed endpoints make both initial and incremental scans reliable on
  // chains whose public RPCs reject historical log ranges. Built-in keyless
  // endpoints are preferred where available; BSC/Monad use configured ones.
  const indexedApi = indexedLogApiFor(client.chainId)
  if (indexedApi) {
    try {
      return await scanIndexedLogs(
        client,
        indexedApi,
        factory,
        topic,
        fromBlock,
        toBlock,
      )
    } catch {
      // Fall back to adaptive RPC chunks; coverage remains failed-closed if
      // both providers reject the range.
    }
  }

  // Probe one leading range to discover the provider's supported window, then
  // scan independent windows concurrently. This matters for archive providers
  // whose valid empty-log responses can still take seconds. Each window keeps
  // the same retries, envelope validation, and adaptive subdivision, and
  // mapLimit preserves deterministic range order.
  let sizeIndex = 0
  let firstEnd
  let firstLogs
  while (true) {
    const size = LOG_CHUNK_SIZES[sizeIndex]
    firstEnd = Math.min(toBlock, fromBlock + size - 1)
    try {
      firstLogs = await requestRpcLogRange(client, factory, topic, fromBlock, firstEnd)
      break
    } catch (error) {
      if (sizeIndex >= LOG_CHUNK_SIZES.length - 1) throw error
      sizeIndex += 1
    }
  }

  const ranges = []
  const size = LOG_CHUNK_SIZES[sizeIndex]
  for (let cursor = firstEnd + 1; cursor <= toBlock; cursor += size) {
    ranges.push({ fromBlock: cursor, toBlock: Math.min(toBlock, cursor + size - 1) })
  }
  const chunks = await mapLimit(ranges, RPC_LOG_CONCURRENCY, (range) =>
    scanRpcLogRangeAdaptive(
      client,
      factory,
      topic,
      range.fromBlock,
      range.toBlock,
      sizeIndex,
    ),
  )
  return [...firstLogs, ...chunks.flat()]
}

async function requestRpcLogRange(client, factory, topic, fromBlock, toBlock) {
  const result = await client.request('eth_getLogs', [{
    address: factory,
    topics: [topic],
    fromBlock: numberToHex(fromBlock),
    toBlock: numberToHex(toBlock),
  }])
  if (!Array.isArray(result)) throw new Error('Invalid eth_getLogs response')
  for (const entry of result) assertLogEnvelope(entry, factory, topic, fromBlock, toBlock)
  return result
}

async function scanRpcLogRangeAdaptive(
  client,
  factory,
  topic,
  fromBlock,
  toBlock,
  sizeIndex,
) {
  let lastError
  for (let round = 0; round < RPC_LOG_RANGE_RETRY_ROUNDS; round += 1) {
    try {
      return await requestRpcLogRange(client, factory, topic, fromBlock, toBlock)
    } catch (error) {
      lastError = error
      if (round < RPC_LOG_RANGE_RETRY_ROUNDS - 1) {
        await delay(1_000 * (2 ** round))
      }
    }
  }
  if (sizeIndex >= LOG_CHUNK_SIZES.length - 1) throw lastError

  const childSizeIndex = sizeIndex + 1
  const childSize = LOG_CHUNK_SIZES[childSizeIndex]
  const logs = []
  for (let cursor = fromBlock; cursor <= toBlock; cursor += childSize) {
    const end = Math.min(toBlock, cursor + childSize - 1)
    logs.push(...await scanRpcLogRangeAdaptive(
      client,
      factory,
      topic,
      cursor,
      end,
      childSizeIndex,
    ))
  }
  return logs
}

function assertLogEnvelope(log, factory, topic, fromBlock, toBlock) {
  if (log === null || typeof log !== 'object') {
    throw new Error('Log provider returned a malformed entry')
  }
  if (lowerAddress(log.address, 'log address') !== factory.toLowerCase()) {
    throw new Error('Log provider returned an entry for the wrong factory')
  }
  const blockNumber = quantity(log.blockNumber, 'log block number')
  if (blockNumber < fromBlock || blockNumber > toBlock) {
    throw new Error('Log provider returned an entry outside the requested range')
  }
  if (
    !Array.isArray(log.topics) ||
    typeof log.topics[0] !== 'string' ||
    log.topics[0].toLowerCase() !== topic
  ) {
    throw new Error('Log provider returned an entry with the wrong event topic')
  }
}

async function scanIndexedLogs(
  client,
  endpoint,
  factory,
  topic,
  fromBlock,
  toBlock,
  {
    fetchImpl = fetch,
    maxPages = MAX_INDEXED_LOG_PAGES,
  } = {},
) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_INDEXED_LOG_PAGES) {
    throw new Error('Invalid indexed log page limit')
  }

  const baseUrl = new URL(endpoint)
  baseUrl.searchParams.set('module', 'logs')
  baseUrl.searchParams.set('action', 'getLogs')
  baseUrl.searchParams.set('fromBlock', String(fromBlock))
  baseUrl.searchParams.set('toBlock', String(toBlock))
  baseUrl.searchParams.set('address', factory)
  baseUrl.searchParams.set('topic0', topic)
  baseUrl.searchParams.set('offset', String(INDEXED_LOG_PAGE_SIZE))

  const blocks = new Map()
  const logs = []
  const seenLogIdentities = new Set()
  const seenPageFingerprints = new Set()

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(baseUrl)
    url.searchParams.set('page', String(page))
    let pageEntries
    let lastError
    let fetched = false
    for (let round = 0; round < RPC_RETRY_ROUNDS; round += 1) {
      const fetchPage = async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
        try {
          const response = await fetchImpl(url, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
          })
          if (!response?.ok) {
            const status = Number(response?.status)
            throw new Error(
              Number.isSafeInteger(status)
                ? `Indexed log API returned HTTP ${status}`
                : 'Indexed log API request failed',
            )
          }
          const payload = await response.json()
          return parseIndexedLogPage(payload)
        } finally {
          clearTimeout(timeout)
        }
      }

      try {
        pageEntries = typeof client.scheduleIndexedRequest === 'function'
          ? await client.scheduleIndexedRequest(fetchPage)
          : await fetchPage()
        fetched = true
        break
      } catch (error) {
        lastError = error
        if (round < RPC_RETRY_ROUNDS - 1) {
          await delay(RPC_RETRY_BASE_DELAY_MS * (2 ** round))
        }
      }
    }
    if (!fetched) {
      throw new Error(`Indexed log API request failed: ${safeError(lastError)}`)
    }

    if (pageEntries.length > INDEXED_LOG_PAGE_SIZE) {
      throw new Error('Indexed log API exceeded the requested page size')
    }

    const identities = pageEntries.map((entry) => {
      assertLogEnvelope(entry, factory, topic, fromBlock, toBlock)
      return indexedLogIdentity(entry)
    })
    const fingerprint = identities.join('|')
    if (pageEntries.length > 0 && seenPageFingerprints.has(fingerprint)) {
      throw new Error('Indexed log API repeated a page')
    }
    if (pageEntries.length > 0) seenPageFingerprints.add(fingerprint)

    for (let index = 0; index < pageEntries.length; index += 1) {
      const entry = pageEntries[index]
      const identity = identities[index]
      if (seenLogIdentities.has(identity)) {
        throw new Error('Indexed log API returned a duplicate log across pages')
      }
      seenLogIdentities.add(identity)

      const blockNumber = quantity(entry.blockNumber, 'indexed log block number')
      let blockHash
      if (typeof entry.blockHash === 'string' && HASH_RE.test(entry.blockHash)) {
        blockHash = entry.blockHash.toLowerCase()
      } else {
        let block = blocks.get(blockNumber)
        if (block === undefined) {
          block = await blockAt(client, blockNumber)
          blocks.set(blockNumber, block)
        }
        blockHash = block.hash
      }
      const normalized = {
        ...entry,
        blockNumber: numberToHex(blockNumber),
        blockHash,
      }
      assertLogEnvelope(normalized, factory, topic, fromBlock, toBlock)
      logs.push(normalized)
    }

    // Etherscan-style APIs use a short page as the end marker. Blockscout's
    // legacy endpoint accepts page/offset but repeats a short result for every
    // page, so probing past a short page would reject otherwise-valid scans.
    if (pageEntries.length < INDEXED_LOG_PAGE_SIZE) return logs
  }

  throw new Error('Indexed log API reached the maximum page limit')
}

function parseIndexedLogPage(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Indexed log API returned an invalid envelope')
  }

  let status
  if (payload.status !== undefined) {
    if (
      payload.status !== '0' && payload.status !== '1' &&
      payload.status !== 0 && payload.status !== 1
    ) {
      throw new Error('Indexed log API returned an invalid status')
    }
    status = String(payload.status)
  }
  if (payload.message !== undefined && typeof payload.message !== 'string') {
    throw new Error('Indexed log API returned an invalid message')
  }

  const noRecordsText = [
    typeof payload.message === 'string' ? payload.message : '',
    typeof payload.result === 'string' ? payload.result : '',
  ].join(' ')
  const noRecords = /\bno (?:records|logs) found\b/i.test(noRecordsText)

  if (!Array.isArray(payload.result)) {
    if (noRecords && (status === undefined || status === '0')) return []
    throw new Error('Indexed log API returned an invalid result')
  }
  if (payload.result.length > 0) {
    if (status === '0' || noRecords) {
      throw new Error('Indexed log API returned an inconsistent success envelope')
    }
    return payload.result
  }
  if (status === '0' && !noRecords) {
    throw new Error('Indexed log API returned an error envelope')
  }
  return []
}

function indexedLogIdentity(entry) {
  if (entry === null || typeof entry !== 'object') {
    throw new Error('Indexed log API returned a malformed log')
  }
  const blockNumber = quantity(entry.blockNumber, 'indexed log block number')
  const transactionHash = hash(entry.transactionHash, 'indexed log transaction hash')
  const logIndex = quantity(entry.logIndex, 'indexed log index')
  return `${blockNumber}:${transactionHash}:${logIndex}`
}

function topicAddress(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new Error(`Invalid ${label}`)
  return lowerAddress(`0x${value.slice(-40)}`, label)
}

function decodeMarketLog(log, chainId, factory, generation, eventVersion) {
  if (log === null || typeof log !== 'object' || log.removed === true) {
    throw new Error('Removed or malformed factory log')
  }
  if (!Array.isArray(log.topics) || log.topics.length < 3) {
    throw new Error('Factory log has missing indexed topics')
  }
  if (lowerAddress(log.address, 'factory log address') !== factory) {
    throw new Error('Factory log address does not match its configured factory')
  }
  const expectedTopic = eventVersion === 'v1'
    ? FACTORY_MARKET_EVENT_TOPICS.v1
    : FACTORY_MARKET_EVENT_TOPICS.v3Plus
  if (String(log.topics[0]).toLowerCase() !== expectedTopic) {
    throw new Error('Factory log has the wrong event topic')
  }
  const parameters = eventVersion === 'v1'
    ? decodeAbiParameters(
        [{ type: 'int256' }, { type: 'int256' }],
        log.data,
      )
    : decodeAbiParameters(
        [{ type: 'int256' }, { type: 'int256' }, { type: 'uint256' }],
        log.data,
      )

  const address = topicAddress(log.topics[1], 'market topic')
  const pt = topicAddress(log.topics[2], 'PT topic')
  const createdAt = log.timeStamp === undefined
    ? undefined
    : quantity(log.timeStamp, 'log timestamp')
  return {
    key: `${chainId}:${address}`,
    chainId,
    address,
    pt,
    factory,
    factoryGeneration: generation,
    eventVersion,
    blockNumber: quantity(log.blockNumber, 'log block number'),
    blockHash: hash(log.blockHash, 'log block hash'),
    transactionHash: hash(log.transactionHash, 'transaction hash'),
    logIndex: quantity(log.logIndex, 'log index'),
    scalarRoot: parameters[0].toString(),
    initialAnchor: parameters[1].toString(),
    lnFeeRateRoot: eventVersion === 'v1' ? null : parameters[2].toString(),
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

async function ethCall(client, address, functionName, blockNumber) {
  const data = encodeFunctionData({ abi: marketReadAbi, functionName })
  const result = await client.request('eth_call', [
    { to: address, data },
    typeof blockNumber === 'number' ? numberToHex(blockNumber) : blockNumber,
  ])
  if (typeof result !== 'string' || !result.startsWith('0x')) {
    throw new Error(`Invalid ${functionName} result`)
  }
  return decodeFunctionResult({ abi: marketReadAbi, functionName, data: result })
}

async function activeFactoryAt(client, address, blockNumber) {
  const data = encodeFunctionData({ abi: commonDeployAbi, functionName: 'marketFactory' })
  const result = await client.request('eth_call', [
    { to: address, data },
    typeof blockNumber === 'number' ? numberToHex(blockNumber) : blockNumber,
  ])
  return lowerAddress(
    decodeFunctionResult({
      abi: commonDeployAbi,
      functionName: 'marketFactory',
      data: result,
    }),
    'commonDeploy marketFactory',
  )
}

async function hydrateMarket(client, market, blockCache, safeBlock) {
  const hydrated = { ...market }
  if (hydrated.createdAt === undefined) {
    try {
      let createdBlock = blockCache.get(market.blockNumber)
      if (createdBlock === undefined) {
        createdBlock = await blockAt(client, market.blockNumber)
        blockCache.set(market.blockNumber, createdBlock)
      }
      hydrated.createdAt = createdBlock.timestamp
    } catch {
      // Creation time is display enrichment; inventory remains complete.
    }
  }

  if (hydrated.sy === undefined || hydrated.yt === undefined) {
    try {
      const [sy, pt, yt] = await ethCall(client, market.address, 'readTokens', safeBlock)
      if (lowerAddress(pt, 'readTokens PT') === market.pt) {
        hydrated.sy = lowerAddress(sy, 'readTokens SY')
        hydrated.yt = lowerAddress(yt, 'readTokens YT')
      }
    } catch {
      // A factory event is still retained when optional hydration fails.
    }
  }

  if (hydrated.expiry === undefined) {
    try {
      const expiry = await ethCall(client, market.address, 'expiry', safeBlock)
      const numeric = Number(expiry)
      if (Number.isSafeInteger(numeric) && numeric > 0) hydrated.expiry = numeric
    } catch {
      // The market page will perform the authoritative live read when opened.
    }
  }

  if (hydrated.name === undefined) {
    try {
      const name = await ethCall(client, market.address, 'name', safeBlock)
      if (typeof name === 'string' && name.trim()) hydrated.name = name.trim().slice(0, 160)
    } catch {
      // Generic fallback is supplied by the browser catalog model.
    }
  }
  return hydrated
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= values.length) return
      results[index] = await mapper(values[index], index)
    }
  }
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(limit, values.length) }, worker),
  )
  const failure = workers.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  return results
}

function emptyChain(chainId) {
  return {
    chainId,
    complete: false,
    indexedThrough: null,
    indexedThroughHash: null,
    indexedThroughTimestamp: null,
    reorgAnchor: null,
    factories: [],
    marketCount: 0,
    quarantinedLogCount: 0,
    errors: ['Initial factory scan has not run yet.'],
    markets: [],
  }
}

function emptySnapshot() {
  return {
    schemaVersion: FACTORY_MARKET_SNAPSHOT_SCHEMA_VERSION,
    dataset: FACTORY_MARKET_SNAPSHOT_DATASET,
    provenance: PROVENANCE,
    coverage: {
      complete: false,
      completeChains: [],
      totalChains: SUPPORTED_CHAINS.length,
      marketCount: 0,
      quarantinedLogCount: 0,
    },
    chains: SUPPORTED_CHAINS.map((chain) => emptyChain(chain.id)),
  }
}

async function readSnapshot(path, reset) {
  if (reset) return emptySnapshot()
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parseFactoryMarketSnapshot(parsed)
  } catch (error) {
    if (error?.code === 'ENOENT') return emptySnapshot()
    throw new Error(`Refusing to overwrite an invalid checkpoint: ${safeError(error)}`)
  }
}

function previousFactory(chain, address) {
  return chain.factories.find((entry) => entry.address === address)
}

function canResumeFactoryCheckpoint(chain, checkpoint, completeCheckpointMatches) {
  return checkpoint !== undefined &&
    checkpoint.indexedThrough !== null &&
    chain.quarantinedLogCount === 0 &&
    (!chain.complete || completeCheckpointMatches)
}

async function anchorMatches(client, chain) {
  if (chain.reorgAnchor === null) return false
  try {
    const block = await blockAt(client, chain.reorgAnchor.blockNumber)
    return block.hash === chain.reorgAnchor.blockHash
  } catch {
    return false
  }
}

function addPublicError(errors, value) {
  if (errors.length >= MAX_PUBLIC_ERRORS) return
  const message = safeError(value)
  if (!errors.includes(message)) errors.push(message)
}

async function indexChain(chainId, previous) {
  const indexedProxyEndpoint = indexedLogApiFor(chainId) ?? null
  const client = new RpcClient(chainId, rpcUrlsFor(chainId), indexedProxyEndpoint)
  const book = ADDRESS_BOOKS[chainId]
  const latest = quantity(await client.request('eth_blockNumber', []), 'latest block')
  const safeBlock = Math.max(0, latest - confirmationsFor(chainId))
  if (previous.indexedThrough !== null && previous.indexedThrough > safeBlock) {
    throw new Error(
      `RPC safe head ${safeBlock} is behind checkpoint ${previous.indexedThrough}`,
    )
  }
  const safeHead = await blockAt(client, safeBlock)
  // A complete checkpoint gets a stored reorg-anchor check. An incomplete
  // chain has no chain-level anchor, but individual factories that reached a
  // head remain reusable when no log was quarantined; each is still rewound
  // below before scanning so one failed generation does not force every
  // successful generation back to genesis.
  const completeCheckpointMatches = previous.complete && await anchorMatches(client, previous)
  const errors = []
  let quarantinedLogCount = 0
  const factories = []
  const marketMap = new Map()

  // A static factory list can otherwise look "complete" immediately after a
  // protocol rotation. Fail coverage closed until the new factory is added.
  try {
    const liveFactory = await activeFactoryAt(client, book.commonDeploy, safeBlock)
    if (
      !book.marketFactories.some(
        (factory) => factory.marketFactory.toLowerCase() === liveFactory,
      )
    ) {
      addPublicError(errors, `Active Pendle market factory is not configured: ${liveFactory}`)
    }
  } catch (error) {
    addPublicError(errors, `Could not verify the active Pendle market factory: ${safeError(error)}`)
  }

  for (const configured of book.marketFactories) {
    const factory = configured.marketFactory.toLowerCase()
    const eventVersion = configured.gen === 'v1' ? 'v1' : 'v3+'
    const topic = eventVersion === 'v1'
      ? FACTORY_MARKET_EVENT_TOPICS.v1
      : FACTORY_MARKET_EVENT_TOPICS.v3Plus
    const checkpoint = previousFactory(previous, factory)
    const canResumeFactory = canResumeFactoryCheckpoint(
      previous,
      checkpoint,
      completeCheckpointMatches,
    )
    let deploymentBlock
    let startBlockSource
    let indexedThrough = null

    try {
      if (checkpoint !== undefined) {
        deploymentBlock = checkpoint.deploymentBlock
        startBlockSource = 'checkpoint'
      } else {
        const derivedBlock = await findDeploymentBlock(client, factory, safeBlock)
        deploymentBlock = derivedBlock ?? 0
        startBlockSource = derivedBlock === null
          ? 'configured'
          : 'derived-code-binary-search'
      }

      const scanFrom = canResumeFactory
        ? Math.max(
            deploymentBlock,
            Math.min(checkpoint.indexedThrough, safeBlock) - REORG_WINDOW_BLOCKS + 1,
          )
        : deploymentBlock

      if (canResumeFactory) {
        for (const market of previous.markets) {
          if (market.factory === factory && market.blockNumber < scanFrom) {
            marketMap.set(market.key, market)
          }
        }
      }

      const rawLogs = await scanFactoryLogs(
        client,
        factory,
        topic,
        Math.max(0, scanFrom),
        safeBlock,
      )
      for (const rawLog of rawLogs) {
        try {
          const market = decodeMarketLog(
            rawLog,
            chainId,
            factory,
            configured.gen,
            eventVersion,
          )
          const duplicate = marketMap.get(market.key)
          if (
            duplicate !== undefined &&
            (duplicate.transactionHash !== market.transactionHash ||
              duplicate.logIndex !== market.logIndex)
          ) {
            quarantinedLogCount += 1
            continue
          }
          marketMap.set(market.key, market)
        } catch {
          quarantinedLogCount += 1
        }
      }
      indexedThrough = safeBlock
    } catch (error) {
      addPublicError(errors, `${configured.gen} factory scan failed: ${safeError(error)}`)
      if (checkpoint !== undefined) {
        deploymentBlock = checkpoint.deploymentBlock
        startBlockSource = 'checkpoint'
        indexedThrough = checkpoint.indexedThrough
        for (const market of previous.markets) {
          if (market.factory === factory) marketMap.set(market.key, market)
        }
      } else {
        deploymentBlock ??= 0
        startBlockSource ??= 'configured'
      }
    }

    factories.push({
      generation: configured.gen,
      address: factory,
      eventVersion,
      deploymentBlock,
      startBlockSource,
      indexedThrough,
      logCount: 0,
    })
    console.log(
      `  ${configured.gen} factory: ` +
        (indexedThrough === safeBlock ? `indexed through ${safeBlock}` : 'partial'),
    )
  }

  let markets = [...marketMap.values()]
  const blockCache = new Map([[safeHead.number, safeHead]])
  markets = await mapLimit(markets, HYDRATION_CONCURRENCY, (market) =>
    hydrateMarket(client, market, blockCache, safeBlock),
  )
  markets.sort(compareMarkets)

  for (const factory of factories) {
    factory.logCount = markets.filter((market) => market.factory === factory.address).length
  }
  const allFactoriesIndexed =
    factories.length === book.marketFactories.length &&
    factories.every((factory) => factory.indexedThrough === safeBlock)
  const complete = allFactoriesIndexed && errors.length === 0 && quarantinedLogCount === 0
  const chainIndexedThrough = allFactoriesIndexed ? safeBlock : null
  let reorgAnchor = null
  if (chainIndexedThrough !== null) {
    const anchorNumber = Math.max(0, safeBlock - REORG_WINDOW_BLOCKS + 1)
    const anchor = await blockAt(client, anchorNumber)
    reorgAnchor = { blockNumber: anchor.number, blockHash: anchor.hash }
  }

  return {
    chainId,
    complete,
    indexedThrough: chainIndexedThrough,
    indexedThroughHash: chainIndexedThrough === null ? null : safeHead.hash,
    indexedThroughTimestamp: chainIndexedThrough === null ? null : safeHead.timestamp,
    reorgAnchor,
    factories,
    marketCount: markets.length,
    quarantinedLogCount,
    errors,
    markets,
  }
}

function compareMarkets(a, b) {
  return a.blockNumber - b.blockNumber ||
    a.logIndex - b.logIndex ||
    a.address.localeCompare(b.address)
}

function normalizeSnapshot(chains) {
  const orderedChains = SUPPORTED_CHAINS.map((supported) => {
    const chain = chains.find((candidate) => candidate.chainId === supported.id)
    if (chain === undefined) return emptyChain(supported.id)
    return {
      ...chain,
      factories: [...chain.factories],
      errors: [...chain.errors].slice(0, MAX_PUBLIC_ERRORS),
      markets: [...chain.markets].sort(compareMarkets),
    }
  })
  const completeChains = orderedChains
    .filter((chain) => chain.complete)
    .map((chain) => chain.chainId)
  const marketCount = orderedChains.reduce((total, chain) => total + chain.marketCount, 0)
  const quarantinedLogCount = orderedChains.reduce(
    (total, chain) => total + chain.quarantinedLogCount,
    0,
  )
  return {
    schemaVersion: FACTORY_MARKET_SNAPSHOT_SCHEMA_VERSION,
    dataset: FACTORY_MARKET_SNAPSHOT_DATASET,
    provenance: PROVENANCE,
    coverage: {
      complete: completeChains.length === SUPPORTED_CHAINS.length,
      completeChains,
      totalChains: SUPPORTED_CHAINS.length,
      marketCount,
      quarantinedLogCount,
    },
    chains: orderedChains,
  }
}

function assertGeneratorConfiguration() {
  const factoryCount = Object.values(ADDRESS_BOOKS).reduce(
    (total, book) => total + book.marketFactories.length,
    0,
  )
  if (factoryCount !== 20) {
    throw new Error(`Expected 20 configured Pendle factories, found ${factoryCount}`)
  }
  for (const chain of SUPPORTED_CHAINS) {
    const book = ADDRESS_BOOKS[chain.id]
    if (book.marketFactories.length === 0) {
      throw new Error(`Chain ${chain.id} has no configured factories`)
    }
    for (const factory of book.marketFactories) {
      lowerAddress(factory.marketFactory, `chain ${chain.id} ${factory.gen} factory`)
    }
  }

  // Network-free decoder fixtures keep both deployed event ABIs covered. The
  // oldest factory has no fee word; every later generation does.
  const fixtureTopics = [
    FACTORY_MARKET_EVENT_TOPICS.v1,
    `0x${'11'.repeat(20).padStart(64, '0')}`,
    `0x${'22'.repeat(20).padStart(64, '0')}`,
  ]
  const fixtureBase = {
    address: ADDRESS_BOOKS[42161].marketFactories[0].marketFactory.toLowerCase(),
    topics: fixtureTopics,
    removed: false,
    blockNumber: '0x64',
    blockHash: `0x${'33'.repeat(32)}`,
    transactionHash: `0x${'44'.repeat(32)}`,
    logIndex: '0x0',
  }
  assertLogEnvelope(
    fixtureBase,
    fixtureBase.address,
    FACTORY_MARKET_EVENT_TOPICS.v1,
    100,
    100,
  )
  try {
    assertLogEnvelope(
      { ...fixtureBase, address: `0x${'99'.repeat(20)}` },
      fixtureBase.address,
      FACTORY_MARKET_EVENT_TOPICS.v1,
      100,
      100,
    )
    throw new Error('Log-envelope factory mismatch fixture did not reject')
  } catch (error) {
    if (!safeError(error).includes('wrong factory')) throw error
  }
  const v1 = decodeMarketLog(
    {
      ...fixtureBase,
      data: encodeAbiParameters(
        [{ type: 'int256' }, { type: 'int256' }],
        [1n, 2n],
      ),
    },
    42161,
    ADDRESS_BOOKS[42161].marketFactories[0].marketFactory.toLowerCase(),
    'v1',
    'v1',
  )
  const modern = decodeMarketLog(
    {
      ...fixtureBase,
      address: ADDRESS_BOOKS[42161].marketFactories[1].marketFactory.toLowerCase(),
      topics: [FACTORY_MARKET_EVENT_TOPICS.v3Plus, ...fixtureTopics.slice(1)],
      data: encodeAbiParameters(
        [{ type: 'int256' }, { type: 'int256' }, { type: 'uint256' }],
        [1n, 2n, 3n],
      ),
    },
    42161,
    ADDRESS_BOOKS[42161].marketFactories[1].marketFactory.toLowerCase(),
    'V3',
    'v3+',
  )
  if (v1.lnFeeRateRoot !== null || modern.lnFeeRateRoot !== '3') {
    throw new Error('CreateNewMarket event decoder fixture failed')
  }
  if (!safeError(new Error('failed https://rpc.example/key?token=secret')).includes('<rpc>')) {
    throw new Error('RPC error redaction fixture failed')
  }

  const proxyEndpoint =
    'https://api.example/v2/api?chainid=143&apikey=fixture&page=9&offset=7'
  const proxyCall = indexedProxyRequestUrl(proxyEndpoint, 'eth_call', [
    { to: fixtureBase.address, data: '0x1234' },
    '0x64',
  ])
  if (
    proxyCall.searchParams.get('module') !== 'proxy' ||
    proxyCall.searchParams.get('action') !== 'eth_call' ||
    proxyCall.searchParams.get('chainid') !== '143' ||
    proxyCall.searchParams.get('apikey') !== 'fixture' ||
    proxyCall.searchParams.get('to') !== fixtureBase.address ||
    proxyCall.searchParams.get('data') !== '0x1234' ||
    proxyCall.searchParams.get('tag') !== '0x64' ||
    proxyCall.searchParams.has('page') ||
    proxyCall.searchParams.has('offset')
  ) {
    throw new Error('Indexed proxy URL fixture failed')
  }
  if (parseIndexedProxyPayload({ jsonrpc: '2.0', result: '0x64' }) !== '0x64') {
    throw new Error('Indexed proxy success-envelope fixture failed')
  }
  try {
    parseIndexedProxyPayload({
      status: '0',
      message: 'NOTOK',
      result: 'credential-bearing remote error',
    })
    throw new Error('Indexed proxy error-envelope fixture did not reject')
  } catch (error) {
    const message = safeError(error)
    if (!message.includes('error envelope') || message.includes('credential-bearing')) throw error
  }

  const reusableFactory = { indexedThrough: 100 }
  if (
    !canResumeFactoryCheckpoint(
      { complete: false, quarantinedLogCount: 0 },
      reusableFactory,
      false,
    ) ||
    canResumeFactoryCheckpoint(
      { complete: false, quarantinedLogCount: 1 },
      reusableFactory,
      false,
    ) ||
    canResumeFactoryCheckpoint(
      { complete: true, quarantinedLogCount: 0 },
      reusableFactory,
      false,
    )
  ) {
    throw new Error('Per-factory checkpoint reuse fixture failed')
  }
}

async function assertIndexedLogPagination() {
  const factory = ADDRESS_BOOKS[143].marketFactories[0].marketFactory.toLowerCase()
  const topic = FACTORY_MARKET_EVENT_TOPICS.v3Plus
  const entry = (index) => ({
    address: factory,
    topics: [
      topic,
      `0x${'11'.repeat(20).padStart(64, '0')}`,
      `0x${'22'.repeat(20).padStart(64, '0')}`,
    ],
    data: `0x${'00'.repeat(96)}`,
    blockNumber: '0x64',
    blockHash: `0x${'33'.repeat(32)}`,
    transactionHash: `0x${index.toString(16).padStart(64, '0')}`,
    logIndex: '0x0',
  })
  const firstPage = Array.from({ length: INDEXED_LOG_PAGE_SIZE }, (_, index) => entry(index + 1))
  const finalPage = [entry(INDEXED_LOG_PAGE_SIZE + 1)]
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(new URL(url))
    const page = Number(new URL(url).searchParams.get('page'))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: '1',
        message: 'OK',
        result: page === 1 ? firstPage : page === 2 ? finalPage : [],
      }),
    }
  }
  const logs = await scanIndexedLogs(
    {},
    'https://api.example/v2/api?chainid=143&apikey=fixture&page=99&offset=7',
    factory,
    topic,
    100,
    100,
    { fetchImpl, maxPages: 3 },
  )
  if (
    logs.length !== INDEXED_LOG_PAGE_SIZE + 1 ||
    requested.length !== 2 ||
    requested[0].searchParams.get('page') !== '1' ||
    requested[1].searchParams.get('page') !== '2' ||
    requested.some((url) => url.searchParams.get('offset') !== String(INDEXED_LOG_PAGE_SIZE)) ||
    requested.some((url) => url.searchParams.get('apikey') !== 'fixture')
  ) {
    throw new Error('Indexed log pagination fixture failed')
  }

  try {
    await scanIndexedLogs(
      {},
      'https://api.example/v2/api',
      factory,
      topic,
      100,
      100,
      {
        maxPages: 2,
        fetchImpl: async (url) => ({
          ok: true,
          status: 200,
          json: async () => ({
            status: '1',
            message: 'OK',
            result:
              new URL(url).searchParams.get('page') === '1'
                ? firstPage
                : [firstPage[0]],
          }),
        }),
      },
    )
    throw new Error('Indexed log duplicate-page fixture did not reject')
  } catch (error) {
    if (!safeError(error).includes('duplicate log')) throw error
  }

  const noRecords = parseIndexedLogPage({
    status: '0',
    message: 'No records found',
    result: 'No records found',
  })
  if (noRecords.length !== 0) throw new Error('Indexed log empty-page fixture failed')

  let retryAttempts = 0
  const retried = await scanIndexedLogs(
    {},
    'https://api.example/v2/api',
    factory,
    topic,
    100,
    100,
    {
      fetchImpl: async () => {
        retryAttempts += 1
        return {
          ok: true,
          status: 200,
          json: async () => retryAttempts === 1
            ? { status: '0', message: 'NOTOK', result: 'Max rate limit reached' }
            : { status: '1', message: 'OK', result: finalPage },
        }
      },
    },
  )
  if (retryAttempts !== 2 || retried.length !== finalPage.length) {
    throw new Error('Indexed log retry fixture failed')
  }

  let activeRpcRanges = 0
  let maxActiveRpcRanges = 0
  const rpcLogs = await scanFactoryLogs(
    {
      chainId: 56,
      request: async (method, [filter]) => {
        if (method !== 'eth_getLogs') throw new Error('Unexpected RPC fixture method')
        const start = Number(BigInt(filter.fromBlock))
        const end = Number(BigInt(filter.toBlock))
        if (end - start + 1 > 50_000) throw new Error('Fixture range too wide')
        activeRpcRanges += 1
        maxActiveRpcRanges = Math.max(maxActiveRpcRanges, activeRpcRanges)
        try {
          await delay(5)
          return []
        } finally {
          activeRpcRanges -= 1
        }
      },
    },
    factory,
    topic,
    0,
    449_999,
  )
  if (rpcLogs.length !== 0 || maxActiveRpcRanges !== RPC_LOG_CONCURRENCY) {
    throw new Error('Bounded concurrent RPC log fixture failed')
  }
}

async function checkSnapshot(path, requireComplete = false) {
  assertGeneratorConfiguration()
  await assertIndexedLogPagination()
  const source = await readFile(path, 'utf8')
  const parsed = parseFactoryMarketSnapshot(JSON.parse(source))
  const canonical = `${JSON.stringify(parsed, null, 2)}\n`
  if (source !== canonical) {
    throw new Error('Factory snapshot is not in canonical deterministic form')
  }
  const configuredFactories = new Set(
    Object.values(ADDRESS_BOOKS).flatMap((book) =>
      book.marketFactories.map((factory) => `${book.chainId}:${factory.marketFactory.toLowerCase()}`),
    ),
  )
  const expectedChainOrder = SUPPORTED_CHAINS.map((chain) => chain.id)
  if (parsed.chains.some((chain, index) => chain.chainId !== expectedChainOrder[index])) {
    throw new Error('Factory snapshot chains are not in deterministic configured order')
  }
  for (const chain of parsed.chains) {
    if (chain.errors.some((error) => /https?:\/\//i.test(error))) {
      throw new Error(`Chain ${chain.chainId} errors contain an unredacted RPC URL`)
    }
    const expectedFactories = ADDRESS_BOOKS[chain.chainId].marketFactories.map(
      (factory) => factory.marketFactory.toLowerCase(),
    )
    if (
      chain.factories.length !== expectedFactories.length ||
      chain.factories.some((factory, index) => factory.address !== expectedFactories[index])
    ) {
      throw new Error(`Chain ${chain.chainId} factories are not in configured order`)
    }
    for (let index = 1; index < chain.markets.length; index += 1) {
      if (compareMarkets(chain.markets[index - 1], chain.markets[index]) > 0) {
        throw new Error(`Chain ${chain.chainId} markets are not in deterministic order`)
      }
    }
    for (const factory of chain.factories) {
      if (!configuredFactories.has(`${chain.chainId}:${factory.address}`)) {
        throw new Error(`Snapshot contains unknown factory ${chain.chainId}:${factory.address}`)
      }
    }
  }
  if (requireComplete && !parsed.coverage.complete) {
    throw new Error(
      `Factory snapshot is incomplete: ` +
        `${parsed.coverage.completeChains.length}/${parsed.coverage.totalChains} chains complete`,
    )
  }
  if (
    requireComplete &&
    parsed.chains.some((chain) => chain.indexedThroughTimestamp === null)
  ) {
    throw new Error('Complete factory snapshot is missing indexed-head timestamps')
  }
  if (
    requireComplete &&
    parsed.chains.some((chain) =>
      chain.markets.some((market) =>
        market.name === undefined ||
        market.expiry === undefined ||
        market.yt === undefined ||
        market.sy === undefined ||
        market.createdAt === undefined,
      ),
    )
  ) {
    throw new Error('Complete factory snapshot has markets missing required hydration')
  }
  console.log(
    `Factory snapshot OK: ${parsed.coverage.marketCount} markets, ` +
      `${parsed.coverage.completeChains.length}/${parsed.coverage.totalChains} chains complete, ` +
      `${parsed.coverage.quarantinedLogCount} quarantined logs`,
  )
}

async function writeSnapshot(path, snapshot) {
  const validated = parseFactoryMarketSnapshot(snapshot)
  const serialized = `${JSON.stringify(validated, null, 2)}\n`
  const temporary = `${path}.tmp`
  await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o644 })
  await rename(temporary, path)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.check) {
    await checkSnapshot(options.output, options.requireComplete)
    return
  }
  assertGeneratorConfiguration()
  const previous = await readSnapshot(options.output, options.reset)
  const selected = new Set(
    options.chains ?? SUPPORTED_CHAINS.map((chain) => chain.id),
  )
  const nextChains = []
  for (const supported of SUPPORTED_CHAINS) {
    const checkpoint = previous.chains.find((chain) => chain.chainId === supported.id) ??
      emptyChain(supported.id)
    if (!selected.has(supported.id)) {
      nextChains.push(checkpoint)
      continue
    }
    console.log(`Indexing ${supported.name} (${supported.id})`)
    try {
      const indexed = await indexChain(supported.id, checkpoint)
      nextChains.push(indexed)
      console.log(
        `  ${indexed.marketCount} markets; ${indexed.complete ? 'complete' : 'partial'}; ` +
          `${indexed.quarantinedLogCount} quarantined`,
      )
    } catch (error) {
      const message = safeError(error)
      nextChains.push({
        ...checkpoint,
        complete: false,
        errors: [message],
      })
      console.warn(`  partial: ${message}`)
    }
  }

  const snapshot = normalizeSnapshot(nextChains)
  await writeSnapshot(options.output, snapshot)
  await checkSnapshot(options.output)
}

main().catch((error) => {
  console.error(safeError(error))
  process.exitCode = 1
})
