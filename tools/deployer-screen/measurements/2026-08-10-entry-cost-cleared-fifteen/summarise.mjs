/**
 * Roll `result.json` up into the figures the report states, and nothing else.
 *
 * Offline: it reads `result.json` and `thresholds.json` and opens no socket.
 * `node summarise.mjs [--json]`.
 *
 * **Why the interval and not the bare count.** The census reports its own counts with exact
 * (Clopper–Pearson) 95% intervals because a first-ever positive on a small n is exactly where a bare
 * integer misleads, and the Stage 3 count this lane produces has a far smaller n than the room count
 * it comes from. The two denominators are kept apart and never pooled: `k / attempted` is the share
 * of the 15 that reach Stage 3, and `k / decided` is the share of those whose cost the lane could
 * actually measure. A candidate the lane could not price is in the first denominator and not the
 * second, which is the whole difference between "did not clear" and "was not measured".
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDeployerAttributable } from '../../entry.mjs';
import { clopperPearson, incompleteBeta } from '../../stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREEN = join(HERE, '..', '..');

/**
 * The exact-interval machinery this record's figures were published under, RE-EXPORTED rather than
 * held here.
 *
 * It lived in this file until the realization correction needed the same interval in a production
 * score. Two implementations of a confidence interval is worse than none — both look authoritative
 * and only one can be the one a committed record was computed with — so the code moved to
 * `tools/deployer-screen/stats.mjs`, which imports nothing, and this line keeps every existing
 * importer (this module's own `summarise`, and `test/entry-cost-cleared-fifteen.test.ts`) reading
 * the same bytes it always read. The published figures are unchanged: the moved code is verbatim.
 */
export { clopperPearson, incompleteBeta };

/**
 * How many candidates the pinned population holds, from the population file itself.
 *
 * The denominator a partial roll-up must be read against; see {@link summarise}.
 *
 * @returns {number}
 */
function readCensusCandidates() {
  /** @type {any} */
  const input = JSON.parse(readFileSync(join(HERE, 'census-input.json'), 'utf8'));
  if (!Array.isArray(input?.candidates)) {
    throw new Error('census-input.json carries no candidates array; the pinned population is unreadable.');
  }
  return input.candidates.length;
}

/**
 * The pinned cost gate, from its one owner.
 *
 * Read at run time rather than copied, so a bar cannot be moved from this directory and a roll-up
 * cannot report against a stale one.
 *
 * @returns {number}
 */
function readCostBar() {
  /** @type {any} */
  const thresholds = JSON.parse(readFileSync(join(SCREEN, 'thresholds.json'), 'utf8'));
  const bar = thresholds?.stage2_entry?.maxEntryCostPerSolStaked;
  if (typeof bar !== 'number' || !Number.isFinite(bar)) {
    throw new Error('thresholds.json carries no numeric stage2_entry.maxEntryCostPerSolStaked.');
  }
  return bar;
}

/**
 * Roll one `result.json` up.
 *
 * **Neither bar it reads is written here.** `minPricedFraction` comes off the record — the run states
 * what it applied, and a record that does not carry it is REFUSED rather than defaulted, since a
 * silent default reports against a bar no run ever used. `maxEntryCostPerSolStaked` comes off
 * `thresholds.json`, the one owner, exactly as `price-entry.mjs` reads its pins at run time.
 *
 * **The MEASURED denominator is production's predicate, not a list.** `entry.mjs` →
 * `isDeployerAttributable` decides which verdicts are an answer ABOUT THE DEPLOYER (captain decision
 * 174b); a local copy of the four measured verdicts agreed with it today and would drift silently the
 * moment the ladder gained one, which is the whole reason the predicate exists.
 *
 * **It also states whether it rolled up the WHOLE census population.** A `--only` run produces a
 * one-candidate record, and every count and interval below is over `result.candidates` — so a
 * partial artifact summarised silently would publish `attempted 1` in the same shape as the
 * published `attempted 15`. `censusCandidates` and `coversWholeCensus` travel on the roll-up, and
 * the printed form says so in a banner rather than a field.
 *
 * @param {any} result The parsed `result.json`.
 * @param {object} [pins]
 * @param {number} [pins.maxEntryCostPerSolStaked] `thresholds.json` → `stage2_entry`; read from disk
 *   when omitted.
 * @param {number} [pins.censusCandidates] How many candidates the pinned population holds; read from
 *   `census-input.json` when omitted.
 * @returns {any}
 */
