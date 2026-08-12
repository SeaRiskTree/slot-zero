/**
 * THE SUBTRACTION LEDGER, and the verdict that is a FUNCTION of it. Pure — no I/O, no clock, and it
 * imports nothing.
 *
 * ## The rule this module compiles
 *
 * The captain's standing evidence bar, as `slot-zero-stage3-exit-design` → `report.md` §6.6 states
 * it (held in firstmate's records, not in this repo): everything measurable is measured, everything
 * that is not is given a FIRM NUMERIC BOUNDARY and labelled as such, and a "profitable" verdict must
 * mean profitable **even at the worst end of every boundary**. One clause does the work here:
 *
 * > **A cost component with no numeric boundary blocks the verdict entirely.**
 *
 * That was a sentence in a doc comment and a clause inside a caveat string until now — a
 * hand-maintained condition, which is exactly the shape this repo has watched go stale twice (a
 * claim outrunning its enforcement; `stage2.mjs` says so about the eligibility gate, and captain
 * decision 144a about the two-bound cursor). {@link exitVerdict} makes it arithmetic over
 * {@link costLedger}'s rows instead, so the refusal cannot be forgotten and a future row added
 * without a bound refuses on its own.
 *
 * ## Why the verdict names its own scope, and why that is not cosmetic
 *
 * **Captain decision 466, 2026-08-11.** The captain declined to raise
 * `stage2_cost.maxRpcRequestsPerCandidate`, so attempts made OUTSIDE the create slot stay unpriced
 * and {@link COST_COMPONENTS}' `failed-attempts-rest-of-window` row stays `null`. The binding
 * consequence is a NAMING one: every verdict issued while the attempt term is bounded to the create
 * slot must say so **in the verdict's own name**, not merely in a caveat, so that a reader who sees
 * only the verdict string cannot mistake it for a whole-window cost accounting. Hence
 * `exit-realised-at-worst-case-create-slot-costs-only` rather than the design report's proposed
 * `exit-realised-at-worst-case` — see {@link EXIT_VERDICTS} for the whole vocabulary and for the one
 * name that deliberately deviates from that report.
 *
 * ## What this module does NOT do, and it is the larger half
 *
 * **Nothing here gates anything in Stage 2.** `entry.mjs` → `ENTRY_VERDICTS` is untouched, no bar,
 * threshold, predicate or entry verdict reads a row of this ledger, and a candidate's entry verdict
 * is byte-identical with this module present and absent — the shape captain decision 208b
 * established for `roomLeftBound` and 461 for the all-positions figures: **record it, publish it,
 * decide nothing with it yet.** A test pins it.
 *
 * And it does not produce a profit verdict for a general deployer. Increment 2 turns two of the
 * `null` cost terms into numbers; **three stay `null`** ({@link UNBOUNDABLE_TODAY}), so
 * {@link exitVerdict} returns `'exit-unbounded'` on every candidate this build can score. That is
 * the correct and honest state rather than a defect — the design report's §8.1 says so in those
 * words — and the ladder out of it is its §9.
 */

/**
 * @typedef {'cost' | 'population'} ComponentKind
 *
 * **Only a `cost` row can block a verdict.** A `population` row states which population the number
 * is over — winners-only selection (§6.4), our own market impact (§6.5) — and neither is a term in
 * the sum: they cannot be given a numeric boundary at all, and netting them would be inventing one.
 * They are named ON the verdict instead, which is why the design report keeps them in the same table
 * rather than in a footnote.
 */

/**
 * @typedef {'optimistic' | 'pessimistic' | null} ComponentDirection
 *
 * Which way an unbounded or bounded-but-attributed component pushes the reading. `null` means the
 * component is MEASURED and there is no residual to push anything — not that the direction is
 * unknown. **A direction that is genuinely unmeasured is stated as unmeasured in the row's
 * {@link UnmeasuredComponent.boundBasis} and left `null` here**, never signed: captain decision 473a,
 * and 198b and 208b before it, refuse a signed direction that no measurement establishes.
 */

