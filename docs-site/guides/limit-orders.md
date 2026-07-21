# PT limit orders

PT limit orders let you target an implied APY instead of taking the AMM's current quote. OpenPendle supports **PT ↔ SY** orders on an individual market page.

The wallet signs an EIP-712 order for Pendle's Limit Router, and the browser publishes it to Pendle's hosted order API. OpenPendle does not run the order book, relay fills, or custody funds.

## Availability

Availability is checked live for the exact chain, market, YT, SY, and direction. A Pendle listing alone is not enough: placement is enabled only when Pendle's support response matches the market and its fee root agrees with the on-chain Limit Router.

An unsupported result means the exact order is not available. If the support check fails, OpenPendle reports it as unavailable and does not guess.

The current integration is EOA-only. Smart-contract-wallet signing remains disabled until ERC-1271 support is implemented and tested.

## Buy or sell

- **Buy PT:** offer the market's SY and choose the APY at which you want PT.
- **Sell PT:** offer PT and choose the APY at which you want SY.

Enter the amount, target APY, and expiry. Expiry must be in the future and before market maturity. An order can fill fully, partially, or not at all.

## Place an order

Before signing, OpenPendle checks the market context, support response, fee root, nonce, balance, allowance, and generated order fields. It verifies the EIP-712 domain, locally derived hash, signer, and the router's signature check before publication.

1. Choose Buy PT or Sell PT in the market's limit-order panel.
2. Enter amount, target APY, and expiry.
3. Approve the offered token if the Limit Router lacks sufficient allowance.
4. Review the generated order details.
5. Sign the EIP-712 message.
6. Wait for publication confirmation and verify it appears in your orders.

Signing and API placement are gasless. Approval is an on-chain transaction and costs gas. Exact approval is the default; Unlimited is an explicit higher-exposure option.

## Funds are not reserved

Publication does not escrow or reserve tokens. An active order may become unfillable if the balance or allowance falls below its remaining amount, and it may become fillable again if they are restored.

Treat every active order as a standing executable authorization. Combined open orders can exceed the wallet's balance because the interface does not reserve funds between them.

## Fills, expiry, and cancellation

Pendle reports remaining amount and status. Orders may be open, partially filled, filled, expired, cancelled, or temporarily unfillable.

Cancellation is an on-chain Limit Router transaction and costs gas. It can race a fill until mined, so check the final on-chain/order state rather than assuming the click cancelled immediately. Expiry prevents new fills but does not undo earlier ones.

## Fees and dependencies

OpenPendle adds no fee. Pendle's limit-order path has its own mutable fee configuration, separate from AMM swap fees. Network gas can apply to approvals and cancellation; signing and placement do not submit a transaction.

Pendle's hosted support, generation, book, placement, and maker-order endpoints are operational dependencies. If they are unavailable or their response fails validation, OpenPendle blocks new placement. Existing signed orders and on-chain cancellation remain governed by the Limit Router.

Using the feature sends Pendle the market/order context and, for maker-specific actions, the wallet address and signed payload required to place or retrieve orders. See [How OpenPendle works](/reference/architecture) for the data-flow disclosure.

::: warning Order support is not market endorsement
Pendle's order service and OpenPendle's signature checks validate order mechanics, not the underlying asset or SY.
:::

## See also

- [Buying PT](/guides/buying-pt)
- [Networks & contracts](/reference/networks-and-contracts)
- [How OpenPendle works](/reference/architecture)
- [Risks & disclosures](/reference/risks)
