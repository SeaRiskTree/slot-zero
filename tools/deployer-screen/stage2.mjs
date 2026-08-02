/**
 * Stage 2 — ENTRY, the I/O half. Walks pump.fun's keyless fill tape and hands the fills to
 * `entry.mjs`, which does all the deciding.
 *
 * ## The bound, stated before the code
 *
 * Every provider call this makes is bounded three times over, and none of the bounds has a flag
 * that disables it:
 *
 * | bound | where | value |
 * |---|---|---|
 * | candidates scored | `thresholds.json` → `stage2_entry.maxCandidatesScored` | 3 |
 * | launches per candidate | `stage2_entry.maxLaunchesPerCandidate` | 8 |
 * | requests per launch, RETRIES INCLUDED | `stage2_entry.maxRequestsPerLaunch` | 18 |
 * | requests for the whole stage | `stage2_entry.maxKeylessRequests`, on its own client | 432 |
 *
 * `3 × 8 × 18 = 432` — the declared worst case and the stage ceiling are **the same number**, so no
 * plan-level truncation is possible and the printed plan is the whole exposure. A launch is only
 * started when a full per-launch cap of headroom remains, so a run never abandons a launch
 * half-walked and never spends requests on a window it cannot finish. `--dry-run` prints this plan
 * and fetches nothing.
 *
 * The per-launch cap counts **requests, not pages**, because this endpoint sheds about a quarter of
 * what it is asked for and the client retries. A cap on successful pages would have let a launch
 * cost three times the printed number. The walk also reserves the *whole* cost of a page — one
 * attempt plus its backoffs — before starting one, so 18 is an exact bound rather than an
 * approximate one and the `3 × 8 × 18` arithmetic above is true rather than nearly true.
 *
 * ## Drops are attributed, never lumped
 *
 * Every launch that leaves the sample is counted **by cause** ({@link Stage2DropReasons}), carried
 * into the run record and rendered. The cause that matters is `mintTimeDisagreement`: it says the
 * vendor's mint time and pump.fun's fill tape contradicted each other, which never happens on the
 * committed tape and has never been checked on a stranger, because this lane has held no vendor key.
 * A lump total could not be read for it, so there is no lump total.
 *
 * **No keyed request is issued here, ever.** The mint list comes from the profile Stage 1 already
 * paid for. The shared vendor allowance — which production also draws on — is untouched by this
 * stage, and the endpoints it does reach are pump.fun's free ones.
 *
 * ## What it will not do
 *
 * It does not measure exit. Not partially, not as an input, not as a tiebreak. See `entry.mjs`.
 */

import { CeilingReached } from './client.mjs';
import { measureLaunchEntry, scoreEntry } from './entry.mjs';
import { toLaunchRefs } from './measure.mjs';
import { KeylessHttpError, readLaunchWindow } from './pumpfun.mjs';
import { redactAll, redactVendorIdentifiers } from './record.mjs';

/**
 * @typedef {object} Stage2Thresholds
 * @property {number} minRoomLeft
 * @property {number} minLaunchesSampled
 * @property {number} minFieldRoundTrips
 * @property {number} minFieldHitRateGross
 * @property {number} maxCandidatesScored
 * @property {number} maxLaunchesPerCandidate
 * @property {number} maxRequestsPerLaunch
 * @property {number} tradePageLimit
 * @property {number} windowMs
 * @property {number} seekMarginMs
 * @property {number} windowSlotSpan
 * @property {number} maxKeylessRequests
 * @property {readonly number[]} [keylessRetryBackoffMs]
 */

/**
 * Every way a launch can leave the sample. A lump total would hide the one that matters: a
 * `mintTimeDisagreement` says the vendor's clock and the fill tape have come apart, which is a
 * different event from a launch simply being too busy to walk inside the request cap.
 *
 * @typedef {object} Stage2DropReasons
 * @property {number} mintTimeDisagreement Pre-mint rows came back. **A reportable event.**
 * @property {number} coverageUnproven     The endpoint never said whether anything older exists.
 * @property {number} unrecognisedBody     A body with no readable row list.
 * @property {number} requestCap           Busier than the per-launch request cap allows for.
 * @property {number} stalledCursor
 * @property {number} unparsedRows
 * @property {number} noFills
 * @property {number} noCreateSlot         Walked, but with no bonding-curve buy to anchor on.
 * @property {number} transportError
 * @property {number} stageCeiling         The stage ceiling was reached mid-walk.
 */