/**
 * @typedef {object} UnmeasuredComponent
 * One row of the subtraction ledger — `slot-zero-stage3-exit-design` → `report.md` §6.6's shape,
 * with one field added.
 *
 * @property {string} name  A code from {@link COST_COMPONENTS}, not free text.
 * @property {ComponentKind} kind
 * @property {ComponentDirection} direction
 * @property {number | null} worstCaseSol  **`null` IS UNBOUNDED**, and on a `cost` row that refuses
 *   the verdict. `0` is a measured zero and is a completely different value: a row reading `0` says
 *   the term was measured and found to be nothing, or that the worst case has already been taken
 *   elsewhere in the arithmetic.
 * @property {string} boundBasis  What the number is a ceiling OVER, in one sentence, including what
 *   it does NOT cover. This is the field that keeps a ceiling from being read as a measurement.
 * @property {string} label  Travels to the run record, the rendered block and the score's caveats.
 * @property {number} observations  How many launches the figure was read from — `0` on an unbounded
 *   row. Added to §6.6's shape because a bound over a subset of the sample is not a bound over the
 *   candidate, and a reader cannot check that from `worstCaseSol` alone.
 */

/**
 * Every row of the ledger, by name and in the order the design report tables them.
 *
 * **EXHAUSTIVE, and {@link assertCostLedgerComplete} holds a ledger to it.** A row that can be
 * dropped is a bound that can be made to disappear, and dropping the wrong one turns a refusal into
 * a pass — the one direction this ledger exists to make impossible.
 *
 * @type {readonly string[]}
 */
export const COST_COMPONENTS = Object.freeze([
  'landing-tip-create-slot',
  'landing-tip-outside-bound',
  'failed-attempts-create-slot',
  'failed-attempts-rest-of-window',
  'exit-side-fees-inside-horizon',
  'exit-side-fees-outside-horizon',
  'unrealised-positions',
  'winners-only-selection',
  'own-market-impact',
]);

/**
 * The `cost` rows this build cannot bound at any coverage, so that `exitVerdict` returns
 * `'exit-unbounded'` on **every** candidate until a later increment or a captain's pin closes one.
 *
 * Stated as a constant rather than left for a reader to diff two tables, because the honest headline
 * of this increment is that it does NOT unlock a profit verdict for a general deployer.
 *
 * **THREE, where `report.md` §6.6's prose says two.** Its bolded "after" column names
 * `landing-tip-outside-bound` and `failed-attempts-rest-of-window`; its row 6,
 * `exit-side-fees-outside-horizon`, carries `null` in the "today" column and the words *"shrinks
 * with the horizon"* rather than a number in the "after" one. This build reads no number as `null`,
 * so it counts three — the direction that refuses rather than the one that passes.
 *
 * @type {readonly string[]}
 */
export const UNBOUNDABLE_TODAY = Object.freeze([
  'landing-tip-outside-bound',
  'failed-attempts-rest-of-window',
  'exit-side-fees-outside-horizon',
]);

