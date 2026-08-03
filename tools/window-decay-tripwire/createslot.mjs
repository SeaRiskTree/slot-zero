/**
 * Getting one launch's **create slot** off `swap-api.pump.fun`, and one wallet's launch list off
 * `frontend-api-v3.pump.fun`. Pure of sockets — it builds URLs and reads bodies; `client.mjs` is
 * the only thing here that fetches.
 *
 * The create slot is all this tripwire needs from a launch, and that is what makes it cheap: one
 * Solana slot, readable seconds after the mint, no waiting for anybody's position to close.
 *
 * Three properties of the trade endpoint everything below is built on, all from
 * `data/population-tape-2026-07-29/report.md` §9.2:
 *
 * 1. **Rows come back NEWEST FIRST**, so any walk over them runs backwards and reaches the create
 *    slot LAST. A truncated backwards walk is silently wrong rather than visibly wrong — it returns
 *    a plausible pile of fills whose earliest slot is merely the earliest it saw, and any
 *    create-slot measure then crowns a mid-window sniper as the deployer. Coverage is therefore
 *    *proved* here, by {@link reachedTheBeginning}, and a walk that cannot prove it returns
 *    `proven: false` rather than its best guess.
 * 2. **The cursor's timestamp component seeks**, so knowing when a launch minted turns the walk
 *    into one request instead of a walk. That is why {@link readCreateSlot} wants `createdAtMs` and
 *    why the launch listing is worth its single request.
 * 3. **Sort by `sid` before reading anything**: the stored tape is ascending, the live endpoint is
 *    descending, and the timestamp is second-resolution so it cannot order fills inside one slot —
 *    which a create slot entirely is.
 */

import { FRONTEND_API, SWAP_API } from './client.mjs';

/** The largest page the trade endpoint serves, and the size the committed tape was built at. */
export const PAGE_LIMIT = 100;

/**
 * How far past a launch's mint instant the seek lands, in ms.
 *
 * The endpoint's timestamps are second-resolution, so a cursor at the mint instant itself can fall
 * inside the create slot's own second and return only part of it. One second past covers the whole
 * of it; the walk pages backwards from there regardless, so the only cost of overshooting is rows
 * the caller filters out.
 */
export const SEEK_PAD_MS = 1_000;

/**
 * Pages one launch's create-slot walk may consume.
 *
 * With `createdAtMs` known the walk is normally **one** page: the seek lands just past the mint,
 * and the create slot is the oldest thing there is. Three is headroom for a launch whose first
 * second carried more than `PAGE_LIMIT` fills — reachable on both paging routes, the endpoint's own
 * `nextCursor` and, when it sends none, a seek cursor built from the oldest row's own timestamp.
 * Without `createdAtMs` the walk starts at the newest fill and this bound is what stops it becoming
 * a whole-history walk — it will usually fail to prove coverage instead, which is the correct
 * outcome and is why `--mints` without timestamps is documented as the expensive path.
 */
export const MAX_PAGES_PER_LAUNCH = 3;

/**
 * The shape a mint must have before it may be built into a URL.
 *
 * Mints reach this module vendor-supplied (`parseLaunchListing` reads whatever string the listing
 * body puts in `mint`) or operator-supplied (`--mints`), and they land in a URL **path**, which
 * `..`, `?` or `#` rewrite. The keyless client's host allow-list checks the host prefix and cannot
 * catch that. Same rule and same alphabet as `tools/deployer-screen/dune.mjs` → `WALLET_SHAPE`,
 * for the same reason: a vendor-supplied identifier reaching a query surface is shape-checked
 * first, and a candidate that fails is dropped and counted rather than passed through.
 */
export const MINT_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** @param {unknown} mint @returns {boolean} */
export function isReadableMint(mint) {
  return typeof mint === 'string' && MINT_SHAPE.test(mint);
}

/**
 * Build a cursor that seeks to an instant. The slot half is ignored by the endpoint and is pinned
 * HIGH so that a future version which stops ignoring it over-returns — which the caller filters —
 * rather than under-returns, which is the silent truncation this module exists to refuse.
 *
 * @param {number} atMs Unix ms. Rows at or older than this instant are what the page will hold.
 */
export const seekCursor = (atMs) => `9999999999990000000000-${Math.floor(atMs)}`;

/**
 * @param {string} mint
 * @param {string | null} cursor `null` for the uncursored first page — the newest fills of all.
 */
export function tradesUrl(mint, cursor = null) {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor !== null) query.set('cursor', cursor);
  return `${SWAP_API}/v2/coins/${encodeURIComponent(mint)}/trades?${query.toString()}`;
}

