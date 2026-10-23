// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {SYBase} from "../vendor/contracts/core/StandardizedYield/SYBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ShiftReceiptOracle} from "./ShiftReceiptOracle.sol";

/// @notice Immutable Pendle SY: holds/returns Shift receipts, values them in the vault asset.
/// @dev Uses pinned Pendle SYBase (see vendor/PROVENANCE.md). This extension is
///      new OpenPendle code and makes no inherited audit or security claim.
contract ShiftOracleSY is SYBase {
    error InvalidOracle();
    error UnsupportedTransfer();

    address public immutable exchangeRateOracle;
    address public immutable underlyingAsset;
    uint8 private immutable accountingDecimals;

    constructor(string memory name_, string memory symbol_, address receipt_, address oracle_)
        SYBase(name_, symbol_, receipt_)
    {
        ShiftReceiptOracle oracle = ShiftReceiptOracle(oracle_);
        if (oracle.receipt() != receipt_) revert InvalidOracle();
        exchangeRateOracle = oracle_;
        underlyingAsset = oracle.accountingAsset();
        accountingDecimals = oracle.accountingDecimals();
    }

    function exchangeRate() external view override returns (uint256) {
        return ShiftReceiptOracle(exchangeRateOracle).getExchangeRate();
    }

    function assetInfo() external view returns (AssetType, address, uint8) {
        return (AssetType.TOKEN, underlyingAsset, accountingDecimals);
    }

    function _transferIn(address token, address from, uint256 amount) internal override {
        if (msg.value != 0) revert UnsupportedTransfer();
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        super._transferIn(token, from, amount);
        if (IERC20(token).balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedTransfer();
    }

    function _deposit(address, uint256 amount) internal view override returns (uint256) {
        if (IERC20(yieldToken).balanceOf(address(this)) < totalSupply() + amount) revert UnsupportedTransfer();
        return amount;
    }

    function _redeem(address receiver, address, uint256 amount) internal override returns (uint256) {
        uint256 beforeSelf = IERC20(yieldToken).balanceOf(address(this));
        uint256 beforeReceiver = IERC20(yieldToken).balanceOf(receiver);
        _transferOut(yieldToken, receiver, amount);
        if (IERC20(yieldToken).balanceOf(address(this)) + amount != beforeSelf || IERC20(yieldToken).balanceOf(receiver) != beforeReceiver + amount) {
            revert UnsupportedTransfer();
        }
        return amount;
    }

    function _previewDeposit(address, uint256 amount) internal pure override returns (uint256) { return amount; }
    function _previewRedeem(address, uint256 amount) internal pure override returns (uint256) { return amount; }
    function getTokensIn() public view override returns (address[] memory tokens) { return _receiptOnly(); }
    function getTokensOut() public view override returns (address[] memory tokens) { return _receiptOnly(); }
    function isValidTokenIn(address token) public view override returns (bool) { return token == yieldToken; }
    function isValidTokenOut(address token) public view override returns (bool) { return token == yieldToken; }

    function _receiptOnly() private view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = yieldToken;
    }
}
