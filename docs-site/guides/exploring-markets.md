# Exploring markets

**Explore** is OpenPendle's market directory. It gives you a searchable starting point when you do not already have a market address, while the existing address loader remains available for pools shared by a creator or found through your own research. Browsing the directory and opening a market do not require a connected wallet.

::: warning Discovery is not endorsement
Explore helps you discover contracts; it does not recommend them. Factory provenance, a Pendle listing, or a complete-looking card does not mean that OpenPendle or Pendle guarantees a market's assets, [SY contract](/concepts/standardized-yield), yield, liquidity, or safety. Read the market's trust panel and [Risks & disclosures](/reference/risks) before you transact.
:::

## What the directory contains

Explore's inventory starts from **on-chain factory events**, not from a frontend listing. A scheduled job scans the recognized Pendle market-factory generations on all six supported networks for `CreateNewMarket`, checkpoints its progress, and publishes a versioned static snapshot with one identity per `chainId:marketAddress`. That is what lets Explore include community markets that Pendle's public catalog does not list.

Pendle's public market API is joined afterward as **enrichment**. It can provide names, icons, TVL, implied APY, and whether a market appears in Pendle's catalog, but it is not the inventory source. These terms therefore answer different questions:

| Term | What it means | What it does not mean |
| --- | --- | --- |
| **Factory-indexed** | A recognized Pendle market factory emitted `CreateNewMarket` for this address on this chain. | Reviewed, safe, liquid, or currently usable. |
| **Pendle-listed** | The same factory-indexed market is also present in Pendle's public market catalog. | Endorsed by OpenPendle, guaranteed, or risk-free. |
| **Community / unlisted** | The factory event exists but Pendle's public catalog does not contain the market. | Invalid or unsafe merely because it is unlisted; diligence is still required. |
| **Incomplete** | The event was indexed, but some optional metadata or live-derived fields could not be hydrated. | That the market is fake; the address remains discoverable and can be checked live on its market page. |

A Pendle-listed market is still an on-chain contract with asset and smart-contract risk. A community market is no less real because it is absent from Pendle's frontend. OpenPendle keeps that source distinction visible so coverage is broad without making curation ambiguous.

## Search and filter

Open **Explore** from the desktop header or mobile navigation. The initial view does not hide inventory: it shows **All** indexed lifecycles and sources, sorted by **TVL**, with 24 results per page. Once a market's maturity is known, you can narrow to live or matured markets.

You can narrow the directory with:

- **Search** across the market name, protocol, market address, PT address, YT address, and SY address.
- **Network**: all supported networks, or one of Ethereum, BNB Smart Chain, Monad, Base, Plasma, and Arbitrum.
- **Lifecycle**: **All** (the default), **Live**, **Matured**, or **Unknown**. Unknown is kept separate instead of being guessed from Pendle's catalog status.
- **Source**: **All**, **Pendle-listed**, or **Community**. Community means factory-indexed but absent from Pendle's public catalog; it is not a safety score. If either Pendle catalog slice is unavailable, unmatched results become **Listing unknown** and the Community filter is disabled rather than guessing.
- **Sort**: **Highest TVL** (the default), **Highest implied APY**, **Soonest maturity**, or **Newest created**. Missing maturity or creation dates sort last.

Changing any search, network, status, or sort control returns you to the first results page.
Those controls and the current page are stored in the hash URL, so refreshing or returning from a
market with the browser's **Back** action restores the same directory view. A shared Explore URL
therefore also includes its search text and filters.

Lifecycle, listed status, APY, TVL, and similar fields are discovery metadata, not promises, and can lag the latest block. Explore shows how many network scans are complete; the underlying snapshot also records each chain's indexed-through block and hash for independent verification. If a chain scan is incomplete, the app says so rather than describing the partial result as complete. Records whose event is valid but whose optional metadata could not be hydrated remain visible as incomplete. Factory logs that cannot be decoded into a safe identity are quarantined from normal results and counted in the coverage notice. The market page performs fresh on-chain reads and provenance checks before enabling actions, so treat that page and your wallet's simulation as the transaction-time view.

## Opening and sharing a result

Selecting a result opens the normal market page using a **chain-explicit deep link**. The URL carries both the market address and its chain ID, so it opens on the correct network even when your preferred network is different. A chain-explicit market link overrides that preference only in its own browser tab.

You can share the resulting URL directly. The recipient can inspect the market without connecting a wallet. If they later transact, their wallet must match the market's chain; see [Browsing & networks](/guides/browsing) and [Connecting a wallet](/guides/connecting-a-wallet).

::: info Explore and Saved Pools serve different purposes
Explore is a public discovery catalog. [Saved Pools](/guides/saved-pools) is your private, browser-local list of markets you chose to remember. Opening or filtering Explore does not add anything to Saved Pools.
:::

## Opening a market that is not visible

If a newly created market has not reached the next snapshot, or a chain is marked incomplete, paste its `PendleMarket` address into OpenPendle while viewing the correct network. OpenPendle then reads the contract from the chain and runs its [provenance gate](/guides/opening-a-pool). If you only have a PT or YT, paste it on the home page and open **Token actions**; OpenPendle may resolve its pool. An SY can back many maturities, so an SY alone cannot identify one market — find a PT, YT, or market for the intended maturity.

Absence from Explore is not proof that a contract is fake, and presence is not proof that it is safe. The snapshot is eventually consistent: it can lag recent blocks, and public RPC limits can temporarily interrupt a chain scan. The live provenance gate confirms that a recognized Pendle factory created a market. It cannot vouch for the underlying asset or SY contract.

## How the static snapshot stays honest

The catalog job is an indexer, but it is **not a request-time application backend**. It runs on a schedule, scans forward from per-chain checkpoints, accounts for a reorg buffer before publishing, and writes a static JSON artifact that ships with or is fetched by the static app. There is no account database and it never constructs or relays a transaction.

That design has explicit limitations:

- **Eventual consistency:** a market created after the latest successful run will not appear until a later snapshot.
- **RPC dependence:** range limits, rate limits, or an unavailable chain can make a run partial. Coverage is recorded per chain and factory generation.
- **Metadata gaps:** factory events establish inventory, but labels, icons, TVL, and APY are optional enrichment and can be missing or stale.
- **Known-lineage boundary:** “all” means all events from the recognized factory generations configured for the six supported chains. If Pendle deploys a new factory, OpenPendle must add and backfill it before claiming that generation is covered.
- **Reorganizations:** recently observed events are rescanned before publication; even so, the market page's live checks remain authoritative for actions.

The snapshot improves discovery, not assurance. Every result still needs the same trust-panel review and risk warnings before any transaction.

## Next

- [Opening a pool](/guides/opening-a-pool) — live contract reads, provenance, and the trust panel.
- [Browsing & networks](/guides/browsing) — active networks and chain-explicit links.
- [Saved pools & privacy](/guides/saved-pools) — remember markets locally in your browser.
- [Community pools & incentives](/concepts/community-pools) — permissionless creation and its risks.
- [Risks & disclosures](/reference/risks) — what validation cannot protect you from.
