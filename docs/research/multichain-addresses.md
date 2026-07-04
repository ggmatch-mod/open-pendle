# Pendle V2 per-chain address books (OpenPendle M8 — verified 2026-07-04)

All six requested chains have Pendle V2 with RouterStatic (quoter) + commonDeploy (create wizard). Source: pendle-core-v2-public deployments/<id>-core.json. Cross-chain constants: Router V4 0x888888888889758F76e7103c6CbF23ABbF58F946, commonDeploy 0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9, syFactory 0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8, pyYtLpOracle 0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2, Multicall3 0xcA11bde05977b3631167028862bE2a173976CA11 (verify liveness per chain).

## Ethereum mainnet (chainId 1)
- pendleDeployed: yes | poolCreation: yes | routerStatic: yes
- routerStatic: 0x263833d47eA3fA4a30f269323aba6a107f9eB14C
- treasury: 0x8270400d528c34e1596EF367eeDEc99080A1b592 | PENDLE: 0x808507121b80c02388fad14726482e061b8da827
- activeMarketFactory: 0x6d247b1c044fA1E22e6B04fA9F71Baf99EB29A9f
- activeYieldContractFactory: 0x3E6EBa46AbC5ab18ED95F6667d8B2fd4020E4637
- marketFactories: marketFactory (base/V1-V2)=0x27b1dAcd74688aF24a64BD3C9C1B143118740784, marketFactoryV3=0x1A6fCc85557BC4fB7B534ed835a03EF056552D52, marketFactoryV4=0x3d75Bd20C983edb5fD218A1b7e0024F1056c7A2F, marketFactoryV5=0x6fcf753f2C67b83f7B09746Bbc4FA0047b35D050, marketFactoryV6 (ACTIVE/newest)=0x6d247b1c044fA1E22e6B04fA9F71Baf99EB29A9f
- yieldContractFactories: yieldContractFactory (base/V1-V2)=0x70ee0A6DB4F5a2Dc4d9c0b57bE97B9987e75BAFD, yieldContractFactoryV3=0xdF3601014686674e53d1Fa52F7602525483F9122, yieldContractFactoryV4=0x273b4bFA3Bb30fe8F32c467b5f0046834557F072, yieldContractFactoryV5=0x35A338522a435D46f77Be32C70E215B813D0e3aC, yieldContractFactoryV6 (ACTIVE/newest, pairs with marketFactoryV6)=0x3E6EBa46AbC5ab18ED95F6667d8B2fd4020E4637
- publicRpcs: https://ethereum-rpc.publicnode.com, https://eth.llamarpc.com, https://rpc.ankr.com/eth, https://eth.drpc.org, https://1rpc.io/eth

## Base (chainId 8453)
- pendleDeployed: yes | poolCreation: yes | routerStatic: yes
- routerStatic: 0xB4205a645c7e920BD8504181B1D7f2c5C955C3e7
- treasury: 0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6 | PENDLE: 0xA99F6e6785Da0F5d6fB42495Fe424BCE029Eeb3E
- activeMarketFactory: 0x81E80A50E56d10C501fF17B5Fe2F662bd9EA4590
- activeYieldContractFactory: 0xdDBfA21ecf024971486684E4E1600998ADeabc88
- marketFactories: V5=0x59968008a703dC13E6beaECed644bdCe4ee45d13, V6=0x81E80A50E56d10C501fF17B5Fe2F662bd9EA4590
- yieldContractFactories: V5=0x963ddBB35c1AE44e2a159E3b5fb5177E0B32660d, V6=0xdDBfA21ecf024971486684E4E1600998ADeabc88
- publicRpcs: https://mainnet.base.org, https://base.publicnode.com, https://base.drpc.org, https://public.1rpc.io/base

