/**
 * OpenPendle app shell (reskin) — ticker + sticky header (split logo, Saved-pools
 * pill, Create-pool, network/RPC controls, theme toggle, connect), hash-routed
 * pages, and a footer with the Protocol-status link + license marker.
 *
 * The active-network shell keeps URL-bound market/token reads separate from the
 * persisted preferred chain, while explicit selector clicks also synchronize a
 * connected wallet.
 */
import { lazy, Suspense, useEffect, useRef } from 'react'
import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router-dom'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { NetworkSelector } from './components/NetworkSelector'
import { RpcSettings } from './components/RpcSettings'
import { MobileNav } from './components/MobileNav'
import { WrongNetworkBanner } from './components/WrongNetworkBanner'
import { ForgetUndoProvider } from './components/ForgetUndo'
import { Ticker } from './components/Ticker'
import { Logo, BrandMark } from './components/Logo'
import { ThemeToggle } from './theme/ThemeToggle'
import CreatePoolPage from './pages/CreatePoolPage'
import CreateSyPage from './pages/CreateSyPage'
import Home from './pages/Home'
import MarketPage from './pages/MarketPage'
import TokenPage from './pages/TokenPage'
import PoolsPage from './pages/PoolsPage'
import ExplorePage from './pages/ExplorePage'
import PositionsPage from './pages/PositionsPage'
import ProtocolStatusPage from './pages/ProtocolStatusPage'
import AboutPage from './pages/AboutPage'
import QuickStartPage from './pages/QuickStartPage'
import { useActiveChain } from './lib/hooks'
import { isChainAddressRoute, routeChainId } from './lib/routes'

const AlertsPage = lazy(() => import('./pages/AlertsPage'))
const LoopingPage = lazy(() => import('./pages/LoopingPage'))

function PageFallback() {
  return (
    <div className="space-y-4 py-10" aria-busy="true" aria-label="Loading page">
      <div className="h-7 w-56 animate-pulse rounded bg-surface-2" />
      <div className="h-24 animate-pulse rounded-xl bg-surface" />
      <div className="h-52 animate-pulse rounded-xl bg-surface" />
    </div>
  )
}

function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold text-fg">Page not found</h1>
      <p className="mt-2 text-sm text-muted">Nothing lives at this route.</p>
      <Link
        to="/"
        className="mt-6 inline-block rounded-[10px] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:brightness-110"
      >
        ← Back home
      </Link>
    </div>
  )
}

/**
 * A market/token deep link carries `?chain=<id>`. Gate route mounting until the
 * active read client matches it, so a shared address is never queried on the
 * recipient's previous/default network first.
 */
