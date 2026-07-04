#!/usr/bin/env node
/**
 * M6 deploy test — the M6 "done when" gate. End-to-end verification of the M6
 * data layer (deploy.ts's computeDeployParams / preflightDeploy / planDeployPool
 * / decodeDeploymentResult / recoverDeployments / recoverDeploymentFromTx, the
 * commonDeployPoolAbi / ycfDeployProbeAbi encodings, the M6 creation-error
 * decoding in txflow) against an anvil fork of Arbitrum One, exercising the REAL
 * lib modules — nothing re-implements the tested code path.
 *
 * Scenario (community-pool creation over an EXISTING SY):
 *   Use the live USDai SY (0x5edC…5b82) with a FRESH expiry (next Thursday
 *   00:00 UTC ~90 days out — no existing PT), seed with PYUSD (0x4685…6984,
 *   storage-slot funded) from the dev wallet 0xf39F… (bare-address impersonation
 *   under anvil --auto-impersonate). Then:
 *     1. preflightDeploy → ok, syValid, ptExistsOnActive=false, derived sane.
 *     2. planDeployPool → approve PYUSD → simulateAction → send → decode
 *        MarketDeployment from the receipt → {market, sy=USDai SY, pt, yt} nonzero.
 *     3. loadMarketSnapshot(newMarket) → validated, vintage 'active', not
 *        expired, seeded (totalSy>0 && totalPt>0), impliedApy in [rateMin,rateMax].
 *     4. recoverDeploymentFromTx + recoverDeployments(deployer, fromBlock).
 *     5. Negatives (preflight, no send): non-divisor expiry / rateMax==rateMin /
 *        desired==rateMax / fee>5% → each yields errors[] (no Panic to caller).
 *     6. Duplicate edge: same tuple again in the same block window → decode
 *        MarketFactoryMarketExists (friendly) via createNewMarket directly with
 *        the first market's exact tuple; recovery finds the first market.
 *
 * Run from app/ (requires foundry's `anvil` on PATH):
 *   node --experimental-strip-types scripts/m6-deploy-test.mjs
 *
 * Env:
 *   ARB_RPC_URL — optional fork-source RPC override (tried first).
 *   ANVIL_PORT  — fork port, default 8551.
 *
 * Prints a per-step PASS/FAIL table; exits 1 on any failure. Kills its anvil.
 */

import { spawn } from 'node:child_process'
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  getAbiItem,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
  toHex,
} from 'viem'
import { arbitrum } from 'viem/chains'
import {
  computeDeployParams,
  decodeDeploymentResult,
  planDeployPool,
  preflightDeploy,
  recoverDeploymentFromTx,
  recoverDeployments,
} from '../src/lib/deploy.ts'
import { loadMarketSnapshot } from '../src/lib/market.ts'
import { buildApproveCall, checkApprovals, simulateAction } from '../src/lib/txflow.ts'
import { commonDeployPoolAbi, erc20Abi } from '../src/lib/pendleAbi.ts'
import { COMMON_DEPLOY } from '../src/lib/addresses.ts'

// --- Config ------------------------------------------------------------------

const PORT = Number(process.env.ANVIL_PORT ?? 8551)
const FORK_URLS = [
  process.env.ARB_RPC_URL,
  'https://arb1.arbitrum.io/rpc',
  'https://arbitrum-one-rpc.publicnode.com',
].filter(Boolean)

const RPC = `http://127.0.0.1:${PORT}`
const E18 = 10n ** 18n
const DAY = 86400

/** Live USDai SY (from the 25FEB2027 market's readTokens) — a real, valid SY. */
const USDAI_SY = getAddress('0x5edCBC20Cac67AdC2e724d4348Ff85132B085b82')
/** PYUSD (6 decimals) — in the USDai SY's getTokensIn(); the seed token. */
const PYUSD = getAddress('0x46850aD61C2B7d64d08c9C754F45254596696984')
/** anvil default account 0 — pre-funded; auto-impersonate covers the rest. */
const USER = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')

