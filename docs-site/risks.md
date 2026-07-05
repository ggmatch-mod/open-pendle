# Risks &amp; disclosures

This page mirrors the [About](https://openpendle.com/#/about) page inside the app. Please read it before you transact.

::: danger Experimental — use at your own risk
This is novel, unaudited software for a permissionless protocol. Community pools are **unreviewed** and can be created by anyone; interacting with them can lose you funds. OpenPendle is **not affiliated with, endorsed by, or operated by Pendle Finance**. Nothing here is financial advice, and it comes with no warranty of any kind.
:::

## What community pools are

Anyone can permissionlessly create a Pendle V2 market for any yield-bearing asset — no whitelist, no approval. OpenPendle loads any market by its address; there is no listing or curation here by design. **A market being loadable is not an endorsement of it.**

## What OpenPendle checks — and what it can't

**It checks:**

- that the market was created by a Pendle factory OpenPendle recognizes (a **provenance gate**) before it lets you save or transact;
- it **simulates every transaction** against the chain before you sign;
- it uses **exact-amount token approvals**.

**It can't:**

- vouch for the underlying asset or the **SY (Standardized Yield)** contract a pool wraps. A factory-valid market can still wrap a malicious, broken, or exotic asset.

Read the trust panel on each pool, and **never interact with one unless you trust whoever created it and the assets underneath**.

## Fees

OpenPendle charges **nothing** and adds no fee of its own. Pendle's own protocol fees still apply — the swap-fee cap, the YT interest fee, and so on — enforced by Pendle's contracts, not by this interface. You can read those live on the [Protocol Status &amp; Contracts](https://openpendle.com/#/status) page in the app.

## Your data &amp; privacy

No backend, no accounts, no tracking, no analytics. The pools you remember live only in your browser's local storage; any custom RPC you set stays local too. The only outbound requests are to the blockchain RPCs you're pointed at and — for the header stats ticker — Pendle metrics from DefiLlama and CoinGecko's public APIs. See [Saved pools &amp; privacy](/saved-pools).

## Open source

OpenPendle is released under **GPL-3.0-or-later**. It calls Pendle's deployed contracts with hand-written ABIs and ships no smart contracts of its own. Built by [ggmxbt](https://x.com/ggmxbt).

## Reporting a security issue

Found a vulnerability? Reach out to [ggmxbt on X](https://x.com/ggmxbt) — see [`/.well-known/security.txt`](https://openpendle.com/.well-known/security.txt).
