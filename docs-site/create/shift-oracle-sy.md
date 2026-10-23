# Shift oracle SY

The **Shift oracle SY** option in Create SY separates a Shift receipt's share-price growth from principal denominated in its vault asset. It supports home-chain, 18-decimal Shift V1 receipts and Shift V2 `SyShare` tokens on OpenPendle's supported EVM networks.

If the accounting asset is USDC, PT represents a target of one USDC of receipt NAV at maturity. Settlement and yield claims return the Shift receipt or SY. Converting receipts to USDC follows Shift's separate withdrawal process.

## Launch steps

1. Select **Create SY → Shift oracle SY**, the correct network, and V1 or V2.
2. Paste the receipt token. The launcher discovers its accounting asset and, for V2, its paired vault. An optional vault address must match that receipt.
3. Review the displayed NAV, accounting decimals, maximum NAV age, SY name, symbol, and pause owner. For V2, set the NAV reporter address to the wallet or keeper that will maintain attestations.
4. Deploy the oracle and SY. One contract-creation transaction deploys the pair and transfers SY ownership atomically. No token approval, seed capital, registered template, or predeployed OpenPendle factory is needed for this step.
5. For V2, connect the reporter and attest the current price using the **actual NAV observation timestamp** supplied by Shift's valuation process. The input deliberately has no automatic timestamp default.
6. Once the SY passes readback and has a valid exchange rate, select **Create a pool for this SY**. Configure the maturity, rate range, fee, and seed capital in the existing [pool wizard](./deploying-a-market).

These are separate deployment and pool-creation transactions. A failed pool launch does not undo the earlier SY deployment. Save the SY, oracle, source, reporter, network, and transaction addresses.

## Price source and freshness

| Profile | Receipt and source | Freshness |
| --- | --- | --- |
| V1 | The vault receipt supplies `baseToken()`, `tvlFeed()`, and `getSharePrice()` | The oracle checks the pinned feed's NAV timestamp, nonzero TVL/supply snapshot, and configured maximum age |
| V2 | `SyShare.vault()` and `syVault.share()` must identify each other; the vault supplies `asset()` and `latestSharePrice()` | The configured reporter must attest the current price and its real observation timestamp |

V2 epoch settlement can carry forward an earlier price. A recent settlement timestamp or a low missed-epoch count therefore cannot establish fresh NAV. The oracle trusts the designated reporter to attest a real valuation sample. That reporter can be an existing Shift keeper; the keeper must send an attestation after updating NAV and refresh it before the configured age limit expires.

The V2 reporter calls:

```solidity
oracle.attestNav(currentSettledSharePrice, actualNavObservedAt);
```

The price must equal the vault's current `latestSharePrice()`. The timestamp must be positive, strictly newer than the previous attestation, no later than the current block, and within the maximum age. The contract rejects other senders. No initial attestation is fabricated at deployment.

For either profile, an expired or invalid observation makes `exchangeRate()` revert. This can temporarily block minting, trading, and PT/YT redemption until the source or attestation is refreshed. A direct SY-to-receipt unwrap does not require a price read. Choose an age limit compatible with real reporting operations and arrange continued reporting through maturity and exit.

## Accounting units

The launcher reads the accounting token's actual decimals. It accepts accounting assets with 1–18 decimals and receipts with exactly 18 decimals.

Pendle converts raw units as follows:

```text
raw accounting asset = raw SY × exchangeRate / 1e18
```

For an 18-decimal receipt worth 1.05 USDC, the exchange rate is **1,050,000** and PT/YT have 6 decimals. Multiplying this rate by `1e12` would be incorrect when `assetInfo()` identifies ordinary USDC. V1 feed precision is converted to the accounting token's precision; V2 prices already use raw accounting-asset units per whole share.

Shift's points distributor must account for those PT/YT decimals and the PY index. The new SY has no native reward-token distributor; partner points remain a separate integration.

## Control and economic limits

The new SY and oracle are immutable. Receipt, source, accounting asset, V1 feed, V2 reporter, and maximum age cannot be changed. The SY owner can pause and transfer ownership. The bootstrap contract retains no administrative power, token allowance, or funds. This route uses new OpenPendle code and makes no audit or official Pendle-listing claim.

The source token must remain transferable without rebasing or transfer fees. Deposits and redemptions check actual transfer deltas, but these checks do not establish the correctness of the vault NAV or remove the underlying strategy's risks.

Pendle's PY index never decreases. A NAV increase can be distributed to YT, followed by a drawdown that reduces PT value; previous YT distributions are not clawed back. The oracle does not provide a loss buffer, a guaranteed dollar redemption, or synchronous USDC liquidity. Those economic choices must be established for the launched product.

Bridged receipt peers whose source NAV lives on another chain need a separate, reviewed price-relay integration. This same-chain launcher rejects a missing or mismatched local vault rather than assuming a bridged token exposes its home-chain price.

## Verification and recovery

Before signing, the launcher rechecks source bindings, accounting units, and network, then simulates the exact constructor transaction. After confirmation it verifies the new SY, oracle, owner, metadata, and receipt-only input/output lists. Pool creation remains unavailable until current exchange-rate checks pass.

If a wallet submission or receipt lookup is unresolved, use **Check transaction** or recover the transaction hash from wallet activity. The launcher verifies the original sender, nonce, destination, and calldata; it does not submit another deployment while the first is unresolved.
