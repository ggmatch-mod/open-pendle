/**
 * AddressChip — short checksummed address with copy-to-clipboard and an
 * Arbiscan link. Used in market headers and token strips.
 */

import { useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { arbiscanAddressUrl, shortAddress } from './format'

export function AddressChip({
  address,
  className = '',
}: {
  address: Address
  className?: string
}) {
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
        href={arbiscanAddressUrl(address)}
        target="_blank"
        rel="noreferrer"
        title="View on Arbiscan"
        aria-label={`View ${address} on Arbiscan`}
        className="rounded p-0.5 text-xs leading-none text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
      >
        <span aria-hidden>↗</span>
      </a>
    </span>
  )
}
