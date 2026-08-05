#!/usr/bin/env node
/**
 * deployer-screen grade — the screen scoring its own predictions. **No agent required:**
 * `node tools/deployer-screen/grade.mjs`.
 *
 * This is the second half of the captain's loop — *"we do the same research in a repeatable way …
 * then loop the process continuous getting better"*. `screen.mjs` records what each run predicted
 * (`prediction.mjs`, record schema 16); this reads those claims back, measures what the wallets
 * actually did afterwards, and reports the screen's own hit rate.
 *
 * ## The default costs nothing, and that is deliberate
 *
 * A plain `node grade.mjs` is a **DRY RUN**: it reads the committed run records and the grade
 * ledger, prints the hit rate so far, prints exactly what a live run would fetch, and opens no
 * socket. `--live` is required to spend anything. So the report — the thing a captain reruns to see
 * whether the screen is getting better — is free, and only *measuring a new outcome* costs.
 *
 * ## Every provider call is bounded, and the plan is refused BEFORE the first request
 *
 * | leg | ceiling | value at the pins |
 * |---|---|---|
 * | keyed MadeOnSol profile | `thresholds.json` → `feedback_loop.maxKeyedRequests` | 6 |
 * | keyless swap-api fills | `feedback_loop.maxKeylessRequests` | 540 |
 * | Solana RPC entry cost | `feedback_loop.maxRpcRequests` | 1,500 |
 * | claims measured per run | `feedback_loop.maxClaimsPerRun` | 3 |
 *
 * The plan is priced from each claim's **own recorded recipe** — a claim is graded at the
 * `stage2_entry` / `stage2_cost` bars the predicting run applied, never at today's — and if the sum
 * does not fit, the run **refuses whole and spends nothing**. It is never scaled down to fit: a
 * Stage 2 walk truncated mid-launch holds the earliest entrants by slot, which is a biased sample
 * rather than a short one, and grading the screen on a sample it would never have scored is worse
 * than not grading it.
 *
 * ## What it will not do
 *
 * It re-tunes nothing. No bar in `thresholds.json` moves, no verdict is recomputed, and `screen.mjs`
 * is untouched by whatever this finds — a lane that adjusted the screen it grades could not be read
 * as evidence about the screen. It also makes and grades **no exit claim**: Stage 3 is deferred by
 * captain decision 237a, and room to enter is not room to leave.
 *
 * Exit codes follow `screen.mjs`, so an operator reads one table:
 *
 *   0  ran to completion — including a run with nothing ripe to grade, which is a measured state.
 *   2  usage error, or a plan that does not fit the pinned ceilings. Nothing was spent.
 *   3  credential missing or malformed (--live only).
 *   4  credential rejected (401/403).
 *   5  quota exhausted or rate-limited (429).
 *   6  a request ceiling was reached before the run completed.
 *   7  upstream or transport failure.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BoundedClient, CeilingReached, VendorRefused } from './client.mjs';
import { KEY_ENV_VAR, resolveKey } from './credential.mjs';
import { readRunRecords } from './ledger.mjs';
import {
  dueForMeasurement,
  emptyGradeLedger,
  GRADE_LEDGER_VERSION,
  gradeKeyOf,
  gradeOne,
  mergeGrades,
  summariseGrades,
  UNGRADED_REASONS,
} from './outcome.mjs';
import { extractPredictions } from './prediction.mjs';
import { KeylessClient, SolanaRpcClient } from './pumpfun.mjs';
import { toLaunchRefs } from './measure.mjs';
import { exitForRefusal, loadThresholds } from './screen.mjs';
import { scoreLaunchRefsEntry } from './stage2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNS_DIR = join(HERE, 'runs');
const DEFAULT_LEDGER = join(HERE, 'feedback', 'grades.json');
const MS_PER_DAY = 86_400_000;

const EXIT = { ok: 0, usage: 2, credentialMissing: 3, credentialRejected: 4, quota: 5, ceiling: 6, upstream: 7 };

const USAGE = `deployer-screen grade — score the screen's own predictions, out of sample

  node tools/deployer-screen/grade.mjs [options]

WHAT IT DOES
  Reads the prediction each committed run record carries (record schema 16+), finds the claims old
  enough to have an outcome, re-measures STAGE 2 over launches those wallets created AFTER the
  claim was made, and reports how often the screen was right.

  A DRY RUN BY DEFAULT. Without --live it opens no socket, writes nothing, and still prints the
  hit rate from the ledger plus the exact plan a live run would spend. --live is the only way to
  reach a provider.

OPTIONS
  --live              Measure outcomes and write the ledger. Everything else is a dry run.
  --runs <dir>        Committed run records to read claims from. Default: tools/deployer-screen/runs
  --ledger <path>     The grade ledger. Default: tools/deployer-screen/feedback/grades.json
  --claims <n>        Measure at most n outcomes this run. Can only LOWER the pinned cap.
  --json              Print the report as JSON instead of text.
  --help              This text.

BOUNDS (thresholds.json -> feedback_loop; the plan is refused before the first request)
  claims per run, keyed requests, keyless requests and Solana RPC requests all have their own
  ceiling, and the plan is priced from each claim's OWN recorded recipe rather than from today's
  thresholds. A plan that does not fit is refused whole — never truncated to fit, because a
  truncated Stage 2 walk holds the earliest entrants by slot and that is a biased sample.

CREDENTIAL (--live only)
  Reads ${KEY_ENV_VAR} from the environment for ONE profile request per claim measured. Nothing
  else here is keyed: the fills and the entry cost come from pump.fun's free tape and Solana's
  public RPC, exactly as Stage 2 does.

EXIT CODES
  0 ok (including "nothing ripe to grade", which is a measured state)   2 usage or over budget
  3 no credential   4 credential rejected   5 quota   6 ceiling reached   7 upstream
`;

/**
 * @typedef {object} Options
 * @property {boolean} help
 * @property {boolean} live
 * @property {string} runsDir
 * @property {string} ledgerPath
 * @property {number | null} claims
 * @property {boolean} json
 */

