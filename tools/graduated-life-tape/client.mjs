/**
 * The one file in this tool that opens a socket.
 *
 * It talks to exactly one host — `swap-api.pump.fun`, keyless, no account, no cost — and it is
 * structurally incapable of carrying a credential: there is no header hook, no options bag that
 * reaches `fetch`, and `test/graduated-life-tape.test.ts` asserts that no other file here calls
 * `fetch` and that nothing here names an environment variable. That is the whole of captain
 * decision 112a as it applies to this lane: **zero metered provider requests.**
 *
 * `solana-rpc.publicnode.com` is deliberately absent, and so is every RPC host — this collector
 * needs none. The dead-host trap that stalled an earlier job for 40 minutes behind retry backoff
 * (`data/population-tape-2026-07-29/report.md` §9.3) cannot recur in a client with one host.
 *
 * ## Why this duplicates `tools/deployer-screen/pumpfun.mjs`
 *
 * On purpose, and it is the cheaper of two costs. That module is under active edit by the screen
 * lane; importing it would couple a multi-hour collection walk to a file whose pacing constants and
 * error types are moving. The duplication is the same kind of deliberate cost as the curve
 * constants shared between `src/index.ts` and `tools/deployer-screen/measure.mjs` — do not "fix" it
 * by importing across it.
 *
 * ## Pacing is measured, not guessed
 *
 * `swap-api.pump.fun/v2/coins/{mint}/trades` refuses essentially everything at a 2 s interval and
 * serves cleanly at 8 s. The scout that pinned the graduation timestamps settled on a **4 s floor
 * with adaptive backoff** and completed 871 requests in 66 minutes (~4.55 s/request end to end)
 * with no sustained lockout. {@link DEFAULT_MIN_INTERVAL_MS} and {@link BACKOFF} encode exactly
 * that, and the adaptive half is not optional: the committed tape's own build metadata records
 * **16,960 HTTP 429 against 51,715 OK, with 221 of 235 launches shedding at least once**, and a
 * builder `delay` that ranged 0.75 s–40 s. A 429 here is the normal case, not an incident.
 */

/** Per-token fill tape host. The only host this tool contacts. */
export const SWAP_API = 'https://swap-api.pump.fun';

/**
 * Floor between the *starts* of two requests, in ms.
 *
 * Not the observed rate — the floor. The adaptive term below pushes the real interval above this
 * whenever the endpoint sheds, so the measured end-to-end rate of a long run lands slower.
 */
export const DEFAULT_MIN_INTERVAL_MS = 4_000;

/**
 * How the interval reacts to being shed, and how it comes back down.
 *
 * `growth` on every 429/5xx, `decay` after `decayAfter` consecutive clean responses, clamped to
 * `[floor, ceilingMs]`. The ceiling is the top of the range the tape builder's own `delay` field
 * reached, so a wall that is genuinely 40 s wide is one this client can sit out rather than one it
 * hammers.
 */
export const BACKOFF = Object.freeze({
  growth: 1.6,
  decay: 0.85,
  decayAfter: 5,
  ceilingMs: 40_000,
});

/** Waits before the 2nd, 3rd and 4th attempt at a shed request, on top of the pacing interval. */
export const RETRY_BACKOFF_MS = Object.freeze([3_000, 9_000, 27_000]);

const DEFAULT_TIMEOUT_MS = 30_000;

/** @param {number} ms */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request the endpoint refused, carrying its status as a field rather than only in the message. */
export class HttpRefused extends Error {
  /**
   * @param {number | null} status
   * @param {string} detail
   */
  constructor(status, detail) {
    super(status === null ? `transport failure: ${detail}` : `HTTP ${status}: ${detail}`);
    this.name = 'HttpRefused';
    /** @type {number | null} */
    this.status = status;
  }
}

/** The per-run request ceiling was reached. Thrown rather than returned so no caller can ignore it. */
export class CeilingReached extends Error {
  /** @param {number} ceiling */
  constructor(ceiling) {
    super(`keyless request ceiling of ${ceiling} reached`);
    this.name = 'CeilingReached';
  }
}

