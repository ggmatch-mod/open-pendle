#!/usr/bin/env node
/**
 * M4 liquidity test — the M4 "done when" gate. End-to-end verification of the
 * M4 data layer (liquidity.ts previews/quotes/plans, pendleAbi liquidity ABIs,
 * txflow error decoding) against an anvil fork of Arbitrum One, exercising the
 * REAL lib modules (loadMarketSnapshot → previewDualAdd/quoteZapIn/quoteZapOut
 * → plan* → checkApprovals → approve → simulateAction → send) on the live
 * "PLP USDai 25FEB2027" market:
 *
 *   1. previewDualAdd (sy-fixed, cross-checked against the deployed
 *      addLiquidityDualSyAndPtStatic) → planDualAdd(SY+PT) → approve×2 →
 *      execute → LP delta ≈ lpOutEstimate (±0.5%), leftover dust tiny;
 *   2. previewDualAdd token-fixed sanity (syDesired ≡ SY.previewDeposit,
 *      ptDesired = CEILING ratio math — the NOT_ALL_SY_USED rule);
 *   2b. token-pay dual add EXECUTED: previewDualAdd('token') →
 *      planDualAdd(PYUSD+PT) → approve×2 → simulate (catches the
 *      floor-division 'Slippage: NOT_ALL_SY_USED' blocker class) →
 *      execute → LP delta ≈ lpOutEstimate (±0.5%);
 *   3. quoteZapIn(PYUSD, keepYt=false) → planZapIn → execute → LP delta vs
 *      quote ≤ 0.2%; ApproxParams synthesized from netPtFromSwap + embedded;
 *   4. quoteZapIn(SY, keepYt=true) → planZapIn KeepYt → execute → LP AND YT
 *      deltas vs quote (both statics exist on the deployed diamond);
 *   4b. quoteZapIn(PYUSD, keepYt=true) → planZapIn → execute — the TOKEN
 *      KeepYt router variant (addLiquiditySingleTokenKeepYt), LP + YT deltas;
 *   5. previewDualRemove → planDualRemove(to SY) → execute → ±0.5%;
 *   6. quoteZapOut(PYUSD, all remaining LP) → planZapOut → execute → ≤ 0.2%;
 *   7. round-trip value sanity: PYUSD-equivalent of all holdings within a few
 *      % of the funded start (fees + impact only);
 *   8. negatives: minLpOut = 2× quote → friendly slippage decode; dual add on
 *      the EXPIRED market → decoded 'expired' message.
 *
 * Run from app/ (requires foundry's `anvil` on PATH):
 *   node --experimental-strip-types scripts/m4-liquidity-test.mjs
 *
 * Env:
 *   ARB_RPC_URL — optional fork-source RPC override (tried first).
 *   ANVIL_PORT  — fork port, default 8549.
 *
 * Prints a per-step PASS/FAIL table; exits 1 on any failure.
 * (No npm script here by design — the orchestrator wires it.)
 */

import { spawn } from 'node:child_process'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  pad,
  toFunctionSelector,
  toHex,
} from 'viem'
import { arbitrum } from 'viem/chains'
import { loadMarketSnapshot } from '../src/lib/market.ts'
import { planWrap, quoteWrap } from '../src/lib/actions.ts'
import { planBuy, quoteBuy } from '../src/lib/swaps.ts'
import {
  planDualAdd,
  planDualRemove,
  planZapIn,
  planZapOut,
  previewDualAdd,
  previewDualRemove,
  quoteZapIn,
  quoteZapOut,
} from '../src/lib/liquidity.ts'
import { buildApproveCall, checkApprovals, simulateAction } from '../src/lib/txflow.ts'
import { erc20Abi, routerStaticLiquidityAbi, syActionsAbi } from '../src/lib/pendleAbi.ts'
import { ROUTER_STATIC } from '../src/lib/addresses.ts'

// --- Config ------------------------------------------------------------------

const PORT = Number(process.env.ANVIL_PORT ?? 8549)
const FORK_URLS = [
  process.env.ARB_RPC_URL,
  'https://arb1.arbitrum.io/rpc',
  'https://arbitrum-one-rpc.publicnode.com',
].filter(Boolean)

/** Live USDai community market (active, expiry 2027, fee-discounted). */
const LIVE_MARKET = '0x46f545683d8494ef4c54b7ea40ca762c620846ef'
/** Expired market for the MarketExpired negative path (same as m2). */
const EXPIRED_MARKET = '0xd89a6f5b5be3ed4379cb4b8b76ed51551d3c4dba'
/** anvil default account[0] — pre-funded; auto-impersonate covers the rest. */
const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const ZERO = '0x0000000000000000000000000000000000000000'
const RPC = `http://127.0.0.1:${PORT}`
/** Gate: |static quote − executed| / executed for zap legs (0.2%). */
const MAX_ZAP_DEV_PPM = 2000n
/** Gate: dual-side preview vs execution (±0.5% — pure ratio math). */
const MAX_DUAL_DEV_PPM = 5000n
/** Zap slippage used throughout the legs. */
const LEG_SLIPPAGE = 0.005

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

