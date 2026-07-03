import { useEffect } from 'react'
import { clampLabel } from './format'

const BASE_TITLE = 'OpenPendle — Pendle community pools on Arbitrum'

/**
 * Route-aware document.title. Pass a page-specific prefix
 * (e.g. a market's displayName); undefined keeps the base title.
 * Restores the base title on unmount so stale names never linger.
 * Prefixes are on-chain strings — clamped (bidi/zero-width stripped,
 * truncated) before they reach the tab title.
 */
export function useDocumentTitle(prefix?: string) {
  useEffect(() => {
    document.title = prefix ? `${clampLabel(prefix)} — OpenPendle` : BASE_TITLE
    return () => {
      document.title = BASE_TITLE
    }
  }, [prefix])
}
