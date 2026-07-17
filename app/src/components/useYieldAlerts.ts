import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { fetchYieldAlerts } from '../lib/yieldAlerts.ts'
import type { YieldAlertsResult } from '../lib/yieldAlerts.ts'

export const YIELD_ALERTS_QUERY_KEY = ['yield-alerts', '24h-v1'] as const

const HOUR_MS = 60 * 60_000
const INGESTION_MINUTE = 15

/** Refresh just after Pendle's next buffered UTC-hour window becomes available. */
export function nextYieldAlertsRefreshDelay(now: Date = new Date()): number {
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) return HOUR_MS
  const hourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS
  const thisHourReady = hourStart + INGESTION_MINUTE * 60_000 + 5_000
  const nextReady = nowMs < thisHourReady ? thisHourReady : thisHourReady + HOUR_MS
  return Math.max(5_000, nextReady - nowMs)
}

/** Cross-chain, Pendle-listed PT yield movers over the last complete 24h window. */
export function useYieldAlerts(): UseQueryResult<YieldAlertsResult, Error> {
  return useQuery<YieldAlertsResult, Error>({
    queryKey: YIELD_ALERTS_QUERY_KEY,
    queryFn: ({ signal }) => fetchYieldAlerts({ signal }),
    staleTime: 30 * 60_000,
    gcTime: 2 * HOUR_MS,
    refetchInterval: () => nextYieldAlertsRefreshDelay(),
    // The data layer already performs its one bounded retry per request.
    retry: false,
    refetchOnWindowFocus: true,
  })
}
