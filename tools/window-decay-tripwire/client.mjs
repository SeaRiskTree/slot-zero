/**
 * The one file in this tool that opens a socket.
 *
 * **Zero-token by construction.** Two hosts, both keyless, both free, listed in {@link HOSTS} and
 * nowhere else; there is no header hook, no options bag that reaches `fetch`, and no path by which
 * a credential could be attached even by accident. `test/window-decay-tripwire.test.ts` asserts
 * that no other file here calls `fetch`, that the URL of every request built by this tool starts
 * with one of those two hosts, and that nothing in this directory names an environment variable or
 * contains a key-shaped string. The allow-list is **two hosts in one file** for the same reason
 * `tools/deployer-screen/` keeps its `fetch` allow-list at two files: the ceiling stays auditable
 * by reading one thing.
 *
 * `solana-rpc.publicnode.com` is absent, as is every RPC host — this tripwire needs none. The
 * dead-host trap that stalled an earlier job for 40 minutes behind retry backoff
 * (`population-tape-2026-07-29/report.md` §9.3) cannot arise in a client that can only reach
 * hosts on a literal list.
 *
 * ## Why this duplicates `tools/graduated-life-tape/client.mjs`
 *
 * On purpose, and it is the cheaper of two costs — the same trade that module documents against
 * `tools/deployer-screen/pumpfun.mjs`. This is a *watcher* that must keep running unchanged for
 * weeks while the screen and tape lanes edit their own pacing constants and error types underneath
 * them. Do not "fix" the duplication by importing across it.
 *
 * ## Pacing and the ceiling
 *
 * The floor is 4 s between request starts with adaptive backoff, which
 * `population-tape-2026-07-29/report.md` §9.2 and the graduated-life collection measured as
 * the rung that sustains indefinitely: 6,539 requests, zero HTTP 429. This tool's whole run is
 * two orders of magnitude smaller than that, so pacing is not the binding constraint — the ceiling
 * is, and it is a hard one. Every constructor takes `maxRequests`, it is checked before every
 * attempt including retries, and reaching it throws rather than returning, so no caller can read
 * an exhausted budget as an empty answer.
 */

/** Per-token fill tape. Keyless, no account, no cost. */
export const SWAP_API = 'https://swap-api.pump.fun';

/**
 * Launch listing by creator. Keyless, and **biased**: it lists by CURRENT owner, so a launch whose
 * creator record has moved goes missing, and the one known to have gone missing was this
 * operation's best ever (`AGENTS.md`). A missing launch delays a reading — but it also makes its two
 * neighbours LOOK adjacent, which is a second-order way to manufacture a stop out of two breaches
 * that were never consecutive. `watch.mjs` → `chainsOf` corroborates every claimed adjacency
 * against the elapsed time between the two launches and breaks the chain across a gap wider than
 * any the open window on record contains, so a hole fails towards no stop.
 */
export const FRONTEND_API = 'https://frontend-api-v3.pump.fun';

/** The complete list of hosts this tool may reach. Both keyless. Asserted in the test. */
export const HOSTS = Object.freeze([SWAP_API, FRONTEND_API]);

/**
 * Floor between the *starts* of two requests, in ms. Not the observed rate — the adaptive term
 * below pushes the real interval above it whenever the endpoint sheds.
 */
export const DEFAULT_MIN_INTERVAL_MS = 4_000;

/** `growth` on every 429/5xx, `decay` after `decayAfter` clean responses, clamped to the floor and ceiling. */
export const BACKOFF = Object.freeze({ growth: 1.6, decay: 0.85, decayAfter: 5, ceilingMs: 40_000 });

/** Waits before the 2nd, 3rd and 4th attempt at a shed request, on top of the pacing interval. */
export const RETRY_BACKOFF_MS = Object.freeze([3_000, 9_000, 27_000]);

/**
 * Attempts one request can cost, worst case: the first plus one per retry rung.
 *
 * Derived from `RETRY_BACKOFF_MS` rather than written down beside it, because the pinned per-run
 * ceiling is the exact product of this number and the request bounds. A rung added to the ladder
 * with this left at a literal would raise the real worst case while every plan kept reporting the
 * old one, which is the one way this tool's ceiling could become nominal.
 */
export const ATTEMPTS_PER_REQUEST = RETRY_BACKOFF_MS.length + 1;

const DEFAULT_TIMEOUT_MS = 30_000;

/** @param {number} ms */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request the endpoint refused, carrying its status as a field rather than only in the message. */
export class HttpRefused extends Error {
  /** @param {number | null} status @param {string} detail */
  constructor(status, detail) {
    super(status === null ? `transport failure: ${detail}` : `HTTP ${status}: ${detail}`);
    this.name = 'HttpRefused';
    /** @type {number | null} */ this.status = status;
  }
}

/** The per-run request ceiling was reached. Thrown, never returned, so no caller can ignore it. */
export class CeilingReached extends Error {
  /** @param {number} ceiling */
  constructor(ceiling) {
    super(`keyless request ceiling of ${ceiling} reached`);
    this.name = 'CeilingReached';
  }
}

/** A URL outside {@link HOSTS} was passed to the client. Never a network event — a programming error. */
export class HostRefused extends Error {
  /** @param {string} url */
  constructor(url) {
    super(`refusing a URL outside the keyless host allow-list: ${url}`);
    this.name = 'HostRefused';
  }
}

/**
 * @typedef {object} RequestEvent
 * @property {string} url
 * @property {number | null} status `null` for a transport failure.
 * @property {boolean} ok
 * @property {number} issued Attempts issued by this client so far, including this one.
 * @property {number} intervalMs Pacing interval in force when this attempt was issued.
 */