/**
 * @typedef {'exit-realised-at-worst-case-create-slot-costs-only'
 *   | 'exit-realised-typical-not-worst-case-create-slot-costs-only'
 *   | 'exit-loss-making-create-slot-costs-only'
 *   | 'exit-unbounded'
 *   | 'exit-unmeasured'} ExitVerdict
 *
 * The realized-profit vocabulary, parallel to `entry.mjs` → `ENTRY_VERDICTS` and deliberately NOT
 * reusing it: every value there is a statement about ENTRY, and filing an exit claim under an entry
 * contract is the defect one seam over that `entry-agreement.mjs` exists to prevent.
 *
 * | verdict | means |
 * |---|---|
 * | `exit-realised-at-worst-case-create-slot-costs-only` | clears the bar after the WORST case of every bounded component |
 * | `exit-realised-typical-not-worst-case-create-slot-costs-only` | clears at the measured cost and fails at the worst case — **NOT a pass** |
 * | `exit-loss-making-create-slot-costs-only` | fails even at the most favourable resolution; a firm negative, *a fortiori* |
 * | `exit-unbounded` | a `cost` row has `worstCaseSol === null`. **No profit verdict may be issued** |
 * | `exit-unmeasured` | our coverage: no realized figure was produced for this candidate at all |
 *
 * **The `-create-slot-costs-only` suffix is captain decision 466 and is not decoration.** The two
 * terms this increment bounds — the landing tip and the cost of failed attempts — are both bounded
 * OVER THE CREATE SLOT and nowhere else, so a name without it invites exactly the misreading 466
 * names: a whole-window cost accounting. It rides on the three verdicts that make a statement about
 * money and not on the two that report an ABSENCE of one, which state no cost accounting to be
 * mistaken about.
 *
 * **Two deviations from `report.md` §8.1's proposal, both deliberate.** The suffix is one, and 466
 * requires it. The other is `exit-realised-typical-not-worst-case-…` where that report proposes
 * `exit-realised-typical-only`: with the suffix appended, "typical-only-…-only" reads as a
 * duplication rather than as two qualifiers, and the longer name says the same thing in words that
 * cannot be misread. The MEANING is that report's, unchanged.
 *
 * **`exit-unbounded` and `exit-unmeasured` are different classes on purpose** — the remedies differ.
 * Unmeasured means spend more; unbounded means BUILD A BOUND, or get a captain's pin for one.
 * Collapsing them would hide which.
 *
 * @type {readonly ExitVerdict[]}
 */
export const EXIT_VERDICTS = Object.freeze([
  'exit-realised-at-worst-case-create-slot-costs-only',
  'exit-realised-typical-not-worst-case-create-slot-costs-only',
  'exit-loss-making-create-slot-costs-only',
  'exit-unbounded',
  'exit-unmeasured',
]);

/**
 * The two verdicts that report an ABSENCE of a finding rather than a finding about the deployer.
 *
 * Captain decision 174b's rule, one stage over and unchanged: a later stage may filter ONLY on a
 * verdict that says something about the deployer, and must carry every absence forward as *no
 * answer*, counted and surfaced. {@link isExitFilterable} is the predicate.
 *
 * @type {readonly ExitVerdict[]}
 */
export const UNFILTERABLE_EXIT_VERDICTS = Object.freeze(['exit-unbounded', 'exit-unmeasured']);

/**
 * @typedef {object} CreateSlotCostObservation
 * What one launch's create slot cost the WHOLE FIELD, read out of the `getBlock` response
 * `pumpfun.mjs` → `readCreateSlotCosts` already fetches to price the entrants' own transactions.
 *
 * **Both figures are whole-slot totals and are used as PER-POSITION ceilings.** Attributing the
 * entire slot's failed-attempt bill, or the entire slot's tips, to a single entrant over-attributes
 * grossly — which is exactly what a worst case is for, and is the only attribution the chain
 * supports: a sibling transaction in the same slot cannot be tied to an entrant's bundle by any
 * inference this repo is willing to make (`pumpfun.mjs` → `readCreateSlotCosts` says so and this
 * does not change it).
 *
 * @property {number} tipSol  SOL that ARRIVED at one of the tip accounts this build knows about
 *   (`pumpfun.mjs` → `JITO_TIP_ACCOUNTS`, which owns the list and the limits of its provenance) in
 *   this slot, over every transaction in the block. Balance increases, so a failed transaction
 *   contributes nothing — it transfers nothing and pays only its fee, which is the other figure.
 * @property {number} tipTransfers  How many transactions contributed to it.
 * @property {number} failedAttemptFeeSol  The exact `meta.fee` — base plus priority — of every
 *   LANDED-BUT-FAILED transaction in this slot that touches the launch's mint. Solana charges fees
 *   on inclusion rather than on success, so this is money that was really spent trying.
 * @property {number} failedAttempts  How many such transactions.
 */

/**
 * @typedef {object} LedgerInput
 * @property {readonly CreateSlotCostObservation[]} observations  One per launch that produced one.
 * @property {number} launchesRequiringObservation  How many launches the realized figures are
 *   computed over. **A bound over a subset of them is not a bound over the candidate**, so the two
 *   must be equal or the create-slot rows stay `null`.
 */

