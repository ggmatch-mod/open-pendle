#!/usr/bin/env node
/**
 * M2 flow test — end-to-end verification of the M2 data layer (actions.ts,
 * txflow.ts, positions.ts) against an anvil fork of Arbitrum One, exercising
 * the real lib modules (loadMarketSnapshot → quote/plan → checkApprovals →
 * approve → simulate → send) on the live USDai community market.
 *
 * Run from app/ (requires foundry's `anvil` on PATH):
 *   node --experimental-strip-types scripts/m2-flow-test.mjs
 *
 * Env:
 *   ARB_RPC_URL — optional fork-source RPC override (tried first).
 *   ANVIL_PORT  — fork port, default 8547.
 *
 * Funding strategy (documented per plan): deterministic anvil_setStorageAt
 * balance-slot injection on the tokenIn contract. The probe tries the OZ v5
 * ERC-7201 namespaced ERC20 base slot first (USDai uses it — verified), then
 * plain Solidity slots 0..40, then the Vyper ordering, verifying via
 * balanceOf and reverting misses. NOTE: do NOT fund by impersonating the SY
 * and transferring its token holdings out — this SY is a 1:1 wrapper whose
 * totalSupply must equal its USDai balance, and draining it makes every
 * subsequent deposit revert 'SY: insufficient shares' (found the hard way).
 *
 * Prints a per-step PASS/FAIL table; exits 1 on any failure.
 * (No npm script here by design — the orchestrator wires it.)
 */

import { spawn } from 'node:child_process'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeErrorResult,
  formatUnits,
  http,
  keccak256,
  pad,
  toFunctionSelector,
  toHex,
} from 'viem'
import { arbitrum } from 'viem/chains'
import { loadMarketSnapshot } from '../src/lib/market.ts'
import {
  planClaim,
  planMintPyFromSy,
  planMintPyFromToken,
  planRedeemPyToSy,
  planRedeemPyToToken,
  planUnwrap,
  planWrap,
  quoteMintPyFromSy,
  quoteRedeemPyToSy,
  quoteUnwrap,
  quoteWrap,
} from '../src/lib/actions.ts'
import {
  buildApproveCall,
  checkApprovals,
  decodeRevertData,
  simulateAction,
} from '../src/lib/txflow.ts'
import { loadPositions } from '../src/lib/positions.ts'
import { erc20Abi, pendleErrorsAbi } from '../src/lib/pendleAbi.ts'

// --- Config ------------------------------------------------------------------

const PORT = Number(process.env.ANVIL_PORT ?? 8547)
const FORK_URLS = [
  process.env.ARB_RPC_URL,
  'https://arb1.arbitrum.io/rpc',
  'https://arbitrum-one-rpc.publicnode.com',
].filter(Boolean)

/** Live USDai community market (active, expiry 2027). */
const MARKET = '0x46f545683d8494ef4c54b7ea40ca762c620846ef'
/** Expired market for the YCExpired negative path. */
const EXPIRED_MARKET = '0xd89a6f5b5be3ed4379cb4b8b76ed51551d3c4dba'
/** Bedrock uniETH starter market — native-ETH wrap probe (SKIP if its SY takes no ETH). */
const UNIETH_MARKET = '0x089bb526a424FB18B17e18E62997F4fa40f98543'
/** anvil default account[0] — pre-funded; auto-impersonate covers the rest. */
const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const ZERO = '0x0000000000000000000000000000000000000000'

const RPC = `http://127.0.0.1:${PORT}`

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
      // Sanity read through the fork (also warms the remote connection).
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
  // Estimate + 50% headroom: claims accrue fresh interest-index writes at the
  // next block timestamp, so the raw node estimate can under-shoot (observed
  // OOG at 98% of limit on redeemDueInterestAndRewards). Wallets add similar
  // buffers in production.
  const estimate = await pub.estimateContractGas(base)
  const hash = await wallet.writeContract({
    ...base,
    gas: (estimate * 15n) / 10n,
    chain: arbitrum,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    const tx = await pub.getTransaction({ hash }).catch(() => undefined)
    throw new Error(
      `tx ${call.functionName} reverted on-chain (${hash}; gasUsed ${receipt.gasUsed}/${tx?.gas ?? '?'})`,
    )
  }
  return receipt
}

