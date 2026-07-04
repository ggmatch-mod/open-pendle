/**
 * OpenPendle per-chain address book (M8 multi-network).
 *
 * Source of truth: `deployments/<chainId>-core.json` in
 * pendle-finance/pendle-core-v2-public (verified 2026-07-04 against the raw
 * files — see docs/research/multichain-addresses.md). Every address below was
 * lifted directly from those JSONs.
 *
 * Rule (PLAN §3.2 / F12): hardcode ONLY entry points that are themselves the
 * source of truth. Active factories, expiryDivisor, fee rates and treasury are
 * governance-mutable and MUST be resolved live at runtime (see ProtocolStatus /
 * pendleAbi.ts / deploy.ts preflight), never read from this file for tx routing.
 * The factory *set* here is the paste-validation OR-check (per chain) and the
 * "newest generation present" pick — validation, not routing.
 *
 * Cross-chain constants (IDENTICAL address on every chain, verified in every
 * core.json): Router V4, commonDeploy, syFactory, pyYtLpOracle, the canonical
 * Multicall3, Pendle's governanceProxy, and Pendle's ProxyAdmin. Per-chain (must
 * be chain-keyed, NEVER reuse Arbitrum's): routerStatic, PENDLE token, treasury,
 * governance multisig, wrappedNative + native symbol, and every factory address.
 *
 * All addresses are EIP-55 checksummed.
 */

import { getAddress } from 'viem'
import type { Address } from 'viem'
import type { SupportedChainId } from './types.ts'

// ---------------------------------------------------------------------------
// Cross-chain constants — the same vanity/deterministic address everywhere.
// ---------------------------------------------------------------------------

/** Router V4 — all trades/liquidity/exits. Same address on all 6 chains (fork-verified, no market allowlist). */
export const ROUTER_V4: Address = '0x888888888889758F76e7103c6CbF23ABbF58F946'

/**
 * PendleCommonPoolDeployHelperV2 ("commonDeploy") — one-tx pool (+ optional SY)
 * deploys. Same address on all 6 chains. Its public immutables are the live
 * source of truth for the active market factory, yield contract factory, router
 * and syFactory (resolve them live per F12).
 */
export const COMMON_DEPLOY: Address = '0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9'

/** PendleCommonSYFactory — permissionless SY-template deploys. Same address on all 6 chains. */
export const SY_FACTORY: Address = '0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8'

/** PendlePYLpOracle — TWAP oracle for PT/YT/LP pricing. Same address on all 6 chains. */
export const PY_LP_ORACLE: Address = '0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2'

/**
 * Multicall3 — canonical `0xcA11…CA11`, used by viem's `batch: { multicall: true }`
 * and every explicit `multicallAddress` in lib reads. NOT present in Pendle's
 * core.json — hardcoded here as the canonical cross-chain deployment.
 * VERIFY LIVENESS per chain (esp. Plasma 9745 / Monad 143 — newer chains): if a
 * chain lacks Multicall3, the batched reads revert and reads must fall back to
 * non-batched. As of 2026-07-04 it is deployed on all six requested chains.
 */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** Pendle governance proxy — the default `syOwner` for wizard-deployed SYs. Same address on all 6 chains. */
export const PENDLE_GOVERNANCE: Address = '0x2aD631F72fB16d91c4953A7f4260A97C2fE2f31e'

/**
 * Pendle ProxyAdmin — admin of Pendle's TransparentUpgradeableProxies
 * (syFactory-deployed upgradeable SYs). Same address on all 6 chains
 * (verified in every core.json). The trust panel compares the EIP-1967 admin
 * slot against this.
 */
export const PENDLE_PROXY_ADMIN: Address = '0xA28c08f165116587D4F3E708743B4dEe155c5E64'

// ---------------------------------------------------------------------------
// Address-book shape
// ---------------------------------------------------------------------------

