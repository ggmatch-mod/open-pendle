/**
 * MerklSection (M12-B) — the connected wallet's claimable Merkl rewards, on the
 * "My positions" page. Merkl keeps one Merkle root per chain and claims all of a
 * wallet's rewards at once, so this shows ALL claimable Merkl rewards per network
 * (every protocol, not only Pendle) and claims them in one transaction. Reads are
 * cross-chain; the claim runs on the ACTIVE chain (useActionFlow), so the active
 * chain claims live and others offer "Switch to <chain> to claim". Renders
 * nothing when the wallet has no claimable Merkl rewards anywhere.
 */

import { useMemo } from 'react'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import type { MerklChainRewards } from '../lib/hooks'
import type { SupportedChainId } from '../lib/types'
import { useActionFlow, useMerklRewards } from '../lib/hooks'
import { planMerklClaim } from '../lib/merkl'
import { supportedChain } from '../lib/addresses'
import { TxButton } from './TxButton'
import { TxStatus } from './TxStatus'
import { clampLabel, formatAmount } from './format'
import { useNetworkSelection } from './useNetworkSelection'

function MerklChainRow({
  group,
  isActive,
  user,
  onSwitch,
  selectionDisabled,
  onClaimed,
}: {
  group: MerklChainRewards
  isActive: boolean
  user?: Address
  onSwitch: (id: SupportedChainId) => void
  selectionDisabled: boolean
  onClaimed: () => void
}) {
  const chainName = supportedChain(group.chainId)?.name ?? `Chain ${group.chainId}`

  const plan = useMemo(() => {
    if (!isActive || user === undefined || group.rewards.length === 0) return null
    try {
      return planMerklClaim(user, group.rewards)
    } catch {
      return null
    }
  }, [isActive, user, group.rewards])

  const flow = useActionFlow(plan)

  return (
    <div className="rounded-[12px] border border-hairline bg-bg-2 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
          <p className="text-sm font-semibold text-fg">{chainName}</p>
        </div>
        <div className="w-full sm:w-52">
          {isActive ? (
            <TxButton
              flow={flow}
              actionLabel="Claim Merkl"
              disabledReason="Claim Merkl"
              onDone={() => {
                flow.reset()
                onClaimed()
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => onSwitch(group.chainId)}
              disabled={selectionDisabled}
              className="flex w-full items-center justify-center rounded-lg border border-[rgba(var(--op-accent-rgb),0.4)] px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-[rgba(var(--op-accent-rgb),0.08)] disabled:cursor-wait disabled:opacity-60"
            >
              Switch to {chainName} to claim
            </button>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {group.rewards.map((r) => (
          <span
            key={r.token}
            className="inline-flex items-center rounded-[8px] border border-hairline bg-surface px-2 py-1 text-[12px] text-fg tabular-nums"
          >
            {formatAmount(r.claimable, r.decimals)} {clampLabel(r.symbol, 14)}
          </span>
        ))}
      </div>

      {isActive && (
        <div className="mt-2">
          <TxStatus flow={flow} />
        </div>
      )}
    </div>
  )
}

export function MerklSection() {
  const { isConnected, address: user } = useAccount()
  const { chainId: activeChainId, selectChain, isSelectionDisabled } = useNetworkSelection()
  const { byChain, refetch } = useMerklRewards()

  // Active chain first, then the rest in their fetched order.
  const ordered = useMemo(
    () =>
      [...byChain].sort((a, b) =>
        a.chainId === activeChainId ? -1 : b.chainId === activeChainId ? 1 : 0,
      ),
    [byChain, activeChainId],
  )

  // Render nothing until there is something to claim (covers loading + none).
  if (!isConnected || byChain.length === 0) return null

  return (
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <div>
        <h2 className="text-base font-semibold text-fg">Merkl rewards</h2>
        <p className="mt-0.5 text-[12px] text-muted">
          All your claimable{' '}
          <a
            href="https://merkl.angle.money/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-ink hover:underline"
          >
            Merkl
          </a>{' '}
          rewards across networks — every protocol, not only Pendle. Claimed in one transaction per
          network, straight from the Merkl distributor.
        </p>
      </div>

      <div className="mt-4 space-y-2.5">
        {ordered.map((g) => (
          <MerklChainRow
            key={g.chainId}
            group={g}
            isActive={g.chainId === activeChainId}
            user={user}
            onSwitch={(chainId) => void selectChain(chainId)}
            selectionDisabled={isSelectionDisabled}
            onClaimed={refetch}
          />
        ))}
      </div>
    </section>
  )
}
