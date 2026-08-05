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
 *   (`slot-zero-june-regime-change/report.md` §6.1). A completion-rate ranking would have
 *   put that wallet first.
 * - Stage 0 makes that concrete: it asserts the gate **passes** the one deployer we already know
 *   is not worth the time. A gate that could not do that would be hiding the limitation instead
 *   of demonstrating it.
 * - So the strongest verdict this module emits is {@link Verdict} `gate-passed`, meaning *worth
 *   scoring*, and the language that ships with it says so. The scoring itself is Stage 2, and it
 *   lives in `entry.mjs` with **its own verdict vocabulary** — `entry-open-after-costs` and friends —
 *   deliberately not folded into this one. Competence and entry room are different claims about a
 *   wallet, and a single merged verdict could not be read back apart into which leg carried it.
 */

/**
 * The complete verdict vocabulary of the gate. Note what is absent: nothing here says a wallet is
 * worth trading, or worth entering, or good. `gate-passed` means one thing — it survived the
 * competence filter and is eligible for the measurement that has not been built yet.
 *
 * `gate-unmeasured` is the third value and it is **not a rejection**. The history a candidate is
 * judged on can be incomplete in ways the thresholds cannot see: a launch whose bonded status
 * neither the on-chain curve nor the ownership listing can answer, or an ownership listing that
 * failed to read at all. A `gate-failed` carrying an ordinary rationale over a reading that was
 * never actually taken is precisely the invisible false rejection this tool exists to remove, so
 * the state lives in the VERDICT and not only in the wording beside it — a reader filtering a run
 * record on `verdict` must not be able to miss it.
 *
 * @typedef {'gate-passed' | 'gate-unmeasured' | 'gate-failed'} Verdict
 */

/**
 * @typedef {object} GateInput
 * @property {import('./measure.mjs').CompletionMeasurement} completion
 * @property {'creation-derived' | 'ownership-only'} [historySource] Which reading `completion` was
 *   computed over. It cannot move a verdict — see below — and exists only so a zero-token rejection
 *   names the right party. Defaults to the ownership reading, which is what an unlabelled caller is.
 *
 * Page truncation is deliberately **not** an input. The gate decides on the three pinned
 * thresholds and nothing else; that the vendor's page was full is disclosed by
 * {@link verdictFor} and carried in the record, but it must not be able to move a verdict, and a
 * field the gate never reads would imply otherwise.
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
    // A zero has to name the party it actually came from. Under the creation-derived reading the
    // vendor can have listed plenty — the merge is what produced the zero — and blaming the vendor
    // sends an operator to the wrong place to look. Observed live: a wallet whose vendor profile
    // carried 11 tokens and whose listing served 11 rows was rejected for "the vendor listed no
    // tokens".
    const zeroBlame =
      input.historySource === 'creation-derived'
        ? ' (the creation-derived history came out empty — see this candidate\'s `creation` block ' +
          'for what the walk covered and what the merge did with the ownership listing)'
        : ' (the vendor listed no tokens with a usable deploy time)';
    reasons.push(
      `sample too small: ${completion.tokens} tokens < ${t.minTokens} required` +
        (completion.tokens > 0 ? '' : zeroBlame),
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
 * @property {boolean} historyTruncated Whether the creator walk stopped at its page cap. See
 *   {@link measureConsistency} — this is the one surface here making a long-horizon claim, so the
 *   fact that it was computed over a bounded, lower-bound listing travels with the result.
 * @property {string} note
 */

