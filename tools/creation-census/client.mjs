/**
 * The census's Dune client. **This is the only file in this directory that opens a socket**, and
 * `test/creation-census.test.ts` pins that.
 *
 * It is a deliberate near-copy of `tools/deployer-screen/client.mjs` → `DuneClient`. The boundary in
 * this repository is the DIRECTORY (`CLAUDE.md` → "The one network-capable area is `tools/`"), and
 * the duplicated keyless client across the existing tools is that boundary's stated cost. This lane
 * pays the same cost for the same reason: a census is a scheduled, credential-holding job that must
 * not break because another lane edited the screen's client. What is NOT duplicated is the thing a
 * copy could get wrong — the SQL text itself is compared byte for byte against
 * `tools/arrival-rate-walk/cohort.mjs` by a test, and against the *saved query* by the runner before
 * any execution is spent.
 *
 * Three properties carry over unchanged, and each is load-bearing:
 *
 * - **AN EXECUTION IS BILLED WHETHER OR NOT IT SUCCEEDS, AND IT IS TERMINAL.** {@link
 *   DuneClient.execute} is never retried, on any failure, for any reason. Reads may retry: they are
 *   billed by bytes returned and a failed read returns none.
 * - **Two separate ceilings.** Requests bound the wall clock and polite use of a shared host;
 *   executions bound the money. A poll loop counted against the execution budget would be counting
 *   the wrong thing.
 * - **The key is interpolated in exactly one place, as a HEADER.** No URL this client builds can
 *   carry a credential, so nothing that logs a URL can leak one.
 *
 * One property is new here, and it is about the account rather than the bill: {@link
 * DuneClient.postJson} — the call that CREATES a saved query — is never retried either. The Free
 * tier allows ten private queries and a retried create would spend a second irreplaceable slot on
 * the same statement, which is the slot-exhaustion failure this lane exists downstream of. How many
 * are in use is never quoted here — a count in a comment is the claim that blocked this lane for a
 * month; `run.mjs` → `readSavedQueries` reads it live before every deploy.
 */

/** Dune's SQL API. The only host this tool reaches. */
export const DUNE_API_BASE = 'https://api.dune.com/api/v1';

const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 60_000;
const EXCERPT_LIMIT = 300;

/** A run bound was reached. Carries the remedy, because the fix is always a pinned number. */
export class CeilingReached extends Error {
  /**
   * @param {number} ceiling
   * @param {string} attemptedPath
   * @param {string} remedy
   */
  constructor(ceiling, attemptedPath, remedy) {
    super(`Ceiling of ${ceiling} reached before ${attemptedPath}. ${remedy}`);
    this.name = 'CeilingReached';
    /** @type {number} */ this.ceiling = ceiling;
    /** @type {string} */ this.attemptedPath = attemptedPath;
    /** @type {string} */ this.remedy = remedy;
  }
}

/** Dune refused, or answered something this client will not read. */
export class DuneRefused extends Error {
  /**
   * @param {string} message
   * @param {{ status: number | null, terminal: boolean }} what `terminal` is whether the whole Dune
   *   leg is unusable for this run, as opposed to one call going wrong.
   */
  constructor(message, what) {
    super(message);
    this.name = 'DuneRefused';
    /** @type {number | null} */ this.status = what.status;
    /** @type {boolean} */ this.terminal = what.terminal;
  }
}

/** @param {number} ms @returns {Promise<void>} */
function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function excerptBody(response) {
  try {
    return (await response.text()).slice(0, EXCERPT_LIMIT);
  } catch {
    return '';
  }
}

/**
 * Turn a Dune HTTP status into a specific sentence.
 *
 * A rejected key, a rate limit and an exhausted monthly allowance all stop this lane, but they call
 * for different responses and only one of them is fixed by waiting. None of them is a reason to
 * retry an execution.
 *
 * @param {number} status
 * @param {string} path
 * @param {string} excerpt
 * @returns {string}
 */
export function describeDuneStatus(status, path, excerpt) {
  const tail = excerpt.trim().length > 0 ? ` Vendor said: ${excerpt.trim()}` : '';
  if (status === 401 || status === 403) {
    return (
      `HTTP ${status} on ${path} — Dune rejected the key. There is no keyless route to a census, so ` +
      `this run produced no cohort at all rather than a smaller one.${tail}`
    );
  }
  if (status === 402) {
    return (
      `HTTP 402 on ${path} — the Dune plan's allowance is spent. The key is UNSHARED, so this is ` +
      `this fleet's own spend, and nothing in this tool tracks the month: it is stateless between ` +
      `runs and the monthly arithmetic is the operator's.${tail}`
    );
  }
  if (status === 429) {
    return `HTTP 429 on ${path} — Dune rate-limited this key. Nothing is retried past this point.${tail}`;
  }
  return `HTTP ${status} on ${path}.${tail}`;
}

/**
 * @typedef {object} DuneClientOptions
 * @property {string} key             Held in this closure and nowhere else.
 * @property {number} maxExecutions   Hard ceiling on **executions**, the billed unit that cannot be
 *   taken back.
 * @property {number} maxRequests     Hard ceiling on requests of every kind, polling included.
 * @property {number} [minIntervalMs] Minimum gap between request starts. Default 250.
 * @property {number} [timeoutMs]     Per-request timeout. Default 60000.
 * @property {(label: string, attempt: number) => void} [onRequest] Progress hook. Receives a path
 *   only — never a header, never the key.
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleepImpl]
 */

