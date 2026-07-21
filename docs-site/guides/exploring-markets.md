# Exploring markets

**Explore** is OpenPendle's searchable market directory. It works without a wallet and complements the address loader on the home page.

::: warning Discovery is not endorsement
A factory record or Pendle listing does not make an asset, SY, yield, or market safe. Review the market's trust panel before transacting.
:::

## What Explore contains

Inventory starts from `CreateNewMarket` events emitted by recognized Pendle factories on OpenPendle's six supported networks. A scheduled index job publishes those events as a static snapshot.

Pendle's public market API is then used for optional metadata such as names, icons, TVL, implied APY, and listing status. This produces four useful labels:

| Label | Meaning |
| --- | --- |
| **Factory-indexed** | A recognized factory emitted the market event on that chain. |
| **Pendle-listed** | The indexed market also appears in Pendle's public catalog. |
| **Community / unlisted** | The event exists but the market is absent from that catalog. |
| **Incomplete** | The event is valid, but optional metadata could not be fully hydrated. |

None is a safety score. The market page performs fresh contract reads and provenance checks before enabling actions.

## Search and filter

Open **Explore** from the desktop header or mobile menu. You can filter by:

- search text across names and market, PT, YT, and SY addresses;
- network;
- lifecycle: All, Live, Matured, or Unknown;
- source: All, Pendle-listed, or Community; and
- sort order: TVL, implied APY, maturity, or creation time.

If Pendle listing metadata is unavailable, OpenPendle reports the listing as unknown instead of classifying unmatched markets as Community.

Search, filters, sort, and pagination live in the hash URL. Refreshing, using Back, or sharing the Explore URL preserves that view.

## Open or share a result

Selecting a result opens a chain-explicit market URL. That link overrides the recipient's preferred network only in its own tab and can be inspected without connecting a wallet.

Explore does not save a market automatically. Use **Remember this pool** on the market page if you want it in your browser-local registry.

## If a market is missing

The static snapshot is eventually consistent. A new market may be absent until the next successful scan, and optional metadata can lag.

To inspect a missing market immediately, choose the correct network and paste its `PendleMarket` address on the home page. A pasted PT or YT can also open Token actions and resolve its market. An SY alone may correspond to several maturities, so it cannot identify one market.

Snapshot coverage is reported per chain. Recent blocks are rescanned to reduce reorganization risk, and incomplete scans remain visible as incomplete rather than being presented as comprehensive. For transaction decisions, use the live market page and wallet simulation.

## Next

- [Opening a pool](/guides/opening-a-pool)
- [Saved pools & privacy](/guides/saved-pools)
- [Community pools & incentives](/concepts/community-pools)
- [Risks & disclosures](/reference/risks)