const bal = (token, owner) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function approxEq(a, b, bps = 10n) {
  const d = a > b ? a - b : b - a
  const tol = ((a > b ? a : b) * bps) / 10_000n
  return d <= (tol > 0n ? tol : 1n)
}

function fmtDelta(actual, expected, decimals) {
  const d = actual > expected ? actual - expected : expected - actual
  const rel = expected === 0n ? 0 : Number((d * 1_000_000n) / expected) / 10_000
  return `actual ${formatUnits(actual, decimals)} vs quote ${formatUnits(expected, decimals)} (Δ ${rel}%)`
}

/** Send exact-amount approvals until a plan's approval set is fully met. */
async function settleApprovals(plan, expectedCount) {
  let unmet = await checkApprovals(pub, USER, plan.approvals)
  if (expectedCount !== undefined) {
    assert(
      unmet.length === expectedCount,
      `expected ${expectedCount} unmet approval(s), got ${unmet.length}`,
    )
  }
  let rounds = 0
  while (unmet.length > 0) {
    await sendPlanned(buildApproveCall(unmet[0], false), USER)
    const next = await checkApprovals(pub, USER, plan.approvals)
    assert(next.length < unmet.length, 'approve tx did not reduce the unmet approval set')
    unmet = next
    assert(++rounds <= 5, 'approval loop stuck')
  }
}

/** OZ v5 ERC-7201 namespaced ERC20 storage base ("openzeppelin.storage.ERC20"); balances mapping lives at base+0. */
const OZ_V5_ERC20_BASE =
  '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'

/**
 * Deterministic funding: probe candidate balance-mapping slots (OZ v5
 * namespaced base first, then Solidity slots 0..40, then Vyper ordering),
 * inject via anvil_setStorageAt, verify via balanceOf, revert misses.
 */
async function fundToken(token, holder, amount) {
  const candidates = [
    { key: mappingKey(holder, OZ_V5_ERC20_BASE), label: 'OZ-v5 ERC-7201 base' },
  ]
  for (let slot = 0n; slot < 40n; slot++) {
    candidates.push({
      key: mappingKey(holder, pad(toHex(slot), { size: 32 })),
      label: `solidity slot ${slot}`,
    })
    candidates.push({
      key: keccak256(
        encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [slot, holder]),
      ),
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
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [holder, baseSlot32]),
  )
}

// --- Step runner -----------------------------------------------------------------

const results = []
async function step(name, fn) {
  try {
    const note = await fn()
    results.push({ name, ok: true, note: note ?? '' })
    console.log(`  PASS  ${name}${note ? ` — ${note}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, note: err.message?.slice(0, 200) ?? String(err) })
    console.log(`  FAIL  ${name} — ${err.message}`)
  }
}

// --- Main --------------------------------------------------------------------------

await startAnvil()
console.log('anvil ready.\n')

await rpc('anvil_setBalance', [USER, toHex(1000n * 10n ** 18n)])

console.log(`Loading market snapshot ${MARKET} through the fork …`)
const snapshot = await loadMarketSnapshot(pub, MARKET)
const sy = snapshot.sy
assert(!snapshot.isExpired, 'target market unexpectedly expired — pick a live market')

// tokenIn: prefer the SY accounting asset (USDai) when it's an accepted tokenIn.
const tokenIn =
  sy.tokensIn.find((t) => t.toLowerCase() === sy.assetAddress.toLowerCase()) ??
  sy.tokensIn.find((t) => t !== '0x0000000000000000000000000000000000000000')
assert(tokenIn, 'SY exposes no ERC-20 tokensIn')
const [tokenInSymbol, tokenInDecimals] = await Promise.all([
  pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'symbol' }),
  pub
    .readContract({ address: tokenIn, abi: erc20Abi, functionName: 'decimals' })
    .then(Number),
])
console.log(
  `Market: ${snapshot.displayName} | SY ${sy.symbol} | tokenIn ${tokenInSymbol} (${tokenInDecimals}d)\n`,
)

