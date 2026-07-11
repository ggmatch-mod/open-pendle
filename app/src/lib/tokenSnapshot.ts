/**
 * M12 "paste any token" — resolve a pool's (SY, PT, YT) set from a pasted PT or
 * YT and assemble a MARKET-LESS synthetic MarketSnapshot. A PT knows its SY+YT
 * and a YT knows its SY+PT (the same getters the paste classifier probes), so a
 * pasted PT/YT uniquely identifies the whole set — whereas an SY is ambiguous
 * (one SY backs many maturities), so an SY paste returns null.
 *
 * The synthetic snapshot carries the REAL sy / pt / yt / symbols / expiry, so
 * the fork-tested mint / redeem / claim builders and MintRedeemPanel work
 * unchanged (they never read the market address). Market-only fields are safe
 * placeholders: `address` is set to the pasted token — used ONLY as a
 * react-query key downstream, never for tx building — and state/metrics/trust
 * are empty. Positions load with { includeMarket:false } so no LP/market read
 * touches a market this set doesn't have.
 */

import type { Address, PublicClient } from 'viem'
import type {
  MarketMetrics,
  MarketSnapshot,
  MarketStateSnapshot,
  SyInfo,
  TrustInfo,
} from './types.ts'
import { MULTICALL3 } from './addresses.ts'
import { erc20SymbolAbi, pyProbeAbi, syReadAbi } from './pendleAbi.ts'
import { formatExpiryUtc } from './market.ts'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/** PT and YT both expose expiry() (unix seconds). */
const expiryAbi = [
  { type: 'function', name: 'expiry', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const EMPTY_STATE: MarketStateSnapshot = {
  totalPt: 0n,
  totalSy: 0n,
  totalLp: 0n,
  treasury: ZERO_ADDRESS,
  scalarRoot: 0n,
  lnFeeRateRoot: 0n,
  reserveFeePercent: 0n,
  lastLnImpliedRate: 0n,
}

const EMPTY_METRICS: MarketMetrics = {
  impliedApy: 0,
  ptPriceAsset: 0,
  ptPriceSy: 0,
  ytPriceAsset: 0,
  tvlAsset: 0,
  feeTier: 0,
  ptProportion: 0,
  nearRangeEdge: false,
}

const EMPTY_TRUST: TrustInfo = { syIsProxy: false, notes: [] }

/**
 * Resolve a pasted PT/YT into a market-less MarketSnapshot. Returns null when
 * the address is not a clean PT or YT (an SY, a market, or anything else) — the
 * caller then tells the user to paste the market address.
 */
export async function resolveTokenSet(
  client: PublicClient,
  address: Address,
): Promise<MarketSnapshot | null> {
  // Classify: a PT answers SY()+YT() but not PT(); a YT answers SY()+PT() but
  // not YT() — mirrors classifyAddress in market.ts.
  const probe = await client.multicall({
    contracts: [
      { address, abi: pyProbeAbi, functionName: 'SY' },
      { address, abi: pyProbeAbi, functionName: 'PT' },
      { address, abi: pyProbeAbi, functionName: 'YT' },
      { address, abi: expiryAbi, functionName: 'expiry' },
    ],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })
  const [syR, ptR, ytR, expiryR] = probe
  if (syR.status !== 'success') return null
  const syAddr = syR.result as Address

  let pt: Address
  let yt: Address
  if (ytR.status === 'success' && ptR.status !== 'success') {
    pt = address
    yt = ytR.result as Address
  } else if (ptR.status === 'success' && ytR.status !== 'success') {
    yt = address
    pt = ptR.result as Address
  } else {
    return null // an SY (ambiguous), a market, or not a Pendle token
  }

  if (expiryR.status !== 'success') {
    throw new Error('PT/YT expiry() unavailable — refusing to guess maturity state.')
  }
  const expiry = Number(expiryR.result)
  const isExpired = expiry > 0 ? expiry * 1000 <= Date.now() : false

  // SY info + PT/YT symbols.
  const r = await client.multicall({
    contracts: [
      { address: syAddr, abi: syReadAbi, functionName: 'name' },
      { address: syAddr, abi: syReadAbi, functionName: 'symbol' },
      { address: syAddr, abi: syReadAbi, functionName: 'decimals' },
      { address: syAddr, abi: syReadAbi, functionName: 'assetInfo' },
      { address: syAddr, abi: syReadAbi, functionName: 'exchangeRate' },
      { address: syAddr, abi: syReadAbi, functionName: 'getTokensIn' },
      { address: syAddr, abi: syReadAbi, functionName: 'getTokensOut' },
      { address: syAddr, abi: syReadAbi, functionName: 'yieldToken' },
      { address: pt, abi: erc20SymbolAbi, functionName: 'symbol' },
      { address: yt, abi: erc20SymbolAbi, functionName: 'symbol' },
    ],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })
  const [nameR, symR, decR, aInfoR, rateR, tInR, tOutR, yTokR, ptSymR, ytSymR] = r

  const syName = nameR.status === 'success' ? (nameR.result as string) : ''
  const sySymbol = symR.status === 'success' ? (symR.result as string) : 'SY'
  if (decR.status !== 'success') {
    throw new Error('SY decimals() unavailable — refusing to guess transaction units.')
  }
  const syDecimals = Number(decR.result)

  let assetType = 0
  let assetAddress: Address = ZERO_ADDRESS
  let assetDecimals = syDecimals
  if (aInfoR.status === 'success') {
    const [t, addr, dec] = aInfoR.result as readonly [number, Address, number]
    assetType = Number(t)
    assetAddress = addr
    assetDecimals = Number(dec)
  } else {
    throw new Error('SY assetInfo() unavailable — refusing to guess PT/YT transaction units.')
  }

  const exchangeRate = rateR.status === 'success' ? (rateR.result as bigint) : 10n ** 18n
  const tokensIn = tInR.status === 'success' ? [...(tInR.result as readonly Address[])] : []
  const tokensOut = tOutR.status === 'success' ? [...(tOutR.result as readonly Address[])] : []
  const yieldToken = yTokR.status === 'success' ? (yTokR.result as Address) : ZERO_ADDRESS
  const ptSymbol = ptSymR.status === 'success' ? (ptSymR.result as string) : 'PT'
  const ytSymbol = ytSymR.status === 'success' ? (ytSymR.result as string) : 'YT'

  let assetSymbol: string | undefined
  if (assetAddress !== ZERO_ADDRESS) {
    try {
      assetSymbol = await client.readContract({
        address: assetAddress,
        abi: erc20SymbolAbi,
        functionName: 'symbol',
      })
    } catch {
      assetSymbol = undefined
    }
  }

  const sy: SyInfo = {
    address: syAddr,
    name: syName,
    symbol: sySymbol,
    decimals: syDecimals,
    assetType,
    assetAddress,
    assetDecimals,
    assetSymbol,
    yieldToken,
    tokensIn,
    tokensOut,
    exchangeRate,
  }

  const base = (sySymbol || 'Token').replace(/^SY[-\s]?/i, '')
  const displayName = expiry > 0 ? `${base} · ${formatExpiryUtc(expiry)}` : base

  return {
    address, // the pasted token — used ONLY as a query key, never for tx routing
    pt,
    yt,
    sy,
    ptSymbol,
    ytSymbol,
    displayName,
    expiry,
    isExpired,
    factory: ZERO_ADDRESS,
    validated: false,
    vintage: 'unvalidated',
    state: EMPTY_STATE,
    metrics: EMPTY_METRICS,
    trust: EMPTY_TRUST,
    degraded: [],
  }
}
