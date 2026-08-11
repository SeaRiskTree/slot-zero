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

/**
 * Pacing floor for a construction that specifies none — **a fallback no caller uses, and it is
 * deliberately NOT the live pin.**
 *
 * `thresholds.json` → `budget.keyedMinIntervalMs` owns the pacing a run actually uses (250 ms since
 * captain decision 267a, re-measured on the Ultra key), and all three production constructions —
 * `screen.mjs`, `feed.mjs`, `grade.mjs` — pass it explicitly, so nothing is paced by this constant
 * today. The two are not rivals: the pin owns runs, this owns an argument-less construction.
 *
 * 6,500 ms is the superseded Free-tier burst-limit figure, kept because an unspecified default must
 * fail in the SLOW direction — a caller that forgets gets a needlessly slow client rather than one
 * outrunning a limiter nobody has measured for it. That asymmetry, not the tier, is the reason for
 * the number, and it is why this sits 26× above {@link DUNE_DEFAULT_MIN_INTERVAL_MS} below.
 */
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
 * **AND AN EXECUTION LEFT RUNNING IS AN EXECUTION STILL BILLING** (captain decision 381). Dune bills
 * compute by engine time, so abandoning one stops the watching and not the meter — measured at
 * 180.002 credits for a statement left running to the vendor's 30-minute limit and returning nothing.
 * {@link DuneClient.cancelExecution} is what every abandonment path calls first, and it is the one
 * request the request ceiling may not refuse.
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

  /**
   * **STOP AN EXECUTION WE ARE NO LONGER WILLING TO PAY FOR.**
   *
   * Dune bills execution compute by engine time consumed, so walking away from a running execution
   * does not stop the meter — it only stops us watching it. That is the shape that was measured on
   * 2026-08-08: a statement that compiled, ran to the engine's 30-minute limit and billed 180.002
   * credits for zero rows. Every abandonment path in this repository issues this call first.
   *
   * **NEVER RETRIED, and its failure never masks the abandonment.** A cancel that does not land
   * leaves the execution running; there is nothing better to do about that than say so, and a retry
   * loop on the way out of a run that is already going wrong buys nothing. The caller reports
   * `cancelAcknowledged: false` and the vendor's own words with it.
   *
   * **IT IS THE ONE REQUEST THE REQUEST CEILING MAY NOT REFUSE.** The ceiling exists to bound spend;
   * a ceiling that blocked the cancel would convert a bounded bill into an unbounded one at exactly
   * the moment the bound is needed — the abandonment usually happens because the poll budget ran out,
   * i.e. with the ceiling at or near its limit. It still COUNTS as issued, so `stats().requests` may
   * exceed `maxRequests` by the number of cancels a run had to send, and each lane's
   * `maxRequestsPerRun` justification says so rather than the counter quietly lying.
   *
   * @param {string} executionId
   * @returns {Promise<unknown>}
   */
  async cancelExecution(executionId) {
    const path = `/execution/${executionId}/cancel`;
    const run = this.#queue.then(
      () => this.#request(path, { method: 'POST', body: {}, exemptFromCeiling: true }),
      () => this.#request(path, { method: 'POST', body: {}, exemptFromCeiling: true }),
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
   * @param {{ method: 'GET' | 'POST', body?: unknown, retries?: number,
   *   exemptFromCeiling?: boolean }} opts `exemptFromCeiling` is the cancel, and only the cancel:
   *   see {@link DuneClient.cancelExecution} for why a spend ceiling must not be able to stop the
   *   one request that stops a spend.
   * @returns {Promise<unknown>}
   */
  async #request(path, opts) {
    const retries = opts.retries ?? 0;
    let lastTransportError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (opts.exemptFromCeiling !== true && this.#issued >= this.#ceiling) {
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
      `HTTP 402 on ${path} — the Dune plan's allowance is spent. The key is UNSHARED, so this is ` +
      `this fleet's own spend, and nothing in this tool tracks the month between runs. ` +
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
//
// **AND A PRE-FLIGHT CHECK CANNOT BOUND WHAT AN EXECUTION ACTUALLY COSTS — captain decision 381,
// 2026-08-08.** This guard refuses a plan whose PINNED worst case does not fit; the spend happens
// after it passes, and Dune caps a single execution's cost nowhere. So the protection was only ever
// as good as the pin, and the pin was a guess: a lane running behind this exact code path, with the
// live counter re-read before every execution, printed `verdict: sufficient` against a pinned worst
// case of 6 credits and was billed 180.002 for an execution that returned nothing. The two halves of
// the answer both live here. {@link MEASURED_TIMEOUT_FLOOR_CREDITS} is what the vendor's own
// 30-minute engine limit costs, and it is the floor every per-execution pin must now sit at or above
// so the ARITHMETIC is honest. {@link executionDeadlineCredits} prices the client-side deadline that
// bounds a single execution, and {@link DuneExecutionAbandoned} is the distinct outcome that says we
// stopped it rather than that it broke — because a guard that cannot cap a spend can only ever
// refuse a plan, and refusing plans is not the same as bounding money.

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
 * Dune's own wall-clock limit on ONE execution, in milliseconds.
 *
 * It is the vendor's number, not a bound of ours: an execution the engine has not finished by then is
 * killed and reported `QUERY_STATE_FAILED`. Nothing here can raise it and nothing here needs to —
 * what matters is that it is the LONGEST an execution can run, and therefore the MOST one can cost.
 */
export const ENGINE_TIMEOUT_MS = 1_800_000;

/**
 * What reaching {@link ENGINE_TIMEOUT_MS} COSTS, and it is the number this repository was most wrong
 * about.
 *
 * **MEASURED 2026-08-08.** A scout lane ran an `information_schema.columns` probe that compiled, ran,
 * and was killed by the engine at the 30-minute limit. It returned no rows, produced no result and
 * ended `QUERY_STATE_FAILED` — and it billed **180.002 credits**, read off the free `POST /usage`
 * counter either side with no other execution in flight (219.825 -> 399.827) and re-read after
 * settling. `slot-zero-venue-gradeability-inventory` -> `report.md` section 0 (held in firstmate's
 * records, not in this repo) owns the reading and the ledger it came out of.
 *
 * **"A FAILED EXECUTION IS FREE" IS TRUE ONLY OF A STATEMENT THAT FAILS TO COMPILE, and this
 * repository said otherwise for months.** Dune bills execution compute by engine time consumed. A
 * statement the planner rejects consumes none and costs nothing, which is what made the free-probe
 * premise look right for as long as every probe anyone wrote was malformed. A statement the planner
 * ACCEPTS and cannot finish consumes the whole limit and is billed for the whole limit. Both come
 * back as "failed", and only the first is free — so iterate on COMPILE errors, which return in
 * seconds, and treat a failure that takes minutes to arrive as the most expensive thing on the
 * account: maximum compute for zero rows.
 *
 * It is `n = 1`, on whatever engine that query ran on, and Dune publishes no price table — which is
 * why the pins derived from it carry a margin rather than sitting on it.
 */
export const MEASURED_TIMEOUT_FLOOR_CREDITS = 180.002;

/**
 * Execution compute per engine-MINUTE. **DERIVED from the one reading above, and it is an inference.**
 *
 * 180.002 credits over 30 minutes is 6.0001 credits a minute. Dune publishes no rate, so this says
 * only that ONE runaway execution priced out at that figure; it is not established that compute is
 * linear in engine time, nor that a larger engine bills the same. It exists because a client-side
 * deadline is worth nothing to an operator who cannot price it, and pro-rating the one measurement is
 * the only pricing available.
 */
export const CREDITS_PER_ENGINE_MINUTE = MEASURED_TIMEOUT_FLOOR_CREDITS / (ENGINE_TIMEOUT_MS / 60_000);

/**
 * What an execution left to run to `deadlineMs` can cost, in whole credits, rounded UP.
 *
 * Whole credits because the vendor's counter advances in whole-credit jumps, so sub-credit precision
 * on a worst case is precision the account cannot resolve. Capped at {@link ENGINE_TIMEOUT_MS},
 * because a deadline past the vendor's own limit buys nothing — the engine stops first.
 *
 * **AT THE ENGINE LIMIT IT RETURNS 181, WHICH IS THE FLOOR EVERY PER-EXECUTION PIN IN THIS
 * REPOSITORY MUST SIT AT OR ABOVE.** A pin below it is the defect this function was written for: a
 * guard that clears a plan at 25 credits and is then billed 180 does not bound the month it exists to
 * bound.
 *
 * @param {number} deadlineMs How long an execution may run before this client cancels it.
 * @returns {number} Worst-case execution-compute credits for one such execution.
 */
export function executionDeadlineCredits(deadlineMs) {
  const bounded = Math.min(Math.max(0, deadlineMs), ENGINE_TIMEOUT_MS);
  return Math.ceil((bounded / 60_000) * CREDITS_PER_ENGINE_MINUTE);
}

/**
 * What a deadline does and does NOT buy, stated because the difference is a spend decision.
 *
 * A pre-flight allowance check cannot bound an execution's cost: the spend happens AFTER the check
 * passes, and the only thing that bounds it is how long the engine is left running. So the deadline
 * is the mechanism, and the allowance check is the budget.
 *
 * **WHAT IT REMOVES FOR CERTAIN** is the shape that was measured: an execution abandoned by our own
 * poll budget and left running to the engine's own limit, billed in full for a result nobody read.
 * Every abandonment path in this repository now issues the cancel.
 *
 * **WHAT IT DOES NOT ESTABLISH** is that cancelling stops the BILL. Dune documents
 * `POST /execution/{id}/cancel` as cancelling an execution and publishes nothing about how a
 * cancelled one is billed, and settling it costs a deliberately-runaway execution — which is not a
 * purchase this lane made. So the deadline is claimed as a bound on the WAIT, and as a bound on the
 * bill only conditionally; the pinned per-execution worst case stays at the engine floor, where it
 * is honest under either answer.
 */
export const EXECUTION_DEADLINE_CAVEAT =
  'A client-side deadline bounds the WAIT for certain and the BILL only if Dune stops the engine on ' +
  'cancel, which the vendor does not document and this repository has not bought the runaway ' +
  'execution it would take to settle. What it removes for certain is walking away from a live ' +
  'execution and being billed the full 30-minute engine limit for a result nobody read.';

/**
 * One wording for the deadline and its price, so a plan, a run record and a refusal all say it the
 * same way.
 *
 * @param {number} deadlineMs
 * @returns {string}
 */
export function describeExecutionDeadline(deadlineMs) {
  const seconds = Math.round(deadlineMs / 1000);
  return (
    `${seconds}s execution deadline (worth at most ${executionDeadlineCredits(deadlineMs)} credit(s) of ` +
    `compute at the measured ${MEASURED_TIMEOUT_FLOOR_CREDITS} credits per ${ENGINE_TIMEOUT_MS / 60_000}-minute ` +
    `engine timeout), after which this client cancels rather than waits`
  );
}

/**
 * **WE STOPPED THIS EXECUTION — as distinct from it breaking.** A separate outcome on purpose.
 *
 * An operator reading a run has to be able to tell a statement that failed from a statement we
 * refused to keep paying for, because the two call for opposite responses: the first is a bug in the
 * SQL or the vendor, the second is a statement that has outgrown its deadline and either needs a
 * wider one or needs rewriting. Folding them together is how the 180-credit incident stayed
 * invisible — the poll budget gave up, the run reported a generic Dune failure, and nothing said the
 * engine was still running on our money.
 *
 * It extends the file's own `DuneRefused` deliberately, and is `terminal`: every existing catch site
 * keeps working and keeps falling back, while a site that wants to tell the two apart tests for this
 * type or reads `name`. The cancel's own outcome travels on it rather than being swallowed —
 * `cancelAcknowledged: false` means the cancel was issued and the vendor did not confirm it, which
 * is the case where the engine may still be running and the bill may still be growing.
 */
export class DuneExecutionAbandoned extends DuneRefused {
  /**
   * @param {{ executionId: string, reason: 'deadline' | 'poll-budget', elapsedMs: number,
   *   deadlineMs: number, cancelAcknowledged: boolean, cancelNote: string | null, detail: string }} what
   */
  constructor(what) {
    const why =
      what.reason === 'deadline'
        ? `the ${Math.round(what.deadlineMs / 1000)}s execution deadline expired`
        : 'the poll budget ran out first, which is the same event in the other unit';
    // A cancel that did not land means the execution may STILL be running and the bill may still be
    // growing. That is worse news than the abandonment, so the vendor's own words travel with it.
    const cancelled = what.cancelAcknowledged
      ? 'was acknowledged'
      : `was NOT acknowledged${what.cancelNote === null ? '' : `: ${what.cancelNote}`}`;
    super(
      `ABANDONED BY US, not failed by Dune: execution ${what.executionId} was still running after ` +
        `${Math.round(what.elapsedMs / 1000)}s and this client cancelled it rather than wait — ${why}. ` +
        `${what.detail} Cancel ${cancelled}. ${EXECUTION_DEADLINE_CAVEAT}`,
      { status: null, terminal: true },
    );
    this.name = 'DuneExecutionAbandoned';
    /** @type {string} */ this.executionId = what.executionId;
    /** @type {'deadline' | 'poll-budget'} */ this.reason = what.reason;
    /** @type {number} */ this.elapsedMs = what.elapsedMs;
    /** @type {number} */ this.deadlineMs = what.deadlineMs;
    /** @type {boolean} */ this.cancelAcknowledged = what.cancelAcknowledged;
    /** @type {string | null} */ this.cancelNote = what.cancelNote;
    /** @type {number} */ this.worstCaseCredits = executionDeadlineCredits(what.deadlineMs);
  }
}

/**
 * Cancel a running execution, then refuse with {@link DuneExecutionAbandoned}.
 *
 * **This is the one place an abandonment happens, and it is in the shared region on purpose.** Both
 * keyed tools carry their own `executeAndRead` — the directory boundary forbids importing across it
 * — and two copies of "give up on a running execution" is exactly the thing that must not drift,
 * because the difference between the two would be silent and would be money. The loops decide WHEN;
 * this decides what giving up MEANS, identically.
 *
 * **The cancel's own failure is caught and reported, never thrown.** A cancel that does not land
 * leaves the execution running and possibly still billing, which is worse news than the abandonment
 * itself — so it travels on the refusal rather than replacing it. Throwing the cancel's error would
 * lose the deadline, the elapsed time and the execution id in one go.
 *
 * @param {{ cancelExecution: (executionId: string) => Promise<unknown> }} client
 * @param {{ executionId: string, reason: 'deadline' | 'poll-budget', elapsedMs: number,
 *   deadlineMs: number, detail: string }} what
 * @returns {Promise<never>}
 */
export async function abandonExecution(client, what) {
  const cancelled = await cancelExecutionQuietly(client, what.executionId);
  throw new DuneExecutionAbandoned({
    ...what,
    cancelAcknowledged: cancelled.acknowledged,
    cancelNote: cancelled.note,
  });
}

/**
 * Cancel a running execution and say how it went, without ever throwing.
 *
 * **THE CANCEL IS FOR EVERY WAY OF LEAVING A LIVE EXECUTION, not just the deadline.** A request
 * ceiling reached mid-poll, a transport failure, a result read this repository refuses — each of
 * them walks away from an execution the engine is still running, and each of them used to leave it
 * running to Dune's own 30-minute limit. So the poll loops call this on their way out and rethrow
 * whatever they were already carrying: a `CeilingReached` still reads as a ceiling and keeps its
 * remedy, and the cancel happens anyway. It is separate from {@link abandonExecution} for exactly
 * that reason — one path REPLACES the error because stopping IS the outcome, the other must not.
 *
 * It cannot throw, because a failing cancel must never become the reported failure of a run that had
 * a real one already.
 *
 * @param {{ cancelExecution: (executionId: string) => Promise<unknown> }} client
 * @param {string} executionId
 * @returns {Promise<{ acknowledged: boolean, note: string | null }>}
 */
export async function cancelExecutionQuietly(client, executionId) {
  try {
    await client.cancelExecution(executionId);
    return { acknowledged: true, note: null };
  } catch (cause) {
    return { acknowledged: false, note: cause instanceof Error ? cause.message : String(cause) };
  }
}

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
 * Render the operator's configured cap for a PLAN, or say — in the live path's own words — why it
 * cannot be rendered.
 *
 * **A PLAN THAT CANNOT READ THE CAP MUST SAY SO IN THE SAME TERMS A RUN WOULD REFUSE IN.** Every
 * other surface of captain decision 322a answers a missing or non-numeric pin with a NAMED refusal
 * pointing at {@link MONTHLY_CAP_PIN}; the two plan printers reached that same operator state and
 * answered with a bare `TypeError` (`undefined.toLocaleString`) and with the literal text
 * `operator cap undefined`. Both are the failure the naming requirement exists to prevent, on the
 * one config surface 322a introduces — an operator who has just edited the cap and typoed it is
 * exactly who is reading a dry run.
 *
 * It is deliberately in the shared region rather than written once per lane: the two plan printers
 * live on opposite sides of the directory boundary and neither may import the other, so one wording
 * across both is a duplicated text pinned by a test — the same remedy the rest of this block uses.
 *
 * **It renders, it never decides.** No verdict, bound or value depends on it, and a plan printer has
 * no credential and no balance; {@link decideAllowance} remains the only thing that refuses, and it
 * refuses on the identical condition this reports.
 *
 * @param {unknown} monthlyCapCredits The pin as the lane's own bounds file holds it, uncoerced.
 * @returns {string} The cap phrase, units included, or the named-refusal phrase.
 */
export function describeMonthlyCapCredits(monthlyCapCredits) {
  const usable =
    typeof monthlyCapCredits === 'number' && Number.isFinite(monthlyCapCredits) && monthlyCapCredits > 0;
  return usable
    ? `${monthlyCapCredits.toLocaleString('en-US')} credits/month`
    : `UNREADABLE — the cap is missing or non-numeric at ${MONTHLY_CAP_PIN}, so a live run REFUSES ` +
      `before spending anything rather than falling back to the vendor's figure`;
}

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
 * @property {number} creditsIncluded  The period's allowance AS THE VENDOR REPORTED IT — 2,500 on
 *   the Free tier. `AllowanceDecision.creditsIncluded` is a DIFFERENT quantity under the same name:
 *   the EFFECTIVE ceiling, the smaller of this and the operator's cap (captain decision 322a).
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

/**
 * **A LANE'S CEILING IS A REFUSAL AGAINST A WORST CASE, NEVER A PROJECTION FROM WHAT THE LAST
 * EXECUTION COST — and this repository has now overrun three times believing otherwise.**
 *
 * The three readings, all from lanes held to a hard credit stop written in a brief:
 *
 * 1. A 40-credit stop, 70.467 spent — 76% over. One execution of four cost 46.6 credits for a
 *    SINGLE DAY of data, because cost is dominated by wide repeated array columns rather than by
 *    date range or result size.
 * 2. A 50-credit stop, 50.334 spent. Small in absolute terms and by far the more instructive: two
 *    batches were IDENTICAL IN SHAPE — same generator, same 350 launches, same two-month
 *    `block_month` list, 138.4 KB of SQL each. One cost 14.226 and the next cost 20.028, 41% more
 *    for 25 more result rows. The lane had sized the second from the first's MEASURED cost and
 *    projected ~44 of 50.
 * 3. The settled account counter exceeded the summed `execution_cost_credits` by 8.000 credits over
 *    1.085 MB of result reads.
 *
 * Reading 2 is the one that decides this design. **A pre-flight estimate taken from a measured,
 * identically-shaped prior batch was still not a bound**, so no measured cost may ever narrow the
 * next execution's worst case. {@link openDuneLaneBudget} therefore floors every per-execution price
 * at the ENGINE FLOOR — `executionDeadlineCredits(ENGINE_TIMEOUT_MS)`, 181 credits, what the vendor's
 * own 30-minute limit can bill — and a caller handing in a smaller figure gets that floor rather than
 * its own number.
 *
 * **The floor is the engine's and not the lane's deadline, because the failure class here is A
 * PER-LANE NUMBER CHOSEN TOO LOW and there are three recorded instances of it. The knob is REMOVED
 * rather than re-tuned**: a lane may still pin HIGHER, and a sub-181 lane stop being unrepresentable
 * under this guard is the intended message rather than a regression — evidence 1 measured a SINGLE
 * execution at 46.6 credits, so a 40- or 50-credit stop was never a stop. A deadline bounds the WAIT
 * for certain and the BILL only if Dune stops the engine on cancel, which is undocumented (see
 * {@link EXECUTION_DEADLINE_CAVEAT}), so pricing a lane's worst case off it assumes the unsettled
 * answer in the expensive direction's favour.
 */
export const LANE_CEILING_IS_NOT_A_PROJECTION =
  'A lane ceiling is enforced against a WORST CASE and never against a projection from a prior ' +
  'execution. Two Dune executions identical in shape — same generator, same 350 launches, same ' +
  'two-month block list, 138.4 KB of SQL each — cost 14.226 and 20.028 credits, 41% apart for 25 ' +
  'more result rows, and the lane that sized the second from the first still overran its stop. Per ' +
  'this budget, no measured cost may lower the next execution\'s bound.';

/**
 * **THE COUNTER DELTA BINDS; `execution_cost_credits` IS A FLOOR UNDER IT AND NEVER THE CEILING'S
 * BASIS.**
 *
 * The account counter is what the operator is billed against and the only quantity that closes the
 * month. Attributable execution cost under-reads it in two independent ways: retrieval is ~71% of
 * the bill and is not in that field at all, and the settled counter was measured 8.000 credits above
 * the summed attributed cost over 1.085 MB of reads even after retrieval was allowed for.
 *
 * But the counter also LAGS (see {@link ALLOWANCE_LAG_CAVEAT}) — it lands in whole-credit jumps and
 * was measured rising while the account was idle — so immediately after an execution the delta can
 * still read ZERO for spend that has certainly happened. A budget that trusted only the counter
 * would authorise the whole lane inside one lag window.
 *
 * So this budget holds BOTH and enforces against `max()` of them: the counter delta, and the local
 * half — which is a WORST-CASE RESERVATION, the sum of what each authorised execution was CLEARED
 * at, and NOT a figure built from executions issued and bytes measured. Each covers the other's
 * blind spot and the larger is the honest reading at any instant. Which one bound is reported rather
 * than hidden, because they answer different questions about the same run.
 *
 * **The local half depends on {@link EXPORT_CREDITS_PER_MB} MORE than a measured one would**, the
 * retrieval term being reserved at authorisation rather than read back afterwards. Two readings now
 * put that rate at ~7.4 and ~4.9 credits/MB against the pinned 20 — both in the CHEAP direction,
 * which is the unsafe one to assume persists. That pin is captain decision 248c's and is
 * deliberately not touched here; this budget uses it at its EXPENSIVE published value, so a cheaper
 * real rate makes the reservation over-read, which refuses early rather than late. The counter delta
 * is unaffected by any of it.
 */
export const LANE_SPEND_IS_TWO_QUANTITIES =
  'The ACCOUNT COUNTER DELTA is what this ceiling is enforced against — it is what the month is ' +
  'billed on. Summed `execution_cost_credits` under-reads it (retrieval is ~71% of the bill and is ' +
  'not in that field; the settled counter was measured 8.000 credits above the attributed sum over ' +
  '1.085 MB of reads), and the counter itself LAGS in whole-credit jumps so it under-reads just ' +
  'after an execution. So it is held against a local WORST-CASE RESERVATION — the sum of what each ' +
  'authorised execution was CLEARED at, compute and retrieval together, never a measured figure — ' +
  'and the LARGER of the two binds at every check.';

/**
 * **THIS LANE HAS SPENT ITS CEILING — refused at the execution boundary, not warned about in a
 * brief.**
 *
 * A `DuneRefused` and `terminal`, so no retry loop can walk past it and no `catch` that already
 * falls back on a Dune refusal has to learn a new type. It carries the numbers a refusal is
 * worthless without: the ceiling, what has been spent under both readings, what was held back, and
 * what the execution it refused could have cost.
 */
export class DuneLaneCeilingReached extends DuneRefused {
  /**
   * @param {{ lane: string, ceilingCredits: number, counterDeltaCredits: number | null,
   *   localEstimateCredits: number, bindingSpendCredits: number,
   *   bindingQuantity: 'account-counter-delta' | 'local-estimate', reserveCredits: number,
   *   spendableCredits: number, worstCaseCredits: number, shortfallCredits: number,
   *   executionsAuthorised: number, refusedBy: 'lane-ceiling' | 'monthly-ceiling',
   *   detail: string[] }} what
   */
  constructor(what) {
    // WHICH CEILING REFUSED, said in the first clause. The two call for different responses — a lane
    // ceiling is raised in the lane's own brief, the monthly one is the account's and is not — and a
    // headline that always blamed the lane would report a 0-credit shortfall as the reason.
    const head =
      what.refusedBy === 'lane-ceiling'
        ? `the "${what.lane}" lane's credit ceiling of ${what.ceilingCredits} credit(s) cannot cover ` +
          `the next execution's worst case of ${what.worstCaseCredits} credit(s) — it is ` +
          `${what.shortfallCredits} credit(s) short.`
        : `the ACCOUNT's monthly ceiling refused the next execution of the "${what.lane}" lane, whose ` +
          `worst case is ${what.worstCaseCredits} credit(s). The lane's own ceiling of ` +
          `${what.ceilingCredits} credit(s) still had room; raising it would change nothing.`;
    super(
      `REFUSED at the execution boundary: ${head} ` +
        `${what.executionsAuthorised} execution(s) have been authorised so far; spend reads ` +
        `${what.bindingSpendCredits} credit(s) on the ${what.bindingQuantity} (account counter delta ` +
        `${what.counterDeltaCredits === null ? 'UNREADABLE' : what.counterDeltaCredits}, local ` +
        `estimate ${what.localEstimateCredits}), leaving ${what.spendableCredits} spendable after the ` +
        `${what.reserveCredits}-credit reserve. ` +
        `${what.detail.join(' ')} ${LANE_CEILING_IS_NOT_A_PROJECTION} ${LANE_SPEND_IS_TWO_QUANTITIES}`,
      { status: null, terminal: true },
    );
    this.name = 'DuneLaneCeilingReached';
    /** @type {'lane-ceiling' | 'monthly-ceiling'} */ this.refusedBy = what.refusedBy;
    /** @type {string} */ this.lane = what.lane;
    /** @type {number} */ this.ceilingCredits = what.ceilingCredits;
    /** @type {number | null} */ this.counterDeltaCredits = what.counterDeltaCredits;
    /** @type {number} */ this.localEstimateCredits = what.localEstimateCredits;
    /** @type {number} */ this.bindingSpendCredits = what.bindingSpendCredits;
    /** @type {'account-counter-delta' | 'local-estimate'} */ this.bindingQuantity = what.bindingQuantity;
    /** @type {number} */ this.reserveCredits = what.reserveCredits;
    /** @type {number} */ this.spendableCredits = what.spendableCredits;
    /** @type {number} */ this.worstCaseCredits = what.worstCaseCredits;
    /** @type {number} */ this.shortfallCredits = what.shortfallCredits;
    /** @type {number} */ this.executionsAuthorised = what.executionsAuthorised;
  }
}

/**
 * @typedef {object} LaneSpendReading
 * @property {number | null} counterDeltaCredits  `credits_used` now, less the baseline this budget
 *   took before its first execution. `null` when no reading has EVER been taken.
 * @property {boolean} counterReadingIsStale      The last authorisation could not read the counter
 *   while an EARLIER one had, so `counterDeltaCredits` is a previous reading and not this moment's.
 *   `null` and stale are different states and are kept apart: a lane on the `allowanceRequired:
 *   false` waiver would otherwise report a stale delta as a live binding quantity.
 * @property {number} localEstimateCredits        **A WORST-CASE RESERVATION, and no longer a
 *   measured-bytes figure.** It is the sum of what each authorised execution was CLEARED at —
 *   `estimate.worstCaseCredits`, compute AND retrieval — so authorisation and spend price the same
 *   execution the same way. Nothing the vendor later reports about what an execution cost or
 *   returned moves it.
 * @property {number} attributedExecutionCredits  Summed `execution_cost_credits` as the vendor
 *   reported it. **Reported only — it is not what the ceiling is enforced against.**
 * @property {number} resultBytes                 Result bytes the vendor's metadata declared.
 *   **Reported only, beside `attributedExecutionCredits`** — the retrieval worst case is reserved at
 *   authorisation, so measured bytes reach no enforcement arithmetic.
 * @property {number} bindingSpendCredits         `max()` of the two enforceable readings.
 * @property {'account-counter-delta' | 'local-estimate'} bindingQuantity Which one that was.
 */

/**
 * @typedef {object} DuneLaneBudget
 * @property {(client: { readUsage: () => Promise<unknown> }, input: { plan: DuneSpendPlan,
 *   nowMs: number }) => Promise<{ estimate: DuneSpendEstimate, allowance: AllowanceDecision,
 *   spend: LaneSpendReading, spendableCredits: number }>} authoriseExecution Re-read the live
 *   balance and either clear ONE execution or throw {@link DuneLaneCeilingReached}. **The `plan` it
 *   takes must describe ONE execution.** It is priced as handed in — `executions`, `resultReads` and
 *   `rowsPerRead` are the caller's — so a lane passing its whole RUN-level plan reserves the entire
 *   run's worst case on every authorisation and refuses after one. That direction is toward refusal,
 *   so it is a capacity loss and never a spend hole. `spend` and `spendableCredits` both describe the
 *   instant AFTER the cleared execution, so a lane may size its next batch from either.
 * @property {(outcome: { executionCostCredits?: number | null, resultBytes?: number | null }) => void}
 *   recordExecutionOutcome What the vendor said the execution cost and returned. **Both figures are
 *   REPORTED ONLY.** Neither reaches the enforcement arithmetic: the ceiling is enforced against the
 *   authorised worst case and the account counter delta, and nothing else.
 * @property {() => LaneSpendReading} spentSoFar The two quantities, as last read.
 * @property {() => number} executionsAuthorised
 */

/**
 * **A LANE'S CREDIT CEILING, ENFORCED AT THE EXECUTION BOUNDARY.**
 *
 * The thing this replaces is a sentence in a brief that a worker has to keep obeying while it
 * iterates, and which has now failed three times (see {@link LANE_CEILING_IS_NOT_A_PROJECTION}). It
 * is deliberately the SAME shape as the run-level guard beside it rather than a second mechanism:
 * {@link estimatePlanCredits} prices the plan, {@link decideAllowance} rules on the monthly ceiling
 * exactly as it does for the screen and the census, and this adds the one thing that guard cannot
 * express — a budget SMALLER than the month, spent down across many executions, re-checked before
 * every single one.
 *
 * Six properties — the three overruns above are why the first three exist, and the rest close
 * defects found while closing them:
 *
 * - **It re-reads live usage before EVERY execution.** A pre-flight check that runs once is exactly
 *   what the overrunning lanes had; the whole failure is that iteration happens after it.
 * - **The worst case is floored at the ENGINE FLOOR — `executionDeadlineCredits(ENGINE_TIMEOUT_MS)`,
 *   181 credits — and a caller cannot lower it.** A lane sizing the next execution from the last
 *   one's measured cost hands in a small `creditsPerExecution`; it gets the engine floor. Nothing a
 *   vendor has reported about a completed execution reaches this number, by construction. The floor
 *   is NOT derived from `executionDeadlineMs`: the failure this guard exists to close is a per-lane
 *   number chosen too low, so the knob is removed rather than re-tuned, and a lane wanting a 40- or
 *   50-credit stop cannot have one here — see {@link LANE_CEILING_IS_NOT_A_PROJECTION}. A lane that
 *   knows its statement is worse than the floor may still pin HIGHER.
 * - **What was authorised is what is spent down, WHOLE.** Each cleared execution debits
 *   `estimate.worstCaseCredits` — compute AND retrieval, the entire figure it was cleared against —
 *   so there is ONE rule and no second path. Debiting the compute term alone left the retrieval
 *   worst case unreserved and a lane clearing 423-credit executions could take 1,692 credits of
 *   authorised worst case out of a 1,000-credit ceiling, which is the same defect as a lane pricing
 *   above the floor and being charged the floor. **The consequence is accepted deliberately: a
 *   large-read lane exhausts its ceiling in FEWER executions than its real bytes justify. Refusing
 *   early is the intended direction and is not a regression to be tuned away** — retrieval was ~95%
 *   of this repository's own entry lane's bill, so an unreserved retrieval term is most of the
 *   ceiling.
 * - **THE FIGURE AN AUTHORISATION IS CLEARED AT IS HELD FROM THE MOMENT THE DECISION BEGINS**, before
 *   the balance read suspends the call, so two OVERLAPPING authorisations can never both be cleared
 *   against the same total. The hold is provisional and is released on every path that does not
 *   clear, a thrown one included. Without it the guard's "re-checked before every single one" held
 *   only for a strictly serial lane, and Dune permits parallel executions.
 * - **Spend is `max(counter delta, local estimate)`** — {@link LANE_SPEND_IS_TWO_QUANTITIES}.
 * - **It THROWS.** A returned verdict is a warning, and a warning is what a worker iterates past.
 *
 * **A reading it cannot take refuses**, on the same rule as everything else here: an unreadable
 * balance is not headroom, and a counter reading that has gone STALE says so on the reading rather
 * than passing as live. A lane may pass `allowanceRequired: false` to proceed on the local
 * reservation alone, and then that half is the only thing standing between the lane and the month.
 * **It depends MORE on {@link EXPORT_CREDITS_PER_MB} than it did**, the retrieval term now being
 * reserved rather than measured; that pin is captain decision 248c's and is deliberately used at its
 * EXPENSIVE published value here, which makes the reservation over-read and refuse early.
 *
 * @param {object} config
 * @param {string} config.lane                 Named in every refusal.
 * @param {number} config.ceilingCredits       THIS LANE's budget, in credits. Smaller than the month.
 * @param {number} config.reserveCredits       Held back against the counter's lag; never spendable.
 * @param {number} config.executionDeadlineMs  How long one execution may run before this client
 *   cancels it. **It is required and validated, and it does NOT set the per-execution worst case** —
 *   that is the engine floor above, unconditionally. It is stated because a lane that cannot say how
 *   long it lets an execution run has not bounded its wait, and silently ignoring a supplied deadline
 *   would be worse than not taking one; the budget itself makes no other use of it.
 * @param {number} config.monthlyCapCredits    The operator's fleet-wide cap, for {@link decideAllowance}.
 * @param {number} config.tightMultiple
 * @param {boolean} config.allowanceRequired
 * @returns {DuneLaneBudget}
 */
export function openDuneLaneBudget(config) {
  // A NON-FINITE CEILING CLEARS EVERY COMPARISON, WHICH IS THE GUARD INVERTED — `NaN < worst` is
  // false, so a lane whose ceiling pin was missing or misspelt would be authorised without limit
  // while reporting a budget. It is the same defect `decideAllowance` refuses a `NaN` worst case
  // for, and it is caught HERE, at construction, so a lane cannot reach its first execution holding
  // a budget that means nothing.
  for (const [name, value] of [
    ['ceilingCredits', config.ceilingCredits],
    ['reserveCredits', config.reserveCredits],
    ['executionDeadlineMs', config.executionDeadlineMs],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `the "${config.lane}" lane opened a Dune credit budget whose ${name} read as ${String(value)}, ` +
          `which is not a finite non-negative number. A ceiling that does not price cannot refuse ` +
          `anything: every comparison against it is false and the lane would spend unbounded while ` +
          `reporting a budget. Nothing was requested and nothing was billed.`,
      );
    }
  }
  // THE ENGINE FLOOR, NOT THIS LANE'S DEADLINE. `config.executionDeadlineMs` is validated above and
  // deliberately does not price anything: the failure class is a per-lane number chosen too low, so
  // the knob is removed rather than re-tuned.
  const floorPerExecution = executionDeadlineCredits(ENGINE_TIMEOUT_MS);
  /** @type {number | null} */ let baselineUsed = null;
  let executions = 0;
  let authorisedExecutionCredits = 0;
  let heldCredits = 0;
  let attributedExecutionCredits = 0;
  let resultBytes = 0;
  /** @type {number | null} */ let counterDeltaCredits = null;
  let counterReadingIsStale = false;

  /** @returns {LaneSpendReading} */
  const reading = () => {
    // The local half is a RESERVATION of what was AUTHORISED — each execution at the WHOLE worst
    // case it was cleared against, compute and retrieval together — and never a figure built from
    // what any execution was reported to have cost or returned. Reserving less than was cleared, in
    // either term, lets a lane authorise many multiples of its own ceiling inside the counter's lag
    // window. `attributedExecutionCredits` and `resultBytes` are carried beside it for an operator
    // to read and are deliberately absent from this arithmetic.
    const localEstimateCredits = round3(authorisedExecutionCredits);
    const counter = counterDeltaCredits;
    const counterBinds = counter !== null && counter > localEstimateCredits;
    return {
      counterDeltaCredits: counter,
      counterReadingIsStale,
      localEstimateCredits,
      attributedExecutionCredits: round3(attributedExecutionCredits),
      resultBytes,
      bindingSpendCredits: counterBinds ? counter : localEstimateCredits,
      bindingQuantity: counterBinds ? 'account-counter-delta' : 'local-estimate',
    };
  };

  return {
    executionsAuthorised: () => executions,
    spentSoFar: reading,
    recordExecutionOutcome(outcome) {
      const cost = outcome.executionCostCredits;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) attributedExecutionCredits += cost;
      const bytes = outcome.resultBytes;
      if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) resultBytes += bytes;
    },
    async authoriseExecution(client, input) {
      // THE PER-EXECUTION WORST CASE, AND THE FLOOR IS THE POINT. A caller that sized this from a
      // measured prior execution gets the engine floor instead of its own number; a caller pricing
      // above the floor keeps its own, because a lane may know its statement is worse than average
      // and may never claim it is better.
      const plan = {
        ...input.plan,
        executions: Math.max(1, input.plan.executions),
        creditsPerExecution: Math.max(floorPerExecution, input.plan.creditsPerExecution),
      };
      const estimate = estimatePlanCredits(plan);

      // THE FIGURE THIS AUTHORISATION IS CLEARED AT IS HELD FROM THE MOMENT THE DECISION BEGINS —
      // BEFORE the balance read suspends this call — so two overlapping authorisations can never both
      // be cleared against the same total. Without the hold, both suspend at the `await` reading a
      // pre-debit reservation, both clear, and only then does each debit: the same defect as a term
      // cleared but never reserved, reached through interleaving. The counter cannot catch it either,
      // since it reads low in exactly that window ({@link ALLOWANCE_LAG_CAVEAT}). The hold is
      // PROVISIONAL: every exit that does not clear releases it, including a thrown one, because a
      // leaked hold shrinks the lane's ceiling permanently.
      const heldByThisCall = estimate.worstCaseCredits;
      heldCredits = round3(heldCredits + heldByThisCall);
      let holdReleased = false;
      const releaseHold = () => {
        if (holdReleased) return;
        holdReleased = true;
        heldCredits = round3(heldCredits - heldByThisCall);
      };
      try {
        /** @type {UsageReading} */
        let usage;
        try {
          usage = parseUsageResponse(await client.readUsage(), input.nowMs);
        } catch (cause) {
          usage = {
            ok: false,
            allowance: null,
            reasons: [`POST /usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`],
          };
        }
        if (usage.allowance !== null) {
          // The FIRST successful reading is this lane's zero. Everything after it is a delta, which is
          // what makes a lane ceiling smaller than the month enforceable at all.
          if (baselineUsed === null) baselineUsed = usage.allowance.creditsUsed;
          counterDeltaCredits = Math.max(0, round3(usage.allowance.creditsUsed - baselineUsed));
          counterReadingIsStale = false;
        } else {
          // A READ THAT FAILED AFTER AN EARLIER ONE SUCCEEDED IS STALE, NOT NULL. The two are different
          // states and inferring staleness from `null` cannot tell them apart, so on the
          // `allowanceRequired: false` waiver the last good delta would keep reporting itself as the
          // live binding quantity with nothing saying this authorisation could not read the counter.
          counterReadingIsStale = counterDeltaCredits !== null;
        }

        // ONE MECHANISM, NOT TWO: the monthly ceiling is ruled on by the same `decideAllowance` every
        // other guarded spend path in this repository uses, on this execution's own worst case.
        const allowance = decideAllowance({
          plan,
          estimate,
          allowance: usage.allowance,
          unreadableReasons: usage.reasons,
          reserveCredits: config.reserveCredits,
          monthlyCapCredits: config.monthlyCapCredits,
          tightMultiple: config.tightMultiple,
          allowanceRequired: config.allowanceRequired,
        });

        const spend = reading();
        // What OTHER authorisations are holding right now, and never this call's own hold — which is
        // what keeps a serial lane's arithmetic byte-identical to what it was before holds existed,
        // while an overlapping one is priced against room its sibling has already taken.
        const heldElsewhere = round3(heldCredits - (holdReleased ? 0 : heldByThisCall));
        const spendable = Math.max(
          0,
          round3(
            config.ceilingCredits - spend.bindingSpendCredits - Math.max(0, config.reserveCredits) - heldElsewhere,
          ),
        );
        /** @type {string[]} */
        const detail = [];
        if (spend.counterDeltaCredits === null) {
          detail.push(
            config.allowanceRequired
              ? 'The account counter could not be read at all, so the binding quantity is unavailable ' +
                'and this lane is running on its local estimate alone — which is not headroom.'
              : 'The account counter could not be read; this lane was configured not to require it, so ' +
                'the local estimate is the only thing bounding it.',
          );
        } else if (spend.counterReadingIsStale) {
          detail.push(
            `The account counter could not be read for THIS authorisation, so the ` +
              `${spend.counterDeltaCredits}-credit delta above is a PREVIOUS reading and not this ` +
              `moment's — it is a floor under the counter and cannot have fallen since.`,
          );
        }
        if (heldElsewhere > 0) {
          detail.push(
            `${heldElsewhere} credit(s) are HELD by authorisation(s) still in flight and were subtracted ` +
              `from what this one could spend: a cleared execution is spent whether or not its sibling ` +
              `has returned yet.`,
          );
        }
        if (!allowance.ok) {
          detail.push(
            `The MONTHLY ceiling refused independently of this lane's own: ${allowance.reasons.join(' ')}`,
          );
        }

        const laneShort = spendable < estimate.worstCaseCredits;
        if (!allowance.ok || laneShort) {
          releaseHold();
          throw new DuneLaneCeilingReached({
            // THE LANE'S OWN CEILING IS REPORTED FIRST when both refuse: it is the tighter budget and
            // the one the operator can act on, and a lane over its own stop is over it whatever the
            // month has left.
            refusedBy: laneShort ? 'lane-ceiling' : 'monthly-ceiling',
            lane: config.lane,
            ceilingCredits: config.ceilingCredits,
            counterDeltaCredits: spend.counterDeltaCredits,
            localEstimateCredits: spend.localEstimateCredits,
            bindingSpendCredits: spend.bindingSpendCredits,
            bindingQuantity: spend.bindingQuantity,
            reserveCredits: Math.max(0, config.reserveCredits),
            spendableCredits: spendable,
            worstCaseCredits: estimate.worstCaseCredits,
            shortfallCredits: Math.max(0, round3(estimate.worstCaseCredits - spendable)),
            executionsAuthorised: executions,
            detail,
          });
        }

        // AUTHORISED MEANS SPENT, immediately. A cleared execution is an execution that will run, and
        // the counter will not show it for minutes — so the local half moves here rather than on the
        // way back, where a transport failure would lose it. It moves by the WHOLE figure this
        // execution was CLEARED at — retrieval included — so authorisation and spend price the same
        // execution the same way and there is no term the ceiling clears but never reserves. The
        // provisional hold becomes that permanent debit in one step, with nothing awaited between.
        releaseHold();
        executions += 1;
        authorisedExecutionCredits = round3(authorisedExecutionCredits + estimate.worstCaseCredits);
        // BOTH FIELDS DESCRIBE THE SAME INSTANT — after this execution. Returning the pre-debit
        // spendable overstates the lane's remaining room by exactly one worst case, which is the
        // planning error this guard exists to remove: a lane sizing its next batch from it plans one
        // execution too many.
        const after = reading();
        return {
          estimate,
          allowance,
          spend: after,
          spendableCredits: Math.max(
            0,
            round3(
              config.ceilingCredits - after.bindingSpendCredits - Math.max(0, config.reserveCredits) - heldCredits,
            ),
          ),
        };
      } finally {
        releaseHold();
      }
    },
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
