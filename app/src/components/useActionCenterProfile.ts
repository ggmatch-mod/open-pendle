import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import type { YieldAlert } from '../lib/yieldAlerts'
import type { SupportedChainId } from '../lib/types'
import {
  actionCenterProfile,
  DEFAULT_ACTION_CENTER_PREFERENCES,
  setActionCenterPreferences,
  setTrackedMarketTarget,
  subscribeActionCenter,
  trackActionMarket,
  untrackActionMarket,
} from '../lib/actionCenterStorage'
import type { ActionCenterPreferences } from '../lib/actionCenterStorage'

export function useActionCenterProfile(owner?: Address) {
  const [, setRevision] = useState(0)
  useEffect(
    () => subscribeActionCenter(() => setRevision((current) => current + 1)),
    [],
  )
  const profile = owner === undefined
    ? {
        preferences: { ...DEFAULT_ACTION_CENTER_PREFERENCES },
        trackedMarkets: [],
        activity: [],
      }
    : actionCenterProfile(owner)
  const trackedKeys = useMemo(
    () => new Set(
      profile.trackedMarkets.map(
        (market) => `${market.chainId}:${market.market.toLowerCase()}`,
      ),
    ),
    [profile.trackedMarkets],
  )

  const setPreferences = useCallback((preferences: ActionCenterPreferences) => {
    if (owner !== undefined) setActionCenterPreferences(owner, preferences)
  }, [owner])

  const toggleTracked = useCallback((market: YieldAlert) => {
    if (owner === undefined) return
    const key = `${market.chainId}:${market.address.toLowerCase()}`
    if (trackedKeys.has(key)) {
      untrackActionMarket(owner, market.chainId, market.address)
    } else {
      trackActionMarket(owner, {
        chainId: market.chainId,
        market: market.address,
        label: market.name,
      })
    }
  }, [owner, trackedKeys])

  const untrack = useCallback((chainId: SupportedChainId, market: Address) => {
    if (owner === undefined) return
    untrackActionMarket(owner, chainId, market)
  }, [owner])

  const setTarget = useCallback((
    chainId: SupportedChainId,
    market: Address,
    targetApyBps: number | null,
  ) => {
    if (owner === undefined) return
    setTrackedMarketTarget(owner, chainId, market, targetApyBps)
  }, [owner])

  return {
    profile,
    canPersonalize: owner !== undefined,
    isTracked: (chainId: number, market: Address) =>
      trackedKeys.has(`${chainId}:${market.toLowerCase()}`),
    setPreferences,
    toggleTracked,
    untrack,
    setTarget,
  }
}
