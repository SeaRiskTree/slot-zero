/**
 * Keyless clients — pump.fun's public API and the public Solana RPC. No credential, no account, no
 * cost, but both are shared public resources, so the same bounds apply as to the keyed client.
 *
 * Two hosts are fetched here.
 *
 * `frontend-api-v3.pump.fun/coins?creator=` is a creator's token listing. It serves **70 per page
 * regardless of the limit asked for**, and it lists by *current* creator, so a creator's listed
 * history is a lower bound and the token that goes missing is exactly the good one. It is the
 * **ownership-derived** reading, and `creation.mjs` documents why that is the wrong question.
 *
 * `api.mainnet-beta.solana.com` is the only working keyless RPC found — `solana-rpc.publicnode.com`
 * 403s this client outright on every request (report §9.3), and anything copying the entity report's
 * endpoint list sends half its batches to a dead host while the retry backoff hides it. It is used
 * by {@link readCreatedHistory} to recover the **creation-derived** reading from create transactions,
 * which is the only keyless route to it: no pump.fun surface is indexed by original creator.
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
import { parseCreateTransaction, readCurveState } from './creation.mjs';

/** Creator listing host. */
export const FRONTEND_API = 'https://frontend-api-v3.pump.fun';

/** Per-token fill tape host. The affordable route to a launch window — see {@link readLaunchWindow}. */
export const SWAP_API = 'https://swap-api.pump.fun';

/**
 * The only keyless Solana RPC endpoint that works for this client, and the DEFAULT for
 * {@link SolanaRpcClient} when no endpoint is passed.
 *
 * The alternative in the entity report's endpoint list, `solana-rpc.publicnode.com`, 403s every
 * request with or without a browser `User-Agent`, and a job that sent it half its batches stalled
 * for 40 minutes behind retry backoff before anyone noticed the host was dead. So the keyless
 * choice is still not a choice.
 *
 * It is no longer the ONLY endpoint, though: `credential.mjs` → `resolveSolanaRpcEndpoint` selects
 * a keyed provider when one is configured and this host when none is, and hands the client a
 * {@link SolanaRpcEndpointRef}. This constant stays the default so a client built with no endpoint
 * — every existing caller and every existing test — reaches exactly the host it always did.
 */
export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * What a {@link SolanaRpcClient} ceiling actually stops, and the lever that raises it — persisted
 * verbatim as `creation.stopDetail` in a run record, so it has to be true of THIS ceiling.
 */
const RPC_CEILING_REMEDY =
  'This is the PER-CANDIDATE RPC ceiling, so the run has not stopped: it bounds how far back ' +
  'this one wallet\'s creation window reaches, and everything before it comes from the ownership ' +
  'listing instead. The lever is thresholds.json → creation_walk.maxRpcRequestsPerCandidate, ' +
  'which has no command-line flag; --max-requests is the keyed vendor ceiling and cannot move it.';

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
 * An RPC endpoint that refused this client's credential — HTTP 401 or 403.
 *
 * Its own type because it is the one RPC failure that is **never** retried and **never** a
 * measurement: the allowance is not what is wrong, the key is. Helius answers a bad or missing key
 * with HTTP 401 and a plain-text `Unauthorized` body (measured 2026-08-03), which is otherwise
 * indistinguishable from any other non-shed status.
 *
 * It carries the endpoint's **label**, never its URL: on a keyed endpoint the URL holds the key in
 * a query parameter, and this message reaches a terminal and a run record.
 */
export class RpcCredentialRejected extends Error {
  /**
   * @param {number} status
   * @param {string} endpointLabel The host with no credential in it.
   * @param {string} label         The method or batch that was refused.
   * @param {string} [remedy]      What to do about it, supplied by `credential.mjs`.
   */
  constructor(status, endpointLabel, label, remedy) {
    super(
      `HTTP ${status} from ${endpointLabel} on ${label} — the endpoint refused this client's credential.` +
        (remedy === undefined || remedy === '' ? '' : ` ${remedy}`),
    );
    this.name = 'RpcCredentialRejected';
    this.status = status;
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
 * @typedef {object} ListedToken
 * A row of the ownership-derived listing. A {@link import('./measure.mjs').TokenRecord} plus the
 * mint, which is what lets {@link import('./creation.mjs').mergeHistories} reconcile this listing
 * against the create transactions by identity rather than by counting.
 *
 * The mint is held in memory for the length of a run and is **never persisted** — no run record
 * carries a per-token row, and `test/deployer-screen.test.ts` asserts that.
 * @property {number} deployedAtMs
 * @property {boolean} completed
 * @property {string} mint
 */

/**
 * Page a creator's token listing — the **ownership-derived** reading.
 *
 * Three traps this respects rather than works around. The server serves **70 per page regardless
 * of the limit**, so paging is by offset and a full page never means the end. The listing has a
 * ceiling around 1,050 results, so a deployer past that is truncated no matter how many pages are
 * asked for. And it lists by *current* creator, which moves on-chain — so what comes back is a
 * **lower bound**, and the token most likely to be missing is its best one. That last one is not a
 * caveat to be carried any more: {@link readCreatedHistory} measures it.
 *
 * @param {KeylessClient} client
 * @param {string} creator
 * @param {number} maxPages
 * @returns {Promise<{ records: ListedToken[], pages: number, truncated: boolean }>}
 *   `truncated` means the page cap bit. It does **not** cover the ~1,050-result server ceiling or
 *   the creator-moved lower bound, which apply to every reading this endpoint can produce.
 */
export async function readCreatorHistory(client, creator, maxPages) {
  /** @type {ListedToken[]} */
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
        mint: typeof row['mint'] === 'string' ? row['mint'] : '',
      });
    }

    if (rows.length < 70) break;
    if (pages === maxPages) truncated = true;
  }

  return { records, pages, truncated };
}

// --- the creation-derived reading ------------------------------------------------------------

