/**
 * OpenPendle app shell (M1) — header, wrong-network banner, hash-routed pages,
 * risk-disclaimer footer. Fully browsable with no wallet connected.
 * HashRouter (set up in main.tsx) keeps the SPA static-host/IPFS-friendly.
 */

import { Link, Route, Routes } from 'react-router-dom'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { NetworkSelector } from './components/NetworkSelector'
import { RpcSettings } from './components/RpcSettings'
import { WrongNetworkBanner } from './components/WrongNetworkBanner'
import CreatePoolPage from './pages/CreatePoolPage'
import CreateSyPage from './pages/CreateSyPage'
import Home from './pages/Home'
import MarketPage from './pages/MarketPage'

function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold text-zinc-100">Page not found</h1>
      <p className="mt-2 text-sm text-zinc-400">Nothing lives at this route.</p>
      <Link
        to="/"
        className="mt-6 inline-block rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
      >
        ← Back home
      </Link>
    </div>
  )
}

export default function App() {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100 antialiased">
      <WrongNetworkBanner />

      <header className="border-b border-zinc-800/80">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3.5">
          <Link to="/" className="text-lg font-bold tracking-tight hover:opacity-90">
            <span className="text-emerald-400">Open</span>Pendle
          </Link>
          <div className="flex items-center gap-2.5">
            <Link
              to="/create"
              className="hidden rounded-md border border-emerald-800 px-3 py-1.5 text-sm font-medium text-emerald-400 hover:border-emerald-600 hover:text-emerald-300 sm:inline-block"
            >
              Create pool
            </Link>
            <NetworkSelector />
            <RpcSettings />
            <ConnectButton showBalance={false} accountStatus="address" chainStatus="icon" />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<CreatePoolPage />} />
          <Route path="/create-sy" element={<CreateSyPage />} />
          <Route path="/market/:address" element={<MarketPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
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
