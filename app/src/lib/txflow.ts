/**
 * M2 transaction flow helpers — pure, framework-free (erasable TS).
 *
 * Implements the mechanics of PLAN §3.2's approve → simulate → confirm
 * lifecycle: allowance checking, approve-call building, exact-call simulation
 * (the binding quote), and Pendle custom-error decoding. The React state
 * machine that sequences these lives in hooks.ts (useActionFlow).
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  maxUint256,
} from 'viem'
import type { Abi, Address, Hex, PublicClient } from 'viem'
import type { ApprovalNeed, PlannedCall } from './types.ts'
import { MULTICALL3 } from './addresses.ts'
import { erc20Abi, pendleErrorsAbi } from './pendleAbi.ts'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function isNative(token: Address): boolean {
  return token.toLowerCase() === ZERO_ADDRESS
}

/**
 * Return the approvals whose current allowance is below the required amount.
 * Native ETH (address(0)) needs no approval and is skipped. An unreadable
 * allowance (exotic token) is conservatively treated as unmet so the flow
 * surfaces the problem at the approve step instead of a confusing later
 * simulation failure.
 */
export async function checkApprovals(
  client: PublicClient,
  user: Address,
  approvals: readonly ApprovalNeed[],
): Promise<ApprovalNeed[]> {
  const erc20Needs = approvals.filter((need) => !isNative(need.token))
  if (erc20Needs.length === 0) return []
  const results = await client.multicall({
    contracts: erc20Needs.map((need) => ({
      address: need.token,
      abi: erc20Abi,
      functionName: 'allowance' as const,
      args: [user, need.spender] as const,
    })),
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })
  return erc20Needs.filter((need, i) => {
    const r = results[i]
    return r.status !== 'success' || (r.result as bigint) < need.amount
  })
}

/**
 * ERC-20 approve call for an unmet ApprovalNeed. Exact amount by default
 * (PLAN §3.4 — worst-case loss capped at the amount being traded);
 * `infinite = true` (user opt-in) approves maxUint256.
 */
export function buildApproveCall(need: ApprovalNeed, infinite: boolean): PlannedCall {
  return {
    address: need.token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [need.spender, infinite ? maxUint256 : need.amount],
  }
}

/**
 * Simulate a PlannedCall as `user` via eth_call. On success, `primaryOut` is
 * the first bigint of the return value (netPyOut / netSyOut / amountSharesOut /
 * netTokenOut — every M2 action returns its primary output first); void
 * returns (claim) leave it undefined. On revert, `reason` is the decoded
 * human-readable message (decodePendleError).
 */
export async function simulateAction(
  client: PublicClient,
  user: Address,
  call: PlannedCall,
): Promise<{ ok: true; primaryOut?: bigint } | { ok: false; reason: string }> {
  try {
    const { result } = await client.simulateContract({
      account: user,
      address: call.address,
      abi: call.abi as Abi,
      functionName: call.functionName,
      args: call.args as unknown[],
      ...(call.value !== undefined ? { value: call.value } : {}),
    } as Parameters<PublicClient['simulateContract']>[0])
    return { ok: true, primaryOut: firstBigint(result) }
  } catch (err) {
    return { ok: false, reason: decodePendleError(err) }
  }
}

