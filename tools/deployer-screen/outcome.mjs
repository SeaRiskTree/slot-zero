/**
 * What actually happened — the GRADING half of the screen's feedback loop.
 *
 * `prediction.mjs` turns a Stage 2 finding into a falsifiable claim. This module scores those claims
 * against launches the deployer made AFTER the claim, keeps the running ledger, and computes the
 * screen's own hit rate. Everything here is arithmetic and bookkeeping: it opens no socket, reads no
 * credential and holds no threshold of its own. `grade.mjs` is the runner that does the I/O.
 *
 * ## What "what actually happened" means, and why it is a re-measurement
 *
 * This repo does not trade, so there is no P&L ledger to score a call against. The only available
 * ground truth is the same instrument, pointed at launches the prediction did not see: run the
 * SCREEN'S OWN Stage 2 recipe over the deployer's post-prediction launches and compare the verdict
 * it reaches with the verdict the screen predicted it would reach.
 *
 * That makes the grade a genuine out-of-sample test of the screen's central claim — *this deployer's
 * windows are (not) enterable after costs* — rather than a restatement of it. Three properties keep
 * it honest, and all three are structural rather than remembered:
 *
 * 1. **Strictly out of sample.** Only launches created after the prediction's `madeAtIso` are
 *    measured, and `prediction.mjs` explains why that boundary is a proof rather than a convention.
 *    `grade.mjs` applies the filter; {@link OUTCOME_READING} names it on every row this writes.
 * 2. **Same recipe, same bars.** The outcome is scored by `entry.mjs` → `scoreEntry` at the
 *    `stage2_entry` / `stage2_cost` values the PREDICTING run recorded, not at today's. A prediction
 *    graded against bars it never saw is not graded; it is compared to a different screen.
 * 3. **An unmeasured outcome grades NOTHING.** Captain decision 174b applies on this side too: if
 *    the outcome walk reaches an unmeasured verdict, that is a fact about our coverage, so the row
 *    stays `ungraded` and stays OUT of the hit rate's denominator. Counting it as a miss would
 *    make the screen look worse the flakier pump.fun's endpoint was that day; counting it as a hit
 *    would be worse still.
 *
 * ## Idempotence, stated as the property it has to have
 *
 * Re-running the grader must produce the same ledger and the same hit rate, and must not re-spend.
 * Three rules give that:
 *
 * - every grade has one identity, {@link gradeKeyOf} — `(source record, wallet, subject)`. A wallet
 *   predicted by two runs is TWO claims, because they are two distinct falsifiable statements made
 *   at two instants;
 * - a **terminal** state (`hit` / `miss`) is latched. {@link mergeGrades} will not overwrite one,
 *   and {@link dueForMeasurement} never re-offers it, so a graded claim is never re-measured and
 *   never silently revised;
 * - an `ungraded` row is retried only after {@link GradeBounds.retryAfterMs}. So a rerun the same
 *   day costs nothing at all, while the loop still converges on its own without a flag.
 *
 * A ledger written twice from the same inputs is byte-identical: rows are keyed and emitted in
 * sorted key order.
 */

import { ARMS_ARE_NEVER_POOLED } from './admission.mjs';
import { hitRate } from './entry.mjs';
import { entryPredictionClaim } from './prediction.mjs';

/**
 * Version of the grade ledger on disk.
 *
 * Same contract as the run record's: **bump, never retro-edit**. A graded claim is evidence about
 * the screen's own accuracy, and a lane that rewrote its own past grades would be marking its own
 * homework twice.
 *
 * **2** adds `admissionArm` to every grade row and splits {@link summariseGrades} by it — captain
 * decisions 451 and 480a. A version rather than a silent field because the hit rate itself changed
 * shape: a version-1 ledger's rows carry no arm, so a reader holding one has nothing in the document
 * that says whether the rate beside it was over one population or two.
 */
export const GRADE_LEDGER_VERSION = 2;

