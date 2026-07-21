# Connecting a wallet

OpenPendle connects directly to an **injected wallet**: a browser extension on desktop or a wallet-provided browser on mobile. There is no WalletConnect, QR pairing, OpenPendle account, or transaction relay.

You can browse markets, switch networks, inspect trust information, and view Yield alerts without connecting. Connect only when you are ready to sign a transaction or supported PT limit order.

::: warning Connecting does not move funds
Connecting shares your public address and allows the site to request signatures. Funds move only after you approve or sign. Market provenance is not an endorsement of the underlying asset or SY; read [Risks & disclosures](/reference/risks) first.
:::

## Supported connection model

OpenPendle discovers injected providers through EIP-6963. Common examples include MetaMask, Rabby, Brave Wallet, and other compatible providers. Your wallet keeps the private key and displays every approval or signature request.

This injected-only model keeps the signing path between the page and wallet on your device. The trade-off is that a normal mobile Safari or Chrome tab usually has no provider to connect to.

## Desktop and mobile

### Desktop

1. Install and unlock a compatible wallet extension.
2. Open OpenPendle and select **Connect wallet**.
3. Choose a provider if more than one is available.
4. Approve the connection in the wallet.

### Mobile

Open `openpendle.com` inside your wallet's dApp browser, or another browser that injects a wallet provider. Copy the full `openpendle.com/#/...` URL when opening a specific market or shared Saved Pools link.

You can still browse in an ordinary mobile tab, but you cannot sign there unless that browser supplies an injected provider.

## Network alignment

OpenPendle and the wallet each have a selected chain. The app's **active network** determines the read client and intended transaction destination.

If the two chains differ, use the wrong-network banner to ask the wallet to switch. You can also choose another active network from the desktop header, mobile menu, or **Profile** after connecting. Rejecting a wallet switch leaves browsing available but prevents the mismatched action from proceeding safely.

A market address belongs to one chain, so when viewing a specific market, switch the wallet to the market's chain rather than moving the app to a chain where that address does not exist.

## After connecting

The compact wallet control becomes **Profile**. It contains:

- Saved pools, Positions, and Yield alerts;
- active-network selection;
- the per-chain RPC override;
- light/dark mode; and
- wallet account management.

On-chain actions quote as you type, check balances and allowances, simulate before confirmation, and use exact approvals by default. Unlimited approval is a separate, higher-exposure transaction-setting opt-in.

PT limit orders follow a different path: OpenPendle validates Pendle's generated EIP-712 order before your wallet signs it, then publishes it only when the exact market and direction pass Pendle's live support check. See [PT limit orders](/guides/limit-orders).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No wallet appears on desktop | Unlock and enable the extension, then reload. |
| No wallet appears on mobile | Open the site inside a wallet dApp browser or another provider-injecting browser. |
| You expected a QR code | OpenPendle does not use WalletConnect; use an injected provider. |
| Wrong-network banner remains | Approve its switch request, or choose the intended active network. |
| A transaction action is disabled | Confirm the wallet is connected to the market's chain and no other action is in progress. |

OpenPendle never asks for a seed phrase or private key. Report security issues via [x.com/ggmxbt](https://x.com/ggmxbt) or the contact in `/.well-known/security.txt`.

## See also

- [Browsing & networks](/guides/browsing)
- [Opening a pool](/guides/opening-a-pool)
- [How OpenPendle works](/reference/architecture)
- [Risks & disclosures](/reference/risks)
