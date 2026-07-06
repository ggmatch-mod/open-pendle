/**
 * M2 action builders — pure, framework-free (erasable TS, .ts imports).
 *
 * Signatures are the shared contract (UI codes against them). Conventions:
 * - address(0) = native ETH (SY tokensIn convention); native needs no approval,
 *   the amount rides in PlannedCall.value.
 * - Approval targets: SY.deposit → approve tokenIn to the SY itself;
 *   router flows (mintPy* / redeemPy*) → approve to ROUTER_V4 (SY for mint,
 *   PT AND YT for redeem — YT only pre-expiry: post-expiry the router burns
 *   no YT, so an YT approval would be a pointless extra tx). Claim needs no
 *   approvals. SY.redeem burns the caller's own SY — no approval either.
 * - min-out params are computed by the caller (quote × (1 − slippage)).
 * - Router PY functions take the YT address, not the market.
 * - Router TokenInput/TokenOutput are always SwapType.NONE + pendleSwap =
 *   address(0) + tokenMintSy/tokenRedeemSy = the token itself (v1 zap scope:
 *   SY-accepted tokens only).
 * - `describe` strings embed amounts formatted compactly (≤6 significant
 *   fractional digits, trailing zeros trimmed) with the caller-passed symbols.
 * - Decimals rule (settled on-chain): PT/YT decimals = SY.assetInfo()
 *   .assetDecimals — NOT SY.decimals(); the yield-contract factory mints PT
 *   and YT with assetDecimals, and live markets exist where the two differ in
 *   both directions (SY-dWBTC: SY 8 / PT+YT 18; SY-RLP: SY 18 / PT+YT 6).
 *   LP = 18. SY amounts stay on sy.decimals.
 * - `indicativeOut` is left unset — the caller (UI) fills it from the quote*
 *   functions so display stays clearly separated from the binding simulation.
 */

import { formatUnits } from 'viem'
import type { Address, PublicClient } from 'viem'
import type {
  ActionPlan,
  ApprovalNeed,
  MarketSnapshot,
  PlannedCall,
  SyInfo,
} from './types.ts'
import { MULTICALL3, ROUTER_V4 } from './addresses.ts'
import { routerActionsAbi, syActionsAbi, syReadAbi, ytIndexAbi } from './pendleAbi.ts'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'
const ONE_E18 = 10n ** 18n

/** SwapType.NONE plumbing shared by every TokenInput/TokenOutput we build. */
const EMPTY_SWAP_DATA = {
  swapType: 0,
  extRouter: ZERO_ADDRESS,
  extCalldata: '0x',
  needScale: false,
} as const

function isNative(token: Address): boolean {
  return token.toLowerCase() === ZERO_ADDRESS
}

/** Compact human amount for describe strings: ≤6 fractional digits, trailing zeros trimmed. */
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

/** SY.previewDeposit — exact view quote for wrap. */
export async function quoteWrap(
  client: PublicClient,
  sy: SyInfo,
  tokenIn: Address,
  amountIn: bigint,
): Promise<bigint> {
  return client.readContract({
    address: sy.address,
    abi: syActionsAbi,
    functionName: 'previewDeposit',
    args: [tokenIn, amountIn],
  })
}

/** SY.previewRedeem — exact view quote for unwrap. */
export async function quoteUnwrap(
  client: PublicClient,
  sy: SyInfo,
  tokenOut: Address,
  amountSy: bigint,
): Promise<bigint> {
  return client.readContract({
    address: sy.address,
    abi: syActionsAbi,
    functionName: 'previewRedeem',
    args: [tokenOut, amountSy],
  })
}

/**
 * pyIndex = max(SY.exchangeRate(), YT.pyIndexStored()) — the same formula
 * YT.pyIndexCurrent() applies on-chain (monotone non-decreasing).
 * Exported for M5: maturity.ts' previewExitPostExp redeems the PT leg at
 * exactly this index (one shared multicall implementation, not a duplicate).
 */
export async function readPyIndex(client: PublicClient, snapshot: MarketSnapshot): Promise<bigint> {
  const [rateR, storedR] = await client.multicall({
    contracts: [
      { address: snapshot.sy.address, abi: syReadAbi, functionName: 'exchangeRate' },
      { address: snapshot.yt, abi: ytIndexAbi, functionName: 'pyIndexStored' },
    ],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })
  const rate = rateR.status === 'success' ? rateR.result : 0n
  const stored = storedR.status === 'success' ? storedR.result : 0n
  const pyIndex = rate > stored ? rate : stored
  if (pyIndex === 0n) {
    throw new Error('pyIndex unavailable — SY.exchangeRate() and YT.pyIndexStored() both unreadable')
  }
  return pyIndex
}

