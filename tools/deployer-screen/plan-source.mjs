/**
 * THE PLAN PATH'S HALF OF THE FILL-SOURCE CONTRACT — captain decision 286c, 2026-08-05.
 *
 * ## Why this module exists, stated before the types
 *
 * Captain decisions 281a/284a/285a rewired the dry run so it reports the eligibility bound **the
 * selected fill source itself applies**, instead of re-deriving that duration locally and claiming
 * the two were one number. That is what makes the plan honest, and it is not negotiable: a plan that
 * keeps its own copy of a bound the vendor controls goes on agreeing with the run right up until the
 * day it does not, which is captain decision 144a's defect and this repo has paid for it twice.
 *
 * Its honest cost arrived with it. Asking a source anything means the source must EXIST, and the
 * Dune fill source cannot be built without the decoded trade tables' own coverage assessment — the
 * observed watermark captain decision 257a requires — whose result read is BILLED. So once Gate 3
 * points `ENTRY_FILL_SOURCE_KIND` at Dune, a dry run has only two ways out, and both break a
 * standing promise:
 *
 *   - **SPEND**, and `--dry-run` stops costing nothing. An operator runs a dry run precisely to find
 *     out what a real run would cost, before authorising it. A preview that bills is not a preview.
 *   - **THROW**, and `--dry-run` stops always showing the plan. Every other figure on that page —
 *     the keyed request plan, both keyless ceilings, the wall clock, the caveats — is free, correct
 *     and exactly what the operator asked for. Withholding all of it because ONE line needs a
 *     purchase is a worse answer than printing the rest.
 *
 * The captain refused both and chose the SPLIT this module implements.
 *
 * ## The rule
 *
 * 1. **The default dry run is FREE and ALWAYS shows the plan.** It never constructs a billed source.
 *    Source SELECTION resolves with no network call — {@link FillSourceRegistration} is data, and
 *    `build` is a thunk nobody calls until somebody is entitled to pay for it.
 * 2. **A figure only a billed construction could answer is printed as UNAVAILABLE, naming the source
 *    and the reason.** Never thrown, never omitted, never defaulted to another source's value, never
 *    dressed as a measurement. {@link eligibilityUnavailableNote} is the one sentence, so a printer
 *    cannot degrade the figure into a blank or a zero without deleting the reason with it — and a
 *    test asserts the reason is there.
 * 3. **A SPENDING dry run is available behind an explicit opt-in**, and it states the BOUNDED spend
 *    BEFORE it spends and the ACTUAL after. That ordering is structural rather than remembered:
 *    {@link planEligibility} announces the bound, then builds, then announces the actual in a
 *    `finally`, so a construction that fails half-way still says what it cost.
 *
 * ## The three-valued cost, and why `undeclared` is not `free`
 *
 * {@link FillSourceConstruction.cost} is `'free' | 'billed' | 'undeclared'`. The third value is the
 * one that matters. A registry entry that says nothing about what building it costs is not evidence
 * that building it is free — it is an absence, and reading an absence as a benign value is the
 * failure this repo names in three other places (`covered.fromMs` of `0` read as a 56-year window;
 * `bonded` absent read as "did not bond"; a wallet with no enumeration row read as zero launches).
 * So an undeclared construction is never built by a plan, **even under the opt-in**: there is no
 * bound to state before spending, and a spend that cannot be bounded first is not an authorised
 * spend. It prints UNAVAILABLE with that as its reason.
 *
 * ## What this module does NOT touch
 *
 * The RUN path. A real run builds its source and pays whatever that costs — it was always going to
 * reach that vendor, and the eligibility answer is an input to a measurement rather than a line on a
 * preview. Everything here is reachable only from a `--dry-run`/plan printer.
 */

import { assertMinAgeUsable } from './fill-source.mjs';

