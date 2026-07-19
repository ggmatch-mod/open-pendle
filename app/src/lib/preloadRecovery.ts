/** Recover once when a cached app shell requests a chunk from an older deploy. */

const RELOAD_MARKER_KEY = 'openpendle.preload-reload.v1'
const RELOAD_QUERY_KEY = '_op_reload'
const RELOAD_GUARD_MS = 60_000
const READY_CLEANUP_DELAY_MS = 10_000

let reloadStarted = false
let readyCleanupScheduled = false

function recentReloadAttempt(url: URL): boolean {
  const queryAttempt = Number(url.searchParams.get(RELOAD_QUERY_KEY))
  if (Number.isFinite(queryAttempt) && Date.now() - queryAttempt < RELOAD_GUARD_MS) return true
  try {
    const storedAttempt = Number(window.sessionStorage.getItem(RELOAD_MARKER_KEY))
    return Number.isFinite(storedAttempt) && Date.now() - storedAttempt < RELOAD_GUARD_MS
  } catch {
    return false
  }
}

export function installPreloadRecovery(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('vite:preloadError', (event) => {
    const url = new URL(window.location.href)
    if (reloadStarted || recentReloadAttempt(url)) return

    // Vite documents this event specifically for deploys where an old cached
    // shell requests a chunk that no longer exists. Suppress that first error
    // and hard-navigate to a cache-busted copy of the current HTML.
    event.preventDefault()
    reloadStarted = true
    const attemptedAt = Date.now()
    try {
      window.sessionStorage.setItem(RELOAD_MARKER_KEY, String(attemptedAt))
    } catch {
      // The query marker still prevents a reload loop when storage is denied.
    }
    url.searchParams.set(RELOAD_QUERY_KEY, String(attemptedAt))
    window.location.replace(url.toString())
  })
}

/** Clear the one-shot guard and the temporary query parameter after a good mount. */
export function markAppReady(): void {
  if (typeof window === 'undefined' || readyCleanupScheduled) return
  readyCleanupScheduled = true
  window.setTimeout(() => {
    try {
      window.sessionStorage.removeItem(RELOAD_MARKER_KEY)
    } catch {
      // sessionStorage is optional.
    }

    const url = new URL(window.location.href)
    if (!url.searchParams.has(RELOAD_QUERY_KEY)) return
    url.searchParams.delete(RELOAD_QUERY_KEY)
    window.history.replaceState(window.history.state, '', url.toString())
  }, READY_CLEANUP_DELAY_MS)
}
