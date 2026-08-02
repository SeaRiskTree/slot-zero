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

import { CeilingReached, RequestFailed, UnparseableResponse } from './client.mjs';

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
 * - **4** — the gate reads a CREATION-derived launch history rather than an ownership-derived one.
 *   Candidate rows gain `historySource`, the `vendor*` fields holding the old reading whole, and
 *   `creation` holding the walk's coverage and bounds. A schema-1, schema-2 or schema-3 record's
 *   `tokens` and `completionRate` are the OWNERSHIP reading — biased towards rejection, and
 *   understating a bonded count more than a launch count. **Do not compare them with a schema-4
 *   `completionRate` as though they answered the same question**; compare against
 *   `vendorCompletionRate`, which is the same measurement the older records hold.
 */
export const RECORD_SCHEMA_VERSION = 4;

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
 * Why a measurement could not be taken.
 *
 * These are not interchangeable and the record keeps them apart, because each one tells an operator
 * to do something different. **Asserting an inaccurate cause is worse than asserting none**: a
 * record that says "we retried" when no retry was made is exactly the class of defect the honesty
 * rule above exists to prevent, so a cause that cannot be identified is reported as unidentified
 * rather than rounded to the likeliest story.
 *
 * @typedef {'budget-exhausted' | 'page-failure' | 'not-retried-failure' | 'vendor-refusal'
 *   | 'unparseable-body' | 'local-error' | 'unclassified'} UnmeasuredKind
 */

/**
 * What each kind means, and whether it truncates the run.
 *
 * **Only the budget wall truncates.** The other kinds are still unmeasured, still recorded, and
 * still forbidden from reading as a measured negative — but the run did not stop looking, and a
 * flag that fires on every run carries no information and teaches its reader to skip it.
 *
 * @type {Record<UnmeasuredKind, { truncates: boolean, heading: string, advice: string }>}
 */
export const UNMEASURED_KINDS = {
  'budget-exhausted': {
    truncates: true,
    heading: 'BUDGET EXHAUSTED — a wall. The run stopped looking, and a rerun stops in the same place.',
    advice: 'This IS truncation and it is named in truncationReason.',
  },
  'page-failure': {
    truncates: false,
    heading: 'PAGE FAILURE — the request was retried once and the retry failed too.',
    advice: 'The run continued. A rerun may well succeed.',
  },
  'not-retried-failure': {
    truncates: false,
    heading: 'NOT RETRIED — the request failed and this client was configured not to retry it.',
    advice: 'The cause is known; only the retry is missing. Reachable only with retries disabled.',
  },
  'vendor-refusal': {
    truncates: false,
    heading: 'VENDOR REFUSAL — the endpoint answered on the first attempt and we did NOT retry it.',
    advice: 'A plain rerun is not expected to change it; check whether the endpoint moved.',
  },
  'unparseable-body': {
    truncates: false,
    heading: 'UNPARSEABLE BODY — the request was served, but the body was not JSON.',
    advice: 'Blame is NOT assigned: check first for an edge interstitial or error page behind a 200.',
  },
  'local-error': {
    truncates: false,
    heading: 'LOCAL ERROR — this failed in our own code, having never reached the endpoint.',
    advice: 'No request was retried and one may never have been made. This is our bug to fix.',
  },
  unclassified: {
    truncates: false,
    heading: 'UNCLASSIFIED — the cause could not be identified.',
    advice: 'Nothing is claimed about it, deliberately: a guessed cause is worse than none.',
  },
};

/**
 * What an entry means when its `kind` is not in {@link UNMEASURED_KINDS}.
 *
 * This module is the one that has to survive version skew — `completenessOf` and `schemaVersionOf`
 * already degrade rather than throw on records they do not recognise — and a record written by a
 * newer build, or a kind added later, must not take the whole record build down with a TypeError.
 * It does not truncate: inventing a wall from a label this build cannot read would be asserting a
 * cause we do not have.
 */
export const UNRECOGNISED_KIND = {
  truncates: false,
  heading: 'UNRECOGNISED KIND — written by a build that knew something this one does not.',
  advice: 'Shown rather than dropped, and nothing is claimed about it beyond its own summary.',
};

