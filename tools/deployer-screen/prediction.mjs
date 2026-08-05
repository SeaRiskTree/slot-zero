/**
 * What a run PREDICTED — the recording half of the screen's feedback loop.
 *
 * The captain's requirement is that the research repeat itself and get better: *"we do the same
 * research in a repeatable way … then loop the process continuous getting better"*. A loop needs
 * two halves. This module is the first: it turns a Stage 2 finding into an explicit, falsifiable
 * claim that a later run can score. `outcome.mjs` is the second, and `grade.mjs` is the zero-token
 * runner over both.
 *
 * ## Why this is an accuracy property and not a feature
 *
 * **A run that did not record what it predicted can never be graded** — not "gradeable later with
 * more work", never. The evidence a grade needs is the claim itself plus the instant it stops being
 * in-sample, and neither can be reconstructed after the fact from a record that does not hold them.
 * Every run committed without this block is permanently unfalsifiable. That is the whole
 * justification for the block existing, and it is also its scope limit: nothing here re-tunes the
 * screen, moves a bar, or reads a new surface. It restates a verdict already reached, in a form that
 * can be scored.
 *
 * ## The claim, and the two ways it can be absent
 *
 * The prediction that matters is the **beatable / not-beatable** call: can we enter this deployer's
 * opening window after paying what it costs to land. It is read off the Stage 2 entry verdict and
 * nothing else — {@link ENTRY_CLAIM_BY_VERDICT} is the whole mapping and it is exhaustive over
 * `entry.mjs` → `ENTRY_VERDICTS`, so a verdict added later cannot acquire a claim by default.
 *
 * A candidate can fail to carry a claim for two quite different reasons and the block keeps them
 * apart, because collapsing them is the same defect one layer up:
 *
 * - **`not-scored`** — Stage 2 never reached this candidate. It failed the gate, its gate reading
 *   was unmeasured, or the scoring cap left it unscored. Nothing was claimed because nothing was
 *   measured.
 * - **`entry-unmeasured`** — Stage 2 ran and could not answer. Captain decision 174b: every
 *   unmeasured cause is a fact about OUR coverage, so this is **no answer**, never a prediction of
 *   "not beatable". Predicting `not-beatable` from an unmeasured verdict would manufacture a claim
 *   out of our own budget and then grade ourselves right whenever the deployer turned out to be
 *   unbeatable — the invisible false rejection this screen exists to remove, wearing a hit rate.
 *   {@link entryPredictionClaim} therefore routes through `entry.mjs` → `isDeployerAttributable`
 *   rather than testing the verdict string itself.
 *
 * ## What makes the claim gradeable, and why the boundary instant is a PROOF
 *
 * A prediction is only worth scoring **out of sample**. Re-measuring the launches the prediction was
 * made from would agree with itself by construction and report a hit rate near 1.0 that means
 * nothing.
 *
 * {@link PredictionBlock.madeAtIso} is the run's own `finishedAtIso`, and that choice is a proof
 * rather than a convention. Stage 2 refuses any launch younger than `windowMs + seekMarginMs` at the
 * moment it decides eligibility (`stage2.mjs` → `scoreCandidateEntry`), and that decision happened
 * before the run finished — so **every launch in the sample was created strictly before
 * `finishedAtIso`**. A launch created after it is therefore provably out of sample, with no
 * assumption about clocks, ordering or how long the run took. `outcome.mjs` filters on exactly that.
 *
 * ## Forward compatibility, because Stage 3 is deferred and not cancelled
 *
 * Captain decision 237a defers Stage 3, so an EXIT prediction is out of scope today. The block is
 * shaped so that adding one later does not invalidate a single run recorded before it:
 *
 * - claims are a **list keyed by `subject`**, not a scalar, so a second subject appends;
 * - the run-level block declares {@link PREDICTION_SUBJECTS} — what this build could predict — and
 *   {@link DEFERRED_SUBJECTS} — what it deliberately did not. A grader meeting an older record can
 *   therefore tell "this run had no exit claim because the stage did not exist" from "this run had
 *   no exit claim because it could not measure one", which is the same absence-of-evidence
 *   distinction the rest of this tool turns on;
 * - a grader iterates the claims it recognises and counts the rest as ungraded, so a record written
 *   by a newer build does not break an older grader either.
 *
 * **A schema reset when Stage 3 lands would waste every run recorded between now and then**, which
 * is the one cost this shape exists to avoid.
 */

import { ENTRY_VERDICTS, isDeployerAttributable } from './entry.mjs';

