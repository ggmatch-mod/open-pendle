# Minting & redeeming

Before maturity, Pendle converts an SY amount at the current index into **equal PT and YT quantities**. Holding the same PT and YT amount lets you recombine them into SY.

This changes token form rather than trading one leg against the AMM. Use it when you want both PT and YT, or already hold a matched pair. If you want only one leg, an immediate [PT](/guides/buying-pt) or [YT](/guides/buying-yt) swap is usually simpler.

::: warning The SY still matters
Minting and redeeming depend on the market's underlying asset and SY. Market provenance does not verify either one; read the trust panel first.
:::

## Mint, redeem, or swap?

| Goal | Action |
| --- | --- |
| Hold equal PT and YT units | Mint from SY or an accepted input token. |
| Return a matched PT + YT pair to SY | Redeem the pair. |
| Hold only PT or only YT | Use a swap through the AMM. |
| Settle PT after maturity | Use the matured PT redemption flow; no YT is needed. |

The PT/YT split itself does not use the AMM curve. Wrapping an input into SY or unwrapping SY to an output token still depends on the SY's conversion behavior and the minimum shown by the interface.

## Mint PT + YT

1. Open a live market and review its trust panel.
2. Choose **Mint**.
3. Select SY or another input exposed by that SY.
4. Enter an amount and review the estimated equal PT and YT output.
5. Approve the input if needed.
6. Review the binding simulation, then confirm in your wallet.

An ERC-20 approval is exact by default. Unlimited approval is available only as an explicit transaction-setting opt-in. Supported native-token inputs do not need an ERC-20 approval.

The router can wrap an accepted token into SY and mint the pair in one transaction, so you do not need to hold SY beforehand.

## Redeem PT + YT before maturity

Before maturity, redemption requires matched PT and YT amounts.

1. Choose **Redeem**.
2. Enter an amount up to the smaller of your PT and YT balances.
3. Choose SY or a supported token output.
4. Approve PT and YT if their current allowances are insufficient.
5. Review the estimate and binding simulation, then confirm.

Unmatched PT or YT remains in the wallet. To exit a single leg before maturity, sell it through the AMM instead of using Redeem.

## Approvals and simulation

Mint and redeem follow the same transaction lifecycle as other on-chain actions:

- check balances and existing allowances;
- request exact approval by default, or use the explicit Unlimited setting;
- estimate output and encode a minimum;
- simulate at the current block; and
- enable confirmation only after simulation succeeds.

OpenPendle calls Pendle's Router V4 and adds no fee of its own. Pendle protocol fees and network gas can still apply.

## After maturity

At maturity, swaps, minting, and pre-maturity pair redemption stop. The market page switches to its matured actions:

- **Redeem PT** settles PT through SY at the stored PY index; no YT is required.
- **Exit LP** burns LP and settles its PT component without an AMM swap.
- **Claimables** can include YT interest and token rewards accrued before maturity.
- **Wrap / Unwrap** can remain available when supported by the SY.

YT has no future token value after maturity, but accrued claimables may remain. Check them before treating the position as finished.

PT settlement should not be described as an unconditional one-underlying payout. If the SY's live exchange rate falls below the redemption index, the app warns that unwrapped output can be worth less than one accounting-asset unit. See [settlement at maturity](/concepts/how-pendle-works#stage-4-settle-at-maturity).

## Unsupported or unusual inputs

The available input and output tokens come from the SY. Fee-on-transfer, rebasing, malformed, paused, or otherwise incompatible assets can fail during preview or simulation. Simulation helps avoid sending a reverting transaction; it does not make the asset safe.

## See also

- [How Pendle works](/concepts/how-pendle-works)
- [Buying PT](/guides/buying-pt)
- [Buying YT](/guides/buying-yt)
- [Settlement at maturity](/concepts/how-pendle-works#stage-4-settle-at-maturity)
- [Risks & disclosures](/reference/risks)
