#!/usr/bin/env node
/**
 * Roll the collected tape up into `coverage.csv` and print the headline numbers.
 *
 * **Offline.** It opens no socket and reads only committed files, so every number the dataset
 * README publishes is reproducible by running this against the committed tape:
 *
 * ```bash
 * node tools/graduated-life-tape/summarise.mjs data/graduated-life-tape-2026-08-02
 * ```
 *
 * ## What it deliberately does not compute
 *
 * **P&L.** Every figure derivable from this fill tape is **gross of fees** and is therefore an
 * upper bound, and the trap is concrete rather than theoretical: on the deployer's own post-break
 * field, gross reads 362/473 closed round trips positive, while fee-inclusive the same population
 * made +0.54 SOL per launch with 51 of 106 wallets negative. A collection lane that published a
 * SOL figure would be publishing the wrong sign. What it publishes instead is **closure** — how
 * many (wallet, launch) pairs are complete round trips — because that is the thing the widening
 * actually changes, and it is a count rather than a quantity of money.
 *
 * Closure uses the dataset's own rule: a pair is closed when the residual is within 0.1% of the
 * tokens bought. `wallet_launch_pnl.csv` was reproduced from raw fills under that rule with zero
 * closure mismatches on 1,502 create-slot outsider pairs, so it is the population tape's rule, not
 * a new one invented here.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { readLaunches, readWindowMeta, csvField } from './launches.mjs';
import { VENUE_AMM } from './trades.mjs';

/** The dataset's own closure rule: residual within 0.1% of tokens bought. */
export const CLOSURE_TOLERANCE = 0.001;

/**
 * Closed and open (wallet, launch) pairs over a run of fills, at a cut-off.
 *
 * @param {readonly {u: string, k: string, base: string, tsMs: number}[]} fills
 * @param {number} untilMs
 * @returns {{ closed: number, open: number }}
 */
export function closureAt(fills, untilMs) {
  /** @type {Map<string, { bought: number, sold: number }>} */
  const byWallet = new Map();
  for (const f of fills) {
    if (f.tsMs > untilMs) continue;
    let acc = byWallet.get(f.u);
    if (acc === undefined) byWallet.set(f.u, (acc = { bought: 0, sold: 0 }));
    const base = Number(f.base);
    if (!Number.isFinite(base)) continue;
    if (f.k === 'buy') acc.bought += base;
    else acc.sold += base;
  }
  let closed = 0;
  let open = 0;
  for (const acc of byWallet.values()) {
    // A wallet that only ever sold has nothing this tape can call a round trip — it arrived
    // holding, from a source no fill tape records. Counted as open, never as closed at zero.
    if (acc.bought <= 0) {
      open += 1;
      continue;
    }
    if (Math.abs(acc.bought - acc.sold) <= CLOSURE_TOLERANCE * acc.bought) closed += 1;
    else open += 1;
  }
  return { closed, open };
}

/**
 * Closure **of the same wallets**, at two different window ends.
 *
 * The headline comparison has to be apples-to-apples and the obvious one is not: a longer window
 * contains far more wallets, so "47% of pairs closed at the committed window" against "78% of pairs
 * closed at graduation + 1 h" compares two different populations and flatters the widening for the
 * wrong reason. This restricts to the wallets **visible inside the launch's own committed window**
 * and asks what the wider window did for *them*. That is the population whose P&L the committed tape
 * already publishes, and therefore the population whose numbers this tape can correct.
 *
 * `earlyMs` is the caller's to supply per launch, and it must be that launch's own recorded cut —
 * the committed tape's window is 60 s on 83 of the 103 graduated launches, 120 s on 3 and 300 s on
 * 17, so a fixed 60 s baseline understates the "before" figure on a fifth of the population.
 *
 * @param {readonly {u: string, k: string, base: string, tsMs: number}[]} fills
 * @param {number} earlyMs Cut-off defining which wallets count.
 * @param {number} fullMs  Cut-off at which they are re-evaluated.
 * @returns {{ population: number, closedEarly: number, closedFull: number }}
 */
export function closureOfEarlyPairs(fills, earlyMs, fullMs) {
  const early = new Set(fills.filter((f) => f.tsMs <= earlyMs).map((f) => f.u));
  const restricted = fills.filter((f) => early.has(f.u));
  const atEarly = closureAt(restricted, earlyMs);
  const atFull = closureAt(restricted, fullMs);
  return { population: early.size, closedEarly: atEarly.closed, closedFull: atFull.closed };
}

