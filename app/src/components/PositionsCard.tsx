/**
 * PositionsCard (M2) — the connected user's stake in this market: PT/YT/LP/SY
 * balances (PT/YT in assetDecimals, SY in sy.decimals, LP fixed 18), wallet
 * balances of the SY's tokensIn, and claimables (YT interest in SY units with
 * an ≈-asset conversion via exchangeRate, plus reward tokens) with a Claim
 * button driving useActionFlow(planClaim). Renders only when a wallet is
 * connected; works on expired markets too — claims stay valid there.
 *
 * M4: the LP cell decomposes the balance into its pro-rata pool share
 * ("≈ X SY + Y PT · Z% of pool") via previewDualRemove, falling back to
 * inline lp/totalLp × reserves math while the data-layer skeleton throws.
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import type {
  ActionPlan,
  MarketSnapshot,
  Positions,
  QueryStatus,
  TokenAmount,
} from '../lib/types'
import { useActionFlow } from '../lib/hooks'
import { planClaim } from '../lib/actions'
import { previewDualRemove } from '../lib/liquidity'
import { UNKNOWN_DECIMALS } from '../lib/positions'
import { TxButton } from './TxButton'
import { TxStatus } from './TxStatus'
import { clampLabel, formatAmount, formatPercent } from './format'

/** Pendle market LP is a standard 18-decimals ERC-20 (PendleERC20). */
const LP_DECIMALS = 18

/**
 * Unreadable token decimals (UNKNOWN_DECIMALS sentinel) → "raw: N" instead of
 * formatting with a guessed 18, which would be confidently wrong.
 */
function tokenAmountLabel(t: TokenAmount): string {
  return t.decimals === UNKNOWN_DECIMALS
    ? `raw: ${t.amount.toString()}`
    : formatAmount(t.amount, t.decimals)
}

function BalanceCell({
  role,
  symbol,
  amount,
  decimals,
  sub,
}: {
  role: string
  symbol: string
  amount: bigint
  decimals: number
  /** Optional muted line under the balance (LP decomposition). */
  sub?: ReactNode
}) {
  return (
    <div className="rounded-[12px] border border-hairline bg-bg-2 px-3 py-2.5">
      <p className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">
        <span className="mr-1.5 rounded bg-surface-2 px-1 py-px text-[10px] font-semibold text-muted">
          {role}
        </span>
        <span title={symbol}>{clampLabel(symbol, 18)}</span>
      </p>
      <p className="mt-1 text-sm font-semibold text-fg tabular-nums">
        {formatAmount(amount, decimals)}
      </p>
      {sub != null && (
        <p className="mt-0.5 text-[11px] leading-snug text-faint">{sub}</p>
      )}
    </div>
  )
}

function RewardList({ label, rewards }: { label: string; rewards: TokenAmount[] }) {
  const nonZero = rewards.filter((r) => r.amount > 0n)
  if (nonZero.length === 0) return null
  return (
    <p className="text-xs text-muted">
      <span className="text-faint">{label}:</span>{' '}
      {nonZero.map((r, i) => (
        <span key={r.token}>
          {i > 0 && ' · '}
          {tokenAmountLabel(r)} {clampLabel(r.symbol, 16)}
        </span>
      ))}
    </p>
  )
}

function CardShell({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <h2 className="text-base font-semibold text-fg">Your positions</h2>
      {children}
    </section>
  )
}