/**
 * @typedef {object} Stage2Coverage
 * @property {number} launchRefsAvailable  Launches the vendor profile offered.
 * @property {number} launchesAttempted    Windows we started walking.
 * @property {number} launchesUsable       Windows walked back past the mint.
 * @property {number} launchesDropped      Windows dropped for incomplete coverage.
 * @property {Stage2DropReasons} dropsByReason  The same total, broken out by cause.
 * @property {number} requestsIssued
 * @property {boolean} stoppedForBudget    Whether the stage ceiling ended the walk early.
 * @property {string[]} dropNotes          One line per dropped window, so a drop is never silent.
 */

/** @returns {Stage2DropReasons} */
function noDrops() {
  return {
    mintTimeDisagreement: 0,
    coverageUnproven: 0,
    unrecognisedBody: 0,
    requestCap: 0,
    stalledCursor: 0,
    unparsedRows: 0,
    noFills: 0,
    noCreateSlot: 0,
    transportError: 0,
    stageCeiling: 0,
  };
}

/** @type {Record<import('./pumpfun.mjs').LaunchWindowDropReason, keyof Stage2DropReasons>} */
const DROP_REASON_KEY = {
  'mint-time-disagreement': 'mintTimeDisagreement',
  'coverage-unproven': 'coverageUnproven',
  'unrecognised-body': 'unrecognisedBody',
  'request-cap': 'requestCap',
  'stalled-cursor': 'stalledCursor',
  'unparsed-rows': 'unparsedRows',
  'no-fills': 'noFills',
};

/**
 * Add two drop tallies. Used to roll per-wallet counts up to a run total, which is the level at
 * which a clock disagreement stops looking like one odd launch and starts looking like a broken
 * assumption.
 *
 * @param {Stage2DropReasons} a
 * @param {Stage2DropReasons} b
 * @returns {Stage2DropReasons}
 */
export function addDropReasons(a, b) {
  const sum = noDrops();
  for (const key of /** @type {(keyof Stage2DropReasons)[]} */ (Object.keys(sum))) {
    sum[key] = a[key] + b[key];
  }
  return sum;
}

/** @param {Stage2DropReasons} d @returns {number} */
export function totalDrops(d) {
  let n = 0;
  for (const key of /** @type {(keyof Stage2DropReasons)[]} */ (Object.keys(d))) n += d[key];
  return n;
}

/** @returns {Stage2DropReasons} */
export function emptyDropReasons() {
  return noDrops();
}

/**
 * Describe a failed launch walk **without repeating anything the vendor told us.**
 *
 * A drop note is persisted, and this client's URLs carry the mint, so `cause.message` is not
 * usable here: `HTTP 400 on https://swap-api.pump.fun/v2/coins/<MINT>/trades?…` would put a
 * vendor-derived token address into a run record and break the containment
 * {@link toEntryRecordRow} claims. {@link KeylessHttpError} carries its status as a field for
 * exactly this reason, and anything else is reduced to its constructor name — which is the part
 * that identifies the failure, and the only part that cannot be carrying an identifier.
 *
 * @param {unknown} cause
 * @returns {string}
 */
export function describeTransportFailure(cause) {
  if (cause instanceof KeylessHttpError) return `HTTP ${cause.status}`;
  if (cause instanceof Error) return cause.name === '' ? 'an unnamed error' : cause.name;
  return 'a non-Error throw';
}

