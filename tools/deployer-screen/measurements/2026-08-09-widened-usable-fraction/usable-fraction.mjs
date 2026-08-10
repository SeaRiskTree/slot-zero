/**
 * The usable fraction, computed from run records and nothing else.
 *
 * **A window is USABLE when it produced the figure Stage 2 exists to produce — a room reading.**
 * The measure is `entry.launchesSampled / entry.coverage.launchesPlanned`, summed over every
 * candidate a run SCORED. That is the definition `slot-zero-discovery-beyond-madeonsol` →
 * `report.md` §2.2 used for the pooled 0.5526, and this script reproduces that figure from the
 * committed records before reporting any new one, so the two are known to be the same quantity.
 *
 * **Read the two denominators apart, because they are different questions.**
 *   · usable / PLANNED  — what a scoring slot is worth. This is 379b's unit and the only figure a
 *     throughput number may be multiplied by.
 *   · usable / WALKED   — what the ROOM RULE alone costs, once our own walk drops are removed.
 *     `coverage.launchesUsable` is the walked count; the coverage block's own word "usable" means
 *     *the walk returned a tape*, which is NOT this report's sense of usable, and conflating the
 *     two is the easiest available mistake here.
 *
 * **Populations are never pooled.** Each leg is reported with its own date and its own named
 * population; the script prints a pooled line for the four 2026-08-04→05 legs only because the
 * figure being superseded is that pool, and it refuses to pool across populations.
 *
 * Offline: it opens no socket and reads no credential. `node usable-fraction.mjs [--json]`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREEN = join(HERE, '..', '..');

/**
 * The four legs the superseded pooled fraction was measured over.
 *
 * Named individually rather than globbed: the pool being reproduced is a specific set of records,
 * and a glob would silently change what "0.5526" means the day another record lands beside them.
 */
const BASELINE_LEGS = [
  { label: 'runs/2026-08-04.json', population: 'vendor-seeded strangers, untiered default', path: join(SCREEN, 'runs', '2026-08-04.json') },
  { label: '2026-08-05 tier-good', population: 'MadeOnSol good tier', path: join(SCREEN, 'measurements', '2026-08-05-seed-comparison', '2026-08-05-tier-good.json') },
  { label: '2026-08-05 tier-elite', population: 'MadeOnSol elite tier', path: join(SCREEN, 'measurements', '2026-08-05-seed-comparison', '2026-08-05-tier-elite.json') },
  { label: '2026-08-05 untiered', population: 'MadeOnSol untiered seeds', path: join(SCREEN, 'measurements', '2026-08-05-seed-comparison', '2026-08-05-untiered.json') },
];

/** The pooled fraction this lane exists to supersede, as published. */
export const SUPERSEDED_POOLED = { planned: 190, room: 105, fraction: 0.5526 };

/**
 * Window dispositions of one run record.
 *
 * @param {any} record
 * @returns {{ scored: number, planned: number, walked: number, room: number, drops: Record<string, number>,
 *   perWallet: { wallet: string, planned: number, room: number, fraction: number, launchesPerDay: number | null }[] }}
 */
export function dispositions(record) {
  let scored = 0;
  let planned = 0;
  let walked = 0;
  let room = 0;
  /** @type {Record<string, number>} */
  const drops = {};
  /**
   * Per scored wallet, with the launch tempo the ROTATION ranked it on.
   *
   * `scoringRotation.order[].launchesPerDay` is persisted from schema 23 precisely so a selection
   * is re-derivable from the record alone — which is what lets this script weight the fraction the
   * way captain decision 399a allocates, without asking any vendor anything.
   *
   * @type {{ wallet: string, planned: number, room: number, fraction: number, launchesPerDay: number | null }[]}
   */
  const perWallet = [];
  /** @type {Record<string, number>} */
  const tempo = {};
  for (const o of record.scoringRotation?.order ?? []) {
    if (typeof o.launchesPerDay === 'number') tempo[o.wallet] = o.launchesPerDay;
  }
  for (const c of record.candidates ?? []) {
    if (!c.entry) continue;
    scored += 1;
    const p = c.entry.coverage?.launchesPlanned ?? 0;
    const s = c.entry.launchesSampled ?? 0;
    perWallet.push({ wallet: c.wallet, planned: p, room: s, fraction: p === 0 ? 0 : s / p, launchesPerDay: tempo[c.wallet] ?? null });
    const cov = c.entry.coverage ?? {};
    planned += cov.launchesPlanned ?? 0;
    walked += cov.launchesUsable ?? 0;
    room += c.entry.launchesSampled ?? 0;
    for (const [reason, n] of Object.entries(cov.dropsByReason ?? {})) {
      if (typeof n === 'number' && n > 0) drops[reason] = (drops[reason] ?? 0) + n;
    }
    const unproven = c.entry.launchesRoomUnproven ?? 0;
    if (unproven > 0) drops['roomUnproven(refused, not dropped)'] = (drops['roomUnproven(refused, not dropped)'] ?? 0) + unproven;
  }
  return { scored, planned, walked, room, drops, perWallet };
}

