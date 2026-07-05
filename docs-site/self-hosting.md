# Self-hosting

OpenPendle is a static site with **hash-based routing** and **no backend**, so it runs anywhere you can serve files — a static host, your own box, or IPFS — with no server, no database, and no rewrite rules. Hosting your own copy is the strongest guarantee that the interface can't be changed out from under you.

## Prerequisites

- **Node 22** (pinned via `.node-version`)
- A package manager (`npm` ships with Node)

## Build it

```sh
git clone https://github.com/ggmatch-mod/open-pendle.git
cd open-pendle/app
npm install
npm run dev      # local dev server with hot reload
npm run build    # production build → app/dist
```

The production build is a plain static bundle in `app/dist`. Serve that folder with anything.

## Deploy it

**Cloudflare Pages** (what openpendle.com uses):

- Framework preset: **None**
- Root directory: **`app`**
- Build command: **`npm run build`**
- Build output directory: **`dist`**
- Node version: pinned by the committed `.node-version` (22)

**Any static host** (Netlify, GitHub Pages, S3/CloudFront, nginx…): serve `app/dist`. Because routing is hash-based (`/#/...`), you **don't** need SPA rewrite rules.

**IPFS:** the same `app/dist` pins cleanly and works from any gateway — no absolute paths, no server routes. Point a DNSLink at the pin for a stable name.

## Why it's safe to self-host

- **Strict CSP.** `script-src 'self' 'wasm-unsafe-eval'` — no `eval()`, no `Function`, no `'unsafe-eval'`. WebAssembly instantiation is allowed (for crypto), but no remote script can be pulled or run.
- **Self-hosted fonts.** Fonts are bundled; there are **zero** external font requests.
- **Injected-only wallets.** No WalletConnect relay, no third-party wallet service.
- **No backend to trust.** All state is read from public RPC; the only other outbound calls are the optional DefiLlama / CoinGecko ticker stats.

## License &amp; contributing

OpenPendle is **GPL-3.0-or-later** and ships **no smart contracts of its own** — it calls Pendle's deployed contracts with hand-written ABIs. Contributions are welcome; see [`CONTRIBUTING.md`](https://github.com/ggmatch-mod/open-pendle/blob/main/CONTRIBUTING.md) in the repo.

These docs are a separate VitePress project in [`docs-site/`](https://github.com/ggmatch-mod/open-pendle/tree/main/docs-site) — `npm install` then `npm run docs:dev` there to work on them.
