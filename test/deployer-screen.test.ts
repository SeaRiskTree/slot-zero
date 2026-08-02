/**
 * Tests for the MadeOnSol deployer screen. **Nothing here reaches the network.**
 *
 * Every fixture is synthetic — hand-written to the *shape* observed on 2026-07-29, never a captured
 * vendor payload. That is a requirement, not a convenience: committing real per-token records would
 * be exactly the accumulation MadeOnSol's terms §5a(d) prohibits, and it would put vendor data in a
 * git history that cannot be un-published. Synthetic fixtures also let a test pin a value the live
 * API would never hold still.
 *
 * The `fetchImpl` and `sleepImpl` seams on both clients exist for these tests. No test constructs a
 * client without them, so a regression that starts issuing real requests fails here rather than
 * quietly spending the captain's shared quota.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KEY_ENV_VAR,
  classifyAuthFailure,
  describeKey,
  resolveKey,
} from '../tools/deployer-screen/credential.mjs';
import { BoundedClient, CeilingReached, VendorRefused, buildPath } from '../tools/deployer-screen/client.mjs';
import {
  CURVE_INITIAL_PRICE_SOL,
  createSlotGroups,
  measureCompletion,
  measureCreateSlot,
  median,
  parseFill,
  percentile,
  solBetweenPrices,
  toLaunchRefs,
  toTokenRecords,
} from '../tools/deployer-screen/measure.mjs';
import type { Fill } from '../tools/deployer-screen/measure.mjs';
import {
  ENTRY_VERDICTS,
  distribution,
  hitRate,
  measureLaunchEntry,
  scoreEntry,
} from '../tools/deployer-screen/entry.mjs';
import type { EntryScore, EntryThresholds } from '../tools/deployer-screen/entry.mjs';
import { scoreCandidateEntry, toEntryRecordRow } from '../tools/deployer-screen/stage2.mjs';
import { runStage0 } from '../tools/deployer-screen/stage0.mjs';
import {
  applyGate,
  measureConsistency,
  rankCandidates,
  verdictFor,
} from '../tools/deployer-screen/rank.mjs';
import {
  buildSeedPlan,
  extractWallets,
  mergeSeeds,
  prefilterReason,
  readSeedResponse,
  summariseCoverage,
} from '../tools/deployer-screen/seed.mjs';
import {
  KeylessClient,
  extractTradeRows,
  parseFillLoose,
  readLaunchWindow,
  slotFromSlotIndexId,
  windowFilter,
} from '../tools/deployer-screen/pumpfun.mjs';
import {
  exitForRefusal,
  parseArgs,
  loadThresholds,
  partialOutPath,
} from '../tools/deployer-screen/screen.mjs';
import { LIMITATIONS, renderDryRun, renderEntry, renderStage1 } from '../tools/deployer-screen/render.mjs';
import {
  RECORD_SCHEMA_VERSION,
  completenessOf,
  describeCompleteness,
  schemaVersionOf,
} from '../tools/deployer-screen/record.mjs';

const GATE = { minTokens: 25, minCompletionRate: 0.25, minSpanDays: 14 };

/**
 * Build a synthetic fill.
 *
 * `sid` matters as much as `slot` and is defaulted rather than omitted: it is pump.fun's
 * within-slot ordering key, and it is what the create-slot fill queue — and therefore
 * `solQueuedAheadSol` — is derived from. It defaults to a monotonically increasing value in
 * declaration order, so a test's fill list reads as the queue it looks like.
 */
let sidCounter = 0;
const fill = (
  o: Partial<{
    slot: number;
    sid: string;
    tx: string;
    wallet: string;
    sol: number;
    tokens: number;
    side: 'buy' | 'sell';
    venue: 'pump' | 'pump_amm';
  }>,
): Fill => ({
  slot: o.slot ?? 100,
  sid: o.sid ?? String(++sidCounter).padStart(22, '0'),
  tx: o.tx ?? 'tx0',
  wallet: o.wallet ?? 'w',
  side: o.side ?? ('buy' as const),
  venue: o.venue ?? ('pump' as const),
  sol: o.sol ?? 1,
  tokens: o.tokens ?? (o.sol ?? 1) * 1e7,
  priceSol: 1e-7,
});

const DAY = 86_400_000;
const T0 = Date.parse('2026-06-01T00:00:00Z');

/** A synthetic vendor profile: `pump_tokens` plus the aggregates we must never read. */
function profileFixture(opts: {
  n: number;
  completed: number;
  spanDays: number;
  /** Aggregates deliberately set to values that would change every verdict if trusted. */
  lyingAggregates?: boolean;
}) {
  const tokens = Array.from({ length: opts.n }, (_, i) => ({
    mint: `MINT${String(i).padStart(38, '0')}pump`,
    name: `tok${i}`,
    symbol: `T${i}`,
    created_timestamp: T0 + Math.round((i / Math.max(1, opts.n - 1)) * opts.spanDays * DAY),
    complete: i < opts.completed,
    ath_market_cap: 1000 + i,
  }));
  return {
    is_deployer: true,
    deployer: opts.lyingAggregates
      ? {
          total_tokens_deployed: 3,
          total_bonded: 3,
          bonding_rate: 1,
          recent_bond_rate: 1,
          recent_outcomes: 'BBBBBBBBBB',
          best_token_peak_mc: 999_999_999,
          labeled_tokens: 3,
        }
      : {},
    pump_stats: opts.lyingAggregates
      ? { total: 3, bonded: 3, bondingRate: 1, bestAthMc: 999_999_999 }
      : {},
    pump_tokens: tokens,
  };
}

// ---------------------------------------------------------------------------------------------

describe('credential handling', () => {
  it('reports a missing key with an actionable message and never invents one', () => {
    const r = resolveKey({});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('missing');
    expect(r.message).toContain(KEY_ENV_VAR);
    expect(r.message).toContain('madeonsol.com/developer');
    // It must tell the reader how to supply a key WITHOUT putting one in the repo.
    expect(r.message).toContain('Never commit a key');
  });

  it.each([
    ['blank', '   ', 'blank'],
    ['too short', 'msk_short', 'too-short'],
    ['too long', `msk_${'x'.repeat(200)}`, 'too-long'],
  ])('rejects a %s key as %s', (_label, value, reason) => {
    const r = resolveKey({ [KEY_ENV_VAR]: value });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe(reason);
  });

  it('accepts a plausible key and describes it by length and prefix only', () => {
    const key = `msk_${'a'.repeat(43)}`; // 47 chars, the length we actually hold
    const r = resolveKey({ [KEY_ENV_VAR]: key });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.description).toEqual({ length: 47, hasDocumentedPrefix: true });
    // The description must not be, or contain, the key.
    expect(JSON.stringify(r.description)).not.toContain('aaa');
  });

  it('describeKey discloses nothing but a length and a boolean', () => {
    const d = describeKey('msk_supersecretvalue');
    expect(Object.keys(d).sort()).toEqual(['hasDocumentedPrefix', 'length']);
    expect(JSON.stringify(d)).not.toContain('supersecret');
  });

  it('tells expiry, entitlement and quota apart — they need opposite responses', () => {
    const expired = classifyAuthFailure(401);
    expect(expired?.kind).toBe('expired-or-revoked');
    // Free-tier keys expire every 30 days, so 401 must lead with expiry rather than "invalid".
    expect(expired?.message).toMatch(/expire/i);

    const tier = classifyAuthFailure(403);
    expect(tier?.kind).toBe('wrong-tier');
    // It must not suggest paying: paid tiers are refused standing policy.
    expect(tier?.message).toMatch(/refused standing policy/);

    const quota = classifyAuthFailure(429);
    expect(quota?.kind).toBe('quota-exhausted');
    expect(quota?.message).toMatch(/SHARED/);

    // Every terminal failure must deny being a negative result.
    for (const f of [expired, tier, quota]) {
      expect(f?.message).toMatch(/NOT a negative result/);
    }
    expect(classifyAuthFailure(200)).toBeNull();
    expect(classifyAuthFailure(503)).toBeNull();
  });

  it('classifies the 400 we actually hit, and names the spec/server disagreement', () => {
    const f = classifyAuthFailure(400);
    expect(f?.kind).toBe('malformed-request');
    // limit<=100 is documented; the server rejects anything above 50.
    expect(f?.message).toMatch(/limit<=100/);
    expect(f?.message).toMatch(/above 50/);
  });
});

describe('request bounds', () => {
  const okJson = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

  function stubClient(opts: {
    maxRequests: number;
    responder?: (url: string, n: number) => Response;
  }) {
    let calls = 0;
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      calls += 1;
      const url = String(input);
      urls.push(url);
      return opts.responder ? opts.responder(url, calls) : okJson({ ok: calls });
    }) as unknown as typeof fetch;
    const client = new BoundedClient({
      key: 'msk_test_key_value_padded_to_length_ok_1234',
      maxRequests: opts.maxRequests,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl,
    });
    return { client, urls, count: () => calls };
  }

  it('refuses the request that would cross the ceiling, and counts what it issued', async () => {
    const { client, count } = stubClient({ maxRequests: 2 });
    await client.getJson('/a');
    await client.getJson('/b');
    await expect(client.getJson('/c')).rejects.toBeInstanceOf(CeilingReached);
    expect(count()).toBe(2);
    expect(client.stats().issued).toBe(2);
    expect(client.remaining()).toBe(0);
  });

  it('keeps exactly one request in flight even when callers do not await', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return okJson({});
    }) as unknown as typeof fetch;

    const client = new BoundedClient({
      key: 'msk_test_key_value_padded_to_length_ok_1234',
      maxRequests: 10,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl,
    });

    await Promise.all([client.getJson('/a'), client.getJson('/b'), client.getJson('/c')]);
    expect(maxInFlight).toBe(1);
  });

  it('a rejected request does not poison the queue for later callers', async () => {
    const { client } = stubClient({
      maxRequests: 5,
      responder: (_url, n) =>
        n === 1
          ? ({ ok: false, status: 500, text: async () => 'boom' } as Response)
          : okJson({ fine: true }),
    });
    // maxRetriesPerRequest defaults to 1, so the 500 is retried once and then succeeds.
    await expect(client.getJson('/first')).resolves.toEqual({ fine: true });
    await expect(client.getJson('/second')).resolves.toEqual({ fine: true });
  });

  it('a retry is counted against the ceiling rather than smuggled past it', async () => {
    const { client, count } = stubClient({
      maxRequests: 2,
      responder: () => ({ ok: false, status: 500, text: async () => 'nope' }) as Response,
    });
    await expect(client.getJson('/x')).rejects.toThrow(/HTTP 500/);
    expect(count()).toBe(2); // original + one retry, and now the ceiling is spent
    expect(client.remaining()).toBe(0);
  });

  it('turns a rejected key into a terminal VendorRefused, without retrying it', async () => {
    const { client, count } = stubClient({
      maxRequests: 5,
      responder: () => ({ ok: false, status: 401, text: async () => 'expired' }) as Response,
    });
    const err = await client.getJson('/x').catch((e) => e);
    expect(err).toBeInstanceOf(VendorRefused);
    expect((err as VendorRefused).kind).toBe('expired-or-revoked');
    // Retrying a rejected credential spends a shared allowance to learn the same thing.
    expect(count()).toBe(1);
  });

  it('sends the key as a bearer header and never in the URL', async () => {
    const seen: RequestInit[] = [];
    const seenUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown, init: RequestInit) => {
      seenUrls.push(String(input));
      seen.push(init);
      return okJson({});
    }) as unknown as typeof fetch;
    const client = new BoundedClient({
      key: 'msk_secret_do_not_leak_padded_out_to_len_47',
      maxRequests: 2,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl,
    });
    await client.getJson('/deployer-hunter/leaderboard', { sort: 'total_bonded', limit: 50 });
    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers['authorization']).toMatch(/^Bearer msk_/);
    // The key belongs in the header and nowhere else — never in a URL that could be logged.
    expect(seenUrls[0]).not.toContain('msk_');
    expect(seenUrls[0]).toContain('/deployer-hunter/leaderboard?limit=50&sort=total_bonded');
  });

  it('builds deterministic query strings so a dry run previews the real URL', () => {
    expect(buildPath('/x', { b: 2, a: 1 })).toBe('/x?a=1&b=2');
    expect(buildPath('/x', { a: 1, b: 2 })).toBe('/x?a=1&b=2');
    expect(buildPath('/x')).toBe('/x');
    expect(buildPath('/x', {})).toBe('/x');
  });
});

