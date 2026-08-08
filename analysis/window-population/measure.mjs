/**
 * How many profitable windows the population tape contains, how long they lasted, how fast
 * they closed, and how many ran at once.
 *
 * **Offline by construction.** This directory reads the population tape and nothing else: no
 * network, no credential, no clock. `test/window-population.test.ts` asserts that structurally, the
 * same way `test/loader.test.ts` asserts it for `src/`. Which directory the tape is IN is
 * `config/data-root.mjs`'s answer — see {@link DATA_DIR}.
 *
 * The findings and the definitions they rest on are in `README.md` beside this file. This
 * module is the arithmetic; run it with `node analysis/window-population/measure.mjs`.
 *
 * It parses the CSVs itself rather than importing `src/`, because `src/` is TypeScript and
 * this directory is plain `.mjs` that must run on the Node 20 floor with no build step —
 * the same trade `tools/` makes. The parser is deliberately dumb; the loader in `src/` is the
 * authority on column semantics and on the three traps.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { POPULATION_TAPE, POPULATION_TAPE_DIR, requireDataset } from '../../config/data-root.mjs';

/**
 * @type {string} Absolute path of the dataset directory.
 *
 * **Where the data lives is `config/data-root.mjs`'s to answer**, not this module's: the tapes are
 * not in this tree, and the root defaults to the store at `~/slot-zero-data` and moves with
 * `SLOT_ZERO_DATA_ROOT`. `analysis/` may not read an
 * environment variable itself (`test/window-population.test.ts`, the same guard `src/` is held to),
 * so the one owner lives in its own area and this is the import of it. **No trailing separator** —
 * it used to have one and paths were built by concatenation; they are built with `join()` now.
 */
export const DATA_DIR = POPULATION_TAPE_DIR;

/** The deployer under study. Same constant as `src/cohort.ts`; see the note above on imports. */
export const DEPLOYER = '7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL';

/** The six create-slot cohort wallets — part of the operation, not competitors for it. */
export const COHORT = new Set([
  '2CHrnc2LyagAbMaMFgthiDWh7ZZ9zT9TF8WEJf7MNE71',
  'Atgx1JXsp8pTQ9Qsi74wF5pLMVwHwyQc6jJCu84evN7c',
  '8kzFH4rgFzy4ccz97AhgqRT7Qbt7HnD5oJCDK1Sxdarb',
  'GfJA84gwT9LpeyzeckeXkCsf8vdQuA64ZYQ91xoBawvt',
  '5P8A9bGUhroskpuA4hhRbybgt37TcTz7ft5zLAh8orpn',
  '43x1zWzjVWJbQErWM78m3Acx83FFuGSQEhmgyxUrPdQs',
]);

/**
 * The `9BhkaAyb…` book's five known wallets, collapsed to **one trading unit**.
 *
 * Counting them separately would list one trader up to five times and would make the
 * concurrency answer look better than it is. `src/cohort.ts` owns this fact and the reason it
 * is a type there rather than a comment.
 */
export const BOOK_UNIT = 'unit:9BhkaAyb-book';
export const BOOK = new Set([
  'EgQX9R3Qph1dPHE1Ysou1auSYqRGomCNmLDC28Yg77aq',
  '2CQgjcdNEo7WtbQLpJTAVcC3Ga61pNvRDTgP5grzctFG',
  'HugksxcSGZnhfTuLuwnP38E94FX3HjWZfiNjiXSdx6Yh',
  'Gpb9EZXGBEvURHUJu5sLVUPerduzwafyEu7VjhhdPRS1',
  'BVGAeaRhQp8GxpfDraCSjPtF4GfgAeNYKgMyMkP8GLr8',
]);

/** The trading unit a wallet belongs to. */
export const unitOf = (/** @type {string} */ wallet) => (BOOK.has(wallet) ? BOOK_UNIT : wallet);

// ---------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------

/**
 * Minimal RFC-4180 reader. The tape's `name` column contains commas and quotes, so splitting
 * on `,` silently shifts every later column — it produced a launch dated `" i play to win"`
 * on the first pass of this measurement.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */ const rows = [];
  /** @type {string[]} */ let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c ?? '';
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** @type {Map<string, Array<Record<string, string>>>} Parsed once per file per process. */
const csvCache = new Map();

/**
 * The dataset is a primary record, so a row that does not match its header is an error and not
 * something to skip: a quoting regression would otherwise delete evidence in silence. The one
 * tolerated deviation is a single empty trailing row.
 *
 * @param {string} name File name inside {@link DATA_DIR}.
 * @returns {Array<Record<string, string>>}
 */
export function readCsv(name) {
  const cached = csvCache.get(name);
  if (cached !== undefined) return cached;
  // The first read of the run, and therefore where a missing dataset is reported as a missing
  // dataset rather than as an ENOENT on a CSV nobody has heard of.
  const rows = parseCsv(readFileSync(join(requireDataset(POPULATION_TAPE, DATA_DIR), name), 'utf8'));
  const head = rows[0];
  if (head === undefined) throw new Error(`${name}: empty`);
  /** @type {Array<Record<string, string>>} */ const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (cells.length !== head.length) {
      const emptyTrailing = r === rows.length - 1 && cells.every((c) => c === '');
      if (emptyTrailing) continue;
      throw new Error(
        `${name}: line ${r + 1} has ${cells.length} fields, header has ${head.length}`,
      );
    }
    /** @type {Record<string, string>} */ const o = {};
    for (let i = 0; i < head.length; i++) o[head[i] ?? ''] = cells[i] ?? '';
    out.push(o);
  }
  csvCache.set(name, out);
  return out;
}

