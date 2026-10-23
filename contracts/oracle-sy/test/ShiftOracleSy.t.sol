// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {OracleSyBootstrap} from "../src/OracleSyBootstrap.sol";
import {ShiftOracleSY} from "../src/ShiftOracleSY.sol";
import {ShiftReceiptOracle} from "../src/ShiftReceiptOracle.sol";
import {IStandardizedYield} from "../vendor/contracts/interfaces/IStandardizedYield.sol";
import {MockAccountingAsset, MockShiftV1, MockTvlFeed, MockSyShare, MockSyVault} from "./mocks/MockShift.sol";

interface VmOracleTest {
    function warp(uint256 timestamp) external;
    function prank(address sender) external;
    function expectRevert(bytes4 error) external;
    function expectRevert() external;
}

contract ShiftOracleSyTest {
    VmOracleTest constant vm = VmOracleTest(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint32 constant MAX_AGE = 3_600;
    address constant REPORTER = address(0x1234);
    address constant USER = address(0x5678);
    MockAccountingAsset asset;
    MockTvlFeed feed;
    MockShiftV1 v1;
    MockSyShare share;
    MockSyVault vault;

    function setUp() public {
        vm.warp(1_000_000);
        asset = new MockAccountingAsset(6);
        feed = new MockTvlFeed(6);
        feed.setSample(10_500_000, block.timestamp, 10e18);
        v1 = new MockShiftV1(address(asset), address(feed));
        share = new MockSyShare();
        vault = new MockSyVault(address(share), address(asset));
        share.setVault(address(vault));
    }

    function _v1Oracle() private returns (ShiftReceiptOracle) {
        return new ShiftReceiptOracle(1, address(v1), address(v1), address(asset), MAX_AGE, address(0));
    }
    function _v2Oracle() private returns (ShiftReceiptOracle) {
        return new ShiftReceiptOracle(2, address(share), address(vault), address(asset), MAX_AGE, REPORTER);
    }
    function _attest(ShiftReceiptOracle oracle, uint256 price, uint64 time) private {
        vm.prank(REPORTER);
        oracle.attestNav(price, time);
    }
    function _eq(uint256 a, uint256 b) private pure { require(a == b, "uint mismatch"); }
    function _eq(address a, address b) private pure { require(a == b, "address mismatch"); }

    function testV1RawUSDCUnitsAndMetadata() public {
        ShiftReceiptOracle oracle = _v1Oracle();
        _eq(oracle.getExchangeRate(), 1_050_000);
        _eq(oracle.accountingDecimals(), 6);
        _eq(oracle.feedDecimals(), 6);
        _eq(oracle.tvlFeed(), address(feed));
        // 1e18 SY units * 1.05e6 / 1e18 = 1.05e6 USDC units.
        _eq(1e18 * oracle.getExchangeRate() / 1e18, 1_050_000);
    }

    function testV1ConvertsFeedDecimalsToRawAssetUnits() public {
        feed.setDecimals(18);
        v1.setPrice(1.05e18);
        _eq(_v1Oracle().getExchangeRate(), 1_050_000);
        feed.setDecimals(3);
        v1.setPrice(1_050);
        _eq(_v1Oracle().getExchangeRate(), 1_050_000);
    }

    function testFuzzV1DecimalNormalization(uint8 feedD, uint8 assetD, uint64 wholePrice) public {
        feedD = uint8(uint256(feedD) % 19);
        assetD = uint8(uint256(assetD) % 18 + 1);
        uint256 price = uint256(wholePrice) % 1_000_000 + 1;
        MockAccountingAsset otherAsset = new MockAccountingAsset(assetD);
        MockTvlFeed otherFeed = new MockTvlFeed(feedD);
        otherFeed.setSample(1, block.timestamp, 1e18);
        MockShiftV1 otherV1 = new MockShiftV1(address(otherAsset), address(otherFeed));
        otherV1.setPrice(price * 10 ** feedD);
        ShiftReceiptOracle oracle = new ShiftReceiptOracle(1, address(otherV1), address(otherV1), address(otherAsset), MAX_AGE, address(0));
        _eq(oracle.getExchangeRate(), price * 10 ** assetD);
    }

    function testV1StaleFutureAndZeroTimestampFailClosed() public {
        ShiftReceiptOracle oracle = _v1Oracle();
        feed.setSample(1, block.timestamp - MAX_AGE - 1, 1e18);
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector); oracle.getExchangeRate();
        feed.setSample(1, block.timestamp + 1, 1e18);
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector); oracle.getExchangeRate();
        feed.setSample(1, 0, 1e18);
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector); oracle.getExchangeRate();
    }

    function testV1ZeroPriceValueOrSupplyFailsClosed() public {
        ShiftReceiptOracle oracle = _v1Oracle();
        v1.setPrice(0);
        vm.expectRevert(ShiftReceiptOracle.InvalidPrice.selector); oracle.getExchangeRate();
        v1.setPrice(1_000_000);
        feed.setSample(0, block.timestamp, 1e18);
        vm.expectRevert(ShiftReceiptOracle.InvalidPrice.selector); oracle.getExchangeRate();
        feed.setSample(1, block.timestamp, 0);
        vm.expectRevert(ShiftReceiptOracle.InvalidPrice.selector); oracle.getExchangeRate();
    }

    function testV1FreshnessBoundary() public {
        ShiftReceiptOracle oracle = _v1Oracle();
        vm.warp(block.timestamp + MAX_AGE);
        _eq(oracle.getExchangeRate(), 1_050_000);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector); oracle.getExchangeRate();
    }

    function testV1FeedAssetAndDecimalsChangesInvalidateOracle() public {
        ShiftReceiptOracle oracle = _v1Oracle();
        feed.setDecimals(18);
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector); oracle.getExchangeRate();
        feed.setDecimals(6);
        v1.setFeed(address(asset));
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector); oracle.getExchangeRate();
        v1.setFeed(address(feed));
        v1.setAsset(address(share));
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector); oracle.getExchangeRate();
    }

    function testV1WrongConfigurationRejected() public {
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector);
        new ShiftReceiptOracle(1, address(v1), address(v1), address(asset), MAX_AGE, REPORTER);
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector);
        new ShiftReceiptOracle(1, address(v1), address(vault), address(asset), MAX_AGE, address(0));
        vm.expectRevert(ShiftReceiptOracle.InvalidConfiguration.selector);
        new ShiftReceiptOracle(3, address(v1), address(v1), address(asset), MAX_AGE, address(0));
        vm.expectRevert(ShiftReceiptOracle.InvalidConfiguration.selector);
        new ShiftReceiptOracle(1, address(v1), address(v1), address(asset), 0, address(0));
        v1.setDecimals(6);
        vm.expectRevert(ShiftReceiptOracle.InvalidConfiguration.selector); _v1Oracle();
    }

    function testAccountingAndFeedDecimalsOutsideRangeRejected() public {
        MockAccountingAsset invalidAsset = new MockAccountingAsset(19);
        vm.expectRevert(ShiftReceiptOracle.InvalidConfiguration.selector);
        new ShiftReceiptOracle(1, address(v1), address(v1), address(invalidAsset), MAX_AGE, address(0));
        invalidAsset = new MockAccountingAsset(0);
        vm.expectRevert(ShiftReceiptOracle.InvalidConfiguration.selector);
        new ShiftReceiptOracle(1, address(v1), address(v1), address(invalidAsset), MAX_AGE, address(0));
        feed.setDecimals(19);
        vm.expectRevert(ShiftReceiptOracle.InvalidConfiguration.selector); _v1Oracle();
    }

    function testV2UnarmedThenAttestedAndPriceChangeBlocks() public {
        ShiftReceiptOracle oracle = _v2Oracle();
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector); oracle.getExchangeRate();
        _attest(oracle, 1_050_000, uint64(block.timestamp));
        _eq(oracle.getExchangeRate(), 1_050_000);
        vault.setPrice(1_060_000);
        vm.expectRevert(ShiftReceiptOracle.PriceChanged.selector); oracle.getExchangeRate();
        uint64 nextTime = uint64(block.timestamp + 1);
        vm.warp(nextTime);
        _attest(oracle, 1_060_000, nextTime);
        _eq(oracle.getExchangeRate(), 1_060_000);
    }

    function testV2SampleAgesEvenIfVaultCarriesPriceForward() public {
        ShiftReceiptOracle oracle = _v2Oracle();
        _attest(oracle, 1_050_000, uint64(block.timestamp - MAX_AGE));
        _eq(oracle.getExchangeRate(), 1_050_000);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector); oracle.getExchangeRate();
    }

    function testV2OnlyReporterMayAttest() public {
        ShiftReceiptOracle oracle = _v2Oracle();
        vm.expectRevert(ShiftReceiptOracle.UnauthorizedReporter.selector);
        oracle.attestNav(1_050_000, uint64(block.timestamp));
    }

    function testV2CannotAttestDifferentPriceZeroOrInvalidTimestamp() public {
        ShiftReceiptOracle oracle = _v2Oracle();
        vm.expectRevert(ShiftReceiptOracle.PriceChanged.selector);
        _attest(oracle, 1_060_000, uint64(block.timestamp));
        vm.expectRevert(ShiftReceiptOracle.InvalidPrice.selector);
        _attest(oracle, 0, uint64(block.timestamp));
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector);
        _attest(oracle, 1_050_000, uint64(block.timestamp + 1));
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector);
        _attest(oracle, 1_050_000, uint64(block.timestamp - MAX_AGE - 1));
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector);
        _attest(oracle, 1_050_000, 0);
    }

    function testV2CannotRenewWithSameObservationTimestamp() public {
        ShiftReceiptOracle oracle = _v2Oracle();
        uint64 time = uint64(block.timestamp);
        _attest(oracle, 1_050_000, time);
        vm.warp(block.timestamp + 100);
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector); _attest(oracle, 1_050_000, time);
    }

    function testV2BindingChangesInvalidateRateAndAttestation() public {
        ShiftReceiptOracle oracle = _v2Oracle();
        _attest(oracle, 1_050_000, uint64(block.timestamp));
        vault.setShare(address(v1));
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector); oracle.getExchangeRate();
        uint64 nextTime = uint64(block.timestamp + 1);
        vm.warp(nextTime);
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector); _attest(oracle, 1_050_000, nextTime);
        vault.setShare(address(share));
        share.setVault(address(v1));
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector); oracle.getExchangeRate();
        share.setVault(address(vault));
        vault.setAsset(address(v1));
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector); oracle.getExchangeRate();
    }

    function testV2WrongReceiptBindingAndMissingReporterRejected() public {
        share.setVault(address(v1));
        vm.expectRevert(ShiftReceiptOracle.InvalidBinding.selector); _v2Oracle();
        share.setVault(address(vault));
        vm.expectRevert(ShiftReceiptOracle.InvalidConfiguration.selector);
        new ShiftReceiptOracle(2, address(share), address(vault), address(asset), MAX_AGE, address(0));
    }

    function testV2MismatchedConversionConventionRejected() public {
        vault.setConversionScale(1e6);
        vm.expectRevert(ShiftReceiptOracle.InvalidPrice.selector); _v2Oracle();
        vault.setConversionScale(1e18);
        ShiftReceiptOracle oracle = _v2Oracle();
        _attest(oracle, 1_050_000, uint64(block.timestamp));
        vault.setConversionScale(1e6);
        vm.expectRevert(ShiftReceiptOracle.InvalidPrice.selector); oracle.getExchangeRate();
        uint64 nextTime = uint64(block.timestamp + 1);
        vm.warp(nextTime);
        vm.expectRevert(ShiftReceiptOracle.InvalidPrice.selector); _attest(oracle, 1_050_000, nextTime);
    }

    function testBootstrapAtomicallyAssignsOwnerAndBindsConfiguration() public {
        OracleSyBootstrap bootstrap = new OracleSyBootstrap(1, address(v1), address(v1), address(asset), MAX_AGE, address(0), "SY extUSD", "SY-extUSD", USER);
        ShiftOracleSY sy = ShiftOracleSY(payable(bootstrap.sy()));
        ShiftReceiptOracle oracle = ShiftReceiptOracle(bootstrap.oracle());
        _eq(sy.owner(), USER);
        _eq(sy.yieldToken(), address(v1));
        _eq(sy.exchangeRateOracle(), address(oracle));
        _eq(sy.underlyingAsset(), address(asset));
        _eq(sy.decimals(), 18);
        (IStandardizedYield.AssetType kind, address accounting, uint8 decimals_) = sy.assetInfo();
        _eq(uint8(kind), 0); _eq(accounting, address(asset)); _eq(decimals_, 6);
        _eq(sy.exchangeRate(), 1_050_000);
        require(!sy.paused(), "unexpected pause");
        _eq(sy.getTokensIn().length, 1); _eq(sy.getTokensOut().length, 1);
        _eq(sy.getTokensIn()[0], address(v1)); _eq(sy.getTokensOut()[0], address(v1));
    }

    function testV2BootstrapDeploysUnarmed() public {
        OracleSyBootstrap bootstrap = new OracleSyBootstrap(2, address(share), address(vault), address(asset), MAX_AGE, REPORTER, "SY syUSDC", "SY-syUSDC", address(this));
        ShiftReceiptOracle oracle = ShiftReceiptOracle(bootstrap.oracle());
        _eq(oracle.lastObservedAt(), 0);
        ShiftOracleSY sy = ShiftOracleSY(payable(bootstrap.sy()));
        vm.expectRevert(ShiftReceiptOracle.StaleNav.selector); sy.exchangeRate();
        _attest(oracle, 1_050_000, uint64(block.timestamp));
        _eq(sy.exchangeRate(), 1_050_000);
    }

    function testBootstrapRejectsZeroOwnerAndEmptyMetadata() public {
        vm.expectRevert(OracleSyBootstrap.InvalidOwnerOrMetadata.selector);
        new OracleSyBootstrap(1, address(v1), address(v1), address(asset), MAX_AGE, address(0), "SY", "SY", address(0));
        vm.expectRevert(OracleSyBootstrap.InvalidOwnerOrMetadata.selector);
        new OracleSyBootstrap(1, address(v1), address(v1), address(asset), MAX_AGE, address(0), "", "SY", USER);
    }

    function testSYReceiptOnlyWrappingRedemptionAndMinimums() public {
        ShiftOracleSY sy = new ShiftOracleSY("SY extUSD", "SY-extUSD", address(v1), address(_v1Oracle()));
        v1.mint(address(this), 5e18);
        v1.approve(address(sy), 5e18);
        _eq(sy.previewDeposit(address(v1), 5e18), 5e18);
        _eq(sy.previewRedeem(address(v1), 5e18), 5e18);
        _eq(sy.deposit(address(this), address(v1), 5e18, 5e18), 5e18);
        _eq(sy.balanceOf(address(this)), 5e18);
        vm.expectRevert(); sy.redeem(USER, 1e18, address(asset), 0, false);
        vm.expectRevert(); sy.redeem(USER, 1e18, address(v1), 2e18, false);
        _eq(sy.redeem(USER, 5e18, address(v1), 5e18, false), 5e18);
        _eq(v1.balanceOf(USER), 5e18); _eq(sy.totalSupply(), 0);
    }

    function testSYInternalBalanceRedemptionCompatibleWithPendle() public {
        ShiftOracleSY sy = new ShiftOracleSY("SY", "SY", address(v1), address(_v1Oracle()));
        v1.mint(address(this), 1e18); v1.approve(address(sy), 1e18);
        sy.deposit(address(this), address(v1), 1e18, 0);
        sy.transfer(address(sy), 1e18);
        sy.redeem(USER, 1e18, address(v1), 1e18, true);
        _eq(v1.balanceOf(USER), 1e18); _eq(sy.totalSupply(), 0);
    }

    function testSYRejectsFeeOnTransferEvenWhenDonationsCoverFee() public {
        ShiftOracleSY sy = new ShiftOracleSY("SY", "SY", address(v1), address(_v1Oracle()));
        v1.mint(address(this), 2e18); v1.mint(address(sy), 1e18);
        v1.approve(address(sy), 2e18); v1.setFee(100);
        vm.expectRevert(ShiftOracleSY.UnsupportedTransfer.selector);
        sy.deposit(address(this), address(v1), 1e18, 0);
        _eq(sy.totalSupply(), 0);
    }

    function testSYRejectsOutgoingFeeAndDepositAfterNegativeRebase() public {
        ShiftOracleSY sy = new ShiftOracleSY("SY", "SY", address(v1), address(_v1Oracle()));
        v1.mint(address(this), 2e18); v1.approve(address(sy), 2e18);
        sy.deposit(address(this), address(v1), 1e18, 0);
        v1.setFee(100);
        vm.expectRevert(ShiftOracleSY.UnsupportedTransfer.selector); sy.redeem(USER, 1e18, address(v1), 0, false);
        v1.setFee(0); v1.slash(address(sy), 1);
        vm.expectRevert(ShiftOracleSY.UnsupportedTransfer.selector); sy.deposit(address(this), address(v1), 1e18, 0);
    }

    function testOwnerCanPauseButCannotChangeOracleConfiguration() public {
        ShiftReceiptOracle oracle = _v1Oracle();
        ShiftOracleSY sy = new ShiftOracleSY("SY", "SY", address(v1), address(oracle));
        v1.mint(address(this), 2e18); v1.approve(address(sy), 2e18);
        sy.deposit(address(this), address(v1), 1e18, 0);
        vm.prank(USER); vm.expectRevert(); sy.pause();
        sy.pause();
        vm.expectRevert(); sy.deposit(address(this), address(v1), 1e18, 0);
        vm.expectRevert(); sy.redeem(USER, 1e18, address(v1), 0, false);
        vm.expectRevert(); sy.transfer(USER, 1);
        sy.unpause(); sy.transfer(USER, 1);
        (bool success,) = address(sy).call(abi.encodeWithSignature("setExchangeRateOracle(address)", USER));
        require(!success, "oracle mutable");
        _eq(sy.exchangeRateOracle(), address(oracle));
    }

    function testFuzzFixedPrincipalAndYieldSplitInUSDCUnits(uint64 principalSeed, uint32 growthSeed) public pure {
        uint256 receiptAmount = (uint256(principalSeed) % 1_000_000 + 1) * 1e18;
        uint256 initialRate = 1_000_000;
        uint256 finalRate = initialRate + uint256(growthSeed) % 1_000_001;
        uint256 principal = receiptAmount * initialRate / 1e18;
        uint256 syForPrincipal = principal * 1e18 / finalRate;
        uint256 syForYield = receiptAmount - syForPrincipal;
        // Pendle rounding leaves at most one raw accounting-asset unit of dust.
        require(principal - syForPrincipal * finalRate / 1e18 <= 1, "principal unit mismatch");
        require(syForYield * finalRate / 1e18 + syForPrincipal * finalRate / 1e18 <= receiptAmount * finalRate / 1e18, "yield overallocated");
    }
}
