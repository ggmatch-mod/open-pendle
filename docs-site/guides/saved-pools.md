# Saved pools & privacy

Saved Pools is a browser-local bookmark list for Pendle markets you want to revisit. There is no OpenPendle account or server-side saved-pool database, and saving a market does not create an on-chain record.

## Remember and forget

After a market passes OpenPendle's provenance check, **Remember this pool** adds its market address and chain to the local registry. It then appears on the [Saved Pools](https://openpendle.com/#/pools) page, grouped by network.

**Forget** removes an entry. An Undo toast remains available for roughly four seconds; after it expires, reopen the market and remember it again if needed.

::: warning A bookmark is not an endorsement
Provenance confirms that a recognized Pendle factory created the market. It does not verify the asset or SY contract. Re-check every imported or shared market before transacting.
:::

## Where the registry lives

The registry is stored in the current browser and origin under:

```
openpendle.pools.v1
```

It survives ordinary reloads, but it does not automatically follow you to another browser, profile, device, or private window. Clearing site data removes it, so export first if the list matters to you.

The `v1` suffix is an internal schema version. Prefer the app's Export and Import controls over editing localStorage directly.

## Export, import, and share

Open **Saved pools** to move or back up the registry.

- **Export JSON** downloads the current list. Exporting does not upload it.
- **Import** reads a compatible JSON file and adds valid entries to this browser.
- **Copy share link** creates a `/#/pools?import=...` URL containing the list in its hash route.

Opening a share link does **not** modify the registry immediately. OpenPendle shows how many pools were shared and asks the recipient to choose **Add** or **Dismiss**.

Importing adds market pointers, not trust. Each pool is checked again when opened, and its chain must be supported.

## Privacy boundary

Saving, forgetting, importing, and exporting operate on localStorage. OpenPendle does not intentionally attach the registry to RPC, Pendle, Merkl, or analytics requests.

Other app features still make network requests. For example, opening a saved market reads its contracts through an RPC; Positions reads balances for saved markets and asks Pendle for the connected wallet's Official-pool market IDs; limit-order and Merkl features send the data those services require; and Cloudflare Web Analytics receives page-view and performance data. See [How OpenPendle works](/reference/architecture) for the current provider and data-flow disclosure.

Treat a share link as sensitive if your chosen market list reveals information you would not publish: anyone who receives the URL can decode the entries it contains.

## Good practices

- Export before clearing site data or changing devices.
- Verify shared markets independently.
- Keep the full chain-explicit market URL when sharing one market.
- Remember that Positions combines this registry with Pendle Official Pool discovery; unsupported or undiscovered markets can still be absent.

## See also

- [Positions & rewards](/guides/positions)
- [Opening a pool](/guides/opening-a-pool)
- [Browsing & networks](/guides/browsing)
- [Risks & disclosures](/reference/risks)
