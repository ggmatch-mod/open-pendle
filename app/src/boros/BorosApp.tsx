import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useEffect } from 'react'
import { BrandMark } from '../components/Logo'
import { markAppReady } from '../lib/preloadRecovery'
import BorosHedgePage from '../pages/BorosHedgePage'
import { ThemeToggle } from '../theme/ThemeToggle'

function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, mounted, openAccountModal, openConnectModal }) => {
        if (!mounted) return <div className="h-[34px] w-28 rounded-[10px] bg-surface-2" />
        if (account === undefined) {
          return (
            <button
              type="button"
              onClick={openConnectModal}
              className="h-[34px] rounded-[10px] bg-accent px-3 text-[12px] font-semibold text-accent-fg hover:brightness-110"
            >
              Connect wallet
            </button>
          )
        }
        return (
          <button
            type="button"
            onClick={openAccountModal}
            className="inline-flex h-[34px] items-center gap-2 rounded-[10px] border border-hairline bg-surface px-3 font-mono text-[11px] font-medium text-fg hover:bg-surface-2"
          >
            <span className="h-2 w-2 rounded-full bg-good" />
            {account.displayName}
          </button>
        )
      }}
    </ConnectButton.Custom>
  )
}

export default function BorosApp() {
  useEffect(() => {
    markAppReady()
  }, [])

  return (
    <div
      data-openpendle-startup="ready"
      className="flex min-h-screen flex-col bg-bg text-fg antialiased"
    >
      <header
        className="sticky top-0 z-50 border-b border-hairline backdrop-blur-md"
        style={{ background: 'var(--op-header)' }}
      >
        <div className="mx-auto flex h-16 max-w-[1220px] items-center justify-between gap-3 px-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="h-7 w-7 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight text-fg">Boros Hedge</p>
              <p className="truncate font-mono text-[9px] uppercase tracking-[.1em] text-faint">by OpenPendle</p>
            </div>
            <span className="hidden rounded-full border border-hairline bg-surface px-2 py-0.5 font-mono text-[9px] uppercase tracking-[.08em] text-faint sm:inline-flex">
              Prototype
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <WalletButton />
          </div>
        </div>
      </header>

      <BorosHedgePage />

      <footer className="mt-auto border-t border-hairline bg-bg-2">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3 px-4 py-6 text-[11px] text-faint sm:px-7">
          <p>Quote-only prototype · No transaction is submitted from this surface.</p>
          <div className="flex items-center gap-3">
            <a href="https://docs.pendle.finance/boros-docs/Introduction" target="_blank" rel="noopener noreferrer" className="text-muted no-underline hover:text-fg">Boros docs ↗</a>
            <a href="https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api" target="_blank" rel="noopener noreferrer" className="text-muted no-underline hover:text-fg">Hyperliquid API ↗</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
