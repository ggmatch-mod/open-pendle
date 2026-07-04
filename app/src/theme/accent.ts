/**
 * Brand accent for the reskin. Change ACCENT here and it cascades everywhere —
 * every color token in index.css derives from the `data-accent` attribute.
 * ACCENT_HEX is only for places that need a JS hex value (RainbowKit).
 */
export type Accent = 'indigo' | 'emerald' | 'violet' | 'cyan' | 'amber'

export const ACCENT: Accent = 'indigo'

export const ACCENT_HEX: Record<Accent, string> = {
  indigo: '#6366f1',
  emerald: '#10b981',
  violet: '#8b5cf6',
  cyan: '#06b6d4',
  amber: '#f59e0b',
}
