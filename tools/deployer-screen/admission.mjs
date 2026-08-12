/**
 * THE SECOND ADMISSION ARM — how a deployer the competence gate REFUSES still reaches Stage 2.
 *
 * Captain decision 451, 2026-08-11. Pure: it takes a completion measurement, a gate result and the
 * pinned bounds, and returns a decision. It reads no vendor, opens no socket and costs nothing in
 * every currency — every field it reads was already in the history Stage 1 paid for.
 *
 * ## WHY THERE IS A SECOND ARM AT ALL
 *
 * All six `entry-open-after-costs` verdicts this project has ever produced come from deployers that
 * FAIL `stage1_gate.minCompletionRate` — sub-gate on 15 of 15 of the population that produced them,
 * highest lifetime rate 0.2000 — while every population the gate ADMITS has returned zero: 0 of 21
 * scored on the widened gate-passing legs (exact 95% [0.0000, 0.1611]) and 0 of 43 scored across all
 * nine committed run records. Either the gate is wrong about these deployers or they are not the
 * business, and the captain ruled the former.
 * (`slot-zero-viability-verdict` → `report.md` §§2–3 and `decision-451.md`, held in firstmate's
 * records, not in this repo — see AGENTS.md, "Citing a report this repo does not hold".)
 *
 * ## WHAT IT IS NOT, AND THE STANDING RULING THAT SHAPES IT
 *
 * The captain's standing ruling on the gate (2026-08-07), verbatim: *"The gate sounds like it will
 * be the continuing improvement, the gate is there because of that, the gate can loosen but the
 * candidates being measured must be worth the spend."* So this is a DELIBERATE LOOSENING and not a
 * removal, and four things follow, each of which is a property of the code below rather than a
 * promise about it:
 *
 * 1. **`minCompletionRate` does not move and is not bypassed.** It still decides which ARM a
 *    candidate is judged on. There is no flag that turns the gate off.
 * 2. **Admission stays a spend-worthiness test.** {@link assessSubGateAdmission} refuses, with a
 *    stated reason, and on the committed `runs/2026-08-04.json` it refuses **54 of the 62**
 *    candidates the rate bar removes there — see {@link SUB_GATE_ADMISSION_RULE} for the derivation
 *    and `thresholds.json` → `stage1_gate.justification.subGateAdmission` for the full argument.
 * 3. **The arm is on the record.** An admitted candidate carries the verdict `sub-gate-admitted`,
 *    which is its OWN value and never `gate-passed`, so nothing that already counts gate survivors
 *    can pick these up by accident.
 * 4. **The two populations are never pooled.** {@link ARMS_ARE_NEVER_POOLED} is the sentence, and
 *    the verdict vocabulary is what enforces it: a statistic over `gate-passed` is arm A's alone
 *    and a statistic over `sub-gate-admitted` is arm B's alone, each with its own denominator.
 *
 * ## AND IT SETTLES NOTHING ABOUT WHETHER THE SUB-GATE PASSES ARE REAL
 *
 * {@link SUB_GATE_ADMISSION_IS_NOT_A_FINDING} travels with every admission for this reason. Measured
 * entry cost is a LOWER bound — a landing tip paid in a separate transaction of the same bundle is
 * in no figure this repo can compute (`entry.mjs` → `LANDING_TIP_CAVEAT`) — so an after-cost result
 * above a bar is an UPPER bound on itself and establishes nothing positive. Admitting these
 * deployers buys the MEASUREMENT and not a verdict about it.
 */

// The tempo is the rotation's own rank-key quantity and is imported rather than recomputed: a
// second derivation of `tokens / spanDays` would be free to drift from the one that allocates the
// scoring cap, and this arm's window-supply floor is derived in exactly that unit (see
// {@link SUB_GATE_ADMISSION_RULE}). `launchesPerDayOf` is pure — it takes a measurement and returns
// a number — so nothing about the rotation's state file reaches this module.
import { launchesPerDayOf } from './rotation.mjs';

/**
 * The two arms a candidate can reach Stage 2 through, as a closed vocabulary.
 *
 * `gate` is the competence gate, unchanged since before captain decision 451. `sub-gate` is this
 * module. They are recorded per candidate (`admissionArm`, record schema 27) because a later
 * reading has to be able to separate them, and they are NEVER summed.
 *
 * @typedef {'gate' | 'sub-gate'} AdmissionArm
 */

