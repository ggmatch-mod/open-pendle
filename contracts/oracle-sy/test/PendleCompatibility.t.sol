// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {OracleSyBootstrap} from "../src/OracleSyBootstrap.sol";
import {ShiftOracleSY} from "../src/ShiftOracleSY.sol";
import {ShiftReceiptOracle} from "../src/ShiftReceiptOracle.sol";
import {MockAccountingAsset, MockShiftV1, MockTvlFeed, MockSyShare, MockSyVault} from "./mocks/MockShift.sol";

interface VmPendleCompatibility {
    function envOr(string calldata key, string calldata fallbackValue) external returns (string memory);
    function createSelectFork(string calldata rpc) external returns (uint256);
    function skip(bool skipTest) external;
    function warp(uint256 timestamp) external;
    function roll(uint256 blockNumber) external;
    function getBlockTimestamp() external view returns (uint256);
    function getBlockNumber() external view returns (uint256);
    function prank(address sender) external;
}

struct CompatibilityPoolConfig {
    uint32 expiry;
    uint256 rateMin;
    uint256 rateMax;
    uint256 desiredImpliedRate;
    uint256 fee;
}
struct CompatibilityPoolAddresses { address SY; address PT; address YT; address market; }
interface ICompatibilityHelper {
    function yieldContractFactory() external view returns (address);
    function deploy5115MarketAndSeedLiquidity(address sy, CompatibilityPoolConfig calldata config, address token, uint256 seed)
        external payable returns (CompatibilityPoolAddresses memory);
}
interface ICompatibilityFactory { function expiryDivisor() external view returns (uint96); }
interface ICompatibilityToken {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}
interface ICompatibilityYT {
    function mintPY(address receiverPT, address receiverYT) external returns (uint256 amountPYOut);
    function redeemPY(address receiver) external returns (uint256 amountSyOut);
    function redeemDueInterestAndRewards(address user, bool redeemInterest, bool redeemRewards)
        external returns (uint256 interestOut, uint256[] memory rewardsOut);
}

