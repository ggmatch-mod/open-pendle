# Positions & rewards

The **Positions** page shows the connected wallet's PT, YT, and LP holdings across both local **Saved Pools** and Pendle **Official Pools**. Looped PT positions remain separate. Reads are cross-chain; transaction actions remain bound to the active network.

## How pools are found

OpenPendle combines two sources:

- every market in the current browser's Saved Pools registry, including saved community markets; and
- the connected wallet's market IDs returned by Pendle's Official cross-chain position index.

The Pendle response is discovery-only. OpenPendle re-loads each relevant market and its balances through that market's own chain RPC before displaying it. It does not scan every Pendle market, and it does not render the API's cached claim amounts as live balances.

Saved Pool positions load independently of Official discovery. If Pendle is unavailable or reports an incomplete chain, the page keeps those Saved results and shows a coverage warning instead of declaring the wallet empty. Markets with no current PT, YT, LP, or claimable balance are omitted.

## What is included

Standard holdings are separated into three groups on each network:

- **PT** — Principal Token balances;
- **YT** — Yield Token balances; and
- **LP** — market liquidity-token balances.

PT and YT are token positions, so a shared PT/YT pair is shown once even if more than one market uses it. LP positions remain market-specific. Pendle-native interest and rewards are listed separately under the same network, while PT loops keep their own controls and risk information.

Standalone SY balances and bridged cross-chain PT representations are not folded into the PT/YT/LP groups.

## Loop positions

Looped PT collateral is managed separately from ordinary wallet PT balances. Select a supported network under **Loop positions**; OpenPendle scans its permanent reviewed position-management registry through the connected wallet's RPC and shows positions with Morpho debt or collateral.

A clean supported loop can adjust leverage or fully exit. A risk-increasing adjustment can acquire PT through Market Mode or mint PT+YT through Mint Mode when that mode's additional release gates permit it. The mode belongs to the action rather than the Morpho position, which stores only PT collateral and debt. Reductions and full exit use the separate exit path, never require wallet YT, and leave any YT in the wallet. If the PT has matured, adjustment is disabled but the position remains visible and **Full exit** uses PT redemption before repaying the Morpho debt. A paused entry policy never removes the position or its bounded recovery controls.

## Claims are grouped by network

Cross-chain balances can be read together, but a transaction can only execute on one network at a time. The active network gets the live claim action. Other groups show **Switch to _network_ to claim** first.

Each Pendle-native claim batches the eligible Saved and Official markets on that network into one transaction. Shared SY and YT addresses are de-duplicated. A discovered market must still pass OpenPendle's live recognized-factory validation before it is admitted to a claim transaction; an unvalidated result can be displayed read-only with a warning. OpenPendle simulates the transaction before signing and refreshes position data after confirmation.

## Merkl rewards

When a wallet is connected, OpenPendle also asks Merkl's public API for claimable rewards on supported networks. Merkl's response is wallet-wide and can include rewards from protocols other than Pendle. Claims run directly against Merkl's distributor in one transaction per network.

If there is nothing claimable, the Merkl section stays hidden. See [Risks & disclosures](/reference/risks) for the wallet-address and network data sent for this lookup.

## Privacy and limitations

- Saved pools stay in local browser storage unless you explicitly export or share them.
- Opening Positions sends the connected wallet address to Pendle's Official position-discovery endpoint. The returned market IDs are used only to choose which markets to read.
- Displayed position balances and Pendle-native claims come from RPC reads, not Pendle's cached claim values.
- Merkl receives the connected wallet address and supported chain IDs for reward lookup.
- OpenPendle has no account system and does not synchronize the saved registry between devices.
- Supported loop discovery uses the permanent reviewed registry, so it does not depend on the PT remaining in the live, unexpired Looping directory.

## See also

- [Saved pools & privacy](/guides/saved-pools) — add, remove, import, and export the local registry.
- [Browsing & networks](/guides/browsing) — active-chain and RPC behavior.
- [Providing liquidity](/guides/providing-liquidity) — LP positions and exits.
- [Quickstart](/introduction/quickstart) — choose another OpenPendle workflow.
