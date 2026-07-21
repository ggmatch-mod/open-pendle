# Networks & contracts

OpenPendle ships no OpenPendle-authored smart contracts. It calls Pendle's deployed contracts and, in the Create flow, asks Pendle's factories and helper to deploy Pendle SY and market contracts. This page records the network configuration used by the production interface.

## Supported networks

| Network | Chain ID | Native gas token |
| --- | ---: | --- |
| Ethereum | `1` | ETH |
| BNB Smart Chain | `56` | BNB |
| Monad | `143` | MON |
| Base | `8453` | ETH |
| Plasma | `9745` | XPL |
| Arbitrum | `42161` | ETH |

The preferred chain is stored under `openpendle.chain` and defaults to Arbitrum. A market/token URL with `?chain=<id>` overrides it for that tab. Selecting a chain also asks an injected wallet to switch; rejecting the wallet request leaves read-only browsing on the selected OpenPendle chain.

::: warning A market is chain-specific
An address is not enough to identify a market across networks. Confirm the chain ID before reading, sharing, approving, or signing.
:::

## Shared entry points

These addresses are configured identically on all six chains:

| Contract | Address | Role |
| --- | --- | --- |
| Router V4 | `0x888888888889758F76e7103c6CbF23ABbF58F946` | AMM trades, liquidity, and exits |
| Limit Router | `0x000000000000c9B3E2C3Ec88B1B4c0cD853f4321` | Limit-order validation, settlement, and cancellation |
| `PendleCommonPoolDeployHelperV2` | `0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9` | Market deployment and initial liquidity; can also deploy an SY |
| `PendleCommonSYFactory` | `0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8` | Permissionless SY-template deployment |
| `PendlePYLpOracle` | `0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2` | PT/YT/LP TWAP pricing |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | Batched reads |
| Pendle governance proxy | `0x2aD631F72fB16d91c4953A7f4260A97C2fE2f31e` | Default owner option for wizard-deployed SYs |
| Pendle ProxyAdmin | `0xA28c08f165116587D4F3E708743B4dEe155c5E64` | Admin of factory-deployed upgradeable SY proxies |

The same address on two chains still represents two separate contract instances and states.

Router V4 receives allowances for immediate AMM actions. The Limit Router is a separate spender for supported limit orders. The deployment helper receives a seed-token allowance during market creation. Review the spender in every wallet prompt; identical-looking actions can legitimately target different contracts.

## Bundled configuration versus live reads

The production release contains a chain-keyed address book. It includes `RouterStatic`, PENDLE, wrapped-native tokens, treasury and governance references, plus the recognized market/yield-factory lineage. These values are not all rediscovered on every page load.

OpenPendle also reads the following live:

- the common deployment helper's active market factory, yield-contract factory, router, and SY factory;
- mutable expiry, interest-fee, treasury, and swap-fee-cap parameters from the active factories; and
- each opened market's contract state and trust signals.

