#!/usr/bin/env node
/**
 * The collector CLI. Keyless throughout — **zero metered provider requests**, and the credential
 * allow-list for this directory is empty.
 *
 * `--out` is a directory in the data store rather than in this repository: dry dock phase C
 * untracked the measurement tapes for repository hygiene, and a multi-day collection written into
 * the tree grows back exactly what that removed. `~/slot-zero-data` is where the existing datasets
 * live (`config/data-root.mjs`), and this one has no committed home yet — it has never been run.
 *
 * ```
 * node tools/arrival-rate-walk/collect.mjs --phase preflight --out ~/slot-zero-data/arrival-rate-2026-08
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
import {
  LAUNCH_LIST_STALENESS_RULE,
  isLaunchListDocument,
  launchListHandoverDir,
  readLaunchListDocument,
  resolveLaunchListPath,
} from './launch-list.mjs';
import { selectPreflightLaunches, measureBlockTimeSkew, measureDuneClockSkew, assessSkew } from './preflight.mjs';
import { walkOpeningWindow } from './walk.mjs';
import {
  measureLaunch,
  seriesRow,
  toSeriesPoints,
  SERIES_COLUMNS,
  ALL_ENTRANT_FLOOR_CAVEAT,
  GROSS_OF_FEES_CAVEAT,
  ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT,
} from './series.mjs';
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
   *   launchListMaxAgeDays: number | null,
   *   limit: number | null, only: string[], minIntervalMs: number, maxRequests: number, dryRun: boolean }} */
  const args = {
    phase: '',
    out: null,
    cohort: null,
    launchList: null,
    // No default, on purpose. A launch list from the deployer screen states the instant its
    // observation stops, and nothing measured here says how fast that population goes stale — so
    // the bound is the run's to state and is recorded in the plan beside the result. A raw Dune
    // export carries no ceiling and needs none of this. See `launch-list.mjs`.
    launchListMaxAgeDays: null,
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
    else if (a === '--launch-list-max-age-days') {
      args.launchListMaxAgeDays = positiveNumber('--launch-list-max-age-days', next());
    }
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
  // STILL REQUIRED, and deliberately not defaulted to the handover directory captain decision 457a
  // adds. `--launch-list` names the POPULATION this run measures, and a walk that picked up
  // whichever list happened to be newest in the store would choose its own population silently —
  // which is the same failure as reading an absent list as an empty one, arriving from the other
  // side. The directory is printed by the screen and named in the README; the operator passes it,
  // and `--launch-list <dir>` then means "the newest list in here".
  if (args.phase === 'walk' && args.launchList === null) {
    throw new Error(
      `--launch-list is required for the walk: it is what says which launches exist. It takes a raw ` +
        `Dune export, a deployer-screen launch list, or a DIRECTORY of the latter — the handover ` +
        `directory is ${launchListHandoverDir()}.`,
    );
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
 * @param {string | null} [args.launchListPath] A RAW Dune export. Read here, unchanged.
 * @param {import('./cohort.mjs').LaunchList | null} [args.launchList] An already-parsed list, which
 *   is how a screen by-product reaches leg B: that shape carries a staleness ceiling and is read by
 *   `launch-list.mjs` rather than by `readDuneResultFile`, so it arrives parsed. Takes precedence.
 * @param {number} [args.sampleLaunches]
 * @returns {Promise<{ verdict: import('./preflight.mjs').SkewVerdict, samples: import('./preflight.mjs').SkewSample[],
 *   duneVerdict: import('./preflight.mjs').SkewVerdict | null, duneSamples: import('./preflight.mjs').SkewSample[] }>}
 */
export async function runPreflight({
  out,
  client,
  launchListPath = null,
  launchList = null,
  sampleLaunches = BOUNDS.preflight.sampleLaunches,
}) {
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
  const legBList =
    launchList ??
    (launchListPath === null
      ? null
      : parseLaunchListRows(readDuneResultFile(readFileSync(launchListPath, 'utf8'), launchListPath)));
  if (legBList !== null) {
    const list = legBList;
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
 * Read a launch-list export once, in the one shape every phase agrees on.
 *
 * Parsed once and shared, rather than re-parsed per caller: two readings of the same file that can
 * diverge is a plan that costs one run and a walk that walks another.
 *
 * @param {string} text
 * @param {string} label
 * @returns {import('./cohort.mjs').LaunchList}
 */
export function readLaunchList(text, label) {
  return parseLaunchListRows(readDuneResultFile(text, label));
}

/**
 * Read whatever the operator pointed `--launch-list` at: a raw Dune export, or the deployer screen's
 * launch-list by-product (captain decision 457a), or a DIRECTORY holding the latter.
 *
 * **The routing keys on the document's own marker, never on the file name or the flag**, because the
 * failure worth removing is a by-product read as a raw export: `readDuneResultFile` would find its
 * rows under a `rows` key if it had one, walk them, and report nothing whatever about the
 * observation ceiling they were collected under. The by-product deliberately keys its rows
 * elsewhere, so that route already refuses — this makes it route correctly instead.
 *
 * **A by-product needs `maxAgeDays` and there is no default.** See
 * {@link LAUNCH_LIST_STALENESS_RULE}: nothing measured here says how fast a screened deployer
 * population goes stale, so the bound is stated by the run and recorded in the plan rather than
 * invented once and inherited silently forever. A raw export carries no ceiling to check and is
 * unaffected.
 *
 * @param {string} target A file or a directory.
 * @param {object} opts
 * @param {number} opts.nowMs
 * @param {number | null} opts.maxAgeDays
 * @returns {{ list: import('./cohort.mjs').LaunchList,
 *   provenance: import('./launch-list.mjs').LaunchListProvenance | null }}
 */
export function readLaunchListInput(target, { nowMs, maxAgeDays }) {
  const resolved = resolveLaunchListPath(target);
  if (!resolved.ok) throw new Error(resolved.reason);
  const text = readFileSync(resolved.path, 'utf8');
  if (!isLaunchListDocument(text)) {
    return { list: readLaunchList(text, resolved.path), provenance: null };
  }
  if (maxAgeDays === null) {
    throw new Error(
      `${resolved.path} is a deployer-screen launch list, which states the instant its observation ` +
        `stops. Pass --launch-list-max-age-days to say how old a list this run will walk. ` +
        LAUNCH_LIST_STALENESS_RULE,
    );
  }
  const { rows, provenance } = readLaunchListDocument(text, {
    path: resolved.path,
    nowMs,
    maxAgeMs: maxAgeDays * 86_400_000,
  });
  return { list: parseLaunchListRows(rows), provenance };
}

/**
 * Hold a launch list's own refusals against a caller that has no plan to carry them.
 *
 * `buildPlan` adopts them into `plan.refusals`, which is how the plan and walk phases surface them.
 * The pre-flight has no plan: it reads the list only to check the two clocks against the committed
 * tape. Left unread, those refusals were collected and thrown away — so leg B could measure skew
 * against a list whose enumeration leg had FAILED, whose coverage probe REFUSED, or that is past the
 * `--launch-list-max-age-days` the run itself stated, and report `ok` from it.
 *
 * **It throws rather than returning a verdict**, because a failing pre-flight is already a hard stop:
 * the collection it gates runs for days and the failure it looks for deletes create slots silently,
 * so a soft reading there is a reading nobody acts on.
 *
 * @param {import('./launch-list.mjs').LaunchListProvenance | null} provenance
 * @returns {void}
 */
export function refuseUnusableLaunchList(provenance) {
  if (provenance === null || provenance.refusals.length === 0) return;
  throw new Error(
    `the launch list at ${provenance.path} cannot be used: ${provenance.refusals.join(' ')}`,
  );
}

/**
 * @typedef {object} Plan
 * @property {boolean} ok Cleared by a {@link Plan.refusals} entry only. An advisory never clears it.
 * @property {string[]} refusals Each one stops the run.
 * @property {string[]} advisories Stated before the first request and **fatal to nothing**: a
 *   collection this tool checkpoints and resumes is not failed by being large.
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
 * @property {import('./launch-list.mjs').LaunchListProvenance | null} launchListProvenance Where the
 *   list came from and how old it is, when it came from the deployer screen's by-product (captain
 *   decision 457a). `null` for a raw Dune export, which states no observation ceiling — that is an
 *   absence of the evidence, never a claim that the export is fresh.
 * @property {string[]} caveats
 */

/**
 * Cost a run before it is spent. **Issues no request.**
 *
 * @param {object} input
 * @param {string | null} input.cohortText   The cohort query's export, or `null` when the launch
 *   list alone is being costed.
 * @param {import('./cohort.mjs').LaunchList} input.launchList The already-parsed launch list — see
 *   {@link readLaunchList}.
 * @param {number} input.nowMs
 * @param {import('./launch-list.mjs').LaunchListProvenance | null} [input.launchListProvenance] The
 *   handover evidence when the list is the screen's by-product. Its own refusals are adopted whole —
 *   a stale list, a failed enumeration leg, a refused coverage probe — and a deployer the screen
 *   would not gate on refuses the plan **only when this run means to walk it**, because this
 *   document is one screen batch and a wallet outside this lane's cohort is somebody else's refusal.
 * @returns {Plan}
 */
export function buildPlan({ cohortText, launchList, nowMs, launchListProvenance = null }) {
  /** @type {string[]} */
  const refusals = [];
  /** @type {string[]} */
  const advisories = [];
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

  const list = launchList;
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

  // ---- THE HANDOVER'S OWN EVIDENCE (captain decision 457a). ---------------------------------
  // Adopted whole, and BEFORE the cost estimate, so a run that cannot use its list never reads a
  // request budget as though it were going to spend one. The screen's refusals are refusals about
  // the LIST — a stale ceiling, a failed enumeration leg, a coverage probe that would not vouch for
  // its surfaces — and none of them is a judgement about a deployer.
  if (launchListProvenance !== null) {
    refusals.push(...launchListProvenance.refusals);
    advisories.push(...launchListProvenance.advisories);
    // A wallet the screen would not gate on refuses this plan only where this plan MEANS TO WALK
    // IT. The document is one screen batch and this lane's cohort is chosen elsewhere, so refusing
    // on a wallet nobody here asked for would make an unrelated run's coverage gap this run's.
    const walked = new Set(cohort.map((c) => c.wallet));
    for (const { wallet, reasons } of launchListProvenance.unusableDeployers) {
      if (!walked.has(wallet)) continue;
      refusals.push(
        `${wallet} is in this run's cohort, and the deployer screen would not gate on the launch ` +
          `history it read for that wallet: ${reasons.join(' ')} The rows are in the list; what is ` +
          `missing is any claim that they are whole, so walking them would measure an arrival rate ` +
          `over a history nobody vouched for. Re-run the screen over this wallet.`,
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

  // ADVISORY, not a refusal. The collector checkpoints every launch and resumes, so a cohort larger
  // than one sitting is the shape this lane was designed for — the README's own headline scenario is
  // ~2,100 launches, which is a p95 well past this ceiling. Refusing it would make the lane's target
  // population unwalkable while the real bound — the client's own per-run ceiling — already stops a
  // run exactly and leaves it resumable.
  if (expectedRequests.p95 > BOUNDS.walk.maxRequestsPerRun) {
    advisories.push(
      `the p95 request estimate is ${expectedRequests.p95}, above the pinned run ceiling of ` +
        `${BOUNDS.walk.maxRequestsPerRun}. The collector checkpoints and resumes, so this is a ` +
        `statement about how many sittings the collection takes rather than a failure — but it is ` +
        `said before the first request rather than discovered at the ceiling. Expect at least ` +
        `${Math.ceil(expectedRequests.p95 / BOUNDS.walk.maxRequestsPerRun)} sittings.`,
    );
  }

  return {
    ok: refusals.length === 0,
    refusals,
    advisories,
    threshold,
    ladder,
    cohort,
    launchListProvenance,
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
 * Whether a launch already on disk is DONE, as opposed to merely attempted.
 *
 * **Only a PROVED walk is done.** A walk that ended truncated, or on a transport failure the client
 * had already retried out, wrote a sidecar saying `reached_mint: false` — and a resume that skipped
 * on the sidecar's existence would make one transient failure a permanent unmeasured launch. The
 * loss is not random either: a busy launch issues more requests, so it is likelier to be shed or cut
 * short, and busy launches are the high-prize tail the 40-request per-launch budget exists to keep.
 *
 * The failed attempt's own evidence — `stop_reason`, `requests`, `pages`, `attempts` — stays on disk
 * and is carried forward into the next attempt's sidecar, because a run that leaves no record of
 * what it spent is the thing `requests.csv` exists to prevent.
 *
 * **But the retry is BOUNDED, because "retry until proved" is not a bound at all.** A launch that can
 * never be proved — a mint the endpoint 404s, or one whose pages never say nothing is older — would
 * otherwise re-spend a whole per-launch budget on every sitting of a days-long collection, ahead of
 * launches never attempted. At `BOUNDS.walk.maxWalkAttemptsPerLaunch` recorded attempts it is done,
 * and its sidecar's `given_up_reason` says we stopped trying rather than that we never tried. What
 * the launch MEANS is unchanged: still unproved at series time is UNMEASURED, and never a zero.
 *
 * An unreadable sidecar is NOT done: it cannot vouch for the walk it describes, so the launch is
 * re-attempted rather than counted on a file nothing can read.
 *
 * @param {string} windowDir
 * @param {string} mint
 * @returns {{ done: boolean, gaveUp: boolean, attempts: number, previous: Record<string, unknown> | null }}
 */
export function checkpointState(windowDir, mint) {
  const metaPath = join(windowDir, `${mint}.meta.json`);
  if (!existsSync(metaPath)) return { done: false, gaveUp: false, attempts: 0, previous: null };
  /** @type {Record<string, unknown>} */
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return { done: false, gaveUp: false, attempts: 0, previous: null };
  }
  const attempts = typeof meta['attempts'] === 'number' ? meta['attempts'] : 0;
  if (meta['reached_mint'] === true) return { done: true, gaveUp: false, attempts, previous: meta };
  const gaveUp = attempts >= BOUNDS.walk.maxWalkAttemptsPerLaunch;
  return { done: gaveUp, gaveUp, attempts, previous: meta };
}

/**
 * The sentence a sidecar carries when the collector stopped spending on a launch.
 *
 * @param {number} attempts
 * @returns {string}
 */
export function givenUpReason(attempts) {
  return (
    `${attempts} whole sitting(s) failed to prove this walk reached the create slot, which is the ` +
    `pinned cap of ${BOUNDS.walk.maxWalkAttemptsPerLaunch}, so the collector stopped spending on it. ` +
    `That is "we stopped trying", not "we never tried" and not "there was nothing here": the launch ` +
    `is still UNMEASURED at series time and is never read as a zero. Its attempts are on disk in ` +
    `previous_attempts and every request they cost is in requests.csv.`
  );
}

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
  /** @type {Map<string, Record<string, unknown> | null>} */
  const previousAttempts = new Map();
  /** @type {import('./cohort.mjs').DuneLaunch[]} */
  const pending = [];
  let retrying = 0;
  let gaveUp = 0;
  for (const l of launches) {
    const state = checkpointState(windowDir, l.mint);
    if (state.gaveUp) gaveUp += 1;
    if (state.done) continue;
    if (state.previous !== null) retrying += 1;
    previousAttempts.set(l.mint, state.previous);
    pending.push(l);
  }
  const todo = limit === null ? pending : pending.slice(0, limit);
  say(
    `walk: ${todo.length} launches to walk ` +
      `(${launches.length - pending.length - gaveUp} proved and on disk, ` +
      `${retrying} unproved attempt(s) being retried, ` +
      `${gaveUp} given up on at the ${BOUNDS.walk.maxWalkAttemptsPerLaunch}-attempt cap)`,
  );

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
    const previous = previousAttempts.get(launch.mint) ?? null;
    const attempts = (typeof previous?.['attempts'] === 'number' ? previous['attempts'] : 0) + 1;
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
        // An UNPROVED walk is retried on the next sitting, so what the failed attempts spent has to
        // survive the retry rather than be overwritten by the one that finally worked — and the
        // retry is capped, so a launch that can never be proved stops taxing every future sitting.
        attempts,
        given_up_reason:
          result.reachedMint || attempts < BOUNDS.walk.maxWalkAttemptsPerLaunch ? null : givenUpReason(attempts),
        previous_attempts:
          previous === null
            ? []
            : [
                ...(Array.isArray(previous['previous_attempts']) ? previous['previous_attempts'] : []),
                {
                  n: previous['n'],
                  pages: previous['pages'],
                  requests: previous['requests'],
                  reached_mint: previous['reached_mint'],
                  truncated: previous['truncated'],
                  stop_reason: previous['stop_reason'],
                },
              ],
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
 * **An unreadable checkpoint is a named refusal, never a throw.** A walk killed mid-write leaves a
 * truncated last line, and letting that abort the whole offline `series` phase would lose every
 * other launch's measurement to one launch's interrupted write. It is reported as unreadable and
 * counted, which is how every other unreadable input in this lane is treated — and the launch is
 * then UNMEASURED, which is not a zero.
 *
 * @param {string} windowDir
 * @param {string} mint
 * @returns {{ fills: import('./trades.mjs').Fill[], meta: Record<string, unknown>, unreadable: string | null } | null}
 */
export function readPersistedWindow(windowDir, mint) {
  const metaPath = join(windowDir, `${mint}.meta.json`);
  const gz = join(windowDir, `${mint}.jsonl.gz`);
  if (!existsSync(metaPath) || !existsSync(gz)) return null;
  /** @type {Record<string, unknown>} */
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (cause) {
    return { fills: [], meta: {}, unreadable: `its sidecar could not be parsed: ${errorText(cause)}` };
  }
  /** @type {import('./trades.mjs').Fill[]} */
  const fills = [];
  /** @type {string} */
  let text;
  try {
    text = gunzipSync(readFileSync(gz)).toString('utf8');
  } catch (cause) {
    return { fills, meta, unreadable: `its fill file could not be decompressed: ${errorText(cause)}` };
  }
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line === '') continue;
    /** @type {any} */
    let r;
    try {
      r = JSON.parse(line);
    } catch (cause) {
      return {
        fills,
        meta,
        unreadable:
          `line ${i + 1} of ${lines.length} in its fill file could not be parsed (${errorText(cause)}), ` +
          `which is what a walk killed mid-write leaves. The launch is UNMEASURED rather than measured ` +
          `on the ${fills.length} fill(s) that did parse: a window read short is a biased sample, not a ` +
          `small one. Re-walk it.`,
      };
    }
    fills.push({ ...r, tsMs: Date.parse(r.ts) });
  }
  return { fills, meta, unreadable: null };
}

/** @param {unknown} cause */
function errorText(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The offline half: per-launch series, then windows per deployer, then the arrival summary.
 *
 * @param {object} args
 * @param {string} args.out
 * @returns {{ rows: import('./series.mjs').LaunchMeasurement[], perDeployer: import('./arrival.mjs').DeployerWindows[],
 *   summary: import('./arrival.mjs').ArrivalSummary, unreadable: { mint: string, reason: string }[],
 *   givenUp: { mint: string, attempts: number, reason: string }[],
 *   rankInput: import('./series.mjs').RankInput }}
 */
export function runSeries({ out }) {
  const windowDir = join(out, 'window');
  if (!existsSync(windowDir)) throw new Error(`${windowDir} does not exist: run --phase walk first`);
  const mints = readdirSync(windowDir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => f.replace(/\.meta\.json$/, ''));

  /** @type {import('./series.mjs').LaunchMeasurement[]} */
  const rows = [];
  /** @type {{ mint: string, reason: string }[]} */
  const unreadable = [];
  /** @type {{ mint: string, attempts: number, reason: string }[]} */
  const givenUp = [];
  for (const mint of mints) {
    const w = readPersistedWindow(windowDir, mint);
    if (w === null) continue;
    if (w.unreadable !== null) {
      unreadable.push({ mint, reason: w.unreadable });
      say(`series: ${mint} is UNREADABLE and is unmeasured — ${w.unreadable}`);
    }
    if (typeof w.meta['given_up_reason'] === 'string') {
      givenUp.push({
        mint,
        attempts: typeof w.meta['attempts'] === 'number' ? w.meta['attempts'] : 0,
        reason: w.meta['given_up_reason'],
      });
    }
    rows.push(
      measureLaunch({
        mint,
        deployer: String(w.meta['deployer'] ?? ''),
        mintMs: Number(w.meta['created_timestamp']),
        fills: w.fills,
        // An unreadable checkpoint proves nothing about its own coverage, whatever its sidecar
        // claims: the fills that back that claim are the ones that would not parse.
        reachedMint: w.unreadable === null && w.meta['reached_mint'] === true,
      }),
    );
  }
  rows.sort((a, b) => a.mintMs - b.mintMs || (a.mint < b.mint ? -1 : 1));

  writeFileSync(
    join(out, 'series.csv'),
    [SERIES_COLUMNS.join(','), ...rows.map((r) => seriesRow(r).map(csvField).join(','))].join('\n') + '\n',
  );

  // The rank test's input, and the exclusions are made HERE rather than imputed: a measured launch
  // with no closed create-slot outsider round trip has no return per SOL and never enters the
  // segmentation as a 0. `series.csv` above already carries every one of those launches as a row.
  const rankInput = toSeriesPoints(rows);
  const perDeployer = [...rankInput.byDeployer].map(([deployer, series]) =>
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
        // What actually reached the rank test, and every launch that did not, counted by reason.
        // `launchesMeasured` is the segmentation's own denominator: a launch excluded below is in
        // NEITHER it nor any deployer's observation span.
        launchesMeasured: rankInput.launchesInRankTest,
        launchesUnmeasured: rankInput.launchesUnmeasured,
        launchesExcludedNoClosedCreateSlotPair: rankInput.launchesNoClosedCreateSlotPair,
        launchesUnreadable: unreadable,
        // Giving up on a launch is a spending decision and it is REPORTED, never silent — a reader
        // must be able to tell "we stopped trying" from "we never tried".
        launchesGivenUpAtAttemptCap: givenUp,
        perDeployer,
        summary,
        caveats: [
          GROSS_OF_FEES_CAVEAT,
          ALL_ENTRANT_FLOOR_CAVEAT,
          `${rankInput.launchesNoClosedCreateSlotPair} measured launch(es) were excluded here. ` +
            ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT,
          ...summary.caveats,
        ],
      },
      null,
      2,
    ) + '\n',
  );
  return { rows, perDeployer, summary, unreadable, givenUp, rankInput };
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
      // Leg B reads whatever `--launch-list` points at, by-product or raw export, through the ONE
      // reader that knows the difference — and is held to the SAME refusals the walk is, not merely
      // to the hard throws. `refuseUnusableLaunchList` is the enforcement the plan and walk phases
      // get from `buildPlan`; this phase has no plan to carry them, so it refuses here.
      /** @type {import('./cohort.mjs').LaunchList | null} */
      let preflightList = null;
      if (args.launchList !== null) {
        const input = readLaunchListInput(args.launchList, {
          nowMs: Date.now(),
          maxAgeDays: args.launchListMaxAgeDays,
        });
        refuseUnusableLaunchList(input.provenance);
        preflightList = input.list;
      }
      const { verdict, duneVerdict } = await runPreflight({
        out: /** @type {string} */ (out),
        client,
        launchList: preflightList,
      });
      say(`preflight leg A: ${JSON.stringify(verdict)}`);
      if (duneVerdict !== null) say(`preflight leg B: ${JSON.stringify(duneVerdict)}`);
      // A failing pre-flight is a hard stop. The collection it gates is days long and the failure it
      // looks for deletes create slots silently.
      process.exit(verdict.ok && (duneVerdict === null || duneVerdict.ok) ? 0 : 2);
    }

    if (args.phase === 'plan') {
      if (args.launchList === null) throw new Error('--launch-list is required to cost a run');
      const nowMs = Date.now();
      const input = readLaunchListInput(args.launchList, {
        nowMs,
        maxAgeDays: args.launchListMaxAgeDays,
      });
      const plan = buildPlan({
        cohortText: args.cohort === null ? null : readFileSync(args.cohort, 'utf8'),
        launchList: input.list,
        nowMs,
        launchListProvenance: input.provenance,
      });
      process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
      if (out !== null) writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
      process.exit(plan.ok ? 0 : 2);
    }

    if (args.phase === 'walk') {
      // Parsed ONCE and shared with the walk below: two readings of the same file that can diverge
      // is a plan costing one run and a walk walking another.
      const nowMs = Date.now();
      const input = readLaunchListInput(/** @type {string} */ (args.launchList), {
        nowMs,
        maxAgeDays: args.launchListMaxAgeDays,
      });
      const list = input.list;
      const plan = buildPlan({
        cohortText: null,
        launchList: list,
        nowMs,
        launchListProvenance: input.provenance,
      });
      if (input.provenance !== null) {
        say(
          `launch list: ${input.provenance.path}, generated ${input.provenance.generatedAtIso} ` +
            `(${input.provenance.ageDays.toFixed(2)} days old against the ` +
            `${input.provenance.maxAgeDays.toFixed(2)} this run stated), ` +
            `${input.provenance.walletsUsable}/${input.provenance.walletsAsked} deployers usable`,
        );
      }
      say(
        `plan: ${plan.launchesToWalk} launches, p50 ~${plan.expectedRequests.p50} requests ` +
          `(~${plan.expectedWallClock.p50Hours.toFixed(1)} h), p95 ~${plan.expectedRequests.p95} ` +
          `(~${plan.expectedWallClock.p95Hours.toFixed(1)} h), ceiling ${plan.expectedRequests.ceiling}`,
      );
      for (const r of plan.refusals) say(`REFUSED: ${r}`);
      // Advisories are printed exactly as loudly and stop nothing: the run's real bound is the
      // client's own per-run ceiling, which stops a sitting and leaves it resumable.
      for (const a of plan.advisories) say(`ADVISORY: ${a}`);
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
        list,
        nowMs: Date.now(),
        limit: args.limit,
        only: args.only,
      });
      process.exit(0);
    }

    const { rows, summary, rankInput, unreadable, givenUp } = runSeries({ out: /** @type {string} */ (out) });
    say(
      `series: ${rows.length} launches, ${rankInput.launchesInRankTest} in the rank test, ` +
        `${rankInput.launchesUnmeasured} unmeasured, ${rankInput.launchesNoClosedCreateSlotPair} ` +
        `measured with no closed create-slot round trip (excluded, NOT read as zero), ` +
        `${unreadable.length} unreadable, ${givenUp.length} given up on at the attempt cap`,
    );
    say(`arrival: ${JSON.stringify(summary)}`);
    process.exit(0);
  };

  main().catch((cause) => {
    say(`FAILED: ${cause instanceof Error ? cause.stack : String(cause)}`);
    process.exit(1);
  });
}
/* c8 ignore stop */
