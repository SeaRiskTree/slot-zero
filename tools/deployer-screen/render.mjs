/**
 * Output. Pure string building — the module decides nothing, but it is where the tool's honesty
 * about its own scope lives, so it is not incidental.
 *
 * Every rendered surface carries {@link LIMITATIONS}. That is deliberate and it is not boilerplate:
 * a ranking read out of context is exactly how a gate becomes a recommendation, and the person most
 * likely to read this output in six months has forgotten which stages were built.
 *
 * That includes the surfaces which show no verdict at all: {@link renderDryRun} and BOTH halves of
 * the `--stage0` report, its text here and its JSON in `screen.mjs`. Their omission was an oversight
 * rather than a decision — a reader who sees a request plan naming `elite` deployers has already
 * begun forming a conclusion, and the block costs nothing. `--stage0` is the surface a human runs
 * first, so it was the worst one to be missing it.
 *
 * The other honesty this module owns is the difference between a run that **finished** and one that
 * **died**. `renderStage1` is told which, because "no candidate cleared the gate" is a measured
 * outcome in the first case and meaningless in the second, and printing the first sentence over the
 * second state is the single output this tool exists to make impossible.
 */

import { MADEONSOL_DAILY_REQUESTS, buildPath, ENDPOINT_ROLES } from './client.mjs';
// The per-deployer cap's arithmetic, imported rather than restated: a dry run that printed a bound
// the query does not apply would be worse than printing none. It is arithmetic over a pinned
// threshold — no Dune-derived value crosses this import.
import { LAUNCH_CAP_FLOOR, MAYHEM_OBSERVATION_ONLY, duneSpendPlan, launchCapPerWallet } from './dune.mjs';
import { estimatePlanCredits } from './client.mjs';
import { LANDING_TIP_CAVEAT } from './entry.mjs';
// The reach the plan quotes is DERIVED, never a second copy of the formula: an operator reads this
// block before authorising a run, so it has to describe the walk `readLaunchWindow` will actually do.
import { windowReachMs } from './pumpfun.mjs';
import { groupUnmeasured, kindMetaOf, partitionUnmeasured } from './record.mjs';
import { addDropReasons, emptyDropReasons, totalDrops } from './stage2.mjs';

/**
 * The standing limitation block. Printed on every human-readable surface and embedded in every
 * machine-readable one.
 *
 * The bar named in the third bullet is this project's own standing bar for a signal of this class,
 * and the point of stating it is that this tool clears none of it.
 */
export const LIMITATIONS = [
  'WHAT THIS IS: a candidate list for further research. Nothing here is a recommendation, and',
  'nothing here establishes a tradeable edge.',
  '',
  'WHAT IT MEASURES:',
  '  · STAGE 1, competence — whether a deployer completes bonding curves. One number, computed by',
  '    us from per-token records, over a window of about 35 days.',
  '  · STAGE 2, ENTRY — how much of its own opening window the deployer and its own wallets take',
  '    before anyone else is filled, and what the OTHER sniping wallets on those same launches',
  '    achieved: fill, queue position, and realised P&L. Distributions and a hit rate, never a mean.',
  '  · STAGE 2, THE PRICE OF THE SEAT — what landing in that window cost those wallets, recovered',
  '    from the chain: the transaction fee (base and priority) exactly, and everything else their',
  '    own transaction moved. The field\'s result is then reported both gross and NET of it.',
  '',
  'WHICH HISTORY IT COUNTS: the tokens the wallet CREATED, read from pump.fun create transactions.',
  'NOT the tokens it owns now, which is what every vendor surface answers. Ownership on pump.fun',
  'is a sellable position — the owner collects the creator fees — so the ownership reading',
  'understates launches, understates BONDED launches by more, and scores the better deployer',
  'worse. Both readings are in every candidate row, with the verdict each one produced.',
  'The creation walk covers a BOUNDED WINDOW backwards from now; outside it the ownership listing',
  'is carried over unchanged and the row says how much of the history that is.',
  '',
  'WHAT IT DOES NOT MEASURE, and none of these are minor:',
  '  · EXIT. Room to enter is not room to leave. When the dev sells, whether its trigger is a SIZE',
  '    that our own buy would count towards and would therefore cap our position, and whether an',
  '    outsider could have got out first, are ALL UNMEASURED here. No exit signal reaches any entry',
  '    number in this output, deliberately: a blended score cannot be read back apart.',
  '  · A LANDING TIP PAID IN A SEPARATE TRANSACTION OF THE SAME BUNDLE. It is not recoverable from',
  '    the entrant\'s own transaction and it is not measured anywhere in this repo\'s ground truth',
  '    either, so every cost figure is a LOWER bound and every after-cost figure an UPPER bound:',
  '    entry looks cheaper, and the field more profitable, than either was.',
  '  · WHETHER WE WOULD HAVE BEEN FILLED AT ALL. Every fill in the tape belongs to a wallet that',
  '    WON the auction — post-break our own subject saw a median 41.6 attempts per landed',
  '    transaction — and a wallet that paid and did not land is invisible to it. So the measured',
  '    cost of entering is the cost paid by winners and it understates the cost of TRYING.',
  '  · Lead time, or the independence of the actors involved.',
  '',
  'The standing bar for acting on a signal of this class is real lead time, independence of the',
  'actors, and realised profit reported as a distribution plus a hit rate. Stage 2 clears the last',
  'of those three net of MEASURED fees — an upper bound, not the truth — and clears neither of the',
  'first two. THAT NET READING IS PER CANDIDATE AND IS OFTEN ABSENT: the cost leg does not run under',
  '--no-stage2, does not run in a --stage0 run, and does not run for any candidate the free legs',
  '(room, or the field GROSS of fees) already refused. Where it did not run the figures are gross of',
  'fees only, the candidate\'s own block says NOT MEASURED, and its verdict is entry-cost-unmeasured',
  '— which is never a pass. Read the per-candidate block, not this footer, for whether the seat was',
  'priced.',
  '',
  'A HIGH COMPLETION RATE DOES NOT IMPLY A PROFITABLE ENTRY, and A PROFITABLE-LOOKING FIELD DOES',
  'NOT IMPLY A PROFITABLE ENTRY EITHER. We hold the counterexample to both. Our own subject',
  'deployer completes 43% of its launches, and gross of fees ~77% of the closed round trips in its',
  'opening window are positive — yet fee-inclusive, the entire outsider population there has made',
  '+0.54 SOL per launch since 2026-06-04 with 51 of 106 wallets losing money, because the',
  'operation\'s own group takes 97% of the profit available. Stage 0 shows the gate PASSING that',
  'wallet and Stage 2 REFUSING it.',
  '',
  'The completion rate is a RECENCY measure, not a lifetime record, and long-horizon consistency',
  'is reported UNMEASURED unless --consistency was passed. Read each row\'s creation window before',
  'reading its rate as a record: a wallet whose walk stopped on a ceiling has a rate computed over',
  'that window plus whatever the ownership listing carried over from before it.',
];

/**
 * The Helius Developer plan's monthly credit allowance, from their pricing page (read 2026-08-03).
 *
 * Printed by the dry run so the worst case has a denominator on the same screen. It is the plan's
 * number, not a measurement of ours, and it is **unshared** — the key belongs to this lane alone
 * (captain, 2026-08-03), so the whole allowance is what this tool may draw on.
 */
const HELIUS_MONTHLY_CREDITS = 10_000_000;

/**
 * Measured per-candidate credit cost of a COMPLETE creation history, at the median.
 *
 * From the only population where every wallet's whole index was enumerated: the twelve of
 * `runs/2026-07-29-elite.json`, walked to exhaustion 2026-08-03. Their succeeded-transaction counts
 * were 168 / 211 / 1,007 / 1,026 / 2,136 / 2,989 / 3,344 / 4,749 / 6,378 / 7,791 / 46,815 / 49,367,
 * which at 10 credits per 100 returned is 20 / 30 / 110 / 110 / 220 / 300 / 340 / 480 / 640 / 780 /
 * 4,690 / 4,940 — median 320. It is quoted as the EXPECTED cost beside the ceiling because the two
 * differ by more than an order of magnitude and printing only one of them misleads in whichever
 * direction it was chosen. `thresholds.json` → `creation_walk_helius` owns the full figures.
 */
const MEASURED_MEDIAN_CREDITS = 320;

/**
 * Dune's Free-tier monthly credit allowance, from their pricing page.
 *
 * Printed by the dry run so the Dune worst case has a denominator on the same screen, exactly as
 * {@link HELIUS_MONTHLY_CREDITS} does. Unlike the Helius allowance this one is **shared** with
 * whatever else holds the key, and nothing in this tool tracks the month — the dry run says so.
 */
const DUNE_MONTHLY_CREDITS = 2_500;

/**
 * Measured per-deployer credit cost of a Dune creation enumeration.
 *
 * MEASURED 2026-08-03 on this account: the union enumeration over 5 wallets returned 482 rows in
 * 46,718 bytes and cost 1.919 BILLED credits — 0.919 of compute plus ~1.0 of export at the published
 * 20 credits/MB. That is ~0.38 per deployer at a batch of 5, and it FALLS as the batch grows,
 * because the table scan is nearly independent of how many wallets are in the filter (measured at 5
 * and at 20) while only the bytes scale. 0.1 is the per-deployer figure at the candidate cap, where
 * the fixed scan is amortised over 195 wallets and the per-row bytes are the whole marginal cost: 195
 * deployers at a median ~50 launches is ~0.95 MB, about 19 credits of export plus ~1 of compute.
 * The 46,718 bytes above were measured at FOUR columns; `CREATION_SQL` now selects six, whose
 * per-row cost has been re-measured — see `DUNE_BYTES_PER_ROW_CEILING` below.
 * Quoted beside the ceiling for the same reason the Helius median is — they differ by 40x, and
 * printing only one of them misleads in whichever direction it was chosen.
 */
const DUNE_EXPECTED_CREDITS_PER_CANDIDATE = 0.1;

/**
 * An UPPER BOUND on the bytes one enumeration row costs, in bytes.
 *
 * **97 is a MEASUREMENT and it was taken at FOUR columns** (482 rows, 46,718 bytes, 2026-08-03).
 * `CREATION_SQL` now selects six: `launches_total` is what makes its per-deployer cap detectable
 * instead of silent, and `is_mayhem_mode` is captain decision 227a's recorded-and-reported flag.
 * That six-column shape has been MEASURED at both read shapes — 105.92 bytes/row batch-shaped and
 * 105.91 for one wallet — so 121 still holds and does not move. Its headroom is now 15.08 bytes,
 * less than one more boolean column is worth, so a SEVENTH column must re-measure and raise the
 * pin rather than lean on a margin that is gone. `CREATION-DERIVED.md` §8.2c owns every figure.
 */
const DUNE_BYTES_PER_ROW_CEILING = 121;

/**
 * Measured wall-clock cost of ONE indexed page, in milliseconds.
 *
 * This is a MEASUREMENT, not a guess, and it exists because the naive estimate — one page per
 * `rpcMinIntervalMs` — understates the walk. From the 2026-08-03 full-mode pacing ladder against
 * the busiest measured wallet, 20 requests a rung, one request in flight:
 *
 * ```
 *   enforced interval 1000ms → 1.04 req/s →  962 ms per request
 *   enforced interval  500ms → 2.04 req/s →  490 ms per request
 *   enforced interval  250ms → 3.32 req/s →  301 ms per request
 *   enforced interval  100ms → 3.98 req/s →  251 ms per request
 *   enforced interval    0ms → 3.89 req/s →  257 ms per request
 * ```
 *
 * Below roughly 250ms of enforced interval the cycle is pinned by RESPONSE LATENCY (p50 ~220ms) at
 * 250–260ms; above it the interval dominates with ~50ms of overhead on top. So at the pinned 200ms
 * floor a page really costs ~270–285ms, and the estimate is taken as
 * `Math.max(rpcMinIntervalMs, MEASURED_PAGE_CYCLE_MS)`: at the pinned floor that prints the
 * latency-bound truth, and if anyone later raises the interval past the measured cycle the interval
 * correctly dominates again and the estimate keeps rising. An estimate stale in the OPTIMISTIC
 * direction is the one that gets a healthy run killed by an operator who thinks the tool has hung —
 * the same doctrine `thresholds.json` → `budget.keyedMinIntervalMs` already states.
 */
