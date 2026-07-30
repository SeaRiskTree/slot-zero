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
 */

/**
 * Schema version of records this build writes.
 *
 * - **absent** — schema 1. Predates `completed`; completeness is unknowable from the record.
 * - **2** — carries `completed`, and `coverage` distinguishing cap truncation from an abort.
 */
export const RECORD_SCHEMA_VERSION = 2;

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
