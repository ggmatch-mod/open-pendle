import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { LOOPING_ENTRY_EXECUTION_REGISTRY } from './src/lib/loopingRegistry.ts'

export interface LoopingBuildEnvironment {
  readonly OPENPENDLE_LOCAL_MINT_POLICY_ALL?: string
  readonly OPENPENDLE_LOCAL_MINT_POLICY_MARKET?: string
  readonly CF_PAGES?: string
  readonly CF_PAGES_BRANCH?: string
  readonly CF_PAGES_URL?: string
  readonly VITE_LOOPING_EXECUTION_BETA_ENABLED?: string
  readonly VITE_LOOPING_MINT_BETA_ENABLED?: string
  readonly VITE_LOOPING_EXIT_BETA_ENABLED?: string
}

export const OPENPENDLE_CLOUDFLARE_HOST = 'open-pendle.pages.dev'
export const LOOPING_MINT_RUNTIME_POLICY_PATH =
  '/looping-mint-execution-policy.v1.json'
export const LOCAL_LOOPING_MINT_POLICY_MAX_MARKETS = 32

export interface LocalLoopingMintPolicyMarket {
  readonly chainId: number
  readonly morphoMarketId: `0x${string}`
}

export function resolveLocalLoopingMintPolicyMarket(
  value: string | undefined,
): Readonly<LocalLoopingMintPolicyMarket> | null {
  if (value === undefined || value === '') return null
  const match = /^([1-9][0-9]*):(0x[0-9a-fA-F]{64})$/.exec(value)
  if (match === null) {
    throw new Error(
      'OPENPENDLE_LOCAL_MINT_POLICY_MARKET must be <chainId>:<marketId>.',
    )
  }
  const chainId = Number(match[1])
  if (!Number.isSafeInteger(chainId)) {
    throw new Error('OPENPENDLE_LOCAL_MINT_POLICY_MARKET chainId is unsafe.')
  }
  return Object.freeze({
    chainId,
    morphoMarketId: match[2].toLowerCase() as `0x${string}`,
  })
}

const EMPTY_LOCAL_LOOPING_MINT_POLICY_MARKETS:
readonly Readonly<LocalLoopingMintPolicyMarket>[] = Object.freeze([])

/**
 * Dev-server-only Mint policy selection. The all-markets option expands to
 * the reviewed entry registry; it never grants an unreviewed or
 * position-management-only market.
 */
export function resolveLocalLoopingMintPolicyMarkets(
  environment: Pick<
    LoopingBuildEnvironment,
    'OPENPENDLE_LOCAL_MINT_POLICY_ALL' |
    'OPENPENDLE_LOCAL_MINT_POLICY_MARKET'
  >,
): readonly Readonly<LocalLoopingMintPolicyMarket>[] {
  const allValue = environment.OPENPENDLE_LOCAL_MINT_POLICY_ALL
  if (
    allValue !== undefined &&
    allValue !== '' &&
    allValue !== 'false' &&
    allValue !== 'true'
  ) {
    throw new Error(
      'OPENPENDLE_LOCAL_MINT_POLICY_ALL must be true, false, or empty.',
    )
  }
  const singleMarket = resolveLocalLoopingMintPolicyMarket(
    environment.OPENPENDLE_LOCAL_MINT_POLICY_MARKET,
  )
  const allMarkets = allValue === 'true'
  if (allMarkets && singleMarket !== null) {
    throw new Error(
      'Set only one of OPENPENDLE_LOCAL_MINT_POLICY_ALL or ' +
      'OPENPENDLE_LOCAL_MINT_POLICY_MARKET.',
    )
  }
  if (!allMarkets) {
    return singleMarket === null
      ? EMPTY_LOCAL_LOOPING_MINT_POLICY_MARKETS
      : Object.freeze([singleMarket])
  }

  const markets = LOOPING_ENTRY_EXECUTION_REGISTRY.map((market) =>
    Object.freeze({
      chainId: market.chainId,
      morphoMarketId: market.marketId.toLowerCase() as `0x${string}`,
    }))
  if (
    markets.length === 0 ||
    markets.length > LOCAL_LOOPING_MINT_POLICY_MAX_MARKETS
  ) {
    throw new Error(
      'The reviewed looping entry registry does not fit the Mint policy.',
    )
  }
  return Object.freeze(markets)
}

