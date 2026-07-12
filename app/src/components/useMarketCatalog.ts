import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { fetchMarketCatalog } from '../lib/catalog.ts'
import type { MarketCatalog } from '../lib/catalog.ts'

export const MARKET_CATALOG_QUERY_KEY = [
  'market-catalog',
  'factory-snapshot-v1',
  'pendle-enrichment',
] as const

/** Shared directory of factory-created markets with Pendle catalog enrichment. */
export function useMarketCatalog(): UseQueryResult<MarketCatalog, Error> {
  return useQuery<MarketCatalog, Error>({
    queryKey: MARKET_CATALOG_QUERY_KEY,
    queryFn: ({ signal }) => fetchMarketCatalog({ signal }),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 2,
    refetchOnWindowFocus: (query) => {
      const data = query.state.data
      return data !== undefined &&
        (data.coverage.membership !== 'complete' ||
          !data.coverage.pendle.active ||
          !data.coverage.pendle.inactive)
        ? 'always'
        : true
    },
  })
}
