/**
 * Immutable identities reviewed for possible browser-built looping execution.
 *
 * This is deliberately separate from the executable registry. Discovery data
 * and observed liquidity can nominate a candidate, but cannot make it
 * executable without route validation, lifecycle tests, and an explicit
 * promotion into the execution policy.
 *
 * Once a candidate has actually been promoted and used, its immutable identity
 * must remain available for position management after maturity or a liquidity
 * decline. Entry eligibility is a separate, live decision; do not delete a
 * previously executable identity merely because new entries are paused.
 */

import type { Address, Hex } from 'viem'

export type ReviewedLoopingChainId = 1 | 143 | 42_161

export interface ReviewedLoopingMarketCandidate {
  chainId: ReviewedLoopingChainId
  marketId: Hex
  display: Readonly<{
    loanTokenSymbol: string
    collateralTokenSymbol: string
  }>
  morphoMarketParams: Readonly<{
    loanToken: Address
    collateralToken: Address
    oracle: Address
    irm: Address
    lltv: bigint
  }>
  principalToken: Address
  loanTokenDecimals: number
  collateralTokenDecimals: number
  pendleMarket: Address
  pendleMarketExpiry: bigint
  standardizedYield: Address
  syTokensIn: readonly Address[]
  syTokensOut: readonly Address[]
  /** Discovery metadata only. None of these fields is part of market identity. */
  audit: Readonly<{
    capturedAt: string
    minimumBorrowLiquidityUsd: 100
    observedBorrowLiquidityUsd: number
    morphoListed: boolean
  }>
}

interface CandidateSeed {
  chainId: ReviewedLoopingChainId
  marketId: Hex
  loanTokenSymbol: string
  collateralTokenSymbol: string
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
  loanTokenDecimals: number
  collateralTokenDecimals: number
  pendleMarket: Address
  pendleMarketExpiry: bigint
  standardizedYield: Address
  syTokensIn: readonly Address[]
  syTokensOut: readonly Address[]
  observedBorrowLiquidityUsd: number
}

const AUDIT_CAPTURED_AT = '2026-07-21T10:53:06Z'

function reviewedMarket(
  seed: CandidateSeed,
): Readonly<ReviewedLoopingMarketCandidate> {
  return Object.freeze({
    chainId: seed.chainId,
    marketId: seed.marketId,
    display: Object.freeze({
      loanTokenSymbol: seed.loanTokenSymbol,
      collateralTokenSymbol: seed.collateralTokenSymbol,
    }),
    morphoMarketParams: Object.freeze({
      loanToken: seed.loanToken,
      collateralToken: seed.collateralToken,
      oracle: seed.oracle,
      irm: seed.irm,
      lltv: seed.lltv,
    }),
    principalToken: seed.collateralToken,
    loanTokenDecimals: seed.loanTokenDecimals,
    collateralTokenDecimals: seed.collateralTokenDecimals,
    pendleMarket: seed.pendleMarket,
    pendleMarketExpiry: seed.pendleMarketExpiry,
    standardizedYield: seed.standardizedYield,
    syTokensIn: Object.freeze([...seed.syTokensIn]),
    syTokensOut: Object.freeze([...seed.syTokensOut]),
    audit: Object.freeze({
      capturedAt: AUDIT_CAPTURED_AT,
      minimumBorrowLiquidityUsd: 100 as const,
      observedBorrowLiquidityUsd: seed.observedBorrowLiquidityUsd,
      morphoListed: true,
    }),
  })
}

