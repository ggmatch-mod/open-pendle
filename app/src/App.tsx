/**
 * OpenPendle app shell — ticker + sticky product navigation, compact wallet /
 * profile controls, hash-routed pages, and the footer.
 *
 * The active-network shell keeps URL-bound market/token reads separate from the
 * persisted preferred chain, while explicit selector clicks also synchronize a
 * connected wallet.
 */
import { lazy, Suspense, useEffect, useRef } from 'react'
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router-dom'
import { MobileNav } from './components/MobileNav'
import { HeaderAccountControls } from './components/HeaderAccountControls'
import { WrongNetworkBanner } from './components/WrongNetworkBanner'
import { ForgetUndoProvider } from './components/ForgetUndo'
import { Ticker } from './components/Ticker'
import { Logo, BrandMark } from './components/Logo'
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
import { markAppReady } from './lib/preloadRecovery'

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
      <p className="mt-2 text-sm text-muted">This page doesn't exist.</p>
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
  useEffect(() => {
    markAppReady()
  }, [])

  return (
    <ForgetUndoProvider>
    <div
      data-openpendle-release="looping-preview-v1.1"
      data-openpendle-startup="ready"
      className="flex min-h-screen flex-col bg-bg text-fg antialiased"
    >
      <WrongNetworkBanner />
      <Ticker />

      <header
        className="sticky top-0 z-50 border-b border-hairline backdrop-blur-md"
        style={{ background: 'var(--op-header)' }}
      >
        <div className="mx-auto flex h-16 max-w-[1320px] items-center justify-between gap-2 px-3 sm:gap-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-7">
            <Logo />
            <nav className="hidden items-center gap-5 lg:flex" aria-label="Primary">
              {[
                { to: '/explore', label: 'Explore' },
                { to: '/looping', label: 'Looping' },
                { to: '/alerts', label: 'Alerts' },
                { to: '/positions', label: 'Positions' },
                { to: '/create', label: 'Create' },
              ].map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `whitespace-nowrap text-[13.5px] font-medium no-underline transition-colors ${
                      isActive ? 'text-fg' : 'text-muted hover:text-fg'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <HeaderAccountControls />
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
              Experimental, unaudited software; community pools are unreviewed —{' '}
              <span className="text-warn">use at your own risk</span>. Free and open source, no
              fees. Not affiliated with Pendle Finance.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <Link to="/about" className="text-[12px] font-medium text-muted no-underline hover:text-fg">
              About &amp; risks
            </Link>
            <span className="h-3 w-px bg-hairline" />
            <Link to="/status" className="text-[12px] font-medium text-muted no-underline hover:text-fg">
              Protocol status
            </Link>
            <span className="h-3 w-px bg-hairline" />
            <Link to="/pools" className="text-[12px] font-medium text-muted no-underline hover:text-fg">
              Saved pools
            </Link>
            <span className="h-3 w-px bg-hairline" />
            <a
              href="https://docs.openpendle.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] font-medium text-muted no-underline hover:text-fg"
            >
              Docs
            </a>
            <span className="h-3 w-px bg-hairline" />
            <span className="whitespace-nowrap text-[12px] font-medium text-muted">
              <a
                href="https://x.com/openpendle"
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline hover:text-fg"
              >
                @openpendle
              </a>{' '}
              by{' '}
              <a
                href="https://x.com/ggmxbt"
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline hover:text-fg"
              >
                @ggmxbt
              </a>
            </span>
            <span className="h-3 w-px bg-hairline" />
            <span className="whitespace-nowrap font-mono text-[11px] tracking-[.04em] text-faint">
              GPL-3.0
            </span>
          </div>
        </div>
      </footer>
    </div>
    </ForgetUndoProvider>
  )
}
