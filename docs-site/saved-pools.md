# Saved pools &amp; privacy

OpenPendle has no accounts and no backend, so there's nothing to log into — but you can still keep a personal list of the pools you care about. It lives entirely in your browser.

## Remembering a pool

Open a market and toggle **Remember this pool**. It's added to your local registry, stored in your browser's `localStorage` (under the key `openpendle.pools.v1`). Nothing is sent anywhere — no server ever sees which pools you follow.

Your saved pools are grouped by network on the **Saved pools** page (the ★ pill in the header, at `/pools`). The home page shows a short preview with a link to the full list.

## Forget — with undo

Forgetting a pool removes it immediately, but a toast gives you a few seconds to hit **Undo** and restore it exactly (nothing is really lost until the window closes).

## Moving pools between browsers &amp; devices

Because the registry is local, it doesn't follow you to another browser automatically. Three ways to move it, all on the Saved pools page:

- **Export to JSON** — download your saved pools as a file.
- **Import** — load a JSON file (or a shared list) back in; existing pools are kept and new ones merged.
- **Share link** — copy a link with your pools encoded in it (an `?import=` token). Opening it on another device offers to import them.

These are the *only* ways your list leaves the browser — and only when **you** trigger them.

## Privacy model

- **No backend, no accounts, no tracking, no analytics.**
- Saved pools and any **custom RPC** you set stay in your browser's local storage.
- The only outbound requests are to the **blockchain RPCs** you're pointed at and, for the header ticker, **Pendle metrics from DefiLlama and CoinGecko** public APIs.

Clearing your browser storage clears your saved pools — export first if you want a backup. See [Risks &amp; disclosures](/risks).
