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

import { buildPath, ENDPOINT_ROLES } from './client.mjs';
import { groupUnmeasured } from './record.mjs';
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
  '',
  'WHAT IT DOES NOT MEASURE, and none of these are minor:',
  '  · EXIT. Room to enter is not room to leave. When the dev sells, whether its trigger is a SIZE',
  '    that our own buy would count towards and would therefore cap our position, and whether an',
  '    outsider could have got out first, are ALL UNMEASURED here. No exit signal reaches any entry',
  '    number in this output, deliberately: a blended score cannot be read back apart.',
  '  · FEES. Every P&L above is gross of fees — no priority fee, no landing tip, no venue fee, no',
  '    rent — and is therefore an UPPER BOUND on what any wallet actually took.',
  '  · Lead time, or the independence of the actors involved.',
  '',
  'The standing bar for acting on a signal of this class is real lead time, independence of the',
  'actors, and realised profit reported as a distribution plus a hit rate. Stage 2 clears the last',
  'of those three GROSS OF FEES only, and clears neither of the first two.',
  '',
  'A HIGH COMPLETION RATE DOES NOT IMPLY A PROFITABLE ENTRY, and A PROFITABLE-LOOKING FIELD DOES',
  'NOT IMPLY A PROFITABLE ENTRY EITHER. We hold the counterexample to both. Our own subject',
  'deployer completes 43% of its launches, and gross of fees ~77% of the closed round trips in its',
  'opening window are positive — yet fee-inclusive, the entire outsider population there has made',
  '+0.54 SOL per launch since 2026-06-04 with 51 of 106 wallets losing money, because the',
  'operation\'s own group takes 97% of the profit available. Stage 0 shows the gate PASSING that',
  'wallet and Stage 2 REFUSING it.',
  '',
  'The completion rate is computed over roughly 35 days and about 70 tokens. It is a RECENCY',
  'measure, not a lifetime record, and long-horizon consistency is reported UNMEASURED unless',
  '--consistency was passed.',
];

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
  for (const line of wrap(e.rationale, 84)) L.push(`        ${line}`);
  L.push('');

  L.push(`      ENTRY ROOM — how much of its own opening window the deployer leaves`);
  L.push(distHeader());
  L.push(distLine('room left', e.roomLeft));
  L.push(distLine('operation share', e.operationShare));
  L.push(distLine('dev buy (SOL)', e.devSol));
  L.push(distLine('its own cohort (SOL)', e.coordinatedSol));
  L.push(distLine('competing wallets', e.outsidersPerLaunch, 1));
  L.push(
    `      hit rate: ${e.roomHitRate.hits}/${e.roomHitRate.n} launches leave room ` +
      `(${pct(e.roomHitRate.rate)}); ${e.launchesWithNoOutsider} launch(es) had no competitor at all`,
  );
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

  if (coverage !== null) {
    L.push(
      `      coverage: ${coverage.launchesUsable} usable of ${coverage.launchesAttempted} attempted ` +
        `(${coverage.launchRefsAvailable} available), ${coverage.requestsIssued} keyless request(s)` +
        (coverage.stoppedForBudget ? ', STOPPED EARLY on the stage request ceiling' : ''),
    );
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
 * gap is exactly zero across all 235 covered launches — but this lane has never held a vendor key,
 * so the stranger case is untested and only a visible per-run count can keep it from staying that way.
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
  L.push('  The co-ordination rule — a create-slot transaction carrying 2+ distinct wallets marks');
  L.push('  every wallet in it — recovers the known six-wallet cohort WITHOUT being told who it is.');
  L.push('  That is what makes the method applicable to a stranger.');
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

  L.push('THE KNOWN-NEGATIVE CONTROL — Stage 2 must REFUSE our subject deployer');
  for (const [label, e] of /** @type {[string, import('./entry.mjs').EntryScore][]} */ ([
    ['most recent launches (what a live run would score today)', r.subjectEntryRecent],
    ['the whole post-2026-06-04 regime', r.subjectEntryPostBreak],
  ])) {
    L.push(
      `  ${pad(label, 52)} ${pad(e.verdict.toUpperCase(), 24)} ` +
        `room ${num(e.roomLeft.median, 3)} over ${e.launchesSampled} launches`,
    );
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
  const failed = run.candidates.filter((c) => c.verdict === 'gate-failed');

  L.push('='.repeat(78));
  L.push('STAGE 1 — completion-rate GATE. This tool gates; it does not recommend.');
  L.push('='.repeat(78));
  L.push('');
  L.push(`run started        ${run.startedAtIso}`);
  L.push(`keyed requests     ${run.keyedRequests}  (MadeOnSol, Free tier)`);
  L.push(
    `keyless requests   ${run.keylessRequests}  (pump.fun)` +
      (run.keylessShed === undefined ? '' : `, ${run.keylessShed} shed and retried`),
  );
  L.push(`elapsed            ${(run.elapsedMs / 1000).toFixed(1)}s`);
  L.push(`prefiltered out    ${run.prefiltered}  (skipped before spending a request)`);
  L.push(`candidates gated   ${run.candidates.length}`);
  L.push(`gate passed        ${passed.length}`);
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
    for (const [why, n] of groupUnmeasured(unmeasured)) L.push(`   · ${n} candidate(s): ${why}`);
    L.push('   A ceiling hit, an exhausted budget or a failed walk is NEVER a measured result. The');
    L.push('   affected candidates read UNMEASURED below and the record is flagged truncated. Do');
    L.push('   not read their absence of a finding as a finding.');
  }
  L.push('');

  if (passed.length === 0) {
    if (run.completed) {
      L.push('NO CANDIDATE CLEARED THE GATE.');
      L.push('');
      L.push('This is a real measured outcome, not an error — the run completed and every candidate');
      L.push('was evaluated. If the run had failed instead, it would have exited non-zero and said so');
      L.push('above. The per-candidate reasons are listed below.');
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
    L.push('  n    = tokens in the denominator we computed ourselves');
    L.push('  done = of those, how many completed the bonding curve');
    L.push('  cap  = the vendor page was full, so older launches exist that it does not show');
    L.push('  seeds= how many of the 3 enumeration queries surfaced this wallet');
    L.push('');
    L.push('  ENTRY-ROOM-PRESENT IS NOT "BEATABLE". It means the opening window is not already');
    L.push('  closed, so the EXIT question is worth asking. Exit is unmeasured here, and every');
    L.push('  realised figure above is gross of fees and therefore an upper bound.');
  }

  if (failed.length > 0) {
    L.push('');
    L.push('DID NOT CLEAR THE GATE');
    for (const c of failed) {
      L.push(`  ${c.wallet}`);
      for (const reason of c.gate.reasons) L.push(`      · ${reason}`);
    }
  }

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
 * @param {{ length: number, hasDocumentedPrefix: boolean } | null} plan.keyDescription
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
    L.push('                                (measured: p50 4 pages, p90 8, p95 13; ~25% shed rate)');
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
        `(~6 requests/launch at the measured p50), about ${minutes(worstCase)} min worst case`,
    );
    L.push(
      worstCase <= t.maxKeylessRequests
        ? '  The worst case is at or under the ceiling, so the plan above is the WHOLE exposure.'
        : '  !! The worst case EXCEEDS the ceiling — the ceiling binds and the run will stop early.',
    );
    L.push('  A launch is only started when a full page-cap of headroom remains, so no launch is');
    L.push(`  ever abandoned half-walked. Window measured: ${t.windowSlotSpan} SLOTS from the create`);
    L.push(`  slot — the chain's own ordering, not the vendor's clock. The seek starts ${t.seekMarginMs / 1000}s past`);
    L.push(`  the nominal ${t.windowMs / 1000}s end so an early vendor mint time cannot truncate the tail; that`);
    L.push('  margin is a cursor hint and never a tolerance on the pre-mint drop. Pinned keyless');
    L.push('  pacing, one request in flight.');
  } else {
    L.push('KEYLESS — STAGE 2 DISABLED (--no-stage2). No entry measurement would be taken, so the');
    L.push('  run would report competence only and nothing about whether a window is enterable.');
  }
  L.push('');

  if (plan.consistency) {
    L.push('KEYLESS — pump.fun creator listing, for gate survivors only:');
    L.push('  GET https://frontend-api-v3.pump.fun/coins?creator={wallet}&offset=...');
    L.push(`  up to 3 pages per survivor, ceiling ${plan.maxKeylessRequests}. Costs no quota.`);
  } else {
    L.push('KEYLESS — no consistency pass. Pass --consistency to measure it (no quota cost).');
  }
  L.push('');
  L.push('NOT REQUESTED, deliberately:');
  L.push('  /deployer-hunter/{wallet}/tokens   — bonded-only, so it has no denominator at all.');
  L.push('  /deployer-hunter/{wallet}/history  — PRO+. This tool is Free tier only.');
  L.push('');
  L.push('='.repeat(78));
  for (const line of LIMITATIONS) L.push(line);
  L.push('='.repeat(78));
  return L.join('\n');
}