/**
 * The reading every outcome figure in this ledger is taken on, carried on the row rather than only
 * in a doc.
 *
 * The gate's `completionRate` and the feed's differ by up to 0.69 on the same wallet because they
 * are two readings of one name; this lane must not add a third such pair. So: an outcome verdict
 * here is Stage 2's, over post-prediction launches only, at the predicting run's own bars.
 */
export const OUTCOME_READING =
  'STAGE 2 ENTRY re-measured OUT OF SAMPLE: pump.fun swap-api fills for launches this deployer ' +
  'created STRICTLY AFTER the prediction`s `madeAtIso`, offered by the MadeOnSol profile, scored by ' +
  '`entry.mjs` -> `scoreEntry` at the `stage2_entry`/`stage2_cost` bars the PREDICTING run ' +
  'recorded — never at today`s. It is NOT the gate reading and NOT the vendor`s own aggregate.';

/** The sentence that keeps a hit rate over a handful of claims from being quoted as a rate. */
export const HIT_RATE_CAVEAT =
  'A HIT RATE IS ONLY AS GOOD AS ITS `n`, WHICH IS PRINTED BESIDE IT AND MUST TRAVEL WITH IT. ' +
  'Ungraded claims are EXCLUDED from the denominator, not counted against the screen: every reason ' +
  'a claim goes ungraded is a fact about our own coverage (captain decision 174b), and folding ' +
  'those into the rate would make the screen score worse the flakier the endpoint was that day. ' +
  'The ungraded tally is published beside the rate for exactly that reason — read them together.';

/**
 * @typedef {'hit' | 'miss' | 'ungraded'} GradeState
 */

/**
 * The reasons that reach no provider and inspect nothing, so they are not attempts and must not
 * stamp the retry clock. Named once because {@link gradeOne} and {@link dueForMeasurement} have to
 * agree on it: a reason counted as an attempt here would push the retry window forward on a row
 * nobody looked at and stall the loop rather than pace it.
 *
 * @type {ReadonlySet<string>}
 */
export const SCHEDULING_REFUSALS = new Set(['too-soon', 'awaiting-retry', 'not-attempted']);

/**
 * Why a claim could not be scored. **Every one of these is our own coverage** — none is a finding
 * about the deployer, and none may be read as a failed prediction.
 *
 * Two of them are scheduling refusals and they are kept APART on purpose: `awaiting-retry` is a
 * claim cooling off after an attempt, `not-attempted` is this run's per-run cap. Folding them
 * together reports a cap that bound nothing, which is the same conflation this lane refuses between
 * `not-scored` and `entry-unmeasured`, one level down.
 *
 * @typedef {'too-soon' | 'awaiting-retry' | 'not-attempted' | 'no-post-prediction-launches'
 *   | 'outcome-unmeasured' | 'profile-unreadable' | 'recipe-unusable'} UngradedReason
 */

/** @type {Readonly<Record<UngradedReason, string>>} */
export const UNGRADED_REASONS = Object.freeze({
  'too-soon':
    'not enough time has passed since the claim for this deployer to have produced a scoreable ' +
    'number of post-prediction launches. Nothing was spent on it; a later run reaches it.',
  'awaiting-retry':
    'this claim was attempted before and is still inside its retry window, so it was left alone to ' +
    'cool off. NO cap bound this run on its account — every ungraded reason is fixed by the ' +
    'deployer launching again, which takes days, so asking again the same afternoon would spend the ' +
    'walk budget to learn the same thing.',
  'not-attempted':
    'this run`s per-run measurement cap, and ONLY that cap, was reached before this claim`s turn. A ' +
    'bound of ours, not a property of the claim — the oldest waiting claims are taken first, so a ' +
    'later run reaches it.',
  'no-post-prediction-launches':
    'the vendor profile offered no launch created after the claim`s boundary, so there is nothing ' +
    'out of sample to measure yet. This is NOT evidence the deployer stopped launching: the ' +
    'profile is a 70-record page and this reading is bounded by it.',
  'outcome-unmeasured':
    'the out-of-sample walk ran and reached an UNMEASURED verdict. Captain decision 174b: every ' +
    'unmeasured cause is a fact about our coverage, so this scores nothing and stays out of the ' +
    'hit rate`s denominator. It is not a miss.',
  'profile-unreadable':
    'the deployer`s vendor profile could not be read, so the out-of-sample launches could not even ' +
    'be listed. Nothing about the claim is established either way.',
  'recipe-unusable':
    'the predicting run`s own `stage2_entry`/`stage2_cost` bars could not be applied by this build, ' +
    'so the outcome could not be measured at the bars the claim was made under. Substituting ' +
    'today`s would grade the claim against a screen it never was.',
});

