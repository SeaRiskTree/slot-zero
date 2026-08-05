/**
 * The swap-api {@link import('./fill-source.mjs').FillSource} — pump.fun's keyless trade endpoint,
 * wearing the contract. Captain decision 260a, 2026-08-05.
 *
 * **This is the source Stage 2 runs on today and the one it must keep running on until Gate 3.** It
 * is a wrapper and nothing more: `readLaunchWindow` does the walk exactly as it did when
 * `stage2.mjs` called it directly, `windowReachMs` answers eligibility exactly as it did, and no
 * bound, cursor, tripwire or drop rule moved. What changed is who holds the knowledge that the
 * endpoint exists — this module, rather than the module that computes `roomLeft`.
 *
 * **The two questions this answers are ONE function call, and that is load-bearing.** `minAgeMs`
 * ("has this launch finished happening?") and the walk's seek cursor ("how far past the mint must I
 * reach?") are the same instant, so they are the same `windowReachMs` call. They were once two
 * expressions that merely agreed, and captain decision 144a records both times that drifted — the
 * second time silently, because the guard on it was denominated in the variable that did not move.
 * Injecting the source is what makes that structural rather than remembered: a caller cannot supply
 * its own eligibility duration because the contract does not let it.
 */

import { readLaunchWindow, windowReachMs } from './pumpfun.mjs';

/**
 * Build the swap-api fill source over a keyless client.
 *
 * The client carries the stage ceiling and the pacing (7s on this host — it sheds about a quarter
 * of what it is asked for), so the source's `issued`/`remaining` are the client's: Stage 2's
 * "reserve a whole launch before starting one" rule is unchanged and still exact.
 *
 * @param {import('./pumpfun.mjs').KeylessClient} client
 * @returns {import('./fill-source.mjs').FillSource}
 */
export function swapApiFillSource(client) {
  return {
    kind: 'swap-api',
    issued: () => client.issued(),
    remaining: () => client.remaining(),

    /**
     * @param {import('./fill-source.mjs').FillSourceBounds} bounds
     * @returns {Promise<number>}
     */
    async minAgeMs(bounds) {
      // `nowMs` is deliberately unused here: this vendor serves a launch the moment its own window
      // is in the past, so the answer is the cursor's reach and nothing else. A source whose tables
      // LAG must answer from an observed watermark instead (captain decision 257a), which is why
      // the clock is in the contract at all.
      return windowReachMs({
        windowMs: bounds.windowMs,
        seekMarginMs: bounds.seekMarginMs,
        windowSlotSpan: bounds.windowSlotSpan,
      });
    },

    /**
     * @param {import('./measure.mjs').LaunchRef} ref
     * @param {import('./fill-source.mjs').FillSourceBounds} bounds
     * @returns {Promise<import('./fill-source.mjs').SourcedLaunchWindow>}
     */
    async readWindow(ref, bounds) {
      const window = await readLaunchWindow(client, {
        mint: ref.mint,
        createdAtMs: ref.deployedAtMs,
        windowMs: bounds.windowMs,
        seekMarginMs: bounds.seekMarginMs,
        windowSlotSpan: bounds.windowSlotSpan,
        maxRequests: bounds.maxRequestsPerLaunch,
        pageLimit: bounds.tradePageLimit,
      });
      // The contract guard lives at the CONSUMER (`stage2.mjs` → `assertWindowUsable`), not here:
      // one enforcement point holds every source to it, including a future one that forgets to
      // hold itself.
      return { ...window, kind: 'swap-api' };
    },
  };
}
