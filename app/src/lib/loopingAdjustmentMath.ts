/**
 * Pure position and target math for adjusting an existing Morpho PT loop.
 *
 * These helpers deliberately know nothing about Pendle routes or wallet state.
 * Risk-increase output assumes an ideal 1:1 loan-token-to-collateral-value
 * conversion. Risk-reduction output assumes withdrawn collateral can be sold
 * at the Morpho oracle value. An executable compiler must replace those ideal
 * assumptions with fresh, strictly validated route bounds.
 */

const WAD = 10n ** 18n
const ORACLE_PRICE_SCALE = 10n ** 36n
const VIRTUAL_SHARES = 1_000_000n
const VIRTUAL_ASSETS = 1n
const MAX_UINT256 = (1n << 256n) - 1n

export type LoopingAdjustmentMathErrorCode =
  | 'INVALID_INPUT'
  | 'INSOLVENT_POSITION'
  | 'NO_OP'

export class LoopingAdjustmentMathError extends Error {
  readonly code: LoopingAdjustmentMathErrorCode

  constructor(code: LoopingAdjustmentMathErrorCode, message: string) {
    super(message)
    this.name = 'LoopingAdjustmentMathError'
    this.code = code
  }
}

export interface LoopingAdjustmentPositionInput {
  /** The account's current Morpho borrow shares. */
  borrowShares: bigint
  /** The account's current Morpho collateral, in collateral-token base units. */
  collateral: bigint
  /** Accrued Morpho market total from the same pinned snapshot. */
  totalBorrowAssets: bigint
  /** Accrued Morpho market total from the same pinned snapshot. */
  totalBorrowShares: bigint
  /** Morpho oracle price, using Morpho's 1e36 scale. */
  oraclePrice: bigint
}

export interface LoopingAdjustmentPosition {
  kind: 'looping-adjustment-position'
  borrowShares: bigint
  collateral: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
  oraclePrice: bigint
  accruedDebtAssets: bigint
  collateralLoanValue: bigint
  equityAssets: bigint
  /** Rounded up so the UI never understates current leverage. */
  leverageWad: bigint
}

export interface IdealLoopingRiskIncrease {
  kind: 'risk-increase'
  targetLeverageWad: bigint
  /** Maximum ideal-par debt increase that does not exceed the target. */
  additionalBorrowAssets: bigint
  idealPostBorrowAssets: bigint
  idealPostCollateralLoanValue: bigint
  idealPostEquityAssets: bigint
  /** Rounded up and guaranteed not to exceed targetLeverageWad. */
  idealPostLeverageWad: bigint
}

export interface IdealLoopingRiskReduction {
  kind: 'risk-reduction'
  targetLeverageWad: bigint
  /** Remaining shares are rounded down, so the estimate repays at least enough debt. */
  targetRemainingBorrowShares: bigint
  borrowSharesToRepay: bigint
  estimatedRemainingBorrowAssets: bigint
  estimatedDebtAssetsToRepay: bigint
  /** Collateral sale is rounded up to cover the ideal oracle-valued repayment. */
  targetRemainingCollateral: bigint
  collateralToWithdraw: bigint
  idealWithdrawnCollateralLoanValue: bigint
  estimatedRemainingCollateralLoanValue: bigint
  estimatedPostEquityAssets: bigint
  /** Rounded up and guaranteed not to exceed targetLeverageWad. */
  estimatedPostLeverageWad: bigint
}

export type IdealLoopingAdjustment =
  | IdealLoopingRiskIncrease
  | IdealLoopingRiskReduction

function fail(
  code: LoopingAdjustmentMathErrorCode,
  message: string,
): never {
  throw new LoopingAdjustmentMathError(code, message)
}

function assertUint(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) {
    fail('INVALID_INPUT', `${label} must be a uint256 bigint.`)
  }
}

function assertPositiveUint(value: bigint, label: string): void {
  assertUint(value, label)
  if (value === 0n) fail('INVALID_INPUT', `${label} must be positive.`)
}

function checkedUint(value: bigint, label: string): bigint {
  assertUint(value, label)
  return value
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    fail('INVALID_INPUT', 'Adjustment math received an invalid division.')
  }
  if (numerator === 0n) return 0n
  return (numerator + denominator - 1n) / denominator
}

