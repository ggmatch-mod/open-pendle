/**
 * wagmi / RainbowKit configuration — Arbitrum One only (PLAN scope).
 *
 * - All reads flow through the (user-configurable) HTTP RPC transport, never
 *   the connected wallet, so the whole app browses wallet-less.
 * - Multicall batching is on: viem aggregates reads through Multicall3.
 * - WalletConnect projectId is optional; with the placeholder, injected
 *   wallets (MetaMask, Rabby, ...) still work — only the WalletConnect QR
 *   modal needs a real id from https://cloud.walletconnect.com.
 */

import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { getAddress, isAddress } from 'viem'
import type { Address, Chain } from 'viem'
import { http } from 'wagmi'
import { arbitrum } from 'wagmi/chains'
import { DEFAULT_RPC_URL, RPC_STORAGE_KEY } from './addresses'

/** Read the user's custom RPC URL (settings panel writes it; reload applies it). */
export function getRpcUrl(): string {
  try {
    const stored = window.localStorage.getItem(RPC_STORAGE_KEY)
    if (stored && /^https?:\/\//.test(stored.trim())) return stored.trim()
  } catch {
    // localStorage unavailable (privacy mode) — fall through to default.
  }
  return DEFAULT_RPC_URL
}

// ---------------------------------------------------------------------------
// Dev wallet (M2, fork testing) — DEV BUILDS ONLY.
//
// When `import.meta.env.DEV` and localStorage 'openpendle.devwallet' holds a
// valid address, wagmi's mock connector is prepended with that account and
// auto-connected. Point the RPC setting ('openpendle.rpc') at a local anvil
// fork started with `--auto-impersonate`: the mock connector forwards
// eth_sendTransaction as a raw RPC call, anvil signs it server-side as the
// impersonated account, and the full approve → simulate → confirm → confirmed
// loop runs end-to-end with no wallet extension.
//
// Activation:
//   1. anvil --fork-url <arbitrum RPC> --auto-impersonate [--port 8545]
//   2. in the app: set the custom RPC to http://127.0.0.1:8545 (RPC panel)
//   3. localStorage.setItem('openpendle.devwallet', '0x<account>'); reload
//   4. remove the key + reload to go back to real wallets
//
// Production safety: everything is gated on `import.meta.env.DEV`, which Vite
// replaces with `false` in production builds — the guarded branches become
// dead code and the mock/connect imports are dropped by the bundler. The
// connector cannot exist in a production bundle.
// ---------------------------------------------------------------------------

/** localStorage key holding the dev-wallet (fork impersonation) address. */
export const DEV_WALLET_STORAGE_KEY = 'openpendle.devwallet'

function readDevWalletAddress(): Address | null {
  try {
    const raw = window.localStorage.getItem(DEV_WALLET_STORAGE_KEY)?.trim()
    if (raw && isAddress(raw, { strict: false })) return getAddress(raw)
  } catch {
    // localStorage unavailable — no dev wallet.
  }
  return null
}

const devWalletAddress: Address | null = import.meta.env.DEV
  ? readDevWalletAddress()
  : null

// The mock connector sends eth_sendTransaction to `chain.rpcUrls.default`
// (NOT the wagmi transport), so in dev-wallet mode the chain itself must
// point at the configured RPC (the anvil fork). No-op outside dev-wallet mode.
const arbitrumChain: Chain = devWalletAddress
  ? { ...arbitrum, rpcUrls: { default: { http: [getRpcUrl()] } } }
  : arbitrum

const walletConnectProjectId =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'OPENPENDLE_PLACEHOLDER_PROJECT_ID'

export const wagmiConfig = getDefaultConfig({
  appName: 'OpenPendle',
  projectId: walletConnectProjectId,
  chains: [arbitrumChain],
  transports: {
    [arbitrum.id]: http(getRpcUrl()),
  },
  // Batch eth_calls through Multicall3 — public RPCs rate-limit hard (PLAN §3.2).
  batch: { multicall: true },
})

if (import.meta.env.DEV && devWalletAddress) {
  // Dynamic imports keep the mock connector fully out of production bundles
  // (a static `import { mock }` survives tree-shaking because @wagmi/core's
  // module has side-effectful assignments; this whole block is dead code in
  // prod, so the dynamic import chunk is never emitted).
  void (async () => {
    const [{ mock }, { connect }] = await Promise.all([
      import('wagmi/connectors'),
      import('wagmi/actions'),
    ])

    // Prepend the mock connector. _internal.connectors is wagmi's own setup
    // API for connectors added after createConfig (its provider discovery
    // uses the same path). `defaultConnected` + `reconnect` let wagmi's
    // reconnect-on-mount adopt the wallet by itself when the RPC answers
    // eth_accounts (anvil does); against RPCs that don't, the fallback below
    // connects explicitly.
    const connector = wagmiConfig._internal.connectors.setup(
      mock({
        accounts: [devWalletAddress],
        features: { defaultConnected: true, reconnect: true },
      }),
    )
    wagmiConfig._internal.connectors.setState((prev) => [connector, ...prev])

    // Auto-connect — but only AFTER wagmi's reconnect-on-mount settles: its
    // final state write clobbers any connection established mid-reconnect.
    // One-shot: a later manual disconnect is respected.
    let settled = false
    const adopt = (): void => {
      if (settled) return
      const { status } = wagmiConfig.state
      if (status === 'connected') {
        settled = true // reconnect-on-mount already adopted it (anvil path)
      } else if (status === 'disconnected') {
        settled = true
        connect(wagmiConfig, { connector }).catch(() => {
          // RPC/storage hiccup — leave the user on the manual connect button.
        })
      }
    }
    wagmiConfig.subscribe((s) => s.status, adopt)
    // Fallback in case reconnect-on-mount is disabled or settled already.
    setTimeout(adopt, 1_500)

    console.info(`[openpendle] dev wallet active: ${devWalletAddress} (mock connector)`)
  })()
}