/**
 * One grade's identity.
 *
 * `(source, wallet, subject)` and not `(wallet, subject)`: the same wallet predicted by two runs is
 * two claims, made at two instants over two samples, and each is separately right or wrong. Merging
 * them would let a later run's claim silently overwrite an earlier one's grade — which is how a
 * screen ends up scoring only its most recent opinion.
 *
 * @param {{ source: string, wallet: string, subject: string }} p
 * @returns {string}
 */
export function gradeKeyOf(p) {
  return `${p.source}|${p.wallet}|${p.subject}`;
}

/**
 * @typedef {object} GradeBounds
 * @property {number} minOutcomeAgeMs How old a claim must be before the outcome is worth measuring.
 * @property {number} retryAfterMs     How long an `ungraded` row waits before it is offered again.
 * @property {number} maxClaimsPerRun  How many outcomes one run may measure.
 */

/**
 * @typedef {object} OutcomeMeasurement
 * What the out-of-sample walk found. Every count is OURS; no vendor per-token row survives here, the
 * same containment `stage2.mjs` → `toEntryRecordRow` applies.
 *
 * @property {string} verdict                  The Stage 2 verdict over post-prediction launches.
 * @property {string | null} unmeasuredCause
 * @property {number} launchesOffered          Launch refs the profile offered at all.
 * @property {number} launchesAfterBoundary    …of which were created after the claim's boundary.
 * @property {number} launchesScored           …of which Stage 2 actually scored.
 * @property {number} launchesDropped
 * @property {number | null} roomLeftMedian
 * @property {boolean} coverageProvenBackToBoundary Whether the profile page reached BACK past the
 *   boundary. `false` means the page is full of post-boundary launches and older ones may exist
 *   behind it — the sample is then the NEWEST post-prediction launches rather than all of them.
 *   That does not make the grade in-sample; it bounds what the outcome saw, and it is recorded
 *   because a page cap is exactly the kind of limit that reads as a measurement when unstated.
 * @property {number} keylessRequests
 * @property {number} rpcRequests
 */

/**
 * @typedef {object} GradeRow
 * @property {string} source
 * @property {string} wallet
 * @property {string} subject
 * @property {string} predictedClaim
 * @property {string} predictedVerdict
 * @property {string} madeAtIso
 * @property {string} gateReading      Which history the GATE read when the claim was made.
 * @property {'gate' | 'sub-gate'} admissionArm WHICH ARM admitted the candidate this claim is about
 *   — captain decisions 451 and 480a. The hit rate is reported per arm and never pooled, because
 *   the two are two populations with two denominators.
 * @property {string} outcomeReading   {@link OUTCOME_READING}.
 * @property {string | number | null} thresholdsVersion
 * @property {GradeState} state
 * @property {string | null} outcomeClaim
 * @property {string | null} outcomeVerdict
 * @property {UngradedReason | null} ungradedReason
 * @property {string | null} ungradedDetail
 * @property {OutcomeMeasurement | null} outcome
 * @property {number} attempts
 * @property {string} firstSeenIso
 * @property {string | null} lastAttemptIso
 * @property {string | null} gradedAtIso
 */

