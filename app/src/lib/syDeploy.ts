/**
 * M7 SY-adapter creation — pure, framework-free (erasable TS).
 *
 * SKELETON: signatures are the shared contract (UI codes against them; the
 * data-layer work fills the bodies). Ground truth for template ids, encodings,
 * and the DeployedSY event is the fork-tested research: scratchpad/pendle/
 * PendleCommonSYFactory.sol + PendleCommonPoolDeployHelperV2.sol and the
 * WORKING 16/16 suite research/fork-tests/SYFactoryFork.t.sol — port encodings
 * from there, NOT from the stale @pendle/core-v2 repo interfaces.
 *
 * Rules:
 * - Template ids = keccak256(name): PendleERC20SY, PendleERC4626SYV2,
 *   PendleERC4626NotRedeemableToAssetSYV2 (basic → deploySY); the 4 adapter/
 *   upgradeable ids → deployUpgradableSY. Basic constructorParams =
 *   abi.encode(string name, string symbol, address token). Upgradeable
 *   constructorParams = abi.encode(address token, address rewardManager=0),
 *   initData = initialize(name,symbol,adapter) for the 3 WithAdapter ids and
 *   initialize(name,symbol) for ERC4626NoRedeemNoDeposit (3-arg reverts on it).
 * - Two flows: (a) SY-only via syFactory.deploySY/deployUpgradableSY;
 *   (b) SY + PT/YT + market + seed in ONE tx via commonDeploy wrappers
 *   (deployERC20Market/deployERC4626Market/…) reusing the M6 PoolConfig.
 * - syOwner default = PENDLE_GOVERNANCE. Warn if the deployer keeps ownership
 *   (pause / setAdapter vectors). Adapter/upgradeable SYs are Transparent
 *   proxies under Pendle's proxyAdmin — disclose.
 * - Token screening MUST be browser-feasible (PLAN M7): FOT via the deploy+seed
 *   eth_call simulation (helper reverts on FOT) and/or balance-slot state-
 *   override probing; a denylist for known rebasing/FOT Arbitrum classes;
 *   probe decimals()/asset()/previewDeposit/previewRedeem. Block FOT/rebasing.
 * - Result address comes from the DeployedSY event (verify topic/shape vs the
 *   verified source) and, for the combined flow, the MarketDeployment event
 *   (reuse deploy.ts decodeDeploymentResult).
 *
 * IMPLEMENTATION NOTES (this file, filled by the M7 data-layer work):
 * - constructorParams encodings are the fork-verified ones. Basic 3:
 *   abi.encode(string,string,address). Upgradeable 4:
 *   abi.encode(address token, address rewardManager=0). initData: 3 WithAdapter
 *   → initialize(string,string,address); NoRedeemNoDeposit → initialize(string,
 *   string). Empty initData reverts, and deploySY on an upgradeable id reverts
 *   (its impl runs _disableInitializers, so the factory's ownership transfer
 *   fails). Both are surfaced through decodePendleError in the wizard.
 * - The FOT screen is a real BROWSER mechanism, not a forge re-run: an eth_call
 *   transfer-delta measured under a state override (inject a balance into a
 *   scratch probe contract, transfer to a sink, read the delta). It degrades to
 *   'unknown' where the RPC rejects overrides. A curated denylist flags known
 *   Arbitrum rebasing/FOT classes (aTokens etc.) as 'suspected'.
 */

import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  pad,
  toHex,
} from 'viem'
import type { Address, PublicClient } from 'viem'
import type {
  ActionPlan,
  AssetProbe,
  PoolConfig,
  ScreenVerdict,
  SyDeployConfig,
  SyDeployResult,
  SyTemplateId,
} from './types.ts'
import { COMMON_DEPLOY, PENDLE_PROXY_ADMIN, SY_FACTORY } from './addresses.ts'
import {
  commonDeploySyMarketAbi,
  erc20MetaAbi,
  erc4626ProbeAbi,
  syFactoryAbi,
} from './pendleAbi.ts'
import { decodeDeploymentResult } from './deploy.ts'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

// ---------------------------------------------------------------------------
// Template registry — keccak256(name) ids (fork-verified against the on-chain
// registered ids; see the digest in docs/research/pendle-v2-research.md and the
// constants in the Arbiscan-verified PendleCommonPoolDeployHelperV2.sol).
// ---------------------------------------------------------------------------

