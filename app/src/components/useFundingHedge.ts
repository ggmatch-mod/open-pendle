import { useQuery } from '@tanstack/react-query'
import { fetchBorosHyperliquidBtcMarkets, simulateBorosHedge } from '../lib/boros'
import type { FundingHedgePlan } from '../lib/fundingHedge'
import { fetchHyperliquidBtcPositions } from '../lib/hyperliquid'

export function useHyperliquidBtcPositions(address?: string) {
  return useQuery({
    queryKey: ['hyperliquid', 'btc-positions', address?.toLowerCase()],
    queryFn: ({ signal }) => fetchHyperliquidBtcPositions(String(address), { signal }),
    enabled: address !== undefined,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
  })
}

export function useBorosHedgeMarkets(enabled: boolean) {
  return useQuery({
    queryKey: ['boros', 'hyperliquid-btc-markets'],
    queryFn: ({ signal }) => fetchBorosHyperliquidBtcMarkets({ signal }),
    enabled,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: 1,
  })
}

export function useBorosHedgeQuote(plan: FundingHedgePlan | null) {
  return useQuery({
    queryKey: [
      'boros',
      'hedge-quote',
      plan?.market.marketId,
      plan?.market.ammId,
      plan?.side,
      plan?.sizeX18,
    ],
    queryFn: ({ signal }) => simulateBorosHedge(
      {
        marketId: Number(plan?.market.marketId),
        ammId: plan?.market.ammId,
        side: plan?.side ?? 'long',
        sizeX18: String(plan?.sizeX18),
      },
      { signal },
    ),
    enabled: plan !== null,
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: 1,
  })
}
