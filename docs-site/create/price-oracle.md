# Initializing the price oracle

A new Pendle market can trade immediately, but it begins with a small observation buffer. Increase that buffer only when an external protocol needs a time-weighted price.

## Spot quotes versus TWAP

| | Spot quote | Pendle TWAP |
| --- | --- | --- |
| Source | Current market state | Stored market observations read through `PendlePYLpOracle` |
| Used by OpenPendle trading/LP UI | Yes | No |
| Available immediately | Yes | A useful window needs more observations and elapsed activity |
| Typical consumer | Trader or LP interface | Lending market, oracle integration, or external analytics |

The shared Pendle oracle address is:

`0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2`

## Cardinality

A fresh market starts with observation cardinality 1. That is enough for current-state operation but not a meaningful multi-point TWAP window.

The market exposes:

```
increaseObservationsCardinalityNext(uint16 cardinalityNext)
```

The call raises the target observation capacity; it does not populate historical data retroactively. New observations accumulate as market activity occurs. A larger buffer therefore needs both storage capacity and enough time-spread observations before a requested window becomes usable.

Properties to remember:

- anyone can raise the target; it is not restricted to the deployer;
- the target can be raised again later if a consumer needs more capacity;
- asking for no increase has no useful effect; and
- sizing depends on the downstream consumer's TWAP duration and requirements.

Follow the consuming protocol's documented cardinality and duration rather than choosing an arbitrary large value.

## Do you need it?

| Goal | Increase now? |
| --- | --- |
| Trade, quote, mint/redeem, or add/remove liquidity in OpenPendle | No |
| Explore a newly deployed pool | No |
| Integrate a lending market or feed that requires Pendle TWAP | Follow that integration's requirement |

Leaving cardinality at 1 does not prevent normal Pendle market operation. It does mean an external consumer that requires a multi-observation TWAP will not have the history it needs.

## How to raise it today

OpenPendle currently explains this step but does not send the oracle transaction.

1. Open the new `PendleMarket` address on the correct chain's block explorer.
2. Verify the address and chain.
3. Connect any wallet with enough gas.
4. Call `increaseObservationsCardinalityNext` with the value required by the external consumer.

Because the call is made through the explorer, OpenPendle's provenance and simulate-before-sign flow is not involved. Use the explorer's simulation if available and verify the transaction request in the wallet.

::: warning Oracle capacity is not a safety review
More observations can make a TWAP available; they do not make the asset, SY, liquidity, or price manipulation risk safe. A thin or inactive market can still be unsuitable for collateral use.
:::

Return to [Deploying the market](/create/deploying-a-market), or read [Risks & disclosures](/reference/risks) before integrating the price elsewhere.
