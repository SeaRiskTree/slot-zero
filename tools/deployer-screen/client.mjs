/**
 * One of the two network-capable modules in THIS TOOL (the other is `pumpfun.mjs`) — other tools
 * under `tools/` carry their own keyless clients — and the one module anywhere in this repository
 * that holds a KEYED vendor client: MadeOnSol's {@link BoundedClient} and Dune's
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
 * Everything here is about *bounds*. The key is the captain's own; since 2026-08-05 it is **Ultra
 * and EXCLUSIVE to slot-zero** rather than Free tier and shared, which changes what the bounds are
 * FOR without removing one of them — see {@link MADEONSOL_DAILY_REQUESTS}:
 *
 * - **A hard request ceiling.** {@link BoundedClient} counts every request it issues,
 *   including failures and retries, and throws {@link CeilingReached} rather than issue the
 *   one that would cross the line. There is no flag that disables the ceiling.
 * - **One request in flight, ever.** Not a pool of one — a serialised queue, so two callers
 *   cannot race past each other. Two concurrent jobs against this vendor's keyless endpoint
 *   earned a sustained lockout once already (see CLAUDE.md); the same caution applies to the
 *   keyed one.
 * - **Paced, and the pacing was re-measured on the new tier rather than inherited.** The Free tier
 *   burst at ~10/min and the gap was 6.5 s; a ladder on Ultra shed nothing at any rung down to
 *   0 ms, so the gap is now a 250 ms courtesy floor. `thresholds.json` →
 *   `budget.justification.keyedMinIntervalMs` owns the measurement and its limits. The client
 *   sleeps the remainder itself rather than trusting the caller to.
 * - **No retries by default.** A retry is a second request against the allowance. The
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
 * The MadeOnSol daily request allowance, and the DENOMINATOR every share of it is printed against.
 *
 * **100,000/day, resetting at 00:00Z, and the key is EXCLUSIVE to slot-zero** — captain, 2026-08-05.
 * Read off the wire rather than off a pricing page: the vendor returns `x-ratelimit-limit`,
 * `x-ratelimit-remaining`, `x-ratelimit-used` and `x-ratelimit-reset` on every response, and this
 * figure is `x-ratelimit-limit` as measured that day. It was ~200/day and SHARED with whatever else
 * held the key, which is the tier every bound in this tool was originally sized against; captain
 * decision 267a re-derived those bounds and `thresholds.json` → `budget` owns the result.
 *
 * **NOTHING IN THIS REPOSITORY READS THOSE HEADERS**, which is why this is a pinned constant and not
 * a live reading. The ceilings here bound ONE RUN and the tool is stateless between runs, so N legs
 * that each fit can still exceed a day together — measured on 2026-08-05, when three legs did
 * exactly that against the old 200. At 100,000 exclusive it stopped being urgent; it did not stop
 * being true. Read the header before a multi-leg session.
 */
export const MADEONSOL_DAILY_REQUESTS = 100_000;

/**
 * The consequence and the lever for the ceiling this class was written for: the keyed run-wide
 * ceiling, which `--max-requests` sets. It is the default because that is the only ceiling this
 * module owns — every other client that throws this must say what its OWN ceiling bounds.
 *
 * The lever's caveat is no longer the daily allowance: at {@link MADEONSOL_DAILY_REQUESTS} a full
 * run is ~0.2% of a day, so what a raise actually costs is wall clock and how many strangers get
 * graded unreviewed — a graded wallet is filed and never offered again.
 */
const KEYED_RUN_CEILING_REMEDY =
  'The run stopped early and the ranking below is INCOMPLETE. Raise --max-requests if the run ' +
  'has the wall clock for it; the daily allowance is not what binds here.';

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
 * README that can drift from the code. Only `{wallet}` scales per candidate: everything else is one
 * call per tier enumerated (two by default — `seed.mjs` -> `DEFAULT_TIERS`).
 *
 * Two endpoints are deliberately absent and stay absent — `/deployer-hunter/{wallet}/tokens` is
 * bonded-only (no denominator, and it rejects `limit` above 50) and `/deployer-hunter/{wallet}/history`
 * is reachable on this lane's Ultra key but serves daily snapshots of the trailing-window aggregates
 * this tool refuses to read, so it stays absent for a design reason rather than an entitlement one.
 *
 * @type {Record<string, { role: string, costModel: string }>}
 */
