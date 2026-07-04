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
          ? 'bg-amber-400'
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
        ? 'text-red-200/90'
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
 * The full, verbatim error list still renders separately below, so a wording
 * the keyword map misses is never hidden — it just also shows there.
 */
function hardChecks(pf: DeployPreflight): { label: string; ok: boolean }[] {
  const errs = pf.errors.map((e) => e.toLowerCase())
  const has = (...needles: string[]): boolean =>
    errs.some((e) => needles.some((n) => e.includes(n)))
  return [
    { label: 'Expiry is in the future and divisor-aligned', ok: !has('expiry') },
    { label: 'Rate band is valid (max > min)', ok: !has('band', 'ratemax', 'ratemin') },
    { label: 'Launch APY is strictly inside the band', ok: !has('desired', 'launch apy', 'implied rate') },
    { label: 'Fee is within the 5% cap', ok: !has('fee') },
    { label: 'SY implements IStandardizedYield', ok: pf.syValid },
    { label: 'Seed token is the SY or an accepted token', ok: !has('seed token', 'seed') },
  ]
}

export function PreflightChecklist({
  status,
  preflight,
  error,
  incomplete,
}: {
  status: QueryStatus
  preflight?: DeployPreflight
  error?: string
  /** True when the page hasn't gathered enough inputs to preflight yet. */
  incomplete?: boolean
}) {
  return (
    <section className="rounded-xl border border-hairline bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg">Preflight</h2>
        {status === 'loading' && (
          <span className="text-xs text-faint">checking…</span>
        )}
      </div>

      {incomplete && status === 'idle' ? (
        <p className="mt-2 text-xs text-faint">
          Fill in the SY, expiry, rate band, launch APY, fee and a seed amount to
          run the live checks and the binding on-chain simulation.
        </p>
      ) : status === 'idle' ? (
        <p className="mt-2 text-xs text-faint">
          The live preflight is not available yet — the checklist and binding
          simulation will run here once the deploy data layer is wired. Deploy
          stays disabled until every hard check passes.
        </p>
      ) : status === 'error' ? (
        <p className="mt-2 text-xs text-danger">
          Couldn't run preflight: {error ?? 'the RPC read failed.'} Deploy stays
          disabled.
        </p>
      ) : preflight ? (
        (() => {
          // Deploy gates on the HARD checks only (FIX A) — not the advisory
          // simulation. `hardBlocked` drives the summary banner tone.
          const hardBlocked = preflight.errors.length > 0 || !preflight.syValid
          return (
        <div className="mt-3 space-y-3">
          <ul className="space-y-1.5">
            {hardChecks(preflight).map((c) => (
              <Line key={c.label} tone={c.ok ? 'ok' : 'bad'}>
                {c.ok ? '' : 'Needs fixing: '}
                {c.label}
              </Line>
            ))}
          </ul>

          {/* Extra hard errors the keyword map didn't attribute to a line. */}
          {preflight.errors.length > 0 && (
            <ul className="space-y-1.5 border-t border-hairline pt-2.5">
              {preflight.errors.map((e, i) => (
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
                  A PT already exists for this SY + expiry on the active factory —
                  it will be reused
                  {preflight.existingPt
                    ? ` (${shortAddress(preflight.existingPt)})`
                    : ''}
                  . This is normal, not an error.
                </Line>
              )}
              {preflight.legacyParallelPts.map((p) => (
                <Line key={p.pt} tone="warn">
                  A parallel PT for this SY + expiry exists on a legacy factory
                  ({p.gen}: {shortAddress(p.pt)}) — informational only; your new
                  pool uses the active generation.
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
                Binding simulation passed — the exact deploy call succeeds from
                your address.
              </Line>
            ) : preflight.simulationPendingApproval ? (
              <Line tone="warn">
                Advisory simulation pending — approve the seed token first, then
                it runs against your allowance. This does not block deploying.
              </Line>
            ) : preflight.simulationError ? (
              <Line tone="bad">
                Advisory simulation reverted: {preflight.simulationError}
              </Line>
            ) : (
              <Line tone="idle">
                Advisory simulation runs once every hard check passes.
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
              ? 'Deploy stays disabled until every hard check passes.'
              : 'Hard checks passed — approve the seed token, then deploy.'}
          </div>
        </div>
          )
        })()
      ) : null}
    </section>
  )
}
