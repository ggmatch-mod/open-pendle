/**
 * My positions (M12) — a cross-pool, cross-chain view of the connected wallet's
 * Pendle positions, aggregated over the saved-pool registry. For every saved
 * pool on every chain it shows PT/YT/LP/SY balances + claimable Pendle-native
 * yield (YT interest + SY/LP rewards), and offers a per-chain "Claim all"
 * (one redeemDueInterestAndRewards tx batching that chain's pools).
 *
 * Reads are cross-chain (each pool via its own chain's client). WRITES go only
 * to the ACTIVE chain (useActionFlow's constraint), so the active chain's group
 * gets a live claim button; other chains offer "Switch to <chain> to claim",
 * which flips the active chain (and the wallet-switch runs through the usual
 * wrong-network flow). Discovery is registry-driven — positions live only in
 * pools you've saved; unsaved-pool discovery ("scan my wallet") is a follow-up.
 */

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import type { Address } from 'viem'
import type { AggregatedPosition } from '../lib/hooks'
import type { MarketSnapshot, Positions, SupportedChainId } from '../lib/types'
import { useActionFlow, useActiveChain, useAllPositions, useRegistry } from '../lib/hooks'
import { planClaimAll } from '../lib/actions'
import { SUPPORTED_CHAINS, supportedChain } from '../lib/addresses'
import { TxButton } from '../components/TxButton'
import { TxStatus } from '../components/TxStatus'
import { MerklSection } from '../components/MerklSection'
import { clampLabel, formatAmount } from '../components/format'
import { useDocumentTitle } from '../components/useDocumentTitle'

const LP_DECIMALS = 18

function hasClaimables(p: Positions): boolean {
  return (
    p.ytClaimableInterestSy > 0n ||
    [...p.ytClaimableRewards, ...p.lpClaimableRewards, ...p.syClaimableRewards].some(
      (r) => r.amount > 0n,
    )
  )
}

function hasPosition(p: Positions): boolean {
  return p.pt > 0n || p.yt > 0n || p.lp > 0n || p.sy > 0n || hasClaimables(p)
}

/** Compact non-zero balance chips for one pool. */
function BalanceChips({ snapshot, positions }: { snapshot: MarketSnapshot; positions: Positions }) {
  const chips: { role: string; text: string }[] = []
  if (positions.pt > 0n)
    chips.push({ role: 'PT', text: `${formatAmount(positions.pt, snapshot.sy.assetDecimals)} ${clampLabel(snapshot.ptSymbol || 'PT', 14)}` })
  if (positions.yt > 0n)
    chips.push({ role: 'YT', text: `${formatAmount(positions.yt, snapshot.sy.assetDecimals)} ${clampLabel(snapshot.ytSymbol || 'YT', 14)}` })
  if (positions.lp > 0n)
    chips.push({ role: 'LP', text: `${formatAmount(positions.lp, LP_DECIMALS)} LP` })
  if (positions.sy > 0n)
    chips.push({ role: 'SY', text: `${formatAmount(positions.sy, snapshot.sy.decimals)} ${clampLabel(snapshot.sy.symbol, 14)}` })
  if (chips.length === 0) return <p className="text-xs text-faint">No token balance.</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span
          key={c.role}
          className="inline-flex items-center gap-1 rounded-[8px] border border-hairline bg-bg-2 px-2 py-1 text-[12px] text-fg tabular-nums"
        >
          <span className="rounded bg-surface-2 px-1 text-[10px] font-semibold text-muted">{c.role}</span>
          {c.text}
        </span>
      ))}
    </div>
  )
}

