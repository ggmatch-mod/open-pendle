# Networks & contracts

OpenPendle ships **no smart contracts of its own**. Every read and every transaction it makes goes to Pendle V2's already-deployed contracts, called with hand-written ABIs. This page is the authoritative reference for *which* contracts those are: the six supported networks, the entry-point addresses that are identical on all of them, the per-chain contracts that vary and are therefore resolved live, the RPC endpoints the app reads through, and how to verify every one of these facts yourself.

It is a reference page, not a tutorial. For the interface around this — the network selector, browsing without a wallet, the custom-RPC field — see [Browsing & networks](/guides/browsing). If `PT`, `YT`, and `SY` are unfamiliar, start with [How Pendle works](/concepts/how-pendle-works); this page assumes them.

::: info OpenPendle is only an interface
Because OpenPendle deploys nothing, every address below belongs to Pendle Finance or is a canonical public utility (like `Multicall3`). OpenPendle validates that a market descends from a Pendle factory it recognises, but it cannot vouch for the assets or SY contracts underneath. Not affiliated with Pendle Finance, and it takes no fee of its own.
:::

## Supported networks

OpenPendle supports six chains. Pendle V2's core contracts are deployed on each, and the app reads from and writes to them directly.

| Network | Chain ID | Native token |
| --- | --- | --- |
| Ethereum | `1` | ETH |
| BNB Smart Chain | `56` | BNB |
| Monad | `143` | MON |
| Base | `8453` | ETH |
| Plasma | `9745` | XPL |
| Arbitrum | `42161` | ETH |

The **native token** is the chain's gas asset — what you pay transaction fees in — and on some chains it is also an asset a pool can accept directly at deploy time. Note that ETH is the native token on three of these chains (Ethereum, Base, Arbitrum), so "ETH" alone does not identify a chain; the **chain ID is the unambiguous identifier**, and it is the value the app keys everything on.

The **active network** — the one the whole app currently reads from and would send a transaction to — normally comes from a UI preference stored under `openpendle.chain` (default **Arbitrum**). A market/token URL with `?chain=<id>` overrides that preference only for its own tab. It remains distinct from the wallet's chain, although an explicit selector click asks a connected wallet to synchronize. See [Browsing & networks](/guides/browsing) for the selector and wrong-network behavior.

::: warning A market lives on exactly one chain
A `PendleMarket` address exists only on the single chain it was deployed to. If the active network does not match the chain a market lives on, that market will not resolve. When you open a pool from a shared address or an `?import=` link, make sure the active network matches the chain the market was created on. See [Opening a pool](/guides/opening-a-pool).
:::

## Shared entry points

A set of Pendle's contracts is deployed to the **same address on all six chains**. These are the entry points OpenPendle calls most often, and because the address is identical everywhere, they are safe to hardcode. Each is reproduced here character-for-character; verify them against a block explorer on any chain (see [Verify for yourself](#verify-for-yourself)).

| Contract | Address | Role |
| --- | --- | --- |
| Router V4 | `0x888888888889758F76e7103c6CbF23ABbF58F946` | Every trade, liquidity add/remove, and exit routes through it |
| `PendleCommonPoolDeployHelperV2` | `0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9` | One-transaction pool deploy, optionally bundling an SY deploy |
| `PendleCommonSYFactory` | `0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8` | Permissionless SY deploys from its registered templates |
| `PendlePYLpOracle` | `0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2` | TWAP oracle used to price PT / YT / LP |
| `Multicall3` | `0xcA11bde05977b3631167028862bE2a173976CA11` | Batches many reads into a single RPC call |
| Pendle governance proxy | `0x2aD631F72fB16d91c4953A7f4260A97C2fE2f31e` | Default owner of SYs deployed through the create wizard |
| Pendle ProxyAdmin | `0xA28c08f165116587D4F3E708743B4dEe155c5E64` | Admin of Pendle's upgradeable (adapter) SY proxies |

A few notes on what each one means in practice:

