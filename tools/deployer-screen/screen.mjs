#!/usr/bin/env node
/**
 * deployer-screen — a rerunnable competence GATE plus an ENTRY score, over MadeOnSol's free
 * Deployer Hunter endpoints and pump.fun's keyless fill tape. No agent required:
 * `node tools/deployer-screen/screen.mjs --help`.
 *
 * **This tool gates and scores ENTRY. It does not recommend, and it does not score EXIT.** See
 * README.md for the scope statement and `thresholds.json` → `stage2_entry`.
 *
 * Exit codes are distinct on purpose, because the worst failure mode for a screen is an empty
 * result that looks like a real negative:
 *
 *   0  ran to completion. A ranking was produced, possibly with zero survivors — which is a
 *      measured outcome and is labelled as one.
 *   2  usage error.
 *   3  credential missing or malformed.
 *   4  credential rejected (401/403) — expiry is the likeliest cause, though UNVERIFIED on Ultra.
 *   5  quota exhausted or rate-limited (429).
 *   6  a request ceiling was reached before the run completed.
 *   7  upstream or transport failure, INCLUDING a 400 the vendor's own validator rejected. A
 *      malformed query is our bug, not the operator's credential, and it must never send someone to
 *      rotate a key that is working.
 *   8  Stage 0 validation failed — the screen no longer reproduces what we already know.
 *
 * A run that stops early still writes its record and `--json` still prints it, flagged
 * `completed: false`, with the non-zero exit preserved. Throwing away fifteen paid-for measurements
 * because the sixteenth request hit the ceiling just spends the shared allowance twice. But it is
 * written to `<--out>.partial.json`, never to the requested path: a same-day retry that dies on a
 * 401 must not overwrite that day's good record with an empty one.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BoundedClient,
  CeilingReached,
  DuneClient,
  VendorRefused,
  describeAllowanceDecision,
  localCreditEstimate,
} from './client.mjs';
import { coveredBoundMs, mergeHistories } from './creation.mjs';
import {
  DUNE_KEY_ENV_VAR,
  HELIUS_KEY_ENV_VAR,
  KEY_ENV_VAR,
  resolveDuneCredential,
  resolveKey,
  resolveSolanaRpcEndpoint,
} from './credential.mjs';
import { checkDuneAllowance, coverageRecordRow, enumerateCreations } from './dune.mjs';
import { measureCompletion, toTokenRecords } from './measure.mjs';
import { buildPredictionBlock, summarisePredictions } from './prediction.mjs';
import {
  RECORD_SCHEMA_VERSION,
  deriveTruncation,
  describeUnmeasured,
  readPredictions,
  redactAll,
  redactCreationNotes,
  redactVendorIdentifiers,
  unmeasuredBecause,
  unmeasuredNoSource,
} from './record.mjs';
import {
  KeylessClient,
  RpcCredentialRejected,
  SolanaRpcClient,
  readCreatedHistory,
  readCreatedHistoryIndexed,
  readCreatorHistory,
} from './pumpfun.mjs';
import { rpcCostSource } from './rpc-costs.mjs';
import { assertMinAgeUsable } from './fill-source.mjs';
import { freeConstruction, planEligibility, registrationOf } from './plan-source.mjs';
import { swapApiFillSource } from './swapapi-fills.mjs';
import { applyGate, measureConsistency, rankCandidates, verdictFor } from './rank.mjs';
import { renderDryRun, renderMayhemShare, renderStage0, renderStage1, LIMITATIONS } from './render.mjs';
import {
  addDropReasons,
  emptyDropReasons,
  entryFillBounds,
  scoreCandidateEntry,
  toEntryRecordRow,
  totalDrops,
} from './stage2.mjs';
import {
  buildSeedPlan,
  mergeSeeds,
  prefilterReason,
  readSeedResponse,
  summariseCoverage,
} from './seed.mjs';
import { SUBJECT_DEPLOYER, VENDOR_READINGS, runStage0 } from './stage0.mjs';

/**
 * Pages of the ownership listing read per candidate for the merge.
 *
 * 70 rows a page, so 4 pages is 280 — already four times the 70 the vendor's own surface caps at,
 * and it bounds the keyless spend at 4 requests per candidate rather than the ~1,050-result server
 * ceiling. `readCreatorHistory` reports when the cap bit and the record carries it as
 * `listingPageCapped`.
 *
 * **THE 4 ITSELF IS AN UNMEASURED OPERATIONAL BOUND**, and it is stated rather than dressed up: the
 * ratio above says 280 is generous next to the vendor profile it is merged with, not that a deployer
 * needs 280 rows. Nothing committed here measures how deep the listing must be read before the merge
 * stops changing — **neither committed run can answer it**, because both graded on the ownership
 * reading and so record `vendorPageCapped` (the vendor's own 70-record profile cap, which bit for 6
 * of 65 and 4 of 12) and never `listingPageCapped`. What would justify a value: one creation-derived
 * run recording, per candidate, the page at which the merged launch count stops moving. Until that
 * exists this is a spend ceiling chosen for the keyless plan it has to fit — 195 x 4 = 780 of
 * `budget.maxKeylessRequests`, which a test pins — and the failure it can cause is disclosed rather
 * than silent, since a truncated listing is reported on the candidate.
 */
const LISTING_PAGES_FOR_MERGE = 4;

/**
 * How often the creation walk prints a liveness line, in RPC requests.
 *
 * The other three clients print one line per request, and that is right for them: they issue tens
 * of requests over a run. This one issues up to 100 per candidate across up to 195 candidates, so
 * the same treatment would bury the report under ~20,000 lines. Silence is the worse failure
 * though — this is the leg that dominates the wall clock, and an operator watching a still terminal
 * kills a healthy run. So: every 10th request, which at the pinned 2.5s pacing is a line about
 * every 25 seconds, plus the first request of each candidate so a walk is seen to start at all.
 */
const RPC_HEARTBEAT_EVERY = 10;

/**
 * Which fill source Stage 2 runs on. **`swap-api`, and the cutover is not this lane's.**
 *
 * Captain decision 260a built the source-agnostic provider so that a Dune fill source *can* reach
 * Stage 2 by injection. The captain's programme cuts over at **Gate 3**, which has not been
 * convened, so this run reads pump.fun's keyless trade endpoint exactly as it did before the
 * provider existed. A committed Dune path that nothing routes through is the correct resting state,
 * not an unfinished one — the same posture captain decision 258b states for its committed SQL.
 *
 * @type {import('./fill-source.mjs').FillSourceKind}
 */
export const ENTRY_FILL_SOURCE_KIND = 'swap-api';

/**
 * Choose the fill source, from constructors the caller supplies.
 *
 * **It refuses rather than falls back**, and that is the whole reason it is a function. A selector
 * that quietly used the swap-api when asked for a source it had no constructor for is how a cutover
 * reports itself done while nothing moved: every number would be a swap-api number, every record
 * would say the run succeeded, and the only evidence would be an absence. This repo has the same
 * shape on the record twice already — a guard denominated in the variable that did not move, and a
 * `0` sentinel read as a 56-year window.
 *
 * The constructors are thunks so that a source is only built when it is selected. Building the
 * unselected one would be harmless today and would stop being harmless the moment a source's
 * constructor spends something to find out what it can vouch for.
 *
 * **A constructor may itself refuse, and that refusal surfaces HERE rather than as a measurement.**
 * A source that cannot answer eligibility — the Dune route with no readable watermark — throws from
 * its own constructor, so this site is where "we cannot run Stage 2 on the source we were asked
 * for" is stated. The alternative is a source that exists and answers `Infinity`, which travels: it
 * is persisted as `entry.coverage.minAgeMs`, where `JSON.stringify` writes it as `null`, and
 * rendered as a duration. `fill-source.mjs` → `assertMinAgeUsable` is the backstop that fails on a
 * future source which forgets this.
 *
 * **SELECTION AND CONSTRUCTION ARE TWO STEPS NOW** (captain decision 286c). {@link
 * resolveEntryFillSource} does the choosing and touches nothing; this function is that plus the
 * `build()` the RUN path always wants. The split exists because the PLAN path must be able to
 * resolve a source — to name it, and to say what asking it would cost — without building one, since
 * building the Dune source needs a billed coverage probe. Nothing about the run path moved.
 *
 * @param {import('./fill-source.mjs').FillSourceKind} kind
 * @param {FillSourceRegistry} sources
 * @returns {import('./fill-source.mjs').FillSource}
 */
export function selectEntryFillSource(kind, sources) {
  return resolveEntryFillSource(kind, sources).build();
}

/**
 * Every entry source this run could be asked for, and — where the registrar said — what building
 * each one costs.
 *
 * A bare thunk is still accepted and still means "build it this way"; it declares nothing about
 * cost, and `plan-source.mjs` → {@link registrationOf} treats an absent declaration as UNDECLARED
 * rather than as free. That is the fail-safe direction: the run path builds either way, and the plan
 * path refuses to find out by spending.
 *
 * @typedef {Partial<Record<import('./fill-source.mjs').FillSourceKind,
 *   import('./plan-source.mjs').FillSourceRegistration
 *     | (() => import('./fill-source.mjs').FillSource)>>} FillSourceRegistry
 */

/**
 * CHOOSE the fill source without building it. **This resolves with no network call, ever.**
 *
 * It is the half of {@link selectEntryFillSource} the dry run may use: a plan has to know which
 * source it is describing, and it must not construct one to find out. The refusal is unchanged and
 * lives here, because refusing a kind this run has no constructor for is a property of the CHOICE
 * rather than of the construction.
 *
 * @param {import('./fill-source.mjs').FillSourceKind} kind
 * @param {FillSourceRegistry} sources
 * @returns {import('./plan-source.mjs').FillSourceRegistration}
 */
export function resolveEntryFillSource(kind, sources) {
  const entry = sources[kind];
  if (entry === undefined) {
    throw new Error(
      `Stage 2 was asked for a ${kind} fill source and this run carries no constructor for one. ` +
        `It refuses rather than substituting another source: a run that silently measured on a ` +
        `different vendor than it was asked to would report itself complete and be wrong in the ` +
        `one direction nothing observes.`,
    );
  }
  const registration = registrationOf(kind, entry);
  if (registration.construction.kind !== kind) {
    throw new Error(
      `Stage 2 was asked for a ${kind} fill source and this run's registration declares itself ` +
        `${registration.construction.kind}. It refuses rather than resolving one: a plan LABELS ` +
        `every figure it prints with this kind — which page distribution, which shed rate, which ` +
        `pacing justification and which cursor geometry describe the walk — so a declaration that ` +
        `disagrees with its key would mislabel every one of them, which is standing ruling 285a's ` +
        `defect arriving through the label itself, the one route the labelling cannot catch.`,
    );
  }
  return registration;
}

/**
 * What building the swap-api fill source costs: nothing, and this is where that is declared.
 *
 * It is stated rather than assumed because the plan path reads declarations, not implementations —
 * see `plan-source.mjs`. The claim is checkable in one line: the source is built from a
 * `KeylessClient` that has already been constructed, and its eligibility answer is its own cursor
 * reach, which is arithmetic over pinned thresholds. No socket, no allowance, no credential.
 *
 * **EXPORTED SO THE CENSUS'S COPY CANNOT DRIFT FROM IT** (captain decision 290b). `bundling.mjs`
 * declares the same construction for the same source and may not import this module — that would put
 * the Dune client and the credential reader in the census's import graph, and captain decision 173a's
 * "spends zero keyed requests" is a property of the tree. A test imports both and fails the build if
 * the two ever differ, which is the only place that comparison can live.
 */
export const SWAP_API_CONSTRUCTION = freeConstruction(
  'swap-api',
  'it is built from a keyless client and answers eligibility from its own cursor reach, so no ' +
    'request, credit or credential is involved in building it or in asking it.',
);

/**
 * The flag that authorises a dry run to build a billed source, named once so the plan's own
 * unavailable line can tell an operator what to do next rather than describing a capability without
 * saying how to reach it.
 */
const DRY_RUN_SPEND_FLAG = '--dry-run-spend';