/**
 * The meaning of a kind, falling back to {@link UNRECOGNISED_KIND} rather than throwing.
 *
 * @param {string} kind
 * @returns {{ truncates: boolean, heading: string, advice: string }}
 */
export function kindMetaOf(kind) {
  return Object.prototype.hasOwnProperty.call(UNMEASURED_KINDS, kind)
    ? UNMEASURED_KINDS[/** @type {UnmeasuredKind} */ (kind)]
    : UNRECOGNISED_KIND;
}

/**
 * One measurement the run could not take, and why.
 *
 * `summary` and `detail` are split on purpose. The summary is **wallet-independent** — it names the
 * kind, the measurement and the status class and nothing else — so it is safe to group on. The
 * detail is the raw message, which carries the per-wallet URL, and must never become a grouping key:
 * keying on it gives every wallet its own line and buries the one sentence that matters.
 *
 * @typedef {object} Unmeasured
 * @property {string} measurement       What was not measured, named as the record names it.
 * @property {string} subject           The wallet it was not measured for.
 * @property {UnmeasuredKind} kind      What actually happened.
 * @property {string} summary           Stable across wallets. The grouping key.
 * @property {string | null} detail     The raw cause. Per-wallet; never a grouping key.
 */

/**
 * Classify a failed measurement pass by **what actually happened**, from the evidence the client
 * attached to the exception rather than from a guess about it.
 *
 * @param {unknown} cause
 * @returns {UnmeasuredKind}
 */
export function classifyUnmeasured(cause) {
  if (cause instanceof CeilingReached) return 'budget-exhausted';
  // Served, but unreadable. Neither side is established — the likeliest cause is an edge
  // interstitial behind a 200, which is the vendor's, and a bug in our handling is the other — so
  // this is its own kind rather than blame pinned on whichever we happened to guess.
  if (cause instanceof UnparseableResponse) return 'unparseable-body';
  if (cause instanceof RequestFailed) {
    // `retried` is the client's own record of what it did, so this branch can say "retried" and be
    // right. A 4xx that arrived after a retried 5xx is still a request we retried.
    if (cause.retried) return 'page-failure';
    if (cause.status !== null && cause.status >= 400 && cause.status < 500) return 'vendor-refusal';
    // Known cause, no retry. Only reachable with retries disabled, and calling it unidentifiable
    // would be inaccurate in the other direction — we know exactly what happened.
    return 'not-retried-failure';
  }
  // Every client failure leaves as a RequestFailed or an UnparseableResponse, so an Error that is
  // neither never reached the endpoint: a bug thrown inside the measurement itself.
  if (cause instanceof Error) return 'local-error';
  return 'unclassified';
}

/**
 * Record that a measurement pass could not run.
 *
 * Each kind gets its own sentence and they are not interchangeable. Only the retried kind may say
 * it was retried; only the wall may tell an operator to change a threshold; a local error says it
 * is ours. An operator acts on these sentences, and the wrong one sends them to rotate a key, raise
 * a bound, or rerun a forty-minute job for no reason.
 *
 * @param {string} measurement
 * @param {string} subject
 * @param {unknown} cause
 * @param {{ budget: string, ceiling: number, setting: string }} spent The budget the pass drew on.
 * @returns {Unmeasured}
 */
