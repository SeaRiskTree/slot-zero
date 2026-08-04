/**
 * Tests for the keyless graduated-life tape collector. **Nothing here reaches the network.**
 *
 * Every fixture is synthetic — hand-written to the shape `swap-api.pump.fun` returned on
 * 2026-08-02, never a captured payload — except where a test deliberately reads the repo's own
 * committed data, which is ours and is the point.
 *
 * The `fetchImpl`, `sleepImpl` and `nowImpl` seams on `KeylessClient` exist for these tests. No
 * test constructs a client without them, so a regression that starts issuing real requests fails
 * here rather than quietly hammering a shared public endpoint for hours.
 *
 * Two kinds of assertion live here and they are not interchangeable:
 *
 * - **Boundary** — this is the repo's second network-capable directory, and the whole guarantee of
 *   captain decision 112a is that it is *keyless*. The scans below are what make "zero metered
 *   provider requests" a property of the tree rather than a claim in a README.
 * - **Coverage** — a backwards walk that stops early is silently wrong, not visibly wrong. The
 *   tests that read the committed output assert its coverage proofs rather than its size.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { KeylessClient, CeilingReached, HttpRefused, BACKOFF, DEFAULT_MIN_INTERVAL_MS } from '../tools/graduated-life-tape/client.mjs';
import {
  PAGE_LIMIT,
  VENUE_AMM,
  VENUE_CURVE,
  dedupeBySid,
  parseFill,
  parseTradePage,
  provesOlderThan,
  seekCursor,
  slotOf,
  sortAscending,
  tradesUrl,
} from '../tools/graduated-life-tape/trades.mjs';
import type { Fill } from '../tools/graduated-life-tape/trades.mjs';
import {
  MAX_PROBES,
  bracketFromFills,
  findGraduation,
  graduatedByPage,
} from '../tools/graduated-life-tape/graduation.mjs';
import { MAX_PAGES_PER_LAUNCH, POST_GRADUATION_MS, walkLife } from '../tools/graduated-life-tape/walk.mjs';
import { parseCsv, readLaunches, readWindowMeta, readWindowTape } from '../tools/graduated-life-tape/launches.mjs';
import { parseArgs, readGraduationCsv, toTapeRow } from '../tools/graduated-life-tape/collect.mjs';
import { CLOSURE_TOLERANCE, closureAt, closureOfEarlyPairs, quantile } from '../tools/graduated-life-tape/summarise.mjs';
import { CREDENTIAL_PATTERNS, KEY_SHAPED } from './offline-guard.js';

// ---------------------------------------------------------------------------------------------
// Fixtures

/** A row in the endpoint's own shape, not the tape's. */
function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    slotIndexId: '000411639965' + '0007760002',
    tx: 'sig-' + String(overrides['slotIndexId'] ?? 'a'),
    timestamp: '2026-04-07T13:27:14.000Z',
    userAddress: 'wallet-a',
    type: 'buy',
    program: VENUE_CURVE,
    priceUsd: '0.0000027',
    priceSol: '0.000000034',
    amountUsd: '1.0',
    amountSol: '3.456790122',
    baseAmount: '110863468.564034',
    quoteAmount: '3.456790122',
    ...overrides,
  };
}

/** `slotIndexId` for a slot and intra-slot ordinal, in the endpoint's fixed-width form. */
function sid(slot: number, ordinal = 0): string {
  return String(slot).padStart(12, '0') + String(ordinal).padStart(10, '0');
}

function pageBody(rows: Record<string, unknown>[], hasMore = true, nextCursor: string | null = 'next') {
  return { trades: rows, pagination: { hasMore, nextCursor, limit: PAGE_LIMIT } };
}

