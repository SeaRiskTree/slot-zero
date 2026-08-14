/**
 * Tests for the keyless arrival-rate walk. **Nothing here reaches the network.**
 *
 * Every fixture is synthetic — hand-written to the shape `swap-api.pump.fun` and Dune returned on
 * 2026-08-03, never a captured payload — except where a test deliberately reads the repo's own
 * committed data, which is ours and is the point.
 *
 * The `fetchImpl`, `sleepImpl` and `nowImpl` seams on `KeylessClient` exist for these tests. No test
 * constructs a client without them, so a regression that starts issuing real requests fails here
 * rather than quietly hammering a shared public endpoint for hours.
 *
 * Four kinds of assertion live here and they are not interchangeable:
 *
 * - **Boundary** — this is the repo's THIRD network-capable directory and it is keyless throughout.
 *   The scans below are what make "zero metered provider requests" a property of the tree.
 * - **One bound** — the defect `data/slot-zero-cursor-gap-walk-blast/report.md` exists about is a
 *   walk with two bounds in two units. The tests here pin that the seek instant and the membership
 *   ceiling are the same number, so the class cannot come back.
 * - **Refusal** — almost every failure mode in this lane returns a confident, complete-LOOKING wrong
 *   answer. The tests assert what is refused, not only what is computed.
 * - **Reproduction** — this tool's segmentation is run over the committed tape and required to return
 *   the published measurement: the same two break dates, the same three regimes, the same 82.7-day
 *   window. It is duplicated from `analysis/window-population/measure.mjs` by necessity, and this is
 *   what stops the two copies drifting.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { KeylessClient, CeilingReached, HttpRefused, SWAP_API, SOLANA_RPC, SWAP_MIN_INTERVAL_MS } from '../tools/arrival-rate-walk/client.mjs';
import {
  PAGE_LIMIT,
  VENUE_CURVE,
  dedupeBySid,
  parseFill,
  parseTradePage,
  provesOlderThan,
  seekCursor,
  slotOf,
  sortAscending,
  tradesUrl,
} from '../tools/arrival-rate-walk/trades.mjs';
import { walkOpeningWindow } from '../tools/arrival-rate-walk/walk.mjs';
import { parseCsv, csvRecords, readLaunches, readWindowTape, TAPE_DIR } from '../tools/arrival-rate-walk/tape.mjs';
import {
  COHORT_SQL,
  COHORT_TABLES,
  WALLET_SHAPE,
  assessCohortCoverage,
  chooseThreshold,
  parseCohortRows,
  parseDuneTimestamp,
  parseLaunchListRows,
  readDuneResultFile,
} from '../tools/arrival-rate-walk/cohort.mjs';
import {
  SECOND_RESOLUTION_MS,
  assessSkew,
  measureBlockTimeSkew,
  measureDuneClockSkew,
  readBlockTimeMs,
  selectPreflightLaunches,
} from '../tools/arrival-rate-walk/preflight.mjs';
import {
  ALL_ENTRANT_FLOOR_CAVEAT,
  GROSS_OF_FEES_CAVEAT,
  SERIES_COLUMNS,
  createSlotGroups,
  measureLaunch,
  roomIsProven,
  seriesRow,
  toSeriesPoints,
  walletTotals,
  ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT,
} from '../tools/arrival-rate-walk/series.mjs';
import type { LaunchMeasurement } from '../tools/arrival-rate-walk/series.mjs';
import {
  EXPOSURE_BASES,
  EXPOSURE_BASIS_CAVEAT,
  MARGINAL_DETECTION_CAVEAT,
  PUBLISHED_EXPOSURE_BASIS,
  UNRESOLVED_BAND,
  calendarExposure,
  changepoints,
  detectionVerdict,
  findWindows,
  formatArrivalRate,
  formatUnresolvedBreak,
  formatWindow,
  median,
  segmentation,
  summariseArrival,
} from '../tools/arrival-rate-walk/arrival.mjs';
import type { ExposureBasis, Window } from '../tools/arrival-rate-walk/arrival.mjs';
import {
  BOUNDS,
  OBSERVATION_FILE,
  OBSERVATION_SCHEMA_VERSION,
  buildPlan,
  checkpointState,
  parseArgs,
  readLaunchList,
  readObservation,
  readPersistedWindow,
  recordObservation,
  runSeries,
  runWalk,
  toTapeRow,
} from '../tools/arrival-rate-walk/collect.mjs';
import { CREDENTIAL_PATTERNS, KEY_SHAPED } from './offline-guard.js';

// ---------------------------------------------------------------------------------------------
// Fixtures

const MINT = 'FIXTUREmintaaaaaaaaaaaaaaaaaaaaaaaaaaaapump';
const DEPLOYER = '7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL';
const COHORT = new Set([
  '2CHrnc2LyagAbMaMFgthiDWh7ZZ9zT9TF8WEJf7MNE71',
  'Atgx1JXsp8pTQ9Qsi74wF5pLMVwHwyQc6jJCu84evN7c',
  '8kzFH4rgFzy4ccz97AhgqRT7Qbt7HnD5oJCDK1Sxdarb',
  'GfJA84gwT9LpeyzeckeXkCsf8vdQuA64ZYQ91xoBawvt',
  '5P8A9bGUhroskpuA4hhRbybgt37TcTz7ft5zLAh8orpn',
  '43x1zWzjVWJbQErWM78m3Acx83FFuGSQEhmgyxUrPdQs',
]);

/** `slotIndexId` for a slot and intra-slot ordinal, in the endpoint's fixed-width form. */
function sid(slot: number, ordinal = 0): string {
  return String(slot).padStart(12, '0') + String(ordinal).padStart(10, '0');
}

/** A row in the endpoint's own shape, not the tape's. */
function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    slotIndexId: sid(400_000_000),
    tx: 'tx-a',
    timestamp: '2026-04-07T13:27:14.000Z',
    userAddress: 'wallet-a',
    type: 'buy',
    program: VENUE_CURVE,
    amountSol: '1.0',
    baseAmount: '1000',
    priceSol: '0.001',
    priceUsd: '0.1',
    ...overrides,
  };
}

function pageBody(rows: Record<string, unknown>[], hasMore = true, nextCursor: string | null = 'next') {
  return { trades: rows, pagination: { hasMore, nextCursor, limit: PAGE_LIMIT } };
}

