#!/usr/bin/env node
/**
 * The collector CLI. Keyless throughout — **zero metered provider requests**, and the credential
 * allow-list for this directory is empty.
 *
 * ```
 * node tools/arrival-rate-walk/collect.mjs --phase preflight --out data/arrival-rate-2026-08
 * node tools/arrival-rate-walk/collect.mjs --phase plan  --cohort <file> --launch-list <file>
 * node tools/arrival-rate-walk/collect.mjs --phase walk  --launch-list <file> --out <dir> [--dry-run]
 * node tools/arrival-rate-walk/collect.mjs --phase series --out <dir>
 * ```
 *
 * ## The order is the safety property, not a convenience
 *
 * `preflight` before anything else, because the collection it authorises is days long and the clock
 * failure it looks for is silent. `plan` before `walk`, because a plan is the only place the cost of
 * a run is stated before it is spent — it issues **no request at all** and refuses a run whose
 * bounds do not hold. `walk` checkpoints every launch and skips what is already on disk, so an
 * interruption costs the launch in flight and nothing else. `series` is offline over what the walk
 * persisted, so the definitional question decision 164c deferred is answered from the data rather
 * than from a re-fetch.
 *
 * ## Every request it issues is recorded
 *
 * `requests.csv` gets one row per **attempt**, retries and refusals included, so a run's exact cost
 * is a committed fact rather than a claim in prose. `--out` is required for anything that issues a
 * request, precisely so no run can happen without leaving that record.
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KeylessClient, CeilingReached, SWAP_API, SOLANA_RPC } from './client.mjs';
import { readLaunches, readWindowTape, csvField } from './tape.mjs';
import { readDuneResultFile, parseCohortRows, parseLaunchListRows, assessCohortCoverage, chooseThreshold } from './cohort.mjs';
import { selectPreflightLaunches, measureBlockTimeSkew, measureDuneClockSkew, assessSkew } from './preflight.mjs';
import { walkOpeningWindow } from './walk.mjs';
import { measureLaunch, seriesRow, SERIES_COLUMNS, ALL_ENTRANT_FLOOR_CAVEAT, GROSS_OF_FEES_CAVEAT } from './series.mjs';
import { findWindows, summariseArrival } from './arrival.mjs';

/** The pinned bounds. Read once, never overridden downward-unsafe by a flag. */
export const BOUNDS = JSON.parse(readFileSync(fileURLToPath(new URL('./bounds.json', import.meta.url)), 'utf8'));

/**
 * A count from the command line, refused rather than coerced.
 *
 * `Number('x')` is `NaN`, and every comparison this collector makes against these values fails
 * *open*: `requests < NaN` ends a walk at zero, and `wait > NaN` removes the pacing floor entirely
 * and hammers a shared public endpoint. A bound that silently becomes no bound is worse than no flag.
 *
 * @param {string} flag
 * @param {string} raw
 * @returns {number}
 */
