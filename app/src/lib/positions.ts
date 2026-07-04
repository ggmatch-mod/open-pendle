/**
 * M2 positions reader — pure, framework-free (erasable TS).
 *
 * loadPositions gathers, for one market + user:
 * - PT / YT / LP (market) / SY balances — plain balanceOf, ONE multicall
 *   round together with tokensIn wallet balances + missing token metadata
 *   (native ETH balance fetched in parallel via getBalance);
 * - claimables via RouterStatic getUserPYInfo / getUserMarketInfo /
 *   getUserSYInfo. Those functions are STATE-MUTATING (they poke reward
 *   indexes) so they run through client.simulateContract (eth_call), never
 *   in a tx. Each probe is individually try/caught → degraded[] entry
 *   (RouterStatic may not cover exotic legacy markets);
 * - reward-token symbols/decimals in one follow-up multicall (failures →
 *   symbol '?', decimals UNKNOWN_DECIMALS sentinel + degraded[] note — we
 *   never fabricate 18 for a token we could not read).
 *
 * Correctness notes:
 * - `ytClaimableInterestSy` is denominated in SY units (RouterStatic reports
 *   unclaimedInterest with token = the SY).
 * - Our own balanceOf reads are canonical for pt/yt — getUserPYInfo's
 *   ptBalance/ytBalance are ignored (never double-counted), and reward/interest
 *   entries are matched by their `.token` field, not by tuple position.
 */

import type { Address, PublicClient } from 'viem'
import type { MarketSnapshot, Positions, TokenAmount } from './types.ts'
import { MULTICALL3, ROUTER_STATIC } from './addresses.ts'
import { erc20Abi, routerStaticUserAbi } from './pendleAbi.ts'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Sentinel for a TokenAmount whose on-chain decimals() could not be read.
 * -1 can never be a real ERC-20 decimals value, so renderers can detect it
 * and MUST NOT formatUnits with it — show the raw integer amount instead
 * (PositionsCard renders "raw: N"). Kept local to the positions pipeline on
 * purpose: types.ts (the shared UI/data contract) stays unchanged.
 */
export const UNKNOWN_DECIMALS = -1