/**
 * @typedef {object} CreationReading
 * What the creation-derived walk found, and every bound that shaped it.
 *
 * Recorded whole rather than reduced to the two counts the gate uses. The counts alone would let a
 * two-day window read exactly like a two-year one, and this project has already shipped two wrong
 * committed numbers to silent truncation that looked like healthy data.
 * @property {string | null} coveredFromIso
 * @property {string | null} coveredToIso
 * @property {number} coveredDays
 * @property {boolean} wholeHistory True only when the walk reached the end of the wallet's
 *   signature index. Under anything else the window is a ceiling, not a record.
 * @property {'index-exhausted' | 'page-cap' | 'transaction-cap' | 'request-ceiling' | 'upstream-error' | 'credit-ceiling' | 'dune-enumerated'} stopReason
 *   `credit-ceiling` reaches only the indexed (Helius) walk, whose provider bills by transactions
 *   returned rather than by request. It is a ceiling like the others and means the same thing about
 *   the window: it is a bound, not a history.
 *   `dune-enumerated` is the ONE value that is not a stop at all: nothing was walked, so nothing
 *   stopped. The window is the coverage probe's own bound and `wholeHistory` is true inside it.
 * @property {string | null} stopDetail
 * @property {number} rpcRequests
 * @property {number} loadShedEvents
 * @property {number} signaturesScanned
 * @property {number} signaturesSucceeded
 * @property {number} transactionsInspected
 * @property {number} unresolvedTransactions Transactions the endpoint never returned, retry
 *   included. Non-zero means the window is NOT exact, and `windowExact` below says so.
 * @property {number} curvesUnread Creations whose curve account went unread. Their bonded status
 *   falls back to the ownership listing; `bondedUndecidable` is what neither source could answer.
 * @property {number} listingRows
 * @property {boolean} listingPageCapped
 * @property {string | null} listingUnmeasuredNote Why the ownership listing could not be read at
 *   all, when it could not. Non-null makes the whole reading unmeasured — the listing supplies
 *   everything before the creation window, so without it the history is a fragment.
 * @property {number} createdInWindow
 * @property {number} listedInWindow
 * @property {number} hiddenByOwnership Created inside the window, absent from the ownership
 *   surface. The under-count this whole route exists to measure.
 * @property {number} notCreatedByWallet
 * @property {number} movedCreator
 * @property {number} listedOutsideWindow
 * @property {number} listedInWindowCarried
 * @property {boolean} windowExact
 * @property {number} bondedFromCurve Launches whose bonded status came from the chain's own
 *   statement — the curve's `complete` byte, or the `CompleteEvent` the same transition emits.
 * @property {number} bondedFromListing Launches whose bonded status came from the listing's flag.
 * @property {number} bondedUndecidable Launches neither source could answer for. Any non-zero
 *   value makes the candidate's verdict `gate-unmeasured`.
 * @property {'dune' | 'helius' | 'keyless-rpc'} enumerationSource Which surface answered "which
 *   mints did this wallet create" for THIS candidate. Per-candidate rather than per-run because the
 *   Dune coverage probe refuses a wallet at a time: a wallet whose earliest launch sits at or before
 *   the probed surfaces' own first row falls back to the walk while the rest of the batch does not.
 * @property {number | null} duneLaunches Launches the Dune enumeration attributed to this wallet,
 *   `null` when Dune was not consulted. Kept even when the reading FELL BACK, so a record shows what
 *   the refused answer would have said rather than only that it was refused. **On a candidate the
 *   per-deployer row cap truncated this is a PREFIX, not a count**: it is how many rows came back,
 *   while the true count the answer declared appears only in the `duneFallbackReasons` sentence. So
 *   a large disagreement between this and the walk's own total on a cap-refused candidate is the
 *   contract working, not two broken surfaces — read the reason before diffing the two.
 * @property {string[]} duneFallbackReasons Why this candidate did not use the Dune reading, empty
 *   when it did. **An empty list on a `keyless-rpc`/`helius` source means Dune was never consulted
 *   at all** — no key, `--no-dune`, or `--ownership-only`; the run-level `dune` block says which.
 * @property {number} creatorMovementUnmeasured Launches whose curve state came from a route that
 *   does not report a current creator. `movedCreator` says nothing about these — the Dune
 *   enumeration answers who created a mint and whether it completed, and nothing about who owns the
 *   curve today. Do not add the two.
 * @property {number | null} mayhemLaunches How many of this candidate's enumerated launches carry
 *   pump.fun's `is_mayhem_mode` flag — captain decision 227a, and an OBSERVATION. Nothing in this
 *   module or any other reads it: it reaches no gate, bar, rate or verdict, and no launch is
 *   dropped or weighted for carrying it. `dune.mjs` → `MAYHEM_OBSERVATION_ONLY` owns the rule and
 *   the evidence behind it.
 * @property {number | null} mayhemFlagReadable The share's DENOMINATOR — launches the flag was
 *   readable on. **Not `duneLaunches`**: `pump_call_create` has no such column, so a history
 *   reaching back past `pump_evt_createevent` holds launches with nothing to read, and the
 *   difference between these two fields is how many.
 * @property {number | null} mayhemShare `mayhemLaunches / mayhemFlagReadable`.
 *
 *   **All three are `null` on a candidate the creation WALK answered, and `null` is UNMEASURED,
 *   never 0%.** The flag is a column on Dune's decoded create event; the walk reads transactions
 *   and curve accounts and cannot see it. This is `creatorMovementUnmeasured`'s trap running the
 *   other way — there the Dune route is the blind one — so read `enumerationSource` beside both.
 */

