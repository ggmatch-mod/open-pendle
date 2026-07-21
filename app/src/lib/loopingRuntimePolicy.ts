import type { Hex } from 'viem'

export const LOOPING_RUNTIME_ENTRY_POLICY_PATH =
  '/looping-execution-policy.v1.json' as const
export const LOOPING_RUNTIME_ENTRY_POLICY_SCHEMA =
  'openpendle.looping-execution-policy.v1' as const
export const LOOPING_RUNTIME_ENTRY_POLICY_TIMEOUT_MS = 4_000
export const LOOPING_RUNTIME_ENTRY_POLICY_MAX_VALIDITY_MS =
  7 * 24 * 60 * 60 * 1_000
export const LOOPING_RUNTIME_ENTRY_POLICY_MIN_REMAINING_MS = 30_000
export const LOOPING_RUNTIME_ENTRY_POLICY_MAX_MARKETS = 32

interface LoopingRuntimeEntryMarket {
  chainId: number
  morphoMarketId: Hex
}

interface LoopingRuntimeEntryPolicy {
  schema: typeof LOOPING_RUNTIME_ENTRY_POLICY_SCHEMA
  revision: number
  entry: {
    enabled: boolean
    validUntil: string | null
    markets: readonly LoopingRuntimeEntryMarket[]
  }
}

type LoopingPolicyFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

let policyRequestSequence = 0

export class LoopingRuntimePolicyError extends Error {
  readonly code: 'RUNTIME_ENTRY_POLICY'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LoopingRuntimePolicyError'
    this.code = 'RUNTIME_ENTRY_POLICY'
  }
}

function fail(message: string, cause?: unknown): never {
  throw new LoopingRuntimePolicyError(
    message,
    cause === undefined ? undefined : { cause },
  )
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseRuntimeEntryMarket(value: unknown): LoopingRuntimeEntryMarket {
  if (!isRecord(value) || !hasExactKeys(value, ['chainId', 'morphoMarketId'])) {
    fail('The live looping entry policy is invalid, so new-loop entry is paused.')
  }
  if (
    !Number.isSafeInteger(value.chainId) ||
    typeof value.morphoMarketId !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.morphoMarketId)
  ) {
    fail('The live looping entry policy is invalid, so new-loop entry is paused.')
  }
  return Object.freeze({
    chainId: value.chainId as number,
    morphoMarketId: value.morphoMarketId as Hex,
  })
}

function parseRuntimeEntryPolicy(
  value: unknown,
  now: number,
): LoopingRuntimeEntryPolicy {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'revision', 'entry'])) {
    fail('The live looping entry policy is invalid, so new-loop entry is paused.')
  }
  if (
    value.schema !== LOOPING_RUNTIME_ENTRY_POLICY_SCHEMA ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !isRecord(value.entry) ||
    !hasExactKeys(value.entry, ['enabled', 'validUntil', 'markets']) ||
    typeof value.entry.enabled !== 'boolean' ||
    !Array.isArray(value.entry.markets) ||
    value.entry.markets.length > LOOPING_RUNTIME_ENTRY_POLICY_MAX_MARKETS
  ) {
    fail('The live looping entry policy is invalid, so new-loop entry is paused.')
  }
  const markets = value.entry.markets.map(parseRuntimeEntryMarket)
  const uniqueMarkets = new Set(
    markets.map((market) =>
      `${market.chainId}:${market.morphoMarketId.toLowerCase()}`),
  )
  if (uniqueMarkets.size !== markets.length) {
    fail('The live looping entry policy is invalid, so new-loop entry is paused.')
  }

  if (!value.entry.enabled) {
    if (value.entry.validUntil !== null || markets.length !== 0) {
      fail('The live looping entry policy is invalid, so new-loop entry is paused.')
    }
  } else {
    if (
      typeof value.entry.validUntil !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
        value.entry.validUntil,
      ) ||
      markets.length === 0
    ) {
      fail('The live looping entry policy is invalid, so new-loop entry is paused.')
    }
    const validUntilMs = Date.parse(value.entry.validUntil)
    if (
      !Number.isFinite(validUntilMs) ||
      validUntilMs - now < LOOPING_RUNTIME_ENTRY_POLICY_MIN_REMAINING_MS ||
      validUntilMs - now > LOOPING_RUNTIME_ENTRY_POLICY_MAX_VALIDITY_MS
    ) {
      fail('The live looping entry policy is expired or too long-lived, so entry is paused.')
    }
  }

  return Object.freeze({
    schema: LOOPING_RUNTIME_ENTRY_POLICY_SCHEMA,
    revision: value.revision as number,
    entry: Object.freeze({
      enabled: value.entry.enabled,
      validUntil: value.entry.validUntil as string | null,
      markets: Object.freeze(markets),
    }),
  })
}

