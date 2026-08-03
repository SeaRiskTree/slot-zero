/**
 * Creation enumeration over Dune — **the primary answer to "which mints did this wallet create"**
 * since captain decision 156a (`data/decisions/156-slot-zero-dune-vs-helius-creation-walk.md`).
 *
 * ## What this replaces, and what it deliberately does not
 *
 * `creation.mjs` states the defect: every pump.fun and reseller surface answers *"which tokens does
 * this wallet OWN NOW"*, ownership is a sellable position, and the ones worth handing on are the
 * winners — so the ownership reading scores the better dev worse and a false rejection is invisible.
 * The route out of that was a Solana signature walk, keyless or (from 2026-08-03) indexed through
 * Helius. Dune answers the same question from the decoded creation event, in ONE query for a whole
 * candidate batch, for a fraction of a free monthly allowance.
 *
 * **The walk is not deleted; it is the fallback.** It runs when there is no Dune key, when Dune
 * fails, or when the coverage probe below refuses a wallet's reading. And **Helius stays primary and
 * necessary for every transaction-level measurement** — Stage 2's entry-cost leg reads `meta.fee`
 * and pre/post balances per transaction, which no decoded table serves. Nothing in this module may
 * reach a Stage 2 entry number or Stage 3: room to enter is not room to leave, and an enumeration
 * source is neither.
 *
 * ## The two traps, both of which return a confident wrong answer
 *
 * 1. **Table choice.** Dune decodes `Create` and `CreateV2` into SEPARATE tables, with a third for
 *    the `CreateEvent` both emit. `pump_call_create` alone returns **zero rows** for our subject,
 *    which launches with CreateV2. `pump_call_create_v2` alone is not backfilled before roughly
 *    2026-04-28 and silently misses **101 of our 239 launches, `maxxing` included**. Only
 *    `pump_evt_createevent` UNION `pump_call_create` spans both boundaries — on a straddling
 *    third-party wallet it recovers 53 launches where either table alone recovers 31 or 35.
 *    {@link CREATION_SQL} is that union and nothing else may be substituted for it.
 * 2. **Attribution.** `creator` is a settable `CreateV2` ARGUMENT, not proof of authorship: six
 *    mints declare our subject as `creator` while being signed by six different bot-shaped wallets,
 *    inflating the count 247 → 253. Authorship keys on `"user"` / `account_user`, the signer.
 *
 * ## The binding condition: no count without its own coverage probe
 *
 * Decoded tables have **silent start dates**. They return a confident, well-formed, complete-looking
 * answer that is simply wrong before their first row, and nothing in the response says so. It is the
 * same failure shape as a truncated backwards walk in `pumpfun.mjs` — `meta.reached_mint` exists for
 * exactly this — and it fails in the same direction: plausible and silent.
 *
 * So every Dune-derived count here ships with {@link CoverageProbe}: `min(block_time)`,
 * `max(block_time)` and monthly row counts for the exact tables the enumeration reads.
 * {@link assessCoverage} refuses a reading that reaches outside it, and a refused reading falls back
 * to the walk rather than being published. The probe also reads `pump_call_create_v2`, which the
 * enumeration does NOT use, so the tool demonstrates the boundary that disqualifies it rather than
 * asserting it in prose.
 *
 * ## The same rule applied past coverage: a reading that cannot vouch for itself falls back
 *
 * Coverage is one way a Dune answer stops being able to account for itself, and it is not the only
 * one. Four more, each of which produces a complete-LOOKING answer that is short, and each of which
 * therefore refuses rather than publishes:
 *
 * - **A row the parser could not read**, INCLUDING one whose `bonded` is not a boolean.
 *   `unreadableRows > 0` refuses the WHOLE batch, not the wallet the row belonged to — a row that
 *   fails to parse commonly has no readable `deployer`, so the wallet whose history went short is
 *   exactly the wallet that cannot be named, and a shifted column shifts for every row at once.
 * - **A wallet the enumeration returned NO row for.** That is an absence of evidence, not evidence
 *   of absence, and gating a wallet on a zero-launch history built from it is the invisible false
 *   rejection this whole lane exists to remove. See {@link toWalletEnumeration}.
 * - **A wallet whose address is not base58-shaped.** Every wallet here is vendor-supplied and lands
 *   inside a single-quoted SQL literal, so {@link isEnumerableWallet} is checked before the batch is
 *   sent and anything failing it is dropped from the parameter and counted.
 * - **A result read that cannot prove it is whole** — no declared total, a total over the ceiling,
 *   rows sitting exactly on the `?limit=`, or rows disagreeing with the declared total, which is
 *   Dune paging on response size rather than on ours. See {@link DuneResultSet}'s reader.
 * - **A wallet whose rows the per-deployer cap TRUNCATED.** {@link CREATION_SQL} returns at most
 *   {@link launchCapPerWallet} rows per deployer and carries each deployer's TRUE count beside them,
 *   so a truncated history is detected exactly — rows returned below `launches_total` — and refused.
 *   The cap is deliberate truncation rather than a vendor failure, and the two must not be confused:
 *   see {@link toWalletEnumeration} for why a capped wallet is never a short-but-complete history.
 *
 * Every one of them leaves `usable: false` with a whole-sentence reason, and the candidate takes the
 * walk. Falling back costs wall clock; publishing a count the evidence does not support costs a
 * verdict, and that is the expensive side of the trade.
 *
 * ## The refusal's GRANULARITY is the wallet, not the batch, wherever the wallet can be named
 *
 * One execution answers for a whole batch, so a batch-wide refusal is expensive in a way a
 * per-wallet one is not: every OTHER candidate loses a ~1-credit Dune answer and takes a walk
 * measured in hours. The result-row ceiling used to be exactly that — one industrial-spam deployer
 * (`README.md` records an 8,518-deploy wallet reachable from the `total_bonded` leaderboard, which
 * is one of the three seeds) carried the whole batch past `maxResultRows` and sent EVERY candidate
 * to the walk. {@link CREATION_SQL}'s per-deployer cap moves that refusal onto the one wallet that
 * earned it. The batch-level ceiling in {@link DuneResultSet}'s reader is NOT deleted: it stays as
 * the backstop, and under {@link LAUNCH_CAP_FLOOR} it is genuinely reachable rather than
 * unreachable-by-a-bug — roughly 40 wallets of 500+ launches in one batch put a result past it, and
 * the run then falls back exactly as it did before the cap existed. Two bounds hold and they are
 * different bounds: BYTES at `?limit=maxResultRows` (<=20,000 rows at <=121 bytes/row, ~2.42 MB),
 * and ROWS from the SQL at `max(`{@link SQL_ROW_CEILING}`, <deployers> × 500)` with the ceiling
 * refusing anything above `maxResultRows` rather than publishing it.
 *
 * ## Spend
 *
 * **A FAILED EXECUTION IS STILL BILLED AND IT IS TERMINAL** — `client.mjs` → {@link
 * import('./client.mjs').DuneClient} never retries one, and nothing here may add a retry around it.
 * Budget from *billed* credits, not `execution_cost_credits`, which understates by about 3.5×
 * because retrieving results is ~71% of the bill at ~20 credits/MB. Hence: aggregate server-side,
 * select only the columns the tool reads, and fetch each execution's results exactly once. The
 * coverage probe is parameterless, so it defaults to a CACHED read that costs no execution at all.
 *
 * **`derive and discard`, as for MadeOnSol.** Per-launch rows live in memory for one run; only
 * derived counts are ever written, and only with `--out`. Nothing here caches a result between runs.
 */

import { DuneRefused } from './client.mjs';

/**
 * The row ceiling {@link CREATION_SQL} divides between the batch's deployers, written as a literal
 * inside that SQL because a saved query cannot read `thresholds.json`.
 *
 * It is `dune.maxResultRows - 1`: one under the ceiling {@link DuneResultSet}'s reader refuses at,
 * so a result honouring the derived half of the cap can never sit ON its own `?limit=` either. The
 * duplication is real and it is guarded — `test/deployer-screen.test.ts` → "the SQL's per-deployer
 * cap is derived from the pinned row ceiling" fails if this number and the pinned threshold stop
 * agreeing, because the saved query would then bound a run at a size the reader no longer accepts.
 *
 * **It does NOT bound a run's rows on its own.** {@link LAUNCH_CAP_FLOOR} is a floor under the
 * share-out, so above 39 deployers the floor binds and the rows bound is `<deployers> × 500`. See
 * {@link launchCapPerWallet} for the bound that actually holds and why the batch-level ceiling is
 * kept as the backstop that refuses anything past `maxResultRows`.
 */