/** One saved pool's row: name, balances, claimable summary, open link. */
function PositionRow({ item }: { item: AggregatedPosition }) {
  const { pool, snapshot, positions, error } = item
  const label = snapshot?.displayName || pool.label || pool.market
  return (
    <div className="rounded-[12px] border border-hairline bg-bg-2 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-fg" title={label}>
          {clampLabel(label, 42)}
        </p>
        <Link
          to={`/market/${pool.market}`}
          className="shrink-0 text-[12px] font-medium text-accent-ink no-underline hover:underline"
        >
          Open →
        </Link>
      </div>

      {error !== undefined ? (
        <p className="mt-2 text-xs text-danger">Couldn't load — {error}</p>
      ) : positions !== undefined && snapshot !== undefined ? (
        <>
          <div className="mt-2.5">
            <BalanceChips snapshot={snapshot} positions={positions} />
          </div>
          {hasClaimables(positions) ? (
            <p className="mt-2 text-[12px] text-muted">
              <span className="font-semibold text-accent-ink">Claimable:</span>{' '}
              {positions.ytClaimableInterestSy > 0n && (
                <span>
                  {formatAmount(positions.ytClaimableInterestSy, snapshot.sy.decimals)}{' '}
                  {clampLabel(snapshot.sy.symbol, 14)} YT interest
                </span>
              )}
              {[...positions.ytClaimableRewards, ...positions.lpClaimableRewards, ...positions.syClaimableRewards]
                .filter((r) => r.amount > 0n)
                .map((r) => (
                  <span key={r.token}> · {clampLabel(r.symbol, 14)} rewards</span>
                ))}
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-faint">Nothing to claim.</p>
          )}
        </>
      ) : (
        <div className="mt-2 h-10 animate-pulse rounded-lg bg-surface-2" />
      )}
    </div>
  )
}

/**
 * All positions for ONE chain. The active chain gets a live batched claim
 * (planClaimAll over its claimable pools); other chains offer a switch. Each
 * group calls useActionFlow exactly once (plan is null off the active chain, so
 * it stays idle) — a stable hook order per instance.
 */
