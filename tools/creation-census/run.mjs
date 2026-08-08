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
 * The dry run prints exactly what would be sent — the query id, the month bounds, the parameters,
 * every ceiling and the execution deadline — and issues no request at all.
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
import {
  DuneClient,
  DuneExecutionAbandoned,
  DuneRefused,
  CeilingReached,
  abandonExecution,
  cancelExecutionQuietly,
  decideAllowance,
  describeAllowanceDecision,
  describeExecutionDeadline,
  describeMonthlyCapCredits,
  estimatePlanCredits,
  executionDeadlineCredits,
  localCreditEstimate,
  parseUsageResponse,
} from './client.mjs';
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
 * Exit codes, so a scheduler can tell the failures apart.
 *
 * A refusal (2) is a real answer about our own evidence and is not a fault; a credential problem (3)
 * means nothing was measured; a vendor refusal (4) means the execution may already have been billed.
 *
 * **`deadline` (5) IS ITS OWN CODE AND MUST NOT BE FOLDED INTO `vendor` (captain decision 381).** It
 * means WE STOPPED THIS: the execution was still running at `bounds.json` →
 * `dune.executionDeadlineMs`, and this run cancelled it rather than keep paying. Every other failure
 * is something going wrong; this one is a statement that has outgrown its deadline, and the two call
 * for opposite responses — a `vendor` exit sends an operator to look at Dune or at the SQL, while a
 * `deadline` exit is a decision about how much engine time COHORT_SQL is worth. Folding them is how
 * the 180-credit incident stayed invisible: the poll budget gave up, the run reported a generic
 * failure, and nothing said the engine was still running on our money.
 */
export const EXIT = { ok: 0, refused: 2, credential: 3, vendor: 4, deadline: 5, usage: 64 };

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
 * **AND GIVING UP NOW CANCELS, WHICH IS THE WHOLE OF CAPTAIN DECISION 381's SECOND HALF.** This loop
 * used to walk away when the poll budget ran out and say so — and that sentence was a lie about the
 * money: the engine kept running on Dune's side, to its own 30-minute limit, and billed the full
 * limit for a result nobody read. Measured at 180.002 credits on 2026-08-08, against a guard that had
 * cleared the plan at a pinned 6. Both give-up paths now go through
 * `client.mjs` → {@link abandonExecution}, which issues `POST /execution/{id}/cancel` before it
 * refuses and hands back {@link DuneExecutionAbandoned} — a DISTINCT outcome, so a reader can tell
 * "we stopped this" from "this broke". What the cancel bounds for certain is the wait; whether it
 * stops the BILL is the vendor's to say and they do not — `EXECUTION_DEADLINE_CAVEAT` carries that
 * and rides on the refusal.
 *
 * **THE DEADLINE AND THE POLL BUDGET ARE ONE BOUND IN TWO UNITS, and the duration is the authority.**
 * That is captain decision 144a's rule applied here: a bound the vendor controls (how long an
 * execution takes) must not be written as two numbers that can drift. `executionDeadlineMs` is the
 * give-up point; `maxPollAttempts` is the request budget that has to COVER it, and
 * `test/dune-credit-ceiling.test.ts` pins `maxPollAttempts × pollIntervalMs >= executionDeadlineMs`
 * so the request budget can never be what silently ends the wait first. It defaults to exactly that
 * product, so a caller that pins nothing keeps the give-up point it already had and gains only the
 * cancel.
 *
 * @param {DuneClient} client
 * @param {number} queryId
 * @param {Record<string, string>} parameters
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, resultLimit: number,
 *   executionDeadlineMs?: number | undefined, clock?: () => number }} bounds `clock` is injected
 *   only so a test can reach the deadline without waiting for it; a run reads the wall clock.
 * @returns {Promise<{ rows: unknown[], resultBytes: number }>}
 */