function isLoopbackRequest(request: {
  method?: string
  headers: { host?: string }
  socket: { remoteAddress?: string }
}): boolean {
  const host = request.headers.host?.toLowerCase() ?? ''
  const remoteAddress = request.socket.remoteAddress?.toLowerCase() ?? ''
  return (
    request.method === 'GET' &&
    (host.startsWith('127.0.0.1:') || host.startsWith('localhost:')) &&
    (
      remoteAddress === '127.0.0.1' ||
      remoteAddress === '::1' ||
      remoteAddress === '::ffff:127.0.0.1'
    )
  )
}

function localLoopingMintPolicyPlugin(
  markets: readonly Readonly<LocalLoopingMintPolicyMarket>[],
): Plugin {
  return {
    name: 'openpendle-local-mint-policy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (
          requestUrl.pathname !== LOOPING_MINT_RUNTIME_POLICY_PATH ||
          !isLoopbackRequest(request)
        ) {
          next()
          return
        }
        const validUntil =
          new Date(Date.now() + 60 * 60 * 1_000).toISOString()
        const capability = {
          enabled: true,
          validUntil,
          markets,
        }
        response.statusCode = 200
        response.setHeader(
          'Content-Type',
          'application/json; charset=utf-8',
        )
        response.setHeader(
          'Cache-Control',
          'no-store, no-cache, must-revalidate, max-age=0',
        )
        response.end(JSON.stringify({
          schema: 'openpendle.looping-mint-execution-policy.v1',
          revision: 1,
          mint: {
            entry: capability,
            increase: capability,
          },
        }))
      })
    },
  }
}

function isOpenPendleCloudflareUrl(value: string | undefined): boolean {
  if (value === undefined) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.port === '' &&
      (url.hostname === OPENPENDLE_CLOUDFLARE_HOST ||
        url.hostname.endsWith(`.${OPENPENDLE_CLOUDFLARE_HOST}`))
  } catch {
    return false
  }
}

/**
 * Cloudflare previews must never inherit executable-looping release flags.
 * The canonical OpenPendle main deployment is enabled explicitly here;
 * outside it, local development still requires the opt-in VITE flags.
 */
export function resolveLoopingReleaseFlags(
  environment: LoopingBuildEnvironment,
): Readonly<{ entry: boolean; mint: boolean; exit: boolean }> {
  if (environment.CF_PAGES === '1') {
    const isMainDeployment =
      isOpenPendleCloudflareUrl(environment.CF_PAGES_URL) &&
      environment.CF_PAGES_BRANCH === 'main'
    return Object.freeze({
      entry: isMainDeployment,
      // Mint Mode always requires a separate, deliberate production release.
      mint: false,
      exit: isMainDeployment,
    })
  }

  return Object.freeze({
    entry: environment.VITE_LOOPING_EXECUTION_BETA_ENABLED === 'true',
    mint: environment.VITE_LOOPING_MINT_BETA_ENABLED === 'true',
    exit: environment.VITE_LOOPING_EXIT_BETA_ENABLED === 'true',
  })
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const environment = {
    ...loadEnv(mode, process.cwd(), ''),
    ...process.env,
  }
  const loopingReleaseFlags = resolveLoopingReleaseFlags(environment)
  const localMintPolicyMarkets = command === 'serve'
    ? resolveLocalLoopingMintPolicyMarkets(environment)
    : EMPTY_LOCAL_LOOPING_MINT_POLICY_MARKETS

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(localMintPolicyMarkets.length === 0
        ? []
        : [localLoopingMintPolicyPlugin(localMintPolicyMarkets)]),
    ],
    define: {
      'import.meta.env.VITE_LOOPING_EXECUTION_BETA_ENABLED': JSON.stringify(
        loopingReleaseFlags.entry ? 'true' : 'false',
      ),
      'import.meta.env.VITE_LOOPING_MINT_BETA_ENABLED': JSON.stringify(
        loopingReleaseFlags.mint ? 'true' : 'false',
      ),
      'import.meta.env.VITE_LOOPING_EXIT_BETA_ENABLED': JSON.stringify(
        loopingReleaseFlags.exit ? 'true' : 'false',
      ),
    },
    build: {
      // Rotate the full asset namespace once so clients that cached an old HTML
      // fallback under a chunk URL cannot reuse that poisoned response.
      assetsDir: 'assets-v2',
    },
  }
})
