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

// The pure measurement core, and the ONLY runtime edge this module has. It takes the two RAISE-85
// constants rather than restating them, because a bar written twice is a bar that can be moved once
// (captain decision 352b; `measure.mjs` → `RAISE_85_SOL_BAR` owns why it does not move at all).
import { RAISE_85_SOL_BAR, RAISE_85_WINDOW_HOURS } from './measure.mjs';

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
 * Whether the mayhem exclusion is what left a competence reading with nothing to measure.
 *
 * Captain decision 351 removes a known-mayhem launch from BOTH sides of the completion rate
 * (`measure.mjs` → `measureCompletion` owns the argument). A deployer whose launches are ALL mayhem
 * therefore ends with a denominator of zero — and **zero of zero is an absent measurement, not a
 * failing rate.** The distinction is the whole reason the exclusion could take the denominator with
 * it without becoming captain decision 227c, *excluding mayhem-heavy deployers outright*, which is
 * NOT reversed and remains declined: a rate of 0.0000 rejects, an undefined reading does not.
 *
 * So this predicate exists to keep those two apart at the one place a verdict is decided, rather
 * than leaving it to a caller to remember. It is deliberately narrow — it fires only where the
 * exclusion actually removed something — so an ordinarily empty history keeps the `gate-failed` it
 * has always had, and this lane does not quietly widen what counts as unmeasured.
 *
 * @param {import('./measure.mjs').CompletionMeasurement} completion
 * @returns {boolean}
 */
export function competenceEmptiedByMayhem(completion) {
  return completion.mayhemExcluded > 0 && completion.tokens === 0;
}

/**
 * Whether the criterion-unreadable exclusion is what left a competence reading with nothing to
 * measure.
 *
 * The sibling of {@link competenceEmptiedByMayhem} and it exists for the same reason: captain
 * decision 352b removes from BOTH sides a launch RAISE-85 could not be read on, so a deployer none
 * of whose launches could be read ends with a denominator of zero — and **zero of zero is an absent
 * measurement, not a failing rate.** Here the point is sharper still, because what emptied the
 * reading is OUR OWN COVERAGE rather than anything about the deployer, and reading that as 0.0000
 * is the invisible false rejection this tool exists to remove.
 *
 * Narrow in the same way: it fires only where the exclusion actually removed something, so an
 * ordinarily empty history keeps the `gate-failed` it has always had.
 *
 * @param {import('./measure.mjs').CompletionMeasurement} completion
 * @returns {boolean}
 */
export function competenceEmptiedByCriterion(completion) {
  return completion.criterionUnreadable > 0 && completion.tokens === 0;
}

/**
 * The clause every gate sentence and every verdict rationale appends when RAISE-85 could not be
 * read on part of the history — captain decision 352b.
 *
 * Written once because it is stated in four places and this repo never retro-edits a record: a
 * candidate row carries these sentences forever, so an overstatement in one of them is permanent.
 * It claims only what the measurement supports — a count of launches that left the rate, and the
 * reason they left — and it never reads as a second population, which is the mistake
 * {@link applyGate}'s mayhem note is written to avoid one exclusion over.
 *
 * @param {import('./measure.mjs').CompletionMeasurement} completion
 * @param {boolean} emptied Whether the exclusion is what left the reading with nothing at all.
 * @returns {string} Empty when nothing was excluded, so a caller can concatenate unconditionally.
 */
export function criterionNoteFor(completion, emptied) {
  if (completion.criterionUnreadable === 0) return '';
  return emptied
    ? ` — the completion criterion (RAISE-85, captain decision 352b) could not be read on any of ` +
        `the ${completion.criterionUnreadable} launch(es) that reached it, and a launch no surface ` +
        `could measure is excluded from both sides rather than scored as a failure`
    : ` — a further ${completion.criterionUnreadable} launch(es) are excluded from both sides ` +
        `because the completion criterion (RAISE-85, captain decision 352b) could not be read on ` +
        `them at all, which is OUR coverage and not this deployer's record`;
}

/**
 * Apply the Stage 1 completion gate.
 *
 * **The three bars read the NON-MAYHEM history** since captain decision 351 — `tokens`, `rate` and
 * `spanDays` all describe the launches that survived the exclusion, because they are three
 * statements about one sample and a rate computed over one set with a count taken over another is
 * exactly the "two achievements through one number" defect 351 exists to fix. Both counts of what
 * was set aside travel on the measurement, and the rejection sentences below name them.
 *
 * @param {GateInput} input
 * @param {{ minTokens: number, minCompletionRate: number, minSpanDays: number }} t
 * @returns {GateResult}
 */