interface TemplateSpec {
  /** keccak256 of the implementation contract name (the on-chain deploy id). */
  id: `0x${string}`
  /** true → deployUpgradableSY (TransparentUpgradeableProxy); false → deploySY. */
  upgradeable: boolean
  /** true → its initData is initialize(name,symbol,adapter); false (NDNR) →
   *  initialize(name,symbol). Undefined for the basic (non-upgradeable) ids. */
  adapterInit?: boolean
  /** commonDeploy combined-flow wrapper; undefined → route via deployCommonMarketById. */
  marketFn?: string
}

/**
 * The 7 registered templates. Ids are the literal keccak256 hashes — verified
 * identical to `cast keccak <name>` AND to the on-chain `creationCodes(id)`
 * registrations (research digest 2026-07-03). Kept as literals (not recomputed)
 * so this stays a pure erasable module and the values are auditable at a glance.
 */
const TEMPLATES: Record<SyTemplateId, TemplateSpec> = {
  erc20: {
    id: '0xfcf22a9a515753d83e4f2a81cf368c7226408c64f52411ae95241ebf5ed53304',
    upgradeable: false,
    marketFn: 'deployERC20Market',
  },
  erc4626: {
    id: '0x1278efc0e6754cd30fef2df25ff5ced072ebb194d348b0b1b9548166d24352ef',
    upgradeable: false,
    marketFn: 'deployERC4626Market',
  },
  'erc4626-not-redeemable': {
    id: '0x6f089cd4afdd945c5c26b3f4542d0c294d19ec0e339c6ce4f8eafa94d700d05d',
    upgradeable: false,
    marketFn: 'deployERC4626NotRedeemableMarket',
  },
  'erc20-adapter': {
    id: '0xe5cce2b1999bf8c2cc4cf6d96d0569a24d8b782ba1647c09a8e1aa8bbfb98996',
    upgradeable: true,
    adapterInit: true,
    marketFn: 'deployERC20WithAdapterMarket',
  },
  'erc4626-adapter': {
    id: '0x73f41560741d6765943d3c955034291fe23d9141e3a4719bc97422d5bf019adc',
    upgradeable: true,
    adapterInit: true,
    marketFn: 'deployERC4626WithAdapterMarket',
  },
  'erc4626-noredeem-adapter': {
    id: '0x3b8dd2b992f773444e5422ba1db289c4657c57110d740dca7975dc095632ef23',
    upgradeable: true,
    adapterInit: true,
    marketFn: 'deployERC4626NoRedeemWithAdapterMarket',
  },
  'erc4626-noredeem-nodeposit': {
    id: '0x5c1cddc0128e0b02bb711f84a022bf1c13177d4ab028830b702f3a77280025ea',
    upgradeable: true,
    adapterInit: false, // 3-arg initialize reverts; uses initialize(name,symbol)
    // no dedicated commonDeploy wrapper → deployCommonMarketById
  },
}

/** keccak256 template id + which factory entrypoint a template uses. */
export function templateInfo(_template: SyTemplateId): {
  id: `0x${string}`
  upgradeable: boolean
} {
  const spec = TEMPLATES[_template]
  return { id: spec.id, upgradeable: spec.upgradeable }
}

// ---------------------------------------------------------------------------
// SY-only unseeded-deploy screening gate (FIX 1 / PLAN §5 M7 line 230).
// ---------------------------------------------------------------------------

/**
 * The basic templates route through `deploySY` (no seeding). They are exactly
 * the non-upgradeable ids (erc20 / erc4626 / erc4626-not-redeemable). This is
 * the set that, deployed SY-ONLY (unseeded), has NO on-chain backstop against a
 * fee-on-transfer / rebasing asset — so the token screen must be the gate.
 */
export function isBasicTemplate(_template: SyTemplateId): boolean {
  return !TEMPLATES[_template].upgradeable
}

/**
 * Whether a token's screen genuinely PASSED for an unseeded SY-only deploy of a
 * basic template (PLAN §5 M7 line 230). Passing requires a clean fee-on-transfer
 * verdict ('ok', i.e. the state-override probe actually ran and delivered a full
 * transfer) AND rebasing that is not 'suspected'. An 'unknown' FOT verdict
 * (state overrides unsupported / no balance slot found) does NOT pass — the
 * unseeded path silently under-collateralizes on an FOT/rebasing SY, and unlike
 * the combined deploy+seed flow there is no seeding revert to catch it.
 *
 * Callers use this ONLY for the SY-only + basic-template combination; the
 * combined (deploy+seed) flow keeps its on-chain seeding-revert backstop and the
 * upgradeable/adapter templates are out of the unseeded-basic set.
 */
