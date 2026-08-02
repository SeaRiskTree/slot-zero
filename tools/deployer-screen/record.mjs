/**
 * The run-record schema contract.
 *
 * Run records under `runs/` are **evidence**: the prediction-grading lane's declared input, and the
 * only durable trace of what a run measured. That makes them append-only in spirit — a committed
 * record is never retro-edited to fit a newer schema, because a lane whose whole purpose is grading
 * what past runs predicted cannot also be rewriting them.
 *
 * The cost of that is version skew, and this module owns it.
 *
 * ## Why `completed` is three-state and not a boolean
 *
 * `completed` was added in schema version 2. The first record we committed
 * (`runs/2026-07-29-elite.json`) predates it, so it has no such key — and it is a run that
 * **finished**, whose candidate cap merely dropped wallets it never gated.
 *
 * A consumer reading `record.completed` on that file gets `undefined`, which is falsy, which is
 * indistinguishable from `false` — so the naive read turns a completed run into an aborted one, and
 * grades a real measurement as a failure. The record cannot be fixed, so the *reader* is what has to
 * be correct.
 *
 * Hence {@link completenessOf}, which returns one of three values and never a boolean. A caller
 * cannot write `if (completed)` and be accidentally right; it has to say which of the three states
 * it is handling. **`unknown` must not be collapsed into `true` or `false`** — not by defaulting, and
 * in particular not by inferring from `truncated` or `truncationReason`, which describe *what is
 * missing* and not *whether the run reached the end*. The committed record is the proof of why:
 * `truncated: true` there means the cap bit, not that anything failed.
 *
 * ## The standing rule this module also enforces
 *
 * **A ceiling hit, an exhausted budget or a failed walk must never be recordable as a measured
 * result.** If the tool could not look, the record has to say it could not look. {@link
 * unmeasuredBecause} and {@link deriveTruncation} are the general form of that: any measurement pass
 * that draws on a budget routes its failures through them and inherits the truncation, rather than
 * each new budget needing its own special case that someone remembers to add.
 */

import { CeilingReached } from './client.mjs';

/**
 * Schema version of records this build writes.
 *
 * - **absent** — schema 1. Predates `completed`; completeness is unknowable from the record.
 * - **2** — carries `completed`, and `coverage` distinguishing cap truncation from an abort.
 * - **3** — adds `spend`: the keyed ceiling, what was left unspent, the planned worst case, and the
 *   endpoints actually called with each one's per-call cost. A schema-2 record carries only the
 *   `keyedRequests` total, so on those `spend` is genuinely absent and must not be reconstructed —
 *   the total cannot say which endpoint the requests went to. Also adds `unmeasured`: every
 *   measurement the run could not take and why, which `truncated` and `truncationReason` now
 *   account for. Its absence on an older record means unknown, not none.
 */
export const RECORD_SCHEMA_VERSION = 3;

/**
 * Completeness of a run, as the record can actually support.
 *
 * `unknown` is a first-class answer, not an error and not a default.
 *
 * @typedef {'complete' | 'incomplete' | 'unknown'} Completeness
 */

/**
 * Resolve whether a run reached the end, honouring the three-state contract.
 *
 * Deliberately reads **only** `completed`. Every other field that hints at incompleteness describes
 * coverage rather than termination, so inferring from one would be the silent collapse this contract
 * exists to forbid.
 *
 * @param {unknown} record A parsed run record of any schema version.
 * @returns {Completeness}
 */
export function completenessOf(record) {
  if (typeof record !== 'object' || record === null) return 'unknown';
  const completed = /** @type {Record<string, unknown>} */ (record)['completed'];
  if (completed === true) return 'complete';
  if (completed === false) return 'incomplete';
  return 'unknown';
}

/**
 * Schema version of a record, with absence meaning 1.
 *
 * @param {unknown} record
 * @returns {number}
 */
export function schemaVersionOf(record) {
  if (typeof record !== 'object' || record === null) return 1;
  const v = /** @type {Record<string, unknown>} */ (record)['schemaVersion'];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 1;
}

