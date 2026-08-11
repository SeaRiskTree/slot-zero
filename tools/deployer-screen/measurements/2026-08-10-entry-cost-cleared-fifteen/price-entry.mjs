/**
 * Price the entry cost of the 15 candidates that cleared the room bar, through production Stage 2.
 *
 * The room census (`slot-zero-july-stage3-census` → `report.md`, held in firstmate's records, not in
 * this repo) found the first candidates in this project's history to clear
 * `stage2_entry.minRoomLeft` 0.55, and explicitly did NOT price what it costs to land in their
 * windows. Without that price there is no Stage 3 count: captain decision 136b is that a room figure
 * with the price of the seat unmeasured beside it is not an answer to "is this enterable".
 *
 * ## It re-implements no rule, and that is the whole design
 *
 * The cost arithmetic, the verdict ladder and every bar are `stage2.mjs` → `scoreLaunchRefsEntry`'s,
 * called unchanged. This file supplies three things and decides nothing:
 *
 *   1. the POPULATION — the census's own pinned windows, copied verbatim into `census-input.json`;
 *   2. the CLIENTS — a keyless swap-api client at the pinned Stage 2 bounds, and a Solana RPC client
 *      for the cost leg;
 *   3. a LANE-WIDE spend ceiling, because 15 candidates at the pinned per-candidate ceiling is more
 *      than this lane was authorised to spend.
 *
 * Every threshold is read from `thresholds.json` at run time. Nothing here holds a copy of one, so a
 * bar cannot be moved from this directory.
 *
 * ## The transport is Helius, and that is this lane's one deviation from a screen run
 *
 * `screen.mjs` builds the cost leg's `SolanaRpcClient` with no `endpoint`, so a screen run prices on
 * `api.mainnet-beta` at `stage2_cost.rpcMinIntervalMs` (2.5s) whether or not a Helius key is set —
 * the indexed endpoint reaches only the creation walk. The captain chose the faster source for this
 * lane (2026-08-10: *speed is the priority here, not saving credits*), so the endpoint comes from
 * `credential.mjs` → `resolveSolanaRpcEndpoint`, the repo's only chooser, and the pacing is the
 * pinned Helius one (`creation_walk_helius.rpcMinIntervalMs`) rather than the public endpoint's.
 * **Pacing is a property of the host, not of the measurement**: the 2.5s exists because
 * `api.mainnet-beta` rate-limits globally across methods, which Helius does not. No bar, scope or
 * cost rule moves with the endpoint — `readCreateSlotCosts` reads the same `meta.fee` and the same
 * pre/post balance deltas either way.
 *
 * With no key resolved the endpoint falls back to the public one, and the run is a slow keyless one
 * rather than a wrong one; {@link main} prints which it got.
 *
 * ## The spend bound is structural, not a projection
 *
 * A pre-flight estimate is not a bound. `SolanaRpcClient` checks its ceiling immediately before
 * every attempt, retries included, so `maxRequests` is an EXACT cap on attempts — and on this
 * provider every method this leg calls (`getTransaction`, `getBlock`) is a 1-credit standard method,
 * so attempts are an exact upper bound on credits. This lane therefore carries a single
 * `LANE_RPC_CEILING` and hands each candidate `min(<the pinned per-candidate ceiling>, what is left
 * of the lane)`. The sum across candidates cannot exceed the lane ceiling, whatever the endpoint
 * does. A candidate whose share runs out is reported UNMEASURED with that cause — never as a
 * candidate that failed the cost gate.
 *
 * ## What this cannot do
 *
 * Helius publishes no usage or credit-balance endpoint reachable with this key — probed
 * 2026-08-10 — and returns no credit header on an RPC response, so "read live usage before and
 * after" is not available here. The request counters below are reported instead, and they are an
 * upper bound rather than an estimate.
 *
 * `node price-entry.mjs [--dry-run] [--only <wallet>]`. **`--dry-run` prints the plan and opens no
 * socket**; a bare invocation walks and spends.
 *
 * **A `--only` run writes beside the published artifact, never over it** — see {@link resultPathFor}
 * — {@link assertResultPathWritable} refuses a narrower record over a wider one before the first
 * request, and {@link openResultWriter} keeps the per-candidate snapshots off the published path
 * until the run finishes wide enough to earn it. The pre-flight check alone is NOT sufficient and
 * that writer's doc says why.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSolanaRpcEndpoint } from '../../credential.mjs';
import { KeylessClient, SolanaRpcClient } from '../../pumpfun.mjs';
import { rpcCostSource } from '../../rpc-costs.mjs';
import { scoreLaunchRefsEntry } from '../../stage2.mjs';
import { swapApiFillSource } from '../../swapapi-fills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREEN = join(HERE, '..', '..');

/**
 * The lane's whole Solana RPC exposure, in requests.
 *
 * The captain's hard stop is 1,500 Helius credits. This sits below it with headroom for the shed
 * retries a counter cannot predict, and it is enforced by handing out client ceilings that sum to
 * it — not by watching a total and stopping when it looks close.
 */
