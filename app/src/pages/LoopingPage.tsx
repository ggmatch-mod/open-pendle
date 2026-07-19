import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { useLoopingMarkets } from '../components/useLoopingMarkets'
import {
  clampLabel,
  formatCompact,
  formatDate,
  formatPercent,
  shortAddress,
} from '../components/format'
import { isSupportedChainId, SUPPORTED_CHAINS, supportedChain } from '../lib/addresses'
import {
  calculateLoopingScenario,
  type LoopingMarketCandidate,
  type LoopingScenario,
  type LoopingScenarioInput,
} from '../lib/looping'
import {
  buildLoopingTransactionPreview,
  type LoopingSafetyGateStatus,
  type LoopingTransactionPreview,
} from '../lib/loopingPreview'
import type { SupportedChainId } from '../lib/types'

const ARBITRUM_CANARY_MARKET_ID =
  '0x97cb4b88a7a5e8e9c039b106374124e642395437ffc0ef93f2799343ad022985'
const MARKET_STATE_STALE_AFTER_SECONDS = 60 * 60
const DIRECTORY_SNAPSHOT_STALE_AFTER_SECONDS = 15 * 60
const DIRECTORY_PAGE_SIZE = 8
const CLOCK_SKEW_TOLERANCE_SECONDS = 5 * 60
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60
const EMPTY_CANDIDATES: LoopingMarketCandidate[] = []

type ChainFilter = SupportedChainId | 'all'
type ListedFilter = 'all' | 'listed' | 'unlisted'
type BorrowableFilter = 'all' | 'borrowable' | 'dry'
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
  preview: LoopingTransactionPreview
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
  borrowApyIncrease: '2',
  ptApyHaircut: '2',
  entryCost: '0.5',
  exitCost: '0.5',
  fixedCost: '0.1',
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

function listedFromParam(value: string | null): ListedFilter {
  return value === 'all' || value === 'unlisted' ? value : 'listed'
}

