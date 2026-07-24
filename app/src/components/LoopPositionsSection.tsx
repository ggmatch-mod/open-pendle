import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { supportedChain } from '../lib/addresses'
import {
  calculateLoopingLeverageCap,
  calculateLoopingScenario,
  type LoopingMarketCandidate,
} from '../lib/looping'
import { evaluateLoopingRiskIncreaseEligibility } from '../lib/loopingEligibility'
import {
  getLoopingExecutionCandidateMarket,
  LOOPING_EXECUTION_REGISTRY,
  type LoopingExecutionChainId,
  type LoopingExecutionMarket,
} from '../lib/loopingRegistry'
import {
  readLoopingPositionInventory,
  type LoopingPositionInventorySnapshot,
} from '../lib/loopingExecution'
import {
  createLoopingWalletReadClient,
  mayUseLoopingWalletReadFallback,
} from '../lib/loopingRpc'
import { useTransactionInFlight } from '../lib/hooks'
import { useLoopingMarkets } from './useLoopingMarkets'
import { LoopingExecutionPanel } from './LoopingExecutionPanel'
import { clampLabel, formatAmount, formatPercent, shortAddress } from './format'

const LOOPING_POSITION_STALE_TIME_MS = 12_000
const LOOPING_POSITION_SCAN_CONCURRENCY = 4
const POSITION_TARGET_MINIMUM = 1.01
const POSITION_TARGET_STEP = 0.01
const POSITION_SLIDER_MAX_POLICY = {
  collateralPriceDrop: 0,
  lltvBuffer: 0.01,
  step: 0.05,
  absoluteCap: 100,
} as const
const POSITION_SLIDER_WARNING_POLICY = {
  ...POSITION_SLIDER_MAX_POLICY,
  lltvBuffer: 0.1,
} as const

type AcquisitionMode = 'market' | 'mint'

const EXECUTION_CHAIN_IDS = Object.freeze(
  [...new Set(LOOPING_EXECUTION_REGISTRY.map((market) => market.chainId))]
    .sort((left, right) => left - right),
) as readonly LoopingExecutionChainId[]

if (EXECUTION_CHAIN_IDS.length === 0) {
  throw new Error('Loop positions require at least one reviewed execution market.')
}

const DEFAULT_EXECUTION_CHAIN_ID = EXECUTION_CHAIN_IDS[0]

function chainName(chainId: number): string {
  return supportedChain(chainId)?.name ?? `Chain ${chainId}`
}

function chainNetworkName(chainId: LoopingExecutionChainId): string {
  switch (chainId) {
    case 1: return 'ethereum'
    case 143: return 'monad'
    case 8_453: return 'base'
    case 42_161: return 'arbitrum'
  }
}

interface LoopPositionRow {
  market: Readonly<LoopingExecutionMarket>
  inventory?: LoopingPositionInventorySnapshot
  error?: string
}

function marketIdentity(market: Readonly<LoopingExecutionMarket>): string {
  return `${market.chainId}:${market.marketId.toLowerCase()}:${market.pendleMarket.toLowerCase()}`
}

function readableError(error: unknown): string {
  const message = error !== null && typeof error === 'object' &&
    'shortMessage' in error && typeof error.shortMessage === 'string'
    ? error.shortMessage
    : error instanceof Error
      ? error.message
      : 'Unknown RPC error.'
  return message.length > 240 ? `${message.slice(0, 239)}…` : message
}

function hasPosition(position: LoopingPositionInventorySnapshot['position']): boolean {
  return position.supplyShares > 0n || position.borrowShares > 0n || position.collateral > 0n
}

function isCleanOpenLoop(position: LoopingPositionInventorySnapshot['position']): boolean {
  return position.classification === 'open-loop' &&
    position.supplyShares === 0n &&
    position.borrowShares > 0n &&
    position.collateral > 0n
}