export function positiveNumber(flag, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} needs a positive finite number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** @param {readonly string[]} argv */
export function parseArgs(argv) {
  /** @type {{ phase: string, out: string | null, cohort: string | null, launchList: string | null,
   *   limit: number | null, only: string[], minIntervalMs: number, maxRequests: number, dryRun: boolean }} */
  const args = {
    phase: '',
    out: null,
    cohort: null,
    launchList: null,
    limit: null,
    only: [],
    minIntervalMs: BOUNDS.walk.minIntervalMs,
    maxRequests: BOUNDS.walk.maxRequestsPerRun,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--phase') args.phase = next();
    else if (a === '--out') args.out = next();
    else if (a === '--cohort') args.cohort = next();
    else if (a === '--launch-list') args.launchList = next();
    else if (a === '--limit') args.limit = positiveNumber('--limit', next());
    else if (a === '--only') args.only.push(next());
    else if (a === '--min-interval-ms') args.minIntervalMs = positiveNumber('--min-interval-ms', next());
    else if (a === '--max-requests') args.maxRequests = positiveNumber('--max-requests', next());
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const phases = ['preflight', 'plan', 'walk', 'series'];
  if (!phases.includes(args.phase)) throw new Error(`--phase must be one of ${phases.join(', ')}`);
  // The measured floor is the one constraint this whole lane exists to honour: 2 s is refused
  // outright by the fill endpoint. The command line may raise it and may not undercut it.
  if (args.minIntervalMs < BOUNDS.walk.minIntervalMs) {
    throw new Error(`--min-interval-ms may not go below the measured ${BOUNDS.walk.minIntervalMs}ms floor`);
  }
  if (args.maxRequests > BOUNDS.walk.maxRequestsPerRun) {
    throw new Error(`--max-requests may not exceed the pinned ceiling of ${BOUNDS.walk.maxRequestsPerRun}`);
  }
  if (args.phase === 'walk' && args.launchList === null) {
    throw new Error('--launch-list is required for the walk: it is what says which launches exist');
  }
  if (args.phase !== 'plan' && args.out === null) {
    throw new Error('--out is required: a run that leaves no record is not reproducible');
  }
  return args;
}

/** @param {string} message */
function say(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * @param {string} out
 * @param {string} phase
 * @returns {(event: import('./client.mjs').RequestEvent) => void}
 */
export function ledger(out, phase) {
  const path = join(out, 'requests.csv');
  if (!existsSync(path)) writeFileSync(path, 'phase,at_utc,host,mint,status,interval_ms\n');
  return (event) => {
    // The URL is reduced to a host and a mint. The full URL adds nothing a reader needs and makes
    // the ledger a list of endpoints to replay rather than a record of what this run spent.
    const mint = event.url.match(/\/coins\/([^/]+)\/trades/)?.[1] ?? '';
    const host = event.url.startsWith(SWAP_API) ? 'swap-api' : 'solana-rpc';
    appendFileSync(
      path,
      `${phase},${new Date().toISOString()},${host},${mint},${event.status ?? 'transport'},${event.intervalMs}\n`,
    );
  };
}

// -------------------------------------------------------------------------------------------
// preflight

/**
 * The clock pre-flight. Leg A always; leg B whenever a launch-list export is at hand.
 *
 * @param {object} args
 * @param {string} args.out
 * @param {KeylessClient} args.client
 * @param {string | null} [args.launchListPath]
 * @param {number} [args.sampleLaunches]
 * @returns {Promise<{ verdict: import('./preflight.mjs').SkewVerdict, samples: import('./preflight.mjs').SkewSample[],
 *   duneVerdict: import('./preflight.mjs').SkewVerdict | null, duneSamples: import('./preflight.mjs').SkewSample[] }>}
 */
export async function runPreflight({ out, client, launchListPath = null, sampleLaunches = BOUNDS.preflight.sampleLaunches }) {
  const picked = selectPreflightLaunches(readLaunches(), (m) => readWindowTape(m), sampleLaunches);
  say(`preflight leg A: ${picked.length} launches, at most ${picked.length * BOUNDS.preflight.attemptsPerLaunch} requests`);
  const samples = await measureBlockTimeSkew({
    client,
    launches: picked,
    attemptsPerLaunch: BOUNDS.preflight.attemptsPerLaunch,
    log: say,
  });
  const verdict = assessSkew(samples, BOUNDS.walk.mintFloorSlackMs);

  /** @type {import('./preflight.mjs').SkewSample[]} */
  let duneSamples = [];
  /** @type {import('./preflight.mjs').SkewVerdict | null} */
  let duneVerdict = null;
  if (launchListPath !== null) {
    const list = parseLaunchListRows(readDuneResultFile(readFileSync(launchListPath, 'utf8'), launchListPath));
    duneSamples = measureDuneClockSkew([...list.byDeployer.values()].flat(), (m) => readWindowTape(m));
    duneVerdict = assessSkew(duneSamples, BOUNDS.walk.mintFloorSlackMs);
    say(`preflight leg B: ${duneSamples.length} launches matched against the committed tape, 0 requests`);
  } else {
    say(
      'preflight leg B SKIPPED: no --launch-list. Leg A compares the CHAIN clock against the vendor ' +
        "clock and infers Dune's column from its schema; leg B compares that column directly and " +
        'costs nothing. Run it before the collection.',
    );
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'preflight.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        slackMs: BOUNDS.walk.mintFloorSlackMs,
        legA: { source: 'getBlockTime(createSlot) vs the committed window sidecar', verdict, samples },
        legB:
          duneVerdict === null
            ? { skipped: 'no launch-list export was supplied' }
            : { source: "Dune created_at vs the committed window sidecar", verdict: duneVerdict, samples: duneSamples },
      },
      null,
      2,
    ) + '\n',
  );
  return { verdict, samples, duneVerdict, duneSamples };
}

