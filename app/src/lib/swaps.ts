/**
 * M3 swap quoter + plan builders — pure, framework-free (erasable TS).
 *
 * SKELETON: signatures are the shared contract (UI codes against them; the
 * data-layer work fills the bodies). Design per PLAN §3.2 + fork-tests/PARITY.md:
 * - Quotes come from RouterStatic swap statics (fork-verified: they quote in
 *   the per-router DISCOUNTED fee context, ≤~50 ppm vs execution).
 * - ApproxParams are synthesized client-side (guessOffchain = static quote,
 *   slippage-scaled bounds: guessMin tracks the user's slippage tolerance,
 *   guessMax carries +5% headroom, small maxIteration — mirroring Pendle's
 *   own deployed generator) — the repo's 2-arg generator helpers do NOT
 *   exist on the deployed diamond. Fallback: default full-range params.
 * - Only BUY directions (…ForPt / …ForYt) take ApproxParams; sells are
 *   exact-in with no search.
 * - minOut is caller-computed: quote × (1 − max(slippage, 0.0005)) — the
 *   0.05% floor absorbs the fork-observed static over-quote on YT buys.
 * - token == snapshot.sy.address selects the *Sy router variants; any other
 *   token must be in SY.tokensIn/tokensOut and uses TokenInput/TokenOutput
 *   with SwapType.NONE. address(0) = native ETH (value rides on the call).
 * - Always empty LimitOrderData.
 * - PT/YT amounts are raw at SY.assetInfo().assetDecimals (M2 rule).
 *
 * exchangeRateAfter → impliedApyAfter (live-verified 2026-07-04 on the PLP
 * USDai market): the statics' exchangeRateAfter sits in the same frame as
 * exp(lastLnImpliedRate·T/365d) — at zero trade size that expression matches
 * getMarketState's marketExchangeRateExcludeFee within 0.3 ppm, and the
 * post-trade value moves monotonically down for PT buys / up for PT sells
 * (and the reverse for YT). Hence
 *   impliedApyAfter = (exchangeRateAfter/1e18)^(31536000/T) − 1,  T = expiry − now
 * computed in floating point; T ≤ 0 or nonsense rates → undefined.
 */

import { formatUnits } from 'viem'
import type { Address, PublicClient } from 'viem'
import type {
  ActionPlan,
  ApprovalNeed,
  ApproxParamsStruct,
  MarketSnapshot,
  PlannedCall,
  SwapQuote,
} from './types.ts'
import { ROUTER_V4, addressBookFor } from './addresses.ts'
import { routerStaticSwapAbi, routerSwapAbi } from './pendleAbi.ts'

export type SwapSide = 'pt' | 'yt'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'
const ONE_E18 = 10n ** 18n
const SECONDS_PER_YEAR = 31_536_000

/** SwapType.NONE plumbing — same shape actions.ts uses for every TokenInput/TokenOutput. */
const EMPTY_SWAP_DATA = {
  swapType: 0,
  extRouter: ZERO_ADDRESS,
  extCalldata: '0x',
  needScale: false,
} as const

/** Empty LimitOrderData — routes 100% through the AMM (F11; QuoterParity-proven encoding). */
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

/** Compact human amount for describe strings: ≤6 fractional digits, trailing zeros trimmed (actions.ts convention). */
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

/** Full-range on-chain search — the fork-proven fallback. */
export function createDefaultApproxParams(): ApproxParamsStruct {
  return {
    guessMin: 0n,
    guessMax: 2n ** 256n - 1n,
    guessOffchain: 0n,
    maxIteration: 256n,
    eps: 10n ** 14n,
  }
}

/**
 * Client-synthesized ApproxParams for buys, mirroring Pendle's own deployed
 * generator (guessOffchain = the static quote): guessMin scales with the
 * user's slippage tolerance (floored at 0.1% — fixed ±0.1% bounds were
 * live-reproduced to revert on ANY pool move beyond 0.1%), guessMax carries
 * +5% upward headroom so favorable moves never revert, eps 1e14.
 */
