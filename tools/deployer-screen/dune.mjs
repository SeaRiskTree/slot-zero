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
 * The enumeration query's SQL, committed byte for byte.
 *
 * A saved Dune query is editable from a browser and its answer is a gate input, so
 * {@link assertSavedQueryMatches} compares this text against the saved query before an execution is
 * spent. Drift fails loudly instead of returning a different measurement under the same name.
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
-- FOUR COLUMNS AND NO MORE, because retrieving results is ~71% of the bill at ~20 credits/MB.
-- The create transaction and the graduation timestamp were both dropped once the tool was shown
-- not to read them; that halves the bytes of every production run.
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
)
SELECT b.deployer, b.mint, b.created_at, (c.mint IS NOT NULL) AS bonded
FROM deduped b
LEFT JOIN (SELECT DISTINCT mint FROM pumpdotfun_solana.pump_evt_completeevent) c ON c.mint = b.mint
ORDER BY b.deployer, b.created_at
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
 * Rows whose timestamp will not parse, or whose mint or deployer is missing, are counted rather than
 * dropped silently: a partly-unreadable answer is not a shorter answer, and a wallet whose rows went
 * unread must fall back to the walk rather than be gated on what survived.
 *
 * @param {readonly unknown[]} rows
 * @returns {{ byWallet: Map<string, DuneLaunch[]>, unreadableRows: number }}
 */
export function parseCreationRows(rows) {
  /** @type {Map<string, DuneLaunch[]>} */
  const byWallet = new Map();
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
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
    if (typeof deployer !== 'string' || deployer === '' || typeof mint !== 'string' || mint === '' || createdAtMs === null) {
      unreadableRows += 1;
      continue;
    }
    let mints = seen.get(deployer);
    if (mints === undefined) {
      mints = new Set();
      seen.set(deployer, mints);
      byWallet.set(deployer, []);
    }
    // The SQL already dedupes by (deployer, mint); this is the belt to that braces, because a
    // duplicated mint would double-count a launch on both sides of the gate's fraction.
    if (mints.has(mint)) continue;
    mints.add(mint);
    byWallet.get(deployer)?.push({ mint, createdAtMs, bonded: row['bonded'] === true });
  }

  for (const list of byWallet.values()) list.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return { byWallet, unreadableRows };
}

/**
 * @typedef {object} WalletEnumeration
 * @property {boolean} usable      Whether this wallet's reading may be gated on. `false` means fall
 *   back to the creation walk — never "this wallet has no launches".
 * @property {string[]} reasons    Why it is not usable, empty when it is.
 * @property {import('./creation.mjs').CreateRecord[]} creates
 * @property {Map<string, import('./creation.mjs').CurveState>} curves
 * @property {import('./creation.mjs').CoveredWindow} covered
 * @property {number} launches     Distinct mints the enumeration attributes to this wallet.
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
 * `curves` carries `creator: null` on every entry, deliberately. Dune says who created a mint and
 * whether it completed; it does not say who the curve's creator is NOW, so
 * `mergeHistories.movedCreator` must not be allowed to report 0 as though it had measured one.
 *
 * @param {object} input
 * @param {string} input.wallet
 * @param {readonly DuneLaunch[]} input.launches
 * @param {CoverageAssessment} input.coverage
 * @returns {WalletEnumeration}
 */
export function toWalletEnumeration(input) {
  const { wallet, launches, coverage } = input;
  /** @type {string[]} */
  const reasons = [];

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

  return {
    usable: reasons.length === 0,
    reasons,
    creates,
    curves,
    covered: {
      fromMs: coverage.fromMs,
      toMs: coverage.toMs ?? 0,
      // Inside probed coverage the enumeration is EXHAUSTIVE — it is an index of creation events,
      // not a window walked backwards until a budget bit. That is the whole difference from the
      // signature walk, and it is what lets the merge label a listed-but-not-created token
      // "acquired" instead of carrying it over.
      exhausted: coverage.ok,
    },
    launches: launches.length,
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
  const total = Number(field(metadata, 'total_row_count') ?? rows.length);
  if (Number.isFinite(total) && total > bounds.maxResultRows) {
    throw new DuneRefused(
      `Dune returned ${total} rows for ${path}, above the pinned ceiling of ${bounds.maxResultRows}. ` +
        `Results are billed by bytes, so an unbounded read is an unbounded bill; the reading is ` +
        `refused rather than paged.`,
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
 * @property {Map<string, WalletEnumeration>} byWallet Keyed on the wallet, for every wallet ASKED
 *   about — including ones the enumeration returned no row for, which is a real answer (a wallet
 *   with no creation event created nothing on these surfaces) and not a missing one.
 * @property {number} unreadableRows
 * @property {number} rowsReturned
 */

/**
 * Enumerate a whole candidate batch's creation histories in ONE execution.
 *
 * Batching is the cost model rather than a convenience: the scan cost is nearly independent of how
 * many wallets are in the filter — measured, 5 wallets and 20 wallets cost the same table scan — so
 * the per-deployer price falls as the batch grows. What scales is the bytes returned, which is why
 * the SQL selects four columns.
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

  /** @type {Map<string, WalletEnumeration>} */
  const byWallet = new Map();
  if (!coverage.ok) {
    for (const w of opts.wallets) {
      byWallet.set(w, toWalletEnumeration({ wallet: w, launches: [], coverage }));
    }
    return { probe, coverage, byWallet, unreadableRows: 0, rowsReturned: 0 };
  }

  await assertSavedQueryMatches(client, opts.creationQueryId, CREATION_SQL);
  const result = await executeAndRead(
    client,
    opts.creationQueryId,
    { [DEPLOYERS_PARAM]: opts.wallets.join(',') },
    opts.bounds,
  );
  const { byWallet: rowsByWallet, unreadableRows } = parseCreationRows(result.rows);

  for (const w of opts.wallets) {
    byWallet.set(w, toWalletEnumeration({ wallet: w, launches: rowsByWallet.get(w) ?? [], coverage }));
  }
  return { probe, coverage, byWallet, unreadableRows, rowsReturned: result.rows.length };
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
