/**
 * UI-owned on-chain reads for the M6 create-pool wizard. These live in the UI
 * layer (components/) because the wizard needs SY metadata and a seed-token
 * balance BEFORE any market exists — there is no MarketSnapshot to hang them
 * off, and lib/deploy.ts is (correctly) scoped to the deploy tx/preflight, not
 * to arbitrary SY probing. Consumes the shared ABIs from lib/pendleAbi.ts and
 * the live expiryDivisor from the active yield-contract factory.
 *
 * Pure wagmi/viem + TanStack Query, no writes. Lives outside a *.tsx component
 * file so those files only export components (fast-refresh / oxlint rule).
 */

import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { getAddress, isAddress, zeroAddress } from 'viem'
import type { Address, PublicClient } from 'viem'
import { addressBookFor, supportedChain } from '../../lib/addresses'
import { useActiveChain } from '../../lib/hooks'
import {
  commonDeployAbi,
  erc20Abi,
  erc20SymbolAbi,
  syReadAbi,
  yieldContractFactoryAbi,
} from '../../lib/pendleAbi'

export const NATIVE_TOKEN: Address = zeroAddress

/** The default daily divisor (86400 = midnight UTC) used until the live read lands. */
export const DEFAULT_EXPIRY_DIVISOR = 86400

export interface SyMeta {
  address: Address
  name: string
  symbol: string
  decimals: number
  /** SY itself + its getTokensIn() list — the allowed seed tokens. */
  seedTokens: SeedTokenMeta[]
}

export interface SeedTokenMeta {
  address: Address
  symbol: string
  decimals: number
  isNative: boolean
  /** True for the SY share token itself (always a valid seed input). */
  isSy: boolean
}

const SHARED_STALE_MS = 30_000

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * Probe an address for IStandardizedYield: name/symbol/decimals + getTokensIn.
 * Throws (query 'error') when the address doesn't answer the SY surface — the
 * caller renders that as "not a valid SY".
 */
async function loadSyMeta(
  client: PublicClient,
  sy: Address,
  nativeSymbol: string,
): Promise<SyMeta> {
  const [name, symbol, decimals, tokensIn] = await Promise.all([
    client.readContract({ address: sy, abi: syReadAbi, functionName: 'name' }),
    client.readContract({ address: sy, abi: syReadAbi, functionName: 'symbol' }),
    client.readContract({ address: sy, abi: syReadAbi, functionName: 'decimals' }),
    client.readContract({ address: sy, abi: syReadAbi, functionName: 'getTokensIn' }),
  ])

  // Resolve symbol/decimals for each accepted token. address(0) = native ETH.
  const rawTokens = (tokensIn as readonly Address[]) ?? []
  const seedTokens: SeedTokenMeta[] = [
    // The SY share itself is always a valid seed token.
    {
      address: sy,
      symbol: symbol as string,
      decimals: Number(decimals),
      isNative: false,
      isSy: true,
    },
  ]

  for (const t of rawTokens) {
    if (t.toLowerCase() === sy.toLowerCase()) continue // already listed as the SY itself
    if (t === NATIVE_TOKEN) {
      // Native gas token — symbol is chain-specific (ETH / BNB / MON / XPL).
      seedTokens.push({ address: NATIVE_TOKEN, symbol: nativeSymbol, decimals: 18, isNative: true, isSy: false })
      continue
    }
    try {
      const [tSym, tDec] = await Promise.all([
        client.readContract({ address: t, abi: erc20SymbolAbi, functionName: 'symbol' }),
        client.readContract({ address: t, abi: erc20Abi, functionName: 'decimals' }),
      ])
      seedTokens.push({
        address: t,
        symbol: tSym as string,
        decimals: Number(tDec),
        isNative: false,
        isSy: false,
      })
    } catch {
      // Token metadata unreadable — still list it, sized only if the user
      // knows the decimals. Skip rather than fail the whole SY probe.
      seedTokens.push({ address: t, symbol: 'token', decimals: 18, isNative: false, isSy: false })
    }
  }

  return {
    address: sy,
    name: name as string,
    symbol: symbol as string,
    decimals: Number(decimals),
    seedTokens,
  }
}

/**
 * Validate + load SY metadata for the wizard. Wallet-less: reads via the
 * configured public client. 'idle' until the input is a well-formed address.
 */
export function useSyMeta(input: string): {
  status: 'idle' | 'loading' | 'error' | 'success'
  meta?: SyMeta
  error?: string
} {
  // M8: read the ACTIVE chain (a bare usePublicClient() would hit the wagmi
  // default = Ethereum). Native seed-token symbol is the active chain's.
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const nativeSymbol = supportedChain(chainId)?.nativeSymbol ?? 'ETH'
  const trimmed = input.trim()
  const valid = isAddress(trimmed, { strict: false })
  const sy = valid ? getAddress(trimmed) : undefined
  const enabled = sy !== undefined && client !== undefined

  const query = useQuery({
    queryKey: ['create.syMeta', chainId, sy?.toLowerCase() ?? null],
    queryFn: () => loadSyMeta(client as PublicClient, sy as Address, nativeSymbol),
    enabled,
    staleTime: SHARED_STALE_MS,
    retry: 1,
  })

  if (!valid) return { status: 'idle' }
  if (!enabled || query.status === 'pending') return { status: 'loading' }
  if (query.status === 'error') return { status: 'error', error: errText(query.error) }
  return { status: 'success', meta: query.data }
}

/**
 * Live expiryDivisor from the active yield-contract factory (resolved from
 * commonDeploy — never hardcoded, F12). Falls back to the daily default while
 * the read is in flight or if it fails, so the date picker always snaps.
 */
export function useExpiryDivisor(): number {
  // M8: resolve commonDeploy + read the yield-contract factory on the ACTIVE
  // chain (keyed by chainId so switching networks re-reads its divisor).
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const commonDeploy = addressBookFor(chainId).commonDeploy
  const query = useQuery({
    queryKey: ['create.expiryDivisor', chainId],
    queryFn: async () => {
      const ycf = await (client as PublicClient).readContract({
        address: commonDeploy,
        abi: commonDeployAbi,
        functionName: 'yieldContractFactory',
      })
      const divisor = await (client as PublicClient).readContract({
        address: ycf as Address,
        abi: yieldContractFactoryAbi,
        functionName: 'expiryDivisor',
      })
      const n = Number(divisor)
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_EXPIRY_DIVISOR
    },
    enabled: client !== undefined,
    staleTime: 5 * 60_000,
    retry: 1,
  })
  return query.data ?? DEFAULT_EXPIRY_DIVISOR
}

/**
 * Wallet balance of a seed token (native ETH via getBalance, ERC-20 via
 * balanceOf). 'idle' with no user/token; the AmountInput renders "—" then.
 */
export function useTokenBalance(
  token: Address | undefined,
  user: Address | undefined,
  isNative: boolean,
): { balance?: bigint } {
  // M8: balance must be read on the ACTIVE chain (deploy target), not the
  // wagmi default. Keyed by chainId so switching networks re-reads.
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const enabled = token !== undefined && user !== undefined && client !== undefined

  const query = useQuery({
    queryKey: ['create.balance', chainId, token?.toLowerCase() ?? null, user?.toLowerCase() ?? null, isNative],
    queryFn: async (): Promise<bigint> => {
      const c = client as PublicClient
      if (isNative) return c.getBalance({ address: user as Address })
      return c.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [user as Address],
      }) as Promise<bigint>
    },
    enabled,
    staleTime: 12_000,
    retry: 1,
  })

  return { balance: query.data }
}
