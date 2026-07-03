// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////////////////
    QuoterParity.t.sol — M0 deliverable (PLAN.md §5 M0, decides M3 quoter)

    Question: are PendleRouterStatic quotes consistent with actual Router V4
    execution on
      (a) a Pendle-listed market with a governance-discounted per-router fee
          (PLP USDai 25FEB2027, 0x46f5...46ef), and
      (b) a fresh community market with no fee override (created in-fork
          over a mock SY)?

    Concern (PLAN §2 F10): fees are per-(router, market). If RouterStatic's
    internal fee context is the base fee while Router V4 executes at the
    discounted fee, quotes mislead and static-derived ApproxParams bounds can
    make execution revert.

    IMPORTANT: divergence does NOT fail this suite. Assertions only verify
    harness mechanics (calls succeed, values non-zero, the fee discount
    precondition still exists). The deviations are FINDINGS, logged with
    console2.log and written up in fork-tests/PARITY.md.
//////////////////////////////////////////////////////////////////////////*/

import "forge-std/Test.sol";

/*//////////////////////////////////////////////////////////////
                    PENDLE STRUCTS
//////////////////////////////////////////////////////////////*/
struct SwapData {
    uint8 swapType;
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

/// Field order verified live against readState() at block 480027000.
struct MarketState {
    int256 totalPt;
    int256 totalSy;
    int256 totalLp;
    address treasury;
    int256 scalarRoot;
    uint256 expiry;
    uint256 lnFeeRateRoot;
    uint256 reserveFeePercent;
    uint256 lastLnImpliedRate;
}

/*//////////////////////////////////////////////////////////////
                    INTERFACES
//////////////////////////////////////////////////////////////*/
interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IPMarket {
    function readTokens() external view returns (address SY, address PT, address YT);
    function readState(address router) external view returns (MarketState memory);
    function isExpired() external view returns (bool);
    function expiry() external view returns (uint256);
}

interface ISYMin {
    function getTokensIn() external view returns (address[] memory);
    function previewDeposit(address tokenIn, uint256 amountTokenToDeposit) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IYCFactory {
    function createYieldContract(address SY, uint32 expiry, bool doCacheIndexSameBlock)
        external
        returns (address PT, address YT);
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
}

interface IRouterExec {
    function selectorToFacet(bytes4 selector) external view returns (address);
    function mintSyFromToken(address receiver, address SY, uint256 minSyOut, TokenInput calldata input)
        external
        payable
        returns (uint256 netSyOut);
    function mintPyFromSy(address receiver, address YT, uint256 netSyIn, uint256 minPyOut)
        external
        returns (uint256 netPyOut);
    function addLiquidityDualSyAndPt(
        address receiver,
        address market,
        uint256 netSyDesired,
        uint256 netPtDesired,
        uint256 minLpOut
    ) external returns (uint256 netLpOut, uint256 netSyUsed, uint256 netPtUsed);
    function swapExactSyForPt(
        address receiver,
        address market,
        uint256 exactSyIn,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        LimitOrderData calldata limit
    ) external returns (uint256 netPtOut, uint256 netSyFee);
    function swapExactTokenForPt(
        address receiver,
        address market,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm);
    function swapExactSyForYt(
        address receiver,
        address market,
        uint256 exactSyIn,
        uint256 minYtOut,
        ApproxParams calldata guessYtOut,
        LimitOrderData calldata limit
    ) external returns (uint256 netYtOut, uint256 netSyFee);
}

/// Signatures + return layouts verified live via eth_call at block 480027000.
interface IRouterStatic {
    function swapExactSyForPtStatic(address market, uint256 exactSyIn)
        external
        view
        returns (uint256 netPtOut, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter);
    function swapExactTokenForPtStatic(address market, address tokenIn, uint256 amountTokenIn)
        external
        view
        returns (
            uint256 netPtOut,
            uint256 netSyMinted,
            uint256 netSyFee,
            uint256 priceImpact,
            uint256 exchangeRateAfter
        );
    function swapExactSyForYtStatic(address market, uint256 exactSyIn)
        external
        view
        returns (uint256 netYtOut, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter);
    function swapExactTokenForYtStatic(address market, address tokenIn, uint256 amountTokenIn)
        external
        view
        returns (
            uint256 netYtOut,
            uint256 netSyMinted,
            uint256 netSyFee,
            uint256 priceImpact,
            uint256 exchangeRateAfter
        );
}

/*//////////////////////////////////////////////////////////////
                    MOCKS (pattern from OpenPendleFork.t.sol)
//////////////////////////////////////////////////////////////*/
contract QPMockERC20 {
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

/// Minimal IStandardizedYield over QPMockERC20, 1:1, exchangeRate 1e18.
contract QPMockSY is QPMockERC20 {
    address public immutable yieldToken;

    constructor(address _underlying) QPMockERC20("SY Mock USD QP", "SY-mUSD-QP") {
        yieldToken = _underlying;
    }

    function deposit(address receiver, address tokenIn, uint256 amountTokenToDeposit, uint256 minSharesOut)
        external
        payable
        returns (uint256 amountSharesOut)
    {
        require(tokenIn == yieldToken, "bad tokenIn");
        QPMockERC20(yieldToken).transferFrom(msg.sender, address(this), amountTokenToDeposit);
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
        QPMockERC20(yieldToken).transfer(receiver, amountTokenOut);
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
                    THE PARITY TEST
//////////////////////////////////////////////////////////////*/
contract QuoterParityTest is Test {
    // Canonical Arbitrum addresses (PLAN.md Appendix A)
    address constant ROUTER_V4 = 0x888888888889758F76e7103c6CbF23ABbF58F946;
    address constant ROUTER_STATIC = 0xAdB09F65bd90d19e3148D9ccb693F3161C6DB3E8;
    address constant ROUTER_V3_LEGACY = 0x00000000005BBB0EF59571E58418F9a4357b68A0;
    address constant YCF_V6 = 0xBA814Bf6E27A6d6baE4a8aC65c8Bc3d8e9B0aaCF;
    address constant MKT_FACTORY_V7 = 0x49F2f7002669E0e4425Fa0203975625Ab4af3143;

    // Listed, fee-discounted, ACTIVE market: "PLP USDai 25FEB2027", expiry 1803513600
    address constant LISTED_MARKET = 0x46f545683D8494Ef4c54B7ea40cA762c620846eF;
    // SY tokensIn on the listed market (verified at fork block): [PYUSD (6 dec), USDai (18 dec)]
    address constant USDAI = 0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF;

    IRouterExec constant router = IRouterExec(ROUTER_V4);
    IRouterStatic constant rstatic = IRouterStatic(ROUTER_STATIC);

    address user = makeAddr("parityUser");

    /*----------------------------------------------------------
                        helpers
    ----------------------------------------------------------*/
    function emptyLimit() internal pure returns (LimitOrderData memory l) {}

    /// createDefaultApproxParams() — the fork-proven default (F6)
    function defaultApprox() internal pure returns (ApproxParams memory) {
        return ApproxParams({guessMin: 0, guessMax: type(uint256).max, guessOffchain: 0, maxIteration: 256, eps: 1e14});
    }

    /// Emulation of the (NOT deployed, see selector survey) *AndGenerateApproxParams
    /// output: offchain guess = static quote, tight ±0.1% bounds.
    function tightApprox(uint256 q) internal pure returns (ApproxParams memory) {
        return ApproxParams({guessMin: q * 999 / 1000, guessMax: q * 1001 / 1000, guessOffchain: q, maxIteration: 256, eps: 1e14});
    }

    /// Offchain guess from the static quote but with fail-safe wide bounds.
    function seededApprox(uint256 q) internal pure returns (ApproxParams memory) {
        return ApproxParams({guessMin: 0, guessMax: type(uint256).max, guessOffchain: q, maxIteration: 256, eps: 1e14});
    }

    function tokenInput(address tok, uint256 amt) internal pure returns (TokenInput memory t) {
        t.tokenIn = tok;
        t.netTokenIn = amt;
        t.tokenMintSy = tok;
    }

    /// |a - b| * 1e6 / b  (parts-per-million vs actual)
    function relDevPpm(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 d = a > b ? a - b : b - a;
        return d * 1e6 / b;
    }

    function logDeviation(string memory label, uint256 staticQ, uint256 actual) internal pure {
        console2.log(string.concat("  ", label, " static  :"), staticQ);
        console2.log(string.concat("  ", label, " actual  :"), actual);
        console2.log(
            string.concat(
                "  deviation: ",
                vm.toString(relDevPpm(staticQ, actual)),
                " ppm (",
                staticQ < actual ? "static UNDERquotes" : (staticQ > actual ? "static OVERquotes" : "exact match"),
                ")"
            )
        );
    }

    function logFeeContext(address market) internal view {
        console2.log("  lnFeeRateRoot base (addr0)   :", IPMarket(market).readState(address(0)).lnFeeRateRoot);
        console2.log("  lnFeeRateRoot Router V4      :", IPMarket(market).readState(ROUTER_V4).lnFeeRateRoot);
        console2.log("  lnFeeRateRoot RouterStatic   :", IPMarket(market).readState(ROUTER_STATIC).lnFeeRateRoot);
        console2.log("  lnFeeRateRoot legacy RouterV3:", IPMarket(market).readState(ROUTER_V3_LEGACY).lnFeeRateRoot);
    }

    /*----------------------------------------------------------
        selector survey: which RouterStatic quote fns exist?
    ----------------------------------------------------------*/
    /// EXISTS if the diamond dispatches the selector (call may still revert
    /// inside the facet for arg reasons); MISSING when the fallback reverts
    /// Error("selector not found").
    function selectorExists(bytes memory callData) internal view returns (bool ok, bool exists) {
        bytes memory ret;
        (ok, ret) = ROUTER_STATIC.staticcall(callData);
        if (ok) return (ok, true);
        if (ret.length >= 100 && bytes4(ret) == bytes4(0x08c379a0)) {
            // decode Error(string)
            bytes memory body = new bytes(ret.length - 4);
            for (uint256 i = 4; i < ret.length; i++) {
                body[i - 4] = ret[i];
            }
            string memory reason = abi.decode(body, (string));
            exists = keccak256(bytes(reason)) != keccak256(bytes("selector not found"));
        } else {
            exists = true; // reverted some other way => facet code ran
        }
    }

    function survey(string memory sig, bytes memory args) internal view returns (bool exists) {
        bool ok;
        (ok, exists) = selectorExists(abi.encodePacked(bytes4(keccak256(bytes(sig))), args));
        console2.log(string.concat(exists ? (ok ? "  OK       " : "  EXISTS*  ") : "  MISSING  ", sig));
    }

    function test_routerStatic_selectorSurvey() external view {
        console2.log("=== RouterStatic selector survey (OK = call succeeded, EXISTS* = selector dispatched but call reverted, MISSING = 'selector not found') ===");
        address m = LISTED_MARKET;
        uint256 amt = 100e18;
        bytes memory a2 = abi.encode(m, amt);
        bytes memory a3tok = abi.encode(m, USDAI, amt);
        bytes memory a3out = abi.encode(m, amt, USDAI);

        // exact-in swap quotes
        bool coreSyPt = survey("swapExactSyForPtStatic(address,uint256)", a2);
        bool coreTokPt = survey("swapExactTokenForPtStatic(address,address,uint256)", a3tok);
        bool coreSyYt = survey("swapExactSyForYtStatic(address,uint256)", a2);
        survey("swapExactTokenForYtStatic(address,address,uint256)", a3tok);
        survey("swapExactPtForSyStatic(address,uint256)", a2);
        survey("swapExactPtForTokenStatic(address,uint256,address)", a3out);
        survey("swapExactYtForSyStatic(address,uint256)", a2);
        survey("swapExactYtForTokenStatic(address,uint256,address)", a3out);
        // exact-out swap quotes
        survey("swapSyForExactPtStatic(address,uint256)", a2);
        survey("swapPtForExactSyStatic(address,uint256)", a2);
        survey("swapSyForExactYtStatic(address,uint256)", a2);
        survey("swapYtForExactSyStatic(address,uint256)", a2);
        // ApproxParams generators (research digest F6 said these exist — verify)
        survey("swapExactSyForPtStaticAndGenerateApproxParams(address,uint256)", a2);
        survey("swapExactTokenForPtStaticAndGenerateApproxParams(address,address,uint256)", a3tok);
        survey("swapExactSyForYtStaticAndGenerateApproxParams(address,uint256)", a2);
        survey("swapExactTokenForYtStaticAndGenerateApproxParams(address,address,uint256)", a3tok);
        // price impact decomposition
        survey("calcPriceImpactPt(address,int256)", abi.encode(m, int256(1e18)));
        survey("calcPriceImpactYt(address,int256)", abi.encode(m, int256(1e18)));
        survey("calcPriceImpactPY(address,int256)", abi.encode(m, int256(1e18)));
        // liquidity quotes
        survey("addLiquiditySingleSyStatic(address,uint256)", a2);
        survey("addLiquiditySingleSyKeepYtStatic(address,uint256)", a2);
        survey("removeLiquiditySingleSyStatic(address,uint256)", a2);
        // info helpers
        survey("getMarketState(address)", abi.encode(m));
        survey("getYieldTokenAndPtRate(address)", abi.encode(m));
        survey("getPtImpliedYield(address)", abi.encode(m));
        survey("getUserMarketInfo(address,address)", abi.encode(m, address(0xBEEF)));

        // harness mechanics: the three quote fns the parity test depends on must exist
        assertTrue(coreSyPt, "swapExactSyForPtStatic missing");
        assertTrue(coreTokPt, "swapExactTokenForPtStatic missing");
        assertTrue(coreSyYt, "swapExactSyForYtStatic missing");
    }

    /*----------------------------------------------------------
        precondition: the governance fee discount still exists
    ----------------------------------------------------------*/
    function test_listed_feeDiscountStillPresent() external view {
        console2.log("=== LISTED market fee context (PLP USDai 25FEB2027) ===");
        logFeeContext(LISTED_MARKET);
        uint256 base = IPMarket(LISTED_MARKET).readState(address(0)).lnFeeRateRoot;
        uint256 v4 = IPMarket(LISTED_MARKET).readState(ROUTER_V4).lnFeeRateRoot;
        assertTrue(base != v4, "fee discount for Router V4 no longer present - parity premise changed, re-check PARITY.md");
        assertFalse(IPMarket(LISTED_MARKET).isExpired(), "listed market expired");
    }

    /*----------------------------------------------------------
        parity core: one direction = quote, execute, compare
    ----------------------------------------------------------*/
    struct DirResult {
        uint256 staticOut;
        uint256 staticFee;
        uint256 actualOut;
        uint256 actualFee;
    }

    function runSyForPt(address market, uint256 syIn) internal returns (DirResult memory r) {
        console2.log("--- swapExactSyForPt | exactSyIn:", syIn);
        (r.staticOut, r.staticFee,,) = rstatic.swapExactSyForPtStatic(market, syIn);

        uint256 snap = vm.snapshotState();
        vm.prank(user);
        (r.actualOut, r.actualFee) = router.swapExactSyForPt(user, market, syIn, 0, defaultApprox(), emptyLimit());
        vm.revertToState(snap);

        logDeviation("netPtOut", r.staticOut, r.actualOut);
        console2.log("  netSyFee static:", r.staticFee);
        console2.log("  netSyFee actual:", r.actualFee);

        // (a) emulated generated ApproxParams: offchain = static quote, +-0.1% bounds
        vm.prank(user);
        try router.swapExactSyForPt(user, market, syIn, 0, tightApprox(r.staticOut), emptyLimit()) returns (
            uint256 o, uint256
        ) {
            console2.log("  tight static-derived ApproxParams (+-0.1%): OK, netPtOut =", o);
        } catch {
            console2.log("  tight static-derived ApproxParams (+-0.1%): REVERTED");
        }
        vm.revertToState(snap);

        // (b) offchain guess seeded from static quote, fail-safe wide bounds
        vm.prank(user);
        try router.swapExactSyForPt(user, market, syIn, 0, seededApprox(r.staticOut), emptyLimit()) returns (
            uint256 o, uint256
        ) {
            console2.log("  seeded-guess wide-bounds ApproxParams     : OK, netPtOut =", o);
        } catch {
            console2.log("  seeded-guess wide-bounds ApproxParams     : REVERTED");
        }
        vm.revertToState(snap);

        // (c) would a UI using the static quote as minPtOut get reverts?
        vm.prank(user);
        try router.swapExactSyForPt(user, market, syIn, r.staticOut, defaultApprox(), emptyLimit()) returns (
            uint256 o, uint256
        ) {
            console2.log("  minPtOut = static quote, default approx   : OK, netPtOut =", o);
        } catch {
            console2.log("  minPtOut = static quote, default approx   : REVERTED (static quote not achievable)");
        }
        vm.revertToState(snap);

        assertGt(r.staticOut, 0, "static quote zero");
        assertGt(r.actualOut, 0, "actual out zero");
    }

    function runTokenForPt(address market, address tokenIn, uint256 tokAmt) internal returns (DirResult memory r) {
        console2.log("--- swapExactTokenForPt | netTokenIn:", tokAmt);
        uint256 syMinted;
        (r.staticOut, syMinted, r.staticFee,,) = rstatic.swapExactTokenForPtStatic(market, tokenIn, tokAmt);
        console2.log("  netSyMinted (static preview):", syMinted);

        uint256 snap = vm.snapshotState();
        vm.prank(user);
        (r.actualOut, r.actualFee,) =
            router.swapExactTokenForPt(user, market, 0, defaultApprox(), tokenInput(tokenIn, tokAmt), emptyLimit());
        vm.revertToState(snap);

        logDeviation("netPtOut", r.staticOut, r.actualOut);
        console2.log("  netSyFee static:", r.staticFee);
        console2.log("  netSyFee actual:", r.actualFee);

        vm.prank(user);
        try router.swapExactTokenForPt(
            user, market, 0, tightApprox(r.staticOut), tokenInput(tokenIn, tokAmt), emptyLimit()
        ) returns (uint256 o, uint256, uint256) {
            console2.log("  tight static-derived ApproxParams (+-0.1%): OK, netPtOut =", o);
        } catch {
            console2.log("  tight static-derived ApproxParams (+-0.1%): REVERTED");
        }
        vm.revertToState(snap);

        vm.prank(user);
        try router.swapExactTokenForPt(
            user, market, r.staticOut, defaultApprox(), tokenInput(tokenIn, tokAmt), emptyLimit()
        ) returns (uint256 o, uint256, uint256) {
            console2.log("  minPtOut = static quote, default approx   : OK, netPtOut =", o);
        } catch {
            console2.log("  minPtOut = static quote, default approx   : REVERTED (static quote not achievable)");
        }
        vm.revertToState(snap);

        assertGt(r.staticOut, 0, "static quote zero");
        assertGt(r.actualOut, 0, "actual out zero");
    }

    function runSyForYt(address market, uint256 syIn) internal returns (DirResult memory r) {
        console2.log("--- swapExactSyForYt | exactSyIn:", syIn);
        (r.staticOut, r.staticFee,,) = rstatic.swapExactSyForYtStatic(market, syIn);

        uint256 snap = vm.snapshotState();
        vm.prank(user);
        (r.actualOut, r.actualFee) = router.swapExactSyForYt(user, market, syIn, 0, defaultApprox(), emptyLimit());
        vm.revertToState(snap);

        logDeviation("netYtOut", r.staticOut, r.actualOut);
        console2.log("  netSyFee static:", r.staticFee);
        console2.log("  netSyFee actual:", r.actualFee);

        vm.prank(user);
        try router.swapExactSyForYt(user, market, syIn, 0, tightApprox(r.staticOut), emptyLimit()) returns (
            uint256 o, uint256
        ) {
            console2.log("  tight static-derived ApproxParams (+-0.1%): OK, netYtOut =", o);
        } catch {
            console2.log("  tight static-derived ApproxParams (+-0.1%): REVERTED");
        }
        vm.revertToState(snap);

        vm.prank(user);
        try router.swapExactSyForYt(user, market, syIn, r.staticOut, defaultApprox(), emptyLimit()) returns (
            uint256 o, uint256
        ) {
            console2.log("  minYtOut = static quote, default approx   : OK, netYtOut =", o);
        } catch {
            console2.log("  minYtOut = static quote, default approx   : REVERTED (static quote not achievable)");
        }
        vm.revertToState(snap);

        assertGt(r.staticOut, 0, "static quote zero");
        assertGt(r.actualOut, 0, "actual out zero");
    }

    /*----------------------------------------------------------
        (a) listed, governance fee-discounted market
    ----------------------------------------------------------*/
    function test_parity_listedDiscountedMarket() external {
        console2.log("=== PARITY (a): LISTED fee-discounted market", LISTED_MARKET, "===");
        (address sy,,) = IPMarket(LISTED_MARKET).readTokens();
        logFeeContext(LISTED_MARKET);

        MarketState memory st = IPMarket(LISTED_MARKET).readState(ROUTER_V4);
        console2.log("  pool totalSy:", uint256(st.totalSy));

        // fund + approve (trade sizes ~0.05-0.25% of pool SY = 39296e18)
        deal(sy, user, 200e18);
        deal(USDAI, user, 200e18);
        vm.startPrank(user);
        ISYMin(sy).approve(ROUTER_V4, type(uint256).max);
        IERC20Min(USDAI).approve(ROUTER_V4, type(uint256).max);
        vm.stopPrank();

        runSyForPt(LISTED_MARKET, 100e18); //  ~0.25% of pool SY
        runTokenForPt(LISTED_MARKET, USDAI, 100e18);
        runSyForYt(LISTED_MARKET, 20e18); //   YT trades lever ~1/ytPrice of notional
    }

    /*----------------------------------------------------------
        (b) fresh community market, no fee override
    ----------------------------------------------------------*/
    QPMockERC20 underlying;
    QPMockSY mockSy;
    address freshPt;
    address freshYt;
    address freshMarket;

    // Same creator-chosen fee as the listed market's BASE fee, so the two
    // scenarios differ only by the governance override.
    uint80 constant FRESH_LN_FEE = 5982071677547463;

    function createFreshMarket() internal {
        underlying = new QPMockERC20("Mock USD QP", "mUSD-QP");
        mockSy = new QPMockSY(address(underlying));

        uint32 expiry = uint32(((block.timestamp + 90 days) / 86400 + 1) * 86400);
        (freshPt, freshYt) = IYCFactory(YCF_V6).createYieldContract(address(mockSy), expiry, false);
        freshMarket = IMarketFactoryV7(MKT_FACTORY_V7).createNewMarket(
            freshPt, int256(35.88e18), int256(1.02e18), FRESH_LN_FEE
        );
        require(IMarketFactoryV7(MKT_FACTORY_V7).isValidMarket(freshMarket), "fresh market invalid");

        // no per-router override for the fresh market (harness precondition)
        (, uint80 ovFee,) = IMarketFactoryV7(MKT_FACTORY_V7).getMarketConfig(freshMarket, ROUTER_V4);
        assertEq(uint256(ovFee), 0, "unexpected fee override on fresh market");

        // seed via addLiquidityDualSyAndPt (pattern from OpenPendleFork.t.sol)
        underlying.mint(address(this), 1_000_000e18);
        underlying.approve(ROUTER_V4, type(uint256).max);
        uint256 netSy = router.mintSyFromToken(address(this), address(mockSy), 0, tokenInput(address(underlying), 2000e18));
        require(netSy == 2000e18, "mintSyFromToken");
        mockSy.approve(ROUTER_V4, type(uint256).max);
        uint256 netPy = router.mintPyFromSy(address(this), freshYt, 800e18, 0);
        require(netPy == 800e18, "mintPyFromSy");
        IERC20Min(freshPt).approve(ROUTER_V4, type(uint256).max);
        (uint256 seedLp,,) = router.addLiquidityDualSyAndPt(address(this), freshMarket, 1200e18, 800e18, 0);
        require(seedLp > 0, "seed failed");
    }

    function test_parity_freshCommunityMarket() external {
        createFreshMarket();
        console2.log("=== PARITY (b): FRESH community market (no fee override)", freshMarket, "===");
        logFeeContext(freshMarket);

        // fund + approve user (pool: 1200 SY / 800 PT)
        underlying.mint(user, 100e18);
        vm.startPrank(user);
        underlying.approve(address(mockSy), type(uint256).max);
        underlying.approve(ROUTER_V4, type(uint256).max);
        QPMockSY(mockSy).deposit(user, address(underlying), 50e18, 0);
        mockSy.approve(ROUTER_V4, type(uint256).max);
        vm.stopPrank();

        runSyForPt(freshMarket, 5e18); //     ~0.4% of pool SY
        runTokenForPt(freshMarket, address(underlying), 5e18);
        runSyForYt(freshMarket, 2e18);

        // optional YT token-direction quote (selector exists but is finicky; finding, not assertion)
        try rstatic.swapExactTokenForYtStatic(freshMarket, address(underlying), 2e18) returns (
            uint256 q, uint256, uint256, uint256, uint256
        ) {
            console2.log("  swapExactTokenForYtStatic quote:", q);
        } catch {
            console2.log("  swapExactTokenForYtStatic: REVERTED on fresh market");
        }
    }
}