/**
 * What building one fill source costs, declared by whoever registers it.
 *
 * **It is a DECLARATION, not a measurement, and it is read before anything is built** — which is the
 * only order in which it is worth anything. `actual` is the other half: read after, from the
 * transport's own counters, so the pair is "what it may cost" and "what it did".
 *
 * @typedef {object} FillSourceConstruction
 * @property {import('./fill-source.mjs').FillSourceKind} kind
 * @property {'free' | 'billed' | 'undeclared'} cost
 *   `free`   — building it opens no socket and spends no allowance. A plan builds it.
 *   `billed` — building it spends. A plan builds it only under an explicit authorisation, and states
 *              {@link FillSourceConstruction.bound} first.
 *   `undeclared` — the registry said nothing. A plan NEVER builds it; see the module header.
 * @property {string} why
 *   One sentence. When the plan cannot have the figure, this is printed verbatim as the reason, so
 *   it must read as an explanation to an operator rather than as an internal note.
 * @property {string} bound
 *   The BOUNDED spend, stated BEFORE a request is made. Meaningful only when `cost` is `'billed'`.
 * @property {() => string} actual
 *   What the construction actually cost, read AFTER it from the transport's own counters. A thunk
 *   rather than a value because it is read after the fact, and supplied by the registering site
 *   rather than by this module, so no vendor accounting crosses into the contract.
 */

/**
 * A fill source plus what building it costs. The pair is what a plan needs and a run does not.
 *
 * `build` is a thunk for the reason `screen.mjs` → `selectEntryFillSource` already gives: a source is
 * only built when it is selected. That mattered little while every constructor was free; it is the
 * whole mechanism now.
 *
 * @typedef {object} FillSourceRegistration
 * @property {FillSourceConstruction} construction
 * @property {() => import('./fill-source.mjs').FillSource} build
 */

/**
 * What a plan can say about the eligibility gate.
 *
 * **`known: false` is an ABSENCE, not a value.** It carries no number at all — deliberately, because
 * a shape with an optional `minAgeMs` is a shape a printer reads as `0` on the day someone forgets
 * the check.
 *
 * `billed` on the known side is what the figure COST TO OBTAIN, carried beside it rather than
 * inferred from the flag that authorised it: an authorisation is permission to spend and not
 * evidence of a spend, and a banner saying "what it cost is stated above" when the selected source
 * was free to build would be a claim about a purchase that never happened.
 *
 * @typedef {{ known: true, kind: import('./fill-source.mjs').FillSourceKind, minAgeMs: number,
 *       billed: boolean }
 *   | { known: false, kind: import('./fill-source.mjs').FillSourceKind, why: string,
 *       authorisedBy: string | null }} PlanEligibility
 */

/**
 * Declare a construction that costs nothing.
 *
 * @param {import('./fill-source.mjs').FillSourceKind} kind
 * @param {string} why How it is free, in one sentence — printed nowhere today, and the field a
 *   future reader checks when they want to know whether "free" was reasoned or assumed.
 * @returns {FillSourceConstruction}
 */
export function freeConstruction(kind, why) {
  return {
    kind,
    cost: 'free',
    why,
    bound: 'no request, no credit and no quota — this source is free to build',
    actual: () => 'nothing — this source is free to build',
  };
}

/**
 * Declare a construction that spends.
 *
 * @param {import('./fill-source.mjs').FillSourceKind} kind
 * @param {object} spec
 * @param {string} spec.why What building it spends on, and therefore why a free plan cannot have the
 *   figures only it can answer. Printed verbatim to the operator.
 * @param {string} spec.bound The ceiling, in the units the vendor bills — stated BEFORE the spend.
 * @param {() => string} spec.actual Read AFTER, from the transport's own counters.
 * @returns {FillSourceConstruction}
 */
export function billedConstruction(kind, spec) {
  return { kind, cost: 'billed', why: spec.why, bound: spec.bound, actual: spec.actual };
}

/**
 * What a registry entry that declared nothing is worth to a plan: nothing, and it says so.
 *
 * **This is the fail-safe direction and it is chosen on purpose.** Treating an undeclared cost as
 * free would make the default dry run spend the first time somebody registers a billed source
 * without coming back here — which is the whole failure 286c exists to prevent, arriving through
 * the one door a declaration cannot close.
 *
 * @param {import('./fill-source.mjs').FillSourceKind} kind
 * @returns {FillSourceConstruction}
 */
export function undeclaredConstruction(kind) {
  return {
    kind,
    cost: 'undeclared',
    why:
      'this run registered it without declaring what building it costs, and a plan that assumed ' +
      '"free" would find out by spending. An undeclared construction can state no bound, so no ' +
      'authorisation can cover it either — it is never built by a plan.',
    bound: 'unknown — an undeclared construction cannot state a bound, so a plan never builds it',
    actual: () => 'nothing — a plan never builds an undeclared construction',
  };
}

