/**
 * The creation census: **every pump.fun deployer that created in one past month, taken whole above a
 * stated count.** Offline half — the SQL text, the readers, the coverage rule and the run record.
 * `run.mjs` is the only part that spends anything.
 *
 * ## What this exists to correct
 *
 * Candidate discovery in this repository is 100% vendor-selected (`tools/deployer-screen/FEED.md`):
 * every candidate comes from a MadeOnSol enumeration endpoint, so a deployer they never profiled is
 * invisible rather than rare, and their `bonding_rate` / `total_bonded` figures are a trailing
 * ~7.5-day window their own alert text calls "lifetime". Measured against this census on
 * 2026-08-04: for creations in 2026-07 the feed sees **25** deployers where the census reaches
 * **10,280**, and narrowed to the wallets clearing the screen's Stage 1 competence gate the feed
 * yields **8** against the census's **35** — about **27 named wallets that pass the bar and that
 * this project structurally could not see**. `data/slot-zero-discovery-widen-operations/report.md`
 * §2.1 and §4.1 own that measurement; captain decision 187a routed this lane from it.
 *
 * ## The bias this census still carries, named rather than assumed away
 *
 * A census carries **no** survivorship and **no** cadence bias — it holds every creation in the
 * month, attributed to the signer, with no vendor in the loop and no "still active" term. It carries
 * two others, and both are in the output rather than only in prose:
 *
 * 1. **Silent table start dates.** A decoded table answers confidently and wrongly before its first
 *    row. {@link CENSUS_SQL} probes both surfaces it reads in the same execution and
 *    {@link assessCensusCoverage} refuses a result whose surfaces do not bracket the month.
 * 2. **`{{min_launches}}` is a PROLIFIC-NESS cut, not a competence one** — {@link
 *    PROLIFIC_CUT_CAVEAT}. It is the same species of trap as the feed's filter, which looked like
 *    quality and was tempo. It is far weaker (historical rather than trailing; per month rather than
 *    per 7.5 days) and it does not condition on success at all, but a deployer launching three times
 *    a month for two years is missed at any floor above three. Whoever sets or raises it says so.
 *
 * ## Why the SQL is not written here
 *
 * {@link CENSUS_SQL} is a byte-for-byte copy of `tools/arrival-rate-walk/cohort.mjs` →
 * `COHORT_SQL`, which is the committed home of the statement, and `test/creation-census.test.ts`
 * asserts the two are identical rather than trusting them to stay so. That lane is **keyless
 * throughout** — its credential allow-list is empty and a test enforces it — so it cannot execute
 * its own statement, and this directory exists to be the half that can. The duplication is the
 * directory boundary's stated cost (`CLAUDE.md`), paid here as it is paid four times already, and it
 * is pinned instead of promised.
 *
 * The reverse copy — the reader — is duplicated for the same reason and pinned the same way: the
 * test drives this module's {@link parseCensusRows} and {@link assessCensusCoverage} and the walk's
 * `parseCohortRows` / `assessCohortCoverage` over one set of fixtures and requires the same verdict.
 */

/**
 * The two decoded surfaces the census is read from, and neither alone is usable.
 *
 * `pump_call_create` decodes only the original `Create` and returns **zero rows** for a deployer
 * launching with `CreateV2`. `pump_call_create_v2` is not backfilled before ~2026-04-28 and would
 * silently miss any seed month before then — which is exactly the failure this list exists to
 * prevent, so it is deliberately absent from the union and probed nowhere.
 * `pump_evt_createevent` decodes the `CreateEvent` **both** instructions emit and is the surface
 * that spans the boundary.
 */
export const CENSUS_TABLES = ['evt_createevent', 'call_create'];

/**
 * The base58 wallet shape. Census wallets are vendor-derived strings that will land inside another
 * statement's single-quoted SQL literal (`CREATION_SQL`'s `{{deployers}}` parameter downstream), so
 * nothing that fails this may be carried forward.
 */
export const WALLET_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The one sentence that must travel with every cohort this tool produces — to the record, to the
 * rendered summary and to the README.
 *
 * The feed's filter looked like quality and was tempo, and that cost this project real coverage. The
 * census's own floor is the same shape of trap in a weaker form, and the only defence against a
 * threshold quietly becoming a competence claim is that it says out loud what it is.
 */