export async function executeAndRead(client, queryId, parameters, bounds) {
  const clock = bounds.clock ?? Date.now;
  const deadlineMs = bounds.executionDeadlineMs ?? bounds.maxPollAttempts * bounds.pollIntervalMs;
  const executionId = await client.execute(queryId, parameters);
  const startedAtMs = clock();
  // A LIVE EXECUTION IS NEVER LEFT RUNNING, WHATEVER TOOK US OUT OF THIS LOOP. The deadline and
  // the poll budget cancel themselves through `abandonExecution`; this catches every OTHER way
  // out with the engine still going — a request ceiling reached mid-poll, a transport failure,
  // a result read this repo refuses — and cancels before rethrowing the error unchanged. Two
  // things it deliberately does not do: it does not replace the caller's error (a
  // `CeilingReached` must keep its own remedy), and it does not cancel a SETTLED execution,
  // because there is nothing to stop and the result has already been paid for.
  let settled = false;
  try {
    for (let attempt = 0; attempt < bounds.maxPollAttempts; attempt++) {
      await client.wait(bounds.pollIntervalMs);
      const status = await client.getJson(`/execution/${executionId}/status`);
      const state = /** @type {any} */ (status)?.state;
      if (state === 'QUERY_STATE_COMPLETED') {
        // SETTLED: the engine has stopped on its own. A read this repository then refuses is a
        // refusal about the ANSWER, and cancelling a finished execution would neither save money
        // nor be true.
        settled = true;
        return readResult(client, `/execution/${executionId}/results?limit=${bounds.resultLimit}`, bounds.resultLimit);
      }
      if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED' || state === 'QUERY_STATE_EXPIRED') {
        // SETTLED the other way: the vendor stopped it. Nothing to cancel, and a cancel here would
        // spend a request to tell Dune something it just told us.
        settled = true;
        throw new DuneRefused(
          `Dune execution of query ${queryId} ended ${String(state)}. It is billed either way and it is ` +
            `NOT retried. There is no keyless route to a census, so this run produced no cohort at all. ` +
            `A statement that fails to COMPILE costs nothing; one that ran and then failed is billed for ` +
            `the engine time it consumed.`,
          { status: null, terminal: true },
        );
      }
      // The deadline is checked AFTER the poll, so a state the vendor has already settled is read
      // rather than cancelled: there is nothing to stop, and cancelling a finished execution would
      // discard a result this run has already paid for.
      if (clock() - startedAtMs >= deadlineMs) {
        await abandonExecution(client, {
          executionId,
          reason: 'deadline',
          elapsedMs: clock() - startedAtMs,
          deadlineMs,
          detail:
            `The census has no keyless route, so this run produced no cohort at all. Raising ` +
            `bounds.json dune.executionDeadlineMs buys COHORT_SQL more engine time and costs up to ` +
            `${executionDeadlineCredits(deadlineMs)} more credits per execution at the measured rate; ` +
            `it is a spend decision and dune.worstCaseCreditsPerExecution has to move with it.`,
        });
      }
    }
    await abandonExecution(client, {
      executionId,
      reason: 'poll-budget',
      elapsedMs: clock() - startedAtMs,
      deadlineMs,
      detail:
        `The poll budget of ${bounds.maxPollAttempts} × ${bounds.pollIntervalMs} ms expired before the ` +
        `deadline did, which means bounds.json dune.maxPollAttempts no longer covers ` +
        `dune.executionDeadlineMs — the two are meant to be one bound in two units. The census has no ` +
        `keyless route, so this run produced no cohort at all.`,
    });
  } catch (cause) {
    if (!settled && !(cause instanceof DuneExecutionAbandoned)) await cancelExecutionQuietly(client, executionId);
    throw cause;
  }
  /* c8 ignore next -- `abandonExecution` always throws; this satisfies the return type. */
  throw new Error('unreachable');
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
 * The run's spend, stated in the units the monthly credit ceiling is denominated in.
 *
 * It prices the CEILINGS, not the expected run: `dune.maxExecutionsPerRun` executions and one result
 * read each plus one of headroom, every read at the `?limit=` this month's plan will actually use.
 * A plan is admissible when its worst case fits — the same rule the screen applies to Helius — so
 * the guard is exact rather than usually-right.
 *
 * `plannedExecutions` is 0 on `--deploy` and `--verify`, which spend no execution and read no
 * result; the guard then costs nothing to satisfy and the run is not held up by an allowance it
 * cannot spend.
 *
 * @param {any} bounds
 * @param {{ resultLimit: number }} plan
 * @param {number} plannedExecutions
 * @returns {import('./client.mjs').DuneSpendPlan}
 */
