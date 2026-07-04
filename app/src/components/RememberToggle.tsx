/**
 * RememberToggle — the product's signature interaction (PLAN §3.3, user
 * requirement #8). A prominent checkbox: ticked = pool saved to the
 * localStorage registry; unticking forgets it instantly.
 */

import type { MarketSnapshot } from '../lib/types'
import { useRegistry } from '../lib/hooks'

export function RememberToggle({ snapshot }: { snapshot: MarketSnapshot }) {
  const { isSaved, save, forget } = useRegistry()
  const saved = isSaved(snapshot.address)

  // Markets no known Pendle factory validates must never enter the registry
  // (the saved list re-renders them on the home grid with cached labels —
  // exactly the laundering a fake market wants).
  if (!snapshot.validated) {
    return (
      <div className="max-w-56">
        <label className="flex cursor-not-allowed select-none items-center gap-2.5 rounded-xl border border-hairline bg-surface px-4 py-2.5 text-faint">
          <input type="checkbox" checked={false} disabled readOnly className="h-4 w-4" />
          <span className="text-sm font-medium">Remember this pool</span>
        </label>
        <p className="mt-1.5 text-xs text-faint">
          unvalidated markets can't be remembered
        </p>
      </div>
    )
  }

  return (
    <div>
      <label
        className={`flex cursor-pointer select-none items-center gap-2.5 rounded-[16px] border px-4 py-2.5 transition ${
          saved
            ? 'border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink'
            : 'border-hairline-strong bg-surface text-muted hover:border-[rgba(var(--op-accent-rgb),0.4)] hover:text-fg'
        }`}
      >
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => {
            if (e.target.checked) save(snapshot)
            else forget(snapshot.address)
          }}
          className="sr-only"
        />
        <span
          className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm border transition ${
            saved
              ? 'border-transparent bg-accent text-accent-fg'
              : 'border-hairline-strong bg-surface text-transparent'
          }`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6.5 5 9l4.5-5.5" />
          </svg>
        </span>
        <span className="text-sm font-medium">
          {saved ? 'Remembered' : 'Remember this pool'}
        </span>
      </label>
      {/* Nudge for pool creators — incentivize this pool's LPs via Merkl (v1.5
          will surface active campaigns in-app; for now this deep-links out). */}
      <p className="mt-1.5 text-xs text-faint">
        Is this your Pool? You can add incentives over at{' '}
        <a
          href="https://studio.merkl.xyz/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-ink underline decoration-dotted underline-offset-2 hover:text-accent-ink"
        >
          Merkl
        </a>
      </p>
    </div>
  )
}
