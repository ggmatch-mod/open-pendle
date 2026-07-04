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
  // 2-arg form is the canonical on-chain signature (PendleMarketFactoryV7Upg:
  // `revert Errors.MarketFactoryLnFeeRateRootTooHigh(lnFeeRateRoot,
  // maxLnFeeRateRoot)`). Real selector 0x163cca2a (viem
  // toFunctionSelector('MarketFactoryLnFeeRateRootTooHigh(uint80,uint256)')).
  // The stale no-arg form hashed to 0x4f5e2d07 and never matched a live revert.
  'error MarketFactoryLnFeeRateRootTooHigh(uint80 lnFeeRateRoot, uint256 maxLnFeeRateRoot)',
  // The characteristic bad-band revert: createNewMarket reverts this when the
  // derived initialAnchor < minInitialAnchor (= 1e18). 2-arg (int256, int256),
  // real selector 0x7b48ef70.
  'error MarketFactoryInitialAnchorTooLow(int256 initialAnchor, int256 minInitialAnchor)',
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
  // M4: MarketMathCore add/remove-liquidity errors (verified against the
  // scratchpad MarketMathCore.sol: addLiquidityCore throws ZeroAmountsInput /
  // ZeroAmountsOutput / MarketExpired; removeLiquidityCore the two Zero ones;
  // MarketProportionMustNotEqualOne guards the post-add swap proportion).
  'error MarketZeroAmountsInput()',
  'error MarketZeroAmountsOutput()',
  'error MarketProportionMustNotEqualOne()',
])

// ---------------------------------------------------------------------------
// M4 additions — liquidity surface (data layer). Router signatures verified
// verbatim against the scratchpad IPActionAddRemoveLiqV3.sol AND the
// ActionAddRemoveLiqV3.sol facet implementation (return orders + revert
// strings). RouterStatic signatures live-verified 2026-07-04 against the
// deployed diamond 0xAdB0…B3E8 on the PLP USDai market (raw eth_call word
// counts + magnitude decoding of EVERY word — see routerStaticLiquidityAbi
// notes; the M3 lesson about tuple asymmetries applied again).
// ---------------------------------------------------------------------------

/**
 * Router V4 liquidity actions (IPActionAddRemoveLiqV3, the v1-scope subset —
 * the SinglePt variants are out of scope and omitted).
 * - Only the non-KeepYt single-sided ADDS take ApproxParams
 *   (guessPtReceivedFromSy — the PT amount bought by the internal swap, NOT
 *   the LP out). KeepYt variants take NO ApproxParams and NO limit: they mint
 *   PY from part of the SY and dual-add, no AMM swap happens.
 * - Single-sided removes to SY/token take a LimitOrderData but no ApproxParams
 *   (exact LP in, PT side is market-sold exact-in).
 * - LimitOrderData is ALWAYS passed empty by us (F11); TokenInput/TokenOutput
 *   follow the M2 rule (SwapType.NONE, pendleSwap = 0, token = mint/redeem sy).
 * - Every function returns its primary output FIRST (netLpOut / netSyOut /
 *   netTokenOut) — simulateAction's firstBigint rule holds.
 * - Dual-add order of operations (facet-verified): the ratio math runs BEFORE
 *   any transferFrom, so an expired market reverts MarketExpired even when the
 *   caller holds no tokens; the token variant reverts 'Slippage:
 *   NOT_ALL_SY_USED' when the wrapped SY overshoots what the ratio can absorb.
 */