/**
 * Version of the prediction block itself, inside the run record's own schema version.
 *
 * A second version counter looks redundant next to `record.mjs` → `RECORD_SCHEMA_VERSION`, and it is
 * not: the grading lane reads records written by many builds and cares about ONE block's shape. The
 * record version answers "what does this whole file carry"; this answers "can I score the claims in
 * it". Stage 3 arriving will move this one and the record one together; a change elsewhere in the
 * record moves only the record one, and a grader does not have to re-derive whether it was affected.
 */
export const PREDICTION_BLOCK_VERSION = 1;

/**
 * The claim vocabulary. Two values and no third, deliberately.
 *
 * "No answer" is the ABSENCE of a claim (`claim: null`) rather than a third value, because a third
 * value would be sortable, filterable and countable beside the other two — and the one thing captain
 * decision 174b forbids is a consumer treating our own coverage as if it were a finding.
 *
 * @typedef {'beatable' | 'not-beatable'} PredictionClaim
 */

/** @type {readonly PredictionClaim[]} */
export const PREDICTION_CLAIMS = ['beatable', 'not-beatable'];

/**
 * What a claim is ABOUT. Today: entry only.
 *
 * @typedef {'entry'} PredictionSubject
 */

/** @type {readonly PredictionSubject[]} */
export const PREDICTION_SUBJECTS = ['entry'];

/**
 * Subjects this build deliberately does NOT predict, and why.
 *
 * Recorded rather than omitted. A run whose record simply lacked an exit claim is indistinguishable
 * from a run that tried to make one and failed, and the grading lane would have to guess which —
 * the same absence-of-evidence trap `creation.mayhemShare` and `movedCreator` already carry a `null`
 * for. **Room to enter is not room to leave**, so an exit claim can never be inferred from an entry
 * one; when Stage 3 lands it appends a subject here and moves to {@link PREDICTION_SUBJECTS}.
 */
export const DEFERRED_SUBJECTS = Object.freeze([
  Object.freeze({
    subject: 'exit',
    reason:
      'STAGE 3 (the exit trap) is DEFERRED by captain decision 237a, so this build makes no exit ' +
      'prediction at all. This is not an unmeasured exit claim and must never be graded as one: ' +
      'room to enter is not room to leave, and no entry number may stand in for an exit one. A ' +
      'later build appends the subject; every record written before it stays valid and stays ' +
      'gradeable on the subjects it does declare.',
  }),
]);

/**
 * The reading the entry claim rests on, named on the record rather than left to be inferred.
 *
 * The task this loop was released under is explicit that a figure must name its reading, because
 * conflating two readings of the same name is the defect three lanes have just finished correcting.
 * Two readings are involved in reaching an entry claim and they are different surfaces:
 *
 * - the candidate reached Stage 2 by clearing the GATE, which by default reads the creation-derived
 *   merged history and under `--ownership-only` reads the vendor's 70-record page — a shorter,
 *   success-biased window. The row's own `historySource` says which, and the block copies it into
 *   `gateReading` so a claim is self-describing;
 * - the claim itself is Stage 2's, and Stage 2 reads pump.fun's keyless fill tape over the launches
 *   the MadeOnSol profile offered, filtered to those old enough to have finished happening.
 *
 * They are never pooled and a grader must not pool them either.
 */
export const ENTRY_PREDICTION_READING =
  'STAGE 2 ENTRY, over pump.fun swap-api fills for the launches `measure.mjs` -> `toLaunchRefs` ' +
  'read off the MadeOnSol profile, gated to launches at least the Stage 2 fill source`s own ' +
  '`minAgeMs` old — the same instant its seek cursor reaches, which on the swap-api source is ' +
  '`pumpfun.mjs` -> `windowReachMs` and is 85,000ms at the pinned values, NOT the superseded ' +
  'hand-written `windowMs + seekMarginMs` sum of 65,000ms this sentence used to name, ' +
  'scored by `entry.mjs` -> `scoreEntry` at this run`s pinned `stage2_entry` and `stage2_cost` ' +
  'bars. It is NOT the gate reading: `gateReading` on this block names that one separately, and ' +
  'the two must never be pooled or compared.';

/**
 * The sentence that says what would make an entry claim scoreable, carried ON the claim.
 *
 * Same discipline as `entry.mjs` → `LANDING_TIP_CAVEAT`: a rule that lives only in a README is a
 * rule the next consumer does not meet. A grader and this record can therefore be checked against
 * each other, rather than the grader being the only place the rule exists.
 */