/** @type {readonly AdmissionArm[]} */
export const ADMISSION_ARMS = Object.freeze(['gate', 'sub-gate']);

/**
 * The one sentence that says the two arms are two populations. Written once because it is stated on
 * the candidate row, in the rendered block, in the run record and in this module's own refusals,
 * and this repo never retro-edits a record — so a wording that overstates is permanent.
 *
 * It is a rule about ARITHMETIC and not about presentation: pooling is not "confusing", it produces
 * a number with no denominator, which is the standing prohibition AGENTS.md states one measurement
 * over ("Those are rows, not wallets, and the distinction is load-bearing").
 */
export const ARMS_ARE_NEVER_POOLED =
  'SUB-GATE AND GATE-PASSING CANDIDATES ARE TWO POPULATIONS WITH TWO DENOMINATORS (captain ' +
  'decision 451). No count, rate or interval may combine them: every figure states which arm it ' +
  'is over, and a figure that cannot is not computed.';

/**
 * What an admission through this arm claims, and — the load-bearing half — what it does not.
 *
 * Captain decision 451 admits these deployers to be MEASURED. It establishes nothing about whether
 * the six after-cost passes that motivated it are real, and the repo's own pinned rule is why:
 * `thresholds.json` → `stage2_entry.justification.minFieldHitRateNet` records that measured cost is
 * a LOWER bound, so a net figure above the bar cannot EARN a verdict. Nothing this arm produces may
 * be presented as a finding of profitability.
 */
export const SUB_GATE_ADMISSION_IS_NOT_A_FINDING =
  'ADMITTED THROUGH THE SUB-GATE ARM (captain decision 451): this candidate FAILED the competence ' +
  'gate and is being measured anyway. It says the measurement is worth taking and NOTHING ELSE. No ' +
  'after-cost result from this population is established — measured entry cost is a LOWER bound, so ' +
  'a net figure above a bar is an upper bound on itself and cannot earn a verdict.';

/**
 * HOW THE RULE WAS DERIVED, in one place, because the derivation is the thing a later lane has to
 * be able to attack. `thresholds.json` → `stage1_gate.justification.subGateAdmission` carries the
 * same argument with every figure and its provenance; this constant is what the tool PRINTS, so it
 * states the shape and points there rather than restating the numbers.
 *
 * **It is derived from the population, never from the six known passes.** Fitting a floor to the
 * wallets already known to have passed would make every later verdict circular, and the six are not
 * an input to any value here. The check that they are not is stated where it belongs — in the
 * justification, which records that this rule would have admitted FOUR of the six and refused two
 * (lifetime rates 0.018 and 0.036, both below the inflow floor), and that the lever for that decile
 * is the floor's own derivation and not the six.
 */
export const SUB_GATE_ADMISSION_RULE =
  'SUB-GATE ADMISSION (captain decision 451) — three conditions, all derived from the population ' +
  'and none from the six known after-cost passes: (1) the candidate fails the gate on the ' +
  'COMPLETION RATE ALONE, so the sample-size and evidence-window bars still bind; (2) its rate ' +
  'clears the INFLOW FLOOR, which since captain decision 352b is a floor on the money that reaches ' +
  "its launches — the rate is the share of them pulling RAISE-85's 85 SOL-equivalent of net quote " +
  'inflow in 24 hours; (3) it supplies WINDOWS — its launch tempo fills one Stage 2 visit inside ' +
  'the horizon the already-admitted population takes to refresh its own, and it is still launching ' +
  'inside that same horizon. Conditions (2) and (3) are what keep admission a spend-worthiness ' +
  'test. See thresholds.json -> stage1_gate.justification.subGateAdmission for every figure.';

/**
 * @typedef {object} SubGateBounds
 * @property {number} minCompletionRate The inflow floor. PINNED — `stage1_gate.subGateAdmission`.
 * @property {number} visitRefreshDays The horizon both window-supply bounds are derived from.
 *   PINNED — the one number this arm writes down.
 * @property {number} minLaunchesPerDay DERIVED, never written: `windowCap / visitRefreshDays`.
 * @property {number} maxDaysSinceLastLaunch DERIVED, never written: `visitRefreshDays` itself.
 * @property {number} windowCap `stage2_entry.maxLaunchesPerCandidate`, handed in rather than read
 *   here — it is source-scoped, and the rotation already resolves it once per run.
 */

