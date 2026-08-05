/**
 * The COST SOURCE CONTRACT — and nothing else. Captain decision 260a, 2026-08-05.
 *
 * ## Why the cost leg gets the same seam as the fill leg
 *
 * The premise the fill-provider work started from was that entry COST stays on the RPC regardless,
 * because `meta.fee` and pre/post balances are in no decoded trade table. That is true of decoded
 * **trade** tables and false of Dune generally: captain decision 255b authorises a Dune cost source
 * over `solana.transactions`, and the value it produces feeds `entry.mjs` →
 * `entryCostPerSolStakedByLaunch`, which gates `entry-cost-prohibitive` — a member of
 * `ENTRY_VERDICTS`. So a Dune value would reach a Stage 2 entry number **and a Stage 2 entry
 * verdict**, which is the precise thing captain decision 156a's boundary is named after.
 *
 * 260a answered that collision: 156a binds the cost leg too, and the same injection discipline
 * extends to a {@link CostSource}. This module is the wiring half of that answer. It amends 255b's
 * steps (2) and (3) in their WIRING ONLY — not its spend, not its pins, not its direction: the Dune
 * cost implementation, its SQL and its pinned prices remain that lane's to land, and it lands as a
 * second implementation behind this seam rather than as an import inside `stage2.mjs`.
 *
 * ## What that buys, concretely
 *
 * `stage2.mjs` names neither implementation, so pricing a launch cannot become a branch on vendor
 * kind inside the module that computes the bar the price is compared against. And it makes 255b's
 * own requirement — *"the offline parity harness written FIRST"* — nearly free: a fake
 * {@link CostSource} returning fixture walks exercises the whole of the cost leg with no vendor at
 * all, and both sources can be run over one candidate without either two code paths or live spend.
 *
 * ## This module imports NOTHING at runtime
 *
 * Same rule, same reason, same test as `fill-source.mjs`: a scoring module may import it precisely
 * because there is no value here that could have come from a vendor.
 *
 * {@link TransactionCosts} and {@link CostWalkResult} moved here from `pumpfun.mjs` for that reason
 * — they were the last types by which `entry.mjs` and `stage0.mjs` named a transport module, and
 * neither is RPC-specific: an exact fee and an exact per-account lamport delta are properties of the
 * chain, whoever reads them out of it.
 */

/**
 * @typedef {'solana-rpc' | 'dune'} CostSourceKind
 */

/**
 * Every provenance an entry cost may carry. **Exhaustive**, for the reason
 * `fill-source.mjs` → `FILL_SOURCE_KINDS` states.
 *
 * @type {readonly CostSourceKind[]}
 */
export const COST_SOURCE_KINDS = Object.freeze(['solana-rpc', 'dune']);

/**
 * @typedef {object} TransactionCosts
 * What one transaction cost, recovered exactly from the chain.
 *
 * @property {string} signature
 * @property {number} feeSol      `meta.fee` — **base plus priority**, in SOL. Exact, and charged to
 *   {@link TransactionCosts.feePayer}.
 * @property {string | null} feePayer `accountKeys[0]`. For a bundled transaction this is NOT the
 *   trader — CLAUDE.md's fee-payer counter-trap — which is why it is carried rather than assumed.
 * @property {Map<string, number>} solOutByWallet `(preBalance − postBalance) / 1e9` per account, so
 *   a positive number is SOL that LEFT that account. This is the wallet's real lamport change and it
 *   already nets the swap, the venue fee, rent, its own fee if it is the payer, and **any tip paid
 *   inside this transaction**.
 */

/**
 * @typedef {object} CostWalkResult
 * @property {Map<string, TransactionCosts>} priced  By signature.
 * @property {number} requests            Requests this walk issued, retries included.
 * @property {number} unresolved          Transactions the source never resolved, or whose shape it
 *   refused. Neither is "cost zero" — see `stage2.mjs`.
 * @property {number} viaBlock            Priced from a whole-block read.
 * @property {number} viaTransaction      Priced one transaction at a time.
 * @property {boolean} blockRouteTried
 * @property {string | null} blockRouteNote Why the block route was not used, when it was not.
 * @property {boolean} stoppedForBudget   The per-candidate ceiling ended the walk early.
 */

/**
 * A source of exact, fee-inclusive transaction costs.
 *
 * @typedef {object} CostSource
 * @property {CostSourceKind} kind
 *   Provenance. Carried, and read by no bar — the same posture {@link CostWalkResult}'s producers
 *   are held to and `fill-source.mjs` states in full.
 * @property {(input: { transactions: readonly import('./measure.mjs').WalletTransaction[],
 *   createSlot: number }) => Promise<CostWalkResult>} priceLaunch
 *   Price one launch's target transactions. **The route choice is the SOURCE'S**, not Stage 2's:
 *   whether a whole-block read is worth a request, and whether the probe that answered that is
 *   latched for the rest of the candidate, is a property of the vendor and belongs with it.
 * @property {() => number} issued    Requests spent so far, retries included.
 * @property {() => number} remaining Requests left under this source's own PER-CANDIDATE ceiling.
 *   Stage 2 reserves a whole launch's targets before starting one, because a launch priced half-way
 *   yields the cost of whichever entrants sorted first — a biased sample rather than a short one.
 */

/**
 * Refuse a cost walk that cannot be accounted for.
 *
 * The counterpart to `fill-source.mjs` → `assertWindowUsable`, and it throws for the same reason: a
 * walk whose counters do not add up is a source bug, and Stage 2 reconciles a run record
 * arithmetically from exactly these numbers. A silent disagreement here surfaces later as a coverage
 * figure that cannot be checked against anything.
 *
 * @param {CostWalkResult} walk
 * @param {number} targets How many transactions the launch asked for.
 * @returns {void}
 */
export function assertCostWalkAccounted(walk, targets) {
  if (walk.priced.size > targets) {
    throw new Error(
      `a cost source priced ${walk.priced.size} transaction(s) for a launch that asked for ${targets}`,
    );
  }
  if (walk.viaBlock + walk.viaTransaction !== walk.priced.size) {
    throw new Error(
      `a cost source's routes account for ${walk.viaBlock + walk.viaTransaction} priced ` +
        `transaction(s) against ${walk.priced.size} actually priced`,
    );
  }
  if (walk.viaBlock > 0 && !walk.blockRouteTried) {
    throw new Error('a cost source priced from a block it says it never tried to read');
  }
}