/** A client whose every response is scripted. Never touches the network. */
function scriptedClient(
  responses: Array<unknown | Error>,
  opts: { maxRequests?: number; host?: string } = {},
): { client: KeylessClient; urls: string[]; bodies: unknown[] } {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let i = 0;
  const client = new KeylessClient({
    host: opts.host ?? SWAP_API,
    maxRequests: opts.maxRequests ?? 200,
    minIntervalMs: 0,
    retryBackoffMs: [],
    sleepImpl: async () => undefined,
    nowImpl: () => 0,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      urls.push(url);
      bodies.push(init?.body === undefined ? null : JSON.parse(String(init.body)));
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return { ok: true, status: 200, json: async () => next } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  return { client, urls, bodies };
}

/** Every launch on the committed tape with its §2.1 create-slot totals — INCLUDING the zero-trip ones. */
function publishedLaunchTotals(): { mint: string; symbol: string; date: string; stake: number; gross: number; trips: number }[] {
  const launches = csvRecords(parseCsv(readFileSync(join(TAPE_DIR, 'launches.csv'), 'utf8')));
  const pairs = csvRecords(parseCsv(readFileSync(join(TAPE_DIR, 'wallet_launch_pnl.csv'), 'utf8')));
  const byMint = new Map(
    launches.map((l) => [
      l['mint'] as string,
      { mint: l['mint'] as string, symbol: l['symbol'] as string, date: l['created_utc'] as string, stake: 0, gross: 0, trips: 0 },
    ]),
  );
  for (const p of pairs) {
    const r = byMint.get(p['mint'] as string);
    if (r === undefined || p['wallet'] === DEPLOYER || COHORT.has(p['wallet'] as string)) continue;
    if (p['in_create_slot'] === '1' && p['closed_in_window'] === '1') {
      r.stake += Number(p['sol_in']);
      r.gross += Number(p['realised_sol']);
      r.trips += 1;
    }
  }
  return [...byMint.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/** The §2.1 per-launch series, built from the committed CSVs exactly as the published measurement does. */
function publishedSeries(): { mint: string; symbol: string; date: string; mintMs: number; returnPerSol: number; prizeSol: number }[] {
  return publishedLaunchTotals()
    .filter((r) => r.trips > 0)
    .map((r) => ({ mint: r.mint, symbol: r.symbol, date: r.date, mintMs: Date.parse(r.date), returnPerSol: r.gross / r.stake, prizeSol: r.gross }))
    .sort((a, b) => a.mintMs - b.mintMs);
}

/**
 * The same launches as {@link publishedLaunchTotals}, in the shape the PRODUCTION series-construction
 * path consumes — zero-trip launches included, so the exclusion is made by `toSeriesPoints` rather
 * than by this helper. That is the whole point: a reproduction proof that pre-filters its own input
 * never exercises the code that decides what enters the rank test.
 */
function publishedMeasurements(): LaunchMeasurement[] {
  return publishedLaunchTotals().map((r) => ({
    mint: r.mint,
    deployer: DEPLOYER,
    mintMs: Date.parse(r.date),
    measured: true,
    unmeasuredReason: null,
    createSlot: 0,
    deployerIsFirstBuyer: true,
    bundledTx: 1,
    maxWalletsInOneTx: 2,
    createSlotOutsiders: r.trips,
    createSlotClosedPairs: r.trips,
    createSlotStakeSol: r.stake,
    createSlotPrizeSolGrossOfFees: r.gross,
    createSlotReturnPerSolGrossOfFees: r.stake > 0 ? r.gross / r.stake : Number.NaN,
    allEntrantClosedPairsFloor: 0,
    allEntrantStakeSolFloor: 0,
    allEntrantPrizeFloorSolGrossOfFees: 0,
    allEntrantReturnPerSolFloorGrossOfFees: Number.NaN,
    fills: 0,
    wallets: 0,
    caveats: [GROSS_OF_FEES_CAVEAT, ALL_ENTRANT_FLOOR_CAVEAT],
  }));
}

// ---------------------------------------------------------------------------------------------

describe('the trade endpoint is read, never assumed', () => {
  it('derives the slot from the fixed-width slotIndexId, and agrees with the committed tape', () => {
    // Not a self-consistency check: the committed window tape stores BOTH `sid` and `slot`, written
    // by a different builder from a different code path.
    const tape = readWindowTape('13JbNUE6PUmkhda8YyfMaHqUnYYYvtq1Tgp9SJjepump');
    expect(tape).not.toBeNull();
    expect(tape!.fills.length).toBeGreaterThan(0);
    for (const f of tape!.fills) expect(slotOf(f.sid)).toBe(f.slot);
  });

  it('drops a row missing anything a caller must not invent, and counts it', () => {
    expect(parseFill(row())).not.toBeNull();
    for (const bad of [{ slotIndexId: undefined }, { userAddress: 42 }, { type: 'transfer' }, { program: null }, { timestamp: 'not a date' }]) {
      expect(parseFill(row(bad as Record<string, unknown>)), JSON.stringify(bad)).toBeNull();
    }
    const page = parseTradePage(pageBody([row(), row({ type: 'transfer' })]));
    expect(page.rawRows).toBe(2);
    expect(page.fills).toHaveLength(1);
  });

  it('tells "we do not understand the answer" from "there is nothing older"', () => {
    // Collapsing the two is what would let an unreadable body terminate a backwards walk as though
    // it had proved coverage.
    const unreadable = parseTradePage({ error: 'nope' });
    expect(unreadable.recognised).toBe(false);
    expect(provesOlderThan(unreadable, 0)).toBe(false);

    const emptyButDone = parseTradePage(pageBody([], false, null));
    expect(emptyButDone.recognised).toBe(true);
    expect(provesOlderThan(emptyButDone, 0)).toBe(true);

    const emptyNoStatement = parseTradePage(pageBody([], true, 'more'));
    expect(provesOlderThan(emptyNoStatement, 0)).toBe(false);

    // A bare array carries no pagination, so it makes no statement about what is older.
    const bare = parseTradePage([row()]);
    expect(bare.recognised).toBe(true);
    expect(bare.hasMore).toBeNull();
    expect(provesOlderThan(bare, Date.parse('2026-04-07T13:27:14.000Z'))).toBe(false);
  });

  it('sorts by sid and dedupes by sid, because pages overlap and ts cannot order within a slot', () => {
    const a = parseFill(row({ slotIndexId: sid(10, 2) }))!;
    const b = parseFill(row({ slotIndexId: sid(10, 1) }))!;
    expect(sortAscending([a, b]).map((f) => f.sid)).toEqual([b.sid, a.sid]);
    expect(dedupeBySid([a, b, a])).toHaveLength(2);
  });

  it('builds a cursor that seeks to an instant, with the slot half pinned high', () => {
    expect(seekCursor(1_700_000_000_123)).toBe('9999999999990000000000-1700000000123');
    expect(tradesUrl(MINT, seekCursor(5))).toContain('cursor=9999999999990000000000-5');
    expect(tradesUrl(MINT)).not.toContain('cursor=');
  });
});

describe('the keyless client is bounded before it is fast', () => {
  it('refuses a URL outside its own host', async () => {
    const { client } = scriptedClient([pageBody([])]);
    await expect(client.getJson('https://evil.example/v2/coins/x/trades')).rejects.toThrow(/not under this client's host/);
  });

  it('counts every ATTEMPT against the ceiling, not every logical request', async () => {
    // A retry consumes the shared public endpoint exactly as a first try does.
    let calls = 0;
    const client = new KeylessClient({
      host: SWAP_API,
      maxRequests: 2,
      minIntervalMs: 0,
      retryBackoffMs: [1, 1, 1],
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      fetchImpl: (async () => {
        calls += 1;
        return { ok: false, status: 429, text: async () => '' } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await expect(client.getJson(`${SWAP_API}/x`)).rejects.toBeInstanceOf(CeilingReached);
    expect(calls).toBe(2);
    expect(client.issued()).toBe(2);
    expect(client.shed()).toBe(2);
  });

  it('does not retry a 4xx that is not a 429 — it is the endpoint answering our question', async () => {
    let calls = 0;
    const client = new KeylessClient({
      host: SWAP_API,
      maxRequests: 10,
      minIntervalMs: 0,
      retryBackoffMs: [1, 1],
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      fetchImpl: (async () => {
        calls += 1;
        return { ok: false, status: 400, text: async () => '' } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await expect(client.getJson(`${SWAP_API}/x`)).rejects.toBeInstanceOf(HttpRefused);
    expect(calls).toBe(1);
  });

  it('paces from the measured floor and backs off when shed', async () => {
    const client = new KeylessClient({
      host: SWAP_API,
      maxRequests: 10,
      minIntervalMs: SWAP_MIN_INTERVAL_MS,
      retryBackoffMs: [],
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      fetchImpl: (async () => ({ ok: false, status: 429, text: async () => '' }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(client.intervalMs()).toBe(SWAP_MIN_INTERVAL_MS);
    await expect(client.getJson(`${SWAP_API}/x`)).rejects.toBeInstanceOf(HttpRefused);
    expect(client.intervalMs()).toBeGreaterThan(SWAP_MIN_INTERVAL_MS);
  });

  it('posts one JSON-RPC call per request — never a batch', async () => {
    const { client, bodies } = scriptedClient([{ jsonrpc: '2.0', id: 1, result: 1 }], { host: SOLANA_RPC });
    await client.rpc('getBlockTime', [42]);
    expect(bodies[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'getBlockTime', params: [42] });
    expect(Array.isArray(bodies[0])).toBe(false);
  });
});

describe('the walk has ONE bound, in ONE unit', () => {
  const mintMs = Date.parse('2026-04-07T13:27:00.000Z');
  const windowMs = 60_000;
  const slackMs = 5_000;

  it('seeks to exactly the instant it filters on, and the two are the same number', async () => {
    // This is the whole design. readLaunchWindow seeks in MILLISECONDS and filters in SLOTS; the
    // nominal 400 ms/slot that once reconciled them was drifted past by the chain, and captain
    // decision 144a replaced it with a conversion at a measured worst-case rate (pumpfun.mjs ->
    // windowReachMs) rather than with no conversion at all. This walk has no second unit to
    // reconcile, which is why it is the shape to copy — asserted here, not promised in prose.
    const endMs = mintMs + windowMs;
    const { client, urls } = scriptedClient([
      pageBody(
        [
          row({ slotIndexId: sid(100, 9), timestamp: new Date(endMs + 1).toISOString() }),
          row({ slotIndexId: sid(100, 8), timestamp: new Date(endMs).toISOString() }),
          row({ slotIndexId: sid(100, 0), timestamp: new Date(mintMs).toISOString() }),
        ],
        false,
        null,
      ),
    ]);
    const result = await walkOpeningWindow({ client, mint: MINT, mintMs, windowMs, mintFloorSlackMs: slackMs, maxRequests: 10 });

    expect(urls[0]).toContain(`cursor=${encodeURIComponent(seekCursor(endMs))}`);
    expect(result.endMs).toBe(endMs);
    // The fill one millisecond past the bound is out; the one exactly on it is in.
    expect(result.fills.map((f) => f.tsMs)).toEqual([mintMs, endMs]);
  });

  it('keeps a create slot the two clocks disagree about, and says so', async () => {
    // A fill four seconds BEFORE the declared mint instant is what a positive clock skew looks like.
    // The zero-slack tripwire would delete it; the floor slack keeps it and preMintFills reports it.
    const { client } = scriptedClient([
      pageBody([row({ slotIndexId: sid(99, 0), timestamp: new Date(mintMs - 4_000).toISOString() })], false, null),
    ]);
    const result = await walkOpeningWindow({ client, mint: MINT, mintMs, windowMs, mintFloorSlackMs: slackMs, maxRequests: 10 });
    expect(result.fills).toHaveLength(1);
    expect(result.preMintFills).toBe(1);
    expect(result.floorMs).toBe(mintMs - slackMs);
  });

  it('never reports a create slot on a walk that did not prove coverage', async () => {
    // A truncated backwards walk returns a plausible pile of fills whose earliest slot is merely the
    // earliest it saw. Reading that as the create slot crowns a mid-window sniper as the deployer.
    const { client } = scriptedClient([pageBody([row({ slotIndexId: sid(500, 0), timestamp: new Date(mintMs + 10).toISOString() })], true, 'more')]);
    const result = await walkOpeningWindow({ client, mint: MINT, mintMs, windowMs, mintFloorSlackMs: slackMs, maxRequests: 5 });
    expect(result.reachedMint).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.createSlot).toBeNull();
    expect(result.fills.length).toBeGreaterThan(0);
  });

  it('reserves a whole request budget before starting one, so the bound is exact not nominal', async () => {
    const client = new KeylessClient({
      host: SWAP_API,
      maxRequests: 100,
      minIntervalMs: 0,
      retryBackoffMs: [1, 1, 1],
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      fetchImpl: (async () =>
        ({ ok: true, status: 200, json: async () => pageBody([row({ timestamp: new Date(mintMs + 1).toISOString() })], true, 'more') }) as unknown as Response) as unknown as typeof fetch,
    });
    // attemptsPerRequest() is 4 here, so a budget of 4 permits exactly one page: the second is
    // refused because its WORST CASE would not fit, not because the budget had already run out.
    const result = await walkOpeningWindow({ client, mint: MINT, mintMs, windowMs, mintFloorSlackMs: slackMs, maxRequests: 4 });
    expect(client.attemptsPerRequest()).toBe(4);
    expect(result.pages).toBe(1);
    expect(result.requests + client.attemptsPerRequest()).toBeGreaterThan(4);
    expect(result.truncated).toBe(true);
    expect(result.stopReason).toMatch(/request budget of 4 would be exceeded/);
  });

  it('stops on an unreadable body rather than reading it as proof of exhaustion', async () => {
    const { client } = scriptedClient([{ error: 'maintenance' }]);
    const result = await walkOpeningWindow({ client, mint: MINT, mintMs, windowMs, mintFloorSlackMs: slackMs, maxRequests: 10 });
    expect(result.reachedMint).toBe(false);
    expect(result.stopReason).toMatch(/no rows could be read from/);
  });

  it('propagates a run ceiling and swallows a single launch\'s transport failure', async () => {
    const { client } = scriptedClient([new Error('ECONNRESET')], { maxRequests: 5 });
    const result = await walkOpeningWindow({ client, mint: MINT, mintMs, windowMs, mintFloorSlackMs: slackMs, maxRequests: 10 });
    expect(result.stopReason).toMatch(/request failed/);

    const { client: tiny } = scriptedClient([pageBody([])], { maxRequests: 1 });
    await tiny.getJson(tradesUrl(MINT));
    await expect(
      walkOpeningWindow({ client: tiny, mint: MINT, mintMs, windowMs, mintFloorSlackMs: slackMs, maxRequests: 10 }),
    ).rejects.toBeInstanceOf(CeilingReached);
  });
});

describe('the cohort is seeded from history, and it vouches for itself', () => {
  const monthStartMs = Date.UTC(2026, 0, 1);
  const monthEndMs = Date.UTC(2026, 1, 1);
  const wallets = ['7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL', '4q4GKBpVmSMkGaqDUZctSPTaqPCFxUhxr8fH3PbUgAqQ', '2CHrnc2LyagAbMaMFgthiDWh7ZZ9zT9TF8WEJf7MNE71'];

  function coverageRows(overrides: Partial<Record<string, unknown>>[] = []) {
    const base = COHORT_TABLES.map((t) => ({
      kind: 'coverage',
      key: t,
      a: '2024-04-01 00:00:00.000 UTC',
      b: '2026-08-03 00:00:00.000 UTC',
      n: 5000,
    }));
    return base.map((r, i) => ({ ...r, ...(overrides[i] ?? {}) }));
  }

  function cohortRows(counts: number[], extra: unknown[] = []) {
    return [
      ...coverageRows(),
      { kind: 'total', key: 'deployers_at_or_above_floor', a: null, b: null, n: counts.length },
      ...counts.map((n, i) => ({ kind: 'deployer', key: wallets[i % wallets.length], a: null, b: null, n })),
      ...extra,
    ];
  }

  it('reads the query the SQL declares, and the SQL selects on ONE PAST MONTH and nothing after it', () => {
    // Structural, not a promise in prose: decision 165b's whole content is that nothing conditions
    // the sample on surviving. A join to the completion surface, or any recency term, would.
    // Asserted over the EXECUTABLE half — the comments name the traps and must be free to.
    const sql = COHORT_SQL.split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(sql).toContain('pumpdotfun_solana.pump_evt_createevent');
    expect(sql).toContain('pumpdotfun_solana.pump_call_create\n');
    expect(sql).not.toContain('pump_call_create_v2');
    expect(sql).not.toContain('pump_evt_completeevent');
    expect(sql).not.toMatch(/bonded|bonding_rate|now\(\)|current_date|interval\s+'/i);
    // Attribution is the SIGNER. `creator` is a settable CreateV2 argument.
    expect(sql).toContain('e."user"');
    expect(sql).toContain('c.account_user');
    expect(sql).not.toMatch(/\bcreator\b/);
    // Both surfaces are bounded by the SAME month parameter, so neither can quietly read wider.
    expect(sql.match(/\{\{month_start\}\}/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql.match(/\{\{month_end\}\}/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('accepts the vendor\'s JSON envelope, a bare array and the browser CSV export alike', () => {
    const rows = [{ kind: 'deployer', key: wallets[0], a: '', b: '', n: 30 }];
    expect(readDuneResultFile(JSON.stringify({ result: { rows } }), 'x')).toHaveLength(1);
    expect(readDuneResultFile(JSON.stringify(rows), 'x')).toHaveLength(1);
    const csv = `kind,key,a,b,n\ndeployer,${wallets[0]},,,30\n`;
    expect(parseCohortRows(readDuneResultFile(csv, 'x')).deployers).toEqual([{ wallet: wallets[0], launchesInMonth: 30 }]);
  });

  it('refuses a surface that does not bracket the seed month — the silent start date, stated', () => {
    const cohort = parseCohortRows(cohortRows([30, 25]));
    expect(assessCohortCoverage({ cohort, monthStartMs, monthEndMs }).ok).toBe(true);

    const late = parseCohortRows([
      ...coverageRows([{ a: '2026-04-28 00:00:00.000 UTC' }]),
      { kind: 'total', key: 't', a: null, b: null, n: 1 },
      { kind: 'deployer', key: wallets[0], a: null, b: null, n: 30 },
    ]);
    const verdict = assessCohortCoverage({ cohort: late, monthStartMs, monthEndMs });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/does not bracket the seed month/);
  });

  it('refuses a missing surface, an empty month, an unreadable row and a capped result', () => {
    const missing = parseCohortRows([...coverageRows().slice(0, 1), { kind: 'total', key: 't', a: null, b: null, n: 0 }]);
    expect(assessCohortCoverage({ cohort: missing, monthStartMs, monthEndMs }).reasons.join(' ')).toMatch(/carries no coverage row/);

    const empty = parseCohortRows([
      ...coverageRows([{ n: 0 }, { n: 0 }]),
      { kind: 'total', key: 't', a: null, b: null, n: 0 },
    ]);
    expect(assessCohortCoverage({ cohort: empty, monthStartMs, monthEndMs }).reasons.join(' ')).toMatch(/NO creation row at all in the seed month/);

    const unreadable = parseCohortRows(cohortRows([30], [{ kind: 'deployer', key: wallets[0], a: null, b: null, n: 'twenty' }]));
    expect(unreadable.unreadableRows).toBe(1);
    expect(assessCohortCoverage({ cohort: unreadable, monthStartMs, monthEndMs }).reasons.join(' ')).toMatch(/could not be read/);

    // Declared 9 qualifying deployers, returned 2: the cap truncated it, and the survivors are the
    // most prolific — a selection rather than a shortfall.
    const capped = parseCohortRows([
      ...coverageRows(),
      { kind: 'total', key: 't', a: null, b: null, n: 9 },
      { kind: 'deployer', key: wallets[0], a: null, b: null, n: 40 },
      { kind: 'deployer', key: wallets[1], a: null, b: null, n: 30 },
    ]);
    expect(assessCohortCoverage({ cohort: capped, monthStartMs, monthEndMs }).reasons.join(' ')).toMatch(/row cap truncated it/);
  });

  it('never puts a string that is not base58-shaped into a query parameter', () => {
    // Dune substitutes text parameters into the query TEXT, and cohort wallets flow on into
    // CREATION_SQL's single-quoted literal. A comma is excluded by the alphabet, not by a rule.
    expect(WALLET_SHAPE.test(wallets[0]!)).toBe(true);
    for (const bad of ["a',''); DROP", 'short', 'has,comma', '0OIl-not-base58-alphabet-0OIl0OIl0OIl']) {
      expect(WALLET_SHAPE.test(bad), bad).toBe(false);
    }
    const parsed = parseCohortRows(cohortRows([30], [{ kind: 'deployer', key: "x'; --", a: null, b: null, n: 99 }]));
    expect(parsed.refusedByShape).toBe(1);
    expect(parsed.deployers.some((d) => d.wallet.includes("'"))).toBe(false);
  });

  it('chooses the threshold by a rule stated in advance, and publishes the ladder', () => {
    const deployers = [60, 55, 40, 30, 28, 25, 22, 21, 20, 20, 19].map((n, i) => ({ wallet: `w${i}`, launchesInMonth: n }));
    const choice = chooseThreshold(deployers, { floor: 20, maxCohort: 5 });
    // The lowest threshold whose cohort fits — never a threshold picked to move a finding.
    expect(choice.cohort.length).toBeLessThanOrEqual(5);
    expect(choice.ladder.find((r) => r.threshold === 20)?.deployers).toBe(10);
    expect(choice.cohort.every((d) => d.launchesInMonth >= choice.threshold)).toBe(true);
    // Taken WHOLE at the chosen threshold: nobody above it is dropped.
    expect(choice.cohort.length).toBe(deployers.filter((d) => d.launchesInMonth >= choice.threshold).length);
    // The floor binds when the whole eligible set already fits.
    expect(chooseThreshold(deployers, { floor: 20, maxCohort: 50 }).threshold).toBe(20);
  });

  it('type-checks bonded and launches_total as hard as it checks a timestamp', () => {
    const good = { deployer: wallets[0], mint: 'm1', created_at: '2026-01-05 00:00:00.000 UTC', bonded: false, launches_total: 2 };
    expect(parseLaunchListRows([good, { ...good, mint: 'm2', bonded: true }]).unreadableRows).toBe(0);
    // `false` is legitimate, so `=== true` would collapse "the column is gone" into "did not bond"
    // and gate-fail every candidate at 0% bonded on a run reporting itself fully measured.
    expect(parseLaunchListRows([{ ...good, bonded: undefined }]).unreadableRows).toBe(1);
    expect(parseLaunchListRows([{ ...good, launches_total: undefined }]).unreadableRows).toBe(1);
    expect(parseLaunchListRows([{ ...good, launches_total: true }]).unreadableRows).toBe(1);
    // A CSV export spells booleans as text, and only these two spellings count.
    expect(parseLaunchListRows([{ ...good, bonded: 'true' }]).unreadableRows).toBe(0);
    expect(parseLaunchListRows([{ ...good, bonded: 'yes' }]).unreadableRows).toBe(1);
  });

  it('parses both of Dune\'s timestamp spellings and refuses anything else', () => {
    expect(parseDuneTimestamp('2025-12-01 19:37:59.000 UTC')).toBe(Date.parse('2025-12-01T19:37:59.000Z'));
    expect(parseDuneTimestamp('2026-08-03T09:12:21.429632Z')).toBe(Date.parse('2026-08-03T09:12:21.429Z'));
    expect(parseDuneTimestamp('yesterday')).toBeNull();
    expect(parseDuneTimestamp(42)).toBeNull();
  });
});

describe('the clock pre-flight refuses rather than shrugs', () => {
  it('treats a null RPC result as load-shedding and an error envelope as an answer', async () => {
    const shedding = scriptedClient([{ jsonrpc: '2.0', id: 1, result: null }], { host: SOLANA_RPC });
    expect(await readBlockTimeMs(shedding.client, 1, 3)).toEqual({
      blockTimeMs: null,
      note: expect.stringContaining('load-shedding'),
    });
    expect(shedding.urls).toHaveLength(3);

    const erroring = scriptedClient([{ jsonrpc: '2.0', id: 1, error: { code: -32602 } }], { host: SOLANA_RPC });
    const answer = await readBlockTimeMs(erroring.client, 1, 3);
    expect(answer.blockTimeMs).toBeNull();
    expect(erroring.urls).toHaveLength(1);
  });

  it('refuses a slack the worst measured skew reaches, and refuses an empty pre-flight', () => {
    const sample = (skewMs: number | null) => ({ mint: 'm', symbol: 's', vendorMs: 0, chainMs: skewMs, skewMs, note: null });
    expect(assessSkew([sample(0), sample(0), sample(0)], 5_000).ok).toBe(true);
    // Second-resolution granularity is carried in the arithmetic rather than left to a reader.
    expect(assessSkew([sample(0)], SECOND_RESOLUTION_MS).ok).toBe(false);
    const tight = assessSkew([sample(4_500), sample(0), sample(0)], 5_000);
    expect(tight.ok).toBe(false);
    expect(tight.reasons.join(' ')).toMatch(/filtered out of its own window/);
    const nothing = assessSkew([sample(null), sample(null)], 5_000);
    expect(nothing.ok).toBe(false);
    expect(nothing.reasons.join(' ')).toMatch(/established nothing/);
  });

  it('stops at its own request ceiling instead of burning every attempt against a refusing client', async () => {
    // Swallowing CeilingReached as a per-attempt note would run the full attempt loop for every
    // remaining launch against a client that throws immediately, and would report them as merely
    // unread rather than as "the ceiling stopped the pre-flight".
    const { client, urls } = scriptedClient([{ jsonrpc: '2.0', id: 1, result: 1 }], { host: SOLANA_RPC, maxRequests: 1 });
    await client.rpc('getBlockTime', [1]);
    await expect(readBlockTimeMs(client, 2, 3)).rejects.toBeInstanceOf(CeilingReached);
    expect(urls).toHaveLength(1);

    const launches = [1, 2, 3].map((i) => ({ mint: `m${i}`, symbol: `s${i}`, createSlot: i, vendorMs: 0 }));
    const { client: paced } = scriptedClient([{ jsonrpc: '2.0', id: 1, result: 1 }], { host: SOLANA_RPC, maxRequests: 1 });
    const samples = await measureBlockTimeSkew({ client: paced, launches, attemptsPerLaunch: 3 });
    expect(samples).toHaveLength(2);
    expect(samples[1]!.skewMs).toBeNull();
    expect(samples[1]!.note).toMatch(/ceiling stopped it here/);
    // The launches after it were never attempted, and the verdict says so rather than calling them unread.
    expect(samples[1]!.note).toMatch(/1 launch\(es\) after this one were never attempted/);
  });

  it('only offers launches whose create slot is PROVED', () => {
    const launches = readLaunches();
    const picked = selectPreflightLaunches(launches, (m) => readWindowTape(m), 6);
    expect(picked.length).toBe(6);
    for (const p of picked) {
      const tape = readWindowTape(p.mint);
      expect(tape!.reachedMint).toBe(true);
      expect(tape!.createSlot).toBe(p.createSlot);
    }
    // Spread across the tape's own range, not taken from one end.
    const span = picked[picked.length - 1]!.vendorMs - picked[0]!.vendorMs;
    expect(span).toBeGreaterThan(180 * 86_400_000);
  });

  it('leg B is pure arithmetic over the committed tape, and costs nothing', () => {
    const mint = readLaunches().find((l) => readWindowTape(l.mint)?.createdTimestamp != null)!.mint;
    const vendorMs = readWindowTape(mint)!.createdTimestamp!;
    const samples = measureDuneClockSkew([{ mint, createdAtMs: vendorMs + 250 }], (m) => readWindowTape(m));
    expect(samples).toEqual([{ mint, symbol: '', vendorMs, chainMs: vendorMs + 250, skewMs: 250, note: null }]);
  });
});

describe('the per-launch series is section 2.1\'s, reproduced rather than re-argued', () => {
  const mintMs = Date.parse('2026-04-07T13:27:00.000Z');

  function fill(over: Partial<Record<string, unknown>>) {
    return parseFill(row({ timestamp: new Date(mintMs).toISOString(), ...over }))!;
  }

  it('marks the operation from a bundled create-slot transaction, and the deployer from the signer', () => {
    const fills = [
      fill({ slotIndexId: sid(10, 0), tx: 'dev', userAddress: DEPLOYER }),
      fill({ slotIndexId: sid(10, 1), tx: 'bundle', userAddress: 'coordinated-a' }),
      fill({ slotIndexId: sid(10, 2), tx: 'bundle', userAddress: 'coordinated-b' }),
      fill({ slotIndexId: sid(10, 3), tx: 'solo', userAddress: 'outsider' }),
    ];
    const g = createSlotGroups(fills, DEPLOYER)!;
    expect(g.slot).toBe(10);
    expect(g.firstBuyer).toBe(DEPLOYER);
    expect(g.bundledTx).toBe(1);
    expect(g.maxWalletsInOneTx).toBe(2);
    expect([...g.operation].sort()).toEqual([DEPLOYER, 'coordinated-a', 'coordinated-b'].sort());
    expect(g.operation.has('outsider')).toBe(false);
    expect(roomIsProven(g)).toBe(true);
    expect(roomIsProven({ bundledTx: 0 })).toBe(false);
  });

  it('reports an unproved create slot as UNMEASURED, never as a zero prize', () => {
    // Decision 134a. Finding nothing is indistinguishable from there being nothing, and reading it
    // as the second books the operation's own stake as outsider capital — inflating room.
    const fills = [fill({ slotIndexId: sid(10, 0), tx: 'dev', userAddress: DEPLOYER }), fill({ slotIndexId: sid(10, 1), tx: 'solo', userAddress: 'outsider' })];
    const m = measureLaunch({ mint: MINT, deployer: DEPLOYER, mintMs, fills, reachedMint: true });
    expect(m.measured).toBe(false);
    expect(m.unmeasuredReason).toMatch(/2\+ distinct wallets/);
    expect(m.createSlotPrizeSolGrossOfFees).toBe(0);

    const unproved = measureLaunch({ mint: MINT, deployer: DEPLOYER, mintMs, fills, reachedMint: false });
    expect(unproved.measured).toBe(false);
    expect(unproved.unmeasuredReason).toMatch(/did not prove it reached the create slot/);
  });

  it('reports an undecidable or never-opened position as OPEN, never as closed', () => {
    // A wrongly-closed pair contributes a fabricated P&L; a wrongly-open one only shrinks the sample.
    const seller = walletTotals([fill({ userAddress: 'w', type: 'sell', amountSol: '3', baseAmount: '1000' })]).get('w')!;
    expect(seller.closed).toBe(false);
    const roundTrip = walletTotals([
      fill({ userAddress: 'w', type: 'buy', amountSol: '1', baseAmount: '1000' }),
      fill({ userAddress: 'w', type: 'sell', amountSol: '3', baseAmount: '1000' }),
    ]).get('w')!;
    expect(roundTrip.closed).toBe(true);
    expect(roundTrip.realisedSolGrossOfFees).toBeCloseTo(2, 9);
    const partial = walletTotals([
      fill({ userAddress: 'w', type: 'buy', amountSol: '1', baseAmount: '1000' }),
      fill({ userAddress: 'w', type: 'sell', amountSol: '1', baseAmount: '500' }),
    ]).get('w')!;
    expect(partial.closed).toBe(false);
    expect(Number.isNaN(partial.realisedSolGrossOfFees)).toBe(true);
  });

  it('reproduces the committed dataset\'s own P&L on the walked sample it ships', () => {
    // The committed window tape is a primary record written by a different builder from a different
    // code path. Agreement on it is what makes a live measurement comparable to the published one.
    const mints = [
      'DfsvFZ4YiRQUd9A7Z1R2v4RWavpATC4WTK9t5V1npump',
      '5yWb5o2XT4J5dFCg3w6EZHxRAgYhyuj8H1RAEFeUpump',
      'DmuXsG8SaXYpz5TbDD48Rb6fJrJ6KV87EEjmwCmJpump',
      'C62QnxGVAa9AV4br5BpUzonaKxXc8jAczp6hFL47pump',
      '6HWgQuKsq96UguqoZPfeLxN9TgNTq18yUrKv6EvEpump',
    ];
    const pairs = csvRecords(parseCsv(readFileSync(join(TAPE_DIR, 'wallet_launch_pnl.csv'), 'utf8')));
    let compared = 0;
    let closureDifferences = 0;
    let maxError = 0;
    for (const mint of mints) {
      const totals = walletTotals(readWindowTape(mint)!.fills);
      for (const p of pairs.filter((r) => r['mint'] === mint)) {
        const t = totals.get(p['wallet'] as string);
        if (t === undefined) continue;
        compared += 1;
        const csvClosed = p['closed_in_window'] === '1';
        if (csvClosed !== t.closed) {
          closureDifferences += 1;
          // The ONE deliberate difference, and it runs one way: a wallet that sold without buying
          // has no round trip here, where the dataset books it closed with sol_in = 0.
          expect(Number(p['tokens_bought'])).toBe(0);
          continue;
        }
        if (t.closed) maxError = Math.max(maxError, Math.abs(Number(p['realised_sol']) - t.realisedSolGrossOfFees));
      }
    }
    expect(compared).toBeGreaterThan(1_000);
    expect(maxError).toBeLessThan(1e-6);
    expect(closureDifferences).toBeLessThanOrEqual(2);
  });

  it('labels the all-entrant figure a FLOOR in its own field name and in the row\'s caveats', () => {
    // Decision 164c: persisting raw fills preserves the option, it does not repair the data. If the
    // label cannot travel with the number, the deferral just relocates the bias.
    const fills = [
      fill({ slotIndexId: sid(10, 0), tx: 'dev', userAddress: DEPLOYER }),
      fill({ slotIndexId: sid(10, 1), tx: 'bundle', userAddress: 'coord' }),
      fill({ slotIndexId: sid(10, 2), tx: 'bundle', userAddress: 'coord2' }),
      fill({ slotIndexId: sid(10, 3), tx: 'solo', userAddress: 'slot-zero-outsider', amountSol: '1', baseAmount: '1000' }),
      fill({ slotIndexId: sid(11, 0), tx: 'late', userAddress: 'late-entrant', amountSol: '2', baseAmount: '2000' }),
      fill({ slotIndexId: sid(12, 0), tx: 'x', userAddress: 'slot-zero-outsider', type: 'sell', amountSol: '4', baseAmount: '1000' }),
      fill({ slotIndexId: sid(12, 1), tx: 'y', userAddress: 'late-entrant', type: 'sell', amountSol: '5', baseAmount: '2000' }),
    ];
    const m = measureLaunch({ mint: MINT, deployer: DEPLOYER, mintMs, fills, reachedMint: true });
    expect(m.measured).toBe(true);
    expect(m.createSlotOutsiders).toBe(1);
    expect(m.createSlotPrizeSolGrossOfFees).toBeCloseTo(3, 9);
    expect(m.allEntrantPrizeFloorSolGrossOfFees).toBeCloseTo(6, 9);
    expect(m.caveats).toContain(ALL_ENTRANT_FLOOR_CAVEAT);
    expect(m.caveats).toContain(GROSS_OF_FEES_CAVEAT);
    for (const column of SERIES_COLUMNS.filter((c) => c.startsWith('all_entrant'))) {
      expect(column, `${column} must carry "floor" in its own name`).toContain('floor');
    }
    expect(seriesRow(m)).toHaveLength(SERIES_COLUMNS.length);
  });

  it('names every P&L field for the fee treatment it actually has', () => {
    // A field called `prize` alone leaves a reader to remember which of the two it is, and the
    // committed tape's whole first trap is that only `onchain_*.csv` is fee-inclusive.
    const source = readFileSync(fileURLToPath(new URL('../tools/arrival-rate-walk/series.mjs', import.meta.url)), 'utf8');
    const declared = [...source.matchAll(/@property \{[^}]+\} (\w+)/g)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(10);
    for (const field of declared) {
      if (!/[Pp]rize|[Rr]ealised|[Rr]eturnPerSol/.test(field)) continue;
      expect(field, `${field} must say GrossOfFees or NetOfMeasuredFees`).toMatch(/GrossOfFees|NetOfMeasuredFees/);
    }
    for (const column of SERIES_COLUMNS) {
      if (!/prize|realised|return_per_sol/.test(column)) continue;
      expect(column, `${column} must say gross_of_fees or net_of_measured_fees`).toMatch(/gross_of_fees|net_of_measured_fees/);
    }
  });
});

describe('windows are segmented, never thresholded — and the published answer comes back', () => {
  it('reproduces section 4.1\'s two break dates on BOTH metrics, blind', () => {
    const series = publishedSeries();
    expect(series).toHaveLength(197);
    for (const metric of ['returnPerSol', 'prizeSol'] as const) {
      const breaks = changepoints(series.map((s) => s[metric]));
      const dates = breaks.map((b) => series[b.index]!.date);
      expect(dates.slice(0, 2), metric).toEqual(['2026-03-12T18:09:24Z', '2026-06-04T12:08:52Z']);
      expect(breaks[0]!.z).toBeGreaterThanOrEqual(4);
      expect(breaks[1]!.z).toBeGreaterThanOrEqual(4);
    }
  });

  it('reproduces section 4.3\'s three regimes and section 5\'s 82.7-day window', () => {
    const found = findWindows(publishedSeries(), { deployer: DEPLOYER });
    expect(found.segments.map((s) => s.launches)).toEqual([15, 102, 80]);
    expect(found.segments.map((s) => Number(s.medianPrizeSol.toFixed(2)))).toEqual([-0.01, 5.3, 1.38]);
    expect(found.segments.map((s) => Number(s.medianReturnPerSol.toFixed(3)))).toEqual([-0.002, 0.341, 0.138]);

    expect(found.windows).toHaveLength(1);
    const w = found.windows[0]!;
    expect(new Date(w.segment.fromMs).toISOString()).toBe('2026-03-12T18:09:24.000Z');
    expect(w.durationDays).toBeCloseTo(82.7, 1);
    expect(w.launchesMeasured).toBe(102);
    // Both ends observed is what makes 82.7 days a measurement rather than a bound.
    expect(w.openObserved).toBe(true);
    expect(w.closeObserved).toBe(true);
    // Section 6: it closed between two consecutive launches, 24.7 hours apart.
    expect(w.gapToNextRegimeDays * 24).toBeCloseTo(24.7, 1);
  });

  it('reproduces those breaks through the PRODUCTION series-construction path, zero-trip launches and all', () => {
    // The gap this closes: the two tests above hand `changepoints` a series this file pre-filtered,
    // so they never exercised the code that decides what enters the rank test. `toSeriesPoints` is
    // that code, and it is given every launch — including the ones with no closed create-slot round
    // trip, which is what the collector actually reads off disk.
    const rows = publishedMeasurements();
    const rank = toSeriesPoints(rows);
    expect(rows.length).toBeGreaterThan(197);
    expect(rank.launchesNoClosedCreateSlotPair).toBe(rows.length - 197);
    expect(rank.launchesNoClosedCreateSlotPair).toBeGreaterThan(0);
    expect(rank.launchesInRankTest).toBe(197);
    // The number the caveat quotes for this exclusion, measured rather than asserted in prose.
    expect(rank.launchesNoClosedCreateSlotPair).toBe(42);
    expect(ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT).toContain('on the committed tape is 42');

    const points = rank.byDeployer.get(DEPLOYER)!;
    expect(points.map((p) => p.mint)).toEqual(publishedSeries().map((s) => s.mint));
    const found = findWindows(points, { deployer: DEPLOYER });
    expect(found.segments.map((s) => s.launches)).toEqual([15, 102, 80]);
    expect(found.windows).toHaveLength(1);
    expect(new Date(found.windows[0]!.segment.fromMs).toISOString()).toBe('2026-03-12T18:09:24.000Z');
    expect(found.windows[0]!.durationDays).toBeCloseTo(82.7, 1);
    // The dropped launches do not inflate the denominator either.
    expect(found.launchesMeasured).toBe(197);
  });

  it('shows why 0 is not the missing value: imputing it moves the published answer', () => {
    // §11 of the published measurement puts a size on this — reading the launches with no outsider
    // in the create slot as zeros rather than as missing lowers the window's median prize by roughly
    // a fifth. On this series it is worse than a shift: the imputed zeros flatten the level enough
    // that the rank test finds NO break at all, so the published window disappears entirely. A test
    // that only asserted the exclusion happens would pass on an imputation too.
    const kept = findWindows(toSeriesPoints(publishedMeasurements()).byDeployer.get(DEPLOYER)!, { deployer: DEPLOYER });
    const imputed = findWindows(
      publishedMeasurements().map((r) => ({
        mint: r.mint,
        mintMs: r.mintMs,
        returnPerSol: Number.isFinite(r.createSlotReturnPerSolGrossOfFees) ? r.createSlotReturnPerSolGrossOfFees : 0,
        prizeSol: r.createSlotPrizeSolGrossOfFees,
      })),
      { deployer: DEPLOYER },
    );
    expect(imputed.launchesMeasured).toBeGreaterThan(kept.launchesMeasured);
    expect(kept.windows).toHaveLength(1);
    expect(imputed.segments).toHaveLength(1);
    expect(imputed.windows).toHaveLength(0);
    // And the level it flattens to sits far below the window's own.
    expect(imputed.segments[0]!.medianPrizeSol).toBeLessThan(kept.windows[0]!.segment.medianPrizeSol);
  });

  it('flags a censored end instead of reporting a bound as a measurement', () => {
    const point = (i: number, r: number) => ({ mint: `m${i}`, mintMs: i * 86_400_000, returnPerSol: r, prizeSol: r });
    const highThenLow = [...Array(20)].map((_, i) => point(i, 1 + i * 1e-6)).concat([...Array(20)].map((_, i) => point(20 + i, -1 + i * 1e-6)));
    const found = findWindows(highThenLow);
    expect(found.windows).toHaveLength(1);
    expect(found.windows[0]!.openObserved).toBe(false);
    expect(found.windows[0]!.closeObserved).toBe(true);
    expect(Number.isNaN(found.windows[0]!.gapToNextRegimeDays)).toBe(false);
  });

  it('says a short series is UNSEGMENTABLE, which is not the same finding as no window', () => {
    const short = [...Array(6)].map((_, i) => ({ mint: `m${i}`, mintMs: i * 1000, returnPerSol: 1, prizeSol: 1 }));
    const found = findWindows(short);
    expect(found.windows).toHaveLength(0);
    expect(found.tooShortReason).toMatch(/NOT the same finding as no window having arrived/);
    const summary = summariseArrival([found], { exposureBasis: 'calendar' });
    // Excluded from the denominator rather than counted as a deployer with no window.
    expect(summary.deployersSegmentable).toBe(0);
    expect(Number.isNaN(summary.windowsPerDeployerYearResolvedOnCalendarExposure)).toBe(true);
    expect(Number.isNaN(summary.windowsPerDeployerYearIncludingUnresolvedOnCalendarExposure)).toBe(true);
    expect(Number.isNaN(summary.windowsPerDeployerYearResolvedOnSeriesExposure)).toBe(true);
    // Nothing was segmentable, so no bar was applied to anything — reported as such, not as 4.
    expect(summary.detectionBand.minZ).toBeNull();
    expect(summary.caveats.join(' ')).toMatch(/excluded from the denominator/);
  });

  it('does not call an unprofitable local maximum a window', () => {
    const point = (i: number, r: number) => ({ mint: `m${i}`, mintMs: i * 86_400_000, returnPerSol: r, prizeSol: r });
    const negative = [...Array(20)].map((_, i) => point(i, -5 + i * 1e-6)).concat([...Array(20)].map((_, i) => point(20 + i, -9 + i * 1e-6)));
    const found = findWindows(negative);
    expect(found.windows).toHaveLength(0);
    expect(found.unprofitablePeaks.length).toBeGreaterThan(0);
  });

  it('keeps a median honest on an empty sample', () => {
    expect(Number.isNaN(median([]))).toBe(true);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('every window carries its strength, and the marginal band is a third verdict — 496a', () => {
  // A PERFECT step of `m` launches either side has a closed-form rank-sum z, so these three series
  // land on the three verdicts by construction rather than by being fished for. m = 10 → |z| 3.78
  // (inside the band, BELOW the bar), m = 12 → 4.16 (inside the band, ABOVE it), m = 15 → 4.67
  // (clear of the band). Nothing here is tuned: the only free number is the length.
  const point = (i: number, r: number) => ({ mint: `m${i}`, mintMs: i * 86_400_000, returnPerSol: r, prizeSol: r });
  const step = (m: number) =>
    [...Array(m)].map((_, i) => point(i, 1 + i * 1e-6)).concat([...Array(m)].map((_, i) => point(m + i, -1 + i * 1e-6)));
  // Wide enough to contain every series built from `point`, so calendar exposure is a real span
  // rather than a refusal — captain decision 504a. It is deliberately WIDER than any of them: the
  // whole point of the calendar denominator is that it keeps counting after a deployer goes quiet.
  const OBSERVATION = { fromMs: 0, toMs: 120 * 86_400_000 };

  it('THE BAR DOES NOT MOVE — 496a is a reporting change and this is what says so', () => {
    // If this fails, someone edited the threshold instead of the report. That is the one thing
    // 496a forbids: the bar is 4 for comparability with the published n = 1.
    expect(BOUNDS.series.minZ).toBe(4);
    // And the band is not a second bar dressed as one — it straddles 4 rather than replacing it.
    expect(UNRESOLVED_BAND.lo).toBeLessThan(BOUNDS.series.minZ);
    expect(UNRESOLVED_BAND.hi).toBeGreaterThan(BOUNDS.series.minZ);
  });

  it('sorts a strength into exactly one of the three verdicts, band edges included', () => {
    expect(detectionVerdict(6.5)).toBe('window');
    expect(detectionVerdict(4.5)).toBe('window'); // `hi` is exclusive of unresolved
    expect(detectionVerdict(4.49)).toBe('unresolved');
    expect(detectionVerdict(4.13)).toBe('unresolved'); // the reading that was called "window"
    expect(detectionVerdict(3.91)).toBe('unresolved'); // and the one 0.2 away called "no window"
    expect(detectionVerdict(3.5)).toBe('unresolved'); // `lo` is inclusive
    expect(detectionVerdict(3.49)).toBe('no-window');
    expect(detectionVerdict(2.99)).toBe('no-window');
    // An unreadable strength is no answer, and reading it as `no-window` would manufacture a refusal.
    expect(detectionVerdict(Number.NaN)).toBe('unresolved');
  });

  it('a comfortable detection is a WINDOW and states its own strength', () => {
    const found = findWindows(step(15));
    expect(found.windows).toHaveLength(1);
    const w = found.windows[0]!;
    expect(w.detection.z).toBeGreaterThanOrEqual(UNRESOLVED_BAND.hi);
    expect(w.detection.verdict).toBe('window');
    // The open end is the series' own start: absent evidence, not weak evidence.
    expect(w.detection.openZ).toBeNull();
    expect(w.detection.closeZ).toBeCloseTo(w.detection.z, 12);
    expect(w.detection.minZ).toBe(4);
    expect(found.unresolvedBreaks).toHaveLength(0);
  });

  it('a detection INSIDE the band still segments, and is reported UNRESOLVED rather than as a window', () => {
    const found = findWindows(step(12));
    // Segmentation behaviour is untouched: it cleared the bar, so it split, exactly as before.
    expect(found.segments).toHaveLength(2);
    expect(found.windows).toHaveLength(1);
    const w = found.windows[0]!;
    expect(w.detection.z).toBeGreaterThanOrEqual(BOUNDS.series.minZ);
    expect(w.detection.z).toBeLessThan(UNRESOLVED_BAND.hi);
    expect(w.detection.verdict).toBe('unresolved');
    // It is still a window object with a real duration — unresolved is a verdict, not a deletion.
    expect(w.launchesMeasured).toBe(12);
  });

  it('a detection BELOW the bar but inside the band is reported, not filed as absence', () => {
    const found = findWindows(step(10));
    // The split was NOT taken — one segment, no window, byte-identical to the pre-496a answer.
    expect(found.segments).toHaveLength(1);
    expect(found.windows).toHaveLength(0);
    // ...and the near-miss is now visible instead of vanishing.
    expect(found.unresolvedBreaks).toHaveLength(1);
    const b = found.unresolvedBreaks[0]!;
    expect(b.z).toBeGreaterThanOrEqual(UNRESOLVED_BAND.lo);
    expect(b.z).toBeLessThan(BOUNDS.series.minZ);
    expect(detectionVerdict(b.z)).toBe('unresolved');
    // And a genuinely flat series still says nothing at all — the band does not invent detections.
    const flat = [...Array(30)].map((_, i) => ({ mint: `m${i}`, mintMs: i * 86_400_000, returnPerSol: (i % 2) * 1e-9, prizeSol: 0 }));
    expect(findWindows(flat).unresolvedBreaks).toHaveLength(0);
  });

  it('surfacing the near-miss changes NO split: the breaks are the ones changepoints always took', () => {
    for (const m of [10, 12, 15, 20]) {
      const values = step(m).map((p) => p.returnPerSol);
      const full = segmentation(values);
      expect(full.breaks, `m=${m}`).toEqual(changepoints(values));
      // A near-miss is by definition not a break, so the two lists cannot overlap.
      const taken = new Set(full.breaks.map((b) => b.index));
      expect(full.unresolvedBreaks.some((b) => taken.has(b.index)), `m=${m}`).toBe(false);
    }
    // The published n = 1 is the real regression: same segments, same one window, unchanged.
    const published = findWindows(publishedSeries(), { deployer: DEPLOYER });
    expect(published.segments.map((s) => s.launches)).toEqual([15, 102, 80]);
    expect(published.windows).toHaveLength(1);
    expect(published.unresolvedBreaks).toHaveLength(0);
    // Both of its ends are real breaks, so the binding strength is the weaker of the two.
    const d = published.windows[0]!.detection;
    expect(d.openZ).not.toBeNull();
    expect(d.closeZ).not.toBeNull();
    expect(d.z).toBe(Math.min(d.openZ!, d.closeZ!));
  });

  it('reports the PUBLISHED n = 1 window as unresolved, which is 496a working rather than failing', () => {
    // The finding this convention was adopted to surface, and it lands on this project's own
    // headline window. On `returnPerSol` — the metric findWindows segments — the two breaks read
    // |z| 4.2802 at the open and 5.0205 at the close, so the BINDING edge is 4.28: inside the band,
    // and 0.28 from having not been found at all. On `prizeSol` the same window reads 5.26 / 6.50
    // and is comfortably resolved. Nothing about the measurement changed — 102 launches, 82.7 days,
    // both ends observed, all byte-identical — and no bar moved; what changed is that the report no
    // longer presents a reading 0.28 above the bar in the same words as one 2.5 above it.
    const roi = findWindows(publishedSeries(), { deployer: DEPLOYER });
    const d = roi.windows[0]!.detection;
    expect(d.openZ).toBeCloseTo(4.2802, 3);
    expect(d.closeZ).toBeCloseTo(5.0205, 3);
    expect(d.verdict).toBe('unresolved');
    expect(roi.windows[0]!.launchesMeasured).toBe(102);
    expect(roi.windows[0]!.durationDays).toBeCloseTo(82.7, 1);

    // On the prize metric the same boundaries clear the band, so the window is not marginal on the
    // evidence as a whole — which is exactly why the strength travels per reading and not per window.
    const prizeBreaks = changepoints(publishedSeries().map((s) => s.prizeSol));
    expect(prizeBreaks.slice(0, 2).map((b) => detectionVerdict(b.z))).toEqual(['window', 'window']);
  });

  it('the summary keeps the three apart and publishes the rate as a RANGE', () => {
    const resolved = findWindows(step(15), { deployer: 'resolved', observation: OBSERVATION });
    const marginal = findWindows(step(12), { deployer: 'marginal', observation: OBSERVATION });
    const nearMiss = findWindows(step(10), { deployer: 'near-miss', observation: OBSERVATION });
    const summary = summariseArrival([resolved, marginal, nearMiss], { exposureBasis: 'calendar' });

    expect(summary.windowsResolved).toBe(1);
    expect(summary.windowsUnresolved).toBe(1);
    expect(summary.windowsDetectedIncludingUnresolved).toBe(2);
    expect(summary.unresolvedBreaksNotSplit).toBe(1);
    expect(summary.detectionBand).toEqual({ minZ: 4, unresolvedLo: UNRESOLVED_BAND.lo, unresolvedHi: UNRESOLVED_BAND.hi });

    // The rate is two bounds and never one figure, and the unresolved window moves only the upper.
    expect(summary.windowsPerDeployerYearIncludingUnresolvedOnCalendarExposure).toBeGreaterThan(
      summary.windowsPerDeployerYearResolvedOnCalendarExposure,
    );
    // Durations are kept apart too: whether there is a window at all is what is unresolved.
    expect(summary.durationsDaysCensored).toHaveLength(1);
    expect(summary.unresolvedDurationsDaysCensored).toHaveLength(1);
    expect(summary.durationsDaysBothEndsObserved).toHaveLength(0);
    expect(summary.caveats).toContain(MARGINAL_DETECTION_CAVEAT);

    // THE COLLAPSE GUARD: the pre-496a keys are GONE rather than redefined, so a consumer that
    // pooled the classes reads `undefined` and fails, instead of reading a pooled count as resolved.
    expect(summary).not.toHaveProperty('windows');
    expect(summary).not.toHaveProperty('windowsPerDeployerYear');
    expect(summary).not.toHaveProperty('windowsWithBothEndsObserved');

    // The classification is a PARTITION: the three classes sum to the pooled count, so no window is
    // absorbed into a neighbour and none is dropped either.
    expect(summary.windowsResolved + summary.windowsUnresolved + summary.windowsBelowBand).toBe(
      summary.windowsDetectedIncludingUnresolved,
    );
  });

  it('a BELOW-BAND window is neither pooled into unresolved nor lost — the third class', () => {
    // 496a's own rule in the other direction. At the pinned bar this is unreachable — a taken break
    // has |z| >= 4, above the band's `lo` — but `findWindows` takes `opts.minZ`, and a caller below
    // the band is the reachable route. A `!== 'window'` catch-all counted such a window as
    // UNRESOLVED, which is the collapse this change exists to prevent.
    const m = 14;
    const overlapped = [...Array(m)]
      .map((_, i) => point(i, (i < 3 ? -1 : 1) + i * 1e-6))
      .concat([...Array(m)].map((_, i) => point(m + i, (i < 3 ? 1 : -1) + i * 1e-6)));
    const found = findWindows(overlapped, { minZ: 2.5, deployer: 'below-band', observation: OBSERVATION });
    expect(found.windows).toHaveLength(1);
    const w = found.windows[0]!;
    expect(w.detection.z).toBeLessThan(UNRESOLVED_BAND.lo);
    expect(w.detection.verdict).toBe('no-window');

    const summary = summariseArrival([found], { exposureBasis: 'calendar' });
    // NOT absorbed: it is out of the unresolved count and out of the rate's UPPER bound, which is
    // resolved-plus-unresolved and never the class that resolved the other way.
    expect(summary.windowsUnresolved).toBe(0);
    expect(summary.windowsResolved).toBe(0);
    expect(summary.windowsPerDeployerYearIncludingUnresolvedOnCalendarExposure).toBe(0);
    expect(summary.windowsPerDeployerYearResolvedOnCalendarExposure).toBe(0);
    expect(summary.unresolvedDurationsDaysCensored).toEqual([]);
    expect(summary.unresolvedDurationsDaysBothEndsObserved).toEqual([]);
    // NOT lost: counted in its own class, in its own duration list, and in the pooled total.
    expect(summary.windowsBelowBand).toBe(1);
    expect(summary.belowBandDurationsDaysCensored).toHaveLength(1);
    expect(summary.windowsDetectedIncludingUnresolved).toBe(1);
    expect(summary.windowsResolved + summary.windowsUnresolved + summary.windowsBelowBand).toBe(
      summary.windowsDetectedIncludingUnresolved,
    );
  });

  it('there is ONE window formatter and it cannot print a window without its strength', () => {
    const lines: Array<[Window, string]> = [
      [findWindows(step(15)).windows[0]!, 'WINDOW'],
      [findWindows(step(12)).windows[0]!, 'UNRESOLVED'],
    ];
    for (const [w, word] of lines) {
      const line = formatWindow(w);
      expect(line, word).toContain(word);
      expect(line, word).toContain(`|z|=${w.detection.z.toFixed(2)}`);
      expect(line, word).toContain(`bar ${w.detection.minZ}`);
    }
    // The unresolved one carries the caveat with it; the resolved one has nothing to warn about.
    expect(formatWindow(lines[1]![0])).toContain(MARGINAL_DETECTION_CAVEAT);
    expect(formatWindow(lines[0]![0])).not.toContain(MARGINAL_DETECTION_CAVEAT);

    const near = findWindows(step(10)).unresolvedBreaks[0]!;
    const text = formatUnresolvedBreak(near, 4);
    expect(text).toContain('UNRESOLVED');
    expect(text).toContain(`|z|=${near.z.toFixed(2)}`);
    expect(text).toMatch(/NOT split/);
    expect(text).toContain(MARGINAL_DETECTION_CAVEAT);
  });

  it('says why, in the caveat that travels with every unresolved reading', () => {
    expect(MARGINAL_DETECTION_CAVEAT).toContain('496a');
    expect(MARGINAL_DETECTION_CAVEAT).toContain('UNMOVED');
    expect(MARGINAL_DETECTION_CAVEAT).toMatch(/Never pool an unresolved count into either neighbour/);
  });
});

describe('the arrival rate is published on CALENDAR exposure — 504a', () => {
  const point = (i: number, r: number) => ({ mint: `m${i}`, mintMs: i * 86_400_000, returnPerSol: r, prizeSol: r });
  const step = (m: number) =>
    [...Array(m)].map((_, i) => point(i, 1 + i * 1e-6)).concat([...Array(m)].map((_, i) => point(m + i, -1 + i * 1e-6)));
  // The series runs 0 → 29 days; observation runs 0 → 120. The 91 quiet days at the end are exactly
  // what the series denominator drops and the calendar one keeps.
  const OBSERVATION = { fromMs: 0, toMs: 120 * 86_400_000 };
  const windows = (opts: Record<string, unknown> = {}) =>
    findWindows(step(15), { deployer: 'd', observation: OBSERVATION, ...opts });

  it('REFUSES to summarise without an explicit denominator — a default IS a pin', () => {
    // The defect 504a closes is a denominator nobody chose. A caller that will not name one gets a
    // throw naming the decision, not the basis that happens to be convenient.
    // @ts-expect-error — the omission is exactly what this refuses, and TypeScript agrees.
    expect(() => summariseArrival([windows()])).toThrow(/explicit exposureBasis/);
    // @ts-expect-error — and a word neither basis is not silently coerced to one that is.
    expect(() => summariseArrival([windows()], { exposureBasis: 'whatever' })).toThrow(/504a/);
    expect(() => summariseArrival([windows()], { exposureBasis: 'calendar' })).not.toThrow();
    expect(() => summariseArrival([windows()], { exposureBasis: 'series' })).not.toThrow();
    expect([...EXPOSURE_BASES]).toEqual(['calendar', 'series']);
  });

  it('pins CALENDAR as the published basis in the code and in the bounds, and pins the two equal', () => {
    // Two copies of one pin, held together, so the module's own refusal and the value a run reads
    // cannot drift apart. If this fails, someone changed the denominator rather than the report.
    expect(PUBLISHED_EXPOSURE_BASIS).toBe('calendar');
    expect(BOUNDS.series.exposureBasis).toBe(PUBLISHED_EXPOSURE_BASIS);
    expect(BOUNDS.justification['series.exposureBasis']).toMatch(/504a/);
    expect(BOUNDS.justification['series.exposureBasis']).toMatch(/165b/);
  });

  it('the two denominators are DIFFERENT quantities, and the published rate is the calendar one', () => {
    const summary = summariseArrival([windows()], { exposureBasis: 'calendar' });
    // The bias, in one comparison: the series denominator stops at the last measured launch, so it
    // is the smaller one and therefore the flattering one.
    expect(summary.exposure.deployerDaysSeries).toBeCloseTo(29, 9);
    expect(summary.exposure.deployerDaysCalendar).toBeCloseTo(120, 9);
    expect(summary.exposure.seriesShareOfCalendar).toBeCloseTo(29 / 120, 9);
    expect(summary.exposure.basis).toBe('calendar');
    expect(summary.exposure.publishedBasis).toBe('calendar');
    expect(summary.exposure.deployerDaysPublished).toBe(summary.exposure.deployerDaysCalendar);
    // Same windows, two rates, and the calendar one is the smaller — which is the direction the
    // whole finding turns on.
    expect(summary.windowsPerDeployerYearResolvedOnSeriesExposure).toBeGreaterThan(
      summary.windowsPerDeployerYearResolvedOnCalendarExposure,
    );
    expect(summary.windowsPerDeployerYearResolvedOnCalendarExposure).toBeCloseTo(365.25 / 120, 9);
    expect(summary.windowsPerDeployerYearResolvedOnSeriesExposure).toBeCloseTo(365.25 / 29, 9);

    // THE COLLAPSE GUARD, 496a's rule one quantity over: the pre-504a keys are GONE rather than
    // redefined, so a consumer cannot read a calendar figure where it expected a series one.
    expect(summary).not.toHaveProperty('windowsPerDeployerYearResolved');
    expect(summary).not.toHaveProperty('windowsPerDeployerYearIncludingUnresolved');
    expect(summary).not.toHaveProperty('observationDeployerDays');
    expect(windows()).not.toHaveProperty('observationDays');
  });

  it('choosing the SERIES basis changes which rate is published and says so, changing no number', () => {
    const calendar = summariseArrival([windows()], { exposureBasis: 'calendar' });
    const series = summariseArrival([windows()], { exposureBasis: 'series' });
    // Both readings are on both summaries; the basis decides which is THE published one, and never
    // what either is worth.
    for (const key of [
      'windowsPerDeployerYearResolvedOnCalendarExposure',
      'windowsPerDeployerYearIncludingUnresolvedOnCalendarExposure',
      'windowsPerDeployerYearResolvedOnSeriesExposure',
      'windowsPerDeployerYearIncludingUnresolvedOnSeriesExposure',
    ] as const) {
      expect(series[key], key).toBe(calendar[key]);
    }
    expect(series.exposure.deployerDaysPublished).toBe(series.exposure.deployerDaysSeries);
    // And a summary computed on the superseded basis says in one comparison that it is not a
    // published reading, rather than looking like one.
    expect(series.exposure.basis).not.toBe(series.exposure.publishedBasis);
    expect(formatArrivalRate(series)).toContain('NOT A PUBLISHED READING');
    expect(formatArrivalRate(calendar)).not.toContain('NOT A PUBLISHED READING');
  });

  it('REFUSES the calendar rate rather than falling back to the series one when the window is unknown', () => {
    // The dangerous failure is not an error, it is a plausible number: a run that quietly reverts to
    // the denominator 504a replaced publishes a pre-504a rate under a post-504a name.
    const unknown = findWindows(step(15), { deployer: 'd' });
    expect(unknown.calendarObservationDays).toBeNull();
    expect(unknown.calendarObservationRefusal).toMatch(/no observation window was supplied/);

    const summary = summariseArrival([unknown], { exposureBasis: 'calendar' });
    expect(Number.isNaN(summary.windowsPerDeployerYearResolvedOnCalendarExposure)).toBe(true);
    // The series reading is still there, finite, and under its own name — labelled, not published.
    expect(summary.windowsPerDeployerYearResolvedOnSeriesExposure).toBeCloseTo(365.25 / 29, 9);
    expect(summary.exposure.calendarUnavailable).toHaveLength(1);
    expect(summary.exposure.calendarUnavailable[0]!.deployer).toBe('d');
    const line = formatArrivalRate(summary);
    expect(line).toContain('CALENDAR EXPOSURE UNAVAILABLE');
    expect(line).toContain('UNAVAILABLE');
    expect(line).not.toMatch(/arrival rate 12\.5/);

    // ONE deployer without a window makes the WHOLE calendar denominator unknown: the numerator
    // still counts that deployer's windows, so dividing by the rest is a rate over two populations.
    const mixed = summariseArrival([windows(), unknown], { exposureBasis: 'calendar' });
    expect(Number.isNaN(mixed.exposure.deployerDaysCalendar)).toBe(true);
    expect(Number.isNaN(mixed.windowsPerDeployerYearResolvedOnCalendarExposure)).toBe(true);
  });

  it('refuses a window that does not contain what was measured, rather than stretching it to fit', () => {
    const points = step(15);
    const short = calendarExposure({ fromMs: 0, toMs: 5 * 86_400_000 }, points);
    expect(short.days).toBeNull();
    expect(short.refusal).toMatch(/sit outside the stated observation window/);
    // An unreadable mint instant gets its OWN refusal: it is not a launch in the wrong place, and
    // the two sentences send an operator to different places.
    const undated = calendarExposure(OBSERVATION, [...points, { ...points[0]!, mintMs: Number.NaN }]);
    expect(undated.days).toBeNull();
    expect(undated.refusal).toMatch(/carry no finite mint instant/);
    expect(undated.refusal).not.toMatch(/sit outside/);
    expect(calendarExposure({ fromMs: 10, toMs: 10 }, points).refusal).toMatch(/not a positive span/);
    expect(calendarExposure({ fromMs: Number.NaN, toMs: 10 }, points).refusal).toMatch(/not a positive span/);
    expect(calendarExposure(OBSERVATION, points).days).toBeCloseTo(120, 9);
    // Never throws: this runs offline over persisted checkpoints, where one bad deployer must not
    // cost every other deployer its measurement.
    expect(() => calendarExposure(null, points)).not.toThrow();
  });

  it('there is ONE rate formatter and it cannot print a rate without its denominator', () => {
    const line = formatArrivalRate(summariseArrival([windows()], { exposureBasis: 'calendar' }));
    expect(line).toContain('CALENDAR EXPOSURE');
    expect(line).toContain('per deployer-year');
    expect(line).toContain('SUPERSEDED series denominator');
    expect(line).toContain(EXPOSURE_BASIS_CAVEAT);
  });

  it('states the denominator in the DOCUMENTATION as well as in the output', () => {
    // Criterion three of 504a: the choice is stated wherever a rate appears. The tool's README is
    // where a reader meets the rate before ever running it.
    const readme = readFileSync(join(TOOL_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/## The arrival rate is published on CALENDAR exposure/);
    expect(readme).toContain('504a');
    expect(readme).toContain('windowsPerDeployerYearResolvedOnCalendarExposure');
  });

  it('says why, in the caveat that travels with every rate', () => {
    expect(EXPOSURE_BASIS_CAVEAT).toContain('504a');
    expect(EXPOSURE_BASIS_CAVEAT).toContain('165b');
    expect(EXPOSURE_BASIS_CAVEAT).toContain('495a');
    expect(EXPOSURE_BASIS_CAVEAT).toContain('0.5893');
    expect(EXPOSURE_BASIS_CAVEAT).toContain('0.1883');
    expect(EXPOSURE_BASIS_CAVEAT).toMatch(/3\.13x/);
    // The caveat reaches the summary itself, not only a document.
    expect(summariseArrival([windows()], { exposureBasis: 'calendar' }).caveats).toContain(EXPOSURE_BASIS_CAVEAT);
  });

  it('MOVES NO MEASURED VALUE: the denominator is the only thing the observation window touches', () => {
    // 504a is a reporting-unit change. Segments, windows, durations, strengths and the bar are
    // byte-identical with the window supplied and without it.
    const withWindow = windows();
    const without = findWindows(step(15), { deployer: 'd' });
    const measured = ({
      calendarObservationDays: _days,
      calendarObservationRefusal: _refusal,
      ...rest
    }: typeof withWindow) => rest;
    expect(measured(withWindow)).toEqual(measured(without));
    expect(withWindow.seriesObservationDays).toBe(without.seriesObservationDays);
    for (const basis of EXPOSURE_BASES) {
      const a = summariseArrival([withWindow], { exposureBasis: basis as ExposureBasis });
      const b = summariseArrival([without], { exposureBasis: basis as ExposureBasis });
      expect(a.windowsResolved).toBe(b.windowsResolved);
      expect(a.durationsDaysCensored).toEqual(b.durationsDaysCensored);
      expect(a.windowsPerDeployerYearResolvedOnSeriesExposure).toBe(
        b.windowsPerDeployerYearResolvedOnSeriesExposure,
      );
    }
  });
});

describe('the plan is the only place a run states its cost, and it issues nothing', () => {
  const launchRow = (mint: string, atIso: string, total: number) => ({
    deployer: DEPLOYER,
    mint,
    created_at: atIso,
    bonded: false,
    launches_total: total,
  });

  it('costs a run in requests and wall clock before a single request is spent', () => {
    const rows = [...Array(10)].map((_, i) => launchRow(`m${i}`, `2026-02-0${(i % 9) + 1} 00:00:00.000 UTC`, 10));
    const plan = buildPlan({ cohortText: null, launchList: readLaunchList(JSON.stringify(rows), 'test launch list'), nowMs: Date.parse('2026-08-03T00:00:00Z') });
    expect(plan.ok).toBe(true);
    expect(plan.launchesToWalk).toBe(10);
    expect(plan.expectedRequests.p50).toBe(40);
    expect(plan.expectedRequests.ceiling).toBe(10 * BOUNDS.walk.maxRequestsPerLaunch);
    expect(plan.expectedWallClock.p50Hours).toBeCloseTo((40 * BOUNDS.walk.minIntervalMs) / 3_600_000, 9);
    // The lane's ONLY metered spend is stated in the plan, because it happens by hand beforehand.
    expect(plan.duneSpend.executions).toBe(BOUNDS.dune.expectedExecutions);
    expect(plan.caveats.join(' ')).toMatch(/no filter on whether a deployer is still\s+active/);
  });

  it('refuses a prefix read as a total, and an oversized history read as a truncation', () => {
    const short = buildPlan({
      cohortText: null,
      launchList: readLaunchList(JSON.stringify([launchRow('m1', '2026-02-01 00:00:00.000 UTC', 99)]), 'test launch list'),
      nowMs: Date.parse('2026-08-03T00:00:00Z'),
    });
    expect(short.ok).toBe(false);
    expect(short.refusals.join(' ')).toMatch(/silently short/);

    const huge = [...Array(BOUNDS.walk.maxLaunchesPerDeployer + 1)].map((_, i) =>
      launchRow(`m${i}`, '2026-02-01 00:00:00.000 UTC', BOUNDS.walk.maxLaunchesPerDeployer + 1),
    );
    const over = buildPlan({ cohortText: null, launchList: readLaunchList(JSON.stringify(huge), 'test launch list'), nowMs: Date.parse('2026-08-03T00:00:00Z') });
    expect(over.refusals.join(' ')).toMatch(/refused from the plan rather than truncated/);
    expect(over.launchesToWalk).toBe(0);
  });

  it('refuses a cohort deployer the launch list holds no row for, rather than dropping it', () => {
    // Absence of evidence, not evidence of absence. Dropping it would shrink the arrival rate's
    // denominator silently — the same invisible false rejection the creation-derived lane exists
    // to remove, arriving as a hole in a sample instead of as a gate failure.
    const cohortText = JSON.stringify([
      ...COHORT_TABLES.map((t) => ({ kind: 'coverage', key: t, a: '2024-04-01 00:00:00.000 UTC', b: '2026-08-03 00:00:00.000 UTC', n: 5000 })),
      { kind: 'total', key: 't', a: null, b: null, n: 2 },
      { kind: 'deployer', key: DEPLOYER, a: null, b: null, n: 40 },
      { kind: 'deployer', key: '4q4GKBpVmSMkGaqDUZctSPTaqPCFxUhxr8fH3PbUgAqQ', a: null, b: null, n: 30 },
    ]);
    const plan = buildPlan({
      cohortText,
      launchList: readLaunchList(JSON.stringify([launchRow('m1', '2026-02-01 00:00:00.000 UTC', 1)]), 'test launch list'),
      nowMs: Date.parse('2026-08-03T00:00:00Z'),
    });
    expect(plan.ok).toBe(false);
    expect(plan.refusals.join(' ')).toMatch(/4q4GKBpV.* returned no creation row for it at all/);
    // The chosen threshold and the ladder that produced it are published either way.
    // Two deployers already fit `maxCohort`, so the rule stops at the pinned floor.
    expect(plan.threshold).toBe(BOUNDS.seed.minLaunchesInMonthFloor);
    expect(plan.ladder.length).toBeGreaterThan(0);
    expect(plan.cohort[0]!.launchesInMonth).toBe(40);
  });

  it('states a multi-sitting collection as an ADVISORY, and does not refuse its own target cohort', () => {
    // The collector checkpoints every launch and resumes, so a p95 above the run ceiling says how
    // many sittings to expect — it is not a failure. Refusing it would make the README's own headline
    // scenario (~2,100 launches) unwalkable before the first request. The real bound is the client's
    // per-run ceiling, which stops a sitting exactly and leaves it resumable.
    // Spread over several deployers, each well inside the per-deployer ceiling, so the only thing
    // over a bound is the RUN's request estimate.
    const perDeployer = Math.floor(BOUNDS.walk.maxLaunchesPerDeployer / 2);
    const deployers = Math.ceil(BOUNDS.walk.maxRequestsPerRun / 13 / perDeployer) + 1;
    const rows = [...Array(deployers)].flatMap((_, d) =>
      [...Array(perDeployer)].map((__, i) => ({
        deployer: `deployer-${d}`,
        mint: `m${d}-${i}`,
        created_at: '2026-02-01 00:00:00.000 UTC',
        bonded: false,
        launches_total: perDeployer,
      })),
    );
    const plan = buildPlan({
      cohortText: null,
      launchList: readLaunchList(JSON.stringify(rows), 'test launch list'),
      nowMs: Date.parse('2026-08-03T00:00:00Z'),
    });
    expect(plan.expectedRequests.p95).toBeGreaterThan(BOUNDS.walk.maxRequestsPerRun);
    expect(plan.ok).toBe(true);
    expect(plan.refusals).toEqual([]);
    expect(plan.advisories.join(' ')).toMatch(/above the pinned run ceiling/);
    expect(plan.advisories.join(' ')).toMatch(/sittings/);
  });

  it('walks only forward from the seed month, so every deployer gets the same observation', () => {
    // The "before" row is DERIVED from the pinned bound, never restated: anchoring it to one
    // particular `seed.months` value couples this fixture to a bound it is not testing, so moving
    // the bound would fail the suite on the fixture rather than on a defect.
    const seedStartMs = Date.parse(`${BOUNDS.seed.months[0]}-01T00:00:00Z`);
    const beforeSeed = new Date(seedStartMs - 60 * 86_400_000).toISOString().replace('T', ' ').replace('Z', ' UTC');
    const rows = [
      launchRow('before', beforeSeed, 3),
      launchRow('inside', '2026-02-01 00:00:00.000 UTC', 3),
      launchRow('future', '2027-01-01 00:00:00.000 UTC', 3),
    ];
    const plan = buildPlan({ cohortText: null, launchList: readLaunchList(JSON.stringify(rows), 'test launch list'), nowMs: Date.parse('2026-08-03T00:00:00Z') });
    expect(plan.launchesToWalk).toBe(1);
  });
});

describe('the CLI refuses a bound that would silently stop being one', () => {
  it('rejects a non-number rather than coercing it to NaN', () => {
    expect(() => parseArgs(['--phase', 'walk', '--out', 'x', '--launch-list', 'y', '--limit', 'lots'])).toThrow(/positive finite number/);
    expect(() => parseArgs(['--phase', 'walk', '--out', 'x', '--launch-list', 'y', '--max-requests', '-1'])).toThrow(/positive finite number/);
  });

  it('lets the pacing floor be raised and never undercut', () => {
    const raised = parseArgs(['--phase', 'walk', '--out', 'x', '--launch-list', 'y', '--min-interval-ms', '8000']);
    expect(raised.minIntervalMs).toBe(8000);
    expect(() => parseArgs(['--phase', 'walk', '--out', 'x', '--launch-list', 'y', '--min-interval-ms', '2000'])).toThrow(/may not go below/);
    expect(() => parseArgs(['--phase', 'walk', '--out', 'x', '--launch-list', 'y', '--max-requests', '999999'])).toThrow(/may not exceed the pinned ceiling/);
  });

  it('requires an output directory for anything that spends, and a launch list for the walk', () => {
    expect(() => parseArgs(['--phase', 'walk', '--launch-list', 'y'])).toThrow(/--out is required/);
    expect(() => parseArgs(['--phase', 'walk', '--out', 'x'])).toThrow(/--launch-list is required/);
    expect(() => parseArgs(['--phase', 'nonsense', '--out', 'x'])).toThrow(/--phase must be one of/);
    expect(parseArgs(['--phase', 'plan', '--launch-list', 'y']).out).toBeNull();
  });

  it('writes fills in the committed tapes\' own row schema, so the files concatenate', () => {
    const f = parseFill(row())!;
    expect(Object.keys(toTapeRow(f))).toEqual(['slot', 'sid', 'tx', 'ts', 'u', 'k', 'p', 'sol', 'base', 'psol', 'pusd']);
    // `tsMs` is derived and deliberately not stored beside its source.
    expect(Object.keys(toTapeRow(f))).not.toContain('tsMs');
  });
});

describe('the collector end to end, on a scripted endpoint', () => {
  it('persists every fill in the window, then derives BOTH series from that one pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arrival-walk-'));
    try {
      const mintMs = Date.parse('2026-02-01T00:00:00.000Z');
      const fills = [
        row({ slotIndexId: sid(10, 0), tx: 'dev', userAddress: DEPLOYER, timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(10, 1), tx: 'bundle', userAddress: 'coord-a', timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(10, 2), tx: 'bundle', userAddress: 'coord-b', timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(10, 3), tx: 'solo', userAddress: 'outsider', amountSol: '1', baseAmount: '1000', timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(11, 0), tx: 'late', userAddress: 'later', amountSol: '2', baseAmount: '500', timestamp: new Date(mintMs + 5_000).toISOString() }),
        row({ slotIndexId: sid(12, 0), tx: 's1', userAddress: 'outsider', type: 'sell', amountSol: '4', baseAmount: '1000', timestamp: new Date(mintMs + 10_000).toISOString() }),
      ];
      const { client } = scriptedClient([pageBody(fills, false, null)]);
      const list = parseLaunchListRows([{ deployer: DEPLOYER, mint: MINT, created_at: '2026-02-01 00:00:00.000 UTC', bonded: true, launches_total: 1 }]);
      const walked = await runWalk({ out: dir, client, list, nowMs: Date.parse('2026-08-03T00:00:00Z') });
      expect(walked.walked).toBe(1);

      // Decision 164c: the raw fills are on disk, every wallet, not only the create slot's.
      const persisted = readPersistedWindow(join(dir, 'window'), MINT)!;
      expect(persisted.fills).toHaveLength(6);
      expect(new Set(persisted.fills.map((f) => f.u))).toContain('later');
      expect(persisted.meta['reached_mint']).toBe(true);
      expect(persisted.meta['create_slot']).toBe(10);
      expect(persisted.meta['pre_mint_fills']).toBe(0);
      expect(gunzipSync(readFileSync(join(dir, 'window', `${MINT}.jsonl.gz`))).toString('utf8')).toContain('"sid"');

      const { rows, summary } = runSeries({ out: dir, exposureBasis: BOUNDS.series.exposureBasis });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.measured).toBe(true);
      expect(rows[0]!.createSlotOutsiders).toBe(1);
      expect(rows[0]!.createSlotPrizeSolGrossOfFees).toBeCloseTo(3, 9);
      // Both readings, one pass. The all-entrant one carries `later`'s OPEN position as open.
      expect(rows[0]!.allEntrantClosedPairsFloor).toBe(1);

      const series = readFileSync(join(dir, 'series.csv'), 'utf8');
      expect(series.split('\n')[0]).toBe(SERIES_COLUMNS.join(','));
      const arrival = JSON.parse(readFileSync(join(dir, 'arrival.json'), 'utf8'));
      expect(arrival.caveats.join(' ')).toContain('FLOOR');
      expect(summary.deployers).toBe(1);
      // 496a reaches the RUN RECORD, not only the library: the band the run read is on the summary,
      // the caveat is in the record's own caveats, and every per-deployer row carries the bar it was
      // segmented at even when — as here — the series was far too short to detect anything.
      expect(arrival.caveats.join(' ')).toContain('UNRESOLVED');
      expect(arrival.summary.detectionBand).toEqual({ minZ: null, unresolvedLo: 3.5, unresolvedHi: 4.5 });
      expect(arrival.perDeployer[0].minZ).toBe(4);
      expect(arrival.perDeployer[0].unresolvedBreaks).toEqual([]);

      // 504a reaches the RUN RECORD too: the record says what a published rate would have been
      // divided by, and where that window came from. A record that states the rate without stating
      // this is the pre-504a record — unreadable years later.
      expect(arrival.caveats.join(' ')).toContain('CALENDAR exposure');
      expect(arrival.observation.basis).toBe('calendar');
      expect(arrival.observation.unrecordedReason).toBeNull();
      expect(arrival.observation.window.fromIso).toBe('2026-01-01T00:00:00.000Z');
      expect(arrival.observation.window.toIso).toBe('2026-08-03T00:00:00.000Z');
      expect(summary.exposure.basis).toBe('calendar');
      expect(summary.exposure.publishedBasis).toBe('calendar');
      // The walk enumerated from the seed month's start to its own instant, and that IS the
      // denominator — read back from what the walk recorded, never inferred from the series.
      expect(arrival.perDeployer[0].calendarObservationDays).toBeCloseTo(214, 6);
      expect(arrival.perDeployer[0].calendarObservationRefusal).toBeNull();

      // Re-running skips what is already on disk: an interruption costs the launch in flight.
      const { client: second } = scriptedClient([pageBody(fills, false, null)]);
      expect((await runWalk({ out: dir, client: second, list, nowMs: Date.parse('2026-08-03T00:00:00Z') })).walked).toBe(0);
      expect(second.issued()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-attempts an UNPROVED walk on the next sitting, and keeps what the failed one spent', async () => {
    // A sidecar's existence is not proof of coverage. A walk that ended truncated wrote one saying
    // `reached_mint: false`, and skipping on existence alone would make one transient failure a
    // permanent unmeasured launch — biased towards the busiest launches, which are the high-prize
    // tail the 40-request per-launch budget exists to keep.
    const dir = mkdtempSync(join(tmpdir(), 'arrival-retry-'));
    try {
      const mintMs = Date.parse('2026-02-01T00:00:00.000Z');
      const list = parseLaunchListRows([
        { deployer: DEPLOYER, mint: MINT, created_at: '2026-02-01 00:00:00.000 UTC', bonded: true, launches_total: 1 },
      ]);
      const nowMs = Date.parse('2026-08-03T00:00:00Z');
      const late = row({ slotIndexId: sid(500, 0), timestamp: new Date(mintMs + 10).toISOString() });

      // Sitting one: the endpoint never proves it holds nothing older, so the walk is truncated.
      const { client: first } = scriptedClient([pageBody([late], true, 'more')]);
      await runWalk({ out: dir, client: first, list, nowMs });
      const windowDir = join(dir, 'window');
      const attempt = JSON.parse(readFileSync(join(windowDir, `${MINT}.meta.json`), 'utf8'));
      expect(attempt.reached_mint).toBe(false);
      expect(attempt.attempts).toBe(1);
      expect(typeof attempt.stop_reason).toBe('string');
      expect(checkpointState(windowDir, MINT).done).toBe(false);

      // Sitting two: it is offered again, and the failed attempt's evidence survives the retry.
      const proving = [
        row({ slotIndexId: sid(10, 0), tx: 'dev', userAddress: DEPLOYER, timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(10, 1), tx: 'bundle', userAddress: 'coord-a', timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(10, 2), tx: 'bundle', userAddress: 'coord-b', timestamp: new Date(mintMs).toISOString() }),
      ];
      const { client: second } = scriptedClient([pageBody(proving, false, null)]);
      expect((await runWalk({ out: dir, client: second, list, nowMs })).walked).toBe(1);
      const proved = JSON.parse(readFileSync(join(windowDir, `${MINT}.meta.json`), 'utf8'));
      expect(proved.reached_mint).toBe(true);
      expect(proved.attempts).toBe(2);
      expect(proved.previous_attempts).toHaveLength(1);
      expect(proved.previous_attempts[0].reached_mint).toBe(false);
      expect(proved.previous_attempts[0].requests).toBe(attempt.requests);

      // And now it IS done, so a third sitting spends nothing on it.
      expect(checkpointState(windowDir, MINT).done).toBe(true);
      const { client: third } = scriptedClient([pageBody(proving, false, null)]);
      expect((await runWalk({ out: dir, client: third, list, nowMs })).walked).toBe(0);
      expect(third.issued()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the observation window the WALK covered, merges it across sittings, and refuses a shape it cannot read', async () => {
    // Captain decision 504a: the denominator of a published arrival rate is what we WATCHED, and
    // only the phase that did the watching knows it. It is written before the first request, so a
    // sitting that is interrupted — or that walks nothing at all — still leaves the offline phase
    // able to state its denominator.
    const dir = mkdtempSync(join(tmpdir(), 'arrival-observation-'));
    try {
      const first = recordObservation(dir, { fromMs: 100, toMs: 200 });
      expect(first).toEqual({ fromMs: 100, toMs: 200, sittings: 1 });
      // A resumed collection MERGES: observation ran across every sitting, so the floor is the
      // earliest any of them enumerated from and the ceiling the latest any of them reached.
      const second = recordObservation(dir, { fromMs: 50, toMs: 150 });
      expect(second).toEqual({ fromMs: 50, toMs: 200, sittings: 2 });
      const third = recordObservation(dir, { fromMs: 100, toMs: 400 });
      expect(third).toEqual({ fromMs: 50, toMs: 400, sittings: 3 });
      expect(readObservation(dir)).toEqual({ window: { fromMs: 50, toMs: 400 }, reason: null });

      const written = JSON.parse(readFileSync(join(dir, OBSERVATION_FILE), 'utf8'));
      expect(written.schema_version).toBe(OBSERVATION_SCHEMA_VERSION);
      expect(written.seed_months).toEqual(BOUNDS.seed.months);
      expect(written.note).toBe(EXPOSURE_BASIS_CAVEAT);

      // A version this build does not know is REFUSED, never guessed at: a window read out of a
      // shape nobody vouched for is a denominator nobody vouched for.
      writeFileSync(join(dir, OBSERVATION_FILE), JSON.stringify({ ...written, schema_version: 99 }));
      expect(readObservation(dir).window).toBeNull();
      expect(readObservation(dir).reason).toMatch(/schema 99/);
      writeFileSync(join(dir, OBSERVATION_FILE), '{"schema_version":1,"from_ms":');
      expect(readObservation(dir).reason).toMatch(/could not be parsed/);
      rmSync(join(dir, OBSERVATION_FILE));
      expect(readObservation(dir).reason).toMatch(/is not in the collection directory/);

      // And an offline phase over a directory with no record publishes NO rate rather than the
      // series one: the caveat and the refusal are in the record, and every rate on the calendar
      // denominator reads NaN.
      mkdirSync(join(dir, 'window'), { recursive: true });
      const summary = runSeries({ out: dir, exposureBasis: BOUNDS.series.exposureBasis }).summary;
      expect(summary.exposure.basis).toBe('calendar');
      const arrival = JSON.parse(readFileSync(join(dir, 'arrival.json'), 'utf8'));
      expect(arrival.observation.window).toBeNull();
      expect(arrival.observation.unrecordedReason).toMatch(/is not in the collection directory/);
      expect(arrival.caveats).toContain(EXPOSURE_BASIS_CAVEAT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a checkpoint killed mid-write as unreadable and UNMEASURED, instead of throwing', async () => {
    // One truncated last line is what a walk killed mid-write leaves. Aborting the whole offline
    // phase over it would lose every other launch's measurement to one launch's interrupted write.
    const dir = mkdtempSync(join(tmpdir(), 'arrival-torn-'));
    try {
      const mintMs = Date.parse('2026-02-01T00:00:00.000Z');
      const fills = [
        row({ slotIndexId: sid(10, 0), tx: 'dev', userAddress: DEPLOYER, timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(10, 1), tx: 'bundle', userAddress: 'coord-a', timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(10, 2), tx: 'bundle', userAddress: 'coord-b', timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(10, 3), tx: 'solo', userAddress: 'outsider', amountSol: '1', baseAmount: '1000', timestamp: new Date(mintMs).toISOString() }),
        row({ slotIndexId: sid(12, 0), tx: 's1', userAddress: 'outsider', type: 'sell', amountSol: '4', baseAmount: '1000', timestamp: new Date(mintMs + 10_000).toISOString() }),
      ];
      const { client } = scriptedClient([pageBody(fills, false, null)]);
      const list = parseLaunchListRows([
        { deployer: DEPLOYER, mint: MINT, created_at: '2026-02-01 00:00:00.000 UTC', bonded: true, launches_total: 1 },
      ]);
      await runWalk({ out: dir, client, list, nowMs: Date.parse('2026-08-03T00:00:00Z') });

      const gz = join(dir, 'window', `${MINT}.jsonl.gz`);
      const lines = gunzipSync(readFileSync(gz)).toString('utf8').trimEnd().split('\n');
      writeFileSync(gz, gzipSync(`${lines.slice(0, -1).join('\n')}\n{"slot":12,"sid":"000`));

      const torn = readPersistedWindow(join(dir, 'window'), MINT)!;
      expect(torn.unreadable).toMatch(/could not be parsed/);
      const { rows, rankInput, unreadable } = runSeries({ out: dir, exposureBasis: BOUNDS.series.exposureBasis });
      expect(unreadable).toHaveLength(1);
      expect(rows[0]!.measured).toBe(false);
      // Unmeasured, never a zero: it reaches neither the rank test nor a deployer's observation span.
      expect(rankInput.launchesInRankTest).toBe(0);
      expect(rankInput.launchesUnmeasured).toBe(1);
      const arrival = JSON.parse(readFileSync(join(dir, 'arrival.json'), 'utf8'));
      expect(arrival.launchesUnreadable[0].mint).toBe(MINT);
      expect(arrival.launchesMeasured).toBe(0);

      // The SIDECAR tears just as easily as the fill file, and it is the worse half: with no
      // readable `created_timestamp` the row's date is NaN, and `new Date(NaN).toISOString()`
      // throws — which would abort the whole phase exactly as before the guard was added.
      writeFileSync(join(dir, 'window', `${MINT}.meta.json`), '{"mint":"x","created_time');
      const tornSidecar = readPersistedWindow(join(dir, 'window'), MINT)!;
      expect(tornSidecar.unreadable).toMatch(/sidecar could not be parsed/);
      const after = runSeries({ out: dir, exposureBasis: BOUNDS.series.exposureBasis });
      expect(after.unreadable).toHaveLength(1);
      expect(after.rows[0]!.measured).toBe(false);
      expect(Number.isFinite(after.rows[0]!.mintMs)).toBe(false);
      // The row is still written, with an EMPTY date rather than a thrown RangeError.
      const csv = readFileSync(join(dir, 'series.csv'), 'utf8').trim().split('\n');
      expect(csv).toHaveLength(2);
      expect(csv[1]!.split(',')[2]).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up on a launch it cannot prove after the pinned cap, and says so rather than retrying forever', async () => {
    // Retry-until-proved is not a bound. A mint the endpoint 404s, or one whose pages never say
    // nothing is older, would re-spend a whole per-launch budget on every sitting of a days-long
    // collection, ahead of launches never attempted.
    const dir = mkdtempSync(join(tmpdir(), 'arrival-cap-'));
    try {
      const mintMs = Date.parse('2026-02-01T00:00:00.000Z');
      const list = parseLaunchListRows([
        { deployer: DEPLOYER, mint: MINT, created_at: '2026-02-01 00:00:00.000 UTC', bonded: true, launches_total: 1 },
      ]);
      const nowMs = Date.parse('2026-08-03T00:00:00Z');
      const unprovable = pageBody([row({ slotIndexId: sid(500, 0), timestamp: new Date(mintMs + 10).toISOString() })], true, 'more');
      const windowDir = join(dir, 'window');

      const cap = BOUNDS.walk.maxWalkAttemptsPerLaunch;
      for (let attempt = 1; attempt <= cap; attempt++) {
        const { client } = scriptedClient([unprovable]);
        expect((await runWalk({ out: dir, client, list, nowMs })).walked, `sitting ${attempt}`).toBe(1);
        const meta = JSON.parse(readFileSync(join(windowDir, `${MINT}.meta.json`), 'utf8'));
        expect(meta.attempts).toBe(attempt);
        expect(meta.reached_mint).toBe(false);
        // It is given up on at the cap and NOT before: a transient failure still gets its retries.
        expect(typeof meta.given_up_reason === 'string', `sitting ${attempt}`).toBe(attempt === cap);
      }

      const capped = JSON.parse(readFileSync(join(windowDir, `${MINT}.meta.json`), 'utf8'));
      expect(capped.given_up_reason).toMatch(/stopped trying/);
      expect(capped.previous_attempts).toHaveLength(cap - 1);
      const state = checkpointState(windowDir, MINT);
      expect(state.done).toBe(true);
      expect(state.gaveUp).toBe(true);

      // The next sitting spends nothing on it.
      const { client: after } = scriptedClient([unprovable]);
      expect((await runWalk({ out: dir, client: after, list, nowMs })).walked).toBe(0);
      expect(after.issued()).toBe(0);

      // And giving up is REPORTED, not silent — while the launch still means UNMEASURED, not zero.
      const { rankInput, givenUp } = runSeries({ out: dir, exposureBasis: BOUNDS.series.exposureBasis });
      expect(givenUp.map((g) => g.mint)).toEqual([MINT]);
      expect(rankInput.launchesUnmeasured).toBe(1);
      expect(rankInput.launchesInRankTest).toBe(0);
      const arrival = JSON.parse(readFileSync(join(dir, 'arrival.json'), 'utf8'));
      expect(arrival.launchesGivenUpAtAttemptCap[0].mint).toBe(MINT);
      expect(arrival.launchesGivenUpAtAttemptCap[0].attempts).toBe(cap);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records every attempt it issues, refusals included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arrival-ledger-'));
    try {
      const { ledger } = await import('../tools/arrival-rate-walk/collect.mjs');
      const note = ledger(dir, 'walk');
      note({ url: `${SWAP_API}/v2/coins/${MINT}/trades?limit=100`, status: 429, ok: false, issued: 1, intervalMs: 4000 });
      note({ url: SOLANA_RPC, status: null, ok: false, issued: 2, intervalMs: 2500 });
      const csv = readFileSync(join(dir, 'requests.csv'), 'utf8').trim().split('\n');
      expect(csv[0]).toBe('phase,at_utc,host,mint,status,interval_ms');
      expect(csv[1]).toContain(`swap-api,${MINT},429`);
      expect(csv[2]).toContain('solana-rpc,,transport');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------

const TOOL_DIR = fileURLToPath(new URL('../tools/arrival-rate-walk/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const ANALYSIS_DIR = fileURLToPath(new URL('../analysis/', import.meta.url));

function readAll(dir: string, prefix: string, pattern = /\.(ts|mjs|js)$/): Map<string, string> {
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

describe('the keyless boundary holds around this tool', () => {
  it('opens a socket in exactly one file', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/arrival-rate-walk/')) {
      if (file === 'tools/arrival-rate-walk/client.mjs') continue;
      expect(/\bfetch\s*\(/.test(text), `${file} must not call fetch directly`).toBe(false);
    }
  });

  it('reaches exactly two hosts, both keyless, and never the one that 403s this client', () => {
    const all = readAll(TOOL_DIR, 'tools/arrival-rate-walk/', /\.(mjs|js)$/);
    const urls = new Set<string>();
    for (const text of all.values()) for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) urls.add(m[0]);
    expect([...urls].sort()).toEqual([SOLANA_RPC, SWAP_API].sort());
    for (const [file, text] of readAll(TOOL_DIR, 'tools/arrival-rate-walk/', /\.(mjs|js|md|json)$/)) {
      // `solana-rpc.publicnode.com` 403s this client on every request and the retry backoff hides
      // it — it stalled an earlier job for 40 minutes. It may be NAMED in prose as a warning.
      expect(/https?:\/\/[^\s'"]*publicnode/.test(text), `${file} must not build a publicnode URL`).toBe(false);
      expect(/https?:\/\/[^\s'"]*(madeonsol|helius)/i.test(text), `${file} must not reach a metered host`).toBe(false);
    }
  });

  it('names no credential and contains no key-shaped string — the allow-list here is EMPTY', () => {
    // Unlike `tools/deployer-screen/`, which has a credential module and an allowed list of files
    // that may name the variable, this tool has no keyed half at all. That is the guarantee: no
    // request from this directory can ever be metered, and the collector cannot spend money.
    for (const [file, text] of readAll(TOOL_DIR, 'tools/arrival-rate-walk/', /./)) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
      }
      expect(KEY_SHAPED.test(text), `${file} may contain a real key`).toBe(false);
    }
  });

  it('does not import src/, analysis/ or another tool, and is not imported by them', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/arrival-rate-walk/')) {
      expect(text, `${file} must not import from src/`).not.toMatch(/from\s+['"](\.\.\/)+src\//);
      expect(text, `${file} must not import from analysis/`).not.toMatch(/from\s+['"].*analysis\//);
      // The duplication with the two existing tools is deliberate: this collector runs for days and
      // must not be coupled to a file another lane is editing.
      expect(text, `${file} must not import from another tool`).not.toMatch(/from\s+['"][^'"]*(deployer-screen|graduated-life-tape)/);
    }
    for (const [file, text] of readAll(SRC_DIR, 'src/')) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
    for (const [file, text] of readAll(ANALYSIS_DIR, 'analysis/')) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
  });

  it('ships its method, its bounds and its pre-flight beside the code', () => {
    const files = [...readAll(TOOL_DIR, 'tools/arrival-rate-walk/', /./).keys()];
    expect(files).toContain('tools/arrival-rate-walk/README.md');
    expect(files).toContain('tools/arrival-rate-walk/bounds.json');
    expect(files).toContain('tools/arrival-rate-walk/preflight-2026-08-03.md');
    const readme = readFileSync(join(TOOL_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/gross of fees/i);
    expect(readme).toMatch(/## What this tool cannot answer/);
    // The saved-query dependency must be in the README, not only in a status line somewhere. It
    // was recorded here for a month as a BLOCKER — "the free tier's ten private query slots are
    // full" — and it was false: the account held eight. `COHORT_SQL` is deployed now, so what the
    // README owes a reader is where the statement runs and how the slot count is re-checked, not a
    // replacement number to take on faith.
    expect(readme).toMatch(/saved quer/i);
    expect(readme).toContain('tools/creation-census/');
    expect(readme, 'the README must not restate the stale slot-exhaustion claim').not.toMatch(
      /ten private query slots are\s+full/,
    );
  });

  it('keeps the zero-closed-pair caveat to ONE claim, scoped to the population it was measured over', () => {
    // The published "roughly a fifth" is measured over the 25 launches with no outsider in the
    // create slot at all; this lane excludes every launch with no CLOSED create-slot round trip,
    // which is wider. Quoting the narrower figure for the wider exclusion is the same error the
    // all-entrant caveat refuses when it declines to attach the blast report's 69-pairs figure to
    // this tape. The README quotes the constant verbatim so the two copies cannot drift.
    expect(ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT).toContain('25 launches with no outsider in the create slot AT ALL');
    expect(ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT).toContain('What is excluded here is wider');
    // Section 11's "moves neither break" and this lane's own reproduction both appear, because a
    // reader meeting either without the other will think one of them is wrong.
    expect(ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT).toContain('moves neither break');
    expect(ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT).toContain('no break is detected');
    expect(readFileSync(join(TOOL_DIR, 'README.md'), 'utf8')).toContain(ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT);
  });

  it('gives every pinned parameter a stated reason', () => {
    // The 2026-08-02 provenance audit on the screen found eight values with no stated reason at all.
    // "No measurement backs this, and here is what would" is acceptable; inventing an anchor is not.
    const groups = ['seed', 'walk', 'preflight', 'series', 'dune'] as const;
    for (const group of groups) {
      for (const key of Object.keys(BOUNDS[group])) {
        const reason = BOUNDS.justification[`${group}.${key}`];
        expect(typeof reason, `${group}.${key} has no justification`).toBe('string');
        expect(reason.length, `${group}.${key}'s justification is a stub`).toBeGreaterThan(80);
      }
    }
    // And nothing in a justification may quote curve_last_tx_s, which is a non-timing.
    expect(JSON.stringify(BOUNDS.justification)).not.toContain('curve_last_tx_s');
  });

  it('pins the pre-flight\'s own result where the slack is justified', () => {
    expect(BOUNDS.justification['walk.mintFloorSlackMs']).toMatch(/12 of 12/);
    expect(BOUNDS.walk.mintFloorSlackMs).toBeGreaterThan(SECOND_RESOLUTION_MS);
    expect(existsSync(join(TOOL_DIR, 'preflight-2026-08-03.md'))).toBe(true);
  });
});
