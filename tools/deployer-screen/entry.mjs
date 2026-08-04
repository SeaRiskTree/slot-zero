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
 * | `too-few-closed-round-trips` | field gate | room was measured on a full sample and clears the bar, and the field around those launches produced fewer than `minFieldRoundTrips` complete round trips. |
 * | `too-little-of-the-field-priced` | cost gate | below `minPricedFraction` of the create-slot field could be priced on-chain — or the cost leg never ran at all. |
 * | `too-few-priced-round-trips` | cost gate | entries priced, but fewer than `minFieldRoundTrips` round trips priced across their WHOLE window, so what the field cleared after costs is unknown. |
 *
 * The first three share one code site and are the aggregate the decision was really about: a
 * candidate silenced because it never had eight launches, one silenced because pump.fun shed our
 * walk, and one silenced by the co-ordination rule are three different states of the world.
 *
 * @typedef {'too-few-windows-available' | 'windows-dropped' | 'too-few-proven-windows'
 *   | 'too-few-closed-round-trips' | 'too-little-of-the-field-priced'
 *   | 'too-few-priced-round-trips'} UnmeasuredCause
 */

/** @type {readonly UnmeasuredCause[]} */
export const UNMEASURED_CAUSES = [
  'too-few-windows-available',
  'windows-dropped',
  'too-few-proven-windows',
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
 * 174b, revised). All six producers describe us, so a later stage may filter ONLY on the four
 * MEASURED verdicts — `entry-open-after-costs`, `entry-room-absent`, `entry-cost-prohibitive`,
 * `entry-field-loss-making` — and must carry EVERY unmeasured outcome forward as no answer. The
 * field, the type and this table stay: a future producer CAN be deployer-attributable, and it has to
 * come here on purpose to become one.
 *
 * `too-few-closed-round-trips` was the one row attributed to the deployer, on the ground that
 * closure is read inside the pinned `windowMs` and that is the same window for every candidate. It
 * is not: `pumpfun.mjs` → `readLaunchWindow` seeks in MILLISECONDS (65,000) and decides membership
 * in SLOTS (160), so at 2026-07 slot drift 160 slots reach up to 70.6 s and the window's tail is
 * never fetched. The truncated fills are disproportionately late SELLS — 354 in-window fills, 161 of
 * them sells, across 102 launches — and dropping one flips a wallet from closed to open. So
 * `closed.length` is partly a function of WHEN a candidate's launches happened, which is a
 * time-varying limit of ours; `thresholds.json` → `stage2_entry.windowSlotSpan` already states that
 * a too-narrow span silently changes gate outcomes at `minFieldRoundTrips`. The honest note beside
 * it: that defect moved our own create-slot series by nothing to seven significant figures, because
 * create-slot outsiders close early — but that is n = 1 deployer on our own tape and establishes no
 * bound for a stranger, which is exactly why the conservative attribution is the captain's call.
 *
 * @type {Readonly<Record<UnmeasuredCause, 'our-coverage' | 'deployer'>>}
 */
export const UNMEASURED_CAUSE_ATTRIBUTION = Object.freeze({
  'too-few-windows-available': 'our-coverage',
  'windows-dropped': 'our-coverage',
  'too-few-proven-windows': 'our-coverage',
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
 * and nothing else, because {@link UNMEASURED_CAUSE_ATTRIBUTION} attributes all six producers to our
 * own coverage. `false` when it is a statement about our own coverage, which a consumer must carry
 * forward as *no answer* rather than drop.
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
 *   schema-≤9 one: a schema-≤9 record's room reading was taken with these wallets counted as
 *   outsiders.
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
 * The consequence is deliberate and it is the safe one. A candidate whose proven launches fall
 * below `minLaunchesSampled` scores `entry-unmeasured` — never `entry-open-after-costs`, and never
 * folded in with a refusal. **It is `too-few-proven-windows` specifically**, and it is
 * `our-coverage`: the score says so on its own face rather than leaving a consumer to infer it from
 * `launchesRoomUnproven`. See {@link UNMEASURED_CAUSE_ATTRIBUTION} and
 * {@link isDeployerAttributable} — a later stage may not drop a candidate on this.
 * On our own tape, replaying the live recipe at every index, that removes
 * **24 of 24 false-positive windows and leaves none at any bar from 0.1 to 0.8**.
 *
 * **What it costs is what captain decision 182a bought back.** Under the shared-transaction rule
 * alone the refusal cost 81 of 228 rolling windows, which became unmeasured rather than wrong;
 * under the UNION rule it costs **0 of 228**, with false positives still 0. The refusal is
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
 * @returns {EntryScore}
 */
export function scoreEntry(launches, t, context = {}) {
  // THE PARTITION, and it comes first because nothing below may see the refused half. A launch the
  // co-ordination rule marked nothing in contributes no room figure, no field entrant and no round
  // trip — see the module header and `measure.mjs` → `roomIsProven`.
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
    // Room was read on a full sample and clears the bar, so outsiders did reach these create slots
    // — and then too few of them completed a round trip to build a hit rate from. This reads like a
    // fact about the deployer and is NOT one: `readLaunchWindow` reaches 65,000 ms but counts 160
    // slots, so the window's tail goes unfetched by an amount that varies with slot drift, and the
    // fills it loses are disproportionately late SELLS — each one flipping a wallet from closed to
    // open. `our-coverage`, per {@link UNMEASURED_CAUSE_ATTRIBUTION}.
    attributeUnmeasured(score, ['too-few-closed-round-trips']);
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
      `it is NOT a finding that the window is enterable — it is the absence of one.`;
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
      `the price of the seat consumes the opening. ${LANDING_TIP_CAVEAT}`;
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
    `costs a median ${fmt(entryCostPerSolStakedByLaunch.median)} SOL per SOL staked per launch ` +
    `(${fmt(entryCostPerSolStaked.median)} pooled over entries, ` +
    `${fmt(score.entryCostSol.median)} SOL at the median entry, p90 ${fmt(score.entryCostSol.p90)}); ` +
    `and after that cost the field still clears — ${fieldHitRateNetOfMeasuredFees.hits}/` +
    `${fieldHitRateNetOfMeasuredFees.n} priced round trips positive, median ` +
    `${fmt(fieldRealisedSolNetOfMeasuredFees.median)} SOL NET OF MEASURED FEES against ` +
    `${fmt(score.fieldRealisedSolGrossOfFees.median)} gross. ` +
    `NOT a recommendation and NOT a profit claim: ${LANDING_TIP_CAVEAT} Exit feasibility is ` +
    `unmeasured entirely. This means the exit question is worth asking, and nothing more.`;
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
