/**
 * Pure, preview-only planning for a Pendle PT / Morpho looping lifecycle.
 *
 * This module intentionally cannot quote, encode, sign, simulate, or submit a
 * transaction. It turns already-validated discovery data plus a user scenario
 * into a page-friendly checklist. Every value which must come from live chain
 * state or a verified route remains an explicit unresolved finite bound.
 */

import type { Address } from 'viem'
import {
  calculateLoopingScenario,
  type LoopingMarketCandidate,
  type LoopingScenario,
  type LoopingScenarioInput,
} from './looping.ts'

export const LOOPING_PREVIEW_PLAN_VERSION = 1 as const
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60

export interface LoopingPreviewFeatureFlags {
  /** Allows a page to show this inert preview. */
  previewEnabled: boolean
  /** Literal false: this planner is not an execution feature. */
  executionEnabled: false
}

export const DEFAULT_LOOPING_PREVIEW_FEATURE_FLAGS: Readonly<LoopingPreviewFeatureFlags> =
  Object.freeze({
    previewEnabled: true,
    executionEnabled: false,
  })

export class LoopingPreviewValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'LoopingPreviewValidationError'
    this.path = path
  }
}

export interface LoopingTransactionPreviewInput {
  candidate: LoopingMarketCandidate
  scenario: LoopingScenarioInput
  /** Exact loan-token units the user proposes supplying as initial equity. */
  equityAssets: bigint
  /** Unix seconds used for expiry and indexed-state freshness checks. */
  nowUnixSeconds: number
  /** Defaults to five minutes. This is a preview gate, not quote validity. */
  maxMarketStateAgeSeconds?: number
}

export type LoopingSafetyGateStatus = 'pass' | 'blocked' | 'pending'

export type LoopingSafetyGateCode =
  | 'PREVIEW_FEATURE_ENABLED'
  | 'EXECUTION_FEATURE_DISABLED'
  | 'CANDIDATE_IDENTITY_MATCHES'
  | 'MORPHO_MARKET_LISTED'
  | 'PENDLE_MARKET_ACTIVE'
  | 'PENDLE_MARKET_UNEXPIRED'
  | 'HOLDING_PERIOD_WITHIN_MATURITY'
  | 'MORPHO_STATE_CURRENT'
  | 'MORPHO_LIQUIDITY_REPORTED'
  | 'SCENARIO_WITHIN_PROTOCOL_LLTV'
  | 'SCENARIO_WITHIN_CONSERVATIVE_LLTV'
  | 'VERIFIED_CONTRACT_REGISTRY_REQUIRED'
  | 'VERIFIED_ENTRY_ROUTE_REQUIRED'
  | 'VERIFIED_EXIT_ROUTE_REQUIRED'
  | 'FINITE_BOUNDS_REQUIRED'
  | 'PENDING_STATE_SIMULATION_REQUIRED'

export interface LoopingSafetyGate {
  code: LoopingSafetyGateCode
  label: string
  status: LoopingSafetyGateStatus
  /** A non-pass value prevents this preview from becoming executable. */
  blocking: boolean
  detail: string
}

export interface LoopingUnsupportedReason {
  code: LoopingSafetyGateCode
  message: string
}

export interface LoopingExactApprovalIntent {
  policy: 'exact-only'
  token: Address
  tokenSymbol: string
  /** Contract role only; its address must come from a verified chain registry. */
  spenderRole: 'Morpho GeneralAdapter1'
  amount: bigint
  formattedAmount: string
  beforeTransaction: 'entry'
  postcondition: 'user allowance to the verified adapter is zero'
}

export interface LoopingMorphoAuthorizationPair {
  marketId: string
  authorizer: 'connected account'
  operatorRole: 'Morpho GeneralAdapter1'
  sameTransactionRequired: true
  firstAction: 'authorize operator for this account'
  finalAction: 'revoke operator for this account'
  noncePolicy: 'read a fresh Morpho authorization nonce immediately before planning'
  deadlinePolicy: 'use a finite deadline derived immediately before submission'
  postcondition: 'operator is not authorized for this account'
}