function firstBigint(result: unknown): bigint | undefined {
  if (typeof result === 'bigint') return result
  if (Array.isArray(result)) {
    const found = result.find((v) => typeof v === 'bigint')
    return typeof found === 'bigint' ? found : undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Error decoding
// ---------------------------------------------------------------------------

type FriendlyFn = (args: readonly unknown[]) => string

const slippage =
  (unit: string): FriendlyFn =>
  (args) =>
    `Slippage: would receive ${String(args[0] ?? '?')} ${unit} (raw units), below your minimum of ${String(args[1] ?? '?')}.`

/** Pendle custom-error name → friendly message (PLAN §3.4 decoding table). */
const FRIENDLY_ERRORS: Record<string, FriendlyFn> = {
  MarketExpired: () => 'This market has expired — trading and minting are closed.',
  YCExpired: () =>
    'This market has expired — PT + YT can no longer be minted (redemption still works).',
  MarketZeroNetLPFee: () =>
    'Trade too small — the fee rounds to zero. Increase the amount.',
  MarketProportionTooHigh: () =>
    'Trade would push the pool past its PT-proportion cap (0.96) — reduce the size.',
  MarketInsufficientSyForTrade: () =>
    'The pool does not have enough SY liquidity for this trade — reduce the size.',
  YCNothingToRedeem: () => 'Nothing to redeem for this position.',
  SYZeroDeposit: () => 'Deposit amount is zero.',
  SYZeroRedeem: () => 'Redeem amount is zero.',
  SYInsufficientSharesOut: slippage('SY'),
  SYInsufficientTokenOut: slippage('tokens'),
  RouterInsufficientSyOut: slippage('SY'),
  RouterInsufficientPtOut: slippage('PT'),
  RouterInsufficientYtOut: slippage('YT'),
  RouterInsufficientPYOut: slippage('PT+YT'),
  RouterInsufficientLpOut: slippage('LP'),
  RouterInsufficientTokenOut: slippage('tokens'),
  MarketFactoryMarketExists: () =>
    'A market with these exact parameters already exists — use the existing market or retry.',
  MarketFactoryInvalidPt: () =>
    'This PT was not created by the factory paired with this market factory.',
  MarketFactoryExpiredPt: () => 'This PT has already expired — pick a future expiry.',
  YCFactoryYieldContractExisted: () =>
    'A PT/YT pair for this SY and expiry already exists.',
  YCFactoryInvalidExpiry: () =>
    'Invalid expiry — it must be in the future and aligned to the factory expiry divisor (daily 00:00 UTC).',
}

/**
 * Decode raw revert bytes: Pendle custom errors → friendly message;
 * Error(string) → the string itself (passes through 'Slippage: …' and ERC20
 * allowance/balance reverts); unknown selector → undefined.
 */
export function decodeRevertData(data: Hex): string | undefined {
  if (!data || data === '0x') return undefined
  try {
    // Cast: viem types errorName to the ABI's declared errors only, but at
    // runtime decodeErrorResult also decodes the built-in Error(string)/Panic.
    const decoded = decodeErrorResult({ abi: pendleErrorsAbi, data }) as {
      errorName: string
      args?: readonly unknown[]
    }
    if (decoded.errorName === 'Error') {
      return String(decoded.args?.[0] ?? 'Execution reverted.')
    }
    if (decoded.errorName === 'Panic') {
      return `Panic (code ${String(decoded.args?.[0] ?? '?')}) — arithmetic or assertion failure.`
    }
    const friendly = FRIENDLY_ERRORS[decoded.errorName]
    return friendly ? friendly(decoded.args ?? []) : `Reverted: ${decoded.errorName}`
  } catch {
    return undefined
  }
}

/**
 * Walk a viem error chain and produce a human-readable message:
 * 1. string reverts (Error(string)) pass through verbatim ('Slippage: …',
 *    ERC20 allowance/balance strings);
 * 2. Pendle custom-error selectors map to friendly messages (FRIENDLY_ERRORS);
 * 3. anything else falls back to viem's shortMessage / the raw message.
 */
export function decodePendleError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      // Error(string) reverts decoded by viem itself.
      if (revert.reason) return revert.reason
      // Custom errors: viem exposes the raw revert bytes on `raw` (and the
      // decoded form on `data` only when the call ABI contained the error —
      // ours deliberately does not; pendleErrorsAbi is the decode table).
      if (revert.raw) {
        const decoded = decodeRevertData(revert.raw)
        if (decoded) return decoded
      }
      if (revert.data?.errorName) return `Reverted: ${revert.data.errorName}`
      if (revert.signature) return `Reverted with unrecognized error ${revert.signature}.`
      return err.shortMessage
    }
    // Some RPCs surface revert data without a ContractFunctionRevertedError
    // wrapper — scan the cause chain for hex data as a last resort.
    const withData = err.walk(
      (e) => typeof (e as { data?: unknown }).data === 'string',
    ) as { data?: string } | null
    if (withData && typeof withData.data === 'string' && withData.data.startsWith('0x')) {
      const decoded = decodeRevertData(withData.data as Hex)
      if (decoded) return decoded
    }
    return err.shortMessage
  }
  if (err instanceof Error) return err.message
  return String(err)
}
