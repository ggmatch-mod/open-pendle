/**
 * Reviewed allowlist for browser-built looping transactions.
 *
 * This is intentionally not a general Morpho/Pendle address book. A market is
 * executable only when its chain and exact Morpho market id resolve here. An
 * unknown chain, market, SY route token, or external router fails closed.
 */

import { encodeAbiParameters, getAddress, keccak256 } from 'viem'
import type { Address, Hex } from 'viem'
import { morphoMarketIdParameters } from './loopingAbi.ts'
import {
  LOOPING_MARKET_CANDIDATE_MANIFEST,
  type ReviewedLoopingMarketCandidate,
} from './loopingMarketManifest.ts'

export const ETHEREUM_LOOPING_CHAIN_ID = 1 as const
export const MONAD_LOOPING_CHAIN_ID = 143 as const
export const ARBITRUM_LOOPING_CHAIN_ID = 42_161 as const
export type LoopingExecutionChainId =
  | typeof ETHEREUM_LOOPING_CHAIN_ID
  | typeof MONAD_LOOPING_CHAIN_ID
  | 8_453
  | typeof ARBITRUM_LOOPING_CHAIN_ID

export interface LoopingMorphoMarketParams {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

export interface LoopingExecutionContracts {
  morpho: Address
  bundler3: Address
  generalAdapter1: Address
  pendleRouter: Address
  pendleSwap: Address
  multicall3: Address
}

export interface LoopingRuntimeCodePolicy {
  /** Runtime bytecode hashes pin the exact contracts whose storage/callback behavior was reviewed. */
  morpho: Hex
  bundler3: Hex
  generalAdapter1: Hex
  pendleRouter: Hex
  pendleRouterImplementation: Hex
  pendleRouterRedeemImplementation: Hex
  pendleSwap: Hex
  pendleSwapImplementation: Hex
  kyberRouter: Hex
  multicall3: Hex
}

export interface LoopingRouteUpgradePolicy {
  pendleRouter: Readonly<{
    implementation: Address
    redeemImplementation: Address
    selectorImplementationSlots: readonly [
      Readonly<{ selector: '0xc81f847a'; storageSlot: Hex }>,
      Readonly<{ selector: '0x594a88cc'; storageSlot: Hex }>,
      Readonly<{ selector: '0x47f1de22'; storageSlot: Hex }>,
    ]
  }>
  pendleSwap: Readonly<{
    implementation: Address
    implementationStorageSlot: Hex
  }>
  kyberRouter: Readonly<{
    address: Address
  }>
}

export interface LoopingKyberExecutorPolicy {
  address: Address
  /** `keccak256` of the reviewed chain's live runtime bytecode. */
  runtimeCodeHash: Hex
}

export interface LoopingKyberRoutePolicy {
  executorAllowlist: readonly Readonly<LoopingKyberExecutorPolicy>[]
  expectedFlags: 512n
  maxSourceReceivers: 8
  maxTargetDataBytes: 16_384
  maxClientDataBytes: 4_096
}

export interface LoopingRoutePolicy {
  aggregator: 'kyberswap'
  swapType: 1
  externalRouterAllowlist: readonly Address[]
  kyber: Readonly<LoopingKyberRoutePolicy>
  mintSyTokenAllowlist: readonly Address[]
  redeemSyTokenAllowlist: readonly Address[]
  entryNeedScale: false
  exitNeedScale: true
}

export interface LoopingLaunchPolicy {
  /** Decimal fraction: 0.01 means a 1% Pendle quote tolerance. */
  quoteSlippage: 0.01
  /** Absolute live execution floor: 100 bps means 1% before liquidation. */
  modelMinLiquidationBufferBps: 100
  /** Red warning marker. Risk increases below it require explicit confirmation. */
  minLiquidationBufferBps: 1_000
  /** Minimum oracle value retained versus supplied equity plus entry debt. */
  minEntryValueBps: 9_000
  /** Short lifetime for each paired Morpho authorization signature. */
  authorizationLifetimeSeconds: 120n
  borrowShareBufferBps: 50
  repayDriftBps: 100
  quoteValidityMs: 45_000
}

export interface LoopingExecutionMarket {
  chainId: LoopingExecutionChainId
  marketId: Hex
  display: Readonly<{
    name: string
    loanTokenSymbol: string
    collateralTokenSymbol: string
  }>
  pendleMarket: Address
  pendleMarketExpiry: bigint
  standardizedYield: Address
  morphoMarketParams: Readonly<LoopingMorphoMarketParams>
  contracts: Readonly<LoopingExecutionContracts>
  runtimeCodePolicy: Readonly<LoopingRuntimeCodePolicy>
  routeUpgradePolicy: Readonly<LoopingRouteUpgradePolicy>
  routePolicy: Readonly<LoopingRoutePolicy>
  launchPolicy: Readonly<LoopingLaunchPolicy>
  loanTokenDecimals: number
  collateralTokenDecimals: number
}

/** Security-relevant directory fields required before a reviewed market can execute. */
export interface LoopingExecutionCandidateIdentity {
  morpho: Readonly<{
    chainId: number
    marketId: string
    tuple: Readonly<LoopingMorphoMarketParams>
    loanAsset: Readonly<{ address: Address; decimals: number }>
    collateralAsset: Readonly<{ address: Address; decimals: number }>
  }>
  pendle: Readonly<{
    chainId: number
    market: Address
    pt: Address
    expiry: number
  }>
}

export class LoopingRegistryError extends Error {
  readonly code:
    | 'INVALID_MARKET_ID'
    | 'MARKET_NOT_ALLOWLISTED'
    | 'ADDRESS_NOT_ALLOWLISTED'
    | 'CODE_HASH_NOT_ALLOWLISTED'

