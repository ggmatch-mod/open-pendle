# Looping Mint Mode: feasibility and integration plan

**Status:** Full Mint Mode implemented locally; writes remain disabled by default

**Date:** 2026-07-23

**Scope:** Alternative looping entry and increase flow; implementation,
validation, and GitHub proposal only. Production activation remains separate.

## Executive verdict

Mint Mode is feasible with OpenPendle's existing Pendle Router V4, Morpho Blue,
Bundler3, and GeneralAdapter1 stack. It does not require a backend or a new smart
contract.

The exact flow requested is viable:

1. Buy the initial PT with the user's loan-token equity.
2. Supply that PT as Morpho collateral.
3. Borrow the loan token.
4. Mint PT+YT with the borrowed loan token.
5. Add only the guaranteed PT output to Morpho collateral.
6. Return all minted YT, excess PT, and dust to the user's wallet.

The local implementation selects the full-mint interpretation:

| Mode | Initial equity | Borrowed capital | User receives YT | Assessment |
| --- | --- | --- | --- | --- |
| Market Mode | Buy PT | Buy PT | No | Current behavior |
| Hybrid Mint Mode | Buy PT | Mint PT+YT | Borrowed leg only | Literal requested flow; mechanically straightforward, but mixed economics |
| Full Mint Mode | Mint PT+YT | Mint PT+YT | Both legs | Recommended meaning for a `Market / Mint` switch |

Pendle's own looping product uses “Mint Mode” for the full-mint interpretation:
mint PT+YT, loop only PT, and return YT to the wallet. This is the cleaner
product model because each mode uses one acquisition method consistently.

**Implemented decision:** full Mint Mode mints both the user's equity leg and
the borrowed leg on entry. On an existing-position increase, there is only a
borrowed leg, so Mint changes that leg from buying PT to minting PT+YT. Existing
PT from the user's wallet remains a separate later feature because it changes
the input asset, sizing, approvals, and recovery logic.

## Why the current architecture can support it

OpenPendle already compiles one atomic Bundler3 transaction that:

- pulls the user's loan token;
- obtains initial PT through Pendle Router V4;
- calls `morphoSupplyCollateral` with a callback;
- borrows inside that callback;
- obtains the remaining PT;
- lets Morpho pull the promised PT collateral;
- clears temporary approvals and sweeps dust; and
- wraps the transaction in temporary Morpho authorization and revocation.

Morpho credits the declared collateral before invoking its callback and pulls
that collateral after the callback returns. The callback can therefore borrow
against the promised final PT amount, mint the borrowed leg, and produce the PT
before Morpho pulls it. If minting, borrowing, collateral delivery, or cleanup
fails, the entire transaction reverts.

The change is primarily a new, strictly validated Pendle conversion primitive:

```text
loan token -> Router V4 mintPyFromToken -> equal PT + YT
                                              |      |
                                              |      +--> user wallet
                                              +---------> Morpho collateral
```

The current source has 22 reviewed entry-market identities plus one
management-only identity. Nineteen entry identities remain unexpired on this
document's date; three matured identities are retained for position management
but fail closed for new entry and increases. Fresh Mint quotes validate for all
19 active identities: three direct `VOID` routes and 16 pinned KyberSwap routes.
All 16 unique YT contracts currently match their paired PT decimals.

## Recommended atomic flows

### Full Mint Mode

Let `E` be user equity in the Morpho loan token and `D` the requested debt.

Before signing, obtain two binding Pendle v3 Convert routes:

- `E loan token -> [PT, YT]`
- `D loan token -> [PT, YT]`

Both routes must use GeneralAdapter1 as receiver and expose a guaranteed
`minPyOut`.

The Bundler3 transaction should:

1. Pull exactly `E` loan tokens from the user.
2. Give Router V4 an exact temporary allowance.
3. Execute the initial `mintPyFromToken`.
4. Clear the Router allowance.
5. Call `morphoSupplyCollateral` for
   `initialMinPy + borrowedMinPy`, with the user as position owner.
6. Inside the Morpho callback:
   1. borrow `D` loan tokens to Bundler3 using a bounded share amount;
   2. give Router V4 an exact temporary allowance;
   3. execute the borrowed-leg `mintPyFromToken`;
   4. clear the Router allowance.
