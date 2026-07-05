# Networks &amp; contracts

OpenPendle runs against Pendle V2's own deployed contracts — it adds none of its own. This page lists the networks and the fixed entry-point addresses. For the **live, per-chain** factory set and fee parameters, use the in-app [Protocol Status &amp; Contracts](https://openpendle.com/#/status) page, which resolves them from the chain in real time.

## Supported networks

| Network | Chain ID | Native token |
| --- | --- | --- |
| Ethereum | `1` | ETH |
| BNB Smart Chain | `56` | BNB |
| Monad | `143` | MON |
| Base | `8453` | ETH |
| Plasma | `9745` | XPL |
| Arbitrum | `42161` | ETH |

## Shared entry points

These addresses are **the same on all six networks** (deterministic deployments, verified against Pendle's `deployments/<chainId>-core.json`):

| Contract | Address | Role |
| --- | --- | --- |
| Router V4 | `0x888888888889758F76e7103c6CbF23ABbF58F946` | All trades, liquidity, and exits |
| PendleCommonPoolDeployHelperV2 | `0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9` | One-tx pool (+ optional SY) deploys |
| PendleCommonSYFactory | `0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8` | Permissionless SY-template deploys |
| PendlePYLpOracle | `0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2` | TWAP oracle for PT / YT / LP pricing |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | Batched reads (canonical deployment) |
| Pendle governance proxy | `0x2aD631F72fB16d91c4953A7f4260A97C2fE2f31e` | Default owner of wizard-deployed SYs |
| Pendle ProxyAdmin | `0xA28c08f165116587D4F3E708743B4dEe155c5E64` | Admin of Pendle's upgradeable SY proxies |

## Per-chain contracts

Some contracts are **chain-specific** — the PENDLE token, `RouterStatic`, the treasury, the governance multisig, and the **market / yield-contract factories**. The factory lineage present varies by network:

- **Ethereum &amp; Arbitrum:** the full lineage (v1, V3, V4, V5, V6)
- **BNB Smart Chain:** the full lineage (v1, V3, V4, V5, V6)
- **Base &amp; Plasma:** V5 and V6
- **Monad:** V6 only (it launched on the current generation)

Factories are **governance-mutable**, so OpenPendle never hardcodes the "active" one for routing — it **resolves the current factory live** and uses the hardcoded set only to validate a market's provenance. To see the exact live addresses for any network, open [Protocol Status &amp; Contracts](https://openpendle.com/#/status) in the app.

## RPC endpoints

Each network ships with **keyless public RPC endpoints** (e.g. PublicNode, dRPC, official gateways), wrapped in a fallback transport so a rate-limited or down endpoint automatically rolls over to a backup.

You can override the endpoint per network from the **RPC settings** in the header — useful if the public ones throttle you. Your override is stored **only in your browser** and replaces the defaults for that one network. See [Browsing &amp; doing actions](/using-openpendle#custom-rpc).

## Verifying for yourself

Every address above is checksummed and lifted directly from Pendle's public deployment files. Because OpenPendle ships no contracts of its own, you can cross-check all of them on each network's block explorer, or against `pendle-finance/pendle-core-v2-public`.
