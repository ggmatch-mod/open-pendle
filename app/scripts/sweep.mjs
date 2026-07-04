#!/usr/bin/env node
/**
 * M1 acceptance sweep (PLAN.md, M1 "Done when").
 *
 * Enumerates every market created through the ACTIVE factory generation
 * (CreateNewMarket events), runs the market reader over all of them asserting
 * sane invariants, spot-checks a few legacy-vintage markets best-effort, and
 * writes src/lib/starterMarkets.json (the home screen's starter list).
 *
 * Run from app/:
 *   node --experimental-strip-types scripts/sweep.mjs
 *
 * Env:
 *   ARB_RPC_URL — optional RPC override (archive-grade recommended in CI).
 *
 * Exits 1 on any invariant failure.
 */

import { createPublicClient, getAddress, http, numberToHex } from 'viem'
import { arbitrum } from 'viem/chains'
import { loadMarketSnapshot } from '../src/lib/market.ts'

// --- Constants --------------------------------------------------------------

/** Active market factory ("V6", impl V7). */
const ACTIVE_FACTORY = '0x49F2f7002669E0e4425Fa0203975625Ab4af3143'
/** keccak256 topic0 of CreateNewMarket(address indexed market, address indexed PT, ...). */
const CREATE_NEW_MARKET_TOPIC0 =
  '0xae811fae25e2770b6bd1dcb1475657e8c3a976f91d1ebf081271db08eef920af'
/** Block of the first CreateNewMarket event on the active factory. */
const FIRST_EVENT_BLOCK = 392527114n

const RPC_URLS = [
  process.env.ARB_RPC_URL,
  'https://arb1.arbitrum.io/rpc',
  'https://arbitrum-one-rpc.publicnode.com',
  'https://1rpc.io/arb',
].filter(Boolean)

/** Legacy spot-checks: degraded[] allowed, but the load must not throw. */
const LEGACY_SPOT_CHECKS = [
  { vintage: 'v1', address: '0xe59A37F7F5263aA8cb5155AF3498ba01CC2c394B' },
  { vintage: 'v1', address: '0x9bC62257Ffe7D0f7c52A019E6Fc0AF3102F8F44E' },
  { vintage: 'V3', address: '0x6febB4d63F6715793107DB9214e9e88dc3E7C3Bd' },
  { vintage: 'V4', address: '0x279b44E48226d40Ec389129061cb0B56C5c09e46' },
  { vintage: 'V5', address: '0x281fE15fd3E08A282f52D5cf09a4d13c3709E66D' },
]

// --- Helpers ----------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeClient(url) {
  return createPublicClient({
    chain: arbitrum,
    transport: http(url, { retryCount: 3, retryDelay: 500, timeout: 30_000 }),
  })
}

async function withRetry(fn, label, attempts = 3) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (i < attempts - 1) {
        console.log(`  retry ${i + 1}/${attempts - 1} for ${label}: ${error.message?.slice(0, 120)}`)
        await sleep(1000 * (i + 1))
      }
    }
  }
  throw lastError
}

async function getLogsRange(client, fromBlock, toBlock) {
  return client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: ACTIVE_FACTORY,
        topics: [CREATE_NEW_MARKET_TOPIC0],
        fromBlock: numberToHex(fromBlock),
        toBlock: numberToHex(toBlock),
      },
    ],
  })
}

/** Chunk-size cascade for the eth_getLogs fallback. The 10k floor stays
 * reachable for providers whose range limit is below 50k (e.g. 10k-limit
 * public RPCs), which a halving loop with a 50k floor could never reach. */
const CHUNK_SIZES = [10_000_000n, 1_000_000n, 100_000n, 10_000n]

/**
 * Enumerate CreateNewMarket logs. Strategy: one wide eth_getLogs first (some
 * public RPCs allow it when results are few — ~24 events expected); on
 * rejection fall back to chunked scanning, cascading 10M → 1M → 100k → 10k
 * with one same-size retry (transient errors) before stepping down.
 */