const UNIT = 10n ** BigInt(tokenInDecimals)
const fundNote = await fundToken(tokenIn, USER, 1000n * UNIT)
console.log(`Funded 1000 ${tokenInSymbol} via ${fundNote}.\n`)

let syFromWrap = 0n

await step('1. wrap: quote → plan → approve → simulate → send', async () => {
  const amountIn = 100n * UNIT
  const quote = await quoteWrap(pub, sy, tokenIn, amountIn)
  assert(quote > 0n, 'previewDeposit returned 0')
  const plan = planWrap(sy, tokenIn, tokenInSymbol, tokenInDecimals, amountIn, (quote * 99n) / 100n, USER)
  await settleApprovals(plan, 1)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  assert(approxEq(sim.primaryOut, quote), `simulated out != quote: ${fmtDelta(sim.primaryOut, quote, sy.decimals)}`)
  const before = await bal(sy.address, USER)
  await sendPlanned(plan.call, USER)
  const after = await bal(sy.address, USER)
  syFromWrap = after - before
  assert(approxEq(syFromWrap, sim.primaryOut), `SY delta != simulated out: ${fmtDelta(syFromWrap, sim.primaryOut, sy.decimals)}`)
  return fmtDelta(syFromWrap, quote, sy.decimals)
})

await step('2. mintPyFromSy: quote → plan → approve → simulate → send', async () => {
  const amountSy = syFromWrap / 2n
  assert(amountSy > 0n, 'no SY to mint from (step 1 failed?)')
  const quote = await quoteMintPyFromSy(pub, snapshot, amountSy)
  const plan = planMintPyFromSy(snapshot, amountSy, (quote * 99n) / 100n, USER)
  await settleApprovals(plan, 1)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  assert(approxEq(sim.primaryOut, quote, 50n), `netPyOut vs quote: ${fmtDelta(sim.primaryOut, quote, sy.decimals)}`)
  const [ptBefore, ytBefore] = await Promise.all([bal(snapshot.pt, USER), bal(snapshot.yt, USER)])
  await sendPlanned(plan.call, USER)
  const [ptAfter, ytAfter] = await Promise.all([bal(snapshot.pt, USER), bal(snapshot.yt, USER)])
  const ptDelta = ptAfter - ptBefore
  const ytDelta = ytAfter - ytBefore
  assert(ptDelta === ytDelta, `PT delta ${ptDelta} != YT delta ${ytDelta}`)
  assert(approxEq(ptDelta, quote, 50n), `PT delta vs quote: ${fmtDelta(ptDelta, quote, sy.decimals)}`)
  return fmtDelta(ptDelta, quote, sy.decimals)
})

await step('3. loadPositions matches chain state, no degraded probes', async () => {
  const pos = await loadPositions(pub, snapshot, USER)
  const [ptBal, ytBal, syBal, lpBal, tokBal] = await Promise.all([
    bal(snapshot.pt, USER),
    bal(snapshot.yt, USER),
    bal(sy.address, USER),
    bal(snapshot.address, USER),
    bal(tokenIn, USER),
  ])
  assert(pos.pt === ptBal, `positions.pt ${pos.pt} != balanceOf ${ptBal}`)
  assert(pos.yt === ytBal, `positions.yt ${pos.yt} != balanceOf ${ytBal}`)
  assert(pos.sy === syBal, `positions.sy ${pos.sy} != balanceOf ${syBal}`)
  assert(pos.lp === lpBal, `positions.lp ${pos.lp} != balanceOf ${lpBal}`)
  const wt = pos.walletTokens.find((t) => t.token.toLowerCase() === tokenIn.toLowerCase())
  assert(wt && wt.amount === tokBal, `walletTokens ${tokenIn} mismatch`)
  assert(wt.symbol === tokenInSymbol, `walletTokens symbol ${wt.symbol} != ${tokenInSymbol}`)
  assert(
    pos.degraded.length === 0,
    `degraded probes: ${pos.degraded.join('; ')}`,
  )
  return `pt=yt=${formatUnits(ptBal, sy.decimals)}, sy=${formatUnits(syBal, sy.decimals)}, claimInterestSy=${formatUnits(pos.ytClaimableInterestSy, sy.decimals)}`
})

