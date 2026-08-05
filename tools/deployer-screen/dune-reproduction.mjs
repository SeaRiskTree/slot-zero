/**
 * **Does the committed Dune statement reproduce the chain?** — the reproduction suite, run against
 * EVERY launch on the committed population tape. Gate 3 precondition 1, 2026-08-05.
 *
 * ## What this settles, and what it does not
 *
 * Gate 1 proved `dune-fills.mjs` → {@link ENTRY_SQL} reproduces one launch; a follow-up batch
 * measurement proved ten, all at zero error. Both are held in firstmate's records and not in this
 * repo, so both are asserted from elsewhere. THIS runs the same statement over all 235 launches the
 * tape proved coverage for and compares the result — through this repo's own production functions,
 * not a re-implementation — against `wallet_launch_pnl.csv`, the dataset's committed P&L table.
 *
 * The bar is `stage0.mjs` → {@link verifyFieldReproduction}'s own: **0 closure mismatches and a max
 * realised error under 1e-6 SOL**, over every create-slot outsider pair. (The 5e-07 this repo has
 * recorded elsewhere is a MEASURED RESULT from the tape-sourced leg, not a threshold; nothing here
 * treats it as one.) What passing it means is narrow and worth stating: the vendor's decoded rows
 * and the endpoint's own rows agree about who traded, how much, and whether they got out. It says
 * nothing about cost, about Stage 3, or about a launch this tape does not hold.
 *
 * ## The three choices that make the comparison honest
 *
 * 1. **ONE code path.** `duneRowsToWindow` → `measureLaunchEntry` → `verifyFieldReproduction` are
 *    the production functions, called here with Dune rows where a run calls them with the endpoint's.
 *    A parallel reimplementation would be testing this file rather than the statement.
 * 2. **The tape's OWN window, per launch.** `measureSubjectLaunches` measures each launch over its
 *    whole stored window — 60s on 210 launches, 120s on 4, 300s on 21 of the 235 — and
 *    `wallet_launch_pnl.csv` is computed over that same window. So the scan asks for that window and
 *    {@link NO_TRIM_SLOT_SPAN} keeps `windowFilter` from trimming it further. That the trim never
 *    binds is CHECKED per launch, not assumed; see {@link NO_TRIM_SLOT_SPAN}.
 * 3. **The whole window, not the part that is read.** Nothing in Stage 2 reads a fill whose wallet
 *    never touched the create slot — `measureLaunchEntry` totals only the create-slot outsiders and
 *    `entryCostTargets` walks only their transactions — so a statement returning 10,396 of the
 *    tape's 107,439 rows would produce every figure below at about a tenth of the bytes. It is NOT
 *    what is committed or what is measured here: that reduction encodes a property of today's
 *    consumer into the statement, and a later consumer would find a statement nobody had proven.
 *    The saving is real and is recorded as an option the captain has not taken, not taken quietly.
 *
 * ## Custody, and why the order is the deliverable
 *
 * A saved query is editable from a browser, so the committed text is compared against the deployed
 * one BEFORE the first execution — a disagreement refuses the WHOLE leg and costs nothing.
 * {@link runReproduction} does that once, at the top, and {@link custodyOrderVerdict} states the
 * property over a recorded call log so a test can drive both a compliant and a deliberately
 * mis-ordered runner through the same predicate and watch it fail on the second. An assertion that
 * cannot fail is the defect this repo keeps finding.
 *
 * ## Spend
 *
 * Every ceiling refuses before the first billed request: the monthly balance is read from
 * `POST /usage` (free), the plan is priced in credits, and a plan that does not fit is refused
 * WHOLE rather than truncated to fit. A part-run would report a completeness figure over a
 * population chosen by where the money ran out. `--live` is the only way to spend; the default
 * prints the plan and opens no socket.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALLOWANCE_LAG_CAVEAT,
  ALLOWANCE_SHARED_CAVEAT,
  DuneClient,
  EXPORT_CREDITS_PER_MB,
  decideAllowance,
  parseUsageResponse,
} from './client.mjs';
import { resolveDuneCredential } from './credential.mjs';
import { assertSavedQueryMatches, executeAndRead, normaliseSql } from './dune.mjs';
import { ENTRY_QUERY_ID, ENTRY_SQL, duneRowsToWindow, entryQueryParameters } from './dune-fills.mjs';
import { measureLaunchEntry } from './entry.mjs';
import { createSlotGroups } from './measure.mjs';
import { cohortRoomLeft, measureSubjectLaunches, verifyFieldReproduction } from './stage0.mjs';

/**
 * The slot span handed to `duneRowsToWindow`, chosen so the window trim CANNOT bind.
 *
 * `windowFilter` cuts a live Stage 2 window to `stage2_entry.windowSlotSpan` slots because a live
 * run has no stored window to use. This comparison does: the statement is asked for the launch's own
 * `window_ms`, which is the window `wallet_launch_pnl.csv` was computed over, and the stage 0 header
 * states why imposing a slot span on top would move closure verdicts at the tail and break the very
 * reproduction that makes the live recipe trustworthy.
 *
 * A no-op sentinel is a value that can silently start binding, so it is not trusted: every launch
 * asserts `fills.length === rowsSeen`, i.e. the trim dropped nothing, and a launch where it did is
 * reported as a failure rather than measured. 1,000,000 slots is ~4.6 days at the measured
 * worst-case rate against a 300 s longest window — five orders of magnitude of headroom, and the
 * check is what makes the headroom a fact rather than a hope.
 */
export const NO_TRIM_SLOT_SPAN = 1_000_000;

/**
 * The clock slack backdated off the tape's own declared mint before the scan starts.
 *
 * It buys the coverage proof and nothing else: `duneRowsToWindow` refuses a window whose scan began
 * at or after the declared mint, because an absence of older rows only means something if older rows
 * were asked for. It is the same 5,000 ms `thresholds.json` → `stage2_entry.seekMarginMs` pins and
 * that `bundling.mjs` and the arrival-rate walk both carry, restated here rather than imported
 * because this lane must not acquire a dependency on the screen's recipe: a change to the live
 * seek margin must not silently redefine what this measurement scanned.
 *
 * It is NOT slack on the pre-mint tripwire. A row older than the declared mint is still a
 * disagreement and still drops the launch — on this tape the tripwire has nothing to forgive, since
 * every launch's earliest fill sits exactly on its own declared mint instant.
 */
export const SCAN_MARGIN_MS = 5_000;

/**
 * Rows one execution's result may plan for.
 *
 * **Not a vendor limit and not `dune.maxResultRows`.** `readResult` refuses a result above
 * `maxResultRows` (40,000) and refuses one that came back as a PAGE — `/results` pages on response
 * size independently of the `?limit=` it was issued with — so a batch must be small enough that the
 * whole result arrives in one response, which is a bytes property rather than a rows one. Half the
 * row ceiling at this statement's ~200-byte rows is ~4 MB, comfortably one response, and it leaves
 * the reader's own ceiling doing the job it already does: refusing a result that cannot prove it is
 * whole.
 *
 * The planner sizes batches from the TAPE's own per-launch fill counts, which is the only forward
 * estimate available. A Dune result materially larger than the tape's count is not smoothed over: it
 * either clears the reader's checks and is reported as a row-count disagreement, or it does not and
 * the read is refused.
 */
export const MAX_PLANNED_ROWS_PER_EXECUTION = 20_000;

/**
 * Bytes per returned row, for pricing the plan. **A CEILING, and it is the measured figure plus a
 * margin — not the measurement.**
 *
 * MEASURED 2026-08-05 at **230.1 bytes/row**, from Dune's own declared `total_result_set_bytes` on
 * two independent batches of this statement: 7,363 bytes over 32 rows and 518,848 over 2,255. The
 * two agree to four significant figures, which is what a fixed-width projection should do — every
 * row carries a base58 signature (88), a base58 mint and a base58 wallet (44 each) and nine short
 * numeric or tag fields, and none of them varies much.
 *
 * The pin is 250 rather than 230.1 because it prices a plan the run is then held to, and an
 * estimate that sits ON its own measurement refuses nothing and admits a run that is 1% over. The
 * ~8.6% margin is stated rather than folded in silently.
 */
export const ESTIMATED_BYTES_PER_ROW = 250;

