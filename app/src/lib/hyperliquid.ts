/**
 * Read-only Hyperliquid position discovery for the Boros hedge surface.
 *
 * Hyperliquid's info endpoint is public and keyed by the user's 0x address, so
 * connecting a wallet is enough to discover positions. No signature, API
 * wallet, or Hyperliquid trading permission is requested here.
 */

export const HYPERLIQUID_INFO_ENDPOINT = 'https://api.hyperliquid.xyz/info'

const REQUEST_TIMEOUT_MS = 15_000
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

type JsonRecord = Record<string, unknown>

export interface HyperliquidBtcPosition {
  id: string
  accountAddress: string
  accountLabel: string
  accountKind: 'main' | 'subaccount'
  direction: 'long' | 'short'
  sizeBtc: number
  sizeBtcText: string
  notionalUsd: number
  notionalUsdText: string
  entryPrice: number | null
  liquidationPrice: number | null
  leverage: number | null
  leverageType: string | null
  marginUsedUsd: number | null
  unrealizedPnlUsd: number | null
  fundingSinceOpenUsd: number | null
}

export interface HyperliquidPositionSnapshot {
  rootAddress: string
  positions: HyperliquidBtcPosition[]
  accountCount: number
  oraclePrice: number
  sourceTimestamp: number | null
  fetchedAt: number
}

interface HyperliquidFetchOptions {
  fetcher?: typeof fetch
  endpoint?: string
  signal?: AbortSignal
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function textNumber(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  return text !== '' && Number.isFinite(Number(text)) ? text : null
}

function optionalFinite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  return finiteNumber(value)
}

function accountSourceTimestamp(value: unknown): number | null {
  const timestamp = optionalFinite(record(value)?.time)
  return timestamp !== null && Number.isSafeInteger(timestamp) && timestamp > 0
    ? timestamp
    : null
}

export function normalizeHyperliquidAddress(address: string): string {
  const normalized = address.trim().toLowerCase()
  if (!ADDRESS_PATTERN.test(normalized)) {
    throw new Error('A valid 0x wallet address is required')
  }
  return normalized
}

function parseBtcPositions(
  stateValue: unknown,
  accountAddress: string,
  accountLabel: string,
  accountKind: HyperliquidBtcPosition['accountKind'],
  oraclePrice: number,
): HyperliquidBtcPosition[] {
  const state = record(stateValue)
  if (state === null || !Array.isArray(state.assetPositions)) {
    throw new Error(`Hyperliquid returned an invalid ${accountLabel} account state`)
  }

  const positions: HyperliquidBtcPosition[] = []
  for (const assetPositionValue of state.assetPositions) {
    const assetPosition = record(assetPositionValue)
    const position = record(assetPosition?.position)
    if (position?.coin !== 'BTC') continue

    const sizeText = textNumber(position.szi)
    if (sizeText === null) {
      throw new Error(`Hyperliquid returned an invalid BTC size for ${accountLabel}`)
    }
    const signedSize = Number(sizeText)
    if (signedSize === 0) continue

    // Hyperliquid funding is charged against oracle price, not mark or entry
    // price. Use the current BTC oracle for USD-collateral Boros sizing.
    const notional = Math.abs(signedSize) * oraclePrice
    const notionalText = notional.toFixed(8)

    const leverage = record(position.leverage)
    const cumulativeFunding = record(position.cumFunding)
    const normalizedAccount = normalizeHyperliquidAddress(accountAddress)
    positions.push({
      id: `${normalizedAccount}:BTC`,
      accountAddress: normalizedAccount,
      accountLabel,
      accountKind,
      direction: signedSize > 0 ? 'long' : 'short',
      sizeBtc: Math.abs(signedSize),
      sizeBtcText: sizeText.replace(/^-/, ''),
      notionalUsd: notional,
      notionalUsdText: notionalText.replace(/^-/, ''),
      entryPrice: optionalFinite(position.entryPx),
      liquidationPrice: optionalFinite(position.liquidationPx),
      leverage: optionalFinite(leverage?.value),
      leverageType: typeof leverage?.type === 'string' ? leverage.type : null,
      marginUsedUsd: optionalFinite(position.marginUsed),
      unrealizedPnlUsd: optionalFinite(position.unrealizedPnl),
      fundingSinceOpenUsd: optionalFinite(cumulativeFunding?.sinceOpen),
    })
  }
  return positions
}

function parseBtcOraclePrice(value: unknown): number {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('Hyperliquid returned invalid BTC market context')
  }
  const meta = record(value[0])
  const contexts = value[1]
  if (!Array.isArray(meta?.universe) || !Array.isArray(contexts)) {
    throw new Error('Hyperliquid returned invalid BTC market context')
  }
  const index = meta.universe.findIndex((item) => record(item)?.name === 'BTC')
  const context = index >= 0 ? record(contexts[index]) : null
  const oraclePrice = finiteNumber(context?.oraclePx)
  if (oraclePrice === null || oraclePrice <= 0) {
    throw new Error('Hyperliquid BTC oracle price is unavailable')
  }
  return oraclePrice
}