/**
 * Resolve the arm's bounds from its pins and the run's own window cap.
 *
 * **TWO OF THE FOUR ARE DERIVED AND NEITHER MAY BE WRITTEN DOWN**, which is this repo's standing
 * shape for a bound someone else's number controls (`client.mjs` → `laneCeilingCredits`,
 * `pumpfun.mjs` → `windowReachMs`): the tempo floor is *one visit's worth of windows inside the
 * refresh horizon*, so it must move when `maxLaunchesPerCandidate` moves — and it has moved before,
 * 8 → 10 at captain decision 190a. A written 0.465 would have stayed at the 8-launch value silently.
 *
 * Refuses by name rather than defaulting. A pin this arm prices an admission from is REQUIRED, for
 * the reason `enumerateCreations` refuses without its own: a guard that weakens when its inputs go
 * missing fails in the one direction this decision has to be safe in — quietly admitting a
 * population nobody sized.
 *
 * @param {{ subGateAdmission?: { minCompletionRate?: unknown, visitRefreshDays?: unknown } }} gateThresholds
 * @param {number} windowCap `stage2_entry.maxLaunchesPerCandidate` for the recipe this run applies.
 * @returns {SubGateBounds}
 */
export function subGateBounds(gateThresholds, windowCap) {
  const pinned = gateThresholds.subGateAdmission;
  if (pinned === undefined || pinned === null || typeof pinned !== 'object') {
    throw new Error(
      'refusing to admit anybody through the sub-gate arm: thresholds.json -> ' +
        'stage1_gate.subGateAdmission is missing. Captain decision 451 sizes this arm against ' +
        'pinned values and a defaulted one would admit a population nobody sized.',
    );
  }
  const minCompletionRate = pinned.minCompletionRate;
  const visitRefreshDays = pinned.visitRefreshDays;
  if (typeof minCompletionRate !== 'number' || !Number.isFinite(minCompletionRate) || minCompletionRate <= 0) {
    throw new Error(
      'refusing to admit anybody through the sub-gate arm: ' +
        `stage1_gate.subGateAdmission.minCompletionRate reads ${String(minCompletionRate)}. It must ` +
        'be a positive number — captain decision 451 loosens the gate and does NOT set it to zero.',
    );
  }
  if (typeof visitRefreshDays !== 'number' || !Number.isFinite(visitRefreshDays) || visitRefreshDays <= 0) {
    throw new Error(
      'refusing to admit anybody through the sub-gate arm: ' +
        `stage1_gate.subGateAdmission.visitRefreshDays reads ${String(visitRefreshDays)}. Both ` +
        'window-supply bounds are derived from it, so an unusable value leaves the arm with no ' +
        'spend-worthiness test at all.',
    );
  }
  if (typeof windowCap !== 'number' || !Number.isFinite(windowCap) || windowCap <= 0) {
    throw new Error(
      `refusing to admit anybody through the sub-gate arm: the window cap handed in is ${String(windowCap)}. ` +
        'It is stage2_entry.maxLaunchesPerCandidate for the recipe this run applies, and the tempo ' +
        'floor is derived from it rather than written down.',
    );
  }
  return {
    minCompletionRate,
    visitRefreshDays,
    // Quantised for the same reason the rotation quantises its key: a bar compared against a
    // floating-point division has to be reproducible from a record, and six decimals is what every
    // other derived figure in this tool is rounded to.
    minLaunchesPerDay: Number((windowCap / visitRefreshDays).toFixed(6)),
    maxDaysSinceLastLaunch: visitRefreshDays,
    windowCap,
  };
}

/**
 * @typedef {object} SubGateAssessment
 * @property {boolean} admitted
 * @property {string} rationale The sentence a record and a rendered line carry. **This module owns
 *   it rather than `rank.mjs`**, for the reason that module owns the gate's own: the wording is
 *   persisted forever and never retro-edited, so the arm's claim and its limits have to be written
 *   where the arm's argument is. It is built for BOTH outcomes — an admission states what it does
 *   and does not claim, a refusal names which condition refused — so no caller has to remember to
 *   append a caveat.
 * @property {string[]} reasons Why it was NOT admitted. Empty when it was.
 * @property {number | null} launchesPerDay The tempo this arm read, `null` when unreadable.
 * @property {number | null} daysSinceLastLaunch At the run's own instant, `null` when unreadable.
 * @property {SubGateBounds} bounds The bounds it was assessed against, so a record carries what it
 *   was judged on rather than what the file says today.
 */

