/**
 * The oversized split — captain decision 196a, 2026-08-04.
 *
 * `CREATION_SQL`'s per-deployer cap refuses **604 of the 3,036 wallets in the 2026-07 creation
 * census (19.9%)**, and the refusal is biased towards the LARGEST histories — the wallets most worth
 * finding (`slot-zero-census-wallet-gate-validation` → `report.md`, finding 2, held in firstmate's
 * records, not in this repo). The captain chose a
 * split over a bigger cap: raising the cap trades one arbitrary bound for another and leaves the bias
 * where it was, while re-asking for the truncated wallets in their own, smaller execution removes it
 * at its cause — the cap is a function of BATCH SIZE.
 *
 * These tests pin the two things that make that safe rather than merely cheaper:
 *
 * 1. **A planned group can never be truncated by the cap it plans against.** If it could, the split
 *    would spend a billed execution to produce a second prefix — the same confident-wrong-answer
 *    shape, arriving one layer down.
 * 2. **What the split does NOT reach is counted and named**, never inferred from the wallets that
 *    came back. The blackout has a second cause (a wallet whose newest launch post-dates the cached
 *    coverage probe) that this change cannot touch, and a run that read the recovery alone would
 *    report a closed blackout that is not closed.
 *
 * The live measurement over the census population is `tools/creation-census/OVERSIZED-SPLIT.md`, with
 * its evidence in `tools/creation-census/runs/2026-08-04-oversized-split.json`. Everything here is
 * offline: no test constructs a client that can reach the network.
 */

import { describe, expect, it } from 'vitest';

import { clearedAllowance, isUsagePath, usageResponseBody } from './dune-lane-budget-fixture.js';

import { DuneClient } from '../tools/deployer-screen/client.mjs';
import {
  CREATION_SQL,
  COVERAGE_SQL,
  LAUNCH_CAP_FLOOR,
  OVERSIZED_SPLIT,
  SQL_ROW_CEILING,
  enumerateCreations,
  launchCapPerWallet,
  planOversizedSplit,
} from '../tools/deployer-screen/dune.mjs';

const NOW_MS = Date.parse('2026-08-04T00:00:00.000Z');
const KEY = 'x'.repeat(32);
const BOUNDS = {
  pollIntervalMs: 0,
  maxPollAttempts: 3,
  maxResultRows: 20_000,
  maxCoverageLagMs: 6 * 3_600_000,
  // THE REAL PINS, so every authorisation below is priced the way a live run's is. They are
  // REQUIRED by `enumerateCreations` rather than defaulted, because the lane budget's ceiling comes
  // from the cleared plan's own pins: an authorisation priced without them is cheaper than the plan
  // reserved for it, and this suite would then exercise a budget no run ever gets.
  worstCaseCreditsPerExecution: 200,
  resultBytesPerRowCeiling: 121,
};

// A cleared monthly credit allowance, so these fixtures exercise the split rather than the credit
// guard in front of it. `enumerateCreations` refuses outright without one; test/dune-credit-ceiling
// .test.ts owns that behaviour.
// The pre-flight verdict these runs were ADMITTED on. Its `worstCaseCredits` is what the lane
// budget's stop is taken from (captain decision 437(a)), so it is sized here for the several
// executions the split issues rather than left at a token 1 — a ceiling under one execution's
// engine-floored price refuses the split's very first follow-up, which is the budget working and
// not this suite's subject.
const ALLOWANCE_CLEARED = clearedAllowance({ creditsIncluded: 2500, creditsIncludedVendor: 2500 });

/**
 * A base58-shaped address, so nothing is dropped by `WALLET_SHAPE` before it can be measured. The
 * alphabet excludes `0`, `O`, `I` and `l`, which is why this is built rather than templated from a
 * number — a wallet failing the shape check never reaches the query at all and would silently pass
 * these tests for the wrong reason.
 */
const wallet = (n: number) =>
  `W${'abcdefghijkmnopqrstuvwxyz'[n % 25]}${'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(n / 25) % 24]}${'q'.repeat(41)}`;