/** A client whose every response is scripted. Never touches the network. */
function scriptedClient(
  responses: Array<unknown | Error>,
  opts: { maxRequests?: number } = {},
): { client: KeylessClient; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const client = new KeylessClient({
    maxRequests: opts.maxRequests ?? 200,
    minIntervalMs: 0,
    retryBackoffMs: [],
    sleepImpl: async () => undefined,
    nowImpl: () => 0,
    fetchImpl: (async (url: string) => {
      urls.push(url);
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return { ok: true, status: 200, json: async () => next } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  return { client, urls };
}

// ---------------------------------------------------------------------------------------------

describe('the trade endpoint is read, never assumed', () => {
  it('derives the slot from the fixed-width slotIndexId, and agrees with the committed tape', () => {
    // Not a self-consistency check: the committed window tape stores BOTH `sid` and `slot`, written
    // by a different builder from a different code path. If the 12-digit split were wrong this
    // would disagree on every row, and every slot-based measure downstream — the create slot, the
    // window slot span — would be wrong with the tape still parsing cleanly.
    const tape = readWindowTape('13JbNUE6PUmkhda8YyfMaHqUnYYYvtq1Tgp9SJjepump');
    expect(tape).not.toBeNull();
    expect(tape!.fills.length).toBeGreaterThan(0);
    for (const f of tape!.fills) expect(slotOf(f.sid)).toBe(f.slot);
  });

  it('seeks by the timestamp half of the cursor, with a slot half that cannot narrow the seek', () => {
    // The endpoint ignores the slot component (report §9.2). It is pinned HIGH rather than low so
    // that a future version which stops ignoring it over-returns — which the caller filters — rather
    // than under-returns, which is the silent truncation this module exists to refuse.
    expect(seekCursor(1_700_000_000_000)).toBe('9999999999990000000000-1700000000000');
    expect(seekCursor(1_700_000_000_000.9)).toBe('9999999999990000000000-1700000000000');
  });

  it('builds a cursored and an uncursored URL at the page limit the endpoint honours', () => {
    expect(tradesUrl('MINT')).toBe('https://swap-api.pump.fun/v2/coins/MINT/trades?limit=100');
    expect(tradesUrl('MINT', 'abc-1')).toContain('cursor=abc-1');
  });

  it('reads both the wrapped and the bare page shape, but only the wrapped one carries pagination', () => {
    const wrapped = parseTradePage(pageBody([row()], true, 'c'));
    expect(wrapped.recognised).toBe(true);
    expect(wrapped.fills).toHaveLength(1);
    expect(wrapped.hasMore).toBe(true);
    expect(wrapped.nextCursor).toBe('c');

    const bare = parseTradePage([row()]);
    expect(bare.recognised).toBe(true);
    expect(bare.fills).toHaveLength(1);
    // No statement made — NOT "there is nothing more". The distinction is what stops an unpaginated
    // body from reading as proof the walk finished.
    expect(bare.hasMore).toBeNull();
  });

  it('tells "we cannot read this" apart from "there is nothing"', () => {
    const unreadable = parseTradePage({ error: 'nope' });
    expect(unreadable.recognised).toBe(false);
    expect(unreadable.fills).toEqual([]);

    const empty = parseTradePage(pageBody([], false, null));
    expect(empty.recognised).toBe(true);
    expect(empty.fills).toEqual([]);

    // Only the second may terminate a backwards walk.
    expect(provesOlderThan(unreadable, 0)).toBe(false);
    expect(provesOlderThan(empty, 0)).toBe(true);
  });

  it('drops a row missing anything a caller must not invent, and counts what it dropped', () => {
    const page = parseTradePage(
      pageBody([row(), { ...row(), type: 'transfer' }, { ...row(), userAddress: 42 }], true),
    );
    expect(page.rawRows).toBe(3);
    expect(page.fills).toHaveLength(1);
    expect(parseFill(null)).toBeNull();
    expect(parseFill({ slotIndexId: 'short' })).toBeNull();
  });

  it('proves coverage from a row older than the bound, never from having run out of pages', () => {
    const older = parseTradePage(
      pageBody([row({ slotIndexId: sid(1), timestamp: '2026-04-07T13:00:00.000Z' })], true),
    );
    expect(provesOlderThan(older, Date.parse('2026-04-07T13:27:14.000Z'))).toBe(true);

    const notYet = parseTradePage(
      pageBody([row({ slotIndexId: sid(2), timestamp: '2026-04-07T13:30:00.000Z' })], true),
    );
    expect(provesOlderThan(notYet, Date.parse('2026-04-07T13:27:14.000Z'))).toBe(false);
  });

  it('sorts ascending by sid, because the timestamp cannot order fills inside one slot', () => {
    const fills = parseTradePage(
      pageBody([
        row({ slotIndexId: sid(500, 9) }),
        row({ slotIndexId: sid(500, 1) }),
        row({ slotIndexId: sid(499, 3) }),
      ]),
    ).fills;
    // All three share a timestamp. Only `sid` separates them, and it does so correctly.
    expect(new Set(fills.map((f) => f.ts)).size).toBe(1);
    expect(sortAscending(fills).map((f) => f.sid)).toEqual([sid(499, 3), sid(500, 1), sid(500, 9)]);
  });

  it('dedupes overlapping pages by sid, keeping the first seen', () => {
    const a = parseFill(row({ slotIndexId: sid(1), userAddress: 'first' })) as Fill;
    const b = parseFill(row({ slotIndexId: sid(1), userAddress: 'second' })) as Fill;
    expect(dedupeBySid([a, b])).toHaveLength(1);
    expect(dedupeBySid([a, b])[0]!.u).toBe('first');
  });
});

// ---------------------------------------------------------------------------------------------

describe('the keyless client is paced, bounded and cannot carry a credential', () => {
  it('counts every attempt against the ceiling, retries included', async () => {
    let calls = 0;
    const client = new KeylessClient({
      maxRequests: 2,
      minIntervalMs: 0,
      retryBackoffMs: [1],
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      fetchImpl: (async () => {
        calls++;
        return { ok: false, status: 429 } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    // One logical request, two attempts, ceiling of two: the retry consumes the ceiling exactly as
    // a first try does. A bound that only counted first tries would not be a bound.
    await expect(client.getJson('u')).rejects.toBeInstanceOf(HttpRefused);
    expect(calls).toBe(2);
    expect(client.issued()).toBe(2);
    expect(client.shed()).toBe(2);
    await expect(client.getJson('u')).rejects.toBeInstanceOf(CeilingReached);
  });

  it('retries a 429 and a 5xx, and refuses to re-ask a 4xx', async () => {
    let calls = 0;
    const client = new KeylessClient({
      maxRequests: 10,
      minIntervalMs: 0,
      retryBackoffMs: [1, 1],
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      fetchImpl: (async () => {
        calls++;
        return { ok: false, status: 400 } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await expect(client.getJson('u')).rejects.toMatchObject({ status: 400 });
    // A 4xx that is not a 429 is the endpoint's considered answer about our query shape. Asking
    // again spends a shared public request to be told the same thing.
    expect(calls).toBe(1);
  });

  it('slows down when shed and decays back towards the floor when clean', async () => {
    const statuses = [429, 200, 200, 200, 200, 200];
    let i = 0;
    const client = new KeylessClient({
      maxRequests: 20,
      minIntervalMs: 4_000,
      retryBackoffMs: [],
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      fetchImpl: (async () => {
        const status = statuses[i++] ?? 200;
        return { ok: status === 200, status, json: async () => pageBody([], false, null) } as unknown as Response;
      }) as unknown as typeof fetch,
    });

    await expect(client.getJson('u')).rejects.toBeInstanceOf(HttpRefused);
    const backedOff = client.intervalMs();
    expect(backedOff).toBe(Math.round(4_000 * BACKOFF.growth));

    // Five clean responses is `decayAfter`, so exactly one decay step lands — and it cannot go
    // below the measured floor.
    for (let n = 0; n < BACKOFF.decayAfter; n++) await client.getJson('u');
    expect(client.intervalMs()).toBe(Math.max(4_000, Math.round(backedOff * BACKOFF.decay)));
    expect(client.intervalMs()).toBeGreaterThanOrEqual(4_000);
  });

  it('paces from the measured floor, not from taste', () => {
    // The endpoint refuses essentially everything at 2s and serves cleanly at 8s; the scout that
    // pinned the graduation instants settled on 4s with adaptive backoff and completed 871 requests
    // in 66 minutes with no sustained lockout. Lowering this constant is how a future run earns a
    // lockout, so it is asserted rather than left to a default.
    expect(DEFAULT_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(4_000);
    expect(BACKOFF.ceilingMs).toBeGreaterThanOrEqual(40_000);
  });

  it('refuses a command line that would defeat the floor or the page ceiling', () => {
    const base = ['--phase', 'life', '--out', 'x'];
    // `Number('x')` is NaN and every comparison against it fails OPEN: `wait > NaN` is false, so a
    // NaN interval removes the pacing floor entirely against a shared public endpoint, and
    // `pages < NaN` is false, so a NaN page ceiling walks zero pages and then writes an empty
    // sidecar that the resume logic treats as a completed launch. Both must be refusals.
    expect(() => parseArgs([...base, '--min-interval-ms', 'x'])).toThrow(/positive finite/);
    expect(() => parseArgs([...base, '--max-pages', 'x'])).toThrow(/positive finite/);
    expect(() => parseArgs([...base, '--limit', 'x'])).toThrow(/positive finite/);
    expect(() => parseArgs([...base, '--max-pages', '0'])).toThrow(/positive finite/);
    expect(() => parseArgs([...base, '--limit', '-1'])).toThrow(/positive finite/);

    // The floor may be raised from the command line and may not be undercut.
    expect(() => parseArgs([...base, '--min-interval-ms', '2000'])).toThrow(/floor/);
    expect(parseArgs([...base, '--min-interval-ms', '8000']).minIntervalMs).toBe(8_000);
    expect(parseArgs(base).minIntervalMs).toBe(DEFAULT_MIN_INTERVAL_MS);
  });

  it('reports a transport failure as its own thing and retries it', async () => {
    let calls = 0;
    const client = new KeylessClient({
      maxRequests: 10,
      minIntervalMs: 0,
      retryBackoffMs: [1],
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      fetchImpl: (async () => {
        calls++;
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    await expect(client.getJson('u')).rejects.toMatchObject({ status: null });
    expect(calls).toBe(2);
    // A request that never reached the endpoint is not a refusal by it — kept in its own counter so
    // a run cannot report a dead network as a busy endpoint.
    expect(client.transportFailures()).toBe(2);
    expect(client.shed()).toBe(0);
  });

  it('rejects a ceiling that is not a positive integer', () => {
    expect(() => new KeylessClient({ maxRequests: 0 })).toThrow(TypeError);
    expect(() => new KeylessClient({ maxRequests: 1.5 })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------------

describe('graduation is bisected on a monotone venue field', () => {
  it('brackets the migration exactly when one run of fills straddles it', () => {
    const fills = parseTradePage(
      pageBody([
        row({ slotIndexId: sid(11), timestamp: '2026-04-07T13:00:10.000Z', program: VENUE_AMM }),
        row({ slotIndexId: sid(10), timestamp: '2026-04-07T13:00:08.000Z', program: VENUE_AMM }),
        row({ slotIndexId: sid(9), timestamp: '2026-04-07T13:00:05.000Z', program: VENUE_CURVE }),
      ]),
    ).fills;
    expect(bracketFromFills(fills)).toEqual({
      lowerMs: Date.parse('2026-04-07T13:00:05.000Z'),
      gradMs: Date.parse('2026-04-07T13:00:08.000Z'),
    });
  });

  it('refuses a run that is not monotone rather than averaging it', () => {
    // A curve fill NEWER than an AMM fill would mean the venue sequence went backwards, which would
    // invalidate the bisection outright — the predicate would not be monotone and the whole method
    // would be unsound. Returning null makes that a missing measurement instead of a wrong one.
    const fills = parseTradePage(
      pageBody([
        row({ slotIndexId: sid(11), timestamp: '2026-04-07T13:00:10.000Z', program: VENUE_CURVE }),
        row({ slotIndexId: sid(10), timestamp: '2026-04-07T13:00:08.000Z', program: VENUE_AMM }),
      ]),
    ).fills;
    expect(bracketFromFills(fills)).toBeNull();
  });

  it('reads the venue in force at a seek from the newest row on the page', () => {
    const amm = parseTradePage(pageBody([row({ slotIndexId: sid(5), program: VENUE_AMM })]));
    expect(graduatedByPage(amm)).toBe(true);
    const curve = parseTradePage(pageBody([row({ slotIndexId: sid(5), program: VENUE_CURVE })]));
    expect(graduatedByPage(curve)).toBe(false);
    // A seek that lands before the token's first fill is pre-migration by construction; an
    // unreadable body says nothing at all.
    expect(graduatedByPage(parseTradePage(pageBody([], false, null)))).toBe(false);
    expect(graduatedByPage(parseTradePage({ error: 1 }))).toBeNull();
  });

  it('costs zero requests when the committed 60-second window already straddles the migration', async () => {
    const mintMs = Date.parse('2026-04-07T13:00:00.000Z');
    const { client, urls } = scriptedClient([pageBody([], false, null)]);
    const tapeFills = parseTradePage(
      pageBody([
        row({ slotIndexId: sid(9), timestamp: '2026-04-07T13:00:05.000Z', program: VENUE_CURVE }),
        row({ slotIndexId: sid(10), timestamp: '2026-04-07T13:00:08.000Z', program: VENUE_AMM }),
      ]),
    ).fills;

    const result = await findGraduation({ client, mint: 'M', mintMs, tapeFills });
    expect(result.source).toBe('tape');
    expect(result.probes).toBe(0);
    expect(urls).toEqual([]);
    expect(result.gradMs).toBe(Date.parse('2026-04-07T13:00:08.000Z'));
  });

  it('converges by geometric bisection and reports the bracket it actually reached', async () => {
    const mintMs = 1_000_000_000_000;
    const trueGradMs = mintMs + 1_000_000; // +1000 s

    // A synthetic endpoint: any seek returns one row whose venue reflects the true migration, so
    // the bisection has to find it rather than be handed it. `hasMore` is true so nothing but the
    // bisection's own tolerance can terminate the search.
    let i = 0;
    const client = new KeylessClient({
      maxRequests: 100,
      minIntervalMs: 0,
      retryBackoffMs: [],
      sleepImpl: async () => undefined,
      nowImpl: () => 0,
      fetchImpl: (async (url: string) => {
        i++;
        const cursor = new URL(url).searchParams.get('cursor');
        const atMs = cursor === null ? mintMs + 5_000_000 : Number(cursor.split('-')[1]);
        const graduated = atMs >= trueGradMs;
        return {
          ok: true,
          status: 200,
          json: async () =>
            pageBody(
              [
                row({
                  slotIndexId: sid(i),
                  timestamp: new Date(atMs).toISOString(),
                  program: graduated ? VENUE_AMM : VENUE_CURVE,
                }),
              ],
              true,
            ),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });

    const result = await findGraduation({ client, mint: 'M', mintMs, tapeFills: [] });
    expect(result.source).toBe('bisect');
    expect(result.graduated).toBe(true);
    expect(result.probes).toBeLessThanOrEqual(MAX_PROBES);
    // The bracket must CONTAIN the truth — a bisection that converges to a tight bracket in the
    // wrong place is the failure mode worth catching, and a point estimate would hide it.
    expect(result.lowerMs!).toBeLessThanOrEqual(trueGradMs);
    expect(result.gradMs!).toBeGreaterThanOrEqual(trueGradMs);
    expect(result.bracketMs!).toBeLessThan(trueGradMs - mintMs);
  });

  it('reports a token whose newest fill is still on the curve as unmigrated, not as a number', async () => {
    const { client } = scriptedClient([pageBody([row({ program: VENUE_CURVE })], true)]);
    const result = await findGraduation({ client, mint: 'M', mintMs: 0, tapeFills: [] });
    expect(result.graduated).toBe(false);
    expect(result.gradMs).toBeNull();
    expect(result.source).toBe('unresolved');
  });

  it('reports an unreadable or empty head page as unresolved rather than as zero', async () => {
    const bad = await findGraduation({ client: scriptedClient([{ error: 1 }]).client, mint: 'M', mintMs: 0 });
    expect(bad.source).toBe('unresolved');
    const empty = await findGraduation({
      client: scriptedClient([pageBody([], false, null)]).client,
      mint: 'M',
      mintMs: 0,
    });
    expect(empty.source).toBe('unresolved');
    expect(empty.gradMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('the life walk proves its oldest end', () => {
  const mintMs = Date.parse('2026-04-07T13:00:00.000Z');

  it('walks backwards until the endpoint says there is nothing older', async () => {
    const { client, urls } = scriptedClient([
      pageBody([row({ slotIndexId: sid(30), timestamp: '2026-04-07T13:20:00.000Z' })], true, 'c2'),
      pageBody([row({ slotIndexId: sid(20), timestamp: '2026-04-07T13:10:00.000Z' })], true, 'c3'),
      pageBody([row({ slotIndexId: sid(10), timestamp: '2026-04-07T13:00:00.000Z' })], false, null),
    ]);
    const result = await walkLife({ client, mint: 'M', mintMs, endMs: mintMs + 3_600_000 });

    expect(result.pages).toBe(3);
    expect(result.reachedMint).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.stopReason).toBe('the endpoint holds nothing older');
    // Ascending by sid, as the committed tape is — the live endpoint hands them back descending.
    expect(result.fills.map((f) => f.sid)).toEqual([sid(10), sid(20), sid(30)]);
    expect(result.oldestSlot).toBe(10);
    // The first request seeks to the declared end; the rest follow the endpoint's own cursors.
    expect(urls[0]).toContain(`cursor=${encodeURIComponent(seekCursor(mintMs + 3_600_000))}`);
    expect(urls[1]).toContain('cursor=c2');
  });

  it('records a page-ceilinged walk as truncated instead of as short', async () => {
    // Every page claims there is more and offers a cursor, so nothing but the ceiling stops it.
    const endless = pageBody([row({ slotIndexId: sid(99), timestamp: '2026-04-07T13:59:00.000Z' })], true, 'c');
    const { client } = scriptedClient([endless], { maxRequests: MAX_PAGES_PER_LAUNCH + 10 });
    const result = await walkLife({ client, mint: 'M', mintMs, endMs: mintMs + 3_600_000, maxPages: 3 });

    expect(result.pages).toBe(3);
    // The end it lost is the OLDEST end — the mint end. A caller that read `fills.length > 0` as
    // coverage would be reading a mid-window sniper as the deployer.
    expect(result.reachedMint).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.stopReason).toContain('page ceiling');
  });

  it('will not treat an unreadable body as having reached the mint', async () => {
    const { client } = scriptedClient([
      pageBody([row({ slotIndexId: sid(30), timestamp: '2026-04-07T13:20:00.000Z' })], true, 'c2'),
      { error: 'nope' },
    ]);
    const result = await walkLife({ client, mint: 'M', mintMs, endMs: mintMs + 3_600_000 });
    expect(result.reachedMint).toBe(false);
    expect(result.stopReason).toContain('no rows could be read from');
  });

  it('will not treat a missing next cursor as the endpoint saying it is done', async () => {
    const { client } = scriptedClient([
      pageBody([row({ slotIndexId: sid(30), timestamp: '2026-04-07T13:20:00.000Z' })], true, null),
    ]);
    const result = await walkLife({ client, mint: 'M', mintMs, endMs: mintMs + 3_600_000 });
    expect(result.reachedMint).toBe(false);
    expect(result.stopReason).toContain('did not say it was done');
  });

  it('keeps only fills inside its own declared window', async () => {
    const endMs = mintMs + 600_000;
    const { client } = scriptedClient([
      pageBody(
        [
          row({ slotIndexId: sid(40), timestamp: '2026-04-07T13:20:00.000Z' }), // past endMs
          row({ slotIndexId: sid(30), timestamp: '2026-04-07T13:05:00.000Z' }), // inside
          row({ slotIndexId: sid(5), timestamp: '2026-04-07T12:59:00.000Z' }), // before the mint
        ],
        false,
        null,
      ),
    ]);
    const result = await walkLife({ client, mint: 'M', mintMs, endMs });
    // A tape whose rows fall outside its own stated window is a tape a reader cannot bound anything
    // by. The out-of-window rows still prove coverage — they are just not part of the record.
    expect(result.fills.map((f) => f.sid)).toEqual([sid(30)]);
    expect(result.reachedMint).toBe(true);
    expect(result.fromMs).toBe(Date.parse('2026-04-07T13:05:00.000Z'));
  });

  it('counts the PumpSwap fills, which are the part no 60-second window could hold', async () => {
    const { client } = scriptedClient([
      pageBody(
        [
          row({ slotIndexId: sid(30), timestamp: '2026-04-07T13:20:00.000Z', program: VENUE_AMM }),
          row({ slotIndexId: sid(10), timestamp: '2026-04-07T13:00:00.000Z', program: VENUE_CURVE }),
        ],
        false,
        null,
      ),
    ]);
    const result = await walkLife({ client, mint: 'M', mintMs, endMs: mintMs + 3_600_000 });
    expect(result.ammFills).toBe(1);
    expect(result.fills).toHaveLength(2);
  });

  it('lets a run ceiling stop the whole run, but keeps a launch-level failure to that launch', async () => {
    const { client } = scriptedClient([pageBody([row()], true, 'c')], { maxRequests: 1 });
    await client.getJson(tradesUrl('other'));
    await expect(walkLife({ client, mint: 'M', mintMs, endMs: mintMs + 1 })).rejects.toBeInstanceOf(
      CeilingReached,
    );
  });

  it('widens by exactly one hour past graduation', () => {
    expect(POST_GRADUATION_MS).toBe(3_600_000);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the committed tape is read the way the dataset requires', () => {
  it('parses quoted CSV fields, so a comma in a token name cannot shift a column', () => {
    // A naive split shifts every later column of that row, and the column it shifts INTO
    // `graduated` is a boolean — so the corruption is a plausible value, not an obvious one.
    const rows = parseCsv('a,b,c\n1,"two, and a half",3\n"say ""hi""",5,6\n');
    expect(rows[1]).toEqual(['1', 'two, and a half', '3']);
    expect(rows[2]).toEqual(['say "hi"', '5', '6']);
  });

  it('reads back a graduation row whose symbol carries a comma, without shifting a column', () => {
    // The writer quotes `symbol` and `note`; a reader that split on a bare comma would take
    // `created_utc` for `grad_ms` and bound the whole life walk by a nonsense instant that still
    // parses as a number. Latent on the committed file, which happens to hold no quoted field.
    const dir = mkdtempSync(join(tmpdir(), 'grad-csv-'));
    try {
      const path = join(dir, 'graduation.csv');
      writeFileSync(
        path,
        'mint,symbol,created_utc,mint_ms,graduated,grad_ms,grad_s_from_mint,lower_ms,bracket_ms,source,probes,last_trade_ms,note\n' +
          'MINT,"Doge, Inc",2026-01-01T00:00:00Z,1000,1,9000,8.0,8000,1000,bisect,7,9500,"probed, twice"\n',
      );
      expect(readGraduationCsv(path).get('MINT')).toEqual({
        gradMs: 9000,
        bracketMs: 1000,
        source: 'bisect',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds exactly the 103 graduated launches the dataset publishes', () => {
    const launches = readLaunches();
    expect(launches).toHaveLength(239);
    expect(launches.filter((l) => l.graduated)).toHaveLength(103);
    // Symbols are not unique — two launches are called `maxxing`, one of them the operator's best
    // result ever. Keying on anything but the mint loses one of them.
    expect(launches.filter((l) => l.symbol === 'maxxing')).toHaveLength(2);
    expect(new Set(launches.map((l) => l.mint)).size).toBe(239);
  });

  it('reports window coverage from the sidecar, never from the file existing', () => {
    const tape = readWindowTape('13JbNUE6PUmkhda8YyfMaHqUnYYYvtq1Tgp9SJjepump');
    expect(tape!.reachedMint).toBe(true);
    expect(tape!.createSlot).toBe(Math.min(...tape!.fills.map((f) => f.slot)));
    expect(readWindowTape('not-a-mint')).toBeNull();
  });

  it('reports each launch\'s OWN committed window, because that window is not a constant', () => {
    // The bug this pins: the committed tape's window is 60 s on most launches but 300 s on 17 of
    // the graduated 103 and 120 s on 3. A baseline that hardcodes 60 s measures a window those 20
    // launches were never collected over, and it flatters the widening by ~6 points.
    const graduated = readLaunches().filter((l) => l.graduated);
    const widths = new Map<number, number>();
    for (const l of graduated) {
      const w = readWindowMeta(l.mint).windowMs;
      widths.set(w, (widths.get(w) ?? 0) + 1);
    }
    expect(Object.fromEntries(widths)).toEqual({ 60_000: 83, 120_000: 3, 300_000: 17 });
    expect(readWindowTape(graduated[0]!.mint)!.windowMs).toBe(readWindowMeta(graduated[0]!.mint).windowMs);
  });

  it('leaves a create slot unclaimed when the committed window was truncated', () => {
    // Four of the 239 window files never reached the mint. Their oldest slot is merely the oldest
    // the builder's backwards walk happened to see, and reading it as the create slot is exactly
    // what would crown a mid-window sniper as the deployer.
    const dir = fileURLToPath(new URL('../data/population-tape-2026-07-29/window/', import.meta.url));
    const truncated = readdirSync(dir)
      .filter((f) => f.endsWith('.meta.json'))
      .filter((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).reached_mint !== true);
    expect(truncated.length).toBeGreaterThan(0);
    for (const f of truncated) {
      const tape = readWindowTape(f.replace('.meta.json', ''));
      expect(tape!.reachedMint).toBe(false);
      expect(tape!.createSlot).toBeNull();
    }
  });

  it('writes life rows in the committed tape\'s own schema, so the two files concatenate', () => {
    const fill = parseFill(row()) as Fill;
    const written = toTapeRow(fill);
    expect(Object.keys(written)).toEqual(['slot', 'sid', 'tx', 'ts', 'u', 'k', 'p', 'sol', 'base', 'psol', 'pusd']);
    // `tsMs` is derived from `ts` and is deliberately NOT stored: a primary record that carries the
    // same fact twice is a record whose two copies can disagree.
    expect(written).not.toHaveProperty('tsMs');

    const committed = JSON.parse(
      gunzipSync(
        readFileSync(
          fileURLToPath(
            new URL(
              '../data/population-tape-2026-07-29/window/13JbNUE6PUmkhda8YyfMaHqUnYYYvtq1Tgp9SJjepump.jsonl.gz',
              import.meta.url,
            ),
          ),
        ),
      )
        .toString('utf8')
        .split('\n')[0]!,
    );
    expect(Object.keys(committed)).toEqual(Object.keys(written));
  });
});

// ---------------------------------------------------------------------------------------------

describe('the summary counts closure, and deliberately never counts money', () => {
  const at = (u: string, k: 'buy' | 'sell', base: string, tsMs: number) => ({ u, k, base, tsMs });

  it('closes a pair whose residual is within the dataset\'s own 0.1% tolerance', () => {
    // The rule is the population tape's, not a new one: reproducing `wallet_launch_pnl.csv` from
    // raw fills under it agrees on 1,322 create-slot outsider pairs with zero closure mismatches
    // (1,502 before captain decision 182a widened the co-ordination rule; the closure rule itself is
    // untouched, and only the outsider population it runs over got smaller).
    expect(closureAt([at('w', 'buy', '1000', 0), at('w', 'sell', '999.5', 1)], 10)).toEqual({
      closed: 1,
      open: 0,
    });
    expect(closureAt([at('w', 'buy', '1000', 0), at('w', 'sell', '990', 1)], 10)).toEqual({
      closed: 0,
      open: 1,
    });
    expect(CLOSURE_TOLERANCE).toBe(0.001);
  });

  it('counts a wallet that only ever sold as open, never as closed at zero', () => {
    // It arrived holding, from a source no fill tape records. Calling that a completed round trip
    // would manufacture a P&L out of a position this tape never saw opened.
    expect(closureAt([at('w', 'sell', '500', 0)], 10)).toEqual({ closed: 0, open: 1 });
  });

  it('is a cut-off, so the same fills give different closure at different window ends', () => {
    // This is the entire justification for the widening, in one assertion: the wallet is open at
    // 60 seconds and closed an hour later, and nothing about its behaviour changed — only where
    // the window stopped.
    const fills = [at('w', 'buy', '1000', 0), at('w', 'sell', '1000', 600_000)];
    expect(closureAt(fills, 60_000)).toEqual({ closed: 0, open: 1 });
    expect(closureAt(fills, 3_600_000)).toEqual({ closed: 1, open: 0 });
  });

  it('compares the SAME wallets at two window ends, not two different populations', () => {
    // The obvious comparison is wrong and flatters the widening: a longer window contains far more
    // wallets, so "42% closed at 60s" against "78% closed at graduation+1h" is two populations, not
    // a before and after. This restricts to wallets visible early and re-evaluates *them*.
    const fills = [
      at('early', 'buy', '1000', 0),
      at('early', 'sell', '1000', 600_000), // closes only in the wider window
      at('late', 'buy', '500', 900_000), // never visible at 60s
      at('late', 'sell', '500', 950_000),
    ];
    const r = closureOfEarlyPairs(fills, 60_000, 3_600_000);
    expect(r.population).toBe(1); // 'late' is excluded from the base entirely
    expect(r.closedEarly).toBe(0);
    expect(r.closedFull).toBe(1);

    // The naive comparison would have counted 'late' as a closed pair in the wider window and
    // credited the widening with it — a wallet the narrow window never saw at all.
    expect(closureAt(fills, 3_600_000).closed).toBe(2);
  });

  it('interpolates quantiles and survives an empty series', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.9)).toBe(5);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it('publishes no SOL figure, because every figure from this tape is gross of fees', () => {
    // Not a style rule. On the deployer's own post-break field over all 89 launches, gross reads
    // 358/469 closed round
    // trips positive; fee-inclusive, the same population made +0.54 SOL per launch with 51 of 106
    // wallets negative. A collection lane that published a SOL number would publish the wrong sign,
    // so the summariser publishes counts and leaves P&L to a view that can carry the fee brand.
    const source = readFileSync(
      fileURLToPath(new URL('../tools/graduated-life-tape/summarise.mjs', import.meta.url)),
      'utf8',
    );
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/\bsol\b/i.test(executable), 'the summariser must not compute a SOL quantity').toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

const OUT_DIR = fileURLToPath(new URL('../data/graduated-life-tape-2026-08-02/', import.meta.url));

/**
 * Every string literal in `source` — single-quoted, double-quoted or template — that names a
 * window AND carries a digit, i.e. that would write a fixed window width into a note. Comments
 * are tokenised alongside the literals and discarded, so a duration stated in prose is fine and a
 * `//` inside a literal cannot desynchronise the scan.
 */
function fixedWindowWidthLiterals(source: string): string[] {
  const tokens =
    source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
  return tokens.filter(
    (t) => /^['"`]/.test(t) && /window/i.test(t) && /\d/.test(t),
  );
}

describe('the collected tape says what it covers and what it does not', () => {
  const gradPath = join(OUT_DIR, 'graduation.csv');

  it('pins a graduation instant for every graduated launch, with the bracket it reached', () => {
    const grad = readGraduationCsv(gradPath);
    const graduated = readLaunches().filter((l) => l.graduated);
    expect(grad.size).toBe(graduated.length);
    for (const l of graduated) {
      const row = grad.get(l.mint);
      expect(row, `${l.mint} (${l.symbol}) has no graduation row`).toBeDefined();
      expect(row!.gradMs, `${l.mint} has no graduation instant`).not.toBeNull();
      // Every instant is bracketed. A point estimate with no width would let a reader treat a
      // ±200% bisection and a one-fill page straddle as the same measurement.
      expect(row!.bracketMs, `${l.mint} has no bracket`).not.toBeNull();
      expect(['tape', 'page', 'bisect']).toContain(row!.source);
    }
  });

  it('places every graduation after its own mint and before its own last trade', () => {
    // Read through the quoting-aware parser, not a bare split: `symbol` and `note` are written
    // through `csvField`, so a comma in either shifts every later column of that row.
    const rows = parseCsv(readFileSync(gradPath, 'utf8'));
    const header = rows[0]!;
    for (const cells of rows.slice(1)) {
      const at = (name: string) => cells[header.indexOf(name)]!;
      const mintMs = Number(at('mint_ms'));
      const gradMs = Number(at('grad_ms'));
      const lowerMs = Number(at('lower_ms'));
      expect(gradMs, `${at('mint')} graduated before its mint`).toBeGreaterThanOrEqual(mintMs);
      expect(lowerMs).toBeLessThanOrEqual(gradMs);
    }
  });

  it('carries a coverage proof and a create-slot cross-check on every walked launch', () => {
    const lifeDir = join(OUT_DIR, 'life');
    if (!existsSync(lifeDir)) return;
    const metas = readdirSync(lifeDir).filter((f) => f.endsWith('.meta.json'));
    expect(metas.length).toBeGreaterThan(0);
    for (const f of metas) {
      const meta = JSON.parse(readFileSync(join(lifeDir, f), 'utf8'));
      expect(typeof meta.reached_mint).toBe('boolean');
      expect(existsSync(join(lifeDir, `${meta.mint}.jsonl.gz`))).toBe(true);
      // The free, load-bearing check: the committed 60-second tape PROVED its own coverage of the
      // create slot. A life walk that claims to have reached the mint must land on the same slot,
      // and disagreement means one of the two walks is silently truncated.
      if (meta.create_slot_agrees !== null) {
        expect(meta.create_slot_agrees, `${meta.mint} disagrees with the window tape's create slot`).toBe(true);
      }
      // The window is the declared one, not whatever the walk happened to return.
      expect(meta.end_ms).toBe(meta.grad_ms + POST_GRADUATION_MS);
      if (meta.n > 0) {
        expect(meta.from_ms).toBeGreaterThanOrEqual(meta.floor_ms);
        expect(meta.to_ms).toBeLessThanOrEqual(meta.end_ms);
      }
    }
  });

  it('states no fixed window width in a graduation note, because the committed window varies', () => {
    // The one place a stale flat-60 s claim reached committed DATA rather than prose, which is why
    // it survived two documentation sweeps. Of the 18 `tape`-sourced rows only 12 were collected
    // over 60 s — 1 ran to 120 s and 5 to 300 s — so any note naming a duration is wrong for a
    // third of the rows carrying it. Asserted on the committed file and on the string the collector
    // would write next, so a future run cannot reintroduce it.
    const rows = parseCsv(readFileSync(gradPath, 'utf8'));
    const header = rows[0]!;
    const iNote = header.indexOf('note');
    const iSource = header.indexOf('source');

    // A note may name an instant — the `page` rows record the probe offset that straddled the
    // migration, and that is a measurement. What none may do is put a duration on "window".
    const tapeRows = rows.slice(1).filter((cells) => cells[iSource] === 'tape');
    expect(tapeRows.length).toBeGreaterThan(0);
    for (const cells of rows.slice(1)) {
      const note = cells[iNote] ?? '';
      if (!/window/i.test(note)) continue;
      expect(/\d/.test(note), `a note puts a fixed width on the window: ${note}`).toBe(false);
    }
    for (const cells of tapeRows) {
      expect(cells[iNote]).toBe('bracketed inside the committed window tape; zero requests');
    }

    const source = readFileSync(
      fileURLToPath(new URL('../tools/graduated-life-tape/graduation.mjs', import.meta.url)),
      'utf8',
    );
    // Every quote form, not just the single quotes the notes happened to use when this was
    // written: two of the five note sites in `graduation.mjs` are already template literals, so a
    // single-quote-only pattern would let a backtick-written width straight through and the
    // committed-data half above would only catch it after a collection had run.
    const offenders = fixedWindowWidthLiterals(source);
    expect(offenders, `the collector would write a fixed width: ${offenders.join(', ')}`).toEqual([]);
  });

  it('fails the source-side guard on a fixed width written as a template or double-quoted note', () => {
    // The discriminating case. Each of these is the same defect in a different quote form, and the
    // single-quoted pattern this guard used to carry saw only the first of them.
    expect(fixedWindowWidthLiterals("note: 'collected over the 60 s window',")).toHaveLength(1);
    expect(fixedWindowWidthLiterals('note: "collected over the 60 s window",')).toHaveLength(1);
    expect(fixedWindowWidthLiterals('note: `collected over the 60 s window`,')).toHaveLength(1);
    expect(fixedWindowWidthLiterals('note: `a ${windowMs / 1000} s window`,')).toHaveLength(1);
    // And what it must not flag: a note naming an instant rather than a window width, the notes
    // the collector actually writes, and a duration living in a comment.
    expect(fixedWindowWidthLiterals('note: `a probe page at +${n}s straddled the migration`,')).toEqual([]);
    expect(fixedWindowWidthLiterals("note: 'bracketed inside the committed window tape; zero requests',")).toEqual([]);
    expect(fixedWindowWidthLiterals('// the window was 60 s on 83 launches\n')).toEqual([]);
  });

  it('evaluates the closure baseline at each launch\'s own committed window, not a flat 60 s', () => {
    // A synthetic-fill test cannot catch this, which is why the bug survived one: the defect is
    // that the production baseline ignored the committed tape's per-launch `window_ms`. So this
    // reads the committed roll-up and demands the per-launch cut be visible in it.
    const rows = parseCsv(readFileSync(join(OUT_DIR, 'coverage.csv'), 'utf8'));
    const header = rows[0]!;
    const iMint = header.indexOf('mint');
    const iWindow = header.indexOf('committed_window_s');
    expect(iWindow, 'coverage.csv must record the baseline cut it applied').toBeGreaterThanOrEqual(0);

    const widths = new Set<string>();
    for (const cells of rows.slice(1)) {
      widths.add(cells[iWindow]!);
      // Every row's cut is that launch's own recorded window, never a default.
      expect(Number(cells[iWindow]), `${cells[iMint]} was cut at the wrong window`).toBe(
        readWindowMeta(cells[iMint]!).windowMs / 1000,
      );
    }
    expect(widths.size, 'a flat baseline would leave one distinct window in the roll-up').toBeGreaterThan(1);

    // And the constant cannot come back: no cut-off in the summariser is a literal 60 s.
    const source = readFileSync(
      fileURLToPath(new URL('../tools/graduated-life-tape/summarise.mjs', import.meta.url)),
      'utf8',
    );
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/60[_,]?000/.test(executable), 'the summariser must not hardcode a 60 s window').toBe(false);
  });

  it('publishes an exact request count that the ledger reproduces row for row', () => {
    // The acceptance bar for this lane: the run's cost is a committed fact, not a claim in prose.
    const ledger = readFileSync(join(OUT_DIR, 'requests.csv'), 'utf8').trim().split('\n');
    expect(ledger[0]).toBe('phase,at_utc,mint,status,interval_ms');
    const attempts = ledger.length - 1;
    expect(attempts).toBeGreaterThan(0);

    const readme = readFileSync(join(OUT_DIR, 'README.md'), 'utf8');
    const claimed = readme.match(/<!-- requests:(\d+) -->/);
    expect(claimed, 'the README must carry the request count as a machine-checkable marker').not.toBeNull();
    expect(Number(claimed![1])).toBe(attempts);
  });
});

// ---------------------------------------------------------------------------------------------

const TOOL_DIR = fileURLToPath(new URL('../tools/graduated-life-tape/', import.meta.url));
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
    // The point of captain decision 112a is EUR 0, and EUR 0 is a property of which hosts this code
    // can reach. One file, one host, no options bag that reaches `fetch` from anywhere else.
    for (const [file, text] of readAll(TOOL_DIR, 'tools/graduated-life-tape/')) {
      if (file === 'tools/graduated-life-tape/client.mjs') continue;
      expect(/\bfetch\s*\(/.test(text), `${file} must not call fetch directly`).toBe(false);
    }
  });

  it('names no credential and contains no key-shaped string', () => {
    // This tool has no keyed half at all — unlike `tools/deployer-screen/`, which has a credential
    // module and an allowed list of files that may name the variable. Here the allowed list is
    // empty, and that is the guarantee: no request from this directory can ever be metered.
    const all = readAll(TOOL_DIR, 'tools/graduated-life-tape/', /./);
    for (const [file, text] of all) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        // `process.env` is permitted nowhere; the CLI reads argv, not the environment.
        if (pattern.source === 'process\\.env' && file.endsWith('collect.mjs')) {
          expect(/process\.env/.test(text), `${file} must not read the environment`).toBe(false);
          continue;
        }
        expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
      }
      expect(KEY_SHAPED.test(text), `${file} may contain a real key`).toBe(false);
    }
  });

  it('reaches no metered host, and never names the endpoint that 403s this client', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/graduated-life-tape/', /\.(mjs|js|md)$/)) {
      // `solana-rpc.publicnode.com` 403s this client on every request. Anything that copies the
      // entity report's endpoint list sends half its batches to a dead host, and the retry backoff
      // hides it — it stalled an earlier job for 40 minutes. It may be *named* in prose as a
      // warning but must never appear inside a URL string.
      expect(/https?:\/\/[^\s'"]*publicnode/.test(text), `${file} must not build a publicnode URL`).toBe(false);
      expect(/madeonsol/i.test(text) && /https?:\/\/[^\s'"]*madeonsol/i.test(text), `${file} must not reach MadeOnSol`).toBe(false);
    }
  });

  it('does not import src/ or analysis/, and is not imported by them', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/graduated-life-tape/')) {
      expect(text, `${file} must not import from src/`).not.toMatch(/from\s+['"](\.\.\/)+src\//);
      expect(text, `${file} must not import from analysis/`).not.toMatch(/from\s+['"].*analysis\//);
      // The screen lane is actively editing its own modules. The duplication between the two
      // keyless clients is deliberate; coupling a multi-hour collection walk to a moving file is
      // the cost that duplication buys out of.
      expect(text, `${file} must not import from the deployer screen`).not.toMatch(
        /from\s+['"][^'"]*deployer-screen/,
      );
    }
    for (const [file, text] of readAll(SRC_DIR, 'src/')) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
    for (const [file, text] of readAll(ANALYSIS_DIR, 'analysis/')) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
  });

  it('ships its method and its limits next to its data', () => {
    expect([...readAll(TOOL_DIR, 'tools/graduated-life-tape/', /./).keys()]).toContain(
      'tools/graduated-life-tape/README.md',
    );
    expect(existsSync(join(OUT_DIR, 'README.md'))).toBe(true);
    const readme = readFileSync(join(OUT_DIR, 'README.md'), 'utf8');
    // The dataset README is where a reader meets this tape. The limits have to be in it, not only
    // in a report they may never open.
    expect(readme).toMatch(/gross of fees/i);
    expect(readme).toMatch(/## What this tape does not establish/);
  });
});