export const LANE_RPC_CEILING = 1400;

/** The captain's hard stop, recorded so the run record states what the ceiling was chosen against. */
export const LANE_CREDIT_HARD_STOP = 1500;

/**
 * Why a candidate has no cost reading. Kept as a closed set beside `entry.mjs` → `UNMEASURED_CAUSES`
 * rather than folded into it: these are THIS LANE's coverage, not Stage 2's, and conflating the two
 * would let a lane budget wear a measurement's clothes — the failure captain decision 174b names.
 *
 * @typedef {'lane-rpc-ceiling'} LaneUnmeasuredCause
 */

/**
 * @typedef {object} CensusCandidate
 * @property {string} deployer
 * @property {string} arm
 * @property {number} lifetimeCompletionRate
 * @property {number} censusRoomMedian
 * @property {number} censusBoundLo
 * @property {number} censusBoundHi
 * @property {string} censusVerdict
 * @property {string} censusUnmeasuredCause
 * @property {number} censusWindowsPlanned
 * @property {number} censusProven
 * @property {{ mint: string, mintedUtc: string, censusProven: boolean, censusRoomLeft: number | null,
 *   censusDevSol: number | null }[]} windows
 */

/**
 * The launch list Stage 2 scores, from the census's own pinned selection.
 *
 * **The mint instant is NOT backdated, deliberately.** `bundling.mjs` → `MINT_TIME_BACKDATE_CAVEAT`
 * backdates by a pinned margin because its mint times come from `frontend-api-v3`, which carries
 * millisecond precision against swap-api's floored whole seconds — and that module's own comment
 * says in terms that copying the line into a FULL-WINDOW walk is a bug, because `readLaunchWindow`
 * seeks at `createdAtMs + windowReachMs` and backdating pulls the newest instant reached 5s earlier.
 * This is a full-window walk (the field leg needs the closed round trips), and the census's mint
 * times are the chain's own block time on both sides — its §4.1 measured the backdate firing zero
 * times over all 24,708 windows. So the declared instant is used as-is and a genuine disagreement
 * is reported as the `mintTimeDisagreement` drop it is.
 *
 * @param {CensusCandidate} candidate
 * @returns {import('../../measure.mjs').LaunchRef[]} Newest first, as `toLaunchRefs` returns them.
 */
export function censusLaunchRefs(candidate) {
  return candidate.windows
    .map((w) => {
      const deployedAtMs = Date.parse(w.mintedUtc);
      if (!Number.isFinite(deployedAtMs)) {
        throw new Error(
          `census-input.json: ${candidate.deployer} window ${w.mint} carries an unparsable mintedUtc ` +
            `${JSON.stringify(w.mintedUtc)}. The census population is pinned; refusing rather than ` +
            `scoring a reshaped sample.`,
        );
      }
      return { mint: w.mint, deployedAtMs };
    })
    .sort((a, b) => b.deployedAtMs - a.deployedAtMs);
}

/**
 * What one candidate is allowed to spend, given what the lane has left.
 *
 * Separate and exported so the bound is testable without a socket. It never exceeds the pinned
 * per-candidate ceiling and never exceeds what remains, so summing it over the candidates is the
 * lane ceiling by construction.
 *
 * @param {number} pinnedPerCandidate `thresholds.json` → `stage2_cost.maxRpcRequestsPerCandidate`.
 * @param {number} laneSpent
 * @param {number} [laneCeiling]
 * @returns {number} Zero when nothing is left, which is a REFUSAL to start rather than a small budget.
 */
export function costCeilingFor(pinnedPerCandidate, laneSpent, laneCeiling = LANE_RPC_CEILING) {
  return Math.max(0, Math.min(pinnedPerCandidate, laneCeiling - laneSpent));
}

