/**
 * TrustPanel — per-pool trust disclosure (PLAN §3.4). Valid market ≠ safe
 * market: the SY underneath is permissionless, untrusted code. This panel
 * surfaces SY provenance, owner, paused state and upgradeability.
 *
 * Collapsible; defaults open the first time a given market is viewed
 * (tracked in localStorage), collapsed afterwards.
 */

import { useState } from 'react'
import type { Address } from 'viem'
import type { ReactNode } from 'react'
import type { TrustInfo } from '../lib/types'
import { AddressChip } from './AddressChip'
import { shortAddress } from './format'

const SEEN_KEY = 'openpendle.trustseen.v1'

function readSeen(): string[] {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** True on the first visit of this market; marks it seen as a side effect. */
function useFirstVisit(market: Address): boolean {
  const [first] = useState(() => {
    const seen = readSeen()
    const key = market.toLowerCase()
    if (seen.includes(key)) return false
    try {
      window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, key].slice(-200)))
    } catch {
      // localStorage unavailable — default to open every time, safer anyway.
    }
    return true
  })
  return first
}

function TrustRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-zinc-800 py-2.5 last:border-b-0">
      <span className="text-sm text-zinc-400">{label}</span>
      <span className="text-right text-sm">{children}</span>
    </div>
  )
}

const tone = {
  good: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-red-400',
  neutral: 'text-zinc-300',
} as const

export function TrustPanel({ market, sy, trust }: { market: Address; sy: Address; trust: TrustInfo }) {
  const defaultOpen = useFirstVisit(market)
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="flex items-center gap-2.5">
          <h2 className="text-base font-semibold text-zinc-100">Trust panel</h2>
          <span className="rounded-full border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 text-xs text-zinc-400">
            valid market ≠ safe SY
          </span>
        </span>
        <span aria-hidden className="text-zinc-500">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 px-5 pb-4 pt-1">
          <TrustRow label="SY contract">
            <AddressChip address={sy} />
          </TrustRow>

          <TrustRow label="SY owner">
            {trust.syOwner ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
                <span className="font-mono text-xs text-zinc-400" title={trust.syOwner}>
                  {shortAddress(trust.syOwner)}
                </span>
                {trust.ownerIsPendleGovernance ? (
                  <span className={tone.good}>Pendle governance</span>
                ) : trust.ownerIsRenounced ? (
                  <span className={tone.good}>
                    ownership renounced — no one can pause this SY
                  </span>
                ) : (
                  <span className={tone.warn}>unknown owner — can pause this SY</span>
                )}
              </span>
            ) : (
              <span className={tone.neutral}>not readable</span>
            )}
          </TrustRow>

          <TrustRow label="Paused">
            {trust.syPaused === undefined ? (
              <span className={tone.neutral}>not readable</span>
            ) : trust.syPaused ? (
              <span className={`font-medium ${tone.bad}`}>yes — deposits/redeems blocked</span>
            ) : (
              <span className={tone.neutral}>no</span>
            )}
          </TrustRow>

          <TrustRow label="Upgradeability">
            {trust.syIsProxy ? (
              trust.adminIsPendleProxyAdmin ? (
                <span className={tone.good}>upgradeable proxy — admin: Pendle proxyAdmin</span>
              ) : (
                <span className={tone.warn}>
                  upgradeable proxy — unknown admin
                  {trust.syProxyAdmin ? ` (${shortAddress(trust.syProxyAdmin)})` : ''}
                </span>
              )
            ) : (
              <span className={tone.neutral}>not a proxy (immutable)</span>
            )}
          </TrustRow>

          {trust.notes.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-zinc-400">
              {trust.notes.map((note) => (
                <li key={note} className="flex gap-1.5">
                  <span aria-hidden className="text-zinc-600">
                    •
                  </span>
                  {note}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-4 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
            OpenPendle verifies market provenance, not the safety of the SY or its
            assets.
          </p>
        </div>
      )}
    </section>
  )
}
