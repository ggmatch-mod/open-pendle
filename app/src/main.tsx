import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import './index.css'
import App from './App.tsx'
import { wagmiConfig } from './lib/wagmi.ts'
import { ThemeProvider, useTheme } from './theme/ThemeProvider'
import { ACCENT, ACCENT_HEX } from './theme/accent'

const queryClient = new QueryClient()

// RainbowKit's modal theme follows the app's light/dark + brand accent.
function ThemedRainbowKit({ children }: { children: ReactNode }) {
  const { theme } = useTheme()
  const accentColor = ACCENT_HEX[ACCENT]
  return (
    <RainbowKitProvider theme={theme === 'light' ? lightTheme({ accentColor }) : darkTheme({ accentColor })}>
      {children}
    </RainbowKitProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
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
  </StrictMode>,
)