const MEASURED_PAGE_CYCLE_MS = 280;

/**
 * What the dry run says when no Solana RPC key is configured.
 *
 * It deliberately does NOT spell the environment variable: this module is not on
 * `credential.mjs`'s allow-list, and a second copy of a credential's name is how an allow-list
 * stops meaning anything. The endpoint descriptor carries the variable when there IS one
 * (`rpcEndpoint.keyEnvVar`), which is the only place the tool reads it from.
 */
const KEYLESS_HINT = 'No Solana RPC key is configured.';

/** @param {number} n @param {number} [dp] */
const pct = (n, dp = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : 'n/a');
/** @param {number} n @param {number} [dp] */
const num = (n, dp = 2) => (Number.isFinite(n) ? n.toFixed(dp) : 'n/a');

/** @param {string} s @param {number} w */
const pad = (s, w) => (s.length >= w ? s : s + ' '.repeat(w - s.length));
/** @param {string} s @param {number} w */
const padl = (s, w) => (s.length >= w ? s : ' '.repeat(w - s.length) + s);

/**
 * One line of a distribution: label, n, and the quantiles.
 *
 * There is no mean column and there is not going to be one. The captain's standing bar for this
 * class of claim is distributions plus a hit rate, and it is a correctness rule rather than a
 * presentational preference — sniper outcomes are heavy-tailed on both sides, so a mean is carried
 * by whichever tail is fatter and describes nobody's experience.
 *
 * @param {string} label
 * @param {import('./entry.mjs').Distribution} d
 * @param {number} [dp]
 * @returns {string}
 */
function distLine(label, d, dp = 3) {
  return (
    `    ${pad(label, 26)}${padl(String(d.n), 5)}  ${padl(num(d.min, dp), 9)}  ${padl(num(d.p10, dp), 9)}  ` +
    `${padl(num(d.p25, dp), 9)}  ${padl(num(d.median, dp), 9)}  ${padl(num(d.p75, dp), 9)}  ` +
    `${padl(num(d.p90, dp), 9)}  ${padl(num(d.max, dp), 9)}`
  );
}

/**
 * The room median's own incompleteness, in one line, for a surface that prints the median.
 *
 * Captain decision 208b's requirement is that the FIGURE states it, so this is deliberately terse
 * enough to sit on the same screen as the number rather than being a paragraph a reader skips. The
 * full sentence — the construction, the assumptions and the "reported, never gated on" rule — is
 * `entry.mjs` → `describeRoomMedianBound`, and it reaches this block anyway through `e.caveats`.
 *
 * @param {import('./entry.mjs').RoomMedianBound} b
 * @returns {string}
 */
function roomBoundLine(b) {
  if (b.launchesScored === 0) return 'no launch scored, so there is no median and no bound on one';
  if (b.launchesMissing === 0) {
    return `bound [${num(b.lo, 4)}, ${num(b.hi, 4)}] — COMPLETE: no window refused, none dropped`;
  }
  return (
    `bound [${num(b.lo, 4)}, ${num(b.hi, 4)}] over the ${b.launchesMissing} window(s) with NO room ` +
    `figure (${b.launchesRefusedMeasured} refused, measuring a median ` +
    `${num(b.refusedRoomLeft.median, 4)}; ${b.launchesUnmeasured} never measured) — this median may ` +
    `OVERSTATE room by up to ${num(b.overstatementMax, 4)}` +
    (b.provablyOverstated ? ', and provably does' : '')
  );
}

/** @returns {string} */
function distHeader() {
  return (
    `    ${pad('', 26)}${padl('n', 5)}  ${padl('min', 9)}  ${padl('p10', 9)}  ${padl('p25', 9)}  ` +
    `${padl('median', 9)}  ${padl('p75', 9)}  ${padl('p90', 9)}  ${padl('max', 9)}`
  );
}

/**
 * Render one candidate's ENTRY score.
 *
 * @param {import('./entry.mjs').EntryScore} e
 * @param {import('./stage2.mjs').Stage2Coverage | null} coverage
 * @returns {string[]}
 */
export function renderEntry(e, coverage) {
  const L = [];
  L.push(`      ENTRY: ${e.verdict.toUpperCase()}`);
  // Captain decision 174b, on the face of the run rather than only in the record. An unmeasured
  // verdict is seven unrelated producers and the operator has to be able to see which fired. All
  // seven are OUR COVERAGE today — a limit of this reading, never grounds for dropping the wallet
  // — but the attribution is printed from the score rather than assumed, so a future
  // deployer-attributed producer says so here without a second edit. The check is nullish: a
  // schema-≤9 `entry` row carries no field at all and must not fall into this branch.
  if (e.unmeasuredCause != null) {
    L.push(
      `      CAUSE: ${e.unmeasuredCause.toUpperCase()} — ` +
        (e.unmeasuredCauseAttribution === 'deployer'
          ? 'a finding about THIS DEPLOYER, measured on a full sample'
          : 'a limit of OUR COVERAGE, not a finding about this deployer — never filter on it') +
        (e.unmeasuredContributingCauses.length > 1
          ? ` (also: ${e.unmeasuredContributingCauses.slice(1).join(', ')})`
          : ''),
    );
  }
  for (const line of wrap(e.rationale, 84)) L.push(`        ${line}`);
  L.push('');

  L.push(`      ENTRY ROOM — how much of its own opening window the deployer leaves`);
  L.push(distHeader());
  L.push(distLine('room left', e.roomLeft));
  // IMMEDIATELY UNDER THE FIGURE IT BOUNDS, captain decision 208b — not further down the block and
  // not in the caveat list alone. The median above is over the launches that were SCORED, and the
  // refused ones are not a random sample of the rest; this is how far completing them could move it.
  // Reported, never gated on.
  for (const [i, line] of wrap(roomBoundLine(e.roomLeftBound), 100).entries()) {
    L.push(`      ${i === 0 ? '^' : ' '} ${line}`);
  }
  L.push(distLine('operation share', e.operationShare));
  L.push(distLine('dev buy (SOL)', e.devSol));
  L.push(distLine('its own cohort (SOL)', e.coordinatedSol));
  L.push(distLine('competing wallets', e.outsidersPerLaunch, 1));
  // Over EVERY measured launch, refused ones included — a zero on BOTH halves is what says the
  // co-ordination rule found nothing rather than finding no co-ordination, and it is the only
  // visible sign of it. The two halves are printed apart so a reader can see which one carried the
  // launch: `bundled create-slot tx 0` beside `anchored run tx 3` is a launch only the union scores.
  L.push(distLine('bundled create-slot tx', e.bundledTx, 1));
  L.push(distLine('max wallets in one tx', e.maxWalletsInOneTx, 1));
  L.push(distLine('anchored run tx', e.runTx, 1));
  L.push(distLine('wallets adjacency added', e.adjacencyMarks, 1));
  L.push(
    `      hit rate: ${e.roomHitRate.hits}/${e.roomHitRate.n} launches leave room ` +
      `(${pct(e.roomHitRate.rate)}); ${e.launchesWithNoOutsider} launch(es) had no competitor at all`,
  );
  if (e.launchesRoomUnproven > 0) {
    L.push(
      `      ${e.launchesRoomUnproven} further launch(es) are NOT SCORED: no shared transaction and ` +
        `no anchored run in the create slot, so the opening is UNPROVEN rather than open`,
    );
  }
  L.push('      ^ Read this the captain\'s way: it measures how badly configured the dev\'s own');
  L.push('        launch bot is. A bot that takes the bottom of its own curve leaves us nothing.');
  L.push('');

  L.push('      THE FIELD — what every OTHER sniping wallet on those same launches achieved');
  L.push(distHeader());
  L.push(distLine('fill (SOL)', e.fieldFillSol));
  L.push(distLine('SOL queued ahead', e.fieldSolQueuedAhead, 2));
  L.push(distLine('realised SOL *GROSS*', e.fieldRealisedSolGrossOfFees));
  L.push(distLine('return per SOL *GROSS*', e.fieldReturnPerSolGrossOfFees));
  L.push(
    `      hit rate: ${e.fieldHitRateGrossOfFees.hits}/${e.fieldHitRateGrossOfFees.n} closed round ` +
      `trips positive (${pct(e.fieldHitRateGrossOfFees.rate)}) — GROSS OF FEES, so an UPPER BOUND`,
  );
  L.push(
    `      ${e.fieldEntrants} field entr(y/ies), ${e.fieldClosedRoundTrips} closed, ` +
      `${e.fieldOpenPositions} still open at the window's end and therefore with NO complete P&L`,
  );
  L.push('');

  L.push('      WHAT IT COSTS TO GET IN — recovered on-chain, and what the field cleared after it');
  if (e.entryCostPriced.hits === 0) {
    L.push('      NOT MEASURED. No create-slot transaction was priced, so the price of the seat is');
    L.push('      unknown — which is NOT a finding that entry was cheap.');
  } else {
    L.push(distHeader());
    L.push(distLine('entry cost (SOL)', e.entryCostSol, 4));
    L.push(distLine('per SOL staked, entries', e.entryCostPerSolStaked, 4));
    // The unit the bar is compared against, printed beside the pooled one so a reader can see both
    // and can see which is which. Decision 140a.
    L.push(distLine('per SOL staked, *LAUNCH*', e.entryCostPerSolStakedByLaunch, 4));
    L.push(distLine('tx fee, base+priority', e.entryTxFeeSol, 5));
    L.push(distLine('realised SOL *NET*', e.fieldRealisedSolNetOfMeasuredFees));
    L.push(distLine('return per SOL *NET*', e.fieldReturnPerSolNetOfMeasuredFees));
    L.push(
      `      hit rate: ${e.fieldHitRateNetOfMeasuredFees.hits}/${e.fieldHitRateNetOfMeasuredFees.n} ` +
        `priced round trips positive (${pct(e.fieldHitRateNetOfMeasuredFees.rate)}) NET OF MEASURED ` +
        `FEES, against ${pct(e.fieldHitRateGrossOfFees.rate)} gross`,
    );
    L.push(
      `      priced: ${e.entryCostPriced.hits}/${e.entryCostPriced.n} create-slot entries ` +
        `(${pct(e.entryCostPriced.rate)}), ${e.fieldClosedRoundTripsPriced}/${e.fieldClosedRoundTrips} ` +
        `round trips priced across their whole window`,
    );
    // The limit travels with the number, not only with the documentation. Same string the score's
    // caveats and the run record carry, so a figure cannot be lifted out of one surface without it.
    for (const line of wrap(LANDING_TIP_CAVEAT, 84)) L.push(`      ! ${line}`);
  }
  L.push('');

  if (coverage !== null) {
    L.push(
      `      coverage: ${coverage.launchesUsable} usable of ${coverage.launchesAttempted} attempted ` +
        `(${coverage.launchRefsAvailable} available), ${coverage.requestsIssued} keyless request(s)` +
        (coverage.stoppedForBudget ? ', STOPPED EARLY on the stage request ceiling' : ''),
    );
    // The eligibility filter's own arithmetic. Three quite different reasons a launch went
    // unmeasured used to look identical from the outside; they are now separate numbers.
    L.push(
      `      eligibility: ${coverage.launchesTooYoung} of ${coverage.launchRefsAvailable} launch(es) ` +
        `younger than ${coverage.minAgeMs}ms and not yet finished happening, ` +
        `${coverage.launchesDroppedByCap} dropped by the per-candidate cap` +
        (coverage.youngestEligibleAgeMs === null
          ? ''
          : `; youngest measured ${Math.round(coverage.youngestEligibleAgeMs / 1000)}s old`),
    );
    if (coverage.cost.ran) {
      L.push(
        `      cost walk: ${coverage.cost.transactionsPriced}/${coverage.cost.transactionsTargeted} ` +
          `transaction(s) priced in ${coverage.cost.rpcRequests} RPC request(s) over ` +
          `${coverage.cost.launchesPriced} launch(es)` +
          (coverage.cost.transactionsDiscarded > 0 || coverage.cost.launchesDiscarded > 0
            ? `, plus ${coverage.cost.transactionsDiscarded} transaction(s) over ` +
              `${coverage.cost.launchesDiscarded} launch(es) PAID FOR AND DISCARDED (backing nothing)`
            : '') +
          (coverage.cost.viaBlock > 0 ? `, ${coverage.cost.viaBlock} from a whole-block read` : '') +
          (coverage.cost.transactionsUnresolved > 0
            ? `, ${coverage.cost.transactionsUnresolved} UNRESOLVED (not "free")`
            : '') +
          (coverage.cost.stoppedForBudget ? ', STOPPED EARLY on the per-candidate RPC ceiling' : ''),
      );
      for (const note of coverage.cost.notes) L.push(`        · ${note}`);
    } else {
      L.push('      cost walk: NOT RUN — the free legs settled this candidate, so no RPC was spent.');
    }
    for (const line of renderDropTally(coverage.launchesDropped, coverage.dropsByReason, '      ')) L.push(line);
    for (const note of coverage.dropNotes) L.push(`        · ${note}`);
  }
  for (const c of e.caveats) {
    for (const line of wrap(c, 84)) L.push(`      ! ${line}`);
  }
  return L;
}

