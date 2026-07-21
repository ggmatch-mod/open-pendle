# Risks & disclosures

::: danger Experimental — use at your own risk
OpenPendle is unaudited software for a permissionless protocol. Community pools can be created by anyone and can lose you funds. OpenPendle is not affiliated with, endorsed by, or operated by Pendle Finance. Nothing here is financial advice.
:::

## Provenance is not safety

Before a market can be saved or used for a market action, OpenPendle checks that a factory in its recognized chain-specific lineage created it. This helps block look-alike market contracts.

It does **not** establish that:

- the underlying asset is solvent, liquid, or correctly priced;
- the SY deposits and redeems as expected;
- an adapter is safe;
- the SY owner or proxy admin will behave honestly; or
- PT will redeem at par.

A factory-valid market can still wrap a malicious, broken, upgradeable, or highly experimental asset. Inspect the market's trust panel and verify the asset, SY, owner, adapter, and proxy state independently.

## What transaction safeguards do

OpenPendle reduces some interface-level mistakes:

- **Simulation before signature.** On-chain actions are simulated against the current chain state. A call that would revert under that state is blocked before the wallet prompt.
- **Exact approvals by default.** An ERC-20 approval normally matches the current action amount. Unlimited approval is an explicit setting and leaves a standing allowance until revoked.
- **Provenance gating.** Recognized factory origin is required for saving and market actions.
- **Limit-order validation.** PT ↔ SY orders require matching live support and fee data, field-by-field EIP-712 validation, local and on-chain hash checks, signer recovery, and a Limit Router signature check before publication.

Simulation does not prove that a token's hidden behavior is safe, guarantee the state when a transaction is mined, prevent front-running, or remove Pendle and third-party contract risk. Exact approval limits allowance exposure; it does not make the approved contract trustworthy.

## Risk by feature

| Risk | What OpenPendle can do | What remains yours |
| --- | --- | --- |
| Fake market contract | Require recognized factory provenance | Verify the asset and SY underneath |
| Transaction revert | Simulate against current state | State can change before mining; semantics may still be unsafe |
| Excess token allowance | Default to the exact action amount | Revoke explicit unlimited approvals when no longer needed |
| PT or LP loss | Show market and trust data | Asset, SY, maturity, liquidity, and AMM risk |
| PT looping | Exact reviewed registry, route and contract checks, bounded simulation, and independent exit/recovery controls | Borrow rates, PT APY, oracle moves, liquidation, slippage, gas, protocol risk, and state changes before mining |
| Limit order | Validate and display order state | Fill probability, balance/allowance, mutable fees, API availability, and cancellation races |
| Pool creation | Validate inputs and simulate Pendle calls | Irreversible deployment, seed price, asset design, owner choice, and user communication |
| Merkl reward claim | Build a direct distributor claim from Merkl's proof | Merkl data, reward-token risk, and wallet-wide campaign scope |

### Market and position risk

- **PT is not a guaranteed bond.** Convergence to par assumes the underlying asset and SY remain redeemable.
- **YT can expire worthless.** It is a leveraged position on realized yield before maturity.
- **LP return is not a quoted APR.** It combines PT/SY exposure, underlying yield, swap fees, changing implied rates, and any incentives. Impermanent loss and asset failure can dominate fees.
- **Low liquidity magnifies slippage and exit risk.** A position may be difficult to unwind even when displayed mark values look healthy.

### Limit-order risk

Placing an order signs and publishes it to Pendle's hosted service; it does not reserve or escrow tokens. Moving funds, changing allowance, a fee-root update, or other state changes can make it unfillable. A cancellation is effective only when its on-chain transaction is mined, so a taker can race it.

Pendle's API can be unavailable, change behavior, or omit a market. OpenPendle fails closed when support or generated data does not validate, but it does not operate an independent order book.

### Looping risk

The Looping directory and APY model cover more markets than OpenPendle will execute. A wallet action is available only for an exact reviewed market when the relevant build flag, same-origin runtime entry policy, live contract and route checks, and unsigned simulation all pass.

The slider's red marker represents a simplified 10% liquidation buffer. Moving past it requires explicit acknowledgement, but that acknowledgement does not waive the hard live preflight floor of 1%. Neither threshold guarantees safety: borrow interest, PT value, oracle behavior, liquidity, fees, slippage, and chain state can change before or after execution.

New entry and leverage increases can be paused while leverage decreases, full exit, and bounded recovery remain separately controlled. Expiry also does not repay Morpho debt. OpenPendle retains reviewed matured positions in Positions and supports only the post-expiry full-exit path, but users still need a functioning wallet, RPC, contracts, route, and enough gas.

### Creation risk

Creating an SY or market deploys real Pendle contracts and can commit real seed capital. Deployment is irreversible. Keeping SY ownership gives the wallet privileged control, including pause and, for applicable templates, adapter changes; choosing Pendle governance delegates that control instead. Upgradeable templates also depend on Pendle's ProxyAdmin.

The token screen is a safeguard, not a general audit. Do not override an inconclusive screen unless you have independently verified the asset behavior.

## Fees and gas

OpenPendle adds **no fee of its own**. You can still pay:

- network gas;
- Pendle AMM and YT protocol fees;
- Pendle limit-order fees when an order fills;
- price impact and slippage; and
- third-party costs associated with the underlying asset or reward system.

Mutable protocol parameters shown on [Protocol Status](https://openpendle.com/#/status) are read from the chain. Gasless limit-order publication does not make approvals or on-chain cancellation gasless.

## Privacy and external services

OpenPendle operates no request-time application server, account system, or user database. These values are stored locally:

| Data | Storage |
| --- | --- |
| Preferred chain | `openpendle.chain` |
| Custom RPC | `openpendle.rpc.<chainId>` |
| Saved pools | `openpendle.pools.v1` |

Local storage is not the same as network anonymity. App RPCs see read/simulation requests; the injected wallet's provider sees submitted transactions. Feature APIs receive the identifiers needed for their requests. In particular:

- Pendle receives maker addresses on maker-order reads and the complete signed order on placement.
- Pendle receives the connected wallet address when Positions discovers its Official-pool market IDs; balances and claims are then re-read from the relevant chains.
- Merkl receives the connected wallet address and supported chain IDs when Positions loads rewards.
- Morpho receives public PT-address queries when Looping loads; no wallet is required.
- Cloudflare Web Analytics receives page-view and performance data on the hosted build.

The complete list is maintained in [Architecture](/reference/architecture#outbound-requests). Providers can also observe ordinary metadata such as IP address and timing.

Saved-pool export, import, and share links are explicit. Opening saved markets or Positions still creates ordinary chain and feature requests for the relevant addresses.

## Wallet and RPC trust

OpenPendle uses injected wallets and no WalletConnect session relay. Transaction requests are sent to the wallet, which broadcasts through its own provider. The custom OpenPendle RPC is a separate path for reads and simulations. A malicious wallet, wallet RPC, app RPC, browser extension, or compromised static bundle can still mislead or harm you.

Self-hosting lets you choose and inspect the bundle; it does not remove those dependencies or make a pool safe.

## Open source and reporting

OpenPendle is licensed `GPL-3.0-or-later` and ships no OpenPendle-authored contracts. Source: [github.com/ggmatch-mod/open-pendle](https://github.com/ggmatch-mod/open-pendle).

Report interface vulnerabilities responsibly to [ggmxbt on X](https://x.com/ggmxbt) or follow [`security.txt`](https://openpendle.com/.well-known/security.txt). Pendle-contract vulnerabilities should follow Pendle Finance's own disclosure process.
