import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import {
  useBorosHedgeMarkets,
  useBorosHedgeQuote,
  useHyperliquidBtcPositions,
} from '../components/useFundingHedge'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { borosMarketUrl, borosPreviewFreshness } from '../lib/boros'
import {
  buildFundingHedgePlan,
  calculateFundingHedgeEconomics,
  recommendedBorosMarkets,
} from '../lib/fundingHedge'
import type { FundingHedgeEconomics, FundingHedgePlan } from '../lib/fundingHedge'
import type { HyperliquidBtcPosition } from '../lib/hyperliquid'

const HEDGE_RATIOS = [2_500, 5_000, 7_500, 10_000] as const
const DEMO_POSITION: HyperliquidBtcPosition = {
  id: 'demo:BTC',
  accountAddress: '0x0000000000000000000000000000000000000000',
  accountLabel: 'Sample account',
  accountKind: 'main',
  direction: 'long',
  sizeBtc: 1,
  sizeBtcText: '1',
  notionalUsd: 62_932,
  notionalUsdText: '62932',
  entryPrice: 60_000,
  liquidationPrice: 48_000,
  leverage: 5,
  leverageType: 'cross',
  marginUsedUsd: 12_586.4,
  unrealizedPnlUsd: 2_932,
  fundingSinceOpenUsd: -118,
}

function formatUsd(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  })
}

function formatApr(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function formatBps(value: number): string {
  return `${(value * 10_000).toFixed(1)} bps`
}

function formatBtc(value: number): string {
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })} BTC`
}

function formatDate(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1_000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatDays(seconds: number): string {
  const days = seconds / 86_400
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} days`
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'Unknown'
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Live data is temporarily unavailable.'
}

function ConnectWalletCallToAction() {
  return (
    <ConnectButton.Custom>
      {({ mounted, openConnectModal }) => (
        <button
          type="button"
          disabled={!mounted}
          onClick={openConnectModal}
          className="inline-flex min-h-11 items-center justify-center rounded-[12px] bg-accent px-5 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
        >
          Connect wallet to scan
        </button>
      )}
    </ConnectButton.Custom>
  )
}

function LoadingPanel() {
  return (
    <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]" aria-busy="true">
      {[0, 1].map((item) => (
        <div key={item} className="h-[330px] animate-pulse rounded-[20px] border border-hairline bg-surface" />
      ))}
    </div>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 rounded-[14px] border border-hairline bg-bg-2 px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[.08em] text-faint">{label}</p>
      <p className="mt-1 truncate text-[15px] font-semibold tabular-nums text-fg">{value}</p>
      {note ? <p className="mt-0.5 text-[10.5px] leading-snug text-faint">{note}</p> : null}
    </div>
  )
}