/**
 * @param {string} creator
 * @param {number} limit
 */
export function creatorLaunchesUrl(creator, limit) {
  const query = new URLSearchParams({
    creator,
    limit: String(limit),
    offset: '0',
    sort: 'created_timestamp',
    order: 'DESC',
    includeNsfw: 'true',
  });
  return `${FRONTEND_API}/coins?${query.toString()}`;
}

/**
 * @typedef {object} TradePage
 * @property {import('./detector.mjs').Fill[]} fills
 * @property {number} rawRows Rows the endpoint sent, before any failed to parse.
 * @property {boolean} recognised Whether the body was a shape rows can be read out of **at all**.
 *   `false` with no fills and `true` with no fills are different findings — "we do not understand
 *   the answer" against "the endpoint says there is nothing". Only the second may end a walk.
 * @property {boolean | null} hasMore The endpoint's own statement, `null` if it made none.
 * @property {string | null} nextCursor
 */

/**
 * The `slotIndexId` is a fixed-width `<12-digit slot><10-digit intra-slot ordinal>`; the endpoint
 * sends no slot field, so it is derived. Validated against the committed tape, which stores both.
 *
 * @param {string} sid
 */
export const slotOf = (sid) => Number(sid.slice(0, 12));

/**
 * A vendor timestamp in unix ms, or `null` when it is not one this module can read.
 *
 * **The one place this file decides what unit a vendor timestamp is in.** Both feeds it reads — the
 * trade endpoint's rows and the launch listing's `created_timestamp` — are the same kind of field
 * from the same vendor, and two parsers in this file disagreeing about seconds against milliseconds
 * is how a launch's seek lands in 1970. A seconds-resolution epoch is therefore widened here and
 * nowhere else; anything unreadable is `null`, which callers must treat as "no timestamp", never as
 * zero — a launch seeked from the epoch returns an empty page that looks exactly like silence.
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseRowTimestamp(raw) {
  const widen = (/** @type {number} */ n) => (n < 1e12 ? Math.round(n * 1_000) : Math.round(n));
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? widen(raw) : null;
  if (typeof raw !== 'string' || raw === '') return null;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? widen(numeric) : null;
}

/**
 * Normalise one endpoint row. Returns `null` for a row missing anything a caller must not invent —
 * dropped rows are counted by {@link parseTradePage}, never silently absorbed.
 *
 * `sol` is a number here rather than the tape's string, because this tool only ever sums it. The
 * committed tape's own strings are parsed the same way by `backtest.mjs`, so both feeds reach
 * `detector.mjs` in one shape.
 *
 * @param {unknown} row
 * @returns {import('./detector.mjs').Fill | null}
 */
export function parseFill(row) {
  if (typeof row !== 'object' || row === null) return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const sid = r['slotIndexId'], tx = r['tx'], u = r['userAddress'], k = r['type'];
  if (typeof sid !== 'string' || sid.length < 12) return null;
  if (typeof tx !== 'string' || typeof u !== 'string') return null;
  if (k !== 'buy' && k !== 'sell') return null;
  const slot = slotOf(sid);
  if (!Number.isFinite(slot)) return null;
  const raw = r['amountSol'];
  const sol = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  // A fill whose size will not parse cannot be summed, and summing it as zero would understate the
  // denominator — i.e. push the share UP, towards a stop. Dropped instead, and counted.
  if (!Number.isFinite(sol) || sol < 0) return null;
  return { slot, sid, tx, u, k, sol };
}

/**
 * Read one page. Both the bare-array and the wrapped body shapes are accepted, but only the wrapped
 * one carries `pagination` — so an unwrapped body yields `hasMore: null`, "no statement made",
 * never "there is nothing more".
 *
 * @param {unknown} body
 * @returns {TradePage}
 */
export function parseTradePage(body) {
  /** @type {unknown[] | null} */ let rows = null;
  /** @type {boolean | null} */ let hasMore = null;
  /** @type {string | null} */ let nextCursor = null;

  if (Array.isArray(body)) rows = body;
  else if (typeof body === 'object' && body !== null) {
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

  /** @type {import('./detector.mjs').Fill[]} */ const fills = [];
  for (const row of rows) {
    const fill = parseFill(row);
    if (fill !== null) fills.push(fill);
  }
  return { fills, rawRows: rows.length, recognised: true, hasMore, nextCursor };
}

/** Ascending by `sid` — the committed tape's order, and the only key that orders one slot. */
export const sortAscending = (/** @type {readonly import('./detector.mjs').Fill[]} */ fills) =>
  [...fills].sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));