/** Active generation (V6/V7) factories — used only for the duplicate-tuple edge. */
const MKT_FACTORY_V7 = getAddress('0x49F2f7002669E0e4425Fa0203975625Ab4af3143')

const mktFactoryAbi = parseAbi([
  'function createNewMarket(address PT, int256 scalarRoot, int256 initialAnchor, uint80 lnFeeRateRoot) returns (address market)',
])

// --- Anvil lifecycle -----------------------------------------------------------

let anvilProc

function killAnvil() {
  if (anvilProc && !anvilProc.killed) anvilProc.kill('SIGKILL')
  anvilProc = undefined
}
process.on('exit', killAnvil)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killAnvil()
    process.exit(1)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClients() {
  const transport = http(RPC, { timeout: 120_000, retryCount: 2, retryDelay: 500 })
  return {
    pub: createPublicClient({ chain: arbitrum, transport }),
    wallet: createWalletClient({ chain: arbitrum, transport }),
  }
}

async function startAnvil() {
  for (const forkUrl of FORK_URLS) {
    console.log(`\nStarting anvil fork of ${forkUrl} on :${PORT} …`)
    anvilProc = spawn(
      'anvil',
      ['--fork-url', forkUrl, '--port', String(PORT), '--auto-impersonate', '--silent'],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )
    const { pub } = makeClients()
    const deadline = Date.now() + 90_000
    let ready = false
    while (Date.now() < deadline) {
      if (anvilProc.exitCode !== null) break
      try {
        await pub.getBlockNumber()
        ready = true
        break
      } catch {
        await sleep(500)
      }
    }
    if (ready) {
      try {
        const chainId = await pub.getChainId()
        if (chainId !== 42161) throw new Error(`fork chainId ${chainId} != 42161`)
        return
      } catch (err) {
        console.log(`  fork sanity check failed: ${err.message} — retrying with next RPC`)
      }
    } else {
      console.log('  anvil did not become ready — retrying with next RPC')
    }
    killAnvil()
    await sleep(1000)
  }
  throw new Error('could not start a working anvil fork on any RPC')
}

// --- Helpers -------------------------------------------------------------------

const { pub, wallet } = makeClients()
const rpc = (method, params) => pub.request({ method, params })

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const bal = (token, owner) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })

async function sendPlanned(call, from) {
  const base = {
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    ...(call.value !== undefined ? { value: call.value } : {}),
    account: from,
  }
  let gas
  try {
    gas = ((await pub.estimateContractGas(base)) * 15n) / 10n
  } catch {
    gas = 20_000_000n
  }
  const hash = await wallet.writeContract({ ...base, gas, chain: arbitrum })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`tx ${call.functionName} reverted on-chain (${hash})`)
  }
  return receipt
}

/** Send exact-amount approvals (as `from`) until a plan's approval set is met. */
async function settleApprovalsFor(plan, from, expectedCount) {
  let unmet = await checkApprovals(pub, from, plan.approvals)
  if (expectedCount !== undefined) {
    assert(
      unmet.length === expectedCount,
      `expected ${expectedCount} unmet approval(s), got ${unmet.length}`,
    )
  }
  let rounds = 0
  while (unmet.length > 0) {
    await sendPlanned(buildApproveCall(unmet[0], false), from)
    const next = await checkApprovals(pub, from, plan.approvals)
    assert(next.length < unmet.length, 'approve tx did not reduce the unmet approval set')
    unmet = next
    assert(++rounds <= 5, 'approval loop stuck')
  }
}

