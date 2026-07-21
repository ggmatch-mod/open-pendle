// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

/// @notice Morpho Blue's immutable market tuple.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @notice A single Bundler3 call.
struct Call {
    address to;
    bytes data;
    uint256 value;
    bool skipRevert;
    bytes32 callbackHash;
}

/// @notice Morpho's EIP-712 manager authorization payload.
struct Authorization {
    address authorizer;
    address authorized;
    bool isAuthorized;
    uint256 nonce;
    uint256 deadline;
}

struct Signature {
    uint8 v;
    bytes32 r;
    bytes32 s;
}

interface IERC20Looping {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IBundler3Looping {
    function multicall(Call[] calldata bundle) external payable;
    function initiator() external view returns (address);
}

interface IMorphoLooping {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonce(address authorizer) external view returns (uint256);
    function setAuthorization(address authorized, bool newIsAuthorized) external;
    function setAuthorizationWithSig(Authorization calldata authorization, Signature calldata signature) external;
    function isAuthorized(address authorizer, address authorized) external view returns (bool);
    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
}

interface IGeneralAdapter1Looping {
    function erc20TransferFrom(address token, address receiver, uint256 amount) external;
    function erc20Transfer(address token, address receiver, uint256 amount) external;

    function morphoSupplyCollateral(
        MarketParams calldata marketParams,
        uint256 assets,
        address onBehalf,
        bytes calldata data
    ) external;

    function morphoBorrow(
        MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        uint256 minSharePriceE27,
        address receiver
    ) external;

    function morphoRepay(
        MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        uint256 maxSharePriceE27,
        address onBehalf,
        bytes calldata data
    ) external;

    function morphoWithdrawCollateral(MarketParams calldata marketParams, uint256 assets, address receiver) external;
}

/**
 * @notice Live fork proof for a Pendle PT / Morpho USDC loop.
 *
 * The runner obtains fresh Pendle Hosted SDK calldata, pins the immediately
 * following chain block, and injects the three opaque Router calls through
 * environment variables. No private key or funded wallet is used.
 *
 * The proof deliberately uses the already-deployed Morpho Bundler3 and
 * GeneralAdapter1. The user's initial USDC purchase is followed by a Morpho
 * supply-collateral callback that borrows more USDC and buys more PT before
 * Morpho pulls the promised collateral. The unwind mirrors that construction
 * through Morpho's repay callback.
 */
contract LoopingForkTest is Test {
    uint256 internal constant USER_PRIVATE_KEY = 0xA11CE;
    bytes32 internal constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
    );

    address internal user;

    address internal constant DEFAULT_MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant DEFAULT_BUNDLER3 = 0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245;
    address internal constant DEFAULT_ADAPTER = 0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0;
    address internal constant DEFAULT_PENDLE_ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;

    address internal constant DEFAULT_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant DEFAULT_PT = 0xeCfaFdC7741323a945A163ed068B5a3C43483957;
    address internal constant DEFAULT_ORACLE = 0x217d6DdCDB95112C51657F6270e8C079CFDB51f0;
    address internal constant DEFAULT_IRM = 0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC;

    bytes32 internal constant DEFAULT_MARKET_ID = 0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64;
    uint256 internal constant DEFAULT_LLTV = 915_000_000_000_000_000;

    uint256 internal constant MAX_UINT = type(uint256).max;
    uint256 internal constant RAY = 1e27;

    bytes4 internal constant SWAP_EXACT_TOKEN_FOR_PT = 0xc81f847a;
    bytes4 internal constant SWAP_EXACT_PT_FOR_TOKEN = 0x594a88cc;

    address internal MORPHO;
    address internal BUNDLER3;
    address internal ADAPTER;
    address internal PENDLE_ROUTER;
    address internal USDC;
    address internal PT;
    address internal ORACLE;
    address internal IRM;
    bytes32 internal MARKET_ID;
    uint256 internal LLTV;
    MarketParams internal marketParams;

