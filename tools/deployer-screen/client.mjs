/**
 * One of the two network-capable modules in this repository (the other is `pumpfun.mjs`), and the
 * one that holds every KEYED vendor client: MadeOnSol's {@link BoundedClient} and Dune's
 * {@link DuneClient}. New clients land here rather than in a file of their own on purpose — the
 * `fetch` allow-list in `test/deployer-screen.test.ts` is exactly two files, and keeping it at two
 * is what makes "one request in flight, under a ceiling" auditable by reading two files.
 *
 * slot-zero's analysis core under `src/` is keyless by construction and
 * `test/loader.test.ts` proves it by grepping the sources for sockets, `process.env` and
 * key-shaped strings. That guard is untouched. This file lives outside `src/` on purpose:
 * the boundary is the directory, and `test/deployer-screen.test.ts` asserts that the network
 * client stays on this side of it.
 *
 * Everything here is about *bounds*, because the key is the captain's own and its allowance is
 * shared:
 *
 * - **A hard request ceiling.** {@link BoundedClient} counts every request it issues,
 *   including failures and retries, and throws {@link CeilingReached} rather than issue the
 *   one that would cross the line. There is no flag that disables the ceiling.
 * - **One request in flight, ever.** Not a pool of one — a serialised queue, so two callers
 *   cannot race past each other. Two concurrent jobs against this vendor's keyless endpoint
 *   earned a sustained lockout once already (see CLAUDE.md); the same caution applies to the
 *   keyed one.
 * - **Paced.** Free tier bursts at ~10/min, so the default gap is 6.5 s and the client sleeps
 *   the remainder itself rather than trusting the caller to.
 * - **No retries by default.** A retry is a second request against a shared allowance. The
 *   client will retry a 5xx or a transport error at most `maxRetriesPerRequest` times, which
 *   defaults to 1, and every attempt is counted against the ceiling.
 *
 * There is no cache, no persistence and no background anything. The client holds a response
 * only long enough to return it.
 */

import { DUNE_API_BASE, classifyAuthFailure } from './credential.mjs';

/** Production base URL, from `servers[0].url` of their OpenAPI document. */
export const BASE_URL = 'https://madeonsol.com/api/v1';

/**
 * The consequence and the lever for the ceiling this class was written for: the keyed run-wide
 * allowance, which `--max-requests` sets. It is the default because that is the only ceiling this
 * module owns — every other client that throws this must say what its OWN ceiling bounds.
 */
const KEYED_RUN_CEILING_REMEDY =
  'The run stopped early and the ranking below is INCOMPLETE. Raise --max-requests only ' +
  'if the shared daily allowance can afford it.';

/**
 * Thrown when a request would exceed the run's ceiling. Carries no credential.
 *
 * `remedy` is a parameter rather than a constant because this message is **persisted**: the
 * creation walk stores it in a run record's `creation.stopDetail` — vendor identifiers struck on the
 * way in by `record.mjs` → `redactCreationNotes`, the wording itself untouched — and the grading
 * lane reads run records. A per-candidate RPC ceiling reusing the keyed run ceiling's wording put "the
 * run stopped early" and "raise --max-requests" into a record whose top level said
 * `completed: true`, over a lever that does not apply to it — two false statements in the declared
 * input of another lane. A caller with its own ceiling passes its own consequence and its own lever.
 */
export class CeilingReached extends Error {
  /**
   * @param {number} ceiling
   * @param {string} attemptedPath
   * @param {string} [remedy] What this particular ceiling stopped, and which lever raises it.
   */
  constructor(ceiling, attemptedPath, remedy = KEYED_RUN_CEILING_REMEDY) {
    super(`Request ceiling of ${ceiling} reached; refusing to issue ${attemptedPath}. ${remedy}`);
    this.name = 'CeilingReached';
    /** @type {number} */ this.ceiling = ceiling;
    /** @type {string} */ this.attemptedPath = attemptedPath;
  }
}

/**
 * Thrown when a request did not come back with a usable answer.
 *
 * Carries **what actually happened** rather than only a message, because the record classifies a
 * missing measurement from the exception and a sentence is not evidence. `retried` is whether this
 * client made more than one attempt, and `status` is the HTTP status if one was ever received —
 * `null` for a transport failure or a timeout, where no status exists to report.
 *
 * The pair is what lets a reader tell "we tried twice and it still failed" from "the endpoint
 * answered once and we chose not to ask again". A record that claims the first when the second
 * happened is exactly the defect this class exists to prevent.
 */
