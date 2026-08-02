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
 * population tape was built from. {@link readLaunchWindow} is the paging walk over that endpoint;
 * it was deliberately left unbuilt until Stage 2 had a real caller to validate it against, and it
 * is written here against one.
 *
 * Pacing is not a guess: the June report measured sustainable keyless throughput at roughly
 * 0.5 requests/second with one request in flight, and found batching and concurrency both
 * actively harmful. The default interval encodes that.
 */

import { CeilingReached } from './client.mjs';

/** Creator listing host. */
export const FRONTEND_API = 'https://frontend-api-v3.pump.fun';

/** Per-token fill tape host. The affordable route to a launch window — see {@link readLaunchWindow}. */
export const SWAP_API = 'https://swap-api.pump.fun';

/**
 * @typedef {object} KeylessOptions
 * @property {number} maxRequests
 * @property {number} [minIntervalMs] Default 2000 — the June report's measured pacing, plus margin.
 * @property {number} [timeoutMs]     Default 30000.
 * @property {readonly number[]} [retryBackoffMs] Backoff before each retry. Empty disables retry.
 *   Default {@link DEFAULT_RETRY_BACKOFF_MS} — see {@link KeylessClient} on why a keyless client
 *   needs one at all.
 * @property {(label: string) => void} [onRequest]
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleepImpl]
 */

const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Backoff before the 2nd and 3rd attempt at a shed request.
 *
 * **Measured, from the committed tape's own build metadata.** Every `window/*.meta.json` records
 * the request stats of the walk that produced it, and across the 235 covered launches those read
 * **51,715 OK against 16,960 HTTP 429 — a 24.7% shed rate — with 221 of the 235 launches shedding
 * at least once.** The builder's own `delay` field ranges from 0.75s to 40s, i.e. it backed off
 * adaptively and retried through them.
 *
 * So on this endpoint a 429 is the normal case, not an incident, and a client that treats one as
 * terminal cannot walk a launch window at all. That is not a hypothetical: the first live check of
 * this pager died on a 429 three launches in. Two retries at 3s and 9s clear the ordinary case
 * while staying far inside the pacing the tape build itself sustained.
 */
export const DEFAULT_RETRY_BACKOFF_MS = [3_000, 9_000];

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
    this.#retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.#onRequest = options.onRequest;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleepImpl ?? realSleep;
  }

  /** @type {number} */ #ceiling;
  /** @type {number} */ #minIntervalMs;
  /** @type {number} */ #timeoutMs;
  /** @type {readonly number[]} */ #retryBackoffMs;
  /** @type {((label: string) => void) | undefined} */ #onRequest;
  /** @type {typeof fetch} */ #fetch;
  /** @type {(ms: number) => Promise<void>} */ #sleep;
  /** @type {number} */ #issued = 0;
  /** @type {number} */ #shed = 0;
  /** @type {number} */ #lastStartedAt = 0;
  /** @type {Promise<unknown>} */ #queue = Promise.resolve();

  /**
   * Requests the endpoint refused with a 429 or a 5xx, across every attempt.
   *
   * Reported rather than swallowed: on the committed tape's own build a quarter of all requests
   * were shed, so a run whose shed count is *low* is the surprising one.
   *
   * @returns {number}
   */
  shed() {
    return this.#shed;
  }

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
    /** @type {Error} */
    let last = new Error(`no attempt was made for ${url}`);

    // Attempt 0 plus one per configured backoff. **Every attempt counts against the ceiling**, the
    // same rule the keyed client uses: a retry consumes a shared public resource exactly as a first
    // try does, and a bound that only counted successes would not be a bound.
    for (let attempt = 0; attempt <= this.#retryBackoffMs.length; attempt++) {
      if (this.#issued >= this.#ceiling) throw new CeilingReached(this.#ceiling, url);

      if (attempt > 0) await this.#sleep(/** @type {number} */ (this.#retryBackoffMs[attempt - 1]));
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

      if (response.ok) return response.json();

      last = new Error(`HTTP ${response.status} on ${url}`);
      // 429 and 5xx are the endpoint shedding load, which it does constantly. A 4xx that is not a
      // 429 is our query shape, and retrying it just spends the allowance to be told off twice.
      if (response.status !== 429 && response.status < 500) throw last;
      this.#shed += 1;
    }
    throw last;
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
 * | tokens      | `base`  | `baseAmount` |
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
    // Left-padded to a fixed width so a lexicographic sort is a numeric one. The stored tape's
    // `sid` is already zero-padded to 22; the live `slotIndexId` is the same width, but a shorter
    // value from either surface would otherwise sort *before* a longer one and silently invert the
    // fill queue that `solQueuedAheadSol` is computed from.
    sid: String(row['sid'] ?? row['slotIndexId'] ?? '').padStart(22, '0'),
    tx: String(row['tx'] ?? row['signature'] ?? row['tx_signature'] ?? ''),
    wallet: String(row['u'] ?? row['userAddress'] ?? row['user'] ?? row['wallet'] ?? ''),
    side,
    venue,
    sol: Number(row['sol'] ?? row['amountSol'] ?? row['sol_amount'] ?? 0),
    tokens: Number(row['base'] ?? row['baseAmount'] ?? row['base_amount'] ?? row['tokenAmount'] ?? Number.NaN),
    priceSol: Number(row['psol'] ?? row['priceSol'] ?? row['price_sol'] ?? 0),
  };
}

