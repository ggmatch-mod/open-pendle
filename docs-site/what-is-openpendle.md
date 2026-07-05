# What is OpenPendle

OpenPendle is a free, open-source, backend-free interface to Pendle V2's **permissionless community pools** — the markets anyone can create, that Pendle's own app doesn't list. It reads straight from the chain and simulates every transaction before you sign. It is a gift to Pendle's community and takes no fee of its own.

## Why it exists

Pendle is a permissionless protocol: **anyone** can deploy a yield market for **any** yield-bearing asset, with no whitelist and no approval. Pendle's official app curates a listed subset of those markets. Everything else — the long tail of community-created pools — has no first-class interface.

OpenPendle is that interface. It loads any Pendle V2 market by its address, on any supported network, and lets you trade, provide liquidity, redeem, or create one — with no listing, no curation, and no gatekeeper.

> A market being loadable here is **not** an endorsement of it. See [Risks &amp; disclosures](/risks).

## What makes it different

- **No backend, no indexer, no database.** State comes directly from the blockchain via public RPC. There is no server between you and Pendle's contracts.
- **Provenance gate.** Before you can save or transact against a market, OpenPendle verifies it was created by a Pendle factory it recognizes.
- **Simulate before sign.** Every transaction is simulated against the live chain first, so you see the expected outcome before committing.
- **Exact-amount approvals.** Token approvals are scoped to the amount you're spending — no unlimited allowances.
- **Injected-only wallets.** Connects to your browser wallet (MetaMask, Rabby, Brave) directly. No WalletConnect, no third-party relay. See [Browsing &amp; doing actions](/using-openpendle).
- **Six networks.** Ethereum, BNB Smart Chain, Monad, Base, Plasma, and Arbitrum. See [Networks &amp; contracts](/networks-and-contracts).
- **Self-hostable.** It's a static site with hash-based routing, so it runs on any static host or IPFS with no rewrite rules. See [Self-hosting](/self-hosting).
- **Private.** No accounts, no tracking, no analytics. Saved pools and custom RPCs live only in your browser.
- **No fee of its own.** OpenPendle adds nothing on top. Pendle's own protocol fees still apply, enforced by Pendle's contracts.

## What it is not

- It is **not affiliated with, endorsed by, or operated by Pendle Finance**.
- It is **not a curator or reviewer**. It does not vet the assets or SY contracts a pool wraps.
- It is **not custodial**. It never holds your funds or keys; you sign every transaction in your own wallet.
- It **ships no smart contracts of its own**. It calls Pendle's already-deployed contracts with hand-written ABIs.

## Next

- New to Pendle? Read [How community pools work](/how-pools-work).
- Ready to use it? See [Browsing &amp; doing actions](/using-openpendle).
- Want to launch your own market? See [Creating a pool](/creating-a-pool).