function leverageWad(collateralLoanValue: bigint, debtAssets: bigint): bigint {
  if (collateralLoanValue <= debtAssets) {
    fail('INSOLVENT_POSITION', 'The loop has no positive oracle-valued equity.')
  }
  return ceilDiv(
    collateralLoanValue * WAD,
    collateralLoanValue - debtAssets,
  )
}

function assertTargetLeverageWad(value: bigint): void {
  assertUint(value, 'targetLeverageWad')
  if (value < WAD) {
    fail('INVALID_INPUT', 'Target leverage must be at least 1x.')
  }
}

function assertDerivedPosition(
  position: Readonly<LoopingAdjustmentPosition>,
): void {
  if (position.kind !== 'looping-adjustment-position') {
    fail('INVALID_INPUT', 'The adjustment position snapshot is invalid.')
  }
  assertPositiveUint(position.borrowShares, 'position.borrowShares')
  assertPositiveUint(position.collateral, 'position.collateral')
  assertPositiveUint(position.totalBorrowAssets, 'position.totalBorrowAssets')
  assertPositiveUint(position.totalBorrowShares, 'position.totalBorrowShares')
  assertPositiveUint(position.oraclePrice, 'position.oraclePrice')
  assertPositiveUint(position.accruedDebtAssets, 'position.accruedDebtAssets')
  assertPositiveUint(position.collateralLoanValue, 'position.collateralLoanValue')
  assertPositiveUint(position.equityAssets, 'position.equityAssets')
  assertPositiveUint(position.leverageWad, 'position.leverageWad')
  if (position.borrowShares > position.totalBorrowShares) {
    fail('INVALID_INPUT', 'The adjustment position snapshot is invalid.')
  }
  const shareAssets = checkedUint(
    position.totalBorrowAssets + VIRTUAL_ASSETS,
    'position.virtualBorrowAssets',
  )
  const shareSupply = checkedUint(
    position.totalBorrowShares + VIRTUAL_SHARES,
    'position.virtualBorrowShares',
  )
  const expectedDebt = ceilDiv(
    position.borrowShares * shareAssets,
    shareSupply,
  )
  const expectedValue =
    position.collateral * position.oraclePrice / ORACLE_PRICE_SCALE
  if (
    expectedDebt !== position.accruedDebtAssets ||
    expectedValue !== position.collateralLoanValue ||
    expectedValue <= expectedDebt ||
    position.equityAssets !== expectedValue - expectedDebt ||
    position.leverageWad !== leverageWad(expectedValue, expectedDebt)
  ) {
    fail('INVALID_INPUT', 'The adjustment position snapshot is internally inconsistent.')
  }
}

/** Parse a plain decimal leverage value into exact 18-decimal WAD units. */
export function parseLoopingTargetLeverageWad(value: string): bigint {
  if (typeof value !== 'string') {
    fail('INVALID_INPUT', 'Target leverage must be a decimal string.')
  }
  const cleaned = value.trim()
  if (!/^\d+(?:\.\d*)?$/.test(cleaned)) {
    fail('INVALID_INPUT', 'Target leverage must be a plain decimal number.')
  }
  const [whole, fraction = ''] = cleaned.split('.')
  if (fraction.length > 18) {
    fail('INVALID_INPUT', 'Target leverage supports at most 18 decimal places.')
  }
  const parsed = BigInt(whole) * WAD +
    BigInt(fraction.padEnd(18, '0') || '0')
  assertTargetLeverageWad(parsed)
  return parsed
}

/**
 * Derive one internally consistent position snapshot using Morpho's virtual
 * share conversion and the same oracle scale as the executable compiler.
 */