7. Return from the callback so Morpho pulls the promised PT.
8. Transfer all YT to the user.
9. Transfer excess PT and loan-token dust to the user.
10. Clear residual allowances and revoke the temporary Morpho authorization.

### Literal hybrid variant

The transaction remains the same except:

- the initial route remains the current `swapExactTokenForPt`;
- only the borrowed route uses `mintPyFromToken`; and
- the promised collateral is
  `initialBoughtMinPt + borrowedMinPy`.

Only the borrowed mint's YT is returned. This is a smaller implementation
change, but the resulting position combines:

- fixed-yield PT exposure from the user's equity; and
- PT+YT, economically closer to underlying/SY exposure, from borrowed capital.

The UI must not apply one headline PT APY to that mixed position.

### Existing-position increase

An increase has no new user-equity leg, so the full-versus-hybrid distinction
only applies to entry or an add action that includes user capital. A Mint
increase has one acquisition route:

1. Calculate additional debt `D` from the position's current on-chain
   collateral/debt state and target LTV.
2. Obtain and validate `D loan token -> [PT, YT]`.
3. Call `morphoSupplyCollateral(borrowedMinPy)` with a callback.
4. Inside the callback, borrow `D`, approve Router V4, mint PT+YT, and clear the
   approval.
5. Let Morpho pull `borrowedMinPy` PT and return YT plus excess PT/dust to the
   user.

Increase sizing must target the resulting on-chain LTV and liquidation buffer.
It cannot use entry's `capitalMultiple = (E + D) / E`, because there is no
action-level `E` or authoritative acquisition history for an existing
position.

### Why one callback is enough

“Looping” does not need multiple borrow/mint callback rounds. The compiler can
calculate the final conservative PT collateral amount in advance. Morpho
temporarily credits that promised amount for the health check, the callback
borrows once and creates the missing PT, and Morpho pulls the promised PT when
the callback ends. Failure to produce the full amount reverts all state.

## Pendle integration

### Quote source

Use Pendle's v3 Convert API with outputs `[PT, YT]`. The accepted route must
identify:

- action `mint-py`;
- method `mintPyFromToken`;
- exact chain, loan token, and input amount;
- exact market YT;
- GeneralAdapter1 as PT/YT receiver;
- Bundler3 as the effective Router caller and token holder/approver;
- Router V4 as transaction target;
- `minPyOut`; and
- equal PT and YT output amounts.

Keep limit orders disabled for this flow. A route may use a reviewed aggregator
to convert the loan token into an accepted SY input.

### ABI and reviewed Router surface

The general Pendle ABI already contains `mintPyFromToken`; the looping-specific
ABI does not. The implementation would need to add it and review selector
`0xd0f42385`.

The selector must be pinned to its expected Router facet and runtime code hash
in the same fail-closed registry used for the existing buy-PT, sell-PT, and
redeem-PY selectors. A Router upgrade or unexpected facet must disable Mint
entry/increase without disabling reduction, exit, or recovery.

### Strict route validation

Do not treat the Hosted SDK response as trusted calldata. The compiler should
decode and validate all of the following:

1. `action`, method, selector, chain, Router target, Bundler3 caller/sender, and
   zero native value.
2. Exact loan-token input and exact `E` or `D` input amount.
3. Exact PT, YT, and SY returned by the selected Pendle market's live
   `readTokens()`.
4. Exact YT receiver: GeneralAdapter1.
5. `tokenMintSy` is present in the SY's live `getTokensIn()` result.
6. Positive `minPyOut`, exactly two PT/YT outputs, equal raw output amounts, and
   both outputs at least `minPyOut`.
7. Exact temporary approval target and amount.
8. Exact `TokenInput.pendleSwap`, allowed `swapType` (`NONE` or the reviewed
   Kyber shape), and the expected `needScale` value.
9. For aggregated routes, exact source token, destination token, input amount,
   currently pinned executor/target/code hash, and bounded nested calldata.
10. Empty permit and limit-order branches, with no fee or other side path.
11. Quote freshness, pinned block assumptions, maturity runway, and current
    Router facet/code checks immediately before signing.

