# Creating an SY

A [Standardized Yield (SY)](/concepts/how-pendle-works#stage-1-standardize-the-yield-source) gives Pendle a common deposit, redemption, and accounting interface for a yield-bearing asset. OpenPendle can deploy one of seven templates registered in Pendle's common SY factory.

::: warning Review the contract configuration
Factory provenance does not validate the asset, adapter, owner choice, or economic design. A malformed or privileged SY can put every market built on it at risk.
:::

## Factory

| Contract | Address on all supported chains |
| --- | --- |
| `PendleCommonSYFactory` | `0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8` |

The factory and templates are Pendle contracts. OpenPendle supplies the chosen template ID and encoded configuration; it deploys no OpenPendle-authored contract.

## Asset screening

The wizard accepts a standard ERC-20 or ERC-4626 address and probes:

- metadata and decimals;
- ERC-4626 behavior where applicable;
- common rebasing interfaces and known unsafe classes; and
- fee-on-transfer behavior when the RPC supports the required state-override probe.

Suspected fee-on-transfer or rebasing assets are blocked because they can break share accounting and redemption. Raw native ETH has no SY template; use a compatible wrapped or vault asset. An SY can nevertheless accept native input through separately supplied adapter logic.

The screen is not exhaustive. On RPCs that cannot perform the fee-on-transfer probe, an unseeded basic SY-only deploy is blocked by default behind an explicit “not fully screened” override. Combined SY + market deployment has an on-chain seed-revert backstop, but a successful simulation is still not an asset audit.

## Templates

| Template | Asset | Upgradeable | Adapter |
| --- | --- | --- | --- |
| `PendleERC20SY` | ERC-20 | No | No |
| `PendleERC4626SYV2` | ERC-4626 | No | No |
| `PendleERC4626NotRedeemableToAssetSYV2` | ERC-4626 | No | No |
| `PendleERC20WithAdapterSY` | ERC-20 | Yes | Optional address |
| `PendleERC4626WithAdapterSY` | ERC-4626 | Yes | Optional address |
| `PendleERC4626NoRedeemWithAdapterSY` | ERC-4626 | Yes | Optional address |
| `PendleERC4626NoRedeemNoDepositUpgSY` | ERC-4626 | Yes | No |

### Basic templates

The three basic templates use `deploySY` with encoded `(name, symbol, token)` parameters. They are immutable SY implementations:

- **ERC-20:** a one-to-one wrapper for a standard, fixed-balance token.
- **ERC-4626:** follows the vault-share conversion rather than assuming one vault share equals one underlying asset.
- **Not redeemable to asset:** for a vault whose share cannot be redeemed through the normal underlying-asset path.

Prefer a basic template when the asset needs no custom routing; it has the smallest template-level trust surface.

### Upgradeable and adapter templates

The four advanced templates use `deployUpgradableSY` and deploy a `TransparentUpgradeableProxy` administered by Pendle's ProxyAdmin:

`0xA28c08f165116587D4F3E708743B4dEe155c5E64`

For the three adapter templates, initialization includes `(name, symbol, adapter)`. Leaving the adapter blank passes `address(0)`, creating a plain shell whose SY owner can later call `setAdapter`.

An adapter is a separate, per-asset `IStandardizedYieldAdapter` contract. The common SY factory does **not** deploy it. A supplied adapter must be independently reviewed and must use the correct pivot token:

| Variant | Required `PIVOT_TOKEN` |
| --- | --- |
| ERC-20 adapter SY | SY yield token |
| ERC-4626 adapter SY | Vault `asset()` |

The no-redeem/no-deposit template has no adapter parameter and uses a two-argument initializer. OpenPendle builds these encodings; empty initialization is never sent because it would revert.

## Off-chain reward-manager limitation

Upgradeable template constructor parameters include `(token, offchainRewardManager)`. In the current production interface, OpenPendle **always supplies `address(0)`** for `offchainRewardManager`.

Consequences:

- the SY deploys and functions normally;
- that SY's `claimOffchainRewards` hook is disabled; and
- the wizard offers no field to configure a different manager.

This does not prevent every external reward program: a campaign can distribute directly to eligible wallets through a separate system. OpenPendle's Positions page can also retrieve and claim wallet-wide Merkl rewards. It does mean you must not rely on this wizard to create an SY-level Merkl reward route. See [Incentives](/create/incentives).

## Name and symbol

The wizard suggests:

- name: `SY <asset>`
- symbol: `SY-<asset>`

You can edit both, but misleading metadata makes market diligence harder. Names do not establish asset identity; users should verify addresses.

## Ownership

The SY owner can pause the contract and, for adapter templates, change the adapter. The wizard offers:

| Choice | Control |
| --- | --- |
| **Pendle governance** (default) | Owner is `0x2aD631F72fB16d91c4953A7f4260A97C2fE2f31e` |
| **Keep ownership** (advanced) | Owner is the connected wallet |

Keeping ownership gives the deployer privileged control and causes OpenPendle's trust panel to flag the non-Pendle owner. Choosing Pendle governance delegates owner powers but does not remove the separate ProxyAdmin trust for upgradeable templates.

Ownership is not an LP position and does not entitle the owner to market funds.

## Deploy mode

### SY only

Calls the common SY factory and requires no token approval. After confirmation, the success panel shows the SY address and links to the market wizard.

### SY + market

Calls a Pendle helper wrapper that deploys the configured SY, creates PT/YT and the market, and seeds liquidity atomically. The combined path:

- always seeds with the selected ERC-20 or ERC-4626 token;
- requires approval of that token to Pendle's helper; and
- cannot attach native transaction value because these wrapper entry points are not payable.

For native seeding, first use or deploy an SY whose accepted inputs include `address(0)`, then use the separate existing-SY market flow. See [Deploying the market](/create/deploying-a-market#seed-token-and-amount).

All on-chain actions are simulated against current state before the wallet prompt. The injected wallet broadcasts through its own provider.

## After confirmation

Record and verify the SY address on the target chain. For an upgradeable template, disclose the ProxyAdmin and owner. For an adapter template, disclose and monitor the adapter.

If you deployed only the SY, continue to [Deploying the market](/create/deploying-a-market). If you deployed both, open and save the market; it may not enter Explore until a later catalog refresh.
