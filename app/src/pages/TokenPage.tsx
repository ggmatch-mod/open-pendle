/**
 * TokenPage (M12 "paste any token") — /token/:address. When a user pastes a PT
 * or YT instead of the market (PLP), this resolves the whole (SY, PT, YT) set
 * and offers the actions that DON'T need a market: wrap / unwrap the resolved
 * SY, mint / redeem PT+YT ↔ SY (or the SY's accepted tokens), and claim accrued
 * yield — including redeeming PT at maturity. Trading (swap) and liquidity DO
 * need the market, so those point the user at the paste box. An SY paste is
 * ambiguous (one SY, many maturities), so only PT/YT resolve here.
 */

import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { isAddress, getAddress } from 'viem'
import type { ActionPlan, SupportedChainId } from '../lib/types'
import {
  useActionFlow,
  useActiveChain,
  useResolveMarket,
  useTokenPositions,
  useTokenSnapshot,
} from '../lib/hooks'
import { planClaimTokens } from '../lib/actions'
import { ActionTabs } from '../components/ActionTabs'
import { TxButton } from '../components/TxButton'
import { TxStatus } from '../components/TxStatus'
import { clampLabel, explorerAddressUrl, formatAmount, shortAddress } from '../components/format'
import { useDocumentTitle } from '../components/useDocumentTitle'
import { marketPath } from '../lib/routes'

function AddrRow({ role, symbol, address, chainId }: { role: string; symbol?: string; address: string; chainId: SupportedChainId }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">
        <span className="mr-1.5 rounded bg-surface-2 px-1 py-px text-[10px] font-semibold text-muted">{role}</span>
        {symbol ? clampLabel(symbol, 22) : ''}
      </span>
      <a
        href={explorerAddressUrl(chainId, address as `0x${string}`)}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-[12px] text-muted hover:text-accent-ink"
        title={address}
      >
        {shortAddress(address as `0x${string}`)} ↗
      </a>
    </div>
  )
}

