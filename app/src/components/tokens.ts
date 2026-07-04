/**
 * Token metadata for the M2 action panels: symbol + decimals for the SY's
 * tokensIn/tokensOut lists, read on demand (batched through Multicall3 by the
 * wagmi transport). address(0) is native ETH by SY convention — never called,
 * always rendered as ETH/18.
 *
 * Positions.walletTokens already carries symbol/decimals for tokensIn, but the
 * panels also need tokensOut (and must render before positions load), so this
 * hook is the single metadata source; walletTokens supplies only balances.
 */

import { erc20Abi, zeroAddress } from 'viem'
import type { Address } from 'viem'
import { useReadContracts } from 'wagmi'
import type { Positions } from '../lib/types'
import { supportedChain } from '../lib/addresses'
import { useActiveChain } from '../lib/hooks'

export interface TokenMeta {
  address: Address
  isNative: boolean
  /** Undefined until the on-chain read lands (or if it failed). */
  symbol?: string
  decimals?: number
}

export function sameAddress(a?: string, b?: string): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
}

export function isNativeEth(token: Address): boolean {
  return token.toLowerCase() === zeroAddress
}

/**
 * symbol()/decimals() for a set of token addresses. Failures leave the fields
 * undefined (panels degrade to a short address + disabled input, never crash).
 */
export function useTokenMetas(tokens: readonly Address[]): Record<string, TokenMeta> {
  // M8: route the metadata multicall to the ACTIVE chain (else the wagmi
  // default = Ethereum), and label the native token with THIS chain's symbol
  // (ETH / BNB / MON / XPL), not a hardcoded ETH.
  const { chainId } = useActiveChain()
  const nativeSymbol = supportedChain(chainId)?.nativeSymbol ?? 'ETH'
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))] as Address[]
  const erc20s = unique.filter((t) => !isNativeEth(t))

  const { data } = useReadContracts({
    contracts: erc20s.flatMap((address) => [
      { chainId, address, abi: erc20Abi, functionName: 'symbol' } as const,
      { chainId, address, abi: erc20Abi, functionName: 'decimals' } as const,
    ]),
    allowFailure: true,
    query: { staleTime: Infinity, enabled: erc20s.length > 0 },
  })

  const metas: Record<string, TokenMeta> = {}
  for (const t of unique) {
    if (isNativeEth(t)) {
      metas[t] = { address: t, isNative: true, symbol: nativeSymbol, decimals: 18 }
    } else {
      metas[t] = { address: t, isNative: false }
    }
  }
  erc20s.forEach((address, i) => {
    const symbol = data?.[i * 2]
    const decimals = data?.[i * 2 + 1]
    const meta = metas[address.toLowerCase()]
    if (meta === undefined) return
    if (symbol?.status === 'success' && typeof symbol.result === 'string') {
      meta.symbol = symbol.result
    }
    if (decimals?.status === 'success' && typeof decimals.result === 'number') {
      meta.decimals = decimals.result
    }
  })
  return metas
}

/** Wallet balance of a tokensIn entry, from Positions (undefined until loaded). */
export function findWalletBalance(
  positions: Positions | undefined,
  token: Address,
): bigint | undefined {
  return positions?.walletTokens.find((t) => sameAddress(t.token, token))?.amount
}