/**
 * A serialised, paced, ceiling-bounded, host-restricted keyless client.
 *
 * Serialised deliberately: batching and concurrency are measured harmful against this family of
 * endpoints, and two concurrent jobs earned a sustained lockout. One request in flight, always.
 */
export class KeylessClient {
  /**
   * @param {object} options
   * @param {number} options.maxRequests Hard ceiling on attempts issued, retries included.
   * @param {number} [options.minIntervalMs]
   * @param {number} [options.timeoutMs]
   * @param {readonly number[]} [options.retryBackoffMs] Empty disables retry.
   * @param {(event: RequestEvent) => void} [options.onRequest] Called once per attempt.
   * @param {typeof fetch} [options.fetchImpl]
   * @param {(ms: number) => Promise<void>} [options.sleepImpl]
   * @param {() => number} [options.nowImpl]
   */
  constructor(options) {
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new TypeError('maxRequests must be a positive integer');
    }
    this.#ceiling = options.maxRequests;
    this.#floorMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#intervalMs = this.#floorMs;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.#onRequest = options.onRequest;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleepImpl ?? realSleep;
    this.#now = options.nowImpl ?? Date.now;
  }

  /** @type {number} */ #ceiling;
  /** @type {number} */ #floorMs;
  /** @type {number} */ #intervalMs;
  /** @type {number} */ #timeoutMs;
  /** @type {readonly number[]} */ #retryBackoffMs;
  /** @type {((event: RequestEvent) => void) | undefined} */ #onRequest;
  /** @type {typeof fetch} */ #fetch;
  /** @type {(ms: number) => Promise<void>} */ #sleep;
  /** @type {() => number} */ #now;
  /** @type {number} */ #issued = 0;
  /** @type {number} */ #shed = 0;
  /** @type {number} */ #transportFailures = 0;
  /** @type {number} */ #clean = 0;
  /** @type {number} */ #lastStartedAt = 0;
  /** @type {Promise<unknown>} */ #queue = Promise.resolve();

  /** Attempts issued, retries included. The number a run has to publish. */
  issued() { return this.#issued; }
  /** Attempts refused with 429 or 5xx. */
  shed() { return this.#shed; }
  /** Attempts that never reached the endpoint — timeout, reset, DNS. */
  transportFailures() { return this.#transportFailures; }
  /** Pacing interval currently in force, ms. */
  intervalMs() { return this.#intervalMs; }
  /** @returns {number} */
  remaining() { return Math.max(0, this.#ceiling - this.#issued); }

  /**
   * The most attempts one {@link getJson} can consume. A caller with a per-launch cap must
   * **reserve** this much before starting, which is what keeps a per-launch bound exact.
   */
  attemptsPerRequest() { return this.#retryBackoffMs.length + 1; }

  /** @param {string} url Absolute URL, on a host in {@link HOSTS}. @returns {Promise<unknown>} */
  async getJson(url) {
    if (!HOSTS.some((h) => url.startsWith(`${h}/`))) throw new HostRefused(url);
    const run = this.#queue.then(() => this.#execute(url), () => this.#execute(url));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** @param {string} url @returns {Promise<unknown>} */
  async #execute(url) {
    /** @type {Error} */ let last = new Error(`no attempt was made for ${url}`);
    for (let attempt = 0; attempt <= this.#retryBackoffMs.length; attempt++) {
      // Checked before every attempt, not once per logical request: a retry consumes the shared
      // public resource exactly as a first try does, and a bound that counted only first tries
      // would not be a bound.
      if (this.#issued >= this.#ceiling) throw new CeilingReached(this.#ceiling);

      if (attempt > 0) await this.#sleep(/** @type {number} */ (this.#retryBackoffMs[attempt - 1]));
      const wait = this.#intervalMs - (this.#now() - this.#lastStartedAt);
      if (this.#lastStartedAt !== 0 && wait > 0) await this.#sleep(wait);

      this.#issued += 1;
      this.#lastStartedAt = this.#now();
      const intervalMs = this.#intervalMs;

      /** @type {Response} */ let response;
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        this.#transportFailures += 1;
        this.#slowDown();
        last = new HttpRefused(null, cause instanceof Error ? cause.message : String(cause));
        this.#onRequest?.({ url, status: null, ok: false, issued: this.#issued, intervalMs });
        continue;
      }

      this.#onRequest?.({ url, status: response.status, ok: response.ok, issued: this.#issued, intervalMs });

      if (response.ok) {
        this.#speedUp();
        try {
          return await response.json();
        } catch (cause) {
          // The request WAS served, so this is neither "the endpoint failed" nor "we asked wrong",
          // and retrying cannot resolve which. Its own status, so no caller reads it as an empty page.
          throw new HttpRefused(response.status, `body was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }

      last = new HttpRefused(response.status, url);
      // A 4xx that is not a 429 is the endpoint's considered answer about our query shape. Asking
      // again spends a request to be told the same thing.
      if (response.status !== 429 && response.status < 500) throw last;
      this.#shed += 1;
      this.#slowDown();
    }
    throw last;
  }

  #slowDown() {
    this.#clean = 0;
    this.#intervalMs = Math.min(BACKOFF.ceilingMs, Math.round(this.#intervalMs * BACKOFF.growth));
  }

  #speedUp() {
    this.#clean += 1;
    if (this.#clean < BACKOFF.decayAfter) return;
    this.#clean = 0;
    this.#intervalMs = Math.max(this.#floorMs, Math.round(this.#intervalMs * BACKOFF.decay));
  }
}