export class RequestFailed extends Error {
  /**
   * @param {string} message
   * @param {{ status: number | null, retried: boolean }} what
   */
  constructor(message, what) {
    super(message);
    this.name = 'RequestFailed';
    /** @type {number | null} */ this.status = what.status;
    /** @type {boolean} */ this.retried = what.retried;
  }
}

/**
 * Thrown when a request was served but its body could not be parsed as JSON.
 *
 * Its own type rather than a plain error, because the two plausible causes sit on opposite sides of
 * the boundary and **asserting an inaccurate cause is worse than asserting none**. The likeliest is
 * an HTTP 200 carrying an edge interstitial or error page, which is the vendor's; a genuine bug in
 * our own handling is the other. Nothing available here can tell them apart, so the record says what
 * happened and declines to assign blame. A plain error would have been read as ours, and would have
 * sent an operator hunting a bug that does not exist.
 */
export class UnparseableResponse extends Error {
  /**
   * @param {string} message
   * @param {{ status: number }} what
   */
  constructor(message, what) {
    super(message);
    this.name = 'UnparseableResponse';
    /** @type {number} */ this.status = what.status;
  }
}

/**
 * Thrown when the vendor rejects the key or the quota, or rejects our query shape. Terminal:
 * the caller must exit non-zero rather than render an empty ranking.
 */
export class VendorRefused extends Error {
  /**
   * @param {import('./credential.mjs').AuthFailure} failure
   * @param {number} status
   */
  constructor(failure, status) {
    super(failure.message);
    this.name = 'VendorRefused';
    /** @type {import('./credential.mjs').AuthFailureKind} */ this.kind = failure.kind;
    /** @type {number} */ this.status = status;
  }
}

/**
 * @typedef {object} ClientOptions
 * @property {string} key                   Bearer token. Held in this closure and nowhere else.
 * @property {number} maxRequests           Hard ceiling on issued requests.
 * @property {number} [minIntervalMs]       Minimum gap between request starts. Default 6500.
 * @property {number} [timeoutMs]           Per-request timeout. Default 30000.
 * @property {number} [maxRetriesPerRequest] Default 1. Each attempt counts against the ceiling.
 * @property {(path: string, attempt: number) => void} [onRequest] Progress hook. Receives the
 *   path only — never a header, never the key.
 * @property {typeof fetch} [fetchImpl]     Injected for tests. Tests pass a stub; there is no
 *   code path in the test suite that reaches the real network.
 * @property {(ms: number) => Promise<void>} [sleepImpl] Injected for tests so pacing is free.
 */

/**
 * @typedef {object} EndpointSpend
 * @property {string} endpoint  Path template, wallet segment collapsed to `{wallet}`.
 * @property {string} role      What the endpoint is for, from {@link ENDPOINT_ROLES}.
 * @property {string} costModel Per-call cost in keyed requests, as a phrase.
 * @property {number} calls     Requests actually issued against it, retries included.
 */

/**
 * @typedef {object} RequestStats
 * @property {number} issued      Requests actually sent, including retries and failures.
 * @property {number} ceiling     The configured hard limit.
 * @property {number} elapsedMs   Wall clock from construction to the last completed request.
 * @property {EndpointSpend[]} byEndpoint  Where the spend went, in first-call order.
 */

/**
 * The keyed surface this tool uses, and what each call costs.
 *
 * The captain asked for the endpoint list by name and for spend to be reported concretely rather
 * than as one aggregate number, so this table is the tool's own answer rather than prose in a
 * README that can drift from the code. Only `{wallet}` scales: everything else is one call per run.
 *
 * Two endpoints are deliberately absent and stay absent — `/deployer-hunter/{wallet}/tokens` is
 * bonded-only (no denominator, and it rejects `limit` above 50) and `/deployer-hunter/{wallet}/history`
 * is PRO+, which standing policy refuses.
 *
 * @type {Record<string, { role: string, costModel: string }>}
 */
export const ENDPOINT_ROLES = {
  '/deployer-hunter/recent-bonds': { role: 'enumeration; carries the tier filter', costModel: '1 per run' },
  '/deployer-hunter/alerts': { role: 'enumeration', costModel: '1 per run' },
  '/deployer-hunter/leaderboard': { role: 'enumeration', costModel: '1 per run' },
  '/deployer-hunter/{wallet}': { role: 'the gate', costModel: '1 per candidate — the only cost that scales' },
};