export function PositionsCard({
  snapshot,
  positions,
  status,
  error,
  refetch,
}: {
  snapshot: MarketSnapshot
  positions?: Positions
  status: QueryStatus
  error?: string
  refetch: () => void
}) {
  const { address: user, isConnected } = useAccount()

  const hasClaimables =
    positions !== undefined &&
    (positions.ytClaimableInterestSy > 0n ||
      [
        ...positions.ytClaimableRewards,
        ...positions.lpClaimableRewards,
        ...positions.syClaimableRewards,
      ].some((r) => r.amount > 0n))

  const { plan: claimPlan, reason: claimReason } = useMemo((): {
    plan: ActionPlan | null
    reason: string | null
  } => {
    if (user === undefined || positions === undefined) return { plan: null, reason: null }
    if (!hasClaimables) return { plan: null, reason: 'Nothing to claim' }
    try {
      return { plan: planClaim(user, snapshot), reason: null }
    } catch {
      return { plan: null, reason: 'Claim unavailable' }
    }
  }, [user, positions, hasClaimables, snapshot])

  const claimFlow = useActionFlow(claimPlan)

  // All hooks above this line — render gates below.
  if (!isConnected) return null

  if (status === 'error') {
    return (
      <CardShell>
        <p className="mt-2 text-sm text-danger">
          Couldn't load positions{error ? ` — ${error}` : ''}.
        </p>
        <button
          type="button"
          onClick={refetch}
          className="mt-2 rounded-md border border-hairline-strong px-3 py-1.5 text-xs text-muted hover:bg-surface-2"
        >
          Retry
        </button>
      </CardShell>
    )
  }

  if (positions === undefined) {
    // 'loading', or 'idle' until the M2 data layer wires usePositions live.
    return (
      <CardShell>
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-2" />
          ))}
        </div>
      </CardShell>
    )
  }

  const { sy } = snapshot

  // M4: LP → (SY + PT) pro-rata decomposition + share of pool. Prefer the
  // lib's previewDualRemove (single source of truth with the Liquidity tab);
  // fall back to inline lp/totalLp × reserves math while the skeleton throws.
  const lpBreakdown = ((): { syOut: bigint; ptOut: bigint; share: number } | undefined => {
    if (positions.lp <= 0n) return undefined
    try {
      const p = previewDualRemove(snapshot, positions.lp)
      return { syOut: p.syOut, ptOut: p.ptOut, share: p.shareBurned }
    } catch {
      const { totalLp, totalSy, totalPt } = snapshot.state
      if (totalLp <= 0n) return undefined
      return {
        syOut: (positions.lp * totalSy) / totalLp,
        ptOut: (positions.lp * totalPt) / totalLp,
        share: Number((positions.lp * 1_000_000n) / totalLp) / 1_000_000,
      }
    }
  })()

  const walletNonZero = positions.walletTokens.filter((t) => t.amount > 0n)
  // Raw-first conversion so sy.decimals ≠ assetDecimals cannot skew the ≈ line:
  // SY raw × exchangeRate (1e18-scaled SY→asset) yields RAW asset units, which
  // are then formatted at assetDecimals.
  const interestAssetRaw = (positions.ytClaimableInterestSy * sy.exchangeRate) / 10n ** 18n
  const interestAsset = Number(formatUnits(interestAssetRaw, sy.assetDecimals))
  const assetLabel = sy.assetSymbol ? clampLabel(sy.assetSymbol) : 'asset'

  const claimOnDone = () => {
    claimFlow.reset()
    refetch()
  }

  return (
    <CardShell>
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <BalanceCell
          role="PT"
          symbol={snapshot.ptSymbol || 'PT'}
          amount={positions.pt}
          decimals={sy.assetDecimals}
        />
        <BalanceCell
          role="YT"
          symbol={snapshot.ytSymbol || 'YT'}
          amount={positions.yt}
          decimals={sy.assetDecimals}
        />
        <BalanceCell
          role="LP"
          symbol="Pool LP"
          amount={positions.lp}
          decimals={LP_DECIMALS}
          sub={
            lpBreakdown !== undefined ? (
              <>
                ≈ {formatAmount(lpBreakdown.syOut, sy.decimals)} SY +{' '}
                {formatAmount(lpBreakdown.ptOut, sy.assetDecimals)} PT ·{' '}
                {formatPercent(lpBreakdown.share)} of pool
              </>
            ) : undefined
          }
        />
        <BalanceCell role="SY" symbol={sy.symbol} amount={positions.sy} decimals={sy.decimals} />
      </div>

      {walletNonZero.length > 0 && (
        <p className="mt-3 text-xs text-muted">
          <span className="text-faint">Wallet (deposit tokens):</span>{' '}
          {walletNonZero.map((t, i) => (
            <span key={t.token}>
              {i > 0 && ' · '}
              {tokenAmountLabel(t)} {clampLabel(t.symbol, 16)}
            </span>
          ))}
        </p>
      )}

      <div className="mt-4 rounded-lg border border-hairline bg-bg-2 p-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-semibold text-muted">Claimable</p>
            {positions.ytClaimableInterestSy > 0n ? (
              <p className="text-xs text-muted">
                <span className="text-faint">YT interest:</span>{' '}
                {formatAmount(positions.ytClaimableInterestSy, sy.decimals)}{' '}
                {clampLabel(sy.symbol, 16)}{' '}
                <span className="text-faint">
                  (≈ {Number.isFinite(interestAsset) ? interestAsset.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'}{' '}
                  {assetLabel} terms)
                </span>
              </p>
            ) : (
              <p className="text-xs text-faint">No YT interest accrued.</p>
            )}
            <RewardList label="YT rewards" rewards={positions.ytClaimableRewards} />
            <RewardList label="LP rewards" rewards={positions.lpClaimableRewards} />
            <RewardList label="SY rewards" rewards={positions.syClaimableRewards} />
          </div>
          <div className="w-full sm:w-44">
            <TxButton
              flow={claimFlow}
              actionLabel="claim"
              disabledReason={claimReason ?? 'Claim'}
              onDone={claimOnDone}
            />
          </div>
        </div>
        <div className="mt-2">
          <TxStatus flow={claimFlow} />
        </div>
        {snapshot.isExpired && (
          <p className="mt-2 text-[11px] text-faint">
            This market has matured — accrual is frozen but residual claims stay
            valid forever.
          </p>
        )}
      </div>

      {positions.degraded.length > 0 && (
        <ul className="mt-3 space-y-0.5">
          {positions.degraded.map((note) => (
            <li key={note} className="text-[11px] text-faint">
              ⚠ {note}
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  )
}