export const SQL_ROW_CEILING = 19999;

/**
 * The floor under the per-deployer cap, mirrored as a literal in {@link CREATION_SQL}'s `cap` CTE.
 *
 * **It exists so that no deployer this repo has ever measured is capped at any batch size.** A
 * purely derived cap makes the truncation threshold a function of batch size, and at the tool's own
 * 195-candidate cap the share-out is 102 rows — which would refuse the subject deployer (247
 * launches, the reproduction control) and `4q4GKBpV…` (152) on every full run, biasing the fallback
 * towards exactly the largest and most gate-relevant wallets.
 *
 * 500 is anchored on the only per-wallet counts this repo holds: 8, 10, 65, 152 and 247
 * (`CREATION-DERIVED.md` §8.3). It is ~2× the largest of them, so the whole measured population
 * enumerates whole at any batch size, and ~17× below the industrial-spam extreme the `total_bonded`
 * leaderboard serves (8,518 deploys), so a spam wallet is still contained to 500 rows rather than
 * pricing the batch at 8,518.
 */
export const LAUNCH_CAP_FLOOR = 500;

/**
 * How many rows one deployer may contribute to a batch of `walletCount` deployers.
 *
 * The same arithmetic {@link CREATION_SQL} performs server-side, mirrored here so the tool can name
 * the cap in a refusal reason. It is `max(`{@link LAUNCH_CAP_FLOOR}`, ceiling shared out)`: the
 * share-out is what keeps a small batch's bill bounded by the pinned ceiling, and the floor is what
 * keeps an ordinary deployer whole in a large one.
 *
 * **The bound this produces, stated as it actually holds** — because the share-out alone would have
 * bounded a run at {@link SQL_ROW_CEILING} rows and the floor breaks that above 39 deployers:
 *
 * - **BYTES, unchanged and provable.** Every result read is issued with `?limit=maxResultRows`, so
 *   no read returns more than 20,000 rows at <=121 bytes/row, i.e. <=~2.42 MB.
 * - **ROWS from the SQL: at most `max(`{@link SQL_ROW_CEILING}`, <deployers> × 500)`.** Above 39
 *   deployers that exceeds `maxResultRows`, and the batch-level ceiling in {@link DuneResultSet}'s
 *   reader REFUSES such a result rather than publishing it — the whole-batch fallback merged `main`
 *   already had. It takes roughly 40 wallets of 500+ launches in one batch to get there, which the
 *   `total_bonded` leaderboard seed can serve; that is the accepted trade for never truncating a
 *   measured wallet.
 *
 * A wallet above its run's cap falls back to the walk, which is the slow answer rather than a wrong
 * one — and the record carries enough to recompute the cap exactly
 * (`thresholds.dune.maxResultRows`, the gated candidate count and `dune.walletsRefusedByShape`), so
 * what a run applied is auditable after the fact.
 *
 * @param {number} walletCount How many deployers went into the query parameter.
 * @param {number} maxResultRows The pinned result-row ceiling — `dune.maxResultRows`.
 * @returns {number} Rows per deployer, never below {@link LAUNCH_CAP_FLOOR}.
 */
export function launchCapPerWallet(walletCount, maxResultRows) {
  return Math.max(LAUNCH_CAP_FLOOR, Math.floor((maxResultRows - 1) / Math.max(1, walletCount)));
}

/**
 * The enumeration query's SQL, committed byte for byte.
 *
 * A saved Dune query is editable from a browser and its answer is a gate input, so
 * {@link assertSavedQueryMatches} compares this text against the saved query before an execution is
 * spent. Drift fails loudly instead of returning a different measurement under the same name.
 *
 * **DEPLOY STEP: changing this text means updating saved query `8204672` in place.** The comparison
 * runs BEFORE the execution, so a mismatch is not a wrong answer — it is a terminal refusal of the
 * whole Dune leg on every run until the saved query is restored to this text. The free tier holds
 * only 10 private queries and the account holds 10, so there is no new query to create: the
 * production one is edited. `README.md` → "Deploying a change to the committed SQL" owns the step.
 */
export const CREATION_SQL = `-- slot-zero: ORIGINAL-CREATOR launch enumeration. One execution per candidate batch.
--
-- Committed byte for byte as CREATION_SQL in tools/deployer-screen/dune.mjs, and that module
-- refuses to spend an execution unless the saved query still matches it. A saved query is
-- editable from a browser; the answer it returns is a gate input, so drift must fail loudly.
--
-- UNION of two surfaces, deduped by mint, because NEITHER spans both coverage boundaries:
--   pump_evt_createevent  decodes the CreateEvent that BOTH Create and CreateV2 emit, from 2024-04
--   pump_call_create      decodes the original Create instruction only, from 2024-01
-- pump_call_create_v2 is deliberately ABSENT: it is not backfilled before ~2026-04-28 and
-- silently misses 101 of our subject's 239 launches, \`maxxing\` among them.
--
-- Attribution is "user" / account_user, the SIGNER of the creation. \`creator\` is a settable
-- CreateV2 argument and is NOT proof of authorship: six mints declare our subject as \`creator\`
-- while being signed by six different bot-shaped wallets.
--
-- FIVE COLUMNS AND NO MORE, because retrieving results is ~71% of the bill at ~20 credits/MB.
-- The create transaction and the graduation timestamp were both dropped once the tool was shown
-- not to read them; that halves the bytes of every production run. The fifth, launches_total, is
-- a bigint and it is what makes the cap below DETECTABLE rather than silent.
--
-- THE CAP IS PER DEPLOYER, NOT PER BATCH, and that is the whole point of this shape. Each
-- deployer contributes at most greatest(500, floor(19999 / <deployers in the batch>)) rows.
-- Without it a single industrial-spam wallet (8,518 deploys is a real row on the total_bonded
-- leaderboard this tool seeds from) pushes the whole batch past dune.maxResultRows and EVERY
-- candidate in the run loses its Dune answer to a walk measured in hours.
--
-- THE 500 IS A FLOOR, NOT A SECOND SHARE-OUT, and it is why the rows bound is
-- max(19999, <deployers> x 500) rather than 19,999 flat: the share-out alone is 102 rows at the
-- tool's 195-candidate cap, which would truncate the subject deployer (247 launches) and
-- 4q4GKBpV (152) on every full run. 500 is ~2x the largest history this repo has measured, so no
-- measured deployer is ever capped, and ~17x below the spam extreme. Above ~40 deployers of 500+
-- launches the result can exceed the reader's ceiling, and the reader then refuses the whole
-- batch exactly as it did before this cap existed. That backstop is kept, not loosened.
--
-- launches_total is each deployer's TRUE count, computed BEFORE the cap. So truncation is
-- detected exactly — rows returned below launches_total — and only the truncated deployer falls
-- back to the walk. A capped deployer must never be read as a short-but-complete history, which
-- is why the count travels with the rows rather than being inferred from them.
--
-- THE SURVIVING PREFIX IS THE MOST RECENT LAUNCHES, so row_number() ranks created_at DESC. This
-- tool asks what a wallet is creating NOW; a capped deployer's oldest launches are the least
-- informative rows it could keep.
WITH deployers AS (
  SELECT trim(w) AS wallet FROM unnest(split('{{deployers}}', ',')) AS t(w)
), ev AS (
  SELECT e."user" AS deployer, e.mint AS mint, e.evt_block_time AS created_at
  FROM pumpdotfun_solana.pump_evt_createevent e
  JOIN deployers d ON d.wallet = e."user"
), cl AS (
  SELECT c.account_user AS deployer, c.account_mint AS mint, c.call_block_time AS created_at
  FROM pumpdotfun_solana.pump_call_create c
  JOIN deployers d ON d.wallet = c.account_user
), deduped AS (
  SELECT deployer, mint, min(created_at) AS created_at
  FROM (SELECT * FROM ev UNION ALL SELECT * FROM cl)
  GROUP BY 1, 2
), ranked AS (
  SELECT b.deployer, b.mint, b.created_at,
         row_number() OVER (PARTITION BY b.deployer ORDER BY b.created_at DESC, b.mint DESC) AS rn,
         count(*) OVER (PARTITION BY b.deployer) AS launches_total
  FROM deduped b
), cap AS (
  SELECT greatest(500, cast(floor(19999.0 / greatest(count(DISTINCT wallet), 1)) AS bigint)) AS max_rows
  FROM deployers
)
SELECT r.deployer, r.mint, r.created_at, (c.mint IS NOT NULL) AS bonded, r.launches_total
FROM ranked r
LEFT JOIN (SELECT DISTINCT mint FROM pumpdotfun_solana.pump_evt_completeevent) c ON c.mint = r.mint
WHERE r.rn <= (SELECT max_rows FROM cap)
ORDER BY r.deployer, r.created_at
`;

