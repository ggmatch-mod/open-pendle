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
