/**
 * Reading the committed population tape, for the backtest only. **Offline: no socket, no
 * credential.** The live watcher never touches this file — it reads the create slot off the
 * endpoint through `createslot.mjs`, and both feeds reach `detector.mjs` in the same shape, which
 * is the point of normalising the endpoint's rows into the tape's schema rather than the reverse.
 *
 * It parses the CSVs itself rather than importing `src/` or `analysis/`, because this directory is
 * plain `.mjs` that must run on the Node 20 floor with no build step and the boundary between the
 * three areas is asserted structurally. That duplication is the boundary's deliberate cost;
 * `src/types.ts` remains the authority on column semantics and on the three traps.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { POPULATION_TAPE, POPULATION_TAPE_DIR, requireDataset } from '../../config/data-root.mjs';

/**
 * @type {string} Absolute path of the population tape directory.
 *
 * **Where it lives is `config/data-root.mjs`'s answer, not this tool's**: the tapes are not in
 * this tree, and it defaults to the store at `~/slot-zero-data` and moves with
 * `SLOT_ZERO_DATA_ROOT`. **No trailing separator** — it used to have
 * one and paths were built by concatenation; they are built with `join()` now.
 */
export const DATA_DIR = POPULATION_TAPE_DIR;

/**
 * The deployer this tape is one long observation of.
 *
 * Duplicated from `src/cohort.ts` for the boundary reason above, and it is a constant of the
 * DATASET, not a configuration of the tool: `watch.mjs` takes the wallet to watch on the command
 * line and knows nothing about this one.
 */
export const SUBJECT_DEPLOYER = '7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL';

/** The six create-slot cohort wallets — part of the operation, not competitors for it. */
export const SUBJECT_COHORT = Object.freeze([
  '2CHrnc2LyagAbMaMFgthiDWh7ZZ9zT9TF8WEJf7MNE71',
  'Atgx1JXsp8pTQ9Qsi74wF5pLMVwHwyQc6jJCu84evN7c',
  '8kzFH4rgFzy4ccz97AhgqRT7Qbt7HnD5oJCDK1Sxdarb',
  'GfJA84gwT9LpeyzeckeXkCsf8vdQuA64ZYQ91xoBawvt',
  '5P8A9bGUhroskpuA4hhRbybgt37TcTz7ft5zLAh8orpn',
  '43x1zWzjVWJbQErWM78m3Acx83FFuGSQEhmgyxUrPdQs',
]);

/**
 * The two dates the blind changepoint scan in `analysis/window-population/` found. Quoted here so
 * the backtest can label a launch's regime; nothing in the detector reads them, and nothing in it
 * is calibrated on them.
 */
export const WINDOW_OPEN = '2026-03-12';
export const WINDOW_CLOSE = '2026-06-04';

/** @param {string} date @returns {'before' | 'open' | 'after'} */
export const regimeOf = (date) => (date < WINDOW_OPEN ? 'before' : date < WINDOW_CLOSE ? 'open' : 'after');

/**
 * Minimal RFC-4180 reader. The tape's `name` column contains commas and quotes, so splitting on
 * `,` silently shifts every later column.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */ const rows = [];
  /** @type {string[]} */ let row = [];
  let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
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

/** @type {Map<string, Array<Record<string, string>>>} */
const csvCache = new Map();

/**
 * The dataset is a primary record, so a row that does not match its header is an error rather than
 * something to skip: a quoting regression would otherwise delete evidence in silence.
 *
 * @param {string} name File name inside {@link DATA_DIR}.
 * @returns {Array<Record<string, string>>}
 */
export function readCsv(name) {
  const cached = csvCache.get(name);
  if (cached !== undefined) return cached;
  // The backtest's first read of the tape, and so where an absent dataset is named as one.
  const rows = parseCsv(readFileSync(join(requireDataset(POPULATION_TAPE, DATA_DIR), name), 'utf8'));
  const head = rows[0];
  if (head === undefined) throw new Error(`${name}: empty`);
  /** @type {Array<Record<string, string>>} */ const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (cells.length !== head.length) {
      if (r === rows.length - 1 && cells.every((c) => c === '')) continue;
      throw new Error(`${name}: line ${r + 1} has ${cells.length} fields, header has ${head.length}`);
    }
    /** @type {Record<string, string>} */ const o = {};
    for (let i = 0; i < head.length; i++) o[head[i] ?? ''] = cells[i] ?? '';
    out.push(o);
  }
  csvCache.set(name, out);
  return out;
}

/**
 * @typedef {object} TapedLaunch
 * @property {string} mint
 * @property {string} symbol
 * @property {string} date `created_utc`.
 * @property {import('./detector.mjs').Fill[]} fills Every fill in the launch's window tape,
 *   ascending by `sid`. Empty when the launch has no covered tape.
 */

/**
 * Every launch of the committed tape, ascending by date, with its window fills attached.
 *
 * **Coverage is `meta.reached_mint`, never file existence.** All 239 mints have a `window/*.jsonl.gz`
 * and four never reached the mint; their files are truncated at the OLDEST end, so the create slot
 * the backwards walk never reached is simply absent. Handing those fills to the detector would let
 * it read the earliest fill it happened to see as the create slot — the exact trap the live walk's
 * `proven` flag refuses. They come back with no fills instead.
 *
 * @returns {TapedLaunch[]}
 */
