import type { Address } from 'viem'

// Shared M1 contracts. Both the data layer (lib/) and the UI (components/, pages/)
// code against these types — change them only with both sides in view.
// Erasable TypeScript only in lib/ (no enums/namespaces): the acceptance sweep
// script imports these modules under `node --experimental-strip-types`.

export type Vintage = 'v1' | 'V3' | 'V4' | 'V5' | 'active' | 'unvalidated'

export interface MarketValidation {
  isMarket: boolean
  factory?: Address
  vintage?: Vintage
}

export type AddressKind = 'market' | 'pt' | 'yt' | 'sy' | 'contract' | 'eoa' | 'invalid'

export interface AddressClassification {
  kind: AddressKind
  /** Short user-facing explanation, e.g. "This looks like a PT — paste the market (PLP) address instead." */
  message: string
  symbol?: string
  /** Set when kind === 'market'. */
  validation?: MarketValidation
  /** Best-effort resolved market for pt/yt/sy near-misses (may be absent). */
  resolvedMarket?: Address
  /** Address has code and answers readTokens() but no known factory validates it — possibly a newer factory generation than this build knows, or a fake. */
  unvalidatedMarketShape?: boolean
}

export interface SyInfo {
  address: Address
  name: string
  symbol: string
  decimals: number
  assetType: number
  assetAddress: Address
  assetDecimals: number
  assetSymbol?: string
  yieldToken: Address
  tokensIn: Address[]
  tokensOut: Address[]
  /** 1e18-scaled SY -> accounting asset. */
  exchangeRate: bigint
}

export interface MarketStateSnapshot {
  totalPt: bigint
  totalSy: bigint
  totalLp: bigint
  treasury: Address
  scalarRoot: bigint
  lnFeeRateRoot: bigint
  reserveFeePercent: bigint
  lastLnImpliedRate: bigint
}

export interface TrustInfo {
  syOwner?: Address
  syPaused?: boolean
  syIsProxy: boolean
  syProxyAdmin?: Address
  ownerIsPendleGovernance?: boolean
  /** True when owner() is the zero address — nobody can pause this SY. */
  ownerIsRenounced?: boolean
  adminIsPendleProxyAdmin?: boolean
  notes: string[]
}

export interface MarketMetrics {
  /** 0.05 = 5% APY, from e^(lastLnImpliedRate/1e18) - 1. */
  impliedApy: number
  /** PT price in accounting-asset terms (0..1; exactly 1 post-expiry). */
  ptPriceAsset: number
  ptPriceSy: number
  /** 1 - ptPriceAsset. */
  ytPriceAsset: number
  /** Pool TVL in accounting-asset units (human number, decimals applied). */
  tvlAsset: number
  /** Rate-terms fee tier, 0.008 = 0.8%, from expm1(lnFeeRateRoot/1e18). */
  feeTier: number
  /** PT proportion of the pool, 0..1 (cap at trade time is 0.96). */
  ptProportion: number
  /** True when the pool is pinned near its immutable rate-band edge. */
  nearRangeEdge: boolean
}

export interface MarketSnapshot {
  address: Address
  pt: Address
  yt: Address
  sy: SyInfo
  ptSymbol: string
  ytSymbol: string
  /** Human name; composed from SY symbol + expiry for legacy vintages whose name() is generic. */
  displayName: string
  /** Unix seconds. */
  expiry: number
  isExpired: boolean
  factory: Address
  /**
   * True only when validateMarket (our own isValidMarket calls across the 5
   * known factories) recognized this address. NEVER derived from the market's
   * self-reported factory() — that claim is attacker-controlled.
   */
  validated: boolean
  vintage: Vintage
  state: MarketStateSnapshot
  metrics: MarketMetrics
  trust: TrustInfo
  /** Human-readable probe failures — non-empty means best-effort/degraded rendering (legacy markets). */
  degraded: string[]
}

export interface SavedPool {
  chainId: 42161
  market: Address
  savedAt: number
  // Display cache only — re-verified on load, never trusted for tx building.
  label: string
  sy: Address
  pt: Address
  yt: Address
  expiry: number
  factory: Address
  // Cached for the home-grid registry sweep (TVL needs asset decimals without
  // a per-card full snapshot load). Optional: pools saved before these fields
  // existed simply render without TVL. Schema stays version 1 (unreleased).
  assetDecimals?: number
  assetSymbol?: string
}

export type QueryStatus = 'idle' | 'loading' | 'error' | 'success'

// ---------------------------------------------------------------------------
// M2 contracts — positions & transaction flows
// ---------------------------------------------------------------------------

/** address(0) denotes native ETH throughout (matches SY tokensIn convention). */
export interface TokenAmount {
  token: Address
  amount: bigint
  symbol: string
  decimals: number
}

export interface Positions {
  user: Address
  pt: bigint
  yt: bigint
  lp: bigint
  sy: bigint
  /** Wallet balances of the SY's tokensIn (wrap sources), incl. native ETH when listed. */
  walletTokens: TokenAmount[]
  /** Claimable YT interest, denominated in SY units. */
  ytClaimableInterestSy: bigint
  ytClaimableRewards: TokenAmount[]
  lpClaimableRewards: TokenAmount[]
  syClaimableRewards: TokenAmount[]
  /** Probe failures — render what loaded, note what didn't. */
  degraded: string[]
}

export interface ApprovalNeed {
  token: Address
  spender: Address
  amount: bigint
  symbol: string
  decimals: number
}

/** viem writeContract-shaped call; `value` set for native-ETH deposits. */
export interface PlannedCall {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[]
  value?: bigint
}

export interface ActionPlan {
  /** Short human description, e.g. "Wrap 100 USDai into SY-USDai". */
  describe: string
  /** ERC-20 approvals required before `call` can succeed (native ETH → none). */
  approvals: ApprovalNeed[]
  call: PlannedCall
  /** Indicative expected output (pre-simulation), display only. */
  indicativeOut?: TokenAmount
}

/**
 * approve → simulate → confirm lifecycle (PLAN §3.2). Quotes shown before
 * approval are indicative; the binding number comes from simulation, which
 * gates the confirm button.
 */
export type TxPhase =
  | 'idle'
  | 'needs-wallet'
  | 'wrong-network'
  | 'checking'
  | 'needs-approval'
  | 'approving'
  | 'simulating'
  | 'ready'
  | 'signing'
  | 'pending'
  | 'confirmed'
  | 'failed'