/** Indicative PT+YT out for mintPyFromSy: syToAsset at current pyIndex (amountSy · pyIndex / 1e18). */
export async function quoteMintPyFromSy(
  client: PublicClient,
  snapshot: MarketSnapshot,
  amountSy: bigint,
): Promise<bigint> {
  const pyIndex = await readPyIndex(client, snapshot)
  return (amountSy * pyIndex) / ONE_E18
}

/** Indicative SY out for redeemPyToSy at current pyIndex (amountPy · 1e18 / pyIndex). */
export async function quoteRedeemPyToSy(
  client: PublicClient,
  snapshot: MarketSnapshot,
  amountPy: bigint,
): Promise<bigint> {
  const pyIndex = await readPyIndex(client, snapshot)
  return (amountPy * ONE_E18) / pyIndex
}

export function planWrap(
  sy: SyInfo,
  tokenIn: Address,
  tokenInSymbol: string,
  tokenInDecimals: number,
  amountIn: bigint,
  minSyOut: bigint,
  receiver: Address,
): ActionPlan {
  const native = isNative(tokenIn)
  const call: PlannedCall = {
    address: sy.address,
    abi: syActionsAbi,
    functionName: 'deposit',
    // Native ETH: tokenIn stays address(0), the amount rides in `value`.
    args: [receiver, tokenIn, amountIn, minSyOut],
    ...(native ? { value: amountIn } : {}),
  }
  return {
    describe: `Wrap ${fmt(amountIn, tokenInDecimals)} ${tokenInSymbol} → ${sy.symbol}`,
    approvals: native
      ? []
      : [approval(tokenIn, sy.address, amountIn, tokenInSymbol, tokenInDecimals)],
    call,
  }
}

export function planUnwrap(
  sy: SyInfo,
  tokenOut: Address,
  tokenOutSymbol: string,
  tokenOutDecimals: number,
  amountSy: bigint,
  minTokenOut: bigint,
  receiver: Address,
): ActionPlan {
  void tokenOutDecimals
  return {
    describe: `Unwrap ${fmt(amountSy, sy.decimals)} ${sy.symbol} → ${tokenOutSymbol}`,
    // SY.redeem burns the caller's own SY balance — no approval needed.
    approvals: [],
    call: {
      address: sy.address,
      abi: syActionsAbi,
      functionName: 'redeem',
      // burnFromInternalBalance = false always (we never hold internal balances).
      args: [receiver, amountSy, tokenOut, minTokenOut, false],
    },
  }
}

/** Router mintPyFromSy — approvals: SY → router. */
export function planMintPyFromSy(
  snapshot: MarketSnapshot,
  amountSy: bigint,
  minPyOut: bigint,
  receiver: Address,
): ActionPlan {
  const sy = snapshot.sy
  return {
    describe: `Mint ${snapshot.ptSymbol} + ${snapshot.ytSymbol} from ${fmt(amountSy, sy.decimals)} ${sy.symbol}`,
    approvals: [approval(sy.address, ROUTER_V4, amountSy, sy.symbol, sy.decimals)],
    call: {
      address: ROUTER_V4,
      abi: routerActionsAbi,
      functionName: 'mintPyFromSy',
      args: [receiver, snapshot.yt, amountSy, minPyOut],
    },
  }
}

/** Router mintPyFromToken (TokenInput, SwapType NONE) — tokenIn must be in SY.tokensIn. */
export function planMintPyFromToken(
  snapshot: MarketSnapshot,
  tokenIn: Address,
  tokenInSymbol: string,
  tokenInDecimals: number,
  amountIn: bigint,
  minPyOut: bigint,
  receiver: Address,
): ActionPlan {
  const native = isNative(tokenIn)
  const input = {
    tokenIn,
    netTokenIn: amountIn,
    tokenMintSy: tokenIn,
    pendleSwap: ZERO_ADDRESS,
    swapData: EMPTY_SWAP_DATA,
  }
  const call: PlannedCall = {
    address: ROUTER_V4,
    abi: routerActionsAbi,
    functionName: 'mintPyFromToken',
    args: [receiver, snapshot.yt, minPyOut, input],
    ...(native ? { value: amountIn } : {}),
  }
  return {
    describe: `Mint ${snapshot.ptSymbol} + ${snapshot.ytSymbol} from ${fmt(amountIn, tokenInDecimals)} ${tokenInSymbol}`,
    approvals: native
      ? []
      : [approval(tokenIn, ROUTER_V4, amountIn, tokenInSymbol, tokenInDecimals)],
    call,
  }
}