async function enumerateLogs(client) {
  const latest = await client.getBlockNumber()
  try {
    const logs = await getLogsRange(client, FIRST_EVENT_BLOCK, latest)
    return { logs, strategy: `single-range (${FIRST_EVENT_BLOCK} → ${latest})` }
  } catch (error) {
    console.log(`  wide eth_getLogs rejected (${error.message?.slice(0, 120)}) — chunked fallback`)
  }

  const logs = []
  let sizeIdx = 0
  let retriedAtThisSize = false
  let from = FIRST_EVENT_BLOCK
  let chunkCalls = 0
  while (from <= latest) {
    const chunk = CHUNK_SIZES[sizeIdx]
    const to = from + chunk - 1n > latest ? latest : from + chunk - 1n
    try {
      const part = await getLogsRange(client, from, to)
      logs.push(...part)
      from = to + 1n
      chunkCalls++
      retriedAtThisSize = false
    } catch (error) {
      if (!retriedAtThisSize) {
        // One same-size retry: range-limit rejections are deterministic, but
        // transient RPC hiccups shouldn't burn a whole cascade step.
        retriedAtThisSize = true
        await sleep(500)
        continue
      }
      retriedAtThisSize = false
      sizeIdx++
      if (sizeIdx >= CHUNK_SIZES.length) {
        throw new Error(`chunked eth_getLogs failed even at ${CHUNK_SIZES.at(-1)}-block ranges: ${error.message}`)
      }
    }
  }
  return {
    logs,
    strategy: `chunked (${chunkCalls} calls, final chunk ${CHUNK_SIZES[sizeIdx]} blocks)`,
  }
}

function marketFromLog(log) {
  // topic1 = indexed market address (last 20 bytes of the 32-byte topic).
  return getAddress(`0x${log.topics[1].slice(26)}`)
}

const isRealAddress = (a) =>
  typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && BigInt(a) !== 0n

function assertActiveInvariants(snap) {
  const errors = []
  if (!isRealAddress(snap.sy?.address)) errors.push('SY address did not resolve')
  if (!isRealAddress(snap.pt)) errors.push('PT address did not resolve')
  if (!isRealAddress(snap.yt)) errors.push('YT address did not resolve')
  if (!(Number.isFinite(snap.expiry) && snap.expiry > 0)) errors.push(`expiry not > 0 (${snap.expiry})`)
  if (!(Number.isFinite(snap.metrics.tvlAsset) && snap.metrics.tvlAsset >= 0)) {
    errors.push(`tvlAsset invalid (${snap.metrics.tvlAsset})`)
  }
  if (!snap.displayName || snap.displayName.trim() === '') errors.push('displayName empty')
  if (snap.vintage !== 'active') errors.push(`vintage '${snap.vintage}' != 'active'`)
  return errors
}

const fmtApy = (snap) => `${(snap.metrics.impliedApy * 100).toFixed(2)}%`
const fmtTvl = (snap) =>
  `${snap.metrics.tvlAsset.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${snap.sy.assetSymbol ?? snap.sy.symbol ?? 'asset'}`

function printRow(cols) {
  const [addr, name, expired, apy, tvl, degraded] = cols
  console.log(
    `${addr.padEnd(43)} ${name.slice(0, 30).padEnd(31)} ${expired.padEnd(8)} ${apy.padStart(8)} ${tvl.padStart(24)} ${degraded.padStart(9)}`,
  )
}

// --- Main -------------------------------------------------------------------

