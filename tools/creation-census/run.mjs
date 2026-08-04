#!/usr/bin/env node
/**
 * The creation census's spending half: deploy the committed statement once, then run one seed month.
 *
 * ```bash
 * node tools/creation-census/run.mjs                          # dry run. Issues NOTHING. The default.
 * node tools/creation-census/run.mjs --verify --live          # 1 request, 0 executions
 * node tools/creation-census/run.mjs --deploy --live          # creates the saved query. ONE TIME.
 * node tools/creation-census/run.mjs --month 2026-07 --live   # 1 execution
 * ```
 *
 * **`--live` is required to spend anything and the dry run is the default**, because the binding
 * unit here cannot be taken back: a Dune execution is billed whether or not it succeeds and is never
 * retried, and a saved query created by mistake spends one of the Free tier's ten private slots.
 * The dry run prints exactly what would be sent — the query id, the month bounds, the parameters and
 * every ceiling — and issues no request at all.
 *
 * ## The order of operations, and why it is that order
 *
 * 1. **Verify the saved query against the committed text.** One request, no execution. A saved query
 *    is editable from a browser and this one decides which deployers the whole lane is about, so it
 *    is checked BEFORE the billed step rather than after it (`dune.mjs` → `assertSavedQueryMatches`
 *    is the same rule for the screen's two queries).
 * 2. **Execute once, poll, read once.** The read is refused unless it can prove it is whole.
 * 3. **Assess coverage, then publish or refuse.** The probe rows ride in the same result, so the
 *    count and the evidence for the count cannot be separated — the repository's standing rule that
 *    a Dune count travels with the probe that proves its table coverage.
 *
 * Nothing here tracks the month: the tool is stateless between runs, so the monthly credit
 * arithmetic is the operator's. See `README.md` → "Bounds".
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDuneCredential } from './credential.mjs';
import { DuneClient, DuneRefused, CeilingReached } from './client.mjs';
import {
  CENSUS_SQL,
  PROLIFIC_CUT_CAVEAT,
  assessCensusCoverage,
  buildCensusRecord,
  monthBounds,
  normaliseSql,
  parseCensusRows,
  serialiseCohortFile,
  summariseLaunches,
} from './census.mjs';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(TOOL_DIR));

/**
 * The record's pointer to the raw rows it is a reading of, as a repository-relative path.
 *
 * **A pointer that cannot be made relative falls back to the absolute path, never to a truncated
 * one.** The record is a versioned evidence contract whose one link to its own rows is this string,
 * so it must be whole or plainly absolute — an `--out` outside the checkout is a legitimate
 * invocation, not a licence to write something shorter than the path.
 *
 * @param {string} path
 * @returns {string}
 */
export function evidencePointer(path) {
  const abs = resolve(path);
  const rel = relative(REPO_ROOT, abs);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return abs;
  return rel.split(sep).join('/');
}

/** Pinned bounds, every value with a stated reason. @returns {any} */
export function readBounds() {
  return JSON.parse(readFileSync(join(TOOL_DIR, 'bounds.json'), 'utf8'));
}

/**
 * Exit codes, so a scheduler can tell the three failures apart.
 *
 * A refusal (2) is a real answer about our own evidence and is not a fault; a credential problem (3)
 * means nothing was measured; a vendor refusal (4) means the execution may already have been billed.
 */
export const EXIT = { ok: 0, refused: 2, credential: 3, vendor: 4, usage: 64 };

/**
 * @param {readonly string[]} argv
 * @returns {{ month: string | null, minLaunches: number | null, maxRows: number | null, out: string | null,
 *   live: boolean, deploy: boolean, verify: boolean, help: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
  const out = {
    month: /** @type {string | null} */ (null),
    minLaunches: /** @type {number | null} */ (null),
    maxRows: /** @type {number | null} */ (null),
    out: /** @type {string | null} */ (null),
    live: false,
    deploy: false,
    verify: false,
    help: false,
    /** @type {string[]} */ errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--month':
        out.month = next() ?? '';
        break;
      case '--min-launches': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1) out.errors.push('--min-launches must be a positive integer');
        else out.minLaunches = n;
        break;
      }
      case '--max-rows': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1) out.errors.push('--max-rows must be a positive integer');
        else out.maxRows = n;
        break;
      }
      case '--out':
        out.out = next() ?? '';
        break;
      case '--live':
        out.live = true;
        break;
      case '--dry-run':
        // Accepted and redundant: the dry run is the default. Named so a cautious invocation that
        // spells it out is not rejected as an unknown flag.
        break;
      case '--deploy':
        out.deploy = true;
        break;
      case '--verify':
        out.verify = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        out.errors.push(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (out.deploy && out.verify) out.errors.push('--deploy and --verify are separate steps; run one at a time');
  return out;
}

