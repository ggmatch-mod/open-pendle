# OpenPendle — Project Plan

**Status:** v1.0 — 2026-07-03. Grounded in a multi-agent research pass (fork-tested against live Arbitrum contracts) and revised through a 4-lens adversarial critique ([docs/research/plan-critique.md](docs/research/plan-critique.md)).
**Scope:** Arbitrum One (chain id 42161) only, for v1.

---

## 1. Vision

OpenPendle is an open-source web interface for Pendle V2 **Community Pools** — the permissionless side of Pendle that the official app deliberately curates away. Pendle's contracts let anyone deploy an SY adapter, create a PT/YT pair and an AMM market, and trade it; but app.pendle.finance only shows pools its team has manually whitelisted, and its pool-creation flow is a hardhat repo plus a listing portal, not a UI.

OpenPendle fills exactly that gap:

1. **Create pools from the browser** — the same one-transaction deploy path Pendle's own tooling uses.
2. **One-click SY adapters** — deploy audited Pendle SY templates for any ERC-20 / ERC-4626 asset.
3. **Load any market by pasting its address** — no backend, no whitelist, no waiting for indexing.
4. **Full market lifecycle** — buy/sell PT and YT, mint/redeem PT+YT, wrap/unwrap SY, add/remove/zap liquidity.
5. **Maturity handling** — expired pools get a proper redeem/exit interface instead of raw Arbiscan calls.

**Principles:**

- **Backend-free.** Everything reads from the chain. No OpenPendle server, no database, no dependency on Pendle's API (which does not index permissionless pools anyway). The app is a static site, hostable on Vercel/Cloudflare/IPFS.
- **Canonical contracts only.** All transactions go through Pendle's deployed factories and Router V4. This means Pendle's protocol fees (80% of swap fees, 5% of YT interest/rewards, post-expiry residuals) flow to Pendle's treasury automatically — it is enforced in the contracts and cannot be bypassed, so requirement #7 ("respect Pendle's fees") is satisfied by construction.
- **Zero custom smart contracts in v1.** Research confirmed Pendle already ships everything on-chain (see §2). Not writing contracts removes the audit burden and most of the security risk.
- **User safety over feature count.** Pasted addresses are untrusted input; every transaction is simulated before the user signs; scam/broken-token classes (fee-on-transfer, rebasing) are screened in the creation wizard.

---

## 2. Fact base (what research established)

A multi-agent research pass on 2026-07-03 verified the current state of Pendle V2 on Arbitrum against primary sources (contract source, live `eth_call`s, event history, and **fork tests that executed every core flow end-to-end**). Full findings with sources: [docs/research/pendle-v2-research.md](docs/research/pendle-v2-research.md). Fork-test proofs: [research/fork-tests/](research/fork-tests/).

The load-bearing facts:

| # | Fact | Confidence |
|---|------|------------|
| F1 | Market + yield-contract creation is fully permissionless. No SY allowlist anywhere on-chain. | Verified in source + live calls |
| F2 | **Router V4 (`0x8888...F946`) has no market allowlist.** A market created on a fork with a mock SY (never seen by Pendle) traded end-to-end through the live router: swaps, zaps, liquidity, exits. | Fork-test executed |
| F3 | Pendle's treasury received fees from that never-whitelisted market automatically. Swap fees (80% reserve), YT interest/reward fees (5%), and post-expiry residuals are contract-enforced. A frontend cannot redirect them even deliberately. | Fork-test executed |
| F4 | **`PendleCommonPoolDeployHelperV2` (`commonDeploy`, `0x2Ed4...8aA9`)** is the entry point Pendle's own community flow uses (22 of the last 23 market creations on Arbitrum went through it). One tx: optional SY deploy → PT/YT → market → seed liquidity. Takes user-friendly `PoolConfig {expiry, rateMin, rateMax, desiredImpliedRate, fee}` and computes `scalarRoot`/`initialAnchor` internally. | Event history + live calls |
| F5 | **`PendleCommonSYFactory` (`syFactory`, `0x466C...1CF8`)** permissionlessly deploys Pendle-audited SY templates. All 7 registered template ids fork-tested working (3 basic via `deploySY`, 4 upgradeable/adapter via `deployUpgradableSY`). | Fork-test executed (16/16) |
| F6 | All display data is computable client-side: `market.readTokens()/readState(router)`, SY previews, implied APY = `e^(lastLnImpliedRate/1e18) − 1`, PT/YT prices, TVL. Default `ApproxParams(0, max, 0, 256, 1e14)` routes fully on-chain with no backend. **M0 parity suite settled the RouterStatic question**: its quote statics track real Router V4 execution within ~50 ppm on both a fee-discounted listed market and a fresh community market — it quotes in the *discounted per-router* fee context. The repo's `*AndGenerateApproxParams` helpers do **not** exist on the deployed diamond; ApproxParams are synthesized client-side (`guessOffchain` = static quote), fork-verified in every direction. See `fork-tests/PARITY.md`. | Fork-test executed (M0 parity suite, block 480027000) |
| F7 | Five market-factory generations coexist on Arbitrum (146 markets total). One universal read ABI covers all of them; `isValidMarket(address)` OR-ed across the 5 factories is a safe paste-validation (returns false, never reverts, on junk). | Live calls on all 5 |
| F8 | Post-expiry: swaps/mints revert (`MarketExpired`), `burn`/remove-liquidity always works, PT redeems 1:1 to accounting asset without YT, YT accrual freezes but residuals stay claimable forever, `exitPostExpToToken/Sy` gives one-click exits. No keeper needed. | Fork-test executed |
| F9 | Legacy edge cases: 7 old markets are whitelisted on `ExpiredLpPtRedeemer` (`0x2356...D446`) because their YT is drained (normal redeem reverts); 9 markets (7 GLP v1 + 2 V5) are **hard-stuck at protocol level** (even LP transfers revert) — no frontend can fix them, only disclose. | Fork-test + 146-market scan |
| F10 | Quote-accuracy gotcha: fees are per-(router, market). Pendle governance sets ~4–10× discounted fees for Router V4 on *listed* markets; fresh community markets pay their creator-chosen fee. Always call `readState(<actual router>)`, never hardcode, and quote through the router you execute through. | Live calls |
| F11 | Direct `swapExactPtForYt`/`swapExactYtForPt` were **removed from the router** (Dec 2024). PT↔YT requires two-step composition; the router's `multicall` preserves `msg.sender` for bundling. | Selector-map dump + fork test |
| F12 | Governance-mutable values (`expiryDivisor` = 86400, fee rates, treasury, factory implementations — several contracts are upgradeable proxies) must be **read live at runtime**, never hardcoded. Factory addresses should be resolved from `commonDeploy`'s public immutables. | Live calls |