export const ENTRY_GRADEABLE_WHEN =
  'Scoreable once this deployer has created enough further launches, ALL of them after this ' +
  'record`s `madeAtIso`, for the same Stage 2 recipe to reach a MEASURED verdict over them. The ' +
  'boundary is a proof, not a convention: Stage 2 refused every launch younger than the fill ' +
  'source`s own `minAgeMs` — the seek cursor`s own bound, derived from the slot span at a ' +
  'measured worst-case rate — at the instant it chose its sample, and that instant precedes ' +
  '`madeAtIso`, so a launch created after `madeAtIso` cannot have been in the sample. An outcome ' +
  'measurement that reaches an unmeasured verdict grades NOTHING — it is our coverage again, not ' +
  'a miss.';

/** The run-level caveat, so the counts below cannot be quoted as a performance figure. */
export const PREDICTION_RUN_CAVEAT =
  'THESE ARE CLAIMS, NOT RESULTS. Nothing here has been graded; `grade.mjs` is what scores them, ' +
  'against launches this deployer created after `outOfSampleAfterIso`. A run`s own claim counts ' +
  'say what it was willing to be wrong about and nothing about whether it was right.';

/**
 * Why a candidate carries no claim. Two states, kept apart on purpose — see the module header.
 *
 * @typedef {'not-scored' | 'entry-unmeasured' | 'verdict-unrecognised'} NoClaimReason
 */

/** @type {Readonly<Record<NoClaimReason, string>>} */
export const NO_CLAIM_REASONS = Object.freeze({
  'not-scored':
    'Stage 2 never scored this candidate — it failed the competence gate, its gate reading was ' +
    'itself unmeasured, or the scoring cap left it unscored. NOTHING was claimed because nothing ' +
    'was measured, and this is not a prediction of "not beatable".',
  'entry-unmeasured':
    'Stage 2 ran and could not answer. Captain decision 174b: EVERY unmeasured cause is a fact ' +
    'about our own coverage, so this is NO ANSWER carried forward, never a prediction. Reading it ' +
    'as "not beatable" would let the screen score itself right whenever its own budget ran out.',
  'verdict-unrecognised':
    'the entry verdict is not one this build knows, so no claim is made about it. A record from a ' +
    'newer build, or a hand-edited one, fails SAFE here rather than being mapped by guesswork.',
});

/**
 * Entry verdict → claim. **Exhaustive over `entry.mjs` → `ENTRY_VERDICTS`**, and a test asserts it,
 * so a verdict added later has to come here on purpose instead of silently defaulting.
 *
 * `null` is the two unmeasured verdicts. Note this table is NOT the predicate: {@link
 * entryPredictionClaim} asks `isDeployerAttributable` first, so the rule about what may be treated
 * as a finding lives in one place (`entry.mjs`) and this table only says which finding it is.
 *
 * @type {Readonly<Record<string, PredictionClaim | null>>}
 */
export const ENTRY_CLAIM_BY_VERDICT = Object.freeze({
  // Room was present, the seat was priced, and the field still cleared after paying for it.
  'entry-open-after-costs': 'beatable',
  'entry-room-absent': 'not-beatable',
  'entry-cost-prohibitive': 'not-beatable',
  'entry-field-loss-making': 'not-beatable',
  'entry-cost-unmeasured': null,
  'entry-unmeasured': null,
});

/**
 * @typedef {object} PredictionClaimRow
 * @property {PredictionSubject | string} subject
 * @property {PredictionClaim | null} claim   `null` means NO CLAIM. See {@link NO_CLAIM_REASONS}.
 * @property {boolean} measured               `entry.mjs` → `isDeployerAttributable` on the finding.
 * @property {string} basis                   Which field the claim was read off.
 * @property {string | null} verdict          The entry verdict, kept so a grade can be audited.
 * @property {string | null} unmeasuredCause  Present when the verdict was unmeasured.
 * @property {NoClaimReason | null} noClaimReason
 * @property {string} reason                  The sentence for whichever of the two applies.
 * @property {string} gradeableWhen
 */

/**
 * @typedef {object} PredictionBlock
 * @property {number} block                   {@link PREDICTION_BLOCK_VERSION}.
 * @property {string} madeAtIso               The out-of-sample boundary. See the module header.
 * @property {string} gateReading             Which history the GATE read for this candidate.
 * @property {string} entryReading            {@link ENTRY_PREDICTION_READING}.
 * @property {string | number | null} thresholdsVersion
 * @property {PredictionClaimRow[]} claims
 */