const HELP = `slot-zero creation census — every pump.fun deployer creating in one past month, taken whole.

  --month YYYY-MM     seed month (default: bounds.json census.defaultMonth)
  --min-launches N    prolific-ness floor (default: bounds.json census.minLaunches)
  --max-rows N        per-result deployer row cap (default: bounds.json census.maxRows)
  --out DIR           where the cohort and the record are written (default: tools/creation-census/runs)
  --live              actually spend. WITHOUT IT NOTHING IS ISSUED — the dry run is the default.
  --verify            compare the saved query against the committed SQL. 1 request, 0 executions.
  --deploy            create the saved query. ONE TIME, and it spends one of ten private slots.
  --dry-run           accepted and redundant; this is the default.
`;

/**
 * Count the account's saved queries, and separately the PRIVATE ones the Free-tier cap governs.
 *
 * **This is the re-checkable form of a claim that was wrong for months.** `cohort.mjs` and this
 * lane's README recorded the census as blocked because the Free tier's ten private query slots were
 * full; the account held eight. A number written into a comment cannot be checked by the next
 * reader, so the deploy step counts them itself, immediately before creating anything, and refuses
 * rather than asserting a figure that has to be taken on faith.
 *
 * **The count must measure the population the cap actually governs.** `total` is every query the
 * account owns, public and archived included, while the allowance is on PRIVATE queries — and a
 * guard measuring a different population than the cap it enforces is exactly the take-it-on-faith
 * defect this lane exists to remove. Over-refusing is not good enough here, because the whole point
 * is that the refusal was wrong. So both figures are reported: `total` as the vendor declared it and
 * `privateInUse` as the filtered one the deploy compares against the cap.
 *
 * The filter is deliberately asymmetric, because under-counting is the one direction that lets a
 * deploy over-spend. `/queries?limit=100` rows do NOT carry `is_private` or `is_archived` at all
 * (verified against the live account 2026-08-04) while `GET /query/{id}` does, so a row that says
 * nothing is COUNTED as possibly private. Only a row explicitly saying `is_private === false`, or
 * explicitly saying it is archived, is excluded — as are no rows at all when the list is short of
 * the declared total, whose unseen remainder is counted the same way.
 *
 * @param {DuneClient} client
 * @returns {Promise<{ total: number, privateInUse: number, names: string[] }>}
 */
export async function readSavedQueries(client) {
  const body = await client.getJson('/queries?limit=100');
  const queries = /** @type {any} */ (body)?.queries;
  const declared = /** @type {any} */ (body)?.total;
  if (!Array.isArray(queries)) {
    throw new DuneRefused(
      'Dune returned no query list, so the number of private slots in use cannot be established. ' +
        'Nothing was created — a deploy that cannot count the slots it is about to spend is exactly ' +
        'the failure this step exists to avoid.',
      { status: null, terminal: true },
    );
  }
  const total = typeof declared === 'number' && Number.isFinite(declared) ? declared : queries.length;
  const countsAgainstCap = (/** @type {any} */ q) =>
    q?.is_private !== false && q?.is_archived !== true && q?.archived !== true;
  const unlisted = Math.max(0, total - queries.length);
  const privateInUse = queries.filter(countsAgainstCap).length + unlisted;
  return { total, privateInUse, names: queries.map((q) => String(q?.name ?? '')) };
}

/**
 * Create the saved query from the committed text.
 *
 * @param {DuneClient} client
 * @param {{ name: string, parameters: {key: string, value: string, type: string}[] }} opts
 * @returns {Promise<number>} The new query id, to be pinned in `bounds.json`.
 */