/** Human labels for {@link import('./stage2.mjs').Stage2DropReasons}, in reporting order. */
const DROP_LABELS = /** @type {const} */ ([
  ['mintTimeDisagreement', 'mint-time disagreement'],
  ['coverageUnproven', 'coverage unproven'],
  ['unrecognisedBody', 'unreadable body'],
  ['requestCap', 'busier than the request cap'],
  ['stalledCursor', 'stalled cursor'],
  ['unparsedRows', 'unreadable row'],
  ['noFills', 'no fill in the window'],
  ['noCreateSlot', 'no create slot to anchor on'],
  ['transportError', 'transport error'],
  ['stageCeiling', 'stage ceiling reached mid-walk'],
]);

/**
 * Render a drop tally broken out by cause.
 *
 * The tripwire count gets its own line rather than a share of one, because a non-zero
 * `mintTimeDisagreement` is a **reportable event**: it says the vendor's clock and pump.fun's fill
 * tape have come apart, which is the assumption the whole walk rests on. On the committed tape that
 * gap is exactly zero across all 235 covered launches — on strangers it has now been seen to break,
 * and this per-run count is what surfaced it (`runs/2026-08-04-full-day-default.md` owns the reading).
 *
 * @param {number} total
 * @param {import('./stage2.mjs').Stage2DropReasons} by
 * @param {string} indent
 * @returns {string[]}
 */
export function renderDropTally(total, by, indent) {
  if (total === 0) return [];
  const L = [];
  const parts = DROP_LABELS.filter(([key]) => by[key] > 0).map(([key, label]) => `${by[key]} ${label}`);
  L.push(`${indent}${total} launch(es) DROPPED: ${parts.length === 0 ? 'cause unrecorded' : parts.join(', ')}`);
  if (by.mintTimeDisagreement > 0) {
    L.push(
      `${indent}!! REPORTABLE: ${by.mintTimeDisagreement} drop(s) were a MINT-TIME DISAGREEMENT — the`,
    );
    L.push(`${indent}   vendor's creation time and pump.fun's fills contradict each other. On our own`);
    L.push(`${indent}   tape that gap is exactly 0 on all 235 launches, so this is not a footnote: the`);
    L.push(`${indent}   clock assumption has broken and the measurement is not resting on what we think.`);
  }
  return L;
}

/**
 * The mayhem-mode share, as ONE sentence written in ONE place — captain decision 227a.
 *
 * Every surface that summarises a candidate prints this: `screen.mjs`'s live line, this module's
 * gate-passed block and the same block's gate-failed sibling. It is a formatter and nothing more:
 * it reads three fields off a `creation` block and returns a line, and no caller may branch on what
 * it returns. See `dune.mjs` → `MAYHEM_OBSERVATION_ONLY`.
 *
 * **`null` prints as UNMEASURED, never as 0%.** The share is `null` on every candidate the creation
 * walk answered, because `is_mayhem_mode` is a column on Dune's decoded create event and the walk
 * reads transactions. A "0%" there would be this screen asserting a wallet launches no mayhem
 * tokens on the strength of having used a surface that cannot see the flag.
 *
 * The DENOMINATOR is stated rather than left to be inferred: it is the launches the flag was
 * READABLE on, which is not the launch count printed beside it whenever `pump_call_create` supplied
 * rows the newer event table has none of.
 *
 * @param {{ mayhemLaunches: number | null, mayhemFlagReadable: number | null,
 *   mayhemShare: number | null, duneLaunches?: number | null, enumerationSource?: string } | null}
 *   creation
 * @param {string} indent
 * @returns {string[]} One line, or none when there is no creation reading at all.
 */
export function renderMayhemShare(creation, indent) {
  if (creation === null) return [];
  const { mayhemLaunches, mayhemFlagReadable, mayhemShare } = creation;
  if (mayhemLaunches === null || mayhemFlagReadable === null) {
    return [
      `${indent}mayhem mode: UNMEASURED — the ${creation.enumerationSource ?? 'walk'} enumeration ` +
        `does not read the flag. NOT a reading of 0%.`,
    ];
  }
  if (mayhemShare === null || mayhemFlagReadable === 0) {
    // A different null from the one above, and it is told apart because only this one is a fact
    // about the WALLET: the route does read the flag, and none of this wallet's enumerated launches
    // carried a readable one.
    return [
      `${indent}mayhem mode: UNMEASURED — the flag was readable on none of this wallet's ` +
        `enumerated launches. NOT a reading of 0%.`,
    ];
  }
  // The unreadable count is `duneLaunches - mayhemFlagReadable`, both on this same block, and it is
  // printed rather than left to be subtracted — a denominator smaller than the launch count beside
  // it reads as an error unless the gap is named.
  const unreadable =
    typeof creation.duneLaunches === 'number' ? Math.max(0, creation.duneLaunches - mayhemFlagReadable) : 0;
  return [
    `${indent}mayhem mode: ${mayhemLaunches} of ${mayhemFlagReadable} launch(es) the flag was ` +
      `readable on = ${pct(mayhemShare)}` +
      `${unreadable > 0 ? `, ${unreadable} unreadable` : ''} — RECORDED, reaching no bar (227a)`,
  ];
}

/**
 * Wrap prose to a width so a long rationale stays readable in a terminal.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
function wrap(text, width) {
  /** @type {string[]} */
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * Render the Stage 0 validation report.
 *
 * @param {import('./stage0.mjs').Stage0Result} r
 * @param {readonly { atUtc: string, deployed: number, bonded: number, rate: number }[]} vendorReadings
 * @returns {string}
 */
