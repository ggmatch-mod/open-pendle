# Buying PT (fixed yield)

Buying **PT** swaps an input token through the Pendle AMM for the market's [Principal Token](/concepts/how-pendle-works#stage-2-split-principal-from-yield). The executed PT price determines the fixed return in accounting-asset terms if you hold until maturity.

This guide covers the immediate AMM swap. A [PT limit order](/guides/limit-orders) instead targets an APY and waits for a taker on markets supported by Pendle's order service.

::: warning Fixed rate does not mean risk-free
PT removes uncertainty about the yield rate at the executed price. It does not remove underlying-asset, SY, smart-contract, depeg, or early-exit price risk. Read the market's trust panel first.
:::

## Before you start

1. Open the `PendleMarket` on its correct chain.
2. Review the underlying, SY owner and upgradeability, maturity, and liquidity.
3. Connect an injected wallet on that chain.
4. Hold an input token offered by the market's swap panel and enough native gas token.

A matured market no longer accepts swaps; use its PT redemption flow instead.

## 1. Choose Buy → PT

On the market page, open the swap action, choose **Buy**, then **PT**. Select SY or another input supported by the market's SY.

The router handles any required wrapping and AMM trade in one action. You do not need to mint PT + YT or hold SY first unless you deliberately want those lower-level flows.

## 2. Enter an amount

Enter how much of the input token to spend. OpenPendle requests a RouterStatic estimate as you type.

Larger orders can move the AMM price more than smaller ones. Keep enough of the chain's native token for gas, especially when the input is also the native token.

## 3. Review the estimate

The production quote card shows:

| Field | Meaning |
| --- | --- |
| **You receive (estimated)** | Expected PT output from RouterStatic. |
| **Minimum after slippage** | The lowest PT output encoded for the transaction. |
| **Price impact** | Estimated effect of this trade on the pool price. |
| **Implied APY after trade** | Current market APY compared with the estimated post-trade APY. |
| **Market swap fee** | Pendle market fee expressed in SY. |

The estimate is indicative. OpenPendle also checks trade size and the pool's PT-proportion limit, warning or blocking when the route is likely to exceed the AMM boundary.

Set slippage deliberately. A tight tolerance can revert if the pool moves; a loose tolerance accepts a worse fill. OpenPendle applies a 0.05% minimum to static-derived minimum-output calculations when your setting is lower.

## 4. Approve if needed

If the input is an ERC-20 and Pendle's Router V4 lacks sufficient allowance, OpenPendle asks for approval before the swap.

- **Exact** is the default and approves the required amount.
- **Unlimited** is available only through transaction settings and leaves a standing allowance until revoked.
- Native-token inputs do not require an ERC-20 approval.

An existing sufficient allowance skips this step.

## 5. Review the binding simulation

Before the confirm button becomes active, OpenPendle simulates the planned call against the live chain. The binding status shows the expected PT output and encoded minimum.

Check that:

- the input token and amount are correct;
- expected and minimum PT output are acceptable;
- the wallet and active network match the market; and
- the market has not moved beyond your tolerance.

A successful simulation verifies transaction mechanics at that block. It does not endorse the asset or guarantee that state will remain unchanged until inclusion.

## 6. Confirm

Confirm the swap in your wallet. Once mined, the router delivers PT to your address and OpenPendle links to the transaction.

OpenPendle adds no fee. Pendle's market fee and network gas still apply; the market fee is included in the displayed route estimate.

## What you hold

PT is an ERC-20 for one market and maturity. Before maturity:

- its price changes with time and the market's implied APY;
- selling early executes at the then-current AMM price; and
- only holding through maturity preserves the fixed-rate outcome implied by your executed entry price.

Save the market if you want a browser-local path back to it, and use [Positions](/guides/positions) to track balances across Saved and Pendle Official pools.

## Redeem after maturity

At maturity, trading stops and PT can settle through the market's SY at the stored PY index. Open the matured market and use **Redeem PT**; no matching YT is required.

The page estimates the SY or supported output token, applies the appropriate minimum, simulates, and then asks for confirmation. A depeg warning appears when the SY's live exchange rate is below the redemption index: in that case the unwrapped output can be worth less than one accounting-asset unit even though Pendle's index settlement is functioning.

There is no fixed redemption deadline, but asset, SY, and contract risks remain after maturity.

## See also

- [Principal Tokens](/concepts/how-pendle-works#stage-2-split-principal-from-yield)
- [Settlement at maturity](/concepts/how-pendle-works#stage-4-settle-at-maturity)
- [PT limit orders](/guides/limit-orders)
- [Opening a pool](/guides/opening-a-pool)
- [Risks & disclosures](/reference/risks)