// -------------------------------------------------------------------------------------------
// plan

/**
 * @typedef {object} Plan
 * @property {boolean} ok
 * @property {string[]} refusals
 * @property {number | null} threshold
 * @property {{ threshold: number, deployers: number }[]} ladder
 * @property {{ wallet: string, launchesInMonth: number, launchesToWalk: number }[]} cohort
 *   `launchesInMonth` is 0 when no cohort export was supplied — the launch list alone does not say
 *   how prolific a deployer was in the seed month, and inventing the number would make the published
 *   threshold unauditable.
 * @property {number} launchesToWalk
 * @property {{ p50: number, p95: number, ceiling: number }} expectedRequests
 * @property {{ p50Hours: number, p95Hours: number }} expectedWallClock
 * @property {{ executions: number, estimatedCredits: number }} duneSpend
 * @property {string[]} caveats
 */

/**
 * Cost a run before it is spent. **Issues no request.**
 *
 * @param {object} input
 * @param {string | null} input.cohortText   The cohort query's export, or `null` when the launch
 *   list alone is being costed.
 * @param {string} input.launchListText
 * @param {number} input.nowMs
 * @returns {Plan}
 */
export function buildPlan({ cohortText, launchListText, nowMs }) {
  /** @type {string[]} */
  const refusals = [];
  /** @type {{ threshold: number, deployers: number }[]} */
  let ladder = [];
  /** @type {number | null} */
  let threshold = null;
  /** @type {Map<string, number> | null} */
  let cohortWallets = null;

  if (cohortText !== null) {
    const cohort = parseCohortRows(readDuneResultFile(cohortText, 'the cohort export'));
    const month = /** @type {string} */ (BOUNDS.seed.months[0]);
    const monthStartMs = Date.parse(`${month}-01T00:00:00Z`);
    const monthEndMs = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
    const coverage = assessCohortCoverage({ cohort, monthStartMs, monthEndMs });
    refusals.push(...coverage.reasons);
    const choice = chooseThreshold(cohort.deployers, {
      floor: BOUNDS.seed.minLaunchesInMonthFloor,
      maxCohort: BOUNDS.seed.maxCohort,
    });
    ladder = choice.ladder;
    threshold = choice.threshold;
    cohortWallets = new Map(choice.cohort.map((d) => [d.wallet, d.launchesInMonth]));
    if (choice.cohort.length < BOUNDS.seed.minCohort) {
      refusals.push(
        `the cohort is ${choice.cohort.length} deployer(s) at a threshold of ${threshold} launches in ` +
          `${month}, below the ${BOUNDS.seed.minCohort} this lane wants. Widen the seed month ` +
          `BACKWARDS — never forwards, because forward observation time is the scarcer resource — ` +
          `and re-execute. Do NOT lower the threshold to admit less prolific deployers without ` +
          `saying so: the threshold is published with the result.`,
      );
    }
  }

  const list = parseLaunchListRows(readDuneResultFile(launchListText, 'the launch-list export'));
  if (list.unreadableRows > 0) {
    refusals.push(
      `${list.unreadableRows} row(s) of the launch list could not be read. A row that fails to parse ` +
        `commonly has no readable deployer, so the wallet whose history came back short cannot be ` +
        `named and the whole list is refused rather than walked as far as it parsed.`,
    );
  }

  const seedStartMs = Date.parse(`${BOUNDS.seed.months[0]}-01T00:00:00Z`);
  /** @type {{ wallet: string, launchesInMonth: number, launchesToWalk: number }[]} */
  const cohort = [];
  let launchesToWalk = 0;
  for (const [wallet, launches] of list.byDeployer) {
    if (cohortWallets !== null && !cohortWallets.has(wallet)) continue;
    const launchesInMonth = cohortWallets?.get(wallet) ?? 0;
    const declared = list.declaredByDeployer.get(wallet) ?? null;
    if (declared === null) {
      refusals.push(
        `the launch list gave ${wallet} more than one value for its own creation total, so its rows ` +
          `cannot be reconciled with the history they claim to be.`,
      );
    } else if (declared > launches.length) {
      refusals.push(
        `the launch list declares ${declared} creation(s) for ${wallet} and returned ${launches.length}. ` +
          `A prefix read as a total is a launch history that is silently short; re-execute the ` +
          `enumeration for this wallet rather than walking what came back.`,
      );
    }
    // Forward from the seed month only. Anything older is outside the observation this lane defines,
    // and mixing it in would give the earliest-seeded deployers a longer series than the rest.
    const forward = launches.filter((l) => l.createdAtMs >= seedStartMs && l.createdAtMs <= nowMs);
    if (forward.length > BOUNDS.walk.maxLaunchesPerDeployer) {
      refusals.push(
        `${wallet} has ${forward.length} launches since the seed month, above the pinned ` +
          `${BOUNDS.walk.maxLaunchesPerDeployer}. It is refused from the plan rather than truncated: ` +
          `cutting a launch history selects on time — dropping either the window's open or its close — ` +
          `and a series missing one end silently answers a different question.`,
      );
      continue;
    }
    cohort.push({ wallet, launchesInMonth, launchesToWalk: forward.length });
    launchesToWalk += forward.length;
  }

  // A cohort deployer the launch list holds no row for is REFUSED, never read as "created nothing".
  // That is an absence of evidence, and reading it the other way drops a deployer from the sample
  // silently — which is the same invisible false rejection the creation-derived lane exists to
  // remove, arriving here as a hole in the denominator of an arrival rate.
  if (cohortWallets !== null) {
    for (const wallet of cohortWallets.keys()) {
      if (list.byDeployer.has(wallet)) continue;
      refusals.push(
        `${wallet} is in the cohort but the launch list returned no creation row for it at all. That ` +
          `is an absence of evidence rather than evidence of absence: dropping it would remove a ` +
          `deployer from the sample silently and shrink the arrival rate's denominator with nothing ` +
          `saying so. Re-execute the enumeration for the whole cohort rather than walking what came back.`,
      );
    }
  }

  // Per-launch page budgets measured on the committed tape's opening windows: p50 4, p95 13, max 24.
  // Requests rather than pages, because the endpoint sheds about a quarter of every request when
  // pushed and a page budget understates the true cost by roughly threefold.
  const expectedRequests = {
    p50: launchesToWalk * 4,
    p95: launchesToWalk * 13,
    ceiling: launchesToWalk * BOUNDS.walk.maxRequestsPerLaunch,
  };
  const hours = (/** @type {number} */ n) => (n * BOUNDS.walk.minIntervalMs) / 3_600_000;

  if (expectedRequests.p95 > BOUNDS.walk.maxRequestsPerRun) {
    refusals.push(
      `the p95 request estimate is ${expectedRequests.p95}, above the pinned run ceiling of ` +
        `${BOUNDS.walk.maxRequestsPerRun}. The collector checkpoints and resumes, so this is a ` +
        `statement about how many sittings the collection takes rather than a failure — but it is ` +
        `said before the first request rather than discovered at the ceiling.`,
    );
  }

  return {
    ok: refusals.length === 0,
    refusals,
    threshold,
    ladder,
    cohort,
    launchesToWalk,
    expectedRequests,
    expectedWallClock: { p50Hours: hours(expectedRequests.p50), p95Hours: hours(expectedRequests.p95) },
    // Stated in the plan because it is the lane's ONLY metered spend and it happens by hand, before
    // this tool is ever run. An execution is billed whether or not it succeeds and is never retried.
    duneSpend: { executions: BOUNDS.dune.expectedExecutions, estimatedCredits: 15 },
    caveats: [
      GROSS_OF_FEES_CAVEAT,
      ALL_ENTRANT_FLOOR_CAVEAT,
      'The cohort is seeded from ONE PAST MONTH with no filter on whether a deployer is still ' +
        'active. Every other seed this repo has selects on success, which biases arrival rate up, ' +
        'duration up and close rate down — on the exact quantity this lane measures.',
      'Discovery of the cohort is entirely Dune-derived, so a deployer whose creations neither ' +
        'decoded surface holds is invisible rather than absent.',
    ],
  };
}

