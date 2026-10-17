import { useEffect, useMemo } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import { buildActionCenterItems } from '../lib/actionCenter'
import { updateActionActivityStatus } from '../lib/actionCenterStorage'
import type { ActionActivity } from '../lib/actionCenterStorage'
import type { SupportedChainId } from '../lib/types'
import { useYieldAlerts } from './useYieldAlerts'
import { useActionCenterProfile } from './useActionCenterProfile'
import { usePortfolioOverview } from './usePortfolioOverview'

const UNKNOWN_AFTER_MS = 7 * 24 * 60 * 60_000

function useActionCenterClients(): Record<SupportedChainId, PublicClient | undefined> {
  const c1 = usePublicClient({ chainId: 1 })
  const c56 = usePublicClient({ chainId: 56 })
  const c143 = usePublicClient({ chainId: 143 })
  const c8453 = usePublicClient({ chainId: 8453 })
  const c9745 = usePublicClient({ chainId: 9745 })
  const c42161 = usePublicClient({ chainId: 42161 })
  return useMemo(
    () => ({ 1: c1, 56: c56, 143: c143, 8453: c8453, 9745: c9745, 42161: c42161 }),
    [c1, c56, c143, c8453, c9745, c42161],
  )
}

function pendingActivity(activity: readonly ActionActivity[]): ActionActivity[] {
  return activity.filter(
    (item) =>
      item.kind !== 'limit-order' &&
      item.hash !== undefined &&
      (item.status === 'pending' || item.status === 'unconfirmed'),
  )
}

export function useActionCenter() {
  const { address: owner } = useAccount()
  const profileState = useActionCenterProfile(owner)
  const portfolio = usePortfolioOverview(profileState.profile.preferences.maturityLeadDays)
  const yieldQuery = useYieldAlerts()
  const clients = useActionCenterClients()
  const pending = useMemo(
    () => pendingActivity(profileState.profile.activity),
    [profileState.profile.activity],
  )
  const pendingKey = pending
    .map((item) => `${item.id}:${item.status}:${item.hash}`)
    .sort()
    .join(',')

  useEffect(() => {
    if (owner === undefined || pending.length === 0) return
    let cancelled = false
    void Promise.allSettled(
      pending.map(async (activity) => {
        const client = clients[activity.chainId]
        if (client === undefined || activity.hash === undefined) return
        try {
          const receipt = await client.getTransactionReceipt({ hash: activity.hash })
          if (cancelled) return
          updateActionActivityStatus(
            owner,
            activity.id,
            receipt.status === 'success' ? 'confirmed' : 'failed',
          )
        } catch {
          if (!cancelled && Date.now() - activity.updatedAt > UNKNOWN_AFTER_MS) {
            updateActionActivityStatus(owner, activity.id, 'unknown')
          }
        }
      }),
    )
    return () => {
      cancelled = true
    }
    // Recheck receipts while the page stays open; a receipt is often absent
    // on the first request immediately after submission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, owner, pendingKey, portfolio.evaluatedAt])

  const items = useMemo(
    () => buildActionCenterItems({
      portfolioActions: portfolio.actions,
      holdings: portfolio.overview.holdings,
      yieldAlerts: yieldQuery.data?.alerts ?? [],
      trackedMarkets: profileState.profile.trackedMarkets,
      activity: profileState.profile.activity,
      preferences: profileState.profile.preferences,
      yieldWindowEnd: yieldQuery.data?.windowEnd,
      yieldCoverageUnavailable:
        yieldQuery.isError || (yieldQuery.data?.failedHistories.length ?? 0) > 0,
      portfolioCoverageUnavailable:
        portfolio.status === 'error' ||
        portfolio.officialDiscoveryError !== undefined ||
        portfolio.overview.degradedMarketCount > 0,
      now: portfolio.evaluatedAt,
    }),
    [
      portfolio.actions,
      portfolio.evaluatedAt,
      portfolio.status,
      portfolio.officialDiscoveryError,
      portfolio.overview.degradedMarketCount,
      portfolio.overview.holdings,
      profileState.profile.activity,
      profileState.profile.preferences,
      profileState.profile.trackedMarkets,
      yieldQuery.data,
      yieldQuery.isError,
    ],
  )

  return {
    owner,
    profileState,
    portfolio,
    yieldQuery,
    items,
  }
}
