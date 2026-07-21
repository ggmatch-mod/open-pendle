import type { Address } from 'viem'
import type { SavedPool, SupportedChainId } from './types.ts'

export type PositionMarketSource = 'saved' | 'official'

export interface OfficialPositionMarketReference {
  chainId: SupportedChainId
  market: Address
}

/** A market candidate for My Positions without pretending it was saved locally. */
export interface PositionMarketTarget {
  chainId: SupportedChainId
  market: Address
  label?: string
  sources: PositionMarketSource[]
}

export function positionMarketKey(chainId: SupportedChainId, market: Address): string {
  return `${chainId}:${market.toLowerCase()}`
}

/** Saved pools first, then wallet-discovered Pendle Official pools, de-duplicated. */
export function mergePositionMarketTargets(
  savedPools: readonly SavedPool[],
  officialMarkets: readonly OfficialPositionMarketReference[],
): PositionMarketTarget[] {
  const targets = new Map<string, PositionMarketTarget>()

  for (const pool of savedPools) {
    const key = positionMarketKey(pool.chainId, pool.market)
    targets.set(key, {
      chainId: pool.chainId,
      market: pool.market,
      label: pool.label,
      sources: ['saved'],
    })
  }

  for (const official of officialMarkets) {
    const key = positionMarketKey(official.chainId, official.market)
    const existing = targets.get(key)
    if (existing !== undefined) {
      if (!existing.sources.includes('official')) existing.sources.push('official')
      continue
    }
    targets.set(key, {
      chainId: official.chainId,
      market: official.market,
      sources: ['official'],
    })
  }

  return [...targets.values()]
}

/** Hydrate wallet-relevant markets without an unbounded burst of RPC traffic. */
export async function mapPositionMarketsBounded<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  if (items.length === 0) return []
  const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1
  const width = Math.max(1, Math.min(requested, items.length))
  const output = new Array<R>(items.length)
  let nextIndex = 0

  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      output[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: width }, () => run()))
  return output
}