export function duneSpendPlan(bounds, plan, plannedExecutions) {
  return {
    lane: 'tools/creation-census',
    executions: plannedExecutions,
    creditsPerExecution: bounds.dune.worstCaseCreditsPerExecution,
    // One result read per execution, plus one of headroom for a re-read. Zero when nothing executes.
    resultReads: plannedExecutions === 0 ? 0 : plannedExecutions + 1,
    rowsPerRead: plan.resultLimit,
    bytesPerRow: bounds.dune.resultBytesPerRowCeiling,
  };
}

/**
 * Read the account allowance and decide whether this plan may spend — BEFORE the saved-query
 * verification and long before the execution.
 *
 * **Every failure here yields no allowance rather than an optimistic one.** A transport failure, a
 * refusal, a body this cannot parse: all of them mean the balance is unknown, and
 * {@link decideAllowance} refuses an unknown balance while `dune.allowanceRequired` is true. The
 * reading itself is free and is retried once inside the client, so one hiccup does not reach here.
 *
 * @param {DuneClient} client
 * @param {object} input
 * @param {import('./client.mjs').DuneSpendPlan} input.spendPlan
 * @param {any} input.bounds
 * @param {number} input.nowMs
 * @returns {Promise<{ estimate: import('./client.mjs').DuneSpendEstimate,
 *   allowance: import('./client.mjs').DuneAllowance | null,
 *   decision: import('./client.mjs').AllowanceDecision }>}
 */