function synthesizeApproxParams(
  staticOut: bigint,
  effectiveSlippage: number,
): ApproxParamsStruct | null {
  if (staticOut <= 0n) return null
  // Basis-point bigint math from the float slippage; the integer division
  // rounds guessMin DOWN (never above the reachable region).
  const slippageBps = BigInt(
    Math.min(10_000, Math.max(10, Math.round(Math.max(effectiveSlippage, 0.001) * 10_000))),
  )
  return {
    guessMin: (staticOut * (10_000n - slippageBps)) / 10_000n,
    guessMax: (staticOut * 105n) / 100n,
    guessOffchain: staticOut,
    maxIteration: 30n,
    eps: 10n ** 14n,
  }
}

/**
 * Post-trade implied APY from the static's exchangeRateAfter (see header for
 * the live-verified semantics). Guards: expired/expiring (T ≤ 0), rate < 1
 * (on-chain math forbids it — a lower value means garbage decode) and
 * non-finite/absurd results all yield undefined rather than a wrong number.
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

function buildQuote(
  snapshot: MarketSnapshot,
  amountOut: bigint,
  netSyFee: bigint,
  priceImpact1e18: bigint,
  exchangeRateAfter: bigint,
  approx: ApproxParamsStruct | null,
): SwapQuote {
  return {
    amountOut,
    // Statics return priceImpact 1e18-scaled — normalize to a fraction.
    priceImpact: Number(priceImpact1e18) / 1e18,
    impliedApyAfter: impliedApyAfterFromExchangeRate(snapshot, exchangeRateAfter),
    netSyFee,
    approx,
  }
}

/**
 * Buy PT/YT quote: pay `tokenIn` (SY address for the Sy variant), exact-in.
 * `slippageFraction` (the caller's effective slippage) is used ONLY to scale
 * the synthesized ApproxParams bounds — never for min-out math.
 */
export async function quoteBuy(
  client: PublicClient,
  snapshot: MarketSnapshot,
  side: SwapSide,
  tokenIn: Address,
  amountIn: bigint,
  slippageFraction: number,
): Promise<SwapQuote> {
  // RouterStatic is PER CHAIN — resolve from the client's chain (F10 quoter).
  const routerStatic = addressBookFor(client).routerStatic
  if (isSyToken(snapshot, tokenIn)) {
    const [netOut, netSyFee, priceImpact, exchangeRateAfter] = await client.readContract({
      address: routerStatic,
      abi: routerStaticSwapAbi,
      functionName: side === 'pt' ? 'swapExactSyForPtStatic' : 'swapExactSyForYtStatic',
      args: [snapshot.address, amountIn],
    })
    return buildQuote(
      snapshot, netOut, netSyFee, priceImpact, exchangeRateAfter,
      synthesizeApproxParams(netOut, slippageFraction),
    )
  }
  // Token variant — amountIn must be scaled at the TOKEN's own decimals
  // (PARITY gotcha: a mis-scaled 6-decimal tokensIn entry reverts APPROX_EXHAUSTED).
  const [netOut, , netSyFee, priceImpact, exchangeRateAfter] = await client.readContract({
    address: routerStatic,
    abi: routerStaticSwapAbi,
    functionName: side === 'pt' ? 'swapExactTokenForPtStatic' : 'swapExactTokenForYtStatic',
    args: [snapshot.address, tokenIn, amountIn],
  })
  return buildQuote(
    snapshot, netOut, netSyFee, priceImpact, exchangeRateAfter,
    synthesizeApproxParams(netOut, slippageFraction),
  )
}