For an MVP, accept only route shapes that have deterministic validators and
fork coverage. Fail closed on any new Hosted SDK shape.

### Current read-only validation

On 2026-07-23, the reproducible live audit covered all 22 reviewed entry
identities across Ethereum, Monad, and Arbitrum. It verified the exact SY, PT,
YT, expiry, PT/YT decimals, SY token allowlists, Mint Router facet/code pin, and
Kyber executor code pin at canonical blocks. Fresh production-validator Mint
quotes passed for all 19 unexpired identities; the three matured identities
were identified without requesting entry routes.

## Sizing and risk math

Mint Mode cannot reuse the current Market Mode leverage cap or APY formula.

### Guaranteed collateral

For full Mint Mode:

```text
Cmin = mintMinPy(E) + mintMinPy(D)
Ymin = mintMinPy(E) + mintMinPy(D)
```

For the hybrid:

```text
Cmin = buyMinPt(E) + mintMinPy(D)
Ymin = mintMinPy(D)
```

`Cmin` is the only mint-related amount that may be promised to Morpho. Actual
PT above the route minima should be returned to the wallet rather than counted
as collateral. Router V4 returns PT and YT to one receiver, so supplying the
unknown actual PT balance would require a more complex adapter flow and is not
necessary for the MVP.

### Health condition

At the pinned block:

```text
Vmin = floor(oracleValue(Cmin))
maxSafeDebt = floor(Vmin * LLTV * configuredSafetyBuffer)
```

The compiler must require the worst-case debt implied by the signed
borrow-share cap to remain below `maxSafeDebt`. Round:

- collateral and collateral value down;
- requested debt down; and
- maximum debt shares/exposure up.

YT is never Morpho collateral and must never contribute to health factor,
liquidation buffer, or borrow capacity.

### Replace the current value floor for Mint only

The current compiler also requires:

- entry PT collateral value to be at least 90% of `E + D`; and
- added PT value on an increase to be at least 90% of added debt.

A valid Mint route intentionally moves part of the capital's value into YT
outside Morpho, so it can fail those checks even when its PT collateral and
debt are safe. Replace them for Mint actions with mode-specific route-value
sanity checks, guaranteed-output checks, and the conservative health condition
above. Do not lower or remove the existing Market Mode value floor globally.

### Dynamic maximum

If the slider remains defined as capital multiple:

```text
capitalMultiple = (E + D) / E = 1 + D / E
```

the maximum cannot be derived from LLTV alone. `mintMinPy(D)` changes as `D`
changes, so the preview should solve the quote-dependent health inequality
with a conservative bounded search and then apply:

- per-market maximum input;
- maximum share of current Morpho borrow liquidity;
- minimum maturity runway;
- oracle freshness;
- quote age; and
- a mode-specific safety buffer.

The UI should call this **capital multiple**, not PT collateral leverage, and
show actual LTV and liquidation buffer separately.

### Return presentation

The current Market Mode estimate:

```text
PT APY * leverage - borrow APY * debt multiple
```

is not valid for Mint Mode.

In full Mint Mode, holding both PT and YT recreates underlying/SY-like exposure,
while only PT is pledged. The strategy is approximately:

```text
gross underlying/SY return on E + D
- borrow cost on D
- conversion and gas costs
```

In the hybrid, the equity leg still earns fixed PT economics while the borrowed
leg has combined PT+YT economics.

Use Pendle's current `details.underlyingApy` enrichment as the displayed
underlying/SY yield reference. The Mint return estimate is a rate-only
projection at the selected capital multiple. Label it as an estimate based on
Pendle-reported underlying APY and explicitly exclude route conversion, fees,
slippage, and gas. If that field is unavailable, keep the Estimated loop APY
card visible and mark it unavailable rather than falling back to PT implied
APY.

Keep the same five economics fields in both modes:

- Estimated loop APY;
- estimated debt;
- PT supplied as collateral;
- current LTV;
- drop to liquidation.

For Mint Mode, PT collateral and drop to liquidation must come from the
binding quote's guaranteed PT, current Morpho oracle, debt, and LLTV. Keep
minimum YT delivered to the wallet as an additional execution-preview detail;
YT never contributes to LTV or liquidation distance.

