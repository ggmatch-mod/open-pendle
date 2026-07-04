/**
 * AddressChip — short checksummed address with copy-to-clipboard and a
 * block-explorer link. Used in market headers and token strips. M8: links to
 * the ACTIVE chain's explorer (reads useActiveChain internally so callsites
 * stay unchanged).
 */

import { useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { useActiveChain } from '../lib/hooks'
import { explorerAddressUrl, explorerName, shortAddress } from './format'

export function AddressChip({
  address,
  className = '',
}: {
  address: Address
  className?: string
}) {
  const { chainId } = useActiveChain()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable (permissions/insecure context) — no-op.
    }
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="font-mono text-xs text-zinc-400" title={address}>
        {shortAddress(address)}
      </span>
      <button
        onClick={copy}
        title={copied ? 'Copied!' : 'Copy address'}
        aria-label={copied ? 'Copied' : `Copy address ${address}`}
        className="rounded p-0.5 text-xs leading-none text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      >
        {copied ? <span className="text-emerald-400">✓</span> : <span aria-hidden>⧉</span>}
      </button>
      <a
        href={explorerAddressUrl(chainId, address)}
        target="_blank"
        rel="noreferrer"
        title={`View on ${explorerName(chainId)}`}
        aria-label={`View ${address} on ${explorerName(chainId)}`}
        className="rounded p-0.5 text-xs leading-none text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
      >
        <span aria-hidden>↗</span>
      </a>
    </span>
  )
}