export default function TokenPage() {
  const { address: raw } = useParams()
  useDocumentTitle('Token actions')
  const { isConnected, address: user } = useAccount()
  const { chainId } = useActiveChain()

  const valid = raw && isAddress(raw, { strict: false }) ? getAddress(raw) : undefined

  const { status, snapshot, notPyToken, refetch: refetchSnap } = useTokenSnapshot(valid)
  const {
    status: positionsStatus,
    positions,
    error: positionsError,
    refetch: refetchPositions,
  } = useTokenPositions(snapshot)
  const { status: marketResolveStatus, markets: resolvedMarkets } = useResolveMarket(snapshot)

  const hasClaimables =
    positions !== undefined &&
    (positions.ytClaimableInterestSy > 0n ||
      [...positions.ytClaimableRewards, ...positions.syClaimableRewards].some((r) => r.amount > 0n))

  const claimPlan = useMemo((): ActionPlan | null => {
    if (!snapshot || !user || !hasClaimables) return null
    try {
      return planClaimTokens(user, snapshot.sy.address, snapshot.yt)
    } catch {
      return null
    }
  }, [snapshot, user, hasClaimables])
  const claimFlow = useActionFlow(claimPlan)

  const backHome = (
    <p className="mt-8 text-sm">
      <Link to="/" className="text-accent-ink hover:text-accent-ink">
        ← Home
      </Link>
    </p>
  )

  if (valid === undefined) {
    return (
      <div className="py-8">
        <h1 className="text-2xl font-bold tracking-tight text-fg">Token actions</h1>
        <p className="mt-3 text-sm text-danger">That isn't a valid address. Paste a 42-character 0x… address.</p>
        {backHome}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[720px] py-8">
      <Link to="/" className="text-sm text-muted hover:text-fg">
        ← Home
      </Link>

      <h1 className="mt-4 text-2xl font-bold tracking-tight text-fg">
        {snapshot ? clampLabel(snapshot.displayName) : 'Token actions'}
      </h1>
      <p className="mt-1 text-sm text-muted">
        Act on a PT or YT directly — wrap or unwrap its SY, mint, redeem, and claim without the
        market. Swaps and liquidity still need the market.
      </p>

      {/* Loading / not-a-PT-YT / error states */}
      {status === 'loading' ? (
        <div className="mt-6 h-40 animate-pulse rounded-xl bg-surface-2" aria-busy="true" />
      ) : status === 'error' ? (
        <section className="mt-6 rounded-xl border border-hairline bg-surface p-6 text-center">
          <p className="text-sm text-danger">Couldn't read this token.</p>
          <button
            type="button"
            onClick={refetchSnap}
            className="mt-3 rounded-md border border-hairline-strong px-3 py-1.5 text-xs text-muted hover:bg-surface-2"
          >
            Retry
          </button>
        </section>
      ) : notPyToken || snapshot === undefined ? (
        <section className="mt-6 rounded-xl border border-hairline bg-surface p-6">
          <p className="text-sm font-medium text-fg">Not a PT or YT</p>
          <p className="mt-2 text-sm text-muted">
            This address isn't a Pendle Principal or Yield token. If it's an <span className="text-fg">SY</span>,
            note that one SY backs many maturities, so it can't open a single pool — paste a specific{' '}
            <span className="text-fg">PT</span>, <span className="text-fg">YT</span>, or the{' '}
            <span className="text-fg">market (PLP)</span> address instead.
          </p>
          <Link
            to="/"
            className="mt-4 inline-block text-sm font-medium text-accent-ink hover:underline"
          >
            Load a market by address →
          </Link>
        </section>
      ) : (
        <div className="mt-6 space-y-4">
          {/* Go to the pool — when the market resolves (Pendle API / event scan). */}
          {resolvedMarkets.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.09)] p-4">
              <p className="text-sm text-fg">
                {resolvedMarkets.length === 1
                  ? "Found this token's pool — trade, provide liquidity, or save it there."
                  : `Found ${resolvedMarkets.length} pools for this token.`}
              </p>
              {resolvedMarkets.length === 1 ? (
                <Link
                  to={marketPath(resolvedMarkets[0], chainId)}
                  className="shrink-0 rounded-[10px] bg-accent px-3.5 py-1.5 text-sm font-semibold text-white no-underline hover:brightness-110"
                >
                  Go to the pool →
                </Link>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {resolvedMarkets.map((m) => (
                    <Link
                      key={m}
                      to={marketPath(m, chainId)}
                      className="rounded-[10px] border border-[rgba(var(--op-accent-rgb),0.4)] px-2.5 py-1 font-mono text-xs text-accent-ink no-underline hover:bg-[rgba(var(--op-accent-rgb),0.08)]"
                    >
                      {shortAddress(m)} →
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Risk callout — this is a community token, unreviewed. */}
          <div
            role="note"
            className="rounded-[14px] border p-4"
            style={{ borderColor: 'var(--op-warn-bd)', background: 'var(--op-warn-soft)' }}
          >
            <p className="text-sm text-muted">
              <span className="font-semibold text-warn">Unreviewed — use at your own risk.</span>{' '}
              OpenPendle resolved this token set from the chain but can't vouch for the SY or the asset
              underneath. Verify the addresses below before you transact.
            </p>
          </div>

          {/* Resolved set */}
          <section className="rounded-xl border border-hairline bg-surface p-5">
            <h2 className="text-base font-semibold text-fg">Resolved token set</h2>
            <div className="mt-2 divide-y divide-hairline">
              <AddrRow role="PT" symbol={snapshot.ptSymbol} address={snapshot.pt} chainId={chainId} />
              <AddrRow role="YT" symbol={snapshot.ytSymbol} address={snapshot.yt} chainId={chainId} />
              <AddrRow role="SY" symbol={snapshot.sy.symbol} address={snapshot.sy.address} chainId={chainId} />
            </div>
            <p className="mt-2 text-[11px] text-faint">
              {snapshot.isExpired ? 'Matured' : 'Matures'} {snapshot.displayName.split('·')[1]?.trim()}
              {snapshot.isExpired ? ' — PT is redeemable 1:1 for the underlying.' : '.'}
            </p>
          </section>

          {/* Balances + market-less claim */}
          {isConnected && positions !== undefined && (
            <section className="rounded-xl border border-hairline bg-surface p-5">
              <h2 className="text-base font-semibold text-fg">Your balances</h2>
              <div className="mt-3 grid grid-cols-3 gap-2.5">
                {(
                  [
                    ['PT', snapshot.ptSymbol || 'PT', positions.pt, snapshot.sy.assetDecimals],
                    ['YT', snapshot.ytSymbol || 'YT', positions.yt, snapshot.sy.assetDecimals],
                    ['SY', snapshot.sy.symbol, positions.sy, snapshot.sy.decimals],
                  ] as const
                ).map(([role, sym, amt, dec]) => (
                  <div key={role} className="rounded-[12px] border border-hairline bg-bg-2 px-3 py-2.5">
                    <p className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">
                      <span className="mr-1.5 rounded bg-surface-2 px-1 py-px text-[10px] font-semibold text-muted">{role}</span>
                      {clampLabel(sym, 14)}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-fg tabular-nums">{formatAmount(amt, dec)}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-bg-2 p-3.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-muted">Claimable yield</p>
                  {hasClaimables ? (
                    <p className="mt-0.5 text-xs text-muted">
                      {positions.ytClaimableInterestSy > 0n && (
                        <span>
                          {formatAmount(positions.ytClaimableInterestSy, snapshot.sy.decimals)}{' '}
                          {clampLabel(snapshot.sy.symbol, 14)} YT interest
                        </span>
                      )}
                      {[...positions.ytClaimableRewards, ...positions.syClaimableRewards]
                        .filter((r) => r.amount > 0n)
                        .map((r) => (
                          <span key={r.token}> · {clampLabel(r.symbol, 14)} rewards</span>
                        ))}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[11px] text-faint">Nothing to claim.</p>
                  )}
                </div>
                <div className="w-full sm:w-44">
                  <TxButton
                    flow={claimFlow}
                    actionLabel="claim"
                    disabledReason={hasClaimables ? 'Claim' : 'Nothing to claim'}
                    onDone={() => {
                      claimFlow.reset()
                      refetchPositions()
                    }}
                  />
                </div>
              </div>
              <div className="mt-2">
                <TxStatus flow={claimFlow} />
              </div>
            </section>
          )}

          {/* SY and PT/YT actions that do not require a market. A terminal
              balance-query failure must not masquerade as perpetual loading. */}
          {isConnected && positionsStatus === 'error' ? (
            <section
              role="alert"
              className="rounded-xl border border-hairline bg-surface p-5"
            >
              <h2 className="text-base font-semibold text-fg">Token actions</h2>
              <p className="mt-2 text-sm text-danger">
                Couldn't load wallet balances{positionsError ? ` — ${positionsError}` : ''}.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-faint">
                Actions are paused because OpenPendle can't safely check the amount against your
                balance.
              </p>
              <button
                type="button"
                onClick={refetchPositions}
                className="mt-3 rounded-md border border-hairline-strong px-3 py-1.5 text-xs text-muted hover:bg-surface-2"
              >
                Retry
              </button>
            </section>
          ) : (
            <ActionTabs
              snapshot={snapshot}
              positions={positions}
              refetchPositions={refetchPositions}
              variant="token"
            />
          )}

          {marketResolveStatus === 'loading' && (
            <section
              className="rounded-xl border border-hairline bg-bg-2 p-4"
              aria-busy="true"
            >
              <p className="text-sm text-muted">
                Looking for this token's pool in Pendle and community-market indexes…
              </p>
            </section>
          )}

          {/* Trading / LP need the market — show the fallback only after the
              resolver has actually finished, never during its indexed lookup. */}
          {(marketResolveStatus === 'success' || marketResolveStatus === 'error') &&
            resolvedMarkets.length === 0 && (
            <section className="rounded-xl border border-hairline bg-bg-2 p-4">
              <p className="text-sm text-muted">
                <span className="font-medium text-fg">Want to trade or provide liquidity?</span> Swaps and
                LP need the market (PLP) address — we couldn't find it in Pendle's listings or the
                community-market indexes available for this network.{' '}
                <Link to="/" className="text-accent-ink hover:underline">
                  Load the market →
                </Link>
              </p>
            </section>
            )}
        </div>
      )}

      {backHome}
    </div>
  )
}
