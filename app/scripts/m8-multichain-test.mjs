#!/usr/bin/env node
/**
 * M8 multi-network test — proves the data layer resolves the CORRECT per-chain
 * address book from the client's chain and reads real markets on more than one
 * chain (PLAN.md M8 "Done when": a pool loads + trades on each chain).
 *
 * Spawns TWO anvil forks — Base (8453) and Ethereum (1) — on separate ports.
 * On EACH fork it:
 *   1. picks a REAL active Pendle market on that chain (first candidate that
 *      validates against THAT chain's factory set AND is non-expired);
 *   2. runs loadMarketSnapshot resolving THAT chain's address book from the
 *      client (no chainId is passed to any lib fn — it rides on client.chain.id);
 *   3. asserts validated === true, vintage === 'active', SY/PT/YT resolve,
 *      expiry parses, and TVL ≥ 0.
 * On BASE it additionally runs a READ-ONLY quoteBuy (SY→PT) to prove RouterStatic
 * resolves PER CHAIN (the wrong RouterStatic would revert / mis-quote).
 *
 * It also asserts addressBookFor(1) / (8453) / (42161) return DISTINCT, correct
 * routerStatic + PENDLE addresses (the core cross-chain-correctness invariant).
 *
 * Run from app/ (requires foundry's `anvil` on PATH):
 *   node --experimental-strip-types scripts/m8-multichain-test.mjs
 *
 * Env:
 *   ETH_RPC_URL  / BASE_RPC_URL — optional fork-source RPC overrides.
 *   ETH_MARKET   / BASE_MARKET  — optional market override (skips discovery).
 *
 * Prints a PASS table; kills both anvils; exits 1 on any failure.
 * (No npm script here by design — the orchestrator wires it.)
 */

import { spawn } from 'node:child_process'
import { createPublicClient, http } from 'viem'
import { mainnet, base } from 'viem/chains'
import { loadMarketSnapshot, validateMarket } from '../src/lib/market.ts'
import { quoteBuy } from '../src/lib/swaps.ts'
import { addressBookFor, ADDRESS_BOOKS } from '../src/lib/addresses.ts'

// --- Config -----------------------------------------------------------------

const CHAINS = {
  eth: {
    label: 'Ethereum',
    chainId: 1,
    viemChain: mainnet,
    port: Number(process.env.ETH_PORT ?? 8547),
    forkUrls: [
      process.env.ETH_RPC_URL,
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://rpc.ankr.com/eth',
    ].filter(Boolean),
    // Active-generation markets on Ethereum (verified active + non-expired on a
    // fork 2026-07-04). The test picks the first that still validates active +
    // is non-expired AT RUN TIME, so an expired candidate is skipped rather than
    // failing the suite. Ordered longest-dated first for durability.
    candidates: (process.env.ETH_MARKET ? [process.env.ETH_MARKET] : [
      '0x4a5067c3ff1abb7449244025b0e37feaf77d8e3e', // PLP USD3 17DEC2026
      '0x30ee7618e0ef0682f0f354d6f84be87de6b8878c', // PLP Wrapped OUSD 17DEC2026
      '0x61703e1ea2887fffd4b5f777bafd6abd7122bcf9', // PLP Flagship USDC SuperVault 26NOV2026
      '0xac24a6f0068d9701eaea76ab0b418021017f8d59', // PLP Staked cap USD 23JUL2026
      '0x9eaaeda23177b7168c55a3a0f937f67919733449', // PLP cap USD 23JUL2026
    ]),
  },
  base: {
    label: 'Base',
    chainId: 8453,
    viemChain: base,
    port: Number(process.env.BASE_PORT ?? 8546),
    forkUrls: [
      process.env.BASE_RPC_URL,
      'https://base.publicnode.com',
      'https://mainnet.base.org',
      'https://base.drpc.org',
    ].filter(Boolean),
    // Ordered longest-dated first for durability (picks first active + non-expired).
    candidates: (process.env.BASE_MARKET ? [process.env.BASE_MARKET] : [
      '0xf5e6cf47ee975600786248cae0a80ab99daf0350', // PLP apxUSD 05NOV2026
      '0x250c15e59a7572195e248f668636723cca20a2b8', // PLP yoVaultUSD 24SEP2026
      '0x87e9a352d50146fa03373c52b9b21a32402a9597', // 40acresUSDC 27AUG2026
      '0xb0eb82ba25ffa51641d8613d270ad79183171fac', // sKAITO 30JUL2026
    ]),
  },
}