// -------------------------------------------------------------------------------------------
// walk

/**
 * Walk every launch in the plan, checkpointing each one.
 *
 * @param {object} args
 * @param {string} args.out
 * @param {KeylessClient} args.client
 * @param {import('./cohort.mjs').LaunchList} args.list
 * @param {number} args.nowMs
 * @param {number | null} [args.limit]
 * @param {readonly string[]} [args.only]
 * @returns {Promise<{ walked: number, skipped: number, truncated: number }>}
 */
export async function runWalk({ out, client, list, nowMs, limit = null, only = [] }) {
  const windowDir = join(out, 'window');
  mkdirSync(windowDir, { recursive: true });
  const seedStartMs = Date.parse(`${BOUNDS.seed.months[0]}-01T00:00:00Z`);

  /** @type {import('./cohort.mjs').DuneLaunch[]} */
  let launches = [];
  for (const rows of list.byDeployer.values()) {
    for (const l of rows) if (l.createdAtMs >= seedStartMs && l.createdAtMs <= nowMs) launches.push(l);
  }
  launches.sort((a, b) => a.createdAtMs - b.createdAtMs);
  if (only.length > 0) launches = launches.filter((l) => only.includes(l.mint));
  const pending = launches.filter((l) => !existsSync(join(windowDir, `${l.mint}.meta.json`)));
  const todo = limit === null ? pending : pending.slice(0, limit);
  say(`walk: ${todo.length} launches to walk (${launches.length - pending.length} already on disk)`);

  let walked = 0;
  let truncated = 0;
  for (const [i, launch] of todo.entries()) {
    /** @type {import('./walk.mjs').WalkResult} */
    let result;
    try {
      result = await walkOpeningWindow({
        client,
        mint: launch.mint,
        mintMs: launch.createdAtMs,
        windowMs: BOUNDS.walk.windowMs,
        mintFloorSlackMs: BOUNDS.walk.mintFloorSlackMs,
        maxRequests: BOUNDS.walk.maxRequestsPerLaunch,
      });
    } catch (cause) {
      if (cause instanceof CeilingReached) {
        say(`walk: ${cause.message} — stopping with ${walked} walked this run`);
        return { walked, skipped: todo.length - walked, truncated };
      }
      throw cause;
    }
    if (result.truncated) truncated += 1;

    // Every fill inside the window, every wallet — captain decision 164c. The create-slot-only
    // series and the all-entrant series both come out of this one file.
    writeFileSync(
      join(windowDir, `${launch.mint}.jsonl.gz`),
      gzipSync(result.fills.map((f) => JSON.stringify(toTapeRow(f))).join('\n') + '\n'),
    );
    writeFileSync(
      join(windowDir, `${launch.mint}.meta.json`),
      JSON.stringify({
        mint: launch.mint,
        deployer: launch.deployer,
        created_timestamp: launch.createdAtMs,
        created_at_source: 'dune:chain_block_time',
        bonded: launch.bonded,
        window_ms: BOUNDS.walk.windowMs,
        mint_floor_slack_ms: BOUNDS.walk.mintFloorSlackMs,
        floor_ms: result.floorMs,
        end_ms: result.endMs,
        n: result.fills.length,
        pages: result.pages,
        requests: result.requests,
        reached_mint: result.reachedMint,
        truncated: result.truncated,
        max_requests: BOUNDS.walk.maxRequestsPerLaunch,
        from_ms: result.oldestFillMs,
        to_ms: result.newestFillMs,
        create_slot: result.createSlot,
        // Non-zero means the two clocks disagreed on THIS launch. The floor slack is what kept the
        // create slot; this is what makes the disagreement visible rather than merely survived.
        pre_mint_fills: result.preMintFills,
        stop_reason: result.stopReason,
      }) + '\n',
    );
    walked += 1;
    say(
      `[${i + 1}/${todo.length}] ${launch.mint} ${result.fills.length} fills ${result.pages}p ` +
        `reached_mint=${result.reachedMint} issued=${client.issued()} shed=${client.shed()} ` +
        `interval=${client.intervalMs()}ms`,
    );
  }
  say(`walk done: ${client.issued()} requests issued, ${client.shed()} shed, ${truncated} truncated`);
  return { walked, skipped: 0, truncated };
}