The [Protocol Status & Contracts](https://openpendle.com/#/status) page displays that active wiring and those mutable parameters for every supported chain. It is a live status view, not a complete historical contract registry.

The bundled factory lineage serves more than one purpose: catalog generation, PT/YT-to-market matching, duplicate checks during deployment, and provenance validation. A provenance pass means a recognized Pendle factory created the market; it does not endorse the asset or SY.

Chain-specific bundled fields include:

- `RouterStatic`, used for read-only quotes and position helpers;
- the PENDLE token and wrapped-native token;
- governance and treasury reference addresses; and
- each recognized market factory paired with its yield-contract factory.

These values are selected by chain ID. The release never reuses Arbitrum's chain-specific addresses on another network.

### Factory lineage bundled with this release

| Network | Recognized generations |
| --- | --- |
| Ethereum | v1, V3, V4, V5, V6 |
| BNB Smart Chain | v1, V3, V4, V5, V6 |
| Arbitrum | v1, V3, V4, V5, V6 |
| Base | V5, V6 |
| Plasma | V5, V6 |
| Monad | V6 |

Factory addresses can change or new generations can be introduced. The app and catalog must be updated when the recognized lineage changes; the status page alone does not add a new generation to a previously built release.

## RPC behavior

OpenPendle uses public RPCs for chain reads, quotes, provenance checks, simulations, and receipt polling. Each chain has keyless defaults wrapped in a viem `fallback()` transport, so a failed primary can roll over to a backup.

### Bundled public defaults

| Chain | Primary | Backup |
| --- | --- | --- |
| Ethereum | `ethereum-rpc.publicnode.com` | `cloudflare-eth.com` |
| BNB Smart Chain | `bsc-rpc.publicnode.com` | `bsc-dataseed.bnbchain.org` |
| Monad | `rpc.monad.xyz` | `monad.drpc.org` |
| Base | `base.publicnode.com` | `mainnet.base.org` |
| Plasma | `plasma.drpc.org` | `rpc.plasma.to` |
| Arbitrum | `arb1.arbitrum.io/rpc` | `arbitrum-one-rpc.publicnode.com` |

These are convenience defaults, not endorsements or availability guarantees. Providers can rate-limit, log, censor, or return stale data. The effective list is fixed when the app starts.

You can replace those defaults for one chain in **RPC settings**. The override is stored locally under:

```
openpendle.rpc.<chainId>
```

For example, Arbitrum uses `openpendle.rpc.42161`. The older `openpendle.rpc` key remains an Arbitrum-only fallback. Saving an override reloads the app because transports are created at startup. On an HTTPS deployment, the override must also use HTTPS.

An invalid override is not saved. Clearing the per-chain field restores the bundled fallback pair for that chain without changing the other five networks.

### Reads and transaction submission are separate

The custom OpenPendle RPC affects app reads and simulations. It does **not** reconfigure an injected wallet. When you approve or execute an on-chain action, OpenPendle sends the transaction request to the wallet; the wallet broadcasts through its own configured provider. OpenPendle's public client then follows the result.

Both providers matter:

- A bad **app RPC** can return stale or misleading reads or simulations.
- A bad **wallet RPC** can delay, reject, or misroute transaction submission.

Use providers you trust and verify the chain shown in the wallet before signing.

## Market URLs and active-chain behavior

Market and token routes include `?chain=<id>`. The app waits until the route's read client matches that chain before querying the address. This avoids briefly loading an address against a previous/default network.

The selected OpenPendle chain and the wallet chain can differ during wallet-less browsing. A wrong-network banner blocks signing and offers a switch. Rejecting that switch does not prevent reads on the selected OpenPendle chain.

Creation routes do not infer a target chain from an asset address. They use the active OpenPendle chain, so verify both the selector and wallet prompt before deploying.

## What else the browser contacts

The RPC is not the only network dependency. The stock interface also contacts its same-origin catalog and looping entry policy, Pendle APIs, Morpho for Looping discovery, supported Blockscout endpoints, DefiLlama/CoinGecko, Merkl on Positions, and Cloudflare Web Analytics. Pendle's hosted APIs supply looping routes and the off-chain limit-order path.

The canonical trigger-and-data disclosure is under [Outbound requests](/reference/architecture#outbound-requests).

## Verify independently

- Compare shared addresses above with Pendle's public [`pendle-core-v2-public`](https://github.com/pendle-finance/pendle-core-v2-public) repository and the relevant block explorer.
- Use [Protocol Status](https://openpendle.com/#/status) for active helper wiring and mutable fee/treasury parameters.
- Inspect the repository's chain address book for the exact bundled lineage used by a particular release.

For mutable values, record the chain and block when verifying. For bundled addresses, record the OpenPendle commit or release. That distinction makes later drift explainable rather than treating documentation as timeless state.

Addresses prove contract identity, not safety. Read [Risks & disclosures](/reference/risks) before interacting with a community market.
