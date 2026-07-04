/**
 * Slim protocol-fact ticker for the top of the shell. Pure CSS marquee
 * (op-ticker keyframe lives in index.css); pauses on hover. Facts are real —
 * cross-chain constants come from the address book.
 */
import { ROUTER_V4, SY_FACTORY } from '../lib/addresses'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const ITEMS = [
  'No backend',
  'No whitelist',
  'No indexer',
  '100% on-chain',
  '6 networks',
  `Router V4 · ${short(ROUTER_V4)}`,
  `SY factory · ${short(SY_FACTORY)}`,
  'Expiry divisor · 86400s',
  'YT interest fee · 3%',
  'Max swap fee · 5%',
  'GPL-3.0 · open source',
]

export function Ticker() {
  const loop = [...ITEMS, ...ITEMS] // duplicated so translateX(-50%) loops seamlessly
  return (
    <div className="overflow-hidden border-b border-hairline bg-bg-2">
      <div
        className="flex w-max hover:[animation-play-state:paused]"
        style={{ animation: 'op-ticker 52s linear infinite', willChange: 'transform' }}
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