function months(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const from = fromIso.split('-').map(Number) as [number, number];
  const to = toIso.split('-').map(Number) as [number, number];
  for (let y = from[0], m = from[1]; y < to[0] || (y === to[0] && m <= to[1]); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01 00:00:00.000 UTC`);
  }
  return out;
}

function probeRows(): unknown[] {
  const rows: unknown[] = [];
  for (const [tbl, first, from] of [
    ['evt_createevent', '2024-04-26 09:55:52.000 UTC', '2024-04'],
    ['call_create', '2024-01-14 12:57:12.000 UTC', '2024-01'],
  ] as const) {
    rows.push({ tbl, metric: 'first_row', at: first, n: 1_000_000 });
    rows.push({ tbl, metric: 'last_row', at: '2026-08-03 23:00:00.000 UTC', n: 1_000_000 });
    for (const at of months(from, '2026-08')) rows.push({ tbl, metric: 'month', at, n: 10 });
  }
  return rows;
}

function resultBody(rows: unknown[]): Response {
  return new Response(
    JSON.stringify({
      execution_ended_at: '2026-08-03T23:30:00.000000Z',
      result: { rows, metadata: { total_row_count: rows.length, total_result_set_bytes: rows.length * 105 } },
    }),
    { status: 200 },
  );
}

/** `count` launch rows for `w`, every one declaring `total` as the wallet's true history. */
function launchRows(w: string, count: number, total: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    deployer: w,
    mint: `${w}-mint-${i}`,
    created_at: '2026-05-01 00:00:00.000 UTC',
    bonded: i % 5 === 0,
    launches_total: total,
  }));
}

/**
 * A fetch stub that answers the coverage probe from cache and hands each `/query/{id}/execute` its
 * own execution id, so a run's Nth execution can return different rows from its first — which is the
 * whole shape of the split and is exactly what a single shared stub cannot express.
 */
function stub(perExecution: (unknown[] | 'fail')[]) {
  let executions = 0;
  const asked: string[][] = [];
  const impl = async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    // The lane budget re-reads the live balance before EVERY execution (captain decision 437(a)), so
    // a stub that did not answer this would make the balance unreadable and the lane would refuse.
    // That refusal has its own test; here it would only hide what this suite is about.
    if (isUsagePath(path)) return new Response(JSON.stringify(usageResponseBody()), { status: 200 });
    if (path.includes('/query/2/results')) return resultBody(probeRows());
    if (path.endsWith('/query/2')) return new Response(JSON.stringify({ query_sql: COVERAGE_SQL }), { status: 200 });
    if (path.endsWith('/query/1')) return new Response(JSON.stringify({ query_sql: CREATION_SQL }), { status: 200 });
    if (path.includes('/query/1/execute')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      asked.push(String(body.query_parameters?.deployers ?? '').split(',').filter(Boolean));
      executions += 1;
      return new Response(JSON.stringify({ execution_id: `e${executions}` }), { status: 200 });
    }
    const m = /\/execution\/e(\d+)\//.exec(path);
    if (m !== null) {
      const planned = perExecution[Number(m[1]) - 1];
      if (path.includes('/status')) {
        return new Response(
          JSON.stringify({ state: planned === 'fail' ? 'QUERY_STATE_FAILED' : 'QUERY_STATE_COMPLETED' }),
          { status: 200 },
        );
      }
      return resultBody(planned === 'fail' || planned === undefined ? [] : planned);
    }
    return new Response('not found', { status: 404 });
  };
  return { impl, asked };
}

function client(impl: (url: unknown, init?: RequestInit) => Promise<Response>, maxExecutions = 4) {
  return new DuneClient({
    key: KEY,
    maxExecutions,
    maxRequests: 100,
    minIntervalMs: 0,
    fetchImpl: impl as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
}

describe('planOversizedSplit — the packing, which must never produce a second prefix', () => {
  it('never seats a wallet in a group whose own cap would truncate it', () => {
    // The load-bearing property. A group of k wallets is executed under
    // launchCapPerWallet(k), so seating a 6,694-launch wallet beside six others would hand it a
    // 2,857-row cap and buy a billed execution for another truncated prefix.
    const sizes = [6694, 5979, 2618, 1178, 1126, 899, 717, 692, 653, 501, 500, 12_000, 19_999];
    const plan = planOversizedSplit({
      wallets: sizes.map((n, i) => ({ wallet: wallet(i), declaredLaunches: n })),
      maxExecutions: 99,
    });
    const declared = new Map(sizes.map((n, i) => [wallet(i), n]));
    for (const g of plan.groups) {
      expect(g.launchCap).toBe(launchCapPerWallet(g.wallets.length));
      for (const w of g.wallets) expect(declared.get(w)!).toBeLessThanOrEqual(g.launchCap);
      expect(g.expectedRows).toBe(g.wallets.reduce((n, w) => n + declared.get(w)!, 0));
      expect(g.expectedRows).toBeLessThanOrEqual(SQL_ROW_CEILING);
    }
    // Every wallet is accounted for exactly once, seated or named — a planner that silently dropped
    // one would under-report the blackout it exists to measure.
    const seen = [...plan.groups.flatMap((g) => g.wallets), ...plan.unplaced.map((u) => u.wallet)];
    expect(seen.sort()).toEqual([...declared.keys()].sort());
  });

  it('holds that property at every batch size the cap arithmetic can produce', () => {
    for (let largest = LAUNCH_CAP_FLOOR + 1; largest <= SQL_ROW_CEILING; largest = Math.ceil(largest * 1.7)) {
      const plan = planOversizedSplit({
        wallets: Array.from({ length: 12 }, (_, i) => ({ wallet: wallet(i), declaredLaunches: largest })),
        maxExecutions: 99,
      });
      for (const g of plan.groups) expect(largest).toBeLessThanOrEqual(launchCapPerWallet(g.wallets.length));
      expect(plan.unplaced).toEqual([]);
    }
  });

  it('seats the LARGEST histories first, so a budget that binds does not reinstate the bias', () => {
    // The refusal being fixed is biased towards the largest wallets. A budget that dropped those
    // would leave the bias exactly where it was while reporting a recovery.
    const sizes = [700, 6000, 900, 3000];
    const plan = planOversizedSplit({
      wallets: sizes.map((n, i) => ({ wallet: wallet(i), declaredLaunches: n })),
      maxExecutions: 1,
    });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.wallets[0]).toBe(wallet(1)); // the 6,000-launch wallet
    expect(plan.unplaced.map((u) => u.declaredLaunches)).not.toContain(6000);
    for (const u of plan.unplaced) {
      expect(u.reason).toMatch(/budget/);
      expect(u.reason).toMatch(/largest histories are seated first/);
      expect(u.reason).toMatch(/creation walk answers for it/);
    }
  });

  it('names a wallet no execution can hold rather than planning one that would be refused', () => {
    // Above the largest result the reader accepts, no batch size helps: a batch of one is still
    // capped at 19,999 rows. That residual is permanent and belongs in a report, not in silence.
    const plan = planOversizedSplit({
      wallets: [{ wallet: wallet(1), declaredLaunches: SQL_ROW_CEILING + 1 }],
      maxExecutions: 9,
    });
    expect(plan.groups).toEqual([]);
    expect(plan.unplaced[0]!.reason).toMatch(/not seatable at ANY batch size/);
  });

  it('refuses to plan against a size it does not have, rather than assuming one', () => {
    const plan = planOversizedSplit({ wallets: [{ wallet: wallet(1), declaredLaunches: null }], maxExecutions: 9 });
    expect(plan.groups).toEqual([]);
    expect(plan.unplaced[0]!.reason).toMatch(/no size to plan a follow-up execution against/);
  });

  it('honours a tighter per-execution row budget than the reader would accept', () => {
    // `/results` pages on RESPONSE SIZE independently of our `?limit=`, and a paged read is refused
    // whole — a billed execution for no answer. An operator may buy safety with an extra execution.
    const plan = planOversizedSplit({
      wallets: [900, 800, 700, 600].map((n, i) => ({ wallet: wallet(i), declaredLaunches: n })),
      maxExecutions: 9,
      maxRowsPerExecution: 1800,
    });
    for (const g of plan.groups) expect(g.expectedRows).toBeLessThanOrEqual(1800);
    expect(plan.groups.length).toBeGreaterThan(1);
  });

  it('separates a wallet the CALLER’s tighter row budget refuses from one nothing can seat', () => {
    // Both are refused, and the reasons are not interchangeable: one is the vendor's own permanent
    // ceiling, the other is a bound this caller chose and could raise. Saying "not seatable at ANY
    // batch size" of the second would claim more than the code establishes.
    const plan = planOversizedSplit({
      wallets: [
        { wallet: wallet(1), declaredLaunches: SQL_ROW_CEILING + 1 },
        { wallet: wallet(2), declaredLaunches: 12_555 },
      ],
      maxExecutions: 9,
      maxRowsPerExecution: 8000,
    });
    expect(plan.groups).toEqual([]);
    const byWallet = new Map(plan.unplaced.map((u) => [u.wallet, u.reason]));
    expect(byWallet.get(wallet(1))!).toMatch(/not seatable at ANY batch size/);
    const tightened = byWallet.get(wallet(2))!;
    expect(tightened).not.toMatch(/not seatable at ANY batch size/);
    expect(tightened).toMatch(/12555/);
    expect(tightened).toMatch(/8000/);
    expect(tightened).toMatch(new RegExp(String(SQL_ROW_CEILING)));
    expect(tightened).toMatch(/maxOversizedRowsPerExecution/);
  });

  it('spends nothing when there is no budget, and says so per wallet', () => {
    const plan = planOversizedSplit({
      wallets: [{ wallet: wallet(1), declaredLaunches: 900 }],
      maxExecutions: 0,
    });
    expect(plan.groups).toEqual([]);
    expect(plan.rowsPlanned).toBe(0);
    expect(plan.unplaced).toHaveLength(1);
  });
});

describe('the split inside enumerateCreations', () => {
  const big = wallet(1);
  const small = wallet(2);
  const cap = LAUNCH_CAP_FLOOR;

  /** A first execution in which `big` is truncated at the floor and `small` comes back whole. */
  const pass1 = () => [...launchRows(big, cap, 1200), ...launchRows(small, 3, 3)];
  /** Pad the batch to 40 so the cap is the production 500 rather than a share-out. */
  const batch = [big, small, ...Array.from({ length: 38 }, (_, i) => wallet(i + 10))];

  it('is OPT-IN: without the flag the run is byte-for-byte what it was before decision 196a', async () => {
    // `thresholds.json` → dune.maxExecutionsPerRun pins "one execution for the enumeration, and at
    // most one more to re-execute the coverage probe … nothing else in a run may execute". A default
    // that quietly spent that reserve would contradict a pinned reason rather than change it.
    const s = stub([pass1()]);
    const c = client(s.impl);
    const e = await enumerateCreations(c, {
      wallets: batch,
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      allowance: ALLOWANCE_CLEARED,
    });
    expect(c.executions()).toBe(1);
    expect(e.walletsRefusedByLaunchCap).toBe(1);
    expect(e.oversizedSplit.attempted).toBe(false);
    expect(e.oversizedSplit.walletsTruncated).toBe(1);
    expect(e.byWallet.get(big)?.usable).toBe(false);
  });

  it('re-asks for a truncated wallet in its own execution and returns its whole history', async () => {
    const s = stub([pass1(), launchRows(big, 1200, 1200)]);
    const c = client(s.impl);
    const e = await enumerateCreations(c, {
      wallets: batch,
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      splitOversized: true,
      allowance: ALLOWANCE_CLEARED,
    });

    // The wallet that was a 500-row prefix is now a 1,200-launch history that may be gated on.
    expect(e.byWallet.get(big)?.usable).toBe(true);
    expect(e.byWallet.get(big)?.launches).toBe(1200);
    expect(e.byWallet.get(big)?.declaredLaunches).toBe(1200);
    expect(e.byWallet.get(big)?.truncatedByLaunchCap).toBe(false);
    expect(e.byWallet.get(big)?.covered.exhausted).toBe(true);
    expect(e.walletsRefusedByLaunchCap).toBe(0);

    // The follow-up asked about that wallet ALONE, which is what gives it a 19,999-row cap.
    expect(s.asked[1]).toEqual([big]);
    expect(e.oversizedSplit.groups[0]!.launchCap).toBe(launchCapPerWallet(1));
    expect(e.oversizedSplit.groups[0]!.expectedRows).toBe(1200);
    expect(e.oversizedSplit.groups[0]!.rowsReturned).toBe(1200);
    expect(e.oversizedSplit.groups[0]!.resultBytes).toBeGreaterThan(0);

    // The cost is stated rather than implied, and so is the residual.
    expect(e.oversizedSplit.executions).toBe(1);
    expect(e.oversizedSplit.walletsTruncated).toBe(1);
    expect(e.oversizedSplit.walletsRecovered).toBe(1);
    expect(e.oversizedSplit.walletsStillRefused).toBe(0);
    expect(e.oversizedSplit.note).toBe(OVERSIZED_SPLIT);
    expect(c.executions()).toBe(2);

    // Every other candidate keeps the answer the FIRST execution gave it — the split re-reads the
    // wallets it is about and nothing else.
    expect(e.byWallet.get(small)?.usable).toBe(true);
    expect(e.byWallet.get(small)?.launches).toBe(3);
  });

  it('counts a wallet the split enumerated whole but something ELSE still refuses', async () => {
    // The measured case, and the one a report must not round away: two of the nine wallets recovered
    // live came back whole and were then refused because their newest launch post-dated the cached
    // coverage probe. A recovery figure quoted alone would read as a closed blackout.
    const future = launchRows(big, 1200, 1200).map((r, i) =>
      i === 0 ? { ...(r as object), created_at: '2026-08-04 12:00:00.000 UTC' } : r,
    );
    const s = stub([pass1(), future]);
    const e = await enumerateCreations(client(s.impl), {
      wallets: batch,
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      splitOversized: true,
      allowance: ALLOWANCE_CLEARED,
    });
    expect(e.byWallet.get(big)?.launches).toBe(1200);
    expect(e.byWallet.get(big)?.usable).toBe(false);
    expect(e.byWallet.get(big)?.reasons.join(' ')).toMatch(/newer than the probed surfaces' own last row/);
    // Not the cap any more — a DIFFERENT cause, and the counts say so separately.
    expect(e.byWallet.get(big)?.truncatedByLaunchCap).toBe(false);
    expect(e.walletsRefusedByLaunchCap).toBe(0);
    expect(e.oversizedSplit.walletsRecovered).toBe(0);
    expect(e.oversizedSplit.walletsStillRefused).toBe(1);
  });

  it('spends only the execution budget the run already has, and names what it could not reach', async () => {
    // maxExecutions 1 is entirely consumed by the enumeration, so there is nothing left to split
    // with. The wallet keeps its refusal and the reason says why, rather than the run reporting a
    // split that did not happen.
    const s = stub([pass1()]);
    const c = client(s.impl, 1);
    const e = await enumerateCreations(c, {
      wallets: batch,
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      splitOversized: true,
      allowance: ALLOWANCE_CLEARED,
    });
    expect(c.executions()).toBe(1);
    expect(e.oversizedSplit.attempted).toBe(true);
    expect(e.oversizedSplit.executions).toBe(0);
    expect(e.oversizedSplit.unplaced).toHaveLength(1);
    expect(e.oversizedSplit.unplaced[0]!.reason).toMatch(/0 follow-up execution\(s\) of budget/);
    expect(e.walletsRefusedByLaunchCap).toBe(1);
  });

  it('lets a caller reserve budget with maxOversizedExecutions', async () => {
    const s = stub([pass1()]);
    const c = client(s.impl, 4);
    const e = await enumerateCreations(c, {
      wallets: batch,
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: { ...BOUNDS, maxOversizedExecutions: 0 },
      splitOversized: true,
      allowance: ALLOWANCE_CLEARED,
    });
    expect(c.executions()).toBe(1);
    expect(e.oversizedSplit.executions).toBe(0);
  });

  it('does not retry a failed follow-up execution, and does not let it cost the batch its answer', async () => {
    // A follow-up execution is billed whether or not it succeeds, exactly like the first one. It
    // refuses its own group and stops the split; nothing else in the run is made worse by it.
    const s = stub([pass1(), 'fail']);
    const c = client(s.impl);
    const e = await enumerateCreations(c, {
      wallets: batch,
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      splitOversized: true,
      allowance: ALLOWANCE_CLEARED,
    });
    expect(c.executions()).toBe(2);
    expect(e.oversizedSplit.stopped).toMatch(/stopped after 1 follow-up execution/);
    expect(e.oversizedSplit.groups[0]!.refused).toMatch(/QUERY_STATE_FAILED/);
    expect(e.oversizedSplit.walletsRecovered).toBe(0);
    expect(e.oversizedSplit.walletsStillRefused).toBe(1);
    // The batch's own reading survives intact.
    expect(e.byWallet.get(small)?.usable).toBe(true);
    expect(e.byWallet.get(big)?.usable).toBe(false);
    expect(e.walletsRefusedByLaunchCap).toBe(1);
  });

  it('names every wallet of a group the stop never issued, rather than leaving it to a count', async () => {
    // Two wallets too large to share a group, so the plan holds two follow-up executions and the
    // first one fails. The second group's wallets hold no answer of their own and nothing else in
    // the record would say so — what the split does not reach is NAMED, never inferred.
    const bigA = wallet(1);
    const bigB = wallet(2);
    const pair = [bigA, bigB, ...Array.from({ length: 38 }, (_, i) => wallet(i + 10))];
    const first = [...launchRows(bigA, cap, 12_000), ...launchRows(bigB, cap, 12_000)];
    const s = stub([first, 'fail', 'fail']);
    const c = client(s.impl);
    const e = await enumerateCreations(c, {
      wallets: pair,
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      splitOversized: true,
      allowance: ALLOWANCE_CLEARED,
    });
    expect(e.oversizedSplit.groups).toHaveLength(1);
    expect(c.executions()).toBe(2);
    expect(e.oversizedSplit.stopped).toMatch(/stopped after 1 follow-up execution/);
    // Every planned wallet is accounted for exactly once across groups plus unplaced.
    const seen = [
      ...e.oversizedSplit.groups.flatMap((g) => g.wallets),
      ...e.oversizedSplit.unplaced.map((u) => u.wallet),
    ];
    expect(seen.sort()).toEqual([bigA, bigB].sort());
    const unissued = e.oversizedSplit.unplaced.find((u) => !e.oversizedSplit.groups[0]!.wallets.includes(u.wallet))!;
    expect(unissued.declaredLaunches).toBe(12_000);
    expect(unissued.reason).toMatch(/planned but never issued/);
    expect(unissued.reason).toMatch(/billed and is never retried/);
    expect(unissued.reason).toMatch(/creation walk answers for it/);
    expect(e.oversizedSplit.walletsStillRefused).toBe(2);
  });

  it('does not spend into a first execution that could not be read at all', async () => {
    // The whole batch is already refused on an unreadable row, and a follow-up asks the same query
    // the same way. Spending a second billed execution to meet the same shape is not a recovery.
    // `big` is still truncated at the cap; the unreadable row belongs to another wallet entirely,
    // which is the realistic shape — a row that fails to parse commonly has no readable deployer.
    const bad = [...pass1(), { deployer: wallet(11), mint: 'M', created_at: 'nope', bonded: true, launches_total: 4 }];
    const s = stub([bad, launchRows(big, 1200, 1200)]);
    const c = client(s.impl);
    const e = await enumerateCreations(c, {
      wallets: batch,
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      splitOversized: true,
      allowance: ALLOWANCE_CLEARED,
    });
    expect(e.unreadableRows).toBe(1);
    expect(c.executions()).toBe(1);
    expect(e.oversizedSplit.executions).toBe(0);
    expect(e.oversizedSplit.stopped).toMatch(/was not attempted/);
  });

  it('refuses a whole follow-up execution whose rows would not parse, and no further', async () => {
    const bad = [...launchRows(big, 1199, 1200), { deployer: big, mint: 'M', created_at: 'nope', bonded: true, launches_total: 1200 }];
    const s = stub([pass1(), bad]);
    const e = await enumerateCreations(client(s.impl), {
      wallets: batch,
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      splitOversized: true,
      allowance: ALLOWANCE_CLEARED,
    });
    expect(e.byWallet.get(big)?.usable).toBe(false);
    expect(e.byWallet.get(big)?.reasons.join(' ')).toMatch(/follow-up \(oversized-split\) Dune answer could not be read/);
    expect(e.byWallet.get(small)?.usable).toBe(true);
  });
});

describe('the committed measurement is evidence, and it still agrees with itself', () => {
  const record = JSON.parse(
    new TextDecoder().decode(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').readFileSync(
        new URL('../tools/creation-census/runs/2026-08-04-oversized-split.json', import.meta.url),
      ),
    ),
  );

  it('reproduces its own before/after arithmetic', () => {
    const s = record.oversizedSplit;
    // BEFORE is derived, not re-measured: the split's eligible set IS the cap-truncated set.
    expect(record.refusalRate.before.refused).toBe(record.refusalRate.after.refused + s.walletsRecovered);
    expect(record.refusalRate.before.byLaunchCap).toBe(s.walletsTruncated);
    expect(record.refusalRate.after.byLaunchCap).toBe(0);
    expect(s.walletsRecovered + s.walletsStillRefused).toBe(s.walletsTruncated);
  });

  it('shows every follow-up execution returning exactly the rows its plan expected', () => {
    // What makes the plan exact rather than an estimate: `launches_total` is the true count, so a
    // group's expected rows and its returned rows are the same number or the answer is not whole.
    const s = record.oversizedSplit;
    expect(s.groups.length).toBe(s.executions);
    for (const g of s.groups) {
      expect(g.rowsReturned).toBe(g.expectedRows);
      expect(g.refused).toBeNull();
      expect(g.launchCap).toBe(launchCapPerWallet(g.wallets.length));
    }
    expect(s.groups.reduce((n: number, g: { rowsReturned: number }) => n + g.rowsReturned, 0)).toBe(s.rowsReturned);
  });

  it('accounts for the first execution row for row against the cap it applied', () => {
    const cap = record.pass1.launchCap;
    expect(cap).toBe(launchCapPerWallet(record.sample.n));
    expect(cap).toBe(LAUNCH_CAP_FLOOR);
    const expected = record.wallets.reduce(
      (n: number, w: { declaredLaunches: number | null }) => n + Math.min(w.declaredLaunches ?? 0, cap),
      0,
    );
    expect(record.pass1.rowsReturned).toBe(expected);
  });

  it('states what is still refused rather than implying the blackout closed', () => {
    // The one thing a reader of the after figure must not conclude. Every remaining refusal is the
    // probe-freshness class, which this change cannot touch.
    expect(record.refusalRate.after.byProbeFreshness).toBe(record.refusalRate.after.refused);
    for (const w of record.wallets.filter((x: { usable: boolean }) => !x.usable)) {
      expect(w.reasons.join(' ')).toMatch(/newer than the probed surfaces' own last row/);
    }
  });
});
