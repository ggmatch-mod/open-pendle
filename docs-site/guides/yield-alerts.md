# Yield alerts

The **Yield alerts** page is a read-only view of the largest 24-hour changes in Pendle PT fixed yield. It is designed to answer a narrow question: *which liquid, active PT markets have had a meaningful change in implied APY since the same UTC hour yesterday?*

No wallet is needed. The page does not create a position, send a transaction, subscribe you to notifications, or store an alert preference.

## Which markets are included

The page starts from **active markets returned by Pendle's public API** and keeps only markets on OpenPendle's [six supported networks](/reference/networks-and-contracts). This means its coverage is intentionally narrower than Explore:

- a factory-valid community market that is not in Pendle's active API catalog does **not** appear;
- an expired or inactive market does not appear; and
- a market on an unsupported network does not appear.

Being included is not an endorsement. It only means the market is active, API-listed, on a supported network, and passes the data and liquidity checks below.

## The exact 24-hour window

OpenPendle compares two exact, UTC-aligned hourly observations: the beginning and end of a 24-hour interval. A valid history contains **25 points**—one for each hourly boundary, including both endpoints.

The window advances 15 minutes after each UTC hour. That buffer gives Pendle's newest hourly data time to arrive; it prevents a just-opened or missing bucket from being treated as a complete hour. OpenPendle rejects a history if it has the wrong endpoints, a missing or duplicate hour, or anything other than the complete 25-point series.

The move is calculated as:

- **basis-point change:** ending implied APY minus starting implied APY, multiplied by 10,000; and
- **relative change:** the same APY difference divided by the starting implied APY.

The page shows both increases and decreases and lets you filter and sort the qualified results.

## The $1 million liquidity gate

A market qualifies only when its **Pendle AMM pool liquidity** is at least **$1 million now and at every one of the 25 hourly observations**. OpenPendle first uses current liquidity as a prefilter, then checks the minimum across the full history.

This gate uses Pendle's per-market `tvl` history field as **AMM pool liquidity**. It does not substitute the protocol's broader `totalTvl` figure. A market that dips below $1 million at even one hourly point is excluded from the page for that window.

## What “significant” means

A move is marked significant only when **both** of these are true:

- its absolute change is at least **50 basis points**; and
- its absolute relative change is at least **10%** of the starting implied APY.

Markets with **72 hours or less until maturity** are excluded from the significant set because fixed-yield figures can move sharply near expiry. A near-maturity market may still appear when viewing all qualified movers; it simply is not labelled significant.

The two thresholds are joined by **and**, not “or.” For example, a 60-basis-point move from a very high starting APY may still fall below the 10% relative threshold. A non-positive starting APY cannot satisfy the relative-change test.

## Refreshes and incomplete coverage

The browser refreshes the dataset after the next buffered UTC-hour boundary, when the next complete window should be available. You can also refresh it manually.

Each qualified candidate needs its own history request. If one or more histories fail validation or cannot be fetched, OpenPendle keeps the valid markets visible and shows a **partial coverage** warning. If candidates exist but none of their histories can be validated, the page reports that yield alerts are temporarily unavailable rather than presenting an empty result as complete.

## Current delivery model

Yield alerts currently run entirely in your browser. The browser downloads Pendle's active-market catalog and fans out bounded requests for the candidate histories; OpenPendle operates no alert database or notification service. Pendle's API and the normal network path can observe those requests and ordinary request metadata such as your IP address.

This direct approach is simple and verifiable, but it repeats the same history work in every visitor's browser. If traffic grows, production should place a small, auditable cache or scheduled aggregation job in front of these public data calls. That would improve rate-limit resilience and load time, but it would also introduce a new OpenPendle-operated data component whose freshness, failure behavior, and privacy boundary would need to be documented explicitly.

## No notifications yet

The first version is a page, not a delivery service. It does **not** send browser push notifications, email, Telegram messages, or X posts. Those channels can be added later without changing how a significant move is calculated, but each would introduce its own account, delivery, rate-limit, and privacy considerations.

## See also

- [Exploring markets](/guides/exploring-markets) — the broader factory-indexed market directory.
- [Buying PT](/guides/buying-pt) — how fixed yield and PT purchases work.
- [How OpenPendle works](/reference/architecture) — data flow and outbound-request disclosure.
- [Risks & disclosures](/reference/risks) — what API-listed and liquid do not guarantee.
