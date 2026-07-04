# RouterStatic ↔ Router V4 quote parity (M0 deliverable)

**Decides:** M3 quoter architecture (PLAN.md §3.2 "Quoting — simulation-first", §5 M0).
**Test:** [`test/QuoterParity.t.sol`](test/QuoterParity.t.sol) — divergence never fails the suite; assertions cover harness mechanics only, deviations are findings.

## Setup

| Item | Value |
|---|---|
| Fork block | **480027000** (Arbitrum One, 2026-07-03) |
| RPC | `https://arb1.arbitrum.io/rpc` |
| Toolchain | forge 1.7.1 (4072e48), solc 0.8.26, `evm_version = cancun`, via-ir |
| RouterStatic | `0xAdB09F65bd90d19e3148D9ccb693F3161C6DB3E8` |
| Router V4 (execution) | `0x888888888889758F76e7103c6CbF23ABbF58F946` |
| Market (a) listed, fee-discounted | `0x46f545683D8494Ef4c54B7ea40cA762c620846eF` "PLP USDai 25FEB2027" (expiry 1803513600, totalSy ≈ 39,296 SY) |
| Market (b) fresh community | created in-fork over a mock SY via YCF v6 + market factory V7, `lnFeeRateRoot = 5982071677547463` (same as (a)'s base fee), no override; seeded 1,200 SY / 800 PT via `addLiquidityDualSyAndPt` |
| Execution params | `createDefaultApproxParams()` = `ApproxParams(0, type(uint256).max, 0, 256, 1e14)`, pranked funded EOA, `vm.snapshotState/revertToState` between runs |

### Fee context at fork block (market (a))

| `readState(x).lnFeeRateRoot` | value |
|---|---|
| `x = address(0)` (base) | 5982071677547463 |
| `x = Router V4` | **1399020913707341** (≈ 4.28× governance discount — precondition verified) |
| `x = RouterStatic` | 5982071677547463 (no override entry for RouterStatic itself) |
| `x = legacy Router V3` | 5982071677547463 |

Market (b): all four contexts identical (5982071677547463), `getMarketConfig(market, RouterV4).overriddenFee == 0`.

## Results

Deviation = |static − actual| / actual. "min-out = static" = executing with the raw static quote as `minPtOut`/`minYtOut` and default ApproxParams.

### (a) Listed, fee-discounted market — trade sizes ≈ 0.05–0.25 % of pool SY

| Direction (size) | Static quote | Actual (Router V4) | Deviation | Tight static-derived ApproxParams (±0.1 %, guessOffchain = static) | min-out = static |
|---|---|---|---|---|---|
| `swapExactSyForPt` (100 SY) | 104.242362422412970717 PT | 104.246726186649625409 PT | **41 ppm, static under** | OK | OK |
| `swapExactTokenForPt` (100 USDai) | 104.242362422412970717 PT | 104.246726186649625409 PT | **41 ppm, static under** | OK | OK |
| `swapExactSyForYt` (20 SY) | 462.691150691153928447 YT | 462.682553675599961754 YT | **18 ppm, static OVER** | OK | **REVERTED** |

netSyFee, `swapExactSyForPt`: static 0.090521 SY vs actual 0.090525 SY (0.004 % apart). If RouterStatic quoted at the base fee the fee would be ≈ 4.28× higher (≈ 0.387 SY) and netPtOut would deviate ≈ 2,900 ppm — observed 41 ppm. **RouterStatic quotes in Router V4's discounted fee context**, despite `readState(RouterStatic)` returning the base fee — i.e. it internally reads market state as the real trading router, not as itself.

### (b) Fresh community market, no fee override — trade sizes ≈ 0.2–0.4 % of pool SY

| Direction (size) | Static quote | Actual (Router V4) | Deviation | Tight ApproxParams | min-out = static |
|---|---|---|---|---|---|
| `swapExactSyForPt` (5 SY) | 5.077817691878956024 PT | 5.078075882072964915 PT | **50 ppm, static under** | OK | OK |
| `swapExactTokenForPt` (5 mUSD) | 5.077817691878956024 PT | 5.078075882072964915 PT | **50 ppm, static under** | OK | OK |
| `swapExactSyForYt` (2 SY) | 101.285278320312499995 YT | 101.287602887554597167 YT | **22 ppm, static under** | OK | OK |

Seeding `guessOffchain` with the static quote under fail-safe wide bounds `(0, max, static, 256, 1e14)` also executed cleanly (tested in the SY→PT direction on both markets).

All observed deviations (18–50 ppm, sign varies) sit inside the approximation tolerance `eps = 1e14` (= 100 ppm) used by both the router's binary search and RouterStatic's internal math — this is approx-search noise, not a fee-context error.

## RouterStatic selector survey (deployed diamond, block 480027000)

Present and working: `swapExact{Sy,Token}For{Pt,Yt}Static`, `swapExact{Pt,Yt}For{Sy,Token}Static`, `swap{Sy,Pt,Yt}ForExact*Static` (all 12 exact-in/exact-out swap quotes), `calcPriceImpactPt/Yt/PY`, `addLiquiditySingleSyStatic`, `addLiquiditySingleSyKeepYtStatic`, `removeLiquiditySingleSyStatic`, `getMarketState`, `getYieldTokenAndPtRate`, `getUserMarketInfo` (state-mutating, `eth_call` only).

**Missing — reverts `"selector not found"` (corrects fact F6, which had these "signature-verified"):**

- `swapExactSyForPtStaticAndGenerateApproxParams(address,uint256)`
- `swapExactTokenForPtStaticAndGenerateApproxParams(address,address,uint256)`
- `swapExactSyForYtStaticAndGenerateApproxParams(address,uint256)`
- `swapExactTokenForYtStaticAndGenerateApproxParams(address,address,uint256)`
- `getPtImpliedYield(address)`

Practical gotcha found while probing: `getTokensIn()[0]` of the listed SY is PYUSD (**6 decimals**); token-direction static quotes revert `APPROX_EXHAUSTED` if you pass 18-decimal-scaled amounts of it. Always scale by the token's own decimals.

## VERDICT

**RouterStatic is usable as a quote source.** Its fee context is the *per-router discounted* fee, not the base fee: on the governance-discounted listed market its quotes and `netSyFee` match real Router V4 execution to ≤ 41 ppm (a base-fee quote would be ~2,900 ppm off), and on a fresh no-override community market parity is ≤ 50 ppm — all within the `eps = 1e14` approximation tolerance. It achieves this by reading market state as the real trading router internally, even though no fee-override entry exists for RouterStatic itself (`readState(RouterStatic)` = base fee — so never infer its behavior from that read). Two operational caveats for M3: (1) the `*AndGenerateApproxParams` helpers do **not** exist on the deployed Arbitrum diamond, so "generated ApproxParams" must be synthesized client-side — `guessOffchain = static quote` with either tight ±0.1 % bounds or fail-safe wide bounds executed cleanly in every tested direction; (2) static quotes carry ±eps approx noise with varying sign — on the listed YT direction the static quote *over*-quoted by 18 ppm and using it raw as `minYtOut` reverted, so any min-out derived from a static quote needs a haircut of at least `eps` (0.01 %), which any sane slippage setting already provides. §3.2's simulation-first pipeline remains the binding pre-sign quote (it also validates allowances and decodes reverts), but RouterStatic is confirmed safe for indicative quotes, price-impact decomposition, and ApproxParams seeding — the M3 gate passes.

---

**Post-M3 footnote (2026-07-04):** the `*AndGenerateApproxParams` helpers DO exist on the deployed diamond, at arities this report didn't probe — `(address,uint256,uint256)` / `(address,address,uint256,uint256)` with a trailing 1e18-scaled slippage param, returning ApproxParams with maxIteration 30 / eps 1e13 / guessOffchain = static quote. Only the 2-arg form probed above is absent, and no YT-direction generator exists at any arity. OpenPendle keeps client-side synthesis regardless (one fewer RPC, covers YT buys; fork-measured 70,245 gas / ~15% cheaper than default full-range params). See `app/scripts/m3-swap-test.mjs`.