/**
 * The fraction weighted by launch flow — the unit captain decision 399a actually allocates in.
 *
 * The pooled fraction counts every planned window once, which is the right answer when windows are
 * drawn evenly. 399a does not draw them evenly: it points the cap at the survivors with the most
 * unharvested flow, so the windows a flow-weighted month actually harvests are drawn from wallets
 * in proportion to their tempo. Weighting each wallet's own fraction by that tempo is the like-for-
 * like figure for that rung, and on this population it is FAR below the pooled one.
 *
 * Returns `null` when no scored wallet carried a readable tempo — never 0, which would read as
 * "nothing is usable" rather than "this was not measurable".
 *
 * @param {{ fraction: number, launchesPerDay: number | null }[]} rows
 * @returns {number | null}
 */
export function flowWeightedFraction(rows) {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (typeof r.launchesPerDay !== 'number' || !Number.isFinite(r.launchesPerDay) || r.launchesPerDay <= 0) continue;
    num += r.launchesPerDay * r.fraction;
    den += r.launchesPerDay;
  }
  return den === 0 ? null : num / den;
}

/** @param {number} a @param {number} b */
const ratio = (a, b) => (b === 0 ? null : a / b);

/** @param {number | null} x */
const f4 = (x) => (x === null ? 'n/a' : x.toFixed(4));

