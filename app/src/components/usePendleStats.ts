/**
 * usePendleStats — live Pendle protocol metrics for the top ticker.
 *
 * Sources: DefiLlama (TVL / fees / revenue) + CoinGecko (PENDLE price / market
 * cap / 24h change). Both are free, key-less, CORS-enabled public read APIs —
 * a fit for the backend-free / public-good stance. Partial failures degrade
 * gracefully (only the sources that answer are shown); a total failure returns
 * [] so the Ticker falls back to its static brand facts.
 *
 * Launch note: allowlist `api.llama.fi` + `api.coingecko.com` in the CSP
 * connect-src.
 */
import { useQuery } from '@tanstack/react-query'

const usd = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n)

const price = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(3)}`)

async function json(url: string): Promise<unknown> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

async function fetchPendleStats(): Promise<string[]> {
  const [tvl, fees, rev, cg] = await Promise.allSettled([
    json('https://api.llama.fi/tvl/pendle'),
    json('https://api.llama.fi/summary/fees/pendle'),
    json('https://api.llama.fi/summary/fees/pendle?dataType=dailyRevenue'),
    json(
      'https://api.coingecko.com/api/v3/simple/price?ids=pendle&vs_currencies=usd&include_market_cap=true&include_24hr_change=true',
    ),
  ])

  const items: string[] = []

  if (tvl.status === 'fulfilled') {
    const v = num(tvl.value)
    if (v !== undefined) items.push(`Pendle TVL · ${usd(v)}`)
  }
  if (fees.status === 'fulfilled') {
    const f = fees.value as { total24h?: unknown; total7d?: unknown }
    const d = num(f?.total24h)
    const w = num(f?.total7d)
    if (d !== undefined) items.push(`Fees 24h · ${usd(d)}`)
    if (w !== undefined) items.push(`Fees 7d · ${usd(w)}`)
  }
  if (rev.status === 'fulfilled') {
    const d = num((rev.value as { total24h?: unknown })?.total24h)
    if (d !== undefined) items.push(`Revenue 24h · ${usd(d)}`)
  }
  if (cg.status === 'fulfilled') {
    const p = (cg.value as { pendle?: { usd?: unknown; usd_market_cap?: unknown; usd_24h_change?: unknown } })
      ?.pendle
    const px = num(p?.usd)
    const mc = num(p?.usd_market_cap)
    const ch = num(p?.usd_24h_change)
    if (px !== undefined) items.push(`PENDLE · ${price(px)}`)
    if (mc !== undefined) items.push(`Market cap · ${usd(mc)}`)
    if (ch !== undefined) items.push(`PENDLE 24h · ${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(1)}%`)
  }

  if (items.length === 0) throw new Error('all Pendle stat sources failed')
  return items
}

/** Live Pendle metric strings for the ticker; [] while loading or on total failure. */
export function usePendleStats(): string[] {
  const q = useQuery({
    queryKey: ['pendle-stats'],
    queryFn: fetchPendleStats,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  })
  return q.data ?? []
}
