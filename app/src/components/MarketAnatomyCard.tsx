/**
 * Presentational "market anatomy" card for the Home hero — visualizes the
 * SY → PT + YT split with example stats. Pure presentation (no data fetching);
 * pass real values later if you want, or leave the illustrative defaults.
 */
type Props = {
  name?: string
  maturity?: string
  chain?: string
  addressShort?: string
  impliedApy?: string
  tvl?: string
  ptProportionPct?: number
}

export function MarketAnatomyCard({
  name = 'PLP Staked USDai',
  maturity = '25 Feb 2027',
  chain = 'Arbitrum',
  addressShort = '0xf861…83c8',
  impliedApy = '10.43%',
  tvl = '842K',
  ptProportionPct = 62,
}: Props) {
  return (
    <div
      className="relative rounded-[20px] border border-hairline bg-surface p-[22px]"
      style={{ boxShadow: 'var(--op-shadow-lg)' }}
    >
      <div className="flex items-center justify-between gap-2.5">
        <span className="inline-flex items-center gap-[7px] font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--op-accent)', animation: 'op-pulse 2.4s ease-in-out infinite' }} />
          Live market · anatomy
        </span>
        <span className="rounded-full border border-hairline bg-surface-2 px-[9px] py-0.5 font-mono text-[10px] uppercase tracking-[.05em] text-muted">
          Example
        </span>
      </div>

      <p className="mt-3.5 text-[16px] font-bold tracking-[-.01em] text-fg">{name}</p>
      <p className="mt-1 text-[12.5px] text-muted">
        Matures {maturity} · {chain} · <span className="font-mono">{addressShort}</span>
      </p>

      <div className="mt-[18px] flex flex-col items-center">
        <span className="inline-flex items-center gap-[9px] rounded-[11px] border border-hairline-strong bg-bg-2 px-3.5 py-2">
          <span className="font-mono text-[11px] font-semibold text-accent-ink">SY</span>
          <span className="text-[12px] text-muted">Standardized Yield wraps the asset</span>
        </span>
        <span className="h-4 w-px" style={{ background: 'var(--op-border-strong)' }} />
        <div className="grid w-full grid-cols-2 gap-3">
          <div className="overflow-hidden rounded-[12px] border border-hairline bg-bg-2">
            <div className="h-[3px]" style={{ background: 'var(--op-accent)' }} />
            <div className="px-3 py-2.5">
              <p className="font-mono text-[11px] font-semibold text-accent-ink">PT</p>
              <p className="mt-1 text-[11.5px] leading-snug text-muted">Principal — redeems 1:1 at maturity</p>
            </div>
          </div>
          <div className="overflow-hidden rounded-[12px] border border-hairline bg-bg-2">
            <div className="h-[3px]" style={{ background: 'var(--op-accent-strong)' }} />
            <div className="px-3 py-2.5">
              <p className="font-mono text-[11px] font-semibold text-fg">YT</p>
              <p className="mt-1 text-[11.5px] leading-snug text-muted">Yield — collects until expiry</p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex justify-between font-mono text-[10px] uppercase tracking-[.05em] text-faint">
          <span>PT proportion</span>
          <span>{ptProportionPct}%</span>
        </div>
        <div className="mt-1.5 h-[5px] overflow-hidden rounded-[3px] bg-surface-3">
          <div className="h-full rounded-[3px]" style={{ width: `${ptProportionPct}%`, background: 'var(--op-accent)' }} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2.5 border-t border-hairline pt-3.5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[.04em] text-faint">Implied APY</p>
          <p className="mt-1 text-[16px] font-bold tabular-nums text-accent-ink">{impliedApy}</p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[.04em] text-faint">Maturity</p>
          <p className="mt-1 text-[15px] font-semibold text-fg">{maturity}</p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[.04em] text-faint">TVL</p>
          <p className="mt-1 text-[15px] font-semibold tabular-nums text-fg">{tvl}</p>
        </div>
      </div>
    </div>
  )
}
