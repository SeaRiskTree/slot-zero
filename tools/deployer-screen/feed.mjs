#!/usr/bin/env node
/**
 * feed — a scheduled lane that surfaces deployer wallets this project has NOT seen before, triages
 * them on the Stage 1 competence gate, and queues the survivors for the beatability screen.
 * No agent required: `node tools/deployer-screen/feed.mjs --help`.
 *
 * Full scope, bounds and reproduction in `FEED.md`. Four things about it are load-bearing enough to
 * repeat here, because a reader who skims one file will skim this one:
 *
 * ## 1. It looks forward at the population, never back at the graveyard
 *
 * This supersedes the re-open monitor. The captain's correction, 2026-08-02: *"It would not sit and
 * watch wallet already deemed closed window, a dev that is competent will not reopen a window.
 * Instead we need to keep search for new dev wallets."* So a wallet graded here is **never
 * re-polled** — it is simply never offered as new again. `ledger.mjs` is that memory.
 *
 * ## 2. The default path spends nothing
 *
 * A run is a **dry run unless `--live` is passed**. This lane is meant to run on a schedule forever,
 * so the safe path has to be the one an operator gets by typing the command wrong — and that
 * argument does not weaken now the key is Ultra and exclusive to slot-zero, because what a cron
 * spends unreviewed was never only about the size of the allowance. Its per-run keyed cost is pinned
 * in `thresholds.json` → `feed` and refused before the first request if the plan does not fit:
 * **6 enumeration + at most `--gate` profile requests, and nothing else is keyed** — 6 and not 3
 * since captain decision 262a made the seeding tiered (`seed.mjs` → `DEFAULT_TIERS`). It spends no
 * keyless request at all.
 *
 * ## 3. It grades on the CHEAP reading, and that reading is biased in BOTH directions at once
 *
 * The gate here reads the vendor profile — which tokens the wallet OWNS NOW — because the
 * creation-derived history costs ~100 Solana RPC requests per candidate at 2.5s apart and no
 * schedule can carry it. That reading **rejects** through the count bars — it understates a
 * wallet's launches and understates its bonded launches by more, so it scores the better deployer
 * worse (`README.md` → "Which history the gate counts") — and it **inflates** through the rate,
 * because the page holds what a wallet still owns and the ones that move on are the winners
 * (`FEED.md` → "It is biased in BOTH directions at once" carries the measured counts). Therefore
 * **a failure here is `held`, not `gate-failed`** — a triage outcome, not a verdict — and every run
 * prints the standing count of held wallets and the near-misses inside it. It is NOT a one-way
 * conservative filter, so clearing it is not pre-validation either. `screen.mjs` remains the
 * authority on whether a wallet is competent.
 *
 * ## 4. A dead feed must not read as a healthy quiet one
 *
 * That is not a hypothetical: the screen's first two committed runs looked healthy while two of
 * three seeds returned zero wallets, because nothing compared rows against wallets. Here, three
 * conditions are audible and exit **non-zero** — a seed that returned rows but no wallets (our
 * reader is wrong), every seed inert (no input at all), and a dry streak (the vendor's population is
 * saturated). See `ledger.mjs` → `feedAlarm`.
 *
 * Exit codes, chosen so a scheduler can act on them without parsing text:
 *
 *   0  ran to completion and the yield is within tolerance.
 *   2  usage error.
 *   3  credential missing or malformed.
 *   4  credential rejected (401/403).
 *   5  quota exhausted or rate-limited (429).
 *   6  a request ceiling was reached before the run completed.
 *   7  upstream or transport failure, including a 400 the vendor's validator rejected.
 *   8  Stage 0 validation failed — the gate no longer reproduces what we already know.
 *   9  THE FEED IS DRY OR BROKEN. It ran, it spent quota, and its yield is not usable.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POPULATION_TAPE, POPULATION_TAPE_DIR, requireDataset } from '../../config/data-root.mjs';
import { assessSubGateAdmission, subGateBounds } from './admission.mjs';
import { BoundedClient, CeilingReached, MADEONSOL_DAILY_REQUESTS, VendorRefused } from './client.mjs';
import { KEY_ENV_VAR, resolveKey } from './credential.mjs';
import {
  ALL_UNMEASURED_MIN_GATED,
  appendRun,
  backlogDepth,
  dryStreak,
  feedAlarm,
  importRunRecords,
  gradeWallet,
  loadLedger,
  markPrefiltered,
  markWorthARequest,
  medianOf,
  nextGateBatch,
  queuedForScreen,
  readRunRecords,
  recordSeen,
  saveLedger,
  summariseLedger,
} from './ledger.mjs';
import { measureCompletion, toTokenRecords } from './measure.mjs';
import { redactAll, redactVendorIdentifiers } from './record.mjs';
import {
  applyGate,
  competenceCriterionIncomplete,
  competenceEmptiedByMayhem,
  verdictFor,
} from './rank.mjs';
import { PREFILTER_MIN_DEPLOYED, buildSeedPlan, mergeSeeds, prefilterReason, readSeedResponse } from './seed.mjs';
import { runStage0 } from './stage0.mjs';
import { exitForRefusal, loadThresholds, partialOutPath } from './screen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The population tape's directory. **Where the data lives is `config/data-root.mjs`'s answer, not
 * this tool's**: the tapes are not in this tree, and it defaults to the store at
 * `~/slot-zero-data` and moves with `SLOT_ZERO_DATA_ROOT`.
 * `--data-dir` still overrides it per run.
 */
const DEFAULT_DATA_DIR = POPULATION_TAPE_DIR;
const DEFAULT_LEDGER = join(HERE, 'feed', 'ledger.json');
const DEFAULT_RUNS_DIR = join(HERE, 'runs');

/**
 * Feed record format version. Separate from the screen's `RECORD_SCHEMA_VERSION`: these are
 * different documents answering different questions, and one version number over both would make a
 * change to either read as a change to both.
 *
 * **2** adds `alarm.unmeasuredConditionArmed`. Bumped rather than added silently for the reason the
 * field itself exists: in a schema-1 record the field's absence is indistinguishable from a run that
 * had the alarm armed, so a reader with no version could not tell a disarmed run from an older one.
 *
 * **3** changes what `spend.dailyAllowance` MEANS. Under schema 2 it held the per-run keyed ceiling
 * (`budget.maxKeyedRequests` — 402 after captain decision 267a, and mislabelled a daily allowance);
 * under schema 3 it holds the vendor's actual day, `MADEONSOL_DAILY_REQUESTS` (100,000). Bumped
 * rather than corrected in place because the two quantities differ by ~250x while both being
 * well-formed request counts, so a reader holding a schema-2 record has nothing in the record itself
 * that would tell them which one they have — a version is exactly how that is said.
 */
export const FEED_RECORD_SCHEMA_VERSION = 3;

const EXIT = {
  ok: 0,
  usage: 2,
  credentialMissing: 3,
  credentialRejected: 4,
  quota: 5,
  ceiling: 6,
  upstream: 7,
  stage0: 8,
  dry: 9,
};

/**
 * What this lane does not and cannot cover. Printed on every run and persisted in every record,
 * for the same reason the screen prints its own: a number without its ceiling gets quoted without it.
 */
