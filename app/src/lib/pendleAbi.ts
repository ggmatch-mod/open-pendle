/**
 * Minimal hand-written ABIs for M0's live address-book resolution (PLAN F12).
 *
 * Everything governance-mutable (active factories, expiryDivisor, fee rates,
 * treasury, fee caps) is read through these at runtime instead of being
 * hardcoded. The full ABI pipeline (@wagmi/cli codegen from @pendle/core-v2 +
 * checked-in verified sources) lands with M1; keep this file minimal.
 */

import { parseAbi } from 'viem'

/**
 * PendleCommonPoolDeployHelperV2 (`commonDeploy`) — public immutables.
 * These four getters are the live source of truth for the active protocol
 * wiring; PLAN §3.2 mandates resolving factories from here, never hardcoding.
 */
export const commonDeployAbi = parseAbi([
  // Active market factory (currently the "V6" generation proxy).
  'function marketFactory() view returns (address)',
  // Active PT/YT (yield contract) factory paired with the market factory.
  'function yieldContractFactory() view returns (address)',
  // Router the helper wires new pools to (Router V4).
  'function router() view returns (address)',
  // PendleCommonSYFactory used for combined SY+market deploys.
  'function syFactory() view returns (address)',
])

/**
 * Yield contract factory (PT/YT factory) — governance-mutable parameters.
 * Note: on-chain storage uses narrow uints (uint96/uint128); declaring
 * uint256 is ABI-compatible since return words are 32-byte padded.
 */
export const yieldContractFactoryAbi = parseAbi([
  // Expiries must be a multiple of this (86400 = daily 00:00 UTC; read live).
  'function expiryDivisor() view returns (uint256)',
  // Fee on YT interest/rewards, 1e18-scaled (5e16 = 5% on the active factory).
  'function interestFeeRate() view returns (uint256)',
  // Fee recipient — Pendle's treasury (contract-enforced, F3).
  'function treasury() view returns (address)',
])

/**
 * Market factory — governance-mutable parameters + per-market fee config.
 */
export const marketFactoryAbi = parseAbi([
  // Cap on a market's lnFeeRateRoot; fee cap % = e^(value/1e18) − 1 (ln(1.05) → 5%).
  'function maxLnFeeRateRoot() view returns (uint256)',
  // Fee recipient — Pendle's treasury.
  'function treasury() view returns (address)',
  // Per-(market, router) fee config (F10: fees are per-router; quote through
  // the router you execute through). Not called in M0; needed from M1 on.
  'function getMarketConfig(address market, address router) view returns (address treasury, uint80 overriddenFee, uint8 reserveFeePercent)',
])

// ---------------------------------------------------------------------------
// M1 additions — market reader / paste-classification ABIs (data layer).
// One universal read ABI covers all five factory generations (PLAN F7).
// ---------------------------------------------------------------------------

/**
 * Universal PendleMarket read ABI (all vintages, v1 → active).
 * `readState(router)` MUST be called with the actual router (F10): fee fields
 * are per-(market, router) overrides, never pass address(0).
 */
export const marketReadAbi = parseAbi([
  'struct MarketState { int256 totalPt; int256 totalSy; int256 totalLp; address treasury; int256 scalarRoot; uint256 expiry; uint256 lnFeeRateRoot; uint256 reserveFeePercent; uint256 lastLnImpliedRate; }',
  'function readTokens() view returns (address _SY, address _PT, address _YT)',
  'function readState(address router) view returns (MarketState market)',
  'function expiry() view returns (uint256)',
  'function isExpired() view returns (bool)',
  'function factory() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
])

/** Market-factory paste-validation gate (returns false, never reverts, on junk — F7). */
export const factoryValidateAbi = parseAbi([
  'function isValidMarket(address market) view returns (bool)',
])

/**
 * IStandardizedYield reads + trust probes. `owner()`/`paused()` are probes:
 * absent on some SYs, callers must try/catch them individually.
 * Legacy v1 markets wrap SCY contracts where `exchangeRate()` may be missing —
 * probe failures degrade, never fail the load.
 */
export const syReadAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function assetInfo() view returns (uint8 assetType, address assetAddress, uint8 assetDecimals)',
  'function exchangeRate() view returns (uint256)',
  'function getTokensIn() view returns (address[] tokens)',
  'function getTokensOut() view returns (address[] tokens)',
  'function yieldToken() view returns (address)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
])

/**
 * PT/YT near-miss probes (M1 paste classifier): a PT exposes SY() + YT(),
 * a YT exposes SY() + PT().
 */
export const pyProbeAbi = parseAbi([
  'function SY() view returns (address)',
  'function PT() view returns (address)',
  'function YT() view returns (address)',
  'function symbol() view returns (string)',
])