async function main() {
  let client
  let enumeration
  let rpcUsed

  for (const url of RPC_URLS) {
    console.log(`\nRPC candidate: ${url}`)
    const candidate = makeClient(url)
    try {
      enumeration = await withRetry(() => enumerateLogs(candidate), 'log enumeration', 2)
      client = candidate
      rpcUsed = url
      break
    } catch (error) {
      console.log(`  enumeration failed on ${url}: ${error.message?.slice(0, 160)}`)
    }
  }
  if (!enumeration) {
    console.error('FATAL: could not enumerate CreateNewMarket logs on any RPC')
    process.exit(1)
  }

  const markets = [...new Set(enumeration.logs.map(marketFromLog))]
  console.log(`\nEnumerated ${enumeration.logs.length} CreateNewMarket events → ${markets.length} unique markets`)
  console.log(`RPC: ${rpcUsed}  |  strategy: ${enumeration.strategy}`)

  if (markets.length === 0) {
    console.error('FATAL: zero markets enumerated — wrong factory/topic/range?')
    process.exit(1)
  }

  // --- Load every active-generation market ---------------------------------
  console.log(`\n=== Active-generation markets (${markets.length}) ===`)
  printRow(['address', 'name', 'expired', 'APY', 'TVL (accounting asset)', 'degraded'])
  const failures = []
  const snapshots = []
  for (const market of markets) {
    try {
      const snap = await withRetry(() => loadMarketSnapshot(client, market), market)
      const errors = assertActiveInvariants(snap)
      if (errors.length > 0) failures.push({ market, errors })
      snapshots.push(snap)
      printRow([
        market,
        snap.displayName,
        snap.isExpired ? 'YES' : 'no',
        fmtApy(snap),
        fmtTvl(snap),
        String(snap.degraded.length),
      ])
      if (snap.degraded.length > 0) {
        for (const note of snap.degraded) console.log(`    degraded: ${note}`)
      }
    } catch (error) {
      failures.push({ market, errors: [`loadMarketSnapshot threw: ${error.message}`] })
      printRow([market, '<LOAD FAILED>', '-', '-', '-', '-'])
    }
    await sleep(150) // be polite to public RPCs
  }

  // --- Legacy spot-checks (best-effort: degraded allowed, must not throw) --
  console.log(`\n=== Legacy spot-checks (${LEGACY_SPOT_CHECKS.length}) ===`)
  printRow(['address', 'name', 'expired', 'APY', 'TVL (accounting asset)', 'degraded'])
  for (const { vintage, address } of LEGACY_SPOT_CHECKS) {
    try {
      const snap = await withRetry(() => loadMarketSnapshot(client, address), address)
      printRow([
        address,
        `[${snap.vintage}] ${snap.displayName}`,
        snap.isExpired ? 'YES' : 'no',
        fmtApy(snap),
        fmtTvl(snap),
        String(snap.degraded.length),
      ])
      if (snap.vintage !== vintage) {
        failures.push({ market: address, errors: [`expected vintage ${vintage}, got ${snap.vintage}`] })
      }
    } catch (error) {
      failures.push({ market: address, errors: [`legacy spot-check threw: ${error.message}`] })
      printRow([address, `[${vintage}] <LOAD FAILED>`, '-', '-', '-', '-'])
    }
    await sleep(150)
  }

  // --- Home-screen examples --------------------------------------------------
  // src/lib/starterMarkets.json is HAND-CURATED (a small, deliberate example
  // set), NOT auto-generated — the sweep no longer overwrites it. For
  // reference it prints the non-expired active-gen markets it found so the
  // curated list can be refreshed by hand if desired.
  const nonExpired = snapshots
    .filter((s) => !s.isExpired)
    .sort((a, b) => a.expiry - b.expiry)
    .map((s) => `  ${s.address}  ${s.displayName}`)
  console.log(
    `\nHome examples are curated in src/lib/starterMarkets.json (not written by this sweep).` +
      `\nNon-expired active-gen markets found (${nonExpired.length}) — for optional hand-curation:\n${nonExpired.join('\n')}`,
  )

  // --- Verdict ---------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\nSWEEP FAILED — ${failures.length} market(s) violated invariants:`)
    for (const f of failures) {
      console.error(`  ${f.market}`)
      for (const e of f.errors) console.error(`    - ${e}`)
    }
    process.exit(1)
  }
  console.log(`\nSWEEP PASSED — ${markets.length} active markets + ${LEGACY_SPOT_CHECKS.length} legacy spot-checks OK`)
}

main().catch((error) => {
  console.error('FATAL:', error)
  process.exit(1)
})