describe('the curve, and the fills', () => {
  it('inverts the bonding curve exactly', () => {
    // The dataset's own preset: 14.814814813 SOL of dev buy from the initial price.
    const dev = 14.814814813;
    const root = Math.sqrt(CURVE_INITIAL_PRICE_SOL) + dev / Math.sqrt(30 * 1_073_000_000);
    const p0 = root * root;
    expect(solBetweenPrices(CURVE_INITIAL_PRICE_SOL, p0)).toBeCloseTo(dev, 9);
    // Reversing the direction reverses the sign; the function does not pretend otherwise.
    expect(solBetweenPrices(p0, CURVE_INITIAL_PRICE_SOL)).toBeCloseTo(-dev, 9);
  });

  it('refuses to guess an unknown side or venue', () => {
    const base = { slot: 1, tx: 'a', u: 'w', sol: '1', psol: '1', k: 'buy', p: 'pump' };
    expect(() => parseFill({ ...base, k: 'BUY' })).toThrow(/field 'k'/);
    expect(() => parseFill({ ...base, p: 'raydium' })).toThrow(/field 'p'/);
    // Defaulting either one would silently reclassify a fill — a corruption, not a crash.
    expect(parseFill(base).side).toBe('buy');
  });

  it('tolerates the live endpoint\'s different field names', () => {
    // The stored tape and the live endpoint do NOT share field names. Measured 2026-07-29.
    // The real live payload carries NO `slot` field — only `slotIndexId`, whose first 12 digits
    // are the slot. A parser that looked for `slot` would read NaN on every row and collapse
    // every fill into one create slot.
    const live = {
      slotIndexId: '0004357956790007370002',
      tx: 'sig',
      userAddress: 'wallet1',
      type: 'sell',
      program: 'pump_amm',
      amountSol: '0.0697',
      priceSol: '0.000000126',
    };
    const f = parseFillLoose(live);
    expect(f.side).toBe('sell');
    expect(f.venue).toBe('pump_amm');
    expect(f.wallet).toBe('wallet1');
    expect(f.sol).toBeCloseTo(0.0697, 6);
    expect(f.slot).toBe(435_795_679);
    expect(slotFromSlotIndexId('0004357956790007370002')).toBe(435_795_679);
    // And a row with neither is a hard error, not a silent NaN.
    expect(() => parseFillLoose({ type: 'buy', program: 'pump' })).toThrow(/no usable slot/);
  });

  it('unwraps whichever envelope the trade endpoint returns', () => {
    expect(extractTradeRows([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(extractTradeRows({ trades: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(extractTradeRows({ data: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(extractTradeRows({ unexpected: 1 })).toEqual([]);
    expect(extractTradeRows(null)).toEqual([]);
  });
});

describe('the co-ordination rule — the Stage 2 seam', () => {

  it('marks every wallet sharing a transaction as co-ordinated', () => {
    // dev buys alone; two wallets share one transaction; one buys by itself.
    const m = measureCreateSlot([
      fill({ tx: 'devtx', wallet: 'dev', sol: 10 }),
      fill({ tx: 'bundle', wallet: 'book1', sol: 3 }),
      fill({ tx: 'bundle', wallet: 'book2', sol: 3 }),
      fill({ tx: 'solo', wallet: 'outsider', sol: 4 }),
    ]);
    expect(m).not.toBeNull();
    expect(m!.deployer).toBe('dev');
    expect(m!.devSol).toBe(10);
    expect(m!.coordinatedSol).toBe(6);
    expect(m!.coordinatedWallets).toBe(2);
    expect(m!.independentSol).toBe(4);
    expect(m!.independentWallets).toBe(1);
    expect(m!.bundledTx).toBe(1);
    expect(m!.maxWalletsInOneTx).toBe(2);
    // (10 + 6) / (10 + 10) = 0.8
    expect(m!.operationShare).toBeCloseTo(0.8, 10);
    expect(m!.roomLeft).toBeCloseTo(0.2, 10);
  });

  it('counts a lone co-ordinated wallet as independent — a conservatism that costs us', () => {
    // A book wallet that never shares a transaction is indistinguishable from an outsider on
    // fills alone. It is credited to the outsiders, which INFLATES room left. That direction is
    // deliberate: it makes a "leaves room" conclusion harder to reach, not easier.
    const m = measureCreateSlot([
      fill({ tx: 'devtx', wallet: 'dev', sol: 10 }),
      fill({ tx: 'solo1', wallet: 'secretbook', sol: 10 }),
    ]);
    expect(m!.coordinatedSol).toBe(0);
    expect(m!.independentSol).toBe(10);
    expect(m!.roomLeft).toBeCloseTo(0.5, 10);
  });

  it('reads the deployer off the fills rather than trusting a creator field', () => {
    // pump.fun's creator record can move on-chain, and the token that goes missing is exactly the
    // good one. The first curve buyer in the earliest slot is the deployer, by construction.
    const m = measureCreateSlot([
      fill({ slot: 200, tx: 't2', wallet: 'later' }),
      fill({ slot: 100, tx: 't1', wallet: 'realdev', sol: 5 }),
    ]);
    expect(m!.deployer).toBe('realdev');
    expect(m!.slot).toBe(100);
  });

  it('ignores sells and graduated-pool fills when locating the create slot', () => {
    const m = measureCreateSlot([
      fill({ slot: 50, wallet: 'amm', venue: 'pump_amm' }),
      fill({ slot: 60, wallet: 'seller', side: 'sell' }),
      fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 9 }),
    ]);
    expect(m!.slot).toBe(100);
    expect(m!.deployer).toBe('dev');
  });

  it('returns null rather than a fabricated measurement when there is no curve buy', () => {
    expect(measureCreateSlot([])).toBeNull();
    expect(measureCreateSlot([fill({ side: 'sell' })])).toBeNull();
  });

  it('treats an empty create slot as fully occupied rather than wide open', () => {
    const m = measureCreateSlot([fill({ tx: 'devtx', wallet: 'dev', sol: 0 })]);
    expect(m!.operationShare).toBe(1);
    expect(m!.roomLeft).toBe(0);
  });

  it('windowFilter keeps the opening slots and drops later trading', () => {
    const fills = [fill({ slot: 1000 }), fill({ slot: 1100 }), fill({ slot: 99_999 })];
    const kept = windowFilter(fills, 60_000); // 60s ≈ 150 slots
    expect(kept.map((f) => f.slot)).toEqual([1000, 1100]);
  });
});

describe('the completion measurement, and the denominator that makes it honest', () => {
  it('computes the rate from per-token records with an explicit denominator', () => {
    const m = measureCompletion([
      { deployedAtMs: T0, completed: true },
      { deployedAtMs: T0 + 10 * DAY, completed: false },
      { deployedAtMs: T0 + 20 * DAY, completed: true },
    ]);
    expect(m.tokens).toBe(3);
    expect(m.completed).toBe(2);
    expect(m.rate).toBeCloseTo(2 / 3, 10);
    expect(m.spanDays).toBeCloseTo(20, 6);
  });

  it('drops unusable timestamps into a visible diagnostic rather than the denominator', () => {
    const m = measureCompletion([
      { deployedAtMs: T0, completed: true },
      { deployedAtMs: Number.NaN, completed: true },
      { deployedAtMs: 0, completed: false },
    ]);
    expect(m.tokens).toBe(1);
    expect(m.droppedNoTimestamp).toBe(2);
  });

  it('reports an undefined rate instead of zero when there is nothing to divide', () => {
    const m = measureCompletion([]);
    // A rate of 0 would gate as "a bad deployer"; NaN gates as "we could not measure".
    expect(Number.isNaN(m.rate)).toBe(true);
    expect(m.firstDeployIso).toBeNull();
  });

  it('reads ONLY pump_tokens, ignoring every aggregate in the same payload', () => {
    // The aggregates in this fixture all say "3 for 3, perfect, best token ever". If any of them
    // leaked into the measurement the numbers below would change.
    const profile = profileFixture({ n: 40, completed: 12, spanDays: 30, lyingAggregates: true });
    const { records } = toTokenRecords(profile);
    const m = measureCompletion(records);
    expect(m.tokens).toBe(40);
    expect(m.completed).toBe(12);
    expect(m.rate).toBeCloseTo(0.3, 10);
  });

  it('flags a full vendor page as capped, because older launches exist behind it', () => {
    expect(toTokenRecords(profileFixture({ n: 70, completed: 30, spanDays: 35 })).capped).toBe(true);
    expect(toTokenRecords(profileFixture({ n: 69, completed: 30, spanDays: 35 })).capped).toBe(false);
  });

  it('survives a profile that is missing pump_tokens entirely', () => {
    for (const bad of [null, {}, { pump_tokens: null }, { pump_tokens: 'nope' }, 42]) {
      expect(toTokenRecords(bad)).toEqual({ records: [], capped: false });
    }
  });

  it('THE TRAP: /tokens is bonded-only, so its own rate is 1.0 for everyone', () => {
    // Measured 2026-07-29 against ground truth: 100 records fetched from
    // /deployer-hunter/{wallet}/tokens, 98 in our graduated set, ZERO of the 136 launches our tape
    // records as failures, `total: 101` against our 103 bonded — and `only_bonded=true` returns the
    // identical total, so the flag is a no-op. This fixture encodes that shape. A future refactor
    // that switched the gate to this endpoint would rate every deployer alive at 100%.
    const bondedOnlyEndpoint = {
      total: 101,
      tokens: Array.from({ length: 50 }, (_, i) => ({
        token_mint: `M${i}`,
        deployed_at: new Date(T0 + i * DAY).toISOString(),
        bonded_at: new Date(T0 + i * DAY + 3_600_000).toISOString(),
        time_to_bond_minutes: 60,
      })),
    };
    const naive = bondedOnlyEndpoint.tokens.filter((t) => t.bonded_at !== null).length;
    expect(naive / bondedOnlyEndpoint.tokens.length).toBe(1);

    // And the shape carries no `complete` flag and no `pump_tokens`, so our reader declines it.
    expect(toTokenRecords(bondedOnlyEndpoint)).toEqual({ records: [], capped: false });
  });
});

describe('the gate', () => {
  const completion = (n: number, completed: number, spanDays: number) =>
    measureCompletion(
      Array.from({ length: n }, (_, i) => ({
        deployedAtMs: T0 + Math.round((i / Math.max(1, n - 1)) * spanDays * DAY),
        completed: i < completed,
      })),
    );

  it('passes a deployer that clears all three thresholds', () => {
    const g = applyGate({ completion: completion(40, 20, 30) }, GATE);
    expect(g.passed).toBe(true);
    expect(g.reasons).toEqual([]);
  });

  it.each([
    ['sample', 20, 10, 30, /sample too small/],
    ['rate', 40, 4, 30, /completion rate/],
    ['span', 40, 20, 5, /spans/],
  ])('fails on %s and says which', (_label, n, done, span, re) => {
    const g = applyGate({ completion: completion(n, done, span) }, GATE);
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(re);
  });

  it('reports every failing reason, not just the first', () => {
    const g = applyGate({ completion: completion(5, 0, 1) }, GATE);
    expect(g.reasons.length).toBe(3);
  });

  it('fails a wallet with no usable records rather than scoring it zero', () => {
    const g = applyGate({ completion: measureCompletion([]) }, GATE);
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/undefined/);
  });

  it('emits only gate verdicts — the vocabulary contains no recommendation', () => {
    const pass = verdictFor({
      gate: { passed: true, reasons: [] },
      completion: completion(40, 20, 30),
      capped: false,
    });
    expect(pass.verdict).toBe('gate-passed');
    // The wording must carry its own limitation, because it gets quoted out of context.
    expect(pass.rationale).toMatch(/NOT a recommendation/);
    expect(pass.rationale).toMatch(/UNMEASURED/);
    // And it must never claim the thing it did not measure.
    expect(pass.rationale).not.toMatch(/profitab(le|ility)\b(?!.*UNMEASURED)/i);

    const fail = verdictFor({
      gate: { passed: false, reasons: ['sample too small'] },
      completion: completion(3, 3, 1),
      capped: false,
    });
    expect(fail.verdict).toBe('gate-failed');
  });

  it('says so when the vendor page was truncated', () => {
    const v = verdictFor({
      gate: { passed: true, reasons: [] },
      completion: completion(70, 35, 35),
      capped: true,
    });
    expect(v.rationale).toMatch(/TRUNCATED/);
  });
});

describe('ordering is deterministic and not a league table', () => {
  const candidate = (
    wallet: string,
    n: number,
    done: number,
    verdict: 'gate-passed' | 'gate-failed',
    roomMedian?: number,
  ) => ({
    wallet,
    seededBy: ['leaderboard:total_bonded'],
    completion: measureCompletion(
      Array.from({ length: n }, (_, i) => ({ deployedAtMs: T0 + i * DAY, completed: i < done })),
    ),
    completionCapped: false,
    gate: { passed: verdict === 'gate-passed', reasons: [] },
    verdict,
    rationale: '',
    consistency: null,
    entry:
      roomMedian === undefined
        ? null
        : ({ roomLeft: { ...distribution([roomMedian]) } } as unknown as EntryScore),
    entryCoverage: null,
  });

  it('sorts by MEASURED entry room, and puts unscored candidates after every scored one', () => {
    // The promise the Stage 1 lane made when it left the seam: once Stage 2 landed, room-left
    // becomes the sort key. An unscored candidate is not a low-room candidate, so it sorts last
    // rather than being interleaved at some imputed room.
    const ranked = rankCandidates([
      candidate('unscored', 70, 40, 'gate-passed'),
      candidate('narrow', 70, 40, 'gate-passed', 0.2),
      candidate('wide', 30, 15, 'gate-passed', 0.8),
      candidate('rejected', 10, 10, 'gate-failed'),
    ]);
    expect(ranked.map((c) => c.wallet)).toEqual(['wide', 'narrow', 'unscored', 'rejected']);
  });

  it('puts passers first, then larger samples, then higher rates', () => {
    const ranked = rankCandidates([
      candidate('zzz', 30, 29, 'gate-passed'),
      candidate('aaa', 70, 35, 'gate-passed'),
      candidate('fff', 10, 10, 'gate-failed'),
    ]);
    expect(ranked.map((c) => c.wallet)).toEqual(['aaa', 'zzz', 'fff']);
    // Sample size leads rate deliberately: 29/30 is weaker evidence than 35/70.
    expect(ranked[0]?.completion.tokens).toBe(70);
  });

  it('is a total order, so two runs over the same data agree byte for byte', () => {
    const input = [
      candidate('bbb', 40, 20, 'gate-passed'),
      candidate('aaa', 40, 20, 'gate-passed'),
      candidate('ccc', 40, 20, 'gate-passed'),
    ];
    const once = rankCandidates(input).map((c) => c.wallet);
    const twice = rankCandidates([...input].reverse()).map((c) => c.wallet);
    expect(once).toEqual(['aaa', 'bbb', 'ccc']);
    expect(twice).toEqual(once);
  });
});

describe('consistency over time', () => {
  const C = { minEpochs: 3, minTokensPerEpoch: 12, epochDays: 30, maxDispersion: 0.35 };

  it('refuses to claim consistency from too little history', () => {
    const r = measureConsistency(
      Array.from({ length: 20 }, (_, i) => ({ deployedAtMs: T0 + i * DAY, completed: i % 2 === 0 })),
      C,
    );
    // 20 tokens over 20 days is one epoch, not three. This is the exact defect we found in the
    // vendor's own aggregate, so the tool must not reproduce it.
    expect(r.state).toBe('unmeasured');
    expect(r.note).toMatch(/qualifying epochs required/);
  });

  it('measures the spread across epochs when there is enough history', () => {
    // 3 epochs x 15 tokens; the newest epoch is hot and the oldest is cold.
    const records: { deployedAtMs: number; completed: boolean }[] = [];
    const rates = [0.2, 0.4, 0.8];
    for (let e = 0; e < 3; e++) {
      for (let i = 0; i < 15; i++) {
        records.push({
          deployedAtMs: T0 + (2 - e) * 30 * DAY + i * DAY,
          completed: i < Math.round(15 * (rates[e] as number)),
        });
      }
    }
    const r = measureConsistency(records, C);
    expect(r.state).toBe('measured');
    expect(r.epochs).toBe(3);
    expect(r.minEpochRate).toBeCloseTo(0.2, 2);
    expect(r.maxEpochRate).toBeCloseTo(0.8, 2);
    // A one-hot-epoch record must be FLAGGED, not silently filtered.
    expect(r.streaky).toBe(true);
    expect(r.note).toMatch(/STREAKY/);
  });

  it('does not flag a steady deployer', () => {
    const records = Array.from({ length: 60 }, (_, i) => ({
      deployedAtMs: T0 + i * 1.5 * DAY,
      completed: i % 2 === 0,
    }));
    const r = measureConsistency(records, C);
    expect(r.state).toBe('measured');
    expect(r.streaky).toBe(false);
  });

  it('carries the walk\'s truncation and the lower-bound caveat into the result', () => {
    const records = Array.from({ length: 60 }, (_, i) => ({
      deployedAtMs: T0 + i * 1.5 * DAY,
      completed: i % 2 === 0,
    }));

    // This is the ONE surface here making a long-horizon claim, and it is computed over a
    // page-capped walk of a listing that lists by *current* creator — which moves on-chain, and the
    // token that goes missing is the deployer's best one. Both limits must travel with the number.
    const capped = measureConsistency(records, C, true);
    expect(capped.historyTruncated).toBe(true);
    expect(capped.note).toMatch(/LOWER BOUND/);
    expect(capped.note).toMatch(/current\* creator/);
    expect(capped.note).toMatch(/page cap/);

    const full = measureConsistency(records, C, false);
    expect(full.historyTruncated).toBe(false);
    // Even an untruncated walk is a lower bound, because the creator record can move.
    expect(full.note).toMatch(/LOWER BOUND/);
    expect(full.note).not.toMatch(/page cap/);

    // The default must be the safe one, never an implied "complete".
    expect(measureConsistency(records, C).historyTruncated).toBe(false);
  });
});

describe('enumeration', () => {
  it('seeds from currently-active endpoints, not just a leaderboard tail', () => {
    // Measured 2026-07-29: sort=bonding_rate DESC returns 1-for-1 wallets last active in May 2024,
    // and sort=total_bonded DESC returns 8518-deployed/127-bonded spam. A first run seeded only
    // from the leaderboard gated twelve wallets that were all a single token.
    const plan = buildSeedPlan({ limit: 20 });
    expect(plan.map((p) => p.path)).toEqual([
      '/deployer-hunter/recent-bonds',
      '/deployer-hunter/alerts',
      '/deployer-hunter/leaderboard',
    ]);
    // recent-bonds leads: a deployer listed there is bonding curves NOW.
    expect(plan[0]?.path).toContain('recent-bonds');
    // bonding_rate is never used as a sort — that ordering is what surfaces the n=1 flukes.
    expect(JSON.stringify(plan)).not.toContain('"sort":"bonding_rate"');
    expect(plan[2]?.query['sort']).toBe('total_bonded');
  });

  it('clamps each endpoint to its own documented maximum', () => {
    const plan = buildSeedPlan({ limit: 999 });
    expect(plan[0]?.query['limit']).toBe(50); // recent-bonds
    expect(plan[1]?.query['limit']).toBe(100); // alerts
    expect(plan[2]?.query['limit']).toBe(50); // leaderboard
  });

  it('threads a tier filter into every query and into the provenance label', () => {
    const plan = buildSeedPlan({ limit: 10, tier: 'elite' });
    expect(plan.every((p) => p.query['tier'] === 'elite')).toBe(true);
    expect(plan[0]?.label).toContain(':elite');
  });

  it('reads the elite recent-bond and alert shapes the vendor actually sends', () => {
    // Measured 2026-07-29 against recent-bonds?tier=elite and alerts. Both nest the deployer block
    // under `deployers` — PLURAL — and recent-bonds wraps its rows in `tokens`, not `bonds`. Looking
    // only for the singular `deployer` is what made both seeds yield ZERO wallets while still
    // costing a keyed request each, for two committed runs, invisibly.
    const recentBondsElite = {
      tokens: [
        {
          id: 'bc5ac976',
          token_mint: 'GtK9NvPrVgmp9XFXvHiWh5awHy547agehcwjaMrYpump',
          token_name: 'a token',
          bonded_at: '2026-07-29T18:40:23.88+00:00',
          time_to_bond_minutes: 162,
          peak_market_cap: 24_820.27,
          deployers: {
            tier: 'elite',
            wallet_address: 'ELITEwallet1',
            total_tokens_deployed: 7,
            total_bonded: 7,
            bonding_rate: 1,
          },
        },
      ],
      limit: 2,
      next_since: '2026-07-29T18:40:23.88+00:00',
    };
    expect(extractWallets(recentBondsElite)).toEqual([
      { wallet: 'ELITEwallet1', vendorDeployed: 7, vendorBonded: 7 },
    ]);

    const alerts = {
      alerts: [
        {
          id: '98d15b31',
          token_mint: 'ALERTmint',
          alert_type: 'bonded',
          title: "Good deployer's token bonded!",
          deployers: { tier: 'good', wallet_address: 'ALERTwallet1', total_tokens_deployed: 6, total_bonded: 4 },
          kol_buys: { count: 6, total_sol: 24.35, kols: [] },
        },
      ],
      limit: 2,
      offset: 0,
    };
    expect(extractWallets(alerts)).toEqual([
      { wallet: 'ALERTwallet1', vendorDeployed: 6, vendorBonded: 4 },
    ]);
  });

  it('reads the wallet and the embedded deployer block from either nesting', () => {
    // The singular `deployer` is still tolerated; the leaderboard inlines the fields on the row.
    expect(
      extractWallets({ bonds: [{ token_mint: 'M', deployer: { wallet_address: 'a', total_tokens_deployed: 40, total_bonded: 20 } }] }),
    ).toEqual([{ wallet: 'a', vendorDeployed: 40, vendorBonded: 20 }]);
    expect(extractWallets({ deployers: [{ wallet_address: 'b', total_tokens_deployed: 7 }] })).toEqual([
      { wallet: 'b', vendorDeployed: 7, vendorBonded: null },
    ]);
    expect(extractWallets(['d'])).toEqual([{ wallet: 'd', vendorDeployed: null, vendorBonded: null }]);
    // An unrecognised shape yields nothing rather than a guess.
    expect(extractWallets({ mystery: [{ nope: 1 }] })).toEqual([]);
    expect(extractWallets(null)).toEqual([]);
  });

  it('the prefilter can only skip a request, and admits anything it cannot judge', () => {
    const base = { wallet: 'w', seededBy: [], bestRank: 0 };
    // Their `rising` tier: a perfect rate over one launch. This is what consumed a whole first run.
    expect(prefilterReason({ ...base, vendorDeployed: 1, vendorBonded: 1 })).toMatch(/below the 5/);
    expect(prefilterReason({ ...base, vendorDeployed: 4, vendorBonded: 4 })).not.toBeNull();
    expect(prefilterReason({ ...base, vendorDeployed: 5, vendorBonded: 1 })).toBeNull();
    expect(prefilterReason({ ...base, vendorDeployed: 20, vendorBonded: 13 })).toBeNull();
    // Unknown counts admit the wallet: paying a request to find out is the right side to err on.
    expect(prefilterReason({ ...base, vendorDeployed: null, vendorBonded: null })).toBeNull();
  });

  it('the prefilter never admits a vendor aggregate into a measurement', () => {
    // A wallet the prefilter admits is still measured entirely from pump_tokens. Proven by giving
    // the profile aggregates that disagree violently with its own per-token records.
    const profile = profileFixture({ n: 40, completed: 12, spanDays: 30, lyingAggregates: true });
    const m = measureCompletion(toTokenRecords(profile).records);
    expect(m.rate).toBeCloseTo(0.3, 10); // not the 1.0 every aggregate in the payload claims
  });

  it('prefers wallets that recur across endpoints, then first-seen rank, deterministically', () => {
    const w = (wallet: string, deployed: number | null) => ({ wallet, vendorDeployed: deployed, vendorBonded: null });
    const merged = mergeSeeds([
      { label: 'recent-bonds', wallets: [w('w1', 10), w('w2', 90)] },
      { label: 'alerts', wallets: [w('w1', 10), w('w9', 50)] },
    ]);
    // w1 appears in both endpoints, so it earns a request before w2 does.
    expect(merged[0]?.wallet).toBe('w1');
    expect(merged[0]?.seededBy).toEqual(['recent-bonds', 'alerts']);
    // Among singly-seeded wallets, first-seen rank decides: w2 at index 1, w9 at index 1 too, so
    // the address breaks the tie.
    expect(merged.slice(1).map((m) => m.wallet)).toEqual(['w2', 'w9']);
    expect(new Set(merged.map((m) => m.wallet)).size).toBe(merged.length);
  });

  it('THE INVARIANT: the comparator never consults the vendor aggregate', () => {
    // The sorted list is truncated by the candidate cap, so anything the comparator reads decides
    // which wallets get gated and therefore which appear in the output at all. A vendor aggregate
    // there is a vendor aggregate reaching an output — and `prefilterReason` is documented as the
    // ONE place one may be read. These two wallets are identical but for `vendorDeployed`, so if
    // it were consulted `zzz` would sort first; ordering must fall through to the address. Each
    // wallet is at index 0 of its own seed, so provenance count and bestRank tie exactly and
    // `vendorDeployed` is the ONLY thing left that could separate them.
    const zzzFirst = mergeSeeds([
      { label: 'recent-bonds', wallets: [{ wallet: 'zzz', vendorDeployed: 9_999, vendorBonded: 9_999 }] },
      { label: 'alerts', wallets: [{ wallet: 'aaa', vendorDeployed: 6, vendorBonded: 1 }] },
    ]);
    expect(zzzFirst.map((m) => m.wallet)).toEqual(['aaa', 'zzz']);
    expect(zzzFirst[0]?.seededBy.length).toBe(zzzFirst[1]?.seededBy.length);
    expect(zzzFirst[0]?.bestRank).toBe(zzzFirst[1]?.bestRank);
    // The counters are still carried — the pre-filter needs them — just never used to order.
    expect(zzzFirst[1]?.vendorDeployed).toBe(9_999);

    // And it is still a total order, so two runs over the same data spend quota on the same wallets.
    const aaaFirst = mergeSeeds([
      { label: 'recent-bonds', wallets: [{ wallet: 'aaa', vendorDeployed: 6, vendorBonded: 1 }] },
      { label: 'alerts', wallets: [{ wallet: 'zzz', vendorDeployed: 9_999, vendorBonded: 9_999 }] },
    ]);
    expect(aaaFirst.map((m) => m.wallet)).toEqual(['aaa', 'zzz']);
  });

  it('counts every seed\'s yield, so an inert seed cannot be invisible again', () => {
    const plan = buildSeedPlan({ limit: 10, tier: 'elite' });
    const recentBonds = plan[0]!;
    const alerts = plan[1]!;

    // The elite-tier recent-bond feed IS recent-bonds?tier=elite — there is no separate endpoint.
    expect(recentBonds.path).toBe('/deployer-hunter/recent-bonds');
    expect(recentBonds.query['tier']).toBe('elite');
    expect(recentBonds.label).toBe('recent-bonds:elite');

    const live = readSeedResponse(recentBonds, {
      tokens: [{ deployers: { wallet_address: 'w1', total_tokens_deployed: 7, total_bonded: 7 } }],
    });
    expect(live).toMatchObject({
      label: 'recent-bonds:elite',
      path: '/deployer-hunter/recent-bonds',
      rowsReturned: 1,
      walletsReturned: 1,
    });

    // The exact regression: rows arrive and we read nothing out of them. `rowsReturned` without
    // `walletsReturned` is the fingerprint of our reader being wrong rather than the vendor empty.
    const shapeMoved = readSeedResponse(alerts, {
      alerts: [{ token_mint: 'M', someFutureBlockName: { wallet_address: 'w1' } }],
    });
    expect(shapeMoved.rowsReturned).toBe(1);
    expect(shapeMoved.walletsReturned).toBe(0);

    const empty = readSeedResponse(alerts, { alerts: [] });
    expect(empty.rowsReturned).toBe(0);
    expect(empty.walletsReturned).toBe(0);
  });

  it('accounts for coverage, and names a zero-yield seed as inert', () => {
    const cov = summariseCoverage({
      seeds: [
        { label: 'recent-bonds:elite', path: '/a', rowsReturned: 50, walletsReturned: 50, wallets: [] },
        { label: 'alerts:elite', path: '/b', rowsReturned: 40, walletsReturned: 0, wallets: [] },
      ],
      distinctWalletsSeeded: 55,
      prefilteredOut: 5,
      worthARequest: 50,
      candidateCap: 12,
      gated: 12,
    });
    expect(cov.inertSeeds).toEqual(['alerts:elite']);
    // 50 worth a request, cap of 12 — so 38 seeded wallets were never measured, and the run must
    // say so rather than read as a screen of everything enumeration found.
    expect(cov.droppedByCandidateCap).toBe(38);
    expect(cov.coverageTruncated).toBe(true);

    const complete = summariseCoverage({
      seeds: [{ label: 's', path: '/a', rowsReturned: 8, walletsReturned: 8, wallets: [] }],
      distinctWalletsSeeded: 8,
      prefilteredOut: 2,
      worthARequest: 6,
      candidateCap: 20,
      gated: 6,
    });
    expect(complete.inertSeeds).toEqual([]);
    expect(complete.droppedByCandidateCap).toBe(0);
    expect(complete.coverageTruncated).toBe(false);

    // A run that stopped mid-gate is truncated even though the cap never bit.
    const stoppedEarly = summariseCoverage({
      seeds: [],
      distinctWalletsSeeded: 8,
      prefilteredOut: 0,
      worthARequest: 8,
      candidateCap: 20,
      gated: 3,
    });
    expect(stoppedEarly.coverageTruncated).toBe(true);
  });

  it('keeps the largest counter when two endpoints disagree', () => {
    const merged = mergeSeeds([
      { label: 'a', wallets: [{ wallet: 'w', vendorDeployed: 3, vendorBonded: 1 }] },
      { label: 'b', wallets: [{ wallet: 'w', vendorDeployed: 30, vendorBonded: 12 }] },
    ]);
    // Their blocks refresh at different times; err towards spending the request.
    expect(merged[0]?.vendorDeployed).toBe(30);
    expect(merged[0]?.vendorBonded).toBe(12);
    expect(prefilterReason(merged[0]!)).toBeNull();
  });

  it('does not record a duplicate label when one query lists a wallet twice', () => {
    const merged = mergeSeeds([
      { label: 'a', wallets: [{ wallet: 'w1', vendorDeployed: 9, vendorBonded: 3 }, { wallet: 'w1', vendorDeployed: 9, vendorBonded: 3 }] },
    ]);
    expect(merged[0]?.seededBy).toEqual(['a']);
  });
});

describe('the CLI contract', () => {
  it('parses the documented flags', () => {
    const r = parseArgs(['--stage0', '--dry-run', '--candidates', '5', '--tier', 'elite', '--consistency']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.opts.stage0Only).toBe(true);
    expect(r.opts.dryRun).toBe(true);
    expect(r.opts.candidates).toBe(5);
    expect(r.opts.tier).toBe('elite');
    expect(r.opts.consistency).toBe(true);
  });

  it('rejects bad input rather than guessing', () => {
    for (const argv of [
      ['--candidates', 'many'],
      ['--candidates', '0'],
      ['--max-requests', '-3'],
      ['--tier', 'platinum'],
      ['--out'],
      ['--nonsense'],
    ]) {
      expect(parseArgs(argv).ok, argv.join(' ')).toBe(false);
    }
  });

  it('writes nothing by default — persistence is opt-in', () => {
    const r = parseArgs([]);
    if (!r.ok) throw new Error('unreachable');
    expect(r.opts.out).toBeNull();
  });

  it('scores ENTRY by default, because that is the question the tool exists for', () => {
    const r = parseArgs([]);
    if (!r.ok) throw new Error('unreachable');
    // Shipping the answerable question off by default would make the unanswerable one the headline.
    expect(r.opts.stage2).toBe(true);
    expect(r.opts.scoreCandidates).toBeNull();

    const off = parseArgs(['--no-stage2']);
    if (!off.ok) throw new Error('unreachable');
    expect(off.opts.stage2).toBe(false);

    const scored = parseArgs(['--score', '2']);
    if (!scored.ok) throw new Error('unreachable');
    expect(scored.opts.scoreCandidates).toBe(2);
    expect(parseArgs(['--score', '0']).ok).toBe(false);
    expect(parseArgs(['--score']).ok).toBe(false);
  });

  it('the dry run prints Stage 2\'s whole exposure before a single request', () => {
    const T = loadThresholds();
    const text = renderDryRun({
      seedPlan: [],
      maxCandidates: 12,
      maxKeyedRequests: 45,
      consistency: false,
      maxKeylessRequests: T['budget'].maxKeylessRequests,
      stage2: true,
      maxScored: T['stage2_entry'].maxCandidatesScored,
      entryThresholds: T['stage2_entry'],
      keyDescription: null,
    });
    const worstCase =
      T['stage2_entry'].maxCandidatesScored *
      T['stage2_entry'].maxLaunchesPerCandidate *
      T['stage2_entry'].maxRequestsPerLaunch;
    expect(text).toMatch(/WORST CASE/);
    expect(text).toContain(String(worstCase));
    expect(text).toMatch(/WHOLE exposure/i);
    // And it says out loud that the stage costs no vendor quota, which is the fact a reviewer of a
    // provider-bound change most needs.
    expect(text).toMatch(/NO KEYED REQUEST/);
    // With --no-stage2 the plan must say what is NOT being measured, not merely go quiet.
    const off = renderDryRun({
      seedPlan: [],
      maxCandidates: 12,
      maxKeyedRequests: 45,
      consistency: false,
      maxKeylessRequests: T['budget'].maxKeylessRequests,
      stage2: false,
      maxScored: 0,
      entryThresholds: T['stage2_entry'],
      keyDescription: null,
    });
    expect(off).toMatch(/STAGE 2 DISABLED/);
    expect(off).toMatch(/nothing about whether a window is enterable/);
  });

  it('ships pinned thresholds, with Stage 2 active and every provider bound tied together', () => {
    const T = loadThresholds();
    expect(T['stage1_gate'].minTokens).toBe(25);
    expect(T['stage1_gate'].minCompletionRate).toBe(0.25);
    expect(T['stage1_gate'].minSpanDays).toBe(14);
    expect(T['stage1_gate'].completionRateSource).toBe('profile.pump_tokens[].complete');
    // The gate must never be able to read a vendor aggregate.
    expect(JSON.stringify(T['stage1_gate'])).not.toMatch(/"bonding_rate"\s*:/);
    // Stage 2 is now built, and its block is the v2.0.0 `stage2_seam` promoted in place. The two
    // values that block RESERVED were pinned before this lane existed to apply them, and they must
    // still be the ones in force: a bar derived after seeing the output it judges is not a bar.
    expect(T['stage2_seam']).toBeUndefined();
    expect(T['stage2_entry'].active).toBe(true);
    expect(T['stage2_entry'].minRoomLeft).toBe(0.55);
    expect(T['stage2_entry'].minLaunchesSampled).toBe(8);
    // Every provider bound Stage 2 has, and the arithmetic that ties them together. The declared
    // worst case must not exceed the ceiling, or the dry run's plan is not the whole exposure.
    const s2 = T['stage2_entry'];
    expect(s2.maxCandidatesScored * s2.maxLaunchesPerCandidate * s2.maxRequestsPerLaunch).toBeLessThanOrEqual(
      s2.maxKeylessRequests,
    );
    expect(s2.maxKeylessRequests).toBeLessThanOrEqual(loadThresholds()['budget'].maxKeylessRequests);
    // Every Stage 2 threshold carries its anchor, same rule as the gate's.
    for (const key of Object.keys(s2)) {
      if (key.startsWith('$') || key === 'active' || key === 'justification') continue;
      expect(s2.justification[key], `stage2_entry.${key} has no justification`).toBeTruthy();
    }
    // Every threshold carries its anchor.
    expect(Object.keys(T['stage1_gate'].justification).sort()).toEqual([
      'minCompletionRate',
      'minSpanDays',
      'minTokens',
    ]);
  });

  it('never reports a malformed query as a rejected credential', () => {
    // A 400 is OUR query shape. Telling an operator their key was rejected — on a tier where keys
    // expire every 30 days, so expiry is the plausible reading — sends them to rotate a key that
    // works. It is an upstream failure: the thing that failed is upstream of the credential.
    expect(exitForRefusal('malformed-request')).toBe(7);
    expect(exitForRefusal('expired-or-revoked')).toBe(4);
    expect(exitForRefusal('wrong-tier')).toBe(4);
    expect(exitForRefusal('quota-exhausted')).toBe(5);
    // Every refusal kind the credential module can produce is mapped, and none of them maps to 0.
    for (const kind of ['malformed-request', 'expired-or-revoked', 'wrong-tier', 'quota-exhausted'] as const) {
      expect(exitForRefusal(kind)).not.toBe(0);
    }
  });

  it('bounds every run in the pinned budget', () => {
    const b = loadThresholds()['budget'];
    expect(b.maxKeyedRequests).toBeLessThanOrEqual(50); // a quarter of the shared 200/day
    expect(b.maxCandidates).toBeLessThanOrEqual(20);
    expect(b.keyedMinIntervalMs).toBeGreaterThanOrEqual(6_000); // Free tier bursts at ~10/min
    expect(b.keylessMinIntervalMs).toBeGreaterThanOrEqual(2_000); // measured pump.fun pacing
  });
});

describe('an incomplete run can never read as a measured negative', () => {
  const render = (o: { completed: boolean; candidates?: unknown[]; coverageTruncated?: boolean }) =>
    renderStage1({
      candidates: (o.candidates ?? []) as never,
      keyedRequests: 4,
      keylessRequests: 0,
      elapsedMs: 1000,
      startedAtIso: '2026-07-29T00:00:00.000Z',
      completed: o.completed,
      truncationReason: o.completed ? 'the candidate cap dropped 8 seeded wallet(s)' : 'HTTP 429 — rate-limited',
      prefiltered: 0,
      coverage: {
        seeds: [],
        inertSeeds: [],
        distinctWalletsSeeded: 20,
        prefilteredOut: 0,
        worthARequest: 20,
        candidateCap: 12,
        droppedByCandidateCap: o.coverageTruncated ? 8 : 0,
        gated: o.candidates?.length ?? 0,
        coverageTruncated: o.coverageTruncated ?? false,
      },
      thresholds: {},
    });

  const COMPLETION_CLAIM = /the run completed and every candidate/;

  it('does NOT claim completion when the run died with nothing passing', () => {
    const text = render({ completed: false });
    // The exact prohibited output: an empty ranking that reads as a real negative result.
    expect(text).not.toMatch(COMPLETION_CLAIM);
    expect(text).not.toMatch(/This is a real measured outcome/);
    expect(text).toMatch(/RUN STOPPED EARLY/);
    expect(text).toMatch(/NOT A NEGATIVE RESULT/);
    // It must name why, and say the unrequested wallets cannot have failed.
    expect(text).toMatch(/429/);
    expect(text).toMatch(/never requested cannot have failed/);
  });

  it('still claims completion when the run genuinely completed with nothing passing', () => {
    const text = render({ completed: true });
    expect(text).toMatch(/NO CANDIDATE CLEARED THE GATE\./);
    expect(text).toMatch(COMPLETION_CLAIM);
    expect(text).not.toMatch(/RUN STOPPED EARLY/);
  });

  it('separates a capped-coverage run from an aborted one', () => {
    // A completed run whose candidate cap bit is truncated but NOT incomplete: every candidate it
    // gated really was evaluated. Conflating the two is what produced the false claim.
    const capped = render({ completed: true, coverageTruncated: true });
    expect(capped).toMatch(/COVERAGE TRUNCATED/);
    expect(capped).toMatch(/The run completed and every candidate it gated was evaluated/);
    expect(capped).not.toMatch(/RUN STOPPED EARLY/);

    const aborted = render({ completed: false, coverageTruncated: true });
    expect(aborted).toMatch(/RUN STOPPED EARLY/);
    expect(aborted).not.toMatch(/COVERAGE TRUNCATED/);
    expect(aborted).not.toMatch(COMPLETION_CLAIM);
  });

  it('carries the limitation block whether or not the run finished', () => {
    for (const completed of [true, false]) {
      expect(render({ completed })).toContain(LIMITATIONS[0] as string);
    }
  });

  it('writes an incomplete record beside the good one, never over it', () => {
    // The documented invocation is --out runs/$(date +%F).json, so a same-day retry that dies on a
    // 401 must not overwrite that day's good record with candidates: [].
    expect(partialOutPath('runs/2026-07-29.json')).toBe('runs/2026-07-29.partial.json');
    expect(partialOutPath('/abs/path/run.json')).toBe('/abs/path/run.partial.json');
    // No .json extension to replace — append rather than mangle the name.
    expect(partialOutPath('runs/record')).toBe('runs/record.partial.json');
    // Whatever the input, the result is never the input.
    for (const p of ['runs/2026-07-29.json', '/abs/path/run.json', 'runs/record']) {
      expect(partialOutPath(p)).not.toBe(p);
      expect(partialOutPath(p).endsWith('.partial.json')).toBe(true);
    }
  });
});

describe('the run-record completeness contract', () => {
  /**
   * A SYNTHETIC schema-1 record: the shape that predates `completed`. Hand-built, not copied from
   * the committed artefact — and it carries the trap deliberately, `truncated: true` for the benign
   * reason (the candidate cap), which is precisely the state a careless reader misgrades.
   */
  const schema1 = {
    tool: 'deployer-screen',
    truncated: true,
    truncationReason: 'the candidate cap of 12 dropped 10 seeded wallet(s) before they were measured',
    coverage: { coverageTruncated: true, droppedByCandidateCap: 10 },
    candidates: [],
  };

  it('reads a record without `completed` as UNKNOWN, never as false', () => {
    expect(completenessOf(schema1)).toBe('unknown');
    // The whole point: unknown must not be either boolean, so `if (completed)` cannot be right.
    expect(completenessOf(schema1)).not.toBe(false);
    expect(completenessOf(schema1)).not.toBe(true);
    expect(completenessOf(schema1)).not.toBe('incomplete');
    expect(completenessOf(schema1)).not.toBe('complete');
  });

  it('never infers completeness from truncated or truncationReason', () => {
    // `truncated` describes WHAT IS MISSING, not whether the run reached the end. A schema-1 record
    // whose truncation is a benign cap must still resolve to unknown rather than to incomplete.
    expect(completenessOf({ ...schema1, truncated: true })).toBe('unknown');
    expect(completenessOf({ ...schema1, truncated: false, truncationReason: null })).toBe('unknown');
    expect(completenessOf({ truncationReason: 'HTTP 429 — rate-limited' })).toBe('unknown');
  });

  it('reads schema 2 as the boolean it records', () => {
    expect(completenessOf({ schemaVersion: 2, completed: true, truncated: true })).toBe('complete');
    expect(completenessOf({ schemaVersion: 2, completed: false, truncated: true })).toBe('incomplete');
    // A non-boolean `completed` is not a third opinion — it is unreadable, so unknown.
    expect(completenessOf({ schemaVersion: 2, completed: 'yes' })).toBe('unknown');
    expect(completenessOf(null)).toBe('unknown');
    expect(completenessOf('not a record')).toBe('unknown');
  });

  it('treats an absent schemaVersion as 1', () => {
    expect(schemaVersionOf(schema1)).toBe(1);
    expect(schemaVersionOf({ schemaVersion: 2 })).toBe(2);
    expect(schemaVersionOf({ schemaVersion: 'two' })).toBe(1);
    expect(schemaVersionOf(null)).toBe(1);
    // This build writes the current version, and it is >= 2 (the version that added `completed`).
    expect(RECORD_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('gives the unknown state somewhere honest to go', () => {
    expect(describeCompleteness('unknown')).toMatch(/UNKNOWN/);
    expect(describeCompleteness('unknown')).toMatch(/must not be guessed/);
    expect(describeCompleteness('incomplete')).toMatch(/nothing in it is a measured negative/);
    expect(describeCompleteness('complete')).toMatch(/reached the end/);
  });

  it('the committed record predates the field and resolves to unknown, not incomplete', () => {
    // The artefact is left byte-for-byte as the run wrote it: a committed record is evidence for the
    // grading lane, so it is not retro-edited to fit a later schema. This asserts the consequence —
    // that a reader following the contract cannot mistake that finished run for an aborted one.
    const records = readAll(join(TOOL_DIR, 'runs'), '', /\.json$/);
    expect(records.size).toBeGreaterThan(0);
    for (const [file, text] of records) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const state = completenessOf(parsed);
      expect(['complete', 'incomplete', 'unknown'], file).toContain(state);
      if (schemaVersionOf(parsed) === 1) {
        expect(state, `${file} is schema 1, so completeness is unknowable`).toBe('unknown');
        expect(parsed['completed'], file).toBeUndefined();
      } else {
        expect(state, `${file} is schema 2+, so it must state completeness`).not.toBe('unknown');
      }
    }
  });
});

describe('percentiles match the convention the tape report used', () => {
  it('interpolates linearly', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(median([1, 2, 3])).toBe(2);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

const TOOL_DIR = fileURLToPath(new URL('../tools/deployer-screen/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Read committed files under a directory.
 *
 * `pattern` defaults to source files, which is right for the import and `fetch` boundary assertions —
 * those are statements about code. It is deliberately WIDENED for the key-shaped-string scan: a
 * committed run record, `thresholds.json` or a README example is where an accidental paste of a real
 * key would most plausibly land, and a source-only filter never looked at any of them.
 */
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

describe('the keyless boundary holds in both directions', () => {
  it('the network tool never imports the keyless analysis core, and vice versa', () => {
    // The boundary is the directory. src/ is provably keyless (test/loader.test.ts) and must stay
    // that way; a dependency in either direction would blur the line that guarantee rests on.
    // Note the duplicated curve constants in measure.mjs: that duplication is this boundary's cost,
    // and it is paid on purpose.
    for (const [file, text] of readAll(SRC_DIR, 'src/')) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
    for (const [file, text] of readAll(TOOL_DIR, 'tools/deployer-screen/')) {
      expect(text, `${file} must not import from src/`).not.toMatch(/from\s+['"]\.\.\/\.\.\/src\//);
    }
  });

  it('only the two declared client modules may open a socket', () => {
    // Confining fetch to two named files is what makes "one request in flight, under a ceiling"
    // auditable: any other module that grew a fetch would bypass both.
    const allowed = new Set(['tools/deployer-screen/client.mjs', 'tools/deployer-screen/pumpfun.mjs']);
    for (const [file, text] of readAll(TOOL_DIR, 'tools/deployer-screen/')) {
      if (allowed.has(file)) continue;
      expect(/\bfetch\s*\(/.test(text), `${file} must not call fetch directly`).toBe(false);
    }
  });

  it('only the credential module names the environment variable that holds the key', () => {
    // screen.mjs may re-export it for the help text, but nothing else may reach for process.env
    // to find a credential.
    const allowed = new Set([
      'tools/deployer-screen/credential.mjs',
      'tools/deployer-screen/screen.mjs',
    ]);
    for (const [file, text] of readAll(TOOL_DIR, 'tools/deployer-screen/')) {
      if (allowed.has(file)) continue;
      expect(/MADEONSOL_API_KEY/.test(text), `${file} must not name the key variable`).toBe(false);
    }
  });

  it('no committed file under the tool holds a key-shaped string', () => {
    // EVERY committed file, not just the sources: runs/*.json, thresholds.json and README.md are
    // the likeliest places a real key gets pasted by accident, and they went unscanned.
    const all = readAll(TOOL_DIR, 'tools/deployer-screen/', /./);
    expect([...all.keys()]).toContain('tools/deployer-screen/README.md');
    expect([...all.keys()]).toContain('tools/deployer-screen/thresholds.json');
    expect([...all.keys()].some((f) => f.startsWith('tools/deployer-screen/runs/'))).toBe(true);

    for (const [file, text] of all) {
      // A real msk_ key is 47 characters. Test doubles are shorter or obviously fake, and no
      // committed file has any business containing one at all.
      expect(/msk_[A-Za-z0-9_-]{20,}/.test(text), `${file} may contain a real key`).toBe(false);
    }
  });

  it('a committed run record persists derived fields only — ToS §5a(d), asserted', () => {
    // The README makes a ToS-facing claim about exactly which fields survive a run. It is asserted
    // here so the claim cannot drift from the code, and so a future field addition has to come and
    // change this list on purpose.
    // An ALLOWED SET rather than an exact list, because committed records are evidence and are
    // never retro-edited: the schema-1 record predates `entry` and legitimately lacks it. The
    // ToS-facing claim is that nothing OUTSIDE this set is ever persisted, and a subset check is
    // exactly that claim. The current writer's own row shape is pinned separately, below.
    const ALLOWED = new Set([
      'completed',
      'completionRate',
      'consistency',
      'entry',
      'gateReasons',
      'rationale',
      'seededBy',
      'spanDays',
      'tokens',
      'vendorPageCapped',
      'verdict',
      'wallet',
      'windowFirstDeploy',
      'windowLastDeploy',
    ]);
    // Anything from the vendor's per-token records. None of these may appear in a candidate row.
    const FORBIDDEN =
      /"(mint|token_mint|token_name|token_symbol|symbol|name|peak_market_cap|mc_at_bond|bonded_at|deployed_at|time_to_bond_minutes|ath_market_cap|pool_address|token_image_url)"/;

    const records = readAll(join(TOOL_DIR, 'runs'), '', /\.json$/);
    expect(records.size).toBeGreaterThan(0);
    for (const [file, text] of records) {
      const parsed = JSON.parse(text) as { candidates: Record<string, unknown>[] };
      expect(parsed.candidates.length, file).toBeGreaterThan(0);
      for (const row of parsed.candidates) {
        for (const key of Object.keys(row)) {
          expect(ALLOWED.has(key), `${file} candidate row persists unexpected field '${key}'`).toBe(true);
        }
        expect(FORBIDDEN.test(JSON.stringify(row)), `${file} holds per-token vendor data`).toBe(false);
      }
    }
  });
});

// =============================================================================================
// STAGE 2 — ENTRY
// =============================================================================================

const ENTRY_T: EntryThresholds = {
  minRoomLeft: 0.55,
  minLaunchesSampled: 8,
  minFieldRoundTrips: 10,
  minFieldHitRateGross: 0.5,
};

describe('distributions and a hit rate, never a mean', () => {
  it('reports quantiles and NO mean — the captain bar, enforced on the shape', () => {
    const d = distribution([1, 2, 3, 4, 100]);
    expect(Object.keys(d).sort()).toEqual(['max', 'median', 'min', 'n', 'p10', 'p25', 'p75', 'p90']);
    expect(d.median).toBe(3);
    expect(d.min).toBe(1);
    expect(d.max).toBe(100);
    // The point of the rule, in one assertion: the arithmetic mean of this sample is 22, which is
    // larger than 80% of the observations and describes none of them.
    expect(JSON.stringify(d)).not.toContain('22');
  });

  it('the entry module computes no mean anywhere, and says so in its own source', () => {
    // A source-level guard rather than an output-level one. An output-level check only catches a
    // mean that got a field name; this catches one computed for a threshold comparison, where it
    // would be invisible and would still be the wrong answer.
    const src = readFileSync(join(TOOL_DIR, 'entry.mjs'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.includes('/**'))
      .join('\n');
    expect(code).not.toMatch(/\b(mean|average|avg)\b/i);
    expect(code).not.toMatch(/reduce\([^)]*\+/);
  });

  it('an empty sample yields NaN, never a zero that reads as a measured negative', () => {
    const d = distribution([]);
    expect(d.n).toBe(0);
    expect(Number.isNaN(d.median)).toBe(true);
    const h = hitRate([], () => true);
    expect(h.n).toBe(0);
    // 'no observations' and 'none of the observations hit' are different findings.
    expect(Number.isNaN(h.rate)).toBe(true);
    expect(h.rate).not.toBe(0);
  });

  it('drops non-finite observations rather than propagating them through every quantile', () => {
    const d = distribution([1, Number.NaN, 3]);
    expect(d.n).toBe(2);
    expect(d.median).toBe(2);
  });
});

describe('the field — what every OTHER sniping wallet achieved', () => {
  /** dev 10 SOL, a 2-wallet bundle at 3 each, then two independent wallets. */
  const openingWindow = () => [
    fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 10, tokens: 1000 }),
    fill({ slot: 100, tx: 'bundle', wallet: 'book1', sol: 3, tokens: 200 }),
    fill({ slot: 100, tx: 'bundle', wallet: 'book2', sol: 3, tokens: 200 }),
    fill({ slot: 100, tx: 'o1', wallet: 'winner', sol: 2, tokens: 100 }),
    fill({ slot: 100, tx: 'o2', wallet: 'loser', sol: 2, tokens: 90 }),
    // Later in the window: one closes at a profit, one closes at a loss.
    fill({ slot: 140, tx: 's1', wallet: 'winner', sol: 5, tokens: 100, side: 'sell' }),
    fill({ slot: 145, tx: 's2', wallet: 'loser', sol: 1, tokens: 90, side: 'sell' }),
  ];

  it('measures fill, queue position and SOL queued ahead for every competing wallet', () => {
    const e = measureLaunchEntry(openingWindow());
    expect(e).not.toBeNull();
    const field = e!.field;
    expect(field.map((f) => f.wallet)).toEqual(['winner', 'loser']);

    const winner = field[0]!;
    expect(winner.createSlotFillSol).toBe(2);
    expect(winner.queuePosition).toBe(4);
    // dev 10 + book 3 + book 3 = 16 SOL was already committed ahead of it.
    expect(winner.solQueuedAheadSol).toBe(16);
    expect(field[1]!.solQueuedAheadSol).toBe(18);
  });

  it('reports realised P&L as a distribution and a hit rate, gross of fees', () => {
    const e = measureLaunchEntry(openingWindow())!;
    expect(e.field[0]!.realisedSolGrossOfFees).toBeCloseTo(3, 10); // 5 out, 2 in
    expect(e.field[1]!.realisedSolGrossOfFees).toBeCloseTo(-1, 10); // 1 out, 2 in
    expect(e.field[0]!.returnPerSolGrossOfFees).toBeCloseTo(1.5, 10);

    const score = scoreEntry([e], ENTRY_T);
    expect(score.fieldHitRateGrossOfFees).toEqual({ n: 2, hits: 1, rate: 0.5 });
  });

  it('EVERY P&L field is named GrossOfFees, so a caller cannot forget what is missing', () => {
    const e = measureLaunchEntry(openingWindow())!;
    const pnlish = Object.keys(e.field[0]!).filter((k) => /realised|return|pnl|profit/i.test(k));
    expect(pnlish.length).toBeGreaterThan(0);
    for (const k of pnlish) expect(k, `${k} does not disclose that it is gross of fees`).toMatch(/GrossOfFees$/);

    const score = scoreEntry([e], ENTRY_T);
    for (const k of Object.keys(score).filter((k) => /realised|return|pnl|profit/i.test(k))) {
      expect(k).toMatch(/GrossOfFees$/);
    }
    // The field's hit rate is a P&L statement too, so it carries the same disclosure. `roomHitRate`
    // deliberately does not: it is a share of launches leaving room, which fees cannot touch.
    expect(Object.keys(score)).toContain('fieldHitRateGrossOfFees');
    expect(Object.keys(score)).toContain('roomHitRate');
  });

  it('an OPEN position has no complete P&L and is counted, never marked to a price', () => {
    // The dataset's trap #2, on the live path: only closed pairs have a complete P&L, and an open
    // one contributes nothing to the distribution rather than a paper number.
    const fills = [
      fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 10, tokens: 1000 }),
      fill({ slot: 100, tx: 'o1', wallet: 'holder', sol: 2, tokens: 100 }),
      fill({ slot: 140, tx: 's1', wallet: 'holder', sol: 1, tokens: 40, side: 'sell' }),
    ];
    const e = measureLaunchEntry(fills)!;
    expect(e.field[0]!.closedInWindow).toBe(false);
    expect(Number.isNaN(e.field[0]!.realisedSolGrossOfFees)).toBe(true);

    const score = scoreEntry([e], ENTRY_T);
    expect(score.fieldOpenPositions).toBe(1);
    expect(score.fieldClosedRoundTrips).toBe(0);
    expect(score.fieldRealisedSolGrossOfFees.n).toBe(0);
    expect(score.caveats.join(' ')).toMatch(/still open .* NO complete P&L/);
  });

  it("uses the dataset's own 0.1% residual rule for closure, not exact equality", () => {
    const nearlyFlat = [
      fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 10, tokens: 1000 }),
      fill({ slot: 100, tx: 'o1', wallet: 'w', sol: 2, tokens: 100_000 }),
      fill({ slot: 140, tx: 's1', wallet: 'w', sol: 3, tokens: 99_950, side: 'sell' }),
    ];
    expect(measureLaunchEntry(nearlyFlat)!.field[0]!.closedInWindow).toBe(true);
  });

  it('treats an unreadable token amount as OPEN — undecidable is never rounded to closed', () => {
    // A closed pair contributes a P&L to the distribution. Guessing closure on a row we could not
    // read would fabricate one; guessing open only shrinks the sample and says so.
    const fills = [
      fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 10 }),
      fill({ slot: 100, tx: 'o1', wallet: 'w', sol: 2, tokens: Number.NaN }),
      fill({ slot: 140, tx: 's1', wallet: 'w', sol: 5, tokens: Number.NaN, side: 'sell' }),
    ];
    expect(measureLaunchEntry(fills)!.field[0]!.closedInWindow).toBe(false);
  });

  it('orders the create slot by sid, so live newest-first rows do not invert the queue', () => {
    // The live endpoint returns rows DESCENDING. Without the sort, the LAST wallet in the queue
    // would be read as the deployer and every "queued ahead" figure would be backwards.
    const descending = [
      fill({ slot: 100, sid: '0000000000000000000003', tx: 'o1', wallet: 'late', sol: 2 }),
      fill({ slot: 100, sid: '0000000000000000000002', tx: 'o2', wallet: 'mid', sol: 3 }),
      fill({ slot: 100, sid: '0000000000000000000001', tx: 'devtx', wallet: 'dev', sol: 10 }),
    ];
    const e = measureLaunchEntry(descending)!;
    expect(e.createSlot.deployer).toBe('dev');
    expect(e.field.map((f) => f.wallet)).toEqual(['mid', 'late']);
    expect(e.field[0]!.solQueuedAheadSol).toBe(10);
    expect(e.field[1]!.solQueuedAheadSol).toBe(13);
  });

  it('shares one definition of "the operation" with the room measurement', () => {
    // If these could disagree, the room figure would be a statement about a different population
    // than the field figure printed beside it.
    const fills = openingWindow();
    const groups = createSlotGroups(fills)!;
    const e = measureLaunchEntry(fills)!;
    expect(e.createSlot.deployer).toBe(groups.deployer);
    expect(e.createSlot.coordinatedWallets).toBe(groups.coordinated.size);
    expect(e.field.every((f) => f.wallet !== groups.deployer && !groups.coordinated.has(f.wallet))).toBe(true);
    expect(measureCreateSlot(fills)).toEqual(e.createSlot);
  });
});

describe('the entry verdict, and the leg that must never be able to earn one', () => {
  /**
   * A launch with a chosen room figure and a chosen field outcome.
   *
   * `roomLeft` is (independent SOL) / (dev + independent), so a dev buy of `10 * (1/room - 1)`
   * against 10 SOL of outsider capital lands on the room asked for.
   */
  const launch = (room: number, outcomes: number[]) => {
    const devSol = 10 * (1 / room - 1);
    const fills = [fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: devSol, tokens: 1e6 })];
    outcomes.forEach((realised, i) => {
      const stake = 10 / outcomes.length;
      fills.push(fill({ slot: 100, tx: `o${i}`, wallet: `w${i}`, sol: stake, tokens: 1000 }));
      fills.push(
        fill({ slot: 140, tx: `s${i}`, wallet: `w${i}`, sol: stake + realised, tokens: 1000, side: 'sell' }),
      );
    });
    return measureLaunchEntry(fills)!;
  };

  const many = (n: number, room: number, outcomes: number[]) =>
    Array.from({ length: n }, () => launch(room, outcomes));

  it('says entry-room-present only when BOTH legs allow it', () => {
    const s = scoreEntry(many(8, 0.7, [1, 1, -0.2]), ENTRY_T);
    expect(s.verdict).toBe('entry-room-present');
    expect(s.roomLeft.median).toBeCloseTo(0.7, 6);
    expect(s.fieldHitRateGrossOfFees.rate).toBeCloseTo(2 / 3, 6);
  });

  it('THE KNOWN-NEGATIVE SHAPE: a profitable-looking field cannot rescue a closed window', () => {
    // This is our own subject deployer's shape, synthesised: the window is taken (room ~0.24) and
    // yet the field reads overwhelmingly positive GROSS of fees. A design in which the field leg
    // can carry a verdict scores this wallet as beatable, and it is not.
    const s = scoreEntry(many(8, 0.24, [1, 1, 1, 1, -0.1]), ENTRY_T);
    expect(s.fieldHitRateGrossOfFees.rate).toBeCloseTo(0.8, 6);
    expect(s.fieldRealisedSolGrossOfFees.median).toBeGreaterThan(0);
    expect(s.verdict).toBe('entry-room-absent');
    expect(s.rationale).toMatch(/nothing to enter/);
    // And the room leg's failure is explained in the captain's framing, because that is what makes
    // the number actionable rather than merely reported.
    expect(s.rationale).toMatch(/launch bot is well configured/);
  });

  it('a field that loses money BEFORE costs vetoes a window that has room', () => {
    const s = scoreEntry(many(8, 0.7, [-1, -1, 0.2]), ENTRY_T);
    expect(s.verdict).toBe('entry-field-loss-making');
    expect(s.rationale).toMatch(/BEFORE costs/);
    // Conclusive in one direction only: fees can only make a gross loss worse.
    expect(s.rationale).toMatch(/Fees only make that worse/);
  });

  it('refuses to report anything from too few launches', () => {
    const s = scoreEntry(many(3, 0.9, [1, 1, 1]), ENTRY_T);
    expect(s.verdict).toBe('entry-unmeasured');
    expect(s.rationale).toMatch(/not a distribution/);
  });

  it('refuses a hit rate built on too few round trips, even with ample room', () => {
    const s = scoreEntry(many(8, 0.9, [1]), ENTRY_T);
    expect(s.fieldClosedRoundTrips).toBe(8);
    expect(s.verdict).toBe('entry-unmeasured');
    expect(s.rationale).toMatch(/field is UNMEASURED/);
    // Crucially it must not read as a negative: room was found, the field simply was not measured.
    expect(s.rationale).toMatch(/leaves room/);
  });

  it('never emits a verdict outside the declared ENTRY vocabulary', () => {
    const cases = [many(8, 0.7, [1, 1, -0.2]), many(8, 0.2, [1, 1, 1]), many(8, 0.7, [-1, -1]), many(2, 0.9, [1])];
    for (const c of cases) expect(ENTRY_VERDICTS).toContain(scoreEntry(c, ENTRY_T).verdict);
    // Nothing in the vocabulary claims profitability, beatability, or a recommendation.
    expect(ENTRY_VERDICTS.join(' ')).not.toMatch(/beatable|profitable|buy|recommend|good/i);
  });

  it('NO EXIT SIGNAL reaches any entry number — the separation is the deliverable', () => {
    const s = scoreEntry(many(8, 0.7, [1, 1, -0.2]), ENTRY_T);
    const numericFields = Object.entries(s).filter(([, v]) => typeof v === 'number' || (v && typeof v === 'object'));
    for (const [k] of numericFields) {
      expect(k, `${k} sounds like an exit measurement leaking into the entry score`).not.toMatch(
        /exit|dump|rug|ladder|sellPressure|trap/i,
      );
    }
    // And the caveats must say the omission out loud on every score, not only the negative ones.
    expect(s.caveats.join(' ')).toMatch(/ENTRY ONLY/);
    expect(s.caveats.join(' ')).toMatch(/GROSS OF FEES/);
    expect(s.rationale).toMatch(/exit feasibility is unmeasured/i);
  });

  it('discloses a deployer mismatch instead of silently measuring someone else', () => {
    const s = scoreEntry(many(8, 0.7, [1, 1, -0.2]), ENTRY_T, { candidateWallet: 'somebody-else' });
    expect(s.deployerMismatches).toBe(8);
    expect(s.caveats.join(' ')).toMatch(/first create-slot buyer other than the candidate/);
    // The direction of the error is stated, because it is the reason the launch is kept at all.
    expect(s.caveats.join(' ')).toMatch(/understates room/);
  });

  it('counts dropped windows in the caveats rather than quietly shrinking n', () => {
    const s = scoreEntry(many(4, 0.7, [1, 1]), ENTRY_T, { launchesDropped: 4 });
    expect(s.caveats.join(' ')).toMatch(/4 launch window\(s\) could not be walked back to the mint/);
    expect(s.rationale).toMatch(/4 window\(s\) were dropped/);
  });
});

describe('readLaunchWindow — coverage is a proof obligation, not an assumption', () => {
  const MINT = 'MINTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaapump';
  const CREATED = Date.parse('2026-07-28T12:00:00Z');

  /**
   * A fake `swap-api` that serves rows newest-first from a synthetic history, honouring the
   * timestamp half of the cursor exactly as the real endpoint was measured to on 2026-07-29.
   */
  const fakeEndpoint = (rows: Record<string, unknown>[], opts: { lieAboutHasMore?: boolean; stall?: boolean } = {}) => {
    const sorted = [...rows].sort((a, b) => Date.parse(String(b['timestamp'])) - Date.parse(String(a['timestamp'])));
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url));
      calls.push(u.pathname + u.search);
      const cursor = String(u.searchParams.get('cursor') ?? '');
      const limit = Number(u.searchParams.get('limit') ?? 100);
      const cursorMs = Number(cursor.split('-')[1] ?? Number.MAX_SAFE_INTEGER);
      const page = sorted.filter((r) => Date.parse(String(r['timestamp'])) <= cursorMs).slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = opts.stall ? cursor : `0-${last === undefined ? 0 : Date.parse(String(last['timestamp']))}`;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trades: page,
          pagination: {
            hasMore: opts.lieAboutHasMore === true ? true : page.length === limit,
            nextCursor,
            limit,
          },
        }),
      };
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  const row = (o: { ms: number; wallet: string; sol: number; sid: string; tx?: string; type?: string }) => ({
    slotIndexId: o.sid,
    tx: o.tx ?? `tx-${o.sid}`,
    timestamp: new Date(o.ms).toISOString(),
    userAddress: o.wallet,
    type: o.type ?? 'buy',
    program: 'pump',
    amountSol: String(o.sol),
    baseAmount: '1000',
    priceSol: '0.0000001',
  });

  /** The pre-mint history a real token does not have, used to prove the walk stops on time. */
  const history = () => [
    row({ ms: CREATED, wallet: 'dev', sol: 10, sid: '0004000000000000000001' }),
    row({ ms: CREATED + 1000, wallet: 'outsider', sol: 2, sid: '0004000000000000000002' }),
    row({ ms: CREATED + 30_000, wallet: 'outsider', sol: 5, sid: '0004000000000000000003', type: 'sell' }),
    // Outside the window, and therefore not part of the opening at all.
    row({ ms: CREATED + 120_000, wallet: 'latecomer', sol: 9, sid: '0004000000000000000009' }),
  ];

  const client = (fetchImpl: typeof fetch, maxRequests = 10) =>
    new KeylessClient({ maxRequests, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });

  it('seeks straight to the window end by timestamp and walks back to the mint', async () => {
    const { fetchImpl, calls } = fakeEndpoint(history());
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED,
      windowMs: 60_000,
      maxRequests: 10,
      pageLimit: 100,
    });
    expect(w.usable).toBe(true);
    expect(w.reachedCreateSlot).toBe(true);
    // The FIRST request already carries the cursor. That seek is what makes this affordable: it
    // turns walking a token's whole history into a handful of requests.
    expect(calls[0]).toContain(`cursor=0-${CREATED + 60_000}`);
    // Fills outside the window are dropped even though the endpoint returned them.
    expect(w.fills.map((f) => f.wallet).sort()).toEqual(['dev', 'outsider', 'outsider']);
    const e = measureLaunchEntry(w.fills)!;
    expect(e.createSlot.deployer).toBe('dev');
  });

  /**
   * An endpoint with an inexhaustible supply of in-window fills, so the walk can never get behind
   * the mint. This is the shape of a launch busier than the page cap allows for.
   */
  const neverReachesMint = () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trades: [row({ ms: CREATED + 30_000, wallet: `w${calls}`, sol: 1, sid: `00040000000000000${String(calls).padStart(5, '0')}` })],
          pagination: { hasMore: true, nextCursor: `0-${CREATED + 30_000 - calls}`, limit: 1 },
        }),
      };
    }) as unknown as typeof fetch;
    return { fetchImpl, count: () => calls };
  };

  it('DROPS a window that hit the page cap — the earliest slot seen is NOT the create slot', async () => {
    // The failure this exists to make impossible: a truncated walk still returns a plausible pile
    // of fills, and measuring it would crown a mid-window sniper as the deployer.
    const { fetchImpl } = neverReachesMint();
    const w = await readLaunchWindow(client(fetchImpl, 50), {
      mint: MINT,
      createdAtMs: CREATED,
      windowMs: 60_000,
      maxRequests: 3,
      pageLimit: 1,
    });
    expect(w.hitRequestCap).toBe(true);
    expect(w.reachedCreateSlot).toBe(false);
    expect(w.usable).toBe(false);
    expect(w.note).toMatch(/DROPPED/);
    expect(w.note).toMatch(/NOT the create slot/);
    expect(w.pages).toBe(3);
  });

  it('DROPS a window whose cursor stops advancing, and says so specifically', async () => {
    // A stalled cursor would otherwise burn the whole page cap and then be misdiagnosed as a
    // busy launch, which is the wrong thing to go and look at.
    const { fetchImpl } = fakeEndpoint(history(), { lieAboutHasMore: true, stall: true });
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED + 500,
      windowMs: 60_000,
      maxRequests: 10,
      pageLimit: 1,
    });
    expect(w.usable).toBe(false);
    expect(w.note).toMatch(/cursor stopped advancing/);
    expect(w.pages).toBeLessThan(10);
  });

  it('treats "no older fills" as having reached the mint, because it has', async () => {
    const { fetchImpl } = fakeEndpoint(history());
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED,
      windowMs: 60_000,
      maxRequests: 10,
      pageLimit: 2,
    });
    expect(w.reachedCreateSlot).toBe(true);
    expect(w.usable).toBe(true);
  });

  it('DROPS a window with an unreadable row rather than measuring the rest of it', async () => {
    const bad = [...history(), { ...row({ ms: CREATED + 2000, wallet: 'x', sol: 1, sid: '0004000000000000000004' }), program: 'some_new_amm' }];
    const { fetchImpl } = fakeEndpoint(bad);
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED,
      windowMs: 60_000,
      maxRequests: 10,
      pageLimit: 100,
    });
    expect(w.unparsedRows).toBe(1);
    expect(w.usable).toBe(false);
    expect(w.note).toMatch(/shape may have changed/);
  });

  it('never issues more requests than its page cap, whatever the endpoint says', async () => {
    const { fetchImpl, count } = neverReachesMint();
    await readLaunchWindow(client(fetchImpl, 100), {
      mint: MINT,
      createdAtMs: CREATED,
      windowMs: 60_000,
      maxRequests: 4,
      pageLimit: 1,
    });
    expect(count()).toBe(4);
  });
});