/**
 * @typedef {object} LaunchWindow
 * @property {string} mint
 * @property {import('./measure.mjs').Fill[]} fills Fills inside `[createdAt, createdAt + windowMs]`.
 * @property {number} pages           Pages the walk consumed.
 * @property {number} requests        Requests it cost, **including retries of shed ones**.
 * @property {number} rowsSeen        Rows the endpoint returned, before window filtering.
 * @property {number} unparsedRows    Rows we could not read. Non-zero makes the launch unusable.
 * @property {boolean} reachedCreateSlot Whether the walk provably got back past the mint.
 * @property {boolean} hitRequestCap  Whether it stopped because of `maxRequests`.
 * @property {boolean} usable         Whether this window may be measured at all.
 * @property {string} note            Why, in one sentence. Always populated.
 */

/**
 * Walk the per-token fill tape backwards from the end of a launch's opening window to the mint.
 *
 * **The affordable route.** `swap-api.pump.fun/v2/coins/{mint}/trades` is keyless, serves 100 fills
 * a page with the swapping wallet on every row, and its cursor is `<slotIndexId>-<timestampMs>`
 * whose **timestamp component seeks** — so a launch window costs a handful of requests instead of
 * walking the token's entire history. The seek is why this measurement is affordable at all; the
 * population tape was built by paging this endpoint the same way.
 *
 * **The trap this function exists to refuse.** Rows come back newest-first, so the create slot is
 * the *last* thing a backwards walk reaches. A walk that stops early — page cap, a stalled cursor,
 * a transport failure — still returns a plausible-looking pile of fills whose earliest slot is
 * simply the earliest one it happened to see. {@link import('./measure.mjs').measureCreateSlot}
 * would then anchor on that slot, call some mid-window sniper "the deployer", and report a
 * confident room figure for a launch whose opening it never saw. Nothing about the output would
 * look wrong.
 *
 * So coverage is a **proof obligation, not an assumption**: `reachedCreateSlot` is true only when
 * the walk saw a row older than the mint, or the endpoint told us there was nothing older. This is
 * the same distinction the population tape draws with `meta.reached_mint`, which the repo's loader
 * gates on because all 239 mints have a window file and four of them never reached the mint.
 *
 * `usable` is what a caller must branch on. An unusable window is **dropped and counted**, never
 * measured — a launch missing from the sample shrinks `n` visibly, whereas a launch measured from a
 * partial window is a wrong number that looks like a right one.
 *
 * Ceiling errors are deliberately **not** caught here. A {@link CeilingReached} mid-launch is a
 * run-level terminal, and the caller is expected to reserve `maxRequests` of headroom before starting
 * a launch it cannot afford to finish.
 *
 * The cap is on **requests, not pages**, and that distinction is load-bearing. This endpoint sheds
 * roughly a quarter of what it is asked for (see {@link DEFAULT_RETRY_BACKOFF_MS}), and the client
 * retries. If the cap counted only successful pages, a launch's true cost would be the cap times
 * the retry count and the printed plan would understate the exposure by 3x. Counting requests makes
 * the per-launch bound exact: it cannot cost more than `maxRequests`, retries included.
 *
 * @param {KeylessClient} client
 * @param {object} opts
 * @param {string} opts.mint
 * @param {number} opts.createdAtMs Mint time. The walk's stopping post.
 * @param {number} opts.windowMs    Opening window length. 60000 matches the committed tape.
 * @param {number} opts.maxRequests Hard per-launch request cap, retries included.
 * @param {number} opts.pageLimit   Rows per request.
 * @returns {Promise<LaunchWindow>}
 */