/**
 * Collapse a requested path onto the endpoint template it belongs to.
 *
 * Per-endpoint accounting has to survive both the query string and the wallet address, and a
 * wallet must never end up as a key of its own — that would turn a spend table into a list of
 * addresses we screened, which the record's own projection is careful not to persist twice.
 *
 * The wallet substitution is **positional, not exact-match**: the segment after `/deployer-hunter/`
 * is collapsed whatever follows it. An exact-match rule only covered `/deployer-hunter/{wallet}`
 * itself, so the day someone added a sub-resource call the raw address would have been written into
 * the record verbatim. The ToS 5a(d) containment must not depend on nobody adding one.
 *
 * @param {string} path Path as issued, query string included.
 * @returns {string}
 */
export function endpointOf(path) {
  const bare = path.split('?')[0] ?? path;
  if (Object.prototype.hasOwnProperty.call(ENDPOINT_ROLES, bare)) return bare;
  const segments = bare.split('/');
  if (segments[1] === 'deployer-hunter' && (segments[2] ?? '') !== '') {
    segments[2] = '{wallet}';
    return segments.join('/');
  }
  return bare;
}

const DEFAULT_MIN_INTERVAL_MS = 6_500;
const DEFAULT_TIMEOUT_MS = 30_000;

/** @param {number} ms */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A serialised, ceiling-bounded, paced JSON client for exactly one vendor.
 */
