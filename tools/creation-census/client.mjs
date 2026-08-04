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
 * tier allows ten private queries and the account holds eight; a retried create would spend a second
 * irreplaceable slot on the same statement, which is the slot-exhaustion failure this lane exists
 * downstream of.
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
      `HTTP 402 on ${path} — the Dune plan's allowance is spent. The Free tier is 2,500 credits a ` +
      `month, SHARED with whatever else holds this key, and nothing in this tool tracks the month: ` +
      `it is stateless between runs and the monthly arithmetic is the operator's.${tail}`
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
