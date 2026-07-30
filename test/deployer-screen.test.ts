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
  measureCompletion,
  measureCreateSlot,
  median,
  parseFill,
  percentile,
  solBetweenPrices,
  toTokenRecords,
} from '../tools/deployer-screen/measure.mjs';
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
} from '../tools/deployer-screen/seed.mjs';
import {
  extractTradeRows,
  parseFillLoose,
  slotFromSlotIndexId,
  windowFilter,
} from '../tools/deployer-screen/pumpfun.mjs';
import { parseArgs, loadThresholds } from '../tools/deployer-screen/screen.mjs';

const GATE = { minTokens: 25, minCompletionRate: 0.25, minSpanDays: 14 };

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
  const fill = (o: Partial<{ slot: number; tx: string; wallet: string; sol: number; side: 'buy' | 'sell' }>) => ({
    slot: o.slot ?? 100,
    tx: o.tx ?? 'tx0',
    wallet: o.wallet ?? 'w',
    side: o.side ?? ('buy' as const),
    venue: 'pump' as const,
    sol: o.sol ?? 1,
    priceSol: 1e-7,
  });

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
      { ...fill({ slot: 50, wallet: 'amm' }), venue: 'pump_amm' },
      { ...fill({ slot: 60, wallet: 'seller' }), side: 'sell' },
      fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 9 }),
    ]);
    expect(m!.slot).toBe(100);
    expect(m!.deployer).toBe('dev');
  });

  it('returns null rather than a fabricated measurement when there is no curve buy', () => {
    expect(measureCreateSlot([])).toBeNull();
    expect(measureCreateSlot([{ ...fill({}), side: 'sell' }])).toBeNull();
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
    const g = applyGate({ completion: completion(40, 20, 30), capped: false }, GATE);
    expect(g.passed).toBe(true);
    expect(g.reasons).toEqual([]);
  });

  it.each([
    ['sample', 20, 10, 30, /sample too small/],
    ['rate', 40, 4, 30, /completion rate/],
    ['span', 40, 20, 5, /spans/],
  ])('fails on %s and says which', (_label, n, done, span, re) => {
    const g = applyGate({ completion: completion(n, done, span), capped: false }, GATE);
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(re);
  });

  it('reports every failing reason, not just the first', () => {
    const g = applyGate({ completion: completion(5, 0, 1), capped: false }, GATE);
    expect(g.reasons.length).toBe(3);
  });

  it('fails a wallet with no usable records rather than scoring it zero', () => {
    const g = applyGate({ completion: measureCompletion([]), capped: false }, GATE);
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
  const candidate = (wallet: string, n: number, done: number, verdict: 'gate-passed' | 'gate-failed') => ({
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

  it('reads the wallet and the embedded deployer block from either nesting', () => {
    // recent-bonds and alerts nest the block under `deployer`; the leaderboard inlines it.
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

  it('prefers wallets that recur across endpoints, then the most active, deterministically', () => {
    const w = (wallet: string, deployed: number | null) => ({ wallet, vendorDeployed: deployed, vendorBonded: null });
    const merged = mergeSeeds([
      { label: 'recent-bonds', wallets: [w('w1', 10), w('w2', 90)] },
      { label: 'alerts', wallets: [w('w1', 10), w('w9', 50)] },
    ]);
    // w1 appears in both endpoints, so it earns a request before the busier w2 does.
    expect(merged[0]?.wallet).toBe('w1');
    expect(merged[0]?.seededBy).toEqual(['recent-bonds', 'alerts']);
    // Among singly-seeded wallets, the busier one first.
    expect(merged.slice(1).map((m) => m.wallet)).toEqual(['w2', 'w9']);
    expect(new Set(merged.map((m) => m.wallet)).size).toBe(merged.length);
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

  it('ships pinned thresholds whose stage-2 block is inert', () => {
    const T = loadThresholds();
    expect(T['stage1_gate'].minTokens).toBe(25);
    expect(T['stage1_gate'].minCompletionRate).toBe(0.25);
    expect(T['stage1_gate'].minSpanDays).toBe(14);
    expect(T['stage1_gate'].completionRateSource).toBe('profile.pump_tokens[].complete');
    // The gate must never be able to read a vendor aggregate.
    expect(JSON.stringify(T['stage1_gate'])).not.toMatch(/"bonding_rate"\s*:/);
    // Stage 2 is reserved, not active. If this flips to true, a scoring lane shipped without
    // updating the scope statements in render.mjs and the README.
    expect(T['stage2_seam'].active).toBe(false);
    // Every threshold carries its anchor.
    expect(Object.keys(T['stage1_gate'].justification).sort()).toEqual([
      'minCompletionRate',
      'minSpanDays',
      'minTokens',
    ]);
  });

  it('bounds every run in the pinned budget', () => {
    const b = loadThresholds()['budget'];
    expect(b.maxKeyedRequests).toBeLessThanOrEqual(50); // a quarter of the shared 200/day
    expect(b.maxCandidates).toBeLessThanOrEqual(20);
    expect(b.keyedMinIntervalMs).toBeGreaterThanOrEqual(6_000); // Free tier bursts at ~10/min
    expect(b.keylessMinIntervalMs).toBeGreaterThanOrEqual(2_000); // measured pump.fun pacing
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

function readAll(dir: string, prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const [k, v] of readAll(full, `${prefix}${entry}/`)) out.set(k, v);
    } else if (/\.(ts|mjs|js)$/.test(entry)) {
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
    for (const [file, text] of readAll(TOOL_DIR, 'tools/deployer-screen/')) {
      // A real msk_ key is 47 characters. Test doubles are shorter or obviously fake, and no
      // source file has any business containing one at all.
      expect(/msk_[A-Za-z0-9_-]{20,}/.test(text), `${file} may contain a real key`).toBe(false);
    }
  });
});