/** Bare ERC-20 symbol (asset symbol lookups + plain-contract classification). */
export const erc20SymbolAbi = parseAbi([
  'function symbol() view returns (string)',
])

// ---------------------------------------------------------------------------
// M2 additions — transaction & positions ABIs (data layer). Signatures
// verified against docs/research/pendle-v2-research.md (IPActionMiscV3 /
// IStandardizedYield / IPRouterStatic) AND against live Arbitrum calls
// (2026-07-04): getUserPYInfo takes the YT address and returns ptBalance
// FIRST (token fields checked against readTokens()); getUserSYInfo /
// getUserMarketInfo tuple shapes decoded cleanly with the layouts below.
// ---------------------------------------------------------------------------

/**
 * Router V4 mint/redeem/claim surface (IPActionMiscV3 subset).
 * PY functions take the YT address, NOT the market. TokenInput/TokenOutput are
 * only ever built with SwapType.NONE (0) + pendleSwap = address(0) in v1
 * (SY-accepted tokens; aggregator zaps are v1.5).
 */
export const routerActionsAbi = parseAbi([
  'struct SwapData { uint8 swapType; address extRouter; bytes extCalldata; bool needScale; }',
  'struct TokenInput { address tokenIn; uint256 netTokenIn; address tokenMintSy; address pendleSwap; SwapData swapData; }',
  'struct TokenOutput { address tokenOut; uint256 minTokenOut; address tokenRedeemSy; address pendleSwap; SwapData swapData; }',
  'function mintPyFromToken(address receiver, address YT, uint256 minPyOut, TokenInput input) payable returns (uint256 netPyOut, uint256 netSyInterm)',
  'function mintPyFromSy(address receiver, address YT, uint256 netSyIn, uint256 minPyOut) returns (uint256 netPyOut)',
  'function redeemPyToSy(address receiver, address YT, uint256 netPyIn, uint256 minSyOut) returns (uint256 netSyOut)',
  'function redeemPyToToken(address receiver, address YT, uint256 netPyIn, TokenOutput output) returns (uint256 netTokenOut, uint256 netSyInterm)',
  'function redeemDueInterestAndRewards(address user, address[] sys, address[] yts, address[] markets)',
])

/** IStandardizedYield wrap/unwrap + exact view quotes (M2). deposit is payable (native tokenIn = address(0)). */
export const syActionsAbi = parseAbi([
  'function deposit(address receiver, address tokenIn, uint256 amountTokenToDeposit, uint256 minSharesOut) payable returns (uint256 amountSharesOut)',
  'function redeem(address receiver, uint256 amountSharesToRedeem, address tokenOut, uint256 minTokenOut, bool burnFromInternalBalance) returns (uint256 amountTokenOut)',
  'function previewDeposit(address tokenIn, uint256 amountTokenToDeposit) view returns (uint256 amountSharesOut)',
  'function previewRedeem(address tokenOut, uint256 amountSharesToRedeem) view returns (uint256 amountTokenOut)',
])

/** YT index read for indicative PY quotes: pyIndex = max(SY.exchangeRate(), YT.pyIndexStored()). */
export const ytIndexAbi = parseAbi([
  'function pyIndexStored() view returns (uint256)',
])

/**
 * RouterStatic IPActionInfoStatic getUser* helpers. STATE-MUTATING (they poke
 * reward indexes) — call via eth_call / simulateContract ONLY, never in a tx.
 * `py` in getUserPYInfo is the YT address (live-verified). Consumers should
 * still match pt/yt entries by their `.token` field (positions.ts does).
 */
export const routerStaticUserAbi = parseAbi([
  'struct TokenAmount { address token; uint256 amount; }',
  'struct UserSYInfo { TokenAmount syBalance; TokenAmount[] unclaimedRewards; }',
  'struct UserPYInfo { TokenAmount ptBalance; TokenAmount ytBalance; TokenAmount unclaimedInterest; TokenAmount[] unclaimedRewards; }',
  'struct UserMarketInfo { TokenAmount lpBalance; TokenAmount ptBalance; TokenAmount syBalance; TokenAmount[] unclaimedRewards; }',
  'function getUserSYInfo(address sy, address user) returns (UserSYInfo res)',
  'function getUserPYInfo(address py, address user) returns (UserPYInfo res)',
  'function getUserMarketInfo(address market, address user) returns (UserMarketInfo res)',
])

/** Minimal ERC-20 surface for M2 balances/approvals. */
export const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

// ---------------------------------------------------------------------------
// M3 additions — PT/YT swap surface (data layer). Router signatures from the
// verified IPActionSwapPTV3/IPActionSwapYTV3 sources (research scratchpad);
// RouterStatic signatures live-verified 2026-07-04 against the deployed
// diamond 0xAdB0…B3E8 (raw eth_call word counts + magnitude decoding on the
// PLP USDai market) and cross-checked with fork-tests/QuoterParity.t.sol.
// ---------------------------------------------------------------------------