async function sendPlanned(call, from) {
  const base = {
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    ...(call.value !== undefined ? { value: call.value } : {}),
    account: from,
  }
  // Estimate + 50% headroom (m2 lesson: node estimates can under-shoot on
  // fresh interest-index writes).
  const estimate = await pub.estimateContractGas(base)
  const hash = await wallet.writeContract({ ...base, gas: (estimate * 15n) / 10n, chain: arbitrum })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`tx ${call.functionName} reverted on-chain (${hash})`)
  }
  return receipt
}

const bal = (token, owner) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** |a − b| in parts-per-million of b. */
function devPpm(a, b) {
  if (b === 0n) return a === 0n ? 0n : 10n ** 9n
  const d = a > b ? a - b : b - a
  return (d * 1_000_000n) / b
}

function fmtDev(quoted, executed, decimals) {
  return `quote ${formatUnits(quoted, decimals)} vs executed ${formatUnits(executed, decimals)} (Δ ${devPpm(quoted, executed)} ppm)`
}

/** Send exact-amount approvals until a plan's approval set is fully met. */
async function settleApprovals(plan, expectedCount) {
  let unmet = await checkApprovals(pub, USER, plan.approvals)
  if (expectedCount !== undefined) {
    assert(unmet.length === expectedCount, `expected ${expectedCount} unmet approval(s), got ${unmet.length}`)
  }
  let rounds = 0
  while (unmet.length > 0) {
    await sendPlanned(buildApproveCall(unmet[0], false), USER)
    const next = await checkApprovals(pub, USER, plan.approvals)
    assert(next.length < unmet.length, 'approve tx did not reduce the unmet approval set')
    unmet = next
    assert(++rounds <= 6, 'approval loop stuck')
  }
}

/** OZ v5 ERC-7201 namespaced ERC20 storage base; balances mapping at base+0. */
const OZ_V5_ERC20_BASE = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'

/** Deterministic funding by balance-slot storage injection (m2/m3 pattern). */
async function fundToken(token, holder, amount) {
  const candidates = [{ key: mappingKey(holder, OZ_V5_ERC20_BASE), label: 'OZ-v5 ERC-7201 base' }]
  for (let slot = 0n; slot < 40n; slot++) {
    candidates.push({
      key: mappingKey(holder, pad(toHex(slot), { size: 32 })),
      label: `solidity slot ${slot}`,
    })
    candidates.push({
      key: keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [slot, holder])),
      label: `vyper slot ${slot}`,
    })
  }
  for (const { key, label } of candidates) {
    const prev = await pub.getStorageAt({ address: token, slot: key })
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })])
    if ((await bal(token, holder)) === amount) return `storage injection (${label})`
    await rpc('anvil_setStorageAt', [token, key, prev ?? pad('0x0', { size: 32 })])
  }
  throw new Error(`could not locate a balance slot for ${token}`)
}

function mappingKey(holder, baseSlot32) {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [holder, baseSlot32]))
}

/** Extract the embedded ApproxParams struct from a zap-in plan's call args. */
function embeddedZapApprox(plan) {
  const fn = plan.call.functionName
  if (fn === 'addLiquiditySingleSy') return plan.call.args[4]
  if (fn === 'addLiquiditySingleToken') return plan.call.args[3]
  throw new Error(`not a non-KeepYt zap-in call: ${fn}`)
}

// --- Step runner -----------------------------------------------------------------

const results = []
async function step(name, fn) {
  try {
    const note = await fn()
    results.push({ name, ok: true, note: note ?? '' })
    console.log(`  PASS  ${name}${note ? ` — ${note}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, note: err.message?.slice(0, 220) ?? String(err) })
    console.log(`  FAIL  ${name} — ${err.message}`)
  }
}

// --- Main --------------------------------------------------------------------------

await startAnvil()
console.log('anvil ready.\n')
await rpc('anvil_setBalance', [USER, toHex(1000n * 10n ** 18n)])

// ============ RouterStatic liquidity-static selector survey ============

/** The 10 statics routerStaticLiquidityAbi encodes (must all dispatch). */
const REQUIRED_LIQ_STATIC_SIGS = [
  'addLiquidityDualSyAndPtStatic(address,uint256,uint256)',
  'addLiquidityDualTokenAndPtStatic(address,address,uint256,uint256)',
  'addLiquiditySingleSyStatic(address,uint256)',
  'addLiquiditySingleTokenStatic(address,address,uint256)',
  'addLiquiditySingleSyKeepYtStatic(address,uint256)',
  'addLiquiditySingleTokenKeepYtStatic(address,address,uint256)',
  'removeLiquidityDualSyAndPtStatic(address,uint256)',
  'removeLiquidityDualTokenAndPtStatic(address,uint256,address)',
  'removeLiquiditySingleSyStatic(address,uint256)',
  'removeLiquiditySingleTokenStatic(address,uint256,address)',
]
/** Out-of-scope PT-sided statics — surveyed for the record only. */
const INFO_LIQ_STATIC_SIGS = [
  'addLiquiditySinglePtStatic(address,uint256)',
  'removeLiquiditySinglePtStatic(address,uint256)',
]

