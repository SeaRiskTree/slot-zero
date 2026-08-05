/**
 * The Dune {@link import('./fill-source.mjs').FillSource} — decoded `SwapEvent` rows, wearing the
 * same contract the swap-api reader wears. Captain decision 260a, 2026-08-05.
 *
 * ## Read this before reading the code: NOTHING ROUTES THROUGH THIS TODAY, AND THAT IS CORRECT
 *
 * The captain's Dune-aggregated Stage 2 programme cuts over at **Gate 3**, which has not been
 * convened. This module is Gate 3 precondition 2 — *the source-agnostic provider exists* — and a
 * committed Dune path that no run reaches is the correct resting state, not an unfinished one.
 * `screen.mjs` selects the swap-api source on every run.
 *
 * ## What is HERE and what belongs to other decisions
 *
 * Here, and complete: the row → {@link import('./fill-source.mjs').LaunchWindow} assembly, its
 * coverage proof, the within-slot ordering recovery, the pre-mint tripwire, and the watermark
 * eligibility rule. All of it is pure and offline-testable, and all of it is evidence Gate 1
 * already produced.
 *
 * NOT here, deliberately:
 *
 * - **The entry SQL and its saved-query id** are captain decision 258b's, which lands the batch
 *   statement byte-for-byte as a committed constant with `assertSavedQueryMatches` against a pinned
 *   id. This module READS a statement; it does not own one. {@link duneFillSource} takes it as
 *   `opts.query`, and **absent means REFUSE** — every window comes back `usable: false` with a
 *   sentence naming 258b. A source that fabricated a window because its statement was missing is
 *   the exact failure the whole boundary exists to prevent.
 * - **The pinned prices and ceilings** are captain decision 255b's and `thresholds.json`'s. Bounds
 *   arrive as an argument; nothing here writes a number down.
 * - **The two-table union** (captain decision 256a, `pump_amm` beside the bonding curve) is a
 *   property of that statement. What this module enforces is that the projection **says which venue
 *   a row came from** — a row that does not is refused rather than defaulted to the curve, because
 *   `pump_amm` fills are exactly the 18 graduation-spanning launches the union exists to recover
 *   and silently calling them curve fills would move `roomLeft`.
 *
 * ## The hazard this route reproduces, and where it is answered
 *
 * The comment on 156a's boundary assertion argues about what a row MEANS. That argument does not
 * survive the substitution — a `SwapEvent` row decoded by Dune is the same observation
 * `swap-api.pump.fun` serves, and Gate 1 reproduced every entry quantity from it at **0.000e+00**
 * absolute error using this repo's own production functions. The real hazard is **completeness**,
 * and it is the one this repo has documented more thoroughly than any other: a short result is
 * well-formed, complete-looking and silently wrong, and any create-slot measure over one crowns a
 * mid-window sniper as the deployer.
 *
 * Dune reaches that failure through three doors the swap-api does not have — vendor lag, an absent
 * table, and result-set truncation — so coverage here is proved the way Gate 1 proved it:
 * **scan WIDER than the window and observe the boundary rather than assume it.** A scan whose old
 * edge is not strictly older than the declared mint proves nothing and is refused.
 */

import { assertSavedQueryMatches, executeAndRead, parseDuneTimestamp } from './dune.mjs';
import { LAMPORTS_PER_SOL } from './measure.mjs';
// Window GEOMETRY, shared by every source: which fills are inside the window
// ({@link windowFilter}, denominated in slots) and how far past the mint the window reaches
// ({@link windowReachMs}, denominated in slots at a measured worst-case rate). Imported rather than
// re-derived on purpose — a second copy of the membership rule is a second answer to "what is in
// this window", and captain decision 144a records what happens when two such expressions merely
// agree.
import { windowFilter, windowReachMs } from './pumpfun.mjs';

/**
 * Token-2022 base units per whole token. `LAMPORTS_PER_SOL` is the pure core's, imported above.
 *
 * Raw integer amounts come back as strings and are scaled HERE rather than in Trino: dividing in
 * SQL introduces a double rounding between the chain and the comparison and makes exact agreement
 * with the fill tape unprovable. Gate 1 §2 establishes that as one of the four load-bearing choices
 * in its projection.
 */