export const FEED_LIMITATIONS = [
  'DISCOVERY IS ENTIRELY VENDOR-SELECTED. Every wallet here came from a MadeOnSol enumeration ' +
    'endpoint, so this feed can only ever surface deployers that vendor already tracks and profiles. ' +
    'A deployer they have never profiled is not rare here — it is INVISIBLE here, and no count this ' +
    'run prints bounds how many there are.',
  'THE DISCOVERY LAG IS REPORTED AS A LOWER BOUND AND THAT IS NOT MODESTY. It is measured as the ' +
    'age of the oldest deploy in the vendor\'s own profile page, which is a capped page of a ' +
    'trailing window; and it exists only for wallets the vendor profiled at all. It says how late ' +
    'we were to the wallets we found. It says NOTHING about the ones we did not.',
  'THE PRE-FILTER IS A CADENCE FILTER. It reads the vendor\'s trailing ~7.5-day deploy count, so a ' +
    'slow-but-steady deployer is skipped before a request is spent on it. The skipped wallets are ' +
    'counted and their trailing counts reported, so the cost is visible; it is not eliminated.',
  'THE GATE READING HERE IS OWNERSHIP-DERIVED AND BIASED TOWARDS REJECTION. A `held` wallet is NOT ' +
    'a rejected wallet. screen.mjs, which reads the creation-derived history, is the authority.',
  'AND THAT BIAS RUNS BOTH WAYS AT ONCE, FROM THE SAME SURFACE. Measured over the 82 candidates of ' +
    'the screen\'s last real run, which records both readings per candidate: the vendor page ' +
    'REJECTS through the count bars — 20 of 82 clear minTokens+minSpanDays here against 66 of 82 on ' +
    'the creation-derived reading — while the RATE it computes reads HIGHER than the gate\'s on 37 ' +
    'of 81 wallets, by up to +0.6929, because the page holds what a wallet still OWNS and the ones ' +
    'that move on are the winners. So `held` is over-populated and `queued` is over-generous at the ' +
    'same time; this is not a one-way conservative filter.',
  'THIS RECORD\'S completionRate IS NOT screen.mjs\'s completionRate. They are different quantities ' +
    'over different histories and differ by up to 0.69 on one wallet. Every ledger row carries ' +
    '`gateReading` (`ownership-only` here, `creation-derived` under screen.mjs\'s default) — read ' +
    'it before comparing, pooling or ranking rates across the two sources.',
  'CLEARING THIS GATE IS NOT A RECOMMENDATION. It means competent enough to be worth measuring. ' +
    'Whether a deployer leaves an outsider any room, and whether that room is profitable, is ' +
    'UNMEASURED here — that is Stage 2, in screen.mjs.',
];

const DEFAULT_SEED_REQUESTS = buildSeedPlan({ limit: 1 }).length;

const USAGE = `feed — continuous discovery of NEW candidate deployer wallets

  node tools/deployer-screen/feed.mjs [options]

THE DEFAULT IS A DRY RUN. Nothing is requested and nothing is written unless --live is passed.

OPTIONS
  --live              Actually spend. Without it this prints the plan and the ledger's state and
                      requests nothing at all.
  --bootstrap         Create or refresh the ledger from the committed screen run records and stop.
                      Offline, no key, no request. Run this once when standing the lane up so the
                      first live run does not offer 82 already-graded wallets back as discoveries.
  --gate <n>          New wallets to gate this run. Cannot exceed the pinned cap in
                      thresholds.json -> feed.maxGateBatch; this flag can only lower it.
  --tier <t>          Restrict enumeration to one tier: elite|good|moderate|rising|cold. Treat tier
                      as another trailing window — membership is NOT stable (README.md).
  --ledger <path>     Feed memory. Default tools/deployer-screen/feed/ledger.json.
  --runs <dir>        Committed screen run records, folded in so a wallet the screen already graded
                      is never offered as new. Default tools/deployer-screen/runs.
  --out <path>        Write this run's feed record as JSON. An INCOMPLETE run writes
                      <path>.partial.json instead, leaving <path> untouched.
  --json              Print the feed record as JSON instead of text.
  --data-dir <path>   Population tape location, for Stage 0. Defaults to the population tape under
                      $SLOT_ZERO_DATA_ROOT, which is ~/slot-zero-data when unset.
  --help              This text.

WHAT ONE RUN COSTS
  Keyed (MadeOnSol, Ultra and exclusive to this lane): ${DEFAULT_SEED_REQUESTS} enumeration requests
  on the default tiered seeding — a single --tier narrows the plan and costs fewer — plus at most
  --gate profile requests. Nothing else is keyed. A plan whose worst case exceeds the pinned per-run
  ceiling is refused before the first request, with nothing spent.
  Keyless: NONE. This lane does not walk the fill tape and does not touch Solana RPC.

CREDENTIAL
  Reads ${KEY_ENV_VAR} from the environment. Never printed, never logged, never written to disk.

EXIT CODES
  0 ok   2 usage   3 no credential   4 credential rejected   5 quota   6 ceiling reached
  7 upstream   8 stage 0 failed
  9 THE FEED IS DRY OR BROKEN — it ran and its yield is not usable. A scheduler must not treat
    this as a quiet day.
`;

/**
 * @typedef {object} FeedOptions
 * @property {boolean} live
 * @property {boolean} bootstrap
 * @property {number | null} gate
 * @property {string | undefined} tier
 * @property {string} ledger
 * @property {string} runsDir
 * @property {string | null} out
 * @property {boolean} json
 * @property {string} dataDir
 * @property {boolean} help
 */

/**
 * @param {readonly string[]} argv
 * @returns {{ ok: true, opts: FeedOptions } | { ok: false, message: string }}
 */
export function parseFeedArgs(argv) {
  /** @type {FeedOptions} */
  const opts = {
    // **Dry by default.** A scheduled lane — the one caller no human reviews before each spend —
    // does not get to have its spending path be the one you reach by forgetting a flag.
    live: false,
    bootstrap: false,
    gate: null,
    tier: undefined,
    ledger: DEFAULT_LEDGER,
    runsDir: DEFAULT_RUNS_DIR,
    out: null,
    json: false,
    dataDir: DEFAULT_DATA_DIR,
    help: false,
  };

  const TIERS = ['elite', 'good', 'moderate', 'rising', 'cold'];

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
      case '--bootstrap':
        opts.bootstrap = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--gate': {
        const v = next();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isInteger(n) || n < 1) return { ok: false, message: '--gate needs a positive integer' };
        opts.gate = n;
        break;
      }
      case '--tier': {
        const v = next();
        if (v === null || !TIERS.includes(v)) {
          return { ok: false, message: `--tier must be one of ${TIERS.join('|')}` };
        }
        opts.tier = v;
        break;
      }
      case '--ledger': {
        const v = next();
        if (v === null) return { ok: false, message: '--ledger needs a path' };
        opts.ledger = v;
        break;
      }
      case '--runs': {
        const v = next();
        if (v === null) return { ok: false, message: '--runs needs a path' };
        opts.runsDir = v;
        break;
      }
      case '--out': {
        const v = next();
        if (v === null) return { ok: false, message: '--out needs a path' };
        opts.out = v;
        break;
      }
      case '--data-dir': {
        const v = next();
        if (v === null) return { ok: false, message: '--data-dir needs a path' };
        opts.dataDir = v;
        break;
      }
      default:
        return { ok: false, message: `unknown option '${String(arg)}'` };
    }
  }

  if (opts.bootstrap && opts.live) {
    return {
      ok: false,
      message:
        '--bootstrap and --live are contradictory: bootstrap builds the ledger from committed run ' +
        'records offline and requests nothing. Run --bootstrap first, then --live.',
    };
  }

  return { ok: true, opts };
}