/**
 * Project a fill onto the committed tapes' row schema, so a window file written here concatenates
 * with one written by either existing collector.
 *
 * `tsMs` is dropped: it is `Date.parse(ts)`, and storing a derived field beside its source invites
 * the two to disagree.
 *
 * @param {import('./trades.mjs').Fill} f
 */
export function toTapeRow(f) {
  return { slot: f.slot, sid: f.sid, tx: f.tx, ts: f.ts, u: f.u, k: f.k, p: f.p, sol: f.sol, base: f.base, psol: f.psol, pusd: f.pusd };
}

// -------------------------------------------------------------------------------------------
// series

/**
 * Read one persisted window back.
 *
 * @param {string} windowDir
 * @param {string} mint
 * @returns {{ fills: import('./trades.mjs').Fill[], meta: Record<string, unknown> } | null}
 */
export function readPersistedWindow(windowDir, mint) {
  const metaPath = join(windowDir, `${mint}.meta.json`);
  const gz = join(windowDir, `${mint}.jsonl.gz`);
  if (!existsSync(metaPath) || !existsSync(gz)) return null;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  /** @type {import('./trades.mjs').Fill[]} */
  const fills = [];
  for (const line of gunzipSync(readFileSync(gz)).toString('utf8').split('\n')) {
    if (line === '') continue;
    const r = JSON.parse(line);
    fills.push({ ...r, tsMs: Date.parse(r.ts) });
  }
  return { fills, meta };
}