export class BoundedClient {
  /** @param {ClientOptions} options */
  constructor(options) {
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new TypeError('maxRequests must be a positive integer');
    }
    /** @type {string} @readonly */
    this.#key = options.key;
    /** @type {number} */
    this.#ceiling = options.maxRequests;
    /** @type {number} */
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    /** @type {number} */
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /** @type {number} */
    this.#maxRetries = options.maxRetriesPerRequest ?? 1;
    /** @type {((path: string, attempt: number) => void) | undefined} */
    this.#onRequest = options.onRequest;
    /** @type {typeof fetch} */
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    /** @type {(ms: number) => Promise<void>} */
    this.#sleep = options.sleepImpl ?? realSleep;
    /** @type {number} */
    this.#startedAt = Date.now();
  }

  /** @type {string} */ #key;
  /** @type {number} */ #ceiling;
  /** @type {number} */ #minIntervalMs;
  /** @type {number} */ #timeoutMs;
  /** @type {number} */ #maxRetries;
  /** @type {((path: string, attempt: number) => void) | undefined} */ #onRequest;
  /** @type {typeof fetch} */ #fetch;
  /** @type {(ms: number) => Promise<void>} */ #sleep;
  /** @type {number} */ #startedAt;

  /** Requests issued so far, retries and failures included. @type {number} */
  #issued = 0;
  /** Timestamp of the last request start, for pacing. @type {number} */
  #lastStartedAt = 0;
  /** Tail of the serialisation chain — guarantees one request in flight. @type {Promise<unknown>} */
  #queue = Promise.resolve();
  /** @type {number} */ #finishedAt = 0;

  /** Issued requests per endpoint template, in first-call order. @type {Map<string, number>} */
  #byEndpoint = new Map();

  /** @returns {RequestStats} */
  stats() {
    return {
      issued: this.#issued,
      ceiling: this.#ceiling,
      elapsedMs: (this.#finishedAt || Date.now()) - this.#startedAt,
      byEndpoint: [...this.#byEndpoint].map(([endpoint, calls]) => ({
        endpoint,
        role: ENDPOINT_ROLES[endpoint]?.role ?? 'unclassified — this endpoint is not in ENDPOINT_ROLES',
        costModel: ENDPOINT_ROLES[endpoint]?.costModel ?? '1 per call',
        calls,
      })),
    };
  }

  /** Requests still available under the ceiling. @returns {number} */
  remaining() {
    return Math.max(0, this.#ceiling - this.#issued);
  }

  /**
   * GET a JSON document from a path relative to {@link BASE_URL}.
   *
   * Serialised against every other call on this client, paced, ceiling-checked, and stripped
   * of any credential on every error path.
   *
   * @param {string} path  e.g. `/deployer-hunter/leaderboard`
   * @param {Record<string, string | number | boolean>} [query]
   * @returns {Promise<unknown>}
   */
  async getJson(path, query) {
    const label = buildPath(path, query);
    // Chain onto the tail so exactly one request is ever in flight, and so a rejection does
    // not poison the queue for later callers.
    const run = this.#queue.then(
      () => this.#execute(path, query, label),
      () => this.#execute(path, query, label),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * @param {string} path
   * @param {Record<string, string | number | boolean> | undefined} query
   * @param {string} label
   * @returns {Promise<unknown>}
   */
  async #execute(path, query, label) {
    let lastTransportError = null;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      // The ceiling is checked immediately before each attempt, so a retry cannot smuggle a
      // request past it.
      if (this.#issued >= this.#ceiling) {
        throw new CeilingReached(this.#ceiling, label);
      }

      const wait = this.#minIntervalMs - (Date.now() - this.#lastStartedAt);
      if (this.#lastStartedAt !== 0 && wait > 0) await this.#sleep(wait);

      this.#issued += 1;
      const endpoint = endpointOf(label);
      this.#byEndpoint.set(endpoint, (this.#byEndpoint.get(endpoint) ?? 0) + 1);
      this.#lastStartedAt = Date.now();
      this.#onRequest?.(label, attempt);

      let response;
      try {
        response = await this.#fetch(`${BASE_URL}${label}`, {
          method: 'GET',
          headers: {
            // The only place the key is ever interpolated.
            authorization: `Bearer ${this.#key}`,
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        // Transport failure: no status, so it cannot be an auth problem. Retry if allowed.
        lastTransportError = new Error(
          `Transport failure on ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        this.#finishedAt = Date.now();
        continue;
      }

      this.#finishedAt = Date.now();

      if (!response.ok) {
        const excerpt = await excerptBody(response);
        const failure = classifyAuthFailure(response.status, excerpt);
        // 401/403/429/400 are terminal — retrying a rejected key or an exhausted quota just
        // spends more of a shared allowance to learn the same thing.
        if (failure) throw new VendorRefused(failure, response.status);

        if (response.status >= 500 && attempt < this.#maxRetries) {
          lastTransportError = new Error(`HTTP ${response.status} on ${label}: ${excerpt}`);
          continue;
        }
        throw new Error(`HTTP ${response.status} on ${label}: ${excerpt}`);
      }

      try {
        return await response.json();
      } catch (cause) {
        throw new Error(
          `Response to ${label} was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }

    throw lastTransportError ?? new Error(`Request to ${label} failed with no diagnosis`);
  }
}

// --- Dune ------------------------------------------------------------------------------------

/**
 * Thrown when Dune refuses the key, the plan or the request shape. Terminal for the Dune leg: the
 * caller falls back to the Solana RPC creation walk rather than retrying.
 *
 * Its own type rather than a reused {@link VendorRefused} because the two vendors' failure shapes do
 * not line up — `classifyAuthFailure` speaks of 30-day Free-tier expiry and a ~200/day request
 * allowance, neither of which is true of Dune — and a message naming the wrong vendor's remedy sends
 * an operator to rotate a key that is working.
 */
export class DuneRefused extends Error {
  /**
   * @param {string} message
   * @param {{ status: number | null, terminal: boolean }} what `terminal` is whether this refusal
   *   means the whole Dune leg is unusable for this run, as opposed to one call going wrong.
   */
  constructor(message, what) {
    super(message);
    this.name = 'DuneRefused';
    /** @type {number | null} */ this.status = what.status;
    /** @type {boolean} */ this.terminal = what.terminal;
  }
}

/**
 * @typedef {object} DuneClientOptions
 * @property {string} key                Held in this closure and nowhere else.
 * @property {number} maxExecutions      Hard ceiling on **executions**, the billed unit that cannot
 *   be taken back. See {@link DuneClient} for why this is separate from the request ceiling.
 * @property {number} maxRequests        Hard ceiling on requests of every kind, polling included.
 * @property {number} [minIntervalMs]    Minimum gap between request starts. Default 250.
 * @property {number} [timeoutMs]        Per-request timeout. Default 60000 — an execution POST can
 *   sit for a while before it hands back an id.
 * @property {(label: string, attempt: number) => void} [onRequest] Progress hook. Receives a path
 *   only — never a header, never the key.
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleepImpl]
 */

const DUNE_DEFAULT_MIN_INTERVAL_MS = 250;
const DUNE_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * A serialised, ceiling-bounded client for Dune's SQL API.
 *
 * It differs from {@link BoundedClient} in the one way that matters, and the difference is the whole
 * reason it is a separate class rather than a base URL parameter:
 *
 * **AN EXECUTION IS BILLED WHETHER OR NOT IT SUCCEEDS, AND IT IS TERMINAL.** So
 * {@link DuneClient.execute} is the one call in this repository that is *never* retried, on any
 * failure, for any reason — a retried execution buys a second bill for the same answer and there is
 * no failure mode where that is the right move. Reads ({@link DuneClient.getJson}) may retry: they
 * are billed by bytes returned, and a failed read returns none.
 *
 * The two ceilings are separate for the same reason. Requests bound the wall clock and the polite
 * use of a shared host; **executions bound the money**, and a poll loop that spent an execution's
 * worth of budget on status checks would be counting the wrong thing.
 *
 * Credits are estimated, never asserted: the vendor bills compute plus ~20 credits/MB of results and
 * reports the total only on a lagging, whole-credit ledger. {@link DuneClient.stats} reports what
 * this client can actually see — executions issued and result bytes read — and
 * `estimatedExportCredits` is labelled an estimate everywhere it surfaces.
 */
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
    this.#minIntervalMs = options.minIntervalMs ?? DUNE_DEFAULT_MIN_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? DUNE_DEFAULT_TIMEOUT_MS;
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

  /** Result bytes read, as the vendor's own metadata reports them. @returns {number} */
  resultBytes() {
    return this.#resultBytes;
  }

  /**
   * What this run spent, in the units this client can actually observe.
   *
   * `estimatedExportCredits` applies the Free tier's published 20 credits/MB to the result bytes the
   * vendor's own response metadata declared. It is NOT the bill: compute is billed on top, and the
   * only authoritative figure is `POST /usage`, which lags minutes and lands in whole-credit jumps.
   * It is here so a run record carries an order-of-magnitude figure rather than nothing.
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
        'The Dune execution ceiling is the run\'s spend bound and an execution is billed whether or ' +
          'not it succeeds. Raise thresholds.json dune.maxExecutionsPerRun only against a stated ' +
          'monthly arithmetic.',
      );
    }
    // Counted BEFORE the request, not after. An execution that times out on our side may well have
    // started on theirs, and a counter that only increments on success would under-report the bill.
    this.#executions += 1;
    const body = await this.#request(label, { method: 'POST', body: { query_parameters: parameters } });
    const id = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body)['execution_id'] : undefined;
    if (typeof id !== 'string' || id === '') {
      throw new DuneRefused(`Dune accepted ${label} but returned no execution id.`, { status: null, terminal: true });
    }
    return id;
  }

  /**
   * GET a JSON document from a path relative to Dune's API base. Retried once on a 5xx or a
   * transport failure — reads are billed by bytes returned, so a failed one costs nothing.
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

  /** Sleep between polls, on this client's own injected clock so tests stay free. @param {number} ms */
  async wait(ms) {
    await this.#sleep(ms);
  }

  /**
   * Record the result bytes a response declared, for the export half of the credit estimate.
   * Called by `dune.mjs` because only it knows where in a payload the vendor puts that number.
   *
   * @param {number} bytes
   */
  noteResultBytes(bytes) {
    if (Number.isFinite(bytes) && bytes > 0) this.#resultBytes += bytes;
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
          'The Dune request ceiling bounds polling and result reads. Raise thresholds.json ' +
            'dune.maxRequestsPerRun, or lower dune.pollIntervalMs so a slow execution costs fewer polls.',
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

/**
 * Turn a Dune HTTP status into a specific sentence.
 *
 * The distinction that matters is 401 versus 429 versus 402: a rejected key, a rate limit and an
 * exhausted monthly allowance all stop the Dune leg, but they call for different responses and only
 * one of them is fixed by waiting. None of them is a reason to retry an execution.
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
      `HTTP ${status} on ${path} — Dune rejected the key. Creation enumeration fell back to the ` +
      `Solana RPC walk, which needs no Dune credential and is slower rather than wrong.${tail}`
    );
  }
  if (status === 402) {
    return (
      `HTTP 402 on ${path} — the Dune plan's allowance is spent. The Free tier is 2,500 credits a ` +
      `month, SHARED with whatever else holds this key, and nothing in this tool tracks the month. ` +
      `Creation enumeration fell back to the Solana RPC walk.${tail}`
    );
  }
  if (status === 429) {
    return (
      `HTTP 429 on ${path} — rate-limited. Creation enumeration fell back to the Solana RPC walk ` +
      `for this run; a rerun costs no more than the first run did, because nothing here is cached ` +
      `between runs.${tail}`
    );
  }
  return `HTTP ${status} on ${path}.${tail}`;
}

/**
 * Build a path with a deterministic query string. Keys are emitted in sorted order so that a
 * dry-run plan and the real run produce byte-identical URLs, which is what makes `--dry-run`
 * an honest preview rather than an approximation.
 *
 * @param {string} path
 * @param {Record<string, string | number | boolean>} [query]
 * @returns {string}
 */
export function buildPath(path, query) {
  if (!query) return path;
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return path;
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return `${path}?${qs.join('&')}`;
}

/**
 * Read at most a few hundred characters of an error body, for diagnosis.
 *
 * Bounded because a vendor error page can be a megabyte of HTML, and because anything read
 * here ends up in a log line.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function excerptBody(response) {
  try {
    const text = await response.text();
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
  } catch {
    return '(body unreadable)';
  }
}