export function renderStage0(r, vendorReadings) {
  const L = [];
  L.push('='.repeat(78));
  L.push('STAGE 0 — validating the screen against data we already hold. No network, no quota.');
  L.push('='.repeat(78));
  L.push('');

  L.push('GROUND TRUTH — our subject deployer, from the committed population tape');
  L.push(
    `  ${r.groundTruth.completed}/${r.groundTruth.tokens} launches completed = ` +
      `${num(r.groundTruth.rate, 4)} over ${num(r.groundTruth.spanDays, 0)} days ` +
      `(${r.groundTruth.firstDeployIso?.slice(0, 10)} → ${r.groundTruth.lastDeployIso?.slice(0, 10)})`,
  );
  L.push('');

  L.push('THE SAME DEPLOYER, AS THE VENDOR REPORTS IT — why we never inherit their aggregate');
  for (const v of vendorReadings) {
    const rel = (v.rate / r.groundTruth.rate - 1) * 100;
    L.push(
      `  ${v.atUtc}  ${padl(String(v.deployed), 3)} deployed / ${padl(String(v.bonded), 3)} bonded ` +
        `= ${num(v.rate, 4)}   overstates ground truth by ${rel >= 0 ? '+' : ''}${num(rel, 1)}% relative`,
    );
  }
  L.push(
    '  The window SLID and SHRANK between those two readings while the deployer launched again.',
  );
  L.push(
    '  A count window would have grown. This is a trailing ~7.5-DAY window labelled "lifetime".',
  );
  L.push('');

  L.push('THE GATE, APPLIED TO GROUND TRUTH — and this is the point of Stage 0');
  L.push(`  verdict: ${r.subjectVerdict.verdict.toUpperCase()}`);
  L.push(`  ${r.subjectVerdict.rationale}`);
  L.push('');
  L.push('  ^ The gate PASSES this wallet, and the wallet is NOT worth the time: its opening');
  L.push('    window has been unprofitable for outsiders since 2026-06-04. That is the whole');
  L.push('    demonstration. Competence is not opportunity, and this gate measures competence.');
  L.push('');

  L.push(`CURVE INVERSION — exact against the dataset's own ${r.curveCheck.n} recorded dev buys`);
  L.push(
    `  max error ${r.curveCheck.maxAbsErrorSol.toExponential(3)} SOL   ${r.curveCheck.ok ? 'OK' : 'FAILED'}`,
  );
  L.push('');

  L.push('STAGE 2 — the create-slot primitive, reproduced against the published §5.1 split');
  L.push('');
  L.push(
    `  ${pad('era', 22)}${padl('n', 4)}  ${padl('dev', 14)}  ${padl('co-ord', 8)}  ` +
      `${padl('wal', 4)}  ${padl('indep', 8)}  ${padl('share', 7)}  ${padl('published', 9)}`,
  );
  for (const e of r.eraSplit) {
    L.push(
      `  ${pad(e.era, 22)}${padl(String(e.n), 4)}  ${padl(num(e.devSolMedian, 9), 14)}  ` +
        `${padl(num(e.coordinatedSolMedian), 8)}  ${padl(num(e.coordinatedWalletsMedian, 0), 4)}  ` +
        `${padl(num(e.independentSolMedian), 8)}  ${padl(num(e.operationShareMedian, 3), 7)}  ` +
        `${padl(num(e.publishedOperationShare, 3), 9)}`,
    );
  }
  L.push('');
  L.push('  The co-ordination rule is the UNION of two structural tests, and it needs no wallet list,');
  L.push('  which is what makes the method applicable to a stranger: (a) a create-slot transaction');
  L.push('  carrying 2+ distinct wallets marks every wallet in it, and (b) the transactions forming a');
  L.push('  contiguous block-index run through the deployer\'s own mark every wallet in that run.');
  L.push('  HOW MUCH OF THE COHORT HALF (a) RECOVERS IS THE OPERATOR\'S SUBMISSION HABIT, NOT A');
  L.push('  PROPERTY OF THE RULE: 97-100% from May 2026 on, 69.9% in April, 41.6% in March, and 0%');
  L.push('  in Dec 2025 - Feb 2026, when this deployer shared no transaction at all. Half (b) is what');
  L.push('  closes that range — over the whole tape the union recovers 1140 of 1140 cohort wallet-');
  L.push('  instances, against 960 for (a) alone. A create slot NEITHER half marks is still');
  L.push('  indistinguishable from one with no co-ordination, so those launches are NOT SCORED —');
  L.push('  the era rows above are over the scored ones only.');
  const unprovenInEras = r.eraSplit.reduce((n, e) => n + e.nRoomUnproven, 0);
  L.push(
    `  ${unprovenInEras} launch(es) in these two eras were excluded for that reason` +
      `${unprovenInEras === 0 ? '.' : ` (${r.eraSplit.map((e) => `${e.era}: ${e.nRoomUnproven}`).join(', ')}).`}`,
  );
  L.push('');

  L.push('THE ROLLING REPLAY — the same known-negative question, asked at EVERY point in the tape');
  L.push(
    `  ${r.rollingRoom.windows} trailing windows: ${r.rollingRoom.present} room-present, ` +
      `${r.rollingRoom.absent} room-absent, ${r.rollingRoom.unmeasured} unmeasured`,
  );
  L.push(
    `  against the NAMED six-wallet cohort: ${r.rollingRoom.falsePositives} false positive(s), ` +
      `${r.rollingRoom.falseNegatives} false negative(s), measured windows only   ` +
      `${r.rollingRoom.ok ? 'OK' : 'FAILED'}`,
  );
  L.push('  A false positive is a window the screen would call enterable that our own ground truth');
  L.push('  says was not, and every error the co-ordination rule can make runs that way. It fails on');
  L.push('  one. A false negative does NOT fail: refusing to score an unproven opening costs real');
  L.push('  coverage, and that cost is the ruling (decision 134a), not a defect. A REFUSED window is');
  L.push('  counted as unmeasured and never as a false negative — it carries no verdict to be wrong.');
  L.push('');

  L.push('THE ADJACENCY TRIPWIRE — does half (b) of the co-ordination rule still read anything?');
  L.push(
    `  ${r.adjacencyRuns.launches} launch(es) ${r.adjacencyRuns.era} (needs ` +
      `${r.adjacencyRuns.minLaunches}): ${r.adjacencyRuns.withRun} produced an anchored run of 2+ ` +
      `transactions, shortest run ${r.adjacencyRuns.minRunTx}`,
  );
  L.push(
    `  ${r.adjacencyRuns.cohortRecovered}/${r.adjacencyRuns.cohortInstances} cohort wallet-instances ` +
      `recovered, ${r.adjacencyRuns.falseMarks} non-cohort wallet(s) marked; over ` +
      `${r.adjacencyRuns.createSlotFills} create-slot fill(s): ` +
      `${r.adjacencyRuns.unreadableIndexes} unreadable sid index(es), ` +
      `${r.adjacencyRuns.slotPrefixMismatches} prefix mismatch(es), ` +
      `${r.adjacencyRuns.txWithTwoIndexes} tx with two indices   ` +
      `${r.adjacencyRuns.ok ? 'OK' : 'FAILED'}`,
  );
  L.push('  The shared-transaction rule recovers NOTHING in this era, so adjacency is the only thing');
  L.push('  carrying these launches. If pump.fun\'s sid format moves, the block index stops decoding,');
  L.push('  every run collapses to length 1 and every launch that depends on half (b) silently goes');
  L.push('  back to UNPROVEN — the safe direction, and invisible without this check.');
  L.push('');

  L.push('FIELD MEASUREMENT — reproduced against the dataset\'s own committed P&L table');
  L.push(
    `  ${r.fieldCheck.pairs} create-slot outsider pair(s) recomputed from raw fills: ` +
      `${r.fieldCheck.closureMismatches} closure mismatch(es), ${r.fieldCheck.missingFromCsv} absent ` +
      `from the table, max realised error ${r.fieldCheck.maxRealisedErrorSol.toExponential(3)} SOL   ` +
      `${r.fieldCheck.ok ? 'OK' : 'FAILED'}`,
  );
  L.push('  Only closed round trips carry a complete P&L, and that rule is the dataset\'s own —');
  L.push('  reproducing it is what lets a live measurement be compared with the published one.');
  L.push('');

  L.push('THE COST LEG — what landing cost, and what the field cleared after it, from the chain');
  L.push(
    `  ${r.costCheck.launchesPriced} launch(es) priced (needs ${r.costCheck.minLaunches}), ` +
      `${r.costCheck.entriesPriced}/${r.costCheck.entries} create-slot entries costed, ` +
      `${r.costCheck.pairsPriced} round trip(s) priced end to end (needs ${r.costCheck.minPairs})   ` +
      `${r.costCheck.ok ? 'OK' : 'FAILED'}`,
  );
  L.push(
    `  entry cost: median ${num(r.costCheck.entryCostMedianSol, 4)} SOL, ` +
      `${pct(r.costCheck.entryCostPositiveShare)} of entries above zero ` +
      `(needs ${pct(r.costCheck.minEntryCostPositiveShare)})`,
  );
  L.push(
    `  per SOL staked: ${num(r.costCheck.entryCostPerSolStakedMedianByLaunch, 4)} median PER LAUNCH ` +
      `(the unit the entry-cost bar is compared against), ` +
      `${num(r.costCheck.entryCostPerSolStakedMedianByEntry, 4)} pooled per ENTRY`,
  );
  // BOTH POPULATIONS, so the record shows the difference rather than asserting there is none. The
  // figures above are over the launches whose opening is PROVEN — the population the live bar reads.
  L.push(
    `  the population above is PROVEN openings only, matching what the gate scores; leaving the ` +
      `unproven ones in reads ` +
      `${r.costCheck.includingUnprovenLaunchesPriced} launch(es), ` +
      `${r.costCheck.includingUnprovenPairsPriced} pair(s) and ` +
      `${num(r.costCheck.includingUnprovenEntryCostPerSolStakedMedianByLaunch, 4)} per SOL staked`,
  );
  L.push(
    `  the field: hit rate ${num(r.costCheck.grossHitRate, 4)} GROSS against ` +
      `${num(r.costCheck.netHitRate, 4)} NET, median ${num(r.costCheck.grossMedianSol, 4)} against ` +
      `${num(r.costCheck.netMedianSol, 4)} SOL — ${r.costCheck.flipsPositiveToNegative} round trip(s) ` +
      `flip from positive to negative`,
  );
  L.push('  Netting measured fees must move the field DOWN and the seat must cost something. A');
  L.push('  reading that says otherwise is a sign error in the cost leg, not a discovery — which is');
  L.push('  the failure this check exists to catch before a stranger is ever priced.');
  for (const line of wrap(LANDING_TIP_CAVEAT, 84)) L.push(`  ! ${line}`);
  L.push('');

  L.push('THE KNOWN-NEGATIVE CONTROL — Stage 2 must REFUSE our subject deployer');
  for (const [label, e] of /** @type {[string, import('./entry.mjs').EntryScore][]} */ ([
    ['most recent launches (what a live run would score today)', r.subjectEntryRecent],
    ['the whole post-2026-06-04 regime', r.subjectEntryPostBreak],
    ['the post-break regime WITH its on-chain costs attached', r.costCheck.postBreakScore],
  ])) {
    L.push(
      `  ${pad(label, 52)} ${pad(e.verdict.toUpperCase(), 24)} ` +
        `room ${num(e.roomLeft.median, 3)} over ${e.launchesSampled} launches`,
    );
    // The bound travels with THIS median too (captain decision 208b). On the committed tape it reads
    // COMPLETE — our subject is proven 235/235 under the union rule and its tape carries no walk
    // drops — and printing that is the point: a reader sees that the figure is whole rather than
    // inferring it from silence, and a future tape that stops being whole says so here.
    L.push(`      ^ ${roomBoundLine(e.roomLeftBound)}`);
  }
  L.push('');
  L.push('  And here is the trap, on the one wallet where we hold the answer:');
  L.push(
    `    the FIELD leg reads ${r.subjectEntryPostBreak.fieldHitRateGrossOfFees.hits}/` +
      `${r.subjectEntryPostBreak.fieldHitRateGrossOfFees.n} closed round trips POSITIVE ` +
      `(${pct(r.subjectEntryPostBreak.fieldHitRateGrossOfFees.rate)}), median ` +
      `${num(r.subjectEntryPostBreak.fieldRealisedSolGrossOfFees.median, 3)} SOL`,
  );
  L.push('    ...gross of fees. Fee-inclusive, that same population made +0.54 SOL PER LAUNCH across');
  L.push('    106 wallets since the break, with 51 of them LOSING money. So the field leg, followed');
  L.push('    on its own, would call this wallet beatable — and it is not. That is why the field can');
  L.push('    only ever VETO a verdict here and never earn one, and why this check is the assertion');
  L.push('    rather than a threshold comparison.');
  L.push('');

  L.push(`CONTROL POPULATION — ${r.controlPopulation.n} other deployers in the dataset's own control`);
  L.push(
    `  room left (upper bound, dev buy only): p25 ${num(r.controlPopulation.roomP25, 3)}  ` +
      `median ${num(r.controlPopulation.roomMedian, 3)}  p75 ${num(r.controlPopulation.roomP75, 3)}`,
  );
  L.push(
    `  ${r.controlPresets.groupedPreset15} of ${r.controlPresets.n} use the same 14.814814813 SOL ` +
      `dev-buy preset as our subject — the preset is not operator-specific.`,
  );
  L.push('');

  L.push('-'.repeat(78));
  if (r.passed) {
    L.push('STAGE 0 PASSED. The screen reproduces every answer we already hold.');
  } else {
    L.push('STAGE 0 FAILED — do not point this screen at strangers until these are resolved:');
    for (const f of r.failures) L.push(`  · ${f}`);
  }
  L.push('-'.repeat(78));
  L.push('');
  L.push('='.repeat(78));
  for (const line of LIMITATIONS) L.push(line);
  L.push('='.repeat(78));
  return L.join('\n');
}

/**
 * Render the Stage 1 gate results.
 *
 * @param {object} run
 * @param {readonly import('./rank.mjs').Candidate[]} run.candidates
 * @param {number} run.keyedRequests
 * @param {number} run.keylessRequests
 * @param {number} [run.keylessShed] Requests pump.fun refused with a 429 or 5xx and we retried.
 *   Printed because on this endpoint a LOW shed count is the surprising one — the committed tape's
 *   own build shed 24.7% — so a zero here is a hint that the walk did not happen rather than that it
 *   went well.
 * @param {number} run.rpcRequests
 * @param {number} run.rpcLoadShedEvents
 * @param {'creation-derived' | 'ownership-only'} run.historySource
 * @param {number} run.elapsedMs
 * @param {string} run.startedAtIso
 * @param {boolean} run.completed Whether enumeration and gating ran to the end. **Load-bearing.**
 *   Two very different things used to share one `truncated` flag: a run that finished but whose
 *   candidate cap dropped seeded wallets, and a run that died at a request. Only the first may say
 *   every candidate was evaluated, so the renderer is told which happened rather than guessing.
 *
 *   The record's own `truncated` is deliberately NOT an input: it is the disjunction of those two
 *   states, and this function needs them apart. It reads `completed` for the abort and
 *   `coverage.coverageTruncated` for the cap.
 * @param {string | null} run.truncationReason
 * @param {number} run.prefiltered
 * @param {import('./seed.mjs').SeedCoverage} run.coverage
 * @param {{ keyedCeiling: number, keyedRemaining: number, plannedWorstCaseKeyed: number,
 *   candidateCap: number, endpoints: readonly import('./client.mjs').EndpointSpend[] }} [run.spend]
 *   Where the keyed allowance actually went. Optional only so a caller rendering a schema-2 record
 *   is not forced to invent one; a live run always passes it.
 * @param {readonly import('./record.mjs').Unmeasured[]} [run.unmeasured] Measurements the run could
 *   not take. Rendered as its own block rather than left to the per-candidate note, because a
 *   ceiling that stopped the tool looking is a fact about the RUN — a reader who scans the header
 *   and the coverage block must not come away believing everything reported was measured.
 * @param {Record<string, unknown>} run.thresholds
 * @returns {string}
 */
