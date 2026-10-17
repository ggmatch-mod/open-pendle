#!/usr/bin/env node

/** Reproduce the reviewed source and live binaries without vendoring contracts. Read-only RPCs only. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { keccak256 } from 'viem'

const review = JSON.parse(readFileSync(new URL('../../docs/research/pendleswap-upgrade-2026-10-17/review.json', import.meta.url), 'utf8'))
const option = (name) => process.argv[process.argv.indexOf(name) + 1]
const soljsonPath = process.argv.includes('--soljson') ? option('--soljson') : null
if (!soljsonPath || !isAbsolute(soljsonPath)) throw new Error('Pass --soljson /absolute/path/to/official-solc-0.8.30/soljson.js; compiler SHA-256 is verified before loading')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
if (sha256(readFileSync(soljsonPath)) !== review.compiler.soljsonSha256) throw new Error('Solidity compiler does not match the reviewed official artifact')

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.text()
}
const html = process.argv.includes('--source-html')
  ? readFileSync(option('--source-html'), 'utf8')
  : await fetchText(review.sourceUrls[0])
const match = html.match(/var editor_contractJsonData = ('(?:[^'\\]|\\.)*')/)
if (!match) throw new Error('Verified-source editor payload is unavailable')
// Decode data as JSON twice; never evaluate explorer-provided JavaScript.
const literal = match[1].slice(1, -1).replace(/\\'/g, "'").replace(/\\`/g, '`')
const editor = JSON.parse(JSON.parse(`"${literal}"`))
const settings = JSON.parse(editor.sources['settings.json'].content)
delete editor.sources['settings.json']
settings.outputSelection = { '*': { '*': ['evm.deployedBytecode', 'evm.bytecode', 'metadata', 'storageLayout', 'abi'] } }
const input = JSON.stringify({ ...editor, settings })
if (sha256(input) !== review.compiler.inputSha256) throw new Error('Source or compiler settings differ from the reviewed input')
for (const source of review.sourceFiles) {
  if (sha256(editor.sources[source.path]?.content ?? '') !== source.sha256) throw new Error(`Verified source differs: ${source.path}`)
}
const require = createRequire(import.meta.url)
const compiler = require(soljsonPath)
const compile = compiler.cwrap('solidity_compile', 'string', ['string', 'number', 'number'])
const output = JSON.parse(compile(input, 0, 0))
const errors = (output.errors ?? []).filter((error) => error.severity === 'error')
if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join('\n'))
const contract = output.contracts['lib/pendle-core-v2/contracts/router/swap-aggregator/PendleSwap.sol'].PendleSwap
const storage = contract.storageLayout.storage.map(({ astId: _ast, contract: _contract, ...row }) => row)
if (JSON.stringify(storage) !== JSON.stringify(review.storage.new)) throw new Error('Compiled storage layout differs from the reviewed layout')
const references = Object.values(contract.evm.deployedBytecode.immutableReferences).flat()
const endpoints = { ethereum: 'https://ethereum-rpc.publicnode.com', arbitrum: 'https://arb1.arbitrum.io/rpc', monad: 'https://rpc.monad.xyz' }
async function rpc(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`)
  const body = await response.json()
  if (body.error) throw new Error(JSON.stringify(body.error))
  return body.result
}
for (const expected of review.bytecodeReproduction.results) {
  const url = endpoints[expected.chain]
  const block = await rpc(url, 'eth_blockNumber', [])
  const live = await rpc(url, 'eth_getCode', [review.implementation, block])
  let reproduced = contract.evm.deployedBytecode.object
  for (const { start, length } of references) {
    const observed = live.slice(2 + start * 2, 2 + (start + length) * 2)
    const pinned = expected.immutableValues.find((item) => item.start === start && item.length === length)
    if (pinned?.value !== observed) throw new Error(`${expected.chain} immutable changed at byte ${start}`)
    reproduced = reproduced.slice(0, start * 2) + observed + reproduced.slice((start + length) * 2)
  }
  if (`0x${reproduced}` !== live || keccak256(live) !== expected.hash) throw new Error(`${expected.chain} runtime bytecode does not reproduce exactly`)
  console.log(`${expected.chain}: exact verified-source reproduction at block ${BigInt(block)}; ${expected.hash}`)
}