function QuoteEconomics({ plan, economics }: {
  plan: FundingHedgePlan
  economics: FundingHedgeEconomics
}) {
  const isPayer = plan.position.direction === 'long'
  const comparisonPositive = economics.comparisonToCurrentUsd !== null && economics.comparisonToCurrentUsd >= 0
  const fixedLegIsPayment = isPayer
    ? economics.fixedTermCashflowUsd >= 0
    : economics.fixedTermCashflowUsd < 0
  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Stat
          label="Fixed APR"
          value={formatApr(economics.fixedApr)}
          note={economics.netFixedApr === null ? 'After-fee APR unknown' : `${formatApr(economics.netFixedApr)} after quoted fee`}
        />
        <Stat
          label="Current floating"
          value={formatApr(economics.currentFloatingApr)}
          note="Latest Boros oracle snapshot"
        />
        <Stat
          label={fixedLegIsPayment ? 'Fixed payment' : 'Fixed income'}
          value={formatUsd(Math.abs(economics.fixedTermCashflowUsd), 2)}
          note={`Across ${formatDays(plan.termSeconds)}`}
        />
        <Stat
          label="Boros margin"
          value={formatUsd(economics.marginRequiredUsd, 2)}
          note={`${economics.marginRequiredCollateral.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${plan.market.collateral.symbol}`}
        />
        <Stat
          label="Estimated fees"
          value={economics.totalFeeUsd === null ? 'Unknown' : formatUsd(economics.totalFeeUsd, 2)}
          note={`${economics.takerFeeUsd === null ? 'Unknown taker fee' : `${formatUsd(economics.takerFeeUsd, 2)} taker`} + ${formatUsd(economics.settlementFeeUsd, 2)} settlement; entry fee and gas excluded`}
        />
        <Stat
          label="Book spread"
          value={plan.bookSpreadApr === null ? 'Unavailable' : formatBps(plan.bookSpreadApr)}
          note={`${formatBps(Math.abs(economics.executionVsBestApr))} vs best displayed level`}
        />
      </div>

      {economics.comparisonToCurrentUsd !== null && economics.netFixedApr !== null ? <div className={`mt-3 rounded-[14px] border px-4 py-3 ${
        comparisonPositive
          ? 'border-[rgba(52,211,153,0.28)] bg-[var(--op-good-soft)]'
          : 'border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)]'
      }`}>
        <p className={`text-[12px] font-semibold ${comparisonPositive ? 'text-good' : 'text-warn'}`}>
          {comparisonPositive
            ? `At today's floating rate, this hedge would be ${formatUsd(economics.comparisonToCurrentUsd, 2)} better through maturity.`
            : `At today's floating rate, locking now would cost ${formatUsd(Math.abs(economics.comparisonToCurrentUsd), 2)} more through maturity.`}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          Break-even average floating APR is about {formatApr(economics.netFixedApr)}. For this {plan.side} hedge,
          average floating funding must finish {plan.side === 'long' ? 'above' : 'below'} that level to beat staying unhedged.
          This is a snapshot, not a funding forecast.
        </p>
      </div> : (
        <p className="mt-3 rounded-[14px] border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3 text-[11px] leading-relaxed text-muted">
          Trading fees are unavailable. The after-fee APR, total fees, and break-even comparison are unknown.
        </p>
      )}
    </>
  )
}

