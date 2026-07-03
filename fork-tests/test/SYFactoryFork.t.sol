// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

// ---------------------------------------------------------------- interfaces

interface IFactory {
    function deploySY(bytes32 id, bytes memory constructorParams, address syOwner) external returns (address SY);
    function deployUpgradableSY(bytes32 id, bytes memory constructorParams, bytes memory initData, address syOwner)
        external
        returns (address);
    function creationCodes(bytes32) external view returns (address, uint256, address, uint256);
    function proxyAdmin() external view returns (address);
}

struct PoolConfig {
    uint32 expiry;
    uint256 rateMin;
    uint256 rateMax;
    uint256 desiredImpliedRate;
    uint256 fee;
}

struct PoolDeploymentAddrs {
    address SY;
    address PT;
    address YT;
    address market;
}

interface IHelper {
    function deployERC20Market(
        bytes memory constructorParams,
        PoolConfig memory config,
        address tokenToSeedLiqudity,
        uint256 amountToSeed,
        address syOwner
    ) external returns (PoolDeploymentAddrs memory);

    function deployERC20WithAdapterMarket(
        bytes memory constructorParams,
        bytes memory initData,
        PoolConfig memory config,
        address tokenToSeedLiqudity,
        uint256 amountToSeed,
        address syOwner
    ) external returns (PoolDeploymentAddrs memory);

    function deployERC4626WithAdapterMarket(
        bytes memory constructorParams,
        bytes memory initData,
        PoolConfig memory config,
        address tokenToSeedLiqudity,
        uint256 amountToSeed,
        address syOwner
    ) external returns (PoolDeploymentAddrs memory);

    function deployERC4626NoRedeemWithAdapterMarket(
        bytes memory constructorParams,
        bytes memory initData,
        PoolConfig memory config,
        address tokenToSeedLiqudity,
        uint256 amountToSeed,
        address syOwner
    ) external returns (PoolDeploymentAddrs memory);

    function deployCommonMarketById(
        bytes32 id,
        bytes memory constructorParams,
        bytes memory initData,
        PoolConfig memory config,
        address tokenToSeedLiqudity,
        uint256 amountToSeed,
        address syOwner
    ) external returns (PoolDeploymentAddrs memory);

    function deploy5115MarketAndSeedLiquidity(
        address SY,
        PoolConfig memory config,
        address tokenToSeedLiqudity,
        uint256 amountToSeed
    ) external payable returns (PoolDeploymentAddrs memory);
}

interface ISY {
    function deposit(address receiver, address tokenIn, uint256 amountTokenToDeposit, uint256 minSharesOut)
        external
        payable
        returns (uint256);
    function redeem(
        address receiver,
        uint256 amountSharesToRedeem,
        address tokenOut,
        uint256 minTokenOut,
        bool burnFromInternalBalance
    ) external returns (uint256);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function owner() external view returns (address);
    function adapter() external view returns (address);
    function offchainRewardManager() external view returns (address);
    function yieldToken() external view returns (address);
    function exchangeRate() external view returns (uint256);
    function getTokensIn() external view returns (address[] memory);
    function getTokensOut() external view returns (address[] memory);
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function isValidTokenIn(address) external view returns (bool);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IYCF {
    function expiryDivisor() external view returns (uint96);
}

interface IWETH {
    function deposit() external payable;
    function transfer(address, uint256) external returns (bool);
}

// ---------------------------------------------------------------- mocks

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function mint(address to, uint256 amt) public {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function _burn(address from, uint256 amt) internal {
        balanceOf[from] -= amt;
        totalSupply -= amt;
    }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        return _xfer(msg.sender, to, amt);
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amt;
        return _xfer(from, to, amt);
    }

