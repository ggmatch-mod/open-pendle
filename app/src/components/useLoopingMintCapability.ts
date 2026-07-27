/**
 * Read-only probe of the served looping Mint runtime policy.
 *
 * `assertLoopingMintRuntimeActionEnabled` is the authority and stays exactly
 * where it is — immediately before signing, inside execute(). This hook does
 * not replace it and grants nothing: it only lets the UI avoid OFFERING a mode
 * the policy will refuse, so the user is not walked through two Pendle quotes,
 * a pinned preflight and a liquidation-risk acknowledgement before being told
 * "paused by OpenPendle".
 *
 * Fail-closed: any error, timeout, or in-flight state reports `enabled: false`.
 */

import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import {
  assertLoopingMintRuntimeActionEnabled,
  type LoopingMintRuntimeAction,
} from '../lib/loopingMintRuntimePolicy'

export interface LoopingMintCapability {
  /** True only when the served policy positively enables this action. */
  enabled: boolean
  /** Operator-supplied pause reason, when the policy refused. */
  reason?: string
  pending: boolean
}

const CAPABILITY_STALE_MS = 60_000

export function useLoopingMintCapability({
  action,
  chainId,
  marketId,
}: {
  action: LoopingMintRuntimeAction
  chainId: number | undefined
  marketId: Hex | undefined
}): LoopingMintCapability {
  const query = useQuery({
    queryKey: ['looping-mint-capability', action, chainId, marketId],
    enabled: chainId !== undefined && marketId !== undefined,
    staleTime: CAPABILITY_STALE_MS,
    gcTime: CAPABILITY_STALE_MS,
    retry: false,
    queryFn: async (): Promise<{ enabled: boolean; reason?: string }> => {
      if (chainId === undefined || marketId === undefined) {
        return { enabled: false }
      }
      try {
        await assertLoopingMintRuntimeActionEnabled({ action, chainId, marketId })
        return { enabled: true }
      } catch (error) {
        // A refusal is a normal, expected answer here — not a query failure.
        return {
          enabled: false,
          reason: error instanceof Error ? error.message : undefined,
        }
      }
    },
  })

  return {
    enabled: query.data?.enabled ?? false,
    reason: query.data?.reason,
    pending: query.isPending && chainId !== undefined && marketId !== undefined,
  }
}
