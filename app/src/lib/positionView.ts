import type { MarketSnapshot, Positions } from './types.ts'

export const LP_POSITION_DECIMALS = 18

export type StandardPositionRole = 'PT' | 'YT' | 'LP'

export interface StandardPositionBalance {
  role: StandardPositionRole
  amount: bigint
  decimals: number
  symbol: string
  token: `0x${string}`
}

export interface PositionDataItem {
  snapshot?: MarketSnapshot
  positions?: Positions
}

export interface StandardPositionRow<T extends PositionDataItem> {
  item: T
  balance: StandardPositionBalance
}

export interface ClaimablePositionRow<T extends PositionDataItem> {
  item: T
  includeYt: boolean
  includeSy: boolean
}

/** Pendle-style primary position rows: one row per non-zero PT, YT, or LP balance. */
export function standardPositionBalances(
  snapshot: MarketSnapshot,
  positions: Positions,
): StandardPositionBalance[] {
  const balances: StandardPositionBalance[] = []
  if (positions.pt > 0n) {
    balances.push({
      role: 'PT',
      amount: positions.pt,
      decimals: snapshot.sy.assetDecimals,
      symbol: snapshot.ptSymbol || 'PT',
      token: snapshot.pt,
    })
  }
  if (positions.yt > 0n) {
    balances.push({
      role: 'YT',
      amount: positions.yt,
      decimals: snapshot.sy.assetDecimals,
      symbol: snapshot.ytSymbol || 'YT',
      token: snapshot.yt,
    })
  }
  if (positions.lp > 0n) {
    balances.push({
      role: 'LP',
      amount: positions.lp,
      decimals: LP_POSITION_DECIMALS,
      symbol: 'LP',
      token: snapshot.address,
    })
  }
  return balances
}

export function hasClaimablePositionRewards(positions: Positions): boolean {
  return (
    positions.ytClaimableInterestSy > 0n ||
    [
      ...positions.ytClaimableRewards,
      ...positions.lpClaimableRewards,
      ...positions.syClaimableRewards,
    ].some((reward) => reward.amount > 0n)
  )
}

export function hasStandardPosition(positions: Positions): boolean {
  return (
    positions.pt > 0n ||
    positions.yt > 0n ||
    positions.lp > 0n ||
    hasClaimablePositionRewards(positions)
  )
}

/**
 * Split hydrated market items into PT/YT/LP rows. PT and YT are token
 * positions, so markets that share the same PY pair must not duplicate them;
 * LP remains keyed by its market token. Call this on one chain at a time.
 */
export function splitStandardPositionRows<T extends PositionDataItem>(
  items: readonly T[],
): Record<StandardPositionRole, StandardPositionRow<T>[]> {
  const rows: Record<StandardPositionRole, StandardPositionRow<T>[]> = {
    PT: [],
    YT: [],
    LP: [],
  }
  const seen = new Set<string>()

  for (const item of items) {
    if (item.snapshot === undefined || item.positions === undefined) continue
    for (const balance of standardPositionBalances(item.snapshot, item.positions)) {
      const key = `${balance.role}:${balance.token.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      rows[balance.role].push({ item, balance })
    }
  }

  return rows
}

function hasPositiveReward(rewards: Positions['ytClaimableRewards']): boolean {
  return rewards.some((reward) => reward.amount > 0n)
}

/**
 * Keep YT interest/rewards and SY rewards once per token while retaining LP
 * rewards once per market. Multiple Pendle markets can share one PY pair/SY.
 */
export function dedupeClaimablePositionRows<T extends PositionDataItem>(
  items: readonly T[],
): ClaimablePositionRow<T>[] {
  const rows: ClaimablePositionRow<T>[] = []
  const seenYts = new Set<string>()
  const seenSys = new Set<string>()

  for (const item of items) {
    if (item.snapshot === undefined || item.positions === undefined) continue
    const { snapshot, positions } = item
    const hasYt =
      positions.ytClaimableInterestSy > 0n || hasPositiveReward(positions.ytClaimableRewards)
    const hasSy = hasPositiveReward(positions.syClaimableRewards)
    const hasLp = hasPositiveReward(positions.lpClaimableRewards)
    const ytKey = snapshot.yt.toLowerCase()
    const syKey = snapshot.sy.address.toLowerCase()
    const includeYt = hasYt && !seenYts.has(ytKey)
    const includeSy = hasSy && !seenSys.has(syKey)

    if (includeYt) seenYts.add(ytKey)
    if (includeSy) seenSys.add(syKey)
    if (includeYt || includeSy || hasLp) rows.push({ item, includeYt, includeSy })
  }

  return rows
}

/** Transaction-safe claim candidates; unvalidated discoveries remain read-only. */
export function validatedClaimableSnapshots<T extends PositionDataItem>(
  items: readonly T[],
): MarketSnapshot[] {
  return items
    .filter(
      (item) =>
        item.snapshot?.validated === true &&
        item.positions !== undefined &&
        hasClaimablePositionRewards(item.positions),
    )
    .map((item) => item.snapshot as MarketSnapshot)
}