export function renderStage1(run) {
  const L = [];
  const passed = run.candidates.filter((c) => c.verdict === 'gate-passed');
  const notMeasured = run.candidates.filter((c) => c.verdict === 'gate-unmeasured');
  const failed = run.candidates.filter((c) => c.verdict === 'gate-failed');

  L.push('='.repeat(78));
  L.push('STAGE 1 — completion-rate GATE. This tool gates; it does not recommend.');
  L.push('='.repeat(78));
  L.push('');
  L.push(`run started        ${run.startedAtIso}`);
  L.push(`keyed requests     ${run.keyedRequests}  (MadeOnSol, Ultra — ${MADEONSOL_DAILY_REQUESTS.toLocaleString('en-US')}/day, exclusive to this lane)`);
  L.push(
    `keyless requests   ${run.keylessRequests}  (pump.fun)` +
      (run.keylessShed === undefined ? '' : `, ${run.keylessShed} shed and retried`),
  );
  L.push(`solana rpc         ${run.rpcRequests}  (creation-derived history; ${run.rpcLoadShedEvents} load-shed)`);
  L.push(`history source     ${run.historySource}${run.historySource === 'ownership-only' ? '  !! BIASED BOTH WAYS (rejects on counts, inflates the rate)' : ''}`);
  L.push(`elapsed            ${(run.elapsedMs / 1000).toFixed(1)}s`);
  L.push(`prefiltered out    ${run.prefiltered}  (skipped before spending a request)`);
  L.push(`candidates gated   ${run.candidates.length}`);
  L.push(`gate passed        ${passed.length}`);
  L.push(`gate unmeasured    ${notMeasured.length}  (reading incomplete — NOT rejections)`);
  L.push(`gate failed        ${failed.length}`);

  // Run-level drop tally. A per-wallet count can look like one awkward launch; the total across the
  // run is the level at which a systematic clock disagreement becomes visible, and it is the only
  // reason we would ever learn that the stranger case does not behave like our own tape.
  const runDrops = run.candidates.reduce(
    (acc, c) => (c.entryCoverage === null ? acc : addDropReasons(acc, c.entryCoverage.dropsByReason)),
    emptyDropReasons(),
  );
  const runDropTotal = totalDrops(runDrops);
  if (runDropTotal > 0) {
    L.push('');
    L.push('STAGE 2 DROPS — every launch window the entry walk refused, across the whole run');
    for (const line of renderDropTally(runDropTotal, runDrops, '  ')) L.push(line);
  }
  L.push('');

  if (run.spend !== undefined) {
    L.push('SPEND — every keyed request, by endpoint, with what each call costs');
    L.push(`  ${pad('endpoint', 36)}${padl('calls', 6)}  ${pad('cost per call', 48)}role`);
    for (const e of run.spend.endpoints) {
      L.push(`  ${pad(e.endpoint, 36)}${padl(String(e.calls), 6)}  ${pad(e.costModel, 48)}${e.role}`);
    }
    if (run.spend.endpoints.length === 0) L.push('  (none — no keyed request was issued)');
    L.push(
      `  ${padl(String(run.keyedRequests), 42)} total, against a ceiling of ${run.spend.keyedCeiling} ` +
        `(${run.spend.keyedRemaining} unspent; planned worst case ${run.spend.plannedWorstCaseKeyed})`,
    );
    L.push('');
  }

  const cov = run.coverage;
  L.push('SEED YIELD — per query, because an inert seed is otherwise invisible');
  L.push(`  ${pad('query', 34)}${padl('rows', 6)}  ${padl('wallets', 8)}`);
  for (const s of cov.seeds) {
    L.push(`  ${pad(s.label, 34)}${padl(String(s.rowsReturned), 6)}  ${padl(String(s.walletsReturned), 8)}`);
  }
  if (cov.inertSeeds.length > 0) {
    L.push('');
    L.push(`  !! ${cov.inertSeeds.length} SEED(S) YIELDED NO WALLET: ${cov.inertSeeds.join(', ')}`);
    L.push('     Each still cost a keyed request. If its row count is non-zero the vendor answered');
    L.push('     and OUR READER is wrong — check the envelope and block keys in seed.mjs.');
  }
  L.push('');
  L.push('COVERAGE — what enumeration surfaced versus what was actually gated');
  L.push(`  ${padl(String(cov.distinctWalletsSeeded), 4)} distinct wallets seeded`);
  L.push(`  ${padl(String(cov.prefilteredOut), 4)} prefiltered out before spending a request`);
  L.push(`  ${padl(String(cov.worthARequest), 4)} worth a request, against a candidate cap of ${cov.candidateCap}`);
  L.push(`  ${padl(String(cov.droppedByCandidateCap), 4)} dropped by the candidate cap, never measured`);
  L.push(`  ${padl(String(cov.gated), 4)} gated`);

  if (!run.completed) {
    L.push('');
    L.push(`!! RUN STOPPED EARLY — ${run.truncationReason ?? 'the run did not reach the end'}`);
    L.push('   THIS IS NOT A SCREEN AND NOT A MEASURED OUTCOME. The run died before it finished, so');
    L.push('   wallets below this point were never requested and nothing here is a negative result.');
    L.push('   The record is kept only so the requests already paid for are not spent twice.');
  } else if (cov.coverageTruncated) {
    L.push('');
    L.push(`!! COVERAGE TRUNCATED — ${run.truncationReason ?? 'the candidate cap dropped seeded wallets'}`);
    L.push('   The run completed and every candidate it gated was evaluated, but it is NOT a screen');
    L.push('   of everything enumeration found.');
  }

  const unmeasured = run.unmeasured ?? [];
  if (unmeasured.length > 0) {
    L.push('');
    L.push(`!! ${unmeasured.length} MEASUREMENT(S) NOT TAKEN — the tool could not look`);
    // One block per kind, because each one tells the reader to do something different — and the
    // grouping key is the wallet-independent summary, so a hundred failed wallets are one line.
    for (const [kind, entries] of partitionUnmeasured(unmeasured)) {
      const meta = kindMetaOf(kind);
      L.push(`   ${meta.heading}`);
      L.push(`   ${meta.advice}`);
      for (const [summary, n] of groupUnmeasured(entries)) {
        L.push(`     · ${n} candidate(s): ${summary}`);
      }
    }
    L.push('   Whichever it was, it is NEVER a measured result: the affected candidates read');
    L.push('   UNMEASURED below, and their absence of a finding is not a finding.');
  }
  L.push('');

  if (passed.length === 0) {
    if (run.completed) {
      L.push('NO CANDIDATE CLEARED THE GATE.');
      L.push('');
      L.push('This is a real measured outcome, not an error — the run completed and every candidate');
      L.push('was evaluated. If the run had failed instead, it would have exited non-zero and said so');
      L.push('above. The per-candidate reasons are listed below.');
      if (notMeasured.length > 0) {
        L.push('');
        L.push(`EXCEPT for ${notMeasured.length} candidate(s) whose reading was NOT MEASURED — see the`);
        L.push('GATE UNMEASURED section below. Those wallets were not judged at all, so "no candidate');
        L.push('cleared the gate" does not cover them.');
      }
    } else {
      // Never the completion language on an aborted run: an empty ranking that reads as a real
      // negative is the one output this tool exists to make impossible.
      L.push('NO CANDIDATE HAD CLEARED THE GATE WHEN THE RUN DIED.');
      L.push('');
      L.push('THIS IS NOT A NEGATIVE RESULT. The run did not complete, so "nothing cleared the gate"');
      L.push('here means "the run stopped", not "these deployers are not competent". Candidates that');
      L.push('were never requested cannot have failed. Resolve the failure above and rerun; the');
      L.push('screen is stateless.');
    }
  } else {
    L.push('CLEARED THE COMPETENCE GATE — and, where Stage 2 reached them, scored for ENTRY');
    L.push('');
    L.push(
      `  ${pad('wallet', 46)}${padl('n', 4)}  ${padl('done', 5)}  ${padl('rate', 7)}  ` +
        `${padl('days', 5)}  ${pad('cap', 4)}  seeds`,
    );
    for (const c of passed) {
      L.push(
        `  ${pad(c.wallet, 46)}${padl(String(c.completion.tokens), 4)}  ` +
          `${padl(String(c.completion.completed), 5)}  ${padl(pct(c.completion.rate), 7)}  ` +
          `${padl(num(c.completion.spanDays, 0), 5)}  ${pad(c.completionCapped ? 'yes' : 'no', 4)}  ` +
          `${c.seededBy.length}`,
      );
      if (c.creation !== null) {
        L.push(
          `      created ${c.creation.createdInWindow} in a ${num(c.creation.coveredDays, 1)}d window ` +
            `(ownership showed ${c.creation.listedInWindow}: ${c.creation.hiddenByOwnership} HIDDEN, ` +
            `${c.creation.notCreatedByWallet} acquired, ${c.creation.movedCreator} creator moved); ` +
            `+${c.creation.listedOutsideWindow} carried over from the listing`,
        );
        // Captain decision 227a, printed on EVERY gate survivor rather than only where the share is
        // non-zero: this list is what a later decision reads to size the screen's mayhem exposure,
        // and a wallet that is silent here would be indistinguishable from one measured at zero.
        for (const line of renderMayhemShare(c.creation, '      ')) L.push(line);
        // A walk that covered nothing gets its own sentence rather than the general one with a
        // hole where the date should be. "Before null" tells a reader nothing, and the state it
        // stands for — the reading falls back to the ownership listing, with no window to correct
        // it — is the one they most need to know before reading the rate above as a correction.
        // An empty window withdraws the right to call a listed token "acquired"; it does NOT
        // discard the creates the walk proved on the page it abandoned, and those are exactly the
        // launches ownership hides, so the sentence has to count them in rather than claim the
        // listing is the whole of it. The two parts are NAMED and only the listing's row count is
        // quoted: the walk-proven remainder is not a number this record can derive, because a
        // listing row with no timestamp or no mint counts once here and not at all in the gate's
        // history, and printing a derived difference would be printing a number we do not have.
        if (c.creation.coveredFromIso === null) {
          L.push(
            `      ^ the walk stopped on ${c.creation.stopReason} before covering ANY window, so ` +
              `these ${c.completion.tokens} launch(es) are the ownership listing ` +
              `(${c.creation.listedOutsideWindow} row(s)) plus whatever creates the walk proved ` +
              `before stopping — a LOWER BOUND, biased towards rejection`,
          );
        } else if (!c.creation.wholeHistory) {
          L.push(
            `      ^ the walk stopped on ${c.creation.stopReason}, so anything created before ` +
              `${c.creation.coveredFromIso} is a LOWER BOUND from the ownership listing`,
          );
        }
        if (c.creation.curvesUnread > 0) {
          L.push(
            `      ^ ${c.creation.curvesUnread} curve account(s) unread; bonded status came from ` +
              `the on-chain curve for ${c.creation.bondedFromCurve} launch(es) and from the ` +
              `ownership listing for ${c.creation.bondedFromListing}`,
          );
        }
        if (!c.creation.windowExact) {
          L.push(
            `      ^ ${c.creation.unresolvedTransactions} transaction(s) never resolved, so the walk ` +
              `is NOT authoritative inside its own window: ${c.creation.listedInWindowCarried} ` +
              `in-window listing row(s) were carried rather than read as acquired`,
          );
        }
      }
      if (c.verdict !== c.vendorVerdict) {
        L.push(
          `      ^ VERDICT CHANGED: the ownership reading (${c.vendorCompletion.completed}/` +
            `${c.vendorCompletion.tokens}) would have said ${c.vendorVerdict}`,
        );
      }
      if (c.entry !== null) {
        L.push('');
        for (const line of renderEntry(c.entry, c.entryCoverage)) L.push(line);
        L.push('');
      } else {
        L.push('      ENTRY: NOT SCORED — no entry measurement was taken for this wallet.');
        L.push('      Passing the competence gate says nothing about whether its window is enterable.');
      }
      if (c.consistency !== null) {
        L.push(`      consistency: ${c.consistency.state.toUpperCase()} — ${c.consistency.note}`);
        if (c.consistency.historyTruncated) {
          L.push('      ^ computed over a PAGE-CAPPED creator walk, so it is a lower bound twice over.');
        }
      } else {
        L.push('      consistency over time: UNMEASURED (pass --consistency to measure, keyless)');
      }
    }
    L.push('');
    L.push('  n    = launches in the denominator we computed ourselves — CREATED by this wallet');
  L.push('         inside the creation window, plus whatever the ownership listing showed before it');
    L.push('  done = of those, how many completed the bonding curve');
    L.push('  cap  = the page the GATE\'S reading came from was full, so older launches exist that');
  L.push('         it does not show. Under creation-derived history that is the ownership listing,');
  L.push('         which supplies everything before the creation window.');
    L.push(`  seeds= how many of this run's ${run.coverage.seeds.length} enumeration queries surfaced this wallet`);
    L.push('');
    // The legend has to speak the vocabulary the run actually emitted, and it has to state the
    // gross-only limit exactly where it is true. Naming a verdict this tool can no longer emit, or
    // calling a NET figure gross, misreads the run for whoever reads it — and the candidates are
    // already in hand here, so the condition is a fact about THIS run rather than a hedge.
    const anyPriced = passed.some((c) => c.entry !== null && c.entry.entryCostPriced.hits > 0);
    L.push('  NO VERDICT HERE MEANS "BEATABLE". ENTRY-OPEN-AFTER-COSTS is the strongest thing this');
    L.push('  stage says: room was present, the seat was priced from the chain, and the field still');
    L.push('  cleared after paying for it — so the EXIT question is worth asking. Exit is unmeasured.');
    L.push('  ENTRY-COST-PROHIBITIVE and ENTRY-COST-UNMEASURED are both REFUSALS, and the second is');
    L.push('  the absence of a finding rather than a finding of absence: the seat went unpriced, which');
    L.push('  is never evidence that it was cheap.');
    // Captain decision 174b. The legend is where a reader learns what a verdict is worth, so it is
    // where the filter rule belongs too — an unmeasured verdict is seven producers and every one of
    // them is ours.
    L.push('  EVERY unmeasured verdict prints a CAUSE line saying WHOSE fact it is, and all seven');
    L.push('  producers are OUR COVERAGE. A later stage may filter ONLY on a MEASURED verdict, and');
    L.push('  never on an unmeasured one whatever its cause: an unmeasured outcome is no answer and');
    L.push('  must be carried forward, counted, never dropped. Filtering on the verdict alone');
    L.push('  filters on our own budget and evidence (decision 174b).');
    if (anyPriced) {
      L.push('  The *NET* figures above are the on-chain correction and they sit BESIDE the *GROSS*');
      L.push('  ones rather than replacing them. They are an UPPER bound themselves: a landing tip');
      L.push('  paid in a separate transaction of the same bundle is in neither figure.');
      L.push('  Where a candidate\'s own block says NOT MEASURED, only the gross figures exist for it,');
      L.push('  and those are an upper bound.');
    } else {
      L.push('  No candidate in this run carries a priced seat — the cost leg does not run under');
      L.push('  --no-stage2 or a --stage0 run, and does not run for a candidate the free legs (room,');
      L.push('  or the field GROSS of fees) already refused. So every realised figure above is gross');
      L.push('  of fees and therefore an upper bound.');
    }
  }

  // Its own section, never folded into either list. A candidate that appeared in neither would
  // vanish from the report entirely, and one listed among the rejections would be read as judged
  // and found wanting — which is the false rejection this whole reading exists to remove, restored
  // at the last step.
  if (notMeasured.length > 0) {
    L.push('');
    L.push('GATE UNMEASURED — THIS IS NOT A NEGATIVE RESULT');
    L.push('  These wallets were NOT judged. The launch history the gate reads was incomplete, so');
    L.push('  the thresholds decided nothing about them: they are neither rejected nor passed, and');
    L.push('  the absence of a finding here is not a finding. Rerun to measure them.');
    for (const c of notMeasured) {
      L.push(`  ${c.wallet}`);
      L.push(`      · ${c.rationale}`);
      if (c.creation !== null && c.creation.bondedUndecidable > 0) {
        L.push(
          `      · bonded status: ${c.creation.bondedFromCurve} from the on-chain curve, ` +
            `${c.creation.bondedFromListing} from the ownership listing, ` +
            `${c.creation.bondedUndecidable} UNDECIDABLE`,
        );
      }
      if (c.creation !== null && c.creation.listingUnmeasuredNote !== null) {
        L.push(`      · ownership listing unread: ${c.creation.listingUnmeasuredNote}`);
      }
      // 227a. An unjudged wallet is still a candidate this run enumerated, and its mayhem exposure
      // is a fact about the launches rather than about the gate that could not decide over them.
      for (const line of renderMayhemShare(c.creation, '      · ')) L.push(line);
    }
  }

  if (failed.length > 0) {
    L.push('');
    L.push('DID NOT CLEAR THE GATE');
    L.push('  (a false rejection here is INVISIBLE — the wallet is dropped and nothing downstream');
    L.push('   contradicts it — so each row states which history the rejection was computed over)');
    for (const c of failed) {
      L.push(`  ${c.wallet}`);
      for (const reason of c.gate.reasons) L.push(`      · ${reason}`);
      if (c.creation !== null && c.creation.coveredFromIso === null) {
        // The heading above promises each row states which history it was rejected over. A walk
        // that covered no window at all was rejected over the ownership listing plus whatever
        // creates it proved before stopping, and saying "a 0.0d creation window" without saying
        // that would leave the promise unkept. The count printed is the one the gate read — naming
        // the listing alone would put a number here LOWER than the denominator of the rate above,
        // which is the same rendered-prose-contradicts-the-reading defect this lane exists to close.
        L.push(
          `      · the creation walk covered NO window (stopped on ${c.creation.stopReason}), so ` +
            `this was computed over ${c.completion.tokens} launch(es) — the ownership listing ` +
            `(${c.creation.listedOutsideWindow} row(s)) plus whatever creates the walk proved ` +
            `before stopping — the biased reading`,
        );
      } else if (c.creation !== null && !c.creation.wholeHistory) {
        L.push(
          `      · computed over a ${num(c.creation.coveredDays, 1)}d creation window ` +
            `(stopped on ${c.creation.stopReason}) plus ${c.creation.listedOutsideWindow} ` +
            `ownership-listed launches before it`,
        );
      }
      // 227a here too. A rejected wallet's mayhem exposure is what tells a later decision whether
      // this bar is being applied to two different populations through one number — the confounder
      // §3 of `slot-zero-graduation-regime-remeasure` names (held in firstmate's records, not in
      // this repo) — and that question is answered from the REJECTIONS as much as the survivors.
      for (const line of renderMayhemShare(c.creation, '      · ')) L.push(line);
      if (c.historySource === 'ownership-only') {
        L.push('      · OWNERSHIP-ONLY run: this rejection was computed on the biased reading');
      }
    }
  }

  L.push('');
  for (const line of wrap(MAYHEM_OBSERVATION_ONLY, 78)) L.push(`  ! ${line}`);

  L.push('');
  L.push('='.repeat(78));
  for (const line of LIMITATIONS) L.push(line);
  L.push('='.repeat(78));
  return L.join('\n');
}