/** Router redeemPyToSy — pre-expiry needs equal PT+YT; approvals: PT → router, YT → router (YT pre-expiry only). */
export function planRedeemPyToSy(
  snapshot: MarketSnapshot,
  amountPy: bigint,
  minSyOut: bigint,
  receiver: Address,
): ActionPlan {
  return {
    describe: `Redeem ${fmt(amountPy, snapshot.sy.assetDecimals)} ${snapshot.ptSymbol}${snapshot.isExpired ? '' : ` + ${snapshot.ytSymbol}`} → ${snapshot.sy.symbol}`,
    approvals: redeemPyApprovals(snapshot, amountPy),
    call: {
      address: ROUTER_V4,
      abi: routerActionsAbi,
      functionName: 'redeemPyToSy',
      args: [receiver, snapshot.yt, amountPy, minSyOut],
    },
  }
}

/** Router redeemPyToToken (TokenOutput, SwapType NONE) — tokenOut must be in SY.tokensOut. */
export function planRedeemPyToToken(
  snapshot: MarketSnapshot,
  tokenOut: Address,
  tokenOutSymbol: string,
  tokenOutDecimals: number,
  amountPy: bigint,
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
    describe: `Redeem ${fmt(amountPy, snapshot.sy.assetDecimals)} ${snapshot.ptSymbol}${snapshot.isExpired ? '' : ` + ${snapshot.ytSymbol}`} → ${tokenOutSymbol}`,
    approvals: redeemPyApprovals(snapshot, amountPy),
    call: {
      address: ROUTER_V4,
      abi: routerActionsAbi,
      functionName: 'redeemPyToToken',
      args: [receiver, snapshot.yt, amountPy, output],
    },
  }
}

/**
 * PT always; YT only pre-expiry (the router's _redeemPyToSy only pulls/burns
 * YT while the yield contract is live). PT/YT carry the SY's assetDecimals
 * (the factory mints them with SY.assetInfo().assetDecimals — see header).
 */
function redeemPyApprovals(snapshot: MarketSnapshot, amountPy: bigint): ApprovalNeed[] {
  const decimals = snapshot.sy.assetDecimals
  const approvals = [
    approval(snapshot.pt, ROUTER_V4, amountPy, snapshot.ptSymbol, decimals),
  ]
  if (!snapshot.isExpired) {
    approvals.push(approval(snapshot.yt, ROUTER_V4, amountPy, snapshot.ytSymbol, decimals))
  }
  return approvals
}

/** Router redeemDueInterestAndRewards(user, [sy], [yt], [market]) — no approvals. */
export function planClaim(user: Address, snapshot: MarketSnapshot): ActionPlan {
  return {
    describe: `Claim accrued interest & rewards on ${snapshot.displayName}`,
    approvals: [],
    call: {
      address: ROUTER_V4,
      abi: routerActionsAbi,
      functionName: 'redeemDueInterestAndRewards',
      args: [user, [snapshot.sy.address], [snapshot.yt], [snapshot.address]],
    },
  }
}

/**
 * Batched claim across many markets on ONE chain (M12 "My positions"): a single
 * redeemDueInterestAndRewards(user, sys[], yts[], markets[]) claims all their
 * accrued YT interest + SY/LP rewards in one tx. The router iterates the arrays
 * independently, so passing every pool's (sy, yt, market) claims them together.
 * Caller passes only snapshots that actually have something claimable (an empty
 * probe would just waste gas). All snapshots MUST be on the same chain as the
 * client that will simulate/send this — the caller groups by chain first.
 */
export function planClaimAll(user: Address, snapshots: readonly MarketSnapshot[]): ActionPlan {
  const n = snapshots.length
  return {
    describe: `Claim accrued interest & rewards on ${n} pool${n === 1 ? '' : 's'}`,
    approvals: [],
    call: {
      address: ROUTER_V4,
      abi: routerActionsAbi,
      functionName: 'redeemDueInterestAndRewards',
      args: [
        user,
        snapshots.map((s) => s.sy.address),
        snapshots.map((s) => s.yt),
        snapshots.map((s) => s.address),
      ],
    },
  }
}

/**
 * Market-less claim (M12 "paste any token"): redeemDueInterestAndRewards with an
 * EMPTY markets[] — claims YT interest + YT/SY rewards for a pasted PT/YT set
 * with no market of its own (so no LP rewards, and it never touches a market
 * address it doesn't have). No approvals.
 */
export function planClaimTokens(user: Address, sy: Address, yt: Address): ActionPlan {
  return {
    describe: 'Claim accrued interest & rewards',
    approvals: [],
    call: {
      address: ROUTER_V4,
      abi: routerActionsAbi,
      functionName: 'redeemDueInterestAndRewards',
      args: [user, [sy], [yt], []],
    },
  }
}