/**
 * Build the ledger for one candidate.
 *
 * **The bounding rule, and it fails towards refusal in both of its clauses.** The two create-slot
 * rows carry a number only when EVERY launch the realized figures are computed over produced an
 * observation, and when there was at least one such launch. A launch whose cost walk fell back to
 * per-signature reads produces none — the fallback reads one transaction at a time and never sees
 * the slot's other transactions at all — so a single fallback inside a candidate's sample takes both
 * rows back to `null` and the verdict back to `'exit-unbounded'`. That is the required direction:
 * a ceiling read from four launches of six says nothing about the two it did not see.
 *
 * The worst case over the sample is the LARGEST launch's total, not the median: the ledger's promise
 * is that a passing verdict survives the worst end of every boundary, and a median would let the
 * worst launch through.
 *
 * @param {LedgerInput} input
 * @returns {readonly UnmeasuredComponent[]}
 */
export function costLedger(input) {
  const n = input.launchesRequiringObservation;
  const obs = input.observations;
  const complete = n > 0 && obs.length === n;
  const max = /** @param {(o: CreateSlotCostObservation) => number} pick */ (pick) =>
    complete ? obs.reduce((acc, o) => Math.max(acc, pick(o)), 0) : null;
  const total = /** @param {(o: CreateSlotCostObservation) => number} pick */ (pick) =>
    complete ? obs.reduce((acc, o) => acc + pick(o), 0) : 0;

  const tipSol = max((o) => o.tipSol);
  const failedSol = max((o) => o.failedAttemptFeeSol);
  const observations = complete ? obs.length : 0;

  return Object.freeze([
    Object.freeze({
      name: 'landing-tip-create-slot',
      kind: /** @type {ComponentKind} */ ('cost'),
      direction: /** @type {ComponentDirection} */ ('optimistic'),
      worstCaseSol: tipSol,
      boundBasis:
        'The largest single create slot\'s TOTAL arriving at a published Jito tip account, ' +
        'attributed entirely to one entrant. It is a ceiling over the slot and NOT a measurement of ' +
        'what any entrant tipped: the true figure is at most this and is not separable. It covers ' +
        'only transfers to the tip accounts this build knows about, and only inside the create ' +
        'slot — everything else is the `landing-tip-outside-bound` row, which is UNBOUNDED.' +
        (complete
          ? ` Read from ${observations} launch(es), ${total((o) => o.tipTransfers)} tipping ` +
            'transaction(s) in total.'
          : ' UNBOUNDED here: the whole-block read did not serve every launch of this sample, and a ' +
            'per-signature fallback cannot see a slot it did not fetch.'),
      label:
        'A LANDING TIP PAID IN A SEPARATE TRANSACTION OF THE SAME BUNDLE is not in any entrant\'s ' +
        'own cost. What bounds it is the create slot\'s whole tip total, attributed to one entrant.',
      observations,
    }),
    Object.freeze({
      name: 'landing-tip-outside-bound',
      kind: /** @type {ComponentKind} */ ('cost'),
      direction: /** @type {ComponentDirection} */ ('optimistic'),
      worstCaseSol: null,
      boundBasis:
        'UNBOUNDED, and it stays unbounded after this increment. Two things are in it and both are ' +
        'invisible to a create-slot block read: a tip paid in a DIFFERENT slot of the window, and a ' +
        'tip paid inside the create slot to an account that is not in this build\'s published tip ' +
        'list. Nothing in this repository holds a magnitude for either.',
      label:
        'TIPS OUTSIDE THE CREATE-SLOT BOUND ARE UNBOUNDED — a tip paid in another slot, or paid in ' +
        'the create slot by a route this build cannot recognise. Their absence makes entry look ' +
        'CHEAPER than it was.',
      observations: 0,
    }),
    Object.freeze({
      name: 'failed-attempts-create-slot',
      kind: /** @type {ComponentKind} */ ('cost'),
      direction: /** @type {ComponentDirection} */ ('optimistic'),
      worstCaseSol: failedSol,
      boundBasis:
        'The largest single create slot\'s TOTAL `meta.fee` over every landed-but-FAILED ' +
        'transaction touching that launch\'s mint — base plus priority, exact, and charged because ' +
        'Solana bills inclusion rather than success — attributed entirely to one entrant. A ceiling ' +
        'over the slot, not a measurement of what any entrant spent failing.' +
        (complete
          ? ` Read from ${observations} launch(es), ${total((o) => o.failedAttempts)} failed ` +
            'transaction(s) in total.'
          : ' UNBOUNDED here: the whole-block read did not serve every launch of this sample, and a ' +
            'per-signature fallback cannot see a transaction it did not fetch.'),
      label:
        'THE COST ABOVE IS THE COST PAID BY WINNERS, and what the losers paid in the SAME CREATE ' +
        'SLOT is bounded by that slot\'s own failed-transaction fee bill.',
      observations,
    }),
    Object.freeze({
      name: 'failed-attempts-rest-of-window',
      kind: /** @type {ComponentKind} */ ('cost'),
      direction: /** @type {ComponentDirection} */ ('optimistic'),
      worstCaseSol: null,
      boundBasis:
        'UNBOUNDED, and CAPTAIN DECISION 466 leaves it so deliberately. Pricing attempts in the ' +
        'other slots of the window needs a whole-block read on up to `windowSlotSpan` slots per ' +
        'launch against `stage2_cost.maxRpcRequestsPerCandidate` for the WHOLE candidate — roughly ' +
        '3x over budget for a single launch. The ceiling was not raised, so this term stays null ' +
        'and every verdict names the create-slot bound in its own name.',
      label:
        'ATTEMPTS MADE OUTSIDE THE CREATE SLOT ARE UNPRICED (captain decision 466). The cost ' +
        'accounting here is CREATE-SLOT SCOPED and is not a whole-window one.',
      observations: 0,
    }),
    Object.freeze({
      name: 'exit-side-fees-inside-horizon',
      kind: /** @type {ComponentKind} */ ('cost'),
      direction: /** @type {ComponentDirection} */ (null),
      worstCaseSol: 0,
      boundBasis:
        'MEASURED, and already subtracted rather than bounded: `entry.mjs` → `priceLaunchEntry` ' +
        'sums a wallet\'s real lamport delta over its whole window transaction set, so a fee paid ' +
        'closing a position inside the horizon is inside the `NetOfMeasuredFees` figures already. ' +
        'Zero is what remains to subtract, not a claim that exit fees are free. THE ZERO IS SCOPED ' +
        'TO THAT CONSTRUCTION: those fees are netted only in the `*NetOfMeasuredFees` figures, ' +
        'whose population is the non-random subset whose WHOLE window the cost leg priced ' +
        '(`entry.mjs` → `NET_ALL_POSITIONS_SELECTION_CAVEAT`, captain decision 461), and the GROSS ' +
        'construction nets nothing — so a realised figure computed over the gross population may ' +
        'NOT be compared against this zero. It is inert today because three other rows keep the ' +
        'verdict at `exit-unbounded`; closing those rows requires this row\'s scope to be revisited ' +
        'rather than inherited.',
      label:
        'EXIT-SIDE FEES INSIDE THE HORIZON ARE ALREADY NETTED. On the committed tape they are ' +
        '2.12% of the measured fee bill — all the money is in the entry auction.',
      observations: 0,
    }),
    Object.freeze({
      name: 'exit-side-fees-outside-horizon',
      kind: /** @type {ComponentKind} */ ('cost'),
      direction: /** @type {ComponentDirection} */ ('optimistic'),
      worstCaseSol: null,
      boundBasis:
        'UNBOUNDED. A position that closes after the walked horizon pays fees this walk never sees. ' +
        'Resolving such a position at ZERO RECOVERY bounds what it RECOVERS and not what it SPENDS ' +
        'recovering it, so the two are not the same bound and this one is not closed by the other. ' +
        'It shrinks as the horizon widens, and widening the horizon is a pinned value and therefore ' +
        'the captain\'s.',
      label:
        'FEES PAID CLOSING A POSITION AFTER THE WALKED HORIZON ARE UNBOUNDED. They shrink as the ' +
        'horizon widens; the horizon is a pinned value.',
      observations: 0,
    }),
    Object.freeze({
      name: 'unrealised-positions',
      kind: /** @type {ComponentKind} */ ('cost'),
      direction: /** @type {ComponentDirection} */ ('optimistic'),
      worstCaseSol: 0,
      boundBasis:
        'The worst case is ALREADY TAKEN in the figures this ledger is about: captain decision 461 ' +
        'resolves every position still held at the horizon at ZERO RECOVERY, which is the worst end ' +
        'of that boundary, and reports the marked residual beside it and never instead of it. So ' +
        'nothing remains to subtract. A position whose closure our own rows cannot decide is in ' +
        'NEITHER construction and is our coverage, not a cost.',
      label:
        'POSITIONS STILL HELD AT THE HORIZON ARE RESOLVED AT ZERO RECOVERY in the *OverAllPositions ' +
        'figures — the worst case, already taken.',
      observations: 0,
    }),
    Object.freeze({
      name: 'winners-only-selection',
      kind: /** @type {ComponentKind} */ ('population'),
      direction: /** @type {ComponentDirection} */ ('optimistic'),
      worstCaseSol: null,
      boundBasis:
        'NOT A COST TERM AND NOT BOUNDABLE. Every fill belongs to a wallet that WON the auction, and ' +
        'a wallet that bid and never landed leaves no on-chain record at all — this is structural ' +
        'rather than budgetary, the same shape as the custodial-wall ceiling and captain decision ' +
        '114a. It is a POPULATION limit, so it is named on the verdict and never netted, and it ' +
        'does not block one.',
      label:
        'THE POPULATION IS THE WALLETS THAT GOT A SEAT — what they realized, never what we would ' +
        'realize.',
      observations: 0,
    }),
    Object.freeze({
      name: 'own-market-impact',
      kind: /** @type {ComponentKind} */ ('population'),
      direction: /** @type {ComponentDirection} */ ('optimistic'),
      worstCaseSol: null,
      boundBasis:
        'NOT A COST TERM AND NOT BOUNDABLE. Adding our own capital to a create slot moves the price ' +
        'the field pays and moves the queue, and on a deployer whose exit trigger may be a SIZE it ' +
        'could move that too. A counterfactual, so like winners-only it is named and never netted.',
      label:
        'OUR OWN ENTRY WOULD CHANGE THE EXIT BEING MEASURED. Every figure here is what the OBSERVED ' +
        'field realized.',
      observations: 0,
    }),
  ]);
}