/**
 * The coverage probe's SQL, committed byte for byte. See {@link CREATION_SQL} for why the text
 * lives here rather than only on Dune.
 */
export const COVERAGE_SQL = `-- slot-zero: COVERAGE PROBE for the create surfaces the enumeration reads.
--
-- Committed byte for byte as COVERAGE_SQL in tools/deployer-screen/dune.mjs, which refuses to
-- read a result unless the saved query still matches it.
--
-- WHY EVERY DUNE-DERIVED COUNT SHIPS WITH THIS: decoded tables have SILENT START DATES. They
-- return a confident, well-formed, complete-looking answer that is simply wrong before their
-- first row, and nothing in the response says so. Same failure shape as a truncated backwards
-- walk in pumpfun.mjs, and it fails in the same direction: plausible and silent.
--
-- pump_call_create_v2 is probed but NOT read by the enumeration. It is here so the probe itself
-- demonstrates the boundary that disqualifies it, rather than the repo asserting it in prose.
SELECT 'evt_createevent' AS tbl, 'first_row' AS metric, min(evt_block_time) AS at, count(*) AS n
FROM pumpdotfun_solana.pump_evt_createevent
UNION ALL
SELECT 'evt_createevent', 'last_row', max(evt_block_time), count(*)
FROM pumpdotfun_solana.pump_evt_createevent
UNION ALL
SELECT 'evt_createevent', 'month', date_trunc('month', evt_block_time), count(*)
FROM pumpdotfun_solana.pump_evt_createevent GROUP BY 1, 2, 3
UNION ALL
SELECT 'call_create', 'first_row', min(call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create
UNION ALL
SELECT 'call_create', 'last_row', max(call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create
UNION ALL
SELECT 'call_create', 'month', date_trunc('month', call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create GROUP BY 1, 2, 3
UNION ALL
SELECT 'call_create_v2', 'first_row', min(call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create_v2
UNION ALL
SELECT 'call_create_v2', 'last_row', max(call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create_v2
UNION ALL
SELECT 'call_create_v2', 'month', date_trunc('month', call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create_v2 GROUP BY 1, 2, 3
ORDER BY 1, 2, 3
`;

/**
 * The tables the enumeration actually READS, in the order {@link CREATION_SQL} unions them.
 *
 * `call_create_v2` is deliberately not here even though the probe returns it. That asymmetry is the
 * point: the probe is wider than the read so its own output demonstrates why the third table is
 * refused. A future change that adds a table to the SQL must add it here, or {@link assessCoverage}
 * will be probing a surface the query no longer matches — which is the silent failure this module
 * exists to make loud.
 */
export const ENUMERATION_TABLES = ['evt_createevent', 'call_create'];

/**
 * The parameter name {@link CREATION_SQL} declares. Named once so a rename cannot half-happen.
 */
export const DEPLOYERS_PARAM = 'deployers';

/**
 * The base58 wallet shape, and the ONLY strings {@link enumerateCreations} will put in a Dune query
 * parameter.
 *
 * **This is the first path in this repository where a vendor-supplied string reaches a query
 * language.** Every other consumer neutralises it — `encodeURIComponent` for the MadeOnSol URL, a
 * JSON parameter for the RPC walk — but Dune substitutes text parameters into the query TEXT, and
 * {@link CREATION_SQL} interpolates `{{deployers}}` inside the single-quoted literal
 * `split('{{deployers}}', ',')`. A wallet carrying a quote would close that literal and alter a
 * statement that is executed and billed on this account. Nothing upstream validates the shape:
 * `seed.mjs` → `extractWallets` accepts any non-empty string a MadeOnSol payload puts in
 * `wallet_address` / `wallet` / `address` / `deployer_wallet` / `creator`.
 *
 * A comma is excluded by the alphabet rather than by a separate rule, which matters because the
 * parameter is comma-joined: a wallet containing one would silently become two filter entries.
 */
export const WALLET_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Whether a candidate's address may be sent to Dune at all. See {@link WALLET_SHAPE}.
 *
 * @param {unknown} wallet
 * @returns {boolean}
 */
export function isEnumerableWallet(wallet) {
  return typeof wallet === 'string' && WALLET_SHAPE.test(wallet);
}

/**
 * Parse one of Dune's timestamps to epoch milliseconds.
 *
 * **TWO SPELLINGS, and both have to work.** Result rows carry `2025-12-01 19:37:59.000 UTC` — a
 * space, three fractional digits and a trailing zone word. The execution envelope carries
 * `2026-08-03T09:12:21.429632Z` — a `T`, SIX fractional digits and a `Z`. A parser accepting only
 * the first returns `null` for the second, which is how `probedAtIso` reads `null` on a probe that
 * plainly has a timestamp. Sub-millisecond digits are truncated rather than rounded, because this
 * value is compared against a coverage bound and rounding up would claim coverage of an instant the
 * table does not hold.
 *
 * Hand-parsed rather than handed to `Date`, because `new Date('2025-12-01 19:37:59.000 UTC')` is not
 * a format any standard requires an engine to accept: V8 takes it, another runtime may return
 * `Invalid Date`, and a silently-NaN creation time would flow straight into a covered-window
 * comparison that then admits or refuses the wrong launches. A strict parser returns `null` and the
 * caller refuses the row.
 *
 * @param {unknown} value
 * @returns {number | null} Epoch ms, or `null` when the value is not a timestamp this understands.
 */
export function parseDuneTimestamp(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(?:UTC|Z)?$/.exec(value.trim());
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    frac === undefined ? 0 : Number(frac.padEnd(3, '0').slice(0, 3)),
  );
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @typedef {object} TableCoverage
 * @property {string} table       Table name as the probe labels it.
 * @property {number} firstRowMs  Oldest block time the table holds. **The silent start date.**
 * @property {number} lastRowMs   Newest block time the table holds.
 * @property {number} rowsTotal   Rows in the whole table.
 * @property {{ monthMs: number, rows: number }[]} months Monthly row counts, ascending.
 */

/**
 * @typedef {object} CoverageProbe
 * @property {TableCoverage[]} tables   Every table probed, INCLUDING ones the enumeration does not
 *   read — see {@link ENUMERATION_TABLES}.
 * @property {number | null} probedAtMs When the probe's execution finished, or `null` when the
 *   vendor did not say. Freshness is a coverage property here: a cached probe whose newest row
 *   predates the enumeration cannot vouch for the enumeration's recent end.
 * @property {boolean} fromCache        True when the probe came from Dune's cached results rather
 *   than a fresh execution. Recorded because it changes what the probe can claim, not because it
 *   changes what it says.
 */

/**
 * Turn the probe query's rows into {@link CoverageProbe}.
 *
 * @param {readonly unknown[]} rows
 * @param {{ probedAtMs?: number | null, fromCache?: boolean }} [meta]
 * @returns {CoverageProbe}
 */
