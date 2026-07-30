/**
 * Gate verdicts and ordering. Pure: takes measurements and thresholds, returns a decision.
 *
 * **This tool gates. It does not recommend.** That is a scope statement, not modesty, and the
 * whole module is shaped around it:
 *
 * - A completion rate says a deployer is **competent**. It says nothing about whether there is
 *   money in it for us, and we hold proof of the gap rather than a worry about it. Our subject
 *   deployer completes 43% of its launches — genuinely good, and it clears every threshold here
 *   comfortably — while its opening window has been unprofitable for outsiders since 2026-06-04,
 *   because the operation's own group takes 97% of the profit available there
 *   (`data/slot-zero-june-regime-change/report.md` §6.1). A completion-rate ranking would have
 *   put that wallet first.
 * - Stage 0 makes that concrete: it asserts the gate **passes** the one deployer we already know
 *   is not worth the time. A gate that could not do that would be hiding the limitation instead
 *   of demonstrating it.
 * - So the strongest verdict this module emits is {@link Verdict} `gate-passed`, meaning *worth
 *   scoring*, and the language that ships with it says so. Scoring is Stage 2, which is
 *   deliberately unbuilt here — see `thresholds.json` → `stage2_seam`.
 */

/**
 * The complete verdict vocabulary of the gate. Note what is absent: nothing here says a wallet is
 * worth trading, or worth entering, or good. `gate-passed` means one thing — it survived the
 * competence filter and is eligible for the measurement that has not been built yet.
 *
 * @typedef {'gate-passed' | 'gate-failed'} Verdict
 */

/**
 * @typedef {object} GateInput
 * @property {import('./measure.mjs').CompletionMeasurement} completion
 * @property {boolean} capped Whether the vendor's token page was full, meaning older tokens exist
 *   that this surface will not show.
 */

/**
 * @typedef {object} GateResult
 * @property {boolean} passed
 * @property {string[]} reasons Why it failed. Empty when it passed.
 */

/**
 * Apply the Stage 1 completion gate.
 *
 * @param {GateInput} input
 * @param {{ minTokens: number, minCompletionRate: number, minSpanDays: number }} t
 * @returns {GateResult}
 */
export function applyGate(input, t) {
  const { completion } = input;
  /** @type {string[]} */
  const reasons = [];

  if (completion.tokens < t.minTokens) {
    reasons.push(
      `sample too small: ${completion.tokens} tokens < ${t.minTokens} required` +
        (completion.tokens > 0 ? '' : ' (the vendor listed no tokens with a usable deploy time)'),
    );
  }
  if (!Number.isFinite(completion.rate)) {
    reasons.push('completion rate is undefined (no usable token records)');
  } else if (completion.rate < t.minCompletionRate) {
    reasons.push(`completion rate ${completion.rate.toFixed(4)} < ${t.minCompletionRate} required`);
  }
  if (completion.spanDays < t.minSpanDays) {
    reasons.push(
      `history spans ${completion.spanDays.toFixed(1)} days < ${t.minSpanDays} required ` +
        `(a rate earned inside a burst is not a record)`,
    );
  }

  return { passed: reasons.length === 0, reasons };
}

/**
 * @typedef {object} ConsistencyResult
 * @property {'measured' | 'unmeasured'} state
 * @property {number} epochs
 * @property {number} minEpochRate
 * @property {number} maxEpochRate
 * @property {number} dispersion
 * @property {boolean} streaky
 * @property {string} note
 */

/**
 * @typedef {object} Candidate
 * @property {string} wallet
 * @property {string[]} seededBy  Which enumeration queries surfaced it. Provenance, so a rerun
 *   can tell a leaderboard artefact from a genuinely recurring name.
 * @property {import('./measure.mjs').CompletionMeasurement} completion
 * @property {boolean} completionCapped
 * @property {GateResult} gate
 * @property {Verdict} verdict
 * @property {string} rationale
 * @property {ConsistencyResult | null} consistency `null` unless `--consistency` was passed.
 */

/**
 * Turn a gate result into a verdict and a sentence a human can act on.
 *
 * The `gate-passed` wording is load-bearing. It says *eligible for scoring*, names the fact that
 * the profit leg is unmeasured, and never uses a word like "candidate" or "gem" unqualified,
 * because a later reader will quote this line out of context.
 *
 * @param {{ gate: GateResult, completion: import('./measure.mjs').CompletionMeasurement,
 *           capped: boolean }} input
 * @returns {{ verdict: Verdict, rationale: string }}
 */
export function verdictFor(input) {
  if (!input.gate.passed) {
    return {
      verdict: 'gate-failed',
      rationale: `did not clear the completion gate: ${input.gate.reasons.join('; ')}`,
    };
  }

  const c = input.completion;
  return {
    verdict: 'gate-passed',
    rationale:
      `completed ${c.completed}/${c.tokens} launches (${(c.rate * 100).toFixed(1)}%) over ` +
      `${c.spanDays.toFixed(0)} days` +
      (input.capped ? ', on a TRUNCATED page so older launches exist that this surface hides' : '') +
      `. Competent enough to be worth measuring. NOT a recommendation: whether this deployer ` +
      `leaves an outsider any room, and whether that room is profitable, is UNMEASURED here.`,
  };
}

