/**
 * Reading the committed population tape from disk, and the CSV primitives the rest of this tool
 * shares. No network, no credential.
 *
 * The tape is read for exactly two jobs, both of them checks rather than inputs to the series:
 *
 * - **The clock pre-flight** (`preflight.mjs`) needs launches whose create slot and vendor creation
 *   instant are both already established, so the two clocks can be compared without spending a walk.
 * - **The reproduction test** drives this tool's own series and segmentation over the committed tape
 *   and requires the published answer back — one window, 2026-03-12 to 2026-06-04.
 *
 * Two rules of the dataset are enforced here rather than trusted:
 *
 * - **Key on `mint`, never on `symbol`.** Two launches in this tape are called `maxxing`, and one of
 *   them is the operator's best result ever.
 * - **A `window/*.jsonl.gz` existing does not mean the window was covered.** Coverage is the
 *   sidecar's `reached_mint`, and four of the 239 files are truncated at their oldest end.
 *
 * The CSV is parsed here rather than by importing `src/`, for the reason both existing tools give:
 * this is plain `.mjs` on the Node 20 floor with no build step, and the `src/`↔`tools/` boundary is
 * asserted in both directions.
 */

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { POPULATION_TAPE, POPULATION_TAPE_DIR, requireDataset } from '../../config/data-root.mjs';
import { slotOf } from './trades.mjs';

/**
 * The committed primary record. Never reformatted, re-sorted or "cleaned" — read only.
 *
 * **Where it lives is `config/data-root.mjs`'s answer, not this tool's**: it defaults to the copy in
 * this repository and moves with `SLOT_ZERO_DATA_ROOT`.
 */
export const TAPE_DIR = POPULATION_TAPE_DIR;

/**
 * Parse RFC-4180 CSV, honouring quoted fields.
 *
 * Hand-rolled rather than split-on-comma because `launches.csv` holds token names and at least one
 * contains a comma — a naive split silently shifts every later column of that row, and the column it
 * shifts into `graduated` is a boolean, so the corruption is a plausible value rather than an
 * obvious one. Dune's own CSV export quotes the same way, and `cohort.mjs` reads it with this.
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
 * Escape one CSV field the way {@link parseCsv} reads it back.
 *
 * @param {string | number} value
 * @returns {string}
 */
export function csvField(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Turn a parsed CSV into records keyed by the header row.
 *
 * @param {readonly string[][]} rows
 * @returns {Record<string, string>[]}
 */
export function csvRecords(rows) {
  const header = rows[0];
  if (header === undefined) return [];
  return rows.slice(1).map((cells) => {
    /** @type {Record<string, string>} */
    const out = {};
    header.forEach((name, i) => {
      out[name] = cells[i] ?? '';
    });
    return out;
  });
}

/**
 * @typedef {object} LaunchRow
 * @property {string} mint
 * @property {string} symbol
 * @property {string} createdUtc
 * @property {number} mintMs   The VENDOR's creation instant, from `created_utc`.
 * @property {boolean} graduated
 */

/**
 * Every launch in the committed tape, in the file's own order.
 *
 * @param {string} [dir]
 * @returns {LaunchRow[]}
 */
export function readLaunches(dir = TAPE_DIR) {
  // The tool's first read of the tape, and so where an absent dataset is named as one.
  const rows = parseCsv(readFileSync(join(requireDataset(POPULATION_TAPE, dir), 'launches.csv'), 'utf8'));
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
 * @property {number | null} createdTimestamp The builder's record of the mint instant, in ms —
 *   the VENDOR's clock, which is the half of the pre-flight's comparison this repo already holds.
 * @property {number | null} windowMs This launch's own committed window width. **Not a constant**:
 *   60 s on 210 of the 239, 120 s on 4 and 300 s on 25.
 * @property {number | null} createSlot The oldest slot a *covered* window reaches.
 */

/**
 * Read one committed window tape, if it exists.
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
  /** @type {number | null} */
  let windowMs = null;
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    reachedMint = meta.reached_mint === true;
    createdTimestamp = typeof meta.created_timestamp === 'number' ? meta.created_timestamp : null;
    windowMs = typeof meta.window_ms === 'number' && meta.window_ms > 0 ? meta.window_ms : null;
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
  // oldest the builder's backwards walk happened to reach.
  let createSlot = null;
  if (reachedMint && fills.length > 0) {
    createSlot = Infinity;
    for (const f of fills) if (f.slot < createSlot) createSlot = f.slot;
  }

  return { fills, reachedMint, createdTimestamp, windowMs, createSlot };
}