/**
 * Project the ledger onto the rows a run record persists.
 *
 * **It lives here rather than in `stage2.mjs`, and the reason is a guard rather than tidiness.** A
 * scoring module may not read a `.kind` — that is how a bar drifts toward a source, and
 * `test/deployer-screen.test.ts` → "a scoring module imports only from a declared pure set" scans
 * for the property rather than for the intent, so it fires on ANY `.kind` in one of those modules
 * whatever the field means. The right answer is not to dodge the regex by destructuring: it is that
 * the ledger's row shape belongs to the module that defines it, so Stage 2 hands the rows over whole
 * and never opens one.
 *
 * The two sentence fields go through the caller's redactor for the reason every free-text field in a
 * record does — containment must not depend on a future edit remembering — even though both are
 * built here from a closed set of component names and can carry no vendor identifier today.
 *
 * @param {readonly UnmeasuredComponent[]} ledger
 * @param {(text: string) => string} redact
 * @returns {readonly object[]}
 */
export function costLedgerRecordRows(ledger, redact) {
  return ledger.map((c) => ({
    name: c.name,
    kind: c.kind,
    direction: c.direction,
    // `null` is UNBOUNDED and `0` is a measured zero. The two must not be collapsed by rounding, so
    // an unbounded row is passed through as `null` and a bounded one is fixed to the same six
    // decimals every SOL figure in a record carries.
    worstCaseSol: c.worstCaseSol === null ? null : Number(c.worstCaseSol.toFixed(6)),
    boundBasis: redact(c.boundBasis),
    label: redact(c.label),
    observations: c.observations,
  }));
}

