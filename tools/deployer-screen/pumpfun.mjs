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

import { CeilingReached, RequestFailed, UnparseableResponse } from './client.mjs';

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
 * A refused keyless request, carrying its status **as a field**.
 *
 * The status is structured rather than only formatted into the message because a caller that has to
 * report the failure must be able to do so **without repeating the URL** — and this client's URLs
 * embed the mint. A drop note built from `error.message` would carry a vendor-derived token address
 * into a persisted run record, which is exactly what MadeOnSol terms §5a(d) and the containment
 * claim in `stage2.mjs` → `toEntryRecordRow` forbid. `record.mjs` → `redactVendorIdentifiers`
 * catches it at the boundary as well; this is the half that means it never has to.
 *
 * It extends {@link RequestFailed} so `record.mjs` can classify a missing measurement from ONE
 * exception type: the status is what a drop note needs, `retried` is what the record needs to tell
 * a wall apart from a hiccup, and neither should need its own `instanceof` arm.
 */
export class KeylessHttpError extends RequestFailed {
  /**
   * @param {number} status
   * @param {string} url
   * @param {boolean} [retried]
   */
  constructor(status, url, retried = false) {
    super(`HTTP ${status} on ${url}`, { status, retried });
    this.name = 'KeylessHttpError';
  }
}

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
   * The most requests one {@link getJson} can consume: the first attempt plus one per backoff.
   *
   * Exposed because a caller with a per-walk request cap has to **reserve** this much before
   * starting a request, not discover it afterwards. Deriving it from the client rather than
   * restating it in the caller is what keeps `maxRequestsPerLaunch` an exact bound rather than an
   * approximate one — see {@link readLaunchWindow}.
   *
   * @returns {number}
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
   * One retry, matching the keyed client's allowance.
   *
   * A 5xx or a timeout means the request was **not served**, so re-issuing it once is closer to one
   * successful request than to two — which is why the courtesy this class owes a shared public
   * endpoint is the pacing, left untouched at the measured interval, and not the retry count. The
   * alternative is worse for pump.fun as well as for us: without a retry the caller re-runs the
   * whole walk. Every attempt still counts against the ceiling, and the ceiling is re-checked
   * before each one, so a retry cannot smuggle a request past it.
   *
   * A 4xx is not retried. It is the endpoint's considered answer, and asking again spends a
   * request to be told the same thing.
   *
   * Every failure leaves as a {@link RequestFailed} carrying the status and whether a retry was
   * actually made, because the run record classifies a missing measurement from this exception. The
   * one exception is a body that is not JSON, which leaves as an {@link UnparseableResponse}: the
   * request WAS served, so neither "the endpoint failed" nor "our code failed" is established, and
   * the record must not pick one.
   *
   * @param {string} url
   * @returns {Promise<unknown>}
   */
  async #execute(url) {
    /** @type {Error} */
    let last = new Error(`no attempt was made for ${url}`);
    let attempts = 0;

    // Attempt 0 plus one per configured backoff. **Every attempt counts against the ceiling**, the
    // same rule the keyed client uses: a retry consumes a shared public resource exactly as a first
    // try does, and a bound that only counted successes would not be a bound.
    for (let attempt = 0; attempt <= this.#retryBackoffMs.length; attempt++) {
      if (this.#issued >= this.#ceiling) throw new CeilingReached(this.#ceiling, url);

      if (attempt > 0) await this.#sleep(/** @type {number} */ (this.#retryBackoffMs[attempt - 1]));
      const wait = this.#minIntervalMs - (Date.now() - this.#lastStartedAt);
      if (this.#lastStartedAt !== 0 && wait > 0) await this.#sleep(wait);

      this.#issued += 1;
      attempts += 1;
      this.#lastStartedAt = Date.now();
      this.#onRequest?.(url);

      // A transport failure — a timeout, a reset, a DNS blip — means the request was never served,
      // so it is retried on the same budget as a shed one rather than ending the walk. The attempt
      // has already been counted above, which is the point: the ceiling bounds what we sent, not
      // what came back.
      let response;
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        last = new RequestFailed(
          `Transport failure on ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { status: null, retried: attempts > 1 },
        );
        continue;
      }

      if (response.ok) {
        // A body that is not JSON leaves as an `UnparseableResponse`, not a `RequestFailed`: the
        // request WAS served, so neither "the endpoint failed" nor "our code failed" is
        // established, and the record must not pick one.
        try {
          return await response.json();
        } catch (cause) {
          throw new UnparseableResponse(
            `Response to ${url} was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
            { status: response.status },
          );
        }
      }

      last = new KeylessHttpError(response.status, url, attempts > 1);
      // 429 and 5xx are the endpoint shedding load, which it does constantly. A 4xx that is not a
      // 429 is our query shape, and retrying it just spends the allowance to be told off twice.
      if (response.status !== 429 && response.status < 500) throw last;
      this.#shed += 1;
    }
    if (last instanceof RequestFailed) last.retried = attempts > 1;
    throw last;
  }
}