/** @param {string | undefined} v @returns {number | null} */
export const num = (v) => (v === undefined || v === '' ? null : Number(v));

// ---------------------------------------------------------------------------------
// distribution helpers
// ---------------------------------------------------------------------------------

/**
 * Linear-interpolation percentile — the convention the dataset publishes against
 * (`src/units.ts` records why).
 *
 * @param {readonly number[]} sorted Ascending.
 * @param {number} p 0…1
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  const a = sorted[lo], b = sorted[hi];
  if (a === undefined || b === undefined) return NaN;
  return lo === hi ? a : a + (b - a) * (idx - lo);
}

/** @param {readonly number[]} xs */
export const asc = (xs) => [...xs].sort((a, b) => a - b);
/** @param {readonly number[]} xs */
export const median = (xs) => percentile(asc(xs), 0.5);
/** @param {readonly number[]} xs */
export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
/** @param {readonly number[]} xs */
export const quantiles = (xs) => {
  const s = asc(xs);
  return { p10: percentile(s, 0.1), p25: percentile(s, 0.25), p50: percentile(s, 0.5), p75: percentile(s, 0.75), p90: percentile(s, 0.9) };
};

// ---------------------------------------------------------------------------------
// the per-launch series
// ---------------------------------------------------------------------------------

/**
 * @typedef {object} LaunchRow
 * One launch, with the outsider create-slot prize attached.
 * @property {string} mint
 * @property {string} symbol
 * @property {string} date `created_utc`.
 * @property {boolean} taped `tape !== 'none'`.
 * @property {number | null} devBuy Deployer's own buy, SOL.
 * @property {number} cohortStake Cohort create-slot stake, SOL, all pairs.
 * @property {number} outsiderStakeAll Non-cohort create-slot stake, SOL, all pairs.
 * @property {number} outsiderWallets Non-cohort wallets reaching the create slot.
 * @property {number} createSlotWallets Every wallet reaching the create slot bar the deployer,
 *   straight off `launches.csv`. Cohort included — this is the figure the control's
 *   `n_create_slot_wallets` is comparable to, because that column counts a control deployer's
 *   own helpers too and nothing on the tape says which of them are helpers.
 * @property {number} stake Non-cohort create-slot stake over **closed** round trips only.
 * @property {number} gross Their realised SOL, **gross of every fee**.
 * @property {number} trips Closed round trips behind `stake`/`gross`.
 * @property {number} net Fee-inclusive net over the subset of those trips priced on-chain.
 * @property {number} netTrips How many of `trips` are priced. Equal to `trips` when the
 *   launch is fully priced; 0 before 2026-05-08, when `onchain_create_slot_pnl.csv` starts.
 * @property {number} lateStake Non-create-slot closed stake, SOL.
 * @property {number} lateGross Non-create-slot closed realised SOL, gross of fees.
 * @property {number} lateTrips
 */

/**
 * Build the per-launch series from the three files the measurement needs.
 *
 * Two dataset traps are load-bearing here and are handled the way `src/types.ts` forces:
 * only `closed_in_window = 1` pairs carry a complete P&L, so the prize is summed over those
 * alone; and every tape column is gross of fees, so `gross` and `net` are kept apart and
 * never added.
 *
 * @returns {LaunchRow[]} Ascending by `date`.
 */
