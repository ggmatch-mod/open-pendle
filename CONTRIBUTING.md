# Contributing to OpenPendle

Thanks for your interest. OpenPendle is a static, backend-free interface to Pendle V2's permissionless community pools, released under GPL-3.0-or-later.

## Ground rules

- **No backend.** OpenPendle is a static SPA and stays that way — no server, database, or hosted API of our own.
- **No custom smart contracts.** The app only calls Pendle's already-deployed contracts with hand-written ABIs. Anything that would require deploying our own contract is out of scope.
- **No new tracking by default.** The hosted site currently uses Cloudflare Web Analytics. Do not add another tracker, remote asset, or third-party script without explicit approval and a matching privacy disclosure (fonts stay self-hosted).
- **Read live from the chain.** Don't hardcode governance-mutable values (fees, factory addresses) — resolve them at runtime, as the existing code does.

## Development

Requires Node 22+.

```bash
cd app
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build → app/dist
npm run lint     # oxlint
```

Before opening a PR, make sure `npm run build` and `npm run lint` are both green.

## Fork tests

Changes that touch reads, quoting, or the transaction pipeline should be exercised against a mainnet fork. See `app/scripts/` (Node harnesses, one per milestone, each spins up its own anvil) and `fork-tests/` (Foundry). Don't trust a tx-pipeline change without a fork run.

## Security

Found a security issue? Please report it privately rather than opening a public issue — reach out via [x.com/ggmxbt](https://x.com/ggmxbt). Note that a factory-valid market wrapping a malicious or exotic SY is a **known, disclosed residual risk** (see the in-app About page), not a bug.

## License

By contributing, you agree your contributions are licensed under GPL-3.0-or-later.
