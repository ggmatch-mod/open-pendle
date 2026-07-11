import { useContext } from 'react'
import { ThemeCtx } from './themeContext'

export function useTheme() {
  return useContext(ThemeCtx)
}