/** Sell PT/YT quote: receive `tokenOut` (SY address for the Sy variant), exact PT/YT in. Sells take no ApproxParams. */
export async function quoteSell(
  client: PublicClient,
  snapshot: MarketSnapshot,
  side: SwapSide,
  tokenOut: Address,
  amountPy: bigint,
): Promise<SwapQuote> {
  // RouterStatic is PER CHAIN — resolve from the client's chain (F10 quoter).
  const routerStatic = addressBookFor(client).routerStatic
  const sy = isSyToken(snapshot, tokenOut)
  if (side === 'pt') {
    if (sy) {
      const [netSyOut, netSyFee, priceImpact, exchangeRateAfter] = await client.readContract({
        address: routerStatic,
        abi: routerStaticSwapAbi,
        functionName: 'swapExactPtForSyStatic',
        args: [snapshot.address, amountPy],
      })
      return buildQuote(snapshot, netSyOut, netSyFee, priceImpact, exchangeRateAfter, null)
    }
    // (netTokenOut, netSyToRedeem, netSyFee, priceImpact, exchangeRateAfter)
    const [netTokenOut, , netSyFee, priceImpact, exchangeRateAfter] = await client.readContract({
      address: routerStatic,
      abi: routerStaticSwapAbi,
      functionName: 'swapExactPtForTokenStatic',
      args: [snapshot.address, amountPy, tokenOut],
    })
    return buildQuote(snapshot, netTokenOut, netSyFee, priceImpact, exchangeRateAfter, null)
  }
  if (sy) {
    const [netSyOut, netSyFee, priceImpact, exchangeRateAfter] = await client.readContract({
      address: routerStatic,
      abi: routerStaticSwapAbi,
      functionName: 'swapExactYtForSyStatic',
      args: [snapshot.address, amountPy],
    })
    return buildQuote(snapshot, netSyOut, netSyFee, priceImpact, exchangeRateAfter, null)
  }
  // (netTokenOut, netSyFee, priceImpact, exchangeRateAfter, …extra) — fee at
  // index 1 here, unlike the PT sibling (live-verified asymmetry, see pendleAbi).
  const [netTokenOut, netSyFee, priceImpact, exchangeRateAfter] = await client.readContract({
    address: routerStatic,
    abi: routerStaticSwapAbi,
    functionName: 'swapExactYtForTokenStatic',
    args: [snapshot.address, amountPy, tokenOut],
  })
  return buildQuote(snapshot, netTokenOut, netSyFee, priceImpact, exchangeRateAfter, null)
}

/** Buy plan — approvals: tokenIn → router (none for native; SY variant approves the SY). */
export function planBuy(
  snapshot: MarketSnapshot,
  side: SwapSide,
  tokenIn: Address,
  tokenInSymbol: string,
  tokenInDecimals: number,
  amountIn: bigint,
  minPyOut: bigint,
  approx: ApproxParamsStruct | null,
  receiver: Address,
): ActionPlan {
  const outSymbol = side === 'pt' ? snapshot.ptSymbol : snapshot.ytSymbol
  const guess = approx ?? createDefaultApproxParams()
  let call: PlannedCall
  let approvals: ApprovalNeed[]
  if (isSyToken(snapshot, tokenIn)) {
    call = {
      address: ROUTER_V4,
      abi: routerSwapAbi,
      functionName: side === 'pt' ? 'swapExactSyForPt' : 'swapExactSyForYt',
      args: [receiver, snapshot.address, amountIn, minPyOut, guess, EMPTY_LIMIT_ORDER_DATA],
    }
    approvals = [approval(tokenIn, ROUTER_V4, amountIn, tokenInSymbol, tokenInDecimals)]
  } else {
    const native = isNative(tokenIn)
    const input = {
      tokenIn,
      netTokenIn: amountIn,
      tokenMintSy: tokenIn,
      pendleSwap: ZERO_ADDRESS,
      swapData: EMPTY_SWAP_DATA,
    }
    call = {
      address: ROUTER_V4,
      abi: routerSwapAbi,
      functionName: side === 'pt' ? 'swapExactTokenForPt' : 'swapExactTokenForYt',
      args: [receiver, snapshot.address, minPyOut, guess, input, EMPTY_LIMIT_ORDER_DATA],
      ...(native ? { value: amountIn } : {}),
    }
    approvals = native
      ? []
      : [approval(tokenIn, ROUTER_V4, amountIn, tokenInSymbol, tokenInDecimals)]
  }
  return {
    describe: `Buy ${outSymbol} with ${fmt(amountIn, tokenInDecimals)} ${tokenInSymbol}`,
    approvals,
    call,
  }
}