export const LOOPING_MARKET_CANDIDATE_MANIFEST = Object.freeze([
  // Ethereum
  reviewedMarket({
    chainId: 1,
    marketId: '0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-reUSD-10DEC2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0xeCfaFdC7741323a945A163ed068B5a3C43483957',
    oracle: '0x217d6DdCDB95112C51657F6270e8C079CFDB51f0',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 6,
    pendleMarket: '0x13285bCbc27F92b47B4EDB99D744C07B48C977c0', pendleMarketExpiry: 1_796_860_800n,
    standardizedYield: '0x9487Bd5A3b16Ecb5F3184453E3ee75B800141648',
    syTokensIn: ['0x5086bf358635B81D8C47C66d1C8b9E567Db70c72'],
    syTokensOut: ['0x5086bf358635B81D8C47C66d1C8b9E567Db70c72'],
    observedBorrowLiquidityUsd: 4_384_435.123723817,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0xf8c5aa31ea6b2a068a9eddb46dd110cae57bf0f12be9583a3f9a818effecba89',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-USD3-17DEC2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0x7f47c3e6b2c00fC4eB4d5Ae50d0Ab0Ab6888Eb4D',
    oracle: '0xe5E6Ec063E63A9D0c6Ac041d0AD2bd03F7f08d72',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 860_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 6,
    pendleMarket: '0x4A5067C3fF1abb7449244025B0e37fEAF77D8E3e', pendleMarketExpiry: 1_797_465_600n,
    standardizedYield: '0xeA3BC608F32847B97965C5e1648BDFCd4C2C40d0',
    syTokensIn: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x056B269Eb1f75477a8666ae8C7fE01b64dD55eCc'],
    syTokensOut: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x056B269Eb1f75477a8666ae8C7fE01b64dD55eCc'],
    observedBorrowLiquidityUsd: 1_888_916.1545555156,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0xdf6ca97d41975a6996e9db491cb38152b65d7c00807dfe15d95d8d76e5d122e0',
    loanTokenSymbol: 'USDT', collateralTokenSymbol: 'PT-sUSDD-27AUG2026',
    loanToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    collateralToken: '0xD341A146A4fD20eA89898E4d86Ae1829bF3A1c23',
    oracle: '0x1F96824a00DD81bF4694471d1F0741E6A4de0cc2',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0x45252f9a932910aBC436644F0b29f5531F0eb4Cc', pendleMarketExpiry: 1_787_788_800n,
    standardizedYield: '0x149BD983030E14e8B2F1eBDc8BBd9c419411fBC9',
    syTokensIn: ['0x4f8e5DE400DE08B164E7421B3EE387f461beCD1A', '0xC5d6A7B61d18AfA11435a889557b068BB9f29930'],
    syTokensOut: ['0x4f8e5DE400DE08B164E7421B3EE387f461beCD1A', '0xC5d6A7B61d18AfA11435a889557b068BB9f29930'],
    observedBorrowLiquidityUsd: 774_284.1026004535,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0xf02d2e8f427a2b91785b3d09690ef9d3811bf674ba97b00bafc7665004a6dd97',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-sUSDD-27AUG2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0xD341A146A4fD20eA89898E4d86Ae1829bF3A1c23',
    oracle: '0x208C784A15347bF51919C0850ae869ca764B595D',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0x45252f9a932910aBC436644F0b29f5531F0eb4Cc', pendleMarketExpiry: 1_787_788_800n,
    standardizedYield: '0x149BD983030E14e8B2F1eBDc8BBd9c419411fBC9',
    syTokensIn: ['0x4f8e5DE400DE08B164E7421B3EE387f461beCD1A', '0xC5d6A7B61d18AfA11435a889557b068BB9f29930'],
    syTokensOut: ['0x4f8e5DE400DE08B164E7421B3EE387f461beCD1A', '0xC5d6A7B61d18AfA11435a889557b068BB9f29930'],
    observedBorrowLiquidityUsd: 724_155.1926351695,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x69ef7fd17b42cd7df6d885aee1b11380837afbc1664b25587041cf193b31617b',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-USDat-27AUG2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0x1D69402390657308C91179aa184bF992908c1e08',
    oracle: '0xDA25BFf53bF9E12c728Cd83Ff9Fc22c581f564CD',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 6,
    pendleMarket: '0x9aFe7a057A09cF5da748d952078C9C99938b4329', pendleMarketExpiry: 1_787_788_800n,
    standardizedYield: '0x7a7dE491e1BE5287874904e2b7c8488249A4D0a9',
    syTokensIn: ['0x23238f20b894f29041f48D88eE91131C395Aaa71'],
    syTokensOut: ['0x23238f20b894f29041f48D88eE91131C395Aaa71'],
    observedBorrowLiquidityUsd: 539_966.2348740608,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x9464b3d42133c10c8b216d3d9429b43e98c2f3856a87940ef18b8bdd3e7bd831',
    loanTokenSymbol: 'AUSD', collateralTokenSymbol: 'PT-USDat-27AUG2026',
    loanToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    collateralToken: '0x1D69402390657308C91179aa184bF992908c1e08',
    oracle: '0xDAd04877702ca7F4a02ECCDfa1D0BFD2bB2Be6b8',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 6,
    pendleMarket: '0x9aFe7a057A09cF5da748d952078C9C99938b4329', pendleMarketExpiry: 1_787_788_800n,
    standardizedYield: '0x7a7dE491e1BE5287874904e2b7c8488249A4D0a9',
    syTokensIn: ['0x23238f20b894f29041f48D88eE91131C395Aaa71'],
    syTokensOut: ['0x23238f20b894f29041f48D88eE91131C395Aaa71'],
    observedBorrowLiquidityUsd: 523_553.7428249699,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x1749e02006bc6bd6a86af52d231511f6911d5e42318e028e51a28dfabc68dd47',
    loanTokenSymbol: 'RLUSD', collateralTokenSymbol: 'PT-sUSDE-13AUG2026',
    loanToken: '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD',
    collateralToken: '0x5A19fa369F2895dCD8d2cEE62E4Ceae58eF92BBb',
    oracle: '0x968eb911Db90BB8eA9E4792b05C94500bC1A62D7',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 18, collateralTokenDecimals: 18,
    pendleMarket: '0x177768caf9D0e036725A51D3f60d7E20F2D4D194', pendleMarketExpiry: 1_786_579_200n,
    standardizedYield: '0xBF98480425A29197e5d99D003017f63a1e595D02',
    syTokensIn: ['0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497'],
    syTokensOut: ['0x9D39A5DE30e57443BfF2A8307A4256c8797A3497'],
    observedBorrowLiquidityUsd: 507_297.11089861026,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x02bb03bf55f07c3ed3eee8a25d8df60fb9d09a38db612f0e07cf5c4d3df0100d',
    loanTokenSymbol: 'USDT', collateralTokenSymbol: 'PT-USDG-24SEP2026',
    loanToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    collateralToken: '0xc1906aeCf868749a2DeE203F59b904c0cf212140',
    oracle: '0x4C0fE43eCF0C552F9cFE40D07B7fb5235d808076',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 6,
    pendleMarket: '0xF80b67a32DF07960C731794769309E3D30E9717F', pendleMarketExpiry: 1_790_208_000n,
    standardizedYield: '0xc1799CaB1F201946f7CFaFBaF1BCC089b2F08927',
    syTokensIn: ['0xe343167631d89B6Ffc58B88d6b7fB0228795491D'],
    syTokensOut: ['0xe343167631d89B6Ffc58B88d6b7fB0228795491D'],
    observedBorrowLiquidityUsd: 331_846.64472830103,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x6acd18854e43f93f5a90446004c35c72a68af1ad99f08cb247782ce6457914ca',
    loanTokenSymbol: 'USDT', collateralTokenSymbol: 'PT-reUSD-10DEC2026',
    loanToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    collateralToken: '0xeCfaFdC7741323a945A163ed068B5a3C43483957',
    oracle: '0x217d6DdCDB95112C51657F6270e8C079CFDB51f0',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 6,
    pendleMarket: '0x13285bCbc27F92b47B4EDB99D744C07B48C977c0', pendleMarketExpiry: 1_796_860_800n,
    standardizedYield: '0x9487Bd5A3b16Ecb5F3184453E3ee75B800141648',
    syTokensIn: ['0x5086bf358635B81D8C47C66d1C8b9E567Db70c72'],
    syTokensOut: ['0x5086bf358635B81D8C47C66d1C8b9E567Db70c72'],
    observedBorrowLiquidityUsd: 294_231.19308980135,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0xb37c30f34bff11c81ee8400133965f450a5f7c5d81ba2cf5740076f49eabc95c',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-apyUSD-5NOV2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0xb5Be35D8fF83D431899b95851CB17a2B4bcEF150',
    oracle: '0x100187B3074116255c5C644eAd561E920f654E65',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 860_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0xC5f938A8ef5F3BF9E72F5aA094baF5E03f4727D3', pendleMarketExpiry: 1_793_836_800n,
    standardizedYield: '0x04F8DCa7bcCD8997ac57ca6feF7c705E17d6bcB6',
    syTokensIn: ['0x98A878b1Cd98131B271883B390f68D2c90674665', '0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A'],
    syTokensOut: ['0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A'],
    observedBorrowLiquidityUsd: 278_466.5772593857,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x908b037029b5c0671ba3b362eaf289c3199560d1d4632e6cb527cc7240fa006e',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-apxUSD-5NOV2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0xAF687B5EcB525Ccea96115088999B4eD80C388b6',
    oracle: '0xFb8B9A1b92B0F6CC3bb940F6CA670ca7dA455f9d',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 860_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0xaf0349FB9B1bA07D34381870c59b560b31412660', pendleMarketExpiry: 1_793_836_800n,
    standardizedYield: '0x4f116eE5BCD227d1a1C4f57918D694a4aBe7b3FC',
    syTokensIn: ['0x98A878b1Cd98131B271883B390f68D2c90674665'],
    syTokensOut: ['0x98A878b1Cd98131B271883B390f68D2c90674665'],
    observedBorrowLiquidityUsd: 218_643.45239303797,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0xebd23a871b52e0a8c92bd719f4413600101b69e946cb72923b3a33fb5bc6ec85',
    loanTokenSymbol: 'apxUSD', collateralTokenSymbol: 'PT-apyUSD-5NOV2026',
    loanToken: '0x98A878b1Cd98131B271883B390f68D2c90674665',
    collateralToken: '0xb5Be35D8fF83D431899b95851CB17a2B4bcEF150',
    oracle: '0xD3acB26E38465613B9a974caD2bA56FbCC7B87E9',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 18, collateralTokenDecimals: 18,
    pendleMarket: '0xC5f938A8ef5F3BF9E72F5aA094baF5E03f4727D3', pendleMarketExpiry: 1_793_836_800n,
    standardizedYield: '0x04F8DCa7bcCD8997ac57ca6feF7c705E17d6bcB6',
    syTokensIn: ['0x98A878b1Cd98131B271883B390f68D2c90674665', '0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A'],
    syTokensOut: ['0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A'],
    observedBorrowLiquidityUsd: 168_172.49929157703,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x4bb22a5f6313fc9d7b5e1438967bfcd0a513a839d26662dd8d235629942400e2',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-sUSDat-27AUG2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0xc689f76F90FE1762faC55983Ff25ae71033A84F7',
    oracle: '0x4FcF6507b4a9ed8b174AB2aFE51340f506DfbB39',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 6,
    pendleMarket: '0x91bC86899c8391B6CAaF26535B9Cd82efE49A189', pendleMarketExpiry: 1_787_788_800n,
    standardizedYield: '0x8917F8c7Feb840b5837EDC7e128123baa2f289F9',
    syTokensIn: ['0x23238f20b894f29041f48D88eE91131C395Aaa71', '0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7'],
    syTokensOut: ['0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7'],
    observedBorrowLiquidityUsd: 157_300.13927441929,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x62878115c6ee109c256237eb6daef589d006258202682d2e210cad3bb19e0f09',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-apyUSD-27AUG2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0xEe5C7CdA577484b70b65C21235ECbd302bB290E2',
    oracle: '0x2c0A8C81d61529Bc08E0A4F780D098C8595c9158',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 860_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0x30bB9Ee8DC6AAb322Dc3A0d36063CBf06a9e5952', pendleMarketExpiry: 1_787_788_800n,
    standardizedYield: '0x04F8DCa7bcCD8997ac57ca6feF7c705E17d6bcB6',
    syTokensIn: ['0x98A878b1Cd98131B271883B390f68D2c90674665', '0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A'],
    syTokensOut: ['0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A'],
    observedBorrowLiquidityUsd: 49_372.73725401224,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x4483b864209c50da2be8fc75371db0e92fdc6bc8920d86fc9b56ea7383f8c9d1',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-apxUSD-27AUG2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0xd28B0D694b8E814FA905A8b480B30691e18396EB',
    oracle: '0x5a25Dd4C2fCb3f260407102efF711F54E22d5408',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 860_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0xc3e6cC9269dc780e0d55512c46cad1dD29CFBaa5', pendleMarketExpiry: 1_787_788_800n,
    standardizedYield: '0x4f116eE5BCD227d1a1C4f57918D694a4aBe7b3FC',
    syTokensIn: ['0x98A878b1Cd98131B271883B390f68D2c90674665'],
    syTokensOut: ['0x98A878b1Cd98131B271883B390f68D2c90674665'],
    observedBorrowLiquidityUsd: 45_470.31267815546,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x2fb3713487c7812e7309935b034f40228841666f6b048faf31fd2110ae674f20',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-stcUSD-23JUL2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0x2d3C279E5FcDF5b793c0a75ed90738D7369B0b83',
    oracle: '0x11aEFbf08bAB2b3f3141c2CC4749A638c4c3b674',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0xaC24A6f0068d9701EAEa76AB0B418021017F8D59', pendleMarketExpiry: 1_784_764_800n,
    standardizedYield: '0x27010cE8D14B4E73Ef48aF1CF9a5A91e8356d10f',
    syTokensIn: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x434558CB1EBe9950e8A66f1ef8A15A473Dce7D8c', '0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC', '0x88887bE419578051FF9F4eb6C858A951921D8888'],
    syTokensOut: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x434558CB1EBe9950e8A66f1ef8A15A473Dce7D8c', '0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC', '0x88887bE419578051FF9F4eb6C858A951921D8888'],
    observedBorrowLiquidityUsd: 41_359.284148966886,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0xd86df29b48f2d88a0453027212247a29e68ff52c6589c46054f57285da2fa7e3',
    loanTokenSymbol: 'apxUSD', collateralTokenSymbol: 'PT-apxUSD-5NOV2026',
    loanToken: '0x98A878b1Cd98131B271883B390f68D2c90674665',
    collateralToken: '0xAF687B5EcB525Ccea96115088999B4eD80C388b6',
    oracle: '0xeCA7Ce58Af9c9f57fC7ac4e9bca17731F74C8E0B',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 945_000_000_000_000_000n,
    loanTokenDecimals: 18, collateralTokenDecimals: 18,
    pendleMarket: '0xaf0349FB9B1bA07D34381870c59b560b31412660', pendleMarketExpiry: 1_793_836_800n,
    standardizedYield: '0x4f116eE5BCD227d1a1C4f57918D694a4aBe7b3FC',
    syTokensIn: ['0x98A878b1Cd98131B271883B390f68D2c90674665'],
    syTokensOut: ['0x98A878b1Cd98131B271883B390f68D2c90674665'],
    observedBorrowLiquidityUsd: 13_091.428605467483,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0xfd039edc69eac5eaab4a10463fdbcaca75d6eddb1f0e00248d73fc977fb2554b',
    loanTokenSymbol: 'USDT', collateralTokenSymbol: 'PT-cUSD-23JUL2026',
    loanToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    collateralToken: '0x928FB6ED39100a92B2480f5cbB93453f98D9F4cE',
    oracle: '0x25b30502467639E8FA118451105269e9B9813DD2',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0x9EaAedA23177B7168c55a3A0F937f67919733449', pendleMarketExpiry: 1_784_764_800n,
    standardizedYield: '0x3EAf6C8425b40c554099BEEd4DcB9f4601942fcb',
    syTokensIn: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x434558CB1EBe9950e8A66f1ef8A15A473Dce7D8c', '0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC'],
    syTokensOut: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x434558CB1EBe9950e8A66f1ef8A15A473Dce7D8c', '0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC'],
    observedBorrowLiquidityUsd: 10_154.947477023654,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x5eaaebc81e9e27972ab458811d1b60828e8ab51ef6620f9b3918fd7e68eecec1',
    loanTokenSymbol: 'USDT', collateralTokenSymbol: 'PT-stcUSD-23JUL2026',
    loanToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    collateralToken: '0x2d3C279E5FcDF5b793c0a75ed90738D7369B0b83',
    oracle: '0x11aEFbf08bAB2b3f3141c2CC4749A638c4c3b674',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0xaC24A6f0068d9701EAEa76AB0B418021017F8D59', pendleMarketExpiry: 1_784_764_800n,
    standardizedYield: '0x27010cE8D14B4E73Ef48aF1CF9a5A91e8356d10f',
    syTokensIn: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x434558CB1EBe9950e8A66f1ef8A15A473Dce7D8c', '0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC', '0x88887bE419578051FF9F4eb6C858A951921D8888'],
    syTokensOut: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x434558CB1EBe9950e8A66f1ef8A15A473Dce7D8c', '0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC', '0x88887bE419578051FF9F4eb6C858A951921D8888'],
    observedBorrowLiquidityUsd: 7_713.795038433912,
  }),
  reviewedMarket({
    chainId: 1,
    marketId: '0x42c2b592fc759fad461fb5c80d5ea214a496f70d8594398d69af68c2f3798de6',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-srUSDat-27AUG2026',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    collateralToken: '0x2D433b943FB8c015AE409444B7F960ED288082b4',
    oracle: '0x32966C34D92BA0d7E34206E4674b12460CeD32D7',
    irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 6,
    pendleMarket: '0x4237a8acBD0B5a2DEc4aa83B1fd83F20162d02B8', pendleMarketExpiry: 1_787_788_800n,
    standardizedYield: '0x9D0fc59F88acb85520a8cfb74C7fE141d8563185',
    syTokensIn: ['0xFaa9a0e1Db9E22AE3A20B2B58a68DC24D053d066', '0x23238f20b894f29041f48D88eE91131C395Aaa71', '0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7'],
    syTokensOut: ['0xFaa9a0e1Db9E22AE3A20B2B58a68DC24D053d066', '0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7'],
    observedBorrowLiquidityUsd: 4_334.0399443838905,
  }),

  // Monad
  reviewedMarket({
    chainId: 143,
    marketId: '0x93a7a013b5501cee5d9bee0d29bb3fca790196134c4c7058365e5bc6d2ad80a2',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-AUSD-8OCT2026',
    loanToken: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
    collateralToken: '0x9FC74f8Ed616B5BaF52a170caa97d6d3898602d1',
    oracle: '0x436CA3263B1AAA57d286823a42E35d8c228e85a2',
    irm: '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 6,
    pendleMarket: '0x6f99CF00ee7290aE78a072Bb6910eF72D1129fE7', pendleMarketExpiry: 1_791_417_600n,
    standardizedYield: '0xBA3d60f5000f472aef947FB8020a3E6319F9a0B7',
    syTokensIn: ['0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a'],
    syTokensOut: ['0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a'],
    observedBorrowLiquidityUsd: 330_909.04402821633,
  }),

  // Arbitrum. The ~$0.09 USDT0 debt tuple is intentionally excluded.
  reviewedMarket({
    chainId: 42_161,
    marketId: '0x97cb4b88a7a5e8e9c039b106374124e642395437ffc0ef93f2799343ad022985',
    loanTokenSymbol: 'USDC', collateralTokenSymbol: 'PT-USDai-15OCT2026',
    loanToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    collateralToken: '0xC9d24aD0bB25F34098e226a8C5192Dea7bacccaE',
    oracle: '0xaAe5194036306A14B6bFE51A255001bd75F315b1',
    irm: '0x66F30587FB8D4206918deb78ecA7d5eBbafD06DA', lltv: 915_000_000_000_000_000n,
    loanTokenDecimals: 6, collateralTokenDecimals: 18,
    pendleMarket: '0xA8a0DEA40174CfC30fEA9e3A77f182aB33f46E25', pendleMarketExpiry: 1_792_022_400n,
    standardizedYield: '0x5edCBC20Cac67AdC2e724d4348Ff85132B085b82',
    syTokensIn: ['0x46850aD61C2B7d64d08c9C754F45254596696984', '0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF'],
    syTokensOut: ['0x46850aD61C2B7d64d08c9C754F45254596696984', '0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF'],
    observedBorrowLiquidityUsd: 30_989.97312484625,
  }),
] as const)