/** Deterministic funding by balance-slot storage injection (m2/m3/m5 pattern). */
function mappingKey(holder, baseSlot32) {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [holder, baseSlot32]),
  )
}
async function fundToken(token, holder, amount) {
  for (let slot = 0n; slot < 40n; slot++) {
    const key = mappingKey(holder, pad(toHex(slot), { size: 32 }))
    const prev = await pub.getStorageAt({ address: token, slot: key })
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })])
    if ((await bal(token, holder)) === amount) return `solidity slot ${slot}`
    await rpc('anvil_setStorageAt', [token, key, prev ?? pad('0x0', { size: 32 })])
  }
  throw new Error(`could not locate a balance slot for ${token}`)
}

/** Next Thursday 00:00 UTC ~`daysOut` days ahead (1970-01-01 was a Thursday). */
function nextThursday(nowSeconds, daysOut) {
  let e = Math.floor((nowSeconds + daysOut * DAY) / DAY) * DAY
  const dow = Math.floor(e / DAY + 4) % 7 // 0 = Thursday in this frame
  e += ((0 - dow + 7) % 7) * DAY
  while (e <= nowSeconds) e += 7 * DAY
  return e
}

// --- Step runner -----------------------------------------------------------------

const results = []
async function step(name, fn) {
  try {
    const note = await fn()
    results.push({ name, ok: true, note: note ?? '' })
    console.log(`  PASS  ${name}${note ? ` — ${note}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, note: err.message?.slice(0, 300) ?? String(err) })
    console.log(`  FAIL  ${name} — ${err.message}`)
  }
}

// --- Main --------------------------------------------------------------------------

await startAnvil()
console.log('anvil ready.\n')
await rpc('anvil_setBalance', [USER, toHex(1000n * E18)])

const block = await pub.getBlock()
const now = Number(block.timestamp)
const fromBlockCheckpoint = await pub.getBlockNumber()

// Config: rateMin 0.02, rateMax 0.20, desired 0.08, fee = rateMax/25 (0.8%).
const RATE_MIN = 2n * 10n ** 16n
const RATE_MAX = 20n * 10n ** 16n
const DESIRED = 8n * 10n ** 16n
const FEE = RATE_MAX / 25n
const expiry = nextThursday(now, 90)
const config = {
  expiry,
  rateMin: RATE_MIN,
  rateMax: RATE_MAX,
  desiredImpliedRate: DESIRED,
  fee: FEE,
}
const SEED_DECIMALS = 6
const seedAmount = 5000n * 10n ** BigInt(SEED_DECIMALS) // 5000 PYUSD

console.log(
  `config: SY=${USDAI_SY}  expiry=${expiry} (${((expiry - now) / DAY).toFixed(1)}d out, Thursday 00:00 UTC)`,
)
console.log(`        rateMin=2% rateMax=20% desired=8% fee=0.8%  seed=5000 PYUSD\n`)

let deployedResult
let deployReceipt

// --- ABI/topic sanity -----------------------------------------------------------

await step('abi. commonDeployPoolAbi encodings match verified source', async () => {
  const fn = getAbiItem({ abi: commonDeployPoolAbi, name: 'deploy5115MarketAndSeedLiquidity' })
  const ev = getAbiItem({ abi: commonDeployPoolAbi, name: 'MarketDeployment' })
  const sel = toFunctionSelector(fn)
  const topic0 = toEventSelector(ev)
  assert(sel === '0x7fa1669e', `deploy5115 selector ${sel} != 0x7fa1669e`)
  assert(
    topic0 === '0xd1f8866e1ab220ea57cc2bc3d029810357a6f6df863760170473f9df5b322ebd',
    `MarketDeployment topic0 ${topic0} mismatch`,
  )
  return `selector ${sel}, topic0 …${topic0.slice(-6)}`
})

// --- 0. computeDeployParams (float mirror) sanity -------------------------------