async function selectorPresent(sig) {
  // Probe with plausible args on the live market; 'selector not found' is the
  // diamond's miss marker — any other outcome means the facet dispatched.
  const argWords = sig.split(',').length
  const data =
    toFunctionSelector(sig) +
    pad(LIVE_MARKET, { size: 32 }).slice(2) +
    pad(toHex(10n ** 18n), { size: 32 }).slice(2).repeat(argWords - 1)
  try {
    await pub.call({ to: ROUTER_STATIC, data })
    return true
  } catch (err) {
    return !/selector not found/i.test(err?.message ?? '')
  }
}

const selectorSurvey = []
await step('0. RouterStatic liquidity-static selector survey (10 required + 2 info)', async () => {
  for (const sig of REQUIRED_LIQ_STATIC_SIGS) {
    const present = await selectorPresent(sig)
    selectorSurvey.push({ sig, present, required: true })
    assert(present, `required liquidity static MISSING on deployed diamond: ${sig}`)
  }
  const infoNotes = []
  for (const sig of INFO_LIQ_STATIC_SIGS) {
    const present = await selectorPresent(sig)
    selectorSurvey.push({ sig, present, required: false })
    infoNotes.push(present ? 'present' : 'missing')
  }
  return `all 10 encoded statics present (incl. BOTH KeepYt); PT-sided info statics: ${infoNotes.join('/')}`
})

// ============ Fixture: fund PYUSD, wrap SY, buy PT ============

console.log(`\nLoading LIVE market snapshot ${LIVE_MARKET} …`)
let live = await loadMarketSnapshot(pub, LIVE_MARKET)
assert(!live.isExpired, 'live market unexpectedly expired — pick another live market')
const liveSy = live.sy
const assetDec = liveSy.assetDecimals
const SY_UNIT = 10n ** BigInt(liveSy.decimals)