export const PROLIFIC_CUT_CAVEAT =
  'THE min_launches FLOOR IS A PROLIFIC-NESS CUT, NOT A COMPETENCE ONE. It selects deployers by how ' +
  'much they created in the seed month and by nothing else — no bonding rate, no completion, no ' +
  '"still active" term — so it is the same species of filter as the vendor feed\'s, which looked ' +
  'like quality and was tempo. It is weaker in three ways that matter (historical rather than ' +
  'trailing, per calendar month rather than per 7.5 days, and conditioning on volume rather than on ' +
  'success) and it introduces no survivorship bias at all. What it DOES miss is the low-cadence ' +
  'deployer: a wallet launching three times a month for two years is absent at any floor above ' +
  'three, and nothing in the output reveals that. Raising this floor narrows the census on ' +
  'prolific-ness alone; whoever raises it must say so here.';

/** The census result's own schema version. Bump, never retro-edit — committed runs are evidence. */
export const RECORD_SCHEMA_VERSION = 1;

/**
 * The census ladder this repository has already published, by seed month and prolific-ness floor.
 *
 * Source: `data/slot-zero-discovery-widen-operations/report.md` §2.1, measured 2026-08-04 by the
 * scout that produced captain decision 187a, over the same two decoded surfaces this statement
 * reads.
 *
 * **It is here so a run reconciles against it rather than beside it.** The headline number
 * authorising this lane is *10,280 deployers creating in 2026-07*, and a run at the pinned floor
 * returns *3,036*. Those are the SAME census at two different floors — but a figure that looks
 * measured while measuring something else is this repository's characteristic defect, so the
 * comparison is computed into every record instead of being left for a reader to make. A future run
 * of a month in this table that disagrees at the SAME floor is saying that one of the two statements
 * changed, and {@link reconcileWithPublished} makes that visible instead of quietly shipping a
 * different number under the same name.
 */
export const PUBLISHED_LADDER = {
  '2026-01': { 1: 227083, 4: 26977, 8: 13298, 15: 6645, 30: 3290 },
  '2026-07': { 1: 176200, 4: 22620, 8: 10280, 15: 5416, 30: 3036 },
};

/** Where {@link PUBLISHED_LADDER} comes from. Quoted into every record. */
export const PUBLISHED_LADDER_SOURCE =
  'data/slot-zero-discovery-widen-operations/report.md section 2.1, measured 2026-08-04';

/**
 * State exactly which cut produced a count, and reconcile it against the published ladder.
 *
 * @param {object} input
 * @param {string} input.month
 * @param {number} input.minLaunches
 * @param {number | null} input.declaredTotal The qualifying deployers BEFORE the row cap.
 * @returns {{ cut: string, source: string, floor: number, publishedAtThisFloor: number | null,
 *   measured: number | null, agrees: boolean | null, publishedAtOtherFloors: { floor: number,
 *   deployers: number }[], note: string }}
 */
export function reconcileWithPublished({ month, minLaunches, declaredTotal }) {
  const cut =
    `Wallets that SIGNED at least ${minLaunches} distinct mint creations whose block time falls in ` +
    `[${month}-01, the first instant of the next month), over pumpdotfun_solana.pump_evt_createevent ` +
    `UNION pump_call_create deduped by mint. Attribution is "user" / account_user, the SIGNER — not ` +
    `\`creator\`, a settable CreateV2 argument. No bonding, completion, recency or "still active" ` +
    `term enters it, so the ONLY difference between this count and a larger one over the same month ` +
    `is the prolific-ness floor.`;
  const published = /** @type {Record<string, Record<string, number>> } */ (PUBLISHED_LADDER)[month];
  const others = published === undefined ? [] : Object.entries(published).map(([f, n]) => ({ floor: Number(f), deployers: n }));
  const atThisFloor = published?.[String(minLaunches)] ?? null;
  const agrees = atThisFloor === null || declaredTotal === null ? null : atThisFloor === declaredTotal;
  let note;
  if (published === undefined) {
    note = `No published ladder exists for ${month}, so this count reconciles against nothing and stands on its own probe.`;
  } else if (agrees === true) {
    const bigger = others.filter((o) => o.floor < minLaunches).sort((a, b) => a.floor - b.floor);
    note =
      `MEASURED ${declaredTotal} at a floor of ${minLaunches}; the published ladder reads ` +
      `${atThisFloor} at the same floor over the same month and the same two surfaces — the same ` +
      `number, not a close one. The larger published figures for this month are the SAME census at ` +
      `LOWER floors (` +
      bigger.map((o) => `${o.deployers} at >=${o.floor}`).join(', ') +
      `), so a reader meeting both is meeting one measurement at two cuts rather than two ` +
      `measurements. NOTE the record's own ladder starts at the floor this run used and therefore ` +
      `CANNOT re-derive the lower rungs: reproducing them costs another execution.`;
  } else if (agrees === false) {
    note =
      `DISAGREES: this run measured ${declaredTotal} at a floor of ${minLaunches} where the published ` +
      `ladder reads ${atThisFloor} for the same month and floor. A closed past month should not move, ` +
      `so one of two things changed — the decoded tables were backfilled or reprocessed, or the saved ` +
      `statement is no longer the one that produced the published figure. Establish which before ` +
      `quoting either number.`;
  } else {
    note =
      `The published ladder for ${month} carries no rung at a floor of ${minLaunches}, so this count ` +
      `reconciles against no published figure. Its neighbours are listed for scale only and are NOT ` +
      `a check on it.`;
  }
  return {
    cut,
    source: PUBLISHED_LADDER_SOURCE,
    floor: minLaunches,
    publishedAtThisFloor: atThisFloor,
    measured: declaredTotal,
    agrees,
    publishedAtOtherFloors: others,
    note,
  };
}