/**
 * A serialised, ceiling-bounded, paced JSON-RPC client for the public Solana endpoint.
 *
 * A third client rather than a reuse of {@link KeylessClient}, for the same reason that one is not
 * {@link import('./client.mjs').BoundedClient}: it POSTs a JSON-RPC envelope to a different host
 * with different failure semantics, and keeping the three apart means no refactor can send one
 * host's headers, pacing or credential to another.
 *
 * Two endpoint-specific behaviours are handled here rather than left to callers:
 *
 * - **A `null` result means retry, never "absent".** The public RPC sheds load by returning nulls
 *   inside batches instead of erroring, and a caller that reads one as an empty answer silently
 *   loses records. {@link batch} retries the null entries and reports what never resolved.
 * - **Rate limiting is global across methods.** `report.md` §9.4's "separate buckets" for
 *   `getSignaturesForAddress` and `getTransaction` did not hold, and two concurrent jobs earned a
 *   sustained 429 lockout. So there is one queue, one request in flight, and the interval is shared.
 * - **A 429 here is load-shedding, not a verdict.** This is the opposite of
 *   {@link import('./client.mjs').BoundedClient}, where 429 means a metered allowance is spent and
 *   retrying is just spending it again — so there it is terminal. On a free public endpoint it means
 *   *slow down*, and a client that gives up on the first one abandons the walk over a condition that
 *   clears in seconds. It is retried with exponential backoff, and **every attempt counts against
 *   the ceiling**, so a 429 storm still cannot turn a bounded walk into an unbounded one.
 *
 * @typedef {object} SolanaRpcEndpointRef
 * Where to POST, and the only thing that may be said about it out loud.
 *
 * Two fields rather than one because on Helius the URL **carries the credential** in a query
 * parameter. `url` is used for exactly one thing — the `fetch` call — and `label` is what every
 * thrown error, every heartbeat line and every persisted field uses. Nothing in this module
 * interpolates `url` into a string, and a test drives every failure path against a
 * sentinel-bearing URL to assert the sentinel reaches none of them.
 *
 * @property {string} url   The address to POST to. May carry a credential. Never formatted.
 * @property {string} label The same endpoint with no credential in it. Always safe to print.
 * @property {string} [authRemedy] What to do when the endpoint rejects the credential. Supplied by
 *   `credential.mjs`, because this module may not name a key's environment variable and so cannot
 *   write the sentence itself.
 *
 * @typedef {object} RpcOptions
 * @property {number} maxRequests
 * @property {SolanaRpcEndpointRef} [endpoint] Default {@link SOLANA_RPC}, keyless — so a caller
 *   that passes nothing reaches exactly the host it always did.
 * @property {number} [maxCredits] A metered-spend ceiling **in vendor credits**, for an endpoint
 *   that bills by returned rows rather than by request. Default `Infinity`, which is the truth on
 *   the keyless endpoint: it bills nothing, so nothing is metered and the request ceiling is the
 *   only bound. See {@link chargeCredits} for why the meter is driven by the caller.
 * @property {number} [minIntervalMs] Default 2500. See `thresholds.json` → `creation_walk`: the
 *   nominally faster 1400 was measured *slower* in wall-clock once backoff is counted. A keyed
 *   endpoint pins its own — `creation_walk_helius.rpcMinIntervalMs`, measured separately, because
 *   this default is a property of the free host and not of the method.
 * @property {number} [timeoutMs]     Default 40000.
 * @property {number} [maxRetriesPerRequest] Default 3. Each attempt counts against the ceiling.
 * @property {number} [backoffMs]     Default 5000, doubling per attempt.
 * @property {(label: string) => void} [onRequest]
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleepImpl]
 */
export class SolanaRpcClient {
  /** @param {RpcOptions} options */
  constructor(options) {
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new TypeError('maxRequests must be a positive integer');
    }
    this.#ceiling = options.maxRequests;
    this.#endpoint = options.endpoint ?? { url: SOLANA_RPC, label: SOLANA_RPC };
    this.#creditCeiling = options.maxCredits ?? Number.POSITIVE_INFINITY;
    this.#minIntervalMs = options.minIntervalMs ?? 2_500;
    this.#timeoutMs = options.timeoutMs ?? 40_000;
    this.#maxRetries = options.maxRetriesPerRequest ?? 3;
    this.#backoffMs = options.backoffMs ?? 5_000;
    this.#onRequest = options.onRequest;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** @type {SolanaRpcEndpointRef} */ #endpoint;
  /** @type {number} */ #creditCeiling;
  /** @type {number} */ #creditsSpent = 0;
  /** @type {number} */ #ceiling;
  /** @type {number} */ #minIntervalMs;
  /** @type {number} */ #timeoutMs;
  /** @type {number} */ #maxRetries;
  /** @type {number} */ #backoffMs;
  /** @type {((label: string) => void) | undefined} */ #onRequest;
  /** @type {typeof fetch} */ #fetch;
  /** @type {(ms: number) => Promise<void>} */ #sleep;
  /** @type {number} */ #issued = 0;
  /** @type {number} */ #shedEvents = 0;
  /** @type {number} */ #lastStartedAt = 0;
  /** @type {Promise<unknown>} */ #queue = Promise.resolve();

  /** @returns {number} */
  issued() {
    return this.#issued;
  }

  /**
   * How many attempts were refused with a 429 or a 5xx.
   *
   * Recorded because backoff is exactly the thing that hides a problem: a walk that took four times
   * as long as its pacing implies has been shedding, and without this the record shows only the
   * elapsed time and no reason for it.
   *
   * @returns {number}
   */
  loadShedEvents() {
    return this.#shedEvents;
  }