const tokenCandidates = liveSy.tokensIn.filter((t) => t.toLowerCase() !== ZERO)
const tokenSymbols = await Promise.all(
  tokenCandidates.map((t) =>
    pub.readContract({ address: t, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
  ),
)
const pyusdIdx = tokenSymbols.findIndex((s) => s.toUpperCase() === 'PYUSD')
const PYUSD = tokenCandidates[pyusdIdx >= 0 ? pyusdIdx : 0]
const PYUSD_SYMBOL = tokenSymbols[pyusdIdx >= 0 ? pyusdIdx : 0]
const PYUSD_DEC = Number(
  await pub.readContract({ address: PYUSD, abi: erc20Abi, functionName: 'decimals' }),
)
const PYUSD_UNIT = 10n ** BigInt(PYUSD_DEC)
assert(
  liveSy.tokensOut.some((t) => t.toLowerCase() === PYUSD.toLowerCase()),
  `${PYUSD_SYMBOL} not in SY.tokensOut — zap-out leg impossible`,
)

/** Funded start — the round-trip baseline (step 7). */
const START_PYUSD = 4000n * PYUSD_UNIT
console.log(`LIVE: ${live.displayName} | token ${PYUSD_SYMBOL} (${PYUSD_DEC}d) | impliedApy ${(live.metrics.impliedApy * 100).toFixed(3)}%`)
const fundNote = await fundToken(PYUSD, USER, START_PYUSD)
console.log(`Funded ${formatUnits(START_PYUSD, PYUSD_DEC)} ${PYUSD_SYMBOL} via ${fundNote}.\n`)

const reload = async () => {
  live = await loadMarketSnapshot(pub, LIVE_MARKET)
}

await step('f0. fixture: wrap 1500 PYUSD → SY (M2 planWrap) + buy PT with 800 PYUSD (M3 planBuy)', async () => {
  const wrapIn = 1500n * PYUSD_UNIT
  const wrapQuote = await quoteWrap(pub, liveSy, PYUSD, wrapIn)
  const wrapPlan = planWrap(liveSy, PYUSD, PYUSD_SYMBOL, PYUSD_DEC, wrapIn, (wrapQuote * 99n) / 100n, USER)
  await settleApprovals(wrapPlan)
  await sendPlanned(wrapPlan.call, USER)
  const syBal = await bal(liveSy.address, USER)
  assert(syBal >= (wrapQuote * 99n) / 100n, `wrap produced ${syBal} SY < min`)

  const buyIn = 800n * PYUSD_UNIT
  const buyQuote = await quoteBuy(pub, live, 'pt', PYUSD, buyIn, LEG_SLIPPAGE)
  const buyPlan = planBuy(live, 'pt', PYUSD, PYUSD_SYMBOL, PYUSD_DEC, buyIn, (buyQuote.amountOut * 995n) / 1000n, buyQuote.approx, USER)
  await settleApprovals(buyPlan)
  await sendPlanned(buyPlan.call, USER)
  const ptBal = await bal(live.pt, USER)
  assert(ptBal > 0n, 'PT buy produced nothing')
  await reload()
  return `holding ${formatUnits(syBal, liveSy.decimals)} SY + ${formatUnits(ptBal, assetDec)} PT`
})

// ============ 1. dual add (sy-fixed) ============

await step('1. previewDualAdd(sy-fixed) → planDualAdd(SY+PT) → approve×2 → execute', async () => {
  const syAmount = 500n * SY_UNIT
  const preview = await previewDualAdd(pub, live, 'sy', undefined, syAmount)
  assert(preview.syDesired === syAmount, 'sy-fixed preview must echo the SY side')
  assert(preview.ptDesired > 0n && preview.lpOutEstimate > 0n, 'preview returned zeros')
  assert(preview.shareOfPoolAfter > 0 && preview.shareOfPoolAfter < 1, `shareOfPoolAfter out of range: ${preview.shareOfPoolAfter}`)

  // Cross-check the pure ratio math against the deployed dual static.
  const [staticLp, staticSyUsed, staticPtUsed] = await pub.readContract({
    address: ROUTER_STATIC,
    abi: routerStaticLiquidityAbi,
    functionName: 'addLiquidityDualSyAndPtStatic',
    args: [live.address, syAmount, preview.ptDesired],
  })
  assert(devPpm(preview.lpOutEstimate, staticLp) <= 10n,
    `preview lp ${preview.lpOutEstimate} vs deployed static ${staticLp} (Δ ${devPpm(preview.lpOutEstimate, staticLp)} ppm)`)
  assert(devPpm(preview.ptDesired, staticPtUsed) <= 10n, 'preview ptDesired diverges from static netPtUsed')
  assert(staticSyUsed <= syAmount, 'static used more SY than desired?')

  assert((await bal(live.pt, USER)) >= preview.ptDesired, 'fixture PT insufficient for the dual add')
  const minLpOut = (preview.lpOutEstimate * 995n) / 1000n
  const plan = planDualAdd(live, liveSy.address, liveSy.symbol, liveSy.decimals, syAmount, preview.ptDesired, minLpOut, USER)
  assert(plan.call.functionName === 'addLiquidityDualSyAndPt', `wrong call: ${plan.call.functionName}`)
  assert(plan.approvals.length === 2, `dual add must need SY AND PT approvals, got ${plan.approvals.length}`)
  await settleApprovals(plan, 2) // approve×2: SY + PT, both fresh for the router
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)

  const [lpBefore, syBefore, ptBefore] = await Promise.all([
    bal(live.address, USER), bal(liveSy.address, USER), bal(live.pt, USER),
  ])
  await sendPlanned(plan.call, USER)
  const [lpAfter, syAfter, ptAfter] = await Promise.all([
    bal(live.address, USER), bal(liveSy.address, USER), bal(live.pt, USER),
  ])
  const lpDelta = lpAfter - lpBefore
  const dev = devPpm(preview.lpOutEstimate, lpDelta)
  assert(dev <= MAX_DUAL_DEV_PPM, `LP delta deviates ${dev} ppm > ±0.5%: ${fmtDev(preview.lpOutEstimate, lpDelta, 18)}`)
  // Leftover dust: the router pulls only what the ratio absorbs — both sides
  // must be consumed to within 0.1% of the desired amounts.
  const syDust = syAmount - (syBefore - syAfter)
  const ptDust = preview.ptDesired - (ptBefore - ptAfter)
  assert(syDust >= 0n && devPpm(syAmount - syDust, syAmount) <= 1000n, `SY dust too large: ${syDust}`)
  assert(ptDust >= 0n && devPpm(preview.ptDesired - ptDust, preview.ptDesired) <= 1000n, `PT dust too large: ${ptDust}`)
  await reload()
  return `${fmtDev(preview.lpOutEstimate, lpDelta, 18)}; dust SY ${syDust} wei / PT ${ptDust} wei; static cross-check ≤10 ppm`
})

// ============ 2. dual add preview (token-fixed) sanity ============

await step('2. previewDualAdd(token-fixed) sanity — syDesired ≡ SY.previewDeposit', async () => {
  const tokenAmount = 100n * PYUSD_UNIT
  const preview = await previewDualAdd(pub, live, 'token', PYUSD, tokenAmount)
  const expectedSy = await quoteWrap(pub, liveSy, PYUSD, tokenAmount)
  assert(preview.syDesired === expectedSy,
    `syDesired ${preview.syDesired} != previewDeposit ${expectedSy}`)
  // PT side must sit on the pool ratio of the derived SY amount — CEILING
  // division, matching previewDualAdd's token branch: the token-pay router fn
  // (addLiquidityDualTokenAndPt) requires ALL wrapped SY to be consumed
  // ('Slippage: NOT_ALL_SY_USED'), so SY must be the binding side.
  const expectedPt =
    (expectedSy * live.state.totalPt + live.state.totalSy - 1n) / live.state.totalSy
  assert(preview.ptDesired === expectedPt, `ptDesired ${preview.ptDesired} != ceiling-ratio-derived ${expectedPt}`)
  assert(preview.lpOutEstimate > 0n, 'lpOutEstimate is zero')
  return `100 ${PYUSD_SYMBOL} wraps to ${formatUnits(preview.syDesired, liveSy.decimals)} SY → ${formatUnits(preview.ptDesired, assetDec)} PT alongside (ceiling)`
})

// ============ 2b. dual add (token-fixed) EXECUTED ============

await step('2b. previewDualAdd(token-fixed) → planDualAdd(PYUSD+PT) → approve×2 → execute', async () => {
  const tokenAmount = 100n * PYUSD_UNIT
  const preview = await previewDualAdd(pub, live, 'token', PYUSD, tokenAmount)
  assert(preview.ptDesired > 0n && preview.lpOutEstimate > 0n, 'preview returned zeros')
  assert((await bal(live.pt, USER)) >= preview.ptDesired, 'fixture PT insufficient for the token-pay dual add')

  const minLpOut = (preview.lpOutEstimate * 995n) / 1000n
  const plan = planDualAdd(live, PYUSD, PYUSD_SYMBOL, PYUSD_DEC, tokenAmount, preview.ptDesired, minLpOut, USER)
  assert(plan.call.functionName === 'addLiquidityDualTokenAndPt', `wrong call: ${plan.call.functionName}`)
  assert(plan.approvals.length === 2, `token-pay dual add must need ${PYUSD_SYMBOL} AND PT approvals, got ${plan.approvals.length}`)
  const approvalTokens = plan.approvals.map((a) => a.token.toLowerCase())
  assert(approvalTokens.includes(PYUSD.toLowerCase()) && approvalTokens.includes(live.pt.toLowerCase()),
    `approvals must cover ${PYUSD_SYMBOL} + PT, got: ${approvalTokens.join(', ')}`)
  await settleApprovals(plan, 2) // approve×2: PYUSD + PT, both fresh for the router
  // THE BLOCKER CLASS LIVES HERE: with a floor-derived PT side the router
  // reverts 'Slippage: NOT_ALL_SY_USED' deterministically (1 wei of wrapped
  // SY left unconsumed). The ceiling derivation must simulate clean.
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)

  const [lpBefore, ptBefore] = await Promise.all([bal(live.address, USER), bal(live.pt, USER)])
  await sendPlanned(plan.call, USER)
  const [lpAfter, ptAfter] = await Promise.all([bal(live.address, USER), bal(live.pt, USER)])
  const lpDelta = lpAfter - lpBefore
  const dev = devPpm(preview.lpOutEstimate, lpDelta)
  assert(dev <= MAX_DUAL_DEV_PPM, `LP delta deviates ${dev} ppm > ±0.5%: ${fmtDev(preview.lpOutEstimate, lpDelta, 18)}`)
  // The router pulls only netPtUsed — never more than the approved ptDesired
  // (the ceiling's extra wei stays in the wallet).
  const ptPulled = ptBefore - ptAfter
  assert(ptPulled <= preview.ptDesired, `router pulled ${ptPulled} PT > approved ptDesired ${preview.ptDesired}`)
  await reload()
  return `${fmtDev(preview.lpOutEstimate, lpDelta, 18)}; PT pulled ${formatUnits(ptPulled, assetDec)} of ${formatUnits(preview.ptDesired, assetDec)} desired`
})