The selected-market PT APY and raw PT-minus-borrow spread remain visible in
both modes as market context. They are not the Mint strategy return.
- conversion price impact and gas.

Do not silently substitute PT implied APY. Rewards and points embedded in YT
should be described but not valued unless OpenPendle has a reliable source.

## Product and lifecycle behavior

### Toggle

Market Mode remains the default. The switch should be available for new
positions and risk-increasing actions when the exact market passes the
Mint-specific runtime policy.

Suggested copy for full Mint Mode:

> Mint PT+YT from your capital and borrowed capital. PT is supplied as
> collateral; YT is sent to your wallet and is not collateral.

If the hybrid is chosen, the copy must say that only borrowed capital is
minted.

The selected mode must be included in:

- URL/view state;
- quote and preview identity;
- execution fingerprint;
- minimal pending recovery metadata; and
- recovery verification.

Changing modes invalidates the old preview. Lock the switch while signing,
broadcasting, confirming, or recovering a transaction.

### Position semantics

Mode is attached to an action, not permanently to an on-chain position. Morpho
stores PT collateral and loan-token debt; it does not preserve how PT was
acquired. A later increase may use either mode.

### YT ownership

YT is an independent wallet asset:

- transferring or selling it does not change Morpho health;
- it changes the economics of the strategy;
- existing wallet YT must not be presented as if all of it came from this loop;
  and
- at maturity it has no future yield exposure, although historical rewards may
  still be claimable.

Verify delivery from transaction logs or a baseline-aware balance delta for at
least `Ymin`. A Morpho position change alone is insufficient proof.

### Reduction and exit

Existing reductions and exits can remain mode-agnostic: sell PT, repay debt,
and return remaining PT/loan-token funds. They must not require or pull YT,
because the user may already have sold or transferred it.

Because the chain does not preserve acquisition provenance, use this copy for
every PT-loop exit rather than trying to detect a Mint-origin position:

> Close debt and withdraw PT collateral. YT remains in your wallet.

A later optional **recombine PT+YT** exit could use matching wallet YT to redeem
PY into the underlying before repayment. That requires a separate YT approval,
quote, and recovery design and is not an MVP dependency.

### Maturity

Disable new Mint entries and increases before expiry using a configured
inclusion margin, not only once the expiry timestamp has passed. Existing
reduction, repayment, recovery, and matured-PT redemption paths must remain
available.

## Runtime policy and recovery

Add a separate Mint capability to the runtime policy, including:

- independent `mintEntry` and `mintIncrease` switches;
- exact market allowlist;
- maximum user input;
- maximum debt;
- maximum share of live borrow liquidity;
- minimum maturity runway;
- route/aggregator allowlist version; and
- required Router selector/facet/code pins.

An incident must be able to disable Mint risk-increasing actions without
disabling Market Mode, reduction, exit, repayment, or pending recovery.

Mint also needs a separate build-time gate alongside the current looping beta
flags. The existing same-origin v1 policy parser rejects unknown keys, so adding
Mint fields directly to `looping-execution-policy.v1.json` would pause current
Market entry. Prefer a parallel Mint policy file/schema for the first rollout.
If a combined v2 policy is preferred, deploy backwards-compatible parser
support before switching the served policy. Never make the policy migration
itself a Market Mode outage.

Extend pending state with a closed, versioned Mint schema containing:

- mode and action;
- exact YT and market identity;
- minimum YT delivery;
- bounded debt assets/shares;
- expected position/auth bounds; and
- receipt-log verification requirements.

Keep it within the existing small recovery-record budget. Quote payloads,
identifiers, expiries, calldata, transaction requests, and signatures are
compiler-time data and must never be persisted. Quote freshness remains part of
the preview/execution fingerprint and signed-state revalidation.

Preserve the current discipline: simulate the unsigned bundle, persist pending
state before signatures, revalidate live state before signing and broadcasting,
broadcast once, wait for confirmations, and never auto-retry an ambiguous
submission.

## Local implementation snapshot

The local implementation now includes:

- full Mint entry and borrowed-leg Mint increases;
- direct `VOID` and reviewed `KYBERSWAP` v3 Convert routes;
- exact YT identities, explicit PT/YT decimal pins, and Mint Router facet/code
  pins for all reviewed markets;
