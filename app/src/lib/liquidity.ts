/**
 * M4 liquidity quoter + plan builders — pure, framework-free (erasable TS).
 *
 * SKELETON: signatures are the shared contract (UI codes against them; the
 * data-layer work fills the bodies). Rules:
 * - Dual add/remove is pro-rata (no swap, no price impact): previews are pure
 *   ratio math over readState (ptDesired/totalPt = syDesired/totalSy;
 *   lpOut ≈ totalLp × syDesired/totalSy; dual remove pays lp/totalLp of both
 *   sides). Token pay-side wraps via SY.previewDeposit first.
 * - Single-sided zaps swap internally → RouterStatic statics quote them
 *   (probe which liquidity statics exist on the deployed diamond; label
 *   honestly if a KeepYt static is missing). ApproxParams for zap-in follow
 *   the M3 rule: slippage-scaled guessMin, +5% guessMax, guessOffchain from
 *   the static's internal PT-swap amount when the static exposes it,
 *   otherwise createDefaultApproxParams. KeepYt variants take NO ApproxParams.
 * - Approvals: adds → pay tokens to ROUTER_V4 (dual: SY-or-token AND PT);
 *   removes → the LP token (= the market address) to ROUTER_V4. Native ETH
 *   pay side → value on the call, no approval.
 * - min-outs are caller-computed (quote × (1 − effectiveSlippage)); dual-add
 *   minLpOut from lpOutEstimate the same way.
 * - Always empty LimitOrderData on the variants that take it.
 * - Zap scope v1.0 (user-approved 2026-07-04): SY-accepted tokens only,
 *   SwapType.NONE. Aggregator zaps are v1.5.
 *
 * IMPLEMENTATION NOTES (live-verified 2026-07-04, see pendleAbi.ts):
 * - ALL 12 RouterStatic liquidity statics exist on the deployed diamond,
 *   INCLUDING both KeepYt statics — so KeepYt quotes come from the real
 *   static, no computed fallback needed. KeepYt does no AMM swap (the facet
 *   mints PY from part of the SY and dual-adds), hence its static exposes no
 *   priceImpact/netSyFee: the quote honestly reports priceImpact 0 /
 *   netSyFee 0n / approx null / impliedApyAfter undefined (rate unchanged).
 * - Zap-in ApproxParams are synthesized from the static's netPtFromSwap
 *   (guessPtReceivedFromSy — the INTERNAL PT swap amount, NOT the LP out),
 *   with the M3 recipe: guessMin = x×(1−max(slippage, 0.001)) floored,
 *   guessMax = x×105/100, guessOffchain = x, maxIteration 30, eps 1e14.
 * - Dual-add preview mirrors the market's own min() rule: the derived side is
 *   floored ratio math, lpOutEstimate = min(lp-by-sy, lp-by-pt) — matched the
 *   deployed addLiquidityDualSyAndPtStatic word-for-word in the live probe.
 *   EXCEPTION (fork-proven): the TOKEN pay side derives PT with CEILING
 *   division, because addLiquidityDualTokenAndPt reverts 'Slippage:
 *   NOT_ALL_SY_USED' unless the market consumes ALL the wrapped SY — see the
 *   comment in previewDualAdd.
 */

import { formatUnits } from 'viem'
import type { Address, PublicClient } from 'viem'
import type {
  ActionPlan,
  ApprovalNeed,
  ApproxParamsStruct,
  DualAddPreview,
  DualRemovePreview,
  MarketSnapshot,
  PlannedCall,
  SwapQuote,
} from './types.ts'
import { ROUTER_STATIC, ROUTER_V4 } from './addresses.ts'
import { routerLiquidityAbi, routerStaticLiquidityAbi, syActionsAbi } from './pendleAbi.ts'
import { createDefaultApproxParams } from './swaps.ts'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'
const SECONDS_PER_YEAR = 31_536_000
/** LP tokens are always 18 decimals (M2 decimals rule). */
const LP_DECIMALS = 18

/** SwapType.NONE plumbing — same shape actions.ts/swaps.ts use everywhere. */
const EMPTY_SWAP_DATA = {
  swapType: 0,
  extRouter: ZERO_ADDRESS,
  extCalldata: '0x',
  needScale: false,
} as const

/** Empty LimitOrderData — routes 100% through the AMM (F11). */
const EMPTY_LIMIT_ORDER_DATA = {
  limitRouter: ZERO_ADDRESS,
  epsSkipMarket: 0n,
  normalFills: [],
  flashFills: [],
  optData: '0x',
} as const

function isNative(token: Address): boolean {
  return token.toLowerCase() === ZERO_ADDRESS
}

