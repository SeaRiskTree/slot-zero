/**
 * The one file in this tool that opens a socket, and `test/venue-label.test.ts` pins that.
 *
 * It talks to exactly one host — Helius's Wallet API, `credential.mjs` → `WALLET_API_HOST` — and to
 * exactly two paths on it. It never names an environment variable: the key arrives as a constructor
 * argument, lives in a private field, and reaches nothing but {@link walletIdentityUrl}. Every
 * message this module can produce is built from the *safe* spelling of the URL, and a test drives
 * every failure path against a sentinel key and asserts the sentinel reaches none of them.
 *
 * ## The cheap path is the default, and it is a 100x saving
 *
 * **Both endpoints cost {@link CREDITS_PER_REQUEST} credits per REQUEST**, and the batch one
 * resolves up to 100 addresses in that one request — so labelling 100 addresses one at a time costs
 * 10,000 credits and labelling them together costs 100. `identity.mjs` → `planLookups` is what makes
 * the cheap path unavoidable rather than optional; this client only carries the two shapes.
 *
 * ## Every issued attempt is counted as billed
 *
 * The vendor publishes no statement about whether a shed or failed request is billed, and a bill we
 * cannot see is assumed to have happened. So {@link WalletIdentityClient.creditsSpent} counts
 * ATTEMPTS, retries included, and the ceiling is checked before each one. That over-states spend on
 * a run that retried; over-stating a spend against a ceiling fails towards not spending, which is
 * the only direction that is safe on a metered surface.
 *
 * ## Helius's failure shapes are not the public RPC's
 *
 * Measured on the RPC route (`AGENTS.md` → "Helius facts") and carried over here, with the Wallet
 * API's own documented addition:
 *
 * - **401** — a bad or missing key, returned with a plain-text body. Terminal. Never retried.
 * - **403** — the key is real but the plan is not entitled: the Wallet API docs state free-tier
 *   keys get `403` on these endpoints. Terminal, and it is a TIER fact rather than a transient one.
 * - **429 / 5xx** — retried with backoff. Nothing shed at any rung on the RPC route, so a 429 here
 *   is a surprise worth backing off from rather than hammering.
 * - **Any other 4xx** — the vendor's considered answer about our request shape. Asking again spends
 *   another 100 credits to be told the same thing, so it is terminal too. The documented instance:
 *   the batch endpoint requires the field `addresses` and rejects `wallets` with a `400`.
 */

import { walletIdentityUrl } from './credential.mjs';

/**
 * Credits a single Wallet API request costs, from the vendor's own billing table
 * (`helius.dev/docs/billing/credits`, read 2026-08-07): *"All Wallet API requests cost 100 credits
 * each: Wallet Identity 100 … Batch Identity Lookup 100 — Look up up to 100 addresses in a single
 * request"*. It is a VENDOR fact and lives beside the host rather than in `bounds.json`, which holds
 * only this project's own ceilings; a test pins the two together.
 */
export const CREDITS_PER_REQUEST = 100;

/** Path of the single-address lookup. `{address}` is substituted. */
export const IDENTITY_PATH = '/v1/wallet/{address}/identity';

/** Path of the batch lookup — up to 100 addresses for one request's worth of credits. */
export const BATCH_IDENTITY_PATH = '/v1/wallet/batch-identity';

/**
 * Floor between the starts of two requests, in ms.
 *
 * **UNMEASURED on this endpoint.** A ladder down to 0 ms shed nothing on Helius's RPC route at
 * 161 req/s (`AGENTS.md` → "Helius facts"), and the plan allows 50 req/s, but nothing has measured
 * the Wallet API. This is a courtesy floor, not a shed-avoidance figure, and it is cheap: a run of
 * this size issues single-digit requests.
 */
export const DEFAULT_MIN_INTERVAL_MS = 250;

/** Waits before the 2nd and 3rd attempt at a shed request, on top of the pacing interval. */
export const RETRY_BACKOFF_MS = Object.freeze([1_000, 4_000]);

const DEFAULT_TIMEOUT_MS = 30_000;

/** @param {number} ms */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A request the vendor refused, carrying its status and whether it is worth asking again as fields
 * rather than only in the message.
 */
