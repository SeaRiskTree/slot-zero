/**
 * Stage 2 — ENTRY. The pure measurement core. No I/O, no network, no clock.
 *
 * ## The question this serves
 *
 * The captain's, verbatim (2026-07-29):
 *
 * > *"Can I beat the dev and all other wallets sniping the same tokens created by the dev
 * > currently?"*
 *
 * That splits cleanly in two, and this module owns both halves of the ENTRY side:
 *
 * 1. **Entry room** — how much of the opening window the deployer and its own wallets take before
 *    anyone else is filled. This is the quantity that decided the 2026-06-04 finding, and the
 *    captain's framing of it is the one to keep, because they arrived at it independently: it
 *    measures **how badly configured the dev's own launch bot is.** A dev whose bot leaves the
 *    bottom of its own curve to strangers is a dev whose launches have room in them; a dev whose
 *    bot takes it all has already won the race before anyone else has a chance to run it.
 * 2. **The field** — what every OTHER sniping wallet on those same tokens actually achieved: how
 *    much they were filled for, where they sat in the queue, and what they realised. The question
 *    is whether *we* beat them, so the competition is measured rather than assumed.
 *
 * ## What this module deliberately does NOT do
 *
 * **It does not score exit feasibility, and no exit signal reaches an entry number.** Room to enter
 * is not room to leave. When the dev sells, whether its trigger is a *size* that our own buy would
 * count towards, and whether an outsider could have got out first, are Stage 3's separate
 * deliverable. Keeping them unmixed is the point: a single blended number would let a wide entry
 * hide a trap, and there is no way to read back out of it which leg carried the verdict.
 *
 * ## Distributions and a hit rate, never a mean
 *
 * A standing bar from the captain for this class of claim, and it is a correctness rule rather than
 * a presentational one. Sniper outcomes are heavy-tailed on both sides — on our own subject's
 * post-break launches the p90 outsider round trip is roughly twenty times the median — so a mean is
 * dominated by whichever tail is fatter and describes nobody's experience. It is a **wrong answer,
 * not a rough one.** Nothing in this module computes one, and a test asserts the word does not
 * appear in it.
 *
 * ## What the fill tape can say about fees is NOTHING, and that is load-bearing
 *
 * The fill tape carries swap-quote SOL. It does not carry the priority fee, the landing tip, the
 * venue fee or rent, and only `onchain_*.csv` in the committed dataset is fee-inclusive. So every
 * P&L computed from fills alone is an **upper bound** on what a wallet actually took, and every such
 * field is named `…GrossOfFees` so a caller cannot forget. The size of the gap is measured, not
 * feared: on our subject's post-2026-06-04 launches the field reads **76.3% of closed round trips
 * positive with a median +0.12 SOL gross**, while the fee-inclusive truth over the same launches is
 * **+0.54 SOL per launch shared across 106 wallets, 51 of them negative**
 * (`slot-zero-june-regime-change/report.md` §6.5). Read naively, gross says the field is winnable.
 * It is not.
 *
 * That is exactly why the field is a **necessary condition and never a sufficient one**: a field
 * that loses money before costs certainly loses money after them, but a field that makes money
 * before costs has established nothing. {@link scoreEntry} is wired that way, and Stage 0 asserts
 * the consequence on the one wallet where we hold the answer.
 *
 * ## The fee is inside the entry window, so the cost of the seat is measured too
 *
 * Captain's standing ruling, 2026-08-02: fees are part of the entry window, and "enterable" means
 * enterable **after what it costs to enter**. What the fill tape cannot say, the chain can — every
 * fill carries its transaction signature, so the transactions that bought a stranger's create slot
 * are a by-product of a walk that has already happened. {@link entryCostTargets} names them,
 * `pumpfun.mjs` → `readCreateSlotCosts` prices them, and {@link priceLaunchEntry} attaches the
 * result. The `…NetOfMeasuredFees` fields sit **beside** the gross ones and replace none of them.
 *
 * Two limits travel with every one of those numbers rather than living in a document —
 * {@link LANDING_TIP_CAVEAT} and {@link WINNERS_ONLY_CAVEAT} — and both run in the same direction:
 * entry looks cheaper, and the field more profitable, than either was.
 *
 * ## And a THIRD optimism, which is not about fees at all — it is about who gets counted
 *
 * Captain decision 461, 2026-08-11. Every field figure above is computed over the positions that
 * GOT OUT. A position that was entered and never exited was dropped from the denominator rather
 * than resolved, so `fieldHitRateGrossOfFees` and `fieldHitRateNetOfMeasuredFees` are
 * **P(profit | the position exited)** and not P(profit).
 *
 * That is the right quantity for the question Stage 2 asks — *is the field, once out, in profit* —
 * and it is the wrong one for *what did a position taken here actually realize*. Measured on the
 * committed tape over the same 32 launches and the same 265 create-slot outsider positions,
 * fee-inclusive: conditioned on exiting the field reads 80/158 positive and **+108.28 SOL**; over
 * every position taken, with the unexited resolved at zero recovery, it reads 86/265 and
 * **−8.12 SOL**. Same launches, same positions, one construction choice — the 107 that never got
 * out are worth −116.40 SOL between them.
 *
 * **And those positions are not unknowns, they are losses.** Of the 140 priced create-slot outsider
 * entries that never closed, **7 = 0.0500 [0.0203, 0.1003]** are above water once their remaining
 * tokens are marked at the token's LATEST known price. So dropping them deletes losers
 * rather than unknowns, and the conditioned denominator is **optimistic rather than conservative**.
 * (`slot-zero-stage3-exit-design` → `report.md` §§5.3, 5.4, held in firstmate's records, not in
 * this repo.)
 *
 * So {@link FieldEntrant.positionOutcome} splits the old `closedInWindow` boolean into the three
 * states {@link POSITION_OUTCOMES} names, and every `…OverAllPositions` figure on
 * {@link EntryScore} is the same statistic over every position taken. **Both constructions are
 * reported and neither replaces the other** — {@link REALISATION_CONSTRUCTION_CAVEAT} is the label
 * that says which is which, and it is on every score.
 *
 * **NOTHING GATES ON THE NEW FIGURES.** No bar, gate, threshold, predicate or verdict reads one and
 * no threshold moved for them, which is the shape captain decision 208b established for
 * {@link EntryScore.roomLeftBound}: record it, publish it, decide nothing with it yet. That is
 * precisely what makes a change that reverses the sign of a headline number safe to land.
 *
 * ## And the refusal that sits on top of all of it is now ARITHMETIC rather than a sentence
 *
 * Captain decision 466, Stage 3 increment 2. *"Two cost terms are still unbounded, so no profit
 * verdict may be issued"* was, until now, a claim in this header and a clause inside
 * {@link REALISATION_CONSTRUCTION_CAVEAT} — a hand-maintained condition, which is the shape that has
 * gone stale twice in this tree. `bounds.mjs` makes it a function: {@link EntryScore.costLedger} is
 * one typed row per cost and population component, and {@link EntryScore.exitVerdict} is
 * `bounds.mjs` → `exitVerdict` over it, which returns `'exit-unbounded'` whenever ANY cost row has
 * no numeric boundary.
 *
 * Two of those rows became numbers here at zero marginal cost — the create slot's whole
 * failed-attempt fee bill and its whole tip total, read out of a `getBlock` response the cost leg
 * already fetched (`pumpfun.mjs` → `readCreateSlotSlotCosts`). **Three stay `null`**, so every
 * candidate this build can score still reads `'exit-unbounded'`, and that is the correct state
 * rather than a defect. The verdict is REPORTING on the same terms as everything else in this
 * header: no entry verdict, bar, gate or threshold reads it, and a test pins that a run's entry
 * findings are byte-identical with it present and absent.
 */

import { costLedger, describeCostLedger, exitVerdict } from './bounds.mjs';
import {
  ENTRANT_IDENTITY_IS_A_WALLET_NOT_A_TRADER,
  ROOM_LEFT_RANGE,
  blockTxIndex,
  createSlotGroups,
  entrantUnitIsProven,
  median,
  percentile,
  roomIsProven,
  tallyCreateSlot,
  walletTransactions,
} from './measure.mjs';
import { clopperPearson } from './stats.mjs';

/**
 * The one limit that must travel with every cost and every after-cost figure this module produces.
 *
 * It is a constant rather than a sentence retyped at each call site because the requirement is that
 * it reaches **the number**, not the documentation: the score's caveats, the rendered block and the
 * persisted run record all carry this exact string, so a figure cannot be lifted out of one surface
 * and quoted without it.
 *
 * The direction is what makes it non-optional. A tip we cannot see makes entry look CHEAPER and the
 * field look MORE profitable than either was, which is the direction the captain's standing
 * tiebreaker — a null beats a false positive — exists to refuse.
 */
export const LANDING_TIP_CAVEAT =
  'A LANDING TIP PAID IN A SEPARATE TRANSACTION OF THE SAME BUNDLE IS NOT IN ANY FIGURE ABOVE. It ' +
  'is not recoverable from the entrant\'s own transaction and it is not measured anywhere in this ' +
  'repo\'s ground truth either, so every cost here is a LOWER bound and every after-cost result an ' +
  'UPPER bound: entry looks cheaper, and the field more profitable, than either was.';

/**
 * The second limit on the same numbers, and it runs the same way.
 *
 * Every fill in the tape belongs to a wallet that WON the auction. Post-break our subject's launches
 * saw a median 41.6 attempts per landed transaction, and a landed-but-failed attempt still pays its
 * fee — so the measured cost of entering is the cost paid by winners and it understates the cost of
 * trying (`slot-zero-stage2-correctness-and-fees/report.md` §5.8).
 */
export const WINNERS_ONLY_CAVEAT =
  'THE COST ABOVE IS THE COST PAID BY WINNERS. Every fill in the tape belongs to a wallet that won ' +
  'the auction; the wallets that paid and did not land are invisible to it. Post-break our own ' +
  'subject saw a median 41.6 attempts per landed transaction, so this understates the cost of ' +
  'TRYING to enter — again in the optimistic direction.';

/**
 * A position counts as closed when the residual is within 0.1% of the tokens bought.
 *
 * Not a choice — it is the committed dataset's own `closed_in_window` rule, and Stage 0 checks
 * that reproducing it from the raw tape agrees with `wallet_launch_pnl.csv` on every create-slot
 * outsider pair. Matching it is what makes a live measurement comparable to the published one.
 */
export const RESIDUAL_TOLERANCE = 0.001;

/**
 * @typedef {'exited' | 'still-held-at-horizon' | 'horizon-not-observed'} PositionOutcome
 *
 * What became of one position taken. Captain decision 461: **every position taken gets an outcome**,
 * and the three are kept apart because two of them used to be the same value.
 *
 * - **`exited`** — flat by the horizon (residual within {@link RESIDUAL_TOLERANCE} of the tokens
 *   bought, the committed dataset's own `closed_in_window` rule). A realized figure exists, and it
 *   is the one the `…GrossOfFees` / `…NetOfMeasuredFees` fields already carried.
 * - **`still-held-at-horizon`** — the wallet bought, we can read what it bought and what it sold,
 *   and it was not flat. **Resolved at ZERO RECOVERY** in every `…AtZeroRecovery` /
 *   `…OverAllPositions` figure, with {@link FieldEntrant.residualMarkedSolAtWindowLastPriceGrossOfFees} printed
 *   BESIDE it and never instead of it. Zero recovery is the worst case for the part we cannot see,
 *   which is what the captain's standing evidence bar asks a figure to survive; the mark is the
 *   bound on it, and a mark is a price nobody paid.
 * - **`horizon-not-observed`** — OUR COVERAGE. The rows we hold cannot decide closure at all, so
 *   the position is carried, counted and surfaced, and it is resolved NEITHER way. Never a loss and
 *   never a hit: an undecidable position resolved at zero recovery would be a manufactured loss,
 *   which is the mirror of the manufactured profit this whole correction removes. Captain decision
 *   174b's rule applies to it unchanged — {@link EntryScore.positionsHorizonNotObserved} is
 *   reported, and a later stage may not filter a candidate on it.
 *
 * **What can produce the third one, exhaustively, and what cannot.** Today it is the undecidable
 * closure case alone: a fill whose token amount we could not read, or an entrant whose buys sum to
 * no tokens at all, so `tokensBought − tokensSold` is not a residual. The other producer a reader
 * will look for — *the walk did not reach the end of the window* — **cannot arise inside a scored
 * launch**, and that is a property of the fill-source contract rather than of this function: a
 * source that cannot prove it covered the window returns `usable: false`, `stage2.mjs` →
 * `assertWindowUsable` holds every source to that, and the launch is dropped whole and counted as
 * `launchesDropped` (`our-coverage`, unfilterable, already 174b-compliant). So the coverage question
 * is answered one layer up, per LAUNCH, and this outcome is the per-POSITION remainder of it.
 */

/**
 * Every value {@link FieldEntrant.positionOutcome} may take, in the order the design states them.
 *
 * Exported as a closed set so a consumer can exhaust it rather than testing for the two it happens
 * to have thought of, which is the boolean this replaces.
 *
 * @type {readonly PositionOutcome[]}
 */
export const POSITION_OUTCOMES = Object.freeze([
  'exited',
  'still-held-at-horizon',
  'horizon-not-observed',
]);

/**
 * The label that keeps the two realized constructions apart, and it is on every score.
 *
 * A constant rather than a sentence retyped per surface, for the reason {@link LANDING_TIP_CAVEAT}
 * is one: the requirement is that it reaches **the number** — the score's caveats, the rendered
 * block and the persisted run record — so neither figure can be lifted out of a surface and quoted
 * as though it were the other.
 *
 * Note what it does NOT say. It does not say the all-positions figure is a profit verdict, and it no
 * longer asserts WHICH cost terms are unbounded either: that is {@link EntryScore.costLedger}'s to
 * state and {@link EntryScore.exitVerdict}'s to rule on. The clause names the residual ROWS rather
 * than counting them, so an increment that bounds one cannot leave the sentence wrong. See the
 * module header.
 */
export const REALISATION_CONSTRUCTION_CAVEAT =
  'TWO REALIZED CONSTRUCTIONS ARE REPORTED AND NEITHER REPLACES THE OTHER. The *OfFees figures are ' +
  'conditioned on the position having EXITED, which is the OPTIMISTIC one: a position that was ' +
  'entered and never exited is dropped from that denominator rather than resolved, and on the ' +
  'committed tape those dropped positions are 95% LOSSES even when their remaining tokens are ' +
  "marked at the token's LATEST known price — so dropping them deletes losers, not " +
  'unknowns. The *OverAllPositions figures beside them count every position taken, with the ones ' +
  'still held at the horizon resolved at ZERO RECOVERY (the worst case) and their marked residual ' +
  "reported separately — and that residual is marked at the WINDOW's own last price, which is the " +
  'MORE GENEROUS of the two marks, not the harsher latest-known-price one this sentence cites. ' +
  'Positions whose closure our own rows cannot decide are in NEITHER ' +
  'construction and are counted as horizon-not-observed. NONE of this is a profit verdict. The ' +
  'landing tip and the cost of failed attempts are bounded only INSIDE THE CREATE SLOT, by a ' +
  "whole-slot ceiling attributed to one entrant rather than by any measurement of what an entrant " +
  'paid; their residuals — landing-tip-outside-bound and failed-attempts-rest-of-window — carry no ' +
  'numeric boundary at all. Which cost terms are unbounded is not asserted here: it is read off ' +
  'the subtraction ledger, and the refusal that follows from it is exitVerdict.';

/**
 * That the net all-positions population is a NON-RANDOM subset of the gross one, stated the way
 * {@link LANDING_TIP_CAVEAT} and {@link WINNERS_ONLY_CAVEAT} state their own limits — and with the
 * direction left UNSIGNED, which is the whole point of it.
 *
 * **The condition, exactly.** A position carries a whole-window net figure only where every
 * transaction the wallet appears in across the window was in the priced target set —
 * `mine.length === windowTxCount` in {@link priceLaunchEntry}. {@link entryCostTargets} admits a
 * transaction when it is in the create slot OR it carries a wallet that closed, so this is NOT
 * "the wallet never traded again" and NOT "it never sold": a wallet that sold inside its create slot
 * is in scope, and a wallet whose later transaction happens to be bundled with a closed wallet is
 * priced whole.
 *
 * **Why the direction is not signed.** `realisedSolAtZeroRecoveryGrossOfFees` is `solOut − solIn`.
 * An excluded wallet that SOLD later has recovered SOL and would have scored better, which pulls the
 * net reading down; an excluded wallet that BOUGHT more later — averaging in, ordinary sniper
 * behaviour — carries a larger `solIn`, would have scored worse, and pulls it up. Which way the
 * selection runs therefore depends on the mix of later buys and later sells among the excluded
 * positions, and that mix is UNMEASURED. Captain decisions 198b and 208b already refuse this shape:
 * an unmeasured direction is not to be signed, and a one-way correction to it is wrong.
 *
 * What survives either way is that the two readings are not a fee apart, so the gap between them
 * cannot be read as a fee cost. The cost leg was not widened to close the shortfall because widening
 * it is a spend.
 */