export const routerLiquidityAbi = parseAbi([
  'struct SwapData { uint8 swapType; address extRouter; bytes extCalldata; bool needScale; }',
  'struct TokenInput { address tokenIn; uint256 netTokenIn; address tokenMintSy; address pendleSwap; SwapData swapData; }',
  'struct TokenOutput { address tokenOut; uint256 minTokenOut; address tokenRedeemSy; address pendleSwap; SwapData swapData; }',
  'struct ApproxParams { uint256 guessMin; uint256 guessMax; uint256 guessOffchain; uint256 maxIteration; uint256 eps; }',
  'struct Order { uint256 salt; uint256 expiry; uint256 nonce; uint8 orderType; address token; address YT; address maker; address receiver; uint256 makingAmount; uint256 lnImpliedRate; uint256 failSafeRate; bytes permit; }',
  'struct FillOrderParams { Order order; bytes signature; uint256 makingAmount; }',
  'struct LimitOrderData { address limitRouter; uint256 epsSkipMarket; FillOrderParams[] normalFills; FillOrderParams[] flashFills; bytes optData; }',
  // dual adds
  'function addLiquidityDualSyAndPt(address receiver, address market, uint256 netSyDesired, uint256 netPtDesired, uint256 minLpOut) returns (uint256 netLpOut, uint256 netSyUsed, uint256 netPtUsed)',
  'function addLiquidityDualTokenAndPt(address receiver, address market, TokenInput input, uint256 netPtDesired, uint256 minLpOut) payable returns (uint256 netLpOut, uint256 netPtUsed, uint256 netSyInterm)',
  // single-sided adds (zap-in)
  'function addLiquiditySingleSy(address receiver, address market, uint256 netSyIn, uint256 minLpOut, ApproxParams guessPtReceivedFromSy, LimitOrderData limit) returns (uint256 netLpOut, uint256 netSyFee)',
  'function addLiquiditySingleToken(address receiver, address market, uint256 minLpOut, ApproxParams guessPtReceivedFromSy, TokenInput input, LimitOrderData limit) payable returns (uint256 netLpOut, uint256 netSyFee, uint256 netSyInterm)',
  // single-sided adds keeping the YT (no ApproxParams, no limit)
  'function addLiquiditySingleSyKeepYt(address receiver, address market, uint256 netSyIn, uint256 minLpOut, uint256 minYtOut) returns (uint256 netLpOut, uint256 netYtOut, uint256 netSyMintPy)',
  'function addLiquiditySingleTokenKeepYt(address receiver, address market, uint256 minLpOut, uint256 minYtOut, TokenInput input) payable returns (uint256 netLpOut, uint256 netYtOut, uint256 netSyMintPy, uint256 netSyInterm)',
  // dual removes
  'function removeLiquidityDualSyAndPt(address receiver, address market, uint256 netLpToRemove, uint256 minSyOut, uint256 minPtOut) returns (uint256 netSyOut, uint256 netPtOut)',
  'function removeLiquidityDualTokenAndPt(address receiver, address market, uint256 netLpToRemove, TokenOutput output, uint256 minPtOut) returns (uint256 netTokenOut, uint256 netPtOut, uint256 netSyInterm)',
  // single-sided removes (zap-out)
  'function removeLiquiditySingleSy(address receiver, address market, uint256 netLpToRemove, uint256 minSyOut, LimitOrderData limit) returns (uint256 netSyOut, uint256 netSyFee)',
  'function removeLiquiditySingleToken(address receiver, address market, uint256 netLpToRemove, TokenOutput output, LimitOrderData limit) returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)',
])

/**
 * RouterStatic liquidity statics (view; display quotes only — the binding
 * number is always a real-router simulation, PLAN §3.2).
 *
 * ALL 12 liquidity statics are PRESENT on the deployed diamond, including
 * both KeepYt statics (live-probed 2026-07-04, PLP USDai market
 * 0x46f5…46ef: every candidate selector dispatched). Return layouts verified
 * word-by-word against a live pool state where SY.exchangeRate() was exactly
 * 1e18 (PYUSD 6d / SY 18d / PT 18d / LP 18d gives unambiguous magnitudes):
 * - addLiquidityDualSyAndPtStatic(100e18 SY, 100e18 PT) → (68.25e18 LP,
 *   100e18 syUsed, 45.24e18 ptUsed) — matches lp = totalLp·syUsed/totalSy and
 *   the pool's sy:pt ratio exactly;
 * - the single-sided add statics put netPtFromSwap at index 1 (the
 *   guessPtReceivedFromSy seed for ApproxParams synthesis) — cross-checked:
 *   30.21 SY swapped → 31.49 PT at the pool's ~0.959 PT price, remaining
 *   69.79 SY : 31.49 PT sits on the post-swap ratio;
 * - the token variants insert netSyMinted before the trailing swap detail
 *   (index 5 of 7 on add, absent on the Sy sibling) — the M3 asymmetry
 *   pattern again;
 * - KeepYt statics carry NO priceImpact/exchangeRateAfter/netSyFee — honest:
 *   the KeepYt path does no AMM swap (facet-verified: mint PY + dual add), so
 *   price impact is genuinely zero. netYtOut at index 1 (equal to netSyToPY
 *   at 1e18 index in the probe; ordering per IPRouterStatic and re-asserted
 *   by the M4 fork gate's executed YT delta);
 * - remove statics: netSyOut/netTokenOut FIRST, then fee/impact/rate, then
 *   burn/swap breakdown words (netSyFromBurn, netPtFromBurn, netSyFromSwap —
 *   magnitude-matched against removeLiquidityDualSyAndPtStatic of the same
 *   LP amount; netSyOut = netSyFromBurn + netSyFromSwap held exactly).
 * priceImpact is 1e18-scaled; exchangeRateAfter same frame as the M3 swap
 * statics (→ impliedApyAfter formula).
 */
