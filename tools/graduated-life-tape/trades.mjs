/**
 * Reading `swap-api.pump.fun/v2/coins/{mint}/trades`: URLs, page shapes, row normalisation and the
 * venue field. Pure — it opens no socket and is the half of this tool that unit tests can drive
 * with fixtures.
 *
 * Two properties of the endpoint everything here is built on, both from
 * `population-tape-2026-07-29/report.md` §9.2 and re-confirmed live on 2026-08-02:
 *
 * 1. **Rows come back NEWEST FIRST**, so a walk that pages through them runs *backwards* in time
 *    and reaches the create slot LAST. A truncated backwards walk is silently wrong rather than
 *    visibly wrong — it returns a plausible pile of fills whose earliest slot is merely the
 *    earliest it happened to see. Coverage must therefore be *proved*, never assumed: see
 *    {@link provesOlderThan}.
 * 2. **The cursor's timestamp component seeks.** A cursor is `<slotIndexId>-<timestampMs>` and the
 *    slot half is ignored, so {@link seekCursor} can jump to an arbitrary instant in a token's
 *    history for one request. That is what turns a whole-life walk from ~500,000 requests into
 *    thousands, and what makes the graduation bisection in `graduation.mjs` possible at all.
 *
 * The `program` field is the third: `pump` is the bonding curve, `pump_amm` is PumpSwap. The first
 * `pump_amm` fill **is** the migration to within one fill, verified on-chain against the two
 * program ids by the scout that pinned the graduation timestamps.
 */

import { SWAP_API } from './client.mjs';

/** The bonding curve. Every fill before graduation. */
export const VENUE_CURVE = 'pump';

/** PumpSwap. Every fill after graduation. */
export const VENUE_AMM = 'pump_amm';

/**
 * The largest page the endpoint serves.
 *
 * Unlike MadeOnSol's `/tokens` endpoint — whose spec claims 100 and whose real cap is 50 — this one
 * honours 100, and the committed tape was built at 100.
 */
export const PAGE_LIMIT = 100;

/**
 * Build a cursor that seeks to an instant.
 *
 * The slot component is a sentinel that sorts above every real `slotIndexId`, so the seek can never
 * be narrowed by it; the endpoint ignores it regardless, and pinning it high rather than low means
 * that if a future version *stops* ignoring it the walk over-returns rather than under-returns.
 * Over-returning is recoverable — the caller filters. Under-returning is the silent truncation this
 * whole module exists to refuse.
 *
 * @param {number} atMs Unix ms. Rows at or older than this instant are what the page will hold.
 * @returns {string}
 */
export function seekCursor(atMs) {
  return `9999999999990000000000-${Math.floor(atMs)}`;
}

/**
 * @param {string} mint
 * @param {string | null} cursor `null` for the uncursored first page — the newest fills of all.
 * @returns {string}
 */
export function tradesUrl(mint, cursor = null) {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor !== null) query.set('cursor', cursor);
  return `${SWAP_API}/v2/coins/${mint}/trades?${query.toString()}`;
}

/**
 * @typedef {object} Fill
 * @property {number} slot
 * @property {string} sid    `slotIndexId` — the endpoint's total order, and the only safe sort key.
 * @property {string} tx
 * @property {string} ts     ISO-8601, second resolution.
 * @property {number} tsMs
 * @property {string} u      The swapping wallet. **The unit of "who traded"** — never the fee payer.
 * @property {'buy' | 'sell'} k
 * @property {string} p      Venue: {@link VENUE_CURVE} or {@link VENUE_AMM}.
 * @property {string} sol
 * @property {string} base
 * @property {string} psol
 * @property {string} pusd
 */

/**
 * @typedef {object} TradePage
 * @property {Fill[]} fills
 * @property {number} rawRows       Rows the endpoint sent, before any of them failed to parse.
 * @property {boolean} recognised   Whether the body was a shape rows can be read out of **at all**.
 *   `false` with `fills: []` and `true` with `fills: []` are different findings — the first is "we
 *   do not understand the answer", the second is "the endpoint says there is nothing older". Only
 *   the second may ever terminate a backwards walk.
 * @property {boolean | null} hasMore     The endpoint's own statement, `null` if it made none.
 * @property {string | null} nextCursor
 */

/**
 * The `slotIndexId` is a fixed-width `<12-digit slot><10-digit intra-slot ordinal>`.
 *
 * Validated against the committed tape, which stores both fields: every row's first twelve digits
 * parse to exactly its recorded `slot`. Derived rather than taken from a `slot` field because the
 * endpoint does not send one.
 *
 * @param {string} sid
 * @returns {number}
 */
export function slotOf(sid) {
  return Number(sid.slice(0, 12));
}

