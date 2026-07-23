# PT looping fork proof

**Status:** Market Mode has a guarded Arbitrum burner round trip. Mint entry is
production-enabled for 19 live reviewed markets; Mint increases remain disabled.
**Last live value-moving run:** 23 July 2026 (Ethereum Mint entry and exit)
**Networks:** Ethereum user round trip, Arbitrum Market Mode canary, and pinned
Ethereum, Monad, and Arbitrum compiler-fork proofs

## Result

One atomic Market Mode PT loop and its complete unwind are feasible through
Morpho's already-deployed Bundler3 and GeneralAdapter1. The tested path does
not require an OpenPendle contract or a backend executor.

The default Market Mode proof uses a deliberately small fixture: a 1 USDC
simulated user contribution and one 0.5 USDC Morpho borrow:

1. pull the user's USDC into Bundler3;
2. buy PT through Pendle Router V4, with output sent to GeneralAdapter1;
3. promise the two slippage-protected PT minimums as Morpho collateral;
4. inside Morpho's collateral callback, borrow 0.5 USDC and buy the remaining PT;
5. let Morpho pull the promised PT and sweep any excess back to the user;
6. for a full close, repay all debt shares and, inside the repay callback, withdraw and sell all collateral PT;
7. sweep the USDC surplus to the user.

Morpho's position is always owned by the user. Bundler3 and GeneralAdapter1 finish with no USDC or PT, and temporary Pendle Router allowances are cleared.

## Arbitrum mainnet Market Mode burner canary

The first funded proof used the Arbitrum PT-USDai-15OCT2026 / native-USDC Morpho market. It deliberately opened and closed the position inside one Bundler3 transaction so any bad entry, exit, repayment, or revocation reverted the entire position-bearing operation.

The canary used a 1 USDC contribution and a 0.5 USDC Morpho borrow. Fresh KyberSwap routes guaranteed at least:

- `1.004833134703734112` PT from the initial buy;
- `0.502416567026611538` PT from the callback buy;
- `1.469000` USDC from selling the exact `1.507249701730345650` PT collateral.

The borrow was bounded to at most `501157596354` shares. The finite repay-price bound could authorize no more than `0.505002` USDC, including a 1% buffer and two raw USDC units for rounding. The exact pending-state transaction simulated successfully before broadcast.

| Step | Arbitrum transaction | Result |
| --- | --- | --- |
| Exact 1 USDC approval | `0x87c34f07265175d94e56d7c78537e78f239b5c9b2e25b8e57efdf143fed8e074` | success; 55,547 gas |
| Atomic entry and full unwind | `0x96afc1d32ba37ddd3945a939b881ee5786ec65de0b0ffc71f28eb7dd2a1ec793` | success; 1,767,392 gas |

Independent post-transaction reads confirmed:

- Morpho debt and collateral are both zero;
- GeneralAdapter1 authorization is false and the Morpho nonce advanced from 0 to 2;
- the burner-to-adapter USDC allowance is zero;
- Bundler3 and GeneralAdapter1 route-token balances and temporary Router allowances are zero;
- the burner finished with `2.083838` USDC and `0.015228950214561514` PT dust.

The atomic canary proves the assembled Arbitrum transaction shape can execute and unwind. By itself it does not prove production sizing, every market, persisted positions across blocks, or frontend wallet behavior.

## Persisted Arbitrum Market Mode entry and separate unwind

A second burner proof opened the same 1 USDC + 0.5 USDC loop as a real Morpho position, verified it after confirmation, and closed it in a separate transaction 22 blocks later. Both transactions contained their own signed Morpho authorize/revoke pair, so GeneralAdapter1 was already unauthorized while the position remained open between transactions.

Pendle's current Hosted SDK route selected USDai as the SY mint token for both PT buys. The runner accepted it only after checking the explicit PYUSD/USDai allowlist against the SY contract's current `getTokensIn()` result. Before broadcast, the exact entry bundle passed pending-state simulation with:

- `1.507238842139092082` PT promised as collateral;
- a `0.5` USDC borrow bounded to at most `501155958021` shares;
- a current maximum healthy borrow of `1.358187` USDC, or a 2.7163x buffer over the canary debt;
- empty Pendle limit-order data, an allowlisted Kyber route, exact wallet approval, and a 45-second quote window.

