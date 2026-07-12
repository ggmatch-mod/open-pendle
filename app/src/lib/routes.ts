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

/** Only address routes are bound to a network by their URL. */
export function isChainAddressRoute(pathname: string): boolean {
  try {
    return /^\/(market|token)\/[^/]+\/?$/i.test(decodeURIComponent(pathname))
  } catch {
    return false
  }
}

/**
 * Resolve the chain this tab should read. Market/token deep links override the
 * persisted preference locally; other pages always use the preference.
 */
export function activeChainForLocation(
  preferredChainId: SupportedChainId,
  pathname: string,
  search: string,
): SupportedChainId {
  if (!isChainAddressRoute(pathname)) return preferredChainId
  return routeChainId(search) ?? preferredChainId
}

/** Rewrite a market/token route's chain while preserving its other queries. */
export function chainSearchForLocation(
  pathname: string,
  search: string,
  chainId: SupportedChainId,
): string | undefined {
  if (!isChainAddressRoute(pathname)) return undefined
  const params = new URLSearchParams(search)
  params.set('chain', String(chainId))
  return `?${params.toString()}`
}