export function parseCoverageProbe(rows, meta) {
  /** @type {Map<string, { first: number | null, last: number | null, rowsTotal: number, months: { monthMs: number, rows: number }[] }>} */
  const byTable = new Map();
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const table = row['tbl'];
    const metric = row['metric'];
    if (typeof table !== 'string' || typeof metric !== 'string') continue;
    const at = parseDuneTimestamp(row['at']);
    const n = typeof row['n'] === 'number' ? row['n'] : Number(row['n']);
    if (at === null || !Number.isFinite(n)) continue;
    let entry = byTable.get(table);
    if (entry === undefined) {
      entry = { first: null, last: null, rowsTotal: 0, months: [] };
      byTable.set(table, entry);
    }
    if (metric === 'first_row') {
      entry.first = at;
      entry.rowsTotal = n;
    } else if (metric === 'last_row') {
      entry.last = at;
      entry.rowsTotal = n;
    } else if (metric === 'month') {
      entry.months.push({ monthMs: at, rows: n });
    }
  }

  /** @type {TableCoverage[]} */
  const tables = [];
  for (const [table, e] of byTable) {
    if (e.first === null || e.last === null) continue;
    tables.push({
      table,
      firstRowMs: e.first,
      lastRowMs: e.last,
      rowsTotal: e.rowsTotal,
      months: e.months.sort((a, b) => a.monthMs - b.monthMs),
    });
  }
  tables.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
  return {
    tables,
    probedAtMs: meta?.probedAtMs ?? null,
    fromCache: meta?.fromCache ?? false,
  };
}

