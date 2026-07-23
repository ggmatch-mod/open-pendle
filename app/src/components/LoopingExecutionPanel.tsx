import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import type { LoopingMarketCandidate } from '../lib/looping'
import type { LoopingAcquisitionMode } from '../lib/loopingExecution'
import { supportedChain } from '../lib/addresses'
import { explorerTxUrl, shortAddress } from './format'
import {
  requiresLoopingHighRiskConfirmation,
  useLoopingExecution,
  type LoopingExecutionPhase,
  type UseLoopingExecutionResult,
} from './useLoopingExecution'

function formatTokenAmount(value: bigint, decimals: number, symbol: string): string {
  const formatted = formatUnits(value, decimals)
  const numeric = Number(formatted)
  if (!Number.isFinite(numeric)) return `${formatted} ${symbol}`
  return `${numeric.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${symbol}`
}

function formatBps(value: bigint | number): string {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  return `${(numeric / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

function formatLeverageWad(value: bigint): string {
  const scaled = value / 100_000_000_000_000n
  return (Number(scaled) / 10_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function Detail({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface p-3">
      <p className="text-[9px] uppercase tracking-[.06em] text-faint">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold tabular-nums text-fg">{value}</p>
      {note && <p className="mt-1 text-[10px] leading-4 text-muted">{note}</p>}
    </div>
  )
}

const ACTIVE_STEP_LABELS: Partial<Record<LoopingExecutionPhase, string>> = {
  checking: 'Checking the live position, contracts, and route',
  'clearing-allowance': 'Clearing the old token allowance',
  approving: 'Setting the exact token allowance',
  simulating: 'Simulating the transaction',
  'signing-authorize': 'Sign 1 of 2 · temporary Morpho authorization',
  'signing-revoke': 'Sign 2 of 2 · mandatory Morpho revocation',
  revalidating: 'Rechecking before submitting',
  submitting: 'Confirm in your wallet',
  pending: 'Waiting for the transaction receipt',
  verifying: 'Verifying position, allowance, and permissions',
  recovering: 'Securing the exposed Morpho authorization',
}

export interface LoopingExecutionInputs {
  candidate: LoopingMarketCandidate
  equityAssets: bigint
  leverage: string
  intent?: 'auto' | 'adjust' | 'full-exit'
  acquisitionMode?: LoopingAcquisitionMode
}

interface LoopingExecutionContextValue
  extends Omit<LoopingExecutionInputs, 'acquisitionMode'> {
  acquisitionMode: LoopingAcquisitionMode
  execution: UseLoopingExecutionResult
}

const LoopingExecutionContext = createContext<LoopingExecutionContextValue | null>(null)

function useRequiredLoopingExecution(): LoopingExecutionContextValue {
  const value = useContext(LoopingExecutionContext)
  if (value === null) {
    throw new Error('Looping execution UI must be rendered inside LoopingExecutionProvider.')
  }
  return value
}

export function LoopingExecutionProvider({
  candidate,
  equityAssets,
  leverage,
  intent = 'auto',
  acquisitionMode = 'market',
  children,
}: LoopingExecutionInputs & { children: ReactNode }) {
  const execution = useLoopingExecution({
    candidate,
    equityAssets,
    leverage,
    intent,
    acquisitionMode,
  })
  const value = useMemo<LoopingExecutionContextValue>(() => ({
    candidate,
    equityAssets,
    leverage,
    intent,
    acquisitionMode,
    execution,
  }), [acquisitionMode, candidate, equityAssets, execution, intent, leverage])
  return (
    <LoopingExecutionContext.Provider value={value}>
      {children}
    </LoopingExecutionContext.Provider>
  )
}

function LoopingExecutionActionView({
  execution,
  compactNote = true,
}: {
  execution: UseLoopingExecutionResult
  compactNote?: boolean
}) {
  const preview = execution.preview
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [highRiskAccepted, setHighRiskAccepted] = useState(false)
  const riskIncreasingPreview = preview?.kind === 'entry-preview' ||
    preview?.kind === 'increase-preview'
  const highRiskConfirmationRequired = preview !== undefined &&
    requiresLoopingHighRiskConfirmation(preview)
  const previewLiquidationBufferBps = preview?.kind === 'entry-preview'
    ? preview.health.liquidationBufferBps
    : preview?.kind === 'increase-preview'
      ? preview.conservativePost.liquidationBufferBps
      : undefined
  const activeStep = ACTIVE_STEP_LABELS[execution.phase]
  const quoteExpired = preview !== undefined &&
    Math.max(nowMs, Date.now()) >= preview.validUntilMs
  const executionChainName = execution.market === undefined
    ? 'selected chain'
    : supportedChain(execution.market.chainId)?.name ?? `Chain ${execution.market.chainId}`

  useEffect(() => {
    setHighRiskAccepted(false)
  }, [preview])

  useEffect(() => {
    if (preview === undefined) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [preview])
  const buttonClass = 'h-11 w-full rounded-[10px] px-4 text-sm font-semibold transition'
  const enabledClass = `${buttonClass} bg-accent text-white hover:brightness-110`
  const warningClass = `${buttonClass} bg-warn text-white hover:brightness-105`
  const disabledClass = `${buttonClass} cursor-not-allowed border border-hairline bg-surface text-faint`

  let action: ReactNode
  if (!execution.supported || execution.market === undefined) {
    action = <button type="button" disabled className={disabledClass}>Loop unavailable for this market</button>
  } else if (execution.phase === 'needs-wallet') {
    action = <button type="button" onClick={execution.connectWallet} className={enabledClass}>Connect wallet</button>
  } else if (execution.phase === 'wrong-network') {
    action = <button type="button" onClick={execution.switchToMarketChain} className={warningClass}>Switch wallet to {executionChainName}</button>
  } else if (execution.phase === 'ambiguous') {
    const cleanupOnly = execution.pendingRecord?.operation === 'allowance-cleanup'
    const metadataOnly = execution.pendingRecord?.operation === 'metadata-cleanup'
    const submittedTransaction = execution.pendingRecord?.txHash !== undefined ||
      execution.txHash !== undefined
    action = (
      <button
        type="button"
        onClick={() => void execution.recover()}
        disabled={!execution.canRecover}
        className={execution.canRecover ? warningClass : disabledClass}
      >
        {execution.canRecover
          ? metadataOnly
            ? 'Clear browser recovery state'
            : cleanupOnly
              ? 'Clear adapter allowance'
              : submittedTransaction
                ? 'Recheck completed transaction'
                : 'Secure Morpho permissions'
          : 'Pending operation needs review'}
      </button>
    )
  } else if (execution.busy) {
    action = <button type="button" disabled className={disabledClass}>{activeStep ?? 'Working…'}</button>
  } else if (preview !== undefined && execution.phase === 'ready') {
    const label = preview.kind === 'entry-preview'
      ? preview.acquisitionMode === 'mint'
        ? 'Start Mint Mode loop'
        : 'Start loop'
      : preview.kind === 'increase-preview'
        ? preview.acquisitionMode === 'mint'
          ? 'Increase with Mint Mode'
          : 'Increase leverage'
        : preview.kind === 'decrease-preview'
          ? 'Decrease leverage'
          : 'Exit full loop'
    const operationEnabled = riskIncreasingPreview
      ? execution.entryEnabled
      : execution.exitEnabled
    const canExecuteNow = execution.canExecute &&
      !quoteExpired &&
      (!highRiskConfirmationRequired || highRiskAccepted)
    action = (
      <button
        type="button"
        onClick={() => void execution.execute({
          highLiquidationRiskAccepted: highRiskAccepted,
        })}
        disabled={!canExecuteNow}
        className={canExecuteNow ? enabledClass : disabledClass}
      >
        {!operationEnabled
          ? `${label} · ${riskIncreasingPreview ? 'risk increase' : 'risk reduction'} disabled`
          : quoteExpired
            ? 'Quote expired · refresh first'
            : highRiskConfirmationRequired && !highRiskAccepted
              ? 'Confirm liquidation risk to continue'
              : label}
      </button>
    )
  } else {
    action = (
      <button
        type="button"
        onClick={() => void execution.prepare()}
        disabled={!execution.canPrepare}
        className={execution.canPrepare ? enabledClass : disabledClass}
      >
        {execution.phase === 'confirmed'
          ? 'Refresh live position'
          : execution.phase === 'error' || execution.phase === 'blocked'
            ? 'Retry safety check'
            : execution.intent === 'adjust'
              ? 'Preview adjustment'
              : execution.intent === 'full-exit'
                ? 'Preview full exit'
                : 'Check live position & quote'}
      </button>
    )
  }

  return (
    <div>
      {highRiskConfirmationRequired && execution.phase === 'ready' && (
        <label className="mb-2.5 flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-3 py-2.5 text-[10.5px] leading-4 text-danger">
          <input
            type="checkbox"
            aria-label="Accept elevated liquidation risk"
            checked={highRiskAccepted}
            onChange={(event) => setHighRiskAccepted(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--op-danger)]"
          />
          <span>
            <span className="font-semibold">Accept high liquidation risk.</span>{' '}
            This preview leaves an estimated {previewLiquidationBufferBps === undefined
              ? 'sub-10%'
              : formatBps(previewLiquidationBufferBps)} buffer, inside the red 10% warning zone.
            A small move may liquidate the position.
          </span>
        </label>
      )}
      {action}
      {compactNote && riskIncreasingPreview && (
        <p className={`mt-1.5 text-center text-[9.5px] leading-4 ${highRiskConfirmationRequired
          ? 'text-danger'
          : 'text-muted'}`}>
          {highRiskConfirmationRequired
            ? 'Execution is allowed only after explicit confirmation. A 1% preflight floor still applies.'
            : '10% is the warning marker; 1% remains the absolute preflight floor.'}
        </p>
      )}
    </div>
  )
}

export function LoopingExecutionAction() {
  const { execution } = useRequiredLoopingExecution()
  return <LoopingExecutionActionView execution={execution} />
}

function LoopingExecutionDetails({
  acquisitionMode,
  candidate,
  execution,
  showAction,
}: {
  acquisitionMode: LoopingAcquisitionMode
  candidate: LoopingMarketCandidate
  execution: UseLoopingExecutionResult
  showAction: boolean
}) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const loanDecimals = candidate.morpho.loanAsset.decimals
  const loanSymbol = candidate.morpho.loanAsset.symbol

  useEffect(() => {
    if (!execution.preview) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [execution.preview])

  if (!execution.supported || execution.market === undefined) {
    return (
      <div className="mt-5 rounded-xl border border-hairline bg-surface-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-fg">Calculator only</p>
            <p className="mt-1 max-w-2xl text-[10.5px] leading-4 text-muted">
              {acquisitionMode === 'mint'
                ? "Mint Mode execution isn't enabled for this market yet."
                : "Execution isn't enabled for this market yet."}
            </p>
          </div>
        </div>
        {showAction && (
          <div className="mt-3">
            <LoopingExecutionActionView execution={execution} compactNote={false} />
          </div>
        )}
      </div>
    )
  }

  const { market, preview } = execution
  const executionChainName = supportedChain(market.chainId)?.name ?? `Chain ${market.chainId}`
  const entryPreview = preview?.kind === 'entry-preview' ? preview : undefined
  const exitPreview = preview?.kind === 'exit-preview' ? preview : undefined
  const increasePreview = preview?.kind === 'increase-preview' ? preview : undefined
  const decreasePreview = preview?.kind === 'decrease-preview' ? preview : undefined
  const riskReducingPreview = exitPreview ?? decreasePreview
  const displayedAcquisitionMode = entryPreview?.acquisitionMode ??
    increasePreview?.acquisitionMode ??
    (riskReducingPreview === undefined ? acquisitionMode : null)
  const quoteSecondsRemaining = preview === undefined
    ? undefined
    : Math.max(0, Math.ceil((preview.validUntilMs - nowMs) / 1_000))
  const quoteExpired = quoteSecondsRemaining === 0
  const activeStep = ACTIVE_STEP_LABELS[execution.phase]
  const postQuoteLtv = entryPreview === undefined || entryPreview.health.collateralLoanValue === 0n
    ? undefined
    : Number(entryPreview.health.borrowAssets * 1_000_000n /
        entryPreview.health.collateralLoanValue) / 10_000

  return (
    <div className="mt-5 rounded-xl border border-[rgba(var(--op-accent-rgb),0.35)] bg-[rgba(var(--op-accent-rgb),0.05)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-fg">
            {displayedAcquisitionMode === null
              ? 'Execute risk reduction'
              : `Execute ${displayedAcquisitionMode === 'mint' ? 'Mint Mode' : 'Market Mode'}`} on {executionChainName}
          </p>
          <p className="mt-1 max-w-2xl text-[10.5px] leading-4 text-muted">
            {displayedAcquisitionMode === null
              ? 'Reduces or closes the existing position without acquiring new PT or minting YT.'
              : displayedAcquisitionMode === 'mint'
              ? 'Mints equal PT and YT in one transaction. PT backs the Morpho loan; YT stays in your wallet and does not support it.'
              : 'Runs as a single transaction from your wallet.'}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {!execution.entryEnabled && (
            <span className="rounded-full border border-hairline bg-surface px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.07em] text-faint">
              entry gated
            </span>
          )}
          {!execution.exitEnabled && (
            <span className="rounded-full border border-hairline bg-surface px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.07em] text-faint">
              exit gated
            </span>
          )}
        </div>
      </div>

      {preview === undefined && execution.intent === 'adjust' ? (
        <div className="mt-3 rounded-lg border border-hairline bg-surface px-3 py-2 text-[10.5px] leading-4 text-muted">
          Raising leverage past the red mark needs confirmation; lowering it is always allowed.
        </div>
      ) : riskReducingPreview ? (
        <div className="mt-3 rounded-lg border border-[var(--op-good-bd)] bg-[var(--op-good-soft)] px-3 py-2 text-[10.5px] leading-4 text-good">
          {decreasePreview
            ? 'Reducing leverage sells PT to repay part of the debt.'
            : 'Full exit is quoted against your live position.'}
        </div>
      ) : null}

      {activeStep && (
        <div role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-hairline bg-surface px-3 py-2 text-xs text-fg">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
          <span>{activeStep}</span>
        </div>
      )}

      {execution.notice && (
        <p
          role={execution.noticeTone === 'danger' ? 'alert' : 'status'}
          className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${execution.noticeTone === 'danger'
            ? 'border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] text-danger'
            : 'border-[var(--op-good-bd)] bg-[var(--op-good-soft)] text-good'}`}
        >
          {execution.notice}
        </p>
      )}
      {execution.message && (
        <p
          role={execution.phase === 'error' || execution.phase === 'ambiguous' ? 'alert' : 'status'}
          className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${execution.phase === 'error' || execution.phase === 'ambiguous'
            ? 'border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] text-danger'
            : 'border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] text-warn'}`}
        >
          {execution.message}
        </p>
      )}

      {execution.txHash && (
        <a
          href={explorerTxUrl(market.chainId, execution.txHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block break-all rounded-lg border border-hairline bg-surface px-3 py-2 font-mono text-[10px] text-accent-ink hover:underline"
        >
          View transaction {shortAddress(execution.txHash)}
        </a>
      )}

      {entryPreview && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[.06em] text-accent-ink">
              New loop · {entryPreview.acquisitionMode === 'mint'
                ? 'Mint Mode preflight passed'
                : 'preflight passed'}
            </p>
            <span className={quoteExpired ? 'text-[10px] text-warn' : 'text-[10px] text-muted'}>
              {quoteExpired ? 'Quote expired' : `${quoteSecondsRemaining}s remaining`}
            </span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Detail
              label="Equity"
              value={formatTokenAmount(entryPreview.equityAssets, loanDecimals, loanSymbol)}
            />
            <Detail
              label="Exact debt"
              value={formatTokenAmount(entryPreview.borrowAssets, loanDecimals, loanSymbol)}
            />
            <Detail
              label="Minimum PT"
              value={formatTokenAmount(
                entryPreview.quotes.minimumCollateral,
                market.collateralTokenDecimals,
                candidate.morpho.collateralAsset.symbol,
              )}
            />
            {entryPreview.acquisitionMode === 'mint' && (
              <Detail
                label="Minimum YT to wallet"
                value={formatTokenAmount(
                  entryPreview.minimumYtOut,
                  market.yieldTokenDecimals,
                  'YT',
                )}
                note={`Quote expects ${formatTokenAmount(
                  entryPreview.expectedYtOut,
                  market.yieldTokenDecimals,
                  'YT',
                )} · token ${shortAddress(entryPreview.yieldToken)}`}
              />
            )}
            <Detail
              label="Post-quote LTV"
              value={postQuoteLtv === undefined ? 'Unavailable' : `${postQuoteLtv.toFixed(2)}%`}
              note={`${formatBps(entryPreview.health.liquidationBufferBps)} estimated buffer at latest simulation`}
            />
          </div>
          <p className="mt-2 text-[10.5px] leading-4 text-muted">
            Allowance: {formatTokenAmount(entryPreview.approval.current, loanDecimals, loanSymbol)}.
            If needed, OpenPendle first clears any mismatched allowance, then approves only the exact equity amount.
          </p>
        </div>
      )}

      {exitPreview && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[.06em] text-warn">
              Existing loop · full exit available
            </p>
            <span className={quoteExpired ? 'text-[10px] text-warn' : 'text-[10px] text-muted'}>
              {quoteExpired ? 'Quote expired' : `${quoteSecondsRemaining}s remaining`}
            </span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <Detail
              label="PT collateral to unwind"
              value={formatTokenAmount(
                exitPreview.position.collateral,
                market.collateralTokenDecimals,
                candidate.morpho.collateralAsset.symbol,
              )}
            />
            <Detail
              label="Exact debt shares"
              value={exitPreview.position.borrowShares.toString()}
              note={`Repayment capped at ${formatTokenAmount(exitPreview.bounds.repaymentCapAssets, loanDecimals, loanSymbol)}`}
            />
            <Detail
              label="Minimum net return"
              value={formatTokenAmount(exitPreview.minimumReturnedAssets, loanDecimals, loanSymbol)}
              note="After the bounded debt repayment"
            />
          </div>
        </div>
      )}

      {increasePreview && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[.06em] text-accent-ink">
              Existing loop · {increasePreview.acquisitionMode === 'mint'
                ? 'Mint Mode increase passed'
                : 'increase preview passed'}
            </p>
            <span className={quoteExpired ? 'text-[10px] text-warn' : 'text-[10px] text-muted'}>
              {quoteExpired ? 'Quote expired' : `${quoteSecondsRemaining}s remaining`}
            </span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Detail
              label="Estimated leverage"
              value={`${formatLeverageWad(increasePreview.current.leverageWad)}× → ${formatLeverageWad(increasePreview.conservativePost.leverageWad)}×`}
              note={`Selected target ${formatLeverageWad(increasePreview.targetLeverageWad)}×`}
            />
            <Detail
              label="Added debt"
              value={formatTokenAmount(increasePreview.borrowAssets, loanDecimals, loanSymbol)}
            />
            <Detail
              label="Minimum added PT"
              value={formatTokenAmount(
                increasePreview.quote.minPtOut,
                market.collateralTokenDecimals,
                candidate.morpho.collateralAsset.symbol,
              )}
            />
            {increasePreview.acquisitionMode === 'mint' && (
              <Detail
                label="Minimum added YT to wallet"
                value={formatTokenAmount(
                  increasePreview.minimumYtOut,
                  market.yieldTokenDecimals,
                  'YT',
                )}
                note={`Quote expects ${formatTokenAmount(
                  increasePreview.expectedYtOut,
                  market.yieldTokenDecimals,
                  'YT',
                )} · token ${shortAddress(increasePreview.yieldToken)}`}
              />
            )}
            <Detail
              label="Post-quote buffer"
              value={formatBps(increasePreview.conservativePost.liquidationBufferBps)}
              note="Conservative at the latest oracle and route bounds"
            />
          </div>
        </div>
      )}

      {decreasePreview && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[.06em] text-good">
              Existing loop · reduction preview passed
            </p>
            <span className={quoteExpired ? 'text-[10px] text-warn' : 'text-[10px] text-muted'}>
              {quoteExpired ? 'Quote expired' : `${quoteSecondsRemaining}s remaining`}
            </span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Detail
              label="Estimated leverage"
              value={`${formatLeverageWad(decreasePreview.current.leverageWad)}× → ${formatLeverageWad(decreasePreview.conservativePost.leverageWad)}×`}
              note={`Selected target ${formatLeverageWad(decreasePreview.targetLeverageWad)}×`}
            />
            <Detail
              label="PT sold"
              value={formatTokenAmount(
                decreasePreview.collateralToSell,
                market.collateralTokenDecimals,
                candidate.morpho.collateralAsset.symbol,
              )}
            />
            <Detail
              label="Debt shares repaid"
              value={decreasePreview.repayShares.toString()}
              note={`Repayment capped at ${formatTokenAmount(decreasePreview.bounds.repaymentCapAssets, loanDecimals, loanSymbol)}`}
            />
            <Detail
              label="Post-quote buffer"
              value={formatBps(decreasePreview.conservativePost.liquidationBufferBps)}
              note={`At least ${formatTokenAmount(decreasePreview.minimumReturnedAssets, loanDecimals, loanSymbol)} route surplus returned`}
            />
          </div>
        </div>
      )}

      {showAction && (
        <div className="mt-3">
          <LoopingExecutionActionView execution={execution} compactNote={false} />
        </div>
      )}
      {preview && execution.phase === 'ready' && (
        <button
          type="button"
          onClick={() => void execution.prepare()}
          disabled={!execution.canPrepare}
          className="mt-2 h-9 w-full rounded-[9px] border border-hairline bg-surface px-3 text-xs font-medium text-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          Refresh safety check
        </button>
      )}

      <p className="mt-2 text-center text-[10px] leading-4 text-muted">
        Checks run through your wallet's {executionChainName} RPC — OpenPendle never simulates the signed calldata,
        and nothing is sent without your confirmation. There is no beta-size amount cap;
        wallet balance, liquidity, and every safety check still apply.
      </p>
      {execution.phase === 'ambiguous' && (
        <p className="mt-1 text-center text-[10px] leading-4 text-danger">
          {execution.pendingRecord?.operation === 'allowance-cleanup'
            ? 'No authorization signature was exposed. OpenPendle will verify and clear only the unused adapter allowance.'
            : execution.pendingRecord?.operation === 'metadata-cleanup'
              ? 'No authorization signature was exposed. Only stale browser recovery metadata needs removal.'
              : execution.pendingRecord?.txHash !== undefined || execution.txHash !== undefined
                ? 'OpenPendle will first verify the completed position and permission state. It will not send another transaction unless an active permission actually needs to be secured.'
                : 'Nothing is retried automatically. Recovery is offered only when the on-chain state is unambiguous.'}
        </p>
      )}
      <p className="mt-1 text-center font-mono text-[9px] text-faint">
        {shortAddress(market.marketId)} · {executionChainName}
      </p>
    </div>
  )
}

function ContextualLoopingExecutionDetails({ showAction }: { showAction: boolean }) {
  const { acquisitionMode, candidate, execution } = useRequiredLoopingExecution()
  return (
    <LoopingExecutionDetails
      acquisitionMode={acquisitionMode}
      candidate={candidate}
      execution={execution}
      showAction={showAction}
    />
  )
}

function LoopingConfirmationEffect({ onConfirmed }: { onConfirmed?: () => void }) {
  const { execution } = useRequiredLoopingExecution()
  const queryClient = useQueryClient()
  const callbackRef = useRef(onConfirmed)
  const previousPhaseRef = useRef<LoopingExecutionPhase | undefined>(undefined)
  callbackRef.current = onConfirmed

  useEffect(() => {
    if (
      execution.phase === 'confirmed' &&
      previousPhaseRef.current !== 'confirmed'
    ) {
      void queryClient.invalidateQueries({ queryKey: ['looping-positions'] })
      callbackRef.current?.()
    }
    previousPhaseRef.current = execution.phase
  }, [execution.phase, queryClient])

  return null
}

export interface LoopingExecutionPanelProps extends Partial<LoopingExecutionInputs> {
  onConfirmed?: () => void
}

/**
 * Detailed execution status. New call sites should render this inside the
 * provider; the optional props keep the previous single-panel integration
 * working while the calculator moves the primary action next to Amount.
 */
export function LoopingExecutionPanel(props: LoopingExecutionPanelProps = {}) {
  const context = useContext(LoopingExecutionContext)
  if (context !== null) {
    return (
      <>
        <LoopingConfirmationEffect onConfirmed={props.onConfirmed} />
        <LoopingExecutionDetails
          acquisitionMode={context.acquisitionMode}
          candidate={context.candidate}
          execution={context.execution}
          showAction={false}
        />
      </>
    )
  }
  if (
    props.candidate === undefined ||
    props.equityAssets === undefined ||
    props.leverage === undefined
  ) {
    throw new Error('LoopingExecutionPanel requires a provider or complete execution inputs.')
  }
  return (
    <LoopingExecutionProvider
      candidate={props.candidate}
      equityAssets={props.equityAssets}
      leverage={props.leverage}
      intent={props.intent}
      acquisitionMode={props.acquisitionMode}
    >
      <LoopingConfirmationEffect onConfirmed={props.onConfirmed} />
      <ContextualLoopingExecutionDetails showAction />
    </LoopingExecutionProvider>
  )
}