/**
 * Decide whether a candidate the competence gate refused is nevertheless worth the spend.
 *
 * **CONDITION 1 — IT MUST FAIL ON THE RATE AND ON NOTHING ELSE.** The bars are re-checked
 * structurally rather than by reading {@link import('./rank.mjs').GateResult.reasons}, because
 * matching prose couples this decision to sentences that are rewritten whenever a captain decision
 * lands. `minTokens` (25) and `minSpanDays` (14) still bind unchanged: they are the sample-size and
 * evidence-window guarantees, without which a completion rate is not a reading at all, and the
 * chain-scale census measures them as nearly inert next to the bar this decision indicts — over the
 * 6,535 pump.fun deployers of 2026-07 clearing the other two, `minCompletionRate` alone removes
 * **6,477**, against 889 for `minTokens` and 12 for `minSpanDays`. So confining the loosening to the
 * indicted bar is what the evidence's own shape asks for.
 *
 * A candidate whose reading is UNMEASURED never reaches here: `verdictFor` returns
 * `gate-unmeasured` before any arm is consulted, and captain decisions 351 and 352b own why. An
 * absent measurement is not a sub-gate candidate — it is not a candidate at all yet.
 *
 * **CONDITION 2 — THE INFLOW FLOOR, AND IT IS NOT A SECOND COMPETENCE BAR.** Since captain decision
 * 352b the completion rate counts RAISE-85: net quote inflow into a token's own primary market
 * reaching 85 SOL-equivalent over its first 24 hours. So `rate × 85 SOL` is a statement about the
 * MONEY that reaches this deployer's launches, which is the pool an entrant's prize is a share of —
 * a spend-worthiness quantity, not the competence claim the 0.25 bar makes. The floor is pinned and
 * its derivation is `thresholds.json` → `stage1_gate.justification.subGateAdmission`.
 *
 * **CONDITION 3 — WINDOW SUPPLY, IN THE CURRENCY STAGE 2 ACTUALLY SPENDS.** A Stage 2 visit walks
 * up to `maxLaunchesPerCandidate` of a candidate's most recent windows and a verdict is read off
 * exactly those, so a candidate that cannot fill a visit, or that has stopped producing windows at
 * all, is a measurement that cannot be spent. Both bounds come off ONE horizon —
 * `visitRefreshDays`, the time the population the gate ALREADY admits takes to refresh a full
 * visit's worth of windows (`rotation.mjs`, captain decision 336a's own measurement). The tempo half
 * is the rotation's rank key; the recency half is the thing that key is blind to, and knowingly so:
 * `RotationRow.launchesPerDay` records that a LIFETIME tempo still visits a wallet that has gone
 * quiet, which is an accepted cost for ALLOCATION between wallets already judged worth measuring and
 * is not one for ADMISSION, where a verdict about a wallet that has stopped launching is unspendable.
 *
 * **AND THE UNIT IS NARROWER THAN THE HARVEST — a KNOWN LIMIT, stated rather than closed.** Both
 * quantities come from `measureCompletion`, computed over the launches that survive captain
 * decisions 351 and 352b, while Stage 2 visits `toLaunchRefs`'s UNFILTERED listing. So this
 * condition is measured in the currency Stage 2 spends only up to that mismatch, and the error runs
 * one way: a mayhem-heavy or criterion-unreadable deployer's flow is UNDERSTATED and the arm refuses
 * more often than its true flow warrants. See the two reads inside {@link assessSubGateAdmission},
 * which own the full statement, and `thresholds.json` →
 * `stage1_gate.justification.subGateAdmission`.
 *
 * **EVERY REFUSAL LEAVES THE CANDIDATE EXACTLY WHERE IT WAS.** This arm can only ADD; a candidate it
 * turns down keeps the `gate-failed` it already had, so a bound chosen too tight here cannot create
 * a rejection that did not already exist. That is the one direction this whole tool is allowed to
 * fail in, and it is why the bounds are sized from the population rather than widened to fit a
 * result.
 *
 * @param {{ completion: import('./measure.mjs').CompletionMeasurement,
 *           gate: import('./rank.mjs').GateResult, nowMs: number }} input
 * @param {{ minTokens: number, minCompletionRate: number, minSpanDays: number }} gateBars
 * @param {SubGateBounds} bounds
 * @returns {SubGateAssessment}
 */
