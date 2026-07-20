# Positions & rewards

The **Positions** page shows the connected wallet's PT, YT, LP, and SY balances across every pool saved in the current browser. Reads are cross-chain; transaction actions remain bound to the active network.

## Before positions can appear

OpenPendle does not run a global wallet indexer. It checks the pools in your local Saved pools registry:

1. Open a market.
2. Enable **Remember this pool**.
3. Connect the wallet whose balances you want to inspect.
4. Open **Profile → Positions**.

Saved pools with no balance are omitted from the main list. The page reports how many empty saved pools were not shown.

## What is included

For every saved market where the wallet holds something, the page can show:

- wallet PT and YT;
- LP tokens;
- SY;
- claimable Pendle-native interest or rewards; and
- the network and market needed to act on the position.

This is a portfolio view over saved pools, not proof that no other Pendle position exists elsewhere.

## Claims are grouped by network

Cross-chain balances can be read together, but a transaction can only execute on one network at a time. The active network gets the live claim action. Other groups show **Switch to _network_ to claim** first.

Each Pendle-native claim batches the eligible saved pools on that network into one transaction. OpenPendle simulates the transaction before signing and refreshes the position data after confirmation.

## Merkl rewards

When a wallet is connected, OpenPendle also asks Merkl's public API for claimable rewards on supported networks. Merkl's response is wallet-wide and can include rewards from protocols other than Pendle. Claims run directly against Merkl's distributor in one transaction per network.

If there is nothing claimable, the Merkl section stays hidden. See [Risks & disclosures](/reference/risks) for the wallet-address and network data sent for this lookup.

## Privacy and limitations

- Saved pools stay in local browser storage unless you explicitly export or share them.
- Position balances come from RPC reads.
- Merkl receives the connected wallet address and supported chain IDs for reward lookup.
- OpenPendle has no account system and does not synchronize the saved registry between devices.

## See also

- [Saved pools & privacy](/guides/saved-pools) — add, remove, import, and export the local registry.
- [Browsing & networks](/guides/browsing) — active-chain and RPC behavior.
- [Providing liquidity](/guides/providing-liquidity) — LP positions and exits.
- [Quickstart](/introduction/quickstart) — choose another OpenPendle workflow.