/**
 * Resolve the per-run bounds from the pinned block plus the flags.
 *
 * Separated out and exported so the refusal arithmetic is testable without a network, and so the
 * dry run and the live run cannot disagree about what a run would cost — they call this.
 *
 * @param {{ gateBatch: number, maxGateBatch: number, maxKeyedRequestsPerRun: number }} feedT
 * @param {{ maxKeyedRequests: number }} budgetT
 * @param {number | null} requestedGate
 * @param {number} enumerationCost
 * @returns {{ ok: true, gateBatch: number, maxKeyed: number, worstCaseKeyed: number } |
 *            { ok: false, message: string }}
 */
export function planFeedRun(feedT, budgetT, requestedGate, enumerationCost) {
  // The pinned cap can only ever be lowered from the command line. Same rule as every other bound
  // in this tool: a bound a flag can widen is not a bound.
  const gateBatch = Math.min(requestedGate ?? feedT.gateBatch, feedT.maxGateBatch);
  const maxKeyed = Math.min(feedT.maxKeyedRequestsPerRun, budgetT.maxKeyedRequests);
  const worstCaseKeyed = enumerationCost + gateBatch;

  if (worstCaseKeyed > maxKeyed) {
    return {
      ok: false,
      message:
        `Refusing to start: the plan's worst case is ${enumerationCost} enumeration + ${gateBatch} ` +
        `gate = ${worstCaseKeyed} keyed requests, above this lane's per-run ceiling of ${maxKeyed}. ` +
        `Lower --gate to ${Math.max(0, maxKeyed - enumerationCost)} or fewer. Nothing was requested, ` +
        `so no quota was spent.`,
    };
  }

  return { ok: true, gateBatch, maxKeyed, worstCaseKeyed };
}

/**
 * The standing warning for a gate batch too small to arm the "every gated profile unreadable" alarm.
 *
 * `feedAlarm` refuses to assert a vendor-shape move from a sample of one, so a batch below
 * {@link ALL_UNMEASURED_MIN_GATED} cannot ever satisfy that condition. Nothing else covers the gap —
 * a shape move leaves enumeration healthy, so the run still surfaces wallets and the dry streak
 * never accumulates — which is exactly the silent death the `unmeasured` state exists to prevent.
 * The floor is not lowered to close it; the configuration says so out loud instead, on the dry path
 * as well as the live one, because the dry run is the default and is where an operator reads what a
 * setting will do.
 *
 * Derived from the shared constant rather than a literal, so the warning and the alarm cannot
 * disagree if the floor is ever re-pinned.
 *
 * @param {number} gateBatch The batch this run resolved to, after the pinned cap and `--gate`.
 * @returns {string | null} `null` when the alarm is armed.
 */
export function unmeasuredAlarmDisabledWarning(gateBatch) {
  if (gateBatch >= ALL_UNMEASURED_MIN_GATED) return null;
  return (
    `  !! ALARM DISABLED AT THIS SETTING — a gate batch of ${gateBatch} can never reach the ` +
    `${ALL_UNMEASURED_MIN_GATED} gated wallets\n` +
    `     the "every gated profile came back unreadable" condition requires, so that alarm CANNOT ` +
    `fire here.\n` +
    `     The day the vendor's profile shape moves, this lane grades every wallet unmeasured and ` +
    `still\n` +
    `     exits 0: enumeration stays healthy, so the dry streak does not catch it either. Run ` +
    `--gate ${ALL_UNMEASURED_MIN_GATED}\n` +
    `     or higher to arm it.`
  );
}

/**
 * Triage one wallet's vendor profile onto a feed state.
 *
 * Pure, so the mapping from a gate verdict to a feed state is one testable place rather than a
 * conditional inside the run loop. The mapping is where this lane's central caution lives:
 * `gate-failed` becomes `held`, and `held` is not a rejection.
 *
 * ## THE SECOND ADMISSION ARM REACHES THIS LANE TOO, AND IT HAD TO — captain decision 451
 *
 * `ledger.mjs` grades a wallet ONCE and never offers it again, so a discovery feed left on the old
 * rule would file every sub-gate deployer as `held` permanently: the captain's ruling would apply
 * at `screen.mjs` and never reach the surface that decides which wallets the screen is ever offered.
 * That is the invisible, permanent direction this whole lane is built to avoid, so the arm is asked
 * here as well and an admission becomes its own state, `queued-sub-gate`.
 *
 * **IT IS ASKED ON THE VENDOR PAGE, WHICH IS A DIFFERENT AND BIASED READING, and that is disclosed
 * rather than corrected.** FEED.md → "Why the gate here reads ownership" owns the argument: this
 * page's rate reads HIGHER than the gate reading on 37 of 81 wallets and by up to +0.6929, so the
 * inflow floor admits more wallets here than `screen.mjs` would. The direction is the cheap one —
 * `screen.mjs` re-judges every queued wallet on the creation-derived history and can still refuse
 * it, while a wallet this lane files is never offered again — and it is the same asymmetry that
 * keeps the feed on the vendor page at all.
 *
 * @param {unknown} profile A parsed `/deployer-hunter/{wallet}` response.
 * @param {{ minTokens: number, minCompletionRate: number, minSpanDays: number }} gateThresholds
 * @param {{ bounds: import('./admission.mjs').SubGateBounds, nowMs: number } | null} [subGate] The
 *   second arm's bounds and the run's own instant. Omitted or `null` means the arm was NOT
 *   CONSULTED — every verdict is then what it was before captain decision 451, which is what keeps
 *   the superseded behaviour reachable from a test rather than reconstructed by a second code path.
 *   The run loop below always passes it, and a test pins that it does.
 * @returns {{ state: import('./ledger.mjs').FeedState, gateVerdict: string, rationale: string,
 *             completion: import('./measure.mjs').CompletionMeasurement, capped: boolean,
 *             shortfalls: string[] }}
 */
