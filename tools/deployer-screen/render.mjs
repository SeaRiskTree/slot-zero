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

import { buildPath } from './client.mjs';

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
  'WHAT IT MEASURES: whether a deployer completes bonding curves — competence. One number,',
  'computed by us from per-token records, over a window of about 35 days.',
  '',
  'WHAT IT DOES NOT MEASURE, and none of these are minor:',
  '  · Whether the deployer leaves an outsider any room in the opening window. NOT BUILT (Stage 2).',
  '  · Whether it sets an exit trap — dumping its position once outsider money reaches some size,',
  '    which would cap our position size regardless of how good the entry looks. NOT BUILT.',
  '  · Realised profit, as a distribution and a hit rate. NOT MEASURED.',
  '  · Lead time, or the independence of the actors involved.',
  '',
  'The standing bar for acting on a signal of this class is real lead time, independence of the',
  'actors, and realised profit reported as a distribution plus a hit rate. This tool clears none',
  'of those. Passing the gate means "worth spending costlier research on", and nothing more.',
  '',
  'A HIGH COMPLETION RATE DOES NOT IMPLY A PROFITABLE ENTRY. We have measured the counterexample:',
  'our own subject deployer completes 43% of its launches and its opening window has been',
  'unprofitable for outsiders since 2026-06-04, because the operation\'s own group takes 97% of the',
  'profit available there. Stage 0 shows this gate PASSING that wallet.',
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

  L.push('STAGE 2 SEAM — the create-slot primitive, reproduced against the published §5.1 split');
  L.push('  (not wired into any verdict here; validated so the next lane inherits a proven tool)');
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
 * @param {number} run.elapsedMs
 * @param {string} run.startedAtIso
 * @param {boolean} run.completed Whether enumeration and gating ran to the end. **Load-bearing.**
 *   Two very different things used to share one `truncated` flag: a run that finished but whose
 *   candidate cap dropped seeded wallets, and a run that died at a request. Only the first may say
 *   every candidate was evaluated, so the renderer is told which happened rather than guessing.
 * @param {boolean} run.truncated Either kind of incompleteness.
 * @param {string | null} run.truncationReason
 * @param {number} run.prefiltered
 * @param {import('./seed.mjs').SeedCoverage} run.coverage
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
  L.push(`keyless requests   ${run.keylessRequests}  (pump.fun)`);
  L.push(`elapsed            ${(run.elapsedMs / 1000).toFixed(1)}s`);
  L.push(`prefiltered out    ${run.prefiltered}  (skipped before spending a request)`);
  L.push(`candidates gated   ${run.candidates.length}`);
  L.push(`gate passed        ${passed.length}`);
  L.push(`gate failed        ${failed.length}`);
  L.push('');

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
    L.push('CLEARED THE GATE — eligible for Stage 2 scoring, which is NOT BUILT');
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
  L.push('  The ceiling is enforced before each request; the run stops and says so rather than');
  L.push('  continuing past it.');
  L.push('');

  if (plan.consistency) {
    L.push('KEYLESS — pump.fun creator listing, for gate survivors only:');
    L.push('  GET https://frontend-api-v3.pump.fun/coins?creator={wallet}&offset=...');
    L.push(`  up to 3 pages per survivor, ceiling ${plan.maxKeylessRequests}. Costs no quota.`);
  } else {
    L.push('KEYLESS — none. Pass --consistency to measure long-horizon consistency (no quota cost).');
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
