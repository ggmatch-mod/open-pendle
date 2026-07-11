# Glossary

A reference for every term used across these docs, defined tightly and cross-linked to the page that explains it in full. Entries are alphabetical. Terms in **bold** inside a definition have their own entry.

If you are new to Pendle, read [How Pendle works](/concepts/how-pendle-works) first — it introduces most of these terms in the order they matter. This page is for looking one up quickly afterward.

::: info Not affiliated with Pendle
OpenPendle is an independent, open-source interface to Pendle V2. It is not affiliated with, endorsed by, or operated by Pendle Finance, and it takes no fee of its own (Pendle's own protocol fees still apply). Where a term below describes Pendle's protocol, it describes Pendle's public, on-chain mechanics — not something OpenPendle adds.
:::

## A

**Adapter (SY adapter).**
An `IStandardizedYieldAdapter` contract that teaches a WithAdapter- or upgradeable-**SY** how to deposit into and redeem from a specific yield source. Its `PIVOT_TOKEN` must equal the SY's yield token (ERC-20 variant) or the vault's `asset()` (ERC-4626 variants). OpenPendle's wizard deploys only the SY shell — the adapter itself is a separate per-asset contract the factory does **not** deploy. See [Creating an SY](/create/standardized-yield).

**Add / remove liquidity.**
The action of depositing into, or withdrawing from, a market's **AMM** to hold an **LP** position. Adding seeds **PT** and **SY** into the pool; removing returns your pro-rata share of the current reserves — a mix of PT and SY. See [Providing liquidity](/guides/providing-liquidity).

**AMM (automated market maker).**
The on-chain pool inside every Pendle market that lets people swap between **PT** and **SY** without a matching counterparty. Pendle's AMM concentrates liquidity near the curve PT traces toward par as **maturity** approaches, which keeps capital efficient for this specific price behaviour. See [Liquidity & the AMM](/concepts/liquidity-and-amm).

**APY (implied / fixed).**
See **implied APY**. "Fixed APY" is the same figure viewed from the buyer's side: the return a **PT** buyer locks in by holding to **maturity**. Both are arithmetic derived from the current PT price and time to maturity, not a rate the protocol promises to pay.

**Active network.**
The chain OpenPendle currently reads from and sends transactions to. It is a UI / `localStorage` choice (key `openpendle.chain`, default Arbitrum), independent of your wallet's chain; a wrong-network banner offers a one-click switch when they differ. See [Networks & contracts](/reference/networks-and-contracts).

## C

**Cardinality.**
See **TWAP oracle** and **oracle init**. A fresh market starts with observation cardinality 1; a one-time `increaseObservationsCardinalityNext` bump lets other protocols price the pool via TWAP. It is not required to trade, quote, or add liquidity through OpenPendle. See [Price oracle](/create/price-oracle).

**Community pool.**
A Pendle V2 market created permissionlessly — no whitelist, no approval, and **unreviewed by anyone** — that Pendle's official app does not list. These are the markets OpenPendle is built to reach. Anyone can create one, and interacting with them can lose you funds. See [Community pools & incentives](/concepts/community-pools).

**Content-Security-Policy (CSP).**
The browser policy OpenPendle ships with. `script-src` is `'self' 'wasm-unsafe-eval'`, which blocks JavaScript `eval()` and `Function()` while permitting **WebAssembly** (used for cryptography). Fonts are self-hosted, so there are zero external font requests. See [Architecture](/reference/architecture).

## E

**EIP-5115.**
The Ethereum standard that defines **SY** (Standardized Yield): a single, uniform token interface over many different yield sources, so every downstream contract can talk to one interface instead of special-casing each asset. See [Standardized Yield](/concepts/standardized-yield).

**EIP-6963.**
The browser standard for discovering multiple injected wallet providers. OpenPendle connects to any injected EIP-6963 provider — MetaMask, Rabby, Brave, and others — with no WalletConnect and no third-party relay. See [Connecting a wallet](/guides/connecting-a-wallet).

**Expiry / maturity.**
The fixed date, set when a market is created, at which the position resolves: **PT** becomes redeemable 1:1 for the **underlying**, **YT** is worth 0, and the market stops trading. "Expiry" and "maturity" are used interchangeably. See [Maturity & redemption](/concepts/maturity).

## F

**Factory (market / yield-contract).**
The Pendle contract that deploys new markets and yield contracts (**PT** / **YT** pairs) on a chain. OpenPendle's **provenance gate** checks that a market descends from a Pendle factory it recognizes. Because factories are governance-mutable, the active factory is resolved live at runtime; the hardcoded factory set is used only for provenance validation. Factory lineage varies by chain — see [Networks & contracts](/reference/networks-and-contracts).

**Fixed yield.**
A known return, set at the moment you buy, achieved by purchasing **PT** below par and holding it to **maturity**, where it redeems 1:1 for the **underlying**. The gap between purchase price and par, annualized, is the **implied APY**. It removes yield-*rate* uncertainty but not exposure to the underlying itself. See [Principal Tokens](/concepts/principal-tokens).

## H

**HashRouter.**
The client-side routing scheme OpenPendle uses, which puts the route after a `#` (URLs look like `openpendle.com/#/...`). Because the path lives in the fragment, the app runs on any static host or IPFS with no server rewrite rules. See [Self-hosting](/reference/self-hosting).

## I

**Implied APY.**
The fixed yield implied by the current **PT** price over the time remaining to **maturity**. A lower PT price means a deeper discount and a higher implied APY; a price nearer par means a lower one. It is the fixed rate a PT buyer locks in, and the bar realized yield must clear for a **YT** position to come out ahead. See [Principal Tokens](/concepts/principal-tokens).

**Impermanent loss (IL).**
The shortfall an **LP** suffers versus simply holding the two deposited assets, caused by the AMM rebalancing reserves as prices move. It is "impermanent" because it can shrink or vanish if prices return to where you entered — and becomes permanent the moment you withdraw. See [Liquidity & the AMM](/concepts/liquidity-and-amm).

**Injected wallet.**
A wallet that exposes a provider object directly in the browser page (via **EIP-6963**), such as a MetaMask or Rabby extension. OpenPendle is injected-only: on desktop use the extension; on mobile you must open the site inside a wallet's in-app dApp browser or in Brave mobile, because a normal mobile browser tab has no injected wallet. See [Connecting a wallet](/guides/connecting-a-wallet).

## L

**Long yield.**
A position that profits when the **underlying** accrues more yield than the market implied — taken by holding **YT**. It is the opposite view to **fixed yield**: you keep full variable-rate exposure. See [Yield Tokens](/concepts/yield-tokens).

**LP (liquidity provider / LP token).**
Someone who deposits into a market's **AMM**, and the token representing that share of the pool. An LP earns **swap fees** plus any **Merkl** incentives, and carries **AMM** risk — including **impermanent loss** — plus **PT**-vs-**SY** price exposure. See [Providing liquidity](/guides/providing-liquidity).

## M

**Maturity.**
See **expiry / maturity**.

**Merkl.**
An off-chain incentives platform ([merkl.angle.money](https://merkl.angle.money/)) used to distribute extra rewards on **community pools**, which are not eligible for native PENDLE **gauge** emissions. A campaign must be funded by the pool's creator or a third party; many community pools have none, and rewards are claimed through Merkl's distributor using OpenPendle's **My positions** page or Merkl's interface. See [Incentives](/create/incentives).

**Mint.**
The action `SY → PT + YT`: splitting one unit of **SY** into matching amounts of **PT** and **YT**, available any time before **maturity**. You can also mint from the **underlying** directly, which wraps it into SY first. The reverse is **redeem**. See [Minting & redeeming](/guides/minting-redeeming).

**Multicall3.**
The batched-read helper contract at `0xcA11bde05977b3631167028862bE2a173976CA11`, identical on all six chains, that OpenPendle uses to fetch many on-chain values in a single call. See [Networks & contracts](/reference/networks-and-contracts).

## O

**Oracle init.**
The one-time `increaseObservationsCardinalityNext` bump on a fresh market that lets **other** protocols price the pool via its **TWAP oracle** (lending markets taking PT as collateral, dashboards). It is **not** required to trade, quote, or add liquidity through OpenPendle, and is safe to skip; a one-click step is planned, and for now it is called from a block explorer. See [Price oracle](/create/price-oracle).

## P

**Par.**
The value of one **PT** in **underlying** terms at **maturity**: exactly 1. Before maturity PT trades below par, and the gap is the source of its **fixed yield**. See [Principal Tokens](/concepts/principal-tokens).

**PendleCommonPoolDeployHelperV2.**
The helper at `0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9` that deploys a pool (optionally an **SY** and a market together) in a single transaction, seeds initial liquidity, and sends the caller **LP** + **YT** while SY ownership goes to the SY's owner. Identical on all six chains. See [Deploying a market](/create/deploying-a-market).

**PendleCommonSYFactory.**
The permissionless **SY** factory at `0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8`, identical on all six chains, exposing seven registered templates (3 basic + 3 WithAdapter + 1 NoRedeemNoDepositUpg). It wraps an ERC-20 or ERC-4626 asset; there is no native-ETH template. See [Creating an SY](/create/standardized-yield).

**PendleMarket.**
The on-chain contract that *is* a Pendle pool: it holds the **AMM** pairing **PT** with **SY** for one **maturity**. Its address is what you paste into OpenPendle to open a pool — not the PT, YT, or SY address. See [Anatomy of a pool](/concepts/pool-anatomy).

**PendlePYLpOracle.**
The **TWAP oracle** at `0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2`, identical on all six chains, used to price **PT**, **YT**, and **LP**. See [Price oracle](/create/price-oracle).

**Pool / market.**
The on-chain **PendleMarket** contract. A **community pool** is a permissionlessly-created market — no whitelist, no approval, unreviewed by anyone. See [Anatomy of a pool](/concepts/pool-anatomy).

**Provenance gate.**
OpenPendle's check that a market was created by a Pendle **factory** it recognizes, run before you can save or transact against that market. This is **validation, not endorsement**: it confirms the market descends from Pendle, but says nothing about whether the **asset** or **SY** underneath is safe. See [Architecture](/reference/architecture).

**PT (Principal Token).**
The principal half of a split — a yield-bearing asset with its future yield stripped away. It redeems 1:1 for the **underlying** at **maturity**; bought below **par** and held to maturity, it locks in a **fixed yield**. Before maturity it trades in the **AMM** at a discount that moves with the market's **implied APY**. See [Principal Tokens](/concepts/principal-tokens).

## R

**Redeem.**
Two distinct actions share the word. `PT + YT → SY` recombines both halves back into **SY**, available any time before **maturity**. Redeeming **PT** for the **underlying** happens **at or after** maturity, once PT equals par. See [Minting & redeeming](/guides/minting-redeeming) and [Maturity & redemption](/concepts/maturity).

**Router V4 (`PendleRouterV4`).**
Pendle's main router at `0x888888888889758F76e7103c6CbF23ABbF58F946`, identical on all six chains, through which OpenPendle sends all trades, liquidity actions, and exits. OpenPendle simulates every such transaction before you sign and defaults to exact-amount approvals. See [Architecture](/reference/architecture).

**RouterStatic.**
Pendle's read-only helper contract for quotes and position math, used by OpenPendle to compute what a given action would return. It is chain-specific (resolved live per chain), unlike the shared **Router V4**. See [Networks & contracts](/reference/networks-and-contracts).

**RPC (public / fallback / override).**
The endpoint OpenPendle reads the chain through. Each chain ships a keyless public default wrapped in a viem `fallback()` transport that rolls over to a backup automatically; you can override it per chain (key `openpendle.rpc.<chainId>`), stored locally, and saving reloads the app. RPC carries core chain reads and transactions; separate public services support the ticker, PT/YT pool lookup, and Merkl rewards. See [Browsing](/guides/browsing) and [Architecture](/reference/architecture).

## S

**Saved pools (registry).**
The client-side list of pools you have chosen to remember, stored in `localStorage` under `openpendle.pools.v1` — no OpenPendle backend storage or account. It supports Export to JSON, Import, and a shareable `?import=` link; the registry itself leaves the browser only when you export or share. See [Saved pools](/guides/saved-pools).

**Seed / seed token.**
The initial liquidity a pool deploy adds, and the token used for it — whatever the **SY** accepts. If that includes native ETH (the SY lists `address(0)` among its inputs), the deploy sends ETH as `msg.value` with no approval; otherwise you approve the exact seed amount first. See [Deploying a market](/create/deploying-a-market).

**Simulate-before-sign.**
OpenPendle's practice of simulating every transaction against the live chain *before* you sign it, so the quoted result is the result the chain will execute at that block. See [Architecture](/reference/architecture).

**Swap.**
Trading a token into or out of **PT** (a **fixed-yield** position) or **YT** (a **long-yield** position) through **Router V4**. Quotes update live as you type, and each swap simulates before signing with exact approvals by default. See [Buying PT](/guides/buying-pt) and [Buying YT](/guides/buying-yt).

**SY (Standardized Yield).**
The uniform **EIP-5115** wrapper Pendle puts around a yield-bearing asset, presenting many different yield sources through one interface. SY is what splits into **PT** + **YT** and what the **AMM** pairs PT against; you rarely touch it directly. See [Standardized Yield](/concepts/standardized-yield).

## T

**Template (SY template).**
One of the seven registered kinds of **SY** the **PendleCommonSYFactory** can deploy: 3 basic (which encode name, symbol, and token), 3 WithAdapter, and 1 NoRedeemNoDepositUpg. Upgradeable and adapter templates use `deployUpgradableSY`; empty `initData` reverts. See [Creating an SY](/create/standardized-yield).

**Treasury.**
The Pendle-controlled address that receives Pendle's protocol fees on a chain. It is chain-specific (resolved live) and unrelated to OpenPendle, which takes no fee of its own. See [Networks & contracts](/reference/networks-and-contracts).

**TWAP oracle.**
A time-weighted-average-price oracle — here **PendlePYLpOracle** — that Pendle uses to price **PT**, **YT**, and **LP** over a window rather than off a single instantaneous tick. A fresh market's TWAP needs an **oracle init** bump before *other* protocols can read it; OpenPendle does not require it to quote or trade. See [Price oracle](/create/price-oracle).

## U

**Underlying.**
The asset a pool ultimately resolves to: the yield-bearing token (or its base asset) that **SY** wraps, and what **PT** redeems 1:1 for at **maturity**. A **fixed yield** is only ever as safe as the underlying it is fixed on. See [How Pendle works](/concepts/how-pendle-works).

## V

**vePENDLE / gauges.**
Pendle's vote-escrow token and the gauge system that directs native PENDLE emissions to markets. **Community pools are not eligible** for gauge emissions or vePENDLE voting — those are reserved for team-listed markets — so community pools rely on **Merkl** instead. See [Incentives](/create/incentives).

## W

**WebAssembly (WASM).**
The compiled-code format OpenPendle's **CSP** permits (`'wasm-unsafe-eval'`) while blocking JavaScript `eval()`; it is used for cryptography. See [Architecture](/reference/architecture).

**Wrapped native.**
The ERC-20 wrapper of a chain's native coin (for example wrapped ETH or wrapped BNB). It is chain-specific and resolved live. Note that Pendle's SY templates wrap an ERC-20 or ERC-4626 asset — there is no native-ETH SY template — though a pool deploy can still *seed* with native ETH when the SY accepts it. See [Networks & contracts](/reference/networks-and-contracts).

## Y

**Yield contract.**
The Pendle contract, deployed by a yield-contract **factory**, that mints and redeems a **PT** + **YT** pair from a given **SY** for one **maturity**. See [Anatomy of a pool](/concepts/pool-anatomy).

**YT (Yield Token).**
The yield half of a split — the right to *all* the yield the **underlying** accrues from now until **maturity**. It is a variable, **long-yield** position whose value tracks realized yield and **trends to 0 at maturity**, once all that yield has been paid out. See [Yield Tokens](/concepts/yield-tokens).

## A word on safety

::: warning Provenance is not endorsement
The **provenance gate** validates that a market descends from a Pendle **factory** — it does **not** vouch for the **asset** or **SY** contract underneath. **Community pools** are permissionless and unreviewed — anyone can create one, and interacting with them can lose you funds. Experimental — use at your own risk. Not affiliated with Pendle Finance.
:::

## See also

- [How Pendle works](/concepts/how-pendle-works) — most of these terms, introduced in order from first principles.
- [Anatomy of a pool](/concepts/pool-anatomy) — how PendleMarket, PT, YT, and SY fit together as one pool.
- [Community pools & incentives](/concepts/community-pools) — what "unreviewed" means, and why these pools use Merkl.
- [Networks & contracts](/reference/networks-and-contracts) — the shared and per-chain addresses behind these terms.
- [Architecture](/reference/architecture) — the provenance gate, simulate-before-sign, CSP, and HashRouter in depth.
- [Risks & disclosures](/reference/risks) — the full risk picture in one place.
