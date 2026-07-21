/**
 * Read-only RPC clients used by the chain-scoped looping flow.
 *
 * Browser execution uses the connected wallet's RPC through the exact-method,
 * read-only client below. The keyless 1RPC exports remain only for standalone
 * canary tooling; the browser hook must not import them. Even after signing,
 * the wallet read client receives only unsigned simulation calldata or public
 * reads.
 */

import { createPublicClient, custom } from 'viem'
import type { Chain, WalletClient } from 'viem'
import { arbitrum, base, mainnet, monad } from 'viem/chains'

export const LOOPING_1RPC_ARBITRUM_URL = 'https://public.1rpc.io/arb' as const

export const LOOPING_WALLET_RPC_CHAINS = Object.freeze({
  [mainnet.id]: mainnet,
  [monad.id]: monad,
  [base.id]: base,
  [arbitrum.id]: arbitrum,
} as const satisfies Readonly<Record<number, Chain>>)

export const LOOPING_WALLET_RPC_READ_METHODS = Object.freeze([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
] as const)

const LOOPING_WALLET_RPC_READ_METHOD_SET = new Set<string>(
  LOOPING_WALLET_RPC_READ_METHODS,
)

export const LOOPING_RPC_POLICY = Object.freeze({
  walletTimeoutMs: 12_000,
  walletRetryCount: 0,
})

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Connected-wallet RPC timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timeoutId)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeoutId)
        reject(error)
      },
    )
  })
}

function assertReadOnlyWalletRpcMethod(method: string): void {
  if (!LOOPING_WALLET_RPC_READ_METHOD_SET.has(method)) {
    throw new Error(`Looping wallet RPC is read-only; ${method} is not allowed.`)
  }
}

function rpcErrorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : ''
}

function collectRpcErrorDetails(
  error: unknown,
): Array<{ name: string; message: string; code: string }> {
  const details: Array<{ name: string; message: string; code: string }> = []
  const seen = new Set<unknown>()
  let cursor: unknown = error
  while (cursor !== null && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor)
    const item = cursor as {
      name?: unknown
      message?: unknown
      shortMessage?: unknown
      details?: unknown
      code?: unknown
      cause?: unknown
    }
    details.push({
      name: typeof item.name === 'string' ? item.name : '',
      message: [item.message, item.shortMessage, item.details]
        .filter((value): value is string => typeof value === 'string')
        .join(' '),
      code: item.code === undefined ? '' : String(item.code),
    })
    cursor = item.cause
  }
  return details
}

/**
 * Retry another read-only RPC only for transport, rate-limit, or capability
 * failures. Contract reverts and compiler safety failures must remain final.
 */