/**
 * Normalise a registry entry. A bare thunk declares nothing and is treated as such.
 *
 * The run path's registry may still hold bare thunks — building is all it does with them, and what
 * that costs is not its question. Only a plan asks, and only a plan is refused an answer.
 *
 * @param {import('./fill-source.mjs').FillSourceKind} kind
 * @param {FillSourceRegistration | (() => import('./fill-source.mjs').FillSource)} entry
 * @returns {FillSourceRegistration}
 */
export function registrationOf(kind, entry) {
  return typeof entry === 'function' ? { construction: undeclaredConstruction(kind), build: entry } : entry;
}

/**
 * ASK THE SELECTED SOURCE FOR THE PLAN'S ELIGIBILITY GATE, OR SAY WHY THE PLAN CANNOT HAVE IT.
 *
 * The one function the split lives in. Read the branches in order — they are the captain's rule,
 * one clause each:
 *
 *  - an undeclared construction is never built, and there is nothing an authorisation can do about
 *    it, because the bound that authorisation would be given against does not exist;
 *  - a billed construction with no authorisation is not built either — the DEFAULT dry run must
 *    cost nothing, and `build` is never called, which is what a stub constructor can prove;
 *  - a billed construction WITH authorisation states its bound, builds, and states what it actually
 *    cost, in that order, with the actual reported even if the construction throws;
 *  - a free construction is simply built, exactly as it was before this split existed.
 *
 * **The answer is still the SOURCE'S**, in every branch that produces one — asked of it, never
 * derived here. That is the property 281a/284a/285a bought and this split must not spend.
 *
 * @param {object} input
 * @param {FillSourceRegistration} input.registration
 * @param {import('./fill-source.mjs').FillSourceBounds} input.bounds
 * @param {boolean} input.spendAuthorised Whether the operator explicitly opted into a spending plan.
 * @param {string | null} input.authorisedBy The flag that WOULD authorise it, named so the
 *   unavailable line can tell the operator what to do next. `null` where no such flag exists — the
 *   census, whose fill source is keyless by construction and has nothing to authorise.
 * @param {(line: string) => void} input.announce Where the bound and the actual are printed. Called
 *   BEFORE `build` for the bound and after it for the actual, so the ordering is a property of this
 *   function rather than of the caller's memory.
 * @returns {Promise<PlanEligibility>}
 */
export async function planEligibility(input) {
  const { construction, build } = input.registration;

  if (construction.cost !== 'free' && !(construction.cost === 'billed' && input.spendAuthorised)) {
    return {
      known: false,
      kind: construction.kind,
      why: construction.why,
      // An undeclared construction is unauthorisable, so it never names a flag — offering one would
      // be telling the operator to try something that cannot work.
      authorisedBy: construction.cost === 'undeclared' ? null : input.authorisedBy,
    };
  }

  if (construction.cost === 'billed') {
    input.announce(
      `AUTHORISED SPEND — building the ${construction.kind} fill source is billed, and this plan ` +
        `was told to pay for it${input.authorisedBy === null ? '' : ` (${input.authorisedBy})`}.`,
    );
    input.announce(`  BOUND, before anything is spent: ${construction.bound}`);
  }

  try {
    const source = build();
    const minAgeMs = await source.minAgeMs(input.bounds);
    // The same guard the run path and the census apply at their own consumption sites. A non-finite
    // floor printed here would be `younger than Infinityms` — an unknown wearing a measurement's
    // clothes, which is the one thing this whole stretch of work removes.
    assertMinAgeUsable(source, minAgeMs);
    return { known: true, kind: source.kind, minAgeMs, billed: construction.cost === 'billed' };
  } finally {
    // AFTER, and in a `finally`, because a construction that failed half-way still spent. A spend
    // reported only on success is a spend that goes missing exactly when it is most surprising.
    if (construction.cost === 'billed') input.announce(`  ACTUAL, after: ${construction.actual()}`);
  }
}

/**
 * The eligibility floor as a plan prints it inline, in milliseconds.
 *
 * @param {PlanEligibility} eligibility
 * @returns {string}
 */
export function eligibilityFloorMs(eligibility) {
  return eligibility.known ? `${eligibility.minAgeMs}ms` : 'UNAVAILABLE';
}