export function perLaunchSeries() {
  const launches = readCsv('launches.csv');
  const pairs = readCsv('wallet_launch_pnl.csv');
  const onchain = readCsv('onchain_create_slot_pnl.csv');

  /** @type {Map<string, LaunchRow>} */ const byMint = new Map();
  for (const l of launches) {
    const mint = l['mint'] ?? '';
    byMint.set(mint, {
      mint, symbol: l['symbol'] ?? '', date: l['created_utc'] ?? '', taped: l['tape'] !== 'none',
      devBuy: num(l['dev_sol_in']), cohortStake: 0, outsiderStakeAll: 0, outsiderWallets: 0,
      createSlotWallets: num(l['n_createslot_wallets']) ?? 0,
      stake: 0, gross: 0, trips: 0, net: 0, netTrips: 0, lateStake: 0, lateGross: 0, lateTrips: 0,
    });
  }

  /** @type {Set<string>} pairs whose P&L is complete and in the create slot */
  const closedSlotZero = new Set();
  for (const p of pairs) {
    const mint = p['mint'] ?? '', wallet = p['wallet'] ?? '';
    const row = byMint.get(mint);
    if (row === undefined || wallet === DEPLOYER) continue;
    const inSlotZero = p['in_create_slot'] === '1';
    const closed = p['closed_in_window'] === '1';
    const stake = num(p['sol_in']) ?? 0;
    if (COHORT.has(wallet)) {
      if (inSlotZero) row.cohortStake += stake;
      continue;
    }
    if (inSlotZero) {
      row.outsiderStakeAll += stake;
      row.outsiderWallets += 1;
      if (closed) {
        row.stake += stake;
        row.gross += num(p['realised_sol']) ?? 0;
        row.trips += 1;
        closedSlotZero.add(`${mint}|${wallet}`);
      }
    } else if (closed) {
      row.lateStake += stake;
      row.lateGross += num(p['realised_sol']) ?? 0;
      row.lateTrips += 1;
    }
  }

  // Fee-inclusive net, restricted to the same closed create-slot pairs. A wallet can appear
  // on several transactions of one launch, so the lamport deltas are summed per pair first.
  /** @type {Map<string, number>} */ const netByPair = new Map();
  for (const r of onchain) {
    const k = `${r['mint'] ?? ''}|${r['wallet'] ?? ''}`;
    if (!closedSlotZero.has(k)) continue;
    netByPair.set(k, (netByPair.get(k) ?? 0) + (num(r['sol_delta_lamports']) ?? 0) / 1e9);
  }
  for (const k of closedSlotZero) {
    const n = netByPair.get(k);
    if (n === undefined) continue;
    const row = byMint.get(k.slice(0, k.indexOf('|')));
    if (row === undefined) continue;
    row.net += n;
    row.netTrips += 1;
  }

  return [...byMint.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------------
// changepoints
// ---------------------------------------------------------------------------------

/**
 * Mid-ranks of `values`, ties averaged. The ranking does not depend on where the series is
 * split, so it is computed once per candidate segment rather than once per split.
 *
 * @param {readonly number[]} values
 * @returns {number[]} `rank[i]` is the mid-rank of `values[i]`, 1-based.
 */
export function rankVector(values) {
  const order = values.map((v, i) => /** @type {[number, number]} */ ([v, i])).sort((a, b) => a[0] - b[0]);
  /** @type {number[]} */ const rank = new Array(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && (order[j + 1]?.[0] ?? NaN) === (order[i]?.[0] ?? NaN)) j++;
    const r = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) rank[order[t]?.[1] ?? 0] = r;
    i = j + 1;
  }
  return rank;
}

/**
 * Running sums of a rank vector: `prefix[k]` is the rank sum of the first `k` observations, so
 * every split of one series costs O(1) once this is built.
 *
 * @param {readonly number[]} rank
 * @returns {number[]} Length `rank.length + 1`.
 */
export function rankPrefix(rank) {
  /** @type {number[]} */ const prefix = new Array(rank.length + 1).fill(0);
  for (let i = 0; i < rank.length; i++) prefix[i + 1] = (prefix[i] ?? 0) + (rank[i] ?? 0);
  return prefix;
}

/**
 * Standardised Mann–Whitney rank-sum statistic for the split `[0…k) | [k…n)` of a series whose
 * rank prefix sums are `prefix`.
 *
 * @param {readonly number[]} prefix From {@link rankPrefix}.
 * @param {number} k
 * @param {number} minSegment
 * @returns {number} z. 0 when either side is shorter than `minSegment`.
 */
export function rankSumZFromPrefix(prefix, k, minSegment = 8) {
  const n = prefix.length - 1, n1 = k, n2 = n - k;
  if (n1 < minSegment || n2 < minSegment) return 0;
  const r1 = prefix[k] ?? 0;
  const mu = (n1 * (n + 1)) / 2;
  const sd = Math.sqrt((n1 * n2 * (n + 1)) / 12);
  return (r1 - mu) / sd;
}

/**
 * Standardised Mann–Whitney rank-sum statistic for the split `values[0…k) | values[k…]`.
 *
 * Rank-based on purpose: the per-launch prize is heavy-tailed (one launch is +27 SOL) and a
 * mean-shift test would chase single launches instead of level changes.
 *
 * @param {readonly number[]} values
 * @param {number} k
 * @param {number} minSegment
 * @returns {number} z. 0 when either side is shorter than `minSegment`.
 */
export function rankSumZ(values, k, minSegment = 8) {
  if (k < minSegment || values.length - k < minSegment) return 0;
  return rankSumZFromPrefix(rankPrefix(rankVector(values)), k, minSegment);
}

/**
 * @typedef {object} Break
 * @property {number} index First index of the segment **after** the break.
 * @property {number} z Absolute rank-sum z at that split.
 * @property {number} depth Recursion depth it was found at.
 */

/**
 * Binary segmentation: recursively split wherever the rank-sum statistic exceeds `minZ`.
 *
 * This is what makes the window count a measurement rather than a threshold choice. It asks
 * "is the level different either side of here", never "is the level above some bar" — so it
 * cannot be tuned into finding more windows, which thresholding demonstrably can
 * ({@link runsAboveThreshold}).
 *
 * @param {readonly number[]} values
 * @param {number} minZ
 * @param {number} minSegment
 * @returns {Break[]} Ascending by index.
 */
