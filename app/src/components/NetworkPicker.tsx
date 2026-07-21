/**
 * NetworkPicker — the shared chain-selection radiogroup, rendered as a
 * two-column grid. Hosted by the header dropdown (NetworkSelector), the
 * Profile panel, and MobileNav so all three stay identical in semantics
 * and visuals.
 *
 * Selection goes through useNetworkSelection: it updates app reads and asks a
 * connected wallet to switch to the same chain. Buttons disable while a chain
 * switch or transaction is pending.
 */

import { SUPPORTED_CHAINS } from '../lib/addresses'
import { useNetworkSelection } from './useNetworkSelection'

export function NetworkPicker({
  className,
  onSelect,
}: {
  /** Extra classes for the radiogroup grid (host-specific spacing). */
  className?: string
  /** Called after a chain is picked — hosts use it to close their popover. */
  onSelect?: () => void
}) {
  const { chainId, selectChain, isSelectionDisabled } = useNetworkSelection()

  return (
    <div
      role="radiogroup"
      aria-label="Select active network"
      className={`grid grid-cols-2 gap-1${className ? ` ${className}` : ''}`}
    >
      {SUPPORTED_CHAINS.map((chain) => {
        const active = chain.id === chainId
        return (
          <button
            key={chain.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={isSelectionDisabled}
            onClick={() => {
              void selectChain(chain.id)
              onSelect?.()
            }}
            className={`flex min-h-9 items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-[11.5px] disabled:cursor-wait disabled:opacity-60 ${
              active
                ? 'bg-[rgba(var(--op-accent-rgb),0.12)] font-semibold text-accent-ink'
                : 'text-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-[var(--op-faint)]'}`}
            />
            <span className="truncate">{chain.name}</span>
          </button>
        )
      })}
    </div>
  )
}
