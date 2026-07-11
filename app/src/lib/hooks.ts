// M1 hook implementations. The signatures are the contract the UI codes
// against — do not change them without updating both sides. All React/wagmi
// coupling for the data layer lives HERE; market.ts / registry.ts stay pure.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { BaseError, UserRejectedRequestError } from 'viem'
import type { Address, PublicClient } from 'viem'
import type {
  ActionPlan,
  AddressClassification,
  ApprovalNeed,
  MarketSnapshot,
  PlannedCall,
  QueryStatus,
  SavedPool,
  SupportedChainId,
  TxPhase,
} from './types'
import type { RegistrySweepResult } from './market'
import type { SupportedChain } from './addresses'
import { classifyAddress, loadMarketSnapshot, sweepRegistryPools } from './market'
import { preflightDeploy } from './deploy'
import { probeAsset } from './syDeploy'
import { ARBITRUM_CHAIN_ID, SUPPORTED_CHAINS, isSupportedChainId, supportedChain } from './addresses'
import { loadPositions } from './positions'
import { fetchMerklRewards } from './merkl'
import type { MerklReward } from './merkl'
import { resolveTokenSet } from './tokenSnapshot'
import { resolveMarketsForToken } from './marketResolve'
import { quoteBuy, quoteSell } from './swaps'
import { previewDualAdd, quoteZapIn, quoteZapOut } from './liquidity'
import { previewExitPostExp, readDepegInfo } from './maturity'
import { buildApproveCall, checkApprovals, decodePendleError, simulateAction } from './txflow'
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
const POSITIONS_STALE_TIME_MS = 12_000
/** localStorage key: 'infinite' opts in to infinite approvals (exact-amount default, PLAN §3.4). */
const APPROVAL_MODE_STORAGE_KEY = 'openpendle.approvals'

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

// ---------------------------------------------------------------------------
// M8 active chain — the app's SELECTED network (localStorage-backed, cross-tab).
// This is NOT the wallet's chain; every data hook reads the active chain via
// usePublicClient({ chainId }), so switching it reloads everything on the new
// chain WITHOUT the UI passing a chainId anywhere. The wallet-chain vs
// active-chain mismatch drives the wrong-network state (useActionFlow).
// ---------------------------------------------------------------------------

/** localStorage key holding the selected active chain id (default Arbitrum). */
const ACTIVE_CHAIN_STORAGE_KEY = 'openpendle.chain'

const activeChainListeners = new Set<() => void>()
let activeChainStorageInstalled = false

function readActiveChainId(): SupportedChainId {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(ACTIVE_CHAIN_STORAGE_KEY)
      const parsed = raw === null ? NaN : Number(raw)
      if (isSupportedChainId(parsed)) return parsed
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return ARBITRUM_CHAIN_ID
}

function writeActiveChainId(id: SupportedChainId): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(ACTIVE_CHAIN_STORAGE_KEY, String(id))
    }
  } catch {
    // Quota / storage disabled — the in-memory emit below still updates this tab.
  }
  for (const l of activeChainListeners) l()
}

function subscribeActiveChain(listener: () => void): () => void {
  if (!activeChainStorageInstalled && typeof window !== 'undefined') {
    activeChainStorageInstalled = true
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key === null || event.key === ACTIVE_CHAIN_STORAGE_KEY) {
        for (const l of activeChainListeners) l()
      }
    })
  }
  activeChainListeners.add(listener)
  return () => {
    activeChainListeners.delete(listener)
  }
}

/**
 * The app's selected network. `chainId` is backed by localStorage
 * (`openpendle.chain`, default 42161) and stays in sync across tabs;
 * `setChainId` persists + notifies. `chain` is the SUPPORTED_CHAINS entry for
 * the active id. This is the SINGLE source the data hooks read — the UI never
 * threads a chainId through them.
 */
