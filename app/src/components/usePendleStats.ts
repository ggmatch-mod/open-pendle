/**
 * usePendleStats — live Pendle protocol metrics for the top ticker.
 *
 * Curated to one headline number per category:
 *   TVL · Market cap · Revenue (1y) · Holder revenue (1y) · Fees (1y) · PENDLE price+24h
 *
 * Sources: DefiLlama (TVL + fees/revenue/holders-revenue trailing-year) and
 * CoinGecko (price / market cap / 24h change). Both are free, key-less,
 * CORS-enabled public read APIs — a fit for the backend-free / public-good
 * stance. Partial failures degrade gracefully (only sources that answer show);
 * a total failure returns [] so the Ticker falls back to its static brand facts.
 *
 * Launch note: allowlist `api.llama.fi` + `api.coingecko.com` in the CSP
 * connect-src.
 */
import { useQuery } from '@tanstack/react-query'

/** One ticker cell: a value, an optional label prefix, and an optional signed % change. */
export type TickerItem = { label?: string; value: string; change?: number }

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

/** DefiLlama fee-summary trailing-year total (total1y) for a given dataType. */
function total1y(r: PromiseSettledResult<unknown>): number | undefined {
  return r.status === 'fulfilled' ? num((r.value as { total1y?: unknown })?.total1y) : undefined
}

async function fetchPendleStats(): Promise<TickerItem[]> {
  const [tvl, fees, rev, hrev, cg] = await Promise.allSettled([
    json('https://api.llama.fi/tvl/pendle'),
    json('https://api.llama.fi/summary/fees/pendle'),
    json('https://api.llama.fi/summary/fees/pendle?dataType=dailyRevenue'),
    json('https://api.llama.fi/summary/fees/pendle?dataType=dailyHoldersRevenue'),
    json(
      'https://api.coingecko.com/api/v3/simple/price?ids=pendle&vs_currencies=usd&include_market_cap=true&include_24hr_change=true',
    ),
  ])

  const cgP =
    cg.status === 'fulfilled'
      ? (cg.value as { pendle?: { usd?: unknown; usd_market_cap?: unknown; usd_24h_change?: unknown } })?.pendle
      : undefined

  const items: TickerItem[] = []

  // Order mirrors the curated category list.
  if (tvl.status === 'fulfilled') {
    const v = num(tvl.value)
    if (v !== undefined) items.push({ label: 'TVL', value: usd(v) })
  }
  const mc = num(cgP?.usd_market_cap)
  if (mc !== undefined) items.push({ label: 'Market cap', value: usd(mc) })

  const rv = total1y(rev)
  if (rv !== undefined) items.push({ label: 'Revenue 1y', value: usd(rv) })

  const hr = total1y(hrev)
  if (hr !== undefined) items.push({ label: 'Holder revenue 1y', value: usd(hr) })

  const fe = total1y(fees)
  if (fe !== undefined) items.push({ label: 'Fees 1y', value: usd(fe) })

  const px = num(cgP?.usd)
  const ch = num(cgP?.usd_24h_change)
  if (px !== undefined) items.push({ label: 'PENDLE', value: price(px), change: ch })

  if (items.length === 0) throw new Error('all Pendle stat sources failed')
  return items
}

/** Live Pendle metric cells for the ticker; [] while loading or on total failure. */
export function usePendleStats(): TickerItem[] {
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
