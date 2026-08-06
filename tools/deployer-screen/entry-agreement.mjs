/**
 * THE PER-CANDIDATE AGREEMENT COMPARISON — Gate 3 precondition 4, and nothing else.
 *
 * ## What the captain's bar is, and why the obvious implementation fails it
 *
 * The amendment asks for ONE run that carries BOTH Stage 2 entry fill sources and **agrees with
 * itself per candidate**: some candidates' recorded verdicts come from Dune fills, some from the
 * swap-api, and the two readings match wherever both answered.
 *
 * The obvious implementation — score every candidate twice, divide the matches by the total, print
 * one percentage — is the exact shape captain decision 143a established as untrustworthy on this
 * project. There, **98.4% whole-window agreement hid a total failure confined to the create slot**:
 * the aggregate was dominated by the easy majority and the disagreement that mattered was invisible
 * inside it. A rate cannot say WHICH candidate disagreed, and on a screen whose whole purpose is to
 * refuse a deployer, the candidate is the unit that matters.
 *
 * So this module emits **counts by class and a row per candidate, and no rate at all**. That is not
 * a stylistic preference: {@link summariseEntryAgreement} deliberately has no denominator anywhere
 * in its output, and a test pins that its keys carry no rate, share or percentage. A consumer that
 * wants one may compute it from the counts, having seen the classes it is collapsing.
 *
 * ## "Answered" is `isDeployerAttributable`, and this is captain decision 174b one level up
 *
 * A source that returned `entry-unmeasured` DID NOT DISAGREE — it said nothing. Counting it as a
 * disagreement would make the comparison read worse the more of our own coverage ran out; counting
 * it as an agreement would make it read better. Both are the failure 174b names: an unmeasured
 * verdict is *no answer*, and every one of its producers is our own coverage rather than a fact
 * about the deployer. So the classes keep three states apart that a rate collapses into one —
 * `agreed`, `disagreed`, and `only-<kind>-answered` — and `neither-answered` is its own class again
 * rather than being dropped from a denominator where nobody would see it.
 *
 * ## `attempted` is separate from `answered`, and the difference is the run's own shape
 *
 * A source that was never asked for a candidate is not the same as one that was asked and could not
 * answer, and only the second says anything about the source. Every {@link EntryReading} carries
 * both flags so a reader can tell them apart without inferring it from an absence.
 *
 * ## What this module may and may not do
 *
 * It **reads `kind`**, which no scoring module may. That is legitimate here and structurally
 * contained: this module decides nothing about a deployer — it classifies two findings that were
 * already reached — and it is imported by `screen.mjs` alone, never from a scoring module, which
 * `test/deployer-screen.test.ts`'s transitive import closure enforces rather than trusts.
 * {@link pickRecordedReading} is the one place a provenance decision is taken, and it is the
 * enumeration lane's pattern verbatim (captain decisions 156a and 191a): a PRIMARY source, a named
 * FALLBACK when the primary could not answer, and a sentence per candidate saying which and why.
 */

import { isDeployerAttributable } from './entry.mjs';
import { FILL_SOURCE_KINDS } from './fill-source.mjs';

/**
 * The classes, and they are EXHAUSTIVE and DERIVED rather than written twice.
 *
 * The `only-<kind>-answered` half is generated from {@link FILL_SOURCE_KINDS}, so a third fill
 * source acquires its class automatically instead of silently falling into a bucket that predates
 * it. That is the same discipline the kind list itself is held to.
 *
 * @type {readonly string[]}
 */
export const AGREEMENT_CLASSES = Object.freeze([
  'agreed',
  'disagreed',
  ...FILL_SOURCE_KINDS.map((k) => `only-${k}-answered`),
  'neither-answered',
]);

/**
 * The sentence that travels with the counts, so they cannot be quoted as one figure.
 *
 * It is carried IN the summary rather than written in a doc for the reason `entry.mjs` gives about
 * its own caveats: a caveat that lives only in prose is one a reader of the record never sees, and
 * this record's whole claim is about a distinction a percentage destroys.
 */
export const NO_AGGREGATE_RATE =
  'THESE ARE COUNTS BY CLASS, NOT A RATE, AND COLLAPSING THEM IS THE DEFECT THIS MEASUREMENT ' +
  'EXISTS TO AVOID. Captain decision 143a: a 98.4% whole-window agreement figure on this project ' +
  'hid a total failure confined to the create slot, because an aggregate is dominated by the easy ' +
  'majority. `disagreed` is the finding; `only-<kind>-answered` is a coverage difference between ' +
  'the two sources and NOT a disagreement, per captain decision 174b — an unmeasured verdict is no ' +
  'answer, not a wrong one. Read the per-candidate rows on `candidates[].entryAgreement` before ' +
  'quoting any of these numbers, and never divide one by another.';

