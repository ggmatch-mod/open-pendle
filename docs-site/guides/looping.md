# PT looping

OpenPendle's **Looping** page finds Morpho markets whose collateral exactly matches a live Pendle Principal Token, then models what borrowing against that PT could do to yield and liquidation risk.

::: warning Preview boundary
The directory, leverage calculator, and human-readable entry and exit outline are live. **Token approvals, authorization signatures, and transaction execution are disabled.** The page cannot open or close a loop yet.
:::

## What the directory shows

Each candidate is an exact same-chain identity match between:

- a factory-indexed Pendle PT; and
- the collateral token in a Morpho market tuple.

The directory keeps Pendle and Morpho identifiers visible and distinguishes Morpho-listed markets from permissionless tuples. Filters let you choose a network, listing status, whether borrow liquidity is currently available, and sort order.

Borrow liquidity is the value currently available to borrow on Morpho. It is not the market's total supplied assets or Pendle pool TVL. The current filter separates markets with reported borrowable liquidity from dry markets; the displayed USD amount can still be unavailable.

## Model leverage and APY

Select a market, enter an equity amount, and set the leverage and stress assumptions. The calculator estimates:

- gross PT exposure;
- borrowed amount;
- loop APY using the current PT and borrow APYs;
- current LTV; and
- a simplified collateral-price drop to liquidation.

The model checks the entered leverage against the market's LLTV, your chosen safety buffer, and your collateral-price stress. These controls do not define a safe maximum: oracle basis, rate changes, route execution, depeg, liquidity cliffs, and contract risk can move the real boundary.

The APY figure holds the displayed PT and borrow rates constant. It excludes fees, slippage, borrow-rate impact, and compounding path changes unless the page states otherwise. Treat it as a comparison tool, not a promised return.

## What the transaction outline means

After you model a scenario, the page can show a human-readable outline of the separate entry and exit transactions a live implementation would need. It lists approvals, safety gates, finite values that would have to be refreshed, and post-transaction checks.

This outline is not calldata, a route quote, or a simulation. It does not inspect your wallet, reserve liquidity, request a signature, or authorize OpenPendle to move funds.

## Why execution is disabled

A production entry must safely coordinate an approval, two sequential Morpho authorization signatures, an atomic conversion/supply/borrow callback, state revalidation, gas bounds, recovery, and post-transaction checks. Reusable authorization signatures must not be sent to an ordinary browser RPC for simulation because the RPC operator could submit them independently.

OpenPendle will enable execution only after the complete entry and unwind paths have passed funded tests with cleanup and recovery verified. Until then, use Looping to compare markets and understand the risk envelope.

## Before using a future live loop

- Understand the collateral asset, SY, oracle, LLTV, and maturity.
- Check both borrow liquidity and Pendle exit liquidity.
- Use a meaningful liquidation buffer rather than treating the protocol LLTV as a target.
- Expect borrow APY and PT APY to change independently.
- Plan the unwind before opening; maturity does not automatically repay Morpho debt.

## See also

- [Principal Tokens](/concepts/principal-tokens) — what PT represents.
- [Maturity & redemption](/concepts/maturity) — what changes at expiry.
- [Risks & disclosures](/reference/risks) — interface, market, oracle, and third-party risks.
- [Quickstart](/introduction/quickstart) — the rest of OpenPendle.
