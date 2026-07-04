/**
 * Slim protocol ticker for the top of the shell. Pure CSS marquee (op-ticker
 * keyframe lives in index.css); pauses on hover.
 *
 * Content is LIVE Pendle metrics from DefiLlama + CoinGecko (usePendleStats).
 * If those are unreachable (offline / rate-limited / CSP), it falls back to the
 * static brand + contract facts below, so the bar is never empty.
 */
import { ROUTER_V4, SY_FACTORY } from '../lib/addresses'
import { usePendleStats } from './usePendleStats'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

// Shown until live stats load, or if every metric source fails.
const FALLBACK = [
  'No backend',
  'No whitelist',
  'No indexer',
  '100% on-chain',
  '6 networks',
  `Router V4 · ${short(ROUTER_V4)}`,
  `SY factory · ${short(SY_FACTORY)}`,
  'GPL-3.0 · open source',
]

export function Ticker() {
  const live = usePendleStats()
  // Live metrics lead; a couple of brand facts tail them for identity.
  const items = live.length > 0 ? [...live, 'No whitelist', 'GPL-3.0 · open source'] : FALLBACK
  const loop = [...items, ...items] // duplicated so translateX(-50%) loops seamlessly

  return (
    <div className="overflow-hidden border-b border-hairline bg-bg-2">
      <div
        className="flex w-max hover:[animation-play-state:paused]"
        style={{ animation: 'op-ticker 60s linear infinite', willChange: 'transform' }}
      >
        {loop.map((t, i) => (
          <span
            key={i}
            className="flex items-center gap-[9px] whitespace-nowrap px-[22px] py-[7px] font-mono text-[11px] uppercase tracking-[.03em] text-faint"
          >
            <span className="h-1 w-1 rounded-full" style={{ background: 'var(--op-accent)', opacity: 0.75 }} />
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}
