import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchLoopingMarkets,
  loopingCatalogFingerprint,
} from '../lib/looping.ts'
import type { LoopingMarketsResult } from '../lib/looping.ts'
import { useMarketCatalog } from './useMarketCatalog.ts'

export const LOOPING_MARKETS_QUERY_KEY = ['looping-markets', 'morpho-pt-v1'] as const

export interface UseLoopingMarketsResult {
  data: LoopingMarketsResult | undefined
  isPending: boolean
  isFetching: boolean
  isError: boolean
  error: Error | null
  refetch: () => Promise<void>
}

/**
 * Factory-backed Pendle PTs joined to exact Morpho collateral tuples.
 * Catalog and API failures are combined so pages cannot mistake missing source
 * coverage for a valid empty result.
 */
export function useLoopingMarkets(): UseLoopingMarketsResult {
  const catalogQuery = useMarketCatalog()
  const catalog = catalogQuery.data
  const fingerprint = useMemo(
    () => catalog === undefined ? 'catalog-pending' : loopingCatalogFingerprint(catalog),
    [catalog],
  )
  const morphoQuery = useQuery<LoopingMarketsResult, Error>({
    queryKey: [...LOOPING_MARKETS_QUERY_KEY, fingerprint],
    enabled: catalog !== undefined,
    queryFn: ({ signal }) => {
      if (catalog === undefined) throw new Error('Pendle market catalog is unavailable')
      return fetchLoopingMarkets({ catalog, signal })
    },
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  })

  const refetch = useCallback(async (): Promise<void> => {
    const refreshedCatalogResult = await catalogQuery.refetch()
    if (refreshedCatalogResult.error !== null) throw refreshedCatalogResult.error
    const refreshedCatalog = refreshedCatalogResult.data
    if (refreshedCatalog === undefined) {
      throw new Error('Pendle market catalog is unavailable')
    }

    // If the catalog fingerprint changes, React Query mounts the new key and
    // fetches Morpho against the refreshed enrichment. Otherwise force a fresh
    // Morpho read now that the catalog refresh has completed.
    if (loopingCatalogFingerprint(refreshedCatalog) === fingerprint) {
      await morphoQuery.refetch()
    }
  }, [catalogQuery, fingerprint, morphoQuery])

  return {
    data: morphoQuery.data,
    isPending: catalogQuery.isPending || (catalog !== undefined && morphoQuery.isPending),
    isFetching: catalogQuery.isFetching || morphoQuery.isFetching,
    isError: catalogQuery.isError || morphoQuery.isError,
    error: catalogQuery.error ?? morphoQuery.error,
    refetch,
  }
}
