# Vendored dependency provenance

- `contracts/**`: Pendle Finance `Pendle-SY-Public`, commit `73676d931102a369a978a713abfd0b48e3e34361` (2026-02-07), the transitive dependency closure of `SYBase.sol`.
- `@openzeppelin/contracts/**`: OpenZeppelin Contracts tag `v4.9.3`.
- `@openzeppelin/contracts-upgradeable/**`: OpenZeppelin Contracts Upgradeable tag `v4.9.3`.
- Original SPDX headers are preserved. Pendle dependencies are GPL-3.0-or-later; the full GPL text is at the repository root `LICENSE`. OpenZeppelin MIT terms are preserved in `OPENZEPPELIN-LICENSE` and in source headers.

The only change to the vendored sources is adding `virtual` to `TokenHelper._transferIn`. `ShiftOracleSY` overrides that hook to enforce exact incoming transfer deltas, rejecting fee-on-transfer receipts. No storage layout or standard SY ABI is changed.

The deployed SY is a new, immutable OpenPendle extension of Pendle SYBase. It is **not** the upstream proxy-based `PendleERC20WithOracleSY`, has no upgrade administrator, and does not inherit any audit claim from Pendle or OpenZeppelin. The code does not implement token rewards or off-chain points attribution.

Sources: https://github.com/pendle-finance/Pendle-SY-Public/tree/73676d931102a369a978a713abfd0b48e3e34361 ; https://github.com/OpenZeppelin/openzeppelin-contracts/tree/v4.9.3 ; https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable/tree/v4.9.3 .