export function screenPassedForUnseededSyOnly(probe: {
  feeOnTransfer: ScreenVerdict
  rebasing: ScreenVerdict
}): boolean {
  return probe.feeOnTransfer === 'ok' && probe.rebasing !== 'suspected'
}

/**
 * Does an unseeded SY-only deploy of `template` on `probe` need the explicit
 * "deploy anyway" override? True when it's a basic (unseeded) template AND the
 * screen did not genuinely pass. Combined-flow and upgradeable templates never
 * need the hard override (the combined seeding revert is their backstop).
 */
export function syOnlyDeployNeedsOverride(
  template: SyTemplateId,
  probe: { feeOnTransfer: ScreenVerdict; rebasing: ScreenVerdict },
): boolean {
  return isBasicTemplate(template) && !screenPassedForUnseededSyOnly(probe)
}

// ---------------------------------------------------------------------------
// constructorParams / initData encoders (fork-verified).
// ---------------------------------------------------------------------------

/** Basic templates: abi.encode(string name, string symbol, address token). */
function encodeBasicConstructorParams(
  name: string,
  symbol: string,
  token: Address,
): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'address' }],
    [name, symbol, token],
  )
}

/**
 * Upgradeable templates: abi.encode(address token, address rewardManager).
 * rewardManager = address(0) is fork-accepted (only disables Merkl offchain
 * reward claims).
 */
function encodeUpgradeableConstructorParams(token: Address): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }],
    [token, ZERO_ADDRESS],
  )
}

/**
 * initData for an upgradeable template. The 3 WithAdapter ids →
 * initialize(name,symbol,adapter) (adapter = address(0) → plain 1:1 wrapper,
 * settable later by the SY owner). NoRedeemNoDeposit → initialize(name,symbol)
 * (the 3-arg form reverts on it). Empty initData is NEVER produced — it reverts.
 */
function encodeInitData(
  spec: TemplateSpec,
  name: string,
  symbol: string,
  adapter: Address,
): `0x${string}` {
  if (spec.adapterInit) {
    return encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'initialize',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'name', type: 'string' },
            { name: 'symbol', type: 'string' },
            { name: 'adapter', type: 'address' },
          ],
          outputs: [],
        },
      ],
      functionName: 'initialize',
      args: [name, symbol, adapter],
    })
  }
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'initialize',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
        ],
        outputs: [],
      },
    ],
    functionName: 'initialize',
    args: [name, symbol],
  })
}

// ---------------------------------------------------------------------------
// Screening — browser-feasible token classification (PLAN §5 M7).
// ---------------------------------------------------------------------------

/**
 * Curated denylist of known Arbitrum rebasing / fee-on-transfer token classes
 * whose accounting the common SY templates do NOT support (fork-verified: a
 * negative rebase breaks redemption; FOT under-collateralizes / reverts). This
 * is a small, documented set — NOT exhaustive; the state-override transfer-delta
 * probe is the general FOT catcher, and the deploy+seed eth_call simulation is
 * the ultimate backstop (the helper's seeding reverts on FOT). Addresses are
 * lower-cased for comparison.
 *
 * Sources (Arbitrum One):
 * - Aave v3 aTokens rebase balances (aArbUSDC, aArbWETH, aArbUSDT, aArbDAI,
 *   aArbUSDCn) — rebasing; excluded by every common template.
 * - Lido wstETH is NON-rebasing (safe) but stETH-style rebasing wrappers are
 *   not; we do not list wstETH.
 */
const DENYLIST: Record<string, { class: string; kind: 'rebasing' | 'fot' }> = {
  // Aave v3 Arbitrum aTokens (rebasing).
  '0x625e7708f30ca75bfd92586e17077590c60eb4cd': { class: 'Aave aArbUSDC', kind: 'rebasing' },
  '0x724dc807b04555b71ed48a6896b6f41593b8c637': { class: 'Aave aArbUSDCn', kind: 'rebasing' },
  '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8': { class: 'Aave aArbWETH', kind: 'rebasing' },
  '0x6ab707aca953edaefbc4fd23ba73294241490620': { class: 'Aave aArbUSDT', kind: 'rebasing' },
  '0x82e64f49ed5ec1bc6e43dad4fc8af9bb3a2312ee': { class: 'Aave aArbDAI', kind: 'rebasing' },
}

