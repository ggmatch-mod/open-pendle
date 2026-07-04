# OpenPendle

**An open-source, backend-free interface for Pendle V2 Community Pools on Arbitrum.**

Pendle's contracts are permissionless — anyone can deploy an SY adapter, create a PT/YT pair and an AMM market, and trade it. But the official app only shows team-whitelisted pools. OpenPendle is the missing UI for everything else:

- **Load any Pendle market** by pasting its address — no whitelist, no backend, no indexer.
- **Remember pools** locally (per-pool checkbox, persisted in your browser).
- **Full lifecycle:** buy/sell PT and YT, mint/redeem PT+YT, wrap/unwrap SY, add/remove/zap liquidity.
- **Matured pools** get a proper redeem/exit interface.
- **Create pools & SY adapters** from the browser via Pendle's own deployed helpers.

Pendle's protocol fees are enforced in the contracts themselves and flow to Pendle's treasury automatically through any interface, including this one.

## Status

Pre-release — under active development. See [PLAN.md](PLAN.md) for the roadmap, [docs/research/](docs/research/) for the fork-tested protocol research this project is grounded in.

## Repository layout

| Path | What |
|---|---|
| `app/` | The frontend (Vite + React + TS, wagmi/viem, RainbowKit) |
| `fork-tests/` | Foundry fork tests against live Arbitrum Pendle contracts |
| `docs/research/` | Protocol research digest + plan critique |
| `research/fork-tests/` | Original research-phase fork-test artifacts |

## Security model (summary)

OpenPendle validates pasted markets against Pendle's factories, simulates every transaction before you sign, and defaults to exact-amount approvals. **A factory-valid market can still wrap a malicious SY** — community pools are unreviewed by definition. Read the per-pool trust panel and trade at your own risk.

## License

[GPL-3.0-or-later](LICENSE). OpenPendle is a copyleft public good — forks and hosted derivatives must stay open under the same license (the same license Uniswap's own interface uses). The app only calls Pendle's deployed contracts and hand-written ABIs; it does not vendor Pendle's contract source, so their licensing does not extend here. All runtime dependencies are permissive (MIT).