/** Drop duplicates, keeping the first seen. `sid` is the endpoint's own total order, so it is the identity. */
export function dedupeBySid(/** @type {readonly import('./detector.mjs').Fill[]} */ fills) {
  /** @type {Map<string, import('./detector.mjs').Fill>} */ const seen = new Map();
  for (const f of fills) if (!seen.has(f.sid)) seen.set(f.sid, f);
  return [...seen.values()];
}

/**
 * Has a backwards walk **proved** it reached the very beginning of a token's life?
 *
 * One thing establishes it: the oldest fill seen is a **buy by the deployer**. Nothing can precede
 * the create, so a deployer buy at the minimum `sid` is the create itself and there is provably
 * nothing older. Running out of pages establishes nothing, and neither does an empty page — the
 * same distinction the committed tape draws with `meta.reached_mint`, and the reason four of its
 * 239 window files are marked incomplete rather than quietly short.
 *
 * @param {readonly import('./detector.mjs').Fill[]} fills Everything the walk has accumulated.
 * @param {string} deployer
 * @returns {boolean}
 */
export function reachedTheBeginning(fills, deployer) {
  const oldest = sortAscending(fills)[0];
  return oldest !== undefined && oldest.u === deployer && oldest.k === 'buy';
}

/**
 * Why a walk cannot say anything about this launch **yet**, as opposed to having read it.
 *
 * - `ceiling` — the run's request budget ran out mid-walk.
 * - `pages` — the per-launch page bound ran out before coverage was proved.
 * - `unreadable` — a body this module could not read rows out of, or a page whose rows all failed
 *   to parse.
 * - `no-cursor` — the walk had not reached the beginning and the endpoint sent no `nextCursor`.
 *   There is no second way to ask: the cursor's seeking half is a **second-resolution** timestamp,
 *   so it cannot page backwards inside the one second a create slot lives in — a seek built from
 *   the oldest row's own instant re-requests the page it just read.
 * - `empty-page` — a **cursored** request came back with nothing. That is equally consistent with
 *   a token that has no such fills and with a seek that landed in the wrong place, and the walk
 *   cannot tell which, so it does not get to call it silence.
 *
 * @typedef {'ceiling' | 'pages' | 'unreadable' | 'no-cursor' | 'empty-page'} UndecidedReason
 */

/**
 * @typedef {object} CreateSlotWalk
 * @property {import('./detector.mjs').Fill[]} fills Everything read, ascending by `sid`.
 * @property {boolean} proven Whether the walk reached the beginning. **A `false` here must reach
 *   the reading as `no-create-slot`, never as a create slot the walk merely happened to stop at.**
 * @property {boolean} decided Whether this walk settled the launch at all — coverage proved, or the
 *   endpoint itself saying there is nothing older. **A walk that is not decided must not be
 *   recorded as read**: "we ran out of budget" and "this launch has no create slot" are different
 *   findings, and storing the first as the second destroys the evidence permanently, because a mint
 *   in `readMints` is never fetched again.
 * @property {UndecidedReason | null} undecidedReason `null` exactly when `decided`.
 * @property {number} pages Pages read.
 * @property {number} droppedRows Rows the endpoint sent that would not parse.
 */

/**
 * Walk backwards to a launch's create slot, bounded by {@link MAX_PAGES_PER_LAUNCH}.
 *
 * @param {import('./client.mjs').KeylessClient} client
 * @param {string} mint
 * @param {object} options
 * @param {string} options.deployer
 * @param {number | null} [options.createdAtMs] The launch's mint instant. With it the walk is
 *   normally one request; without it the walk starts at the newest fill and usually cannot prove
 *   coverage inside the page bound, which is the honest outcome rather than a cheap wrong one.
 * @param {number} [options.maxPages]
 * @returns {Promise<CreateSlotWalk>}
 */
