# OpenPendle

**An open-source, backend-free interface for Pendle V2 community pools — across six networks.**

Pendle's contracts are permissionless: anyone can deploy an SY adapter, create a PT/YT pair and an AMM market, and trade it. But Pendle's own app only lists team-curated pools. OpenPendle is the missing UI for everything else — paste any market address and interact with it, on any chain Pendle is deployed to.

**OpenPendle is a gift to Pendle's community and takes no fee of its own.** It is not affiliated with, endorsed by, or operated by Pendle Finance.

## What it does

- **Load any Pendle V2 market** by pasting its address — no whitelist, no backend, no indexer; it reads straight from the chain and simulates every transaction before you sign.
- **Six networks:** Arbitrum, Ethereum, Base, BNB Chain, Plasma, Monad — switch from the header.
- **Full lifecycle:** buy/sell PT & YT, mint/redeem PT+YT, wrap/unwrap SY, add/remove/zap liquidity, and a proper redeem/exit flow for matured pools.
- **Create pools & SY adapters** from the browser via Pendle's own deployed helper contracts (zero custom contracts of our own).
- **Remember pools** locally (per-pool, per-chain) — stored only in your browser, with a dedicated saved-pools view and an undo on forget.
- **Protocol Status & Contracts** page — each chain's live Pendle wiring + fee parameters, resolved on-chain; plus a top ticker of live Pendle metrics (DefiLlama + CoinGecko).
- **Light/dark theme**, and injected-wallet connect (MetaMask, Rabby, Brave — no WalletConnect).

Approvals are exact-amount, and Pendle's own protocol fees are enforced by its contracts and flow to Pendle's treasury through any interface, including this one.

## No backend, no tracking

A static single-page app. No server, no database, no accounts, no analytics. Your remembered pools and any custom RPCs live only in your browser's local storage. The only outbound requests are to the blockchain RPCs you're pointed at and — for the header ticker — DefiLlama and CoinGecko's public stats APIs. Fonts are self-hosted; there are no third-party asset fetches.

## Security model

OpenPendle validates every loaded market against Pendle's known factories (a provenance gate) before it lets you save or transact, simulates each transaction against the chain first, and defaults to exact-amount approvals. **A factory-valid market can still wrap a malicious or exotic SY** — community pools are unreviewed by definition. Read the per-pool trust panel, and never interact with a pool unless you trust its creator and the assets underneath. The in-app **About** page spells this out.

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

OpenPendle never hardcodes Pendle's live parameters. It resolves each chain's active factories from `commonDeploy`'s on-chain immutables and reads the governance-mutable fee values from the resolved factories at runtime — all visible on the in-app Protocol Status & Contracts page. Router V4 (`0x8888…F946`), `commonDeploy`, the SY factory and the PT/YT/LP oracle share one vanity address on every chain; RouterStatic, PENDLE, the wrapped-native token and the factory generations are per-chain.

## Repository layout

| Path | What |
|---|---|
| `app/` | The frontend (Vite 8 + React 19 + TypeScript, wagmi/viem, RainbowKit, Tailwind v4) |
| `app/scripts/` | Node fork-test harnesses (per milestone) + protocol/address checks |
| `fork-tests/` | Foundry fork tests against live Pendle contracts |
| `docs/research/` | Fork-tested protocol research digest + multichain address books |
| `PLAN.md` | Architecture notes + roadmap |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: it's a static Vite app in `app/`, run on Node 22, keep `npm run build` and `npm run lint` green, and don't add a backend or any custom smart contracts — OpenPendle only ever calls Pendle's deployed contracts with hand-written ABIs.

## License

[GPL-3.0-or-later](LICENSE). OpenPendle is a copyleft public good — forks and hosted derivatives must stay open under the same license (the license Uniswap's own interface uses). The app only calls Pendle's deployed contracts with hand-written ABIs; it vendors no Pendle contract source, so Pendle's licensing doesn't extend here. All runtime dependencies are permissive (MIT).

Built by [ggmxbt](https://x.com/ggmxbt).
