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

const walletConnectProjectId =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'OPENPENDLE_PLACEHOLDER_PROJECT_ID'

export const wagmiConfig = getDefaultConfig({
  appName: 'OpenPendle',
  projectId: walletConnectProjectId,
  chains: [arbitrum],
  transports: {
    [arbitrum.id]: http(getRpcUrl()),
  },
  // Batch eth_calls through Multicall3 — public RPCs rate-limit hard (PLAN §3.2).
  batch: { multicall: true },
})