export const routerStaticLiquidityAbi = parseAbi([
  // dual (pure ratio math — no fee/impact fields)
  'function addLiquidityDualSyAndPtStatic(address market, uint256 netSyDesired, uint256 netPtDesired) view returns (uint256 netLpOut, uint256 netSyUsed, uint256 netPtUsed)',
  'function addLiquidityDualTokenAndPtStatic(address market, address tokenIn, uint256 netTokenDesired, uint256 netPtDesired) view returns (uint256 netLpOut, uint256 netTokenUsed, uint256 netPtUsed, uint256 netSyUsed, uint256 netSyDesired)',
  // single-sided adds
  'function addLiquiditySingleSyStatic(address market, uint256 netSyIn) view returns (uint256 netLpOut, uint256 netPtFromSwap, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter, uint256 netSyToSwap)',
  'function addLiquiditySingleTokenStatic(address market, address tokenIn, uint256 netTokenIn) view returns (uint256 netLpOut, uint256 netPtFromSwap, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter, uint256 netSyMinted, uint256 netSyToSwap)',
  // single-sided adds keeping YT (no swap → no fee/impact words)
  'function addLiquiditySingleSyKeepYtStatic(address market, uint256 netSyIn) view returns (uint256 netLpOut, uint256 netYtOut, uint256 netSyToPY)',
  'function addLiquiditySingleTokenKeepYtStatic(address market, address tokenIn, uint256 netTokenIn) view returns (uint256 netLpOut, uint256 netYtOut, uint256 netSyMinted, uint256 netSyToPY)',
  // dual removes (pure pro-rata)
  'function removeLiquidityDualSyAndPtStatic(address market, uint256 netLpToRemove) view returns (uint256 netSyOut, uint256 netPtOut)',
  'function removeLiquidityDualTokenAndPtStatic(address market, uint256 netLpToRemove, address tokenOut) view returns (uint256 netTokenOut, uint256 netPtOut, uint256 netSyToRedeem)',
  // single-sided removes
  'function removeLiquiditySingleSyStatic(address market, uint256 netLpToRemove) view returns (uint256 netSyOut, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter, uint256 netSyFromBurn, uint256 netPtFromBurn, uint256 netSyFromSwap)',
  'function removeLiquiditySingleTokenStatic(address market, uint256 netLpToRemove, address tokenOut) view returns (uint256 netTokenOut, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter, uint256 netSyOut, uint256 netSyFromBurn, uint256 netPtFromBurn, uint256 netSyFromSwap)',
])

// ---------------------------------------------------------------------------
// M5 additions — post-expiry one-click exit surface (IPActionMiscV3 subset).
// Signatures verified verbatim against the scratchpad IPActionMiscV3.sol AND
// the ActionMiscV3.sol facet implementation (2026-07-04):
// - exitPostExpToSy returns ONLY the ExitPostExpReturnParams struct — there
//   is NO leading totalSyOut word (the research digest's shorthand implied
//   one; the verified source does not have it). Selector unaffected (returns
//   don't hash): the digest's fork-captured selectors 0xc2d6d65d (ToSy) /
//   0xf06a07a0 (ToToken) are asserted against these exact encodings by
//   scripts/m5-maturity-test.mjs, and the ToSy struct decode is validated
//   on-fork by simulating and matching params.totalSyOut to the exact
//   client-side preview.
// - Because viem decodes a single-struct return as an OBJECT, txflow's
//   simulateAction yields primaryOut = undefined for exitPostExpToSy (like
//   claim). That is fine: post-expiry exits do no swap, so the binding
//   display number is maturity.ts' exact previewExitPostExp math, not the
//   simulation's return value. exitPostExpToToken returns totalTokenOut
//   first and decodes primaryOut normally.
// - NO ApproxParams, NO LimitOrderData on either variant (nothing to search,
//   no swap happens post-expiry); TokenOutput follows the M2 rule
//   (SwapType.NONE, pendleSwap = 0, tokenRedeemSy = the token itself).
// - Facet-verified order of operations: LP is pulled from msg.sender to the
//   market and burned (PT leg of the burn goes straight to the YT), then any
//   loose netPtIn is pulled to the YT, then ONE YT.redeemPY covers both —
//   hence approvals are LP (= market address) always, PT only when included.
// ---------------------------------------------------------------------------