/**
 * Keep only fills inside the opening window, measured in **slots** from the create slot.
 *
 * Using slots rather than the timestamp avoids depending on the endpoint's second-resolution `ts`,
 * which cannot order fills inside one slot, and on the vendor's mint time, which is a second clock
 * with nothing to reconcile it against.
 *
 * The span is a **pinned parameter, deliberately not `ceil(windowMs / 400)`.** That nominal
 * conversion gives 150 for a 60s window and is measurably too narrow: across the 210 committed
 * 60-second launches the observed slot span runs p50 151 / p90 155 / max 158, and 51% of them hold
 * at least one fill beyond `createSlot + 150`. Those trailing fills are disproportionately late
 * sells, and dropping one flips a wallet from closed to open — which shrinks
 * `fieldClosedRoundTrips`, itself a gate. See `thresholds.json` → `stage2_entry.windowSlotSpan`.
 *
 * @param {readonly import('./measure.mjs').Fill[]} fills
 * @param {number} windowSlotSpan Slots after the create slot that remain inside the window.
 * @returns {import('./measure.mjs').Fill[]}
 */
export function windowFilter(fills, windowSlotSpan) {
  const curveBuys = fills.filter((f) => f.side === 'buy' && f.venue === 'pump');
  if (curveBuys.length === 0) return [];
  let createSlot = Infinity;
  for (const f of curveBuys) if (f.slot < createSlot) createSlot = f.slot;
  return fills.filter((f) => f.slot >= createSlot && f.slot <= createSlot + windowSlotSpan);
}

/**
 * @typedef {object} TradePage
 * @property {Record<string, unknown>[]} rows
 * @property {boolean} recognised Whether the body was a shape we can read rows out of **at all**.
 *   `false` and `rows: []` are different findings: the first is "we do not understand the answer",
 *   the second is "the endpoint says there is nothing". Collapsing them is what let an unrecognised
 *   body read as proof that the walk had reached the mint.
 * @property {boolean | null} hasMore    The endpoint's own statement, or `null` when it made none.
 * @property {string | null} nextCursor
 */

/**
 * Read one page of the trade endpoint.
 *
 * The endpoint has returned both a bare array and an object wrapping one across versions, so accept
 * either rather than assume. But **only the wrapped shape carries `pagination`**, and pagination is
 * the only thing that can prove a backwards walk has nothing older left to see. So the three facts
 * are reported separately and a missing one is `null`, never a default: see {@link readLaunchWindow}
 * for why an assumed `hasMore: false` is the exact silent failure this module exists to refuse.
 *
 * @param {unknown} body
 * @returns {TradePage}
 */
export function extractTradePage(body) {
  /** @type {TradePage} */
  const none = { rows: [], recognised: false, hasMore: null, nextCursor: null };
  if (Array.isArray(body)) {
    return { rows: /** @type {Record<string, unknown>[]} */ (body), recognised: true, hasMore: null, nextCursor: null };
  }
  if (typeof body !== 'object' || body === null) return none;

  const obj = /** @type {Record<string, unknown>} */ (body);
  /** @type {Record<string, unknown>[] | null} */
  let rows = null;
  for (const key of ['trades', 'data', 'items', 'results']) {
    const v = obj[key];
    if (Array.isArray(v)) {
      rows = /** @type {Record<string, unknown>[]} */ (v);
      break;
    }
  }
  if (rows === null) return none;

  const raw = obj['pagination'];
  const pagination = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : null;
  const hasMore = pagination !== null && typeof pagination['hasMore'] === 'boolean' ? pagination['hasMore'] : null;
  const next = pagination === null ? undefined : pagination['nextCursor'];
  return { rows, recognised: true, hasMore, nextCursor: typeof next === 'string' ? next : null };
}