export function assessSubGateAdmission(input, gateBars, bounds) {
  const { completion, gate } = input;
  /** @type {string[]} */
  const reasons = [];

  // KNOWN LIMIT, AND IT IS STATED HERE RATHER THAN CLOSED. Both window-supply quantities below are
  // read off `measureCompletion`'s output, whose `tokens`, `spanDays` and both deploy instants are
  // computed over the set that SURVIVES captain decisions 351 (no mayhem launch) and 352b (no launch
  // the RAISE-85 criterion could not be read on). Stage 2's visit list is not that set:
  // `measure.mjs` -> `toLaunchRefs` walks the vendor's `pump_tokens` UNFILTERED, so a launch this
  // arm does not count as supply is a launch a visit would still harvest.
  //
  // THE ERROR THEREFORE RUNS ONE WAY: a mayhem-heavy or criterion-unreadable deployer's flow is
  // UNDERSTATED — its tempo reads low against the derived floor and its last launch reads older than
  // it is — so the arm REFUSES more often than the true flow warrants. It can only fail to ADMIT,
  // never over-admit, and a refusal leaves the candidate with the `gate-failed` it already had,
  // which is why the mismatch is survivable in this direction and would not be in the other.
  // It is the same accepted limit `rotation.mjs` -> `RotationRow.launchesPerDay` already records for
  // the rank key, and that doc owns the argument rather than it being re-made here.
  //
  // RE-SOURCING THIS ARM'S TEMPO FROM THE UNFILTERED LISTING IS AN OPEN DECISION and is deliberately
  // not taken here: moving a bar and changing what it measures in one step leaves neither auditable.
  const launchesPerDay = launchesPerDayOf(completion);
  const lastMs = completion.lastDeployIso === null ? Number.NaN : Date.parse(completion.lastDeployIso);
  const daysSinceLastLaunch =
    Number.isFinite(lastMs) && Number.isFinite(input.nowMs)
      ? Number((Math.max(0, input.nowMs - lastMs) / 86_400_000).toFixed(2))
      : null;

  /** @returns {SubGateAssessment} */
  const result = () => {
    const admitted = reasons.length === 0;
    return {
      admitted,
      rationale: admitted
        ? `SUB-GATE ADMITTED (captain decision 451) — this wallet FAILED the competence gate ` +
          `(${gate.reasons.join('; ')}) and is admitted to Stage 2 anyway, through the second arm. ` +
          `It clears that arm's own spend-worthiness test: completion rate ` +
          `${completion.rate.toFixed(4)} >= ${bounds.minCompletionRate} of net quote inflow ` +
          `reaching RAISE-85, launch tempo ${String(launchesPerDay)} /day >= ` +
          `${bounds.minLaunchesPerDay} (one Stage 2 visit's ${bounds.windowCap} window(s) inside ` +
          `${bounds.visitRefreshDays} days), and last launched ${String(daysSinceLastLaunch)} days ` +
          `ago. ${SUB_GATE_ADMISSION_IS_NOT_A_FINDING} ${ARMS_ARE_NEVER_POOLED}`
        : `the sub-gate arm (captain decision 451) also refused it: ${reasons.join('; ')}`,
      reasons,
      launchesPerDay,
      daysSinceLastLaunch,
      bounds,
    };
  };

  // A candidate that PASSED the gate is arm A's and this function has nothing to say about it. It
  // is not an error to ask — `verdictFor` asks about everything it judges — so it is a refusal with
  // a reason rather than a throw, and the reason is deliberately readable in a record.
  if (gate.passed) {
    reasons.push('cleared the competence gate, so it is admitted through the gate arm and not this one');
    return result();
  }

  if (!(completion.tokens >= gateBars.minTokens)) {
    reasons.push(
      `sample too small for either arm: ${completion.tokens} tokens < ${gateBars.minTokens} required. ` +
        'Captain decision 451 loosens the completion-rate bar and NOT the sample-size bar, which is ' +
        'what makes any rate here a reading at all',
    );
  }
  if (!(completion.spanDays >= gateBars.minSpanDays)) {
    reasons.push(
      `evidence window too short for either arm: ${completion.spanDays.toFixed(1)} days < ` +
        `${gateBars.minSpanDays} required. Captain decision 451 loosens the completion-rate bar and ` +
        'NOT the span bar — a rate earned inside a burst is not a record on either arm',
    );
  }
  if (!Number.isFinite(completion.rate)) {
    // Unreachable through `verdictFor`, which returns `gate-unmeasured` on an undefined rate before
    // any arm is consulted. Stated anyway: this function is exported and a future caller must not be
    // able to admit a candidate on a rate that does not exist.
    reasons.push('the completion rate is undefined, so there is no reading for this arm to compare');
  } else if (!(completion.rate >= bounds.minCompletionRate)) {
    reasons.push(
      `completion rate ${completion.rate.toFixed(4)} < ${bounds.minCompletionRate} required by the ` +
        'sub-gate arm. Since captain decision 352b that rate is the share of this deployer\'s ' +
        'launches pulling 85 SOL-equivalent of net quote inflow in their first 24 hours, so this ' +
        'floor is on the money reaching the windows Stage 2 would measure, not on competence',
    );
  }

  if (launchesPerDay === null) {
    // Unreachable while the two bars above hold — `launchesPerDayOf` returns `null` only on a
    // non-positive token count or span. Refuses rather than assuming, and the refusal costs the
    // candidate nothing it had: it keeps the `gate-failed` it already carried.
    reasons.push(
      'launch tempo unreadable, so this arm cannot show that a Stage 2 visit to this wallet would ' +
        'cover new ground',
    );
  } else if (!(launchesPerDay >= bounds.minLaunchesPerDay)) {
    reasons.push(
      `launch tempo ${launchesPerDay} /day < ${bounds.minLaunchesPerDay} required — one Stage 2 ` +
        `visit harvests ${bounds.windowCap} window(s), and at this tempo that takes longer than the ` +
        `${bounds.visitRefreshDays} days the already-admitted population takes to refresh its own`,
    );
  }

  if (daysSinceLastLaunch === null) {
    reasons.push('no usable last-deploy instant, so this arm cannot show the wallet is still launching');
  } else if (!(daysSinceLastLaunch <= bounds.maxDaysSinceLastLaunch)) {
    reasons.push(
      `last launch ${daysSinceLastLaunch} days ago > ${bounds.maxDaysSinceLastLaunch} allowed — the ` +
        'tempo above is a LIFETIME reading and is blind to a wallet that has gone quiet, and a ' +
        'verdict about a wallet that has stopped launching cannot be spent',
    );
  }

  return result();
}

