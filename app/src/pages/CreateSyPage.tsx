/**
 * CreateSyPage — /create-sy. The M7 SY-adapter creation wizard, a single
 * scrollable page mirroring the M6 CreatePoolPage structure: paste a yield
 * token / ERC-4626 vault → probe it (ERC-4626 detection + FOT/rebasing
 * screening) → pick a template (basic simple path; upgradeable/adapter behind
 * an Advanced disclosure) → name/symbol conventions → choose the SY owner
 * (default Pendle governance) → deploy the SY alone, or the SY + a pool in one
 * transaction (reusing the M6 rate-band / launch-APY / fee / seed inputs and
 * education panel).
 *
 * Data-layer boundary: this page CONSUMES lib/syDeploy.ts (probeAsset via the
 * useAssetProbe hook, templateInfo, planDeploySyOnly, planDeploySyAndMarket,
 * decodeSyDeployResult — all currently THROW/idle) and lib/hooks.ts
 * (useAssetProbe — idle; useActionFlow — live). Every call into a throwing stub
 * is guarded so the page renders safe idle states: inputs validate locally, the
 * template picker and disclosures work, Deploy stays disabled, and nothing
 * crashes while integration is pending.
 *
 * Blocker-gated deploy: when the probe reports FOT/rebasing (probe.blockers
 * non-empty) a RED banner blocks and Deploy is disabled — no override (Pendle
 * SY accounting can't hold those tokens safely; fork-verified they
 * under-collateralize).
 *
 * SY-only screening gate (FIX 1 / PLAN §5 M7 line 230): an UNSEEDED SY-only
 * deploy of a BASIC template (deploySY, no on-chain seeding backstop) is allowed
 * only when the token screen genuinely PASSED (feeOnTransfer === 'ok' AND
 * rebasing !== 'suspected'). When the FOT screen is merely 'unknown' (the common
 * arb1 case — state overrides degrade), the deploy is BLOCKED by default behind
 * an explicit "I understand… deploy anyway" override checkbox. The combined
 * (deploy+seed) flow keeps its on-chain seeding-revert backstop and only surfaces
 * the warning (no hard override). See syDeploy.syOnlyDeployNeedsOverride.
 *
 * Plan gate (mirrors M6 FIX A): the deploy plan is built from LOCAL hard checks
 * + "no blockers" ONLY — never from a binding simulation that needs an approval
 * first. useActionFlow owns approve → simulate → confirm. For a SY-only deploy
 * there are no approvals at all; for the combined flow the seed token approval
 * is surfaced by useActionFlow exactly like M6.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { getAddress, isAddress } from 'viem'
import type { Address } from 'viem'
import type {
  ActionPlan,
  DerivedDeployParams,
  PoolConfig,
  SyDeployConfig,
  SyTemplateId,
} from '../lib/types'
import { computeDeployParams } from '../lib/deploy'
import {
  isBasicTemplate,
  planDeploySyAndMarket,
  planDeploySyOnly,
  screenPassedForUnseededSyOnly,
  syOnlyDeployNeedsOverride,
  templateInfo,
} from '../lib/syDeploy'
import { useActionFlow, useAssetProbe } from '../lib/hooks'
import { PENDLE_GOVERNANCE } from '../lib/addresses'
import { AmountInput } from '../components/AmountInput'
import { TxButton } from '../components/TxButton'
import { TxStatus } from '../components/TxStatus'
import { clampLabel, shortAddress } from '../components/format'
import { parseAmount } from '../components/parseAmount'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { PoolParamEducation } from '../components/create/PoolParamEducation'
import { SyDeploySuccess } from '../components/create/SyDeploySuccess'
import {
  useExpiryDivisor,
  useTokenBalance,
} from '../components/create/createReads'
import {
  ADVANCED_TEMPLATES,
  BASIC_TEMPLATES,
  templateMeta,
} from '../components/create/syTemplates'
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
// Section shell (matches CreatePoolPage)
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
    <section className="rounded-[16px] border border-hairline bg-surface p-4">
      <div className="flex items-baseline gap-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-bg font-mono text-[11px] text-accent-ink">
          {step}
        </span>
        <div>
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {subtitle && <p className="text-xs text-faint">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null
  return <p className="mt-1 text-xs text-danger">{msg}</p>
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
      <label className="text-xs text-faint">{label}</label>
      <div
        className={`mt-1 flex items-center gap-2 rounded-[10px] border bg-bg-2 px-3 py-2 focus-within:border-accent focus-within:ring-4 focus-within:ring-[rgba(var(--op-accent-rgb),0.14)] ${
          error ? 'border-[var(--op-danger-bd)]' : 'border-hairline-strong'
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
          className="min-w-0 flex-1 bg-transparent text-base font-medium text-fg placeholder-[color:var(--op-faint)] outline-none disabled:cursor-not-allowed"
        />
        <span className="shrink-0 text-sm text-faint">%</span>
      </div>
      {error ? <FieldError msg={error} /> : hint ? (
        <p className="mt-1 text-[11px] text-faint">{hint}</p>
      ) : null}
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  error,
  disabled,
  mono,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  error?: string
  disabled?: boolean
  mono?: boolean
  hint?: string
}) {
  return (
    <div>
      <label className="text-xs text-faint">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        className={`mt-1 w-full rounded-[10px] border bg-bg-2 px-3 py-2 text-sm text-fg placeholder-[color:var(--op-faint)] outline-none focus:border-accent focus:ring-4 focus:ring-[rgba(var(--op-accent-rgb),0.14)] disabled:opacity-60 ${
          error ? 'border-[var(--op-danger-bd)]' : 'border-hairline-strong'
        } ${mono ? 'font-mono' : ''}`}
      />
      {error ? <FieldError msg={error} /> : hint ? (
        <p className="mt-1 text-[11px] text-faint">{hint}</p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Screening verdict pill
// ---------------------------------------------------------------------------

function VerdictPill({ label, verdict }: { label: string; verdict: 'ok' | 'suspected' | 'unknown' }) {
  const cls =
    verdict === 'ok'
      ? 'border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] text-accent-ink'
      : verdict === 'suspected'
        ? 'border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] text-danger'
        : 'border-hairline-strong bg-bg-2 text-muted'
  const word = verdict === 'ok' ? 'clear' : verdict === 'suspected' ? 'suspected' : 'unknown'
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}: {word}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CreateSyPage() {
  useDocumentTitle('Create an SY adapter')
  const { address: user } = useAccount()

  // --- asset input + probe ---
  const [assetInput, setAssetInput] = useState('')
  const trimmedAsset = assetInput.trim()
  const assetValid = isAddress(trimmedAsset, { strict: false })
  const asset: Address | undefined = assetValid ? getAddress(trimmedAsset) : undefined
  const probeResult = useAssetProbe(asset)
  const probe = probeResult.probe

  // --- template selection (default = probe suggestion; else erc20) ---
  const [templateOverride, setTemplateOverride] = useState<SyTemplateId | undefined>(undefined)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const template: SyTemplateId = templateOverride ?? probe?.suggested ?? 'erc20'
  const tmeta = templateMeta(template)
  // templateInfo() throws pre-integration — guard so upgradeability disclosure
  // degrades to the static metadata flag rather than crashing.
  const upgradeable = useMemo(() => {
    try {
      return templateInfo(template).upgradeable
    } catch {
      return tmeta.upgradeable
    }
  }, [template, tmeta.upgradeable])

  // If the probe suggests a template the user hasn't overridden, keep following
  // the suggestion (clear a stale override when the asset changes).
  useEffect(() => {
    setTemplateOverride(undefined)
  }, [asset])

  // --- adapter address (advanced adapter templates only) ---
  const [adapterInput, setAdapterInput] = useState('')
  const trimmedAdapter = adapterInput.trim()
  const adapterValid = trimmedAdapter.length === 0 || isAddress(trimmedAdapter, { strict: false })
  const adapter: Address | undefined =
    tmeta.takesAdapter && trimmedAdapter.length > 0 && isAddress(trimmedAdapter, { strict: false })
      ? getAddress(trimmedAdapter)
      : undefined
  const adapterError =
    tmeta.takesAdapter && trimmedAdapter.length > 0 && !adapterValid
      ? 'Enter a valid address, or leave blank for a plain 1:1 wrapper.'
      : undefined

  // --- name / symbol (auto-filled from the probe, editable) ---
  const [nameInput, setNameInput] = useState('')
  const [symbolInput, setSymbolInput] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [symbolTouched, setSymbolTouched] = useState(false)

  // Auto-fill "SY <name>" / "SY-<symbol>" once the probe resolves, unless the
  // user has already typed their own.
  const suggestedName = probe ? `SY ${probe.symbol}` : ''
  const suggestedSymbol = probe ? `SY-${probe.symbol}` : ''
  useEffect(() => {
    if (!probe) return
    if (!nameTouched) setNameInput(`SY ${probe.symbol}`)
    if (!symbolTouched) setSymbolInput(`SY-${probe.symbol}`)
  }, [probe, nameTouched, symbolTouched])

  const name = nameInput.trim()
  const symbol = symbolInput.trim()
  const nameError =
    name.length === 0
      ? undefined // empty is "incomplete", not an error banner
      : !name.startsWith('SY ') && name !== 'SY'
        ? "By convention SY names start with “SY ” (e.g. “SY Staked ETH”)."
        : undefined
  const symbolError =
    symbol.length === 0
      ? undefined
      : !symbol.startsWith('SY-') && symbol !== 'SY'
        ? "By convention SY symbols start with “SY-” (e.g. “SY-stETH”)."
        : undefined

  // --- syOwner choice (default: Pendle governance) ---
  const [ownerChoice, setOwnerChoice] = useState<'governance' | 'self'>('governance')
  const syOwner: Address | undefined =
    ownerChoice === 'governance' ? PENDLE_GOVERNANCE : user

  // --- deploy mode ---
  const [mode, setMode] = useState<'sy-only' | 'sy-and-market'>('sy-only')

  // --- SY-only unseeded-deploy screening override (FIX 1) ---
  // An unseeded SY-only deploy of a basic template has NO on-chain backstop
  // against FOT/rebasing; when the token screen didn't genuinely pass we require
  // the user to tick an explicit "deploy anyway" override.
  const [screenOverride, setScreenOverride] = useState(false)
  // Reset the override whenever the asset changes (a new token isn't overridden).
  useEffect(() => {
    setScreenOverride(false)
  }, [asset])

  // --- expiry / rate band / fee / seed (combined mode only; reuses M6 math) ---
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

  const [minInput, setMinInput] = useState('2')
  const [maxInput, setMaxInput] = useState('20')
  const minParse = parsePercent(minInput)
  const maxParse = parsePercent(maxInput)
  const rateMin = minParse.scaled
  const rateMax = maxParse.scaled
  const bandValid = rateMin !== undefined && rateMax !== undefined && rateMax > rateMin
  const bandError =
    rateMin !== undefined && rateMax !== undefined && rateMax <= rateMin
      ? 'Max must be greater than min.'
      : (maxParse.error ?? minParse.error)

  const [desiredInput, setDesiredInput] = useState('')
  const desiredParse = parsePercent(desiredInput)
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

  const [feeInput, setFeeInput] = useState('')
  const feeParse = parsePercent(feeInput)
  const feeScaled = useMemo<bigint | undefined>(() => {
    if (feeParse.scaled !== undefined) return feeParse.scaled
    if (rateMax !== undefined) return defaultFee(rateMax)
    return undefined
  }, [feeParse.scaled, rateMax])
  const feeOverCap = feeScaled !== undefined && feeScaled > FEE_CAP_SCALED
  const feeError = feeParse.error ?? (feeOverCap ? 'Fee cannot exceed 5%.' : undefined)

  // Combined-mode seed: the seed token defaults to the underlying asset the SY
  // wraps. Its symbol/decimals come from the probe.
  const seedTokenAddr = asset
  const seedSymbol = probe?.symbol ?? ''
  const seedDecimals = probe?.decimals
  const seedBalance = useTokenBalance(seedTokenAddr, user, false)
  const [seedAmountInput, setSeedAmountInput] = useState('')
  const seedParsed =
    seedDecimals !== undefined
      ? parseAmount(seedAmountInput, seedDecimals)
      : { amount: undefined, error: undefined }
  const seedAmount = seedParsed.amount
  const seedOverBalance =
    seedAmount !== undefined &&
    seedBalance.balance !== undefined &&
    seedAmount > seedBalance.balance
  const seedError =
    seedParsed.error ?? (seedOverBalance ? 'Amount exceeds your balance.' : undefined)

  // --- assembled pool config (combined mode) ---
  const poolConfig: PoolConfig | undefined = useMemo(() => {
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

  // --- derived params for the education visual (computeDeployParams THROWS
  //     pre-integration) ---
  const derived: DerivedDeployParams | undefined = useMemo(() => {
    if (!poolConfig) return undefined
    try {
      return computeDeployParams(poolConfig, Math.floor(nowSec))
    } catch {
      return undefined
    }
  }, [poolConfig, nowSec])

  // --- SY deploy config ---
  const syConfig: SyDeployConfig | undefined = useMemo(() => {
    if (asset === undefined || syOwner === undefined || name.length === 0 || symbol.length === 0) {
      return undefined
    }
    return {
      template,
      asset,
      name,
      symbol,
      syOwner,
      ...(adapter !== undefined ? { adapter } : {}),
    }
  }, [asset, syOwner, name, symbol, template, adapter])

  // --- blocker gate: FOT / rebasing → deploy blocked, no override ---
  const blockers = probe?.blockers ?? []
  const blocked = blockers.length > 0

  // --- SY-only unseeded screening gate (FIX 1 / PLAN §5 M7 line 230) ---
  // Only an UNSEEDED SY-only deploy of a BASIC template lacks the seeding-revert
  // backstop. When the token screen didn't genuinely pass (FOT not 'ok', or
  // rebasing 'suspected') this deploy is gated behind the explicit override.
  const screenPassed = probe !== undefined && screenPassedForUnseededSyOnly(probe)
  const syOnlyUnbackstopped =
    mode === 'sy-only' && probe !== undefined && isBasicTemplate(template)
  const needsScreenOverride =
    syOnlyUnbackstopped &&
    !blocked &&
    syOnlyDeployNeedsOverride(template, probe)
  // The combined flow (or an already-passing screen) never needs the override,
  // but we still surface the advisory warning for the combined flow.
  const showCombinedScreenWarning =
    mode === 'sy-and-market' &&
    probe !== undefined &&
    !blocked &&
    !screenPassed

  // --- local hard-validation (mirrors M6 FIX A: the plan is NOT gated on a
  //     binding simulation — useActionFlow owns approve→simulate→confirm) ---
  const nameConventionOk = nameError === undefined && symbolError === undefined
  const syPartValid =
    probeResult.status === 'success' &&
    !blocked &&
    syConfig !== undefined &&
    nameConventionOk &&
    adapterError === undefined &&
    (ownerChoice === 'governance' || user !== undefined) &&
    // FIX 1: an unseeded SY-only basic deploy whose screen didn't pass is
    // allowed only when the explicit override is ticked.
    (!needsScreenOverride || screenOverride)

  const combinedPartValid =
    mode === 'sy-only' ||
    (poolConfig !== undefined &&
      expiryInFuture &&
      expiryAligned &&
      bandValid &&
      desiredInBand &&
      !feeOverCap &&
      seedTokenAddr !== undefined &&
      seedDecimals !== undefined &&
      seedAmount !== undefined &&
      seedAmount > 0n &&
      !seedOverBalance &&
      seedError === undefined)

  const canBuildPlan = user !== undefined && syPartValid && combinedPartValid

  // --- deploy plan (throwing stubs → try/catch → null → Deploy disabled) ---
  const plan: ActionPlan | null = useMemo(() => {
    if (!canBuildPlan || !syConfig || !user) return null
    try {
      if (mode === 'sy-only') {
        return planDeploySyOnly(syConfig)
      }
      if (
        poolConfig === undefined ||
        seedTokenAddr === undefined ||
        seedDecimals === undefined ||
        seedAmount === undefined
      ) {
        return null
      }
      return planDeploySyAndMarket(
        syConfig,
        poolConfig,
        seedTokenAddr,
        seedSymbol,
        seedDecimals,
        seedAmount,
        user,
      )
    } catch {
      // Stubs throw until integration — no plan yet, Deploy stays disabled.
      return null
    }
  }, [
    canBuildPlan,
    syConfig,
    user,
    mode,
    poolConfig,
    seedTokenAddr,
    seedSymbol,
    seedDecimals,
    seedAmount,
  ])

  const flow = useActionFlow(plan)
  const busy =
    flow.phase === 'approving' ||
    flow.phase === 'simulating' ||
    flow.phase === 'signing' ||
    flow.phase === 'pending' ||
    flow.phase === 'checking'
  const inputsFrozen = busy || flow.phase === 'confirmed'

  // --- disabled reason (mirrors the LOCAL checks + the blocker gate, NOT the
  //     advisory simulation) ---
  const disabledReason = (() => {
    if (!user) return 'Connect wallet to deploy'
    if (probeResult.status !== 'success') return 'Enter a valid asset address'
    if (blocked) return 'This token is blocked from SY deployment'
    if (name.length === 0 || symbol.length === 0) return 'Enter a name and symbol'
    if (!nameConventionOk) return 'Fix the name/symbol convention'
    if (adapterError) return 'Fix the adapter address'
    if (ownerChoice === 'self' && !user) return 'Connect wallet to keep ownership'
    if (needsScreenOverride && !screenOverride)
      return 'This token was not fully screened — confirm the override to deploy SY-only'
    if (mode === 'sy-and-market') {
      if (!expiryInFuture || !expiryAligned) return 'Fix the expiry'
      if (!bandValid) return 'Fix the rate band'
      if (!desiredInBand) return 'Launch APY must be inside the band'
      if (feeOverCap) return 'Fee cannot exceed 5%'
      if (seedAmount === undefined || seedAmount === 0n) return 'Enter a seed amount'
      if (seedOverBalance) return 'Seed amount exceeds your balance'
    }
    return 'Preparing…'
  })()

  const actionLabel = mode === 'sy-only' ? 'deploy SY' : 'deploy SY + pool'

  return (
    <div className="mx-auto max-w-[760px]">
      <div className="space-y-5 py-8">
      <Link to="/" className="inline-block text-sm text-muted hover:text-fg">
        ← Home
      </Link>

      <header>
        <h1 className="text-xl font-bold tracking-tight text-fg sm:text-2xl">
          Create an SY adapter
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">
          Deploy a Pendle-audited Standardized Yield (SY) wrapper for any ERC-20
          or ERC-4626 asset through Pendle's canonical{' '}
          <span className="font-mono text-xs">syFactory</span> — optionally with
          a pool in the same transaction. You can fill this in and preview
          without a wallet; deploying needs one.
        </p>
      </header>

      {flow.phase === 'confirmed' && flow.txHash ? (
        <SyDeploySuccess txHash={flow.txHash} upgradeable={upgradeable} />
      ) : null}

      {/* 1 — Asset */}
      <Section
        step={1}
        title="Asset to wrap"
        subtitle="The yield-bearing ERC-20 or ERC-4626 vault your SY will wrap."
      >
        <input
          type="text"
          value={assetInput}
          onChange={(e) => setAssetInput(e.target.value)}
          placeholder="0x… yield token or ERC-4626 vault address"
          spellCheck={false}
          autoComplete="off"
          disabled={inputsFrozen}
          className="w-full rounded-[10px] border border-hairline-strong bg-bg-2 px-3 py-2.5 font-mono text-sm text-fg placeholder-[color:var(--op-faint)] outline-none focus:border-accent focus:ring-4 focus:ring-[rgba(var(--op-accent-rgb),0.14)] disabled:opacity-60"
        />
        <div aria-live="polite" className="mt-2 space-y-2 text-xs">
          {trimmedAsset.length > 0 && !assetValid && (
            <span className="text-danger">That is not a valid address (0x + 40 hex).</span>
          )}
          {assetValid && probeResult.status === 'loading' && (
            <span className="text-faint">probing the token on-chain…</span>
          )}
          {assetValid && probeResult.status === 'idle' && (
            <span className="text-faint">
              Token probing runs here once the data layer is wired. You can still
              pick a template and configure the deploy below.
            </span>
          )}
          {probeResult.status === 'error' && (
            <span className="text-danger">
              Couldn't probe that token: {probeResult.error ?? 'the RPC read failed.'}
            </span>
          )}
          {probeResult.status === 'success' && probe && (
            <div className="space-y-2">
              <p className="text-accent-ink">
                Detected: {clampLabel(probe.symbol)} · {probe.decimals} decimals ·{' '}
                {probe.isErc4626 ? 'ERC-4626 vault' : 'plain ERC-20'}
                {probe.isErc4626 && probe.underlyingSymbol
                  ? ` → underlying ${clampLabel(probe.underlyingSymbol)}`
                  : ''}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <VerdictPill label="fee-on-transfer" verdict={probe.feeOnTransfer} />
                <VerdictPill label="rebasing" verdict={probe.rebasing} />
              </div>
              {probe.notes.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-faint">
                  {probe.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* RED blocker banner — FOT / rebasing → deploy blocked, no override. */}
        {blocked && (
          <div className="mt-3 rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-3">
            <p className="text-sm font-semibold text-danger">
              This token can't be wrapped safely — deploying is blocked.
            </p>
            <p className="mt-1 text-xs text-red-200/90">
              It looks fee-on-transfer or rebasing. Pendle SY accounting assumes a
              token's balance only changes on explicit transfers of a fixed
              amount; fee-on-transfer and rebasing tokens break that assumption
              and the SY would silently under-collateralize (fork-verified).
              There is no override.
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-red-200/80">
              {blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        )}

        {/* AMBER gate — SY-only unseeded basic deploy whose screen didn't pass
            (FIX 1). Blocks by default; an explicit override checkbox is required. */}
        {needsScreenOverride && (
          <div className="mt-3 rounded-lg border border-amber-600 bg-[var(--op-warn-soft)] p-3">
            <p className="text-sm font-semibold text-warn">
              This token wasn't fully screened — an SY-only deploy is blocked by default.
            </p>
            <p className="mt-1 text-xs text-amber-100/90">
              {probe && probe.feeOnTransfer === 'suspected'
                ? 'The fee-on-transfer screen flagged this token.'
                : "The fee-on-transfer screen couldn't complete (this RPC didn't fully support the on-chain probe), so it's inconclusive."}{' '}
              Unlike the “SY + pool” flow, an <span className="font-medium">SY-only</span>{' '}
              deploy has no seeding step to revert on a bad token — a
              fee-on-transfer or rebasing token would deploy successfully and then
              silently under-collateralize. If you know this token is a plain,
              non-fee, non-rebasing ERC-20 you can override; otherwise use the
              “SY + pool” flow (which is protected by its on-chain seeding revert)
              or pick a cleaner token.
            </p>
            <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-xs text-amber-100">
              <input
                type="checkbox"
                className="mt-0.5 accent-amber-500"
                checked={screenOverride}
                disabled={inputsFrozen}
                onChange={(e) => setScreenOverride(e.target.checked)}
              />
              <span>
                I understand this token wasn't fully screened and may break the SY —
                deploy anyway.
              </span>
            </label>
          </div>
        )}

        {/* Advisory (combined flow) — screen didn't pass, but the on-chain
            seeding revert is the backstop, so no hard override is required. */}
        {showCombinedScreenWarning && (
          <div className="mt-3 rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] p-3 text-[11px] leading-snug text-warn">
            <span className="font-semibold text-warn">Heads up:</span>{' '}
            {probe && probe.feeOnTransfer === 'suspected'
              ? 'the fee-on-transfer screen flagged this token'
              : "the fee-on-transfer screen couldn't fully complete on this RPC"}
            . The “SY + pool” flow seeds liquidity on-chain, so a genuinely
            fee-on-transfer or rebasing token will make this transaction{' '}
            <span className="font-medium">revert</span> during seeding (your funds
            stay safe) rather than deploying a broken SY.
          </div>
        )}
      </Section>

      {/* 2 — Template */}
      <Section
        step={2}
        title="SY template"
        subtitle={
          probe
            ? `Suggested from the probe: ${templateMeta(probe.suggested).label}.`
            : 'Pick the template that matches your asset.'
        }
      >
        <div className="space-y-2">
          {BASIC_TEMPLATES.map((t) => {
            const disabled = inputsFrozen || (t.requiresErc4626 && probe !== undefined && !probe.isErc4626)
            const selected = template === t.id
            const isSuggested = probe?.suggested === t.id
            return (
              <label
                key={t.id}
                className={`flex cursor-pointer items-start gap-2.5 rounded-[12px] border p-3 ${
                  selected ? 'border-[rgba(var(--op-accent-rgb),0.5)] bg-[rgba(var(--op-accent-rgb),0.09)]' : 'border-hairline bg-bg/40'
                } ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-hairline-strong'}`}
              >
                <input
                  type="radio"
                  name="sy-template"
                  className="mt-0.5 accent-[var(--op-accent)]"
                  checked={selected}
                  disabled={disabled}
                  onChange={() => setTemplateOverride(t.id)}
                />
                <div>
                  <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
                    {selected && (
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent" />
                    )}
                    {t.label}
                    {isSuggested && (
                      <span className="ml-2 rounded bg-[rgba(var(--op-accent-rgb),0.12)] px-1.5 py-0.5 text-[10px] font-semibold text-accent-ink">
                        suggested
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-faint">{t.description}</p>
                  {disabled && t.requiresErc4626 && probe && !probe.isErc4626 && (
                    <p className="mt-1 text-[11px] text-warn">
                      Needs an ERC-4626 vault — this asset probed as a plain ERC-20.
                    </p>
                  )}
                </div>
              </label>
            )
          })}
        </div>

        {/* Advanced (upgradeable / adapter) templates behind a disclosure. */}
        <details
          className="group mt-3 rounded-lg border border-hairline bg-bg/40"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted hover:text-fg">
            Advanced: upgradeable / adapter templates
          </summary>
          <div className="space-y-2 border-t border-hairline px-3 py-3">
            <div className="rounded-md border border-[var(--op-warn-bd)] bg-amber-950/30 px-3 py-2 text-[11px] leading-snug text-warn">
              These templates deploy a{' '}
              <span className="font-medium">TransparentUpgradeableProxy under Pendle's proxyAdmin</span>{' '}
              — the SY implementation can later be upgraded by Pendle governance.
              Adapter templates also let the SY owner call{' '}
              <span className="font-mono">setAdapter</span>, which changes how
              deposits/redeems are routed. Use only if you specifically need an
              adapter or an upgradeable SY.
            </div>
            {ADVANCED_TEMPLATES.map((t) => {
              const disabled = inputsFrozen || (t.requiresErc4626 && probe !== undefined && !probe.isErc4626)
              const selected = template === t.id
              return (
                <label
                  key={t.id}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-[12px] border p-3 ${
                    selected ? 'border-[rgba(var(--op-accent-rgb),0.5)] bg-[rgba(var(--op-accent-rgb),0.09)]' : 'border-hairline bg-bg/40'
                  } ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-hairline-strong'}`}
                >
                  <input
                    type="radio"
                    name="sy-template"
                    className="mt-0.5 accent-[var(--op-accent)]"
                    checked={selected}
                    disabled={disabled}
                    onChange={() => setTemplateOverride(t.id)}
                  />
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
                      {selected && (
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent" />
                      )}
                      {t.label}
                    </p>
                    <p className="mt-0.5 text-xs text-faint">{t.description}</p>
                  </div>
                </label>
              )
            })}

            {/* Optional adapter address for the adapter templates. */}
            {tmeta.takesAdapter && (
              <div className="pt-1">
                <TextField
                  label="Adapter address (optional)"
                  value={adapterInput}
                  onChange={setAdapterInput}
                  placeholder="0x… IStandardizedYieldAdapter — blank = plain 1:1 wrapper"
                  disabled={inputsFrozen}
                  mono
                  error={adapterError}
                  hint="Leave blank to deploy a plain 1:1 wrapper. A pasted adapter is treated as untrusted until you've verified it."
                />
              </div>
            )}
          </div>
        </details>
      </Section>

      {/* 3 — Name / symbol */}
      <Section
        step={3}
        title="Name and symbol"
        subtitle="Conventions: name starts with “SY ”, symbol with “SY-”."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="SY name"
            value={nameInput}
            onChange={(v) => {
              setNameTouched(true)
              setNameInput(v)
            }}
            placeholder={suggestedName || 'SY <asset name>'}
            disabled={inputsFrozen}
            error={nameError}
          />
          <TextField
            label="SY symbol"
            value={symbolInput}
            onChange={(v) => {
              setSymbolTouched(true)
              setSymbolInput(v)
            }}
            placeholder={suggestedSymbol || 'SY-<asset symbol>'}
            disabled={inputsFrozen}
            mono
            error={symbolError}
          />
        </div>
        {probe && (nameTouched || symbolTouched) && (
          <button
            type="button"
            disabled={inputsFrozen}
            onClick={() => {
              setNameTouched(false)
              setSymbolTouched(false)
              setNameInput(`SY ${probe.symbol}`)
              setSymbolInput(`SY-${probe.symbol}`)
            }}
            className="mt-2 rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] text-muted hover:border-[rgba(var(--op-accent-rgb),0.4)] hover:text-accent-ink disabled:opacity-50"
          >
            Reset to suggested (SY {clampLabel(probe.symbol)} / SY-{clampLabel(probe.symbol)})
          </button>
        )}
      </Section>

      {/* 4 — SY owner */}
      <Section
        step={4}
        title="SY owner"
        subtitle="Who can pause the SY (and, for adapter SYs, call setAdapter)."
      >
        <div className="space-y-2">
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-[12px] border p-3 ${
              ownerChoice === 'governance'
                ? 'border-[rgba(var(--op-accent-rgb),0.5)] bg-[rgba(var(--op-accent-rgb),0.09)]'
                : 'border-hairline bg-bg/40 hover:border-hairline-strong'
            } ${inputsFrozen ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <input
              type="radio"
              name="sy-owner"
              className="mt-0.5 accent-[var(--op-accent)]"
              checked={ownerChoice === 'governance'}
              disabled={inputsFrozen}
              onChange={() => setOwnerChoice('governance')}
            />
            <div>
              <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
                {ownerChoice === 'governance' && (
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent" />
                )}
                Pendle governance{' '}
                <span className="rounded bg-[rgba(var(--op-accent-rgb),0.12)] px-1.5 py-0.5 text-[10px] font-semibold text-accent-ink">
                  recommended
                </span>
              </p>
              <p className="mt-0.5 text-xs text-faint">
                Ownership goes to Pendle governance ({shortAddress(PENDLE_GOVERNANCE)}) —
                the same trust profile as Pendle's own SYs. Traders can verify the
                owner is Pendle rather than an unknown deployer.
              </p>
            </div>
          </label>

          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-[12px] border p-3 ${
              ownerChoice === 'self'
                ? 'border-[var(--op-warn-bd)] bg-amber-950/20'
                : 'border-hairline bg-bg/40 hover:border-hairline-strong'
            } ${inputsFrozen ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <input
              type="radio"
              name="sy-owner"
              className="mt-0.5 accent-amber-500"
              checked={ownerChoice === 'self'}
              disabled={inputsFrozen}
              onChange={() => setOwnerChoice('self')}
            />
            <div>
              <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
                {ownerChoice === 'self' && (
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-warn" />
                )}
                Keep ownership{' '}
                <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
                  advanced
                </span>
              </p>
              <p className="mt-0.5 text-xs text-faint">
                Your connected wallet
                {user ? ` (${shortAddress(user)})` : ''} owns the SY.
              </p>
            </div>
          </label>

          {ownerChoice === 'self' && (
            <div className="rounded-lg border border-[var(--op-warn-bd)] bg-amber-950/30 px-3 py-2.5 text-xs leading-relaxed text-warn">
              <span className="font-semibold text-warn">Trust flag:</span> as
              owner you can <span className="font-medium">pause</span> the SY at
              any time (freezing wraps/unwraps for everyone holding it)
              {tmeta.takesAdapter || upgradeable
                ? ', and for this adapter/upgradeable template you can also call setAdapter to re-route deposits and redemptions'
                : ''}
              . Every pool built on this SY will render an owner-not-Pendle
              warning to its users. Keep ownership only if you understand and want
              that responsibility.
              {!user && (
                <span className="mt-1 block text-warn">
                  Connect a wallet to use your address as the owner.
                </span>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* 5 — Deploy mode */}
      <Section
        step={5}
        title="Deploy mode"
        subtitle="Deploy just the SY, or the SY plus a tradeable pool in one transaction."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            disabled={inputsFrozen}
            onClick={() => setMode('sy-only')}
            className={`rounded-lg border p-3 text-left ${
              mode === 'sy-only'
                ? 'border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)]'
                : 'border-hairline bg-bg/40 hover:border-hairline-strong'
            } disabled:opacity-60`}
          >
            <p className="text-sm font-medium text-fg">SY only</p>
            <p className="mt-0.5 text-xs text-faint">
              Deploy just the SY wrapper. No approval needed. You can create a
              pool for it afterwards.
            </p>
          </button>
          <button
            type="button"
            disabled={inputsFrozen}
            onClick={() => setMode('sy-and-market')}
            className={`rounded-lg border p-3 text-left ${
              mode === 'sy-and-market'
                ? 'border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)]'
                : 'border-hairline bg-bg/40 hover:border-hairline-strong'
            } disabled:opacity-60`}
          >
            <p className="text-sm font-medium text-fg">SY + pool in one transaction</p>
            <p className="mt-0.5 text-xs text-faint">
              Deploy the SY, a PT/YT pair and an AMM market, and seed its first
              liquidity — all in one tx.
            </p>
          </button>
        </div>
      </Section>

      {/* Combined-mode pool config (reuses the M6 rate-band / launch-APY / fee /
          education / seed pieces). Only shown for the combined mode. */}
      {mode === 'sy-and-market' && (
        <>
          <Section
            step={6}
            title="Expiry"
            subtitle="When PT matures. Snaps to 00:00 UTC (Pendle convention: a Thursday)."
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div>
                <label className="text-xs text-faint">Maturity date (UTC)</label>
                <input
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  disabled={inputsFrozen}
                  className="mt-1 block rounded-[10px] border border-hairline-strong bg-bg-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-4 focus:ring-[rgba(var(--op-accent-rgb),0.14)] disabled:opacity-60 [color-scheme:dark]"
                />
              </div>
              <button
                type="button"
                onClick={() => setExpiryDate(unixToDateInput(nextThursdayUtc()))}
                disabled={inputsFrozen}
                className="rounded-lg border border-hairline-strong px-3 py-2 text-xs text-muted hover:border-[rgba(var(--op-accent-rgb),0.4)] hover:text-accent-ink disabled:opacity-50"
              >
                Next Thursday
              </button>
            </div>
            {expiryUnix !== undefined && (
              <div className="mt-2.5 rounded-md border border-hairline bg-bg-2 px-3 py-2 text-xs">
                <p className="text-muted">
                  Expiry: <span className="font-medium">{formatUtcDateTime(expiryUnix)}</span>{' '}
                  <span className="text-faint">
                    ({daysToExpiry(expiryUnix)} days from now · unix {expiryUnix})
                  </span>
                </p>
                {!expiryInFuture && (
                  <p className="mt-1 text-danger">Expiry must be in the future.</p>
                )}
                {expiryInFuture && !expiryAligned && (
                  <p className="mt-1 text-warn">
                    Snapped to the {expiryDivisor}s boundary required by the factory.
                  </p>
                )}
              </div>
            )}
          </Section>

          <Section
            step={7}
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

          <PoolParamEducation
            rateMin={bandValid ? rateMin : undefined}
            rateMax={bandValid ? rateMax : undefined}
            desired={desiredScaled}
            derived={derived}
          />

          <Section
            step={8}
            title="Seed liquidity"
            subtitle="Seeds the pool with an initial position. You receive LP plus YT."
          >
            {probeResult.status !== 'success' ? (
              <p className="text-xs text-faint">
                Enter a valid asset above to size the seed amount.
              </p>
            ) : (
              <>
                <AmountInput
                  label={`Seed amount (${clampLabel(seedSymbol, 16)})`}
                  value={seedAmountInput}
                  onChange={setSeedAmountInput}
                  symbol={seedSymbol}
                  decimals={seedDecimals}
                  balance={seedBalance.balance}
                  disabled={inputsFrozen}
                  error={seedError}
                  balanceHint="seed small first, top up later"
                />
                <p className="mt-2 text-[11px] leading-snug text-faint">
                  The pool is seeded with the asset the SY wraps. Pendle's
                  guidance: seed a small amount (under ~$10), confirm the pool
                  trades, then add liquidity from the pool page.
                </p>
              </>
            )}
          </Section>
        </>
      )}

      {/* Deploy */}
      <Section
        step={mode === 'sy-and-market' ? 9 : 6}
        title={mode === 'sy-only' ? 'Deploy SY' : 'Deploy SY + pool'}
        subtitle={
          mode === 'sy-only'
            ? 'One transaction, no approval — deploys the SY wrapper.'
            : 'One transaction: approve the seed token, then deploy the SY + pool and seed it.'
        }
      >
        {flow.phase === 'confirmed' ? (
          <p className="mb-2 text-xs text-accent-ink">
            Deployed — see the success card above. Use “Done” to reset the wizard.
          </p>
        ) : null}
        <div className="space-y-2.5">
          <TxButton
            flow={flow}
            actionLabel={actionLabel}
            disabledReason={plan ? undefined : disabledReason}
            onDone={() => {
              flow.reset()
            }}
          />
          <TxStatus flow={flow} />
        </div>
      </Section>
      </div>
    </div>
  )
}
