# Incentives for a new pool

Deploying a Pendle market does **not** automatically give it PENDLE emissions or create a rewards campaign. Incentive eligibility and campaign setup are separate from permissionless on-chain deployment.

## Pendle's current model: AIM

Pendle currently documents the [Algorithmic Incentive Model (AIM)](https://docs.pendle.finance/pendle-v2/ProtocolMechanics/Mechanisms/Incentives). AIM allocates PENDLE across eligible pools using performance, limit-order, co-incentive, and discretionary components.

The important boundary for OpenPendle creators is simple:

- a factory-valid market is not automatically whitelisted for AIM;
- OpenPendle cannot enroll or whitelist a market; and
- AIM rules, budgets, matching, and eligibility are controlled by Pendle and can change.

Treat Pendle's current documentation and partner/listing process as authoritative. Do not describe an unlisted market as receiving PENDLE incentives unless its live reward state confirms it.

## External Incentive Campaigns and Merkl

Pendle's AIM documentation also describes **External Incentive Campaigns**: a protocol can contribute reward tokens to a campaign, and eligible campaigns can affect Pendle co-incentives. The submission process and eligibility are external to OpenPendle.

**Merkl** is a separate third-party distribution system used by some ecosystem campaigns and points programs. A typical Merkl flow is:

1. a campaign operator funds and configures a campaign outside OpenPendle;
2. Merkl computes wallet entitlements from on-chain activity;
3. Merkl publishes cumulative amounts and Merkle proofs; and
4. users claim from Merkl's distributor.

Merkl is not synonymous with AIM, and it is not the only possible external distribution mechanism. Conversely, creating a Pendle pool does not create a Merkl campaign.

## What OpenPendle supports today

OpenPendle does **not**:

- create, submit, whitelist, or fund AIM incentives;
- create or configure External Incentive Campaigns;
- create or fund Merkl campaigns;
- provide a campaign directory or campaign APR; or
- add an arbitrary reward token to a Pendle market.

OpenPendle's **Positions** page does one narrower job: when a wallet is connected, it asks Merkl's public API for wallet-wide claimable rewards on supported chains and can build a direct claim to Merkl's distributor.

Those results are not restricted to Pendle and can include unrelated protocols. If nothing is claimable, the Merkl section stays hidden. OpenPendle does not compute or custody the rewards.

## SY `offchainRewardManager`

Some upgradeable Pendle SY templates accept an immutable `offchainRewardManager` constructor parameter that can enable the SY's `claimOffchainRewards` path.

The current OpenPendle SY wizard **always passes `address(0)`** for this parameter. Therefore:

- the deployed SY's off-chain reward-manager hook is disabled;
- the wizard offers no alternate manager field; and
- users must not assume SY-targeted Merkl distributions can be claimed through that SY.

This limitation is separate from wallet-direct campaigns. A campaign may distribute to eligible wallets through its own distributor without using the SY hook.

## If you want to incentivize a pool

1. Deploy and verify the market; record its chain, market, PT, YT, and SY addresses.
2. Check Pendle's current AIM and External Incentive Campaign documentation for eligibility and submission requirements.
3. If using Merkl or another distributor, configure the campaign on that provider and verify supported chains, assets, recipients, fees, and accounting.
4. Tell users which positions qualify, where accounting occurs, how claims work, when the campaign ends, and what token is paid.
5. Never present temporary rewards as guaranteed pool yield.

OpenPendle currently provides no safe in-app shortcut for these steps.

## Risks and privacy

- Rewards can change, end, or become unclaimable.
- A reward token has its own price, liquidity, and contract risk.
- AIM and external campaign rules can change independently of a pool.
- Merkl accounting and proofs are third-party data.
- Opening Positions sends the connected wallet address and supported chain IDs to Merkl.
- Claiming is an on-chain transaction through the injected wallet to Merkl's distributor and costs gas.

Rewards do not reduce asset, SY, AMM, or liquidation risk. Evaluate the base position without incentives first.

For the claim interface, see [Positions & rewards](/guides/positions). For SY construction and the disabled manager hook, see [Creating an SY](/create/standardized-yield#off-chain-reward-manager-limitation). For the complete request disclosure, see [Architecture](/reference/architecture#outbound-requests).
