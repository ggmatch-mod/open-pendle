/**
 * My positions (M12) — a cross-pool, cross-chain view of the connected wallet's
 * Pendle positions, aggregated over Saved Pools plus wallet-discovered Pendle
 * Official pools. Standard positions are split into PT, YT, and LP like the
 * Pendle dashboard; looped PT positions stay in their separate section.
 *
 * Reads are cross-chain (each pool via its own chain's client). WRITES go only
 * to the ACTIVE chain (useActionFlow's constraint), so the active chain's group
 * gets a live claim button; other chains offer "Switch to <chain> to claim",
 * which synchronizes both the active chain and a connected wallet. Pendle's
 * wallet endpoint discovers Official markets, while balances and claimables
 * are re-read directly from the relevant chains.
 */

import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import type { Address } from 'viem'
import type { AggregatedPosition } from '../lib/hooks'
import type { SupportedChainId } from '../lib/types'
import { useActionFlow, useAllPositions } from '../lib/hooks'
import { planClaimAll } from '../lib/actions'
import { SUPPORTED_CHAINS, supportedChain } from '../lib/addresses'
import { TxButton } from '../components/TxButton'
import { TxStatus } from '../components/TxStatus'
import { MerklSection } from '../components/MerklSection'
import { LoopPositionsSection } from '../components/LoopPositionsSection'
import { clampLabel, formatAmount } from '../components/format'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { useNetworkSelection } from '../components/useNetworkSelection'
import { marketPath } from '../lib/routes'
import {
  dedupeClaimablePositionRows,
  hasClaimablePositionRewards,
  hasStandardPosition,
  splitStandardPositionRows,
  validatedClaimableSnapshots,
} from '../lib/positionView'
import type {
  StandardPositionBalance,
  StandardPositionRole,
  StandardPositionRow,
} from '../lib/positionView'

function PositionSources({ item }: { item: AggregatedPosition }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {item.target.sources.includes('official') && (
        <span className="rounded-md bg-[rgba(var(--op-accent-rgb),0.12)] px-1.5 py-0.5 text-[10px] font-medium text-accent-ink">
          Official
        </span>
      )}
      {item.target.sources.includes('saved') && (
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
          Saved
        </span>
      )}
      {item.snapshot !== undefined && !item.snapshot.validated && (
        <span className="rounded-md bg-[var(--op-warn-soft)] px-1.5 py-0.5 text-[10px] font-medium text-warn">
          Unvalidated
        </span>
      )}
    </div>
  )
}

function OpenMarketButton({ item }: { item: AggregatedPosition }) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => navigate(marketPath(item.target.market, item.target.chainId))}
      className="shrink-0 text-[12px] font-medium text-accent-ink no-underline hover:underline"
    >
      Open →
    </button>
  )
}

function positionLabel(item: AggregatedPosition): string {
  return item.snapshot?.displayName || item.target.label || item.target.market
}

function PositionRoleCard({
  item,
  balance,
}: {
  item: AggregatedPosition
  balance: StandardPositionBalance
}) {
  const label = positionLabel(item)
  return (
    <div className="rounded-[12px] border border-hairline bg-bg-2 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-fg" title={label}>
          {clampLabel(label, 36)}
        </p>
        <OpenMarketButton item={item} />
      </div>
      <p className="mt-2 text-sm font-semibold tabular-nums text-fg">
        {formatAmount(balance.amount, balance.decimals)} {clampLabel(balance.symbol, 18)}
      </p>
      <PositionSources item={item} />
    </div>
  )
}

const ROLE_COPY: Record<StandardPositionRole, string> = {
  PT: 'Principal tokens',
  YT: 'Yield tokens',
  LP: 'Liquidity positions',
}