/**
 * Score one candidate's entry room and field.
 *
 * The unusable-window rule is the load-bearing one: a window that could not be walked back to the
 * mint is **dropped and counted**, never measured. Measuring a partial window would anchor the
 * create slot on whatever fill the walk happened to stop at, credit some mid-window sniper as the
 * deployer, and produce a confident room figure for a launch whose opening was never seen. A
 * dropped launch merely shrinks `n` — visibly, and towards `entry-unmeasured`.
 *
 * @param {import('./pumpfun.mjs').KeylessClient} client
 * @param {object} input
 * @param {string} input.wallet
 * @param {unknown} input.profile A parsed `/deployer-hunter/{wallet}` response from Stage 1.
 * @param {number} input.nowMs    Clock, injected so a run is reproducible in a test.
 * @param {Stage2Thresholds} input.thresholds
 * @param {(line: string) => void} [input.log]
 * @returns {Promise<{ score: import('./entry.mjs').EntryScore, coverage: Stage2Coverage }>}
 */
export async function scoreCandidateEntry(client, input) {
  const t = input.thresholds;
  const refs = toLaunchRefs(input.profile);

  // A launch younger than the window has not finished happening. Measuring it would read a
  // truncated opening as a quiet one.
  const eligible = refs.filter((r) => input.nowMs - r.deployedAtMs >= t.windowMs);
  const planned = eligible.slice(0, t.maxLaunchesPerCandidate);

  /** @type {import('./entry.mjs').LaunchEntry[]} */
  const measured = [];
  /** @type {string[]} */
  const dropNotes = [];
  const dropsByReason = noDrops();
  let attempted = 0;
  let dropped = 0;
  let stoppedForBudget = false;
  const requestsBefore = client.issued();

  for (const ref of planned) {
    // Reserve the whole per-launch cost before starting. Beginning a walk we cannot finish would
    // spend requests to produce a window that is unusable by construction.
    if (client.remaining() < t.maxRequestsPerLaunch) {
      stoppedForBudget = true;
      dropNotes.push(
        `stopped before ${planned.length - attempted} further launch(es): fewer than ` +
          `${t.maxRequestsPerLaunch} request(s) of the ${t.maxKeylessRequests} stage ceiling remain, and a ` +
          `launch is never started unless it can be finished`,
      );
      break;
    }

    attempted += 1;
    /** @type {import('./pumpfun.mjs').LaunchWindow} */
    let window;
    try {
      window = await readLaunchWindow(client, {
        mint: ref.mint,
        createdAtMs: ref.deployedAtMs,
        windowMs: t.windowMs,
        seekMarginMs: t.seekMarginMs,
        windowSlotSpan: t.windowSlotSpan,
        maxRequests: t.maxRequestsPerLaunch,
        pageLimit: t.tradePageLimit,
      });
    } catch (cause) {
      if (cause instanceof CeilingReached) {
        stoppedForBudget = true;
        dropped += 1;
        dropsByReason.stageCeiling += 1;
        dropNotes.push('the stage request ceiling was reached mid-walk');
        break;
      }
      dropped += 1;
      dropsByReason.transportError += 1;
      dropNotes.push(`DROPPED (transport error): ${describeTransportFailure(cause)}`);
      continue;
    }

    if (!window.usable) {
      dropped += 1;
      if (window.dropReason !== null) dropsByReason[DROP_REASON_KEY[window.dropReason]] += 1;
      dropNotes.push(window.note);
      input.log?.(`    ${window.note}`);
      continue;
    }

    const entry = measureLaunchEntry(window.fills);
    if (entry === null) {
      dropped += 1;
      dropsByReason.noCreateSlot += 1;
      dropNotes.push('DROPPED: no bonding-curve buy in the window, so there is no create slot to anchor on');
      continue;
    }
    measured.push(entry);
    input.log?.(
      `    ${window.pages} page(s) / ${window.requests} request(s), ${window.fills.length} fill(s), room ` +
        `${entry.createSlot.roomLeft.toFixed(3)}, ${entry.field.length} competing wallet(s)`,
    );
  }

  const score = scoreEntry(measured, t, {
    candidateWallet: input.wallet,
    launchesDropped: dropped,
    mintTimeDisagreements: dropsByReason.mintTimeDisagreement,
  });

  return {
    score,
    coverage: {
      launchRefsAvailable: refs.length,
      launchesAttempted: attempted,
      launchesUsable: measured.length,
      launchesDropped: dropped,
      dropsByReason,
      requestsIssued: client.issued() - requestsBefore,
      stoppedForBudget,
      dropNotes,
    },
  };
}