export async function deploySavedQuery(client, opts) {
  const body = await client.postJson('/query', {
    name: opts.name,
    query_sql: CENSUS_SQL,
    is_private: true,
    parameters: opts.parameters,
  });
  const id = /** @type {any} */ (body)?.query_id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new DuneRefused(
      'Dune accepted the query creation but returned no query id, so nothing can be pinned and the ' +
        'created query — if there is one — cannot be named. Check the account before retrying: this ' +
        'call is never retried automatically because a second create spends a second private slot.',
      { status: null, terminal: true },
    );
  }
  return id;
}

/**
 * Verify a saved Dune query still holds the text this repository committed.
 *
 * One request, NO execution, and it runs before the execution rather than after: the point is to not
 * spend a billed, unrecoverable execution on a query that no longer asks what this module documents.
 *
 * It RETURNS its verdict rather than only throwing, because the run record carries that verdict as
 * a field. A field asserting a verification result must be wired to the verification: a literal
 * `true` written beside the number would keep reading `true` on any path that never checked.
 *
 * @param {DuneClient} client
 * @param {number} queryId
 * @returns {Promise<true>}
 */
export async function assertSavedQueryMatches(client, queryId) {
  const body = await client.getJson(`/query/${queryId}`);
  const actual = /** @type {any} */ (body)?.query_sql;
  if (typeof actual !== 'string') {
    throw new DuneRefused(
      `Dune query ${queryId} returned no SQL, so it cannot be verified against the text committed in ` +
        `tools/arrival-rate-walk/cohort.mjs. Nothing was executed.`,
      { status: null, terminal: true },
    );
  }
  if (normaliseSql(actual) !== normaliseSql(CENSUS_SQL)) {
    throw new DuneRefused(
      `Dune query ${queryId} no longer matches COHORT_SQL as committed in ` +
        `tools/arrival-rate-walk/cohort.mjs. A saved query is editable from a browser and this one ` +
        `decides which deployers the whole lane is about, so this run refuses to spend an execution ` +
        `on it. Restore the saved query from the committed text, or change the committed text on ` +
        `purpose and redeploy in the same commit. Nothing was executed.`,
      { status: null, terminal: true },
    );
  }
  return true;
}

/**
 * Read a result set, refusing anything that cannot prove it is whole.
 *
 * Four ways it fails to: no `total_row_count` (so nothing bounds it), a declared total above the
 * ceiling (an unbounded read is an unbounded bill), rows sitting exactly on the `?limit=` it was
 * issued with, and rows DISAGREEING with the declared total — `/results` pages on response size
 * independently of our limit, so a page read as a whole answer is a census that is simply short.
 *
 * @param {DuneClient} client
 * @param {string} path
 * @param {number} limit
 * @returns {Promise<{ rows: unknown[], resultBytes: number }>}
 */
export async function readResult(client, path, limit) {
  const body = await client.getJson(path);
  const result = /** @type {any} */ (body)?.result;
  const rows = result?.rows;
  if (!Array.isArray(rows)) {
    throw new DuneRefused(`Dune returned no result rows for ${path}.`, { status: null, terminal: false });
  }
  const metadata = result?.metadata ?? {};
  const bytes = Number(metadata.total_result_set_bytes ?? metadata.result_set_bytes ?? 0);
  client.noteResultBytes(bytes);
  const declared = metadata.total_row_count;
  const total = Number(declared);
  if (declared === undefined || declared === null || !Number.isFinite(total)) {
    throw new DuneRefused(
      `Dune returned no \`total_row_count\` for ${path}, so this read cannot say whether it was ` +
        `truncated at the \`?limit=${limit}\` it was issued with. A result cut at the limit is ` +
        `indistinguishable from a complete one of that size, so it is refused rather than read.`,
      { status: null, terminal: false },
    );
  }
  if (total > limit) {
    throw new DuneRefused(
      `Dune returned ${total} rows for ${path}, above the \`?limit=${limit}\` this read was issued ` +
        `with. Results are billed by bytes, so an unbounded read is an unbounded bill; the reading ` +
        `is refused rather than paged.`,
      { status: null, terminal: false },
    );
  }
  if (rows.length >= limit) {
    throw new DuneRefused(
      `Dune returned exactly the ${limit} rows requested for ${path}, so this read sits on its own ` +
        `limit and cannot prove it is whole. It is refused rather than published.`,
      { status: null, terminal: false },
    );
  }
  if (rows.length !== total) {
    throw new DuneRefused(
      `Dune declared ${total} rows for ${path} and handed back ${rows.length}, so this read is a PAGE ` +
        `rather than the whole result — /results pages on response size independently of the ` +
        `\`?limit=\` it was issued with. A page read as a whole answer is a census that is simply ` +
        `short, so it is refused rather than published.`,
      { status: null, terminal: false },
    );
  }
  return { rows, resultBytes: Number.isFinite(bytes) ? bytes : 0 };
}

