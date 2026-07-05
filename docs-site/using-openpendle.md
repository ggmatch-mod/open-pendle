# Browsing &amp; doing actions

How to connect, open a pool, and trade or provide liquidity.

## Browsing is wallet-less

You don't need to connect anything to look around. OpenPendle reads everything from public RPC, so you can switch networks and open any market first, then connect only when you want to transact.

Use the **network selector** in the header to pick which chain you're reading from (Ethereum, BNB Smart Chain, Monad, Base, Plasma, Arbitrum). This is the single "active network" the whole app reads from — and where a transaction will be sent. See [Networks &amp; contracts](/networks-and-contracts).

## Connecting a wallet

OpenPendle is **injected-only**: it talks to a browser wallet directly, with **no WalletConnect** and no third-party relay. Supported wallets include **MetaMask, Rabby, and Brave** — anything that injects a standard provider.

- **On desktop:** install the wallet's browser extension, then click **Connect**.
- **On mobile:** open `openpendle.com` inside your **wallet's in-app dApp browser** (MetaMask, Rabby, etc.) or in **Brave mobile**. A normal mobile Safari/Chrome tab has no injected wallet and can't connect — this is a deliberate trade-off for privacy and static-hostability, not a bug.

If your wallet is on a different network than the one you're viewing, a banner offers a one-click **switch** so your transaction lands on the right chain. Browsing still works either way.

## Opening a pool

Paste a **market address** on the home page to load it live. OpenPendle runs its **provenance gate** first: the market must come from a Pendle factory it recognizes, or it won't let you save or transact. Once loaded, read the **trust panel** — it surfaces what the pool wraps and who controls it.

## Actions on a pool

Every action **simulates against the live chain before you sign** and uses **exact-amount approvals**. The common ones:

- **Mint / Redeem** — split SY (or the underlying) into `PT + YT`, or recombine `PT + YT` back into SY, any time before maturity.
- **Swap to PT** — buy the Principal Token for a **fixed yield** locked in at purchase; hold to maturity to redeem 1:1 for the underlying.
- **Swap to YT** — take **yield exposure**: YT collects the underlying's yield until maturity.
- **Add / remove liquidity** — provide an LP position to earn swap fees (and any Merkl incentives), or withdraw it.
- **Redeem at maturity** — after expiry, redeem PT for the underlying and exit LP.

Quotes update as you type, showing the expected output before you commit. See [How community pools work](/how-pools-work) for what PT, YT and LP mean.

## Custom RPC

Public endpoints can rate-limit. Open the **RPC settings** in the header to point the active network at your own endpoint (Alchemy, Infura, dRPC, …). Each network has its own override, it's stored **only in your browser**, and saving reloads the app. See [Networks &amp; contracts](/networks-and-contracts).

## Theme

Toggle light / dark from the header. Your choice is remembered locally; dark is the default.

## Next

- [Saved pools &amp; privacy](/saved-pools) — keep track of the pools you care about.
- [Creating a pool](/creating-a-pool) — launch your own market.
