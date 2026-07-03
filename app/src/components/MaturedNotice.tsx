/**
 * MaturedNotice — replaces the actions area on expired markets (PLAN M1:
 * basic expired-state machine, pulled forward from M5).
 */

export function MaturedNotice() {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-center gap-2.5">
        <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
          Matured
        </span>
        <h2 className="text-base font-semibold text-zinc-100">
          This market has matured
        </h2>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        The protocol disables swaps, minting and adding liquidity after expiry.
        PT is redeemable 1:1 for the accounting asset — redemption flows arrive
        in <span className="text-zinc-200">M5</span>.
      </p>
    </section>
  )
}