// --- anvil lifecycle --------------------------------------------------------

const procs = []
function killAll() {
  for (const p of procs) if (p && !p.killed) p.kill('SIGKILL')
  procs.length = 0
}
process.on('exit', killAll)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killAll()
    process.exit(1)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClient(chain) {
  return createPublicClient({
    chain: chain.viemChain,
    transport: http(`http://127.0.0.1:${chain.port}`, {
      timeout: 120_000,
      retryCount: 2,
      retryDelay: 500,
    }),
  })
}

async function startFork(chain) {
  for (const forkUrl of chain.forkUrls) {
    console.log(`Starting anvil fork of ${chain.label} (${forkUrl}) on :${chain.port} …`)
    const proc = spawn(
      'anvil',
      ['--fork-url', forkUrl, '--port', String(chain.port), '--silent'],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    procs.push(proc)
    const client = makeClient(chain)
    const deadline = Date.now() + 90_000
    let ready = false
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break
      try {
        await client.getBlockNumber()
        ready = true
        break
      } catch {
        await sleep(500)
      }
    }
    if (ready) {
      try {
        const id = await client.getChainId()
        if (id !== chain.chainId) throw new Error(`fork chainId ${id} != ${chain.chainId}`)
        console.log(`  ${chain.label} fork ready (chainId ${id}).`)
        return client
      } catch (err) {
        console.log(`  ${chain.label} fork sanity failed: ${err.message} — next RPC`)
      }
    } else {
      console.log(`  ${chain.label} anvil did not become ready — next RPC`)
    }
    if (proc && !proc.killed) proc.kill('SIGKILL')
    await sleep(1000)
  }
  throw new Error(`could not start a working ${chain.label} anvil fork on any RPC`)
}

// --- Assertions -------------------------------------------------------------