function ChainGroup({
  chainId,
  items,
  isActive,
  user,
  onSwitch,
  onClaimed,
}: {
  chainId: SupportedChainId
  items: AggregatedPosition[]
  isActive: boolean
  user?: Address
  onSwitch: (id: SupportedChainId) => void
  onClaimed: () => void
}) {
  const chainName = supportedChain(chainId)?.name ?? `Chain ${chainId}`

  // Snapshots on this chain that actually have something claimable.
  const claimableSnapshots = useMemo(
    () =>
      items
        .filter((it) => it.positions !== undefined && hasClaimables(it.positions) && it.snapshot !== undefined)
        .map((it) => it.snapshot as MarketSnapshot),
    [items],
  )

  const claimPlan = useMemo(() => {
    if (!isActive || user === undefined || claimableSnapshots.length === 0) return null
    try {
      return planClaimAll(user, claimableSnapshots)
    } catch {
      return null
    }
  }, [isActive, user, claimableSnapshots])

  const claimFlow = useActionFlow(claimPlan)

  const hasAnyClaimable = claimableSnapshots.length > 0

  return (
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
          <h2 className="text-base font-semibold text-fg">{chainName}</h2>
          <span className="text-xs text-faint">
            {items.length} pool{items.length === 1 ? '' : 's'}
          </span>
        </div>
        {hasAnyClaimable && (
          <div className="w-full sm:w-52">
            {isActive ? (
              <TxButton
                flow={claimFlow}
                actionLabel="Claim all"
                disabledReason="Claim all"
                onDone={() => {
                  claimFlow.reset()
                  onClaimed()
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => onSwitch(chainId)}
                className="flex w-full items-center justify-center rounded-lg border border-[rgba(var(--op-accent-rgb),0.4)] px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-[rgba(var(--op-accent-rgb),0.08)]"
              >
                Switch to {chainName} to claim
              </button>
            )}
          </div>
        )}
      </div>

      {isActive && hasAnyClaimable && (
        <div className="mt-2">
          <TxStatus flow={claimFlow} />
        </div>
      )}

      <div className="mt-4 space-y-2.5">
        {items.map((it) => (
          <PositionRow key={`${it.pool.chainId}:${it.pool.market}`} item={it} />
        ))}
      </div>
    </section>
  )
}

export default function PositionsPage() {
  useDocumentTitle('My positions')
  const { isConnected } = useAccount()
  const { address: user } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { chainId: activeChainId, setChainId } = useActiveChain()
  const { pools } = useRegistry()
  const { items, status, refetch } = useAllPositions()

  // Keep only pools where the user actually holds something (or that errored, so
  // failures are visible). Group the rest by chain, active chain first.
  const shown = items.filter((it) => it.error !== undefined || (it.positions !== undefined && hasPosition(it.positions)))
  const emptyCount = items.length - shown.length

  const groups = useMemo(() => {
    const byChain = new Map<SupportedChainId, AggregatedPosition[]>()
    for (const it of shown) {
      const arr = byChain.get(it.pool.chainId)
      if (arr) arr.push(it)
      else byChain.set(it.pool.chainId, [it])
    }
    const order = [activeChainId, ...SUPPORTED_CHAINS.map((c) => c.id).filter((id) => id !== activeChainId)]
    return order
      .filter((id) => byChain.has(id))
      .map((id) => ({ chainId: id, items: byChain.get(id) as AggregatedPosition[] }))
  }, [shown, activeChainId])

  return (
    <div className="py-8">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-fg">My positions</h1>
          <p className="mt-1 text-sm text-muted">
            Your PT, YT, LP and SY across every pool you've saved, on every network — read straight from
            the chain, claim yield in one transaction per network.
          </p>
        </div>
        {isConnected && pools.length > 0 && (
          <button
            type="button"
            onClick={refetch}
            className="shrink-0 rounded-[10px] border border-hairline bg-surface px-3 py-1.5 text-sm text-muted transition hover:text-fg hover:border-hairline-strong"
          >
            Refresh
          </button>
        )}
      </div>

      {!isConnected ? (
        <section className="rounded-xl border border-hairline bg-surface p-8 text-center">
          <p className="text-sm text-muted">Connect your wallet to see your positions.</p>
          <button
            type="button"
            onClick={() => openConnectModal?.()}
            disabled={!openConnectModal}
            className="mt-4 inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Connect wallet
          </button>
        </section>
      ) : (
        <div className="space-y-4">
          <MerklSection />
          {pools.length === 0 ? (
        <section className="rounded-xl border border-hairline bg-surface p-8 text-center">
          <p className="text-sm font-medium text-fg">No saved pools yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            OpenPendle finds your positions in the pools you've remembered. Open a market by address and
            tick <span className="text-fg">Remember this pool</span> — it will show up here.
          </p>
          <div className="mt-4 flex items-center justify-center gap-4 text-sm">
            <Link to="/" className="font-medium text-accent-ink hover:underline">
              Load a market →
            </Link>
            <Link to="/pools" className="font-medium text-muted hover:text-fg">
              Saved pools
            </Link>
          </div>
        </section>
      ) : status === 'loading' ? (
        <div className="space-y-4" aria-busy="true">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl bg-surface-2" />
          ))}
        </div>
      ) : status === 'error' ? (
        <section className="rounded-xl border border-hairline bg-surface p-8 text-center">
          <p className="text-sm text-danger">Couldn't load your positions.</p>
          <button
            type="button"
            onClick={refetch}
            className="mt-4 rounded-md border border-hairline-strong px-3 py-1.5 text-xs text-muted hover:bg-surface-2"
          >
            Retry
          </button>
        </section>
      ) : groups.length === 0 ? (
        <section className="rounded-xl border border-hairline bg-surface p-8 text-center">
          <p className="text-sm font-medium text-fg">No open positions</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            You don't currently hold PT, YT, LP or SY in any of your {pools.length} saved pool
            {pools.length === 1 ? '' : 's'}. Buy PT for a fixed yield, or provide liquidity, to see a
            position here.
          </p>
          <Link to="/pools" className="mt-4 inline-block text-sm font-medium text-accent-ink hover:underline">
            Your saved pools →
          </Link>
        </section>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <ChainGroup
              key={g.chainId}
              chainId={g.chainId}
              items={g.items}
              isActive={g.chainId === activeChainId}
              user={user}
              onSwitch={setChainId}
              onClaimed={refetch}
            />
          ))}
          {emptyCount > 0 && (
            <p className="text-center text-[12px] text-faint">
              {emptyCount} saved pool{emptyCount === 1 ? '' : 's'} with no position not shown.
            </p>
          )}
        </div>
      )}
        </div>
      )}
    </div>
  )
}
