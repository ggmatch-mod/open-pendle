import type { Address } from 'viem'

// Shared M1 contracts. Both the data layer (lib/) and the UI (components/, pages/)
// code against these types — change them only with both sides in view.
// Erasable TypeScript only in lib/ (no enums/namespaces): the acceptance sweep
// script imports these modules under `node --experimental-strip-types`.

/**
 * M8 multi-network: the chains OpenPendle supports (all verified to have Pendle
 * V2 deployed with RouterStatic + commonDeploy — see docs/research/
 * multichain-addresses.md). Every per-chain address book is keyed by these ids.
 */
export type SupportedChainId =
  | 1 // Ethereum
  | 56 // BNB Smart Chain
  | 143 // Monad
  | 8453 // Base
  | 9745 // Plasma
  | 42161 // Arbitrum (the original single-chain build)

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
  /** M8: the network this pool lives on. Pools are keyed by (chainId, market). */
  chainId: SupportedChainId
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

// ---------------------------------------------------------------------------
// M3 contracts — PT/YT trading
// ---------------------------------------------------------------------------

/** On-chain ApproxParams struct for the router's guess search. */
export interface ApproxParamsStruct {
  guessMin: bigint
  guessMax: bigint
  guessOffchain: bigint
  maxIteration: bigint
  eps: bigint
}

export interface SwapQuote {
  /** Expected out, raw units of the out asset (PT/YT at assetDecimals; tokens at their own). */
  amountOut: bigint
  /** Fraction, e.g. 0.0012 = 0.12%. */
  priceImpact: number
  /** Post-trade implied APY (fraction), when derivable from exchangeRateAfter. */
  impliedApyAfter?: number
  /** Swap fee taken by the market, in SY units. */
  netSyFee: bigint
  /**
   * Synthesized ApproxParams for buy directions (guessOffchain = static
   * quote, slippage-scaled guessMin, +5% guessMax headroom). null → caller
   * uses createDefaultApproxParams. Sell directions take no ApproxParams
   * (exact-in, no search).
   */
  approx: ApproxParamsStruct | null
  /** KeepYt zap-ins only: the YT amount the user keeps alongside LP. */
  ytOut?: bigint
}

// ---------------------------------------------------------------------------
// M4 contracts — liquidity
// ---------------------------------------------------------------------------

/**
 * Dual-sided add preview — pure ratio math, no swap, no price impact.
 * Amounts are raw units (SY at sy.decimals, PT at assetDecimals; when the
 * pay side is a token, tokenAmount is the token's raw input that wraps to
 * syDesired).
 */
export interface DualAddPreview {
  syDesired: bigint
  ptDesired: bigint
  /** Estimated LP out: totalLp × syDesired / totalSy (pro-rata; no swap). */
  lpOutEstimate: bigint
  /** User's pool share after the add, 0..1. */
  shareOfPoolAfter: number
}

/** Dual-sided remove preview — pro-rata burn, no swap. */
export interface DualRemovePreview {
  syOut: bigint
  ptOut: bigint
  /** Share of pool being burned, 0..1. */
  shareBurned: number
}

// ---------------------------------------------------------------------------
// M5 contracts — matured markets
// ---------------------------------------------------------------------------

/**
 * Post-expiry one-click exit preview (exitPostExpToSy/Token): LP burns
 * pro-rata, the PT leg (from the burn + any loose PT included) redeems at
 * pyIndex — no swap anywhere, so this is exact math, not an estimate.
 */
export interface ExitPostExpPreview {
  syFromLpBurn: bigint
  ptFromLpBurn: bigint
  /** Loose PT the user chose to fold into the exit. */
  ptIncluded: bigint
  /** SY from redeeming (ptFromLpBurn + ptIncluded) at pyIndex. */
  syFromPtRedeem: bigint
  totalSyOut: bigint
  /** pyIndex used (max(SY.exchangeRate, YT.pyIndexStored), 1e18). */
  pyIndex: bigint
}

/**
 * Depeg guard for matured markets: pyIndex is max()-guarded and
 * non-decreasing, so when the SY's live exchangeRate has fallen BELOW the
 * stored index, each PT still redeems 1 accounting asset's worth of SY *at
 * the stored index* — but that SY is worth less than 1 asset when unwrapped.
 */