export const NET_ALL_POSITIONS_SELECTION_CAVEAT =
  'THE NET *OverAllPositions FIGURES ARE OVER A NON-RANDOM SUBSET OF THE GROSS ONES, AND WHICH WAY ' +
  'THAT SELECTION RUNS IS UNMEASURED. A position carries a whole-window net figure only where every ' +
  'transaction it appears in across the window was already in the priced target set — which admits ' +
  'the create slot and any transaction carrying a wallet that closed, so a wallet that sold inside ' +
  'its create slot is in scope and a wallet bundled with a closed one can be priced whole. An ' +
  'excluded wallet that sold later would have scored better and an excluded wallet that bought more ' +
  'later would have scored worse, so the direction depends on a mix this run has not measured and ' +
  'is NOT claimed. DO NOT difference the net and gross readings to infer a fee cost: the gap is not ' +
  'all fees. The cost leg was not widened to close it, which would be a spend.';

/**
 * @typedef {object} BoundedHitRate
 * @property {number} n     Observations the rate is over.
 * @property {number} hits
 * @property {number} rate  `hits / n`, or `NaN` when `n === 0`.
 * @property {number} lo    Exact (Clopper–Pearson) two-sided 95% lower bound; `NaN` when `n === 0`.
 * @property {number} hi    The upper bound, on the same terms.
 */

/**
 * A share of a sample WITH its exact interval — {@link hitRate} plus the two bounds.
 *
 * Separate from {@link hitRate} rather than a widening of it, deliberately. `HitRate` is pinned in
 * the run record's schema at four earlier versions and a consumer version-detects on that shape, so
 * growing it would silently change what every older reader parses. This is the shape for a rate
 * added from captain decision 461 onward.
 *
 * **Why the interval is not optional here.** Every rate this reports is over a small, hard-won n,
 * and the whole content of the correction is that two constructions of the SAME population read
 * differently — a reader comparing 0.5063 with 0.3245 has to be able to see whether the difference
 * survives the sample. The bare rates cannot say; the intervals can. Exact rather than approximate
 * for the reason `stats.mjs` states.
 *
 * @template T
 * @param {readonly T[]} values
 * @param {(v: T) => boolean} predicate
 * @returns {BoundedHitRate}
 */
export function boundedHitRate(values, predicate) {
  const h = hitRate(values, predicate);
  const ci = clopperPearson(h.hits, h.n);
  return { ...h, lo: ci === null ? Number.NaN : ci.lo, hi: ci === null ? Number.NaN : ci.hi };
}

/**
 * @typedef {object} Distribution
 * @property {number} n
 * @property {number} min
 * @property {number} p10
 * @property {number} p25
 * @property {number} median
 * @property {number} p75
 * @property {number} p90
 * @property {number} max
 *
 * Note what is absent, and note that it is absent on purpose. See the module header.
 */

/**
 * Summarise a sample by its quantiles.
 *
 * @param {readonly number[]} values
 * @returns {Distribution} All-`NaN` for an empty sample, which is the honest answer for one.
 */
export function distribution(values) {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) {
    const nan = Number.NaN;
    return { n: 0, min: nan, p10: nan, p25: nan, median: nan, p75: nan, p90: nan, max: nan };
  }
  return {
    n: usable.length,
    min: percentile(usable, 0),
    p10: percentile(usable, 0.1),
    p25: percentile(usable, 0.25),
    median: median(usable),
    p75: percentile(usable, 0.75),
    p90: percentile(usable, 0.9),
    max: percentile(usable, 1),
  };
}

/**
 * @typedef {object} HitRate
 * @property {number} n     Observations the rate is over.
 * @property {number} hits
 * @property {number} rate  `hits / n`, or `NaN` when `n === 0`.
 */

/**
 * Share of a sample satisfying a predicate.
 *
 * `NaN` rather than `0` for an empty sample: "no observations" and "none of the observations hit"
 * are different findings, and rounding the first to the second manufactures a negative result out
 * of missing data — the failure mode the whole tool is shaped against.
 *
 * @template T
 * @param {readonly T[]} values
 * @param {(v: T) => boolean} predicate
 * @returns {HitRate}
 */
export function hitRate(values, predicate) {
  const hits = values.filter(predicate).length;
  return { n: values.length, hits, rate: values.length === 0 ? Number.NaN : hits / values.length };
}

/**
 * @typedef {object} FieldEntrant
 * One competing wallet on one launch: a wallet that reached the create slot and is not the
 * deployer and not marked as the operation's own by the bundle rule.
 *
 * @property {string} wallet
 * @property {string} sid  pump.fun's own within-slot ordering key for this wallet's FIRST
 *   create-slot fill — `slot(12) + blockTxIndex(6) + innerInstructionIndex(4)`, verbatim and as a
 *   STRING, never parsed to a number (`measure.mjs` → `blockTxIndex` owns why: 22 digits is past
 *   `Number.MAX_SAFE_INTEGER`). It is the byte that makes an entrant row auditable against the chain
 *   and re-orderable after the fact, it is free in rows the walk has already fetched, and it is the
 *   one thing here that is **unrecoverable without re-walking the window**.
 * @property {string} createSlotTx  The signature of the transaction that fill landed in. Free in the
 *   same row, and the key a human hand-checks a claim with.
 * @property {number} blockTxIndex  {@link import('./measure.mjs').blockTxIndex} of `sid` — where in
 *   the block that transaction sat. `NaN` when the key is not that shape, never a guess.
 * @property {number} createSlotFillSol  What it was filled for in the create slot itself.
 * @property {number} solQueuedAheadSol  SOL already committed to the create slot ahead of this
 *   wallet's first fill, by pump.fun's own within-slot ordering key. The June report's §5.2
 *   measure of how far back in the queue an outsider now sits.
 * @property {number} queuePosition      1-based rank of that first fill among all create-slot fills.
 * @property {number} outsiderQueuePosition 1-based rank among the create-slot fills of OUTSIDERS
 *   alone — the queue with the operation's own fills removed. Reported beside `queuePosition`
 *   rather than instead of it because the two answer different questions ("how far into the block
 *   did this land" against "how many rivals were served first") and neither is recoverable from the
 *   other once the window is gone.
 * @property {boolean} entrantUnitIsProven Whether the one available collapse rule evidenced this row
 *   as ONE submitter — `measure.mjs` → `entrantUnitIsProven`, which owns the rule, its
 *   counterexample, and the fact that it reads `false` on every create-slot outsider **by
 *   construction** under the shipped co-ordination rule. `false` means nothing was established
 *   either way; it never means the wallet is an independent trader.
 * @property {string[]} unitCoAppearingWallets The evidence that flag reads: other distinct swapping
 *   wallets sharing one of this wallet's create-slot transactions. Empty by the construction above.
 * @property {string[]} windowCoAppearingWallets The same co-appearance over the WHOLE walked window,
 *   where half (a) does not reclassify anybody and the set is therefore not empty by construction.
 *   Recorded and read by nothing: widening the collapse scope is a decision, not a diff.
 * @property {number} stakeSol           Total buy SOL across the whole opening window.
 * @property {boolean} closedInWindow    Whether the position was flat by the window's end.
 *   **Exactly `positionOutcome === 'exited'`, and it is kept so no existing figure moves.** It is
 *   the field that could not tell a wallet that was still HOLDING from one whose closure our rows
 *   could not decide; read {@link FieldEntrant.positionOutcome} for that.
 * @property {PositionOutcome} positionOutcome  What became of this position — {@link
 *   POSITION_OUTCOMES} owns the three states and the rule. Captain decision 461.
 * @property {number} windowTxCount      Distinct transactions this wallet appears in across the
 *   whole walked window. Free from the same fills, and it is what lets {@link priceLaunchEntry}
 *   tell a wallet whose WHOLE window was priced from one whose create slot alone was: an unexited
 *   position is not in the cost leg's round-trip scope, so its later transactions are usually
 *   unpriced, and a sum over the ones that happen to be in scope would be a WRONG figure rather
 *   than a missing one.
 * @property {number} residualTokens     `tokens bought − tokens sold` at the horizon. `NaN` when
 *   closure is undecidable; at or near zero on an exited position by the closure rule itself.
 * @property {number} residualMarkedSolAtWindowLastPriceGrossOfFees  {@link FieldEntrant.residualTokens} valued
 *   at the LAST price the walked window itself showed. **The bound printed beside the zero-recovery
 *   resolution, never instead of it** — a mark is a price nobody paid, and on the committed tape
 *   95% of unexited positions are losses even marked at the token's LATEST known price.
 *   `NaN` when the residual or the window's last price is unreadable. Gross of fees like every other
 *   fill-derived figure.
 * @property {number} realisedSolAtZeroRecoveryGrossOfFees  `sol out − sol in` with anything still held
 *   valued at NOTHING. Defined on an `exited` position (where it EQUALS
 *   {@link FieldEntrant.realisedSolGrossOfFees}) and on a `still-held-at-horizon` one; `NaN` on
 *   `horizon-not-observed`, which is resolved neither way.
 * @property {number} returnPerSolAtZeroRecoveryGrossOfFees  That over `stakeSol`. `NaN` on the same terms.
 * @property {number} realisedSolAtZeroRecoveryNetOfMeasuredFees  The same worst-case resolution, from real lamport
 *   changes rather than from quotes. **`NaN` unless every one of this wallet's
 *   {@link FieldEntrant.windowTxCount} window transactions was priced** — every transaction the
 *   wallet appears in has to have been in {@link entryCostTargets}'s set, which admits the create
 *   slot and any transaction carrying a wallet that closed, so a wallet that sold INSIDE its create
 *   slot is in scope and a wallet bundled with a closed one is priced whole. That is not a gap to be closed by asking for
 *   more: widening the target list would spend RPC requests this correction is not authorised to
 *   spend, and the count is reported instead.
 * @property {number} returnPerSolAtZeroRecoveryNetOfMeasuredFees  That over `stakeSol`. `NaN` on the same terms.
 * @property {number} realisedSolGrossOfFees   `sol out − sol in`. **`NaN` unless closed** — an open
 *   position has no complete P&L, and the committed dataset makes the same field absent rather than
 *   zero for exactly this reason.
 * @property {number} returnPerSolGrossOfFees  `realised / stake`. `NaN` unless closed.
 * @property {number} entryCostSol   What landing in the create slot cost this wallet OVER AND ABOVE
 *   the position it took: its real lamport outflow minus the swap-quote SOL it committed there. So
 *   it is the fee (base and priority), the venue fee, the rent, the execution difference, and any
 *   tip paid INSIDE its own transaction. **`NaN` until the create slot is priced on-chain** — the
 *   fill tape cannot see any of it. See {@link LANDING_TIP_CAVEAT} for what it still misses.
 * @property {number} entryCostPerSolStaked `entryCostSol / createSlotFillSol` — the price of the
 *   seat per SOL of seat, for THIS ONE ENTRY. `NaN` unless priced. The verdict does not read this
 *   figure directly: see {@link EntryScore.entryCostPerSolStakedByLaunch}.
 * @property {number} entryTxFeeSol  The transaction fee, base plus priority, on the create-slot
 *   transactions this wallet PAID FOR. Exact where it applies, and zero where another account was
 *   the fee payer — the counter-trap CLAUDE.md names. Carried apart from `entryCostSol` because it
 *   is the observable price of the slot auction specifically. `NaN` unless priced.
 * @property {number} realisedSolNetOfMeasuredFees  `realisedSolGrossOfFees` less every measured
 *   cost across the whole window, computed from real lamport changes rather than from quotes.
 *   **`NaN` unless the position closed AND every one of its window transactions was priced.**
 * @property {number} returnPerSolNetOfMeasuredFees `net realised / stake`. `NaN` on the same terms.
 */

/**
 * @typedef {object} LaunchEntry
 * @property {import('./measure.mjs').CreateSlotMeasurement} createSlot
 * @property {FieldEntrant[]} field  Every competing wallet in the create slot. May be empty, which
 *   is itself a finding: eight of our subject's 89 post-break launches had no outsider at all, and
 *   under the union rule all 89 of them are proven. Refusing unproven openings never moved that
 *   count — under the shared-transaction rule alone it was eight over the 86 that rule could prove,
 *   because none of the three launches it refused was outsider-free.
 */

/**
 * Measure one launch's opening window: the operation's share of it, and everyone else's outcome.
 *
 * @param {readonly import('./measure.mjs').Fill[]} fills All fills for one launch's opening window.
 * @returns {LaunchEntry | null} `null` when there is no bonding-curve buy to anchor the create slot
 *   on — the honest answer for a window whose start we cannot see.
 */