/**
 * Render the dry-run request plan.
 *
 * The plan is built by the same functions the real run uses, so this is a preview rather than an
 * approximation. The per-candidate cost is stated as a formula because the candidate list is not
 * knowable until the enumeration has actually run — saying so is more honest than inventing a
 * concrete list.
 *
 * @param {object} plan
 * @param {readonly import('./seed.mjs').SeedPlanEntry[]} plan.seedPlan
 * @param {number} plan.maxCandidates
 * @param {number} plan.maxKeyedRequests
 * @param {boolean} plan.consistency
 * @param {number} plan.maxKeylessRequests
 * @param {boolean} plan.stage2
 * @param {number} plan.maxScored
 * @param {import('./stage2.mjs').Stage2Thresholds} plan.entryThresholds
 * @param {'creation-derived' | 'ownership-only'} plan.historySource
 * @param {{ maxRpcRequestsPerCandidate: number, rpcMinIntervalMs: number }} plan.creationWalk
 * @param {{ maxRpcRequestsPerCandidate: number, rpcMinIntervalMs: number, preferBlockRoute: boolean }} plan.costBounds
 * @param {{ length: number, hasDocumentedPrefix: boolean } | null} plan.keyDescription
 * @param {import('./credential.mjs').SolanaRpcEndpoint} plan.rpcEndpoint Which Solana RPC endpoint
 *   the creation walk would reach, and — on the keyed one — the key's length and shape. **Never its
 *   value and never the composed URL**: `label` is the only form printed.
 * @param {{ maxCreditsPerCandidate: number, maxCreditsPerRun: number, maxPagesPerCandidate: number,
 *   pageLimit: number, rpcMinIntervalMs: number }} plan.indexedWalk
 * @param {number} plan.worstCaseCredits The run's declared worst-case Helius spend, 0 when the walk
 *   would not run on Helius. Computed by `screen.mjs` from the same values it refuses a plan on, so
 *   this is the preview of an enforced bound rather than a second estimate of it.
 * @param {{ creationQueryId: number, coverageQueryId: number, maxExecutionsPerRun: number,
 *   maxRequestsPerRun: number, maxResultRows: number, maxCoverageLagMs: number,
 *   minIntervalMs: number, worstCaseCreditsPerExecution: number, resultBytesPerRowCeiling: number,
 *   allowanceReserveCredits: number, allowanceTightMultiple: number,
 *   allowanceRequired: boolean }} plan.dune The pinned Dune bounds.
 * @param {import('./credential.mjs').DuneCredential} plan.duneCredential Never its value: `label`,
 *   a length and a shape are the only things printed.
 * @param {boolean} plan.usingDune Whether creation enumeration would take the Dune route.
 * @param {boolean} plan.duneRefreshProbe Whether the coverage probe would be re-EXECUTED (billed)
 *   rather than read from Dune's cache (free).
 * @returns {string}
 */
