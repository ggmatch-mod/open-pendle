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
import { arbiscanAddressUrl, arbiscanTxUrl } from '../format'

function OracleCta() {
  return (
    <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/50">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-300 hover:text-zinc-100">
        Optional: initialize the price oracle
      </summary>
      <div className="border-t border-zinc-800 px-3 py-2.5">
        <p className="text-xs leading-relaxed text-zinc-400">
          New pools start with a TWAP oracle cardinality of 1. A one-time
          cardinality bump lets the pool record enough price observations for
          robust TWAP pricing later (used by lending markets and dashboards). It
          is <span className="text-zinc-300">not</span> required to trade, add
          liquidity, or quote through the router — those work immediately.
        </p>
        <p className="mt-2 text-[11px] leading-snug text-zinc-500">
          This optional transaction is a planned follow-up step and isn't wired
          into this build yet. You can safely deploy and trade without it and
          initialize the oracle later from the pool page.
        </p>
        <button
          type="button"
          disabled
          className="mt-2.5 cursor-not-allowed rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-500"
          title="Oracle initialization ships as a follow-up step."
        >
          Initialize oracle (coming soon)
        </button>
      </div>
    </details>
  )
}

export function DeploySuccess({ txHash }: { txHash: `0x${string}` }) {
  const client = usePublicClient()
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
    <section className="rounded-xl border border-emerald-700 bg-emerald-950/40 p-5">
      <div className="flex items-center gap-2">
        <span className="text-lg" aria-hidden>
          ✓
        </span>
        <h2 className="text-base font-semibold text-emerald-200">
          Pool deployed and seeded
        </h2>
      </div>

      <p className="mt-2 text-xs text-emerald-200/80">
        Your deploy transaction confirmed:{' '}
        <a
          href={arbiscanTxUrl(txHash)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-emerald-300 underline decoration-emerald-800 underline-offset-2 hover:text-emerald-200"
        >
          {txHash.slice(0, 10)}…{txHash.slice(-6)} ↗
        </a>
      </p>

      {result ? (
        <div className="mt-3 rounded-lg border border-emerald-800 bg-emerald-950/50 p-3">
          <p className="text-xs text-emerald-200/80">New market (PLP) address</p>
          <p className="mt-0.5 break-all font-mono text-sm text-emerald-100" title={result.market}>
            {result.market}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Link
              to={`/market/${result.market}`}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Open the pool →
            </Link>
            <a
              href={arbiscanAddressUrl(result.market)}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-emerald-300/80 underline decoration-emerald-800 underline-offset-2 hover:text-emerald-200"
            >
              View on Arbiscan
            </a>
          </div>
          <p className="mt-2 text-[11px] text-emerald-300/70">
            Opening the pool loads it live — tick “Remember this pool” there to
            save it to your local registry.
          </p>
        </div>
      ) : decodeFailed ? (
        <div className="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3">
          <p className="text-xs text-amber-200/90">
            The transaction confirmed, but the market address couldn't be read
            from the receipt automatically. Use “Recover a deployment” below with
            the transaction hash above to retrieve it.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-emerald-200/70">
          Reading the new market address from the receipt…
        </p>
      )}

      <OracleCta />
    </section>
  )
}