**What this means for scope:** the original idea assumed we might need to build an SY-factory contract. We don't — macro feature 2 becomes pure UI over `syFactory`/`commonDeploy`. OpenPendle v1 is a frontend-only project.

**Scope clarification (user direction, 2026-07-03):** OpenPendle is for **custom community pools** — current-generation markets people create and share by address. It does not aim to re-serve Pendle's historical listed markets. Legacy vintages (v1–V5) still load best-effort (same read ABI, F7, and the 5-factory validation gate stays because it's the security check), but legacy-specific rescue flows (`ExpiredLpPtRedeemer` routing, the 9 hard-stuck markets) are non-goals — see §7.

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  OpenPendle SPA (static site)                              │
│                                                            │
│  UI (React + Tailwind)                                     │
│   ├─ Pool Registry (localStorage)   ← remember/forget      │
│   ├─ Pool View (trade / mint / LP / maturity tabs)         │
│   ├─ Create Pool wizard                                    │
│   └─ Create SY wizard                                      │
│                                                            │
│  Data layer (wagmi + viem + TanStack Query)                │
│   ├─ market reader   (readTokens/readState, all vintages)  │
│   ├─ quoter          (RouterStatic + eth_call simulation)  │
│   ├─ tx builder      (Router V4 / commonDeploy / syFactory)│
│   └─ address book    (live-resolved, minimal hardcoding)   │
└──────────────┬─────────────────────────────────────────────┘
               │ JSON-RPC only (user-configurable, multicall-batched)
               ▼
   Arbitrum One — Pendle canonical contracts