/**
 * Project an entry score onto the fields a run record may persist.
 *
 * Same containment as `screen.mjs` → `toRecordRow`, for the same reason: what survives a run is our
 * arithmetic over pump.fun's public fills, and never a vendor per-token record. In particular **no
 * mint appears here**, although Stage 2 held a list of them in memory to do the walk at all.
 *
 * Wallet addresses are also dropped. The field is reported as a distribution and a hit rate — which
 * is the whole point of the leg — and a list of who was in it would be an accumulation with no
 * question attached to it.
 *
 * Every FREE-TEXT field is passed through `record.mjs` → `redactVendorIdentifiers` on the way out.
 * The structured fields cannot leak — they are numbers — but a sentence can, and one did: a
 * transport failure's message carried the trade URL, mint and all, into `dropNotes`. Notes are now
 * built without it (see {@link describeTransportFailure}) AND scrubbed here, because the containment
 * claim should not rest on every future note-writer remembering.
 *
 * @param {import('./entry.mjs').EntryScore} s
 * @param {Stage2Coverage} coverage
 */
export function toEntryRecordRow(s, coverage) {
  /** @param {import('./entry.mjs').Distribution} d */
  const dist = (d) => ({
    n: d.n,
    min: round(d.min),
    p10: round(d.p10),
    p25: round(d.p25),
    median: round(d.median),
    p75: round(d.p75),
    p90: round(d.p90),
    max: round(d.max),
  });
  /** @param {import('./entry.mjs').HitRate} h */
  const hit = (h) => ({ n: h.n, hits: h.hits, rate: round(h.rate) });

  return {
    verdict: s.verdict,
    rationale: redactVendorIdentifiers(s.rationale),
    launchesSampled: s.launchesSampled,
    launchesWithNoOutsider: s.launchesWithNoOutsider,
    roomLeft: dist(s.roomLeft),
    roomHitRate: hit(s.roomHitRate),
    operationShare: dist(s.operationShare),
    devSol: dist(s.devSol),
    coordinatedSol: dist(s.coordinatedSol),
    outsidersPerLaunch: dist(s.outsidersPerLaunch),
    fieldFillSol: dist(s.fieldFillSol),
    fieldSolQueuedAhead: dist(s.fieldSolQueuedAhead),
    fieldRealisedSolGrossOfFees: dist(s.fieldRealisedSolGrossOfFees),
    fieldReturnPerSolGrossOfFees: dist(s.fieldReturnPerSolGrossOfFees),
    fieldHitRateGrossOfFees: hit(s.fieldHitRateGrossOfFees),
    fieldEntrants: s.fieldEntrants,
    fieldClosedRoundTrips: s.fieldClosedRoundTrips,
    fieldOpenPositions: s.fieldOpenPositions,
    deployerMismatches: s.deployerMismatches,
    caveats: redactAll(s.caveats),
    coverage: {
      launchRefsAvailable: coverage.launchRefsAvailable,
      launchesAttempted: coverage.launchesAttempted,
      launchesUsable: coverage.launchesUsable,
      launchesDropped: coverage.launchesDropped,
      // Broken out by cause, not a lump total: the whole point of the mint-time tripwire is that a
      // run can be read for whether it fired, and a total cannot be.
      dropsByReason: { ...coverage.dropsByReason },
      requestsIssued: coverage.requestsIssued,
      stoppedForBudget: coverage.stoppedForBudget,
      dropNotes: redactAll(coverage.dropNotes),
    },
  };
}

/** @param {number} n @returns {number | null} */
function round(n) {
  return Number.isFinite(n) ? Number(n.toFixed(6)) : null;
}