/**
 * Whether a verdict is one Stage 2 scores.
 *
 * **THE ONE PLACE THE TWO ARMS ARE UNIONISED, AND IT DECIDES WHO IS MEASURED — NEVER WHAT IS
 * COUNTED.** Selecting a population to spend a keyless walk on is the only legitimate use of the
 * union; the moment a count, a rate or an interval is taken over it, the figure has two denominators
 * and {@link ARMS_ARE_NEVER_POOLED} is broken. `test/deployer-screen.test.ts` → "451: the two arms
 * are never pooled into one statistic" enumerates this predicate's call sites as a source fact for
 * exactly that reason, so a third caller fails the suite rather than quietly publishing a pooled
 * number.
 *
 * @param {import('./rank.mjs').Verdict} verdict
 * @returns {boolean}
 */
export function admittedToStage2(verdict) {
  return verdict === 'gate-passed' || verdict === 'sub-gate-admitted';
}

/**
 * Which arm a verdict represents, for the record row and the rendered block.
 *
 * `null` for a candidate no arm admitted, which is NOT a third arm: it is a rejection or an absent
 * measurement, and both already have their own verdict.
 *
 * @param {import('./rank.mjs').Verdict} verdict
 * @returns {AdmissionArm | null}
 */
export function admissionArmOf(verdict) {
  if (verdict === 'gate-passed') return 'gate';
  if (verdict === 'sub-gate-admitted') return 'sub-gate';
  return null;
}
