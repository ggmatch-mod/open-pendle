# Deploying the market

The market wizard turns an existing [SY](/concepts/how-pendle-works#stage-1-standardize-the-yield-source) into PT, YT, and a Pendle AMM for one maturity. It calls Pendle's `PendleCommonPoolDeployHelperV2` and seeds the first liquidity in the same transaction.

::: danger Real contracts and capital
Deployment is irreversible and the seed leaves your wallet. Confirm the chain, SY, maturity, rate settings, fee, token, and amount before signing. A factory-created market is not automatically reviewed or listed.
:::

## Contract and transaction

| Contract | Address on all supported chains |
| --- | --- |
| `PendleCommonPoolDeployHelperV2` | `0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9` |

For an existing SY, OpenPendle calls `deploy5115MarketAndSeedLiquidity`. Pendle's helper:

1. creates or reuses the PT for the SY and maturity;
2. deploys the market with the configured pricing curve and fee;
3. converts the chosen seed token as needed;
4. seeds PT/SY liquidity; and
5. returns LP and YT to the caller.

If any step reverts, the whole deployment reverts.

The separate SY wizard can also call helper wrappers that deploy a new SY and market together. That combined path is described under [Creating an SY](/create/standardized-yield#deploy-mode).

## Configuration

### SY address

Paste an `IStandardizedYield` contract. The wizard checks its metadata and accepted deposit tokens. A valid interface is not an asset audit; inspect the SY owner, adapter, proxy, and underlying asset separately.

### Maturity

Maturity must be in the future and aligned to the active yield-contract factory's live expiry divisor. The UI snaps dates to the expected UTC boundary.

If a PT already exists for the same SY and maturity on the active factory, Pendle can reuse it. OpenPendle also warns when an older recognized factory generation already has a parallel PT for that pair.

### Rate band and launch APY

The minimum and maximum APYs define the market's immutable pricing band. Launch APY must sit strictly inside it. The interface previews derived curve parameters for explanation; Pendle's helper computes the transaction parameters on-chain.

Bad bands can make the market unusable. Wider is not automatically safer: choose a band that reflects the asset, maturity, and expected market behavior.

### Swap fee

The fee must remain under the active market factory's live cap. OpenPendle currently presents a 5% upper boundary and reads the factory value during preflight. This is the market fee configuration, not an OpenPendle fee.

### Seed token and amount

The seed token must be the SY itself or one of the tokens returned by `getTokensIn()`.

| Seed type | Approval | Delivery |
| --- | --- | --- |
| ERC-20 or SY token | Exact amount by default; Unlimited only by explicit opt-in | Helper pulls the approved token |
| Native coin (`address(0)`) | None | Sent as transaction value |

Native seeding is available only when the **existing SY** lists `address(0)` as an accepted input. A chain using ETH for gas does not imply that every SY accepts native ETH.

The **new SY + market** combined wizard is different: its helper wrappers are not payable and always seed with the selected ERC-20 or ERC-4626 asset. That path requires an ERC-20 approval and cannot use native value.

## Preflight and signing sequence

The interface checks:

- the active chain and wallet connection;
- SY interface and accepted seed token;
- future/aligned maturity;
- rate band, launch APY, and fee cap;
- seed amount and displayed balance;
- existing or parallel PT signals; and
- a simulation of the exact final deploy call.

For ERC-20 seeds, the binding deployment simulation may require allowance. The intended order is:

1. approve the seed token if needed;
2. wait for approval confirmation;
3. simulate the final deployment against current state; and
4. ask the wallet to send the deployment.

Simulation catches a call that would revert under the simulated state. The wallet broadcasts through its own provider, not the custom OpenPendle read RPC.

## Outputs and ownership

The caller receives:

- the LP position representing the seeded liquidity; and
- the YT left after the helper creates the initial PT/SY pool balance.

The market address is the address to open, save, and share. It is also the LP token contract address; do not substitute the PT, YT, or SY address.

Deploying a market over an existing SY does not change that SY's owner. In a combined new-SY deployment, ownership follows the choice made in the SY wizard: Pendle governance by default or the connected wallet as an advanced option.

## Confirmation and recovery

After confirmation, the success panel attempts to decode the deployment receipt and shows:

- the market address;
- **Open the pool**; and
- an explorer link.

If receipt decoding fails, use the transaction hash in the page's bounded recovery tool or inspect the helper's deployment event on the explorer. Save the opened market locally; Explore may not include it until the next catalog refresh.

## After deployment

- Trading, quoting, mint/redeem, and liquidity work immediately.
- An external TWAP consumer may require a larger observation cardinality. See [Initializing the price oracle](/create/price-oracle).
- Deployment does not automatically whitelist the pool for Pendle AIM rewards or create an external campaign. See [Incentives](/create/incentives).

OpenPendle ships no deployment contract and takes no fee of its own. The helper and created contracts are Pendle's; Pendle protocol fees and network gas still apply.