/** Sell plan — approvals: PT or YT → router (PT/YT carry SY assetDecimals, M2 rule). */
export function planSell(
  snapshot: MarketSnapshot,
  side: SwapSide,
  tokenOut: Address,
  tokenOutSymbol: string,
  tokenOutDecimals: number,
  amountPy: bigint,
  minTokenOut: bigint,
  receiver: Address,
): ActionPlan {
  void tokenOutDecimals
  const pyToken = side === 'pt' ? snapshot.pt : snapshot.yt
  const pySymbol = side === 'pt' ? snapshot.ptSymbol : snapshot.ytSymbol
  let call: PlannedCall
  if (isSyToken(snapshot, tokenOut)) {
    call = {
      address: ROUTER_V4,
      abi: routerSwapAbi,
      functionName: side === 'pt' ? 'swapExactPtForSy' : 'swapExactYtForSy',
      args: [receiver, snapshot.address, amountPy, minTokenOut, EMPTY_LIMIT_ORDER_DATA],
    }
  } else {
    const output = {
      tokenOut,
      minTokenOut,
      tokenRedeemSy: tokenOut,
      pendleSwap: ZERO_ADDRESS,
      swapData: EMPTY_SWAP_DATA,
    }
    call = {
      address: ROUTER_V4,
      abi: routerSwapAbi,
      functionName: side === 'pt' ? 'swapExactPtForToken' : 'swapExactYtForToken',
      args: [receiver, snapshot.address, amountPy, output, EMPTY_LIMIT_ORDER_DATA],
    }
  }
  return {
    describe: `Sell ${fmt(amountPy, snapshot.sy.assetDecimals)} ${pySymbol} → ${tokenOutSymbol}`,
    approvals: [approval(pyToken, ROUTER_V4, amountPy, pySymbol, snapshot.sy.assetDecimals)],
    call,
  }
}

/**
 * ESTIMATE ONLY (UI warnings, e.g. the 0.96 PT-proportion trade cap — never
 * used for tx building): rough post-trade PT proportion of the pool.
 *
 * Buying YT or selling PT ADDS ~amountPyApprox PT to the pool; buying PT or
 * selling YT REMOVES it. Holding the asset side fixed,
 *   p' = (totalPt ± Δ) / ((totalPt ± Δ) + totalAsset)
 * in raw accounting-asset units (totalAsset = totalSy·SY.exchangeRate/1e18,
 * the same frame market.ts uses for metrics.ptProportion), clamped to 0..1.
 * It ignores the trade's own SY leg and index drift — good enough to warn
 * before the router's approx search fails, not an execution predictor.
 */
export function estimatePostTradeProportion(
  snapshot: MarketSnapshot,
  side: SwapSide,
  action: 'buy' | 'sell',
  amountPyApprox: bigint,
): number {
  const addsPt = (side === 'yt' && action === 'buy') || (side === 'pt' && action === 'sell')
  let totalPt = snapshot.state.totalPt + (addsPt ? amountPyApprox : -amountPyApprox)
  if (totalPt < 0n) totalPt = 0n
  const totalAsset = (snapshot.state.totalSy * snapshot.sy.exchangeRate) / ONE_E18
  const denominator = totalPt + totalAsset
  if (denominator <= 0n) return 0
  const p = Number(totalPt) / Number(denominator)
  if (!Number.isFinite(p)) return 0
  return Math.min(1, Math.max(0, p))
}