export function applyGate(input, t) {
  const { completion } = input;
  /** @type {string[]} */
  const reasons = [];

  // Captain decision 351: whenever the exclusion removed anything, every rejection sentence below
  // has to say so. "Sample too small" or "rate 0.0000" over a history that plainly holds launches
  // sends an operator looking for a truncated walk that is not there, and hides the one fact that
  // decides how to read the number — that what remains is this deployer's NON-MAYHEM record.
  // The emptied-denominator sentence, in the one wording every bar below uses. It claims only what
  // the measurement supports: `measureCompletion` drops a launch with no usable deploy time BEFORE
  // the mayhem filter, so a non-mayhem launch can have left this reading for an unrelated reason
  // and "every launch is mayhem" would be false about it. Every sentence here is persisted on the
  // candidate row and this repo never retro-edits a record, so an overstatement there is permanent.
  const emptied = competenceEmptiedByMayhem(completion);
  const emptiedByMayhem =
    `the competence measure was left with no non-mayhem launch to read: ` +
    `${completion.mayhemExcluded} launch(es) carry pump.fun's mayhem-mode flag` +
    (completion.droppedNoTimestamp > 0
      ? `, and a further ${completion.droppedNoTimestamp} had no usable deploy time and are NOT ` +
        `part of that count`
      : '');

  // NO REASON STATES THE MAYHEM COUNT TWICE, and none of them may read as a SECOND set of launches.
  // "a further N" is what the exclusion removed from a sample that still holds something; where the
  // exclusion emptied the sample there is nothing for it to be further to, and a reader of
  // "0 tokens ... a further 2" totals more launches than the wallet has.
  const mayhemNote =
    completion.mayhemExcluded === 0
      ? ''
      : emptied
        ? ` — ${emptiedByMayhem} (captain decision 351)`
        : ` — measured on the NON-MAYHEM record: a further ${completion.mayhemExcluded} launch(es) ` +
          `carry pump.fun's mayhem-mode flag and are excluded from both sides of this rate ` +
          `(captain decision 351)`;

  // Captain decision 352b, and it rides on the SAME sentences rather than on a field beside them,
  // for the reason 351's note does: these lines are what a later reader quotes out of context, and
  // a rate measured over part of a history has to say so where it is stated. The two notes are
  // concatenated and never merged — *not competence evidence* and *nothing could measure this*
  // answer different questions, and one "unknown" would make the rate unauditable.
  const criterionNote = criterionNoteFor(completion, competenceEmptiedByCriterion(completion));
  const notes = mayhemNote + criterionNote;

  if (completion.tokens < t.minTokens) {
    // A zero has to name the party it actually came from. Under the creation-derived reading the
    // vendor can have listed plenty — the merge is what produced the zero — and blaming the vendor
    // sends an operator to the wrong place to look. Observed live: a wallet whose vendor profile
    // carried 11 tokens and whose listing served 11 rows was rejected for "the vendor listed no
    // tokens". The mayhem exclusion is a THIRD party that can produce the same zero, and it takes
    // precedence when it applies, for the same reason: it is where the launches actually went.
    const zeroBlame = emptied
      ? ` (${emptiedByMayhem} — an ABSENT measurement, not a rate of 0)`
      : competenceEmptiedByCriterion(completion)
        ? ` (the completion criterion could not be read on any launch that reached it — an ABSENT ` +
          `measurement, not a rate of 0)`
        : input.historySource === 'creation-derived'
          ? ' (the creation-derived history came out empty — see this candidate\'s `creation` block ' +
            'for what the walk covered and what the merge did with the ownership listing)'
          : ' (the vendor listed no tokens with a usable deploy time)';
    reasons.push(
      `sample too small: ${completion.tokens} tokens < ${t.minTokens} required` +
        (completion.tokens > 0 ? '' : zeroBlame) +
        (emptied ? criterionNote : notes),
    );
  }
  if (!Number.isFinite(completion.rate)) {
    reasons.push(
      emptied
        ? `completion rate is undefined (${emptiedByMayhem} — captain decision 351; this is NOT a ` +
          `rate of 0 and NOT a rejection, see the verdict)${criterionNote}`
        : competenceEmptiedByCriterion(completion)
          ? `completion rate is undefined${criterionNote} — this is NOT a rate of 0 and NOT a ` +
            `rejection, see the verdict`
          : 'completion rate is undefined (no usable token records)',
    );
  } else if (completion.rate < t.minCompletionRate) {
    reasons.push(
      `completion rate ${completion.rate.toFixed(4)} < ${t.minCompletionRate} required${notes}`,
    );
  }
  if (completion.spanDays < t.minSpanDays) {
    reasons.push(
      `history spans ${completion.spanDays.toFixed(1)} days < ${t.minSpanDays} required ` +
        `(a rate earned inside a burst is not a record)` +
        notes,
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
 *   **Since captain decision 298a there is no third meaning.** A candidate that fell back while the
 *   leg WAS consulted always carries a sentence, including when the leg failed as a whole and every
 *   candidate carries the same one — such an entry starts with `dune.mjs` → `DUNE_LEG_FAILED`, so a
 *   run-wide failure reads apart from a per-wallet refusal. On a record written before schema 17's
 *   `thresholdsVersion` reached 6.3.0 an empty list on a walked candidate may still be either;
 *   `runs/2026-08-04.json` is the case — 82 walked candidates, all empty, one whole-leg failure.
 * @property {number} creatorMovementUnmeasured Launches whose curve state came from a route that
 *   does not report a current creator. `movedCreator` says nothing about these — the Dune
 *   enumeration answers who created a mint and whether it completed, and nothing about who owns the
 *   curve today. Do not add the two.
 * @property {number | null} mayhemLaunches How many of this candidate's ENUMERATED launches carry
 *   pump.fun's `is_mayhem_mode` flag — captain decision 227a's reported observation, and still an
 *   observation: no bar reads this number. **It is not the competence measure's own count and the
 *   two legitimately differ.** Since captain decision 351 the gate excludes a mayhem launch from
 *   both sides of its rate, and the candidate row's `competenceMayhemExcluded` is what that
 *   exclusion actually removed — over the MERGED history the gate read, which carries launches the
 *   enumeration never returned (the ownership listing's rows) and drops ones it did (a mint created
 *   by somebody else). `dune.mjs` → `MAYHEM_NOT_COMPETENCE` owns the rule and the evidence behind
 *   it; `measure.mjs` → `measureCompletion` owns the exclusion.
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
 * @property {import('./fill-source.mjs').FillSourceKind | null} entrySource WHICH FILL SOURCE
 *   PRODUCED {@link Candidate.entry}, per candidate rather than per run — `enumerationSource`'s
 *   shape one stage over, and for the same reason: on a dual-source run the primary can fail to
 *   answer for one candidate while answering for the rest. `null` means Stage 2 produced no score
 *   at all (no gate pass, `--no-stage2`, or the scoring cap), never "a source that was not named".
 *   Every default run records `swap-api` here, which is what it has always read.
 * @property {string[]} entrySourceFallbackReasons Why this candidate's recorded reading came from
 *   the CROSS-CHECK source rather than the primary, empty when it did not. Empty on every
 *   single-source run — there is no fallback to take.
 * @property {import('./entry-agreement.mjs').EntryAgreementRow | null} entryAgreement The
 *   per-candidate comparison of the two readings, `null` on a single-source run. **Per candidate is
 *   the point**: captain decision 143a established on this project that a whole-run agreement
 *   percentage is untrustworthy — 98.4% whole-window agreement there hid a total failure confined
 *   to the create slot — so the class lives on the candidate and the run level carries counts only.
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
 * {@link competenceEmptiedByMayhem} is a second, structural producer of the same state, and it is
 * checked HERE rather than pushed onto every caller's `notMeasured` list on purpose: captain
 * decision 351 removed launches from the gate's own denominator, so the case it creates is a
 * property of the measurement rather than of one call site's plumbing, and a caller that forgot it
 * would emit `gate-failed` on an absent measurement — 227c by accident, permanently and invisibly.
 *
 * @param {{ gate: GateResult, completion: import('./measure.mjs').CompletionMeasurement,
 *           capped: boolean, notMeasured?: readonly string[] }} input
 * @returns {{ verdict: Verdict, rationale: string }}
 */
export function verdictFor(input) {
  const notMeasured = input.notMeasured ?? [];
  if (competenceEmptiedByMayhem(input.completion)) {
    return {
      verdict: 'gate-unmeasured',
      rationale:
        `GATE UNMEASURED — this is NOT a rejection and NOT a pass. The competence measure was left ` +
        `with no non-mayhem launch to read: ${input.completion.mayhemExcluded} launch(es) in the ` +
        `history this gate read carry pump.fun's mayhem-mode flag` +
        (input.completion.droppedNoTimestamp > 0
          ? `, and a further ${input.completion.droppedNoTimestamp} had no usable deploy time and ` +
            `are NOT part of that count — they left this reading for an unrelated reason`
          : '') +
        `. A mayhem-mode graduation is not competence evidence — it ` +
        `raises a median 0.291 SOL against 85.005 for a classic curve graduation (captain decision ` +
        `351). Excluding them leaves NO non-mayhem record to measure, which is an absent reading ` +
        `and not a rate of 0. Captain decision 227c — dropping a mayhem-heavy deployer outright — ` +
        `remains DECLINED, so this wallet is not rejected: it is UNJUDGED. A later SCREEN run over a ` +
        `reading that holds a non-mayhem launch would judge it — the screen keeps no memory of a ` +
        `gate verdict between runs (its Stage 2 rotation memory holds only wallets that were ` +
        `SCORED, and an unjudged wallet never reaches Stage 2). That is a statement about ` +
        `screen.mjs and about nothing else: what the discovery feed ` +
        `does with a gate-unmeasured verdict is ledger.mjs's, and ledger.mjs -> markWorthARequest ` +
        `owns that rule.` +
        criterionNoteFor(input.completion, false) +
        (notMeasured.length > 0 ? ` The reading was also incomplete: ${notMeasured.join('; ')}.` : ''),
    };
  }
  // Captain decision 352b's own producer of the same state, and it is checked here for exactly the
  // reason 351's is: the launches left the gate's own denominator, so this is a property of the
  // measurement rather than of one call site's plumbing, and a caller that forgot it would emit
  // `gate-failed` on an absent measurement — permanently and invisibly, and on evidence about OUR
  // coverage rather than about the deployer.
  if (competenceEmptiedByCriterion(input.completion)) {
    return {
      verdict: 'gate-unmeasured',
      rationale:
        `GATE UNMEASURED — this is NOT a rejection and NOT a pass. The completion criterion ` +
        `could not be read on any of the ${input.completion.criterionUnreadable} launch(es) that ` +
        `reached it, so there is no rate to compare against the bar. The measure is RAISE-85 — net ` +
        `quote inflow into a token's own primary market reaching ${RAISE_85_SOL_BAR} ` +
        `SOL-equivalent over its first ${RAISE_85_WINDOW_HOURS} hours (captain decision 352b) — ` +
        `and a launch no surface could apply it to is excluded from both sides rather than scored ` +
        `as a failure, because that would default OUR coverage gap into a rejection. This wallet ` +
        `is not rejected: it is UNJUDGED, and a later run over a readable history would judge it.` +
        (input.completion.mayhemExcluded > 0
          ? ` A further ${input.completion.mayhemExcluded} launch(es) had already left this reading ` +
            `carrying pump.fun's mayhem-mode flag (captain decision 351), and they are NOT part of ` +
            `the criterion count.`
          : '') +
        (notMeasured.length > 0 ? ` The reading was also incomplete: ${notMeasured.join('; ')}.` : ''),
    };
  }
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
      // Captain decision 351, on the PASSING sentence too and not only on the rejections. This
      // rationale is the line a later reader quotes out of context, so a rate that is a NON-MAYHEM
      // rate has to say so where it is stated rather than in a field beside it.
      (c.mayhemExcluded > 0
        ? `, on their NON-MAYHEM record — a further ${c.mayhemExcluded} mayhem-mode launch(es) are ` +
          `excluded from both sides of that rate (captain decision 351)`
        : '') +
      criterionNoteFor(c, false) +
      // Captain decision 352b, and on the PASSING sentence for the same reason 351's clause is: a
      // rate read through pump.fun's graduation flag is an UPPER BOUND on the RAISE-85 rate, and a
      // reader who quotes this line out of context would otherwise take an estimate for the measure.
      (c.criterionEstimated > 0
        ? `. RAISE-85 was ESTIMATED rather than measured on ${c.criterionEstimated} of those ` +
          `${c.tokens} launch(es), through pump.fun's own graduation flag — every token that ` +
          `reached 85 SOL graduated, but 0.82% of graduations did not reach it, so this rate is an ` +
          `UPPER BOUND on the RAISE-85 rate`
        : '') +
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

  // Captain decision 352b: a launch RAISE-85 could not be READ on leaves this measurement the same
  // way it leaves the gate's own rate — out of BOTH sides — rather than sitting in an epoch's
  // denominator with nothing in its numerator. `r.completed` is three-state now, and `if
  // (r.completed)` below would silently read `null` as a failed launch, which is the one coercion
  // `measure.mjs` → `completionFlagOf` exists to prevent; here it would manufacture dispersion out
  // of a coverage gap and could then mark a deployer STREAKY for a walk that came back short.
  // NOTE what is deliberately NOT done here: 351's mayhem exclusion does not reach this function
  // and this lane does not extend it. That is a reported note rather than a bar, and widening an
  // exclusion is a captain decision, not a passing fix.
  const usable = records
    .filter((r) => Number.isFinite(r.deployedAtMs) && r.deployedAtMs > 0)
    .filter((r) => typeof r.completed === 'boolean')
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
    // `=== true` and not truthiness. `usable` has already dropped the unreadable ones, so this is
    // belt and braces — and it is exactly the belt captain decision 352b asks for, because the
    // filter above is one edit away from being moved and this line reads correctly either way.
    if (r.completed === true) b.completed += 1;
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
