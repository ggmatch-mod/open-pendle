/**
 * wagmi / RainbowKit configuration — MULTI-NETWORK (M8).
 *
 * Supported chains: Ethereum (1), BNB Smart Chain (56), Monad (143),
 * Base (8453), Plasma (9745), Arbitrum (42161). Each is registered with its own
 * user-configurable HTTP RPC transport (openpendle.rpc.<chainId>).
 *
 * - All reads flow through the HTTP RPC transports, never the connected wallet,
 *   so the whole app browses wallet-less on any selected chain.
 * - Multicall batching is on: viem aggregates reads through Multicall3.
 * - WalletConnect projectId is optional; with the placeholder, injected wallets
 *   (MetaMask, Rabby, ...) still work — only the WalletConnect QR modal needs a
 *   real id from https://cloud.walletconnect.com.
 * - The active chain (which network the app is showing) is a UI/localStorage
 *   concept (`openpendle.chain`, see hooks.useActiveChain) — NOT the wagmi
 *   config's chain order. Data hooks select their client via
 *   usePublicClient({ chainId }); this config just makes all six available.
 */

import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { getAddress, isAddress } from 'viem'
import type { Address, Chain } from 'viem'
import { http } from 'wagmi'
import { arbitrum, base, bsc, mainnet, monad, plasma } from 'wagmi/chains'
import type { SupportedChainId } from './types'
import {
  DEFAULT_RPC_URL,
  RPC_STORAGE_KEY,
  getChainRpcUrl,
} from './addresses'

/**
 * Back-compat: the legacy single-chain RPC reader. Existing components import
 * `getRpcUrl()` and the old localStorage key; it now delegates to the per-chain
 * helper for Arbitrum (which also honors the legacy un-suffixed key).
 */
export function getRpcUrl(): string {
  try {
    const stored = window.localStorage.getItem(RPC_STORAGE_KEY)
    if (stored && /^https?:\/\//.test(stored.trim())) return stored.trim()
  } catch {
    // localStorage unavailable (privacy mode) — fall through to default.
  }
  return DEFAULT_RPC_URL
}

// The six chains OpenPendle supports, in display order. Each has a Pendle V2
// deployment (see addresses.ts / docs/research/multichain-addresses.md).
const SUPPORTED_VIEM_CHAINS = [mainnet, bsc, monad, base, plasma, arbitrum] as const

// ---------------------------------------------------------------------------
// Dev wallet (M2+, fork testing) — DEV BUILDS ONLY.
//
// When `import.meta.env.DEV` and localStorage 'openpendle.devwallet' holds a
// valid address, wagmi's mock connector is prepended with that account and
// auto-connected. Point the per-chain RPC setting for the ACTIVE chain
// ('openpendle.rpc.<chainId>') at a local anvil fork started with
// `--auto-impersonate`: the mock connector forwards eth_sendTransaction as a
// raw RPC call, anvil signs it server-side as the impersonated account, and the
// full approve → simulate → confirm loop runs end-to-end with no wallet
// extension.
//
// M8: the mock connector's chain is the ACTIVE chain (openpendle.chain), not a
// hardcoded Arbitrum — so a fork test on Base/Ethereum/etc. drives the dev
// wallet on that chain. The mock connector sends eth_sendTransaction to
// `chain.rpcUrls.default` (NOT the wagmi transport), so that chain's default
// rpc is overridden to the active chain's configured RPC (the fork).
//
// Activation:
//   1. anvil --fork-url <chain RPC> --auto-impersonate [--port 8545]
//   2. set localStorage 'openpendle.chain' to the forked chain id
//   3. set the custom RPC for that chain ('openpendle.rpc.<chainId>') to
//      http://127.0.0.1:8545 (RPC panel)
//   4. localStorage.setItem('openpendle.devwallet', '0x<account>'); reload
//   5. remove the key + reload to go back to real wallets
//
// Production safety: everything is gated on `import.meta.env.DEV`, which Vite
// replaces with `false` in production builds — the guarded branches become dead
// code and the mock/connect imports are dropped by the bundler.
// ---------------------------------------------------------------------------

/** localStorage key holding the dev-wallet (fork impersonation) address. */
export const DEV_WALLET_STORAGE_KEY = 'openpendle.devwallet'

/** localStorage key holding the active chain id (mirrors hooks.ACTIVE_CHAIN_STORAGE_KEY). */
const ACTIVE_CHAIN_STORAGE_KEY = 'openpendle.chain'

function readDevWalletAddress(): Address | null {
  try {
    const raw = window.localStorage.getItem(DEV_WALLET_STORAGE_KEY)?.trim()
    if (raw && isAddress(raw, { strict: false })) return getAddress(raw)
  } catch {
    // localStorage unavailable — no dev wallet.
  }
  return null
}

/** The dev-wallet active chain (defaults to Arbitrum) — used to pin the mock connector's chain. */
function readDevWalletActiveChain(): Chain {
  let chainId: number = arbitrum.id
  try {
    const raw = window.localStorage.getItem(ACTIVE_CHAIN_STORAGE_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    if (SUPPORTED_VIEM_CHAINS.some((c) => c.id === parsed)) chainId = parsed
  } catch {
    // localStorage unavailable — default to Arbitrum.
  }
  return SUPPORTED_VIEM_CHAINS.find((c) => c.id === chainId) ?? arbitrum
}

const devWalletAddress: Address | null = import.meta.env.DEV
  ? readDevWalletAddress()
  : null

// In dev-wallet mode, override the ACTIVE chain's default rpcUrls to the
// configured RPC (the anvil fork), because the mock connector sends
// eth_sendTransaction to chain.rpcUrls.default, not the wagmi transport.
const devActiveChain: Chain | null = devWalletAddress ? readDevWalletActiveChain() : null
const chains = SUPPORTED_VIEM_CHAINS.map((chain) => {
  if (devActiveChain && chain.id === devActiveChain.id) {
    return {
      ...chain,
      rpcUrls: { default: { http: [getChainRpcUrl(chain.id as SupportedChainId)] } },
    }
  }
  return chain
}) as unknown as readonly [Chain, ...Chain[]]

const walletConnectProjectId =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'OPENPENDLE_PLACEHOLDER_PROJECT_ID'

// Per-chain HTTP transports keyed by chain id (user-configurable per chain).
const transports = Object.fromEntries(
  SUPPORTED_VIEM_CHAINS.map((chain) => [
    chain.id,
    http(getChainRpcUrl(chain.id as SupportedChainId)),
  ]),
)

export const wagmiConfig = getDefaultConfig({
  appName: 'OpenPendle',
  projectId: walletConnectProjectId,
  chains,
  transports,
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
    // API for connectors added after createConfig (its provider discovery uses
    // the same path). `defaultConnected` + `reconnect` let wagmi's
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

    console.info(
      `[openpendle] dev wallet active: ${devWalletAddress} on chain ${devActiveChain?.id ?? arbitrum.id} (mock connector)`,
    )
  })()
}