- discriminated Market/Mint previews and signed bundles;
- PT-only Morpho collateral accounting and YT-to-wallet receipt verification;
- independent disabled-by-default Mint build and runtime gates;
- mode-bound URL, preview, execution fingerprint, and pending recovery state;
- Market/Mint selectors for new loops and risk-increasing adjustments; and
- mode-aware sizing, presentation, registry, policy, pending, and compiler tests;
  and
- fresh Ethereum, Monad, and Arbitrum compiler-fork lifecycles covering Mint
  entry, Mint increase, Market-based partial decrease, full exit, direct rescue,
  and post-expiry exit.

Market Mode remains the default. Mint writes cannot run from an ordinary local
or production build unless both the base entry gate and the separate Mint gate
are deliberately enabled. Reduction, exit, and recovery do not depend on the
Mint gate.

Production work remains intentionally out of scope here: a lifecycle-filtered
runtime allowlist, a burner-wallet canary, rollout approval, and activation of
the disabled production Mint policy.

## Implementation and rollout checklist

P1 through P4 are implemented locally and retained below as an audit checklist.
The current-market P0 audit is complete; P5 production actions remain open.

### P0 — Product decision and market audit

1. Confirm full versus hybrid semantics.
2. Audit all 22 current entry markets for exact YT, decimals, SY inputs, mint
   quote shape, aggregator path, maturity, and Router facet. **Complete for the
   2026-07-23 registry snapshot.**
3. Select:
   - one direct-SY-input canary; and
   - one aggregator canary.
4. Set initial per-market caps and maturity runway.

### P1 — Types, registry, and quote compiler

Likely touchpoints:

- `app/src/lib/loopingAbi.ts`
- `app/src/lib/loopingRegistry.ts`
- `app/src/lib/loopingMarketManifest.ts`
- `app/src/lib/loopingExecution.ts`
- `app/src/lib/loopingBeta.ts`
- `app/src/lib/loopingRuntimePolicy.ts`
- a parallel Mint policy file/schema, or a staged compatible policy v2
- deployment/environment configuration for the Mint build flag

Work:

1. Add discriminated `market` and `mint` acquisition types.
2. Add/pin exact YT identity for every market.
3. Add `mintPyFromToken` ABI and selector/facet/code checks.
4. Implement the strict v3 mint-route decoder and validator.
5. Produce a preview containing guaranteed PT, guaranteed YT, debt bounds, LTV,
   liquidation buffer, quote expiries, and cleanup invariants.
6. Add the separate Mint build gate and runtime policy without changing
   the accepted shape of the live Market v1 policy.

### P2 — Execution, verification, and recovery

Likely touchpoints:

- `app/src/lib/loopingExecution.ts`
- `app/src/hooks/useLoopingExecution.ts`
- `app/src/lib/loopingPending.ts`

Work:

1. Compile the full or hybrid atomic call sequence.
2. Use exact temporary Router approvals and clear them after each leg.
3. Supply only guaranteed PT.
4. Sweep all YT, excess PT, and loan-token dust.
5. Include mode and both routes in the execution fingerprint.
6. Verify debt/collateral bounds, YT delivery, authorization revocation,
   allowance cleanup, and no transaction-created adapter/Bundler residual
   balance delta. Do not require absolute zero because unrelated tokens may have
   been donated before execution.
7. Preserve the repay-with-wallet-funds rescue path.

### P3 — Math and UI

Likely touchpoints:

- `app/src/lib/looping.ts`
- `app/src/pages/LoopingPage.tsx`
- `app/src/components/looping/LoopingExecutionPanel.tsx`

Work:

1. Add conservative Mint sizing and a quote-dependent maximum-capital solver.
2. Add the mode switch and explanatory copy.
3. Keep Estimated loop APY, estimated debt, PT collateral, current LTV, and
   drop to liquidation visible in both modes; use quote-backed Mint risk
   values.
4. Show actual LTV, liquidation buffer, maturity runway, borrow cost, and
   separate YT-to-wallet output.
5. Keep PT APY and raw spread visible as market context, but calculate Mint
   return from Pendle-reported underlying APY rather than PT implied APY.
