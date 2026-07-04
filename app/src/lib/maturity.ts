/**
 * M5 matured-market flows — pure, framework-free (erasable TS).
 *
 * SKELETON: signatures are the shared contract (UI codes against them; the
 * data-layer work fills the bodies). Rules:
 * - Post-expiry PT redemption needs NO YT (the router burns no YT after
 *   expiry — actions.ts planRedeemPyToSy/ToToken already skip the YT
 *   approval; the matured UI reuses those builders + quoteRedeemPyToSy).
 * - One-click LP exit: exitPostExpToSy(receiver, market, netPtIn, netLpIn,
 *   minSyOut) / exitPostExpToToken(receiver, market, netPtIn, netLpIn,
 *   TokenOutput) — burns LP pro-rata and redeems the PT leg at pyIndex.
 *   NO ApproxParams, NO LimitOrderData (no swap happens post-expiry).
 *   Approvals: LP (= market address) → router; PT → router only when
 *   ptIncluded > 0.
 * - Previews are EXACT math (no swap): LP burn pro-rata from readState +
 *   PT redemption at pyIndex = max(SY.exchangeRate, YT.pyIndexStored).
 * - Depeg guard: pyIndex is non-decreasing; when the live SY exchangeRate
 *   drops below pyIndexStored, redemption output (in real asset terms) is
 *   impaired — surface, never hide.
 * - Legacy graceful failure: when a redemption/exit SIMULATION reverts on a
 *   legacy vintage, the UI shows the honest can't-redeem notice (rescue
 *   paths are §7 non-goals). The lib just decodes; no special-casing here.
 *
 * IMPLEMENTATION NOTES (source-verified against the scratchpad
 * ActionMiscV3.sol, 2026-07-04; fork gate: scripts/m5-maturity-test.mjs):
 * - The facet's _exitPostExpToSy pulls LP from msg.sender to the market and
 *   burns it with the PT leg going STRAIGHT to the YT, pulls any loose
 *   netPtIn to the YT, then runs one YT.redeemPY for the sum — so the exact
 *   preview is previewDualRemove's pro-rata split (reused, not duplicated)
 *   plus (ptFromLpBurn + ptIncluded)·1e18/pyIndex, floor at each step, and
 *   totalSyOut = netSyFromRemove + netSyFromRedeem matches to the wei on a
 *   same-state simulation.
 * - No swap anywhere ⇒ no slippage semantics beyond the min-out the CALLER
 *   applies to preview.totalSyOut. Only index/reserve drift between preview
 *   and execution matters, so a tiny margin (~0.1%) is the recommendation.
 * - pyIndex comes from actions.ts' readPyIndex (exported for M5) — one
 *   multicall of SY.exchangeRate + YT.pyIndexStored, max()-combined exactly
 *   like YT.pyIndexCurrent computes on-chain.
 * - exitPostExpToSy returns ONLY the ExitPostExpReturnParams struct (no
 *   leading totalSyOut word — see routerExitAbi notes), so simulateAction
 *   reports primaryOut = undefined for it; the exact preview IS the binding
 *   display number. The ToToken variant returns totalTokenOut first.
 */

import { formatUnits } from 'viem'
import type { Address, PublicClient } from 'viem'
import type {
  ActionPlan,
  ApprovalNeed,
  DepegInfo,
  ExitPostExpPreview,
  MarketSnapshot,
} from './types.ts'
import { MULTICALL3, ROUTER_V4 } from './addresses.ts'
import { readPyIndex } from './actions.ts'
import { previewDualRemove } from './liquidity.ts'
import { routerExitAbi, syReadAbi, ytIndexAbi } from './pendleAbi.ts'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'
const ONE_E18 = 10n ** 18n
/** LP tokens are always 18 decimals (M2 decimals rule). */
const LP_DECIMALS = 18

/** SwapType.NONE plumbing — same shape actions.ts/liquidity.ts use everywhere. */
const EMPTY_SWAP_DATA = {
  swapType: 0,
  extRouter: ZERO_ADDRESS,
  extCalldata: '0x',
  needScale: false,
} as const

/** Compact human amount for describe strings (actions.ts convention). */
function fmt(amount: bigint, decimals: number): string {
  const s = formatUnits(amount, decimals)
  const [int, frac = ''] = s.split('.')
  const trimmed = frac.slice(0, 6).replace(/0+$/, '')
  return trimmed ? `${int}.${trimmed}` : int
}

function approval(
  token: Address,
  spender: Address,
  amount: bigint,
  symbol: string,
  decimals: number,
): ApprovalNeed {
  return { token, spender, amount, symbol, decimals }
}

/**
 * Header rule: LP (= the market address itself) → router always; PT → router
 * only when the user folds loose PT into the exit. (A 0-amount LP approval is
 * vacuously met, so listing it unconditionally costs nothing on PT-only exits.)
 */
function exitApprovals(
  snapshot: MarketSnapshot,
  lpIn: bigint,
  ptIncluded: bigint,
): ApprovalNeed[] {
  const approvals: ApprovalNeed[] = [
    approval(snapshot.address, ROUTER_V4, lpIn, 'LP', LP_DECIMALS),
  ]
  if (ptIncluded > 0n) {
    approvals.push(
      approval(snapshot.pt, ROUTER_V4, ptIncluded, snapshot.ptSymbol, snapshot.sy.assetDecimals),
    )
  }
  return approvals
}

