// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {ShiftReceiptOracle} from "./ShiftReceiptOracle.sol";
import {ShiftOracleSY} from "./ShiftOracleSY.sol";

/// @notice One creation transaction deploys a bound oracle/SY pair atomically.
/// @dev No registered Pendle factory template, proxy admin, or predeployed
///      OpenPendle infrastructure is required. This contract retains no powers.
contract OracleSyBootstrap {
    error InvalidOwnerOrMetadata();

    address public immutable sy;
    address public immutable oracle;

    event OracleSyDeployed(address indexed sy, address indexed oracle, uint8 sourceKind, address receipt, address accountingAsset);

    constructor(
        uint8 sourceKind,
        address receipt,
        address source,
        address accountingAsset,
        uint32 maxAge,
        address reporter,
        string memory name,
        string memory symbol,
        address syOwner
    ) {
        if (syOwner == address(0) || bytes(name).length == 0 || bytes(symbol).length == 0) revert InvalidOwnerOrMetadata();
        ShiftReceiptOracle deployedOracle = new ShiftReceiptOracle(sourceKind, receipt, source, accountingAsset, maxAge, reporter);
        ShiftOracleSY deployedSy = new ShiftOracleSY(name, symbol, receipt, address(deployedOracle));
        deployedSy.transferOwnership(syOwner, true, false);
        sy = address(deployedSy);
        oracle = address(deployedOracle);
        emit OracleSyDeployed(sy, oracle, sourceKind, receipt, accountingAsset);
    }
}