export interface DepegInfo {
  syExchangeRate: bigint
  pyIndexStored: bigint
  /** True when syExchangeRate < pyIndexStored (redemption output impaired). */
  depegged: boolean
  /**
   * True only when BOTH sub-reads (SY.exchangeRate + YT.pyIndexStored)
   * succeeded, so `depegged` reflects a real comparison. When false the depeg
   * status is UNKNOWN (a probe was unreadable or a multicall leg dropped) and
   * `depegged` is forced false — the banner distinguishes "not depegged" from
   * "couldn't check" and never fires on unknown.
   */
  rateKnown: boolean
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

// ---------------------------------------------------------------------------
// M6 contracts — community pool creation (commonDeploy.deploy5115MarketAndSeedLiquidity)
// ---------------------------------------------------------------------------

/**
 * User-friendly market config. All rates are 1e18-scaled APYs. The contract
 * derives scalarRoot/initialAnchor/lnFeeRateRoot from this on-chain (via
 * MarketDeployLib) — we mirror the math client-side ONLY for preview/education.
 */
export interface PoolConfig {
  /** unix seconds (uint32). Must be future AND % expiryDivisor == 0 (read live). */
  expiry: number
  /** lower edge of the implied-APY band (e.g. 0.02e18). */
  rateMin: bigint
  /** upper edge, strictly > rateMin. */
  rateMax: bigint
  /** launch implied APY, strictly inside (rateMin, rateMax). */
  desiredImpliedRate: bigint
  /** rate-terms fee (e.g. 0.008e18); lnFeeRateRoot = ln(1+fee) must be ≤ ln(1.05). */
  fee: bigint
}

/** Client-side mirror of MarketDeployLib output — DISPLAY ONLY (the tx recomputes on-chain). */
export interface DerivedDeployParams {
  scalarRoot: bigint
  initialAnchor: bigint
  lnFeeRateRoot: bigint
  /** launch PT proportion 0..1 (float, for the education visual). */
  initialProportion: number
  yearsToExpiry: number
}

export interface DeployPreflight {
  /** true only when all hard checks pass AND the eth_call simulation succeeds. */
  ok: boolean
  errors: string[] // hard blocks (bad expiry, rateMax≤rateMin, fee>cap, desired outside band, sim revert…)
  warnings: string[] // non-blocking (PT already exists on active YCF → reused; parallel legacy PT…)
  syValid: boolean
  ptExistsOnActive: boolean
  existingPt?: Address
  /** PTs for the same (SY,expiry) on OLDER factory generations — informational. */
  legacyParallelPts: { gen: string; pt: Address }[]
  derived?: DerivedDeployParams
  simulated: boolean
  simulationError?: string
  /**
   * True when the binding simulation could not run only because the seed token
   * is an ERC20/SY not yet approved to COMMON_DEPLOY (the expected pre-approval
   * state). The advisory sim revert is then NOT a config failure — the UI can
   * still reach Approve → Deploy (FIX A). Native ETH and already-approved tokens
   * leave this false; a genuine revert (bad config, insufficient balance) also
   * leaves it false so the error surfaces normally.
   */
  simulationPendingApproval?: boolean
}

/** Parsed from the commonDeploy MarketDeployment event / a recovery scan. */
export interface DeployResult {
  market: Address
  sy: Address
  pt: Address
  yt: Address
}

// ---------------------------------------------------------------------------
// M7 contracts — SY adapter creation (syFactory / commonDeploy combined flows)
// ---------------------------------------------------------------------------

/**
 * The registered Pendle SY templates OpenPendle offers. v1 leads with the 3
 * basic templates (deploySY / commonDeploy combined market wrappers); the
 * adapter/upgradeable ids are the advanced path (deployUpgradableSY).
 */
export type SyTemplateId =
  | 'erc20' // PendleERC20SY — plain ERC-20, 1:1
  | 'erc4626' // PendleERC4626SYV2 — ERC-4626 vault
  | 'erc4626-not-redeemable' // PendleERC4626NotRedeemableToAssetSYV2
  | 'erc20-adapter' // PendleERC20WithAdapterSY (advanced)
  | 'erc4626-adapter' // PendleERC4626WithAdapterSY (advanced)
  | 'erc4626-noredeem-adapter' // PendleERC4626NoRedeemWithAdapterSY (advanced)
  | 'erc4626-noredeem-nodeposit' // PendleERC4626NoRedeemNoDepositUpgSY (advanced)

/** Risk verdict for a screened token class. */
export type ScreenVerdict = 'ok' | 'suspected' | 'unknown'

/** Result of probing an asset to suggest a template + screen for broken-token classes. */
export interface AssetProbe {
  address: Address
  symbol: string
  decimals: number
  /** True when the asset implements ERC-4626 (asset()/convertToAssets probe). */
  isErc4626: boolean
  /** For ERC-4626, the underlying .asset(). */
  underlying?: Address
  underlyingSymbol?: string
  /** Suggested template from the probe (4626 → erc4626; plain ERC-20 → erc20). */
  suggested: SyTemplateId
  /** Fee-on-transfer suspicion (transfer-delta / denylist). FOT tokens must be blocked (fork-verified: they under-collateralize). */
  feeOnTransfer: ScreenVerdict
  /** Rebasing suspicion (denylist of known classes, e.g. aTokens). Rebasing breaks SY accounting. */
  rebasing: ScreenVerdict
  /** Human-readable screening notes / disclosures. */
  notes: string[]
  /** Non-empty → a hard block (deploy disabled unless explicitly overridden). */
  blockers: string[]
}

/** Config for deploying an SY (and optionally its market in the same tx). */
export interface SyDeployConfig {
  template: SyTemplateId
  /** The yield token (ERC-20) or the ERC-4626 vault. */
  asset: Address
  /** SY name — convention "SY <asset name>". */
  name: string
  /** SY symbol — convention "SY-<asset symbol>". */
  symbol: string
  /** Owner of the deployed SY. Default = Pendle governance (can pause; adapter SYs' owner can setAdapter). */
  syOwner: Address
  /** Advanced adapter templates only: a pre-deployed IStandardizedYieldAdapter (address(0) = plain 1:1 wrapper). */
  adapter?: Address
}

/** Result of an SY deploy — sy always; market/pt/yt set for the combined SY+market flow. */
export interface SyDeployResult {
  sy: Address
  market?: Address
  pt?: Address
  yt?: Address
}