/** First instant of the UTC month containing `ms`. @param {number} ms @returns {number} */
function monthFloor(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** The UTC month after `monthMs`. @param {number} monthMs @returns {number} */
function nextMonth(monthMs) {
  const d = new Date(monthMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * @typedef {object} CoverageAssessment
 * @property {boolean} ok         Whether the probed surfaces may be read at all this run.
 * @property {number | null} fromMs Oldest instant the UNION of the read tables covers, `null` when
 *   the probe could not establish one. **`null` means covered NOTHING**, never "since the epoch" —
 *   the same rule `creation.mjs` → `coveredBoundMs` states for the walk's window, and for the same
 *   reason: a `0` sentinel there reads as a 56-year window that contains every timestamp.
 * @property {number | null} toMs Newest instant the union covers.
 * @property {string[]} reasons   Why the probe refuses, empty when it does not. Every entry is a
 *   whole sentence, because these reach a run record and a rendered line.
 * @property {{ monthIso: string }[]} holes Months inside the covered span where the union of read
 *   tables holds NO row at all. A hole is the `create_v2` failure arriving in the middle rather than
 *   at the start, and it is what stops this probe from being a start-date check wearing a longer name.
 * @property {boolean} staleOnly True when staleness is the ONLY thing wrong. That case is
 *   repairable by re-executing the probe, which {@link enumerateCreations} does once; a hole or a
 *   missing table is not repairable by asking again and falls straight through to the walk.
 */

/**
 * Decide whether the probed coverage lets a Dune count be published at all.
 *
 * Three refusals, and each one is a way a confident wrong answer gets out:
 *
 * 1. **A read table is missing from the probe, or holds no rows.** The enumeration would then be
 *    reading a surface nothing vouched for.
 * 2. **A hole inside the covered span.** Any month between the union's first and last row where
 *    both read tables return zero. This is the `pump_call_create_v2` defect stated mechanically:
 *    had that table been the one read, every month from 2025-12 to 2026-03 would be empty here.
 * 3. **Staleness.** The union's newest row is older than `maxCoverageLagMs`. The probe cannot vouch
 *    for a period it does not reach, and the recent end is exactly where a live screen looks.
 *
 * @param {object} input
 * @param {CoverageProbe} input.probe
 * @param {number} input.nowMs
 * @param {{ maxCoverageLagMs: number }} input.bounds
 * @param {readonly string[]} [input.tables] Defaults to {@link ENUMERATION_TABLES}.
 * @returns {CoverageAssessment}
 */
export function assessCoverage(input) {
  const wanted = input.tables ?? ENUMERATION_TABLES;
  /** @type {string[]} */
  const reasons = [];
  /** @type {TableCoverage[]} */
  const read = [];

  for (const name of wanted) {
    const t = input.probe.tables.find((x) => x.table === name);
    if (t === undefined) {
      reasons.push(
        `the coverage probe returned nothing for \`${name}\`, which the enumeration reads — so no ` +
          `count from it is bounded and none may be published.`,
      );
      continue;
    }
    if (t.rowsTotal <= 0) {
      reasons.push(
        `\`${name}\` holds no rows at all, so the enumeration would be reading an empty surface and ` +
          `reporting the result as a launch history.`,
      );
      continue;
    }
    read.push(t);
  }

  if (read.length === 0) {
    return { ok: false, fromMs: null, toMs: null, reasons, holes: [], staleOnly: false };
  }

  const fromMs = Math.min(...read.map((t) => t.firstRowMs));
  const toMs = Math.max(...read.map((t) => t.lastRowMs));

  // Monthly union across the read tables. A month absent from every one of them is a hole.
  /** @type {Map<number, number>} */
  const unionMonths = new Map();
  for (const t of read) {
    for (const m of t.months) unionMonths.set(m.monthMs, (unionMonths.get(m.monthMs) ?? 0) + m.rows);
  }
  /** @type {{ monthIso: string }[]} */
  const holes = [];
  for (let m = monthFloor(fromMs); m <= monthFloor(toMs); m = nextMonth(m)) {
    if ((unionMonths.get(m) ?? 0) <= 0) holes.push({ monthIso: new Date(m).toISOString().slice(0, 7) });
  }
  if (holes.length > 0) {
    reasons.push(
      `the probed surfaces hold NO row at all in ${holes.length} month(s) inside their own covered ` +
        `span (${holes.map((h) => h.monthIso).join(', ')}). A decoded table with a gap returns a ` +
        `complete-looking answer that is simply missing those launches, so no count over this span ` +
        `may be published.`,
    );
  }

  const structuralReasons = reasons.length;
  const lagMs = input.nowMs - toMs;
  if (lagMs > input.bounds.maxCoverageLagMs) {
    reasons.push(
      `the probed surfaces' newest row is ${(lagMs / 3_600_000).toFixed(1)} h old, past the pinned ` +
        `${(input.bounds.maxCoverageLagMs / 3_600_000).toFixed(1)} h. The probe cannot vouch for a ` +
        `period it does not reach, and the recent end is where a live screen looks.`,
    );
  }

  return {
    ok: reasons.length === 0,
    fromMs,
    toMs,
    reasons,
    holes,
    staleOnly: structuralReasons === 0 && reasons.length > 0,
  };
}

/**
 * @typedef {object} DuneLaunch
 * @property {string} mint
 * @property {number} createdAtMs
 * @property {boolean} bonded Whether `pump_evt_completeevent` holds this mint — the chain's own
 *   statement that the curve completed, and the same transition the on-chain `complete` byte records.
 */

/**
 * Group the enumeration query's rows by deployer.
 *
 * Rows whose timestamp will not parse, whose mint or deployer is missing, or whose `bonded` is not a
 * BOOLEAN are counted rather than dropped silently: a partly-unreadable answer is not a shorter
 * answer, and a wallet whose rows went unread must fall back to the walk rather than be gated on
 * what survived.
 *
 * **`bonded` is type-checked, not truth-checked, and it is the column that most needs it.** `false`
 * is a legitimate value there, so `=== true` would collapse "the column is gone" into "this launch
 * did not bond" — a `LEFT JOIN pump_evt_completeevent` whose spelling shifts would make every
 * candidate in the batch read 0% bonded and gate-FAIL, on a run reporting itself fully measured.
 * Absent and legitimately-false must not be indistinguishable, so an absent one takes the same route
 * a bad timestamp already does rather than a second, weaker one of its own.
 *
 * **`launches_total` is checked exactly as hard as `bonded`, and for the same reason.** It is the
 * deployer's true count before {@link CREATION_SQL}'s per-deployer cap, and it is the ONLY thing
 * that distinguishes a capped history from a whole one. A missing or non-numeric value therefore
 * counts the row unreadable rather than defaulting to "not capped": a default would delete the cap's
 * detection the day the column is renamed, and every capped wallet would be gated on a prefix of its
 * history reported as a total — silently, on a run reporting itself fully measured.
 *
 * `declaredByWallet` carries that count per wallet, or `null` when the wallet's own rows disagreed
 * about it. A disagreement is nameable per wallet, unlike a parse failure, so it refuses that wallet
 * rather than the batch — see {@link toWalletEnumeration}.
 *
 * **`unreadableRows > 0` refuses the WHOLE batch**, in {@link enumerateCreations}, and the blast
 * radius is deliberate rather than lazy. A row that fails to parse commonly has no readable
 * `deployer` — that is one of the ways it fails to parse — so the wallet whose history came
 * back short is exactly the wallet that cannot be named. Attributing the damage per wallet would
 * leave the affected one gated on a silently short history, which is the confident-wrong-answer
 * shape this module exists to refuse, arriving through the parser instead of through coverage.
 *
 * @param {readonly unknown[]} rows
 * @returns {{ byWallet: Map<string, DuneLaunch[]>, declaredByWallet: Map<string, number | null>, unreadableRows: number }}
 */
export function parseCreationRows(rows) {
  /** @type {Map<string, DuneLaunch[]>} */
  const byWallet = new Map();
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  /** @type {Map<string, number | null>} */
  const declaredByWallet = new Map();
  let unreadableRows = 0;

  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) {
      unreadableRows += 1;
      continue;
    }
    const row = /** @type {Record<string, unknown>} */ (raw);
    const deployer = row['deployer'];
    const mint = row['mint'];
    const createdAtMs = parseDuneTimestamp(row['created_at']);
    // `bonded` is TYPE-checked rather than read as `=== true`, and it is the one column where that
    // distinction is the whole point: `false` is a legitimate value, so a truthiness test collapses
    // "the column is gone" into "this launch did not bond". A LEFT JOIN whose column shifts would
    // then make every candidate in the batch read 0% bonded and gate-fail, with `unreadableRows: 0`
    // and a clean coverage probe reporting the run as fully measured.
    const bonded = row['bonded'];
    // The deployer's TRUE launch count, before CREATION_SQL's per-deployer cap. Read as strictly as
    // `bonded` and for the same reason: it is the only signal that says the rows are a prefix, so
    // treating an absent one as "not capped" would silently reinstate the very failure the cap
    // exists to make visible. A numeric STRING is accepted because a bigint column may arrive as
    // one; a boolean is not, so a shifted column cannot be read as the count 1.
    const declared = readRowCount(row['launches_total']);
    if (
      typeof deployer !== 'string' ||
      deployer === '' ||
      typeof mint !== 'string' ||
      mint === '' ||
      createdAtMs === null ||
      typeof bonded !== 'boolean' ||
      declared === null
    ) {
      unreadableRows += 1;
      continue;
    }
    let mints = seen.get(deployer);
    if (mints === undefined) {
      mints = new Set();
      seen.set(deployer, mints);
      byWallet.set(deployer, []);
      declaredByWallet.set(deployer, declared);
    } else if (declaredByWallet.get(deployer) !== declared) {
      // One deployer, two answers about its own size. Nameable, so it refuses this wallet only.
      declaredByWallet.set(deployer, null);
    }
    // The SQL already dedupes by (deployer, mint); this is the belt to that braces, because a
    // duplicated mint would double-count a launch on both sides of the gate's fraction.
    if (mints.has(mint)) continue;
    mints.add(mint);
    byWallet.get(deployer)?.push({ mint, createdAtMs, bonded });
  }

  for (const list of byWallet.values()) list.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return { byWallet, declaredByWallet, unreadableRows };
}

/**
 * Read a positive whole-number count out of a result cell, or `null` when the cell is not one.
 *
 * Deliberately narrower than `Number`: `true`, `null`, `''` and `'12abc'` all become numbers under
 * it, and a shifted column read as the count 1 or 0 is exactly the silent shortening this module
 * refuses. A numeric string IS accepted, because a bigint may arrive as one.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function readRowCount(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * @typedef {object} WalletEnumeration
 * @property {boolean} usable      Whether this wallet's reading may be gated on. `false` means fall
 *   back to the creation walk — never "this wallet has no launches".
 * @property {string[]} reasons    Why it is not usable, empty when it is.
 * @property {import('./creation.mjs').CreateRecord[]} creates
 * @property {Map<string, import('./creation.mjs').CurveState>} curves
 * @property {import('./creation.mjs').CoveredWindow} covered
 * @property {number} launches     Distinct mints the enumeration RETURNED for this wallet. On a
 *   usable reading that is its whole history; on one the per-deployer cap truncated it is a prefix,
 *   which is why `usable` is false there and `declaredLaunches` says how much was left behind.
 * @property {number | null} declaredLaunches The count the answer declared for this wallet
 *   (`launches_total`), before {@link CREATION_SQL}'s cap. `null` when the wallet had no row at all,
 *   or when its rows disagreed about it.
 * @property {boolean} truncatedByLaunchCap Whether this wallet was refused because the per-deployer
 *   cap cut its history. Counted at run level so a batch that lost one wallet to the cap does not
 *   look like a batch that lost nothing.
 * @property {number} bonded       How many of them the chain says completed.
 * @property {number | null} firstLaunchMs
 * @property {number | null} lastLaunchMs
 */

/**
 * Turn one wallet's rows into the shape `creation.mjs` → `mergeHistories` already consumes, and
 * decide whether that shape may be used at all.
 *
 * **The per-wallet refusal is the launch-level half of the coverage condition**, and it is the one a
 * run-level probe cannot make: a wallet whose earliest launch sits at or before the union's first
 * row may have launched before the tables begin, and there is nothing in the answer that would say
 * so. That wallet falls back to the walk. A launch NEWER than the probed ceiling is the same failure
 * from the other end, and it is reachable in practice — the probe defaults to a cached read, so an
 * enumeration executed after it can return a launch the probe never covered.
 *
 * **A wallet the enumeration returned NO row for is refused too, and that is not a reading of "this
 * wallet created nothing".** It is an absence of evidence, and treating it as evidence of absence is
 * the worst failure available here: `mergeHistories` would read `covered.exhausted` over the probe's
 * whole multi-year span, count every in-window row of that wallet's ownership listing
 * `notCreatedByWallet`, drop them, and apply the gate to a history of zero created launches. That is
 * precisely the invisible false rejection the creation-derived lane exists to remove, manufactured
 * out of nothing. It falls back to the walk, which CAN tell the two apart.
 *
 * `covered.exhausted` therefore tracks THIS wallet's usability rather than the run-level probe: a
 * refused reading must not carry a claim of exhaustive coverage into the merge even if nothing
 * downstream reads it today.
 *
 * **A wallet the per-deployer cap TRUNCATED is refused, and it is not the same thing as the vendor
 * handing back a page.** {@link CREATION_SQL} returns at most {@link launchCapPerWallet} rows per
 * deployer and carries each deployer's true `launches_total` beside them, so this is DELIBERATE
 * truncation and the tool knows its exact size. The distinction from `/results` paging on response
 * size matters and the two checks stay separate: that one compares `rows.length` against the result
 * set's own `total_row_count` and lives in {@link DuneResultSet}'s reader, where a mismatch means
 * bytes went missing in transit; this one compares the rows returned FOR ONE WALLET against the
 * count that wallet's own rows declare, where a shortfall means the query cut the history on
 * purpose. A capped wallet must never be read as a short-but-complete launch history — that is
 * precisely the invisible false rejection this lane exists to remove — so it takes the walk, which
 * enumerates the whole thing, while every other candidate in the batch keeps its Dune answer.
 *
 * A shortfall the cap does NOT explain is refused too, under its own sentence. Nothing measured
 * produces it; it is the shape a future defect would arrive in, and a reading that cannot account
 * for its own row count may not be gated on.
 *
 * `curves` carries `creator: null` on every entry, deliberately. Dune says who created a mint and
 * whether it completed; it does not say who the curve's creator is NOW, so
 * `mergeHistories.movedCreator` must not be allowed to report 0 as though it had measured one.
 *
 * @param {object} input
 * @param {string} input.wallet
 * @param {readonly DuneLaunch[]} input.launches
 * @param {CoverageAssessment} input.coverage
 * @param {number | null} [input.declaredLaunches] `launches_total` for this wallet, `null` when its
 *   rows disagreed about it. OMITTED means the caller declares nothing and the row-count check is
 *   skipped; `null` is a refusal. Only {@link enumerateCreations} is in a position to supply it.
 * @param {number | null} [input.launchCap] The per-deployer cap this run applied, for the reason's
 *   own arithmetic. See {@link launchCapPerWallet}.
 * @param {number | null} [input.batchWallets] How many deployers shared that cap.
 * @param {readonly string[]} [input.priorReasons] Batch-level refusals already established for this
 *   wallet — an unreadable row anywhere in the answer, or an address never sent. They are carried
 *   here so every refusal reaches `reasons` by one route.
 * @returns {WalletEnumeration}
 */
export function toWalletEnumeration(input) {
  const { wallet, launches, coverage } = input;
  /** @type {string[]} */
  const reasons = [...(input.priorReasons ?? [])];
  // `undefined` means the caller declared nothing — the shape check below is skipped. `null` means
  // the answer declared something that could not be reconciled, which is a refusal. The two are
  // deliberately not collapsed, and the strictness that matters lives where the absence actually
  // arrives from the network: `parseCreationRows` counts a row with no `launches_total` unreadable,
  // so a vendor omission never reaches here wearing a caller's "nothing to declare".
  const declaredSupplied = input.declaredLaunches !== undefined;
  const declaredLaunches = launches.length === 0 ? null : (input.declaredLaunches ?? null);
  const launchCap = input.launchCap ?? null;
  let truncatedByLaunchCap = false;

  const firstLaunchMs = launches.length === 0 ? null : Math.min(...launches.map((l) => l.createdAtMs));
  const lastLaunchMs = launches.length === 0 ? null : Math.max(...launches.map((l) => l.createdAtMs));

  if (!coverage.ok || coverage.fromMs === null || coverage.toMs === null) {
    reasons.push('the run-level coverage probe refused these surfaces, so no count over them is bounded.');
  } else {
    if (firstLaunchMs !== null && firstLaunchMs <= coverage.fromMs) {
      reasons.push(
        `this wallet's earliest enumerated launch (${new Date(firstLaunchMs).toISOString()}) is at or ` +
          `before the probed surfaces' own first row (${new Date(coverage.fromMs).toISOString()}), so ` +
          `its history may reach outside the probed coverage and the count would be a lower bound ` +
          `presented as a total.`,
      );
    }
    if (lastLaunchMs !== null && lastLaunchMs > coverage.toMs) {
      reasons.push(
        `this wallet's newest enumerated launch (${new Date(lastLaunchMs).toISOString()}) is newer than ` +
          `the probed surfaces' own last row (${new Date(coverage.toMs).toISOString()}), so the probe ` +
          `does not cover the period the count was read over.`,
      );
    }
  }

  // What the answer says about this wallet's SIZE, against what it handed over for it. The cap is
  // deliberate truncation and it is checked here rather than in the reader, because the reader's
  // `rows.length !== total_row_count` check is about the RESULT SET losing bytes in transit and
  // this one is about the QUERY cutting one wallet's history on purpose. Conflating them would
  // either refuse every capped batch wholesale or, far worse, let a prefix pass as a total.
  if (launches.length > 0 && declaredSupplied) {
    if (declaredLaunches === null) {
      reasons.push(
        `the Dune answer gave this wallet more than one value for its own creation total, so its ` +
          `rows cannot be reconciled with the history they claim to be. A reading that cannot ` +
          `account for its own size is refused rather than published, and the creation walk answers ` +
          `for this wallet.`,
      );
    } else if (declaredLaunches > launches.length && launchCap !== null && launches.length === launchCap) {
      truncatedByLaunchCap = true;
      reasons.push(
        `the Dune answer declares ${declaredLaunches} creation(s) for this wallet and returned ` +
          `${launches.length} of them — exactly the per-deployer cap this run applied, which is the ` +
          `greater of the pinned floor of ${LAUNCH_CAP_FLOOR} and the pinned result-row ceiling ` +
          `shared between the ${input.batchWallets ?? '?'} candidate(s) in the batch. What came back ` +
          `is its most recent ${launches.length}, a PREFIX of this wallet's history, not a short history, and ` +
          `gating on it would read a truncated count as a total. The creation walk enumerates this ` +
          `wallet instead — and only this wallet: every other candidate in the batch keeps its Dune ` +
          `answer, which is the whole reason the cap is per deployer rather than per batch.`,
      );
    } else if (declaredLaunches !== launches.length) {
      reasons.push(
        `the Dune answer declares ${declaredLaunches} creation(s) for this wallet and returned ` +
          `${launches.length} distinct mint(s), which is neither its whole history nor the ` +
          `per-deployer cap of ${launchCap ?? 'unknown'} this run applied. A reading that cannot ` +
          `account for its own row count is refused rather than published, and the creation walk ` +
          `answers for this wallet.`,
      );
    }
  }

  if (reasons.length === 0 && launches.length === 0) {
    reasons.push(
      `the enumeration returned no creation row at all for this wallet, which is an absence of ` +
        `evidence rather than evidence of absence. Reading it as a launch history of zero would let ` +
        `the merge reclassify this wallet's whole ownership listing as acquired and gate it on ` +
        `nothing, so the creation walk answers for it instead.`,
    );
  }

  /** @type {import('./creation.mjs').CreateRecord[]} */
  const creates = [];
  /** @type {Map<string, import('./creation.mjs').CurveState>} */
  const curves = new Map();
  let bonded = 0;
  for (const l of launches) {
    creates.push({
      mint: l.mint,
      // Neither is recoverable from a decoded creation event, and neither is read by the merge. They
      // are empty rather than invented; `enumerationSource` on the record says which route produced
      // the reading, so an empty signature cannot be mistaken for a walk that lost one.
      bondingCurve: '',
      signature: '',
      creator: wallet,
      createdAtMs: l.createdAtMs,
    });
    curves.set(l.mint, { complete: l.bonded, creator: null });
    if (l.bonded) bonded += 1;
  }

  const usable = reasons.length === 0;
  return {
    usable,
    reasons,
    creates,
    curves,
    covered: {
      fromMs: coverage.fromMs,
      toMs: coverage.toMs ?? 0,
      // Inside probed coverage the enumeration is EXHAUSTIVE — it is an index of creation events,
      // not a window walked backwards until a budget bit. That is the whole difference from the
      // signature walk, and it is what lets the merge label a listed-but-not-created token
      // "acquired" instead of carrying it over. It is THIS WALLET's usability rather than the
      // run-level probe: a refused reading claims no coverage it can be held to.
      exhausted: usable,
    },
    launches: launches.length,
    declaredLaunches,
    truncatedByLaunchCap,
    bonded,
    firstLaunchMs,
    lastLaunchMs,
  };
}

// --- the API calls -----------------------------------------------------------------------------

/**
 * Read a JSON object field without trusting the payload's shape.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return typeof value === 'object' && value !== null ? /** @type {Record<string, unknown>} */ (value)[key] : undefined;
}

