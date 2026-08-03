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
 */

import { createSlotGroups, median, percentile, roomIsProven, tallyCreateSlot, walletTransactions } from './measure.mjs';

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
 * @property {number} createSlotFillSol  What it was filled for in the create slot itself.
 * @property {number} solQueuedAheadSol  SOL already committed to the create slot ahead of this
 *   wallet's first fill, by pump.fun's own within-slot ordering key. The June report's §5.2
 *   measure of how far back in the queue an outsider now sits.
 * @property {number} queuePosition      1-based rank of that first fill among all create-slot fills.
 * @property {number} stakeSol           Total buy SOL across the whole opening window.
 * @property {boolean} closedInWindow    Whether the position was flat by the window's end.
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
 *   seat per SOL of seat. `NaN` unless priced.
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
 *   is itself a finding: eight of our subject's 86 proven post-break launches had no outsider at
 *   all. Refusing the unproven openings did not move that count — it is eight over all 89 too,
 *   because none of the three refused launches was outsider-free.
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
  /** @type {Map<string, { aheadSol: number, position: number, fillSol: number }>} */
  const queue = new Map();
  let cumulativeSol = 0;
  for (let i = 0; i < inSlot.length; i++) {
    const f = /** @type {import('./measure.mjs').Fill} */ (inSlot[i]);
    if (outsiders.has(f.wallet)) {
      const seen = queue.get(f.wallet);
      if (seen === undefined) queue.set(f.wallet, { aheadSol: cumulativeSol, position: i + 1, fillSol: f.sol });
      else seen.fillSol += f.sol;
    }
    cumulativeSol += f.sol;
  }

  // Whole-window totals, needed for the closure test. Sells matter as much as buys: a wallet that
  // never sold has no realised figure at all, and imputing one from a mark is how a paper number
  // becomes a claimed profit.
  /** @type {Map<string, { solIn: number, solOut: number, tokensBought: number, tokensSold: number }>} */
  const totals = new Map();
  for (const f of fills) {
    let t = totals.get(f.wallet);
    if (t === undefined) {
      t = { solIn: 0, solOut: 0, tokensBought: 0, tokensSold: 0 };
      totals.set(f.wallet, t);
    }
    if (f.side === 'buy') {
      t.solIn += f.sol;
      t.tokensBought += f.tokens;
    } else {
      t.solOut += f.sol;
      t.tokensSold += f.tokens;
    }
  }

  /** @type {FieldEntrant[]} */
  const field = [];
  for (const [wallet, q] of queue) {
    const t = totals.get(wallet) ?? { solIn: 0, solOut: 0, tokensBought: 0, tokensSold: 0 };
    // An unreadable token amount makes closure undecidable. Undecidable is reported as OPEN, never
    // as closed: a wrongly-closed pair contributes a fabricated P&L to the distribution, whereas a
    // wrongly-open one only shrinks the sample and says so.
    const decidable = Number.isFinite(t.tokensBought) && Number.isFinite(t.tokensSold);
    const closedInWindow =
      decidable && t.tokensBought > 0 && t.tokensBought - t.tokensSold <= RESIDUAL_TOLERANCE * t.tokensBought;
    const realised = closedInWindow ? t.solOut - t.solIn : Number.NaN;
    field.push({
      wallet,
      createSlotFillSol: q.fillSol,
      solQueuedAheadSol: q.aheadSol,
      queuePosition: q.position,
      stakeSol: t.solIn,
      closedInWindow,
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
 * @param {ReadonlyMap<string, import('./pumpfun.mjs').TransactionCosts>} priced What came back.
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

    const entryCostSol = entryScope === null ? Number.NaN : entryScope.solOut - entryScope.quotedSol;
    const netRealised = windowScope === null ? Number.NaN : -windowScope.solOut;
    return {
      ...e,
      entryCostSol,
      entryCostPerSolStaked:
        entryScope !== null && e.createSlotFillSol > 0 ? entryCostSol / e.createSlotFillSol : Number.NaN,
      entryTxFeeSol: entryScope === null ? Number.NaN : entryScope.feeAsPayerSol,
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
 * @typedef {object} EntryThresholds
 * @property {number} minRoomLeft            Median room a launch set must leave.
 * @property {number} minLaunchesSampled     Launches below which no distribution is reported.
 * @property {number} minFieldRoundTrips     Closed round trips below which the hit rate is noise.
 * @property {number} minFieldHitRateGross   Necessary-condition floor on the gross hit rate.
 * @property {number} minFieldHitRateNet     The same floor, net of measured fees. The same veto,
 *   now over a real measurement rather than an upper bound.
 * @property {number} maxEntryCostPerSolStaked Median price of the seat, per SOL of seat, at or above
 *   which the cost consumes the opening.
 * @property {number} minPricedFraction      Share of the field the cost leg must have priced before
 *   any after-cost reading is allowed to stand.
 */

/**
 * @typedef {object} EntryScore
 * @property {EntryVerdict} verdict
 * @property {string} rationale
 * @property {number} launchesSampled        Launches actually SCORED. Every distribution and count
 *   below except {@link EntryScore.bundledTx} and {@link EntryScore.maxWalletsInOneTx} is over
 *   exactly this population. Launches handed in but refused are {@link
 *   EntryScore.launchesRoomUnproven}, so `launchesSampled + launchesRoomUnproven` is what the walk
 *   delivered.
 * @property {number} launchesRoomUnproven   Launches whose create slot carried NO bundled
 *   transaction and which are therefore **not scored at all** — see `measure.mjs` →
 *   `roomIsProven`. Not a drop and not a refusal: the opening is unproven, which is a different
 *   finding from an opening that was measured and found closed.
 * @property {Distribution} bundledTx        Create-slot transactions carrying 2+ wallets, over
 *   **every launch handed in**, refused ones included. The zeros are the whole point: this and
 *   `maxWalletsInOneTx` are the only observable that exposes the unproven condition, so a saved run
 *   can be audited for it after the fact.
 * @property {Distribution} maxWalletsInOneTx Largest wallet count in one create-slot transaction,
 *   over every launch handed in.
 * @property {number} launchesWithNoOutsider Launches whose create slot the operation took entirely.
 * @property {Distribution} roomLeft         Across scored launches.
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
 * @property {Distribution} entryCostPerSolStaked  The same, per SOL of seat.
 * @property {Distribution} entryTxFeeSol          The transaction fee half of it — base plus
 *   priority — where the entrant paid it. The observable price of the slot auction.
 * @property {HitRate} entryCostPriced             How much of the field the cost leg priced. `hits`
 *   is entries with a cost, `n` every create-slot entry. This is the coverage the verdict gates on.
 * @property {Distribution} fieldRealisedSolNetOfMeasuredFees  Closed round trips that were priced
 *   across their WHOLE window. Beside the gross figures and never replacing them.
 * @property {Distribution} fieldReturnPerSolNetOfMeasuredFees
 * @property {HitRate} fieldHitRateNetOfMeasuredFees  Share of priced closed round trips above zero.
 * @property {number} fieldClosedRoundTripsPriced  Closed round trips with a complete net figure.
 * @property {number} fieldEntrants          Distinct (wallet, launch) create-slot entries.
 * @property {number} fieldClosedRoundTrips
 * @property {number} fieldOpenPositions     Entries with no complete P&L. Reported, never imputed.
 * @property {number} deployerMismatches     Launches whose first create-slot buyer was not the
 *   candidate wallet. See {@link scoreEntry}.
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
 * ## Launches whose opening is UNPROVEN are not scored at all
 *
 * `measure.mjs` → `roomIsProven` owns the reasoning. A create slot carrying no bundled transaction
 * gives the co-ordination rule nothing to find, which is indistinguishable from there being nothing
 * to find — and the difference is worth ~9.6–10.0 SOL of the operation's own stake booked as
 * outsider capital. Those launches are removed from **both** legs before anything is computed:
 * they contribute no room figure, no field entrant and no round trip. Captain decision 134a.
 *
 * The consequence is deliberate and it is the safe one. A candidate whose proven launches fall
 * below `minLaunchesSampled` scores `entry-unmeasured` — never `entry-open-after-costs`, and never
 * folded in with a refusal. On our own tape, replaying the live recipe at every index, that removes
 * **24 of 24 false-positive windows and leaves none at any bar from 0.1 to 0.8**; it costs 81 of
 * 228 windows, which become unmeasured rather than wrong. Stage 0's rolling replay asserts it.
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
 * @returns {EntryScore}
 */
export function scoreEntry(launches, t, context = {}) {
  // THE PARTITION, and it comes first because nothing below may see the refused half. A launch
  // whose create slot carried no bundled transaction contributes no room figure, no field entrant
  // and no round trip — see the module header and `measure.mjs` → `roomIsProven`.
  const scored = launches.filter((l) => roomIsProven(l.createSlot));
  const roomUnproven = launches.length - scored.length;

  const room = scored.map((l) => l.createSlot.roomLeft);
  const field = scored.flatMap((l) => l.field);
  const closed = field.filter((e) => e.closedInWindow);

  const deployerMismatches =
    context.candidateWallet === undefined
      ? 0
      : scored.filter((l) => l.createSlot.deployer !== context.candidateWallet).length;

  const roomLeft = distribution(room);
  const fieldHitRateGrossOfFees = hitRate(closed, (e) => e.realisedSolGrossOfFees > 0);

  // The cost leg's own populations. `priced` is every create-slot entry the chain could price;
  // `closedPriced` is the subset whose WHOLE window priced, which is the only population that can
  // carry a net P&L. They are counted apart because they fail apart: a run can price every create
  // slot and still be unable to price a single round trip end to end.
  const priced = field.filter((e) => Number.isFinite(e.entryCostSol));
  const closedPriced = closed.filter((e) => Number.isFinite(e.realisedSolNetOfMeasuredFees));
  const entryCostPriced = hitRate(field, (e) => Number.isFinite(e.entryCostSol));
  const entryCostPerSolStaked = distribution(priced.map((e) => e.entryCostPerSolStaked));
  const fieldHitRateNetOfMeasuredFees = hitRate(closedPriced, (e) => e.realisedSolNetOfMeasuredFees > 0);
  const fieldRealisedSolNetOfMeasuredFees = distribution(
    closedPriced.map((e) => e.realisedSolNetOfMeasuredFees),
  );

  /** @type {EntryScore} */
  const score = {
    verdict: 'entry-unmeasured',
    rationale: '',
    launchesSampled: scored.length,
    launchesRoomUnproven: roomUnproven,
    // Over EVERY launch handed in, refused ones included. A distribution taken over the scored half
    // could never contain a zero, and the zeros are exactly what an auditor is looking for.
    bundledTx: distribution(launches.map((l) => l.createSlot.bundledTx)),
    maxWalletsInOneTx: distribution(launches.map((l) => l.createSlot.maxWalletsInOneTx)),
    launchesWithNoOutsider: scored.filter((l) => l.field.length === 0).length,
    roomLeft,
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
    entryTxFeeSol: distribution(priced.map((e) => e.entryTxFeeSol)),
    entryCostPriced,
    fieldRealisedSolNetOfMeasuredFees,
    fieldReturnPerSolNetOfMeasuredFees: distribution(
      closedPriced.map((e) => e.returnPerSolNetOfMeasuredFees),
    ),
    fieldHitRateNetOfMeasuredFees,
    fieldClosedRoundTripsPriced: closedPriced.length,
    fieldEntrants: field.length,
    fieldClosedRoundTrips: closed.length,
    fieldOpenPositions: field.length - closed.length,
    deployerMismatches,
    caveats: [],
  };

  const dropped = context.launchesDropped ?? 0;
  const clockDrops = context.mintTimeDisagreements ?? 0;
  if (roomUnproven > 0) {
    score.caveats.push(
      `${roomUnproven} of ${launches.length} measured launch(es) had NO bundled transaction in the ` +
        `create slot, so the co-ordination rule recovered nothing there and the opening is UNPROVEN ` +
        `rather than open. Those launches are NOT SCORED — not their room, not their field. Scoring ` +
        `them would book the operation's own stake as outsider capital and inflate room, which is ` +
        `the one direction that manufactures an edge (captain decision 134a).`,
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
    // the first fill was measured on our OWN tape, and this lane has never held a vendor key — so
    // whether it holds for strangers is untested, and this count is the test.
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
        `end and have NO complete P&L; they are excluded from the realised figures, never marked`,
    );
  }
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
    score.rationale =
      `only ${scored.length} scoreable launch window(s), below the ${t.minLaunchesSampled} this ` +
      `measurement needs. A distribution over fewer is not a distribution.` +
      (roomUnproven > 0
        ? ` ${roomUnproven} further window(s) were measured but NOT SCORED: their create slot ` +
          `carried no bundled transaction, so the co-ordination rule found nothing and cannot tell ` +
          `an operation that did not bundle from a create slot full of genuine outsiders. That is ` +
          `UNPROVEN, not closed and not open — read it as no answer about this wallet.`
        : '') +
      (dropped > 0 ? ` ${dropped} window(s) were dropped for incomplete coverage.` : '');
    return score;
  }

  if (!(roomLeft.median >= t.minRoomLeft)) {
    score.verdict = 'entry-room-absent';
    score.rationale =
      `median room left ${fmt(roomLeft.median)} over ${scored.length} scored launches is below the ` +
      `${t.minRoomLeft} bar (p25 ${fmt(roomLeft.p25)}, p75 ${fmt(roomLeft.p75)}; ` +
      `${score.roomHitRate.hits}/${score.roomHitRate.n} launches clear it). The deployer and its own ` +
      `wallets take the bottom of their own curve, so there is nothing to enter. Read the captain's ` +
      `way: this launch bot is well configured, and that is bad news for us.`;
    return score;
  }

  if (closed.length < t.minFieldRoundTrips) {
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}), but only ${closed.length} ` +
      `closed round trip(s) across ${scored.length} scored launches — below the ${t.minFieldRoundTrips} a ` +
      `hit rate needs. The field is UNMEASURED, so whether anyone actually takes that room is ` +
      `unknown and must not be assumed from the room figure alone.`;
    return score;
  }

  if (!(fieldHitRateGrossOfFees.rate >= t.minFieldHitRateGross) || !(score.fieldRealisedSolGrossOfFees.median > 0)) {
    score.verdict = 'entry-field-loss-making';
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}), but the field loses money ` +
      `BEFORE costs: ${score.fieldHitRateGrossOfFees.hits}/${score.fieldHitRateGrossOfFees.n} closed ` +
      `round trips positive (${fmt(fieldHitRateGrossOfFees.rate)}), median ` +
      `${fmt(score.fieldRealisedSolGrossOfFees.median)} SOL gross. Fees only make that worse, so this ` +
      `is conclusive: room exists and nobody is converting it. No RPC request was spent pricing it.`;
    return score;
  }

  // ---- THE COST LEG. Everything above was free; nothing below is. ---------------------------
  //
  // Rule 1 of the ruling: unmeasured cost is never a pass. A run that could not price the field has
  // not established that the window is enterable, it has established that it does not know — and
  // the two must not share a verdict. This is terminal for the candidate in this run.
  if (!(entryCostPriced.rate >= t.minPricedFraction)) {
    score.verdict = 'entry-cost-unmeasured';
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}) and the field is not ` +
      `loss-making before costs, but only ${entryCostPriced.hits} of ${entryCostPriced.n} ` +
      `create-slot entries could be priced on-chain (${fmt(entryCostPriced.rate)}, below the ` +
      `${t.minPricedFraction} this reading needs). Under the captain's ruling of 2026-08-02 the fee ` +
      `is part of the entry window, so a room figure with the price of the seat unmeasured beside ` +
      `it is NOT a finding that the window is enterable — it is the absence of one.`;
    return score;
  }

  if (entryCostPerSolStaked.median >= t.maxEntryCostPerSolStaked) {
    score.verdict = 'entry-cost-prohibitive';
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}), but landing in it costs a ` +
      `median ${fmt(entryCostPerSolStaked.median)} SOL per SOL staked (p75 ` +
      `${fmt(entryCostPerSolStaked.p75)}, p90 ${fmt(entryCostPerSolStaked.p90)}), at or above the ` +
      `${t.maxEntryCostPerSolStaked} bar — the price of the seat consumes the opening. ` +
      `${LANDING_TIP_CAVEAT}`;
    return score;
  }

  if (closedPriced.length < t.minFieldRoundTrips) {
    score.verdict = 'entry-cost-unmeasured';
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}) and entry costs a median ` +
      `${fmt(entryCostPerSolStaked.median)} SOL per SOL staked, but only ${closedPriced.length} ` +
      `closed round trip(s) could be priced across their whole window — below the ` +
      `${t.minFieldRoundTrips} an after-cost hit rate needs. What the field actually CLEARED after ` +
      `costs is therefore unmeasured, and an unmeasured after-cost result is not a pass.`;
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
      `cannot see. ${LANDING_TIP_CAVEAT}`;
    return score;
  }

  score.verdict = 'entry-open-after-costs';
  score.rationale =
    `median room left ${fmt(roomLeft.median)} over ${scored.length} scored launches ` +
    `(${score.roomHitRate.hits}/${score.roomHitRate.n} clear the ${t.minRoomLeft} bar); landing ` +
    `costs a median ${fmt(entryCostPerSolStaked.median)} SOL per SOL staked ` +
    `(${fmt(score.entryCostSol.median)} SOL at the median entry, p90 ${fmt(score.entryCostSol.p90)}); ` +
    `and after that cost the field still clears — ${fieldHitRateNetOfMeasuredFees.hits}/` +
    `${fieldHitRateNetOfMeasuredFees.n} priced round trips positive, median ` +
    `${fmt(fieldRealisedSolNetOfMeasuredFees.median)} SOL NET OF MEASURED FEES against ` +
    `${fmt(score.fieldRealisedSolGrossOfFees.median)} gross. ` +
    `NOT a recommendation and NOT a profit claim: ${LANDING_TIP_CAVEAT} Exit feasibility is ` +
    `unmeasured entirely. This means the exit question is worth asking, and nothing more.`;
  return score;
}

/** @param {number} n @returns {string} */
function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(3) : 'n/a';
}
