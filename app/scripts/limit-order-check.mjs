#!/usr/bin/env node
/**
 * Network-free security checks for src/lib/limitOrders.ts.
 *
 * Run from app/:
 *   node --experimental-strip-types scripts/limit-order-check.mjs
 *
 * Every HTTP call uses an injected fetch stub. This script never reads a key,
 * signs an order, or contacts Pendle's live API.
 */

import assert from 'node:assert/strict'
import {
  LIMIT_ORDER_SALT_DIVISOR,
  PT_FOR_TOKEN,
  TOKEN_FOR_PT,
  LimitOrderApiError,
  LimitOrderValidationError,
  apyFromLnImpliedRate,
  buildCancelAllLimitOrdersPlan,
  buildCancelBatchLimitOrdersPlan,
  buildCancelSingleLimitOrderPlan,
  buildLimitOrderTypedData,
  createGenerateLimitOrderRequest,
  createLimitOrderDto,
  fetchLimitOrderBook,
  fetchLimitOrderSupport,
  fetchMakerLimitOrders,
  generateLimitOrderData,
  hashLimitOrder,
  hashLimitOrderDomain,
  isAmbiguousSubmissionHttpStatus,
  parseGeneratedLimitOrder,
  parseLimitOrderBook,
  parseLimitOrderRecord,
  parseLimitOrderSupport,
  parseMakerLimitOrdersResponse,
  reconcileLimitOrderSubmission,
  submitLimitOrder,
  validateGeneratedLimitOrder,
  validateLimitOrderRecordAgainstDto,
  validatePtSyLimitOrderIntent,
  validateSupportForPtSy,
} from '../src/lib/limitOrders.ts'

const CHAIN_ID = 42161
const MARKET = '0x46f545683d8494ef4c54b7ea40ca762c620846ef'
const YT = '0x82533d15d76f498de4f50858f9a86ad3b22c752d'
const SY = '0x5edcbc20cac67adc2e724d4348ff85132b085b82'
const PT = '0xfaf260b16d3fa1609c74799089ad3cedfcd703fc'
const MAKER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const OTHER_HASH = `0x${'22'.repeat(32)}`
const LIMIT_ROUTER = '0x000000000000c9B3E2C3Ec88B1B4c0cD853f4321'
const NOW = 1_900_000_000n
const ORDER_EXPIRY = 2_000_000_000n
const MARKET_EXPIRY = 2_100_000_000n
const MAKING_AMOUNT = 1_000_000_000_000_000_000n
const IMPLIED_APY = 0.08
const LN_IMPLIED_RATE = 76_961_041_136_128_320n
const SALT = LIMIT_ORDER_SALT_DIVISOR * 12_345n
const SIGNATURE = `0x${'11'.repeat(65)}`
const EXPECTED_DOMAIN_HASH = '0xc53aa7bb89179896388dff123cb7a3240aaf666fd12bd860043b254054594617'
const EXPECTED_ORDER_HASH = '0x8810ae3d35ce64e343a7fcee211d95941456786248337a541877b95fa6166fe2'

const SUPPORT_JSON = {
  id: `${CHAIN_ID}-${YT}`,
  chainId: CHAIN_ID,
  yt: YT,
  market: MARKET,
  sy: SY,
  name: 'USDai USD.ai',
  tokenIns: [SY],
  tokenOuts: [SY],
  lnFeeRateRoot: '1860697815230763',
}

const GENERATED_JSON = {
  chainId: CHAIN_ID,
  YT,
  salt: SALT.toString(),
  expiry: ORDER_EXPIRY.toString(),
  nonce: '7',
  token: SY,
  orderType: TOKEN_FOR_PT,
  // Live direct-SY PT_FOR_TOKEN records currently use 0.9e18. The router
  // bypasses this conversion guard when token === SY, so it must round-trip.
  failSafeRate: '900000000000000000',
  maker: MAKER,
  receiver: MAKER,
  makingAmount: MAKING_AMOUNT.toString(),
  permit: '0x',
  lnImpliedRate: LN_IMPLIED_RATE.toString(),
}

