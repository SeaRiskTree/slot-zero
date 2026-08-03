#!/usr/bin/env node
/**
 * The collector: pins every graduation instant, then walks every graduated launch from its mint to
 * one hour past that instant. Keyless throughout — **zero metered provider requests**, which is the
 * whole of captain decision 112a as it reaches this lane.
 *
 * ```
 * node tools/graduated-life-tape/collect.mjs --phase graduation --out data/graduated-life-2026-08-02
 * node tools/graduated-life-tape/collect.mjs --phase life       --out data/graduated-life-2026-08-02
 * ```
 *
 * ## It checkpoints, because it runs for hours
 *
 * Every launch is written to disk the moment its own work finishes, and every phase skips launches
 * whose output already exists. An interrupted run costs the launch in flight and nothing else, and
 * re-running the command resumes. The request ledger is append-only for the same reason: it has to
 * survive the interruption that makes it worth having.
 *
 * ## Every request it issues is recorded
 *
 * `requests.csv` gets one row per **attempt**, retries and refusals included, so the run's exact
 * request count is a committed fact rather than a claim in prose. `--out` is required for a live
 * run precisely so that no run can happen without leaving that record.
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

import { KeylessClient, CeilingReached, DEFAULT_MIN_INTERVAL_MS } from './client.mjs';
import { readLaunches, readWindowTape } from './launches.mjs';
import { findGraduation } from './graduation.mjs';
import { walkLife, POST_GRADUATION_MS, MAX_PAGES_PER_LAUNCH } from './walk.mjs';

/**
 * Run ceiling for the graduation phase.
 *
 * The scout's validated bisection cost 871 requests for 90 tokens at 9.7 probes each. Eighteen of
 * our 103 are free from the committed window tape, so ~85 need probing; 1,600 leaves room for the
 * endpoint's measured ~25% shed rate without letting a pathological launch run away.
 */
export const GRADUATION_CEILING = 1_600;

/**
 * Run ceiling for the life phase.
 *
 * The scout costed this window at 10–40 pages per launch, so 103 launches is 1,000–4,000 *pages*.
 * At the endpoint's measured shed rate an attempt ceiling of 6,000 covers the top of that range;
 * against ~9,500 for the naive all-239 whole-life walk it is roughly a quarter of the cost.
 */
export const LIFE_CEILING = 6_000;

