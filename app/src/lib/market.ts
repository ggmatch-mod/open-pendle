/**
 * M1 market reader — pure viem functions (PLAN §3.2–3.4, M1).
 *
 * Framework-free, erasable TypeScript: the acceptance sweep imports this file
 * under `node --experimental-strip-types`, so imports use explicit `.ts`
 * extensions and there is no React/wagmi coupling here (that lives in
 * hooks.ts only).
 *
 * Every function takes a viem PublicClient. Reads go through explicit
 * `client.multicall` batches (with the canonical Multicall3 address passed
 * explicitly so the functions work on any client, chain-configured or not).
 */

import { getAddress, isAddress } from 'viem'
import type { Address, ContractFunctionParameters, Hex, PublicClient } from 'viem'
import type {
  AddressClassification,
  MarketMetrics,
  MarketSnapshot,
  MarketStateSnapshot,
  MarketValidation,
  SavedPool,
  SyInfo,
  TrustInfo,
  Vintage,
} from './types.ts'
import {
  FACTORY_GENERATIONS,
  MULTICALL3,
  PENDLE_GOVERNANCE,
  PENDLE_GOVERNANCE_MULTISIG,
  PENDLE_PROXY_ADMIN,
  ROUTER_V4,
} from './addresses.ts'
import {
  erc20SymbolAbi,
  factoryValidateAbi,
  marketReadAbi,
  pyProbeAbi,
  syReadAbi,
} from './pendleAbi.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
const EIP1967_IMPLEMENTATION_SLOT: Hex =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

/** EIP-1967 admin slot: keccak256("eip1967.proxy.admin") - 1. */
const EIP1967_ADMIN_SLOT: Hex =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

const SECONDS_PER_YEAR = 31536000

/** Addresses that count as "Pendle governance" for the trust panel. */
const PENDLE_GOVERNANCE_SET: readonly Address[] = [
  PENDLE_GOVERNANCE,
  PENDLE_GOVERNANCE_MULTISIG,
]

