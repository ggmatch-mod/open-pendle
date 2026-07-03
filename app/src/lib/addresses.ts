/**
 * OpenPendle static address book — Arbitrum One (chain id 42161).
 *
 * Source: PLAN.md Appendix A (verified 2026-07-03 against live contracts).
 * Canonical upstream: `deployments/42161-core.json` in pendle-finance/pendle-core-v2-public.
 *
 * Rule (PLAN §3.2 / F12): hardcode ONLY entry points that are themselves the
 * source of truth. Active factories, expiryDivisor, fee rates and treasury are
 * governance-mutable and MUST be resolved live at runtime (see ProtocolStatus /
 * pendleAbi.ts), never read from this file.
 *
 * All addresses are EIP-55 checksummed.
 */

import type { Address } from 'viem'

export const ARBITRUM_CHAIN_ID = 42161 as const

// ---------------------------------------------------------------------------
// Transaction entry points
// ---------------------------------------------------------------------------

/** Router V4 — all trades/liquidity/exits. Facet proxy; no market allowlist (fork-verified). */
export const ROUTER_V4: Address = '0x888888888889758F76e7103c6CbF23ABbF58F946'

/**
 * PendleCommonPoolDeployHelperV2 ("commonDeploy") — one-tx pool (+ optional SY)
 * deploys. Its public immutables are the live source of truth for the active
 * market factory, yield contract factory, router and syFactory.
 */
export const COMMON_DEPLOY: Address = '0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9'

/** PendleCommonSYFactory — permissionless deploys of Pendle-audited SY templates (7 template ids). */
export const SY_FACTORY: Address = '0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8'

/**
 * ExpiredLpPtRedeemer — rescue path for 7 whitelisted drained legacy markets
 * (non-goal in v1, kept for reference). Note: PLAN.md Appendix A prints this
 * address with incorrect EIP-55 casing; the hex bytes below are identical and
 * the casing is the valid checksum per viem `getAddress`.
 */
export const EXPIRED_LP_PT_REDEEMER: Address = '0x23567b248cd64479384d2E0Cbe83522aFB8DD446'

// ---------------------------------------------------------------------------
// Read / quote helpers
// ---------------------------------------------------------------------------

/** RouterStatic — ~27 quote helpers (eth_call only; fee context unverified, see PLAN F6/F10). */
export const ROUTER_STATIC: Address = '0xAdB09F65bd90d19e3148D9ccb693F3161C6DB3E8'

/** PendlePYLpOracle — TWAP oracle for PT/YT/LP pricing (needs one-time cardinality init per market). */
export const PY_LP_ORACLE: Address = '0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2'

/** Multicall3 — canonical multicall used by viem's `batch: { multicall: true }`. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** PendleMulticallV2 — Pendle's own multicall aggregator. */
export const PENDLE_MULTICALL_V2: Address = '0x539fd510fE352CC81822a222F821c340133Ed41C'

// ---------------------------------------------------------------------------
// Validation sets (PLAN F7): five market-factory generations coexist on
// Arbitrum. `isValidMarket(address)` OR-ed across all 5 factories is the
// paste-validation gate (returns false, never reverts, on junk input).
// The paired yield-contract factories answer `getPT(SY, expiry)` for
// duplicate-PT checks. Order: oldest → newest; the LAST entry is the active
// generation, but the active factory must still be resolved live from
// commonDeploy (F12) — this array is for validation, not for tx routing.
// ---------------------------------------------------------------------------

export interface FactoryGeneration {
  /** Human label for the generation (badge in the UI). */
  gen: 'v1' | 'V3' | 'V4' | 'V5' | 'V6'
  marketFactory: Address
  yieldContractFactory: Address
  /** Notes from the 2026-07-03 research pass. */
  note: string
}

export const FACTORY_GENERATIONS: readonly FactoryGeneration[] = [
  {
    gen: 'v1',
    marketFactory: '0xf5a7De2D276dbda3EEf1b62A9E718EFf4d29dDC8',
    yieldContractFactory: '0x28dE02Ac3c3F5ef427e55c321F73fDc7F192e8E4',
    note: '27 markets, all expired; 1-arg getMarketConfig',
  },
  {
    gen: 'V3',
    marketFactory: '0x2FCb47B58350cD377f94d3821e7373Df60bD9Ced',
    yieldContractFactory: '0xEb38531db128EcA928aea1B1CE9E5609B15ba146',
    note: '40 markets, all expired',
  },
  {
    gen: 'V4',
    marketFactory: '0xd9f5e9589016da862D2aBcE980A5A5B99A94f3E8',
    yieldContractFactory: '0xc7F8F9F1DdE1104664b6fC8F33E49b169C12F41E',
    note: '3 markets, all expired',
  },
  {
    gen: 'V5',
    marketFactory: '0xd29e76c6F15ada0150D10A1D3f45aCCD2098283B',
    yieldContractFactory: '0xFF29e023910FB9bfc86729c1050AF193A45a0C0c',
    note: '52 markets, all expired',
  },
  {
    gen: 'V6',
    marketFactory: '0x49F2f7002669E0e4425Fa0203975625Ab4af3143',
    yieldContractFactory: '0xBA814Bf6E27A6d6baE4a8aC65c8Bc3d8e9B0aaCF',
    note: 'Active generation ("V6", impl V7) — all new pools; upgradeable proxies',
  },
] as const

/** The 5 market factories, for `isValidMarket` paste-validation sweeps (M1). */
export const MARKET_FACTORIES: readonly Address[] = FACTORY_GENERATIONS.map(
  (g) => g.marketFactory,
)

/** The 5 paired yield-contract factories, for `getPT` duplicate checks (M6). */
export const YIELD_CONTRACT_FACTORIES: readonly Address[] = FACTORY_GENERATIONS.map(
  (g) => g.yieldContractFactory,
)

// ---------------------------------------------------------------------------
// Reference addresses (display / defaults only — fee values themselves are
// read live per F12; these constants are never used to compute fees).
// ---------------------------------------------------------------------------

/** Pendle treasury — receives protocol fees automatically (contract-enforced, F3). */
export const PENDLE_TREASURY: Address = '0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6'

/** Pendle governance proxy — the default `syOwner` for wizard-deployed SYs (M7). */
export const PENDLE_GOVERNANCE: Address = '0x2aD631F72fB16d91c4953A7f4260A97C2fE2f31e'

/** PENDLE token (Arbitrum). */
export const PENDLE_TOKEN: Address = '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8'

// ---------------------------------------------------------------------------
// RPC defaults
// ---------------------------------------------------------------------------

/** Default public Arbitrum One RPC; user-overridable via the RPC settings panel. */
export const DEFAULT_RPC_URL = 'https://arb1.arbitrum.io/rpc'

/** localStorage key holding a user-supplied custom RPC URL. */
export const RPC_STORAGE_KEY = 'openpendle.rpc'
