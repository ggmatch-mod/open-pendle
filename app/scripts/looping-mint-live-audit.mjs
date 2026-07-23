#!/usr/bin/env node

/**
 * Read-only production audit for every reviewed Mint Mode entry market.
 *
 * Pins one live block per chain, verifies Pendle PT/YT/SY wiring, explicit
 * PT/YT decimals, Mint Router facet and Kyber executor code pins, then passes
 * one fresh quote per unexpired market through the production validator.
 * It never signs, approves, sends, or mutates chain state.
 */

import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiParameters,
} from 'viem'
import { arbitrum, mainnet, monad } from 'viem/chains'
import {
  loopingErc20Abi,
  loopingStandardizedYieldAbi,
  pendleLoopingMarketAbi,
} from '../src/lib/loopingAbi.ts'
import { fetchPendleLoopingMintRoute } from '../src/lib/loopingExecution.ts'
import { LOOPING_ENTRY_EXECUTION_REGISTRY } from '../src/lib/loopingRegistry.ts'

const CHAIN_CONFIG = Object.freeze({
  1: Object.freeze({
    chain: mainnet,
    rpcUrl:
      process.env.OPENPENDLE_ETH_RPC_URL ??
      process.env.ETH_RPC_URL ??
      'https://ethereum-rpc.publicnode.com',
  }),
  143: Object.freeze({
    chain: monad,
    rpcUrl:
      process.env.OPENPENDLE_MONAD_RPC_URL ??
      process.env.MONAD_RPC_URL ??
      'https://rpc.monad.xyz',
  }),
  42_161: Object.freeze({
    chain: arbitrum,
    rpcUrl:
      process.env.OPENPENDLE_ARB_RPC_URL ??
      process.env.ARB_RPC_URL ??
      'https://arb1.arbitrum.io/rpc',
  }),
})

const HTTP_RETRY_DELAYS_MS = Object.freeze([0, 5_000, 15_000, 30_000])
const QUOTE_RETRY_DELAYS_MS = Object.freeze([0, 5_000, 15_000])
const QUOTE_SPACING_MS = 1_500

function fail(message) {
  throw new Error(message)
}

function sameHex(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase()
}

