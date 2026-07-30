/**
 * Keyless pump.fun clients. No credential, no account, no cost — but a shared public resource,
 * so the same bounds apply as to the keyed client.
 *
 * One endpoint is fetched here: `frontend-api-v3.pump.fun/coins?creator=`, a creator's token
 * listing, used only by the optional `--consistency` pass. It serves **70 per page regardless of the
 * limit asked for**, and it lists by *current* creator, so a creator's listed history is a lower
 * bound and the token that goes missing is exactly the good one.
 *
 * The row parsers here — {@link parseFillLoose}, {@link windowFilter}, {@link extractTradeRows} —
 * read `swap-api.pump.fun/v2/coins/{mint}/trades` rows, the per-token fill tape the committed
 * population tape was built from. **Nothing in this module fetches that tape.** The paging walk that
 * would is Stage 2's, and it belongs in the lane that has a caller to validate it against; a
 * half-exercised pager described in the docs as tested is worse than an absent one.
 *
 * Pacing is not a guess: the June report measured sustainable keyless throughput at roughly
 * 0.5 requests/second with one request in flight, and found batching and concurrency both
 * actively harmful. The default interval encodes that.
 */

import { CeilingReached } from './client.mjs';

/** Creator listing host. */
export const FRONTEND_API = 'https://frontend-api-v3.pump.fun';

/**
 * @typedef {object} KeylessOptions
 * @property {number} maxRequests
 * @property {number} [minIntervalMs] Default 2000 — the June report's measured pacing, plus margin.
 * @property {number} [timeoutMs]     Default 30000.
 * @property {(label: string) => void} [onRequest]
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleepImpl]
 */

const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** @param {number} ms */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A serialised, ceiling-bounded, paced client for pump.fun's keyless endpoints.
 *
 * Deliberately a separate class from {@link import('./client.mjs').BoundedClient} rather than a
 * shared base: that one carries a credential and this one must never be able to. Keeping them
 * apart means no refactor can accidentally attach an `Authorization` header to a keyless
 * request or send a key to a host that never needed one.
 */