export const routerExitAbi = parseAbi([
  'struct SwapData { uint8 swapType; address extRouter; bytes extCalldata; bool needScale; }',
  'struct TokenOutput { address tokenOut; uint256 minTokenOut; address tokenRedeemSy; address pendleSwap; SwapData swapData; }',
  'struct ExitPostExpReturnParams { uint256 netPtFromRemove; uint256 netSyFromRemove; uint256 netPtRedeem; uint256 netSyFromRedeem; uint256 totalSyOut; }',
  'function exitPostExpToSy(address receiver, address market, uint256 netPtIn, uint256 netLpIn, uint256 minSyOut) returns (ExitPostExpReturnParams params)',
  'function exitPostExpToToken(address receiver, address market, uint256 netPtIn, uint256 netLpIn, TokenOutput output) returns (uint256 totalTokenOut, ExitPostExpReturnParams params)',
])

// ---------------------------------------------------------------------------
// M6 additions — community pool creation surface (commonDeploy). Verified
// VERBATIM against the Arbiscan-verified PendleCommonPoolDeployHelperV2 /
// PendlePoolDeployHelperV2 sources (scratchpad/pendle) — the @pendle/core-v2
// repo `IPCommonPoolDeployHelperV2` interface is STALE (it omits
// deploy5115MarketAndSeedLiquidity entirely, and its deployCommonMarketById
// lacks the `initData` param the deployed contract takes). Corrections vs the
// stale repo interface are documented in deploy.ts's header and the M6 report.
// ---------------------------------------------------------------------------

/**
 * commonDeploy pool-creation entry point + its emitted event.
 *
 * `deploy5115MarketAndSeedLiquidity(SY, PoolConfig, tokenToSeedLiquidity,
 * amountToSeed)` — the one-tx deploy path. PoolConfig carries the user-friendly
 * band; the contract computes scalarRoot/initialAnchor/lnFeeRateRoot on-chain
 * via MarketDeployLib. `payable`: when the seed token is native ETH the amount
 * rides in `value` (no approval); otherwise the seed token is approved to
 * COMMON_DEPLOY and pulled with transferFrom. Returns PoolDeploymentAddrs
 * {SY, PT, YT, market}.
 *
 * `MarketDeployment(PoolDeploymentAddrs addrs, PoolDeploymentParams params)`
 * — topic0 0xd1f8866e1ab220ea57cc2bc3d029810357a6f6df863760170473f9df5b322ebd
 * (derived from this exact ABI item; asserted in scripts/m6-deploy-test.mjs).
 * NEITHER field is indexed: both structs live entirely in `data`, so a
 * deployer-filtered log scan must filter by the tx sender (recoverDeployments),
 * NOT by an indexed topic.
 */
export const commonDeployPoolAbi = parseAbi([
  'struct PoolConfig { uint32 expiry; uint256 rateMin; uint256 rateMax; uint256 desiredImpliedRate; uint256 fee; }',
  'struct PoolDeploymentAddrs { address SY; address PT; address YT; address market; }',
  'struct PoolDeploymentParams { uint32 expiry; uint80 lnFeeRateRoot; int256 scalarRoot; int256 initialRateAnchor; bool doCacheIndexSameBlock; }',
  'function deploy5115MarketAndSeedLiquidity(address SY, PoolConfig config, address tokenToSeedLiquidity, uint256 amountToSeed) payable returns (PoolDeploymentAddrs)',
  'event MarketDeployment(PoolDeploymentAddrs addrs, PoolDeploymentParams params)',
])

/**
 * Yield-contract-factory duplicate-PT / expiry probes (M6 preflight).
 * `getPT(SY, expiry)` returns address(0) when no PT exists for that (SY,expiry)
 * on this factory (a non-zero result means the deploy will REUSE it — the
 * commonDeploy `_createPYIfNotExist` reuse path). `getYT` mirrors it.
 * `expiryDivisor()` is the live divisor an expiry must be a multiple of
 * (also on yieldContractFactoryAbi — duplicated here so preflight has a single
 * import). Reads return address(0) / a value; they do NOT revert on unknown
 * inputs, so they are multicall-safe with allowFailure.
 */