export function triage(profile, gateThresholds, subGate = null) {
  const { records, capped } = toTokenRecords(profile);
  const completion = measureCompletion(records);
  // `historySource: 'ownership-only'` is passed so a zero-token rejection names the vendor rather
  // than a creation walk this lane never runs.
  const gate = applyGate({ completion, historySource: 'ownership-only' }, gateThresholds);
  // **A profile with no usable record is UNMEASURED, not failed.** The screen reaches
  // `gate-unmeasured` only from the creation-derived merge, so this is the feed's own addition and
  // it is deliberate: on a schedule, the day the vendor's profile shape moves, EVERY wallet would
  // come back with zero parsed records. Graded as `held` that reads as a population of ordinary
  // rejections and the feed dies quietly; graded as unmeasured it is visible per wallet and it
  // trips the run-level alarm. An empty profile and a moved response shape look identical from
  // here, so neither may be recorded as a finding.
  // WHICH way a reading empties is named from the counts in hand, never asserted. A profile whose
  // rows all carry a usable `created_timestamp` and no readable `complete` field empties through the
  // criterion, not through the deploy time, and blaming the deploy time sends an operator looking
  // for a gap that is not there. The note is persisted in the feed run record and this repo never
  // retro-edits one, so an overstatement here is permanent.
  // AND IT STATES ONLY WHAT `verdictFor` DOES NOT — the same "state it once" rule `applyGate` keeps
  // one module over. The mayhem count and the criterion count are `verdictFor`'s own branches to
  // state, so this entry carries the deploy-time cause and the nothing-at-all case and stays silent
  // where repeating would be the whole of its contribution.
  const emptiedByMayhem = competenceEmptiedByMayhem(completion);
  /** @type {string[]} */
  const emptiedBy = [];
  if (completion.droppedNoTimestamp > 0 && !emptiedByMayhem) {
    emptiedBy.push(`${completion.droppedNoTimestamp} carried no usable deploy time`);
  }
  // A branch of `verdictFor` already reaches `gate-unmeasured` and names the cause, so an entry
  // adding nothing may be dropped without changing the outcome. Where it adds nothing AND no such
  // branch fires, it is what makes an empty profile unmeasured rather than failed — so it is pushed.
  const verdictNamesTheCause = emptiedByMayhem || competenceCriterionIncomplete(completion);
  // AND THE PREFIX MAY NOT CLAIM A COMPLETE CAUSE IT DOES NOT HAVE. Where `verdictFor` has already
  // named the criterion count, the deploy-time count is an ADDITIONAL cause and not the emptying
  // one — "the gate was left no launch record to read: 2 carried no usable deploy time" is false
  // when 30 more left through the criterion, and it is persisted.
  const notMeasured =
    completion.tokens === 0 && (emptiedBy.length > 0 || !verdictNamesTheCause)
      ? [
          (emptiedBy.length === 0
            ? "the vendor's profile carried no launch record at all"
            : verdictNamesTheCause
              ? `a further ${emptiedBy.join('; ')}, on top of the exclusion named above`
              : `the gate was left no launch record to read: ${emptiedBy.join('; ')}`) +
            ', so the gate had nothing to decide over — an empty deployer and a moved response ' +
            'shape are indistinguishable from here',
        ]
      : [];
  const { verdict, rationale } = verdictFor({
    gate,
    completion,
    capped,
    notMeasured,
    // Captain decision 451. `verdictFor` consults it only where the gate refused a COMPLETE
    // reading, so an unmeasured profile — the state the paragraphs above exist to protect — is
    // reached before the arm is asked and cannot be admitted by it.
    subGate:
      subGate === null
        ? null
        : assessSubGateAdmission({ completion, gate, nowMs: subGate.nowMs }, gateThresholds, subGate.bounds),
  });

  /** @type {import('./ledger.mjs').FeedState} */
  const state =
    verdict === 'gate-passed'
      ? 'queued'
      : // ITS OWN STATE AND NOT `queued`, for the reason it is its own verdict one module over: the
        // two arms are two populations, and `summariseLedger`'s counts would otherwise pool them.
        // `queuedForScreen` deliberately serves both, because the queue is a spend decision and not
        // a statistic — the same distinction `admittedToStage2` draws at the screen.
        verdict === 'sub-gate-admitted'
        ? 'queued-sub-gate'
        : verdict === 'gate-failed'
          ? 'held'
          : 'unmeasured';

  return {
    state,
    gateVerdict: verdict,
    rationale,
    completion,
    capped,
    // Free text built from counts by rank.mjs, routed through the same redaction boundary the
    // screen's record uses. Nothing vendor-derived may reach a persisted note by accident.
    shortfalls: redactAll(gate.reasons),
  };
}

/**
 * @typedef {object} FeedDeps
 * @property {typeof fetch} [fetchImpl] Injected for tests, exactly as `client.mjs` does. There is no
 *   code path in the test suite that reaches the real network — `test/offline-guard.ts` enforces it.
 * @property {(ms: number) => Promise<void>} [sleepImpl] Injected so the keyed pacing is free in tests.
 */

