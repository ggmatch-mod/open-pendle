# Glossary

A concise reference to the terms used in OpenPendle. For a guided introduction, read [How Pendle works](/concepts/how-pendle-works).

## A

**Accounting asset.** The unit in which an SY measures principal. One PT redeems at maturity for one unit of the accounting asset, often delivered as an amount of the yield-bearing token through the SY. It is not necessarily one raw underlying token.

**Active network.** The chain OpenPendle reads and sends transactions on. It is stored locally and can differ from the wallet's current chain until the wallet switches.

**Adapter.** A contract that teaches an adapter-based SY how to interact with a particular yield source. It is a separate trust surface from the SY shell.

**Add / remove liquidity.** Deposit PT and SY into a market for LP tokens, or burn LP tokens for a pro-rata share of the current reserves. Adding ends at maturity; removal remains available afterward.

**AIM (Algorithmic Incentive Model).** Pendle's current system for allocating PENDLE emissions to eligible, whitelisted markets using live performance and other inputs. See Pendle's [Incentives](https://docs.pendle.finance/pendle-v2/ProtocolMechanics/Mechanisms/Incentives).

**AMM.** The automated market maker inside a `PendleMarket`, holding PT and SY reserves for one maturity.

**APY, fixed / implied.** The annualized return implied by PT's current discount to its accounting-asset value at maturity. A PT buyer locks the execution-time rate only if they hold to maturity and redemption succeeds.

**Approval / allowance.** Permission an ERC-20 holder gives a spender contract to move tokens. OpenPendle defaults to the current action amount; Unlimited leaves a standing maximum allowance until changed or revoked.

## C

**Capital multiple.** In Mint Mode, the total loan-token capital converted into PT+YT divided by the user's equity. Guaranteed PT, debt, and live Morpho state determine actual LTV and liquidation distance.

**Cardinality.** The number of observations a market's TWAP oracle can retain. A new market needs an initial increase before external integrations can use longer TWAP windows, and capacity can be raised again later. Normal OpenPendle quotes and trades do not require it.

**Community market.** OpenPendle's label for a recognized factory-created market absent from Pendle's current catalog. It is not an endorsement, review result, or durable incentive classification.

**Content-Security-Policy (CSP).** The browser policy restricting scripts and connections that the hosted OpenPendle build may use. See [Architecture](/reference/architecture).

## E

**EIP-5115.** The Standardized Yield interface used by SY contracts for deposits, redemptions, exchange rates, and rewards.

**EIP-6963.** A standard for discovering injected browser-wallet providers. OpenPendle uses injected providers and does not use WalletConnect.

**EIP-712.** Structured, domain-separated signing. Pendle limit orders use it to bind a signature to the chain, Limit Router, and exact order fields.

**Expiry / maturity.** The fixed timestamp when PT becomes redeemable at par in accounting-asset terms, YT loses future-yield value, and market swaps and new liquidity stop.

## F

**Factory.** A Pendle contract that deploys markets or PT/YT yield contracts. OpenPendle's provenance gate checks a chain-specific lineage bundled with the release; Protocol Status separately displays the deployment helper's live wiring.

**Fixed yield.** The accounting-asset return from buying PT below par and holding it to maturity. It removes variable-yield-rate exposure, not asset, SY, liquidity, or smart-contract risk.

## H

**Hash routing.** Client-side routing that places the app route after `#`, allowing a domain-root static deployment to serve every route without server rewrites. IPFS subpath deployments may also require an appropriate build base.

## I

**Implied APY.** See **APY, fixed / implied**.

**Impermanent loss (IL).** The difference between an LP position and holding the deposited assets outside the AMM, caused by reserve rebalancing as prices move.

**Injected wallet.** A wallet that exposes a provider directly to the web page, such as a browser extension or a wallet's mobile dApp browser.

## L

**Limit order.** An off-chain, signed PT ↔ SY order at a target implied APY, published to Pendle's hosted API for possible later fill. It does not reserve funds and may fill partially or not at all.

**Limit Router.** Pendle's contract for validating, filling, and cancelling limit orders. It is separate from Router V4, which handles immediate AMM actions.

**Long yield.** Exposure that benefits when realized yield and rewards exceed what was priced into YT, after fees and costs.

**Leverage.** Total position exposure divided by the user's net equity. In OpenPendle's Looping model, it estimates repeated PT collateral and borrowing. Exact reviewed markets can execute only after the current release and safety gates pass.

**Liquidation buffer.** The distance between a modeled borrow position and its liquidation threshold. It is sensitive to collateral price, debt growth, oracle behavior, and market-specific LLTV.

**LLTV.** Morpho's liquidation loan-to-value limit for a market. Crossing it makes a position eligible for liquidation; it is not a recommended operating target.

**LP / LP token.** A pro-rata claim on a market's current PT and SY reserves. Returns can include PT accretion, SY yield and rewards, swap fees, PENDLE when eligible, and supported external incentives.

**Looping candidate.** A Pendle PT and Morpho market joined by exact collateral-token identity and chain. A candidate can appear in the comparison directory without belonging to the reviewed execution registry or live entry allowlist.

## M

**Market / pool.** A `PendleMarket` contract holding the PT/SY AMM for one maturity.

**Market Mode.** A looping acquisition path that buys PT with the user's capital and borrowed capital, then supplies the acquired PT as Morpho collateral.

**Morpho market.** An immutable lending-market tuple defining loan token, collateral token, oracle, interest-rate model, and LLTV. Two markets using similar symbols are not interchangeable unless the tuple matches.

**Merkl.** An external reward-distribution service. OpenPendle supports eligible Merkl claims on Positions; this does not mean every market has a campaign or that Merkl is the only possible external reward mechanism.

**Mint PT and YT.** Convert SY value at the current index into equal quantities of PT and YT before maturity. One raw SY token does not necessarily equal one PT plus one YT.

**Mint Mode.** A full-mint looping path that, on entry, mints PT+YT from both the user's capital and borrowed capital. A Mint increase mints only its new borrowed leg. Only guaranteed PT supports the Morpho loan; YT is sent to the wallet, and Mint risk increases have a separate release plane.

**Multicall3.** A helper contract used to batch several on-chain reads into one RPC request.

## O

**Oracle initialization.** The initial increase to a fresh market's observation cardinality so external protocols can consume a longer TWAP. Capacity may be increased again later; it is separate from market creation and ordinary trading.

## P

**Par.** One accounting-asset unit per PT at maturity, assuming the SY and underlying system settle correctly.

**PendleCommonPoolDeployHelperV2.** Pendle's helper for deploying and seeding a market, optionally alongside a supported SY creation flow.

**PendleCommonSYFactory.** Pendle's factory for registered permissionless SY templates. Factory deployment does not itself prove an input asset is compatible or safe.

**PendleMarket.** See **market / pool**.

**PendlePYLpOracle.** Pendle's TWAP oracle for PT, YT, and LP values. OpenPendle's headline implied APY is instead derived from current market state.

**Provenance gate.** OpenPendle's check that a market came from a recognized Pendle factory. It validates origin, not the asset or SY.

**Price impact.** The change in execution price caused by the requested trade consuming available liquidity. It is distinct from slippage tolerance, which bounds acceptable movement or quote deterioration.

**PT (Principal Token).** The principal claim in a Pendle split. At maturity, one PT redeems for one unit of the accounting asset through the supported settlement path.

## R

**Redeem PT + YT.** Recombine equal PT and YT quantities into SY before maturity.

**Redeem matured PT.** Settle PT for its accounting-asset value at or after maturity, normally through an accepted SY output token.

**Router V4.** Pendle's router for immediate swaps, mint/redeem, liquidity, and settlement actions used by OpenPendle.

**RouterStatic.** Pendle's read-only quote and position-math helper. OpenPendle bundles its chain-specific address in the supported-network configuration.

**RPC.** The endpoint OpenPendle uses for reads, simulations, and receipt polling. The injected wallet provider broadcasts signed transactions. OpenPendle supplies public read fallbacks and supports a browser-local override.

## S

**Saved pools.** A browser-local registry of markets the user chose to remember. It can be exported, imported, or shared; OpenPendle does not keep an account copy.

**Seed / seed token.** The initial liquidity and accepted SY input token used when deploying a market.

**Simulate before sign.** Run the prepared transaction against current chain state before requesting a wallet signature. Success predicts the call under that state but cannot guarantee later inclusion or execution.

**Slippage tolerance.** The user's allowed deviation between quoted and minimum accepted output. A wider setting reduces quote-expiry reverts but permits worse execution.

**sPENDLE.** Pendle's current staking and governance system, replacing legacy vePENDLE over a transition period. See Pendle's [sPENDLE documentation](https://docs.pendle.finance/pendle-v2/ProtocolMechanics/Mechanisms/sPENDLE).

**Swap.** An immediate PT or YT trade routed through Pendle's AMM. A limit order is a separate signed-order path.

**SY (Standardized Yield).** The EIP-5115 wrapper over a yield-bearing source. It reports its accounting asset, exchange rate, accepted inputs/outputs, and rewards.

## T

**Template, SY.** A registered SY implementation exposed by PendleCommonSYFactory. Templates differ in asset type, deposit/redeem support, adapter use, ownership, and upgradeability.

**Treasury.** The Pendle-controlled recipient of protocol fees. It is unrelated to OpenPendle, which adds no fee of its own.

**TVL / liquidity.** TVL estimates total value associated with a market; executable liquidity is the depth available for a particular action. A high TVL does not by itself guarantee a low-impact trade or available Morpho borrowing.

**TWAP oracle.** A time-weighted price source used by external integrations to reduce reliance on a single spot state.

## U

**Underlying / yield-bearing token.** The token the SY holds or manages. It can differ from the **accounting asset** against which the SY exchange rate and PT principal are measured.

## W

**WebAssembly (WASM).** A compiled-code format used by browser cryptography. OpenPendle's CSP permits the required WASM execution while blocking JavaScript `eval()`.

**Wrapped native.** The ERC-20 representation of a chain's native coin, such as WETH. It is distinct from the native coin used as transaction value.

## Y

**Yield alert.** A read-only 24-hour PT implied-APY move that passes OpenPendle's history, liquidity, and maturity filters. It is not a push-notification subscription.

**Yield contract.** The Pendle contract that mints and redeems one PT/YT pair from an SY for one maturity.

**YT (Yield Token).** The pre-maturity claim on yield and rewards associated with the tokenized principal, net of Pendle's protocol fees. It has no future-yield value at maturity, though accrued amounts can remain claimable.

::: warning Provenance is not endorsement
Community markets require independent review of the asset, SY, and exit path. See [Community pools](/concepts/community-pools) and [Risks & disclosures](/reference/risks).
:::