function AppRoutes() {
  const location = useLocation()
  const navigate = useNavigate()
  const chainAddressRoute = isChainAddressRoute(location.pathname)
  const requestedChainId = chainAddressRoute ? routeChainId(location.search) : undefined
  const { chainId } = useActiveChain()
  const navigationType = useNavigationType()
  const previousPathname = useRef(location.pathname)

  useEffect(() => {
    const pathnameChanged = previousPathname.current !== location.pathname
    previousPathname.current = location.pathname
    if (pathnameChanged && navigationType !== 'POP') {
      window.scrollTo({ top: 0, left: 0 })
    }
  }, [location.pathname, navigationType])

  useEffect(() => {
    if (requestedChainId === undefined && chainAddressRoute) {
      const search = new URLSearchParams(location.search)
      search.set('chain', String(chainId))
      void navigate(
        { pathname: location.pathname, search: `?${search.toString()}` },
        { replace: true },
      )
    }
  }, [
    chainId,
    chainAddressRoute,
    location.pathname,
    location.search,
    navigate,
    requestedChainId,
  ])

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/quickstart" element={<QuickStartPage />} />
      <Route path="/explore" element={<ExplorePage />} />
      <Route
        path="/alerts"
        element={
          <Suspense fallback={<PageFallback />}>
            <AlertsPage />
          </Suspense>
        }
      />
      <Route
        path="/looping"
        element={
          <Suspense fallback={<PageFallback />}>
            <LoopingPage />
          </Suspense>
        }
      />
      <Route path="/pools" element={<PoolsPage />} />
      <Route path="/positions" element={<PositionsPage />} />
      <Route path="/status" element={<ProtocolStatusPage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/create" element={<CreatePoolPage />} />
      <Route path="/create-sy" element={<CreateSyPage />} />
      <Route path="/market/:address" element={<MarketPage />} />
      <Route path="/token/:address" element={<TokenPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

export default function App() {
  return (
    <ForgetUndoProvider>
    <div className="flex min-h-screen flex-col bg-bg text-fg antialiased">
      <WrongNetworkBanner />
      <Ticker />

      <header
        className="sticky top-0 z-50 border-b border-hairline backdrop-blur-md"
        style={{ background: 'var(--op-header)' }}
      >
        <div className="mx-auto flex h-16 max-w-[1320px] items-center justify-between gap-2 px-3 sm:gap-4 sm:px-7">
          <Logo />
          <div className="flex items-center gap-2">
            <Link
              to="/quickstart"
              className="hidden h-[34px] items-center gap-2 whitespace-nowrap rounded-[10px] border border-hairline bg-surface px-[13px] text-[13px] font-medium text-fg no-underline hover:bg-surface-2 xl:inline-flex"
            >
              <span aria-hidden className="text-[12px] text-accent-ink">
                ✦
              </span>
              Quick start
            </Link>
            <Link
              to="/explore"
              className="hidden h-[34px] items-center gap-2 whitespace-nowrap rounded-[10px] border border-[rgba(var(--op-accent-rgb),0.4)] bg-[rgba(var(--op-accent-rgb),0.08)] px-[13px] text-[13px] font-medium text-accent-ink no-underline hover:bg-[rgba(var(--op-accent-rgb),0.12)] xl:inline-flex"
            >
              <span aria-hidden className="text-[12px]">
                ◇
              </span>
              Explore
            </Link>
            <Link
              to="/alerts"
              className="hidden h-[34px] items-center gap-2 whitespace-nowrap rounded-[10px] border border-hairline bg-surface px-[13px] text-[13px] font-medium text-fg no-underline hover:bg-surface-2 xl:inline-flex"
            >
              <span aria-hidden className="text-[12px] text-accent-ink">
                ↕
              </span>
              Yield alerts
            </Link>
            <Link
              to="/looping"
              className="hidden h-[34px] items-center gap-2 whitespace-nowrap rounded-[10px] border border-hairline bg-surface px-[13px] text-[13px] font-medium text-fg no-underline hover:bg-surface-2 xl:inline-flex"
            >
              <span aria-hidden className="text-[12px] text-accent-ink">
                ↻
              </span>
              Looping
            </Link>
            <Link
              to="/positions"
              className="hidden h-[34px] items-center gap-2 whitespace-nowrap rounded-[10px] border border-hairline bg-surface px-[13px] text-[13px] font-medium text-fg no-underline hover:bg-surface-2 xl:inline-flex"
            >
              <span aria-hidden className="text-[12px] text-accent-ink">
                ◈
              </span>
              Positions
            </Link>
            <Link
              to="/pools"
              className="hidden h-[34px] items-center gap-2 whitespace-nowrap rounded-[10px] border border-hairline bg-surface px-[13px] text-[13px] font-medium text-fg no-underline hover:bg-surface-2 xl:inline-flex"
            >
              <span aria-hidden className="text-[12px] text-accent-ink">
                ★
              </span>
              Saved pools
            </Link>
            <Link
              to="/create"
              className="hidden h-[34px] items-center whitespace-nowrap rounded-[10px] px-[13px] text-[13px] font-semibold text-accent-ink no-underline hover:bg-[rgba(var(--op-accent-rgb),0.08)] xl:inline-flex"
              style={{ border: '1px solid rgba(var(--op-accent-rgb),.4)' }}
            >
              Create pool
            </Link>
            <span className="mx-0.5 hidden h-[22px] w-px bg-hairline xl:block" />
            <div className="hidden items-center gap-2 xl:flex">
              <NetworkSelector />
              <RpcSettings />
            </div>
            <ThemeToggle />
            <ConnectButton
              showBalance={false}
              accountStatus={{ smallScreen: 'avatar', largeScreen: 'address' }}
              chainStatus="none"
            />
            <MobileNav />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1160px] flex-1 px-4 sm:px-7">
        <AppRoutes />
      </main>

      <footer className="border-t border-hairline bg-bg-2">
        <div className="mx-auto flex max-w-[1160px] flex-wrap items-center justify-between gap-4 px-4 py-7 sm:px-7">
          <div className="flex items-center gap-[11px]">
            <BrandMark className="h-[22px] w-[22px] shrink-0" />
            <p className="max-w-[66ch] text-[12px] leading-relaxed text-faint">
              Community pools are permissionless and{' '}
              <span className="text-warn">unreviewed — use at your own risk</span>. OpenPendle
              validates market provenance but cannot vouch for the assets or SY contracts underneath.{' '}
              <span className="text-warn">Not affiliated with Pendle Finance.</span>{' '}
              <span className="text-accent-ink">
                OpenPendle is a gift to Pendle's community and takes no fee of its own.
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3.5">
            <Link to="/about" className="text-[12px] font-medium text-muted no-underline hover:text-accent-ink">
              About &amp; risks
            </Link>
            <span className="h-3 w-px bg-hairline" />
            <Link to="/status" className="text-[12px] font-medium text-muted no-underline hover:text-accent-ink">
              Protocol status
            </Link>
            <span className="h-3 w-px bg-hairline" />
            <a
              href="https://docs.openpendle.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] font-medium text-muted no-underline hover:text-accent-ink"
            >
              Docs
            </a>
            <span className="h-3 w-px bg-hairline" />
            <span className="whitespace-nowrap text-[12px] font-medium text-muted">
              <a
                href="https://x.com/openpendle"
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline hover:text-accent-ink"
              >
                @openpendle
              </a>{' '}
              by{' '}
              <a
                href="https://x.com/ggmxbt"
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline hover:text-accent-ink"
              >
                @ggmxbt
              </a>
            </span>
            <span className="h-3 w-px bg-hairline" />
            <span className="whitespace-nowrap font-mono text-[11px] tracking-[.04em] text-faint">
              GPL-3.0 · OPEN SOURCE
            </span>
          </div>
        </div>
      </footer>
    </div>
    </ForgetUndoProvider>
  )
}