/** A serialised, ceiling-bounded client for Dune's SQL API. */
export class DuneClient {
  /** @param {DuneClientOptions} options */
  constructor(options) {
    if (!Number.isInteger(options.maxExecutions) || options.maxExecutions < 0) {
      throw new TypeError('maxExecutions must be a non-negative integer');
    }
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new TypeError('maxRequests must be a positive integer');
    }
    this.#key = options.key;
    this.#maxExecutions = options.maxExecutions;
    this.#ceiling = options.maxRequests;
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onRequest = options.onRequest;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleepImpl ?? realSleep;
  }

  /** @type {string} */ #key;
  /** @type {number} */ #maxExecutions;
  /** @type {number} */ #ceiling;
  /** @type {number} */ #minIntervalMs;
  /** @type {number} */ #timeoutMs;
  /** @type {((label: string, attempt: number) => void) | undefined} */ #onRequest;
  /** @type {typeof fetch} */ #fetch;
  /** @type {(ms: number) => Promise<void>} */ #sleep;

  /** @type {number} */ #issued = 0;
  /** @type {number} */ #executions = 0;
  /** @type {number} */ #resultBytes = 0;
  /** @type {number} */ #lastStartedAt = 0;
  /** @type {Promise<unknown>} */ #queue = Promise.resolve();

  /** Requests issued so far, retries and failures included. @returns {number} */
  issued() {
    return this.#issued;
  }

  /** Executions actually started. The billed, unrecoverable unit. @returns {number} */
  executions() {
    return this.#executions;
  }

  /**
   * What this run spent, in the units this client can observe.
   *
   * `estimatedExportCredits` applies the Free tier's published 20 credits/MB to the result bytes the
   * vendor's own metadata declared. It is NOT the bill — compute is billed on top, and the only
   * authoritative figure is `POST /usage`, which lags minutes and lands in whole-credit jumps. It is
   * here so a run record carries an order-of-magnitude figure rather than nothing.
   *
   * @returns {{ requests: number, executions: number, executionCeiling: number, resultBytes: number,
   *   estimatedExportCredits: number }}
   */
  stats() {
    return {
      requests: this.#issued,
      executions: this.#executions,
      executionCeiling: this.#maxExecutions,
      resultBytes: this.#resultBytes,
      estimatedExportCredits: Number(((this.#resultBytes / 1_000_000) * 20).toFixed(3)),
    };
  }

  /**
   * Record the result bytes a response declared, for the export half of the credit estimate.
   *
   * @param {number} bytes
   */
  noteResultBytes(bytes) {
    if (Number.isFinite(bytes) && bytes > 0) this.#resultBytes += bytes;
  }

  /**
   * Start a query execution. **Never retried, on any failure.**
   *
   * @param {number} queryId
   * @param {Record<string, string>} parameters Query parameters, by name.
   * @returns {Promise<string>} The execution id.
   */
  async execute(queryId, parameters) {
    const label = `/query/${queryId}/execute`;
    const run = this.#queue.then(
      () => this.#startExecution(queryId, parameters, label),
      () => this.#startExecution(queryId, parameters, label),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * @param {number} queryId
   * @param {Record<string, string>} parameters
   * @param {string} label
   * @returns {Promise<string>}
   */
  async #startExecution(queryId, parameters, label) {
    if (this.#executions >= this.#maxExecutions) {
      throw new CeilingReached(
        this.#maxExecutions,
        label,
        'The Dune execution ceiling is this run\'s spend bound and an execution is billed whether or ' +
          'not it succeeds. Raise bounds.json dune.maxExecutionsPerRun only against a stated monthly ' +
          'arithmetic — nothing here tracks the month.',
      );
    }
    // Counted BEFORE the request. An execution that times out on our side may well have started on
    // theirs, and a counter that only increments on success would under-report the bill.
    this.#executions += 1;
    const body = await this.#request(label, { method: 'POST', body: { query_parameters: parameters } });
    const id =
      typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body)['execution_id'] : undefined;
    if (typeof id !== 'string' || id === '') {
      throw new DuneRefused(`Dune accepted ${label} but returned no execution id.`, { status: null, terminal: true });
    }
    return id;
  }

  /**
   * GET a JSON document. Retried once on a 5xx or a transport failure — reads are billed by bytes
   * returned, so a failed one costs nothing.
   *
   * @param {string} path e.g. `/execution/{id}/status`
   * @returns {Promise<unknown>}
   */
  async getJson(path) {
    const run = this.#queue.then(
      () => this.#request(path, { method: 'GET', retries: 1 }),
      () => this.#request(path, { method: 'GET', retries: 1 }),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * POST a JSON document. **Never retried.**
   *
   * The only caller is the deploy step, which CREATES a saved query. A retried create spends a
   * second of the Free tier's ten private query slots on the same statement, and a slot is not
   * something a later run can win back — see this module's header.
   *
   * @param {string} path
   * @param {unknown} body
   * @returns {Promise<unknown>}
   */
  async postJson(path, body) {
    const run = this.#queue.then(
      () => this.#request(path, { method: 'POST', body }),
      () => this.#request(path, { method: 'POST', body }),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Read the account's credit allowance — the pre-flight half of the monthly ceiling guard.
   *
   * **Free.** Dune documents `POST /usage` as a metadata endpoint that consumes no credits, so this
   * is RETRIED once, unlike every other POST this client makes. The three are three different
   * things and the difference is the whole reason they are separate methods: `execute` buys a billed
   * execution that cannot be taken back, `postJson` consumes an irreplaceable private-query slot,
   * and this one creates nothing and costs nothing — a transport hiccup on it must not be what
   * decides a run cannot afford itself.
   *
   * It returns the RAW body and reads nothing out of it. {@link parseUsageResponse} does that, and
   * it is a pure function precisely so the response shape can be pinned by tests with no key.
   *
   * @returns {Promise<unknown>}
   */
  async readUsage() {
    const run = this.#queue.then(
      () => this.#request(USAGE_PATH, { method: 'POST', body: {}, retries: 1 }),
      () => this.#request(USAGE_PATH, { method: 'POST', body: {}, retries: 1 }),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Sleep between polls, on this client's own injected clock so tests stay free. @param {number} ms */
  async wait(ms) {
    await this.#sleep(ms);
  }

  /**
   * @param {string} path
   * @param {{ method: 'GET' | 'POST', body?: unknown, retries?: number }} opts
   * @returns {Promise<unknown>}
   */
  async #request(path, opts) {
    const retries = opts.retries ?? 0;
    let lastTransportError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this.#issued >= this.#ceiling) {
        throw new CeilingReached(
          this.#ceiling,
          path,
          'The Dune request ceiling bounds polling and result reads. Raise bounds.json ' +
            'dune.maxRequestsPerRun, or raise dune.pollIntervalMs so a slow execution costs fewer polls.',
        );
      }

      const wait = this.#minIntervalMs - (Date.now() - this.#lastStartedAt);
      if (this.#lastStartedAt !== 0 && wait > 0) await this.#sleep(wait);

      this.#issued += 1;
      this.#lastStartedAt = Date.now();
      this.#onRequest?.(path, attempt);

      let response;
      try {
        response = await this.#fetch(`${DUNE_API_BASE}${path}`, {
          method: opts.method,
          headers: {
            // The only place the key is ever interpolated. A HEADER, never `Bearer`, and never a
            // query parameter — so no URL this client builds can carry a credential.
            'x-dune-api-key': this.#key,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        lastTransportError = new DuneRefused(
          `Transport failure on ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { status: null, terminal: false },
        );
        if (attempt < retries) continue;
        throw lastTransportError;
      }

      if (!response.ok) {
        const excerpt = await excerptBody(response);
        if (response.status >= 500 && attempt < retries) {
          lastTransportError = new DuneRefused(`HTTP ${response.status} on ${path}: ${excerpt}`, {
            status: response.status,
            terminal: false,
          });
          continue;
        }
        throw new DuneRefused(describeDuneStatus(response.status, path, excerpt), {
          status: response.status,
          // 401/402/403/429 mean the whole leg is unusable this run: a bad key, an exhausted free
          // allowance or a rate limit are not conditions the next call will find different.
          terminal: [401, 402, 403, 429].includes(response.status),
        });
      }

      try {
        return await response.json();
      } catch (cause) {
        throw new DuneRefused(
          `Response to ${path} was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          { status: response.status, terminal: false },
        );
      }
    }

    throw lastTransportError ?? new DuneRefused(`Request to ${path} failed with no diagnosis`, { status: null, terminal: false });
  }
}

// --- BEGIN SHARED REGION: the Dune monthly credit ceiling guard -------------------------------
//
// **THIS BLOCK IS DUPLICATED BYTE FOR BYTE IN `tools/deployer-screen/client.mjs` AND
// `tools/creation-census/client.mjs`, AND `test/dune-credit-ceiling.test.ts` FAILS IF THE TWO
// COPIES DRIFT.** The boundary in this repository is the DIRECTORY (`CLAUDE.md` -> "The one
// network-capable area is `tools/`"), a third vendor goes into `client.mjs` rather than a new file,
// and neither keyed tool may import the other. So the only way both tools can be guarded by ONE
// rule is a duplicated text pinned by a test — the same remedy `COHORT_SQL` already uses across the
// same boundary. Do not "fix" it by importing across the boundary, and do not edit one copy.
//
// WHAT IT GUARDS. Dune bills a monthly allowance in credits, and a FAILED execution is billed
// exactly like a successful one. Before this block existed, both tools discovered the ceiling by
// hitting it — an HTTP 402 partway through a multi-execution run leaves neither a result nor the
// credits to retry. The measured case that motivated it: one venue-research investigation spent
// ~350 credits, 14% of a month, in a single sitting.
//
// TWO CEILINGS APPLY AND THE SMALLER BINDS (captain decision 322a). The vendor reports what its
// PLAN includes for the current billing period; the OPERATOR configures a monthly cap of their own,
// pinned in each lane's own bounds file as `dune.monthlyCreditCapCredits` and never written in
// code. Neither figure is rewritten into the other: both of them, and the NAME of the one that
// bound, travel on every verdict this block returns, so an operator reading a refusal can tell
// whether to wait for the period to roll or to raise their own number. It is a `min()` rather than
// a chosen figure because BOTH sides move — a plan can be upgraded mid-period, and the cap is the
// captain's to change — and a `min()` needs no edit when either of them does.
//
// THE CAP IS A POLICY NUMBER AND IT IS ENFORCED PER ACCOUNT-PERIOD, WHICH IS NOT THE SAME THING.
// The captain's cap is one fleet-wide monthly total across every lane and project that touches Dune,
// and nothing here tracks spend across runs. It binds anyway WITHIN one account, because
// `credits_used` is that account's own running total for the billing period: a cap applied to the
// PERIOD's total rather than to a run is enforced by subtraction on every run, without any lane
// having to know what the others spent.
//
// **WHAT IT THEREFORE CANNOT DO, stated because the fleet already holds more than one Dune key.**
// Separate keys are separate ACCOUNTS with separate quotas and separate period boundaries, and each
// counter knows only its own account's spend. So this guard holds a run to the cap on WHICHEVER KEY
// IT USED, and two keys each honouring a 4,000-credit cap spend 8,000 between them with neither one
// wrong. Nothing in a `POST /usage` response can close that; only one key, or a smaller cap on each,
// can — and which of those is a captain's decision rather than a guard's. **Read the included figure
// and the period out of the response the key in use returned.** Do not carry either across keys and
// do not write either down: both are the vendor's, both move, and they are not the same numbers on
// two accounts.
//
// THREE UNITS, AND THEY ARE NOT INTERCHANGEABLE. Credits are the monthly allowance. Executions are
// billed whether or not they succeed and are what {@link DuneClient} already ceilings. Result BYTES
// are billed separately at {@link EXPORT_CREDITS_PER_MB}. This block converts a run's plan, stated
// in executions and bytes, into the one unit the allowance is denominated in.

/**
 * Dune's account-usage endpoint, relative to the API base.
 *
 * `POST` — not `GET`, which is the shape that catches a reader out — with an optional
 * `{start_date, end_date}` body; sending `{}` returns the CURRENT billing period. Dune documents it
 * as a metadata endpoint that consumes no credits, and this repository's own evaluation used it
 * throughout without the counter moving for it.
 */
export const USAGE_PATH = '/usage';

/**
 * Free-tier result-export price in credits per megabyte of result bytes — Dune's published figure,
 * and the one already applied by `stats().estimatedExportCredits`. Compute is billed ON TOP of it,
 * which is why an export figure alone is never presented as a bill.
 */
export const EXPORT_CREDITS_PER_MB = 20;

/**
 * Why a reading of the allowance is a FLOOR on spend rather than a measurement of it.
 *
 * Measured on this account during the Dune evaluation: the counter rose +6.0 credits while the
 * evaluator was completely idle, and it lands in whole-credit jumps. So `credits_used` at any
 * instant is behind the truth, `remaining` is therefore an OVER-statement, and a guard that spent
 * right up to it would be spending money the vendor has already taken. The reserve subtracted before
 * any comparison is what absorbs that, and it is pinned per lane rather than here.
 */
export const ALLOWANCE_LAG_CAVEAT =
  'The Dune usage counter LAGS and lands in whole-credit jumps — measured rising +6.0 credits while ' +
  'this account was idle. A reading is a floor on what has been spent and a ceiling on what remains, ' +
  'never a measurement of either, so the allowance check subtracts a pinned reserve before comparing.';

/**
 * The half of the allowance no reading can bound: it is ONE ACCOUNT's, and the fleet holds more than
 * one.
 *
 * **The keys are the CAPTAIN'S ALONE and are no longer shared with another holder** (captain
 * decision 322a — which is what makes a configured monthly cap enforceable at all: a cap on an
 * allowance a stranger also draws on would be a wish). Two things a reading still cannot bound.
 * WITHIN the account: the screen, the census, the reproduction lane and any browser session spend
 * the same total, nothing here holds state between runs, and a sibling run can take the remainder
 * between our reading and our first execution. ACROSS accounts: separate keys are separate accounts
 * with their own quotas and their own period boundaries, so this reading describes the key this run
 * used and says nothing whatever about the others. The reserve makes the first less likely; it
 * cannot make it impossible, and it does not touch the second at all.
 *
 * **This is NOT the lag caveat and neither stands in for the other.** "Unshared" says no stranger is
 * spending the balance. {@link ALLOWANCE_LAG_CAVEAT} says the counter itself is behind the truth.
 * Only the first of those changed, and reading the change as "the counter is exact now" would spend
 * the reserve on a claim nobody made.
 */
export const ALLOWANCE_ACCOUNT_WIDE_CAVEAT =
  'The Dune allowance is ONE ACCOUNT\'s — the key this run used. That key is UNSHARED, but every lane ' +
  'and run of this fleet draws on the same account total, nothing tracks it between runs, and a ' +
  'SEPARATE key is a separate account with its own quota and its own period. A sufficient reading is ' +
  'evidence, never a reservation.';

/**
 * Where the operator's own monthly cap is edited, named in the sentences a refusal prints.
 *
 * Captain decision 322a puts the cap in CONFIGURATION and nowhere else — this string is a POINTER
 * to that key, never the value, which is the whole reason it may live in code. Both keyed lanes
 * spell the key identically under their own bounds file (`tools/deployer-screen/thresholds.json` and
 * `tools/creation-census/bounds.json`), so one lane-neutral pointer is honest for both and this
 * region stays duplicable byte for byte.
 */
export const MONTHLY_CAP_PIN = 'dune.monthlyCreditCapCredits';

/**
 * What a run's own arithmetic is worth once it has started spending.
 *
 * Between the pre-flight reading and the end of a run the vendor counter is useless — it lags by
 * more than the run lasts — so what a record carries for its own spend is computed locally from the
 * executions issued and the bytes read. It is an ESTIMATE and the label travels with the number:
 * execution compute is priced by a table Dune does not publish, and `execution_cost_credits`
 * understates the bill by ~3.5x because retrieving results is ~71% of it.
 */
export const LOCAL_ESTIMATE_CAVEAT =
  'LOCAL ESTIMATE, not the bill: executions priced at this lane\'s pinned worst case and bytes at the ' +
  'published export rate. Dune publishes no execution-compute price table and `execution_cost_credits` ' +
  'understates the bill by ~3.5x. Only POST /usage is authoritative, and it lags minutes.';

/**
 * @typedef {object} DuneAllowance
 * @property {number} creditsUsed      As the vendor reported it, for the selected billing period.
 * @property {number} creditsIncluded  The period's allowance. 2,500 on the Free tier.
 * @property {number} creditsRemaining `creditsIncluded - creditsUsed`, floored at 0.
 * @property {string} periodStart      `YYYY-MM-DD`, the vendor's own string.
 * @property {string} periodEnd        `YYYY-MM-DD`. **NOT a calendar month** — one of this fleet's
 *   Dune accounts was measured running 2026-07-29 -> 2026-08-29, i.e. it resets on a subscription
 *   anniversary, and a DIFFERENT key is a different account on a different period. Always read this
 *   out of the response the key in use returned; never carry a period across keys.
 * @property {number} periodsReturned  How many periods the response carried.
 * @property {number} readAtMs         When this reading was taken. A reading ages badly; see the lag.
 * @property {number | null} privateQueries Saved private queries in use, when the response says. The
 *   Free tier allows 10 and the census's deploy step counts them a different way; this is a bonus
 *   field, never the authority.
 */

/**
 * @typedef {object} UsageReading
 * @property {boolean} ok
 * @property {DuneAllowance | null} allowance
 * @property {string[]} reasons Why the response could not be read, when it could not.
 */

/**
 * Read `POST /usage`'s body into an allowance, or refuse it.
 *
 * **ONE FIELD NAME HERE IS AN ASSUMPTION AND IS MARKED AS ONE.** Dune's own documentation
 * contradicts itself: the response SCHEMA names the array `billing_periods` and the EXAMPLE beside
 * it names the same array `billingPeriods`. This repository has no committed capture of a live
 * response to settle it, so both spellings are accepted and which one answered is not recorded —
 * accepting both is cheaper than being wrong, and being wrong here refuses a run that could have
 * proceeded. If a live response ever settles it, narrow this; do not widen it further.
 *
 * Everything else is refused rather than guessed. A response this cannot read yields no allowance,
 * and a caller with no allowance refuses the run — absence of evidence is not evidence of headroom.
 *
 * @param {unknown} body
 * @param {number} readAtMs
 * @returns {UsageReading}
 */
export function parseUsageResponse(body, readAtMs) {
  /** @type {string[]} */
  const reasons = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, allowance: null, reasons: ['POST /usage did not return a JSON object.'] };
  }
  const doc = /** @type {Record<string, unknown>} */ (body);
  const raw = doc['billing_periods'] ?? doc['billingPeriods'];
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      allowance: null,
      reasons: [
        'POST /usage carried no billing period (neither `billing_periods` nor `billingPeriods` held a ' +
          'non-empty array), so this run cannot see what the allowance has left.',
      ],
    };
  }

  /** @type {{ start: string, end: string, used: number, included: number, startMs: number, endMs: number }[]} */
  const periods = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const p = /** @type {Record<string, unknown>} */ (entry);
    const start = p['start_date'];
    const end = p['end_date'];
    const used = p['credits_used'];
    const included = p['credits_included'];
    // TYPE-checked, never truth-checked: `credits_used: 0` is a legitimate reading at the start of a
    // period, and `=== 0` collapsing into "the field is gone" is the failure shape this repository
    // already records for Dune's `bonded` column.
    if (typeof start !== 'string' || typeof end !== 'string') continue;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) continue;
    if (typeof included !== 'number' || !Number.isFinite(included) || included <= 0) continue;
    const startMs = parseUsageDate(start);
    const endMs = parseUsageDate(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    periods.push({ start, end, used, included, startMs, endMs });
  }
  if (periods.length === 0) {
    reasons.push(
      'POST /usage returned billing periods but none of them carried a readable start_date, end_date, ' +
        'credits_used and credits_included, so the allowance is unknown rather than large.',
    );
    return { ok: false, allowance: null, reasons };
  }

  // The period that BRACKETS the reading is the ONLY one a run may spend against, and when none
  // does this REFUSES rather than substituting another. We always POST an empty body, which the
  // vendor documents as returning the CURRENT period, so a non-bracketing answer means the vendor,
  // the clock or our reading of the shape is wrong — and a balance that could not be established is
  // not headroom, the same rule {@link decideAllowance} applies to a null allowance. The newest
  // period's own dates go into the refusal so an operator can see what the vendor did return.
  const bracketing = periods.filter((p) => p.startMs <= readAtMs && readAtMs < p.endMs);
  if (bracketing.length === 0) {
    const newest = periods.reduce((a, b) => (b.startMs > a.startMs ? b : a));
    reasons.push(
      `POST /usage returned ${periods.length} readable billing period(s) but none of them contains the ` +
        `instant of this reading (${new Date(readAtMs).toISOString()}), so the CURRENT billing period ` +
        `could not be established; the newest one listed runs ${newest.start} -> ${newest.end}.`,
    );
    return { ok: false, allowance: null, reasons };
  }
  const chosen = bracketing.reduce((a, b) => (b.startMs > a.startMs ? b : a));
  const privateQueries = doc['private_queries'];

  return {
    ok: true,
    reasons,
    allowance: {
      creditsUsed: chosen.used,
      creditsIncluded: chosen.included,
      creditsRemaining: Math.max(0, chosen.included - chosen.used),
      periodStart: chosen.start,
      periodEnd: chosen.end,
      periodsReturned: periods.length,
      readAtMs,
      privateQueries:
        typeof privateQueries === 'number' && Number.isFinite(privateQueries) ? privateQueries : null,
    },
  };
}

