# Yield Tokens (YT)

A **Yield Token (YT)** is the pre-maturity claim on yield and rewards associated with a fixed amount of accounting-asset principal. Holding YT is a long-yield position: its result improves when realized yield and rewards exceed what the market priced in, after protocol fees and trading costs.

## Where YT comes from

Before maturity, SY value is converted at the current exchange-rate index into equal quantities of PT and YT:

- **PT** holds the accounting-asset principal claim.
- **YT** holds the associated yield and reward claim until maturity.

Equal PT and YT quantities can recombine into SY before maturity. One raw SY token does not necessarily mint one PT and one YT. See [How Pendle works](/concepts/how-pendle-works).

## What YT pays

YT can accrue:

- yield created by the SY's underlying source;
- SY-native reward tokens;
- points or other supported reward entitlements;
- external incentives where a campaign includes the position.

Pendle takes protocol fees from YT yield and points. Current official documentation describes a 5% fee, but the deployed rules and current [Fees documentation](https://docs.pendle.finance/pendle-v2/ProtocolMechanics/Mechanisms/Fees) are authoritative.

“YT receives all yield” should therefore be read as the tokenized position's yield entitlement **net of applicable protocol fees**, not a promise that every gross reward reaches the holder unchanged.

## Why YT reaches zero at maturity

YT is a claim on a shrinking future window. As time passes, part of the originally expected yield has already accrued and less remains.

At maturity, YT has no **future** yield entitlement and no terminal principal value. Its market can no longer trade. Already-accrued, unclaimed yield or rewards may still be claimable, so “YT is worth zero” does not mean accrued claims are erased.

YT's market price need not decline smoothly. Changes in expected yield, rewards, liquidity, and time can move it sharply before maturity.

## Implied yield as a hurdle

PT's market price implies a fixed APY to maturity. That rate is a useful benchmark for YT:

- realized yield above the implied rate generally helps YT;
- realized yield below it generally hurts YT;
- fees, points, rewards, entry price, holding period, and exit price determine the actual result.

“Realized APY equals implied APY” is therefore a rough breakeven intuition, not an exact profit formula.

## Illustrative example

Suppose a market has 60 days remaining and its prices imply roughly 10% annualized yield. A YT buyer pays for the right to the net yield and rewards associated with its principal notional during those 60 days.

- If the source realizes materially more than the priced rate, the collected value may exceed the YT purchase cost.
- If it realizes less, the collected value may not offset the YT's declining remaining value.

The exact result must use the execution price, actual accrual, protocol fees, reward value, and any early-sale proceeds. The example is directional, not a quote or guarantee.

## Trading before maturity

YT can be bought or sold while the market is active. Pendle routes the trade through the PT/SY AMM even though YT is not a standing reserve.

Selling early can realize a gain or loss before terminal value reaches zero. Liquidity and price impact matter, especially near maturity or in small Community markets.

OpenPendle quotes against current state and simulates the prepared transaction before requesting a signature. A later state change can still alter or revert execution.

## Risks

- **Yield underperformance.** The source may earn less than the market priced in.
- **Fee and reward uncertainty.** Fees reduce accrual; points and external rewards can be difficult to value or may change.
- **Time decay.** The remaining claim window continuously shortens.
- **Liquidity risk.** A thin market can make an early exit expensive or unavailable at the desired price.
- **Asset and SY risk.** A failing yield source, accounting asset, or wrapper can impair claims entirely.

YT is leveraged exposure to a rate without a borrowing liquidation mechanism, but that does not make it low risk. Its purchase price can be lost.

::: warning Know what produces the yield
OpenPendle validates market provenance, not whether the yield is real or sustainable. Review [Community pools](/concepts/community-pools) and [Risks & disclosures](/reference/risks) before buying YT.
:::

## See also

- [Buying YT](/guides/buying-yt)
- [Principal Tokens](/concepts/principal-tokens)
- [Maturity & redemption](/concepts/maturity)
- [Standardized Yield](/concepts/standardized-yield)