await step('0. computeDeployParams derived params sane + self-consistent', async () => {
  const d = computeDeployParams(config, now)
  assert(d.initialAnchor >= E18, `initialAnchor ${d.initialAnchor} < 1e18`)
  assert(d.lnFeeRateRoot <= 48790164169432003n, `lnFeeRateRoot ${d.lnFeeRateRoot} > cap`)
  assert(
    d.initialProportion > 0.05 && d.initialProportion < 0.95,
    `initialProportion ${d.initialProportion} not in (0.05,0.95)`,
  )
  assert(d.scalarRoot > 0n, 'scalarRoot not positive')
  assert(d.yearsToExpiry > 0.2 && d.yearsToExpiry < 0.3, `yearsToExpiry ${d.yearsToExpiry} unexpected`)
  return `scalarRoot=${d.scalarRoot} anchor=${d.initialAnchor} lnFee=${d.lnFeeRateRoot} prop=${d.initialProportion.toFixed(4)} T=${d.yearsToExpiry.toFixed(4)}`
})

// --- fund + approve -------------------------------------------------------------

await step('fund. storage-inject PYUSD to the dev wallet', async () => {
  const slot = await fundToken(PYUSD, USER, seedAmount * 3n)
  const b = await bal(PYUSD, USER)
  assert(b >= seedAmount, 'funding did not stick')
  return `funded ${b} PYUSD via ${slot}`
})

// --- 1. preflight (positive) ----------------------------------------------------

await step('1. preflightDeploy → ok, syValid, no active PT, derived sane', async () => {
  // Approve first (the binding sim seeds via transferFrom from USER).
  const plan = planDeployPool(USDAI_SY, config, PYUSD, 'PYUSD', SEED_DECIMALS, seedAmount, USER)
  await settleApprovalsFor(plan, USER, 1)

  const pf = await preflightDeploy(pub, USDAI_SY, config, PYUSD, seedAmount, USER)
  assert(pf.syValid, 'syValid false for the live USDai SY')
  assert(!pf.ptExistsOnActive, `ptExistsOnActive true for a fresh expiry (existingPt ${pf.existingPt})`)
  assert(pf.derived !== undefined && pf.derived.initialAnchor >= E18, 'derived anchor < 1e18')
  assert(pf.derived.lnFeeRateRoot <= 48790164169432003n, 'derived lnFee > cap')
  assert(
    pf.derived.initialProportion > 0.05 && pf.derived.initialProportion < 0.95,
    `initialProportion ${pf.derived.initialProportion} out of (0.05,0.95)`,
  )
  assert(pf.simulated, `binding simulation failed: ${pf.simulationError}`)
  assert(pf.errors.length === 0, `unexpected errors: ${pf.errors.join(' | ')}`)
  assert(pf.ok, 'preflight ok=false')
  return `ok, ${pf.warnings.length} warning(s), sim passed`
})

// --- 2. plan → approve → simulate → send → decode -------------------------------