/**
 * THE PLAN'S ELIGIBILITY ANSWER: resolve the source, and ask it only where that is free or the
 * operator has authorised the purchase.
 *
 * It exists as a named function rather than four lines inside `main` because it is the seam captain
 * decision 286c has to be testable at: the registry is what a test substitutes, and a stub whose
 * constructor throws is what proves the default path never builds a billed source. A test driving
 * `planEligibility` alone would prove the helper works and say nothing about whether `screen.mjs`
 * routes through it.
 *
 * @param {import('./fill-source.mjs').FillSourceKind} kind
 * @param {FillSourceRegistry} sources
 * @param {object} opts
 * @param {import('./fill-source.mjs').FillSourceBounds} opts.bounds
 * @param {boolean} opts.spendAuthorised
 * @param {(line: string) => void} opts.announce
 * @returns {Promise<import('./plan-source.mjs').PlanEligibility>}
 */
export async function planEntryEligibility(kind, sources, opts) {
  return planEligibility({
    registration: resolveEntryFillSource(kind, sources),
    bounds: opts.bounds,
    spendAuthorised: opts.spendAuthorised,
    authorisedBy: DRY_RUN_SPEND_FLAG,
    announce: opts.announce,
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_DATA_DIR = join(REPO_ROOT, 'data', 'population-tape-2026-07-29');

const EXIT = {
  ok: 0,
  usage: 2,
  credentialMissing: 3,
  credentialRejected: 4,
  quota: 5,
  ceiling: 6,
  upstream: 7,
  stage0: 8,
};

const USAGE = `deployer-screen — competence gate + ENTRY score for pump.fun deployers

  node tools/deployer-screen/screen.mjs [options]

MODES
  --stage0            Run only the local validation. No network, no key, no quota. Always safe.
  --dry-run           Print exactly what a real run would fetch, and fetch nothing. FREE, and it
                      ALWAYS prints the plan: a figure that could only be had by BUILDING a fill
                      source whose construction is billed is printed as UNAVAILABLE, naming the
                      source and the reason, never thrown and never quietly replaced by another
                      source's number.
  --dry-run-spend     With --dry-run only. Authorise the plan to BUILD a billed fill source so it
                      can state those figures. It prints the BOUNDED spend before spending and the
                      ACTUAL after. Today's selected source is free to build, so this authorises a
                      purchase there is nothing to make; it exists for the Gate 3 cutover.
  (default)           Stage 0, then Stage 1 (enumerate + gate), then Stage 2 (score entry room and
                      the field, keyless). Stage 0 must pass first.

OPTIONS
  --candidates <n>    Max deployers to gate. DEFAULT: as many as the request ceiling allows, so a
                      default run grades everything enumeration surfaces. Ceiling from
                      thresholds.json; this flag can only lower it.
  --max-requests <n>  Hard keyed-request ceiling. Cannot exceed the pinned budget, which is the
                      PLAN's one-retry worst case rather than a daily allowance (captain decision
                      267a — the MadeOnSol key is Ultra at 100,000/day, so the allowance stopped
                      being what binds). A plan whose worst case does not fit under the ceiling is
                      refused before the first request (exit 2).
  --tier <t>          Enumerate ONE tier: elite|good|moderate|rising|cold. The default is TIERED
                      already — the pinned tier set in seed.mjs -> DEFAULT_TIERS, 'good' + 'elite'
                      (captain decision 262a). This NARROWS that to one tier; it does not turn
                      tiering on, and the dry-run plan prints the exact enumeration cost.
  --no-stage2         Skip entry scoring. Stage 1 only — the competence gate on its own, which
                      answers nothing about whether a window is enterable.
  --score <n>         Max gate survivors to score in Stage 2. Cannot exceed the pinned cap.
  --consistency       Also measure long-horizon consistency for gate survivors, via a keyless
                      pump.fun creator walk. Costs no MadeOnSol quota.
  --ownership-only    Gate on the OWNERSHIP reading alone and skip the creation-derived walk.
                      Fast and free of Solana RPC, and BIASED BOTH WAYS AT ONCE — it rejects
                      through the count bars (20 of 82 clear minTokens+minSpanDays on the
                      vendor page against 66 of 82 on the creation-derived reading) and
                      inflates through the rate (higher on 37 of 81 wallets, lower on 29,
                      median difference 0.0000, by up to +0.6929). See below.
                      The record is stamped historySource: "ownership-only" so a run made this
                      way can never be mistaken for a creation-derived one.
  --no-dune           Skip the Dune creation enumeration and take the Solana RPC walk instead.
                      Same measurement, slower, and the record records which surface answered.
  --dune-refresh-probe
                      Re-EXECUTE Dune's coverage probe rather than reading its cached result.
                      Costs one billed execution; the default cached read costs none.
  --predict <path>    Read a predictions document and carry it VERBATIM in the run record, so the
                      grading lane has an input rather than a plan. Validated for shape BEFORE the
                      first request — an unreadable document refuses the run (exit 2) rather than
                      being discovered after the keyed allowance is gone. Nothing here is evaluated
                      by this tool: it records what was predicted and measures what happened, and
                      scoring one against the other belongs to the lane that grades. See
                      record.mjs -> readPredictions for the shape and what each field must say.
  --out <path>        Write the run record as JSON. Default: nothing is written. An INCOMPLETE run
                      writes <path>.partial.json instead, leaving <path> untouched.
  --json              Print the run record as JSON instead of text.
  --data-dir <path>   Population tape location. Default data/population-tape-2026-07-29.
  --help              This text.

WHICH HISTORY THE GATE READS
  By default the gate reads a CREATION-DERIVED history: which tokens this wallet CREATED. Since
  captain decision 156a the PRIMARY surface for that is Dune's decoded pump.fun creation events
  (thresholds.json -> dune), which answers a whole candidate batch in one query. The Solana RPC
  walk over create transactions is the FALLBACK, taken when there is no ${DUNE_KEY_ENV_VAR}, when
  Dune fails, or when its coverage probe refuses a reading; it is bounded by thresholds.json ->
  creation_walk (keyless) or creation_walk_helius (with ${HELIUS_KEY_ENV_VAR} set).

  EVERY DUNE-DERIVED COUNT SHIPS WITH ITS OWN COVERAGE PROBE, and a count that reaches outside the
  probed coverage is refused rather than published. Decoded tables have silent start dates: they
  return a confident, complete-looking answer that is simply wrong before their first row.

  Helius is NOT demoted for transaction-level work. Stage 2's entry-cost leg reads meta.fee and
  pre/post balances per transaction, which no decoded table serves.

  The alternative, which every vendor surface answers, is which tokens the wallet OWNS NOW. On
  pump.fun the owner collects the token's creator fees, so ownership is a live position that can be
  sold or handed on -- and the ones worth handing on are the winners. That reading understates a
  dev's launches, understates its bonded count by MORE, and so scores the better dev worse. A dev
  that creates 20, bonds 9 and hands on 3 winners reads 17/6 = 35% instead of 45%; a gate at 40%
  rejects it, and a false rejection is invisible.

  The walk covers a bounded window backwards from now. Outside that window there is nothing but the
  ownership listing, so those rows are carried over unchanged and counted in the record. Every
  candidate row carries both readings and the verdict each one would have produced.

CREDENTIAL
  Reads ${KEY_ENV_VAR} from the environment. Never printed, never logged, never written to disk,
  and never stored in this repository. Free-tier keys expired every 30 days and WHETHER THAT HOLDS
  ON ULTRA IS UNVERIFIED; either way a rejected key exits 4 with a specific message rather than an
  empty result.

      export ${KEY_ENV_VAR}="$(your-secret-manager read madeonsol)"
      # or, from a dotenv file kept OUTSIDE this repo:
      set -a; . /path/to/.env; set +a

EXIT CODES
  0 ok (possibly zero survivors — a measured outcome)   2 usage   3 no credential
  4 credential rejected (401/403)   5 quota (429)   6 ceiling reached
  7 upstream — transport, 5xx, or a 400 our query shape earned. NOT a credential problem.
  8 stage 0 failed

A run that stops early still records what it paid for and still exits non-zero, but it is labelled
an incomplete run — never as a measured negative — and it is written to <--out>.partial.json so a
failed retry cannot destroy a good record.
`;

/**
 * @param {readonly string[]} argv
 * @returns {{ ok: true, opts: Options } | { ok: false, message: string }}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const opts = {
    stage0Only: false,
    dryRun: false,
    dryRunSpend: false,
    candidates: null,
    maxRequests: null,
    tier: undefined,
    // Stage 2 is ON by default. The tool exists to answer whether a window can be entered, and a
    // build that shipped the entry score off by default would make the answerable question the
    // opt-in and the unanswerable one the headline.
    stage2: true,
    scoreCandidates: null,
    consistency: false,
    ownershipOnly: false,
    noDune: false,
    duneRefreshProbe: false,
    predict: null,
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
      case '--stage0':
        opts.stage0Only = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--dry-run-spend':
        opts.dryRunSpend = true;
        break;
      case '--consistency':
        opts.consistency = true;
        break;
      case '--no-stage2':
        opts.stage2 = false;
        break;
      case '--score': {
        const v = next();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isInteger(n) || n < 1) return { ok: false, message: '--score needs a positive integer' };
        opts.scoreCandidates = n;
        break;
      }
      case '--ownership-only':
        opts.ownershipOnly = true;
        break;
      case '--no-dune':
        opts.noDune = true;
        break;
      case '--dune-refresh-probe':
        opts.duneRefreshProbe = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--candidates': {
        const v = next();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isInteger(n) || n < 1) return { ok: false, message: '--candidates needs a positive integer' };
        opts.candidates = n;
        break;
      }
      case '--max-requests': {
        const v = next();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isInteger(n) || n < 1) return { ok: false, message: '--max-requests needs a positive integer' };
        opts.maxRequests = n;
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
      case '--predict': {
        const v = next();
        if (v === null) return { ok: false, message: '--predict needs a path' };
        opts.predict = v;
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

  // **The opt-in only opts into something inside a dry run.** Outside one it would read as an
  // authorisation the run never asked for and never consults, and a flag that is silently inert is
  // how an operator comes to believe they authorised something they did not. Captain decision 286c.
  if (opts.dryRunSpend && !opts.dryRun) {
    return { ok: false, message: '--dry-run-spend only means anything with --dry-run' };
  }

  return { ok: true, opts };
}

/**
 * @typedef {object} Options
 * @property {boolean} stage0Only
 * @property {boolean} dryRun
 * @property {boolean} dryRunSpend Authorise the DRY RUN to build a fill source whose construction is
 *   billed, so the plan can state the figures only that construction can answer. Captain decision
 *   286c: without it a dry run is free and prints those figures as UNAVAILABLE with the reason; with
 *   it the bound is stated before the spend and the actual after. Requires `--dry-run`.
 * @property {number | null} candidates
 * @property {number | null} maxRequests
 * @property {string | undefined} tier
 * @property {boolean} stage2
 * @property {number | null} scoreCandidates
 * @property {boolean} consistency
 * @property {boolean} ownershipOnly
 * @property {boolean} noDune Skip the Dune creation enumeration and take the Solana RPC walk, which
 *   is what every run before captain decision 156a did. The record still says which surface answered.
 * @property {boolean} duneRefreshProbe Re-EXECUTE the coverage probe instead of reading Dune's
 *   cached result for it. An execution is billed; the cached read is not.
 * @property {string | null} predict Path to a predictions document, carried verbatim in the record.
 *   Read and shape-checked before the first request; see `record.mjs` → `readPredictions`.
 * @property {string | null} out
 * @property {boolean} json
 * @property {string} dataDir
 * @property {boolean} help
 */

/**
 * Map a vendor refusal onto an exit code.
 *
 * The mapping is the whole point of having distinct codes, and one case is easy to get wrong: an
 * **HTTP 400 is our query shape, not their verdict on the credential.** Reporting it as
 * `credentialRejected` tells an operator to rotate a key that is working perfectly, which on a
 * vendor whose keys may expire is a plausible and entirely wasted afternoon. It is an upstream
 * failure, because the thing that failed is upstream of the key.
 *
 * @param {import('./credential.mjs').AuthFailureKind} kind
 * @returns {number}
 */
export function exitForRefusal(kind) {
  switch (kind) {
    case 'quota-exhausted':
      return EXIT.quota;
    case 'malformed-request':
      return EXIT.upstream;
    case 'expired-or-revoked':
    case 'wrong-tier':
      return EXIT.credentialRejected;
    default:
      return EXIT.upstream;
  }
}

/** @returns {Record<string, any>} */
export function loadThresholds() {
  return JSON.parse(readFileSync(join(HERE, 'thresholds.json'), 'utf8'));
}

/**
 * @param {Options} opts
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} out
 * @param {(line: string) => void} err
 * @returns {Promise<number>} Process exit code.
 */
export async function main(opts, env, out, err) {
  if (opts.help) {
    out(USAGE);
    return EXIT.ok;
  }

  const T = loadThresholds();
  const gateThresholds = {
    minTokens: T['stage1_gate'].minTokens,
    minCompletionRate: T['stage1_gate'].minCompletionRate,
    minSpanDays: T['stage1_gate'].minSpanDays,
  };
  const budget = T['budget'];
  /** @type {import('./stage2.mjs').Stage2Thresholds} */
  const entryThresholds = { ...T['stage2_entry'] };
  /** @type {{ maxRpcRequestsPerCandidate: number, rpcMinIntervalMs: number, preferBlockRoute: boolean }} */
  const costBounds = T['stage2_cost'];
  // The scoring cap can be lowered from the command line and never raised. Same rule as the
  // candidate cap: a pinned bound that a flag can widen is not a bound.
  const maxScored = Math.min(opts.scoreCandidates ?? entryThresholds.maxCandidatesScored, entryThresholds.maxCandidatesScored);

  /** @type {'creation-derived' | 'ownership-only'} */
  const historySource = opts.ownershipOnly ? 'ownership-only' : 'creation-derived';

  // ---- The predictions this run is being made to test, if any ----------------------------
  // Read and shape-checked HERE — before Stage 0, before the plan, before any ceiling — because
  // the failure it prevents is specific: a run that discovers its predictions were unreadable
  // after spending the keyed allowance has to spend it again to get them back, and the whole
  // point of recording a prediction is that it exists before the answer does. Nothing in this
  // document is evaluated; `record.mjs` -> readPredictions says why.
  /** @type {Record<string, unknown> | null} */
  let declaredPredictions = null;
  if (opts.predict !== null) {
    /** @type {string} */
    let text;
    try {
      text = readFileSync(opts.predict, 'utf8');
    } catch (cause) {
      err(`--predict: could not read ${opts.predict}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return EXIT.usage;
    }
    const parsed = readPredictions(text, opts.predict);
    if (!parsed.ok) {
      err(`--predict: ${parsed.message}`);
      return EXIT.usage;
    }
    declaredPredictions = parsed.predictions;
  }

  // ---- Stage 0. Always runs. Nothing keyed happens until it has passed. -------------------
  /** @type {import('./stage0.mjs').Stage0Result} */
  let stage0;
  try {
    stage0 = runStage0(opts.dataDir, gateThresholds, entryThresholds);
  } catch (cause) {
    err(`Stage 0 could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
    err(`  Is --data-dir correct? Tried: ${opts.dataDir}`);
    return EXIT.stage0;
  }

  if (!opts.json) out(renderStage0(stage0, VENDOR_READINGS));

  if (!stage0.passed) {
    err('');
    err('Refusing to spend quota: Stage 0 failed, so the screen no longer reproduces the answers');
    err('we already hold. Fix the drift before pointing it at strangers.');
    return EXIT.stage0;
  }

  if (opts.stage0Only) {
    if (opts.json) out(JSON.stringify({ stage0: summariseStage0(stage0), limitations: LIMITATIONS }, null, 2));
    return EXIT.ok;
  }

  // ---- Plan ------------------------------------------------------------------------------
  // The pinned bounds are RE-DERIVED for the Ultra tier (captain decision 267a): the keyed ceiling
  // is the plan's one-retry worst case, not a daily allowance, and the candidate cap is the largest
  // the pinned keyless ceiling admits. Both are hard: `--candidates` and `--max-requests` can only
  // ever lower them.
  const maxKeyed = Math.min(opts.maxRequests ?? budget.maxKeyedRequests, budget.maxKeyedRequests);
  // The plan is built FIRST so the enumeration cost is the plan's own length rather than a literal
  // that happens to match it. A fourth enumeration query would otherwise leave a no-flag invocation
  // deriving a candidate cap the refusal check three lines down then rejects. The page `limit` is
  // bounded by what could possibly be gated — the explicit `--candidates` if there is one, and
  // otherwise the request ceiling — so it never depends on the cap this plan is about to size.
  const seedPlan = buildSeedPlan({
    limit: Math.min(50, Math.max(opts.candidates ?? maxKeyed, 10)),
    ...(opts.tier === undefined ? {} : { tier: opts.tier }),
  });
  const enumerationCost = seedPlan.length;
  // **The default grades what enumeration surfaces, up to the budget.** The committed elite run
  // seeded 22 wallets and graded 12 because it was invoked with a number smaller than the ceiling
  // already allowed; ten wallets were dropped by a flag rather than by any judgement. So an
  // unstated candidate cap now follows the request ceiling instead of being a separate small
  // number a conservative invocation can silently pin.
  const maxCandidates = Math.min(
    opts.candidates ?? Math.max(1, maxKeyed - enumerationCost),
    budget.maxCandidates,
  );

  // **Over budget fails BEFORE spending.** A plan whose worst case cannot fit under the ceiling
  // would otherwise run until the ceiling bit and then report an incomplete screen — paying for
  // most of a run to learn something arithmetic could have said for free.
  const worstCaseKeyed = seedPlan.length + maxCandidates;
  if (worstCaseKeyed > maxKeyed) {
    err(
      `Refusing to start: the plan's worst case is ${seedPlan.length} enumeration + ${maxCandidates} ` +
        `candidate = ${worstCaseKeyed} keyed requests, above the ceiling of ${maxKeyed}.`,
    );
    err(
      `  Lower --candidates to ${Math.max(0, maxKeyed - seedPlan.length)} or fewer, or raise ` +
        `--max-requests (up to the pinned ${budget.maxKeyedRequests}).`,
    );
    err('  Nothing was requested, so no quota was spent.');
    return EXIT.usage;
  }

  // **The same refusal for the keyless ceiling.** It bounds a shared public resource rather than a
  // metered allowance, but the failure it prevents is worse: the keyless work happens AFTER the
  // keyed allowance has been spent, so a ceiling discovered half-way through wastes the quota it
  // already paid for. The gate's own ownership listing costs up to `LISTING_PAGES_FOR_MERGE` per
  // candidate and `--consistency` costs up to 3 more per gate survivor, of which every candidate
  // could be one.
  const listingPagesPerCandidate = opts.ownershipOnly ? 0 : LISTING_PAGES_FOR_MERGE;
  const worstCaseKeyless = maxCandidates * (listingPagesPerCandidate + (opts.consistency ? 3 : 0));
  if (worstCaseKeyless > budget.maxKeylessRequests) {
    err(
      `Refusing to start: the plan's worst case is ${maxCandidates} candidate x ` +
        `${listingPagesPerCandidate + (opts.consistency ? 3 : 0)} keyless page(s) = ${worstCaseKeyless} ` +
        `requests, above the pinned keyless ceiling of ${budget.maxKeylessRequests}.`,
    );
    err(
      `  Lower --candidates to ${Math.floor(budget.maxKeylessRequests / Math.max(1, listingPagesPerCandidate + (opts.consistency ? 3 : 0)))} ` +
        `or fewer, drop --consistency, or raise thresholds.json budget.maxKeylessRequests.`,
    );
    err('  Nothing was requested, so no quota was spent.');
    return EXIT.usage;
  }

  // **Which Solana RPC endpoint the creation walk reaches, decided once, here.** With
  // `HELIUS_API_KEY` set it is the indexed route; with it unset the keyless signature scan, exactly
  // as before this key existed. A key that is PRESENT but malformed falls back and says why —
  // `endpoint.rejected` is printed below rather than swallowed, because a silent fallback would
  // read as a keyed run in the record.
  const rpcEndpoint = resolveSolanaRpcEndpoint(env);
  const indexedWalk = T['creation_walk_helius'];
  const usingIndexedWalk = rpcEndpoint.provider === 'helius' && !opts.ownershipOnly;

  // **The same refusal again, in the unit this provider actually bills in.** Helius charges by
  // transactions RETURNED, not by request, so a request ceiling cannot bound the spend — 195
  // candidates at the worst measured per-candidate cost is 1,014,000 credits, near a ninth of the
  // monthly allowance, and a plan that only discovered that half-way through would have spent it.
  const worstCaseCredits = usingIndexedWalk ? maxCandidates * indexedWalk.maxCreditsPerCandidate : 0;
  if (worstCaseCredits > indexedWalk.maxCreditsPerRun) {
    err(
      `Refusing to start: the plan's worst case is ${maxCandidates} candidate x ` +
        `${indexedWalk.maxCreditsPerCandidate} Helius credits = ${worstCaseCredits}, above the pinned ` +
        `per-run ceiling of ${indexedWalk.maxCreditsPerRun}.`,
    );
    err(
      `  Lower --candidates to ${Math.floor(indexedWalk.maxCreditsPerRun / indexedWalk.maxCreditsPerCandidate)} ` +
        `or fewer, pass --ownership-only to skip the walk entirely, or raise thresholds.json ` +
        `creation_walk_helius.maxCreditsPerRun.`,
    );
    err('  Nothing was requested, so no credit and no quota was spent.');
    return EXIT.usage;
  }

  // **Which surface answers "which mints did this wallet create", decided once, here.** Captain
  // decision 156a makes Dune primary; the walk above is the fallback and stays fully wired, because
  // the fallback is taken often enough to matter — no key, a Dune failure, or a wallet the coverage
  // probe refuses. A key that is PRESENT but malformed falls back and SAYS WHY, for the same reason
  // the Helius one does: a silent fallback reads as a deliberate choice in the record.
  const duneBounds = T['dune'];
  const duneCredential = resolveDuneCredential(env);
  const usingDune = duneCredential.available && !opts.ownershipOnly && !opts.noDune;

  // **The Helius worst case is NOT reduced by Dune being primary, and that is deliberate.** Every
  // candidate can fall back, so the reservation has to cover every candidate falling back. What Dune
  // changes is the EXPECTED spend, not the admissible plan: a run where Dune answers spends nothing
  // on the walk, and a run where it does not is exactly the run this ceiling was sized for.
  const resolution = resolveKey(env);

  // Stage 2 gets its OWN ceiling on its OWN client, so the fill walk and the consistency walk
  // cannot eat each other's budget and neither can silently exceed what the dry run printed.
  const stage2Keyless = new KeylessClient({
    maxRequests: entryThresholds.maxKeylessRequests,
    // Its OWN pacing, not `budget.keylessMinIntervalMs`, because it reaches a different host. At the
    // 2s that host-agnostic value would impose, swap-api shed half this run's launches to 429 and the
    // verdict degraded to `entry-unmeasured`; 7s walked all of them. The consistency walk on
    // frontend-api-v3 keeps 2s — it has shed nothing, so it is not slowed for another host's fault.
    minIntervalMs: entryThresholds.keylessMinIntervalMs,
    // The fill endpoint sheds about a quarter of what it is asked for — measured on the committed
    // tape's own build metadata — so a walk without retry cannot finish. Every attempt still counts
    // against the ceiling, so this widens no bound.
    retryBackoffMs: entryThresholds.keylessRetryBackoffMs ?? [],
    onRequest: (url) => {
      if (!opts.json) out(`  → GET ${url}`);
    },
  });

  // THE ONE PLACE A FILL SOURCE IS CHOSEN (captain decision 260a). Everything downstream —
  // `stage2.mjs`, `entry.mjs`, `measure.mjs`, `rank.mjs` — receives the source and never names one.
  // See {@link selectEntryFillSource} for what this run resolves to and why.
  //
  // **THE REGISTRY IS DATA AND RESOLVING IT COSTS NOTHING** (captain decision 286c). Each entry
  // carries a constructor AND a declaration of what running that constructor costs, so the dry-run
  // branch below can name the source, and say what asking it would cost, without building one. That
  // matters from the Gate 3 cutover on: the Dune source cannot be built without a BILLED coverage
  // probe, so a plan that built its source to describe it would either spend or throw, and the
  // captain refused both.
  /** @type {FillSourceRegistry} */
  const entryFillSources = {
    'swap-api': { construction: SWAP_API_CONSTRUCTION, build: () => swapApiFillSource(stage2Keyless) },
  };

  if (opts.dryRun) {
    // THE PLAN MUST STATE THE GATE THE SOURCE ITSELF WILL APPLY — a plan that re-derived that
    // duration would be a second expression that merely agrees, which is captain decision 144a's
    // defect and the reason the gate was injected in the first place (281a/284a/285a). What 286c
    // adds is the other half of the same honesty: where the source cannot be ASKED for free, the
    // plan says so in place and prints everything else, rather than spending or refusing to print.
    /** @type {import('./plan-source.mjs').PlanEligibility | null} */
    let entryEligibility = null;
    // ONLY A PLAN THAT WILL PRINT THE FIGURE MAY BUY IT. The eligibility floor is rendered inside
    // the Stage 2 block and nowhere else, so under `--no-stage2` the source is not consulted at
    // all — otherwise the opt-in could authorise a bounded purchase of a number that appears on no
    // page, which is a spend with no reader and one the run path would not make either.
    if (opts.stage2) {
      try {
        entryEligibility = await planEntryEligibility(ENTRY_FILL_SOURCE_KIND, entryFillSources, {
          bounds: entryFillBounds(entryThresholds, Date.now()),
          spendAuthorised: opts.dryRunSpend,
          // The bound and the actual land ABOVE the plan, in the order they happen, so an operator
          // reading top to bottom sees what was authorised before they see what it bought.
          announce: (line) => out(line),
        });
      } catch (cause) {
        // A source this run has no constructor for, or one that could not be built where NOTHING
        // WAS SPENT, stops the PLAN — the site whose whole job is to say "we cannot describe Stage
        // 2 on the source we were asked for". Escaping `main` would return Node's exit 1, which is
        // not in the `EXIT` map, and print the message as a crash. A failure AFTER an authorised
        // spend never reaches here: `planEntryEligibility` degrades it to a stated absence rather
        // than taking the money and the page both.
        err('');
        err('Refusing to plan: Stage 2 has no usable fill source.');
        err(`  ${cause instanceof Error ? cause.message : String(cause)}`);
        err('  Nothing else was requested.');
        return EXIT.upstream;
      }
    }
    out('');
    out(
      renderDryRun({
        seedPlan,
        maxCandidates,
        maxKeyedRequests: maxKeyed,
        consistency: opts.consistency,
        maxKeylessRequests: budget.maxKeylessRequests,
        stage2: opts.stage2,
        maxScored,
        entryThresholds,
        entryEligibility,
        spendAuthorised: opts.dryRunSpend,
        historySource,
        creationWalk: T['creation_walk'],
        costBounds,
        keyDescription: resolution.ok ? resolution.description : null,
        rpcEndpoint,
        indexedWalk,
        worstCaseCredits,
        dune: duneBounds,
        duneCredential,
        usingDune,
        duneRefreshProbe: opts.duneRefreshProbe,
      }),
    );
    return EXIT.ok;
  }

  // ---- the RUN path, unchanged by 286c ----------------------------------------------------
  // A real run builds its source and pays whatever that costs: it was always going to reach that
  // vendor, and the eligibility answer is an input to a measurement rather than a line on a preview.
  //
  // BOTH STEPS CAN REFUSE, AND A REFUSAL IS A REPORTED OUTCOME RATHER THAN A STACK TRACE. A source
  // whose constructor cannot vouch for itself, or one answering an eligibility that is not a
  // duration, stops the run here — the site whose whole job is to say "we cannot run Stage 2 on the
  // source we were asked for".
  /** @type {import('./fill-source.mjs').FillSource} */
  let entryFillSource;
  /** @type {number} */
  let entryMinAgeMs;
  try {
    entryFillSource = selectEntryFillSource(ENTRY_FILL_SOURCE_KIND, entryFillSources);
    entryMinAgeMs = await entryFillSource.minAgeMs(entryFillBounds(entryThresholds, Date.now()));
    assertMinAgeUsable(entryFillSource, entryMinAgeMs);
  } catch (cause) {
    err('');
    err('Refusing to start: Stage 2 has no usable fill source.');
    err(`  ${cause instanceof Error ? cause.message : String(cause)}`);
    err('  Nothing was requested, so no quota was spent.');
    return EXIT.upstream;
  }

  if (!resolution.ok) {
    err('');
    err(`CREDENTIAL PROBLEM — no deployer was screened, and this is NOT a negative result.`);
    err('');
    err(resolution.message);
    return EXIT.credentialMissing;
  }

  // ---- Stage 1 ---------------------------------------------------------------------------
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let completed = true;
  /** @type {string | null} */
  let abortReason = null;
  /** @type {import('./record.mjs').Unmeasured[]} */
  const unmeasured = [];
  /** @type {{ wallet: string, reason: string }[]} */
  let prefiltered = [];
  /** @type {import('./seed.mjs').SeedYield[]} */
  const seedYields = [];
  let distinctWalletsSeeded = 0;
  let worthARequestCount = 0;

  const client = new BoundedClient({
    key: resolution.key,
    maxRequests: maxKeyed,
    minIntervalMs: budget.keyedMinIntervalMs,
    onRequest: (path, attempt) => {
      if (!opts.json) out(`  → GET ${path}${attempt > 0 ? ` (retry ${attempt})` : ''}`);
    },
  });

  const keyless = new KeylessClient({
    maxRequests: budget.maxKeylessRequests,
    minIntervalMs: budget.keylessMinIntervalMs,
    onRequest: (url) => {
      if (!opts.json) out(`  → GET ${url}`);
    },
  });

  // The Dune client, built even when unused so the record's spend block always reports the same
  // shape. Its TWO ceilings are separate on purpose: requests bound the wall clock and the polite
  // use of a shared free-tier host, executions bound the money — an execution is billed whether or
  // not it succeeds and is NEVER retried.
  const duneClient = usingDune
    ? new DuneClient({
        key: duneCredential.key ?? '',
        maxExecutions: duneBounds.maxExecutionsPerRun,
        maxRequests: duneBounds.maxRequestsPerRun,
        minIntervalMs: duneBounds.minIntervalMs,
        onRequest: (path) => {
          if (!opts.json) out(`  → dune ${path}`);
        },
      })
    : null;
  /** @type {import('./dune.mjs').DuneEnumeration | null} */
  let duneEnumeration = null;
  /** @type {import('./client.mjs').AllowanceDecision | null} */
  let duneAllowance = null;
  /** @type {string | null} */
  let duneUnusableNote = null;

  const walkBounds = T['creation_walk'];
  let rpcRequests = 0;
  let rpcLoadShedEvents = 0;
  // Reported SEPARATELY from the request count and from the MadeOnSol allowance, because they are
  // three different budgets against three different vendors. Only the indexed walk spends credits;
  // the keyless fallback and Stage 2's cost leg spend requests against a free host and nothing else.
  let heliusCredits = 0;

  /** @type {import('./rank.mjs').Candidate[]} */
  const candidates = [];
  // Vendor profiles, held in memory for this run only so Stage 2 can read the mint list Stage 1
  // already paid for. Never written, never cached — MadeOnSol terms §5a(d); see `toLaunchRefs`.
  /** @type {Map<string, unknown>} */
  const profiles = new Map();
  let scoringTruncatedBy = 0;

  try {
    if (!opts.json) {
      out('');
      out('STAGE 1 — enumerating candidates from the free leaderboard endpoints');
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

    // Pre-filter before spending a request. This reads the vendor's trailing-window counters and
    // can only ever SKIP a wallet; it never touches a rate, a verdict or an output number.
    const merged = mergeSeeds(seedYields);
    /** @type {{ wallet: string, reason: string }[]} */
    const skipped = [];
    /** @type {import('./seed.mjs').SeedCandidate[]} */
    const worthARequest = [];
    for (const seed of merged) {
      const reason = prefilterReason(seed);
      if (reason === null) worthARequest.push(seed);
      else skipped.push({ wallet: seed.wallet, reason });
    }

    distinctWalletsSeeded = merged.length;
    worthARequestCount = worthARequest.length;
    prefiltered = skipped;

    if (!opts.json) {
      out(`  ${merged.length} distinct wallets seeded`);
      out(`  ${skipped.length} skipped before spending a request (vendor trailing count too low)`);
      out(`  gating the first ${Math.min(worthARequest.length, maxCandidates)} of ${worthARequest.length}`);
      out('');
    }

    const gating = worthARequest.slice(0, maxCandidates);

    // ---- Creation enumeration, PRIMARY on Dune, ONE execution for the whole batch. ------------
    // Batching is the cost model rather than a convenience: the table scan costs nearly the same
    // for 5 wallets as for 20, so the per-deployer price falls as the batch grows. It runs BEFORE
    // the gate loop because the loop is where the fallback walk would otherwise be spent.
    if (usingDune && duneClient !== null && gating.length > 0) {
      if (!opts.json) {
        out('');
        out(
          `GATING — creation-derived history, ENUMERATED ON DUNE (${duneCredential.label}), ` +
            `one execution for all ${gating.length} candidate(s)`,
        );
      }
      try {
        // ---- THE MONTHLY CREDIT CEILING, BEFORE THE FIRST DUNE REQUEST OF THE RUN. ------------
        // Dune bills a SHARED monthly allowance and a FAILED execution is billed like a successful
        // one, so the failure worth preventing is a leg that starts, dies partway and leaves
        // neither a result nor the credits to retry. The reading is free and it happens before the
        // coverage probe, which is itself a billed read. A refusal degrades this leg to the RPC
        // walk exactly as any other Dune failure does — slower rather than wrong.
        const checked = await checkDuneAllowance(duneClient, { bounds: duneBounds, nowMs: Date.now() });
        duneAllowance = checked.decision;
        if (!opts.json) for (const line of describeAllowanceDecision(checked.decision)) out(`  ${line}`);
        duneEnumeration = await enumerateCreations(duneClient, {
          wallets: gating.map((s) => s.wallet),
          creationQueryId: duneBounds.creationQueryId,
          coverageQueryId: duneBounds.coverageQueryId,
          refreshProbe: opts.duneRefreshProbe,
          nowMs: Date.now(),
          bounds: duneBounds,
          allowance: checked.decision,
        });
        if (!opts.json) {
          const cov = duneEnumeration.coverage;
          out(
            `  coverage probe: ${duneEnumeration.probe.tables.length} table(s) probed, ` +
              `${cov.ok ? 'PASSED' : 'REFUSED'}` +
              (cov.fromMs === null || cov.toMs === null
                ? ''
                : ` — covered ${new Date(cov.fromMs).toISOString().slice(0, 10)} → ` +
                  `${new Date(cov.toMs).toISOString().slice(0, 10)}, ${cov.holes.length} month(s) with no row`),
          );
          for (const r of cov.reasons) out(`  !! coverage REFUSED: ${r}`);
          out(`  ${duneEnumeration.rowsReturned} launch row(s) returned, ${duneEnumeration.unreadableRows} unreadable`);
          // A row that would not parse commonly has no readable deployer, so the wallet whose
          // history came back short cannot be named — the WHOLE batch falls back rather than being
          // gated on what survived the parser.
          if (duneEnumeration.unreadableRows > 0) {
            out('  !! unreadable rows: the whole batch is REFUSED and every candidate takes the walk');
          }
          // The cap is per DEPLOYER, so this line reports a handful of wallets walking rather than
          // a whole batch losing its Dune answer — which is what the run-level row ceiling used to
          // cost when one industrial-spam wallet blew it for everyone. See dune.mjs → CREATION_SQL.
          if (duneEnumeration.walletsRefusedByLaunchCap > 0) {
            out(
              `  !! ${duneEnumeration.walletsRefusedByLaunchCap} candidate(s) have more creations than ` +
                `this batch's per-deployer cap of ${duneEnumeration.launchCap} row(s) — their Dune ` +
                `history is a prefix, so THEY take the walk and every other candidate keeps its answer`,
            );
          }
          if (duneEnumeration.walletsRefusedByShape > 0) {
            out(
              `  !! ${duneEnumeration.walletsRefusedByShape} candidate(s) were never sent to Dune — ` +
                `their address is not base58-shaped — and take the walk`,
            );
          }
        }
      } catch (cause) {
        // A Dune failure degrades this leg to the walk and NEVER aborts a run whose keyed MadeOnSol
        // allowance is already spent. The same rule the ownership listing already follows, and for
        // the same reason: one vendor's bad afternoon must not throw away paid-for measurements.
        duneUnusableNote = redactVendorIdentifiers(cause instanceof Error ? cause.message : String(cause));
        // Deliberately NOT pushed onto `unmeasured`. That list is what makes a run report itself
        // TRUNCATED, and a Dune failure does not leave a measurement untaken — the walk takes it.
        // Recording it there would claim missing evidence the run in fact holds, which is the same
        // class of false statement the list exists to prevent, pointing the other way. The failure
        // is on the record either way: `dune.unusableNote` carries it, and every candidate's
        // `enumerationSource` says the walk answered.
        if (!opts.json) out(`  !! Dune enumeration unusable, falling back to the RPC walk: ${duneUnusableNote}`);
      }
    }

    if (!opts.json && !opts.ownershipOnly) {
      out('');
      out(
        usingIndexedWalk
          ? `FALLBACK CREATION WALK, from pump.fun create transactions (indexed RPC, ${rpcEndpoint.label})`
          : 'FALLBACK CREATION WALK, from pump.fun create transactions (keyless RPC)',
      );
      // A key that was present but unusable must not read as a deliberate keyless run.
      if (rpcEndpoint.rejected !== null) out(`  !! ${rpcEndpoint.rejected}`);
      else if (!usingIndexedWalk) {
        out(
          `  ${HELIUS_KEY_ENV_VAR} is not set, so this leg runs on the keyless public endpoint and ` +
            `is SLOWER, not different.`,
        );
      }
      if (duneCredential.rejected !== null) out(`  !! ${duneCredential.rejected}`);
      else if (!usingDune && !opts.noDune) {
        out(
          `  ${DUNE_KEY_ENV_VAR} is not set, so creation enumeration runs on this walk rather than ` +
            `on Dune. Same measurement, and slower by roughly an order of magnitude.`,
        );
      }
    }

    for (const seed of gating) {
      const profile = await client.getJson(`/deployer-hunter/${encodeURIComponent(seed.wallet)}`);
      const { records, capped } = toTokenRecords(profile);

      // The vendor reading. It is the OLD gate input and it stays in the record verbatim, because a
      // correction whose predecessor is not recorded alongside it becomes an invisible assumption
      // one release later — which is how this defect survived as a comment for as long as it did.
      const vendorCompletion = measureCompletion(records);
      const vendorGate = applyGate({ completion: vendorCompletion }, gateThresholds);
      const vendorVerdict = verdictFor({ gate: vendorGate, completion: vendorCompletion, capped });

      /** @type {import('./rank.mjs').CreationReading | null} */
      let creation = null;
      let completion = vendorCompletion;
      let gateReadingCapped = capped;
      let gate = vendorGate;
      let { verdict, rationale } = vendorVerdict;

      if (!opts.ownershipOnly) {
        // **Dune first, the walk only if Dune's reading is refused.** The refusal is per WALLET and
        // not per run: the coverage probe turns down a wallet whose earliest launch sits at or
        // before the probed surfaces' own first row, while the rest of the batch is fine. So a
        // single run can carry both sources, and every candidate row says which one answered it.
        const fromDune = duneEnumeration?.byWallet.get(seed.wallet) ?? null;
        const useDune = fromDune !== null && fromDune.usable;
        /** @type {string[]} */
        const duneFallbackReasons = useDune ? [] : (fromDune?.reasons ?? []);
        const duneLaunches = fromDune === null ? null : fromDune.launches;
        // 227a's observation, and it is scoped to the route that ANSWERED this candidate.
        // `is_mayhem_mode` is a column on the decoded create event; the creation walk reads
        // transactions and curve accounts and never sees it, so a walk-sourced candidate reports
        // the flag as UNMEASURED rather than as absent — the same distinction
        // `creatorMovementUnmeasured` draws for the other direction of that trade.
        //
        // It is gated on `useDune` rather than on Dune having returned rows, so the share's
        // denominator is always drawn from the history the gate actually read. A REFUSED Dune
        // reading does hold mayhem evidence, and publishing it here would be publishing a share
        // over the prefix or the out-of-coverage slice that got the reading refused in the first
        // place — a figure whose incompleteness the record could not state, next to an
        // `enumerationSource` naming a different surface. This value is read nowhere above.
        const mayhem = useDune && fromDune !== null ? fromDune.mayhem : null;

        let rpcTicks = 0;
        // ONE per-candidate ceiling either way, in whichever unit the endpoint bills in. The
        // indexed route reads up to `maxPagesPerCandidate` pages and is bounded by CREDITS; the
        // keyless one reads up to `maxRpcRequestsPerCandidate` requests and is bounded by those.
        // Both are per-candidate, so one wallet's busy index cannot eat the next wallet's budget.
        const ceilingForCandidate = usingIndexedWalk
          ? indexedWalk.maxPagesPerCandidate + Math.ceil(indexedWalk.maxTransactionsPerCandidate / 100) + 1
          : walkBounds.maxRpcRequestsPerCandidate;
        const rpc = useDune
          ? null
          : new SolanaRpcClient({
              maxRequests: ceilingForCandidate,
              endpoint: rpcEndpoint,
              minIntervalMs: usingIndexedWalk ? indexedWalk.rpcMinIntervalMs : walkBounds.rpcMinIntervalMs,
              ...(usingIndexedWalk ? { maxCredits: indexedWalk.maxCreditsPerCandidate } : {}),
              // Same `!opts.json` guard as the other three clients, so --json stays machine-readable.
              ...(opts.json
                ? {}
                : {
                    /** @param {string} label */
                    onRequest: (label) => {
                      rpcTicks += 1;
                      if (rpcTicks !== 1 && rpcTicks % RPC_HEARTBEAT_EVERY !== 0) return;
                      out(
                        `    · ${seed.wallet}: ${rpcTicks}/${ceilingForCandidate} ` +
                          `RPC request(s) — ${label}`,
                      );
                    },
                  }),
            });
        // One shape either way, so everything downstream — the merge, the verdict, the record — is
        // written once and cannot drift between the two sources. The walk-only diagnostics read 0
        // on the Dune path because no walk happened, and `enumerationSource` is what tells them apart.
        const walk =
          useDune && fromDune !== null
            ? {
                creates: fromDune.creates,
                curves: fromDune.curves,
                covered: fromDune.covered,
                unresolvedTransactions: 0,
                /** @type {'dune-enumerated'} */
                stopReason: /** @type {const} */ ('dune-enumerated'),
                stopDetail: null,
                signaturesScanned: 0,
                signaturesSucceeded: 0,
                transactionsInspected: 0,
                curvesUnread: 0,
              }
            : rpc === null
              ? null
              : usingIndexedWalk
                ? await readCreatedHistoryIndexed(rpc, seed.wallet, {
                    maxPages: indexedWalk.maxPagesPerCandidate,
                    pageLimit: indexedWalk.pageLimit,
                    maxTransactions: indexedWalk.maxTransactionsPerCandidate,
                    maxCredits: indexedWalk.maxCreditsPerCandidate,
                  })
                : await readCreatedHistory(rpc, seed.wallet, {
                    maxSignaturePages: walkBounds.maxSignaturePages,
                    maxTransactions: walkBounds.maxTransactionsPerCandidate,
                    txBatchSize: walkBounds.txBatchSize,
                  });
        if (walk === null) throw new Error('unreachable: neither a Dune reading nor a walk was produced');
        const walkRequests = rpc === null ? 0 : rpc.issued();
        const walkShed = rpc === null ? 0 : rpc.loadShedEvents();
        rpcRequests += walkRequests;
        rpcLoadShedEvents += walkShed;
        heliusCredits += usingIndexedWalk && rpc !== null ? rpc.creditsSpent() : 0;

        // Guarded per candidate, exactly as the consistency pass is. A CeilingReached or a
        // transport failure on one wallet's listing used to reach the outer catch and abort a run
        // whose keyed MadeOnSol allowance was already spent — one wallet's bad luck throwing away
        // every measurement paid for before it. It degrades this candidate's reading instead, and
        // the reading then reads as unmeasured rather than as a rejection.
        /** @type {{ records: import('./pumpfun.mjs').ListedToken[], truncated: boolean }} */
        let listing = { records: [], truncated: false };
        /** @type {string | null} */
        let listingUnmeasuredNote = null;
        try {
          listing = await readCreatorHistory(keyless, seed.wallet, LISTING_PAGES_FOR_MERGE);
        } catch (cause) {
          const entry = unmeasuredBecause('the ownership listing the creation window merges with', seed.wallet, cause, {
            budget: 'keyless pump.fun',
            ceiling: budget.maxKeylessRequests,
            setting: 'thresholds.json budget.maxKeylessRequests',
          });
          unmeasured.push(entry);
          listingUnmeasuredNote = describeUnmeasured(entry);
        }

        const merged = mergeHistories({
          creates: walk.creates,
          wallet: seed.wallet,
          curves: walk.curves,
          listed: listing.records,
          covered: walk.covered,
          unresolvedTransactions: walk.unresolvedTransactions,
        });

        completion = measureCompletion(merged.records);
        gateReadingCapped = listing.truncated;
        gate = applyGate({ completion, historySource }, gateThresholds);
        // What makes this reading unjudgeable, if anything. Both entries describe a history the
        // thresholds were applied to but could not actually decide over, and either one is enough:
        // a rejection computed on it would be exactly the invisible false rejection this lane
        // exists to remove, and a pass would be no better founded.
        /** @type {string[]} */
        const notMeasured = [];
        if (merged.bondedUndecidable > 0) {
          notMeasured.push(
            `${merged.bondedUndecidable} of ${merged.records.length} launch(es) have no bonded ` +
              `status from EITHER source — the bonding-curve account could not be read and the ` +
              `ownership listing has no row for them (which is what a hidden launch looks like)`,
          );
          // The run level too, not only the candidate row. A record whose `unmeasured` reads empty
          // and `truncated` reads false has told its reader it measured everything, and a wallet
          // nobody judged sitting in the candidate list does not contradict that at a glance —
          // which is the same invisible false rejection this lane exists to remove, one level up.
          unmeasured.push(
            unmeasuredNoSource(
              'the bonded status of a creation-derived launch history',
              seed.wallet,
              'neither the on-chain bonding-curve account nor the ownership listing could say ' +
                'whether some of this wallet\'s launches bonded, so the gate was not applied to it',
              `${merged.bondedUndecidable} of ${merged.records.length} launch(es) undecidable`,
            ),
          );
        }
        if (listingUnmeasuredNote !== null) {
          notMeasured.push(
            `the ownership listing, which supplies every launch before the creation window, could ` +
              `not be read: ${listingUnmeasuredNote}`,
          );
        }
        ({ verdict, rationale } = verdictFor({ gate, completion, capped: gateReadingCapped, notMeasured }));
        // Both bounds go through the merge's own test, so the record cannot claim a window the
        // reading it was produced from treated as empty. `coveredFromIso: null` means the walk
        // never finished a signature page, so it covered NOTHING and `coveredDays` is 0 — not a
        // 56-year window, which is what the epoch floor this replaced used to report. Under it the
        // whole ownership listing is carried over as `listedOutsideWindow`, and that is what the
        // gate reads.
        const covFrom = coveredBoundMs(walk.covered.fromMs);
        const covTo = coveredBoundMs(walk.covered.toMs);
        creation = {
          coveredFromIso: covFrom === null ? null : new Date(covFrom).toISOString(),
          coveredToIso: covTo === null ? null : new Date(covTo).toISOString(),
          coveredDays:
            covFrom === null || covTo === null ? 0 : Number(((covTo - covFrom) / 86_400_000).toFixed(2)),
          wholeHistory: walk.covered.exhausted,
          stopReason: walk.stopReason,
          stopDetail: walk.stopDetail,
          rpcRequests: walkRequests,
          loadShedEvents: walkShed,
          signaturesScanned: walk.signaturesScanned,
          signaturesSucceeded: walk.signaturesSucceeded,
          transactionsInspected: walk.transactionsInspected,
          unresolvedTransactions: walk.unresolvedTransactions,
          curvesUnread: walk.curvesUnread,
          listingRows: listing.records.length,
          listingPageCapped: listing.truncated,
          listingUnmeasuredNote,
          createdInWindow: merged.createdInWindow,
          listedInWindow: merged.listedInWindow,
          hiddenByOwnership: merged.hiddenByOwnership,
          notCreatedByWallet: merged.notCreatedByWallet,
          movedCreator: merged.movedCreator,
          listedOutsideWindow: merged.listedOutsideWindow,
          listedInWindowCarried: merged.listedInWindowCarried,
          windowExact: merged.windowExact,
          bondedFromCurve: merged.bondedFromCurve,
          bondedFromListing: merged.bondedFromListing,
          bondedUndecidable: merged.bondedUndecidable,
          // WHICH SURFACE ANSWERED THIS CANDIDATE, per candidate rather than per run, because the
          // coverage probe refuses a wallet at a time. `duneFallbackReasons` is empty both when Dune
          // answered and when Dune was never consulted; the run-level `dune` block separates those.
          enumerationSource: useDune ? 'dune' : usingIndexedWalk ? 'helius' : 'keyless-rpc',
          duneLaunches,
          duneFallbackReasons,
          creatorMovementUnmeasured: merged.creatorMovementUnmeasured,
          // CAPTAIN DECISION 227a — pump.fun's mayhem-mode flag, RECORDED and REPORTED, reaching
          // no bar and no verdict. All three are `null` on a candidate the Dune enumeration did not
          // answer for, and that is the same distinction `creatorMovementUnmeasured` already draws
          // one line up: the creation walk reads a transaction, not a decoded create event, so it
          // measures NOTHING here. A `0` would say "this wallet launches no mayhem tokens", which
          // is a claim no walk-sourced reading is entitled to make.
          // `mayhemFlagReadable` is the share's DENOMINATOR and is persisted rather than derived:
          // it is not `duneLaunches`, because a history reaching back past `pump_evt_createevent`
          // picks up rows from `pump_call_create`, which has no such column. The unreadable count
          // is the difference between the two, both on this block.
          mayhemLaunches: mayhem === null ? null : mayhem.mayhem,
          mayhemFlagReadable: mayhem === null ? null : mayhem.launches,
          mayhemShare: mayhem === null ? null : mayhem.share,
        };

        if (!opts.json) {
          out(
            `  ${seed.wallet}: created ${merged.createdInWindow} in the ${creation.coveredDays}d window ` +
              `(ownership showed ${merged.listedInWindow}; ${merged.hiddenByOwnership} hidden, ` +
              `${merged.notCreatedByWallet} acquired, ${merged.movedCreator} creator moved` +
              `${merged.creatorMovementUnmeasured > 0 ? ` / ${merged.creatorMovementUnmeasured} unmeasured` : ''}), ` +
              `+${merged.listedOutsideWindow} carried over — via ${creation.enumerationSource}, ` +
              `stopped on ${walk.stopReason}`,
          );
          // 227a, on the line under the counts and on EVERY candidate — an exposure that only
          // printed when it was non-zero would leave a reader unable to tell "no mayhem launches"
          // from "nobody looked", which is the distinction the whole field exists to carry.
          for (const line of renderMayhemShare(creation, '      ')) out(line);
          for (const r of duneFallbackReasons) out(`      ^ DUNE READING REFUSED, walked instead: ${r}`);
          if (notMeasured.length > 0) {
            out(`      ^ READING NOT MEASURED — verdict ${verdict}, not a rejection: ${notMeasured.join('; ')}`);
          }
        }
      }

      profiles.set(seed.wallet, profile);
      candidates.push({
        wallet: seed.wallet,
        seededBy: seed.seededBy,
        completion,
        completionCapped: gateReadingCapped,
        gate,
        verdict,
        rationale,
        consistency: null,
        entry: null,
        entryCoverage: null,
        historySource,
        vendorCompletion,
        vendorVerdict: vendorVerdict.verdict,
        vendorPageCapped: capped,
        creation,
      });
    }

    // ---- Stage 2 — ENTRY. Keyless, and it spends no keyed request at all. -----------------
    if (opts.stage2) {
      const survivors = candidates.filter((c) => c.verdict === 'gate-passed');
      const toScore = survivors.slice(0, maxScored);
      scoringTruncatedBy = survivors.length - toScore.length;

      if (!opts.json) {
        out('');
        out(
          `STAGE 2 — ENTRY: room in the opening window, and what the field achieved. ` +
            `Scoring ${toScore.length} of ${survivors.length} gate survivor(s), keyless, ` +
            `ceiling ${entryThresholds.maxKeylessRequests} request(s).`,
        );
      }

      for (const c of toScore) {
        if (!opts.json) out(`  ${c.wallet}`);
        // The cost leg's own client, with its own PER-CANDIDATE ceiling — the same shape the
        // creation walk uses, and for the same reason: one wallet's busy window must not eat the
        // next wallet's budget. It is built here rather than shared because `SolanaRpcClient`
        // carries its ceiling for life. Pacing is the creation walk's, and the two legs never run
        // at the same time: api.mainnet-beta rate-limits globally across methods.
        let costTicks = 0;
        const costRpc = new SolanaRpcClient({
          maxRequests: costBounds.maxRpcRequestsPerCandidate,
          minIntervalMs: costBounds.rpcMinIntervalMs,
          ...(opts.json
            ? {}
            : {
                /** @param {string} label */
                onRequest: (label) => {
                  costTicks += 1;
                  if (costTicks !== 1 && costTicks % RPC_HEARTBEAT_EVERY !== 0) return;
                  out(
                    `    · ${c.wallet}: ${costTicks}/${costBounds.maxRpcRequestsPerCandidate} ` +
                      `cost RPC request(s) — ${label}`,
                  );
                },
              }),
        });
        const { score, coverage } = await scoreCandidateEntry(entryFillSource, {
          wallet: c.wallet,
          profile: profiles.get(c.wallet),
          nowMs: Date.now(),
          thresholds: entryThresholds,
          costSource: rpcCostSource(costRpc, { preferBlockRoute: costBounds.preferBlockRoute }),
          log: opts.json ? undefined : (line) => out(line),
        });
        rpcRequests += costRpc.issued();
        rpcLoadShedEvents += costRpc.loadShedEvents();
        c.entry = score;
        c.entryCoverage = coverage;
        if (!opts.json) out(`    → ${score.verdict.toUpperCase()}: ${score.rationale}`);
      }
    }

    // Optional keyless consistency pass, survivors only.
    if (opts.consistency) {
      if (!opts.json) {
        out('');
        out('CONSISTENCY — keyless pump.fun creator walk for gate survivors (no quota cost)');
      }
      for (const c of candidates) {
        if (c.verdict !== 'gate-passed') continue;
        try {
          // `truncated` travels with the result. This is the only surface here making a
          // long-horizon claim, and it is computed over a page-capped walk of a listing that is
          // itself a lower bound — the run has already reported epoch dispersion up to 0.619 from
          // exactly this walk, so the caveat is load-bearing rather than decorative.
          const { records, truncated: historyTruncated } = await readCreatorHistory(keyless, c.wallet, 3);
          c.consistency = measureConsistency(records, T['consistency_over_time'], historyTruncated);
        } catch (cause) {
          // A ceiling hit, an exhausted budget or a failed walk is NOT a measured result, and it
          // must not be recordable as one. So the failure is logged against the run — where it
          // makes the record truncated and names what went unlooked-at — rather than living only
          // in this candidate's note, where `completed: true, truncated: false` would have read as
          // a screen that had measured everything it reports.
          const entry = unmeasuredBecause('consistency-over-time', c.wallet, cause, {
            budget: 'keyless pump.fun',
            ceiling: budget.maxKeylessRequests,
            setting: 'thresholds.json budget.maxKeylessRequests',
          });
          unmeasured.push(entry);
          c.consistency = {
            state: 'unmeasured',
            epochs: 0,
            minEpochRate: Number.NaN,
            maxEpochRate: Number.NaN,
            dispersion: Number.NaN,
            streaky: false,
            historyTruncated: false,
            note: describeUnmeasured(entry),
          };
        }
      }
    }
  } catch (cause) {
    // Every terminal path here exits non-zero, so a partial list can never be mistaken for a
    // completed screen — but it is still WRITTEN and still PRINTED. A ceiling hit after fifteen
    // profiles used to discard fifteen paid-for measurements, which just spends the shared
    // allowance a second time to learn the same thing.
    completed = false;
    abortReason = cause instanceof Error ? cause.message : String(cause);
    err('');
    err(abortReason);

    // A REFUSED RPC CREDENTIAL IS TERMINAL FOR THE RUN, not a reading on one wallet. It says
    // nothing about the deployer being screened, so it may never produce a per-candidate reading —
    // and if it did, every candidate after it would fall back to the ownership listing while the
    // record still claimed `historySource: creation-derived`, one paid-for MadeOnSol profile at a
    // time. Stopping on the first one leaves the rest of the shared daily allowance unspent.
    if (cause instanceof RpcCredentialRejected) {
      err('');
      err('CREDENTIAL PROBLEM — the run STOPPED HERE, and this is NOT a negative result.');
      err(
        `  Every gate reading after this point would have silently fallen back to the ownership ` +
          `listing while the record still said historySource "${historySource}", so the run stops ` +
          `instead. The rest of the MadeOnSol daily allowance is unspent.`,
      );
    }

    const code =
      cause instanceof RpcCredentialRejected
        ? EXIT.credentialRejected
        : cause instanceof VendorRefused
          ? exitForRefusal(cause.kind)
          : cause instanceof CeilingReached
            ? EXIT.ceiling
            : EXIT.upstream;

    emit(code);
    return code;
  }

  emit(EXIT.ok);
  return EXIT.ok;

  /**
   * Assemble the persistable run record and, separately, the ranked candidates.
   *
   * They are two return values rather than one object with a field the caller must remember to
   * strip. `ranked` holds full `Candidate` objects — every gate reason, every measurement — and the
   * ToS 5a(d) containment is that only {@link toRecordRow}'s projection is ever written. When the
   * record carried `ranked` and the writer removed it by destructuring, that containment rested on
   * one line in one caller; anything else that stringified the record would have persisted more than
   * the asserted field set. Now the record's own shape is the guarantee.
   */
  function buildRecord() {
    const stats = client.stats();
    const ranked = rankCandidates(candidates);
    const coverage = summariseCoverage({
      seeds: seedYields,
      distinctWalletsSeeded,
      prefilteredOut: prefiltered.length,
      worthARequest: worthARequestCount,
      candidateCap: maxCandidates,
      gated: candidates.length,
    });

    const truncation = deriveTruncation({ abortReason, coverage, unmeasured });
    // The Stage 2 scoring cap is a fourth source of missingness. It is this run's own bound rather
    // than a failed or unlooked-at pass, so it is folded in here rather than inside
    // `deriveTruncation`, which owns the three that every stage shares.
    const scoringShortfall =
      scoringTruncatedBy > 0
        ? `the Stage 2 scoring cap of ${maxScored} left ${scoringTruncatedBy} gate survivor(s) with no entry score`
        : null;
    // Redacted for the same reason `toEntryRecordRow` redacts its notes: these strings can be built
    // from a thrown error, and an error's message is exactly where a vendor-derived identifier
    // arrives without anyone deciding to persist one.
    const reasons = [truncation.truncationReason, scoringShortfall].filter((r) => r !== null);

    // Hoisted out of the literal below because it is now read TWICE: once as the run's own
    // `finishedAtIso`, and once as every prediction's out-of-sample boundary. They must be the same
    // instant to the millisecond — `prediction.mjs` derives its "a launch created after this cannot
    // have been in the sample" proof from that identity — so they come from one `new Date()` rather
    // than from two calls that would differ by however long the record takes to assemble.
    const finishedAtIso = new Date().toISOString();
    const rows = ranked.map((c) => toRecordRow(c, { madeAtIso: finishedAtIso, thresholdsVersion: T['version'] }));

    return {
      ranked,
      record: {
        tool: 'deployer-screen',
        schemaVersion: RECORD_SCHEMA_VERSION,
        scope:
          'STAGE 1 (competence gate) + STAGE 2 (ENTRY room and the field). This tool does not ' +
          'recommend, and it does NOT score EXIT — no exit signal reaches any number here.',
        thresholdsVersion: T['version'],
        startedAtIso,
        finishedAtIso,
        keyedRequests: stats.issued,
        keylessRequests: keyless.issued() + stage2Keyless.issued(),
        keylessRequestsStage2: stage2Keyless.issued(),
        keylessShed: keyless.shed() + stage2Keyless.shed(),
        // Spend, reported concretely rather than as one number: what the ceiling was, where every
        // keyed request went, and what each endpoint costs per call. The captain asked for the
        // endpoint list specifically, and a record that only carries a total cannot answer
        // "what did we buy with it".
        spend: {
          keyedCeiling: stats.ceiling,
          keyedRemaining: Math.max(0, stats.ceiling - stats.issued),
          plannedWorstCaseKeyed: worstCaseKeyed,
          candidateCap: maxCandidates,
          endpoints: stats.byEndpoint,
          // Per-seed yields are NOT repeated here: `coverage.seeds` already carries them, and two
          // projections of the same facts drift until whichever one a reader opens becomes the
          // truth. The spend block owes the endpoints and the per-call cost, which nothing else has.
          //
          // THE THREE BUDGETS ARE REPORTED SEPARATELY because they are three vendors with three
          // units and no exchange rate between them: MadeOnSol is metered in requests against a
          // shared daily allowance, Helius in CREDITS against an unshared monthly one, and the
          // keyless hosts in neither. A single "requests" total would hide which allowance a heavy
          // run actually spent. The endpoint carries NO credential — `label`, never `url`.
          rpcProvider: rpcEndpoint.provider,
          rpcEndpoint: rpcEndpoint.label,
          heliusCredits,
          heliusCreditCeilingPerCandidate: usingIndexedWalk ? indexedWalk.maxCreditsPerCandidate : null,
          plannedWorstCaseHeliusCredits: worstCaseCredits,
        },
        rpcRequests,
        rpcLoadShedEvents,
        historySource,
        // **The Dune leg, metered in its own units in its own block.** Folding it into `spend`
        // would imply a fourth budget commensurable with the other three, and it is not: MadeOnSol
        // is requests against a shared daily allowance, Helius credits against an unshared monthly
        // one, and Dune executions-plus-bytes against a shared monthly one where a FAILED execution
        // is billed exactly like a successful one. `estimatedCredits` is an ESTIMATE and is named
        // one: it applies the published 20 credits/MB to the bytes the vendor's own metadata
        // declared, and compute is billed on top. The only authoritative figure is POST /usage,
        // which lags minutes and lands in whole-credit jumps, so nothing here reads it.
        dune: (() => {
          const stats = duneClient?.stats() ?? null;
          return {
            used: usingDune,
            reason: !duneCredential.available
              ? duneCredential.rejected === null
                ? `${DUNE_KEY_ENV_VAR} is not set`
                : 'the key was present but malformed'
              : opts.ownershipOnly
                ? '--ownership-only skips every creation-derived reading'
                : opts.noDune
                  ? '--no-dune'
                  : null,
            rejected: duneCredential.rejected,
            unusableNote: duneUnusableNote,
            endpoint: duneCredential.label,
            creationQueryId: duneBounds.creationQueryId,
            coverageQueryId: duneBounds.coverageQueryId,
            executions: stats?.executions ?? 0,
            executionCeiling: duneBounds.maxExecutionsPerRun,
            requests: stats?.requests ?? 0,
            resultBytes: stats?.resultBytes ?? 0,
            estimatedCredits: stats?.estimatedExportCredits ?? 0,
            // The two halves of the monthly credit ceiling. `allowance` is what the guard saw
            // BEFORE the leg spent anything — `null` on a run that never reached Dune — and
            // `localEstimate` is what this run believes it took, computed from its own counters
            // because the vendor's counter lags by longer than a run lasts. Neither is the bill.
            allowance: duneAllowance,
            localEstimate: localCreditEstimate({
              executions: stats?.executions ?? 0,
              creditsPerExecution: duneBounds.worstCaseCreditsPerExecution,
              resultBytes: stats?.resultBytes ?? 0,
            }),
            rowsReturned: duneEnumeration?.rowsReturned ?? 0,
            unreadableRows: duneEnumeration?.unreadableRows ?? 0,
            walletsRefusedByShape: duneEnumeration?.walletsRefusedByShape ?? 0,
            // The BOUND, not the vendor's data. `derive and discard`: the probe holds table-wide
            // monthly counts, and what survives a run is which tables, from when, to when, and
            // whether the span had holes — which is what says what the count was allowed to claim.
            coverage:
              duneEnumeration === null ? null : coverageRecordRow(duneEnumeration.probe, duneEnumeration.coverage),
          };
        })(),
        // **What the LANE said it expected of this run, before it looked.** Carried verbatim from
        // `--predict` and evaluated by nothing here: the screen records the claim and measures the
        // outcome, and scoring one against the other is the grading lane's job — a tool that graded
        // its own predictions would be marking its own paper. Deliberately NOT `predictions`, which
        // is the screen's own per-candidate claim summary further down. `null` means NOTHING WAS
        // PREDICTED, the normal state of a run made without the flag, and is not "the predictions
        // failed".
        declaredPredictions,
        elapsedMs: Date.now() - startedAt,
        // `completed` is whether the run reached the end; `truncated` is whether anything is
        // missing for any reason. A completed run whose candidate cap bit is truncated but NOT
        // incomplete, and only the second may be read as a measured outcome.
        completed,
        truncated: truncation.truncated || scoringShortfall !== null,
        truncationReason: reasons.length === 0 ? null : redactVendorIdentifiers(reasons.join('; ')),
        // What the tool could not look at, and why. A record that reports an unmeasured candidate
        // has to say so at the run level too, or the run reads as having measured everything.
        unmeasured,
        coverage,
        scoringCap: { max: maxScored, survivorsUnscored: scoringTruncatedBy, enabled: opts.stage2 },
        // Run-level Stage 2 drop tally, broken out by cause. `mintTimeDisagreement` is the one to
        // read: it says the vendor's mint time and pump.fun's fills contradicted each other, which
        // on our own tape never happens, so a non-zero value in a committed record is the evidence
        // that the assumption has broken on strangers.
        entryDrops: (() => {
          const by = candidates.reduce(
            (acc, c) => (c.entryCoverage === null ? acc : addDropReasons(acc, c.entryCoverage.dropsByReason)),
            emptyDropReasons(),
          );
          return { total: totalDrops(by), byReason: by };
        })(),
        prefilteredOut: prefiltered,
        thresholds: {
          stage1_gate: T['stage1_gate'],
          stage2_entry: T['stage2_entry'],
          stage2_cost: T['stage2_cost'],
          budget: T['budget'],
          creation_walk: T['creation_walk'],
          dune: T['dune'],
        },
        stage0: summariseStage0(stage0),
        limitations: LIMITATIONS,
        // Schema 16. WHAT THIS RUN PREDICTED, counted — the recording half of the feedback loop. A
        // run without it is permanently unfalsifiable, because neither the claim nor the instant it
        // stops being in-sample can be reconstructed after the fact. These are CLAIMS and never
        // results: `grade.mjs` scores them against launches made after `outOfSampleAfterIso`, and a
        // committed record is never retro-edited to carry a grade. `prediction.mjs` owns the shape,
        // including why `subjectsDeferred` records Stage 3's absence rather than omitting it.
        predictions: { ...summarisePredictions(rows), outOfSampleAfterIso: finishedAtIso },
        candidates: rows,
      },
    };
  }

  /**
   * Render and persist. One path, so `--out` and `--json` behave identically whether the run
   * finished or stopped early — but an incomplete run is labelled as one and written to a
   * DIFFERENT file. See {@link partialOutPath}.
   *
   * @param {number} code
   */
  function emit(code) {
    const { ranked, record } = buildRecord();

    if (opts.json) out(JSON.stringify(record, null, 2));
    else {
      out('');
      out(
        renderStage1({
          candidates: ranked,
          keyedRequests: record.keyedRequests,
          keylessRequests: record.keylessRequests,
          keylessShed: record.keylessShed,
          rpcRequests: record.rpcRequests,
          rpcLoadShedEvents: record.rpcLoadShedEvents,
          historySource: record.historySource,
          elapsedMs: record.elapsedMs,
          startedAtIso,
          completed: record.completed,
          truncationReason: record.truncationReason,
          prefiltered: prefiltered.length,
          coverage: record.coverage,
          spend: record.spend,
          unmeasured: record.unmeasured,
          thresholds: T['stage1_gate'],
        }),
      );
      if (!record.completed) {
        out('');
        out(`RUN STOPPED EARLY — exit ${code}. The above is an INCOMPLETE run, not a screen.`);
      }
    }

    if (opts.out !== null) {
      const target = record.completed ? resolve(opts.out) : partialOutPath(resolve(opts.out));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      if (!opts.json) {
        out(
          record.completed
            ? `\nrun record written to ${opts.out}`
            : `\nINCOMPLETE run record written to ${partialOutPath(opts.out)}` +
                `\n  (${opts.out} was left untouched — an aborted retry must not destroy a good record)`,
        );
      }
    }
  }
}

/**
 * Where an incomplete run's record goes.
 *
 * A truncated record must never land on the path a complete one would use. The README's own
 * documented invocation is `--out runs/$(date +%F).json`, so a same-day rerun that dies on a 401 or
 * a 429 would otherwise overwrite that day's good record with `candidates: []` — and run records are
 * the grading lane's declared input. Both artefacts have to survive, which is why this is a distinct
 * name rather than a refusal to write.
 *
 * @param {string} path
 * @returns {string}
 */
export function partialOutPath(path) {
  return path.endsWith('.json') ? `${path.slice(0, -'.json'.length)}.partial.json` : `${path}.partial.json`;
}

/**
 * Project a candidate onto the row that may be persisted.
 *
 * **This is the ToS clause 5a(d) containment, implemented rather than promised.** What survives a
 * run is a derived statistic: five numbers and a verdict per wallet. What does not survive is every
 * per-token record the numbers were computed from — no mint, no token name, no symbol, no market
 * cap, no bond time, no per-token row of any kind. Roughly 70 vendor records per wallet are read,
 * reduced, and dropped when the process exits.
 *
 * The wallet address is ours to keep: it is public on-chain data, not vendor data. The counts and
 * the rate are our computation. Nothing here can reconstruct any part of their database.
 *
 * Every FREE-TEXT field here — `rationale`, `gateReasons`, `consistency.note` — is routed through
 * `record.mjs` → `redactVendorIdentifiers`, as {@link toEntryRecordRow} routes its own. Structured
 * fields are not, deliberately: `wallet` is base58 of exactly the shape the redactor strikes, so a
 * blanket sweep would delete the one identifier this record exists to carry.
 *
 * @param {import('./rank.mjs').Candidate} c
 * @param {{ madeAtIso: string, thresholdsVersion: string | number | null }} run The run-level facts
 *   a prediction has to carry to be self-contained: the out-of-sample boundary and the bars in force.
 */
function toRecordRow(c, run) {
  return {
    wallet: c.wallet,
    seededBy: c.seededBy,
    // What the gate actually read. Under the default `historySource` this is the creation-derived
    // history; under --ownership-only it is the vendor reading and identical to `vendorTokens`.
    tokens: c.completion.tokens,
    completed: c.completion.completed,
    completionRate: Number.isFinite(c.completion.rate) ? Number(c.completion.rate.toFixed(6)) : null,
    spanDays: Number(c.completion.spanDays.toFixed(2)),
    windowFirstDeploy: c.completion.firstDeployIso,
    windowLastDeploy: c.completion.lastDeployIso,
    vendorPageCapped: c.vendorPageCapped,
    gateReadingPageCapped: c.completionCapped,
    historySource: c.historySource,
    // The OLD reading, kept whole and beside the new one. `vendorVerdict` is what this run would
    // have decided before the correction, so the gap is a diff in the record rather than an
    // archaeology exercise across two runs.
    vendorTokens: c.vendorCompletion.tokens,
    vendorCompleted: c.vendorCompletion.completed,
    vendorCompletionRate: Number.isFinite(c.vendorCompletion.rate)
      ? Number(c.vendorCompletion.rate.toFixed(6))
      : null,
    vendorSpanDays: Number(c.vendorCompletion.spanDays.toFixed(2)),
    vendorVerdict: c.vendorVerdict,
    // Only a MEASURED gate verdict can differ from the vendor's. `gate-unmeasured` is not a
    // different answer to the same question, it is the absence of one, and recording it as a
    // changed verdict would put it into the very gap-tracking figure this record exists to keep
    // honest. The `verdict` field carries the state; this flag stays a comparison of two results.
    verdictChanged: c.verdict !== 'gate-unmeasured' && c.verdict !== c.vendorVerdict,
    // Structured throughout EXCEPT `stopDetail` (a raw upstream `Error.message`) and
    // `listingUnmeasuredNote` (built from one), so those two — and only those two — are routed
    // through the redaction boundary. See `record.mjs` → `redactCreationNotes`.
    creation: redactCreationNotes(c.creation),
    verdict: c.verdict,
    // FREE TEXT, so it goes through the redaction boundary — the same one `toEntryRecordRow`
    // applies to its half. These three are all template-generated from counts and rates today
    // (`rank.mjs` → `verdictFor` / `applyGate` / `measureConsistency`), so nothing leaks now; the
    // point is that containment must not go back to depending on every future writer remembering,
    // which is how a mint reached `coverage.dropNotes` in the first place.
    // NOT A BLANKET SWEEP: `wallet` above is a 44-character base58 string this record deliberately
    // keeps, and `redactVendorIdentifiers` would strike it. Only free text is routed.
    rationale: redactVendorIdentifiers(c.rationale),
    gateReasons: redactAll(c.gate.reasons),
    consistency:
      c.consistency === null
        ? null
        : { ...c.consistency, note: redactVendorIdentifiers(c.consistency.note) },
    // Stage 2's own projection, which is subject to the same containment: quantiles, counts and a
    // hit rate over pump.fun's public fills. No mint — Stage 2 held a list of them in memory to do
    // the walk and dropped it — and no counterparty wallet address.
    entry: c.entry === null || c.entryCoverage === null ? null : toEntryRecordRow(c.entry, c.entryCoverage),
    // Schema 16. THE EXPLICIT, SCOREABLE CLAIM — derived from the verdict directly above it and from
    // nothing else, so this block can never disagree with the finding it restates. It reads no
    // surface, spends no request and moves no bar; a test asserts a run's verdicts are identical
    // with it present and absent. `prediction.mjs` owns why an unmeasured verdict yields NO claim
    // rather than "not beatable", and why the claims are a list (Stage 3 is deferred, not cancelled).
    prediction: buildPredictionBlock({
      entry: c.entry,
      madeAtIso: run.madeAtIso,
      gateReading: c.historySource,
      thresholdsVersion: run.thresholdsVersion,
    }),
  };
}

/** @param {import('./stage0.mjs').Stage0Result} s */
function summariseStage0(s) {
  /** @param {import('./entry.mjs').EntryScore} e */
  const control = (e) => ({
    verdict: e.verdict,
    launchesSampled: e.launchesSampled,
    roomLeftMedian: Number(e.roomLeft.median.toFixed(4)),
    // Schema 14, captain decision 208b: the median does not travel alone, on this surface either.
    // Stage 0's controls run over the committed tape, where the union rule refuses nothing and the
    // tape carries no drops — so this reads a degenerate `[median, median]` today. That is the
    // honest reading rather than a vacuous field: it is what says the control's figures are whole,
    // and a tape or a rule that stopped making them whole would show here rather than nowhere.
    roomLeftBound: {
      lo: Number(e.roomLeftBound.lo.toFixed(4)),
      hi: Number(e.roomLeftBound.hi.toFixed(4)),
      overstatementMax: Number(e.roomLeftBound.overstatementMax.toFixed(4)),
      launchesMissing: e.roomLeftBound.launchesMissing,
      launchesRefusedMeasured: e.roomLeftBound.launchesRefusedMeasured,
    },
    fieldClosedRoundTrips: e.fieldClosedRoundTrips,
    fieldHitRateGrossOfFees: Number(e.fieldHitRateGrossOfFees.rate.toFixed(4)),
    fieldRealisedMedianSolGrossOfFees: Number(e.fieldRealisedSolGrossOfFees.median.toFixed(4)),
  });

  return {
    passed: s.passed,
    failures: s.failures,
    groundTruth: {
      tokens: s.groundTruth.tokens,
      completed: s.groundTruth.completed,
      rate: Number(s.groundTruth.rate.toFixed(6)),
      spanDays: Number(s.groundTruth.spanDays.toFixed(2)),
    },
    subjectVerdict: s.subjectVerdict.verdict,
    subjectVerdictMeaning:
      'The gate PASSES our subject deployer, whose opening window is known to be unprofitable for ' +
      'outsiders since 2026-06-04. Passing this gate does not mean a deployer is worth the time.',
    curveInversionMaxErrorSol: s.curveCheck.maxAbsErrorSol,
    fieldReproduction: {
      pairs: s.fieldCheck.pairs,
      closureMismatches: s.fieldCheck.closureMismatches,
      missingFromCsv: s.fieldCheck.missingFromCsv,
      maxRealisedErrorSol: s.fieldCheck.maxRealisedErrorSol,
      ok: s.fieldCheck.ok,
    },
    knownNegativeControl: {
      wallet: SUBJECT_DEPLOYER,
      meaning:
        'Stage 2 must NOT score this wallet as having entry room. It is competent (the gate passes ' +
        'it) and it is not beatable — measured in analysis/window-population/README.md §4.1 and ' +
        '§4.3 over the committed tape, and asserted by test/window-population.test.ts, not assumed. ' +
        'Note that the field leg, gross of fees, says the opposite: a verdict that follows ' +
        'it would be wrong, which is why the field can only veto and never pass.',
      recentLaunches: control(s.subjectEntryRecent),
      postBreakRegime: control(s.subjectEntryPostBreak),
    },
    stage2SeamReproduction: s.eraSplit.map((e) => ({
      era: e.era,
      // From schema 5 on, `n` counts only the SCORED launches in the era — those whose create slot
      // the co-ordination rule marked something in. `nRoomUnproven` is the refused remainder,
      // persisted so a reader can add them back and see why an era's `n` differs from a schema-4
      // record's. From schema 11 the rule is the UNION, so era 2 reads n 89 / nRoomUnproven 0 where
      // a schema-5..10 record reads 86 / 3 over the same tape.
      n: e.n,
      nRoomUnproven: e.nRoomUnproven,
      // Persisted so a reader can see the comparison was not vacuous: an empty bucket yields a NaN
      // median that no inequality catches, so `n >= minN` is what makes a PASSED here mean anything.
      minN: e.minN,
      operationShareMeasured: Number(e.operationShareMedian.toFixed(4)),
      operationSharePublished: e.publishedOperationShare,
    })),
    // The control that would have caught the unproven-opening defect. Persisted so a saved run
    // carries evidence that it ran and what it found, rather than only that Stage 0 exited 0.
    rollingRoom: {
      windows: s.rollingRoom.windows,
      present: s.rollingRoom.present,
      absent: s.rollingRoom.absent,
      unmeasured: s.rollingRoom.unmeasured,
      falsePositives: s.rollingRoom.falsePositives,
      falseNegatives: s.rollingRoom.falseNegatives,
      ok: s.rollingRoom.ok,
    },
    // Schema 11. The tripwire on the block-index signal half (b) of the co-ordination rule reads.
    // Persisted because its failure mode is SILENT and towards refusal: a moved `sid` format makes
    // every anchored run collapse to length 1, and a saved run with `withRun` short of `launches`
    // is the only durable evidence of when that started.
    adjacencyRuns: {
      era: s.adjacencyRuns.era,
      launches: s.adjacencyRuns.launches,
      minLaunches: s.adjacencyRuns.minLaunches,
      withRun: s.adjacencyRuns.withRun,
      minRunTx: s.adjacencyRuns.minRunTx,
      createSlotFills: s.adjacencyRuns.createSlotFills,
      unreadableIndexes: s.adjacencyRuns.unreadableIndexes,
      slotPrefixMismatches: s.adjacencyRuns.slotPrefixMismatches,
      txWithTwoIndexes: s.adjacencyRuns.txWithTwoIndexes,
      cohortInstances: s.adjacencyRuns.cohortInstances,
      cohortRecovered: s.adjacencyRuns.cohortRecovered,
      falseMarks: s.adjacencyRuns.falseMarks,
      ok: s.adjacencyRuns.ok,
    },
    // The cost leg's own regression, persisted for the same reason: it is the ONE control that
    // establishes the direction of the whole fee correction — netting measured fees must move the
    // field DOWN — and `passed: true` alone cannot say by how much, or over what.
    onChainCostReproduction: {
      launchesPriced: s.costCheck.launchesPriced,
      minLaunches: s.costCheck.minLaunches,
      entriesPriced: s.costCheck.entriesPriced,
      entries: s.costCheck.entries,
      pairsPriced: s.costCheck.pairsPriced,
      minPairs: s.costCheck.minPairs,
      entryCostMedianSol: Number(s.costCheck.entryCostMedianSol.toFixed(6)),
      entryCostPerSolStakedMedianByEntry: Number(
        s.costCheck.entryCostPerSolStakedMedianByEntry.toFixed(6),
      ),
      entryCostPerSolStakedMedianByLaunch: Number(
        s.costCheck.entryCostPerSolStakedMedianByLaunch.toFixed(6),
      ),
      entryCostPositiveShare: Number(s.costCheck.entryCostPositiveShare.toFixed(4)),
      minEntryCostPositiveShare: s.costCheck.minEntryCostPositiveShare,
      // Schema 7: the same three figures over the UNFILTERED population, so the record says which
      // population its identically named keys above mean rather than leaving it to context.
      includingUnprovenLaunchesPriced: s.costCheck.includingUnprovenLaunchesPriced,
      includingUnprovenPairsPriced: s.costCheck.includingUnprovenPairsPriced,
      includingUnprovenEntryCostPerSolStakedMedianByLaunch: Number(
        s.costCheck.includingUnprovenEntryCostPerSolStakedMedianByLaunch.toFixed(6),
      ),
      grossHitRate: Number(s.costCheck.grossHitRate.toFixed(4)),
      netHitRate: Number(s.costCheck.netHitRate.toFixed(4)),
      grossMedianSol: Number(s.costCheck.grossMedianSol.toFixed(6)),
      netMedianSol: Number(s.costCheck.netMedianSol.toFixed(6)),
      flipsPositiveToNegative: s.costCheck.flipsPositiveToNegative,
      // The known-negative control run through the whole new ladder WITH its costs attached. It is
      // refused by ROOM and only room — the net field leg does not veto it, and asserting that it
      // did would pin a property the evidence does not support.
      postBreakVerdict: s.costCheck.postBreakScore.verdict,
      ok: s.costCheck.ok,
    },
  };
}

// --- entry point ---------------------------------------------------------------------------
// `import.meta.main` is not available on the Node 20 floor, so compare argv[1] instead.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

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
