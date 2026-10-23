/** Pure sizing and economics for matching a Hyperliquid BTC perp to Boros. */

import type { BorosHedgeMarket, BorosHedgeQuote } from './boros.ts'
import type { HyperliquidBtcPosition } from './hyperliquid.ts'

const X18 = 10n ** 18n
const YEAR_SECONDS = 365 * 24 * 60 * 60
const MIN_TERM_SECONDS = 24 * 60 * 60

export interface FundingHedgePlan {
  position: HyperliquidBtcPosition
  market: BorosHedgeMarket
  side: 'long' | 'short'
  hedgeRatioBps: number
  sizeYu: number
  sizeX18: string
  hedgedNotionalUsd: number
  uncoveredNotionalUsd: number
  bestExecutableApr: number
  bookSpreadApr: number | null
  termSeconds: number
  termYears: number
}

export interface FundingHedgeEconomics {
  fullFill: boolean
  fillRatio: number
  matchedYu: number
  hedgedNotionalUsd: number
  uncoveredNotionalUsd: number
  fixedApr: number
  netFixedApr: number | null
  currentFloatingApr: number
  fixedTermCashflowUsd: number
  currentFloatingTermCashflowUsd: number
  comparisonToCurrentUsd: number | null
  takerFeeUsd: number | null
  settlementFeeUsd: number
  totalFeeUsd: number | null
  marginRequiredCollateral: number
  marginRequiredUsd: number
  executionVsBestApr: number
}

function decimalTextToX18(value: string): bigint {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error('Position size is not a supported decimal value')
  }
  const [whole, fraction = ''] = normalized.split('.')
  const fractionX18 = `${fraction}000000000000000000`.slice(0, 18)
  return BigInt(whole) * X18 + BigInt(fractionX18)
}

export function x18ToNumber(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('Invalid 18-decimal value')
  return Number(BigInt(value)) / Number(X18)
}

export function recommendedBorosMarkets(
  position: HyperliquidBtcPosition,
  markets: readonly BorosHedgeMarket[],
  now = Math.floor(Date.now() / 1_000),
): BorosHedgeMarket[] {
  const side = position.direction
  return markets
    .filter((market) => {
      const executableApr = side === 'long' ? market.bestAskApr : market.bestBidApr
      return market.status === 2 && executableApr !== null && market.maturity - now >= MIN_TERM_SECONDS
    })
    .sort((a, b) => {
      // Prefer the nearer roll date, then the best displayed executable rate.
      // Stable collateral remains visible as a convenience alternative; it is
      // not silently preferred when its live fixed rate is worse.
      if (a.maturity !== b.maturity) return a.maturity - b.maturity
      const aRate = position.direction === 'long' ? a.bestAskApr : a.bestBidApr
      const bRate = position.direction === 'long' ? b.bestAskApr : b.bestBidApr
      if (aRate !== bRate) {
        return position.direction === 'long'
          ? Number(aRate) - Number(bRate)
          : Number(bRate) - Number(aRate)
      }
      if (a.collateral.unit !== b.collateral.unit) return a.collateral.unit === 'usd' ? -1 : 1
      const aOiUsd = a.notionalOpenInterest * a.collateral.usdPrice
      const bOiUsd = b.notionalOpenInterest * b.collateral.usdPrice
      return bOiUsd - aOiUsd
    })
}

export function buildFundingHedgePlan(
  position: HyperliquidBtcPosition,
  market: BorosHedgeMarket,
  hedgeRatioBps: number,
  now = Math.floor(Date.now() / 1_000),
): FundingHedgePlan {
  if (!Number.isInteger(hedgeRatioBps) || hedgeRatioBps <= 0 || hedgeRatioBps > 10_000) {
    throw new Error('Hedge ratio must be between 1% and 100%')
  }
  if (market.status !== 2) throw new Error('The selected Boros market is not open')
  const termSeconds = market.maturity - now
  if (termSeconds < MIN_TERM_SECONDS) {
    throw new Error('The selected Boros market is too close to maturity')
  }

  const side = position.direction
  const bestExecutableApr = side === 'long' ? market.bestAskApr : market.bestBidApr
  if (bestExecutableApr === null) throw new Error('The selected Boros book has no executable quote')

  const baseSize = market.collateral.unit === 'btc'
    ? decimalTextToX18(position.sizeBtcText)
    : decimalTextToX18((position.notionalUsd / market.collateral.usdPrice).toFixed(12))
  const size = baseSize * BigInt(hedgeRatioBps) / 10_000n
  if (size <= 0n) throw new Error('The resulting Boros hedge is below minimum precision')

  const ratio = hedgeRatioBps / 10_000
  return {
    position,
    market,
    side,
    hedgeRatioBps,
    sizeYu: Number(size) / Number(X18),
    sizeX18: size.toString(),
    hedgedNotionalUsd: position.notionalUsd * ratio,
    uncoveredNotionalUsd: position.notionalUsd * (1 - ratio),
    bestExecutableApr,
    bookSpreadApr: market.bestBidApr === null || market.bestAskApr === null
      ? null
      : market.bestAskApr - market.bestBidApr,
    termSeconds,
    termYears: termSeconds / YEAR_SECONDS,
  }
}