export function changepoints(values, minZ = 4, minSegment = 8) {
  /** @type {Break[]} */ const out = [];
  /** @param {number} lo @param {number} hi @param {number} depth */
  const recurse = (lo, hi, depth) => {
    const slice = values.slice(lo, hi);
    if (slice.length < minSegment * 2 + 4) return;
    const prefix = rankPrefix(rankVector(slice));
    let best = { z: 0, k: -1 };
    for (let k = minSegment; k <= slice.length - minSegment; k++) {
      const z = Math.abs(rankSumZFromPrefix(prefix, k, minSegment));
      if (z > best.z) best = { z, k };
    }
    if (best.k < 0 || best.z < minZ) return;
    const at = lo + best.k;
    out.push({ index: at, z: best.z, depth });
    recurse(lo, at, depth + 1);
    recurse(at, hi, depth + 1);
  };
  recurse(0, values.length, 0);
  return out.sort((a, b) => a.index - b.index);
}

/**
 * The alternative this report rejects: count maximal runs whose trailing-`k` median clears a
 * bar. Reported only to show the answer moves with the bar — 2 runs at 0.05, 7 at 0.15.
 *
 * @param {readonly number[]} values
 * @param {number} threshold
 * @param {number} trailing
 * @param {number} minRun
 * @returns {Array<{from: number, to: number, length: number}>}
 */
export function runsAboveThreshold(values, threshold, trailing = 7, minRun = 5) {
  /** @type {Array<{from: number, to: number, length: number}>} */ const runs = [];
  /** @type {{from: number, to: number} | null} */ let cur = null;
  for (let i = 0; i < values.length; i++) {
    const m = median(values.slice(Math.max(0, i - trailing + 1), i + 1));
    if (m >= threshold) cur = cur === null ? { from: i, to: i } : { from: cur.from, to: i };
    else if (cur !== null) { runs.push({ ...cur, length: cur.to - cur.from + 1 }); cur = null; }
  }
  if (cur !== null) runs.push({ ...cur, length: cur.to - cur.from + 1 });
  return runs.filter((r) => r.length >= minRun);
}

// ---------------------------------------------------------------------------------
// the window this tape contains
// ---------------------------------------------------------------------------------

/**
 * The two dates the changepoint scan finds, hard-coded so every downstream table cuts on the
 * same boundaries. `README.md` §3 derives them and `test/window-population.test.ts` re-derives
 * them blind from the series; nothing here is fitted to them.
 */
export const WINDOW_OPEN = '2026-03-12';
export const WINDOW_CLOSE = '2026-06-04';

/** @param {string} date @returns {'before' | 'open' | 'after'} */
export const regimeOf = (date) => (date < WINDOW_OPEN ? 'before' : date < WINDOW_CLOSE ? 'open' : 'after');

/**
 * @typedef {object} RegimeStats
 * @property {'before' | 'open' | 'after'} regime
 * @property {number} launches Every launch in the regime.
 * @property {number} measurable Launches with at least one closed outsider create-slot trip.
 * @property {number} trips
 * @property {number} stake SOL.
 * @property {number} gross SOL, gross of fees.
 * @property {number} grossRoi
 * @property {number} pricedLaunches Launches where every such trip is priced on-chain.
 * @property {number} pricedGross SOL over those launches.
 * @property {number} pricedNet SOL, fee-inclusive, over those launches.
 * @property {ReturnType<typeof quantiles>} prizeQuantiles Per-launch gross prize, SOL.
 * @property {ReturnType<typeof quantiles>} roiQuantiles Per-launch gross return per SOL.
 * @property {ReturnType<typeof quantiles>} shareQuantiles Per-launch operation share of the
 *   bottom of the curve — the June report's T1.
 */

/**
 * @param {readonly LaunchRow[]} series
 * @param {'before' | 'open' | 'after'} regime
 * @returns {RegimeStats}
 */
export function regimeStats(series, regime) {
  const all = series.filter((r) => regimeOf(r.date) === regime);
  const rows = all.filter((r) => r.trips > 0);
  const priced = rows.filter((r) => r.netTrips > 0 && r.netTrips === r.trips);
  const share = all
    .filter((r) => r.devBuy !== null && r.devBuy > 0)
    .map((r) => ((r.devBuy ?? 0) + r.cohortStake) / ((r.devBuy ?? 0) + r.cohortStake + r.outsiderStakeAll));
  const stake = sum(rows.map((r) => r.stake));
  const gross = sum(rows.map((r) => r.gross));
  return {
    regime,
    launches: all.length,
    measurable: rows.length,
    trips: sum(rows.map((r) => r.trips)),
    stake, gross, grossRoi: stake === 0 ? NaN : gross / stake,
    pricedLaunches: priced.length,
    pricedGross: sum(priced.map((r) => r.gross)),
    pricedNet: sum(priced.map((r) => r.net)),
    prizeQuantiles: quantiles(rows.map((r) => r.gross)),
    roiQuantiles: quantiles(rows.map((r) => r.gross / r.stake)),
    shareQuantiles: quantiles(share),
  };
}

/**
 * How long the close took to become visible in the outsiders' own P&L.
 *
 * For each trailing-window length `k`, the alarm level is the 5th percentile of the same
 * trailing median **inside the open window** — i.e. a level the open regime itself crossed
 * one launch in twenty. The latency is how many launches after the break the trailing median
 * first goes below it. Calibrating on the open regime is what stops this being a threshold
 * pulled out of the air.
 *
 * @param {readonly LaunchRow[]} series
 * @param {readonly number[]} ks
 */