/**
 * Score one claim against one outcome measurement.
 *
 * The comparison is between two CLAIMS, not two verdicts: `entry-room-absent` and
 * `entry-cost-prohibitive` are different verdicts and the same prediction, so a screen that said
 * "not beatable" for one reason and was right for another is right. Grading verdict-against-verdict
 * would score the screen on a question it never asked.
 *
 * @param {import('./prediction.mjs').ExtractedPrediction} prediction
 * @param {OutcomeMeasurement | null} outcome `null` when no measurement was taken.
 * @param {{ reason: UngradedReason, detail?: string | null } | null} refusal Why there is no
 *   outcome, when there is none. Exactly one of `outcome` / `refusal` is expected.
 * @param {string} nowIso
 * @param {GradeRow | null} [existing]
 * @returns {GradeRow}
 */
export function gradeOne(prediction, outcome, refusal, nowIso, existing = null) {
  // Whether this run actually LOOKED at the claim. The three scheduling refusals reach no provider
  // and inspect nothing, so they are not attempts; everything else either spent a request or tried
  // to.
  const looked = outcome !== null || !SCHEDULING_REFUSALS.has(refusal?.reason ?? '');
  /** @type {GradeRow} */
  const base = {
    source: prediction.source,
    wallet: prediction.wallet,
    subject: prediction.subject,
    predictedClaim: prediction.claim,
    predictedVerdict: prediction.verdict,
    madeAtIso: prediction.madeAtIso,
    gateReading: prediction.gateReading,
    admissionArm: prediction.admissionArm === 'sub-gate' ? 'sub-gate' : 'gate',
    outcomeReading: OUTCOME_READING,
    thresholdsVersion: prediction.thresholdsVersion,
    state: 'ungraded',
    outcomeClaim: null,
    outcomeVerdict: null,
    ungradedReason: null,
    ungradedDetail: null,
    outcome: null,
    // `too-soon` and `not-attempted` cost nothing and are NOT attempts, on either counter. Stamping
    // them would push the retry window forward on a row nobody looked at, which stalls the loop
    // rather than pacing it — and an `attempts` count that rose without a request would make a
    // never-measured claim read like a repeatedly-failed one.
    attempts: (existing?.attempts ?? 0) + (looked ? 1 : 0),
    firstSeenIso: existing?.firstSeenIso ?? nowIso,
    lastAttemptIso: looked ? nowIso : (existing?.lastAttemptIso ?? null),
    gradedAtIso: null,
  };

  if (outcome === null) {
    const reason = refusal?.reason ?? 'not-attempted';
    return {
      ...base,
      ungradedReason: reason,
      ungradedDetail: refusal?.detail ?? UNGRADED_REASONS[reason],
    };
  }

  const read = entryPredictionClaim({ verdict: outcome.verdict, unmeasuredCause: outcome.unmeasuredCause });
  if (read.claim === null) {
    // The walk ran and could not answer. OUR coverage, so it scores nothing — see the module header.
    return {
      ...base,
      outcomeVerdict: outcome.verdict,
      outcome,
      ungradedReason: 'outcome-unmeasured',
      ungradedDetail:
        `${UNGRADED_REASONS['outcome-unmeasured']} Verdict ${outcome.verdict}` +
        `${outcome.unmeasuredCause === null ? '' : `, cause ${outcome.unmeasuredCause}`}.`,
    };
  }

  return {
    ...base,
    state: read.claim === prediction.claim ? 'hit' : 'miss',
    outcomeClaim: read.claim,
    outcomeVerdict: outcome.verdict,
    outcome,
    gradedAtIso: nowIso,
  };
}

/** @returns {{ tool: string, schemaVersion: number, updatedAtIso: string | null, grades: Record<string, GradeRow> }} */
export function emptyGradeLedger() {
  return { tool: 'deployer-screen-grade', schemaVersion: GRADE_LEDGER_VERSION, updatedAtIso: null, grades: {} };
}

