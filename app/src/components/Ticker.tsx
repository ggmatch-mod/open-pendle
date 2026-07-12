/**
 * Slim protocol ticker for the top of the shell. Pure CSS marquee (op-ticker
 * keyframe lives in index.css); pauses on hover.
 *
 * Content is LIVE Pendle metrics from DefiLlama + CoinGecko (usePendleStats),
 * one headline per category, with a green/red 24h change on the price. If those
 * are unreachable (offline / rate-limited / CSP) it falls back to the static
 * brand facts below, so the bar is never empty.
 */
import { ROUTER_V4, SY_FACTORY } from '../lib/addresses'
import { usePendleStats, type TickerItem } from './usePendleStats'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

// Shown until live stats load, or if every metric source fails.
const FALLBACK: TickerItem[] = [
  { value: 'No transaction backend' },
  { value: 'No whitelist' },
  { value: 'Core data via RPC' },
  { value: 'Local pool registry' },
  { value: '6 networks' },
  { value: `Router V4 · ${short(ROUTER_V4)}` },
  { value: `SY factory · ${short(SY_FACTORY)}` },
  { value: 'GPL-3.0 · open source' },
]

export function Ticker() {
  const live = usePendleStats()
  const items = live.length > 0 ? live : FALLBACK
  // 4 copies (with the -50% op-ticker keyframe) keeps the loop seamless AND
  // wide enough to fill the viewport even with the short curated metric set.
  const loop = [...items, ...items, ...items, ...items]

  return (
    <div className="overflow-hidden border-b border-hairline bg-bg-2">
      <div
        className="flex w-max [animation:op-ticker_48s_linear_infinite] [will-change:transform] hover:[animation-play-state:paused] motion-reduce:animate-none motion-reduce:[will-change:auto]"
      >
        {loop.map((it, i) => (
          <span
            key={i}
            className="flex items-center gap-[7px] whitespace-nowrap px-[22px] py-[7px] font-mono text-[11px] uppercase tracking-[.03em] text-faint"
          >
            <span className="h-1 w-1 rounded-full" style={{ background: 'var(--op-accent)', opacity: 0.75 }} />
            {it.label ? <span>{it.label}</span> : null}
            <span className="text-muted">{it.value}</span>
            {it.change !== undefined ? (
              <span className={it.change >= 0 ? 'text-good' : 'text-danger'}>
                {it.change >= 0 ? '+' : '−'}
                {Math.abs(it.change).toFixed(2)}%
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  )
}
