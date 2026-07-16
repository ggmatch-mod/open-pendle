# How OpenPendle works

OpenPendle is a free, open-source (`GPL-3.0-or-later`) web interface to the full Pendle V2 market universe on its six supported chains. Its factory-indexed directory includes both Pendle-listed markets and permissionless [community pools](/concepts/community-pools) that the official app does not list. This page is the architecture and trust-model deep-dive: what the interface is, what it deliberately is **not**, and every boundary it draws around your funds and your privacy.

The short version is a single design commitment: OpenPendle is a **thin, verifiable client** in front of contracts it does not own. It ships **no smart contracts of its own** and adds **no fee of its own** — it calls Pendle's already-deployed contracts with hand-written ABIs, and every Pendle protocol fee still applies. OpenPendle operates no request-time application server, account system, database, or transaction relay. Core market reads and transactions go directly through the RPC endpoint you choose. Explore consumes a versioned static catalog built on a schedule from factory events, and clearly scoped public services provide enrichment, ticker, token-discovery, rewards, and Cloudflare page-view/performance analytics.

::: info The trust model in one sentence
OpenPendle reads and writes Pendle V2 directly from your browser, validates that a market genuinely came from a Pendle factory, simulates every transaction before you sign, and defaults to exact-amount approvals — but it **validates provenance, not the asset or SY underneath**, and it is **not affiliated with, endorsed by, or operated by Pendle Finance**.
:::

## What OpenPendle is not

Most of OpenPendle's security properties are the direct consequence of things it refuses to have. It is easier to trust a system when there is less of it to trust.

- **No OpenPendle request-time backend.** There is no OpenPendle server that holds your data, brokers transactions, or sits between your wallet and Pendle.
- **No live application database.** Core pool state, balances, quotes, provenance, and transaction simulations are read live from the chain. A scheduled, stateless catalog job indexes recognized factories' `CreateNewMarket` logs into a static JSON snapshot for discovery and PT/YT-to-pool lookup. Pendle's public API enriches those records; where available, public Blockscout indexes provide a lookup fallback beyond the snapshot's indexed head.
- **No accounts.** There is nothing to sign up for and no identity to link.
- **Limited interface analytics.** Cloudflare Web Analytics receives page-view and performance metrics. OpenPendle does not intentionally include wallet addresses, saved pools, or settings in that beacon. As with any direct web request, the RPC and ancillary public services can observe the requests sent to them; the exact calls are listed below.
- **No custody.** OpenPendle never holds funds. Your wallet signs; the transaction goes straight to Pendle's contracts.
- **No contracts of its own.** OpenPendle deploys nothing. It calls Pendle's deployed contracts using ABIs written by hand and checked into the [open-source repository](https://github.com/ggmatch-mod/open-pendle).

Because OpenPendle operates no request-time transaction service, there is no privileged OpenPendle server that can quietly rewrite a transaction or collect application telemetry. The app logic runs in your browser, which is what makes it self-hostable and censorship-resistant. The published catalog can be stale or incomplete, and its data providers can observe the indexing or enrichment requests they receive, but an outage disables discovery rather than the core market-by-address reads or transactions. See [Self-hosting](/reference/self-hosting) for running your own copy and rebuilding the snapshot.

## Reads: straight from the chain

OpenPendle reads Pendle's state directly from public RPC using [viem](https://viem.sh) and batches those reads through **Multicall3** at `0xcA11bde05977b3631167028862bE2a173976CA11` — the same canonical Multicall3 address on all six supported networks. Batching many calls into one request is what lets a pool's full state (PT price, SY exchange rate, market reserves, your balances, oracle data) load in a single round-trip instead of dozens.

Nothing about reading requires a wallet. Browsing OpenPendle is **wallet-less**: you can open the app, switch networks, open a pool, and watch quotes update as you type without ever connecting. A connection is only needed to *sign* a transaction. See [Browsing & networks](/guides/browsing).

The set of contracts OpenPendle reads and writes is Pendle's own. The fixed entry points — identical on every chain — are:

