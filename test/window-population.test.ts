import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  WINDOW_CLOSE,
  WINDOW_OPEN,
  changepoints,
  closeDetectionLatency,
  median,
  perLaunchSeries,
  percentile,
  rankSumZ,
  regimeOf,
  regimeStats,
  runsAboveThreshold,
  unitLedger,
  type LaunchRow,
} from '../analysis/window-population/measure.mjs';

let series: LaunchRow[];
let measurable: LaunchRow[];
beforeAll(() => {
  series = perLaunchSeries();
  measurable = series.filter((r) => r.trips > 0);
});

describe('the boundaries are found blind, not assumed', () => {
  it('binary segmentation on return per SOL finds exactly the two dates the report names', () => {
    // The procedure is given the series and nothing else — no candidate dates, no thresholds
    // on the level. That is what makes "one window" a measurement rather than a definition.
    const breaks = changepoints(measurable.map((r) => r.gross / r.stake));
    expect(breaks.length).toBe(2);
    const dates = breaks.map((b) => measurable[b.index]?.date.slice(0, 10));
    expect(dates).toEqual([WINDOW_OPEN, WINDOW_CLOSE]);
    for (const b of breaks) expect(b.z).toBeGreaterThan(4);
  });

  it('the same two dates fall out of the prize in SOL, plus one break inside the closed regime', () => {
    const breaks = changepoints(measurable.map((r) => r.gross));
    const dates = breaks.map((b) => measurable[b.index]?.date.slice(0, 10));
    expect(dates.slice(0, 2)).toEqual([WINDOW_OPEN, WINDOW_CLOSE]);
    // The third is a partial recovery *within* the closed regime — 2026-06-22, still a third
    // of the open window's prize. It is not a re-open; see README.md §4.
    expect(dates[2]).toBe('2026-06-22');
    const after = measurable.filter((r) => regimeOf(r.date) === 'after' && r.date >= '2026-06-22');
    expect(median(after.map((r) => r.gross))).toBeLessThan(2);
  });

  it('the open window is one regime, not several back to back', () => {
    // The strongest internal split is well under the |z| = 4 the two real breaks clear.
    for (const pick of [(r: LaunchRow) => r.gross / r.stake, (r: LaunchRow) => r.gross]) {
      const inside = measurable.filter((r) => regimeOf(r.date) === 'open').map(pick);
      let best = 0;
      for (let k = 8; k <= inside.length - 8; k++) best = Math.max(best, Math.abs(rankSumZ(inside, k)));
      expect(best).toBeLessThan(4);
    }
  });

  it('counting runs above a bar instead manufactures windows — the answer moves with the bar', () => {
    // This is the trap the report exists to avoid. Same series, same code, seven "windows" at
    // one bar and two at another, and at the loosest bar the second "window" is the period the
    // strategy demonstrably does not pay.
    const roi = measurable.map((r) => r.gross / r.stake);
    const counts = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3].map((t) => runsAboveThreshold(roi, t).length);
    expect(counts).toEqual([2, 3, 7, 5, 6, 4]);
    expect(Math.max(...counts) - Math.min(...counts)).toBeGreaterThanOrEqual(5);
  });
});