/**
 * Normalise one endpoint row into the committed tape's row schema.
 *
 * The field names are the population tape's, not the endpoint's, and that is deliberate: a life
 * tape written in a second schema could not be concatenated with the committed window tape it
 * extends, and the first thing anyone will want to do is exactly that. `tsMs` is the one addition,
 * and it is derived rather than stored (see `writeFills` in `walk.mjs`).
 *
 * Returns `null` for a row missing anything a caller must not invent. A dropped row is counted, not
 * silently absorbed — `rawRows` above is the count before dropping.
 *
 * @param {unknown} row
 * @returns {Fill | null}
 */
export function parseFill(row) {
  if (typeof row !== 'object' || row === null) return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const sid = r['slotIndexId'];
  const tx = r['tx'];
  const ts = r['timestamp'];
  const u = r['userAddress'];
  const k = r['type'];
  const p = r['program'];
  if (typeof sid !== 'string' || sid.length < 12) return null;
  if (typeof tx !== 'string' || typeof ts !== 'string' || typeof u !== 'string') return null;
  if (k !== 'buy' && k !== 'sell') return null;
  if (typeof p !== 'string') return null;
  const slot = slotOf(sid);
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(slot) || !Number.isFinite(tsMs)) return null;
  return {
    slot,
    sid,
    tx,
    ts,
    tsMs,
    u,
    k,
    p,
    sol: str(r['amountSol']),
    base: str(r['baseAmount']),
    psol: str(r['priceSol']),
    pusd: str(r['priceUsd']),
  };
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function str(v) {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/**
 * Read one page.
 *
 * The endpoint has returned both a bare array and an object wrapping one across versions, so both
 * are accepted — but only the wrapped shape carries `pagination`, and pagination is what a walk
 * uses to terminate. An unwrapped body therefore yields `hasMore: null`, which
 * {@link provesOlderThan} treats as "no statement made" rather than as "nothing more".
 *
 * @param {unknown} body
 * @returns {TradePage}
 */
export function parseTradePage(body) {
  /** @type {unknown[] | null} */
  let rows = null;
  /** @type {boolean | null} */
  let hasMore = null;
  /** @type {string | null} */
  let nextCursor = null;

  if (Array.isArray(body)) {
    rows = body;
  } else if (typeof body === 'object' && body !== null) {
    const b = /** @type {Record<string, unknown>} */ (body);
    if (Array.isArray(b['trades'])) rows = b['trades'];
    const pagination = b['pagination'];
    if (typeof pagination === 'object' && pagination !== null) {
      const p = /** @type {Record<string, unknown>} */ (pagination);
      if (typeof p['hasMore'] === 'boolean') hasMore = p['hasMore'];
      if (typeof p['nextCursor'] === 'string') nextCursor = p['nextCursor'];
    }
  }

  if (rows === null) return { fills: [], rawRows: 0, recognised: false, hasMore: null, nextCursor: null };

  /** @type {Fill[]} */
  const fills = [];
  for (const row of rows) {
    const fill = parseFill(row);
    if (fill !== null) fills.push(fill);
  }
  return { fills, rawRows: rows.length, recognised: true, hasMore, nextCursor };
}

/**
 * Has this page **proved** the walk has reached back past `boundMs`?
 *
 * The whole point of the function. Two things establish it and nothing else does:
 *
 * - a fill strictly older than the bound is present, so the walk has demonstrably crossed it; or
 * - the endpoint states there is nothing more (`hasMore === false`), so there is nothing older to
 *   reach.
 *
 * An unrecognised body proves nothing. A recognised but empty page proves nothing on its own —
 * only its `hasMore` does. This is the same distinction the committed tape draws with
 * `meta.reached_mint`, and it is the reason four of its 239 window files are marked incomplete
 * instead of quietly short.
 *
 * @param {TradePage} page
 * @param {number} boundMs
 * @returns {boolean}
 */
export function provesOlderThan(page, boundMs) {
  if (!page.recognised) return false;
  if (page.hasMore === false) return true;
  return page.fills.some((f) => f.tsMs < boundMs);
}

/**
 * Sort fills into the committed tape's order: **ascending by `sid`**.
 *
 * The live endpoint is descending and the stored tape is ascending, and mixing the two is a trap
 * the population report calls out by name. `sid` rather than `ts` because the timestamp is
 * second-resolution and cannot order fills inside one slot — and a launch window is mostly one slot.
 *
 * @param {readonly Fill[]} fills
 * @returns {Fill[]}
 */
export function sortAscending(fills) {
  return [...fills].sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
}

/**
 * Drop duplicate fills, keeping the first seen.
 *
 * Pages overlap whenever a walk re-seeks — the bisection's probe pages are reused by the walk that
 * follows it, precisely so their cost is not paid twice — and `sid` is the endpoint's own total
 * order, so it is the identity.
 *
 * @param {readonly Fill[]} fills
 * @returns {Fill[]}
 */
export function dedupeBySid(fills) {
  /** @type {Map<string, Fill>} */
  const seen = new Map();
  for (const f of fills) if (!seen.has(f.sid)) seen.set(f.sid, f);
  return [...seen.values()];
}