    function setUp() external {
        user = vm.addr(USER_PRIVATE_KEY);
        MORPHO = vm.envOr("OPENPENDLE_MORPHO", DEFAULT_MORPHO);
        BUNDLER3 = vm.envOr("OPENPENDLE_BUNDLER3", DEFAULT_BUNDLER3);
        ADAPTER = vm.envOr("OPENPENDLE_ADAPTER", DEFAULT_ADAPTER);
        PENDLE_ROUTER = vm.envOr("OPENPENDLE_PENDLE_ROUTER", DEFAULT_PENDLE_ROUTER);
        USDC = vm.envOr("OPENPENDLE_LOAN_TOKEN", DEFAULT_USDC);
        PT = vm.envOr("OPENPENDLE_COLLATERAL_TOKEN", DEFAULT_PT);
        ORACLE = vm.envOr("OPENPENDLE_ORACLE", DEFAULT_ORACLE);
        IRM = vm.envOr("OPENPENDLE_IRM", DEFAULT_IRM);
        MARKET_ID = vm.envOr("OPENPENDLE_MARKET_ID", DEFAULT_MARKET_ID);
        LLTV = vm.envOr("OPENPENDLE_LLTV", DEFAULT_LLTV);
        marketParams = MarketParams({loanToken: USDC, collateralToken: PT, oracle: ORACLE, irm: IRM, lltv: LLTV});
    }

    function test_atomicEntryOnly() external {
        _requireLiveFixture();

        Fixture memory fixture = _fixture();
        _assertFixture(fixture);
        _prepareUser(fixture);

        uint256 collateral = fixture.initialMinPt + fixture.loopMinPt;
        vm.prank(user);
        IBundler3Looping(BUNDLER3).multicall(_entryBundle(fixture, fixture.loopBorrowUsdc));

        (, uint128 borrowShares, uint128 recordedCollateral) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertGt(borrowShares, 0, "entry: user has no Morpho debt");
        _assertDebtBounded(fixture, borrowShares);
        assertEq(uint256(recordedCollateral), collateral, "entry: wrong user collateral");
        _assertNoProtocolPosition(BUNDLER3, "entry: Bundler owns position");
        _assertNoProtocolPosition(ADAPTER, "entry: adapter owns position");
        _assertTransientBalancesCleared("entry");
    }

    function test_atomicEntryAndFullUnwind() external {
        _requireLiveFixture();

        Fixture memory fixture = _fixture();
        _assertFixture(fixture);
        _prepareUser(fixture);

        uint256 collateral = fixture.initialMinPt + fixture.loopMinPt;

        vm.prank(user);
        IBundler3Looping(BUNDLER3).multicall(_entryBundle(fixture, fixture.loopBorrowUsdc));

        (, uint128 borrowShares, uint128 recordedCollateral) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertGt(borrowShares, 0, "entry: user has no Morpho debt");
        _assertDebtBounded(fixture, borrowShares);
        assertEq(uint256(recordedCollateral), collateral, "entry: wrong user collateral");
        _assertNoProtocolPosition(BUNDLER3, "entry: Bundler owns position");
        _assertNoProtocolPosition(ADAPTER, "entry: adapter owns position");
        _assertTransientBalancesCleared("entry");

        uint256 userUsdcBeforeExit = IERC20Looping(USDC).balanceOf(user);

        vm.prank(user);
        IBundler3Looping(BUNDLER3).multicall(_exitBundle(fixture, collateral));

        (, borrowShares, recordedCollateral) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertEq(borrowShares, 0, "exit: debt remains");
        assertEq(recordedCollateral, 0, "exit: collateral remains");
        assertGt(IERC20Looping(USDC).balanceOf(user), userUsdcBeforeExit, "exit: no USDC returned");
        _assertNoProtocolPosition(BUNDLER3, "exit: Bundler owns position");
        _assertNoProtocolPosition(ADAPTER, "exit: adapter owns position");
        _assertTransientBalancesCleared("exit");
        assertEq(IBundler3Looping(BUNDLER3).initiator(), address(0), "exit: initiator not cleared");
    }