/**
 * A sentence a human or a log line can carry, for each of the three states.
 *
 * Exists so the `unknown` case has somewhere honest to go instead of being rounded off at the point
 * of use.
 *
 * @param {Completeness} c
 * @returns {string}
 */
export function describeCompleteness(c) {
  switch (c) {
    case 'complete':
      return 'the run reached the end; every candidate it gated was evaluated';
    case 'incomplete':
      return 'the run stopped early, so nothing in it is a measured negative';
    default:
      return (
        'UNKNOWN — this record predates the `completed` field (schema 1). Whether the run finished ' +
        'cannot be recovered from it, and must not be guessed from `truncated`'
      );
  }
}

/** A whole URL. This client's trade URLs embed the mint, so a URL in free text is a leak. */
const URL_SHAPED = /\bhttps?:\/\/\S+/gi;

/**
 * A Solana-style base58 run. Mints and wallets are 32–44 characters from this alphabet, which
 * excludes `0`, `O`, `I` and `l` — so ordinary English prose does not match it.
 */
const BASE58_SHAPED = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/**
 * Strip vendor-derived identifiers out of a free-text string bound for a run record.
 *
 * **The retention boundary, enforced in one place rather than at each call site.** MadeOnSol terms
 * §5a(d) and this tool's own containment claim say a run record carries our derived arithmetic and
 * no per-token vendor record — but free text is how that leaks, and it leaks by accident: an error
 * message, a note built from one, a URL in a stack. The concrete case this exists for is a
 * transport failure on a launch walk, where the thrown message carried
 * `swap-api.pump.fun/v2/coins/<MINT>/trades` straight into `coverage.dropNotes` and out to `--out`.
 * The committed-record test only forbade mint-shaped *keys*, so a mint inside a sentence passed it.
 *
 * Applied to every free-text field a record persists. Structured fields are not passed through it —
 * a candidate's own `wallet` is public on-chain data we deliberately keep, and it is stored as a
 * field precisely so it is never confused with an incidental one.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactVendorIdentifiers(text) {
  return String(text).replace(URL_SHAPED, '[url redacted]').replace(BASE58_SHAPED, '[address redacted]');
}

/**
 * {@link redactVendorIdentifiers} over a list of free-text lines.
 *
 * @param {readonly string[]} lines
 * @returns {string[]}
 */
export function redactAll(lines) {
  return lines.map((l) => redactVendorIdentifiers(l));
}

/**
 * Why a measurement could not be taken. The two are not interchangeable and the record keeps them
 * apart:
 *
 * - **`budget-exhausted`** — a request ceiling. A wall: the tool stopped looking and will stop at
 *   the same place on a rerun, so it is genuine truncation of the run's coverage.
 * - **`page-failure`** — one request was retried and still failed. The run kept going and the next
 *   candidate was measured normally.
 *
 * @typedef {'budget-exhausted' | 'page-failure'} UnmeasuredKind
 */

/**
 * One measurement the run could not take, and why.
 *
 * @typedef {object} Unmeasured
 * @property {string} measurement    What was not measured, named as the record names it.
 * @property {string} subject        The wallet it was not measured for.
 * @property {UnmeasuredKind} kind   A wall, or a request that did not come back.
 * @property {string} why            A sentence naming the cause and the budget behind it.
 */

/**
 * Record that a measurement pass could not run.
 *
 * A ceiling has to name the budget that ran out and the setting that governs it, because the fix is
 * a number in `thresholds.json` and not a retry — an operator who reads "walk failed" reruns the
 * job and spends the keyed allowance again to reach the same wall. A page failure has the opposite
 * advice, so it must not borrow that sentence.
 *
 * @param {string} measurement
 * @param {string} subject
 * @param {unknown} cause
 * @param {{ budget: string, ceiling: number, setting: string }} spent The budget the pass drew on.
 * @returns {Unmeasured}
 */