function isSyToken(snapshot: MarketSnapshot, token: Address): boolean {
  return token.toLowerCase() === snapshot.sy.address.toLowerCase()
}

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

/** TokenInput with SwapType.NONE (v1 zap scope — SY-accepted tokens only). */
function tokenInput(tokenIn: Address, netTokenIn: bigint) {
  return {
    tokenIn,
    netTokenIn,
    tokenMintSy: tokenIn,
    pendleSwap: ZERO_ADDRESS,
    swapData: EMPTY_SWAP_DATA,
  }
}

/** TokenOutput with SwapType.NONE. */
function tokenOutput(tokenOut: Address, minTokenOut: bigint) {
  return {
    tokenOut,
    minTokenOut,
    tokenRedeemSy: tokenOut,
    pendleSwap: ZERO_ADDRESS,
    swapData: EMPTY_SWAP_DATA,
  }
}

/**
 * M3-recipe ApproxParams synthesis (mirrors swaps.ts' private helper — that
 * module is frozen, so the recipe is duplicated here verbatim). For zap-ins
 * the seed is the static's netPtFromSwap: the router's guessPtReceivedFromSy
 * searches over the INTERNAL PT-swap amount, not the LP out.
 */
function synthesizeApproxParams(
  netPtFromSwap: bigint,
  effectiveSlippage: number,
): ApproxParamsStruct | null {
  if (netPtFromSwap <= 0n) return null
  const slippageBps = BigInt(
    Math.min(10_000, Math.max(10, Math.round(Math.max(effectiveSlippage, 0.001) * 10_000))),
  )
  return {
    guessMin: (netPtFromSwap * (10_000n - slippageBps)) / 10_000n,
    guessMax: (netPtFromSwap * 105n) / 100n,
    guessOffchain: netPtFromSwap,
    maxIteration: 30n,
    eps: 10n ** 14n,
  }
}

/**
 * Post-trade implied APY from exchangeRateAfter — same live-verified frame
 * and guards as swaps.ts (see its header for the derivation).
 */
function impliedApyAfterFromExchangeRate(
  snapshot: MarketSnapshot,
  exchangeRateAfter: bigint,
): number | undefined {
  const t = snapshot.expiry - Math.floor(Date.now() / 1000)
  if (t <= 0) return undefined
  const rate = Number(exchangeRateAfter) / 1e18
  if (!Number.isFinite(rate) || rate < 1) return undefined
  const apy = Math.pow(rate, SECONDS_PER_YEAR / t) - 1
  if (!Number.isFinite(apy) || apy > 100) return undefined
  return apy
}

/** Floor mulDiv over bigints. */
function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) return 0n
  return (a * b) / d
}

/** Ceiling mulDiv over bigints. */
function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) return 0n
  return (a * b + d - 1n) / d
}

/**
 * Preview a dual-sided add. `fixed` names which side the user typed:
 * - 'pt': amount is PT (assetDecimals) → derive SY side
 * - 'sy': amount is SY (sy.decimals) → derive PT side
 * - 'token': amount is tokenIn raw units → previewDeposit → SY → derive PT
 */
export async function previewDualAdd(
  client: PublicClient,
  snapshot: MarketSnapshot,
  fixed: 'pt' | 'sy' | 'token',
  tokenIn: Address | undefined,
  amount: bigint,
): Promise<DualAddPreview> {
  const { totalPt, totalSy, totalLp } = snapshot.state
  if (totalPt <= 0n || totalSy <= 0n || totalLp <= 0n) {
    throw new Error('Pool has no liquidity to derive a dual-add ratio from.')
  }
  let syDesired: bigint
  let ptDesired: bigint
  if (fixed === 'pt') {
    ptDesired = amount
    syDesired = mulDiv(amount, totalSy, totalPt)
  } else {
    if (fixed === 'token') {
      if (tokenIn === undefined) {
        throw new Error('previewDualAdd: tokenIn is required when fixed = "token"')
      }
      // Token pay side wraps first — SY.previewDeposit is the exact view quote.
      syDesired = await client.readContract({
        address: snapshot.sy.address,
        abi: syActionsAbi,
        functionName: 'previewDeposit',
        args: [tokenIn, amount],
      })
      // TOKEN pay side: derive PT with CEILING division — deliberately
      // asymmetric with the 'sy' branch below. addLiquidityDualTokenAndPt
      // wraps the token and then REQUIRES the market to consume every wei of
      // the resulting SY (reverts 'Slippage: NOT_ALL_SY_USED'); a floored PT
      // side can make PT the binding side of the market's min() rule and
      // strand 1 wei of SY → deterministic revert. Ceiling the PT side
      // guarantees SY is the fully-consumed side (fork-proven); the router
      // pulls only netPtUsed from the wallet, so the extra PT wei is never
      // taken.
      ptDesired = mulDivUp(syDesired, totalPt, totalSy)
    } else {
      // SY pay side: FLOOR is correct here — addLiquidityDualSyAndPt has no
      // NOT_ALL_SY_USED check, so a floored PT side merely leaves wei-level
      // SY dust in the wallet instead of reverting.
      syDesired = amount
      ptDesired = mulDiv(syDesired, totalPt, totalSy)
    }
  }
  // The market mints min(lp-by-sy, lp-by-pt); with a floor-derived side the
  // two are equal-or-adjacent (ceiling-derived PT makes lp-by-sy the min),
  // and min() keeps the estimate ≤ actual usage.
  const lpBySy = mulDiv(syDesired, totalLp, totalSy)
  const lpByPt = mulDiv(ptDesired, totalLp, totalPt)
  const lpOutEstimate = lpBySy < lpByPt ? lpBySy : lpByPt
  const share = Number(lpOutEstimate) / Number(totalLp + lpOutEstimate)
  return {
    syDesired,
    ptDesired,
    lpOutEstimate,
    shareOfPoolAfter: Number.isFinite(share) ? share : 0,
  }
}