const results = []
function record(chain, step, ok, detail) {
  results.push({ chain, step, ok, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${chain} · ${step}${detail ? ` — ${detail}` : ''}`)
}

const isRealAddress = (a) =>
  typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && BigInt(a) !== 0n

/** Pick the first candidate that validates active + is non-expired on this chain. */
async function pickActiveMarket(client, chain) {
  for (const market of chain.candidates) {
    try {
      const v = await validateMarket(client, market)
      if (!v.isMarket) continue
      const snap = await loadMarketSnapshot(client, market)
      if (v.vintage === 'active' && !snap.isExpired) return { market, snap }
      console.log(`  (skip ${market}: vintage=${v.vintage} expired=${snap.isExpired})`)
    } catch (err) {
      console.log(`  (skip ${market}: ${String(err.message || err).slice(0, 80)})`)
    }
  }
  throw new Error(`no active, non-expired candidate market on ${chain.label}`)
}

// --- Main -------------------------------------------------------------------

async function main() {
  // --- (0) Cross-chain address-book distinctness (no fork needed) -----------
  console.log('\n=== Address-book distinctness ===')
  const b1 = addressBookFor(1)
  const b8453 = addressBookFor(8453)
  const b42161 = addressBookFor(42161)
  const rsSet = new Set([b1.routerStatic, b8453.routerStatic, b42161.routerStatic])
  const pendleSet = new Set([b1.pendle, b8453.pendle, b42161.pendle])
  record(
    'ALL',
    'routerStatic distinct per chain',
    rsSet.size === 3,
    `1=${b1.routerStatic} 8453=${b8453.routerStatic} 42161=${b42161.routerStatic}`,
  )
  record(
    'ALL',
    'PENDLE token distinct per chain',
    pendleSet.size === 3,
    `1=${b1.pendle} 8453=${b8453.pendle} 42161=${b42161.pendle}`,
  )
  // Router / commonDeploy / syFactory are the SAME address cross-chain.
  const routerSame =
    b1.router === b8453.router && b8453.router === b42161.router &&
    b1.commonDeploy === b8453.commonDeploy && b1.syFactory === b8453.syFactory
  record('ALL', 'router/commonDeploy/syFactory same cross-chain', routerSame, b1.router)
  // Every supported chain must have a non-empty factory set + an active pair.
  const allBooksSane = Object.values(ADDRESS_BOOKS).every(
    (b) =>
      b.marketFactories.length > 0 &&
      isRealAddress(b.activeMarketFactory) &&
      isRealAddress(b.activeYieldContractFactory) &&
      b.activeMarketFactory ===
        b.marketFactories[b.marketFactories.length - 1].marketFactory,
  )
  record('ALL', 'every book has an active factory pick', allBooksSane)

  // --- (1) Per-chain fork loads --------------------------------------------
  for (const key of ['base', 'eth']) {
    const chain = CHAINS[key]
    console.log(`\n=== ${chain.label} (chain ${chain.chainId}) ===`)
    const client = await startFork(chain)

    // addressBookFor resolves from the CLIENT's chain (no chainId passed).
    const resolved = addressBookFor(client)
    record(
      chain.label,
      'addressBookFor(client) resolves this chain',
      resolved.chainId === chain.chainId,
      `resolved chainId ${resolved.chainId}`,
    )

    const { market, snap } = await pickActiveMarket(client, chain)
    console.log(`  market: ${market} — ${snap.displayName}`)

    record(chain.label, 'market validated', snap.validated === true)
    record(chain.label, "vintage === 'active'", snap.vintage === 'active', snap.vintage)
    record(
      chain.label,
      'SY/PT/YT resolve',
      isRealAddress(snap.sy.address) && isRealAddress(snap.pt) && isRealAddress(snap.yt),
      `SY ${snap.sy.symbol}`,
    )
    record(
      chain.label,
      'expiry parses (future)',
      Number.isFinite(snap.expiry) && snap.expiry > 0 && !snap.isExpired,
      new Date(snap.expiry * 1000).toISOString().slice(0, 10),
    )
    record(
      chain.label,
      'TVL ≥ 0',
      Number.isFinite(snap.metrics.tvlAsset) && snap.metrics.tvlAsset >= 0,
      `${snap.metrics.tvlAsset.toFixed(0)} ${snap.sy.assetSymbol ?? snap.sy.symbol ?? 'asset'}`,
    )
    record(
      chain.label,
      'no degraded probes',
      snap.degraded.length === 0,
      snap.degraded.length ? snap.degraded.join('; ') : 'clean',
    )

    // Base-only: read-only quoteBuy proves RouterStatic resolves PER CHAIN.
    if (key === 'base') {
      try {
        const amountIn = 10n ** BigInt(snap.sy.decimals) // 1 SY
        const q = await quoteBuy(client, snap, 'pt', snap.sy.address, amountIn, 0.01)
        record(
          chain.label,
          'quoteBuy via per-chain RouterStatic',
          q.amountOut > 0n,
          `1 SY → ${q.amountOut} PT (impact ${q.priceImpact.toExponential(2)})`,
        )
      } catch (err) {
        record(chain.label, 'quoteBuy via per-chain RouterStatic', false, String(err.message || err).slice(0, 120))
      }
    }
  }

  // --- Verdict --------------------------------------------------------------
  const failures = results.filter((r) => !r.ok)
  console.log('\n=== M8 MULTI-NETWORK RESULT ===')
  console.log(`  ${results.length - failures.length}/${results.length} checks passed`)
  if (failures.length > 0) {
    console.error('\nM8 TEST FAILED:')
    for (const f of failures) console.error(`  - ${f.chain} · ${f.step}${f.detail ? ` (${f.detail})` : ''}`)
    process.exit(1)
  }
  console.log('\nM8 TEST PASSED — Base + Ethereum markets load via their own address books; RouterStatic resolves per chain.')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