    function test_signedMorphoAuthorizationAndRevocation() external {
        _requireLiveFixture();

        Fixture memory fixture = _fixture();
        _assertFixture(fixture);
        _prepareUserFundsOnly(fixture);

        uint256 startingNonce = IMorphoLooping(MORPHO).nonce(user);
        uint256 collateral = fixture.initialMinPt + fixture.loopMinPt;

        Call[] memory entry = _prepend(_signedAuthorizationCall(true), _entryBundle(fixture, fixture.loopBorrowUsdc));
        vm.prank(user);
        IBundler3Looping(BUNDLER3).multicall(entry);

        assertTrue(IMorphoLooping(MORPHO).isAuthorized(user, ADAPTER), "signature: authorization missing");
        (, uint128 borrowShares, uint128 recordedCollateral) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertGt(borrowShares, 0, "signature: entry debt missing");
        _assertDebtBounded(fixture, borrowShares);
        assertEq(uint256(recordedCollateral), collateral, "signature: wrong collateral");

        Call[] memory exit = _append(_exitBundle(fixture, collateral), _signedAuthorizationCall(false));
        vm.prank(user);
        IBundler3Looping(BUNDLER3).multicall(exit);

        (, borrowShares, recordedCollateral) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertEq(borrowShares, 0, "signature: exit debt remains");
        assertEq(recordedCollateral, 0, "signature: exit collateral remains");
        assertFalse(IMorphoLooping(MORPHO).isAuthorized(user, ADAPTER), "signature: authorization not revoked");
        assertEq(IMorphoLooping(MORPHO).nonce(user), startingNonce + 2, "signature: wrong nonce");
        _assertTransientBalancesCleared("signature exit");
    }

    function test_fullUnwindAfterInterestAccrues() external {
        _requireLiveFixture();

        Fixture memory fixture = _fixture();
        _assertFixture(fixture);
        _prepareUser(fixture);

        uint256 collateral = fixture.initialMinPt + fixture.loopMinPt;
        vm.prank(user);
        IBundler3Looping(BUNDLER3).multicall(_entryBundle(fixture, fixture.loopBorrowUsdc));

        (, uint128 borrowSharesBefore,) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertGt(borrowSharesBefore, 0, "interest: entry debt missing");
        _assertDebtBounded(fixture, borrowSharesBefore);

        // Morpho accrues the elapsed interest when the repay begins. Five
        // minutes is long enough to exercise debt-share rounding while staying
        // inside the lifetime of a freshly generated aggregator route.
        vm.warp(block.timestamp + 5 minutes);
        vm.roll(block.number + 25);

        vm.prank(user);
        IBundler3Looping(BUNDLER3).multicall(_exitBundle(fixture, collateral));

        (, uint128 borrowSharesAfter, uint128 collateralAfter) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertEq(borrowSharesAfter, 0, "interest: debt remains");
        assertEq(collateralAfter, 0, "interest: collateral remains");
        _assertTransientBalancesCleared("interest exit");
    }

    /// @notice Safest live-proof shape: one user transaction either opens and
    /// closes the loop completely or reverts every intermediate state change.
    function test_singleMulticallSignedRoundTrip() external {
        _requireLiveFixture();

        Fixture memory fixture = _fixture();
        _assertFixture(fixture);
        _prepareUserFundsOnly(fixture);

        uint256 startingNonce = IMorphoLooping(MORPHO).nonce(user);
        uint256 minimumRefund = fixture.exitMinUsdc - fixture.repaymentCapUsdc;
        Call[] memory roundTrip =
            _singleRoundTripBundle(fixture, fixture.initialMinPt + fixture.loopMinPt, startingNonce);

        vm.prank(user);
        IBundler3Looping(BUNDLER3).multicall(roundTrip);

        (, uint128 borrowShares, uint128 collateral) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertEq(borrowShares, 0, "single: debt remains");
        assertEq(collateral, 0, "single: collateral remains");
        assertFalse(IMorphoLooping(MORPHO).isAuthorized(user, ADAPTER), "single: authorization remains");
        assertEq(IMorphoLooping(MORPHO).nonce(user), startingNonce + 2, "single: wrong authorization nonce");
        assertGe(IERC20Looping(USDC).balanceOf(user), minimumRefund, "single: guaranteed refund missing");
        assertEq(IERC20Looping(USDC).allowance(user, ADAPTER), 0, "single: user allowance remains");
        _assertNoProtocolPosition(BUNDLER3, "single: Bundler owns position");
        _assertNoProtocolPosition(ADAPTER, "single: adapter owns position");
        _assertTransientBalancesCleared("single");
        assertEq(IBundler3Looping(BUNDLER3).initiator(), address(0), "single: initiator not cleared");
    }

