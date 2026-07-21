import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export interface LoopingBuildEnvironment {
  readonly CF_PAGES?: string
  readonly CF_PAGES_BRANCH?: string
  readonly CF_PAGES_URL?: string
  readonly VITE_LOOPING_EXECUTION_BETA_ENABLED?: string
  readonly VITE_LOOPING_EXIT_BETA_ENABLED?: string
}

export const OPENPENDLE_CLOUDFLARE_HOST = 'open-pendle.pages.dev'

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
): Readonly<{ entry: boolean; exit: boolean }> {
  if (environment.CF_PAGES === '1') {
    const isMainDeployment =
      isOpenPendleCloudflareUrl(environment.CF_PAGES_URL) &&
      environment.CF_PAGES_BRANCH === 'main'
    return Object.freeze({
      entry: isMainDeployment,
      exit: isMainDeployment,
    })
  }

  return Object.freeze({
    entry: environment.VITE_LOOPING_EXECUTION_BETA_ENABLED === 'true',
    exit: environment.VITE_LOOPING_EXIT_BETA_ENABLED === 'true',
  })
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const environment = {
    ...loadEnv(mode, process.cwd(), ''),
    ...process.env,
  }
  const loopingReleaseFlags = resolveLoopingReleaseFlags(environment)

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_LOOPING_EXECUTION_BETA_ENABLED': JSON.stringify(
        loopingReleaseFlags.entry ? 'true' : 'false',
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
