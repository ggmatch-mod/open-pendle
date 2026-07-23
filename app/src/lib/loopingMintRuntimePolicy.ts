import type { Hex } from 'viem'

export const LOOPING_MINT_RUNTIME_POLICY_PATH =
  '/looping-mint-execution-policy.v1.json' as const
export const LOOPING_MINT_RUNTIME_POLICY_SCHEMA =
  'openpendle.looping-mint-execution-policy.v1' as const
export const LOOPING_MINT_RUNTIME_POLICY_TIMEOUT_MS = 4_000
export const LOOPING_MINT_RUNTIME_POLICY_MAX_VALIDITY_MS =
  7 * 24 * 60 * 60 * 1_000
export const LOOPING_MINT_RUNTIME_POLICY_MIN_REMAINING_MS = 30_000
export const LOOPING_MINT_RUNTIME_POLICY_MAX_MARKETS = 32

export type LoopingMintRuntimeAction = 'entry' | 'increase'

export interface LoopingMintRuntimeMarket {
  chainId: number
  morphoMarketId: Hex
}

export interface LoopingMintRuntimeCapability {
  enabled: boolean
  validUntil: string | null
  markets: readonly Readonly<LoopingMintRuntimeMarket>[]
}

export interface LoopingMintRuntimePolicy {
  schema: typeof LOOPING_MINT_RUNTIME_POLICY_SCHEMA
  revision: number
  mint: Readonly<{
    entry: Readonly<LoopingMintRuntimeCapability>
    increase: Readonly<LoopingMintRuntimeCapability>
  }>
}

type LoopingMintPolicyFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

let policyRequestSequence = 0

export class LoopingMintRuntimePolicyError extends Error {
  readonly code: 'RUNTIME_MINT_POLICY'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LoopingMintRuntimePolicyError'
    this.code = 'RUNTIME_MINT_POLICY'
  }
}

function fail(message: string, cause?: unknown): never {
  throw new LoopingMintRuntimePolicyError(
    message,
    cause === undefined ? undefined : { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(record).sort()
  const expected = [...expectedKeys].sort()
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
}

function invalidPolicy(): never {
  fail('The live looping Mint policy is invalid, so Mint Mode is paused.')
}

function parseRuntimeMarket(value: unknown): Readonly<LoopingMintRuntimeMarket> {
  if (!isRecord(value) || !hasExactKeys(value, ['chainId', 'morphoMarketId'])) {
    invalidPolicy()
  }
  if (
    !Number.isSafeInteger(value.chainId) ||
    Number(value.chainId) <= 0 ||
    typeof value.morphoMarketId !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.morphoMarketId)
  ) {
    invalidPolicy()
  }
  return Object.freeze({
    chainId: value.chainId as number,
    morphoMarketId: value.morphoMarketId.toLowerCase() as Hex,
  })
}

function parseCapability(
  value: unknown,
  now: number,
): Readonly<LoopingMintRuntimeCapability> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['enabled', 'validUntil', 'markets']) ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.markets) ||
    value.markets.length > LOOPING_MINT_RUNTIME_POLICY_MAX_MARKETS
  ) {
    invalidPolicy()
  }
  const markets = value.markets.map(parseRuntimeMarket)
  const uniqueMarkets = new Set(
    markets.map((market) =>
      `${market.chainId}:${market.morphoMarketId.toLowerCase()}`),
  )
  if (uniqueMarkets.size !== markets.length) invalidPolicy()

  if (!value.enabled) {
    if (value.validUntil !== null || markets.length !== 0) invalidPolicy()
  } else {
    if (
      typeof value.validUntil !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
        value.validUntil,
      ) ||
      markets.length === 0
    ) {
      invalidPolicy()
    }
    const validUntilMs = Date.parse(value.validUntil)
    if (
      !Number.isFinite(validUntilMs) ||
      validUntilMs - now < LOOPING_MINT_RUNTIME_POLICY_MIN_REMAINING_MS ||
      validUntilMs - now > LOOPING_MINT_RUNTIME_POLICY_MAX_VALIDITY_MS
    ) {
      fail('The live looping Mint policy is expired or too long-lived, so Mint Mode is paused.')
    }
  }

  return Object.freeze({
    enabled: value.enabled,
    validUntil: value.validUntil as string | null,
    markets: Object.freeze(markets),
  })
}