export function mayUseLoopingWalletReadFallback(error: unknown): boolean {
  const topCode = rpcErrorCode(error)
  const details = collectRpcErrorDetails(error)
  const combined = details.map((item) => `${item.name} ${item.code} ${item.message}`).join(' ')
  const nestedDetails = details.slice(1)
  const remoteRpcIndex = nestedDetails.findIndex((item) =>
    /^(?:InternalRpcError|RpcRequestError)$/i.test(item.name) &&
    item.code === '-32603' &&
    /\bRemote Error\b/.test(item.message),
  )
  const opaqueRemoteProviderError = remoteRpcIndex >= 0 &&
    nestedDetails.slice(remoteRpcIndex + 1).some((item) =>
      (item.name === '' || item.name === 'Error') &&
      item.code === '-32603' &&
      item.message.trim() === 'Remote Error',
    )
  const oneRpcQuotaFailure = details.some((item) =>
    item.code === '-32001' &&
    /reached the usage limit for your current plan/i.test(item.message),
  )
  if (
    /execution reverted|revert data|vm execution error|insufficient funds/i.test(
      combined,
    )
  ) return false
  const nestedCombined = nestedDetails
    .map((item) => `${item.name} ${item.code} ${item.message}`)
    .join(' ')
  const nestedRpcFailure =
    /method not found|method.*not supported|unsupported.*state override|too many arguments|rate.?limit|too many requests|request limit|temporarily unavailable|upstream unavailable|service unavailable|timed out|timeout|failed to fetch|network|HTTP status|429|502|503|504/i.test(
      nestedCombined,
    ) ||
    nestedDetails.some((item) =>
      /HttpRequestError|TimeoutError|WebSocketRequestError/i.test(item.name) ||
      item.code === '-32601' ||
      item.code === '-32005' ||
      item.code === '429' ||
      item.code === '502' ||
      item.code === '503' ||
      item.code === '504')
  if (
    /INVALID_|UNSUPPORTED_|ROUTE_|STATE_|POSITION_|QUOTE_|UNSAFE_|CAP_|BOUND_|BUFFER_|HEALTH_|ALLOW_|MARKET_|WIRING|STALE_|SIGNATURE_/i.test(
      topCode,
    ) &&
    !(topCode === 'UNSAFE_WIRING' &&
      (nestedRpcFailure || opaqueRemoteProviderError || oneRpcQuotaFailure))
  ) return false
  // 1RPC can return an opaque JSON-RPC -32603 "Remote Error" for a valid
  // eth_call. Viem then wraps that exact provider chain as a contract revert.
  // Retry only when both the RPC wrapper and raw leaf match; generic -32603
  // errors and explicit EVM-revert evidence remain final.
  if (opaqueRemoteProviderError) return true
  // The public 1RPC endpoint reports exhausted plan capacity as -32001.
  // Treat only its exact quota wording as provider failure; other -32001
  // responses remain final.
  if (oneRpcQuotaFailure) return true
  if (/contract function.*revert/i.test(combined)) return false
  if (
    /method not found|method.*not supported|unsupported.*state override|too many arguments/i.test(
      combined,
    )
  ) return true
  if (
    /rate.?limit|too many requests|request limit|temporarily unavailable|upstream unavailable|service unavailable/i.test(
      combined,
    )
  ) return true
  if (details.some((item) => /HttpRequestError|TimeoutError|WebSocketRequestError/i.test(item.name))) {
    return /1rpc|public\.1rpc\.io|timed out|timeout|failed to fetch|network|HTTP status|429|502|503|504/i.test(
      combined,
    )
  }
  return details.some((item) =>
    item.code === '-32601' ||
    item.code === '-32005' ||
    item.code === '429' ||
    item.code === '502' ||
    item.code === '503' ||
    item.code === '504',
  )
}

/**
 * Adapt the connected wallet's EIP-1193 transport into a read-only viem
 * PublicClient. Callers must keep all signatures and signed bundle calldata
 * local, including when this client is used for post-signature unsigned reads.
 */
export function createLoopingWalletReadClient(
  walletClient: WalletClient,
) {
  const walletChainId = walletClient.chain?.id
  const chain = walletChainId === undefined
    ? undefined
    : LOOPING_WALLET_RPC_CHAINS[
        walletChainId as keyof typeof LOOPING_WALLET_RPC_CHAINS
      ]
  if (chain === undefined) {
    throw new Error('Looping wallet RPC requires a supported execution-chain connection.')
  }

  const provider = {
    request(args: { method: string; params?: unknown }): Promise<unknown> {
      assertReadOnlyWalletRpcMethod(args.method)
      return withTimeout(
        walletClient.request(args as never),
        LOOPING_RPC_POLICY.walletTimeoutMs,
      )
    },
  }

  return createPublicClient({
    chain,
    key: `openpendle-looping-wallet-read-${chain.id}`,
    name: `OpenPendle Looping Wallet Read Client (${chain.name})`,
    batch: { multicall: true },
    transport: custom(provider, {
      key: 'openpendle-looping-wallet-read-custom',
      name: 'OpenPendle Looping Wallet Read Custom',
      retryCount: LOOPING_RPC_POLICY.walletRetryCount,
    }),
  })
}
