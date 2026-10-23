# Shift receipt oracle SY

This standalone Solidity project creates a Pendle-compatible SY with receipt-only deposits and redemptions. SY balances are in receipt units; `assetInfo()` declares the vault's accounting ERC-20. One 18-decimal SY share has an exchange rate in **raw accounting-token units**. A share worth 1.05 USDC therefore returns `1_050_000`, not `1.05e18`.

## Deployment

The UI sends the checked-in `OracleSyBootstrap` creation bytecode with constructor arguments:

```solidity
(uint8 sourceKind, address receipt, address source, address accountingAsset,
 uint32 maxAge, address reporter, string name, string symbol, address syOwner)
```

The constructor deploys a fresh `ShiftReceiptOracle` and immutable `ShiftOracleSY`, transfers SY ownership to `syOwner`, and emits:

```solidity
event OracleSyDeployed(address indexed sy, address indexed oracle,
    uint8 sourceKind, address receipt, address accountingAsset);
```

The bootstrap holds no authority after construction. There is no proxy, upgrade administrator, common-SY-factory registration, or predeployed OpenPendle contract dependency. The result is passed into the existing Pendle PT/YT and pool creation flow. The SY owner can pause/unpause SY transfers, deposits, and redemptions, and transfer ownership; the owner cannot replace the immutable receipt, oracle, or accounting asset.

## Supported profiles

V1 (`sourceKind = 1`) requires `source == receipt`, `receipt.decimals() == 18`, `receipt.baseToken() == accountingAsset`, an on-chain `tvlFeed()`, and `reporter == address(0)`. It reads the feed's `(value, timestamp, supplySnapshot)` and receipt's `getSharePrice()`. Zero, future, or expired samples and zero prices fail closed. The rate converts feed decimals into accounting-token decimals. A change to the feed address/decimals or accounting asset invalidates the oracle rather than silently changing its meaning.

V2 (`sourceKind = 2`) requires an 18-decimal home-chain `SyShare`, its distinct paired vault, `receipt.vault() == source`, `vault.share() == receipt`, `vault.asset() == accountingAsset`, and a nonzero reporter. It reads `vault.latestSharePrice()` in raw accounting-token units and requires `vault.convertToAssets(1e18)` to exactly match, at deployment and every rate read or attestation. Bridged `SySharePeer` receipts are deliberately unsupported: they need a separately specified price relay and binding model.

V2 starts **unarmed**. A settlement or performance-history timestamp does not establish that the valuation is fresh: a vault may carry an older price forward. The designated Shift NAV reporter must call:

```solidity
oracle.attestNav(expectedPrice, observedAt);
```

`observedAt` must be the actual valuation observation time, no later than the current block and no older than `maxAge`. It must strictly increase from the previous attestation. `expectedPrice` must exactly match the paired vault's current `latestSharePrice()`. The oracle reverts before the first attestation, after it expires, or after the source price changes until a matching fresh attestation is supplied. Deployment does not create an initial attestation. The reporter remains trusted to report an honest observation time; its address and the freshness threshold are immutable. Integrate this transaction into Shift's existing NAV keeper before launching a V2 pool, and choose `maxAge` for the actual NAV publication cadence.

Only accounting ERC-20s with 1 through 18 decimals are supported. Fee-on-transfer receipts are rejected through exact incoming/outgoing balance-delta checks. Deposits also reject receipt undercollateralization. Rebasing receipts are unsupported; the supported Shift receipt contracts are expected to use ordinary ERC-20 balances.

## Settlement and yield

Depositing one receipt mints one SY; redeeming one SY returns one receipt. The SY never promises immediate accounting-asset withdrawal. Principal and yield settlement still use receipt tokens, then Shift's normal withdrawal process. Pending USDC/EURC withdrawals, fees, vault losses, and receipt liquidity remain properties of the underlying vault.

The SY has no token reward list and implements no off-chain points distributor. Shift must separately route points to eligible YT/LP holders. Pendle's nondecreasing PY index does not claw distributed yield back after a later NAV decline, so a loss can reduce PT's accounting-asset value below par.

## Build and verification

```sh
forge test --root contracts/oracle-sy --match-contract ShiftOracleSyTest
node app/scripts/build-oracle-sy.mjs
node app/scripts/build-oracle-sy.mjs --check
```

To exercise both profiles against the deployed Pendle helper/factory on a Base fork:

```sh
ORACLE_SY_FORK_RPC_URL=https://base.publicnode.com forge test --root contracts/oracle-sy --match-contract PendleCompatibilityTest --evm-version cancun -vv
node app/scripts/build-oracle-sy.mjs --check
```

The fork suite creates and seeds markets, checks six-decimal PT/YT accounting, claims yield after NAV growth, and redeems matured PT back into receipts. It uses mock Shift sources against real Pendle contracts, not a production Shift vault admission test. The final artifact check rebuilds the browser bytecode with the pinned Paris settings after the Cancun fork run.

Build settings are pinned in `foundry.toml`: Solidity 0.8.26, optimizer 200, via IR, Paris EVM, metadata disabled. The generator includes a SHA-256 digest over Solidity sources and the compiler configuration, and emits ABI plus creation bytecode for browser deployment. `--check` recompiles and rejects any mismatch with the checked-in artifact. Foundry requires its matching compiler to be available (or downloaded on the first build).

The offline suite exercises unit conversions, freshness boundaries, invalid source bindings, unarmed V2 activation, price-change invalidation, reporter authorization, immutable config, ownership/pause behavior, internal-balance redemption, transfer fees, and modeled PT/YT accounting. Pendle deployment compatibility is checked separately by the opt-in RPC fork test; local unit results alone do not establish live pool suitability.

Dependency versions, the single documented vendored hook change, and licenses are recorded in `vendor/PROVENANCE.md`. This is new integration code with no audit claim. No contract or pool is deployed by building or testing it.