/**
 * @param {FeedOptions} opts
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} out
 * @param {(line: string) => void} err
 * @param {FeedDeps} [deps] Test seam. Absent in every real invocation.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(opts, env, out, err, deps = {}) {
  if (opts.help) {
    out(USAGE);
    return EXIT.ok;
  }

  const T = loadThresholds();
  const feedT = T['feed'];
  const budgetT = T['budget'];
  const gateThresholds = {
    minTokens: T['stage1_gate'].minTokens,
    minCompletionRate: T['stage1_gate'].minCompletionRate,
    minSpanDays: T['stage1_gate'].minSpanDays,
  };
  // Captain decision 451's second arm. Resolved once and REFUSING rather than defaulting if its
  // pins are missing, exactly as `screen.mjs` does — on a scheduled lane a quietly self-sized arm
  // would file a population nobody sized, once, permanently. The window cap is `stage2_entry`'s
  // because the tempo floor is one Stage 2 VISIT's worth of windows and this lane queues for that
  // stage; it scores nothing itself.
  const subGateAdmissionBounds = subGateBounds(T['stage1_gate'], T['stage2_entry'].maxLaunchesPerCandidate);

  // ---- Stage 0. Local, ~1 second, no network and no key. ----------------------------------
  // The gate this lane applies is the screen's gate. If the screen no longer reproduces the
  // answers we already hold, a feed built on it produces a queue nobody should act on — and unlike
  // a one-off screen run, it would keep producing one on a schedule.
  try {
    // Checked before the first CSV read — see the same call in `screen.mjs`.
    const stage0 = runStage0(requireDataset(POPULATION_TAPE, opts.dataDir), gateThresholds, { ...T['stage2_entry'] });
    if (!stage0.passed) {
      err('Refusing to run: Stage 0 failed, so the gate no longer reproduces the answers we hold.');
      for (const failure of stage0.failures) err(`  - ${failure}`);
      return EXIT.stage0;
    }
    if (!opts.json) out(`stage 0 PASSED (${stage0.groundTruth.tokens} ground-truth launches) — the gate is fit to use`);
  } catch (cause) {
    err(`Stage 0 could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
    err(`  Is --data-dir correct? Tried: ${opts.dataDir}`);
    return EXIT.stage0;
  }

  // ---- Memory. Offline, free, and rebuilt from committed run records every time. -----------
  /** @type {import('./ledger.mjs').Ledger} */
  let ledger;
  try {
    ledger = loadLedger(resolve(opts.ledger));
  } catch (cause) {
    err(cause instanceof Error ? cause.message : String(cause));
    return EXIT.usage;
  }
  const knownBeforeImport = Object.keys(ledger.wallets).length;
  const runRecords = readRunRecords(resolve(opts.runsDir));
  const { imported } = importRunRecords(ledger, runRecords);
  const knownBefore = Object.keys(ledger.wallets).length;

  // ---- Bootstrap. Offline, keyless, and the one path that writes without spending. ---------
  if (opts.bootstrap) {
    saveLedger(resolve(opts.ledger), ledger, new Date().toISOString());
    out('');
    out(
      `BOOTSTRAP — ledger written to ${resolve(opts.ledger)}: ${knownBefore} wallet(s), ` +
        `${imported} folded in from ${runRecords.length} committed run record(s). ` +
        `No request was made and no quota was spent.`,
    );
    out('');
    out(renderLedgerState(ledger));
    return EXIT.ok;
  }

  // ---- Plan --------------------------------------------------------------------------------
  const seedPlan = buildSeedPlan({
    limit: feedT.seedLimit,
    ...(opts.tier === undefined ? {} : { tier: opts.tier }),
  });
  const plan = planFeedRun(feedT, budgetT, opts.gate, seedPlan.length);
  if (!plan.ok) {
    err(plan.message);
    return EXIT.usage;
  }
  const { gateBatch, maxKeyed, worstCaseKeyed } = plan;

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  // One instant for every elapsed-days judgement in the run, so a wallet's sub-gate admission does
  // not depend on where in the batch it was gated.
  const runStartedMs = startedAt;
  const resolution = resolveKey(env);

  // ---- The dry path, which is the DEFAULT. Requests nothing, writes nothing. ---------------
  if (!opts.live) {
    out('');
    out('DRY RUN — this is the default. Nothing was requested and nothing was written.');
    out('');
    out(`  keyed plan            ${seedPlan.length} enumeration + up to ${gateBatch} gate = ${worstCaseKeyed} request(s)`);
    out(`  per-run ceiling       ${maxKeyed} (thresholds.json -> feed.maxKeyedRequestsPerRun)`);
    // THE DENOMINATOR IS THE VENDOR'S DAY, NOT budget.maxKeyedRequests. It used to be the latter,
    // which read correctly only while that ceiling happened to BE the daily allowance — at Ultra it
    // is a per-run ceiling of 402 and printing a share against it would have understated this lane's
    // headroom by ~250x while looking exactly as authoritative.
    const dailyWorstCase = worstCaseKeyed * feedT.runsPerDayAssumed;
    out(
      `  assumed daily cost    ${worstCaseKeyed} x ${feedT.runsPerDayAssumed} run(s)/day = ` +
        `${dailyWorstCase} of the ${MADEONSOL_DAILY_REQUESTS.toLocaleString('en-US')}/day allowance ` +
        `(${((dailyWorstCase / MADEONSOL_DAILY_REQUESTS) * 100).toFixed(3)}%, Ultra and exclusive to this lane)`,
    );
    out('  keyless plan          NONE. This lane spends no keyless request and touches no Solana RPC.');
    const disabled = unmeasuredAlarmDisabledWarning(gateBatch);
    if (disabled !== null) {
      out('');
      out(disabled);
    }
    out('');
    for (const entry of seedPlan) out(`  would GET ${entry.path} (${entry.label})`);
    out('');
    out(`  ledger                ${resolve(opts.ledger)}`);
    out(
      `  known wallets         ${knownBefore} (${knownBeforeImport} in the ledger, ${imported} folded in ` +
        `from ${runRecords.length} committed run record(s))`,
    );
    out(`  backlog               ${backlogDepth(ledger)} wallet(s) surfaced but not yet gated`);
    const preview = nextGateBatch(ledger, gateBatch);
    out(`  would gate first      ${preview.length === 0 ? '(nothing in the backlog — the batch would be filled from this run\'s new wallets)' : preview.join(', ')}`);
    out('');
    out(renderLedgerState(ledger));
    out('');
    out(
      resolution.ok
        ? `  credential            ${resolution.description}`
        : `  credential            NOT USABLE — a live run would exit ${EXIT.credentialMissing}`,
    );
    out('');
    out('  Add --live to spend the plan above.');
    out('');
    out(renderLimitations());
    return EXIT.ok;
  }

  if (!resolution.ok) {
    err('');
    err('CREDENTIAL PROBLEM — nothing was discovered, and this is NOT a dry feed.');
    err('');
    err(resolution.message);
    return EXIT.credentialMissing;
  }

  // ---- Live -------------------------------------------------------------------------------
  let completed = true;
  /** @type {string | null} */
  let abortReason = null;
  /** @type {import('./seed.mjs').SeedYield[]} */
  const seedYields = [];
  let distinctWalletsSeeded = 0;
  let newlySurfaced = 0;
  /** @type {Map<string, number>} */
  const newBySeed = new Map();
  /** @type {{ wallet: string, vendorDeployed: number | null }[]} */
  const prefilteredThisRun = [];
  let newPrefiltered = 0;
  /** @type {{ wallet: string, state: string, gateVerdict: string, rationale: string,
   *           tokens: number, completionRate: number, spanDays: number,
   *           criterionUnreadable: number, lagDaysAtLeast: number | null,
   *           fromBacklog: boolean }[]} */
  const gradedThisRun = [];

  const client = new BoundedClient({
    key: resolution.key,
    maxRequests: maxKeyed,
    minIntervalMs: budgetT.keyedMinIntervalMs,
    onRequest: (path, attempt) => {
      if (!opts.json) out(`  → GET ${path}${attempt > 0 ? ` (retry ${attempt})` : ''}`);
    },
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.sleepImpl === undefined ? {} : { sleepImpl: deps.sleepImpl }),
  });

  // Which wallets were already waiting BEFORE this run's enumeration, so the report can separate
  // "we drained the backlog" from "we gated something we just found". A feed whose gate batch is
  // permanently full of backlog is not discovering anything, and that has to be visible.
  const backlogBefore = new Set(
    Object.values(ledger.wallets).filter((e) => e.state === 'deferred').map((e) => e.wallet),
  );

  try {
    if (!opts.json) {
      out('');
      out('ENUMERATING — MadeOnSol free endpoints. This is the only discovery source there is.');
    }

    for (const entry of seedPlan) {
      const body = await client.getJson(entry.path, entry.query);
      const yielded = readSeedResponse(entry, body);
      seedYields.push(yielded);
      if (!opts.json) {
        out(
          `  ${yielded.label}: ${yielded.rowsReturned} row(s), ${yielded.walletsReturned} wallet(s)` +
            (yielded.walletsReturned === 0
              ? yielded.rowsReturned === 0
                ? '  !! INERT — the vendor returned nothing'
                : '  !! INERT — rows arrived but we read no wallet from them; OUR READER IS WRONG'
              : ''),
        );
      }
    }

    const merged = mergeSeeds(seedYields);
    distinctWalletsSeeded = merged.length;

    for (const seed of merged) {
      const isNew = recordSeen(ledger, seed.wallet, seed.seededBy, startedAtIso);
      if (isNew) {
        newlySurfaced += 1;
        for (const label of seed.seededBy) newBySeed.set(label, (newBySeed.get(label) ?? 0) + 1);
      }
      // The pre-filter reads the vendor's trailing counters and can only ever SKIP a request. It
      // never reaches a verdict or an output number — seed.mjs owns that rule and this lane does not
      // relax it.
      const reason = prefilterReason(seed);
      if (reason === null) {
        markWorthARequest(ledger, seed.wallet);
      } else {
        markPrefiltered(ledger, seed.wallet, startedAtIso);
        // Only a wallet the gate could still have spent a request on is a cost of the cadence
        // filter. `markPrefiltered` leaves an already-graded wallet in its graded state, so this
        // check excludes exactly those — in steady state the vendor re-serves the same pages every
        // run, and counting them would report the filter as denying dozens of requests that were
        // never going to be spent.
        if (ledger.wallets[seed.wallet]?.state === 'prefiltered') {
          prefilteredThisRun.push({ wallet: seed.wallet, vendorDeployed: seed.vendorDeployed });
          if (isNew) newPrefiltered += 1;
        }
      }
    }

    // Backlog first, oldest first. A run that always gated the freshest wallets would starve the
    // deferred ones permanently while reporting healthy yield every time.
    const batch = nextGateBatch(ledger, gateBatch);

    if (!opts.json) {
      out('');
      out(
        `TRIAGE — Stage 1 gate on the OWNERSHIP reading (one keyed request each, no RPC walk). ` +
          `Gating ${batch.length} of ${backlogDepth(ledger)} waiting.`,
      );
    }

    for (const wallet of batch) {
      const profile = await client.getJson(`/deployer-hunter/${encodeURIComponent(wallet)}`);
      // Captain decision 451's second arm, on the run's own instant so a wallet's admission does
      // not depend on where in the batch it was gated. The window cap is `stage2_entry`'s because
      // that is the recipe `screen.mjs` will re-judge a queued wallet under — this lane scores
      // nothing itself, so borrowing the screen's cap is what keeps the two arms the same arm.
      const t = triage(profile, gateThresholds, { bounds: subGateAdmissionBounds, nowMs: runStartedMs });
      const graded = gradeWallet(
        ledger,
        wallet,
        {
          state: t.state,
          gateVerdict: t.gateVerdict,
          gateReading: 'ownership-only',
          tokens: t.completion.tokens,
          completionRate: t.completion.rate,
          spanDays: t.completion.spanDays,
          firstDeployIso: t.completion.firstDeployIso,
          shortfalls: t.shortfalls,
        },
        startedAtIso,
      );
      gradedThisRun.push({
        wallet,
        state: t.state,
        gateVerdict: t.gateVerdict,
        rationale: redactVendorIdentifiers(t.rationale),
        tokens: t.completion.tokens,
        completionRate: t.completion.rate,
        spanDays: t.completion.spanDays,
        // Carried so the run-level alarm can tell an unparseable profile from a history that HELD
        // launch records and still could not be judged — two different faults with two different
        // remedies, and the extent of the second is not a third. `ledger.mjs` -> `feedAlarm` owns
        // the distinction.
        criterionUnreadable: t.completion.criterionUnreadable,
        // The stored figure, which is measured from FIRST SIGHT of the wallet. Recomputing it
        // against this run's clock would inflate every backlog wallet's lag by its queue latency.
        lagDaysAtLeast: graded.discoveryLagDaysAtLeast,
        fromBacklog: backlogBefore.has(wallet),
      });
      if (!opts.json) {
        out(
          `  ${wallet}: ${t.state.toUpperCase()} — ${t.completion.completed}/${t.completion.tokens} ` +
            `over ${t.completion.spanDays.toFixed(0)}d` +
            (t.state === 'held' ? ` (NOT a rejection: ${t.shortfalls.join('; ')})` : ''),
        );
      }
    }
  } catch (cause) {
    // Everything learned before the failure is real and paid for. It is persisted, the run is
    // labelled incomplete, and the exit code is non-zero — a partial feed run must never be
    // mistaken for a quiet one.
    completed = false;
    abortReason = cause instanceof Error ? cause.message : String(cause);
    err('');
    err(abortReason);

    const code =
      cause instanceof VendorRefused
        ? exitForRefusal(cause.kind)
        : cause instanceof CeilingReached
          ? EXIT.ceiling
          : EXIT.upstream;

    emit(code);
    return code;
  }

  // The alarm is computed inside `emit`, over the ledger with THIS run's row already appended — so a
  // third consecutive dry run alarms on its own output rather than on the next run's. It is
  // returned rather than recomputed here: two computations of the same condition drift, and the one
  // that drifts is always the one nobody printed.
  const alarm = emit(null);
  return alarm.alarmed ? EXIT.dry : EXIT.ok;

  /**
   * @param {boolean} ranToCompletion Recorded on the row so the dry streak cannot absorb an abort:
   *   a run that died on a 429 surfaced nothing because it stopped, and reading that as saturation
   *   points the operator at discovery breadth when the fault was the credential or the transport.
   * @returns {import('./ledger.mjs').FeedRunRow}
   */
  function thisRunRow(ranToCompletion) {
    return {
      startedAtIso,
      live: true,
      completed: ranToCompletion,
      distinctWalletsSeeded,
      alreadyKnown: distinctWalletsSeeded - newlySurfaced,
      newlySurfaced,
      gated: gradedThisRun.length,
      queued: gradedThisRun.filter((g) => g.state === 'queued').length,
      // Captain decision 451, and its own figure rather than folded into `queued`: the two arms are
      // two populations, and the dry-streak alarm reads these counts.
      queuedSubGate: gradedThisRun.filter((g) => g.state === 'queued-sub-gate').length,
      held: gradedThisRun.filter((g) => g.state === 'held').length,
      unmeasured: gradedThisRun.filter((g) => g.state === 'unmeasured').length,
      prefiltered: prefilteredThisRun.length,
      backlog: backlogDepth(ledger),
      keyedRequests: client.stats().issued,
      inertSeeds: seedYields.filter((s) => s.walletsReturned === 0).map((s) => s.label),
    };
  }

  /**
   * Persist the ledger, assemble the record, render and optionally write.
   *
   * One path for both the completed and the aborted case, so a run that stopped early still updates
   * the memory it paid for. Re-learning those wallets would spend a keyed request twice for one
   * answer.
   *
   * @param {number | null} abortCode The exit code an aborted run is returning, or `null` when the
   *   run completed. Marks the run row incomplete and drives the wording; the decision to abort was
   *   made by the caller.
   * @returns {import('./ledger.mjs').FeedAlarm}
   */
  function emit(abortCode) {
    const row = thisRunRow(abortCode === null);
    appendRun(ledger, row, feedT.runHistoryKept);
    const summary = summariseLedger(ledger);
    const queue = queuedForScreen(ledger);
    const streak = dryStreak(ledger);
    const finalAlarm = feedAlarm({
      seeds: seedYields,
      dryStreak: streak,
      dryStreakAlarm: feedT.dryStreakAlarm,
      gated: row.gated,
      unmeasured: row.unmeasured,
      unmeasuredWithRecords: gradedThisRun.filter(
        (g) => g.state === 'unmeasured' && g.criterionUnreadable > 0,
      ).length,
    });

    saveLedger(resolve(opts.ledger), ledger, new Date().toISOString());

    const lags = gradedThisRun.map((g) => g.lagDaysAtLeast).filter((l) => l !== null);
    const cadenceCounts = prefilteredThisRun.map((p) => p.vendorDeployed).filter((v) => v !== null);

    const record = {
      tool: 'deployer-screen-feed',
      schemaVersion: FEED_RECORD_SCHEMA_VERSION,
      scope:
        'CONTINUOUS DISCOVERY of deployer wallets not previously seen, triaged on the Stage 1 ' +
        'competence gate over the OWNERSHIP reading. It does not score entry, it does not score ' +
        'exit, and a `held` wallet is NOT a rejection — screen.mjs is the authority.',
      thresholdsVersion: T['version'],
      startedAtIso,
      finishedAtIso: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      live: true,
      completed,
      abortReason: abortReason === null ? null : redactVendorIdentifiers(abortReason),
      keyedRequests: client.stats().issued,
      keylessRequests: 0,
      spend: {
        keyedCeiling: client.stats().ceiling,
        keyedRemaining: client.remaining(),
        plannedWorstCaseKeyed: worstCaseKeyed,
        gateBatch,
        assumedRunsPerDay: feedT.runsPerDayAssumed,
        assumedDailyWorstCaseKeyed: worstCaseKeyed * feedT.runsPerDayAssumed,
        dailyAllowance: MADEONSOL_DAILY_REQUESTS,
        endpoints: client.stats().byEndpoint,
      },
      seeds: seedYields.map((s) => ({
        label: s.label,
        path: s.path,
        rowsReturned: s.rowsReturned,
        walletsReturned: s.walletsReturned,
        newWallets: newBySeed.get(s.label) ?? 0,
      })),
      // The feed's own yield, which is the deliverable. Duplicates are reported as loudly as new
      // wallets: a run that surfaced 61 wallets and 0 new ones is a dry run, and a report that led
      // with 61 would read as a busy one.
      yield: {
        distinctWalletsSeeded,
        alreadyKnown: distinctWalletsSeeded - newlySurfaced,
        newlySurfaced,
        newPrefiltered,
        gated: gradedThisRun.length,
        gatedFromBacklog: gradedThisRun.filter((g) => g.fromBacklog).length,
        clearedTheGate: gradedThisRun.filter((g) => g.state === 'queued').length,
        // Captain decision 451. NOT added to `clearedTheGate` — these wallets FAILED the gate and
        // were admitted for measurement anyway, which is a different fact with its own denominator.
        admittedSubGate: gradedThisRun.filter((g) => g.state === 'queued-sub-gate').length,
        held: gradedThisRun.filter((g) => g.state === 'held').length,
        unmeasured: gradedThisRun.filter((g) => g.state === 'unmeasured').length,
        backlog: backlogDepth(ledger),
        knownBefore,
        importedFromRunRecords: imported,
        runRecordsRead: runRecords.length,
      },
      // The lag, and what it is a bound on. See FEED_LIMITATIONS — this measures how late we were
      // to the wallets we found and says nothing about the ones the vendor never profiled.
      discoveryLag: {
        basis:
          'age of the oldest deploy in the vendor profile, measured at FIRST SIGHT of the wallet ' +
          'rather than at grading time — a LOWER BOUND',
        observations: lags.length,
        medianDaysAtLeast: lags.length === 0 ? null : Number(medianOf(lags).toFixed(2)),
        maxDaysAtLeast: lags.length === 0 ? null : Number(Math.max(...lags).toFixed(2)),
      },
      // What the cadence filter cost this run, in wallets and in their trailing counts. The
      // pre-filter is the one place a vendor aggregate is read, and this is what it bought.
      // `skipped` counts only wallets the gate could still have spent a request on: an already
      // graded wallet re-served below the floor was never a candidate, so counting it would make
      // the filter's cost read larger every run without the filter denying anything more.
      cadenceFilter: {
        skipped: prefilteredThisRun.length,
        skippedAndNew: newPrefiltered,
        floor: PREFILTER_MIN_DEPLOYED,
        vendorTrailingDeploys: {
          observations: cadenceCounts.length,
          min: cadenceCounts.length === 0 ? null : Math.min(...cadenceCounts),
          median: cadenceCounts.length === 0 ? null : Number(medianOf(cadenceCounts).toFixed(2)),
          max: cadenceCounts.length === 0 ? null : Math.max(...cadenceCounts),
        },
      },
      dryStreak: streak,
      dryStreakAlarm: feedT.dryStreakAlarm,
      // `unmeasuredConditionArmed` is derived from the same constant the warning and the alarm
      // condition read, so the three cannot disagree. It is in the record because `--json` is the
      // shape a scheduler and any later reader of a saved `--out` record consume, and a text-only
      // warning would leave the hole silent in exactly the place that acts on it: an `alarmed:
      // false` from a batch below the floor is weaker evidence of health than one above it, and
      // nothing else in the record says so.
      alarm: { ...finalAlarm, unmeasuredConditionArmed: gateBatch >= ALL_UNMEASURED_MIN_GATED },
      ledger: summary,
      // The product. Wallet addresses are public on-chain data and ours to keep; nothing per-token
      // survives here, exactly as screen.mjs's own projection guarantees.
      queue: queue.map((e) => ({
        wallet: e.wallet,
        firstSeenIso: e.firstSeenIso,
        gradedAtIso: e.gradedAtIso,
        gateReading: e.gateReading,
        tokens: e.tokens,
        completionRate: e.completionRate,
        spanDays: e.spanDays,
        discoveryLagDaysAtLeast: e.discoveryLagDaysAtLeast,
      })),
      limitations: FEED_LIMITATIONS,
    };

    if (opts.json) out(JSON.stringify(record, null, 2));
    else {
      out('');
      out(renderFeedRun(record));
      out('');
      out(renderLedgerState(ledger));
      if (abortCode !== null) {
        out('');
        out(`RUN STOPPED EARLY — exit ${abortCode}. This is an INCOMPLETE feed run, not a dry one.`);
      }
      out('');
      out(renderLimitations());
    }

    if (opts.out !== null) {
      const target = completed ? resolve(opts.out) : partialOutPath(resolve(opts.out));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      if (!opts.json) {
        out(
          completed
            ? `\nfeed record written to ${opts.out}`
            : `\nINCOMPLETE feed record written to ${partialOutPath(opts.out)}` +
                `\n  (${opts.out} was left untouched)`,
        );
      }
    }

    return finalAlarm;
  }
}