/**
 * Read the beatable / not-beatable claim off a Stage 2 finding.
 *
 * Takes the in-process `EntryScore` and the persisted `entry` record row alike — they carry the same
 * three fields, and `isDeployerAttributable` is documented to answer the same for both.
 *
 * @param {{ verdict: string, unmeasuredCause?: string | null } | null | undefined} entry
 * @returns {{ claim: PredictionClaim | null, measured: boolean, verdict: string | null,
 *   unmeasuredCause: string | null, noClaimReason: NoClaimReason | null, reason: string }}
 */
export function entryPredictionClaim(entry) {
  if (entry == null || typeof entry.verdict !== 'string') {
    return {
      claim: null,
      measured: false,
      verdict: null,
      unmeasuredCause: null,
      noClaimReason: 'not-scored',
      reason: NO_CLAIM_REASONS['not-scored'],
    };
  }
  const verdict = entry.verdict;
  const unmeasuredCause = entry.unmeasuredCause ?? null;
  // The RULE first, the mapping second. `isDeployerAttributable` owns "may this be treated as a
  // finding at all" — including its three fail-safe behaviours for unknown verdicts, unknown causes
  // and records too old to carry a cause — so this function never re-derives it from the string.
  const measured = isDeployerAttributable({ verdict, unmeasuredCause });
  if (!measured) {
    const known = /** @type {readonly string[]} */ (ENTRY_VERDICTS).includes(verdict);
    const noClaimReason = /** @type {NoClaimReason} */ (known ? 'entry-unmeasured' : 'verdict-unrecognised');
    return { claim: null, measured: false, verdict, unmeasuredCause, noClaimReason, reason: NO_CLAIM_REASONS[noClaimReason] };
  }
  const claim = ENTRY_CLAIM_BY_VERDICT[verdict] ?? null;
  if (claim === null) {
    // Unreachable while the table is exhaustive and agrees with `isDeployerAttributable`, and it is
    // still handled: the alternative is a measured verdict silently producing no claim.
    return {
      claim: null,
      measured: true,
      verdict,
      unmeasuredCause,
      noClaimReason: 'verdict-unrecognised',
      reason: NO_CLAIM_REASONS['verdict-unrecognised'],
    };
  }
  return {
    claim,
    measured: true,
    verdict,
    unmeasuredCause,
    noClaimReason: null,
    reason:
      claim === 'beatable'
        ? `Stage 2 reached ${verdict}: room was present in the opening window, the seat was priced, ` +
          `and the field still cleared after paying for it. THE CLAIM: the next launches from this ` +
          `wallet, measured the same way, will also be enterable after costs.`
        : `Stage 2 reached ${verdict}. THE CLAIM: the next launches from this wallet, measured the ` +
          `same way, will also fail to be enterable after costs.`,
  };
}

/**
 * Build the per-candidate `prediction` block a run record persists.
 *
 * Every field is derived from what the run already measured; nothing here reads a surface, spends a
 * request or consults a threshold. That is the scope limit stated in the module header, implemented
 * rather than promised — and a test asserts that adding this block moves no verdict.
 *
 * @param {object} input
 * @param {{ verdict: string, unmeasuredCause?: string | null } | null} input.entry The Stage 2
 *   finding, or `null` when Stage 2 never scored this candidate.
 * @param {string} input.madeAtIso        The run's `finishedAtIso`. See the module header for why.
 * @param {string} input.gateReading      The candidate row's `historySource`.
 * @param {string | number | null} input.thresholdsVersion
 * @returns {PredictionBlock}
 */
export function buildPredictionBlock(input) {
  const entry = entryPredictionClaim(input.entry);
  return {
    block: PREDICTION_BLOCK_VERSION,
    madeAtIso: input.madeAtIso,
    gateReading: input.gateReading,
    entryReading: ENTRY_PREDICTION_READING,
    thresholdsVersion: input.thresholdsVersion,
    claims: [
      {
        subject: 'entry',
        claim: entry.claim,
        measured: entry.measured,
        basis: 'entry.verdict',
        verdict: entry.verdict,
        unmeasuredCause: entry.unmeasuredCause,
        noClaimReason: entry.noClaimReason,
        reason: entry.reason,
        gradeableWhen: ENTRY_GRADEABLE_WHEN,
      },
    ],
  };
}