function fallbackCandidate(
  market: Readonly<LoopingExecutionMarket>,
): LoopingMarketCandidate {
  const loanSymbol = market.display.loanTokenSymbol
  const collateralSymbol = market.display.collateralTokenSymbol
  return {
    key: marketIdentity(market),
    morpho: {
      key: `${market.chainId}:${market.marketId}`,
      marketId: market.marketId,
      chainId: market.chainId,
      chainNetwork: chainNetworkName(market.chainId),
      listed: true,
      tuple: market.morphoMarketParams,
      loanAsset: {
        address: market.morphoMarketParams.loanToken,
        symbol: loanSymbol,
        decimals: market.loanTokenDecimals,
      },
      collateralAsset: {
        address: market.morphoMarketParams.collateralToken,
        symbol: collateralSymbol,
        decimals: market.collateralTokenDecimals,
      },
      state: {
        borrowAssets: 0n,
        borrowAssetsUsd: null,
        supplyAssets: 0n,
        supplyAssetsUsd: null,
        liquidityAssets: 0n,
        liquidityAssetsUsd: null,
        borrowApy: 0,
        utilization: 0,
        fee: 0,
        timestamp: 0,
      },
    },
    pendle: {
      chainId: market.chainId,
      market: market.pendleMarket,
      pt: market.morphoMarketParams.collateralToken,
      name: market.display.name,
      expiry: Number(market.pendleMarketExpiry),
      impliedApy: null,
      underlyingApy: null,
      pendleStatus: null,
    },
  }
}