export type LoopingFiniteBoundKind = 'minimum' | 'maximum' | 'deadline'

export interface LoopingFiniteBoundPlaceholder {
  key:
    | 'initialMinPtOut'
    | 'loopMinPtOut'
    | 'maxBorrowShares'
    | 'minBorrowSharePriceRay'
    | 'entryQuoteDeadline'
    | 'maxRepayAssets'
    | 'maxRepaySharePriceRay'
    | 'exitMinLoanAssetsOut'
    | 'exitQuoteDeadline'
  label: string
  kind: LoopingFiniteBoundKind
  status: 'unresolved'
  placeholder: string
  source: string
  invariant: string
  /** Makes MAX_UINT, zero-minimum, and unbounded-deadline defaults invalid. */
  unlimitedValueAllowed: false
}

export interface LoopingPreviewStep {
  order: number
  label: string
  detail: string
}

export interface LoopingPlannedTransaction {
  id: 'entry' | 'exit'
  order: 1 | 2
  label: string
  atomicity: 'all actions succeed or the transaction reverts'
  authorization: LoopingMorphoAuthorizationPair
  approvalIntent: LoopingExactApprovalIntent | null
  steps: LoopingPreviewStep[]
  finiteBounds: LoopingFiniteBoundPlaceholder[]
  postconditions: string[]
}

export interface LoopingTransactionPreview {
  version: typeof LOOPING_PREVIEW_PLAN_VERSION
  mode: 'preview-only'
  previewEnabled: boolean
  executionEnabled: false
  executionStatus: 'disabled'
  executionMessage: string
  candidateKey: string
  chainId: number
  marketId: string
  pendleMarket: Address
  collateralToken: Address
  loanToken: Address
  equity: {
    assets: bigint
    formatted: string
    symbol: string
  }
  scenario: LoopingScenario
  safetyGates: LoopingSafetyGate[]
  blockers: LoopingSafetyGate[]
  unsupportedReasons: LoopingUnsupportedReason[]
  summary: string[]
  /** Always ordered entry then exit. Neither item contains executable data. */
  transactions: readonly [LoopingPlannedTransaction, LoopingPlannedTransaction]
}

function fail(path: string, message: string): never {
  throw new LoopingPreviewValidationError(path, message)
}

function safeInteger(value: number, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    return fail(path, `expected a safe integer greater than or equal to ${minimum}`)
  }
  return value
}

function formatExactUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString()
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const remainder = value % scale
  if (remainder === 0n) return whole.toString()
  const fractional = remainder.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}.${fractional}`
}

function gate(
  code: LoopingSafetyGateCode,
  label: string,
  status: LoopingSafetyGateStatus,
  detail: string,
): LoopingSafetyGate {
  return { code, label, status, blocking: status !== 'pass', detail }
}

function pendingBound(
  key: LoopingFiniteBoundPlaceholder['key'],
  label: string,
  kind: LoopingFiniteBoundKind,
  placeholder: string,
  source: string,
  invariant: string,
): LoopingFiniteBoundPlaceholder {
  return {
    key,
    label,
    kind,
    status: 'unresolved',
    placeholder,
    source,
    invariant,
    unlimitedValueAllowed: false,
  }
}

function authorizationPair(marketId: string): LoopingMorphoAuthorizationPair {
  return {
    marketId,
    authorizer: 'connected account',
    operatorRole: 'Morpho GeneralAdapter1',
    sameTransactionRequired: true,
    firstAction: 'authorize operator for this account',
    finalAction: 'revoke operator for this account',
    noncePolicy: 'read a fresh Morpho authorization nonce immediately before planning',
    deadlinePolicy: 'use a finite deadline derived immediately before submission',
    postcondition: 'operator is not authorized for this account',
  }
}

function entryBounds(collateralSymbol: string): LoopingFiniteBoundPlaceholder[] {
  return [
    pendingBound(
      'initialMinPtOut',
      `Minimum ${collateralSymbol} from initial equity`,
      'minimum',
      '<fresh initial-route quote minus the configured slippage tolerance>',
      'fresh, locally decoded and allowlisted Pendle route quote',
      'must be positive and no lower than the user-confirmed quote tolerance',
    ),
    pendingBound(
      'loopMinPtOut',
      `Minimum ${collateralSymbol} from borrowed assets`,
      'minimum',
      '<fresh loop-route quote minus the configured slippage tolerance>',
      'fresh, locally decoded and allowlisted Pendle route quote',
      'must be positive and no lower than the user-confirmed quote tolerance',
    ),
    pendingBound(
      'maxBorrowShares',
      'Maximum Morpho borrow shares',
      'maximum',
      '<finite ceiling above shares observed in pending-state simulation>',
      'current Morpho totals with conservative share rounding',
      'must cap share-price movement without using MAX_UINT',
    ),
    pendingBound(
      'minBorrowSharePriceRay',
      'Minimum borrow share price',
      'minimum',
      '<finite RAY floor paired with maxBorrowShares>',
      'current Morpho totals and the exact requested borrow assets',
      'must cause the entry to revert if debt becomes more expensive than confirmed',
    ),
    pendingBound(
      'entryQuoteDeadline',
      'Entry quote deadline',
      'deadline',
      '<finite timestamp inside the configured quote-validity window>',
      'fresh quote response and current block time',
      'must not be zero, MAX_UINT, or later than the user-confirmed validity window',
    ),
  ]
}

function exitBounds(loanSymbol: string): LoopingFiniteBoundPlaceholder[] {
  return [
    pendingBound(
      'maxRepayAssets',
      `Maximum ${loanSymbol} used to repay`,
      'maximum',
      '<finite ceiling above current debt including an explicit interest buffer>',
      'fresh accrued Morpho position and market totals',
      'must be sufficient for all debt shares but bounded independently of swap output',
    ),
    pendingBound(
      'maxRepaySharePriceRay',
      'Maximum repay share price',
      'maximum',
      '<finite RAY ceiling paired with maxRepayAssets>',
      'fresh accrued Morpho debt shares and market totals',
      'must cause the unwind to revert if accrued debt exceeds the confirmed cap',
    ),
    pendingBound(
      'exitMinLoanAssetsOut',
      `Minimum ${loanSymbol} from selling all withdrawn collateral`,
      'minimum',
      '<fresh full-collateral exit quote minus the configured slippage tolerance>',
      'fresh, locally decoded and allowlisted Pendle route quote',
      'must exceed maxRepayAssets plus the user-confirmed residual-output floor',
    ),
    pendingBound(
      'exitQuoteDeadline',
      'Exit quote deadline',
      'deadline',
      '<finite timestamp inside the configured quote-validity window>',
      'fresh quote response and current block time',
      'must not be zero, MAX_UINT, or later than the user-confirmed validity window',
    ),
  ]
}

/**
 * Build an inert, human-readable lifecycle preview.
 *
 * Even a caller passing malformed JavaScript cannot enable execution here:
 * `executionEnabled: true` is rejected at runtime as well as by TypeScript.
 */
export function buildLoopingTransactionPreview(
  input: LoopingTransactionPreviewInput,
  featureFlags: LoopingPreviewFeatureFlags = DEFAULT_LOOPING_PREVIEW_FEATURE_FLAGS,
): LoopingTransactionPreview {
  if (typeof featureFlags.previewEnabled !== 'boolean') {
    return fail('featureFlags.previewEnabled', 'expected a boolean')
  }
  if (featureFlags.executionEnabled !== false) {
    return fail(
      'featureFlags.executionEnabled',
      'this preview-only module requires executionEnabled to remain false',
    )
  }
  if (typeof input.equityAssets !== 'bigint' || input.equityAssets <= 0n) {
    return fail('input.equityAssets', 'must be a positive bigint in loan-token units')
  }
  const nowUnixSeconds = safeInteger(input.nowUnixSeconds, 'input.nowUnixSeconds', 1)
  const maxMarketStateAgeSeconds = safeInteger(
    input.maxMarketStateAgeSeconds ?? 300,
    'input.maxMarketStateAgeSeconds',
    1,
  )
  if (input.scenario.lltv !== input.candidate.morpho.tuple.lltv) {
    return fail('input.scenario.lltv', 'must equal the selected Morpho market LLTV')
  }

  const { candidate } = input
  const { morpho, pendle } = candidate
  const scenario = calculateLoopingScenario(input.scenario)
  const candidateIdentityMatches =
    pendle.chainId === morpho.chainId &&
    pendle.pt.toLowerCase() === morpho.tuple.collateralToken.toLowerCase()
  const marketStateAge = nowUnixSeconds - morpho.state.timestamp
  const marketStateCurrent =
    marketStateAge >= 0 && marketStateAge <= maxMarketStateAgeSeconds
  const marketUnexpired = pendle.expiry > nowUnixSeconds
  const holdingPeriodEndsAt =
    nowUnixSeconds + input.scenario.holdingPeriodYears * SECONDS_PER_YEAR
  const holdingPeriodWithinMaturity = holdingPeriodEndsAt <= pendle.expiry

  const safetyGates: LoopingSafetyGate[] = [
    gate(
      'PREVIEW_FEATURE_ENABLED',
      'Looping preview feature is enabled',
      featureFlags.previewEnabled ? 'pass' : 'blocked',
      featureFlags.previewEnabled
        ? 'The page may render this inert plan.'
        : 'The preview feature flag is off; the page should not expose this plan.',
    ),
    gate(
      'EXECUTION_FEATURE_DISABLED',
      'Looping execution remains disabled',
      'blocked',
      'This module has no wallet, calldata, quote, signing, simulation, or broadcast capability.',
    ),
    gate(
      'CANDIDATE_IDENTITY_MATCHES',
      'Pendle PT exactly matches Morpho collateral on the same chain',
      candidateIdentityMatches ? 'pass' : 'blocked',
      candidateIdentityMatches
        ? `Chain ${morpho.chainId}; collateral ${morpho.tuple.collateralToken}.`
        : 'Candidate chain or PT/collateral identity does not match.',
    ),
    gate(
      'MORPHO_MARKET_LISTED',
      'Morpho market is officially listed',
      morpho.listed ? 'pass' : 'blocked',
      morpho.listed
        ? 'The discovery API marks this market as listed.'
        : 'Unlisted Morpho tuples remain discoverable but are not supported for execution.',
    ),
    gate(
      'PENDLE_MARKET_ACTIVE',
      'Pendle market is actively listed',
      pendle.pendleStatus === 'active' ? 'pass' : 'blocked',
      pendle.pendleStatus === 'active'
        ? 'Pendle catalog status is active.'
        : 'Inactive or coverage-unknown Pendle markets are preview-only.',
    ),
    gate(
      'PENDLE_MARKET_UNEXPIRED',
      'Pendle market has not expired',
      marketUnexpired ? 'pass' : 'blocked',
      marketUnexpired
        ? `Expiry is ${pendle.expiry}.`
        : `Market expiry ${pendle.expiry} is not after preview time ${nowUnixSeconds}.`,
    ),
    gate(
      'HOLDING_PERIOD_WITHIN_MATURITY',
      'Modeled holding period ends by PT maturity',
      holdingPeriodWithinMaturity ? 'pass' : 'blocked',
      holdingPeriodWithinMaturity
        ? `Modeled horizon ends at Unix time ${Math.floor(holdingPeriodEndsAt)}, no later than maturity ${pendle.expiry}.`
        : `Modeled horizon ends at Unix time ${Math.floor(holdingPeriodEndsAt)}, after PT maturity ${pendle.expiry}.`,
    ),
    gate(
      'MORPHO_STATE_CURRENT',
      'Indexed Morpho state is recent',
      marketStateCurrent ? 'pass' : 'blocked',
      marketStateCurrent
        ? `Indexed state is ${marketStateAge} seconds old.`
        : marketStateAge < 0
          ? 'Indexed state timestamp is in the future.'
          : `Indexed state is ${marketStateAge} seconds old; limit is ${maxMarketStateAgeSeconds}.`,
    ),
    gate(
      'MORPHO_LIQUIDITY_REPORTED',
      'Morpho reports non-zero loan liquidity',
      morpho.state.liquidityAssets > 0n ? 'pass' : 'blocked',
      morpho.state.liquidityAssets > 0n
        ? 'Exact availability must still be re-read and simulated immediately before entry.'
        : 'The indexed market state reports zero available loan assets.',
    ),
    gate(
      'SCENARIO_WITHIN_PROTOCOL_LLTV',
      'Scenario is below protocol LLTV',
      scenario.withinProtocolLltv ? 'pass' : 'blocked',
      scenario.withinProtocolLltv
        ? 'Normalized debt is below the Morpho liquidation threshold.'
        : 'Requested leverage reaches or exceeds the Morpho liquidation threshold.',
    ),
    gate(
      'SCENARIO_WITHIN_CONSERVATIVE_LLTV',
      'Scenario preserves the configured LLTV buffer',
      scenario.withinConservativeLimit ? 'pass' : 'blocked',
      scenario.withinConservativeLimit
        ? 'Normalized debt stays within the scenario conservative limit.'
        : 'Requested leverage exceeds the scenario conservative limit.',
    ),
    gate(
      'VERIFIED_CONTRACT_REGISTRY_REQUIRED',
      'Verified per-chain contract registry is attached',
      'pending',
      'Resolve Morpho, Bundler3, GeneralAdapter1, Pendle Router, and allowlisted external-router addresses from a reviewed registry.',
    ),
    gate(
      'VERIFIED_ENTRY_ROUTE_REQUIRED',
      'Fresh entry route is verified',
      'pending',
      'No opaque API calldata is accepted; every target, token, amount, swap type, and allowance must be decoded and allowlisted.',
    ),
    gate(
      'VERIFIED_EXIT_ROUTE_REQUIRED',
      'Fresh full-unwind route is verified',
      'pending',
      'The exit must cover every current debt share and all supplied collateral using fresh accrued state.',
    ),
    gate(
      'FINITE_BOUNDS_REQUIRED',
      'Every entry and exit bound is finite and quote-backed',
      'pending',
      'All bound fields below are intentionally unresolved; zero minima, MAX_UINT maxima, and unlimited deadlines are forbidden.',
    ),
    gate(
      'PENDING_STATE_SIMULATION_REQUIRED',
      'Complete entry or exit transaction passes pending-state simulation',
      'pending',
      'Simulation must use the connected account, current nonce, current accrued market totals, and the exact final transaction request.',
    ),
  ]

  const exactEquity = formatExactUnits(input.equityAssets, morpho.loanAsset.decimals)
  const approvalIntent: LoopingExactApprovalIntent = {
    policy: 'exact-only',
    token: morpho.tuple.loanToken,
    tokenSymbol: morpho.loanAsset.symbol,
    spenderRole: 'Morpho GeneralAdapter1',
    amount: input.equityAssets,
    formattedAmount: `${exactEquity} ${morpho.loanAsset.symbol}`,
    beforeTransaction: 'entry',
    postcondition: 'user allowance to the verified adapter is zero',
  }

  const entry: LoopingPlannedTransaction = {
    id: 'entry',
    order: 1,
    label: 'Open the loop atomically',
    atomicity: 'all actions succeed or the transaction reverts',
    authorization: authorizationPair(morpho.marketId),
    approvalIntent,
    steps: [
      {
        order: 1,
        label: 'Authorize the adapter',
        detail: `After the separate exact-approval prerequisite for ${approvalIntent.formattedAmount}, begin the entry multicall with a fresh, finite Morpho authorization.`,
      },
      {
        order: 2,
        label: 'Convert initial equity to PT',
        detail: `Transfer exactly ${approvalIntent.formattedAmount}, route it through reviewed contracts, and require initialMinPtOut.`,
      },
      {
        order: 3,
        label: 'Supply initial PT collateral',
        detail: 'Supply only the PT produced by this transaction; do not consume pre-existing wallet PT dust.',
      },
      {
        order: 4,
        label: 'Borrow and add looped PT',
        detail: 'Borrow the scenario debt under paired share-price bounds, convert it under loopMinPtOut, and supply the resulting PT.',
      },
      {
        order: 5,
        label: 'Settle residue and revoke',
        detail: 'Add remaining transaction-created PT to collateral, return other token residue, clear temporary allowances, and revoke Morpho authorization.',
      },
    ],
    finiteBounds: entryBounds(morpho.collateralAsset.symbol),
    postconditions: [
      'position collateral includes every PT produced by the transaction and is not below the confirmed floor',
      'debt shares do not exceed maxBorrowShares',
      'user loan-token allowance to GeneralAdapter1 is zero',
      'GeneralAdapter1 is no longer authorized on Morpho for the account',
      'Bundler and adapter token residue and temporary router allowances are zero',
    ],
  }

  const exit: LoopingPlannedTransaction = {
    id: 'exit',
    order: 2,
    label: 'Fully unwind in a separate transaction',
    atomicity: 'all actions succeed or the transaction reverts',
    authorization: authorizationPair(morpho.marketId),
    approvalIntent: null,
    steps: [
      {
        order: 1,
        label: 'Refresh the complete position',
        detail: 'Read accrued market totals plus the account’s exact collateral and debt shares; do not reuse entry-time values.',
      },
      {
        order: 2,
        label: 'Authorize the adapter',
        detail: 'Begin the exit multicall with a new finite Morpho authorization; entry authorization must not persist.',
      },
      {
        order: 3,
        label: 'Withdraw and sell all collateral',
        detail: 'Use the atomic repay callback path to withdraw the complete position collateral and require exitMinLoanAssetsOut.',
      },
      {
        order: 4,
        label: 'Repay every debt share',
        detail: 'Repay the full current share balance under maxRepayAssets and maxRepaySharePriceRay, including bounded accrued interest.',
      },
      {
        order: 5,
        label: 'Sweep residue and revoke',
        detail: 'Return remaining loan assets and transaction-created PT, clear temporary allowances, and revoke authorization as the final action.',
      },
    ],
    finiteBounds: exitBounds(morpho.loanAsset.symbol),
    postconditions: [
      'account collateral and debt shares are both zero',
      'GeneralAdapter1 is no longer authorized on Morpho for the account',
      'user loan-token allowance to GeneralAdapter1 is zero',
      'Bundler and adapter token residue and temporary router allowances are zero',
      'pre-existing wallet PT is preserved and transaction-created residue is returned',
    ],
  }

  const blockers = safetyGates.filter((item) => item.blocking)
  return {
    version: LOOPING_PREVIEW_PLAN_VERSION,
    mode: 'preview-only',
    previewEnabled: featureFlags.previewEnabled,
    executionEnabled: false,
    executionStatus: 'disabled',
    executionMessage:
      'Preview only. OpenPendle cannot quote, sign, encode, simulate, or submit this plan.',
    candidateKey: candidate.key,
    chainId: morpho.chainId,
    marketId: morpho.marketId,
    pendleMarket: pendle.market,
    collateralToken: morpho.tuple.collateralToken,
    loanToken: morpho.tuple.loanToken,
    equity: {
      assets: input.equityAssets,
      formatted: approvalIntent.formattedAmount,
      symbol: morpho.loanAsset.symbol,
    },
    scenario,
    safetyGates,
    blockers,
    unsupportedReasons: blockers.map((item) => ({
      code: item.code,
      message: item.detail,
    })),
    summary: [
      `Preview ${scenario.collateralExposure.toFixed(2)}x gross PT exposure from ${approvalIntent.formattedAmount}.`,
      'Entry and exit are separate atomic multicalls, and each carries its own authorize-then-revoke pair.',
      'Every quote, share-price cap, repayment cap, deadline, contract address, and simulation is unresolved until refreshed live.',
      'Execution is disabled even when all static market and scenario checks pass.',
    ],
    transactions: [entry, exit],
  }
}
