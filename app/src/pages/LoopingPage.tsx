import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useDocumentTitle } from '../components/useDocumentTitle'
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
  LOOPING_EXECUTION_BETA_ENABLED,
  LOOPING_EXIT_BETA_ENABLED,
} from '../lib/loopingBeta'
import {
  evaluateLoopingRiskIncreaseEligibility,
  LOOPING_MIN_BORROW_LIQUIDITY_USD,
} from '../lib/loopingEligibility'

const MARKET_STATE_STALE_AFTER_SECONDS = 60 * 60
const DIRECTORY_SNAPSHOT_STALE_AFTER_SECONDS = 15 * 60
const DIRECTORY_PAGE_SIZE = 3
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
    throw new Error('Equity must be a plain positive token amount.')
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
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-[.06em] text-faint">{label}</p>
        <span className="rounded-full border border-hairline px-1.5 py-0.5 text-[8px] uppercase tracking-[.06em] text-faint">
          estimate
        </span>
      </div>
      <p className={`mt-1.5 text-lg font-bold tabular-nums ${valueClass}`}>{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-muted">{note}</p>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <p className="font-mono text-[10px] uppercase tracking-[.06em] text-faint">{label}</p>
      <p className="mt-1.5 text-xl font-bold tabular-nums text-fg">{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-muted">{note}</p>
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg" title={pendle.name}>
            {clampLabel(pendle.name, 48)}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {chainLabel(morpho.chainId)} · borrow {morpho.loanAsset.symbol}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {selected && (
            <span className="rounded-full border border-[rgba(var(--op-accent-rgb),0.3)] bg-[rgba(var(--op-accent-rgb),0.08)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-accent-ink">
              Selected · click to clear
            </span>
          )}
          <span className={morpho.listed
            ? 'rounded-full border border-[rgba(var(--op-accent-rgb),0.3)] bg-[rgba(var(--op-accent-rgb),0.08)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-accent-ink'
            : 'rounded-full border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-warn'}>
            {morpho.listed ? 'Morpho listed' : 'Morpho unlisted'}
          </span>
          {isExecutionEnabled(candidate) && (
            <span className="rounded-full border border-[rgba(52,211,153,0.3)] bg-[var(--op-good-soft)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-good">
              Looping enabled
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-y border-hairline py-3">
        <div>
          <p className="text-[9px] uppercase tracking-[.06em] text-faint">PT APY</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-accent-ink">
            {pendle.impliedApy === null ? '—' : formatPercent(pendle.impliedApy)}
          </p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-[.06em] text-faint">Borrow APY</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-fg">
            {formatPercent(morpho.state.borrowApy)}
          </p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-[.06em] text-faint">Raw spread</p>
          <p className={`mt-1 text-sm font-semibold tabular-nums ${spread !== null && spread >= 0 ? 'text-good' : 'text-warn'}`}>
            {spread === null ? '—' : formatPercent(spread)}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-[10.5px] text-faint">
        <span>Liquidity {formatUsd(morpho.state.liquidityAssetsUsd)}</span>
        <span className={stale ? 'text-warn' : undefined}>State {formatAge(stateAge)}</span>
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
      const ptApy = selectedCandidate.pendle.impliedApy
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
  }, [form.equity, form.leverage, leverageMaximum, selectedCandidate])

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
  const missingLiquidityCount = uniqueMorphoCandidates.filter(
    (candidate) => candidate.morpho.state.liquidityAssetsUsd === null,
  ).length

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
    <div className="space-y-6 py-8 sm:py-10">
      <header className="relative overflow-hidden rounded-[20px] border border-hairline bg-surface px-5 py-7 sm:px-8 sm:py-9">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full opacity-20 blur-3xl"
          style={{ background: 'var(--op-accent)' }}
        />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <p className="font-mono text-[11px] uppercase tracking-[.1em] text-accent-ink">
              Morpho × Pendle research
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-fg sm:text-4xl">
              PT looping
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              Compare Morpho markets whose collateral exactly matches a live, factory-indexed
              Pendle PT. Model leverage and inspect the reviewed entry and exit path.
              {LOOPING_EXECUTION_BETA_ENABLED
                ? ` Allowlisted beta markets can open a loop from your wallet${LOOPING_EXIT_BETA_ENABLED ? ' and fully unwind it' : ''}.`
                : LOOPING_EXIT_BETA_ENABLED
                  ? ' New entries are gated, while existing allowlisted positions can still use the reviewed full-exit flow.'
                  : ' New entry and full exit remain launch-gated; bounded safety recovery remains available for prior attempts.'}
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-[10.5px] text-muted">
              <span className="rounded-full border border-hairline bg-surface-2 px-2.5 py-1">Exact PT-to-collateral join</span>
              <span className="rounded-full border border-hairline bg-surface-2 px-2.5 py-1">Calculator estimates</span>
              <span className="rounded-full border border-hairline bg-surface-2 px-2.5 py-1">Unsigned wallet-RPC simulation</span>
              <span className="rounded-full border border-hairline bg-surface-2 px-2.5 py-1">
                {LOOPING_EXECUTION_BETA_ENABLED
                  ? 'Reviewed-market entry beta'
                  : LOOPING_EXIT_BETA_ENABLED ? 'Exit-only beta' : 'Entry and exit gated'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void marketsQuery.refetch()}
            disabled={marketsQuery.isFetching}
            className="relative rounded-[10px] border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-fg transition hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
          >
            {marketsQuery.isFetching ? 'Refreshing…' : 'Refresh data'}
          </button>
        </div>
      </header>

      <aside className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3.5" aria-label="Looping risk notice">
        <p className="text-xs leading-5 text-muted">
          <span className="font-semibold text-warn">Research only.</span>{' '}
          PT APY, borrow APY, indexed liquidity, liquidation distance, and cost assumptions can all
          move before a transaction. The estimate excludes oracle-basis risk, route failure,
          liquidity cliffs, token depeg, and smart-contract loss unless you model them explicitly.
        </p>
      </aside>

      {marketsQuery.isError && marketsQuery.data !== undefined && (
        <div role="status" className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-sm text-warn">
          The latest refresh failed. Showing the last successful snapshot. {readableError(marketsQuery.error)}
        </div>
      )}

      {partialCoverage && coverage !== undefined && (
        <div role="status" className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-sm text-warn">
          <span className="font-semibold">Partial directory coverage.</span>{' '}
          {coverage.incompleteMorphoApiChainIds.length > 0
            ? `Incomplete networks: ${coverage.incompleteMorphoApiChainIds.map(chainLabel).join(', ')}. `
            : ''}
          {coverage.unsupportedChainIds.length > 0
            ? `Morpho API coverage does not include ${coverage.unsupportedChainIds.map(chainLabel).join(', ')}. `
            : ''}
          {coverage.deprecationWarningCount > 0
            ? `${coverage.deprecationWarningCount} API deprecation ${coverage.deprecationWarningCount === 1 ? 'warning was' : 'warnings were'} reported. `
            : ''}
          Displayed matches remain identity-validated, but missing markets are possible.
        </div>
      )}

      {(directoryStale || indexedStateStale) && marketsQuery.data !== undefined && (
        <div role="status" className="rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-sm text-warn">
          <span className="font-semibold">Stale research inputs.</span>{' '}
          {directoryStale && directoryAge !== null ? `Directory fetched ${formatAge(directoryAge)}. ` : ''}
          {indexedStateStale && oldestStateAge !== null ? `Oldest Morpho state is ${formatAge(oldestStateAge)}. ` : ''}
          Refresh before interpreting liquidity or risk estimates.
        </div>
      )}

      {marketsQuery.data !== undefined && candidates.length > 0 && (
        <section aria-label="Looping market summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard
            label="Exact matches"
            value={exactMatchCount.toLocaleString('en-US')}
            note={candidates.length === exactMatchCount
              ? 'Factory PT and Morpho collateral match on the same chain'
              : `${candidates.length.toLocaleString('en-US')} exact Pendle-market pairings across unique Morpho tuples`}
          />
          <SummaryCard
            label="Morpho listed"
            value={listedCount.toLocaleString('en-US')}
            note={`${exactMatchCount - listedCount} additional permissionless ${exactMatchCount - listedCount === 1 ? 'tuple' : 'tuples'} shown as unlisted`}
          />
          <SummaryCard
            label="Active networks"
            value={candidateChainCount.toLocaleString('en-US')}
            note="Networks with at least one current exact match"
          />
          <SummaryCard
            label="Reported liquidity"
            value={`$${formatCompact(reportedLiquidity)}`}
            note={missingLiquidityCount === 0
              ? 'Aggregate API-reported borrow liquidity'
              : `Excludes ${missingLiquidityCount} unavailable USD ${missingLiquidityCount === 1 ? 'value' : 'values'}`}
          />
        </section>
      )}

      {marketsQuery.data !== undefined && candidates.length > 0 && (
        <section aria-label="Market directory filters" className="rounded-xl border border-hairline bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">Filter markets</h2>
              <p className="mt-0.5 text-[10.5px] text-faint" aria-live="polite">
                {visible.length.toLocaleString('en-US')} of {candidates.length.toLocaleString('en-US')} exact matches
              </p>
            </div>
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
            Borrow liquidity is the USD value currently available to borrow on Morpho, not market TVL. Markets with unavailable USD pricing are excluded when the minimum is above zero.
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
            but none currently join to a live, unexpired, factory-indexed Pendle PT on the same
            network. This is a valid empty result, not evidence that looping is impossible elsewhere.
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
              {marketsQuery.data.morphoMarketCount.toLocaleString('en-US')} Morpho markets inspected · {marketsQuery.data.coverage.requestedPtCount.toLocaleString('en-US')} unique PTs requested · source data only, never transaction routing
            </footer>
          </section>

          {selectedCandidate === undefined ? (
            <section className="rounded-xl border border-hairline bg-surface px-5 py-12 text-center">
              <h2 className="font-semibold text-fg">
                {selectedKey === null ? 'No market selected' : 'Selected market unavailable'}
              </h2>
              <p className="mt-2 text-sm text-muted">
                {selectedKey === null
                  ? 'Choose a market from the directory to model its leverage and estimated APY.'
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
                        className="rounded-full border border-hairline px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.06em] text-muted hover:border-hairline-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Clear selection
                      </button>
                    </div>
                  </div>

                  {!selectedMatchesFilters && (
                    <div className="mt-4 rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3.5 py-3 text-xs text-warn">
                      This market is selected but hidden by the current directory filters.
                    </div>
                  )}

                  {isExecutionEnabled(selectedCandidate) && (
                    <div className="mt-4 rounded-lg border border-[rgba(52,211,153,0.28)] bg-[var(--op-good-soft)] px-3.5 py-3 text-xs text-good">
                      <span className="font-semibold">Atomic looping enabled for this market</span>
                      <code className="mt-1 block break-all font-mono text-[10.5px] text-fg">{selectedCandidate.morpho.marketId}</code>
                    </div>
                  )}

                  {isExecutionEnabled(selectedCandidate) &&
                    selectedRiskIncreaseEligibility?.eligible === false && (
                    <div className="mt-4 rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3.5 py-3 text-xs leading-5 text-warn">
                      <span className="font-semibold">New borrowing paused.</span>{' '}
                      {selectedRiskIncreaseEligibility.message} Existing leverage reductions,
                      full exit, and permission recovery are not blocked by this liquidity gate.
                    </div>
                  )}

                  <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div className="rounded-lg bg-surface-2 p-3">
                      <dt className="text-[9px] uppercase tracking-[.06em] text-faint">PT APY</dt>
                      <dd className="mt-1 text-lg font-bold tabular-nums text-accent-ink">{selectedCandidate.pendle.impliedApy === null ? '—' : formatPercent(selectedCandidate.pendle.impliedApy)}</dd>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-3">
                      <dt className="text-[9px] uppercase tracking-[.06em] text-faint">Borrow APY</dt>
                      <dd className="mt-1 text-lg font-bold tabular-nums text-fg">{formatPercent(selectedCandidate.morpho.state.borrowApy)}</dd>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-3">
                      <dt className="text-[9px] uppercase tracking-[.06em] text-faint">Raw spread</dt>
                      <dd className={`mt-1 text-lg font-bold tabular-nums ${selectedSpread === null ? 'text-fg' : selectedSpread >= 0 ? 'text-good' : 'text-danger'}`}>
                        {selectedSpread === null ? '—' : formatPercent(selectedSpread)}
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
                  <p className="text-[10px] font-medium uppercase tracking-[.08em] text-accent-ink">Current-rate estimate</p>
                  <h2 id="risk-calculator-title" className="mt-1 text-lg font-semibold text-fg">Leverage and estimated APY</h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
                    Move the slider to see how leverage changes estimated APY. The estimate holds current PT and borrow APYs constant and excludes fees, slippage, and borrow-rate impact.
                  </p>
                </div>

                <LoopingExecutionProvider
                  candidate={selectedCandidate}
                  equityAssets={calculator !== null && calculator.ok ? calculator.equityAssets : 0n}
                  leverage={form.leverage}
                >
                <div className="mt-5 grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
                  <div>
                    <NumberField id="loop-equity" label={`Amount (${selectedCandidate.morpho.loanAsset.symbol})`} value={form.equity} onChange={(value) => setFormField('equity', value)} min={0} max={1e15} step="any" help="Sets modeled equity; executable beta preflight also checks the connected wallet balance." disabled={transactionInFlight} />
                    <div className="mt-3">
                      <LoopingExecutionAction />
                    </div>
                  </div>
                  <div className="rounded-xl border border-hairline bg-surface-2 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="loop-leverage" className="text-sm font-semibold text-fg">Leverage</label>
                      <output
                        htmlFor="loop-leverage"
                        aria-live="polite"
                        className={`text-xl font-bold tabular-nums ${beyondLeverageWarning ? 'text-danger' : 'text-accent-ink'}`}
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
                        aria-valuetext={`${Number(form.leverage).toFixed(2)} times leverage${beyondLeverageWarning ? ', below the 10% liquidation buffer' : ''}`}
                        className="block h-2 w-full cursor-pointer accent-[var(--op-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <span
                        aria-hidden
                        className="pointer-events-none absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-danger shadow-[0_0_0_2px_var(--op-surface-2)]"
                        style={{ left: `${leverageWarningPosition}%` }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10.5px] text-faint">
                      <span>1× · no borrowing</span>
                      <span>{leverageMaximum.toFixed(2)}× · 1% liquidation buffer</span>
                    </div>
                    <div id="loop-leverage-help" className="mt-3 flex items-start gap-2 text-[10.5px] leading-4 text-muted">
                      <span aria-hidden className="mt-0.5 h-3 w-0.5 shrink-0 rounded-full bg-danger" />
                      <p>
                        Red mark: {leverageWarningThreshold.toFixed(2)}× keeps a 10% simplified liquidation buffer. The slider can continue to the market-specific 1% boundary; values beyond the mark are high risk and neither value is a guarantee.
                      </p>
                    </div>
                    {beyondLeverageWarning && (
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
                      <EstimateCard label="Estimated loop APY" value={formatPercent(calculator.scenario.headlineLoopApy)} note={`${formatPercent(calculator.input.ptApy)} at 1×; each additional 1× changes APY by ${selectedSpread === null ? '—' : formatPercent(selectedSpread)}.`} tone={calculator.scenario.headlineLoopApy >= 0 ? 'good' : 'warn'} />
                      <EstimateCard label="Estimated debt" value={formatEstimateAmount(calculator.equityNumber * calculator.scenario.debt, selectedCandidate.morpho.loanAsset.symbol)} note={`${formatEstimateAmount(calculator.equityNumber * calculator.scenario.collateralExposure, `${selectedCandidate.morpho.loanAsset.symbol} equiv.`)} gross PT exposure.`} />
                      <EstimateCard label="Current LTV" value={formatPercent(calculator.scenario.currentLtv)} note={`Morpho LLTV is ${formatPercent(calculator.scenario.lltv)}.`} />
                      <EstimateCard label="Drop to liquidation" value={calculator.scenario.priceDropToLiquidation === null ? 'No debt' : formatPercent(calculator.scenario.priceDropToLiquidation)} note="Simplified constant-debt estimate; not an oracle guarantee." tone={calculator.scenario.priceDropToLiquidation !== null && calculator.scenario.priceDropToLiquidation < 0.15 ? 'warn' : 'neutral'} />
                    </div>

                    <LoopingExecutionPanel />

                    <details className="mt-5 rounded-xl border border-hairline bg-surface-2 p-4">
                      <summary className="cursor-pointer text-sm font-semibold text-fg">Advanced stress assumptions</summary>
                      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
                          <p className="max-w-2xl text-[10.5px] leading-4 text-muted">
                            Optional stress and cost inputs affect only the result below, not the primary current-rate APY, the 10% marker, or the slider's 1% maximum.
                          </p>
                        <button type="button" disabled={transactionInFlight} onClick={resetAdvancedAssumptions} className="text-xs font-medium text-accent-ink hover:underline disabled:cursor-not-allowed disabled:opacity-60">Reset stress assumptions</button>
                      </div>
                      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <NumberField id="loop-holding" label="Holding period" value={form.holdingMonths} onChange={(value) => setFormField('holdingMonths', value)} suffix="mo" min={0.25} max={120} step="0.25" help={`Must end by ${formatDate(selectedCandidate.pendle.expiry)}; used only to annualize modeled one-time costs.`} disabled={transactionInFlight} />
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
                            <p className="mt-1 text-[10.5px] text-muted">
                              Stressed LTV {formatPercent(advancedCalculator.scenario.stressedLtv)} versus {formatPercent(advancedCalculator.scenario.conservativeLltv)} buffered limit; custom-stress maximum {advancedCalculator.scenario.conservativeMaxLeverage.toFixed(2)}×; includes {formatPercent(advancedCalculator.scenario.annualizedOneTimeCosts)} annualized modeled costs.
                            </p>
                          </div>
                        </div>
                      )}
                    </details>
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