/**
 * Whether THIS LANE's ceiling — rather than the vendor or the chain — is why a candidate has no cost
 * reading.
 *
 * **It is derived from what happened to the leg, not from the leg never starting.** The first cut set
 * the cause only when the granted ceiling was exactly 0, and the lane never reached 0: the three
 * candidates it ran out on were granted 122, 17 and 8 requests and were truncated MID-leg. So the
 * documented mechanism never fired in the case it was written for, and the three read as an ordinary
 * `too-little-of-the-field-priced` — indistinguishable from a provider coverage failure to the only
 * reader that matters, the one taking the RECORDED cause rather than the prose.
 *
 * The two conjuncts are both necessary. A granted ceiling below the pinned one says the lane, not
 * `stage2_cost`, set the bound; the leg having stopped, skipped a launch for budget, or never been
 * granted a request at all says that bound actually bit. Without the second, every candidate scored
 * after the lane's budget started running down would be blamed on the lane whether or not it cost
 * them anything.
 *
 * **It sits BESIDE production's `unmeasuredCause` and never replaces it** (captain decision 174b):
 * production still says `too-little-of-the-field-priced` / `our-coverage`, and this refines WHOSE
 * coverage failed. Returns `null` on a candidate that reached a verdict, since there is nothing to
 * attribute.
 *
 * @param {object} args
 * @param {string} args.verdict Production's verdict for the candidate.
 * @param {number} args.ceilingGranted What {@link costCeilingFor} handed this candidate.
 * @param {number} args.pinnedPerCandidate `stage2_cost.maxRpcRequestsPerCandidate`.
 * @param {{ stoppedForBudget?: boolean, launchesSkippedForBudget?: number }} args.cost
 *   `coverage.cost`, as the production scorer reports it.
 * @returns {LaneUnmeasuredCause | null}
 */
export function laneUnmeasuredCauseFor({ verdict, ceilingGranted, pinnedPerCandidate, cost }) {
  if (verdict !== 'entry-cost-unmeasured') return null;
  if (ceilingGranted >= pinnedPerCandidate) return null;
  const bit =
    ceilingGranted === 0 || cost.stoppedForBudget === true || (cost.launchesSkippedForBudget ?? 0) > 0;
  return bit ? 'lane-rpc-ceiling' : null;
}

/**
 * Where a run writes, which is NOT one path.
 *
 * A `--only` run scores one candidate out of the census's fifteen, and the published artifact is the
 * whole-population one — so a partial run writes beside it rather than over it. Naming the wallet in
 * the file keeps two partial runs from colliding as well.
 *
 * @param {string | null} only The validated `--only` wallet, or `null` for a whole-population run.
 * @returns {string} An absolute path inside this directory.
 */
export function resultPathFor(only) {
  return join(HERE, only === null ? 'result.json' : `result-only-${only}.json`);
}

/**
 * Refuse to write over a record of MORE candidates than this run will produce.
 *
 * **The check runs before the first request, not before the first write.** A refusal after the walk
 * has already spent is not a refusal — this lane's other three guards (the lane ceiling, `--only`'s
 * own validation and the mint-instant check) all refuse up front, and this is the same rule for the
 * output side: a run that cannot legally publish its result should never have been paid for.
 *
 * Re-running the SAME population is still allowed, since that is an honest replacement.
 *
 * @param {string} path Where the run intends to write.
 * @param {number} candidatesToScore How many candidates this run will score.
 * @param {(p: string) => string | null} [readIfPresent] Seam for the test; reads the file or returns
 *   `null` when it does not exist.
 */
export function assertResultPathWritable(path, candidatesToScore, readIfPresent = readFileIfPresent) {
  const existing = readIfPresent(path);
  if (existing === null) return;
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(existing);
  } catch {
    // An unreadable artifact is not evidence that overwriting it is safe.
    throw new Error(`${path} exists and is not readable JSON. Refusing to overwrite it.`);
  }
  const held = Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0;
  if (held > candidatesToScore) {
    throw new Error(
      `${path} already holds ${held} candidate(s) and this run scores ${candidatesToScore}. Refusing ` +
        `to replace a wider record with a narrower one, before the first request.`,
    );
  }
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function readFileIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * How many candidates a record holds, or 0 when there is no readable record.
 *
 * @param {string | null} text
 * @returns {number}
 */
function candidatesHeld(text) {
  if (text === null) return 0;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0;
  } catch {
    return 0;
  }
}