```

### 3.1 Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Build | **Vite + React + TypeScript** | Static SPA fits the backend-free ethos (IPFS-hostable); no SSR value in a wallet-gated dApp. Same family as the user's other project (Vite/React/TS/Tailwind). |
| Styling | **Tailwind CSS + shadcn/ui** | Fast, familiar, good dark-mode defaults. |
| Web3 | **wagmi 2.19.5 + viem 2.x + RainbowKit 2.2.11** | Verified-compatible trio (RainbowKit still pins wagmi 2.x as of July 2026). viem `batch: {multicall: true}` batches reads via Multicall3. Revisit wagmi 3 + Reown AppKit only if RainbowKit stays stale. |
| Data | **TanStack Query 5** (wagmi's built-in caching layer) | Per-query staleTime tuning; no extra state library needed beyond a small zustand/context store for the pool registry. |
| ABIs | Generated via **@wagmi/cli** from `@pendle/core-v2` npm + Arbiscan-verified sources | The repo interface for `commonDeploy` is **stale** (missing `initData` param on `deployCommonMarketById`) — helper ABIs must come from the verified deployed source (already captured in `research/`). |
| Testing | **Vitest** (math/units) + **Foundry fork tests** (flows, in CI) | The two research fork suites (Router feasibility, SY factory matrix) are checked into `research/fork-tests/` and become the seed of the CI suite. Note: router facets use Cancun opcodes — forks must run `evm_version >= cancun`. |
| Hosting | **GitHub repo + Vercel or Cloudflare Pages** (static) | Auto-deploy from `main`; IPFS mirror later. |

### 3.2 Data layer rules

- **RPC:** default to a public Arbitrum RPC with a settings panel for a user-supplied RPC URL. Aggressive multicall batching; TanStack staleTime ≥ 15s for market state, longer for immutables.
- **Address book:** hardcode only the entry points that are themselves the source of truth (`router`, `routerStatic`, `commonDeploy`, `syFactory`, `oracle`, the 5 market factories + 5 YCFs for validation, `expiredRedeemer`); resolve active factories from `commonDeploy.marketFactory()/yieldContractFactory()` at runtime; read `expiryDivisor`, fee rates, treasury live (F12).
- **Quoting (M0 parity verdict — `fork-tests/PARITY.md`):** RouterStatic statics are the display-quote source (fork-verified: discounted per-router fee context, ≤ ~50 ppm deviation). ApproxParams are synthesized client-side with `guessOffchain` = static quote — the `*AndGenerateApproxParams` helpers don't exist on the deployed diamond. The **binding** pre-sign number is still an `eth_call` simulation of the real router call; any min-out derived from a static quote gets a ≥ 0.01% haircut (YT-direction statics can over-quote within approx-search noise — fork-observed revert without it). Scale amounts by each token's own decimals (a 6-decimal `tokensIn` entry mis-scaled reverts statics with `APPROX_EXHAUSTED`). Never infer fee context from `readState(RouterStatic)` — it returns the base fee even though the statics quote discounted.
- **Tx lifecycle — approve → simulate → confirm:** exact-call simulation reverts until allowance exists. Quotes shown before approval are marked *indicative*; the binding simulation (exact min-received, decoded errors) runs once the approve tx confirms and is what gates the Confirm button. Where the RPC supports `eth_call` state overrides, simulate earlier by overriding allowance/balance slots; degrade gracefully on RPCs that reject overrides. Same sequencing applies to M6's deploy pre-flight (seed token must be approved to `commonDeploy` first).
- **USD prices (optional, clearly labeled):** there is no on-chain USD feed for arbitrary assets. v1 shows everything denominated in the SY's accounting asset; a DefiLlama/CoinGecko price lookup is an optional enhancement, visually marked as external data.
- **No indexer:** market discovery is paste-an-address (by design); history/charts are out of scope for v1 (needs archive RPC or indexer — see §7).

### 3.3 Pool registry (user requirement #8 — remember/forget checkboxes)

`localStorage` key `openpendle.pools.v1`:

```ts
type SavedPool = {
  chainId: 42161;
  market: Address;        // checksummed PLP address (the key)
  savedAt: number;
  // display cache (re-verified on load, never trusted for tx building):
  label: string;          // e.g. "PT-SY-myToken-25FEB2027" (older vintages need composed names)
  sy: Address; pt: Address; yt: Address;
  expiry: number;
  factory: Address;       // which of the 5 factories validated it
};
```

- The pool page has a **"Remember this pool"** checkbox. Ticking saves; unticking **forgets** (removes from the list). The saved list renders on the home screen; each entry has its own checkbox state. Multiple pools supported; storage schema is versioned for future migration.
- On app load, saved pools are re-validated and their live state (expired? TVL? implied APY) is fetched in one multicall sweep.

### 3.4 Security posture

- Validate every pasted address via `isValidMarket` across all 5 factories **before** showing any approve/trade UI (the router itself will happily call a malicious address — F2's flip side). The gate applies to **every entry path** — the paste box AND direct `#/market/0x…` links (link-sharing is the product's primary flow, so deep links are the attack surface). The validation verdict travels with the snapshot (`validated` flag); provenance labels (vintage badges) must derive only from our own factory checks, never from the market's self-reported `factory()`. Unvalidated market-shaped contracts render a red warning state, not metrics with a green badge (M1 review finding, 2026-07-04).
- **Valid market ≠ safe market.** `isValidMarket` proves only that the market shell is canonical factory bytecode. The SY underneath — and its attacker-controlled `tokensIn` list — is permissionless, untrusted code (F1). Treat the SY as adversarial even after the gate: every pool page carries a **trust panel** (SY provenance: deployed via Pendle's `syFactory` templates vs unknown bytecode; SY owner address; paused state; proxy admin / upgradeability), and approvals stay exact-amount so worst-case loss is capped at the amount being traded.
- Exact-amount approvals by default, with an "infinite approval" opt-in.
- Simulate every tx pre-signature; decode Pendle custom errors (`MarketExpired` 0xb2094b59, `MarketFactoryMarketExists` 0x4a588866, `MarketFactoryInvalidPt` 0x781eae2d, `YCFactoryYieldContractExisted` 0xa50d9502, `YCFactoryInvalidExpiry` 0x1f687fd0, "Slippage: search range overflow", `MarketZeroNetLPFee`, …) into human-readable messages.
- Disclose trust facts in context: SYs deployed via the upgradeable path are proxies under **Pendle's** proxyAdmin; SY owners can pause; community pools have no Pendle listing review — "trade at your own risk" framing throughout.

---

## 4. Macro features → milestones

| Macro feature (user's list) | Milestone(s) |
|---|---|
| 1. Community Pool Creation | M6 |
| 2. SY Adapter Creation | M7 |
| 3. Load pools by address + remember/forget | M1 |
| 4. Full integrations (PT/YT, SY, liquidity, zap) | M2 + M3 + M4 — zap scope **approved by user 2026-07-04**: v1.0 zaps cover SY-accepted tokens (the underlying); aggregator zaps from arbitrary tokens are confirmed for **v1.5** (§7). |
| 5. Maturity handling | M5 (flows) — but the basic expired-state gating ships in **M1**, since 138 of the 146 loadable Arbitrum markets are already expired |

Mapping to the user's original 8-point list: points 1–5 are the macro features above; #6 (Arbitrum-only) is a global constraint; #7 (respect Pendle's fees) is satisfied by construction (F3); #8 (remember/forget checkboxes, multi-pool, persisted locally) is §3.3, delivered in M1.

**Why execution order ≠ list order:** loading and trading (M1–M5) can be built and tested against the 8 live community markets on Arbitrum *today*, and every creation flow ends by dropping the user onto a pool page — so the pool page must exist first. Creation (M6–M7) is then a thin, well-understood layer over `commonDeploy`/`syFactory`. If you'd rather ship creation earlier, M6 can move ahead of M4/M5 with no dependency breakage — but M1–M3 come first regardless.

---

## 5. Milestones and tasks

Each milestone ends with: fork-test/preview verification, a short demo note, and a deploy to the staging URL.

### M0 — Foundation (repo, wallet, address book) ✅ complete 2026-07-03

- [x] Scaffold Vite 8 + React 19 + TS (strict) + Tailwind 4; CI workflow (frontend build + forge fork tests). *shadcn/ui deferred to M1 (CLI friction on Vite 8/Tailwind 4, no M0 payoff); GitHub repo + hosted deploys pending user go-ahead.*
- [x] wagmi 2.19.5 / viem 2.54 / RainbowKit 2.2.11: Arbitrum One only; custom-RPC setting (`openpendle.rpc`); multicall batching on.
- [x] ABI baseline: hand-written minimal ABIs for live resolution (`src/lib/pendleAbi.ts`); *full `@pendle/core-v2` + @wagmi/cli codegen pipeline moved to M1 where real ABIs are first needed.*
- [x] Address-book module with live resolution (F12) + static entries from Appendix A — verified against mainnet (resolved values match).
- [x] Both research fork suites ported into `fork-tests/` and passing (17/17) under Cancun + via-ir, pinned fork block 480027000.
- [x] **Quoter architecture test**: passed — verdict recorded in `fork-tests/PARITY.md` and folded into §3.2/F6 (RouterStatic usable; generators missing on deployed diamond; haircut rule).
- [x] Wallet UX baseline: fully browsable wallet-less; wrong-network banner with switch-to-Arbitrum.

**Done when:** address book resolves live values ✅; app fully browsable wallet-less ✅; wallet connects on Arbitrum with wrong-network handling ✅; fork tests green (21/21 incl. parity suite) ✅ — CI runs on GitHub once the repo is published.

### M1 — Load pools by address + registry (macro #3) ✅ complete 2026-07-04

- [x] Paste-an-address flow: normalize/checksum → `isValidMarket` across 5 factories (the provenance gate, §3.4). Rejection UX distinguishes "not a Pendle market" from "this app build may be outdated" (a future factory generation would fail against a stale list — pair with the M8 drift check).
- [x] **Near-miss classifier:** users will paste PT/YT/SY addresses. Probe rejected addresses for PT/YT/SY interface signatures and answer specifically ("this looks like a PT — paste the market (PLP) address instead"), resolving to the market where cheaply possible.
- [x] Market reader: `readTokens()` → SY/PT/YT; SY `assetInfo/yieldToken/getTokensIn/getTokensOut/exchangeRate`; `readState(router)` (F10); expiry/isExpired; compose display names for pre-V6 vintages (their `name()` is just "Pendle Market").
- [x] Pool overview card: implied APY, PT price (asset & SY terms), YT price, TVL in accounting asset, time to maturity, fee tier, factory vintage badge, **out-of-range indicator** (implied APY pinned at the rate band's edge / 0.96-proportion cap), links to Arbiscan.
- [x] **Trust panel** per pool (§3.4): SY provenance (syFactory-template vs unknown bytecode), SY owner, paused state, upgradeability.
- [x] **Basic expired-market state machine** (pulled forward from M5 — most loadable markets are expired): `isExpired()` switches the pool page to a Matured layout with trade/mint/LP-add controls disabled and a "redeem support lands in M5" notice; "Matured" badge in the registry list.
- [x] Registry: remember/forget checkbox per pool (§3.3), saved-pools home screen with live-state sweep, multi-pool support.
- [x] **First-visit home state:** paste box front-and-center, a short "where do I find a PLP address" explainer, and a small static starter list of currently-active community markets, clearly labeled as unvetted examples.
- [x] Legacy vintages (v1–V5) load **best-effort**: if any probe fails, degrade to a partial view with a "legacy market — limited support" note instead of erroring (the 9 known hard-stuck markets fall out of this naturally).

**Done when:** a **scripted acceptance sweep** — enumerate every market created through the *active* factory generation (from its `CreateNewMarket` events; archive-grade RPC in CI, not the app default) and run the reader over all of them asserting load-without-error and sane invariants (expiry parses, tokens resolve, TVL ≥ 0) — passes, plus best-effort spot-checks of a few markets per legacy vintage; expired markets render the disabled Matured layout; pools persist across reloads; unticking forgets.

### M2 — Positions, wrap/unwrap, mint/redeem (macro #4, part 1) ✅ complete 2026-07-04

- [x] Positions panel: PT/YT/LP/SY/underlying balances; claimable interest & rewards via RouterStatic `getUserSYInfo/getUserPYInfo/getUserMarketInfo` (eth_call only — they're state-mutating).
- [x] Wrap/unwrap SY: `SY.deposit`/`SY.redeem` (or router `mintSyFromToken`/`redeemSyToToken` for token lists), quoting via `previewDeposit/previewRedeem`.
- [x] Mint PT+YT: router `mintPyFromToken`/`mintPyFromSy`; Redeem PT+YT → `redeemPyToToken`/`redeemPyToSy` (pre-expiry: equal PT+YT amounts).
- [x] Claim flows: `redeemDueInterestAndRewards` batch.
- [x] Approvals manager (exact-amount default) + tx lifecycle UX per §3.2 (approve → simulate → confirm → pending → confirmed/decoded-error; indicative quotes pre-approval; opportunistic state-override simulation).

**Done when:** full mint→wrap→claim→redeem loop verified on a fork against a live market, and in preview against Arbitrum; expired markets never render these controls enabled (M1 state machine). ✅ Verified twice: lib-level fork flow test (12/12, incl. TokenInput/TokenOutput paths) + browser E2E on an anvil fork via the dev wallet (wrap, mint, dual-approval redeem). M2 review rules now encoded in code: **PT/YT decimals = `SY.assetInfo().assetDecimals`, never `SY.decimals()`** (live counterexample markets exist); the action flow **latches the plan once a send begins** (no teardown of in-flight txs on quote drift); wrong-network gating reads the connector's real chain (`useAccount().chainId`).

### M3 — Trading PT & YT (macro #4, part 2) ✅ complete 2026-07-04

- [x] Buy/sell PT: `swapExactTokenForPt` / `swapExactPtForToken` (+ SY variants); Buy/sell YT: `swapExactTokenForYt` / `swapExactYtForToken` (+ SY variants). Always empty `LimitOrderData` (F11 context; limit orders need Pendle's off-chain orderbook and per-market whitelisting — out of scope).
- [x] Quote pipeline per §3.2 (parity test passed): RouterStatic statics for display quotes + client-synthesized ApproxParams (`guessOffchain`); binding min-received from real-router simulation, with the ≥ 0.01% haircut on static-derived min-out; price impact via `calcPriceImpactPt/Yt`; per-token decimal scaling; slippage setting.
- [x] Trade panel UX: token selector limited to SY `tokensIn/tokensOut` + PT/YT/SY; implied-APY-after-trade preview (`exchangeRateAfter` → post-trade lnImpliedRate); warnings for shallow pools (YT buys revert with "search range overflow" when size pushes proportion past 0.96 — pre-check and cap the input).
- [x] Optional PT↔YT convenience: two-step `swapExactPtForSy` + `swapExactSyForYt` bundled via router `multicall` (F11).

**Done when:** all four swap directions execute on a fork against a fresh unlisted market (replicating the research fork test) and against a live listed market; quoted min-received matches fork execution within slippage tolerance on both; expired markets show no trade controls. ✅ Verified twice: lib fork gate 19/19 (all 8 router fns + 8 statics, quote-vs-executed 0–3 ppm, perturbed-pool leg) + browser E2E of all four directions via the dev wallet (executed amounts matched quotes to the digit). M3 review rules now encoded: **ApproxParams bounds scale with the user's slippage** (guessMin = quote×(1−slippage), guessMax = quote×1.05 — Pendle's own generator recipe; hardcoded ±0.1% bounds live-reproduced reverting on ANY >0.1% pool move, favorable included); quote failures decode through the same friendly mapper as simulations; the 0.96 PT-proportion cap is pre-checked and blocks the plan.

### M4 — Liquidity & zaps (macro #4, part 3) ✅ complete 2026-07-04

- [x] Add liquidity: dual (`addLiquidityDualTokenAndPt`/`DualSyAndPt`) and single-token zap (`addLiquiditySingleToken`, plus `KeepYt` variant with its no-ApproxParams signature).
- [x] Remove liquidity: dual and single-token (`removeLiquiditySingleToken`).
- [x] Zap scope v1: tokens the SY itself accepts (`getTokensIn/Out`, `SwapType.NONE`, `pendleSwap = 0`). Aggregator zaps (KyberSwap/ODOS via client-side API calls) are a v1.5 enhancement — third-party API, not Pendle backend.
- [x] LP position display: LP → (SY + PT) decomposition, share of pool, LP rewards claim.

**Done when:** zap-in with underlying → LP → zap-out round-trip verified on fork; dual-sided flows verified; expired markets show no add-liquidity/zap-in controls. ✅ Verified twice: lib fork gate 13/13 (every liquidity router fn EXECUTED incl. token-pay dual add and both KeepYt variants; 0 ppm deviations) + browser round-trip (zap-in → balanced remove → zap-out, exact to preview; LP decomposition line live). M4 review rules now encoded: **the derived PT side of a token-pay balanced add must round UP** (ceiling division — floor trips the router's `NOT_ALL_SY_USED` wei check deterministically, live-reproduced; SY-pay path keeps floor); **gate tests must EXECUTE every router variant they claim to cover** (the blocker passed a preview-only gate); balanced-form failures refresh the market snapshot on retry.

### M5 — Maturity handling (macro #5)

The disabled-actions Matured layout and registry badge already exist from M1; M5 adds the actual value flows.

- [ ] Matured layout completion: PT shown at 1 accounting asset; YT shown at $0 with claimable residuals; contextual explanations replace the M1 placeholder notice.
- [ ] Redeem PT (no YT needed post-expiry): `redeemPyToToken/Sy`; value via `pyIndexCurrent` (max()-guarded — show a depeg note when `SY.exchangeRate()` < stored index).
- [ ] Claim YT residuals: `redeemDueInterestAndRewards`; LP exits: `burn`-based dual removal + `exitPostExpToToken/Sy` one-click (zero price impact path).
- [ ] If a redemption simulation reverts on an old market, show a generic "this legacy market can't be redeemed through OpenPendle" notice (the `ExpiredLpPtRedeemer` rescue path for drained legacy markets is a non-goal, §7).

**Done when:** an expired market of each vintage (v1/V3/V4/V5) loads correctly on a fork, exits succeed, and the whitelisted-redeemer path works on the known drained market.

### M6 — Community pool creation (macro #1)

- [ ] Wizard over `commonDeploy.deploy5115MarketAndSeedLiquidity` (existing SY) — inputs: SY address (validated: implements IStandardizedYield via probe calls), expiry (date picker snapped to `expiryDivisor` boundaries, defaulting to Thursdays for ecosystem convention), rateMin/rateMax band, desiredImpliedRate (must be strictly inside the band), fee (default `rateMax/25`, max 5%), seed token (must be the SY itself or in `getTokensIn()`) + amount.
- [ ] Parameter education UI: the band → `scalarRoot`/`initialAnchor` mapping is **immutable**; if implied APY exits [rateMin, rateMax] the pool goes out of range permanently — explain with a visual; explain the seeder receives LP **and** YT (they end up long-yield unless they sell the YT).
- [ ] Pre-flight per research checklist: expiry future + divisor-aligned (read live), rateMax > rateMin strictly, fee cap, duplicate-PT check on YCF v6 (`getPT(SY, expiry)` → "PT exists, will be reused") + legacy-YCF scan (parallel-PT warning), then full `eth_call` simulation from the user's address.
- [ ] Error handling: decode the five custom errors from F-facts; on `MarketFactoryMarketExists` (front-run/griefing edge) resolve the existing market and offer "use existing market" or "retry" (next block's timestamp changes the tuple). **The event scan must be bounded**: a tuple collision implies same-timestamp creation, so scan only the last few minutes of blocks (`topic2 = PT`) — public RPCs reject wide `eth_getLogs` ranges; alternatively precompute the market's CREATE2 address (constant salt `bytes32(chainid)`) and skip logs entirely.
- [ ] Success → market address from the `MarketDeployment` event → auto-save to registry → land on the new pool page, with an **"initialize oracle" CTA** (one-time cardinality bump so TWAP pricing works later; optional, clearly priced).
- [ ] **"Recover my deployment"** affordance: if the receipt is missed (closed tab, RPC drop), scan `commonDeploy` `MarketDeployment` events filtered by the connected deployer from a checkpoint block stored at wizard start (bounded range), and/or accept a pasted tx hash — without this, a lost address is unusually costly in a directory-less app.

**Done when:** a pool is deployed + seeded on a fork through the wizard end-to-end, the created market immediately loads in M1's loader, and the recovery path retrieves it from a tx hash.

### M7 — SY adapter creation (macro #2)

- [ ] Wizard over `syFactory`/`commonDeploy` combined flows. Simple path: pick asset → template auto-suggested by probing the token (`ERC-4626?` → 4626 templates; plain ERC-20 → `PendleERC20SY`) → name/symbol conventions (`SY ...` / `SY-...`) → **one tx deploys SY + pool together** (`deployERC20Market` / `deployERC4626Market` / `deployERC4626NotRedeemableMarket`), or SY-only via `deploySY`.
- [ ] Advanced path: the 4 upgradeable templates via `deployUpgradableSY` semantics — `constructorParams = (token, rewardManager=0)` for all four, but the initData **differs**: the 3 WithAdapter ids use `initialize(name, symbol, adapter)`, while `PendleERC4626NoRedeemNoDepositUpgSY` uses `initialize(name, symbol)` (3-arg form reverts) and has no dedicated commonDeploy wrapper — its combined SY+market flow goes through `deployCommonMarketById`. Pasted adapter addresses treated as untrusted (probe `PIVOT_TOKEN()` match, simulate deposit round-trip).
- [ ] Token screening — **browser-feasible mechanisms, not forge re-runs** (the failure modes are fork-verified; the detection must work from a static site): (1) the full deploy+seed `eth_call` simulation is the primary FOT catcher (helper seeding reverts on FOT) — accordingly, SY-only `deploySY` of `PendleERC20SY` without seeding requires a passed token screen or an explicit "I know what I'm doing" override, because an unseeded FOT deploy silently under-collateralizes later; (2) balance-slot discovery via `eth_call` state-override probing where the RPC supports it, degrading gracefully; (3) a hardcoded denylist of known Arbitrum rebasing/FOT classes (aTokens etc.); (4) probe `decimals()` exists; for 4626, probe `asset()/previewDeposit/previewRedeem`.
- [ ] `syOwner` choice UX: default **Pendle governance** (matches Pendle's own trust profile; owner can pause the SY, and for adapter SYs also `setAdapter` — a theft vector if user-held); advanced users may keep ownership, with an explicit warning rendered on the resulting pool page for everyone.
- [ ] Disclose upgradeability: adapter-path SYs are TransparentUpgradeableProxies under Pendle's proxyAdmin.

**Done when:** each template deploys through the wizard on a fork (mirroring the 16-test research suite), FOT/rebasing mocks are correctly blocked **by the browser-side screening mechanism** (not just forge assertions), and the resulting pool trades in M3's panel.

### M8 — Hardening & public release

- [ ] Empty/error/loading states everywhere; mobile pass; dark mode.
- [ ] Risk & fee disclosure pages (what community pools are, what Pendle's fees are, what OpenPendle does/doesn't verify).
- [ ] README, CONTRIBUTING, architecture doc (this file evolves into it), license (recommend MIT for our code; we call deployed contracts, so Pendle's BUSL/GPL licensing of contract *source* isn't dragged in — flag for a final check if we ever vendor template source).
- [ ] Monitoring hooks for protocol drift: CI job that re-runs the address-book/live-value assertions (catches factory rotation, router facet changes — governance remapped selectors before, F11) **and watches `deployments/42161-core.json` for new factory keys**, so a generation rotation produces a PR instead of the app silently rejecting valid new markets.
- [ ] Registry export/import: JSON download and a shareable URL encoding pool addresses — localStorage is origin-scoped and clearable, and the IPFS-mirror future means a different gateway loses the list otherwise.
- [ ] Public launch: publish repo, deploy production URL, announce.

---

## 6. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Pendle governance upgrades (router facets, factory proxies, template codes are all owner-mutable) | Flows break silently | Live-read everything (F12); CI drift-checks (M8); pin behavior tests in fork CI |
| Public RPC rate limits / flaky reads | Bad UX | Multicall batching, query caching, user-configurable RPC, consider a default free-tier key |
| Users paste malicious "market" addresses | Fund loss via approvals | Factory validation gate before any approval UI (M1); simulate-before-sign. **Residual risk:** a factory-valid market can still wrap a malicious SY (valid market ≠ safe SY) — mitigated by the per-pool trust panel (M1), exact approvals, and disclosure, never claimed to be eliminated |
| Fresh pools have no fee discount (F10) and shallow liquidity | Quotes look worse than Pendle app on listed pools; big trades revert | Quote through actual router; pre-check trade size vs 0.96 proportion cap; honest price-impact display |
| Out-of-range pools (immutable rate band) | Creator confusion, "dead" pools | Wizard education + range visual (M6); out-of-range banner on pool pages |
| TWAP oracle uninitialized on new pools (cardinality 1) | No robust price for display | Use spot + "manipulable" label; offer optional "initialize oracle" tx (one-time ~900-slot cardinality bump); TWAP not needed for router quoting |
| Exotic SYs (deposit caps, pausable, oracle staleness) fail in ways generic UI can't predict | Failed txs | Simulation-first pipeline surfaces the revert before signing; decoded error display |
| Legal/licensing of Pendle code | Redistribution issues | We call deployed contracts and vendor only ABIs; license check before ever vendoring Solidity source |
| Pendle ships their own permissionless-pool UI (Zenith roadmap hinted at it) | Reduced differentiation | OpenPendle still wins on load-any-address + expired handling + open source; monitor and adjust |

---

## 7. Explicit non-goals for v1

- Limit orders (needs Pendle's centralized orderbook + per-market governance fee setup — degrades gracefully by always passing empty `LimitOrderData`).
- Aggregator zaps from arbitrary tokens — **user-approved as the first v1.5 feature (2026-07-04)**: client-side KyberSwap/ODOS calls, no Pendle backend.
- Chains beyond Arbitrum One (architecture keeps `chainId` explicit everywhere to ease expansion).
- Historical charts / underlying-APY column (needs archive RPC or indexer; revisit with event-scan + localStorage sampling).
- PENDLE gauge incentives, vePENDLE, points programs.
- Bespoke SY authoring for rebasing/exotic assets (blocked in wizard; adapter escape hatch exists for power users).
- Legacy Pendle-listed market special-casing: `ExpiredLpPtRedeemer` whitelist routing, the 9 hard-stuck markets, guaranteed pre-V6 rendering. OpenPendle targets current-generation community pools; older markets load best-effort with honest degradation (user direction, §2).
- Our own smart contracts of any kind.

---

## 8. Ways of working

- **Repo:** `open-pendle` (this folder), GitHub under the user's account, public once M1 is demoable. Claude handles all git/GitHub operations end to end.
- **Environment note:** this Mac has no Node toolchain installed; standalone Node/foundry binaries are downloaded per-session (same pattern as previous projects). CI carries the real test burden.
- **Cadence:** one milestone at a time; each ends with a fork-verified demo + staging deploy before moving on.

---

## Appendix A — Address book (Arbitrum One, verified 2026-07-03)

**Transaction entry points**

| Contract | Address | Notes |
|---|---|---|
| Router V4 | `0x888888888889758F76e7103c6CbF23ABbF58F946` | All trades/liquidity/exits; facet proxy, no market allowlist (fork-verified) |
| commonDeploy (PendleCommonPoolDeployHelperV2) | `0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9` | Pool + SY one-tx deploys; resolve factories from its immutables |
| syFactory (PendleCommonSYFactory) | `0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8` | 7 template ids registered (fork-verified) |
| ExpiredLpPtRedeemer | `0x23567b248cd64479384d2E0Cbe83522aFB8DD446` | 7 whitelisted drained legacy markets (non-goal v1, reference only) |

**Read/quote helpers**

| Contract | Address |
|---|---|
| RouterStatic | `0xAdB09F65bd90d19e3148D9ccb693F3161C6DB3E8` |
| PendlePYLpOracle | `0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| PendleMulticallV2 | `0x539fd510fE352CC81822a222F821c340133Ed41C` |

**Validation set — market factories (isValidMarket) / paired YCFs (getPT)**

| Gen | Market factory | Yield contract factory | Status |
|---|---|---|---|
| v1 | `0xf5a7De2D276dbda3EEf1b62A9E718EFf4d29dDC8` | `0x28dE02Ac3c3F5ef427e55c321F73fDc7F192e8E4` | 27 markets, expired; 1-arg `getMarketConfig` |
| V3 | `0x2FCb47B58350cD377f94d3821e7373Df60bD9Ced` | `0xEb38531db128EcA928aea1B1CE9E5609B15ba146` | 40 markets, expired |
| V4 | `0xd9f5e9589016da862D2aBcE980A5A5B99A94f3E8` | `0xc7F8F9F1DdE1104664b6fC8F33E49b169C12F41E` | 3 markets, expired |
| V5 | `0xd29e76c6F15ada0150D10A1D3f45aCCD2098283B` | `0xFF29e023910FB9bfc86729c1050AF193A45a0C0c` | 52 markets, expired |
| "V6" (impl V7) | `0x49F2f7002669E0e4425Fa0203975625Ab4af3143` | `0xBA814Bf6E27A6d6baE4a8aC65c8Bc3d8e9B0aaCF` | **Active** — all new pools; upgradeable proxies |

**Reference**

| Item | Value |
|---|---|
| Pendle treasury | `0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6` |
| Pendle governance proxy (default syOwner) | `0x2aD631F72fB16d91c4953A7f4260A97C2fE2f31e` |
| PENDLE token | `0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8` |
| expiryDivisor (live-read) | 86400 (daily 00:00 UTC; Thursday is convention) |
| Max fee (lnFeeRateRoot cap) | ln(1.05) = 48790164169432003 |
| Swap fee to treasury | reserveFeePercent = 80% |
| YT interest/reward fee (v5/v6 YCF) | 5% (older factories 3%) — read per-market |
| Hard-stuck legacy markets | 9 (7 GLP v1 + 2 V5) — disclosure list in research doc |

Canonical source: `deployments/42161-core.json` in `pendle-finance/pendle-core-v2-public`.