    /// @notice If the exit half cannot pull the exact promised PT, the entry,
    /// both authorization nonces, and every transient balance roll back too.
    function test_singleMulticallBadExitRollsBackEntry() external {
        _requireLiveFixture();

        Fixture memory fixture = _fixture();
        _assertFixture(fixture);
        _prepareUserFundsOnly(fixture);

        uint256 collateral = fixture.initialMinPt + fixture.loopMinPt;
        uint256 startingNonce = IMorphoLooping(MORPHO).nonce(user);
        uint256 userUsdcBefore = IERC20Looping(USDC).balanceOf(user);
        uint256 userAllowanceBefore = IERC20Looping(USDC).allowance(user, ADAPTER);
        uint256 bundlerUsdcAllowanceBefore = IERC20Looping(USDC).allowance(BUNDLER3, PENDLE_ROUTER);
        uint256 bundlerPtAllowanceBefore = IERC20Looping(PT).allowance(BUNDLER3, PENDLE_ROUTER);
        Call[] memory roundTrip = _singleRoundTripBundle(fixture, collateral - 1, startingNonce);

        vm.startPrank(user);
        vm.expectRevert();
        IBundler3Looping(BUNDLER3).multicall(roundTrip);
        vm.stopPrank();

        (, uint128 borrowShares, uint128 recordedCollateral) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertEq(borrowShares, 0, "bad exit: debt persisted");
        assertEq(recordedCollateral, 0, "bad exit: collateral persisted");
        assertFalse(IMorphoLooping(MORPHO).isAuthorized(user, ADAPTER), "bad exit: authorization persisted");
        assertEq(IMorphoLooping(MORPHO).nonce(user), startingNonce, "bad exit: authorization nonce changed");
        assertEq(IERC20Looping(USDC).balanceOf(user), userUsdcBefore, "bad exit: user USDC changed");
        assertEq(IERC20Looping(USDC).allowance(user, ADAPTER), userAllowanceBefore, "bad exit: user allowance changed");
        _assertNoProtocolPosition(BUNDLER3, "bad exit: Bundler owns position");
        _assertNoProtocolPosition(ADAPTER, "bad exit: adapter owns position");
        _assertTransientBalancesCleared(
            "bad exit", bundlerUsdcAllowanceBefore, bundlerPtAllowanceBefore
        );
        assertEq(IBundler3Looping(BUNDLER3).initiator(), address(0), "bad exit: initiator not cleared");
    }