/**
 * @typedef {object} DuneSpendPlan
 * @property {string} lane                 Which tool is asking, for the refusal sentence.
 * @property {number} executions           Executions this run MAY spend — the client's ceiling, not
 *   the expected count. A plan is admissible only if its worst case fits; that is the same rule the
 *   screen already applies to Helius credits.
 * @property {number} creditsPerExecution  Worst-case execution-compute credits for ONE of this
 *   lane's executions. Pinned per lane, because Dune publishes no price table for compute and the
 *   real figure depends entirely on what the statement scans — measured 0.75-0.92 credits for this
 *   repository's creation queries against 221.5 for one that joined the trade tape.
 * @property {number} resultReads          Result reads this run may issue.
 * @property {number} rowsPerRead          The `?limit=` a read is issued with. Bytes, not rows, are
 *   what is billed; this is one factor of the bytes bound.
 * @property {number} bytesPerRow          Pinned per-row byte ceiling for this lane's result shape.
 */

/**
 * @typedef {object} DuneSpendEstimate
 * @property {number} executionCredits Worst-case compute.
 * @property {number} exportBytes      Worst-case result bytes.
 * @property {number} exportCredits    Those bytes at {@link EXPORT_CREDITS_PER_MB}.
 * @property {number} worstCaseCredits The sum, and the only figure a decision compares.
 */

