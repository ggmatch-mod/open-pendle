/**
 * Public build-time feature gates for wallet-submitted looping transactions.
 *
 * This is deliberately not a security boundary: every transaction still goes
 * through the allowlist, safety compiler, unsigned simulation, and wallet
 * confirmation. Production and local development stay off unless each
 * operation's explicit public flag is enabled.
 *
 * Recovery is intentionally not launch-gated: scoped nonce burns, permission
 * revokes, allowance cleanup, and browser-metadata cleanup must remain
 * available after either launch flag is disabled.
 *
 * Vite flags are compiled into the app build. New entry therefore also checks
 * the same-origin, no-store runtime policy immediately before signing and
 * again before submission, so an already-open tab can be stopped. Exit and
 * recovery deliberately do not depend on that runtime entry policy.
 */
export const LOOPING_EXECUTION_BETA_ENABLED =
  import.meta.env.VITE_LOOPING_EXECUTION_BETA_ENABLED === 'true'

export const LOOPING_EXIT_BETA_ENABLED =
  import.meta.env.VITE_LOOPING_EXIT_BETA_ENABLED === 'true'
