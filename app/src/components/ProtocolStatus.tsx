/**
 * ProtocolStatus — live-reads one chain's protocol wiring straight from the
 * chain (takes an explicit `chainId`, so the /status page can render a card per
 * supported network). The commonDeploy entry point and every read are resolved/
 * routed for that chainId.
 *
 * Stage 1: resolve active marketFactory / yieldContractFactory / router /
 *          syFactory from commonDeploy's immutables (PLAN F12).
 * Stage 2: read governance-mutable values (expiryDivisor, interestFeeRate,
 *          treasury, maxLnFeeRateRoot) from the resolved factories.
 *
 * All reads go through that chain's RPC transport (multicall-batched) — no
 * wallet needed. Retries are TanStack Query defaults, which absorb flaky
 * public-RPC hiccups; each card owns its own loading/error state.
 */

import type { ReactNode } from 'react'
import { useReadContracts } from 'wagmi'
import type { Address } from 'viem'
import { addressBookFor, supportedChain } from '../lib/addresses'
import { useActiveChain } from '../lib/hooks'
import type { SupportedChainId } from '../lib/types'
import { explorerAddressUrl } from './format'
import {
  commonDeployAbi,
  marketFactoryAbi,
  yieldContractFactoryAbi,
} from '../lib/pendleAbi'

/** 1e18-scaled rate → "5%" (trims trailing zeros; 5e16 → "5%"). */
function formatRate1e18(value: bigint): string {
  const pct = (Number(value) / 1e18) * 100
  return `${trimZeros(pct.toFixed(4))}%`
}

/** lnFeeRateRoot cap → effective fee cap %: e^(x/1e18) − 1 (ln(1.05) → "5%"). */
function formatLnFeeCap(value: bigint): string {
  const pct = Math.expm1(Number(value) / 1e18) * 100
  return `${trimZeros(pct.toFixed(4))}%`
}

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, '')
}

/** 86400 → "86400 s (daily, 00:00 UTC)". */
function formatExpiryDivisor(value: bigint): string {
  const suffix = value === 86400n ? ' (daily, 00:00 UTC)' : ''
  return `${value.toString()} s${suffix}`
}

function shortAddr(addr: Address): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function AddressValue({ address, chainId }: { address: Address; chainId: SupportedChainId }) {
  return (
    <a
      href={explorerAddressUrl(chainId, address)}
      target="_blank"
      rel="noreferrer"
      title={address}
      className="font-mono text-sm text-accent-ink hover:underline"
    >
      {shortAddr(address)}
    </a>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-hairline py-2.5 last:border-b-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  )
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div aria-busy="true" aria-label="Loading protocol status">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-4 border-b border-hairline py-3 last:border-b-0"
        >
          <div className="h-3.5 w-36 animate-pulse rounded bg-surface-2" />
          <div className="h-3.5 w-28 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  )
}

