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
        <label className="flex cursor-not-allowed select-none items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-2.5 text-zinc-500">
          <input type="checkbox" checked={false} disabled readOnly className="h-4 w-4" />
          <span className="text-sm font-medium">Remember this pool</span>
        </label>
        <p className="mt-1.5 text-xs text-zinc-500">
          unvalidated markets can't be remembered
        </p>
      </div>
    )
  }

  return (
    <div>
      <label
        className={`flex cursor-pointer select-none items-center gap-2.5 rounded-xl border px-4 py-2.5 transition ${
          saved
            ? 'border-emerald-700 bg-emerald-950/50 text-emerald-300'
            : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-emerald-800 hover:text-zinc-100'
        }`}
      >
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => {
            if (e.target.checked) save(snapshot)
            else forget(snapshot.address)
          }}
          className="h-4 w-4 accent-emerald-500"
        />
        <span className="text-sm font-medium">
          {saved ? 'Remembered' : 'Remember this pool'}
        </span>
      </label>
      {/* Nudge for pool creators — incentivize this pool's LPs via Merkl (v1.5
          will surface active campaigns in-app; for now this deep-links out). */}
      <p className="mt-1.5 text-xs text-zinc-500">
        Is this your Pool? You can add incentives over at{' '}
        <a
          href="https://studio.merkl.xyz/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-400 underline decoration-dotted underline-offset-2 hover:text-emerald-300"
        >
          Merkl
        </a>
      </p>
    </div>
  )
}