/**
 * Order candidates for presentation.
 *
 * Ordered by completion rate **only within the passed and failed classes**, and that ordering is
 * presentational rather than a ranking claim: `render.mjs` prints it as a table of gate results,
 * not as a league table. When Stage 2 lands, the sort key becomes room-left and completion rate
 * stops being an ordering input at all — which is the point of keeping this function small.
 *
 * The final tiebreak is the wallet address, so two runs over the same data produce byte-identical
 * output.
 *
 * @param {readonly Candidate[]} candidates
 * @returns {Candidate[]}
 */
export function rankCandidates(candidates) {
  /** @type {Record<Verdict, number>} */
  const classOrder = { 'gate-passed': 0, 'gate-failed': 1 };

  return [...candidates].sort((a, b) => {
    const cls = classOrder[a.verdict] - classOrder[b.verdict];
    if (cls !== 0) return cls;

    // Larger sample first, then higher rate. Sample size leads deliberately: a 0.9 over 26
    // tokens is weaker evidence than a 0.5 over 70, and putting the rate first would invert that.
    if (a.completion.tokens !== b.completion.tokens) {
      return b.completion.tokens - a.completion.tokens;
    }
    const ar = Number.isFinite(a.completion.rate) ? a.completion.rate : -1;
    const br = Number.isFinite(b.completion.rate) ? b.completion.rate : -1;
    if (ar !== br) return br - ar;

    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });
}

/**
 * Bucket token records into fixed-length epochs and report the spread of the rate across them.
 *
 * This is the only place a long-horizon "consistently" claim can come from, and it is off by
 * default: MadeOnSol's usable denominator spans about 35 days, and building a multi-month claim
 * on a 35-day window is precisely the defect their own aggregate has. Reaching this function
 * requires `--consistency`, which pages a keyless pump.fun creator listing and spends no quota.
 *
 * A high dispersion **flags** rather than excludes. The reader is entitled to see that a rate came
 * from one hot epoch; silently filtering on it would hide the very fact it exists to expose.
 *
 * @param {readonly import('./measure.mjs').TokenRecord[]} records
 * @param {{ minEpochs: number, minTokensPerEpoch: number, epochDays: number, maxDispersion: number }} t
 * @returns {ConsistencyResult}
 */
export function measureConsistency(records, t) {
  const usable = records
    .filter((r) => Number.isFinite(r.deployedAtMs) && r.deployedAtMs > 0)
    .sort((a, b) => a.deployedAtMs - b.deployedAtMs);

  /** @param {string} note @returns {ConsistencyResult} */
  const unmeasured = (note) => ({
    state: 'unmeasured',
    epochs: 0,
    minEpochRate: Number.NaN,
    maxEpochRate: Number.NaN,
    dispersion: Number.NaN,
    streaky: false,
    note,
  });

  const newest = usable[usable.length - 1];
  if (newest === undefined) return unmeasured('no usable token records');

  const epochMs = t.epochDays * 86_400_000;
  /** @type {Map<number, { n: number, completed: number }>} */
  const buckets = new Map();
  for (const r of usable) {
    // Bucket backwards from the newest record, so the most recent epoch is always a whole one.
    const idx = Math.floor((newest.deployedAtMs - r.deployedAtMs) / epochMs);
    const b = buckets.get(idx) ?? { n: 0, completed: 0 };
    b.n += 1;
    if (r.completed) b.completed += 1;
    buckets.set(idx, b);
  }

  const qualifying = [...buckets.values()].filter((b) => b.n >= t.minTokensPerEpoch);
  if (qualifying.length < t.minEpochs) {
    return unmeasured(
      `only ${qualifying.length} of ${buckets.size} ${t.epochDays}-day epochs carry the ` +
        `${t.minTokensPerEpoch} tokens needed for a rate; ${t.minEpochs} qualifying epochs required`,
    );
  }

  const rates = qualifying.map((b) => b.completed / b.n);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const dispersion = max - min;

  return {
    state: 'measured',
    epochs: qualifying.length,
    minEpochRate: min,
    maxEpochRate: max,
    dispersion,
    streaky: dispersion > t.maxDispersion,
    note:
      `${qualifying.length} qualifying ${t.epochDays}-day epochs, rate ${min.toFixed(3)}..${max.toFixed(3)}` +
      (dispersion > t.maxDispersion
        ? `; STREAKY — spread ${dispersion.toFixed(3)} exceeds ${t.maxDispersion}, so the pooled rate is carried by some epochs and not others`
        : `; spread ${dispersion.toFixed(3)} within ${t.maxDispersion}`),
  };
}
