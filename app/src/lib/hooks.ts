// M1 hook implementations. The signatures are the contract the UI codes
// against — do not change them without updating both sides. All React/wagmi
// coupling for the data layer lives HERE; market.ts / registry.ts stay pure.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import type { AddressClassification, MarketSnapshot, QueryStatus, SavedPool } from './types'
import type { RegistrySweepResult } from './market'
import { classifyAddress, loadMarketSnapshot, sweepRegistryPools } from './market'
import {
  forgetPool,
  getServerPools,
  isPoolSaved,
  loadPools,
  savePool,
  subscribeRegistry,
} from './registry'

const CLASSIFY_DEBOUNCE_MS = 400
const MARKET_STALE_TIME_MS = 15_000

/** Debounce a changing value; returns the value as of `delayMs` ago. */
function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

function toQueryStatus(status: 'pending' | 'error' | 'success'): QueryStatus {
  if (status === 'pending') return 'loading'
  return status
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Classify pasted input. Empty/whitespace input → status 'idle'.
 * Runs format validation, then on-chain probes (market validation across the
 * 5 factories, PT/YT/SY near-miss detection).
 */
export function useClassifyAddress(input: string): {
  status: QueryStatus
  classification?: AddressClassification
  error?: string
} {
  const client = usePublicClient()
  const trimmed = input.trim()
  const debounced = useDebouncedValue(trimmed, CLASSIFY_DEBOUNCE_MS)
  const enabled = debounced.length > 0 && client !== undefined

  const query = useQuery({
    queryKey: ['classify', debounced],
    queryFn: () => classifyAddress(client as PublicClient, debounced),
    enabled,
    staleTime: 60_000,
    retry: 1,
  })

  if (trimmed.length === 0) return { status: 'idle' }
  // Debounce window still open (or the client not ready yet) → loading.
  if (debounced !== trimmed || !enabled) return { status: 'loading' }
  if (query.status === 'error') {
    return { status: 'error', error: errorMessage(query.error) }
  }
  if (query.status === 'success') {
    return { status: 'success', classification: query.data }
  }
  return { status: 'loading' }
}

/**
 * Load a full market snapshot (state, SY info, metrics, trust probes).
 * Undefined address → status 'idle'. Legacy probe failures land in
 * snapshot.degraded rather than failing the whole load.
 */
export function useMarketSnapshot(address?: Address): {
  status: QueryStatus
  snapshot?: MarketSnapshot
  error?: string
  refetch: () => void
} {
  const client = usePublicClient()
  const enabled = address !== undefined && client !== undefined

  const query = useQuery({
    queryKey: ['market', address?.toLowerCase() ?? null],
    queryFn: () => loadMarketSnapshot(client as PublicClient, address as Address),
    enabled,
    staleTime: MARKET_STALE_TIME_MS,
    retry: 1,
  })

  const refetch = (): void => {
    void query.refetch()
  }

  if (address === undefined) return { status: 'idle', refetch }
  if (!enabled) return { status: 'loading', refetch }
  if (query.status === 'error') {
    return { status: 'error', error: errorMessage(query.error), refetch }
  }
  return { status: toQueryStatus(query.status), snapshot: query.data, refetch }
}

/**
 * Home-grid quick stats for ALL saved pools in ONE multicall batch
 * (PLAN §3.3 "one multicall sweep") instead of a full snapshot per card.
 * Per market: readState(ROUTER_V4) + isExpired() + SY.exchangeRate().
 * Result is keyed by lowercased market address; a missing key means that
 * market's reads failed (the card renders '—', never crashes).
 */
export function useRegistrySweep(pools: SavedPool[]): {
  status: QueryStatus
  stats: RegistrySweepResult
} {
  const client = usePublicClient()
  const key = pools
    .map((p) => p.market.toLowerCase())
    .sort()
    .join(',')
  const enabled = pools.length > 0 && client !== undefined

  const query = useQuery({
    queryKey: ['registry-sweep', key],
    queryFn: () => sweepRegistryPools(client as PublicClient, pools),
    enabled,
    staleTime: MARKET_STALE_TIME_MS,
    retry: 1,
  })

  if (pools.length === 0) return { status: 'idle', stats: {} }
  if (!enabled) return { status: 'loading', stats: {} }
  if (query.status === 'error') return { status: 'error', stats: {} }
  return { status: toQueryStatus(query.status), stats: query.data ?? {} }
}

/**
 * The remember/forget registry (localStorage-backed, schema-versioned,
 * multi-pool; see PLAN.md §3.3). save() derives the SavedPool display cache
 * from a loaded snapshot; forget() removes by market address.
 */
export function useRegistry(): {
  pools: SavedPool[]
  isSaved: (market: Address) => boolean
  save: (snapshot: MarketSnapshot) => void
  forget: (market: Address) => void
} {
  const pools = useSyncExternalStore(subscribeRegistry, loadPools, getServerPools)
  return {
    pools,
    isSaved: (market: Address) => isPoolSaved(market),
    save: (snapshot: MarketSnapshot) => {
      savePool(snapshot)
    },
    forget: (market: Address) => {
      forgetPool(market)
    },
  }
}