/** Pure pro-rata dual-remove preview (no RPC needed beyond the snapshot). */
export function previewDualRemove(
  snapshot: MarketSnapshot,
  lpIn: bigint,
): DualRemovePreview {
  const { totalPt, totalSy, totalLp } = snapshot.state
  if (totalLp <= 0n) {
    return { syOut: 0n, ptOut: 0n, shareBurned: 0 }
  }
  const share = Number(lpIn) / Number(totalLp)
  return {
    syOut: mulDiv(lpIn, totalSy, totalLp),
    ptOut: mulDiv(lpIn, totalPt, totalLp),
    shareBurned: Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0,
  }
}

/** Single-sided zap-in quote (token or SY → LP; keepYt → LP + YT). */
export async function quoteZapIn(
  client: PublicClient,
  snapshot: MarketSnapshot,
  tokenIn: Address,
  amountIn: bigint,
  keepYt: boolean,
  slippageFraction: number,
): Promise<SwapQuote> {
  const sy = isSyToken(snapshot, tokenIn)
  if (keepYt) {
    // KeepYt statics EXIST on the deployed diamond (live-probed) — no
    // degraded fallback needed. No AMM swap happens on this path, so the
    // quote honestly reports zero fee/impact and no post-trade rate shift.
    let netLpOut: bigint
    let netYtOut: bigint
    if (sy) {
      ;[netLpOut, netYtOut] = await client.readContract({
        address: ROUTER_STATIC,
        abi: routerStaticLiquidityAbi,
        functionName: 'addLiquiditySingleSyKeepYtStatic',
        args: [snapshot.address, amountIn],
      })
    } else {
      ;[netLpOut, netYtOut] = await client.readContract({
        address: ROUTER_STATIC,
        abi: routerStaticLiquidityAbi,
        functionName: 'addLiquiditySingleTokenKeepYtStatic',
        args: [snapshot.address, tokenIn, amountIn],
      })
    }
    return {
      amountOut: netLpOut,
      priceImpact: 0,
      netSyFee: 0n,
      approx: null, // KeepYt router variants take NO ApproxParams
      ytOut: netYtOut,
    }
  }
  if (sy) {
    const [netLpOut, netPtFromSwap, netSyFee, priceImpact, exchangeRateAfter] =
      await client.readContract({
        address: ROUTER_STATIC,
        abi: routerStaticLiquidityAbi,
        functionName: 'addLiquiditySingleSyStatic',
        args: [snapshot.address, amountIn],
      })
    return {
      amountOut: netLpOut,
      priceImpact: Number(priceImpact) / 1e18,
      impliedApyAfter: impliedApyAfterFromExchangeRate(snapshot, exchangeRateAfter),
      netSyFee,
      approx: synthesizeApproxParams(netPtFromSwap, slippageFraction),
    }
  }
  // Token variant — amountIn scaled at the TOKEN's own decimals (M3 gotcha).
  const [netLpOut, netPtFromSwap, netSyFee, priceImpact, exchangeRateAfter] =
    await client.readContract({
      address: ROUTER_STATIC,
      abi: routerStaticLiquidityAbi,
      functionName: 'addLiquiditySingleTokenStatic',
      args: [snapshot.address, tokenIn, amountIn],
    })
  return {
    amountOut: netLpOut,
    priceImpact: Number(priceImpact) / 1e18,
    impliedApyAfter: impliedApyAfterFromExchangeRate(snapshot, exchangeRateAfter),
    netSyFee,
    approx: synthesizeApproxParams(netPtFromSwap, slippageFraction),
  }
}