/**
 * The rows of one trade page, for callers that only need the rows.
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>[]}
 */
export function extractTradeRows(body) {
  return extractTradePage(body).rows;
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
 * Why a launch window was dropped. One value per cause, never a lump total, because the causes call
 * for different actions: a request cap means the launch was busy, a `mint-time-disagreement` means
 * the vendor's clock and the fill tape have come apart and the measurement is no longer resting on
 * what we think it is.
 *
 * @typedef {'mint-time-disagreement' | 'coverage-unproven' | 'unrecognised-body' | 'request-cap'
 *   | 'stalled-cursor' | 'unparsed-rows' | 'no-fills'} LaunchWindowDropReason
 */

/**
 * @typedef {object} LaunchWindow
 * @property {string} mint
 * @property {import('./measure.mjs').Fill[]} fills Fills inside the opening window, **anchored on
 *   the earliest curve buy's own slot** rather than on the supplied mint time.
 * @property {number} pages           Pages the walk consumed.
 * @property {number} requests        Requests it cost, **including retries of shed ones**.
 * @property {number} rowsSeen        Rows the endpoint returned, before window filtering.
 * @property {number} unparsedRows    Rows we could not read. Non-zero makes the launch unusable.
 * @property {boolean} reachedCreateSlot Whether the walk provably got back past the mint.
 * @property {boolean} hitRequestCap  Whether it stopped because of `maxRequests`.
 * @property {boolean} mintTimeDisagreement Whether a row older than the supplied mint time came
 *   back — proof the two clocks disagree, and a hard drop. See {@link readLaunchWindow}.
 * @property {boolean} usable         Whether this window may be measured at all.
 * @property {LaunchWindowDropReason | null} dropReason `null` exactly when `usable`.
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
 * So coverage is a **proof obligation, not an assumption**, and the only thing that discharges it is
 * **the endpoint explicitly saying there is nothing older**: a `pagination.hasMore` of exactly
 * `false`, or a recognised page with no rows on it. The *absence* of a pagination object proves
 * nothing at all — {@link extractTradePage} deliberately tolerates a bare array and `data`/`items`/
 * `results` wrappers, none of which carry one, and reading a missing `hasMore` as `false` would stop
 * the walk after page one and call a partial window complete. An unrecognised body likewise proves
 * nothing; it is a drop of its own. This is the same distinction the population tape draws with
 * `meta.reached_mint`, which the repo's loader gates on because all 239 mints have a window file and
 * four of them never reached the mint.
 *
 * **A row older than the mint is a DISAGREEMENT, not coverage.** `createdAtMs` comes from the
 * vendor's `pump_tokens[].created_timestamp` while the fills come from pump.fun, and a real token has
 * no pre-mint trades — so a pre-mint row means the two clocks have come apart, not that the walk
 * arrived. Measured on the committed tape: **0 of 235 covered launches has any fill older than its
 * recorded creation time, and the gap between that time and the first fill is exactly 0 on every one
 * of them.** There is no slack to spend on a tolerance, and a positive skew of one millisecond would
 * delete the entire create slot — whose rows share the mint's exact millisecond — leaving the walk
 * anchored on a mid-window slot with the wrong deployer, a near-zero dev buy and an inflated room
 * figure. So the launch is **dropped**, and the drop is counted and reported per run.
 *
 * **The measured window is anchored on the chain's own ordering, not on the vendor's clock.** Fills
 * are trimmed by {@link windowFilter}, i.e. by `windowSlotSpan` slots from the earliest curve buy, so
 * the timestamp survives only as the seek cursor hint and never decides membership. A clock
 * disagreement therefore cannot quietly shift which fills are measured; it can only trip the
 * tripwire above.
 *
 * **`seekMarginMs` and the pre-mint tripwire are DIFFERENT MECHANISMS with different rules, and a
 * reader must not merge them.** The margin is added to the *cursor* only: the walk starts from
 * `createdAtMs + windowMs + seekMarginMs` so that a vendor mint time running *early* by less than the
 * margin cannot cut the tail off the window before the slot trim ever sees it. It buys back rows the
 * seek would otherwise never fetch. It is **not** a tolerance on any proof: the pre-mint tripwire
 * still compares `ts < createdAtMs` with **zero slack** (the measured gap is exactly 0 on all 235
 * committed launches, so there is no slack to spend), and coverage is still discharged only by the
 * endpoint explicitly saying nothing older exists. Widening the margin can never soften either.
 *
 * `usable` is what a caller must branch on, and `dropReason` is why. An unusable window is **dropped
 * and counted**, never measured — a launch missing from the sample shrinks `n` visibly, whereas a
 * launch measured from a partial window is a wrong number that looks like a right one.
 *
 * Ceiling errors are deliberately **not** caught here. A {@link CeilingReached} mid-launch is a
 * run-level terminal, and the caller is expected to reserve `maxRequests` of headroom before starting
 * a launch it cannot afford to finish.
 *
 * The cap is on **requests, not pages**, and that distinction is load-bearing. This endpoint sheds
 * roughly a quarter of what it is asked for (see {@link DEFAULT_RETRY_BACKOFF_MS}), and the client
 * retries. If the cap counted only successful pages, a launch's true cost would be the cap times
 * the retry count and the printed plan would understate the exposure by 3x. Counting requests makes
 * the per-launch bound exact — but only if the **whole** cost of a page is reserved before it is
 * started, since one {@link KeylessClient#getJson} may spend up to {@link
 * KeylessClient#attemptsPerRequest} requests. Checking the cap between pages instead would let a walk
 * with one request of headroom left spend three, and the stage's declared worst case is arithmetic
 * the dry run prints as the entire exposure. It cannot cost more than `maxRequests`, retries included.
 *
 * @param {KeylessClient} client
 * @param {object} opts
 * @param {string} opts.mint
 * @param {number} opts.createdAtMs Mint time. The seek cursor's hint and the disagreement tripwire —
 *   **not** the window boundary.
 * @param {number} opts.windowMs    Opening window length, for the seek only. 60000 matches the tape.
 * @param {number} opts.seekMarginMs Extra time past the nominal window end to start the seek from,
 *   so an early vendor mint time cannot truncate the tail. A cursor hint, never a proof tolerance.
 * @param {number} opts.windowSlotSpan Slots after the create slot that count as inside the window.
 * @param {number} opts.maxRequests Hard per-launch request cap, retries included.
 * @param {number} opts.pageLimit   Rows per request.
 * @returns {Promise<LaunchWindow>}
 */
export async function readLaunchWindow(client, opts) {
  const { mint, createdAtMs, windowMs, seekMarginMs, windowSlotSpan, maxRequests, pageLimit } = opts;
  const seekFromMs = createdAtMs + windowMs + seekMarginMs;
  const issuedBefore = client.issued();
  const spent = () => client.issued() - issuedBefore;
  const perPageCost = client.attemptsPerRequest();

  /** @type {import('./measure.mjs').Fill[]} */
  const collected = [];
  let pages = 0;
  let rowsSeen = 0;
  let unparsedRows = 0;
  let reachedCreateSlot = false;
  let hitRequestCap = false;
  let stalled = false;
  let unrecognisedBody = false;
  let coverageUnproven = false;
  let mintTimeDisagreement = false;

  // The slot half of the cursor is ignored by the seek; only the timestamp is honoured. Sending a
  // literal 0 says so, rather than implying a slot we did not measure. The margin only widens where
  // the walk STARTS — what ends up in the window is decided by `windowSlotSpan` below.
  let cursor = `0-${seekFromMs}`;

  while (spent() + perPageCost <= maxRequests) {
    const url =
      `${SWAP_API}/v2/coins/${encodeURIComponent(mint)}/trades` +
      `?limit=${pageLimit}&cursor=${encodeURIComponent(cursor)}`;
    const body = await client.getJson(url);
    pages += 1;

    const page = extractTradePage(body);
    if (!page.recognised) {
      // We do not understand the answer. That is not the same as being told there is nothing older,
      // and treating it as such is what would mark a partial window usable.
      unrecognisedBody = true;
      break;
    }
    rowsSeen += page.rows.length;
    if (page.rows.length === 0) {
      // A page we could read that carries no row: the endpoint says nothing older than the cursor
      // exists, so the walk is behind the mint by construction.
      reachedCreateSlot = true;
      break;
    }

    for (const row of page.rows) {
      const ts = Date.parse(String(row['timestamp'] ?? row['ts'] ?? ''));
      if (!Number.isFinite(ts)) {
        unparsedRows += 1;
        continue;
      }
      // ZERO SLACK, deliberately, and `seekMarginMs` is not admitted here. The margin is a cursor
      // hint; this is a proof. A real token has no pre-mint trade, so any row older than the
      // recorded creation means the two clocks disagree.
      if (ts < createdAtMs) {
        mintTimeDisagreement = true;
        continue;
      }
      try {
        collected.push(parseFillLoose(row));
      } catch {
        unparsedRows += 1;
      }
    }

    if (mintTimeDisagreement) break;

    if (page.hasMore === false) {
      // The endpoint says the token has no older fills, so we are behind the mint. This is the ONLY
      // pagination-derived proof, and every walk that has ever succeeded ended here.
      reachedCreateSlot = true;
      break;
    }
    if (page.hasMore !== true) {
      // No pagination at all. Nothing is proved either way, and a walk that cannot prove coverage is
      // dropped rather than measured.
      coverageUnproven = true;
      break;
    }
    if (page.nextCursor === null || page.nextCursor === '' || page.nextCursor === cursor) {
      // A cursor that does not advance would loop forever against the page cap and then report a
      // page-cap truncation, which is the wrong diagnosis for a broken cursor.
      stalled = true;
      break;
    }
    cursor = page.nextCursor;
  }

  if (!reachedCreateSlot && !stalled && !unrecognisedBody && !coverageUnproven && !mintTimeDisagreement) {
    hitRequestCap = spent() + perPageCost > maxRequests;
  }

  // Anchored on the earliest curve buy's own slot. Slots are a monotonic sequence the chain itself
  // maintains; the vendor's wall clock is a second opinion we have no way to reconcile.
  const fills = mintTimeDisagreement ? [] : windowFilter(collected, windowSlotSpan);

  const usable = reachedCreateSlot && unparsedRows === 0 && fills.length > 0;
  /** @type {LaunchWindowDropReason | null} */
  const dropReason = usable
    ? null
    : mintTimeDisagreement
      ? 'mint-time-disagreement'
      : stalled
        ? 'stalled-cursor'
        : unrecognisedBody
          ? 'unrecognised-body'
          : coverageUnproven
            ? 'coverage-unproven'
            : hitRequestCap
              ? 'request-cap'
              : unparsedRows > 0
                ? 'unparsed-rows'
                : 'no-fills';

  const note = usable
    ? `${fills.length} fill(s) in the opening ${windowSlotSpan} slot(s) over ${pages} page(s) and ` +
      `${spent()} request(s), walked back past the mint`
    : dropReason === 'mint-time-disagreement'
      ? `DROPPED (mint-time disagreement): the endpoint returned fill(s) OLDER than the recorded mint ` +
        `time, which a real token does not have. The vendor's creation time and the fill tape ` +
        `disagree, so the create slot cannot be trusted and this launch is not measured. A NON-ZERO ` +
        `COUNT OF THESE IS A REPORTABLE EVENT: it means the clock assumption this walk rests on has broken.`
      : dropReason === 'stalled-cursor'
        ? `DROPPED: the cursor stopped advancing after ${spent()} request(s), so the walk never reached the mint`
        : dropReason === 'unrecognised-body'
          ? `DROPPED: the endpoint returned a body with no readable row list after ${pages} page(s) — ` +
            `its shape may have changed, and an answer we cannot read is NOT proof that the walk reached the mint`
          : dropReason === 'coverage-unproven'
            ? `DROPPED: the endpoint returned ${rowsSeen} row(s) but never said whether anything older ` +
              `exists, so coverage back to the mint is UNPROVEN. The earliest slot seen is merely the ` +
              `earliest seen, which is not the create slot.`
            : dropReason === 'request-cap'
              ? `DROPPED: spent ${spent()} of the ${maxRequests}-request cap on ${rowsSeen} row(s) without ` +
                `reaching the mint, and the remaining headroom is less than one page costs, so the ` +
                `earliest slot seen is NOT the create slot. This launch was busier than the cap allows ` +
                `for, and busy launches are exactly the interesting ones — see the sampling caveat.`
              : dropReason === 'unparsed-rows'
                ? `DROPPED: ${unparsedRows} of ${rowsSeen} row(s) could not be read — the endpoint's shape may have changed`
                : `DROPPED: no fill in the opening ${windowSlotSpan} slot(s) (is the mint time right?)`;

  return {
    mint,
    fills,
    pages,
    requests: spent(),
    rowsSeen,
    unparsedRows,
    reachedCreateSlot,
    hitRequestCap,
    mintTimeDisagreement,
    usable,
    dropReason,
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
