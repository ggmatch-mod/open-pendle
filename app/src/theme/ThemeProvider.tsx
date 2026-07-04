/**
 * OpenPendle reskin — theme context (light / dark).
 * Single source of truth so the header toggle AND the RainbowKit theme in
 * main.tsx share one state. Sets data-theme + data-accent on <html>; the CSS
 * tokens in index.css read those attributes. Persists to localStorage.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ACCENT } from './accent'

type Theme = 'dark' | 'light'
const KEY = 'op.theme'

function initialTheme(): Theme {
  try {
    const s = localStorage.getItem(KEY)
    if (s === 'light' || s === 'dark') return s
  } catch {
    /* localStorage unavailable */
  }
  return 'dark' // product default
}

const ThemeCtx = createContext<{ theme: Theme; toggle: () => void }>({
  theme: 'dark',
  toggle: () => {},
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.dataset.accent = ACCENT
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  const value = useMemo(
    () => ({ theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }),
    [theme],
  )

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  return useContext(ThemeCtx)
}