/** Single-sided zap-out quote (LP → token or SY). Removes take no ApproxParams. */
export async function quoteZapOut(
  client: PublicClient,
  snapshot: MarketSnapshot,
  tokenOut: Address,
  lpIn: bigint,
): Promise<SwapQuote> {
  if (isSyToken(snapshot, tokenOut)) {
    const [netSyOut, netSyFee, priceImpact, exchangeRateAfter] = await client.readContract({
      address: ROUTER_STATIC,
      abi: routerStaticLiquidityAbi,
      functionName: 'removeLiquiditySingleSyStatic',
      args: [snapshot.address, lpIn],
    })
    return {
      amountOut: netSyOut,
      priceImpact: Number(priceImpact) / 1e18,
      impliedApyAfter: impliedApyAfterFromExchangeRate(snapshot, exchangeRateAfter),
      netSyFee,
      approx: null,
    }
  }
  const [netTokenOut, netSyFee, priceImpact, exchangeRateAfter] = await client.readContract({
    address: ROUTER_STATIC,
    abi: routerStaticLiquidityAbi,
    functionName: 'removeLiquiditySingleTokenStatic',
    args: [snapshot.address, lpIn, tokenOut],
  })
  return {
    amountOut: netTokenOut,
    priceImpact: Number(priceImpact) / 1e18,
    impliedApyAfter: impliedApyAfterFromExchangeRate(snapshot, exchangeRateAfter),
    netSyFee,
    approx: null,
  }
}

/** Dual add — addLiquidityDualSyAndPt or addLiquidityDualTokenAndPt. */
export function planDualAdd(
  snapshot: MarketSnapshot,
  tokenIn: Address,
  tokenInSymbol: string,
  tokenInDecimals: number,
  amountTokenOrSy: bigint,
  ptDesired: bigint,
  minLpOut: bigint,
  receiver: Address,
): ActionPlan {
  const ptApproval = approval(
    snapshot.pt,
    ROUTER_V4,
    ptDesired,
    snapshot.ptSymbol,
    snapshot.sy.assetDecimals,
  )
  let call: PlannedCall
  let approvals: ApprovalNeed[]
  if (isSyToken(snapshot, tokenIn)) {
    call = {
      address: ROUTER_V4,
      abi: routerLiquidityAbi,
      functionName: 'addLiquidityDualSyAndPt',
      args: [receiver, snapshot.address, amountTokenOrSy, ptDesired, minLpOut],
    }
    approvals = [
      approval(tokenIn, ROUTER_V4, amountTokenOrSy, tokenInSymbol, tokenInDecimals),
      ptApproval,
    ]
  } else {
    const native = isNative(tokenIn)
    call = {
      address: ROUTER_V4,
      abi: routerLiquidityAbi,
      functionName: 'addLiquidityDualTokenAndPt',
      args: [
        receiver,
        snapshot.address,
        tokenInput(tokenIn, amountTokenOrSy),
        ptDesired,
        minLpOut,
      ],
      ...(native ? { value: amountTokenOrSy } : {}),
    }
    approvals = native
      ? [ptApproval]
      : [
          approval(tokenIn, ROUTER_V4, amountTokenOrSy, tokenInSymbol, tokenInDecimals),
          ptApproval,
        ]
  }
  return {
    describe: `Add ${fmt(amountTokenOrSy, tokenInDecimals)} ${tokenInSymbol} + ${fmt(ptDesired, snapshot.sy.assetDecimals)} ${snapshot.ptSymbol} liquidity`,
    approvals,
    call,
  }
}