/**
 * Price a run's PLAN before it spends anything.
 *
 * It prices the worst case the client's own ceilings admit, never the expected cost, and the two
 * differ by more than an order of magnitude on a normal run. That is deliberate and it is the same
 * discipline the Helius leg already uses: a plan is admissible when its worst case fits, so the
 * ceiling is exact rather than usually-right. Refusing a run that would have cost 2 credits because
 * it COULD have cost 195 is the safe direction — the screen falls back to a slower walk and the
 * census waits for the period to roll — and the alternative is the failure this guard exists to
 * prevent: dying at the fifth execution with the month gone.
 *
 * @param {DuneSpendPlan} plan
 * @returns {DuneSpendEstimate}
 */
export function estimatePlanCredits(plan) {
  const executions = Math.max(0, plan.executions);
  const executionCredits = executions * Math.max(0, plan.creditsPerExecution);
  const exportBytes = Math.max(0, plan.resultReads) * Math.max(0, plan.rowsPerRead) * Math.max(0, plan.bytesPerRow);
  const exportCredits = (exportBytes / 1_000_000) * EXPORT_CREDITS_PER_MB;
  return {
    executionCredits: round3(executionCredits),
    exportBytes,
    exportCredits: round3(exportCredits),
    worstCaseCredits: round3(executionCredits + exportCredits),
  };
}