function formatBps(value: bigint | null): string {
  if (value === null) return 'Unavailable'
  return `${(Number(value) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

function positionLeverage(inventory: LoopingPositionInventorySnapshot): number | null {
  const equity = inventory.collateralLoanValue - inventory.accruedDebtAssets
  if (inventory.collateralLoanValue <= 0n || equity <= 0n) return null
  const scaled = inventory.collateralLoanValue * 10_000n / equity
  const leverage = Number(scaled) / 10_000
  return Number.isFinite(leverage) ? leverage : null
}

function formatLeverage(inventory: LoopingPositionInventorySnapshot): string {
  const leverage = positionLeverage(inventory)
  if (leverage === null) return 'Unavailable'
  return `${leverage.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}×`
}

function positionPtLoopApy(
  inventory: LoopingPositionInventorySnapshot,
  candidate: LoopingMarketCandidate | undefined,
  market: Readonly<LoopingExecutionMarket>,
): number | null {
  const leverage = positionLeverage(inventory)
  if (leverage === null || candidate === undefined || candidate.pendle.impliedApy === null) {
    return null
  }
  try {
    return calculateLoopingScenario({
      leverage,
      ptApy: candidate.pendle.impliedApy,
      borrowApy: candidate.morpho.state.borrowApy,
      lltv: market.morphoMarketParams.lltv,
      holdingPeriodYears: 1,
    }).headlineLoopApy
  } catch {
    return null
  }
}

function findCandidate(
  market: Readonly<LoopingExecutionMarket>,
  candidates: readonly LoopingMarketCandidate[],
): LoopingMarketCandidate | undefined {
  return candidates.find((candidate) => {
    try {
      return getLoopingExecutionCandidateMarket(candidate) === market
    } catch {
      return false
    }
  })
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor
        cursor += 1
        results[index] = await task(values[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}

function loopingPath(candidate: LoopingMarketCandidate): string {
  const params = new URLSearchParams({
    chain: String(candidate.morpho.chainId),
    selected: candidate.key,
  })
  return `/looping?${params.toString()}`
}

function LoopPositionManager({
  candidate,
  market,
  inventory,
  transactionInFlight,
  onConfirmed,
}: {
  candidate: LoopingMarketCandidate
  market: Readonly<LoopingExecutionMarket>
  inventory: LoopingPositionInventorySnapshot
  transactionInFlight: boolean
  onConfirmed: () => void
}) {
  const matured = Number(market.pendleMarketExpiry) <= Math.floor(Date.now() / 1_000)
  const currentLeverage = positionLeverage(inventory)
  const marketMaximum = calculateLoopingLeverageCap(
    market.morphoMarketParams.lltv,
    POSITION_SLIDER_MAX_POLICY,
  )
  const warningThreshold = calculateLoopingLeverageCap(
    market.morphoMarketParams.lltv,
    POSITION_SLIDER_WARNING_POLICY,
  )
  const sliderMaximum = currentLeverage === null
    ? marketMaximum
    : Math.max(marketMaximum, Math.ceil(currentLeverage * 100) / 100)
  const initialTarget = currentLeverage === null
    ? POSITION_TARGET_MINIMUM
    : Math.max(POSITION_TARGET_MINIMUM, Math.min(sliderMaximum, currentLeverage))
  const [mode, setMode] = useState<'adjust' | 'full-exit'>(
    matured ? 'full-exit' : 'adjust',
  )
  const [acquisitionMode, setAcquisitionMode] = useState<AcquisitionMode>('market')
  const [target, setTarget] = useState(() => initialTarget.toFixed(2))
  const targetLeverage = Number(target)
  const targetChanged = currentLeverage !== null &&
    Number.isFinite(targetLeverage) &&
    Math.abs(targetLeverage - currentLeverage) >= POSITION_TARGET_STEP * 0.9
  const increasingRisk = currentLeverage !== null &&
    Number.isFinite(targetLeverage) &&
    targetLeverage > currentLeverage
  const beyondWarningThreshold = increasingRisk &&
    targetLeverage > warningThreshold + POSITION_TARGET_STEP / 2
  const riskIncreaseEligibility = evaluateLoopingRiskIncreaseEligibility(candidate)
  const liquidityIncreaseBlocked = increasingRisk && !riskIncreaseEligibility.eligible
  const adjustmentAvailable = currentLeverage !== null &&
    targetChanged &&
    targetLeverage >= POSITION_TARGET_MINIMUM &&
    targetLeverage <= sliderMaximum &&
    !liquidityIncreaseBlocked
  const markerPosition = (value: number): number => sliderMaximum <= POSITION_TARGET_MINIMUM
    ? 0
    : Math.max(0, Math.min(100,
        (value - POSITION_TARGET_MINIMUM) /
          (sliderMaximum - POSITION_TARGET_MINIMUM) * 100,
      ))

  useEffect(() => {
    setTarget(initialTarget.toFixed(2))
  }, [initialTarget])

  useEffect(() => {
    if (matured) setMode('full-exit')
  }, [matured])

  if (matured) {
    return (
      <div className="mt-3">
        <div className="rounded-lg border border-[var(--op-good-bd)] bg-[var(--op-good-soft)] px-3 py-3 text-xs leading-5 text-good">
          <span className="font-semibold">PT matured — full exit only.</span>{' '}
          Exit redeems the PT, repays the debt, and returns the rest to your wallet.
        </div>
        <LoopingExecutionPanel
          candidate={candidate}
          equityAssets={0n}
          leverage="1"
          intent="full-exit"
          acquisitionMode="market"
          onConfirmed={onConfirmed}
        />
      </div>
    )
  }

  return (
    <div className="mt-3">
      <div className="flex gap-1 rounded-[10px] border border-hairline bg-surface p-1">
        <button
          type="button"
          onClick={() => setMode('adjust')}
          disabled={transactionInFlight}
          className={`flex-1 rounded-[7px] px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${mode === 'adjust'
            ? 'bg-[rgba(var(--op-accent-rgb),0.12)] text-accent-ink'
            : 'text-muted hover:text-fg'}`}
        >
          Adjust leverage
        </button>
        <button
          type="button"
          onClick={() => setMode('full-exit')}
          disabled={transactionInFlight}
          className={`flex-1 rounded-[7px] px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${mode === 'full-exit'
            ? 'bg-[var(--op-warn-soft)] text-warn'
            : 'text-muted hover:text-fg'}`}
        >
          Full exit
        </button>
      </div>

      {mode === 'adjust' ? (
        <div className="mt-3">
          {currentLeverage === null ? (
            <p className="rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs leading-5 text-warn">
              Current leverage cannot be calculated safely. Full exit remains available.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-muted">
                  Current <span className="font-semibold tabular-nums text-fg">{currentLeverage.toFixed(2)}×</span>
                  {' → '}Target
                </p>
                <output
                  htmlFor={`position-leverage-${market.marketId}`}
                  className={`text-lg font-bold tabular-nums ${beyondWarningThreshold ? 'text-danger' : 'text-accent-ink'}`}
                >
                  {targetLeverage.toFixed(2)}×
                </output>
              </div>
              <div className="relative mt-3">
                <input
                  id={`position-leverage-${market.marketId}`}
                  type="range"
                  min={POSITION_TARGET_MINIMUM}
                  max={sliderMaximum}
                  step={POSITION_TARGET_STEP}
                  value={target}
                  disabled={transactionInFlight}
                  onChange={(event) => setTarget(event.target.value)}
                  aria-valuetext={`${targetLeverage.toFixed(2)} times target leverage`}
                  className="block h-2 w-full cursor-pointer accent-[var(--op-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-faint shadow-[0_0_0_2px_var(--op-surface)]"
                  style={{ left: `${markerPosition(currentLeverage)}%` }}
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-danger shadow-[0_0_0_2px_var(--op-surface)]"
                  style={{ left: `${markerPosition(warningThreshold)}%` }}
                />
              </div>
              <div className="mt-2 flex items-start justify-between gap-3 text-[10px] leading-4 text-faint">
                <span>{POSITION_TARGET_MINIMUM.toFixed(2)}× · partial loop</span>
                <span className="text-right">
                  {sliderMaximum.toFixed(2)}× · {sliderMaximum > marketMaximum
                    ? 'current position'
                    : '1% model boundary'}
                </span>
              </div>
              <p className="mt-2 text-[10.5px] leading-4 text-muted">
                Grey: current · red: high risk above {warningThreshold.toFixed(2)}×.
              </p>
              {beyondWarningThreshold && (
                <p role="status" className="mt-2 text-[10.5px] font-medium text-danger">
                  Increasing past the red 10% buffer mark is allowed after an explicit liquidation-risk confirmation.
                </p>
              )}
              {liquidityIncreaseBlocked &&
                !riskIncreaseEligibility.eligible && (
                <p role="status" className="mt-2 text-[10.5px] font-medium text-warn">
                  {riskIncreaseEligibility.message} Choose a lower target to reduce risk, or
                  refresh the market data.
                </p>
              )}
            </>
          )}

          {currentLeverage !== null && targetChanged && increasingRisk && (
            <div className="mt-3 rounded-[10px] border border-hairline bg-surface p-1.5">
              <div
                className="grid grid-cols-2 gap-1"
                role="group"
                aria-label="Added collateral acquisition mode"
              >
                {(['market', 'mint'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    disabled={transactionInFlight}
                    aria-pressed={acquisitionMode === option}
                    onClick={() => {
                      if (!transactionInFlight) setAcquisitionMode(option)
                    }}
                    className={`rounded-[7px] px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${acquisitionMode === option
                      ? 'bg-[rgba(var(--op-accent-rgb),0.12)] text-accent-ink'
                      : 'text-muted hover:text-fg'}`}
                  >
                    {option === 'market' ? 'Market Mode' : 'Mint Mode'}
                  </button>
                ))}
              </div>
              <p className="px-2 pb-1 pt-2 text-[10.5px] leading-4 text-muted">
                {acquisitionMode === 'mint'
                  ? 'Borrowed capital mints PT+YT. Added PT becomes Morpho collateral; YT goes to your wallet.'
                  : 'Borrowed capital buys added PT on the market for Morpho collateral.'}
              </p>
            </div>
          )}

          {adjustmentAvailable ? (
            <LoopingExecutionPanel
              candidate={candidate}
              equityAssets={0n}
              leverage={target}
              intent="adjust"
              acquisitionMode={increasingRisk ? acquisitionMode : 'market'}
              onConfirmed={onConfirmed}
            />
          ) : (
            <button
              type="button"
              disabled
              className="mt-3 h-11 w-full cursor-not-allowed rounded-[10px] border border-hairline bg-surface px-4 text-sm font-semibold text-faint"
            >
              {liquidityIncreaseBlocked
                  ? 'Not enough borrow liquidity (min $100)'
                : currentLeverage === null
                  ? 'Adjustment unavailable'
                  : 'Choose a different target'}
            </button>
          )}
        </div>
      ) : (
        <LoopingExecutionPanel
          candidate={candidate}
          equityAssets={0n}
          leverage="1"
          intent="full-exit"
          acquisitionMode="market"
          onConfirmed={onConfirmed}
        />
      )}
    </div>
  )
}

function LoopPositionCard({
  row,
  candidate,
  directoryCandidate,
  directoryDataAvailable,
  expanded,
  transactionInFlight,
  onToggle,
  onConfirmed,
}: {
  row: LoopPositionRow
  candidate: LoopingMarketCandidate
  directoryCandidate?: LoopingMarketCandidate
  directoryDataAvailable: boolean
  expanded: boolean
  transactionInFlight: boolean
  onToggle: () => void
  onConfirmed: () => void
}) {
  const { market, inventory, error } = row
  const label = directoryCandidate?.pendle.name ?? candidate.pendle.name

  if (error !== undefined) {
    return (
      <article className="rounded-[12px] border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-fg">{clampLabel(label, 52)}</p>
            <p className="mt-1 font-mono text-[10px] text-faint" title={market.marketId}>
              {shortAddress(market.marketId)} · {chainName(market.chainId)}
            </p>
          </div>
          <span className="rounded-full border border-[var(--op-danger-bd)] px-2 py-1 text-[9px] font-semibold uppercase tracking-[.06em] text-danger">
            read failed
          </span>
        </div>
        <p className="mt-3 text-xs leading-5 text-danger">{error}</p>
      </article>
    )
  }

  if (inventory === undefined) return null
  const { position } = inventory
  const cleanOpenLoop = isCleanOpenLoop(position)
  const canManage = cleanOpenLoop
  const matured = Number(market.pendleMarketExpiry) <= Math.floor(Date.now() / 1_000)
  const collateralSymbol = candidate.morpho.collateralAsset.symbol
  const debtSymbol = candidate.morpho.loanAsset.symbol
  const estimatedPtLoopApy = matured
    ? null
    : positionPtLoopApy(inventory, directoryCandidate, market)

  return (
    <article className="rounded-[12px] border border-hairline bg-bg-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 text-sm font-semibold text-fg">{clampLabel(label, 52)}</p>
            <span className="rounded-full border border-[var(--op-good-bd)] bg-[var(--op-good-soft)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-good">
              {chainName(market.chainId)}
            </span>
            {matured && (
              <span className="rounded-full border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-warn">
                PT matured
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted">
            {debtSymbol === undefined ? 'Morpho debt position' : `${clampLabel(debtSymbol, 14)} debt`} ·{' '}
            <span className="font-mono text-faint" title={market.marketId}>{shortAddress(market.marketId)}</span>
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {directoryCandidate !== undefined && (
              <Link
                to={loopingPath(directoryCandidate)}
                className="text-xs font-medium text-muted no-underline hover:text-fg"
              >
                Open market ↗
              </Link>
            )}
            <button
              type="button"
              onClick={onToggle}
              disabled={transactionInFlight}
              className="rounded-[9px] border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.08)] px-3 py-2 text-xs font-semibold text-accent-ink hover:bg-[rgba(var(--op-accent-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {expanded ? 'Close manager' : 'Manage'}
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <span className="rounded-[8px] border border-hairline bg-surface px-2.5 py-1.5 text-xs tabular-nums text-fg">
          {formatAmount(position.collateral, market.collateralTokenDecimals)}{' '}
          {clampLabel(collateralSymbol, 18)}
        </span>
        <span className="rounded-[8px] border border-hairline bg-surface px-2.5 py-1.5 text-xs tabular-nums text-fg">
          {formatAmount(inventory.accruedDebtAssets, market.loanTokenDecimals)}{' '}
          {clampLabel(debtSymbol, 14)} debt
        </span>
        <span className="rounded-[8px] border border-hairline bg-surface px-2.5 py-1.5 text-xs tabular-nums text-fg">
          LTV {formatBps(inventory.ltvBps)}
        </span>
        <span className="rounded-[8px] border border-hairline bg-surface px-2.5 py-1.5 text-xs tabular-nums text-fg">
          Leverage {formatLeverage(inventory)}
        </span>
        <span
          title="Rate-only estimate from current PT implied APY, Morpho borrow APY, and live position leverage. Excludes separately held YT, rewards, fees, slippage, and gas."
          className="rounded-[8px] border border-hairline bg-surface px-2.5 py-1.5 text-xs tabular-nums text-fg"
        >
          Estimated PT loop APY {estimatedPtLoopApy === null
            ? 'Unavailable'
            : formatPercent(estimatedPtLoopApy)}
        </span>
        <span
          title="Oracle-based collateral-price drop to Morpho liquidation at constant debt; not a guarantee."
          className="rounded-[8px] border border-hairline bg-surface px-2.5 py-1.5 text-xs tabular-nums text-fg"
        >
          Drop to liquidation {formatBps(inventory.liquidationBufferBps)}
        </span>
      </div>

      {!cleanOpenLoop && (
        <p className="mt-3 rounded-lg border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-xs leading-5 text-warn">
          This position's shape isn't supported for automatic exit — manage it directly on Morpho.
        </p>
      )}
      {cleanOpenLoop && !directoryDataAvailable && (
        <p className="mt-3 rounded-lg border border-hairline bg-surface px-3 py-2 text-xs leading-5 text-muted">
          Live market data is unavailable. You can still manage this position — everything is rechecked before any transaction.
        </p>
      )}

      {canManage && expanded && (
        <div className="mt-4 border-t border-hairline pt-1">
          <LoopPositionManager
            candidate={directoryCandidate ?? candidate}
            market={market}
            inventory={inventory}
            transactionInFlight={transactionInFlight}
            onConfirmed={onConfirmed}
          />
        </div>
      )}
    </article>
  )
}

export function LoopPositionsSection() {
  const { address: owner, chainId: walletChainId } = useAccount()
  const [selectedChainId, setSelectedChainId] = useState<LoopingExecutionChainId>(
    () => EXECUTION_CHAIN_IDS.includes(walletChainId as LoopingExecutionChainId)
      ? walletChainId as LoopingExecutionChainId
      : DEFAULT_EXECUTION_CHAIN_ID,
  )
  const { data: walletClient } = useWalletClient({
    chainId: selectedChainId,
  })
  const client = useMemo(
    () => walletClient === undefined || walletChainId !== selectedChainId
      ? undefined
      : createLoopingWalletReadClient(walletClient) as PublicClient,
    [selectedChainId, walletChainId, walletClient],
  )
  const { switchChain } = useSwitchChain()
  const marketsQuery = useLoopingMarkets()
  const transactionInFlight = useTransactionInFlight()
  const [expandedMarket, setExpandedMarket] = useState<string | null>(null)
  const selectedMarkets = useMemo(
    () => LOOPING_EXECUTION_REGISTRY.filter(
      (market) => market.chainId === selectedChainId,
    ),
    [selectedChainId],
  )
  const registryFingerprint = selectedMarkets
    .map((market) => marketIdentity(market))
    .sort()
    .join(',')

  useEffect(() => {
    if (EXECUTION_CHAIN_IDS.includes(walletChainId as LoopingExecutionChainId)) {
      setSelectedChainId(walletChainId as LoopingExecutionChainId)
    }
  }, [walletChainId])

  useEffect(() => {
    setExpandedMarket(null)
  }, [selectedChainId])

  const query = useQuery({
    queryKey: [
      'looping-positions',
      selectedChainId,
      owner?.toLowerCase() ?? null,
      registryFingerprint,
    ],
    enabled: owner !== undefined &&
      walletChainId === selectedChainId &&
      client !== undefined,
    queryFn: async (): Promise<LoopPositionRow[]> => mapWithConcurrency(
      selectedMarkets,
      LOOPING_POSITION_SCAN_CONCURRENCY,
      async (market): Promise<LoopPositionRow> => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const inventory = await readLoopingPositionInventory({
              client: client!,
              owner: owner as Address,
              market,
            })
            return { market, inventory }
          } catch (error) {
            if (attempt === 0 && mayUseLoopingWalletReadFallback(error)) continue
            return { market, error: readableError(error) }
          }
        }
        return { market, error: 'The wallet RPC read could not be completed.' }
      },
    ),
    staleTime: LOOPING_POSITION_STALE_TIME_MS,
    retry: 0,
  })

  const candidates = marketsQuery.data?.candidates ?? []
  const visibleRows = useMemo(
    () => (query.data ?? []).filter((row) =>
      row.error !== undefined ||
        (row.inventory !== undefined && hasPosition(row.inventory.position)),
    ),
    [query.data],
  )

  if (owner === undefined) return null

  return (
    <section className="rounded-xl border border-hairline bg-surface p-5" aria-labelledby="loop-positions-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="loop-positions-title" className="text-base font-semibold text-fg">Loop positions</h2>
            <span className="rounded-full border border-hairline bg-surface-2 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-muted">
              {chainName(selectedChainId)}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
            Your loop positions, read directly from chain.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {EXECUTION_CHAIN_IDS.map((chainId) => (
            <button
              key={chainId}
              type="button"
              onClick={() => setSelectedChainId(chainId)}
              disabled={transactionInFlight}
              aria-pressed={selectedChainId === chainId}
              className={`rounded-[9px] border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${selectedChainId === chainId
                ? 'border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.08)] text-accent-ink'
                : 'border-hairline bg-surface text-muted hover:border-hairline-strong hover:text-fg'}`}
            >
              {chainName(chainId)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              void Promise.allSettled([
                query.refetch(),
                marketsQuery.refetch(),
              ])
            }}
            disabled={
              query.isFetching ||
              marketsQuery.isFetching ||
              walletChainId !== selectedChainId ||
              client === undefined ||
              transactionInFlight
            }
            className="rounded-[9px] border border-hairline bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:border-hairline-strong hover:text-fg disabled:cursor-wait disabled:opacity-50"
          >
            {query.isFetching || marketsQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {walletChainId !== selectedChainId ? (
        <div className="mt-4 rounded-lg border border-hairline bg-bg-2 px-3 py-3">
          <p className="text-xs leading-5 text-muted">
            Switch your wallet to {chainName(selectedChainId)} to load and manage loop positions through your wallet&apos;s RPC.
          </p>
          <button
            type="button"
            onClick={() => switchChain({ chainId: selectedChainId })}
            disabled={transactionInFlight}
            className="mt-2 rounded-[9px] border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.08)] px-3 py-2 text-xs font-semibold text-accent-ink hover:bg-[rgba(var(--op-accent-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Switch to {chainName(selectedChainId)}
          </button>
        </div>
      ) : client === undefined ? (
        <p className="mt-4 rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-3 py-2 text-xs text-danger">
          Your wallet&apos;s {chainName(selectedChainId)} RPC is unavailable. No loop position could be checked.
        </p>
      ) : query.isPending ? (
        <div className="mt-4 space-y-2" aria-busy="true" aria-label="Loading loop positions">
          <div className="h-24 animate-pulse rounded-[12px] bg-surface-2" />
        </div>
      ) : query.isError ? (
        <p className="mt-4 rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-3 py-2 text-xs text-danger">
          Couldn&apos;t scan reviewed {chainName(selectedChainId)} loop markets. Retry the on-chain read.
        </p>
      ) : visibleRows.length === 0 ? (
        <p className="mt-4 rounded-lg border border-hairline bg-bg-2 px-3 py-3 text-xs text-muted">
          No position found in the currently reviewed {chainName(selectedChainId)} loop markets.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {visibleRows.map((row) => {
            const identity = marketIdentity(row.market)
            const directoryCandidate = findCandidate(row.market, candidates)
            const candidate = fallbackCandidate(row.market)
            return (
              <LoopPositionCard
                key={identity}
                row={row}
                candidate={candidate}
                directoryCandidate={directoryCandidate}
                directoryDataAvailable={directoryCandidate !== undefined}
                expanded={expandedMarket === identity}
                transactionInFlight={transactionInFlight}
                onToggle={() => setExpandedMarket((current) => current === identity ? null : identity)}
                onConfirmed={() => void query.refetch()}
              />
            )
          })}
        </div>
      )}
    </section>
  )
}