describe('Stage 2 spends what the dry run said it would, and no keyed request at all', () => {
  const T = loadThresholds()['stage2_entry'] as Record<string, number>;
  const CREATED = Date.parse('2026-07-28T12:00:00Z');
  const NOW = CREATED + 3_600_000;

  const profile = (n: number) => ({
    pump_tokens: Array.from({ length: n }, (_, i) => ({
      mint: `MINT${String(i).padStart(38, '0')}pump`,
      created_timestamp: CREATED - i * 3_600_000,
      complete: true,
    })),
  });

  /** An endpoint that never reaches the mint, so every launch burns its full page cap. */
  const insatiable = () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trades: [
            {
              slotIndexId: `000400000000000000${String(calls).padStart(4, '0')}`,
              tx: `tx${calls}`,
              timestamp: new Date(CREATED + 1000).toISOString(),
              userAddress: 'w',
              type: 'buy',
              program: 'pump',
              amountSol: '1',
              baseAmount: '1000',
              priceSol: '0.0000001',
            },
          ],
          pagination: { hasMore: true, nextCursor: `0-${CREATED + 1000 - calls}`, limit: 1 },
        }),
      };
    }) as unknown as typeof fetch;
    return { fetchImpl, count: () => calls };
  };

  it('cannot exceed its own stage ceiling even when every launch is pathological', async () => {
    const { fetchImpl, count } = insatiable();
    const client = new KeylessClient({
      maxRequests: T.maxKeylessRequests as number,
      minIntervalMs: 0,
      fetchImpl,
      sleepImpl: async () => {},
    });
    const { score, coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: profile(40),
      nowMs: NOW,
      thresholds: T as never,
      });
    // The per-candidate plan binds first: 8 launches x 10 pages, never the 40 the vendor offered.
    expect(coverage.launchesAttempted).toBe(T.maxLaunchesPerCandidate);
    expect(count()).toBeLessThanOrEqual((T.maxLaunchesPerCandidate as number) * (T.maxRequestsPerLaunch as number));
    expect(client.issued()).toBe(count());
    // Every window was unusable, so nothing was measured from a partial walk.
    expect(coverage.launchesUsable).toBe(0);
    expect(coverage.launchesDropped).toBe(T.maxLaunchesPerCandidate);
    expect(score.verdict).toBe('entry-unmeasured');
  });

  it('never starts a launch it cannot finish, and says why it stopped', async () => {
    const { fetchImpl, count } = insatiable();
    // Room for exactly two full launches and a remainder too small for a third.
    const budget = (T.maxRequestsPerLaunch as number) * 2 + 3;
    const client = new KeylessClient({ maxRequests: budget, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const { coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: profile(20),
      nowMs: NOW,
      thresholds: { ...T, maxKeylessRequests: budget } as never,
    });
    expect(coverage.launchesAttempted).toBe(2);
    expect(coverage.stoppedForBudget).toBe(true);
    expect(count()).toBe((T.maxRequestsPerLaunch as number) * 2);
    // The remainder is left unspent rather than half-walking a third launch for nothing.
    expect(client.remaining()).toBe(3);
    expect(coverage.dropNotes.join(' ')).toMatch(/never started unless it can be finished/);
  });

  it('skips launches younger than the window, which have not finished happening', async () => {
    const { fetchImpl } = insatiable();
    const client = new KeylessClient({ maxRequests: 200, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const { coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: profile(3),
      nowMs: CREATED + 10_000, // the newest launch is 10s old against a 60s window
      thresholds: T as never,
    });
    expect(coverage.launchRefsAvailable).toBe(3);
    expect(coverage.launchesAttempted).toBe(2);
  });

  it('reads the mint list from the profile Stage 1 already paid for — no second vendor call', () => {
    const refs = toLaunchRefs(profile(5));
    expect(refs).toHaveLength(5);
    // Newest first: a run samples recent launches, and recency is all this surface can speak to.
    expect(refs[0]!.deployedAtMs).toBeGreaterThan(refs[4]!.deployedAtMs);
    // A record with no usable mint or deploy time is skipped rather than guessed at.
    expect(toLaunchRefs({ pump_tokens: [{ created_timestamp: CREATED }, { mint: 'M' }] })).toEqual([]);
    expect(toLaunchRefs({})).toEqual([]);
    expect(toLaunchRefs(null)).toEqual([]);
  });

  it('the whole stage touches no keyed surface — asserted on the source, not promised', () => {
    // Comments are stripped first: both files DESCRIBE the keyed endpoint in prose, and it is the
    // executable half that must be unable to reach it.
    const code = (file: string) =>
      readFileSync(join(TOOL_DIR, file), 'utf8')
        .split('\n')
        .filter((l) => {
          const t = l.trimStart();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**') && !t.startsWith('/*');
        })
        .join('\n');
    for (const file of ['stage2.mjs', 'entry.mjs']) {
      expect(code(file), file).not.toMatch(/MADEONSOL/);
      expect(code(file), file).not.toMatch(/BoundedClient/);
      expect(code(file), file).not.toMatch(/deployer-hunter/);
      expect(code(file), file).not.toMatch(/fetch\(/);
    }
  });
});

describe('what a Stage 2 run record may persist', () => {
  const score = (): EntryScore => {
    const fills = [
      fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 3, tokens: 1000 }),
      fill({ slot: 100, tx: 'o1', wallet: 'SoMeCounterpartyWalletAddress1111111111111', sol: 3.5, tokens: 250 }),
      fill({ slot: 100, tx: 'o2', wallet: 'SoMeCounterpartyWalletAddress2222222222222', sol: 3.5, tokens: 250 }),
      fill({ slot: 140, tx: 's1', wallet: 'SoMeCounterpartyWalletAddress1111111111111', sol: 4.5, tokens: 250, side: 'sell' }),
      fill({ slot: 141, tx: 's2', wallet: 'SoMeCounterpartyWalletAddress2222222222222', sol: 4.5, tokens: 250, side: 'sell' }),
    ];
    return scoreEntry(Array.from({ length: 8 }, () => measureLaunchEntry(fills)!), ENTRY_T);
  };

  it('persists quantiles and counts — never a mint, never a counterparty address', () => {
    const row = toEntryRecordRow(score(), {
      launchRefsAvailable: 20,
      launchesAttempted: 8,
      launchesUsable: 8,
      launchesDropped: 0,
      requestsIssued: 34,
      stoppedForBudget: false,
      dropNotes: [],
    });
    const json = JSON.stringify(row);
    // Stage 2 held a mint list in memory to do the walk at all. None of it survives — MadeOnSol
    // terms §5a(d), implemented rather than promised.
    expect(json).not.toMatch(/MINT[0-9a-zA-Z]*pump/);
    expect(json).not.toContain('SoMeCounterpartyWalletAddress1111111111111');
    expect(json).not.toContain('SoMeCounterpartyWalletAddress2222222222222');
    expect(json).not.toMatch(/"(mint|symbol|token_name|ath_market_cap|bonded_at)"/);
    // And no mean, at the record layer too.
    expect(json).not.toMatch(/"(mean|average|avg)"/i);
    expect(row.roomLeft.median).toBeCloseTo(0.7, 6);
    expect(row.verdict).toBe('entry-room-present');
  });

  it('renders NaN as null rather than as a number a consumer would believe', () => {
    const empty = scoreEntry([], ENTRY_T);
    const row = toEntryRecordRow(empty, {
      launchRefsAvailable: 0,
      launchesAttempted: 0,
      launchesUsable: 0,
      launchesDropped: 0,
      requestsIssued: 0,
      stoppedForBudget: false,
      dropNotes: [],
    });
    expect(row.roomLeft.median).toBeNull();
    expect(row.fieldHitRateGrossOfFees.rate).toBeNull();
    expect(row.verdict).toBe('entry-unmeasured');
  });
});

describe('the keyless client retries a shed request, and a retry is not free', () => {
  /** @returns a fetch that sheds `shedCount` times before answering. */
  const shedding = (shedCount: number, status = 429) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls <= shedCount) return { ok: false, status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: calls }) };
    }) as unknown as typeof fetch;
    return { fetchImpl, count: () => calls };
  };

  const client = (fetchImpl: typeof fetch, maxRequests = 10) =>
    new KeylessClient({ maxRequests, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });

  it('retries through a 429, which on this endpoint is the normal case and not an incident', async () => {
    // Measured on the committed tape's own build: 16,960 of 68,675 requests were shed, and 221 of
    // 235 launches shed at least once. A client without this cannot walk a launch window at all.
    const { fetchImpl, count } = shedding(2);
    const c = client(fetchImpl);
    await expect(c.getJson('https://swap-api.pump.fun/x')).resolves.toEqual({ ok: 3 });
    expect(count()).toBe(3);
    expect(c.shed()).toBe(2);
    // Every attempt counted. A bound that only counted successes would not be a bound.
    expect(c.issued()).toBe(3);
  });

  it('gives up after the configured backoffs rather than retrying forever', async () => {
    const { fetchImpl, count } = shedding(99);
    const c = client(fetchImpl);
    await expect(c.getJson('https://swap-api.pump.fun/x')).rejects.toThrow(/HTTP 429/);
    expect(count()).toBe(3); // one attempt plus the two default backoffs
    expect(c.issued()).toBe(3);
  });

  it('does NOT retry a 4xx that is our own query shape', async () => {
    // A 400 is our URL, not their load. Retrying it spends a shared public resource to be told off
    // a second time — the same reasoning that maps a vendor 400 to exit 7 rather than exit 4.
    const { fetchImpl, count } = shedding(99, 400);
    const c = client(fetchImpl);
    await expect(c.getJson('https://swap-api.pump.fun/x')).rejects.toThrow(/HTTP 400/);
    expect(count()).toBe(1);
    expect(c.shed()).toBe(0);
  });

  it('stops at the ceiling even when every attempt is a retry', async () => {
    const { fetchImpl, count } = shedding(99);
    const c = client(fetchImpl, 2);
    await expect(c.getJson('https://swap-api.pump.fun/x')).rejects.toBeInstanceOf(CeilingReached);
    expect(count()).toBe(2);
    expect(c.remaining()).toBe(0);
  });

  it('a per-launch cap counts REQUESTS, so retries cannot widen it', async () => {
    // If the cap counted successful PAGES instead, this launch would cost 6 pages x 3 attempts = 18
    // requests, and the dry run's printed plan would understate the real exposure threefold.
    const CREATED = Date.parse('2026-07-28T12:00:00Z');
    let calls = 0;
    // Sheds every other request, and never serves a row older than the mint, so the walk keeps
    // going until something stops it. Only the request cap can.
    const fetchImpl = (async () => {
      calls += 1;
      if (calls % 2 === 1) return { ok: false, status: 429, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trades: [
            {
              slotIndexId: `00040000000000000${String(calls).padStart(5, '0')}`,
              tx: `tx${calls}`,
              timestamp: new Date(CREATED + 30_000).toISOString(),
              userAddress: 'w',
              type: 'buy',
              program: 'pump',
              amountSol: '1',
              baseAmount: '1000',
              priceSol: '0.0000001',
            },
          ],
          pagination: { hasMore: true, nextCursor: `0-${CREATED + 30_000 - calls}`, limit: 1 },
        }),
      };
    }) as unknown as typeof fetch;

    const c = client(fetchImpl, 100);
    const w = await readLaunchWindow(c, {
      mint: 'MINTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaapump',
      createdAtMs: CREATED,
      windowMs: 60_000,
      maxRequests: 6,
      pageLimit: 1,
    });
    expect(calls).toBe(6);
    expect(w.requests).toBe(6);
    expect(w.pages).toBe(3); // half of them were shed and retried
    expect(c.shed()).toBe(3);
    expect(w.hitRequestCap).toBe(true);
    expect(w.usable).toBe(false);
  });
});