/**
 * Worst-case execution-compute credits for ONE batch of this statement.
 *
 * **MEASURED FOR THIS STATEMENT, and that re-derivation is the point of the number.** It was first
 * pinned at 225 — the top of the band this repo had measured for statements that join the trade
 * tape (0.75-0.92 for the creation queries against 81.74 and 221.51 for two trade-tape joins) — and
 * at that pin the full 235-launch plan priced at 3,237 credits and the guard REFUSED it. That
 * refusal was correct and it was also uninformative, because the pin was carried from a different
 * statement rather than derived from this one.
 *
 * So it was measured, from the balance itself rather than from `execution_cost_credits`, which
 * understates by ~3.5x. Two executions, `POST /usage` read before and after each:
 *
 * - a 65-SECOND scan hull, 1 launch, 32 rows: 0.395 credits total, of which 0.147 is the result
 *   read at 20 credits/MB — so **~0.25 credits of compute**;
 * - a 16.1-DAY scan hull, 11 launches, 2,255 rows: 12.287 credits total, 10.377 of it the read —
 *   so **~1.91 credits of compute**.
 *
 * Compute tracks the SCAN HULL and is small: four orders of magnitude of hull bought 7.7x the
 * compute, because the statement's mint equi-join and its `block_time` predicate let the engine skip
 * almost everything. The widest hull this plan issues is 29.8 days, which extrapolates linearly to
 * ~3.5 credits. **10 is pinned**: ~5x the largest measurement and ~3x that extrapolation, so a
 * hull-to-compute relationship steeper than linear still fits, while the number stays small enough
 * that the guard bites if this statement is ever edited into an expensive one.
 *
 * **THE COST OF THIS LANE IS RETRIEVAL, NOT COMPUTE** — ~495 credits of bytes against ~24 of
 * compute over the full tape — which inverts the assumption `thresholds.json` → `stage2_entry_dune`
 * reasons from for a Stage 2 run ("the lever is windows scanned, not rows returned"). The two are
 * not in conflict: that block returns ONE aggregated row per launch, and this one returns every
 * fill. It is stated here because a reader arriving from that block will otherwise size this one
 * wrongly.
 */
export const WORST_CASE_CREDITS_PER_EXECUTION = 10;

/**
 * Credits held back for the usage counter's lag. Same reserve the screen's Dune leg pins, and for
 * the same reason: the counter was measured rising 6.0 credits while the account was idle and it
 * lands in whole-credit jumps, so a reading over-states what remains.
 */
export const ALLOWANCE_RESERVE_CREDITS = 25;

/**
 * @typedef {object} TapeLaunchRef
 * One launch as the committed tape declares it, read from the sidecar alone.
 *
 * @property {string} mint
 * @property {string} symbol
 * @property {number} createdAtMs Declared mint instant.
 * @property {number} windowMs    THIS launch's own window. Never a flat 60,000.
 * @property {number} tapeFills   Rows the committed window tape holds, for sizing a batch.
 */

/**
 * Read the tape's launch list from the `window/*.meta.json` sidecars.
 *
 * **Gated on `reached_mint`, not on file existence** — all 239 mints have a window file and four
 * never reached the mint, and those four are truncated at the OLDEST end, so a reader that trusted
 * the filename would compare against a launch whose create slot the collector never saw. The gzipped
 * fills are read only for `tapeFills`, which the planner needs to size a batch.
 *
 * @param {string} dataDir Path to `data/population-tape-2026-07-29`.
 * @returns {TapeLaunchRef[]} Oldest first.
 */
export function readTapeLaunches(dataDir) {
  const windowDir = join(dataDir, 'window');
  /** @type {TapeLaunchRef[]} */
  const out = [];
  for (const file of readdirSync(windowDir)) {
    if (!file.endsWith('.meta.json')) continue;
    const meta = /** @type {Record<string, unknown>} */ (
      JSON.parse(readFileSync(join(windowDir, file), 'utf8'))
    );
    if (meta['reached_mint'] !== true) continue;
    out.push({
      mint: String(meta['mint']),
      symbol: String(meta['symbol'] ?? ''),
      createdAtMs: Number(meta['created_timestamp']),
      windowMs: Number(meta['window_ms']),
      tapeFills: Number(meta['n']),
    });
  }
  out.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.mint < b.mint ? -1 : 1));
  return out;
}

/**
 * @typedef {object} ReproductionBatch
 * @property {string} month        The `YYYY-MM` partition this batch sits in.
 * @property {TapeLaunchRef[]} launches
 * @property {number} plannedRows  The tape's own row count for these launches.
 */

/**
 * Split the tape into executions.
 *
 * **By month first, then by planned rows.** The month is what the statement's partition predicate
 * prunes on, so a batch that straddles months pays for both; and a batch is capped at
 * {@link MAX_PLANNED_ROWS_PER_EXECUTION} rows so its result arrives as one response rather than as a
 * page the reader refuses. Launches stay in date order inside a month, so the split is deterministic
 * and two plans over the same tape are the same plan.
 *
 * A single launch whose own tape count exceeds the cap would get a batch of its own and be reported
 * as over the cap rather than silently split — this statement cannot return half a window, and half
 * a window is a biased sample rather than a short one. On the committed tape the largest launch is
 * 2,321 fills, so this does not arise.
 *
 * @param {readonly TapeLaunchRef[]} launches
 * @param {number} [maxRows]
 * @returns {ReproductionBatch[]}
 */
export function planReproduction(launches, maxRows = MAX_PLANNED_ROWS_PER_EXECUTION) {
  /** @type {ReproductionBatch[]} */
  const batches = [];
  for (const launch of launches) {
    const month = new Date(launch.createdAtMs).toISOString().slice(0, 7);
    const open = batches[batches.length - 1];
    if (open !== undefined && open.month === month && open.plannedRows + launch.tapeFills <= maxRows) {
      open.launches.push(launch);
      open.plannedRows += launch.tapeFills;
      continue;
    }
    batches.push({ month, launches: [launch], plannedRows: launch.tapeFills });
  }
  return batches;
}

/**
 * The scan bounds one launch is asked about.
 *
 * The old edge is backdated by {@link SCAN_MARGIN_MS} to buy the coverage proof; the new edge is the
 * launch's own declared window, which is what the committed P&L was computed over.
 *
 * @param {TapeLaunchRef} launch
 * @returns {import('./dune-fills.mjs').EntryWindowRequest}
 */
export function scanWindowFor(launch) {
  return {
    mint: launch.mint,
    fromMs: launch.createdAtMs - SCAN_MARGIN_MS,
    toMs: launch.createdAtMs + launch.windowMs,
  };
}

/**
 * Price a plan in credits, before anything is spent.
 *
 * Executions are priced at the ceiling ({@link WORST_CASE_CREDITS_PER_EXECUTION} each) because a
 * plan is admissible only when its WORST case fits. Bytes are priced from the tape's own row counts
 * rather than from the row cap, because the tape is a measurement of how many rows these windows
 * hold and the cap is only a bound on how they are grouped — pricing 12 reads at the cap would
 * refuse a run over rows that provably do not exist.
 *
 * @param {readonly ReproductionBatch[]} batches
 * @returns {import('./client.mjs').DuneSpendEstimate}
 */
export function estimateReproductionCredits(batches) {
  const executionCredits = batches.length * WORST_CASE_CREDITS_PER_EXECUTION;
  const exportBytes = batches.reduce((n, b) => n + b.plannedRows, 0) * ESTIMATED_BYTES_PER_ROW;
  const exportCredits = (exportBytes / 1_000_000) * EXPORT_CREDITS_PER_MB;
  const round = (/** @type {number} */ n) => Number(n.toFixed(3));
  return {
    executionCredits: round(executionCredits),
    exportBytes,
    exportCredits: round(exportCredits),
    worstCaseCredits: round(executionCredits + exportCredits),
  };
}

/**
 * @typedef {object} CustodyCall
 * One observable call a run made, in the order it made it.
 *
 * @property {'saved-query-read' | 'execute'} kind
 * @property {number} queryId
 */

/**
 * @typedef {object} CustodyVerdict
 * @property {boolean} ok
 * @property {string[]} reasons Empty exactly when `ok`.
 */