/**
 * The run's yield, rendered so a dry feed cannot be skimmed as a healthy one.
 *
 * The ordering is deliberate: the alarm comes FIRST when there is one, then the new-wallet count,
 * then the duplicates. A report that leads with "61 wallets surfaced" reads as a good day even when
 * every one of them was already known.
 *
 * @param {Record<string, any>} record
 * @returns {string}
 */
export function renderFeedRun(record) {
  /** @type {string[]} */
  const lines = [];
  const bar = '='.repeat(94);

  lines.push(bar);
  lines.push('FEED YIELD');
  lines.push(bar);

  if (record['alarm'].alarmed) {
    lines.push('');
    lines.push('!! THE FEED IS NOT HEALTHY. This run exits non-zero. Do not read it as a quiet day.');
    for (const reason of record['alarm'].reasons) lines.push(`   - ${reason}`);
  }

  // Beside the alarm block, because it says which alarm this configuration cannot raise: an exit 0
  // from a batch below the floor is weaker evidence of health than one above it.
  const disabled = unmeasuredAlarmDisabledWarning(record['spend'].gateBatch);
  if (disabled !== null) {
    lines.push('');
    lines.push(disabled);
  }

  const y = record['yield'];
  lines.push('');
  lines.push(`  NEW wallets this run       ${y.newlySurfaced}${y.newlySurfaced === 0 ? '   << none. This run discovered nothing.' : ''}`);
  lines.push(`  already known (duplicates) ${y.alreadyKnown} of ${y.distinctWalletsSeeded} surfaced`);
  lines.push(`  gated this run             ${y.gated} (${y.gatedFromBacklog} from the backlog)`);
  lines.push(`    cleared the gate         ${y.clearedTheGate}  -> queued for the beatability screen`);
  lines.push(`    held (NOT a rejection)   ${y.held}`);
  lines.push(`    unmeasured               ${y.unmeasured}`);
  lines.push(`  still waiting to be gated  ${y.backlog}`);
  lines.push(`  dry streak                 ${record['dryStreak']} live run(s) with no new wallet (alarm at ${record['dryStreakAlarm']})`);

  lines.push('');
  lines.push('  PER SEED — rows, wallets, and how many of those wallets were NEW. Rows present with');
  lines.push('  wallets zero means OUR READER is wrong, not that the vendor is empty. A wallet two');
  lines.push('  seeds both surfaced counts as new under BOTH, so these do not sum to the figure above.');
  for (const s of record['seeds']) {
    lines.push(
      `    ${String(s.label).padEnd(34)} ${String(s.rowsReturned).padStart(4)} row(s)  ` +
        `${String(s.walletsReturned).padStart(4)} wallet(s)  ${String(s.newWallets).padStart(4)} new` +
        (s.walletsReturned === 0 ? '   !! INERT' : ''),
    );
  }

  const lag = record['discoveryLag'];
  lines.push('');
  lines.push('  DISCOVERY LAG — how long these wallets had ALREADY been deploying before we saw them.');
  lines.push(
    lag.observations === 0
      ? '    no observation this run (nothing was graded, or no usable deploy time came back)'
      : `    median >= ${lag.medianDaysAtLeast} days, max >= ${lag.maxDaysAtLeast} days, over ${lag.observations} wallet(s)`,
  );
  lines.push('    A LOWER BOUND, and only for wallets the vendor profiled at all. It does not bound');
  lines.push('    the lag on deployers this vendor has never tracked — those are invisible here.');

  const cad = record['cadenceFilter'];
  lines.push('');
  lines.push('  CADENCE FILTER — wallets skipped before a request was spent, on the vendor\'s trailing');
  lines.push('  ~7.5-day deploy count. A slow-but-steady deployer lands here. Counts only wallets still');
  lines.push('  awaiting the gate: one already graded is re-served every run and was never a candidate.');
  lines.push(
    `    ${cad.skipped} skipped (${cad.skippedAndNew} of them new)` +
      (cad.vendorTrailingDeploys.observations === 0
        ? ''
        : `; their trailing counts min ${cad.vendorTrailingDeploys.min}, median ` +
          `${cad.vendorTrailingDeploys.median}, max ${cad.vendorTrailingDeploys.max}`),
  );

  lines.push('');
  lines.push(
    `  SPEND  ${record['keyedRequests']} keyed request(s) of a ${record['spend'].keyedCeiling} per-run ceiling; ` +
      `0 keyless. Assumed daily worst case ` +
      `${record['spend'].assumedDailyWorstCaseKeyed} of the ` +
      `${record['spend'].dailyAllowance.toLocaleString('en-US')}/day allowance ` +
      `(${((record['spend'].assumedDailyWorstCaseKeyed / record['spend'].dailyAllowance) * 100).toFixed(3)}%, ` +
      `Ultra and exclusive to this lane).`,
  );

  const queue = record['queue'];
  lines.push('');
  lines.push(`  THE QUEUE — ${queue.length} wallet(s) that cleared the gate and have NOT been screened.`);
  if (queue.length === 0) {
    lines.push('    (empty)');
  } else {
    for (const q of queue.slice(0, 20)) {
      lines.push(
        `    ${q.wallet}  ${q.tokens === null ? '?' : q.tokens} launches, ` +
          `${q.completionRate === null ? '?' : (q.completionRate * 100).toFixed(1)}% over ` +
          `${q.spanDays === null ? '?' : q.spanDays.toFixed(0)}d` +
          (q.discoveryLagDaysAtLeast === null ? '' : `, first seen >= ${q.discoveryLagDaysAtLeast}d after it started`),
      );
    }
    if (queue.length > 20) lines.push(`    ... and ${queue.length - 20} more (see the record, or --json)`);
    lines.push('');
    lines.push('    Next step is screen.mjs, which re-reads these on the CREATION-DERIVED history and');
    lines.push('    scores entry. Clearing this gate is not a recommendation.');
  }

  return lines.join('\n');
}