/**
 * @typedef {object} CreditCeiling
 * @property {number} ceilingCredits   The SMALLER of the two, and the only one a decision spends
 *   against.
 * @property {'operator-cap' | 'vendor-plan'} binding Which one that was.
 * @property {number} monthlyCapCredits     The operator's configured cap, unchanged.
 * @property {number} vendorCreditsIncluded The vendor's reported plan, unchanged.
 */

/**
 * Resolve the operator's monthly cap and the vendor's reported plan into the one that binds.
 *
 * **BOTH ARE REAL NUMBERS AND THE SMALLER ONE WINS — that is the whole of captain decision 322a.**
 * Before it, the guard followed whatever the vendor happened to report as included and the
 * operator's own monthly limit was enforced nowhere: at a plan of 2,500 against a cap of 4,000 the
 * cap looked harmless, and an account upgraded past the cap would have spent straight through it
 * with nothing noticing.
 *
 * **NEITHER FIGURE IS REWRITTEN INTO THE OTHER.** Both come back beside the answer so every
 * sentence downstream can state which ceiling bound and by how much, rather than presenting one
 * number as though it were the only one there ever was.
 *
 * **A TIE IS REPORTED AS THE VENDOR'S.** The two are then the same number and either label is
 * arithmetically honest, so it goes to the externally-imposed one: at equality, raising the cap buys
 * nothing, which is what `vendor-plan` tells an operator to expect.
 *
 * @param {number} monthlyCapCredits     The operator's configured monthly cap, already validated.
 * @param {number} vendorCreditsIncluded What `POST /usage` reported for the current period.
 * @returns {CreditCeiling}
 */