/**
 * Normalise SQL for comparison: line endings and trailing whitespace only.
 *
 * Deliberately NOT a semantic comparison. Two texts that differ by a comment are two different
 * statements of intent, and this check exists to catch the case where somebody edited the saved
 * query — including its comments, which are where the traps are written down.
 *
 * @param {string} sql
 * @returns {string}
 */
export function normaliseSql(sql) {
  return sql.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/**
 * Verify a saved Dune query still holds the SQL this repo committed.
 *
 * Costs one request and NO execution, and it runs before the execution rather than after: the whole
 * point is to not spend a billed, unrecoverable execution on a query that no longer asks what this
 * module documents.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {number} queryId
 * @param {string} expectedSql
 * @returns {Promise<void>} Resolves when they match; throws {@link DuneRefused} when they do not.
 */
export async function assertSavedQueryMatches(client, queryId, expectedSql) {
  const body = await client.getJson(`/query/${queryId}`);
  const actual = field(body, 'query_sql');
  if (typeof actual !== 'string') {
    throw new DuneRefused(
      `Dune query ${queryId} returned no SQL, so it cannot be verified against the text committed in ` +
        `dune.mjs. Nothing was executed.`,
      { status: null, terminal: true },
    );
  }
  if (normaliseSql(actual) !== normaliseSql(expectedSql)) {
    throw new DuneRefused(
      `Dune query ${queryId} no longer matches the SQL committed in tools/deployer-screen/dune.mjs. ` +
        `A saved query is editable from a browser and its answer is a gate input, so this run refuses ` +
        `to spend an execution on it. Restore the saved query from the committed text, or update the ` +
        `committed text on purpose. Nothing was executed.`,
      { status: null, terminal: true },
    );
  }
}

/**
 * @typedef {object} DuneResultSet
 * @property {unknown[]} rows
 * @property {number} resultBytes
 * @property {number | null} endedAtMs
 */

/**
 * Pull an execution's — or a saved query's cached — result, exactly once, and account its bytes.
 *
 * **A read that cannot prove it is whole is refused, never published.** Four ways it fails to:
 * no `total_row_count` (so nothing bounds it), a declared total above `maxResultRows` (an unbounded
 * read is an unbounded bill), rows sitting exactly on the `?limit=` it was issued with, and rows
 * DISAGREEING with the declared total — `/results` pages on response size independently of our
 * limit, so a page read as a whole answer is a launch history that is simply short.
 *
 * **The row ceiling is a BACKSTOP now, not the first line — but it is still REACHABLE.** {@link
 * CREATION_SQL} bounds the enumeration at `max(`{@link SQL_ROW_CEILING}`, <deployers> × `{@link
 * LAUNCH_CAP_FLOOR}`)` rows, so a median-shaped batch cannot come near `maxResultRows`, while
 * roughly 40 wallets of 500+ launches in one batch can still exceed it. Reaching it means either
 * that genuinely oversized batch — which falls back whole, as it did before the cap existed — or a
 * cap that did not apply, i.e. a saved query edited past the pinned text or a shape this reader does
 * not understand. It is kept exactly as it was rather than loosened, because a soft bound on a
 * billed read is not a bound. Note also that the
 * per-deployer cap does NOT interact with the `rows.length !== total` check below: `total_row_count`
 * describes the RESULT SET the query produced, which is the capped one, so a capped enumeration
 * still returns exactly as many rows as it declares. Deliberate truncation is caught one level up,
 * per wallet, against `launches_total` — see {@link toWalletEnumeration}.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {string} path
 * @param {{ maxResultRows: number }} bounds
 * @returns {Promise<DuneResultSet>}
 */
async function readResult(client, path, bounds) {
  const body = await client.getJson(path);
  const result = field(body, 'result');
  const rows = field(result, 'rows');
  if (!Array.isArray(rows)) {
    throw new DuneRefused(`Dune returned no result rows for ${path}.`, { status: null, terminal: false });
  }
  const metadata = field(result, 'metadata');
  const bytes = Number(field(metadata, 'total_result_set_bytes') ?? field(metadata, 'result_set_bytes') ?? 0);
  client.noteResultBytes(bytes);
  // The request carries `?limit=maxResultRows`, so `rows.length` is NOT a substitute for the
  // declared total: a result truncated at exactly the limit would read as a complete result of that
  // size and sail through the ceiling check below. That is the same complete-looking-but-short
  // failure this module refuses everywhere else, so a missing total refuses rather than guesses.
  const declared = field(metadata, 'total_row_count');
  const total = Number(declared);
  if (declared === undefined || declared === null || !Number.isFinite(total)) {
    throw new DuneRefused(
      `Dune returned no \`total_row_count\` for ${path}, so this read cannot say whether it was ` +
        `truncated at the \`?limit=${bounds.maxResultRows}\` it was issued with. A result cut at the ` +
        `limit is indistinguishable from a complete one of that size, so it is refused rather than ` +
        `read as a launch history.`,
      { status: null, terminal: false },
    );
  }
  if (total > bounds.maxResultRows) {
    throw new DuneRefused(
      `Dune returned ${total} rows for ${path}, above the pinned ceiling of ${bounds.maxResultRows}. ` +
        `Results are billed by bytes, so an unbounded read is an unbounded bill; the reading is ` +
        `refused rather than paged.`,
      { status: null, terminal: false },
    );
  }
  if (rows.length >= bounds.maxResultRows) {
    throw new DuneRefused(
      `Dune returned exactly the ${bounds.maxResultRows} rows requested for ${path}, so this read ` +
        `sits on its own limit and cannot prove it is whole. It is refused rather than published.`,
      { status: null, terminal: false },
    );
  }
  // Our `?limit=` is not the only cut Dune makes: `/results` also pages on RESPONSE SIZE, in which
  // case `total_row_count` describes the whole result set while `rows` carries one page. A response
  // declaring 5,000 and handing back 1,200 clears every check above and reads as a complete launch
  // history 3,800 rows short — the same complete-looking-but-short failure, arriving from the
  // vendor's own paging rather than from ours. It also settles `total_row_count: ""`, which
  // `Number` makes a finite 0.
  if (rows.length !== total) {
    throw new DuneRefused(
      `Dune declared ${total} rows for ${path} and handed back ${rows.length}, so this read is a ` +
        `PAGE rather than the whole result — /results pages on response size independently of the ` +
        `\`?limit=\` it was issued with. A page read as a whole answer is a launch history that is ` +
        `simply short, so it is refused rather than published.`,
      { status: null, terminal: false },
    );
  }
  const endedAt = parseDuneTimestamp(field(body, 'execution_ended_at'));
  return { rows, resultBytes: Number.isFinite(bytes) ? bytes : 0, endedAtMs: endedAt };
}

/**
 * Run a saved query and wait for it.
 *
 * **The execution is issued exactly once.** A failed or cancelled execution is reported, never
 * retried: it is billed either way, and a second one buys a second bill for the same answer.
 * Polling is retried, because a poll is a read and a failed read costs nothing.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {number} queryId
 * @param {Record<string, string>} parameters
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, maxResultRows: number }} bounds
 * @returns {Promise<DuneResultSet>}
 */
export async function executeAndRead(client, queryId, parameters, bounds) {
  const executionId = await client.execute(queryId, parameters);
  for (let attempt = 0; attempt < bounds.maxPollAttempts; attempt++) {
    await client.wait(bounds.pollIntervalMs);
    const status = await client.getJson(`/execution/${executionId}/status`);
    const state = field(status, 'state');
    if (state === 'QUERY_STATE_COMPLETED') {
      return readResult(client, `/execution/${executionId}/results?limit=${bounds.maxResultRows}`, bounds);
    }
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED' || state === 'QUERY_STATE_EXPIRED') {
      throw new DuneRefused(
        `Dune execution of query ${queryId} ended ${String(state)}. It is billed either way and it is ` +
          `NOT retried — the creation enumeration falls back to the Solana RPC walk for this run.`,
        { status: null, terminal: true },
      );
    }
  }
  throw new DuneRefused(
    `Dune execution of query ${queryId} did not finish within ${bounds.maxPollAttempts} polls. The ` +
      `execution is billed and is not retried; the creation enumeration falls back to the Solana RPC walk.`,
    { status: null, terminal: true },
  );
}