export const CENSUS_SQL = `-- slot-zero: HISTORICAL DEPLOYER COHORT for the arrival-rate walk. ONE execution.
--
-- Committed byte for byte as COHORT_SQL in tools/arrival-rate-walk/cohort.mjs. Whatever executes
-- it must compare the saved query against that text first: a saved query is editable from a
-- browser and this one decides which deployers the whole measurement is about.
--
-- WHAT IT SELECTS ON, AND WHAT IT DELIBERATELY DOES NOT. Captain decision 165b: every deployer
-- that created a launch in ONE PAST MONTH, above a stated count, taken whole and followed
-- forward. It reads that month and nothing after it. There is NO join to
-- pump_evt_completeevent, no bonding rate, no "still active" test and no recency term, because
-- every one of those conditions the sample on SURVIVING - which is the single bias that decides
-- whether an arrival rate means anything.
--
-- UNION of two surfaces, deduped by mint, because NEITHER spans both coverage boundaries:
--   pump_evt_createevent  decodes the CreateEvent that BOTH Create and CreateV2 emit, from 2024-04
--   pump_call_create      decodes the original Create instruction only, from 2024-01
-- pump_call_create_v2 is deliberately ABSENT: it is not backfilled before ~2026-04-28 and would
-- silently return nothing at all for a seed month in early 2026.
--
-- Attribution is "user" / account_user, the SIGNER of the creation. \`creator\` is a settable
-- CreateV2 argument and is NOT proof of authorship.
--
-- IT VOUCHES FOR ITSELF. The kind='coverage' rows carry each read surface's first row, last row
-- and row count INSIDE the seed month. Decoded tables have silent start dates, so a cohort read
-- from a surface that does not bracket its own seed month is a complete-looking answer that is
-- simply missing deployers. The reader refuses such a result rather than publishing a smaller
-- cohort. kind='total' carries the count of qualifying deployers BEFORE the row cap, so a capped
-- result is detected exactly rather than read as a short-but-complete cohort.
WITH ev AS (
  SELECT e."user" AS deployer, e.mint AS mint
  FROM pumpdotfun_solana.pump_evt_createevent e
  WHERE e.evt_block_time >= TIMESTAMP '{{month_start}}'
    AND e.evt_block_time < TIMESTAMP '{{month_end}}'
), cl AS (
  SELECT c.account_user AS deployer, c.account_mint AS mint
  FROM pumpdotfun_solana.pump_call_create c
  WHERE c.call_block_time >= TIMESTAMP '{{month_start}}'
    AND c.call_block_time < TIMESTAMP '{{month_end}}'
), deduped AS (
  SELECT deployer, mint FROM (SELECT * FROM ev UNION ALL SELECT * FROM cl) GROUP BY 1, 2
), counted AS (
  SELECT deployer, count(*) AS launches_in_month FROM deduped GROUP BY 1
), qualified AS (
  SELECT deployer, launches_in_month,
         row_number() OVER (ORDER BY launches_in_month DESC, deployer) AS rn
  FROM counted WHERE launches_in_month >= {{min_launches}}
)
SELECT 'coverage' AS kind, 'evt_createevent' AS key,
       cast(min(evt_block_time) AS varchar) AS a, cast(max(evt_block_time) AS varchar) AS b,
       cast(count_if(evt_block_time >= TIMESTAMP '{{month_start}}'
                 AND evt_block_time < TIMESTAMP '{{month_end}}') AS bigint) AS n
FROM pumpdotfun_solana.pump_evt_createevent
UNION ALL
SELECT 'coverage', 'call_create',
       cast(min(call_block_time) AS varchar), cast(max(call_block_time) AS varchar),
       cast(count_if(call_block_time >= TIMESTAMP '{{month_start}}'
                 AND call_block_time < TIMESTAMP '{{month_end}}') AS bigint)
FROM pumpdotfun_solana.pump_call_create
UNION ALL
SELECT 'total', 'deployers_at_or_above_floor', NULL, NULL, cast(count(*) AS bigint) FROM qualified
UNION ALL
SELECT 'deployer', deployer, NULL, NULL, cast(launches_in_month AS bigint)
FROM qualified WHERE rn <= {{max_rows}}
ORDER BY 1, 5 DESC, 2
`;

