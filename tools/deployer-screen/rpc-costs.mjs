/**
 * The Solana-RPC {@link import('./cost-source.mjs').CostSource} — `api.mainnet-beta` (or Helius when
 * keyed), wearing the contract. Captain decision 260a, 2026-08-05.
 *
 * **A wrapper, and nothing more.** `readCreateSlotCosts` prices exactly what it priced when
 * `stage2.mjs` called it directly: `meta.fee` (base plus priority, exact) and every account's real
 * lamport change, over the union of the create-slot scope and the closed-round-trip window scope.
 * No bound moved, no pacing moved, and the per-candidate ceiling is still the client's own.
 *
 * **What moved INTO here is the route latch, and that is the point.** Whether the whole-block read
 * is worth a request — and whether the one probe that answered it is latched for the rest of the
 * candidate — is a property of this vendor's endpoint, not of the measurement. Stage 2 used to hold
 * that latch, which meant Stage 2 held a fact about `getBlock`. A source is built per candidate
 * (the client carries its ceiling for life), so the latch's scope is unchanged: one probe, then the
 * rest of the candidate inherits the answer.
 *
 * The landing-tip limit is unchanged and is not this module's to state: a tip paid in a SEPARATE
 * transaction of the same bundle is in no figure here, every cost is therefore a lower bound, and
 * `entry.mjs` → `LANDING_TIP_CAVEAT` is the one string that travels with the numbers. What Stage 3
 * increment 2 added is a CEILING on that tip and on the cost of failing to land, read out of the
 * same block response and attributed to nobody — `pumpfun.mjs` → `readCreateSlotSlotCosts` owns it,
 * and this module still only passes the walk through.
 */

import { readCreateSlotCosts } from './pumpfun.mjs';

/**
 * Build the RPC cost source over a per-candidate Solana RPC client.
 *
 * @param {import('./pumpfun.mjs').SolanaRpcClient} rpc
 * @param {object} [opts]
 * @param {boolean} [opts.preferBlockRoute] `thresholds.json` → `stage2_cost.preferBlockRoute`.
 *   Default `true`, matching the threshold's own default.
 * @returns {import('./cost-source.mjs').CostSource}
 */
export function rpcCostSource(rpc, opts) {
  // Latched per candidate rather than per launch: the whole-block route is UNTESTED against this
  // endpoint, so the first launch pays one request to find out and the rest of the candidate
  // inherits the answer. Bounded waste, and the answer reaches the record through `viaBlock`.
  let preferBlock = opts?.preferBlockRoute ?? true;

  return {
    kind: 'solana-rpc',
    issued: () => rpc.issued(),
    remaining: () => rpc.remaining(),

    /**
     * @param {{ transactions: readonly import('./measure.mjs').WalletTransaction[],
     *   createSlot: number, mint: string | null }} input
     * @returns {Promise<import('./cost-source.mjs').CostWalkResult>}
     */
    async priceLaunch(input) {
      const walk = await readCreateSlotCosts(rpc, {
        transactions: input.transactions,
        createSlot: input.createSlot,
        // Passed through, never held: it scopes the whole-slot failed-attempt observation to this
        // launch and nothing here retains it.
        mint: input.mint,
        preferBlock,
      });
      // One probe decides the route for the candidate. `blockRouteTried` with nothing to show for
      // it is the failure; a route that was never applicable leaves the probe available.
      if (walk.blockRouteTried && walk.viaBlock === 0) preferBlock = false;
      // The contract guard lives at the CONSUMER (`stage2.mjs` → `assertCostWalkAccounted`), for
      // the reason `swapapi-fills.mjs` states: one enforcement point holds every source to it.
      return walk;
    },
  };
}