/** addresses.ts gen labels → the shared Vintage type ('V6' is the active generation). */
const VINTAGE_BY_GEN: Record<string, Vintage> = {
  v1: 'v1',
  V3: 'V3',
  V4: 'V4',
  V5: 'V5',
  V6: 'active',
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Extract the address packed into a 32-byte storage word (last 20 bytes). */
function addressFromWord(word: Hex): Address | undefined {
  const hex = word.replace(/^0x/, '').padStart(64, '0')
  const value = BigInt(`0x${hex}`)
  // Zero or a tiny sentinel value (observed 0x…01 in the wild on non-standard
  // proxy patterns) is not a real address — treat as "not identifiable" rather
  // than reporting a scary-looking NON-Pendle admin.
  if (value <= 0xffffn) return undefined
  return getAddress(`0x${hex.slice(24)}`)
}

/** "26 Sep 2024" — deterministic UTC date, locale-independent. */
export function formatExpiryUtc(expirySeconds: number): string {
  const d = new Date(expirySeconds * 1000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/**
 * Compose a display name. Pre-V6 vintages name their LP token just
 * "Pendle Market" — compose "<SY symbol sans SY- prefix> · <expiry>" instead.
 */
export function composeDisplayName(
  marketName: string | undefined,
  sySymbol: string,
  expirySeconds: number,
): string {
  if (marketName && marketName.trim() !== '' && marketName.trim() !== 'Pendle Market') {
    return marketName.trim()
  }
  const base = sySymbol.replace(/^SY[- ]/, '').trim() || sySymbol.trim() || 'Unknown SY'
  return `${base} · ${formatExpiryUtc(expirySeconds)}`
}

// ---------------------------------------------------------------------------
// validateMarket — the provenance gate (PLAN §3.4, F7)
// ---------------------------------------------------------------------------

/**
 * `isValidMarket(address)` OR-ed across the five factory generations.
 * Returns which factory validated the address and its vintage. Factories
 * return false (never revert) on junk input; individual factory call
 * failures are treated as "not validated by that factory".
 */
export async function validateMarket(
  client: PublicClient,
  address: Address,
): Promise<MarketValidation> {
  const results = await client.multicall({
    contracts: FACTORY_GENERATIONS.map((g) => ({
      address: g.marketFactory,
      abi: factoryValidateAbi,
      functionName: 'isValidMarket' as const,
      args: [address] as const,
    })),
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'success' && r.result === true) {
      const gen = FACTORY_GENERATIONS[i]
      return {
        isMarket: true,
        factory: gen.marketFactory,
        vintage: VINTAGE_BY_GEN[gen.gen] ?? 'active',
      }
    }
  }
  return { isMarket: false }
}

// ---------------------------------------------------------------------------
// classifyAddress — paste-input pipeline (M1 near-miss classifier)
// ---------------------------------------------------------------------------

/**
 * Classify arbitrary pasted input:
 *   format check → EOA check → factory validation → PT/YT/SY near-miss
 *   probes → market-shaped-but-unvalidated → plain contract.
 *
 * `resolvedMarket` stays undefined in M1 — resolving a PT/YT/SY back to its
 * market cheaply would need wide event scans (deliberately skipped).
 */
export async function classifyAddress(
  client: PublicClient,
  input: string,
): Promise<AddressClassification> {
  const raw = input.trim()
  if (!isAddress(raw, { strict: false })) {
    return {
      kind: 'invalid',
      message: 'Not a valid address — paste a 42-character 0x… hex address.',
    }
  }
  const address = getAddress(raw)

  const code = await client.getCode({ address })
  if (!code || code === '0x') {
    return {
      kind: 'eoa',
      message:
        'This address has no contract code (a wallet / EOA) — paste a Pendle market (PLP) address.',
    }
  }

  const validation = await validateMarket(client, address)
  if (validation.isMarket) {
    return {
      kind: 'market',
      message:
        validation.vintage === 'active'
          ? 'Validated Pendle market (active factory generation).'
          : `Validated Pendle market (legacy ${validation.vintage} factory — limited support).`,
      validation,
    }
  }

  // Near-miss probes, all in one batch. A PT exposes SY()+YT(), a YT exposes
  // SY()+PT(), an SY answers assetInfo().
  const probes = await client.multicall({
    contracts: [
      { address, abi: pyProbeAbi, functionName: 'SY' },
      { address, abi: pyProbeAbi, functionName: 'PT' },
      { address, abi: pyProbeAbi, functionName: 'YT' },
      { address, abi: syReadAbi, functionName: 'assetInfo' },
      { address, abi: erc20SymbolAbi, functionName: 'symbol' },
      { address, abi: marketReadAbi, functionName: 'readTokens' },
    ],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })
  const [syR, ptR, ytR, assetInfoR, symbolR, readTokensR] = probes
  const symbol =
    symbolR.status === 'success' && typeof symbolR.result === 'string'
      ? symbolR.result
      : undefined
  const symbolLabel = symbol ?? 'unknown symbol'

  if (syR.status === 'success' && ytR.status === 'success' && ptR.status !== 'success') {
    return {
      kind: 'pt',
      message: `This looks like a PT (${symbolLabel}) — paste the market (PLP) address instead.`,
      symbol,
    }
  }
  if (syR.status === 'success' && ptR.status === 'success' && ytR.status !== 'success') {
    return {
      kind: 'yt',
      message: `This looks like a YT (${symbolLabel}) — paste the market (PLP) address instead.`,
      symbol,
    }
  }
  if (assetInfoR.status === 'success') {
    return {
      kind: 'sy',
      message: `This looks like an SY (${symbolLabel}) — paste the market (PLP) address instead.`,
      symbol,
    }
  }
  if (readTokensR.status === 'success' && Array.isArray(readTokensR.result)) {
    // Market-shaped (answers readTokens()) but no known factory validates it:
    // either not a Pendle market, or a newer factory generation than this build.
    return {
      kind: 'contract',
      message:
        'Not validated by any known Pendle factory — either not a Pendle market, or this app build predates a newer factory generation. Do not interact unless you trust the source.',
      symbol,
      unvalidatedMarketShape: true,
    }
  }
  if (symbol) {
    return {
      kind: 'contract',
      message: `This is a contract (${symbol}) but not a Pendle market — paste the market (PLP) address.`,
      symbol,
    }
  }
  return {
    kind: 'contract',
    message: 'This contract does not look like a Pendle market, PT, YT or SY.',
  }
}

// ---------------------------------------------------------------------------
// loadMarketSnapshot — full pool read (M1 market reader)
// ---------------------------------------------------------------------------

/**
 * Load everything the pool page needs in a handful of batched rounds.
 *
 * Degradation contract: any individual probe failure (legacy vintages, exotic
 * SYs) appends a human-readable string to `degraded` and the load continues
 * with a sensible fallback. Only a failure of the core reads
 * (readTokens + readState + expiry) rejects the whole load.
 */
export async function loadMarketSnapshot(
  client: PublicClient,
  address: Address,
): Promise<MarketSnapshot> {
  const market = getAddress(address)
  const degraded: string[] = []

  // -- Round 1: core market reads + factory validation, in parallel ---------
  const [core, validation] = await Promise.all([
    client.multicall({
      contracts: [
        { address: market, abi: marketReadAbi, functionName: 'readTokens' },
        { address: market, abi: marketReadAbi, functionName: 'expiry' },
        { address: market, abi: marketReadAbi, functionName: 'isExpired' },
        // NOTE: no factory() read — the market's self-reported factory is
        // attacker-controlled and must never influence validated/vintage.
        { address: market, abi: marketReadAbi, functionName: 'name' },
        // ALWAYS the real router — fees are per-(market, router) overrides (F10).
        { address: market, abi: marketReadAbi, functionName: 'readState', args: [ROUTER_V4] },
      ],
      allowFailure: true,
      multicallAddress: MULTICALL3,
    }),
    validateMarket(client, market),
  ])
  const [tokensR, expiryR, isExpiredR, nameR, stateR] = core

  if (
    tokensR.status !== 'success' ||
    expiryR.status !== 'success' ||
    stateR.status !== 'success'
  ) {
    const failed = [
      tokensR.status !== 'success' ? 'readTokens()' : null,
      expiryR.status !== 'success' ? 'expiry()' : null,
      stateR.status !== 'success' ? 'readState(router)' : null,
    ]
      .filter((s) => s !== null)
      .join(', ')
    throw new Error(`Not readable as a Pendle market — core reads failed (${failed}) for ${market}`)
  }

  const [syAddr, ptAddr, ytAddr] = tokensR.result
  const expiry = Number(expiryR.result)
  const rawState = stateR.result
  const state: MarketStateSnapshot = {
    totalPt: rawState.totalPt,
    totalSy: rawState.totalSy,
    totalLp: rawState.totalLp,
    treasury: rawState.treasury,
    scalarRoot: rawState.scalarRoot,
    lnFeeRateRoot: rawState.lnFeeRateRoot,
    reserveFeePercent: rawState.reserveFeePercent,
    lastLnImpliedRate: rawState.lastLnImpliedRate,
  }

  let isExpired: boolean
  if (isExpiredR.status === 'success') {
    isExpired = isExpiredR.result
  } else {
    isExpired = expiry * 1000 <= Date.now()
    degraded.push('isExpired() unavailable — derived from expiry timestamp.')
  }

  const marketName = nameR.status === 'success' ? nameR.result : undefined
  if (nameR.status !== 'success') {
    degraded.push('market name() unavailable — display name composed from SY symbol.')
  }

  // Factory + vintage come ONLY from the validation gate (our own
  // isValidMarket calls against the 5 known factories). The market's
  // self-reported factory() is attacker-controlled — a fake market can claim
  // the real V6 factory address — so it must NEVER drive `vintage` or
  // `validated` (PLAN §3.4).
  let factory: Address
  let vintage: Vintage
  let validated: boolean
  if (validation.isMarket && validation.factory && validation.vintage) {
    validated = true
    factory = validation.factory
    vintage = validation.vintage
  } else {
    validated = false
    factory = ZERO_ADDRESS
    vintage = 'unvalidated'
    degraded.push('Not validated by any known Pendle factory')
  }

  // -- Round 2: SY reads + PT/YT symbols + SY trust probes -------------------
  const round2 = await client.multicall({
    contracts: [
      { address: syAddr, abi: syReadAbi, functionName: 'name' },
      { address: syAddr, abi: syReadAbi, functionName: 'symbol' },
      { address: syAddr, abi: syReadAbi, functionName: 'decimals' },
      { address: syAddr, abi: syReadAbi, functionName: 'assetInfo' },
      { address: syAddr, abi: syReadAbi, functionName: 'exchangeRate' },
      { address: syAddr, abi: syReadAbi, functionName: 'getTokensIn' },
      { address: syAddr, abi: syReadAbi, functionName: 'getTokensOut' },
      { address: syAddr, abi: syReadAbi, functionName: 'yieldToken' },
      { address: syAddr, abi: syReadAbi, functionName: 'owner' },
      { address: syAddr, abi: syReadAbi, functionName: 'paused' },
      { address: ptAddr, abi: erc20SymbolAbi, functionName: 'symbol' },
      { address: ytAddr, abi: erc20SymbolAbi, functionName: 'symbol' },
    ],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })
  const [
    syNameR, sySymbolR, syDecimalsR, assetInfoR, exchangeRateR,
    tokensInR, tokensOutR, yieldTokenR, ownerR, pausedR,
    ptSymbolR, ytSymbolR,
  ] = round2

  const syName = syNameR.status === 'success' ? syNameR.result : ''
  if (syNameR.status !== 'success') degraded.push('SY name() unavailable.')
  const sySymbol = sySymbolR.status === 'success' ? sySymbolR.result : ''
  if (sySymbolR.status !== 'success') degraded.push('SY symbol() unavailable.')
  const syDecimals = syDecimalsR.status === 'success' ? syDecimalsR.result : 18
  if (syDecimalsR.status !== 'success') degraded.push('SY decimals() unavailable — assuming 18.')

  let assetType = 0
  let assetAddress: Address = ZERO_ADDRESS
  let assetDecimals = syDecimals
  if (assetInfoR.status === 'success') {
    const [t, addr, dec] = assetInfoR.result
    assetType = t
    assetAddress = addr
    assetDecimals = dec
  } else {
    degraded.push('SY assetInfo() unavailable — asset-terms metrics use SY decimals.')
  }

  let exchangeRate = 10n ** 18n
  if (exchangeRateR.status === 'success') {
    exchangeRate = exchangeRateR.result
  } else {
    degraded.push('SY exchangeRate() unavailable (legacy SCY?) — assuming 1.0; asset-terms metrics are approximate.')
  }

  const tokensIn = tokensInR.status === 'success' ? [...tokensInR.result] : []
  if (tokensInR.status !== 'success') degraded.push('SY getTokensIn() unavailable.')
  const tokensOut = tokensOutR.status === 'success' ? [...tokensOutR.result] : []
  if (tokensOutR.status !== 'success') degraded.push('SY getTokensOut() unavailable.')
  const yieldToken = yieldTokenR.status === 'success' ? yieldTokenR.result : ZERO_ADDRESS
  if (yieldTokenR.status !== 'success') degraded.push('SY yieldToken() unavailable.')

  const ptSymbol = ptSymbolR.status === 'success' ? ptSymbolR.result : 'PT'
  if (ptSymbolR.status !== 'success') degraded.push('PT symbol() unavailable.')
  const ytSymbol = ytSymbolR.status === 'success' ? ytSymbolR.result : 'YT'
  if (ytSymbolR.status !== 'success') degraded.push('YT symbol() unavailable.')

  // -- Round 3: asset symbol + EIP-1967 proxy slots (individually try/caught)
  const [assetSymbol, implWord, adminWord] = await Promise.all([
    (async (): Promise<string | undefined> => {
      if (assetAddress === ZERO_ADDRESS) return undefined
      try {
        return await client.readContract({
          address: assetAddress,
          abi: erc20SymbolAbi,
          functionName: 'symbol',
        })
      } catch {
        // Exotic asset (or assetType with a non-ERC20 asset ref) — fine to skip.
        return undefined
      }
    })(),
    (async (): Promise<Hex | undefined> => {
      try {
        return await client.getStorageAt({ address: syAddr, slot: EIP1967_IMPLEMENTATION_SLOT })
      } catch {
        degraded.push('SY proxy probe (implementation slot) failed.')
        return undefined
      }
    })(),
    (async (): Promise<Hex | undefined> => {
      try {
        return await client.getStorageAt({ address: syAddr, slot: EIP1967_ADMIN_SLOT })
      } catch {
        degraded.push('SY proxy probe (admin slot) failed.')
        return undefined
      }
    })(),
  ])

  // -- Trust panel -----------------------------------------------------------
  const syOwner = ownerR.status === 'success' ? ownerR.result : undefined
  const syPaused = pausedR.status === 'success' ? pausedR.result : undefined
  const implAddress = implWord ? addressFromWord(implWord) : undefined
  const syProxyAdmin = adminWord ? addressFromWord(adminWord) : undefined
  const syIsProxy = implAddress !== undefined

  const notes: string[] = []
  let ownerIsPendleGovernance: boolean | undefined
  let ownerIsRenounced: boolean | undefined
  if (syOwner !== undefined) {
    ownerIsPendleGovernance = PENDLE_GOVERNANCE_SET.some((g) => sameAddress(g, syOwner))
    ownerIsRenounced = sameAddress(syOwner, ZERO_ADDRESS)
    if (ownerIsPendleGovernance) {
      notes.push('SY owner is Pendle governance (same trust profile as listed pools).')
    } else if (ownerIsRenounced) {
      notes.push('SY ownership is renounced (owner is the zero address) — no one can pause this SY.')
    } else {
      notes.push(`SY owner is ${syOwner} — NOT Pendle governance; the owner can pause the SY.`)
    }
  } else {
    notes.push('SY exposes no owner() — ownership unknown.')
  }
  if (syPaused === true) {
    notes.push('SY is currently PAUSED — deposits and redemptions will revert.')
  } else if (syPaused === false) {
    notes.push('SY is not paused.')
  } else {
    notes.push('SY exposes no paused() — pause state unknown.')
  }
  let adminIsPendleProxyAdmin: boolean | undefined
  if (syIsProxy) {
    if (syProxyAdmin !== undefined) {
      adminIsPendleProxyAdmin = sameAddress(syProxyAdmin, PENDLE_PROXY_ADMIN)
      if (adminIsPendleProxyAdmin) {
        notes.push("SY is an upgradeable proxy administered by Pendle's proxy admin.")
      } else {
        notes.push(
          `SY is an upgradeable proxy with a NON-Pendle admin (${syProxyAdmin}) — the admin can replace the SY's code.`,
        )
      }
    } else {
      notes.push(
        'SY is an upgradeable proxy (EIP-1967) but its admin is not identifiable from the standard admin slot (UUPS or non-standard pattern) — upgrade authority unknown.',
      )
    }
  } else if (implWord !== undefined) {
    notes.push('SY is not an EIP-1967 proxy (no implementation slot set).')
  }

  const trust: TrustInfo = {
    syOwner,
    syPaused,
    syIsProxy,
    syProxyAdmin,
    ownerIsPendleGovernance,
    ownerIsRenounced,
    adminIsPendleProxyAdmin,
    notes,
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

  const metrics = computeMetrics(state, expiry, isExpired, exchangeRate, assetDecimals, syDecimals)
  const displayName = composeDisplayName(marketName, sySymbol, expiry)

  return {
    address: market,
    pt: ptAddr,
    yt: ytAddr,
    sy,
    ptSymbol,
    ytSymbol,
    displayName,
    expiry,
    isExpired,
    factory,
    validated,
    vintage,
    state,
    metrics,
    trust,
    degraded,
  }
}

// ---------------------------------------------------------------------------
// Metrics (Number math — display only, PLAN F6)
// ---------------------------------------------------------------------------

/**
 * Shared APY/price/TVL core — computeMetrics (full snapshot) and the
 * home-grid registry sweep (sweepRegistryPools) both derive their numbers
 * from this one helper so they can never drift apart.
 */
export function computeCoreStats(params: {
  lastLnImpliedRate: bigint
  /** Unix seconds. */
  expiry: number
  isExpired: boolean
  totalPt: bigint
  totalSy: bigint
  /** EIP-5115 raw-unit rate: assetRaw = syRaw · rate / 1e18. */
  exchangeRate: bigint
  assetDecimals: number
}): { impliedApy: number; ptPriceAsset: number; syAssetRaw: bigint; tvlAsset: number } {
  const lnRate = Number(params.lastLnImpliedRate) / 1e18
  const impliedApy = Math.expm1(lnRate)
  const nowSeconds = Math.floor(Date.now() / 1000)
  const timeToExpiry = Math.max(0, params.expiry - nowSeconds)

  // PT price in accounting-asset terms: e^(−rate·T/year); exactly 1 at expiry.
  const ptPriceAsset =
    params.isExpired ? 1 : Math.exp((-lnRate * timeToExpiry) / SECONDS_PER_YEAR)

  // Asset value of the SY side in raw units (EIP-5115: sy · exchangeRate / 1e18).
  // PT decimals == asset decimals by factory construction.
  const syAssetRaw = (params.totalSy * params.exchangeRate) / 10n ** 18n
  const scale = 10 ** params.assetDecimals
  const tvlAsset =
    Number(syAssetRaw) / scale + (Number(params.totalPt) / scale) * ptPriceAsset

  return { impliedApy, ptPriceAsset, syAssetRaw, tvlAsset }
}

export function computeMetrics(
  state: MarketStateSnapshot,
  expiry: number,
  isExpired: boolean,
  exchangeRate: bigint,
  assetDecimals: number,
  syDecimals: number,
): MarketMetrics {
  const { impliedApy, ptPriceAsset, syAssetRaw, tvlAsset } = computeCoreStats({
    lastLnImpliedRate: state.lastLnImpliedRate,
    expiry,
    isExpired,
    totalPt: state.totalPt,
    totalSy: state.totalSy,
    exchangeRate,
    assetDecimals,
  })

  // PT price in SY terms (SY per 1 PT). The EIP-5115 exchangeRate is a
  // RAW-unit rate (assetRaw = syRaw · rate / 1e18), so the whole-unit
  // asset-per-SY price is rateFloat · 10^(syDecimals − assetDecimals) — the
  // bare rateFloat is only correct when syDecimals == assetDecimals.
  // Example: an 18-decimal share SY over a 6-decimal asset worth 1.05
  // asset/share has exchangeRate = 1.05e6 (rateFloat = 1.05e-12);
  // ptPriceSy = ptPriceAsset · 10^(6−18) / 1.05e-12 = ptPriceAsset / 1.05.
  const exchangeRateFloat = Number(exchangeRate) / 1e18
  const ptPriceSy =
    exchangeRateFloat > 0
      ? (ptPriceAsset * 10 ** (assetDecimals - syDecimals)) / exchangeRateFloat
      : ptPriceAsset
  const ytPriceAsset = 1 - ptPriceAsset

  const denominator = state.totalPt + syAssetRaw
  const ptProportion = denominator > 0n ? Number(state.totalPt) / Number(denominator) : 0

  const feeTier = Math.expm1(Number(state.lnFeeRateRoot) / 1e18)

  // Only meaningful while the pool is live: expired pools legitimately sit at
  // APY ≈ 0 / extreme proportions, which is not a tradable-range condition.
  const nearRangeEdge =
    !isExpired && (ptProportion > 0.93 || ptProportion < 0.03 || impliedApy < 0.001)

  return {
    impliedApy,
    ptPriceAsset,
    ptPriceSy,
    ytPriceAsset,
    tvlAsset,
    feeTier,
    ptProportion,
    nearRangeEdge,
  }
}

// ---------------------------------------------------------------------------
// Registry sweep — home-grid quick stats (PLAN §3.3 "one multicall sweep")
// ---------------------------------------------------------------------------

/** Vintage for a factory address WE previously validated (e.g. a SavedPool's cached factory). */
export function vintageFromFactory(factory: Address): Vintage | undefined {
  const gen = FACTORY_GENERATIONS.find((g) => sameAddress(g.marketFactory, factory))
  return gen ? VINTAGE_BY_GEN[gen.gen] : undefined
}

export interface RegistrySweepEntry {
  impliedApy: number
  /** Only present when the pool cached assetDecimals AND exchangeRate() read. */
  tvlAsset?: number
  isExpired: boolean
}

/** Keyed by lowercased market address. Missing key = that market's reads failed. */
export type RegistrySweepResult = Record<string, RegistrySweepEntry>

/**
 * ONE multicall batch across all saved markets: per market
 * readState(ROUTER_V4) + isExpired() + SY.exchangeRate() (SY address from the
 * SavedPool cache). Markets whose readState fails are absent from the result —
 * the card renders '—' rather than crashing. APY/TVL math is computeCoreStats,
 * the same formulas the full snapshot uses.
 */
export async function sweepRegistryPools(
  client: PublicClient,
  pools: readonly SavedPool[],
): Promise<RegistrySweepResult> {
  const out: RegistrySweepResult = {}
  if (pools.length === 0) return out

  // Heterogeneous dynamic batch → viem's documented loose typing
  // (ContractFunctionParameters[]); results are cast per call below.
  const contracts: ContractFunctionParameters[] = pools.flatMap((pool) => [
    {
      address: pool.market,
      abi: marketReadAbi,
      functionName: 'readState',
      args: [ROUTER_V4],
    },
    { address: pool.market, abi: marketReadAbi, functionName: 'isExpired' },
    { address: pool.sy, abi: syReadAbi, functionName: 'exchangeRate' },
  ])
  const results = await client.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i]
    const stateR = results[i * 3]
    const isExpiredR = results[i * 3 + 1]
    const exchangeRateR = results[i * 3 + 2]
    if (stateR.status !== 'success') continue

    const raw = stateR.result as {
      totalPt: bigint
      totalSy: bigint
      expiry: bigint
      lastLnImpliedRate: bigint
    }
    const expiry = Number(raw.expiry)
    const isExpired =
      isExpiredR.status === 'success'
        ? (isExpiredR.result as boolean)
        : expiry * 1000 <= Date.now()
    const exchangeRate =
      exchangeRateR.status === 'success' ? (exchangeRateR.result as bigint) : undefined

    const hasTvlInputs = pool.assetDecimals !== undefined && exchangeRate !== undefined
    const core = computeCoreStats({
      lastLnImpliedRate: raw.lastLnImpliedRate,
      expiry,
      isExpired,
      totalPt: raw.totalPt,
      totalSy: raw.totalSy,
      exchangeRate: exchangeRate ?? 10n ** 18n,
      assetDecimals: pool.assetDecimals ?? 18,
    })

    out[pool.market.toLowerCase()] = {
      impliedApy: core.impliedApy,
      ...(hasTvlInputs ? { tvlAsset: core.tvlAsset } : {}),
      isExpired,
    }
  }
  return out
}