function PositionRoleColumn({
  role,
  rows,
}: {
  role: StandardPositionRole
  rows: StandardPositionRow<AggregatedPosition>[]
}) {
  return (
    <section className="rounded-[14px] border border-hairline bg-surface-2/50 p-3">
      <div className="mb-3 flex items-baseline justify-between gap-2 px-0.5">
        <div>
          <h3 className="text-sm font-semibold text-fg">{role}</h3>
          <p className="text-[11px] text-faint">{ROLE_COPY[role]}</p>
        </div>
        <span className="text-[11px] tabular-nums text-faint">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-hairline px-3 py-6 text-center text-xs text-faint">
          No {role} positions
        </p>
      ) : (
        <div className="space-y-2.5">
          {rows.map(({ item, balance }) => (
            <PositionRoleCard
              key={`${balance.role}:${balance.token.toLowerCase()}`}
              item={item}
              balance={balance}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ClaimableRow({
  item,
  includeYt,
  includeSy,
}: {
  item: AggregatedPosition
  includeYt: boolean
  includeSy: boolean
}) {
  const { snapshot, positions } = item
  if (snapshot === undefined || positions === undefined) return null
  const details: string[] = []
  if (includeYt && positions.ytClaimableInterestSy > 0n) {
    details.push(
      `${formatAmount(positions.ytClaimableInterestSy, snapshot.sy.decimals)} ${clampLabel(snapshot.sy.symbol, 14)} YT interest`,
    )
  }
  const rewardSymbols = new Set(
    [
      ...(includeYt ? positions.ytClaimableRewards : []),
      ...positions.lpClaimableRewards,
      ...(includeSy ? positions.syClaimableRewards : []),
    ]
      .filter((reward) => reward.amount > 0n)
      .map((reward) => clampLabel(reward.symbol, 14)),
  )
  for (const symbol of rewardSymbols) details.push(`${symbol} rewards`)

  const label = positionLabel(item)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-hairline bg-bg-2 px-3.5 py-3">
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-fg" title={label}>{clampLabel(label, 42)}</p>
        <p className="mt-1 text-[11px] text-muted">{details.join(' · ')}</p>
      </div>
      <OpenMarketButton item={item} />
    </div>
  )
}

function PositionErrorRow({ item }: { item: AggregatedPosition }) {
  return (
    <div className="rounded-[10px] border border-hairline bg-bg-2 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-fg" title={positionLabel(item)}>
            {clampLabel(positionLabel(item), 42)}
          </p>
          <p className="mt-1 text-[11px] text-danger">Couldn&apos;t load — {item.error}</p>
        </div>
        <OpenMarketButton item={item} />
      </div>
      <PositionSources item={item} />
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
  selectionDisabled,
  onClaimed,
}: {
  chainId: SupportedChainId
  items: AggregatedPosition[]
  isActive: boolean
  user?: Address
  onSwitch: (id: SupportedChainId) => void
  selectionDisabled: boolean
  onClaimed: () => void
}) {
  const chainName = supportedChain(chainId)?.name ?? `Chain ${chainId}`
  const roleRows = useMemo(() => splitStandardPositionRows(items), [items])
  const claimableItems = items.filter(
    (item) => item.positions !== undefined && hasClaimablePositionRewards(item.positions),
  )
  const claimableRows = useMemo(
    () => dedupeClaimablePositionRows(items),
    [items],
  )
  const errorItems = items.filter((item) => item.error !== undefined)

  // Only recognized factory markets are admitted to a transaction plan.
  const claimableSnapshots = useMemo(
    () => validatedClaimableSnapshots(items),
    [items],
  )
  const unvalidatedClaimableCount = claimableItems.filter(
    (item) => item.snapshot !== undefined && !item.snapshot.validated,
  ).length

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
            {items.length} market{items.length === 1 ? '' : 's'}
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
                disabled={selectionDisabled}
                className="flex w-full items-center justify-center rounded-lg border border-[rgba(var(--op-accent-rgb),0.4)] px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-[rgba(var(--op-accent-rgb),0.08)] disabled:cursor-wait disabled:opacity-60"
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

      {unvalidatedClaimableCount > 0 && (
        <p className="mt-3 rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs text-warn">
          Claiming is disabled for {unvalidatedClaimableCount} unvalidated market
          {unvalidatedClaimableCount === 1 ? '' : 's'}.
        </p>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {(['PT', 'YT', 'LP'] as const).map((role) => (
          <PositionRoleColumn key={role} role={role} rows={roleRows[role]} />
        ))}
      </div>

      {claimableRows.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            Yield & rewards
          </h3>
          <div className="space-y-2">
            {claimableRows.map(({ item, includeYt, includeSy }) => (
              <ClaimableRow
                key={`${item.target.chainId}:${item.target.market.toLowerCase()}`}
                item={item}
                includeYt={includeYt}
                includeSy={includeSy}
              />
            ))}
          </div>
        </section>
      )}

      {errorItems.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            Unavailable markets
          </h3>
          <div className="space-y-2">
            {errorItems.map((item) => (
              <PositionErrorRow
                key={`${item.target.chainId}:${item.target.market.toLowerCase()}`}
                item={item}
              />
            ))}
          </div>
        </section>
      )}
    </section>
  )
}

export default function PositionsPage() {
  useDocumentTitle('My positions')
  const { isConnected } = useAccount()
  const { address: user } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { chainId: activeChainId, selectChain, isSelectionDisabled } = useNetworkSelection()
  const { items, status, officialStatus, officialDiscoveryError, refetch } = useAllPositions()

  const shown = items.filter(
    (item) =>
      item.error !== undefined ||
      (item.positions !== undefined && hasStandardPosition(item.positions)),
  )
  const emptyCount = items.length - shown.length

  const groups = useMemo(() => {
    const byChain = new Map<SupportedChainId, AggregatedPosition[]>()
    for (const it of shown) {
      const arr = byChain.get(it.target.chainId)
      if (arr) arr.push(it)
      else byChain.set(it.target.chainId, [it])
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
            Your PT loops plus PT, YT, and LP across Saved Pools and Pendle Official Pools — with
            balances read from their own networks.
          </p>
        </div>
        {isConnected && (
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
          <LoopPositionsSection />
          <MerklSection />
          {officialStatus === 'loading' && groups.length > 0 && (
            <section
              role="status"
              className="rounded-xl border border-hairline bg-surface px-4 py-3 text-sm text-muted"
            >
              Saved Pool positions are shown. Still checking Pendle Official Pools…
            </section>
          )}
          {officialDiscoveryError !== undefined && groups.length > 0 && (
            <section
              role="status"
              className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-sm text-warn"
            >
              Pendle Official Pool discovery is temporarily unavailable. Saved Pool positions are
              still shown where available.
            </section>
          )}
          {status === 'loading' ? (
            <div className="space-y-4" aria-busy="true">
              {Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="h-40 animate-pulse rounded-xl bg-surface-2" />
              ))}
            </div>
          ) : status === 'error' ? (
            <section className="rounded-xl border border-hairline bg-surface p-8 text-center">
              <p className="text-sm text-danger">
                Couldn&apos;t load your Saved and Official Pool positions.
              </p>
              <button
                type="button"
                onClick={refetch}
                className="mt-4 rounded-md border border-hairline-strong px-3 py-1.5 text-xs text-muted hover:bg-surface-2"
              >
                Retry
              </button>
            </section>
          ) : groups.length === 0 ? (
            officialStatus === 'loading' ? (
              <section className="rounded-xl border border-hairline bg-surface p-8 text-center" aria-busy="true">
                <p className="text-sm font-medium text-fg">Checking Pendle Official Pools…</p>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted">
                  Saved Pool reads are complete. Official positions will appear when discovery finishes.
                </p>
              </section>
            ) : officialDiscoveryError !== undefined ? (
              <section className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] p-8 text-center">
                <p className="text-sm font-medium text-warn">Official Pool coverage is incomplete</p>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted">
                  No Saved Pool positions were found, but OpenPendle could not confirm all Pendle
                  Official Pools. This is not a confirmed empty wallet.
                </p>
                <button
                  type="button"
                  onClick={refetch}
                  className="mt-4 rounded-md border border-[var(--op-warn-bd)] px-3 py-1.5 text-xs font-medium text-warn hover:bg-surface-2"
                >
                  Retry
                </button>
              </section>
            ) : (
              <section className="rounded-xl border border-hairline bg-surface p-8 text-center">
                <p className="text-sm font-medium text-fg">No PT, YT, or LP positions found</p>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted">
                  OpenPendle checked your Saved Pools and Pendle Official Pools. You can still save a
                  community market to include it here.
                </p>
                <div className="mt-4 flex items-center justify-center gap-4 text-sm">
                  <Link to="/explore" className="font-medium text-accent-ink hover:underline">
                    Explore markets →
                  </Link>
                  <Link to="/pools" className="font-medium text-muted hover:text-fg">
                    Saved pools
                  </Link>
                </div>
              </section>
            )
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <ChainGroup
                  key={group.chainId}
                  chainId={group.chainId}
                  items={group.items}
                  isActive={group.chainId === activeChainId}
                  user={user}
                  onSwitch={(chainId) => void selectChain(chainId)}
                  selectionDisabled={isSelectionDisabled}
                  onClaimed={refetch}
                />
              ))}
              {emptyCount > 0 && (
                <p className="text-center text-[12px] text-faint">
                  {emptyCount} market{emptyCount === 1 ? '' : 's'} with no PT, YT, LP, or claimable
                  rewards not shown.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
