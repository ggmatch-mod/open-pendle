# Self-hosting

OpenPendle builds to a static folder. There is no OpenPendle application server, account database, or transaction relay to operate. A self-hosted copy still makes the RPC and feature-API requests documented in [Architecture](/reference/architecture#outbound-requests).

Self-hosting lets you inspect and choose the exact source and deployment you serve. It does not review community pools, remove wallet/RPC risk, or make external APIs available offline.

## Requirements

- Node.js 22, pinned by the repository's `.node-version` files
- npm
- Git, or a source archive

## Build and preview

```sh
git clone https://github.com/ggmatch-mod/open-pendle.git
cd open-pendle/app
npm ci
npm run build
npm run preview
```

`npm run build` runs TypeScript checks and Vite, then writes the deployable app to `app/dist`. The folder includes the bundled factory-market snapshot, hashed assets, fonts, startup recovery script, security-header file, and static metadata.

The committed snapshot makes an ordinary build usable without API keys. It gradually becomes stale unless you update it.

## Refresh the market catalog

To maintain Explore independently of upstream releases:

```sh
cd open-pendle/app
npm run index:factory-markets
npm run check:factory-markets:complete
npm run build
```

The generator scans the recognized factory lineage and writes `public/catalog/factory-markets.v1.json`. Reliable historical scans require archive/log-capable sources. It accepts:

- `ETHEREUM_RPC_URL`
- `BSC_RPC_URL`
- `MONAD_RPC_URL`
- `BASE_RPC_URL`
- `PLASMA_RPC_URL`
- `ARBITRUM_RPC_URL`
- an Etherscan-compatible `<NETWORK>_LOG_API_URL` where appropriate

Provider URLs can contain credentials; store them in the scheduler's secret configuration, not the repository. Inspect completeness, errors, quarantined logs, and indexed-through metadata before publishing. The upstream workflow keeps the last-known-complete artifact when a refresh is partial.

Without a refresh, users can still load a recognized market directly by address, but new markets may be absent from Explore and PT/YT mapping until the next snapshot.

## Asset paths and routing

OpenPendle uses HashRouter, so routes live after `#`. Static hosts therefore do not need “rewrite every path to `index.html`” rules.

Routing and asset paths are separate concerns. The default Vite build uses root-relative URLs such as `/assets-v2/...`, `/fonts/...`, and `/catalog/...`.

- **Domain root:** deploy `dist` unchanged.
- **Subpath:** set Vite's [`base`](https://vite.dev/config/shared-options.html#base) to that subpath and rebuild.
- **IPFS:** use DNSLink or another gateway arrangement that serves the CID as the site's root, or rebuild with a base that matches the gateway path. A raw `/ipfs/<CID>/` URL is not guaranteed to work with the unmodified root-relative build.

## Deployment options

### Cloudflare Pages

The hosted app uses Cloudflare Pages with:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Root directory | `app` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node | 22 |

The committed `public/_headers` file is copied into `dist` and is interpreted by Cloudflare Pages. It sets no-cache behavior for HTML/startup recovery, long-lived caching for hashed assets, and the production security headers.

### Other static hosts

Build and serve `app/dist` over HTTPS. Wallet injection generally requires a secure browser context. Hash routing needs no SPA fallback.

Not every host understands Cloudflare's `_headers` syntax. Reproduce its headers in your host configuration, especially:

- Content-Security-Policy
- `X-Content-Type-Options`
- `Referrer-Policy`
- frame restrictions
- `Permissions-Policy`
- HSTS, when appropriate for your domain
- cache rules that keep HTML fresh and hashed assets immutable

If you remove Cloudflare Web Analytics from `index.html`, also remove its script source from the CSP. If you keep it, the self-hosted copy will send the same page-view/performance beacon as the stock build.

### IPFS with DNSLink

```sh
cd open-pendle/app
npm run build
ipfs add -r dist
```

Pin the resulting CID, then point DNSLink at it:

```
_dnslink.openpendle.example. TXT "dnslink=/ipfs/<CID>"
```

DNSLink gives the build a domain-root path and a stable name that can later point to a new CID. Content addressing proves the bytes associated with a CID; availability still depends on at least one surviving pin and reachable gateway.

## Security checklist

A self-hosted build retains code-level behavior such as injected-wallet connection, transaction simulation, exact approvals by default, local saved pools, and self-hosted fonts. Hosting configuration still matters.

Before publishing:

1. Build from the intended commit with the committed lockfile (`npm ci`).
2. Run the frontend checks used by CI, or at minimum `npm run lint` and `npm run build`.
3. Confirm the catalog is complete or intentionally retain a known snapshot.
4. Serve over HTTPS.
5. Apply the headers from `public/_headers` in the host's native format.
6. Verify the CSP and cache headers from the deployed URL.
7. Open a market, run a read-only quote, and confirm the expected chain/RPC.
8. If testing writes, use a burner and a minimal amount first.

::: warning Interface integrity is not pool safety
A reproducible deployment can establish which frontend code you served. It cannot vouch for a market's asset, SY, adapter, owner, liquidity, or future behavior. Read [Risks & disclosures](/reference/risks).
:::

## External dependencies remain

The stock build can contact:

- configured app RPCs for ordinary reads, simulations, and receipt polling;
- the injected wallet's provider for Looping safety reads, unsigned simulation, and signed transaction submission;
- the same-origin market snapshot, base Looping entry policy, and separate Mint policy;
- Pendle APIs for enrichment, alerts, Looping routes, limit orders, and connected-wallet Official-position discovery;
- Morpho for Looping discovery and public market state;
- supported Blockscout APIs for bounded lookup fallback;
- DefiLlama and CoinGecko for aggregate ticker data;
- Merkl when a connected user opens Positions; and
- Cloudflare Web Analytics unless removed.

Official-position discovery sends the connected wallet address to Pendle to find relevant Official-pool market IDs; balances and claims are then re-read through the relevant chain RPCs. Merkl receives the wallet address and supported chain IDs to return claimable rewards and proofs. Pendle Looping-route requests include market and token identifiers, amounts, the reviewed adapter receiver, and slippage, but no wallet signature.

Disabling a UI feature can remove its ancillary call, but review the code and CSP rather than assuming self-hosting removes it. See the canonical [outbound-request table](/reference/architecture#outbound-requests).

## Looping execution controls

Self-hosting does not automatically enable executable Looping. New entry and leverage increases require all of the following:

- the build-time `VITE_LOOPING_EXECUTION_BETA_ENABLED` flag;
- an exact market in the reviewed execution registry;
- a fresh, enabled, same-origin `app/public/looping-execution-policy.v1.json` entry for that chain and Morpho market ID; and
- live contract, route, position, risk, and unsigned-simulation checks.

Mint entry and Mint leverage increases require all of those controls plus `VITE_LOOPING_MINT_BETA_ENABLED=true` and the matching capability in `app/public/looping-mint-execution-policy.v1.json`. Both policies are fetched without cache and fail closed on redirects, the wrong content type, invalid structure, expiry, excessive validity, or an unlisted market.

OpenPendle's main Cloudflare deployment enables Market entry and exit with a time-bounded base policy, but currently forces Mint execution off and ships the Mint policy disabled. Cloudflare previews force all looping write flags off. Self-hosted builds remain disabled by default. Renew or disable an enabled policy before its seven-day limit, and serve both JSON files with the headers in `public/_headers`.

For loopback Vite testing only, enable both the base and Mint entry build flags, then choose either `OPENPENDLE_LOCAL_MINT_POLICY_ALL=true` or `OPENPENDLE_LOCAL_MINT_POLICY_MARKET=<chainId>:<Morpho market id>`. The dev server then serves a one-hour Mint policy for the selected scope; the reviewed registry still blocks unreviewed markets. These two local-policy variables are mutually exclusive and production builds ignore them; the base entry policy must still be fresh and cover the market.

Leverage decreases and full exit use the separate `VITE_LOOPING_EXIT_BETA_ENABLED` build flag. Recovery is independent of the entry policy, so pausing new risk does not by itself remove permission cleanup or direct rescue.

Browser Looping reads and unsigned simulations use the connected wallet's selected-chain RPC through a read-only method allowlist; the wallet broadcasts the final signed transaction through that same provider. A self-hoster's general app RPC override does not reconfigure the wallet provider. Never put private keys or RPC secrets in a `VITE_*` variable because those values are public in the browser bundle.

## What OpenPendle ships

OpenPendle is licensed `GPL-3.0-or-later`. It ships no OpenPendle-authored smart contract. Its Create flows can invoke Pendle factories to deploy Pendle SY and market contracts, and its reward claim can invoke Merkl's distributor, but there is no OpenPendle contract to deploy or administer.

## Documentation site

The documentation site is a separate VitePress project:

```sh
cd open-pendle/docs-site
npm ci
npm run docs:build
```

Security reports: [x.com/ggmxbt](https://x.com/ggmxbt) and `/.well-known/security.txt` on the app.
