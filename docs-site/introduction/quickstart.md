# Quickstart

OpenPendle has no account or sign-up. You can browse markets, inspect Yield alerts, and model PT loops without connecting a wallet. Connect only when you are ready to transact.

If PT, YT, or SY are new to you, read [How Pendle works](/concepts/how-pendle-works) first.

::: warning Community markets require your own diligence
OpenPendle validates that a market came from a recognized Pendle factory. It does not review or endorse the asset, SY, or market. Read [Community pools](/concepts/community-pools) and [Risks & disclosures](/reference/risks) before signing.
:::

## Choose your goal

| Goal | Start here | What you can do |
| --- | --- | --- |
| **Open or model a PT loop** | [Looping](https://openpendle.com/#/looping) | Compare exact Pendle PT/Morpho matches, then buy PT in Market Mode or mint PT+YT in Mint Mode. |
| **Spot fixed-yield moves** | [Yield alerts](https://openpendle.com/#/alerts) | Review qualified 24-hour changes in PT implied APY. No wallet or notification subscription is required. |
| **Find a market** | [Explore](https://openpendle.com/#/explore) | Search the factory-indexed directory across supported networks. |
| **Trade now or target an APY** | Open a market | Swap through Pendle's AMM or place a PT ↔ SY limit order when Pendle's live service supports it. |
| **Track positions and rewards** | [Positions](https://openpendle.com/#/positions) | Read Saved and Pendle Official pool balances, manage supported loops, and claim supported rewards. |
| **Launch a market** | [Create pool](https://openpendle.com/#/create) | Deploy a community market from an existing SY, or create a supported SY first. |

Wallet requirements differ by workflow:

| Workflow | Wallet needed to inspect? | Wallet needed to complete? |
| --- | --- | --- |
| Explore and Yield alerts | No | No wallet action |
| Looping directory and model | No | Yes, for an enabled reviewed-market action |
| Market quotes and trust panel | No | Yes, for an on-chain action |
| Limit-order support and book | No | Yes, to approve and sign an order |
| Positions | Yes, to choose an address | Yes, to claim rewards |
| Create | No, for the form | Yes, to deploy and seed |

## 1. Pick a network

Choose the network before opening a market. When disconnected, the selector is in the header; after connection, it moves into **Profile**. The active network controls app reads and transaction destinations.

OpenPendle supports Ethereum, BNB Smart Chain, Monad, Base, Plasma, and Arbitrum. Your preference is stored locally. Chain-specific market and token links override it for that tab.

If your wallet is connected to a different chain, OpenPendle asks it to switch. Rejecting the request leaves read-only browsing available. If a public RPC is unreliable, set a custom endpoint in **RPC settings**. See [Browsing & networks](/guides/browsing) and [Networks & contracts](/reference/networks-and-contracts).

## 2. Find a market

Use whichever route matches what you know:

- **Explore by name or protocol.** The directory is built from recognized factory events. Pendle's catalog adds listing and display metadata; it does not define the full inventory.
- **Paste a market address.** A valid `PendleMarket` opens directly.
- **Paste PT or YT.** OpenPendle shows Token actions and attempts to resolve matching markets.
- **Open a saved pool.** Pools remembered in this browser appear under [Saved pools](/guides/saved-pools).
- **Use Yield alerts or Looping.** Yield alerts links qualified moves to their market; Looping identifies exact Pendle PT and Morpho market pairs for comparison.

An SY address alone cannot identify one market because the same SY may support several maturities. Recent markets also remain reachable by address before the next Explore snapshot.

## 3. Check provenance and the trust panel

Before saving or transacting, OpenPendle checks whether the market was created by a recognized Pendle factory. Passing this gate proves origin, not safety.

Review the market's trust panel:

- the yield-bearing token and the SY's accounting asset;
- the SY address, owner, adapter, and upgradeability where available;
- maturity and whether the market has expired;
- live reserves, implied APY, and any degraded-data warnings.

One PT redeems at maturity for one unit of the SY's **accounting asset**, normally delivered through an accepted SY output token. This is not necessarily one raw yield-bearing token. See [Anatomy of a pool](/concepts/pool-anatomy).

## 4. Connect a wallet

OpenPendle supports injected EIP-6963 wallets such as MetaMask, Rabby, and Brave. It does not use WalletConnect or a third-party connection relay.

- On desktop, use an installed wallet extension.
- On mobile, open OpenPendle inside a wallet's dApp browser or another browser that exposes an injected provider.

Browsing does not require a wallet. Connect only after choosing a market and checking its trust surface. See [Connecting a wallet](/guides/connecting-a-wallet).

## 5. Take an action

Available actions depend on the market lifecycle and Pendle's live services:

- **Buy PT** for a fixed return in the accounting asset when held to maturity.
- **Buy YT** for exposure to realized yield and rewards until maturity, net of Pendle's protocol fees.
- **Mint or redeem PT + YT** before maturity. The current SY exchange rate determines how much equal PT and YT an SY amount represents.
- **Add or remove liquidity.** Adding ends at maturity; removing and settling remain available afterward.
- **Place a PT limit order** where Pendle approves the exact market and direction. Placement does not reserve funds and an order may never fill.
- **Open a reviewed PT loop** in Market Mode by buying PT, or in Mint Mode by minting PT+YT, supplying only PT as collateral, and keeping YT in your wallet. Mint risk increases require their additional release gates. Existing supported loops are managed from Positions.
- **Redeem matured PT** through the market's supported output path.

OpenPendle simulates prepared on-chain transactions against current chain state before asking for a signature. A successful simulation is useful evidence, not a guarantee: market state can change before inclusion. Token approvals default to the action amount; Unlimited approval is an explicit opt-in.

Immediate swaps and liquidity actions use Pendle Router V4. Limit orders instead use signed EIP-712 data, Pendle's hosted order API, and the Limit Router. OpenPendle adds no interface fee; Pendle and network fees still apply.

### Review transaction settings

Before an immediate on-chain action, check:

- input token and exact spend amount;
- expected output and minimum output after slippage;
- deadline;
- approval spender and exact versus Unlimited approval;
- active network and destination contract;
- simulation result and wallet calldata summary.

The chain can move between simulation, signature, and mining. A quote can become stale or a previously successful simulation can later revert.

### Understand the limit-order lifecycle

A limit order is not an immediate trade. OpenPendle first asks Pendle's live service whether the exact market and direction are supported. It then generates and validates typed data before your wallet signs it.

Publishing sends the maker address and signed order to Pendle's hosted API. Funds remain in the wallet and must still be available and approved when a taker attempts to fill. An order can fill partially, fill completely, expire, become unfundable, or remain open until cancellation. See [PT limit orders](/guides/limit-orders).

The **Looping** directory is broader than its execution allowlist. For an enabled reviewed market, OpenPendle validates the exact Pendle and Morpho identities, contract state, route, liquidity, risk floor, and runtime entry policy before requesting wallet actions. Mint Mode also requires its independent build flag and runtime policy. Pausing either entry plane does not disable full exit or bounded recovery, and exiting never consumes YT held in the wallet. See [PT looping](/guides/looping).

## 6. Track what you used

Select **Remember this pool** to add a market to the browser-local registry. Saved pools and custom RPC settings are not stored in an OpenPendle account.

From [Saved pools](/guides/saved-pools), you can forget a pool, undo a recent removal, export or import JSON, or create a shareable registry link. [Positions](/guides/positions) combines that local registry with the connected wallet's market IDs from Pendle Official Pools, then re-reads balances on-chain. It is broader than Saved Pools but is not a universal wallet scan.

The connected **Profile** menu links to Saved pools, Positions, and Yield alerts. It also contains the active-network controls, RPC override, theme, and wallet-management entry.

## Common problems

- **A market is missing from Explore.** Open it by address; the factory snapshot may not have reached that block yet.
- **A PT or YT does not resolve a pool.** Confirm the active chain. The token can also sit outside current lookup coverage.
- **Reads fail or appear stale.** Try the RPC override for that chain and reload.
- **The wallet cannot connect on mobile.** Use a wallet dApp browser or another browser exposing an injected provider.
- **A limit-order form is unavailable.** Pendle's support decision is stricter than catalog listing and can differ by direction.
- **A transaction simulation fails.** Do not bypass it. Recheck balance, allowance, maturity, slippage, and market state.

## After maturity

Trading and new liquidity stop at maturity. You can still redeem PT and remove an LP position. A reviewed loop remains manageable in Positions, where its only supported post-expiry action is full exit through PT redemption and Morpho debt repayment. Pendle redirects yield and points generated by matured, unredeemed PT and LP positions according to its protocol rules, so review and settle matured positions promptly. See [Maturity & redemption](/concepts/maturity).

## Next

- [Opening a pool](/guides/opening-a-pool)
- [PT looping](/guides/looping)
- [PT limit orders](/guides/limit-orders)
- [Risks & disclosures](/reference/risks)
