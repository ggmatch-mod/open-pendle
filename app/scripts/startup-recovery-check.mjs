import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

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
globalThis.document = { documentElement: { dataset: {} } }

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
delete globalThis.document

const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const entryRecoveryPosition = indexSource.indexOf('src="/startup-recovery.js"')
const moduleEntryPosition = indexSource.indexOf('data-openpendle-entry')
assert.ok(entryRecoveryPosition >= 0)
assert.ok(moduleEntryPosition > entryRecoveryPosition)

const entryRecoverySource = await readFile(
  new URL('../public/startup-recovery.js', import.meta.url),
  'utf8',
)
const entryListeners = new Map()
const windowListeners = new Map()
const appendedScripts = []
const entryElement = {
  src: 'https://openpendle.com/assets/index-old.js',
  addEventListener: (name, listener) => entryListeners.set(name, listener),
}
const fallbackTitle = { textContent: 'OpenPendle is loading' }
const fallbackCopy = { textContent: 'Loading' }
const fallbackElement = {
  querySelector: (selector) => (selector === 'strong' ? fallbackTitle : fallbackCopy),
}
const classicDocument = {
  addEventListener: () => {},
  createElement: () => ({
    addEventListener: () => {},
    setAttribute: () => {},
    src: '',
    type: '',
  }),
  head: { appendChild: (script) => appendedScripts.push(script) },
  querySelector: (selector) => {
    if (selector.includes('"ready"') || selector.includes('"error"')) return null
    if (selector.includes('data-openpendle-entry')) return entryElement
    if (selector.includes('"pending"')) return fallbackElement
    return null
  },
}
const classicWindow = {
  addEventListener: (name, listener) => windowListeners.set(name, listener),
  location: { href: 'https://openpendle.com/#/looping' },
  setTimeout: () => {},
}
vm.runInNewContext(entryRecoverySource, {
  Date,
  URL,
  document: classicDocument,
  window: classicWindow,
})
assert.equal(typeof windowListeners.get('error'), 'function')
windowListeners.get('error')()
assert.equal(appendedScripts.length, 1)
assert.equal(appendedScripts[0].type, 'module')
assert.ok(new URL(appendedScripts[0].src).searchParams.get('_op_boot_retry'))
windowListeners.get('error')()
assert.equal(appendedScripts.length, 1)

console.log('startup recovery checks passed')