/**
 * Parse a Dune timestamp to epoch ms. **Two spellings, and both have to work**: result rows carry
 * `2025-12-01 19:37:59.000 UTC` and envelopes carry `2026-08-03T09:12:21.429632Z`. Hand-parsed
 * rather than handed to `Date`, because the first form is not a format any standard requires an
 * engine to accept — V8 takes it, another runtime may return `Invalid Date`, and a silently-NaN
 * instant would flow straight into a coverage comparison.
 *
 * @param {unknown} value
 * @returns {number | null}
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
 * Read a positive whole-number count out of a result cell, or `null` when the cell is not one.
 *
 * Deliberately narrower than `Number`: `true`, `null`, `''` and `'12abc'` all become numbers under
 * it, and a shifted column read as the count 1 or 0 is a silently short answer.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function readCount(value) {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * The seed month, in the two forms the run needs: the SQL's half-open bounds and the epoch
 * milliseconds the coverage rule compares against.
 *
 * Half-open on purpose — `>= start AND < end` — so a creation at the last instant of the month is
 * counted once and a creation at the first instant of the next is counted in the next.
 *
 * @param {string} month `YYYY-MM`.
 * @returns {{ month: string, startSql: string, endSql: string, startMs: number, endMs: number }}
 */
export function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (m === null) throw new TypeError(`month must be YYYY-MM, got ${JSON.stringify(month)}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new TypeError(`month ${JSON.stringify(month)} has no such calendar month`);
  const startMs = Date.UTC(year, mon - 1, 1);
  const endMs = Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1);
  /** @param {number} ms @returns {string} */
  const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('.000Z', '');
  return { month: `${m[1]}-${m[2]}`, startSql: sql(startMs), endSql: sql(endMs), startMs, endMs };
}

/**
 * @typedef {object} CensusResult
 * @property {Map<string, { firstRowMs: number | null, lastRowMs: number | null, monthRows: number }>} coverage
 * @property {{ wallet: string, launchesInMonth: number }[]} deployers Descending by count.
 * @property {number | null} declaredTotal Qualifying deployers before the row cap, `null` if absent.
 * @property {number} unreadableRows Rows the parser could not read. **Any non-zero value refuses the
 *   whole census**: a row that fails to parse commonly has no readable wallet, so the deployer that
 *   went missing is exactly the one that cannot be named.
 * @property {number} refusedByShape Rows whose wallet was not base58-shaped.
 */

/**
 * Read the census query's rows.
 *
 * @param {readonly unknown[]} rows
 * @returns {CensusResult}
 */
export function parseCensusRows(rows) {
  /** @type {Map<string, { firstRowMs: number | null, lastRowMs: number | null, monthRows: number }>} */
  const coverage = new Map();
  /** @type {{ wallet: string, launchesInMonth: number }[]} */
  const deployers = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {number | null} */
  let declaredTotal = null;
  let unreadableRows = 0;
  let refusedByShape = 0;

  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) {
      unreadableRows += 1;
      continue;
    }
    const row = /** @type {Record<string, unknown>} */ (raw);
    const kind = row['kind'];
    const key = row['key'];
    const n = readCount(row['n']);
    if (typeof kind !== 'string' || typeof key !== 'string' || key === '' || n === null) {
      unreadableRows += 1;
      continue;
    }
    if (kind === 'coverage') {
      coverage.set(key, {
        firstRowMs: parseDuneTimestamp(row['a']),
        lastRowMs: parseDuneTimestamp(row['b']),
        monthRows: n,
      });
    } else if (kind === 'total') {
      declaredTotal = n;
    } else if (kind === 'deployer') {
      if (!WALLET_SHAPE.test(key)) {
        refusedByShape += 1;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      deployers.push({ wallet: key, launchesInMonth: n });
    } else {
      unreadableRows += 1;
    }
  }

  deployers.sort((a, b) => b.launchesInMonth - a.launchesInMonth || (a.wallet < b.wallet ? -1 : 1));
  return { coverage, deployers, declaredTotal, unreadableRows, refusedByShape };
}

/**
 * @typedef {object} CensusCoverage
 * @property {boolean} ok
 * @property {string[]} reasons Whole sentences; they reach the record.
 */

/**
 * Decide whether the surfaces the census was read from can vouch for the seed month.
 *
 * This is the repository's standing rule applied to a new question: **a Dune count travels with the
 * probe that proves its table coverage, and a count that reaches outside the probed coverage is
 * refused, never published** (`tools/deployer-screen/dune.mjs` states it for the enumeration).
 * Five refusals, and each is a way a confident wrong answer gets out:
 *
 * 1. **A read surface is missing from the result.** The census would then rest on a table nothing
 *    vouched for.
 * 2. **A read surface's own span does not bracket the seed month.** The silent start date stated
 *    mechanically: a table that begins after the month returns a well-formed, empty-looking answer
 *    for it.
 * 3. **The union of the read surfaces holds NO row in the seed month.** Distinct from (2) — a table
 *    can span the month and still be missing it — and it is the case where the census is empty for a
 *    reason that has nothing to do with how many deployers there were.
 * 4. **A row the parser could not read**, which refuses the whole census rather than the row.
 * 5. **A capped result**, which is a selection (the most prolific rows) rather than a shortfall.
 *
 * There is **no fallback** here, unlike the screen's per-wallet enumeration, which can walk a
 * signature index. Nothing else enumerates strangers by creation month, so a refused census stops
 * the lane rather than shrinking it.
 *
 * @param {object} input
 * @param {CensusResult} input.census
 * @param {number} input.monthStartMs
 * @param {number} input.monthEndMs
 * @param {readonly string[]} [input.tables] Defaults to {@link CENSUS_TABLES}.
 * @returns {CensusCoverage}
 */
export function assessCensusCoverage({ census, monthStartMs, monthEndMs, tables = CENSUS_TABLES }) {
  /** @type {string[]} */
  const reasons = [];
  let unionMonthRows = 0;
  let anyRead = false;

  for (const name of tables) {
    const t = census.coverage.get(name);
    if (t === undefined) {
      reasons.push(
        `the census result carries no coverage row for \`${name}\`, which it reads — so nothing bounds ` +
          `the count and no cohort from it may be used.`,
      );
      continue;
    }
    if (t.firstRowMs === null || t.lastRowMs === null) {
      reasons.push(`\`${name}\`'s coverage row has no readable first or last block time, so it bounds nothing.`);
      continue;
    }
    anyRead = true;
    unionMonthRows += t.monthRows;
    if (t.firstRowMs > monthStartMs || t.lastRowMs < monthEndMs) {
      reasons.push(
        `\`${name}\` spans ${new Date(t.firstRowMs).toISOString()} to ${new Date(t.lastRowMs).toISOString()}, ` +
          `which does not bracket the seed month ${new Date(monthStartMs).toISOString().slice(0, 7)}. A decoded ` +
          `table returns a complete-looking answer for a period it does not hold, so the census would be ` +
          `missing deployers with nothing saying so.`,
      );
    }
  }

  if (anyRead && unionMonthRows <= 0) {
    reasons.push(
      `the read surfaces hold NO creation row at all in the seed month, so an empty census here says ` +
        `nothing about how many deployers there were.`,
    );
  }
  if (census.unreadableRows > 0) {
    reasons.push(
      `${census.unreadableRows} row(s) of the census result could not be read, and a row that fails to ` +
        `parse commonly has no readable wallet — so the deployer that went missing cannot be named and ` +
        `the whole census is refused rather than used as far as it parsed.`,
    );
  }
  if (census.declaredTotal === null) {
    reasons.push(
      `the census result declares no total for the qualifying deployers, so it cannot say whether the ` +
        `row cap truncated it. A capped census read as a whole one is a sample chosen by a LIMIT.`,
    );
  } else if (census.declaredTotal > census.deployers.length + census.refusedByShape) {
    reasons.push(
      `the census result declares ${census.declaredTotal} qualifying deployer(s) and returned ` +
        `${census.deployers.length + census.refusedByShape}, so the row cap truncated it. The surviving ` +
        `rows are the most prolific ones, which is a selection rather than a shortfall: raise ` +
        `min_launches and re-execute rather than reading this as the census.`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Cohort sizes a reader is likely to want a threshold for. The census is far larger than any lane
 * downstream can walk, so the useful question is not "how many deployers are there" but "what floor
 * gives me a cohort of about this size" — `tools/arrival-rate-walk/cohort.mjs` → `chooseThreshold`
 * asks exactly that, over the same rows.
 */
export const LADDER_TARGETS = [10, 20, 50, 100, 250, 500, 1000, 2500];

/**
 * Summarise the distribution of launches-in-month over the returned deployers.
 *
 * **Quantiles and a ladder, never a mean** — the standing captain bar for this class of claim. A
 * creation-count distribution is heavily right-skewed (the `total_bonded` leaderboard serves an
 * 8,518-deploy wallet), so a mean is a wrong answer rather than a rough one.
 *
 * @param {readonly {wallet: string, launchesInMonth: number}[]} deployers Any order.
 * @returns {{ deployers: number, min: number | null, p50: number | null, p90: number | null,
 *   p99: number | null, max: number | null, ladder: { cohortAtMost: number, threshold: number,
 *   deployers: number }[] }}
 */
export function summariseLaunches(deployers) {
  const counts = deployers.map((d) => d.launchesInMonth).sort((a, b) => a - b);
  /** @param {number} q @returns {number | null} */
  const at = (q) => counts[Math.min(counts.length - 1, Math.floor(q * counts.length))] ?? null;
  // Ascending distinct counts, computed once: `counts` is sorted, so the number of deployers at or
  // above a threshold is `counts.length` minus the index where that threshold first appears.
  const distinct = [...new Set(counts)];
  /** @param {number} threshold @returns {number} */
  const atOrAbove = (threshold) => counts.length - counts.findIndex((c) => c >= threshold);
  /** @type {{ cohortAtMost: number, threshold: number, deployers: number }[]} */
  const ladder = [];
  for (const target of LADDER_TARGETS) {
    // The LOWEST threshold whose cohort fits the target — the same rule
    // `tools/arrival-rate-walk/cohort.mjs` → `chooseThreshold` applies, reported here so the choice
    // is auditable from the record rather than recomputed.
    const found = distinct.find((t) => atOrAbove(t) <= target);
    if (found === undefined) continue;
    if (ladder.some((r) => r.threshold === found)) continue;
    ladder.push({ cohortAtMost: target, threshold: found, deployers: atOrAbove(found) });
  }
  return {
    deployers: deployers.length,
    min: counts[0] ?? null,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: counts[counts.length - 1] ?? null,
    ladder,
  };
}

/**
 * Serialise the raw census result to the file the next lane reads.
 *
 * **One row per line, deliberately.** The envelope is the shape
 * `tools/arrival-rate-walk/cohort.mjs` → `readDuneResultFile` already accepts (`body.rows`), so the
 * census hands the walk its input with no conversion step in between, and the coverage rows are in
 * the same file as the count — the standing rule that a Dune count travels with the probe that
 * proves its table coverage, made a property of the file rather than of a convention. The line-per-
 * row layout is what makes a 3,000-row evidence file reviewable in a diff; whole-document pretty
 * printing costs 70% more bytes to say the same thing.
 *
 * @param {object} input
 * @param {number} input.queryId
 * @param {string} input.month
 * @param {Record<string, string>} input.parameters
 * @param {string} input.executedAtUtc
 * @param {readonly unknown[]} input.rows
 * @returns {string}
 */
export function serialiseCohortFile(input) {
  const head = {
    source: 'tools/creation-census/run.mjs',
    queryId: input.queryId,
    month: input.month,
    parameters: input.parameters,
    executedAtUtc: input.executedAtUtc,
  };
  const header = Object.entries(head)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join('\n');
  const rows = input.rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
  return `{\n${header}\n  "rows": [\n${rows}\n  ]\n}\n`;
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
 * @typedef {object} CensusRecordInput
 * @property {string} runAtUtc
 * @property {ReturnType<typeof monthBounds>} bounds
 * @property {{ minLaunches: number, maxRows: number }} parameters
 * @property {number} queryId
 * @property {CensusResult} census
 * @property {CensusCoverage} coverage
 * @property {{ requests: number, executions: number, executionCeiling: number, resultBytes: number,
 *   estimatedExportCredits: number }} spend
 * @property {string} cohortFile Path, relative to the repository root, of the raw result this record
 *   describes. The rows are the evidence; this record is the reading of them.
 * @property {boolean} savedQueryMatchedCommittedSql The OUTCOME of the pre-execution comparison
 *   between the saved Dune query and the committed SQL, threaded in rather than written as a
 *   literal. This record is evidence, and a field asserting a verification result that is not wired
 *   to the verification keeps reading `true` on a path that never ran it.
 */

/**
 * Build the committed run record.
 *
 * **It is a versioned contract: bump, never retro-edit.** Committed records are evidence that a
 * census ran and what it saw, and a later reader version-detects rather than assuming. The wallet
 * list deliberately does NOT live here — it lives in the raw result file this record names, in the
 * shape `tools/arrival-rate-walk/cohort.mjs` → `readDuneResultFile` already accepts, so the census
 * hands the walk its input without a conversion step in between.
 *
 * @param {CensusRecordInput} input
 * @returns {Record<string, unknown>}
 */
export function buildCensusRecord(input) {
  const tables = CENSUS_TABLES.map((name) => {
    const t = input.census.coverage.get(name);
    return {
      table: name,
      firstRowUtc: t?.firstRowMs == null ? null : new Date(t.firstRowMs).toISOString(),
      lastRowUtc: t?.lastRowMs == null ? null : new Date(t.lastRowMs).toISOString(),
      rowsInMonth: t?.monthRows ?? null,
      bracketsMonth:
        t?.firstRowMs == null || t?.lastRowMs == null
          ? null
          : t.firstRowMs <= input.bounds.startMs && t.lastRowMs >= input.bounds.endMs,
    };
  });
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    tool: 'tools/creation-census',
    runAtUtc: input.runAtUtc,
    month: input.bounds.month,
    monthStartUtc: new Date(input.bounds.startMs).toISOString(),
    monthEndUtc: new Date(input.bounds.endMs).toISOString(),
    parameters: { min_launches: input.parameters.minLaunches, max_rows: input.parameters.maxRows },
    dune: {
      queryId: input.queryId,
      savedQueryMatchedCommittedSql: input.savedQueryMatchedCommittedSql,
      requests: input.spend.requests,
      executions: input.spend.executions,
      executionCeiling: input.spend.executionCeiling,
      resultBytes: input.spend.resultBytes,
      estimatedExportCredits: input.spend.estimatedExportCredits,
    },
    coverage: { ok: input.coverage.ok, reasons: input.coverage.reasons, tables },
    census: {
      declaredTotal: input.census.declaredTotal,
      deployersReturned: input.census.deployers.length,
      refusedByShape: input.census.refusedByShape,
      unreadableRows: input.census.unreadableRows,
      capped:
        input.census.declaredTotal !== null &&
        input.census.declaredTotal > input.census.deployers.length + input.census.refusedByShape,
      launchesInMonth: summariseLaunches(input.census.deployers),
    },
    // WHICH CUT PRODUCED THE COUNT, and how it relates to every other census figure this
    // repository has published for the same month. A count without its cut is the defect this
    // whole module is arranged against, one level up from the coverage probe.
    reconciliation: reconcileWithPublished({
      month: input.bounds.month,
      minLaunches: input.parameters.minLaunches,
      declaredTotal: input.census.declaredTotal,
    }),
    cohortFile: input.cohortFile,
    caveats: [PROLIFIC_CUT_CAVEAT],
  };
}