export function deriveLoopingAdjustmentPosition(
  input: Readonly<LoopingAdjustmentPositionInput>,
): Readonly<LoopingAdjustmentPosition> {
  assertPositiveUint(input.borrowShares, 'borrowShares')
  assertPositiveUint(input.collateral, 'collateral')
  assertPositiveUint(input.totalBorrowAssets, 'totalBorrowAssets')
  assertPositiveUint(input.totalBorrowShares, 'totalBorrowShares')
  assertPositiveUint(input.oraclePrice, 'oraclePrice')
  if (input.borrowShares > input.totalBorrowShares) {
    fail('INVALID_INPUT', 'Account borrow shares exceed accrued market borrow shares.')
  }

  const shareAssets = checkedUint(
    input.totalBorrowAssets + VIRTUAL_ASSETS,
    'virtualBorrowAssets',
  )
  const shareSupply = checkedUint(
    input.totalBorrowShares + VIRTUAL_SHARES,
    'virtualBorrowShares',
  )

  const accruedDebtAssets = checkedUint(ceilDiv(
    input.borrowShares * shareAssets,
    shareSupply,
  ), 'accruedDebtAssets')
  const collateralLoanValue = checkedUint(
    input.collateral * input.oraclePrice / ORACLE_PRICE_SCALE,
    'collateralLoanValue',
  )
  if (collateralLoanValue <= accruedDebtAssets) {
    fail('INSOLVENT_POSITION', 'The loop is at or beyond zero oracle-valued equity.')
  }
  const equityAssets = collateralLoanValue - accruedDebtAssets
  const position = Object.freeze({
    kind: 'looping-adjustment-position',
    borrowShares: input.borrowShares,
    collateral: input.collateral,
    totalBorrowAssets: input.totalBorrowAssets,
    totalBorrowShares: input.totalBorrowShares,
    oraclePrice: input.oraclePrice,
    accruedDebtAssets,
    collateralLoanValue,
    equityAssets,
    leverageWad: checkedUint(
      leverageWad(collateralLoanValue, accruedDebtAssets),
      'leverageWad',
    ),
  } satisfies LoopingAdjustmentPosition)
  return position
}

/**
 * Estimate a debt increase at ideal oracle parity. The final division rounds
 * down, so this ideal estimate cannot exceed the selected leverage target.
 */
export function deriveIdealLoopingRiskIncrease(args: {
  position: Readonly<LoopingAdjustmentPosition>
  targetLeverageWad: bigint
}): Readonly<IdealLoopingRiskIncrease> {
  assertDerivedPosition(args.position)
  assertTargetLeverageWad(args.targetLeverageWad)
  if (args.targetLeverageWad <= args.position.leverageWad) {
    fail('NO_OP', 'Risk increase requires a target above current leverage.')
  }

  const idealPostCollateralLoanValue = checkedUint(
    args.position.equityAssets * args.targetLeverageWad / WAD,
    'idealPostCollateralLoanValue',
  )
  if (idealPostCollateralLoanValue <= args.position.collateralLoanValue) {
    fail('NO_OP', 'Target leverage produces no positive borrow increase.')
  }
  const additionalBorrowAssets =
    idealPostCollateralLoanValue - args.position.collateralLoanValue
  const idealPostBorrowAssets = checkedUint(
    args.position.accruedDebtAssets + additionalBorrowAssets,
    'idealPostBorrowAssets',
  )
  const idealPostLeverageWad = leverageWad(
    idealPostCollateralLoanValue,
    idealPostBorrowAssets,
  )
  if (idealPostLeverageWad > args.targetLeverageWad) {
    fail('INVALID_INPUT', 'Risk-increase rounding exceeded the leverage target.')
  }

  return Object.freeze({
    kind: 'risk-increase',
    targetLeverageWad: args.targetLeverageWad,
    additionalBorrowAssets,
    idealPostBorrowAssets,
    idealPostCollateralLoanValue,
    idealPostEquityAssets:
      idealPostCollateralLoanValue - idealPostBorrowAssets,
    idealPostLeverageWad,
  })
}

/**
 * Estimate a debt-and-collateral reduction at ideal oracle parity.
 *
 * Remaining borrow shares round down. Collateral to withdraw rounds up far
 * enough to cover that ideal oracle-valued repayment. The result is rejected
 * if token granularity would still leave leverage above the selected target.
 */
