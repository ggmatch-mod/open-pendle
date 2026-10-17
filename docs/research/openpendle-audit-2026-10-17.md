# OpenPendle audit and release review

Checked 17 October 2026, Asia/Tokyo. Covers the local release candidate, the public deployment, current official Pendle manifests and APIs, dependencies, and local mainnet-fork behavior. Existing Portfolio OS, Action Center, and Boros work is included.

This record supersedes the initial findings from earlier on the same date. It is an application and integration review, not a formal audit of every Pendle contract or underlying SY asset. All state-changing tests used disposable local forks. No real wallet signatures, funded actions, main-branch merge, or production deployment were performed.

## Release scope

- New Market and Mint entry: exactly Ethereum **PT-reUSD / USDC** and Monad **PT-USDat / USDC**.
- Arbitrum and matured Monad AUSD: existing-position management, reductions, exit, and direct recovery remain available. No new Arbitrum entry is authorized.
- Mint leverage increases remain disabled in the production policy.
- Runtime policies use strict v2 schemas and **have no expiration date**. Policy retrieval, exact market scope, code pins, market maturity, quote/signature deadlines, liquidity checks, and simulation remain enforced.
- Portfolio OS and Action Center are review-first, read-only discovery and monitoring surfaces. The Boros hedge preview remains a separate read-only prototype.

## Blockers resolved

| Area | Initial failure | Release change |
| --- | --- | --- |
| Catalog indexing | Ethereum and Base archive-log restrictions prevented complete scheduled refreshes. | Ethereum Blockscout cursor logs and historical headers; verified keyless historical RPC fallback; adaptive log windows, bounded backoff and request pacing. Reorg anchors must be readable and match before incremental reuse. |
| Catalog publishing | Failed refreshes accumulated while the September snapshot stayed public. | Complete six-chain coverage plus a 48-hour freshness check; bounded retries preserve checkpoints; branch artifacts support review; only main publishes with rebase/push retries. Recovery evidence is recorded below. |
| PendleSwap drift | All three proxy implementation pins rejected the upgraded implementation. | Source review, exact compiler reproduction on Ethereum/Arbitrum/Monad, storage-layout comparison, renewed implementation hashes, and additional Kyber helper proxy/implementation pins. |
| Obsolete looping fixtures | Arbitrum and the previous Monad canary matured. | New Monad USDat fixture; active Ethereum/Monad lifecycle proofs; a genuine current Arbitrum borrower proves matured exit and recovery. |
| Policy expiry | Old runtime policies paused entry after a date. | Non-expiring v2 policies; strict schema migration; disabled v1 compatibility files; year-2100, disabled-policy, fetch/body timeout, and invalid-schema regressions. |
| Missing SY rates | A fabricated fallback rate could distort displays and trade-size caps. | Explicit unavailable rate state; suppress derived TVL, PT-in-SY, approximate conversions and caps until valid data exists; preserve legitimate redemption access. |
| Dependencies | App/docs had high-severity audit findings; old Actions used deprecated runtimes. | Compatible lockfile updates, targeted ws/uuid overrides, patched documentation Vite/KaTeX, current checkout/setup/github-script Actions, and audit gates in CI. |
| Clean installs | npm 10 rejected a lockfile generated under npm 11 because an optional Coinbase/Solana TypeScript peer was absent. | Generate the missing nested TypeScript 5.9.3 peer with Node 22.23.3/npm 10.9.9; a fresh default `npm ci` passes without changing the root TypeScript 6 compiler or bypassing peers. |

The upgraded PendleSwap implementation is `0xD14feb6Aaf8650BbfcC8aBEc299B249a80FE7C78`. The reviewed change adds a ZEROX route and removes ODOS scaling. OpenPendle continues accepting only its reviewed Kyber route; regressions reject ZEROX and retired ODOS calldata. Chain-specific immutable values explain the different runtime hashes. [Review, compiler settings, source digests, runtime hashes, and fork evidence](pendleswap-upgrade-2026-10-17/review.json). [Read-only reproduction script](../../app/scripts/reproduce-pendleswap-upgrade.mjs).

## Application fixes included

| Area | Result |
| --- | --- |
| Portfolio valuation | Apply raw SY exchange rates before accounting-token decimal formatting; unavailable rates leave LP values unpriced. Only PT holdings satisfy PT allocation targets. |
| Action Center coverage | Partial discovery, failed reads and uncovered APY targets produce coverage warnings. Foreground polling refreshes wallet discovery and balances each minute and portfolio prices every five minutes; minute ticks also advance maturity, expiry, staleness and receipt checks. |
| Local journal privacy | Store fixed transaction categories and generic approval labels instead of amount-bearing descriptions. Normalize older descriptions on read and remove them on the next write. |
| Market lookup | Bound request and JSON-body time, page count and repeated pages; preserve factory fallbacks and direct-address access. |
| Pool/SY deployment | Validate event emitters and require combined deployment events to agree on the SY address. Unknown fee-on-transfer or rebasing verdicts cannot pass the clean screen. |
| Boros discovery and economics | Paginate markets safely; tolerate absent optional AMM IDs; refresh simulations; show source/quote age; require fresh timestamps for every required main/subaccount exposure source; retain unknown fees instead of substituting zero. |
| Fork safety | Disposable EOA per run, occupied-port rejection and exact source block number/hash verification before any local fixture mutation. |
| Documentation | Correct raw SY accounting formulas, render diagrams correctly in development and production, and document durable policies and outbound requests. |