// ============ 3. zap in (PYUSD, keepYt=false) ============

await step('3. quoteZapIn(PYUSD, keepYt=false) → planZapIn → execute (≤0.2%)', async () => {
  const amountIn = 300n * PYUSD_UNIT
  const quote = await quoteZapIn(pub, live, PYUSD, amountIn, false, LEG_SLIPPAGE)
  assert(quote.amountOut > 0n, 'zap-in quote returned 0')
  assert(quote.approx !== null, 'non-KeepYt zap-in must carry synthesized ApproxParams')
  assert(quote.approx.guessOffchain > 0n, 'synthesized guessOffchain must be > 0 (netPtFromSwap)')
  assert(quote.approx.guessOffchain !== quote.amountOut,
    'guessOffchain must be the INTERNAL netPtFromSwap, not the LP out')
  assert(quote.approx.guessMin === (quote.approx.guessOffchain * 9950n) / 10_000n,
    'guessMin must scale with the passed slippage (0.5% → ×0.995, floored)')
  assert(quote.approx.guessMax === (quote.approx.guessOffchain * 105n) / 100n,
    'guessMax must carry the +5% headroom')
  assert(quote.priceImpact > 0 && quote.netSyFee > 0n, 'zap-in swap leg must report fee + impact')
  assert(quote.impliedApyAfter !== undefined, 'impliedApyAfter missing on the swap-backed zap quote')

  const minLpOut = (quote.amountOut * 995n) / 1000n
  const plan = planZapIn(live, PYUSD, PYUSD_SYMBOL, PYUSD_DEC, amountIn, minLpOut, undefined, quote.approx, false, USER)
  assert(plan.call.functionName === 'addLiquiditySingleToken', `wrong call: ${plan.call.functionName}`)
  const embedded = embeddedZapApprox(plan)
  assert(embedded.guessOffchain === quote.approx.guessOffchain, 'plan must embed the synthesized ApproxParams')
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const before = await bal(live.address, USER)
  await sendPlanned(plan.call, USER)
  const lpDelta = (await bal(live.address, USER)) - before
  assert(lpDelta >= minLpOut, `executed ${lpDelta} < plan minLpOut ${minLpOut}`)
  const dev = devPpm(quote.amountOut, lpDelta)
  assert(dev <= MAX_ZAP_DEV_PPM, `zap-in deviation ${dev} ppm > 0.2%: ${fmtDev(quote.amountOut, lpDelta, 18)}`)
  await reload()
  return `${fmtDev(quote.amountOut, lpDelta, 18)}; approx SYNTHESIZED from netPtFromSwap ${formatUnits(quote.approx.guessOffchain, assetDec)} PT`
})