/**
 * The run's persistence, which keeps the published artifact intact until the run has earned it.
 *
 * **THE PRE-FLIGHT CHECK IS NOT ENOUGH, AND THE REASON IS THE INCREMENTAL WRITE.** This lane
 * snapshots after every candidate so a walk that dies at candidate 12 does not throw away eleven
 * candidates of paid-for work. Writing those snapshots straight to the published path — which is
 * what this file did until this writer existed — means a run that PASSES
 * {@link assertResultPathWritable} at 15-against-15 still replaces the published fifteen with a
 * single row the instant candidate 1 finishes, and any abort after that (a signal, a throw out of
 * the scorer, a client's own ceiling) leaves it replaced. The count is only whole at the very end,
 * so a guard that runs only at the start guards only the start.
 *
 * So the snapshots go to a `.partial` sibling and the published path is written **once**, by
 * {@link ResultWriter.publish}, and only when the finished record is at least as wide as whatever is
 * already published. The published count is re-read at publish time rather than trusted from open
 * time, so a record that grew underneath the run is not clobbered either.
 *
 * The property, stated so a test can hold it: **an aborted or narrower run leaves the published
 * record byte-identical.**
 *
 * @param {string} publishedPath
 * @param {object} [io] Seam so the behaviour is testable without a socket or the metered run.
 * @param {(p: string) => string | null} [io.read]
 * @param {(p: string, body: string) => void} [io.write]
 * @param {(from: string, to: string) => void} [io.promote]
 */
export function openResultWriter(publishedPath, io = {}) {
  const read = io.read ?? readFileIfPresent;
  const write = io.write ?? ((/** @type {string} */ p, /** @type {string} */ b) => writeFileSync(p, b));
  const promote = io.promote ?? ((/** @type {string} */ f, /** @type {string} */ t) => renameSync(f, t));
  const partialPath = `${publishedPath}.partial`;
  const heldAtOpen = candidatesHeld(read(publishedPath));

  /** @param {any} record */
  const body = (record) => `${JSON.stringify(record, null, 2)}\n`;

  return {
    partialPath,
    /**
     * Persist progress so far. It NEVER touches the published path.
     *
     * @param {any} record
     */
    snapshot(record) {
      write(partialPath, body(record));
    },
    /**
     * Promote the finished record onto the published path, or refuse.
     *
     * @param {any} record
     */
    publish(record) {
      const scored = Array.isArray(record?.candidates) ? record.candidates.length : 0;
      const heldNow = Math.max(heldAtOpen, candidatesHeld(read(publishedPath)));
      if (scored < heldNow) {
        throw new Error(
          `${publishedPath} holds ${heldNow} candidate(s) and this run finished with ${scored}. ` +
            `Refusing to publish a narrower record; the run's own output is at ${partialPath}.`,
        );
      }
      write(partialPath, body(record));
      promote(partialPath, publishedPath);
    },
  };
}