/**
 * Execute the census once and read it once.
 *
 * **The execution is issued exactly once.** A failed or cancelled execution is reported, never
 * retried: it is billed either way, and a second one buys a second bill for the same answer.
 * Polling is retried, because a poll is a read and a failed read costs nothing.
 *
 * @param {DuneClient} client
 * @param {number} queryId
 * @param {Record<string, string>} parameters
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, resultLimit: number }} bounds
 * @returns {Promise<{ rows: unknown[], resultBytes: number }>}
 */
export async function executeAndRead(client, queryId, parameters, bounds) {
  const executionId = await client.execute(queryId, parameters);
  for (let attempt = 0; attempt < bounds.maxPollAttempts; attempt++) {
    await client.wait(bounds.pollIntervalMs);
    const status = await client.getJson(`/execution/${executionId}/status`);
    const state = /** @type {any} */ (status)?.state;
    if (state === 'QUERY_STATE_COMPLETED') {
      return readResult(client, `/execution/${executionId}/results?limit=${bounds.resultLimit}`, bounds.resultLimit);
    }
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED' || state === 'QUERY_STATE_EXPIRED') {
      throw new DuneRefused(
        `Dune execution of query ${queryId} ended ${String(state)}. It is billed either way and it is ` +
          `NOT retried. There is no keyless route to a census, so this run produced no cohort at all.`,
        { status: null, terminal: true },
      );
    }
  }
  throw new DuneRefused(
    `Dune execution of query ${queryId} did not finish within ${bounds.maxPollAttempts} polls of ` +
      `${bounds.pollIntervalMs} ms. The execution is billed and is not retried; the result may still ` +
      `be readable from the saved query's cache on a later run.`,
    { status: null, terminal: true },
  );
}

/**
 * The plan a dry run prints and a live run follows. Issues nothing.
 *
 * @param {any} bounds
 * @param {{ month: string | null, minLaunches: number | null, maxRows: number | null }} args
 * @returns {{ month: ReturnType<typeof monthBounds>, minLaunches: number, maxRows: number,
 *   resultLimit: number, queryId: number | null,
 *   parameters: { month_start: string, month_end: string, min_launches: string, max_rows: string },
 *   refusals: string[] }}
 */
export function buildPlan(bounds, args) {
  const month = monthBounds(args.month ?? bounds.census.defaultMonth);
  const minLaunches = args.minLaunches ?? bounds.census.minLaunches;
  const maxRows = args.maxRows ?? bounds.census.maxRows;
  // The `?limit=` must sit STRICTLY above the largest result the SQL can produce, or a complete
  // result reads as one truncated at the limit and is refused. The SQL returns at most `max_rows`
  // deployer rows plus its coverage and total rows, so the headroom covers the meta rows and any
  // future one.
  const resultLimit = maxRows + bounds.census.resultLimitHeadroom;
  /** @type {string[]} */
  const refusals = [];
  if (bounds.census.queryId === null) {
    refusals.push(
      'bounds.json → census.queryId is null, so the committed SQL is not deployed. Run --deploy --live ' +
        'once and pin the id it prints. Nothing may execute under a guessed id.',
    );
  }
  if (maxRows > bounds.census.maxRowsCeiling) {
    refusals.push(
      `--max-rows ${maxRows} is above the pinned ceiling of ${bounds.census.maxRowsCeiling}. Results are ` +
        'billed by bytes; a larger census is a larger bill and is a decision, not a flag.',
    );
  }
  return {
    month,
    minLaunches,
    maxRows,
    resultLimit,
    queryId: bounds.census.queryId,
    parameters: {
      month_start: month.startSql,
      month_end: month.endSql,
      min_launches: String(minLaunches),
      max_rows: String(maxRows),
    },
    refusals,
  };
}

