/** Header light/dark switch. Shares state via ThemeProvider. */
import { useTheme } from './ThemeProvider'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <button
      type="button"
      onClick={toggle}
      title="Toggle light / dark"
      aria-label="Toggle light or dark theme"
      className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-hairline text-muted hover:border-hairline-strong hover:text-fg"
    >
      <span className="text-[15px]" aria-hidden>
        {theme === 'dark' ? '☾' : '☀'}
      </span>
    </button>
  )
}
