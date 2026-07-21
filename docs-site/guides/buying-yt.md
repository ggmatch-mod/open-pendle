# Buying YT (yield exposure)

Buying **YT** takes a long position on the underlying asset's yield until maturity. YT receives that yield while it remains live, then has no future token value after expiry.

If realized yield does not compensate for the price paid and the token's decay, the position loses money. Read [Yield Tokens](/concepts/how-pendle-works#fixed-yield-versus-long-yield) before using this action.

::: warning YT is a leveraged yield position
A relatively small payment can control the yield of a larger notional. That increases upside and downside. Underlying, SY, liquidity, and smart-contract risks still apply.
:::

## Before you start

1. Open the market on its correct chain.
2. Read the trust panel and maturity date.
3. Compare the current implied APY with your own view of future realized yield.
4. Connect an injected wallet only when ready to transact.

If you want the fixed-rate leg rather than variable yield exposure, see [Buying PT](/guides/buying-pt).

## 1. Choose Buy → YT

On the market page, open the swap action, choose **Buy**, then **YT**. Select SY or another token accepted by the market's SY.

Pendle's Router V4 handles wrapping and the AMM route. The YT amount can be much larger than the input-token amount because it represents yield on a larger notional; it is not a one-for-one token purchase.

## 2. Review the estimate

Enter an input amount. The production quote card shows:

| Field | Meaning |
| --- | --- |
| **You receive (estimated)** | Expected YT output from RouterStatic. |
| **Minimum after slippage** | The lowest YT output encoded for the transaction. |
| **Price impact** | Estimated effect of this trade on the pool price. |
| **Implied APY after trade** | Current market APY compared with the estimated post-trade APY. |
| **Market swap fee** | Pendle market fee expressed in SY. |

The market page separately shows maturity and current implied APY. Use those as context for your yield view; OpenPendle does not display a guaranteed breakeven return.

YT buys can push the pool toward Pendle's PT-proportion cap. OpenPendle warns near the limit and blocks an estimated route beyond it. Thin pools can also produce high price impact or fail to quote.

Set slippage deliberately. OpenPendle applies a 0.05% minimum to static-derived minimum-output calculations when your setting is lower.

## 3. Approve if needed

For an ERC-20 input, the router needs allowance:

- Exact approval is the default.
- Unlimited approval is an explicit, higher-exposure transaction-setting option.
- A sufficient existing allowance skips approval.
- A supported native-token input requires no ERC-20 approval.

Approval and swap are separate transactions.

## 4. Review the binding simulation

OpenPendle simulates the planned swap before enabling confirmation. The binding status shows expected and minimum YT output.

Confirm that the token, amount, chain, and output match your intent. A successful simulation checks the route at the current block; it does not prove that the underlying will generate the yield you expect.

## 5. Confirm

Confirm in your wallet. Once mined, YT is delivered to your address and begins carrying that market's future yield entitlement.

OpenPendle adds no fee. Pendle market fees, YT interest fees, and network gas can still apply through Pendle's contracts.

## Monitor or exit

While live, YT both accrues yield and loses remaining time value. Judge the position using:

- yield accrued and claimed;
- current YT exit value;
- remaining time to maturity;
- current implied versus realized yield; and
- asset and SY health.

You do not have to hold until maturity. **Sell → YT** swaps the token back through the AMM at the current price. That exit uses the same estimate, approval setting, simulation, and slippage protections.

## At maturity

At maturity:

- the AMM stops trading;
- YT has no future token value; and
- accrued but unclaimed interest or rewards can remain claimable.

Open the market or [Positions](/guides/positions) to claim residual interest and rewards. Do not discard or ignore a matured YT position until you have checked those claimables.

## See also

- [Yield Tokens](/concepts/how-pendle-works#fixed-yield-versus-long-yield)
- [Buying PT](/guides/buying-pt)
- [Positions & rewards](/guides/positions)
- [Settlement at maturity](/concepts/how-pendle-works#stage-4-settle-at-maturity)
- [Risks & disclosures](/reference/risks)
