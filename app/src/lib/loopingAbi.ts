/**
 * Minimal contract surface used by the reviewed looping markets.
 *
 * Keep this file narrower than the upstream protocol ABIs: executable route
 * data is decoded against these exact shapes before it can be considered for
 * simulation or submission.
 */

import { parseAbi, parseAbiParameters } from 'viem'

export const loopingErc20Abi = parseAbi([
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

export const bundler3Abi = parseAbi([
  'function multicall((address to,bytes data,uint256 value,bool skipRevert,bytes32 callbackHash)[] bundle) payable',
  'function initiator() view returns (address)',
])

export const morphoBlueAbi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct Authorization { address authorizer; address authorized; bool isAuthorized; uint256 nonce; uint256 deadline; }',
  'struct Signature { uint8 v; bytes32 r; bytes32 s; }',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function nonce(address authorizer) view returns (uint256)',
  'function isAuthorized(address authorizer,address authorized) view returns (bool)',
  'function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)',
  'function accrueInterest(MarketParams marketParams)',
  'function repay(MarketParams marketParams,uint256 assets,uint256 shares,address onBehalf,bytes data) returns (uint256 assetsRepaid,uint256 sharesRepaid)',
  'function withdrawCollateral(MarketParams marketParams,uint256 assets,address onBehalf,address receiver)',
  'function setAuthorization(address authorized,bool newIsAuthorized)',
  'function setAuthorizationWithSig(Authorization authorization,Signature signature)',
])

export const generalAdapter1Abi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'function BUNDLER3() view returns (address)',
  'function MORPHO() view returns (address)',
  'function erc20TransferFrom(address token,address receiver,uint256 amount)',
  'function erc20Transfer(address token,address receiver,uint256 amount)',
  'function morphoSupplyCollateral(MarketParams marketParams,uint256 assets,address onBehalf,bytes data)',
  'function morphoBorrow(MarketParams marketParams,uint256 assets,uint256 shares,uint256 minSharePriceE27,address receiver)',
  'function morphoRepay(MarketParams marketParams,uint256 assets,uint256 shares,uint256 maxSharePriceE27,address onBehalf,bytes data)',
  'function morphoWithdrawCollateral(MarketParams marketParams,uint256 assets,address receiver)',
])

export const pendleLoopingRouterAbi = parseAbi([
  'struct SwapData { uint8 swapType; address extRouter; bytes extCalldata; bool needScale; }',
  'struct TokenInput { address tokenIn; uint256 netTokenIn; address tokenMintSy; address pendleSwap; SwapData swapData; }',
  'struct TokenOutput { address tokenOut; uint256 minTokenOut; address tokenRedeemSy; address pendleSwap; SwapData swapData; }',
  'struct ApproxParams { uint256 guessMin; uint256 guessMax; uint256 guessOffchain; uint256 maxIteration; uint256 eps; }',
  'struct Order { uint256 salt; uint256 expiry; uint256 nonce; uint8 orderType; address token; address YT; address maker; address receiver; uint256 makingAmount; uint256 lnImpliedRate; uint256 failSafeRate; bytes permit; }',
  'struct FillOrderParams { Order order; bytes signature; uint256 makingAmount; }',
  'struct LimitOrderData { address limitRouter; uint256 epsSkipMarket; FillOrderParams[] normalFills; FillOrderParams[] flashFills; bytes optData; }',
  'function mintPyFromToken(address receiver,address YT,uint256 minPyOut,TokenInput input) payable returns (uint256 netPyOut,uint256 netSyInterm)',
  'function swapExactTokenForPt(address receiver,address market,uint256 minPtOut,ApproxParams guessPtOut,TokenInput input,LimitOrderData limit) payable returns (uint256 netPtOut,uint256 netSyFee,uint256 netSyInterm)',
  'function swapExactPtForToken(address receiver,address market,uint256 exactPtIn,TokenOutput output,LimitOrderData limit) returns (uint256 netTokenOut,uint256 netSyFee,uint256 netSyInterm)',
  'function redeemSyToToken(address receiver,address SY,uint256 netSyIn,TokenOutput output) returns (uint256 netTokenOut)',
  'function redeemPyToToken(address receiver,address YT,uint256 netPyIn,TokenOutput output) returns (uint256 netTokenOut,uint256 netSyInterm)',
])

export const pendleLoopingMarketAbi = parseAbi([
  'function readTokens() view returns (address SY,address PT,address YT)',
  'function expiry() view returns (uint256)',
])

export const loopingStandardizedYieldAbi = parseAbi([
  'function getTokensIn() view returns (address[] tokens)',
  'function getTokensOut() view returns (address[] tokens)',
  'function exchangeRate() view returns (uint256 res)',
])

export const loopingYieldTokenAbi = parseAbi([
  'function pyIndexStored() view returns (uint256)',
])

export const loopingMulticall3Abi = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
])

export const morphoOracleAbi = parseAbi([
  'function price() view returns (uint256)',
])

/** ABI tuple used by Bundler3 callback hashing. */
export const bundler3CallArrayParameters = parseAbiParameters(
  '(address to,bytes data,uint256 value,bool skipRevert,bytes32 callbackHash)[]',
)

/** Canonical Morpho Blue market-id tuple, in its contract-defined order. */
export const morphoMarketIdParameters = parseAbiParameters(
  'address,address,address,address,uint256',
)