describe('THE KNOWN-NEGATIVE CONTROL, run against the committed tape', () => {
  // Slow by design: it reads all 235 covered window tapes and the 46,553-row P&L table. It is the
  // one test that proves the whole entry stage on real data rather than on a fixture, and it is the
  // reason a regression in Stage 2 cannot ship quietly.
  const DATA_DIR = join(TOOL_DIR, '..', '..', 'data', 'population-tape-2026-07-29');
  const T = loadThresholds();
  const result = runStage0(
    DATA_DIR,
    {
      minTokens: T['stage1_gate'].minTokens,
      minCompletionRate: T['stage1_gate'].minCompletionRate,
      minSpanDays: T['stage1_gate'].minSpanDays,
    },
    T['stage2_entry'],
  );

  it('passes, so the screen still reproduces every answer we already hold', () => {
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('the gate PASSES 7ufmve7Z and Stage 2 REFUSES it — both halves, on the same wallet', () => {
    expect(result.subjectGate.passed).toBe(true);
    expect(result.subjectEntryRecent.verdict).toBe('entry-room-absent');
    expect(result.subjectEntryPostBreak.verdict).toBe('entry-room-absent');
    // Competence and entry room are separate claims with separate vocabularies, and this wallet is
    // the proof that they come apart.
    expect(result.subjectVerdict.verdict).toBe('gate-passed');
  });

  it('and the field leg, followed alone, WOULD have called it beatable', () => {
    // The whole reason the control is an assertion rather than a threshold comparison. Gross of
    // fees this wallet's post-break field is overwhelmingly positive; fee-inclusive, the entire
    // outsider population made +0.54 SOL per launch with 51 of 106 wallets losing money.
    const field = result.subjectEntryPostBreak;
    expect(field.fieldHitRateGrossOfFees.rate).toBeGreaterThan(T['stage2_entry'].minFieldHitRateGross);
    expect(field.fieldRealisedSolGrossOfFees.median).toBeGreaterThan(0);
    expect(field.fieldClosedRoundTrips).toBeGreaterThanOrEqual(T['stage2_entry'].minFieldRoundTrips);
    // Every field leg satisfied, and the verdict is still negative. That is the design working.
    expect(field.verdict).toBe('entry-room-absent');
  });

  it('reproduces the published §5.1 era split and the dataset\'s own P&L table', () => {
    for (const era of result.eraSplit) {
      expect(era.n).toBeGreaterThanOrEqual(era.minN);
      expect(Math.abs(era.operationShareMedian - era.publishedOperationShare)).toBeLessThan(0.02);
    }
    expect(result.fieldCheck.ok).toBe(true);
    expect(result.fieldCheck.pairs).toBeGreaterThan(1000);
    expect(result.fieldCheck.closureMismatches).toBe(0);
    expect(result.fieldCheck.maxRealisedErrorSol).toBeLessThan(1e-6);
  });

  it('fails LOUDLY if the entry bar is ever loosened enough to admit this wallet', () => {
    // A future lane that quietly drops minRoomLeft to fit an output gets this, rather than a
    // green suite and a wrong answer.
    const loosened = runStage0(
      DATA_DIR,
      {
        minTokens: T['stage1_gate'].minTokens,
        minCompletionRate: T['stage1_gate'].minCompletionRate,
        minSpanDays: T['stage1_gate'].minSpanDays,
      },
      { ...T['stage2_entry'], minRoomLeft: 0.1 },
    );
    expect(loosened.passed).toBe(false);
    expect(loosened.failures.join(' ')).toMatch(/SCORED OUR SUBJECT DEPLOYER AS HAVING ENTRY ROOM/);
    // And the failure message points at the leg most likely to be the culprit.
    expect(loosened.failures.join(' ')).toMatch(/field leg/);
  });
});
