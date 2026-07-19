/* OpenPendle entry-module recovery. Kept dependency-free and unhashed on purpose. */
(function () {
  'use strict'

  var retryStarted = false

  function appState() {
    if (document.querySelector('[data-openpendle-startup="ready"]')) return 'ready'
    if (document.querySelector('[data-openpendle-startup="error"]')) return 'error'
    return 'pending'
  }

  function entryScript() {
    return document.querySelector(
      'script[type="module"][data-openpendle-entry], script[type="module"][src^="/assets/index-"], script[type="module"][src*="/src/main.tsx"]',
    )
  }

  function showFailure() {
    if (appState() !== 'pending') return
    var fallback = document.querySelector('[data-openpendle-startup="pending"]')
    if (!fallback) return
    var title = fallback.querySelector('strong')
    var copy = fallback.querySelector('p')
    if (title) title.textContent = 'OpenPendle could not finish loading'
    if (copy) {
      copy.textContent =
        'Reload once to fetch the current release. No wallet signature or transaction was requested.'
    }
  }

  function retryEntry() {
    if (retryStarted || appState() !== 'pending') return
    var entry = entryScript()
    if (!entry || !entry.src) {
      showFailure()
      return
    }

    retryStarted = true
    var retryUrl = new URL(entry.src, window.location.href)
    retryUrl.searchParams.set('_op_boot_retry', String(Date.now()))
    var retry = document.createElement('script')
    retry.type = 'module'
    retry.src = retryUrl.toString()
    retry.setAttribute('data-openpendle-entry-retry', 'true')
    retry.addEventListener('error', showFailure, { once: true })
    document.head.appendChild(retry)
    window.setTimeout(showFailure, 8_000)
  }

  function watchEntry() {
    var entry = entryScript()
    if (entry) entry.addEventListener('error', retryEntry, { once: true })
  }

  // Register before the module entry is parsed so evaluation/network failures
  // can still recover from a browser cache poisoned by an old HTML fallback.
  window.addEventListener('error', retryEntry)
  window.addEventListener('unhandledrejection', retryEntry)
  document.addEventListener('DOMContentLoaded', watchEntry, { once: true })
  window.setTimeout(retryEntry, 6_000)
})()