function borrowableFromParam(value: string | null): BorrowableFilter {
  return value === 'all' || value === 'dry' ? value : 'borrowable'
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

function isCanary(candidate: LoopingMarketCandidate): boolean {
  return candidate.morpho.chainId === 42161 &&
    candidate.morpho.marketId.toLowerCase() === ARBITRUM_CANARY_MARKET_ID
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

function StatusPill({ status }: { status: LoopingSafetyGateStatus }) {
  const styles = status === 'pass'
    ? 'border-[rgba(52,211,153,0.28)] bg-[var(--op-good-soft)] text-good'
    : status === 'blocked'
      ? 'border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] text-danger'
      : 'border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] text-warn'
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.07em] ${styles}`}>
      {status}
    </span>
  )
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
          className={`${inputClass} ${suffix ? 'pr-12' : ''}`}
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
      {Array.from({ length: 4 }, (_, index) => (
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
}: {
  candidate: LoopingMarketCandidate
  selected: boolean
  now: number
  onSelect: () => void
}) {
  const { morpho, pendle } = candidate
  const spread = marketSpread(candidate)
  const stateAge = now - morpho.state.timestamp
  const stale = isStaleAge(stateAge, MARKET_STATE_STALE_AFTER_SECONDS)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={selected
        ? 'w-full rounded-xl border border-[rgba(var(--op-accent-rgb),0.55)] bg-[rgba(var(--op-accent-rgb),0.08)] p-4 text-left shadow-[var(--op-shadow)] outline-none ring-1 ring-[rgba(var(--op-accent-rgb),0.12)] focus-visible:ring-2 focus-visible:ring-accent'
        : 'w-full rounded-xl border border-hairline bg-surface p-4 text-left outline-none transition hover:border-hairline-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent'}
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
              Selected
            </span>
          )}
          <span className={morpho.listed
            ? 'rounded-full border border-[rgba(var(--op-accent-rgb),0.3)] bg-[rgba(var(--op-accent-rgb),0.08)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-accent-ink'
            : 'rounded-full border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-warn'}>
            {morpho.listed ? 'Morpho listed' : 'Morpho unlisted'}
          </span>
          {isCanary(candidate) && (
            <span className="rounded-full border border-[rgba(52,211,153,0.3)] bg-[var(--op-good-soft)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-good">
              Arbitrum canary
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
  useDocumentTitle('PT looping research')
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
  const listed = listedFromParam(searchParams.get('listed'))
  const borrowable = borrowableFromParam(searchParams.get('borrowable'))
  const sort = sortFromParam(searchParams.get('sort'))
  const selectedKey = searchParams.get('selected')
  const candidates = marketsQuery.data?.candidates ?? EMPTY_CANDIDATES

  const updateParam = (key: string, value: string, defaultValue: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === defaultValue || value.trim() === '') next.delete(key)
    else next.set(key, value)
    setSearchParams(next, { replace: true })
  }

  const visible = useMemo(() => {
    const needle = queryText.trim().toLowerCase()
    return candidates
      .filter((candidate) => chain === 'all' || candidate.morpho.chainId === chain)
      .filter((candidate) => {
        if (listed === 'listed') return candidate.morpho.listed
        if (listed === 'unlisted') return !candidate.morpho.listed
        return true
      })
      .filter((candidate) => {
        const hasLiquidity = candidate.morpho.state.liquidityAssets > 0n
        if (borrowable === 'borrowable') return hasLiquidity
        if (borrowable === 'dry') return !hasLiquidity
        return true
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
  }, [borrowable, candidates, chain, listed, queryText, sort])

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.key === selectedKey),
    [candidates, selectedKey],
  )
  const selectedSpread = selectedCandidate === undefined ? null : marketSpread(selectedCandidate)
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
    if (marketsQuery.data === undefined || candidates.length === 0 || selectedCandidate !== undefined) return
    const fallback = visible.find(isCanary) ??
      visible.find((candidate) => candidate.morpho.listed && candidate.morpho.state.liquidityAssets > 0n) ??
      candidates.find(isCanary) ??
      visible[0] ??
      candidates[0]
    if (fallback === undefined) return
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      next.set('selected', fallback.key)
      return next
    }, { replace: true })
  }, [candidates, marketsQuery.data, selectedCandidate, setSearchParams, visible])

  useEffect(() => {
    setVisibleLimit(DIRECTORY_PAGE_SIZE)
  }, [borrowable, chain, listed, queryText, sort])

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
        leverage: parseNumberField(form.leverage, 'Leverage', 1, 20),
        ptApy,
        borrowApy: selectedCandidate.morpho.state.borrowApy,
        lltv: selectedCandidate.morpho.tuple.lltv,
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
      const preview = buildLoopingTransactionPreview({
        candidate: selectedCandidate,
        scenario: input,
        equityAssets,
        nowUnixSeconds: now,
        maxMarketStateAgeSeconds: MARKET_STATE_STALE_AFTER_SECONDS,
      })
      return { ok: true, equityNumber, equityAssets, input, scenario, preview }
    } catch (error) {
      return { ok: false, error: readableError(error) }
    }
  }, [form, now, selectedCandidate])

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
    setForm((current) => ({ ...current, [key]: value }))
  }

  const clearFilters = () => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      next.delete('q')
      next.delete('chain')
      next.delete('listed')
      next.delete('borrowable')
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
              PT looping, modeled before execution
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              Compare Morpho markets whose collateral exactly matches a live, factory-indexed
              Pendle PT. Stress a normalized position, inspect an inert entry and exit plan, and
              see every unresolved safety gate. The Looping controls cannot quote, sign, encode,
              or submit.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-[10.5px] text-muted">
              <span className="rounded-full border border-hairline bg-surface-2 px-2.5 py-1">Exact PT-to-collateral join</span>
              <span className="rounded-full border border-hairline bg-surface-2 px-2.5 py-1">Estimates, not quotes</span>
              <span className="rounded-full border border-hairline bg-surface-2 px-2.5 py-1">Execution hard-disabled</span>
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
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 id="looping-directory-title" className="font-semibold text-fg">Market directory</h2>
                  <p className="mt-1 text-xs text-faint" aria-live="polite">
                    {visible.length.toLocaleString('en-US')} of {candidates.length.toLocaleString('en-US')} exact matches
                  </p>
                </div>
                {(queryText !== '' || chain !== 'all' || listed !== 'listed' || borrowable !== 'borrowable' || sort !== 'liquidity') && (
                  <button type="button" onClick={clearFilters} className="text-xs font-medium text-accent-ink hover:underline">
                    Clear filters
                  </button>
                )}
              </div>

              <label className="mt-4 block">
                <span className="sr-only">Search looping markets</span>
                <input
                  type="search"
                  maxLength={180}
                  value={queryText}
                  onChange={(event) => updateParam('q', event.target.value.slice(0, 180), '')}
                  placeholder="Search name, token, market ID or address…"
                  className={inputClass}
                />
              </label>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="text-[10px] font-medium uppercase tracking-[.05em] text-faint">
                  Network
                  <select value={chain} onChange={(event) => updateParam('chain', event.target.value, 'all')} className={`mt-1 ${selectClass}`}>
                    <option value="all">All networks</option>
                    {SUPPORTED_CHAINS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label className="text-[10px] font-medium uppercase tracking-[.05em] text-faint">
                  Morpho listing
                  <select value={listed} onChange={(event) => updateParam('listed', event.target.value, 'listed')} className={`mt-1 ${selectClass}`}>
                    <option value="all">All listings</option>
                    <option value="listed">Listed only</option>
                    <option value="unlisted">Unlisted only</option>
                  </select>
                </label>
                <label className="text-[10px] font-medium uppercase tracking-[.05em] text-faint">
                  Borrow liquidity
                  <select value={borrowable} onChange={(event) => updateParam('borrowable', event.target.value, 'borrowable')} className={`mt-1 ${selectClass}`}>
                    <option value="all">All liquidity</option>
                    <option value="borrowable">Borrowable only</option>
                    <option value="dry">No liquidity</option>
                  </select>
                </label>
                <label className="text-[10px] font-medium uppercase tracking-[.05em] text-faint">
                  Sort
                  <select value={sort} onChange={(event) => updateParam('sort', event.target.value, 'liquidity')} className={`mt-1 ${selectClass}`}>
                    <option value="spread">Highest raw spread</option>
                    <option value="liquidity">Most borrow liquidity</option>
                    <option value="pt-apy">Highest PT APY</option>
                    <option value="borrow-apy">Lowest borrow APY</option>
                    <option value="expiry">Soonest maturity</option>
                  </select>
                </label>
              </div>
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
                  onSelect={() => updateParam('selected', candidate.key, '')}
                />
              ))}
              {orderedVisible.length > visibleLimit && (
                <button
                  type="button"
                  onClick={() => setVisibleLimit((current) => current + DIRECTORY_PAGE_SIZE)}
                  className="w-full rounded-[10px] border border-hairline bg-surface-2 px-3 py-2.5 text-sm font-medium text-fg hover:border-hairline-strong"
                >
                  Show {Math.min(DIRECTORY_PAGE_SIZE, orderedVisible.length - visibleLimit)} more
                </button>
              )}
            </div>

            <footer className="border-t border-hairline px-4 py-3 text-[10.5px] leading-4 text-faint">
              {marketsQuery.data.morphoMarketCount.toLocaleString('en-US')} Morpho markets inspected · {marketsQuery.data.coverage.requestedPtCount.toLocaleString('en-US')} unique PTs requested · source data only, never transaction routing
            </footer>
          </section>

          {selectedCandidate === undefined ? (
            <section className="rounded-xl border border-hairline bg-surface px-5 py-12 text-center">
              <h2 className="font-semibold text-fg">Choose a market to begin</h2>
              <p className="mt-2 text-sm text-muted">The selected market is stored in the URL for a reproducible research view.</p>
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
                    <div className="flex flex-wrap gap-1.5">
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
                    </div>
                  </div>

                  {isCanary(selectedCandidate) && (
                    <div className="mt-4 rounded-lg border border-[rgba(52,211,153,0.28)] bg-[var(--op-good-soft)] px-3.5 py-3 text-xs text-good">
                      <span className="font-semibold">Arbitrum atomic canary market ID</span>
                      <code className="mt-1 block break-all font-mono text-[10.5px] text-fg">{ARBITRUM_CANARY_MARKET_ID}</code>
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
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-[.08em] text-accent-ink">Normalized stress model</p>
                    <h2 id="risk-calculator-title" className="mt-1 text-lg font-semibold text-fg">Risk calculator</h2>
                    <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">Every output is an estimate. APYs are held constant except for the explicit stress adjustments; one-time costs are annualized over the chosen holding period.</p>
                  </div>
                  <button type="button" onClick={() => setForm(DEFAULT_FORM)} className="text-xs font-medium text-accent-ink hover:underline">Reset assumptions</button>
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <NumberField id="loop-equity" label={`Equity (${selectedCandidate.morpho.loanAsset.symbol})`} value={form.equity} onChange={(value) => setFormField('equity', value)} min={0} max={1e15} step="any" help="Exact preview input amount; no balance is read." />
                  <NumberField id="loop-leverage" label="Gross PT exposure" value={form.leverage} onChange={(value) => setFormField('leverage', value)} suffix="×" min={1} max={20} step="0.05" help="1× is unlevered; debt equals leverage minus one." />
                  <NumberField id="loop-holding" label="Holding period" value={form.holdingMonths} onChange={(value) => setFormField('holdingMonths', value)} suffix="mo" min={0.25} max={120} step="0.25" help={`Must end by ${formatDate(selectedCandidate.pendle.expiry)}; used only to annualize modeled one-time costs.`} />
                  <NumberField id="loop-drop" label="Collateral price drop" value={form.collateralPriceDrop} onChange={(value) => setFormField('collateralPriceDrop', value)} suffix="%" min={0} max={99} step="0.1" help="Absolute stress to PT collateral value." />
                  <NumberField id="loop-buffer" label="LLTV safety buffer" value={form.lltvBuffer} onChange={(value) => setFormField('lltvBuffer', value)} suffix="%" min={0} max={99} step="0.1" help="Fraction of protocol LLTV deliberately left unused." />
                  <NumberField id="loop-borrow-stress" label="Borrow APY increase" value={form.borrowApyIncrease} onChange={(value) => setFormField('borrowApyIncrease', value)} suffix="pp" min={0} max={100} step="0.1" help="Percentage points added to current borrowing cost." />
                  <NumberField id="loop-pt-stress" label="PT APY haircut" value={form.ptApyHaircut} onChange={(value) => setFormField('ptApyHaircut', value)} suffix="pp" min={0} max={100} step="0.1" help="Percentage points removed from current PT APY." />
                  <NumberField id="loop-entry-cost" label="Entry cost" value={form.entryCost} onChange={(value) => setFormField('entryCost', value)} suffix="%" min={0} max={25} step="0.01" help="One-time estimate on gross PT exposure." />
                  <NumberField id="loop-exit-cost" label="Exit cost" value={form.exitCost} onChange={(value) => setFormField('exitCost', value)} suffix="%" min={0} max={25} step="0.01" help="One-time estimate on gross PT exposure." />
                  <NumberField id="loop-fixed-cost" label="Fixed cost on equity" value={form.fixedCost} onChange={(value) => setFormField('fixedCost', value)} suffix="%" min={0} max={25} step="0.01" help="Gas, relayer, and aggregator estimate." />
                </div>

                {calculator === null ? null : !calculator.ok ? (
                  <div role="alert" className="mt-5 rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-4 py-3 text-sm text-danger">
                    {calculator.error}
                  </div>
                ) : (
                  <div className="mt-6">
                    <h3 className="text-sm font-semibold text-fg">Estimated scenario</h3>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <EstimateCard label="Normalized gross exposure" value={formatEstimateAmount(calculator.equityNumber * calculator.scenario.collateralExposure, `${selectedCandidate.morpho.loanAsset.symbol} equiv.`)} note={`${calculator.scenario.collateralExposure.toFixed(2)}× initial equity in loan-token-equivalent terms; the PT amount requires a fresh route quote.`} />
                      <EstimateCard label="Debt" value={formatEstimateAmount(calculator.equityNumber * calculator.scenario.debt, selectedCandidate.morpho.loanAsset.symbol)} note="Normalized debt; not a current Morpho quote." />
                      <EstimateCard label="Headline loop APY" value={formatPercent(calculator.scenario.headlineLoopApy)} note="PT APY × exposure minus current borrow APY × debt; excludes costs." tone={calculator.scenario.headlineLoopApy >= 0 ? 'good' : 'warn'} />
                      <EstimateCard label="Stress-adjusted net APY" value={formatPercent(calculator.scenario.conservativeNetApy)} note={`Includes ${formatPercent(calculator.scenario.annualizedOneTimeCosts)} annualized modeled costs.`} tone={calculator.scenario.conservativeNetApy >= 0 ? 'good' : 'warn'} />
                      <EstimateCard label="Current / stressed LTV" value={`${formatPercent(calculator.scenario.currentLtv)} / ${formatPercent(calculator.scenario.stressedLtv)}`} note={`Protocol LLTV is ${formatPercent(calculator.scenario.lltv)}.`} tone={calculator.scenario.withinProtocolLltv ? 'neutral' : 'warn'} />
                      <EstimateCard label="Conservative health factor" value={calculator.scenario.conservativeHealthFactor === null ? 'No debt' : calculator.scenario.conservativeHealthFactor.toFixed(2)} note={`Conservative max exposure ${calculator.scenario.conservativeMaxLeverage.toFixed(2)}×.`} tone={calculator.scenario.withinConservativeLimit ? 'good' : 'warn'} />
                      <EstimateCard label="Price drop to liquidation" value={calculator.scenario.priceDropToLiquidation === null ? 'No debt' : formatPercent(calculator.scenario.priceDropToLiquidation)} note="Simplified constant-debt estimate; not an oracle guarantee." />
                    </div>
                  </div>
                )}
              </section>

              {calculator !== null && calculator.ok && (
                <section className="rounded-xl border border-hairline bg-surface p-5 sm:p-6" aria-labelledby="transaction-preview-title">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-[10px] font-medium uppercase tracking-[.08em] text-accent-ink">Inert lifecycle plan</p>
                      <h2 id="transaction-preview-title" className="mt-1 text-lg font-semibold text-fg">Entry and exit preview</h2>
                      <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">These are human-readable requirements, not calldata. Entry and exit are separate atomic transactions, each with its own authorization and revocation.</p>
                    </div>
                    <span className="rounded-full border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.07em] text-danger">execution disabled</span>
                  </div>

                  <ul className="mt-4 space-y-1.5 text-xs leading-5 text-muted">
                    {calculator.preview.summary.map((item) => <li key={item} className="flex gap-2"><span aria-hidden className="text-accent-ink">•</span><span>{item}</span></li>)}
                  </ul>

                  <div className="mt-6">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold text-fg">Safety gates</h3>
                      <span className="text-[10.5px] tabular-nums text-faint">{calculator.preview.blockers.length} blocking or unresolved</span>
                    </div>
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      {calculator.preview.safetyGates.map((gate) => (
                        <div key={gate.code} className="rounded-lg border border-hairline bg-surface-2 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-xs font-medium leading-4 text-fg">{gate.label}</p>
                            <StatusPill status={gate.status} />
                          </div>
                          <p className="mt-1.5 text-[10.5px] leading-4 text-muted">{gate.detail}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 lg:grid-cols-2">
                    {calculator.preview.transactions.map((transaction) => (
                      <article key={transaction.id} className="rounded-xl border border-hairline bg-surface-2 p-4">
                        <div className="flex items-start gap-3">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[rgba(var(--op-accent-rgb),0.13)] text-xs font-bold text-accent-ink">{transaction.order}</span>
                          <div>
                            <h3 className="text-sm font-semibold text-fg">{transaction.label}</h3>
                            <p className="mt-0.5 text-[10.5px] text-faint">{transaction.atomicity}</p>
                          </div>
                        </div>

                        <ol className="mt-4 space-y-3">
                          {transaction.steps.map((step) => (
                            <li key={step.order} className="flex gap-2.5">
                              <span className="font-mono text-[10px] text-accent-ink">{String(step.order).padStart(2, '0')}</span>
                              <div>
                                <p className="text-xs font-medium text-fg">{step.label}</p>
                                <p className="mt-0.5 text-[10.5px] leading-4 text-muted">{step.detail}</p>
                              </div>
                            </li>
                          ))}
                        </ol>

                        {transaction.approvalIntent && (
                          <div className="mt-4 rounded-lg border border-hairline bg-surface px-3 py-2.5 text-[10.5px] leading-4 text-muted">
                            <span className="font-semibold text-fg">Exact approval:</span>{' '}{transaction.approvalIntent.formattedAmount} to the verified adapter; zero afterward.
                          </div>
                        )}

                        <details className="mt-4 rounded-lg border border-hairline bg-surface px-3 py-2.5">
                          <summary className="cursor-pointer text-xs font-medium text-fg">Unresolved finite bounds ({transaction.finiteBounds.length})</summary>
                          <ul className="mt-3 space-y-3">
                            {transaction.finiteBounds.map((bound) => (
                              <li key={bound.key}>
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-[10.5px] font-medium text-fg">{bound.label}</p>
                                  <span className="rounded-full border border-[var(--op-warn-bd)] px-1.5 py-0.5 text-[8px] uppercase tracking-[.06em] text-warn">unresolved</span>
                                </div>
                                <p className="mt-1 break-words font-mono text-[9.5px] leading-4 text-muted">{bound.placeholder}</p>
                                <p className="mt-1 text-[9.5px] leading-4 text-faint">{bound.invariant}</p>
                              </li>
                            ))}
                          </ul>
                        </details>

                        <details className="mt-2 rounded-lg border border-hairline bg-surface px-3 py-2.5">
                          <summary className="cursor-pointer text-xs font-medium text-fg">Required postconditions</summary>
                          <ul className="mt-2 space-y-1.5 text-[10.5px] leading-4 text-muted">
                            {transaction.postconditions.map((item) => <li key={item} className="flex gap-2"><span aria-hidden className="text-good">✓</span><span>{item}</span></li>)}
                          </ul>
                        </details>
                      </article>
                    ))}
                  </div>

                  <div className="mt-6 rounded-xl border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-4">
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="h-11 w-full cursor-not-allowed rounded-[10px] border border-[var(--op-danger-bd)] bg-surface-2 px-4 text-sm font-semibold text-faint opacity-70"
                    >
                      Execution unavailable — research preview only
                    </button>
                    <p className="mt-2 text-center text-[10.5px] leading-4 text-muted">No wallet hook, signing path, calldata encoder, simulator, or broadcaster is attached to this control.</p>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
