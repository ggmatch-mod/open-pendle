/**
 * CreatePoolPage — /create. The M6 community-pool creation wizard: a single
 * scrollable page that gathers a PoolConfig, teaches the immutable-band /
 * long-yield facts, runs a live preflight, and deploys + seeds through
 * commonDeploy.deploy5115MarketAndSeedLiquidity via the M2 action machinery.
 *
 * Data-layer boundary: this page CONSUMES lib/deploy.ts (planDeployPool,
 * computeDeployParams — both currently THROW) and lib/hooks.ts
 * (useDeployPreflight — currently 'idle', useActionFlow — live). Every call
 * into a throwing stub is guarded so the page renders safe idle states: the
 * education visual works, inputs validate locally, Deploy stays disabled, and
 * nothing crashes while integration is pending.
 */

import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import type { ActionPlan, DerivedDeployParams, PoolConfig } from '../lib/types'
import { computeDeployParams, planDeployPool } from '../lib/deploy'
import { useActionFlow, useDeployPreflight } from '../lib/hooks'
import { AmountInput } from '../components/AmountInput'
import { TxButton } from '../components/TxButton'
import { TxStatus } from '../components/TxStatus'
import { clampLabel, shortAddress } from '../components/format'
import { parseAmount } from '../components/parseAmount'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { PoolParamEducation } from '../components/create/PoolParamEducation'
import { PreflightChecklist } from '../components/create/PreflightChecklist'
import { DeployRecovery } from '../components/create/DeployRecovery'
import { DeploySuccess } from '../components/create/DeploySuccess'
import {
  useExpiryDivisor,
  useSyMeta,
  useTokenBalance,
  type SeedTokenMeta,
} from '../components/create/createReads'
import {
  bandMidpoint,
  dateInputToUnix,
  daysToExpiry,
  defaultFee,
  FEE_CAP_SCALED,
  formatUtcDateTime,
  isExpiryAligned,
  nextThursdayUtc,
  parsePercent,
  snapExpiry,
  unixToDateInput,
} from '../components/create/configMath'

// ---------------------------------------------------------------------------
// Section shell
// ---------------------------------------------------------------------------

