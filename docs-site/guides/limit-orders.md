# PT limit orders

PT limit orders let you express a target fixed yield on an individual market page instead of accepting the AMM's current quote. OpenPendle's first version supports **PT ↔ SY only**: buying PT with that market's SY, or selling PT back for SY.

The order is an EIP-712 message signed by your wallet and published to **Pendle's hosted off-chain order API**. It is not an OpenPendle order book, and OpenPendle does not relay or custody the order.

## Availability is checked live

Limit orders do not automatically work on every market OpenPendle can load, or even every market labelled as officially listed. When you open a market, OpenPendle asks Pendle's support endpoint whether the exact chain, market, YT, SY, and order direction are supported.

This live support response is the authority. An official listing is therefore **not sufficient**: limit orders are available only for the subset for which Pendle's order API returns a matching support configuration and the on-chain fee root agrees. A clear unsupported state means Pendle does not support that market or direction; an unavailable state means the check failed and OpenPendle will not guess.

The first version is also **EOA-only**. Smart-contract wallets are disabled until ERC-1271 signing and validation are explicitly supported and tested.

## Buying and selling

- **Buy PT:** you offer SY and specify the fixed yield at which you are willing to receive PT.
- **Sell PT:** you offer PT and specify the fixed yield at which you are willing to receive SY.

The order includes an amount, target implied APY, and expiry. Its expiry must be in the future and strictly before the Pendle market matures. Takers may fill it completely, fill it partially over time, or never fill it at all.

A target APY is a condition, not a guarantee of execution. Other makers, available liquidity, market movement, fees, your balance and allowance, and the remaining time before expiry all affect whether a taker can fill the order.

## Signing and placement

Before asking for a signature, OpenPendle checks the live market context, Pendle's support response, the Limit Router fee root, your current order nonce, balance, and allowance. It validates the generated order against the exact values you entered, including its chain, market-linked YT and SY, direction, maker and receiver, amount, APY, nonce, and expiry.

The typed-data domain is also fixed and checked:

- name: `Pendle Limit Order Protocol`
- version: `1`
- chain ID: the market's active network
- verifying contract: Pendle's Limit Router at `0x000000000000c9B3E2C3Ec88B1B4c0cD853f4321`

OpenPendle computes the order hash locally, compares the domain and order hash with the Limit Router, recovers the EOA signer, and calls the router's signature check before submitting the signed payload. A mismatch blocks placement.

Signing and publishing the order itself is **gasless**. If your offered token does not already have enough allowance for the Limit Router, the approval is a normal on-chain transaction and costs gas. OpenPendle uses its normal exact-amount approval default; an unlimited allowance remains an explicit opt-in.

## Funds are not reserved

Publishing an order does **not** escrow, lock, or reserve your tokens. They remain in your wallet, and you can move or spend them. That also means:

- you can create orders whose combined amounts exceed your available balance;
- an order can become unfillable if your balance or Limit Router allowance falls below what remains; and
- restoring the balance or allowance may make a still-active order fillable again.

Treat every active order as a standing authorization that may execute when its conditions are met. Do not rely on the interface to reserve funds for it.

## Partial fills, expiry, and cancellation

Pendle's API reports the order's remaining amount and status. An order can be open, partially filled, fully filled, expired, cancelled, or temporarily unfillable because of balance or transfer conditions.

Cancellation is an **on-chain** Limit Router transaction and therefore costs gas. It can also race a fill: until the cancellation is mined and reflected on-chain, a taker may still fill some or all of the order. Review the final on-chain state after cancellation rather than assuming the click reserved the outcome.

An expired order cannot be newly filled, but expiry does not undo fills that already occurred.

## Fees and costs

OpenPendle adds no fee. Pendle's limit-order protocol exposes a **mutable annualized fee parameter** through its support configuration and Limit Router. The actual fee on a fill depends on the order direction and the time remaining until market maturity, and it declines toward maturity. This fee path is separate from the Pendle AMM's swap fee, so an AMM quote and a limit-order target should not be compared as though they share one fee path.

You may also pay network gas for:

- approving SY or PT for the Limit Router; and
- cancelling an order on-chain.

Order signing and API placement do not themselves submit a transaction. A fill is executed later through Pendle's Limit Router by the party taking or settling the order.

## What Pendle's API receives

Using the order feature makes direct requests from your browser to Pendle's API. Depending on the action, Pendle receives or can observe:

- the chain, market, YT, SY/token, and requested order direction;
- your maker address, amount, target APY, expiry, nonce, and signed order when you place it;
- your maker address and market-linked YT when the interface retrieves your orders; and
- ordinary request metadata, including your IP address and request timing.

The signature is intended for Pendle's Limit Router domain and exact order fields, but it is still public order data once submitted. OpenPendle does not operate an account database or copy the order into its own backend.

## Important limitations

::: warning Off-chain availability is a dependency
The contracts may be live while Pendle's hosted support, generation, book, or order endpoints are unavailable or changed. In that case OpenPendle blocks new placement rather than signing against an unverified response. Existing signed orders and on-chain fills or cancellations remain governed by Pendle's Limit Router.
:::

::: danger A limit order does not make a market safe
Support from Pendle's order API says nothing about the solvency of the underlying asset or the safety of the SY. OpenPendle's provenance and signature checks protect order mechanics; they do not endorse the market. Read [Risks & disclosures](/reference/risks) before signing.
:::

## See also

- [Buying PT](/guides/buying-pt) — immediate AMM execution and fixed-yield basics.
- [Networks & contracts](/reference/networks-and-contracts) — the Limit Router address and network model.
- [How OpenPendle works](/reference/architecture) — the off-chain order data flow.
- [Risks & disclosures](/reference/risks) — order, fee, allowance, and API risks.