const TOKEN_UNITS_PER_TOKEN = 1_000_000;

/**
 * `priceSol` on a Dune-sourced fill is **NaN, and NaN means UNMEASURED**.
 *
 * The decoded trade tables carry the two amounts and not the quoted price, so there is nothing here
 * to put in this field. `0` would be a *plausible* wrong value, which is the category this repo
 * refuses everywhere else — `covered.fromMs === null` means covered nothing and never
 * since-the-epoch, and a `0` sentinel in that exact position once read as a 56-year window and
 * deleted 29 of one live wallet's 30 launches. A NaN is a refusal; a zero is an answer.
 *
 * Nothing in the scoring path reads `priceSol` today, so this is a latent trap being closed rather
 * than a live one being patched: the first consumer that reads it gets a value that cannot be
 * mistaken for a measurement.
 */
export const DUNE_PRICE_UNMEASURED = Number.NaN;

/**
 * @typedef {object} DuneWindowScan
 * What was asked of the vendor for one launch, so the answer can be checked against the question.
 *
 * @property {number} fromMs  Oldest instant the scan covered. **Must be strictly older than the
 *   declared mint** or coverage cannot be proved: a scan starting at the mint returns a plausible
 *   pile of fills whose earliest slot is merely the earliest it was allowed to see.
 * @property {number} toMs    Newest instant the scan covered.
 * @property {number} requests Requests the read cost, retries included.
 */

/**
 * Rebuild pump.fun's within-slot ordering key from Dune's three index columns.
 *
 * **The obvious mapping is wrong and Gate 1 §5.2 measured why.** `inner_instruction_index` is the
 * position of the `SwapEvent` CPI log inside its parent instruction and is CONSTANT within a
 * transaction (7, on every row of the launch it measured). The discriminator between three wallets
 * bundled into one transaction is `outer_instruction_index` (5, 7, 9) — the top-level instruction
 * index. So the recovery is `tx_index` across transactions, then `outer` then `inner` within one.
 *
 * The rebuilt key is `slot(12) + tx_index(6) + rank(outer, inner)(4)`, which matched the tape on
 * **349 of 350** create-slot fills. The single miss is structural and permanent: the deployer's own
 * create-then-buy transaction carries `0002` on the tape because the buy is the third pump.fun
 * instruction in it, and `base_trades` decodes only `SwapEvent`, so it sees one row and ranks it 0.
 *
 * That changes no ordering — the trailing field is a within-transaction tiebreak and that
 * transaction holds one swap — but it means the string is **order-faithful, not identity-faithful**.
 * **Never join, dedup or cache on `sid` across sources.** The natural implementation of a
 * mixed-source parity harness is exactly such a join, and it would report one spurious mismatch per
 * launch, forever, on the deployer's own row.
 *
 * @param {number} slot
 * @param {number} txIndex
 * @param {number} rank Position of this row among its own transaction's rows, `outer` then `inner`.
 * @returns {string}
 */
export function rebuildSid(slot, txIndex, rank) {
  return (
    String(slot).padStart(12, '0') + String(txIndex).padStart(6, '0') + String(rank).padStart(4, '0')
  );
}