    function test_callbackFailureRollsBackEverything() external {
        _requireLiveFixture();

        Fixture memory fixture = _fixture();
        _assertFixture(fixture);
        _prepareUser(fixture);

        uint256 userUsdcBefore = IERC20Looping(USDC).balanceOf(user);
        uint256 bundlerUsdcAllowanceBefore = IERC20Looping(USDC).allowance(BUNDLER3, PENDLE_ROUTER);
        uint256 bundlerPtAllowanceBefore = IERC20Looping(PT).allowance(BUNDLER3, PENDLE_ROUTER);

        // One wei less than the Router needs. The initial PT purchase succeeds,
        // then the callback purchase fails. Bundler3 must roll the whole entry
        // back, including the initial transfer and swap.
        vm.startPrank(user);
        vm.expectRevert();
        IBundler3Looping(BUNDLER3).multicall(_entryBundle(fixture, fixture.loopBorrowUsdc - 1));
        vm.stopPrank();

        (, uint128 borrowShares, uint128 collateral) = IMorphoLooping(MORPHO).position(MARKET_ID, user);
        assertEq(borrowShares, 0, "rollback: debt persisted");
        assertEq(collateral, 0, "rollback: collateral persisted");
        assertEq(IERC20Looping(USDC).balanceOf(user), userUsdcBefore, "rollback: user USDC changed");
        assertEq(IERC20Looping(USDC).balanceOf(BUNDLER3), 0, "rollback: Bundler USDC");
        assertEq(IERC20Looping(PT).balanceOf(BUNDLER3), 0, "rollback: Bundler PT");
        assertEq(IERC20Looping(USDC).balanceOf(ADAPTER), 0, "rollback: adapter USDC");
        assertEq(IERC20Looping(PT).balanceOf(ADAPTER), 0, "rollback: adapter PT");
        assertEq(
            IERC20Looping(USDC).allowance(BUNDLER3, PENDLE_ROUTER),
            bundlerUsdcAllowanceBefore,
            "rollback: Bundler USDC allowance changed"
        );
        assertEq(
            IERC20Looping(PT).allowance(BUNDLER3, PENDLE_ROUTER),
            bundlerPtAllowanceBefore,
            "rollback: Bundler PT allowance changed"
        );
        assertEq(IBundler3Looping(BUNDLER3).initiator(), address(0), "rollback: initiator not cleared");
    }

    struct Fixture {
        bytes initialBuy;
        bytes loopBuy;
        bytes fullExit;
        uint256 initialMinPt;
        uint256 loopMinPt;
        uint256 exitMinUsdc;
        uint256 initialUsdc;
        uint256 loopBorrowUsdc;
        uint256 minBorrowSharePriceE27;
        uint256 maxRepaySharePriceE27;
        uint256 maxBorrowShares;
        uint256 repaymentCapUsdc;
    }

    function _requireLiveFixture() internal view {
        require(
            vm.envOr("OPENPENDLE_LOOPING_FORK", false),
            "looping fixture missing: use scripts/run-looping-fork.mjs"
        );
    }

    function _fixture() internal view returns (Fixture memory fixture) {
        fixture.initialBuy = vm.envBytes("OPENPENDLE_INITIAL_BUY_CALLDATA");
        fixture.loopBuy = vm.envBytes("OPENPENDLE_LOOP_BUY_CALLDATA");
        fixture.fullExit = vm.envBytes("OPENPENDLE_FULL_EXIT_CALLDATA");
        fixture.initialMinPt = vm.envUint("OPENPENDLE_INITIAL_MIN_PT");
        fixture.loopMinPt = vm.envUint("OPENPENDLE_LOOP_MIN_PT");
        fixture.exitMinUsdc = vm.envUint("OPENPENDLE_EXIT_MIN_USDC");
        fixture.initialUsdc = vm.envUint("OPENPENDLE_INITIAL_USDC");
        fixture.loopBorrowUsdc = vm.envUint("OPENPENDLE_LOOP_BORROW_USDC");
        fixture.minBorrowSharePriceE27 = vm.envUint("OPENPENDLE_MIN_BORROW_SHARE_PRICE_E27");
        fixture.maxRepaySharePriceE27 = vm.envUint("OPENPENDLE_MAX_REPAY_SHARE_PRICE_E27");
        fixture.maxBorrowShares = vm.envUint("OPENPENDLE_MAX_BORROW_SHARES");
        fixture.repaymentCapUsdc = vm.envUint("OPENPENDLE_REPAYMENT_CAP_USDC");
    }