/** Zap in — addLiquiditySingleToken/Sy (+KeepYt variants when keepYt). */
export function planZapIn(
  snapshot: MarketSnapshot,
  tokenIn: Address,
  tokenInSymbol: string,
  tokenInDecimals: number,
  amountIn: bigint,
  minLpOut: bigint,
  minYtOut: bigint | undefined,
  approx: SwapQuote['approx'],
  keepYt: boolean,
  receiver: Address,
): ActionPlan {
  const sy = isSyToken(snapshot, tokenIn)
  const native = isNative(tokenIn)
  let call: PlannedCall
  if (keepYt) {
    // KeepYt: NO ApproxParams, NO limit — a passed `approx` is ignored.
    if (sy) {
      call = {
        address: ROUTER_V4,
        abi: routerLiquidityAbi,
        functionName: 'addLiquiditySingleSyKeepYt',
        args: [receiver, snapshot.address, amountIn, minLpOut, minYtOut ?? 0n],
      }
    } else {
      call = {
        address: ROUTER_V4,
        abi: routerLiquidityAbi,
        functionName: 'addLiquiditySingleTokenKeepYt',
        args: [
          receiver,
          snapshot.address,
          minLpOut,
          minYtOut ?? 0n,
          tokenInput(tokenIn, amountIn),
        ],
        ...(native ? { value: amountIn } : {}),
      }
    }
  } else {
    const guess = approx ?? createDefaultApproxParams()
    if (sy) {
      call = {
        address: ROUTER_V4,
        abi: routerLiquidityAbi,
        functionName: 'addLiquiditySingleSy',
        args: [receiver, snapshot.address, amountIn, minLpOut, guess, EMPTY_LIMIT_ORDER_DATA],
      }
    } else {
      call = {
        address: ROUTER_V4,
        abi: routerLiquidityAbi,
        functionName: 'addLiquiditySingleToken',
        args: [
          receiver,
          snapshot.address,
          minLpOut,
          guess,
          tokenInput(tokenIn, amountIn),
          EMPTY_LIMIT_ORDER_DATA,
        ],
        ...(native ? { value: amountIn } : {}),
      }
    }
  }
  return {
    describe: `Zap ${fmt(amountIn, tokenInDecimals)} ${tokenInSymbol} into LP${keepYt ? ` (keeping ${snapshot.ytSymbol})` : ''}`,
    approvals: native
      ? []
      : [approval(tokenIn, ROUTER_V4, amountIn, tokenInSymbol, tokenInDecimals)],
    call,
  }
}

/** LP approval — the LP token IS the market contract itself (18 decimals). */
function lpApproval(snapshot: MarketSnapshot, lpIn: bigint): ApprovalNeed {
  return approval(snapshot.address, ROUTER_V4, lpIn, 'LP', LP_DECIMALS)
}

/** Dual remove — removeLiquidityDualSyAndPt (SY target) or DualTokenAndPt. */
export function planDualRemove(
  snapshot: MarketSnapshot,
  tokenOut: Address,
  tokenOutSymbol: string,
  tokenOutDecimals: number,
  lpIn: bigint,
  minSyOrTokenOut: bigint,
  minPtOut: bigint,
  receiver: Address,
): ActionPlan {
  void tokenOutDecimals
  let call: PlannedCall
  if (isSyToken(snapshot, tokenOut)) {
    call = {
      address: ROUTER_V4,
      abi: routerLiquidityAbi,
      functionName: 'removeLiquidityDualSyAndPt',
      args: [receiver, snapshot.address, lpIn, minSyOrTokenOut, minPtOut],
    }
  } else {
    call = {
      address: ROUTER_V4,
      abi: routerLiquidityAbi,
      functionName: 'removeLiquidityDualTokenAndPt',
      args: [
        receiver,
        snapshot.address,
        lpIn,
        tokenOutput(tokenOut, minSyOrTokenOut),
        minPtOut,
      ],
    }
  }
  return {
    describe: `Remove ${fmt(lpIn, LP_DECIMALS)} LP → ${tokenOutSymbol} + ${snapshot.ptSymbol}`,
    approvals: [lpApproval(snapshot, lpIn)],
    call,
  }
}

/** Zap out — removeLiquiditySingleToken/Sy. */
export function planZapOut(
  snapshot: MarketSnapshot,
  tokenOut: Address,
  tokenOutSymbol: string,
  tokenOutDecimals: number,
  lpIn: bigint,
  minTokenOut: bigint,
  receiver: Address,
): ActionPlan {
  void tokenOutDecimals
  let call: PlannedCall
  if (isSyToken(snapshot, tokenOut)) {
    call = {
      address: ROUTER_V4,
      abi: routerLiquidityAbi,
      functionName: 'removeLiquiditySingleSy',
      args: [receiver, snapshot.address, lpIn, minTokenOut, EMPTY_LIMIT_ORDER_DATA],
    }
  } else {
    call = {
      address: ROUTER_V4,
      abi: routerLiquidityAbi,
      functionName: 'removeLiquiditySingleToken',
      args: [
        receiver,
        snapshot.address,
        lpIn,
        tokenOutput(tokenOut, minTokenOut),
        EMPTY_LIMIT_ORDER_DATA,
      ],
    }
  }
  return {
    describe: `Zap ${fmt(lpIn, LP_DECIMALS)} LP out → ${tokenOutSymbol}`,
    approvals: [lpApproval(snapshot, lpIn)],
    call,
  }
}