/**
 * The run-level summary of what a run was willing to be wrong about.
 *
 * Counts only. It deliberately reports `noClaim` broken out BY REASON rather than as a total,
 * because a run with 79 `not-scored` and a run with 79 `entry-unmeasured` are in completely
 * different states — the first spent nothing on them, the second spent a full Stage 2 walk each and
 * still could not answer.
 *
 * @param {readonly { prediction?: PredictionBlock | null }[]} rows Persisted candidate rows.
 * @returns {object}
 */
export function summarisePredictions(rows) {
  /** @type {Record<string, number>} */
  const noClaimByReason = {};
  let withClaim = 0;
  let beatable = 0;
  let notBeatable = 0;
  for (const row of rows) {
    for (const c of row.prediction?.claims ?? []) {
      if (c.subject !== 'entry') continue;
      if (c.claim === 'beatable') {
        withClaim += 1;
        beatable += 1;
      } else if (c.claim === 'not-beatable') {
        withClaim += 1;
        notBeatable += 1;
      } else {
        const key = c.noClaimReason ?? 'verdict-unrecognised';
        noClaimByReason[key] = (noClaimByReason[key] ?? 0) + 1;
      }
    }
  }
  return {
    block: PREDICTION_BLOCK_VERSION,
    subjects: [...PREDICTION_SUBJECTS],
    subjectsDeferred: DEFERRED_SUBJECTS.map((d) => ({ ...d })),
    candidates: rows.length,
    withClaim,
    beatable,
    notBeatable,
    noClaim: rows.length - withClaim,
    noClaimByReason,
    caveat: PREDICTION_RUN_CAVEAT,
  };
}

/**
 * The oldest record schema whose entry claims may be graded, and the reason it is a RECORD property
 * rather than a per-verdict one.
 *
 * Schema 6 is where the fee moved inside the entry window (captain's ruling of 2026-08-02, decision
 * 136b). Before it, `entry-room-present` meant *room was present and the seat was never priced* and
 * `entry-room-absent` meant *room alone was short* — both answers to a question with no cost leg in
 * it. Today's claim is about being enterable AFTER costs, and the outcome this lane measures is
 * produced by a recipe that prices the seat.
 *
 * **So the two are answers to different questions, and grading one against the other would report a
 * hit rate for a comparison nobody made.** The boundary is the RECORD's version and not the
 * verdict's: `entry-room-present` has no modern equivalent at all, and its sibling
 * `entry-room-absent` survived the rename while the question around it changed, so cherry-picking
 * the surviving label would be exactly the "same name, different quantity" conflation this lane was
 * released to avoid reintroducing. The committed `runs/2026-08-02-good.json` is the concrete case:
 * schema 3, one `entry-room-present` and two `entry-room-absent`, all three refused here by name.
 *
 * Committed records are never retro-edited, so those runs stay legal and stay unfalsifiable. That is
 * the cost this whole lane exists to stop paying, not a defect in the older records.
 */
export const MIN_GRADEABLE_SCHEMA = 6;

/**
 * @typedef {object} ExtractedPrediction
 * @property {string} source          The run record's file name — half of the grade's identity.
 * @property {string} wallet
 * @property {string} subject
 * @property {PredictionClaim} claim
 * @property {string} verdict         The verdict the claim was read off, for audit.
 * @property {string} madeAtIso
 * @property {number} outOfSampleAfterMs
 * @property {string} gateReading
 * @property {string} entryReading
 * @property {string | number | null} thresholdsVersion
 * @property {Record<string, unknown>} stage2Entry The `stage2_entry` bars THIS run applied.
 * @property {Record<string, unknown>} stage2Cost  The `stage2_cost` bars THIS run applied.
 */

/**
 * @typedef {object} RefusedPrediction
 * @property {string} source
 * @property {string | null} wallet
 * @property {string} reason
 */

/**
 * Pull every gradeable claim out of a set of committed run records.
 *
 * **Refusals are returned, never dropped.** A record this cannot grade is a record whose runs are
 * unfalsifiable, which is the finding this lane exists to surface — silently skipping it would
 * report a clean, small, confident worklist and hide the reason it is small.
 *
 * The recipe travels with the claim. A grade compares like with like only if the outcome is measured
 * at the bars the PREDICTION was made under, so `stage2Entry` and `stage2Cost` are taken from the
 * record rather than from today's `thresholds.json` — a run graded against bars it never saw is not
 * graded, it is compared to a different screen. A record missing either block is refused rather than
 * defaulted, because defaulting is precisely how the substitution would become invisible.
 *
 * @param {readonly { file: string, body: unknown }[]} records As `ledger.mjs` → `readRunRecords`
 *   returns them, so the tool has one shape for "a committed run record read off disk".
 * @returns {{ predictions: ExtractedPrediction[], refused: RefusedPrediction[] }}
 */
