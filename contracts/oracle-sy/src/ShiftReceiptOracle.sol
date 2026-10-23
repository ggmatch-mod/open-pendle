// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IShiftV1Receipt {
    function baseToken() external view returns (address);
    function tvlFeed() external view returns (address);
    function getSharePrice() external view returns (uint256);
}

interface IShiftV1TvlFeed {
    struct TvlData { uint256 value; uint256 timestamp; uint256 supplySnapshot; }
    function decimals() external view returns (uint8);
    function getLastTvl() external view returns (TvlData memory);
}

interface IShiftV2Receipt {
    function vault() external view returns (address);
}

interface IShiftV2Vault {
    function share() external view returns (address);
    function asset() external view returns (address);
    function latestSharePrice() external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

/// @notice Immutable same-chain accounting oracle for Shift V1 receipts or V2 SyShare.
/// @dev Pendle rate units: raw accounting-asset units per 1e18 receipt units.
///      A V2 settlement timestamp may carry forward an old price. Therefore V2
///      requires the designated NAV reporter to attest the actual observation time.
contract ShiftReceiptOracle {
    error InvalidConfiguration();
    error InvalidBinding();
    error InvalidPrice();
    error StaleNav();
    error UnauthorizedReporter();
    error PriceChanged();

    uint8 public immutable sourceKind;
    address public immutable receipt;
    address public immutable source;
    address public immutable accountingAsset;
    address public immutable tvlFeed;
    uint8 public immutable accountingDecimals;
    uint8 public immutable feedDecimals;
    uint32 public immutable maxAge;
    address public immutable reporter;

    uint64 public lastObservedAt;
    uint256 public lastObservedPrice;

    event NavAttested(uint256 price, uint64 observedAt);

    constructor(
        uint8 kind,
        address receipt_,
        address source_,
        address accountingAsset_,
        uint32 maxAge_,
        address reporter_
    ) {
        if (receipt_.code.length == 0 || source_.code.length == 0 || accountingAsset_.code.length == 0 || maxAge_ == 0) {
            revert InvalidConfiguration();
        }
        uint8 assetDecimals = IERC20Metadata(accountingAsset_).decimals();
        if (IERC20Metadata(receipt_).decimals() != 18 || assetDecimals == 0 || assetDecimals > 18) {
            revert InvalidConfiguration();
        }
        sourceKind = kind;
        receipt = receipt_;
        source = source_;
        accountingAsset = accountingAsset_;
        accountingDecimals = assetDecimals;
        maxAge = maxAge_;
        reporter = reporter_;

        if (kind == 1) {
            if (source_ != receipt_ || reporter_ != address(0) || IShiftV1Receipt(source_).baseToken() != accountingAsset_) {
                revert InvalidBinding();
            }
            address feed = IShiftV1Receipt(source_).tvlFeed();
            if (feed.code.length == 0) revert InvalidBinding();
            uint8 decimals_ = IShiftV1TvlFeed(feed).decimals();
            if (decimals_ > 18) revert InvalidConfiguration();
            tvlFeed = feed;
            feedDecimals = decimals_;
            // Validate shape/binding even if NAV is stale; deploying the SY does
            // not invent a fresh sample or grant any right to launch a market.
            IShiftV1TvlFeed(feed).getLastTvl();
        } else if (kind == 2) {
            if (source_ == receipt_ || reporter_ == address(0)) revert InvalidConfiguration();
            if (IShiftV2Vault(source_).share() != receipt_ || IShiftV2Receipt(receipt_).vault() != source_ || IShiftV2Vault(source_).asset() != accountingAsset_) {
                revert InvalidBinding();
            }
            tvlFeed = address(0);
            feedDecimals = assetDecimals;
            _readV2Price();
        } else {
            revert InvalidConfiguration();
        }
    }

    /// @notice Attest a real NAV observation after checking the vault's current price.
    /// @dev No attestation is created during deployment. The reporter is trusted
    ///      to use the valuation's observation time, not the time of settlement.
    function attestNav(uint256 expectedPrice, uint64 observedAt) external {
        if (sourceKind != 2 || msg.sender != reporter) revert UnauthorizedReporter();
        _checkTimestamp(observedAt);
        if (observedAt <= lastObservedAt) revert StaleNav();
        _checkV2Binding();
        if (expectedPrice == 0) revert InvalidPrice();
        if (_readV2Price() != expectedPrice) revert PriceChanged();
        lastObservedAt = observedAt;
        lastObservedPrice = expectedPrice;
        emit NavAttested(expectedPrice, observedAt);
    }

    function getExchangeRate() external view returns (uint256 rate) {
        if (sourceKind == 1) {
            if (IShiftV1Receipt(source).baseToken() != accountingAsset || IShiftV1Receipt(source).tvlFeed() != tvlFeed || IShiftV1TvlFeed(tvlFeed).decimals() != feedDecimals) {
                revert InvalidBinding();
            }
            IShiftV1TvlFeed.TvlData memory sample = IShiftV1TvlFeed(tvlFeed).getLastTvl();
            _checkTimestamp(sample.timestamp);
            if (sample.value == 0 || sample.supplySnapshot == 0) revert InvalidPrice();
            uint256 price = IShiftV1Receipt(source).getSharePrice();
            // V1 getSharePrice is in feed decimals; SY assetInfo is in the
            // accounting token's decimals. For 18-decimal shares and USDC6,
            // a $1.05 share returns 1_050_000, not 1.05e18.
            rate = Math.mulDiv(price, 10 ** accountingDecimals, 10 ** feedDecimals);
        } else {
            _checkV2Binding();
            _checkTimestamp(lastObservedAt);
            rate = _readV2Price();
            if (rate != lastObservedPrice) revert PriceChanged();
        }
        if (rate == 0) revert InvalidPrice();
    }

    function _checkV2Binding() internal view {
        if (IShiftV2Vault(source).share() != receipt || IShiftV2Receipt(receipt).vault() != source || IShiftV2Vault(source).asset() != accountingAsset) {
            revert InvalidBinding();
        }
    }

    function _readV2Price() internal view returns (uint256 price) {
        price = IShiftV2Vault(source).latestSharePrice();
        // Check the vault's ERC-7575 conversion agrees with the claimed raw
        // accounting units per whole 18-decimal share. Different V2 versions
        // cannot silently substitute a differently scaled price method.
        if (price == 0 || IShiftV2Vault(source).convertToAssets(1e18) != price) revert InvalidPrice();
    }

    function _checkTimestamp(uint256 timestamp) internal view {
        if (timestamp == 0 || timestamp > block.timestamp || block.timestamp - timestamp > maxAge) revert StaleNav();
    }
}