/**
 * The offline half: per-launch series, then windows per deployer, then the arrival summary.
 *
 * @param {object} args
 * @param {string} args.out
 * @returns {{ rows: import('./series.mjs').LaunchMeasurement[], perDeployer: import('./arrival.mjs').DeployerWindows[],
 *   summary: import('./arrival.mjs').ArrivalSummary }}
 */
export function runSeries({ out }) {
  const windowDir = join(out, 'window');
  if (!existsSync(windowDir)) throw new Error(`${windowDir} does not exist: run --phase walk first`);
  const mints = readdirSync(windowDir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => f.replace(/\.meta\.json$/, ''));

  /** @type {import('./series.mjs').LaunchMeasurement[]} */
  const rows = [];
  for (const mint of mints) {
    const w = readPersistedWindow(windowDir, mint);
    if (w === null) continue;
    rows.push(
      measureLaunch({
        mint,
        deployer: String(w.meta['deployer'] ?? ''),
        mintMs: Number(w.meta['created_timestamp']),
        fills: w.fills,
        reachedMint: w.meta['reached_mint'] === true,
      }),
    );
  }
  rows.sort((a, b) => a.mintMs - b.mintMs || (a.mint < b.mint ? -1 : 1));

  writeFileSync(
    join(out, 'series.csv'),
    [SERIES_COLUMNS.join(','), ...rows.map((r) => seriesRow(r).map(csvField).join(','))].join('\n') + '\n',
  );

  /** @type {Map<string, import('./arrival.mjs').SeriesPoint[]>} */
  const byDeployer = new Map();
  for (const r of rows) {
    if (!r.measured) continue;
    const list = byDeployer.get(r.deployer) ?? [];
    list.push({
      mint: r.mint,
      mintMs: r.mintMs,
      returnPerSol: Number.isFinite(r.createSlotReturnPerSolGrossOfFees) ? r.createSlotReturnPerSolGrossOfFees : 0,
      prizeSol: r.createSlotPrizeSolGrossOfFees,
    });
    byDeployer.set(r.deployer, list);
  }
  const perDeployer = [...byDeployer].map(([deployer, series]) =>
    findWindows(series, { deployer, minZ: BOUNDS.series.minZ, minSegment: BOUNDS.series.minSegment }),
  );
  const summary = summariseArrival(perDeployer);

  writeFileSync(
    join(out, 'arrival.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        bounds: { seed: BOUNDS.seed, walk: BOUNDS.walk, series: BOUNDS.series },
        launches: rows.length,
        launchesMeasured: rows.filter((r) => r.measured).length,
        perDeployer,
        summary,
        caveats: [GROSS_OF_FEES_CAVEAT, ALL_ENTRANT_FLOOR_CAVEAT, ...summary.caveats],
      },
      null,
      2,
    ) + '\n',
  );
  return { rows, perDeployer, summary };
}