/**
 * @param {readonly string[]} argv
 * @returns {{ ok: true, opts: Options } | { ok: false, message: string }}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const opts = {
    help: false,
    // OFF by default. The report is the thing rerun most often and it must be free; a tool that
    // reached a provider on a bare invocation would make "check the hit rate" a spending decision.
    live: false,
    runsDir: DEFAULT_RUNS_DIR,
    ledgerPath: DEFAULT_LEDGER,
    claims: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    /** @returns {string | null} */
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return null;
      i += 1;
      return v;
    };
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--live':
        opts.live = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--runs': {
        const v = next();
        if (v === null) return { ok: false, message: '--runs needs a path' };
        opts.runsDir = v;
        break;
      }
      case '--ledger': {
        const v = next();
        if (v === null) return { ok: false, message: '--ledger needs a path' };
        opts.ledgerPath = v;
        break;
      }
      case '--claims': {
        const v = next();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isInteger(n) || n < 1) return { ok: false, message: '--claims needs a positive integer' };
        opts.claims = n;
        break;
      }
      default:
        return { ok: false, message: `unknown option '${String(arg)}'` };
    }
  }
  return { ok: true, opts };
}

/**
 * Every field of the predicting run's recipe this build has to be able to apply, and it is checked
 * rather than defaulted.
 *
 * **Defaulting a missing bar would be the substitution this lane exists to avoid**: a claim graded
 * at today's `minRoomLeft` when it was made under a different one is not graded, and the difference
 * would be invisible in the ledger. A record missing any of these leaves its claims `recipe-unusable`
 * — ungraded, counted, and named — which is the honest outcome for a record that cannot say what it
 * was judging by.
 */
export const REQUIRED_ENTRY_RECIPE = Object.freeze([
  'minRoomLeft',
  'minLaunchesSampled',
  'minFieldRoundTrips',
  'minFieldHitRateGross',
  'minFieldHitRateNet',
  'maxEntryCostPerSolStaked',
  'minPricedFraction',
  'maxLaunchesPerCandidate',
  'maxRequestsPerLaunch',
  'maxKeylessRequests',
  'tradePageLimit',
  'windowMs',
  'seekMarginMs',
  'windowSlotSpan',
]);

/** @type {readonly string[]} */
export const REQUIRED_COST_RECIPE = Object.freeze(['maxRpcRequestsPerCandidate', 'rpcMinIntervalMs']);