/**
 * Hold a ledger to {@link COST_COMPONENTS} — every row present, exactly once, no stranger.
 *
 * **This throws rather than returning a verdict, and that is the point.** A ledger with a row
 * missing is a ledger whose refusal can be made to disappear by deletion, which is the one way a
 * `null` cost term could stop blocking a verdict. It is called by {@link exitVerdict} on every
 * evaluation, so there is no path to a verdict that skips it.
 *
 * @param {readonly UnmeasuredComponent[]} ledger
 * @returns {void}
 */
export function assertCostLedgerComplete(ledger) {
  const names = ledger.map((c) => c.name);
  const expected = [...COST_COMPONENTS];
  if (names.length !== expected.length || names.some((n, i) => n !== expected[i])) {
    throw new Error(
      `the subtraction ledger must carry exactly ${expected.length} component(s) in order — ` +
        `got [${names.join(', ')}]`,
    );
  }
  for (const c of ledger) {
    if (c.worstCaseSol !== null && !Number.isFinite(c.worstCaseSol)) {
      throw new Error(`ledger component ${c.name} carries a non-finite worst case`);
    }
    if (c.worstCaseSol !== null && c.worstCaseSol < 0) {
      throw new Error(`ledger component ${c.name} carries a negative worst case`);
    }
  }
}

