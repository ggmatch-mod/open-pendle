/**
 * M6 community pool creation — pure, framework-free (erasable TS).
 *
 * SKELETON: signatures are the shared contract (UI codes against them; the
 * data-layer work fills the bodies). Rules:
 * - The deploy tx is commonDeploy.deploy5115MarketAndSeedLiquidity(SY,
 *   PoolConfig, tokenToSeed, amountToSeed) — the contract computes
 *   scalarRoot/initialAnchor/lnFeeRateRoot from PoolConfig ON-CHAIN.
 *   computeDeployParams mirrors MarketDeployLib in FLOATING POINT for the
 *   education UI / preview ONLY — it is NEVER used to build the tx.
 * - Seed token must be the SY itself or in SY.getTokensIn(); native ETH →
 *   value on the call, no approval; else approve tokenToSeed → COMMON_DEPLOY.
 * - Preflight = pure validation (expiry future + % expiryDivisor (read LIVE),
 *   rateMax>rateMin, fee cap ln(1.05), desiredImpliedRate strictly in band,
 *   SY implements IStandardizedYield, getPT(SY,expiry) on the active YCF →
 *   reuse notice, legacy-YCF scan → parallel-PT warning) THEN a full eth_call
 *   simulation of the exact deploy call from the user's address (the binding
 *   check — it exercises the on-chain param math + seeding).
 * - Result comes from the commonDeploy MarketDeployment event
 *   (topic0 0xd1f8866e1ab220ea57cc2bc3d029810357a6f6df863760170473f9df5b322ebd,
 *   payload PoolDeploymentAddrs{SY,PT,YT,market}) — verify the exact ABI
 *   against the Arbiscan-verified commonDeploy source before decoding.
 * - Recovery: bounded MarketDeployment event scan filtered by deployer from a
 *   checkpoint block, and/or extract from a pasted tx hash's receipt.
 * - Front-run edge: on MarketFactoryMarketExists (0x4a588866) the scalarRoot/
 *   anchor tuple collided (same-timestamp) — resolve the existing market by a
 *   BOUNDED recent CreateNewMarket scan (topic2 = PT) or retry next block.
 *
 * ABI note (correction vs the stale @pendle/core-v2 repo interface): the repo's
 * IPCommonPoolDeployHelperV2 OMITS deploy5115MarketAndSeedLiquidity (the entry
 * point this whole module targets) and its deployCommonMarketById lacks the
 * `initData` param the deployed contract takes. All ABIs here come from the
 * Arbiscan-verified PendleCommonPoolDeployHelperV2 / PendlePoolDeployHelperV2
 * sources (commonDeployPoolAbi / ycfDeployProbeAbi in pendleAbi.ts).
 *
 * MarketDeployment is NOT indexed (both structs sit entirely in `data`), so
 * recovery filters by the tx sender, never by an indexed topic.
 */

import { decodeEventLog, getAddress, numberToHex } from 'viem'
import type { Address, Log, PublicClient } from 'viem'
import type {
  ActionPlan,
  DeployPreflight,
  DeployResult,
  DerivedDeployParams,
  PoolConfig,
} from './types.ts'
import {
  ARBITRUM_CHAIN_ID,
  COMMON_DEPLOY,
  FACTORY_GENERATIONS,
} from './addresses.ts'
import {
  commonDeployPoolAbi,
  erc20Abi,
  marketFactoryAbi,
  syReadAbi,
  ycfDeployProbeAbi,
} from './pendleAbi.ts'
import { decodePendleError } from './txflow.ts'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'
const ONE_E18 = 10n ** 18n
const YEAR_SECONDS = 365 * 86400
/** ln(1.05)·1e18 — the lnFeeRateRoot cap. Read live in preflight; this is the fallback/expectation. */
const MAX_LN_FEE_RATE_ROOT = 48790164169432003n

/** Active generation (last entry) — its YCF answers the duplicate-PT / expiryDivisor reads. */
const ACTIVE_GEN = FACTORY_GENERATIONS[FACTORY_GENERATIONS.length - 1]

function isNative(token: Address): boolean {
  return token.toLowerCase() === ZERO_ADDRESS
}