export function measureLaunchEntry(fills) {
  const groups = createSlotGroups(fills);
  if (groups === null) return null;
  const { inSlot } = groups;

  // The room figure and the population it is a statement about come from ONE tally, so the two
  // cannot drift apart under a change to the co-ordination rule.
  const { measurement: createSlot, outsiders } = tallyCreateSlot(groups);

  // Queue position and the SOL already ahead, walked in the venue's own within-slot order.
  //
  // `sid`, `createSlotTx` and the outsider-only rank are captured in the SAME pass and from the same
  // fill the position is read off, so the ordering key a record carries is always the key that
  // produced the position rather than a second lookup that could pick a different one of the
  // wallet's fills. They are free — every field is already on the parsed fill — and `sid` is the one
  // thing here that cannot be recovered from anything else once the window is gone.
  /** @type {Map<string, { aheadSol: number, position: number, outsiderPosition: number, fillSol: number, sid: string, tx: string }>} */
  const queue = new Map();
  let cumulativeSol = 0;
  let outsiderRank = 0;
  for (let i = 0; i < inSlot.length; i++) {
    const f = /** @type {import('./measure.mjs').Fill} */ (inSlot[i]);
    if (outsiders.has(f.wallet)) {
      outsiderRank += 1;
      const seen = queue.get(f.wallet);
      if (seen === undefined) {
        queue.set(f.wallet, {
          aheadSol: cumulativeSol,
          position: i + 1,
          outsiderPosition: outsiderRank,
          fillSol: f.sol,
          sid: f.sid,
          tx: f.tx,
        });
      } else seen.fillSol += f.sol;
    }
    cumulativeSol += f.sol;
  }

  // The one collapse rule there is, computed from `createSlotGroups`' OWN transaction map rather
  // than from a second grouping of the same fills — `measure.mjs` → `entrantUnitIsProven` owns the
  // rule and the reason it reads false on every row this loop can produce. The window-wide cousin is
  // built beside it because the fills are already here and nothing else will ever pay for them.
  /** @param {ReadonlyMap<string, ReadonlySet<string>>} byTx @param {string} wallet */
  const coAppearing = (byTx, wallet) => {
    /** @type {Set<string>} */
    const peers = new Set();
    for (const wallets of byTx.values()) {
      if (!wallets.has(wallet)) continue;
      for (const w of wallets) if (w !== wallet) peers.add(w);
    }
    return [...peers];
  };
  /** @type {Map<string, Set<string>>} */
  const createSlotByTx = new Map();
  for (const [tx, t] of groups.transactions) createSlotByTx.set(tx, new Set(t.wallets));
  /** @type {Map<string, Set<string>>} */
  const windowByTx = new Map();
  for (const f of fills) {
    let w = windowByTx.get(f.tx);
    if (w === undefined) {
      w = new Set();
      windowByTx.set(f.tx, w);
    }
    w.add(f.wallet);
  }

  // Whole-window totals, needed for the closure test. Sells matter as much as buys: a wallet that
  // never sold has no realised figure at all, and imputing one from a mark is how a paper number
  // becomes a claimed profit.
  //
  // `txs` rides along because it is the same pass and the same rows: how many DISTINCT transactions
  // this wallet made inside the window is what tells the cost leg later whether it priced the whole
  // of a position or only its create slot (captain decision 461, and see
  // {@link FieldEntrant.windowTxCount}).
  /** @type {Map<string, { solIn: number, solOut: number, tokensBought: number, tokensSold: number, txs: Set<string> }>} */
  const totals = new Map();
  for (const f of fills) {
    let t = totals.get(f.wallet);
    if (t === undefined) {
      t = { solIn: 0, solOut: 0, tokensBought: 0, tokensSold: 0, txs: new Set() };
      totals.set(f.wallet, t);
    }
    t.txs.add(f.tx);
    if (f.side === 'buy') {
      t.solIn += f.sol;
      t.tokensBought += f.tokens;
    } else {
      t.solOut += f.sol;
      t.tokensSold += f.tokens;
    }
  }

  // THE WINDOW'S OWN LAST PRICE, which is the only mark this walk can produce for free.
  //
  // It is the SOL per token of the newest readable fill the window holds, in the venue's own
  // within-slot order — `sid` is the ordering key and it is compared as a STRING, because 22 decimal
  // digits is past `Number.MAX_SAFE_INTEGER` (`measure.mjs` → `blockTxIndex` owns why). All the
  // window's `sid`s share a length, so a lexicographic comparison IS the numeric one; the slot
  // comparison ahead of it makes that independent of any key that is not that shape.
  //
  // It exists to BOUND the zero-recovery resolution, never to replace it: the design's own
  // measurement puts 54 of 140 unexited positions above water at this mark against 7 of 140 at the
  // token's LATEST known price, so this is the FLATTERING mark of the two and is reported
  // as a bound rather than as an outcome.
  /** @type {import('./measure.mjs').Fill | null} */
  let newest = null;
  for (const f of fills) {
    if (!(Number.isFinite(f.sol) && Number.isFinite(f.tokens) && f.tokens > 0)) continue;
    if (
      newest === null ||
      f.slot > newest.slot ||
      (f.slot === newest.slot && f.sid > newest.sid)
    ) {
      newest = f;
    }
  }
  const windowLastPrice = newest === null ? Number.NaN : newest.sol / newest.tokens;

  /** @type {FieldEntrant[]} */
  const field = [];
  for (const [wallet, q] of queue) {
    const t = totals.get(wallet) ?? {
      solIn: 0,
      solOut: 0,
      tokensBought: 0,
      tokensSold: 0,
      txs: new Set(),
    };
    // An unreadable token amount makes closure undecidable. Undecidable is reported as OPEN, never
    // as closed: a wrongly-closed pair contributes a fabricated P&L to the distribution, whereas a
    // wrongly-open one only shrinks the sample and says so.
    const decidable = Number.isFinite(t.tokensBought) && Number.isFinite(t.tokensSold);
    const closedInWindow =
      decidable && t.tokensBought > 0 && t.tokensBought - t.tokensSold <= RESIDUAL_TOLERANCE * t.tokensBought;
    const realised = closedInWindow ? t.solOut - t.solIn : Number.NaN;
    // THE THREE-STATE SPLIT of that boolean — captain decision 461, and {@link POSITION_OUTCOMES}
    // owns the rule. `decidable && tokensBought > 0` is exactly the condition under which the
    // residual `bought − sold` is a residual at all, so it is the line between a position we can
    // resolve at zero recovery and one we cannot resolve either way. Note that it is the SAME
    // conjunction the closure test above already applies: this adds no reading, it stops two
    // different readings sharing one `false`.
    const resolvable = decidable && t.tokensBought > 0;
    /** @type {PositionOutcome} */
    const positionOutcome = closedInWindow
      ? 'exited'
      : resolvable
        ? 'still-held-at-horizon'
        : 'horizon-not-observed';
    // Zero recovery: what is still held is worth NOTHING. On an exited position the residual is
    // within tolerance of zero by the closure rule, so this is `realised` to the last bit — which is
    // what makes the conditioned figure a strict SUBSET of this one rather than a second population.
    const grossAtZeroRecovery = resolvable ? t.solOut - t.solIn : Number.NaN;
    const residualTokens = resolvable ? t.tokensBought - t.tokensSold : Number.NaN;
    const unit = {
      createSlotCoAppearingWallets: coAppearing(createSlotByTx, wallet),
      windowCoAppearingWallets: coAppearing(windowByTx, wallet),
    };
    field.push({
      wallet,
      sid: q.sid,
      createSlotTx: q.tx,
      blockTxIndex: blockTxIndex(q.sid),
      createSlotFillSol: q.fillSol,
      solQueuedAheadSol: q.aheadSol,
      queuePosition: q.position,
      outsiderQueuePosition: q.outsiderPosition,
      entrantUnitIsProven: entrantUnitIsProven(unit),
      unitCoAppearingWallets: unit.createSlotCoAppearingWallets,
      windowCoAppearingWallets: unit.windowCoAppearingWallets,
      stakeSol: t.solIn,
      closedInWindow,
      positionOutcome,
      windowTxCount: t.txs.size,
      residualTokens,
      residualMarkedSolAtWindowLastPriceGrossOfFees: residualTokens * windowLastPrice,
      realisedSolAtZeroRecoveryGrossOfFees: grossAtZeroRecovery,
      returnPerSolAtZeroRecoveryGrossOfFees:
        resolvable && t.solIn > 0 ? grossAtZeroRecovery / t.solIn : Number.NaN,
      // Absent until the chain is asked, exactly like the two fields below it: the fill tape can
      // resolve a position at zero recovery GROSS, and nothing but real lamport changes can do it
      // net.
      realisedSolAtZeroRecoveryNetOfMeasuredFees: Number.NaN,
      returnPerSolAtZeroRecoveryNetOfMeasuredFees: Number.NaN,
      realisedSolGrossOfFees: realised,
      returnPerSolGrossOfFees: closedInWindow && t.solIn > 0 ? realised / t.solIn : Number.NaN,
      // Absent until the chain is asked. NaN and not 0: "we have not priced this" and "this cost
      // nothing" are different findings, and the second one is a free seat.
      entryCostSol: Number.NaN,
      entryCostPerSolStaked: Number.NaN,
      entryTxFeeSol: Number.NaN,
      realisedSolNetOfMeasuredFees: Number.NaN,
      returnPerSolNetOfMeasuredFees: Number.NaN,
    });
  }
  field.sort((a, b) => a.queuePosition - b.queuePosition);

  return { createSlot, field };
}

/**
 * The transactions a launch's entry cost and after-cost result must be priced from.
 *
 * Two scopes, unioned so a signature is never paid for twice:
 *
 * - **Entry cost** — every create-slot transaction of every field entrant. This is the captain's
 *   question as posed, "what does it cost me to get in", and it is the cheap half.
 * - **The after-cost result** — every window transaction of the entrants whose position CLOSED.
 *   Only a closed round trip has a P&L at all, so pricing an open one buys nothing; this is the
 *   expensive half and it is what stops the field leg being veto-only (captain decision 136b).
 *
 * The union matters: a closed entrant's create-slot transaction belongs to both scopes, and paying
 * an RPC request for it twice would be the difference between a run that fits its ceiling and one
 * that does not.
 *
 * **CAPTAIN DECISION 461 DELIBERATELY DID NOT WIDEN THIS.** Resolving unexited positions at zero
 * recovery would be *better evidenced* with their whole windows priced too — but that is more RPC
 * requests, and that correction is authorised to cost nothing in every currency. So the scope is
 * byte-identical to what it was, {@link priceLaunchEntry} gives an unexited position a NET figure
 * only where its whole window happens to already be in scope (every transaction it appears in was
 * admitted by the filter below — the create slot, or a transaction carrying a wallet that closed —
 * which on the committed tape is the majority of unexited positions, 128 of the open window's 212),
 * and {@link EntryScore.fieldHitRateOverAllPositionsNetOfMeasuredFees}`.n` states
 * how many that was rather than the shortfall being silent. Widening it is a spend, and a spend is
 * the captain's.
 *
 * Pure. The walk that spends requests on the result is `pumpfun.mjs` → `readCreateSlotCosts`.
 *
 * @param {readonly import('./measure.mjs').Fill[]} fills The same fills {@link measureLaunchEntry}
 *   was given.
 * @param {LaunchEntry} entry
 * @returns {import('./measure.mjs').WalletTransaction[]}
 */
export function entryCostTargets(fills, entry) {
  const entrants = new Set(entry.field.map((e) => e.wallet));
  const closed = new Set(entry.field.filter((e) => e.closedInWindow).map((e) => e.wallet));
  const all = walletTransactions(fills, entrants, null);
  return all.filter(
    (t) => t.slot === entry.createSlot.slot || t.wallets.some((w) => closed.has(w.wallet)),
  );
}

/**
 * Attach measured on-chain costs to a launch's field.
 *
 * **All or nothing, per wallet and per scope.** An entrant is priced only when EVERY transaction in
 * the scope came back — a partially priced wallet would report a cost that is missing one of its
 * transactions, which is a wrong number rather than a missing one, and it would be wrong in the
 * cheap direction. The two scopes are decided separately: a wallet whose create slot priced but
 * whose later window did not still has an entry cost, and still has no after-cost result.
 *
 * `NaN` is the answer for anything unpriced, and {@link scoreEntry} counts what fraction of the
 * field it could price so that "we did not look" can never read as "it was free".
 *
 * @param {LaunchEntry} entry
 * @param {readonly import('./measure.mjs').WalletTransaction[]} targets What was asked for.
 * @param {ReadonlyMap<string, import('./cost-source.mjs').TransactionCosts>} priced What came back.
 * @returns {LaunchEntry} A new entry; the input is not mutated.
 */
export function priceLaunchEntry(entry, targets, priced) {
  /** @type {Map<string, import('./measure.mjs').WalletTransaction[]>} */
  const byWallet = new Map();
  for (const t of targets) {
    for (const w of t.wallets) {
      const list = byWallet.get(w.wallet);
      if (list === undefined) byWallet.set(w.wallet, [t]);
      else list.push(t);
    }
  }

  /**
   * Sum a wallet's real outflow against what the fill tape says it committed, over a set of
   * transactions. `null` when any one of them is unpriced or does not carry the wallet at all.
   *
   * @param {string} wallet
   * @param {readonly import('./measure.mjs').WalletTransaction[]} over
   * @returns {{ solOut: number, quotedSol: number, feeAsPayerSol: number } | null}
   */
  const sum = (wallet, over) => {
    if (over.length === 0) return null;
    let solOut = 0;
    let quotedSol = 0;
    let feeAsPayerSol = 0;
    for (const t of over) {
      const costs = priced.get(t.tx);
      if (costs === undefined) return null;
      const delta = costs.solOutByWallet.get(wallet);
      // The wallet traded in this transaction, so it is one of its accounts. If the priced result
      // does not carry it, the two are not describing the same transaction and nothing is claimed.
      if (delta === undefined || !Number.isFinite(delta)) return null;
      solOut += delta;
      quotedSol += t.wallets.find((w) => w.wallet === wallet)?.quotedSol ?? 0;
      if (costs.feePayer === wallet) feeAsPayerSol += costs.feeSol;
    }
    return { solOut, quotedSol, feeAsPayerSol };
  };

  const field = entry.field.map((e) => {
    const mine = byWallet.get(e.wallet) ?? [];
    const inCreateSlot = mine.filter((t) => t.slot === entry.createSlot.slot);
    const entryScope = sum(e.wallet, inCreateSlot);
    const windowScope = e.closedInWindow ? sum(e.wallet, mine) : null;

    // THE ZERO-RECOVERY NET LEG, captain decision 461, and it asks for no transaction the scope did
    // not already hold. Two conditions, and the second is the one that keeps it honest:
    //
    // 1. The position must be RESOLVABLE — exited or still held, never `horizon-not-observed`,
    //    which is resolved neither way.
    // 2. Every one of this wallet's window transactions must be in scope. `entryCostTargets` asks
    //    for a whole window only for wallets that CLOSED, so an unexited wallet that traded again
    //    after its create slot has transactions nobody priced — and summing the ones that happen to
    //    be in scope while calling the result a whole-window figure is a wrong number rather than a
    //    missing one, in the cheap direction. `windowTxCount` is what makes that check possible;
    //    it is counted off the same fills the targets were built from.
    //
    // On an EXITED position both conditions hold wherever `windowScope` is non-null, so this equals
    // `realisedSolNetOfMeasuredFees` there — which is what makes the conditioned reading a strict
    // subset of the all-positions one rather than a second, differently-computed population.
    const wholeWindowInScope = mine.length === e.windowTxCount;
    const zeroRecoveryScope =
      e.positionOutcome !== 'horizon-not-observed' && wholeWindowInScope
        ? sum(e.wallet, mine)
        : null;

    const entryCostSol = entryScope === null ? Number.NaN : entryScope.solOut - entryScope.quotedSol;
    const netRealised = windowScope === null ? Number.NaN : -windowScope.solOut;
    const netAtZeroRecovery = zeroRecoveryScope === null ? Number.NaN : -zeroRecoveryScope.solOut;
    return {
      ...e,
      entryCostSol,
      entryCostPerSolStaked:
        entryScope !== null && e.createSlotFillSol > 0 ? entryCostSol / e.createSlotFillSol : Number.NaN,
      entryTxFeeSol: entryScope === null ? Number.NaN : entryScope.feeAsPayerSol,
      realisedSolAtZeroRecoveryNetOfMeasuredFees: netAtZeroRecovery,
      returnPerSolAtZeroRecoveryNetOfMeasuredFees:
        zeroRecoveryScope !== null && e.stakeSol > 0 ? netAtZeroRecovery / e.stakeSol : Number.NaN,
      realisedSolNetOfMeasuredFees: netRealised,
      returnPerSolNetOfMeasuredFees:
        windowScope !== null && e.stakeSol > 0 ? netRealised / e.stakeSol : Number.NaN,
    };
  });

  return { createSlot: entry.createSlot, field };
}

/**
 * The complete Stage 2 verdict vocabulary. **Every value is about ENTRY only.**
 *
 * Note what is absent: nothing here says a deployer is beatable, profitable, or worth trading.
 * `entry-open-after-costs` is the strongest thing this stage can say and it means one thing — the
 * opening window is not already closed AND what it costs to land there does not consume it, so the
 * exit question is worth asking. Whether it is *escapable* is Stage 3's.
 *
 * **`entry-room-present` is gone, and its removal is the point of this vocabulary.** Under the
 * captain's ruling of 2026-08-02, fees are part of the entry window and "enterable" means enterable
 * AFTER what it costs to enter, so a verdict that spoke only of room could no longer be the
 * strongest thing said. Three rules follow from the same ruling and its standing tiebreaker, and
 * none of them is negotiable:
 *
 * 1. **Unmeasured cost is never a pass.** `entry-cost-unmeasured` is terminal for that candidate in
 *    that run. Before this, a gross-positive field could carry a positive verdict with fees
 *    entirely unmeasured; it cannot now.
 * 2. **The net field leg is still only a veto.** Measured cost is a LOWER bound — see {@link
 *    LANDING_TIP_CAVEAT} — so a net P&L built on it is still an upper bound and still cannot EARN a
 *    verdict. Netting fees makes the veto much sharper without changing which direction it points.
 * 3. **Distributions and a hit rate, never a mean**, for cost as much as for P&L. On our own tape
 *    the fee alone spans 0.00001 to 3.15 SOL on the same deployer.
 *
 * @typedef {'entry-open-after-costs' | 'entry-room-absent' | 'entry-cost-prohibitive'
 *   | 'entry-cost-unmeasured' | 'entry-field-loss-making' | 'entry-unmeasured'} EntryVerdict
 */

/** @type {readonly EntryVerdict[]} */
export const ENTRY_VERDICTS = [
  'entry-open-after-costs',
  'entry-room-absent',
  'entry-cost-prohibitive',
  'entry-cost-unmeasured',
  'entry-field-loss-making',
  'entry-unmeasured',
];

/**
 * The two verdicts that report an ABSENCE of a finding rather than a finding. Everything else in
 * {@link ENTRY_VERDICTS} is a statement about the deployer.
 *
 * @type {readonly EntryVerdict[]}
 */
export const UNMEASURED_VERDICTS = ['entry-unmeasured', 'entry-cost-unmeasured'];

