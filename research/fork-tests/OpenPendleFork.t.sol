// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/*//////////////////////////////////////////////////////////////
                        CHEATCODES (no forge-std)
//////////////////////////////////////////////////////////////*/
interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function label(address, string calldata) external;
}

/*//////////////////////////////////////////////////////////////
                        PENDLE STRUCTS (from IPAllActionTypeV3)
//////////////////////////////////////////////////////////////*/
struct SwapData {
    uint8 swapType; // enum SwapType { NONE, KYBERSWAP, ONE_INCH, ETH_WETH } (uint8 in abi)
    address extRouter;
    bytes extCalldata;
    bool needScale;
}

struct TokenInput {
    address tokenIn;
    uint256 netTokenIn;
    address tokenMintSy;
    address pendleSwap;
    SwapData swapData;
}

struct TokenOutput {
    address tokenOut;
    uint256 minTokenOut;
    address tokenRedeemSy;
    address pendleSwap;
    SwapData swapData;
}

struct Order {
    uint256 salt;
    uint256 expiry;
    uint256 nonce;
    uint8 orderType;
    address token;
    address YT;
    address maker;
    address receiver;
    uint256 makingAmount;
    uint256 lnImpliedRate;
    uint256 failSafeRate;
    bytes permit;
}

struct FillOrderParams {
    Order order;
    bytes signature;
    uint256 makingAmount;
}

struct LimitOrderData {
    address limitRouter;
    uint256 epsSkipMarket;
    FillOrderParams[] normalFills;
    FillOrderParams[] flashFills;
    bytes optData;
}

struct ApproxParams {
    uint256 guessMin;
    uint256 guessMax;
    uint256 guessOffchain;
    uint256 maxIteration;
    uint256 eps;
}

struct ExitPreExpReturnParams {
    uint256 netPtFromRemove;
    uint256 netSyFromRemove;
    uint256 netPyRedeem;
    uint256 netSyFromRedeem;
    uint256 netPtSwap;
    uint256 netYtSwap;
    uint256 netSyFromSwap;
    uint256 netSyFee;
    uint256 totalSyOut;
}

struct ExitPostExpReturnParams {
    uint256 netPtFromRemove;
    uint256 netSyFromRemove;
    uint256 netPtRedeem;
    uint256 netSyFromRedeem;
    uint256 totalSyOut;
}

/*//////////////////////////////////////////////////////////////
                        PENDLE INTERFACES
//////////////////////////////////////////////////////////////*/
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

interface IYCFactory {
    function createYieldContract(address SY, uint32 expiry, bool doCacheIndexSameBlock)
        external
        returns (address PT, address YT);
    function expiryDivisor() external view returns (uint96);
    function isPT(address) external view returns (bool);
}

interface IMarketFactoryV7 {
    function createNewMarket(address PT, int256 scalarRoot, int256 initialAnchor, uint80 lnFeeRateRoot)
        external
        returns (address market);
    function isValidMarket(address market) external view returns (bool);
    function getMarketConfig(address market, address router)
        external
        view
        returns (address treasury, uint80 overriddenFee, uint8 reserveFeePercent);
    function maxLnFeeRateRoot() external view returns (uint256);
}

interface IPMarketMini is IERC20 {
    function readTokens() external view returns (address SY, address PT, address YT);
    function expiry() external view returns (uint256);
    function isExpired() external view returns (bool);
    function factory() external view returns (address);
    function getNonOverrideLnFeeRateRoot() external view returns (uint80);
}

interface IRouter {
    // ActionMiscV3
    function mintSyFromToken(address receiver, address SY, uint256 minSyOut, TokenInput calldata input)
        external
        payable
        returns (uint256 netSyOut);
    function mintPyFromSy(address receiver, address YT, uint256 netSyIn, uint256 minPyOut)
        external
        returns (uint256 netPyOut);
    function mintPyFromToken(address receiver, address YT, uint256 minPyOut, TokenInput calldata input)
        external
        payable
        returns (uint256 netPyOut, uint256 netSyInterm);
    function redeemPyToToken(address receiver, address YT, uint256 netPyIn, TokenOutput calldata output)
        external
        returns (uint256 netTokenOut, uint256 netSyInterm);
    function exitPreExpToToken(
        address receiver,
        address market,
        uint256 netPtIn,
        uint256 netYtIn,
        uint256 netLpIn,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 totalTokenOut, ExitPreExpReturnParams memory params);
    function exitPostExpToToken(
        address receiver,
        address market,
        uint256 netPtIn,
        uint256 netLpIn,
        TokenOutput calldata output
    ) external returns (uint256 totalTokenOut, ExitPostExpReturnParams memory params);