- **Router V4** is the single contract your trades, liquidity actions, and exits flow through. When one of those actions needs approval, Router V4 receives the allowance: exact-amount by default, or unlimited only after an explicit settings opt-in. See [Buying PT](/guides/buying-pt), [Buying YT](/guides/buying-yt), and [Providing liquidity](/guides/providing-liquidity).
- **`PendleCommonPoolDeployHelperV2`** and **`PendleCommonSYFactory`** are the creation surface — the helper deploys a market (and can bundle the SY in the same transaction), and the factory deploys an SY from its registered templates. See [Creating a pool: overview](/create/overview), [Creating an SY](/create/standardized-yield), and [Deploying a market](/create/deploying-a-market).
- **`PendlePYLpOracle`** provides the time-weighted prices used to value PT, YT, and LP. It reads from a market's on-chain observation buffer, which is why a freshly deployed market may need an oracle cardinality bump before *other* protocols can price it. See [Initializing the price oracle](/create/price-oracle).
- **`Multicall3`** is the canonical community deployment present at the same address across most EVM chains; OpenPendle uses it to fold many core reads into one RPC round-trip, which keeps browsing responsive without an OpenPendle-operated backend or indexer. See [How OpenPendle works](/reference/architecture).
- The **governance proxy** and **ProxyAdmin** are Pendle-controlled. The governance proxy is the default **owner** of an SY you deploy through the wizard (so you do not end up controlling the SY machinery), and the ProxyAdmin is the **admin** of Pendle's upgradeable SY proxies — adapter SYs are `TransparentUpgradeableProxy` contracts whose admin is Pendle governance, not you. See [Creating an SY](/create/standardized-yield).

::: info Same address, still per-chain instances
"Identical address on all six chains" does not mean one shared contract — it is a separate deployment on each chain that happens to sit at the same address (Pendle uses deterministic deployment for these). Router V4 on Arbitrum and Router V4 on Base are distinct contracts holding distinct state; only the address they occupy is the same. Reads and writes always go to the instance on the **active network**.
:::

## Per-chain contracts (resolved live)

Not everything is identical across chains. The following are **chain-specific**, and OpenPendle does **not** hardcode them for routing:

- the `PENDLE` token,
- `RouterStatic` (the read-only quoting helper),
- the treasury,
- the governance multisig,
- the wrapped-native token, and
- most importantly, the **market and yield-contract factories**.

Two facts make live resolution necessary rather than a convenience. First, these addresses genuinely differ from chain to chain. Second, Pendle's factories are **governance-mutable** — governance can change which factory is the active one — so a value that is correct today may not be tomorrow. Hardcoding the "active" factory would eventually route against a stale contract.

So OpenPendle resolves the current per-chain contracts **live at runtime**, from the chain itself, and treats its built-in factory list as a *provenance* set only — used to answer "was this market minted by a genuine Pendle factory?", never as the source of the address it routes a trade to.

::: info Provenance validation, not endorsement
The hardcoded factory set exists so the app can confirm a market's **origin** before you save or transact against it. A pass means a recognised Pendle factory created the market — nothing more. It is not a statement that the underlying asset or SY is safe. Community pools are permissionless and unreviewed. See [Community pools & incentives](/concepts/community-pools).
:::

### Factory lineage by chain

Pendle has shipped several factory generations over time, and not every chain carries the whole history. A chain can only host markets made by a factory in *its* lineage, so the set of possible community pools differs per network. The lineage present on each chain:

| Network | Factory lineage present |
| --- | --- |
| Ethereum | v1 + V3 + V4 + V5 + V6 |
| BNB Smart Chain | v1 + V3 + V4 + V5 + V6 |
| Arbitrum | v1 + V3 + V4 + V5 + V6 |
| Base | V5 + V6 |
| Plasma | V5 + V6 |
| Monad | V6 only |

The three oldest chains (Ethereum, BSC, Arbitrum) carry the full lineage back to v1. Base and Plasma joined later and carry V5 + V6. Monad launched on the current generation and is **V6 only**. A market created by, say, a V3 factory can therefore exist on Ethereum, BSC, or Arbitrum, but not on Monad — the factory that would have minted it was never deployed there.

::: tip Read the live set from the app
Because the per-chain contracts and the exact live factory addresses can change with governance, the source of truth is the app's [Protocol Status & Contracts](https://openpendle.com/#/status) page, which reads them from the chain in real time for whichever network you are on. This documentation page deliberately does not print those mutable addresses, so it cannot go stale against the chain.
:::

## RPC endpoints

Core blockchain data — pool state, quotes, balances, maturities, provenance checks, and simulations — arrives over an **RPC endpoint**, and every transaction is submitted through one. No OpenPendle request-time backend, database, indexer, or transaction relay sits in that path. Explore's static inventory is generated on a schedule by scanning these factory lineages; aggregate ticker metrics, Pendle listing enrichment, PT/YT-to-pool discovery, and Merkl rewards use the scoped data sources listed below.

### Keyless defaults with automatic fallback

Each chain ships with **keyless public RPC defaults** — no API key, nothing to configure, works out of the box. To stay resilient, OpenPendle wraps each chain's default endpoints in a viem `fallback()` transport: if the primary endpoint is rate-limiting or unreachable, the app **automatically rolls over to a backup**. For most people this is invisible and needs no attention.