/* c8 ignore start -- the CLI shell; every part it calls is exercised directly by the tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out === null ? null : args.out;
  if (out !== null) mkdirSync(out, { recursive: true });

  const main = async () => {
    if (args.phase === 'preflight') {
      const client = new KeylessClient({
        host: SOLANA_RPC,
        maxRequests: BOUNDS.preflight.maxRequests,
        minIntervalMs: BOUNDS.preflight.minIntervalMs,
        onRequest: ledger(/** @type {string} */ (out), 'preflight'),
      });
      const { verdict, duneVerdict } = await runPreflight({
        out: /** @type {string} */ (out),
        client,
        launchListPath: args.launchList,
      });
      say(`preflight leg A: ${JSON.stringify(verdict)}`);
      if (duneVerdict !== null) say(`preflight leg B: ${JSON.stringify(duneVerdict)}`);
      // A failing pre-flight is a hard stop. The collection it gates is days long and the failure it
      // looks for deletes create slots silently.
      process.exit(verdict.ok && (duneVerdict === null || duneVerdict.ok) ? 0 : 2);
    }

    if (args.phase === 'plan') {
      if (args.launchList === null) throw new Error('--launch-list is required to cost a run');
      const plan = buildPlan({
        cohortText: args.cohort === null ? null : readFileSync(args.cohort, 'utf8'),
        launchListText: readFileSync(args.launchList, 'utf8'),
        nowMs: Date.now(),
      });
      process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
      if (out !== null) writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
      process.exit(plan.ok ? 0 : 2);
    }

    if (args.phase === 'walk') {
      const listText = readFileSync(/** @type {string} */ (args.launchList), 'utf8');
      const plan = buildPlan({ cohortText: null, launchListText: listText, nowMs: Date.now() });
      say(
        `plan: ${plan.launchesToWalk} launches, p50 ~${plan.expectedRequests.p50} requests ` +
          `(~${plan.expectedWallClock.p50Hours.toFixed(1)} h), p95 ~${plan.expectedRequests.p95} ` +
          `(~${plan.expectedWallClock.p95Hours.toFixed(1)} h), ceiling ${plan.expectedRequests.ceiling}`,
      );
      for (const r of plan.refusals) say(`REFUSED: ${r}`);
      if (args.dryRun) {
        say('dry run: no request issued');
        process.exit(plan.ok ? 0 : 2);
      }
      if (!plan.ok) {
        say('the plan does not hold; nothing was requested');
        process.exit(2);
      }
      const client = new KeylessClient({
        host: SWAP_API,
        maxRequests: args.maxRequests,
        minIntervalMs: args.minIntervalMs,
        onRequest: ledger(/** @type {string} */ (out), 'walk'),
      });
      await runWalk({
        out: /** @type {string} */ (out),
        client,
        list: parseLaunchListRows(readDuneResultFile(listText, args.launchList ?? 'launch list')),
        nowMs: Date.now(),
        limit: args.limit,
        only: args.only,
      });
      process.exit(0);
    }

    const { rows, summary } = runSeries({ out: /** @type {string} */ (out) });
    say(`series: ${rows.length} launches, ${rows.filter((r) => r.measured).length} measured`);
    say(`arrival: ${JSON.stringify(summary)}`);
    process.exit(0);
  };

  main().catch((cause) => {
    say(`FAILED: ${cause instanceof Error ? cause.stack : String(cause)}`);
    process.exit(1);
  });
}
/* c8 ignore stop */