export function useActiveChain(): {
  chainId: SupportedChainId
  setChainId: (id: SupportedChainId) => void
  chain: SupportedChain
} {
  const chainId = useSyncExternalStore(
    subscribeActiveChain,
    readActiveChainId,
    () => ARBITRUM_CHAIN_ID,
  )
  const setChainId = useCallback((id: SupportedChainId) => {
    writeActiveChainId(id)
  }, [])
  // SUPPORTED_CHAINS always contains every SupportedChainId, so this is defined.
  const chain = supportedChain(chainId) as SupportedChain
  return { chainId, setChainId, chain }
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
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const trimmed = input.trim()
  const debounced = useDebouncedValue(trimmed, CLASSIFY_DEBOUNCE_MS)
  const enabled = debounced.length > 0 && client !== undefined

  const query = useQuery({
    queryKey: ['classify', chainId, debounced],
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
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const enabled = address !== undefined && client !== undefined

  const query = useQuery({
    queryKey: ['market', chainId, address?.toLowerCase() ?? null],
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
 * All six supported-chain public clients, resolved unconditionally at the top
 * level (the chain list is a compile-time constant, so this is a FIXED set of
 * hook calls — React's rules-of-hooks hold). Used by the cross-chain registry
 * sweep so a pool saved on Base reads via Base's client. Keyed by chainId.
 */
function useAllChainClients(): Record<SupportedChainId, PublicClient | undefined> {
  // One usePublicClient per supported chain — order is stable across renders.
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

/**
 * Home-grid quick stats for ALL saved pools (PLAN §3.3 "one multicall sweep").
 * M8: pools may span chains — group by each pool's OWN chainId and sweep each
 * group through that chain's client (one multicall PER chain), so the home grid
 * shows cross-chain pools. Per market: readState(router) + isExpired() +
 * SY.exchangeRate(). Result is keyed by `${chainId}:${market}` (sweepKey), so
 * the same market address saved on two chains stays two distinct entries; a
 * missing key means that market's reads failed (the card renders '—', never
 * crashes).
 */
export function useRegistrySweep(pools: SavedPool[]): {
  status: QueryStatus
  stats: RegistrySweepResult
} {
  const clients = useAllChainClients()
  // Fingerprint (chainId:market) pairs, sorted, so the query re-runs when the
  // set of saved pools changes across ANY chain.
  const key = pools
    .map((p) => `${p.chainId}:${p.market.toLowerCase()}`)
    .sort()
    .join(',')
  const enabled = pools.length > 0

  const query = useQuery({
    queryKey: ['registry-sweep', key],
    queryFn: async () => {
      // Group by chainId, then one sweep per chain (each with that chain's
      // client). Chains whose client isn't ready are skipped (their cards
      // render '—' until it is).
      const byChain = new Map<SupportedChainId, SavedPool[]>()
      for (const p of pools) {
        const arr = byChain.get(p.chainId)
        if (arr) arr.push(p)
        else byChain.set(p.chainId, [p])
      }
      const results = await Promise.all(
        [...byChain.entries()].map(async ([chainId, chainPools]) => {
          const client = clients[chainId]
          if (!client) return {} as RegistrySweepResult
          try {
            return await sweepRegistryPools(client, chainPools)
          } catch {
            return {} as RegistrySweepResult
          }
        }),
      )
      // Merge: each chain's sweep keys entries by `${chainId}:${market}`
      // (sweepKey), so the composite keys never collide across chains — the
      // same market address on two chains stays two distinct entries.
      return Object.assign({}, ...results) as RegistrySweepResult
    },
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
 * multi-pool, M8 CROSS-CHAIN; see PLAN.md §3.3).
 *
 * - `pools` are ALL remembered pools across ALL chains (each carries its own
 *   chainId) — the home grid groups/badges them by network, never filters to
 *   the active chain (PLAN M8: switching networks and returning always shows a
 *   chain's pools).
 * - `save()` stamps the ACTIVE chain id (the pool page is always on the active
 *   chain); `isSaved(market)` / `forget(market)` are scoped to the active chain
 *   (the UI passes no chainId — the pool-page market lives on the active chain).
 * - `isSavedOn(chainId, market)` / `forgetOn(chainId, market)` are the
 *   chain-explicit variants for the grouped home grid, where a card may belong
 *   to a non-active chain.
 */
export function useRegistry(): {
  pools: SavedPool[]
  isSaved: (market: Address) => boolean
  isSavedOn: (chainId: SupportedChainId, market: Address) => boolean
  save: (snapshot: MarketSnapshot) => void
  forget: (market: Address) => void
  forgetOn: (chainId: SupportedChainId, market: Address) => void
} {
  const { chainId } = useActiveChain()
  const pools = useSyncExternalStore(subscribeRegistry, loadPools, getServerPools)
  return {
    pools,
    isSaved: (market: Address) => isPoolSaved(chainId, market),
    isSavedOn: (poolChainId: SupportedChainId, market: Address) =>
      isPoolSaved(poolChainId, market),
    save: (snapshot: MarketSnapshot) => {
      savePool(chainId, snapshot)
    },
    forget: (market: Address) => {
      forgetPool(chainId, market)
    },
    forgetOn: (poolChainId: SupportedChainId, market: Address) => {
      forgetPool(poolChainId, market)
    },
  }
}

// ---------------------------------------------------------------------------
// M2 hook contracts — STUB bodies below are replaced by the data-layer work;
// the signatures are the contract the UI codes against. Do not change
// signatures without updating both sides.
// ---------------------------------------------------------------------------

/**
 * Load the connected user's positions for a market: PT/YT/LP/SY balances,
 * tokensIn wallet balances, claimable interest & rewards (RouterStatic
 * getUser* via eth_call — those functions are state-mutating, never in a tx).
 * Undefined snapshot or no connected wallet → 'idle'.
 */
export function usePositions(snapshot?: MarketSnapshot): {
  status: QueryStatus
  positions?: import('./types').Positions
  error?: string
  refetch: () => void
} {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const { address: user } = useAccount()
  const enabled = snapshot !== undefined && user !== undefined && client !== undefined

  const query = useQuery({
    queryKey: [
      'positions',
      chainId,
      snapshot?.address.toLowerCase() ?? null,
      user?.toLowerCase() ?? null,
    ],
    queryFn: () =>
      loadPositions(client as PublicClient, snapshot as MarketSnapshot, user as Address),
    enabled,
    staleTime: POSITIONS_STALE_TIME_MS,
    retry: 1,
  })

  const refetch = (): void => {
    void query.refetch()
  }

  if (snapshot === undefined || user === undefined) return { status: 'idle', refetch }
  if (!enabled) return { status: 'loading', refetch }
  if (query.status === 'error') {
    return { status: 'error', error: errorMessage(query.error), refetch }
  }
  return { status: toQueryStatus(query.status), positions: query.data, refetch }
}

/** One aggregated saved-pool position: the pool, its loaded snapshot + the
 * connected user's positions on it, or an error string if either read failed. */
export interface AggregatedPosition {
  pool: SavedPool
  snapshot?: MarketSnapshot
  positions?: import('./types').Positions
  error?: string
}

/**
 * Cross-chain "My positions" (M12): for EVERY saved pool on EVERY chain, load
 * its market snapshot + the connected user's positions on it, through that
 * chain's own client. One react-query entry keyed by (user, saved-pool set), so
 * it refetches when the wallet or the registry changes and is invalidated by
 * useActionFlow after a confirmed claim. Reads only — the claim tx still runs
 * through useActionFlow on the ACTIVE chain (see PositionsPage). A single pool's
 * failed read degrades to an `error` entry; the rest still render.
 */
export function useAllPositions(): {
  status: QueryStatus
  items: AggregatedPosition[]
  refetch: () => void
} {
  const { pools } = useRegistry()
  const clients = useAllChainClients()
  const { address: user } = useAccount()

  const key = pools
    .map((p) => `${p.chainId}:${p.market.toLowerCase()}`)
    .sort()
    .join(',')
  const enabled = pools.length > 0 && user !== undefined

  const query = useQuery({
    queryKey: ['all-positions', user?.toLowerCase() ?? null, key],
    queryFn: async (): Promise<AggregatedPosition[]> => {
      const u = user as Address
      return Promise.all(
        pools.map(async (pool): Promise<AggregatedPosition> => {
          const client = clients[pool.chainId]
          if (!client) return { pool, error: 'RPC unavailable for this network.' }
          try {
            const snapshot = await loadMarketSnapshot(client, pool.market)
            const positions = await loadPositions(client, snapshot, u)
            return { pool, snapshot, positions }
          } catch (err) {
            return { pool, error: errorMessage(err) }
          }
        }),
      )
    },
    enabled,
    staleTime: POSITIONS_STALE_TIME_MS,
    retry: 1,
  })

  const refetch = (): void => {
    void query.refetch()
  }

  if (pools.length === 0 || user === undefined) return { status: 'idle', items: [], refetch }
  if (query.status === 'error') return { status: 'error', items: [], refetch }
  return { status: toQueryStatus(query.status), items: query.data ?? [], refetch }
}

/** A wallet's claimable Merkl rewards on one chain (all protocols, not just Pendle). */
export interface MerklChainRewards {
  chainId: SupportedChainId
  rewards: MerklReward[]
}

/**
 * The connected wallet's claimable Merkl rewards across ALL supported chains
 * (M12-B), fetched in parallel from Merkl's public keyless API; only chains with
 * something to claim are returned. Independent of saved pools — Merkl rewards
 * exist per wallet per chain regardless of which pools you follow. The claim
 * still runs through useActionFlow on the ACTIVE chain (see MerklSection).
 */
export function useMerklRewards(): {
  status: QueryStatus
  byChain: MerklChainRewards[]
  refetch: () => void
} {
  const { address: user } = useAccount()

  const query = useQuery({
    queryKey: ['merkl', user?.toLowerCase() ?? null],
    queryFn: async (): Promise<MerklChainRewards[]> => {
      const u = user as Address
      const results = await Promise.all(
        SUPPORTED_CHAINS.map(async (c) => ({
          chainId: c.id,
          rewards: await fetchMerklRewards(c.id, u),
        })),
      )
      return results.filter((r) => r.rewards.length > 0)
    },
    enabled: user !== undefined,
    // Proofs rotate ~every 4h; a 2-min cache keeps the page snappy without staleness.
    staleTime: 120_000,
    retry: 1,
  })

  const refetch = (): void => {
    void query.refetch()
  }

  if (user === undefined) return { status: 'idle', byChain: [], refetch }
  if (query.status === 'error') return { status: 'error', byChain: [], refetch }
  return { status: toQueryStatus(query.status), byChain: query.data ?? [], refetch }
}

/**
 * Resolve a pasted PT/YT into a market-less token snapshot (M12 "paste any
 * token"). `notPyToken` is true when the address loaded but is NOT a clean PT/YT
 * (an SY, a market, or other) — the page then tells the user to paste the
 * market. Undefined address → 'idle'.
 */
export function useTokenSnapshot(address?: Address): {
  status: QueryStatus
  snapshot?: MarketSnapshot
  notPyToken: boolean
  refetch: () => void
} {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const enabled = address !== undefined && client !== undefined

  const query = useQuery({
    queryKey: ['token-set', chainId, address?.toLowerCase() ?? null],
    queryFn: () => resolveTokenSet(client as PublicClient, address as Address),
    enabled,
    staleTime: MARKET_STALE_TIME_MS,
    retry: 1,
  })

  const refetch = (): void => {
    void query.refetch()
  }

  if (address === undefined) return { status: 'idle', notPyToken: false, refetch }
  if (!enabled) return { status: 'loading', notPyToken: false, refetch }
  if (query.status === 'error') return { status: 'error', notPyToken: false, refetch }
  if (query.status === 'success') {
    // resolveTokenSet returns null when the address is not a clean PT/YT.
    return query.data
      ? { status: 'success', snapshot: query.data, notPyToken: false, refetch }
      : { status: 'success', notPyToken: true, refetch }
  }
  return { status: 'loading', notPyToken: false, refetch }
}

/**
 * The connected user's MARKET-LESS positions on a pasted-token snapshot (PT/YT/SY
 * balances + claimable YT interest + YT/SY rewards; no LP). Loads with
 * includeMarket:false so no LP/market read is attempted. Undefined snapshot or
 * no wallet → 'idle'.
 */
export function useTokenPositions(snapshot?: MarketSnapshot): {
  status: QueryStatus
  positions?: import('./types').Positions
  error?: string
  refetch: () => void
} {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const { address: user } = useAccount()
  const enabled = snapshot !== undefined && user !== undefined && client !== undefined

  const query = useQuery({
    queryKey: [
      'token-positions',
      chainId,
      snapshot?.address.toLowerCase() ?? null,
      user?.toLowerCase() ?? null,
    ],
    queryFn: () =>
      loadPositions(client as PublicClient, snapshot as MarketSnapshot, user as Address, {
        includeMarket: false,
      }),
    enabled,
    staleTime: POSITIONS_STALE_TIME_MS,
    retry: 1,
  })

  const refetch = (): void => {
    void query.refetch()
  }

  if (snapshot === undefined || user === undefined) return { status: 'idle', refetch }
  if (!enabled) return { status: 'loading', refetch }
  if (query.status === 'error') {
    return { status: 'error', error: errorMessage(query.error), refetch }
  }
  return { status: toQueryStatus(query.status), positions: query.data, refetch }
}

/**
 * Resolve the market(s) for a pasted PT/YT (M12 "Go to the pool") — Pendle's
 * all-markets API for listed pools, indexed factory logs for community pools
 * where available, then a best-effort direct RPC scan. Returns [] when nothing
 * resolves. Undefined snapshot → 'idle'.
 */
export function useResolveMarket(snapshot?: MarketSnapshot): {
  status: QueryStatus
  markets: Address[]
} {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const enabled = snapshot !== undefined && client !== undefined

  const query = useQuery({
    queryKey: ['resolve-market', chainId, snapshot?.pt.toLowerCase() ?? null],
    queryFn: () =>
      resolveMarketsForToken(
        client as PublicClient,
        chainId,
        (snapshot as MarketSnapshot).pt,
        (snapshot as MarketSnapshot).yt,
      ),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  })

  if (!enabled) return { status: 'idle', markets: [] }
  if (query.status === 'error') return { status: 'error', markets: [] }
  return { status: toQueryStatus(query.status), markets: query.data ?? [] }
}

/**
 * Drive one ActionPlan through the approve → simulate → confirm lifecycle
 * (PLAN §3.2). Semantics:
 * - null/undefined plan → 'idle'
 * - `simulatedOut` is the decoded primary output of the simulated main call
 *   once phase reaches 'ready' — the binding quote that gates Confirm
 * - approve() sends the first unmet approval; execute() sends the main call
 *   (valid only in 'ready'); reset() returns to 'idle' after confirmed/failed
 * - once a send starts, the driving plan is LATCHED: plan changes are ignored
 *   during approving/signing/pending/confirmed and picked up only when the
 *   send resolves or reset() runs (see latchRef below)
 */
/** True when the user declined the wallet prompt (EIP-1193 code 4001) — not a failure state. */
function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) {
    return true
  }
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 4001
  )
}

/** JSON-stable key for a plan (bigints stringified); the ABI is implied by address+functionName. */
function planMemoKey(plan: ActionPlan | null | undefined): string | null {
  if (!plan) return null
  return JSON.stringify(
    {
      address: plan.call.address,
      functionName: plan.call.functionName,
      args: plan.call.args,
      value: plan.call.value,
      approvals: plan.approvals,
    },
    (_key, value: unknown) => (typeof value === 'bigint' ? `${value.toString()}n` : value),
  )
}

export function useActionFlow(plan?: import('./types').ActionPlan | null): {
  phase: import('./types').TxPhase
  error?: string
  simulatedOut?: bigint
  txHash?: `0x${string}`
  /** First unmet approval, for button labeling ("Approve USDai"). */
  pendingApproval?: import('./types').ApprovalNeed
  /**
   * True only when a 'failed' phase came from a genuine on-chain revert — the
   * binding simulation returned ok:false, or a signed tx's receipt reverted.
   * False for transport/RPC errors caught by the pipeline (which are transient
   * and retryable). Callers (e.g. the M5 legacy can't-redeem notice) use this
   * to avoid asserting un-redeemability on a mere network hiccup. Additive:
   * M2/M3/M4 panels ignore it.
   */
  reverted: boolean
  approve: () => void
  execute: () => void
  reset: () => void
  /**
   * Ask the wallet to switch to the app's ACTIVE chain — for the wrong-network
   * banner's "Switch to <chain>" button (M8: generalized from switch-to-Arbitrum).
   * Resolves whether or not the user accepts; the pipeline re-arms via the
   * walletChainId change when the switch lands.
   */
  switchNetwork: () => Promise<void>
} {
  // walletChainId comes from useAccount() — the CONNECTOR's real chain.
  // activeChainId is the app's SELECTED network. The tx must go to the ACTIVE
  // chain; the wrong-network state is walletChainId ≠ activeChainId (M8:
  // generalized from the hardcoded 42161). The reads use the active-chain
  // client so a preflight/simulation always runs on the selected chain.
  const { address: user, chainId: walletChainId } = useAccount()
  const { chainId: activeChainId } = useActiveChain()
  const client = usePublicClient({ chainId: activeChainId })
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const queryClient = useQueryClient()

  const [phase, setPhase] = useState<TxPhase>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const [simulatedOut, setSimulatedOut] = useState<bigint | undefined>(undefined)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  const [pendingApproval, setPendingApproval] = useState<ApprovalNeed | undefined>(undefined)
  // True only for a genuine on-chain revert (sim ok:false / receipt reverted),
  // never for a thrown transport/RPC error. Cleared on every (re)arm below.
  const [reverted, setReverted] = useState(false)
  const [resetNonce, setResetNonce] = useState(0)

  // Monotonic run id: any state transition source bumps it; async continuations
  // check it before touching state so stale pipelines can never clobber a
  // newer plan's phases.
  const runRef = useRef(0)
  const planRef = useRef<ActionPlan | null | undefined>(plan)
  planRef.current = plan

  // Send latch: the moment approve()/execute() fires, the driving plan is
  // snapshotted (closure) and this latch is armed. While armed, the pipeline
  // effect is a NO-OP — quote refetches, input nudges or positions updates
  // that rebuild/null the plan can no longer abandon a receipt-wait, wipe
  // txHash, or re-arm Confirm while a signed tx is in flight. The latch stays
  // armed through 'confirmed' (Done + tx link survive plan churn) and is
  // released on resolution (rejection/failure re-arm cleanly) or by reset().
  // Continuations check the latch id — NOT runRef — so the receipt-wait stays
  // alive for the whole send regardless of other state churn.
  const latchRef = useRef<{ id: number; key: string | null } | null>(null)
  const latchSeq = useRef(0)

  const planKey = useMemo(() => planMemoKey(plan), [plan])

  /** PlannedCall → wagmi writeContract variables (loosely typed by design). */
  const toWriteRequest = (
    call: PlannedCall,
  ): Parameters<typeof writeContractAsync>[0] =>
    ({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      ...(call.value !== undefined ? { value: call.value } : {}),
      chainId: activeChainId,
    }) as unknown as Parameters<typeof writeContractAsync>[0]

  /** checkApprovals → needs-approval | simulate → ready/failed (pipeline effect body). */
  const runCheckAndSimulate = async (
    run: number,
    activePlan: ActionPlan,
    activeClient: PublicClient,
    activeUser: Address,
  ): Promise<void> => {
    const unmet = await checkApprovals(activeClient, activeUser, activePlan.approvals)
    if (runRef.current !== run) return
    if (unmet.length > 0) {
      setPendingApproval(unmet[0])
      setPhase('needs-approval')
      return
    }
    setPendingApproval(undefined)
    setPhase('simulating')
    const sim = await simulateAction(activeClient, activeUser, activePlan.call)
    if (runRef.current !== run) return
    if (sim.ok) {
      setSimulatedOut(sim.primaryOut)
      setPhase('ready')
    } else {
      // Binding simulation reverted — a genuine on-chain revert (decoded).
      setReverted(true)
      setError(sim.reason)
      setPhase('failed')
    }
  }

  // Pipeline: (re)runs on plan change (memo key), wallet/network change, or
  // reset(). Simulation runs once on reaching ready; execute() reuses the
  // same call, whose min-out params keep the binding protection.
  useEffect(() => {
    // A latched send (approving/signing/pending/confirmed) owns the flow —
    // see latchRef above. The newest plan is picked up when the send resolves
    // (its handlers re-arm via resetNonce when the plan moved) or on reset().
    if (latchRef.current !== null) return
    const run = ++runRef.current
    setError(undefined)
    setSimulatedOut(undefined)
    setTxHash(undefined)
    setPendingApproval(undefined)
    setReverted(false)
    const activePlan = planRef.current
    if (!activePlan) {
      setPhase('idle')
      return
    }
    if (!user) {
      setPhase('needs-wallet')
      return
    }
    // Wrong network = the WALLET is not on the app's ACTIVE chain (M8).
    if (walletChainId !== activeChainId) {
      setPhase('wrong-network')
      return
    }
    if (!client) {
      setPhase('checking')
      return
    }
    setPhase('checking')
    void (async () => {
      try {
        await runCheckAndSimulate(run, activePlan, client, user)
      } catch (err) {
        if (runRef.current !== run) return
        setError(decodePendleError(err))
        setPhase('failed')
      }
    })()
    // planKey (not plan) is deliberate: the UI may rebuild an identical plan
    // object every render; resetNonce re-arms the pipeline after reset().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, user, walletChainId, activeChainId, client, resetNonce])

  const approve = useCallback(() => {
    const activePlan = planRef.current
    const need = pendingApproval
    if (phase !== 'needs-approval' || !need || !activePlan || !client || !user) return
    runRef.current++ // abandon any in-flight pipeline continuation
    const latch = { id: ++latchSeq.current, key: planMemoKey(activePlan) }
    latchRef.current = latch
    setError(undefined)
    setPhase('approving')
    void (async () => {
      /** True when reset() released the latch mid-send — abandon silently. */
      const released = (): boolean => latchRef.current?.id !== latch.id
      try {
        const infinite =
          typeof localStorage !== 'undefined' &&
          localStorage.getItem(APPROVAL_MODE_STORAGE_KEY) === 'infinite'
        const hash = await writeContractAsync(toWriteRequest(buildApproveCall(need, infinite)))
        const receipt = await client.waitForTransactionReceipt({ hash })
        if (released()) return
        latchRef.current = null
        if (receipt.status !== 'success') {
          setError(
            'Approval transaction reverted on-chain — this token may require resetting the allowance to 0 first.',
          )
          setPhase('failed')
          return
        }
        // Approval mined — re-arm the pipeline for a fresh allowance check +
        // binding simulation against the CURRENT plan/wallet (this also picks
        // up any plan change that happened while the approval was in flight).
        setResetNonce((n) => n + 1)
      } catch (err) {
        if (released()) return
        latchRef.current = null
        if (isUserRejection(err)) {
          setError('Approval rejected in the wallet — nothing was sent.')
          if (planMemoKey(planRef.current ?? null) !== latch.key) {
            // Plan moved while the prompt was open — re-arm on the new plan.
            setResetNonce((n) => n + 1)
          } else {
            setPhase('needs-approval')
          }
          return
        }
        setError(decodePendleError(err))
        setPhase('failed')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pendingApproval, client, user, writeContractAsync])

  const execute = useCallback(() => {
    // The plan is snapshotted HERE (closure): whatever the UI rebuilds later,
    // this send keeps tracking the exact call that was simulated and signed.
    const activePlan = planRef.current
    if (phase !== 'ready' || !activePlan || !client) return
    runRef.current++ // abandon any in-flight pipeline continuation
    const latch = { id: ++latchSeq.current, key: planMemoKey(activePlan) }
    latchRef.current = latch
    setError(undefined)
    setPhase('signing')
    void (async () => {
      /** True when reset() released the latch mid-send — abandon silently. */
      const released = (): boolean => latchRef.current?.id !== latch.id
      try {
        const hash = await writeContractAsync(toWriteRequest(activePlan.call))
        if (released()) return
        setTxHash(hash)
        setPhase('pending')
        const receipt = await client.waitForTransactionReceipt({ hash })
        if (released()) return
        if (receipt.status === 'success') {
          // Stay latched through 'confirmed': the Done + tx-link state must
          // survive plan churn (e.g. the positions refetch below nulling a
          // Max-amount plan). Only reset() (Done/Retry) releases the latch.
          setPhase('confirmed')
          void queryClient.invalidateQueries({ queryKey: ['positions'] })
          void queryClient.invalidateQueries({ queryKey: ['all-positions'] })
          void queryClient.invalidateQueries({ queryKey: ['token-positions'] })
          void queryClient.invalidateQueries({ queryKey: ['merkl'] })
          void queryClient.invalidateQueries({ queryKey: ['market'] })
          void queryClient.invalidateQueries({ queryKey: ['registry-sweep'] })
          // The trade itself moved the pool: a repeat trade must never reuse
          // a pre-trade cached quote (its ApproxParams bounds are now stale).
          void queryClient.invalidateQueries({ queryKey: ['swap-quote'] })
        } else {
          latchRef.current = null
          // Signed tx mined but reverted — a genuine on-chain revert.
          setReverted(true)
          setError('Transaction reverted on-chain — no tokens moved (gas was spent).')
          setPhase('failed')
        }
      } catch (err) {
        if (released()) return
        latchRef.current = null
        if (isUserRejection(err)) {
          // Gentle note, not a failure: the user just declined the prompt.
          setError('Transaction rejected in the wallet — nothing was sent.')
          if (planMemoKey(planRef.current ?? null) !== latch.key) {
            // Plan moved while the prompt was open — the old simulation no
            // longer matches it, so re-arm instead of returning to 'ready'.
            setResetNonce((n) => n + 1)
          } else {
            setPhase('ready')
          }
          return
        }
        setError(decodePendleError(err))
        setPhase('failed')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, client, writeContractAsync, queryClient])

  const reset = useCallback(() => {
    runRef.current++
    latchRef.current = null // release any in-flight send; its continuations abandon
    setPhase('idle')
    setError(undefined)
    setSimulatedOut(undefined)
    setTxHash(undefined)
    setPendingApproval(undefined)
    setReverted(false)
    // Re-arm the pipeline: with a plan still set, the effect immediately
    // moves idle → checking again (fresh allowance check + simulation).
    setResetNonce((n) => n + 1)
  }, [])

  const switchNetwork = useCallback(async () => {
    try {
      await switchChainAsync({ chainId: activeChainId })
    } catch {
      // User declined / wallet can't switch — leave them on the banner.
    }
  }, [switchChainAsync, activeChainId])

  return {
    phase,
    error,
    simulatedOut,
    txHash,
    pendingApproval,
    reverted,
    approve,
    execute,
    reset,
    switchNetwork,
  }
}

// ---------------------------------------------------------------------------
// M3 hook contract — STUB body below is replaced by the data-layer work; the
// signature is the contract the UI codes against.
// ---------------------------------------------------------------------------

const SWAP_QUOTE_DEBOUNCE_MS = 350
const SWAP_QUOTE_STALE_TIME_MS = 10_000

/**
 * Debounced swap quote via RouterStatic (display quote + synthesized
 * ApproxParams; the binding number still comes from useActionFlow's
 * simulation). token = the pay token for buys / receive token for sells;
 * pass snapshot.sy.address for the SY variants. Undefined inputs → 'idle'.
 * slippageFraction only shapes the synthesized ApproxParams bounds (buys).
 * Quote errors are decoded through decodePendleError (revert families arrive
 * pre-translated; non-revert errors fall back to viem's shortMessage), and
 * `refetch` (stable identity) forces a fresh quote — used after a failed
 * flow, where the pool has usually moved from under the cached quote.
 */
export function useSwapQuote(
  snapshot: MarketSnapshot | undefined,
  side: import('./swaps').SwapSide,
  action: 'buy' | 'sell',
  token: Address | undefined,
  amount: bigint | undefined,
  slippageFraction: number,
): {
  status: QueryStatus
  quote?: import('./types').SwapQuote
  error?: string
  refetch: () => void
} {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  // Debounce the amount (stringified — useDebouncedValue is a string hook and
  // bigints can't sit in query keys anyway). '' encodes "no amount".
  const amountKey = amount === undefined ? '' : amount.toString()
  const debouncedAmountKey = useDebouncedValue(amountKey, SWAP_QUOTE_DEBOUNCE_MS)
  const inputsReady =
    snapshot !== undefined && token !== undefined && amount !== undefined && amount > 0n
  const enabled = inputsReady && client !== undefined && debouncedAmountKey === amountKey

  const query = useQuery({
    queryKey: [
      'swap-quote',
      chainId,
      snapshot?.address.toLowerCase() ?? null,
      side,
      action,
      token?.toLowerCase() ?? null,
      debouncedAmountKey,
      slippageFraction,
    ],
    queryFn: () =>
      action === 'buy'
        ? quoteBuy(
            client as PublicClient,
            snapshot as MarketSnapshot,
            side,
            token as Address,
            BigInt(debouncedAmountKey),
            slippageFraction,
          )
        : quoteSell(
            client as PublicClient,
            snapshot as MarketSnapshot,
            side,
            token as Address,
            BigInt(debouncedAmountKey),
          ),
    enabled,
    staleTime: SWAP_QUOTE_STALE_TIME_MS,
    retry: 1,
  })

  // Stable identity (TanStack v5's query.refetch is stable) so callers can
  // key effects on it without refetch loops.
  const queryRefetch = query.refetch
  const refetch = useCallback((): void => {
    void queryRefetch()
  }, [queryRefetch])

  if (!inputsReady) return { status: 'idle', refetch }
  // Debounce window still open (or the client not ready yet) → loading.
  if (!enabled) return { status: 'loading', refetch }
  if (query.status === 'error') {
    return { status: 'error', error: decodePendleError(query.error), refetch }
  }
  if (query.status === 'success') return { status: 'success', quote: query.data, refetch }
  return { status: 'loading', refetch }
}

// ---------------------------------------------------------------------------
// M4 hook contracts — STUB bodies below are replaced by the data-layer work;
// signatures are the contract the UI codes against.
// ---------------------------------------------------------------------------

/**
 * Debounced dual-add preview (pure ratio math + optional previewDeposit for
 * token pay sides). Undefined inputs → 'idle'.
 */
export function useDualAddPreview(
  snapshot: MarketSnapshot | undefined,
  fixed: 'pt' | 'sy' | 'token',
  tokenIn: Address | undefined,
  amount: bigint | undefined,
): { status: QueryStatus; preview?: import('./types').DualAddPreview; error?: string } {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  // Debounce the amount (stringified — useDebouncedValue is a string hook and
  // bigints can't sit in query keys anyway). '' encodes "no amount".
  const amountKey = amount === undefined ? '' : amount.toString()
  const debouncedAmountKey = useDebouncedValue(amountKey, SWAP_QUOTE_DEBOUNCE_MS)
  const inputsReady =
    snapshot !== undefined &&
    amount !== undefined &&
    amount > 0n &&
    // tokenIn only matters for the token pay side (previewDeposit input).
    (fixed !== 'token' || tokenIn !== undefined)
  const enabled = inputsReady && client !== undefined && debouncedAmountKey === amountKey

  // The preview is pure ratio math over snapshot.state — fingerprint the
  // pool sides into the key so a refreshed market snapshot (useActionFlow
  // invalidates ['market'] after every confirmed send) recomputes it instead
  // of serving a pre-trade ratio from cache.
  const stateKey =
    snapshot === undefined
      ? null
      : `${snapshot.state.totalSy}:${snapshot.state.totalPt}:${snapshot.state.totalLp}`

  const query = useQuery({
    queryKey: [
      'dual-add-preview',
      chainId,
      snapshot?.address.toLowerCase() ?? null,
      stateKey,
      fixed,
      tokenIn?.toLowerCase() ?? null,
      debouncedAmountKey,
    ],
    queryFn: () =>
      previewDualAdd(
        client as PublicClient,
        snapshot as MarketSnapshot,
        fixed,
        tokenIn,
        BigInt(debouncedAmountKey),
      ),
    enabled,
    staleTime: SWAP_QUOTE_STALE_TIME_MS,
    retry: 1,
  })

  if (!inputsReady) return { status: 'idle' }
  // Debounce window still open (or the client not ready yet) → loading.
  if (!enabled) return { status: 'loading' }
  if (query.status === 'error') {
    return { status: 'error', error: decodePendleError(query.error) }
  }
  if (query.status === 'success') return { status: 'success', preview: query.data }
  return { status: 'loading' }
}

/**
 * Debounced zap quote (single-sided liquidity via RouterStatic). action
 * 'in' quotes token/SY → LP (keepYt → LP+YT); 'out' quotes LP → token/SY.
 * Undefined inputs → 'idle'.
 */
export function useZapQuote(
  snapshot: MarketSnapshot | undefined,
  action: 'in' | 'out',
  token: Address | undefined,
  amount: bigint | undefined,
  keepYt: boolean,
  slippageFraction: number,
): { status: QueryStatus; quote?: import('./types').SwapQuote; error?: string; refetch: () => void } {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const amountKey = amount === undefined ? '' : amount.toString()
  const debouncedAmountKey = useDebouncedValue(amountKey, SWAP_QUOTE_DEBOUNCE_MS)
  const inputsReady =
    snapshot !== undefined && token !== undefined && amount !== undefined && amount > 0n
  const enabled = inputsReady && client !== undefined && debouncedAmountKey === amountKey

  const query = useQuery({
    // Keyed under the 'swap-quote' family ON PURPOSE: useActionFlow
    // invalidates ['swap-quote'] after every confirmed send, and a zap moves
    // the pool exactly like a swap does — a repeat zap must never reuse a
    // pre-trade cached quote (its ApproxParams bounds are now stale). The
    // 'zap' discriminator cannot collide with useSwapQuote's keys (its third
    // element is a market address / null).
    queryKey: [
      'swap-quote',
      'zap',
      chainId,
      snapshot?.address.toLowerCase() ?? null,
      action,
      token?.toLowerCase() ?? null,
      debouncedAmountKey,
      keepYt,
      slippageFraction,
    ],
    queryFn: () =>
      action === 'in'
        ? quoteZapIn(
            client as PublicClient,
            snapshot as MarketSnapshot,
            token as Address,
            BigInt(debouncedAmountKey),
            keepYt,
            slippageFraction,
          )
        : quoteZapOut(
            client as PublicClient,
            snapshot as MarketSnapshot,
            token as Address,
            BigInt(debouncedAmountKey),
          ),
    enabled,
    staleTime: SWAP_QUOTE_STALE_TIME_MS,
    retry: 1,
  })

  // Stable identity (TanStack v5's query.refetch is stable) so callers can
  // key effects on it without refetch loops.
  const queryRefetch = query.refetch
  const refetch = useCallback((): void => {
    void queryRefetch()
  }, [queryRefetch])

  if (!inputsReady) return { status: 'idle', refetch }
  // Debounce window still open (or the client not ready yet) → loading.
  if (!enabled) return { status: 'loading', refetch }
  if (query.status === 'error') {
    return { status: 'error', error: decodePendleError(query.error), refetch }
  }
  if (query.status === 'success') return { status: 'success', quote: query.data, refetch }
  return { status: 'loading', refetch }
}

// ---------------------------------------------------------------------------
// M5 hook contracts — STUB bodies below are replaced by the data-layer work;
// signatures are the contract the UI codes against.
// ---------------------------------------------------------------------------

/**
 * Exact post-expiry exit preview (LP burn pro-rata + PT redemption at
 * pyIndex — no swap, so this is math, not an estimate). Undefined inputs or
 * a non-expired market → 'idle'.
 */
export function useExitPreview(
  snapshot: MarketSnapshot | undefined,
  lpIn: bigint | undefined,
  ptIncluded: bigint,
): {
  status: QueryStatus
  preview?: import('./types').ExitPostExpPreview
  error?: string
  /**
   * Force a fresh preview. The query key does NOT include pyIndex (it's read
   * live inside previewExitPostExp), so invalidating ['market'] alone won't
   * refresh the PT-redemption leg when the stored index drifts — callers use
   * this after a failed flow / on Retry to re-read pyIndex.
   */
  refetch: () => void
} {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  // Debounce the LP amount (stringified — useDebouncedValue is a string hook
  // and bigints can't sit in query keys anyway). '' encodes "no amount";
  // a PT-only exit (ptIncluded > 0, no LP) previews with lpIn = 0n.
  const lpKey = lpIn === undefined ? '' : lpIn.toString()
  const debouncedLpKey = useDebouncedValue(lpKey, SWAP_QUOTE_DEBOUNCE_MS)
  const inputsReady =
    snapshot !== undefined &&
    snapshot.isExpired &&
    ((lpIn !== undefined && lpIn > 0n) || ptIncluded > 0n)
  const enabled = inputsReady && client !== undefined && debouncedLpKey === lpKey

  // The LP leg is pure ratio math over snapshot.state — fingerprint the pool
  // sides into the key (useDualAddPreview precedent) so a refreshed market
  // snapshot recomputes the split instead of serving a stale one from cache.
  const stateKey =
    snapshot === undefined
      ? null
      : `${snapshot.state.totalSy}:${snapshot.state.totalPt}:${snapshot.state.totalLp}`

  const query = useQuery({
    queryKey: [
      'exit-preview',
      chainId,
      snapshot?.address.toLowerCase() ?? null,
      stateKey,
      debouncedLpKey,
      ptIncluded.toString(),
    ],
    queryFn: () =>
      previewExitPostExp(
        client as PublicClient,
        snapshot as MarketSnapshot,
        debouncedLpKey === '' ? 0n : BigInt(debouncedLpKey),
        ptIncluded,
      ),
    enabled,
    staleTime: SWAP_QUOTE_STALE_TIME_MS,
    retry: 1,
  })

  // Stable identity (TanStack v5's query.refetch is stable) so callers can
  // key effects on it without refetch loops.
  const queryRefetch = query.refetch
  const refetch = useCallback((): void => {
    void queryRefetch()
  }, [queryRefetch])

  if (!inputsReady) return { status: 'idle', refetch }
  // Debounce window still open (or the client not ready yet) → loading.
  if (!enabled) return { status: 'loading', refetch }
  if (query.status === 'error') {
    return { status: 'error', error: decodePendleError(query.error), refetch }
  }
  if (query.status === 'success') return { status: 'success', preview: query.data, refetch }
  return { status: 'loading', refetch }
}

/** Depeg reads refresh slowly — the stored index only moves on YT activity. */
const DEPEG_STALE_TIME_MS = 30_000

/** Depeg guard for matured markets (SY.exchangeRate vs pyIndexStored). */
export function useDepegInfo(snapshot?: MarketSnapshot): {
  status: QueryStatus
  info?: import('./types').DepegInfo
} {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const enabled = snapshot !== undefined && snapshot.isExpired && client !== undefined

  const query = useQuery({
    queryKey: ['depeg-info', chainId, snapshot?.address.toLowerCase() ?? null],
    queryFn: () => readDepegInfo(client as PublicClient, snapshot as MarketSnapshot),
    enabled,
    staleTime: DEPEG_STALE_TIME_MS,
    retry: 1,
  })

  if (snapshot === undefined || !snapshot.isExpired) return { status: 'idle' }
  if (!enabled) return { status: 'loading' }
  if (query.status === 'error') return { status: 'error' }
  if (query.status === 'success') return { status: 'success', info: query.data }
  return { status: 'loading' }
}

// ---------------------------------------------------------------------------
// M6 hook contract — STUB body below is replaced by the data-layer work;
// signature is the contract the UI codes against.
// ---------------------------------------------------------------------------

/** Debounce for the create-pool preflight (the whole config, not one field). */
const DEPLOY_PREFLIGHT_DEBOUNCE_MS = 500
const DEPLOY_PREFLIGHT_STALE_TIME_MS = 8_000

/** Stable string fingerprint of a PoolConfig (bigints → decimal strings). */
function serializeConfig(config: import('./types').PoolConfig): string {
  return [
    config.expiry,
    config.rateMin.toString(),
    config.rateMax.toString(),
    config.desiredImpliedRate.toString(),
    config.fee.toString(),
  ].join('|')
}

/**
 * Debounced live preflight for the create-pool wizard: validates the config +
 * runs the binding eth_call simulation of the deploy. Undefined/incomplete
 * inputs → 'idle'. Errors that are the SIMULATION reverting land in
 * preflight.simulationError (decoded), not as a thrown hook error.
 *
 * The simulation `user` is the connected account: the deploy is signed from
 * their wallet and the seeding pulls the seed token from them, so the eth_call
 * must run as them (needs the seed token held + approved to COMMON_DEPLOY —
 * the wizard runs preflight AFTER the approve tx confirms, PLAN §3.2). With no
 * wallet connected the preflight stays idle (nothing to simulate against).
 */
export function useDeployPreflight(
  sy: Address | undefined,
  config: import('./types').PoolConfig | undefined,
  seedToken: Address | undefined,
  seedAmount: bigint | undefined,
): { status: QueryStatus; preflight?: import('./types').DeployPreflight; error?: string } {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const { address: account } = useAccount()

  // Debounce the whole config + seed amount (stringified — useDebouncedValue is
  // a string hook and bigints can't sit in query keys anyway). The active
  // chainId is part of the key so switching networks re-runs the preflight.
  const configKey = config === undefined ? '' : serializeConfig(config)
  const seedAmountKey = seedAmount === undefined ? '' : seedAmount.toString()
  const inputKey = `${chainId}~${sy?.toLowerCase() ?? ''}~${configKey}~${seedToken?.toLowerCase() ?? ''}~${seedAmountKey}~${account?.toLowerCase() ?? ''}`
  const debouncedKey = useDebouncedValue(inputKey, DEPLOY_PREFLIGHT_DEBOUNCE_MS)

  const inputsReady =
    sy !== undefined &&
    config !== undefined &&
    seedToken !== undefined &&
    seedAmount !== undefined &&
    seedAmount > 0n &&
    account !== undefined
  const enabled = inputsReady && client !== undefined && debouncedKey === inputKey

  const query = useQuery({
    queryKey: ['deploy-preflight', debouncedKey],
    queryFn: () =>
      preflightDeploy(
        client as PublicClient,
        sy as Address,
        config as import('./types').PoolConfig,
        seedToken as Address,
        seedAmount as bigint,
        account as Address,
      ),
    enabled,
    staleTime: DEPLOY_PREFLIGHT_STALE_TIME_MS,
    retry: 1,
  })

  if (!inputsReady) return { status: 'idle' }
  // Debounce window still open (or the client not ready yet) → loading.
  if (!enabled) return { status: 'loading' }
  if (query.status === 'error') {
    return { status: 'error', error: decodePendleError(query.error) }
  }
  if (query.status === 'success') return { status: 'success', preflight: query.data }
  return { status: 'loading' }
}

// ---------------------------------------------------------------------------
// M7 hook contract — STUB body below is replaced by the data-layer work;
// signature is the contract the UI codes against.
// ---------------------------------------------------------------------------

/**
 * Debounced asset probe for the SY-adapter wizard: ERC-4626 detection,
 * template suggestion, and FOT/rebasing screening. Undefined/invalid (non
 * 0x-address) asset → 'idle'. Keyed on the lower-cased address; errors are
 * decoded via decodePendleError. The probe itself is pure (syDeploy.probeAsset)
 * — this hook only sequences debounce + react-query + idle/loading/error state.
 */
export function useAssetProbe(
  asset: Address | undefined,
): { status: QueryStatus; probe?: import('./types').AssetProbe; error?: string } {
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })

  const assetKey = asset?.toLowerCase() ?? ''
  const isValid = /^0x[0-9a-fA-F]{40}$/.test(assetKey)
  const debouncedKey = useDebouncedValue(assetKey, CLASSIFY_DEBOUNCE_MS)
  const enabled = isValid && client !== undefined && debouncedKey === assetKey

  const query = useQuery({
    queryKey: ['asset-probe', chainId, debouncedKey],
    queryFn: () => probeAsset(client as PublicClient, asset as Address),
    enabled,
    staleTime: 60_000,
    retry: 1,
  })

  if (!isValid) return { status: 'idle' }
  // Debounce window still open (or the client not ready yet) → loading.
  if (!enabled) return { status: 'loading' }
  if (query.status === 'error') {
    return { status: 'error', error: decodePendleError(query.error) }
  }
  if (query.status === 'success') return { status: 'success', probe: query.data }
  return { status: 'loading' }
}