function includesAddress(values, target) {
  return values.some((value) => sameHex(value, target))
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isRetryableQuoteFailure(error) {
  return /HTTP (?:408|425|429|5\d\d)|rate.?limit|temporar|timeout|fetch failed/i
    .test(messageOf(error))
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function withQuoteRetry(task) {
  let lastError
  for (const waitMs of QUOTE_RETRY_DELAYS_MS) {
    if (waitMs > 0) await delay(waitMs)
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (!isRetryableQuoteFailure(error)) throw error
    }
  }
  throw lastError
}

async function retryingQuoteFetch(input, init) {
  let response
  for (const waitMs of HTTP_RETRY_DELAYS_MS) {
    if (waitMs > 0) await delay(waitMs)
    response = await globalThis.fetch(input, init)
    if (response.status !== 429 && response.status < 500) return response
    await response.arrayBuffer()
  }
  return response
}

async function auditChain(chainId, markets) {
  const config = CHAIN_CONFIG[chainId]
  if (config === undefined) fail(`No RPC configuration for chain ${chainId}.`)
  const client = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl, { retryCount: 1, timeout: 60_000 }),
  })
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || block.hash === null) {
    fail(`Chain ${chainId} did not return a canonical latest block.`)
  }
  if (await client.getChainId() !== chainId) {
    fail(`RPC chain mismatch for chain ${chainId}.`)
  }

  const executorHashes = {}
  const executors = new Map()
  for (const market of markets) {
    for (const executor of market.routePolicy.kyber.executorAllowlist) {
      executors.set(executor.address.toLowerCase(), executor)
    }
  }
  for (const executor of executors.values()) {
    const code = await client.getBytecode({
      address: executor.address,
      blockNumber: block.number,
    })
    if (code === undefined || code === '0x') {
      fail(`Kyber executor has no code: ${executor.address}.`)
    }
    const codeHash = keccak256(code)
    if (!sameHex(codeHash, executor.runtimeCodeHash)) {
      fail(`Kyber executor code changed: ${executor.address}.`)
    }
    executorHashes[executor.address.toLowerCase()] = codeHash
  }

  const mintFacetPolicy =
    markets[0].mintRouteUpgradePolicy.pendleRouter
  const [mintFacetWord, mintFacetCode] = await Promise.all([
    client.getStorageAt({
      address: markets[0].contracts.pendleRouter,
      slot: mintFacetPolicy.selectorStorageSlot,
      blockNumber: block.number,
    }),
    client.getBytecode({
      address: mintFacetPolicy.facet,
      blockNumber: block.number,
    }),
  ])
  const expectedMintFacetWord = encodeAbiParameters(
    parseAbiParameters('address'),
    [mintFacetPolicy.facet],
  )
  if (
    mintFacetWord === undefined ||
    !sameHex(mintFacetWord, expectedMintFacetWord) ||
    mintFacetCode === undefined ||
    mintFacetCode === '0x' ||
    !sameHex(
      keccak256(mintFacetCode),
      mintFacetPolicy.facetRuntimeCodeHash,
    )
  ) {
    fail(`Mint Router facet changed on chain ${chainId}.`)
  }

  const results = []
  for (const market of markets) {
    const [
      marketTokens,
      expiry,
      tokensIn,
      tokensOut,
      ptDecimals,
      ytDecimals,
    ] = await Promise.all([
      client.readContract({
        address: market.pendleMarket,
        abi: pendleLoopingMarketAbi,
        functionName: 'readTokens',
        blockNumber: block.number,
      }),
      client.readContract({
        address: market.pendleMarket,
        abi: pendleLoopingMarketAbi,
        functionName: 'expiry',
        blockNumber: block.number,
      }),
      client.readContract({
        address: market.standardizedYield,
        abi: loopingStandardizedYieldAbi,
        functionName: 'getTokensIn',
        blockNumber: block.number,
      }),
      client.readContract({
        address: market.standardizedYield,
        abi: loopingStandardizedYieldAbi,
        functionName: 'getTokensOut',
        blockNumber: block.number,
      }),
      client.readContract({
        address: market.morphoMarketParams.collateralToken,
        abi: loopingErc20Abi,
        functionName: 'decimals',
        blockNumber: block.number,
      }),
      client.readContract({
        address: market.yieldToken,
        abi: loopingErc20Abi,
        functionName: 'decimals',
        blockNumber: block.number,
      }),
    ])
    if (
      !sameHex(marketTokens[0], market.standardizedYield) ||
      !sameHex(marketTokens[1], market.morphoMarketParams.collateralToken) ||
      !sameHex(marketTokens[2], market.yieldToken) ||
      expiry !== market.pendleMarketExpiry
    ) {
      fail(`Pendle market wiring changed for ${chainId}:${market.marketId}.`)
    }
    if (
      ptDecimals !== market.collateralTokenDecimals ||
      ytDecimals !== market.yieldTokenDecimals ||
      ptDecimals !== ytDecimals
    ) {
      fail(`PT/YT decimals changed for ${chainId}:${market.marketId}.`)
    }
    for (const token of market.routePolicy.mintSyTokenAllowlist) {
      if (!includesAddress(tokensIn, token)) {
        fail(`SY mint token changed for ${chainId}:${market.marketId}.`)
      }
    }
    for (const token of market.routePolicy.redeemSyTokenAllowlist) {
      if (!includesAddress(tokensOut, token)) {
        fail(`SY redeem token changed for ${chainId}:${market.marketId}.`)
      }
    }

    if (block.timestamp >= expiry) {
      const result = Object.freeze({
        chainId,
        marketId: market.marketId,
        status: 'matured',
      })
      results.push(result)
      console.log(JSON.stringify(result))
      continue
    }
    const amountIn = 10n ** BigInt(market.loanTokenDecimals)
    const quote = await withQuoteRetry(() => fetchPendleLoopingMintRoute({
      market,
      wiring: {
        tokensIn,
        tokensOut,
        kyberExecutorCodeHashes: executorHashes,
      },
      amountIn,
      yieldToken: market.yieldToken,
      fetcher: retryingQuoteFetch,
    }))
    const result = Object.freeze({
      chainId,
      marketId: market.marketId,
      status: 'quote-valid',
      route: quote.route.kyberExecutor === null ? 'direct' : 'kyberswap',
      ptDecimals,
      ytDecimals,
    })
    results.push(result)
    console.log(JSON.stringify(result))
    await delay(QUOTE_SPACING_MS)
  }
  return results
}

async function main() {
  const grouped = new Map()
  for (const market of LOOPING_ENTRY_EXECUTION_REGISTRY) {
    const markets = grouped.get(market.chainId) ?? []
    markets.push(market)
    grouped.set(market.chainId, markets)
  }
  const results = []
  for (const [chainId, markets] of grouped) {
    results.push(...await auditChain(chainId, markets))
  }
  const quoteValid = results.filter((result) => result.status === 'quote-valid')
  const matured = results.filter((result) => result.status === 'matured')
  console.log(JSON.stringify({
    kind: 'summary',
    reviewed: results.length,
    quoteValid: quoteValid.length,
    matured: matured.length,
    direct: quoteValid.filter((result) => result.route === 'direct').length,
    kyberswap:
      quoteValid.filter((result) => result.route === 'kyberswap').length,
  }))
  if (results.length !== LOOPING_ENTRY_EXECUTION_REGISTRY.length) {
    fail('Live Mint audit did not cover the full entry registry.')
  }
}

await main()