/** Round a non-negative float to the nearest bigint (matches Solidity's floor-ish result closely enough for a DISPLAY mirror). */
function floatToWad(x: number): bigint {
  if (!Number.isFinite(x) || x < 0) return 0n
  return BigInt(Math.round(x))
}

// ---------------------------------------------------------------------------
// MarketDeployLib float mirror (DISPLAY ONLY)
// ---------------------------------------------------------------------------

/**
 * Floating-point mirror of MarketDeployLib.calcParams/calcFee/calcInitialProportion
 * — DISPLAY ONLY. The tx uses the on-chain computation regardless.
 *
 * Solidity semantics reproduced (verified against scratchpad MarketDeployLib.sol):
 *  - yearsToExpiry T = (expiry − now) / YEAR  [seconds → years, a float]
 *  - rateMinScaled = (1 + rateMin/1e18)^T ,  rateMaxScaled = (1 + rateMax/1e18)^T
 *      (Solidity: (rate+ONE).pow(T·1e18) via LogExpMath = exp(T·ln(base)))
 *  - initialRateAnchor = (rateMinScaled + rateMaxScaled) / 2      [1e18-scaled]
 *  - scalarRoot = LN_9 · T / (rateMaxScaled − initialRateAnchor)  [1e18-scaled]
 *  - lnFeeRateRoot = ln(1 + fee/1e18) · 1e18
 *  - initialProportion = logitP / (1 + logitP), where
 *      desiredExchangeRate = (1 + desired/1e18)^T
 *      rateScalar          = scalarRoot · YEAR / (expiry − now)   [float]
 *      logitP              = exp((desiredExchangeRate − initialAnchorFloat) · rateScalar)
 */
