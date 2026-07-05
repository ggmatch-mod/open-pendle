/**
 * Post-deploy success card (PLAN M6). Once useActionFlow reaches 'confirmed'
 * the page hands us the txHash; useActionFlow does NOT expose the receipt logs,
 * so we fetch the receipt via the public client and decode the market address
 * with decodeDeploymentResult (lib). We then:
 *   - show the new market address,
 *   - offer "Open the pool" (→ /market/<addr>, which loads it in M1's loader
 *     and lets the user tick Remember there), and
 *   - render the optional "Initialize price oracle" CTA.
 *
 * decodeDeploymentResult throws until the data layer wires it — the receipt
 * effect try/catches so the confirmed state still renders (with the tx link and
 * a "couldn't read the address automatically — recover it below" fallback).
 *
 * Oracle-init decision: the actual cardinality-bump tx is DEFERRED to a
 * follow-up (see the CTA copy + the agent report). We surface it as a clearly
 * labeled optional step with a short explainer rather than half-wiring a second
 * action flow, because it needs an oracle/market ABI this UI must not add to
 * lib and is a one-time nicety, not required for trading or quoting.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import type { DeployResult } from '../../lib/types'
import { decodeDeploymentResult } from '../../lib/deploy'
import { useActiveChain } from '../../lib/hooks'
import { explorerAddressUrl, explorerName, explorerTxUrl } from '../format'

function OracleCta() {
  return (
    <details className="group mt-3 rounded-lg border border-hairline bg-bg/50">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted hover:text-fg">
        Optional: initialize the price oracle
      </summary>
      <div className="border-t border-hairline px-3 py-2.5">
        <p className="text-xs leading-relaxed text-muted">
          New pools start with a TWAP oracle cardinality of 1. A one-time
          cardinality bump lets the pool record enough price observations for
          robust TWAP pricing later (used by lending markets and dashboards). It
          is <span className="text-muted">not</span> required to trade, add
          liquidity, or quote through the router — those work immediately.
        </p>
        <p className="mt-2 text-[11px] leading-snug text-faint">
          A one-click initialize step is planned for a later OpenPendle update. If
          you need it now, call{' '}
          <span className="font-mono">increaseObservationsCardinalityNext</span> on
          the market contract from a block explorer. It's safe to skip.
        </p>
      </div>
    </details>
  )
}

export function DeploySuccess({ txHash }: { txHash: `0x${string}` }) {
  // M8: read the deploy receipt on the ACTIVE chain (deploy target), and link
  // to that chain's explorer.
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const [result, setResult] = useState<DeployResult | undefined>(undefined)
  const [decodeFailed, setDecodeFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function decode(): Promise<void> {
      if (!client) return
      try {
        const receipt = await (client as PublicClient).getTransactionReceipt({
          hash: txHash,
        })
        const decoded = decodeDeploymentResult(receipt.logs)
        if (cancelled) return
        if (decoded) setResult(decoded)
        else setDecodeFailed(true)
      } catch {
        // decodeDeploymentResult throws pre-integration; a missing receipt or
        // RPC error lands here too. Fall back to the tx link + recovery hint.
        if (!cancelled) setDecodeFailed(true)
      }
    }
    void decode()
    return () => {
      cancelled = true
    }
  }, [client, txHash])

  return (
    <section className="rounded-xl border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] p-5">
      <div className="flex items-center gap-2">
        <span className="text-lg" aria-hidden>
          ✓
        </span>
        <h2 className="text-base font-semibold text-accent-ink">
          Pool deployed and seeded
        </h2>
      </div>

      <p className="mt-2 text-xs text-accent-ink/80">
        Your deploy transaction confirmed:{' '}
        <a
          href={explorerTxUrl(chainId, txHash)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-accent-ink underline decoration-[rgba(var(--op-accent-rgb),0.5)] underline-offset-2 hover:text-accent-ink"
        >
          {txHash.slice(0, 10)}…{txHash.slice(-6)} ↗
        </a>
      </p>

      {result ? (
        <div className="mt-3 rounded-lg border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] p-3">
          <p className="text-xs text-accent-ink/80">New market (PLP) address</p>
          <p className="mt-0.5 break-all font-mono text-sm text-fg" title={result.market}>
            {result.market}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Link
              to={`/market/${result.market}`}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
            >
              Open the pool →
            </Link>
            <a
              href={explorerAddressUrl(chainId, result.market)}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-accent-ink/80 underline decoration-[rgba(var(--op-accent-rgb),0.5)] underline-offset-2 hover:text-accent-ink"
            >
              View on {explorerName(chainId)}
            </a>
          </div>
          <p className="mt-2 text-[11px] text-accent-ink/70">
            Opening the pool loads it live — tick “Remember this pool” there to
            save it to your local registry.
          </p>
        </div>
      ) : decodeFailed ? (
        <div className="mt-3 rounded-lg border border-[var(--op-warn-bd)] bg-amber-950/30 p-3">
          <p className="text-xs text-warn">
            The transaction confirmed, but the market address couldn't be read
            from the receipt automatically. Use “Recover a deployment” below with
            the transaction hash above to retrieve it.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-accent-ink/70">
          Reading the new market address from the receipt…
        </p>
      )}

      <OracleCta />
    </section>
  )
}
