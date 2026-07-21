/**
 * Live preflight checklist for the create-pool wizard (PLAN M6). Renders the
 * result of useDeployPreflight: a pass/fail line per hard check, the PT-reuse
 * notice, the legacy-parallel-PT warnings, and the binding eth_call simulation
 * status. The Deploy button (owned by the page) gates on preflight.ok.
 *
 * While the lib preflight stub returns 'idle' (pre-integration), we show a
 * neutral "waiting to preview" state — never a crash, never a false green.
 */

import type { DeployPreflight, QueryStatus } from '../../lib/types'
import { shortAddress } from '../format'

function Dot({ tone }: { tone: 'ok' | 'bad' | 'warn' | 'idle' }) {
  const cls =
    tone === 'ok'
      ? 'bg-accent'
      : tone === 'bad'
        ? 'bg-danger'
        : tone === 'warn'
          ? 'bg-warn'
          : 'bg-[var(--op-faint)]'
  return <span className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} aria-hidden />
}

function Line({
  tone,
  children,
}: {
  tone: 'ok' | 'bad' | 'warn' | 'idle'
  children: React.ReactNode
}) {
  const text =
    tone === 'ok'
      ? 'text-accent-ink/90'
      : tone === 'bad'
        ? 'text-danger'
        : tone === 'warn'
          ? 'text-warn'
          : 'text-muted'
  return (
    <li className="flex items-start gap-2">
      <Dot tone={tone} />
      <span className={`text-xs leading-relaxed ${text}`}>{children}</span>
    </li>
  )
}

/**
 * The six hard checks. `syValid` is a structured field; the rest are inferred
 * from the preflight's human error strings via conservative keyword matching
 * (a check reads "needs fixing" only when an error clearly names its topic).
 * Errors the keyword map attributes to a check line are consumed by it; only
 * the unattributed remainder renders in the verbatim list below, so a wording
 * the map misses is never hidden — and nothing shows twice.
 */
function hardChecks(pf: DeployPreflight): {
  checks: { label: string; ok: boolean }[]
  unattributed: string[]
} {
  const errs = pf.errors.map((e) => e.toLowerCase())
  const attributed = new Set<number>()
  const has = (...needles: string[]): boolean => {
    let hit = false
    errs.forEach((e, i) => {
      if (needles.some((n) => e.includes(n))) {
        attributed.add(i)
        hit = true
      }
    })
    return hit
  }
  const checks = [
    { label: 'Expiry is in the future and on a valid boundary', ok: !has('expiry') },
    { label: 'Rate band is valid (max > min)', ok: !has('band', 'ratemax', 'ratemin') },
    { label: 'Launch APY is strictly inside the band', ok: !has('desired', 'launch apy', 'implied rate') },
    { label: 'Fee is within the 5% cap', ok: !has('fee') },
    { label: 'SY implements IStandardizedYield', ok: pf.syValid },
    { label: 'Seed token is the SY or an accepted token', ok: !has('seed token', 'seed') },
  ]
  return {
    checks,
    unattributed: pf.errors.filter((_, i) => !attributed.has(i)),
  }
}

export function PreflightChecklist({
  step,
  status,
  preflight,
  error,
  incomplete,
}: {
  /** Wizard step number, rendered like the page's Section shell. */
  step?: number
  status: QueryStatus
  preflight?: DeployPreflight
  error?: string
  /** True when the page hasn't gathered enough inputs to preflight yet. */
  incomplete?: boolean
}) {
  return (
    <section className="rounded-[16px] border border-hairline bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          {step !== undefined && (
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-bg font-mono text-[11px] text-accent-ink">
              {step}
            </span>
          )}
          <h2 className="text-sm font-semibold text-fg">Preflight</h2>
        </div>
        {status === 'loading' && (
          <span className="text-xs text-faint">checking…</span>
        )}
      </div>

      {incomplete && status === 'idle' ? (
        <p className="mt-2 text-xs text-faint">
          Complete the form above to run the live checks.
        </p>
      ) : status === 'idle' ? (
        <p className="mt-2 text-xs text-faint">
          Preflight checks aren't available yet. Deploy stays disabled.
        </p>
      ) : status === 'error' ? (
        <p className="mt-2 text-xs text-danger">
          Couldn't run preflight: {error ?? 'the RPC read failed.'}
        </p>
      ) : preflight ? (
        (() => {
          // Deploy gates on the HARD checks only (FIX A) — not the advisory
          // simulation. `hardBlocked` drives the summary banner tone.
          const hardBlocked = preflight.errors.length > 0 || !preflight.syValid
          const { checks, unattributed } = hardChecks(preflight)
          return (
        <div className="mt-3 space-y-3">
          <ul className="space-y-1.5">
            {checks.map((c) => (
              <Line key={c.label} tone={c.ok ? 'ok' : 'bad'}>
                {c.ok ? (
                  <span className="sr-only">Passed: </span>
                ) : (
                  'Needs fixing: '
                )}
                {c.label}
              </Line>
            ))}
          </ul>

          {/* Errors the keyword map didn't attribute to a check line. */}
          {unattributed.length > 0 && (
            <ul className="space-y-1.5 border-t border-hairline pt-2.5">
              {unattributed.map((e, i) => (
                <Line key={i} tone="bad">
                  {e}
                </Line>
              ))}
            </ul>
          )}

          {/* PT-reuse notice + legacy parallel PTs + generic warnings. */}
          {(preflight.ptExistsOnActive ||
            preflight.legacyParallelPts.length > 0 ||
            preflight.warnings.length > 0) && (
            <ul className="space-y-1.5 border-t border-hairline pt-2.5">
              {preflight.ptExistsOnActive && (
                <Line tone="warn">
                  A PT already exists for this SY + expiry and will be reused
                  {preflight.existingPt
                    ? ` (${shortAddress(preflight.existingPt)})`
                    : ''}
                  .
                </Line>
              )}
              {preflight.legacyParallelPts.map((p) => (
                <Line key={p.pt} tone="warn">
                  An older-factory PT exists for this SY + expiry ({p.gen}:{' '}
                  {shortAddress(p.pt)}); your pool won't use it.
                </Line>
              ))}
              {preflight.warnings.map((w, i) => (
                <Line key={`w${i}`} tone="warn">
                  {w}
                </Line>
              ))}
            </ul>
          )}

          {/* Advisory binding-simulation status. The simulation is a HINT, not a
              gate: an ERC20/SY seed token not yet approved makes it revert with
              an allowance error, which is the expected pre-approval state — the
              Deploy button still reaches Approve → Confirm (FIX A). */}
          <div className="border-t border-hairline pt-2.5">
            {preflight.simulated ? (
              <Line tone="ok">
                Simulation passed — the deploy call succeeds from your address.
              </Line>
            ) : preflight.simulationPendingApproval ? (
              <Line tone="warn">
                Simulation will run after you approve the seed token — it
                doesn't block deploying.
              </Line>
            ) : preflight.simulationError ? (
              <Line tone="bad">
                Simulation failed: {preflight.simulationError}
              </Line>
            ) : (
              <Line tone="idle">
                Simulation runs once all checks pass.
              </Line>
            )}
          </div>

          <div
            className={`rounded-md px-3 py-2 text-xs font-medium ${
              hardBlocked
                ? 'border border-hairline bg-bg-2 text-muted'
                : 'border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink'
            }`}
          >
            {hardBlocked
              ? 'Deploy stays disabled until every check passes.'
              : 'Checks passed — approve the seed token, then deploy.'}
          </div>
        </div>
          )
        })()
      ) : null}
    </section>
  )
}
