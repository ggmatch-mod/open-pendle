# Browsing & networks

OpenPendle can be browsed without a wallet. Core market state, quotes, balances, and contract checks are read through the active network's RPC. Discovery and ancillary features also use the public data sources disclosed in [How OpenPendle works](/reference/architecture).

If `PT`, `YT`, and `SY` are new, start with [How Pendle works](/concepts/how-pendle-works).

## Choose the active network

The **active network** determines which chain OpenPendle reads and where an on-chain transaction or PT limit order belongs.

- On desktop while disconnected, use the network control in the header.
- On mobile, use **Menu → Network**.
- Once connected, network, RPC, and theme settings are grouped under **Profile**.

OpenPendle supports:

| Network | Chain ID | Gas token |
| --- | --- | --- |
| Ethereum | `1` | ETH |
| BNB Smart Chain | `56` | BNB |
| Monad | `143` | MON |
| Base | `8453` | ETH |
| Plasma | `9745` | XPL |
| Arbitrum | `42161` | ETH |

Your preferred network is stored locally as `openpendle.chain` and defaults to Arbitrum. A chain-explicit market or token link (`?chain=<id>`) overrides that preference only in its own tab, so shared links open on the intended chain.

When a wallet is connected, selecting a network also asks the wallet to switch. If you reject the request, read-only browsing continues on the chosen network and the wrong-network banner remains available.

::: warning A market belongs to one chain
A `PendleMarket` address is chain-specific. If a pasted market does not resolve, first confirm that the active network matches the market's chain.
:::

## Browse without connecting

Without a wallet you can:

- search the factory-indexed universe in **Explore**;
- open a market or token by address;
- inspect market provenance, the trust panel, maturity, and live metrics;
- view [Yield alerts](/guides/yield-alerts);
- compare [PT looping](/guides/looping) models; and
- save pools in the current browser.

Ordinary market browsing needs no wallet. A wallet is required for wallet-specific views such as Positions and when you sign a transaction, an enabled looping action, or an executable limit order.

## Wrong-network banner

Your wallet's selected chain can differ from OpenPendle's active network. When they do, the banner offers a one-click wallet switch.

The mismatch does not block reads: those continue through the active network's RPC. It does block safe transaction preparation, because the wallet must be on the chain the action targets. Network selection is temporarily locked while an approval, transaction, or limit-order signature flow is in progress.

## Custom RPC endpoints

Each supported chain has keyless public RPC defaults with fallback endpoints. You can replace them per chain in **RPC endpoint** settings.

An override is stored locally as `openpendle.rpc.<chainId>`; Arbitrum also recognizes the older `openpendle.rpc` key. Saving an override reloads the app so its transport can be rebuilt.

Use a custom endpoint when you need better rate limits, lower latency, or a node you trust. Clearing the field restores the public defaults.

::: warning Trust the endpoint you choose
An RPC can return stale or misleading data or drop requests. Simulation and approval controls operate against the chain view that RPC provides; they cannot make a hostile endpoint or unsafe market trustworthy.
:::

## Theme and local settings

The theme control switches between dark and light mode and stores the choice locally as `op.theme`. The active network, RPC overrides, theme, and saved pools all remain browser-local and reset when site data is cleared.

OpenPendle still makes external requests needed for blockchain reads, market discovery, alerts, limit orders, positions, the header ticker, and anonymous site analytics. See [How OpenPendle works](/reference/architecture) for the current provider list and privacy boundaries.

## Next

- [Connecting a wallet](/guides/connecting-a-wallet)
- [Opening a pool](/guides/opening-a-pool)
- [Networks & contracts](/reference/networks-and-contracts)
- [Risks & disclosures](/reference/risks)