// ============ 4. zap in (SY, keepYt=true) ============

await step('4. quoteZapIn(SY, keepYt=true) → planZapIn KeepYt → execute (LP + YT deltas)', async () => {
  const amountIn = 200n * SY_UNIT
  assert((await bal(liveSy.address, USER)) >= amountIn, 'fixture SY insufficient for the KeepYt zap')
  const quote = await quoteZapIn(pub, live, liveSy.address, amountIn, true, LEG_SLIPPAGE)
  assert(quote.amountOut > 0n, 'KeepYt quote returned 0 LP')
  assert(quote.ytOut !== undefined && quote.ytOut > 0n, 'KeepYt static exists on the diamond — quote.ytOut must be set')
  assert(quote.approx === null, 'KeepYt variants take NO ApproxParams — approx must be null')
  assert(quote.priceImpact === 0 && quote.netSyFee === 0n, 'KeepYt does no AMM swap — fee/impact must be zero')

  const minLpOut = (quote.amountOut * 995n) / 1000n
  const minYtOut = (quote.ytOut * 995n) / 1000n
  const plan = planZapIn(live, liveSy.address, liveSy.symbol, liveSy.decimals, amountIn, minLpOut, minYtOut, quote.approx, true, USER)
  assert(plan.call.functionName === 'addLiquiditySingleSyKeepYt', `wrong call: ${plan.call.functionName}`)
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const [lpBefore, ytBefore] = await Promise.all([bal(live.address, USER), bal(live.yt, USER)])
  await sendPlanned(plan.call, USER)
  const [lpAfter, ytAfter] = await Promise.all([bal(live.address, USER), bal(live.yt, USER)])
  const lpDelta = lpAfter - lpBefore
  const ytDelta = ytAfter - ytBefore
  const lpDev = devPpm(quote.amountOut, lpDelta)
  const ytDev = devPpm(quote.ytOut, ytDelta)
  assert(lpDelta >= minLpOut, `LP ${lpDelta} < minLpOut ${minLpOut}`)
  assert(ytDelta >= minYtOut, `YT ${ytDelta} < minYtOut ${minYtOut}`)
  assert(lpDev <= MAX_ZAP_DEV_PPM, `KeepYt LP deviation ${lpDev} ppm > 0.2%`)
  assert(ytDev <= MAX_ZAP_DEV_PPM, `KeepYt YT deviation ${ytDev} ppm > 0.2% (netYtOut tuple position?)`)
  await reload()
  return `LP ${fmtDev(quote.amountOut, lpDelta, 18)}; YT ${fmtDev(quote.ytOut, ytDelta, assetDec)} — quoted via the deployed KeepYt STATIC`
})

// ============ 4b. zap in (PYUSD, keepYt=true) — TOKEN KeepYt variant ============

