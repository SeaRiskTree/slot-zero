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
 *   4  credential rejected (401/403) — on Free tier, most likely expired.
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

import { BoundedClient, CeilingReached, VendorRefused } from './client.mjs';
import { coveredBoundMs, mergeHistories } from './creation.mjs';
import { HELIUS_KEY_ENV_VAR, KEY_ENV_VAR, resolveKey, resolveSolanaRpcEndpoint } from './credential.mjs';
import { measureCompletion, toTokenRecords } from './measure.mjs';
import {
  RECORD_SCHEMA_VERSION,
  deriveTruncation,
  describeUnmeasured,
  redactAll,
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
import { applyGate, measureConsistency, rankCandidates, verdictFor } from './rank.mjs';
import { renderDryRun, renderStage0, renderStage1, LIMITATIONS } from './render.mjs';
import { addDropReasons, emptyDropReasons, scoreCandidateEntry, toEntryRecordRow, totalDrops } from './stage2.mjs';
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
  --dry-run           Print exactly what a real run would fetch, and fetch nothing.
  (default)           Stage 0, then Stage 1 (enumerate + gate), then Stage 2 (score entry room and
                      the field, keyless). Stage 0 must pass first.

OPTIONS
  --candidates <n>    Max deployers to gate. DEFAULT: as many as the request ceiling allows, so a
                      default run grades everything enumeration surfaces. Ceiling from
                      thresholds.json; this flag can only lower it.
  --max-requests <n>  Hard keyed-request ceiling. Cannot exceed the pinned budget, which is the
                      whole MadeOnSol Free-tier daily allowance. A plan whose worst case does not
                      fit under the ceiling is refused before the first request (exit 2).
  --tier <t>          Restrict enumeration to one tier: elite|good|moderate|rising|cold.
  --no-stage2         Skip entry scoring. Stage 1 only — the competence gate on its own, which
                      answers nothing about whether a window is enterable.
  --score <n>         Max gate survivors to score in Stage 2. Cannot exceed the pinned cap.
  --consistency       Also measure long-horizon consistency for gate survivors, via a keyless
                      pump.fun creator walk. Costs no MadeOnSol quota.
  --ownership-only    Gate on the OWNERSHIP reading alone and skip the creation-derived walk.
                      Fast and free of Solana RPC, and BIASED TOWARDS REJECTION — see below.
                      The record is stamped historySource: "ownership-only" so a run made this
                      way can never be mistaken for a creation-derived one.
  --out <path>        Write the run record as JSON. Default: nothing is written. An INCOMPLETE run
                      writes <path>.partial.json instead, leaving <path> untouched.
  --json              Print the run record as JSON instead of text.
  --data-dir <path>   Population tape location. Default data/population-tape-2026-07-29.
  --help              This text.

WHICH HISTORY THE GATE READS
  By default the gate reads a CREATION-DERIVED history: which tokens this wallet CREATED, recovered
  from pump.fun create transactions over the public Solana RPC. Keyless, and bounded by
  thresholds.json -> creation_walk.

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
  and never stored in this repository. Free-tier keys expire every 30 days; a rejected key exits 4
  with a specific message rather than an empty result.

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

  return { ok: true, opts };
}