/**
 * Fold freshly-computed rows into the ledger, **without ever revising a terminal grade**.
 *
 * A `hit` or a `miss` is evidence about the screen's accuracy, and this lane may not rewrite it —
 * not on a rerun, not when a later measurement disagrees. So a terminal row wins over anything
 * offered for the same key, and the count of such collisions is returned rather than swallowed: a
 * grader that started re-measuring settled claims would otherwise be invisible.
 *
 * @param {ReturnType<typeof emptyGradeLedger>} ledger
 * @param {readonly GradeRow[]} rows
 * @param {string} nowIso
 * @returns {{ ledger: ReturnType<typeof emptyGradeLedger>, added: number, updated: number, latched: number }}
 */
export function mergeGrades(ledger, rows, nowIso) {
  /** @type {Record<string, GradeRow>} */
  const grades = { ...ledger.grades };
  let added = 0;
  let updated = 0;
  let latched = 0;
  for (const row of rows) {
    const key = gradeKeyOf(row);
    const existing = grades[key];
    if (existing === undefined) {
      grades[key] = row;
      added += 1;
      continue;
    }
    if (existing.state === 'hit' || existing.state === 'miss') {
      latched += 1;
      continue;
    }
    grades[key] = row;
    updated += 1;
  }
  // Sorted on the way out so two runs over the same inputs write the same bytes.
  /** @type {Record<string, GradeRow>} */
  const sorted = {};
  for (const key of Object.keys(grades).sort()) sorted[key] = /** @type {GradeRow} */ (grades[key]);
  return {
    ledger: { ...ledger, schemaVersion: GRADE_LEDGER_VERSION, updatedAtIso: nowIso, grades: sorted },
    added,
    updated,
    latched,
  };
}

/**
 * Decide which claims this run should MEASURE, and why the rest are being left alone.
 *
 * Returns everything, partitioned, rather than only the worklist: a claim skipped for a bound of
 * ours has to be visible, because an invisible cap reads as "there was nothing to do".
 *
 * Ordering is **oldest claim first**, tie-broken by key, so the backlog drains deterministically and
 * two runs over the same ledger pick the same work.
 *
 * @param {readonly import('./prediction.mjs').ExtractedPrediction[]} predictions
 * @param {ReturnType<typeof emptyGradeLedger>} ledger
 * @param {number} nowMs
 * @param {GradeBounds} bounds
 * @returns {{ due: import('./prediction.mjs').ExtractedPrediction[],
 *   skipped: { prediction: import('./prediction.mjs').ExtractedPrediction, reason: UngradedReason }[],
 *   settled: number }}
 */
export function dueForMeasurement(predictions, ledger, nowMs, bounds) {
  /** @type {import('./prediction.mjs').ExtractedPrediction[]} */
  const ready = [];
  /** @type {{ prediction: import('./prediction.mjs').ExtractedPrediction, reason: UngradedReason }[]} */
  const skipped = [];
  let settled = 0;

  const ordered = [...predictions].sort(
    (a, b) => a.outOfSampleAfterMs - b.outOfSampleAfterMs || (gradeKeyOf(a) < gradeKeyOf(b) ? -1 : 1),
  );

  for (const p of ordered) {
    const existing = ledger.grades[gradeKeyOf(p)];
    if (existing !== undefined && (existing.state === 'hit' || existing.state === 'miss')) {
      settled += 1;
      continue;
    }
    if (nowMs - p.outOfSampleAfterMs < bounds.minOutcomeAgeMs) {
      skipped.push({ prediction: p, reason: 'too-soon' });
      continue;
    }
    // An ungraded row waits out its retry window. Every ungraded reason is fixed by the deployer
    // making more launches, which takes days — so asking again the same afternoon spends the walk
    // budget to learn the same thing.
    const lastAttempt = existing?.lastAttemptIso == null ? null : Date.parse(existing.lastAttemptIso);
    if (lastAttempt !== null && Number.isFinite(lastAttempt) && nowMs - lastAttempt < bounds.retryAfterMs) {
      skipped.push({ prediction: p, reason: 'awaiting-retry' });
      continue;
    }
    ready.push(p);
  }

  const due = ready.slice(0, bounds.maxClaimsPerRun);
  for (const p of ready.slice(bounds.maxClaimsPerRun)) skipped.push({ prediction: p, reason: 'not-attempted' });
  return { due, skipped, settled };
}