await step('4. planClaim: simulate + send (0-value claim must not revert)', async () => {
  const plan = planClaim(USER, snapshot)
  assert(plan.approvals.length === 0, 'claim should need no approvals')
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `claim simulation failed: ${sim.ok ? '' : sim.reason}`)
  await sendPlanned(plan.call, USER)
})

let remainingPy = 0n

await step('5. redeemPyToSy (half the PY): quote → approvals(PT+YT) → send', async () => {
  const ptBal = await bal(snapshot.pt, USER)
  const amountPy = ptBal / 2n
  remainingPy = ptBal - amountPy
  assert(amountPy > 0n, 'no PY to redeem (step 2 failed?)')
  const quote = await quoteRedeemPyToSy(pub, snapshot, amountPy)
  const plan = planRedeemPyToSy(snapshot, amountPy, (quote * 99n) / 100n, USER)
  assert(plan.approvals.length === 2, `pre-expiry redeem should need PT+YT approvals, got ${plan.approvals.length}`)
  await settleApprovals(plan, 2)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const before = await bal(sy.address, USER)
  await sendPlanned(plan.call, USER)
  const delta = (await bal(sy.address, USER)) - before
  assert(approxEq(delta, quote, 50n), `SY delta vs quote: ${fmtDelta(delta, quote, sy.decimals)}`)
  return fmtDelta(delta, quote, sy.decimals)
})

await step('6. unwrap remaining SY back to tokenIn', async () => {
  const syBal = await bal(sy.address, USER)
  assert(syBal > 0n, 'no SY left to unwrap')
  const quote = await quoteUnwrap(pub, sy, tokenIn, syBal)
  const plan = planUnwrap(sy, tokenIn, tokenInSymbol, tokenInDecimals, syBal, (quote * 99n) / 100n, USER)
  assert(plan.approvals.length === 0, 'unwrap should need no approvals')
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const before = await bal(tokenIn, USER)
  await sendPlanned(plan.call, USER)
  const delta = (await bal(tokenIn, USER)) - before
  assert(approxEq(delta, quote, 10n), `token delta vs quote: ${fmtDelta(delta, quote, tokenInDecimals)}`)
  return fmtDelta(delta, quote, tokenInDecimals)
})

// --- TokenInput/TokenOutput router encodings (the panels' token variants) ----
// Zap token: PYUSD (a non-asset tokensIn entry of the USDai SY) — falls back
// to any other ERC-20 tokensIn if PYUSD is ever delisted, noting the switch.
let zapToken, zapSymbol, zapDecimals, zapUnit
let zapMintedPy = 0n