/**
 * WHY a run reached one of {@link UNMEASURED_VERDICTS} — one code per distinct producer in
 * {@link scoreEntry}, and the whole point of captain decision 174b.
 *
 * **The defect this exists to remove.** Before it, six unrelated code paths collapsed onto two
 * labels, every one of which describes OUR evidence rather than the DEPLOYER. A consumer writing
 * `verdict !== 'entry-unmeasured'` was therefore filtering on our own coverage while believing it
 * was filtering on a measurement — the invisible false rejection this whole screen exists to
 * remove, one layer down. Enumerated from the code rather than from intent, in the order
 * `scoreEntry` can reach them:
 *
 * | code | where | it says |
 * |---|---|---|
 * | `too-few-windows-available` | sample-size gate | the walk was never offered `minLaunchesSampled` windows — a short or too-young history, or our own `maxLaunchesPerCandidate` cap. |
 * | `windows-dropped` | sample-size gate | windows were reached and could not be walked back to the mint, so they were dropped (`Stage2Coverage.dropsByReason` says which). |
 * | `too-few-proven-windows` | sample-size gate | windows were measured perfectly well and REFUSED, because their create slot carried no bundled transaction (`measure.mjs` → `roomIsProven`, captain decision 134a). |
 * | `room-verdict-not-robust-to-missing-launches` | near-bar guard | ENOUGH windows scored, and the launches that went missing could have moved the median across `minRoomLeft` either way, so the bar is not decided by the evidence (captain decision 198b, {@link roomBarRobustness}). |
 * | `too-few-closed-round-trips` | field gate | room was measured on a full sample and clears the bar, and the field around those launches produced fewer than `minFieldRoundTrips` complete round trips. |
 * | `too-little-of-the-field-priced` | cost gate | below `minPricedFraction` of the create-slot field could be priced on-chain — or the cost leg never ran at all. |
 * | `too-few-priced-round-trips` | cost gate | entries priced, but fewer than `minFieldRoundTrips` round trips priced across their WHOLE window, so what the field cleared after costs is unknown. |
 *
 * The first three share one code site and are the aggregate the decision was really about: a
 * candidate silenced because it never had eight launches, one silenced because pump.fun shed our
 * walk, and one silenced by the co-ordination rule are three different states of the world.
 *
 * **The near-bar guard's cause is not a variant of any of the first three and must not be read as
 * one.** Those
 * three say the sample was too SMALL. This one says the sample was large enough and is INCOMPLETE
 * in a way that leaves the answer undetermined — the candidate cleared `minLaunchesSampled` and was
 * refused anyway. A run record where an operator cannot tell those apart is a run record that reads
 * a 198b refusal as a short history.
 *
 * @typedef {'too-few-windows-available' | 'windows-dropped' | 'too-few-proven-windows'
 *   | 'too-few-closed-round-trips' | 'too-little-of-the-field-priced'
 *   | 'too-few-priced-round-trips'
 *   | 'room-verdict-not-robust-to-missing-launches'} UnmeasuredCause
 */

/** @type {readonly UnmeasuredCause[]} */
export const UNMEASURED_CAUSES = [
  'too-few-windows-available',
  'windows-dropped',
  'too-few-proven-windows',
  'room-verdict-not-robust-to-missing-launches',
  'too-few-closed-round-trips',
  'too-little-of-the-field-priced',
  'too-few-priced-round-trips',
];

/**
 * WHOSE fact each cause is — and therefore whether a consumer may filter on it.
 *
 * `'our-coverage'` is a limit of this reading: our budget, our luck against a shedding endpoint, or
 * evidence the co-ordination rule could not recover. `'deployer'` is a property of the launches
 * themselves, measured on a full sample by an instrument that does not vary between candidates.
 *
 * **NO cause is `'deployer'`, and that is the finding rather than a redundancy** (captain decision
 * 174b, revised). All seven producers describe us, so a later stage may filter ONLY on the four
 * MEASURED verdicts — `entry-open-after-costs`, `entry-room-absent`, `entry-cost-prohibitive`,
 * `entry-field-loss-making` — and must carry EVERY unmeasured outcome forward as no answer. The
 * field, the type and this table stay: a future producer CAN be deployer-attributable, and it has to
 * come here on purpose to become one.
 *
 * `room-verdict-not-robust-to-missing-launches` (captain decision 198b) is `our-coverage` for the
 * same reason as the three above it, and the point is load-bearing rather than bookkeeping: what
 * went missing was a launch OUR walk could not finish or OUR co-ordination rule could not prove, and
 * the guard fires on the width of that hole rather than on anything the deployer did. Attributing it
 * to the deployer would let a later stage drop exactly the candidates the guard was built to protect
 * — the ones sitting near the bar.
 *
 * `too-few-closed-round-trips` was the one row attributed to the deployer, on the ground that
 * closure is read inside the pinned `windowMs` and that is the same window for every candidate. It
 * is not a fixed instrument: the walk that produces `closed` is bounded by `maxRequestsPerLaunch`,
 * that cap drops the BUSIEST launches as `request-cap`, and a candidate loses its verdict outright
 * once the drops exhaust the headroom `minLaunchesSampled` has under `maxLaunchesPerCandidate` — so
 * both `closed.length` and whether this gate is reached at all are functions of our own budget and
 * our luck against a shedding endpoint, not of the deployer.
 *
 * **The evidence is owned in ONE place and this is a pointer to it, deliberately:**
 * `tools/deployer-screen/README.md` → "Why `too-few-closed-round-trips` is `our-coverage` and not the
 * deployer's" holds the argument, the measured drop rate, its population and the honest limit on it.
 * It has been swapped once already — captain decision 144a closed the two-bound cursor the original
 * evidence rested on, without touching the classification — and it went stale in three files at once
 * because three files each kept a copy. `pumpfun.mjs` → `windowReachMs` owns the page-cost and drop
 * figures themselves.
 *
 * @type {Readonly<Record<UnmeasuredCause, 'our-coverage' | 'deployer'>>}
 */
export const UNMEASURED_CAUSE_ATTRIBUTION = Object.freeze({
  'too-few-windows-available': 'our-coverage',
  'windows-dropped': 'our-coverage',
  'too-few-proven-windows': 'our-coverage',
  'room-verdict-not-robust-to-missing-launches': 'our-coverage',
  'too-few-closed-round-trips': 'our-coverage',
  'too-little-of-the-field-priced': 'our-coverage',
  'too-few-priced-round-trips': 'our-coverage',
});

/**
 * THE FILTER RULE, on the score itself rather than only in a document — the same discipline
 * {@link LANDING_TIP_CAVEAT} follows. It reaches `caveats`, the rendered block and the run record,
 * so a consumer that never opens the README still meets it.
 */
export const COVERAGE_ATTRIBUTION_CAVEAT =
  'THIS IS A LIMIT OF OUR READING, NOT A FINDING ABOUT THIS DEPLOYER. `unmeasuredCause` names ' +
  'which of our own limits produced it and `unmeasuredCauseAttribution` reads `our-coverage`. A ' +
  'later stage MUST NOT drop this candidate on that basis: filtering it out silently filters on ' +
  'our budget and our evidence, which is the invisible false rejection this screen exists to ' +
  'remove. Carry it forward as NO ANSWER, counted and reported. `entry.mjs` → ' +
  '`isDeployerAttributable` is the predicate; captain decision 174b is the rule.';

/**
 * **May a later stage filter this candidate out?** Captain decision 174b, as a predicate.
 *
 * `true` when the outcome is a statement about the deployer — today that is every MEASURED verdict
 * and nothing else, because {@link UNMEASURED_CAUSE_ATTRIBUTION} attributes all seven producers to
 * our own coverage. `false` when it is a statement about our own coverage, which a consumer must
 * carry forward as *no answer* rather than drop.
 *
 * Three properties are deliberate and all three fail SAFE:
 *
 * - **A verdict this module does not recognise returns `false`.** A typo, a value from a future
 *   schema or a hand-edited record is carried forward exactly like an unknown cause, rather than
 *   waved through as a measurement.
 * - **A record older than schema 10 carries no `unmeasuredCause`,** so every unmeasured verdict on
 *   it returns `false` — not filterable. That is correct: those records genuinely cannot say which
 *   producer fired, and guessing would reintroduce exactly the collapse this removes.
 * - **An unrecognised cause returns `false`.** A future producer added without coming here is
 *   treated as our coverage until someone says otherwise, so the error lands on over-reporting
 *   rather than on a silent drop.
 *
 * Takes the in-process {@link EntryScore} and the persisted record row alike — Stage 3 is a second
 * consumer of Stage 2's fill walk rather than a reader of `runs/*.json`, so the in-process shape is
 * the one that matters and both must answer the same.
 *
 * @param {{ verdict: string, unmeasuredCause?: string | null }} finding
 * @returns {boolean}
 */
export function isDeployerAttributable(finding) {
  if (!(/** @type {readonly string[]} */ (ENTRY_VERDICTS).includes(finding.verdict))) return false;
  if (!(/** @type {readonly string[]} */ (UNMEASURED_VERDICTS).includes(finding.verdict))) return true;
  const cause = finding.unmeasuredCause ?? null;
  if (cause === null) return false;
  return (
    /** @type {Record<string, string | undefined>} */ (UNMEASURED_CAUSE_ATTRIBUTION)[cause] === 'deployer'
  );
}

/**
 * @typedef {object} RoomBarRobustness
 * @property {number} lo       Lowest median the completed sample could have had — every missing
 *   launch at {@link import('./measure.mjs').ROOM_LEFT_RANGE}`.min`.
 * @property {number} hi       Highest it could have had — every missing launch at `.max`.
 * @property {boolean} decided Whether `minRoomLeft` falls OUTSIDE `[lo, hi]`, i.e. whether the
 *   launches that went missing could not have changed which side of the bar the median lands on.
 */

/**
 * **THE NEAR-BAR GUARD — refuse a room verdict the missing launches could have flipped.**
 * Captain decision 198b.
 *
 * ## The verdict shape it exists to refuse
 *
 * Captain decision 190a decoupled `maxLaunchesPerCandidate` (10) from `minLaunchesSampled` (8), so a
 * candidate keeps its verdict after losing up to two launches. That bought a real thing — the
 * request-cap no-verdict rate — and it introduced a shape that was **structurally impossible at
 * 8-and-8**: a candidate scored on 8 of 10 launches where the two missing ones were **selected by
 * drop cause, not at random.** `request-cap` drops fall on the BUSIEST launches — `thresholds.json`
 * → `stage2_entry.justification` says so in as many words — and {@link roomIsProven} refusals fall
 * on launches with no co-ordination evidence. Neither is a coin toss over the deployer's history.
 *
 * This repository already discards WHOLE for exactly that shape, twice: the cost leg's truncated
 * walk (`stage2.mjs` — *"a truncated walk holds the earliest entrants by slot, which is a biased
 * sample rather than a short one"*) and `minPricedFraction`. This is the same rule at the room gate,
 * applied only where the incompleteness can actually change the answer.
 *
 * ## WHAT THE MARGIN IS ANCHORED TO — and what it is NOT
 *
 * **It is not anchored to the direction of the bias, and it is built so that it does not need one.**
 * The direction is UNMEASURED and the attempt to measure it is on record as having failed. Over the
 * committed tape, busyness against `roomLeft`: rank correlation **0.0250** (negligible);
 * busiest-quartile median room **0.3032** against the quietest quartile's **0.2771**, i.e. busy
 * reads HIGHER; and dropping the busiest 3.1% moves the median **0.3146 → 0.3314**, i.e. **0.0168**
 * TOWARDS enterable. Two statistics opposite in sign, on **n = 1 deployer**. Nothing may be pinned
 * from that, and a margin invented to look derived from it would be the anchor-fabrication this
 * repo's own justification bar exists to catch.
 *
 * **It is anchored to one ALGEBRAIC fact plus the candidate's own order statistics, and there is
 * therefore NO new pinned number in `thresholds.json`.** The fact is
 * {@link import('./measure.mjs').ROOM_LEFT_RANGE}: `roomLeft` is a share of non-negative create-slot
 * buy SOL, so it lies in `[0, 1]` by construction and not by observation. A launch nobody walked has
 * an UNKNOWN room, but a BOUNDED one. The median is monotone non-decreasing in every observation, so
 * putting all the missing launches at the bottom of that range yields the lowest median the complete
 * sample could have had and putting them all at the top yields the highest — exactly, with no search
 * and no distributional assumption. If `minRoomLeft` falls inside `[lo, hi]` the evidence does not
 * decide the bar, and the verdict is refused.
 *
 * So the effective margin is **the sample's own dispersion around the bar**, recomputed per candidate
 * with the same {@link median} the reported figure uses. It is narrow for a candidate whose launches
 * agree with each other and wide for one whose do not, which is the behaviour a fixed margin could
 * only approximate. At the live 10-and-8 it is at most one order statistic wide in each direction,
 * because at most two launches can be missing from a candidate that scores at all.
 *
 * ## Five properties, all deliberate
 *
 * - **It is SYMMETRIC**, and that follows from the direction being unmeasured rather than from
 *   taste. It refuses a would-be `entry-open-after-costs` and a would-be `entry-room-absent` alike.
 *   The second half matters as much as the first: `entry-room-absent` is a MEASURED verdict a later
 *   stage may filter on ({@link isDeployerAttributable}), so shipping one off a subsample that could
 *   equally have cleared the bar is the invisible false rejection this screen exists to remove.
 * - **It is a WORST CASE, not an estimate**, and it is therefore wider than any displacement anyone
 *   has measured — the only magnitude on record is the 0.0168 above. It will refuse candidates whose
 *   true median would not in fact have moved. That is the accepted direction: the standing bar is
 *   that a false positive is not an acceptable result, and a refusal is.
 * - **Over-refusal is cheap BECAUSE of how the refusal is labelled.** It is `our-coverage`, so a
 *   later stage must carry the candidate forward as no answer rather than drop it (decision 174b).
 *   The candidate is not lost, it is unanswered — and re-walking it later can answer it.
 * - **A complete sample is untouched.** With nothing missing, `lo` and `hi` are both the reported
 *   median, so `decided` is true for any bar and this cannot fire. No 10-of-10 candidate's behaviour
 *   changes, and nothing before decision 190a is retro-graded.
 * - **An empty sample is NOT decided.** `lo`/`hi` are `NaN` and both comparisons are false, so the
 *   caller refuses. {@link scoreEntry} cannot reach that (the sample-size gate returns first), but
 *   the exported function fails safe for anyone who can.
 *
 * ## What it does NOT cover, stated so nobody reads it as broader than it is
 *
 * **Only the room bar.** The field legs (`minFieldHitRateGross`, `minFieldHitRateNet`) and the cost
 * leg (`maxEntryCostPerSolStaked`) run over the same incomplete set of launches and are NOT guarded
 * here. The room bar is the one this guard was authorised for, it is the first gate, and its
 * statistic is one observation per launch — which is what makes this bound exact. The pooled field
 * statistics would need a different construction and their own decision.
 *
 * **The committed tape cannot exercise it, and that is a limit of the evidence rather than a passing
 * check.** Our subject deployer is proven 235/235 under the union co-ordination rule and its tape
 * carries no walk drops, so `missing` is 0 at every point of Stage 0's replay and the guard is
 * silent there by construction. Stage 0's verdicts — including both halves of the known-negative
 * control — are unchanged for that reason, and not because the guard was checked against them.
 *
 * @param {readonly number[]} roomLeft Room figures for the launches that WERE scored.
 * @param {number} missing             Launches planned for this candidate that produced no room
 *   figure: dropped by the walk, refused as unproven, or never started. Never negative.
 * @param {number} minRoomLeft         The bar, `thresholds.json` → `stage2_entry.minRoomLeft`.
 * @returns {RoomBarRobustness}
 */
export function roomBarRobustness(roomLeft, missing, minRoomLeft) {
  const absent = Math.max(0, Math.trunc(missing));
  const lo = median([...roomLeft, ...Array.from({ length: absent }, () => ROOM_LEFT_RANGE.min)]);
  const hi = median([...roomLeft, ...Array.from({ length: absent }, () => ROOM_LEFT_RANGE.max)]);
  // Written as two positive comparisons rather than `!(lo < bar && hi >= bar)` so that a NaN from an
  // empty sample makes both false and leaves the bar UNDECIDED, which is the safe answer.
  return { lo, hi, decided: hi < minRoomLeft || lo >= minRoomLeft };
}