export function ProtocolStatus({ chainId }: { chainId: SupportedChainId }) {
  // commonDeploy is the same address on every chain, but we resolve it via this
  // chain's book (single source of truth) and route every read with `chainId`
  // so the wiring/fee reads land on this network.
  const { chainId: activeChainId } = useActiveChain()
  const isActive = chainId === activeChainId
  const chain = supportedChain(chainId)
  const commonDeploy = addressBookFor(chainId).commonDeploy

  // Stage 1 — resolve the active wiring from commonDeploy's immutables.
  const wiring = useReadContracts({
    allowFailure: false,
    contracts: [
      { chainId, address: commonDeploy, abi: commonDeployAbi, functionName: 'marketFactory' },
      { chainId, address: commonDeploy, abi: commonDeployAbi, functionName: 'yieldContractFactory' },
      { chainId, address: commonDeploy, abi: commonDeployAbi, functionName: 'router' },
      { chainId, address: commonDeploy, abi: commonDeployAbi, functionName: 'syFactory' },
    ],
    query: {
      // Immutables — cache generously (PLAN §3.2: longer staleTime for immutables).
      staleTime: 10 * 60_000,
    },
  })

  const [marketFactory, yieldContractFactory, router, syFactory] =
    wiring.data ?? [undefined, undefined, undefined, undefined]

  // Stage 2 — governance-mutable values from the resolved factories.
  const params = useReadContracts({
    allowFailure: false,
    contracts:
      yieldContractFactory && marketFactory
        ? [
            { chainId, address: yieldContractFactory, abi: yieldContractFactoryAbi, functionName: 'expiryDivisor' },
            { chainId, address: yieldContractFactory, abi: yieldContractFactoryAbi, functionName: 'interestFeeRate' },
            { chainId, address: yieldContractFactory, abi: yieldContractFactoryAbi, functionName: 'treasury' },
            { chainId, address: marketFactory, abi: marketFactoryAbi, functionName: 'maxLnFeeRateRoot' },
          ]
        : undefined,
    query: {
      enabled: Boolean(yieldContractFactory && marketFactory),
      staleTime: 60_000,
    },
  })

  const [expiryDivisor, interestFeeRate, ycfTreasury, maxLnFeeRateRoot] =
    params.data ?? [undefined, undefined, undefined, undefined]

  const isLoading = wiring.isPending || (wiring.isSuccess && params.isPending)
  const error = wiring.error ?? params.error
  const refetch = () => {
    if (wiring.isError) void wiring.refetch()
    if (params.isError) void params.refetch()
  }

  return (
    <section className="rounded-[16px] border border-hairline bg-surface p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{
              background: 'var(--op-accent)',
              animation: isActive ? 'op-pulse 2.4s ease-in-out infinite' : undefined,
              opacity: isActive ? 1 : 0.5,
            }}
            aria-hidden="true"
          />
          <h3 className="text-base font-semibold text-fg">{chain?.name ?? `Chain ${chainId}`}</h3>
        </div>
        {isActive && (
          <span className="rounded-full border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] px-2 py-0.5 text-[11px] font-medium text-accent-ink">
            active
          </span>
        )}
      </div>

      {error ? (
        <div className="rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-4">
          <p className="text-sm text-danger">
            Couldn't read this chain's protocol state from the RPC. Public endpoints
            rate-limit — retrying usually fixes it, or set a custom RPC in settings.
          </p>
          <p className="mt-1 break-all font-mono text-xs text-danger">
            {error.message.split('\n')[0]}
          </p>
          <button
            onClick={refetch}
            className="mt-3 rounded-md border border-[var(--op-danger-bd)] px-3 py-1.5 text-sm text-danger hover:bg-[var(--op-danger-soft)]"
          >
            Retry
          </button>
        </div>
      ) : isLoading ? (
        <SkeletonRows count={8} />
      ) : (
        <div>
          <Row label="Market factory">
            {marketFactory && <AddressValue address={marketFactory} chainId={chainId} />}
          </Row>
          <Row label="Yield contract factory">
            {yieldContractFactory && <AddressValue address={yieldContractFactory} chainId={chainId} />}
          </Row>
          <Row label="Router V4">
            {router && <AddressValue address={router} chainId={chainId} />}
          </Row>
          <Row label="SY factory">
            {syFactory && <AddressValue address={syFactory} chainId={chainId} />}
          </Row>
          <Row label="Expiry divisor">
            <span className="font-mono text-sm text-fg tabular-nums">
              {expiryDivisor !== undefined && formatExpiryDivisor(expiryDivisor)}
            </span>
          </Row>
          <Row label="YT interest fee">
            <span className="font-mono text-sm text-fg tabular-nums">
              {interestFeeRate !== undefined && formatRate1e18(interestFeeRate)}
            </span>
          </Row>
          <Row label="Treasury">
            {ycfTreasury && <AddressValue address={ycfTreasury} chainId={chainId} />}
          </Row>
          <Row label="Max swap fee">
            <span className="font-mono text-sm text-fg tabular-nums">
              {maxLnFeeRateRoot !== undefined && formatLnFeeCap(maxLnFeeRateRoot)}
            </span>
          </Row>
        </div>
      )}
    </section>
  )
}