function isNative(token: Address): boolean {
  return token.toLowerCase() === ZERO_ADDRESS
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

interface RawTokenAmount {
  token: Address
  amount: bigint
}

interface TokenMeta {
  symbol?: string
  decimals?: number
}

/**
 * Metadata already cached on the snapshot — avoids refetching known tokens.
 * PT/YT carry the SY's assetDecimals: the yield-contract factory mints them
 * with SY.assetInfo().assetDecimals, NOT SY.decimals() (live markets differ
 * in both directions — SY-dWBTC: SY 8 / PT+YT 18; SY-RLP: SY 18 / PT+YT 6).
 * Exported for verification scripts.
 */
export function knownMeta(snapshot: MarketSnapshot, token: Address): TokenMeta {
  if (isNative(token)) return { symbol: 'ETH', decimals: 18 }
  const sy = snapshot.sy
  if (sameAddress(token, sy.address)) return { symbol: sy.symbol, decimals: sy.decimals }
  if (sameAddress(token, sy.assetAddress)) {
    return { symbol: sy.assetSymbol, decimals: sy.assetDecimals }
  }
  if (sameAddress(token, snapshot.pt)) {
    return { symbol: snapshot.ptSymbol, decimals: sy.assetDecimals }
  }
  if (sameAddress(token, snapshot.yt)) {
    return { symbol: snapshot.ytSymbol, decimals: sy.assetDecimals }
  }
  return {}
}

export async function loadPositions(
  client: PublicClient,
  snapshot: MarketSnapshot,
  user: Address,
): Promise<Positions> {
  const degraded: string[] = []
  const tokensIn = snapshot.sy.tokensIn
  const erc20TokensIn = tokensIn.filter((t) => !isNative(t))
  const hasNativeIn = tokensIn.some((t) => isNative(t))

  // -- Round 1: ONE multicall for the 4 core balances + tokensIn balances +
  //    missing tokensIn metadata; native ETH balance in parallel. ------------
  const metaTargets = erc20TokensIn.filter((t) => {
    const known = knownMeta(snapshot, t)
    return known.symbol === undefined || known.decimals === undefined
  })
  const balanceContracts = [snapshot.pt, snapshot.yt, snapshot.address, snapshot.sy.address, ...erc20TokensIn].map(
    (address) => ({
      address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [user] as const,
    }),
  )
  const metaContracts = metaTargets.flatMap((address) => [
    { address, abi: erc20Abi, functionName: 'symbol' as const },
    { address, abi: erc20Abi, functionName: 'decimals' as const },
  ])

  const [round1, nativeBalance] = await Promise.all([
    client.multicall({
      contracts: [...balanceContracts, ...metaContracts],
      allowFailure: true,
      multicallAddress: MULTICALL3,
    }),
    hasNativeIn
      ? client.getBalance({ address: user }).catch(() => {
          degraded.push('Native ETH balance unavailable.')
          return 0n
        })
      : Promise.resolve(0n),
  ])

  const coreLabels = ['PT', 'YT', 'LP', 'SY'] as const
  const coreBalances = coreLabels.map((label, i) => {
    const r = round1[i]
    if (r.status === 'success') return r.result as bigint
    degraded.push(`${label} balanceOf failed.`)
    return 0n
  })
  const [pt, yt, lp, sy] = coreBalances

  const fetchedMeta = new Map<string, TokenMeta>()
  for (let i = 0; i < metaTargets.length; i++) {
    const symbolR = round1[balanceContracts.length + i * 2]
    const decimalsR = round1[balanceContracts.length + i * 2 + 1]
    fetchedMeta.set(metaTargets[i].toLowerCase(), {
      symbol: symbolR.status === 'success' ? (symbolR.result as string) : undefined,
      decimals: decimalsR.status === 'success' ? Number(decimalsR.result) : undefined,
    })
  }

  const metaFor = (token: Address): { symbol: string; decimals: number } => {
    const known = knownMeta(snapshot, token)
    const fetched = fetchedMeta.get(token.toLowerCase()) ?? {}
    return {
      symbol: known.symbol ?? fetched.symbol ?? '?',
      // No guessing: unreadable decimals become the UNKNOWN_DECIMALS sentinel
      // (renderers show the raw amount) instead of a confidently wrong 18.
      decimals: known.decimals ?? fetched.decimals ?? UNKNOWN_DECIMALS,
    }
  }

  const walletTokens: TokenAmount[] = tokensIn.map((token) => {
    if (isNative(token)) {
      return { token, amount: nativeBalance, symbol: 'ETH', decimals: 18 }
    }
    const idx = 4 + erc20TokensIn.findIndex((t) => sameAddress(t, token))
    const r = round1[idx]
    let amount = 0n
    if (r.status === 'success') {
      amount = r.result as bigint
    } else {
      degraded.push(`Wallet balance of tokenIn ${token} unavailable.`)
    }
    return { token, amount, ...metaFor(token) }
  })

  // -- Claimables: RouterStatic getUser* via simulateContract (nonpayable),
  //    each probe individually try/caught → degraded[]. ---------------------
  const probe = async <T>(
    functionName: 'getUserPYInfo' | 'getUserMarketInfo' | 'getUserSYInfo',
    target: Address,
  ): Promise<T | undefined> => {
    try {
      const { result } = await client.simulateContract({
        address: ROUTER_STATIC,
        abi: routerStaticUserAbi,
        functionName,
        args: [target, user],
        account: user,
      })
      return result as unknown as T
    } catch {
      degraded.push(`RouterStatic ${functionName} failed — claimables not shown for it.`)
      return undefined
    }
  }

  const [pyInfo, marketInfo, syInfo] = await Promise.all([
    probe<{
      ptBalance: RawTokenAmount
      ytBalance: RawTokenAmount
      unclaimedInterest: RawTokenAmount
      unclaimedRewards: readonly RawTokenAmount[]
    }>('getUserPYInfo', snapshot.yt),
    probe<{
      lpBalance: RawTokenAmount
      ptBalance: RawTokenAmount
      syBalance: RawTokenAmount
      unclaimedRewards: readonly RawTokenAmount[]
    }>('getUserMarketInfo', snapshot.address),
    probe<{
      syBalance: RawTokenAmount
      unclaimedRewards: readonly RawTokenAmount[]
    }>('getUserSYInfo', snapshot.sy.address),
  ])

  // SY-units interest (unclaimedInterest.token is the SY — verified live).
  const ytClaimableInterestSy = pyInfo?.unclaimedInterest.amount ?? 0n

  // -- Reward token metadata: one follow-up multicall over unknown tokens. ---
  const rawRewardLists = {
    yt: pyInfo?.unclaimedRewards ?? [],
    lp: marketInfo?.unclaimedRewards ?? [],
    sy: syInfo?.unclaimedRewards ?? [],
  }
  const unknownRewardTokens = [
    ...new Set(
      Object.values(rawRewardLists)
        .flat()
        .map((r) => r.token)
        .filter((t) => {
          const known = knownMeta(snapshot, t)
          const fetched = fetchedMeta.get(t.toLowerCase())
          return (
            !isNative(t) &&
            (known.symbol ?? fetched?.symbol) === undefined
          )
        })
        .map((t) => t.toLowerCase() as Address),
    ),
  ]
  if (unknownRewardTokens.length > 0) {
    const rewardMeta = await client
      .multicall({
        contracts: unknownRewardTokens.flatMap((address) => [
          { address, abi: erc20Abi, functionName: 'symbol' as const },
          { address, abi: erc20Abi, functionName: 'decimals' as const },
        ]),
        allowFailure: true,
        multicallAddress: MULTICALL3,
      })
      .catch(() => {
        degraded.push(
          'Reward-token metadata lookup failed — unknown reward amounts are shown raw.',
        )
        return undefined
      })
    for (let i = 0; i < unknownRewardTokens.length; i++) {
      const symbolR = rewardMeta?.[i * 2]
      const decimalsR = rewardMeta?.[i * 2 + 1]
      fetchedMeta.set(unknownRewardTokens[i], {
        symbol:
          symbolR?.status === 'success' ? (symbolR.result as string) : undefined,
        decimals:
          decimalsR?.status === 'success' ? Number(decimalsR.result) : undefined,
      })
    }
  }

  const toTokenAmounts = (raw: readonly RawTokenAmount[]): TokenAmount[] =>
    raw.map((r) => ({ token: r.token, amount: r.amount, ...metaFor(r.token) }))

  return {
    user,
    pt,
    yt,
    lp,
    sy,
    walletTokens,
    ytClaimableInterestSy,
    ytClaimableRewards: toTokenAmounts(rawRewardLists.yt),
    lpClaimableRewards: toTokenAmounts(rawRewardLists.lp),
    syClaimableRewards: toTokenAmounts(rawRewardLists.sy),
    degraded,
  }
}