await step('4b. quoteZapIn(PYUSD, keepYt=true) → planZapIn TokenKeepYt → execute (LP + YT deltas)', async () => {
  const amountIn = 150n * PYUSD_UNIT
  const quote = await quoteZapIn(pub, live, PYUSD, amountIn, true, LEG_SLIPPAGE)
  assert(quote.amountOut > 0n, 'token KeepYt quote returned 0 LP')
  assert(quote.ytOut !== undefined && quote.ytOut > 0n, 'token KeepYt static exists on the diamond — quote.ytOut must be set')
  assert(quote.approx === null, 'KeepYt variants take NO ApproxParams — approx must be null')
  assert(quote.priceImpact === 0 && quote.netSyFee === 0n, 'KeepYt does no AMM swap — fee/impact must be zero')

  const minLpOut = (quote.amountOut * 995n) / 1000n
  const minYtOut = (quote.ytOut * 995n) / 1000n
  const plan = planZapIn(live, PYUSD, PYUSD_SYMBOL, PYUSD_DEC, amountIn, minLpOut, minYtOut, quote.approx, true, USER)
  assert(plan.call.functionName === 'addLiquiditySingleTokenKeepYt', `wrong call: ${plan.call.functionName}`)
  assert(plan.approvals.length === 1 && plan.approvals[0].token.toLowerCase() === PYUSD.toLowerCase(),
    'token KeepYt zap-in must approve the pay token only')
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const [lpBefore, ytBefore] = await Promise.all([bal(live.address, USER), bal(live.yt, USER)])
  await sendPlanned(plan.call, USER)
  const [lpAfter, ytAfter] = await Promise.all([bal(live.address, USER), bal(live.yt, USER)])
  const lpDelta = lpAfter - lpBefore
  const ytDelta = ytAfter - ytBefore
  const lpDev = devPpm(quote.amountOut, lpDelta)
  const ytDev = devPpm(quote.ytOut, ytDelta)
  assert(lpDelta >= minLpOut, `LP ${lpDelta} < minLpOut ${minLpOut}`)
  assert(ytDelta >= minYtOut, `YT ${ytDelta} < minYtOut ${minYtOut}`)
  assert(lpDev <= MAX_ZAP_DEV_PPM, `token KeepYt LP deviation ${lpDev} ppm > 0.2%`)
  assert(ytDev <= MAX_ZAP_DEV_PPM, `token KeepYt YT deviation ${ytDev} ppm > 0.2%`)
  await reload()
  return `LP ${fmtDev(quote.amountOut, lpDelta, 18)}; YT ${fmtDev(quote.ytOut, ytDelta, assetDec)} — TOKEN KeepYt variant EXECUTED`
})

// ============ 5. dual remove (to SY) ============

await step('5. previewDualRemove → planDualRemove(to SY) → execute (±0.5%)', async () => {
  const lpBal = await bal(live.address, USER)
  assert(lpBal > 0n, 'no LP to remove')
  const lpIn = lpBal / 2n
  const preview = previewDualRemove(live, lpIn)
  assert(preview.syOut > 0n && preview.ptOut > 0n, 'preview returned zeros')
  assert(preview.shareBurned > 0 && preview.shareBurned < 1, `shareBurned out of range: ${preview.shareBurned}`)

  const plan = planDualRemove(
    live, liveSy.address, liveSy.symbol, liveSy.decimals, lpIn,
    (preview.syOut * 995n) / 1000n, (preview.ptOut * 995n) / 1000n, USER,
  )
  assert(plan.call.functionName === 'removeLiquidityDualSyAndPt', `wrong call: ${plan.call.functionName}`)
  assert(plan.approvals.length === 1 && plan.approvals[0].token.toLowerCase() === live.address.toLowerCase(),
    'dual remove must approve the LP token (the market address) only')
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const [syBefore, ptBefore] = await Promise.all([bal(liveSy.address, USER), bal(live.pt, USER)])
  await sendPlanned(plan.call, USER)
  const [syAfter, ptAfter] = await Promise.all([bal(liveSy.address, USER), bal(live.pt, USER)])
  const syDelta = syAfter - syBefore
  const ptDelta = ptAfter - ptBefore
  const syDev = devPpm(preview.syOut, syDelta)
  const ptDev = devPpm(preview.ptOut, ptDelta)
  assert(syDev <= MAX_DUAL_DEV_PPM, `SY deviation ${syDev} ppm > ±0.5%: ${fmtDev(preview.syOut, syDelta, liveSy.decimals)}`)
  assert(ptDev <= MAX_DUAL_DEV_PPM, `PT deviation ${ptDev} ppm > ±0.5%: ${fmtDev(preview.ptOut, ptDelta, assetDec)}`)
  await reload()
  return `SY ${fmtDev(preview.syOut, syDelta, liveSy.decimals)}; PT ${fmtDev(preview.ptOut, ptDelta, assetDec)}`
})

// ============ 6. zap out (all remaining LP → PYUSD) ============