/** One factory generation (market factory + its paired yield-contract factory). */
export interface FactoryGeneration {
  /** Human label / vintage badge. 'v1' is the base (unsuffixed) factory generation. */
  gen: 'v1' | 'V3' | 'V4' | 'V5' | 'V6'
  marketFactory: Address
  yieldContractFactory: Address
}

/**
 * The full per-chain address book. Cross-chain constants are duplicated in
 * every book (so a caller holding a book needs no second lookup); per-chain
 * fields carry that chain's own values.
 */
export interface AddressBook {
  chainId: SupportedChainId
  // Cross-chain (same address everywhere, mirrored here for convenience).
  router: Address
  commonDeploy: Address
  syFactory: Address
  pyYtLpOracle: Address
  multicall3: Address
  proxyAdmin: Address
  /** Pendle governance proxy (default syOwner). Same address on all chains. */
  governanceProxy: Address
  // Per-chain (chain-keyed — never reuse Arbitrum's).
  routerStatic: Address
  treasury: Address
  /** Pendle governance multisig on this chain (part of the "owner is Pendle" trust set). */
  governance: Address
  pendle: Address
  wrappedNative: Address
  /** Oldest → newest. The LAST entry is the active generation for routing. */
  marketFactories: readonly FactoryGeneration[]
  /** Newest market factory present on this chain (= marketFactories[last]). */
  activeMarketFactory: Address
  /** Newest yield-contract factory present on this chain (paired with activeMarketFactory). */
  activeYieldContractFactory: Address
}

/** Assemble the factory-generation list and derive the active pair, per chain. */
function makeBook(
  chainId: SupportedChainId,
  perChain: {
    routerStatic: Address
    treasury: Address
    governance: Address
    pendle: Address
    wrappedNative: Address
    factories: readonly { gen: FactoryGeneration['gen']; mf: Address; ycf: Address }[]
  },
): AddressBook {
  const marketFactories: readonly FactoryGeneration[] = perChain.factories.map((f) => ({
    gen: f.gen,
    marketFactory: getAddress(f.mf),
    yieldContractFactory: getAddress(f.ycf),
  }))
  // Newest generation present = the last entry (the source arrays are
  // ordered oldest → newest per chain, matching each chain's real lineage).
  const active = marketFactories[marketFactories.length - 1]
  return {
    chainId,
    router: ROUTER_V4,
    commonDeploy: COMMON_DEPLOY,
    syFactory: SY_FACTORY,
    pyYtLpOracle: PY_LP_ORACLE,
    multicall3: MULTICALL3,
    proxyAdmin: PENDLE_PROXY_ADMIN,
    governanceProxy: PENDLE_GOVERNANCE,
    routerStatic: getAddress(perChain.routerStatic),
    treasury: getAddress(perChain.treasury),
    governance: getAddress(perChain.governance),
    pendle: getAddress(perChain.pendle),
    wrappedNative: getAddress(perChain.wrappedNative),
    marketFactories,
    activeMarketFactory: active.marketFactory,
    activeYieldContractFactory: active.yieldContractFactory,
  }
}

// ---------------------------------------------------------------------------
// Per-chain address books. Factory lineage VARIES:
//   Ethereum (1) & BSC (56): base(v1) + V3 + V4 + V5 + V6
//   Base (8453) & Plasma (9745): V5 + V6 only
//   Monad (143): V6 only
//   Arbitrum (42161): base(v1) + V3 + V4 + V5 + V6 (the original build)
// The "newest present" active pick and the paste-validation set are therefore
// per chain — V3/V4 keys are UNDEFINED on Base/Plasma/Monad.
// ---------------------------------------------------------------------------