/**
 * @typedef {object} ClientOptions
 * @property {number} maxRequests            Hard ceiling on requests **issued**, retries included.
 * @property {number} [minIntervalMs]        Default {@link DEFAULT_MIN_INTERVAL_MS}.
 * @property {number} [timeoutMs]            Default 30000.
 * @property {readonly number[]} [retryBackoffMs] Default {@link RETRY_BACKOFF_MS}. Empty disables retry.
 * @property {(event: RequestEvent) => void} [onRequest] Called once per **attempt**, after it resolves.
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleepImpl]
 * @property {() => number} [nowImpl]
 */

/**
 * @typedef {object} RequestEvent
 * @property {string} url
 * @property {number | null} status  `null` for a transport failure.
 * @property {boolean} ok
 * @property {number} issued         Total attempts issued by this client so far, including this one.
 * @property {number} intervalMs     The pacing interval in force when this attempt was issued.
 */

/**
 * A serialised, paced, ceiling-bounded keyless client.
 *
 * Serialised deliberately: the June re-measurement found batching and concurrency actively harmful
 * against this family of endpoints, and two concurrent jobs earned a sustained lockout. One request
 * in flight, always.
 */
export class KeylessClient {
  /** @param {ClientOptions} options */
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

  /** Attempts issued, retries included. The number the run record has to publish. */
  issued() {
    return this.#issued;
  }

  /** Attempts the endpoint refused with 429 or 5xx. A run whose shed count is *low* is the odd one. */
  shed() {
    return this.#shed;
  }

  /** Attempts that never reached the endpoint at all — timeout, reset, DNS. */
  transportFailures() {
    return this.#transportFailures;
  }

  /** The pacing interval currently in force, in ms. Rises on shed, decays back to the floor. */
  intervalMs() {
    return this.#intervalMs;
  }

  /** @returns {number} */
  remaining() {
    return Math.max(0, this.#ceiling - this.#issued);
  }

  /**
   * The most attempts one {@link getJson} can consume.
   *
   * A caller with a per-launch cap has to **reserve** this much before starting a request rather
   * than discover it afterwards, which is what keeps a per-launch bound exact instead of nominal.
   */
  attemptsPerRequest() {
    return this.#retryBackoffMs.length + 1;
  }

  /**
   * @param {string} url Absolute URL.
   * @returns {Promise<unknown>}
   */
  async getJson(url) {
    const run = this.#queue.then(
      () => this.#execute(url),
      () => this.#execute(url),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * @param {string} url
   * @returns {Promise<unknown>}
   */
  async #execute(url) {
    /** @type {Error} */
    let last = new Error(`no attempt was made for ${url}`);

    for (let attempt = 0; attempt <= this.#retryBackoffMs.length; attempt++) {
      // Checked before every attempt, not once per logical request: a retry consumes a shared
      // public resource exactly as a first try does, and a bound that only counted first tries
      // would not be a bound.
      if (this.#issued >= this.#ceiling) throw new CeilingReached(this.#ceiling);

      if (attempt > 0) await this.#sleep(/** @type {number} */ (this.#retryBackoffMs[attempt - 1]));
      const wait = this.#intervalMs - (this.#now() - this.#lastStartedAt);
      if (this.#lastStartedAt !== 0 && wait > 0) await this.#sleep(wait);

      this.#issued += 1;
      this.#lastStartedAt = this.#now();
      const intervalMs = this.#intervalMs;

      /** @type {Response} */
      let response;
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

      this.#onRequest?.({
        url,
        status: response.status,
        ok: response.ok,
        issued: this.#issued,
        intervalMs,
      });

      if (response.ok) {
        this.#speedUp();
        try {
          return await response.json();
        } catch (cause) {
          // The request WAS served, so this is neither "the endpoint failed" nor "we asked wrong",
          // and retrying cannot resolve which. Surfaced as its own status so a caller cannot
          // silently read it as an empty page.
          throw new HttpRefused(
            response.status,
            `body was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
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