export function bindingCreditCeiling(monthlyCapCredits, vendorCreditsIncluded) {
  const capBinds = monthlyCapCredits < vendorCreditsIncluded;
  return {
    ceilingCredits: capBinds ? monthlyCapCredits : vendorCreditsIncluded,
    binding: capBinds ? 'operator-cap' : 'vendor-plan',
    monthlyCapCredits,
    vendorCreditsIncluded,
  };
}

/**
 * @typedef {object} AllowanceDecision
 * @property {'sufficient' | 'tight' | 'insufficient' | 'unreadable'} verdict
 * @property {boolean} ok                  Whether the run may spend. `tight` is a WARNING and passes.
 * @property {number} worstCaseCredits     What the plan could cost.
 * @property {number | null} creditsUsed
 * @property {number | null} creditsIncluded The EFFECTIVE ceiling — the smaller of the operator's
 *   cap and the vendor's plan, which is what the balance was actually measured against. The two
 *   inputs survive beside it in `monthlyCapCredits` and `creditsIncludedVendor`, and
 *   `bindingCeiling` names which of them this is.
 * @property {number | null} monthlyCapCredits     The operator's configured cap, as configured.
 * @property {number | null} creditsIncludedVendor The vendor's reported plan, as reported.
 * @property {'operator-cap' | 'vendor-plan' | null} bindingCeiling Which ceiling bound. `null` when
 *   no comparison happened at all, which is not the same as neither binding.
 * @property {number | null} creditsRemaining
 * @property {number} reserveCredits       Held back for the counter's lag; never spendable.
 * @property {number | null} spendableCredits `creditsRemaining - reserveCredits`, floored at 0.
 * @property {number | null} shortfallCredits How far short the plan is, when it is short.
 * @property {string | null} periodStart
 * @property {string | null} periodEnd
 * @property {string | null} readAtUtc
 * @property {string[]} reasons            The refusal or the warning, in full sentences.
 * @property {string[]} caveats            What this decision cannot see. Always non-empty.
 */

/**
 * Decide whether a plan may spend, given what the allowance says.
 *
 * FOUR OUTCOMES, and the third and fourth are the point:
 *
 * - `sufficient` — the plan's worst case fits with room to run it again.
 * - `tight` — it fits, but not twice. The run PROCEEDS and says so: a run that cannot be repeated is
 *   a run whose failure cannot be retried, and an operator about to queue heavier work should see
 *   that before the period rolls, not after.
 * - `insufficient` — refuse BEFORE the first execution. Stopping here is the whole deliverable;
 *   stopping after the fifth execution is the failure.
 * - `unreadable` — the allowance could not be read, so nothing is known. It refuses by default,
 *   because "we could not see the balance" is not a reason to spend. A lane may pass
 *   `allowanceRequired: false` to proceed unguarded, and then the caveat travels with the run.
 *
 * A PLAN THAT DOES NOT PRICE IS `unreadable` TOO, AND IT REFUSES UNCONDITIONALLY. The pinned bounds
 * both lanes price against are read from JSON at runtime through an untyped object, so a missing or
 * non-numeric bound reaches {@link estimatePlanCredits} and comes back as `NaN` — and every `<`
 * against `NaN` is false, which would clear a run priced at nothing through the `sufficient` door.
 * That inverts the guard's own rule, so the finiteness of the worst case and of the reserve is
 * checked BEFORE any comparison rather than at each one, and no `allowanceRequired: false` opts out
 * of it: the question was never answered, so there is nothing for a lane to waive.
 *
 * **THE OPERATOR'S MONTHLY CAP IS CHECKED IN THAT SAME PLACE AND IS REQUIRED** (captain decision
 * 322a). It is read from the same untyped JSON and reaches the same comparison, so it fails the same
 * way; and it is required rather than optional because an absent cap would be a lane silently
 * uncapped, which is the state this decision exists to end. A lane that wants headroom raises the
 * number where an operator can see it. {@link bindingCreditCeiling} then decides which of the two
 * ceilings the balance is measured against, and BOTH figures reach the reasons either way.
 *
 * @param {object} input
 * @param {DuneSpendPlan} input.plan
 * @param {DuneSpendEstimate} input.estimate
 * @param {DuneAllowance | null} input.allowance
 * @param {readonly string[]} [input.unreadableReasons] Why there is no allowance, when there is none.
 * @param {number} input.reserveCredits
 * @param {number} input.monthlyCapCredits The OPERATOR's fleet-wide monthly cap, from this lane's
 *   pinned bounds. Must be a finite positive number of credits; anything else refuses.
 * @param {number} input.tightMultiple    How many worst cases must fit before a run is not "tight".
 * @param {boolean} input.allowanceRequired
 * @returns {AllowanceDecision}
 */