/** "Exit 12.5 LP + 3 PT-… → …" describe fragment shared by both plan builders. */
function exitDescribe(snapshot: MarketSnapshot, lpIn: bigint, ptIncluded: bigint, outSymbol: string): string {
  const ptPart =
    ptIncluded > 0n ? ` + ${fmt(ptIncluded, snapshot.sy.assetDecimals)} ${snapshot.ptSymbol}` : ''
  return `Exit ${fmt(lpIn, LP_DECIMALS)} LP${ptPart} → ${outSymbol}`
}

/** Exact post-expiry exit preview (one pyIndex read; the rest is pure math). */
export async function previewExitPostExp(
  client: PublicClient,
  snapshot: MarketSnapshot,
  lpIn: bigint,
  ptIncluded: bigint,
): Promise<ExitPostExpPreview> {
  // LP leg: pro-rata burn — the exact math the market's removeLiquidityCore
  // runs (floor lp·totalSy/totalLp, floor lp·totalPt/totalLp), reused from
  // liquidity.ts rather than duplicated.
  const { syOut: syFromLpBurn, ptOut: ptFromLpBurn } = previewDualRemove(snapshot, lpIn)
  // PT leg: every PT (from the burn + loose ptIncluded) redeems in ONE
  // YT.redeemPY at pyIndex = max(SY.exchangeRate, YT.pyIndexStored) — one
  // multicall via actions.ts' readPyIndex (exported for M5 reuse).
  const pyIndex = await readPyIndex(client, snapshot)
  const syFromPtRedeem = ((ptFromLpBurn + ptIncluded) * ONE_E18) / pyIndex
  return {
    syFromLpBurn,
    ptFromLpBurn,
    ptIncluded,
    syFromPtRedeem,
    totalSyOut: syFromLpBurn + syFromPtRedeem,
    pyIndex,
  }
}

/** Read the depeg guard values (SY.exchangeRate vs YT.pyIndexStored). */
export async function readDepegInfo(
  client: PublicClient,
  snapshot: MarketSnapshot,
): Promise<DepegInfo> {
  const [rateR, storedR] = await client.multicall({
    contracts: [
      { address: snapshot.sy.address, abi: syReadAbi, functionName: 'exchangeRate' },
      { address: snapshot.yt, abi: ytIndexAbi, functionName: 'pyIndexStored' },
    ],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })
  // Depeg is only a real comparison when BOTH legs read. A missing
  // exchangeRate (legacy SCY-era SYs may lack it) or a dropped multicall leg
  // makes the status UNKNOWN — NOT depegged. Reporting depegged=true on an
  // unreadable/transient partial multicall was a false alarm that fired even
  // on healthy active markets, so we surface `rateKnown: false` instead and
  // let the UI stay silent. (Doctrine is surface-never-hide for KNOWN
  // impairment; an unknown must not masquerade as a known impairment.)
  const rateKnown = rateR.status === 'success' && storedR.status === 'success'
  const syExchangeRate = rateR.status === 'success' ? rateR.result : 0n
  const pyIndexStored = storedR.status === 'success' ? storedR.result : 0n
  return {
    syExchangeRate,
    pyIndexStored,
    depegged: rateKnown && syExchangeRate < pyIndexStored,
    rateKnown,
  }
}

/** exitPostExpToSy — approvals: LP → router (+ PT → router when ptIncluded > 0). */
export function planExitPostExpToSy(
  snapshot: MarketSnapshot,
  lpIn: bigint,
  ptIncluded: bigint,
  minSyOut: bigint,
  receiver: Address,
): ActionPlan {
  return {
    describe: exitDescribe(snapshot, lpIn, ptIncluded, snapshot.sy.symbol),
    approvals: exitApprovals(snapshot, lpIn, ptIncluded),
    call: {
      address: ROUTER_V4,
      abi: routerExitAbi,
      functionName: 'exitPostExpToSy',
      // Argument order is (receiver, market, netPtIn, netLpIn, minSyOut) —
      // PT before LP, per the verified IPActionMiscV3 signature.
      args: [receiver, snapshot.address, ptIncluded, lpIn, minSyOut],
    },
  }
}

/** exitPostExpToToken — tokenOut must be in SY.tokensOut; TokenOutput SwapType.NONE. */
export function planExitPostExpToToken(
  snapshot: MarketSnapshot,
  tokenOut: Address,
  tokenOutSymbol: string,
  tokenOutDecimals: number,
  lpIn: bigint,
  ptIncluded: bigint,
  minTokenOut: bigint,
  receiver: Address,
): ActionPlan {
  void tokenOutDecimals
  const output = {
    tokenOut,
    minTokenOut,
    tokenRedeemSy: tokenOut,
    pendleSwap: ZERO_ADDRESS,
    swapData: EMPTY_SWAP_DATA,
  }
  return {
    describe: exitDescribe(snapshot, lpIn, ptIncluded, tokenOutSymbol),
    approvals: exitApprovals(snapshot, lpIn, ptIncluded),
    call: {
      address: ROUTER_V4,
      abi: routerExitAbi,
      functionName: 'exitPostExpToToken',
      args: [receiver, snapshot.address, ptIncluded, lpIn, output],
    },
  }
}