/**
 * The screen's own hit rate, with its denominator and everything excluded from it.
 *
 * Reported as a hit rate with its `n` and never as a bare percentage — the same standing bar this
 * tool applies to sniper outcomes, for the same reason: a rate whose sample size is not beside it
 * cannot be read. `entry.mjs` → `hitRate` is reused rather than re-implemented so "what a hit rate
 * is" has one definition in this tool, including its `NaN`-not-zero rule for an empty sample.
 *
 * **EVERY RATE IS PER ADMISSION ARM AND THERE IS NO POOLED ONE — captain decision 480a.** Since
 * captain decision 451 a claim can be about a candidate the competence gate REFUSED and the second
 * arm admitted, and those are two populations with two denominators
 * (`admission.mjs` → `ARMS_ARE_NEVER_POOLED`). A single `overall` across them would be a rate with
 * no denominator, and it would hide the thing this split exists to show: the second arm was opened
 * because the gate arm has produced zero after-cost passes, so a pooled rate would let one arm's
 * accuracy stand in for the other's. A grade row carrying no arm — a version-1 ledger's — is the
 * GATE arm's, exactly: nothing before record schema 26 could admit through the second.
 *
 * `claims` / `graded` / `ungraded` / `ungradedByReason` stay whole-ledger bookkeeping, and they are
 * not arm statistics: they count rows and the reasons rows went ungraded, never a success rate.
 *
 * @param {ReturnType<typeof emptyGradeLedger>} ledger
 * @returns {object}
 */
export function summariseGrades(ledger) {
  const rows = Object.values(ledger.grades);
  const graded = rows.filter((r) => r.state === 'hit' || r.state === 'miss');
  /** @type {Record<string, number>} */
  const ungradedByReason = {};
  for (const r of rows) {
    if (r.state !== 'ungraded') continue;
    const key = r.ungradedReason ?? 'not-attempted';
    ungradedByReason[key] = (ungradedByReason[key] ?? 0) + 1;
  }
  /** @param {readonly GradeRow[]} sample */
  const rate = (sample) => {
    const h = hitRate(sample, (r) => r.state === 'hit');
    return { n: h.n, hits: h.hits, rate: Number.isFinite(h.rate) ? Number(h.rate.toFixed(4)) : null };
  };
  /** @param {'gate' | 'sub-gate'} arm */
  const forArm = (arm) => {
    const sample = graded.filter((r) => (r.admissionArm === 'sub-gate' ? 'sub-gate' : 'gate') === arm);
    return {
      graded: sample.length,
      overall: rate(sample),
      // Broken out by what was CLAIMED, because the two are different questions and a pooled rate
      // can hide that the screen is right about one and wrong about the other. A screen that says
      // "not beatable" about everything scores well on a population of unbeatable deployers while
      // being useless, and only the split shows it. INSIDE the arm, so the two splits compose
      // rather than one undoing the other.
      byClaim: {
        beatable: rate(sample.filter((r) => r.predictedClaim === 'beatable')),
        'not-beatable': rate(sample.filter((r) => r.predictedClaim === 'not-beatable')),
      },
    };
  };
  return {
    schemaVersion: GRADE_LEDGER_VERSION,
    reading: OUTCOME_READING,
    claims: rows.length,
    graded: graded.length,
    ungraded: rows.length - graded.length,
    ungradedByReason,
    byArm: { gate: forArm('gate'), 'sub-gate': forArm('sub-gate') },
    armsAreNeverPooled: ARMS_ARE_NEVER_POOLED,
    caveat: HIT_RATE_CAVEAT,
  };
}