function Section({
  step,
  title,
  subtitle,
  children,
}: {
  step: number
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-baseline gap-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 text-xs font-semibold text-zinc-400">
          {step}
        </span>
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null
  return <p className="mt-1 text-xs text-red-400">{msg}</p>
}

function PercentField({
  label,
  value,
  onChange,
  placeholder,
  error,
  disabled,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  error?: string
  disabled?: boolean
  hint?: string
}) {
  return (
    <div>
      <label className="text-xs text-zinc-500">{label}</label>
      <div
        className={`mt-1 flex items-center gap-2 rounded-lg border bg-zinc-950 px-3 py-2 focus-within:border-emerald-500 ${
          error ? 'border-red-800' : 'border-zinc-700'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder ?? '0.0'}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value
            if (next === '' || /^\d*[.,]?\d*$/.test(next)) onChange(next)
          }}
          className="min-w-0 flex-1 bg-transparent text-base font-medium text-zinc-100 placeholder-zinc-600 outline-none disabled:cursor-not-allowed"
        />
        <span className="shrink-0 text-sm text-zinc-500">%</span>
      </div>
      {error ? <FieldError msg={error} /> : hint ? (
        <p className="mt-1 text-[11px] text-zinc-600">{hint}</p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CreatePoolPage() {
  useDocumentTitle('Create a community pool')
  const { address: user } = useAccount()

  // --- SY input (prefilled from ?sy= when arriving from the M7 SY wizard) ---
  const [searchParams] = useSearchParams()
  const [syInput, setSyInput] = useState(() => searchParams.get('sy') ?? '')
  const syMeta = useSyMeta(syInput)
  const sy: Address | undefined = syMeta.meta?.address

  // --- expiry ---
  const expiryDivisor = useExpiryDivisor()
  const [expiryDate, setExpiryDate] = useState<string>(() =>
    unixToDateInput(nextThursdayUtc()),
  )
  const expiryUnixRaw = dateInputToUnix(expiryDate)
  const expiryUnix =
    expiryUnixRaw !== undefined ? snapExpiry(expiryUnixRaw, expiryDivisor) : undefined
  const nowSec = Date.now() / 1000
  const expiryInFuture = expiryUnix !== undefined && expiryUnix > nowSec
  const expiryAligned =
    expiryUnix !== undefined && isExpiryAligned(expiryUnix, expiryDivisor)

  // --- rate band ---
  const [minInput, setMinInput] = useState('2')
  const [maxInput, setMaxInput] = useState('20')
  const minParse = parsePercent(minInput)
  const maxParse = parsePercent(maxInput)
  const rateMin = minParse.scaled
  const rateMax = maxParse.scaled
  const bandValid =
    rateMin !== undefined && rateMax !== undefined && rateMax > rateMin
  const bandError =
    rateMin !== undefined && rateMax !== undefined && rateMax <= rateMin
      ? 'Max must be greater than min.'
      : (maxParse.error ?? minParse.error)

  // --- desired launch APY (default = band midpoint) ---
  const [desiredInput, setDesiredInput] = useState('')
  const desiredParse = parsePercent(desiredInput)
  // Default to the midpoint when left blank and the band is valid.
  const desiredScaled = useMemo<bigint | undefined>(() => {
    if (desiredParse.scaled !== undefined) return desiredParse.scaled
    if (bandValid && rateMin !== undefined && rateMax !== undefined) {
      return bandMidpoint(rateMin, rateMax)
    }
    return undefined
  }, [desiredParse.scaled, bandValid, rateMin, rateMax])
  const desiredInBand =
    desiredScaled !== undefined &&
    rateMin !== undefined &&
    rateMax !== undefined &&
    desiredScaled > rateMin &&
    desiredScaled < rateMax
  const desiredError = (() => {
    if (desiredParse.error) return desiredParse.error
    if (desiredScaled !== undefined && bandValid && !desiredInBand) {
      return 'Launch APY must be strictly inside the band.'
    }
    return undefined
  })()

  // --- fee (default rateMax/25, max 5%) ---
  const [feeInput, setFeeInput] = useState('')
  const feeParse = parsePercent(feeInput)
  const feeScaled = useMemo<bigint | undefined>(() => {
    if (feeParse.scaled !== undefined) return feeParse.scaled
    if (rateMax !== undefined) return defaultFee(rateMax)
    return undefined
  }, [feeParse.scaled, rateMax])
  const feeOverCap = feeScaled !== undefined && feeScaled > FEE_CAP_SCALED
  const feeError = feeParse.error ?? (feeOverCap ? 'Fee cannot exceed 5%.' : undefined)

  // --- seed token + amount ---
  // Memoize on the query's stable meta identity (TanStack returns a stable
  // `data` reference between renders) so the array isn't a fresh reference
  // every render — otherwise the activeSeedToken memo below never actually memos.
  const seedTokens: SeedTokenMeta[] = useMemo(
    () => syMeta.meta?.seedTokens ?? [],
    [syMeta.meta],
  )
  const [seedTokenAddr, setSeedTokenAddr] = useState<string>('')
  // Default the seed token to the SY itself once metadata arrives.
  const activeSeedToken: SeedTokenMeta | undefined = useMemo(() => {
    if (seedTokens.length === 0) return undefined
    const picked = seedTokens.find(
      (t) => `${t.address}:${t.isSy}` === seedTokenAddr,
    )
    return picked ?? seedTokens[0]
  }, [seedTokens, seedTokenAddr])
  const isNativeSeed = activeSeedToken?.isNative ?? false
  const seedBalance = useTokenBalance(activeSeedToken?.address, user, isNativeSeed)

  const [seedAmountInput, setSeedAmountInput] = useState('')
  const seedParsed =
    activeSeedToken !== undefined
      ? parseAmount(seedAmountInput, activeSeedToken.decimals)
      : { amount: undefined, error: undefined }
  const seedAmount = seedParsed.amount
  const seedOverBalance =
    seedAmount !== undefined &&
    seedBalance.balance !== undefined &&
    seedAmount > seedBalance.balance
  const seedError =
    seedParsed.error ?? (seedOverBalance ? 'Amount exceeds your balance.' : undefined)

  // --- assembled config ---
  const config: PoolConfig | undefined = useMemo(() => {
    if (
      expiryUnix === undefined ||
      rateMin === undefined ||
      rateMax === undefined ||
      desiredScaled === undefined ||
      feeScaled === undefined
    ) {
      return undefined
    }
    return {
      expiry: expiryUnix,
      rateMin,
      rateMax,
      desiredImpliedRate: desiredScaled,
      fee: feeScaled,
    }
  }, [expiryUnix, rateMin, rateMax, desiredScaled, feeScaled])

  // --- derived params (education visual) — computeDeployParams THROWS pre-integration ---
  const derived: DerivedDeployParams | undefined = useMemo(() => {
    if (!config) return undefined
    try {
      return computeDeployParams(config, Math.floor(nowSec))
    } catch {
      return undefined
    }
  }, [config, nowSec])

  // --- live preflight (idle until the data layer is wired) ---
  const configComplete =
    config !== undefined &&
    sy !== undefined &&
    activeSeedToken !== undefined &&
    seedAmount !== undefined &&
    seedAmount > 0n
  const preflight = useDeployPreflight(
    sy,
    config,
    activeSeedToken?.address,
    seedAmount,
  )
  const derivedForVisual = preflight.preflight?.derived ?? derived

  // --- deploy plan ---
  // FIX A (deadlock): the plan is built from the LOCAL hard-validation checks
  // only — it does NOT wait on preflight.ok. preflight.ok requires the binding
  // eth_call simulation, which for any ERC20/SY seed token REVERTS with
  // InsufficientAllowance until the user has approved COMMON_DEPLOY. Gating the
  // plan on it made useActionFlow(null) stay 'idle' → the "Approve {token}"
  // button never rendered → the user could never grant the allowance the sim
  // needed. Decoupling hands the plan to useActionFlow, which owns the correct
  // post-allowance sequence (checkApprovals → approve → binding simulate →
  // confirm), exactly like M2/M3. The advisory preflight simulation stays a
  // display-only hint (PreflightChecklist), never a gate on Approve/Deploy.
  const localConfigValid =
    expiryInFuture &&
    expiryAligned &&
    bandValid &&
    desiredInBand &&
    !feeOverCap &&
    syMeta.status === 'success' &&
    !seedOverBalance &&
    seedError === undefined
  const canBuildPlan =
    configComplete &&
    localConfigValid &&
    user !== undefined &&
    activeSeedToken !== undefined
  const plan: ActionPlan | null = useMemo(() => {
    if (!canBuildPlan || !config || !sy || !activeSeedToken || !user || seedAmount === undefined) {
      return null
    }
    try {
      return planDeployPool(
        sy,
        config,
        activeSeedToken.address,
        activeSeedToken.symbol,
        activeSeedToken.decimals,
        seedAmount,
        user,
      )
    } catch {
      // Stub throws until integration — no plan yet, Deploy stays disabled.
      return null
    }
  }, [canBuildPlan, config, sy, activeSeedToken, user, seedAmount])

  const flow = useActionFlow(plan)
  // Freeze inputs while a send is in flight (approve/simulate/confirm lifecycle).
  const busy =
    flow.phase === 'approving' ||
    flow.phase === 'simulating' ||
    flow.phase === 'signing' ||
    flow.phase === 'pending' ||
    flow.phase === 'checking'
  const inputsFrozen = busy || flow.phase === 'confirmed'

  // Disabled-reason for TxButton when there's no plan. The plan is built from
  // the LOCAL hard-validation checks (FIX A) — so the reasons here mirror those
  // checks, NOT the advisory preflight simulation. A not-yet-approved allowance
  // (which makes the advisory sim revert) must NOT disable Deploy: with a valid
  // config the plan exists and useActionFlow surfaces "Approve {token}".
  const disabledReason = (() => {
    if (!user) return 'Connect wallet to deploy'
    if (syMeta.status !== 'success') return 'Enter a valid SY address'
    if (!config) return 'Complete the configuration'
    if (!expiryInFuture || !expiryAligned) return 'Fix the expiry'
    if (!bandValid) return 'Fix the rate band'
    if (!desiredInBand) return 'Launch APY must be inside the band'
    if (feeOverCap) return 'Fee cannot exceed 5%'
    if (seedAmount === undefined || seedAmount === 0n) return 'Enter a seed amount'
    if (seedOverBalance) return 'Seed amount exceeds your balance'
    return 'Preparing…'
  })()

  return (
    <div className="space-y-5 py-8">
      <Link to="/" className="inline-block text-sm text-zinc-400 hover:text-zinc-200">
        ← Home
      </Link>

      <header>
        <h1 className="text-xl font-bold tracking-tight text-zinc-100 sm:text-2xl">
          Create a community pool
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-zinc-400">
          Deploy a Pendle V2 market for an existing SY and seed its first
          liquidity — one transaction through Pendle's canonical{' '}
          <span className="font-mono text-xs">commonDeploy</span> helper. You can
          fill this in and preview without a wallet; deploying needs one.
        </p>
      </header>

      {flow.phase === 'confirmed' && flow.txHash ? (
        <DeploySuccess txHash={flow.txHash} />
      ) : null}

      {/* 1 — SY address */}
      <Section
        step={1}
        title="SY (Standardized Yield) address"
        subtitle="The yield-bearing token your pool is built on."
      >
        <input
          type="text"
          value={syInput}
          onChange={(e) => setSyInput(e.target.value)}
          placeholder="0x… SY contract address"
          spellCheck={false}
          autoComplete="off"
          disabled={inputsFrozen}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-emerald-500 disabled:opacity-60"
        />
        <div aria-live="polite" className="mt-2 min-h-5 text-xs">
          {syMeta.status === 'loading' && (
            <span className="text-zinc-500">checking SY on-chain…</span>
          )}
          {syMeta.status === 'error' && (
            <span className="text-red-400">
              That address doesn't implement IStandardizedYield (no
              name/symbol/getTokensIn). Paste an SY contract.
            </span>
          )}
          {syMeta.status === 'success' && syMeta.meta && (
            <span className="text-emerald-400">
              Valid SY: {clampLabel(syMeta.meta.name)} (
              {clampLabel(syMeta.meta.symbol)}) · {syMeta.meta.decimals} decimals ·{' '}
              {syMeta.meta.seedTokens.length} seedable token
              {syMeta.meta.seedTokens.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-zinc-600">
          Need an SY first?{' '}
          <Link
            to="/create-sy"
            className="text-emerald-400 underline decoration-emerald-900 underline-offset-2 hover:text-emerald-300"
          >
            Create one in the SY-adapter wizard →
          </Link>
        </p>
      </Section>

      {/* 2 — Expiry */}
      <Section
        step={2}
        title="Expiry"
        subtitle="When PT matures. Snaps to 00:00 UTC (Pendle convention: a Thursday)."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div>
            <label className="text-xs text-zinc-500">Maturity date (UTC)</label>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              disabled={inputsFrozen}
              className="mt-1 block rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 disabled:opacity-60 [color-scheme:dark]"
            />
          </div>
          <button
            type="button"
            onClick={() => setExpiryDate(unixToDateInput(nextThursdayUtc()))}
            disabled={inputsFrozen}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:border-emerald-700 hover:text-emerald-400 disabled:opacity-50"
          >
            Next Thursday
          </button>
        </div>
        {expiryUnix !== undefined && (
          <div className="mt-2.5 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs">
            <p className="text-zinc-300">
              Expiry: <span className="font-medium">{formatUtcDateTime(expiryUnix)}</span>{' '}
              <span className="text-zinc-500">
                ({daysToExpiry(expiryUnix)} days from now · unix {expiryUnix})
              </span>
            </p>
            {!expiryInFuture && (
              <p className="mt-1 text-red-400">Expiry must be in the future.</p>
            )}
            {expiryInFuture && !expiryAligned && (
              <p className="mt-1 text-amber-400/90">
                Snapped to the {expiryDivisor}s boundary required by the factory.
              </p>
            )}
          </div>
        )}
      </Section>

      {/* 3 — Rate band + launch APY + fee */}
      <Section
        step={3}
        title="Rate band, launch APY and fee"
        subtitle="The implied-APY range is permanent — see the panel below."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <PercentField
            label="Rate band — minimum implied APY"
            value={minInput}
            onChange={setMinInput}
            placeholder="2"
            disabled={inputsFrozen}
            error={minParse.error}
          />
          <PercentField
            label="Rate band — maximum implied APY"
            value={maxInput}
            onChange={setMaxInput}
            placeholder="20"
            disabled={inputsFrozen}
            error={bandError && !minParse.error ? bandError : maxParse.error}
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <PercentField
            label="Desired launch APY"
            value={desiredInput}
            onChange={setDesiredInput}
            placeholder={
              bandValid && desiredScaled !== undefined
                ? `${(Number((rateMin! + rateMax!) / 2n) / 1e16).toFixed(1)} (midpoint)`
                : 'midpoint'
            }
            disabled={inputsFrozen}
            error={desiredError}
            hint="Left blank = band midpoint. Must be strictly inside the band."
          />
          <PercentField
            label="Swap fee"
            value={feeInput}
            onChange={setFeeInput}
            placeholder="default = max ÷ 25"
            disabled={inputsFrozen}
            error={feeError}
            hint="Left blank = Pendle's heuristic (max ÷ 25). Max 5%."
          />
        </div>
      </Section>

      {/* Parameter education (required, prominent) */}
      <PoolParamEducation
        rateMin={bandValid ? rateMin : undefined}
        rateMax={bandValid ? rateMax : undefined}
        desired={desiredScaled}
        derived={derivedForVisual}
      />

      {/* 4 — Seed token + amount */}
      <Section
        step={4}
        title="Seed liquidity"
        subtitle="Seeds the pool with an initial position. You receive LP plus YT."
      >
        {syMeta.status !== 'success' ? (
          <p className="text-xs text-zinc-500">
            Enter a valid SY above to choose a seed token.
          </p>
        ) : (
          <>
            <label className="text-xs text-zinc-500">Seed token</label>
            <select
              value={activeSeedToken ? `${activeSeedToken.address}:${activeSeedToken.isSy}` : ''}
              onChange={(e) => setSeedTokenAddr(e.target.value)}
              disabled={inputsFrozen}
              className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 disabled:opacity-60 [color-scheme:dark]"
            >
              {seedTokens.map((t) => (
                <option key={`${t.address}:${t.isSy}`} value={`${t.address}:${t.isSy}`}>
                  {clampLabel(t.symbol, 20)}
                  {t.isSy ? ' (the SY itself)' : t.isNative ? ' (native gas token)' : ''} ·{' '}
                  {t.isNative ? 'native' : shortAddress(t.address)}
                </option>
              ))}
            </select>
            <div className="mt-3">
              <AmountInput
                label="Seed amount"
                value={seedAmountInput}
                onChange={setSeedAmountInput}
                symbol={activeSeedToken?.symbol ?? ''}
                decimals={activeSeedToken?.decimals}
                balance={seedBalance.balance}
                isNative={isNativeSeed}
                disabled={inputsFrozen}
                error={seedError}
                balanceHint="seed small first, top up later"
              />
            </div>
            <p className="mt-2 text-[11px] leading-snug text-zinc-600">
              Pendle's guidance: seed a small amount (under ~$10), confirm the
              pool trades, then add liquidity from the pool page.
            </p>
          </>
        )}
      </Section>

      {/* 5 — Preflight */}
      <PreflightChecklist
        status={preflight.status}
        preflight={preflight.preflight}
        error={preflight.error}
        incomplete={!configComplete}
      />

      {/* 6 — Deploy */}
      <Section
        step={6}
        title="Deploy + seed"
        subtitle="One transaction: approve the seed token, then create and seed the pool."
      >
        {flow.phase === 'confirmed' ? (
          <p className="text-xs text-emerald-300">
            Deployed — see the success card above. Use “Done” to reset the wizard.
          </p>
        ) : null}
        <div className="space-y-2.5">
          <TxButton
            flow={flow}
            actionLabel="deploy pool"
            disabledReason={plan ? undefined : disabledReason}
            onDone={() => {
              flow.reset()
            }}
          />
          <TxStatus flow={flow} />
        </div>
      </Section>

      {/* Recovery */}
      <DeployRecovery />
    </div>
  )
}