await step('6. quoteZapOut(PYUSD, all remaining LP) → planZapOut → execute (≤0.2%)', async () => {
  const lpIn = await bal(live.address, USER)
  assert(lpIn > 0n, 'no LP left to zap out')
  const quote = await quoteZapOut(pub, live, PYUSD, lpIn)
  assert(quote.amountOut > 0n, 'zap-out quote returned 0')
  assert(quote.approx === null, 'zap-out takes no ApproxParams')
  assert(quote.netSyFee > 0n, 'zap-out swap leg must report a fee')

  const minTokenOut = (quote.amountOut * 995n) / 1000n
  const plan = planZapOut(live, PYUSD, PYUSD_SYMBOL, PYUSD_DEC, lpIn, minTokenOut, USER)
  assert(plan.call.functionName === 'removeLiquiditySingleToken', `wrong call: ${plan.call.functionName}`)
  assert(plan.approvals.length === 1 && plan.approvals[0].token.toLowerCase() === live.address.toLowerCase(),
    'zap out must approve the LP token (the market address) only')
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const before = await bal(PYUSD, USER)
  await sendPlanned(plan.call, USER)
  const tokenDelta = (await bal(PYUSD, USER)) - before
  assert(tokenDelta >= minTokenOut, `executed ${tokenDelta} < minTokenOut ${minTokenOut}`)
  const dev = devPpm(quote.amountOut, tokenDelta)
  assert(dev <= MAX_ZAP_DEV_PPM, `zap-out deviation ${dev} ppm > 0.2%: ${fmtDev(quote.amountOut, tokenDelta, PYUSD_DEC)}`)
  assert((await bal(live.address, USER)) === 0n, 'LP not fully zapped out')
  await reload()
  return fmtDev(quote.amountOut, tokenDelta, PYUSD_DEC)
})

// ============ 7. round-trip value sanity ============

await step('7. round-trip value: PYUSD-equivalent of all holdings within a few % of start', async () => {
  const [pyusdBal, syBal, ptBal, ytBal, lpBal] = await Promise.all([
    bal(PYUSD, USER), bal(liveSy.address, USER), bal(live.pt, USER), bal(live.yt, USER), bal(live.address, USER),
  ])
  assert(lpBal === 0n, 'unexpected LP left')
  // SY → PYUSD via the exact preview; PT/YT valued at the snapshot's
  // asset-terms prices (asset = USDai ≈ 1 PYUSD — both USD stables).
  const syAsPyusd = syBal > 0n ? await pub.readContract({
    address: liveSy.address,
    abi: syActionsAbi,
    functionName: 'previewRedeem',
    args: [PYUSD, syBal],
  }) : 0n
  const f = (x, d) => Number(formatUnits(x, d))
  const endValue =
    f(pyusdBal, PYUSD_DEC) +
    f(syAsPyusd, PYUSD_DEC) +
    f(ptBal, assetDec) * live.metrics.ptPriceAsset +
    f(ytBal, assetDec) * live.metrics.ytPriceAsset
  const startValue = f(START_PYUSD, PYUSD_DEC)
  const lossPct = ((startValue - endValue) / startValue) * 100
  assert(Math.abs(lossPct) < 3, `round-trip drift ${lossPct.toFixed(3)}% — outside the fees+impact budget`)
  return `start ${startValue} → end ${endValue.toFixed(2)} PYUSD-equiv (net ${lossPct >= 0 ? '-' : '+'}${Math.abs(lossPct).toFixed(3)}%, fees+impact only)`
})

// ============ 8. negatives ============

await step('n1. negative: minLpOut = 2× quote decodes as friendly slippage', async () => {
  const amountIn = 50n * PYUSD_UNIT
  const quote = await quoteZapIn(pub, live, PYUSD, amountIn, false, LEG_SLIPPAGE)
  const plan = planZapIn(
    live, PYUSD, PYUSD_SYMBOL, PYUSD_DEC, amountIn,
    quote.amountOut * 2n, // unreachable minLpOut
    undefined, quote.approx, false, USER,
  )
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(!sim.ok, 'doubled minLpOut unexpectedly simulated OK')
  assert(/slippage/i.test(sim.reason), `expected a friendly slippage decode, got: ${sim.reason}`)
  return `"${sim.reason.slice(0, 80)}"`
})

await step('n2. negative: add liquidity on the EXPIRED market decodes as expired', async () => {
  const expired = await loadMarketSnapshot(pub, EXPIRED_MARKET)
  assert(expired.isExpired, 'expired fixture market is not expired?')
  // Facet-verified: the dual-add ratio math (which reverts MarketExpired) runs
  // BEFORE any transferFrom, so no balances/approvals are needed to hit it.
  const plan = planDualAdd(
    expired, expired.sy.address, expired.sy.symbol, expired.sy.decimals,
    10n ** 12n, 10n ** 12n, 0n, USER,
  )
  const sim = await simulateAction(pub, USER, plan.call)
  assert(!sim.ok, 'add liquidity on an expired market unexpectedly simulated OK')
  assert(/expired/i.test(sim.reason), `expected the expired decode, got: ${sim.reason}`)
  return `"${sim.reason.slice(0, 80)}"`
})

// --- Report --------------------------------------------------------------------

console.log('\n===== RouterStatic liquidity-static selector survey =====')
for (const { sig, present, required } of selectorSurvey) {
  console.log(`${present ? 'PRESENT' : 'MISSING'}${required ? '' : ' (info)'}  ${sig}`)
}

console.log('\n===== M4 liquidity test results =====')
const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.note}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)

killAnvil()
process.exit(failed.length > 0 ? 1 : 0)