function browserOrigin(): string {
  if (typeof globalThis.location?.origin !== 'string') {
    fail('The live looping entry policy is unavailable, so new-loop entry is paused.')
  }
  return globalThis.location.origin
}

/**
 * Fetch the same-origin, non-cached emergency entry policy.
 *
 * This is an extra launch-control layer, not a replacement for the compiler,
 * simulation, market allowlist, build flag, or wallet prompt. Any network,
 * HTTP, redirect, content-type, schema, expiry, or scope failure pauses new
 * entry. Full exit and recovery do not call this function.
 */
export async function assertLoopingRuntimeEntryEnabled({
  chainId,
  marketId,
  origin = browserOrigin(),
  fetchPolicy = globalThis.fetch?.bind(globalThis),
  clock = Date.now,
  timeoutMs = LOOPING_RUNTIME_ENTRY_POLICY_TIMEOUT_MS,
}: {
  chainId: number
  marketId: Hex
  origin?: string
  fetchPolicy?: LoopingPolicyFetch
  clock?: () => number
  timeoutMs?: number
}): Promise<Readonly<LoopingRuntimeEntryPolicy>> {
  if (fetchPolicy === undefined) {
    fail('The live looping entry policy is unavailable, so new-loop entry is paused.')
  }
  let expectedOrigin: URL
  try {
    expectedOrigin = new URL(origin)
  } catch (error) {
    fail('The live looping entry policy is unavailable, so new-loop entry is paused.', error)
  }
  let requestStartedAt: number
  try {
    requestStartedAt = clock()
  } catch (error) {
    fail('The live looping entry policy is unavailable, so new-loop entry is paused.', error)
  }
  if (
    !Number.isSafeInteger(requestStartedAt) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > LOOPING_RUNTIME_ENTRY_POLICY_TIMEOUT_MS
  ) {
    fail('The live looping entry policy is unavailable, so new-loop entry is paused.')
  }
  const policyUrl = new URL(LOOPING_RUNTIME_ENTRY_POLICY_PATH, expectedOrigin)
  policyRequestSequence = (policyRequestSequence + 1) % Number.MAX_SAFE_INTEGER
  policyUrl.searchParams.set(
    'check',
    `${requestStartedAt.toString(36)}-${policyRequestSequence.toString(36)}`,
  )
  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(),
    timeoutMs,
  )

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
    if (response.status !== 200) {
      fail('The live looping entry policy is unavailable, so new-loop entry is paused.')
    }
    if (response.redirected || response.url === '') {
      fail('The live looping entry policy is invalid, so new-loop entry is paused.')
    }
    const responseUrl = new URL(response.url)
    if (
      responseUrl.origin !== policyUrl.origin ||
      responseUrl.pathname !== policyUrl.pathname ||
      responseUrl.search !== policyUrl.search
    ) {
      fail('The live looping entry policy is invalid, so new-loop entry is paused.')
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      fail('The live looping entry policy is invalid, so new-loop entry is paused.')
    }
    const body = await response.text()
    if (body.length === 0 || body.length > 4_096) {
      fail('The live looping entry policy is invalid, so new-loop entry is paused.')
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(body)
    } catch (error) {
      fail('The live looping entry policy is invalid, so new-loop entry is paused.', error)
    }
    let checkedAt: number
    try {
      checkedAt = clock()
    } catch (error) {
      fail('The live looping entry policy is unavailable, so new-loop entry is paused.', error)
    }
    if (!Number.isSafeInteger(checkedAt) || checkedAt < requestStartedAt) {
      fail('The live looping entry policy is unavailable, so new-loop entry is paused.')
    }
    const policy = parseRuntimeEntryPolicy(decoded, checkedAt)
    if (!policy.entry.enabled) {
      fail('New-loop entry is currently paused by OpenPendle.')
    }
    const marketEnabled = policy.entry.markets.some((market) =>
      market.chainId === chainId &&
      market.morphoMarketId.toLowerCase() === marketId.toLowerCase())
    if (!marketEnabled) {
      fail('The live looping entry policy does not cover this market, so entry is paused.')
    }
    return policy
  } catch (error) {
    if (error instanceof LoopingRuntimePolicyError) throw error
    fail('The live looping entry policy could not be verified, so new-loop entry is paused.', error)
  } finally {
    clearTimeout(timeoutId)
  }
}