export const ADDRESS_BOOKS: Record<SupportedChainId, AddressBook> = {
  1: makeBook(1, {
    routerStatic: '0x263833d47eA3fA4a30f269323aba6a107f9eB14C',
    treasury: '0x8270400d528c34e1596EF367eeDEc99080A1b592',
    governance: '0x8119EC16F0573B7dAc7C0CB94EB504FB32456ee1',
    pendle: '0x808507121b80c02388fad14726482e061b8da827',
    wrappedNative: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    factories: [
      { gen: 'v1', mf: '0x27b1dAcd74688aF24a64BD3C9C1B143118740784', ycf: '0x70ee0A6DB4F5a2Dc4d9c0b57bE97B9987e75BAFD' },
      { gen: 'V3', mf: '0x1A6fCc85557BC4fB7B534ed835a03EF056552D52', ycf: '0xdF3601014686674e53d1Fa52F7602525483F9122' },
      { gen: 'V4', mf: '0x3d75Bd20C983edb5fD218A1b7e0024F1056c7A2F', ycf: '0x273b4bFA3Bb30fe8F32c467b5f0046834557F072' },
      { gen: 'V5', mf: '0x6fcf753f2C67b83f7B09746Bbc4FA0047b35D050', ycf: '0x35A338522a435D46f77Be32C70E215B813D0e3aC' },
      { gen: 'V6', mf: '0x6d247b1c044fA1E22e6B04fA9F71Baf99EB29A9f', ycf: '0x3E6EBa46AbC5ab18ED95F6667d8B2fd4020E4637' },
    ],
  }),
  56: makeBook(56, {
    routerStatic: '0x2700ADB035F82a11899ce1D3f1BF8451c296eABb',
    treasury: '0xd77E9062c6DF3F2d1CB5Bf45855fa1E7712A059e',
    governance: '0xA06627d9884996BC27a7c20fDA94FC94C13aa9Ec',
    pendle: '0xb3Ed0A426155B79B898849803E3B36552f7ED507',
    wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    factories: [
      { gen: 'v1', mf: '0x2bEa6BfD8fbFF45aA2a893EB3B6d85D10EFcC70E', ycf: '0xa2530b4cfBF271e2B409A05C2CE520e4cB5fCc88' },
      { gen: 'V3', mf: '0xC40fEbF5A33b8C92B187d9be0fD3fe0ac2E4B07c', ycf: '0x40Ae6da2d92aa3DCb7f8d7a7209FD12BDfcb7C85' },
      { gen: 'V4', mf: '0x7D20e644D2A9e149e5be9bE9aD2aB243a7835d37', ycf: '0xdb6380041441A94050199b4A46771D8d93553509' },
      { gen: 'V5', mf: '0x7C7f73f7a320364DBB3C9aAa9bCcd402040EE0f9', ycf: '0xE006760020384A20774Dea977C313EF5F51FE17D' },
      { gen: 'V6', mf: '0x80cE46449DF1c977f6ba60495125ce282F83DdFB', ycf: '0xd8c12d46dde7a04F782d417FAE78516448CB2c5b' },
    ],
  }),
  143: makeBook(143, {
    routerStatic: '0x6813d43782395A1F2AAb42f39aeEDE03ac655e09',
    treasury: '0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6',
    governance: '0x7877AdFaDEd756f3248a0EBfe8Ac2E2eF87b75Ac',
    pendle: '0x5e49e1f85813f2b65858860a3fa231b4186f2e0e',
    wrappedNative: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    // Monad went live 2026-06-19 with the current generation only.
    factories: [
      { gen: 'V6', mf: '0xA3cb62a49b66eB2536cf6F3C7AC82293784888A3', ycf: '0x4fe1B23ab695D99394Ab78c16A5bE358f31847F4' },
    ],
  }),
  8453: makeBook(8453, {
    routerStatic: '0xB4205a645c7e920BD8504181B1D7f2c5C955C3e7',
    treasury: '0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6',
    governance: '0x7877AdFaDEd756f3248a0EBfe8Ac2E2eF87b75Ac',
    pendle: '0xA99F6e6785Da0F5d6fB42495Fe424BCE029Eeb3E',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    factories: [
      { gen: 'V5', mf: '0x59968008a703dC13E6beaECed644bdCe4ee45d13', ycf: '0x963ddBB35c1AE44e2a159E3b5fb5177E0B32660d' },
      { gen: 'V6', mf: '0x81E80A50E56d10C501fF17B5Fe2F662bd9EA4590', ycf: '0xdDBfA21ecf024971486684E4E1600998ADeabc88' },
    ],
  }),
  9745: makeBook(9745, {
    routerStatic: '0x6813d43782395A1F2AAb42f39aeEDE03ac655e09',
    treasury: '0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6',
    governance: '0x7877AdFaDEd756f3248a0EBfe8Ac2E2eF87b75Ac',
    pendle: '0x17bac5f906c9a0282ac06a59958d85796c831f24',
    wrappedNative: '0x6100E367285b01F48D07953803A2d8dCA5D19873',
    factories: [
      { gen: 'V5', mf: '0x28dE02Ac3c3F5ef427e55c321F73fDc7F192e8E4', ycf: '0xED0dC8C074255c277BC704D6b096167D7a6E4311' },
      { gen: 'V6', mf: '0x84A240Fa784E7F03CB99BA3716065961c5d0D531', ycf: '0xeAECF59C9Da00DACB73c4AAEbBBa22cf5e5bfD93' },
    ],
  }),
  42161: makeBook(42161, {
    routerStatic: '0xAdB09F65bd90d19e3148D9ccb693F3161C6DB3E8',
    treasury: '0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6',
    governance: '0x7877AdFaDEd756f3248a0EBfe8Ac2E2eF87b75Ac',
    pendle: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    factories: [
      { gen: 'v1', mf: '0xf5a7De2D276dbda3EEf1b62A9E718EFf4d29dDC8', ycf: '0x28dE02Ac3c3F5ef427e55c321F73fDc7F192e8E4' },
      { gen: 'V3', mf: '0x2FCb47B58350cD377f94d3821e7373Df60bD9Ced', ycf: '0xEb38531db128EcA928aea1B1CE9E5609B15ba146' },
      { gen: 'V4', mf: '0xd9f5e9589016da862D2aBcE980A5A5B99A94f3E8', ycf: '0xc7F8F9F1DdE1104664b6fC8F33E49b169C12F41E' },
      { gen: 'V5', mf: '0xd29e76c6F15ada0150D10A1D3f45aCCD2098283B', ycf: '0xFF29e023910FB9bfc86729c1050AF193A45a0C0c' },
      { gen: 'V6', mf: '0x49F2f7002669E0e4425Fa0203975625Ab4af3143', ycf: '0xBA814Bf6E27A6d6baE4a8aC65c8Bc3d8e9B0aaCF' },
    ],
  }),
}