  /** @returns {number} */
  remaining() {
    return Math.max(0, this.#ceiling - this.#issued);
  }

  /**
   * The endpoint's name with no credential in it. The ONLY form any caller may print.
   *
   * @returns {string}
   */
  endpointLabel() {
    return this.#endpoint.label;
  }

  /** @returns {number} Vendor credits charged so far, as reported by the caller. */
  creditsSpent() {
    return this.#creditsSpent;
  }

  /** @returns {number} Credits left under the ceiling, `Infinity` when none was set. */
  creditsRemaining() {
    return Math.max(0, this.#creditCeiling - this.#creditsSpent);
  }

  /**
   * Charge vendor credits against this client's ceiling.
   *
   * **Driven by the caller rather than inferred here, because the price is a property of the ANSWER
   * and not of the request.** Helius bills `getTransactionsForAddress` at 10 credits per 100
   * transactions *returned*, so a page of 1,000 costs 100 and a page of 7 costs the 10-credit
   * minimum, and no amount of inspecting the request tells you which. The walk therefore checks
   * {@link creditsRemaining} against a page's WORST case before starting it and charges the ACTUAL
   * cost after — which is how a ceiling stated in credits stays exact rather than approximate, the
   * same discipline `readLaunchWindow` applies to its per-launch request cap.
   *
   * Charging cannot throw. The ceiling is enforced by refusing to START work that might exceed it;
   * a charge that arrives afterwards is a fact, and a client that threw on a fact would discard the
   * page it had already paid for.
   *
   * @param {number} credits
   * @returns {void}
   */
  chargeCredits(credits) {
    if (!Number.isFinite(credits) || credits <= 0) return;
    this.#creditsSpent += credits;
  }

  /**
   * One RPC method call.
   *
   * A JSON-RPC `error` envelope reads as `null` here, exactly as an absent result does, and that
   * conflation is deliberate on the keyless endpoint: it sheds load by returning nulls inside
   * batches, so the caller's rule is **a null is a retry, never "absent"** and it has to hold for
   * both. It does NOT hold on Helius, which answers a malformed request with HTTP 200 and an
   * `error` envelope — a considered answer that retrying only repeats. {@link callDetailed} is the
   * form that can tell them apart; this one is unchanged so every existing caller behaves exactly
   * as it did.
   *
   * @param {string} method
   * @param {unknown[]} params
   * @returns {Promise<unknown>}
   */
  async call(method, params) {
    const [entry] = await this.#send([{ method, params }], method);
    return entry?.result ?? null;
  }

  /**
   * One RPC method call, with the JSON-RPC `error` envelope kept rather than flattened.
   *
   * The distinction this exists for is the one that decides whether a walk retries or stops, and
   * **the two endpoints signal it differently**. Measured 2026-08-03:
   *
   * - The keyless public endpoint sheds load with a `null` result inside an otherwise fine
   *   response. A null is a retry there, never "absent".
   * - Helius answers a bad parameter with **HTTP 200 and `{"error":{"code":-32602,…}}`** — an
   *   invalid address, a limit above 1,000 and a corrupt pagination token all take that shape. It
   *   is the endpoint's considered answer; asking again spends the allowance to be told the same
   *   thing, and a walk that read it as an exhausted index would record page 2 of 200 as a
   *   wallet's whole history.
   *
   * So an error envelope is reported as an error and never as an empty answer, and the caller
   * decides. A missing result with no error stays `null`, i.e. still a retry.
   *
   * @param {string} method
   * @param {unknown[]} params
   * @returns {Promise<{ result: unknown, error: { code: number, message: string } | null }>}
   */
  async callDetailed(method, params) {
    const [entry] = await this.#send([{ method, params }], method);
    return { result: entry?.result ?? null, error: entry?.error ?? null };
  }

  /**
   * Several method calls in one HTTP request.
   *
   * Batching is what makes the creation walk affordable: the walk inspects thousands of
   * transactions and one request per transaction would not fit inside any honest ceiling. The size
   * is the caller's, capped at 8 — `report.md` §9.4's measured sustainable batch. Note this is the
   * **opposite** of the pump.fun rule encoded in {@link KeylessClient}, where batching and
   * concurrency were both measured actively harmful; the two hosts do not behave alike.
   *
   * @param {readonly { method: string, params: unknown[] }[]} requests
   * @returns {Promise<(unknown | null)[]>} `null` for entries the endpoint never resolved.
   */
  async batch(requests) {
    if (requests.length === 0) return [];
    if (requests.length > 8) throw new RangeError(`batch of ${requests.length} exceeds the measured cap of 8`);

    let out = (await this.#send(requests, `batch:${requests[0]?.method ?? '?'}`)).map((e) => e.result ?? null);
    // One retry for the nulls only. A null is load-shedding, so re-asking for the whole batch would
    // spend the ceiling re-fetching entries that already arrived.
    const missing = out.flatMap((v, i) => (v === null ? [i] : []));
    if (missing.length > 0 && this.remaining() > 0) {
      const retried = await this.#send(
        missing.map((i) => {
          const r = requests[i];
          if (r === undefined) throw new Error('unreachable: index came from this array');
          return r;
        }),
        'batch:retry',
      );
      out = [...out];
      missing.forEach((slot, k) => {
        out[slot] = retried[k]?.result ?? null;
      });
    }
    return out;
  }

  /**
   * @typedef {{ result: unknown, error: { code: number, message: string } | null }} RpcEntry
   */

  /**
   * @param {readonly { method: string, params: unknown[] }[]} requests
   * @param {string} label
   * @returns {Promise<RpcEntry[]>}
   */
  async #send(requests, label) {
    const run = this.#queue.then(
      () => this.#execute(requests, label),
      () => this.#execute(requests, label),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * @param {readonly { method: string, params: unknown[] }[]} requests
   * @param {string} label
   * @returns {Promise<RpcEntry[]>}
   */
  async #execute(requests, label) {
    const envelope = requests.map((r, i) => ({ jsonrpc: '2.0', id: i, method: r.method, params: r.params }));
    const body = JSON.stringify(requests.length === 1 ? envelope[0] : envelope);
    /** @type {unknown} */
    let lastFailure = new Error(`no attempt was made for ${label}`);

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      // Checked immediately before each attempt, so a retry cannot smuggle a request past the
      // ceiling — the same rule the keyed client applies to the metered allowance.
      //
      // Its own message, not the keyed client's. This one lands in a run record's
      // `creation.stopDetail`, and this ceiling is PER CANDIDATE: hitting it bounds one wallet's
      // creation window and stops nothing else, so "the run stopped early" would contradict the
      // `completed: true` in the same file, and `--max-requests` is a keyed lever that cannot move
      // it.
      if (this.#issued >= this.#ceiling) throw new CeilingReached(this.#ceiling, label, RPC_CEILING_REMEDY);

      const wait = this.#minIntervalMs - (Date.now() - this.#lastStartedAt);
      if (this.#lastStartedAt !== 0 && wait > 0) await this.#sleep(wait);

      this.#issued += 1;
      this.#lastStartedAt = Date.now();
      this.#onRequest?.(label);

      try {
        // `#endpoint.url` is used HERE and nowhere else in this module. On Helius it carries the
        // key in a query parameter, so every message below names `#endpoint.label` instead —
        // the same host with no credential in it.
        const response = await this.#fetch(this.#endpoint.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        if (response.status === 429 || response.status >= 500) {
          this.#shedEvents += 1;
          lastFailure = new Error(`HTTP ${response.status} from ${this.#endpoint.label} on ${label}`);
          if (attempt < this.#maxRetries) {
            await this.#sleep(this.#backoffMs * 2 ** attempt);
            continue;
          }
          throw lastFailure;
        }
        // A 401 is the credential, not the query, and it is the one non-shed status worth its own
        // sentence: Helius answers a bad or missing key with exactly this and a plain-text body,
        // measured 2026-08-03. It is NOT retried — the allowance is not what is wrong — and the
        // remedy travels with the endpoint because this module may not name a key variable.
        if (response.status === 401 || response.status === 403) {
          throw new RpcCredentialRejected(response.status, this.#endpoint.label, label, this.#endpoint.authRemedy);
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${this.#endpoint.label} on ${label}`);

        const parsed = await response.json();
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        /** @type {RpcEntry[]} */
        const out = Array.from({ length: requests.length }, () => ({ result: null, error: null }));
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) continue;
          const r = /** @type {Record<string, unknown>} */ (row);
          // `id: null` is what a JSON-RPC server sends when it could not even read the request —
          // Helius returns it for an unknown method. Slot 0 is the only sane home for it in a
          // single-request envelope, which is the only shape it can arrive in.
          const id = typeof r['id'] === 'number' ? r['id'] : 0;
          if (id < 0 || id >= out.length) continue;
          const rawError = r['error'];
          const error =
            typeof rawError === 'object' && rawError !== null
              ? {
                  code: Number(/** @type {Record<string, unknown>} */ (rawError)['code'] ?? 0),
                  message: String(/** @type {Record<string, unknown>} */ (rawError)['message'] ?? 'unspecified'),
                }
              : null;
          out[id] = { result: r['result'] ?? null, error };
        }
        return out;
      } catch (cause) {
        if (cause instanceof CeilingReached) throw cause;
        // A refused credential is the endpoint's considered answer about the KEY, not a transient
        // fault, so it leaves immediately rather than being retried three times over ~35 seconds
        // to be refused three more times. It cannot fire on the keyless endpoint — that host takes
        // no credential — so this narrows the retry rule without changing the keyless walk.
        if (cause instanceof RpcCredentialRejected) throw cause;
        lastFailure = cause;
        if (attempt >= this.#maxRetries) break;
        await this.#sleep(this.#backoffMs * 2 ** attempt);
      }
    }
    throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
  }
}

/**
 * @typedef {object} CreationWalkBounds
 * @property {number} maxSignaturePages Pages of `getSignaturesForAddress`, 1000 signatures each.
 * @property {number} maxTransactions   Transactions inspected with `getTransaction`.
 * @property {number} txBatchSize       1..8.
 */

/**
 * @typedef {object} CreationWalkResult
 * @property {import('./creation.mjs').CreateRecord[]} creates Every pump.fun creation seen, by any
 *   creator. Filtering to the wallet is {@link import('./creation.mjs').mergeHistories}'s job.
 * @property {Map<string, import('./creation.mjs').CurveState>} curves Curve state by mint.
 * @property {import('./creation.mjs').CoveredWindow} covered
 * @property {number} pages
 * @property {number} signaturesScanned
 * @property {number} signaturesSucceeded
 * @property {number} transactionsInspected
 * @property {number} unresolvedTransactions Transactions the endpoint never returned. Coverage
 *   inside the window is only exact when this is zero, so it travels with the result.
 * @property {number} curvesUnread Creations whose bonding-curve account could not be read. Their
 *   bonded status falls back to the ownership listing's own `complete` flag in
 *   {@link import('./creation.mjs').mergeHistories}, and only where that has no row either is the
 *   launch undecidable — at which point the reading is UNMEASURED rather than a rejection.
 * @property {'index-exhausted' | 'page-cap' | 'transaction-cap' | 'request-ceiling' | 'upstream-error' | 'credit-ceiling'} stopReason
 *   Why the walk stopped. `index-exhausted` is the only value for which `covered` spans the
 *   wallet's whole history; every other value means the window is a ceiling, and a caller that
 *   reads the create count as a lifetime figure under one of them is wrong in the same direction as
 *   the vendor's sliding "lifetime" window. `credit-ceiling` reaches only
 *   {@link readCreatedHistoryIndexed}, whose provider bills by rows returned rather than by
 *   request; it is a ceiling like any other and carries no additional meaning.
 * @property {string | null} stopDetail The upstream message, when `stopReason` is `upstream-error`,
 *   or the ceiling's own message when `request-ceiling` threw. It is persisted verbatim in the run
 *   record, so it must describe THIS walk's ceiling — a per-candidate bound — and never claim the
 *   run stopped.
 */

/**
 * Recover a wallet's launch history from **create transactions**, keylessly and under an explicit
 * ceiling.
 *
 * ## The shape of the walk, and why it is this shape
 *
 * `getSignaturesForAddress` returns *referencing* transactions rather than authored ones, which for
 * a pump.fun deployer means the index is dominated by other people's trades — the pump.fun buy and
 * sell instructions take the creator account, so every stranger's failed sniper attempt lands in it.
 * Measured on our subject deployer 2026-08-02: **956 of 1000 signatures carry an error**, matching
 * the 953-per-1000 the sell-side report recorded. Creations always succeed, so filtering on
 * `err === null` discards ~95% of the index for free, before a single `getTransaction` is spent.
 *
 * **That success fraction is the whole cost model, and it is not a constant.** Across the twelve
 * wallets of `runs/2026-07-29-elite.json` it ranged from 1.7% to 99.7%, so the price of a full
 * history ranged from about 170 requests to about 127,000 — 7 minutes to 84 hours at the measured
 * 0.42 requests/second. A caller cannot assume this walk is cheap for the next wallet because it
 * was cheap for the last one, which is why both bounds are arguments with no default and why the
 * result reports which one bit.
 *
 * ## The ceiling, stated rather than left to truncate silently
 *
 * The walk covers a **contiguous window backwards from now**, and `covered.fromMs` is where it
 * stopped — or `null` when it stopped before finishing even its first signature page, which is the
 * normal case for a busy wallet under a 100-request ceiling against 1,000-entry pages. It is not a
 * sample and not a best-effort: inside the window every creation is found,
 * outside it none is. `stopReason` distinguishes reaching the wallet's genesis
 * (`index-exhausted`, so the window is the whole history) from hitting either cap. A caller that
 * ignores this and reads `creates.length` as a lifetime launch count gets a number that shrinks as
 * the wallet gets busier, which is the same class of error as the vendor's sliding "lifetime"
 * window.
 *
 * @param {SolanaRpcClient} rpc
 * @param {string} wallet
 * @param {CreationWalkBounds} bounds
 * @returns {Promise<CreationWalkResult>}
 */
export async function readCreatedHistory(rpc, wallet, bounds) {
  const batchSize = Math.max(1, Math.min(8, bounds.txBatchSize));

  /** @type {import('./creation.mjs').CreateRecord[]} */
  const creates = [];
  /** @type {Map<string, import('./creation.mjs').CurveState>} */
  const curves = new Map();

  let pages = 0;
  let signaturesScanned = 0;
  let signaturesSucceeded = 0;
  let transactionsInspected = 0;
  let unresolvedTransactions = 0;
  let toMs = 0;
  // NULL, not 0. `0` is a real instant — 1970 — and a consumer comparing against it reads a walk
  // that covered nothing as a walk that covered everything since the epoch. That is not
  // hypothetical: it deleted 29 of one wallet's 30 launches in a live run. "Covered nothing" has to
  // be representable, and the type makes a consumer that ignores it a compile error.
  /** @type {number | null} */
  let fromMs = null;
  /** @type {'index-exhausted' | 'page-cap' | 'transaction-cap' | 'request-ceiling' | 'upstream-error'} */
  let stopReason = 'index-exhausted';
  /** @type {string | null} */
  let stopDetail = null;
  /** @type {string | undefined} */
  let before;

  // A ceiling hit is a stop, not a failure. Throwing here would discard every create already paid
  // for — the same mistake the screen's own `emit` path exists to avoid — and would leave the
  // caller unable to tell a bounded window from an error.
  try {
    walk: while (pages < bounds.maxSignaturePages) {
      const params = [wallet, { limit: 1000, ...(before === undefined ? {} : { before }) }];
      // A NULL IS RETRY, NEVER ABSENT. `call` returns null both when the public RPC sheds load and
      // when the JSON-RPC envelope carries an `error` instead of a `result`, and neither means the
      // index ended. Reading one as the end of the index would record page 2 of 200 as the wallet's
      // whole history under `index-exhausted` — a ceiling presented as a measurement, which is the
      // one output this lane exists to make impossible. Only an ARRAY resolves a page; a genuinely
      // empty array is a real end of index, an unresolved page ends the walk on `upstream-error`.
      let page = await rpc.call('getSignaturesForAddress', params);
      if (!Array.isArray(page)) page = await rpc.call('getSignaturesForAddress', params);
      if (!Array.isArray(page)) {
        stopReason = 'upstream-error';
        stopDetail =
          'getSignaturesForAddress returned no result, and the one retry returned none either. ' +
          'A null from this endpoint is load-shedding, so the index is NOT known to have ended here.';
        break;
      }
      pages += 1;
      if (page.length === 0) break;

      /** @type {{ signature: string, blockTime: number, err: unknown }[]} */
      const rows = [];
      for (const entry of page) {
        if (typeof entry !== 'object' || entry === null) continue;
        const r = /** @type {Record<string, unknown>} */ (entry);
        if (typeof r['signature'] !== 'string') continue;
        rows.push({
          signature: r['signature'],
          blockTime: typeof r['blockTime'] === 'number' ? r['blockTime'] : 0,
          err: r['err'] ?? null,
        });
      }
      // A non-empty page none of whose entries carries a signature is a shape we do not understand,
      // not an exhausted index — the same distinction the null check above draws.
      if (rows.length === 0) {
        stopReason = 'upstream-error';
        stopDetail = `getSignaturesForAddress served ${page.length} row(s) carrying no signature`;
        break;
      }

      const newest = rows[0];
      const oldest = rows[rows.length - 1];
      if (newest === undefined || oldest === undefined) break;
      if (toMs === 0) toMs = newest.blockTime * 1000;
      before = oldest.signature;

      signaturesScanned += rows.length;
      // Creations always succeed, so a failed signature can be discarded without being fetched.
      // On a busy deployer that is ~95% of the index, and it is the only reason this walk is
      // affordable at all.
      const succeeded = rows.filter((r) => r.err === null);
      signaturesSucceeded += succeeded.length;

      for (let i = 0; i < succeeded.length; i += batchSize) {
        if (transactionsInspected >= bounds.maxTransactions) {
          stopReason = 'transaction-cap';
          break walk;
        }
        // Stop while there is still budget to CLASSIFY what has been found. A launch whose curve
        // was never read counts as not-bonded, so a walk that spends its last request finding one
        // more creation has bought a launch it must then score as a failure — it deflates the very
        // rate it was widening. Reserve one request per 100 creations, plus one.
        if (rpc.remaining() <= Math.ceil(creates.length / 100) + 1) {
          stopReason = 'request-ceiling';
          break walk;
        }
        const slice = succeeded.slice(i, i + batchSize);
        const results = await rpc.batch(
          slice.map((sig) => ({
            method: 'getTransaction',
            params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
          })),
        );
        transactionsInspected += slice.length;
        for (const tx of results) {
          if (tx === null) {
            unresolvedTransactions += 1;
            continue;
          }
          const create = parseCreateTransaction(tx);
          if (create !== null) creates.push(create);
        }
      }

      // Only advance the covered floor once the whole page has been inspected. A page abandoned
      // half-way must not widen the window it did not actually cover — and until one page is
      // inspected whole, the floor stays `null`, i.e. the window is EMPTY rather than infinite.
      fromMs = oldest.blockTime * 1000;
      if (rows.length < 1000) break;
      if (pages >= bounds.maxSignaturePages) stopReason = 'page-cap';
    }
  } catch (cause) {
    // Same rule for an upstream failure as for the ceiling: keep what was paid for, label why it
    // stopped, and let the caller decide. What must never happen is a short window presented as a
    // measured history.
    stopReason = cause instanceof CeilingReached ? 'request-ceiling' : 'upstream-error';
    stopDetail = cause instanceof Error ? cause.message : String(cause);
  }

  // Curve state for every creation found, 100 accounts per request. This settles whether each
  // launch bonded AND whether its creator record has since moved, from the same bytes.
  //
  // Guarded like the walk itself. A ceiling reached here used to throw away every creation already
  // paid for — the walk's most expensive output — to fail on its cheapest step.
  try {
    for (let i = 0; i < creates.length; i += 100) {
      const slice = creates.slice(i, i + 100);
      const accounts = await rpc.call('getMultipleAccounts', [
        slice.map((c) => c.bondingCurve),
        { encoding: 'base64' },
      ]);
      const value =
        typeof accounts === 'object' && accounts !== null
          ? /** @type {Record<string, unknown>} */ (accounts)['value']
          : null;
      if (!Array.isArray(value)) continue;
      value.forEach((account, k) => {
        const mint = slice[k]?.mint;
        if (mint === undefined) return;
        if (typeof account !== 'object' || account === null) return;
        const data = /** @type {Record<string, unknown>} */ (account)['data'];
        const encoded = Array.isArray(data) && typeof data[0] === 'string' ? data[0] : '';
        const state = readCurveState(encoded);
        if (state !== null) curves.set(mint, state);
      });
    }
  } catch {
    // Deliberately swallowed: `curvesUnread` below reports exactly how many launches this cost,
    // and it must be visible because an unread curve counts as NOT bonded, which deflates the
    // completion rate. A silent deflation is the failure mode this whole lane exists to remove.
  }

  return {
    creates,
    curves,
    // `pages > 0` matters: a zero page bound would otherwise report an untouched index as
    // exhausted, i.e. claim a whole history it never looked at.
    covered: { fromMs, toMs, exhausted: stopReason === 'index-exhausted' && pages > 0 },
    pages,
    signaturesScanned,
    signaturesSucceeded,
    transactionsInspected,
    unresolvedTransactions,
    curvesUnread: creates.length - curves.size,
    stopReason,
    stopDetail,
  };
}

// --- the indexed creation walk (Helius) --------------------------------------------------------

/**
 * What Helius charges for a page of `getTransactionsForAddress` in `full` mode: **10 credits per
 * 100 transactions RETURNED, rounded up, with a 10-credit minimum** (their billing documentation,
 * read 2026-08-03).
 *
 * Two consequences the walk is built around. The price is a property of the **answer**, so it
 * cannot be known before the page arrives — which is why the walk reserves a full page's worth
 * against the ceiling before starting one and charges the actual cost after. And a page of 1,000
 * costs 100 credits flat, so the credit ceiling and the page ceiling are the same bound in two
 * units; `thresholds.json` → `creation_walk_helius` states them that way rather than pretending
 * they are independent.
 *
 * @param {number} transactions
 * @returns {number}
 */
export function creditsForTransactions(transactions) {
  return Math.max(10, Math.ceil(Math.max(0, transactions) / 100) * 10);
}

/**
 * @typedef {object} IndexedWalkBounds
 * @property {number} maxPages     Pages of `getTransactionsForAddress`, `pageLimit` each.
 * @property {number} pageLimit    1..1000. The endpoint refuses more — measured: `limit: 5000`
 *   returns HTTP 200 carrying `{"error":{"code":-32603,"message":"Bad request: Invalid limit…"}}`.
 * @property {number} maxTransactions Transactions parsed, across all pages.
 * @property {number} maxCredits   Vendor credits this candidate may spend. The binding bound.
 */

/**
 * Recover a wallet's launch history from **create transactions**, through a provider that indexes
 * transactions by address — the same measurement as {@link readCreatedHistory} over a cheaper
 * index.
 *
 * ## Why this is not the same walk with a different host
 *
 * {@link readCreatedHistory} exists because the only *keyless* index reaching a create transaction
 * is the wallet's own signature index, which for a pump.fun deployer is ~95% strangers' failed
 * trades. It pages signatures, discards the failures for free, and then spends one `getTransaction`
 * per survivor — so its cost is the wallet's SUCCEEDED signature count, one request each, and that
 * ranged 170 to 127,000 requests across the twelve wallets of `runs/2026-07-29-elite.json`.
 *
 * `getTransactionsForAddress` collapses both halves into one call: `filters: { status: 'succeeded' }`
 * applies the same filter server-side, and `transactionDetails: 'full'` returns the transaction
 * bodies the other walk paid for one at a time. **Measured 2026-08-03 over those same twelve
 * wallets, every one of them walked to exhaustion: 125,981 succeeded transactions in 136 full pages.**
 * The subject deployer's whole history is 7,791 transactions in **9 pages, 793 credits and 12
 * requests end to end** — 8 data pages at 780 credits, one further page that returns no rows and
 * proves exhaustion by answering `paginationToken: null` at the 10-credit minimum, and 3
 * `getMultipleAccounts` curve reads for its 247 creations at 1 credit each — against 7,166 requests
 * and a measured ~287 minutes on the keyless route.
 *
 * **The parsers are untouched and that is checked rather than assumed.** `full` + `jsonParsed`
 * returns `getTransaction`'s own envelope — `{ transaction: { signatures, message }, meta, blockTime }`
 * — so {@link parseCreateTransaction} and {@link readCurveState} read it unchanged. Verified on the
 * `maxxing` create transaction, where the two routes agree field for field on every value the
 * parser reads (`CREATION-DERIVED.md` § "The indexed route").
 *
 * ## What bounds it, and in which unit
 *
 * Credits, not requests. The provider bills by transactions returned, so a busy wallet is expensive
 * in a way a request count cannot see: 9 pages for the subject, 50 for the busiest wallet measured.
 * `maxCredits` is therefore the real ceiling and `maxPages` is the same bound restated for the loop.
 * A page is only STARTED when a whole page's worst-case price still fits, so the ceiling is exact
 * and a page is never abandoned half-paid.
 *
 * ## The coverage rules, unchanged in substance and re-derived against this endpoint's shapes
 *
 * - **Only a well-formed result advances anything.** An `error` envelope (HTTP 200 on this
 *   provider) is a considered answer, so the walk stops on `upstream-error` — it is never read as
 *   an exhausted index. An absent result is load-shedding and is retried by the client.
 * - **Exhaustion is proved by the provider, not inferred.** `paginationToken: null` on a successful
 *   page is the only thing that sets `index-exhausted`. Verified: a query over an empty slot range
 *   returns `{"data":[],"paginationToken":null}`, and a corrupt token returns an `error` envelope
 *   rather than a quiet empty page.
 * - **`covered.fromMs` is `null` until a page has been read whole**, and `null` means covered
 *   NOTHING — never "since the epoch". `mergeHistories` treats an absent floor as an EMPTY window.
 * - **The order is ascending**, so the covered window grows forwards from the wallet's genesis and
 *   a truncated walk leaves the RECENT end to the ownership listing. That is the opposite end from
 *   the keyless walk's window and it is the better one to lose: ownership is least wrong about
 *   tokens the wallet has not yet had time to hand on.
 *
 * @param {SolanaRpcClient} rpc
 * @param {string} wallet
 * @param {IndexedWalkBounds} bounds
 * @returns {Promise<CreationWalkResult>}
 */
export async function readCreatedHistoryIndexed(rpc, wallet, bounds) {
  const pageLimit = Math.max(1, Math.min(1000, bounds.pageLimit));
  const worstCasePageCredits = creditsForTransactions(pageLimit);

  /** @type {import('./creation.mjs').CreateRecord[]} */
  const creates = [];
  /** @type {Map<string, import('./creation.mjs').CurveState>} */
  const curves = new Map();

  let pages = 0;
  let transactionsInspected = 0;
  let toMs = 0;
  // NULL, not 0 — the same rule and the same reason as the keyless walk. `0` reads as 1970, i.e. as
  // a window containing every timestamp, and that deleted 29 of one wallet's 30 launches in a live
  // run. Only a page read WHOLE moves it.
  /** @type {number | null} */
  let fromMs = null;
  /** @type {'index-exhausted' | 'page-cap' | 'transaction-cap' | 'request-ceiling' | 'upstream-error' | 'credit-ceiling'} */
  let stopReason = 'index-exhausted';
  /** @type {string | null} */
  let stopDetail = null;
  /** @type {string | undefined} */
  let paginationToken;

  try {
    while (pages < bounds.maxPages) {
      if (transactionsInspected >= bounds.maxTransactions) {
        stopReason = 'transaction-cap';
        break;
      }
      // Reserve a WHOLE page's worst-case price before starting one. Checking afterwards would let
      // the last page overshoot the ceiling by up to a page, and a credit ceiling that can be
      // exceeded is not a ceiling. Reserve the curve reads too — see the classification note below.
      //
      // Reserved against `creates.length + pageLimit`, i.e. the WORST CASE AFTER the page about to
      // be started, not the count before it. Against the pre-fetch count a page whose rows are all
      // creations under-reserves by up to `pageLimit / 100` reads, leaving those mints unclassified
      // — and an unread curve counts as NOT bonded, which deflates the very rate this walk was
      // widened to measure. `CREATION-DERIVED.md` §4 owns the invariant: a walk must never spend its
      // last unit finding one more creation it then has to score as a failure.
      const worstCaseCreates = creates.length + pageLimit;
      if (rpc.creditsRemaining() < worstCasePageCredits + creditsForCurveReads(worstCaseCreates)) {
        stopReason = 'credit-ceiling';
        break;
      }
      // Same reservation in requests, so whichever ceiling is tighter still stops the walk cleanly
      // rather than throwing part-way through a page.
      if (rpc.remaining() <= curveReadRequests(worstCaseCreates)) {
        stopReason = 'request-ceiling';
        break;
      }

      const { result, error } = await rpc.callDetailed('getTransactionsForAddress', [
        wallet,
        {
          transactionDetails: 'full',
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
          sortOrder: 'asc',
          limit: pageLimit,
          filters: { status: 'succeeded' },
          ...(paginationToken === undefined ? {} : { paginationToken }),
        },
      ]);

      // An `error` envelope is the provider's considered answer and arrives on HTTP 200 here. It is
      // NOT an exhausted index and it is not retried — asking again spends credits to be told the
      // same thing. The walk stops and says which, so a bounded window can never be read as a
      // history.
      if (error !== null) {
        stopReason = 'upstream-error';
        stopDetail =
          `getTransactionsForAddress answered with a JSON-RPC error (${error.code}): ${error.message}. ` +
          'That is the endpoint\'s considered answer, not load-shedding, so the index is NOT known to ' +
          'have ended here.';
        break;
      }
      // A null result IS load-shedding — the client has already retried it under its own backoff —
      // and it still does not mean the index ended. Same rule as the keyless walk.
      if (typeof result !== 'object' || result === null) {
        stopReason = 'upstream-error';
        stopDetail =
          'getTransactionsForAddress returned no result, and the client\'s retries returned none ' +
          'either. An absent result is load-shedding, so the index is NOT known to have ended here.';
        break;
      }

      const envelope = /** @type {Record<string, unknown>} */ (result);
      const rows = envelope['data'];
      if (!Array.isArray(rows)) {
        stopReason = 'upstream-error';
        stopDetail = 'getTransactionsForAddress served a result carrying no `data` array';
        break;
      }

      // Charged from what actually came back, because that is what the provider bills.
      rpc.chargeCredits(creditsForTransactions(rows.length));
      pages += 1;

      /** The provider's own statement that nothing is left. The ONLY thing that proves exhaustion. */
      const rawNext = envelope['paginationToken'];
      const next = typeof rawNext === 'string' && rawNext !== '' ? rawNext : null;

      let pageOldestMs = 0;
      let pageNewestMs = 0;
      for (const tx of rows) {
        transactionsInspected += 1;
        const blockTime = typeof tx === 'object' && tx !== null
          ? /** @type {Record<string, unknown>} */ (tx)['blockTime']
          : undefined;
        if (typeof blockTime === 'number' && Number.isFinite(blockTime) && blockTime > 0) {
          const ms = blockTime * 1000;
          if (pageOldestMs === 0 || ms < pageOldestMs) pageOldestMs = ms;
          if (ms > pageNewestMs) pageNewestMs = ms;
        }
        const create = parseCreateTransaction(tx);
        if (create !== null) creates.push(create);
      }

      // Ascending order, so the FLOOR is set once — by the first page read whole — and the CEILING
      // advances with every page after it. Both only move on a page that was read entire, which is
      // every page here: unlike the keyless walk there is no per-transaction request to abandon
      // half-way, so a page either arrived or did not.
      if (pageOldestMs > 0 && (fromMs === null || pageOldestMs < fromMs)) fromMs = pageOldestMs;
      if (pageNewestMs > toMs) toMs = pageNewestMs;

      if (next === null) break;
      paginationToken = next;
      if (pages >= bounds.maxPages) stopReason = 'page-cap';
    }
  } catch (cause) {
    // A REFUSED CREDENTIAL IS NOT A PROPERTY OF THIS WALLET, so it must not become this wallet's
    // reading. Degrading it here would give every remaining candidate a silent ownership-only
    // history under a record still claiming `historySource: creation-derived`, while the keyed
    // MadeOnSol allowance drained one profile at a time. It is rethrown so the run stops on the
    // first one, with the allowance it has not yet spent still unspent.
    if (cause instanceof RpcCredentialRejected) throw cause;
    // Same rule as the keyless walk: keep what was paid for, label why it stopped, let the caller
    // decide. What must never happen is a short window presented as a measured history.
    stopReason = cause instanceof CeilingReached ? 'request-ceiling' : 'upstream-error';
    stopDetail = cause instanceof Error ? cause.message : String(cause);
  }

  // Curve state for every creation found, 100 accounts per request — identical to the keyless walk,
  // and reserved for above so a walk cannot spend its last credit finding a launch it then has to
  // score as a failure.
  try {
    for (let i = 0; i < creates.length; i += 100) {
      const slice = creates.slice(i, i + 100);
      if (rpc.creditsRemaining() < 1 || rpc.remaining() < 1) break;
      rpc.chargeCredits(1);
      const accounts = await rpc.call('getMultipleAccounts', [
        slice.map((c) => c.bondingCurve),
        { encoding: 'base64' },
      ]);
      const value =
        typeof accounts === 'object' && accounts !== null
          ? /** @type {Record<string, unknown>} */ (accounts)['value']
          : null;
      if (!Array.isArray(value)) continue;
      value.forEach((account, k) => {
        const mint = slice[k]?.mint;
        if (mint === undefined) return;
        if (typeof account !== 'object' || account === null) return;
        const data = /** @type {Record<string, unknown>} */ (account)['data'];
        const encoded = Array.isArray(data) && typeof data[0] === 'string' ? data[0] : '';
        const state = readCurveState(encoded);
        if (state !== null) curves.set(mint, state);
      });
    }
  } catch (cause) {
    // Same exception as above and for the same reason: a credential the endpoint refuses says
    // nothing about this wallet, so it may not be absorbed into `curvesUnread` — which would read
    // as "these launches are not bonded" for every candidate after it.
    if (cause instanceof RpcCredentialRejected) throw cause;
    // Otherwise deliberately swallowed, exactly as in the keyless walk: `curvesUnread` reports what
    // it cost, and it must be visible because an unread curve counts as NOT bonded.
  }

  return {
    creates,
    curves,
    covered: { fromMs, toMs, exhausted: stopReason === 'index-exhausted' && pages > 0 },
    pages,
    // The provider applied `status: succeeded` server-side, so every transaction it returned is one
    // the keyless walk would have SCANNED and then also FETCHED. Reporting the same number under
    // both names is the truth about this route rather than a placeholder: nothing was scanned and
    // discarded, so there is no third figure to report.
    signaturesScanned: transactionsInspected,
    signaturesSucceeded: transactionsInspected,
    transactionsInspected,
    // Structurally zero on this route, and that is a real claim rather than an omission: a page
    // arrives whole or not at all, so there is no per-transaction request that can go unanswered
    // while the walk carries on. It is what lets `mergeHistories` treat the covered window as
    // exact — see `windowExact` there.
    unresolvedTransactions: 0,
    curvesUnread: creates.length - curves.size,
    stopReason,
    stopDetail,
  };
}

/**
 * Requests the curve-classification pass will need for `n` creations, at 100 accounts each.
 *
 * Reserved BEFORE the walk starts another page, for the reason `CREATION-DERIVED.md` §4 records: a
 * walk that spends its last unit finding one more creation has bought a launch it must then score
 * as not-bonded, which deflates the very rate the walk was widening.
 *
 * @param {number} n
 * @returns {number}
 */
function curveReadRequests(n) {
  return Math.ceil(n / 100) + 1;
}

/**
 * Credits the curve-classification pass will need for `n` creations. `getMultipleAccounts` is a
 * standard RPC method and costs 1 credit, so this is the request count.
 *
 * @param {number} n
 * @returns {number}
 */
function creditsForCurveReads(n) {
  return curveReadRequests(n);
}

/** Lamports in one SOL. Named so the conversion is never a bare literal in an arithmetic line. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * @typedef {object} TransactionCosts
 * What one transaction cost, recovered exactly from the chain.
 *
 * @property {string} signature
 * @property {number} feeSol      `meta.fee` — **base plus priority**, in SOL. Exact, and charged to
 *   {@link TransactionCosts.feePayer}.
 * @property {string | null} feePayer `accountKeys[0]`. For a bundled transaction this is NOT the
 *   trader — CLAUDE.md's fee-payer counter-trap — which is why it is carried rather than assumed.
 * @property {Map<string, number>} solOutByWallet `(preBalance − postBalance) / 1e9` per account, so
 *   a positive number is SOL that LEFT that account. This is the wallet's real lamport change and it
 *   already nets the swap, the venue fee, rent, its own fee if it is the payer, and **any tip paid
 *   inside this transaction**.
 */

/**
 * Read one transaction's exact costs out of an RPC result.
 *
 * Serves both routes — a `getTransaction` result and one element of a `getBlock`'s `transactions`
 * array have the same `{ transaction, meta }` shape — so there is one parser and the two routes
 * cannot disagree.
 *
 * **The index check is load-bearing, not defensive tidiness.** `preBalances`/`postBalances` are
 * indexed over the transaction's WHOLE account list, and for a versioned transaction that list is
 * the static keys plus the ones loaded from an address table. `jsonParsed` encoding returns the
 * complete list; a plainer encoding returns only the static half. Reading a balance at an index the
 * key list does not cover would attribute a stranger's lamport change to our entrant — a wrong
 * number rather than a missing one — so a length disagreement refuses the transaction instead.
 *
 * A transaction carrying an error is refused too. Every transaction this walk is pointed at came
 * from a FILL, so it succeeded; an `err` means the row is not what we think it is.
 *
 * @param {unknown} tx
 * @returns {TransactionCosts | null} `null` when the shape is not one this can price exactly.
 */
export function parseTransactionCosts(tx) {
  if (typeof tx !== 'object' || tx === null) return null;
  const root = /** @type {Record<string, unknown>} */ (tx);

  const meta = /** @type {Record<string, unknown> | null | undefined} */ (root['meta']);
  if (meta === undefined || meta === null) return null;
  if (meta['err'] !== null && meta['err'] !== undefined) return null;

  const fee = meta['fee'];
  const pre = meta['preBalances'];
  const post = meta['postBalances'];
  if (typeof fee !== 'number' || !Array.isArray(pre) || !Array.isArray(post)) return null;
  if (pre.length !== post.length) return null;

  const transaction = /** @type {Record<string, unknown> | null | undefined} */ (root['transaction']);
  if (transaction === undefined || transaction === null) return null;
  const message = /** @type {Record<string, unknown> | null | undefined} */ (transaction['message']);
  if (message === undefined || message === null) return null;
  const accountKeys = message['accountKeys'];
  if (!Array.isArray(accountKeys)) return null;
  if (accountKeys.length !== pre.length) return null;

  /** @type {Map<string, number>} */
  const solOutByWallet = new Map();
  /** @type {string | null} */
  let feePayer = null;
  for (let i = 0; i < accountKeys.length; i++) {
    const entry = accountKeys[i];
    const pubkey =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? /** @type {Record<string, unknown>} */ (entry)['pubkey']
          : undefined;
    if (typeof pubkey !== 'string') return null;
    const before = pre[i];
    const after = post[i];
    if (typeof before !== 'number' || typeof after !== 'number') return null;
    if (i === 0) feePayer = pubkey;
    // An account can appear once only; a duplicate key would make the delta ambiguous.
    if (solOutByWallet.has(pubkey)) return null;
    solOutByWallet.set(pubkey, (before - after) / LAMPORTS_PER_SOL);
  }

  const signatures = transaction['signatures'];
  const signature = Array.isArray(signatures) && typeof signatures[0] === 'string' ? signatures[0] : '';
  if (signature === '') return null;

  return { signature, feeSol: fee / LAMPORTS_PER_SOL, feePayer, solOutByWallet };
}

/**
 * @typedef {object} CostWalkResult
 * @property {Map<string, TransactionCosts>} priced  By signature.
 * @property {number} requests            RPC requests this walk issued, retries included.
 * @property {number} unresolved          Transactions the endpoint never resolved, or whose shape
 *   {@link parseTransactionCosts} refused. Neither is "cost zero" — see the caller.
 * @property {number} viaBlock            Priced from a whole-block read.
 * @property {number} viaTransaction      Priced one `getTransaction` at a time.
 * @property {boolean} blockRouteTried
 * @property {string | null} blockRouteNote Why the block route was not used, when it was not.
 * @property {boolean} stoppedForBudget   The per-candidate RPC ceiling ended the walk early.
 */

/**
 * Price a launch's create slot — and, optionally, the rest of its window — from the chain.
 *
 * ## What this recovers, and what it cannot
 *
 * Two exact quantities per transaction, both from one response: the fee (**base plus priority**,
 * `meta.fee`) and every account's real lamport change. Together with the fill tape's swap-quote SOL
 * that gives what an entrant paid over and above the position it took — the venue fee, the rent, the
 * execution difference, and **any tip paid inside its own transaction**.
 *
 * **A landing tip paid in a SEPARATE transaction of the same bundle is not recoverable from this,
 * and it is not measured anywhere in this repo's ground truth either. Its absence biases every
 * figure built on this walk OPTIMISTICALLY — entry looks cheaper than it was.** That caveat travels
 * with the numbers rather than living in a document: `entry.mjs` puts it on the score, `render.mjs`
 * prints it beside the distribution, and the run record persists it in `entry.caveats`.
 *
 * ## Two routes, and why the cheap one is tried behind a fallback
 *
 * `getBlock(slot, { transactionDetails: 'full' })` returns **every transaction in the create slot in
 * one request**, collapsing the create-slot leg from a handful of `getTransaction` calls to one. It
 * has never been exercised against this endpoint from this repo — what is known is that `getBlock`
 * works here for signature listing; what is unknown is whether the public endpoint serves *full*
 * blocks to this client and what a busy mainnet slot's payload costs. So it is **probed, once per
 * launch, behind a fallback**: anything other than a usable block latches the walk onto the
 * per-signature route and records why. The route that ran reaches the run record, so a saved run
 * says which one paid for its numbers.
 *
 * Note the block route buys request count and nothing else. It does **not** reach out-of-transaction
 * tips: attributing a sibling transaction in the same slot to the same bundle is an inference the
 * chain does not support, and this walk makes no inference it cannot prove.
 *
 * ## Pacing is the creation walk's, and it is not negotiable
 *
 * The same client class, the same 2.5s, the same one-request-in-flight queue — `api.mainnet-beta`
 * rate-limits **globally across methods**, so this leg is serialised after the creation walk rather
 * than run beside it, and batching is measured actively harmful (CLAUDE.md, 2026-08-02).
 *
 * @param {SolanaRpcClient} rpc
 * @param {object} opts
 * @param {readonly import('./measure.mjs').WalletTransaction[]} opts.transactions What to price.
 * @param {number} opts.createSlot The launch's create slot — the only slot the block route applies to.
 * @param {boolean} [opts.preferBlock] Try the whole-block read first. Default `true`.
 * @returns {Promise<CostWalkResult>}
 */
export async function readCreateSlotCosts(rpc, opts) {
  const preferBlock = opts.preferBlock ?? true;
  const issuedBefore = rpc.issued();
  /** @type {Map<string, TransactionCosts>} */
  const priced = new Map();
  let unresolved = 0;
  let viaBlock = 0;
  let viaTransaction = 0;
  let blockRouteTried = false;
  /** @type {string | null} */
  let blockRouteNote = null;
  let stoppedForBudget = false;

  const inCreateSlot = opts.transactions.filter((t) => t.slot === opts.createSlot);

  try {
    // The block route is only worth a request when it can replace more than one, and it can only
    // ever serve the create slot — the rest of a window is spread over ~150 slots, where one block
    // per slot would cost far more than one transaction per transaction.
    if (preferBlock && inCreateSlot.length >= 2) {
      blockRouteTried = true;
      const block = await rpc.call('getBlock', [
        opts.createSlot,
        {
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ]);
      const rows =
        typeof block === 'object' && block !== null
          ? /** @type {Record<string, unknown>} */ (block)['transactions']
          : null;
      if (!Array.isArray(rows)) {
        blockRouteNote =
          'getBlock did not serve a full block for the create slot, so every transaction was ' +
          'priced individually instead. A null here is load-shedding or an unsupported request, ' +
          'never evidence that the slot was empty.';
      } else {
        const wanted = new Set(inCreateSlot.map((t) => t.tx));
        for (const row of rows) {
          const costs = parseTransactionCosts(row);
          if (costs === null || !wanted.has(costs.signature)) continue;
          priced.set(costs.signature, costs);
          viaBlock += 1;
        }
        if (viaBlock === 0) {
          blockRouteNote =
            'getBlock served a block carrying none of the create slot\'s own transactions in a ' +
            'shape this build can price, so they were priced individually instead.';
        }
      }
    } else if (preferBlock) {
      blockRouteNote =
        'the block route was not attempted: it replaces one request per create-slot transaction ' +
        'and there were fewer than two to replace.';
    }

    for (const target of opts.transactions) {
      if (priced.has(target.tx)) continue;
      if (rpc.remaining() < 1) {
        stoppedForBudget = true;
        break;
      }
      // A NULL IS RETRY, NEVER ABSENT — the same rule the creation walk applies. The public RPC
      // sheds load with a null result rather than an error, and reading one as "this transaction
      // cost nothing" would book a free entry into a distribution about what entry costs.
      let result = await rpc.call('getTransaction', [
        target.tx,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      if (result === null && rpc.remaining() > 0) {
        result = await rpc.call('getTransaction', [
          target.tx,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
        ]);
      }
      const costs = parseTransactionCosts(result);
      if (costs === null) {
        unresolved += 1;
        continue;
      }
      priced.set(target.tx, costs);
      viaTransaction += 1;
    }
  } catch (cause) {
    // A ceiling hit is a stop, not a failure: what was already paid for is kept and the caller is
    // told the walk is short, exactly as the creation walk does it.
    if (cause instanceof CeilingReached) stoppedForBudget = true;
    else throw cause;
  }

  return {
    priced,
    requests: rpc.issued() - issuedBefore,
    unresolved,
    viaBlock,
    viaTransaction,
    blockRouteTried,
    blockRouteNote,
    stoppedForBudget,
  };
}
