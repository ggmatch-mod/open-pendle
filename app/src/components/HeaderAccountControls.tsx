import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useRegistry } from '../lib/hooks'
import { useTheme } from '../theme/useTheme'
import { ThemeToggle } from '../theme/ThemeToggle'
import { NetworkPicker } from './NetworkPicker'
import { NetworkSelector } from './NetworkSelector'
import { RpcSettings, RpcSettingsForm } from './RpcSettings'
import { useNetworkSelection } from './useNetworkSelection'

const PROFILE_PANEL_ID = 'openpendle-profile-panel'

function ProfilePanel({
  account,
  chainName,
  onClose,
  onManageWallet,
}: {
  account: { address: string; displayName: string }
  chainName: string
  onClose: () => void
  onManageWallet: () => void
}) {
  const { pools } = useRegistry()
  const { theme, toggle } = useTheme()
  const { chainId, isTransactionInFlight } = useNetworkSelection()

  return (
    <div
      id={PROFILE_PANEL_ID}
      role="dialog"
      aria-label="Profile and settings"
      data-testid="profile-panel"
      className="absolute right-[-42px] top-[calc(100%+8px)] z-50 max-h-[min(72vh,640px)] w-[min(320px,calc(100vw-24px))] overflow-y-auto rounded-[16px] border border-hairline bg-surface shadow-[var(--op-shadow-lg)] xl:right-0"
    >
      <div className="border-b border-hairline px-4 py-3.5">
        <p className="font-mono text-[10px] uppercase tracking-[.08em] text-faint">
          Connected wallet
        </p>
        <div className="mt-2 flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgba(var(--op-accent-rgb),0.14)] font-mono text-[10px] font-semibold text-accent-ink"
          >
            {account.address.slice(2, 4).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{account.displayName}</p>
            <p className="mt-0.5 truncate text-[11px] text-faint">{chainName}</p>
          </div>
        </div>
      </div>

      <nav aria-label="Profile pages" className="p-1.5">
        <Link
          to="/pools"
          onClick={onClose}
          className="flex items-center justify-between rounded-[10px] px-3 py-2.5 text-sm font-medium text-fg no-underline hover:bg-surface-2"
        >
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="w-4 text-center text-accent-ink">★</span>
            Saved pools
          </span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-faint">
            {pools.length}
          </span>
        </Link>
        <Link
          to="/positions"
          onClick={onClose}
          className="flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-sm font-medium text-fg no-underline hover:bg-surface-2"
        >
          <span aria-hidden className="w-4 text-center text-accent-ink">◈</span>
          Positions
        </Link>
        <Link
          to="/alerts"
          onClick={onClose}
          className="flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-sm font-medium text-fg no-underline hover:bg-surface-2"
        >
          <span aria-hidden className="w-4 text-center text-accent-ink">↕</span>
          Yield alerts
        </Link>
      </nav>

      <div className="border-t border-hairline px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-fg">Active network</p>
            <p className="mt-0.5 text-[10.5px] text-faint">
              {isTransactionInFlight ? 'Locked while a transaction is pending' : 'App reads and wallet'}
            </p>
          </div>
          <span className="font-mono text-[10px] text-faint">#{chainId}</span>
        </div>
        <NetworkPicker className="mt-2.5" />
      </div>

      <div className="border-t border-hairline px-4 py-3">
        <button
          type="button"
          role="switch"
          aria-checked={theme === 'dark'}
          onClick={toggle}
          className="flex min-h-10 w-full items-center justify-between gap-3 rounded-[10px] px-2.5 text-left text-sm text-fg hover:bg-surface-2"
        >
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="w-4 text-center text-accent-ink">
              {theme === 'dark' ? '☾' : '☀'}
            </span>
            {theme === 'dark' ? 'Dark mode' : 'Light mode'}
          </span>
          <span
            aria-hidden
            className={`relative h-5 w-9 rounded-full transition ${
              theme === 'dark' ? 'bg-accent' : 'bg-surface-3'
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${
                theme === 'dark' ? 'left-[18px]' : 'left-0.5'
              }`}
            />
          </span>
        </button>

        <details className="mt-1 rounded-[10px] border border-hairline bg-bg-2 px-3 py-2.5">
          <summary className="cursor-pointer select-none text-xs font-semibold text-fg">
            RPC endpoint
          </summary>
          <div className="mt-3 border-t border-hairline pt-3">
            <RpcSettingsForm compact />
          </div>
        </details>
      </div>

      <div className="border-t border-hairline p-2">
        <button
          type="button"
          onClick={() => {
            onClose()
            onManageWallet()
          }}
          className="flex min-h-10 w-full items-center justify-between rounded-[10px] px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg"
        >
          Manage wallet
          <span aria-hidden className="text-faint">→</span>
        </button>
      </div>
    </div>
  )
}

export function HeaderAccountControls() {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const location = useLocation()

  useEffect(() => {
    setOpen(false)
  }, [location.pathname, location.search])

  useEffect(() => {
    if (!open) return
    const animationFrame = window.requestAnimationFrame(() => {
      wrapperRef.current
        ?.querySelector<HTMLElement>(`#${PROFILE_PANEL_ID}`)
        ?.querySelector<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), summary')
        ?.focus()
    })
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        authenticationStatus,
        openAccountModal,
        openConnectModal,
      }) => {
        const ready = mounted && authenticationStatus !== 'loading'
        const connected =
          ready &&
          account !== undefined &&
          chain !== undefined &&
          (authenticationStatus === undefined || authenticationStatus === 'authenticated')

        if (!ready) {
          return (
            <div aria-hidden className="h-[34px] w-[102px] rounded-[10px] border border-hairline bg-surface opacity-50" />
          )
        }

        if (!connected) {
          return (
            <>
              <div className="hidden items-center gap-2 xl:flex">
                <NetworkSelector />
                <RpcSettings />
              </div>
              <ThemeToggle />
              <button
                type="button"
                data-testid="connect-wallet-button"
                onClick={openConnectModal}
                className="inline-flex h-[34px] items-center whitespace-nowrap rounded-[10px] bg-accent px-3 text-[12px] font-semibold leading-none text-white hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Connect wallet
              </button>
            </>
          )
        }

        return (
          <div ref={wrapperRef} className="relative">
            <button
              ref={triggerRef}
              type="button"
              data-testid="profile-trigger"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={PROFILE_PANEL_ID}
              onClick={() => setOpen((current) => !current)}
              className="inline-flex h-[34px] items-center gap-2 rounded-[10px] border border-hairline bg-surface px-2.5 text-[12px] font-semibold text-fg hover:border-hairline-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span
                aria-hidden
                className="flex h-5 w-5 items-center justify-center rounded-full bg-[rgba(var(--op-accent-rgb),0.14)] font-mono text-[8px] text-accent-ink"
              >
                {account.address.slice(2, 4).toUpperCase()}
              </span>
              Profile
              <span aria-hidden className="text-[10px] text-faint">{open ? '▴' : '▾'}</span>
            </button>

            {open && (
              <ProfilePanel
                account={account}
                chainName={chain.name ?? `Chain ${chain.id}`}
                onClose={() => setOpen(false)}
                onManageWallet={openAccountModal}
              />
            )}
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