export const ENDPOINT_ROLES = {
  // ONE PER TIER, not one per run: captain decision 262a made the seeding tiered by default, so
  // each of these is issued once for `good` and once for `elite` (seed.mjs -> DEFAULT_TIERS).
  // `--tier <t>` narrows the plan back to one pass each.
  '/deployer-hunter/recent-bonds': { role: 'enumeration; carries the tier filter', costModel: '1 per tier enumerated (2 by default)' },
  '/deployer-hunter/alerts': { role: 'enumeration', costModel: '1 per tier enumerated (2 by default)' },
  '/deployer-hunter/leaderboard': { role: 'enumeration', costModel: '1 per tier enumerated (2 by default)' },
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
 * not line up — `classifyAuthFailure` speaks of MadeOnSol key expiry and a MadeOnSol daily request
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
// WHAT IT GUARDS. Dune bills a SHARED monthly allowance (Free tier: 2,500 credits) in credits, and
// a FAILED execution is billed exactly like a successful one. Before this block existed, both tools
// discovered the ceiling by hitting it — an HTTP 402 partway through a multi-execution run leaves
// neither a result nor the credits to retry. The measured case that motivated it: one venue-research
// investigation spent ~350 credits, 14% of a month, in a single sitting.
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
 * The half of the allowance no reading can bound: the key is shared.
 *
 * The Free-tier allowance belongs to the ACCOUNT, not to this run, and this repository's own
 * `CLAUDE.md` records the key as shared with whatever else holds it. Another holder can spend the
 * whole remainder between our reading and our execution and nothing here would see it. The reserve
 * makes that less likely; it cannot make it impossible.
 */
export const ALLOWANCE_SHARED_CAVEAT =
  'The Dune allowance is the ACCOUNT\'s and the key is shared, so another holder can spend it between ' +
  'this reading and this run\'s first execution. A sufficient reading is evidence, never a reservation.';

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
 * @property {string} periodEnd        `YYYY-MM-DD`. **NOT a calendar month** — this account's period
 *   was measured running 2026-07-29 -> 2026-08-29, i.e. it resets on a subscription anniversary.
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
 * @typedef {object} AllowanceDecision
 * @property {'sufficient' | 'tight' | 'insufficient' | 'unreadable'} verdict
 * @property {boolean} ok                  Whether the run may spend. `tight` is a WARNING and passes.
 * @property {number} worstCaseCredits     What the plan could cost.
 * @property {number | null} creditsUsed
 * @property {number | null} creditsIncluded
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
 * @param {object} input
 * @param {DuneSpendPlan} input.plan
 * @param {DuneSpendEstimate} input.estimate
 * @param {DuneAllowance | null} input.allowance
 * @param {readonly string[]} [input.unreadableReasons] Why there is no allowance, when there is none.
 * @param {number} input.reserveCredits
 * @param {number} input.tightMultiple    How many worst cases must fit before a run is not "tight".
 * @param {boolean} input.allowanceRequired
 * @returns {AllowanceDecision}
 */
export function decideAllowance(input) {
  const reserve = Math.max(0, input.reserveCredits);
  const worst = input.estimate.worstCaseCredits;
  const caveats = [ALLOWANCE_LAG_CAVEAT, ALLOWANCE_SHARED_CAVEAT];

  if (!Number.isFinite(worst) || !Number.isFinite(reserve)) {
    const broken = !Number.isFinite(worst)
      ? `the plan's worst case priced to ${String(worst)}`
      : `the reserve priced to ${String(input.reserveCredits)}`;
    return {
      verdict: 'unreadable',
      ok: false,
      worstCaseCredits: worst,
      creditsUsed: null,
      creditsIncluded: null,
      creditsRemaining: null,
      reserveCredits: reserve,
      spendableCredits: null,
      shortfallCredits: null,
      periodStart: null,
      periodEnd: null,
      readAtUtc: null,
      reasons: [
        `REFUSED before spending anything: ${broken}, not a finite number of credits, so ` +
          `${input.plan.lane} cannot say what this run could cost and no comparison against the ` +
          `balance would mean anything. A pinned bound is missing or non-numeric.`,
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
        ...why,
      ],
      caveats,
    };
  }

  const remaining = input.allowance.creditsRemaining;
  const spendable = Math.max(0, round3(remaining - reserve));
  const shortfall = spendable >= worst ? 0 : round3(worst - spendable);
  const period = `${input.allowance.periodStart} -> ${input.allowance.periodEnd}`;
  const balance =
    `${input.allowance.creditsUsed} of ${input.allowance.creditsIncluded} credit(s) used in the billing ` +
    `period ${period}; ${remaining} remain, ${spendable} spendable after the ${reserve}-credit reserve.`;

  if (spendable < worst) {
    return {
      verdict: 'insufficient',
      ok: false,
      worstCaseCredits: worst,
      creditsUsed: input.allowance.creditsUsed,
      creditsIncluded: input.allowance.creditsIncluded,
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
        `An execution is billed whether or not it succeeds, so a run that starts and cannot finish ` +
          `leaves neither a result nor the credits to retry. The period rolls on ${input.allowance.periodEnd}.`,
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
    creditsIncluded: input.allowance.creditsIncluded,
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
        ]
      : [balance],
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