export async function readLaunchWindow(client, opts) {
  const { mint, createdAtMs, windowMs, maxRequests, pageLimit } = opts;
  const windowEndMs = createdAtMs + windowMs;
  const issuedBefore = client.issued();
  const spent = () => client.issued() - issuedBefore;

  /** @type {import('./measure.mjs').Fill[]} */
  const fills = [];
  let pages = 0;
  let rowsSeen = 0;
  let unparsedRows = 0;
  let reachedCreateSlot = false;
  let hitRequestCap = false;
  let stalled = false;

  // The slot half of the cursor is ignored by the seek; only the timestamp is honoured. Sending a
  // literal 0 says so, rather than implying a slot we did not measure.
  let cursor = `0-${windowEndMs}`;

  while (spent() < maxRequests) {
    const url =
      `${SWAP_API}/v2/coins/${encodeURIComponent(mint)}/trades` +
      `?limit=${pageLimit}&cursor=${encodeURIComponent(cursor)}`;
    const body = await client.getJson(url);
    pages += 1;

    const rows = extractTradeRows(body);
    rowsSeen += rows.length;
    if (rows.length === 0) {
      // Nothing older than the cursor exists, so the walk is behind the mint by construction.
      reachedCreateSlot = true;
      break;
    }

    let crossedTheMint = false;
    for (const row of rows) {
      const ts = Date.parse(String(row['timestamp'] ?? row['ts'] ?? ''));
      if (!Number.isFinite(ts)) {
        unparsedRows += 1;
        continue;
      }
      if (ts < createdAtMs) {
        crossedTheMint = true;
        continue;
      }
      // The seek lands on the first row at or before the cursor timestamp, but a cursor is not a
      // filter — drop anything past the window rather than letting it into the measurement.
      if (ts > windowEndMs) continue;
      try {
        fills.push(parseFillLoose(row));
      } catch {
        unparsedRows += 1;
      }
    }

    if (crossedTheMint) {
      reachedCreateSlot = true;
      break;
    }

    const pagination = /** @type {Record<string, unknown>} */ (
      typeof body === 'object' && body !== null ? (/** @type {any} */ (body)['pagination'] ?? {}) : {}
    );
    const next = pagination['nextCursor'];
    if (pagination['hasMore'] !== true) {
      // The endpoint says the token has no older fills, so we are behind the mint.
      reachedCreateSlot = true;
      break;
    }
    if (typeof next !== 'string' || next === '' || next === cursor) {
      // A cursor that does not advance would loop forever against the page cap and then report a
      // page-cap truncation, which is the wrong diagnosis for a broken cursor.
      stalled = true;
      break;
    }
    cursor = next;
  }

  if (!reachedCreateSlot && !stalled) hitRequestCap = spent() >= maxRequests;

  const usable = reachedCreateSlot && unparsedRows === 0 && fills.length > 0;
  const note = usable
    ? `${fills.length} fill(s) in the opening ${windowMs / 1000}s over ${pages} page(s) and ` +
      `${spent()} request(s), walked back past the mint`
    : stalled
      ? `DROPPED: the cursor stopped advancing after ${spent()} request(s), so the walk never reached the mint`
      : hitRequestCap
        ? `DROPPED: spent the ${maxRequests}-request cap on ${rowsSeen} row(s) without reaching the mint, ` +
          `so the earliest slot seen is NOT the create slot. This launch was busier than the cap ` +
          `allows for, and busy launches are exactly the interesting ones — see the sampling caveat.`
        : unparsedRows > 0
          ? `DROPPED: ${unparsedRows} of ${rowsSeen} row(s) could not be read — the endpoint's shape may have changed`
          : `DROPPED: no fill in the opening ${windowMs / 1000}s (is the mint time right?)`;

  return {
    mint,
    fills,
    pages,
    requests: spent(),
    rowsSeen,
    unparsedRows,
    reachedCreateSlot,
    hitRequestCap,
    usable,
    note,
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