/**
 * One source's finding for one candidate.
 *
 * @typedef {object} EntryReading
 * @property {import('./fill-source.mjs').FillSourceKind} kind
 * @property {boolean} attempted Whether this run asked this source about this candidate at all.
 *   `false` is a property of the RUN, never of the source.
 * @property {boolean} answered Whether the finding is a statement about the deployer —
 *   `entry.mjs` → `isDeployerAttributable`, which is captain decision 174b's predicate and not a
 *   second expression that merely agrees with it.
 * @property {string | null} verdict `null` exactly when `attempted` is false.
 * @property {string | null} unmeasuredCause Which producer reached an unmeasured verdict.
 * @property {number | null} launchesSampled OBSERVATION, so a disagreement can be read rather than
 *   only counted: two sources scoring different numbers of launches is the first thing to look at.
 * @property {number | null} roomLeftMedian OBSERVATION, same reason. **Not a comparison** — the
 *   verdict is what the bar is on, and a median that differs while the verdict does not is
 *   agreement, not a near miss.
 */

/**
 * Read one source's finding into an {@link EntryReading}.
 *
 * A `null` finding means this run never asked, which is why `attempted` is derived here rather than
 * passed in: the two are the same fact, and letting a caller state them separately is how they come
 * apart.
 *
 * @param {import('./fill-source.mjs').FillSourceKind} kind
 * @param {import('./entry.mjs').EntryScore | null} score
 * @returns {EntryReading}
 */
export function readEntryReading(kind, score) {
  if (score === null || score === undefined) {
    return {
      kind,
      attempted: false,
      answered: false,
      verdict: null,
      unmeasuredCause: null,
      launchesSampled: null,
      roomLeftMedian: null,
    };
  }
  return {
    kind,
    attempted: true,
    answered: isDeployerAttributable(score),
    verdict: score.verdict,
    unmeasuredCause: score.unmeasuredCause ?? null,
    launchesSampled: score.launchesSampled,
    roomLeftMedian: Number.isFinite(score.roomLeft.median) ? Number(score.roomLeft.median.toFixed(6)) : null,
  };
}

/**
 * WHICH READING THE RUN RECORDS FOR THIS CANDIDATE — the enumeration lane's pattern, one stage over.
 *
 * `dune.mjs` → `mergeHistories` already answers exactly this question for "which mints did this
 * wallet create": a PRIMARY surface, a fallback to the walk **per wallet** when the primary cannot
 * vouch for that wallet, and `enumerationSource` on the candidate saying which answered. Captain
 * decisions 156a and 191a own that shape, and this is it applied to Stage 2's fills rather than a
 * second pattern invented beside it.
 *
 * **The fallback is on ANSWERED, never on a comparison of the two verdicts.** Choosing whichever
 * reading looked better — more launches, a stronger verdict, a room figure on the passing side of
 * the bar — would be a bar that differs by source arriving through the selection rather than
 * through the arithmetic, which is precisely what the injected-source seam exists to prevent.
 *
 * **A candidate NO source answered still records the primary's reading**, unmeasured verdict and
 * cause intact. Dropping it would delete the candidate from the run, and the cause is the run's own
 * coverage — 174b's rule again: carry it forward, surface it, never filter on it.
 *
 * @param {object} input
 * @param {import('./fill-source.mjs').FillSourceKind} input.primary
 * @param {readonly EntryReading[]} input.readings In the order the run asked. The primary need not
 *   be first; it is found by kind.
 * @returns {{ kind: import('./fill-source.mjs').FillSourceKind, fellBack: boolean,
 *   fallbackReasons: string[] }}
 */
export function pickRecordedReading(input) {
  const primary = input.readings.find((r) => r.kind === input.primary);
  if (primary === undefined) {
    throw new Error(
      `the recorded reading was asked for from a ${input.primary} source that produced no reading ` +
        `for this candidate. A run records the source it declared PRIMARY or names why it fell ` +
        `back; it never silently records a source it did not declare.`,
    );
  }
  if (primary.answered) return { kind: primary.kind, fellBack: false, fallbackReasons: [] };

  const fallback = input.readings.find((r) => r.kind !== input.primary && r.answered);
  if (fallback === undefined) {
    return {
      kind: primary.kind,
      fellBack: false,
      fallbackReasons: [],
    };
  }
  const why = primary.attempted
    ? `the ${primary.kind} fill source was asked and reached ${primary.verdict}` +
      `${primary.unmeasuredCause === null ? '' : ` (${primary.unmeasuredCause})`}, which is our own ` +
      `coverage rather than a statement about this deployer`
    : `the ${primary.kind} fill source was not asked about this candidate`;
  return {
    kind: fallback.kind,
    fellBack: true,
    fallbackReasons: [
      `recorded the ${fallback.kind} reading instead of the primary ${primary.kind} one: ${why}.`,
    ],
  };
}