    function _xfer(address from, address to, uint256 amt) internal virtual returns (bool) {
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// 1% burned on every transfer
contract MockFOT is MockERC20 {
    constructor() MockERC20("FeeOnTransfer", "FOT") {}

    function _xfer(address from, address to, uint256 amt) internal override returns (bool) {
        uint256 fee = amt / 100;
        balanceOf[from] -= amt;
        balanceOf[to] += amt - fee;
        totalSupply -= fee;
        return true;
    }
}

/// minimal 1:1 ERC4626 over `asset_`
contract MockERC4626 is MockERC20 {
    address public immutable asset_;

    constructor(address a) MockERC20("MockVault", "mVLT") {
        asset_ = a;
    }

    function asset() external view returns (address) {
        return asset_;
    }

    function totalAssets() external view returns (uint256) {
        return MockERC20(asset_).balanceOf(address(this));
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        MockERC20(asset_).transferFrom(msg.sender, address(this), assets);
        mint(receiver, assets);
        return assets;
    }

    function redeem(uint256 shares, address receiver, address owner_) external returns (uint256) {
        require(owner_ == msg.sender, "owner");
        _burn(owner_, shares);
        MockERC20(asset_).transfer(receiver, shares);
        return shares;
    }

    function convertToAssets(uint256 shares) external pure returns (uint256) {
        return shares;
    }

    function convertToShares(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    function previewRedeem(uint256 shares) external pure returns (uint256) {
        return shares;
    }
}

/// adapter: pivot = a MockERC20 it can mint; accepts `alt` ERC20 and native ETH
contract MockAdapter {
    address public immutable PIVOT_TOKEN;
    address public immutable alt;

    constructor(address pivot, address alt_) {
        PIVOT_TOKEN = pivot;
        alt = alt_;
    }

    receive() external payable {}

    function getAdapterTokensDeposit() external view returns (address[] memory t) {
        t = new address[](2);
        t[0] = alt;
        t[1] = address(0); // NATIVE
    }

    function getAdapterTokensRedeem() external view returns (address[] memory t) {
        t = new address[](1);
        t[0] = alt;
    }

    function convertToDeposit(address tokenIn, uint256 amt) external returns (uint256) {
        require(tokenIn == alt || tokenIn == address(0), "tokenIn");
        MockERC20(PIVOT_TOKEN).mint(msg.sender, amt); // send pivot to SY
        return amt;
    }

    function convertToRedeem(address tokenOut, uint256 amt) external returns (uint256) {
        require(tokenOut == alt, "tokenOut");
        MockERC20(alt).mint(msg.sender, amt); // send alt to SY
        return amt;
    }

    function previewConvertToDeposit(address, uint256 amt) external pure returns (uint256) {
        return amt;
    }

    function previewConvertToRedeem(address, uint256 amt) external pure returns (uint256) {
        return amt;
    }
}

/// adapter with pivot = WETH, accepts native only, wraps it
contract MockWETHAdapter {
    address public immutable PIVOT_TOKEN;

    constructor(address weth) {
        PIVOT_TOKEN = weth;
    }

    receive() external payable {}

    function getAdapterTokensDeposit() external pure returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(0);
    }

    function getAdapterTokensRedeem() external pure returns (address[] memory t) {
        t = new address[](0);
    }

    function convertToDeposit(address tokenIn, uint256 amt) external returns (uint256) {
        require(tokenIn == address(0), "tokenIn");
        IWETH(PIVOT_TOKEN).deposit{value: amt}();
        IWETH(PIVOT_TOKEN).transfer(msg.sender, amt);
        return amt;
    }

    function convertToRedeem(address, uint256) external pure returns (uint256) {
        revert("no redeem");
    }

    function previewConvertToDeposit(address, uint256 amt) external pure returns (uint256) {
        return amt;
    }

    function previewConvertToRedeem(address, uint256) external pure returns (uint256) {
        return 0;
    }
}

// ---------------------------------------------------------------- test

contract SYFactoryForkTest is Test {
    IFactory constant factory = IFactory(0x466CeD3b33045Ea986B2f306C8D0aA8067961CF8);
    IHelper constant helper = IHelper(0x2Ed473F528E5B320f850d17ADfe0e558f0298aA9);
    address constant YCF_V6 = 0xBA814Bf6E27A6d6baE4a8aC65c8Bc3d8e9B0aaCF;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant PENDLE_PROXY_ADMIN = 0xA28c08f165116587D4F3E708743B4dEe155c5E64;
    bytes32 constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    bytes32 constant ERC20_ID = keccak256("PendleERC20SY");
    bytes32 constant ERC4626_ID = keccak256("PendleERC4626SYV2");
    bytes32 constant ERC4626_NR_ID = keccak256("PendleERC4626NotRedeemableToAssetSYV2");
    bytes32 constant ERC20_ADAPTER_ID = keccak256("PendleERC20WithAdapterSY");
    bytes32 constant ERC4626_ADAPTER_ID = keccak256("PendleERC4626WithAdapterSY");
    bytes32 constant ERC4626_NR_ADAPTER_ID = keccak256("PendleERC4626NoRedeemWithAdapterSY");
    bytes32 constant ERC4626_NDNR_ID = keccak256("PendleERC4626NoRedeemNoDepositUpgSY");

    address alice = makeAddr("alice");
    uint32 expiry;

    function setUp() public {
        uint256 divisor = IYCF(YCF_V6).expiryDivisor();
        expiry = uint32(((block.timestamp / divisor) + 26) * divisor);
    }

    function _cfg() internal view returns (PoolConfig memory) {
        return PoolConfig({
            expiry: expiry,
            rateMin: 0.02e18,
            rateMax: 0.50e18,
            desiredImpliedRate: 0.10e18,
            fee: 0.005e18
        });
    }

    function _initData3(address adapter) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("initialize(string,string,address)", "SY Test", "SY-TEST", adapter);
    }

    // 1. all 7 ids registered
    function test_allSevenIdsRegistered() public view {
        bytes32[7] memory ids = [
            ERC20_ID,
            ERC4626_ID,
            ERC4626_NR_ID,
            ERC20_ADAPTER_ID,
            ERC4626_ADAPTER_ID,
            ERC4626_NR_ADAPTER_ID,
            ERC4626_NDNR_ID
        ];
        for (uint256 i = 0; i < 7; i++) {
            (address a, uint256 sa, address b, uint256 sb) = factory.creationCodes(ids[i]);
            assertTrue(a != address(0) && b != address(0) && sa > 0 && sb > 0, "id not registered");
        }
    }

    // 2. ERC20WithAdapter: minimal params (rewardManager=0, adapter=0)
    function test_erc20Adapter_minimalParams_depositRedeem() public {
        MockERC20 tok = new MockERC20("Token", "TOK");
        address sy = factory.deployUpgradableSY(ERC20_ADAPTER_ID, abi.encode(address(tok), address(0)), _initData3(address(0)), alice);

        assertEq(ISY(sy).name(), "SY Test");
        assertEq(ISY(sy).symbol(), "SY-TEST");
        assertEq(ISY(sy).owner(), alice);
        assertEq(ISY(sy).adapter(), address(0));
        assertEq(ISY(sy).offchainRewardManager(), address(0));
        assertEq(ISY(sy).yieldToken(), address(tok));
        address[] memory tin = ISY(sy).getTokensIn();
        assertEq(tin.length, 1);
        assertEq(tin[0], address(tok));

        // proxy admin
        address admin = address(uint160(uint256(vm.load(sy, ADMIN_SLOT))));
        emit log_named_address("SY proxy admin", admin);
        assertTrue(admin != address(0));

        // deposit / redeem 1:1
        tok.mint(address(this), 100e18);
        tok.approve(sy, type(uint256).max);
        uint256 shares = ISY(sy).deposit(address(this), address(tok), 100e18, 0);
        assertEq(shares, 100e18);
        uint256 out = ISY(sy).redeem(address(this), 100e18, address(tok), 0, false);
        assertEq(out, 100e18);
    }

    // 3. ERC4626WithAdapter + NoRedeemWithAdapter: minimal params
    function test_erc4626Adapters_minimalParams() public {
        MockERC20 asset = new MockERC20("Asset", "AST");
        MockERC4626 vault = new MockERC4626(address(asset));

        address sy = factory.deployUpgradableSY(ERC4626_ADAPTER_ID, abi.encode(address(vault), address(0)), _initData3(address(0)), alice);
        assertEq(ISY(sy).owner(), alice);
        assertEq(ISY(sy).yieldToken(), address(vault));

        // deposit asset -> vault shares; redeem back to asset
        asset.mint(address(this), 50e18);
        asset.approve(sy, type(uint256).max);
        uint256 shares = ISY(sy).deposit(address(this), address(asset), 50e18, 0);
        assertEq(shares, 50e18);
        uint256 out = ISY(sy).redeem(address(this), 25e18, address(asset), 0, false);
        assertEq(out, 25e18);

        address sy2 = factory.deployUpgradableSY(ERC4626_NR_ADAPTER_ID, abi.encode(address(vault), address(0)), _initData3(address(0)), alice);
        address[] memory tout = ISY(sy2).getTokensOut();
        assertEq(tout.length, 1);
        assertEq(tout[0], address(vault)); // no redeem to asset
    }

    // 4. NoRedeemNoDeposit: 2-arg initialize
    function test_noDepositNoRedeem_initSig() public {
        MockERC20 asset = new MockERC20("Asset", "AST");
        MockERC4626 vault = new MockERC4626(address(asset));

        // 3-arg initialize must fail
        vm.expectRevert();
        factory.deployUpgradableSY(ERC4626_NDNR_ID, abi.encode(address(vault), address(0)), _initData3(address(0)), alice);

        bytes memory init2 = abi.encodeWithSignature("initialize(string,string)", "SY NDNR", "SY-NDNR");
        address sy = factory.deployUpgradableSY(ERC4626_NDNR_ID, abi.encode(address(vault), address(0)), init2, alice);
        assertEq(ISY(sy).owner(), alice);
        address[] memory tin = ISY(sy).getTokensIn();
        assertEq(tin.length, 1);
        assertEq(tin[0], address(vault));
    }

    // 5. deploySY (non-upgradeable path) is the wrong entrypoint for adapter ids
    function test_deploySY_wrongEntrypointForAdapterId_reverts() public {
        MockERC20 tok = new MockERC20("Token", "TOK");
        vm.expectRevert();
        factory.deploySY(ERC20_ADAPTER_ID, abi.encode(address(tok), address(0)), alice);
    }

    // 6. deployUpgradableSY with empty initData leaves proxy uninitialized -> ownership transfer fails
    function test_deployUpgradableSY_emptyInitData_reverts() public {
        MockERC20 tok = new MockERC20("Token", "TOK");
        vm.expectRevert();
        factory.deployUpgradableSY(ERC20_ADAPTER_ID, abi.encode(address(tok), address(0)), "", alice);
    }

    // 7. adapter with wrong pivot rejected at initialize
    function test_wrongPivotAdapter_reverts() public {
        MockERC20 tok = new MockERC20("Token", "TOK");
        MockERC20 other = new MockERC20("Other", "OTH");
        MockAdapter bad = new MockAdapter(address(other), address(tok)); // pivot != yieldToken
        vm.expectRevert();
        factory.deployUpgradableSY(ERC20_ADAPTER_ID, abi.encode(address(tok), address(0)), _initData3(address(bad)), alice);
    }

    // 8. full helper flow: deployERC20WithAdapterMarket end-to-end with seeding
    function test_helper_erc20AdapterMarket_endToEnd() public {
        MockERC20 tok = new MockERC20("Token", "TOK");
        tok.mint(address(this), 1000e18);
        tok.approve(address(helper), type(uint256).max);

        PoolDeploymentAddrs memory a = helper.deployERC20WithAdapterMarket(
            abi.encode(address(tok), address(0)), _initData3(address(0)), _cfg(), address(tok), 1000e18, alice
        );
        assertTrue(a.SY != address(0) && a.PT != address(0) && a.YT != address(0) && a.market != address(0));
        assertGt(IERC20Min(a.market).balanceOf(address(this)), 0, "no LP");
        assertGt(IERC20Min(a.YT).balanceOf(address(this)), 0, "no YT");
        assertEq(ISY(a.SY).owner(), alice);
    }

    // 9. full helper flow: ERC4626 adapter market
    function test_helper_erc4626AdapterMarket_endToEnd() public {
        MockERC20 asset = new MockERC20("Asset", "AST");
        MockERC4626 vault = new MockERC4626(address(asset));
        asset.mint(address(this), 1000e18);
        asset.approve(address(helper), type(uint256).max);

        PoolDeploymentAddrs memory a = helper.deployERC4626WithAdapterMarket(
            abi.encode(address(vault), address(0)), _initData3(address(0)), _cfg(), address(asset), 1000e18, alice
        );
        assertTrue(a.market != address(0));
        assertGt(IERC20Min(a.market).balanceOf(address(this)), 0, "no LP");
    }

    // 10. deployCommonMarketById with the id that has no dedicated wrapper
    function test_helper_deployCommonMarketById_NDNR() public {
        MockERC20 asset = new MockERC20("Asset", "AST");
        MockERC4626 vault = new MockERC4626(address(asset));
        asset.mint(address(this), 1000e18);
        asset.approve(address(vault), type(uint256).max);
        MockERC4626(vault).deposit(1000e18, address(this));
        vault.approve(address(helper), type(uint256).max);

        bytes memory init2 = abi.encodeWithSignature("initialize(string,string)", "SY NDNR", "SY-NDNR");
        PoolDeploymentAddrs memory a = helper.deployCommonMarketById(
            ERC4626_NDNR_ID, abi.encode(address(vault), address(0)), init2, _cfg(), address(vault), 1000e18, alice
        );
        assertTrue(a.market != address(0));
        assertGt(IERC20Min(a.market).balanceOf(address(this)), 0, "no LP");
    }

    // 11. real adapter flow: deposit/redeem via adapter token
    function test_adapterFlow_altToken() public {
        MockERC20 pivot = new MockERC20("Pivot", "PVT");
        MockERC20 alt = new MockERC20("Alt", "ALT");
        MockAdapter adapter = new MockAdapter(address(pivot), address(alt));

        address sy = factory.deployUpgradableSY(
            ERC20_ADAPTER_ID, abi.encode(address(pivot), address(0)), _initData3(address(adapter)), alice
        );
        address[] memory tin = ISY(sy).getTokensIn();
        assertEq(tin.length, 3); // alt, NATIVE, pivot
        assertTrue(ISY(sy).isValidTokenIn(address(0)), "native not accepted");

        alt.mint(address(this), 10e18);
        alt.approve(sy, type(uint256).max);
        uint256 shares = ISY(sy).deposit(address(this), address(alt), 10e18, 0);
        assertEq(shares, 10e18);
        uint256 out = ISY(sy).redeem(address(this), 10e18, address(alt), 0, false);
        assertEq(out, 10e18);
    }

    // 12. native ETH: direct SY deposit via adapter + payable seeding via deploy5115MarketAndSeedLiquidity
    function test_native_viaAdapter_andPayableSeeding() public {
        MockWETHAdapter adapter = new MockWETHAdapter(WETH);
        address sy = factory.deployUpgradableSY(
            ERC20_ADAPTER_ID, abi.encode(WETH, address(0)), _initData3(address(adapter)), alice
        );
        assertTrue(ISY(sy).isValidTokenIn(address(0)), "native not in tokensIn");

        vm.deal(address(this), 10 ether);
        uint256 shares = ISY(sy).deposit{value: 1 ether}(address(this), address(0), 1 ether, 0);
        assertEq(shares, 1 ether);

        PoolDeploymentAddrs memory a =
            helper.deploy5115MarketAndSeedLiquidity{value: 5 ether}(sy, _cfg(), address(0), 5 ether);
        assertTrue(a.market != address(0));
        assertGt(IERC20Min(a.market).balanceOf(address(this)), 0, "no LP");
    }

    // 13. FOT: basic ERC20 SY silently under-collateralizes
    function test_fot_basicERC20SY_undercollateralized() public {
        MockFOT fot = new MockFOT();
        address sy = factory.deploySY(ERC20_ID, abi.encode("SY FOT", "SY-FOT", address(fot)), alice);

        fot.mint(address(this), 100e18);
        fot.approve(sy, type(uint256).max);
        uint256 shares = ISY(sy).deposit(address(this), address(fot), 100e18, 0);
        assertEq(shares, 100e18, "credited nominal");
        assertLt(fot.balanceOf(sy), ISY(sy).totalSupply(), "SY should be under-collateralized");

        // full redemption of all shares fails: SY only holds 99e18
        vm.expectRevert();
        ISY(sy).redeem(address(this), 100e18, address(fot), 0, false);
    }

    // 14. FOT: adapter ERC20 SY reverts deposits outright
    function test_fot_adapterERC20SY_depositReverts() public {
        MockFOT fot = new MockFOT();
        address sy = factory.deployUpgradableSY(ERC20_ADAPTER_ID, abi.encode(address(fot), address(0)), _initData3(address(0)), alice);

        fot.mint(address(this), 100e18);
        fot.approve(sy, type(uint256).max);
        vm.expectRevert(bytes("SY: insufficient shares"));
        ISY(sy).deposit(address(this), address(fot), 100e18, 0);
    }

    // 15. FOT: helper seeding path reverts
    function test_fot_helperSeeding_reverts() public {
        MockFOT fot = new MockFOT();
        fot.mint(address(this), 1000e18);
        fot.approve(address(helper), type(uint256).max);
        vm.expectRevert();
        helper.deployERC20Market(abi.encode("SY FOT", "SY-FOT", address(fot)), _cfg(), address(fot), 1000e18, alice);
    }

    // 16. rebasing: negative rebase breaks redemption
    function test_rebasing_negativeRebase_breaks() public {
        MockERC20 reb = new MockERC20("Rebase", "RB");
        address sy = factory.deploySY(ERC20_ID, abi.encode("SY RB", "SY-RB", address(reb)), alice);

        reb.mint(address(this), 100e18);
        reb.approve(sy, type(uint256).max);
        ISY(sy).deposit(address(this), address(reb), 100e18, 0);

        // simulate -5% rebase on SY's balance
        vm.store(
            address(reb),
            keccak256(abi.encode(sy, uint256(4))), // balanceOf mapping at slot 4
            bytes32(uint256(95e18))
        );
        assertEq(reb.balanceOf(sy), 95e18, "rebase sim failed");

        vm.expectRevert();
        ISY(sy).redeem(address(this), 100e18, address(reb), 0, false);
    }

    receive() external payable {}
}