export function calculateFundingHedgeEconomics(
  plan: FundingHedgePlan,
  quote: BorosHedgeQuote,
): FundingHedgeEconomics {
  if (quote.marketId !== plan.market.marketId || quote.side !== plan.side) {
    throw new Error('The Boros quote does not match the selected hedge')
  }
  const requested = BigInt(plan.sizeX18)
  const signedMatched = BigInt(quote.matchedSizeX18)
  if (
    (plan.side === 'long' && signedMatched < 0n) ||
    (plan.side === 'short' && signedMatched > 0n)
  ) {
    throw new Error('The Boros fill direction does not match the selected hedge')
  }
  const matched = signedMatched < 0n ? -signedMatched : signedMatched
  const fillRatio = requested === 0n ? 0 : Math.min(Number(matched) / Number(requested), 1)
  const fullFill = matched >= requested
  const matchedYu = Number(matched) / Number(X18)
  const hedgedNotionalUsd = plan.hedgedNotionalUsd * fillRatio
  const uncoveredNotionalUsd = plan.position.notionalUsd - hedgedNotionalUsd
  const feeAnnualized = quote.takerFeeUsd === null
    ? null
    : hedgedNotionalUsd > 0 && plan.termYears > 0
      ? quote.takerFeeUsd / (hedgedNotionalUsd * plan.termYears)
      : 0
  const settlementFeeUsd =
    hedgedNotionalUsd * plan.market.settlementFeeApr * plan.termYears
  const totalFeeUsd = quote.takerFeeUsd === null ? null : quote.takerFeeUsd + settlementFeeUsd
  const netFixedApr = feeAnnualized === null
    ? null
    : plan.side === 'long'
      ? quote.matchedRate + feeAnnualized + plan.market.settlementFeeApr
      : quote.matchedRate - feeAnnualized - plan.market.settlementFeeApr
  const signedAnnualCost = BigInt(quote.matchedCostX18)
  // Boros signs cost by YU side. Normalize it into the fixed-leg amount from
  // the user's perspective: payment for long YU, income for short YU. Keep a
  // negative result when a negative fixed rate reverses that cash flow.
  const normalizedAnnualCost = plan.side === 'long'
    ? signedAnnualCost
    : -signedAnnualCost
  const fixedTermCashflowUsd =
    Number(normalizedAnnualCost) / Number(X18) * plan.market.collateral.usdPrice * plan.termYears
  const currentFloatingTermCashflowUsd =
    hedgedNotionalUsd * plan.market.floatingApr * plan.termYears
  const comparisonToCurrentUsd = totalFeeUsd === null
    ? null
    : plan.side === 'long'
      ? currentFloatingTermCashflowUsd - fixedTermCashflowUsd - totalFeeUsd
      : fixedTermCashflowUsd - currentFloatingTermCashflowUsd - totalFeeUsd
  const marginRequiredCollateral = x18ToNumber(quote.marginRequiredX18)

  return {
    fullFill,
    fillRatio,
    matchedYu,
    hedgedNotionalUsd,
    uncoveredNotionalUsd,
    fixedApr: quote.matchedRate,
    netFixedApr,
    currentFloatingApr: plan.market.floatingApr,
    fixedTermCashflowUsd,
    currentFloatingTermCashflowUsd,
    comparisonToCurrentUsd,
    takerFeeUsd: quote.takerFeeUsd,
    settlementFeeUsd,
    totalFeeUsd,
    marginRequiredCollateral,
    marginRequiredUsd: marginRequiredCollateral * plan.market.collateral.usdPrice,
    executionVsBestApr: plan.side === 'long'
      ? quote.matchedRate - plan.bestExecutableApr
      : plan.bestExecutableApr - quote.matchedRate,
  }
}