export class KeylessClient {
  /** @param {KeylessOptions} options */
  constructor(options) {
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new TypeError('maxRequests must be a positive integer');
    }
    this.#ceiling = options.maxRequests;
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onRequest = options.onRequest;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleepImpl ?? realSleep;
  }

  /** @type {number} */ #ceiling;
  /** @type {number} */ #minIntervalMs;
  /** @type {number} */ #timeoutMs;
  /** @type {((label: string) => void) | undefined} */ #onRequest;
  /** @type {typeof fetch} */ #fetch;
  /** @type {(ms: number) => Promise<void>} */ #sleep;
  /** @type {number} */ #issued = 0;
  /** @type {number} */ #lastStartedAt = 0;
  /** @type {Promise<unknown>} */ #queue = Promise.resolve();

  /** @returns {number} */
  issued() {
    return this.#issued;
  }

  /** @returns {number} */
  remaining() {
    return Math.max(0, this.#ceiling - this.#issued);
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
    if (this.#issued >= this.#ceiling) throw new CeilingReached(this.#ceiling, url);

    const wait = this.#minIntervalMs - (Date.now() - this.#lastStartedAt);
    if (this.#lastStartedAt !== 0 && wait > 0) await this.#sleep(wait);

    this.#issued += 1;
    this.#lastStartedAt = Date.now();
    this.#onRequest?.(url);

    const response = await this.#fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} on ${url}`);
    }
    return response.json();
  }
}

/**
 * Keep only fills inside the opening window, measured in slots from the create slot.
 *
 * Slots are ~400ms, so a 60s window is ~150 slots. Using slots rather than the timestamp avoids
 * depending on the endpoint's second-resolution `ts`, which cannot order fills inside one slot.
 *
 * @param {readonly import('./measure.mjs').Fill[]} fills
 * @param {number} windowMs
 * @returns {import('./measure.mjs').Fill[]}
 */
export function windowFilter(fills, windowMs) {
  const curveBuys = fills.filter((f) => f.side === 'buy' && f.venue === 'pump');
  if (curveBuys.length === 0) return [];
  let createSlot = Infinity;
  for (const f of curveBuys) if (f.slot < createSlot) createSlot = f.slot;
  const slotSpan = Math.ceil(windowMs / 400);
  return fills.filter((f) => f.slot >= createSlot && f.slot <= createSlot + slotSpan);
}

/**
 * The trade endpoint has returned both a bare array and an object wrapping one across versions.
 * Accept either rather than assume, and say so loudly if it becomes a third thing.
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>[]}
 */
export function extractTradeRows(body) {
  if (Array.isArray(body)) return /** @type {Record<string, unknown>[]} */ (body);
  if (typeof body === 'object' && body !== null) {
    for (const key of ['trades', 'data', 'items', 'results']) {
      const v = /** @type {Record<string, unknown>} */ (body)[key];
      if (Array.isArray(v)) return /** @type {Record<string, unknown>[]} */ (v);
    }
  }
  return [];
}

/**
 * Extract the Solana slot from pump.fun's `slotIndexId`, the within-slot ordering key.
 *
 * The **first 12 digits are the slot** and the remainder orders fills inside it; `src/window.ts`
 * documents the same fact for the stored tape. This matters because the live trade endpoint does
 * not return a `slot` field at all — only `slotIndexId` — so a parser that looked for `slot` would
 * read `NaN` on every live row and collapse every fill into one create slot.
 *
 * @param {unknown} sid
 * @returns {number} `NaN` when the value is not a usable slot index.
 */
export function slotFromSlotIndexId(sid) {
  if (sid === undefined || sid === null) return Number.NaN;
  const digits = String(sid).replace(/\D/g, '');
  if (digits.length < 12) return Number.NaN;
  return Number(digits.slice(0, 12));
}

/**
 * Parse a fill, tolerating the field-name variation between the stored tape's rows and the live
 * endpoint's.
 *
 * These two shapes genuinely differ, measured 2026-07-29 — the stored tape is a *normalised* form,
 * not a verbatim capture:
 *
 * | meaning | stored tape | live `swap-api` |
 * |---|---|---|
 * | slot        | `slot`  | (absent — derive from `slotIndexId`) |
 * | order key   | `sid`   | `slotIndexId` |
 * | wallet      | `u`     | `userAddress` |
 * | side        | `k`     | `type` |
 * | venue       | `p`     | `program` |
 * | SOL         | `sol`   | `amountSol` |
 * | price       | `psol`  | `priceSol` |
 *
 * The strict parser in `measure.mjs` is the one used on committed data, where the shape is known
 * and a surprise should be fatal. This one is used on live data, where it is not.
 *
 * @param {Record<string, unknown>} row
 * @returns {import('./measure.mjs').Fill}
 */
export function parseFillLoose(row) {
  const sideRaw = row['k'] ?? row['type'] ?? row['side'] ?? row['is_buy'];
  const sideStr = typeof sideRaw === 'string' ? sideRaw.toLowerCase() : sideRaw;
  const side =
    sideStr === 'buy' || sideStr === true ? 'buy' : sideStr === 'sell' || sideStr === false ? 'sell' : null;
  if (side === null) throw new Error(`unrecognised side ${JSON.stringify(sideRaw)}`);

  const venueRaw = row['p'] ?? row['program'] ?? row['pool'] ?? row['venue'];
  const venue = venueRaw === 'pump_amm' ? 'pump_amm' : venueRaw === 'pump' ? 'pump' : null;
  if (venue === null) throw new Error(`unrecognised venue ${JSON.stringify(venueRaw)}`);

  // Prefer an explicit slot, fall back to the order key. Never silently yield NaN.
  const explicitSlot = Number(row['slot']);
  const slot = Number.isFinite(explicitSlot)
    ? explicitSlot
    : slotFromSlotIndexId(row['slotIndexId'] ?? row['sid']);
  if (!Number.isFinite(slot)) {
    throw new Error(`no usable slot on fill (slot=${JSON.stringify(row['slot'])}, slotIndexId=${JSON.stringify(row['slotIndexId'])})`);
  }

  return {
    slot,
    tx: String(row['tx'] ?? row['signature'] ?? row['tx_signature'] ?? ''),
    wallet: String(row['u'] ?? row['userAddress'] ?? row['user'] ?? row['wallet'] ?? ''),
    side,
    venue,
    sol: Number(row['sol'] ?? row['amountSol'] ?? row['sol_amount'] ?? 0),
    priceSol: Number(row['psol'] ?? row['priceSol'] ?? row['price_sol'] ?? 0),
  };
}

/**
 * Page a creator's token listing for the optional `--consistency` pass.
 *
 * Two traps this respects rather than works around. The server serves **70 per page regardless
 * of the limit**, so paging is by offset and a full page never means the end. And the listing is
 * by *current* creator, which can move on-chain — so what comes back is a **lower bound** on a
 * creator's history, and the token most likely to be missing is its best one.
 *
 * @param {KeylessClient} client
 * @param {string} creator
 * @param {number} maxPages
 * @returns {Promise<{ records: import('./measure.mjs').TokenRecord[], pages: number, truncated: boolean }>}
 */
export async function readCreatorHistory(client, creator, maxPages) {
  /** @type {import('./measure.mjs').TokenRecord[]} */
  const records = [];
  let pages = 0;
  let truncated = false;

  for (let offset = 0; pages < maxPages; offset += 70) {
    const url =
      `${FRONTEND_API}/coins?creator=${encodeURIComponent(creator)}` +
      `&offset=${offset}&limit=70&sort=created_timestamp&order=DESC&includeNsfw=true`;
    const body = await client.getJson(url);
    pages += 1;

    const rows = Array.isArray(body)
      ? /** @type {Record<string, unknown>[]} */ (body)
      : extractTradeRows(body);
    if (rows.length === 0) break;

    for (const row of rows) {
      records.push({
        deployedAtMs: Number(row['created_timestamp']),
        completed: row['complete'] === true,
      });
    }

    if (rows.length < 70) break;
    if (pages === maxPages) truncated = true;
  }

  return { records, pages, truncated };
}
