# How community pools work

A quick, plain-language primer on Pendle V2's building blocks. If you already know PT/YT/SY, skip to [Browsing &amp; doing actions](/using-openpendle).

Pendle splits a yield-bearing asset into its **principal** and its **yield**, so each can be traded on its own. Here's the chain of pieces.

## SY — the standardized wrapper

A pool starts from a **yield-bearing asset** (a staked token, a lending receipt, a vault share, and so on). Pendle wraps it in a **Standardized Yield (SY)** token — a common interface every downstream contract understands.

OpenPendle can validate that a market came from a Pendle factory, but it **cannot vouch for the SY contract or the asset underneath**. A factory-valid market can still wrap a malicious, broken, or exotic asset. That's the core risk — read the trust panel on each pool.

## PT and YT — principal and yield, split apart

Until a fixed **maturity** date, SY can be split into two tokens:

- **PT (Principal Token)** — redeems **1:1 for the underlying at maturity**. Buy it below par and hold to maturity for a **fixed yield** locked in at purchase.
- **YT (Yield Token)** — entitles the holder to **all the yield** the underlying produces until maturity. It's a bet on variable yield: if yield runs higher than the market priced, YT wins; it decays toward zero as maturity approaches.

By construction, `PT + YT` together reconstitute the SY. You can mint PT+YT from SY, or redeem PT+YT back into SY, at any time before maturity.

## LP — the liquidity pool

Each market has an AMM pairing **PT with SY**. Providing liquidity (an **LP** position) earns:

- a share of **swap fees** from people trading PT in and out, plus
- any **external incentives** on the pool (see below).

LP carries the usual AMM risks plus exposure to PT's price relative to SY.

## Maturity

At the maturity date:

- **PT** becomes redeemable 1:1 for the underlying,
- **YT** stops accruing and is worth nothing further,
- the market stops trading.

After maturity you can still redeem PT and exit LP through OpenPendle.

## What "community pool" means

A **community pool** is simply a Pendle V2 market that **anyone deployed permissionlessly** — no whitelist, no Pendle approval. Two consequences worth knowing:

- **They aren't reviewed.** Pendle's team hasn't vetted them, and neither has OpenPendle. Treat every one as untrusted until you've checked who created it and what it wraps.
- **Incentives come from [Merkl](https://merkl.angle.money/), not native gauges.** Native PENDLE gauge emissions / vePENDLE voting are reserved for team-listed pools, so community pools use Merkl campaigns for any extra rewards. See [Creating a pool](/creating-a-pool).

## Next

- [Browsing &amp; doing actions](/using-openpendle) — put this into practice.
- [Risks &amp; disclosures](/risks) — what can go wrong.
