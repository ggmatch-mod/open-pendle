# OpenPendle

**An open-source, static directory and interface for factory-created Pendle V2 markets — across six networks.**

Pendle's contracts are permissionless: anyone can deploy an SY adapter, create a PT/YT pair and an AMM market, and trade it. But Pendle's own app surfaces a curated subset. OpenPendle builds its directory from factory events — listed and unlisted — and shows exactly which networks the current snapshot covers. Any recognized market can still be inspected directly by address on the six supported chains.

**OpenPendle is a gift to Pendle's community and takes no fee of its own.** It is not affiliated with, endorsed by, or operated by Pendle Finance.

## What it does

- **Explore every indexed factory-created market** across all six supported networks, with source, lifecycle, and network filters plus chain-explicit links.
- **Load any Pendle V2 market** by pasting its address — no whitelist or OpenPendle backend; core market data comes straight from the chain and every transaction is simulated before you sign.
- **Six networks:** Arbitrum, Ethereum, Base, BNB Chain, Plasma, Monad — switch from the header.
- **Full lifecycle:** buy/sell PT & YT, mint/redeem PT+YT, wrap/unwrap SY, add/remove/zap liquidity, and a proper redeem/exit flow for matured pools.
- **Yield Alerts:** a wallet-free page for 24-hour market-implied-APY moves in sufficiently liquid, active Pendle-listed pools.
- **PT limit orders:** gasless order placement inside markets that Pendle's live limit-order support service approves; approvals, settlement, and cancellations use Pendle's Limit Router.
- **Create pools & SY adapters** from the browser via Pendle's own deployed helper contracts (zero custom contracts of our own).
- **Remember pools** locally (per-pool, per-chain) — stored only in your browser, with a dedicated saved-pools view and an undo on forget.
- **Protocol Status & Contracts** page — each chain's live Pendle wiring + fee parameters, resolved on-chain; plus a top ticker of live Pendle metrics (DefiLlama + CoinGecko).
- **Light/dark theme**, and injected-wallet connect (MetaMask, Rabby, Brave — no WalletConnect).

Approvals are exact-amount by default. Users can explicitly opt into unlimited approvals in transaction settings, which leaves a standing allowance and increases exposure. Pendle's own protocol fees are enforced by its contracts and flow to Pendle's treasury through any interface, including this one.

## Static app and external data

A static single-page app with no OpenPendle request-time server, database, or accounts. The hosted site loads Cloudflare Web Analytics. Explore reads a versioned static snapshot generated on a schedule from recognized Pendle factories' `CreateNewMarket` events. The same snapshot provides the primary PT/YT-to-pool mapping. Pendle's public API enriches those records, supplies Alerts history, hosts the off-chain limit-order service, and discovers a connected wallet's Official-pool market IDs for **My positions**; it does not decide which markets exist. Position balances and claims are then re-read from the relevant chains. Remembered pools and custom RPCs live only in local storage. Other outbound traffic goes to configured blockchain RPCs; DefiLlama and CoinGecko for the header ticker; Pendle's API and, where available, keyless Blockscout indexes for live lookup fallbacks; and Merkl when a connected user opens **My positions**. The Pendle position-discovery request includes the wallet address, while the Merkl reward lookup includes the wallet address and supported chain IDs. Fonts are self-hosted.

Alerts do not send a wallet address. Limit-order generation, submission, and maker-history requests send Pendle the connected wallet address plus the chain, market/YT, token, amount, target rate, expiry, and signed order. Funds are not escrowed or reserved by a signed order.

The snapshot is discovery data, not live chain state. It can lag new blocks. Initial scans fail coverage closed, while scheduled refreshes refuse to replace a complete artifact with a partial one after an RPC outage. Each chain carries its indexed block timestamp, so Explore warns when that last-known-complete snapshot becomes stale instead of silently treating missing data as an empty market universe. Opening a market still performs the normal live on-chain reads and provenance checks before any action is enabled.

## Security model

OpenPendle validates every loaded market against Pendle's known factories (a provenance gate) before it lets you save or transact, simulates each on-chain transaction first, and defaults to exact-amount approvals. PT limit orders have a separate protection path: OpenPendle validates the API-generated EIP-712 fields, domain, signer, and on-chain Limit Router hash before submission. **A factory-valid market can still wrap a malicious or exotic SY** — community pools are unreviewed by definition. Read the per-pool trust panel, and never interact with a pool unless you trust its creator and the assets underneath. The in-app **About** page spells this out.

This is experimental software for a permissionless protocol. Use at your own risk; it comes with no warranty.

## Run it locally

Requires Node 22+.

```bash
cd app
npm install
npm run dev      # http://localhost:5173
npm run build    # production build → app/dist
npm run lint
```

The app is fully client-side and static; `app/dist` deploys to any static host. Routing uses a hash router, so no server rewrite rules are needed.

## How the chain wiring works

OpenPendle never hardcodes Pendle's governance-mutable parameters. It resolves each chain's active factories from `commonDeploy`'s on-chain immutables and reads factory and AMM fee values at runtime — these are visible on the in-app Protocol Status & Contracts page. Router V4 (`0x8888…F946`) handles AMM actions; the separate Limit Router (`0x0000…4321`) handles limit-order settlement and cancellation. Those two routers, `commonDeploy`, the SY factory and the PT/YT/LP oracle share one address apiece across the supported chains; RouterStatic, PENDLE, the wrapped-native token and factory generations are per-chain.

## Repository layout

| Path | What |
|---|---|
| `app/` | The frontend (Vite 8 + React 19 + TypeScript, wagmi/viem, RainbowKit, Tailwind v4) |
| `app/scripts/` | Node fork-test harnesses, protocol/address checks, and the factory-market snapshot generator |
| `fork-tests/` | Foundry fork tests against live Pendle contracts |
| `docs/research/` | Fork-tested protocol research digest + multichain address books |
| `PLAN.md` | Architecture notes + roadmap |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: it's a static Vite app in `app/`, run on Node 22, keep `npm run build` and `npm run lint` green, and don't add a request-time backend or custom smart contracts without an explicit architecture decision. On-chain actions call Pendle's deployed contracts directly; signed limit orders first go to Pendle's hosted service and settle later through its Limit Router.

## License

[GPL-3.0-or-later](LICENSE). OpenPendle is a copyleft public good — forks and hosted derivatives must stay open under the same license (the license Uniswap's own interface uses). The app only calls Pendle's deployed contracts with hand-written ABIs; it vendors no Pendle contract source, so Pendle's licensing doesn't extend here. All runtime dependencies are permissive (MIT).

Built by [ggmxbt](https://x.com/ggmxbt).
