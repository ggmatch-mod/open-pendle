/**
 * "Recover a deployment" affordance (PLAN M6). If the success receipt was
 * missed (closed tab / RPC drop), paste the deploy tx hash and we pull the
 * market out of its receipt via recoverDeploymentFromTx, then link to it.
 *
 * recoverDeploymentFromTx throws until the data layer wires it — the handler
 * try/catches so a throw becomes a friendly "couldn't recover" line, never a
 * page crash.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import type { DeployResult } from '../../lib/types'
import { recoverDeploymentFromTx } from '../../lib/deploy'
import { useActiveChain } from '../../lib/hooks'
import { shortAddress } from '../format'

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

export function DeployRecovery() {
  // M8: recover the deploy on the ACTIVE chain (where it was deployed), not the
  // wagmi default (Ethereum).
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const [hash, setHash] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DeployResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const trimmed = hash.trim()
  const validHash = TX_HASH_RE.test(trimmed)

  async function recover(): Promise<void> {
    if (!validHash || !client) return
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      const found = await recoverDeploymentFromTx(
        client as PublicClient,
        trimmed as `0x${string}`,
      )
      if (found) setResult(found)
      else setError('No pool deployment was found in that transaction.')
    } catch (e) {
      // The lib stub throws pre-integration; real failures (bad hash, RPC) land
      // here too. Either way: a friendly line, not a crash.
      setError(
        e instanceof Error
          ? `Couldn't recover from that transaction (${e.message}).`
          : "Couldn't recover from that transaction.",
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="group rounded-xl border border-hairline bg-surface">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted hover:text-fg">
        Recover a deployment
      </summary>
      <div className="border-t border-hairline px-4 py-3">
        <p className="text-xs leading-relaxed text-muted">
          Deployed a pool but lost the address (closed tab, RPC dropped)? Paste
          the deploy transaction hash and we'll pull the market out of its
          receipt.
        </p>
        <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={hash}
            onChange={(e) => setHash(e.target.value)}
            placeholder="0x… (66-character tx hash)"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-hairline-strong bg-bg px-3 py-2 font-mono text-xs text-fg placeholder-[color:var(--op-faint)] outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void recover()}
            disabled={!validHash || busy || !client}
            className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-faint"
          >
            {busy ? 'Recovering…' : 'Recover'}
          </button>
        </div>
        {trimmed.length > 0 && !validHash && (
          <p className="mt-1.5 text-xs text-warn">
            A transaction hash is 0x followed by 64 hex characters.
          </p>
        )}
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        {result && (
          <div className="mt-2.5 rounded-lg border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.1)] px-3 py-2.5">
            <p className="text-xs text-accent-ink/90">
              Found market{' '}
              <span className="font-mono text-accent-ink" title={result.market}>
                {shortAddress(result.market)}
              </span>
            </p>
            <Link
              to={`/market/${result.market}`}
              className="mt-2 inline-block rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110"
            >
              Open the pool →
            </Link>
          </div>
        )}
      </div>
    </details>
  )
}