export async function checkDuneAllowance(client, input) {
  const estimate = estimatePlanCredits(input.spendPlan);
  /** @type {import('./client.mjs').UsageReading} */
  let reading = { ok: false, allowance: null, reasons: [] };
  try {
    reading = parseUsageResponse(await client.readUsage(), input.nowMs);
  } catch (cause) {
    // The message carries a path and a body excerpt and never a credential — the key is a HEADER
    // and is interpolated in exactly one place, so no URL or message this client builds holds it.
    reading = {
      ok: false,
      allowance: null,
      reasons: [`POST /usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }
  const decision = decideAllowance({
    plan: input.spendPlan,
    estimate,
    allowance: reading.allowance,
    unreadableReasons: reading.reasons,
    reserveCredits: input.bounds.dune.allowanceReserveCredits,
    // The operator's fleet-wide monthly cap, passed straight through: an absent pin arrives as
    // `undefined` and `decideAllowance` refuses it (captain decision 322a). The two keyed lanes
    // carry the same number under the same key name in their own bounds file, and
    // `test/dune-credit-ceiling.test.ts` pins the copies equal — a cap that bound one lane and not
    // the other would not be a fleet-wide total.
    monthlyCapCredits: input.bounds.dune.monthlyCreditCapCredits,
    tightMultiple: input.bounds.dune.allowanceTightMultiple,
    allowanceRequired: input.bounds.dune.allowanceRequired,
  });
  return { estimate, allowance: reading.allowance, decision };
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
  // THE ONLY BOUND ON WHAT ONE EXECUTION CAN COST, printed beside the ceilings that merely reserve
  // against it (captain decision 381). A worst case is what a plan is refused on; this is what the
  // run will actually do about an execution that will not finish.
  say(`  deadline       ${describeExecutionDeadline(bounds.dune.executionDeadlineMs)}`);
  say(`  out            ${outDir}`);
  const plannedExecutions = args.deploy || args.verify ? 0 : bounds.dune.maxExecutionsPerRun;
  const spendPlan = duneSpendPlan(bounds, plan, plannedExecutions);
  const estimate = estimatePlanCredits(spendPlan);
  // THE COST BEFORE THE SPEND, printed on every invocation including the keyless dry run. What the
  // dry run cannot show is the balance: reading it needs the key, so it is read on --live only, and
  // it is read BEFORE anything is verified or executed.
  say(
    `  worst case     ${estimate.worstCaseCredits} credit(s) — ${spendPlan.executions} execution(s) at ` +
      `${spendPlan.creditsPerExecution} = ${estimate.executionCredits}, plus ${spendPlan.resultReads} read(s) of at ` +
      `most ${spendPlan.rowsPerRead} row(s) at ${spendPlan.bytesPerRow} bytes = ${estimate.exportCredits}`,
  );
  // THE OPERATOR'S OWN CEILING, printed beside the plan's cost even here, where the vendor's figure
  // cannot be read (captain decision 322a). A --live run compares the worst case above against
  // whichever of the two is SMALLER and names the one that bound.
  say(
    `  operator cap   ${describeMonthlyCapCredits(bounds.dune.monthlyCreditCapCredits)} ` +
      `(bounds.json -> dune.monthlyCreditCapCredits), applied to the billing period of whichever ` +
      `key this run uses; the vendor's own figure for that period is the other ceiling, is read ` +
      `LIVE on --live, and the SMALLER of the two binds`,
  );
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
    say(
      '  the allowance itself is NOT read here: POST /usage needs the key. On --live it is read ' +
        'first, and the run refuses before the saved-query check if the worst case above does not fit.',
    );
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

  // ---- THE MONTHLY CREDIT CEILING, CHECKED BEFORE ANYTHING ELSE. -----------------------------
  // First keyed call of the run, ahead of the saved-query verification and long ahead of the
  // execution, because the failure this prevents is a billed run that dies partway with neither a
  // result nor the credits to retry — and stopping before the first execution is the whole point.
  // Skipped only when the run plans no execution at all (--deploy, --verify), where there is no
  // spend to gate.
  /** @type {import('./client.mjs').AllowanceDecision | null} */
  let allowanceDecision = null;
  if (plannedExecutions > 0) {
    try {
      const checked = await checkDuneAllowance(client, { spendPlan, bounds, nowMs: Date.now() });
      allowanceDecision = checked.decision;
    } catch (cause) {
      // checkDuneAllowance swallows its own read failures; reaching here means the client itself
      // refused (a ceiling, say), which is still an unknown balance and is still a refusal.
      say(`refused: the Dune allowance could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`);
      return EXIT.refused;
    }
    for (const line of describeAllowanceDecision(allowanceDecision)) say(line);
    say('');
    if (!allowanceDecision.ok) return EXIT.refused;
  }

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
      // The give-up point, in the unit it is a bound in. Reached, the execution is CANCELLED rather
      // than left running to Dune's own 30-minute limit — captain decision 381.
      executionDeadlineMs: bounds.dune.executionDeadlineMs,
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
      allowance: allowanceDecision,
      localEstimate: localCreditEstimate({
        executions: client.stats().executions,
        creditsPerExecution: bounds.dune.worstCaseCreditsPerExecution,
        resultBytes: client.stats().resultBytes,
      }),
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
    // WE STOPPED IT, as against it breaking — and it is checked BEFORE `DuneRefused` because it IS
    // one (see client.mjs -> DuneExecutionAbandoned) and the generic branch below would swallow the
    // distinction. Captain decision 381: an operator has to be able to read "this statement has
    // outgrown its deadline" off the exit code, not infer it from a message.
    if (cause instanceof DuneExecutionAbandoned) {
      say(`stopped: ${cause.message}`);
      say(
        `  executions spent this run: ${client.executions()} (billed whether or not they succeeded), ` +
          `bounded at this lane's pinned deadline of ${cause.deadlineMs} ms — worth at most ` +
          `${cause.worstCaseCredits} credit(s) of compute IF cancelling stops Dune's engine, and up to ` +
          `bounds.json dune.worstCaseCreditsPerExecution if it does not.`,
      );
      return EXIT.deadline;
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