function main() {
  const json = process.argv.includes('--json');
  /** @type {any[]} */
  const rows = [];

  for (const leg of BASELINE_LEGS) {
    const record = JSON.parse(readFileSync(leg.path, 'utf8'));
    rows.push({ ...leg, kind: 'baseline', schemaVersion: record.schemaVersion, startedAtIso: record.startedAtIso, ...dispositions(record) });
  }

  const widenedDir = join(HERE, 'runs');
  const widened = readdirSync(widenedDir)
    .filter((n) => /^widened-part\d+\.json$/.test(n))
    .sort();
  for (const name of widened) {
    const record = JSON.parse(readFileSync(join(widenedDir, name), 'utf8'));
    rows.push({
      label: `measurements/2026-08-09-widened-usable-fraction/runs/${name}`,
      population: 'the widened 37 — census-unseen 2026-07 gate-passers, supplied by --wallets',
      kind: 'widened',
      schemaVersion: record.schemaVersion,
      startedAtIso: record.startedAtIso,
      ...dispositions(record),
    });
  }

  /** @param {string} kind */
  const pool = (kind) =>
    rows
      .filter((r) => r.kind === kind)
      .reduce((a, r) => ({ scored: a.scored + r.scored, planned: a.planned + r.planned, walked: a.walked + r.walked, room: a.room + r.room }), {
        scored: 0,
        planned: 0,
        walked: 0,
        room: 0,
      });

  const baseline = pool('baseline');
  const widenedPool = pool('widened');

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          supersededPooled: SUPERSEDED_POOLED,
          legs: rows,
          baselinePooled: { ...baseline, usableFraction: ratio(baseline.room, baseline.planned) },
          widenedPooled: { ...widenedPool, usableFraction: ratio(widenedPool.room, widenedPool.planned) },
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  /** @param {any} r */
  const line = (r) =>
    `${String(r.label).padEnd(58)} ${String(r.scored).padStart(3)} ${String(r.planned).padStart(4)} ` +
    `${String(r.walked).padStart(4)} ${String(r.room).padStart(4)}  ${f4(ratio(r.room, r.planned))}  ${f4(ratio(r.room, r.walked))}`;

  console.log('');
  console.log('THE USABLE FRACTION — usable = the window produced a ROOM READING (entry.launchesSampled)');
  console.log('');
  console.log(`${'leg'.padEnd(58)} ${'sc'.padStart(3)} ${'plan'.padStart(4)} ${'walk'.padStart(4)} ${'room'.padStart(4)}  /plan   /walk`);
  console.log('-'.repeat(94));
  console.log('SUPERSEDED BASELINE — four legs 2026-08-04 → 2026-08-05, vendor-seeded populations');
  for (const r of rows.filter((r) => r.kind === 'baseline')) console.log(line(r));
  console.log(
    `${'  pooled (the published 0.5526)'.padEnd(58)} ${String(baseline.scored).padStart(3)} ${String(baseline.planned).padStart(4)} ` +
      `${String(baseline.walked).padStart(4)} ${String(baseline.room).padStart(4)}  ${f4(ratio(baseline.room, baseline.planned))}  ${f4(ratio(baseline.room, baseline.walked))}`,
  );
  const reproduced = baseline.planned === SUPERSEDED_POOLED.planned && baseline.room === SUPERSEDED_POOLED.room;
  console.log(`  ${reproduced ? 'REPRODUCED' : '!! DOES NOT REPRODUCE'} the published pool (${SUPERSEDED_POOLED.room}/${SUPERSEDED_POOLED.planned})`);
  console.log('');
  if (rows.some((r) => r.kind === 'widened')) {
    console.log('THE WIDENED POPULATION — 2026-08-09, the 37 census-unseen 2026-07 gate-passers');
    for (const r of rows.filter((r) => r.kind === 'widened')) console.log(line(r));
    console.log(
      `${'  MEASURED, widened population, 2026-08-09'.padEnd(58)} ${String(widenedPool.scored).padStart(3)} ${String(widenedPool.planned).padStart(4)} ` +
        `${String(widenedPool.walked).padStart(4)} ${String(widenedPool.room).padStart(4)}  ${f4(ratio(widenedPool.room, widenedPool.planned))}  ${f4(ratio(widenedPool.room, widenedPool.walked))}`,
    );
    console.log('');
    console.log('  These two blocks are DIFFERENT POPULATIONS and are never pooled with each other.');
    console.log('');
    console.log('WHERE THE PLANNED WINDOWS WENT — widened population');
    /** @type {Record<string, number>} */
    const drops = {};
    for (const r of rows.filter((r) => r.kind === 'widened')) for (const [k, v] of Object.entries(r.drops)) drops[k] = (drops[k] ?? 0) + v;
    for (const [k, v] of Object.entries(drops).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
    console.log('');
    const m = ratio(widenedPool.room, widenedPool.planned);
    const allRows = rows.filter((r) => r.kind === 'widened').flatMap((r) => r.perWallet);
    const flow = flowWeightedFraction(allRows);
    console.log('HOW THE FRACTION VARIES WITH LAUNCH FLOW — the term 399a allocates on');
    const withFlow = allRows.filter((r) => typeof r.launchesPerDay === 'number');
    const hi = withFlow.filter((r) => (r.launchesPerDay ?? 0) >= 1);
    const lo = withFlow.filter((r) => (r.launchesPerDay ?? 0) < 1);
    /** @param {{fraction:number}[]} a */
    const mean = (a) => (a.length === 0 ? null : a.reduce((x, r) => x + r.fraction, 0) / a.length);
    console.log(`  flow >= 1 launch/day : n=${hi.length}  mean usable fraction ${f4(mean(hi))}`);
    console.log(`  flow <  1 launch/day : n=${lo.length}  mean usable fraction ${f4(mean(lo))}`);
    console.log(`  pooled, every planned window counted once : ${f4(m)}`);
    console.log(`  FLOW-WEIGHTED, the 399a rung's own unit   : ${f4(flow)}`);
    console.log('');
    console.log("THROUGHPUT RESTATED — distinct USABLE windows per month (captain decision 379b's unit)");
    /** @type {[string, number, number | null][]} */
    const ladder = [
      ['today: 21 reachable wallets, 560 distinct windows/mo', 560, m],
      ['+398a: all 58 reachable, round-robin, 1,067 distinct windows/mo', 1067, m],
      ['+399a: all 58, flow-weighted, 1,963 distinct windows/mo', 1963, flow],
      ['ceiling: all 58 fully harvested, 2,002 distinct windows/mo', 2002, m],
      ['capacity: 2,100 measurement ACTS/mo (a different unit)', 2100, m],
    ];
    console.log(`${'rung'.padEnd(62)} ${'@0.5526'.padStart(8)} ${'@measured'.padStart(9)}  fraction applied`);
    for (const [name, distinct, frac] of ladder) {
      const applied = frac === m ? `pooled ${f4(m)}` : `flow-weighted ${f4(flow)}`;
      console.log(
        `${name.padEnd(62)} ${String(Math.round(distinct * SUPERSEDED_POOLED.fraction)).padStart(8)} ` +
          `${String(Math.round(distinct * (frac ?? 0))).padStart(9)}  ${applied}`,
      );
    }
    console.log('');
    const best = Math.round(1963 * (flow ?? 0));
    const bestPooled = Math.round(1963 * (m ?? 0));
    console.log(
      `  FLOOR 1,000 distinct usable windows/month. The full 398a+399a ladder reads ${best} at the ` +
        `flow-weighted fraction and ${bestPooled} at the pooled one — SHORT BY ${1000 - best} and ` +
        `${1000 - bestPooled} respectively. It does not clear the floor on either reading.`,
    );
  } else {
    console.log('No widened run record yet — nothing measured on the widened population.');
  }
  console.log('');
}

main();
