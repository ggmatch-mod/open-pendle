/**
 * Parameter-education panel (PLAN M6, REQUIRED). Three jobs:
 *  (a) a VISUAL of the immutable implied-APY band [rateMin, rateMax] with the
 *      desired-rate marker and the derived initial PT proportion;
 *  (b) the permanence + long-yield copy (rate band is forever; seeder gets
 *      LP *plus* YT);
 *  (c) an "advanced details" expander for the derived scalarRoot / anchor /
 *      lnFeeRateRoot (from the lib's floating-point mirror, DISPLAY ONLY).
 *
 * The derived numbers come from useDeployPreflight's preflight.derived, which
 * is undefined while the lib stub is idle/throwing — the visual degrades to
 * "computed on preview" instead of crashing.
 */

import type { DerivedDeployParams } from '../../lib/types'
import { formatPercent } from '../format'
import { scaledToFraction } from './configMath'

function pct(v: number): string {
  return formatPercent(v, 2)
}

/**
 * Horizontal band visual. Positions the desired marker within [min, max]; if
 * the desired rate is outside the band we clamp the marker to the edge and
 * flag it red (the inline validator also blocks it).
 */
function BandBar({
  minFrac,
  maxFrac,
  desiredFrac,
  proportion,
}: {
  minFrac: number
  maxFrac: number
  desiredFrac: number
  /** initial PT proportion 0..1, or undefined while not yet derived. */
  proportion?: number
}) {
  const span = maxFrac - minFrac
  const rawPos = span > 0 ? (desiredFrac - minFrac) / span : 0.5
  const inBand = desiredFrac > minFrac && desiredFrac < maxFrac
  const clamped = Math.max(0, Math.min(1, rawPos))
  const leftPct = `${clamped * 100}%`

  return (
    <div className="mt-3">
      <div className="relative h-10">
        {/* the band track */}
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-[rgba(var(--op-accent-rgb),0.15)] via-[rgba(var(--op-accent-rgb),0.32)] to-[rgba(var(--op-accent-rgb),0.15)] ring-1 ring-inset ring-[rgba(var(--op-accent-rgb),0.4)]" />
        {/* desired marker */}
        <div
          className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
          style={{ left: leftPct }}
        >
          <div
            className={`h-6 w-0.5 ${inBand ? 'bg-accent' : 'bg-danger'}`}
            aria-hidden
          />
          <span
            className={`mt-0.5 whitespace-nowrap text-[10px] font-semibold ${
              inBand ? 'text-accent-ink' : 'text-danger'
            }`}
          >
            {pct(desiredFrac)}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>
          <span className="text-faint">min </span>
          {pct(minFrac)}
        </span>
        <span className="text-faint">immutable trading range</span>
        <span>
          <span className="text-faint">max </span>
          {pct(maxFrac)}
        </span>
      </div>
      <div className="mt-2 rounded-md border border-hairline bg-bg-2 px-2.5 py-1.5 text-[11px] text-muted">
        Launch PT proportion:{' '}
        <span className="font-medium text-fg">
          {proportion !== undefined ? pct(proportion) : '—'}
        </span>{' '}
        of the pool starts as PT.
      </div>
    </div>
  )
}

function DerivedRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-faint">{label}</span>
        <span className="font-mono text-xs text-muted">{value}</span>
      </div>
      {hint && <p className="text-[11px] leading-snug text-faint">{hint}</p>}
    </div>
  )
}

export function PoolParamEducation({
  rateMin,
  rateMax,
  desired,
  derived,
}: {
  /** 1e18-scaled band edges + desired rate; undefined while inputs are blank. */
  rateMin?: bigint
  rateMax?: bigint
  desired?: bigint
  /** From preflight.derived — undefined while the lib stub is idle. */
  derived?: DerivedDeployParams
}) {
  const minFrac = rateMin !== undefined ? scaledToFraction(rateMin) : undefined
  const maxFrac = rateMax !== undefined ? scaledToFraction(rateMax) : undefined
  const desiredFrac = desired !== undefined ? scaledToFraction(desired) : undefined
  const showBar =
    minFrac !== undefined &&
    maxFrac !== undefined &&
    desiredFrac !== undefined &&
    maxFrac > minFrac

  return (
    <section className="rounded-xl border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.08)] p-4">
      <h2 className="text-sm font-semibold text-accent-ink">
        Before you deploy
      </h2>

      {showBar ? (
        <BandBar
          minFrac={minFrac}
          maxFrac={maxFrac}
          desiredFrac={desiredFrac}
          proportion={derived?.initialProportion}
        />
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-hairline bg-bg/50 px-3 py-4 text-center text-xs text-faint">
          Enter a rate band and a launch APY to see the immutable trading range.
        </p>
      )}

      <div className="mt-4 space-y-2 text-xs leading-relaxed text-fg/80">
        <p className="rounded-md border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-[12.5px] text-warn">
          The rate band is permanent. If the pool's implied APY leaves this
          range, trading stops — the only fix is deploying a new pool.
        </p>
        <p>
          Seeding mints PT and YT: you keep the LP plus the YT, so you're long
          yield until you sell the YT.
        </p>
      </div>

      <details className="group mt-3 rounded-lg border border-hairline bg-bg/50">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted hover:text-fg">
          Advanced: derived on-chain parameters
        </summary>
        <div className="border-t border-hairline px-3 py-2">
          {derived ? (
            <>
              <DerivedRow
                label="scalarRoot"
                value={derived.scalarRoot.toString()}
                hint="Curve steepness — derived from the band width and tenor."
              />
              <DerivedRow
                label="initialAnchor"
                value={derived.initialAnchor.toString()}
                hint="Sets the launch implied rate inside the band."
              />
              <DerivedRow
                label="lnFeeRateRoot"
                value={derived.lnFeeRateRoot.toString()}
                hint="ln(1 + fee) — the rate-terms swap fee."
              />
              <DerivedRow
                label="years to expiry"
                value={derived.yearsToExpiry.toFixed(4)}
              />
              <p className="mt-2 text-[11px] leading-snug text-faint">
                Preview values — the transaction computes the exact numbers
                on-chain.
              </p>
            </>
          ) : (
            <p className="py-1 text-xs text-faint">
              Complete the form to see derived parameters.
            </p>
          )}
        </div>
      </details>
    </section>
  )
}
