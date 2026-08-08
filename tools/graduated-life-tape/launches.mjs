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

import { POPULATION_TAPE, POPULATION_TAPE_DIR, requireDataset } from '../../config/data-root.mjs';
import { slotOf } from './trades.mjs';

/**
 * The committed primary record. Never reformatted, re-sorted or "cleaned" — read only.
 *
 * **Where it lives is `config/data-root.mjs`'s answer, not this tool's**: the tapes are not in
 * this tree, and it defaults to the store at `~/slot-zero-data` and moves with
 * `SLOT_ZERO_DATA_ROOT`.
 */
export const TAPE_DIR = POPULATION_TAPE_DIR;

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
 * Escape one CSV field the way {@link parseCsv} reads it back.
 *
 * Lives beside the parser because the two are one contract: a writer that does not quote what the
 * reader unquotes produces a file whose columns shift silently, which is the same corruption
 * {@link parseCsv} exists to refuse on the way in.
 *
 * @param {string | number} value
 * @returns {string}
 */
export function csvField(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

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
 * @typedef {object} WindowMeta
 * @property {boolean} reachedMint Coverage, from the sidecar. **Not** file existence.
 * @property {number | null} createdTimestamp The builder's own record of the mint instant, in ms.
 * @property {number} windowMs The width of the window THIS launch was actually collected over.
 */

/**
 * The committed sidecar of one window tape.
 *
 * `windowMs` is the field a caller reaches for most often and the one most easily assumed: the
 * committed tape's window is **not** a constant. Across the 103 graduated launches it is 60 s on
 * 83, 120 s on 3 and 300 s on 17, so a baseline that hardcodes 60 s is measuring a window 20 of
 * those launches never had. There is no default to invent — every launch in the tape carries the
 * sidecar, and a missing one is an error rather than an assumption.
 *
 * @param {string} mint
 * @param {string} [dir]
 * @returns {WindowMeta}
 */
export function readWindowMeta(mint, dir = TAPE_DIR) {
  const path = join(dir, 'window', `${mint}.meta.json`);
  if (!existsSync(path)) throw new Error(`${mint} has no committed window sidecar at ${path}`);
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof meta.window_ms !== 'number' || !Number.isFinite(meta.window_ms) || meta.window_ms <= 0) {
    throw new Error(`${mint}'s window sidecar has no usable window_ms`);
  }
  return {
    reachedMint: meta.reached_mint === true,
    createdTimestamp: typeof meta.created_timestamp === 'number' ? meta.created_timestamp : null,
    windowMs: meta.window_ms,
  };
}

/**
 * @typedef {object} WindowTape
 * @property {import('./trades.mjs').Fill[]} fills Ascending by `sid`, as committed.
 * @property {boolean} reachedMint Coverage, from the sidecar. **Not** file existence.
 * @property {number | null} createdTimestamp The builder's own record of the mint instant, in ms.
 * @property {number | null} windowMs This launch's own committed window width, from the sidecar.
 * @property {number | null} createSlot The oldest slot the covered window reaches.
 */

/**
 * Read one committed window tape, if it exists.
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
  /** @type {number | null} */
  let windowMs = null;
  if (existsSync(metaPath)) {
    const meta = readWindowMeta(mint, dir);
    reachedMint = meta.reachedMint;
    createdTimestamp = meta.createdTimestamp;
    windowMs = meta.windowMs;
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

  return { fills, reachedMint, createdTimestamp, windowMs, createSlot };
}