/**
 * Router V4 swap actions (IPActionSwapPTV3 + IPActionSwapYTV3).
 * - Only BUY directions (…ForPt / …ForYt) take ApproxParams.
 * - LimitOrderData is ALWAYS passed empty by us:
 *   (address(0), 0, [], [], '0x') — routes 100% through the AMM (F11).
 * - TokenInput/TokenOutput follow the M2 rule: SwapType.NONE, pendleSwap =
 *   address(0), tokenMintSy/tokenRedeemSy = the token itself.
 */
export const routerSwapAbi = parseAbi([
  'struct SwapData { uint8 swapType; address extRouter; bytes extCalldata; bool needScale; }',
  'struct TokenInput { address tokenIn; uint256 netTokenIn; address tokenMintSy; address pendleSwap; SwapData swapData; }',
  'struct TokenOutput { address tokenOut; uint256 minTokenOut; address tokenRedeemSy; address pendleSwap; SwapData swapData; }',
  'struct ApproxParams { uint256 guessMin; uint256 guessMax; uint256 guessOffchain; uint256 maxIteration; uint256 eps; }',
  'struct Order { uint256 salt; uint256 expiry; uint256 nonce; uint8 orderType; address token; address YT; address maker; address receiver; uint256 makingAmount; uint256 lnImpliedRate; uint256 failSafeRate; bytes permit; }',
  'struct FillOrderParams { Order order; bytes signature; uint256 makingAmount; }',
  'struct LimitOrderData { address limitRouter; uint256 epsSkipMarket; FillOrderParams[] normalFills; FillOrderParams[] flashFills; bytes optData; }',
  // PT
  'function swapExactTokenForPt(address receiver, address market, uint256 minPtOut, ApproxParams guessPtOut, TokenInput input, LimitOrderData limit) payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm)',
  'function swapExactSyForPt(address receiver, address market, uint256 exactSyIn, uint256 minPtOut, ApproxParams guessPtOut, LimitOrderData limit) returns (uint256 netPtOut, uint256 netSyFee)',
  'function swapExactPtForToken(address receiver, address market, uint256 exactPtIn, TokenOutput output, LimitOrderData limit) returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)',
  'function swapExactPtForSy(address receiver, address market, uint256 exactPtIn, uint256 minSyOut, LimitOrderData limit) returns (uint256 netSyOut, uint256 netSyFee)',
  // YT
  'function swapExactTokenForYt(address receiver, address market, uint256 minYtOut, ApproxParams guessYtOut, TokenInput input, LimitOrderData limit) payable returns (uint256 netYtOut, uint256 netSyFee, uint256 netSyInterm)',
  'function swapExactSyForYt(address receiver, address market, uint256 exactSyIn, uint256 minYtOut, ApproxParams guessYtOut, LimitOrderData limit) returns (uint256 netYtOut, uint256 netSyFee)',
  'function swapExactYtForToken(address receiver, address market, uint256 exactYtIn, TokenOutput output, LimitOrderData limit) returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)',
  'function swapExactYtForSy(address receiver, address market, uint256 exactYtIn, uint256 minSyOut, LimitOrderData limit) returns (uint256 netSyOut, uint256 netSyFee)',
])

/**
 * RouterStatic exact-in swap quote statics (view; display quotes only — the
 * binding number is always a real-router simulation, PLAN §3.2).
 *
 * All 8 selectors live-verified present on the deployed diamond (2026-07-04;
 * PARITY.md's survey additionally covers the 4 exact-out ones we don't use).
 * Return layouts verified by word count + magnitude on live calls; note the
 * asymmetries, they are real:
 * - swapExactPtForTokenStatic carries netSyToRedeem at index 1 (fee at 2);
 * - swapExactYtForTokenStatic carries netSyFee at index 1 (NOT the interm SY)
 *   and 4 trailing extra-info words;
 * - swapExactYtForSyStatic has 3 trailing extra-info words.
 * Trailing extra-info names are best-effort labels (only indices 0–3 are
 * consumed by swaps.ts and were magnitude-verified).
 *
 * priceImpact is 1e18-scaled; exchangeRateAfter is the post-trade market
 * exchange rate in the same frame as exp(lastLnImpliedRate·T/365d) —
 * live-verified within 0.3 ppm of getMarketState's
 * marketExchangeRateExcludeFee at zero trade size, monotone down for PT buys
 * and up for PT sells.
 *
 * The *AndGenerateApproxParams helpers do NOT exist on the deployed diamond
 * (PARITY.md) — ApproxParams are synthesized client-side in swaps.ts.
 */
