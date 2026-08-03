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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

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
  walletTotals,
} from '../tools/arrival-rate-walk/series.mjs';
import { changepoints, findWindows, median, summariseArrival } from '../tools/arrival-rate-walk/arrival.mjs';
import { BOUNDS, buildPlan, parseArgs, readPersistedWindow, runSeries, runWalk, toTapeRow } from '../tools/arrival-rate-walk/collect.mjs';
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

/** The §2.1 per-launch series, built from the committed CSVs exactly as the published measurement does. */
function publishedSeries(): { mint: string; symbol: string; date: string; mintMs: number; returnPerSol: number; prizeSol: number }[] {
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
  return [...byMint.values()]
    .filter((r) => r.trips > 0)
    .map((r) => ({ mint: r.mint, symbol: r.symbol, date: r.date, mintMs: Date.parse(r.date), returnPerSol: r.gross / r.stake, prizeSol: r.gross }))
    .sort((a, b) => a.mintMs - b.mintMs);
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
    // This is the whole design. readLaunchWindow seeks in MILLISECONDS and filters in SLOTS, and
    // nothing reconciles them but a nominal 400 ms/slot the chain has already drifted past.
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
    const summary = summariseArrival([found]);
    // Excluded from the denominator rather than counted as a deployer with no window.
    expect(summary.deployersSegmentable).toBe(0);
    expect(Number.isNaN(summary.windowsPerDeployerYear)).toBe(true);
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
    const plan = buildPlan({ cohortText: null, launchListText: JSON.stringify(rows), nowMs: Date.parse('2026-08-03T00:00:00Z') });
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
      launchListText: JSON.stringify([launchRow('m1', '2026-02-01 00:00:00.000 UTC', 99)]),
      nowMs: Date.parse('2026-08-03T00:00:00Z'),
    });
    expect(short.ok).toBe(false);
    expect(short.refusals.join(' ')).toMatch(/silently short/);

    const huge = [...Array(BOUNDS.walk.maxLaunchesPerDeployer + 1)].map((_, i) =>
      launchRow(`m${i}`, '2026-02-01 00:00:00.000 UTC', BOUNDS.walk.maxLaunchesPerDeployer + 1),
    );
    const over = buildPlan({ cohortText: null, launchListText: JSON.stringify(huge), nowMs: Date.parse('2026-08-03T00:00:00Z') });
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
      launchListText: JSON.stringify([launchRow('m1', '2026-02-01 00:00:00.000 UTC', 1)]),
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

  it('walks only forward from the seed month, so every deployer gets the same observation', () => {
    const rows = [
      launchRow('before', '2025-11-01 00:00:00.000 UTC', 3),
      launchRow('inside', '2026-02-01 00:00:00.000 UTC', 3),
      launchRow('future', '2027-01-01 00:00:00.000 UTC', 3),
    ];
    const plan = buildPlan({ cohortText: null, launchListText: JSON.stringify(rows), nowMs: Date.parse('2026-08-03T00:00:00Z') });
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

      const { rows, summary } = runSeries({ out: dir });
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

      // Re-running skips what is already on disk: an interruption costs the launch in flight.
      const { client: second } = scriptedClient([pageBody(fills, false, null)]);
      expect((await runWalk({ out: dir, client: second, list, nowMs: Date.parse('2026-08-03T00:00:00Z') })).walked).toBe(0);
      expect(second.issued()).toBe(0);
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
    // The one blocking dependency must be in the README, not only in a status line somewhere.
    expect(readme).toMatch(/saved quer/i);
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
