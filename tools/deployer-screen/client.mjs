/**
 * The only network-capable module in this repository.
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

import { classifyAuthFailure } from './credential.mjs';

/** Production base URL, from `servers[0].url` of their OpenAPI document. */
export const BASE_URL = 'https://madeonsol.com/api/v1';

/** Thrown when a request would exceed the run's ceiling. Carries no credential. */
export class CeilingReached extends Error {
  /**
   * @param {number} ceiling
   * @param {string} attemptedPath
   */
  constructor(ceiling, attemptedPath) {
    super(
      `Request ceiling of ${ceiling} reached; refusing to issue ${attemptedPath}. ` +
        `The run stopped early and the ranking below is INCOMPLETE. Raise --max-requests only ` +
        `if the shared daily allowance can afford it.`,
    );
    this.name = 'CeilingReached';
    /** @type {number} */ this.ceiling = ceiling;
    /** @type {string} */ this.attemptedPath = attemptedPath;
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
 * @param {string} path Path as issued, query string included.
 * @returns {string}
 */
export function endpointOf(path) {
  const bare = path.split('?')[0] ?? path;
  const literal = Object.prototype.hasOwnProperty.call(ENDPOINT_ROLES, bare);
  if (literal) return bare;
  return /^\/deployer-hunter\/[^/]+$/.test(bare) ? '/deployer-hunter/{wallet}' : bare;
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
