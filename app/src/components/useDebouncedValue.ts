/**
 * Debounce a changing value — UI-layer copy for quote inputs (the lib/ one is
 * private to the data layer). Returns the value as of `delayMs` ago.
 */

import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