/** Runtime bytecode of FotDeltaProbe.sol (forge 0.8.26/cancun build). See
 *  scripts/m7-sy-test.mjs for the source. Injected at a scratch address via an
 *  eth_call state override; probe(address token, address sink, uint256 amount)
 *  returns the amount `sink` actually received after a transfer. */
const FOT_DELTA_PROBE_RUNTIME =
  '0x608060405234801561000f575f80fd5b5060043610610029575f3560e01c8063dd8e5ec91461002d575b5f80fd5b61004061003b3660046101cc565b610052565b60405190815260200160405180910390f35b6040516370a0823160e01b81526001600160a01b0383811660048301525f9182918616906370a0823190602401602060405180830381865afa15801561009a573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906100be9190610205565b60405163a9059cbb60e01b81526001600160a01b038681166004830152602482018690529192509086169063a9059cbb906044016020604051808303815f875af115801561010e573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610132919061021c565b506040516370a0823160e01b81526001600160a01b0385811660048301528291908716906370a0823190602401602060405180830381865afa15801561017a573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061019e9190610205565b6101a89190610242565b95945050505050565b80356001600160a01b03811681146101c7575f80fd5b919050565b5f805f606084860312156101de575f80fd5b6101e7846101b1565b92506101f5602085016101b1565b9150604084013590509250925092565b5f60208284031215610215575f80fd5b5051919050565b5f6020828403121561022c575f80fd5b8151801515811461023b575f80fd5b9392505050565b8181038181111561026157634e487b7160e01b5f52601160045260245ffd5b9291505056fea26469706673582212209e41481dc3f1cf7327ab647a75faafccca78a078dedd03f4ce1bdd8b0b509f6f64736f6c634300081a0033' as const

/** Scratch addresses used ONLY inside eth_call state overrides (never on-chain). */
const PROBE_ADDR = '0x00000000000000000000000000000000000f0700' as const
const SINK_ADDR = '0x00000000000000000000000000000000000f0511' as const

const probeAbi = [
  {
    type: 'function',
    name: 'probe',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'sink', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'received', type: 'uint256' }],
  },
] as const

/** keccak256(abi.encode(holder, uint256(slot))) — Solidity `mapping(address=>x)` key. */
function balanceMappingKey(holder: Address, slot: bigint): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, slot]),
  )
}

/** keccak256(abi.encode(uint256(slot), holder)) — Vyper's HashMap key ordering. */
function balanceMappingKeyVyper(holder: Address, slot: bigint): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [slot, holder]),
  )
}

/**
 * Fee-on-transfer screen via an eth_call transfer-delta under a state override.
 *
 * Mechanism (browser-feasible, no tx): find the token's balance slot by trying
 * candidate Solidity slots (inject a value at keccak(probe,slot) and read it
 * back via balanceOf), then in ONE eth_call inject that balance into a scratch
 * PROBE contract (whose runtime code we also inject) and have it transfer to a
 * fresh SINK, returning how much SINK actually received. received < amount ⇒
 * fee-on-transfer. If the RPC rejects state overrides (or no slot is found),
 * degrade to 'unknown' — the deploy+seed simulation remains the backstop.
 */
async function screenFeeOnTransfer(
  client: PublicClient,
  token: Address,
  decimals: number,
): Promise<ScreenVerdict> {
  const amount = 10n ** BigInt(Math.min(decimals, 30)) // 1 token in raw units
  // Locate the balance slot for PROBE_ADDR. We try BOTH the Solidity
  // keccak(holder, slot) ordering AND the Vyper keccak(slot, holder) ordering to
  // reduce false 'unknown's on Vyper/proxy tokens (FIX 4), but keep the total
  // candidate count bounded (~24) so a miss doesn't balloon into hundreds of
  // sequential state-override eth_calls. Solidity slots are the common case, so
  // they get the wider range; Vyper's ordering only the low slots.
  const candidates: `0x${string}`[] = []
  for (let slot = 0n; slot < 16n; slot++) candidates.push(balanceMappingKey(PROBE_ADDR, slot))
  for (let slot = 0n; slot < 8n; slot++) candidates.push(balanceMappingKeyVyper(PROBE_ADDR, slot))

  let slotKey: `0x${string}` | undefined
  let firstAttempt = true
  for (const key of candidates) {
    try {
      const read = (await client.readContract({
        address: token,
        abi: erc20MetaAbi,
        functionName: 'balanceOf',
        args: [PROBE_ADDR],
        stateOverride: [
          { address: token, stateDiff: [{ slot: key, value: pad(toHex(amount), { size: 32 }) }] },
        ],
      })) as bigint
      firstAttempt = false
      if (read === amount) {
        slotKey = key
        break
      }
    } catch {
      // First attempt failing ⇒ the node rejects state overrides entirely →
      // cannot probe. A later failure is just a reverting slot read → keep
      // trying the other candidate slots.
      if (firstAttempt) return 'unknown'
    }
  }
  if (slotKey === undefined) return 'unknown'
  try {
    const received = (await client.readContract({
      address: PROBE_ADDR,
      abi: probeAbi,
      functionName: 'probe',
      args: [token, SINK_ADDR, amount],
      stateOverride: [
        { address: PROBE_ADDR, code: FOT_DELTA_PROBE_RUNTIME },
        { address: token, stateDiff: [{ slot: slotKey, value: pad(toHex(amount), { size: 32 }) }] },
      ],
    })) as bigint
    // Allow a tiny rounding tolerance; any material shortfall ⇒ FOT.
    return received < amount ? 'suspected' : 'ok'
  } catch {
    return 'unknown'
  }
}

