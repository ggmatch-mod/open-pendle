import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { PageHeader } from '../components/PageHeader'
import {
  LoopingExecutionAction,
  LoopingExecutionPanel,
  LoopingExecutionProvider,
} from '../components/LoopingExecutionPanel'
import { useLoopingMarkets } from '../components/useLoopingMarkets'
import {
  clampLabel,
  formatCompact,
  formatDate,
  formatPercent,
  shortAddress,
} from '../components/format'
import { isSupportedChainId, SUPPORTED_CHAINS, supportedChain } from '../lib/addresses'
import { useTransactionInFlight } from '../lib/hooks'
import {
  calculateLoopingLeverageCap,
  calculateLoopingScenario,
  type LoopingMarketCandidate,
  type LoopingScenario,
  type LoopingScenarioInput,
} from '../lib/looping'
import { isLoopingExecutionCandidateSupported } from '../lib/loopingRegistry'
import type { SupportedChainId } from '../lib/types'
import {
  evaluateLoopingRiskIncreaseEligibility,
  LOOPING_MIN_BORROW_LIQUIDITY_USD,
} from '../lib/loopingEligibility'

const MARKET_STATE_STALE_AFTER_SECONDS = 60 * 60
const DIRECTORY_SNAPSHOT_STALE_AFTER_SECONDS = 15 * 60
const DIRECTORY_PAGE_SIZE = 9
const DEFAULT_MIN_BORROW_LIQUIDITY_USD = LOOPING_MIN_BORROW_LIQUIDITY_USD
const SLIDER_MAX_POLICY = {
  collateralPriceDrop: 0,
  lltvBuffer: 0.01,
  step: 0.05,
  absoluteCap: 100,
} as const
const SLIDER_WARNING_POLICY = {
  ...SLIDER_MAX_POLICY,
  lltvBuffer: 0.1,
} as const
const CLOCK_SKEW_TOLERANCE_SECONDS = 5 * 60
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60
const EMPTY_CANDIDATES: LoopingMarketCandidate[] = []

type ChainFilter = SupportedChainId | 'all'
type SortKey = 'spread' | 'liquidity' | 'pt-apy' | 'borrow-apy' | 'expiry'
type AcquisitionMode = 'market' | 'mint'

interface CalculatorForm {
  equity: string
  leverage: string
  holdingMonths: string
  collateralPriceDrop: string
  lltvBuffer: string
  borrowApyIncrease: string
  ptApyHaircut: string
  entryCost: string
  exitCost: string
  fixedCost: string
}

interface CalculatorSuccess {
  ok: true
  equityNumber: number
  equityAssets: bigint
  input: LoopingScenarioInput
  scenario: LoopingScenario
}

interface AdvancedCalculatorSuccess {
  ok: true
  input: LoopingScenarioInput
  scenario: LoopingScenario
}

interface CalculatorFailure {
  ok: false
  error: string
}

const DEFAULT_FORM: CalculatorForm = {
  equity: '100',
  leverage: '2',
  holdingMonths: '1',
  collateralPriceDrop: '10',
  lltvBuffer: '10',
  borrowApyIncrease: '0',
  ptApyHaircut: '0',
  entryCost: '0',
  exitCost: '0',
  fixedCost: '0',
}

const selectClass =
  'h-10 w-full rounded-[10px] border border-hairline bg-surface px-3 text-sm text-fg outline-none transition hover:border-hairline-strong focus:border-[rgba(var(--op-accent-rgb),0.7)] focus:ring-2 focus:ring-[rgba(var(--op-accent-rgb),0.12)]'
const inputClass =
  'h-10 w-full rounded-[10px] border border-hairline bg-surface px-3 text-sm tabular-nums text-fg outline-none transition placeholder:text-faint hover:border-hairline-strong focus:border-[rgba(var(--op-accent-rgb),0.7)] focus:ring-2 focus:ring-[rgba(var(--op-accent-rgb),0.12)]'

function chainFromParam(value: string | null): ChainFilter {
  if (value === null || !/^\d+$/.test(value)) return 'all'
  const chainId = Number(value)
  return isSupportedChainId(chainId) ? chainId : 'all'
}

function sortFromParam(value: string | null): SortKey {
  if (
    value === 'spread' ||
    value === 'liquidity' ||
    value === 'pt-apy' ||
    value === 'borrow-apy' ||
    value === 'expiry'
  ) {
    return value
  }
  return 'liquidity'
}

function acquisitionModeFromParam(value: string | null): AcquisitionMode {
  return value === 'mint' ? 'mint' : 'market'
}

function minimumLiquidityFromParam(value: string | null): number {
  if (value === null) return DEFAULT_MIN_BORROW_LIQUIDITY_USD
  if (value.trim() === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 1e15) : 0
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'The looping market directory could not be loaded.'
}

function marketSpread(candidate: LoopingMarketCandidate): number | null {
  const ptApy = candidate.pendle.impliedApy
  return ptApy === null ? null : ptApy - candidate.morpho.state.borrowApy
}

function metricDescending(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return right - left
}

function searchableMarket(candidate: LoopingMarketCandidate): string {
  const { morpho, pendle } = candidate
  return [
    pendle.name,
    morpho.chainNetwork,
    morpho.marketId,
    morpho.loanAsset.symbol,
    morpho.loanAsset.address,
    morpho.collateralAsset.symbol,
    morpho.collateralAsset.address,
    pendle.market,
    pendle.pt,
  ]
    .join(' ')
    .toLowerCase()
}