// ---------------------------------------------------------------------------
// addressBookFor — resolve the book from a chainId OR a viem PublicClient.
// Every lib function already takes a PublicClient (which carries .chain.id), so
// it resolves the per-chain book INSIDE the function with no signature change.
// ---------------------------------------------------------------------------

/** Anything carrying a chain id we can resolve from (a number or a viem client). */
type ChainIdOrClient = number | { chain?: { id?: number } | undefined } | null | undefined

function extractChainId(source: ChainIdOrClient): number | undefined {
  if (typeof source === 'number') return source
  if (source && typeof source === 'object' && source.chain && typeof source.chain.id === 'number') {
    return source.chain.id
  }
  return undefined
}

/** Type guard: is this a chain id OpenPendle supports? */
export function isSupportedChainId(id: number | undefined): id is SupportedChainId {
  return id !== undefined && Object.prototype.hasOwnProperty.call(ADDRESS_BOOKS, id)
}

/**
 * Chain id from a viem PublicClient (or chainId number), or undefined if the
 * client has no configured chain. Same resolution `addressBookFor` uses, but
 * without the throw — callers that only need the id (e.g. sweepKey, native
 * symbol) avoid the `client.chain` possibly-undefined narrowing at each site.
 */
export function chainIdOf(source: ChainIdOrClient): number | undefined {
  return extractChainId(source)
}

