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
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline py-2.5 last:border-b-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-right text-sm">{children}</span>
    </div>
  )
}

const tone = {
  good: 'text-accent-ink',
  warn: 'text-warn',
  bad: 'text-danger',
  neutral: 'text-muted',
} as const

export function TrustPanel({ market, sy, trust }: { market: Address; sy: Address; trust: TrustInfo }) {
  const defaultOpen = useFirstVisit(market)
  const [open, setOpen] = useState(defaultOpen)

  const ownerSummary = trust.syOwner
    ? trust.ownerIsPendleGovernance
      ? 'Pendle governance'
      : trust.ownerIsRenounced
        ? 'ownership renounced'
        : 'unknown owner'
    : 'owner unreadable'
  const proxySummary = trust.syIsProxy
    ? trust.adminIsPendleProxyAdmin
      ? 'Pendle proxyAdmin'
      : 'unknown proxy admin'
    : 'immutable'
  const summary = [ownerSummary, trust.syPaused ? 'paused' : 'not paused', proxySummary].join(' · ')
  const dotClass = trust.syPaused
    ? 'bg-danger'
    : ownerSummary === 'unknown owner' || proxySummary === 'unknown proxy admin' || !trust.syOwner
      ? 'bg-warn'
      : 'bg-good'

  return (
    <section className="rounded-xl border border-hairline bg-surface">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <h2 className="shrink-0 text-base font-semibold text-fg">Trust panel</h2>
          {!open && (
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
              <span className="truncate">{summary}</span>
            </span>
          )}
        </span>
        <span aria-hidden className="shrink-0 text-faint">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="border-t border-hairline px-5 pb-4 pt-1">
          <TrustRow label="SY contract">
            <AddressChip address={sy} />
          </TrustRow>

          <TrustRow label="SY owner">
            {trust.syOwner ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
                <span className="font-mono text-xs text-muted" title={trust.syOwner}>
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
            <ul className="mt-3 space-y-1 text-xs text-muted">
              {trust.notes.map((note) => (
                <li key={note} className="flex gap-1.5">
                  <span aria-hidden className="text-faint">
                    •
                  </span>
                  {note}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-4 border-t border-hairline pt-3 text-xs text-faint">
            OpenPendle verifies the market's factory, not the SY or the assets underneath.
          </p>
        </div>
      )}
    </section>
  )
}