function parseRuntimePolicy(
  value: unknown,
  now: number,
): Readonly<LoopingMintRuntimePolicy> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schema', 'revision', 'mint']) ||
    value.schema !== LOOPING_MINT_RUNTIME_POLICY_SCHEMA ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !isRecord(value.mint) ||
    !hasExactKeys(value.mint, ['entry', 'increase'])
  ) {
    invalidPolicy()
  }
  return Object.freeze({
    schema: LOOPING_MINT_RUNTIME_POLICY_SCHEMA,
    revision: value.revision as number,
    mint: Object.freeze({
      entry: parseCapability(value.mint.entry, now),
      increase: parseCapability(value.mint.increase, now),
    }),
  })
}

function browserOrigin(): string {
  if (typeof globalThis.location?.origin !== 'string') {
    fail('The live looping Mint policy is unavailable, so Mint Mode is paused.')
  }
  return globalThis.location.origin
}

function actionLabel(action: LoopingMintRuntimeAction): string {
  return action === 'entry' ? 'entry' : 'leverage increase'
}

/**
 * Fetch the independent same-origin Mint capability immediately before signing
 * and again before submission. Market Mode never depends on this policy.
 */
export async function assertLoopingMintRuntimeActionEnabled({
  action,
  chainId,
  marketId,
  origin = browserOrigin(),
  fetchPolicy = globalThis.fetch?.bind(globalThis),
  clock = Date.now,
  timeoutMs = LOOPING_MINT_RUNTIME_POLICY_TIMEOUT_MS,
}: {
  action: LoopingMintRuntimeAction
  chainId: number
  marketId: Hex
  origin?: string
  fetchPolicy?: LoopingMintPolicyFetch
  clock?: () => number
  timeoutMs?: number
}): Promise<Readonly<LoopingMintRuntimePolicy>> {
  if (
    (action !== 'entry' && action !== 'increase') ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(marketId)
  ) {
    fail('The requested looping Mint capability is invalid, so Mint Mode is paused.')
  }
  if (fetchPolicy === undefined) {
    fail('The live looping Mint policy is unavailable, so Mint Mode is paused.')
  }

  let expectedOrigin: URL
  try {
    expectedOrigin = new URL(origin)
  } catch (error) {
    fail('The live looping Mint policy is unavailable, so Mint Mode is paused.', error)
  }

  let requestStartedAt: number
  try {
    requestStartedAt = clock()
  } catch (error) {
    fail('The live looping Mint policy is unavailable, so Mint Mode is paused.', error)
  }
  if (
    !Number.isSafeInteger(requestStartedAt) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > LOOPING_MINT_RUNTIME_POLICY_TIMEOUT_MS
  ) {
    fail('The live looping Mint policy is unavailable, so Mint Mode is paused.')
  }

  const policyUrl = new URL(LOOPING_MINT_RUNTIME_POLICY_PATH, expectedOrigin)
  policyRequestSequence = (policyRequestSequence + 1) % Number.MAX_SAFE_INTEGER
  policyUrl.searchParams.set(
    'check',
    `${requestStartedAt.toString(36)}-${policyRequestSequence.toString(36)}`,
  )
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchPolicy(policyUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    if (response.status !== 200 || response.redirected || response.url === '') {
      invalidPolicy()
    }
    const responseUrl = new URL(response.url)
    if (
      responseUrl.origin !== policyUrl.origin ||
      responseUrl.pathname !== policyUrl.pathname ||
      responseUrl.search !== policyUrl.search
    ) {
      invalidPolicy()
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      invalidPolicy()
    }
    const body = await response.text()
    if (body.length === 0 || body.length > 8_192) invalidPolicy()

    let decoded: unknown
    try {
      decoded = JSON.parse(body)
    } catch (error) {
      fail('The live looping Mint policy is invalid, so Mint Mode is paused.', error)
    }

    let checkedAt: number
    try {
      checkedAt = clock()
    } catch (error) {
      fail('The live looping Mint policy is unavailable, so Mint Mode is paused.', error)
    }
    if (!Number.isSafeInteger(checkedAt) || checkedAt < requestStartedAt) {
      fail('The live looping Mint policy is unavailable, so Mint Mode is paused.')
    }

    const policy = parseRuntimePolicy(decoded, checkedAt)
    const capability = policy.mint[action]
    if (!capability.enabled) {
      fail(`Looping Mint ${actionLabel(action)} is currently paused by OpenPendle.`)
    }
    const marketEnabled = capability.markets.some((market) =>
      market.chainId === chainId &&
      market.morphoMarketId.toLowerCase() === marketId.toLowerCase())
    if (!marketEnabled) {
      fail(
        `The live looping Mint policy does not cover this market for ${actionLabel(action)}.`,
      )
    }
    return policy
  } catch (error) {
    if (error instanceof LoopingMintRuntimePolicyError) throw error
    fail('The live looping Mint policy could not be verified, so Mint Mode is paused.', error)
  } finally {
    clearTimeout(timeoutId)
  }
}