export function closeDetectionLatency(series, ks = [1, 3, 5, 7]) {
  const rows = series.filter((r) => r.trips > 0);
  const roi = rows.map((r) => r.gross / r.stake);
  const firstAfter = rows.findIndex((r) => regimeOf(r.date) === 'after');
  const openIdx = rows.map((r, i) => ({ r, i })).filter((x) => regimeOf(x.r.date) === 'open').map((x) => x.i);
  const openStart = openIdx[0] ?? 0;
  return ks.map((k) => {
    /** @param {number} i */ const trail = (i) => median(roi.slice(Math.max(0, i - k + 1), i + 1));
    const alarm = percentile(asc(openIdx.filter((i) => i >= openStart + k).map(trail)), 0.05);
    // No closed regime in the series means there is no break to be late to. Without this the
    // breach loop would start at index -1 and time a close that never happened.
    if (firstAfter < 0) return { k, alarm, launchesAfterBreak: null, daysAfterBreak: null, at: null };
    let hit = -1;
    for (let i = firstAfter; i < rows.length; i++) if (trail(i) < alarm) { hit = i; break; }
    const breakRow = rows[firstAfter];
    const hitRow = hit < 0 ? undefined : rows[hit];
    return {
      k, alarm,
      launchesAfterBreak: hit < 0 ? null : hit - firstAfter,
      daysAfterBreak: hitRow === undefined || breakRow === undefined
        ? null
        : (Date.parse(hitRow.date) - Date.parse(breakRow.date)) / 86_400_000,
      at: hitRow === undefined ? null : `${hitRow.date.slice(0, 10)} ${hitRow.symbol}`,
    };
  });
}

/**
 * @typedef {object} UnitBucket One regime's closed create-slot result for one trading unit.
 * @property {number} trips
 * @property {number} gross SOL, gross of every fee.
 * @property {number} stake SOL.
 */

/**
 * @typedef {object} UnitLedgerRow
 * @property {string} unit
 * @property {string} first
 * @property {string} last
 * @property {UnitBucket} before
 * @property {UnitBucket} open
 * @property {UnitBucket} after
 */

/**
 * Every outsider trading unit's create-slot result, split by regime. The book counts once.
 *
 * @returns {UnitLedgerRow[]}
 */
export function unitLedger() {
  const pairs = readCsv('wallet_launch_pnl.csv');
  const dateOf = new Map(readCsv('launches.csv').map((l) => [l['mint'] ?? '', l['created_utc'] ?? '']));
  /** @type {Map<string, UnitLedgerRow>} */
  const units = new Map();
  for (const p of pairs) {
    if (p['closed_in_window'] !== '1' || p['in_create_slot'] !== '1') continue;
    const wallet = p['wallet'] ?? '';
    if (wallet === DEPLOYER || COHORT.has(wallet)) continue;
    const date = dateOf.get(p['mint'] ?? '');
    if (date === undefined) continue;
    const u = unitOf(wallet);
    let e = units.get(u);
    if (e === undefined) {
      e = {
        unit: u, first: date, last: date,
        before: { trips: 0, gross: 0, stake: 0 },
        open: { trips: 0, gross: 0, stake: 0 },
        after: { trips: 0, gross: 0, stake: 0 },
      };
      units.set(u, e);
    }
    if (date < e.first) e.first = date;
    if (date > e.last) e.last = date;
    const bucket = e[regimeOf(date)];
    bucket.trips += 1;
    bucket.gross += num(p['realised_sol']) ?? 0;
    bucket.stake += num(p['sol_in']) ?? 0;
  }
  return [...units.values()];
}

/**
 * The create slot of each launch: the `first_slot` shared by every pair the tape marks
 * `in_create_slot`. Ambiguity is an error rather than a first-wins choice, the same way
 * `src/tape.ts` treats it.
 *
 * @returns {Map<string, number>}
 */
export function createSlotByMint() {
  /** @type {Map<string, number>} */ const cs = new Map();
  for (const p of readCsv('wallet_launch_pnl.csv')) {
    if (p['in_create_slot'] !== '1') continue;
    const mint = p['mint'] ?? '';
    const slot = num(p['first_slot']);
    if (slot === null) continue;
    const seen = cs.get(mint);
    if (seen === undefined) cs.set(mint, slot);
    else if (seen !== slot) throw new Error(`${mint}: create slot ambiguous (${seen} vs ${slot})`);
  }
  return cs;
}

/** @type {Map<string, number | null>} Last create-slot outsider fill price, SOL per token. */
const lastFillCache = new Map();

/**
 * The price of the **last** non-deployer buy in a launch's create slot, straight off the window
 * tape. `null` when the launch is not covered, has no create slot, or had no such buy.
 *
 * Coverage is `meta.reached_mint`, never file existence: all 239 mints have a tape and four of
 * them never reached the mint, so their files are truncated at the *oldest* end — every row sits
 * inside that launch's own window, but the create slot the backwards walk never reached is absent.
 *
 * @param {string} mint
 * @param {ReadonlyMap<string, number>} createSlot
 * @returns {number | null}
 */