export function computeDeployParams(config: PoolConfig, nowSeconds: number): DerivedDeployParams {
  const secondsToExpiry = config.expiry - nowSeconds
  // Guard: a non-future expiry has no meaningful preview — return zeros so the
  // hard checks (not this mirror) own the error. Preflight blocks this anyway.
  if (secondsToExpiry <= 0) {
    return {
      scalarRoot: 0n,
      initialAnchor: 0n,
      lnFeeRateRoot: floatToWad(Math.log(1 + Number(config.fee) / 1e18) * 1e18),
      initialProportion: 0,
      yearsToExpiry: 0,
    }
  }

  const T = secondsToExpiry / YEAR_SECONDS
  const rateMinF = Number(config.rateMin) / 1e18
  const rateMaxF = Number(config.rateMax) / 1e18
  const desiredF = Number(config.desiredImpliedRate) / 1e18

  // (1 + rate)^T, in FLOAT (un-scaled). Anchor/diff/scalar carry a factor of
  // 1e18 to land back in wad, matching the Solidity fixed-point output.
  const rateMinScaled = Math.pow(1 + rateMinF, T)
  const rateMaxScaled = Math.pow(1 + rateMaxF, T)
  const initialAnchorF = (rateMinScaled + rateMaxScaled) / 2
  const rateDiff = rateMaxScaled - initialAnchorF

  // scalarRoot = ln(9)·T / rateDiff  (float), then ×1e18 to wad.
  const scalarRootF = rateDiff > 0 ? (Math.log(9) * T) / rateDiff : 0
  const scalarRoot = floatToWad(scalarRootF * 1e18)
  const initialAnchor = floatToWad(initialAnchorF * 1e18)

  // lnFeeRateRoot = ln(1 + fee)·1e18.
  const lnFeeRateRoot = floatToWad(Math.log(1 + Number(config.fee) / 1e18) * 1e18)

  // calcInitialProportion (float): rateScalar = scalarRoot·YEAR/timeToExpiry.
  const rateScalarF = (scalarRootF * YEAR_SECONDS) / secondsToExpiry
  const desiredExchangeRateF = Math.pow(1 + desiredF, T)
  const logitP = Math.exp((desiredExchangeRateF - initialAnchorF) * rateScalarF)
  const initialProportion = Number.isFinite(logitP) ? logitP / (1 + logitP) : 1

  return {
    scalarRoot,
    initialAnchor,
    lnFeeRateRoot,
    initialProportion,
    yearsToExpiry: T,
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Full preflight: pure validation + a binding eth_call simulation of the deploy. */
export async function preflightDeploy(
  client: PublicClient,
  sy: Address,
  config: PoolConfig,
  seedToken: Address,
  seedAmount: bigint,
  user: Address,
): Promise<DeployPreflight> {
  const errors: string[] = []
  const warnings: string[] = []

  // --- Live governance-mutable reads (F12): expiryDivisor off the ACTIVE YCF,
  // maxLnFeeRateRoot off the ACTIVE market factory, current chain time. ---
  const [expiryDivisorRes, maxLnFeeRes, block] = await Promise.all([
    client
      .readContract({
        address: ACTIVE_GEN.yieldContractFactory,
        abi: ycfDeployProbeAbi,
        functionName: 'expiryDivisor',
      })
      .catch(() => undefined),
    client
      .readContract({
        address: ACTIVE_GEN.marketFactory,
        abi: marketFactoryAbi,
        functionName: 'maxLnFeeRateRoot',
      })
      .catch(() => undefined),
    client.getBlock(),
  ])
  const expiryDivisor = (expiryDivisorRes as bigint | undefined) ?? 86400n
  const maxLnFeeRateRoot = (maxLnFeeRes as bigint | undefined) ?? MAX_LN_FEE_RATE_ROOT
  const nowSeconds = Number(block.timestamp)

  // --- (a) Hard checks on the config ---------------------------------------
  if (config.expiry <= nowSeconds) {
    errors.push('Expiry must be in the future.')
  }
  if (BigInt(config.expiry) % expiryDivisor !== 0n) {
    errors.push(
      `Expiry must be aligned to the factory divisor (${expiryDivisor} s — midnight UTC).`,
    )
  }
  if (config.rateMax <= config.rateMin) {
    errors.push('The rate band is inverted — the maximum APY must be strictly above the minimum.')
  }
  if (config.desiredImpliedRate <= config.rateMin || config.desiredImpliedRate >= config.rateMax) {
    errors.push('The launch APY must sit strictly inside the rate band (above min, below max).')
  }

  // Derived params (also returned for the education UI). Only trust the fee /
  // anchor checks when the band is well-formed enough that the mirror is sane.
  const derived = computeDeployParams(config, nowSeconds)
  // Fee-cap gate on the FLOAT mirror only — with a tolerance. At exactly the
  // documented 5% max, the float lnFeeRateRoot lands a few tens of wei ABOVE
  // the exact on-chain cap (float ln vs LogExpMath: ~48790164169432048 vs the
  // live 48790164169432003), so a strict `>` false-rejects the max. Allow a
  // small epsilon so the boundary passes here; the binding simulation (exact
  // on-chain calcFee) + the UI's configMath 5% check own genuine over-cap fees.
  const FEE_CAP_EPSILON = 1000n // wei of lnFeeRateRoot — dwarfs float drift, far below one basis point
  if (derived.lnFeeRateRoot > maxLnFeeRateRoot + FEE_CAP_EPSILON) {
    errors.push('Fee above the 5% cap.')
  }
  if (config.rateMax > config.rateMin && config.expiry > nowSeconds && derived.initialAnchor < ONE_E18) {
    errors.push('Derived initial anchor is below 1.0 — widen the rate band or shorten the expiry.')
  }

  // --- (b) SY validity ------------------------------------------------------
  let syValid = false
  let tokensIn: Address[] = []
  const [assetInfoRes, tokensInRes] = await Promise.all([
    client
      .readContract({ address: sy, abi: syReadAbi, functionName: 'assetInfo' })
      .catch(() => undefined),
    client
      .readContract({ address: sy, abi: syReadAbi, functionName: 'getTokensIn' })
      .catch(() => undefined),
  ])
  if (assetInfoRes !== undefined && tokensInRes !== undefined) {
    syValid = true
    tokensIn = (tokensInRes as readonly Address[]).map((a) => getAddress(a))
  } else {
    errors.push('This address does not implement a Pendle SY (assetInfo/getTokensIn failed).')
  }

  // Seed token must be the SY itself, native ETH (only when SY lists it), or in getTokensIn().
  if (syValid) {
    const seedLc = seedToken.toLowerCase()
    const isSy = seedLc === sy.toLowerCase()
    const inTokensIn = tokensIn.some((t) => t.toLowerCase() === seedLc)
    if (!isSy && !inTokensIn) {
      errors.push(
        'The seed token must be the SY itself or one of the tokens the SY accepts (getTokensIn).',
      )
    }
  }

  // --- (c) Duplicate-PT check on the ACTIVE YCF + legacy-YCF scan -----------
  let ptExistsOnActive = false
  let existingPt: Address | undefined
  const legacyParallelPts: { gen: string; pt: Address }[] = []

  // One multicall: getPT(SY, expiry) on every generation's YCF.
  const ptResults = await client.multicall({
    contracts: FACTORY_GENERATIONS.map((g) => ({
      address: g.yieldContractFactory,
      abi: ycfDeployProbeAbi,
      functionName: 'getPT' as const,
      args: [sy, BigInt(config.expiry)] as const,
    })),
    allowFailure: true,
  })
  FACTORY_GENERATIONS.forEach((g, i) => {
    const r = ptResults[i]
    if (r.status !== 'success') return
    const pt = r.result as Address
    if (pt === ZERO_ADDRESS || BigInt(pt) === 0n) return
    if (g.yieldContractFactory.toLowerCase() === ACTIVE_GEN.yieldContractFactory.toLowerCase()) {
      ptExistsOnActive = true
      existingPt = getAddress(pt)
    } else {
      legacyParallelPts.push({ gen: g.gen, pt: getAddress(pt) })
    }
  })
  if (ptExistsOnActive) {
    warnings.push('PT already exists for this SY+expiry — it will be reused.')
  }
  if (legacyParallelPts.length > 0) {
    warnings.push(
      `A PT for this SY+expiry already exists on ${legacyParallelPts.length} older factory generation(s) — a separate, parallel market.`,
    )
  }

  // --- (e) Binding simulation ----------------------------------------------
  // eth_call the exact deploy from `user`. This exercises the on-chain param
  // math AND the seeding path (mintSy → mintPy → addLiquidity). It needs the
  // user to hold + have approved the seed token to COMMON_DEPLOY; the UI runs
  // this AFTER the approve tx confirms (same approve→simulate sequencing as
  // M2/M3, PLAN §3.2). On a public RPC without balance/allowance the seeding
  // reverts (ERC20 transfer/allowance) — that surfaces as simulationError, not
  // a false "config invalid". The fork test funds+approves first, so this is a
  // clean pass there.
  let simulated = false
  let simulationError: string | undefined
  const seedIsNative = isNative(seedToken)

  // FIX A: for an ERC20/SY seed token, check the COMMON_DEPLOY allowance FIRST.
  // If it's below seedAmount the binding sim will revert with an allowance error
  // that is EXPECTED pre-approval — flag it advisory so the UI never treats it
  // as a config failure (the deploy path still reaches Approve → Deploy).
  let simulationPendingApproval = false
  if (!seedIsNative) {
    const allowance = (await client
      .readContract({
        address: seedToken,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [user, COMMON_DEPLOY],
      })
      .catch(() => undefined)) as bigint | undefined
    if (allowance === undefined || allowance < seedAmount) {
      simulationPendingApproval = true
    }
  }

  try {
    await client.simulateContract({
      account: user,
      address: COMMON_DEPLOY,
      abi: commonDeployPoolAbi,
      functionName: 'deploy5115MarketAndSeedLiquidity',
      args: [
        sy,
        {
          expiry: config.expiry,
          rateMin: config.rateMin,
          rateMax: config.rateMax,
          desiredImpliedRate: config.desiredImpliedRate,
          fee: config.fee,
        },
        seedToken,
        seedAmount,
      ],
      ...(seedIsNative ? { value: seedAmount } : {}),
    })
    simulated = true
    // A clean sim proves the allowance is already in place.
    simulationPendingApproval = false
  } catch (err) {
    // forDeploy=true: an arithmetic panic here most likely reflects a
    // degenerate rate band / expiry (calcParams math), so the deploy path
    // opts into the rate-band hint that the shared decoder no longer applies.
    simulationError = decodePendleError(err, true)
  }

  // `ok` is now an ADVISORY "everything simulated cleanly" — the deploy path is
  // NOT gated on it (FIX A: the UI gates on `errors` + local validation, and
  // useActionFlow runs the binding sim post-approval). A pending-approval revert
  // is not counted as a hard failure here.
  const ok = errors.length === 0 && simulated

  return {
    ok,
    errors,
    warnings,
    syValid,
    ptExistsOnActive,
    existingPt,
    legacyParallelPts,
    derived,
    simulated,
    simulationError,
    simulationPendingApproval,
  }
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

/** Compact human amount for describe strings: ≤6 fractional digits, trailing zeros trimmed. */
function fmt(amount: bigint, decimals: number): string {
  const neg = amount < 0n
  const abs = neg ? -amount : amount
  const base = 10n ** BigInt(decimals)
  const int = abs / base
  const fracRaw = (abs % base).toString().padStart(decimals, '0')
  const frac = fracRaw.slice(0, 6).replace(/0+$/, '')
  const body = frac ? `${int}.${frac}` : `${int}`
  return neg ? `-${body}` : body
}

/**
 * Build the deploy plan. Approvals: seedToken → COMMON_DEPLOY (native ETH →
 * value on the call, no approval). `receiver` is informational for describe —
 * the contract seeds LP + YT to msg.sender regardless.
 */
export function planDeployPool(
  sy: Address,
  config: PoolConfig,
  seedToken: Address,
  seedTokenSymbol: string,
  seedTokenDecimals: number,
  seedAmount: bigint,
  receiver: Address,
): ActionPlan {
  void sy
  void receiver
  const native = isNative(seedToken)
  const call = {
    address: COMMON_DEPLOY,
    abi: commonDeployPoolAbi,
    functionName: 'deploy5115MarketAndSeedLiquidity',
    args: [
      sy,
      {
        expiry: config.expiry,
        rateMin: config.rateMin,
        rateMax: config.rateMax,
        desiredImpliedRate: config.desiredImpliedRate,
        fee: config.fee,
      },
      seedToken,
      seedAmount,
    ] as const,
    ...(native ? { value: seedAmount } : {}),
  }

  return {
    describe: `Create pool over ${seedTokenSymbol === '' ? 'SY' : seedTokenSymbol} and seed ${fmt(seedAmount, seedTokenDecimals)} ${seedTokenSymbol}`,
    approvals: native
      ? []
      : [
          {
            token: seedToken,
            spender: COMMON_DEPLOY,
            amount: seedAmount,
            symbol: seedTokenSymbol,
            decimals: seedTokenDecimals,
          },
        ],
    call,
  }
}

// ---------------------------------------------------------------------------
// Result decoding + recovery
// ---------------------------------------------------------------------------

const MARKET_DEPLOYMENT_TOPIC0 =
  '0xd1f8866e1ab220ea57cc2bc3d029810357a6f6df863760170473f9df5b322ebd'

/** Try to decode one raw log as a MarketDeployment event; undefined if it isn't one / fails. */
function decodeOneMarketDeployment(log: {
  topics?: readonly string[]
  data?: string
  address?: string
}): DeployResult | undefined {
  const topics = log.topics
  if (!topics || topics.length === 0) return undefined
  if (topics[0]?.toLowerCase() !== MARKET_DEPLOYMENT_TOPIC0) return undefined
  try {
    const decoded = decodeEventLog({
      abi: commonDeployPoolAbi,
      eventName: 'MarketDeployment',
      topics: topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: (log.data ?? '0x') as `0x${string}`,
    })
    const addrs = (decoded.args as { addrs: { SY: Address; PT: Address; YT: Address; market: Address } })
      .addrs
    return {
      market: getAddress(addrs.market),
      sy: getAddress(addrs.SY),
      pt: getAddress(addrs.PT),
      yt: getAddress(addrs.YT),
    }
  } catch {
    return undefined
  }
}

/** Decode the commonDeploy MarketDeployment event from a receipt's logs. */
export function decodeDeploymentResult(logs: readonly unknown[]): DeployResult | undefined {
  for (const log of logs) {
    const result = decodeOneMarketDeployment(log as { topics?: readonly string[]; data?: string })
    if (result) return result
  }
  return undefined
}

/** Cap per getLogs window — public RPCs reject wide ranges. Matches sweep.mjs's floor. */
const RECOVERY_CHUNK_BLOCKS = 10_000n
/** Floor for the adaptive halving retry — below this a persistent error is real, not a range limit. */
const RECOVERY_MIN_CHUNK_BLOCKS = 500n

/** Raw MarketDeployment log fetch for a [from, to] window (address + topic0 filtered). */
async function getMarketDeploymentLogs(
  client: PublicClient,
  from: bigint,
  to: bigint,
): Promise<Log[]> {
  return (await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: COMMON_DEPLOY,
        topics: [MARKET_DEPLOYMENT_TOPIC0],
        fromBlock: numberToHex(from),
        toBlock: numberToHex(to),
      },
    ],
  })) as unknown as Log[]
}