describe('the one window, measured', () => {
  it('spans 2026-03-12 to 2026-06-03 — 83 days, 129 launches', () => {
    const open = series.filter((r) => regimeOf(r.date) === 'open');
    expect(open.length).toBe(129);
    expect(open[0]?.date.slice(0, 10)).toBe('2026-03-12');
    expect(open[open.length - 1]?.date.slice(0, 10)).toBe('2026-06-03');
    const days =
      (Date.parse(open[open.length - 1]?.date ?? '') - Date.parse(open[0]?.date ?? '')) / 86_400_000;
    expect(days).toBeCloseTo(82.7, 1);
  });

  it('the tape observes both ends: 91 days of no window before it, 54 days of none after', () => {
    // Neither end is censored, which is why the duration is a measurement and not a lower bound.
    const before = series.filter((r) => regimeOf(r.date) === 'before');
    const after = series.filter((r) => regimeOf(r.date) === 'after');
    expect(before.length).toBe(17);
    expect(after.length).toBe(93);
    expect(before[0]?.date.slice(0, 10)).toBe('2025-12-01');
    expect(after[after.length - 1]?.date.slice(0, 10)).toBe('2026-07-28');
  });

  it('the prize distribution steps up and back down by an order of magnitude', () => {
    const [before, open, after] = (['before', 'open', 'after'] as const).map((r) =>
      regimeStats(series, r),
    );
    expect(before?.prizeQuantiles.p50).toBeCloseTo(-0.01, 2);
    expect(open?.prizeQuantiles.p50).toBeCloseTo(5.3, 1);
    expect(after?.prizeQuantiles.p50).toBeCloseTo(1.38, 2);
    expect(before?.roiQuantiles.p50).toBeCloseTo(-0.002, 3);
    expect(open?.roiQuantiles.p50).toBeCloseTo(0.341, 3);
    expect(after?.roiQuantiles.p50).toBeCloseTo(0.138, 3);
    // Gross, so an upper bound on what anyone kept: 591.7 SOL over the whole window.
    expect(open?.gross).toBeCloseTo(591.7, 1);
  });

  it('reproduces the June report’s +46.94 SOL closed-regime prize from a second direction', () => {
    // slot-zero-june-regime-change §6.5 built this from the same file by a different route.
    // Every closed-regime launch with a closed round trip is fully priced, so this is measured.
    const after = regimeStats(series, 'after');
    expect(after.pricedLaunches).toBe(after.measurable);
    expect(after.pricedNet).toBeCloseTo(46.9, 1);
  });

  it('the open window is priced on-chain for only 30 of its 102 measurable launches', () => {
    // The coverage limit that keeps the window's net total an estimate, not a measurement.
    const open = regimeStats(series, 'open');
    expect(open.measurable).toBe(102);
    expect(open.pricedLaunches).toBe(30);
    expect(open.pricedNet / open.pricedGross).toBeCloseTo(0.54, 2);
  });

  it('the operation’s share of the bottom of the curve tracks both transitions', () => {
    // The June report established this indicator on the close alone. It also separates the
    // open, which is a second, independent transition it did not have.
    const [before, open, after] = (['before', 'open', 'after'] as const).map((r) =>
      regimeStats(series, r),
    );
    expect(before?.shareQuantiles.p50).toBeCloseTo(0.773, 2);
    expect(open?.shareQuantiles.p50).toBeCloseTo(0.413, 2);
    expect(after?.shareQuantiles.p50).toBeCloseTo(0.771, 2);
  });
});

describe('how fast it closed, and who it closed on', () => {
  it('the regime changes between two consecutive launches 24.7 hours apart', () => {
    const last = series.filter((r) => regimeOf(r.date) === 'open').at(-1);
    const first = series.filter((r) => regimeOf(r.date) === 'after')[0];
    expect(last?.symbol).toBe('Banknote');
    expect(first?.symbol).toBe('Peque');
    const hours = (Date.parse(first?.date ?? '') - Date.parse(last?.date ?? '')) / 3_600_000;
    expect(hours).toBeCloseTo(24.7, 1);
  });

  it('a participant needed 2–3 days to tell the close from ordinary variance', () => {
    // Alarm levels are the open window's own 1-in-20 trailing median, so these latencies come
    // with a stated false-alarm rate rather than a threshold chosen after the fact.
    const [k1, k3, k5, k7] = closeDetectionLatency(series);
    expect(k1?.launchesAfterBreak).toBe(0); // and a single launch tells you nothing: see below
    expect(k3?.daysAfterBreak).toBeCloseTo(2.0, 1);
    expect(k5?.daysAfterBreak).toBeCloseTo(2.4, 1);
    expect(k7?.daysAfterBreak).toBeCloseTo(3.1, 1);
    // The k=1 alarm level is 0.000 — one launch below zero happens inside the open window too,
    // so the zero-latency reading is a false-alarm-prone one, not an early warning.
    expect(k1?.alarm).toBeCloseTo(0, 3);
  });

  it('every unit that can be tested fell at the same date — the closes are not staggered', () => {
    // If per-participant windows were independent, they would end on their own dates. Only
    // three units traded the create slot often enough on both sides to be testable, and all
    // three collapse across the same break.
    const spanning = unitLedger().filter((u) => u.open.trips >= 8 && u.after.trips >= 8);
    expect(spanning.length).toBe(3);
    for (const u of spanning) {
      expect(u.open.gross / u.open.stake).toBeGreaterThan(u.after.gross / u.after.stake);
    }
  });

  it('two units took 73% of the window — concurrency of earners was 2, not many', () => {
    const ranked = unitLedger()
      .filter((u) => u.open.trips > 0)
      .sort((a, b) => b.open.gross - a.open.gross);
    const total = ranked.reduce((a, u) => a + u.open.gross, 0);
    expect(ranked.length).toBe(186);
    expect(((ranked[0]?.open.gross ?? 0) + (ranked[1]?.open.gross ?? 0)) / total).toBeCloseTo(0.73, 2);
    expect(ranked.filter((u) => u.open.gross >= 5).length).toBe(11);
  });
});

