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
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
    .map((w) => ({ mint: w.mint, deployedAtMs: Date.parse(w.mintedUtc) }))
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

/** @param {number | null | undefined} x */
const fmt = (x) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(6) : 'n/a');

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt === -1 ? null : (argv[onlyAt + 1] ?? null);

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

  if (dryRun) {
    console.log('\n--dry-run: nothing was fetched.');
    return;
  }

  const rpcPacing = endpoint.provider === 'helius' ? heliusBounds.rpcMinIntervalMs : costBounds.rpcMinIntervalMs;
  let laneSpent = 0;
  let laneShed = 0;
  let keylessSpent = 0;
  let keylessShed = 0;
  /** @type {any[]} */
  const rows = [];

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
    /** @type {LaneUnmeasuredCause | null} */
    const laneCause = rpc === null ? 'lane-rpc-ceiling' : null;
    if (laneCause !== null) {
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
        laneUnmeasuredCause: laneCause,
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

    writeFileSync(
      join(HERE, 'result.json'),
      `${JSON.stringify(
        {
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
          spend: {
            keylessRequests: keylessSpent,
            keylessShed,
            rpcRequests: laneSpent,
            rpcShed: laneShed,
          },
          candidates: rows,
        },
        null,
        2,
      )}\n`,
    );
  }

  console.log(
    `\nDONE — ${rows.length} candidate(s). swap-api ${keylessSpent} request(s) (${keylessShed} shed); ` +
      `${endpoint.label} ${laneSpent}/${LANE_RPC_CEILING} request(s) (${laneShed} shed).`,
  );
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  await main();
}
