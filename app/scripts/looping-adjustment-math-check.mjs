#!/usr/bin/env node
/** Deterministic, network-free checks for looping adjustment target math. */

import assert from 'node:assert/strict'
import {
  LoopingAdjustmentMathError,
  deriveIdealLoopingAdjustment,
  deriveIdealLoopingRiskIncrease,
  deriveIdealLoopingRiskReduction,
  deriveLoopingAdjustmentPosition,
  parseLoopingTargetLeverageWad,
} from '../src/lib/loopingAdjustmentMath.ts'

const WAD = 10n ** 18n
const ORACLE_PRICE_SCALE = 10n ** 36n

let checks = 0

function check(name, run) {
  run()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

function expectMathError(code, run) {
  assert.throws(
    run,
    (error) =>
      error instanceof LoopingAdjustmentMathError && error.code === code,
  )
}

check('exact decimal leverage parsing uses 18-decimal WAD units', () => {
  assert.equal(parseLoopingTargetLeverageWad('2'), 2n * WAD)
  assert.equal(parseLoopingTargetLeverageWad('1.25'), 1_250_000_000_000_000_000n)
  assert.equal(parseLoopingTargetLeverageWad(' 1. '), WAD)
  assert.equal(
    parseLoopingTargetLeverageWad('3.000000000000000001'),
    3n * WAD + 1n,
  )
})

check('invalid, sub-1x, over-precision, and overflowing leverage fail closed', () => {
  for (const value of ['', '.5', '2e0', '-2', '1.0000000000000000001']) {
    expectMathError('INVALID_INPUT', () => parseLoopingTargetLeverageWad(value))
  }
  expectMathError('INVALID_INPUT', () => parseLoopingTargetLeverageWad('0.999'))
  expectMathError('INVALID_INPUT', () =>
    parseLoopingTargetLeverageWad(`${1n << 256n}`),
  )
})

const exactPosition = deriveLoopingAdjustmentPosition({
  borrowShares: 400n,
  collateral: 1_000n,
  totalBorrowAssets: 999_999_999n,
  totalBorrowShares: 999_000_000n,
  oraclePrice: ORACLE_PRICE_SCALE,
})

check('current position uses virtual shares, accrued debt, oracle value, and upward leverage rounding', () => {
  assert.equal(exactPosition.accruedDebtAssets, 400n)
  assert.equal(exactPosition.collateralLoanValue, 1_000n)
  assert.equal(exactPosition.equityAssets, 600n)
  assert.equal(exactPosition.leverageWad, 1_666_666_666_666_666_667n)
  assert(Object.isFrozen(exactPosition))
})

check('risk increase derives a downward-rounded ideal borrow delta', () => {
  const increase = deriveIdealLoopingRiskIncrease({
    position: exactPosition,
    targetLeverageWad: 2n * WAD,
  })
  assert.equal(increase.kind, 'risk-increase')
  assert.equal(increase.additionalBorrowAssets, 200n)
  assert.equal(increase.idealPostBorrowAssets, 600n)
  assert.equal(increase.idealPostCollateralLoanValue, 1_200n)
  assert.equal(increase.idealPostEquityAssets, 600n)
  assert.equal(increase.idealPostLeverageWad, 2n * WAD)
})

check('risk reduction rounds remaining shares down and collateral sale up', () => {
  const reduction = deriveIdealLoopingRiskReduction({
    position: exactPosition,
    targetLeverageWad: 1_250_000_000_000_000_000n,
  })
  assert.equal(reduction.kind, 'risk-reduction')
  assert.equal(reduction.targetRemainingBorrowShares, 150n)
  assert.equal(reduction.borrowSharesToRepay, 250n)
  assert.equal(reduction.estimatedRemainingBorrowAssets, 150n)
  assert.equal(reduction.estimatedDebtAssetsToRepay, 250n)
  assert.equal(reduction.collateralToWithdraw, 250n)
  assert.equal(reduction.targetRemainingCollateral, 750n)
  assert.equal(reduction.idealWithdrawnCollateralLoanValue, 250n)
  assert.equal(reduction.estimatedRemainingCollateralLoanValue, 750n)
  assert.equal(reduction.estimatedPostEquityAssets, 600n)
  assert.equal(reduction.estimatedPostLeverageWad, 1_250_000_000_000_000_000n)
})

check('1x target estimates full debt repayment without withdrawing all collateral', () => {
  const reduction = deriveIdealLoopingRiskReduction({
    position: exactPosition,
    targetLeverageWad: WAD,
  })
  assert.equal(reduction.targetRemainingBorrowShares, 0n)
  assert.equal(reduction.borrowSharesToRepay, 400n)
  assert.equal(reduction.estimatedRemainingBorrowAssets, 0n)
  assert.equal(reduction.collateralToWithdraw, 400n)
  assert.equal(reduction.targetRemainingCollateral, 600n)
  assert.equal(reduction.estimatedPostLeverageWad, WAD)
})

const roundedPosition = deriveLoopingAdjustmentPosition({
  borrowShares: 301n,
  collateral: 1_000n,
  totalBorrowAssets: 2_999_999n,
  totalBorrowShares: 1_000_000n,
  oraclePrice: 3n * ORACLE_PRICE_SCALE / 2n,
})

check('non-unit share and oracle prices preserve conservative rounding', () => {
  assert.equal(roundedPosition.accruedDebtAssets, 452n)
  assert.equal(roundedPosition.collateralLoanValue, 1_500n)
  assert.equal(roundedPosition.equityAssets, 1_048n)

  const reduction = deriveIdealLoopingRiskReduction({
    position: roundedPosition,
    targetLeverageWad: 1_200_000_000_000_000_000n,
  })
  assert.equal(reduction.targetRemainingBorrowShares, 139n)
  assert.equal(reduction.estimatedRemainingBorrowAssets, 209n)
  assert.equal(reduction.estimatedDebtAssetsToRepay, 243n)
  assert.equal(reduction.collateralToWithdraw, 162n)
  assert.equal(reduction.idealWithdrawnCollateralLoanValue, 243n)
  assert(reduction.estimatedPostLeverageWad <= reduction.targetLeverageWad)
})

check('direction dispatcher returns increases and reductions', () => {
  assert.equal(
    deriveIdealLoopingAdjustment({
      position: exactPosition,
      targetLeverageWad: 2n * WAD,
    }).kind,
    'risk-increase',
  )
  assert.equal(
    deriveIdealLoopingAdjustment({
      position: exactPosition,
      targetLeverageWad: 1_250_000_000_000_000_000n,
    }).kind,
    'risk-reduction',
  )
})

check('invalid, inconsistent, and insolvent positions fail closed', () => {
  expectMathError('INVALID_INPUT', () => deriveLoopingAdjustmentPosition({
    borrowShares: 0n,
    collateral: 1_000n,
    totalBorrowAssets: 1_000n,
    totalBorrowShares: 1_000n,
    oraclePrice: ORACLE_PRICE_SCALE,
  }))
  expectMathError('INVALID_INPUT', () => deriveLoopingAdjustmentPosition({
    borrowShares: 1_001n,
    collateral: 1_000n,
    totalBorrowAssets: 1_000n,
    totalBorrowShares: 1_000n,
    oraclePrice: ORACLE_PRICE_SCALE,
  }))
  expectMathError('INVALID_INPUT', () => deriveLoopingAdjustmentPosition({
    borrowShares: 1n,
    collateral: 1_000n,
    totalBorrowAssets: 1_000n,
    totalBorrowShares: 1_000n,
    oraclePrice: 0n,
  }))
  expectMathError('INVALID_INPUT', () => deriveLoopingAdjustmentPosition({
    borrowShares: 1n,
    collateral: 1_000n,
    totalBorrowAssets: (1n << 256n) - 1n,
    totalBorrowShares: 1_000n,
    oraclePrice: ORACLE_PRICE_SCALE,
  }))
  expectMathError('INSOLVENT_POSITION', () => deriveLoopingAdjustmentPosition({
    borrowShares: 400n,
    collateral: 400n,
    totalBorrowAssets: 999_999_999n,
    totalBorrowShares: 999_000_000n,
    oraclePrice: ORACLE_PRICE_SCALE,
  }))
})

check('wrong-direction and unchanged targets fail as no-ops', () => {
  expectMathError('NO_OP', () => deriveIdealLoopingRiskIncrease({
    position: exactPosition,
    targetLeverageWad: exactPosition.leverageWad,
  }))
  expectMathError('NO_OP', () => deriveIdealLoopingRiskReduction({
    position: exactPosition,
    targetLeverageWad: 2n * WAD,
  }))
  expectMathError('NO_OP', () => deriveIdealLoopingAdjustment({
    position: exactPosition,
    targetLeverageWad: exactPosition.leverageWad,
  }))
})

check('fabricated derived snapshots are rejected', () => {
  expectMathError('INVALID_INPUT', () => deriveIdealLoopingAdjustment({
    position: { ...exactPosition, accruedDebtAssets: 399n },
    targetLeverageWad: 2n * WAD,
  }))
})

console.log(`\n${checks} looping adjustment math checks passed.`)
