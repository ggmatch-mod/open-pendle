import type { ReactNode } from 'react'
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit'
import { ACCENT, ACCENT_HEX } from './accent'
import { useTheme } from './useTheme'

/** Keep RainbowKit's modal in sync with the app's light/dark and brand theme. */
export function ThemedRainbowKit({ children }: { children: ReactNode }) {
  const { theme } = useTheme()
  const accentColor = ACCENT_HEX[ACCENT]

  return (
    <RainbowKitProvider
      theme={theme === 'light' ? lightTheme({ accentColor }) : darkTheme({ accentColor })}
    >
      {children}
    </RainbowKitProvider>
  )
}
