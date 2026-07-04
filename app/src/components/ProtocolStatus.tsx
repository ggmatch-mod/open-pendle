/**
 * ProtocolStatus — live-reads the protocol wiring straight from the ACTIVE
 * chain (M8: was Arbitrum-hardcoded). The commonDeploy entry point and every
 * read are resolved/routed for useActiveChain().chainId, so switching the
 * network dropdown re-reads this card against the new chain.
 *
 * Stage 1: resolve active marketFactory / yieldContractFactory / router /
 *          syFactory from commonDeploy's immutables (PLAN F12).
 * Stage 2: read governance-mutable values (expiryDivisor, interestFeeRate,
 *          treasury, maxLnFeeRateRoot) from the resolved factories.
 *
 * All reads go through the active chain's RPC transport (multicall-batched) —
 * no wallet needed. Retries are TanStack Query defaults, which absorb flaky
 * public-RPC hiccups.
 */

import type { ReactNode } from 'react'
import { useReadContracts } from 'wagmi'
import type { Address } from 'viem'
import { addressBookFor } from '../lib/addresses'
import { useActiveChain } from '../lib/hooks'
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

function AddressValue({
  address,
  chainId,
}: {
  address: Address
  chainId: import('../lib/types').SupportedChainId
}) {
  return (
    <a
      href={explorerAddressUrl(chainId, address)}
      target="_blank"
      rel="noreferrer"
      title={address}
      className="font-mono text-sm text-accent-ink hover:text-accent-ink hover:underline"
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

export function ProtocolStatus() {
  // M8: everything reads the ACTIVE chain. commonDeploy is the same address on
  // every chain, but we resolve it via the active chain's book (single source
  // of truth) and route every read with chainId: activeChainId so the wiring/
  // fee reads land on the selected network.
  const { chainId: activeChainId, chain } = useActiveChain()
  const commonDeploy = addressBookFor(activeChainId).commonDeploy

  // Stage 1 — resolve the active wiring from commonDeploy's immutables.
  const wiring = useReadContracts({
    allowFailure: false,
    contracts: [
      { chainId: activeChainId, address: commonDeploy, abi: commonDeployAbi, functionName: 'marketFactory' },
      { chainId: activeChainId, address: commonDeploy, abi: commonDeployAbi, functionName: 'yieldContractFactory' },
      { chainId: activeChainId, address: commonDeploy, abi: commonDeployAbi, functionName: 'router' },
      { chainId: activeChainId, address: commonDeploy, abi: commonDeployAbi, functionName: 'syFactory' },
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
            { chainId: activeChainId, address: yieldContractFactory, abi: yieldContractFactoryAbi, functionName: 'expiryDivisor' },
            { chainId: activeChainId, address: yieldContractFactory, abi: yieldContractFactoryAbi, functionName: 'interestFeeRate' },
            { chainId: activeChainId, address: yieldContractFactory, abi: yieldContractFactoryAbi, functionName: 'treasury' },
            { chainId: activeChainId, address: marketFactory, abi: marketFactoryAbi, functionName: 'maxLnFeeRateRoot' },
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
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">Protocol status</h2>
        <span className="rounded-full border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] px-2 py-0.5 text-xs text-accent-ink">
          live from {chain.name}
        </span>
      </div>
      <p className="mb-4 text-xs text-faint">
        Active factories are resolved from commonDeploy's immutables at runtime; fee
        parameters are governance-mutable and read live, never hardcoded.
      </p>

      {error ? (
        <div className="rounded-lg border border-[var(--op-danger-bd)] bg-[var(--op-danger-soft)] p-4">
          <p className="text-sm text-danger">
            Couldn't read protocol state from the RPC. Public endpoints rate-limit —
            retrying usually fixes it, or set a custom RPC in settings.
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
          <Row label="Active market factory">
            {marketFactory && <AddressValue address={marketFactory} chainId={activeChainId} />}
          </Row>
          <Row label="Active yield contract factory">
            {yieldContractFactory && (
              <AddressValue address={yieldContractFactory} chainId={activeChainId} />
            )}
          </Row>
          <Row label="Router V4">
            {router && <AddressValue address={router} chainId={activeChainId} />}
          </Row>
          <Row label="SY factory">
            {syFactory && <AddressValue address={syFactory} chainId={activeChainId} />}
          </Row>
          <Row label="Expiry divisor">
            <span className="font-mono text-sm text-fg">
              {expiryDivisor !== undefined && formatExpiryDivisor(expiryDivisor)}
            </span>
          </Row>
          <Row label="YT interest fee">
            <span className="font-mono text-sm text-fg">
              {interestFeeRate !== undefined && formatRate1e18(interestFeeRate)}
            </span>
          </Row>
          <Row label="Treasury">
            {ycfTreasury && <AddressValue address={ycfTreasury} chainId={activeChainId} />}
          </Row>
          <Row label="Max swap fee (cap)">
            <span className="font-mono text-sm text-fg">
              {maxLnFeeRateRoot !== undefined && formatLnFeeCap(maxLnFeeRateRoot)}
            </span>
          </Row>
        </div>
      )}
    </section>
  )
}