/**
 * The standing state of the ledger, printed on every run including a dry one.
 *
 * `held on the ownership reading` and `near-miss` are here rather than in a document because they
 * are the running cost of grading cheaply: wallets this lane set aside on a reading that rejects
 * through the count bars while inflating through the rate. A number that appears every run gets
 * acted on; a caveat in a README does not.
 *
 * @param {import('./ledger.mjs').Ledger} ledger
 * @returns {string}
 */
export function renderLedgerState(ledger) {
  const s = summariseLedger(ledger);
  return [
    '  LEDGER — everything this project has seen. A wallet here is never offered as new again.',
    `    ${s.wallets} wallet(s): ${s.queued} queued, ${s.queuedSubGate} queued SUB-GATE, ` +
      `${s.held} held, ${s.unmeasured} unmeasured, ` +
      `${s.prefiltered} pre-filtered, ${s.deferred} awaiting the gate`,
    `    ${s.queuedUnscreened} cleared the gate and have not been through the beatability screen`,
    // Captain decision 451, on its OWN line with its OWN denominator. Adding it to the line above
    // would be the one thing that decision forbids: two populations through one number.
    `    ${s.queuedSubGateUnscreened} FAILED the gate and are queued anyway by the sub-gate arm ` +
      `(captain decision 451) — a separate population, never pooled with the line above`,
    `    ${s.heldOnOwnershipReading} held on the OWNERSHIP reading, which rejects through the counts and inflates the rate — of those,`,
    `    ${s.heldNearMiss} missed on exactly ONE gate leg — the plausible false negatives.`,
    '    They are NOT re-polled: a competent dev does not reopen a window, so re-checking them is',
    '    the graveyard. Re-reading one on the creation-derived history is a screen.mjs run and a',
    '    deliberate decision, not a schedule.',
    s.lagObservations === 0
      ? '    DISCOVERY LAG: no observation yet.'
      : `    DISCOVERY LAG, whole ledger: a wallet here had already been deploying for a median of ` +
        `>= ${s.lagMedianDaysAtLeast} days`,
    s.lagObservations === 0
      ? ''
      : `    (max >= ${s.lagMaxDaysAtLeast}, n = ${s.lagObservations}) before this project first saw it. ` +
        `We are late by construction.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** @returns {string} */
function renderLimitations() {
  /** @type {string[]} */
  const lines = ['  WHAT THIS FEED CANNOT SEE'];
  for (const limitation of FEED_LIMITATIONS) {
    const wrapped = wrap(limitation, 90);
    lines.push(`   · ${wrapped[0] ?? ''}`);
    for (const rest of wrapped.slice(1)) lines.push(`     ${rest}`);
  }
  return lines.join('\n');
}

/**
 * Wrap prose to a width, on spaces.
 *
 * The limitation block is the part of this output most likely to be read on a narrow terminal and
 * least likely to be read at all. A five-line paragraph running off the right edge is a caveat
 * nobody reads, which for this particular block would defeat its entire purpose.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrap(text, width) {
  /** @type {string[]} */
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// --- entry point ---------------------------------------------------------------------------
// `import.meta.main` is not available on the Node 20 floor, so compare argv[1] instead.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const parsed = parseFeedArgs(process.argv.slice(2));
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