export function extractPredictions(records) {
  /** @type {ExtractedPrediction[]} */
  const predictions = [];
  /** @type {RefusedPrediction[]} */
  const refused = [];

  for (const { file, body: record } of records) {
    if (typeof record !== 'object' || record === null) {
      refused.push({ source: file, wallet: null, reason: 'the file did not parse as a run record object.' });
      continue;
    }
    const r = /** @type {Record<string, any>} */ (record);
    const schema = typeof r['schemaVersion'] === 'number' ? r['schemaVersion'] : 1;
    if (schema < MIN_GRADEABLE_SCHEMA) {
      refused.push({
        source: file,
        wallet: null,
        reason:
          `schema ${schema} predates the entry-cost verdict vocabulary (schema ` +
          `${MIN_GRADEABLE_SCHEMA}). Its verdicts answer a question with no cost leg in it, so ` +
          `grading them against an after-cost outcome would report a hit rate for a comparison ` +
          `nobody made. Refused whole, by version, rather than per verdict.`,
      });
      continue;
    }
    const madeAtIso = typeof r['finishedAtIso'] === 'string' ? r['finishedAtIso'] : '';
    const outOfSampleAfterMs = madeAtIso === '' ? Number.NaN : Date.parse(madeAtIso);
    if (!Number.isFinite(outOfSampleAfterMs)) {
      refused.push({
        source: file,
        wallet: null,
        reason:
          'the record carries no readable `finishedAtIso`, so the instant its claims stop being ' +
          'in-sample cannot be established and no out-of-sample grade is possible.',
      });
      continue;
    }
    const stage2Entry = r['thresholds']?.['stage2_entry'] ?? null;
    const stage2Cost = r['thresholds']?.['stage2_cost'] ?? null;
    if (stage2Entry == null || stage2Cost == null) {
      refused.push({
        source: file,
        wallet: null,
        reason:
          'the record does not carry both `thresholds.stage2_entry` and `thresholds.stage2_cost`, ' +
          'so the bars its claims were made under are unknown. Substituting today`s would grade ' +
          'the run against a screen it never was.',
      });
      continue;
    }
    const candidates = Array.isArray(r['candidates']) ? r['candidates'] : [];
    let claimsFound = 0;
    for (const raw of candidates) {
      if (typeof raw !== 'object' || raw === null) continue;
      const c = /** @type {Record<string, any>} */ (raw);
      const block = c['prediction'];
      if (block == null) continue;
      const wallet = typeof c['wallet'] === 'string' ? c['wallet'] : null;
      if (wallet === null) continue;
      for (const claim of Array.isArray(block['claims']) ? block['claims'] : []) {
        if (typeof claim !== 'object' || claim === null) continue;
        const cl = /** @type {Record<string, any>} */ (claim);
        if (!(/** @type {readonly string[]} */ (PREDICTION_CLAIMS).includes(cl['claim']))) continue;
        // A subject this build cannot measure an outcome for is NOT a refusal of the record — it is
        // a claim a newer build made and this one carries forward untouched. Counting it as refused
        // would report a newer record as broken.
        if (!(/** @type {readonly string[]} */ (PREDICTION_SUBJECTS).includes(cl['subject']))) continue;
        claimsFound += 1;
        predictions.push({
          source: file,
          wallet,
          subject: cl['subject'],
          claim: cl['claim'],
          verdict: typeof cl['verdict'] === 'string' ? cl['verdict'] : '(unrecorded)',
          madeAtIso,
          outOfSampleAfterMs,
          gateReading: typeof block['gateReading'] === 'string' ? block['gateReading'] : '(unrecorded)',
          entryReading: typeof block['entryReading'] === 'string' ? block['entryReading'] : '(unrecorded)',
          thresholdsVersion: r['thresholdsVersion'] ?? null,
          stage2Entry,
          stage2Cost,
        });
      }
    }
    if (claimsFound === 0) {
      refused.push({
        source: file,
        wallet: null,
        reason:
          `schema ${schema} is gradeable but this record carries no claim: either it predates the ` +
          `prediction block, or every candidate in it reached an unmeasured verdict. Both are ` +
          `PERMANENTLY unfalsifiable — the claim cannot be reconstructed after the fact.`,
      });
    }
  }

  return { predictions, refused };
}