export async function readCreateSlot(client, mint, options) {
  const { deployer, createdAtMs = null, maxPages = MAX_PAGES_PER_LAUNCH } = options;
  if (!isReadableMint(mint)) throw new TypeError(`refusing a mint that is not base58-shaped: ${mint}`);
  /** @type {import('./detector.mjs').Fill[]} */ let fills = [];
  let cursor = createdAtMs === null ? null : seekCursor(createdAtMs + SEEK_PAD_MS);
  let pages = 0, droppedRows = 0;
  /** @type {UndecidedReason | null} */ let undecided = 'pages';

  while (pages < maxPages) {
    // Reserve a whole request's worth of attempts before starting one, so the per-launch bound is
    // exact rather than nominal: a retry spends the shared public endpoint exactly as a first try does.
    if (client.remaining() < client.attemptsPerRequest()) { undecided = 'ceiling'; break; }
    const page = parseTradePage(await client.getJson(tradesUrl(mint, cursor)));
    pages += 1;
    droppedRows += page.rawRows - page.fills.length;
    // An unrecognised body is not an empty one. Stopping here leaves the walk UNDECIDED, which the
    // caller reads as "come back to this launch" rather than as a create slot or as a settled silence.
    if (!page.recognised) { undecided = 'unreadable'; break; }
    const cursored = cursor !== null;
    fills = dedupeBySid([...fills, ...page.fills]);
    if (reachedTheBeginning(fills, deployer)) { undecided = null; break; }
    if (page.fills.length === 0) {
      // Rows arrived and none of them parsed: a gap in what we can read, not a gap in the token.
      if (page.rawRows > 0) { undecided = 'unreadable'; break; }
      // The ONE empty page that settles anything: the uncursored first page, with the endpoint
      // itself saying there is nothing more. A cursored empty page is silence of unknown origin —
      // a token with no such fills and a seek that landed in the wrong place look identical — so it
      // is left undecided and the launch is read again next run.
      undecided = !cursored && page.hasMore === false ? null : 'empty-page';
      break;
    }
    // The endpoint's own statement that there is nothing older. That settles the launch: there is
    // genuinely nothing to read, which is a finding rather than a gap.
    if (page.hasMore === false) { undecided = null; break; }
    // Paging is the endpoint's own `nextCursor` and nothing else. There is no second route: the
    // cursor's seeking half is a second-resolution timestamp, so a cursor built from the oldest row
    // seen asks for the same second again and the walk would spend its remaining pages re-reading
    // rows it already has.
    if (page.nextCursor === null) { undecided = 'no-cursor'; break; }
    cursor = page.nextCursor;
  }

  return {
    fills: sortAscending(fills),
    proven: reachedTheBeginning(fills, deployer),
    decided: undecided === null,
    undecidedReason: undecided,
    pages,
    droppedRows,
  };
}

/**
 * @typedef {object} ListedLaunch
 * @property {string} mint
 * @property {number} createdAtMs
 * @property {string} symbol
 */

/**
 * @typedef {object} LaunchListing
 * @property {ListedLaunch[]} launches Newest first.
 * @property {boolean} recognised Whether the body was a shape launches can be read out of at all.
 * @property {number} rawRows
 */

/**
 * Read a wallet's launch list.
 *
 * **Strict on purpose.** This endpoint's response shape is not pinned by anything in this repo, so
 * an unreadable body must come back as `recognised: false` and stop the run — never as "this wallet
 * has launched nothing", which a watcher would read as "no new evidence" and sit on forever. That
 * is the same failure shape `dune.mjs` refuses when a decoded table returns no row for a wallet.
 *
 * It lists by **current** creator, so a launch whose creator record has moved is missing from it
 * (`AGENTS.md`). For this tool the bias is one-directional: a missing launch delays a reading, it
 * cannot manufacture one — and it cannot un-fire a latched stop.
 *
 * @param {unknown} body
 * @returns {LaunchListing}
 */
export function parseLaunchListing(body) {
  /** @type {unknown[] | null} */ let rows = null;
  if (Array.isArray(body)) rows = body;
  else if (typeof body === 'object' && body !== null) {
    const b = /** @type {Record<string, unknown>} */ (body);
    for (const key of ['coins', 'data', 'results']) if (Array.isArray(b[key])) { rows = b[key]; break; }
  }
  if (rows === null) return { launches: [], recognised: false, rawRows: 0 };

  /** @type {ListedLaunch[]} */ const launches = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = /** @type {Record<string, unknown>} */ (row);
    const mint = r['mint'] ?? r['address'] ?? r['coinMint'];
    const created = r['created_timestamp'] ?? r['createdTimestamp'] ?? r['creationTime'];
    if (typeof mint !== 'string' || mint === '') continue;
    // The same reader the trade rows go through. This value becomes the walk's seek cursor, so
    // reading a seconds-resolution epoch as milliseconds would aim it at 1970 and return an empty
    // page — silence this module would otherwise have to tell apart from a token with no fills.
    const createdAtMs = parseRowTimestamp(created);
    if (createdAtMs === null) continue;
    const symbol = r['symbol'];
    launches.push({ mint, createdAtMs, symbol: typeof symbol === 'string' ? symbol : '' });
  }
  launches.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { launches, recognised: true, rawRows: rows.length };
}
