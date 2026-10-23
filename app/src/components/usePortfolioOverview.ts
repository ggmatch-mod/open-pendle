import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAllPositions } from '../lib/hooks'
import { fetchPendleAssetPrices } from '../lib/portfolio'
import {
  buildPortfolioOverview,
  derivePortfolioActions,
  portfolioPositionPriceIds,
} from '../lib/portfolioPositions'

export function usePortfolioOverview(maturityLeadDays = 30) {
  const [evaluatedAt, setEvaluatedAt] = useState(Date.now)
  useEffect(() => {
    const interval = setInterval(() => setEvaluatedAt(Date.now()), 60_000)
    return () => clearInterval(interval)
  }, [])
  const positions = useAllPositions()
  const priceIds = useMemo(
    () => portfolioPositionPriceIds(positions.items),
    [positions.items],
  )
  const priceKey = priceIds.join(',')
  const priceQuery = useQuery({
    queryKey: ['portfolio-position-prices', priceKey],
    queryFn: ({ signal }) => fetchPendleAssetPrices(priceIds, { signal }),
    enabled: priceIds.length > 0,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  })
  const overview = useMemo(
    () => buildPortfolioOverview(positions.items, priceQuery.data ?? {}, Math.floor(evaluatedAt / 1_000)),
    [positions.items, priceQuery.data, evaluatedAt],
  )
  const actions = useMemo(
    () => derivePortfolioActions(positions.items, maturityLeadDays, Math.floor(evaluatedAt / 1_000)),
    [maturityLeadDays, positions.items, evaluatedAt],
  )

  return {
    ...positions,
    overview,
    actions,
    evaluatedAt,
    pricesStatus: priceIds.length === 0 ? 'idle' as const : priceQuery.status,
    pricesError: priceQuery.error instanceof Error ? priceQuery.error.message : undefined,
    refetch: () => {
      positions.refetch()
      if (priceIds.length > 0) void priceQuery.refetch()
    },
  }
}