/**
 * @typedef {object} Candidate
 * @property {string} wallet
 * @property {string[]} seededBy  Which enumeration queries surfaced it. Provenance, so a rerun
 *   can tell a leaderboard artefact from a genuinely recurring name.
 * @property {import('./measure.mjs').CompletionMeasurement} completion The history the gate read.
 * @property {boolean} completionCapped Whether the surface the GATE'S reading came from was page
 *   capped — the ownership listing under `creation-derived`, the vendor profile under
 *   `ownership-only`. Distinct from {@link Candidate.vendorPageCapped}, which always describes the
 *   vendor profile: showing the vendor's cap flag beside a creation-derived count would describe a
 *   surface the number did not come from.
 * @property {GateResult} gate
 * @property {Verdict} verdict
 * @property {string} rationale
 * @property {ConsistencyResult | null} consistency `null` unless `--consistency` was passed.
 * @property {import('./entry.mjs').EntryScore | null} entry Stage 2's ENTRY score. `null` when the
 *   candidate did not clear the gate, `--no-stage2` was passed, or the scoring cap dropped it.
 *   Deliberately a separate field with its own verdict vocabulary rather than a component of
 *   {@link Verdict}: competence and entry room are different claims, and collapsing them would put
 *   this module back in the business of recommending.
 * @property {import('./stage2.mjs').Stage2Coverage | null} entryCoverage
 * @property {'creation-derived' | 'ownership-only'} historySource
 * @property {import('./measure.mjs').CompletionMeasurement} vendorCompletion The ownership-derived
 *   reading this gate used before creation-derived history landed. Kept so the gap stays visible.
 * @property {Verdict} vendorVerdict What the old reading would have decided.
 * @property {boolean} vendorPageCapped Whether MadeOnSol's profile page was full.
 * @property {CreationReading | null} creation `null` under `--ownership-only`.
 */

/**
 * Turn a gate result into a verdict and a sentence a human can act on.
 *
 * The `gate-passed` wording is load-bearing. It says *eligible for scoring*, names the fact that
 * the profit leg is unmeasured, and never uses a word like "candidate" or "gem" unqualified,
 * because a later reader will quote this line out of context.
 *
 * `notMeasured` outranks the gate itself. When the reading the thresholds were applied to is
 * incomplete, the thresholds have not decided anything, and the rationale says so in the same
 * breath as the verdict rather than qualifying an otherwise ordinary sentence.
 *
 * @param {{ gate: GateResult, completion: import('./measure.mjs').CompletionMeasurement,
 *           capped: boolean, notMeasured?: readonly string[] }} input
 * @returns {{ verdict: Verdict, rationale: string }}
 */
