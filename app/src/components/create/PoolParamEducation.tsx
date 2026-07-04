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
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-emerald-900/40 via-emerald-700/40 to-emerald-900/40 ring-1 ring-inset ring-emerald-800/60" />
        {/* desired marker */}
        <div
          className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
          style={{ left: leftPct }}
        >
          <div
            className={`h-6 w-0.5 ${inBand ? 'bg-emerald-300' : 'bg-red-400'}`}
            aria-hidden
          />
          <span
            className={`mt-0.5 whitespace-nowrap text-[10px] font-semibold ${
              inBand ? 'text-emerald-300' : 'text-red-400'
            }`}
          >
            {pct(desiredFrac)}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-zinc-400">
        <span>
          <span className="text-zinc-500">min </span>
          {pct(minFrac)}
        </span>
        <span className="text-zinc-500">immutable trading range</span>
        <span>
          <span className="text-zinc-500">max </span>
          {pct(maxFrac)}
        </span>
      </div>
      <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5 text-[11px] text-zinc-400">
        Launch PT proportion:{' '}
        <span className="font-medium text-zinc-200">
          {proportion !== undefined ? pct(proportion) : 'computed on preview'}
        </span>{' '}
        of the pool starts as PT.
      </div>
    </div>
  )
}

function DerivedRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-zinc-500" title={hint}>
        {label}
      </span>
      <span className="font-mono text-xs text-zinc-300">{value}</span>
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
    <section className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-4">
      <h2 className="text-sm font-semibold text-emerald-300">
        Read this before you deploy
      </h2>

      {showBar ? (
        <BandBar
          minFrac={minFrac}
          maxFrac={maxFrac}
          desiredFrac={desiredFrac}
          proportion={derived?.initialProportion}
        />
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-zinc-800 bg-zinc-950/50 px-3 py-4 text-center text-xs text-zinc-500">
          Enter a rate band and a launch APY to see the immutable trading range.
        </p>
      )}

      <div className="mt-4 space-y-2.5 text-xs leading-relaxed text-emerald-100/80">
        <p>
          <span className="font-semibold text-amber-300">
            This rate band is PERMANENT.
          </span>{' '}
          If the pool's implied APY ever leaves the range above, the pool goes
          out of range and can't be traded — you'd need to deploy a new one. The
          band maps to an immutable scalarRoot / anchor at deploy time and can
          never be changed.
        </p>
        <p>
          <span className="font-semibold text-emerald-300">
            Seeding mints PT + YT and gives you the LP plus the YT.
          </span>{' '}
          You'll be long yield until you sell the YT — the YT lands in your
          wallet alongside the LP position. That's expected; it's how the seed
          liquidity is created.
        </p>
        <p className="text-emerald-200/60">
          Pendle's own guidance: seed a small amount first (under ~$10), confirm
          the pool lists and trades, then top up liquidity from the pool page.
        </p>
      </div>

      <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/50">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200">
          Advanced: derived on-chain parameters
        </summary>
        <div className="border-t border-zinc-800 px-3 py-2">
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
              <p className="mt-2 text-[11px] leading-snug text-zinc-600">
                These are a client-side floating-point mirror for preview only.
                The deploy transaction recomputes them on-chain from your inputs.
              </p>
            </>
          ) : (
            <p className="py-1 text-xs text-zinc-500">
              Derived parameters appear once the live preview computes them from
              a complete, valid configuration.
            </p>
          )}
        </div>
      </details>
    </section>
  )
}