function lastCreateSlotFillPrice(mint, createSlot) {
  const cached = lastFillCache.get(mint);
  if (cached !== undefined) return cached;
  /** @type {number | null} */ let price = null;
  const slot = createSlot.get(mint);
  const metaPath = join(DATA_DIR, 'window', `${mint}.meta.json`);
  const tapePath = join(DATA_DIR, 'window', `${mint}.jsonl.gz`);
  if (slot !== undefined && existsSync(metaPath) && existsSync(tapePath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta?.reached_mint === true) {
      const text = gunzipSync(readFileSync(tapePath)).toString('utf8');
      for (const line of text.split('\n')) {
        if (line === '') continue;
        const t = JSON.parse(line);
        if (t?.slot !== slot || t?.k !== 'buy' || t?.u === DEPLOYER) continue;
        const psol = num(typeof t?.psol === 'string' ? t.psol : String(t?.psol ?? ''));
        if (psol !== null && Number.isFinite(psol) && psol > 0) price = psol;
      }
    }
  }
  lastFillCache.set(mint, price);
  return price;
}

/**
 * @typedef {object} PriceMultipleResult
 * @property {number[]} multiples One per launch the multiple could be computed on.
 * @property {number} launches How many launches were offered.
 * @property {{noCreateSlotFill: number, noDevBuyPrice: number}} skipped Why the rest are absent —
 *   reported rather than left to vanish out of a median.
 */

/**
 * The subject's create-slot price multiple, on the control's own basis.
 *
 * `control_create_slot.csv` publishes `last_create_slot_price / p0`: the **last** fill in the
 * create slot over the creator's own dev-buy price. `p0` is that dev-buy price — on the 24
 * control launches using the identical 14.814814813-SOL preset it is this deployer's own
 * `price_devbuy` to ten significant figures — so the subject's counterpart is the same
 * construction, and it is built here from the window tape: the last non-deployer buy in the
 * create slot, over `launches.csv`'s `price_devbuy`.
 *
 * It is **not** taken from `first30s_best.csv`. That file is the ten best early entrants per
 * launch, a truncated subset — a median of 5 create-slot rows per open-window launch against a
 * median of 10 wallets actually in the slot — so its highest fill is below the slot's real last
 * fill on most launches, and two open-window launches have no row in it at all.
 *
 * @param {readonly LaunchRow[]} series
 * @returns {PriceMultipleResult}
 */
export function createSlotPriceMultiples(series) {
  const createSlot = createSlotByMint();
  const devBuyPrice = new Map(
    readCsv('launches.csv').map((l) => [l['mint'] ?? '', num(l['price_devbuy'])]),
  );
  /** @type {number[]} */ const multiples = [];
  const skipped = { noCreateSlotFill: 0, noDevBuyPrice: 0 };
  for (const r of series) {
    const p0 = devBuyPrice.get(r.mint) ?? null;
    if (p0 === null || !Number.isFinite(p0) || p0 <= 0) { skipped.noDevBuyPrice += 1; continue; }
    const fill = lastCreateSlotFillPrice(r.mint, createSlot);
    if (fill === null) { skipped.noCreateSlotFill += 1; continue; }
    multiples.push(fill / p0);
  }
  return { multiples, launches: series.length, skipped };
}

// ---------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------

/** @param {number} x @param {number} d */
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
/** @param {ReturnType<typeof quantiles>} q @param {number} d */
const qline = (q, d = 3) => `${f(q.p10, d)} / ${f(q.p25, d)} / ${f(q.p50, d)} / ${f(q.p75, d)} / ${f(q.p90, d)}`;