export function decideAllowance(input) {
  const reserve = Math.max(0, input.reserveCredits);
  const worst = input.estimate.worstCaseCredits;
  const cap = input.monthlyCapCredits;
  const capIsUsable = typeof cap === 'number' && Number.isFinite(cap) && cap > 0;
  const caveats = [ALLOWANCE_LAG_CAVEAT, ALLOWANCE_ACCOUNT_WIDE_CAVEAT];

  if (!Number.isFinite(worst) || !Number.isFinite(reserve) || !capIsUsable) {
    const broken = !Number.isFinite(worst)
      ? `the plan's worst case priced to ${String(worst)}`
      : !Number.isFinite(reserve)
        ? `the reserve priced to ${String(input.reserveCredits)}`
        : `the operator's monthly cap read as ${String(cap)}`;
    return {
      verdict: 'unreadable',
      ok: false,
      worstCaseCredits: worst,
      creditsUsed: null,
      creditsIncluded: null,
      monthlyCapCredits: null,
      creditsIncludedVendor: null,
      bindingCeiling: null,
      creditsRemaining: null,
      reserveCredits: reserve,
      spendableCredits: null,
      shortfallCredits: null,
      periodStart: null,
      periodEnd: null,
      readAtUtc: null,
      reasons: [
        `REFUSED before spending anything: ${broken}, not a finite positive number of credits, so ` +
          `${input.plan.lane} cannot say what this run could cost or what it may spend, and no ` +
          `comparison against the balance would mean anything.` +
          (capIsUsable
            ? ` A pinned bound is missing or non-numeric: the one named above.`
            : ` The cap itself lives in configuration, at ${MONTHLY_CAP_PIN}.`),
      ],
      caveats,
    };
  }

  if (input.allowance === null) {
    const why = [...(input.unreadableReasons ?? [])];
    return {
      verdict: 'unreadable',
      ok: !input.allowanceRequired,
      worstCaseCredits: worst,
      creditsUsed: null,
      creditsIncluded: null,
      monthlyCapCredits: cap,
      creditsIncludedVendor: null,
      bindingCeiling: null,
      creditsRemaining: null,
      reserveCredits: reserve,
      spendableCredits: null,
      shortfallCredits: null,
      periodStart: null,
      periodEnd: null,
      readAtUtc: null,
      reasons: [
        `The Dune allowance could not be read, so this run cannot say whether its worst case of ` +
          `${worst} credit(s) fits. ` +
          (input.allowanceRequired
            ? `Refused before spending anything — an unreadable balance is not headroom.`
            : `Proceeding UNGUARDED because this lane was configured not to require the reading.`),
        `The operator's monthly cap of ${cap} credit(s) (${MONTHLY_CAP_PIN}) is configured and ` +
          `applies; what could not be read is the vendor's own figure and this period's spend, so ` +
          `neither ceiling could be compared against anything.`,
        ...why,
      ],
      caveats,
    };
  }

  // THE `min()` CAPTAIN DECISION 322a ASKS FOR, and the reason it needs no cross-run bookkeeping:
  // `creditsUsed` is the ACCOUNT's running total for the whole billing period, so measuring it
  // against the smaller of the two ceilings enforces a fleet-wide monthly cap on every run without
  // any lane knowing what the others spent. When the vendor's plan is the smaller number this is
  // arithmetically what the guard already did, which is why an uncapped-in-practice cap costs a run
  // nothing at all — a cap that needlessly refused runs would fail the captain's second requirement
  // exactly as an overspend fails the first.
  const ceiling = bindingCreditCeiling(cap, input.allowance.creditsIncluded);
  const capBinds = ceiling.binding === 'operator-cap';
  const remaining = capBinds
    ? Math.max(0, round3(ceiling.ceilingCredits - input.allowance.creditsUsed))
    : input.allowance.creditsRemaining;
  const spendable = Math.max(0, round3(remaining - reserve));
  const shortfall = spendable >= worst ? 0 : round3(worst - spendable);
  const period = `${input.allowance.periodStart} -> ${input.allowance.periodEnd}`;
  const balance =
    `${input.allowance.creditsUsed} of ${ceiling.ceilingCredits} credit(s) used in the billing ` +
    `period ${period}; ${remaining} remain, ${spendable} spendable after the ${reserve}-credit reserve.`;
  // BOTH FIGURES SURVIVE, ON EVERY VERDICT INCLUDING THE PASSING ONES. Printing only the binding one
  // would silently rewrite the operator's number into the vendor's or the other way about, and an
  // operator could not tell a cap they set from a plan they were sold.
  const ceilings =
    `Two ceilings apply and the SMALLER binds: the operator's monthly cap of ${cap} credit(s) ` +
    `(${MONTHLY_CAP_PIN}) and the vendor's reported plan of ${ceiling.vendorCreditsIncluded} for ` +
    `this key's own billing period. ` +
    `${capBinds ? 'THE OPERATOR CAP' : "THE VENDOR'S PLAN"} binds, at ${ceiling.ceilingCredits} credit(s).`;

  if (spendable < worst) {
    return {
      verdict: 'insufficient',
      ok: false,
      worstCaseCredits: worst,
      creditsUsed: input.allowance.creditsUsed,
      creditsIncluded: ceiling.ceilingCredits,
      monthlyCapCredits: cap,
      creditsIncludedVendor: ceiling.vendorCreditsIncluded,
      bindingCeiling: ceiling.binding,
      creditsRemaining: remaining,
      reserveCredits: reserve,
      spendableCredits: spendable,
      shortfallCredits: shortfall,
      periodStart: input.allowance.periodStart,
      periodEnd: input.allowance.periodEnd,
      readAtUtc: new Date(input.allowance.readAtMs).toISOString(),
      reasons: [
        `REFUSED before the first execution: ${input.plan.lane} plans at most ${input.plan.executions} ` +
          `execution(s) and ${input.plan.resultReads} result read(s), a worst case of ${worst} credit(s), ` +
          `and it is ${shortfall} credit(s) short.`,
        balance,
        ceilings,
        // WHICH LEVER CLEARS IT, stated rather than left to be inferred from two numbers. An
        // operator reading a refusal has exactly two moves — wait, or raise their own cap — and only
        // one of them is on their side of the vendor.
        capBinds
          ? `THE OPERATOR CAP is what refused this run: raising ${MONTHLY_CAP_PIN} clears it now, and ` +
            `so does the counter resetting. The period rolls on ${input.allowance.periodEnd}. The ` +
            `vendor's plan of ${ceiling.vendorCreditsIncluded} credit(s) still had room and is not ` +
            `what refused.`
          : `THE VENDOR'S PLAN is what refused this run: raising ${MONTHLY_CAP_PIN} would change ` +
            `nothing, because ${ceiling.vendorCreditsIncluded} is the smaller of the two ceilings. ` +
            `The period rolls on ${input.allowance.periodEnd}.`,
        `An execution is billed whether or not it succeeds, so a run that starts and cannot finish ` +
          `leaves neither a result nor the credits to retry.`,
      ],
      caveats,
    };
  }

  const tight = spendable < worst * Math.max(1, input.tightMultiple);
  return {
    verdict: tight ? 'tight' : 'sufficient',
    ok: true,
    worstCaseCredits: worst,
    creditsUsed: input.allowance.creditsUsed,
    creditsIncluded: ceiling.ceilingCredits,
    monthlyCapCredits: cap,
    creditsIncludedVendor: ceiling.vendorCreditsIncluded,
    bindingCeiling: ceiling.binding,
    creditsRemaining: remaining,
    reserveCredits: reserve,
    spendableCredits: spendable,
    shortfallCredits: 0,
    periodStart: input.allowance.periodStart,
    periodEnd: input.allowance.periodEnd,
    readAtUtc: new Date(input.allowance.readAtMs).toISOString(),
    reasons: tight
      ? [
          `TIGHT: the worst case of ${worst} credit(s) fits, but fewer than ${input.tightMultiple} of ` +
            `them do, so this run may be the last one this period can afford.`,
          balance,
          ceilings,
        ]
      : [balance, ceilings],
    caveats,
  };
}

