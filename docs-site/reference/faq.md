# FAQ

Answers to the questions people ask most about OpenPendle, grouped by theme. Each answer is short by design and links to the page that treats the subject in full. If you are new here, start with [What is OpenPendle](/introduction/what-is-openpendle) and the [Quickstart](/introduction/quickstart); if you are about to transact, read [Risks & disclosures](/reference/risks) first.

::: danger Experimental — use at your own risk
OpenPendle is novel, unaudited software for a permissionless protocol. Community pools are unreviewed — anyone can create one, and interacting with them can lose you funds. Not affiliated with Pendle Finance. Nothing here is financial advice.
:::

## What OpenPendle is

### Is OpenPendle affiliated with Pendle Finance?

No. OpenPendle is an independent, open-source interface built by [ggmxbt](https://x.com/ggmxbt). It is not affiliated with, endorsed by, or operated by Pendle Finance. It calls Pendle's already-deployed contracts with hand-written ABIs and ships no smart contracts of its own. For the full framing, see [What is OpenPendle](/introduction/what-is-openpendle).

### Does it cost anything? Does it take a fee?

OpenPendle is free and takes no fee of its own — it is a gift to Pendle's community. Pendle's own protocol fees (its swap-fee cap, the YT interest fee, and so on) still apply, because those are enforced by Pendle's contracts rather than by this interface. You can read Pendle's live fee parameters on the app's [Protocol Status & Contracts](https://openpendle.com/#/status) page.

### What can I actually do here that I can't do on the official Pendle app?

OpenPendle reaches Pendle's **permissionless community pools** — markets anyone can create that the official app does not list — and lets you create your own. Everything else is standard Pendle: mint and redeem, [buy PT](/guides/buying-pt), [buy YT](/guides/buying-yt), and [provide liquidity](/guides/providing-liquidity). See [Why OpenPendle](/introduction/why-openpendle) for the motivation.

### Is OpenPendle open source? Can I self-host it?

Yes. It is released under **GPL-3.0-or-later** and is a plain static site — no backend, no server rewrite rules — so you can host it anywhere, including from IPFS. The source is on [GitHub](https://github.com/ggmatch-mod/open-pendle). See [Self-hosting](/reference/self-hosting) for how.

## Safety, trust, and privacy

### Is it safe?

OpenPendle validates a market's **provenance** — that it was created by a Pendle factory it recognizes — before it lets you save or transact against it, and it **simulates every transaction** against the live chain before you sign, using **exact-amount approvals** (never unlimited allowances). But provenance is validation, not endorsement: OpenPendle cannot vouch for the asset or the SY contract underneath a pool. Read [Risks & disclosures](/reference/risks) in full before you transact.

::: warning Community pools are unreviewed
A market being loadable in OpenPendle is not an endorsement of it. Anyone can permissionlessly create a Pendle market wrapping any asset, and OpenPendle cannot check the asset or SY behind it. Never interact with a pool unless you trust whoever created it and the assets underneath.
:::

### What exactly does the provenance gate check — and what can't it check?

It checks that a market descends from a Pendle factory OpenPendle recognizes; because Pendle's factories are governance-mutable, the active factory is resolved **live at runtime**, and the hardcoded factory set is used only for validation. It cannot vouch for the underlying asset or the SY contract — a factory-valid market can still wrap a malicious, broken, or exotic asset. See [Community pools](/concepts/community-pools) and [Pool anatomy](/concepts/pool-anatomy).

### Where is my data stored?

In your browser only. There is no backend, no database, no indexer, no account, no tracking, and no analytics. Your [saved pools](/guides/saved-pools) live in `localStorage` under `openpendle.pools.v1`, and any custom RPC you set stays local too; nothing leaves the browser unless you explicitly export or share it. See [Architecture](/reference/architecture) for the full picture.

### What outbound requests does the app make?

The only outbound requests are the blockchain RPCs you point it at, plus — for the header stats ticker alone — Pendle metrics from the DefiLlama and CoinGecko public APIs. Fonts are self-hosted, so there are zero external font requests, and a Content-Security-Policy (`script-src 'self' 'wasm-unsafe-eval'`) blocks JavaScript `eval()` while permitting the WebAssembly used for crypto. More detail is on the [Architecture](/reference/architecture) page.

## Wallets and networks

### Which wallets work? Why is there no WalletConnect?

OpenPendle is **injected-only**: it connects directly to a browser wallet — MetaMask, Rabby, Brave, or any injected EIP-6963 provider — with no WalletConnect and no third-party relay. Avoiding WalletConnect is what keeps the app backend-free, private, and trivial to self-host from a static host or IPFS; the trade-off is the mobile flow described below. See [Connecting a wallet](/guides/connecting-a-wallet).

### How do I use it on mobile?

Open the site inside a wallet's **in-app dApp browser** (MetaMask, Rabby, and similar) or in **Brave mobile**. A normal mobile browser tab has no injected wallet and cannot connect. You can still browse pools wallet-lessly anywhere, since reads go through RPC — see [Browsing](/guides/browsing).

### Which networks are supported?

Six: Ethereum, BNB Smart Chain, Monad, Base, Plasma, and Arbitrum.

| Network | chainId | Native token |
| --- | --- | --- |
| Ethereum | `1` | ETH |
| BNB Smart Chain | `56` | BNB |
| Monad | `143` | MON |
| Base | `8453` | ETH |
| Plasma | `9745` | XPL |
| Arbitrum | `42161` | ETH |

The **active network** is a UI/`localStorage` choice (key `openpendle.chain`, default Arbitrum) that determines what the whole app reads and where a transaction is sent. If your wallet is on a different chain, a wrong-network banner offers a one-click switch; browsing still works either way. Full per-chain contract details are in [Networks & contracts](/reference/networks-and-contracts).

### Can I use my own RPC?

Yes. Each chain ships a keyless public default wrapped in a viem `fallback()` transport that rolls over to a backup automatically, and you can override the endpoint per chain in RPC settings (stored under `localStorage` key `openpendle.rpc.<chainId>`). The override is stored locally, replaces the defaults for that chain, and saving reloads the app. See [Browsing](/guides/browsing).

## Pendle concepts in one line

### What are PT, YT, and SY?

- **SY (Standardized Yield, EIP-5115)** — a uniform ERC-20 wrapper over a yield-bearing asset, so Pendle can treat many yield sources the same way. See [Standardized Yield](/concepts/standardized-yield).
- **PT (Principal Token)** — the principal, split out from SY; it redeems 1:1 for the underlying **at maturity**, so buying it below par and holding locks in a fixed yield. See [Principal Tokens](/concepts/principal-tokens).
- **YT (Yield Token)** — the right to all the yield the underlying accrues until maturity; a variable, long-yield position that trends to 0 at maturity. See [Yield Tokens](/concepts/yield-tokens).

PT and YT mint from SY and redeem back to SY 1:1 at any time before maturity. The whole model is walked through in [How Pendle works](/concepts/how-pendle-works).

### What is the difference between fixed yield and long yield?

**Fixed yield** is a PT position: you buy PT below par and, holding to maturity, earn a fixed rate set at purchase regardless of what the underlying yield does. **Long yield** is a YT position: you buy the yield stream itself and profit if the realized yield over the period exceeds what you paid for it. See [Buying PT](/guides/buying-pt) and [Buying YT](/guides/buying-yt).

### What is a community pool?

A community pool is a Pendle V2 **market** (an on-chain `PendleMarket` contract) that was created permissionlessly — no whitelist, no approval, and unreviewed by anyone. It is exactly the kind of market Pendle's official app does not list, and it is what you reach in OpenPendle by pasting the **market address** (not the PT, YT, or SY address). See [Community pools](/concepts/community-pools) and [Opening a pool](/guides/opening-a-pool).

### Why isn't a given pool on the official Pendle app?

Because it is a permissionless community pool that Pendle's app simply does not list — being reachable in OpenPendle is not an endorsement, and no one has reviewed it. That long tail of unlisted markets is precisely what OpenPendle exists to reach. See [Why OpenPendle](/introduction/why-openpendle) and [Community pools](/concepts/community-pools).

## Incentives on community pools

### Can community pools have incentives?

Yes, through **[Merkl](https://merkl.angle.money/)** campaigns. Community pools are **not** eligible for native PENDLE gauge emissions or vePENDLE voting — those are reserved for team-listed markets — so a pool creator who wants to reward liquidity providers runs a Merkl campaign instead. See [Community pools & incentives](/create/incentives) and [Providing liquidity](/guides/providing-liquidity).

### If I create a pool, does it get PENDLE emissions?

No. A permissionlessly-created market has no gauge and cannot be voted on, so its LPs earn no native PENDLE for providing liquidity. Any extra rewards must come from a Merkl campaign you set up yourself; the underlying LP still earns Pendle swap fees regardless. See [Creating incentives](/create/incentives).

## Creating and running pools

### Can I create my own SY and market?

Yes — OpenPendle wraps Pendle's permissionless deploy path. You can mint an SY from `PendleCommonSYFactory` (`0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8`) and deploy a market in a single transaction via `PendleCommonPoolDeployHelperV2` (`0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9`), optionally SY and market together. Start at the [Create overview](/create/overview), then [Standardized Yield](/create/standardized-yield) and [Deploying a market](/create/deploying-a-market).

### What kinds of assets can an SY wrap?

An SY template wraps an **ERC-20** or **ERC-4626** asset. There is **no native-ETH SY template**, and both **fee-on-transfer** and **rebasing** tokens are blocked — the first breaks SY accounting and liquidity seeding, the second breaks redemption. See [Creating an SY](/create/standardized-yield).

### Do I have to initialize the price oracle after deploying?

No — it is safe to skip. A fresh market starts with TWAP oracle cardinality 1; a one-time `increaseObservationsCardinalityNext` bump lets **other** protocols price the pool via TWAP (for example, lending markets that take the PT as collateral). It is not required to trade, add liquidity, or quote through OpenPendle. A one-click step is planned; for now you call it from a block explorer if you need it. See [Initializing the price oracle](/create/price-oracle).

## Getting help and reporting issues

### How do I report a security issue?

Reach out to [ggmxbt on X](https://x.com/ggmxbt), or see the machine-readable [`/.well-known/security.txt`](https://openpendle.com/.well-known/security.txt) on the app. Responsible disclosure is appreciated.

### Where can I verify the contract addresses OpenPendle uses?

The full live per-chain list is on the app's [Protocol Status & Contracts](https://openpendle.com/#/status) page, and every address can be cross-checked against Pendle's public repository, `pendle-finance/pendle-core-v2-public`. The shared addresses (identical on all six chains) are also listed in [Networks & contracts](/reference/networks-and-contracts).

## See also

- [What is OpenPendle](/introduction/what-is-openpendle) — the one-page overview
- [Risks & disclosures](/reference/risks) — read before you transact
- [Architecture](/reference/architecture) — backend-free design, CSP, and data flow
- [Networks & contracts](/reference/networks-and-contracts) — the six chains and shared addresses
- [Community pools](/concepts/community-pools) — what "permissionless and unreviewed" means
- [Self-hosting](/reference/self-hosting) — run your own copy
