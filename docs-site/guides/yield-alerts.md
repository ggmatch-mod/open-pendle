# Yield alerts

**Yield alerts** is a wallet-free page showing the largest exact 24-hour changes in implied APY across liquid, active Pendle-listed PT markets on OpenPendle's supported networks.

It is a dashboard, not a notification subscription. It does not create positions, save alert preferences, or send browser, email, Telegram, or X messages.

## Market coverage

Candidates come from active markets in Pendle's public API. A market is excluded when it is inactive, outside OpenPendle's supported networks, absent from Pendle's active catalog, or missing the required history.

Coverage is therefore narrower than [Explore](/guides/exploring-markets), which starts from factory events and also includes community markets.

## Exact 24-hour comparison

OpenPendle compares 25 UTC-aligned hourly observations: both endpoints of one complete 24-hour interval. The window advances 15 minutes after each UTC hour to give the latest bucket time to arrive.

A history is rejected if an endpoint or intermediate hour is missing, duplicated, or malformed.

The page reports:

- the APY change in basis points; and
- the same change relative to the starting implied APY, when that value is positive.

## $1 million liquidity gate

A market qualifies only when Pendle AMM pool liquidity is at least **$1 million** both now and at every hourly observation in the window.

This uses the per-market historical `tvl` field as pool liquidity, not Pendle's broader `totalTvl`. A single hourly dip below the threshold excludes the market for that window.

## Significant moves

A move is labelled significant only when both conditions hold:

- absolute change is at least **50 basis points**; and
- absolute relative change is at least **10%** of starting implied APY.

Markets within 72 hours of maturity can appear under **All qualified**, but they are not labelled significant because near-expiry APY can move sharply.

Use the page controls to filter by network, direction, and significance, and to sort by move or liquidity.

## Refresh and partial coverage

The browser loads Pendle's active catalog and eligible market histories directly, then refreshes when the next buffered hourly window becomes available. You can also refresh manually.

If some histories fail, valid markets remain visible with a partial-coverage warning. If candidates exist but none can be validated, the page reports that alerts are temporarily unavailable instead of presenting an empty result as complete.

Pendle can observe these API requests and ordinary request metadata. See [How OpenPendle works](/reference/architecture) for the current data-flow disclosure.

## See also

- [Exploring markets](/guides/exploring-markets)
- [Buying PT](/guides/buying-pt)
- [How OpenPendle works](/reference/architecture)
- [Risks & disclosures](/reference/risks)
