# FAQ

## Is OpenPendle affiliated with Pendle Finance?

No. OpenPendle is an independent, open-source interface. It is **not affiliated with, endorsed by, or operated by Pendle Finance**. It calls Pendle's deployed contracts but is not built or run by the Pendle team.

## Does it cost anything? Does it take a fee?

OpenPendle is **free** and takes **no fee of its own**. Pendle's own protocol fees (swap-fee cap, YT interest fee, etc.) still apply — those are enforced by Pendle's contracts, not by this interface.

## Which wallets work?

Any wallet that injects a standard provider into your browser — **MetaMask, Rabby, Brave**, and similar. There is **no WalletConnect**.

- **Desktop:** use the wallet's browser extension.
- **Mobile:** open the site inside your wallet's in-app dApp browser, or in Brave mobile. A normal mobile browser tab has no injected wallet and can't connect.

See [Browsing &amp; doing actions](/using-openpendle#connecting-a-wallet).

## Why no WalletConnect?

To keep OpenPendle backend-free, private, and easy to self-host (including from IPFS). WalletConnect introduces a third-party relay and project registration; injected-only avoids both. The trade-off is that mobile use requires a wallet's in-app browser.

## Is it safe?

OpenPendle verifies a market's **provenance** (that it came from a recognized Pendle factory) and **simulates every transaction** before you sign. But **community pools are unreviewed** — anyone can create one, and OpenPendle can't vouch for the assets or SY contracts underneath. Please read [Risks &amp; disclosures](/risks).

## Where is my data stored?

In your browser only. No accounts, no backend, no tracking. Saved pools and custom RPCs live in `localStorage`. See [Saved pools &amp; privacy](/saved-pools).

## Can I use my own RPC?

Yes — override the endpoint per network in the header's RPC settings. It's stored locally and never shared.

## Why isn't pool X on the official Pendle app?

Because it's a **permissionless community pool** that Pendle's app doesn't list. That long tail of unlisted markets is exactly what OpenPendle is for. Being loadable here is **not** an endorsement — see [How community pools work](/how-pools-work).

## Can community pools have incentives?

Yes, via [Merkl](https://merkl.angle.money/) campaigns. Native PENDLE gauge emissions and vePENDLE voting are reserved for team-listed markets, so community pools use Merkl for extra rewards. See [Creating a pool](/creating-a-pool#incentives).

## Which networks are supported?

Ethereum, BNB Smart Chain, Monad, Base, Plasma, and Arbitrum. See [Networks &amp; contracts](/networks-and-contracts).

## Is it open source? Can I run my own copy?

Yes — **GPL-3.0-or-later**, and it's a static site you can host anywhere, including IPFS. See [Self-hosting](/self-hosting).

## How do I report a security issue?

Reach out to [ggmxbt on X](https://x.com/ggmxbt), or see [`/.well-known/security.txt`](https://openpendle.com/.well-known/security.txt).