await step('2. planDeployPool → simulate → send → decode MarketDeployment', async () => {
  const plan = planDeployPool(USDAI_SY, config, PYUSD, 'PYUSD', SEED_DECIMALS, seedAmount, USER)
  assert(plan.approvals.length === 1 && plan.approvals[0].spender === COMMON_DEPLOY, 'wrong approval target')
  assert(plan.call.value === undefined, 'ERC-20 seed must not carry value')

  await settleApprovalsFor(plan, USER) // idempotent (already approved in step 1)

  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulateAction failed: ${sim.ok ? '' : sim.reason}`)

  deployReceipt = await sendPlanned(plan.call, USER)
  deployedResult = decodeDeploymentResult(deployReceipt.logs)
  assert(deployedResult !== undefined, 'MarketDeployment not decoded from receipt logs')
  const { market, sy, pt, yt } = deployedResult
  const nonzero = (a) => /^0x[0-9a-fA-F]{40}$/.test(a) && BigInt(a) !== 0n
  assert(nonzero(market) && nonzero(pt) && nonzero(yt), 'market/pt/yt not all nonzero')
  assert(sy.toLowerCase() === USDAI_SY.toLowerCase(), `event SY ${sy} != USDai SY`)
  return `market ${market} pt ${pt.slice(0, 10)}… yt ${yt.slice(0, 10)}…`
})

// --- 3. loadMarketSnapshot on the new market ------------------------------------

await step('3. loadMarketSnapshot(newMarket) → validated/active/seeded/APY-in-band', async () => {
  assert(deployedResult, 'no deployed market (step 2 failed)')
  const snap = await loadMarketSnapshot(pub, deployedResult.market)
  assert(snap.validated, 'new market did not validate via isValidMarket')
  assert(snap.vintage === 'active', `vintage ${snap.vintage} != active`)
  assert(!snap.isExpired, 'fresh market reports expired')
  assert(snap.state.totalSy > 0n, 'totalSy not seeded')
  assert(snap.state.totalPt > 0n, 'totalPt not seeded')
  const apy = snap.metrics.impliedApy
  const min = Number(RATE_MIN) / 1e18
  const max = Number(RATE_MAX) / 1e18
  assert(apy >= min - 1e-4 && apy <= max + 1e-4, `impliedApy ${apy} not in [${min},${max}]`)
  return `validated active, APY ${(apy * 100).toFixed(3)}%, totalSy=${snap.state.totalSy} totalPt=${snap.state.totalPt}`
})

// --- 4. recovery ----------------------------------------------------------------

await step('4a. recoverDeploymentFromTx → same {market,sy,pt,yt}', async () => {
  assert(deployReceipt && deployedResult, 'no deploy receipt')
  const rec = await recoverDeploymentFromTx(pub, deployReceipt.transactionHash)
  assert(rec !== undefined, 'recoverDeploymentFromTx returned undefined')
  assert(
    rec.market.toLowerCase() === deployedResult.market.toLowerCase() &&
      rec.pt.toLowerCase() === deployedResult.pt.toLowerCase() &&
      rec.yt.toLowerCase() === deployedResult.yt.toLowerCase() &&
      rec.sy.toLowerCase() === deployedResult.sy.toLowerCase(),
    'recovered addrs differ from the decoded event',
  )
  return `recovered ${rec.market}`
})

await step('4b. recoverDeployments(deployer, fromBlock) includes the new market', async () => {
  assert(deployedResult, 'no deployed market')
  const list = await recoverDeployments(pub, USER, fromBlockCheckpoint)
  const found = list.find((r) => r.market.toLowerCase() === deployedResult.market.toLowerCase())
  assert(found !== undefined, `new market not in ${list.length} recovered deployment(s)`)
  return `${list.length} deployment(s) by deployer since block ${fromBlockCheckpoint}`
})

// --- 5. Negatives (preflight, no send) — each must yield errors, no Panic thrown --

await step('5a. non-divisor expiry (expiry+1) → errors non-empty, no throw', async () => {
  const bad = { ...config, expiry: config.expiry + 1 }
  const pf = await preflightDeploy(pub, USDAI_SY, bad, PYUSD, seedAmount, USER)
  assert(!pf.ok && pf.errors.length > 0, 'expected a hard error for a non-divisor expiry')
  assert(pf.errors.some((e) => /divisor|midnight|aligned/i.test(e)), `errors: ${pf.errors.join(' | ')}`)
  return pf.errors.find((e) => /divisor|midnight|aligned/i.test(e))
})

await step('5b. rateMax == rateMin → error, no Panic surfaced', async () => {
  const bad = { ...config, rateMax: config.rateMin }
  const pf = await preflightDeploy(pub, USDAI_SY, bad, PYUSD, seedAmount, USER)
  assert(!pf.ok && pf.errors.length > 0, 'expected a hard error for an inverted/flat band')
  assert(pf.errors.some((e) => /band|min|max/i.test(e)), `errors: ${pf.errors.join(' | ')}`)
  // The float mirror must not blow up (NaN/Infinity are fine to compute; the
  // point is no thrown exception reached the caller).
  return pf.errors.find((e) => /band|min|max/i.test(e))
})

await step('5c. desired == rateMax (not strictly inside) → error', async () => {
  const bad = { ...config, desiredImpliedRate: config.rateMax }
  const pf = await preflightDeploy(pub, USDAI_SY, bad, PYUSD, seedAmount, USER)
  assert(!pf.ok && pf.errors.length > 0, 'expected a hard error for desired at the band edge')
  assert(pf.errors.some((e) => /inside|band|strictly/i.test(e)), `errors: ${pf.errors.join(' | ')}`)
  return pf.errors.find((e) => /inside|band|strictly/i.test(e))
})

await step('5d. fee = 0.10e18 (>5%) → error', async () => {
  const bad = { ...config, fee: 10n * 10n ** 16n }
  const pf = await preflightDeploy(pub, USDAI_SY, bad, PYUSD, seedAmount, USER)
  assert(!pf.ok && pf.errors.length > 0, 'expected a hard error for fee above the cap')
  assert(pf.errors.some((e) => /5%|cap|fee/i.test(e)), `errors: ${pf.errors.join(' | ')}`)
  return pf.errors.find((e) => /5%|cap|fee/i.test(e))
})

// --- 6. Duplicate edge: MarketFactoryMarketExists decode + recovery -------------

await step('6. duplicate tuple → MarketFactoryMarketExists (friendly) + recovery finds first', async () => {
  assert(deployedResult && deployReceipt, 'no first market to collide with')
  // createNewMarket keys on the EXACT tuple (PT, scalarRoot, initialAnchor,
  // lnFeeRateRoot). The float mirror matches the on-chain math to <1 ppm but
  // not bit-for-bit, so re-deriving the anchor would spawn a PARALLEL market
  // instead of colliding. To guarantee a genuine collision, replay the FIRST
  // market's exact params — they are carried (un-indexed) in the original
  // MarketDeployment event, so we decode PoolDeploymentParams from the receipt.
  let params
  for (const log of deployReceipt.logs) {
    if (log.topics[0]?.toLowerCase() !== '0xd1f8866e1ab220ea57cc2bc3d029810357a6f6df863760170473f9df5b322ebd') continue
    const decoded = decodeEventLog({
      abi: commonDeployPoolAbi,
      eventName: 'MarketDeployment',
      topics: log.topics,
      data: log.data,
    })
    params = decoded.args.params
    break
  }
  assert(params !== undefined, 'could not decode PoolDeploymentParams from the deploy receipt')

  const dupCall = {
    address: MKT_FACTORY_V7,
    abi: mktFactoryAbi,
    functionName: 'createNewMarket',
    args: [deployedResult.pt, params.scalarRoot, params.initialRateAnchor, params.lnFeeRateRoot],
  }
  const sim = await simulateAction(pub, USER, dupCall)
  assert(!sim.ok, 'duplicate createNewMarket with the exact tuple unexpectedly simulated ok')
  assert(
    /already exists/i.test(sim.reason),
    `expected a friendly "already exists" decode, got: ${sim.reason}`,
  )
  // Recovery/resolve still finds the FIRST market for this deployer.
  const list = await recoverDeployments(pub, USER, fromBlockCheckpoint)
  const found = list.find((r) => r.market.toLowerCase() === deployedResult.market.toLowerCase())
  assert(found !== undefined, 'recovery did not resolve the original market after a collision')
  return `decoded "${sim.reason.slice(0, 56)}…"; recovery found ${found.market}`
})

// --- Verdict --------------------------------------------------------------------

console.log('\n=== M6 DEPLOY TEST RESULTS ===')
const pad2 = (s, n) => String(s).padEnd(n)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad2(r.name, 66)} ${r.note ? `— ${r.note}` : ''}`)
}
const failed = results.filter((r) => !r.ok)
killAnvil()
if (failed.length > 0) {
  console.error(`\nM6 TEST FAILED — ${failed.length}/${results.length} step(s) failed`)
  process.exit(1)
}
console.log(`\nM6 TEST PASSED — ${results.length}/${results.length} steps green`)
process.exit(0)