/**
 * @typedef {object} RoomMedianBound
 * @property {number} median      The REPORTED median, over the scored launches only — the same
 *   number as {@link EntryScore.roomLeft}`.median`, carried here so the figure and its bound cannot
 *   be quoted apart. `NaN` when nothing was scored.
 * @property {number} lo          Lowest median the COMPLETE sample could have had.
 * @property {number} hi          Highest median the complete sample could have had.
 * @property {number} overstatementMax  `median - lo`. How far the reported figure may sit ABOVE the
 *   complete sample's. Non-negative by construction; `0` on a complete sample.
 * @property {number} understatementMax `max(0, hi - median)`. The same, in the other direction.
 * @property {boolean} provablyOverstated Whether `hi < median`, i.e. whether completing the sample
 *   must move the median DOWN whatever the missing launches turn out to be. `false` on an empty or
 *   complete sample, and `false` whenever the interval merely straddles the reported figure.
 * @property {number} launchesScored          Launches the median is over.
 * @property {number} launchesMissing         Launches planned that produced no room figure.
 * @property {number} launchesRefusedMeasured Of those, the ones {@link roomIsProven} REFUSED —
 *   walked, measured, and not scored. Their own room readings are the evidence `hi` uses.
 * @property {number} launchesUnmeasured      The rest of the hole: dropped mid-walk or never
 *   started. Nothing at all is known about their room.
 * @property {Distribution} refusedRoomLeft   What the REFUSED launches' create slots actually
 *   measured, over `launchesRefusedMeasured` observations. Published so a reader can see WHY the
 *   bound lands where it does, and so a saved record can be re-derived rather than trusted. **Not
 *   scored, not gated on, and not a room finding about the deployer** — see the direction argument
 *   in {@link roomMedianBound}.
 * @property {string} caveat      {@link describeRoomMedianBound} of this bound, so the sentence
 *   travels with the numbers into every surface.
 */

/**
 * **THE REFUSED WINDOWS' EFFECT ON THE REPORTED MEDIAN, AS AN EXPLICIT BOUND.**
 * Captain decision 208b (with 208d folded into it as the measurement step).
 *
 * ## The defect it exists to state
 *
 * `scoreEntry` reports a median over the launches it SCORED, and the launches it did not score did
 * not go missing at random. {@link roomIsProven} refuses a create slot the co-ordination rule marked
 * nothing in, the request cap drops the busiest windows, and the stage ceiling leaves the oldest of
 * a plan unattempted. A median over what survives is a real number about a sample that was selected,
 * and nothing beside it used to say by how much that selection could have moved it. On the
 * 2026-08-04 full-day run **18 of the 22 cleanly-walked windows were refused**, and the census
 * separately reports **0 of 13 stranger candidates proven on all eight** — so on the stranger
 * population this is the ordinary case, not an edge one.
 *
 * **This is a REPORTING function and it reaches no gate.** It does not change what `roomIsProven`
 * refuses, it does not move a sample-size floor, and no verdict reads it. Captain decision 203
 * declined both of those (203c and 203d) and 208b was chosen precisely because it does neither: the
 * refusals stay, and what changes is that the figure states what they cost it.
 *
 * ## The two kinds of hole, and what may be assumed about each
 *
 * - **A REFUSED launch was walked and measured.** Its `roomLeft` exists; it is simply not scored.
 *   And that measured value is a **strict upper bound on its true room**, structurally: the
 *   co-ordination rule's under-recovery moves operation stake into `independentSol`, which raises
 *   `roomLeft` (`measure.mjs` → {@link measureCreateSlot} owns the direction). The one error that
 *   runs the other way — half (a) marking a genuine outsider that a third-party bundler put in a
 *   shared transaction — **cannot apply to a refused launch by construction**, because a refused
 *   launch is one where neither half marked anything at all. So a refused launch's true room lies in
 *   `[ROOM_LEFT_RANGE.min, its own measured roomLeft]`.
 * - **A DROPPED or never-started launch was never walked.** Nothing is known about it beyond the
 *   algebraic support, so its true room lies in `[ROOM_LEFT_RANGE.min, ROOM_LEFT_RANGE.max]`.
 *
 * The median is monotone non-decreasing in every observation, so substituting each unknown by its
 * own lower bound gives **exactly** the lowest median the complete sample could have had, and by its
 * own upper bound **exactly** the highest. No search, no distributional assumption, no pinned
 * margin, and therefore no new value in `thresholds.json` — the same construction
 * {@link roomBarRobustness} uses, with the refused half's own measurement supplied in place of the
 * algebraic ceiling.
 *
 * ## Why the two functions are separate, and why THIS one must not be given to the guard
 *
 * `roomBarRobustness` is a REFUSAL and this is a REPORT. This bound is narrower — `lo` is identical
 * and `hi` is `<=` the guard's, since a measured value cannot exceed `ROOM_LEFT_RANGE.max` — so
 * feeding it to the near-bar guard would make the guard refuse LESS, which is loosening a guard by
 * the back door. The guard keeps the assumption-free interval on purpose. Nothing here is a
 * threshold input.
 *
 * ## What it means, stated so a reader can use it
 *
 * `[lo, hi]` is where the median WOULD lie if every planned launch had produced a room figure. The
 * reported median can sit outside it, and when `hi < median` that is the finding rather than a
 * bug: the refused windows' own measurements put the complete-sample median strictly below what is
 * being reported, so the reported figure provably overstates room. `overstatementMax` is the worst
 * case of that overstatement and it is what a reader should carry beside the median.
 *
 * ## Measured, on committed data, both ways — because THE DIRECTION IS NOT UNIVERSAL
 *
 * The premise this lane was given is that refusal moves the median UP, and on the stranger
 * population that is what was measured. It is **not** what our own tape shows, and both readings are
 * recorded here because a one-directional correction would have been wrong.
 *
 * - **The stranger case.** `runs/2026-08-04.json`'s candidate scored 4 of 10 windows at a median
 *   `0.288940`; `census/2026-08-04-proof-coverage-probe.md` walked its 6 refused windows one by one
 *   and measured their room at `0.0000 ×3` and `0.0008 ×3`. This bound over that pair reads
 *   **lo `0.000000`, hi `0.000800`, overstatementMax `0.288940`, provablyOverstated `true`** — the
 *   reported median is roughly 360× the completed one. That is the harm 208b names, at full size.
 * - **Our own tape, and it runs the OTHER way.** The committed 235 launches under the SUPERSEDED
 *   shared-transaction-only half (the only rule that refuses anything here — the union refuses 0 of
 *   235) give 63 rolling ten-launch windows with a hole. Completing them at their measured values
 *   **raises** the median on 52 and lowers it on 8, median displacement `-0.0308`, range `-0.3973`
 *   to `+0.0887`. The reason is instructive: there the rule found nothing because the operation
 *   co-ordinated by adjacency rather than by a shared transaction, so the refused windows carry the
 *   operation's own stake booked as outsider capital and read HIGH. Refusal is not a synonym for
 *   near-zero room; it is a synonym for no evidence, and what that costs depends on why.
 * - **And the bound CONTAINS the better reading on 63 of 63 of those windows** — the union's own
 *   median over the same ten launches falls inside `[lo, hi]` every time. That is the validation
 *   that matters, and `test/deployer-screen.test.ts` re-derives all of it from the tape on every run
 *   rather than pinning these numbers as prose.
 *
 * @param {readonly number[]} scoredRoomLeft   Room figures for the launches that WERE scored.
 * @param {readonly number[]} refusedRoomLeft  Room figures for the launches {@link roomIsProven}
 *   refused — measured, and deliberately not scored.
 * @param {number} unmeasuredMissing           Planned launches that produced no room figure at all:
 *   dropped mid-walk or never started. Never negative.
 * @returns {RoomMedianBound}
 */
export function roomMedianBound(scoredRoomLeft, refusedRoomLeft, unmeasuredMissing) {
  const refused = refusedRoomLeft.filter((v) => Number.isFinite(v));
  // A refused launch whose own reading is unusable is moved into the BLIND half rather than dropped.
  // Dropping it would shrink the hole, which is the one direction a bound on incompleteness must
  // never move in — it would make the figure look more complete than it is.
  const blind =
    Math.max(0, Math.trunc(unmeasuredMissing)) + (refusedRoomLeft.length - refused.length);
  const missing = refused.length + blind;

  const reported = median(scoredRoomLeft);
  // Every unknown at the bottom of what it could be, and then at the top of what it could be. A
  // refused launch's own measurement is its top; a launch nobody walked has only the support.
  const lo = median([
    ...scoredRoomLeft,
    ...Array.from({ length: missing }, () => ROOM_LEFT_RANGE.min),
  ]);
  const hi = median([
    ...scoredRoomLeft,
    ...refused,
    ...Array.from({ length: blind }, () => ROOM_LEFT_RANGE.max),
  ]);

  const bound = {
    median: reported,
    lo,
    hi,
    // `NaN` propagates rather than collapsing to 0: an empty sample has no overstatement to report,
    // and reporting one would be the "no observations reads as none" failure `hitRate` refuses.
    overstatementMax: reported - lo,
    understatementMax: Number.isFinite(hi - reported) ? Math.max(0, hi - reported) : Number.NaN,
    // Two positive comparisons so a NaN anywhere leaves this `false` — an unknown median is never
    // reported as provably anything.
    provablyOverstated: hi < reported,
    launchesScored: scoredRoomLeft.length,
    launchesMissing: missing,
    launchesRefusedMeasured: refused.length,
    launchesUnmeasured: blind,
    refusedRoomLeft: distribution(refused),
    caveat: '',
  };
  bound.caveat = describeRoomMedianBound(bound);
  return bound;
}

/**
 * The sentence that must travel with the median, wherever the median goes.
 *
 * Same discipline as {@link LANDING_TIP_CAVEAT} and {@link COVERAGE_ATTRIBUTION_CAVEAT}, and the
 * reason 208b was chosen over 208a: a bound that lives in surrounding prose is a bound the figure
 * can be quoted without. This string reaches `caveats`, every rationale that states a median, the
 * rendered block and the run record.
 *
 * A COMPLETE sample gets a sentence too, rather than silence. "No window was refused" is a fact a
 * reader needs in order to read the median at face value, and an absent caveat cannot say it.
 *
 * @param {RoomMedianBound} b
 * @returns {string}
 */
export function describeRoomMedianBound(b) {
  /** @param {number} n @returns {string} */
  const at = (n) => (Number.isFinite(n) ? n.toFixed(4) : 'n/a');
  if (b.launchesScored === 0) {
    return (
      'ROOM MEDIAN: NONE — no launch was scored, so there is no median and no bound on one. ' +
      `${b.launchesMissing} planned launch(es) produced no room figure.`
    );
  }
  if (b.launchesMissing === 0) {
    return (
      `ROOM MEDIAN ${at(b.median)} IS COMPLETE: every planned launch produced a room figure, none ` +
      `was refused as unproven and none was dropped, so the bound on it is [${at(b.lo)}, ` +
      `${at(b.hi)}] — the figure itself.`
    );
  }
  return (
    `ROOM MEDIAN ${at(b.median)} IS INCOMPLETE: it is taken over ${b.launchesScored} launch(es) ` +
    `while ${b.launchesMissing} more produced no room figure ` +
    `(${b.launchesRefusedMeasured} REFUSED as unproven and measured, ${b.launchesUnmeasured} never ` +
    `measured at all), and they did not go missing at random. Completing the sample puts the ` +
    `median in [${at(b.lo)}, ${at(b.hi)}], so this figure may overstate room by up to ` +
    `${at(b.overstatementMax)}` +
    (b.provablyOverstated
      ? ' — and it PROVABLY overstates it, because the refused windows\' own measured room puts the ' +
        'completed median strictly below the reported one.'
      : '.') +
    ' The bound is exact rather than tuned: a refused launch\'s measured room is a strict UPPER ' +
    'bound on its true room (the co-ordination rule can only under-mark on a launch it marked ' +
    'nothing in), an unmeasured one lies anywhere in room\'s algebraic support, and the median is ' +
    'monotone in every observation. It is REPORTED and never gated on: no refusal is relaxed by it ' +
    '(captain decision 208b).'
  );
}

/**
 * @typedef {object} EntryThresholds
 * @property {number} minRoomLeft            Median room a launch set must leave.
 * @property {number} minLaunchesSampled     Launches below which no distribution is reported.
 * @property {number} minFieldRoundTrips     Closed round trips below which the hit rate is noise.
 * @property {number} minFieldHitRateGross   Necessary-condition floor on the gross hit rate.
 * @property {number} minFieldHitRateNet     The same floor, net of measured fees. The same veto,
 *   now over a real measurement rather than an upper bound.
 * @property {number} maxEntryCostPerSolStaked Price of the seat, per SOL of seat, at or above which
 *   the cost consumes the opening. Compared against the **per-launch** median — the median over
 *   launches of each launch's own median entry — never the pooled per-entry one. Captain decision
 *   140a: every launch counts once, so a launch with many priced entrants cannot outvote a launch
 *   with one.
 * @property {number} minPricedFraction      Share of the field the cost leg must have priced before
 *   any after-cost reading is allowed to stand.
 */

/**
 * @typedef {object} EntryWindow
 * One walked window, with the wallets that were in it — a {@link LaunchEntry} plus the one bit that
 * says how its room figure may be read.
 *
 * @property {import('./measure.mjs').CreateSlotMeasurement} createSlot
 * @property {boolean} roomIsProven `measure.mjs` → `roomIsProven` over that measurement, carried
 *   rather than left to a consumer to recompute. **It is what keeps the two claims apart**: on a
 *   window reading `false` the entrant list still says truthfully WHO filled, and `createSlot`'s
 *   `roomLeft` and `operationShare` are the unproven readings captain decision 134a refuses to
 *   score — present here for the same reason `roomMedianBound.refusedRoomLeft` is present, and
 *   gating nothing.
 * @property {readonly FieldEntrant[]} entrants The create-slot outsiders, in queue order.
 */