## BNB Smart Chain (BSC) (chainId 56)
- pendleDeployed: yes | poolCreation: yes | routerStatic: yes
- routerStatic: 0x2700ADB035F82a11899ce1D3f1BF8451c296eABb
- treasury: 0xd77E9062c6DF3F2d1CB5Bf45855fa1E7712A059e | PENDLE: 0xb3Ed0A426155B79B898849803E3B36552f7ED507
- activeMarketFactory: 0x80cE46449DF1c977f6ba60495125ce282F83DdFB
- activeYieldContractFactory: 0xd8c12d46dde7a04F782d417FAE78516448CB2c5b
- marketFactories: marketFactory (V1/legacy)=0x2bEa6BfD8fbFF45aA2a893EB3B6d85D10EFcC70E, marketFactoryV3=0xC40fEbF5A33b8C92B187d9be0fD3fe0ac2E4B07c, marketFactoryV4=0x7D20e644D2A9e149e5be9bE9aD2aB243a7835d37, marketFactoryV5=0x7C7f73f7a320364DBB3C9aAa9bCcd402040EE0f9, marketFactoryV6 (ACTIVE/newest)=0x80cE46449DF1c977f6ba60495125ce282F83DdFB
- yieldContractFactories: yieldContractFactory (V1/legacy)=0xa2530b4cfBF271e2B409A05C2CE520e4cB5fCc88, yieldContractFactoryV3=0x40Ae6da2d92aa3DCb7f8d7a7209FD12BDfcb7C85, yieldContractFactoryV4=0xdb6380041441A94050199b4A46771D8d93553509, yieldContractFactoryV5=0xE006760020384A20774Dea977C313EF5F51FE17D, yieldContractFactoryV6 (ACTIVE/newest, paired with marketFactoryV6)=0xd8c12d46dde7a04F782d417FAE78516448CB2c5b
- publicRpcs: https://bsc-dataseed.bnbchain.org, https://bsc-rpc.publicnode.com, https://bsc.drpc.org, https://binance.llamarpc.com

## Plasma (chainId 9745)
- pendleDeployed: yes | poolCreation: yes | routerStatic: yes
- routerStatic: 0x6813d43782395A1F2AAb42f39aeEDE03ac655e09
- treasury: 0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6 | PENDLE: 0x17bac5f906c9a0282ac06a59958d85796c831f24
- activeMarketFactory: 0x84A240Fa784E7F03CB99BA3716065961c5d0D531
- activeYieldContractFactory: 0xeAECF59C9Da00DACB73c4AAEbBBa22cf5e5bfD93
- marketFactories: V5=0x28dE02Ac3c3F5ef427e55c321F73fDc7F192e8E4, V6=0x84A240Fa784E7F03CB99BA3716065961c5d0D531
- yieldContractFactories: V5=0xED0dC8C074255c277BC704D6b096167D7a6E4311, V6=0xeAECF59C9Da00DACB73c4AAEbBBa22cf5e5bfD93
- publicRpcs: https://rpc.plasma.to, https://plasma.drpc.org, https://plasma-mainnet.public.blastapi.io

## Monad (chainId 143)
- pendleDeployed: yes | poolCreation: yes | routerStatic: yes
- routerStatic: 0x6813d43782395A1F2AAb42f39aeEDE03ac655e09
- treasury: 0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6 | PENDLE: 0x5e49e1f85813f2b65858860a3fa231b4186f2e0e
- activeMarketFactory: 0xA3cb62a49b66eB2536cf6F3C7AC82293784888A3
- activeYieldContractFactory: 0x4fe1B23ab695D99394Ab78c16A5bE358f31847F4
- marketFactories: marketFactoryV6=0xA3cb62a49b66eB2536cf6F3C7AC82293784888A3
- yieldContractFactories: yieldContractFactoryV6=0x4fe1B23ab695D99394Ab78c16A5bE358f31847F4
- publicRpcs: https://rpc.monad.xyz, https://rpc1.monad.xyz, https://rpc2.monad.xyz, https://rpc3.monad.xyz, https://rpc-mainnet.monadinfra.com

## Synthesis
All five chains (Ethereum, Base, BSC, Plasma, Monad) are supportable in M8: each has Pendle V2 deployed, a RouterStatic (M3/M4 quoter works), and commonDeploy present (M6 create wizard works). No chain must be excluded. Ship in phases keyed on maturity and RPC risk. Phase 1 (ship first): Ethereum, Base, BSC — mature deployments, long factory lineage, robust public RPC ecosystems, and Ethereum is Pendle's canonical home. Phase 2 (ship after Phase 1 validation): Plasma and Monad — both are genuine deployments but newer (Monad live 2026-06-19) with thinner/rate-limited public RPCs (Plasma rpc.plasma.to is non-production; Monad endpoints have batch caps) and Multicall3 not yet on-chain-verified. Prerequisites before any chain ships: (1) refactor factory selection to pick the newest generation present per chain instead of a fixed version key (unblocks Base/Plasma/Monad which lack V3/V4); (2) chain-key all constants — PENDLE, routerStatic, wrappedNative, native symbol, factories — from the per-chain address book, never Arbitrum defaults; (3) verify Multicall3 liveness per chain (or fall back to non-batched calls) before enabling batched quoter reads, with Plasma/Monad the priority; (4) expose user-configurable RPC override, defaulting to log-capable/high-batch providers (publicnode/drpc/llamarpc) and steering off throttled official endpoints for Plasma and BSC dataseeds.