/** @param {number | null | undefined} x */
const fmt = (x) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(6) : 'n/a');

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const onlyAt = argv.indexOf('--only');
  /** @type {string | null} */
  let only = null;
  if (onlyAt !== -1) {
    const value = argv[onlyAt + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--only needs a deployer address; it was given none. Refusing before the first request.');
    }
    only = value;
  }

  /** @type {any} */
  const thresholds = JSON.parse(readFileSync(join(SCREEN, 'thresholds.json'), 'utf8'));
  /** @type {import('../../stage2.mjs').Stage2Thresholds} */
  const entryThresholds = thresholds.stage2_entry;
  /** @type {any} */
  const costBounds = thresholds.stage2_cost;
  /** @type {any} */
  const heliusBounds = thresholds.creation_walk_helius;

  /** @type {any} */
  const input = JSON.parse(readFileSync(join(HERE, 'census-input.json'), 'utf8'));
  /** @type {CensusCandidate[]} */
  const candidates = input.candidates.filter(
    (/** @type {CensusCandidate} */ c) => only === null || c.deployer === only,
  );
  if (only !== null && candidates.length === 0) {
    throw new Error(
      `--only ${only} matches no deployer in census-input.json. Refusing before the first request.`,
    );
  }

  const resultPath = resultPathFor(only);

  const endpoint = resolveSolanaRpcEndpoint(process.env);
  const startedAtIso = new Date().toISOString();

  console.log(`thresholds ${thresholds.version} — minRoomLeft ${entryThresholds.minRoomLeft}, ` +
    `maxEntryCostPerSolStaked ${costBounds ? thresholds.stage2_entry.maxEntryCostPerSolStaked : '?'}`);
  console.log(`candidates ${candidates.length}, windows ${candidates.reduce((n, c) => n + c.windows.length, 0)}`);
  console.log(`fill source: swap-api, ${entryThresholds.keylessMinIntervalMs}ms pacing, ` +
    `${entryThresholds.maxRequestsPerLaunch} request(s)/launch`);
  console.log(`cost source: ${endpoint.label} (${endpoint.provider}), ` +
    `${endpoint.provider === 'helius' ? heliusBounds.rpcMinIntervalMs : costBounds.rpcMinIntervalMs}ms pacing, ` +
    `<=${costBounds.maxRpcRequestsPerCandidate} request(s)/candidate`);
  if (endpoint.rejected !== null) console.log(`  NOTE: ${endpoint.rejected}`);
  console.log(`lane ceiling ${LANE_RPC_CEILING} RPC request(s) against a ${LANE_CREDIT_HARD_STOP}-credit hard stop`);
  console.log(`writes ${resultPath}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing was fetched.');
    return;
  }

  assertResultPathWritable(resultPath, candidates.length);
  const writer = openResultWriter(resultPath);

  const rpcPacing = endpoint.provider === 'helius' ? heliusBounds.rpcMinIntervalMs : costBounds.rpcMinIntervalMs;
  let laneSpent = 0;
  let laneShed = 0;
  let keylessSpent = 0;
  let keylessShed = 0;
  /** @type {any[]} */
  const rows = [];

  const recordOf = () => ({
    lane: '2026-08-10-entry-cost-cleared-fifteen',
    startedAtIso,
    finishedAtIso: new Date().toISOString(),
    thresholdsVersion: thresholds.version,
    censusInput: input.source,
    fillSourceKind: 'swap-api',
    costEndpointLabel: endpoint.label,
    costEndpointProvider: endpoint.provider,
    costEndpointRejected: endpoint.rejected,
    costPacingMs: rpcPacing,
    laneRpcCeiling: LANE_RPC_CEILING,
    laneCreditHardStop: LANE_CREDIT_HARD_STOP,
    // The coverage floor the roll-up gates cost readings on, recorded rather than restated there:
    // `summarise.mjs` refuses a record that does not carry it instead of defaulting, so a roll-up
    // can never report against a bar this run did not apply.
    thresholdsMinPricedFraction: entryThresholds.minPricedFraction,
    spend: {
      keylessRequests: keylessSpent,
      keylessShed,
      rpcRequests: laneSpent,
      rpcShed: laneShed,
    },
    candidates: rows,
  });

  for (const c of candidates) {
    const refs = censusLaunchRefs(c);
    const planned = Math.min(refs.length, entryThresholds.maxLaunchesPerCandidate);
    console.log(`\n${c.deployer} — census room ${fmt(c.censusRoomMedian)}, ${refs.length} census window(s)`);

    const fillClient = new KeylessClient({
      // The pinned per-launch cap times the launches Stage 2 will plan. Same arithmetic as the
      // stage ceiling (`maxCandidatesScored x maxLaunchesPerCandidate x maxRequestsPerLaunch`),
      // divided by candidate so one busy deployer cannot eat the next one's walk.
      maxRequests: planned * entryThresholds.maxRequestsPerLaunch,
      minIntervalMs: entryThresholds.keylessMinIntervalMs,
      ...(entryThresholds.keylessRetryBackoffMs === undefined
        ? {}
        : { retryBackoffMs: entryThresholds.keylessRetryBackoffMs }),
    });
    const fillSource = swapApiFillSource(fillClient);

    const ceiling = costCeilingFor(costBounds.maxRpcRequestsPerCandidate, laneSpent);
    /** @type {SolanaRpcClient | null} */
    const rpc =
      ceiling === 0
        ? null
        : new SolanaRpcClient({ maxRequests: ceiling, endpoint, minIntervalMs: rpcPacing });
    if (rpc === null) {
      console.log(`  the lane RPC ceiling is spent — the cost leg is NOT run for this candidate`);
    }

    const { score, coverage } = await scoreLaunchRefsEntry(fillSource, {
      wallet: c.deployer,
      refs,
      nowMs: Date.now(),
      thresholds: entryThresholds,
      costSource: rpc === null ? null : rpcCostSource(rpc, { preferBlockRoute: costBounds.preferBlockRoute }),
      log: (line) => console.log(line),
    });

    keylessSpent += fillClient.issued();
    keylessShed += fillClient.shed();
    if (rpc !== null) {
      laneSpent += rpc.issued();
      laneShed += rpc.loadShedEvents();
    }

    console.log(
      `  verdict ${score.verdict}${score.unmeasuredCause === null ? '' : ` (${score.unmeasuredCause})`} — ` +
        `room ${fmt(score.roomLeft.median)} over ${score.launchesSampled}, ` +
        `cost/SOL staked per launch ${fmt(score.entryCostPerSolStakedByLaunch.median)}, ` +
        `priced ${score.entryCostPriced.hits}/${score.entryCostPriced.n}, ` +
        `lane spent ${laneSpent}/${LANE_RPC_CEILING}`,
    );

    rows.push({
      deployer: c.deployer,
      arm: c.arm,
      lifetimeCompletionRate: c.lifetimeCompletionRate,
      census: {
        roomMedian: c.censusRoomMedian,
        boundLo: c.censusBoundLo,
        boundHi: c.censusBoundHi,
        verdict: c.censusVerdict,
        unmeasuredCause: c.censusUnmeasuredCause,
        windowsPlanned: c.censusWindowsPlanned,
        proven: c.censusProven,
      },
      measuredToday: {
        verdict: score.verdict,
        unmeasuredCause: score.unmeasuredCause,
        unmeasuredCauseAttribution: score.unmeasuredCauseAttribution,
        laneUnmeasuredCause: laneUnmeasuredCauseFor({
          verdict: score.verdict,
          ceilingGranted: ceiling,
          pinnedPerCandidate: costBounds.maxRpcRequestsPerCandidate,
          cost: coverage.cost ?? {},
        }),
        rationale: score.rationale,
        launchesSampled: score.launchesSampled,
        launchesRoomUnproven: score.launchesRoomUnproven,
        roomLeft: score.roomLeft,
        roomLeftBound: score.roomLeftBound,
        roomHitRate: score.roomHitRate,
        devSol: score.devSol,
        fieldEntrants: score.fieldEntrants,
        fieldClosedRoundTrips: score.fieldClosedRoundTrips,
        fieldOpenPositions: score.fieldOpenPositions,
        fieldHitRateGrossOfFees: score.fieldHitRateGrossOfFees,
        fieldRealisedSolGrossOfFees: score.fieldRealisedSolGrossOfFees,
        entryCostSol: score.entryCostSol,
        entryCostPerSolStaked: score.entryCostPerSolStaked,
        entryCostPerSolStakedByLaunch: score.entryCostPerSolStakedByLaunch,
        entryTxFeeSol: score.entryTxFeeSol,
        entryCostPriced: score.entryCostPriced,
        fieldHitRateNetOfMeasuredFees: score.fieldHitRateNetOfMeasuredFees,
        fieldRealisedSolNetOfMeasuredFees: score.fieldRealisedSolNetOfMeasuredFees,
        fieldClosedRoundTripsPriced: score.fieldClosedRoundTripsPriced,
        caveats: score.caveats,
      },
      coverage: {
        launchRefsAvailable: coverage.launchRefsAvailable,
        minAgeMs: coverage.minAgeMs,
        launchesPlanned: coverage.launchesPlanned,
        launchesAttempted: coverage.launchesAttempted,
        launchesUsable: coverage.launchesUsable,
        launchesDropped: coverage.launchesDropped,
        dropsByReason: coverage.dropsByReason,
        dropNotes: coverage.dropNotes,
        requestsIssued: coverage.requestsIssued,
        stoppedForBudget: coverage.stoppedForBudget,
        cost: coverage.cost,
      },
      spend: {
        keylessRequests: fillClient.issued(),
        keylessShed: fillClient.shed(),
        rpcRequests: rpc === null ? 0 : rpc.issued(),
        rpcShed: rpc === null ? 0 : rpc.loadShedEvents(),
        rpcCeilingGranted: ceiling,
      },
    });

    writer.snapshot(recordOf());
  }

  writer.publish(recordOf());

  console.log(
    `\nDONE — ${rows.length} candidate(s). swap-api ${keylessSpent} request(s) (${keylessShed} shed); ` +
      `${endpoint.label} ${laneSpent}/${LANE_RPC_CEILING} request(s) (${laneShed} shed).`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