/**
 * Interface fingerprints of known rebasing token classes. The denylist only
 * covers a handful of Arbitrum addresses; this catches the whole CLASS by its
 * ABI shape instead of a hardcoded address, so a rebaser that isn't on the
 * denylist (a new aToken, a fork, another chain's deployment) is still flagged.
 *
 * These are all `view` and non-reverting only on the matching token class — a
 * plain ERC-20 simply reverts them, so the multicall (allowFailure) treats a
 * revert as "not this class". We look for a SIGNATURE MATCH, not a value.
 *
 * - Aave aToken: `scaledBalanceOf(address)` + `UNDERLYING_ASSET_ADDRESS()` (its
 *   balanceOf grows as the reserve accrues — rebasing). `POOL()` corroborates.
 * - stETH-style: `getPooledEthByShares(uint256)` (Lido's rebasing accounting;
 *   note wstETH is the NON-rebasing wrapper and does NOT expose it).
 * - Origin/OUSD-style: `rebaseOptIn()` / `rebasingCreditsPerToken()`.
 */
const rebaseFingerprintAbi = [
  { type: 'function', name: 'scaledBalanceOf', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'UNDERLYING_ASSET_ADDRESS', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'POOL', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getPooledEthByShares', stateMutability: 'view', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'rebasingCreditsPerToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

/**
 * Rebasing screen by INTERFACE FINGERPRINT (supplements the address denylist).
 * Returns 'suspected' + the matched class name when the token exposes a known
 * rebaser's signature; 'ok' otherwise (a clean read that matched nothing).
 * Never returns 'unknown' from here — the reads are view + allowFailure, so a
 * total miss is a legitimate "no fingerprint", which is the 'ok' contribution.
 */
async function screenRebasingFingerprint(
  client: PublicClient,
  token: Address,
): Promise<{ verdict: ScreenVerdict; matched?: string }> {
  try {
    const [scaledBal, underlying, pool, pooledEth, rebaseCredits] = await client.multicall({
      contracts: [
        { address: token, abi: rebaseFingerprintAbi, functionName: 'scaledBalanceOf', args: [token] },
        { address: token, abi: rebaseFingerprintAbi, functionName: 'UNDERLYING_ASSET_ADDRESS' },
        { address: token, abi: rebaseFingerprintAbi, functionName: 'POOL' },
        { address: token, abi: rebaseFingerprintAbi, functionName: 'getPooledEthByShares', args: [10n ** 18n] },
        { address: token, abi: rebaseFingerprintAbi, functionName: 'rebasingCreditsPerToken' },
      ],
      allowFailure: true,
    })
    // Aave aToken: scaledBalanceOf + (UNDERLYING_ASSET_ADDRESS or POOL).
    if (
      scaledBal.status === 'success' &&
      (underlying.status === 'success' || pool.status === 'success')
    ) {
      return { verdict: 'suspected', matched: 'Aave aToken-style (scaledBalanceOf) rebasing token' }
    }
    // stETH-style pooled-ETH rebasing.
    if (pooledEth.status === 'success') {
      return { verdict: 'suspected', matched: 'stETH-style (getPooledEthByShares) rebasing token' }
    }
    // Origin/OUSD-style credits-per-token rebasing.
    if (rebaseCredits.status === 'success') {
      return { verdict: 'suspected', matched: 'Origin/OUSD-style (rebasingCreditsPerToken) rebasing token' }
    }
    return { verdict: 'ok' }
  } catch {
    // A total multicall failure (RPC issue) is inconclusive — treat as 'unknown'
    // so FIX 1's gate counts it toward "not fully screened" for the SY-only path.
    return { verdict: 'unknown' }
  }
}

/** Probe an asset → ERC-4626 detection, template suggestion, and FOT/rebasing screening. */
export async function probeAsset(_client: PublicClient, _asset: Address): Promise<AssetProbe> {
  const asset = getAddress(_asset)
  const notes: string[] = []
  const blockers: string[] = []

  // --- Metadata (symbol / decimals). decimals() MUST exist. -------------------
  const [symbolRes, decimalsRes, nameRes] = await _client.multicall({
    contracts: [
      { address: asset, abi: erc20MetaAbi, functionName: 'symbol' },
      { address: asset, abi: erc20MetaAbi, functionName: 'decimals' },
      { address: asset, abi: erc20MetaAbi, functionName: 'name' },
    ],
    allowFailure: true,
  })

  const symbol = symbolRes.status === 'success' ? (symbolRes.result as string) : ''
  const hasDecimals = decimalsRes.status === 'success'
  const decimals = hasDecimals ? Number(decimalsRes.result as number) : 18
  void nameRes
  if (!hasDecimals) {
    blockers.push('Token does not expose decimals() — SY templates require it.')
  }

  // --- ERC-4626 detection: asset() + convertToAssets both succeed. -----------
  const [assetRes, convRes, prevDepRes, prevRedRes] = await _client.multicall({
    contracts: [
      { address: asset, abi: erc4626ProbeAbi, functionName: 'asset' },
      { address: asset, abi: erc4626ProbeAbi, functionName: 'convertToAssets', args: [10n ** 18n] },
      { address: asset, abi: erc4626ProbeAbi, functionName: 'previewDeposit', args: [10n ** 18n] },
      { address: asset, abi: erc4626ProbeAbi, functionName: 'previewRedeem', args: [10n ** 18n] },
    ],
    allowFailure: true,
  })

  const isErc4626 = assetRes.status === 'success' && convRes.status === 'success'
  let underlying: Address | undefined
  let underlyingSymbol: string | undefined
  let suggested: SyTemplateId = 'erc20'

  if (isErc4626) {
    suggested = 'erc4626'
    underlying = getAddress(assetRes.result as Address)
    // A 4626 that is missing preview* is a hard block for the basic templates.
    if (prevDepRes.status !== 'success' || prevRedRes.status !== 'success') {
      blockers.push(
        'ERC-4626 vault is missing previewDeposit/previewRedeem — not supported by the basic 4626 template.',
      )
    }
    try {
      underlyingSymbol = (await _client.readContract({
        address: underlying,
        abi: erc20MetaAbi,
        functionName: 'symbol',
      })) as string
    } catch {
      underlyingSymbol = undefined
    }
    notes.push(`Detected ERC-4626 vault; underlying = ${underlyingSymbol ?? underlying}.`)
  } else {
    notes.push('Plain ERC-20 detected — suggesting the PendleERC20SY (1:1) template.')
  }

  // --- Denylist (known Arbitrum rebasing/FOT classes). -----------------------
  let feeOnTransfer: ScreenVerdict = 'unknown'
  let rebasing: ScreenVerdict = 'ok'
  const deny = DENYLIST[asset.toLowerCase()]
  if (deny) {
    if (deny.kind === 'rebasing') {
      rebasing = 'suspected'
      blockers.push(
        `${deny.class} is a known rebasing token — its balance drifts and breaks SY 1:1 accounting.`,
      )
    } else {
      feeOnTransfer = 'suspected'
      blockers.push(
        `${deny.class} is a known fee-on-transfer token — it under-collateralizes the SY.`,
      )
    }
  }

  // --- Rebasing interface-fingerprint screen (supplements the denylist). ------
  // The denylist is 5 addresses; this catches the whole CLASS by its ABI shape
  // (aToken scaledBalanceOf, stETH getPooledEthByShares, OUSD credits-per-token)
  // so an off-denylist rebaser is still blocked. Skip if already 'suspected'.
  if (rebasing !== 'suspected') {
    const fp = await screenRebasingFingerprint(_client, asset)
    if (fp.verdict === 'suspected') {
      rebasing = 'suspected'
      blockers.push(
        `${fp.matched ?? 'Rebasing token'} — its balance drifts on rebases and breaks SY 1:1 accounting.`,
      )
    } else if (fp.verdict === 'unknown') {
      // Inconclusive probe (RPC failure) — leave rebasing 'unknown' so the
      // SY-only gate (FIX 1) counts it toward "not fully screened".
      rebasing = 'unknown'
      notes.push(
        'Could not run the rebasing fingerprint probe (RPC read failed); treat this token as not fully screened for an unseeded SY-only deploy.',
      )
    }
  }

  // --- Fee-on-transfer state-override probe (skip if already denylisted). -----
  // Probe the token that actually moves through the SY's transferIn: for a 4626
  // vault the seed/deposit token is the underlying asset, but the FOT failure
  // the SY templates hit is on the yieldToken/asset transfer — probe the asset
  // address the user picked (the yieldToken for erc20, the vault for 4626; the
  // vault's own transfer is what the helper seeds with in the vault-seed path).
  if (feeOnTransfer === 'unknown' && rebasing !== 'suspected') {
    feeOnTransfer = await screenFeeOnTransfer(_client, asset, decimals)
    if (feeOnTransfer === 'suspected') {
      blockers.push(
        'Fee-on-transfer detected (a test transfer delivered less than sent) — it under-collateralizes the SY.',
      )
    } else if (feeOnTransfer === 'unknown') {
      notes.push(
        'Could not run the fee-on-transfer probe (RPC rejected state overrides); the deploy simulation is the backstop.',
      )
    }
  }

  // --- Template-specific disclosures. ----------------------------------------
  notes.push(
    'The syOwner defaults to Pendle governance (can pause; for adapter SYs can setAdapter). Keeping ownership yourself is a rug vector for depositors.',
  )
  if (suggested === 'erc20') {
    notes.push(
      'PendleERC20SY assumes a non-rebasing, non-fee-on-transfer ERC-20 (1 share = 1 token).',
    )
  }

  return {
    address: asset,
    symbol,
    decimals,
    isErc4626,
    underlying,
    underlyingSymbol,
    suggested,
    feeOnTransfer,
    rebasing,
    notes,
    blockers,
  }
}

// ---------------------------------------------------------------------------
// Deploy planners.
// ---------------------------------------------------------------------------

/** SY-only deploy via syFactory.deploySY / deployUpgradableSY. Approvals: none (deploy only). */
export function planDeploySyOnly(_config: SyDeployConfig): ActionPlan {
  const spec = TEMPLATES[_config.template]
  const asset = getAddress(_config.asset)
  const syOwner = getAddress(_config.syOwner)

  if (!spec.upgradeable) {
    // deploySY(id, abi.encode(name, symbol, token), syOwner)
    const constructorParams = encodeBasicConstructorParams(_config.name, _config.symbol, asset)
    return {
      describe: `Deploy ${_config.symbol} (SY-only) via Pendle syFactory`,
      approvals: [],
      call: {
        address: SY_FACTORY,
        abi: syFactoryAbi,
        functionName: 'deploySY',
        args: [spec.id, constructorParams, syOwner] as const,
      },
    }
  }

  // deployUpgradableSY(id, abi.encode(token, 0), initData, syOwner)
  const constructorParams = encodeUpgradeableConstructorParams(asset)
  const adapter = _config.adapter ? getAddress(_config.adapter) : ZERO_ADDRESS
  const initData = encodeInitData(spec, _config.name, _config.symbol, adapter)
  return {
    describe: `Deploy ${_config.symbol} (SY-only, upgradeable proxy) via Pendle syFactory`,
    approvals: [],
    call: {
      address: SY_FACTORY,
      abi: syFactoryAbi,
      functionName: 'deployUpgradableSY',
      args: [spec.id, constructorParams, initData, syOwner] as const,
    },
  }
}

/**
 * Combined SY + PT/YT + market + seed in one tx via the commonDeploy wrapper
 * for the chosen template (reuses the M6 PoolConfig).
 *
 * The commonDeploy market wrappers (deployERC20Market / …WithAdapterMarket /
 * deployCommonMarketById) are NOT payable — attaching `value` reverts. Native
 * ETH combined seeding is therefore unsupported by these wrappers (the wizard
 * never passes address(0) as the seed here), and the seed is ALWAYS an
 * ERC-20/4626 token pulled via transferFrom → the plan always emits the single
 * ERC-20 seed approval and never sets `value` (FIX 3).
 */
export function planDeploySyAndMarket(
  _config: SyDeployConfig,
  _pool: PoolConfig,
  _seedToken: Address,
  _seedTokenSymbol: string,
  _seedTokenDecimals: number,
  _seedAmount: bigint,
  _receiver: Address,
): ActionPlan {
  void _receiver
  const spec = TEMPLATES[_config.template]
  const asset = getAddress(_config.asset)
  const syOwner = getAddress(_config.syOwner)
  const seedToken = getAddress(_seedToken)

  const poolStruct = {
    expiry: _pool.expiry,
    rateMin: _pool.rateMin,
    rateMax: _pool.rateMax,
    desiredImpliedRate: _pool.desiredImpliedRate,
    fee: _pool.fee,
  }

  let call: ActionPlan['call']
  if (!spec.upgradeable) {
    const constructorParams = encodeBasicConstructorParams(_config.name, _config.symbol, asset)
    call = {
      address: COMMON_DEPLOY,
      abi: commonDeploySyMarketAbi,
      functionName: spec.marketFn as string,
      args: [constructorParams, poolStruct, seedToken, _seedAmount, syOwner] as const,
    }
  } else {
    const constructorParams = encodeUpgradeableConstructorParams(asset)
    const adapter = _config.adapter ? getAddress(_config.adapter) : ZERO_ADDRESS
    const initData = encodeInitData(spec, _config.name, _config.symbol, adapter)
    if (spec.marketFn) {
      // deploy{ERC20,ERC4626,ERC4626NoRedeem}WithAdapterMarket
      call = {
        address: COMMON_DEPLOY,
        abi: commonDeploySyMarketAbi,
        functionName: spec.marketFn,
        args: [constructorParams, initData, poolStruct, seedToken, _seedAmount, syOwner] as const,
      }
    } else {
      // NoRedeemNoDeposit: no dedicated wrapper → deployCommonMarketById(id, …)
      call = {
        address: COMMON_DEPLOY,
        abi: commonDeploySyMarketAbi,
        functionName: 'deployCommonMarketById',
        args: [
          spec.id,
          constructorParams,
          initData,
          poolStruct,
          seedToken,
          _seedAmount,
          syOwner,
        ] as const,
      }
    }
  }

  return {
    describe: `Deploy ${_config.symbol} + pool and seed ${_seedTokenSymbol || 'the token'}`,
    approvals: [
      {
        token: seedToken,
        spender: COMMON_DEPLOY,
        amount: _seedAmount,
        symbol: _seedTokenSymbol,
        decimals: _seedTokenDecimals,
      },
    ],
    call,
  }
}

// ---------------------------------------------------------------------------
// Result decoding.
// ---------------------------------------------------------------------------

/** DeployedSY(bytes32 id, bytes constructorParams, address SY) — topic0 below,
 *  no indexed fields (verified source), so SY sits in `data`. */
const DEPLOYED_SY_TOPIC0 =
  '0x07a80415c524a669398df01e97c487fc00986190468c09e2741b44181c5dc8c3'

/** Decode DeployedSY from a raw log; undefined if the log isn't one / fails. */
function decodeOneDeployedSy(log: {
  topics?: readonly string[]
  data?: string
}): Address | undefined {
  const topics = log.topics
  if (!topics || topics.length === 0) return undefined
  if (topics[0]?.toLowerCase() !== DEPLOYED_SY_TOPIC0) return undefined
  try {
    const decoded = decodeEventLog({
      abi: syFactoryAbi,
      eventName: 'DeployedSY',
      topics: topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: (log.data ?? '0x') as `0x${string}`,
    })
    const sy = (decoded.args as { SY: Address }).SY
    return getAddress(sy)
  } catch {
    return undefined
  }
}

/** Decode DeployedSY (+ MarketDeployment for the combined flow) from a receipt's logs. */
export function decodeSyDeployResult(_logs: readonly unknown[]): SyDeployResult | undefined {
  let sy: Address | undefined
  for (const log of _logs) {
    const found = decodeOneDeployedSy(log as { topics?: readonly string[]; data?: string })
    if (found) {
      sy = found
      break
    }
  }
  if (!sy) return undefined

  // Combined flow: a MarketDeployment log is also present — reuse deploy.ts.
  const market = decodeDeploymentResult(_logs)
  if (market) {
    return {
      // Prefer the SY from MarketDeployment (identical); both are the same SY.
      sy: market.sy,
      market: market.market,
      pt: market.pt,
      yt: market.yt,
    }
  }
  return { sy }
}

// Re-export the proxyAdmin for the wizard's upgradeability disclosure (the SY
// created via deployUpgradableSY is a TransparentUpgradeableProxy under it).
export const SY_UPGRADEABLE_PROXY_ADMIN = PENDLE_PROXY_ADMIN