export function unmeasuredBecause(measurement, subject, cause, spent) {
  const kind = classifyUnmeasured(cause);
  const status =
    cause instanceof RequestFailed || cause instanceof UnparseableResponse ? cause.status : null;
  const detail = cause instanceof Error ? cause.message : String(cause);

  let summary;
  switch (kind) {
    case 'budget-exhausted':
      summary =
        `the ${spent.budget} request ceiling of ${spent.ceiling} was reached, so ${measurement} ` +
        `was never looked up. Raise ${spent.setting} or lower the candidate cap; rerunning alone ` +
        `reaches the same wall`;
      break;
    case 'page-failure':
      summary =
        `a ${spent.budget} request failed with ${status === null ? 'a transport failure or timeout' : `HTTP ${status}`} ` +
        `and the one retry failed too, so ${measurement} is missing. The run continued and later ` +
        `candidates were measured normally; a rerun may well succeed`;
      break;
    case 'not-retried-failure':
      summary =
        `a ${spent.budget} request failed with ${status === null ? 'a transport failure or timeout' : `HTTP ${status}`} ` +
        `and this client was configured not to retry it, so ${measurement} is missing. The cause is ` +
        `known; only the retry is absent`;
      break;
    case 'vendor-refusal':
      summary =
        `the ${spent.budget} endpoint answered HTTP ${status} on the first attempt and we did not ` +
        `retry it, so ${measurement} is missing. That is its considered answer, so a plain rerun ` +
        `is not expected to change it — check whether the endpoint moved`;
      break;
    case 'unparseable-body':
      summary =
        `the ${spent.budget} endpoint answered HTTP ${status} but the body was not JSON, so ` +
        `${measurement} is missing. The request WAS served, so this is not attributed to either ` +
        `side: check first for an edge interstitial or error page returned behind a success status`;
      break;
    case 'local-error':
      summary =
        `${measurement} failed inside our own code, having never reached the ${spent.budget} ` +
        `endpoint, so no request was retried and one may never have been made. This is our bug, ` +
        `not the vendor's`;
      break;
    default:
      summary =
        `${measurement} is missing and the cause could not be classified, so nothing is claimed ` +
        `about why it failed or whether a rerun would help`;
  }

  return { measurement, subject, kind, summary, detail };
}

/**
 * The one-line reading of an unmeasured entry, detail included.
 *
 * @param {Unmeasured} u
 * @returns {string}
 */
export function describeUnmeasured(u) {
  return u.detail === null ? u.summary : `${u.summary}: ${u.detail}`;
}

/**
 * Collapse unmeasured entries onto their distinct summaries, preserving first-seen order.
 *
 * Grouped rather than listed per wallet because sixty identical lines bury the one sentence that
 * matters. The key is the wallet-independent {@link Unmeasured.summary} and never the detail, which
 * embeds a per-wallet URL and would give every wallet a group of its own — grouping that groups
 * nothing is just a longer list.
 *
 * @param {readonly Unmeasured[]} unmeasured
 * @returns {Map<string, number>}
 */
export function groupUnmeasured(unmeasured) {
  /** @type {Map<string, number>} */
  const groups = new Map();
  for (const u of unmeasured) groups.set(u.summary, (groups.get(u.summary) ?? 0) + 1);
  return groups;
}

/**
 * Bucket unmeasured entries by kind, in {@link UNMEASURED_KINDS} order, omitting empty kinds.
 *
 * A kind this build does not recognise gets its own trailing bucket rather than being filtered out.
 * Dropping it would be the same defect as mislabelling it: the entry exists because something went
 * unmeasured, and a reader who cannot see it reads the run as more complete than it was.
 *
 * @param {readonly Unmeasured[]} unmeasured
 * @returns {Map<string, Unmeasured[]>}
 */
export function partitionUnmeasured(unmeasured) {
  /** @type {Map<string, Unmeasured[]>} */
  const byKind = new Map();
  for (const kind of Object.keys(UNMEASURED_KINDS)) {
    const of = unmeasured.filter((u) => u.kind === kind);
    if (of.length > 0) byKind.set(kind, of);
  }
  for (const u of unmeasured) {
    if (Object.prototype.hasOwnProperty.call(UNMEASURED_KINDS, u.kind)) continue;
    byKind.set(u.kind, [...(byKind.get(u.kind) ?? []), u]);
  }
  return byKind;
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
 * Which kinds truncate is {@link UNMEASURED_KINDS}'s to say, not this function's — only the budget
 * wall does. Everything else is still unmeasured, still recorded with its own reason, and still
 * forbidden from reading as a measured negative, but it does not declare the run truncated, because
 * the run did not stop looking. That distinction is what keeps the flag worth reading: on the
 * flakiest surface in the tool, one failed page out of up to 585 would otherwise set
 * `truncated: true` on nearly every run.
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
  const truncating = unmeasured.filter((u) => kindMetaOf(u.kind).truncates === true);
  for (const [summary, n] of groupUnmeasured(truncating)) {
    reasons.push(`${n} candidate(s) went unmeasured — ${summary}`);
  }
  return {
    truncated: reasons.length > 0,
    truncationReason: reasons.length === 0 ? null : reasons.join('; '),
  };
}