/**
 * One candidate's agreement row.
 *
 * @typedef {object} EntryAgreementRow
 * @property {import('./fill-source.mjs').FillSourceKind} primary
 * @property {import('./fill-source.mjs').FillSourceKind} recorded Which reading became `entry`.
 * @property {string} class One of {@link AGREEMENT_CLASSES}.
 * @property {EntryReading[]} readings Every source this run carried, answered or not.
 * @property {string} note One sentence. Always populated, on every class.
 */

/**
 * Classify one candidate's two readings.
 *
 * **Exactly two answered readings can disagree; anything else is a coverage statement.** The
 * ordering of the checks is the whole semantics and is stated rather than implied: answered-count
 * first, equality second. A verdict comparison taken before the answered check would compare two
 * `entry-unmeasured` values and report `agreed`, which is a screen agreeing with itself about
 * having measured nothing.
 *
 * @param {object} input
 * @param {import('./fill-source.mjs').FillSourceKind} input.primary
 * @param {import('./fill-source.mjs').FillSourceKind} input.recorded
 * @param {readonly EntryReading[]} input.readings
 * @returns {EntryAgreementRow}
 */
export function classifyEntryAgreement(input) {
  const readings = [...input.readings];
  const answered = readings.filter((r) => r.answered);

  if (answered.length >= 2) {
    const verdicts = new Set(answered.map((r) => r.verdict));
    const agreed = verdicts.size === 1;
    const first = /** @type {EntryReading} */ (answered[0]);
    return {
      primary: input.primary,
      recorded: input.recorded,
      class: agreed ? 'agreed' : 'disagreed',
      readings,
      note: agreed
        ? `every source that answered reached ${first.verdict}.`
        : `the sources that answered reached different verdicts: ` +
          `${answered.map((r) => `${r.kind} ${r.verdict} on ${r.launchesSampled} launch(es)`).join(', ')}. ` +
          `This is the finding — read it per candidate, never as a share of the run.`,
    };
  }

  if (answered.length === 1) {
    const only = /** @type {EntryReading} */ (answered[0]);
    const silent = readings.filter((r) => r.kind !== only.kind);
    return {
      primary: input.primary,
      recorded: input.recorded,
      class: `only-${only.kind}-answered`,
      readings,
      note:
        `only the ${only.kind} source answered (${only.verdict}); ` +
        `${silent
          .map((r) =>
            r.attempted
              ? `${r.kind} reached ${r.verdict}${r.unmeasuredCause === null ? '' : ` (${r.unmeasuredCause})`}`
              : `${r.kind} was not asked`,
          )
          .join(', ')}. That is a COVERAGE difference between the sources, not a disagreement.`,
    };
  }

  return {
    primary: input.primary,
    recorded: input.recorded,
    class: 'neither-answered',
    readings,
    note:
      `no source answered for this candidate: ` +
      `${readings
        .map((r) =>
          r.attempted
            ? `${r.kind} reached ${r.verdict}${r.unmeasuredCause === null ? '' : ` (${r.unmeasuredCause})`}`
            : `${r.kind} was not asked`,
        )
        .join(', ')}. Every producer of an unmeasured verdict is our own coverage, so this says ` +
      `nothing about either source's fidelity and nothing about this deployer.`,
  };
}

/**
 * Count the classes. **No denominator, and that is the deliverable's shape rather than an oversight.**
 *
 * Every class in {@link AGREEMENT_CLASSES} appears with its count even at zero, because a class
 * that is absent from an object reads as "did not arise" only to someone who knows the list — and a
 * missing `disagreed` key is the one absence a reader must never have to infer.
 *
 * @param {readonly EntryAgreementRow[]} rows
 * @returns {{ candidates: number, byClass: Record<string, number>, noAggregateRate: string }}
 */
export function summariseEntryAgreement(rows) {
  /** @type {Record<string, number>} */
  const byClass = {};
  for (const cls of AGREEMENT_CLASSES) byClass[cls] = 0;
  for (const row of rows) {
    if (byClass[row.class] === undefined) {
      throw new Error(
        `an agreement row carried the class ${JSON.stringify(row.class)}, which is not one of the ` +
          `declared classes. The class list is exhaustive on purpose: an unrecognised class would ` +
          `be counted nowhere and the totals would silently stop adding up.`,
      );
    }
    byClass[row.class] = (byClass[row.class] ?? 0) + 1;
  }
  return { candidates: rows.length, byClass, noAggregateRate: NO_AGGREGATE_RATE };
}