export const ycfDeployProbeAbi = parseAbi([
  'function getPT(address SY, uint256 expiry) view returns (address)',
  'function getYT(address SY, uint256 expiry) view returns (address)',
  'function expiryDivisor() view returns (uint256)',
])

/**
 * The five creation custom errors decoded into friendly messages by txflow
 * (PLAN §3.4 + M6 checklist). Selectors (viem hashes the signatures):
 * - MarketFactoryMarketExists 0x4a588866 — the scalarRoot/anchor tuple already
 *   has a market (same-timestamp collision / front-run);
 * - YCFactoryInvalidExpiry 0x1f687fd0 — expiry not a future divisor boundary;
 * - MarketFactoryLnFeeRateRootTooHigh(uint80,uint256) 0x163cca2a — creator fee
 *   above the 5% cap (belt-and-braces: preflight blocks this before the tx);
 * - MarketFactoryInitialAnchorTooLow(int256,int256) 0x7b48ef70 — the derived
 *   anchor fell below 1e18 (rate band too wide / launch APY too low);
 * - MarketFactoryInvalidPt / MarketFactoryExpiredPt round out the PT checks.
 * These are ALSO listed in pendleErrorsAbi (the decode table).
 */
export const creationErrorsAbi = parseAbi([
  'error MarketFactoryMarketExists()',
  'error MarketFactoryInvalidPt()',
  'error MarketFactoryExpiredPt()',
  'error MarketFactoryLnFeeRateRootTooHigh(uint80 lnFeeRateRoot, uint256 maxLnFeeRateRoot)',
  'error MarketFactoryInitialAnchorTooLow(int256 initialAnchor, int256 minInitialAnchor)',
  'error YCFactoryYieldContractExisted()',
  'error YCFactoryInvalidExpiry()',
])

// ===========================================================================
// M7 — SY-adapter creation (PendleCommonSYFactory + the SY+market wrappers on
// PendleCommonPoolDeployHelperV2). Appended per file-ownership rules; nothing
// above this line changed.
//
// GROUND TRUTH — every item below is VERIFIED against the Arbiscan-verified
// sources (scratchpad/pendle/PendleCommonSYFactory.sol +
// PendleCommonPoolDeployHelperV2.sol) and the fork-tested 16/16 suite
// (research/fork-tests/SYFactoryFork.t.sol), NOT the stale @pendle/core-v2
// repo interfaces. Corrections vs the stale repo are documented in the M7
// report and syDeploy.ts's header.
// ===========================================================================

/**
 * PendleCommonSYFactory (`syFactory` @ 0x466C…1CF8) — permissionless SY deploys.
 *
 * Entrypoint rule (fork-verified): the 3 BASIC template ids go through
 * `deploySY(id, constructorParams, syOwner)` with
 * `constructorParams = abi.encode(string name, string symbol, address token)`.
 * The 4 UPGRADEABLE/adapter ids go through
 * `deployUpgradableSY(id, constructorParams, initData, syOwner)` with
 * `constructorParams = abi.encode(address token, address rewardManager)` and a
 * non-empty `initData` (empty initData reverts). Both return the freshly
 * deployed SY address.
 *
 * `DeployedSY(bytes32 id, bytes constructorParams, address SY)` — topic0
 * 0x07a80415c524a669398df01e97c487fc00986190468c09e2741b44181c5dc8c3. NONE of
 * the three fields is `indexed` (verbatim from the verified source: the event
 * declares no `indexed` keyword), so every field lives in `data` — the decoder
 * cannot topic-filter beyond topic0.
 */
export const syFactoryAbi = parseAbi([
  'function deploySY(bytes32 id, bytes constructorParams, address syOwner) returns (address SY)',
  'function deployUpgradableSY(bytes32 id, bytes constructorParams, bytes initData, address syOwner) returns (address SY)',
  'function creationCodes(bytes32 id) view returns (address creationCodeContractA, uint256 creationCodeSizeA, address creationCodeContractB, uint256 creationCodeSizeB)',
  'function proxyAdmin() view returns (address)',
  'function nonce() view returns (uint256)',
  'event DeployedSY(bytes32 id, bytes constructorParams, address SY)',
])