await step('7. mintPyFromToken (PYUSD): fund → chained quote → approve → send', async () => {
  const zapCandidates = sy.tokensIn.filter(
    (t) => t.toLowerCase() !== ZERO && t.toLowerCase() !== tokenIn.toLowerCase(),
  )
  assert(zapCandidates.length > 0, 'SY exposes no second ERC-20 tokenIn for the zap test')
  const symbols = await Promise.all(
    zapCandidates.map((t) =>
      pub.readContract({ address: t, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
    ),
  )
  const pyusdIdx = symbols.findIndex((s) => s.toUpperCase() === 'PYUSD')
  const idx = pyusdIdx >= 0 ? pyusdIdx : 0
  zapToken = zapCandidates[idx]
  zapSymbol = symbols[idx]
  zapDecimals = Number(
    await pub.readContract({ address: zapToken, abi: erc20Abi, functionName: 'decimals' }),
  )
  zapUnit = 10n ** BigInt(zapDecimals)
  const fundVia = await fundToken(zapToken, USER, 1000n * zapUnit)

  const amountIn = 50n * zapUnit
  // Chained indicative quote, exactly like MintRedeemPanel's token variant:
  // previewDeposit(token→SY), then SY→PY at the current index.
  const syOut = await quoteWrap(pub, sy, zapToken, amountIn)
  const quote = await quoteMintPyFromSy(pub, snapshot, syOut)
  assert(quote > 0n, 'chained quote returned 0')
  const plan = planMintPyFromToken(
    snapshot, zapToken, zapSymbol, zapDecimals, amountIn, (quote * 99n) / 100n, USER,
  )
  assert(plan.approvals.length === 1, `token mint should need 1 approval, got ${plan.approvals.length}`)
  await settleApprovals(plan, 1)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  assert(approxEq(sim.primaryOut, quote, 50n), `netPyOut vs chained quote: ${fmtDelta(sim.primaryOut, quote, sy.decimals)}`)
  const [ptBefore, ytBefore] = await Promise.all([bal(snapshot.pt, USER), bal(snapshot.yt, USER)])
  await sendPlanned(plan.call, USER)
  const [ptAfter, ytAfter] = await Promise.all([bal(snapshot.pt, USER), bal(snapshot.yt, USER)])
  const ptDelta = ptAfter - ptBefore
  const ytDelta = ytAfter - ytBefore
  assert(ptDelta === ytDelta, `PT delta ${ptDelta} != YT delta ${ytDelta}`)
  assert(approxEq(ptDelta, quote, 50n), `PT delta vs chained quote: ${fmtDelta(ptDelta, quote, sy.decimals)}`)
  zapMintedPy = ptDelta
  return `${zapSymbol} in via ${fundVia}; ${fmtDelta(ptDelta, quote, sy.decimals)}`
})

await step('8. redeemPyToToken (back to PYUSD): chained quote → approvals → send', async () => {
  assert(zapMintedPy > 0n, 'no PY from the token mint (step 7 failed?)')
  const amountPy = zapMintedPy
  // Chained quote: PY→SY at the index, then previewRedeem(SY→token).
  const syOut = await quoteRedeemPyToSy(pub, snapshot, amountPy)
  const quote = await quoteUnwrap(pub, sy, zapToken, syOut)
  assert(quote > 0n, 'chained redeem quote returned 0')
  const plan = planRedeemPyToToken(
    snapshot, zapToken, zapSymbol, zapDecimals, amountPy, (quote * 99n) / 100n, USER,
  )
  assert(plan.approvals.length === 2, `pre-expiry token redeem should need PT+YT approvals, got ${plan.approvals.length}`)
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const before = await bal(zapToken, USER)
  await sendPlanned(plan.call, USER)
  const delta = (await bal(zapToken, USER)) - before
  assert(approxEq(delta, quote, 50n), `${zapSymbol} delta vs chained quote: ${fmtDelta(delta, quote, zapDecimals)}`)
  return fmtDelta(delta, quote, zapDecimals)
})

await step('9. native-ETH wrap on the uniETH starter market (or SKIP)', async () => {
  const uniSnap = await loadMarketSnapshot(pub, UNIETH_MARKET)
  const hasNativeIn = uniSnap.sy.tokensIn.some((t) => t.toLowerCase() === ZERO)
  if (!hasNativeIn) {
    return `SKIP — SY ${uniSnap.sy.symbol} getTokensIn() does not include address(0)`
  }
  const amountIn = 10n ** 18n // 1 ETH (USER holds 1000 from anvil_setBalance)
  const quote = await quoteWrap(pub, uniSnap.sy, ZERO, amountIn)
  assert(quote > 0n, 'previewDeposit(native) returned 0')
  const plan = planWrap(uniSnap.sy, ZERO, 'ETH', 18, amountIn, (quote * 99n) / 100n, USER)
  assert(plan.approvals.length === 0, 'native wrap must need no approvals')
  assert(plan.call.value === amountIn, 'native amount must ride in call.value')
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const before = await bal(uniSnap.sy.address, USER)
  await sendPlanned(plan.call, USER)
  const delta = (await bal(uniSnap.sy.address, USER)) - before
  assert(approxEq(delta, quote, 10n), `SY delta vs quote: ${fmtDelta(delta, quote, uniSnap.sy.decimals)}`)
  return fmtDelta(delta, quote, uniSnap.sy.decimals)
})

await step('10a. negative: redeem with minSyOut = 2× quote decodes as slippage', async () => {
  assert(remainingPy > 0n, 'no PY left for the negative test')
  const quote = await quoteRedeemPyToSy(pub, snapshot, remainingPy)
  const plan = planRedeemPyToSy(snapshot, remainingPy, quote * 2n, USER)
  // Approvals must be in place so the revert we hit is the min-out check,
  // not an allowance failure (exact-amount approvals were consumed in 5).
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(!sim.ok, 'simulation unexpectedly succeeded with 2× min-out')
  assert(
    /slippage|below your minimum/i.test(sim.reason),
    `expected a slippage-ish decoded message, got: ${sim.reason}`,
  )
  return sim.reason.slice(0, 90)
})

await step('10b. negative: mint on EXPIRED market decodes as expired', async () => {
  const expiredSnap = await loadMarketSnapshot(pub, EXPIRED_MARKET)
  assert(expiredSnap.isExpired, 'expired-market fixture is not expired?')
  // 0-amount mint: the ERC20 pull is a no-op, so the revert comes from
  // YT.mintPY's notExpired modifier (YCExpired 0x5b15a6da — live-verified).
  const plan = planMintPyFromSy(expiredSnap, 0n, 0n, USER)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(!sim.ok, 'mint simulation unexpectedly succeeded on an expired market')
  assert(/expired/i.test(sim.reason), `expected an 'expired' message, got: ${sim.reason}`)
  return sim.reason.slice(0, 90)
})

await step('11. error decoder spot checks (selectors + revert decoding)', async () => {
  const expected = {
    'MarketExpired()': '0xb2094b59',
    'MarketFactoryMarketExists()': '0x4a588866',
    'MarketFactoryInvalidPt()': '0x781eae2d',
    'YCFactoryYieldContractExisted()': '0xa50d9502',
    'YCFactoryInvalidExpiry()': '0x1f687fd0',
    'YCExpired()': '0x5b15a6da',
  }
  for (const [sig, sel] of Object.entries(expected)) {
    const got = toFunctionSelector(sig)
    assert(got === sel, `selector mismatch for ${sig}: ${got} != ${sel}`)
    const name = sig.slice(0, sig.indexOf('('))
    const inAbi = pendleErrorsAbi.some((e) => e.name === name)
    assert(inAbi, `${name} missing from pendleErrorsAbi`)
  }
  assert(/market has expired/i.test(decodeRevertData('0xb2094b59')), 'MarketExpired decode')
  assert(/expired/i.test(decodeRevertData('0x5b15a6da')), 'YCExpired decode')
  const slippageData = encodeErrorResult({
    abi: pendleErrorsAbi,
    errorName: 'RouterInsufficientSyOut',
    args: [99n, 100n],
  })
  assert(/^Slippage:/.test(decodeRevertData(slippageData)), 'RouterInsufficientSyOut decode')
  // M3 (txflow friendlyStringRevert): the approx-failure string family is now
  // rewritten to the friendly 'trade too large' message instead of passing
  // through raw; neutral Error(string) reverts still pass through verbatim.
  const stringRevert = (msg) =>
    '0x08c379a0' + encodeAbiParameters([{ type: 'string' }], [msg]).slice(2)
  assert(
    /trade too large/i.test(decodeRevertData(stringRevert('Slippage: search range overflow'))),
    'approx-failure Error(string) must map to the trade-too-large message',
  )
  assert(
    decodeRevertData(stringRevert('SY: insufficient shares')) === 'SY: insufficient shares',
    'neutral Error(string) pass-through',
  )
  assert(decodeRevertData('0xdeadbeef') === undefined, 'unknown selector must return undefined')
  return '6 selectors verified, 5 decode paths checked'
})

// --- Report --------------------------------------------------------------------

console.log('\n===== M2 flow test results =====')
const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.note}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)

killAnvil()
process.exit(failed.length > 0 ? 1 : 0)