export function unmeasuredBecause(measurement, subject, cause, spent) {
  const exhausted = cause instanceof CeilingReached;
  const why = exhausted
    ? `the ${spent.budget} request ceiling of ${spent.ceiling} was reached, so ${measurement} was ` +
      `never looked up for this wallet. Raise ${spent.setting} or lower the candidate cap; ` +
      `rerunning alone reaches the same wall`
    : `a ${spent.budget} request was retried and still failed, so ${measurement} is missing for ` +
      `this wallet. The run continued and later candidates were measured normally; a rerun may ` +
      `well succeed: ${cause instanceof Error ? cause.message : String(cause)}`;
  return {
    measurement,
    subject,
    kind: exhausted ? 'budget-exhausted' : 'page-failure',
    why,
  };
}

/**
 * Collapse unmeasured entries onto their distinct reasons, preserving first-seen order.
 *
 * Grouped rather than listed per wallet because sixty identical ceiling lines bury the one sentence
 * that matters; the per-wallet detail stays in the record's own `unmeasured` array.
 *
 * @param {readonly Unmeasured[]} unmeasured
 * @returns {Map<string, number>}
 */
export function groupUnmeasured(unmeasured) {
  /** @type {Map<string, number>} */
  const groups = new Map();
  for (const u of unmeasured) groups.set(u.why, (groups.get(u.why) ?? 0) + 1);
  return groups;
}

/**
 * Split unmeasured entries by whether they truncate the run.
 *
 * @param {readonly Unmeasured[]} unmeasured
 * @returns {{ budgetExhausted: Unmeasured[], pageFailures: Unmeasured[] }}
 */
export function partitionUnmeasured(unmeasured) {
  return {
    budgetExhausted: unmeasured.filter((u) => u.kind === 'budget-exhausted'),
    pageFailures: unmeasured.filter((u) => u.kind === 'page-failure'),
  };
}

/**
 * Fold everything missing from a run into one truncation verdict and one sentence.
 *
 * `truncated` is "is anything missing, for any reason". `completed` — "did the run reach the end" —
 * is deliberately NOT an input and is not derivable from this: the three-state contract above turns
 * on keeping them apart. What this adds is the third source of missingness. A run can reach the end,
 * gate every candidate it planned to, and still have failed to measure something; before this, that
 * was visible only in the affected candidate's own note, so the record read `completed: true,
 * truncated: false` — a screen claiming to have measured what it had not.
 *
 * **Only a `budget-exhausted` entry truncates.** A page failure is still unmeasured, still recorded
 * with its own reason, and still forbidden from reading as a measured negative — but it does not
 * declare the run truncated, because the run did not stop looking. The distinction is what keeps
 * the flag worth reading: on the flakiest surface in the tool, one retried-and-failed page out of
 * up to 585 would otherwise set `truncated: true` on nearly every run, and a flag that is always on
 * carries no information and teaches its reader to skip it.
 *
 * @param {object} input
 * @param {string | null} input.abortReason  Why the run died, or null if it did not.
 * @param {{ coverageTruncated: boolean, candidateCap: number, droppedByCandidateCap: number }} input.coverage
 * @param {readonly Unmeasured[]} input.unmeasured
 * @returns {{ truncated: boolean, truncationReason: string | null }}
 */
export function deriveTruncation({ abortReason, coverage, unmeasured }) {
  /** @type {string[]} */
  const reasons = [];
  if (abortReason !== null) reasons.push(abortReason);
  if (coverage.coverageTruncated) {
    reasons.push(
      `the candidate cap of ${coverage.candidateCap} dropped ${coverage.droppedByCandidateCap} ` +
        `seeded wallet(s) before they were measured`,
    );
  }
  for (const [why, n] of groupUnmeasured(partitionUnmeasured(unmeasured).budgetExhausted)) {
    reasons.push(`${n} candidate(s) went unmeasured — ${why}`);
  }
  return {
    truncated: reasons.length > 0,
    truncationReason: reasons.length === 0 ? null : reasons.join('; '),
  };
}