  constructor(
    code: LoopingRegistryError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'LoopingRegistryError'
    this.code = code
  }
}

const ARBITRUM_LOOPING_CONTRACTS: Readonly<LoopingExecutionContracts> =
  Object.freeze({
    morpho: '0x6c247b1F6182318877311737BaC0844bAa518F5e',
    bundler3: '0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13',
    generalAdapter1: '0x9954aFB60BB5A222714c478ac86990F221788B88',
    pendleRouter: '0x888888888889758F76e7103c6CbF23ABbF58F946',
    pendleSwap: '0xd4F480965D2347d421F1bEC7F545682E5Ec2151D',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  })

const ARBITRUM_LOOPING_RUNTIME_CODE_POLICY: Readonly<LoopingRuntimeCodePolicy> =
  Object.freeze({
    morpho:
      '0xd2bb64e51bc71ff5ce00ae89eab643e65fda6fc59f4ab8c367241c4bedf8acf5',
    bundler3:
      '0xd3912f2b89d1e2848544ca398d337f59950ffb9ecc38a7bd644063fa094c8454',
    generalAdapter1:
      '0xdbe426ef0ae7a487da9c6ba392089dad8cb1438943b8fff71279bc7d669bdbb2',
    pendleRouter:
      '0x6e7e96418259651300fbc9b9035c0613bfefc601ddbd840ab39a068ab3ee4293',
    pendleRouterImplementation:
      '0x5e98f3973c2fdabae1168b4afe928c16d4ca9d71803efeacd978fc3bb3898063',
    pendleRouterRedeemImplementation:
      '0x24634730bd528871bc7aada351e5332505c9a51746535b15f377b9978372aed9',
    pendleSwap:
      '0x114e0fcd5f3bdf77cbeefc2f92930a8d648fe71f3ba30b23248bde2507c2f266',
    pendleSwapImplementation:
      '0x5d9d2986245b2745643f17ad845576f72ba13ad28ad45a362e75470340e36894',
    kyberRouter:
      '0x7c53f923286b51431195fc137a16cb9461662b5ae2476353979a52daa527aeaa',
    multicall3:
      '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
  })

const ARBITRUM_LOOPING_ROUTE_UPGRADE_POLICY: Readonly<LoopingRouteUpgradePolicy> =
  Object.freeze({
    pendleRouter: Object.freeze({
      implementation: '0xd8D200d9A713A1c71cF1e7F694B14E5F1D948b15',
      redeemImplementation: '0x373Dba2055Ad40cb4815148bC47cd1DC16e92E44',
      selectorImplementationSlots: Object.freeze([
        Object.freeze({
          selector: '0xc81f847a',
          storageSlot:
            '0xb820d981672246ed2ae2a03a3d77375d8c0576df8bfcece9761c680a952be441',
        }),
        Object.freeze({
          selector: '0x594a88cc',
          storageSlot:
            '0x89ba60bec361b63cc61987f4256981640e7591ee7c9f24b02af2c6fb517cf783',
        }),
        Object.freeze({
          selector: '0x47f1de22',
          storageSlot:
            '0x6734da2a1f646755e54dcb758d0c7e0fe931aba0c85863dd8c0a6bdec717cb9c',
        }),
      ] as const),
    }),
    pendleSwap: Object.freeze({
      implementation: '0x4BaC1d43b7a3a31d84E193B5D4b651F4f3B46AF6',
      implementationStorageSlot:
        '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    }),
    kyberRouter: Object.freeze({
      address: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    }),
  })

const ARBITRUM_KYBER_ROUTER_ALLOWLIST = Object.freeze([
  '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
] as const satisfies readonly Address[])

const ARBITRUM_KYBER_EXECUTOR_ALLOWLIST = Object.freeze([
  Object.freeze({
    address: '0x8F10B468b06c6FD214B65F87778827F7D113f996',
    runtimeCodeHash:
      '0xc3fe18bd9e1e31adecfcaba58177f3d796c3028e7d53a628e321e18295e10682',
  }),
] as const satisfies readonly Readonly<LoopingKyberExecutorPolicy>[])

/** Tokens returned by the canary market SY's on-chain `getTokensIn()`. */
const ARBITRUM_CANARY_MINT_SY_TOKEN_ALLOWLIST = Object.freeze([
  '0x46850aD61C2B7d64d08c9C754F45254596696984',
  '0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF',
] as const satisfies readonly Address[])

/** Token selected from the canary market SY's on-chain `getTokensOut()`. */
const ARBITRUM_CANARY_REDEEM_SY_TOKEN_ALLOWLIST = Object.freeze([
  '0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF',
] as const satisfies readonly Address[])

const ARBITRUM_USDAI_ROUTE_POLICY: Readonly<LoopingRoutePolicy> =
  Object.freeze({
    aggregator: 'kyberswap',
    swapType: 1,
    externalRouterAllowlist: ARBITRUM_KYBER_ROUTER_ALLOWLIST,
    kyber: Object.freeze({
      executorAllowlist: ARBITRUM_KYBER_EXECUTOR_ALLOWLIST,
      expectedFlags: 512n,
      maxSourceReceivers: 8,
      maxTargetDataBytes: 16_384,
      maxClientDataBytes: 4_096,
    }),
    mintSyTokenAllowlist: ARBITRUM_CANARY_MINT_SY_TOKEN_ALLOWLIST,
    redeemSyTokenAllowlist: ARBITRUM_CANARY_REDEEM_SY_TOKEN_ALLOWLIST,
    entryNeedScale: false,
    exitNeedScale: true,
  })

const ARBITRUM_USDAI_LAUNCH_POLICY: Readonly<LoopingLaunchPolicy> =
  Object.freeze({
    quoteSlippage: 0.01,
    modelMinLiquidationBufferBps: 100,
    minLiquidationBufferBps: 1_000,
    minEntryValueBps: 9_000,
    authorizationLifetimeSeconds: 120n,
    borrowShareBufferBps: 50,
    repayDriftBps: 100,
    quoteValidityMs: 45_000,
  })

const ARBITRUM_CANARY_MORPHO_MARKET_PARAMS: Readonly<LoopingMorphoMarketParams> =
  Object.freeze({
    loanToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    collateralToken: '0xC9d24aD0bB25F34098e226a8C5192Dea7bacccaE',
    oracle: '0xaAe5194036306A14B6bFE51A255001bd75F315b1',
    irm: '0x66F30587FB8D4206918deb78ecA7d5eBbafD06DA',
    lltv: 915_000_000_000_000_000n,
  })

const ETHEREUM_LOOPING_CONTRACTS: Readonly<LoopingExecutionContracts> =
  Object.freeze({
    morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    bundler3: '0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245',
    generalAdapter1: '0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0',
    pendleRouter: '0x888888888889758F76e7103c6CbF23ABbF58F946',
    pendleSwap: '0xd4F480965D2347d421F1bEC7F545682E5Ec2151D',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  })

const ETHEREUM_LOOPING_RUNTIME_CODE_POLICY: Readonly<LoopingRuntimeCodePolicy> =
  Object.freeze({
    morpho:
      '0xfa259fa317198f88f5fa3c119f06c066295dbcd47d715e0a30e1bcf94c02ef8c',
    bundler3:
      '0xd3912f2b89d1e2848544ca398d337f59950ffb9ecc38a7bd644063fa094c8454',
    generalAdapter1:
      '0xf9cc71076c5b97dca248a8085a0faaad24a5768948474306a20e345a739dd74c',
    pendleRouter:
      '0x6e7e96418259651300fbc9b9035c0613bfefc601ddbd840ab39a068ab3ee4293',
    pendleRouterImplementation:
      '0x5e98f3973c2fdabae1168b4afe928c16d4ca9d71803efeacd978fc3bb3898063',
    pendleRouterRedeemImplementation:
      '0x24634730bd528871bc7aada351e5332505c9a51746535b15f377b9978372aed9',
    pendleSwap:
      '0x114e0fcd5f3bdf77cbeefc2f92930a8d648fe71f3ba30b23248bde2507c2f266',
    pendleSwapImplementation:
      '0x7ef546e29d845476c1c0a0a0c1637a4192bb90dc4b687c9e36687f63337d7111',
    kyberRouter:
      '0x06468e29bde518202bb725caad5eaaf8184c1b5338d8228e7c779248dbc9e2a3',
    multicall3:
      '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
  })

const ETHEREUM_LOOPING_ROUTE_UPGRADE_POLICY: Readonly<LoopingRouteUpgradePolicy> =
  Object.freeze({
    pendleRouter: Object.freeze({
      implementation: '0xd8D200d9A713A1c71cF1e7F694B14E5F1D948b15',
      redeemImplementation: '0x373Dba2055Ad40cb4815148bC47cd1DC16e92E44',
      selectorImplementationSlots: Object.freeze([
        Object.freeze({
          selector: '0xc81f847a',
          storageSlot:
            '0xb820d981672246ed2ae2a03a3d77375d8c0576df8bfcece9761c680a952be441',
        }),
        Object.freeze({
          selector: '0x594a88cc',
          storageSlot:
            '0x89ba60bec361b63cc61987f4256981640e7591ee7c9f24b02af2c6fb517cf783',
        }),
        Object.freeze({
          selector: '0x47f1de22',
          storageSlot:
            '0x6734da2a1f646755e54dcb758d0c7e0fe931aba0c85863dd8c0a6bdec717cb9c',
        }),
      ] as const),
    }),
    pendleSwap: Object.freeze({
      implementation: '0xBC17404b7bb500051c75C83E4aA5aE447D967811',
      implementationStorageSlot:
        '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    }),
    kyberRouter: Object.freeze({
      address: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    }),
  })

const ETHEREUM_REUSD_SY_TOKEN_ALLOWLIST = Object.freeze([
  '0x5086bf358635B81D8C47C66d1C8b9E567Db70c72',
] as const satisfies readonly Address[])

const ETHEREUM_REUSD_ROUTE_POLICY: Readonly<LoopingRoutePolicy> =
  Object.freeze({
    aggregator: 'kyberswap',
    swapType: 1,
    externalRouterAllowlist: Object.freeze([
      '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    ] as const satisfies readonly Address[]),
    kyber: Object.freeze({
      executorAllowlist: Object.freeze([
        Object.freeze({
          address: '0x8F10B468b06c6FD214B65F87778827F7D113f996',
          runtimeCodeHash:
            '0xc3fe18bd9e1e31adecfcaba58177f3d796c3028e7d53a628e321e18295e10682',
        }),
      ] as const satisfies readonly Readonly<LoopingKyberExecutorPolicy>[]),
      expectedFlags: 512n,
      maxSourceReceivers: 8,
      maxTargetDataBytes: 16_384,
      maxClientDataBytes: 4_096,
    }),
    mintSyTokenAllowlist: ETHEREUM_REUSD_SY_TOKEN_ALLOWLIST,
    redeemSyTokenAllowlist: ETHEREUM_REUSD_SY_TOKEN_ALLOWLIST,
    entryNeedScale: false,
    exitNeedScale: true,
  })

const ETHEREUM_REUSD_LAUNCH_POLICY: Readonly<LoopingLaunchPolicy> =
  Object.freeze({
    quoteSlippage: 0.01,
    modelMinLiquidationBufferBps: 100,
    minLiquidationBufferBps: 1_000,
    minEntryValueBps: 9_000,
    authorizationLifetimeSeconds: 120n,
    borrowShareBufferBps: 50,
    repayDriftBps: 100,
    quoteValidityMs: 45_000,
  })

const MONAD_LOOPING_CONTRACTS: Readonly<LoopingExecutionContracts> =
  Object.freeze({
    morpho: '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee',
    bundler3: '0x82b684483e844422FD339df0b67b3B111F02c66E',
    generalAdapter1: '0x725AB8CAd931BCb80Fdbf10955a806765cCe00e5',
    pendleRouter: '0x888888888889758F76e7103c6CbF23ABbF58F946',
    pendleSwap: '0xd4F480965D2347d421F1bEC7F545682E5Ec2151D',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  })

const MONAD_LOOPING_RUNTIME_CODE_POLICY: Readonly<LoopingRuntimeCodePolicy> =
  Object.freeze({
    morpho:
      '0xb7a6b485eae3ae09fa451369d5001078c2b5a0a409b7a5908ff080b54f68acce',
    bundler3:
      '0xd3912f2b89d1e2848544ca398d337f59950ffb9ecc38a7bd644063fa094c8454',
    generalAdapter1:
      '0xc33e1de8456b2194f397dccb67f24290a8a5d2db896c892c42a7087196f45b08',
    pendleRouter:
      '0xede7d999cb3da0979eaa44b51d5688f7e4185eab224cac8c295c1702350a12ed',
    pendleRouterImplementation:
      '0x1f4fbfa10c4493836243d3325e486dd3e241cee5e715d00b68540ab8eed76181',
    pendleRouterRedeemImplementation:
      '0x8ed5e9bf05f39a1050fba75d81e29fc1dd8e0072e93c7205c595b9955b4ff9c8',
    pendleSwap:
      '0x692d6f336da9d107e0eeb1d7844190b769d97c75ca4fe0d8f3ba655bb8eea8fa',
    pendleSwapImplementation:
      '0xfb6d176d787231bdf5ee4c4a25e802dc1919f61988cbffb386f14a5400f726fa',
    kyberRouter:
      '0x73055c10f463ef7d44c444ccae0b71ab4cacaf67aedbad2cd8af639d53cc6316',
    multicall3:
      '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
  })

const MONAD_LOOPING_ROUTE_UPGRADE_POLICY: Readonly<LoopingRouteUpgradePolicy> =
  Object.freeze({
    pendleRouter: Object.freeze({
      implementation: '0xbb0Dd79794e58795b08b599297ec55a6Afb6AB58',
      redeemImplementation: '0xac1700293346b0bEFC71bCB7E14Bf1c38a5c2a97',
      selectorImplementationSlots: Object.freeze([
        Object.freeze({
          selector: '0xc81f847a',
          storageSlot:
            '0xb820d981672246ed2ae2a03a3d77375d8c0576df8bfcece9761c680a952be441',
        }),
        Object.freeze({
          selector: '0x594a88cc',
          storageSlot:
            '0x89ba60bec361b63cc61987f4256981640e7591ee7c9f24b02af2c6fb517cf783',
        }),
        Object.freeze({
          selector: '0x47f1de22',
          storageSlot:
            '0x6734da2a1f646755e54dcb758d0c7e0fe931aba0c85863dd8c0a6bdec717cb9c',
        }),
      ] as const),
    }),
    pendleSwap: Object.freeze({
      implementation: '0x7fbA4Da81B80a6BfFc337eF9D593047d6f84fe8C',
      implementationStorageSlot:
        '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    }),
    kyberRouter: Object.freeze({
      address: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    }),
  })

const MONAD_AUSD_SY_TOKEN_ALLOWLIST = Object.freeze([
  '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
] as const satisfies readonly Address[])

const MONAD_AUSD_ROUTE_POLICY: Readonly<LoopingRoutePolicy> = Object.freeze({
  aggregator: 'kyberswap',
  swapType: 1,
  externalRouterAllowlist: Object.freeze([
    '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  ] as const satisfies readonly Address[]),
  kyber: Object.freeze({
    executorAllowlist: Object.freeze([
      Object.freeze({
        address: '0x8F10B468b06c6FD214B65F87778827F7D113f996',
        runtimeCodeHash:
          '0xc3fe18bd9e1e31adecfcaba58177f3d796c3028e7d53a628e321e18295e10682',
      }),
    ] as const satisfies readonly Readonly<LoopingKyberExecutorPolicy>[]),
    expectedFlags: 512n,
    maxSourceReceivers: 8,
    maxTargetDataBytes: 16_384,
    maxClientDataBytes: 4_096,
  }),
  mintSyTokenAllowlist: MONAD_AUSD_SY_TOKEN_ALLOWLIST,
  redeemSyTokenAllowlist: MONAD_AUSD_SY_TOKEN_ALLOWLIST,
  entryNeedScale: false,
  exitNeedScale: true,
})

const MONAD_AUSD_LAUNCH_POLICY: Readonly<LoopingLaunchPolicy> = Object.freeze({
  quoteSlippage: 0.01,
  modelMinLiquidationBufferBps: 100,
  minLiquidationBufferBps: 1_000,
  minEntryValueBps: 9_000,
  authorizationLifetimeSeconds: 120n,
  borrowShareBufferBps: 50,
  repayDriftBps: 100,
  quoteValidityMs: 45_000,
})

export const ETHEREUM_LOOPING_REUSD: Readonly<LoopingExecutionMarket> =
  Object.freeze({
    chainId: ETHEREUM_LOOPING_CHAIN_ID,
    marketId:
      '0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64',
    display: Object.freeze({
      name: 'PT-reUSD / USDC',
      loanTokenSymbol: 'USDC',
      collateralTokenSymbol: 'PT-reUSD',
    }),
    pendleMarket: '0x13285bCbc27F92b47B4EDB99D744C07B48C977c0',
    pendleMarketExpiry: 1_796_860_800n,
    standardizedYield: '0x9487Bd5A3b16Ecb5F3184453E3ee75B800141648',
    morphoMarketParams: Object.freeze({
      loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      collateralToken: '0xeCfaFdC7741323a945A163ed068B5a3C43483957',
      oracle: '0x217d6DdCDB95112C51657F6270e8C079CFDB51f0',
      irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
      lltv: 915_000_000_000_000_000n,
    }),
    contracts: ETHEREUM_LOOPING_CONTRACTS,
    runtimeCodePolicy: ETHEREUM_LOOPING_RUNTIME_CODE_POLICY,
    routeUpgradePolicy: ETHEREUM_LOOPING_ROUTE_UPGRADE_POLICY,
    routePolicy: ETHEREUM_REUSD_ROUTE_POLICY,
    launchPolicy: ETHEREUM_REUSD_LAUNCH_POLICY,
    loanTokenDecimals: 6,
    collateralTokenDecimals: 6,
  })

export const MONAD_LOOPING_AUSD: Readonly<LoopingExecutionMarket> =
  Object.freeze({
    chainId: MONAD_LOOPING_CHAIN_ID,
    marketId:
      '0x93a7a013b5501cee5d9bee0d29bb3fca790196134c4c7058365e5bc6d2ad80a2',
    display: Object.freeze({
      name: 'PT-AUSD / USDC',
      loanTokenSymbol: 'USDC',
      collateralTokenSymbol: 'PT-AUSD',
    }),
    pendleMarket: '0x6f99CF00ee7290aE78a072Bb6910eF72D1129fE7',
    pendleMarketExpiry: 1_791_417_600n,
    standardizedYield: '0xBA3d60f5000f472aef947FB8020a3E6319F9a0B7',
    morphoMarketParams: Object.freeze({
      loanToken: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      collateralToken: '0x9FC74f8Ed616B5BaF52a170caa97d6d3898602d1',
      oracle: '0x436CA3263B1AAA57d286823a42E35d8c228e85a2',
      irm: '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F',
      lltv: 915_000_000_000_000_000n,
    }),
    contracts: MONAD_LOOPING_CONTRACTS,
    runtimeCodePolicy: MONAD_LOOPING_RUNTIME_CODE_POLICY,
    routeUpgradePolicy: MONAD_LOOPING_ROUTE_UPGRADE_POLICY,
    routePolicy: MONAD_AUSD_ROUTE_POLICY,
    launchPolicy: MONAD_AUSD_LAUNCH_POLICY,
    loanTokenDecimals: 6,
    collateralTokenDecimals: 6,
  })

export const ARBITRUM_LOOPING_CANARY: Readonly<LoopingExecutionMarket> =
  Object.freeze({
    chainId: ARBITRUM_LOOPING_CHAIN_ID,
    marketId:
      '0x97cb4b88a7a5e8e9c039b106374124e642395437ffc0ef93f2799343ad022985',
    display: Object.freeze({
      name: 'PT-USDai / USDC',
      loanTokenSymbol: 'USDC',
      collateralTokenSymbol: 'PT-USDai',
    }),
    pendleMarket: '0xA8a0DEA40174CfC30fEA9e3A77f182aB33f46E25',
    pendleMarketExpiry: 1_792_022_400n,
    standardizedYield: '0x5edCBC20Cac67AdC2e724d4348Ff85132B085b82',
    morphoMarketParams: ARBITRUM_CANARY_MORPHO_MARKET_PARAMS,
    contracts: ARBITRUM_LOOPING_CONTRACTS,
    runtimeCodePolicy: ARBITRUM_LOOPING_RUNTIME_CODE_POLICY,
    routeUpgradePolicy: ARBITRUM_LOOPING_ROUTE_UPGRADE_POLICY,
    routePolicy: ARBITRUM_USDAI_ROUTE_POLICY,
    launchPolicy: ARBITRUM_USDAI_LAUNCH_POLICY,
    loanTokenDecimals: 6,
    collateralTokenDecimals: 18,
  })

/** Reviewed USDT0 debt tuple for the same USDai Pendle PT. */
export const ARBITRUM_LOOPING_USDT0_USDAI: Readonly<LoopingExecutionMarket> =
  Object.freeze({
    chainId: ARBITRUM_LOOPING_CHAIN_ID,
    marketId:
      '0x6433f5db2936ca728ef720b2e97e111f04f2c276d78b89eb19d7939bda93cd6e',
    display: Object.freeze({
      name: 'PT-USDai / USDT0',
      loanTokenSymbol: 'USDT0',
      collateralTokenSymbol: 'PT-USDai',
    }),
    pendleMarket: '0xA8a0DEA40174CfC30fEA9e3A77f182aB33f46E25',
    pendleMarketExpiry: 1_792_022_400n,
    standardizedYield: '0x5edCBC20Cac67AdC2e724d4348Ff85132B085b82',
    morphoMarketParams: Object.freeze({
      loanToken: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      collateralToken: '0xC9d24aD0bB25F34098e226a8C5192Dea7bacccaE',
      oracle: '0xaAe5194036306A14B6bFE51A255001bd75F315b1',
      irm: '0x66F30587FB8D4206918deb78ecA7d5eBbafD06DA',
      lltv: 915_000_000_000_000_000n,
    }),
    contracts: ARBITRUM_LOOPING_CONTRACTS,
    runtimeCodePolicy: ARBITRUM_LOOPING_RUNTIME_CODE_POLICY,
    routeUpgradePolicy: ARBITRUM_LOOPING_ROUTE_UPGRADE_POLICY,
    routePolicy: ARBITRUM_USDAI_ROUTE_POLICY,
    launchPolicy: ARBITRUM_USDAI_LAUNCH_POLICY,
    loanTokenDecimals: 6,
    collateralTokenDecimals: 18,
  })

function chainExecutionResources(chainId: LoopingExecutionChainId): Readonly<{
  contracts: Readonly<LoopingExecutionContracts>
  runtimeCodePolicy: Readonly<LoopingRuntimeCodePolicy>
  routeUpgradePolicy: Readonly<LoopingRouteUpgradePolicy>
  routePolicyTemplate: Readonly<LoopingRoutePolicy>
  launchPolicyTemplate: Readonly<LoopingLaunchPolicy>
}> {
  switch (chainId) {
    case ETHEREUM_LOOPING_CHAIN_ID:
      return {
        contracts: ETHEREUM_LOOPING_CONTRACTS,
        runtimeCodePolicy: ETHEREUM_LOOPING_RUNTIME_CODE_POLICY,
        routeUpgradePolicy: ETHEREUM_LOOPING_ROUTE_UPGRADE_POLICY,
        routePolicyTemplate: ETHEREUM_REUSD_ROUTE_POLICY,
        launchPolicyTemplate: ETHEREUM_REUSD_LAUNCH_POLICY,
      }
    case MONAD_LOOPING_CHAIN_ID:
      return {
        contracts: MONAD_LOOPING_CONTRACTS,
        runtimeCodePolicy: MONAD_LOOPING_RUNTIME_CODE_POLICY,
        routeUpgradePolicy: MONAD_LOOPING_ROUTE_UPGRADE_POLICY,
        routePolicyTemplate: MONAD_AUSD_ROUTE_POLICY,
        launchPolicyTemplate: MONAD_AUSD_LAUNCH_POLICY,
      }
    case ARBITRUM_LOOPING_CHAIN_ID:
      return {
        contracts: ARBITRUM_LOOPING_CONTRACTS,
        runtimeCodePolicy: ARBITRUM_LOOPING_RUNTIME_CODE_POLICY,
        routeUpgradePolicy: ARBITRUM_LOOPING_ROUTE_UPGRADE_POLICY,
        routePolicyTemplate: ARBITRUM_USDAI_ROUTE_POLICY,
        launchPolicyTemplate: ARBITRUM_USDAI_LAUNCH_POLICY,
      }
    default:
      throw new Error(`No reviewed looping execution resources for chain ${chainId}.`)
  }
}

function reviewedCandidateToExecutionMarket(
  candidate: Readonly<ReviewedLoopingMarketCandidate>,
): Readonly<LoopingExecutionMarket> {
  const resources = chainExecutionResources(candidate.chainId)
  return Object.freeze({
    chainId: candidate.chainId,
    marketId: candidate.marketId,
    display: Object.freeze({
      name: `${candidate.display.collateralTokenSymbol} / ${candidate.display.loanTokenSymbol}`,
      loanTokenSymbol: candidate.display.loanTokenSymbol,
      collateralTokenSymbol: candidate.display.collateralTokenSymbol,
    }),
    pendleMarket: candidate.pendleMarket,
    pendleMarketExpiry: candidate.pendleMarketExpiry,
    standardizedYield: candidate.standardizedYield,
    morphoMarketParams: candidate.morphoMarketParams,
    contracts: resources.contracts,
    runtimeCodePolicy: resources.runtimeCodePolicy,
    routeUpgradePolicy: resources.routeUpgradePolicy,
    routePolicy: Object.freeze({
      ...resources.routePolicyTemplate,
      mintSyTokenAllowlist: Object.freeze([...candidate.syTokensIn]),
      redeemSyTokenAllowlist: Object.freeze([...candidate.syTokensOut]),
    }),
    launchPolicy: resources.launchPolicyTemplate,
    loanTokenDecimals: candidate.loanTokenDecimals,
    collateralTokenDecimals: candidate.collateralTokenDecimals,
  })
}

const MANUALLY_EXPORTED_ENTRY_MARKET_KEYS = new Set([
  `${ETHEREUM_LOOPING_REUSD.chainId}:${ETHEREUM_LOOPING_REUSD.marketId.toLowerCase()}`,
  `${MONAD_LOOPING_AUSD.chainId}:${MONAD_LOOPING_AUSD.marketId.toLowerCase()}`,
  `${ARBITRUM_LOOPING_CANARY.chainId}:${ARBITRUM_LOOPING_CANARY.marketId.toLowerCase()}`,
])

const ADDITIONAL_REVIEWED_LOOPING_MARKETS = Object.freeze(
  LOOPING_MARKET_CANDIDATE_MANIFEST
    .filter((candidate) => !MANUALLY_EXPORTED_ENTRY_MARKET_KEYS.has(
      `${candidate.chainId}:${candidate.marketId.toLowerCase()}`,
    ))
    .map(reviewedCandidateToExecutionMarket),
)

/**
 * Reviewed identities which may open or increase when the separate live
 * liquidity, maturity, release-flag, and runtime-policy checks also pass.
 */
export const LOOPING_ENTRY_EXECUTION_REGISTRY:
readonly Readonly<LoopingExecutionMarket>[] = Object.freeze([
  ETHEREUM_LOOPING_REUSD,
  MONAD_LOOPING_AUSD,
  ARBITRUM_LOOPING_CANARY,
  ...ADDITIONAL_REVIEWED_LOOPING_MARKETS,
])

/**
 * Permanent position-management registry. Never remove an identity merely
 * because its PT matured or its borrow liquidity fell: Positions, reductions,
 * full exit, and permission recovery must remain available.
 */
export const LOOPING_EXECUTION_REGISTRY:
readonly Readonly<LoopingExecutionMarket>[] = Object.freeze([
  ...LOOPING_ENTRY_EXECUTION_REGISTRY,
  ARBITRUM_LOOPING_USDT0_USDAI,
])

const MARKET_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/

function normalizeMarketId(marketId: string): Hex {
  if (!MARKET_ID_PATTERN.test(marketId)) {
    throw new LoopingRegistryError(
      'INVALID_MARKET_ID',
      'Looping market id must be a 32-byte 0x-prefixed hex value.',
    )
  }
  return marketId.toLowerCase() as Hex
}

function normalizeAddress(address: string, label: string): Address {
  try {
    return getAddress(address)
  } catch {
    throw new LoopingRegistryError(
      'ADDRESS_NOT_ALLOWLISTED',
      `${label} is not a valid checksummed address.`,
    )
  }
}

/** Resolve only an explicitly reviewed chain + Morpho market-id pair. */
export function getLoopingExecutionMarket(
  chainId: number,
  marketId: string,
): Readonly<LoopingExecutionMarket> {
  const normalizedMarketId = normalizeMarketId(marketId)
  const market = LOOPING_EXECUTION_REGISTRY.find(
    (entry) =>
      entry.chainId === chainId &&
      entry.marketId.toLowerCase() === normalizedMarketId,
  )
  if (!market) {
    throw new LoopingRegistryError(
      'MARKET_NOT_ALLOWLISTED',
      `Looping execution is not allowlisted for chain ${chainId}, market ${normalizedMarketId}.`,
    )
  }
  return market
}

/** Safe UI predicate; malformed or unknown identities are unsupported. */
export function isLoopingExecutionMarketSupported(
  chainId: number,
  marketId: string,
): boolean {
  try {
    getLoopingExecutionMarket(chainId, marketId)
    return true
  } catch (error) {
    if (error instanceof LoopingRegistryError) return false
    throw error
  }
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * Resolve a directory candidate only when every execution-relevant identity
 * field matches the reviewed registry entry. A shared PT or Morpho market id
 * is not sufficient because discovery may expose more than one Pendle market.
 */
export function getLoopingExecutionCandidateMarket(
  candidate: Readonly<LoopingExecutionCandidateIdentity>,
): Readonly<LoopingExecutionMarket> {
  const market = getLoopingExecutionMarket(
    candidate.morpho.chainId,
    candidate.morpho.marketId,
  )
  const params = market.morphoMarketParams
  const matches =
    candidate.pendle.chainId === market.chainId &&
    sameAddress(candidate.pendle.market, market.pendleMarket) &&
    sameAddress(candidate.pendle.pt, params.collateralToken) &&
    Number.isSafeInteger(candidate.pendle.expiry) &&
    candidate.pendle.expiry >= 0 &&
    BigInt(candidate.pendle.expiry) === market.pendleMarketExpiry &&
    sameAddress(candidate.morpho.tuple.loanToken, params.loanToken) &&
    sameAddress(candidate.morpho.tuple.collateralToken, params.collateralToken) &&
    sameAddress(candidate.morpho.tuple.oracle, params.oracle) &&
    sameAddress(candidate.morpho.tuple.irm, params.irm) &&
    candidate.morpho.tuple.lltv === params.lltv &&
    sameAddress(candidate.morpho.loanAsset.address, params.loanToken) &&
    candidate.morpho.loanAsset.decimals === market.loanTokenDecimals &&
    sameAddress(candidate.morpho.collateralAsset.address, params.collateralToken) &&
    candidate.morpho.collateralAsset.decimals === market.collateralTokenDecimals
  if (!matches) {
    throw new LoopingRegistryError(
      'MARKET_NOT_ALLOWLISTED',
      `Looping directory identity does not match the reviewed registry entry for chain ${market.chainId}, market ${market.marketId}.`,
    )
  }
  return market
}

export function isLoopingExecutionCandidateSupported(
  candidate: Readonly<LoopingExecutionCandidateIdentity>,
): boolean {
  try {
    const market = getLoopingExecutionCandidateMarket(candidate)
    return LOOPING_ENTRY_EXECUTION_REGISTRY.includes(market)
  } catch (error) {
    if (error instanceof LoopingRegistryError) return false
    throw error
  }
}

/** Resolve a route address against a named per-market allowlist. */
export function requireLoopingRouteAddress(
  market: Readonly<LoopingExecutionMarket>,
  kind: 'externalRouter' | 'mintSyToken' | 'redeemSyToken',
  candidate: string,
): Address {
  const normalizedCandidate = normalizeAddress(candidate, kind)
  const allowlist =
    kind === 'externalRouter'
      ? market.routePolicy.externalRouterAllowlist
      : kind === 'mintSyToken'
        ? market.routePolicy.mintSyTokenAllowlist
        : market.routePolicy.redeemSyTokenAllowlist
  const allowed = allowlist.find(
    (address) => address.toLowerCase() === normalizedCandidate.toLowerCase(),
  )
  if (!allowed) {
    throw new LoopingRegistryError(
      'ADDRESS_NOT_ALLOWLISTED',
      `${kind} ${normalizedCandidate} is not allowlisted for ${market.marketId}.`,
    )
  }
  return allowed
}

/** Match both a nested Kyber executor address and its live runtime-code hash. */
export function requireLoopingKyberExecutor(
  market: Readonly<LoopingExecutionMarket>,
  candidate: string,
  runtimeCodeHash: string,
): Readonly<LoopingKyberExecutorPolicy> {
  const normalizedCandidate = normalizeAddress(candidate, 'kyberExecutor')
  if (!MARKET_ID_PATTERN.test(runtimeCodeHash)) {
    throw new LoopingRegistryError(
      'CODE_HASH_NOT_ALLOWLISTED',
      'Kyber executor runtime code hash must be a 32-byte 0x-prefixed hex value.',
    )
  }
  const executor = market.routePolicy.kyber.executorAllowlist.find(
    (entry) =>
      entry.address.toLowerCase() === normalizedCandidate.toLowerCase() &&
      entry.runtimeCodeHash.toLowerCase() === runtimeCodeHash.toLowerCase(),
  )
  if (!executor) {
    throw new LoopingRegistryError(
      'CODE_HASH_NOT_ALLOWLISTED',
      `Kyber executor ${normalizedCandidate} and its runtime code hash are not allowlisted for ${market.marketId}.`,
    )
  }
  return executor
}

function assertChecksummedAddress(label: string, address: Address): void {
  if (getAddress(address) !== address) {
    throw new Error(`${label} must be stored in EIP-55 checksum form.`)
  }
}

function assertRegistryIntegrity(market: Readonly<LoopingExecutionMarket>): void {
  if (market.pendleMarketExpiry <= 0n) {
    throw new Error('Looping registry Pendle expiry must be positive.')
  }
  if (
    !Number.isInteger(market.loanTokenDecimals) ||
    market.loanTokenDecimals < 0 ||
    market.loanTokenDecimals > 255 ||
    !Number.isInteger(market.collateralTokenDecimals) ||
    market.collateralTokenDecimals < 0 ||
    market.collateralTokenDecimals > 255
  ) {
    throw new Error('Looping registry token decimals must be integers from 0 to 255.')
  }
  const addressEntries: readonly (readonly [string, Address])[] = [
    ...Object.entries(market.contracts).map(
      ([label, address]) => [`contracts.${label}`, address] as const,
    ),
    ['pendleMarket', market.pendleMarket],
    ['standardizedYield', market.standardizedYield],
    ...Object.entries(market.morphoMarketParams)
      .filter((entry): entry is [string, Address] => entry[0] !== 'lltv')
      .map(([label, address]) => [`morphoMarketParams.${label}`, address] as const),
    ...market.routePolicy.externalRouterAllowlist.map(
      (address) => ['routePolicy.externalRouterAllowlist', address] as const,
    ),
    ...market.routePolicy.kyber.executorAllowlist.map(
      (executor) => ['routePolicy.kyber.executorAllowlist', executor.address] as const,
    ),
    ...market.routePolicy.mintSyTokenAllowlist.map(
      (address) => ['routePolicy.mintSyTokenAllowlist', address] as const,
    ),
    ...market.routePolicy.redeemSyTokenAllowlist.map(
      (address) => ['routePolicy.redeemSyTokenAllowlist', address] as const,
    ),
    [
      'routeUpgradePolicy.pendleRouter.implementation',
      market.routeUpgradePolicy.pendleRouter.implementation,
    ],
    [
      'routeUpgradePolicy.pendleRouter.redeemImplementation',
      market.routeUpgradePolicy.pendleRouter.redeemImplementation,
    ],
    [
      'routeUpgradePolicy.pendleSwap.implementation',
      market.routeUpgradePolicy.pendleSwap.implementation,
    ],
    [
      'routeUpgradePolicy.kyberRouter.address',
      market.routeUpgradePolicy.kyberRouter.address,
    ],
  ]
  for (const [label, address] of addressEntries) {
    assertChecksummedAddress(label, address)
  }

  for (const executor of market.routePolicy.kyber.executorAllowlist) {
    if (!MARKET_ID_PATTERN.test(executor.runtimeCodeHash)) {
      throw new Error('Kyber executor runtime code hash must be exactly 32 bytes.')
    }
  }
  for (const runtimeCodeHash of Object.values(market.runtimeCodePolicy)) {
    if (!MARKET_ID_PATTERN.test(runtimeCodeHash)) {
      throw new Error('Looping contract runtime code hash must be exactly 32 bytes.')
    }
  }
  const [buySlot, sellSlot, redeemSlot] =
    market.routeUpgradePolicy.pendleRouter.selectorImplementationSlots
  if (
    buySlot.selector !== '0xc81f847a' ||
    buySlot.storageSlot !==
      '0xb820d981672246ed2ae2a03a3d77375d8c0576df8bfcece9761c680a952be441' ||
    sellSlot.selector !== '0x594a88cc' ||
    sellSlot.storageSlot !==
      '0x89ba60bec361b63cc61987f4256981640e7591ee7c9f24b02af2c6fb517cf783' ||
    redeemSlot.selector !== '0x47f1de22' ||
    redeemSlot.storageSlot !==
      '0x6734da2a1f646755e54dcb758d0c7e0fe931aba0c85863dd8c0a6bdec717cb9c' ||
    market.routeUpgradePolicy.pendleSwap.implementationStorageSlot !==
      '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
  ) {
    throw new Error('Looping route implementation slots changed without review.')
  }
  if (
    market.routePolicy.externalRouterAllowlist.length !== 1 ||
    market.routePolicy.externalRouterAllowlist[0].toLowerCase() !==
      market.routeUpgradePolicy.kyberRouter.address.toLowerCase()
  ) {
    throw new Error('Looping Kyber router runtime pin is not tied to the allowlist.')
  }
  if (
    market.routePolicy.kyber.expectedFlags !== 512n ||
    market.routePolicy.kyber.maxSourceReceivers !== 8 ||
    market.routePolicy.kyber.maxTargetDataBytes !== 16_384 ||
    market.routePolicy.kyber.maxClientDataBytes !== 4_096
  ) {
    throw new Error('Kyber nested-route finite bounds changed without review.')
  }
  if (
    market.launchPolicy.modelMinLiquidationBufferBps !== 100 ||
    market.launchPolicy.minLiquidationBufferBps !== 1_000 ||
    market.launchPolicy.minEntryValueBps !== 9_000 ||
    market.launchPolicy.authorizationLifetimeSeconds <= 0n ||
    market.launchPolicy.authorizationLifetimeSeconds > 120n
  ) {
    throw new Error('Looping beta safety policy changed without review.')
  }

  const params = market.morphoMarketParams
  const derivedMarketId = keccak256(
    encodeAbiParameters(morphoMarketIdParameters, [
      params.loanToken,
      params.collateralToken,
      params.oracle,
      params.irm,
      params.lltv,
    ]),
  )
  if (derivedMarketId.toLowerCase() !== market.marketId.toLowerCase()) {
    throw new Error('Looping registry Morpho tuple does not derive its market id.')
  }
}

const registryMarketKeys = new Set<string>()
for (const market of LOOPING_EXECUTION_REGISTRY) {
  assertRegistryIntegrity(market)
  const key = `${market.chainId}:${market.marketId.toLowerCase()}`
  if (registryMarketKeys.has(key)) {
    throw new Error(`Duplicate looping execution market identity: ${key}.`)
  }
  registryMarketKeys.add(key)
}

if (LOOPING_ENTRY_EXECUTION_REGISTRY.length !== LOOPING_MARKET_CANDIDATE_MANIFEST.length) {
  throw new Error('Looping entry registry and reviewed candidate manifest diverged.')
}
for (const market of LOOPING_ENTRY_EXECUTION_REGISTRY) {
  if (!LOOPING_EXECUTION_REGISTRY.includes(market)) {
    throw new Error('A looping entry market is missing from position management.')
  }
}
