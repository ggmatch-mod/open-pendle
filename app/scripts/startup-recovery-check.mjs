import assert from 'node:assert/strict'

const listeners = new Map()
const sessionValues = new Map()
let replacedUrl = null
let cleanedUrl = null
let readyCallback = null

globalThis.window = {
  addEventListener: (name, listener) => listeners.set(name, listener),
  history: {
    state: null,
    replaceState: (_state, _title, url) => {
      cleanedUrl = String(url)
    },
  },
  location: {
    href: 'https://openpendle.com/?release=old#/looping',
    replace: (url) => {
      replacedUrl = String(url)
    },
  },
  sessionStorage: {
    getItem: (key) => sessionValues.get(key) ?? null,
    removeItem: (key) => sessionValues.delete(key),
    setItem: (key, value) => sessionValues.set(key, String(value)),
  },
  setTimeout: (callback) => {
    readyCallback = callback
  },
}

const { installPreloadRecovery, markAppReady } = await import('../src/lib/preloadRecovery.ts')
installPreloadRecovery()

const preloadHandler = listeners.get('vite:preloadError')
assert.equal(typeof preloadHandler, 'function')

let prevented = false
preloadHandler({ preventDefault: () => (prevented = true) })
assert.equal(prevented, true)
assert.ok(replacedUrl)
const recoveryUrl = new URL(replacedUrl)
assert.equal(recoveryUrl.hash, '#/looping')
assert.equal(recoveryUrl.searchParams.get('release'), 'old')
assert.ok(recoveryUrl.searchParams.get('_op_reload'))

let preventedTwice = false
preloadHandler({ preventDefault: () => (preventedTwice = true) })
assert.equal(preventedTwice, false)

window.location.href = replacedUrl
markAppReady()
assert.equal(typeof readyCallback, 'function')
readyCallback()
assert.ok(cleanedUrl)
const readyUrl = new URL(cleanedUrl)
assert.equal(readyUrl.searchParams.has('_op_reload'), false)
assert.equal(readyUrl.hash, '#/looping')
assert.equal(sessionValues.size, 0)

delete globalThis.window

console.log('startup recovery checks passed')