### Overriding the endpoint per chain

You can replace the endpoint for any single chain. In **RPC settings**, each network has its own field; the endpoint you enter is stored locally under the key `openpendle.rpc.<chainId>` — for example `openpendle.rpc.42161` for Arbitrum, `openpendle.rpc.1` for Ethereum. When your override is set and valid, it **replaces the default list for that chain**; clear it (or enter something invalid) and the app reverts to the keyless public defaults.

Three properties of overrides are worth stating precisely:

- **They are local.** An override is stored in your browser's localStorage, exactly like your other preferences. It never leaves the browser, and clearing site data removes it.
- **They are per-chain and independent.** An override keyed to one chain ID affects only that chain; the other five are untouched, each governed by its own key.
- **Saving reloads the app.** The transport is built once at startup, so applying an override restarts the app to rebuild it against the new endpoint. This is expected, not an error.

::: info Legacy Arbitrum key
For historical reasons, Arbitrum also honours the older un-suffixed key `openpendle.rpc` when the newer `openpendle.rpc.42161` is unset. New overrides should use the chain-suffixed form; the legacy key is read only as a fallback for Arbitrum.
:::

For why you might set an override — rate limits, latency, privacy, or reading from a specific node — and a worked walkthrough, see [Custom RPC endpoints](/guides/browsing#custom-rpc-endpoints).

::: warning A malicious or misconfigured RPC can mislead you
An RPC endpoint answers the app's read queries, so a hostile or broken endpoint could return misleading data (wrong balances, stale prices) or silently drop requests. Overriding the RPC changes *where* reads and transactions are sent, not *what* is read — contract addresses, the provenance gate, and simulation logic are unaffected — but those protections operate against whatever chain view the endpoint provides. Only point a chain at an endpoint you trust. Community pools are permissionless and unreviewed, and interacting with them can lose you funds; see [Risks & disclosures](/reference/risks).
:::

### Outbound requests

RPC endpoints carry the blockchain reads and writes you point them at. The stock app also downloads its generated factory-market snapshot, calls **DefiLlama/CoinGecko** for aggregate header metrics, uses Pendle's market API for Explore enrichment and PT/YT pool lookup, uses keyless **Blockscout** log APIs as a lookup fallback where available, and calls **Merkl** when a connected user opens **My positions**. The Merkl reward lookup includes the wallet address and chain ID. OpenPendle sends no analytics or tracking beacon. A strict Content-Security-Policy (`script-src 'self' 'wasm-unsafe-eval'`) blocks JavaScript `eval()`/`Function`, and fonts are self-hosted, so there are zero external font requests. See [How OpenPendle works](/reference/architecture).

## Verify for yourself

None of these addresses require trust in OpenPendle, because OpenPendle authored none of them. You can confirm every one independently:

- **Block explorers.** Look up any address above on the block explorer for the relevant chain — Etherscan for Ethereum, Arbiscan for Arbitrum, BscScan for BNB Smart Chain, and the corresponding explorers for Base, Plasma, and Monad. For a shared entry point, you can check the *same* address on each of the six explorers and see the deployment on every chain.
- **Pendle's public source.** Cross-check the roles and deployments against Pendle's open repository, [`pendle-finance/pendle-core-v2-public`](https://github.com/pendle-finance/pendle-core-v2-public). It is the reference for what each contract is and where it lives.
- **The live per-chain set.** For the chain-specific and governance-mutable addresses this page does not print, read them from the chain via the app's [Protocol Status & Contracts](https://openpendle.com/#/status) page, then verify those too against the explorer and Pendle's repo.

::: tip The addresses are checksummed
Every address on this page is in EIP-55 checksummed form and is copied verbatim from the fact sheet. Paste them into an explorer exactly as written. If a tool rejects an address for a bad checksum, you have a transcription error — re-copy from here rather than adjusting the casing by hand.
:::

## See also

- [Browsing & networks](/guides/browsing) — the network selector, custom-RPC field, and wrong-network banner in the interface.
- [How OpenPendle works](/reference/architecture) — the static, RPC-first, simulate-before-sign architecture and ancillary-service disclosure.
- [Community pools & incentives](/concepts/community-pools) — what "permissionless and unreviewed" means, and how provenance is checked.
- [Anatomy of a pool](/concepts/pool-anatomy) — how the market, PT, YT, and SY contracts wire together.
- [Creating a pool: overview](/create/overview) — the factories and helper a deploy calls, and what you receive.
- [Risks & disclosures](/reference/risks) — please read before you transact against any community pool.
