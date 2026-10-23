// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IShiftV1TvlFeed} from "../../src/ShiftReceiptOracle.sol";

contract MockAccountingAsset is ERC20 {
    uint8 private immutable decimalPlaces;
    constructor(uint8 decimals_) ERC20("Mock asset", "MOCK") { decimalPlaces = decimals_; }
    function decimals() public view override returns (uint8) { return decimalPlaces; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockTvlFeed {
    uint8 public decimals;
    IShiftV1TvlFeed.TvlData private sample;
    constructor(uint8 decimals_) { decimals = decimals_; }
    function setDecimals(uint8 decimals_) external { decimals = decimals_; }
    function setSample(uint256 value, uint256 timestamp, uint256 supply) external {
        sample = IShiftV1TvlFeed.TvlData(value, timestamp, supply);
    }
    function getLastTvl() external view returns (IShiftV1TvlFeed.TvlData memory) { return sample; }
}

contract MockShiftV1 is ERC20 {
    address public baseToken;
    address public tvlFeed;
    uint256 public getSharePrice = 1_050_000;
    uint8 private decimalPlaces = 18;
    uint16 public feeBps;
    constructor(address asset_, address feed_) ERC20("Shift V1 receipt", "extUSD") { baseToken = asset_; tvlFeed = feed_; }
    function decimals() public view override returns (uint8) { return decimalPlaces; }
    function setDecimals(uint8 value) external { decimalPlaces = value; }
    function setPrice(uint256 value) external { getSharePrice = value; }
    function setFeed(address value) external { tvlFeed = value; }
    function setAsset(address value) external { baseToken = value; }
    function setFee(uint16 value) external { feeBps = value; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function slash(address from, uint256 amount) external { _burn(from, amount); }
    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = amount * feeBps / 10_000;
        super._transfer(from, to, amount - fee);
        if (fee != 0) _burn(from, fee);
    }
}

contract MockSyShare is ERC20 {
    address public vault;
    constructor() ERC20("Shift V2 share", "syUSDC") {}
    function setVault(address value) external { vault = value; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockSyVault {
    address public share;
    address public asset;
    uint256 public latestSharePrice = 1_050_000;
    uint256 public conversionScale = 1e18;
    constructor(address receipt_, address asset_) { share = receipt_; asset = asset_; }
    function setPrice(uint256 value) external { latestSharePrice = value; }
    function setShare(address value) external { share = value; }
    function setAsset(address value) external { asset = value; }
    function setConversionScale(uint256 value) external { conversionScale = value; }
    function convertToAssets(uint256 amount) external view returns (uint256) { return amount * latestSharePrice / conversionScale; }
}