export function deriveIdealLoopingRiskReduction(args: {
  position: Readonly<LoopingAdjustmentPosition>
  targetLeverageWad: bigint
}): Readonly<IdealLoopingRiskReduction> {
  assertDerivedPosition(args.position)
  assertTargetLeverageWad(args.targetLeverageWad)
  if (args.targetLeverageWad >= args.position.leverageWad) {
    fail('NO_OP', 'Risk reduction requires a target below current leverage.')
  }

  const maximumRemainingDebtAssets = checkedUint(
    args.position.equityAssets * (args.targetLeverageWad - WAD) / WAD,
    'maximumRemainingDebtAssets',
  )
  const shareAssets = checkedUint(
    args.position.totalBorrowAssets + VIRTUAL_ASSETS,
    'virtualBorrowAssets',
  )
  const shareSupply = checkedUint(
    args.position.totalBorrowShares + VIRTUAL_SHARES,
    'virtualBorrowShares',
  )
  const targetRemainingBorrowShares = checkedUint(
    maximumRemainingDebtAssets * shareSupply / shareAssets,
    'targetRemainingBorrowShares',
  )
  if (targetRemainingBorrowShares >= args.position.borrowShares) {
    fail('NO_OP', 'Target leverage produces no positive debt-share repayment.')
  }
  const estimatedRemainingBorrowAssets = targetRemainingBorrowShares === 0n
    ? 0n
    : checkedUint(ceilDiv(
        targetRemainingBorrowShares * shareAssets,
        shareSupply,
      ), 'estimatedRemainingBorrowAssets')
  if (estimatedRemainingBorrowAssets > maximumRemainingDebtAssets) {
    fail('INVALID_INPUT', 'Debt-share rounding exceeded the target debt ceiling.')
  }

  const estimatedDebtAssetsToRepay =
    args.position.accruedDebtAssets - estimatedRemainingBorrowAssets
  if (estimatedDebtAssetsToRepay <= 0n) {
    fail('NO_OP', 'Target leverage produces no positive debt repayment.')
  }
  const collateralToWithdraw = checkedUint(ceilDiv(
    estimatedDebtAssetsToRepay * ORACLE_PRICE_SCALE,
    args.position.oraclePrice,
  ), 'collateralToWithdraw')
  if (
    collateralToWithdraw <= 0n ||
    collateralToWithdraw >= args.position.collateral
  ) {
    fail(
      'INSOLVENT_POSITION',
      'Oracle-par repayment would consume all available collateral.',
    )
  }
  const targetRemainingCollateral =
    args.position.collateral - collateralToWithdraw
  const idealWithdrawnCollateralLoanValue = checkedUint(
    collateralToWithdraw * args.position.oraclePrice / ORACLE_PRICE_SCALE,
    'idealWithdrawnCollateralLoanValue',
  )
  if (idealWithdrawnCollateralLoanValue < estimatedDebtAssetsToRepay) {
    fail('INVALID_INPUT', 'Collateral rounding does not cover the ideal repayment.')
  }
  const estimatedRemainingCollateralLoanValue = checkedUint(
    targetRemainingCollateral * args.position.oraclePrice /
      ORACLE_PRICE_SCALE,
    'estimatedRemainingCollateralLoanValue',
  )
  if (estimatedRemainingCollateralLoanValue <= estimatedRemainingBorrowAssets) {
    fail('INSOLVENT_POSITION', 'Risk reduction would leave no positive equity.')
  }
  const estimatedPostEquityAssets =
    estimatedRemainingCollateralLoanValue - estimatedRemainingBorrowAssets
  const estimatedPostLeverageWad = leverageWad(
    estimatedRemainingCollateralLoanValue,
    estimatedRemainingBorrowAssets,
  )
  if (estimatedPostLeverageWad > args.targetLeverageWad) {
    fail(
      'INVALID_INPUT',
      'Token granularity prevents a conservative estimate at this leverage target.',
    )
  }

  return Object.freeze({
    kind: 'risk-reduction',
    targetLeverageWad: args.targetLeverageWad,
    targetRemainingBorrowShares,
    borrowSharesToRepay:
      args.position.borrowShares - targetRemainingBorrowShares,
    estimatedRemainingBorrowAssets,
    estimatedDebtAssetsToRepay,
    targetRemainingCollateral,
    collateralToWithdraw,
    idealWithdrawnCollateralLoanValue,
    estimatedRemainingCollateralLoanValue,
    estimatedPostEquityAssets,
    estimatedPostLeverageWad,
  })
}

/** Choose the correct ideal adjustment direction for one exact target. */
export function deriveIdealLoopingAdjustment(args: {
  position: Readonly<LoopingAdjustmentPosition>
  targetLeverageWad: bigint
}): Readonly<IdealLoopingAdjustment> {
  assertDerivedPosition(args.position)
  assertTargetLeverageWad(args.targetLeverageWad)
  if (args.targetLeverageWad > args.position.leverageWad) {
    return deriveIdealLoopingRiskIncrease(args)
  }
  if (args.targetLeverageWad < args.position.leverageWad) {
    return deriveIdealLoopingRiskReduction(args)
  }
  fail('NO_OP', 'Target leverage is already the current leverage.')
}
