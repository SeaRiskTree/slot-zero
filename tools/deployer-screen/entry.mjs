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
 * ## Everything here is GROSS OF FEES, and that is load-bearing
 *
 * The fill tape carries swap-quote SOL. It does not carry the priority fee, the landing tip, the
 * venue fee or rent, and only `onchain_*.csv` in the committed dataset is fee-inclusive. So every
 * P&L this module produces is an **upper bound** on what a wallet actually took, and every such
 * field is named `…GrossOfFees` so a caller cannot forget. The size of the gap is measured, not
 * feared: on our subject's post-2026-06-04 launches the field reads **76.5% of closed round trips
 * positive with a median +0.12 SOL gross**, while the fee-inclusive truth over the same launches is
 * **+0.54 SOL per launch shared across 106 wallets, 51 of them negative**
 * (`slot-zero-june-regime-change/report.md` §6.5). Read naively, gross says the field is winnable.
 * It is not.
 *
 * That is exactly why the field is a **necessary condition and never a sufficient one**: a field
 * that loses money before costs certainly loses money after them, but a field that makes money
 * before costs has established nothing. {@link scoreEntry} is wired that way, and Stage 0 asserts
 * the consequence on the one wallet where we hold the answer.
 */

import { createSlotGroups, median, percentile, tallyCreateSlot } from './measure.mjs';

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
 */

/**
 * @typedef {object} LaunchEntry
 * @property {import('./measure.mjs').CreateSlotMeasurement} createSlot
 * @property {FieldEntrant[]} field  Every competing wallet in the create slot. May be empty, which
 *   is itself a finding: nine of our subject's 89 post-break launches had no outsider at all.
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
    });
  }
  field.sort((a, b) => a.queuePosition - b.queuePosition);

  return { createSlot, field };
}

/**
 * The complete Stage 2 verdict vocabulary. **Every value is about ENTRY only.**
 *
 * Note what is absent: nothing here says a deployer is beatable, profitable, or worth trading.
 * `entry-room-present` is the strongest thing this stage can say and it means one thing — the
 * opening window is not already closed, so the exit question is worth asking. Whether it is
 * *escapable* is Stage 3's, and whether it is *profitable* is nobody's until both have landed and
 * a fee-inclusive pass has been run.
 *
 * @typedef {'entry-room-present' | 'entry-room-absent' | 'entry-field-loss-making' | 'entry-unmeasured'} EntryVerdict
 */

/** @type {readonly EntryVerdict[]} */
export const ENTRY_VERDICTS = [
  'entry-room-present',
  'entry-room-absent',
  'entry-field-loss-making',
  'entry-unmeasured',
];

/**
 * @typedef {object} EntryThresholds
 * @property {number} minRoomLeft            Median room a launch set must leave.
 * @property {number} minLaunchesSampled     Launches below which no distribution is reported.
 * @property {number} minFieldRoundTrips     Closed round trips below which the hit rate is noise.
 * @property {number} minFieldHitRateGross   Necessary-condition floor on the gross hit rate.
 */