/**
 * @typedef {object} Options
 * @property {boolean} stage0Only
 * @property {boolean} dryRun
 * @property {number | null} candidates
 * @property {number | null} maxRequests
 * @property {string | undefined} tier
 * @property {boolean} stage2
 * @property {number | null} scoreCandidates
 * @property {boolean} consistency
 * @property {boolean} ownershipOnly
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
 * `credentialRejected` tells an operator to rotate a key that is working perfectly, which on a tier
 * where keys expire every 30 days is a plausible and entirely wasted afternoon. It is an upstream
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
  // The pinned bounds are the whole Free-tier daily allowance, and both are hard: `--candidates`
  // and `--max-requests` can only ever lower them.
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
  // candidates at the worst measured per-candidate cost is 975,000 credits, near a tenth of the
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

  const resolution = resolveKey(env);

  if (opts.dryRun) {
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
        historySource,
        creationWalk: T['creation_walk'],
        costBounds,
        keyDescription: resolution.ok ? resolution.description : null,
        rpcEndpoint,
        indexedWalk,
        worstCaseCredits,
      }),
    );
    return EXIT.ok;
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

    if (!opts.json && !opts.ownershipOnly) {
      out('');
      out(
        usingIndexedWalk
          ? `GATING — creation-derived history, from pump.fun create transactions ` +
              `(indexed RPC, ${rpcEndpoint.label})`
          : 'GATING — creation-derived history, from pump.fun create transactions (keyless RPC)',
      );
      // A key that was present but unusable must not read as a deliberate keyless run.
      if (rpcEndpoint.rejected !== null) out(`  !! ${rpcEndpoint.rejected}`);
      else if (!usingIndexedWalk) {
        out(
          `  ${HELIUS_KEY_ENV_VAR} is not set, so this leg runs on the keyless public endpoint and ` +
            `is SLOWER, not different.`,
        );
      }
    }

    for (const seed of worthARequest.slice(0, maxCandidates)) {
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
        let rpcTicks = 0;
        // ONE per-candidate ceiling either way, in whichever unit the endpoint bills in. The
        // indexed route reads up to `maxPagesPerCandidate` pages and is bounded by CREDITS; the
        // keyless one reads up to `maxRpcRequestsPerCandidate` requests and is bounded by those.
        // Both are per-candidate, so one wallet's busy index cannot eat the next wallet's budget.
        const ceilingForCandidate = usingIndexedWalk
          ? indexedWalk.maxPagesPerCandidate + Math.ceil(indexedWalk.maxTransactionsPerCandidate / 100) + 1
          : walkBounds.maxRpcRequestsPerCandidate;
        const rpc = new SolanaRpcClient({
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
        const walk = usingIndexedWalk
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
        rpcRequests += rpc.issued();
        rpcLoadShedEvents += rpc.loadShedEvents();
        heliusCredits += usingIndexedWalk ? rpc.creditsSpent() : 0;

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
          rpcRequests: rpc.issued(),
          loadShedEvents: rpc.loadShedEvents(),
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
        };

        if (!opts.json) {
          out(
            `  ${seed.wallet}: created ${merged.createdInWindow} in the ${creation.coveredDays}d window ` +
              `(ownership showed ${merged.listedInWindow}; ${merged.hiddenByOwnership} hidden, ` +
              `${merged.notCreatedByWallet} acquired, ${merged.movedCreator} creator moved), ` +
              `+${merged.listedOutsideWindow} carried over — stopped on ${walk.stopReason}`,
          );
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
        const { score, coverage } = await scoreCandidateEntry(stage2Keyless, {
          wallet: c.wallet,
          profile: profiles.get(c.wallet),
          nowMs: Date.now(),
          thresholds: entryThresholds,
          rpc: costRpc,
          preferBlockRoute: costBounds.preferBlockRoute,
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
          `instead. The rest of the shared MadeOnSol daily allowance is unspent.`,
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
        finishedAtIso: new Date().toISOString(),
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
        },
        stage0: summariseStage0(stage0),
        limitations: LIMITATIONS,
        candidates: ranked.map(toRecordRow),
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
 */
function toRecordRow(c) {
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
    creation: c.creation,
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
  };
}

/** @param {import('./stage0.mjs').Stage0Result} s */
function summariseStage0(s) {
  /** @param {import('./entry.mjs').EntryScore} e */
  const control = (e) => ({
    verdict: e.verdict,
    launchesSampled: e.launchesSampled,
    roomLeftMedian: Number(e.roomLeft.median.toFixed(4)),
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
        'it) and it is not beatable — measured in data/slot-zero-june-regime-change/report.md, not ' +
        'assumed. Note that the field leg, gross of fees, says the opposite: a verdict that follows ' +
        'it would be wrong, which is why the field can only veto and never pass.',
      recentLaunches: control(s.subjectEntryRecent),
      postBreakRegime: control(s.subjectEntryPostBreak),
    },
    stage2SeamReproduction: s.eraSplit.map((e) => ({
      era: e.era,
      // From schema 5 on, `n` counts only the SCORED launches in the era — those whose create slot
      // carried a bundled transaction. `nRoomUnproven` is the refused remainder, persisted so a
      // reader can add them back and see why an era's `n` differs from a schema-4 record's.
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