/**
 * Render a decision as lines an operator reads before anything is spent. One place, so the screen's
 * stdout, the census's stdout and a dry run all say the same thing in the same words.
 *
 * @param {AllowanceDecision} decision
 * @returns {string[]}
 */
export function describeAllowanceDecision(decision) {
  const head = `dune allowance: ${decision.verdict.toUpperCase()} — worst case ${decision.worstCaseCredits} credit(s)`;
  return [head, ...decision.reasons.map((r) => `  ${r}`), ...decision.caveats.map((c) => `  ! ${c}`)];
}

/**
 * What this run believes it spent, computed from its own counters rather than from the vendor.
 *
 * The vendor's counter lags by longer than a run lasts, so re-reading it at the end would report the
 * balance from before the run. This is the only figure a record can carry for its own spend, and
 * {@link LOCAL_ESTIMATE_CAVEAT} travels with it everywhere it surfaces.
 *
 * @param {object} input
 * @param {number} input.executions          Executions actually issued.
 * @param {number} input.creditsPerExecution The lane's pinned worst case per execution.
 * @param {number} input.resultBytes         Bytes the vendor's own metadata declared.
 * @returns {{ executions: number, resultBytes: number, executionCredits: number, exportCredits: number,
 *   estimatedCredits: number, caveat: string }}
 */
export function localCreditEstimate(input) {
  const executionCredits = Math.max(0, input.executions) * Math.max(0, input.creditsPerExecution);
  const exportCredits = (Math.max(0, input.resultBytes) / 1_000_000) * EXPORT_CREDITS_PER_MB;
  return {
    executions: input.executions,
    resultBytes: input.resultBytes,
    executionCredits: round3(executionCredits),
    exportCredits: round3(exportCredits),
    estimatedCredits: round3(executionCredits + exportCredits),
    caveat: LOCAL_ESTIMATE_CAVEAT,
  };
}

/** @param {number} n @returns {number} */
function round3(n) {
  return Number(n.toFixed(3));
}

/**
 * Read a billing period boundary, whichever of the two shapes the vendor sends.
 *
 * Dune documents `start_date`/`end_date` as bare `YYYY-MM-DD` and this repository has no live
 * capture to confirm it. A bare date parses on its own as UTC midnight, so the direct parse is tried
 * FIRST and the `T00:00:00Z` suffix is only a fallback for a value the runtime cannot parse alone.
 * The other order is what breaks: appending the suffix to a full ISO timestamp yields
 * `...T00:00:00ZT00:00:00Z`, drops every period, and reads as unreadable — which sends the screen to
 * the ~13 h RPC walk on every run and refuses the census permanently, since it has no fallback.
 *
 * @param {string} value
 * @returns {number} Epoch milliseconds, or `NaN` when neither shape parses.
 */
function parseUsageDate(value) {
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  return Date.parse(`${value}T00:00:00Z`);
}

// --- END SHARED REGION: the Dune monthly credit ceiling guard ---------------------------------
