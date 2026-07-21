/**
 * Slim protocol ticker for the top of the shell. Pure CSS marquee (op-ticker
 * keyframe lives in index.css); pauses on hover.
 *
 * Content is LIVE Pendle metrics from DefiLlama + CoinGecko (usePendleStats),
 * one headline per category, with a green/red 24h change on the price. If those
 * are unreachable (offline / rate-limited / CSP) it falls back to the static
 * brand facts below, so the bar is never empty.
 */
import { usePendleStats, type TickerItem } from './usePendleStats'

// Shown until live stats load, or if every metric source fails.
const FALLBACK: TickerItem[] = [
  { value: 'Permissionless — no whitelist' },
  { value: '6 networks' },
  { value: 'Open source · no fees' },
]

export function Ticker() {
  const live = usePendleStats()
  const items = live.length > 0 ? live : FALLBACK
  // 4 copies (with the -50% op-ticker keyframe) keeps the loop seamless AND
  // wide enough to fill the viewport even with the short curated metric set.
  const loop = [...items, ...items, ...items, ...items]

  return (
    <div className="hidden overflow-hidden border-b border-hairline bg-bg-2 sm:block">
      <ul className="sr-only">
        {items.map((it, i) => (
          <li key={i}>
            {it.label ? `${it.label} ` : ''}
            {it.value}
            {it.change !== undefined ? ` (${it.change >= 0 ? '+' : '−'}${Math.abs(it.change).toFixed(2)}%)` : ''}
          </li>
        ))}
      </ul>
      <div
        aria-hidden
        className="flex w-max [animation:op-ticker_64s_linear_infinite] [will-change:transform] hover:[animation-play-state:paused] motion-reduce:animate-none motion-reduce:[will-change:auto]"
      >
        {loop.map((it, i) => (
          <span
            key={i}
            className="flex items-center gap-[7px] whitespace-nowrap px-[22px] py-[6px] font-mono text-[10px] tracking-[.03em] text-faint"
          >
            {it.label ? <span>{it.label}</span> : null}
            <span>{it.value}</span>
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