export class HeliusRefused extends Error {
  /**
   * @param {number | null} status  `null` for a transport failure.
   * @param {string} detail         Already free of any credential.
   * @param {boolean} terminal      Whether retrying could ever produce a different answer.
   */
  constructor(status, detail, terminal) {
    super(status === null ? `transport failure: ${detail}` : `HTTP ${status}: ${detail}`);
    this.name = 'HeliusRefused';
    /** @type {number | null} */
    this.status = status;
    /** @type {boolean} */
    this.terminal = terminal;
  }
}

/** A per-run ceiling was reached. Thrown rather than returned so no caller can ignore it. */
export class CeilingReached extends Error {
  /**
   * @param {'requests' | 'credits'} kind
   * @param {number} ceiling
   */
  constructor(kind, ceiling) {
    super(`the per-run ${kind} ceiling of ${ceiling} was reached; nothing further was sent`);
    this.name = 'CeilingReached';
    /** @type {'requests' | 'credits'} */
    this.kind = kind;
  }
}

/**
 * Turn a status into an actionable sentence. Exported so a test can assert the wording without
 * driving a whole run, and so a caller can render it without rebuilding the table.
 *
 * @param {number} status
 * @param {string} bodyExcerpt Already-truncated excerpt of the vendor's body.
 * @returns {string}
 */
export function describeHeliusStatus(status, bodyExcerpt) {
  const tail = bodyExcerpt.trim().length > 0 ? ` Vendor said: ${bodyExcerpt.trim()}` : '';
  if (status === 401) {
    return (
      `HTTP 401 — the vendor rejected the key. Helius answers a bad or missing key this way, with ` +
      `a plain-text body, so this is the credential and not the request. Re-export it and rerun. ` +
      `Nothing was named: this is NOT an "unknown" result.${tail}`
    );
  }
  if (status === 403) {
    return (
      `HTTP 403 — the key is recognised but its plan is not entitled to the Wallet API. The docs ` +
      `state free-tier keys get 403 on these endpoints and this lane's key is Developer, so a 403 ` +
      `here means the plan changed. That is a captain matter, not a retry.${tail}`
    );
  }
  if (status === 429) {
    return `HTTP 429 — rate-limited. Backing off; the request will be retried.${tail}`;
  }
  if (status >= 500) {
    return `HTTP ${status} — the vendor failed on its own side. Backing off; it will be retried.${tail}`;
  }
  return (
    `HTTP ${status} — the vendor refused the request shape. Note the batch endpoint takes ` +
    `\`addresses\`, not \`wallets\`. Asking again spends another ${CREDITS_PER_REQUEST} credits to ` +
    `be told the same thing, so it is not retried.${tail}`
  );
}

/**
 * @typedef {object} RequestEvent
 * @property {string} url        The SAFE spelling. There is no other one outside this module.
 * @property {number | null} status `null` for a transport failure.
 * @property {boolean} ok
 * @property {number} issued     Attempts issued so far, including this one.
 * @property {number} credits    Credits assumed spent so far, including this attempt.
 */

/**
 * @typedef {object} ClientOptions
 * @property {string} key                  The bare key. Held privately; never printed.
 * @property {number} maxRequests          Hard ceiling on attempts issued, retries included.
 * @property {number} maxCredits           Hard ceiling on credits assumed spent.
 * @property {number} [minIntervalMs]
 * @property {number} [timeoutMs]
 * @property {readonly number[]} [retryBackoffMs] Empty disables retry.
 * @property {(event: RequestEvent) => void} [onRequest]
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleepImpl]
 * @property {() => number} [nowImpl]
 */

/**
 * A serialised, paced, ceiling-bounded Wallet API client.
 *
 * Serialised deliberately, for the reason every client in this repository is: one request in
 * flight, always. There is nothing to gain from concurrency at single-digit request counts and the
 * fleet has already paid once for discovering that a vendor weights concurrent requests against its
 * own limiter.
 */
