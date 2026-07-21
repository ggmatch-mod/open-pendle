# Providing liquidity

Providing liquidity deposits into a Pendle PT/SY AMM and returns LP tokens representing a share of its reserves. LPs can earn swap fees and any separately funded incentives, while remaining exposed to the assets and changing reserve mix.

::: warning LP positions can lose money
Factory provenance does not verify the underlying asset or SY. LPs also face price movement, impermanent loss, liquidity, and smart-contract risk. Read the trust panel and [Risks & disclosures](/reference/risks) before depositing.
:::

## Before you start

You need:

- a live market on the correct chain;
- a connected injected wallet;
- the required deposit token or token pair; and
- enough native gas token.

Adding liquidity stops after maturity. Removing or exiting remains available.

## Add liquidity

Open the market's liquidity action and choose one of two modes.

### Balanced add

Balanced mode deposits PT plus SY, or PT plus an accepted token that the router wraps into SY. The interface derives the matching side at the current reserve ratio.

Because this mode adds at the pool ratio, it does not perform an AMM swap and has no swap price impact. Review the estimated LP output and minimum before confirming.

### Zap in

Zap mode accepts one token and routes it into an LP position. With **Keep YT** off, the router converts the position into LP only and the internal AMM path can have price impact.

With **Keep YT** on, part of the deposit is minted into PT + YT, the PT/SY sides are added at the current pool ratio, and the YT is returned to your wallet. The kept YT is a separate yield position; it is not part of the LP token and will not be returned when you remove liquidity.

For either mode:

1. Select the deposit token or pair.
2. Enter an amount and review estimated LP output, any kept YT, and minimums.
3. Approve ERC-20 inputs if needed.
4. Review the binding simulation.
5. Confirm in your wallet.

Exact approval is the default. Unlimited approval is an explicit higher-exposure option.

## Where returns come from

An LP position can receive:

- **Pendle swap fees**, which accrue through pool activity;
- **SY yield, SY-native rewards, and PT accretion** reflected in the position;
- **PENDLE incentives**, when the market is currently eligible under Pendle's live whitelisting and [Algorithmic Incentive Model](https://docs.pendle.finance/pendle-v2/ProtocolMechanics/Mechanisms/Incentives); and
- **external campaign rewards**, including Merkl when a third party has funded a supported campaign.

Eligibility and allocations can change independently of OpenPendle's Listed or Community labels. [Positions](/guides/positions) can claim Pendle-native interest and rewards from eligible Saved and Pendle Official markets, and separately surfaces wallet-wide Merkl rewards where supported. Merkl is OpenPendle's current external-campaign claim integration, not the only reward mechanism a market could use. OpenPendle adds no fee of its own.

Displayed fee APR or incentives are individual components, not a promised total return. Reserve-value changes and impermanent loss can offset them.

## Remove liquidity before maturity

Choose one of two exit modes:

- **Balanced remove** burns LP for its pro-rata PT and SY reserves. No AMM swap is used.
- **Zap out** burns LP and sells the PT component through the pool to return one selected token. This path can have price impact and slippage.

Enter any amount up to your LP balance, review the estimated outputs and minimums, approve the LP token if needed, then simulate and confirm. A partial removal leaves the remainder invested.

Any YT previously retained through **Keep YT** remains a separate wallet position and is unaffected by the LP removal.

## Exit after maturity

At maturity, swaps and new deposits stop. OpenPendle replaces the live liquidity panel with **Exit LP**:

1. Enter the LP amount.
2. Optionally include loose PT from the wallet.
3. Choose SY or a supported token output.
4. Review the breakdown: SY from the LP burn, PT settled at the stored index, and total output.
5. Simulate and confirm.

The matured exit does not depend on an AMM swap, so it has no swap price impact or pool-liquidity dependency. Token unwrapping can still have its own output minimum, and underlying/SY risk continues after maturity.

Maturity ends swap-fee accrual; it does not freeze the economic value of the asset or guarantee an unwrapped one-for-one payout. The app displays a depeg warning when the SY exchange rate falls below the redemption index.

Accrued YT interest and rewards can remain claimable after maturity. Check [Positions](/guides/positions) before treating the position as closed.

## Main risks

- **Underlying and SY risk:** a depeg, pause, accounting failure, or hostile upgrade can impair the whole position.
- **Impermanent loss:** changing implied APY alters the PT/SY reserve mix and can make an early LP exit worse than holding the components.
- **Execution risk:** zap routes use the AMM and can suffer price impact or stale quotes.
- **Incentive risk:** Pendle eligibility and allocations are mutable; external campaigns are separately funded and can end.
- **Allowance and RPC risk:** Unlimited approvals leave standing exposure, and every check depends on the selected RPC's chain view.

## See also

- [Trading PT and YT](/concepts/how-pendle-works#stage-3-trade-pt-and-yt)
- [Positions & rewards](/guides/positions)
- [Settlement at maturity](/concepts/how-pendle-works#stage-4-settle-at-maturity)
- [Pool incentives](/create/incentives)
- [Risks & disclosures](/reference/risks)