describe('what the tape cannot answer', () => {
  it('the control carries 70 deployers, one launch each, and so holds zero window observations', () => {
    // Concurrency of windows needs at least two deployers with history. The control has none:
    // one launch per creator, no dates, no P&L. This asserts the shape of that gap so a later
    // reader does not mistake 70 rows for 70 observations.
    const control = readFileSync(
      fileURLToPath(new URL('../data/population-tape-2026-07-29/control_create_slot.csv', import.meta.url)),
      'utf8',
    ).trim().split('\n');
    expect(control.length - 1).toBe(70);
    const header = control[0]?.split(',') ?? [];
    expect(header).not.toContain('created_utc');
    expect(header).not.toContain('pnl_sol');
    const creators = new Set(control.slice(1).map((l) => l.split(',')[1]));
    expect(creators.size).toBe(70); // one launch each: no creator appears twice
  });

  it('every launch in the tape is the same one deployer', () => {
    // The population of deployers this measurement is drawn from is n = 1.
    const rows = readFileSync(
      fileURLToPath(new URL('../data/population-tape-2026-07-29/launch_universe.jsonl', import.meta.url)),
      'utf8',
    ).trim().split('\n');
    expect(rows.length).toBe(239);
    const creators = rows.map((line) => String(JSON.parse(line).creator));
    const subject = creators.filter((c) => c === '7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL');
    expect(subject.length).toBe(238);
    // The 239th is `maxxing`, whose on-chain creator record moved — the trap AGENTS.md records,
    // and the reason a creator's listed history is a lower bound. It is still this operation's
    // launch, and it is still one deployer.
    expect(new Set(creators).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------

const ANALYSIS_DIR = fileURLToPath(new URL('../analysis/', import.meta.url));

function readAll(dir: string, prefix: string, pattern = /\.(ts|mjs|js|md|json)$/): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const [k, v] of readAll(full, `${prefix}${entry}/`, pattern)) out.set(k, v);
    } else if (pattern.test(entry)) {
      out.set(`${prefix}${entry}`, readFileSync(full, 'utf8'));
    }
  }
  return out;
}

describe('analysis/ reaches no network and reads no credential', () => {
  // The brief for this measurement was "local tape only, no vendor spend at all". That is a
  // property of the code, so it is asserted like one — the same scan test/loader.test.ts runs
  // over src/. tools/deployer-screen/ remains the only network-capable area in the repo.
  it('no socket, no credential, no key-shaped string', () => {
    const all = readAll(ANALYSIS_DIR, 'analysis/');
    expect(all.size).toBeGreaterThan(0);
    expect([...all.keys()]).toContain('analysis/window-population/measure.mjs');
    expect([...all.keys()]).toContain('analysis/window-population/README.md');
    for (const [file, text] of all) {
      expect(/\bfetch\s*\(/.test(text), `${file} must not call fetch`).toBe(false);
      expect(/require\(['"]node:(https?|net|dgram|tls)['"]\)|from ['"]node:(https?|net|dgram|tls)['"]/.test(text), `${file} must not open a socket`).toBe(false);
      expect(/process\.env/.test(text), `${file} must not read the environment`).toBe(false);
      expect(/msk_[A-Za-z0-9_-]{20,}/.test(text), `${file} may contain a real key`).toBe(false);
    }
  });

  it('it does not import the keyed tool, and the keyed tool does not import it', () => {
    for (const [file, text] of readAll(ANALYSIS_DIR, 'analysis/', /\.(ts|mjs|js)$/)) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
    for (const [file, text] of readAll(
      fileURLToPath(new URL('../tools/', import.meta.url)),
      'tools/',
      /\.(ts|mjs|js)$/,
    )) {
      expect(text, `${file} must not import from analysis/`).not.toMatch(/from\s+['"].*analysis\//);
    }
  });
});

describe('the statistics behave', () => {
  it('the rank-sum statistic is zero on an exchangeable series and large on a step', () => {
    const flat = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1 : 2));
    expect(Math.abs(rankSumZ(flat, 30))).toBeLessThan(1);
    const step = [...Array.from({ length: 30 }, () => 1), ...Array.from({ length: 30 }, () => 2)];
    expect(Math.abs(rankSumZ(step, 30))).toBeGreaterThan(6);
    expect(rankSumZ(step, 2)).toBe(0); // below the minimum segment length
  });

  it('percentile interpolates linearly, the convention the dataset publishes against', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(median([3, 1, 2])).toBe(2);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});