/**
 * PendleCommonPoolDeployHelperV2 (`commonDeploy` @ 0x2Ed4…8aA9) — the combined
 * SY + PT/YT + market + seed wrappers. Arg order / tuples confirmed against the
 * Arbiscan-verified source:
 *
 * - basic templates: `deployERC20Market` / `deployERC4626Market` /
 *   `deployERC4626NotRedeemableMarket(bytes constructorParams, PoolConfig,
 *   address tokenToSeed, uint256 amountToSeed, address syOwner)` (the helper
 *   internally calls `deploySY`);
 * - adapter templates: `deployERC20WithAdapterMarket` /
 *   `deployERC4626WithAdapterMarket` /
 *   `deployERC4626NoRedeemWithAdapterMarket(bytes constructorParams, bytes
 *   initData, PoolConfig, …)` (internal `deployUpgradableSY`);
 * - `PendleERC4626NoRedeemNoDepositUpgSY` has NO dedicated wrapper — its
 *   combined flow routes through the generic
 *   `deployCommonMarketById(bytes32 id, bytes constructorParams, bytes initData,
 *   PoolConfig, address, uint256, address)`.
 *
 * The `MarketDeployment(PoolDeploymentAddrs addrs, PoolDeploymentParams params)`
 * event and its `PoolConfig`/`PoolDeploymentAddrs` structs are already declared
 * on `commonDeployPoolAbi` above; the combined-flow decoder REUSES
 * `deploy.ts` `decodeDeploymentResult` for that event. This ABI holds only the
 * SY+market entrypoints M7 adds.
 *
 * STALE-REPO CORRECTION: the repo interface `IPCommonPoolDeployHelperV2` omits
 * the `initData` param on `deployCommonMarketById` and omits the adapter
 * wrappers entirely — this ABI is built from the verified source instead.
 */
export const commonDeploySyMarketAbi = parseAbi([
  'struct PoolConfig { uint32 expiry; uint256 rateMin; uint256 rateMax; uint256 desiredImpliedRate; uint256 fee; }',
  'struct PoolDeploymentAddrs { address SY; address PT; address YT; address market; }',
  'function deployERC20Market(bytes constructorParams, PoolConfig config, address tokenToSeedLiquidity, uint256 amountToSeed, address syOwner) returns (PoolDeploymentAddrs)',
  'function deployERC4626Market(bytes constructorParams, PoolConfig config, address tokenToSeedLiquidity, uint256 amountToSeed, address syOwner) returns (PoolDeploymentAddrs)',
  'function deployERC4626NotRedeemableMarket(bytes constructorParams, PoolConfig config, address tokenToSeedLiquidity, uint256 amountToSeed, address syOwner) returns (PoolDeploymentAddrs)',
  'function deployERC20WithAdapterMarket(bytes constructorParams, bytes initData, PoolConfig config, address tokenToSeedLiquidity, uint256 amountToSeed, address syOwner) returns (PoolDeploymentAddrs)',
  'function deployERC4626WithAdapterMarket(bytes constructorParams, bytes initData, PoolConfig config, address tokenToSeedLiquidity, uint256 amountToSeed, address syOwner) returns (PoolDeploymentAddrs)',
  'function deployERC4626NoRedeemWithAdapterMarket(bytes constructorParams, bytes initData, PoolConfig config, address tokenToSeedLiquidity, uint256 amountToSeed, address syOwner) returns (PoolDeploymentAddrs)',
  'function deployCommonMarketById(bytes32 id, bytes constructorParams, bytes initData, PoolConfig config, address tokenToSeedLiquidity, uint256 amountToSeed, address syOwner) returns (PoolDeploymentAddrs)',
])

/**
 * ERC-4626 detection probe for `probeAsset`. `asset()` + `convertToAssets(1e18)`
 * both succeeding (non-reverting) is the 4626 signal; `previewDeposit` /
 * `previewRedeem` round out the interface check the basic 4626 templates rely on
 * (their constructors call `.asset()` and infinite-approve asset→vault). All are
 * view — multicall-safe with allowFailure (a plain ERC-20 simply fails them).
 */
export const erc4626ProbeAbi = parseAbi([
  'function asset() view returns (address)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
])

/**
 * ERC-20 metadata + FOT screening surface for `probeAsset`. `decimals()` MUST
 * exist (its absence is a hard blocker — the SY templates read token decimals in
 * their constructor). `balanceOf`/`transfer` back the state-override transfer-
 * delta FOT probe (inject a balance via `eth_call` state override, simulate a
 * self-transfer, compare received vs sent); where the RPC rejects overrides the
 * probe degrades to 'unknown'.
 */
export const erc20MetaAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
])
