import type { LoopingMarketCandidate } from './looping'

/** New borrowing is intentionally disabled below this API-reported depth. */
export const LOOPING_MIN_BORROW_LIQUIDITY_USD = 100

/** Match the existing one-hour indexed-state freshness boundary used by the directory. */
export const LOOPING_LIQUIDITY_MAX_AGE_SECONDS = 60 * 60

const CLOCK_SKEW_TOLERANCE_SECONDS = 5 * 60

export type LoopingRiskIncreaseEligibility =
  | { eligible: true }
  | {
      eligible: false
      reason:
        | 'expired'
        | 'liquidity-unavailable'
        | 'liquidity-too-low'
        | 'state-stale'
      message: string
    }

function formatLiquidity(value: number): string {
  return value.toLocaleString('en-US', {
    maximumFractionDigits: value < 10 ? 2 : 0,
  })
}

/**
 * API data is an entry/risk-increase gate only. Callers must never apply this
 * result to a leverage reduction, full exit, or permission recovery.
 */
export function evaluateLoopingRiskIncreaseEligibility(
  candidate: Pick<LoopingMarketCandidate, 'morpho' | 'pendle'>,
  nowUnixSeconds = Math.floor(Date.now() / 1_000),
): LoopingRiskIncreaseEligibility {
  if (candidate.pendle.expiry <= nowUnixSeconds) {
    return {
      eligible: false,
      reason: 'expired',
      message: 'This PT has matured, so new borrowing and leverage increases are disabled.',
    }
  }

  const liquidityUsd = candidate.morpho.state.liquidityAssetsUsd
  if (liquidityUsd === null || !Number.isFinite(liquidityUsd)) {
    return {
      eligible: false,
      reason: 'liquidity-unavailable',
      message: `Fresh Morpho borrow-liquidity data is required for new borrowing (minimum $${LOOPING_MIN_BORROW_LIQUIDITY_USD}).`,
    }
  }

  const stateAge = nowUnixSeconds - candidate.morpho.state.timestamp
  if (
    !Number.isSafeInteger(candidate.morpho.state.timestamp) ||
    stateAge < -CLOCK_SKEW_TOLERANCE_SECONDS ||
    stateAge > LOOPING_LIQUIDITY_MAX_AGE_SECONDS
  ) {
    return {
      eligible: false,
      reason: 'state-stale',
      message: `The Morpho borrow-liquidity reading is stale. Refresh it before new borrowing; reductions and full exit remain available.`,
    }
  }

  if (
    liquidityUsd < LOOPING_MIN_BORROW_LIQUIDITY_USD ||
    candidate.morpho.state.liquidityAssets <= 0n
  ) {
    return {
      eligible: false,
      reason: 'liquidity-too-low',
      message: `Morpho currently reports $${formatLiquidity(liquidityUsd)} available to borrow; new borrowing requires at least $${LOOPING_MIN_BORROW_LIQUIDITY_USD}.`,
    }
  }

  return { eligible: true }
}