/**
 * @typedef {object} EntryScore
 * @property {EntryVerdict} verdict
 * @property {UnmeasuredCause | null} unmeasuredCause  Which producer reached this verdict, when it
 *   is one of {@link UNMEASURED_VERDICTS}; `null` on every measured verdict. **Never `null` on an
 *   unmeasured one** — a consumer that cannot tell the causes apart is back where decision 174b
 *   started. The PRIMARY cause when several apply; see {@link EntryScore.unmeasuredContributingCauses}.
 * @property {'our-coverage' | 'deployer' | null} unmeasuredCauseAttribution  Whose fact
 *   {@link EntryScore.unmeasuredCause} is, carried explicitly so a consumer never re-derives it
 *   from a table of its own. `null` alongside a `null` cause.
 *   {@link UNMEASURED_CAUSE_ATTRIBUTION} is the mapping and a test pins the two agree.
 * @property {readonly UnmeasuredCause[]} unmeasuredContributingCauses  EVERY producer that applied,
 *   in the documented precedence order, primary first. Empty on a measured verdict. The three
 *   sample-size causes can co-occur — four windows refused as unproven and two dropped is a
 *   different state from either alone — and a single label would throw that away. All three are
 *   `our-coverage`, so the precedence never changes the filter answer; it only decides which
 *   sentence leads.
 * @property {string} rationale
 * @property {number} launchesSampled        Launches actually SCORED. Every distribution and count
 *   below except {@link EntryScore.bundledTx} and {@link EntryScore.maxWalletsInOneTx} is over
 *   exactly this population. Launches handed in but refused are {@link
 *   EntryScore.launchesRoomUnproven}, so `launchesSampled + launchesRoomUnproven` is what the walk
 *   delivered.
 * @property {number} launchesRoomUnproven   Launches whose create slot the co-ordination rule
 *   marked NOTHING in — neither half — and which are therefore **not scored at all**; see
 *   `measure.mjs` → `roomIsProven`. Not a drop and not a refusal: the opening is unproven, which is
 *   a different finding from an opening that was measured and found closed.
 * @property {Distribution} bundledTx        Create-slot transactions carrying 2+ wallets — the
 *   SHARED-TRANSACTION half on its own — over **every launch handed in**, refused ones included.
 *   The zeros are the whole point: these four distributions are the only observable that exposes
 *   the unproven condition, so a saved run can be audited for it after the fact.
 * @property {Distribution} maxWalletsInOneTx Largest wallet count in one create-slot transaction,
 *   over every launch handed in.
 * @property {Distribution} runTx            Transactions in the deployer-anchored contiguous
 *   block-index run, anchor included — the ADJACENCY half on its own — over every launch handed in.
 *   A launch reading `bundledTx: 0` beside `runTx: 3` is one only the union can score, and a run of
 *   `0` everywhere is what a moved `sid` format looks like.
 * @property {Distribution} adjacencyMarks   Wallets the adjacency half marked that the
 *   shared-transaction half did not, over every launch handed in. **This is the size of what the
 *   union added**, per launch, and it is what makes a saved `roomLeft` auditable against a
 *   schema-≤10 one: a schema-≤10 record's room reading was taken with these wallets counted as
 *   outsiders.
 * @property {number} launchesWithNoOutsider Launches whose create slot the operation took entirely.
 * @property {Distribution} roomLeft         Across scored launches.
 * @property {RoomMedianBound} roomLeftBound **How far the launches that produced NO room figure
 *   could move {@link EntryScore.roomLeft}`.median`** — captain decision 208b. Always present, on
 *   every verdict, including the ones that never reach a bar: the point of the decision is that the
 *   FIGURE states its own incompleteness, so a surface cannot print the median without it.
 *   {@link roomMedianBound} owns the construction and the measured evidence; it is REPORTING and no
 *   gate reads it.
 * @property {HitRate} roomHitRate           Launches whose room clears `minRoomLeft`.
 * @property {Distribution} operationShare
 * @property {Distribution} devSol
 * @property {Distribution} coordinatedSol
 * @property {Distribution} outsidersPerLaunch
 * @property {Distribution} fieldFillSol           What the field got filled for.
 * @property {Distribution} fieldSolQueuedAhead    How much was ahead of them.
 * @property {Distribution} fieldRealisedSolGrossOfFees   Closed round trips only.
 * @property {Distribution} fieldReturnPerSolGrossOfFees  Closed round trips only.
 * @property {HitRate} fieldHitRateGrossOfFees     Share of closed round trips above zero.
 * @property {Distribution} entryCostSol           What landing cost, per create-slot entry, over
 *   the entries the cost leg could price. Empty (`n: 0`, all `NaN`) when nothing was priced, which
 *   is the honest reading for a leg that did not run.
 * @property {Distribution} entryCostPerSolStaked  The same, per SOL of seat. **Over ENTRIES** — one
 *   observation per priced create-slot entry, pooled across every scored launch. The finer-grained
 *   evidence, and not what the verdict reads.
 * @property {Distribution} entryCostPerSolStakedByLaunch  The same quantity **over LAUNCHES** — one
 *   observation per scored launch that priced at least one entry, each being that launch's own
 *   median entry. **This is the distribution `entry-cost-prohibitive` gates on** (captain decision
 *   140a): pooled over entries, a single launch with dozens of priced entrants outvotes a dozen
 *   launches with one apiece, and the bar is anchored on a per-launch figure.
 * @property {Distribution} entryTxFeeSol          The transaction fee half of it — base plus
 *   priority — where the entrant paid it. The observable price of the slot auction.
 * @property {HitRate} entryCostPriced             How much of the field the cost leg priced. `hits`
 *   is entries with a cost, `n` every create-slot entry. This is the coverage the verdict gates on.
 * @property {Distribution} fieldRealisedSolNetOfMeasuredFees  Closed round trips that were priced
 *   across their WHOLE window. Beside the gross figures and never replacing them.
 * @property {Distribution} fieldReturnPerSolNetOfMeasuredFees
 * @property {HitRate} fieldHitRateNetOfMeasuredFees  Share of priced closed round trips above zero.
 * @property {number} fieldClosedRoundTripsPriced  Closed round trips with a complete net figure.
 * @property {Distribution} fieldRealisedSolOverAllPositionsGrossOfFees  **EVERY POSITION TAKEN**, with the
 *   ones still held at the horizon resolved at ZERO RECOVERY — captain decision 461. The same
 *   statistic as {@link EntryScore.fieldRealisedSolGrossOfFees} over a strictly larger, nested
 *   population: that one drops an unexited position, this one resolves it at the worst case. On the
 *   committed tape the difference is the sign of the headline. Reported BESIDE the conditioned
 *   figure and never instead of it; {@link REALISATION_CONSTRUCTION_CAVEAT} is the label.
 *   **Positions whose closure our rows cannot decide are in NEITHER** — see
 *   {@link EntryScore.positionsHorizonNotObserved}.
 * @property {Distribution} fieldReturnPerSolOverAllPositionsGrossOfFees  The same, per SOL staked.
 * @property {BoundedHitRate} fieldHitRateOverAllPositionsGrossOfFees  Share of every position taken above
 *   zero at that resolution, with its exact (Clopper–Pearson) interval. `n` is the same `n` the
 *   distribution above reports: a position whose SOL amount is unreadable carries no realized figure
 *   and is EXCLUDED rather than scored as a loss, so this `n` can sit below the resolvable count.
 *   The conditioned twin is
 *   {@link EntryScore.fieldHitRateGrossOfFees}, whose `n` is the exited subset of this `n`.
 * @property {Distribution} fieldRealisedSolOverAllPositionsNetOfMeasuredFees  The same construction, net of
 *   measured fees. **Its population is the positions whose WHOLE window was priced** — every
 *   transaction the wallet appears in was already in the cost leg's target set, which was not
 *   widened for this correction and would have cost RPC requests (see {@link entryCostTargets}). A
 *   different denominator from the gross one above and never pooled with it — each carries its own
 *   `n`, and the subset is NON-RANDOM with the direction unmeasured:
 *   {@link NET_ALL_POSITIONS_SELECTION_CAVEAT}.
 * @property {Distribution} fieldReturnPerSolOverAllPositionsNetOfMeasuredFees  The same, per SOL staked.
 * @property {BoundedHitRate} fieldHitRateOverAllPositionsNetOfMeasuredFees  Share of those above zero, with its
 *   exact interval. `n` is how many positions carried a complete whole-window net figure, and the
 *   positions it drops are not a random sample of the gross one —
 *   {@link NET_ALL_POSITIONS_SELECTION_CAVEAT}.
 * @property {Distribution} fieldResidualMarkedSolAtWindowLastPriceGrossOfFees  **THE BOUND ON THE ZERO-RECOVERY
 *   RESOLUTION, over the positions still held at the horizon** — what their remaining tokens would
 *   be worth at the last price the walked window itself showed. It is reported BESIDE the worst-case
 *   figures and is never substituted into one: a mark is a price nobody paid, and on the committed
 *   tape 95% of unexited positions are losses even at the token's LATEST known price — **a HARSHER
 *   mark than this one**, which is the window's own last price and the more generous of the two.
 *   Empty when nothing is still held, and its `n` can sit BELOW
 *   {@link EntryScore.positionsStillHeldAtHorizon}: {@link distribution} drops a non-finite value,
 *   and a still-held position whose window showed no readable price at all marks at `NaN`.
 * @property {number} positionsStillHeldAtHorizon   Positions entered, decidable, and NOT flat at the
 *   horizon. Resolved at zero recovery above; this is how many that was.
 * @property {number} positionsHorizonNotObserved   Positions whose closure our own rows cannot
 *   decide, so they are resolved NEITHER way and are in neither construction. **OUR COVERAGE**, in
 *   captain decision 174b's sense: reported and counted, never a loss, and a later stage may not
 *   filter a candidate on it. With {@link EntryScore.fieldClosedRoundTrips} and
 *   {@link EntryScore.positionsStillHeldAtHorizon} it partitions {@link EntryScore.fieldEntrants}
 *   exactly, and the last two sum to {@link EntryScore.fieldOpenPositions} — which is the boolean
 *   these two replace.
 * @property {number} fieldEntrants          Distinct (wallet, launch) create-slot entries.
 * @property {number} fieldClosedRoundTrips
 * @property {number} fieldOpenPositions     Entries with no complete P&L. Reported, never imputed.
 *   **The conflation captain decision 461 splits**: it is `positionsStillHeldAtHorizon +
 *   positionsHorizonNotObserved`, and those are a fact about the deployer's field and a fact about
 *   our coverage respectively.
 * @property {number} deployerMismatches     Launches whose first create-slot buyer was not the
 *   candidate wallet. See {@link scoreEntry}.
 * @property {readonly EntryWindow[]} windows **EVERY window the walk delivered, refused ones
 *   INCLUDED, each with the wallets that were in it.** Every other field on this score is an
 *   aggregate; this is the evidence they were computed from, kept rather than discarded.
 *
 *   Three things about the population, because they are the whole point of the field. It is over
 *   `launches` and not over `scored`: observing *who filled a create slot* needs no proof of
 *   co-ordination — only *claiming they were independent* does — and on the widened measurement
 *   **209 of 210 windows walked cleanly while 38 produced a room reading**, so restricting this to
 *   the proven half would throw away roughly four fifths of what the same walk already paid for.
 *   Every row carries {@link EntryWindow.roomIsProven}, so the two claims can never be conflated by
 *   a reader. And it decides NOTHING — no bar, gate, threshold, predicate or verdict reads it, and a
 *   test pins that — which is the shape captain decision 208b established for
 *   {@link EntryScore.roomLeftBound}: record it, publish it, decide nothing with it yet.
 *
 *   {@link ENTRANT_IDENTITY_IS_A_WALLET_NOT_A_TRADER} governs what a list of these addresses may be
 *   said to be, and it is in {@link EntryScore.caveats} on every score so the limit travels with the
 *   data rather than with this comment.
 * @property {readonly import('./bounds.mjs').UnmeasuredComponent[]} costLedger  **THE SUBTRACTION
 *   LEDGER** — one typed row per cost and population component of a realized-profit figure, with a
 *   number where this build can bound it and `null` where it cannot. Captain decision 466, Stage 3
 *   increment 2. `bounds.mjs` → `costLedger` owns the rows and what each bound is a ceiling OVER;
 *   the two create-slot rows carry a number only when EVERY scored launch produced a whole-block
 *   observation, so one per-signature fallback inside a sample takes both back to `null`.
 * @property {import('./bounds.mjs').ExitVerdict} exitVerdict  The realized-profit verdict, as a
 *   FUNCTION of {@link EntryScore.costLedger} rather than of a caveat string. It is Stage 3's
 *   vocabulary and not {@link EntryScore.verdict}'s — every value of that one is a statement about
 *   ENTRY — and it is carried here because Stage 3 is a second consumer of Stage 2's walk rather
 *   than a reader of `runs/*.json`. **It reads `'exit-unbounded'` on every candidate this build can
 *   score, and it gates nothing**: no bar, threshold, predicate or entry verdict reads it, and a
 *   test pins that the entry finding is byte-identical without it.
 * @property {string[]} caveats
 */

/**
 * Score a deployer's entry room and its field, from measured launches.
 *
 * ## How the verdict is composed, and why it is composed this way
 *
 * Three legs now, and they are **not** symmetric:
 *
 * - **Room is the gate.** It is measured from capital that provably entered the curve, and it is
 *   the quantity the 2026-06-04 finding turned on. A median below `minRoomLeft` ends the enquiry.
 *
 *   **On fees, be exact about which claim is being made.** No fee term appears anywhere in the room
 *   arithmetic — every input is `Fill.sol`, and given a fixed set of fills no fee can perturb the
 *   ratio. That is *arithmetic* independence, and it is why room is reproducible offline for free.
 *   It is **not** causal independence, and reading it as such is the trap: room is a ratio of who
 *   got FILLED, and the fee auction is what decides that. Post-break our subject's launches saw a
 *   median of **9,169 first-30-second attempts against 220 that landed — 41.6 attempts per landed
 *   transaction** (`slot-zero-stage2-correctness-and-fees/report.md` §4). The fill tape sees only
 *   the ~2% that won, so `independentSol` is outsider capital that *cleared the auction*, never
 *   outsider capital that wanted in. Room is measured strictly downstream of the price of the seat
 *   and says nothing about it: on the launches clearing the 0.55 bar the worst single entrant paid
 *   **2.86 SOL** in fees to get there. Pricing that seat is the next lane's, not this one's.
 * - **The field is a veto, never a pass.** It is gross of fees and therefore an upper bound, so a
 *   loss-making field is conclusive and a profitable-looking one establishes nothing at all. It can
 *   only ever take a verdict away. Netting the measured cost onto it — captain decision 136b —
 *   sharpens the veto without changing its direction: measured cost is itself a lower bound
 *   ({@link LANDING_TIP_CAVEAT}), so the net figure is still an upper bound on what anyone took.
 * - **Cost is a gate, and an unmeasured one is never a pass.** Under the captain's ruling of
 *   2026-08-02 the fee is part of the entry window, so a room figure with the price of the seat
 *   unmeasured beside it is not an answer to "is this enterable". The order the checks run in is
 *   deliberate and it is also what makes the run affordable: **room and the gross field are free and
 *   they run first**, so a deployer that fails either is refused before one RPC request is spent on
 *   pricing it. Only a candidate still alive after both is worth the walk — which is the same
 *   recommendation `slot-zero-stage2-correctness-and-fees/report.md` §5.3 reaches from the cost side.
 *
 *   **The bar is compared PER LAUNCH** (captain decision 140a). Each scored launch contributes its
 *   own median entry and nothing more, and the median of those is what `entry-cost-prohibitive`
 *   reads — {@link EntryScore.entryCostPerSolStakedByLaunch}. The pooled per-entry distribution is
 *   reported beside it, and pooling is exactly what must not be gated on: create-slot entrant
 *   counts vary by an order of magnitude between launches, so a pooled median is a statement about
 *   whichever launch was busiest rather than about the deployer.
 *
 * ## Launches whose opening is UNPROVEN are not scored at all
 *
 * `measure.mjs` → `roomIsProven` owns the reasoning. A create slot the co-ordination rule marks
 * nothing in gives it nothing to find, which is indistinguishable from there being nothing to find
 * — and the difference is worth ~9.6–10.0 SOL of the operation's own stake booked as outsider
 * capital. Those launches are removed from **both** legs before anything is computed: they
 * contribute no room figure, no field entrant and no round trip. Captain decision 134a.
 *
 * ## And a sample that is COMPLETE ENOUGH can still fail to decide the room bar
 *
 * Passing `minLaunchesSampled` says the sample is big enough. It does not say the launches that went
 * missing were harmless, and since captain decision 190a a candidate can be scored with two of them
 * gone — chosen by drop cause rather than at random. {@link roomBarRobustness} is the guard on that
 * and owns the whole argument, including what its margin is and is not anchored to. It runs between
 * the sample-size gate and the room bar, refuses in BOTH directions, and costs nothing on a complete
 * sample.
 *
 * The consequence is deliberate and it is the safe one. A candidate whose proven launches fall
 * below `minLaunchesSampled` scores `entry-unmeasured` — never `entry-open-after-costs`, and never
 * folded in with a refusal. **It is `too-few-proven-windows` specifically**, and it is
 * `our-coverage`: the score says so on its own face rather than leaving a consumer to infer it from
 * `launchesRoomUnproven`. See {@link UNMEASURED_CAUSE_ATTRIBUTION} and
 * {@link isDeployerAttributable} — a later stage may not drop a candidate on this.
 * On our own tape, replaying the live recipe at every index, that removes
 * **22 of 22 false-positive windows and leaves none at any bar from 0.1 to 0.8**.
 *
 * **What it costs is what captain decision 182a bought back.** Under the shared-transaction rule
 * alone the refusal cost 62 of 226 rolling windows, which became unmeasured rather than wrong;
 * under the UNION rule it costs **0 of 226**, with false positives still 0. (Those counts are a
 * property of the replay's window width, which is `maxLaunchesPerCandidate`: at the 8 that preceded
 * captain decision 190a they read 24 of 24, and 81 of 228 against 0 of 228.) The refusal is
 * unchanged and no bar was relaxed — the rule simply sees more, so it refuses less. Stage 0's
 * rolling replay asserts both halves of that.
 *
 * The asymmetry is not caution for its own sake. Our own subject deployer's post-break field reads
 * **76.3% of closed round trips positive** on this exact measurement, while the fee-inclusive record
 * puts the entire outsider population at +0.54 SOL per launch with 51 of 106 wallets negative. A
 * design that let the field leg carry a positive verdict would call that wallet beatable, and it is
 * not. Stage 0 asserts the composite verdict on it for exactly this reason.
 *
 * ## The deployer-mismatch case
 *
 * The create-slot rule reads the deployer off the fills — first curve buyer — rather than trusting a
 * `creator` field that can move on-chain. When that wallet is not the candidate the launch was
 * sampled for, the launch is **kept, counted, and reported**. Keeping it is the conservative
 * direction: whoever bought first is credited to the operation, so the operation's share can only be
 * overstated and the room understated, which makes `entry-open-after-costs` harder to earn rather than
 * easier. A count that is not small is a caveat on the whole sample.
 *
 * @param {readonly LaunchEntry[]} launches Every launch the walk delivered. Ones whose room is
 *   unproven are removed here rather than by the caller, so no caller can forget to.
 * @param {EntryThresholds} t
 * @param {object} [context]
 * @param {string} [context.candidateWallet] Wallet the launches were sampled for, when known.
 * @param {number} [context.launchesDropped] Windows that could not be measured and were excluded.
 * @param {number} [context.mintTimeDisagreements] Of those, the ones dropped because the vendor's
 *   mint time and the fill tape disagreed. Called out separately because it is the one drop cause
 *   that says the method's own assumption has broken rather than that a launch was awkward.
 * @param {ReadonlyMap<LaunchEntry, import('./bounds.mjs').CreateSlotCostObservation>}
 *   [context.createSlotCostObservations] What each launch's WHOLE create slot cost, keyed by the
 *   LAUNCH it was read for and never by its create slot, which two launches can share — the
 *   failed-attempt fee bill and the tip total `pumpfun.mjs` → `readCreateSlotSlotCosts`
 *   read out of a block response the cost leg had already paid for. Absent or short, the two
 *   create-slot rows of {@link EntryScore.costLedger} stay UNBOUNDED, which is the required
 *   direction: a ceiling read from four launches of six says nothing about the two it did not see.
 *   **The population is the SCORED launches**, decided here rather than by the caller, because it is
 *   here that the refused half is removed.
 * @param {number} [context.launchesPlanned] Launches the walk SET OUT to measure for this candidate
 *   — `stage2.mjs`'s `planned.length`. {@link roomBarRobustness} needs the size of the hole, and
 *   this is the only accounting that closes over every way a launch can fail to produce a room
 *   figure: dropped mid-walk, refused as unproven, or never started because the stage ceiling ran
 *   out before its turn. Absent, the hole falls back to `launches.length + launchesDropped`, which
 *   misses only that last case — so a caller that can supply this should.
 * @returns {EntryScore}
 */
