# Creating a pool

OpenPendle can deploy a brand-new Pendle V2 market — permissionlessly, from your own wallet, on any supported network.

::: warning This is an advanced action
Creating a pool deploys **real contracts** and seeds **real liquidity**. You're interacting with a permissionless protocol; there's no undo. Make sure you understand what you're wrapping and that the token behaves normally (see the blocked-token notes below).
:::

## The two pieces: SY, then the market

A Pendle market is built on a **Standardized Yield (SY)** token wrapping a yield-bearing asset. So there are two paths:

1. **You already have an SY** for your asset → go straight to deploying the market.
2. **You need an SY** → create one first with the **SY wizard**, then deploy the market.

OpenPendle can do both, and can deploy the SY and the market **in a single transaction** via Pendle's `PendleCommonPoolDeployHelperV2`.

## Creating the SY

SYs are minted from Pendle's permissionless **`PendleCommonSYFactory`**, which exposes a set of registered templates — **7 template ids** in total: 3 basic wrappers, 3 "with-adapter" variants, and 1 no-redeem/no-deposit upgradeable variant. The wizard picks the right one for your asset.

A few things the wizard handles or blocks:

- **Fee-on-transfer tokens are blocked.** They break SY accounting and liquidity seeding.
- **Rebasing tokens are blocked.** They break redemption.
- **The asset is an ERC-20 or ERC-4626 token.** SY templates wrap a standard token — there is no native-ETH SY template. (Native ETH can still *seed* a pool below, but only if the SY it wraps already accepts it.)
- **Ownership.** Wizard-deployed SYs default their owner to Pendle's governance proxy.

> "One-click adapter SY" deploys only the SY shell. The adapter contract itself is a separate, per-asset contract that the factory does not deploy — an exotic asset may need its own adapter first.

## Deploying the market

Once an SY exists, the pool deploy:

- creates the PT/YT (yield) contracts and the market,
- **seeds initial liquidity**, and
- returns the **LP and YT** to you (the SY ownership goes to the SY's owner).

You seed with a token the SY accepts. If that token is **native ETH** (the SY lists `address(0)` among its inputs), the deploy sends ETH directly with no approval step; otherwise you approve the exact seed amount first.

When it succeeds, OpenPendle shows the **new market address**, an **"Open the pool"** button (which loads it live so you can save it and trade), and a block-explorer link.

## Optional: initialize the price oracle

A fresh market starts with a TWAP oracle cardinality of **1**. A one-time **cardinality bump** (`increaseObservationsCardinalityNext` on the market) lets the pool record enough price observations for robust TWAP pricing — which **other** protocols rely on (lending markets that take the PT as collateral, dashboards, etc.).

It is **not required** to trade, add liquidity, or quote through OpenPendle — those work immediately. A one-click step is planned for a later release; for now, if you need it, call `increaseObservationsCardinalityNext` on the market contract from a block explorer. It's safe to skip.

## Incentives

Community pools **aren't eligible for native PENDLE gauge emissions or vePENDLE voting** — those are reserved for team-listed markets. To incentivize your pool, run a [Merkl](https://merkl.angle.money/) campaign; rewards then accrue to LPs off the native gauge system.

## Next

- [Networks &amp; contracts](/networks-and-contracts) — the factories and entry points a deploy uses.
- [Saved pools &amp; privacy](/saved-pools) — save the pool you just created.