const INTENT = {
  chainId: CHAIN_ID,
  market: MARKET,
  yt: YT,
  sy: SY,
  maker: MAKER,
  token: SY,
  orderType: TOKEN_FOR_PT,
  makingAmount: MAKING_AMOUNT,
  impliedApy: IMPLIED_APY,
  expiry: ORDER_EXPIRY,
  marketExpiry: MARKET_EXPIRY,
  nonce: 7n,
}

const ORDER_RECORD_JSON = {
  id: EXPECTED_ORDER_HASH,
  signature: SIGNATURE,
  chainId: CHAIN_ID,
  salt: SALT.toString(),
  expiry: ORDER_EXPIRY.toString(),
  nonce: '7',
  type: TOKEN_FOR_PT,
  token: SY,
  yt: YT,
  maker: MAKER,
  receiver: MAKER,
  makingAmount: MAKING_AMOUNT.toString(),
  currentMakingAmount: MAKING_AMOUNT.toString(),
  lnImpliedRate: LN_IMPLIED_RATE.toString(),
  failSafeRate: '900000000000000000',
  permit: '0x',
  orderFilledStatus: {
    netInputFromMaker: '0',
    netOutputToMaker: '0',
    feeAmount: '0',
    notionalVolume: '0',
  },
  isActive: true,
  isCanceled: false,
  createdAt: '2030-01-01T00:00:00.000Z',
  sy: SY,
  pt: PT,
  makerBalance: MAKING_AMOUNT.toString(),
  failedMintSy: false,
  failedMintSyReason: '',
  orderBookBalance: MAKING_AMOUNT.toString(),
  makingToken: SY,
  takingToken: PT,
  status: 'FILLABLE',
}

const BOOK_JSON = {
  longYieldEntries: [
    {
      impliedApy: 0.081,
      limitOrderSize: '1000000000000000000',
      ammSize: '2000000000000000000',
      incentiveQualifiedPySize: '500000000000000000',
    },
  ],
  shortYieldEntries: [{ impliedApy: 0.079, limitOrderSize: 42 }],
}

const tests = []

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function expectValidation(fn, path) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof LimitOrderValidationError)
    assert.equal(error.path, path)
    return true
  })
}

function test(name, fn) {
  tests.push({ name, fn })
}

test('strict support parser + PT/SY direction gates', () => {
  const support = parseLimitOrderSupport(SUPPORT_JSON)
  assert.equal(support.lnFeeRateRoot, 1_860_697_815_230_763n)
  assert.equal(validateSupportForPtSy(support, INTENT, TOKEN_FOR_PT), support)
  assert.equal(validateSupportForPtSy(support, INTENT, PT_FOR_TOKEN), support)

  expectValidation(
    () => validateSupportForPtSy(support, { ...INTENT, chainId: 1 }, TOKEN_FOR_PT),
    'support.chainId',
  )
  expectValidation(
    () => validateSupportForPtSy(support, { ...INTENT, market: OTHER }, TOKEN_FOR_PT),
    'support.market',
  )
  expectValidation(
    () => validateSupportForPtSy(support, { ...INTENT, sy: OTHER }, TOKEN_FOR_PT),
    'support.sy',
  )
  const missingInput = parseLimitOrderSupport({ ...SUPPORT_JSON, tokenIns: [OTHER] })
  expectValidation(
    () => validateSupportForPtSy(missingInput, INTENT, TOKEN_FOR_PT),
    'support.tokenIns',
  )
})