function parseNumberField(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (value.trim() === '') throw new Error(`${label} is required.`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return parsed
}

function parseExactAssets(value: string, decimals: number): bigint {
  const cleaned = value.trim()
  if (!/^\d+(?:\.\d*)?$/.test(cleaned)) {
    throw new Error('Enter a positive amount.')
  }
  const [whole, fraction = ''] = cleaned.split('.')
  if (fraction.length > decimals) {
    throw new Error(`Equity supports at most ${decimals} decimal places.`)
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0')
  if (units <= 0n) throw new Error('Equity must be greater than zero.')
  return units
}

function isExecutionEnabled(candidate: LoopingMarketCandidate): boolean {
  return isLoopingExecutionCandidateSupported(candidate)
}

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'age unavailable'
  if (seconds < -CLOCK_SKEW_TOLERANCE_SECONDS) return 'timestamp is ahead of this browser'
  if (seconds < 0) return 'just now'
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function isStaleAge(ageSeconds: number, maximumAgeSeconds: number): boolean {
  return ageSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS || ageSeconds > maximumAgeSeconds
}

function formatEstimateAmount(value: number, symbol: string): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${symbol}`
}

function formatUsd(value: number | null): string {
  return value === null ? 'Unavailable' : `$${formatCompact(value)}`
}

function chainLabel(chainId: number): string {
  return supportedChain(chainId)?.name ?? `Chain ${chainId}`
}

function EstimateCard({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string
  value: string
  note: string
  tone?: 'neutral' | 'good' | 'warn'
}) {
  const valueClass = tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : 'text-fg'
  return (
    <div className="rounded-xl border border-hairline bg-surface-2 p-3.5">
      <p className="text-[10px] font-medium uppercase tracking-[.06em] text-faint">{label}</p>
      <p className={`mt-1.5 text-lg font-bold tabular-nums ${valueClass}`}>{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-muted">{note}</p>
    </div>
  )
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-[.05em] text-faint">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-fg">{value}</span>
    </div>
  )
}

function NumberField({
  id,
  label,
  value,
  onChange,
  suffix,
  min,
  max,
  step,
  help,
  disabled = false,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  suffix?: string
  min: number
  max: number
  step: string
  help: string
  disabled?: boolean
}) {
  const helpId = `${id}-help`
  return (
    <label htmlFor={id} className="block">
      <span className="text-[10.5px] font-medium uppercase tracking-[.05em] text-faint">{label}</span>
      <span className="relative mt-1 block">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={helpId}
          disabled={disabled}
          className={`${inputClass} ${suffix ? 'pr-12' : ''} disabled:cursor-not-allowed disabled:opacity-60`}
        />
        {suffix && (
          <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">
            {suffix}
          </span>
        )}
      </span>
      <span id={helpId} className="mt-1 block text-[10.5px] leading-4 text-faint">{help}</span>
    </label>
  )
}

function DirectorySkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading looping markets">
      {Array.from({ length: DIRECTORY_PAGE_SIZE }, (_, index) => (
        <div key={index} className="h-40 animate-pulse rounded-xl border border-hairline bg-surface" />
      ))}
    </div>
  )
}

function MarketOption({
  candidate,
  selected,
  now,
  onSelect,
  disabled = false,
}: {
  candidate: LoopingMarketCandidate
  selected: boolean
  now: number
  onSelect: () => void
  disabled?: boolean
}) {
  const { morpho, pendle } = candidate
  const spread = marketSpread(candidate)
  const stateAge = now - morpho.state.timestamp
  const stale = isStaleAge(stateAge, MARKET_STATE_STALE_AFTER_SECONDS)
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={selected
        ? 'w-full rounded-xl border border-[rgba(var(--op-accent-rgb),0.55)] bg-[rgba(var(--op-accent-rgb),0.08)] p-4 text-left shadow-[var(--op-shadow)] outline-none ring-1 ring-[rgba(var(--op-accent-rgb),0.12)] focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60'
        : 'w-full rounded-xl border border-hairline bg-surface p-4 text-left outline-none transition hover:border-hairline-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60'}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg" title={pendle.name}>
            {clampLabel(pendle.name, 48)}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {chainLabel(morpho.chainId)} · borrow {morpho.loanAsset.symbol}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {selected && (
            <span className="rounded-full border border-[rgba(var(--op-accent-rgb),0.3)] bg-[rgba(var(--op-accent-rgb),0.08)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-accent-ink">
              Selected
            </span>
          )}
          {!morpho.listed && (
            <span className="rounded-full border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-warn">
              Unlisted
            </span>
          )}
          {isExecutionEnabled(candidate) && (
            <span className="rounded-full border border-[rgba(52,211,153,0.3)] bg-[var(--op-good-soft)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-good">
              Loopable
            </span>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] tabular-nums">
        <span className="text-faint">
          PT{' '}
          <span className="font-semibold text-accent-ink">
            {pendle.impliedApy === null ? '—' : formatPercent(pendle.impliedApy)}
          </span>
        </span>
        <span className="text-faint">
          Borrow <span className="font-semibold text-fg">{formatPercent(morpho.state.borrowApy)}</span>
        </span>
        <span className="text-faint">
          Spread{' '}
          <span className={`font-semibold ${spread !== null && spread >= 0 ? 'text-good' : 'text-warn'}`}>
            {spread === null ? '—' : formatPercent(spread)}
          </span>
        </span>
        <span className="text-faint">
          Liquidity <span className="font-semibold text-fg">{formatUsd(morpho.state.liquidityAssetsUsd)}</span>
        </span>
        <span className={`ml-auto ${stale ? 'text-warn' : 'text-faint'}`}>{formatAge(stateAge)}</span>
      </div>
    </button>
  )
}

export default function LoopingPage() {
  useDocumentTitle('PT looping')
  const transactionInFlight = useTransactionInFlight()
  const marketsQuery = useLoopingMarkets()
  const [searchParams, setSearchParams] = useSearchParams()
  const [form, setForm] = useState<CalculatorForm>(DEFAULT_FORM)
  const [visibleLimit, setVisibleLimit] = useState(DIRECTORY_PAGE_SIZE)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const queryText = (searchParams.get('q') ?? '').slice(0, 180)
  const chain = chainFromParam(searchParams.get('chain'))
  const positiveSpreadOnly = searchParams.get('positiveSpread') === 'true'
  const minimumLiquidityParam = searchParams.get('minLiquidity')
  const minimumLiquidityUsd = minimumLiquidityFromParam(minimumLiquidityParam)
  const minimumLiquidityInput = minimumLiquidityParam === null
    ? String(DEFAULT_MIN_BORROW_LIQUIDITY_USD)
    : minimumLiquidityParam.trim() === ''
      ? ''
      : String(minimumLiquidityUsd)
  const sort = sortFromParam(searchParams.get('sort'))
  const acquisitionMode = acquisitionModeFromParam(searchParams.get('mode'))
  const selectedKey = searchParams.get('selected')
  const candidates = marketsQuery.data?.candidates ?? EMPTY_CANDIDATES

  const updateParam = (key: string, value: string, defaultValue: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === defaultValue || value.trim() === '') next.delete(key)
    else next.set(key, value)
    setSearchParams(next, { replace: true })
  }

  const updateMinimumLiquidity = (value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === String(DEFAULT_MIN_BORROW_LIQUIDITY_USD)) next.delete('minLiquidity')
    else next.set('minLiquidity', value)
    setSearchParams(next, { replace: true })
  }

  const setAcquisitionMode = (nextMode: AcquisitionMode) => {
    if (transactionInFlight) return
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      if (nextMode === 'market') next.delete('mode')
      else next.set('mode', 'mint')
      return next
    }, { replace: true })
  }

  const setSelectedMarket = (marketKey: string | null) => {
    if (transactionInFlight) return
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      if (marketKey === null || next.get('selected') === marketKey) next.delete('selected')
      else next.set('selected', marketKey)
      return next
    }, { replace: true })
  }

  const visible = useMemo(() => {
    const needle = queryText.trim().toLowerCase()
    return candidates
      .filter((candidate) => chain === 'all' || candidate.morpho.chainId === chain)
      .filter((candidate) => !positiveSpreadOnly || (marketSpread(candidate) ?? 0) > 0)
      .filter((candidate) => {
        if (minimumLiquidityUsd <= 0) return true
        const liquidityUsd = candidate.morpho.state.liquidityAssetsUsd
        return liquidityUsd !== null && liquidityUsd >= minimumLiquidityUsd
      })
      .filter((candidate) => needle === '' || searchableMarket(candidate).includes(needle))
      .sort((left, right) => {
        let order = 0
        if (sort === 'spread') order = metricDescending(marketSpread(left), marketSpread(right))
        if (sort === 'liquidity') {
          order = metricDescending(
            left.morpho.state.liquidityAssetsUsd,
            right.morpho.state.liquidityAssetsUsd,
          )
        }
        if (sort === 'pt-apy') {
          order = metricDescending(left.pendle.impliedApy, right.pendle.impliedApy)
        }
        if (sort === 'borrow-apy') {
          order = left.morpho.state.borrowApy - right.morpho.state.borrowApy
        }
        if (sort === 'expiry') order = left.pendle.expiry - right.pendle.expiry
        return order || left.pendle.name.localeCompare(right.pendle.name)
      })
  }, [candidates, chain, minimumLiquidityUsd, positiveSpreadOnly, queryText, sort])

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.key === selectedKey),
    [candidates, selectedKey],
  )
  const selectedMatchesFilters = selectedCandidate !== undefined &&
    visible.some((candidate) => candidate.key === selectedCandidate.key)
  const selectedRiskIncreaseEligibility = selectedCandidate === undefined
    ? undefined
    : evaluateLoopingRiskIncreaseEligibility(selectedCandidate, now)
  const selectedSpread = selectedCandidate === undefined ? null : marketSpread(selectedCandidate)
  const leverageMaximum = selectedCandidate === undefined
    ? 5
    : calculateLoopingLeverageCap(selectedCandidate.morpho.tuple.lltv, SLIDER_MAX_POLICY)
  const leverageWarningThreshold = selectedCandidate === undefined
    ? 3
    : calculateLoopingLeverageCap(selectedCandidate.morpho.tuple.lltv, SLIDER_WARNING_POLICY)
  const leverageWarningPosition = leverageMaximum <= 1
    ? 0
    : Math.max(0, Math.min(100,
        (leverageWarningThreshold - 1) / (leverageMaximum - 1) * 100,
      ))
  const currentLeverage = Number(form.leverage)
  const beyondLeverageWarning = Number.isFinite(currentLeverage) &&
    currentLeverage > leverageWarningThreshold
  const orderedVisible = useMemo(() => {
    if (
      selectedCandidate === undefined ||
      !visible.some((candidate) => candidate.key === selectedCandidate.key)
    ) {
      return visible
    }
    return [
      selectedCandidate,
      ...visible.filter((candidate) => candidate.key !== selectedCandidate.key),
    ]
  }, [selectedCandidate, visible])

  useEffect(() => {
    setVisibleLimit(DIRECTORY_PAGE_SIZE)
  }, [chain, minimumLiquidityUsd, positiveSpreadOnly, queryText, sort])

  useEffect(() => {
    if (selectedCandidate === undefined || transactionInFlight) return
    const currentLeverage = Number(form.leverage)
    if (Number.isFinite(currentLeverage) && currentLeverage >= 1) {
      if (currentLeverage <= leverageMaximum) return
      setForm((current) => ({ ...current, leverage: leverageMaximum.toFixed(2) }))
      return
    }
    const fallbackLeverage = Math.min(Number(DEFAULT_FORM.leverage), leverageMaximum)
    setForm((current) => ({ ...current, leverage: fallbackLeverage.toFixed(2) }))
  }, [form.leverage, leverageMaximum, selectedCandidate, transactionInFlight])

  const calculator = useMemo<CalculatorSuccess | CalculatorFailure | null>(() => {
    if (selectedCandidate === undefined) return null
    try {
      const ptApy = acquisitionMode === 'market'
        ? selectedCandidate.pendle.impliedApy
        : 0
      if (ptApy === null) {
        throw new Error('The selected market has no current PT APY estimate.')
      }
      const equityNumber = parseNumberField(form.equity, 'Equity', Number.MIN_VALUE, 1e15)
      const equityAssets = parseExactAssets(
        form.equity,
        selectedCandidate.morpho.loanAsset.decimals,
      )
      const input: LoopingScenarioInput = {
        leverage: parseNumberField(form.leverage, 'Leverage', 1, leverageMaximum),
        ptApy,
        borrowApy: selectedCandidate.morpho.state.borrowApy,
        lltv: selectedCandidate.morpho.tuple.lltv,
        holdingPeriodYears: 1,
        collateralPriceDrop: SLIDER_MAX_POLICY.collateralPriceDrop,
        lltvBuffer: SLIDER_MAX_POLICY.lltvBuffer,
      }
      const scenario = calculateLoopingScenario(input)
      return { ok: true, equityNumber, equityAssets, input, scenario }
    } catch (error) {
      return { ok: false, error: readableError(error) }
    }
  }, [acquisitionMode, form.equity, form.leverage, leverageMaximum, selectedCandidate])

  const advancedCalculator = useMemo<AdvancedCalculatorSuccess | CalculatorFailure | null>(() => {
    if (selectedCandidate === undefined || calculator === null || !calculator.ok) return null
    try {
      const holdingMonths = parseNumberField(
        form.holdingMonths,
        'Holding period',
        0.25,
        120,
      )
      const holdingPeriodSeconds = holdingMonths * SECONDS_PER_YEAR / 12
      const secondsUntilMaturity = selectedCandidate.pendle.expiry - now
      if (holdingPeriodSeconds > secondsUntilMaturity) {
        const monthsUntilMaturity = Math.max(0, secondsUntilMaturity * 12 / SECONDS_PER_YEAR)
        throw new Error(
          `Holding period must end before PT maturity (${monthsUntilMaturity.toFixed(2)} months remaining).`,
        )
      }
      const input: LoopingScenarioInput = {
        ...calculator.input,
        holdingPeriodYears: holdingMonths / 12,
        collateralPriceDrop:
          parseNumberField(form.collateralPriceDrop, 'Collateral price drop', 0, 99) / 100,
        lltvBuffer: parseNumberField(form.lltvBuffer, 'LLTV buffer', 0, 99) / 100,
        borrowApyIncrease:
          parseNumberField(form.borrowApyIncrease, 'Borrow APY increase', 0, 100) / 100,
        ptApyHaircut: parseNumberField(form.ptApyHaircut, 'PT APY haircut', 0, 100) / 100,
        entryCostRate: parseNumberField(form.entryCost, 'Entry cost', 0, 25) / 100,
        exitCostRate: parseNumberField(form.exitCost, 'Exit cost', 0, 25) / 100,
        fixedCostOnEquity: parseNumberField(form.fixedCost, 'Fixed cost', 0, 25) / 100,
      }
      const scenario = calculateLoopingScenario(input)
      return { ok: true, input, scenario }
    } catch (error) {
      return { ok: false, error: readableError(error) }
    }
  }, [calculator, form.borrowApyIncrease, form.collateralPriceDrop, form.entryCost,
    form.exitCost, form.fixedCost, form.holdingMonths, form.lltvBuffer, form.ptApyHaircut,
    now, selectedCandidate])

  const coverage = marketsQuery.data?.coverage
  const directoryAge = marketsQuery.data === undefined ? null : now - marketsQuery.data.fetchedAt
  const directoryStale = directoryAge !== null &&
    isStaleAge(directoryAge, DIRECTORY_SNAPSHOT_STALE_AFTER_SECONDS)
  const oldestStateAge = coverage?.morphoOldestStateAt == null
    ? null
    : now - coverage.morphoOldestStateAt
  const indexedStateStale = oldestStateAge !== null &&
    isStaleAge(oldestStateAge, MARKET_STATE_STALE_AFTER_SECONDS)
  const partialCoverage = coverage !== undefined && !coverage.complete
  const uniqueMorphoCandidates = [
    ...new Map(candidates.map((candidate) => [candidate.morpho.key, candidate])).values(),
  ]
  const exactMatchCount = uniqueMorphoCandidates.length
  const listedCount = uniqueMorphoCandidates.filter((candidate) => candidate.morpho.listed).length
  const candidateChainCount = new Set(candidates.map((candidate) => candidate.morpho.chainId)).size
  const reportedLiquidity = uniqueMorphoCandidates.reduce(
    (total, candidate) => total + (candidate.morpho.state.liquidityAssetsUsd ?? 0),
    0,
  )
  const setFormField = (key: keyof CalculatorForm, value: string) => {
    if (transactionInFlight) return
    setForm((current) => ({ ...current, [key]: value }))
  }

  const resetAdvancedAssumptions = () => {
    if (transactionInFlight) return
    setForm((current) => ({
      ...current,
      holdingMonths: DEFAULT_FORM.holdingMonths,
      collateralPriceDrop: DEFAULT_FORM.collateralPriceDrop,
      lltvBuffer: DEFAULT_FORM.lltvBuffer,
      borrowApyIncrease: DEFAULT_FORM.borrowApyIncrease,
      ptApyHaircut: DEFAULT_FORM.ptApyHaircut,
      entryCost: DEFAULT_FORM.entryCost,
      exitCost: DEFAULT_FORM.exitCost,
      fixedCost: DEFAULT_FORM.fixedCost,
    }))
  }

  const filtersActive = queryText !== '' || chain !== 'all' || positiveSpreadOnly ||
    minimumLiquidityUsd !== DEFAULT_MIN_BORROW_LIQUIDITY_USD || sort !== 'liquidity'
  const advancedScenarioSafe = advancedCalculator?.ok === true &&
    advancedCalculator.scenario.withinProtocolLltv &&
    advancedCalculator.scenario.withinConservativeLimit

  const clearFilters = () => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      next.delete('q')
      next.delete('chain')
      next.delete('listed')
      next.delete('borrowable')
      next.delete('positiveSpread')
      next.delete('minLiquidity')
      next.delete('sort')
      return next
    }, { replace: true })
  }

  return (
    <div className="space-y-6 pb-8 sm:pb-10">
      <PageHeader
        title="PT looping"
        lede={acquisitionMode === 'mint'
          ? 'Mint PT+YT, supply only PT as Morpho collateral, and keep YT in your wallet.'
          : 'Leverage Pendle PT collateral against Morpho borrow markets, with modeled APY and liquidation distance.'}
        actions={
          <button
            type="button"
            onClick={() => void marketsQuery.refetch()}
            disabled={marketsQuery.isFetching}
            className="rounded-[10px] border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-fg transition hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
          >
            {marketsQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      <aside
        className="rounded-md border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-[12.5px] text-warn"
        aria-label="Looping risk notice"
      >
        Estimates only — rates, liquidity and liquidation distance can move before you transact.
      </aside>

      {marketsQuery.isError && marketsQuery.data !== undefined && (
        <div role="status" className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-sm text-warn">
          Refresh failed — showing the last snapshot. {readableError(marketsQuery.error)}
        </div>
      )}

      {partialCoverage && coverage !== undefined && (
        <div role="status" className="rounded-md border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-[12.5px] text-warn">
          {coverage.unsupportedChainIds.length > 0
            ? `Morpho data doesn't cover ${coverage.unsupportedChainIds.map(chainLabel).join(', ')}. `
            : ''}
          {coverage.incompleteMorphoApiChainIds.length > 0
            ? `Incomplete networks: ${coverage.incompleteMorphoApiChainIds.map(chainLabel).join(', ')}. `
            : ''}
          Some markets may be missing.
        </div>
      )}

      {(directoryStale || indexedStateStale) && marketsQuery.data !== undefined && (
        <div role="status" className="rounded-md border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-[12.5px] text-warn">
          Stale data —{' '}
          {directoryStale && directoryAge !== null ? `directory fetched ${formatAge(directoryAge)}. ` : ''}
          {indexedStateStale && oldestStateAge !== null ? `oldest Morpho state ${formatAge(oldestStateAge)}. ` : ''}
          Refresh before relying on estimates.
        </div>
      )}

      {marketsQuery.data !== undefined && candidates.length > 0 && (
        <section
          aria-label="Looping market summary"
          className="flex flex-wrap items-center gap-x-7 gap-y-2 rounded-lg border border-hairline bg-surface px-4 py-3"
        >
          <SummaryStat label="Exact matches" value={exactMatchCount.toLocaleString('en-US')} />
          <SummaryStat label="Morpho listed" value={listedCount.toLocaleString('en-US')} />
          <SummaryStat label="Networks" value={candidateChainCount.toLocaleString('en-US')} />
          <SummaryStat label="Borrow liquidity" value={`$${formatCompact(reportedLiquidity)}`} />
        </section>
      )}

      {marketsQuery.data !== undefined && candidates.length > 0 && (
        <section aria-label="Market directory filters" className="rounded-xl border border-hairline bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-faint" aria-live="polite">
              {visible.length.toLocaleString('en-US')} of {candidates.length.toLocaleString('en-US')} matches
            </p>
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="text-xs font-medium text-accent-ink hover:underline">
                Reset filters
              </button>
            )}
          </div>

          <div className="mt-3 grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(240px,1.5fr)_minmax(145px,0.8fr)_64px_minmax(145px,0.8fr)_minmax(175px,0.9fr)]">
            <label className="sm:col-span-2 xl:col-span-1">
              <span className="text-[10px] font-medium uppercase tracking-[.05em] text-faint">Search</span>
              <input
                type="search"
                maxLength={180}
                value={queryText}
                onChange={(event) => updateParam('q', event.target.value.slice(0, 180), '')}
                placeholder="Name, token, market ID or address…"
                className={`mt-1 ${inputClass}`}
              />
            </label>
            <label className="text-[10px] font-medium uppercase tracking-[.05em] text-faint">
              Network
              <select value={chain} onChange={(event) => updateParam('chain', event.target.value, 'all')} className={`mt-1 ${selectClass}`}>
                <option value="all">All networks</option>
                {SUPPORTED_CHAINS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <div>
              <span className="block text-[10px] font-medium uppercase leading-[1.05] tracking-[.05em] text-faint">
                Positive<br />Spread
              </span>
              <label
                title="Positive spread only"
                className="op-spread-filter-toggle mt-1 cursor-pointer rounded-[10px] border border-hairline bg-surface transition hover:border-hairline-strong"
              >
                <input
                  type="checkbox"
                  aria-label="Positive spread only"
                  checked={positiveSpreadOnly}
                  onChange={(event) => updateParam('positiveSpread', event.target.checked ? 'true' : '', '')}
                  className="h-4 w-4 rounded border-hairline accent-[var(--op-accent)]"
                />
              </label>
            </div>
            <label className="text-[10px] font-medium uppercase tracking-[.05em] text-faint">
              Min borrow liquidity ($)
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={1e15}
                step="any"
                value={minimumLiquidityInput}
                onChange={(event) => updateMinimumLiquidity(event.target.value)}
                className={`mt-1 ${inputClass}`}
              />
            </label>
            <label className="text-[10px] font-medium uppercase tracking-[.05em] text-faint">
              Sort
              <select value={sort} onChange={(event) => updateParam('sort', event.target.value, 'liquidity')} className={`mt-1 ${selectClass} !pl-2.5 !pr-8 !text-[11px]`}>
                <option value="spread">Highest raw spread</option>
                <option value="liquidity">Most borrow liquidity</option>
                <option value="pt-apy">Highest PT APY</option>
                <option value="borrow-apy">Lowest borrow APY</option>
                <option value="expiry">Soonest maturity</option>
              </select>
            </label>
          </div>
          <p className="mt-2 text-[10.5px] leading-4 text-faint">
            Borrow liquidity is what's currently borrowable on Morpho, not market TVL.
          </p>
        </section>
      )}

      {marketsQuery.isPending && marketsQuery.data === undefined ? (
        <DirectorySkeleton />
      ) : marketsQuery.data === undefined ? (
        <section role="alert" className="rounded-xl border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-5">
          <h2 className="font-semibold text-danger">Looping markets are temporarily unavailable</h2>
          <p className="mt-1.5 text-sm text-muted">{readableError(marketsQuery.error)}</p>
          <button
            type="button"
            onClick={() => void marketsQuery.refetch()}
            className="mt-4 rounded-[10px] border border-[var(--op-danger-bd)] px-3.5 py-2 text-sm font-medium text-danger hover:bg-[var(--op-danger-soft)]"
          >
            Try again
          </button>
        </section>
      ) : candidates.length === 0 ? (
        <section className="rounded-xl border border-hairline bg-surface px-5 py-12 text-center">
          <h2 className="font-semibold text-fg">No exact PT-collateral matches are available</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted">
            Morpho returned {marketsQuery.data.morphoMarketCount.toLocaleString('en-US')} markets,
            but none currently use a live Pendle PT as collateral on the same network.
          </p>
        </section>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.5fr)]">
          <section className="rounded-xl border border-hairline bg-surface" aria-labelledby="looping-directory-title">
            <div className="border-b border-hairline p-4">
              <h2 id="looping-directory-title" className="font-semibold text-fg">Market directory</h2>
              <p className="mt-1 text-xs text-faint" aria-live="polite">
                Select a market to model its loop
              </p>
            </div>

            <div className="space-y-3 p-3">
              {visible.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="font-medium text-fg">No markets match these filters</p>
                  <p className="mt-1.5 text-sm text-muted">Clear a filter or search another token or address.</p>
                </div>
              ) : orderedVisible.slice(0, visibleLimit).map((candidate) => (
                  <MarketOption
                    key={candidate.key}
                    candidate={candidate}
                    selected={candidate.key === selectedCandidate?.key}
                    now={now}
                    onSelect={() => setSelectedMarket(candidate.key)}
                    disabled={transactionInFlight}
                />
              ))}
              {orderedVisible.length > visibleLimit && (
                <button
                  type="button"
                  onClick={() => setVisibleLimit((current) => current + DIRECTORY_PAGE_SIZE)}
                  className="w-full rounded-[10px] border border-hairline bg-surface-2 px-3 py-2.5 text-sm font-medium text-fg hover:border-hairline-strong"
                >
                  Load {Math.min(DIRECTORY_PAGE_SIZE, orderedVisible.length - visibleLimit)} more {Math.min(DIRECTORY_PAGE_SIZE, orderedVisible.length - visibleLimit) === 1 ? 'market' : 'markets'}
                </button>
              )}
            </div>

            <footer className="border-t border-hairline px-4 py-3 text-[10.5px] leading-4 text-faint">
              {marketsQuery.data.morphoMarketCount.toLocaleString('en-US')} Morpho markets checked
            </footer>
          </section>

          {selectedCandidate === undefined ? (
            <section className="rounded-xl border border-hairline bg-surface px-5 py-12 text-center">
              <h2 className="font-semibold text-fg">
                {selectedKey === null ? 'No market selected' : 'Selected market unavailable'}
              </h2>
              <p className="mt-2 text-sm text-muted">
                {selectedKey === null
                  ? acquisitionMode === 'mint'
                    ? 'Choose a market to preview PT collateral and YT sent to your wallet.'
                    : 'Choose a market from the directory to model its leverage and estimated APY.'
                  : 'This saved market is no longer present in the current directory data.'}
                </p>
                {selectedKey !== null && (
                  <button type="button" disabled={transactionInFlight} onClick={() => setSelectedMarket(null)} className="mt-4 text-sm font-medium text-accent-ink hover:underline disabled:cursor-not-allowed disabled:opacity-60">
                  Clear selection
                </button>
              )}
            </section>
          ) : (
            <div className="min-w-0 space-y-5">
              <section className="overflow-hidden rounded-xl border border-hairline bg-surface" aria-labelledby="selected-looping-market">
                <div className="p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium uppercase tracking-[.08em] text-accent-ink">Selected research market</p>
                      <h2 id="selected-looping-market" className="mt-1 break-words text-xl font-bold text-fg sm:text-2xl">
                        {clampLabel(selectedCandidate.pendle.name, 72)}
                      </h2>
                      <p className="mt-1 text-sm text-muted">
                        {chainLabel(selectedCandidate.morpho.chainId)} · {selectedCandidate.morpho.loanAsset.symbol} debt · {selectedCandidate.morpho.collateralAsset.symbol} collateral
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={selectedCandidate.morpho.listed
                        ? 'rounded-full border border-[rgba(var(--op-accent-rgb),0.3)] bg-[rgba(var(--op-accent-rgb),0.08)] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.06em] text-accent-ink'
                        : 'rounded-full border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.06em] text-warn'}>
                        {selectedCandidate.morpho.listed ? 'Morpho listed' : 'Morpho unlisted'}
                      </span>
                      <span className={selectedCandidate.pendle.pendleStatus === 'active'
                        ? 'rounded-full border border-[rgba(52,211,153,0.28)] bg-[var(--op-good-soft)] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.06em] text-good'
                        : 'rounded-full border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.06em] text-warn'}>
                        Pendle {selectedCandidate.pendle.pendleStatus ?? 'coverage unknown'}
                      </span>
                      <button
                        type="button"
                        disabled={transactionInFlight}
                        onClick={() => setSelectedMarket(null)}
                        className="text-xs font-medium text-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  {!selectedMatchesFilters && (
                    <div className="mt-4 rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3.5 py-3 text-xs text-warn">
                      This market is selected but hidden by the current directory filters.
                    </div>
                  )}

                  {isExecutionEnabled(selectedCandidate) &&
                    selectedRiskIncreaseEligibility?.eligible === false && (
                    <div className="mt-4 rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3.5 py-3 text-xs leading-5 text-warn">
                      <span className="font-semibold">New borrowing paused.</span>{' '}
                      {selectedRiskIncreaseEligibility.message} You can still reduce leverage or
                      exit.
                    </div>
                  )}

                  <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div className="rounded-lg bg-surface-2 p-3">
                      <dt className="text-[9px] uppercase tracking-[.06em] text-faint">
                        {acquisitionMode === 'mint' ? 'Mint output' : 'PT APY'}
                      </dt>
                      <dd className="mt-1 text-lg font-bold tabular-nums text-accent-ink">
                        {acquisitionMode === 'mint'
                          ? 'PT + YT'
                          : selectedCandidate.pendle.impliedApy === null
                            ? '—'
                            : formatPercent(selectedCandidate.pendle.impliedApy)}
                      </dd>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-3">
                      <dt className="text-[9px] uppercase tracking-[.06em] text-faint">Borrow APY</dt>
                      <dd className="mt-1 text-lg font-bold tabular-nums text-fg">{formatPercent(selectedCandidate.morpho.state.borrowApy)}</dd>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-3">
                      <dt className="text-[9px] uppercase tracking-[.06em] text-faint">
                        {acquisitionMode === 'mint' ? 'YT destination' : 'Raw spread'}
                      </dt>
                      <dd className={`mt-1 text-lg font-bold tabular-nums ${acquisitionMode === 'mint' || selectedSpread === null ? 'text-fg' : selectedSpread >= 0 ? 'text-good' : 'text-danger'}`}>
                        {acquisitionMode === 'mint'
                          ? 'Wallet'
                          : selectedSpread === null
                            ? '—'
                            : formatPercent(selectedSpread)}
                      </dd>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-3">
                      <dt className="text-[9px] uppercase tracking-[.06em] text-faint">Borrow liquidity</dt>
                      <dd className="mt-1 text-lg font-bold tabular-nums text-fg">{formatUsd(selectedCandidate.morpho.state.liquidityAssetsUsd)}</dd>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-3">
                      <dt className="text-[9px] uppercase tracking-[.06em] text-faint">LLTV</dt>
                      <dd className="mt-1 text-lg font-bold tabular-nums text-fg">{formatPercent(Number(selectedCandidate.morpho.tuple.lltv) / 1e18, 1)}</dd>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-3">
                      <dt className="text-[9px] uppercase tracking-[.06em] text-faint">Utilization</dt>
                      <dd className="mt-1 text-lg font-bold tabular-nums text-fg">{formatPercent(selectedCandidate.morpho.state.utilization, 1)}</dd>
                    </div>
                  </dl>

                  <div className="mt-4 grid gap-2 text-[10.5px] text-faint sm:grid-cols-2">
                    <p>Morpho <code className="font-mono text-muted" title={selectedCandidate.morpho.marketId}>{shortAddress(selectedCandidate.morpho.marketId)}</code></p>
                    <p>Pendle <code className="font-mono text-muted" title={selectedCandidate.pendle.market}>{shortAddress(selectedCandidate.pendle.market)}</code></p>
                    <p>Expiry <span className="text-muted">{formatDate(selectedCandidate.pendle.expiry)}</span></p>
                    <p>Indexed state <span className={isStaleAge(now - selectedCandidate.morpho.state.timestamp, MARKET_STATE_STALE_AFTER_SECONDS) ? 'text-warn' : 'text-muted'}>{formatAge(now - selectedCandidate.morpho.state.timestamp)}</span></p>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-hairline bg-surface p-5 sm:p-6" aria-labelledby="risk-calculator-title">
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-[.08em] text-accent-ink">
                    {acquisitionMode === 'mint' ? 'Mint path' : 'Current-rate estimate'}
                  </p>
                  <h2 id="risk-calculator-title" className="mt-1 text-lg font-semibold text-fg">
                    {acquisitionMode === 'mint'
                      ? 'Capital multiple and live mint quote'
                      : 'Leverage and estimated APY'}
                  </h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
                    {acquisitionMode === 'mint'
                      ? 'Final PT collateral, YT output, and health are set by the live mint quote.'
                      : "Holds today's rates constant; excludes fees and slippage."}
                  </p>
                </div>

                <div className="mt-4 rounded-xl border border-hairline bg-surface-2 p-1.5">
                  <div
                    className="grid grid-cols-2 gap-1"
                    role="group"
                    aria-label="Loop acquisition mode"
                  >
                    {(['market', 'mint'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        disabled={transactionInFlight}
                        aria-pressed={acquisitionMode === option}
                        onClick={() => setAcquisitionMode(option)}
                        className={`rounded-[8px] px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${acquisitionMode === option
                          ? 'bg-[rgba(var(--op-accent-rgb),0.12)] text-accent-ink'
                          : 'text-muted hover:text-fg'}`}
                      >
                        {option === 'market' ? 'Market Mode' : 'Mint Mode'}
                      </button>
                    ))}
                  </div>
                  <p className="px-2 pb-1 pt-2 text-[10.5px] leading-4 text-muted">
                    {acquisitionMode === 'mint'
                      ? 'Your funds and borrowed capital mint equal PT+YT. PT is supplied as Morpho collateral; YT stays in your wallet and does not support the loan.'
                      : 'Your funds and borrowed capital buy PT on the market. All acquired PT is supplied as Morpho collateral.'}
                  </p>
                </div>

                <LoopingExecutionProvider
                  candidate={selectedCandidate}
                  equityAssets={calculator !== null && calculator.ok ? calculator.equityAssets : 0n}
                  leverage={form.leverage}
                  acquisitionMode={acquisitionMode}
                >
                <div className="mt-5 grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
                  <div>
                    <NumberField id="loop-equity" label={`Amount (${selectedCandidate.morpho.loanAsset.symbol})`} value={form.equity} onChange={(value) => setFormField('equity', value)} min={0} max={1e15} step="any" help="Checked against your wallet balance before execution." disabled={transactionInFlight} />
                    <div className="mt-3">
                      <LoopingExecutionAction />
                    </div>
                  </div>
                  <div className="rounded-xl border border-hairline bg-surface-2 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="loop-leverage" className="text-sm font-semibold text-fg">
                        {acquisitionMode === 'mint' ? 'Capital multiple' : 'Leverage'}
                      </label>
                      <output
                        htmlFor="loop-leverage"
                        aria-live="polite"
                        className={`text-xl font-bold tabular-nums ${acquisitionMode === 'market' && beyondLeverageWarning ? 'text-danger' : 'text-accent-ink'}`}
                      >
                        {Number(form.leverage).toFixed(2)}×
                      </output>
                    </div>
                    <div className="relative mt-4">
                      <input
                        id="loop-leverage"
                        type="range"
                        min={1}
                          max={leverageMaximum}
                          step={SLIDER_MAX_POLICY.step}
                          value={form.leverage}
                        disabled={transactionInFlight}
                        onChange={(event) => setFormField('leverage', event.target.value)}
                        aria-describedby="loop-leverage-help"
                        aria-valuetext={`${Number(form.leverage).toFixed(2)} times ${acquisitionMode === 'mint' ? 'capital multiple' : 'leverage'}${acquisitionMode === 'market' && beyondLeverageWarning ? ', below the 10% liquidation buffer' : ''}`}
                        className="block h-2 w-full cursor-pointer accent-[var(--op-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      {acquisitionMode === 'market' && (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-danger shadow-[0_0_0_2px_var(--op-surface-2)]"
                          style={{ left: `${leverageWarningPosition}%` }}
                        />
                      )}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10.5px] text-faint">
                      <span>1× · no borrowing</span>
                      <span>
                        {leverageMaximum.toFixed(2)}× · {acquisitionMode === 'mint'
                          ? 'rechecked with live quote'
                          : '1% liquidation buffer'}
                      </span>
                    </div>
                    <div id="loop-leverage-help" className="mt-3 flex items-start gap-2 text-[10.5px] leading-4 text-muted">
                      <span aria-hidden className="mt-0.5 h-3 w-0.5 shrink-0 rounded-full bg-danger" />
                      <p>
                        {acquisitionMode === 'mint'
                          ? 'The preview values only guaranteed minted PT as collateral and rechecks the liquidation buffer.'
                          : `Past the red mark (${leverageWarningThreshold.toFixed(2)}×), the liquidation buffer drops below 10%.`}
                      </p>
                    </div>
                    {acquisitionMode === 'market' && beyondLeverageWarning && (
                      <p role="status" aria-live="polite" className="mt-2 text-[10.5px] font-medium text-danger">
                        High liquidation risk: this leverage is past the 10% buffer marker.
                      </p>
                    )}
                  </div>
                </div>

                {calculator === null ? null : !calculator.ok ? (
                  <div role="alert" className="mt-5 rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-4 py-3 text-sm text-danger">
                    {calculator.error}
                  </div>
                ) : (
                  <>
                    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {acquisitionMode === 'mint' ? (
                        <>
                          <EstimateCard
                            label="Return estimate"
                            value="Not shown"
                            note="Mint Mode needs a verified SY yield source. PT APY is not used."
                          />
                          <EstimateCard
                            label="Estimated debt"
                            value={formatEstimateAmount(
                              calculator.equityNumber * calculator.scenario.debt,
                              selectedCandidate.morpho.loanAsset.symbol,
                            )}
                            note="Exact debt is rechecked before execution."
                          />
                          <EstimateCard
                            label="PT collateral"
                            value="Set by live quote"
                            note="Only guaranteed minted PT is supplied to Morpho."
                          />
                          <EstimateCard
                            label="YT to wallet"
                            value="Set by live quote"
                            note="YT stays in your wallet and is never counted as collateral."
                          />
                        </>
                      ) : (
                        <>
                          <EstimateCard label="Estimated loop APY" value={formatPercent(calculator.scenario.headlineLoopApy)} note={`${formatPercent(calculator.input.ptApy)} at 1×; each additional 1× changes APY by ${selectedSpread === null ? '—' : formatPercent(selectedSpread)}.`} tone={calculator.scenario.headlineLoopApy >= 0 ? 'good' : 'warn'} />
                          <EstimateCard label="Estimated debt" value={formatEstimateAmount(calculator.equityNumber * calculator.scenario.debt, selectedCandidate.morpho.loanAsset.symbol)} note={`${formatEstimateAmount(calculator.equityNumber * calculator.scenario.collateralExposure, `${selectedCandidate.morpho.loanAsset.symbol} equiv.`)} gross PT exposure.`} />
                          <EstimateCard label="Current LTV" value={formatPercent(calculator.scenario.currentLtv)} note={`Morpho LLTV is ${formatPercent(calculator.scenario.lltv)}.`} />
                          <EstimateCard label="Drop to liquidation" value={calculator.scenario.priceDropToLiquidation === null ? 'No debt' : formatPercent(calculator.scenario.priceDropToLiquidation)} note="Simplified constant-debt estimate; not an oracle guarantee." tone={calculator.scenario.priceDropToLiquidation !== null && calculator.scenario.priceDropToLiquidation < 0.15 ? 'warn' : 'neutral'} />
                        </>
                      )}
                    </div>

                    <LoopingExecutionPanel />

                    {acquisitionMode === 'mint' ? (
                      <div className="mt-5 rounded-xl border border-hairline bg-surface-2 p-4">
                        <p className="text-sm font-semibold text-fg">Mint Mode estimates come from the live quote</p>
                        <p className="mt-1 text-[10.5px] leading-4 text-muted">
                          Review the guaranteed PT collateral, minimum YT sent to your wallet,
                          actual LTV, and liquidation buffer in the execution preview. A return
                          APY is intentionally omitted until a verified SY yield source is available.
                        </p>
                      </div>
                    ) : (
                    <details className="mt-5 rounded-xl border border-hairline bg-surface-2 p-4">
                      <summary className="cursor-pointer text-sm font-semibold text-fg">Advanced stress assumptions</summary>
                      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
                          <p className="max-w-2xl text-[10.5px] leading-4 text-muted">
                            These inputs affect only the stressed result below.
                          </p>
                        <button type="button" disabled={transactionInFlight} onClick={resetAdvancedAssumptions} className="text-xs font-medium text-accent-ink hover:underline disabled:cursor-not-allowed disabled:opacity-60">Reset stress assumptions</button>
                      </div>
                      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <NumberField id="loop-holding" label="Holding period" value={form.holdingMonths} onChange={(value) => setFormField('holdingMonths', value)} suffix="mo" min={0.25} max={120} step="0.25" help={`Must end by ${formatDate(selectedCandidate.pendle.expiry)}.`} disabled={transactionInFlight} />
                        <NumberField id="loop-drop" label="Collateral price drop" value={form.collateralPriceDrop} onChange={(value) => setFormField('collateralPriceDrop', value)} suffix="%" min={0} max={99} step="0.1" help="Absolute stress to PT collateral value." disabled={transactionInFlight} />
                        <NumberField id="loop-buffer" label="Relative LLTV buffer" value={form.lltvBuffer} onChange={(value) => setFormField('lltvBuffer', value)} suffix="%" min={0} max={99} step="0.1" help="A 10% setting uses 90% of the protocol LLTV in this model." disabled={transactionInFlight} />
                        <NumberField id="loop-borrow-stress" label="Borrow APY increase" value={form.borrowApyIncrease} onChange={(value) => setFormField('borrowApyIncrease', value)} suffix="pp" min={0} max={100} step="0.1" help="Percentage points added to current borrowing cost." disabled={transactionInFlight} />
                        <NumberField id="loop-pt-stress" label="PT APY haircut" value={form.ptApyHaircut} onChange={(value) => setFormField('ptApyHaircut', value)} suffix="pp" min={0} max={100} step="0.1" help="Percentage points removed from current PT APY." disabled={transactionInFlight} />
                        <NumberField id="loop-entry-cost" label="Entry cost" value={form.entryCost} onChange={(value) => setFormField('entryCost', value)} suffix="%" min={0} max={25} step="0.01" help="One-time estimate on gross PT exposure." disabled={transactionInFlight} />
                        <NumberField id="loop-exit-cost" label="Exit cost" value={form.exitCost} onChange={(value) => setFormField('exitCost', value)} suffix="%" min={0} max={25} step="0.01" help="One-time estimate on gross PT exposure." disabled={transactionInFlight} />
                        <NumberField id="loop-fixed-cost" label="Fixed cost on equity" value={form.fixedCost} onChange={(value) => setFormField('fixedCost', value)} suffix="%" min={0} max={25} step="0.01" help="Gas, relayer, and aggregator estimate." disabled={transactionInFlight} />
                      </div>
                      {advancedCalculator === null ? null : !advancedCalculator.ok ? (
                        <div role="alert" className="mt-4 rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-4 py-3 text-sm text-danger">
                          {advancedCalculator.error}
                        </div>
                      ) : (
                        <div className={`mt-4 rounded-lg border p-3 ${advancedScenarioSafe ? 'border-hairline bg-surface' : 'border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)]'}`}>
                          <div>
                            <p className="text-[10px] uppercase tracking-[.06em] text-faint">
                              {advancedScenarioSafe ? 'Within modeled stress limit' : 'Unsafe under this stress'}
                            </p>
                            <p className={`mt-1 text-lg font-bold tabular-nums ${!advancedScenarioSafe ? 'text-danger' : advancedCalculator.scenario.conservativeNetApy >= 0 ? 'text-good' : 'text-warn'}`}>
                              {formatPercent(advancedCalculator.scenario.conservativeNetApy)} APY
                            </p>
                            <p className="mt-1 text-[10.5px] tabular-nums text-muted">
                              Stressed LTV {formatPercent(advancedCalculator.scenario.stressedLtv)} (limit {formatPercent(advancedCalculator.scenario.conservativeLltv)}) · max leverage {advancedCalculator.scenario.conservativeMaxLeverage.toFixed(2)}× · costs {formatPercent(advancedCalculator.scenario.annualizedOneTimeCosts)}/yr
                            </p>
                          </div>
                        </div>
                      )}
                    </details>
                    )}
                  </>
                )}
                </LoopingExecutionProvider>
              </section>

            </div>
          )}
        </div>
      )}
    </div>
  )
}
