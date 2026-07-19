import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@rainbow-me/rainbowkit/styles.css'
import './index.css'
import App from './App.tsx'
import { wagmiConfig } from './lib/wagmi.ts'
import { installPreloadRecovery } from './lib/preloadRecovery.ts'
import { ThemeProvider } from './theme/ThemeProvider'
import { ThemedRainbowKit } from './theme/ThemedRainbowKit'
import { StartupErrorBoundary } from './components/StartupErrorBoundary.tsx'

const queryClient = new QueryClient()
installPreloadRecovery()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StartupErrorBoundary>
      <ThemeProvider>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <ThemedRainbowKit>
              {/* HashRouter: IPFS/static-host friendly — no server-side rewrites needed. */}
              <HashRouter>
                <App />
              </HashRouter>
            </ThemedRainbowKit>
          </QueryClientProvider>
        </WagmiProvider>
      </ThemeProvider>
    </StartupErrorBoundary>
  </StrictMode>,
)