export function main() {
  const series = perLaunchSeries();
  const measurable = series.filter((r) => r.trips > 0);
  const first = series[0], last = series[series.length - 1];
  console.log(`population tape: ${series.length} launches, ${first?.date.slice(0, 10)} → ${last?.date.slice(0, 10)}`);
  console.log(`measurable (>=1 closed outsider create-slot round trip): ${measurable.length}` +
    `   of the rest, ${series.filter((r) => !r.taped).length} have no tape at all\n`);

  console.log('CHANGEPOINTS — binary segmentation, |z| >= 4, minimum segment 8 launches');
  for (const [name, pick] of /** @type {Array<[string, (r: LaunchRow) => number]>} */ ([
    ['gross return per SOL', (r) => r.gross / r.stake],
    ['gross prize, SOL', (r) => r.gross],
  ])) {
    const breaks = changepoints(measurable.map(pick));
    console.log(`  on ${name}:`);
    for (const b of breaks) {
      const before = measurable[b.index - 1], after = measurable[b.index];
      console.log(`    |z|=${f(b.z, 1)} depth ${b.depth}  between ${before?.date.slice(0, 10)} ${before?.symbol} and ${after?.date.slice(0, 10)} ${after?.symbol}`);
    }
  }
  const inside = measurable.filter((r) => regimeOf(r.date) === 'open');
  for (const [name, pick] of /** @type {Array<[string, (r: LaunchRow) => number]>} */ ([
    ['gross return per SOL', (r) => r.gross / r.stake],
    ['gross prize, SOL', (r) => r.gross],
  ])) {
    const vals = inside.map(pick);
    let best = 0;
    for (let k = 8; k <= vals.length - 8; k++) best = Math.max(best, Math.abs(rankSumZ(vals, k)));
    console.log(`  strongest break INSIDE the open window on ${name}: |z|=${f(best, 2)} (below 4 — one regime)`);
  }

  console.log('\nTHRESHOLD COUNTING, the alternative this report rejects');
  const roiSeries = measurable.map((r) => r.gross / r.stake);
  for (const th of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35]) {
    const runs = runsAboveThreshold(roiSeries, th);
    console.log(`  bar ${th.toFixed(2)} on the trailing-7 median: ${runs.length} "windows" — ` +
      runs.map((r) => `${measurable[r.from]?.date.slice(0, 10)}→${measurable[r.to]?.date.slice(0, 10)}`).join(', '));
  }

  console.log('\nREGIMES');
  for (const regime of /** @type {const} */ (['before', 'open', 'after'])) {
    const s = regimeStats(series, regime);
    const rows = series.filter((r) => regimeOf(r.date) === regime);
    const a = rows[0]?.date.slice(0, 10), b = rows[rows.length - 1]?.date.slice(0, 10);
    const days = (Date.parse(rows[rows.length - 1]?.date ?? '') - Date.parse(rows[0]?.date ?? '')) / 86_400_000;
    console.log(`  ${regime.padEnd(6)} ${a} → ${b}  ${f(days, 0)} d  ${s.launches} launches (${s.measurable} measurable), ${s.trips} round trips`);
    console.log(`         stake ${f(s.stake, 1)} SOL   gross prize ${f(s.gross, 1)} SOL   return per SOL ${f(s.grossRoi, 3)}`);
    console.log(`         fully priced launches ${s.pricedLaunches}: gross ${f(s.pricedGross, 1)} → net ${f(s.pricedNet, 1)} SOL (net/gross ${f(s.pricedNet / s.pricedGross, 3)})`);
    console.log(`         per-launch prize   p10/p25/p50/p75/p90 = ${qline(s.prizeQuantiles, 2)} SOL`);
    console.log(`         per-launch ROI     p10/p25/p50/p75/p90 = ${qline(s.roiQuantiles)}`);
    console.log(`         operation share T1 p10/p25/p50/p75/p90 = ${qline(s.shareQuantiles)}`);
  }

  console.log('\nTHE LATER SEATS — entrants who were NOT in the create slot, gross of fees');
  const lateRows = series.filter((r) => r.lateTrips > 0);
  for (const [name, pick] of /** @type {Array<[string, (r: LaunchRow) => number]>} */ ([
    ['gross return per SOL', (r) => r.lateGross / r.lateStake],
    ['gross prize, SOL', (r) => r.lateGross],
  ])) {
    const breaks = changepoints(lateRows.map(pick));
    for (const b of breaks) {
      const before = lateRows[b.index - 1], after = lateRows[b.index];
      console.log(`  ${name}: |z|=${f(b.z, 1)} between ${before?.date.slice(0, 10)} ${before?.symbol} and ${after?.date.slice(0, 10)} ${after?.symbol}`);
    }
    const cut = breaks[0]?.index ?? lateRows.length;
    console.log(`    up to the break: median ${f(median(lateRows.slice(0, cut).map(pick)), 3)}` +
      `   after it: median ${f(median(lateRows.slice(cut).map(pick)), 3)}`);
  }

  console.log('\nTHE CLOSE, LAUNCH BY LAUNCH');
  const around = measurable.filter((r) => r.date >= '2026-06-01' && r.date <= '2026-06-07');
  for (const r of around) {
    console.log(`  ${r.date.slice(0, 16).replace('T', ' ')}  ${r.symbol.padEnd(12)} return per SOL ${f(r.gross / r.stake, 3).padStart(7)}   prize ${f(r.gross, 2).padStart(7)} SOL`);
  }

  console.log('\nTHE OPERATION’S OWN PARAMETERS, PER REGIME (medians)');
  for (const regime of /** @type {const} */ (['before', 'open', 'after'])) {
    const rows = series.filter((r) => regimeOf(r.date) === regime && r.devBuy !== null && r.devBuy > 0);
    console.log(`  ${regime.padEnd(6)} dev buy ${f(median(rows.map((r) => r.devBuy ?? 0)), 3).padStart(8)} SOL` +
      `   cohort create-slot stake ${f(median(rows.map((r) => r.cohortStake)), 2).padStart(6)} SOL` +
      `   outsider create-slot stake ${f(median(rows.map((r) => r.outsiderStakeAll)), 2).padStart(6)} SOL` +
      `   numerator ${f(median(rows.map((r) => r.devBuy ?? 0)) + median(rows.map((r) => r.cohortStake)), 2)} SOL`);
  }

  console.log('\nCADENCE INSIDE THE OPEN WINDOW');
  const open = series.filter((r) => regimeOf(r.date) === 'open');
  /** @type {number[]} */ const gaps = [];
  for (let i = 1; i < open.length; i++) gaps.push((Date.parse(open[i]?.date ?? '') - Date.parse(open[i - 1]?.date ?? '')) / 86_400_000);
  const gq = quantiles(gaps);
  console.log(`  ${open.length} launches over ${f((Date.parse(open[open.length - 1]?.date ?? '') - Date.parse(open[0]?.date ?? '')) / 86_400_000, 1)} days` +
    `, ${new Set(open.map((r) => r.date.slice(0, 10))).size} distinct launch days`);
  console.log(`  gap between launches, days   p10/p25/p50/p75/p90 = ${qline(gq, 2)}   max ${f(Math.max(...gaps), 2)}`);
  console.log(`  launches with no outsider in the create slot at all: ${open.filter((r) => r.outsiderWallets === 0).length} of ${open.length}`);

  console.log('\nHOW FAST THE CLOSE BECAME VISIBLE');
  for (const d of closeDetectionLatency(series)) {
    console.log(`  trailing ${d.k} launches: open-window 1-in-20 level ${f(d.alarm, 3)}` +
      `  first breach +${d.launchesAfterBreak} launches / +${f(d.daysAfterBreak ?? NaN, 1)} d  (${d.at})`);
  }

  console.log('\nCONCURRENCY OF EXTRACTORS INSIDE THE ONE WINDOW');
  const units = unitLedger();
  const ranked = units.filter((u) => u.open.trips > 0).sort((a, b) => b.open.gross - a.open.gross);
  const total = sum(ranked.map((u) => u.open.gross));
  console.log(`  ${ranked.length} outsider units took a closed create-slot round trip inside the window`);
  console.log(`  gross prize ${f(total, 1)} SOL: top 1 = ${f(100 * (ranked[0]?.open.gross ?? 0) / total, 0)}%, ` +
    `top 2 = ${f(100 * ((ranked[0]?.open.gross ?? 0) + (ranked[1]?.open.gross ?? 0)) / total, 0)}%, ` +
    `top 5 = ${f(100 * sum(ranked.slice(0, 5).map((u) => u.open.gross)) / total, 0)}%`);
  console.log(`  units clearing +5 SOL gross over the whole window: ${ranked.filter((u) => u.open.gross >= 5).length}` +
    `   +1 SOL: ${ranked.filter((u) => u.open.gross >= 1).length}   positive: ${ranked.filter((u) => u.open.gross > 0).length}`);
  const spanning = units.filter((u) => u.open.trips >= 8 && u.after.trips >= 8);
  console.log(`  units with >=8 round trips on BOTH sides of the close (the only ones testable): ${spanning.length}`);
  for (const u of spanning.sort((a, b) => b.open.gross - a.open.gross)) {
    console.log(`    ${u.unit.slice(0, 26).padEnd(27)} open ${String(u.open.trips).padStart(3)} trips ROI ${f(u.open.gross / u.open.stake, 3)}` +
      `   after ${String(u.after.trips).padStart(3)} trips ROI ${f(u.after.gross / u.after.stake, 3)}`);
  }

  console.log('\nWHAT THE 70-DEPLOYER CONTROL CAN AND CANNOT SAY');
  const control = readCsv('control_create_slot.csv');
  const wallets = control.map((c) => num(c['n_create_slot_wallets']) ?? 0);
  const mults = control.map((c) => (num(c['last_create_slot_price']) ?? 0) / (num(c['p0']) ?? 1));
  console.log(`  ${control.length} other deployers, one launch each, no dates and no P&L — 0 window observations`);
  console.log(`  create-slot wallets        p10/p25/p50/p75/p90 = ${qline(quantiles(wallets), 1)}`);
  console.log(`  create-slot price multiple p10/p25/p50/p75/p90 = ${qline(quantiles(mults), 2)}`);
  const bidInto = control.filter((c) => (num(c['n_create_slot_wallets']) ?? 0) > 0);
  console.log(`  of the 70, ${control.length - bidInto.length} had nobody but the creator in the` +
    ` create slot and read exactly 1.00; over the other ${bidInto.length} the median multiple is` +
    ` ${f(median(bidInto.map((c) => (num(c['last_create_slot_price']) ?? 0) / (num(c['p0']) ?? 1))), 2)}` +
    ` — the like-for-like partner for the subject's figure below`);
  // Like for like: the control column counts every create-slot wallet bar the creator, so it
  // carries a control deployer's own helpers as well as its outsiders and nothing in that file
  // separates the two. The subject's comparable figure is therefore its total — cohort included
  // — not the outsider-only count the rest of this report is built on.
  const subjectMedian = median(open.map((r) => r.createSlotWallets));
  console.log(`  subject's open-window median create-slot wallets (cohort included, deployer excluded,` +
    ` the control column's own basis): ${f(subjectMedian, 1)}` +
    `   — outsiders alone: ${f(median(open.map((r) => r.outsiderWallets)), 1)}`);
  console.log(`  control deployers reaching that level: ${wallets.filter((w) => w >= subjectMedian).length} of ${control.length}`);
  const mult = createSlotPriceMultiples(open);
  console.log(`  subject's open-window median create-slot price multiple, same basis — last` +
    ` create-slot fill over the deployer's own fill price, off the window tape:` +
    ` ${f(median(mult.multiples), 2)}`);
  console.log(`  computed over ${mult.multiples.length} of ${mult.launches} open-window launches` +
    ` (skipped: ${mult.skipped.noCreateSlotFill} with no covered create-slot fill,` +
    ` ${mult.skipped.noDevBuyPrice} with no dev-buy price)`);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main();