/**
 * Resolve the per-chain AddressBook from a chainId number OR a viem
 * PublicClient (reads `client.chain.id`). Throws a clear error for a chain
 * without a Pendle deployment or a client with no configured chain.
 */
export function addressBookFor(source: ChainIdOrClient): AddressBook {
  const id = extractChainId(source)
  if (id === undefined) {
    throw new Error(
      'addressBookFor: could not determine chain id — pass a chainId number or a PublicClient with a configured chain.',
    )
  }
  if (!isSupportedChainId(id)) {
    throw new Error(
      `addressBookFor: chain ${id} is not supported by OpenPendle (no Pendle V2 deployment configured). Supported: ${SUPPORTED_CHAINS.map((c) => c.id).join(', ')}.`,
    )
  }
  return ADDRESS_BOOKS[id]
}

// ---------------------------------------------------------------------------
// Supported chains — display metadata (name / short name / native symbol).
// Native symbol is NOT ETH on BSC (BNB), Monad (MON) or Plasma (XPL).
// ---------------------------------------------------------------------------

export interface SupportedChain {
  id: SupportedChainId
  name: string
  shortName: string
  nativeSymbol: string
}

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  { id: 1, name: 'Ethereum', shortName: 'ETH', nativeSymbol: 'ETH' },
  { id: 56, name: 'BNB Smart Chain', shortName: 'BSC', nativeSymbol: 'BNB' },
  { id: 143, name: 'Monad', shortName: 'MON', nativeSymbol: 'MON' },
  { id: 8453, name: 'Base', shortName: 'Base', nativeSymbol: 'ETH' },
  { id: 9745, name: 'Plasma', shortName: 'XPL', nativeSymbol: 'XPL' },
  { id: 42161, name: 'Arbitrum', shortName: 'ARB', nativeSymbol: 'ETH' },
] as const

/** The SUPPORTED_CHAINS entry for a chain id (undefined if unsupported). */
export function supportedChain(id: number | undefined): SupportedChain | undefined {
  return SUPPORTED_CHAINS.find((c) => c.id === id)
}

// ---------------------------------------------------------------------------
// Per-chain RPC defaults + user overrides (localStorage `openpendle.rpc.<id>`).
// Defaults are log-capable public endpoints (publicnode / drpc / llamarpc),
// steering off throttled official endpoints (Plasma's non-production rpc,
// BSC dataseeds that disable eth_getLogs). Users override per chain in the
// settings panel; the M6 recovery scan + M1 acceptance sweep need eth_getLogs.
// ---------------------------------------------------------------------------

export const DEFAULT_RPCS: Record<SupportedChainId, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  56: 'https://bsc-rpc.publicnode.com',
  143: 'https://rpc.monad.xyz',
  8453: 'https://base.publicnode.com',
  9745: 'https://plasma.drpc.org',
  42161: 'https://arb1.arbitrum.io/rpc',
}

/** localStorage key holding a user-supplied RPC URL for a given chain. */
export function rpcStorageKey(chainId: SupportedChainId): string {
  return `openpendle.rpc.${chainId}`
}

function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//.test(value.trim())
}

/**
 * The effective RPC URL for a chain: the user's override
 * (localStorage `openpendle.rpc.<id>`) if set + valid, else the default.
 * Back-compat: chain 42161 also honors the LEGACY key `openpendle.rpc`
 * (pre-M8, un-suffixed) so existing users keep their custom Arbitrum RPC.
 */
export function getChainRpcUrl(chainId: SupportedChainId): string {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const scoped = window.localStorage.getItem(rpcStorageKey(chainId))
      if (isHttpUrl(scoped)) return scoped.trim()
      if (chainId === ARBITRUM_CHAIN_ID) {
        const legacy = window.localStorage.getItem(RPC_STORAGE_KEY)
        if (isHttpUrl(legacy)) return legacy.trim()
      }
    }
  } catch {
    // localStorage unavailable (privacy mode) — fall through to the default.
  }
  return DEFAULT_RPCS[chainId]
}