export function summarise(result, pins = {}) {
  const rows = result.candidates ?? [];
  /** @type {Record<string, number>} */
  const byVerdict = {};
  /** @type {Record<string, number>} */
  const byCause = {};
  let costLegRan = 0;
  let costPricedLaunches = 0;
  let costTargeted = 0;
  let costPriced = 0;

  for (const r of rows) {
    const v = r.measuredToday.verdict;
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
    const cause = r.measuredToday.laneUnmeasuredCause ?? r.measuredToday.unmeasuredCause;
    if (cause !== null && cause !== undefined) byCause[cause] = (byCause[cause] ?? 0) + 1;
    if (r.coverage.cost.ran) costLegRan += 1;
    costPricedLaunches += r.coverage.cost.launchesPriced;
    costTargeted += r.coverage.cost.transactionsTargeted;
    costPriced += r.coverage.cost.transactionsPriced;
  }

  const attempted = rows.length;
  const decided = rows.filter((/** @type {any} */ r) =>
    isDeployerAttributable({
      verdict: r.measuredToday.verdict,
      unmeasuredCause: r.measuredToday.unmeasuredCause ?? null,
    }),
  ).length;
  const stage3 = rows.filter((/** @type {any} */ r) => r.measuredToday.verdict === 'entry-open-after-costs').length;
  // A cost READING, which is a different and weaker thing from a Stage 3 pass: it says the seat's
  // price was measured on this candidate, whatever the ladder went on to say about the field.
  //
  // **IT IS GATED ON `minPricedFraction`, AND THAT IS NOT A DETAIL.** A candidate whose cost leg
  // priced 1 of 53 entries carries a `median` — the median of one number — and reading it as this
  // deployer's entry cost is exactly the "we did not look" reading as "it was free" that
  // `entryCostPriced` exists to prevent. Production refuses those at the same bar
  // (`entry.mjs` → `entry-cost-unmeasured`), so this counts what production would let decide.
  const minPriced = result.thresholdsMinPricedFraction;
  if (typeof minPriced !== 'number' || !Number.isFinite(minPriced)) {
    throw new Error(
      'result.json carries no thresholdsMinPricedFraction. Refusing: a default would report the cost ' +
        'readings against a bar the run may never have applied.',
    );
  }
  const costBar = pins.maxEntryCostPerSolStaked ?? readCostBar();
  const costRead = rows.filter(
    (/** @type {any} */ r) =>
      Number.isFinite(r.measuredToday.entryCostPerSolStakedByLaunch?.median) &&
      r.measuredToday.entryCostPerSolStakedByLaunch.n > 0 &&
      r.measuredToday.entryCostPriced.rate >= minPriced,
  );
  // Cost readings that exist but are too thin for production to gate on. Reported apart rather than
  // pooled: they are OUR coverage, and pooling them would let a one-entry median vote.
  const costReadBelowPricedBar = rows.filter(
    (/** @type {any} */ r) =>
      Number.isFinite(r.measuredToday.entryCostPerSolStakedByLaunch?.median) &&
      r.measuredToday.entryCostPerSolStakedByLaunch.n > 0 &&
      r.measuredToday.entryCostPriced.rate < minPriced,
  ).length;
  const clearsCostGate = costRead.filter(
    (/** @type {any} */ r) => r.measuredToday.entryCostPerSolStakedByLaunch.median < costBar,
  ).length;

  const censusCandidates = pins.censusCandidates ?? readCensusCandidates();

  return {
    thresholdsMinPricedFraction: minPriced,
    maxEntryCostPerSolStaked: costBar,
    censusCandidates,
    coversWholeCensus: attempted === censusCandidates,
    attempted,
    decided,
    stage3,
    byVerdict,
    byCause,
    costLegRan,
    costPricedLaunches,
    costTargeted,
    costPriced,
    costReadOn: costRead.length,
    costReadBelowPricedBar,
    clearsCostGate,
    intervals: {
      stage3OfAttempted: clopperPearson(stage3, attempted),
      stage3OfDecided: clopperPearson(stage3, decided),
      costGateOfCostRead: clopperPearson(clearsCostGate, costRead.length),
    },
    spend: result.spend,
  };
}

function main() {
  const result = JSON.parse(readFileSync(join(HERE, 'result.json'), 'utf8'));
  const s = summarise(result);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  if (!s.coversWholeCensus) {
    console.log(
      `PARTIAL — this record holds ${s.attempted} of the census's ${s.censusCandidates} candidates. ` +
        'Every count and interval below is over what it holds and is NOT the published population.',
    );
  }
  console.log(`attempted ${s.attempted}, measured verdict on ${s.decided}, Stage 3 ${s.stage3}`);
  console.log('verdicts:', JSON.stringify(s.byVerdict));
  console.log('unmeasured causes:', JSON.stringify(s.byCause));
  console.log(
    `cost leg ran on ${s.costLegRan}; ${s.costPriced}/${s.costTargeted} transaction(s) priced across ` +
      `${s.costPricedLaunches} launch(es); cost read on ${s.costReadOn}, of which ${s.clearsCostGate} ` +
      `below the ${s.maxEntryCostPerSolStaked} bar`,
  );
  for (const [name, ci] of Object.entries(s.intervals)) {
    if (ci === null) continue;
    console.log(`${name}: ${ci.k}/${ci.n} = ${ci.rate.toFixed(4)}  95% [${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]`);
  }
  console.log('spend:', JSON.stringify(s.spend));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
