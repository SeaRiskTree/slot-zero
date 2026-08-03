/**
 * The one file in this tool that opens a socket.
 *
 * It talks to exactly two hosts, both **keyless**: `swap-api.pump.fun` for the per-token fill tape
 * and `api.mainnet-beta.solana.com` for the clock pre-flight's block times. There is no header
 * hook, no options bag that reaches `fetch` from anywhere else, and `test/arrival-rate-walk.test.ts`
 * asserts that no other file here calls `fetch` and that nothing here names an environment
 * variable. The credential allow-list for this directory is **empty**, exactly as it is for
 * `tools/graduated-life-tape/`.
 *
 * **The keyed half of this lane deliberately does not exist.** The cohort and the launch lists come
 * off Dune, and Dune is reached by the operator running two committed statements and exporting
 * their results — see `cohort.mjs`. A collector that runs for days must not also be the thing that
 * can spend a billed, unretryable execution, and keeping the key out of this directory makes that a
 * property of the tree rather than a promise in a README.
 *
 * ## Why this duplicates `tools/graduated-life-tape/client.mjs`
 *
 * On purpose, and for the reason that module already records: the duplication between the two
 * keyless clients is the deliberate cost of the `tools/` boundary, and `AGENTS.md` names it as one
 * not to "fix" by importing across it. This one adds a second host and a per-host pacing floor,
 * which the life-tape collector has no use for.
 *
 * ## Pacing is measured, not guessed, and the two hosts are measured separately
 *
 * - `swap-api.pump.fun` refuses essentially everything at a 2 s interval and serves cleanly at 8 s.
 *   **4 s with adaptive backoff sustains indefinitely**: the graduated-life collection issued 6,539
 *   requests at that floor with *zero* HTTP 429 and three transport failures. A run that sheds
 *   heavily is a run going too fast, not an endpoint having a bad day.
 * - `api.mainnet-beta.solana.com` rate-limits **globally across methods**, and batching against it
 *   was re-measured in 2026-08 as actively harmful — one request per call, ~2.5 s apart, ~0.42
 *   requests/second. That host is used here for one bounded pre-flight and nothing else.
 */

/** Per-token fill tape host. Keyless, no account, no cost. */
export const SWAP_API = 'https://swap-api.pump.fun';

/**
 * The only working keyless Solana RPC endpoint this repo has found.
 *
 * `solana-rpc.publicnode.com` 403s this client outright on every request, with or without a browser
 * `User-Agent`, and the retry backoff hides it — it stalled an earlier job for 40 minutes. It is
 * named here as a warning and appears in no URL this tool builds.
 */
export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/** Measured floor for `swap-api.pump.fun`. 2 s is refused outright; 4 s sustains indefinitely. */
export const SWAP_MIN_INTERVAL_MS = 4_000;

/**
 * Measured floor for `api.mainnet-beta.solana.com`.
 *
 * Sustainable is one process, one call per request, ~2.5 s between requests. The nominally faster
 * 1.4 s is *slower* in wall clock once backoff is counted.
 */
export const RPC_MIN_INTERVAL_MS = 2_500;

/**
 * How the interval reacts to being shed, and how it comes back down.
 *
 * `growth` on every 429/5xx, `decay` after `decayAfter` consecutive clean responses, clamped to
 * `[floor, ceilingMs]`. The ceiling is the top of the range the population tape builder's own
 * `delay` field reached, so a wall that is genuinely 40 s wide is one this client sits out rather
 * than one it hammers.
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
 * @property {string} host                    Absolute origin. Every URL passed to this client must
 *   sit under it — see {@link KeylessClient}.
 * @property {number} maxRequests             Hard ceiling on requests **issued**, retries included.
 * @property {number} minIntervalMs           Floor between the starts of two requests.
 * @property {number} [timeoutMs]             Default 30000.
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
 * A serialised, paced, ceiling-bounded keyless client for ONE host.
 *
 * One host per instance rather than one client for both, because the two hosts' measured pacing
 * floors differ by more than a factor of one and a half and their backoff state must not be
 * shared: a shed from the fill tape has nothing to say about the RPC's willingness to answer.
 *
 * Serialised deliberately: batching and concurrency were re-measured as actively harmful against
 * this family of endpoints, and two concurrent jobs earned a sustained lockout. One request in
 * flight, always.
 */
export class KeylessClient {
  /** @param {ClientOptions} options */
  constructor(options) {
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new TypeError('maxRequests must be a positive integer');
    }
    if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) {
      throw new TypeError('minIntervalMs must be a non-negative finite number');
    }
    this.#host = options.host;
    this.#ceiling = options.maxRequests;
    this.#floorMs = options.minIntervalMs;
    this.#intervalMs = this.#floorMs;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.#onRequest = options.onRequest;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleepImpl ?? realSleep;
    this.#now = options.nowImpl ?? Date.now;
  }

  /** @type {string} */ #host;
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

  /** The origin this client is allowed to reach. @returns {string} */
  host() {
    return this.#host;
  }

  /** Attempts issued, retries included. The number a run record has to publish. */
  issued() {
    return this.#issued;
  }

  /** Attempts the endpoint refused with 429 or 5xx. */
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
   * The most attempts one call can consume.
   *
   * A caller with a per-launch cap has to **reserve** this much before starting a request rather
   * than discover it afterwards, which is what keeps a per-launch bound exact instead of nominal.
   */
  attemptsPerRequest() {
    return this.#retryBackoffMs.length + 1;
  }

  /**
   * @param {string} url Absolute URL under this client's host.
   * @returns {Promise<unknown>}
   */
  async getJson(url) {
    return this.#enqueue(() => this.#execute(url, null));
  }

  /**
   * Issue one JSON-RPC call. **One call per request** — no batching.
   *
   * The public RPC weights each batch entry against its limiter, so the same work took 58 s at
   * batch=1 with zero load-shed events and 110 s at batch=8 with eleven. A `null` result inside a
   * response is load-shedding rather than "absent", so it is surfaced as a refusal the caller
   * retries, never as a verdict.
   *
   * @param {string} method
   * @param {readonly unknown[]} params
   * @returns {Promise<unknown>}
   */
  async rpc(method, params) {
    const body = { jsonrpc: '2.0', id: 1, method, params };
    return this.#enqueue(() => this.#execute(this.#host, body));
  }

  /**
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  #enqueue(work) {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * @param {string} url
   * @param {unknown} body `null` for a GET.
   * @returns {Promise<unknown>}
   */
  async #execute(url, body) {
    // Checked once, before any attempt: a URL outside this client's host is a programming error
    // rather than a runtime condition, and letting it through would make "which hosts can this
    // tool reach" a question about call sites instead of about this file.
    if (!url.startsWith(`${this.#host}/`) && url !== this.#host) {
      throw new TypeError(`${url} is not under this client's host ${this.#host}`);
    }

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
          method: body === null ? 'GET' : 'POST',
          headers:
            body === null
              ? { accept: 'application/json' }
              : { accept: 'application/json', 'content-type': 'application/json' },
          ...(body === null ? {} : { body: JSON.stringify(body) }),
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
