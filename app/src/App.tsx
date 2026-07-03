/**
 * OpenPendle M0 shell — dark-themed, fully browsable with no wallet.
 * Market loading (paste → validate → pool page) arrives in M1; for now the
 * paste box only checks address format.
 */

import { useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { isAddress } from 'viem'
import { ProtocolStatus } from './components/ProtocolStatus'
import { RpcSettings } from './components/RpcSettings'
import { WrongNetworkBanner } from './components/WrongNetworkBanner'

function MarketPasteBox() {
  const [input, setInput] = useState('')
  const trimmed = input.trim()

  let feedback: { tone: 'ok' | 'bad'; text: string } | null = null
  if (trimmed.length > 0) {
    feedback = isAddress(trimmed, { strict: false })
      ? { tone: 'ok', text: 'Valid address format — market loading arrives in M1.' }
      : { tone: 'bad', text: 'That does not look like a valid address (0x + 40 hex characters).' }
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      <label htmlFor="market-address" className="sr-only">
        Market address
      </label>
      <input
        id="market-address"
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Paste a Pendle market (PLP) address — 0x…"
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3.5 font-mono text-sm text-zinc-100 placeholder-zinc-500 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
      />
      <p
        aria-live="polite"
        className={`mt-2 min-h-5 text-sm ${
          feedback === null
            ? 'text-transparent'
            : feedback.tone === 'ok'
              ? 'text-emerald-400'
              : 'text-red-400'
        }`}
      >
        {feedback?.text ?? ' '}
      </p>
    </div>
  )
}

function WhatIsThis() {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="text-base font-semibold text-zinc-100">What is this?</h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        OpenPendle is an open-source, backend-free interface for{' '}
        <span className="text-zinc-200">Pendle V2 community pools</span> on Arbitrum —
        the permissionless markets the official app doesn't list. Everything reads
        straight from the chain and every transaction goes through Pendle's canonical
        contracts, so protocol fees flow to Pendle's treasury exactly as the contracts
        enforce.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        <span className="text-zinc-200">Where do I find a market address?</span>{' '}
        Community pool creators share their market (PLP) address directly — in Discord,
        on X, or via an Arbiscan link. It's the address of the{' '}
        <span className="font-mono text-xs">PendleMarket</span> contract itself. Paste
        it above; loading and validation land in M1.
      </p>
    </section>
  )
}

export default function App() {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100 antialiased">
      <WrongNetworkBanner />

      <header className="border-b border-zinc-800/80">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3.5">
          <span className="text-lg font-bold tracking-tight">
            <span className="text-emerald-400">Open</span>Pendle
          </span>
          <div className="flex items-center gap-2.5">
            <RpcSettings />
            <ConnectButton showBalance={false} accountStatus="address" chainStatus="icon" />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4">
        <section className="py-14 text-center">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Pendle community pools,{' '}
            <span className="text-emerald-400">no whitelist</span>
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-zinc-400 sm:text-base">
            Load any Pendle V2 market on Arbitrum by address. No backend, no curation —
            just the chain.
          </p>
          <div className="mt-8">
            <MarketPasteBox />
          </div>
        </section>

        <div className="grid gap-6 pb-14 md:grid-cols-2">
          <WhatIsThis />
          <ProtocolStatus />
        </div>
      </main>

      <footer className="border-t border-zinc-800/80">
        <div className="mx-auto max-w-4xl px-4 py-5 text-center">
          <p className="text-xs leading-relaxed text-zinc-500">
            Community pools are permissionless and{' '}
            <span className="text-amber-400/90">unreviewed — use at your own risk</span>.
            OpenPendle validates market provenance but cannot vouch for the assets or SY
            contracts underneath. Not affiliated with Pendle Finance.
          </p>
        </div>
      </footer>
    </div>
  )
}