interface ResolvedHyperliquidUser {
  rootAddress: string
  role: 'user' | 'subaccount' | 'missing'
}

function resolveHyperliquidUser(address: string, value: unknown): ResolvedHyperliquidUser {
  const roleResponse = record(value)
  const role = roleResponse?.role
  const data = record(roleResponse?.data)
  if (role === 'user') return { rootAddress: address, role: 'user' }
  if (role === 'agent') {
    if (typeof data?.user !== 'string') throw new Error('Hyperliquid returned an invalid agent role')
    return { rootAddress: normalizeHyperliquidAddress(data.user), role: 'user' }
  }
  if (role === 'subAccount') {
    if (typeof data?.master !== 'string') {
      throw new Error('Hyperliquid returned an invalid subaccount role')
    }
    return { rootAddress: normalizeHyperliquidAddress(data.master), role: 'subaccount' }
  }
  if (role === 'missing') return { rootAddress: address, role: 'missing' }
  if (role === 'vault') {
    throw new Error('Hyperliquid vault exposure is not supported by automatic hedging yet')
  }
  throw new Error('Hyperliquid returned an unknown wallet role')
}

async function requestInfo(
  body: JsonRecord,
  options: HyperliquidFetchOptions,
): Promise<unknown> {
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation is available')
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('Hyperliquid request was aborted')
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new Error('Hyperliquid request timed out')),
    REQUEST_TIMEOUT_MS,
  )

  try {
    const response = await fetcher(options.endpoint ?? HYPERLIQUID_INFO_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Hyperliquid position request failed (${response.status})`)
    }
    return await response.json()
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Discover BTC positions on the main account and every returned subaccount. */
export async function fetchHyperliquidBtcPositions(
  address: string,
  options: HyperliquidFetchOptions = {},
): Promise<HyperliquidPositionSnapshot> {
  const connectedAddress = normalizeHyperliquidAddress(address)
  const resolved = resolveHyperliquidUser(
    connectedAddress,
    await requestInfo({ type: 'userRole', user: connectedAddress }, options),
  )
  if (resolved.role === 'missing') {
    return {
      rootAddress: resolved.rootAddress,
      positions: [],
      accountCount: 0,
      oraclePrice: 0,
      sourceTimestamp: null,
      fetchedAt: Date.now(),
    }
  }

  const rootAddress = resolved.rootAddress
  const [mainState, subaccountsValue, marketContext] = await Promise.all([
    requestInfo({ type: 'clearinghouseState', user: rootAddress }, options),
    requestInfo({ type: 'subAccounts', user: rootAddress }, options),
    requestInfo({ type: 'metaAndAssetCtxs', dex: '' }, options),
  ])
  const oraclePrice = parseBtcOraclePrice(marketContext)

  const positions = parseBtcPositions(
    mainState,
    rootAddress,
    'Main account',
    'main',
    oraclePrice,
  )
  let accountCount = 1
  let sourceTimestamp = accountSourceTimestamp(mainState)

  if (subaccountsValue !== null && !Array.isArray(subaccountsValue)) {
    throw new Error('Hyperliquid returned an invalid subaccount list')
  }

  for (const [index, value] of (subaccountsValue ?? []).entries()) {
    const subaccount = record(value)
    const subaccountAddress = typeof subaccount?.subAccountUser === 'string'
      ? subaccount.subAccountUser
      : null
    const clearinghouseState = subaccount?.clearinghouseState
    if (subaccountAddress === null || record(clearinghouseState) === null) {
      throw new Error('Hyperliquid returned an invalid subaccount')
    }
    const name = typeof subaccount?.name === 'string' && subaccount.name.trim()
      ? subaccount.name.trim()
      : `Subaccount ${index + 1}`
    positions.push(...parseBtcPositions(
      clearinghouseState,
      subaccountAddress,
      name,
      'subaccount',
      oraclePrice,
    ))
    accountCount += 1
    const timestamp = accountSourceTimestamp(clearinghouseState)
    // Every scanned account is needed to establish the current BTC exposure.
    // A fresh main account cannot make an old or undated subaccount current.
    sourceTimestamp = sourceTimestamp === null || timestamp === null
      ? null
      : Math.min(sourceTimestamp, timestamp)
  }

  positions.sort((a, b) => b.notionalUsd - a.notionalUsd)
  return {
    rootAddress,
    positions,
    accountCount,
    oraclePrice,
    sourceTimestamp,
    fetchedAt: Date.now(),
  }
}