/**
 * Entry-recipe keys that are SCHEDULES rather than numbers, checked for their own shape.
 *
 * `keylessRetryBackoffMs` is as load-bearing as any bar above it and is not a bar: its LENGTH is
 * what `pumpfun.mjs` → `attemptsPerRequest` reserves against `maxRequestsPerLaunch`, so a claim
 * graded under a different schedule walks a different number of pages per launch and can drop a
 * launch the predicting screen kept. It is an array, so {@link REQUIRED_ENTRY_RECIPE}'s
 * typeof-number test would pass it silently — hence its own list rather than a widened check there.
 *
 * @type {readonly string[]}
 */
export const REQUIRED_ENTRY_RECIPE_SCHEDULES = Object.freeze(['keylessRetryBackoffMs']);

/** @param {unknown} value @returns {boolean} */
function isBackoffSchedule(value) {
  return Array.isArray(value) && value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

/**
 * Price one claim's outcome measurement from the recipe THAT CLAIM was made under.
 *
 * The whole point of returning `usable: false` with a reason rather than falling back: an outcome
 * measured at bars the prediction never saw grades a different screen.
 *
 * @param {import('./prediction.mjs').ExtractedPrediction} p
 * @param {number} keylessMinIntervalFloorMs
 * @returns {{ usable: true, keyless: number, rpc: number, keyed: number, keylessMinIntervalMs: number,
 *   keylessRetryBackoffMs: readonly number[], entry: Record<string, any>, cost: Record<string, any> }
 *   | { usable: false, reason: string }}
 */
export function priceClaim(p, keylessMinIntervalFloorMs) {
  const entry = /** @type {Record<string, any>} */ (p.stage2Entry ?? {});
  const cost = /** @type {Record<string, any>} */ (p.stage2Cost ?? {});
  const missing = [
    ...REQUIRED_ENTRY_RECIPE.filter((k) => typeof entry[k] !== 'number'),
    ...REQUIRED_ENTRY_RECIPE_SCHEDULES.filter((k) => !isBackoffSchedule(entry[k])),
    ...REQUIRED_COST_RECIPE.filter((k) => typeof cost[k] !== 'number'),
  ];
  if (missing.length > 0) {
    return {
      usable: false,
      reason:
        `the predicting run's recorded recipe is missing ${missing.join(', ')}, so its claim cannot ` +
        `be measured at the bars it was made under. Today's values are NOT substituted — that would ` +
        `grade the claim against a screen it never was.`,
    };
  }
  return {
    usable: true,
    // The walk's exact worst case, the same arithmetic Stage 2 declares: a launch is only started
    // when a whole per-launch cap of headroom remains, so this is a bound rather than an estimate.
    keyless: entry['maxLaunchesPerCandidate'] * entry['maxRequestsPerLaunch'],
    rpc: cost['maxRpcRequestsPerCandidate'],
    // One profile, and the keyed client retries a failed request once against the same ceiling.
    keyed: 2,
    // Never faster than either pin. A record written under a faster pacing pin cannot make this lane
    // outrun a host that sheds a quarter of what it is asked for.
    keylessMinIntervalMs: Math.max(keylessMinIntervalFloorMs, entry['keylessMinIntervalMs'] ?? 0),
    // Applied as recorded, never widened or shortened: unlike the pacing floor this is not a
    // courtesy to the host but part of the walk's own arithmetic, and changing it grades the claim
    // on a different sample of launches.
    keylessRetryBackoffMs: /** @type {readonly number[]} */ (entry['keylessRetryBackoffMs']),
    entry,
    cost,
  };
}

/**
 * Decide whether the whole plan fits, before anything is spent.
 *
 * @param {readonly ReturnType<typeof priceClaim>[]} priced
 * @param {{ maxKeyedRequests: number, maxKeylessRequests: number, maxRpcRequests: number }} bounds
 * @returns {{ fits: boolean, keyed: number, keyless: number, rpc: number, reasons: string[] }}
 */
export function planFits(priced, bounds) {
  let keyed = 0;
  let keyless = 0;
  let rpc = 0;
  for (const item of priced) {
    if (!item.usable) continue;
    keyed += item.keyed;
    keyless += item.keyless;
    rpc += item.rpc;
  }
  /** @type {string[]} */
  const reasons = [];
  if (keyed > bounds.maxKeyedRequests) {
    reasons.push(`keyed worst case ${keyed} exceeds feedback_loop.maxKeyedRequests ${bounds.maxKeyedRequests}`);
  }
  if (keyless > bounds.maxKeylessRequests) {
    reasons.push(
      `keyless worst case ${keyless} exceeds feedback_loop.maxKeylessRequests ${bounds.maxKeylessRequests}`,
    );
  }
  if (rpc > bounds.maxRpcRequests) {
    reasons.push(`Solana RPC worst case ${rpc} exceeds feedback_loop.maxRpcRequests ${bounds.maxRpcRequests}`);
  }
  return { fits: reasons.length === 0, keyed, keyless, rpc, reasons };
}

/**
 * Measure one claim's outcome: what this deployer's POST-PREDICTION launches actually did.
 *
 * The out-of-sample filter is the one line that makes the whole lane worth anything, and it is a
 * strict `>` against the claim's own boundary — `prediction.mjs` owns why that boundary is a proof
 * rather than a convention. Everything after it is Stage 2 verbatim, through
 * `stage2.mjs` → `scoreLaunchRefsEntry`, so the outcome comes from the same instrument as the claim.
 *
 * @param {object} clients
 * @param {BoundedClient} clients.keyed
 * @param {(retryBackoffMs: readonly number[]) => KeylessClient} clients.keylessFor
 *   The fill walk's client for THIS claim's recorded retry schedule. The schedule is part of the
 *   walk's arithmetic — its length is what each request reserves against `maxRequestsPerLaunch` —
 *   so a claim measured under a different one is measured over a different sample of launches.
 * @param {(rpcCeiling: number, minIntervalMs: number) => SolanaRpcClient | null} clients.rpcFor
 *   `null` when the run-level RPC ceiling is already spent. The cost leg is then disabled and the
 *   verdict cannot be better than `entry-cost-unmeasured`, so the claim goes ungraded — which is the
 *   intended consequence rather than a degradation, and is why the ceiling never needs to be
 *   exceeded to finish a candidate.
 * @param {import('./prediction.mjs').ExtractedPrediction} p
 * @param {Extract<ReturnType<typeof priceClaim>, { usable: true }>} recipe
 * @param {number} nowMs
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ outcome: import('./outcome.mjs').OutcomeMeasurement | null,
 *   refusal: { reason: import('./outcome.mjs').UngradedReason, detail: string } | null }>}
 */
export async function measureOutcome(clients, p, recipe, nowMs, log) {
  /** @type {unknown} */
  let profile;
  try {
    profile = await clients.keyed.getJson(`/deployer-hunter/${encodeURIComponent(p.wallet)}`);
  } catch (cause) {
    // A refusal that is terminal for the RUN — a rejected key, an exhausted quota — must reach the
    // caller so the run stops with the right exit code rather than recording it as a fact about this
    // one wallet. Everything else degrades to an ungraded row, the same way Stage 2's cost leg
    // abandons one candidate on a transport failure without throwing the run away.
    if (cause instanceof VendorRefused || cause instanceof CeilingReached) throw cause;
    return {
      outcome: null,
      refusal: {
        reason: 'profile-unreadable',
        detail: `${UNGRADED_REASONS['profile-unreadable']} (${cause instanceof Error ? cause.name : 'a non-Error throw'})`,
      },
    };
  }

  const offered = toLaunchRefs(profile);
  // STRICTLY after. A launch created at the boundary instant itself is refused rather than
  // included — the proof only covers launches created after it, and one borderline launch is not
  // worth weakening the property the whole grade rests on.
  const after = offered.filter((r) => r.deployedAtMs > p.outOfSampleAfterMs);
  const oldestOffered = offered.length === 0 ? null : Math.min(...offered.map((r) => r.deployedAtMs));
  const coverageProvenBackToBoundary = oldestOffered !== null && oldestOffered <= p.outOfSampleAfterMs;

  if (after.length === 0) {
    return {
      outcome: null,
      refusal: {
        reason: 'no-post-prediction-launches',
        detail: `${UNGRADED_REASONS['no-post-prediction-launches']} The profile offered ${offered.length} launch(es), none after the boundary.`,
      },
    };
  }

  const rpc = clients.rpcFor(recipe.cost['maxRpcRequestsPerCandidate'], recipe.cost['rpcMinIntervalMs']);
  const keyless = clients.keylessFor(recipe.keylessRetryBackoffMs);
  const { score, coverage } = await scoreLaunchRefsEntry(keyless, {
    wallet: p.wallet,
    refs: after,
    nowMs,
    thresholds: /** @type {import('./stage2.mjs').Stage2Thresholds} */ (recipe.entry),
    rpc,
    preferBlockRoute: recipe.cost['preferBlockRoute'] ?? true,
    log,
  });

  return {
    outcome: {
      verdict: score.verdict,
      unmeasuredCause: score.unmeasuredCause,
      launchesOffered: offered.length,
      launchesAfterBoundary: after.length,
      launchesScored: score.launchesSampled,
      launchesDropped: coverage.launchesDropped,
      roomLeftMedian: Number.isFinite(score.roomLeft.median) ? Number(score.roomLeft.median.toFixed(6)) : null,
      coverageProvenBackToBoundary,
      keylessRequests: coverage.requestsIssued,
      rpcRequests: coverage.cost.rpcRequests,
    },
    refusal: null,
  };
}

/**
 * Read the grade ledger, or start one.
 *
 * **An ABSENT file is a first run. A file that EXISTS and cannot be read is a refusal**, and the two
 * are not the same event — the same rule `ledger.mjs` → `loadLedger` applies to the feed's memory,
 * for a sharper reason here. A `hit` or a `miss` is latched and never revised, so it is the only
 * copy of that evidence; returning an empty ledger for an unreadable one would let the very next
 * `--live` run write it back over every settled grade, and the loop would silently restart from
 * nothing while reporting a clean rate. A schema this build does not know is refused for the same
 * reason: a ledger is migrated deliberately, never rebuilt by a run that happened to be next.
 *
 * @param {string} path
 * @returns {ReturnType<typeof emptyGradeLedger>}
 * @throws {Error} if the file exists and is not a ledger this build can read.
 */
export function loadGradeLedger(path) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return emptyGradeLedger();
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `The grade ledger at ${path} is not readable JSON (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Refusing to start over: a hit or a miss is latched and never revised, so an empty ledger ` +
        `here would be written back over every settled grade by the next --live run. Restore the ` +
        `file or point --ledger elsewhere.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`The grade ledger at ${path} is not an object. Refusing to overwrite it with an empty one.`);
  }
  const l = /** @type {Record<string, any>} */ (parsed);
  if (l['schemaVersion'] !== GRADE_LEDGER_VERSION) {
    throw new Error(
      `The grade ledger at ${path} declares schemaVersion ${String(l['schemaVersion'])}; this build ` +
        `reads ${GRADE_LEDGER_VERSION}. Grade ledgers are never retro-fitted — migrate it ` +
        `deliberately rather than letting a run rebuild it from nothing.`,
    );
  }
  if (typeof l['grades'] !== 'object' || l['grades'] === null) {
    throw new Error(`The grade ledger at ${path} carries no readable "grades" block.`);
  }
  return { ...emptyGradeLedger(), ...l, grades: l['grades'] };
}

/**
 * Persist the grade ledger, **atomically**.
 *
 * Written to a temp file in the same directory and renamed over the target, so a run killed
 * mid-write cannot leave a truncated ledger behind at all — `rename` within one directory is atomic,
 * and the alternative failure is the one {@link loadGradeLedger} then has to refuse.
 *
 * @param {string} path
 * @param {ReturnType<typeof emptyGradeLedger>} ledger
 */
export function saveGradeLedger(path, ledger) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * @typedef {object} Deps
 * Test seams, exactly as `feed.mjs` → `main` and `client.mjs` provide them. There is no production
 * path that supplies any of these, and a bounds claim asserted only as arithmetic is weaker than one
 * asserted against a stub that counts requests — which is why the live path is drivable at all.
 *
 * @property {typeof fetch} [fetchImpl]        The keyed MadeOnSol client's transport.
 * @property {typeof fetch} [keylessFetchImpl] The swap-api fill walk's transport.
 * @property {typeof fetch} [rpcFetchImpl]     The entry-cost leg's transport.
 * @property {(ms: number) => Promise<void>} [sleepImpl]
 * @property {number} [nowMs]                  Clock, so ripeness is deterministic in a test.
 */

/**
 * @param {Options} opts
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} out
 * @param {(line: string) => void} err
 * @param {Deps} [deps]
 * @returns {Promise<number>}
 */
export async function main(opts, env, out, err, deps = {}) {
  if (opts.help) {
    out(USAGE);
    return EXIT.ok;
  }

  const T = loadThresholds();
  const F = T['feedback_loop'];
  const bounds = {
    minOutcomeAgeMs: F.minOutcomeAgeDays * MS_PER_DAY,
    retryAfterMs: F.retryAfterDays * MS_PER_DAY,
    // `--claims` may only LOWER the pinned cap, the same rule `--candidates` and `--score` follow on
    // the screen: a flag that could raise a pinned ceiling is not a ceiling.
    maxClaimsPerRun: opts.claims === null ? F.maxClaimsPerRun : Math.min(opts.claims, F.maxClaimsPerRun),
  };

  const records = readRunRecords(resolve(opts.runsDir));
  const { predictions, refused } = extractPredictions(records);
  // Terminal for the run, on the dry-run path too: a ledger this build cannot read is refused
  // before anything is planned, rather than degrading into a run that would write over it.
  /** @type {ReturnType<typeof emptyGradeLedger>} */
  let ledger;
  try {
    ledger = loadGradeLedger(resolve(opts.ledgerPath));
  } catch (cause) {
    err('');
    err(cause instanceof Error ? cause.message : String(cause));
    return EXIT.usage;
  }
  const nowMs = deps.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { due, skipped, settled } = dueForMeasurement(predictions, ledger, nowMs, bounds);
  const priced = due.map((p) => priceClaim(p, F.keylessMinIntervalMs));
  const fit = planFits(priced, F);

  /** @type {Record<string, unknown>} */
  const report = {
    tool: 'deployer-screen-grade',
    atIso: nowIso,
    mode: opts.live ? 'live' : 'dry-run',
    thresholdsVersion: T['version'],
    runsRead: records.length,
    claimsFound: predictions.length,
    // Records this lane cannot grade, kept rather than dropped: a run with no gradeable claim is
    // PERMANENTLY unfalsifiable, and a worklist that silently omitted it would look clean.
    recordsRefused: refused,
    settled,
    due: due.length,
    skipped: skipped.map((s) => ({ source: s.prediction.source, wallet: s.prediction.wallet, reason: s.reason })),
    plan: {
      keyedWorstCase: fit.keyed,
      keylessWorstCase: fit.keyless,
      rpcWorstCase: fit.rpc,
      keyedCeiling: F.maxKeyedRequests,
      keylessCeiling: F.maxKeylessRequests,
      rpcCeiling: F.maxRpcRequests,
      fits: fit.fits,
      refusals: fit.reasons,
      unusableRecipes: priced.filter((x) => !x.usable).length,
    },
    grades: summariseGrades(ledger),
  };

  if (!fit.fits) {
    err('');
    err('PLAN REFUSED — nothing was spent.');
    for (const r of fit.reasons) err(`  ${r}`);
    err(
      '  The plan is priced from each claim\'s OWN recorded recipe and is never truncated to fit: a ' +
        'Stage 2 walk cut short holds the earliest entrants by slot, which is a biased sample rather ' +
        'than a short one. Lower --claims, or raise the ceiling in thresholds.json on purpose.',
    );
    if (opts.json) out(JSON.stringify(report, null, 2));
    return EXIT.usage;
  }

  /** @type {import('./outcome.mjs').GradeRow[]} */
  const rows = [];
  let exitCode = EXIT.ok;

  if (opts.live) {
    const resolution = resolveKey(env);
    if (!resolution.ok) {
      err('');
      err(resolution.message);
      return EXIT.credentialMissing;
    }
    const keyed = new BoundedClient({
      key: resolution.key,
      maxRequests: F.maxKeyedRequests,
      minIntervalMs: T['budget'].keyedMinIntervalMs,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.sleepImpl === undefined ? {} : { sleepImpl: deps.sleepImpl }),
      ...(opts.json ? {} : { onRequest: (/** @type {string} */ path) => out(`  keyed: ${path}`) }),
    });
    // Pacing is the slowest of the pins involved, so a mixed batch runs at the safest rate rather
    // than the first claim's — see `priceClaim`.
    const keylessMinIntervalMs = Math.max(
      F.keylessMinIntervalMs,
      ...priced.filter((x) => x.usable).map((x) => /** @type {any} */ (x).keylessMinIntervalMs),
    );
    // One keyless client PER RETRY SCHEDULE — normally one for the whole run, because every claim in
    // a batch usually records the same pin. A claim is walked at the schedule its own run recorded,
    // and the run-level ceiling still binds across all of them: each client is created with only
    // what is left, so the total cannot exceed `maxKeylessRequests` however the batch is composed.
    /** @type {Map<string, KeylessClient>} */
    const keylessClients = new Map();
    const keylessSpent = () => [...keylessClients.values()].reduce((n, c) => n + c.issued(), 0);
    /** @param {readonly number[]} retryBackoffMs @returns {KeylessClient} */
    const keylessFor = (retryBackoffMs) => {
      const key = JSON.stringify(retryBackoffMs);
      const existing = keylessClients.get(key);
      if (existing !== undefined) return existing;
      const client = new KeylessClient({
        maxRequests: Math.max(0, F.maxKeylessRequests - keylessSpent()),
        minIntervalMs: keylessMinIntervalMs,
        retryBackoffMs,
        ...(deps.keylessFetchImpl === undefined ? {} : { fetchImpl: deps.keylessFetchImpl }),
        ...(deps.sleepImpl === undefined ? {} : { sleepImpl: deps.sleepImpl }),
      });
      keylessClients.set(key, client);
      return client;
    };
    // Every cost-leg client this run creates, so the run-level RPC spend is read off the CLIENTS
    // rather than off the outcomes. A claim that threw mid-walk still spent, and counting only what
    // reached a result would let an abandoned walk's requests fall outside the ceiling.
    /** @type {SolanaRpcClient[]} */
    const rpcClients = [];
    const rpcSpent = () => rpcClients.reduce((n, c) => n + c.issued(), 0);
    /** @param {number} ceiling @param {number} minIntervalMs @returns {SolanaRpcClient | null} */
    const rpcFor = (ceiling, minIntervalMs) => {
      // The run-level RPC ceiling binds too, not only the per-candidate one it came from: without it
      // a record pinning a large per-candidate ceiling would set this lane's exposure. It is a HARD
      // floor of zero rather than "at least one request", so the ceiling is exact — the alternative
      // would let a run overrun it by one request per remaining claim.
      const remaining = F.maxRpcRequests - rpcSpent();
      if (remaining < 1) return null;
      const client = new SolanaRpcClient({
        maxRequests: Math.min(ceiling, remaining),
        minIntervalMs,
        ...(deps.rpcFetchImpl === undefined ? {} : { fetchImpl: deps.rpcFetchImpl }),
        ...(deps.sleepImpl === undefined ? {} : { sleepImpl: deps.sleepImpl }),
      });
      rpcClients.push(client);
      return client;
    };

    if (!opts.json) {
      out('');
      out(
        `GRADING ${due.length} claim(s) — worst case ${fit.keyed} keyed, ${fit.keyless} keyless, ` +
          `${fit.rpc} Solana RPC request(s).`,
      );
    }

    try {
      for (const [i, p] of due.entries()) {
        const recipe = priced[i];
        const existing = ledger.grades[gradeKeyOf(p)] ?? null;
        if (recipe === undefined || !recipe.usable) {
          rows.push(
            gradeOne(p, null, { reason: 'recipe-unusable', detail: recipe?.usable === false ? recipe.reason : null }, nowIso, existing),
          );
          continue;
        }
        if (!opts.json) out(`  ${p.wallet} — predicted ${p.claim} on ${p.madeAtIso} (${p.source})`);
        const { outcome, refusal } = await measureOutcome(
          { keyed, keylessFor, rpcFor },
          p,
          recipe,
          nowMs,
          opts.json ? undefined : (line) => out(line),
        );
        const row = gradeOne(p, outcome, refusal, nowIso, existing);
        rows.push(row);
        if (!opts.json) {
          out(
            `    → ${row.state.toUpperCase()}` +
              (row.state === 'ungraded' ? ` (${row.ungradedReason})` : ` — outcome ${row.outcomeClaim}`),
          );
        }
      }
    } catch (cause) {
      // Whatever was graded before the failure is KEPT and written: throwing away paid-for
      // measurements over a later wallet's bad luck just spends the shared allowance twice, which is
      // the same rule `screen.mjs` applies to an aborted run.
      err('');
      err(cause instanceof Error ? cause.message : String(cause));
      exitCode =
        cause instanceof VendorRefused
          ? exitForRefusal(cause.kind)
          : cause instanceof CeilingReached
            ? EXIT.ceiling
            : EXIT.upstream;
    }

    const merged = mergeGrades(ledger, rows, nowIso);
    saveGradeLedger(resolve(opts.ledgerPath), merged.ledger);
    report['measured'] = rows.length;
    report['spend'] = { keyed: keyed.stats().issued, keyless: keylessSpent(), rpc: rpcSpent() };
    report['ledgerAdded'] = merged.added;
    report['ledgerUpdated'] = merged.updated;
    // A settled grade is never revised. A non-zero count here means something re-offered one, which
    // would be a defect in `dueForMeasurement` rather than a normal event — so it is reported.
    report['ledgerLatchedUnchanged'] = merged.latched;
    report['grades'] = summariseGrades(merged.ledger);
  }

  if (opts.json) out(JSON.stringify(report, null, 2));
  else out(render(report, opts));
  return exitCode;
}

/**
 * @param {Record<string, any>} report
 * @param {Options} opts
 * @returns {string}
 */
export function render(report, opts) {
  const g = report['grades'];
  const lines = [
    '',
    `SCREEN FEEDBACK LOOP — ${report['mode']}, thresholds ${report['thresholdsVersion']}`,
    `  ${report['runsRead']} run record(s) read, ${report['claimsFound']} gradeable claim(s) found`,
  ];

  if (report['claimsFound'] === 0) {
    lines.push(
      '',
      '  NO CLAIM IN ANY COMMITTED RECORD CAN BE GRADED, and that is the finding rather than a',
      '  failure. A run that did not record what it predicted can NEVER be graded — the claim and',
      '  the instant it stopped being in-sample cannot be reconstructed after the fact — so every',
      '  such run is permanently unfalsifiable. Records written from schema 16 carry the claim and',
      '  this lane grades them as they ripen.',
    );
  }
  for (const r of report['recordsRefused'] ?? []) {
    lines.push(`    · ${r.source}: ${r.reason}`);
  }

  lines.push(
    '',
    `  settled (never re-measured): ${report['settled']}    due this run: ${report['due']}`,
  );
  /** @type {Record<string, number>} */
  const skippedBy = {};
  for (const s of report['skipped'] ?? []) skippedBy[s.reason] = (skippedBy[s.reason] ?? 0) + 1;
  for (const [reason, n] of Object.entries(skippedBy)) {
    lines.push(`    not measured this run — ${reason}: ${n}`);
  }

  const p = report['plan'];
  lines.push(
    '',
    '  PLAN (worst case, refused before the first request if it does not fit)',
    `    keyed MadeOnSol   ${p.keyedWorstCase} of ${p.keyedCeiling}`,
    `    keyless swap-api  ${p.keylessWorstCase} of ${p.keylessCeiling}`,
    `    Solana RPC        ${p.rpcWorstCase} of ${p.rpcCeiling}`,
  );
  if (p.unusableRecipes > 0) {
    lines.push(`    ${p.unusableRecipes} claim(s) carry a recipe this build cannot apply — ungraded, not defaulted`);
  }
  if (!opts.live) lines.push('    DRY RUN — nothing was fetched and nothing was written. --live spends this.');

  lines.push(
    '',
    '  THE SCREEN\'S OWN HIT RATE',
    `    overall        ${rate(g.overall)}`,
    `    said beatable  ${rate(g.byClaim.beatable)}`,
    `    said not       ${rate(g.byClaim['not-beatable'])}`,
    `    ungraded       ${g.ungraded} of ${g.claims} claim(s) in the ledger`,
  );
  for (const [reason, n] of Object.entries(g.ungradedByReason)) lines.push(`      · ${reason}: ${n}`);
  lines.push('', `  ${g.caveat}`, `  READING: ${g.reading}`);
  return lines.join('\n');
}

/** @param {{ n: number, hits: number, rate: number | null }} h @returns {string} */
function rate(h) {
  return h.n === 0
    ? 'no observations (NOT 0% — nothing has been graded)'
    : `${h.hits}/${h.n} = ${(h.rate ?? 0).toFixed(4)}`;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    process.exit(EXIT.usage);
  }
  const code = await main(
    parsed.opts,
    process.env,
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  );
  process.exit(code);
}
