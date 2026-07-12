/**
 * QuickStartPage — /quickstart. A screen-by-screen annotated walkthrough of
 * OpenPendle: load a market, inspect the pool, create your own, and act on any
 * PT/YT. The screens are faithful *recreations* of the app UI (not live), so the
 * page needs no wallet, no RPC and no chain reads — it renders instantly.
 *
 * The markup is a large block of fully static, self-authored HTML, so it's
 * injected via dangerouslySetInnerHTML rather than hand-ported to JSX (no user
 * input is ever interpolated). All styling is scoped under `.qsg` in
 * quickstart.css, and every colour is aliased onto the app's --op-* tokens, so
 * the whole guide follows the active theme (light/dark) and accent.
 */

import { useDocumentTitle } from '../components/useDocumentTitle'
import './quickstart.css'

const GUIDE_HTML = `
<div class="grid-bg"></div>
<div class="page">
  <div class="wrap">

    <header class="mast">
      <div class="eyebrow">A field guide</div>
      <h1>Pendle community pools, <span class="u">no whitelist</span></h1>
      <p class="lede">OpenPendle is a static interface with no request-time OpenPendle server in the transaction path. Browse factory-indexed Pendle-listed and community markets in Explore, or paste any market by address; its core state is read straight from the chain, its controls are checked, and every transaction is simulated before you sign. Here's the whole tool, screen by screen.</p>
      <div class="nets" aria-label="Supported networks">
        <span class="net"><span class="dot"></span>Ethereum</span>
        <span class="net"><span class="dot"></span>Arbitrum</span>
        <span class="net"><span class="dot"></span>Base</span>
        <span class="net"><span class="dot"></span>BNB Smart Chain</span>
        <span class="net"><span class="dot"></span>Monad</span>
        <span class="net"><span class="dot"></span>Plasma</span>
      </div>
      <div class="legend"><span class="n">1</span> Numbered pins on each screen point to what the panel on the left is describing.</div>
    </header>

    <!-- ============ STEP 01 — HOME ============ -->
    <section class="step">
      <div class="step-grid">
        <div class="rail">
          <div class="idx">STEP 01</div>
          <h2>Explore, or load any address</h2>
          <p>Browse factory-indexed Pendle-listed and community markets in Explore. If a new market has not reached the scheduled snapshot, or its network coverage is incomplete, paste any Pendle&nbsp;V2 market (PLP) address and OpenPendle loads it live from the network you're on. No account required.</p>
          <ul class="notes">
            <li><span class="n">1</span><span><b>Paste box</b> — drop in any market address; it validates on-chain as you type.</span></li>
            <li><span class="n">2</span><span><b>Defaults</b> — exact-amount approvals, simulated first, registry stays on your device.</span></li>
            <li><span class="n">3</span><span><b>Create instead</b> — spin up your own pool or an SY adapter.</span></li>
            <li><span class="n">4</span><span><b>Anatomy</b> — every pool splits an SY into a Principal (PT) and Yield (YT) token.</span></li>
          </ul>
        </div>

        <div class="frame">
          <div class="chrome">
            <span class="tl"><i></i><i></i><i></i></span>
            <span class="urlbar"><span class="lock">🔒</span> openpendle.com<span class="u2">/#/</span></span>
          </div>
          <div class="ticker">
            <span><b>PENDLE TVL</b> $943.7M</span><span><b>FEES 1Y</b> $24.79M</span>
            <span><b>REVENUE 1Y</b> $24.04M</span><span><b>HOLDER REV 1Y</b> $20.42M</span>
            <span class="g"><b>vePENDLE APY</b> 8.1%</span><span><b>TVL</b> $943.7M</span>
          </div>
          <div class="apphdr">
            <div class="brand"><span class="mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2.4 20.6 7v10L12 21.6 3.4 17V7L12 2.4Z" stroke="#6366f1" stroke-width="1.6" stroke-linejoin="round"/></svg></span><span class="wm">Open<span class="b">Pendle</span></span></div>
            <nav class="nav">
              <span class="pill"><span class="i">✦</span>Quick start</span>
              <span class="pill"><span class="i">◇</span>Explore</span>
              <span class="pill"><span class="i">◈</span>Positions</span>
              <span class="pill on">Create pool</span>
              <span class="pill net"><span class="dot"></span>Arbitrum ▾</span>
              <span class="btn accent">Connect Wallet</span>
            </nav>
          </div>

          <div class="screen">
            <div class="hero">
              <div>
                <span class="chip"><span class="livedot"></span><span class="mono" style="font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">Permissionless · on-chain</span></span>
                <h3>Pendle community pools, <span class="u">no whitelist</span></h3>
                <p class="sub">Explore factory-created markets or load any Arbitrum market by address. No OpenPendle server sits in the transaction path — core pool data comes straight from the chain.</p>
                <div class="paste">
                  <label>Load any market</label>
                  <div class="pastebox"><span class="car"></span>Paste a Pendle market (PLP) address — 0x…</div>
                </div>
                <div class="links">
                  <span class="p">Explore factory-created markets →</span><span class="dvd">·</span><span class="s">Create a community pool →</span>
                </div>
                <div class="trust-chips">
                  <span class="chip"><span class="c">✓</span>Exact approvals by default</span>
                  <span class="chip"><span class="c">✓</span>Simulated before you sign</span>
                  <span class="chip"><span class="c">✓</span>Registry stays on your device</span>
                </div>
              </div>

              <div class="anatwrap">
                <div class="anat">
                  <div class="top">
                    <span class="tag"><span class="livedot"></span>Live market · anatomy</span>
                    <span class="tag">Example</span>
                  </div>
                  <div class="nm">PLP Staked USDai</div>
                  <div class="meta">Matures 25 Feb 2027 · Arbitrum · <span class="mono">0xf861…83c8</span></div>
                  <div class="split">
                    <span class="syband"><span class="r">SY</span><span class="t">Standardized Yield wraps the asset</span></span>
                    <span class="stem"></span>
                    <div class="pyrow">
                      <div class="pt"><div class="bar"></div><div class="bd"><div class="r">PT</div><div class="d">Principal — redeems 1:1 at maturity</div></div></div>
                      <div class="yt"><div class="bar"></div><div class="bd"><div class="r">YT</div><div class="d">Yield — collects until expiry</div></div></div>
                    </div>
                  </div>
                  <div class="prop">
                    <div class="lb"><span>PT proportion</span><span>62%</span></div>
                    <div class="track"><div class="fill"></div></div>
                  </div>
                  <div class="stats3">
                    <div><div class="k">Implied APY</div><div class="v ink tnum">10.43%</div></div>
                    <div><div class="k">Maturity</div><div class="v">25 Feb 2027</div></div>
                    <div><div class="k">TVL</div><div class="v tnum">842K</div></div>
                  </div>
                </div>
              </div>
            </div>

            <div class="pin" style="left:3.5%; top:52%;"><span class="n">1</span><span class="t">Paste a market</span></div>
            <div class="pin" style="left:3.5%; top:75.5%;"><span class="n">2</span><span class="t">Safety rails</span></div>
            <div class="pin" style="left:3.5%; top:66%;"><span class="n">3</span><span class="t">Create your own</span></div>
            <div class="pin rev" style="right:3%; top:44%;"><span class="n">4</span><span class="t">SY → PT + YT</span></div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ STEP 02 — MARKET ============ -->
    <section class="step">
      <div class="step-grid">
        <div class="rail">
          <div class="idx">STEP 02</div>
          <h2>Inspect the pool before you touch it</h2>
          <p>Open a market and OpenPendle shows the numbers and, unusually, <b>who controls it</b> — the SY's owner, whether it can be paused, and whether it's an upgradeable proxy. All from live reads.</p>
          <ul class="notes">
            <li><span class="n">1</span><span><b>Overview</b> — implied/fixed APY, TVL, maturity and fee tier, read live.</span></li>
            <li><span class="n">2</span><span><b>Trust panel</b> — SY owner, pause power and upgradeability, surfaced not hidden.</span></li>
            <li><span class="n">3</span><span><b>Actions</b> — wrap, mint/redeem, trade PT&nbsp;&amp;&nbsp;YT, or provide liquidity.</span></li>
            <li><span class="n">4</span><span><b>Validated</b> — checked against the real Pendle factory; fakes get a red banner.</span></li>
          </ul>
        </div>

        <div class="frame">
          <div class="chrome">
            <span class="tl"><i></i><i></i><i></i></span>
            <span class="urlbar"><span class="lock">🔒</span> openpendle.com<span class="u2">/#/market/0xf861…83c8?chain=42161</span></span>
          </div>
          <div class="apphdr">
            <div class="brand"><span class="mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2.4 20.6 7v10L12 21.6 3.4 17V7L12 2.4Z" stroke="#6366f1" stroke-width="1.6" stroke-linejoin="round"/></svg></span><span class="wm">Open<span class="b">Pendle</span></span></div>
            <nav class="nav">
              <span class="pill"><span class="i">✦</span>Quick start</span>
              <span class="pill"><span class="i">◇</span>Explore</span>
              <span class="pill"><span class="i">◈</span>Positions</span>
              <span class="pill">Create pool</span>
              <span class="pill net"><span class="dot"></span>Arbitrum ▾</span>
              <span class="btn accent">Connect Wallet</span>
            </nav>
          </div>

          <div class="screen">
            <div class="mkt-head">
              <div>
                <h3>PLP sUSDai 25FEB2027<span class="badge gen">active gen</span></h3>
                <span class="addrchip">◇ 0xf861…83c8 <span style="color:var(--faint)">⧉</span></span>
              </div>
              <span class="btn ghost">★ Remember pool</span>
            </div>

            <div class="mkt-cols">
              <div>
                <div class="ov">
                  <div class="cell"><div class="k">Implied APY</div><div class="v ink tnum">10.43%</div></div>
                  <div class="cell"><div class="k">TVL</div><div class="v tnum">$842K</div></div>
                  <div class="cell"><div class="k">Maturity</div><div class="v">25 Feb 2027</div></div>
                  <div class="cell"><div class="k">Fee tier</div><div class="v tnum">1.10%</div></div>
                  <div class="cell"><div class="k">PT proportion</div><div class="v tnum">62%</div><div class="h">trades cap at 96%</div></div>
                  <div class="cell"><div class="k">Vintage</div><div class="v" style="font-size:13px">active gen</div><div class="h">Pendle factory</div></div>
                </div>

                <div class="card trust" style="margin-top:14px">
                  <h4>Trust panel</h4>
                  <div class="rowline"><span class="lab">SY owner</span><span class="val">Pendle governance</span></div>
                  <div class="rowline"><span class="lab">Paused</span><span class="val good">no</span></div>
                  <div class="rowline"><span class="lab">Upgradeability</span><span class="val mono">proxy · admin: Pendle proxyAdmin</span></div>
                </div>

                <div class="tokens">
                  <div class="one"><span class="role">PT</span> PT-sUSDai <span class="adr">0x9e3b…a1c4</span></div>
                  <div class="one"><span class="role">YT</span> YT-sUSDai <span class="adr">0x54aa…77de</span></div>
                  <div class="one"><span class="role">SY</span> SY-sUSDai <span class="adr">0x2c1f…09b2</span></div>
                </div>
              </div>

              <div class="tabs">
                <div class="tabhead">Market actions</div>
                <div class="tabbar">
                  <span class="tabbtn">Wrap / Unwrap</span>
                  <span class="tabbtn">Mint / Redeem</span>
                  <span class="tabbtn on">Trade PT &amp; YT</span>
                  <span class="tabbtn">Liquidity</span>
                </div>
                <div class="seg"><span class="s on">Buy</span><span class="s">Sell</span></div>
                <div class="seg" style="margin-top:8px"><span class="s on">PT</span><span class="s">YT</span></div>
                <div class="field">
                  <div class="top"><span>You pay</span><span>balance —</span></div>
                  <div class="amt"><span class="num">0.0</span><span class="tk">◈ USDC ▾</span></div>
                </div>
                <div class="quote"><span>You receive</span><span><b>≈ — PT</b></span></div>
                <div class="note-line"><span style="color:var(--ink)">◆</span> Simulated before you sign · exact approval by default</div>
                <div class="cta">Enter an amount</div>
              </div>
            </div>

            <div class="pin" style="left:2.6%; top:26%;"><span class="n">1</span><span class="t">APY, read live</span></div>
            <div class="pin" style="left:2.6%; top:55%;"><span class="n">2</span><span class="t">Who controls it</span></div>
            <div class="pin rev" style="right:3%; top:33%;"><span class="n">3</span><span class="t">Act on it</span></div>
            <div class="pin" style="left:19.5%; top:12.5%;"><span class="n">4</span><span class="t">Validated</span></div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ STEP 03 — CREATE ============ -->
    <section class="step">
      <div class="step-grid">
        <div class="rail">
          <div class="idx">STEP 03</div>
          <h2>Launch your own community pool</h2>
          <p>Deploy a Pendle&nbsp;V2 market for an existing SY and seed its first liquidity — one transaction through Pendle's canonical <span class="mono" style="color:var(--ink)">commonDeploy</span> helper. Fill it in and preview without a wallet; deploying needs one.</p>
          <ul class="notes">
            <li><span class="n">1</span><span><b>SY address</b> — point at any Standardized-Yield token, or make one in the adapter wizard.</span></li>
            <li><span class="n">2</span><span><b>Expiry</b> — pick when PT matures; it snaps to 00:00 UTC on a Thursday.</span></li>
            <li><span class="n">3</span><span><b>Rate band &amp; fee</b> — set the permanent implied-APY range, launch APY and swap fee.</span></li>
          </ul>
        </div>

        <div class="frame">
          <div class="chrome">
            <span class="tl"><i></i><i></i><i></i></span>
            <span class="urlbar"><span class="lock">🔒</span> openpendle.com<span class="u2">/#/create</span></span>
          </div>
          <div class="apphdr">
            <div class="brand"><span class="mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2.4 20.6 7v10L12 21.6 3.4 17V7L12 2.4Z" stroke="#6366f1" stroke-width="1.6" stroke-linejoin="round"/></svg></span><span class="wm">Open<span class="b">Pendle</span></span></div>
            <nav class="nav">
              <span class="pill"><span class="i">✦</span>Quick start</span>
              <span class="pill"><span class="i">◇</span>Explore</span>
              <span class="pill"><span class="i">◈</span>Positions</span>
              <span class="pill on">Create pool</span>
              <span class="pill net"><span class="dot"></span>Arbitrum ▾</span>
              <span class="btn accent">Connect Wallet</span>
            </nav>
          </div>

          <div class="screen">
            <div class="wiz-h">Create a community pool</div>
            <div class="wiz-sub">Deploy a Pendle V2 market for an existing SY and seed its first liquidity — one transaction through Pendle's canonical <code>commonDeploy</code> helper. You can fill this in and preview without a wallet; deploying needs one.</div>

            <div class="stepcard">
              <div class="sh"><span class="num">1</span><div><div class="ti">SY (Standardized Yield) address</div><div class="de">The yield-bearing token your pool is built on.</div></div></div>
              <div class="inp">0x… SY contract address</div>
              <div class="hint">Need an SY first? <a>Create one in the SY-adapter wizard →</a></div>
            </div>

            <div class="stepcard">
              <div class="sh"><span class="num">2</span><div><div class="ti">Expiry</div><div class="de">When PT matures. Snaps to 00:00 UTC (Pendle convention: a Thursday).</div></div></div>
              <div class="fieldlbl" style="margin-top:11px">Maturity date (UTC)</div>
              <div class="tworow">
                <div class="dateinp">25 / 02 / 2027 &nbsp;📅</div>
                <span class="smallbtn">Next Thursday</span>
              </div>
              <div class="expiry">Expiry: <b>Thu, 25 Feb 2027, 00:00 UTC</b> <span class="sub">· unix 1803513600</span></div>
            </div>

            <div class="stepcard">
              <div class="sh"><span class="num">3</span><div><div class="ti">Rate band, launch APY and fee</div><div class="de">The implied-APY range is permanent — see the panel below.</div></div></div>
              <div class="duo">
                <div><div class="fieldlbl">Min implied APY</div><div class="pctinp"><span class="lbl">2</span><span class="pc">%</span></div></div>
                <div><div class="fieldlbl">Max implied APY</div><div class="pctinp"><span class="lbl">20</span><span class="pc">%</span></div></div>
              </div>
              <div class="duo">
                <div><div class="fieldlbl">Desired launch APY</div><div class="pctinp"><span class="lbl">10</span><span class="pc">%</span></div></div>
                <div><div class="fieldlbl">Swap fee</div><div class="pctinp"><span class="lbl">1.10</span><span class="pc">%</span></div></div>
              </div>
            </div>

            <div class="pin rev" style="right:6%; top:26.5%;"><span class="n">1</span><span class="t">Any SY</span></div>
            <div class="pin rev" style="right:6%; top:53%;"><span class="n">2</span><span class="t">Snaps to Thursday</span></div>
            <div class="pin rev" style="right:6%; top:80%;"><span class="n">3</span><span class="t">Rate band + fee</span></div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ STEP 04 — TOKEN ============ -->
    <section class="step">
      <div class="step-grid">
        <div class="rail">
          <div class="idx">STEP 04</div>
          <h2>Paste a PT or YT, not just the market</h2>
          <p>Hand OpenPendle a Principal or Yield token and it resolves the whole set on-chain, then uses Pendle's market API and, where available, public Blockscout indexes to look for its pool. Mint, redeem and claim work without the market; trading and LP link straight to it.</p>
          <ul class="notes">
            <li><span class="n">1</span><span><b>Go to the pool</b> — we resolve the market from the token and link you there.</span></li>
            <li><span class="n">2</span><span><b>Resolved set</b> — PT, YT and SY, each verified on-chain with an explorer link.</span></li>
            <li><span class="n">3</span><span><b>Market-free actions</b> — mint, redeem and claim yield, even after maturity.</span></li>
          </ul>
        </div>

        <div class="frame">
          <div class="chrome">
            <span class="tl"><i></i><i></i><i></i></span>
            <span class="urlbar"><span class="lock">🔒</span> openpendle.com<span class="u2">/#/token/0x9e3b…a1c4?chain=42161</span></span>
          </div>
          <div class="apphdr">
            <div class="brand"><span class="mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2.4 20.6 7v10L12 21.6 3.4 17V7L12 2.4Z" stroke="#6366f1" stroke-width="1.6" stroke-linejoin="round"/></svg></span><span class="wm">Open<span class="b">Pendle</span></span></div>
            <nav class="nav">
              <span class="pill"><span class="i">✦</span>Quick start</span>
              <span class="pill"><span class="i">◇</span>Explore</span>
              <span class="pill"><span class="i">◈</span>Positions</span>
              <span class="pill">Create pool</span>
              <span class="pill net"><span class="dot"></span>Arbitrum ▾</span>
              <span class="btn accent">Connect Wallet</span>
            </nav>
          </div>

          <div class="screen">
            <div class="tok-h">PT sUSDai · 25 Feb 2027</div>
            <div class="tok-sub">Act on a PT or YT directly — mint, redeem and claim work without the market. Swaps and liquidity need the market.</div>

            <div class="gopool">
              <p>Found this token's pool — trade, provide liquidity, or save it there.</p>
              <span class="btn accent" style="padding:9px 15px">Go to the pool →</span>
            </div>

            <div class="risk"><b>Unreviewed — use at your own risk.</b> OpenPendle resolved this token set from the chain but can't vouch for the SY or the asset underneath. Verify the addresses below before you transact.</div>

            <div class="card" style="margin-top:12px">
              <h4 style="margin:0;font-size:13.5px;font-weight:700;color:var(--text)">Resolved token set</h4>
              <div class="setrows">
                <div class="setrow"><span class="lft"><span class="role">PT</span>PT-sUSDai</span><span class="adr">0x9e3b…a1c4 ↗</span></div>
                <div class="setrow"><span class="lft"><span class="role">YT</span>YT-sUSDai</span><span class="adr">0x54aa…77de ↗</span></div>
                <div class="setrow"><span class="lft"><span class="role">SY</span>SY-sUSDai</span><span class="adr">0x2c1f…09b2 ↗</span></div>
              </div>
              <div style="margin-top:9px;font-size:11px;color:var(--faint)">Matures 25 Feb 2027.</div>
            </div>

            <div class="card mr" style="margin-top:12px">
              <h4 style="margin:0 0 11px;font-size:13.5px;font-weight:700;color:var(--text)">Mint &amp; redeem</h4>
              <div class="tabbar"><span class="tabbtn on">Mint PT + YT</span><span class="tabbtn">Redeem</span></div>
              <div class="field">
                <div class="top"><span>You deposit</span><span>balance —</span></div>
                <div class="amt"><span class="num">0.0</span><span class="tk">◈ sUSDai ▾</span></div>
              </div>
              <div class="cta">Enter an amount</div>
            </div>

            <div class="pin rev" style="right:5%; top:23%;"><span class="n">1</span><span class="t">Finds the pool</span></div>
            <div class="pin" style="left:3%; top:57%;"><span class="n">2</span><span class="t">Verified on-chain</span></div>
            <div class="pin" style="left:3%; top:80%;"><span class="n">3</span><span class="t">No market needed</span></div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ CLOSING ============ -->
    <section class="close">
      <div class="eyebrow">Why it's built this way</div>
      <h2>Trust-minimized by construction</h2>
      <div class="why">
        <div class="c"><div class="k">◇ No request-time backend</div><h5>Core data from the chain</h5><p>OpenPendle runs no request-time app server, user database or transaction relay. Explore reads a scheduled static snapshot built from factory events; Pendle's API adds listing/display enrichment and PT/YT lookup. Core pool data comes from an RPC you can replace.</p></div>
        <div class="c"><div class="k">◈ Injected-only</div><h5>Your wallet, direct</h5><p>Injected wallets only — no WalletConnect relays. Exact approvals by default; unlimited is an explicit, higher-exposure opt-in.</p></div>
        <div class="c"><div class="k">★ Local registry</div><h5>Stays on device</h5><p>Your saved-pool list and settings stay in your browser. The registry leaves only when you explicitly export or share it.</p></div>
        <div class="c"><div class="k">⌥ Open source</div><h5>Fork it</h5><p>GPL-3.0 and static — host it yourself on IPFS or anywhere. Six networks supported today.</p></div>
      </div>
    </section>

  </div>
</div>
`

export default function QuickStartPage() {
  useDocumentTitle('Quick start')
  return <div className="qsg" dangerouslySetInnerHTML={{ __html: GUIDE_HTML }} />
}