| Contract | Address | Role |
| --- | --- | --- |
| Router V4 | `0x888888888889758F76e7103c6CbF23ABbF58F946` | All trades, liquidity, and exits |
| PendleCommonPoolDeployHelperV2 | `0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9` | One-tx pool (+ optional SY) deploys |
| PendleCommonSYFactory | `0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8` | Permissionless SY-template deploys |
| PendlePYLpOracle | `0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2` | TWAP oracle for PT / YT / LP pricing |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | Batched reads |
| Pendle governance proxy | `0x2aD631F72fB16d91c4953A7f4260A97C2fE2f31e` | Default owner of wizard-deployed SYs |
| Pendle ProxyAdmin | `0xA28c08f165116587D4F3E708743B4dEe155c5E64` | Admin of Pendle's upgradeable SY proxies |

Other addresses — the PENDLE token, `RouterStatic`, treasury, governance multisig, wrapped native, and the market and yield-contract factories — are chain-specific and are resolved live rather than assumed. The full per-chain list lives on the in-app [Protocol Status & Contracts](https://openpendle.com/#/status) page, and every address is verifiable against `pendle-finance/pendle-core-v2-public`. The complete reference is on [Networks & contracts](/reference/networks-and-contracts).

## Data flow: live actions plus a static discovery catalog

The signed-action path from your browser to the chain remains short and has no OpenPendle intermediary. Market discovery has a separate, read-only build path.

```mermaid
flowchart LR
  subgraph B["Your browser (the whole app)"]
    UI[OpenPendle UI]
    W[Injected wallet<br/>MetaMask / Rabby / Brave]
  end
  UI -->|batched reads<br/>via viem + Multicall3| RPC[(Public RPC<br/>your endpoint)]
  RPC -->|market / PT / YT / SY state| UI
  UI -.->|signature request| W
  W -.->|signed tx| RPC
  RPC -->|calls| PENDLE[Pendle V2 contracts<br/>Router V4, factories, oracle]
  UI -->|same-origin static JSON| SNAP[(Factory-market snapshot)]
  UI -->|aggregate header metrics| STATS[(DefiLlama / CoinGecko<br/>public metrics APIs)]
  UI -->|listed enrichment +<br/>post-snapshot lookup fallback| INDEX[(Pendle market API /<br/>Blockscout log APIs)]
  UI -->|wallet address + chain ID<br/>on My positions| MERKL[(Merkl rewards API)]
  JOB[Scheduled catalog job] -->|scan CreateNewMarket<br/>across recognized factories| CHAIN[(Supported-chain RPCs)]
  JOB -->|publish versioned artifact| SNAP
```

Core reads flow browser → RPC → Pendle and back. When you transact, the injected wallet signs locally and the signed transaction is sent to the same RPC, which submits it to Pendle's `Router V4`. Explore first reads a static snapshot whose inventory comes from `CreateNewMarket` events across the configured factory lineage. The same snapshot maps a pasted PT/YT to every indexed pool that shares it. Pendle's API enriches that inventory with listed status and optional display metrics; it does not define membership. DefiLlama/CoinGecko provide aggregate header metrics, keyless Blockscout log APIs can assist with the bounded post-snapshot lookup where available, and Merkl's rewards API receives the wallet address and chain ID when a connected user opens **My positions**.

### Catalog generation and coverage

The catalog generator is a **scheduled batch indexer**, not a continuously running application backend. It scans each configured factory generation in bounded log ranges, resumes from checkpoints, replays a recent block window to tolerate reorganizations, and publishes `/catalog/factory-markets.v1.json`. The snapshot carries each chain's indexed-through block, hash and block timestamp, plus completeness, errors, and quarantined-log count. The UI can therefore distinguish a genuinely empty result from an incomplete scan and warn when the last-known-complete artifact has become stale. A failed scheduled refresh never replaces a complete published snapshot with a partial one.

Factory events are the inventory source because they answer the protocol-level question: *which markets did a recognized Pendle factory create?* Pendle's API answers a separate product-level question: *which of those markets is currently represented in Pendle's public catalog, and what optional metadata does it expose?* Keeping those inputs separate prevents a frontend listing decision from hiding a valid community market.

A valid factory event can still produce an incomplete card if later contract hydration or API enrichment fails. Such a market stays addressable and is marked incomplete rather than silently dropped. A malformed or undecodable factory log is quarantined from normal results and counted in the snapshot report. None of these discovery states bypasses the market page's live provenance gate.

## Hosting: HashRouter, static, IPFS-ready

OpenPendle uses a **HashRouter**, so in-app URLs look like `openpendle.com/#/...` — the route lives in the fragment after the `#`. This is a deliberate hosting decision, not a cosmetic one. Because the server never sees the part after the `#`, every route resolves to the same single `index.html`, so the app runs on **any static host or IPFS with no server rewrite rules** and no SPA fallback configuration. A plain file server, an object store, or an IPFS gateway serves it unchanged.

This is what makes OpenPendle genuinely portable and hard to take down: the production build is a static bundle with no absolute paths and no server routes, so it pins cleanly to IPFS and works from any gateway. [Self-hosting](/reference/self-hosting) walks through building and pinning your own copy.

## The provenance gate: validation, not endorsement

Before you can **save** a market or **transact** against it, OpenPendle runs a **provenance gate**. It verifies that the market was created by a **Pendle factory it recognizes** — confirming the contract genuinely descends from Pendle's deployment machinery rather than being an impostor contract wearing a Pendle market's shape.

Two properties of this check matter enormously, and they are easy to conflate.

**First, it is resolved live.** Pendle's factories are **governance-mutable** — governance can change which factory is active. So OpenPendle never hardcodes the "active" factory for routing; it **resolves the current factory live at runtime**. The hardcoded factory set exists for one purpose only: provenance validation, checking a market against the known lineage of Pendle factories on that chain.

**Second, and most important: provenance is validation, not endorsement.** The gate answers exactly one question — *"did this market come from a Pendle factory?"* It does **not** answer "is this asset safe?", "is this SY honest?", or "is whoever deployed this trustworthy?" A market can pass the provenance gate cleanly and still be built on a malicious, broken, or exotic asset. OpenPendle vouches for *where a market came from*, and for nothing underneath it.

```mermaid
flowchart TD
  A[You point OpenPendle at a market] --> R[Read the market from chain via RPC]
  R --> V{Provenance gate:<br/>created by a recognized<br/>Pendle factory?<br/>active factory resolved live}
  V -->|No| X[Cannot save or transact]
  V -->|Yes — validated, NOT endorsed| S[Simulate the action against live chain]
  S --> Q{Would it revert?}
  Q -->|Yes| X2[Blocked before you sign]
  Q -->|No| E[Exact approval by default,<br/>or explicit unlimited opt-in,<br/>then sign]
  E --> U([You still decide whether to trust<br/>the asset & SY underneath])
```

The factory lineage that OpenPendle validates against is chain-specific: Ethereum, BNB Smart Chain, and Arbitrum carry the full history (v1, V3, V4, V5, V6); Base and Plasma carry V5 and V6; Monad, which launched on the current generation, is V6 only. This lineage is documented in full on [Networks & contracts](/reference/networks-and-contracts), and the concept is explained from the market's point of view in [Community pools](/concepts/community-pools).

## Transaction safety: simulate-before-sign and approval modes

The protections OpenPendle offers on the *act of transacting* are two-fold.

**Simulate-before-sign.** Every transaction is simulated against the **live chain** before you are asked to sign. A call that would revert on-chain is caught first, so you do not spend gas discovering that an action was impossible. Quotes for trades, mints, redemptions, and liquidity actions update live as you type, and the same simulation backs the final signature.

**Exact by default; unlimited only by explicit opt-in.** When an action needs an ERC-20 allowance, OpenPendle defaults to approving the **exact amount** that action requires. Transaction settings also let you explicitly select **Unlimited**, which approves the maximum amount and leaves a standing allowance until you revoke it. That can save approval transactions on repeat actions, but it increases exposure to the approved contract—especially if an SY is hostile or later compromised. If a deploy or seed uses native ETH (an SY that lists `address(0)` among its inputs), value is sent as `msg.value` and no ERC-20 approval is needed.

::: warning These protect the transaction, not the asset
Simulate-before-sign and the exact-approval default make the *mechanics* of interacting more legible — simulation catches reverts, and exact approvals cap allowances. Explicitly opting into unlimited approvals removes that cap and increases standing exposure. Neither mode makes an unreviewed asset safe. Community pools are permissionless and unreviewed — anyone can create one, and interacting with them can lose you funds. OpenPendle validates market provenance but cannot vouch for the assets or SY contracts underneath. Read [Risks & disclosures](/reference/risks) before you transact.
:::

## Wallets: injected-only, no relay

OpenPendle connects **only** to an injected browser wallet. There is **no WalletConnect and no third-party relay** — nothing sits between the interface and your wallet. It works with MetaMask, Rabby, Brave, and any injected **EIP-6963** provider, discovered directly in the page.

The practical consequences:

- **Desktop:** use the wallet's browser extension.
- **Mobile:** open the site inside a wallet's in-app dApp browser (MetaMask, Rabby, …) or in Brave mobile. A normal mobile browser tab has **no injected wallet** and cannot connect — this is a limitation of injected-only design, and the trade for having no relay to trust.
- **Browsing stays wallet-less.** Reads go through RPC, so you can explore fully without connecting. When your wallet's chain differs from the app's active network, a wrong-network banner offers a one-click switch; browsing continues to work regardless.

Because there is no relay, there is no third party that can observe your sessions, drop your transactions, or interpose itself between you and your wallet. See [Connecting a wallet](/guides/connecting-a-wallet) for the step-by-step.

## Networks and RPC: defaults, fallback, and per-chain override

OpenPendle supports six networks: Ethereum (`1`), BNB Smart Chain (`56`), Monad (`143`), Base (`8453`), Plasma (`9745`), and Arbitrum (`42161`).

The preferred network is stored under `openpendle.chain`, defaulting to Arbitrum. A chain-explicit market/token URL overrides it only for its own tab; the resulting active network determines what the app reads and where a transaction is sent. An explicit selector click also asks a connected wallet to switch, while a rejected request leaves read-only browsing on the selected chain. All of this is client-side; nothing on a server changes.

RPC is designed to keep working without your intervention while staying fully in your control:

- **Keyless public defaults per chain.** Each network ships with public RPC endpoints that require no API key.
- **Automatic fallback.** The defaults are wrapped in a **viem `fallback()` transport**, so a rate-limited or unreachable endpoint automatically rolls over to a backup — you should rarely notice an outage.
- **Per-chain override, stored locally.** You can override the endpoint for any single chain in **RPC settings**. The override is written to `localStorage` under `openpendle.rpc.<chainId>`, **replaces the defaults for that chain**, stays entirely on your device, and saving reloads the app so the new endpoint takes effect everywhere.

::: tip Your RPC endpoint sees your reads
Whatever RPC you point OpenPendle at can see the read requests your browser makes to it. The public defaults are keyless conveniences; if you would rather a specific provider (or your own node) serve your traffic, set a per-chain override. It is stored only in your browser and never transmitted anywhere except to the endpoint itself.
:::

Full RPC and network details are on [Networks & contracts](/reference/networks-and-contracts).

## Content-Security-Policy and self-hosted assets

OpenPendle ships a strict **Content-Security-Policy**. The script directive is:

```
script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com
```

- `'self'` restricts the application bundle to the app's own origin; the only allowlisted remote script is Cloudflare Web Analytics.
- `'wasm-unsafe-eval'` permits **WebAssembly** instantiation (used for cryptography) **without** enabling JavaScript `eval()` or the `Function` constructor. The dynamic-string code paths that malicious script typically abuses are blocked; WASM, which cannot be used the same way, is allowed for the crypto it needs.

**Fonts are self-hosted.** They are bundled with the app, so there are **zero external font requests** — no font CDN sees your visits, and the app renders correctly offline or from an air-gapped mirror.

## Outbound requests

Given all of the above, the complete list of things that leave your browser is short and worth stating exactly:

| Outbound call | When | Why |
| --- | --- | --- |
| **Blockchain RPC** | Reading state; submitting a signed transaction | The endpoint(s) you point at — defaults or your override |
| **DefiLlama / CoinGecko public APIs** | Loading the header stats ticker | Aggregate Pendle metrics shown in the header |
| **Factory-market snapshot** | Loading Explore | Same-origin static inventory derived from recognized factories' `CreateNewMarket` events; includes schema and coverage metadata |
| **Pendle market API** | Enriching Explore; resolving a pasted PT/YT | Optional listed status, names, icons, TVL/APY metadata, and token-to-pool lookup |
| **Keyless Blockscout log APIs** | Pendle's index does not resolve that PT/YT on a supported Blockscout chain | Factory/event-topic lookup for community pools |
| **Merkl rewards API** | A connected user opens **My positions** | The wallet address and chain ID required to retrieve claimable rewards and proofs |
| **Cloudflare Web Analytics** | Loading and navigating the interface | Privacy-focused page-view and performance metrics |

OpenPendle uses Cloudflare Web Analytics but no error-reporting endpoint, font CDN, or wallet relay. The analytics beacon is not in the transaction-signing path and is not intentionally sent wallet addresses. These ancillary services can observe ordinary request metadata such as your IP address; Merkl additionally receives the connected wallet address and chain ID described above.

::: info Everything else is local
Your active network (`openpendle.chain`), RPC overrides (`openpendle.rpc.<chainId>`), and saved pools (`openpendle.pools.v1`) all live in your browser's `localStorage`. Those stored settings and the saved-pool registry are not uploaded to any ancillary service; the registry leaves your browser only when you explicitly export or share it. See [Saved pools & privacy](/guides/saved-pools).
:::

## Ships no contracts; hand-written ABIs

OpenPendle deploys nothing on-chain. Every interaction — reading a market, minting, redeeming, swapping, adding or removing liquidity, deploying a pool — is a call into **Pendle's own deployed contracts**, encoded against **hand-written ABIs** checked into the repository. There is no OpenPendle proxy, no OpenPendle router, and no OpenPendle fee-taking hook in the path; because it ships no contracts, it takes **no fee of its own**, though Pendle's own protocol fees still apply.

This is also why the interface is straightforward to audit and self-host: the ABIs are readable in source, the addresses are Pendle's public deployments, and you can cross-check every one against `pendle-finance/pendle-core-v2-public` or a block explorer. See [Self-hosting](/reference/self-hosting) to build and serve your own copy.

## Where trust actually sits

Pulling the pieces together, here is the honest accounting of what you are and are not trusting when you use OpenPendle.

| You are trusting | You are **not** relying on OpenPendle for |
| --- | --- |
| Pendle V2's deployed contracts (Router, factories, oracle) | Any judgment about whether an asset or SY is safe |
| The RPC endpoint you point at, the published catalog artifact, and the scoped public services listed above when their features run | An OpenPendle request-time backend, account database, or transaction relay |
| Your own wallet and its signing | A WalletConnect or third-party relay (there is none) |
| The static bundle you loaded (verifiable, self-hostable) | Endorsement of any market — provenance is not approval |
| Pendle's governance over its factories and SY proxies | Analytics or tracking of your activity (there is none) |

The provenance gate, simulate-before-sign, exact-approval default, injected-only wallets, the strict CSP, and self-hosted fonts all harden the *interface and the act of transacting*. None of them can make an unreviewed asset trustworthy. That gap — between "this transaction will do what the interface says" and "this asset is worth interacting with" — is exactly where a community pool's risk lives, and only you can close it.

::: danger Not affiliated with Pendle; community pools are unreviewed
OpenPendle is **not affiliated with, endorsed by, or operated by Pendle Finance**. It is experimental — use at your own risk. Community pools are permissionless and unreviewed — **anyone can create one, and interacting with them can lose you funds.** OpenPendle validates market provenance but **cannot vouch for the assets or SY contracts underneath.** Never interact with a market unless you trust whoever created it and everything beneath it — the asset, the SY, its adapter, and its owner. Security contact: [x.com/ggmxbt](https://x.com/ggmxbt) (see `/.well-known/security.txt`).
:::

## See also

- [Networks & contracts](/reference/networks-and-contracts) — the six chains, the shared addresses, the per-chain factory lineage, and RPC details.
- [Risks & disclosures](/reference/risks) — the full risk surface; read it before you transact.
- [Self-hosting](/reference/self-hosting) — build, pin to IPFS, and run your own verifiable copy.
- [Community pools & incentives](/concepts/community-pools) — what "permissionless and unreviewed" means for the markets OpenPendle reaches.
- [Saved pools & privacy](/guides/saved-pools) — how the client-side registry works and what stays in your browser.
- [Connecting a wallet](/guides/connecting-a-wallet) — injected-only wallets on desktop and mobile.