/// @notice Optional real Pendle helper/factory/router compatibility on a read-only fork.
/// @dev Run with ORACLE_SY_FORK_RPC_URL and --evm-version cancun. The default
///      offline suite skips these tests and retains Paris deployment bytecode.
contract PendleCompatibilityTest {
    VmPendleCompatibility private constant vm = VmPendleCompatibility(address(uint160(uint256(keccak256("hevm cheat code")))));
    ICompatibilityHelper private constant helper = ICompatibilityHelper(0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9);
    address private constant HOLDER = address(0x123456);
    uint32 private constant MAX_AGE = 3_600;
    uint256 private constant SEED = 2_000e18;

    struct Context {
        MockAccountingAsset asset;
        MockTvlFeed feed;
        MockShiftV1 v1;
        MockSyShare share;
        MockSyVault vault;
        ShiftOracleSY sy;
        ShiftReceiptOracle oracle;
        ICompatibilityToken receipt;
        CompatibilityPoolAddresses pool;
        uint256 time;
        uint256 forkBlock;
        uint32 expiry;
    }

    function setUp() public {
        string memory rpc = vm.envOr("ORACLE_SY_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpc);
        require(address(helper).code.length != 0, "Pendle helper unavailable on fork");
    }

    function testV1AccountingSYSeedsRealMarketAndSplitsYield() public { _exercise(1); }
    function testV2AccountingSYSeedsRealMarketAndSplitsYield() public { _exercise(2); }

    function _exercise(uint8 kind) private {
        Context memory c;
        c.time = vm.getBlockTimestamp();
        c.forkBlock = vm.getBlockNumber();
        c.asset = new MockAccountingAsset(6);
        c.feed = new MockTvlFeed(6);
        c.feed.setSample(2_100e6, c.time, 2_000e18);
        c.v1 = new MockShiftV1(address(c.asset), address(c.feed));
        c.share = new MockSyShare();
        c.vault = new MockSyVault(address(c.share), address(c.asset));
        c.share.setVault(address(c.vault));
        c.receipt = ICompatibilityToken(kind == 1 ? address(c.v1) : address(c.share));
        OracleSyBootstrap bootstrap = new OracleSyBootstrap(
            kind, address(c.receipt), kind == 1 ? address(c.v1) : address(c.vault),
            address(c.asset), MAX_AGE, kind == 1 ? address(0) : address(this),
            "SY Shift compatibility", "SY-SHIFT", address(this)
        );
        c.sy = ShiftOracleSY(payable(bootstrap.sy()));
        c.oracle = ShiftReceiptOracle(bootstrap.oracle());
        if (kind == 2) c.oracle.attestNav(1_050_000, uint64(c.time));
        require(c.sy.exchangeRate() == 1_050_000, "wrong initial raw accounting rate");

        uint256 divisor = ICompatibilityFactory(helper.yieldContractFactory()).expiryDivisor();
        c.expiry = uint32(((c.time + 90 days) / divisor + 1) * divisor);
        CompatibilityPoolConfig memory config = CompatibilityPoolConfig(c.expiry, 2e16, 2e17, 8e16, 8e15);
        if (kind == 1) c.v1.mint(address(this), SEED + 100e18);
        else c.share.mint(address(this), SEED + 100e18);
        c.receipt.approve(address(helper), SEED);
        c.pool = helper.deploy5115MarketAndSeedLiquidity(address(c.sy), config, address(c.receipt), SEED);
        require(c.pool.SY == address(c.sy), "helper used different SY");
        require(ICompatibilityToken(c.pool.PT).decimals() == 6, "PT units must be raw accounting units");
        require(ICompatibilityToken(c.pool.YT).decimals() == 6, "YT units must be raw accounting units");
        require(ICompatibilityToken(c.pool.market).balanceOf(address(this)) > 0, "seed did not issue LP");

        // Direct tokenization confirms the 18-decimal receipt -> 6-decimal
        // accounting claim independently of the AMM's seed/trade calculation.
        c.receipt.approve(address(c.sy), 100e18);
        c.sy.deposit(address(this), address(c.receipt), 100e18, 100e18);
        c.sy.transfer(c.pool.YT, 100e18);
        uint256 minted = ICompatibilityYT(c.pool.YT).mintPY(HOLDER, HOLDER);
        require(minted == 105e6, "100 receipts must mint 105 accounting PT/YT");
        require(ICompatibilityToken(c.pool.PT).balanceOf(HOLDER) == 105e6, "wrong principal balance");

        vm.warp(c.time + 1);
        vm.roll(c.forkBlock + 1);
        _refresh(c, kind, c.time + 1);
        uint256 beforeInterest = c.sy.balanceOf(HOLDER);
        (uint256 interest,) = ICompatibilityYT(c.pool.YT).redeemDueInterestAndRewards(HOLDER, true, false);
        require(interest > 0 && c.sy.balanceOf(HOLDER) > beforeInterest, "YT did not receive share-price growth");
        require(ICompatibilityToken(c.pool.PT).balanceOf(HOLDER) == 105e6, "PT principal changed with yield");

        // At maturity PT settles in fewer receipt tokens worth the fixed
        // accounting principal. No synchronous USDC conversion is required.
        vm.warp(uint256(c.expiry) + 1);
        vm.roll(c.forkBlock + 2);
        _refresh(c, kind, uint256(c.expiry) + 1);
        vm.prank(HOLDER);
        ICompatibilityToken(c.pool.PT).transfer(c.pool.YT, minted);
        uint256 principalSy = ICompatibilityYT(c.pool.YT).redeemPY(HOLDER);
        uint256 expected = minted * 1e18 / 1_100_000;
        require(principalSy >= expected && principalSy <= expected + 1, "PT maturity accounting amount incorrect");
        uint256 receiptBefore = c.receipt.balanceOf(HOLDER);
        vm.prank(HOLDER);
        c.sy.redeem(HOLDER, principalSy, address(c.receipt), principalSy, false);
        require(c.receipt.balanceOf(HOLDER) - receiptBefore == principalSy, "principal did not unwrap to receipt");
    }

    function _refresh(Context memory c, uint8 kind, uint256 observation) private {
        if (kind == 1) {
            c.v1.setPrice(1_100_000);
            c.feed.setSample(2_200e6, observation, 2_000e18);
        } else {
            c.vault.setPrice(1_100_000);
            c.oracle.attestNav(1_100_000, uint64(observation));
        }
    }
}