export const routerStaticSwapAbi = parseAbi([
  // buys (PT)
  'function swapExactSyForPtStatic(address market, uint256 exactSyIn) view returns (uint256 netPtOut, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter)',
  'function swapExactTokenForPtStatic(address market, address tokenIn, uint256 amountTokenIn) view returns (uint256 netPtOut, uint256 netSyMinted, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter)',
  // buys (YT)
  'function swapExactSyForYtStatic(address market, uint256 exactSyIn) view returns (uint256 netYtOut, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter)',
  'function swapExactTokenForYtStatic(address market, address tokenIn, uint256 amountTokenIn) view returns (uint256 netYtOut, uint256 netSyMinted, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter)',
  // sells (PT)
  'function swapExactPtForSyStatic(address market, uint256 exactPtIn) view returns (uint256 netSyOut, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter)',
  'function swapExactPtForTokenStatic(address market, uint256 exactPtIn, address tokenOut) view returns (uint256 netTokenOut, uint256 netSyToRedeem, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter)',
  // sells (YT)
  'function swapExactYtForSyStatic(address market, uint256 exactYtIn) view returns (uint256 netSyOut, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter, uint256 netSyOwedInt, uint256 netPYToRepaySyOwedInt, uint256 netPYToRedeemSyOwedInt)',
  'function swapExactYtForTokenStatic(address market, uint256 exactYtIn, address tokenOut) view returns (uint256 netTokenOut, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter, uint256 netSyOut, uint256 netSyOwedInt, uint256 netPYToRepaySyOwedInt, uint256 netPYToRedeemSyOwedInt)',
])

/**
 * Pendle custom errors (core Errors.sol + MarketV7) that txflow's
 * decodePendleError maps to friendly messages. Selector spot-checks
 * (cast sig, 2026-07-04) match PLAN §3.4: MarketExpired 0xb2094b59,
 * MarketFactoryMarketExists 0x4a588866, MarketFactoryInvalidPt 0x781eae2d,
 * YCFactoryYieldContractExisted 0xa50d9502, YCFactoryInvalidExpiry 0x1f687fd0;
 * YCExpired 0x5b15a6da additionally fork-verified (0-amount mintPyFromSy on an
 * expired market reverts with exactly that selector). The remaining selectors
 * derive from these signature strings at decode time (viem hashes ABI items).
 */
export const pendleErrorsAbi = parseAbi([
  // Market trading errors
  'error MarketExpired()',
  'error MarketZeroNetLPFee()',
  'error MarketProportionTooHigh(int256 proportion, int256 maxProportion)',
  'error MarketInsufficientSyForTrade(int256 currentAmount, int256 requiredAmount)',
  // Yield contract (PT/YT) errors
  'error YCExpired()',
  'error YCNothingToRedeem()',
  // SY errors
  'error SYZeroDeposit()',
  'error SYZeroRedeem()',
  'error SYInsufficientSharesOut(uint256 actualSharesOut, uint256 requiredSharesOut)',
  'error SYInsufficientTokenOut(uint256 actualTokenOut, uint256 requiredTokenOut)',
  // Router min-out (slippage) errors
  'error RouterInsufficientSyOut(uint256 actualSyOut, uint256 requiredSyOut)',
  'error RouterInsufficientPtOut(uint256 actualPtOut, uint256 requiredPtOut)',
  'error RouterInsufficientYtOut(uint256 actualYtOut, uint256 requiredYtOut)',
  'error RouterInsufficientPYOut(uint256 actualPYOut, uint256 requiredPYOut)',
  'error RouterInsufficientLpOut(uint256 actualLpOut, uint256 requiredLpOut)',
  'error RouterInsufficientTokenOut(uint256 actualTokenOut, uint256 requiredTokenOut)',
  // Creation errors (PLAN M6 pre-flight decoding)
  'error MarketFactoryMarketExists()',
  'error MarketFactoryInvalidPt()',
  'error MarketFactoryExpiredPt()',
  'error YCFactoryYieldContractExisted()',
  'error YCFactoryInvalidExpiry()',
  // M3: approx-search failure family (pendle-core-v2 Errors.sol, thrown by the
  // V2 approx lib). NOTE: the deployed Router V4 / RouterStatic on Arbitrum
  // run the V1-style approx lib, whose failures are Error(string) reverts
  // ('Slippage: search range overflow' / '…APPROX_EXHAUSTED') mapped in
  // txflow's friendlyStringRevert — these selectors are decoded as a
  // belt-and-braces for other deployments/paths.
  'error ApproxFail()',
  'error ApproxParamsInvalid(uint256 guessMin, uint256 guessMax, uint256 eps)',
  'error ApproxBinarySearchInputInvalid(uint256 approxGuessMin, uint256 approxGuessMax, uint256 minGuessMin, uint256 maxGuessMax)',
])
