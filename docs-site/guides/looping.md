# PT looping

The **Looping** page matches live Pendle PTs with Morpho markets that use the exact same token as collateral. It compares current rates and offers two acquisition paths for reviewed markets:

- **Market Mode** buys PT with the user's capital and borrowed capital, then supplies the acquired PT as Morpho collateral.
- **Mint Mode** mints equal PT+YT from both capital sources, supplies only guaranteed PT as collateral, and sends YT to the user's wallet.

::: warning Reviewed markets only
Seeing a market in the directory does not make it executable. Entry is available only when the exact Pendle market, PT, Morpho tuple, SY route tokens, and deployed contracts match OpenPendle's reviewed registry, the release build enables entry, and the fresh same-origin runtime policy covers that market. Mint risk increases must also pass their independent Mint build flag and runtime policy. Any failed check pauses the action before a wallet request.
:::

## Find and compare markets

Each directory result is an exact same-chain match between a factory-indexed Pendle PT and a Morpho collateral token. Search by name or address, choose a network, require a positive PT-minus-borrow spread, set a minimum borrow-liquidity amount, and sort the results. Looping coverage is limited to networks available through Morpho's API, and the reviewed execution registry can be narrower.

**Borrow liquidity** is the USD value currently available to borrow from Morpho. It is not total supplied assets or Pendle pool TVL. Thin or unpriced markets can remain visible for research but cannot pass live risk-increasing execution checks.

Select a market and enter the amount to model:

- PT collateral and Morpho debt;
- estimated loop APY;
- current LTV and distance to liquidation;
- Market Mode stress assumptions; and
- minimum YT sent to the wallet after a Mint quote.

These are estimates, not quotes or promised returns. Rates, oracle value, liquidity, fees, slippage, and routes can change before a transaction is mined.

Market Mode estimates return from current PT and borrow rates. Mint Mode uses Pendle's reported underlying APY for the paired PT+YT exposure, less borrowing cost. Its estimate excludes conversion costs, fees, slippage, and gas. Mint collateral, LTV, and liquidation distance remain unavailable until a fresh quote supplies guaranteed PT and current Morpho risk values.

## Open a loop

For an enabled reviewed market, **Execute** prepares fresh Pendle buy or mint routes and reads the exact Morpho state and contract wiring through the connected wallet's RPC. It handles the exact token allowance, runs an unsigned simulation, then requests Morpho authorization and the final transaction.

OpenPendle builds one atomic Bundler3 transaction for the position-bearing step. If its callback, conversion, borrow, collateral supply, or cleanup fails, the transaction reverts rather than leaving a partial loop. The wallet owns the Morpho position; OpenPendle does not custody funds or deploy an intermediary contract.

In Market Mode, the leverage slider reaches the market-specific boundary that leaves a simplified **1% liquidation buffer**. The red marker shows the safer **10% buffer**. Mint Mode instead labels the slider as a **capital multiple** and rechecks guaranteed PT, LTV, and liquidation distance with the live quote. Every risk increase still fails below the hard live safety floor.

## Manage an existing loop

Open **Profile → Positions**, choose **Loop positions**, and select the relevant network. A clean OpenPendle-supported loop can:

- increase using Market Mode or Mint Mode, or decrease leverage; or
- fully exit by repaying all Morpho debt and returning the remainder to the wallet.

The acquisition mode belongs to each risk-increasing action; Morpho stores only PT collateral and debt. Increasing leverage uses the entry safety gates, with Mint requiring its additional release plane. Decreasing leverage and full exit use the separately gated exit path and never require or consume wallet YT. The entry policies can therefore pause new risk without removing an existing position or its recovery controls.

## Maturity and recovery

An expired PT is removed from new-loop discovery, but its reviewed identity remains in the permanent position-management registry. The matured position stays visible in **Positions**; leverage adjustment is disabled and **Full exit** uses Pendle's post-expiry PT redemption path before repaying Morpho debt.

Maturity does not repay the debt automatically. A one-transaction full exit also requires the redemption proceeds to cover all accrued debt. If they do not, OpenPendle blocks that route; the current interface does not provide a normal shortfall-top-up action, so the debt must be repaid and the collateral recovered through a separately verified manual workflow. Do not wait until expiry without enough gas and a reviewed plan to manage the position.

If a receipt or RPC response is ambiguous after signatures or a transaction, OpenPendle keeps the operation blocked and exposes bounded reconciliation, permission cleanup, or direct rescue as appropriate. Recovery is independent of the runtime entry policy.

## Risk checklist

- Verify the PT, underlying asset, SY, oracle, LLTV, maturity, and wallet network.
- Check both Morpho borrow liquidity and the available Pendle entry or exit route.
- In Mint Mode, treat YT as a separate wallet asset that can change the strategy's return but never supports the Morpho loan.
- In Market Mode, treat the 10% marker as a warning boundary, not a guarantee against liquidation.
- Expect PT APY, underlying APY, borrow APY, collateral value, and gas to change independently.
- Stop if the runtime policy, contract-state validation, route validation, or simulation fails.

## See also

- [Positions & rewards](/guides/positions)
- [Settlement at maturity](/concepts/how-pendle-works#stage-4-settle-at-maturity)
- [Risks & disclosures](/reference/risks)