export function readTapedLaunches() {
  if (tapedLaunchCache !== null) return tapedLaunchCache;
  tapedLaunchCache = readCsv('launches.csv')
    .map((l) => {
      const mint = l['mint'] ?? '';
      return { mint, symbol: l['symbol'] ?? '', date: l['created_utc'] ?? '', fills: readWindowFills(mint) };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return tapedLaunchCache;
}

/**
 * @type {import('./tape.mjs').TapedLaunch[] | null}
 * Parsed once per process. The backtest replays the same 235 window tapes a dozen times over —
 * once per candidate detector and once per cell of the sensitivity grid — and re-gunzipping them
 * each time is the difference between a 10-second command and a 1-second one.
 */
let tapedLaunchCache = null;

/**
 * @param {string} mint
 * @returns {import('./detector.mjs').Fill[]}
 */
export function readWindowFills(mint) {
  const metaPath = join(DATA_DIR, 'window', `${mint}.meta.json`);
  const tapePath = join(DATA_DIR, 'window', `${mint}.jsonl.gz`);
  if (!existsSync(metaPath) || !existsSync(tapePath)) return [];
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta?.reached_mint !== true) return [];
  /** @type {import('./detector.mjs').Fill[]} */ const fills = [];
  for (const line of gunzipSync(readFileSync(tapePath)).toString('utf8').split('\n')) {
    if (line === '') continue;
    const t = JSON.parse(line);
    const sol = Number(t?.sol);
    if (typeof t?.sid !== 'string' || typeof t?.tx !== 'string' || typeof t?.u !== 'string') continue;
    if (t?.k !== 'buy' && t?.k !== 'sell') continue;
    if (!Number.isFinite(sol)) continue;
    fills.push({ slot: Number(t.slot), sid: t.sid, tx: t.tx, u: t.u, k: t.k, sol });
  }
  return fills.sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
}

/**
 * @typedef {object} PrizeRow One launch's outsider create-slot result, **gross of every fee**.
 * @property {string} mint
 * @property {number} stake SOL staked over closed round trips.
 * @property {number} gross Realised SOL over the same, gross of fees.
 * @property {number} trips
 * @property {number} netOfMeasuredFees Fee-inclusive realised SOL over the priced subset of those
 *   round trips. `onchain_create_slot_pnl.csv` starts on 2026-05-08, so this is 0 for every launch
 *   before then and MUST NOT be summed against `gross`.
 * @property {number} pricedTrips How many of `trips` are priced. Equal to `trips` on a fully priced
 *   launch; 0 before the on-chain file starts.
 */

/**
 * The per-launch outsider create-slot prize, for the P&L baseline this tool is compared against
 * and for pricing what a false stop forfeits.
 *
 * Only `closed_in_window = 1` pairs carry a complete P&L — the loader's second trap — so the prize
 * is summed over those alone. Every figure it produces is GROSS of fees and is an upper bound; the
 * comparison in `backtest.mjs` uses it only to price errors, never to earn a verdict.
 *
 * @returns {Map<string, PrizeRow>}
 */
export function readOutsiderPrize() {
  const cohort = new Set(SUBJECT_COHORT);
  /** @type {Map<string, PrizeRow>} */ const byMint = new Map();
  /** @type {Set<string>} `mint|wallet` of every pair whose P&L is complete and in the create slot. */
  const closedSlotZero = new Set();
  for (const p of readCsv('wallet_launch_pnl.csv')) {
    if (p['closed_in_window'] !== '1' || p['in_create_slot'] !== '1') continue;
    const wallet = p['wallet'] ?? '';
    if (wallet === SUBJECT_DEPLOYER || cohort.has(wallet)) continue;
    const mint = p['mint'] ?? '';
    let row = byMint.get(mint);
    if (row === undefined) { row = { mint, stake: 0, gross: 0, trips: 0, netOfMeasuredFees: 0, pricedTrips: 0 }; byMint.set(mint, row); }
    row.stake += Number(p['sol_in'] ?? 0);
    row.gross += Number(p['realised_sol'] ?? 0);
    row.trips += 1;
    closedSlotZero.add(`${mint}|${wallet}`);
  }

  // Fee-inclusive, over the SAME closed create-slot pairs. A wallet can appear on several
  // transactions of one launch, so the lamport deltas are summed per pair before being counted.
  /** @type {Map<string, number>} */ const netByPair = new Map();
  for (const r of readCsv('onchain_create_slot_pnl.csv')) {
    const key = `${r['mint'] ?? ''}|${r['wallet'] ?? ''}`;
    if (!closedSlotZero.has(key)) continue;
    netByPair.set(key, (netByPair.get(key) ?? 0) + Number(r['sol_delta_lamports'] ?? 0) / 1e9);
  }
  for (const [key, net] of netByPair) {
    const row = byMint.get(key.slice(0, key.indexOf('|')));
    if (row === undefined) continue;
    row.netOfMeasuredFees += net;
    row.pricedTrips += 1;
  }
  return byMint;
}