/**
 * The eligibility floor as a plan prints it inline, in seconds.
 *
 * @param {PlanEligibility} eligibility
 * @returns {string}
 */
export function eligibilityFloorSeconds(eligibility) {
  return eligibility.known ? `${eligibility.minAgeMs / 1000}s` : 'UNAVAILABLE';
}

/**
 * THE SENTENCE THAT MUST TRAVEL WITH AN UNAVAILABLE FIGURE. Empty when the figure is known.
 *
 * **An unavailable figure that reads like a measured one is the exact defect this stretch of work
 * removed**, so the word `UNAVAILABLE` on its own is not enough: the line names the SOURCE that owes
 * the answer, the REASON it cannot give one for free, and — where one exists — what would authorise
 * the purchase. It is built here rather than in each printer so the two plan surfaces cannot drift,
 * and so a change that degraded it into a blank or a zero would have to delete this function.
 *
 * @param {PlanEligibility} eligibility
 * @returns {string[]}
 */
export function eligibilityUnavailableNote(eligibility) {
  if (eligibility.known) return [];
  return [
    `UNAVAILABLE — NOT MEASURED, NOT ZERO, AND NOT ANOTHER SOURCE'S NUMBER. The ` +
      `${eligibility.kind} fill source is the one that will apply this gate, and this plan cannot ` +
      `have its answer for free: ${eligibility.why}` +
      (eligibility.authorisedBy === null
        ? ' Nothing here authorises that spend, so the plan prints everything it knows and stops.'
        : ` Pass ${eligibility.authorisedBy} to authorise that spend; this plan did not, and every ` +
          `other figure on this page is unaffected.`),
  ];
}

/**
 * THE SAME SENTENCE FOR A FIGURE THAT WAS MEASURED ON A SOURCE THIS PLAN IS NOT USING.
 *
 * The eligibility floor is not the only thing on a plan page that belongs to one vendor. A page
 * count, a shed rate, a pacing justification and a cursor geometry are all measurements taken
 * against ONE fill source, and after a cutover every one of them describes a walk the run will
 * never do. Re-printing such a figure under another source is the same defect as re-deriving a
 * bound the vendor controls: it reads exactly as confidently as a true one, and nothing downstream
 * contradicts it. Substituting a plausible number for the selected source would be worse still —
 * none has been measured, and an invented figure is not an absence, it is a false measurement.
 *
 * So the vocabulary is shared with {@link eligibilityUnavailableNote} rather than reinvented per
 * printer: same words, same three refusals, one place to degrade.
 *
 * **The closing sentence is narrow on purpose, and it used to overstate.** It said the ceilings,
 * worst cases and caveats on the page "bind whichever source answers", which is more than this
 * string can know: the Stage 2 plan's ceiling, pacing floor, request worst case and wall clock are
 * all bounds this stage enforces on its OWN KEYLESS CLIENT, and a source billed in executions and
 * credits would not be governed by that client at all. They still print — withholding them is the
 * failure the split exists to avoid — but the sentence now says what they are rather than claiming
 * universality. A shared honesty string that overstates is worse than a specific one, because it is
 * quoted everywhere. See `render.mjs` → `renderDryRun`'s Stage 2 block for the recorded Gate 3
 * residual this narrowing leaves standing.
 *
 * @param {object} spec
 * @param {string} spec.figure What the plan cannot state, named as the reader would name it.
 * @param {import('./fill-source.mjs').FillSourceKind} spec.measuredOn The source the figure was
 *   measured against, and therefore the only source it describes.
 * @param {import('./fill-source.mjs').FillSourceKind} spec.selected The source this run actually
 *   reads its fills from.
 * @returns {string[]}
 */
export function sourceFigureUnavailableNote(spec) {
  if (spec.measuredOn === spec.selected) return [];
  return [
    `${spec.figure}: UNAVAILABLE — NOT MEASURED, NOT ZERO, AND NOT ANOTHER SOURCE'S NUMBER. That ` +
      `figure was measured on the ${spec.measuredOn} source and describes only it; this run's ` +
      `fills come from the ${spec.selected} source, against which nothing here has been measured. ` +
      `The ceilings, worst cases and caveats on this page are the ones this stage enforces on its ` +
      `OWN client today, they are what binds a keyless-sourced walk, and they still print — a ` +
      `source billed in other units would not be governed by them.`,
  ];
}