6. Keep the selected mode through preview/execution and invalidate stale
   cross-mode previews.
7. Clarify that close/reduce leaves YT in the wallet.

### P4 — Deterministic and fork tests

Extend the existing looping safety, execution, pending, UI, registry, runtime
policy, and fork suites.

Required positive cases:

- full or hybrid initial entry, matching the chosen semantics;
- Mint-based leverage increase on an existing position;
- direct-SY-input and aggregator routes;
- exact minimum PT supplied and minimum YT delivered;
- excess PT/YT and dust returned;
- Market-based reduction and exit after a Mint increase;
- exit succeeds when the wallet has no YT;
- recovery succeeds after reload; and
- 6/18-decimal combinations and conservative rounding.

Required adversarial cases:

- wrong Router, selector, facet, receiver, PT, YT, SY, input token, or amount;
- unequal PT/YT outputs or insufficient `minPyOut`;
- unreviewed aggregator/executor or changed code hash;
- nonzero native value, fee/permit side path, or unsupported calldata shape;
- expired/stale quote or a mode switch after preview;
- callback mint failure, collateral shortfall, borrow-liquidity failure, or
  slippage;
- YT transfer failure;
- stale oracle, insufficient health buffer, cap breach, and maturity crossing;
- transaction revert/replacement/drop and receipt-verification failure;
- residual allowances, temporary Morpho authorization, or
  transaction-created adapter balance deltas; and
- Mint policy disabled while reduction, exit, rescue, and recovery remain
  available.

Every callback failure test must prove full rollback: no new debt, no lost user
tokens, no persistent authorization, and no transaction-created residual
balance. Use pinned-block balance snapshots or exact sweep Transfer logs rather
than assuming the adapter and Bundler began at absolute zero.

### P5 — Controlled rollout

1. Ship locally with Mint writes disabled.
2. Run read-only live preflight for every intended market.
3. Pass fork lifecycles for the direct and aggregator canaries on current chain
   forks.
4. Only with separate explicit authorization, run one tiny burner-wallet
   round-trip canary.
5. Enable one market behind the independent Mint runtime gate and exact
   lifecycle-filtered allowlist.
6. Expand market by market only after exact quote and fork evidence.

No release step may impair existing reduction, exit, rescue, or recovery paths.

## Definition of done

Mint Mode is ready for a production proposal only when:

- the full/hybrid semantic decision and UI copy are approved;
- every enabled market has an exact YT and reviewed quote route;
- all route calldata is decoded and fail-closed;
- conservative quote-dependent sizing passes property tests;
- direct and aggregator fork lifecycles pass;
- YT delivery and cleanup are receipt-verified;
- Market Mode regressions pass unchanged;
- Mint has an independent kill switch and exact runtime allowlist; and
- exit, repayment, rescue, and recovery remain available when Mint is disabled.

## Primary references

- [Pendle PT Looping and Mint Mode](https://docs.pendle.finance/pendle-v2/AppGuide/PTLooping)
- [Pendle Hosted SDK / Convert API](https://docs.pendle.finance/pendle-v2-dev/Backend/HostedSdk)
- [Pendle Router overview](https://docs.pendle.finance/pendle-v2-dev/Contracts/PendleRouter/PendleRouterOverview)
- [Pendle Router contract integration guide](https://docs.pendle.finance/pendle-v2-dev/Contracts/PendleRouter/ContractIntegrationGuide)
- [Pendle deployments](https://docs.pendle.finance/pendle-v2-dev/Deployments)
- [Morpho Bundler3 documentation](https://legacy.docs.morpho.org/bundlers/contracts/bundler3/)
- [Morpho Bundler3 tutorial](https://legacy.docs.morpho.org/bundlers/tutorials/bundler3-solidity/)
- [Bundler3 source](https://github.com/morpho-org/bundler3/blob/main/src/Bundler3.sol)
- [GeneralAdapter1 source](https://github.com/morpho-org/bundler3/blob/main/src/adapters/GeneralAdapter1.sol)
- [Morpho Blue collateral callback source](https://github.com/morpho-org/morpho-blue/blob/main/src/Morpho.sol)