The accounting defect was verified on live Ethereum at block **26212515**: reUSD SY `0x9487bd5a3b16ecb5f3184453e3ee75b800141648` has 18 SY decimals, a 6-decimal USDC accounting asset, and raw exchange rate `1107620`. One SY represents **1.10762 USDC**. The old helper produced `1.10762e-12` for that leg. Missing-rate injection now preserves verified snapshots while hiding unavailable conversions.

## Validation

| Check | Result |
| --- | --- |
| Frontend TypeScript, production build, lint and whitespace | Pass. Production release flags are tested for the canonical main deployment; preview builds retain disabled entry flags. |
| Documentation build and browser rendering | Pass, including Mermaid diagrams and plain rendered accounting formulas. |
| Existing 23 application `check:*` commands | All pass, including the previously failing runtime policies. Fresh catalog and fork-harness safety checks are additional release gates. |
| Core Foundry fork suite | **21/21 pass**, no failures or skips. |
| Independent looping Foundry suites | **7/7 Ethereum and 7/7 Monad pass**. |
| Production compiler: Market and Mint | **All four Ethereum/Monad lifecycles pass**: signed entry, increase, partial decrease, full exit, direct rescue, post-expiry redemption, and Mint PT/YT delivery. |
| Arbitrum matured borrower | Genuine EOA position at source block **515689396**; compiled exit and independent four-step recovery pass with supply conservation, exact debt/collateral cleanup, dust and permission checks. |
| PendleSwap reproduction | Exact runtime reproduction on all three chains using solc `0.8.30+commit.73712a01`, viaIR, Cancun, 1,000,000 optimizer runs and declared immutable substitutions. |
| Dependency audits | App: **0 high/critical**, 16 moderate propagated nodes from one remaining advisory family. Docs: **0 findings**. |
| Browser smoke | Home, disconnected portfolio, allocation preview, Action Center, wallet-free movers, Boros disconnected preview, Explore diagnostics and mobile navigation inspected. |

The Arbitrum proof impersonates a real position owner only inside Anvil and preauthorizes the production core action bundle because the owner's real signature is unavailable. It is an actual balance/debt/collateral proof, not a signed-authorization-wrapper proof. Ethereum and Monad lifecycle tests cover that signed wrapper independently. The source block hash is checked before fixture mutations and adapter/bundler balances start at zero. [Arbitrum proof summary](pendleswap-upgrade-2026-10-17/arbitrum-maturity-fork.json). Raw logs contain public addresses and local test state only.

## Catalog recovery evidence

Recovery and incremental workflow validation are in progress on the release branch. A branch run cannot publish to main; the release must include the validated complete fresh artifact before it is ready to merge.

## Remaining limits

- **Kyber helper source:** current helper implementations are source-unverified on the explorers. Their exact binaries, implementation slots and addresses are pinned, and concrete routes pass fork tests. That establishes observed code identity and tested behavior, not a complete helper source review.
- **Legacy wallet dependency:** 16 moderate audit entries propagate from `decode-uri-component` through older WalletConnect dependencies. OpenPendle uses injected wallets. Forcing the patched ESM package into a CommonJS dependency would break compatibility; RainbowKit's current peer range also prevents an unreviewed wagmi 3 migration. No high or critical findings remain.
- **Boros:** live API access from this environment returned HTTP 403. Schema compatibility was checked against the official published SDK and fixtures; actual account margin, positions/orders, entry fees, gas, collateral basis and executable depth remain outside the prototype. It cannot execute a hedge.
- **Performance:** the primary frontend bundle remains large. Route/surface splitting is a useful follow-up with measured load-time evidence.
- **External state:** live contract upgrades, liquidity, maturity and provider availability can still disable a route after this review. Non-expiring policy authorization does not override these live checks.

## Pendle compatibility and next features

Configured core addresses and factory generations on all six chains matched the current [official deployment manifests](https://github.com/pendle-finance/pendle-core-v2-public/tree/main/deployments). Address agreement does not replace implementation checks. Existing `/core/v2/markets/all`, v3 history and v3 convert integrations remain appropriate; [Pendle's API documentation](https://docs.pendle.finance/pendle-v2-dev/Backend/ApiOverview) does not require a blanket migration.

| Priority | Feature | Useful scope |
| --- | --- | --- |
| 1 | Combined operational health | Catalog age/coverage, policy availability/scope and implementation drift in one review surface. |
| 2 | Maturity rollover planner | Compare exit and successor PT/LP quotes with full approval, recipient, fees and minimum-output validation; require user review. |
| 2 | APY and fee history | Reuse v3 history, label incentives and missing observations. |
| 2 | Limit-order incentives | Show qualification and accrued rewards without treating estimated rewards as guaranteed returns. |
| 2 | sPENDLE portfolio view | Read balances, rewards, cooldown and current fee parameters; add review reminders. |
| 3 | Account-aware Boros hedging | Model all committed capital, positions, orders, fees, margin and full executable depth before adding execution. |
| 3 | Additional networks | Add factory indexing, RPC, quote, wallet and fork validation per chain before exposing trading. |

The code is prepared for review and release through a pull request. Merging and deploying to production remain separate actions; no live funds were used for validation.