/**
 * The `cost` rows with no numeric boundary — the ones that refuse a verdict, by name.
 *
 * A `population` row is deliberately never in this list however `null` its `worstCaseSol` is: it is
 * not a term in the sum, requirement 3 does not bite on it, and the honest treatment is to name it
 * on the verdict (§6.4, §6.5).
 *
 * @param {readonly UnmeasuredComponent[]} ledger
 * @returns {readonly string[]}
 */
export function unboundedCostComponents(ledger) {
  return ledger.filter((c) => c.kind === 'cost' && c.worstCaseSol === null).map((c) => c.name);
}

/**
 * @typedef {object} RealisedProfit
 * The realized figure a verdict would be issued over, at both resolutions the vocabulary
 * distinguishes. **The caller computes both** — this module holds the RULE, not the arithmetic of
 * one construction, and a netting arithmetic invented here would be a second implementation of a
 * quantity `entry.mjs` already owns.
 *
 * @property {number} atWorstCase  Realized net over every position taken, after the WORST case of
 *   every bounded component.
 * @property {number} atMeasuredCost  The same figure after the MEASURED costs only.
 */

/**
 * THE VERDICT, as a function of the ledger. `report.md` §6.6's one-line rule, compiled.
 *
 * ```
 * if any cost component has worstCaseSol === null  ->  'exit-unbounded'
 * ```
 *
 * **Today that branch is taken on every candidate this build can produce** — {@link
 * UNBOUNDABLE_TODAY} lists the three rows that make it so — which is the correct and honest state
 * and not a defect. Everything below that line is the machinery this increment exists to install,
 * exercised by tests rather than by a run.
 *
 * **The bar is a REQUIRED PIN and this function throws without one**, on the same discipline
 * `measure.mjs` → `measureWindowParticipation` states: a default IS a pin, and a bar invented here
 * would be a threshold nobody decided. `thresholds.json` → `minFieldHitRateNet` is NOT that bar and
 * must not be borrowed as one — it is calibrated over the denominator conditioned on the position
 * having exited, which is a different quantity (`report.md` §8's table says so in its own row).
 * Pinning an exit bar is the captain's. The throw is unreachable while the ledger refuses first,
 * which is deliberate: it cannot fire on a live run and it cannot be forgotten either.
 *
 * @param {object} input
 * @param {readonly UnmeasuredComponent[]} input.ledger
 * @param {RealisedProfit | null} input.realised  `null` when no realized figure was produced for
 *   this candidate — OUR coverage, and `'exit-unmeasured'`.
 * @param {number | null} input.bar  The captain's pinned floor. Required once the ledger is whole.
 * @returns {ExitVerdict}
 */