/**
 * Bounded recovery scan: commonDeploy MarketDeployment events by deployer since
 * fromBlock. MarketDeployment is NOT indexed, so we cannot topic-filter by
 * deployer — instead we fetch the event logs (address-filtered on COMMON_DEPLOY,
 * topic0-filtered) in bounded chunks, then keep only those whose emitting tx's
 * `from` is the deployer (one getTransaction per candidate log). The wizard
 * stores `fromBlock` at start so the range stays small; we additionally chunk
 * at 10k blocks so even a stale checkpoint doesn't trip a public RPC's range
 * limit.
 *
 * On a chunk error we HALVE the window and retry (down to a 500-block floor)
 * rather than silently skipping the whole 10k window — a strict RPC dropping a
 * user's deployment is worse than a slower scan. If even the floor-sized window
 * keeps failing, we surface the error (throw) instead of returning a partial
 * list that silently omits a real deployment.
 */
export async function recoverDeployments(
  client: PublicClient,
  deployer: Address,
  fromBlock: bigint,
): Promise<DeployResult[]> {
  const latest = await client.getBlockNumber()
  const deployerLc = deployer.toLowerCase()
  const out: DeployResult[] = []
  const seenTx = new Set<string>()

  let from = fromBlock < 0n ? 0n : fromBlock
  let span = RECOVERY_CHUNK_BLOCKS
  while (from <= latest) {
    const to = from + span - 1n > latest ? latest : from + span - 1n
    let logs: Log[]
    try {
      logs = await getMarketDeploymentLogs(client, from, to)
    } catch (err) {
      // Adaptive halving: shrink the window and retry the SAME start block, so
      // a range-limit rejection never drops blocks. Only give up once the
      // window is at the floor and still failing — then surface it.
      if (span > RECOVERY_MIN_CHUNK_BLOCKS) {
        span = span / 2n > RECOVERY_MIN_CHUNK_BLOCKS ? span / 2n : RECOVERY_MIN_CHUNK_BLOCKS
        continue
      }
      throw new Error(
        `Deployment recovery scan failed near block ${from} (window ${span}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    for (const log of logs) {
      const txHash = (log as { transactionHash?: string }).transactionHash
      if (!txHash || seenTx.has(txHash)) continue
      seenTx.add(txHash)
      const result = decodeOneMarketDeployment(log as { topics?: readonly string[]; data?: string })
      if (!result) continue
      // Filter by tx sender (the deployer): MarketDeployment doesn't index it.
      try {
        const tx = await client.getTransaction({ hash: txHash as `0x${string}` })
        if (tx.from.toLowerCase() === deployerLc) out.push(result)
      } catch {
        // Unresolvable tx — skip rather than mis-attribute.
      }
    }
    from = to + 1n
    // A window succeeded — grow back toward the full chunk for the next span.
    if (span < RECOVERY_CHUNK_BLOCKS) {
      span = span * 2n > RECOVERY_CHUNK_BLOCKS ? RECOVERY_CHUNK_BLOCKS : span * 2n
    }
  }
  return out
}

/** Recover a single deployment from a pasted tx hash's receipt. */
export async function recoverDeploymentFromTx(
  client: PublicClient,
  txHash: `0x${string}`,
): Promise<DeployResult | undefined> {
  const receipt = await client.getTransactionReceipt({ hash: txHash })
  return decodeDeploymentResult(receipt.logs)
}

// Re-export the chain id so the wizard can guard the deploy tx target without a
// second import (deploy is Arbitrum-only, like everything else in v1).
export { ARBITRUM_CHAIN_ID }
