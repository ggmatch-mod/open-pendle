/**
 * Local-development override for funded wallet testing.
 *
 * This flag is deliberately impossible to enable in a production build. It
 * bypasses only the temporary 1-token/0.5-token beta size caps; balance,
 * liquidity, quote, liquidation-buffer, simulation, and receipt checks remain
 * mandatory.
 */
export const LOOPING_UNCAPPED_TESTING_ENABLED =
  import.meta.env.DEV &&
  import.meta.env.VITE_LOOPING_UNCAPPED_TESTING_ENABLED === 'true'