    // ActionAddRemoveLiqV3
    function addLiquidityDualSyAndPt(
        address receiver,
        address market,
        uint256 netSyDesired,
        uint256 netPtDesired,
        uint256 minLpOut
    ) external returns (uint256 netLpOut, uint256 netSyUsed, uint256 netPtUsed);
    function addLiquiditySingleToken(
        address receiver,
        address market,
        uint256 minLpOut,
        ApproxParams calldata guessPtReceivedFromSy,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256 netLpOut, uint256 netSyFee, uint256 netSyInterm);
    function removeLiquiditySingleToken(
        address receiver,
        address market,
        uint256 netLpToRemove,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm);

    // ActionSwapPTV3
    function swapExactTokenForPt(
        address receiver,
        address market,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm);
    function swapExactPtForSy(
        address receiver,
        address market,
        uint256 exactPtIn,
        uint256 minSyOut,
        LimitOrderData calldata limit
    ) external returns (uint256 netSyOut, uint256 netSyFee);

    // ActionSwapYTV3
    function swapExactTokenForYt(
        address receiver,
        address market,
        uint256 minYtOut,
        ApproxParams calldata guessYtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256 netYtOut, uint256 netSyFee, uint256 netSyInterm);
    function swapExactSyForYt(
        address receiver,
        address market,
        uint256 exactSyIn,
        uint256 minYtOut,
        ApproxParams calldata guessYtOut,
        LimitOrderData calldata limit
    ) external returns (uint256 netYtOut, uint256 netSyFee);
    function swapExactYtForToken(
        address receiver,
        address market,
        uint256 exactYtIn,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm);

    // ActionStorageV4
    function selectorToFacet(bytes4 selector) external view returns (address);
}