/**
 * Read the coverage probe.
 *
 * **Defaults to Dune's CACHED results, which cost no execution at all** — the probe is
 * parameterless, so the last execution's answer is the answer, and re-executing it every run would
 * spend the binding budget on a figure that moves by one row per second. Re-execution is an explicit
 * flag, and a cached probe that is too old to vouch for the enumeration's recent end is refused by
 * {@link assessCoverage}'s staleness rule rather than used.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {object} opts
 * @param {number} opts.queryId
 * @param {boolean} opts.refresh Execute instead of reading the cache.
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, maxResultRows: number }} opts.bounds
 * @returns {Promise<CoverageProbe>}
 */
export async function readCoverageProbe(client, opts) {
  await assertSavedQueryMatches(client, opts.queryId, COVERAGE_SQL);
  const result = opts.refresh
    ? await executeAndRead(client, opts.queryId, {}, opts.bounds)
    : await readResult(client, `/query/${opts.queryId}/results?limit=${opts.bounds.maxResultRows}`, opts.bounds);
  return parseCoverageProbe(result.rows, { probedAtMs: result.endedAtMs, fromCache: !opts.refresh });
}

/**
 * @typedef {object} DuneEnumeration
 * @property {CoverageProbe} probe
 * @property {CoverageAssessment} coverage
 * @property {Map<string, WalletEnumeration>} byWallet Keyed on the wallet, for every wallet the
 *   caller asked about — including ones never sent because their address was not base58-shaped, and
 *   ones the enumeration returned no row for. Neither is a reading of "this wallet created
 *   nothing": both are `usable: false`, and the walk answers for them.
 * @property {number} unreadableRows Rows the parser could not read. **Any non-zero value refuses the
 *   whole batch** — see {@link parseCreationRows}.
 * @property {number} rowsReturned
 * @property {number} walletsRefusedByShape How many candidates were dropped from the query parameter
 *   for not matching {@link WALLET_SHAPE}. Counted rather than silently narrowing the batch.
 * @property {number} launchCap The per-deployer row cap this batch applied — {@link
 *   launchCapPerWallet} over the wallets actually sent. `0` when nothing was sent.
 * @property {number} walletsRefusedByLaunchCap How many candidates the cap truncated and therefore
 *   refused. The number that says the batch-level ceiling did NOT fire: these wallets take the walk
 *   and everyone else keeps their Dune answer.
 */