/** @param {readonly number[]} xs @param {number} q */
export function quantile(xs, q) {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return /** @type {number} */ (sorted[lo]) + (/** @type {number} */ (sorted[hi]) - /** @type {number} */ (sorted[lo])) * (i - lo);
}

/**
 * @typedef {object} Totals
 * @property {number} launches
 * @property {number} fills
 * @property {number} ammFills
 * @property {number} reached
 * @property {number} truncated
 * @property {number} requests
 * @property {number} shed Attempts the endpoint refused with 429 or 5xx.
 * @property {number} transportFailures Attempts that never reached the endpoint at all.
 * @property {number} pagesTotal
 * @property {number} pagesMedian
 * @property {number} pagesP90
 * @property {number} gradMedianS
 * @property {number} gradP10S
 * @property {number} gradP90S
 * @property {number} bracketMedianS
 * @property {number} bracketP90S
 * @property {number} closedOld
 * @property {number} openOld
 * @property {number} closedNew
 * @property {number} openNew
 * @property {number} earlyPopulation Wallets visible inside each launch's own committed window.
 * @property {number} earlyClosedAtCommitted
 * @property {number} earlyClosedAtFull
 */

/**
 * @param {string} out
 * @returns {{ rows: Record<string, string | number>[], totals: Totals }}
 */
export function summarise(out) {
  const lifeDir = join(out, 'life');
  const symbols = new Map(readLaunches().map((l) => [l.mint, l.symbol]));

  /** @type {Record<string, string | number>[]} */
  const rows = [];
  let fills = 0;
  let ammFills = 0;
  let reached = 0;
  let truncated = 0;
  let closedNew = 0;
  let openNew = 0;
  let closedOld = 0;
  let openOld = 0;
  let earlyPopulation = 0;
  let earlyClosedAtCommitted = 0;
  let earlyClosedAtFull = 0;
  /** @type {number[]} */
  const gradS = [];
  /** @type {number[]} */
  const bracketS = [];
  /** @type {number[]} */
  const pages = [];

  for (const file of readdirSync(lifeDir).filter((f) => f.endsWith('.meta.json')).sort()) {
    const meta = JSON.parse(readFileSync(join(lifeDir, file), 'utf8'));
    /** @type {{u: string, k: string, base: string, tsMs: number, p: string}[]} */
    const launchFills = [];
    for (const line of gunzipSync(readFileSync(join(lifeDir, `${meta.mint}.jsonl.gz`)))
      .toString('utf8')
      .split('\n')) {
      if (line === '') continue;
      const r = JSON.parse(line);
      launchFills.push({ u: r.u, k: r.k, base: r.base, tsMs: Date.parse(r.ts), p: r.p });
    }

    // The comparison that justifies the whole widening: the same launch, the same closure rule,
    // cut at the window the committed tape already covers and at the one this tape adds. The
    // "before" cut is THIS launch's own recorded window, read from its committed sidecar — the
    // committed tape's window is not a constant, and a fixed cut would report a window 20 of the
    // 103 launches were never collected over.
    const committedWindowMs = readWindowMeta(meta.mint).windowMs;
    const committedEndMs = meta.floor_ms + committedWindowMs;
    const before = closureAt(launchFills, committedEndMs);
    const after = closureAt(launchFills, meta.end_ms);
    const early = closureOfEarlyPairs(launchFills, committedEndMs, meta.end_ms);

    fills += launchFills.length;
    ammFills += launchFills.filter((f) => f.p === VENUE_AMM).length;
    if (meta.reached_mint) reached += 1;
    if (meta.truncated) truncated += 1;
    closedOld += before.closed;
    openOld += before.open;
    closedNew += after.closed;
    openNew += after.open;
    earlyPopulation += early.population;
    earlyClosedAtCommitted += early.closedEarly;
    earlyClosedAtFull += early.closedFull;
    gradS.push((meta.grad_ms - meta.created_timestamp) / 1000);
    bracketS.push((meta.grad_bracket_ms ?? 0) / 1000);
    pages.push(meta.pages);

    rows.push({
      mint: meta.mint,
      symbol: symbols.get(meta.mint) ?? '',
      grad_s_from_mint: ((meta.grad_ms - meta.created_timestamp) / 1000).toFixed(1),
      grad_bracket_ms: meta.grad_bracket_ms ?? '',
      grad_source: meta.grad_source,
      window_s: Math.round(meta.window_ms / 1000),
      committed_window_s: Math.round(committedWindowMs / 1000),
      n_fills: meta.n,
      n_amm_fills: meta.n_amm,
      pages: meta.pages,
      requests: meta.requests,
      reached_mint: meta.reached_mint ? 1 : 0,
      truncated: meta.truncated ? 1 : 0,
      create_slot_agrees: meta.create_slot_agrees === null ? '' : meta.create_slot_agrees ? 1 : 0,
      pairs_closed_committed: before.closed,
      pairs_open_committed: before.open,
      pairs_closed_full: after.closed,
      pairs_open_full: after.open,
      early_pairs: early.population,
      early_closed_committed: early.closedEarly,
      early_closed_full: early.closedFull,
    });
  }

  const header = Object.keys(/** @type {Record<string, string | number>} */ (rows[0])).join(',');
  writeFileSync(
    join(out, 'coverage.csv'),
    `${header}\n${rows.map((r) => Object.values(r).map(csvField).join(',')).join('\n')}\n`,
  );

  // Shed and transport are two different facts and the client keeps them apart on purpose: a run
  // that could not reach the endpoint at all must not be reportable as a busy endpoint refusing it.
  const ledgerPath = join(out, 'requests.csv');
  const ledgerRows = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8').trim().split('\n').slice(1)
    : [];
  const statuses = ledgerRows.map((l) => l.split(',')[3]);
  const requests = ledgerRows.length;
  const shed = statuses.filter((s) => s !== 'transport' && Number(s) >= 429).length;
  const transportFailures = statuses.filter((s) => s === 'transport').length;

  return {
    rows,
    totals: {
      launches: rows.length,
      fills,
      ammFills,
      reached,
      truncated,
      requests,
      shed,
      transportFailures,
      pagesTotal: pages.reduce((a, b) => a + b, 0),
      pagesMedian: quantile(pages, 0.5),
      pagesP90: quantile(pages, 0.9),
      gradMedianS: quantile(gradS, 0.5),
      gradP10S: quantile(gradS, 0.1),
      gradP90S: quantile(gradS, 0.9),
      bracketMedianS: quantile(bracketS, 0.5),
      bracketP90S: quantile(bracketS, 0.9),
      closedOld,
      openOld,
      closedNew,
      openNew,
      earlyPopulation,
      earlyClosedAtCommitted,
      earlyClosedAtFull,
    },
  };
}