/** @param {readonly string[]} argv */
export function parseArgs(argv) {
  /** @type {{ phase: string, out: string | null, limit: number | null, minIntervalMs: number, only: string[], maxPages: number }} */
  const args = {
    phase: '',
    out: null,
    limit: null,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    only: [],
    maxPages: MAX_PAGES_PER_LAUNCH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--phase') args.phase = next();
    else if (a === '--out') args.out = next();
    else if (a === '--limit') args.limit = Number(next());
    else if (a === '--min-interval-ms') args.minIntervalMs = Number(next());
    else if (a === '--only') args.only.push(next());
    else if (a === '--max-pages') args.maxPages = Number(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.phase !== 'graduation' && args.phase !== 'life') {
    throw new Error('--phase must be "graduation" or "life"');
  }
  if (args.out === null) throw new Error('--out is required: a run that leaves no record is not reproducible');
  return args;
}

/** @param {string} message */
function say(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * @param {string} out
 * @param {string} phase
 * @returns {(event: import('./client.mjs').RequestEvent) => void}
 */
function ledger(out, phase) {
  const path = join(out, 'requests.csv');
  if (!existsSync(path)) {
    writeFileSync(path, 'phase,at_utc,mint,status,interval_ms\n');
  }
  return (event) => {
    // The URL is reduced to its mint. The full URL adds nothing a reader needs and makes the ledger
    // a list of endpoints to replay rather than a record of what this run spent.
    const mint = event.url.match(/\/coins\/([^/]+)\/trades/)?.[1] ?? '';
    appendFileSync(
      path,
      `${phase},${new Date().toISOString()},${mint},${event.status ?? 'transport'},${event.intervalMs}\n`,
    );
  };
}

/**
 * Launches this collector covers: the graduated ones, keyed by mint.
 *
 * `graduated` comes from the committed tape and is not re-litigated here. Note what that column is
 * and is not: it is a completed bonding curve, and the population it describes is one deployer's
 * 239 launches — **a floor, not the population**, because pump.fun lists by *current* creator and
 * the record moves.
 *
 * @param {string} [dir]
 */
export function graduatedLaunches(dir) {
  return readLaunches(dir).filter((l) => l.graduated);
}

/**
 * Phase one: pin the graduation instant of every graduated launch.
 *
 * @param {object} args
 * @param {string} args.out
 * @param {KeylessClient} args.client
 * @param {number | null} [args.limit]
 * @param {readonly string[]} [args.only]
 */
export async function runGraduationPhase({ out, client, limit = null, only = [] }) {
  const path = join(out, 'graduation.csv');
  const header =
    'mint,symbol,created_utc,mint_ms,graduated,grad_ms,grad_s_from_mint,lower_ms,bracket_ms,source,probes,last_trade_ms,note\n';
  if (!existsSync(path)) writeFileSync(path, header);

  const done = new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .slice(1)
      .filter((l) => l !== '')
      .map((l) => /** @type {string} */ (l.split(',')[0])),
  );

  let launches = graduatedLaunches().filter((l) => !done.has(l.mint));
  if (only.length > 0) launches = launches.filter((l) => only.includes(l.mint));
  if (limit !== null) launches = launches.slice(0, limit);
  say(`graduation phase: ${launches.length} launches to pin (${done.size} already on disk)`);

  for (const [i, launch] of launches.entries()) {
    const tape = readWindowTape(launch.mint);
    /** @type {import('./graduation.mjs').Graduation} */
    let result;
    try {
      result = await findGraduation({
        client,
        mint: launch.mint,
        mintMs: launch.mintMs,
        tapeFills: tape?.fills ?? [],
      });
    } catch (cause) {
      if (cause instanceof CeilingReached) {
        say(`graduation phase: ${cause.message} — stopping with ${done.size + i} pinned`);
        return;
      }
      throw cause;
    }

    const gradS = result.gradMs === null ? '' : ((result.gradMs - launch.mintMs) / 1000).toFixed(1);
    appendFileSync(
      path,
      [
        launch.mint,
        csvField(launch.symbol),
        launch.createdUtc,
        launch.mintMs,
        result.graduated ? 1 : 0,
        result.gradMs ?? '',
        gradS,
        result.lowerMs ?? '',
        result.bracketMs ?? '',
        result.source,
        result.probes,
        result.lastTradeMs ?? '',
        csvField(result.note ?? ''),
      ].join(',') + '\n',
    );

    say(
      `[${i + 1}/${launches.length}] ${launch.mint} ${result.source} ` +
        `grad=+${gradS || '?'}s ±${result.bracketMs ?? '?'}ms probes=${result.probes} ` +
        `issued=${client.issued()} shed=${client.shed()} interval=${client.intervalMs()}ms`,
    );
  }
  say(`graduation phase done: ${client.issued()} requests issued, ${client.shed()} shed`);
}

/**
 * Phase two: walk each graduated launch from its mint to graduation + 1 hour.
 *
 * @param {object} args
 * @param {string} args.out
 * @param {KeylessClient} args.client
 * @param {number | null} [args.limit]
 * @param {readonly string[]} [args.only]
 * @param {number} [args.maxPages] Raised only to re-walk a launch the default ceiling truncated.
 */
export async function runLifePhase({ out, client, limit = null, only = [], maxPages = MAX_PAGES_PER_LAUNCH }) {
  const lifeDir = join(out, 'life');
  mkdirSync(lifeDir, { recursive: true });

  const gradPath = join(out, 'graduation.csv');
  if (!existsSync(gradPath)) throw new Error('run --phase graduation first: the walk is bounded by its output');
  const grad = readGraduationCsv(gradPath);

  const bySymbol = new Map(graduatedLaunches().map((l) => [l.mint, l]));
  let mints = [...grad.keys()].filter((m) => !existsSync(join(lifeDir, `${m}.meta.json`)));
  if (only.length > 0) mints = mints.filter((m) => only.includes(m));
  if (limit !== null) mints = mints.slice(0, limit);
  say(`life phase: ${mints.length} launches to walk`);

  for (const [i, mint] of mints.entries()) {
    const row = /** @type {ReturnType<typeof readGraduationCsv> extends Map<string, infer V> ? V : never} */ (
      grad.get(mint)
    );
    const launch = bySymbol.get(mint);
    if (row.gradMs === null || launch === undefined) {
      say(`[${i + 1}/${mints.length}] ${mint} skipped: no graduation instant`);
      continue;
    }

    // The floor is the earlier of the vendor's mint timestamp and the oldest fill the committed
    // window tape proved it covered. Those two clocks are not the same clock, and taking the later
    // of them would clip the create slot — the one fill that identifies the deployer.
    const tape = readWindowTape(mint);
    let floorMs = launch.mintMs;
    if (tape !== null && tape.reachedMint) {
      for (const f of tape.fills) if (f.tsMs < floorMs) floorMs = f.tsMs;
    }
    const endMs = row.gradMs + POST_GRADUATION_MS;

    /** @type {import('./walk.mjs').WalkResult} */
    let result;
    try {
      result = await walkLife({ client, mint, mintMs: floorMs, endMs, maxPages });
    } catch (cause) {
      if (cause instanceof CeilingReached) {
        say(`life phase: ${cause.message} — stopping with ${i} walked this run`);
        return;
      }
      throw cause;
    }

    writeFileSync(
      join(lifeDir, `${mint}.jsonl.gz`),
      gzipSync(result.fills.map((f) => JSON.stringify(toTapeRow(f))).join('\n') + '\n'),
    );
    writeFileSync(
      join(lifeDir, `${mint}.meta.json`),
      JSON.stringify(
        {
          mint,
          symbol: launch.symbol,
          created_timestamp: launch.mintMs,
          floor_ms: floorMs,
          grad_ms: row.gradMs,
          grad_bracket_ms: row.bracketMs,
          grad_source: row.source,
          end_ms: endMs,
          window_ms: endMs - floorMs,
          n: result.fills.length,
          n_amm: result.ammFills,
          pages: result.pages,
          requests: result.requests,
          reached_mint: result.reachedMint,
          truncated: result.truncated,
          max_pages: maxPages,
          from_ms: result.fromMs,
          to_ms: result.toMs,
          oldest_slot: result.oldestSlot,
          window_tape_create_slot: tape?.createSlot ?? null,
          // A free, load-bearing cross-check. The committed window tape proved its own coverage of
          // the create slot; if this walk claims to have reached the mint it must land on the same
          // slot. Disagreement means one of the two walks is truncated, and the walk that is wrong
          // is silently wrong.
          create_slot_agrees:
            tape?.createSlot == null || !result.reachedMint ? null : tape.createSlot === result.oldestSlot,
          stop_reason: result.stopReason,
        },
        null,
        0,
      ) + '\n',
    );

    say(
      `[${i + 1}/${mints.length}] ${mint} ${result.fills.length} fills ` +
        `(${result.ammFills} amm) ${result.pages}p reached_mint=${result.reachedMint} ` +
        `issued=${client.issued()} shed=${client.shed()} interval=${client.intervalMs()}ms`,
    );
  }
  say(`life phase done: ${client.issued()} requests issued, ${client.shed()} shed`);
}

/**
 * Project a fill back onto the committed tape's row schema.
 *
 * `tsMs` is dropped: it is `Date.parse(ts)` and storing a derived field in a primary record invites
 * the two to disagree. The field order is the committed tape's, so a life file and a window file
 * concatenate.
 *
 * @param {import('./trades.mjs').Fill} f
 */
export function toTapeRow(f) {
  return {
    slot: f.slot,
    sid: f.sid,
    tx: f.tx,
    ts: f.ts,
    u: f.u,
    k: f.k,
    p: f.p,
    sol: f.sol,
    base: f.base,
    psol: f.psol,
    pusd: f.pusd,
  };
}

/**
 * @param {string} path
 * @returns {Map<string, { gradMs: number | null, bracketMs: number | null, source: string }>}
 */
export function readGraduationCsv(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const header = /** @type {string} */ (lines[0]).split(',');
  const iMint = header.indexOf('mint');
  const iGrad = header.indexOf('grad_ms');
  const iBracket = header.indexOf('bracket_ms');
  const iSource = header.indexOf('source');
  /** @type {Map<string, { gradMs: number | null, bracketMs: number | null, source: string }>} */
  const out = new Map();
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const cells = line.split(',');
    const grad = cells[iGrad];
    out.set(/** @type {string} */ (cells[iMint]), {
      gradMs: grad === undefined || grad === '' ? null : Number(grad),
      bracketMs: cells[iBracket] === '' ? null : Number(cells[iBracket]),
      source: /** @type {string} */ (cells[iSource]),
    });
  }
  return out;
}

/** @param {string} value */
function csvField(value) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/* c8 ignore start -- the CLI shell; every part it calls is exercised directly by the tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const out = /** @type {string} */ (args.out);
  mkdirSync(out, { recursive: true });
  const client = new KeylessClient({
    maxRequests: args.phase === 'graduation' ? GRADUATION_CEILING : LIFE_CEILING,
    minIntervalMs: args.minIntervalMs,
    onRequest: ledger(out, args.phase),
  });
  say(
    `phase=${args.phase} out=${out} interval floor=${args.minIntervalMs}ms ` +
      `ceiling=${client.remaining()} maxPages=${MAX_PAGES_PER_LAUNCH}`,
  );
  const run = args.phase === 'graduation' ? runGraduationPhase : runLifePhase;
  run({ out, client, limit: args.limit, only: args.only, maxPages: args.maxPages }).then(
    () => process.exit(0),
    (cause) => {
      say(`FAILED: ${cause instanceof Error ? cause.stack : String(cause)}`);
      process.exit(1);
    },
  );
}
/* c8 ignore stop */
