# FAQ

::: warning Experimental software
Community markets are permissionless, and OpenPendle has not reviewed or endorsed them. It validates market provenance, not the asset or SY underneath. It is not affiliated with Pendle Finance.
:::

## Product

### Is OpenPendle affiliated with Pendle Finance?

No. It is an independent, open-source interface built by [ggmxbt](https://x.com/ggmxbt).

### Does OpenPendle charge a fee?

No. Pendle protocol fees, network gas, slippage, and third-party costs still apply. Limit-order publication is gasless, but approval and on-chain cancellation can require gas.

### What can I do?

You can explore the factory-indexed market universe, load a recognized market by address, trade and manage Pendle positions, inspect Yield alerts, use supported PT ↔ SY limit orders, view positions and claim supported rewards, compare PT loops against Morpho markets, execute enabled reviewed looping actions, and deploy SY or market contracts through Pendle's factories.

Directory coverage is explicit rather than absolute: a new market may be absent until the next complete snapshot. See [Quickstart](/introduction/quickstart).

### Is it open source and self-hostable?

Yes. OpenPendle is `GPL-3.0-or-later` and builds to a static folder. Hash routing removes SPA rewrite requirements. Domain-root hosting works unchanged; subpath or raw IPFS-gateway hosting requires the matching Vite `base`. See [Self-hosting](/reference/self-hosting).

## Safety and privacy

### Is it safe?

OpenPendle checks recognized factory provenance, simulates on-chain calls against current state, and defaults to exact approvals. Limit orders use a separate typed-data validation path. These protections can catch some interface and revert conditions; they do not audit assets, guarantee mined state, or remove protocol risk. Read [Risks & disclosures](/reference/risks).

### What does the provenance gate prove?

Only that a factory in the release's recognized chain-specific lineage created the market. It does not prove the asset, SY, adapter, owner, price, or liquidity is safe.

### Where is my data stored?

Saved pools, preferred chain, and RPC overrides use browser `localStorage`. OpenPendle has no account or user database. Local storage does not hide network activity: RPCs and feature APIs see the requests sent to them.

### What external requests does the app make?

Depending on the page, the browser contacts configured blockchain RPCs, the injected wallet provider, the same-origin market catalog, Pendle APIs, Morpho, supported Blockscout endpoints, DefiLlama/CoinGecko, Merkl, and Cloudflare Web Analytics. Official-position discovery, maker-order requests, and Merkl reward lookups can include a wallet address. The canonical trigger-and-data table is in [Architecture](/reference/architecture#outbound-requests).

## Features

### Are limit orders available on every listed market?

No. OpenPendle requires Pendle's live support response to match the exact chain, market, YT, SY, and direction. Support is narrower than listed status. Placement reserves no funds and does not guarantee a fill. See [PT limit orders](/guides/limit-orders).

### Can Yield alerts notify me?

Not yet. The page is wallet-less and has no push, email, Telegram, or X delivery. It reports qualified 24-hour moves and partial data coverage when histories fail.

### Can I execute a PT loop from OpenPendle?

Yes, conditionally. [Looping](/guides/looping) offers Market Mode, which buys PT, and full Mint Mode. On entry, Mint Mode mints PT+YT from the user's capital and borrowed capital, supplies only PT as collateral, and sends YT to the wallet. Production currently keeps Mint increases disabled. An exact reviewed market must pass the base entry gates and live safety checks, while Mint risk increases must also pass their independent build flag and runtime policy. Reductions and exits never require wallet YT, and pausing either entry plane does not strand an existing position. Expired PT loops stay manageable through the reviewed post-expiry full-exit path.

### What does Explore include?

Inventory comes from successfully indexed `CreateNewMarket` events across the configured factory lineage. Pendle's API adds listed status and display metadata; it does not define membership. The UI shows incomplete or stale coverage.

### What does Positions show?

It combines local Saved Pools with the connected wallet's market IDs from Pendle Official Pools, then re-reads PT, YT, LP, and claimable balances from the relevant chains. Standard holdings are split into PT/YT/LP groups, while looped PT stays separate. It also requests wallet-wide Merkl rewards across supported chains; those results can include non-Pendle campaigns, and claims go directly to Merkl's distributor.

## Wallets and networks

### Which wallets work?

Injected EIP-6963 providers such as MetaMask, Rabby, and Brave. There is no WalletConnect session relay. On mobile, use a wallet dApp browser or another browser with an injected wallet. Wallet-less browsing works normally.

### Which networks are supported?

Ethereum (`1`), BNB Smart Chain (`56`), Monad (`143`), Base (`8453`), Plasma (`9745`), and Arbitrum (`42161`). The preferred chain defaults to Arbitrum; chain-explicit market/token URLs can override it for one tab.

### Can I use my own RPC?

Yes. Configure one HTTPS endpoint per chain in RPC settings. It replaces OpenPendle's fallback list for reads and simulations and is stored under `openpendle.rpc.<chainId>`. It does not change the injected wallet's transaction provider.

## Pendle basics

### What are SY, PT, and YT?

- **SY** is Pendle's standardized wrapper for a yield-bearing asset.
- **PT** is the principal claim that matures into one unit of the market's accounting asset if the asset and SY remain redeemable.
- **YT** is the right to variable yield until maturity.

Equal amounts of PT and YT can be minted from SY and paired for redemption before maturity. See [How Pendle works](/concepts/how-pendle-works).

### What is a community pool?

An OpenPendle Community market is a recognized, factory-created Pendle market absent from Pendle's current catalog. The label is not an OpenPendle review or endorsement.

## Incentives

### Does a newly created pool automatically receive PENDLE incentives?

No. Deployment alone does not whitelist a market for Pendle's current [Algorithmic Incentive Model (AIM)](https://docs.pendle.finance/pendle-v2/ProtocolMechanics/Mechanisms/Incentives). AIM eligibility and allocations are controlled by Pendle's program, not by OpenPendle.

### Can I fund rewards through OpenPendle?

Not currently. Pendle documents External Incentive Campaigns, and some programs use Merkl or other distribution paths. OpenPendle does not create or fund those campaigns. It can display and claim wallet-wide Merkl rewards returned by Merkl. See [Incentives](/create/incentives).

## Creating markets

### Can I deploy an SY and market?

Yes. OpenPendle calls Pendle's common SY factory and deployment helper. You can deploy an SY alone, deploy a market over an existing SY, or combine a new SY and market in one transaction.

### Who owns an SY created in the wizard?

Pendle governance is the default. An advanced option lets the connected wallet keep ownership, which adds pause and, where applicable, adapter-control risk. Upgradeable templates also remain under Pendle's ProxyAdmin.

### Can the combined SY + market flow seed with native ETH?

No. That combined wizard seeds with the ERC-20 or ERC-4626 asset and requires approval. Native seeding is available only when deploying a market over an existing SY whose accepted inputs include `address(0)`.

### Must I initialize the oracle?

No. Trading and liquidity work at cardinality 1. Raise `increaseObservationsCardinalityNext` only if an external consumer needs a TWAP; anyone can do so later. See [Initializing the oracle](/create/price-oracle).

## Verification and reporting

Use [Protocol Status](https://openpendle.com/#/status) for active helper wiring and mutable fee parameters, [Networks & contracts](/reference/networks-and-contracts) for the configured address model, and Pendle's public source plus block explorers for independent checks.

Report OpenPendle interface vulnerabilities to [ggmxbt on X](https://x.com/ggmxbt) or follow [`security.txt`](https://openpendle.com/.well-known/security.txt).
