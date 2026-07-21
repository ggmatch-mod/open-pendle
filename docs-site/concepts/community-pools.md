# Community pools & incentives

OpenPendle labels a market **Community** when it was created by a recognized Pendle factory but is absent from Pendle's current market catalog. The label describes how OpenPendle discovered the market. It does not prove who created it, whether anyone reviewed it, or whether it qualifies for incentives.

If SY, PT, and YT are new to you, start with [How Pendle works](/concepts/how-pendle-works).

::: warning Community is not a safety rating
OpenPendle has not reviewed or endorsed Community markets. A recognized factory can still create a market around a faulty, malicious, upgradeable, or economically fragile asset and SY. See [Risks & disclosures](/reference/risks).
:::

## Four facts that should stay separate

| Fact | What it means |
| --- | --- |
| **Factory provenance** | A recognized Pendle factory created the market. OpenPendle validates this before save or transaction actions. |
| **Pendle catalog status** | Pendle's current public catalog either lists the market or does not. OpenPendle uses this for the Pendle-listed / Community label. |
| **Incentive eligibility** | Pendle's live incentive system may or may not whitelist the market for PENDLE rewards. This can change independently of catalog display. |
| **Asset review** | A separate assessment of the asset, SY, owner, adapter, liquidity, and economics. OpenPendle does not perform one. |

Do not infer one row from another. In particular, factory provenance is not evidence that the asset is safe, and a catalog label is not a guarantee of current rewards.

A market's labels can also change over time. Pendle can add or remove catalog coverage, incentive whitelisting can change, and a third party can start or stop an external campaign. OpenPendle should present each as a live fact rather than turning today's state into a permanent category.

## Permissionless creation

Pendle's public factories and deployment helper allow any address to create a compatible market and supply its initial liquidity. No OpenPendle account or approval is involved.

Every resulting market uses Pendle's core PT/SY market mechanics, but its risk depends heavily on the SY and yield-bearing token beneath it. The factory establishes contract lineage; it does not assess solvency, upgrade authority, redemption behavior, or liquidity.

## Finding a Community market

OpenPendle supports several entry paths:

- Search **Explore**, which indexes recognized factory events and applies the current catalog label.
- Paste a `PendleMarket` address to open it directly.
- Paste PT or YT to open Token actions and attempt market resolution.
- Open a market saved in the browser-local registry.

An SY address alone cannot identify one maturity because several markets can share an SY. A newly created market can also be opened by address before it appears in the next Explore snapshot.

## Incentives today

Pendle's incentive model has changed over time. Current official documentation describes an **Algorithmic Incentive Model (AIM)** that allocates PENDLE to eligible, whitelisted markets using liquidity, fees, limit-order depth, co-incentives, and discretionary inputs. The legacy description of vePENDLE holders voting gauge weights is no longer the current allocation model; vePENDLE is being replaced by sPENDLE.

Because eligibility and rates are externally controlled and mutable, OpenPendle should not treat “Pendle-listed” or “Community” as a durable rewards rule. Verify current eligibility and reward data live. See Pendle's current [Incentives](https://docs.pendle.finance/pendle-v2/ProtocolMechanics/Mechanisms/Incentives) and [sPENDLE](https://docs.pendle.finance/pendle-v2/ProtocolMechanics/Mechanisms/sPENDLE) documentation.

The reward paths are economically distinct:

| Reward source | Typical eligible position | Who controls it |
| --- | --- | --- |
| **SY-native yield/rewards** | YT and LP according to Pendle/SY accounting | The underlying protocol and SY implementation |
| **PENDLE emissions** | Eligible whitelisted market positions | Pendle's live incentive configuration |
| **External campaign** | Whatever positions the campaign defines | Campaign funder and distributor |
| **Points** | Asset-specific rules, often tracked off-chain | The issuing protocol and its integration terms |

Do not add these APRs together without checking that they apply to the same position, period, and notional. A displayed campaign rate can be forward-looking while the claimable balance is already accrued and independently verifiable.

Community markets may also have rewards funded outside Pendle's native emission program. OpenPendle currently integrates **Merkl** claims on the Positions page where supported. That is an OpenPendle integration boundary, not a claim that Merkl is the only campaign or distribution mechanism a third party could use.

For any displayed reward:

- confirm the reward token and eligible position;
- check the funded period and remaining allocation;
- distinguish an estimated APR from accrued, claimable value;
- verify the distributor and transaction in your wallet.

OpenPendle's Positions page reads supported claims across pools saved in the current browser and market IDs discovered through Pendle Official Pools. It does not scan every possible Pendle or external position, and absence from Positions does not prove that no reward exists elsewhere.

See [Pool incentives](/create/incentives) for the current AIM, external-campaign, and Merkl boundaries.

## What OpenPendle validates

Before a market can be saved or used for a transaction, OpenPendle checks it against the recognized factory lineage bundled for that chain. Protocol Status separately reads the deployment helper's active wiring; that live status does not extend the release's provenance set.

For on-chain actions, OpenPendle then prepares bounded calldata, simulates it against current chain state, and defaults token approval to the action amount. These controls reduce interface and transaction-construction risk. They do not inspect whether the SY can later change, whether its accounting asset will retain value, or whether the underlying protocol can redeem.

## What to inspect yourself

- **Accounting asset and yield-bearing token.** One PT redeems for one unit of the accounting asset at maturity, usually delivered through an SY output token. That output can still de-peg or fail.
- **SY implementation.** Check upgradeability, owner, adapter, accepted input/output tokens, and exchange-rate behavior.
- **Market lifecycle.** Check maturity, liquidity, implied APY, and whether the market is near a tradeable-range boundary.
- **Rewards.** Treat PENDLE, SY-native, and external rewards as separate, mutable streams.
- **Exit path.** Confirm how PT, YT, SY, and LP positions settle before depositing.

## A practical review sequence

For an unfamiliar Community result:

1. Confirm the chain, market address, maturity, and factory generation.
2. Identify the accounting asset and the yield-bearing token separately.
3. Inspect the SY implementation, owner, proxy admin, adapter, and accepted outputs.
4. Check current reserves and whether the quoted trade is small relative to available liquidity.
5. Verify each reward stream independently instead of relying on one combined APY.
6. Model the exit: early AMM sale, paired PT/YT redemption, maturity PT settlement, or LP removal.
7. Read the final wallet request and approval spender.

This sequence does not produce a certification. It prevents a catalog or APY label from substituting for basic contract and exit-path diligence.

## See also

- [Anatomy of a pool](/concepts/pool-anatomy)
- [Standardized Yield](/concepts/standardized-yield)
- [Liquidity & the AMM](/concepts/liquidity-and-amm)
- [Risks & disclosures](/reference/risks)