export function scoreEntry(launches, t, context = {}) {
  // THE PARTITION, and it comes first because nothing below may see the refused half. A launch the
  // co-ordination rule marked nothing in contributes no room figure, no field entrant and no round
  // trip — see the module header and `measure.mjs` → `roomIsProven`.
  const scored = launches.filter((l) => roomIsProven(l.createSlot));
  const refused = launches.filter((l) => !roomIsProven(l.createSlot));
  const roomUnproven = refused.length;

  const room = scored.map((l) => l.createSlot.roomLeft);
  const field = scored.flatMap((l) => l.field);
  const closed = field.filter((e) => e.closedInWindow);

  const deployerMismatches =
    context.candidateWallet === undefined
      ? 0
      : scored.filter((l) => l.createSlot.deployer !== context.candidateWallet).length;

  const roomLeft = distribution(room);
  const fieldHitRateGrossOfFees = hitRate(closed, (e) => e.realisedSolGrossOfFees > 0);

  const dropped = context.launchesDropped ?? 0;
  const clockDrops = context.mintTimeDisagreements ?? 0;
  // THE SIZE OF THE HOLE, measured against what the walk PLANNED rather than against what it brought
  // back, so every way a launch can fail to produce a room figure is counted once: dropped mid-walk,
  // refused as unproven, or never started because the stage ceiling ran out before its turn. The
  // `Math.max` is belt and braces — `launchesPlanned` is always at least `launches.length + dropped`
  // in a real run — and it means a caller that supplies neither, or a stale one that supplies too
  // small a plan, can never make the hole look smaller than the two causes `scoreEntry` can see for
  // itself. Computed HERE, before anything returns, because both consumers need it on every path:
  // the near-bar guard below (captain decision 198b) and the reported bound (208b), which must reach
  // even the verdicts that return at the sample-size gate.
  const missingLaunches = Math.max(
    roomUnproven + dropped,
    (context.launchesPlanned ?? 0) - scored.length,
  );
  // Captain decision 208b. REPORTING, not a gate — see {@link roomMedianBound}. The refused half of
  // the hole hands over its OWN measured room, which is what makes the bound informative rather than
  // the algebraic [0, 1] the guard is obliged to use.
  const roomLeftBound = roomMedianBound(
    room,
    refused.map((l) => l.createSlot.roomLeft),
    missingLaunches - roomUnproven,
  );

  // The cost leg's own populations. `priced` is every create-slot entry the chain could price;
  // `closedPriced` is the subset whose WHOLE window priced, which is the only population that can
  // carry a net P&L. They are counted apart because they fail apart: a run can price every create
  // slot and still be unable to price a single round trip end to end.
  const priced = field.filter((e) => Number.isFinite(e.entryCostSol));
  const closedPriced = closed.filter((e) => Number.isFinite(e.realisedSolNetOfMeasuredFees));
  const entryCostPriced = hitRate(field, (e) => Number.isFinite(e.entryCostSol));
  const entryCostPerSolStaked = distribution(priced.map((e) => e.entryCostPerSolStaked));
  // The same quantity one unit up, and it is the unit the bar is anchored on. A launch contributes
  // its own median and nothing else, so thirty priced entrants on one launch weigh exactly as much
  // as one priced entrant on another. Launches that priced nothing contribute nothing rather than a
  // zero — an unpriced launch is not a free one.
  const entryCostPerSolStakedByLaunch = distribution(
    scored.flatMap((l) => {
      const perEntry = l.field
        .map((e) => e.entryCostPerSolStaked)
        .filter((v) => Number.isFinite(v));
      return perEntry.length === 0 ? [] : [median(perEntry)];
    }),
  );
  const fieldHitRateNetOfMeasuredFees = hitRate(closedPriced, (e) => e.realisedSolNetOfMeasuredFees > 0);
  const fieldRealisedSolNetOfMeasuredFees = distribution(
    closedPriced.map((e) => e.realisedSolNetOfMeasuredFees),
  );

  // ---- THE REALIZATION CORRECTION, captain decision 461. Reported, gating nothing. -----------
  //
  // Every figure above is over positions that GOT OUT. These are the same statistics over every
  // position taken, with the ones still held at the horizon resolved at ZERO RECOVERY — the worst
  // case for the part we cannot see, which is what the captain's standing evidence bar asks a figure
  // to survive. The module header owns the measurement and the reason the conditioned reading is
  // the optimistic one rather than the conservative one.
  //
  // THREE DENOMINATORS, kept apart because they answer different questions and pooling them is the
  // defect this whole correction is about:
  //
  // - `resolvable` — exited plus still-held. What the fill tape alone can resolve at zero recovery.
  // - `resolvablePriced` — the subset of those whose WHOLE window the cost leg priced. Smaller for
  //   a reason that is ours and not the deployer's, and `entryCostTargets` owns why it was not
  //   widened.
  // - `stillHeld` — the positions the mark is a bound ON. Never a population any rate is over.
  const resolvable = field.filter((e) => e.positionOutcome !== 'horizon-not-observed');
  const stillHeld = field.filter((e) => e.positionOutcome === 'still-held-at-horizon');
  const horizonNotObserved = field.filter((e) => e.positionOutcome === 'horizon-not-observed');
  const resolvablePriced = resolvable.filter((e) =>
    Number.isFinite(e.realisedSolAtZeroRecoveryNetOfMeasuredFees),
  );
  // A position resolvable by TOKEN readability can still carry an unreadable SOL amount, so it
  // contributes to no realized figure — `distribution` drops it — and it is excluded from the rate
  // rather than scored as a loss, which would manufacture a loss out of OUR OWN coverage in the same
  // direction 461 exists to close. So this rate's `n` may sit BELOW `resolvable.length`, and it is
  // the same `n` the gross distribution beside it reports. (The pre-existing conditioned
  // `fieldHitRateGrossOfFees` has the same shape and is deliberately NOT moved: it is a published
  // quantity and schema 25 claims every `…OfFees` figure is poolable across the boundary.)
  const resolvableGross = resolvable.filter((e) =>
    Number.isFinite(e.realisedSolAtZeroRecoveryGrossOfFees),
  );
  const fieldHitRateOverAllPositionsGrossOfFees = boundedHitRate(
    resolvableGross,
    (e) => e.realisedSolAtZeroRecoveryGrossOfFees > 0,
  );
  const fieldHitRateOverAllPositionsNetOfMeasuredFees = boundedHitRate(
    resolvablePriced,
    (e) => e.realisedSolAtZeroRecoveryNetOfMeasuredFees > 0,
  );

  // THE SUBTRACTION LEDGER, over the SCORED launches — captain decision 466, Stage 3 increment 2.
  //
  // The population is `scored` and not `launches`: a refused window contributes no room figure, no
  // field entrant and no round trip (134a), so it is in no realized figure either and demanding an
  // observation for it would refuse the ledger over a launch nothing is computed from. `costLedger`
  // requires an observation for every one of them, so a single launch whose cost walk fell back to
  // per-signature reads leaves both create-slot rows `null`.
  const observations = context.createSlotCostObservations ?? new Map();
  const ledger = costLedger({
    observations: scored.map((l) => observations.get(l)).filter((o) => o !== undefined),
    launchesRequiringObservation: scored.length,
  });

  /** @type {EntryScore} */
  const score = {
    verdict: 'entry-unmeasured',
    // Set by {@link attributeUnmeasured} on every path that keeps or reaches an unmeasured verdict,
    // and left null on every measured one. The initial verdict above is unmeasured, so a branch
    // that returns without calling it would ship the collapsed label decision 174b removed — which
    // is why the contract is asserted rather than reviewed for.
    unmeasuredCause: null,
    unmeasuredCauseAttribution: null,
    unmeasuredContributingCauses: [],
    rationale: '',
    launchesSampled: scored.length,
    launchesRoomUnproven: roomUnproven,
    // Over EVERY launch handed in, refused ones included. A distribution taken over the scored half
    // could never contain a zero, and the zeros are exactly what an auditor is looking for.
    bundledTx: distribution(launches.map((l) => l.createSlot.bundledTx)),
    maxWalletsInOneTx: distribution(launches.map((l) => l.createSlot.maxWalletsInOneTx)),
    // The two halves of the co-ordination rule are reported APART, over the same population, so a
    // saved run says which one carried each launch. Neither is a verdict input on its own — the
    // predicate reads the union — but a reader who cannot tell them apart cannot audit a room
    // figure against an older record's.
    runTx: distribution(launches.map((l) => l.createSlot.runTx)),
    adjacencyMarks: distribution(launches.map((l) => l.createSlot.adjacencyMarks)),
    launchesWithNoOutsider: scored.filter((l) => l.field.length === 0).length,
    roomLeft,
    roomLeftBound,
    roomHitRate: hitRate(room, (v) => v >= t.minRoomLeft),
    operationShare: distribution(scored.map((l) => l.createSlot.operationShare)),
    devSol: distribution(scored.map((l) => l.createSlot.devSol)),
    coordinatedSol: distribution(scored.map((l) => l.createSlot.coordinatedSol)),
    outsidersPerLaunch: distribution(scored.map((l) => l.field.length)),
    fieldFillSol: distribution(field.map((e) => e.createSlotFillSol)),
    fieldSolQueuedAhead: distribution(field.map((e) => e.solQueuedAheadSol)),
    fieldRealisedSolGrossOfFees: distribution(closed.map((e) => e.realisedSolGrossOfFees)),
    fieldReturnPerSolGrossOfFees: distribution(closed.map((e) => e.returnPerSolGrossOfFees)),
    fieldHitRateGrossOfFees,
    entryCostSol: distribution(priced.map((e) => e.entryCostSol)),
    entryCostPerSolStaked,
    entryCostPerSolStakedByLaunch,
    entryTxFeeSol: distribution(priced.map((e) => e.entryTxFeeSol)),
    entryCostPriced,
    fieldRealisedSolNetOfMeasuredFees,
    fieldReturnPerSolNetOfMeasuredFees: distribution(
      closedPriced.map((e) => e.returnPerSolNetOfMeasuredFees),
    ),
    fieldHitRateNetOfMeasuredFees,
    fieldClosedRoundTripsPriced: closedPriced.length,
    // Captain decision 461. BESIDE the conditioned figures above, never instead of them, and read
    // by nothing — the shape 208b established for `roomLeftBound`.
    fieldRealisedSolOverAllPositionsGrossOfFees: distribution(
      resolvable.map((e) => e.realisedSolAtZeroRecoveryGrossOfFees),
    ),
    fieldReturnPerSolOverAllPositionsGrossOfFees: distribution(
      resolvable.map((e) => e.returnPerSolAtZeroRecoveryGrossOfFees),
    ),
    fieldHitRateOverAllPositionsGrossOfFees,
    fieldRealisedSolOverAllPositionsNetOfMeasuredFees: distribution(
      resolvablePriced.map((e) => e.realisedSolAtZeroRecoveryNetOfMeasuredFees),
    ),
    fieldReturnPerSolOverAllPositionsNetOfMeasuredFees: distribution(
      resolvablePriced.map((e) => e.returnPerSolAtZeroRecoveryNetOfMeasuredFees),
    ),
    fieldHitRateOverAllPositionsNetOfMeasuredFees,
    // The BOUND on the zero-recovery resolution, over the positions it resolves. Reported so the
    // worst case can be read against what the window's own last price says is still there.
    fieldResidualMarkedSolAtWindowLastPriceGrossOfFees: distribution(
      stillHeld.map((e) => e.residualMarkedSolAtWindowLastPriceGrossOfFees),
    ),
    positionsStillHeldAtHorizon: stillHeld.length,
    positionsHorizonNotObserved: horizonNotObserved.length,
    fieldEntrants: field.length,
    fieldClosedRoundTrips: closed.length,
    fieldOpenPositions: field.length - closed.length,
    deployerMismatches,
    // THE EVIDENCE, not another aggregate — over every launch handed in, refused ones included.
    // See the typedef: the refused half is four fifths of what the walk paid for, and `roomIsProven`
    // travels on each row so the entrant reading and the room reading can never be conflated.
    windows: launches.map((l) => ({
      createSlot: l.createSlot,
      roomIsProven: roomIsProven(l.createSlot),
      entrants: l.field,
    })),
    costLedger: ledger,
    // A FUNCTION OF THE LEDGER, and the whole point of captain decision 466's shape: the refusal is
    // computed from the rows rather than asserted in a sentence beside them. `realised` is `null`
    // here — the ledger refuses before any realized figure is consulted, and inventing the
    // comparison would need a BAR, which is a pin nobody has made (`bounds.mjs` → `exitVerdict`).
    exitVerdict: exitVerdict({ ledger, realised: null, bar: null }),
    caveats: [],
  };

  // FIRST, and unconditionally, because it is a statement about the headline figure itself rather
  // than about a hazard in one of the legs. Captain decision 208b: the median must state its own
  // incompleteness at the point of use, so a complete sample says so here too rather than leaving
  // silence to be read as completeness.
  score.caveats.push(roomLeftBound.caveat);
  // The entrant list is on every score, so its limit is on every score too — travelling with the
  // data rather than living in a document, which is the same requirement `LANDING_TIP_CAVEAT` and
  // `WINNERS_ONLY_CAVEAT` are constants for.
  score.caveats.push(ENTRANT_IDENTITY_IS_A_WALLET_NOT_A_TRADER);
  if (roomUnproven > 0) {
    score.caveats.push(
      `${roomUnproven} of ${launches.length} measured launch(es) had NO co-ordination evidence in ` +
        `the create slot — no shared transaction and no deployer-anchored block-index run — so the ` +
        `co-ordination rule recovered nothing there and the opening is UNPROVEN rather than open. ` +
        `Those launches are NOT SCORED — not their room, not their field. Scoring ` +
        `them would book the operation's own stake as outsider capital and inflate room, which is ` +
        `the one direction that manufactures an edge (captain decisions 134a and 182a).`,
    );
  }
  if (dropped > 0) {
    score.caveats.push(
      `${dropped} launch window(s) could not be walked back to the mint and were DROPPED rather ` +
        `than measured from a partial window`,
    );
  }
  if (clockDrops > 0) {
    // A REPORTABLE EVENT, not a footnote. The zero-gap agreement between the vendor's mint time and
    // the first fill was measured on our OWN tape; on strangers it has now been seen to break, and
    // this count is what made it visible (`runs/2026-08-04-full-day-default.md` owns the reading).
    score.caveats.push(
      `REPORTABLE: ${clockDrops} of those ${dropped} were dropped because the vendor's mint time and ` +
        `pump.fun's fill tape DISAGREED (fills older than the recorded creation). On the committed ` +
        `tape that gap is exactly 0 on all 235 covered launches, so a non-zero count here means the ` +
        `clock assumption this measurement rests on has broken and the sample is no longer what it seems.`,
    );
  }
  if (deployerMismatches > 0) {
    score.caveats.push(
      `${deployerMismatches} of ${scored.length} scored launch(es) had a first create-slot buyer other ` +
        `than the candidate wallet; those are credited to the operation, which understates room`,
    );
  }
  if (score.fieldOpenPositions > 0) {
    score.caveats.push(
      `${score.fieldOpenPositions} of ${field.length} field entries were still open at the window's ` +
        `end and have NO complete P&L; they are excluded from the *OfFees realised figures, never ` +
        `marked. Of those, ${score.positionsStillHeldAtHorizon} were STILL HELD at the horizon and ` +
        `are resolved at ZERO RECOVERY in the *OverAllPositions figures, and ` +
        `${score.positionsHorizonNotObserved} could not have their closure decided from the rows we ` +
        `hold at all — those are OUR COVERAGE and are resolved neither way (captain decisions 461 ` +
        `and 174b).`,
    );
  }
  // ON EVERY SCORE, including one that reached no bar, for the reason `roomLeftBound.caveat` is: the
  // point of the decision is that the FIGURE states which construction produced it, so a surface
  // cannot print a realised number without the label, and silence is never read as "there is only
  // one reading".
  score.caveats.push(REALISATION_CONSTRUCTION_CAVEAT);
  score.caveats.push(NET_ALL_POSITIONS_SELECTION_CAVEAT);
  // And the LEDGER's own sentence, on every score for the same reason: the refusal is a property of
  // the numbers above it, so it travels with them to the record and the rendered block rather than
  // living in a doc. It names the unbounded rows rather than counting them, because the remedy
  // differs per row (captain decision 466; `bounds.mjs` → `describeCostLedger`).
  score.caveats.push(describeCostLedger(ledger, score.exitVerdict));
  score.caveats.push(
    'Every *GrossOfFees* figure above is exactly that and is therefore an UPPER BOUND. Priority ' +
      'fees, landing tips, the venue fee and rent are all absent from the fill tape; the ' +
      '*NetOfMeasuredFees* figures beside them are the on-chain correction, and they replace none ' +
      'of the gross ones.',
  );
  if (entryCostPriced.hits > 0) {
    score.caveats.push(
      `${entryCostPriced.hits} of ${entryCostPriced.n} create-slot entries were priced on-chain ` +
        `(${fmt(entryCostPriced.rate)}), and ${score.fieldClosedRoundTripsPriced} of ` +
        `${closed.length} closed round trips were priced across their whole window. The rest carry ` +
        `NO cost figure — not a zero.`,
    );
    score.caveats.push(LANDING_TIP_CAVEAT);
    score.caveats.push(WINNERS_ONLY_CAVEAT);
  } else {
    score.caveats.push(
      'NO ENTRY COST WAS MEASURED for this candidate, so every figure above is gross of fees and ' +
        'the price of the seat is unknown. That is a limit of this reading, not a finding that ' +
        'entry was cheap.',
    );
  }
  score.caveats.push(
    'ENTRY ONLY. Exit feasibility — when the dev sells, whether its trigger is a size our own buy ' +
      'would count towards, and whether an outsider could have left first — is NOT scored here.',
  );

  if (scored.length < t.minLaunchesSampled) {
    // THE AGGREGATE DECISION 174b SPLIT. One code site, three states of the world, and they are
    // separated here rather than left for a consumer to guess at from counts it may not read.
    //
    // Precedence, most binding first: a walk that was never offered enough windows could not have
    // been rescued by either of the other two, a drop is a window we reached and lost, and a
    // refusal is a window we measured and declined to score. All three are `our-coverage`, so the
    // order decides which sentence leads and never whether the candidate may be filtered.
    /** @type {UnmeasuredCause[]} */
    const causes = [];
    if (launches.length + dropped < t.minLaunchesSampled) causes.push('too-few-windows-available');
    if (dropped > 0) causes.push('windows-dropped');
    if (roomUnproven > 0) causes.push('too-few-proven-windows');
    // Exhaustive by arithmetic — `scored = launches.length - roomUnproven`, so with no refusals and
    // no drops `scored < floor` IS `launches.length + dropped < floor`. Kept as the contract guard:
    // an unmeasured verdict must never reach a consumer with no cause on it, whatever a later edit
    // does to the partition above.
    if (causes.length === 0) causes.push('too-few-windows-available');
    attributeUnmeasured(score, causes);
    score.rationale =
      `only ${scored.length} scoreable launch window(s), below the ${t.minLaunchesSampled} this ` +
      `measurement needs. A distribution over fewer is not a distribution.` +
      (roomUnproven > 0
        ? ` ${roomUnproven} further window(s) were measured but NOT SCORED: their create slot ` +
          `carried neither a shared transaction nor a deployer-anchored block-index run, so the ` +
          `co-ordination rule found nothing and cannot tell an operation that did not co-ordinate ` +
          `from a create slot full of genuine outsiders. That is UNPROVEN, not closed and not ` +
          `open — read it as no answer about this wallet.`
        : '') +
      (dropped > 0 ? ` ${dropped} window(s) were dropped for incomplete coverage.` : '');
    return score;
  }

  // THE NEAR-BAR GUARD, captain decision 198b. It sits here — after the sample-size gate and before
  // the first bar — because a sample that is too SMALL is already answered above, and because a
  // candidate refused here must not go on to spend Solana RPC requests pricing a field whose room
  // reading was never decided. `scoreCandidateEntry` starts the cost leg only on
  // `entry-cost-unmeasured`, so returning an unmeasured verdict from this point is also what makes
  // the guard free. `missingLaunches` is computed at the top of this function; the reasoning for how
  // the hole is counted is there.
  //
  // **IT KEEPS THE ASSUMPTION-FREE INTERVAL AND MUST NOT BE HANDED `roomLeftBound`'s.** The reported
  // bound is narrower, because a refused launch's own measurement replaces the algebraic ceiling —
  // so giving it to the guard would make the guard refuse LESS. That is loosening a guard by the
  // back door, which captain decision 208b explicitly does not do. A REFUSAL and a REPORT read the
  // same hole and are entitled to different assumptions about it.
  const robustness = roomBarRobustness(room, missingLaunches, t.minRoomLeft);
  if (!robustness.decided) {
    attributeUnmeasured(score, ['room-verdict-not-robust-to-missing-launches']);
    score.rationale =
      `${scored.length} launch window(s) scored — enough — but ${missingLaunches} of the ` +
      `${scored.length + missingLaunches} planned produced NO room figure, and they did not go ` +
      `missing at random: a walk drops the BUSIEST windows at the request cap, and the ` +
      `co-ordination rule refuses the ones with no evidence in them. Median room over what ` +
      `survived is ${fmt(roomLeft.median)}, but completing the sample puts it anywhere in ` +
      `[${fmt(robustness.lo)}, ${fmt(robustness.hi)}] — an interval that CONTAINS the ` +
      `${t.minRoomLeft} bar, so this sample does not decide which side of it this deployer is on. ` +
      `The bounds are exact: room is a share and lies in [${ROOM_LEFT_RANGE.min}, ` +
      `${ROOM_LEFT_RANGE.max}] by construction, which is the ONLY thing this REFUSAL is entitled to ` +
      `assume about a launch it never walked. (The ROOM MEDIAN BOUND stated after this sentence is ` +
      `a narrower reading of the same hole, fed by the refused launches' own measurements; it is ` +
      `REPORTED and no gate — this one included — is allowed to read it.) ` +
      `WHICH WAY the missing launches lean is UNMEASURED ` +
      `— which is why this refuses in both directions rather than correcting in one. Read it as no ` +
      `answer about this wallet, not as a room finding (captain decision 198b).` +
      ` ${roomLeftBound.caveat}`;
    return score;
  }

  if (!(roomLeft.median >= t.minRoomLeft)) {
    score.verdict = 'entry-room-absent';
    score.rationale =
      `median room left ${fmt(roomLeft.median)} over ${scored.length} scored launches is below the ` +
      `${t.minRoomLeft} bar (p25 ${fmt(roomLeft.p25)}, p75 ${fmt(roomLeft.p75)}; ` +
      `${score.roomHitRate.hits}/${score.roomHitRate.n} launches clear it). The deployer and its own ` +
      `wallets take the bottom of their own curve, so there is nothing to enter. Read the captain's ` +
      `way: this launch bot is well configured, and that is bad news for us.` +
      ` ${roomLeftBound.caveat}`;
    return score;
  }

  if (closed.length < t.minFieldRoundTrips) {
    // Room was read on a full sample and clears the bar, so outsiders did reach these create slots
    // — and then too few of them completed a round trip to build a hit rate from. This reads like a
    // fact about the deployer and is NOT one: the launches this counts over are the ones our own
    // `maxRequestsPerLaunch` afforded to walk, and it drops the busiest ones. `our-coverage`, per
    // {@link UNMEASURED_CAUSE_ATTRIBUTION}, whose doc names the one place the evidence lives.
    attributeUnmeasured(score, ['too-few-closed-round-trips']);
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}), but only ${closed.length} ` +
      `closed round trip(s) across ${scored.length} scored launches — below the ${t.minFieldRoundTrips} a ` +
      `hit rate needs. The field is UNMEASURED, so whether anyone actually takes that room is ` +
      `unknown and must not be assumed from the room figure alone.` +
      ` ${roomLeftBound.caveat}`;
    return score;
  }

  if (!(fieldHitRateGrossOfFees.rate >= t.minFieldHitRateGross) || !(score.fieldRealisedSolGrossOfFees.median > 0)) {
    score.verdict = 'entry-field-loss-making';
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}), but the field loses money ` +
      `BEFORE costs: ${score.fieldHitRateGrossOfFees.hits}/${score.fieldHitRateGrossOfFees.n} closed ` +
      `round trips positive (${fmt(fieldHitRateGrossOfFees.rate)}), median ` +
      `${fmt(score.fieldRealisedSolGrossOfFees.median)} SOL gross. Fees only make that worse, so this ` +
      `is conclusive: room exists and nobody is converting it. No RPC request was spent pricing it.` +
      ` ${roomLeftBound.caveat}`;
    return score;
  }

  // ---- THE COST LEG. Everything above was free; nothing below is. ---------------------------
  //
  // Rule 1 of the ruling: unmeasured cost is never a pass. A run that could not price the field has
  // not established that the window is enterable, it has established that it does not know — and
  // the two must not share a verdict. This is terminal for the candidate in this run.
  if (!(entryCostPriced.rate >= t.minPricedFraction)) {
    score.verdict = 'entry-cost-unmeasured';
    // Our budget and our coverage, in every one of its forms: the leg disabled (no RPC client), the
    // leg abandoned on a transport failure, or the leg run and short. `entry.coverage.cost.ran`
    // separates those three; none of them is a fact about the deployer.
    attributeUnmeasured(score, ['too-little-of-the-field-priced']);
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}) and the field is not ` +
      `loss-making before costs, but only ${entryCostPriced.hits} of ${entryCostPriced.n} ` +
      `create-slot entries could be priced on-chain (${fmt(entryCostPriced.rate)}, below the ` +
      `${t.minPricedFraction} this reading needs). Under the captain's ruling of 2026-08-02 the fee ` +
      `is part of the entry window, so a room figure with the price of the seat unmeasured beside ` +
      `it is NOT a finding that the window is enterable — it is the absence of one.` +
      ` ${roomLeftBound.caveat}`;
    return score;
  }

  // ONE FIGURE PER LAUNCH, every launch counting once — captain decision 140a. The pooled per-entry
  // distribution is reported beside it as the finer-grained evidence, but it is not what is gated:
  // a single launch with dozens of priced entrants would otherwise decide the bar for the sample.
  if (entryCostPerSolStakedByLaunch.median >= t.maxEntryCostPerSolStaked) {
    score.verdict = 'entry-cost-prohibitive';
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}), but landing in it costs a ` +
      `median ${fmt(entryCostPerSolStakedByLaunch.median)} SOL per SOL staked PER LAUNCH over ` +
      `${entryCostPerSolStakedByLaunch.n} priced launch(es) (p75 ` +
      `${fmt(entryCostPerSolStakedByLaunch.p75)}, p90 ${fmt(entryCostPerSolStakedByLaunch.p90)}; ` +
      `pooled over the ${entryCostPerSolStaked.n} individual entries it is ` +
      `${fmt(entryCostPerSolStaked.median)}), at or above the ${t.maxEntryCostPerSolStaked} bar — ` +
      `the price of the seat consumes the opening. ${LANDING_TIP_CAVEAT}` +
      ` ${roomLeftBound.caveat}`;
    return score;
  }

  if (closedPriced.length < t.minFieldRoundTrips) {
    score.verdict = 'entry-cost-unmeasured';
    // Distinct from the gate above and from the gross one at the top: the field DID close enough
    // round trips, and it is our pricing that could not follow them across their whole window.
    attributeUnmeasured(score, ['too-few-priced-round-trips']);
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}) and entry costs a median ` +
      `${fmt(entryCostPerSolStakedByLaunch.median)} SOL per SOL staked per launch, but only ${closedPriced.length} ` +
      `closed round trip(s) could be priced across their whole window — below the ` +
      `${t.minFieldRoundTrips} an after-cost hit rate needs. What the field actually CLEARED after ` +
      `costs is therefore unmeasured, and an unmeasured after-cost result is not a pass.` +
      ` ${roomLeftBound.caveat}`;
    return score;
  }

  if (
    !(fieldHitRateNetOfMeasuredFees.rate >= t.minFieldHitRateNet) ||
    !(fieldRealisedSolNetOfMeasuredFees.median > 0)
  ) {
    score.verdict = 'entry-field-loss-making';
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}) and the field looked ` +
      `positive gross — ${fieldHitRateGrossOfFees.hits}/${fieldHitRateGrossOfFees.n} closed round ` +
      `trips above zero — but NET OF MEASURED FEES it does not: ` +
      `${fieldHitRateNetOfMeasuredFees.hits}/${fieldHitRateNetOfMeasuredFees.n} priced round trips ` +
      `positive (${fmt(fieldHitRateNetOfMeasuredFees.rate)}), median ` +
      `${fmt(fieldRealisedSolNetOfMeasuredFees.median)} SOL. This is the leg the gross reading ` +
      `cannot see. ${LANDING_TIP_CAVEAT}` +
      ` ${roomLeftBound.caveat}`;
    return score;
  }

  score.verdict = 'entry-open-after-costs';
  score.rationale =
    `median room left ${fmt(roomLeft.median)} over ${scored.length} scored launches ` +
    `(${score.roomHitRate.hits}/${score.roomHitRate.n} clear the ${t.minRoomLeft} bar); landing ` +
    `costs a median ${fmt(entryCostPerSolStakedByLaunch.median)} SOL per SOL staked per launch ` +
    `(${fmt(entryCostPerSolStaked.median)} pooled over entries, ` +
    `${fmt(score.entryCostSol.median)} SOL at the median entry, p90 ${fmt(score.entryCostSol.p90)}); ` +
    `and after that cost the field still clears — ${fieldHitRateNetOfMeasuredFees.hits}/` +
    `${fieldHitRateNetOfMeasuredFees.n} priced round trips positive, median ` +
    `${fmt(fieldRealisedSolNetOfMeasuredFees.median)} SOL NET OF MEASURED FEES against ` +
    `${fmt(score.fieldRealisedSolGrossOfFees.median)} gross. ` +
    `NOT a recommendation and NOT a profit claim: ${LANDING_TIP_CAVEAT} Exit feasibility is ` +
    `unmeasured entirely. This means the exit question is worth asking, and nothing more.` +
    ` ${roomLeftBound.caveat}`;
  return score;
}

/**
 * Stamp an unmeasured verdict with WHY, and put the filter rule on the score itself.
 *
 * The caveat is not decoration. Captain decision 174b's whole content is that a coverage limit must
 * not be readable as a judgement, and a rule that lives only in a document is a rule every future
 * consumer has to go and find. This is the same discipline {@link LANDING_TIP_CAVEAT} follows: the
 * limit travels with the number, into `caveats`, the rendered block and the run record.
 *
 * @param {EntryScore} score  Mutated in place — `scoreEntry` owns it and returns it directly below.
 * @param {readonly UnmeasuredCause[]} causes  Primary first, in the documented precedence order.
 * @returns {void}
 */
function attributeUnmeasured(score, causes) {
  const primary = /** @type {UnmeasuredCause} */ (causes[0]);
  score.unmeasuredCause = primary;
  score.unmeasuredCauseAttribution = UNMEASURED_CAUSE_ATTRIBUTION[primary];
  score.unmeasuredContributingCauses = [...causes];
  score.caveats.push(COVERAGE_ATTRIBUTION_CAVEAT);
}

/** @param {number} n @returns {string} */
function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(3) : 'n/a';
}