export function verdictFor(input) {
  const notMeasured = input.notMeasured ?? [];
  if (notMeasured.length > 0) {
    return {
      verdict: 'gate-unmeasured',
      rationale:
        `GATE UNMEASURED — this is NOT a rejection and NOT a pass. The launch history the gate ` +
        `would have judged is incomplete: ${notMeasured.join('; ')}. On that incomplete reading ` +
        `the thresholds would have ${input.gate.passed ? 'passed' : 'failed'} it, which is not a ` +
        `result and must not be quoted as one. Absence of a finding here is not a finding; rerun ` +
        `to measure this wallet.`,
    };
  }

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
 * Presentational rather than a ranking claim: `render.mjs` prints the result as a table of measured
 * results, not as a league table. Three keys, in this order:
 *
 * 1. **Gate class.** Survivors, then candidates whose reading was never measured, then rejections.
 *    `gate-unmeasured` sits between the two because it is neither: sorting it with the rejections
 *    would bury a wallet nobody has judged among the wallets that were judged and failed. The map
 *    is total over {@link Verdict} — an unhandled value would make the comparator return NaN, which
 *    is not a strict weak ordering and would silently break the byte-identical-output guarantee.
 * 2. **Measured entry room, descending** — the promise the Stage 1 lane made when it left the seam:
 *    once Stage 2 landed, room-left would become the sort key. A candidate with **no** entry score
 *    sorts *after* every scored one rather than being interleaved at some imputed room, because an
 *    unscored candidate is not a low-room candidate and the two must not look alike in a list.
 * 3. **Completion rate**, as the tiebreak among equally-unscored candidates only. Larger sample
 *    first, then higher rate: a 0.9 over 26 tokens is weaker evidence than a 0.5 over 70, and
 *    putting the rate first would invert that.
 *
 * The final tiebreak is the wallet address, so two runs over the same data produce byte-identical
 * output.
 *
 * @param {readonly Candidate[]} candidates
 * @returns {Candidate[]}
 */
export function rankCandidates(candidates) {
  /** @type {Record<Verdict, number>} */
  const classOrder = { 'gate-passed': 0, 'gate-unmeasured': 1, 'gate-failed': 2 };
  /** @param {Candidate} c @returns {number} */
  const roomKey = (c) =>
    c.entry === null || !Number.isFinite(c.entry.roomLeft.median) ? Number.NEGATIVE_INFINITY : c.entry.roomLeft.median;

  return [...candidates].sort((a, b) => {
    const cls = classOrder[a.verdict] - classOrder[b.verdict];
    if (cls !== 0) return cls;

    const ra = roomKey(a);
    const rb = roomKey(b);
    if (ra !== rb) return rb - ra;

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
 * `historyTruncated` is a required argument rather than an optional flourish, because the two limits
 * on the walk that produced `records` are exactly the ones a long-horizon claim must not hide: the
 * walk is capped at a few pages, **and** pump.fun lists by *current* creator, which moves on-chain.
 * So the history is a lower bound and the token most likely missing is the deployer's best one — the
 * same trap that once deleted our own subject's `maxxing` launch from its own history. A dispersion
 * figure computed over that has to say so.
 *
 * @param {readonly import('./measure.mjs').TokenRecord[]} records
 * @param {{ minEpochs: number, minTokensPerEpoch: number, epochDays: number, maxDispersion: number }} t
 * @param {boolean} [historyTruncated] Whether the creator walk hit its page cap.
 * @returns {ConsistencyResult}
 */
export function measureConsistency(records, t, historyTruncated = false) {
  const lowerBound =
    '; the creator listing is a LOWER BOUND — it lists by *current* creator, which moves on-chain, ' +
    'and the token that goes missing is the best one' +
    (historyTruncated ? ', and this walk also stopped at its page cap' : '');

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
    historyTruncated,
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
    historyTruncated,
    note:
      `${qualifying.length} qualifying ${t.epochDays}-day epochs, rate ${min.toFixed(3)}..${max.toFixed(3)}` +
      (dispersion > t.maxDispersion
        ? `; STREAKY — spread ${dispersion.toFixed(3)} exceeds ${t.maxDispersion}, so the pooled rate is carried by some epochs and not others`
        : `; spread ${dispersion.toFixed(3)} within ${t.maxDispersion}`) +
      lowerBound,
  };
}
