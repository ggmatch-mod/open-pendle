/**
 * wagmi / RainbowKit configuration — MULTI-NETWORK (M8).
 *
 * Supported chains: Ethereum (1), BNB Smart Chain (56), Monad (143),
 * Base (8453), Plasma (9745), Arbitrum (42161). Each is registered with its own
 * user-configurable HTTP RPC transport (openpendle.rpc.<chainId>).
 *
 * - Normal browsing reads flow through the HTTP RPC transports, so the app can
 *   browse wallet-less. The allowlisted looping-execution beta is the narrow
 *   exception: its live safety reads and unsigned simulations use the connected
 *   wallet's read-only transport for the selected supported execution chain.
 * - Multicall batching is on: viem aggregates reads through Multicall3.
 * - Injected-only: NO WalletConnect. EIP-6963 discovery lists each installed
 *   injected wallet (MetaMask, Rabby, Brave); there is no WC QR option and no
 *   Reown/AppKit init or external WalletConnect config fetch.
 * - The active chain (which network the app is showing) is a UI/localStorage
 *   concept (`openpendle.chain`, see hooks.useActiveChain) — NOT the wagmi
 *   config's chain order. Data hooks select their client via
 *   usePublicClient({ chainId }); this config just makes all six available.
 */

import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { injectedWallet } from '@rainbow-me/rainbowkit/wallets'
import { fallback, getAddress, isAddress } from 'viem'
import type { Address, Chain } from 'viem'
import { createConfig, createStorage, http } from 'wagmi'
import { arbitrum, base, bsc, mainnet, monad, plasma } from 'wagmi/chains'
import type { SupportedChainId } from './types'
import {
  DEFAULT_RPC_URL,
  RPC_STORAGE_KEY,
  getChainRpcUrl,
  getChainRpcUrls,
} from './addresses'
import {
  WAGMI_STORAGE_PREFIX,
  createSafeWagmiBaseStorage,
  deserializeWagmiStorage,
} from './wagmiStorage'
import { prepareBrowserStorage, sanitizeRainbowKitStorage } from './rainbowKitStorage'

// RainbowKit and injected-wallet helpers touch localStorage during provider
// setup. Normalize that dependency state before any connector is constructed.
const browserStorage = prepareBrowserStorage()
sanitizeRainbowKitStorage(() => browserStorage)

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

// RainbowKit ships built-in icons for Ethereum/BSC/Base/Arbitrum, but its
// current metadata only knows Monad testnet and has no Plasma entry. Attach our
// first-party assets to the mainnet chain objects so both missing icons render
// in RainbowKit's wallet-network selector.
const monadWithIcon = {
  ...monad,
  iconUrl: '/chains/monad.png',
  iconBackground: 'transparent',
}
const plasmaWithIcon = {
  ...plasma,
  iconUrl: '/chains/plasma.png',
  iconBackground: 'transparent',
}

// The six chains OpenPendle supports, in display order. Each has a Pendle V2
// deployment (see addresses.ts / docs/research/multichain-addresses.md).
const SUPPORTED_VIEM_CHAINS = [
  mainnet,
  bsc,
  monadWithIcon,
  base,
  plasmaWithIcon,
  arbitrum,
] as const

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

// Per-chain transports: a viem fallback() over the chain's keyless endpoints
// (or the user's single override) so a rate-limited/down primary rolls over to
// a backup automatically (PLAN §3.2 — public RPCs throttle hard).
const transports = Object.fromEntries(
  SUPPORTED_VIEM_CHAINS.map((chain) => [
    chain.id,
    fallback(getChainRpcUrls(chain.id as SupportedChainId).map((url) => http(url))),
  ]),
)

// Injected-only connectors — NO WalletConnect (so no Reown/AppKit init, no dead
// WC option in the connect modal, no external WC config fetches). wagmi's
// EIP-6963 discovery surfaces each installed injected wallet (MetaMask, Rabby,
// Brave) by name; the generic injectedWallet entry connects to whatever
// window.ethereum is. `projectId` is required by the type but unused here (no
// WC-based wallet is listed), so WalletConnect is never initialized.
const connectors = connectorsForWallets(
  [{ groupName: 'Installed', wallets: [injectedWallet] }],
  { appName: 'OpenPendle', projectId: 'openpendle-injected-only' },
)

const wagmiStorage = createStorage({
  key: WAGMI_STORAGE_PREFIX,
  storage: createSafeWagmiBaseStorage(),
  deserialize: deserializeWagmiStorage,
})

export const wagmiConfig = createConfig({
  connectors,
  chains,
  transports,
  storage: wagmiStorage,
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