    function _assertFixture(Fixture memory fixture) internal view {
        assertEq(keccak256(abi.encode(marketParams)), MARKET_ID, "fixture: Morpho tuple changed");
        assertEq(_selector(fixture.initialBuy), SWAP_EXACT_TOKEN_FOR_PT, "fixture: initial selector");
        assertEq(_selector(fixture.loopBuy), SWAP_EXACT_TOKEN_FOR_PT, "fixture: loop selector");
        assertEq(_selector(fixture.fullExit), SWAP_EXACT_PT_FOR_TOKEN, "fixture: exit selector");
        assertGt(fixture.initialMinPt, 0, "fixture: initial min PT is zero");
        assertGt(fixture.loopMinPt, 0, "fixture: loop min PT is zero");
        assertGt(fixture.initialUsdc, 0, "fixture: initial USDC is zero");
        assertGt(fixture.loopBorrowUsdc, 1, "fixture: loop borrow is too small");
        assertGt(fixture.minBorrowSharePriceE27, 0, "fixture: borrow share bound is zero");
        assertGt(fixture.maxRepaySharePriceE27, 0, "fixture: repay share bound is zero");
        assertLt(fixture.maxRepaySharePriceE27, MAX_UINT, "fixture: repay share bound is unlimited");
        assertGt(fixture.maxBorrowShares, 0, "fixture: debt-share cap is zero");
        assertEq(
            fixture.minBorrowSharePriceE27,
            fixture.loopBorrowUsdc * RAY / (fixture.maxBorrowShares + 1) + 1,
            "fixture: borrow share cap is not exact"
        );
        assertEq(
            fixture.maxRepaySharePriceE27,
            ((fixture.repaymentCapUsdc + 1) * RAY - 1) / fixture.maxBorrowShares,
            "fixture: repay coverage cap is not exact"
        );
        assertEq(
            fixture.repaymentCapUsdc,
            (fixture.loopBorrowUsdc * 101 + 99) / 100 + 2,
            "fixture: repayment cap is not 1% plus two units"
        );
        assertGe(fixture.exitMinUsdc, fixture.repaymentCapUsdc, "fixture: exit cannot cover bounded debt");
        assertGt(MORPHO.code.length, 0, "fixture: Morpho missing");
        assertGt(BUNDLER3.code.length, 0, "fixture: Bundler missing");
        assertGt(ADAPTER.code.length, 0, "fixture: adapter missing");
        assertGt(PENDLE_ROUTER.code.length, 0, "fixture: Router missing");
    }

    function _prepareUser(Fixture memory fixture) internal {
        _prepareUserFundsOnly(fixture);
        vm.prank(user);
        IMorphoLooping(MORPHO).setAuthorization(ADAPTER, true);

        assertTrue(IMorphoLooping(MORPHO).isAuthorized(user, ADAPTER), "setup: adapter not authorized");
    }

    function _prepareUserFundsOnly(Fixture memory fixture) internal {
        deal(USDC, user, fixture.initialUsdc);
        vm.startPrank(user);
        IERC20Looping(USDC).approve(ADAPTER, fixture.initialUsdc);
        vm.stopPrank();
    }

    function _signedAuthorizationCall(bool isAuthorized) internal view returns (Call memory) {
        return _signedAuthorizationCall(isAuthorized, IMorphoLooping(MORPHO).nonce(user));
    }

