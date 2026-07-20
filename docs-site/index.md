---
layout: home
title: OpenPendle Docs
titleTemplate: The permissionless Pendle frontend

hero:
  name: OpenPendle
  text: The permissionless Pendle frontend
  tagline: An open-source, static interface to every indexed factory-created Pendle V2 market — listed and community-created.
  image:
    src: /favicon.svg
    alt: OpenPendle
  actions:
    - theme: brand
      text: Open the Quickstart
      link: /introduction/quickstart
    - theme: alt
      text: Understand Pendle
      link: /concepts/how-pendle-works
    - theme: alt
      text: Launch app ↗
      link: https://openpendle.com

features:
  - icon: 🔓
    title: Permissionless by design
    details: Browse every indexed factory-created market or load any Pendle V2 market by address across six networks. Listed status stays visible; it never becomes a whitelist.
  - icon: 🛰️
    title: Static and verifiable
    details: Explore uses a generated factory-event snapshot. Core pool data comes straight from your RPC, every on-chain transaction is simulated, and no OpenPendle request-time server or relay sits in the signing path.
  - icon: 🔒
    title: Yours and private
    details: No OpenPendle accounts or user-data backend. Saved pools and settings stay in your browser; feature APIs and Cloudflare receive only the requests disclosed in the docs.
  - icon: 🎁
    title: A public good
    details: Free everywhere, GPL-3.0, and it takes no fee of its own. Not affiliated with Pendle Finance.
---

::: warning Experimental — use at your own risk
Community pools are **permissionless and unreviewed** — anyone can create one, and interacting with them can lose you funds. OpenPendle checks that a market came from a Pendle factory it recognizes, but it **cannot vouch for the assets or SY contracts underneath**. Please read [Risks &amp; disclosures](/reference/risks) before you transact.
:::

## New here?

- [**Quickstart**](/introduction/quickstart) — choose a goal, then follow the safe core flow.
- [**What is OpenPendle**](/introduction/what-is-openpendle) — what it does, and what makes it different.
- [**Why OpenPendle**](/introduction/why-openpendle) — the case for a permissionless, backend-free Pendle frontend.

## Learn Pendle

- [**How Pendle works**](/concepts/how-pendle-works) — yield tokenization, start to finish.
- [**Principal Tokens (PT)**](/concepts/principal-tokens) & [**Yield Tokens (YT)**](/concepts/yield-tokens) — fixed yield vs. trading yield.
- [**Anatomy of a Pendle pool**](/concepts/pool-anatomy) — what a "market" actually is on-chain.

## Do things

- [**Model a PT loop**](/guides/looping) — compare Pendle PT yield with Morpho borrowing and inspect the read-only entry and exit outline; execution is currently disabled.
- [**Explore markets**](/guides/exploring-markets) — search the factory-created universe across six networks and filter listed vs community markets.
- [**Yield alerts**](/guides/yield-alerts) — inspect qualified 24-hour PT fixed-yield moves; no wallet or notifications.
- [**PT limit orders**](/guides/limit-orders) — target an APY on the subset Pendle's live service supports.
- [**Positions & rewards**](/guides/positions) — inspect balances across saved pools and claim supported rewards by network.
- [**Browsing & doing actions**](/guides/connecting-a-wallet) — connect a wallet and use a pool.
- [**Creating a pool**](/create/overview) — deploy your own market.
- [**Risks & disclosures**](/reference/risks) — please read this one.

OpenPendle is a gift to Pendle's community and takes no fee of its own. Built by [ggmxbt](https://x.com/ggmxbt). Not affiliated with Pendle Finance.