/**
 * @typedef {object} EntryScore
 * @property {EntryVerdict} verdict
 * @property {string} rationale
 * @property {number} launchesSampled
 * @property {number} launchesWithNoOutsider Launches whose create slot the operation took entirely.
 * @property {Distribution} roomLeft         Across launches.
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
 * Two legs, and they are **not** symmetric:
 *
 * - **Room is the gate.** It is measured from capital that provably entered the curve, it does not
 *   depend on fees, and it is the quantity the 2026-06-04 finding turned on. A median below
 *   `minRoomLeft` ends the enquiry.
 * - **The field is a veto, never a pass.** It is gross of fees and therefore an upper bound, so a
 *   loss-making field is conclusive and a profitable-looking one establishes nothing at all. It can
 *   only ever take a verdict away.
 *
 * The asymmetry is not caution for its own sake. Our own subject deployer's post-break field reads
 * **76.5% of closed round trips positive** on this exact measurement, while the fee-inclusive record
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
 * overstated and the room understated, which makes `entry-room-present` harder to earn rather than
 * easier. A count that is not small is a caveat on the whole sample.
 *
 * @param {readonly LaunchEntry[]} launches
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
  const room = launches.map((l) => l.createSlot.roomLeft);
  const field = launches.flatMap((l) => l.field);
  const closed = field.filter((e) => e.closedInWindow);

  const deployerMismatches =
    context.candidateWallet === undefined
      ? 0
      : launches.filter((l) => l.createSlot.deployer !== context.candidateWallet).length;

  const roomLeft = distribution(room);
  const fieldHitRateGrossOfFees = hitRate(closed, (e) => e.realisedSolGrossOfFees > 0);

  /** @type {EntryScore} */
  const score = {
    verdict: 'entry-unmeasured',
    rationale: '',
    launchesSampled: launches.length,
    launchesWithNoOutsider: launches.filter((l) => l.field.length === 0).length,
    roomLeft,
    roomHitRate: hitRate(room, (v) => v >= t.minRoomLeft),
    operationShare: distribution(launches.map((l) => l.createSlot.operationShare)),
    devSol: distribution(launches.map((l) => l.createSlot.devSol)),
    coordinatedSol: distribution(launches.map((l) => l.createSlot.coordinatedSol)),
    outsidersPerLaunch: distribution(launches.map((l) => l.field.length)),
    fieldFillSol: distribution(field.map((e) => e.createSlotFillSol)),
    fieldSolQueuedAhead: distribution(field.map((e) => e.solQueuedAheadSol)),
    fieldRealisedSolGrossOfFees: distribution(closed.map((e) => e.realisedSolGrossOfFees)),
    fieldReturnPerSolGrossOfFees: distribution(closed.map((e) => e.returnPerSolGrossOfFees)),
    fieldHitRateGrossOfFees,
    fieldEntrants: field.length,
    fieldClosedRoundTrips: closed.length,
    fieldOpenPositions: field.length - closed.length,
    deployerMismatches,
    caveats: [],
  };

  const dropped = context.launchesDropped ?? 0;
  const clockDrops = context.mintTimeDisagreements ?? 0;
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
      `${deployerMismatches} of ${launches.length} launch(es) had a first create-slot buyer other ` +
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
    'Every P&L above is GROSS OF FEES and is therefore an UPPER BOUND. Priority fees, landing tips, ' +
      'the venue fee and rent are all absent from the fill tape.',
  );
  score.caveats.push(
    'ENTRY ONLY. Exit feasibility — when the dev sells, whether its trigger is a size our own buy ' +
      'would count towards, and whether an outsider could have left first — is NOT scored here.',
  );

  if (launches.length < t.minLaunchesSampled) {
    score.rationale =
      `only ${launches.length} usable launch window(s), below the ${t.minLaunchesSampled} this ` +
      `measurement needs. A distribution over fewer is not a distribution.` +
      (dropped > 0 ? ` ${dropped} window(s) were dropped for incomplete coverage.` : '');
    return score;
  }

  if (!(roomLeft.median >= t.minRoomLeft)) {
    score.verdict = 'entry-room-absent';
    score.rationale =
      `median room left ${fmt(roomLeft.median)} over ${launches.length} launches is below the ` +
      `${t.minRoomLeft} bar (p25 ${fmt(roomLeft.p25)}, p75 ${fmt(roomLeft.p75)}; ` +
      `${score.roomHitRate.hits}/${score.roomHitRate.n} launches clear it). The deployer and its own ` +
      `wallets take the bottom of their own curve, so there is nothing to enter. Read the captain's ` +
      `way: this launch bot is well configured, and that is bad news for us.`;
    return score;
  }

  if (closed.length < t.minFieldRoundTrips) {
    score.rationale =
      `the opening window leaves room (median ${fmt(roomLeft.median)}), but only ${closed.length} ` +
      `closed round trip(s) across ${launches.length} launches — below the ${t.minFieldRoundTrips} a ` +
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
      `is conclusive: room exists and nobody is converting it.`;
    return score;
  }

  score.verdict = 'entry-room-present';
  score.rationale =
    `median room left ${fmt(roomLeft.median)} over ${launches.length} launches ` +
    `(${score.roomHitRate.hits}/${score.roomHitRate.n} clear the ${t.minRoomLeft} bar), and the field ` +
    `is not already loss-making before costs: ${fieldHitRateGrossOfFees.hits}/` +
    `${fieldHitRateGrossOfFees.n} closed round trips positive, median ` +
    `${fmt(score.fieldRealisedSolGrossOfFees.median)} SOL GROSS. ` +
    `NOT a recommendation and NOT a profit claim: gross is an upper bound, the fee-inclusive figure ` +
    `is unmeasured here, and exit feasibility is unmeasured entirely. This means the exit question ` +
    `is worth asking, and nothing more.`;
  return score;
}

/** @param {number} n @returns {string} */
function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(3) : 'n/a';
}
