/** Chain-explicit internal routes for shareable multi-network deep links. */

import type { Address } from 'viem'
import type { SupportedChainId } from './types.ts'
import { isSupportedChainId } from './addresses.ts'

export function marketPath(address: Address | string, chainId: SupportedChainId): string {
  return `/market/${address}?chain=${chainId}`
}

export function tokenPath(address: Address | string, chainId: SupportedChainId): string {
  return `/token/${address}?chain=${chainId}`
}

export function routeChainId(search: string): SupportedChainId | undefined {
  const raw = new URLSearchParams(search).get('chain')
  if (raw === null || !/^\d+$/.test(raw)) return undefined
  const chainId = Number(raw)
  return isSupportedChainId(chainId) ? chainId : undefined
}