export default function BorosHedgePage() {
  useDocumentTitle('Boros funding hedge')
  const { address, isConnected } = useAccount()
  const demo = !isConnected && new URLSearchParams(window.location.search).get('demo') === '1'
  const active = isConnected || demo
  const positionsQuery = useHyperliquidBtcPositions(isConnected ? address : undefined)
  const marketsQuery = useBorosHedgeMarkets(active)
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null)
  const [selectedMarketId, setSelectedMarketId] = useState<number | null>(null)
  const [hedgeRatioBps, setHedgeRatioBps] = useState<number>(10_000)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(interval)
  }, [])

  const positions = demo ? [DEMO_POSITION] : positionsQuery.data?.positions ?? []
  const position = positions.find((item) => item.id === selectedPositionId) ?? positions[0] ?? null
  const rankedMarkets = useMemo(
    () => position && marketsQuery.data
      ? recommendedBorosMarkets(position, marketsQuery.data.markets)
      : [],
    [marketsQuery.data, position],
  )
  const market = rankedMarkets.find((item) => item.marketId === selectedMarketId)
    ?? rankedMarkets[0]
    ?? null

  useEffect(() => {
    if (position !== null && selectedPositionId !== position.id) {
      setSelectedPositionId(position.id)
    }
  }, [position, selectedPositionId])

  useEffect(() => {
    if (market !== null && selectedMarketId !== market.marketId) {
      setSelectedMarketId(market.marketId)
    }
  }, [market, selectedMarketId])

  const planResult = useMemo(() => {
    if (position === null || market === null) return { plan: null, error: null }
    try {
      return { plan: buildFundingHedgePlan(position, market, hedgeRatioBps), error: null }
    } catch (error) {
      return { plan: null, error: message(error) }
    }
  }, [hedgeRatioBps, market, position])
  const quoteQuery = useBorosHedgeQuote(planResult.plan)
  const freshness = borosPreviewFreshness(
    market?.syncTimestamp,
    quoteQuery.data?.quotedAt,
    now,
    demo ? undefined : positionsQuery.data?.sourceTimestamp ?? null,
  )
  const economicsResult = useMemo(() => {
    if (planResult.plan === null || quoteQuery.data === undefined) {
      return { economics: null, error: null }
    }
    try {
      return {
        economics: calculateFundingHedgeEconomics(planResult.plan, quoteQuery.data),
        error: null,
      }
    } catch (error) {
      return { economics: null, error: message(error) }
    }
  }, [planResult.plan, quoteQuery.data])

  const refresh = () => {
    if (!demo) void positionsQuery.refetch()
    void marketsQuery.refetch()
    if (planResult.plan !== null) void quoteQuery.refetch()
  }

  return (
    <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 pb-16 pt-10 sm:px-7 sm:pt-16">
      <section className="relative overflow-hidden rounded-[24px] border border-hairline bg-surface px-5 py-7 shadow-[var(--op-shadow)] sm:px-8 sm:py-10">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[rgba(var(--op-accent-rgb),0.16)] blur-3xl"
        />
        <div className="relative max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[rgba(var(--op-accent-rgb),0.3)] bg-[rgba(var(--op-accent-rgb),0.09)] px-3 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-accent-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            Live prototype · BTC on Hyperliquid
          </div>
          <h1 className="max-w-[18ch] text-[34px] font-bold leading-[1.04] tracking-[-.035em] text-fg sm:text-[52px]">
            Make your funding rate predictable.
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted sm:text-base">
            Connect the same wallet you use on Hyperliquid. We find open BTC positions, match the
            funding exposure to Boros, and show the fixed rate, liquidity, margin, and fees before
            anything can be signed.
          </p>
          {!active ? <div className="mt-6"><ConnectWalletCallToAction /></div> : null}
          {demo ? (
            <div className="mt-5 inline-flex rounded-[10px] border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2 text-[11px] text-warn">
              Previewing a sample 1 BTC long position against live Boros markets.
            </div>
          ) : null}
        </div>
      </section>

      {!active ? (
        <section className="mt-5 grid gap-3 sm:grid-cols-3">
          {[
            ['01', 'Detect', 'Read the main Hyperliquid account and its subaccounts.'],
            ['02', 'Match', 'Choose the Boros side and size that offsets funding exposure.'],
            ['03', 'Price', 'Simulate the live fill, margin, spread, and term cash flow.'],
          ].map(([index, title, copy]) => (
            <div key={index} className="rounded-[18px] border border-hairline bg-surface p-5">
              <p className="font-mono text-[10px] text-accent-ink">{index}</p>
              <h2 className="mt-3 text-base font-semibold text-fg">{title}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{copy}</p>
            </div>
          ))}
        </section>
      ) : (!demo && positionsQuery.isLoading) || marketsQuery.isLoading ? (
        <section className="mt-5"><LoadingPanel /></section>
      ) : (!demo && positionsQuery.isError) || marketsQuery.isError ? (
        <section className="mt-5 rounded-[18px] border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-5">
          <h2 className="text-base font-semibold text-danger">The live scan could not finish</h2>
          <p className="mt-1.5 text-sm text-muted">
            {message((!demo ? positionsQuery.error : null) ?? marketsQuery.error)}
          </p>
          <button type="button" onClick={refresh} className="mt-4 rounded-[10px] border border-hairline bg-surface px-4 py-2 text-sm font-semibold text-fg hover:bg-surface-2">
            Retry
          </button>
        </section>
      ) : positions.length === 0 ? (
        <section className="mt-5 rounded-[20px] border border-hairline bg-surface px-5 py-10 text-center sm:px-8">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-xl text-faint">◎</div>
          <h2 className="mt-4 text-lg font-semibold text-fg">No open Hyperliquid BTC position found</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted">
            We checked the connected main account and {Math.max((positionsQuery.data?.accountCount ?? 1) - 1, 0)} subaccounts.
            Vault deposits are excluded; agent wallets are resolved to their principal account.
          </p>
          <button type="button" onClick={refresh} className="mt-5 rounded-[10px] border border-hairline bg-bg-2 px-4 py-2 text-sm font-semibold text-fg hover:bg-surface-2">
            Scan again
          </button>
        </section>
      ) : position !== null && planResult.plan !== null ? (
        <section className="mt-5 grid min-w-0 items-start gap-4 lg:grid-cols-[0.88fr_1.12fr]">
          <div className="min-w-0 space-y-4">
            <div className="min-w-0 overflow-hidden rounded-[20px] border border-hairline bg-surface p-4 sm:p-5">
              <div className="flex min-w-0 items-start gap-3">
                <span className={`mt-0.5 shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                  position.direction === 'long'
                    ? 'border-[rgba(52,211,153,0.3)] bg-[var(--op-good-soft)] text-good'
                    : 'border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] text-danger'
                }`}>
                  {position.direction.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[10px] uppercase tracking-[.09em] text-faint">
                    {demo ? 'Sample position' : 'Detected position'} · Hyperliquid
                  </p>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <h2 className="text-xl font-semibold text-fg">{formatBtc(position.sizeBtc)}</h2>
                    <span className="text-[13px] text-muted">BTC perp · {formatUsd(position.notionalUsd)} notional</span>
                  </div>
                </div>
              </div>

              {positions.length > 1 ? (
                <div className="mt-4 flex flex-wrap gap-2" aria-label="Hyperliquid position account">
                  {positions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={item.id === position.id}
                      onClick={() => setSelectedPositionId(item.id)}
                      className={`rounded-[9px] border px-3 py-1.5 text-[11px] font-medium ${
                        item.id === position.id
                          ? 'border-[rgba(var(--op-accent-rgb),0.45)] bg-[rgba(var(--op-accent-rgb),0.11)] text-accent-ink'
                          : 'border-hairline bg-bg-2 text-muted hover:text-fg'
                      }`}
                    >
                      <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
                        item.direction === 'long' ? 'bg-good' : 'bg-danger'
                      }`} />
                      {item.accountLabel} · {item.direction.toUpperCase()} {formatBtc(item.sizeBtc)}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-hairline pt-3 text-[11px]">
                <span className="text-muted">Entry <strong className="ml-1 font-semibold text-fg">{position.entryPrice === null ? 'Unavailable' : formatUsd(position.entryPrice)}</strong></span>
                <span className="text-muted">Liquidation <strong className="ml-1 font-semibold text-fg">{position.liquidationPrice === null ? 'None shown' : formatUsd(position.liquidationPrice)}</strong></span>
                {position.leverage !== null ? (
                  <span className="text-muted">Leverage <strong className="ml-1 font-semibold text-fg">{position.leverage}× {position.leverageType ?? ''}</strong></span>
                ) : null}
              </div>
              <p className="mt-2 truncate font-mono text-[10px] text-faint">
                {position.accountLabel} · {position.accountAddress}
              </p>
            </div>

            <div className="min-w-0 overflow-hidden rounded-[20px] border border-hairline bg-surface p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[.09em] text-faint">Coverage</p>
                  <h2 className="mt-1 text-base font-semibold text-fg">How much to fix</h2>
                </div>
                <span className="text-lg font-semibold tabular-nums text-accent-ink">{hedgeRatioBps / 100}%</span>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-2">
                {HEDGE_RATIOS.map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    aria-pressed={hedgeRatioBps === ratio}
                    onClick={() => setHedgeRatioBps(ratio)}
                    className={`rounded-[9px] border py-2 text-[12px] font-semibold ${
                      hedgeRatioBps === ratio
                        ? 'border-[rgba(var(--op-accent-rgb),0.5)] bg-[rgba(var(--op-accent-rgb),0.12)] text-accent-ink'
                        : 'border-hairline bg-bg-2 text-muted hover:text-fg'
                    }`}
                  >
                    {ratio / 100}%
                  </button>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between text-[12px]">
                <span className="text-muted">Covered</span>
                <span className="font-semibold tabular-nums text-fg">{formatUsd(planResult.plan.hedgedNotionalUsd)}</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[12px]">
                <span className="text-muted">Still floating</span>
                <span className="font-semibold tabular-nums text-fg">{formatUsd(planResult.plan.uncoveredNotionalUsd)}</span>
              </div>
            </div>
          </div>

          <div className="min-w-0 overflow-hidden rounded-[20px] border border-[rgba(var(--op-accent-rgb),0.28)] bg-surface p-5 shadow-[var(--op-shadow)] sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-[rgba(var(--op-accent-rgb),0.12)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[.06em] text-accent-ink">
                    Hedge quote
                  </span>
                  <span className="text-[11px] text-faint">Funding only</span>
                </div>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-fg">
                  {planResult.plan.side === 'long' ? 'Long' : 'Short'} Boros YU
                </h2>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  {planResult.plan.side === 'long'
                    ? 'Receive Hyperliquid floating funding and pay a fixed rate.'
                    : 'Pay Hyperliquid floating funding and receive a fixed rate.'}
                </p>
              </div>
              <button type="button" onClick={refresh} className="rounded-[9px] border border-hairline bg-bg-2 px-3 py-1.5 text-[11px] font-medium text-muted hover:text-fg">
                Refresh
              </button>
            </div>

            <div className="mt-5">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[.08em] text-faint">Boros market</p>
              <div className="flex flex-wrap gap-2">
                {rankedMarkets.map((item, index) => (
                  <button
                    key={item.marketId}
                    type="button"
                    aria-pressed={item.marketId === planResult.plan?.market.marketId}
                    onClick={() => setSelectedMarketId(item.marketId)}
                    className={`rounded-[10px] border px-3 py-2 text-left ${
                      item.marketId === planResult.plan?.market.marketId
                        ? 'border-[rgba(var(--op-accent-rgb),0.5)] bg-[rgba(var(--op-accent-rgb),0.1)]'
                        : 'border-hairline bg-bg-2 hover:border-hairline-strong'
                    }`}
                  >
                    <span className="block text-[12px] font-semibold text-fg">
                      {formatDate(item.maturity)} · {item.collateral.symbol}
                    </span>
                    <span className="mt-0.5 block text-[10.5px] text-faint">
                      {index === 0
                        ? `Suggested default · ${formatApr(position.direction === 'long' ? Number(item.bestAskApr) : Number(item.bestBidApr))}`
                        : item.collateral.unit === 'usd'
                          ? `Stable-collateral option · ${formatApr(position.direction === 'long' ? Number(item.bestAskApr) : Number(item.bestBidApr))}`
                          : `Alternative term · ${formatApr(position.direction === 'long' ? Number(item.bestAskApr) : Number(item.bestBidApr))}`}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-[14px] border border-hairline bg-bg-2 px-4 py-3">
              <div className="flex items-center justify-between gap-3 text-[12px]">
                <span className="text-muted">Hedge size</span>
                <span className="min-w-0 text-right font-semibold tabular-nums text-fg">
                  {planResult.plan.market.collateral.unit === 'btc'
                    ? `${planResult.plan.sizeYu.toLocaleString('en-US', { maximumFractionDigits: 6 })} BTC YU`
                    : `${planResult.plan.sizeYu.toLocaleString('en-US', { maximumFractionDigits: 0 })} USD YU`}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 text-[12px]">
                <span className="text-muted">Fixing window</span>
                <span className="min-w-0 text-right font-semibold text-fg">Until {formatDate(planResult.plan.market.maturity)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 text-[12px]">
                <span className="text-muted">Collateral</span>
                <span className="min-w-0 text-right font-semibold text-fg">{planResult.plan.market.collateral.name} on Arbitrum</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 text-[12px]">
                <span className="text-muted">Execution guard</span>
                <span className="min-w-0 text-right font-semibold text-fg">FOK · max 50 bps from mid</span>
              </div>
            </div>

            <p className="mt-4 text-[10.5px] leading-relaxed text-muted" role="status">
              Boros source: {formatAge(freshness.sourceAgeSeconds)} · Simulation: {formatAge(freshness.quoteAgeSeconds)}
              {demo ? ' · Sample exposure' : ` · Hyperliquid source: ${formatAge(freshness.exposureAgeSeconds)}`}
              {quoteQuery.isFetching ? ' · Refreshing' : ''}
            </p>
            {quoteQuery.isLoading || quoteQuery.isFetching && quoteQuery.data === undefined ? (
              <div className="mt-4 h-48 animate-pulse rounded-[14px] bg-surface-2" aria-label="Simulating Boros hedge" />
            ) : quoteQuery.isError || economicsResult.error !== null ? (
              <div className="mt-4 rounded-[14px] border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] px-4 py-3">
                <p className="text-[12px] font-semibold text-danger">No executable quote</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">{economicsResult.error ?? message(quoteQuery.error)}</p>
              </div>
            ) : !freshness.isFresh && quoteQuery.data !== undefined ? (
              <div className="mt-4 rounded-[14px] border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-4 py-3">
                <p className="text-[12px] font-semibold text-warn">Preview is out of date</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                  Waiting for {demo ? 'Boros source data' : 'Boros and Hyperliquid source data'} under 2 minutes old and a simulation under 45 seconds old. Refresh to try again.
                </p>
              </div>
            ) : economicsResult.economics !== null ? (
              <QuoteEconomics plan={planResult.plan} economics={economicsResult.economics} />
            ) : null}

            <div className="mt-5 border-t border-hairline pt-5">
              {economicsResult.economics?.fullFill && freshness.isFresh && !quoteQuery.isError && economicsResult.error === null ? (
                <a
                  href={borosMarketUrl(planResult.plan.market.marketId, planResult.plan.side)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-12 w-full items-center justify-center rounded-[12px] bg-accent px-4 text-sm font-semibold text-accent-fg no-underline transition hover:brightness-110"
                >
                  Review this hedge on Boros ↗
                </a>
              ) : (
                <button type="button" disabled className="min-h-12 w-full cursor-not-allowed rounded-[12px] bg-surface-3 px-4 text-sm font-semibold text-faint">
                  {!freshness.isFresh ? 'Waiting for a fresh preview' : quoteQuery.isError || economicsResult.error !== null ? 'Quote unavailable' : 'Full size is not executable'}
                </button>
              )}
              <div className="mt-3 flex items-start gap-2 rounded-[11px] border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] px-3 py-2.5">
                <span aria-hidden className="mt-px text-warn">◇</span>
                <p className="text-[10.5px] leading-relaxed text-muted">
                  First iteration: live detection, sizing, and simulation are working; signing is not
                  yet wired here. Quotes are per Hyperliquid account and currently assume no existing
                  Boros BTC position or resting order. First-time Boros use still requires margin
                  funding and agent setup.
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="mt-5 rounded-[18px] border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-5">
          <h2 className="text-base font-semibold text-danger">A safe hedge could not be constructed</h2>
          <p className="mt-1.5 text-sm text-muted">{planResult.error ?? 'No eligible Boros BTC market is currently executable.'}</p>
        </section>
      )}

      <section className="mt-5 grid gap-3 md:grid-cols-3">
        <div className="rounded-[16px] border border-hairline bg-surface p-4">
          <p className="text-[11px] font-semibold text-fg">Read-only by default</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">Hyperliquid exposes positions by public address. This scan asks for no trading key or signature.</p>
        </div>
        <div className="rounded-[16px] border border-hairline bg-surface p-4">
          <p className="text-[11px] font-semibold text-fg">What is hedged</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">Only the funding-rate cash flow. BTC price PnL, liquidation risk, collateral basis, and venue risk remain.</p>
        </div>
        <div className="rounded-[16px] border border-hairline bg-surface p-4">
          <p className="text-[11px] font-semibold text-fg">Execution boundary</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">A future one-click path must refresh the position and quote immediately before the Boros signature.</p>
        </div>
      </section>
    </main>
  )
}