export function renderDryRun(plan) {
  const L = [];
  L.push('='.repeat(78));
  L.push('DRY RUN — nothing was fetched. This is exactly what a real run would request.');
  L.push('='.repeat(78));
  L.push('');

  if (plan.keyDescription === null) {
    L.push('credential   NOT PRESENT — a real run would stop before its first request.');
  } else {
    L.push(
      `credential   present, ${plan.keyDescription.length} characters, ` +
        `documented msk_ prefix: ${plan.keyDescription.hasDocumentedPrefix ? 'yes' : 'no'} ` +
        `(value never read, printed or stored)`,
    );
  }
  L.push('');

  L.push(`KEYED — MadeOnSol, ${plan.seedPlan.length} enumeration requests, exactly these:`);
  for (const e of plan.seedPlan) {
    // The real run's own path builder, not a re-implementation of it. That is what makes
    // "byte-identical URLs" a property rather than a coincidence that holds while every planned
    // value happens to need no percent-encoding.
    L.push(`  GET ${buildPath(e.path, e.query)}`);
  }
  L.push('');
  L.push('KEYED — then one profile request per candidate, up to the candidate cap:');
  L.push(`  GET /deployer-hunter/{wallet}              x  up to ${plan.maxCandidates}`);
  L.push('');
  L.push(
    `  worst case ${plan.seedPlan.length} + ${plan.maxCandidates} = ` +
      `${plan.seedPlan.length + plan.maxCandidates} keyed requests, ceiling ${plan.maxKeyedRequests}.`,
  );
  L.push('  The ceiling is enforced before each request, and a plan whose worst case does not fit');
  L.push('  under it is refused BEFORE the first request rather than allowed to die part-way.');
  L.push('');
  L.push('KEYED ENDPOINTS — the whole surface this tool touches, and the cost of each call:');
  L.push(`  ${pad('endpoint', 36)}${pad('cost', 48)}role`);
  for (const [endpoint, meta] of Object.entries(ENDPOINT_ROLES)) {
    L.push(`  ${pad(endpoint, 36)}${pad(meta.costModel, 48)}${meta.role}`);
  }
  L.push('');

  const t = plan.entryThresholds;
  if (plan.stage2) {
    const worstCase = plan.maxScored * t.maxLaunchesPerCandidate * t.maxRequestsPerLaunch;
    L.push('KEYLESS — STAGE 2, the ENTRY score. pump.fun fill tape, for gate survivors only:');
    L.push('  GET https://swap-api.pump.fun/v2/coins/{mint}/trades?limit=' + `${t.tradePageLimit}&cursor=0-{seekFromMs}`);
    L.push('');
    L.push('  This stage spends NO KEYED REQUEST. The mint list comes from the profile Stage 1 has');
    L.push('  already paid for, so the shared vendor allowance is untouched by everything below.');
    L.push('');
    L.push(`  survivors scored              up to ${plan.maxScored}  (pinned cap ${t.maxCandidatesScored})`);
    L.push(`  launches per survivor         up to ${t.maxLaunchesPerCandidate}`);
    L.push(`  requests per launch           up to ${t.maxRequestsPerLaunch}, RETRIES INCLUDED`);
    L.push(`                                (measured at this ${windowReachMs(t) / 1000}s reach over the 127 committed`);
    L.push('                                launches whose tape outlives it: p50 6 pages, p90 8,');
    L.push('                                p95 9, max 17; ~25% shed rate)');
    L.push(
      `  WORST CASE                    ${plan.maxScored} x ${t.maxLaunchesPerCandidate} x ` +
        `${t.maxRequestsPerLaunch} = ${worstCase} request(s)`,
    );
    L.push(`  stage ceiling                 ${t.maxKeylessRequests}, enforced on its own client`);
    // The wall clock, not just the request count. An estimate that is stale in the OPTIMISTIC
    // direction gets a run killed by an operator who thinks the tool has hung, so this is derived
    // from the pinned pacing rather than written down once.
    const typicalRequests = plan.maxScored * t.maxLaunchesPerCandidate * 6;
    /** @param {number} requests */
    const minutes = (requests) => Math.round((requests * t.keylessMinIntervalMs) / 60_000);
    L.push(
      `  pacing                        ${t.keylessMinIntervalMs / 1000}s between requests, ` +
        `swap-api ONLY (this host sheds ~25%)`,
    );
    L.push(
      `  TIME                          about ${minutes(typicalRequests)} min typical ` +
        `(~6 requests/launch, this walk's p50 over those 127 launches), ` +
        `about ${minutes(worstCase)} min worst case`,
    );
    L.push(
      worstCase <= t.maxKeylessRequests
        ? '  The worst case is at or under the ceiling, so the plan above is the WHOLE exposure.'
        : '  !! The worst case EXCEEDS the ceiling — the ceiling binds and the run will stop early.',
    );
    L.push('  A launch is only started when a full page-cap of headroom remains, so no launch is');
    L.push(`  ever abandoned half-walked. Window measured: ${t.windowSlotSpan} SLOTS from the create`);
    L.push(`  slot — the chain's own ordering, not the vendor's clock. The seek reaches ${windowReachMs(t) / 1000}s`);
    L.push(`  past the mint: that same ${t.windowSlotSpan} slots at a measured worst-case rate, plus ${t.seekMarginMs / 1000}s of`);
    L.push('  clock slack, so an early vendor mint time cannot truncate the tail; that');
    L.push('  margin is a cursor hint and never a tolerance on the pre-mint drop. A launch is not');
    L.push(`  walked until it is ${windowReachMs(t) / 1000}s old — the SAME derivation, not a second number, so the`);
    L.push('  gate cannot fall behind the cursor when the chain slows. Pinned keyless');
    L.push('  pacing, one request in flight.');
    L.push('');

    const c = plan.costBounds;
    const costWorstCase = plan.maxScored * c.maxRpcRequestsPerCandidate;
    L.push('KEYLESS — STAGE 2, THE PRICE OF THE SEAT. Solana RPC, on survivors of the free legs:');
    L.push('  POST https://api.mainnet-beta.solana.com  getBlock + getTransaction');
    L.push('');
    L.push('  Fees are part of the entry window (captain, 2026-08-02), so a room figure without the');
    L.push('  price of the seat beside it is not an answer to "is this enterable". The signatures');
    L.push('  come free with fills Stage 2 already parsed — no vendor request, no extra swap-api page.');
    L.push('');
    L.push(`  requests per candidate        up to ${c.maxRpcRequestsPerCandidate}`);
    L.push(
      `  WORST CASE                    ${plan.maxScored} x ${c.maxRpcRequestsPerCandidate} = ` +
        `${costWorstCase} request(s), about ` +
        `${Math.round((costWorstCase * c.rpcMinIntervalMs) / 60_000)} min`,
    );
    L.push(
      `  pacing                        ${c.rpcMinIntervalMs / 1000}s, INHERITED from the creation ` +
        `walk — one global limiter`,
    );
    L.push('  IT RUNS ONLY ON A CANDIDATE THE FREE LEGS HAVE NOT ALREADY REFUSED. Room and the gross');
    L.push('  field are arithmetic over fills in hand, so a deployer failing either costs 0 requests');
    L.push('  here. Measured per launch on our own tape: ~19 DISTINCT transactions at the median once');
    L.push('  the create-slot scope (p50 7) and the closed-round-trip window scope (p50 18) are');
    L.push('  unioned — 19 IS the union, not 7 + 19, because none is paid for twice.');
    L.push(
      `  Whole-block route ${c.preferBlockRoute ? 'PROBED FIRST' : 'DISABLED'} behind a fallback to per-signature reads; ` +
        `the record says which ran.`,
    );
    for (const line of wrap(LANDING_TIP_CAVEAT, 78)) L.push(`  ! ${line}`);
  } else {
    L.push('KEYLESS — STAGE 2 DISABLED (--no-stage2). No entry measurement would be taken, so the');
    L.push('  run would report competence only and nothing about whether a window is enterable.');
  }
  L.push('');

  if (plan.historySource === 'creation-derived') {
    const d = plan.dune;
    L.push('KEYED — Dune, CREATION ENUMERATION. THE PRIMARY SURFACE (captain decision 156a):');
    if (!plan.usingDune) {
      L.push(
        `  NOT USED — ${plan.duneCredential.rejected !== null ? 'the key was present but malformed' : plan.duneCredential.available ? '--no-dune was passed' : `${plan.duneCredential.keyEnvVar ?? 'the key variable'} is not set`}. ` +
          'Creation enumeration falls back to the',
      );
      L.push('  Solana RPC walk below: the same measurement, slower by about an order of magnitude.');
      if (plan.duneCredential.rejected !== null) L.push(`  !! ${plan.duneCredential.rejected}`);
    } else {
      if (plan.duneCredential.keyDescription !== null) {
        L.push(
          `  credential   present, ${plan.duneCredential.keyDescription.length} characters, ` +
            `alphanumeric: ${plan.duneCredential.keyDescription.hasDocumentedShape ? 'yes' : 'no'} ` +
            `(value never read, printed or stored; sent as a header, never in a URL)`,
        );
      }
      L.push(
        `  POST ${plan.duneCredential.label}/usage                          x 1   THE CREDIT CEILING (free, no execution)`,
      );
      L.push(`  GET  ${plan.duneCredential.label}/query/{id}                 x 2   verify the saved SQL`);
      L.push(
        `  GET  ${plan.duneCredential.label}/query/${d.coverageQueryId}/results` +
          `   x 1   COVERAGE PROBE${plan.duneRefreshProbe ? ' (--dune-refresh-probe: EXECUTED instead)' : ' (CACHED — no execution)'}`,
      );
      L.push(`  POST ${plan.duneCredential.label}/query/${d.creationQueryId}/execute   x 1   one execution for ALL candidates`);
      L.push('');
      L.push('  ONE EXECUTION FOR THE WHOLE BATCH, and that is the cost model rather than a');
      L.push('  convenience: the table scan costs nearly the same for 5 wallets as for 20, so the');
      L.push('  per-deployer price falls as the batch grows. What scales is BYTES RETURNED, which');
      L.push('  is why the SQL selects six columns and no more, and why the rows a single deployer');
      L.push('  may contribute are CAPPED. The cap is per DEPLOYER, not per batch: one');
      L.push('  industrial-spam wallet used to carry the whole result past the row ceiling and send');
      L.push('  EVERY candidate to the walk. Now that wallet walks alone and the rest keep Dune.');
      L.push('');
      L.push('  A FAILED EXECUTION IS STILL BILLED AND IS NEVER RETRIED. Polling is retried; an');
      L.push('  execution is not, because a second one buys a second bill for the same answer.');
      L.push('');
      L.push(
        `  executions                    up to ${d.maxExecutionsPerRun}  (1 enumeration + at most 1 probe refresh)`,
      );
      L.push(`  requests                      ceiling ${d.maxRequestsPerRun}, polling and result reads included`);
      // WHAT THE PLAN COULD COST, IN THE UNIT THE MONTHLY ALLOWANCE IS DENOMINATED IN, printed
      // before anything is spent. A real run is ~20 credits; this is the worst case the ceilings
      // above admit, and it is what a live run compares the account's remaining balance against —
      // the balance itself needs the key and so is read on a real run only, never here.
      const spend = estimatePlanCredits(duneSpendPlan(d));
      L.push(
        `  worst case                    ${spend.worstCaseCredits} credit(s) = ${spend.executionCredits} compute ` +
          `(${d.maxExecutionsPerRun} x ${d.worstCaseCreditsPerExecution}) + ${spend.exportCredits} export ` +
          `(${spend.exportBytes} bytes at ${d.resultBytesPerRowCeiling} bytes/row)`,
      );
      L.push(
        `  refuses below                 ${spend.worstCaseCredits + d.allowanceReserveCredits} credit(s) remaining ` +
          `(worst case + a ${d.allowanceReserveCredits}-credit reserve for the counter's lag), and falls back to the walk`,
      );
      // THE TWO BOUNDS THAT ACTUALLY HOLD, printed as the arithmetic that produces them. The SQL's
      // per-deployer cap is the greater of a pinned floor and the row ceiling shared out, so above
      // 39 deployers the floor binds and the SQL's rows bound EXCEEDS the reader's ceiling — which
      // the reader then refuses whole, the fallback merged `main` already had. What bounds the
      // BILLED unit is unchanged: every read is issued with `?limit=maxResultRows`.
      const plannedCandidates = Math.max(1, plan.maxCandidates);
      const perDeployerRows = launchCapPerWallet(plannedCandidates);
      const sqlRows = perDeployerRows * plannedCandidates;
      const readableRows = Math.min(sqlRows, d.maxResultRows);
      L.push(
        `  rows, per deployer            cap ${perDeployerRows.toLocaleString('en-US')} at this run's ${plannedCandidates} candidate(s) ` +
          `(the greater of the ${LAUNCH_CAP_FLOOR}-row floor and the ${d.maxResultRows.toLocaleString('en-US')}-row ceiling shared out)`,
      );
      L.push(
        `  rows, whole run               at most ${sqlRows.toLocaleString('en-US')} from the SQL` +
          (sqlRows > d.maxResultRows
            ? `, ABOVE the ${d.maxResultRows.toLocaleString('en-US')} ceiling — a batch that fills every cap is REFUSED whole and walks`
            : `, under the ${d.maxResultRows.toLocaleString('en-US')} ceiling the reader refuses at`),
      );
      L.push(
        `  bytes                         at most ~${((readableRows * DUNE_BYTES_PER_ROW_CEILING) / 1_000_000).toFixed(2)} MB ` +
          `(<=${DUNE_BYTES_PER_ROW_CEILING} bytes/row: 105.92 MEASURED at the six columns CREATION_SQL selects today)`,
      );
      L.push(
        `  EXPECTED                      about ${(DUNE_EXPECTED_CREDITS_PER_CANDIDATE * plan.maxCandidates).toFixed(1)} credits at the candidate cap ` +
          `(~${DUNE_EXPECTED_CREDITS_PER_CANDIDATE} per deployer, measured 2026-08-03)`,
      );
      L.push(
        `  WORST CASE                    about ${Math.round((readableRows * DUNE_BYTES_PER_ROW_CEILING * 20) / 1_000_000)} credits ` +
          `for the largest read the ?limit= allows, at the published 20 credits/MB`,
      );
      L.push(
        `  A DEPLOYER ABOVE THE CAP IS REFUSED, NOT TRUNCATED QUIETLY: its rows are a prefix, its`,
      );
      L.push('  true count comes back beside them, and it alone falls back to the creation walk.');
      L.push(
        `  Free tier ${DUNE_MONTHLY_CREDITS.toLocaleString('en-US')} credits/month and SHARED with whatever else holds this key.`,
      );
      L.push('  NOTHING HERE TRACKS THE MONTH: this tool holds no state between runs, so the monthly');
      L.push('  arithmetic is yours — the same limit the Helius block below states.');
      L.push(`  pacing                        ${d.minIntervalMs}ms between requests (a courtesy floor; unmeasured)`);
      L.push('');
      L.push('  EVERY COUNT SHIPS WITH ITS OWN COVERAGE PROBE, and a count reaching outside the');
      L.push('  probed coverage is REFUSED rather than published — that wallet falls back to the');
      L.push('  walk. Decoded tables have silent start dates: they answer confidently and wrongly');
      L.push(`  before their first row. Staleness past ${Math.round(d.maxCoverageLagMs / 3_600_000)}h re-executes the probe once.`);
    }
    L.push('');
  }

  if (plan.historySource === 'creation-derived' && plan.rpcEndpoint.provider === 'helius') {
    const h = plan.indexedWalk;
    // Not `rpcMinIntervalMs` alone: below ~250ms of enforced interval this walk is latency-bound,
    // so the pacing floor is not what a page costs. See MEASURED_PAGE_CYCLE_MS. Both printed
    // figures come from this one value so the two lines cannot drift apart.
    const pageCycleMs = Math.max(h.rpcMinIntervalMs, MEASURED_PAGE_CYCLE_MS);
    const pageSeconds = (h.maxPagesPerCandidate * pageCycleMs) / 1000;
    L.push('KEYED — Helius Solana RPC. FALLBACK for enumeration, PRIMARY for transaction-level work:');
    L.push(`  POST ${plan.rpcEndpoint.label}/  getTransactionsForAddress (full) + getMultipleAccounts`);
    if (plan.rpcEndpoint.keyDescription !== null) {
      L.push(
        `  credential   present, ${plan.rpcEndpoint.keyDescription.length} characters, ` +
          `UUID-shaped: ${plan.rpcEndpoint.keyDescription.hasDocumentedShape ? 'yes' : 'no'} ` +
          `(value never read, printed or stored)`,
      );
    }
    L.push('');
    L.push('  ONE request per 1,000 transactions, not one per transaction: `status: succeeded` is');
    L.push('  applied server-side and the bodies come back in the same call, so both halves of the');
    L.push('  keyless walk collapse into one. The parsers are unchanged — `full` + `jsonParsed`');
    L.push('  returns getTransaction\'s own envelope, checked field for field on a known create.');
    L.push('');
    L.push('  THIS LEG IS BOUNDED IN CREDITS, NOT REQUESTS. Helius bills 10 credits per 100');
    L.push('  transactions RETURNED, so a busy wallet is expensive in a way a request count cannot');
    L.push('  see. A page is only STARTED when a whole page\'s worst case still fits.');
    L.push('');
    L.push(`  pages per candidate           up to ${h.maxPagesPerCandidate} x ${h.pageLimit} transactions`);
    L.push(`  credits per candidate         ceiling ${h.maxCreditsPerCandidate}  (a full page costs 100)`);
    L.push(
      `  WORST CASE                    ${plan.maxCandidates} x ${h.maxCreditsPerCandidate} = ` +
        `${plan.worstCaseCredits} credits, against a per-run ceiling of ${h.maxCreditsPerRun}`,
    );
    L.push(
      plan.worstCaseCredits <= h.maxCreditsPerRun
        ? '  It fits, so the plan above is the whole exposure — a plan that did not fit would be'
        : '  !! IT DOES NOT FIT — a real run is REFUSED before its first request rather than allowed',
    );
    L.push(
      plan.worstCaseCredits <= h.maxCreditsPerRun
        ? '  refused before the first request rather than dying part-way through.'
        : '  to die half-way through, after the keyed allowance has already been spent.',
    );
    // Both figures, because the brief asks for both and they differ by an order of magnitude. The
    // expected one is the measured per-candidate MEDIAN over the only population where complete
    // histories exist; the worst case is the ceiling. Neither is a guess and the record says which.
    L.push(
      `  EXPECTED                      about ${MEASURED_MEDIAN_CREDITS * plan.maxCandidates} credits ` +
        `at the measured per-candidate median of ${MEASURED_MEDIAN_CREDITS} (12 wallets, complete histories)`,
    );
    L.push(
      `  Monthly allowance ${HELIUS_MONTHLY_CREDITS.toLocaleString('en-US')} on the Developer plan, UNSHARED — this lane's alone. ` +
        `So the`,
    );
    L.push(
      `  worst case above is ${((plan.worstCaseCredits / HELIUS_MONTHLY_CREDITS) * 100).toFixed(2)}% of a month and ` +
        `the expected cost ${(((MEASURED_MEDIAN_CREDITS * plan.maxCandidates) / HELIUS_MONTHLY_CREDITS) * 100).toFixed(2)}%. NOTHING HERE TRACKS THE`,
    );
    L.push('  MONTH: this tool holds no state between runs, so the monthly arithmetic is yours.');
    L.push(
      `  pacing                        ${h.rpcMinIntervalMs}ms, one request in flight ` +
        `(measured: zero shed at every rung, including 0ms)`,
    );
    L.push(
      `  TIME                          up to about ${Math.round(pageSeconds)}s per candidate, so about ` +
        `${Math.round((pageSeconds * plan.maxCandidates) / 60)} min at the candidate cap.`,
    );
    L.push('  That replaces a 13.5-hour leg: the keyless route is up to 100 requests per candidate');
    L.push(
      `  at 2.5s, i.e. 195 x 100 x 2.5s. Unset ${plan.rpcEndpoint.keyEnvVar ?? 'the key'} to fall back to it.`,
    );
    L.push('');
    L.push('KEYLESS — pump.fun creator listing, the ownership reading, for every candidate:');
    L.push('  GET https://frontend-api-v3.pump.fun/coins?creator={wallet}&offset=...');
    L.push(`  up to 4 pages per candidate, so up to ${4 * plan.maxCandidates} for the gate alone.`);
  } else if (plan.historySource === 'creation-derived') {
    const w = plan.creationWalk;
    L.push('KEYLESS — Solana RPC. FALLBACK enumeration when Dune is absent or refuses. EXPENSIVE:');
    L.push('  POST https://api.mainnet-beta.solana.com  getSignaturesForAddress + getTransaction');
    if (plan.rpcEndpoint.rejected !== null) L.push(`  !! ${plan.rpcEndpoint.rejected}`);
    // The variable is NAMED FROM THE ENDPOINT rather than spelled here: this module is not on the
    // credential allow-list, and a second copy of the string is how an allow-list stops meaning
    // anything.
    else L.push(`  ${KEYLESS_HINT} Setting a Helius key takes the indexed route, which is ~17x faster.`);
    L.push(`  up to ${w.maxRpcRequestsPerCandidate} requests per candidate, ` +
      `so up to ${w.maxRpcRequestsPerCandidate * plan.maxCandidates} in total.`);
    L.push(`  At the measured ${w.rpcMinIntervalMs}ms pacing that is up to ` +
      `${Math.round((w.maxRpcRequestsPerCandidate * plan.maxCandidates * w.rpcMinIntervalMs) / 60000)} minutes.`);
    L.push('  Cost per candidate is NOT predictable from the wallet address: it scales with the');
    L.push('  fraction of that wallet\'s signature index that SUCCEEDED, measured between 1.7% and');
    L.push('  99.7% across the twelve wallets of runs/2026-07-29-elite.json. Whichever bound bites');
    L.push('  is recorded per candidate; it is a window, not a whole history, unless it says so.');
    L.push('');
    L.push('KEYLESS — pump.fun creator listing, the ownership reading, for every candidate:');
    L.push('  GET https://frontend-api-v3.pump.fun/coins?creator={wallet}&offset=...');
    L.push(`  up to 4 pages per candidate, so up to ${4 * plan.maxCandidates} for the gate alone.`);
  } else {
    L.push('KEYLESS — Solana RPC: NONE. --ownership-only was passed, so the gate reads the');
    L.push('  ownership listing alone. That reading is BIASED BOTH WAYS AT ONCE: it REJECTS');
    L.push('  through the count bars (20 of 82 clear minTokens+minSpanDays on the vendor page');
    L.push('  against 66 of 82 on the creation-derived reading) and INFLATES through the rate');
    L.push('  (higher than the gate\'s on 37 of 81 wallets, lower on 29, median difference');
    L.push('  0.0000, by up to +0.6929). It is NOT a one-way conservative filter. The record');
    L.push('  will be stamped historySource: "ownership-only".');
  }
  if (plan.consistency) {
    L.push('');
    L.push('KEYLESS — a further creator walk for gate survivors, for long-horizon consistency:');
    L.push(`  up to 3 pages per survivor, so up to ${3 * plan.maxCandidates} if every candidate survives.`);
  } else {
    L.push('KEYLESS — no consistency pass. Pass --consistency to measure it (no quota cost).');
    L.push('');
    L.push('Long-horizon consistency: UNMEASURED. Pass --consistency (no quota cost).');
  }
  // Both frontend-api-v3 passes share ONE client and ONE ceiling, so the plan a reader has to check
  // is their sum. A per-pass figure invites the arithmetic that let the gate quietly overrun a
  // ceiling justified for the consistency walk alone.
  const keylessWorstCase =
    plan.maxCandidates * ((plan.historySource === 'creation-derived' ? 4 : 0) + (plan.consistency ? 3 : 0));
  L.push('');
  L.push(
    `  KEYLESS WORST CASE, frontend-api-v3 (one client, one ceiling): ${keylessWorstCase} request(s) ` +
      `against a ceiling of ${plan.maxKeylessRequests}.`,
  );
  L.push(
    keylessWorstCase <= plan.maxKeylessRequests
      ? '  It fits, so the plan above is the whole exposure. A plan that did not fit would be'
      : '  !! IT DOES NOT FIT — a real run is REFUSED before its first request rather than allowed',
  );
  L.push(
    keylessWorstCase <= plan.maxKeylessRequests
      ? '  refused before the first request, not discovered after the keyed allowance was spent.'
      : '  to die half-way through, after the keyed allowance has already been spent.',
  );
  L.push('');
  L.push('NOT REQUESTED, deliberately:');
  L.push('  /deployer-hunter/{wallet}/tokens   — bonded-only, so it has no denominator at all.');
  L.push('  /deployer-hunter/{wallet}/history  — REACHABLE on this key and still not asked for: it');
  L.push('     returns daily snapshots of bonding_rate / total_deployed / recent_bond_rate, the');
  L.push('     trailing-window aggregates this tool refuses to read at any single instant. It was');
  L.push('     PRO+ and out of reach on the Free tier; the Ultra key answers it 200 (measured');
  L.push('     2026-08-05). The reason it is not requested is now a DESIGN reason, not entitlement.');
  L.push('');
  L.push('='.repeat(78));
  for (const line of LIMITATIONS) L.push(line);
  L.push('='.repeat(78));
  return L.join('\n');
}