export class WalletIdentityClient {
  /** @param {ClientOptions} options */
  constructor(options) {
    if (typeof options.key !== 'string' || options.key.length === 0) {
      throw new TypeError('key must be a non-empty string');
    }
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new TypeError('maxRequests must be a positive integer');
    }
    if (!Number.isInteger(options.maxCredits) || options.maxCredits < CREDITS_PER_REQUEST) {
      throw new TypeError(`maxCredits must be an integer of at least ${CREDITS_PER_REQUEST}`);
    }
    this.#key = options.key;
    this.#maxRequests = options.maxRequests;
    this.#maxCredits = options.maxCredits;
    this.#intervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.#onRequest = options.onRequest;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleepImpl ?? realSleep;
    this.#now = options.nowImpl ?? Date.now;
  }

  /** @type {string} */ #key;
  /** @type {number} */ #maxRequests;
  /** @type {number} */ #maxCredits;
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
  /** @type {number} */ #lastStartedAt = 0;

  /** Attempts issued, retries included. */
  issued() {
    return this.#issued;
  }

  /** Credits assumed spent: every attempt, retries included. See this module's header. */
  creditsSpent() {
    return this.#issued * CREDITS_PER_REQUEST;
  }

  /** Attempts the vendor refused with 429 or 5xx. */
  shed() {
    return this.#shed;
  }

  /** Attempts that never reached the vendor at all — timeout, reset, DNS. */
  transportFailures() {
    return this.#transportFailures;
  }

  /** The most attempts one logical request can consume. A caller reserves this before starting. */
  attemptsPerRequest() {
    return this.#retryBackoffMs.length + 1;
  }

  /**
   * One address. Costs the SAME as a batch of 100, so this exists for the single-address case and
   * nothing else — `identity.mjs` → `planLookups` never chooses it for more than one address.
   *
   * @param {string} address Already shape-checked by the caller; it lands in a URL path.
   * @returns {Promise<unknown>}
   */
  async identity(address) {
    return this.#send(IDENTITY_PATH.replace('{address}', encodeURIComponent(address)), null);
  }

  /**
   * Up to 100 addresses for one request's worth of credits.
   *
   * The body field is `addresses`. The published docs implied `wallets` and the live API rejects
   * that with a `400` — recorded because it is the one place the vendor's documentation and its
   * server are known to disagree.
   *
   * @param {readonly string[]} addresses
   * @returns {Promise<unknown>}
   */
  async batchIdentity(addresses) {
    return this.#send(BATCH_IDENTITY_PATH, { addresses: [...addresses] });
  }

  /**
   * @param {string} path
   * @param {object | null} body `null` for a GET.
   * @returns {Promise<unknown>}
   */
  async #send(path, body) {
    const { url, safe } = walletIdentityUrl(this.#key, path);
    /** @type {Error} */
    let last = new Error(`no attempt was made for ${safe}`);

    for (let attempt = 0; attempt <= this.#retryBackoffMs.length; attempt++) {
      // Checked before every attempt, not once per logical request: a retry spends the same
      // 100 credits a first try does, and a ceiling that only counted first tries is not a ceiling.
      if (this.#issued >= this.#maxRequests) throw new CeilingReached('requests', this.#maxRequests);
      if (this.creditsSpent() + CREDITS_PER_REQUEST > this.#maxCredits) {
        throw new CeilingReached('credits', this.#maxCredits);
      }

      if (attempt > 0) await this.#sleep(/** @type {number} */ (this.#retryBackoffMs[attempt - 1]));
      const wait = this.#intervalMs - (this.#now() - this.#lastStartedAt);
      if (this.#lastStartedAt !== 0 && wait > 0) await this.#sleep(wait);

      this.#issued += 1;
      this.#lastStartedAt = this.#now();

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
        last = new HeliusRefused(null, cause instanceof Error ? cause.message : String(cause), false);
        this.#onRequest?.({ url: safe, status: null, ok: false, issued: this.#issued, credits: this.creditsSpent() });
        continue;
      }

      this.#onRequest?.({
        url: safe,
        status: response.status,
        ok: response.ok,
        issued: this.#issued,
        credits: this.creditsSpent(),
      });

      if (response.ok) {
        try {
          return await response.json();
        } catch (cause) {
          // The request WAS served and billed, so this is neither "the vendor failed" nor "we asked
          // wrong", and retrying cannot resolve which. Terminal, and surfaced as its own condition
          // so no caller can read it as an empty answer.
          throw new HeliusRefused(
            response.status,
            `body was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
            true,
          );
        }
      }

      const excerpt = (await response.text().catch(() => '')).slice(0, 200);
      const retryable = response.status === 429 || response.status >= 500;
      last = new HeliusRefused(response.status, describeHeliusStatus(response.status, excerpt), !retryable);
      if (!retryable) throw last;
      this.#shed += 1;
    }
    throw last;
  }
}