/**
 * Enumerate a whole candidate batch's creation histories in ONE execution.
 *
 * Batching is the cost model rather than a convenience: the scan cost is nearly independent of how
 * many wallets are in the filter — measured, 5 wallets and 20 wallets cost the same table scan — so
 * the per-deployer price falls as the batch grows. What scales is the bytes returned, which is why
 * the SQL selects five columns and no more, and why {@link CREATION_SQL} caps the rows ONE DEPLOYER
 * may contribute rather than letting a single spam wallet's history price the batch.
 *
 * **Every wallet asked about comes back with an answer, and "fall back to the walk" is one of the
 * answers.** A refused coverage probe, an unreadable row anywhere in the batch, an address that is
 * not base58-shaped, a history the per-deployer cap truncated, or no row for that wallet at all each
 * leave `usable: false` with a reason. None of them is ever reported as a launch history of zero.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {object} opts
 * @param {readonly string[]} opts.wallets
 * @param {number} opts.creationQueryId
 * @param {number} opts.coverageQueryId
 * @param {boolean} opts.refreshProbe
 * @param {number} opts.nowMs
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, maxResultRows: number, maxCoverageLagMs: number }} opts.bounds
 * @returns {Promise<DuneEnumeration>}
 */
export async function enumerateCreations(client, opts) {
  // The probe FIRST, and its cost is a cached read. An enumeration executed against surfaces nobody
  // has bounded is the thing this module exists to refuse, so it is not spent before the bound is in
  // hand — and if the probe refuses, the execution is never issued at all.
  let probe = await readCoverageProbe(client, {
    queryId: opts.coverageQueryId,
    refresh: opts.refreshProbe,
    bounds: opts.bounds,
  });
  let coverage = assessCoverage({ probe, nowMs: opts.nowMs, bounds: opts.bounds });

  // A cached probe that has simply gone cold is the ONE refusal asking again can fix, and it is the
  // ordinary consequence of defaulting to the cache. Re-executing it costs the second of the two
  // budgeted executions and keeps the default path self-healing; degrading a whole run to the RPC
  // walk because a free cached read was six hours old would trade ~1 credit for ~13 hours. Every
  // other refusal — a missing table, a month with no rows — asks the same question and gets the same
  // answer, so it is not retried.
  if (!coverage.ok && coverage.staleOnly && probe.fromCache) {
    probe = await readCoverageProbe(client, { queryId: opts.coverageQueryId, refresh: true, bounds: opts.bounds });
    coverage = assessCoverage({ probe, nowMs: opts.nowMs, bounds: opts.bounds });
  }

  // Shape-check BEFORE anything is spent. These addresses are vendor-supplied and land inside a
  // single-quoted SQL literal; see WALLET_SHAPE. A wallet that fails is dropped from the parameter
  // and refused like any other unusable reading — it does not vanish from the run, and it does not
  // narrow the batch silently.
  /** @type {string[]} */
  const askable = [];
  /** @type {Map<string, string[]>} */
  const priorReasons = new Map();
  for (const w of opts.wallets) {
    if (isEnumerableWallet(w)) askable.push(w);
    else {
      priorReasons.set(w, [
        `this candidate's address is not the base58 shape a Solana wallet has, so it was never put ` +
          `in the Dune query parameter — a vendor-supplied string is not allowed to reach a query ` +
          `language unchecked. The creation walk answers for it instead.`,
      ]);
    }
  }
  const walletsRefusedByShape = opts.wallets.length - askable.length;

  // The cap the SQL will apply, mirrored here so a refusal can name it. It is derived from the
  // DISTINCT wallets sent, because that is what the query's own `count(DISTINCT wallet)` counts —
  // the two arithmetics have to agree or the tool would report a cap the vendor did not apply.
  const batchWallets = new Set(askable).size;
  const launchCap = batchWallets === 0 ? 0 : launchCapPerWallet(batchWallets, opts.bounds.maxResultRows);

  /** @type {Map<string, WalletEnumeration>} */
  const byWallet = new Map();
  /** @type {(rowsByWallet: Map<string, DuneLaunch[]>, declaredByWallet: Map<string, number | null>, batchReasons: readonly string[]) => void} */
  const fill = (rowsByWallet, declaredByWallet, batchReasons) => {
    for (const w of opts.wallets) {
      byWallet.set(
        w,
        toWalletEnumeration({
          wallet: w,
          launches: rowsByWallet.get(w) ?? [],
          declaredLaunches: declaredByWallet.get(w) ?? null,
          launchCap: launchCap === 0 ? null : launchCap,
          batchWallets,
          coverage,
          priorReasons: [...(priorReasons.get(w) ?? []), ...batchReasons],
        }),
      );
    }
  };

  if (!coverage.ok || askable.length === 0) {
    fill(new Map(), new Map(), []);
    return {
      probe,
      coverage,
      byWallet,
      unreadableRows: 0,
      rowsReturned: 0,
      walletsRefusedByShape,
      launchCap,
      walletsRefusedByLaunchCap: 0,
    };
  }

  await assertSavedQueryMatches(client, opts.creationQueryId, CREATION_SQL);
  const result = await executeAndRead(
    client,
    opts.creationQueryId,
    { [DEPLOYERS_PARAM]: askable.join(',') },
    opts.bounds,
  );
  const { byWallet: rowsByWallet, declaredByWallet, unreadableRows } = parseCreationRows(result.rows);

  // A row that would not parse refuses the WHOLE batch. Not the wallet it belonged to: a row that
  // fails to parse commonly has no readable `deployer`, so the wallet whose history came back short
  // is exactly the one that cannot be named, and partial attribution would leave it gated on a
  // silently short history. See parseCreationRows.
  const batchReasons =
    unreadableRows === 0
      ? []
      : [
          `${unreadableRows} row(s) of the Dune answer could not be read, and a row that fails to ` +
            `parse commonly has no readable deployer — so the wallet whose history came back short ` +
            `cannot be named and the whole batch is refused. Every candidate in it takes the ` +
            `creation walk rather than being gated on what survived the parser.`,
        ];

  fill(rowsByWallet, declaredByWallet, batchReasons);
  let walletsRefusedByLaunchCap = 0;
  for (const e of byWallet.values()) if (e.truncatedByLaunchCap) walletsRefusedByLaunchCap += 1;
  return {
    probe,
    coverage,
    byWallet,
    unreadableRows,
    rowsReturned: result.rows.length,
    walletsRefusedByShape,
    launchCap,
    walletsRefusedByLaunchCap,
  };
}

/**
 * Project a coverage probe onto the derived figures a run record may carry.
 *
 * `derive and discard`: the probe holds table-wide monthly counts, which are the vendor's data. What
 * a record keeps is the BOUND — which tables, from when, to when, how many months, and whether the
 * span had holes — because that is what a reader needs to know what the count was allowed to claim.
 *
 * @param {CoverageProbe} probe
 * @param {CoverageAssessment} coverage
 * @returns {object}
 */
export function coverageRecordRow(probe, coverage) {
  return {
    ok: coverage.ok,
    fromIso: coverage.fromMs === null ? null : new Date(coverage.fromMs).toISOString(),
    toIso: coverage.toMs === null ? null : new Date(coverage.toMs).toISOString(),
    probedAtIso: probe.probedAtMs === null ? null : new Date(probe.probedAtMs).toISOString(),
    fromCache: probe.fromCache,
    monthsWithNoRow: coverage.holes.map((h) => h.monthIso),
    reasons: coverage.reasons,
    // Every table the probe read, including the one the enumeration refuses. A reader who wants to
    // know WHY `call_create_v2` is not in the union can see its first row here rather than take the
    // module's word for it.
    tables: probe.tables.map((t) => ({
      table: t.table,
      read: ENUMERATION_TABLES.includes(t.table),
      firstRowIso: new Date(t.firstRowMs).toISOString(),
      lastRowIso: new Date(t.lastRowMs).toISOString(),
      rowsTotal: t.rowsTotal,
      months: t.months.length,
    })),
  };
}