test('strict order-book parser accepts strings/safe integers and rejects unsafe sizes', () => {
  const book = parseLimitOrderBook(BOOK_JSON)
  assert.equal(book.longYieldEntries[0].limitOrderSize, 1_000_000_000_000_000_000n)
  assert.equal(book.shortYieldEntries[0].limitOrderSize, 42n)
  expectValidation(
    () =>
      parseLimitOrderBook({
        ...BOOK_JSON,
        shortYieldEntries: [{ impliedApy: 0.079, limitOrderSize: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    'orderBook.shortYieldEntries[0].limitOrderSize',
  )
  expectValidation(
    () =>
      parseLimitOrderBook({
        ...BOOK_JSON,
        longYieldEntries: [{ impliedApy: Number.NaN, limitOrderSize: '1' }],
      }),
    'orderBook.longYieldEntries[0].impliedApy',
  )
})

test('intent and generated order validate exact PT/SY signing fields', () => {
  assert.equal(validatePtSyLimitOrderIntent(INTENT, NOW), INTENT)
  const generated = parseGeneratedLimitOrder(GENERATED_JSON)
  assert.equal(
    validateGeneratedLimitOrder(generated, INTENT, { nowUnixSeconds: NOW }),
    generated,
  )
  assert.ok(Math.abs(apyFromLnImpliedRate(generated.lnImpliedRate) - IMPLIED_APY) < 1e-12)
  const request = createGenerateLimitOrderRequest(INTENT, NOW)
  assert.equal(request.makingAmount, MAKING_AMOUNT.toString())
  assert.equal(request.expiry, ORDER_EXPIRY.toString())
  assert.equal(typeof request.makingAmount, 'string')
})

test('generated-order tampering is rejected before typed data', () => {
  const generated = parseGeneratedLimitOrder(GENERATED_JSON)
  const cases = [
    ['generatedOrder.chainId', { chainId: 1 }],
    ['generatedOrder.YT', { YT: OTHER }],
    ['generatedOrder.token', { token: OTHER }],
    ['generatedOrder.orderType', { orderType: PT_FOR_TOKEN }],
    ['generatedOrder.maker', { maker: OTHER }],
    ['generatedOrder.receiver', { receiver: OTHER }],
    ['generatedOrder.makingAmount', { makingAmount: MAKING_AMOUNT + 1n }],
    ['generatedOrder.expiry', { expiry: ORDER_EXPIRY + 1n }],
    ['generatedOrder.nonce', { nonce: 8n }],
    ['generatedOrder.salt', { salt: SALT + 1n }],
    ['generatedOrder.permit', { permit: '0x00' }],
    ['generatedOrder.lnImpliedRate', { lnImpliedRate: LN_IMPLIED_RATE + 10n ** 15n }],
  ]
  for (const [path, patch] of cases) {
    expectValidation(
      () => validateGeneratedLimitOrder({ ...generated, ...patch }, INTENT, { nowUnixSeconds: NOW }),
      path,
    )
  }
  expectValidation(
    () => validatePtSyLimitOrderIntent({ ...INTENT, token: OTHER }, NOW),
    'intent.token',
  )
  expectValidation(
    () => validatePtSyLimitOrderIntent({ ...INTENT, expiry: MARKET_EXPIRY }, NOW),
    'intent.expiry',
  )
})

test('signed integer parsers reject JSON numbers and non-canonical decimals', () => {
  expectValidation(
    () => parseGeneratedLimitOrder({ ...GENERATED_JSON, lnImpliedRate: Number(LN_IMPLIED_RATE) }),
    'generatedOrder.lnImpliedRate',
  )
  expectValidation(
    () => parseGeneratedLimitOrder({ ...GENERATED_JSON, makingAmount: Number(MAKING_AMOUNT) }),
    'generatedOrder.makingAmount',
  )
  expectValidation(
    () => parseGeneratedLimitOrder({ ...GENERATED_JSON, nonce: '07' }),
    'generatedOrder.nonce',
  )
  expectValidation(
    () => parseGeneratedLimitOrder({ ...GENERATED_JSON, salt: (1n << 256n).toString() }),
    'generatedOrder.salt',
  )
  expectValidation(
    () => parseLimitOrderRecord({ ...ORDER_RECORD_JSON, makingAmount: Number(MAKING_AMOUNT) }),
    'limitOrder.makingAmount',
  )
})

test('EIP-712 domain, message, and hashes match deterministic vectors', () => {
  const generated = parseGeneratedLimitOrder(GENERATED_JSON)
  const typed = buildLimitOrderTypedData(generated, CHAIN_ID, LIMIT_ROUTER)
  assert.equal(typed.primaryType, 'Order')
  assert.equal(typed.domain.name, 'Pendle Limit Order Protocol')
  assert.equal(typed.domain.version, '1')
  assert.equal(typed.message.YT.toLowerCase(), YT)
  assert.equal(typed.message.makingAmount, MAKING_AMOUNT)
  assert.equal(hashLimitOrderDomain(CHAIN_ID, LIMIT_ROUTER), EXPECTED_DOMAIN_HASH)
  assert.equal(hashLimitOrder(generated, CHAIN_ID, LIMIT_ROUTER), EXPECTED_ORDER_HASH)
  expectValidation(() => buildLimitOrderTypedData(generated, 1, LIMIT_ROUTER), 'order.chainId')
})

test('DTO and submit record preserve exact signed values', () => {
  const generated = parseGeneratedLimitOrder(GENERATED_JSON)
  const dto = createLimitOrderDto(generated, SIGNATURE)
  assert.equal(dto.type, TOKEN_FOR_PT)
  assert.equal(dto.yt.toLowerCase(), YT)
  assert.equal(dto.salt, SALT.toString())
  assert.equal(dto.lnImpliedRate, LN_IMPLIED_RATE.toString())
  const record = parseLimitOrderRecord(ORDER_RECORD_JSON)
  assert.equal(validateLimitOrderRecordAgainstDto(record, dto, EXPECTED_ORDER_HASH), record)
  assert.equal(parseLimitOrderRecord({ ...ORDER_RECORD_JSON, signature: '0x' }).signature, '0x')
  expectValidation(
    () => validateLimitOrderRecordAgainstDto(record, { ...dto, receiver: OTHER }, EXPECTED_ORDER_HASH),
    'limitOrder.receiver',
  )
  expectValidation(
    () => parseLimitOrderRecord({ ...ORDER_RECORD_JSON, signature: '0x11' }),
    'limitOrder.signature',
  )
})

test('maker-list parser rejects type drift', () => {
  const parsed = parseMakerLimitOrdersResponse(
    { total: 1, limit: 50, skip: 0, results: [ORDER_RECORD_JSON] },
    TOKEN_FOR_PT,
  )
  assert.equal(parsed.results.length, 1)
  const wrongType = { ...ORDER_RECORD_JSON, type: PT_FOR_TOKEN }
  expectValidation(
    () =>
      parseMakerLimitOrdersResponse(
        { total: 1, limit: 50, skip: 0, results: [wrongType] },
        TOKEN_FOR_PT,
      ),
    'makerOrders.results',
  )
})

test('support API distinguishes unsupported from unavailable without network', async () => {
  const supported = await fetchLimitOrderSupport(INTENT, TOKEN_FOR_PT, {
    fetchFn: async () => jsonResponse(SUPPORT_JSON),
  })
  assert.equal(supported.status, 'supported')

  const unsupported = await fetchLimitOrderSupport(INTENT, TOKEN_FOR_PT, {
    fetchFn: async () => jsonResponse({ message: 'not found' }, 404),
  })
  assert.deepEqual(unsupported, { status: 'unsupported' })

  const unavailable = await fetchLimitOrderSupport(INTENT, TOKEN_FOR_PT, {
    fetchFn: async () => jsonResponse({ message: 'busy' }, 503),
  })
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.httpStatus, 503)

  const malformed = await fetchLimitOrderSupport(INTENT, TOKEN_FOR_PT, {
    fetchFn: async () => jsonResponse({ ...SUPPORT_JSON, market: OTHER }),
  })
  assert.equal(malformed.status, 'unavailable')
})

test('book API uses verified defaults and strict URL parameters', async () => {
  let capturedUrl
  let capturedInit
  const book = await fetchLimitOrderBook(
    { chainId: CHAIN_ID, market: MARKET },
    {
      fetchFn: async (url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return jsonResponse(BOOK_JSON)
      },
    },
  )
  assert.equal(book.longYieldEntries.length, 1)
  const url = new URL(capturedUrl)
  assert.equal(url.pathname, `/core/v2/limit-orders/book/${CHAIN_ID}`)
  assert.equal(url.searchParams.get('market'), MARKET)
  assert.equal(url.searchParams.get('precisionDecimal'), '3')
  assert.equal(url.searchParams.get('includeAmm'), 'true')
  assert.equal(url.searchParams.get('limit'), '10')
  assert.equal(capturedInit.method, 'GET')

  await assert.rejects(
    fetchLimitOrderBook(
      { chainId: CHAIN_ID, market: MARKET, precisionDecimal: 4 },
      { fetchFn: async () => jsonResponse(BOOK_JSON) },
    ),
    LimitOrderValidationError,
  )
})

test('global fetch keeps its receiver for Safari and the in-app browser', async () => {
  const originalFetch = globalThis.fetch
  let receiver
  globalThis.fetch = async function () {
    receiver = this
    return jsonResponse(BOOK_JSON)
  }
  try {
    const book = await fetchLimitOrderBook({ chainId: CHAIN_ID, market: MARKET })
    assert.equal(book.shortYieldEntries[0].limitOrderSize, 42n)
    assert.equal(receiver, globalThis)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generate API serializes the exact intent and validates its response', async () => {
  let body
  let path
  const generated = await generateLimitOrderData(INTENT, {
    nowUnixSeconds: NOW,
    fetchFn: async (url, init) => {
      path = new URL(String(url)).pathname
      body = JSON.parse(init.body)
      return jsonResponse(GENERATED_JSON, 201)
    },
  })
  assert.equal(path, '/core/v1/limit-orders/makers/generate-limit-order-data')
  assert.equal(body.YT.toLowerCase(), YT)
  assert.equal(body.makingAmount, MAKING_AMOUNT.toString())
  assert.equal(generated.salt, SALT)

  await assert.rejects(
    generateLimitOrderData(INTENT, {
      nowUnixSeconds: NOW,
      fetchFn: async () => jsonResponse({ ...GENERATED_JSON, receiver: OTHER }, 201),
    }),
    (error) => error instanceof LimitOrderApiError && error.kind === 'invalid-response',
  )
})

test('submit classification preserves ambiguous outcomes for reconciliation', async () => {
  const generated = parseGeneratedLimitOrder(GENERATED_JSON)
  const dto = createLimitOrderDto(generated, SIGNATURE)

  assert.equal(isAmbiguousSubmissionHttpStatus(408), true)
  assert.equal(isAmbiguousSubmissionHttpStatus(409), true)
  assert.equal(isAmbiguousSubmissionHttpStatus(429), true)
  assert.equal(isAmbiguousSubmissionHttpStatus(503), true)
  assert.equal(isAmbiguousSubmissionHttpStatus(422), false)

  const network = await submitLimitOrder(dto, EXPECTED_ORDER_HASH, {
    fetchFn: async () => {
      throw new Error('connection reset')
    },
  })
  assert.equal(network.status, 'ambiguous')

  const server = await submitLimitOrder(dto, EXPECTED_ORDER_HASH, {
    fetchFn: async () => jsonResponse({ message: 'busy' }, 503),
  })
  assert.equal(server.status, 'ambiguous')

  const rejected = await submitLimitOrder(dto, EXPECTED_ORDER_HASH, {
    fetchFn: async () => jsonResponse({ message: 'unsupported token' }, 422),
  })
  assert.equal(rejected.status, 'rejected')

  const malformedSuccess = await submitLimitOrder(dto, EXPECTED_ORDER_HASH, {
    fetchFn: async () => jsonResponse({}, 201),
  })
  assert.equal(malformedSuccess.status, 'ambiguous')

  const submitted = await submitLimitOrder(dto, EXPECTED_ORDER_HASH, {
    fetchFn: async () => jsonResponse(ORDER_RECORD_JSON, 201),
  })
  assert.equal(submitted.status, 'submitted')
})

test('maker and reconcile APIs build exact URLs and classify eventual consistency', async () => {
  let makerUrl
  const makerOrders = await fetchMakerLimitOrders(
    {
      chainId: CHAIN_ID,
      maker: MAKER,
      yt: YT,
      sy: SY,
      limitRouter: LIMIT_ROUTER,
      orderType: TOKEN_FOR_PT,
      isActive: true,
    },
    {
      fetchFn: async (url) => {
        makerUrl = new URL(String(url))
        return jsonResponse({
          total: 2,
          limit: 50,
          skip: 0,
          results: [ORDER_RECORD_JSON, { ...ORDER_RECORD_JSON, id: OTHER_HASH, token: OTHER }],
        })
      },
    },
  )
  assert.equal(makerOrders.results.length, 1)
  assert.equal(makerOrders.total, 1)
  assert.equal(makerUrl.searchParams.get('chainId'), String(CHAIN_ID))
  assert.equal(makerUrl.searchParams.get('maker'), MAKER)
  assert.equal(makerUrl.searchParams.get('yt'), YT)
  assert.equal(makerUrl.searchParams.get('type'), '0')
  assert.equal(makerUrl.searchParams.get('isActive'), 'true')

  await assert.rejects(
    () => fetchMakerLimitOrders(
      { chainId: CHAIN_ID, maker: MAKER, yt: YT, sy: SY, limitRouter: LIMIT_ROUTER, orderType: TOKEN_FOR_PT },
      { fetchFn: async () => jsonResponse({ total: 1, limit: 50, skip: 0, results: [{ ...ORDER_RECORD_JSON, maker: OTHER }] }) },
    ),
    /makerOrders\.results\.maker/,
  )

  await assert.rejects(
    () => fetchMakerLimitOrders(
      { chainId: CHAIN_ID, maker: MAKER, yt: YT, sy: SY, limitRouter: LIMIT_ROUTER, orderType: TOKEN_FOR_PT },
      { fetchFn: async () => jsonResponse({ total: 1, limit: 50, skip: 0, results: [{ ...ORDER_RECORD_JSON, id: OTHER_HASH }] }) },
    ),
    /makerOrders\.results\.id/,
  )

  const notFound = await reconcileLimitOrderSubmission(EXPECTED_ORDER_HASH, undefined, {
    fetchFn: async () => jsonResponse({ message: 'not found' }, 404),
  })
  assert.deepEqual(notFound, { status: 'not-found', definitive: false })

  const unavailable = await reconcileLimitOrderSubmission(EXPECTED_ORDER_HASH, undefined, {
    fetchFn: async () => jsonResponse({ message: 'busy' }, 503),
  })
  assert.equal(unavailable.status, 'unavailable')

  const dto = createLimitOrderDto(parseGeneratedLimitOrder(GENERATED_JSON), SIGNATURE)
  const found = await reconcileLimitOrderSubmission(EXPECTED_ORDER_HASH, dto, {
    fetchFn: async () => jsonResponse(ORDER_RECORD_JSON),
  })
  assert.equal(found.status, 'found')
})

test('cancellation plans accept only the current maker, SY, and bounded batches', () => {
  const generated = parseGeneratedLimitOrder(GENERATED_JSON)
  const inputs = { limitRouter: LIMIT_ROUTER, abi: [{ type: 'function' }], maker: MAKER, sy: SY }
  const single = buildCancelSingleLimitOrderPlan(generated, inputs)
  assert.equal(single.call.address, LIMIT_ROUTER)
  assert.equal(single.call.functionName, 'cancelSingle')
  assert.equal(single.approvals.length, 0)

  const second = { ...generated, salt: generated.salt + 12_421n }
  const batch = buildCancelBatchLimitOrdersPlan([generated, second], inputs)
  assert.equal(batch.call.functionName, 'cancelBatch')
  assert.equal(batch.call.args[0].length, 2)

  expectValidation(
    () => buildCancelBatchLimitOrdersPlan([generated, generated], inputs),
    'orders',
  )

  const all = buildCancelAllLimitOrdersPlan(inputs)
  assert.equal(all.call.functionName, 'increaseNonce')
  assert.deepEqual(all.call.args, [])

  expectValidation(
    () => buildCancelSingleLimitOrderPlan({ ...generated, maker: OTHER }, inputs),
    'order.maker',
  )
  expectValidation(
    () => buildCancelSingleLimitOrderPlan({ ...generated, token: OTHER }, inputs),
    'order.token',
  )
  expectValidation(
    () => buildCancelBatchLimitOrdersPlan([], inputs),
    'orders',
  )
  expectValidation(
    () => buildCancelBatchLimitOrdersPlan(Array.from({ length: 21 }, () => generated), inputs),
    'orders',
  )
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL  ${name}`)
    console.error(error)
  }
}

console.log(`\n${tests.length - failed}/${tests.length} limit-order checks passed.`)
if (failed > 0) process.exitCode = 1