| Step | Arbitrum transaction | Result |
| --- | --- | --- |
| Exact 1 USDC approval | [`0xc7ab986d…2eef6`](https://arbiscan.io/tx/0xc7ab986df4bd01dd53e959228a218f446e3249ba2a4ea84f1151c38d5122eef6) | success at block 485,513,479; 55,563 gas |
| Persisted loop entry | [`0x56bb232d…992d9`](https://arbiscan.io/tx/0x56bb232d43112cefa885d38aefee4f77693bdbf0252f3a176c829a4f067992d9) | success at block 485,513,498; 1,258,768 gas |
| Separate full unwind | [`0xf7a475e3…5e032`](https://arbiscan.io/tx/0xf7a475e3d77d1f25af977d79f62c4562a3f0d5bb9a815b3b08078bef32a5e032) | success at block 485,513,520; 661,420 gas |

The confirmed open position held `498662643088` debt shares and exactly `1.507238842139092082` PT collateral. Its accrued debt read `0.500001` USDC, the wallet's adapter allowance was zero, GeneralAdapter1 authorization was false, and the Morpho nonce had advanced from 2 to 4. The fresh exit used the exact live shares and collateral, a `0.505004` USDC absolute repayment cap, and a `1.469263` USDC minimum output.

Independent receipt and latest-state reads after the exit confirmed:

- burner debt, collateral, adapter allowance, Morpho allowance, and adapter authorization are all zero/false;
- the Morpho nonce advanced to 6;
- Bundler3 and GeneralAdapter1 positions and route-token balances are zero;
- Bundler3's temporary USDC/PT Router allowances and transient initiator are zero;
- the burner finished with `2.067941` USDC, `0.030440134980727062` PT, and `0.004920396774556` ETH.

This proves that the public Bundler3/GeneralAdapter1 path can open a position that persists across blocks and later fully unwind it without leaving wallet authority enabled between transactions. It remains a proof for one small market and size, not production sizing, frontend transaction construction, or support for every Pendle/Morpho pairing.

The guarded direct-Morpho rescue path was reviewed and kept ready, but the successful normal exit meant it was not broadcast. A later production gate must exercise that fallback independently rather than treating its presence in the canary script as live proof.

## Guarded Market Mode production-compiler round trip

The production compiler runner repeated the persisted 1 USDC contribution plus
0.5 USDC debt canary with fresh routes, bounded entry and exit, and separate
transactions:

| Step | Arbitrum transaction | Result |
| --- | --- | --- |
| Exact 1 USDC approval | [`0x1978b92e…3268`](https://arbiscan.io/tx/0x1978b92ee3017a3acfeebc87dbfef0a158b4fc574479f4829b136b2e8daf3268) | success at block 486,012,245; 55,622 gas |
| Persisted loop entry | [`0xc5f9cddc…d1ba`](https://arbiscan.io/tx/0xc5f9cddca33a04c1d683ff29d3ebcb7be704a2cea484991f261699e3a224d1ba) | success at block 486,015,182; 1,269,077 gas |
| Separate full exit | [`0xae355549…b99d`](https://arbiscan.io/tx/0xae3555490dc33dc07655d31a73edc38c626cc102717cfa2c13724bc101f4b99d) | success at block 486,018,611; 747,946 gas |

The confirmed open position held `498576316038` debt shares and exactly
`1.506608856693158646` PT collateral. Independent post-exit preflight confirmed
an empty position, zero adapter allowance, no newly created signature or
transaction, no recovery journal or lock, `2.051794` USDC, and
`0.009878893014228` ETH. Provider errors interrupted state reads during the run,
but the mode-0600 journal prevented a duplicate entry and the fresh exit closed
the confirmed position normally.

## Legacy Ethereum fixture

The proof targets the official Ethereum PT-reUSD/USDC pairing:

| Component | Address or value |
| --- | --- |
| Morpho market ID | `0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64` |
| Morpho core | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| USDC loan token | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| PT-reUSD-10DEC2026 collateral | `0xeCfaFdC7741323a945A163ed068B5a3C43483957` |
| Oracle | `0x217d6DdCDB95112C51657F6270e8C079CFDB51f0` |
| IRM | `0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC` |
| LLTV | 91.5% |
| Pendle market | `0x13285bcbc27f92b47b4edb99d744c07b48c977c0` |
| Pendle Router V4 | `0x888888888889758F76e7103c6CbF23ABbF58F946` |
| PendleSwap | `0xd4F480965D2347d421F1bEC7F545682E5Ec2151D` |
| Bundler3 | `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` |
| GeneralAdapter1 | `0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0` |

These identifiers are asserted in the test rather than inferred from token symbols.

## Tests and evidence

At Arbitrum block `485,499,750`, the exact 1 USDC + 0.5 USDC fixture passed seven KyberSwap fork cases with finite Morpho bounds:

- atomic entry;
- entry followed by a complete unwind;
- complete unwind after five minutes of accrued interest;
- callback failure with complete rollback;
- signed authorization and revocation across entry and exit;
- one-multicall signed entry, unwind, and revocation;
- deliberately broken exit with complete one-multicall rollback.

After Pendle's live route changed from PYUSD to USDai, the same seven cases passed again at Arbitrum block `485,510,755` with the route-selected mint token explicitly checked against both a two-token allowlist and the SY contract's on-chain token list.

The final KyberSwap run at Ethereum block `25,558,145` passed all five cases:

- atomic entry;
- atomic entry followed by a complete unwind;
- complete unwind after five minutes of accrued Morpho interest;
- forced callback failure with full transaction rollback;
- EIP-712 Morpho authorization in the entry bundle and signed revocation at the end of the exit bundle.

The same five cases also passed with Odos at block `25,558,159`. Fresh Hosted SDK quotes were used for every run.

A minimum-size rehearsal using a 2 USDC contribution and a 1 USDC borrow passed the same five KyberSwap cases at block `25,558,375`. Its guaranteed full-exit quote was 2.934846 USDC against 1 USDC of principal debt. This was still a fork rehearsal; the burner wallet had no Ethereum funds, so no mainnet transaction was sent.

### Mint Mode evidence

A 2026-07-23 read-only live audit covered all 22 reviewed entry identities.
Fresh production-validator Mint quotes passed for all 19 unexpired identities
(three direct `VOID` routes and 16 pinned KyberSwap routes); the other three
identities were already matured. The audit also checked PT/YT identity,
decimals, SY inputs, and Router and aggregator pins.

Separately, representative production-compiler fork lifecycles on Ethereum,
Monad, and Arbitrum covered Mint entry, Mint increase, Market Mode partial
decrease, full exit, direct rescue, and post-expiry exit. This is read-only and
fork evidence, not execution proof for every reviewed market.

The user's Ethereum PT-reUSD/USDC Mint entry
[`0x461db7…f64c`](https://etherscan.io/tx/0x461db70575f073e3e5a88da85023f6fb51c4ebe999ec014b7232a4d975cef64c)
and full exit
[`0x5e691a…8d24`](https://etherscan.io/tx/0x5e691a7209c9d7a1b951c7161751538946763e4b508f55a5b5915bc5a6018d24)
succeeded. Later reads confirmed an empty Morpho position and cleared adapter
authorization and allowance. This was not a dedicated burner canary.

### Fork-version finding

An earlier Kyber full-exit test failed with `EvmError: NotActivated` while the same entry passed. The trace reached the external Kyber route and a currently deployed contract before reverting. The cause was the local harness executing as Cancun, not a bad Bundler callback: Ethereum activated Fulu-Osaka in December 2025. Running the fork with `--evm-version osaka` made the identical route and both exit cases pass.

This matters for future testing: a stale fork EVM version can produce a false protocol failure even when the RPC state and quote are current.

## Reproduce

The release-gating command runs the Arbitrum fixture and then starts a local
Anvil fork. On that local fork it executes the exact signed entry and exit
bundles emitted by `app/src/lib/loopingExecution.ts`, verifies their receipts,
opens a second position, and executes the compiler's direct-rescue intent one
re-prepared transaction at a time. The compiler phase refreshes its own fork
block after the Solidity suite and fetches fresh Pendle v3 routes during entry
and exit preparation; it never reuses the Solidity fixture's aging opaque
aggregator calldata:

```sh
cd app
npm run test:looping-fork
```

For focused research runs from `fork-tests/`:

```sh
node --experimental-strip-types scripts/run-looping-fork.mjs --chain arbitrum --aggregator kyberswap --initial-usdc 1 --loop-usdc 0.5
node --experimental-strip-types scripts/run-looping-fork.mjs --aggregator kyberswap
node --experimental-strip-types scripts/run-looping-fork.mjs --chain ethereum --aggregator odos
node --experimental-strip-types scripts/run-looping-fork.mjs --chain ethereum --aggregator kyberswap --initial-usdc 2 --loop-usdc 1
node --experimental-strip-types scripts/run-looping-fork.mjs --chain monad --compiler-only --initial-usdc 1 --loop-usdc 0.11 --maturity-loop-usdc 0.11
node --experimental-strip-types scripts/run-looping-fork.mjs --chain ethereum --compiler-only --mode mint
node --experimental-strip-types scripts/run-looping-fork.mjs --chain monad --compiler-only --mode mint --loop-usdc 0.11 --maturity-loop-usdc 0.11
node --experimental-strip-types scripts/run-looping-fork.mjs --chain arbitrum --compiler-only --mode mint
```

Arbitrum is the default chain. `OPENPENDLE_ARB_RPC_URL` (or `ARB_RPC_URL`),
`OPENPENDLE_ETH_RPC_URL` (or `ETH_RPC_URL`), and `OPENPENDLE_MONAD_RPC_URL`
(or `MONAD_RPC_URL`) may provide alternate RPCs. The
high-volume fork runner deliberately does not load browser or burner secrets
from `.env.local`. Its final Arbitrum fallback is
`https://arb1.arbitrum.io/rpc`. The script prints
only the hostname, fetches fresh Pendle calldata, validates the decoded route,
pins the current block, and executes against the fork under the configured EVM
rules. `--initial-usdc`, `--loop-usdc`, and `--maturity-loop-usdc` accept
amounts with up to six decimals. The maturity amount cannot exceed the normal
loop amount and applies only to the separate post-expiry fixture. Monad uses a
smaller loop fixture because Pendle's live quote service cannot observe the
earlier swap made only on the local fork; this is a test-isolation choice, not
a frontend amount cap. `--match-test <name>` and `--trace` narrow or trace the Solidity
cases. `--compiler-only` is available for a focused production-compiler proof
and is required with `--mode mint`; the full Market Mode Arbitrum run remains
the release gate.

The runner rejects a quote unless it has the expected Router, adapter receiver, market, exact input, token path, PendleSwap, scaling behavior, zero native value, chosen aggregator, and empty limit-order data.

## What this proves about the product architecture

The core transaction path can remain frontend-only:

- OpenPendle can fetch fresh Pendle routes in the browser;
- build the Bundler3 calls client-side;
- ask the wallet for Morpho's EIP-712 manager authorization;
- simulate the complete assembled transaction from the connected wallet;
- submit one atomic entry or exit transaction.

The test still gives USDC approval to GeneralAdapter1 directly. Production should use an exact, short-lived approval or validate Morpho's Permit2 path separately. This is a wallet-approval UX question, not a reason to deploy an OpenPendle contract.

## Required execution gates

The browser compiler preserves these gates for every reviewed-market action:

1. **Full-bundle simulation:** fetch all routes immediately before use, assemble the exact Bundler call, and simulate it from the real wallet at the pending head. Requote on any failure or material head change.
2. **Finite debt bounds:** derive finite Morpho borrow and repay share-price limits from freshly accrued market totals. The fork and burner canary cap borrow shares and enforce an absolute maximum repayment, but production must recompute those values for every assembled transaction.
3. **Repayment coverage:** require the exit's guaranteed minimum USDC, plus any explicit refundable buffer, to cover a buffered maximum repayment for the user's current debt shares. Comparing the exit only with original principal is insufficient.
4. **Exact full-close snapshot:** quote and withdraw the same current collateral amount. Do not mix a dynamic withdrawal amount with fixed Router calldata.
5. **Health and liquidity:** size debt from guaranteed PT minimums, current oracle price, LLTV, borrow liquidity, slippage, and a user-visible safety buffer. Reject stale or unsupported market data.
6. **Route restrictions:** keep Pendle limit-order fills disabled for looping, validate every decoded address and amount, require the correct scaling mode, and clear temporary allowances.
7. **Atomic failure:** never split the entry into steps that can leave the user holding debt and idle borrowed USDC. A failed callback must revert the entire transaction.
8. **Post-expiry path:** a matured PT uses Pendle's post-expiry redemption path instead of the pre-expiry market swap; new entry and leverage adjustment are disabled while full exit remains available from Positions.

GeneralAdapter1's repay callback intentionally ignores Morpho's runtime `assets` argument, so its nested calls cannot resize themselves to an unexpectedly different repayment. That is why the finite share-price limit, repayment buffer, and full simulation are mandatory.

## Launch controls and next proof

The browser now compiles exact reviewed-market paths across its execution
chains, keeps Morpho signatures in memory, revalidates before signing and
submission, verifies receipts and position postconditions, and exposes bounded
direct-Morpho recovery. Risk increase, reduction/exit, and recovery are separate
planes:

- Market Mode entry and increase require
  `VITE_LOOPING_EXECUTION_BETA_ENABLED=true` **and** a fresh enabled
  `app/public/looping-execution-policy.v1.json` covering the exact chain and
  Morpho market;
- Mint Mode entry and increase additionally require
  `VITE_LOOPING_MINT_BETA_ENABLED=true` and the matching `mint.entry` or
  `mint.increase` capability in
  `app/public/looping-mint-execution-policy.v1.json`;
- full exit has its own `VITE_LOOPING_EXIT_BETA_ENABLED` flag and never depends
  on either risk-increase runtime policy; reduction follows the same exit plane;
- recovery is not launch-gated.

Both runtime policies are fetched same-origin with `cache: no-store`; the base
policy is checked first, followed by the action-specific Mint policy. They are
checked before a nonzero adapter approval, immediately before the first
authorization signature, and again immediately before signed submission.
Enabled capabilities expire within seven days; missing, stale, malformed,
redirected, cross-origin, or mismatched policies fail closed.

The canonical Cloudflare main build enables Mint entry for the 19 reviewed
markets that remain live through the current policy window. Mint increases
remain disabled. Local
development may opt in through `OPENPENDLE_LOCAL_MINT_POLICY_ALL=true` or one
exact `OPENPENDLE_LOCAL_MINT_POLICY_MARKET=<chainId>:<marketId>`; these
loopback-only dev-server overrides are ignored by production builds. The
OpenPendle main deployment's base policy covers the reviewed entry registry
and expires within seven days. Preview builds force execution flags off.
Cloudflare cache rules must be verified on each deployed policy endpoint before
its capability is enabled.

The guarded Market Mode production-compiler round trip and cleanup are
complete. The user-run Mint entry and exit are confirmed; no dedicated Mint
burner canary has run. Mint entry can still be paused through its runtime gate
without affecting Market Mode, reduction, full exit, or recovery. The browser
does not impose a fixed equity or debt amount cap; wallet balance, Morpho
liquidity, Pendle quote capacity, and all execution safety checks still apply.
The small runner amounts remain canary fixtures only.

The 10% liquidation-buffer threshold is a warning that requires acknowledgement;
the live preflight enforces the 1% floor.

`app/scripts/live-looping-compiler-canary.mjs` is the guarded runner for the
Market Mode proof. With no arguments it is keyless and read-only.
`--live-preflight` validates the configured burner and private 1RPC endpoint,
compiles a fresh production entry preview, and creates no signature or
transaction. Value-moving modes require an exact environment acknowledgement
and an exclusive local lock. Signed authorization calldata is transport-blocked
from `eth_call` and `eth_estimateGas`; the runner uses fixed fork-reviewed gas
limits, one raw broadcast, two confirmations, and a mode-0600 ignored recovery
journal. A
separate `--recover-reverted`, one-step `--rescue`, read-only `--reconcile`, and
same-nonce `--cancel-ambiguous` path remain available if the normal round trip
does not finish cleanly. Cancellation retains an append-only, capped history of
every same-nonce candidate, requires two confirmations before choosing a
winner, and stops if the wallet nonce advances without a known winner. Its
zero-tip replacement fee floor was accepted by a local Arbitrum-chain-id Anvil
transaction pool. Entry also reserves the full capped cost of approval, entry,
a failed exit, authorization cleanup, and four direct-rescue steps (0.0055 ETH).
After a process crash, keyless `--clear-stale-lock` removes the local lock only
when its recorded PID is no longer alive; it never removes the recovery journal.
The runner's guarded approval, persisted entry, and separate exit are linked
above and are all Market Mode transactions. Browser risk increases and exits
are available only when their respective build flags permit them; every risk
increase requires the fresh base policy, and Mint also requires the fresh
action-specific Mint policy.

## Primary references

- [Pendle Hosted SDK](https://docs.pendle.finance/pendle-v2/Developers/Backend/HostedSdk)
- [Pendle Ethereum deployment manifest](https://github.com/pendle-finance/pendle-core-v2-public/blob/main/deployments/1-core.json)
- [Morpho contract addresses](https://docs.morpho.org/developers/contracts/addresses/)
- [Morpho Bundler3](https://github.com/morpho-org/bundler3/blob/main/src/Bundler3.sol)
- [Morpho GeneralAdapter1](https://github.com/morpho-org/bundler3/blob/main/src/adapters/GeneralAdapter1.sol)
- [Morpho core](https://github.com/morpho-org/morpho-blue/blob/main/src/Morpho.sol)
- [Ethereum Fulu-Osaka](https://ethereum.org/roadmap/fusaka/)