/*//////////////////////////////////////////////////////////////
                        MOCKS
//////////////////////////////////////////////////////////////*/
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) public returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address fr, address to, uint256 amt) public returns (bool) {
        if (allowance[fr][msg.sender] != type(uint256).max) allowance[fr][msg.sender] -= amt;
        balanceOf[fr] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// @dev Minimal IStandardizedYield over MockERC20, 1:1, exchangeRate 1e18.
contract MockSY is MockERC20 {
    address public immutable yieldToken;

    constructor(address _underlying) MockERC20("SY Mock USD", "SY-mUSD") {
        yieldToken = _underlying;
    }

    function deposit(address receiver, address tokenIn, uint256 amountTokenToDeposit, uint256 minSharesOut)
        external
        payable
        returns (uint256 amountSharesOut)
    {
        require(tokenIn == yieldToken, "bad tokenIn");
        MockERC20(yieldToken).transferFrom(msg.sender, address(this), amountTokenToDeposit);
        amountSharesOut = amountTokenToDeposit;
        require(amountSharesOut >= minSharesOut, "slip");
        balanceOf[receiver] += amountSharesOut;
        totalSupply += amountSharesOut;
    }

    function redeem(
        address receiver,
        uint256 amountSharesToRedeem,
        address tokenOut,
        uint256 minTokenOut,
        bool burnFromInternalBalance
    ) external returns (uint256 amountTokenOut) {
        require(tokenOut == yieldToken, "bad tokenOut");
        address burnFrom = burnFromInternalBalance ? address(this) : msg.sender;
        balanceOf[burnFrom] -= amountSharesToRedeem;
        totalSupply -= amountSharesToRedeem;
        amountTokenOut = amountSharesToRedeem;
        require(amountTokenOut >= minTokenOut, "slip");
        MockERC20(yieldToken).transfer(receiver, amountTokenOut);
    }

    function exchangeRate() external pure returns (uint256) {
        return 1e18;
    }

    function assetInfo() external view returns (uint8 assetType, address assetAddress, uint8 assetDecimals) {
        return (0, yieldToken, 18);
    }

    function getTokensIn() external view returns (address[] memory res) {
        res = new address[](1);
        res[0] = yieldToken;
    }

    function getTokensOut() external view returns (address[] memory res) {
        res = new address[](1);
        res[0] = yieldToken;
    }

    function isValidTokenIn(address token) external view returns (bool) {
        return token == yieldToken;
    }

    function isValidTokenOut(address token) external view returns (bool) {
        return token == yieldToken;
    }

    function previewDeposit(address, uint256 amountTokenToDeposit) external pure returns (uint256) {
        return amountTokenToDeposit;
    }

    function previewRedeem(address, uint256 amountSharesToRedeem) external pure returns (uint256) {
        return amountSharesToRedeem;
    }

    function getRewardTokens() external pure returns (address[] memory res) {
        res = new address[](0);
    }

    function claimRewards(address) external pure returns (uint256[] memory res) {
        res = new uint256[](0);
    }

    function accruedRewards(address) external pure returns (uint256[] memory res) {
        res = new uint256[](0);
    }

    function rewardIndexesCurrent() external pure returns (uint256[] memory res) {
        res = new uint256[](0);
    }
}

/*//////////////////////////////////////////////////////////////
                        THE FORK TEST
//////////////////////////////////////////////////////////////*/
contract OpenPendleForkTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // Canonical Arbitrum addresses (pendle-core-v2-public/deployments/42161-core.json)
    address constant ROUTER_V4 = 0x888888888889758F76e7103c6CbF23ABbF58F946;
    address constant YCF_V6 = 0xBA814Bf6E27A6d6baE4a8aC65c8Bc3d8e9B0aaCF; // yieldContractFactory paired w/ V7 mkt factory
    address constant MKT_FACTORY_V7 = 0x49F2f7002669E0e4425Fa0203975625Ab4af3143; // VERSION() == 7
    address constant TREASURY = 0xCbcb48e22622a3778b6F14C2f5d258Ba026b05e6;

    // Selectors as dumped from the LIVE router selector map (SelectorToFacetSet events)
    bytes4 constant SEL_swapExactTokenForPt = 0xc81f847a;
    bytes4 constant SEL_swapExactTokenForYt = 0xed48907e;
    bytes4 constant SEL_addLiquiditySingleToken = 0x12599ac6;
    bytes4 constant SEL_removeLiquiditySingleToken = 0x60da0860;
    bytes4 constant SEL_swapExactPtForSy = 0x3346d3a3;
    bytes4 constant SEL_swapExactSyForYt = 0x7b8b4b95;
    bytes4 constant SEL_exitPreExpToToken = 0x7036e052;
    bytes4 constant SEL_exitPostExpToToken = 0xf06a07a0;
    bytes4 constant SEL_mintPyFromToken = 0xd0f42385;
    bytes4 constant SEL_redeemPyToToken = 0x47f1de22;
    bytes4 constant SEL_swapExactPtForYt_REMOVED = 0xc861a898;
    bytes4 constant SEL_swapExactYtForPt_REMOVED = 0x448b9b95;

    IRouter constant router = IRouter(ROUTER_V4);

    MockERC20 underlying;
    MockSY sy;
    address pt;
    address yt;
    address market;

    event Info(string what, uint256 value);

    function emptyLimit() internal pure returns (LimitOrderData memory l) {}

    function defaultApprox() internal pure returns (ApproxParams memory) {
        return ApproxParams({guessMin: 0, guessMax: type(uint256).max, guessOffchain: 0, maxIteration: 256, eps: 1e14});
    }

    function tokenInput(uint256 amt) internal view returns (TokenInput memory t) {
        t.tokenIn = address(underlying);
        t.netTokenIn = amt;
        t.tokenMintSy = address(underlying);
    }

    function tokenOutput() internal view returns (TokenOutput memory t) {
        t.tokenOut = address(underlying);
        t.tokenRedeemSy = address(underlying);
    }

    function test_RouterV4_AcceptsNeverWhitelistedMarket() external {
        // -1. compile-time selector integrity: our interface == deployed selector map
        require(IRouter.swapExactTokenForPt.selector == SEL_swapExactTokenForPt, "sel swapExactTokenForPt");
        require(IRouter.swapExactTokenForYt.selector == SEL_swapExactTokenForYt, "sel swapExactTokenForYt");
        require(IRouter.addLiquiditySingleToken.selector == SEL_addLiquiditySingleToken, "sel addLiqSingleToken");
        require(
            IRouter.removeLiquiditySingleToken.selector == SEL_removeLiquiditySingleToken, "sel removeLiqSingleToken"
        );
        require(IRouter.swapExactPtForSy.selector == SEL_swapExactPtForSy, "sel swapExactPtForSy");
        require(IRouter.swapExactSyForYt.selector == SEL_swapExactSyForYt, "sel swapExactSyForYt");
        require(IRouter.exitPreExpToToken.selector == SEL_exitPreExpToToken, "sel exitPreExpToToken");
        require(IRouter.exitPostExpToToken.selector == SEL_exitPostExpToToken, "sel exitPostExpToToken");
        require(IRouter.mintPyFromToken.selector == SEL_mintPyFromToken, "sel mintPyFromToken");
        require(IRouter.redeemPyToToken.selector == SEL_redeemPyToToken, "sel redeemPyToToken");

        // 0. live selector map checks: PT<->YT direct selectors REMOVED, core ones present
        require(router.selectorToFacet(SEL_swapExactTokenForPt) != address(0), "map: swapExactTokenForPt missing");
        require(router.selectorToFacet(SEL_swapExactPtForYt_REMOVED) == address(0), "map: swapExactPtForYt present?");
        require(router.selectorToFacet(SEL_swapExactYtForPt_REMOVED) == address(0), "map: swapExactYtForPt present?");

        // 1. deploy a brand-new asset + SY that Pendle has NEVER seen
        underlying = new MockERC20("Mock USD", "mUSD");
        sy = new MockSY(address(underlying));

        // 2. permissionless PT/YT creation via canonical yield contract factory
        uint32 expiry = uint32(((block.timestamp + 90 days) / 86400 + 1) * 86400);
        (pt, yt) = IYCFactory(YCF_V6).createYieldContract(address(sy), expiry, false);
        require(IYCFactory(YCF_V6).isPT(pt), "PT not registered");

        // 3. permissionless market creation via canonical market factory V7
        // scalarRoot/anchor computed like MarketDeployLib.calcParams(2%, 15%, ~90d)
        market =
            IMarketFactoryV7(MKT_FACTORY_V7).createNewMarket(pt, int256(35.88e18), int256(1.02e18), 5982071677547463);
        require(IMarketFactoryV7(MKT_FACTORY_V7).isValidMarket(market), "not valid market");

        // 4. fee config: NO overriddenFee for this market through ANY router (incl. V4)
        {
            (address tre, uint80 ovFee, uint8 resPct) =
                IMarketFactoryV7(MKT_FACTORY_V7).getMarketConfig(market, ROUTER_V4);
            require(tre == TREASURY, "treasury mismatch");
            require(ovFee == 0, "unexpected fee override");
            emit Info("reserveFeePercent", resPct);
        }

        // 5. seed liquidity THROUGH ROUTER V4 (same as Pendle's own PoolDeployHelper does)
        underlying.mint(address(this), 1_000_000e18);
        underlying.approve(ROUTER_V4, type(uint256).max);
        uint256 netSy = router.mintSyFromToken(address(this), address(sy), 0, tokenInput(2000e18));
        require(netSy == 2000e18, "mintSyFromToken");
        sy.approve(ROUTER_V4, type(uint256).max);
        uint256 netPy = router.mintPyFromSy(address(this), yt, 800e18, 0);
        require(netPy == 800e18, "mintPyFromSy");
        IERC20(pt).approve(ROUTER_V4, type(uint256).max);
        (uint256 seedLp,,) = router.addLiquidityDualSyAndPt(address(this), market, 1200e18, 800e18, 0);
        require(seedLp > 0, "seed addLiquidityDualSyAndPt");
        emit Info("seedLp", seedLp);

        // 6. trades by an unrelated user, all through Router V4, on the never-whitelisted market
        address user = address(0xBEEF);
        underlying.mint(user, 1000e18);
        uint256 treasuryBefore = sy.balanceOf(TREASURY);

        vm.startPrank(user);
        underlying.approve(ROUTER_V4, type(uint256).max);

        // 6a. swapExactTokenForPt
        (uint256 netPtOut,,) =
            router.swapExactTokenForPt(user, market, 0, defaultApprox(), tokenInput(50e18), emptyLimit());
        require(netPtOut > 0, "swapExactTokenForPt = 0");
        emit Info("swapExactTokenForPt netPtOut", netPtOut);

        // 6b. swapExactTokenForYt (small size: YT buys lever ~1/ytPrice of pool depth)
        (uint256 netYtOut,,) =
            router.swapExactTokenForYt(user, market, 0, defaultApprox(), tokenInput(2e18), emptyLimit());
        require(netYtOut > 0, "swapExactTokenForYt = 0");
        emit Info("swapExactTokenForYt netYtOut", netYtOut);

        // 6c. addLiquiditySingleToken (zap in)
        (uint256 lpOut,,) =
            router.addLiquiditySingleToken(user, market, 0, defaultApprox(), tokenInput(100e18), emptyLimit());
        require(lpOut > 0, "addLiquiditySingleToken = 0");
        emit Info("addLiquiditySingleToken lpOut", lpOut);

        // 6d. removeLiquiditySingleToken (zap out)
        IERC20(market).approve(ROUTER_V4, type(uint256).max);
        (uint256 tokOut,,) = router.removeLiquiditySingleToken(user, market, lpOut / 2, tokenOutput(), emptyLimit());
        require(tokOut > 0, "removeLiquiditySingleToken = 0");
        emit Info("removeLiquiditySingleToken tokenOut", tokOut);

        // 6e. PT -> YT via two-step composition (direct selector was removed from router)
        IERC20(pt).approve(ROUTER_V4, type(uint256).max);
        (uint256 syFromPt,) = router.swapExactPtForSy(user, market, netPtOut / 2, 0, emptyLimit());
        require(syFromPt > 0, "swapExactPtForSy = 0");
        sy.approve(ROUTER_V4, type(uint256).max);
        uint256 syLeg = syFromPt < 2e18 ? syFromPt : 2e18;
        (uint256 ytFromSy,) = router.swapExactSyForYt(user, market, syLeg, 0, defaultApprox(), emptyLimit());
        require(ytFromSy > 0, "swapExactSyForYt = 0");
        emit Info("PT->SY->YT two-step ytOut", ytFromSy);

        // 6e-bis. YT -> token (completes YT trading loop)
        IERC20(yt).approve(ROUTER_V4, type(uint256).max);
        (uint256 tokFromYt,,) = router.swapExactYtForToken(user, market, ytFromSy / 2, tokenOutput(), emptyLimit());
        require(tokFromYt > 0, "swapExactYtForToken = 0");
        emit Info("swapExactYtForToken tokenOut", tokFromYt);

        // 6f. mint PT+YT from token, redeem PT+YT back to token
        (uint256 pyMinted,) = router.mintPyFromToken(user, yt, 0, tokenInput(30e18));
        require(pyMinted > 0, "mintPyFromToken = 0");
        IERC20(yt).approve(ROUTER_V4, type(uint256).max);
        (uint256 redeemedTok,) = router.redeemPyToToken(user, yt, pyMinted / 2, tokenOutput());
        require(redeemedTok > 0, "redeemPyToToken = 0");
        emit Info("mint/redeem PY roundtrip token", redeemedTok);

        // 6g. exitPreExpToToken with LP + PT + YT together
        {
            uint256 lpBal = IERC20(market).balanceOf(user);
            uint256 ptBal = IERC20(pt).balanceOf(user);
            uint256 ytBal = IERC20(yt).balanceOf(user);
            (uint256 exitOut, ExitPreExpReturnParams memory p) = router.exitPreExpToToken(
                user, market, ptBal / 2, ytBal / 2, lpBal / 2, tokenOutput(), emptyLimit()
            );
            require(exitOut > 0, "exitPreExpToToken = 0");
            require(p.totalSyOut > 0, "exitPreExp totalSyOut = 0");
            emit Info("exitPreExpToToken out", exitOut);
        }
        vm.stopPrank();

        // 7. protocol fees flowed to Pendle treasury from this non-whitelisted market
        uint256 treasuryGain = sy.balanceOf(TREASURY) - treasuryBefore;
        require(treasuryGain > 0, "no fee to treasury");
        emit Info("treasury SY fee gain", treasuryGain);

        // 8. removed selectors revert with INVALID_SELECTOR
        {
            (bool ok, bytes memory ret) = ROUTER_V4.call(
                abi.encodeWithSelector(
                    SEL_swapExactPtForYt_REMOVED, address(this), market, uint256(1e18), uint256(0), defaultApprox()
                )
            );
            require(!ok, "removed selector did not revert");
            // Error(string) INVALID_SELECTOR
            require(ret.length >= 4 && bytes4(ret) == bytes4(0x08c379a0), "unexpected revert type");
        }

        // 9. expiry handling: post-expiry swaps revert, exitPostExpToToken works
        vm.warp(uint256(expiry) + 1);
        require(IPMarketMini(market).isExpired(), "market should be expired");

        vm.startPrank(user);
        (bool okSwap,) = ROUTER_V4.call(
            abi.encodeWithSelector(
                IRouter.swapExactTokenForPt.selector,
                user,
                market,
                uint256(0),
                defaultApprox(),
                tokenInput(1e18),
                emptyLimit()
            )
        );
        require(!okSwap, "swap on expired market should revert");

        {
            uint256 lpBal = IERC20(market).balanceOf(user);
            uint256 ptBal = IERC20(pt).balanceOf(user);
            require(lpBal > 0 && ptBal > 0, "need leftovers for post-exp test");
            (uint256 postExpOut, ExitPostExpReturnParams memory pp) =
                router.exitPostExpToToken(user, market, ptBal, lpBal, tokenOutput());
            require(postExpOut > 0, "exitPostExpToToken = 0");
            require(pp.totalSyOut > 0 && pp.netSyFromRedeem > 0, "post-exp params empty");
            emit Info("exitPostExpToToken out", postExpOut);
        }
        vm.stopPrank();
    }
}