/**
 * Does this call log show custody being taken BEFORE money was spent?
 *
 * **Two clauses, and both have to be able to fail.**
 *
 * 1. The committed text was compared against the saved query at least once before the FIRST
 *    execution. Comparing afterwards is not custody; it is a receipt for a bill already incurred.
 * 2. Every execution is of the query whose text was verified. A run that verified one id and
 *    executed another has checked nothing.
 *
 * A log with no execution passes both vacuously, which is the right answer: that is what a refusal
 * looks like, and a refusal costing nothing is the property being asserted.
 *
 * This is a pure predicate over a recorded log rather than a claim about source order, so a test can
 * drive a compliant runner and a deliberately execute-first one through the SAME function and watch
 * the second fail. That is the difference between an assertion and a comment.
 *
 * @param {readonly CustodyCall[]} log
 * @returns {CustodyVerdict}
 */
export function custodyOrderVerdict(log) {
  /** @type {string[]} */
  const reasons = [];
  const verified = new Set();
  let firstExecutionAt = -1;
  for (let i = 0; i < log.length; i++) {
    const call = /** @type {CustodyCall} */ (log[i]);
    if (call.kind === 'saved-query-read') {
      if (firstExecutionAt === -1) verified.add(call.queryId);
      continue;
    }
    if (firstExecutionAt === -1) firstExecutionAt = i;
    if (!verified.has(call.queryId)) {
      reasons.push(
        `execution ${i + 1} of query ${call.queryId} was billed before its committed text had been ` +
          `compared against the saved query, so a browser edit could have moved a measurement and ` +
          `the bill would already be spent.`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * A {@link DuneClient} that records the two calls custody is a statement about.
 *
 * A decorator rather than a flag inside the client, so the production client is unchanged and the
 * recording cannot alter what is sent. It forwards everything and reads the path to classify it,
 * which is the same string `assertSavedQueryMatches` and `client.execute` build.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @returns {{ client: import('./client.mjs').DuneClient, log: CustodyCall[] }}
 */
export function recordCustody(client) {
  /** @type {CustodyCall[]} */
  const log = [];
  /** @type {import('./client.mjs').DuneClient} */
  const wrapped = /** @type {never} */ ({
    issued: () => client.issued(),
    executions: () => client.executions(),
    resultBytes: () => client.resultBytes(),
    stats: () => client.stats(),
    noteResultBytes: (/** @type {number} */ b) => client.noteResultBytes(b),
    wait: (/** @type {number} */ ms) => client.wait(ms),
    readUsage: () => client.readUsage(),
    getJson: (/** @type {string} */ path) => {
      const match = /^\/query\/(\d+)$/.exec(path);
      if (match !== null) log.push({ kind: 'saved-query-read', queryId: Number(match[1]) });
      return client.getJson(path);
    },
    execute: (/** @type {number} */ queryId, /** @type {Record<string, string>} */ parameters) => {
      log.push({ kind: 'execute', queryId });
      return client.execute(queryId, parameters);
    },
  });
  return { client: wrapped, log };
}

/**
 * @typedef {object} RefutedReference
 * A (launch, wallet) pair whose REFERENCE value — the committed dataset's, not ours — is
 * contradicted by the chain, with what it takes to re-check that.
 *
 * @property {string} mint
 * @property {string} wallet
 * @property {number} disagreeingFills How many of this pair's fills the tape and the statement
 *   disagree about. Every one of them was arbitrated on-chain.
 * @property {number} tapeSol  Those fills' SOL as `window/{mint}.jsonl.gz` records it.
 * @property {number} duneSol  The same fills' SOL as the entry statement returns it.
 * @property {string} tx       One of the disagreeing transactions, so the check is reproducible from
 *   this constant alone: `getTransaction` it and read the wallet's own balance delta.
 */

/**
 * Every (launch, wallet) pair on the committed tape whose reference the CHAIN refutes.
 *
 * **CAPTAIN DECISION 293a, 2026-08-05:** the bar is judged over the pairs this constant does NOT
 * name, on the three conditions this module already met — the exclusions stay enumerated by
 * transaction, the unexcluded reading stays printed beside the excluded one, and closure stays
 * checked over the whole population. The finding itself is ratified as `IMPORT.md` correction 11
 * (decision 294a), with no dataset row edited.
 *
 * **THIS IS NOT A TOLERANCE AND IT MUST NEVER BECOME ONE.** No bar moved, no error was rounded away
 * and no population was widened. Twelve pairs are named individually, every one of them arbitrated
 * against `api.mainnet-beta`, and {@link compareReproduction} reports the comparison BOTH WAYS —
 * over all 1,322 pairs and over the 1,310 whose reference is not refuted. A reader who thinks the
 * exclusion is wrong reads the unexcluded figure in the same record. Loosening `minRoomLeft` to fit
 * an output is the failure this repo names by name; the defences against doing the same thing here
 * are that the excluded set is enumerated rather than described, that the evidence is independent
 * of the thing being tested, and that both readings ship side by side.
 *
 * ## What was measured
 *
 * Over all **107,439** fills of the tape, the statement and the tape agree on the token amount on
 * **107,439** — every row — and disagree on the SOL amount on **1,042 (0.97%)**, in two shapes:
 *
 * - **658 rows where the TAPE's `sol` is far too small**, by factors of 25-40. `psol × base` — the
 *   tape's OWN price column, on the same row — lands on the statement's figure, not on the tape's.
 *   **22 of these fills reach a create-slot outsider's realised P&L, and all 22 were checked
 *   on-chain: the wallet's real balance delta agrees with the STATEMENT on 22 of 22 and with the
 *   tape on 0.** Those 22 fills are the 12 pairs below. The transactions carry pump.fun's newer
 *   `BuyExactSolIn` instruction, which is the lead on the cause and is not established here.
 * - **384 rows where the STATEMENT returns `sol_raw = 0`**, and this is NOT a defect. All 384
 *   are the whole of one launch — `maxxing`, `97nnzgv9…`, which is one of the two launches sharing
 *   that symbol and is **quoted in USDC, not SOL**: its create transaction moves 36.99 USDC and
 *   0.0189 SOL. The decoded `SwapEvent` reports the SOL amount, which is genuinely zero; the
 *   swap-api reports a SOL-EQUIVALENT valuation. They are different quantities and neither is
 *   wrong. **That launch contributes zero closed create-slot outsider pairs, so it never reaches
 *   this comparison — which is luck rather than design, and a lane scoring a non-SOL-quoted launch
 *   through the Dune source would be reading zeros as free entries.** **Do not conflate 384 with the
 *   393 rows the statement returns zero on**: the other nine are rows the tape reads as zero too, so
 *   both sources AGREE on them and they were never disagreements. **Captain decision 295b files that hazard against the
 *   GATE 3 CUTOVER rather than here**, so this module records it and guards nothing: do not add a
 *   quote-mint filter to the statement or a drop rule to this suite on the way past.
 *
 * ## What is NOT claimed
 *
 * That the tape is wrong on all 658. Only the 22 that reach a graded pair were arbitrated on-chain;
 * the rest share the shape and the internal `psol` contradiction, which is evidence and not proof.
 *
 * **The dataset row is NEVER edited** — the never-reformat rule is absolute — and the finding is
 * filed in that dataset's `IMPORT.md` → "Corrections", the documented home for evidence that
 * contradicts an imported record.
 */
export const REFUTED_REFERENCE_PAIRS = /** @type {readonly RefutedReference[]} */ ([
  {
    mint: 'CympZjkuNLSzXmTd9P375dH5rVnnja4rACvgNCsEpump',
    wallet: 'pekN74koZ15b48R8Kj3N9disT3XjaceT3HjfnUfgmwE',
    disagreeingFills: 1,
    tapeSol: 0.072133332,
    duneSol: 1.913860914,
    tx: '5pV9eNiyMxR9LstANfQp1xmn2dwKVuEj5bzHF2r5gsPL7zKZT3wyNPhYH2bt2cGKK3Fjd25kVLb8LNk5vNCMqp1J',
  },
  {
    mint: '7LS4TVEVp5wadBoAzXw7Xsh59V87gQGxnEAKtc9jpump',
    wallet: '2mqrindMAjJEQPLhroYWyiYPo5h9iAsahfdd4QtsjwdY',
    disagreeingFills: 1,
    tapeSol: 0.071986011,
    duneSol: 1.905811473,
    tx: '5JUau5gbV6ZoHyLQoD6utJjySigFvBE8eCypQdh9eAhbnyfcNGRsdUPTSjhJWQo94wRPzinQ7cGgTd752dn6drCW',
  },
  {
    mint: 'H6e9XnLJAvmXjRQEHqL6N7bZqURVdyE2wEQntcnMpump',
    wallet: '5brv79eFZ2rGprXNvqgVJBkBptkkw8GJX1XydJyZLyAr',
    disagreeingFills: 1,
    tapeSol: 0.062238382,
    duneSol: 1.646494594,
    tx: '2abU2EenQeo9TKeXgTLum2i67ZxWxCTsgzAcDb439CrJZp53Hg87EuMhJtheNVM4LEnNCsZFv8pBpnzLspLPWzVh',
  },
  {
    mint: '87ECoUcsioYVxcV71JAwWMhiAEof3gKBV6XLb4szpump',
    wallet: '5brv79eFZ2rGprXNvqgVJBkBptkkw8GJX1XydJyZLyAr',
    disagreeingFills: 1,
    tapeSol: 0.051459284,
    duneSol: 1.363513988,
    tx: '4NYSyYRcw21BZYSQ3hjXPS4gUAbjUs4RwoQSoZx6ntphz6JquqNrPhEZKKbRLe1Uw9PnwUYG3tqb1h8HeRjojyNv',
  },
  {
    mint: 'CccTALHeFndQhWsN1KdPPiDZPtSzvv2KeQfjasqBpump',
    wallet: '5brv79eFZ2rGprXNvqgVJBkBptkkw8GJX1XydJyZLyAr',
    disagreeingFills: 1,
    tapeSol: 0.036507623,
    duneSol: 0.911242787,
    tx: '3N2Rpf8Ly61rWndF4MfJgreKBTkP2nGJxhhfE9ehXeSHLE3HMVin5vqqeXivF2gzhNBv2Vq4KdqCW43VWk1LxBf3',
  },
  {
    mint: 'FaEXgcaRekBgQ6aVFDK2PuVX7ps9K9xn2JvfuTbEpump',
    wallet: 'BZuSpNbXAdwZ7A66rAzAwkxRssUfAWCimh57dubD6A4W',
    disagreeingFills: 1,
    tapeSol: 0.035255342,
    duneSol: 0.891638594,
    tx: '5KrNMZ2SSqLzXfKQXZ24tRJk51cehyJ5Lxoco4LYDJXPJ7MvMJdnbGyv5ziy5SECxDTr6QoSNoYsuGFRMfcgDS4a',
  },
  {
    mint: '4u1LwQQWgR6vyhjrp3sJvv4d6wXCNrVdS78HxWAypump',
    wallet: 'FcjLCZn9mmK4opSzAG8TU36XoiN3zi87M7tdarJcAWhr',
    disagreeingFills: 1,
    tapeSol: 0.034439344,
    duneSol: 0.876843844,
    tx: '49G7bLpK4yUVVDVL1jT3r9hr7z8uCR8u26o3uSkp42mhziQpt1D57aCSq6XtsqKCpx2ggffRsqykZKhFbmHQssK',
  },
  {
    mint: 'GugurhdcJvntY1hXDMFB9Zk8K3aL2aH8g89u1ctDpump',
    wallet: '7Lf6kEy7eEHounyS82DsSd1k7FvoAUFyu9b4EA743WyV',
    disagreeingFills: 1,
    tapeSol: 0.007154119,
    duneSol: 0.118833433,
    tx: 'KS2WzBKw4m5TaQTAbaQKfu4rFzp6HJUJdTcv8EfTtvgBD6FaK2EBi27x5RECcLfVKAyTNrNZQNePWTLcVu3zSoK',
  },
  {
    mint: '2aqfW4bNxHiZ3Ta5mo42kmrGisYbmo98ARxD3BFqpump',
    wallet: 'FuU4YuViuphyhsV1dFgW2gpZu81xBvmua8AcgggpXfJZ',
    disagreeingFills: 2,
    tapeSol: 0.003808024,
    duneSol: 0.058358212,
    tx: '42JySviqbbLWnkeUvKJvzx7Wka7L9xkdgRQ1BMcCFA248j3WqpeZV3dCdHmHXFuf8qoS8DhAG7qgLsTfrNh6g2Hb',
  },
  {
    mint: 'FaEXgcaRekBgQ6aVFDK2PuVX7ps9K9xn2JvfuTbEpump',
    wallet: 'FuU4YuViuphyhsV1dFgW2gpZu81xBvmua8AcgggpXfJZ',
    disagreeingFills: 10,
    tapeSol: 0.001513451,
    duneSol: 0.021676127,
    tx: 'ooJfNVv4nvev98PtHx7Nt3oD7SsvU5VtUVhEQ6jQmqxpY45p2vMh5E9ZS2XGNJ5Wbjn2Q3qe535QArxkgcPPgez',
  },
  {
    mint: 'HmDbKdd7uoM8KSBuWdFq8B45yeeqti5KWKNXNm8apump',
    wallet: 'AqmyUaCa2riiZGXyzpPfuFffGLTXZUUMdjxa5Kfna4Zj',
    disagreeingFills: 1,
    tapeSol: 0.001249676,
    duneSol: 0.01917503,
    tx: '61RNB872wuHRdDKcoiFFnKJT3qTMgnRw1s9K4Gki9ctQqHVF2f6dq1yDTDnT43Yjw326WVJ4hUGzXSMfs3JB9UYo',
  },
  {
    mint: 'FaEXgcaRekBgQ6aVFDK2PuVX7ps9K9xn2JvfuTbEpump',
    wallet: '94NuM2cQ2T2xz2F9K2cJZqQd2rdQmVCvYi3QQY1YJfDc',
    disagreeingFills: 1,
    tapeSol: 0.000906409,
    duneSol: 0.009462793,
    tx: 'Vh2vYMRDcyKiTBuehA8qSpd2xZijgRvJDA9nvPZLHrcSi2vhp9FDmh2RpqMD9PZ5Jwmunkr64FjH72PDTMmArXp',
  },
]);

/**
 * @typedef {object} LaunchComparison
 * @property {string} mint
 * @property {string} symbol
 * @property {number} tapeRows      Fills the committed tape holds for this window.
 * @property {number} duneRows      Rows the statement returned for it.
 * @property {number} duneAmmRows   How many of those were PumpSwap fills — captain decision 256a's
 *   union, counted per launch so "the 18 graduation-spanning launches were measured" is a number
 *   rather than an assertion.
 * @property {boolean} usable       Whether `duneRowsToWindow` would let this window be measured.
 * @property {string | null} dropReason
 * @property {boolean} trimBound    Whether {@link NO_TRIM_SLOT_SPAN} dropped anything. Must be false.
 * @property {number | null} createSlot
 * @property {number | null} tapeCreateSlot
 * @property {number} fieldEntrants
 * @property {number} tapeFieldEntrants
 * @property {number | null} roomLeft
 * @property {number | null} tapeRoomLeft
 */

/**
 * Turn one launch's Dune rows into the same shape `measureSubjectLaunches` produces from the tape.
 *
 * Pure, and it runs the production reader: `duneRowsToWindow` for the coverage proof, the pre-mint
 * tripwire and the ordering recovery, then `measureLaunchEntry` for the create slot and the field.
 *
 * @param {TapeLaunchRef} launch
 * @param {readonly unknown[]} rows
 * @returns {{ taped: import('./stage0.mjs').TapedLaunch | null,
 *   window: import('./fill-source.mjs').SourcedLaunchWindow }}
 */
export function duneLaunchFrom(launch, rows) {
  const scan = scanWindowFor(launch);
  const window = duneRowsToWindow(rows, {
    mint: launch.mint,
    createdAtMs: launch.createdAtMs,
    windowSlotSpan: NO_TRIM_SLOT_SPAN,
    scan: { fromMs: scan.fromMs, toMs: scan.toMs, requests: 0 },
  });
  if (!window.usable) return { taped: null, window };
  const entry = measureLaunchEntry(window.fills);
  const groups = createSlotGroups(window.fills);
  if (entry === null || groups === null) return { taped: null, window };
  return {
    taped: {
      mint: launch.mint,
      dateIso: new Date(launch.createdAtMs).toISOString(),
      createSlot: entry.createSlot,
      field: entry.field,
      fills: window.fills,
      cohortRoomLeft: cohortRoomLeft(groups),
    },
    window,
  };
}

/**
 * @typedef {object} ReproductionResult
 * @property {number} launchesPlanned
 * @property {number} launchesMeasured   Launches the statement produced a measurable window for.
 * @property {number} ammLaunches        Launches carrying at least one PumpSwap fill.
 * @property {number} ammRows
 * @property {number} duneRows
 * @property {number} tapeRows
 * @property {number} launchesDuneShort Launches where Dune returned FEWER rows than the tape holds.
 *   This is the failure direction and the one the whole route is written against: a short window
 *   loses late sells first, so a wallet that closed reads as open.
 * @property {number} launchesDuneLong  Launches where Dune returned MORE. The opposite finding, and
 *   it is about the TAPE rather than the vendor — the swap-api walk sheds and backs off, so its own
 *   tail can be incomplete. Counted apart because averaging the two into one "disagreement" number
 *   would hide which side was short.
 * @property {number} rowCountDisagreements The two together.
 * @property {number} createSlotDisagreements
 * @property {number} fieldDisagreements Launches whose Dune field holds a different number of
 *   entrants than the tape's. Reported over EVERY entrant, including the ones
 *   {@link REFUTED_REFERENCE_PAIRS} names, and it is the reported reading rather than the gating one.
 * @property {number} fieldDisagreementsOnUnrefutedReferences The same count with the named pairs'
 *   wallets removed from BOTH sides. **This is what `ok` reads**, for decision 293a's reason: a gate
 *   that counted the enumerated exclusions would fail on exactly the tape defect the captain ruled
 *   on, and would reverse that ruling by the back door.
 * @property {LaunchComparison[]} launches
 * @property {import('./stage0.mjs').FieldReproduction} field The bar over EVERY pair, including the
 *   one whose reference the chain refutes. Reported first and never hidden.
 * @property {import('./stage0.mjs').FieldReproduction} fieldOnUnrefutedReferences The same bar over
 *   the pairs {@link REFUTED_REFERENCE_PAIRS} does not name. **This is what `ok` reads**, because
 *   the question is whether the statement reproduces the CHAIN and on that one pair the reference
 *   is what the chain disagrees with.
 * @property {readonly RefutedReference[]} refutedReferences What was excluded, with its evidence.
 * @property {import('./stage0.mjs').FieldReproduction} tapeField The same bar over the committed
 *   tape, computed offline in the same run so the two are comparable rather than quoted apart.
 * @property {boolean} ok
 * @property {string[]} failures
 */

/**
 * Do a launch's two field-entrant sets disagree in SIZE, on the entrants that may decide anything?
 *
 * Pure, and the seam the gate reads. `ignoringRefutedReferences` drops the wallets
 * {@link REFUTED_REFERENCE_PAIRS} names FOR THIS MINT from both sides before counting, which is
 * captain decision 293a one level down: the enumerated pairs are where the chain refutes the tape's
 * own reference, so a gate that counted them would fail on the defect the captain ruled on and would
 * reverse that ruling by the back door. Nothing else is ever dropped.
 *
 * @param {string} mint
 * @param {readonly { wallet: string }[]} duneField
 * @param {readonly { wallet: string }[]} tapeField
 * @param {{ ignoringRefutedReferences: boolean }} opts
 * @returns {boolean}
 */
export function fieldEntrantsDisagree(mint, duneField, tapeField, opts) {
  if (!opts.ignoringRefutedReferences) return duneField.length !== tapeField.length;
  const refuted = new Set(REFUTED_REFERENCE_PAIRS.filter((p) => p.mint === mint).map((p) => p.wallet));
  const count = (/** @type {readonly { wallet: string }[]} */ field) =>
    field.filter((e) => !refuted.has(e.wallet)).length;
  return count(duneField) !== count(tapeField);
}

/**
 * Compare Dune-sourced launches against the committed tape and against `wallet_launch_pnl.csv`.
 *
 * **Three independent checks, and every one of them GATES.** Row counts and create slots are the
 * cheap structural ones; the field reproduction is the one that decides, being `stage0.mjs`'s own
 * function over the dataset's own published P&L on every create-slot outsider pair. What each of the
 * structural two does with its result is not symmetric, and the asymmetry is the point:
 *
 * - **A SHORT launch fails the run outright.** Short is this route's failure direction — a window
 *   missing its tail loses late sells first, so a wallet that closed reads as open — and the AMM
 *   shortfall that produced it once is fixed at its cause, so a recurrence is a regression.
 * - **A LONG launch does not gate.** It says the TAPE's own walk was short, which is a finding about
 *   the tape rather than about the statement, and it is 1 today (`Killswitch`).
 * - **A field-entrant disagreement fails the run, counted over the unrefuted entrants.** Without it
 *   an edit to the statement that dropped one create-slot entrant would simply shrink
 *   `verifyFieldReproduction`'s population: not a closure mismatch, not a `missingFromCsv` (which
 *   counts the other direction), no create slot moved — a smaller PASS. Both readings are reported;
 *   only the unrefuted one gates, for the reason {@link fieldEntrantsDisagree} states.
 *
 * @param {string} dataDir
 * @param {readonly TapeLaunchRef[]} planned
 * @param {Map<string, unknown[]>} rowsByMint
 * @returns {ReproductionResult}
 */
export function compareReproduction(dataDir, planned, rowsByMint) {
  const tapeLaunches = measureSubjectLaunches(dataDir);
  const tapeByMint = new Map(tapeLaunches.map((l) => [l.mint, l]));

  /** @type {LaunchComparison[]} */
  const comparisons = [];
  /** @type {import('./stage0.mjs').TapedLaunch[]} */
  const duneLaunches = [];
  /** @type {string[]} */
  const failures = [];
  /**
   * Launches disagreeing over the entrants the chain does NOT refute — the GATING reading.
   * @type {string[]}
   */
  const fieldDisagreementMints = [];
  /**
   * The same, over EVERY entrant — reported beside it, and gating nothing.
   * @type {string[]}
   */
  const fieldDisagreementMintsAllEntrants = [];

  for (const launch of planned) {
    const rows = rowsByMint.get(launch.mint) ?? [];
    const { taped, window } = duneLaunchFrom(launch, rows);
    const tape = tapeByMint.get(launch.mint) ?? null;
    const ammRows = rows.filter(
      (r) => typeof r === 'object' && r !== null && /** @type {Record<string, unknown>} */ (r)['venue'] === 'pump_amm',
    ).length;
    const comparison = {
      mint: launch.mint,
      symbol: launch.symbol,
      tapeRows: launch.tapeFills,
      duneRows: rows.length,
      duneAmmRows: ammRows,
      usable: window.usable,
      dropReason: window.dropReason,
      // The trim must be inert. `rowsSeen` counts what came back; `fills` counts what survived
      // `windowFilter`, and on this comparison nothing may.
      trimBound: window.usable && window.fills.length !== window.rowsSeen,
      createSlot: taped?.createSlot.slot ?? null,
      tapeCreateSlot: tape?.createSlot.slot ?? null,
      fieldEntrants: taped?.field.length ?? 0,
      tapeFieldEntrants: tape?.field.length ?? 0,
      roomLeft: taped?.createSlot.roomLeft ?? null,
      tapeRoomLeft: tape?.createSlot.roomLeft ?? null,
    };
    comparisons.push(comparison);
    // BOTH readings come out of {@link fieldEntrantsDisagree}, differing only in the flag. The
    // reported one used to be an inline `fieldEntrants !== tapeFieldEntrants` over the comparison
    // row — arithmetically the same thing, and that is exactly the problem: it was a SECOND
    // expression of the predicate, so the reported and gating numbers were only equal by
    // coincidence of authorship and the reported one was covered by no production caller. Routing
    // it through the same function makes them provably the same measurement, and puts both flag
    // settings under test in real use rather than only in the unit test.
    if (window.usable) {
      const duneField = taped?.field ?? [];
      const tapeFieldEntrants = tape?.field ?? [];
      if (fieldEntrantsDisagree(launch.mint, duneField, tapeFieldEntrants, { ignoringRefutedReferences: true })) {
        fieldDisagreementMints.push(`${launch.symbol} (${launch.mint})`);
      }
      if (fieldEntrantsDisagree(launch.mint, duneField, tapeFieldEntrants, { ignoringRefutedReferences: false })) {
        fieldDisagreementMintsAllEntrants.push(`${launch.symbol} (${launch.mint})`);
      }
    }
    if (taped !== null) duneLaunches.push(taped);
    else failures.push(`${launch.symbol} (${launch.mint}): ${window.note}`);
    if (comparison.trimBound) {
      failures.push(
        `${launch.symbol} (${launch.mint}): the no-op window trim BOUND — ${window.rowsSeen} row(s) ` +
          `in, ${window.fills.length} kept. NO_TRIM_SLOT_SPAN no longer covers this window, so this ` +
          `comparison is against a shorter window than wallet_launch_pnl.csv was computed over.`,
      );
    }
  }

  const launchesDuneShort = comparisons.filter((c) => c.duneRows < c.tapeRows).length;
  const launchesDuneLong = comparisons.filter((c) => c.duneRows > c.tapeRows).length;
  const rowCountDisagreements = launchesDuneShort + launchesDuneLong;
  const createSlotDisagreements = comparisons.filter(
    (c) => c.createSlot !== null && c.tapeCreateSlot !== null && c.createSlot !== c.tapeCreateSlot,
  ).length;
  const fieldDisagreements = fieldDisagreementMintsAllEntrants.length;
  const fieldDisagreementsOnUnrefutedReferences = fieldDisagreementMints.length;

  const field = verifyFieldReproduction(dataDir, duneLaunches);
  const tapeField = verifyFieldReproduction(dataDir, tapeLaunches);

  // The SECOND reading, over the pairs whose reference the chain does not refute. Same function,
  // same launches, one entrant dropped per named pair — so the two readings differ by exactly the
  // evidence in REFUTED_REFERENCE_PAIRS and by nothing else. A pair not named there is never
  // dropped, whatever it does to the figure.
  const refuted = new Set(REFUTED_REFERENCE_PAIRS.map((p) => `${p.mint}|${p.wallet}`));
  const fieldOnUnrefutedReferences = verifyFieldReproduction(
    dataDir,
    duneLaunches.map((l) => ({ ...l, field: l.field.filter((e) => !refuted.has(`${l.mint}|${e.wallet}`)) })),
  );

  if (duneLaunches.length !== planned.length) {
    failures.push(
      `${planned.length - duneLaunches.length} of ${planned.length} launch(es) produced no measurable ` +
        `window, so this run measured a subset chosen by where the statement fell short.`,
    );
  }
  if (createSlotDisagreements > 0) failures.push(`${createSlotDisagreements} launch(es) disagree about the create slot.`);
  if (launchesDuneShort > 0) {
    failures.push(
      `${launchesDuneShort} launch(es) came back SHORT of the tape's own fill count. A short window ` +
        `loses late sells first, so a wallet that closed reads as open — this is the failure ` +
        `direction the route is written against, and it fails the run.`,
    );
  }
  if (fieldDisagreementsOnUnrefutedReferences > 0) {
    failures.push(
      `${fieldDisagreementsOnUnrefutedReferences} launch(es) hold a different number of field ` +
        `entrants than the tape, over the entrants the chain does not refute: ` +
        `${fieldDisagreementMints.join(', ')}. A dropped entrant shrinks the population the field ` +
        `reproduction is measured over rather than failing it, so it is caught here.`,
    );
  }
  if (!fieldOnUnrefutedReferences.ok) {
    const f = fieldOnUnrefutedReferences;
    failures.push(
      `the field reproduction FAILED: ${f.closureMismatches} closure mismatch(es), max realised ` +
        `error ${f.maxRealisedErrorSol.toExponential(3)} SOL, ${f.missingFromCsv} pair(s) the ` +
        `dataset does not carry, over ${f.pairs} pair(s).`,
    );
  }
  // A CLOSURE mismatch is never excusable by a refuted reference and is checked on the WHOLE
  // population: the exclusions are about a realised AMOUNT the chain settles, and closure is a
  // different question with a different answer.
  if (field.closureMismatches > 0) {
    failures.push(`${field.closureMismatches} closure mismatch(es) over the whole population.`);
  }

  return {
    launchesPlanned: planned.length,
    launchesMeasured: duneLaunches.length,
    ammLaunches: comparisons.filter((c) => c.duneAmmRows > 0).length,
    ammRows: comparisons.reduce((n, c) => n + c.duneAmmRows, 0),
    duneRows: comparisons.reduce((n, c) => n + c.duneRows, 0),
    tapeRows: comparisons.reduce((n, c) => n + c.tapeRows, 0),
    launchesDuneShort,
    launchesDuneLong,
    rowCountDisagreements,
    createSlotDisagreements,
    fieldDisagreements,
    fieldDisagreementsOnUnrefutedReferences,
    launches: comparisons,
    field,
    fieldOnUnrefutedReferences,
    refutedReferences: REFUTED_REFERENCE_PAIRS,
    tapeField,
    ok: failures.length === 0 && fieldOnUnrefutedReferences.ok,
    failures,
  };
}

/**
 * Read the monthly balance and decide whether this plan may spend — before the first billed request.
 *
 * The saved-query comparison is a READ and costs no credits, but a result read IS billed by bytes,
 * so the balance is checked ahead of everything. An unreadable balance refuses: "we could not see
 * it" is not headroom.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {readonly ReproductionBatch[]} batches
 * @param {number} nowMs
 * @returns {Promise<{ estimate: import('./client.mjs').DuneSpendEstimate,
 *   allowance: import('./client.mjs').DuneAllowance | null,
 *   decision: import('./client.mjs').AllowanceDecision }>}
 */
export async function checkReproductionAllowance(client, batches, nowMs) {
  const estimate = estimateReproductionCredits(batches);
  /** @type {import('./client.mjs').UsageReading} */
  let reading = { ok: false, allowance: null, reasons: [] };
  try {
    reading = parseUsageResponse(await client.readUsage(), nowMs);
  } catch (cause) {
    reading = {
      ok: false,
      allowance: null,
      reasons: [`POST /usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }
  const decision = decideAllowance({
    plan: {
      lane: 'tools/deployer-screen (Dune entry reproduction)',
      executions: batches.length,
      creditsPerExecution: WORST_CASE_CREDITS_PER_EXECUTION,
      resultReads: batches.length,
      rowsPerRead: MAX_PLANNED_ROWS_PER_EXECUTION,
      bytesPerRow: ESTIMATED_BYTES_PER_ROW,
    },
    estimate,
    allowance: reading.allowance,
    unreadableReasons: reading.reasons,
    reserveCredits: ALLOWANCE_RESERVE_CREDITS,
    // One worst case, not two: this lane runs once against a fixed tape, so "can it be run again
    // this period" is not a property worth refusing over — unlike the screen, which is repeatable.
    tightMultiple: 1,
    allowanceRequired: true,
  });
  return { estimate, allowance: reading.allowance, decision };
}

/**
 * Run the reproduction. **This spends.**
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {object} opts
 * @param {readonly ReproductionBatch[]} opts.batches
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, maxResultRows: number }} opts.bounds
 * @param {number} [opts.queryId]
 * @param {string} [opts.sql]
 * @param {(line: string) => void} [opts.say]
 * @returns {Promise<{ rowsByMint: Map<string, unknown[]>, executions: number, resultBytes: number }>}
 */
export async function runReproduction(client, opts) {
  const queryId = opts.queryId ?? ENTRY_QUERY_ID;
  const sql = opts.sql ?? ENTRY_SQL;
  const say = opts.say ?? (() => undefined);

  // CUSTODY FIRST, AND ONCE. A repo/saved-query disagreement throws a terminal `DuneRefused` here,
  // before a single execution has been started, so the whole leg refuses and costs nothing. It is
  // deliberately outside the batch loop: a run that verified before batch 1 and drifted before batch
  // 7 is not a case this can protect against — a saved query cannot change mid-execution any more
  // usefully than the text can — and putting it inside would buy one request per batch for the
  // appearance of vigilance.
  await assertSavedQueryMatches(client, queryId, sql);
  say(`  saved query ${queryId} matches the committed ENTRY_SQL byte for byte; executing.`);

  /** @type {Map<string, unknown[]>} */
  const rowsByMint = new Map();
  for (const batch of opts.batches) {
    for (const launch of batch.launches) rowsByMint.set(launch.mint, []);
  }

  for (const [index, batch] of opts.batches.entries()) {
    const parameters = entryQueryParameters(batch.launches.map(scanWindowFor));
    const before = client.resultBytes();
    const result = await executeAndRead(client, queryId, parameters, opts.bounds);
    for (const row of result.rows) {
      if (typeof row !== 'object' || row === null) continue;
      const mint = /** @type {Record<string, unknown>} */ (row)['mint'];
      const bucket = typeof mint === 'string' ? rowsByMint.get(mint) : undefined;
      // A row for a mint this batch did not ask about is a statement that ignored its own predicate.
      // It is counted as unplaced rather than dropped quietly: `compareReproduction` then sees a row
      // count that disagrees with the tape, which is the visible failure.
      if (bucket !== undefined) bucket.push(row);
    }
    say(
      `  batch ${index + 1}/${opts.batches.length} (${batch.month}, ${batch.launches.length} launch(es)): ` +
        `${result.rows.length} row(s) planned ${batch.plannedRows}, ` +
        `${(client.resultBytes() - before).toLocaleString('en-US')} byte(s).`,
    );
  }

  return { rowsByMint, executions: client.executions(), resultBytes: client.resultBytes() };
}

/**
 * The caveats every reading from this lane travels with.
 *
 * Stated as a constant so the record, the printed summary and the companion README cannot drift into
 * three different versions of what was and was not established.
 */
export const REPRODUCTION_CAVEATS = [
  'This is ONE deployer over one tape. Agreement here says the decoded tables and the trade endpoint ' +
    'report the same fills for these 235 windows; it establishes nothing about a launch outside them.',
  'Everything compared is GROSS OF FEES on both sides. `wallet_launch_pnl.csv` is a projection of the ' +
    'same fill tape, so this proves the statement reproduces those fills — not that the resulting P&L ' +
    'is fee-inclusive, which it is not.',
  ALLOWANCE_LAG_CAVEAT,
  ALLOWANCE_SHARED_CAVEAT,
];

/**
 * The fingerprint of the statement a record was measured with.
 *
 * **The saved-query ID is not enough to identify what was run.** The documented deploy step keeps
 * the SAME id across an edit — `README.md` → "Deploying a change to the committed SQL" — so a record
 * that pins only `queryId` stays green over a statement it never saw, and every "the bar is met over
 * 235 launches" assertion would then be describing text that no longer exists. The record therefore
 * carries this too, and the record's test compares it against the committed `ENTRY_SQL`.
 *
 * It hashes {@link normaliseSql}'s output rather than the raw text, so it is the same equivalence
 * the custody comparison uses: a reflow that `assertSavedQueryMatches` would accept does not
 * invalidate a record, and a change of meaning does.
 *
 * ## IT IS SENSITIVE TO THE STATEMENT'S COMMENTS, AND THAT IS ACCEPTED RATHER THAN OVERLOOKED
 *
 * `normaliseSql` folds line endings and trailing whitespace and nothing else, so editing a COMMENT
 * inside {@link ENTRY_SQL} — where this repo writes its traps down — changes this fingerprint and
 * turns the committed record's assertion red, even though the rows the vendor returns are identical.
 *
 * That is deliberate, and stripping comments before hashing would be the wrong fix:
 *
 * - **It is exactly the equivalence custody already imposes.** `assertSavedQueryMatches` compares
 *   the same `normaliseSql` output against the deployed query, comments included, precisely because
 *   the comments are where the traps live and a browser edit to one is a change to the artefact.
 *   A fingerprint that ignored them would be a WEAKER guard than the one beside it, and the two
 *   would disagree about what "the same statement" means.
 * - **The cost of a false red is a doc edit; the cost of a false green is a record describing text
 *   that no longer exists.** Those are not symmetric.
 *
 * **SO A COMMENT-ONLY EDIT TO `ENTRY_SQL` HAS A REAL PRICE, AND HERE IS WHAT IT IS.** The record's
 * fingerprint can only be brought back into agreement by one of two things, and NEITHER is editing
 * the JSON by hand:
 *
 * 1. **Re-run the reproduction** — `--live`, ~495 credits of a 2,500-credit shared month; or
 * 2. **Revert the comment**, which costs nothing.
 *
 * A third route exists and is not free either: redeploying the saved query to the edited text, which
 * is the documented deploy step and is required anyway before any run, since the custody comparison
 * runs first and would otherwise refuse the whole leg terminally.
 *
 * **NEVER hand-edit `entrySqlSha256` in a committed record to make a test pass.** The field exists
 * to say which text produced those numbers; typing a new value into it asserts a measurement that
 * was never taken, which is the one failure this whole lane was built to make impossible. If the
 * statement's meaning changed, the numbers are stale and the record must be re-measured or retired.
 *
 * @param {string} [sql]
 * @returns {string} sha256, hex.
 */
export function entrySqlFingerprint(sql = ENTRY_SQL) {
  return createHash('sha256').update(normaliseSql(sql), 'utf8').digest('hex');
}

export { ENTRY_QUERY_ID, ENTRY_SQL };

/**
 * CLI. `--live` is the only way to spend; the default prints the plan and opens no socket.
 *
 * `--months` and `--mints` narrow the tape to a SUBSET, and a subset can never satisfy the
 * reproduction's own claim — they exist to price and validate a change to the statement cheaply
 * before the whole tape is re-fetched. A record written from a narrowed run says so in its own
 * `launchesPlanned`, which is why the committed record's test asserts 235 rather than "all".
 *
 * `--from-rows` recomputes the comparison from a `--rows` cache and opens no socket. It exists
 * because the FIRST whole-tape run of this lane spent ~530 credits, kept only the comparison, and a
 * correction to the statement then had to buy every row again. A change to the comparison must
 * never cost a re-fetch.
 *
 * @param {readonly string[]} argv
 * @returns {{ live: boolean, dataDir: string, out: string | null, rows: string | null,
 *   fromRows: string | null, months: string[], mints: string[] }}
 */
export function parseArgs(argv) {
  let live = false;
  let dataDir = 'data/population-tape-2026-07-29';
  /** @type {string | null} */
  let out = null;
  /** @type {string | null} */
  let rows = null;
  /** @type {string | null} */
  let fromRows = null;
  /** @type {string[]} */
  let months = [];
  /** @type {string[]} */
  let mints = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') live = true;
    else if (arg === '--data') dataDir = String(argv[++i]);
    else if (arg === '--out') out = String(argv[++i]);
    else if (arg === '--rows') rows = String(argv[++i]);
    else if (arg === '--from-rows') fromRows = String(argv[++i]);
    else if (arg === '--months') months = String(argv[++i]).split(',').filter((m) => m !== '');
    else if (arg === '--mints') mints = String(argv[++i]).split(',').filter((m) => m !== '');
    else throw new Error(`unknown flag ${String(arg)}`);
  }
  return { live, dataDir, out, rows, fromRows, months, mints };
}

/**
 * Read a `--rows` cache back into the shape {@link compareReproduction} takes.
 *
 * @param {string} path
 * @param {(p: string) => Buffer} read
 * @param {(b: Buffer) => Buffer} gunzip
 * @returns {Map<string, unknown[]>}
 */
export function readRowCache(path, read, gunzip) {
  /** @type {Map<string, unknown[]>} */
  const byMint = new Map();
  for (const line of gunzip(read(path)).toString('utf8').split('\n')) {
    if (line === '') continue;
    const entry = /** @type {{ mint: string, row: unknown }} */ (JSON.parse(line));
    const bucket = byMint.get(entry.mint);
    if (bucket === undefined) byMint.set(entry.mint, [entry.row]);
    else bucket.push(entry.row);
  }
  return byMint;
}

/* c8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = await import('node:fs');
  const args = parseArgs(process.argv.slice(2));
  const say = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);

  const all = readTapeLaunches(args.dataDir);
  const selected = all
    .filter((l) => args.months.length === 0 || args.months.includes(new Date(l.createdAtMs).toISOString().slice(0, 7)))
    .filter((l) => args.mints.length === 0 || args.mints.includes(l.mint));
  const batches = planReproduction(selected);
  const estimate = estimateReproductionCredits(batches);

  say('');
  say('Dune entry-statement reproduction — every launch on the committed tape');
  say(`  tape           ${args.dataDir}`);
  say(`  launches       ${selected.length} of ${all.length} that reached the mint`);
  say(`  rows planned   ${batches.reduce((n, b) => n + b.plannedRows, 0).toLocaleString('en-US')} (the tape's own counts)`);
  say(`  executions     ${batches.length}`);
  say(
    `  ESTIMATE       ${estimate.worstCaseCredits} credits = ${batches.length} x ` +
      `${WORST_CASE_CREDITS_PER_EXECUTION} compute + ${estimate.exportCredits} export ` +
      `(${(estimate.exportBytes / 1_000_000).toFixed(1)} MB at ${EXPORT_CREDITS_PER_MB} credits/MB)`,
  );
  say(`  saved query    ${ENTRY_QUERY_ID}, compared against the committed text BEFORE any execution`);
  say(`  statement      sha256 ${entrySqlFingerprint()} of the normalised ENTRY_SQL`);

  /**
   * Report a finished comparison. Shared by the live path and the offline recompute so the two
   * cannot print different summaries of the same numbers.
   *
   * @param {ReproductionResult} result
   * @param {CustodyVerdict} custody
   * @param {ReturnType<import('./client.mjs').DuneClient['stats']> | null} spend
   * @param {'observed' | 'carried-from-the-fetching-run'} custodySource Which run OBSERVED the
   *   saved-query comparison. An offline recompute observed nothing and must say so rather than
   *   restate a verdict it inherited.
   */
  const report = (result, custody, spend, custodySource) => {
    say('');
    say(`  launches       ${result.launchesMeasured} of ${result.launchesPlanned} measured`);
    say(`  rows           ${result.duneRows} from Dune against ${result.tapeRows} on the tape`);
    say(
      `                 short on ${result.launchesDuneShort} launch(es), long on ` +
        `${result.launchesDuneLong} — only SHORT is this route's failure direction`,
    );
    say(`  PumpSwap       ${result.ammRows} row(s) across ${result.ammLaunches} launch(es) — decision 256a's union`);
    say(`  create slots   ${result.createSlotDisagreements} disagreement(s)`);
    say(
      `  field size     ${result.fieldDisagreementsOnUnrefutedReferences} launch(es) disagree on the ` +
        `entrant count over the unrefuted entrants — the gating reading — against ` +
        `${result.fieldDisagreements} over every entrant`,
    );
    say(
      `  FIELD (all)    ${result.field.pairs} pair(s), ${result.field.closureMismatches} closure ` +
        `mismatch(es), max realised error ${result.field.maxRealisedErrorSol.toExponential(3)} SOL`,
    );
    say(
      `  FIELD (bar)    ${result.fieldOnUnrefutedReferences.pairs} pair(s), ` +
        `${result.fieldOnUnrefutedReferences.closureMismatches} closure mismatch(es), max realised ` +
        `error ${result.fieldOnUnrefutedReferences.maxRealisedErrorSol.toExponential(3)} SOL ` +
        `— excluding ${result.refutedReferences.length} pair(s) the CHAIN refutes the reference on`,
    );
    for (const p of result.refutedReferences) {
      say(
        `      excluded ${p.wallet.slice(0, 8)}… on ${p.mint.slice(0, 8)}…: ${p.disagreeingFills} fill(s), ` +
          `tape ${p.tapeSol} SOL against ${p.duneSol}, chain agrees with the statement (${p.tx.slice(0, 10)}…)`,
      );
    }
    say(
      `  tape leg       ${result.tapeField.pairs} pair(s), ${result.tapeField.closureMismatches} closure ` +
        `mismatch(es), max realised error ${result.tapeField.maxRealisedErrorSol.toExponential(3)} SOL`,
    );
    say(`  custody        ${custody.ok ? 'verified before the first execution' : custody.reasons.join(' ')}`);
    for (const failure of result.failures) say(`    FAILED: ${failure}`);
    say(`  VERDICT        ${result.ok && custody.ok ? 'PASS' : 'FAIL'}`);
    if (spend !== null) say(`  spend          ${JSON.stringify(spend)}`);

    if (args.out !== null) {
      writeFileSync(
        args.out,
        `${JSON.stringify(
          {
            lane: 'dune-entry-reproduction',
            queryId: ENTRY_QUERY_ID,
            entrySqlSha256: entrySqlFingerprint(),
            dataDir: args.dataDir,
            batches: batches.map((b) => ({ month: b.month, launches: b.launches.length, plannedRows: b.plannedRows })),
            estimate,
            custody,
            custodySource,
            spend,
            result,
            caveats: REPRODUCTION_CAVEATS,
          },
          null,
          2,
        )}\n`,
      );
      say(`  wrote          ${args.out}`);
    }
    process.exit(result.ok && custody.ok ? 0 : 1);
  };

  // OFFLINE RECOMPUTE. No socket, no credential, no spend — the rows were already paid for.
  //
  // Custody and spend are properties of the run that FETCHED, so they are carried from the record
  // that run wrote rather than restated: this pass observed neither. `custodySource` says which,
  // and a record with no prior run to carry from gets a refusal rather than an inherited `ok`.
  if (args.fromRows !== null) {
    const { gunzipSync } = await import('node:zlib');
    const { existsSync, readFileSync: read } = await import('node:fs');
    const prior =
      args.out !== null && existsSync(args.out)
        ? /** @type {{ custody?: CustodyVerdict, spend?: object }} */ (JSON.parse(read(args.out, 'utf8')))
        : {};
    say('');
    say(`  RECOMPUTED from ${args.fromRows} — no socket was opened and nothing was spent.`);
    report(
      compareReproduction(args.dataDir, selected, readRowCache(args.fromRows, read, gunzipSync)),
      prior.custody ?? { ok: false, reasons: ['no fetching run to carry a custody verdict from'] },
      /** @type {never} */ (prior.spend ?? null),
      'carried-from-the-fetching-run',
    );
  }

  if (!args.live) {
    say('');
    say('  DRY RUN — nothing was requested and no socket was opened. Re-run with --live to spend.');
    process.exit(0);
  }

  const credential = resolveDuneCredential(process.env);
  if (!credential.available || credential.key === null) {
    say('');
    say(`  REFUSED: ${credential.rejected ?? 'no Dune credential is available.'}`);
    process.exit(2);
  }

  // Polls cost a request and no credits, so the attempt count is sized to outlast the widest scan
  // rather than trimmed: an execution abandoned by our own poll ceiling is billed exactly as much as
  // one we waited for, and is worth nothing.
  const bounds = { pollIntervalMs: 3_000, maxPollAttempts: 200, maxResultRows: 40_000 };
  const client = new DuneClient({
    key: credential.key,
    maxExecutions: batches.length,
    // Each batch costs one execute, up to `maxPollAttempts` status polls and one result read, plus
    // the single saved-query read and the usage read at the top. Sized so the ceiling cannot stop a
    // planned run half way, which is the one failure mode worse than refusing it.
    maxRequests: batches.length * (bounds.maxPollAttempts + 2) + 4,
    minIntervalMs: 250,
  });

  const { decision } = await checkReproductionAllowance(client, batches, Date.now());
  say('');
  say(
    `  allowance      ${decision.verdict}: ${decision.creditsUsed ?? '?'} used of ` +
      `${decision.creditsIncluded ?? '?'}, ${decision.spendableCredits ?? '?'} spendable after a ` +
      `${decision.reserveCredits}-credit reserve, against a worst case of ${decision.worstCaseCredits}`,
  );
  for (const reason of decision.reasons) say(`    ${reason}`);
  if (!decision.ok) {
    say('');
    say('  REFUSED before the first billed request. The plan is refused WHOLE rather than truncated:');
    say('  a part-run reports completeness over a population chosen by where the money ran out.');
    process.exit(3);
  }

  const { client: recorded, log } = recordCustody(client);
  const { rowsByMint } = await runReproduction(recorded, { batches, bounds, say });
  const custody = custodyOrderVerdict(log);

  // KEEP WHAT WAS PAID FOR, when asked to. The first full run of this lane spent ~530 credits, threw
  // the rows away and kept only the comparison — so correcting the statement's AMM half meant buying
  // all 107,439 rows a second time, including the 97,000 the correction did not touch. `--rows`
  // writes them so the next change to the COMPARISON costs nothing.
  //
  // It is opt-in and the file is a working artefact, not a committed one: Dune's terms are "derive
  // and discard", which this repo reads as deriving what it needs and not accumulating a vendor's
  // data. A local cache for one session is the deriving; committing 24 MB of vendor rows would be
  // the accumulating.
  if (args.rows !== null) {
    const { gzipSync } = await import('node:zlib');
    const lines = [...rowsByMint.entries()].flatMap(([mint, rows]) =>
      rows.map((r) => JSON.stringify({ mint, row: r })),
    );
    writeFileSync(args.rows, gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));
    say(`  cached         ${lines.length} row(s) to ${args.rows} (a working file; not for committing)`);
  }

  report(compareReproduction(args.dataDir, selected, rowsByMint), custody, client.stats(), 'observed');
}
/* c8 ignore stop */