/** @param {unknown} v @returns {number | null} */
function asInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v !== 'string' || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** @param {unknown} v @returns {string | null} */
function asText(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * One decoded trade row, before it is a {@link import('./measure.mjs').Fill}.
 *
 * @typedef {object} DuneTradeRow
 * @property {number} slot
 * @property {number} txIndex
 * @property {number} outer
 * @property {number} inner
 * @property {string} tx
 * @property {string} wallet
 * @property {'buy' | 'sell'} side
 * @property {'pump' | 'pump_amm'} venue
 * @property {number} sol
 * @property {number} tokens
 * @property {number} tsMs
 */

/**
 * Read one result row, or refuse it.
 *
 * **Refuses rather than defaults, on every field.** An unreadable row is counted as unparsed and a
 * non-zero count makes the whole launch unusable, exactly as it does on the swap-api walk: the
 * alternative is a window that is quietly short by however many rows the parser gave up on, which
 * is the failure shape this route is most exposed to.
 *
 * @param {unknown} raw
 * @returns {DuneTradeRow | null}
 */
export function parseDuneTradeRow(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = /** @type {Record<string, unknown>} */ (raw);

  const slot = asInt(row['block_slot']);
  const txIndex = asInt(row['tx_index']);
  const outer = asInt(row['outer_instruction_index']);
  const inner = asInt(row['inner_instruction_index']);
  const tx = asText(row['tx_id']);
  const wallet = asText(row['trader_id']);
  if (slot === null || txIndex === null || outer === null || inner === null) return null;
  if (tx === null || wallet === null) return null;

  // `is_buy` is TYPE-checked, not truth-checked, for the reason `dune.mjs` states about `bonded`:
  // `0`/`false` is a legitimate answer, so a check that folded a missing column into "sell" would
  // reclassify every fill on a run reporting itself fully measured.
  const isBuy = row['is_buy'];
  /** @type {'buy' | 'sell' | null} */
  let side = null;
  if (isBuy === 1 || isBuy === true) side = 'buy';
  else if (isBuy === 0 || isBuy === false) side = 'sell';
  if (side === null) return null;

  // The venue is MANDATORY and is never defaulted — see this module's header. Under captain
  // decision 256a the projection is a union of the bonding-curve and PumpSwap AMM tables, and a row
  // that cannot say which one it came from is a fill whose venue would have to be guessed.
  const venue = row['venue'];
  if (venue !== 'pump' && venue !== 'pump_amm') return null;

  const solRaw = asInt(row['sol_raw']);
  const tokenRaw = asInt(row['token_raw']);
  if (solRaw === null || tokenRaw === null) return null;

  // Seconds since the epoch, as `to_unixtime(block_time)` gives them, or a timestamp string. Both
  // go through `dune.mjs`'s own parser where they are text, so there is one reading of a Dune
  // instant in this directory.
  let tsMs = null;
  const ts = row['ts_unix'];
  if (typeof ts === 'number' && Number.isFinite(ts)) tsMs = Math.round(ts * 1000);
  else if (typeof ts === 'string' && /^\d+$/.test(ts)) tsMs = Number(ts) * 1000;
  else tsMs = parseDuneTimestamp(ts);
  if (tsMs === null || !Number.isFinite(tsMs)) return null;

  return {
    slot,
    txIndex,
    outer,
    inner,
    tx,
    wallet,
    side,
    venue,
    sol: solRaw / LAMPORTS_PER_SOL,
    tokens: tokenRaw / TOKEN_UNITS_PER_TOKEN,
    tsMs,
  };
}

/**
 * Assemble one launch's window from decoded trade rows.
 *
 * **Pure, and this is where the coverage proof lives.** Four obligations, and the first is the one
 * the whole route turns on:
 *
 * 1. **The scan must have looked OLDER than the mint.** Only then does "no row came back from
 *    before the mint" mean anything. A scan whose old edge is at or after the declared mint is
 *    refused `coverage-unproven` — it is the truncated backwards walk in a different costume.
 * 2. **A row older than the declared mint is a DISAGREEMENT, not coverage.** Same zero-slack rule
 *    as the swap-api walk, deliberately: a positive skew of one millisecond deletes an entire create
 *    slot, whose rows share the mint's exact instant, leaving the measurement anchored on a
 *    mid-window slot with the wrong deployer and an inflated room figure. Stage 2's mint times come
 *    from a vendor whose clock is known to disagree with pump.fun's, so this fires on real launches
 *    and the drop is counted rather than tolerated.
 * 3. **An unreadable row makes the launch unusable**, never merely smaller.
 * 4. **There must be a bonding-curve buy to anchor on** after the slot trim, or there is no create
 *    slot and nothing to measure.
 *
 * **Sorting is deterministic before anything is summed.** Gate 1 §5.4 found its first comparison
 * passed only because V8's stable sort silently preserved the SQL's `ORDER BY` — luck, not proof —
 * and measured a 4.441e-16 SOL residual from summation order once that was removed. Ten orders of
 * magnitude under the bar, and still: a production reader must not assume Dune returns rows in a
 * stable order across executions.
 *
 * @param {readonly unknown[]} rows
 * @param {object} opts
 * @param {string} opts.mint
 * @param {number} opts.createdAtMs Declared mint time — the disagreement tripwire, **not** the
 *   window boundary. Membership is `windowSlotSpan` from the earliest curve buy, as everywhere else.
 * @param {number} opts.windowSlotSpan
 * @param {DuneWindowScan} opts.scan
 * @returns {import('./fill-source.mjs').SourcedLaunchWindow}
 */
export function duneRowsToWindow(rows, opts) {
  /** @param {Partial<import('./fill-source.mjs').SourcedLaunchWindow>} over */
  const window = (over) => ({
    kind: /** @type {const} */ ('dune'),
    mint: opts.mint,
    seekFromMs: opts.scan.toMs,
    fills: [],
    pages: 1,
    requests: opts.scan.requests,
    rowsSeen: rows.length,
    unparsedRows: 0,
    reachedCreateSlot: false,
    hitRequestCap: false,
    mintTimeDisagreement: false,
    usable: false,
    dropReason: /** @type {import('./fill-source.mjs').LaunchWindowDropReason | null} */ (null),
    note: '',
    ...over,
  });

  if (opts.scan.fromMs >= opts.createdAtMs) {
    return window({
      dropReason: 'coverage-unproven',
      note:
        `DROPPED (coverage unproven): the scan began at or after the declared mint, so an absence ` +
        `of older rows proves nothing about the create slot. A window is only covered when the ` +
        `vendor was asked about a period BEFORE the mint and returned nothing there.`,
    });
  }

  /** @type {DuneTradeRow[]} */
  const parsed = [];
  let unparsed = 0;
  for (const raw of rows) {
    const row = parseDuneTradeRow(raw);
    if (row === null) unparsed += 1;
    else parsed.push(row);
  }
  if (unparsed > 0) {
    return window({
      unparsedRows: unparsed,
      dropReason: 'unparsed-rows',
      note:
        `DROPPED: ${unparsed} of ${rows.length} row(s) could not be read, so this window is short ` +
        `by an unknown amount rather than complete.`,
    });
  }

  if (parsed.some((r) => r.tsMs < opts.createdAtMs)) {
    return window({
      mintTimeDisagreement: true,
      dropReason: 'mint-time-disagreement',
      note:
        `DROPPED (mint-time disagreement): a fill older than the declared mint came back, so the ` +
        `vendor's clock and the trade tables have come apart and the measurement is no longer ` +
        `resting on what we think it is.`,
    });
  }

  // Deterministic, key-decided ordering — never the vendor's arrival order. See the doc above.
  parsed.sort(
    (a, b) => a.slot - b.slot || a.txIndex - b.txIndex || a.outer - b.outer || a.inner - b.inner,
  );

  /** @type {Map<string, number>} */
  const rankInTx = new Map();
  /** @type {import('./measure.mjs').Fill[]} */
  const fills = parsed.map((r) => {
    const key = `${r.slot}:${r.txIndex}`;
    const rank = rankInTx.get(key) ?? 0;
    rankInTx.set(key, rank + 1);
    return {
      slot: r.slot,
      sid: rebuildSid(r.slot, r.txIndex, rank),
      tx: r.tx,
      wallet: r.wallet,
      side: r.side,
      venue: r.venue,
      sol: r.sol,
      tokens: r.tokens,
      priceSol: DUNE_PRICE_UNMEASURED,
    };
  });

  const inWindow = windowFilter(fills, opts.windowSlotSpan);
  if (inWindow.length === 0) {
    return window({
      note:
        `DROPPED: the scan returned ${rows.length} row(s) and no bonding-curve buy among them, so ` +
        `there is no create slot to anchor the window on.`,
      dropReason: 'no-fills',
    });
  }

  return window({
    fills: inWindow,
    reachedCreateSlot: true,
    usable: true,
    note:
      `covered: the scan reached ${((opts.createdAtMs - opts.scan.fromMs) / 1000).toFixed(1)}s ` +
      `before the declared mint and returned nothing older than it, so the create slot is the ` +
      `earliest curve buy rather than the earliest row seen`,
  });
}

/**
 * @typedef {object} DuneEntryQuery
 * The committed statement this reader runs. **Captain decision 258b's to land**, id and text
 * together, so `assertSavedQueryMatches` can refuse a saved query edited from a browser BEFORE an
 * execution is billed.
 *
 * @property {number} id  The pinned saved-query id.
 * @property {string} sql The committed text, compared against the saved query before spending.
 * @property {(ref: import('./measure.mjs').LaunchRef, scan: DuneWindowScan) => Record<string, string>}
 *   parameters The launch's own narrow predicate. Per 255b every window is sized from the launch's
 *   own bounds and never from a literal.
 */

/**
 * Build the Dune fill source.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {object} opts
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, maxResultRows: number }} opts.bounds
 * @param {import('./dune.mjs').CoverageAssessment | null} opts.coverage The trade tables' own
 *   coverage assessment — **the observed watermark**, and the only thing that answers eligibility on
 *   this route. `null`, an assessment that refused, or one carrying no `toMs` means this source
 *   CANNOT BE BUILT: see the throw below.
 * @param {DuneEntryQuery | null} [opts.query] Absent means every window is refused; see the module
 *   header.
 * @param {number} opts.maxRequests This source's own request ceiling, so `remaining()` can answer
 *   Stage 2's "reserve a whole launch before starting one" rule. Held here rather than read off the
 *   client because `DuneClient` does not publish its ceiling, and a source that could not answer
 *   `remaining()` would silently disable that reservation.
 * @returns {import('./fill-source.mjs').FillSource}
 * @throws when the watermark is unreadable — the source refuses to exist rather than to answer.
 */
export function duneFillSource(client, opts) {
  const query = opts.query ?? null;

  // AN UNREADABLE WATERMARK REFUSES THE SOURCE, NOT EACH LAUNCH. Eligibility on this route is
  // `nowMs − watermark`, so with no watermark there is no answer — and both ways of pretending
  // otherwise are failures this repo has already paid for. A written constant is captain decision
  // 144a's defect verbatim, a duration for something the vendor controls. `Infinity` is a
  // plausible-looking refusal that does not stay inside the comparison: Stage 2 persists this
  // figure as `entry.coverage.minAgeMs`, whose versioned contract declares it a number, and
  // `JSON.stringify(Infinity)` is `null` — so a run would save itself a MISSING gate and render
  // `younger than Infinityms`, an unknown wearing a measurement's clothes.
  //
  // So the refusal is stated where it can be: here, at construction, which is
  // `screen.mjs` → `selectEntryFillSource` — the one place a source is chosen, and already the one
  // place a source that cannot be supplied is refused rather than substituted. Stage 2 is then
  // never handed a source that cannot answer, and `minAgeMs` is total and finite for every source
  // that exists. `fill-source.mjs` → `assertMinAgeUsable` holds a future source to the same rule.
  const watermarkMs = opts.coverage !== null && opts.coverage.ok ? opts.coverage.toMs : null;
  if (watermarkMs === null || !Number.isFinite(watermarkMs)) {
    const why =
      opts.coverage === null
        ? 'this run carries no coverage assessment for the decoded trade tables'
        : opts.coverage.ok
          ? 'the coverage assessment established no newest covered instant'
          : `the coverage probe refused the trade tables: ${opts.coverage.reasons.join(' ')}`;
    throw new Error(
      `the Dune fill source cannot be built: ${why}, so there is no observed watermark and no ` +
        `answer to "has this launch finished happening". Captain decision 257a requires that ` +
        `answer to come from the vendor's own tables, and captain decision 144a forbids writing a ` +
        `duration for it instead — so this source refuses to exist rather than admit launches ` +
        `against tables that cannot vouch for any of them. The refusal is the run's to report; it ` +
        `is not a launch-level drop.`,
    );
  }

  return {
    kind: 'dune',
    issued: () => client.issued(),
    remaining: () => Math.max(0, opts.maxRequests - client.issued()),

    /**
     * **ELIGIBILITY FROM AN OBSERVED WATERMARK, NEVER A WRITTEN DURATION** — captain decision 257a.
     *
     * Dune's decoded tables lag the chain, measured at ~4 minutes against the swap-api gate's
     * 85,000 ms — 2.8x longer. A launch admitted at 85 s is queried from a table that does not yet
     * hold its fills, and the result comes back well-formed, complete-looking and SHORT: the same
     * silent truncation, in the same direction, arriving by a different door. Raising the gate to a
     * bigger constant was declined because it re-arms the trap captain decision 144a has already
     * named twice — **the defect is writing a DURATION for something someone else controls.**
     *
     * So the lag is not written down here. It is `nowMs − watermark`, read off the tables
     * themselves, and the only duration in the sum is the window's own reach, which is the
     * launch's geometry rather than the vendor's schedule.
     *
     * **An unreadable watermark has already been refused** — by the constructor above, so this is
     * total and finite. Reading a missing watermark as zero lag would admit every launch against
     * tables that cannot vouch for any of them; answering `Infinity` would put a non-number into a
     * figure that is persisted and rendered as one.
     *
     * @param {import('./fill-source.mjs').FillSourceBounds} bounds
     * @returns {Promise<number>}
     */
    async minAgeMs(bounds) {
      const lagMs = Math.max(0, bounds.nowMs - watermarkMs);
      return (
        lagMs +
        windowReachMs({
          windowMs: bounds.windowMs,
          seekMarginMs: bounds.seekMarginMs,
          windowSlotSpan: bounds.windowSlotSpan,
        })
      );
    },

    /**
     * @param {import('./measure.mjs').LaunchRef} ref
     * @param {import('./fill-source.mjs').FillSourceBounds} bounds
     * @returns {Promise<import('./fill-source.mjs').SourcedLaunchWindow>}
     */
    async readWindow(ref, bounds) {
      // THE SCAN IS WIDER THAN THE WINDOW ON PURPOSE, at both ends. The old edge buys the coverage
      // proof (`seekMarginMs` before the declared mint, so an absence of older rows means
      // something); the new edge is the window's own reach, as every other lane sizes it.
      const reachMs = windowReachMs({
        windowMs: bounds.windowMs,
        seekMarginMs: bounds.seekMarginMs,
        windowSlotSpan: bounds.windowSlotSpan,
      });
      /** @type {DuneWindowScan} */
      const scan = {
        fromMs: ref.deployedAtMs - bounds.seekMarginMs,
        toMs: ref.deployedAtMs + reachMs,
        requests: 0,
      };

      if (query === null) {
        const refused = duneRowsToWindow([], {
          mint: ref.mint,
          createdAtMs: ref.deployedAtMs,
          windowSlotSpan: bounds.windowSlotSpan,
          scan,
        });
        return {
          ...refused,
          dropReason: 'coverage-unproven',
          note:
            `DROPPED: this run carries no committed entry statement, so the Dune fill source has ` +
            `nothing to execute. Captain decision 258b lands that statement and its pinned ` +
            `saved-query id; until it does, this source refuses every window rather than ` +
            `returning one it cannot vouch for.`,
        };
      }

      // BEFORE anything is billed. A saved query is editable from a browser and its answer is a
      // measurement input, so a repo/vendor disagreement refuses the leg terminally and costs
      // nothing — the same order `dune.mjs`'s enumeration is held to.
      await assertSavedQueryMatches(client, query.id, query.sql);
      const issuedBefore = client.issued();
      const result = await executeAndRead(client, query.id, query.parameters(ref, scan), opts.bounds);
      scan.requests = client.issued() - issuedBefore;

      return duneRowsToWindow(result.rows, {
        mint: ref.mint,
        createdAtMs: ref.deployedAtMs,
        windowSlotSpan: bounds.windowSlotSpan,
        scan,
      });
    },
  };
}
