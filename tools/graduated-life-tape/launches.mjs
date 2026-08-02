/**
 * Reading the committed population tape from disk. No network, no credential — this is the input
 * side of the collector, and it is deliberately the only place that knows the on-disk layout.
 *
 * Two rules from the dataset are enforced here rather than trusted:
 *
 * - **Key on `mint`, never on `symbol`.** Two launches in this tape are called `maxxing`, and one
 *   of them is the operator's best result ever. {@link readLaunches} returns rows keyed by mint and
 *   nothing here ever indexes by symbol.
 * - **A `window/*.jsonl.gz` existing does not mean the window was covered.** Coverage is the
 *   sidecar's `reached_mint`, and four of the 239 files are truncated at their oldest end.
 *   {@link readWindowTape} returns that flag alongside the fills so a caller cannot lose it.
 *
 * The CSV is parsed here rather than by importing `src/` for the same reason `tools/` and
 * `analysis/` both do it: this is plain `.mjs` on the Node 20 floor with no build step, and the
 * `src/`↔`tools/` boundary is asserted by `test/loader.test.ts` in both directions.
 */

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { slotOf } from './trades.mjs';

/** The committed primary record. Never reformatted, re-sorted or "cleaned" — read only. */
export const TAPE_DIR = fileURLToPath(
  new URL('../../data/population-tape-2026-07-29/', import.meta.url),
);

/**
 * @typedef {object} LaunchRow
 * @property {string} mint
 * @property {string} symbol
 * @property {string} createdUtc
 * @property {number} mintMs
 * @property {boolean} graduated
 */

/**
 * Parse RFC-4180 CSV, honouring quoted fields.
 *
 * Hand-rolled rather than split-on-comma because `launches.csv` has token names in it and at least
 * one of them contains a comma — a naive split silently shifts every later column of that row, and
 * the column it shifts into `graduated` is a boolean, so the corruption is a plausible value rather
 * than an obvious one. That is exactly one launch mis-classified with every test still green.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/**
 * Every launch in the committed tape, in the file's own order.
 *
 * @param {string} [dir]
 * @returns {LaunchRow[]}
 */
export function readLaunches(dir = TAPE_DIR) {
  const rows = parseCsv(readFileSync(join(dir, 'launches.csv'), 'utf8'));
  const header = /** @type {string[]} */ (rows[0]);
  const at = (/** @type {string} */ name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`launches.csv has no ${name} column`);
    return i;
  };
  const iMint = at('mint');
  const iSymbol = at('symbol');
  const iCreated = at('created_utc');
  const iGraduated = at('graduated');
  return rows.slice(1).map((r) => ({
    mint: /** @type {string} */ (r[iMint]),
    symbol: /** @type {string} */ (r[iSymbol]),
    createdUtc: /** @type {string} */ (r[iCreated]),
    mintMs: Date.parse(/** @type {string} */ (r[iCreated])),
    graduated: r[iGraduated] === '1',
  }));
}

/**
 * @typedef {object} WindowTape
 * @property {import('./trades.mjs').Fill[]} fills Ascending by `sid`, as committed.
 * @property {boolean} reachedMint Coverage, from the sidecar. **Not** file existence.
 * @property {number | null} createdTimestamp The builder's own record of the mint instant, in ms.
 * @property {number | null} createSlot The oldest slot the covered window reaches.
 */

/**
 * Read one committed 60-second window tape, if it exists.
 *
 * Serves two jobs in this collector: it brackets the migration for free on the eighteen launches
 * that bonded inside their own window, and its create slot is a free cross-check on the oldest end
 * of every life walk — the one end a backwards walk can silently fail to reach.
 *
 * @param {string} mint
 * @param {string} [dir]
 * @returns {WindowTape | null}
 */
export function readWindowTape(mint, dir = TAPE_DIR) {
  const gz = join(dir, 'window', `${mint}.jsonl.gz`);
  const metaPath = join(dir, 'window', `${mint}.meta.json`);
  if (!existsSync(gz)) return null;

  let reachedMint = false;
  /** @type {number | null} */
  let createdTimestamp = null;
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    reachedMint = meta.reached_mint === true;
    if (typeof meta.created_timestamp === 'number') createdTimestamp = meta.created_timestamp;
  }

  /** @type {import('./trades.mjs').Fill[]} */
  const fills = [];
  for (const line of gunzipSync(readFileSync(gz)).toString('utf8').split('\n')) {
    if (line === '') continue;
    const r = JSON.parse(line);
    fills.push({
      slot: typeof r.slot === 'number' ? r.slot : slotOf(r.sid),
      sid: r.sid,
      tx: r.tx,
      ts: r.ts,
      tsMs: Date.parse(r.ts),
      u: r.u,
      k: r.k,
      p: r.p,
      sol: String(r.sol ?? ''),
      base: String(r.base ?? ''),
      psol: String(r.psol ?? ''),
      pusd: String(r.pusd ?? ''),
    });
  }

  // Only a *covered* window's oldest slot is the create slot. On a truncated one it is merely the
  // oldest the builder's backwards walk happened to reach, which is the precise mistake that would
  // crown a mid-window sniper as the deployer.
  let createSlot = null;
  if (reachedMint && fills.length > 0) {
    createSlot = Infinity;
    for (const f of fills) if (f.slot < createSlot) createSlot = f.slot;
  }

  return { fills, reachedMint, createdTimestamp, createSlot };
}
