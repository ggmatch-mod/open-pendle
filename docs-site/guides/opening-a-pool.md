# Opening a pool & the trust panel

OpenPendle can load a Pendle market directly from its address, including permissionless markets that are not listed in Pendle's frontend. No wallet is needed to inspect one.

::: warning Loadable is not the same as safe
OpenPendle verifies that a recognized Pendle factory created the market. It does not validate the underlying asset or SY contract.
:::

## 1. Find the market address

A Pendle pool is identified by its `PendleMarket` address on one chain. You can get it from:

- an Explore result;
- a creator or project page;
- a block explorer;
- a chain-explicit market link; or
- your Saved Pools registry.

Ask for the **market address**, not only the PT, YT, LP, or SY address. Then choose the chain where it was deployed.

## 2. Paste the address

Paste the address into the home-page market field. OpenPendle checks what kind of contract it is:

- A `PendleMarket` opens the market flow.
- A PT or YT opens Token actions, which can resolve matching markets and maturities.
- An SY is identified, but an SY alone may back several maturities and cannot select one market.

Address-type detection is a convenience, not a trust signal.

## 3. Pass the provenance gate

For a market address, OpenPendle verifies that a recognized Pendle market factory created it. Until that passes, the market cannot be saved or used for transactions.

The release bundles a chain-specific lineage of recognized factories and uses it to validate existing markets. [Protocol Status](https://openpendle.com/#/status) separately reads the deployment helper's active wiring; Pendle's helper routes new creation through that wiring. See [Networks & contracts](/reference/networks-and-contracts).

Passing proves that the contract is a genuine Pendle market. It does **not** prove that its underlying asset, SY implementation, owner, or upgrade authority is safe.

## 4. Read the market view

After validation, OpenPendle reads the market's core state from the active chain. The page shows:

| Field | What to check |
| --- | --- |
| **PT, YT, and SY** | The contracts wired to this market. |
| **Underlying/accounting asset** | What the SY wraps and how value is denominated. |
| **Maturity** | When trading stops and PT settlement becomes available. |
| **Reserves and live metrics** | Current pool depth, price, and implied APY. |
| **Factory provenance** | Which recognized generation created the market. |
| **Available actions** | Actions supported by the market's state and OpenPendle. |

Implied APY is derived from PT pricing and time to maturity; it is not a promised protocol rate. Discovery metadata can be stale, so the market page's live reads and pre-sign simulation are the transaction-time view.

## 5. Use the trust panel

The trust panel surfaces the facts the provenance check does not cover.

### Underlying asset

Identify the asset, issuer, yield source, and failure modes. If the asset de-pegs, freezes, or fails, PT settlement and SY redemption can be impaired. A high APY may be compensation for that risk.

### SY owner and paused state

The SY can have an owner with privileged controls such as pausing. The panel distinguishes Pendle governance, renounced ownership, and an unknown owner when readable.

### Upgradeability

Some SYs are immutable; others are upgradeable proxies. For a proxy, check whether its admin is Pendle's known ProxyAdmin or an unknown address. Upgrade authority can change the code serving deposits and redemptions.

### Maturity

Before maturity, PT and YT trade against SY. At maturity, swaps and new liquidity stop; PT can settle through SY at the stored PY index, while YT has no future token value. Accrued interest or rewards can remain claimable.

| You are trusting | Covered by market provenance? |
| --- | --- |
| Pendle market factory and market code lineage | Yes |
| Underlying asset | No |
| SY implementation and accounting | No |
| SY owner, pause authority, and proxy admin | No |

If you cannot explain the underlying or the SY's control surface, do not fund the market. See [Risks & disclosures](/reference/risks) for the complete risk model.

## 6. Remember the pool

**Remember this pool** saves the chain and market address in the current browser. Reopen it later from [Saved Pools](/guides/saved-pools) or **Profile → Saved pools** when connected.

Forgetting has a brief Undo window. Export, import, and share links are available on the Saved Pools page; shared entries still require explicit acceptance and fresh provenance checks.

## Available actions

For a live market, OpenPendle may offer:

- immediate PT or YT swaps;
- PT ↔ SY limit orders when Pendle's live support check approves the exact direction;
- minting and recombining PT + YT;
- wrapping and unwrapping SY; and
- balanced or single-token liquidity actions.

After maturity, the page changes to PT redemption, LP exit, residual claims, and supported SY wrapping/unwrapping.

Connect an injected wallet only when you are ready to act. On-chain actions use live estimates and then simulate before confirmation. Token approvals are exact by default; Unlimited is an explicit higher-exposure option. OpenPendle calls Pendle's deployed contracts and adds no fee of its own.

## Next

- [Buying PT](/guides/buying-pt)
- [Buying YT](/guides/buying-yt)
- [PT limit orders](/guides/limit-orders)
- [Providing liquidity](/guides/providing-liquidity)
- [Saved pools & privacy](/guides/saved-pools)