export function exitVerdict(input) {
  assertCostLedgerComplete(input.ledger);
  if (unboundedCostComponents(input.ledger).length > 0) return 'exit-unbounded';
  if (input.realised === null) return 'exit-unmeasured';
  if (input.bar === null || !Number.isFinite(input.bar)) {
    throw new Error(
      'a realized-profit verdict needs a PINNED bar and none was supplied: every cost component is ' +
        'bounded, so the ledger no longer refuses, and a bar defaulted here would be a threshold ' +
        'nobody decided. Pinning it is the captain\'s (see `report.md` §8).',
    );
  }
  if (input.realised.atWorstCase >= input.bar) {
    return 'exit-realised-at-worst-case-create-slot-costs-only';
  }
  if (input.realised.atMeasuredCost >= input.bar) {
    return 'exit-realised-typical-not-worst-case-create-slot-costs-only';
  }
  return 'exit-loss-making-create-slot-costs-only';
}

/**
 * **May a later stage filter a candidate out on this verdict?** Captain decision 174b's predicate,
 * one stage over.
 *
 * Fails safe in the same three ways `entry.mjs` → `isDeployerAttributable` does: a verdict this
 * module does not recognise is `false`, and both absence verdicts are `false`. An unbounded verdict
 * is a statement about OUR EVIDENCE — a bound we have not built — and dropping a candidate on it
 * would filter on our own ledger while looking like a measurement.
 *
 * @param {string} verdict
 * @returns {boolean}
 */
export function isExitFilterable(verdict) {
  if (!(/** @type {readonly string[]} */ (EXIT_VERDICTS).includes(verdict))) return false;
  return !(/** @type {readonly string[]} */ (UNFILTERABLE_EXIT_VERDICTS).includes(verdict));
}

/**
 * The sentence the ledger puts on the score's caveats, the rendered block and the run record — the
 * same discipline `LANDING_TIP_CAVEAT` follows, so the refusal travels with the numbers rather than
 * living in a document.
 *
 * It names the unbounded rows rather than counting them, because the remedy differs per row and a
 * count cannot say which.
 *
 * @param {readonly UnmeasuredComponent[]} ledger
 * @param {ExitVerdict} verdict
 * @returns {string}
 */
export function describeCostLedger(ledger, verdict) {
  const unbounded = unboundedCostComponents(ledger);
  const bounded = ledger.filter((c) => c.kind === 'cost' && c.worstCaseSol !== null);
  const head =
    `THE REALIZED-PROFIT VERDICT IS \`${verdict}\` AND IT IS A FUNCTION OF THE SUBTRACTION LEDGER, ` +
    'not of a caveat: a cost component with no numeric boundary blocks a profit verdict entirely.';
  // Each row's DIRECTION is read off the row rather than asserted here. Every unbounded cost term is
  // optimistic today, and writing that as a sentence would be a claim this function cannot keep true
  // — the defect captain decision 473a names, one surface over.
  const un =
    unbounded.length === 0
      ? ' Every cost component is bounded.'
      : ` ${unbounded.length} cost component(s) remain UNBOUNDED, each with the direction it pushes ` +
        `the reading in: ${ledger
          .filter((c) => unbounded.includes(c.name))
          .map((c) => `${c.name} (${c.direction ?? 'direction unmeasured'})`)
          .join(', ')}. An optimistic one makes the reading more flattering than the truth by an ` +
        'amount nobody here can state.';
  const bd =
    bounded.length === 0
      ? ''
      : ` Bounded at: ${bounded
          .map((c) => `${c.name} ${/** @type {number} */ (c.worstCaseSol).toFixed(6)} SOL`)
          .join('; ')}.`;
  const scope =
    ' THE COST ACCOUNTING IS CREATE-SLOT SCOPED (captain decision 466): attempts and tips outside ' +
    'the create slot are unpriced, which is why every verdict that states a result names that scope ' +
    'in its own name. NOTHING IN STAGE 2 READS THIS LEDGER — it is recorded and published and gates ' +
    'nothing.';
  return head + un + bd + scope;
}