/** Persist a user RPC override for a chain (empty/whitespace clears it back to the default). */
export function setChainRpcUrl(chainId: SupportedChainId, url: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const trimmed = url.trim()
    if (trimmed === '') {
      window.localStorage.removeItem(rpcStorageKey(chainId))
      if (chainId === ARBITRUM_CHAIN_ID) window.localStorage.removeItem(RPC_STORAGE_KEY)
    } else {
      window.localStorage.setItem(rpcStorageKey(chainId), trimmed)
    }
  } catch {
    // Quota / storage disabled — no-op.
  }
}

// ---------------------------------------------------------------------------
// Back-compat exports (pre-M8). The UI agent's existing components import these
// (ProtocolStatus, RpcSettings, TxButton, createReads, CreateSyPage, and the
// pure lib modules registry/deploy). Kept working; the Arbitrum-scoped ones
// delegate to the new per-chain helpers so there is a single source of truth.
// ---------------------------------------------------------------------------

export const ARBITRUM_CHAIN_ID = 42161 as const

/** LEGACY single-chain RPC storage key (un-suffixed). Retained for the RpcSettings component + migration. */
export const RPC_STORAGE_KEY = 'openpendle.rpc'

/** LEGACY default RPC — the Arbitrum default, delegated to the per-chain table. */
export const DEFAULT_RPC_URL = DEFAULT_RPCS[ARBITRUM_CHAIN_ID]

/**
 * LEGACY RouterStatic export (Arbitrum). RouterStatic is PER CHAIN — new lib
 * code resolves `addressBookFor(client).routerStatic`; this Arbitrum-scoped
 * constant is retained for the Arbitrum fork-test scripts (m3/m4) that reference
 * it directly. Delegates to the Arbitrum book so there is one source of truth.
 */
export const ROUTER_STATIC: Address = ADDRESS_BOOKS[ARBITRUM_CHAIN_ID].routerStatic

/** LEGACY Pendle treasury export (Arbitrum). Per-chain callers should use addressBookFor(client).treasury. */
export const PENDLE_TREASURY: Address = ADDRESS_BOOKS[ARBITRUM_CHAIN_ID].treasury

/** LEGACY PENDLE token export (Arbitrum). Per-chain callers should use addressBookFor(client).pendle. */
export const PENDLE_TOKEN: Address = ADDRESS_BOOKS[ARBITRUM_CHAIN_ID].pendle

/**
 * LEGACY Pendle governance multisig export (Arbitrum). Kept for any importer;
 * per-chain callers resolve `addressBookFor(client).governance`.
 */
export const PENDLE_GOVERNANCE_MULTISIG: Address = ADDRESS_BOOKS[ARBITRUM_CHAIN_ID].governance

/**
 * LEGACY Arbitrum factory-generation list. Retained so any lingering importer
 * keeps compiling; new lib code resolves `addressBookFor(client).marketFactories`.
 */
export const FACTORY_GENERATIONS: readonly FactoryGeneration[] =
  ADDRESS_BOOKS[ARBITRUM_CHAIN_ID].marketFactories

/** LEGACY Arbitrum market-factory validation set. */
export const MARKET_FACTORIES: readonly Address[] = FACTORY_GENERATIONS.map((g) => g.marketFactory)

/** LEGACY Arbitrum paired yield-contract-factory set. */
export const YIELD_CONTRACT_FACTORIES: readonly Address[] = FACTORY_GENERATIONS.map(
  (g) => g.yieldContractFactory,
)

/** LEGACY ExpiredLpPtRedeemer (Arbitrum only, non-goal v1 — reference). */
export const EXPIRED_LP_PT_REDEEMER: Address = '0x23567b248cd64479384d2E0Cbe83522aFB8DD446'

/** LEGACY PendleMulticallV2 (Arbitrum) — Pendle's own aggregator (unused by the reads, kept for reference). */
export const PENDLE_MULTICALL_V2: Address = '0x539fd510fE352CC81822a222F821c340133Ed41C'