/**
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} say
 * @returns {Promise<number>}
 */
export async function main(argv, env, say) {
  const args = parseArgs(argv);
  if (args.help) {
    say(HELP);
    return EXIT.ok;
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) say(`refused: ${e}`);
    return EXIT.usage;
  }

  const bounds = readBounds();
  let plan;
  try {
    plan = buildPlan(bounds, args);
  } catch (cause) {
    say(`refused: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT.usage;
  }
  const outDir = args.out ?? join(TOOL_DIR, 'runs');

  say('slot-zero creation census');
  say(`  month          ${plan.month.month}  [${plan.month.startSql} , ${plan.month.endSql})`);
  say(`  min_launches   ${plan.minLaunches}   <- a PROLIFIC-NESS cut. See the caveat below.`);
  say(`  max_rows       ${plan.maxRows}  (read at ?limit=${plan.resultLimit})`);
  say(`  saved query    ${plan.queryId === null ? 'NOT DEPLOYED' : plan.queryId}`);
  say(`  ceilings       ${bounds.dune.maxExecutionsPerRun} execution(s), ${bounds.dune.maxRequestsPerRun} requests`);
  say(`  out            ${outDir}`);
  say('');

  if (args.deploy) {
    if (plan.queryId !== null) {
      say(
        `refused: bounds.json already pins census.queryId ${plan.queryId}. Deploying again would spend a ` +
          'second of the ten private slots on the same statement. Use --verify to check the deployed text.',
      );
      return EXIT.refused;
    }
  } else if (plan.refusals.length > 0) {
    for (const r of plan.refusals) say(`refused: ${r}`);
    return EXIT.refused;
  }

  if (!args.live) {
    say('DRY RUN — nothing was issued. Add --live to spend.');
    say('');
    say(PROLIFIC_CUT_CAVEAT);
    return EXIT.ok;
  }

  const credential = resolveDuneCredential(env);
  if (credential.outcome !== 'ok' || credential.key === null) {
    say(`refused: ${credential.message}`);
    return EXIT.credential;
  }
  say(credential.message);

  const client = new DuneClient({
    key: credential.key,
    maxExecutions: args.deploy || args.verify ? 0 : bounds.dune.maxExecutionsPerRun,
    maxRequests: bounds.dune.maxRequestsPerRun,
    minIntervalMs: bounds.dune.minIntervalMs,
    onRequest: (path, attempt) => say(`  -> ${path}${attempt > 0 ? ` (retry ${attempt})` : ''}`),
  });

  try {
    if (args.deploy) {
      const saved = await readSavedQueries(client);
      say(`  account declares ${saved.total} saved quer${saved.total === 1 ? 'y' : 'ies'} in all; ` +
        `${saved.privateInUse} of them count against the ${bounds.dune.privateQuerySlots} private slots ` +
        '(a row that does not say it is public or archived is counted as private). The FILTERED count ' +
        'is what is compared against the cap.');
      if (saved.privateInUse >= bounds.dune.privateQuerySlots) {
        say(
          `refused: ${saved.privateInUse} of the ${bounds.dune.privateQuerySlots} private query slots are ` +
            `in use (of ${saved.total} saved queries in all), so a new saved query cannot be created. ` +
            'Nothing here will delete or overwrite an existing one — which of them is retired is not ' +
            'this tool\'s call. Re-check with GET /api/v1/queries?limit=100.',
        );
        return EXIT.refused;
      }
      const id = await deploySavedQuery(client, {
        name: bounds.census.savedQueryName,
        parameters: [
          { key: 'month_start', value: plan.parameters.month_start, type: 'text' },
          { key: 'month_end', value: plan.parameters.month_end, type: 'text' },
          { key: 'min_launches', value: plan.parameters.min_launches, type: 'number' },
          { key: 'max_rows', value: plan.parameters.max_rows, type: 'number' },
        ],
      });
      say('');
      say(`DEPLOYED. Pin this in bounds.json -> census.queryId: ${id}`);
      say('Editing COHORT_SQL is half a change: the saved query must be updated in place in the same');
      say('commit, or the next run refuses the whole leg before spending an execution.');
      return EXIT.ok;
    }

    if (plan.queryId === null) return EXIT.refused; // unreachable; buildPlan refused above.

    const savedQueryMatchedCommittedSql = await assertSavedQueryMatches(client, plan.queryId);
    say(`  saved query ${plan.queryId} matches the committed COHORT_SQL byte for byte.`);
    if (args.verify) {
      say('VERIFIED. No execution was spent.');
      return EXIT.ok;
    }

    const result = await executeAndRead(client, plan.queryId, plan.parameters, {
      pollIntervalMs: bounds.dune.pollIntervalMs,
      maxPollAttempts: bounds.dune.maxPollAttempts,
      resultLimit: plan.resultLimit,
    });

    const census = parseCensusRows(result.rows);
    const coverage = assessCensusCoverage({
      census,
      monthStartMs: plan.month.startMs,
      monthEndMs: plan.month.endMs,
    });

    mkdirSync(outDir, { recursive: true });
    const runAtUtc = new Date().toISOString();
    const cohortPath = join(outDir, `${plan.month.month}-cohort.json`);
    const recordPath = join(outDir, `${plan.month.month}-census.json`);
    writeFileSync(
      cohortPath,
      serialiseCohortFile({
        queryId: plan.queryId,
        month: plan.month.month,
        parameters: plan.parameters,
        executedAtUtc: runAtUtc,
        rows: result.rows,
      }),
    );

    const record = buildCensusRecord({
      runAtUtc,
      bounds: plan.month,
      parameters: { minLaunches: plan.minLaunches, maxRows: plan.maxRows },
      queryId: plan.queryId,
      census,
      coverage,
      spend: client.stats(),
      cohortFile: evidencePointer(cohortPath),
      savedQueryMatchedCommittedSql,
    });
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const summary = summariseLaunches(census.deployers);
    say('');
    for (const t of /** @type {any} */ (record).coverage.tables) {
      say(
        `  coverage ${t.table.padEnd(16)} ${String(t.firstRowUtc).slice(0, 10)} -> ` +
          `${String(t.lastRowUtc).slice(0, 10)}  ${t.rowsInMonth} row(s) in month  ` +
          `brackets=${t.bracketsMonth}`,
      );
    }
    say(`  qualifying deployers declared ${census.declaredTotal}, returned ${census.deployers.length}` +
      `${census.refusedByShape > 0 ? `, ${census.refusedByShape} refused by shape` : ''}`);
    const reconciliation = /** @type {any} */ (record).reconciliation;
    say(`  cut: ${reconciliation.cut}`);
    say(`  reconciliation (${reconciliation.source}): ${reconciliation.note}`);
    say(`  launches in month: min ${summary.min} p50 ${summary.p50} p90 ${summary.p90} max ${summary.max}`);
    for (const rung of summary.ladder) {
      say(`    threshold >=${String(rung.threshold).padStart(4)} -> ${rung.deployers} deployer(s)`);
    }
    const spend = client.stats();
    say(
      `  spend: ${spend.executions} execution(s), ${spend.requests} request(s), ${spend.resultBytes} ` +
        `result bytes, ~${spend.estimatedExportCredits} export credits (ESTIMATE — compute is billed ` +
        `on top and only POST /usage is authoritative).`,
    );
    say(`  wrote ${cohortPath}`);
    say(`  wrote ${recordPath}`);
    say('');
    say(PROLIFIC_CUT_CAVEAT);

    if (!coverage.ok) {
      say('');
      say('REFUSED — the census cannot vouch for itself and is not a cohort:');
      for (const reason of coverage.reasons) say(`  - ${reason}`);
      say('The result is still written, because what was refused and why is the evidence.');
      return EXIT.refused;
    }
    return EXIT.ok;
  } catch (cause) {
    if (cause instanceof CeilingReached) {
      say(`refused: ${cause.message}`);
      return EXIT.refused;
    }
    if (cause instanceof DuneRefused) {
      say(`refused: ${cause.message}`);
      say(`  executions spent this run: ${client.executions()} (billed whether or not they succeeded)`);
      return EXIT.vendor;
    }
    throw cause;
  }
}

/* c8 ignore start -- the CLI entry point; every branch above is driven by the tests. */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2), process.env, (line) => console.log(line))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((cause) => {
      console.error(`failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