    function _signedAuthorizationCall(bool isAuthorized, uint256 authorizationNonce)
        internal
        view
        returns (Call memory)
    {
        Authorization memory authorization = Authorization({
            authorizer: user,
            authorized: ADAPTER,
            isAuthorized: isAuthorized,
            nonce: authorizationNonce,
            deadline: block.timestamp + 1 hours
        });
        bytes32 structHash = keccak256(abi.encode(AUTHORIZATION_TYPEHASH, authorization));
        bytes32 digest = keccak256(bytes.concat("\x19\x01", IMorphoLooping(MORPHO).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PRIVATE_KEY, digest);
        Signature memory signature = Signature({v: v, r: r, s: s});

        return _call(MORPHO, abi.encodeCall(IMorphoLooping.setAuthorizationWithSig, (authorization, signature)));
    }

    function _prepend(Call memory first, Call[] memory rest) internal pure returns (Call[] memory calls) {
        calls = new Call[](rest.length + 1);
        calls[0] = first;
        for (uint256 i; i < rest.length; ++i) {
            calls[i + 1] = rest[i];
        }
    }

    function _append(Call[] memory first, Call memory last) internal pure returns (Call[] memory calls) {
        calls = new Call[](first.length + 1);
        for (uint256 i; i < first.length; ++i) {
            calls[i] = first[i];
        }
        calls[first.length] = last;
    }

    function _concat(Call[] memory first, Call[] memory second) internal pure returns (Call[] memory calls) {
        calls = new Call[](first.length + second.length);
        for (uint256 i; i < first.length; ++i) {
            calls[i] = first[i];
        }
        for (uint256 i; i < second.length; ++i) {
            calls[first.length + i] = second[i];
        }
    }

    function _singleRoundTripBundle(Fixture memory fixture, uint256 exitRouterAllowance, uint256 startingNonce)
        internal
        view
        returns (Call[] memory bundle)
    {
        uint256 collateral = fixture.initialMinPt + fixture.loopMinPt;
        Call[] memory body = _concat(
            _entryBundle(fixture, fixture.loopBorrowUsdc), _exitBundle(fixture, collateral, exitRouterAllowance)
        );
        bundle = _prepend(_signedAuthorizationCall(true, startingNonce), body);
        bundle = _append(bundle, _signedAuthorizationCall(false, startingNonce + 1));
    }

    function _entryBundle(Fixture memory fixture, uint256 loopRouterAllowance)
        internal
        view
        returns (Call[] memory bundle)
    {
        Call[] memory callback = new Call[](4);
        callback[0] = _call(
            ADAPTER,
            abi.encodeCall(
                IGeneralAdapter1Looping.morphoBorrow,
                (marketParams, fixture.loopBorrowUsdc, 0, fixture.minBorrowSharePriceE27, BUNDLER3)
            )
        );
        callback[1] = _call(USDC, abi.encodeCall(IERC20Looping.approve, (PENDLE_ROUTER, loopRouterAllowance)));
        callback[2] = _call(PENDLE_ROUTER, fixture.loopBuy);
        callback[3] = _call(USDC, abi.encodeCall(IERC20Looping.approve, (PENDLE_ROUTER, 0)));

        bytes memory callbackData = abi.encode(callback);
        uint256 collateral = fixture.initialMinPt + fixture.loopMinPt;

        bundle = new Call[](8);
        bundle[0] = _call(
            ADAPTER, abi.encodeCall(IGeneralAdapter1Looping.erc20TransferFrom, (USDC, BUNDLER3, fixture.initialUsdc))
        );
        bundle[1] = _call(USDC, abi.encodeCall(IERC20Looping.approve, (PENDLE_ROUTER, fixture.initialUsdc)));
        bundle[2] = _call(PENDLE_ROUTER, fixture.initialBuy);
        bundle[3] = _call(USDC, abi.encodeCall(IERC20Looping.approve, (PENDLE_ROUTER, 0)));
        bundle[4] = Call({
            to: ADAPTER,
            data: abi.encodeCall(
                IGeneralAdapter1Looping.morphoSupplyCollateral, (marketParams, collateral, user, callbackData)
            ),
            value: 0,
            skipRevert: false,
            callbackHash: keccak256(callbackData)
        });
        bundle[5] = _call(ADAPTER, abi.encodeCall(IGeneralAdapter1Looping.erc20Transfer, (PT, user, MAX_UINT)));
        bundle[6] = _call(ADAPTER, abi.encodeCall(IGeneralAdapter1Looping.erc20Transfer, (USDC, user, MAX_UINT)));
        bundle[7] = _call(PT, abi.encodeCall(IERC20Looping.approve, (PENDLE_ROUTER, 0)));
    }

    function _exitBundle(Fixture memory fixture, uint256 collateral) internal view returns (Call[] memory bundle) {
        return _exitBundle(fixture, collateral, collateral);
    }

    function _exitBundle(Fixture memory fixture, uint256 collateral, uint256 routerAllowance)
        internal
        view
        returns (Call[] memory bundle)
    {
        Call[] memory callback = new Call[](4);
        callback[0] = _call(
            ADAPTER,
            abi.encodeCall(IGeneralAdapter1Looping.morphoWithdrawCollateral, (marketParams, collateral, BUNDLER3))
        );
        callback[1] = _call(PT, abi.encodeCall(IERC20Looping.approve, (PENDLE_ROUTER, routerAllowance)));
        callback[2] = _call(PENDLE_ROUTER, fixture.fullExit);
        callback[3] = _call(PT, abi.encodeCall(IERC20Looping.approve, (PENDLE_ROUTER, 0)));

        bytes memory callbackData = abi.encode(callback);

        bundle = new Call[](3);
        bundle[0] = Call({
            to: ADAPTER,
            data: abi.encodeCall(
                IGeneralAdapter1Looping.morphoRepay,
                (marketParams, 0, MAX_UINT, fixture.maxRepaySharePriceE27, user, callbackData)
            ),
            value: 0,
            skipRevert: false,
            callbackHash: keccak256(callbackData)
        });
        bundle[1] = _call(ADAPTER, abi.encodeCall(IGeneralAdapter1Looping.erc20Transfer, (USDC, user, MAX_UINT)));
        bundle[2] = _call(ADAPTER, abi.encodeCall(IGeneralAdapter1Looping.erc20Transfer, (PT, user, MAX_UINT)));
    }

    function _call(address to, bytes memory data) internal pure returns (Call memory) {
        return Call({to: to, data: data, value: 0, skipRevert: false, callbackHash: bytes32(0)});
    }

    function _assertNoProtocolPosition(address owner, string memory message) internal view {
        (uint256 supplyShares, uint128 borrowShares, uint128 collateral) =
            IMorphoLooping(MORPHO).position(MARKET_ID, owner);
        assertEq(supplyShares, 0, message);
        assertEq(borrowShares, 0, message);
        assertEq(collateral, 0, message);
    }

    function _assertDebtBounded(Fixture memory fixture, uint128 borrowShares) internal pure {
        assertLe(uint256(borrowShares), fixture.maxBorrowShares, "debt: share cap exceeded");
        assertLe(
            uint256(borrowShares) * fixture.maxRepaySharePriceE27 / RAY,
            fixture.repaymentCapUsdc,
            "debt: repayment cap exceeded"
        );
    }

    function _assertTransientBalancesCleared(string memory phase) internal view {
        _assertTransientBalancesCleared(phase, 0, 0);
    }

    function _assertTransientBalancesCleared(
        string memory phase,
        uint256 expectedBundlerUsdcAllowance,
        uint256 expectedBundlerPtAllowance
    ) internal view {
        assertEq(IERC20Looping(USDC).balanceOf(BUNDLER3), 0, string.concat(phase, ": Bundler USDC"));
        assertEq(IERC20Looping(PT).balanceOf(BUNDLER3), 0, string.concat(phase, ": Bundler PT"));
        assertEq(IERC20Looping(USDC).balanceOf(ADAPTER), 0, string.concat(phase, ": adapter USDC"));
        assertEq(IERC20Looping(PT).balanceOf(ADAPTER), 0, string.concat(phase, ": adapter PT"));
        assertEq(
            IERC20Looping(USDC).allowance(BUNDLER3, PENDLE_ROUTER),
            expectedBundlerUsdcAllowance,
            string.concat(phase, ": Bundler USDC allowance")
        );
        assertEq(
            IERC20Looping(PT).allowance(BUNDLER3, PENDLE_ROUTER),
            expectedBundlerPtAllowance,
            string.concat(phase, ": Bundler PT allowance")
        );
    }

    function _selector(bytes memory data) internal pure returns (bytes4 selector) {
        require(data.length >= 4, "fixture: calldata too short");
        assembly ("memory-safe") {
            selector := mload(add(data, 32))
        }
    }
}
