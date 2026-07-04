/**
 * Post-deploy success card for the M7 SY-adapter wizard. Mirrors
 * create/DeploySuccess.tsx: useActionFlow reaches 'confirmed' and hands us the
 * txHash; the flow does NOT expose receipt logs, so we fetch the receipt via
 * the public client and decode the SY (and, for the combined flow, the market)
 * with decodeSyDeployResult (lib).
 *
 * Two success shapes:
 *   - SY only      → show the new SY address + "Create a pool for this SY"
 *                    (→ /create with the SY prefilled via ?sy=).
 *   - SY + market  → show SY + market addresses + "Open the pool"
 *                    (→ /market/<market>, which loads it in M1's loader).
 *
 * Upgradeable proxy disclosure: for the advanced adapter templates the SY is a
 * TransparentUpgradeableProxy under Pendle's proxyAdmin — surfaced here so the
 * deployer sees it on the success screen too.
 *
 * decodeSyDeployResult THROWS until the data layer wires it — the receipt effect
 * try/catches so the confirmed state still renders (tx link + a "couldn't read
 * the address automatically" fallback), never a crash.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import type { SupportedChainId, SyDeployResult } from '../../lib/types'
import { decodeSyDeployResult } from '../../lib/syDeploy'
import { useActiveChain } from '../../lib/hooks'
import { explorerAddressUrl, explorerName, explorerTxUrl } from '../format'

function AddressRow({
  label,
  address,
  chainId,
}: {
  label: string
  address: string
  chainId: SupportedChainId
}) {
  return (
    <div className="rounded-lg border border-emerald-800 bg-emerald-950/50 p-3">
      <p className="text-xs text-emerald-200/80">{label}</p>
      <p className="mt-0.5 break-all font-mono text-sm text-emerald-100" title={address}>
        {address}
      </p>
      <a
        href={explorerAddressUrl(chainId, address)}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-block text-xs text-emerald-300/80 underline decoration-emerald-800 underline-offset-2 hover:text-emerald-200"
      >
        View on {explorerName(chainId)} ↗
      </a>
    </div>
  )
}

export function SyDeploySuccess({
  txHash,
  upgradeable,
}: {
  txHash: `0x${string}`
  /** True when the chosen template deploys an upgradeable proxy (advanced path). */
  upgradeable: boolean
}) {
  // M8: read the deploy receipt on the ACTIVE chain (deploy target), and link
  // to that chain's explorer.
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const [result, setResult] = useState<SyDeployResult | undefined>(undefined)
  const [decodeFailed, setDecodeFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function decode(): Promise<void> {
      if (!client) return
      try {
        const receipt = await (client as PublicClient).getTransactionReceipt({
          hash: txHash,
        })
        const decoded = decodeSyDeployResult(receipt.logs)
        if (cancelled) return
        if (decoded) setResult(decoded)
        else setDecodeFailed(true)
      } catch {
        // decodeSyDeployResult throws pre-integration; a missing receipt or RPC
        // error lands here too. Fall back to the tx link + a friendly hint.
        if (!cancelled) setDecodeFailed(true)
      }
    }
    void decode()
    return () => {
      cancelled = true
    }
  }, [client, txHash])

  const combined = result?.market !== undefined

  return (
    <section className="rounded-xl border border-emerald-700 bg-emerald-950/40 p-5">
      <div className="flex items-center gap-2">
        <span className="text-lg" aria-hidden>
          ✓
        </span>
        <h2 className="text-base font-semibold text-emerald-200">
          {combined ? 'SY and pool deployed' : 'SY deployed'}
        </h2>
      </div>

      <p className="mt-2 text-xs text-emerald-200/80">
        Your deploy transaction confirmed:{' '}
        <a
          href={explorerTxUrl(chainId, txHash)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-emerald-300 underline decoration-emerald-800 underline-offset-2 hover:text-emerald-200"
        >
          {txHash.slice(0, 10)}…{txHash.slice(-6)} ↗
        </a>
      </p>

      {result ? (
        <div className="mt-3 space-y-2.5">
          <AddressRow
            label="New SY (Standardized Yield) address"
            address={result.sy}
            chainId={chainId}
          />
          {result.market && (
            <AddressRow label="New market (PLP) address" address={result.market} chainId={chainId} />
          )}

          {upgradeable && (
            <p className="rounded-md border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-[11px] leading-snug text-amber-200/90">
              This SY is a TransparentUpgradeableProxy under Pendle's proxyAdmin.
              Its implementation can be upgraded by Pendle governance — disclose
              this to anyone using the pool.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {result.market ? (
              <Link
                to={`/market/${result.market}`}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
              >
                Open the pool →
              </Link>
            ) : (
              <Link
                to={`/create?sy=${result.sy}`}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
              >
                Create a pool for this SY →
              </Link>
            )}
          </div>
          <p className="text-[11px] text-emerald-300/70">
            {result.market
              ? 'Opening the pool loads it live — tick “Remember this pool” there to save it to your local registry.'
              : 'This SY has no market yet. Create one to make it tradeable; the create wizard opens with the SY prefilled.'}
          </p>
        </div>
      ) : decodeFailed ? (
        <div className="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3">
          <p className="text-xs text-amber-200/90">
            The transaction confirmed, but the deployed address couldn't be read
            from the receipt automatically. Open the transaction on{' '}
            {explorerName(chainId)} (link above) to find the new SY (and market)
            in its event logs.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-emerald-200/70">
          Reading the new SY address from the receipt…
        </p>
      )}
    </section>
  )
}
