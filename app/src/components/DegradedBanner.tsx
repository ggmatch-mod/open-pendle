/**
 * DegradedBanner — names the on-chain probes that failed, with a heading that
 * reflects the actual cause (PLAN M1):
 *   - unvalidated market → render NOTHING here; MarketPage's red
 *     "Not validated by any Pendle factory" banner owns that state entirely.
 *   - validated legacy vintage (v1/V3/V4/V5) → "Legacy market — limited support".
 *   - validated active vintage with degraded probes → "Some data unavailable"
 *     (neutral styling — an active market with a flaky probe is not "legacy").
 */

import type { Vintage } from '../lib/types'

export function DegradedBanner({
  degraded,
  validated,
  vintage,
}: {
  degraded: string[]
  validated: boolean
  vintage: Vintage
}) {
  // Unvalidated markets get the prominent red banner on MarketPage instead —
  // don't stack a second banner on top of it.
  if (!validated) return null
  if (degraded.length === 0) return null

  const legacy = vintage !== 'active'

  return (
    <div
      role="status"
      className={`rounded-xl border p-4 ${
        legacy ? 'border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)]' : 'border-hairline-strong bg-surface/70'
      }`}
    >
      <p className={`text-sm font-medium ${legacy ? 'text-warn' : 'text-fg'}`}>
        {legacy ? 'Legacy market — limited support' : 'Some data unavailable'}
      </p>
      <p className={`mt-1 text-xs ${legacy ? 'text-warn' : 'text-muted'}`}>
        {legacy
          ? 'Some on-chain probes failed, so parts of this page are incomplete. Older market generations load best-effort:'
          : 'Some on-chain probes failed, so parts of this page are incomplete:'}
      </p>
      <ul
        className={`mt-2 list-inside list-disc space-y-0.5 text-xs ${
          legacy ? 'text-warn' : 'text-muted'
        }`}
      >
        {degraded.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