/* c8 ignore start -- the CLI shell. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (out === undefined) throw new Error('usage: summarise.mjs <dataset-dir>');
  const { totals } = summarise(out);
  const pct = (/** @type {number} */ n, /** @type {number} */ d) => ((100 * n) / d).toFixed(1);
  process.stdout.write(
    [
      `launches walked        ${totals.launches}`,
      `fills                  ${totals.fills} (${totals.ammFills} on PumpSwap)`,
      `pages                  ${totals.pagesTotal} (median ${totals.pagesMedian}, p90 ${totals.pagesP90})`,
      `requests issued        ${totals.requests} (${totals.shed} shed, ${totals.transportFailures} transport failures)`,
      `reached the mint       ${totals.reached}/${totals.launches}`,
      `truncated              ${totals.truncated}`,
      `graduation from mint   p10 ${totals.gradP10S.toFixed(0)}s  median ${totals.gradMedianS.toFixed(0)}s  p90 ${totals.gradP90S.toFixed(0)}s`,
      `graduation bracket     median ${totals.bracketMedianS.toFixed(1)}s  p90 ${totals.bracketP90S.toFixed(0)}s`,
      `all pairs closed at the committed window ${totals.closedOld}/${totals.closedOld + totals.openOld} (${pct(totals.closedOld, totals.closedOld + totals.openOld)}%)`,
      `all pairs closed at grad+1h              ${totals.closedNew}/${totals.closedNew + totals.openNew} (${pct(totals.closedNew, totals.closedNew + totals.openNew)}%)`,
      `  -- those two have DIFFERENT denominators; the like-for-like comparison is below --`,
      `wallets seen inside the committed window ${totals.earlyPopulation}`,
      `  of those, closed at that window        ${totals.earlyClosedAtCommitted} (${pct(totals.earlyClosedAtCommitted, totals.earlyPopulation)}%)`,
      `  of those, closed at grad+1h          ${totals.earlyClosedAtFull} (${pct(totals.earlyClosedAtFull, totals.earlyPopulation)}%)`,
      '',
    ].join('\n'),
  );
}
/* c8 ignore stop */
