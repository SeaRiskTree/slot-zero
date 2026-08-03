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
  HELIUS_KEY_ENV_VAR,
  HELIUS_RPC_HOST,
  KEY_ENV_VAR,
  PUBLIC_SOLANA_RPC,
  classifyAuthFailure,
  describeHeliusKey,
  describeKey,
  resolveKey,
  resolveSolanaRpcEndpoint,
} from '../tools/deployer-screen/credential.mjs';
import {
  BoundedClient,
  CeilingReached,
  ENDPOINT_ROLES,
  RequestFailed,
  UnparseableResponse,
  VendorRefused,
  buildPath,
  endpointOf,
} from '../tools/deployer-screen/client.mjs';
import {
  CURVE_INITIAL_PRICE_SOL,
  createSlotGroups,
  measureCompletion,
  measureCreateSlot,
  median,
  parseFill,
  percentile,
  roomIsProven,
  solBetweenPrices,
  toLaunchRefs,
  toTokenRecords,
  walletTransactions,
} from '../tools/deployer-screen/measure.mjs';
import type { Fill } from '../tools/deployer-screen/measure.mjs';
import {
  ENTRY_VERDICTS,
  LANDING_TIP_CAVEAT,
  distribution,
  entryCostTargets,
  hitRate,
  measureLaunchEntry,
  priceLaunchEntry,
  scoreEntry,
} from '../tools/deployer-screen/entry.mjs';
import type { EntryScore, EntryThresholds } from '../tools/deployer-screen/entry.mjs';
import {
  emptyCostCoverage,
  emptyDropReasons,
  scoreCandidateEntry,
  toEntryRecordRow,
} from '../tools/deployer-screen/stage2.mjs';
import type { Stage2Coverage } from '../tools/deployer-screen/stage2.mjs';
import { measureSubjectLaunches, replayRollingRoom, runStage0 } from '../tools/deployer-screen/stage0.mjs';
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
  LAMPORTS_PER_SOL,
  RpcCredentialRejected,
  SOLANA_RPC,
  SolanaRpcClient,
  creditsForTransactions,
  extractTradeRows,
  parseFillLoose,
  parseTransactionCosts,
  readCreateSlotCosts,
  readCreatedHistory,
  readCreatedHistoryIndexed,
  readLaunchWindow,
  slotFromSlotIndexId,
  windowFilter,
} from '../tools/deployer-screen/pumpfun.mjs';
import {
  PUMP_PROGRAM_ID,
  base58Encode,
  mergeHistories,
  parseCreateTransaction,
  readCurveState,
} from '../tools/deployer-screen/creation.mjs';
import {
  exitForRefusal,
  main,
  parseArgs,
  loadThresholds,
  partialOutPath,
} from '../tools/deployer-screen/screen.mjs';
import { LIMITATIONS, renderDryRun, renderEntry, renderStage1 } from '../tools/deployer-screen/render.mjs';
import {
  RECORD_SCHEMA_VERSION,
  UNMEASURED_KINDS,
  UNRECOGNISED_KIND,
  classifyUnmeasured,
  kindMetaOf,
  completenessOf,
  deriveTruncation,
  describeCompleteness,
  describeUnmeasured,
  groupUnmeasured,
  partitionUnmeasured,
  redactVendorIdentifiers,
  schemaVersionOf,
  unmeasuredBecause,
  unmeasuredNoSource,
} from '../tools/deployer-screen/record.mjs';

const GATE = { minTokens: 25, minCompletionRate: 0.25, minSpanDays: 14 };

/**
 * A Stage 2 coverage block with nothing in it, for tests about the record's SHAPE rather than its
 * numbers. Spread and overridden rather than restated, so a schema that grows a field breaks the
 * assertions that care and not the ones that do not.
 */
const emptyEntryCoverage = (): Stage2Coverage => ({
  launchRefsAvailable: 0,
  minAgeMs: 65_000,
  launchesTooYoung: 0,
  launchesEligible: 0,
  launchesPlanned: 0,
  launchesDroppedByCap: 0,
  youngestRefAgeMs: null,
  youngestEligibleAgeMs: null,
  launchesAttempted: 0,
  launchesUsable: 0,
  launchesDropped: 0,
  dropsByReason: emptyDropReasons(),
  requestsIssued: 0,
  stoppedForBudget: false,
  dropNotes: [],
  cost: emptyCostCoverage(),
});

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
    const kept = windowFilter(fills, 160); // the pinned live span, stage2_entry.windowSlotSpan
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

  it('does not blame the vendor for a zero the creation merge produced', () => {
    // Observed live: a wallet whose vendor profile carried 11 tokens and whose ownership listing
    // served 11 rows was rejected with "the vendor listed no tokens with a usable deploy time".
    // The zero came from our own merge. A reason that names the wrong party sends an operator to
    // the wrong place, and on this gate a rejection is the output nobody re-examines.
    const derived = applyGate(
      { completion: measureCompletion([]), historySource: 'creation-derived' },
      GATE,
    );
    expect(derived.reasons.join(' ')).not.toMatch(/vendor/);
    expect(derived.reasons.join(' ')).toMatch(/creation-derived history came out empty/);
    // The ownership reading keeps the sentence it was written for, and so does an unlabelled
    // caller — the vendor listing really is the only source there.
    const owned = applyGate(
      { completion: measureCompletion([]), historySource: 'ownership-only' },
      GATE,
    );
    expect(owned.reasons.join(' ')).toMatch(/the vendor listed no tokens/);
    expect(applyGate({ completion: measureCompletion([]) }, GATE).reasons.join(' ')).toMatch(
      /the vendor listed no tokens/,
    );
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

  it('never emits a measured verdict over a reading that was not measured', () => {
    // A gate-failed carrying an ordinary rationale over a history nobody actually read is the
    // invisible false rejection this whole reading exists to remove. The state has to live in the
    // VERDICT, not only in the wording beside it — a reader filtering on `verdict` must not miss it.
    const v = verdictFor({
      gate: { passed: false, reasons: ['completion rate 0.1000 < 0.25 required'] },
      completion: completion(40, 4, 30),
      capped: false,
      notMeasured: ['3 of 40 launch(es) have no bonded status from EITHER source'],
    });
    expect(v.verdict).toBe('gate-unmeasured');
    expect(v.rationale).toMatch(/NOT a rejection/);
    expect(v.rationale).toMatch(/no bonded status/);
    expect(v.rationale).not.toMatch(/did not clear the completion gate/);

    // It outranks a PASS too: an unmeasured reading is no better founded in that direction.
    const passing = verdictFor({
      gate: { passed: true, reasons: [] },
      completion: completion(40, 20, 30),
      capped: false,
      notMeasured: ['the ownership listing could not be read'],
    });
    expect(passing.verdict).toBe('gate-unmeasured');

    // And an empty list is not an unmeasured reading.
    expect(
      verdictFor({
        gate: { passed: true, reasons: [] },
        completion: completion(40, 20, 30),
        capped: false,
        notMeasured: [],
      }).verdict,
    ).toBe('gate-passed');
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
    verdict: 'gate-passed' | 'gate-unmeasured' | 'gate-failed',
    roomMedian?: number,
  ) => {
    const completion = measureCompletion(
      Array.from({ length: n }, (_, i) => ({ deployedAtMs: T0 + i * DAY, completed: i < done })),
    );
    return {
      wallet,
      seededBy: ['leaderboard:total_bonded'],
      completion,
      completionCapped: false,
      gate: { passed: verdict === 'gate-passed', reasons: [] as string[] },
      verdict,
      rationale: '',
      consistency: null,
      historySource: 'creation-derived' as const,
      vendorCompletion: completion,
      vendorVerdict: verdict,
      vendorPageCapped: false,
      creation: null,
      entry:
        roomMedian === undefined
          ? null
          : ({ roomLeft: { ...distribution([roomMedian]) } } as unknown as EntryScore),
      entryCoverage: null,
    };
  };

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

  it('orders the unmeasured between the survivors and the rejections, and stays total', () => {
    // The class map must cover EVERY verdict. An unhandled value makes the comparator return NaN,
    // which is not a strict weak ordering and silently breaks the byte-identical-output guarantee.
    // And an unmeasured candidate is not a rejection, so it must not be buried among them.
    const input = [
      candidate('rejected', 10, 10, 'gate-failed'),
      candidate('unjudged', 40, 20, 'gate-unmeasured'),
      candidate('passed', 40, 20, 'gate-passed'),
    ];
    expect(rankCandidates(input).map((c) => c.wallet)).toEqual(['passed', 'unjudged', 'rejected']);
    expect(rankCandidates([...input].reverse()).map((c) => c.wallet)).toEqual([
      'passed',
      'unjudged',
      'rejected',
    ]);
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

  it('leaves the candidate cap unset by default, so the budget decides it', () => {
    // The committed elite run seeded 22 wallets and graded 12 because it was invoked with a number
    // below the ceiling. A default invocation must not pin one at all.
    const r = parseArgs([]);
    if (!r.ok) throw new Error('unreachable');
    expect(r.opts.candidates).toBeNull();
    expect(r.opts.maxRequests).toBeNull();
  });

  it('refuses an over-budget plan before spending anything', async () => {
    const r = parseArgs(['--candidates', '150', '--max-requests', '10']);
    if (!r.ok) throw new Error('unreachable');
    const out: string[] = [];
    const err: string[] = [];
    // No credential in the environment either — but the refusal must come from the arithmetic,
    // before the key is ever consulted, and above all before a request is issued.
    const code = await main(r.opts, {}, (l) => out.push(l), (l) => err.push(l));
    expect(code).toBe(2);
    const text = err.join('\n');
    expect(text).toMatch(/Refusing to start/);
    expect(text).toMatch(/no quota was spent/);
    expect(text).not.toMatch(/CREDENTIAL PROBLEM/);
  }, 60_000);

  it('never refuses its own default plan', async () => {
    // The default candidate cap is derived from the request ceiling MINUS the enumeration cost, and
    // the refusal check three lines later re-adds it. If those two ever disagree — a fourth
    // enumeration query against a hardcoded 3, say — a no-flag invocation refuses itself. Reaching
    // the credential check (exit 3) rather than the arithmetic refusal (exit 2) is the proof.
    const r = parseArgs([]);
    if (!r.ok) throw new Error('unreachable');
    const err: string[] = [];
    const code = await main(r.opts, {}, () => {}, (l) => err.push(l));
    expect(code).toBe(3);
    expect(err.join('\n')).not.toMatch(/Refusing to start/);
  }, 60_000);

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
      historySource: 'creation-derived' as const,
      creationWalk: T['creation_walk'],
      costBounds: T['stage2_cost'],
      stage2: true,
      maxScored: T['stage2_entry'].maxCandidatesScored,
      entryThresholds: T['stage2_entry'],
      keyDescription: null,
      rpcEndpoint: resolveSolanaRpcEndpoint({}),
      indexedWalk: T['creation_walk_helius'],
      worstCaseCredits: 0,
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
    // And the WALL CLOCK, derived from the pinned pacing rather than written down once. An estimate
    // stale in the optimistic direction gets a run killed by an operator who thinks it has hung.
    expect(text).toMatch(/about 17 min typical/);
    expect(text).toMatch(/about 50 min worst case/);
    expect(text).toMatch(/7s between requests, swap-api ONLY/);
    // The cost leg's own exposure, on the same surface and in the same units. It is a SEPARATE
    // budget on a different host, so a reader who only saw the swap-api arithmetic would under-read
    // the run by the whole of it.
    expect(text).toMatch(/THE PRICE OF THE SEAT/);
    expect(text).toContain(
      String(T['stage2_entry'].maxCandidatesScored * T['stage2_cost'].maxRpcRequestsPerCandidate),
    );
    expect(text).toMatch(/ONLY ON A CANDIDATE THE FREE LEGS HAVE NOT ALREADY REFUSED/);
    // And the limit that must travel with every cost figure travels onto the PLAN too.
    expect(text).toMatch(/LANDING TIP PAID IN A SEPARATE TRANSACTION/);
    // With --no-stage2 the plan must say what is NOT being measured, not merely go quiet.
    const off = renderDryRun({
      seedPlan: [],
      maxCandidates: 12,
      maxKeyedRequests: 45,
      consistency: false,
      maxKeylessRequests: T['budget'].maxKeylessRequests,
      historySource: 'creation-derived' as const,
      creationWalk: T['creation_walk'],
      costBounds: T['stage2_cost'],
      stage2: false,
      maxScored: 0,
      entryThresholds: T['stage2_entry'],
      keyDescription: null,
      rpcEndpoint: resolveSolanaRpcEndpoint({}),
      indexedWalk: T['creation_walk_helius'],
      worstCaseCredits: 0,
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
      'completionRateSource',
      'minCompletionRate',
      'minSpanDays',
      'minTokens',
    ]);
  });

  it('every pinned parameter carries a stated reason, and every stated reason has a parameter', () => {
    // The file's own contract is "the anchor is named in `justification`", and the 2026-08-02
    // provenance audit found eight keys carrying a value and no entry at all — a gap no reader can
    // see without enumerating the file. Two of the three defect shapes it found need a human read
    // (a justification naming a quantity the call site does not compute, or quoting a figure nobody
    // re-derived); THIS one is mechanical, so it is asserted rather than reviewed for.
    //
    // An honest "no measurement backs this, and here is what would" satisfies it — see
    // `creation_walk.maxTransactionsPerCandidate` and `consistency_over_time.minEpochs`, which say
    // exactly that. What it refuses is silence.
    const T = loadThresholds() as Record<string, Record<string, unknown>>;
    for (const [block, body] of Object.entries(T)) {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) continue;
      const justification = (body['justification'] ?? {}) as Record<string, unknown>;
      const params = Object.keys(body).filter((k) => !k.startsWith('$') && k !== 'justification');
      for (const key of params) {
        expect(justification[key], `${block}.${key} has no justification entry`).toBeTruthy();
      }
      // And the other direction, so a deleted parameter cannot leave its reasoning behind to be
      // read as live: an orphan anchor is a claim about a bound that no longer exists.
      for (const key of Object.keys(justification)) {
        expect(params, `${block}.justification.${key} names no parameter`).toContain(key);
      }
    }
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

  it('bounds every run in the pinned budget — the FULL free-tier daily allowance, and no more', () => {
    const b = loadThresholds()['budget'];
    // Captain's instruction 2026-08-02: spend the whole allowance when spending it gets results.
    // The bound is the allowance itself (~200/day), not a fraction of it — but it is still a bound.
    expect(b.maxKeyedRequests).toBeLessThanOrEqual(200);
    expect(b.maxKeyedRequests).toBeGreaterThan(100);
    // The enumeration requests plus the candidate cap must fit under the ceiling, or a default run
    // would be arranged to die at the ceiling rather than to finish. The cost is taken from the
    // plan rather than written as 3, so a fourth enumeration query fails this instead of quietly
    // making a no-flag invocation refuse itself.
    const enumerationCost = buildSeedPlan({ limit: 50 }).length;
    expect(enumerationCost + b.maxCandidates).toBeLessThanOrEqual(b.maxKeyedRequests);
    // The burst limit is the vendor's, not our caution, so relaxing the daily bounds never moves it.
    expect(b.keyedMinIntervalMs).toBeGreaterThanOrEqual(6_000); // Free tier bursts at ~10/min
    expect(b.keylessMinIntervalMs).toBeGreaterThanOrEqual(2_000); // conservative carry-over, frontend-api-v3
  });

  it('paces the fill host on its own pin, and does not slow the host that never shed', () => {
    const T = loadThresholds();
    // Pinned per HOST. At the general 2s, swap-api shed half a live run's launches past all their
    // retries and the verdict degraded to `entry-unmeasured` where the truth was
    // `entry-room-absent` — a quiet failure, so the pacing is pinned above it deliberately.
    expect(T['stage2_entry'].keylessMinIntervalMs).toBe(7_000);
    // frontend-api-v3 has shed nothing here and must NOT be slowed for another host's fault.
    expect(T['budget'].keylessMinIntervalMs).toBe(2_000);
    expect(T['stage2_entry'].keylessMinIntervalMs).toBeGreaterThan(T['budget'].keylessMinIntervalMs);
    // Pacing moves the wall clock, never the exposure: the stage arithmetic is untouched.
    const s2 = T['stage2_entry'];
    expect(s2.maxCandidatesScored * s2.maxLaunchesPerCandidate * s2.maxRequestsPerLaunch).toBe(432);
    // Each justification must name the host it governs, or the next reader re-inherits the
    // misattribution this pin exists to correct.
    expect(s2.justification.keylessMinIntervalMs).toMatch(/swap-api/);
    expect(T['budget'].justification.keylessMinIntervalMs).toMatch(/frontend-api-v3/);
    expect(T['budget'].justification.keylessMinIntervalMs).toMatch(/api\.mainnet-beta\.solana\.com/);
  });

  it('records the captain instruction rather than the withdrawn quarter-allowance caution', () => {
    // A stale rationale is how a withdrawn caution gets re-derived by a future reader, so the
    // pinned prose is asserted, not just the numbers.
    const budget = loadThresholds()['budget'];
    const prose = [...budget.$comment, ...Object.values(budget.justification as Record<string, string>)]
      .join(' ')
      .toLowerCase();
    expect(prose).toContain('captain');
    expect(prose).toMatch(/withdrawn/);
    expect(prose).toMatch(/if it gets results/);
    // MadeOnSol only: the production-shared keys are not covered by this relaxation.
    expect(prose).toMatch(/production/);
    // And nothing may still be claiming the old reasoning.
    expect(prose).not.toMatch(/quarter of the shared/);
  });
});

describe('spend is reported concretely, by endpoint', () => {
  it('classifies every path onto the endpoint template it belongs to', () => {
    expect(endpointOf('/deployer-hunter/recent-bonds?limit=50&tier=elite')).toBe(
      '/deployer-hunter/recent-bonds',
    );
    expect(endpointOf('/deployer-hunter/alerts?limit=100')).toBe('/deployer-hunter/alerts');
    expect(endpointOf('/deployer-hunter/leaderboard?limit=50&sort=total_bonded')).toBe(
      '/deployer-hunter/leaderboard',
    );
    // A wallet must never become a key of its own: a spend table is not a list of who we screened.
    expect(endpointOf('/deployer-hunter/EgQX9R3QabcDEF')).toBe('/deployer-hunter/{wallet}');
    expect(endpointOf('/deployer-hunter/2CQgjcdNxyz')).toBe('/deployer-hunter/{wallet}');
  });

  it('collapses the wallet segment positionally, so a sub-resource cannot leak an address', () => {
    // The containment must not depend on nobody ever adding a call below the wallet. Neither of
    // these endpoints is used — /tokens is bonded-only and /history is PRO+ — which is exactly why
    // an exact-match rule would have gone unnoticed until the day one was.
    for (const suffix of ['/tokens', '/history', '/tokens?limit=50', '/anything/deeper']) {
      const classified = endpointOf(`/deployer-hunter/EgQX9R3QabcDEF${suffix}`);
      expect(classified).not.toMatch(/EgQX9R3QabcDEF/);
      expect(classified.startsWith('/deployer-hunter/{wallet}/')).toBe(true);
    }
    expect(endpointOf('/deployer-hunter/2CQgjcdNxyz/tokens')).toBe('/deployer-hunter/{wallet}/tokens');
    // The literal enumeration endpoints stay classified as themselves, not as wallets.
    expect(endpointOf('/deployer-hunter/recent-bonds')).toBe('/deployer-hunter/recent-bonds');
    // A trailing slash leaves no wallet segment to substitute, so nothing is invented.
    expect(endpointOf('/deployer-hunter/')).toBe('/deployer-hunter/');
  });

  it('names the endpoints the tool uses, and the two it deliberately does not', () => {
    expect(Object.keys(ENDPOINT_ROLES).sort()).toEqual([
      '/deployer-hunter/alerts',
      '/deployer-hunter/leaderboard',
      '/deployer-hunter/recent-bonds',
      '/deployer-hunter/{wallet}',
    ]);
    // Only the gate scales with the candidate count; everything else is one call per run.
    expect(ENDPOINT_ROLES['/deployer-hunter/{wallet}']?.costModel).toMatch(/per candidate/);
    for (const e of ['/deployer-hunter/alerts', '/deployer-hunter/leaderboard', '/deployer-hunter/recent-bonds']) {
      expect(ENDPOINT_ROLES[e]?.costModel).toBe('1 per run');
    }
    // tokens/ is bonded-only and history/ is PRO+; neither may appear as a thing we call.
    expect(Object.keys(ENDPOINT_ROLES).some((e) => e.endsWith('/tokens') || e.endsWith('/history'))).toBe(false);
  });

  it('attributes each issued request, retries included, to its endpoint', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 2
        ? ({ ok: false, status: 500, text: async () => 'boom' } as Response)
        : ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as Response);
    }) as unknown as typeof fetch;
    const client = new BoundedClient({
      key: 'msk_test_key_value_padded_to_length_ok_1234',
      maxRequests: 10,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl,
    });

    await client.getJson('/deployer-hunter/recent-bonds', { limit: 50 });
    await client.getJson('/deployer-hunter/WalletAaa'); // 500 then retried
    await client.getJson('/deployer-hunter/WalletBbb');

    const byEndpoint = client.stats().byEndpoint;
    expect(byEndpoint).toEqual([
      expect.objectContaining({ endpoint: '/deployer-hunter/recent-bonds', calls: 1 }),
      // Two wallets, one of which cost two requests: the retry is spend and it is reported as spend.
      expect.objectContaining({ endpoint: '/deployer-hunter/{wallet}', calls: 3 }),
    ]);
    expect(byEndpoint.reduce((n, e) => n + e.calls, 0)).toBe(client.stats().issued);
  });

  it('prints the spend table with the ceiling and what was left unspent', () => {
    const text = renderStage1({
      candidates: [],
      keyedRequests: 5,
      keylessRequests: 0,
      rpcRequests: 0,
      rpcLoadShedEvents: 0,
      historySource: 'creation-derived' as const,
      elapsedMs: 1000,
      startedAtIso: '2026-08-02T00:00:00.000Z',
      completed: true,
      truncationReason: null,
      prefiltered: 0,
      coverage: {
        seeds: [],
        inertSeeds: [],
        distinctWalletsSeeded: 2,
        prefilteredOut: 0,
        worthARequest: 2,
        candidateCap: 195,
        droppedByCandidateCap: 0,
        gated: 0,
        coverageTruncated: false,
      },
      spend: {
        keyedCeiling: 200,
        keyedRemaining: 195,
        plannedWorstCaseKeyed: 198,
        candidateCap: 195,
        endpoints: [
          { endpoint: '/deployer-hunter/alerts', role: 'enumeration', costModel: '1 per run', calls: 1 },
          { endpoint: '/deployer-hunter/{wallet}', role: 'the gate', costModel: '1 per candidate', calls: 4 },
        ],
      },
      thresholds: {},
    });
    expect(text).toMatch(/SPEND/);
    expect(text).toMatch(/\/deployer-hunter\/\{wallet\}/);
    expect(text).toMatch(/1 per candidate/);
    expect(text).toMatch(/ceiling of 200/);
    expect(text).toMatch(/195 unspent/);
  });
});

describe('an incomplete run can never read as a measured negative', () => {
  const render = (o: { completed: boolean; candidates?: unknown[]; coverageTruncated?: boolean }) =>
    renderStage1({
      candidates: (o.candidates ?? []) as never,
      keyedRequests: 4,
      keylessRequests: 0,
      rpcRequests: 0,
      rpcLoadShedEvents: 0,
      historySource: 'creation-derived' as const,
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

describe('the keyless walk retries, like the keyed one', () => {
  const keyless = (fetchImpl: unknown, maxRequests = 10) =>
    new KeylessClient({
      maxRequests,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl: fetchImpl as typeof fetch,
    });

  const ok = { ok: true, status: 200, json: async () => ({ page: 1 }) } as Response;
  const boom = (status: number) => ({ ok: false, status, json: async () => ({}) }) as Response;

  it('re-issues a 5xx once and counts BOTH attempts against the ceiling', () => {
    // A 5xx means the request was not served, so retrying it is nearer to one successful request
    // than to two — but the ceiling is what bounds our footprint, so every attempt counts.
    let calls = 0;
    const client = keyless(async () => {
      calls += 1;
      return calls === 1 ? boom(503) : ok;
    });
    return client.getJson('https://frontend-api-v3.pump.fun/coins?creator=A').then((body) => {
      expect(body).toEqual({ page: 1 });
      expect(calls).toBe(2);
      expect(client.issued()).toBe(2);
    });
  });

  it('re-issues a transport failure or timeout once', async () => {
    let calls = 0;
    const client = keyless(async () => {
      calls += 1;
      if (calls === 1) throw new Error('The operation was aborted due to timeout');
      return ok;
    });
    await expect(client.getJson('https://frontend-api-v3.pump.fun/coins?creator=A')).resolves.toEqual({
      page: 1,
    });
    expect(calls).toBe(2);
  });

  it('gives up after its pinned backoffs rather than hammering a shared public endpoint', async () => {
    // One attempt per entry in DEFAULT_RETRY_BACKOFF_MS, plus the first — three, and no more. The
    // count is the client's pinned backoff list rather than a number written down twice.
    let calls = 0;
    const client = keyless(async () => {
      calls += 1;
      return boom(503);
    });
    await expect(client.getJson('https://frontend-api-v3.pump.fun/coins?creator=A')).rejects.toThrow(/503/);
    expect(calls).toBe(3);
  });

  it('does not retry a 4xx — that is the endpoint\'s considered answer', async () => {
    let calls = 0;
    const client = keyless(async () => {
      calls += 1;
      return boom(404);
    });
    await expect(client.getJson('https://frontend-api-v3.pump.fun/coins?creator=A')).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it('reports what it actually did, so the record does not have to guess', async () => {
    // The record classifies a missing measurement from this exception. A message alone cannot say
    // whether a retry happened, and a record that claims one that did not is the defect the
    // honesty rule exists to prevent — so the client attaches the evidence.
    let calls = 0;
    const retried = keyless(async () => {
      calls += 1;
      return boom(503);
    });
    await retried.getJson('https://frontend-api-v3.pump.fun/coins?creator=A').catch((e: unknown) => {
      expect(e).toBeInstanceOf(RequestFailed);
      expect((e as InstanceType<typeof RequestFailed>).retried).toBe(true);
      expect((e as InstanceType<typeof RequestFailed>).status).toBe(503);
      expect(classifyUnmeasured(e)).toBe('page-failure');
    });
    // One attempt per entry in the client's pinned backoff list, plus the first.
    expect(calls).toBe(3);

    const refused = keyless(async () => boom(404));
    await refused.getJson('https://frontend-api-v3.pump.fun/coins?creator=A').catch((e: unknown) => {
      expect((e as InstanceType<typeof RequestFailed>).retried).toBe(false);
      expect((e as InstanceType<typeof RequestFailed>).status).toBe(404);
      expect(classifyUnmeasured(e)).toBe('vendor-refusal');
    });

    const transport = keyless(async () => {
      throw new Error('The operation was aborted due to timeout');
    });
    await transport.getJson('https://frontend-api-v3.pump.fun/coins?creator=A').catch((e: unknown) => {
      expect((e as InstanceType<typeof RequestFailed>).retried).toBe(true);
      // No response ever arrived, so there is no status to report and none is invented.
      expect((e as InstanceType<typeof RequestFailed>).status).toBeNull();
      expect(classifyUnmeasured(e)).toBe('page-failure');
    });
  });

  it('reports a non-JSON body as served-but-unreadable, blaming neither side', async () => {
    // The request WAS served, so neither "the endpoint failed" nor "our code failed" is
    // established. The likeliest cause is an edge interstitial behind a 200 — the vendor's — so
    // calling it ours would send an operator hunting a bug that does not exist.
    const client = keyless(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    }));
    const err = await client.getJson('https://frontend-api-v3.pump.fun/coins?creator=A').catch((e) => e);
    expect(err).toBeInstanceOf(UnparseableResponse);
    expect(err).not.toBeInstanceOf(RequestFailed);
    expect((err as InstanceType<typeof UnparseableResponse>).status).toBe(200);
    expect(classifyUnmeasured(err)).toBe('unparseable-body');
  });

  it('classifies a not-retried failure as known-but-not-retried, never as unidentifiable', async () => {
    // Only reachable with retries disabled, but the option is public. The cause is known there —
    // reporting it as unclassifiable is inaccurate in the other direction.
    const client = new KeylessClient({
      maxRequests: 10,
      minIntervalMs: 0,
      retryBackoffMs: [],
      sleepImpl: async () => {},
      fetchImpl: (async () => boom(503)) as unknown as typeof fetch,
    });
    const err = await client.getJson('https://frontend-api-v3.pump.fun/coins?creator=A').catch((e) => e);
    expect((err as InstanceType<typeof RequestFailed>).retried).toBe(false);
    expect((err as InstanceType<typeof RequestFailed>).status).toBe(503);
    expect(classifyUnmeasured(err)).toBe('not-retried-failure');
    expect(client.issued()).toBe(1);
  });

  it('cannot let a retry smuggle a request past the ceiling', async () => {
    let calls = 0;
    const client = keyless(async () => {
      calls += 1;
      return boom(503);
    }, 1);
    // One request of allowance, a 5xx that would earn a retry: the retry has to hit the wall.
    await expect(client.getJson('https://frontend-api-v3.pump.fun/coins?creator=A')).rejects.toBeInstanceOf(
      CeilingReached,
    );
    expect(calls).toBe(1);
    expect(client.issued()).toBe(1);
  });
});

describe('a ceiling hit is never recordable as a measured result', () => {
  const COVERAGE_OK = { coverageTruncated: false, candidateCap: 195, droppedByCandidateCap: 0 };
  const KEYLESS = {
    budget: 'keyless pump.fun',
    ceiling: 600,
    setting: 'thresholds.json budget.maxKeylessRequests',
  };

  it('sizes the keyless ceiling to cover the candidate cap, so the walk cannot run out mid-run', () => {
    const b = loadThresholds()['budget'];
    // 3 pages per gate survivor is what readCreatorHistory is asked for. If this stops holding, a
    // default --consistency run stops looking part-way through a run already paid for in keyed
    // quota, and the wallets after that point are unmeasured rather than measured-and-clean.
    expect(b.maxKeylessRequests).toBeGreaterThanOrEqual(3 * b.maxCandidates);
    // Covering the cap is a count, not a rate: the measured pump.fun pacing is untouched by it.
    expect(b.keylessMinIntervalMs).toBe(2_000);
  });

  const RETRIED = (message: string, status: number | null) =>
    new RequestFailed(message, { status, retried: true });
  const NOT_RETRIED = (message: string, status: number | null) =>
    new RequestFailed(message, { status, retried: false });

  it('names the budget and the setting when a ceiling stopped the measurement', () => {
    const u = unmeasuredBecause('consistency-over-time', 'WalletAaa', new CeilingReached(600, '/x'), KEYLESS);
    expect(u.kind).toBe('budget-exhausted');
    expect(u.measurement).toBe('consistency-over-time');
    expect(u.subject).toBe('WalletAaa');
    // A rerun reaches the same wall, so the note has to point at the number rather than the retry.
    expect(u.summary).toMatch(/ceiling of 600/);
    expect(u.summary).toMatch(/maxKeylessRequests/);
    expect(u.summary).toMatch(/never looked up/);
  });

  it('only says "retried" when the client actually retried', () => {
    // The whole point of classifying from the client's own evidence: a record that claims a retry
    // that never happened is the same class of defect as one that claims a measurement it never
    // took. Asserting an inaccurate cause is worse than asserting none.
    const u = unmeasuredBecause(
      'consistency-over-time',
      'WalletBbb',
      RETRIED('Transport failure on https://…/coins?creator=WalletBbb: timeout', null),
      KEYLESS,
    );
    expect(u.kind).toBe('page-failure');
    expect(u.summary).toMatch(/the one retry failed too/);
    expect(u.summary).toMatch(/transport failure or timeout/);
    expect(u.summary).toMatch(/rerun may well succeed/);
    // Must not borrow the wall's advice to go and change a threshold.
    expect(u.summary).not.toMatch(/maxKeylessRequests/);
    // The per-wallet URL is detail, never the stable summary.
    expect(u.detail).toMatch(/WalletBbb/);
    expect(u.summary).not.toMatch(/WalletBbb/);
  });

  it('does NOT claim a retry for a 4xx, which is the endpoint\'s considered answer', () => {
    // The retry policy deliberately excludes 4xx, so the sentence that says "we retried and it
    // still failed" is simply false here — and it would send an operator to rerun a 40-minute job
    // that will fail exactly the same way.
    const u = unmeasuredBecause(
      'consistency-over-time',
      'W',
      NOT_RETRIED('HTTP 404 on https://…/coins?creator=W', 404),
      KEYLESS,
    );
    expect(u.kind).toBe('vendor-refusal');
    expect(u.summary).toMatch(/HTTP 404/);
    expect(u.summary).toMatch(/did not retry it/);
    expect(u.summary).toMatch(/endpoint moved/);
    expect(u.summary).not.toMatch(/retried and|retry failed|rerun may well succeed/);
  });

  it('does NOT claim a request was even made for an error in our own code', () => {
    // A bug inside measureConsistency never reaches the endpoint. Blaming the vendor for our own
    // defect is how a real bug goes unfixed for a month.
    const u = unmeasuredBecause('consistency-over-time', 'W', new TypeError('x is not a function'), KEYLESS);
    expect(u.kind).toBe('local-error');
    expect(u.summary).toMatch(/inside our own code/);
    expect(u.summary).toMatch(/our bug/);
    // It may deny a retry; it may not claim one, nor promise a rerun would help.
    expect(u.summary).toMatch(/no request was retried/);
    expect(u.summary).not.toMatch(/the one retry failed|rerun may well succeed/);
  });

  it('does NOT blame us for a body the endpoint served but we could not parse', () => {
    // The request WAS served, so "our bug" is a guess, and the likeliest real cause — an edge
    // interstitial behind a 200 — is the vendor's. Asserting an inaccurate cause is worse than
    // asserting none, so this one names what happened and attributes it to nobody.
    const u = unmeasuredBecause(
      'consistency-over-time',
      'W',
      new UnparseableResponse('Response to https://…/coins?creator=W was not JSON: Unexpected token <', {
        status: 200,
      }),
      KEYLESS,
    );
    expect(u.kind).toBe('unparseable-body');
    expect(u.summary).toMatch(/HTTP 200/);
    expect(u.summary).toMatch(/was not JSON/);
    expect(u.summary).toMatch(/edge interstitial or error page/);
    // Neither side is blamed, and no retry is claimed.
    expect(u.summary).not.toMatch(/our bug|inside our own code/);
    expect(u.summary).not.toMatch(/the one retry failed|rerun may well succeed/);
    expect(deriveTruncation({ abortReason: null, coverage: COVERAGE_OK, unmeasured: [u] }).truncated).toBe(
      false,
    );
  });

  it('calls a not-retried failure known-but-not-retried, not unidentifiable', () => {
    const u = unmeasuredBecause('consistency-over-time', 'W', NOT_RETRIED('HTTP 503 on …', 503), KEYLESS);
    expect(u.kind).toBe('not-retried-failure');
    expect(u.summary).toMatch(/HTTP 503/);
    expect(u.summary).toMatch(/configured not to retry/);
    expect(u.summary).toMatch(/cause is known/);
    expect(u.summary).not.toMatch(/could not be classified/);
  });

  it('says the cause could not be classified rather than inventing one', () => {
    const u = unmeasuredBecause('consistency-over-time', 'W', 'something thrown that is not an Error', KEYLESS);
    expect(u.kind).toBe('unclassified');
    expect(u.summary).toMatch(/could not be classified/);
    expect(u.summary).not.toMatch(/retried|ceiling|our bug/);
  });

  it('lets none of the non-wall kinds declare the whole run truncated', () => {
    // The flag has to stay worth reading. A keyless walk issues up to 585 requests against the
    // flakiest surface in the tool; if one hiccuped page truncated the run, `truncated: true` would
    // be on for nearly every run and would carry no information at all.
    const unmeasured = [
      unmeasuredBecause('consistency-over-time', 'A', RETRIED('HTTP 503 on …', 503), KEYLESS),
      unmeasuredBecause('consistency-over-time', 'B', NOT_RETRIED('HTTP 404 on …', 404), KEYLESS),
      unmeasuredBecause('consistency-over-time', 'C', new TypeError('ours'), KEYLESS),
      unmeasuredBecause('consistency-over-time', 'D', 'opaque', KEYLESS),
      unmeasuredBecause('consistency-over-time', 'E', NOT_RETRIED('HTTP 503 on …', 503), KEYLESS),
      unmeasuredBecause('consistency-over-time', 'F', new UnparseableResponse('html', { status: 200 }), KEYLESS),
    ];
    const t = deriveTruncation({ abortReason: null, coverage: COVERAGE_OK, unmeasured });
    expect(t.truncated).toBe(false);
    expect(t.truncationReason).toBeNull();
    // But every one of them is still recorded, and still unmeasured rather than a measured negative.
    expect([...partitionUnmeasured(unmeasured).keys()]).toEqual([
      'page-failure',
      'not-retried-failure',
      'vendor-refusal',
      'unparseable-body',
      'local-error',
      'unclassified',
    ]);
  });

  it('records an unrecognised kind rather than throwing on it or dropping it', () => {
    // record.mjs is the module that has to survive version skew: completenessOf and schemaVersionOf
    // already degrade rather than throw. A record written by a newer build must not take the whole
    // record build down with a TypeError, and must not vanish from the render either — a reader who
    // cannot see the entry reads the run as more complete than it was.
    const fromTheFuture = {
      measurement: 'consistency-over-time',
      subject: 'W',
      kind: 'some-kind-invented-later',
      summary: 'a build that knew more than this one recorded something here',
      detail: null,
    };
    expect(kindMetaOf('some-kind-invented-later')).toBe(UNRECOGNISED_KIND);
    // It does not truncate: inventing a wall from a label we cannot read asserts a cause we lack.
    const t = deriveTruncation({
      abortReason: null,
      coverage: COVERAGE_OK,
      unmeasured: [fromTheFuture as never],
    });
    expect(t.truncated).toBe(false);
    expect([...partitionUnmeasured([fromTheFuture as never]).keys()]).toEqual(['some-kind-invented-later']);
  });

  it('keeps a ceiling truncating even when other kinds are mixed in with it', () => {
    const unmeasured = [
      unmeasuredBecause('consistency-over-time', 'A', RETRIED('HTTP 503 on …', 503), KEYLESS),
      unmeasuredBecause('consistency-over-time', 'B', new CeilingReached(600, '/x'), KEYLESS),
    ];
    const t = deriveTruncation({ abortReason: null, coverage: COVERAGE_OK, unmeasured });
    expect(t.truncated).toBe(true);
    // Only the wall is named as truncation; the hiccup is not folded into the same sentence.
    expect(t.truncationReason).toMatch(/1 candidate\(s\) went unmeasured/);
    expect(t.truncationReason).toMatch(/ceiling of 600/);
    expect(t.truncationReason).not.toMatch(/503/);
  });

  it('groups page failures despite each carrying a different per-wallet URL', () => {
    // The defect this guards: the client's message embeds the request URL, so keying the grouping
    // on it gives every wallet a group of one — a grouping that groups nothing is a longer list.
    const many = Array.from({ length: 60 }, (_, i) =>
      unmeasuredBecause(
        'consistency-over-time',
        `W${i}`,
        RETRIED(`HTTP 503 on https://frontend-api-v3.pump.fun/coins?creator=W${i}&offset=0`, 503),
        KEYLESS,
      ),
    );
    const grouped = groupUnmeasured(many);
    expect(grouped.size).toBe(1);
    expect([...grouped.values()]).toEqual([60]);
    // The per-wallet detail is not lost, it just is not the key.
    expect(many[0]?.detail).toMatch(/creator=W0/);
  });

  it('agrees with UNMEASURED_KINDS about which kind truncates', () => {
    // One authority, so a future kind cannot be added that quietly truncates (or quietly does not).
    for (const [kind, meta] of Object.entries(UNMEASURED_KINDS)) {
      const entry = { measurement: 'm', subject: 'W', kind, summary: `s:${kind}`, detail: null };
      const t = deriveTruncation({
        abortReason: null,
        coverage: COVERAGE_OK,
        unmeasured: [entry as never],
      });
      expect(t.truncated, kind).toBe(meta.truncates);
    }
    expect(Object.values(UNMEASURED_KINDS).filter((m) => m.truncates)).toHaveLength(1);
    expect(UNMEASURED_KINDS['budget-exhausted'].truncates).toBe(true);
  });

  it('records a measurement nothing could answer, without claiming a failure or a wall', () => {
    // Not every unmeasured thing is a failed request. When every request was served and no surface
    // carries the fact, the honest kind is its own — rounding it into `local-error` would blame our
    // code for a limit of the evidence, and into `unclassified` would disclaim a cause we know.
    const u = unmeasuredNoSource(
      'the bonded status of a creation-derived launch history',
      'WalletAaa',
      'neither the on-chain curve nor the ownership listing could answer',
      '3 of 40 launch(es) undecidable',
    );
    expect(u.kind).toBe('no-source');
    expect(u.summary).toMatch(/NOT a negative result/);
    expect(u.summary).not.toMatch(/WalletAaa/);
    expect(describeUnmeasured(u)).toMatch(/3 of 40/);

    // It is unmeasured, so it must be reported — but it is not a budget wall, so it must not
    // manufacture truncation on a run that never stopped looking.
    const t = deriveTruncation({ abortReason: null, coverage: COVERAGE_OK, unmeasured: [u] });
    expect(t.truncated).toBe(false);
    expect(kindMetaOf(u.kind).truncates).toBe(false);
  });

  it('makes an unmeasured candidate truncate the run, with a reason naming what went unmeasured', () => {
    const unmeasured = ['A', 'B', 'C'].map((w) =>
      unmeasuredBecause('consistency-over-time', w, new CeilingReached(600, '/x'), KEYLESS),
    );
    // The exact prohibited record: the run reached the end, the cap dropped nobody, and three
    // candidates were never looked at — which used to read as truncated: false, reason: null.
    const t = deriveTruncation({ abortReason: null, coverage: COVERAGE_OK, unmeasured });
    expect(t.truncated).toBe(true);
    expect(t.truncationReason).toMatch(/3 candidate\(s\) went unmeasured/);
    expect(t.truncationReason).toMatch(/consistency-over-time/);
  });

  it('leaves a genuinely complete run untruncated and unexplained', () => {
    expect(deriveTruncation({ abortReason: null, coverage: COVERAGE_OK, unmeasured: [] })).toEqual({
      truncated: false,
      truncationReason: null,
    });
  });

  it('keeps every source of missingness in one reason without losing any of them', () => {
    const t = deriveTruncation({
      abortReason: 'HTTP 429 — rate-limited',
      coverage: { coverageTruncated: true, candidateCap: 12, droppedByCandidateCap: 8 },
      unmeasured: [
        unmeasuredBecause('consistency-over-time', 'A', new CeilingReached(600, '/x'), KEYLESS),
        // A page failure alongside them: recorded, but it adds no truncation reason of its own.
        unmeasuredBecause('consistency-over-time', 'B', RETRIED('boom', 503), KEYLESS),
      ],
    });
    expect(t.truncated).toBe(true);
    expect(t.truncationReason).toMatch(/429/);
    expect(t.truncationReason).toMatch(/candidate cap of 12 dropped 8/);
    expect(t.truncationReason).toMatch(/1 candidate\(s\) went unmeasured/);
    expect(t.truncationReason).not.toMatch(/boom/);
  });

  it('groups identical reasons rather than repeating one line per wallet', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      unmeasuredBecause('consistency-over-time', `W${i}`, new CeilingReached(600, '/x'), KEYLESS),
    );
    const grouped = groupUnmeasured(many);
    expect(grouped.size).toBe(1);
    expect([...grouped.values()]).toEqual([60]);
  });

  it('does NOT collapse the unmeasured state into `completed` — the three states stay apart', () => {
    // A run can reach the end and still have failed to measure something. `completed` answers only
    // "did it reach the end", and deriveTruncation is not allowed to be an input to that.
    const record = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      completed: true,
      ...deriveTruncation({
        abortReason: null,
        coverage: COVERAGE_OK,
        unmeasured: [unmeasuredBecause('consistency-over-time', 'A', new CeilingReached(600, '/x'), KEYLESS)],
      }),
    };
    expect(completenessOf(record)).toBe('complete');
    expect(record.truncated).toBe(true);
    // The pairing that matters: it may never be completed-and-untruncated.
    expect(record.completed && !record.truncated).toBe(false);
  });

  it('prints the unmeasured block in Stage 1, not just a per-candidate note', () => {
    const text = renderStage1({
      candidates: [],
      keyedRequests: 8,
      keylessRequests: 600,
      rpcRequests: 0,
      rpcLoadShedEvents: 0,
      historySource: 'creation-derived' as const,
      elapsedMs: 1000,
      startedAtIso: '2026-08-02T00:00:00.000Z',
      completed: true,
      truncationReason: '2 candidate(s) went unmeasured — the keyless pump.fun request ceiling…',
      prefiltered: 0,
      coverage: {
        seeds: [],
        inertSeeds: [],
        distinctWalletsSeeded: 2,
        prefilteredOut: 0,
        worthARequest: 2,
        candidateCap: 195,
        droppedByCandidateCap: 0,
        gated: 2,
        coverageTruncated: false,
      },
      unmeasured: [
        ...['A', 'B'].map((w) =>
          unmeasuredBecause('consistency-over-time', w, new CeilingReached(600, '/x'), KEYLESS),
        ),
        unmeasuredBecause('consistency-over-time', 'C', RETRIED('HTTP 503 on …', 503), KEYLESS),
      ],
      thresholds: {},
    });
    expect(text).toMatch(/MEASUREMENT\(S\) NOT TAKEN/);
    expect(text).toMatch(/NEVER a measured result/);
    // The two causes are labelled apart, so an operator can tell "we ran out of allowance and
    // stopped looking" from "one page hiccuped".
    expect(text).toMatch(/BUDGET EXHAUSTED/);
    expect(text).toMatch(/PAGE FAILURE/);
    expect(text).toMatch(/2 candidate\(s\)/);
    expect(text).toMatch(/1 candidate\(s\)/);
    expect(text).toMatch(/maxKeylessRequests/);
    expect(text).toMatch(/A rerun may well succeed/);
  });

  it('gives a 4xx and a local error their own headings, not the retry one', () => {
    const text = renderStage1({
      candidates: [],
      keyedRequests: 8,
      keylessRequests: 12,
      rpcRequests: 0,
      rpcLoadShedEvents: 0,
      historySource: 'creation-derived' as const,
      elapsedMs: 1000,
      startedAtIso: '2026-08-02T00:00:00.000Z',
      completed: true,
      truncationReason: null,
      prefiltered: 0,
      coverage: {
        seeds: [],
        inertSeeds: [],
        distinctWalletsSeeded: 2,
        prefilteredOut: 0,
        worthARequest: 2,
        candidateCap: 195,
        droppedByCandidateCap: 0,
        gated: 2,
        coverageTruncated: false,
      },
      unmeasured: [
        unmeasuredBecause('consistency-over-time', 'A', NOT_RETRIED('HTTP 404 on …', 404), KEYLESS),
        unmeasuredBecause('consistency-over-time', 'B', new TypeError('ours'), KEYLESS),
        unmeasuredBecause('consistency-over-time', 'C', new UnparseableResponse('html', { status: 200 }), KEYLESS),
        // A kind from a build that knew more than this one: shown, not dropped, not fatal.
        { measurement: 'consistency-over-time', subject: 'D', kind: 'invented-later', summary: 'x', detail: null },
      ] as never,
      thresholds: {},
    });
    expect(text).toMatch(/VENDOR REFUSAL/);
    expect(text).toMatch(/LOCAL ERROR/);
    expect(text).toMatch(/UNPARSEABLE BODY/);
    expect(text).toMatch(/UNRECOGNISED KIND/);
    // None may be dressed up as a retried page, and none is a wall.
    expect(text).not.toMatch(/PAGE FAILURE/);
    expect(text).not.toMatch(/BUDGET EXHAUSTED/);
  });

  it('shows only the page-failure half when no ceiling was hit', () => {
    const text = renderStage1({
      candidates: [],
      keyedRequests: 8,
      keylessRequests: 12,
      rpcRequests: 0,
      rpcLoadShedEvents: 0,
      historySource: 'creation-derived' as const,
      elapsedMs: 1000,
      startedAtIso: '2026-08-02T00:00:00.000Z',
      completed: true,
      truncationReason: null,
      prefiltered: 0,
      coverage: {
        seeds: [],
        inertSeeds: [],
        distinctWalletsSeeded: 2,
        prefilteredOut: 0,
        worthARequest: 2,
        candidateCap: 195,
        droppedByCandidateCap: 0,
        gated: 2,
        coverageTruncated: false,
      },
      unmeasured: [unmeasuredBecause('consistency-over-time', 'A', RETRIED('HTTP 503 on …', 503), KEYLESS)],
      thresholds: {},
    });
    expect(text).toMatch(/MEASUREMENT\(S\) NOT TAKEN/);
    expect(text).toMatch(/PAGE FAILURE/);
    // No wall was hit, so nothing may claim one — the run did not stop looking.
    expect(text).not.toMatch(/BUDGET EXHAUSTED/);
    expect(text).not.toMatch(/COVERAGE TRUNCATED/);
  });

  it('says nothing about unmeasured work when there was none', () => {
    const text = renderStage1({
      candidates: [],
      keyedRequests: 4,
      keylessRequests: 0,
      rpcRequests: 0,
      rpcLoadShedEvents: 0,
      historySource: 'creation-derived' as const,
      elapsedMs: 1000,
      startedAtIso: '2026-08-02T00:00:00.000Z',
      completed: true,
      truncationReason: null,
      prefiltered: 0,
      coverage: {
        seeds: [],
        inertSeeds: [],
        distinctWalletsSeeded: 2,
        prefilteredOut: 0,
        worthARequest: 2,
        candidateCap: 195,
        droppedByCandidateCap: 0,
        gated: 2,
        coverageTruncated: false,
      },
      thresholds: {},
    });
    expect(text).not.toMatch(/NOT TAKEN/);
  });

  it('gives an unmeasured reading its own section, never the rejection list and never nowhere', () => {
    // A third verdict that appears in neither printed list disappears from the report entirely —
    // the exact silent drop this repo keeps getting bitten by — and one printed among the
    // rejections reads as judged and found wanting, which is the false rejection restored.
    const unjudged = {
      wallet: 'WalletUnjudged1111111111111111111111111111',
      seededBy: ['alerts'],
      completion: measureCompletion([{ deployedAtMs: T0, completed: false }]),
      completionCapped: false,
      gate: { passed: false, reasons: ['completion rate 0.0000 < 0.25 required'] },
      verdict: 'gate-unmeasured',
      rationale: 'GATE UNMEASURED — this is NOT a rejection and NOT a pass. 3 launches undecidable.',
      consistency: null,
      entry: null,
      entryCoverage: null,
      historySource: 'creation-derived',
      vendorCompletion: measureCompletion([{ deployedAtMs: T0, completed: false }]),
      vendorVerdict: 'gate-failed',
      vendorPageCapped: false,
      creation: {
        bondedFromCurve: 5,
        bondedFromListing: 2,
        bondedUndecidable: 3,
        curvesUnread: 5,
        listingUnmeasuredNote: null,
        wholeHistory: false,
        stopReason: 'request-ceiling',
        coveredDays: 0,
        coveredFromIso: null,
        coveredToIso: null,
        listedOutsideWindow: 0,
        windowExact: true,
        listedInWindowCarried: 0,
        unresolvedTransactions: 0,
      },
    };

    const text = renderStage1({
      candidates: [unjudged] as never,
      keyedRequests: 4,
      keylessRequests: 0,
      rpcRequests: 10,
      rpcLoadShedEvents: 0,
      historySource: 'creation-derived' as const,
      elapsedMs: 1000,
      startedAtIso: '2026-08-02T00:00:00.000Z',
      completed: true,
      truncationReason: null,
      prefiltered: 0,
      coverage: {
        seeds: [],
        inertSeeds: [],
        distinctWalletsSeeded: 1,
        prefilteredOut: 0,
        worthARequest: 1,
        candidateCap: 195,
        droppedByCandidateCap: 0,
        gated: 1,
        coverageTruncated: false,
      },
      thresholds: {},
    });

    expect(text).toMatch(/GATE UNMEASURED — THIS IS NOT A NEGATIVE RESULT/);
    expect(text).toMatch(/gate unmeasured\s+1/);
    expect(text).toContain(unjudged.wallet);
    expect(text).toMatch(/3 UNDECIDABLE/);
    // It must NOT be listed under the rejections, and the "nothing cleared the gate" language must
    // not silently cover a wallet nobody judged.
    const rejections = text.slice(text.indexOf('DID NOT CLEAR THE GATE'));
    expect(text).toMatch(/EXCEPT for 1 candidate\(s\) whose reading was NOT MEASURED/);
    if (text.includes('DID NOT CLEAR THE GATE')) expect(rejections).not.toContain(unjudged.wallet);
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
  const PERSISTED_BY_SCHEMA: Record<number, string[]> = {
    1: [
      'completed',
      'completionRate',
      'consistency',
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
    ],
  };
  PERSISTED_BY_SCHEMA[2] = PERSISTED_BY_SCHEMA[1]!;
  // Schema 3 adds Stage 2's own projection, `entry` — quantiles, counts and a hit rate, no mint and
  // no counterparty address — plus the run-level `spend` block, which is not a candidate field.
  PERSISTED_BY_SCHEMA[3] = [...PERSISTED_BY_SCHEMA[1]!, 'entry'].sort();
  // Schema 4 adds the creation-derived reading and keeps the ownership one beside it. `creation`
  // is an object of counts and bounds; it carries no per-token row, which FORBIDDEN below asserts.
  PERSISTED_BY_SCHEMA[4] = [
    ...PERSISTED_BY_SCHEMA[3]!,
    'creation',
    'gateReadingPageCapped',
    'historySource',
    'vendorCompleted',
    'vendorCompletionRate',
    'vendorSpanDays',
    'vendorTokens',
    'vendorVerdict',
    'verdictChanged',
  ].sort();
  // Schema 5 adds NO candidate field. The change is inside `entry`, which gains
  // `launchesRoomUnproven`, `bundledTx` and `maxWalletsInOneTx` — asserted separately below,
  // because that is where a reader of an older record can go wrong.
  PERSISTED_BY_SCHEMA[5] = PERSISTED_BY_SCHEMA[4]!;
  // Schema 6 adds no candidate field either. The fee moved inside the entry window, so everything
  // it changed is inside `entry` and `entry.coverage`.
  PERSISTED_BY_SCHEMA[6] = PERSISTED_BY_SCHEMA[5]!;
  // Schema 7 adds no candidate field either. It moves `stage0.onChainCostReproduction` to the GATED
  // population under unchanged key names and carries the unfiltered reading beside it, so nothing
  // about a candidate row, `entry` or `entry.coverage` moves.
  PERSISTED_BY_SCHEMA[7] = PERSISTED_BY_SCHEMA[6]!;
  // Schema 8 adds no candidate field either. It changes the run-level `spend` block, which reports
  // three budgets in three units — asserted by SPEND_KEYS_BY_SCHEMA below.
  PERSISTED_BY_SCHEMA[8] = PERSISTED_BY_SCHEMA[7]!;

  // The `entry` block's own contract, per schema version. A schema-3 or schema-4 `entry.roomLeft`
  // may be inflated by the operation's own stake booked as outsider capital and the record carries
  // nothing that could say by how much — which is exactly why schema 5 exists. Committed records
  // are never retro-edited, so the older shape has to stay legal rather than be corrected.
  const ENTRY_KEYS_3_AND_4 = [
    'caveats',
    'coordinatedSol',
    'coverage',
    'deployerMismatches',
    'devSol',
    'fieldClosedRoundTrips',
    'fieldEntrants',
    'fieldFillSol',
    'fieldHitRateGrossOfFees',
    'fieldOpenPositions',
    'fieldRealisedSolGrossOfFees',
    'fieldReturnPerSolGrossOfFees',
    'fieldSolQueuedAhead',
    'launchesSampled',
    'launchesWithNoOutsider',
    'operationShare',
    'outsidersPerLaunch',
    'rationale',
    'roomHitRate',
    'roomLeft',
    'verdict',
  ];
  const ENTRY_KEYS_5 = [...ENTRY_KEYS_3_AND_4, 'launchesRoomUnproven', 'bundledTx', 'maxWalletsInOneTx'];
  // Schema 6: the price of the seat, and what the field cleared after paying it. The `…NetOfMeasuredFees`
  // fields sit BESIDE the `…GrossOfFees` ones and replace none of them, which is why both are in
  // this list — a reader comparing a schema-5 gross figure with a schema-6 one is comparing like
  // with like, and it is only the VERDICT that has no schema-5 equivalent.
  const ENTRY_KEYS_6 = [
    ...ENTRY_KEYS_5,
    'entryCostSol',
    // Two units of the same quantity, and both are persisted on purpose: the per-entry one is the
    // finer-grained evidence, the per-launch one is what `entry-cost-prohibitive` is compared
    // against (decision 140a). A record carrying only the pooled figure could not be audited for
    // the gate that was actually applied.
    'entryCostPerSolStaked',
    'entryCostPerSolStakedByLaunch',
    'entryTxFeeSol',
    'entryCostPriced',
    'fieldRealisedSolNetOfMeasuredFees',
    'fieldReturnPerSolNetOfMeasuredFees',
    'fieldHitRateNetOfMeasuredFees',
    'fieldClosedRoundTripsPriced',
  ];
  const ENTRY_KEYS_BY_SCHEMA: Record<number, string[]> = {
    3: ENTRY_KEYS_3_AND_4,
    4: ENTRY_KEYS_3_AND_4,
    5: ENTRY_KEYS_5,
    6: ENTRY_KEYS_6,
    // Schema 7 changes what a `stage0` block MEANS, not what `entry` carries.
    7: ENTRY_KEYS_6,
    // Schema 8 changes the run-level `spend` block, not what `entry` carries.
    8: ENTRY_KEYS_6,
  };

  // `entry.coverage`'s own key set, per version, for the same reason one level further down: the
  // eligibility counts are the whole point of schema 6's second half, and a nested block was never
  // asserted before — so a field could be added or dropped there without any test noticing.
  const ENTRY_COVERAGE_KEYS_3_TO_5 = [
    'dropNotes',
    'dropsByReason',
    'launchRefsAvailable',
    'launchesAttempted',
    'launchesDropped',
    'launchesUsable',
    'requestsIssued',
    'stoppedForBudget',
  ];
  const ENTRY_COVERAGE_KEYS_6 = [
    ...ENTRY_COVERAGE_KEYS_3_TO_5,
    'cost',
    'launchesDroppedByCap',
    'launchesEligible',
    'launchesPlanned',
    'launchesTooYoung',
    'minAgeMs',
    'youngestEligibleAgeMs',
    'youngestRefAgeMs',
  ];
  const ENTRY_COVERAGE_KEYS_BY_SCHEMA: Record<number, string[]> = {
    3: ENTRY_COVERAGE_KEYS_3_TO_5,
    4: ENTRY_COVERAGE_KEYS_3_TO_5,
    5: ENTRY_COVERAGE_KEYS_3_TO_5,
    6: ENTRY_COVERAGE_KEYS_6,
    7: ENTRY_COVERAGE_KEYS_6,
    8: ENTRY_COVERAGE_KEYS_6,
  };

  // The run-level `spend` block's own key set, per version. This is the hole schema 8 fell through:
  // the three key sets above see a candidate row, its `entry` and that block's `coverage`, and NONE
  // of them can see a run-level block — so five new `spend` keys shipped under an unchanged version
  // with every existing assertion still green. Two records both stamped 7 would then have had
  // different shapes, which is exactly what "bump, never retro-edit" forbids.
  //
  // Committed records are never retro-edited, so the older shape stays legal keyed by its own
  // version, exactly as PERSISTED_BY_SCHEMA already does.
  const SPEND_KEYS_3_TO_7 = [
    'candidateCap',
    'endpoints',
    'keyedCeiling',
    'keyedRemaining',
    'plannedWorstCaseKeyed',
  ];
  // Schema 8: three budgets, three units, no exchange rate between them. `rpcEndpoint` is the
  // endpoint LABEL and never the composed URL — the keyed one carries the credential in a query
  // parameter, so a record holding the URL would be a record holding the key.
  const SPEND_KEYS_8 = [
    ...SPEND_KEYS_3_TO_7,
    'rpcProvider',
    'rpcEndpoint',
    'heliusCredits',
    'heliusCreditCeilingPerCandidate',
    'plannedWorstCaseHeliusCredits',
  ];
  const SPEND_KEYS_BY_SCHEMA: Record<number, string[]> = {
    3: SPEND_KEYS_3_TO_7,
    4: SPEND_KEYS_3_TO_7,
    5: SPEND_KEYS_3_TO_7,
    6: SPEND_KEYS_3_TO_7,
    7: SPEND_KEYS_3_TO_7,
    8: SPEND_KEYS_8,
  };

  // Keys a version adds to the record OUTSIDE the candidate row and its `entry` block — today the
  // `stage0` block. The three key sets above cannot see these, which is how schema 7 could have
  // shipped a second meaning under version 6 with every existing assertion still green.
  const RECORD_KEYS_ADDED_BY_SCHEMA: Record<number, string[]> = {
    7: [
      'includingUnprovenLaunchesPriced',
      'includingUnprovenPairsPriced',
      'includingUnprovenEntryCostPerSolStakedMedianByLaunch',
      'minEntryCostPositiveShare',
    ],
  };

  // Keys a version adds to a block assembled in `buildRecord` rather than in a projection function
  // below it — today the `spend` block. Kept apart from the list above because that one is asserted
  // against the source AFTER `toRecordRow`, which is where `buildRecord` is not.
  const RUN_LEVEL_KEYS_ADDED_BY_SCHEMA: Record<number, string[]> = {
    8: SPEND_KEYS_8.filter((k) => !SPEND_KEYS_3_TO_7.includes(k)),
  };

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

  it('only the credential module names an environment variable that holds a key', () => {
    // screen.mjs may re-export one for the help text, but nothing else may reach for process.env
    // to find a credential.
    //
    // WIDENED DELIBERATELY, 2026-08-03, in the commit that needed it: `HELIUS_API_KEY` joins
    // `MADEONSOL_API_KEY` under the SAME two-file allow-list rather than getting a looser one. It
    // is named explicitly and the list is still exhaustive — no wildcard, no per-variable exception
    // — so adding a third credential means coming back here on purpose. `DUNE_API_KEY` is listed
    // now too, before any Dune code exists: the assertion costs nothing while the answer is
    // vacuously true, and it means the lane that adds that client cannot quietly name it somewhere
    // else first.
    const KEY_VARIABLES = ['MADEONSOL_API_KEY', 'HELIUS_API_KEY', 'DUNE_API_KEY'];
    const allowed = new Set([
      'tools/deployer-screen/credential.mjs',
      'tools/deployer-screen/screen.mjs',
    ]);
    for (const [file, text] of readAll(TOOL_DIR, 'tools/deployer-screen/')) {
      if (allowed.has(file)) continue;
      for (const variable of KEY_VARIABLES) {
        expect(text.includes(variable), `${file} must not name ${variable}`).toBe(false);
      }
    }
    // And the allow-list is only meaningful if the module it points at actually holds the handling.
    const credential = readFileSync(join(TOOL_DIR, 'credential.mjs'), 'utf8');
    for (const variable of ['MADEONSOL_API_KEY', 'HELIUS_API_KEY']) {
      expect(credential.includes(variable), `credential.mjs must own ${variable}`).toBe(true);
    }
  });

  it('the composed Helius URL is built in one place and stored nowhere', () => {
    // The key reaches the wire as a QUERY PARAMETER, which is the one credential shape that leaks
    // by being formatted rather than by being logged on purpose. Two structural rules keep it in:
    // the composition appears once, and no other file may spell the query parameter at all.
    const all = readAll(TOOL_DIR, 'tools/deployer-screen/', /./);
    for (const [file, text] of all) {
      if (file === 'tools/deployer-screen/credential.mjs') continue;
      expect(/api-key=/.test(text), `${file} must not compose a keyed RPC URL`).toBe(false);
    }
    // Counted over the EXECUTABLE half only. The rule is about code; prose that describes the URL
    // shape is documentation, and making documentation unwritable is not a security property.
    const credential = (all.get('tools/deployer-screen/credential.mjs') ?? '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.includes('/**'))
      .join('\n');
    // COMPOSITION is an interpolation — the query parameter followed by a value spliced into it —
    // and that is what must happen once. The bare token may also appear as a SHAPE test, which is
    // how a composed URL pasted into the key variable is refused (a 76-character paste sits inside
    // the length band, so nothing else can catch it). Counting interpolations rather than tokens is
    // the tighter statement of the property, not a looser one: the exhaustive cross-file rule above
    // is untouched, and a second `api-key=${…}` anywhere still fails here.
    expect(credential.match(/api-key=\$\{/g)?.length, 'exactly one composition site').toBe(1);
    // And every other occurrence must be a non-composing one, so a URL cannot be assembled by
    // concatenation to dodge the count above.
    expect(credential.match(/api-key=(?!\$\{)./g) ?? [], 'a non-interpolating use must not build a URL').toSatisfy(
      (uses: string[]) => uses.every((u) => u.endsWith("'") || u.endsWith('"') || u.endsWith('`')),
    );
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
      // TIGHTENED, not loosened: a Helius key is a UUID, so the scan gains a second shape rather
      // than trading the first one away. Nothing under this directory has any business carrying a
      // bare UUID — no mint, signature or wallet address takes that form — so a hit is either a
      // pasted credential or a genuinely new kind of value that has to come and justify itself here.
      expect(
        /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/.test(text),
        `${file} may contain a real Helius key`,
      ).toBe(false);
    }
  });

  it('the RPC endpoint is chosen by the key\'s presence, and both paths are the real ones', () => {
    // The fallback must be the endpoint it always was, byte for byte — not a re-spelling of it.
    const keyless = resolveSolanaRpcEndpoint({});
    expect(keyless.provider).toBe('public');
    expect(keyless.url).toBe(PUBLIC_SOLANA_RPC);
    expect(keyless.url).toBe(SOLANA_RPC);
    expect(keyless.keyDescription).toBeNull();
    expect(keyless.rejected).toBeNull();
    // An empty or whitespace value is "not configured", not "configured badly": that is what an
    // unset variable expands to in a shell, and refusing it as malformed would send an operator
    // hunting a key problem they do not have.
    expect(resolveSolanaRpcEndpoint({ [HELIUS_KEY_ENV_VAR]: '' }).provider).toBe('public');
    expect(resolveSolanaRpcEndpoint({ [HELIUS_KEY_ENV_VAR]: '   ' }).rejected).toBeNull();

    const key = '11111111-2222-4333-8444-555555555555';
    const keyed = resolveSolanaRpcEndpoint({ [HELIUS_KEY_ENV_VAR]: key });
    expect(keyed.provider).toBe('helius');
    expect(keyed.url).toBe(`${HELIUS_RPC_HOST}/?api-key=${key}`);
    // The label is the whole no-leak guarantee, so it is asserted rather than assumed.
    expect(keyed.label).toBe(HELIUS_RPC_HOST);
    expect(keyed.label).not.toContain(key);
    expect(keyed.keyDescription).toEqual({ length: 36, hasDocumentedShape: true });

    // A key that is present but malformed falls back AND says so. Silently running keyless would
    // produce a slow run and a `provider: "public"` record with no reason in it.
    const short = resolveSolanaRpcEndpoint({ [HELIUS_KEY_ENV_VAR]: 'abc' });
    expect(short.provider).toBe('public');
    expect(short.rejected).toMatch(/outside the 24-128 band/);
    // And the complaint never quotes the value it is complaining about.
    expect(short.rejected).not.toContain('abc');
    expect(describeHeliusKey('not-a-uuid-but-long-enough-to-pass').hasDocumentedShape).toBe(false);
  });

  it('a composed URL pasted into the key variable is refused on SHAPE, which no length band can do', () => {
    // The one malformed value the 24-128 band structurally cannot catch: this host plus a UUID key
    // is 76 characters, comfortably inside it. Accepted, it would be composed a SECOND time, every
    // request would 401, and before the walk's fail-fast landed that degraded every candidate to an
    // ownership-only reading while the shared MadeOnSol daily allowance drained a profile at a time.
    const key = '11111111-2222-4333-8444-555555555555';
    const composed = `${HELIUS_RPC_HOST}/?api-key=${key}`;
    expect(composed.length).toBeGreaterThanOrEqual(24);
    expect(composed.length).toBeLessThanOrEqual(128);

    const rejected = resolveSolanaRpcEndpoint({ [HELIUS_KEY_ENV_VAR]: composed });
    // The existing fallback mechanism, unchanged: keyless AND a stated reason. A silent fallback
    // would read as a deliberate keyless run in the record.
    expect(rejected.provider).toBe('public');
    expect(rejected.url).toBe(PUBLIC_SOLANA_RPC);
    expect(rejected.rejected).toMatch(/composed URL/);
    // The message names the SHAPE and never the value — same rule as the too-short/too-long ones.
    // A rejection that quoted the paste would print the key it exists to protect.
    expect(rejected.rejected).not.toContain(key);
    expect(rejected.rejected).not.toContain(composed);

    // A bare scheme is enough; so is a stray query fragment with no scheme at all.
    expect(resolveSolanaRpcEndpoint({ [HELIUS_KEY_ENV_VAR]: `https://example.invalid/${key}` }).provider).toBe(
      'public',
    );
    expect(resolveSolanaRpcEndpoint({ [HELIUS_KEY_ENV_VAR]: `?api-key=${key}` }).rejected).toMatch(
      /composed URL/,
    );
    // And a real bare key is still accepted — the check must not be so broad it refuses the thing
    // it is protecting.
    expect(resolveSolanaRpcEndpoint({ [HELIUS_KEY_ENV_VAR]: key }).provider).toBe('helius');
  });

  it('a keyed endpoint\'s credential reaches no message, on any failure path', () => {
    // The structural half of "never logged": the key rides in the URL, so every failure path is
    // driven against a sentinel-bearing endpoint and the sentinel must appear in none of them.
    // A comment saying "we are careful here" would not have caught the interpolation this replaced.
    const SENTINEL = 'SENTINEL-KEY-MUST-NEVER-APPEAR';
    const endpoint = {
      url: `https://mainnet.helius-rpc.com/?api-key=${SENTINEL}`,
      label: 'https://mainnet.helius-rpc.com',
      authRemedy: 'Re-export the key and rerun.',
    };
    /** @param status what the endpoint answers with */
    const clientAnswering = (status: number, body: unknown = {}) =>
      new SolanaRpcClient({
        maxRequests: 6,
        endpoint,
        minIntervalMs: 0,
        backoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: (async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      });

    const messages: string[] = [];
    return (async () => {
      // 401 — the credential path, and the one that carries a remedy sentence.
      await clientAnswering(401)
        .call('getHealth', [])
        .catch((e: unknown) => messages.push(String((e as Error).message)));
      // 429 and 500 — load-shedding, retried to exhaustion, then thrown.
      await clientAnswering(429).call('getHealth', []).catch((e: unknown) => messages.push(String((e as Error).message)));
      await clientAnswering(503).call('getHealth', []).catch((e: unknown) => messages.push(String((e as Error).message)));
      // 404 — a plain non-ok status.
      await clientAnswering(404).call('getHealth', []).catch((e: unknown) => messages.push(String((e as Error).message)));
      // A transport failure, where the cause is somebody else's string entirely.
      const dead = new SolanaRpcClient({
        maxRequests: 4,
        endpoint,
        minIntervalMs: 0,
        backoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: (async () => {
          throw new Error('ECONNRESET');
        }) as unknown as typeof fetch,
      });
      await dead.call('getHealth', []).catch((e: unknown) => messages.push(String((e as Error).message)));
      // And the ceiling message, which is persisted verbatim into a run record.
      const spent = new SolanaRpcClient({ maxRequests: 1, endpoint, minIntervalMs: 0, sleepImpl: async () => {},
        fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch });
      await spent.call('getHealth', []);
      await spent.call('getHealth', []).catch((e: unknown) => messages.push(String((e as Error).message)));

      expect(messages.length).toBe(6);
      for (const m of messages) {
        expect(m, 'a credential reached an error message').not.toContain(SENTINEL);
        expect(m).not.toContain('api-key=');
      }
      // The safe label DID reach them, so this is a redaction rather than a silence.
      expect(messages.filter((m) => m.includes('mainnet.helius-rpc.com')).length).toBeGreaterThan(0);
      // And a refused credential is not retried: one attempt, not four.
      expect(messages[0]).toMatch(/refused this client's credential/);
      expect(messages[0]).toMatch(/Re-export the key and rerun/);
    })();
  });

  it('a refused credential stops immediately; a shed request is retried', async () => {
    let attempts = 0;
    const rejecting = new SolanaRpcClient({
      maxRequests: 8,
      endpoint: { url: 'https://helius.example/?api-key=x', label: 'https://helius.example' },
      minIntervalMs: 0,
      backoffMs: 0,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        attempts += 1;
        return new Response('Unauthorized', { status: 401 });
      }) as unknown as typeof fetch,
    });
    await expect(rejecting.call('getHealth', [])).rejects.toThrow(RpcCredentialRejected);
    // ONE attempt. The allowance is not what is wrong, so asking three more times over ~35s only
    // spends the ceiling to be refused again.
    expect(attempts).toBe(1);
    expect(rejecting.issued()).toBe(1);

    // A 429 is the opposite: load-shedding, retried, and every attempt still counted.
    let shedAttempts = 0;
    const shedding = new SolanaRpcClient({
      maxRequests: 8,
      minIntervalMs: 0,
      backoffMs: 0,
      maxRetriesPerRequest: 2,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        shedAttempts += 1;
        return new Response('{}', { status: 429 });
      }) as unknown as typeof fetch,
    });
    await expect(shedding.call('getHealth', [])).rejects.toThrow();
    expect(shedAttempts).toBe(3);
    expect(shedding.issued()).toBe(3);
    expect(shedding.loadShedEvents()).toBe(3);
  });

  it('a JSON-RPC error envelope is an ANSWER, and a null result is a retry', async () => {
    // Measured 2026-08-03: Helius answers a bad parameter with HTTP 200 and
    // {"error":{"code":-32602,…}}. The keyless endpoint sheds load with a null result inside an
    // otherwise fine response. `call` flattens both to null — which is what the keyless walk needs
    // — and `callDetailed` keeps them apart, which is what the indexed walk needs.
    const erroring = new SolanaRpcClient({
      maxRequests: 4,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32602, message: 'Invalid param' } }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    expect(await erroring.call('x', [])).toBeNull();
    const detailed = await erroring.callDetailed('x', []);
    expect(detailed.result).toBeNull();
    expect(detailed.error).toEqual({ code: -32602, message: 'Invalid param' });

    // A missing result with NO error stays a null, i.e. still a retry rather than an answer.
    const shedding = new SolanaRpcClient({
      maxRequests: 4,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: null }), { status: 200 })) as unknown as typeof fetch,
    });
    const shed = await shedding.callDetailed('x', []);
    expect(shed.result).toBeNull();
    expect(shed.error).toBeNull();

    // `id: null` is what a JSON-RPC server sends when it could not read the request at all —
    // Helius returns it for an unknown method — and it must not be dropped on the floor.
    const unknownMethod = new SolanaRpcClient({
      maxRequests: 4,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    expect((await unknownMethod.callDetailed('nope', [])).error?.code).toBe(-32601);
  });

  it('a committed run record persists derived fields only — ToS §5a(d), asserted', () => {
    // The README makes a ToS-facing claim about exactly which fields survive a run. It is asserted
    // here so the claim cannot drift from the code, and so a future field addition has to come and
    // change this list on purpose.
    //
    // Keyed by schema version rather than replaced, because run records are the grading lane's
    // declared input and are never retro-edited to fit a newer schema — record.mjs owns that rule.
    // A single flat list would have forced exactly the retro-edit it forbids.
    // Anything from the vendor's per-token records. None of these may appear in a candidate row.
    const FORBIDDEN =
      /"(mint|token_mint|token_name|token_symbol|symbol|name|peak_market_cap|mc_at_bond|bonded_at|deployed_at|time_to_bond_minutes|ath_market_cap|pool_address|token_image_url)"/;

    const records = readAll(join(TOOL_DIR, 'runs'), '', /\.json$/);
    expect(records.size).toBeGreaterThan(0);
    for (const [file, text] of records) {
      const parsed = JSON.parse(text) as {
        candidates: Record<string, unknown>[];
        spend?: Record<string, unknown>;
      };
      expect(parsed.candidates.length, file).toBeGreaterThan(0);
      const expected = PERSISTED_BY_SCHEMA[schemaVersionOf(parsed)];
      expect(expected, `${file} has an unknown schemaVersion`).toBeDefined();
      // The run-level `spend` block, keyed by version for the same reason: schema 8 added five keys
      // to it and nothing above this line could have seen them.
      if (parsed.spend !== undefined && parsed.spend !== null) {
        const spendExpected = SPEND_KEYS_BY_SCHEMA[schemaVersionOf(parsed)];
        expect(spendExpected, `${file} spend block at an unknown schemaVersion`).toBeDefined();
        expect(Object.keys(parsed.spend).sort(), `${file} spend block`).toEqual(
          [...spendExpected!].sort(),
        );
        // And the label, never the composed URL. The keyed endpoint's address carries the
        // credential in a query parameter, so a URL here would be a persisted key.
        expect(JSON.stringify(parsed.spend), `${file} spend block holds a composed RPC URL`).not.toMatch(
          /api-key=/,
        );
      }
      for (const row of parsed.candidates) {
        expect(Object.keys(row).sort(), `${file} candidate row`).toEqual(expected);
        expect(FORBIDDEN.test(JSON.stringify(row)), `${file} holds per-token vendor data`).toBe(false);
        // And the `entry` block's own key set, for the same reason one level down: schema 5 changed
        // nothing about a candidate row and everything about what `entry` means.
        const entry = row['entry'];
        if (entry !== undefined && entry !== null) {
          const entryExpected = ENTRY_KEYS_BY_SCHEMA[schemaVersionOf(parsed)];
          expect(entryExpected, `${file} entry block at an unknown schemaVersion`).toBeDefined();
          expect(Object.keys(entry as object).sort(), `${file} entry block`).toEqual([...entryExpected!].sort());
          const coverage = (entry as Record<string, unknown>)['coverage'];
          const coverageExpected = ENTRY_COVERAGE_KEYS_BY_SCHEMA[schemaVersionOf(parsed)];
          expect(coverageExpected, `${file} entry.coverage at an unknown schemaVersion`).toBeDefined();
          expect(Object.keys(coverage as object).sort(), `${file} entry.coverage`).toEqual(
            [...coverageExpected!].sort(),
          );
        }
      }
    }
  });

  it('a record can never report an unjudged candidate while claiming it measured everything', () => {
    // The invariant, stated once: if any candidate row carries `gate-unmeasured`, the RUN level has
    // to say so too. `unmeasured: []` with `truncated: false` is a record telling its reader it
    // measured everything it reports — which, next to a wallet nobody judged, is the same invisible
    // false rejection this whole reading exists to remove, one level up.
    const violates = (r: {
      candidates?: { verdict?: string }[];
      unmeasured?: unknown[];
      truncated?: boolean;
    }) =>
      (r.candidates ?? []).some((c) => c.verdict === 'gate-unmeasured') &&
      (r.unmeasured ?? []).length === 0 &&
      r.truncated !== true;

    // The checker is not vacuous: a record in the prohibited shape is recognised as one.
    expect(
      violates({ candidates: [{ verdict: 'gate-unmeasured' }], unmeasured: [], truncated: false }),
    ).toBe(true);
    expect(
      violates({
        candidates: [{ verdict: 'gate-unmeasured' }],
        unmeasured: [
          unmeasuredNoSource('the bonded status of a launch history', 'W', 'nothing could answer'),
        ],
        truncated: false,
      }),
    ).toBe(false);

    for (const [file, text] of readAll(join(TOOL_DIR, 'runs'), '', /\.json$/)) {
      expect(violates(JSON.parse(text)), `${file} reports an unjudged candidate as measured`).toBe(false);
    }

    // And the one branch that can mint a `gate-unmeasured` without a thrown cause must be the same
    // branch that files the run-level entry, or the invariant holds only until the next edit.
    const source = readFileSync(join(TOOL_DIR, 'screen.mjs'), 'utf8');
    const branch = source.slice(source.indexOf('if (merged.bondedUndecidable > 0)'));
    expect(branch.slice(0, branch.indexOf('\n        }\n'))).toMatch(/unmeasured\.push\(/);
  });

  it('the creation walk emits the heartbeat the operator guidance tells a reader to watch', () => {
    // Docs and behaviour have to agree, and here the disagreement is consequential: it is the
    // difference between letting a healthy 13-hour run finish and killing it. The walk was the one
    // client built without an onRequest logger while the README told operators to watch a counter.
    const source = readFileSync(join(TOOL_DIR, 'screen.mjs'), 'utf8');
    const construction = source.slice(
      source.indexOf('new SolanaRpcClient('),
      source.indexOf('readCreatedHistory(rpc'),
    );
    expect(construction).toMatch(/onRequest:/);
    // Suppressed under --json, like every other logger here, so the record stays machine-readable.
    expect(construction).toMatch(/opts\.json/);
    // A heartbeat, not a line per request: up to 100 x 195 requests would bury the report.
    expect(construction).toMatch(/RPC_HEARTBEAT_EVERY/);

    const every = Number(/const RPC_HEARTBEAT_EVERY = (\d+)/.exec(source)?.[1]);
    expect(every).toBeGreaterThan(1);

    // And the prose must describe THAT cadence rather than a per-request one. The pacing is pinned
    // in thresholds.json, so the interval the README quotes is derived rather than asserted.
    const thresholds = JSON.parse(readFileSync(join(TOOL_DIR, 'thresholds.json'), 'utf8')) as {
      creation_walk: { rpcMinIntervalMs: number };
    };
    const seconds = (every * thresholds.creation_walk.rpcMinIntervalMs) / 1000;
    const readme = readFileSync(join(TOOL_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/\*\*every tenth\*\*/);
    expect(readme).toMatch(new RegExp(`every ${seconds} seconds`));
    expect(readme, 'the withdrawn per-request claim must not survive anywhere').not.toMatch(
      /counter, which advances on every request/,
    );
    expect(readFileSync(join(TOOL_DIR, 'thresholds.json'), 'utf8')).toMatch(/PERIODIC HEARTBEAT/);
  });

  it('the pinned keyless ceiling covers BOTH passes that share the frontend-api-v3 client', () => {
    // The ceiling was justified on the consistency pass alone — 3 pages per gate survivor — while
    // the GATE spends 4 pages per CANDIDATE on the same client. At the default candidate cap that
    // already overran it, and because the keyless work runs AFTER the keyed allowance is spent, the
    // overrun would have thrown away a run that was already paid for in vendor quota.
    const thresholds = JSON.parse(readFileSync(join(TOOL_DIR, 'thresholds.json'), 'utf8')) as {
      budget: { maxCandidates: number; maxKeylessRequests: number };
    };
    const source = readFileSync(join(TOOL_DIR, 'screen.mjs'), 'utf8');
    const listingPages = Number(/const LISTING_PAGES_FOR_MERGE = (\d+)/.exec(source)?.[1]);
    expect(listingPages).toBeGreaterThan(0);

    const worstCase = thresholds.budget.maxCandidates * (listingPages + 3);
    expect(worstCase).toBeLessThanOrEqual(thresholds.budget.maxKeylessRequests);
    // And the refusal exists, so a plan that ever stops fitting is refused rather than discovered.
    expect(source).toMatch(/worstCaseKeyless/);
  });

  it('the README\'s schema table is in step with record.mjs — these two have drifted twice', () => {
    // The version boundary is documented in TWO prose copies: `record.mjs`\'s module comment, which
    // a reader of the code finds, and the README table, which a consumer of a record finds. They
    // have drifted apart twice. A consumer reading the stale one version-detects wrongly, which on
    // this record is not a cosmetic error: it decides whether an `entry` block\'s verdict means
    // "room was present and the seat was never priced" or "the seat was priced and the field still
    // cleared".
    const readme = readFileSync(join(TOOL_DIR, 'README.md'), 'utf8');
    const table = readme.slice(readme.indexOf('| version | what it carries |'));
    for (let v = 2; v <= RECORD_SCHEMA_VERSION; v++) {
      expect(table, `the README schema table has no row for version ${v}`).toMatch(
        new RegExp(`^\\| ${v} \\|`, 'm'),
      );
    }
    expect(table, 'the README documents a version this build cannot write').not.toMatch(
      new RegExp(`^\\| ${RECORD_SCHEMA_VERSION + 1} \\|`, 'm'),
    );

    // And every key this build adds to `entry` at the current version must be named in the table
    // row for it, or the table describes a record shape that does not exist.
    const currentRow = /^\| \d+ \| .*$/gm;
    const rows = table.match(currentRow) ?? [];
    const row = rows.find((r) => r.startsWith(`| ${RECORD_SCHEMA_VERSION} |`));
    expect(row, 'no README row for the current schema version').toBeDefined();
    const added = ENTRY_KEYS_BY_SCHEMA[RECORD_SCHEMA_VERSION]!.filter(
      (k) => !ENTRY_KEYS_BY_SCHEMA[RECORD_SCHEMA_VERSION - 1]!.includes(k),
    );
    for (const key of added) expect(row, `the README row omits entry.${key}`).toContain(key);

    // This used to demand `added.length > 0` — that every version add an `entry` key. That
    // assumption is wrong and cost a version its bump: a version may instead change what existing
    // keys MEAN (schema 7 moved `stage0.onChainCostReproduction` to the gated population under
    // unchanged names) or add keys to a block other than `entry`. Do not reinstate it. What
    // replaces it still catches a placeholder row and still pins the keys this build newly writes.
    expect(row!.length, 'the README row for the current version is a placeholder').toBeGreaterThan(200);
    const projection = readFileSync(join(TOOL_DIR, 'screen.mjs'), 'utf8');
    const toRecordRow = projection.slice(projection.indexOf('function toRecordRow'));
    for (const key of RECORD_KEYS_ADDED_BY_SCHEMA[RECORD_SCHEMA_VERSION] ?? []) {
      expect(toRecordRow, `toRecordRow must emit ${key}`).toMatch(new RegExp(`\\b${key}:`));
      expect(row, `the README row omits ${key}`).toContain(key);
    }
    for (const key of RUN_LEVEL_KEYS_ADDED_BY_SCHEMA[RECORD_SCHEMA_VERSION] ?? []) {
      // `[:,]` because an emitted key may be shorthand — `heliusCredits,` is the same field as
      // `heliusCredits: heliusCredits` and a colon-only pattern would have missed it.
      expect(projection, `buildRecord must emit ${key}`).toMatch(new RegExp(`\\b${key}[:,]`));
      expect(row, `the README row omits ${key}`).toContain(key);
    }
  });

  it('the row this build writes matches the schema it declares', () => {
    // The assertion above only sees COMMITTED records, so a shape change would go unnoticed until
    // the next run was committed — by which time the record it would have caught already exists.
    const source = readFileSync(join(TOOL_DIR, 'screen.mjs'), 'utf8');
    const projection = source.slice(source.indexOf('function toRecordRow'));
    for (const field of PERSISTED_BY_SCHEMA[RECORD_SCHEMA_VERSION]!) {
      expect(projection, `toRecordRow must emit ${field}`).toMatch(new RegExp(`\\b${field}:`));
    }

    // The `entry` block too, and here against the real projection rather than its source, because
    // this is the block schema 5 changed. A field computed but not persisted is the exact failure
    // `bundledTx` and `maxWalletsInOneTx` already were: present in memory, absent from every record.
    const row = toEntryRecordRow(scoreEntry([], ENTRY_T), emptyEntryCoverage());
    expect(Object.keys(row).sort()).toEqual([...ENTRY_KEYS_BY_SCHEMA[RECORD_SCHEMA_VERSION]!].sort());
    expect(Object.keys(row.coverage).sort()).toEqual(
      [...ENTRY_COVERAGE_KEYS_BY_SCHEMA[RECORD_SCHEMA_VERSION]!].sort(),
    );

    // The run-level `spend` block too, read out of `buildRecord`'s own object literal. There is no
    // committed schema-8 record yet, so the loop over `runs/` cannot see this block at this version
    // — and a key added here without a bump is precisely the drift that made schema 8 necessary.
    const spendStart = source.indexOf('spend: {');
    expect(spendStart, 'buildRecord no longer assembles a `spend` block').toBeGreaterThan(-1);
    const spendBody = source.slice(spendStart + 'spend: {'.length);
    const spendEnd = spendBody.indexOf('\n        },');
    expect(spendEnd, 'the `spend` literal is no longer where this assertion can read it').toBeGreaterThan(-1);
    const spendKeys = [...spendBody.slice(0, spendEnd).matchAll(/^ {10}([A-Za-z][A-Za-z0-9]*)(?::|,$)/gm)].map(
      (m) => m[1]!,
    );
    expect(spendKeys.sort()).toEqual([...SPEND_KEYS_BY_SCHEMA[RECORD_SCHEMA_VERSION]!].sort());
  });
});

// ---------------------------------------------------------------------------------------------
// Creation-derived launch history.
//
// The defect these cover: every vendor surface answers "which tokens does this wallet OWN NOW",
// and ownership on pump.fun is a sellable position whose fees make the winners the ones worth
// selling. So the ownership reading understates launches, understates bonded launches by more, and
// scores the better deployer worse — a bias towards REJECTION, which is the invisible direction.
//
// Fixtures are hand-written to the shape of transactions observed on-chain 2026-08-02. The
// canonical one is the real `maxxing` creation, whose signature and account layout are in
// creation.mjs's module comment; the values below are that shape with the addresses shortened.

const MINT = 'MintMintMintMintMintMintMintMintMintMintMi1';
const CURVE = 'CurveCurveCurveCurveCurveCurveCurveCurveCu1';
const DEV = 'DevDevDevDevDevDevDevDevDevDevDevDevDevDev1';
const BUNDLER = 'PayerPayerPayerPayerPayerPayerPayerPayerPa1';

function createTx(
  overrides: {
    signers?: string[];
    accounts?: string[];
    logs?: string[];
    err?: unknown;
    blockTime?: number;
    programId?: string;
  } = {},
) {
  const signers = overrides.signers ?? [DEV, MINT];
  const accounts = overrides.accounts ?? [MINT, 'meta', CURVE, 'abc', 'global', DEV];
  return {
    blockTime: overrides.blockTime ?? 1_764_617_879,
    meta: {
      err: overrides.err ?? null,
      logMessages: overrides.logs ?? ['Program log: Instruction: CreateV2'],
    },
    transaction: {
      signatures: ['SigSigSig'],
      message: {
        accountKeys: [
          ...signers.map((pubkey) => ({ pubkey, signer: true, writable: true })),
          { pubkey: 'notASigner', signer: false, writable: true },
        ],
        instructions: [
          { programId: '11111111111111111111111111111111', parsed: {} },
          { programId: overrides.programId ?? PUMP_PROGRAM_ID, accounts },
        ],
      },
    },
  };
}

describe('a launch is read from the create transaction, not from who owns it now', () => {
  it('reads mint, curve, creator and time out of a pump.fun creation', () => {
    const parsed = parseCreateTransaction(createTx());
    expect(parsed).toEqual({
      mint: MINT,
      bondingCurve: CURVE,
      creator: DEV,
      createdAtMs: 1_764_617_879_000,
      signature: 'SigSigSig',
    });
  });

  it('credits the creator, NOT the fee payer, when a bundler paid', () => {
    // report.md §9.3's counter-trap runs in this direction too: in a bundled transaction
    // accountKeys[0] is whoever paid, not whoever acted, and fee-payer attribution would credit
    // the launch to the bankroll. A pump.fun create needs the creator's own signature because it
    // funds the curve's rent, so "the signer inside the create instruction that is not the mint"
    // names the creator even when somebody else is first in the account list.
    const parsed = parseCreateTransaction(createTx({ signers: [BUNDLER, DEV, MINT] }));
    expect(parsed?.creator).toBe(DEV);
    expect(parsed?.creator).not.toBe(BUNDLER);
  });

  it('refuses when no signer appears in the create instruction at all', () => {
    // Nothing left to credit. Refusing beats falling back to the fee payer.
    expect(
      parseCreateTransaction(
        createTx({ signers: [BUNDLER, MINT], accounts: [MINT, 'meta', CURVE, 'abc', 'global'] }),
      ),
    ).toBeNull();
  });

  it('accepts every Create version the program has emitted, and nothing else', () => {
    for (const log of ['Instruction: Create', 'Instruction: CreateV2', 'Instruction: CreateV3']) {
      expect(parseCreateTransaction(createTx({ logs: [`Program log: ${log}`] }))).not.toBeNull();
    }
    for (const log of ['Instruction: Buy', 'Instruction: Sell', 'Instruction: CreateFeeSharingConfig']) {
      expect(parseCreateTransaction(createTx({ logs: [`Program log: ${log}`] }))).toBeNull();
    }
  });

  it('refuses a failed transaction, a foreign program, and an unsigned first account', () => {
    expect(parseCreateTransaction(createTx({ err: { InstructionError: [1, 'x'] } }))).toBeNull();
    expect(parseCreateTransaction(createTx({ programId: 'SomeOtherProgram1111111111' }))).toBeNull();
    // The mint keypair signs its own initialisation. Without that, this is a trade sharing the
    // transaction with something that logged a Create.
    expect(parseCreateTransaction(createTx({ signers: [DEV] }))).toBeNull();
  });

  it('refuses rather than guesses when the creator is ambiguous', () => {
    const parsed = parseCreateTransaction(
      createTx({ signers: [DEV, MINT, 'SecondSigner'], accounts: [MINT, 'meta', CURVE, 'SecondSigner', DEV] }),
    );
    expect(parsed).toBeNull();
  });

  it('survives a malformed response instead of throwing', () => {
    for (const junk of [null, undefined, {}, { meta: null }, { meta: { err: null } }, 'nope']) {
      expect(parseCreateTransaction(junk)).toBeNull();
    }
  });
});

describe('the bonding-curve account settles both bonded and moved-on', () => {
  // Byte layout validated 2026-08-02 against a control token whose creator has never moved.
  const curveData = (complete: number, creator: Uint8Array) => {
    const raw = Buffer.alloc(151);
    raw[48] = complete;
    Buffer.from(creator).copy(raw, 49);
    return raw.toString('base64');
  };
  const key = (fill: number) => Uint8Array.from({ length: 32 }, () => fill);

  it('reads the complete flag and the current creator from one account', () => {
    const state = readCurveState(curveData(1, key(7)));
    expect(state?.complete).toBe(true);
    expect(state?.creator).toBe(base58Encode(key(7)));

    expect(readCurveState(curveData(0, key(7)))?.complete).toBe(false);
  });

  it('returns null rather than a wrong answer for an absent or short account', () => {
    expect(readCurveState('')).toBeNull();
    expect(readCurveState(Buffer.alloc(40).toString('base64'))).toBeNull();
  });

  it('base58-encodes leading zero bytes as leading ones', () => {
    const withZeros = new Uint8Array(32);
    withZeros[31] = 1;
    expect(base58Encode(withZeros)).toBe(`${'1'.repeat(31)}2`);
    expect(base58Encode(new Uint8Array(32))).toBe('1'.repeat(32));
  });
});

describe('merging a bounded creation walk with the ownership listing', () => {
  const WALLET = 'WalletWalletWalletWalletWalletWalletWallet1';
  const OTHER = 'OtherOtherOtherOtherOtherOtherOtherOtherOt1';
  const covered = { fromMs: T0, toMs: T0 + 10 * DAY, exhausted: false };

  const create = (mint: string, dayOffset: number, creator = WALLET) => ({
    mint,
    bondingCurve: `curve-${mint}`,
    creator,
    createdAtMs: T0 + dayOffset * DAY,
    signature: `sig-${mint}`,
  });
  const listed = (mint: string, dayOffset: number, completed = false) => ({
    mint,
    deployedAtMs: T0 + dayOffset * DAY,
    completed,
  });

  it('counts the launches the ownership surface hid, which is the whole point', () => {
    // Two created inside the window; ownership shows only one of them, because the other's creator
    // record moved on. That is the `maxxing` case, and it is the launch worth having.
    const merged = mergeHistories({
      creates: [create('kept', 1), create('handedOn', 2)],
      wallet: WALLET,
      curves: new Map([
        ['kept', { complete: false, creator: WALLET }],
        ['handedOn', { complete: true, creator: OTHER }],
      ]),
      listed: [listed('kept', 1)],
      covered,
    });

    expect(merged.createdInWindow).toBe(2);
    expect(merged.listedInWindow).toBe(1);
    expect(merged.hiddenByOwnership).toBe(1);
    expect(merged.movedCreator).toBe(1);
    // And the hidden one is the bonded one, so the rate moves further than the count does: the
    // ownership reading would have said 0/1, the truth is 1/2.
    expect(merged.records.filter((r) => r.completed)).toHaveLength(1);
    expect(merged.records).toHaveLength(2);
  });

  it('counts tokens the wallet owns but did not create, the opposite error', () => {
    const merged = mergeHistories({
      creates: [create('mine', 1)],
      wallet: WALLET,
      curves: new Map([['mine', { complete: false, creator: WALLET }]]),
      listed: [listed('mine', 1), listed('acquired', 3)],
      covered,
    });
    expect(merged.notCreatedByWallet).toBe(1);
    expect(merged.hiddenByOwnership).toBe(0);
    // Inside the window the walk is authoritative, so the acquired token is not a launch.
    expect(merged.records).toHaveLength(1);
  });

  it('carries the ownership listing over OUTSIDE the covered window and says how much', () => {
    // A walk that covered two days must not turn a long history into a two-day one and fail the
    // deployer on sample size. That is the same invisible false rejection from the other end.
    const merged = mergeHistories({
      creates: [create('recent', 1)],
      wallet: WALLET,
      curves: new Map([['recent', { complete: true, creator: WALLET }]]),
      listed: [listed('recent', 1), listed('old', -40, true), listed('older', -90)],
      covered,
    });
    expect(merged.listedOutsideWindow).toBe(2);
    expect(merged.records).toHaveLength(3);
    expect(measureCompletion(merged.records).completed).toBe(2);
  });

  it('ignores creations by other wallets that shared the walked index', () => {
    const merged = mergeHistories({
      creates: [create('mine', 1), create('strangers', 2, OTHER)],
      wallet: WALLET,
      curves: new Map(),
      listed: [],
      covered,
    });
    expect(merged.createdInWindow).toBe(1);
  });

  it('falls back to the ownership listing when a launch\'s curve could not be read', () => {
    // The curve byte is authoritative; the listing's own `complete` flag is a weaker but
    // well-founded second source — the same field a vendor mirror of agreed with our tape 67/67.
    // Scoring straight to not-bonded would deflate the very rate this reading exists to widen.
    const merged = mergeHistories({
      creates: [create('readable', 1), create('unread', 2)],
      wallet: WALLET,
      curves: new Map([['readable', { complete: false, creator: WALLET }]]),
      listed: [listed('readable', 1), listed('unread', 2, true)],
      covered,
    });
    expect(merged.bondedFromCurve).toBe(1);
    expect(merged.bondedFromListing).toBe(1);
    expect(merged.bondedUndecidable).toBe(0);
    expect(merged.records.filter((r) => r.completed)).toHaveLength(1);
    expect(measureCompletion(merged.records).completed).toBe(1);
  });

  it('leaves a launch UNDECIDABLE when neither source can answer, and says so', () => {
    // Not hypothetical: a launch HIDDEN from the ownership listing has no row by definition, and
    // that is exactly the launch this whole route exists to find. Counting it as a failure would
    // reintroduce the invisible false rejection at the last step.
    const merged = mergeHistories({
      creates: [create('hidden', 1)],
      wallet: WALLET,
      curves: new Map(),
      listed: [],
      covered,
    });
    expect(merged.bondedUndecidable).toBe(1);
    expect(merged.bondedFromCurve).toBe(0);
    expect(merged.bondedFromListing).toBe(0);
    // Still counted as not-bonded so the rate can only be understated — but the reading is now
    // recognisably unmeasured rather than a confident rejection.
    expect(merged.records[0]?.completed).toBe(false);
  });

  it('reconciles the three bonded-provenance counts with the launch count, always', () => {
    const merged = mergeHistories({
      creates: [create('curve', 1), create('viaListing', 2), create('neither', 3)],
      wallet: WALLET,
      curves: new Map([['curve', { complete: true, creator: WALLET }]]),
      listed: [listed('viaListing', 2, true), listed('old', -40, true), listed('older', -90)],
      covered,
    });
    expect(merged.bondedFromCurve + merged.bondedFromListing + merged.bondedUndecidable).toBe(
      merged.records.length,
    );
    expect(merged.bondedUndecidable).toBe(1);
  });

  it('does not let a duplicated listing row drive the under-count negative', () => {
    // `overlap` counts listing rows against a set of distinct created mints, so a mint the endpoint
    // served twice — the same row reached from two offsets while the deployer launched again — used
    // to make overlap exceed createdInWindow. This measurement sizes a bias; it cannot carry one.
    const merged = mergeHistories({
      creates: [create('dup', 1)],
      wallet: WALLET,
      curves: new Map([['dup', { complete: false, creator: WALLET }]]),
      listed: [listed('dup', 1), listed('dup', 1), listed('dup', 1)],
      covered,
    });
    expect(merged.listedInWindow).toBe(1);
    expect(merged.hiddenByOwnership).toBe(0);
    expect(merged.hiddenByOwnership).toBeGreaterThanOrEqual(0);
    expect(merged.notCreatedByWallet).toBe(0);
    expect(merged.records).toHaveLength(1);
  });

  it('keeps an in-window listing row when the walk left transactions unresolved', () => {
    // "Inside the window the walk is authoritative" holds only when unresolvedTransactions is 0.
    // A getTransaction that never came back may have been a create, so relabelling its listing row
    // "acquired" and dropping it would delete a real launch — and its bonded flag — from BOTH sides
    // of the gate's fraction.
    const input = {
      creates: [create('seen', 1)],
      wallet: WALLET,
      curves: new Map([['seen', { complete: false, creator: WALLET }]]),
      listed: [listed('seen', 1), listed('missed', 3, true)],
      covered,
    };

    const exact = mergeHistories(input);
    expect(exact.windowExact).toBe(true);
    expect(exact.notCreatedByWallet).toBe(1);
    expect(exact.listedInWindowCarried).toBe(0);
    expect(exact.records).toHaveLength(1);

    const partial = mergeHistories({ ...input, unresolvedTransactions: 2 });
    expect(partial.windowExact).toBe(false);
    expect(partial.listedInWindowCarried).toBe(1);
    // Carried, not reclassified — and notCreatedByWallet must not be inflated by it either.
    expect(partial.notCreatedByWallet).toBe(0);
    expect(partial.records).toHaveLength(2);
    expect(measureCompletion(partial.records).completed).toBe(1);
  });
});

describe('the Solana RPC client is bounded the same way the keyed one is', () => {
  const okBody = (result: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 0, result }),
  });

  it('refuses to exceed its ceiling', async () => {
    const fetchImpl = vi.fn(async () => okBody('x')) as unknown as typeof fetch;
    const rpc = new SolanaRpcClient({ maxRequests: 2, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    await rpc.call('getSlot', []);
    await rpc.call('getSlot', []);
    await expect(rpc.call('getSlot', [])).rejects.toThrow(CeilingReached);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('says what ITS ceiling stopped, not what the keyed run ceiling would have', async () => {
    // This message is persisted verbatim as `creation.stopDetail`, and run records are the grading
    // lane's declared input. Reusing the keyed client's wording put "the run stopped early" and
    // "raise --max-requests" into a record whose top level said `completed: true` — a per-candidate
    // RPC bound is not a run bound, and --max-requests is a keyed lever that cannot move it.
    const fetchImpl = vi.fn(async () => okBody('x')) as unknown as typeof fetch;
    const rpc = new SolanaRpcClient({ maxRequests: 1, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    await rpc.call('getSlot', []);
    const cause = await rpc.call('getSlot', []).catch((e: unknown) => e);

    expect(cause).toBeInstanceOf(CeilingReached);
    const message = (cause as Error).message;
    expect(message).not.toMatch(/Raise --max-requests/);
    expect(message).not.toMatch(/run stopped early/);
    expect(message).not.toMatch(/INCOMPLETE/);
    expect(message).toMatch(/PER-CANDIDATE/);
    expect(message).toMatch(/creation_walk\.maxRpcRequestsPerCandidate/);
    // It names the wrong lever only to rule it out, which is the instinct an operator reading a
    // ceiling message actually has.
    expect(message).toMatch(/--max-requests is the keyed vendor ceiling and cannot move it/);
    // The keyed client's own ceiling keeps the wording that is true of it.
    expect(new CeilingReached(600, '/x').message).toMatch(/--max-requests/);
  });

  it('retries a 429 with backoff, and every attempt counts against the ceiling', async () => {
    // The opposite of the keyed client, where 429 means a metered allowance is spent and retrying
    // just spends it again. On a free public endpoint it means slow down.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? { ok: false, status: 429, json: async () => ({}) } : okBody('done');
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    const rpc = new SolanaRpcClient({
      maxRequests: 10,
      minIntervalMs: 0,
      backoffMs: 100,
      fetchImpl,
      sleepImpl: async (ms) => {
        slept.push(ms);
      },
    });

    expect(await rpc.call('getSlot', [])).toBe('done');
    expect(rpc.issued()).toBe(3);
    expect(rpc.loadShedEvents()).toBe(2);
    expect(slept).toEqual([100, 200]);
  });

  it('a 429 storm still cannot outlast the ceiling', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    const rpc = new SolanaRpcClient({
      maxRequests: 3,
      minIntervalMs: 0,
      backoffMs: 0,
      maxRetriesPerRequest: 99,
      fetchImpl,
      sleepImpl: async () => {},
    });
    await expect(rpc.call('getSlot', [])).rejects.toThrow(CeilingReached);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('treats a null inside a batch as retry, never as absent', async () => {
    // The public RPC sheds load by returning nulls inside batches rather than erroring. A caller
    // that reads one as an empty answer silently loses records.
    let round = 0;
    const fetchImpl = vi.fn(async () => {
      round += 1;
      return {
        ok: true,
        status: 200,
        json: async () =>
          round === 1
            ? [
                { id: 0, result: 'a' },
                { id: 1, result: null },
              ]
            : [{ id: 0, result: 'b' }],
      };
    }) as unknown as typeof fetch;

    const rpc = new SolanaRpcClient({ maxRequests: 5, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const out = await rpc.batch([
      { method: 'getTransaction', params: ['a'] },
      { method: 'getTransaction', params: ['b'] },
    ]);
    expect(out).toEqual(['a', 'b']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('announces every request it issues, retries included, so a caller can prove liveness', async () => {
    // This is the leg that dominates a default run's wall clock — ~13.5 hours worst case — and a
    // silent terminal is what gets a healthy run killed. The client reports each request; deciding
    // how often to SHOW one is the caller's, because a line per request here is ~20,000 lines.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 429, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 0, result: 'ok' }) };
    }) as unknown as typeof fetch;

    const labels: string[] = [];
    const rpc = new SolanaRpcClient({
      maxRequests: 10,
      minIntervalMs: 0,
      backoffMs: 0,
      fetchImpl,
      sleepImpl: async () => {},
      onRequest: (label) => labels.push(label),
    });

    await rpc.call('getSignaturesForAddress', []);
    await rpc.batch([{ method: 'getTransaction', params: ['a'] }]);
    // The shed attempt counts against the ceiling, so it has to be visible too — a heartbeat that
    // stalls during a 429 storm reads exactly like the hang it exists to rule out.
    expect(labels).toEqual([
      'getSignaturesForAddress',
      'getSignaturesForAddress',
      'batch:getTransaction',
    ]);
    expect(labels).toHaveLength(rpc.issued());
  });

  it('refuses a batch larger than the measured cap', async () => {
    const fetchImpl = vi.fn(async () => okBody('x')) as unknown as typeof fetch;
    const rpc = new SolanaRpcClient({ maxRequests: 5, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    await expect(
      rpc.batch(Array.from({ length: 9 }, () => ({ method: 'getTransaction', params: [] }))),
    ).rejects.toThrow(RangeError);
  });
});

describe('the creation walk is bounded, and says which bound bit', () => {
  /** A fake endpoint holding one page of signatures and the transactions behind them. */
  function fakeRpc(pages: { signature: string; blockTime: number; err: unknown }[][], txs: Record<string, unknown>) {
    return vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const one = Array.isArray(body) ? body[0] : body;
      if (one.method === 'getSignaturesForAddress') {
        const before = one.params[1]?.before;
        const idx = before === undefined ? 0 : pages.findIndex((p) => p[p.length - 1]?.signature === before) + 1;
        return { ok: true, status: 200, json: async () => ({ id: 0, result: pages[idx] ?? [] }) };
      }
      if (one.method === 'getMultipleAccounts') {
        return { ok: true, status: 200, json: async () => ({ id: 0, result: { value: [] } }) };
      }
      const rows = (Array.isArray(body) ? body : [body]).map((r: { id: number; params: string[] }) => ({
        id: r.id,
        result: txs[r.params[0] as string] ?? null,
      }));
      return { ok: true, status: 200, json: async () => (Array.isArray(body) ? rows : rows[0]) };
    }) as unknown as typeof fetch;
  }

  const sig = (n: number, err: unknown = null) => ({ signature: `s${n}`, blockTime: 1_700_000_000 + n, err });

  it('inspects only succeeded signatures — creations never fail', async () => {
    const page = [sig(3), sig(2, { InstructionError: [0, 'x'] }), sig(1)];
    const fetchImpl = fakeRpc([page], { s3: createTx({ blockTime: 1_700_000_003 }), s1: createTx() });
    const rpc = new SolanaRpcClient({ maxRequests: 20, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });

    const walk = await readCreatedHistory(rpc, DEV, {
      maxSignaturePages: 5,
      maxTransactions: 50,
      txBatchSize: 1,
    });
    expect(walk.signaturesScanned).toBe(3);
    expect(walk.signaturesSucceeded).toBe(2);
    expect(walk.transactionsInspected).toBe(2);
    expect(walk.creates).toHaveLength(2);
    expect(walk.stopReason).toBe('index-exhausted');
    expect(walk.covered.exhausted).toBe(true);
  });

  it('stops at the transaction cap and reports the window it actually covered', async () => {
    const page = Array.from({ length: 6 }, (_, i) => sig(i));
    const fetchImpl = fakeRpc([page], {});
    const rpc = new SolanaRpcClient({ maxRequests: 50, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });

    const walk = await readCreatedHistory(rpc, DEV, {
      maxSignaturePages: 5,
      maxTransactions: 3,
      txBatchSize: 1,
    });
    expect(walk.stopReason).toBe('transaction-cap');
    expect(walk.covered.exhausted).toBe(false);
    // The floor only advances once a page is fully inspected, so an abandoned page must not widen
    // the window it did not cover. It is NULL rather than 0: `0` is a real instant that a consumer
    // reads as "covered since 1970", which is the widest possible window rather than the empty one
    // this walk actually has. The merge's half of this contract is asserted below, in "a walk that
    // covered nothing".
    expect(walk.covered.fromMs).toBeNull();
  });

  it('keeps what it paid for when the request ceiling bites', async () => {
    const page = [sig(2), sig(1)];
    const fetchImpl = fakeRpc([page], { s2: createTx() });
    // 3: one for the signature page, one for a transaction, one held back for the curve read.
    const rpc = new SolanaRpcClient({ maxRequests: 3, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });

    const walk = await readCreatedHistory(rpc, DEV, {
      maxSignaturePages: 5,
      maxTransactions: 50,
      txBatchSize: 1,
    });
    expect(walk.stopReason).toBe('request-ceiling');
    expect(walk.creates).toHaveLength(1);
    // This fixture's curve account comes back empty, so the launch still counts as not-bonded
    // downstream. That has to be visible: a silently deflated completion rate is the failure mode
    // this lane removes.
    expect(walk.curvesUnread).toBe(1);
  });

  it('labels an upstream failure as a stop, not as an empty history', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const rpc = new SolanaRpcClient({
      maxRequests: 20,
      minIntervalMs: 0,
      backoffMs: 0,
      maxRetriesPerRequest: 1,
      fetchImpl,
      sleepImpl: async () => {},
    });
    const walk = await readCreatedHistory(rpc, DEV, {
      maxSignaturePages: 2,
      maxTransactions: 10,
      txBatchSize: 1,
    });
    expect(walk.stopReason).toBe('upstream-error');
    expect(walk.stopDetail).toMatch(/503/);
    expect(walk.covered.exhausted).toBe(false);
  });

  it('never reads a shed or errored signature page as the end of the index', async () => {
    // `call` returns null both when the public RPC sheds load and when the JSON-RPC envelope
    // carries an `error` instead of a `result`. Reading either as an empty page would record page 2
    // of 200 as the wallet's WHOLE history under `index-exhausted` — a ceiling presented as a
    // measurement, which is the one output this lane exists to make impossible.
    for (const shed of [
      { id: 0, error: { code: -32603, message: 'load shed' } },
      { id: 0, result: null },
    ]) {
      // A FULL page, so the walk carries on to a second one instead of stopping on a short page.
      // Every signature failed, so no getTransaction is spent reaching the shed page.
      const first = Array.from({ length: 1000 }, (_, i) => sig(1000 - i, { InstructionError: [0, 'x'] }));
      let served = 0;
      const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const one = Array.isArray(body) ? body[0] : body;
        if (one.method === 'getSignaturesForAddress') {
          served += 1;
          // The first page resolves; every later attempt sheds, including the retry.
          return served === 1
            ? { ok: true, status: 200, json: async () => ({ id: 0, result: first }) }
            : { ok: true, status: 200, json: async () => shed };
        }
        if (one.method === 'getMultipleAccounts') {
          return { ok: true, status: 200, json: async () => ({ id: 0, result: { value: [] } }) };
        }
        return { ok: true, status: 200, json: async () => ({ id: one.id ?? 0, result: null }) };
      }) as unknown as typeof fetch;

      const rpc = new SolanaRpcClient({
        maxRequests: 40,
        minIntervalMs: 0,
        fetchImpl,
        sleepImpl: async () => {},
      });
      const walk = await readCreatedHistory(rpc, DEV, {
        maxSignaturePages: 10,
        maxTransactions: 100,
        txBatchSize: 1,
      });

      expect(walk.stopReason).not.toBe('index-exhausted');
      expect(walk.stopReason).toBe('upstream-error');
      expect(walk.covered.exhausted).toBe(false);
      expect(walk.stopDetail).toMatch(/load-shedding|no result/i);
      // The page was RETRIED before the walk gave up on it: a null is retry, never absent.
      expect(served).toBeGreaterThanOrEqual(3);
    }
  });

  it('still calls a genuinely empty page the end of the index', async () => {
    // The distinction the fix rests on: an empty ARRAY is a real end of index, an unresolved page
    // is not. Collapsing the two in either direction loses a real property of the walk.
    const fetchImpl = fakeRpc([[sig(2), sig(1)]], { s2: createTx(), s1: createTx() });
    const rpc = new SolanaRpcClient({ maxRequests: 20, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistory(rpc, DEV, {
      maxSignaturePages: 5,
      maxTransactions: 50,
      txBatchSize: 1,
    });
    expect(walk.stopReason).toBe('index-exhausted');
    expect(walk.covered.exhausted).toBe(true);
  });
});

describe('the merge compares only over the range it may compare over', () => {
  const WALLET2 = 'Wallet2Wallet2Wallet2Wallet2Wallet2Wallet21';

  it('does not invent a gap from creates found below the covered floor', () => {
    // A walk that abandons a page part-way proves launches older than `covered.fromMs`. Counting
    // one of those as "hidden" while its listing row counts as outside-window would manufacture an
    // under-count that is not there — and this measurement exists to size a bias, so a bias in the
    // measurement is the one defect it cannot have.
    const covered = { fromMs: T0, toMs: T0 + 10 * DAY, exhausted: false };
    const merged = mergeHistories({
      creates: [
        { mint: 'inside', bondingCurve: 'c1', creator: WALLET2, createdAtMs: T0 + DAY, signature: 's1' },
        { mint: 'below', bondingCurve: 'c2', creator: WALLET2, createdAtMs: T0 - DAY, signature: 's2' },
      ],
      wallet: WALLET2,
      curves: new Map(),
      listed: [
        { mint: 'inside', deployedAtMs: T0 + DAY, completed: false },
        { mint: 'below', deployedAtMs: T0 - DAY, completed: false },
      ],
      covered,
    });

    expect(merged.createdInWindow).toBe(1);
    expect(merged.listedInWindow).toBe(1);
    expect(merged.hiddenByOwnership).toBe(0);
    // Both are still real launches, proven by their create transactions.
    expect(merged.records).toHaveLength(2);
  });
});

describe('a walk that covered nothing is an EMPTY window, never an infinite one', () => {
  // The consumer half of the walk's `covered.fromMs` contract, and the one that was missing: the
  // producer was pinned to leave the floor un-advanced, and nothing asked what the merge then did
  // with it. Under the old encoding (`0`) it read as the epoch, so EVERY listed row was in-window,
  // `windowExact` relabelled every launch the walk had not personally seen as "acquired", and the
  // gate lost it from both sides of its fraction. Measured live 2026-08-02: a wallet reading
  // 30 launches / 20 bonded / 66.7% / gate-passed became 2 / 0 / 0.0% / gate-failed, with an
  // ordinary rationale and `gate-unmeasured` never firing. It hit 3 of 8 candidates, because a
  // 100-request per-candidate ceiling against 1,000-entry signature pages means stopping inside
  // page 1 is the NORMAL case for a busy deployer.
  const W4 = 'Wallet4Wallet4Wallet4Wallet4Wallet4Wallet41';
  const NOW = T0 + 120 * DAY;
  /** Thirty launches over ninety days; the walk proved exactly one before its ceiling bit. */
  const listed = Array.from({ length: 30 }, (_, i) => ({
    mint: `mint-${i}`,
    deployedAtMs: NOW - (i + 1) * 3 * DAY,
    completed: i % 3 === 0,
  }));
  const creates = [
    {
      mint: listed[0]!.mint,
      bondingCurve: 'curve-0',
      creator: W4,
      createdAtMs: listed[0]!.deployedAtMs,
      signature: 'sig-0',
    },
  ];

  it('carries the whole ownership listing over rather than deleting it as acquired', () => {
    const merged = mergeHistories({
      creates,
      wallet: W4,
      curves: new Map(),
      listed,
      // Exactly what `readCreatedHistory` returns when the request ceiling bites part-way through
      // its first signature page: a top, and no floor at all.
      covered: { fromMs: null, toMs: NOW, exhausted: false },
      unresolvedTransactions: 0,
    });

    // Nothing is inside an empty window, so nothing may be reclassified against it. This is the
    // assertion that fails on the pre-fix code, where all 30 rows counted as in-window and 29 of
    // them were dropped.
    expect(merged.listedInWindow).toBe(0);
    expect(merged.notCreatedByWallet).toBe(0);
    expect(merged.listedOutsideWindow).toBe(30);
    expect(merged.records).toHaveLength(30);
    // The reading falls back to the ownership listing — biased towards rejection and honest, which
    // is the README's stated behaviour for history the walk never reached.
    expect(measureCompletion(merged.records).tokens).toBe(30);
    expect(measureCompletion(merged.records).completed).toBe(10);
    // And the one create the walk did pay for is not counted twice, nor claimed as comparable
    // against a listing over a range the walk never covered.
    expect(merged.createdInWindow).toBe(0);
    expect(merged.hiddenByOwnership).toBe(0);
  });

  it('reads a floor at or before the epoch as "covered nothing" too', () => {
    // `0` is the encoding the walk used to return, and it is what a record or a caller written
    // against the old shape still carries. No Solana block time is at or before the epoch, so the
    // only thing `fromMs <= 0` can mean is "never advanced" — and reading it literally is the
    // defect, not a stricter version of it.
    const merged = mergeHistories({
      creates,
      wallet: W4,
      curves: new Map(),
      listed,
      covered: { fromMs: 0, toMs: NOW, exhausted: false },
      unresolvedTransactions: 0,
    });

    expect(merged.listedInWindow).toBe(0);
    expect(merged.notCreatedByWallet).toBe(0);
    expect(merged.records).toHaveLength(30);
  });

  it('still refuses to reclassify when the walk covered nothing AND left work unresolved', () => {
    // The unsafe branch was only ever reachable with `windowExact` true, which is why this defect
    // needed a load-shed-free run to fire. Both paths have to land in the same place.
    const merged = mergeHistories({
      creates,
      wallet: W4,
      curves: new Map(),
      listed,
      covered: { fromMs: null, toMs: NOW, exhausted: false },
      unresolvedTransactions: 4,
    });

    expect(merged.windowExact).toBe(false);
    expect(merged.listedInWindowCarried).toBe(0);
    expect(merged.records).toHaveLength(30);
  });
});

describe('the two gap counts are set differences, never a subtraction', () => {
  const W3 = 'Wallet3Wallet3Wallet3Wallet3Wallet3Wallet31';

  it('a launch on the window boundary cannot produce a negative under-count', () => {
    // The two sides are timestamped by different sources — a create's on-chain `blockTime` and a
    // listing row's `created_timestamp` — so one launch can be in-window on one side and out on
    // the other. Deriving `hiddenByOwnership` by subtracting the overlap out of a total would then
    // report a negative gap, i.e. a bias in the instrument built to measure a bias.
    const covered = { fromMs: T0, toMs: T0 + 10 * DAY, exhausted: false };
    const merged = mergeHistories({
      creates: [
        // Created one millisecond BELOW the floor; its listing row is one millisecond above it.
        { mint: 'edge', bondingCurve: 'c', creator: W3, createdAtMs: T0 - 1, signature: 's' },
      ],
      wallet: W3,
      curves: new Map(),
      listed: [{ mint: 'edge', deployedAtMs: T0 + 1, completed: false }],
      covered,
    });

    expect(merged.hiddenByOwnership).toBeGreaterThanOrEqual(0);
    expect(merged.notCreatedByWallet).toBeGreaterThanOrEqual(0);
    // And the launch is still counted exactly once, from its create transaction.
    expect(merged.records).toHaveLength(1);
  });

  it('never reports a launch it holds the create transaction for as acquired', () => {
    // Same clock mismatch, the other diagnostic. An abandoned page still PROVES the create, so a
    // mint below `covered.fromMs` whose listing row is dated inside the window is a launch this
    // wallet demonstrably made — calling it "acquired by somebody else" contradicts evidence in
    // hand, and it is the ownership surface's own timestamp doing the contradicting.
    const covered = { fromMs: T0, toMs: T0 + 10 * DAY, exhausted: false };
    const merged = mergeHistories({
      creates: [
        { mint: 'proven', bondingCurve: 'c', creator: W3, createdAtMs: T0 - DAY, signature: 's' },
      ],
      wallet: W3,
      curves: new Map([['proven', { complete: true, creator: W3 }]]),
      listed: [{ mint: 'proven', deployedAtMs: T0 + DAY, completed: true }],
      covered,
    });

    expect(merged.windowExact).toBe(true);
    expect(merged.notCreatedByWallet).toBe(0);
    expect(merged.listedInWindow).toBe(1);
    expect(merged.records).toHaveLength(1);
  });
});

describe('the walk keeps enough budget to classify what it found', () => {
  it('stops before it can no longer read the curves of the launches it found', async () => {
    // Spending the last request on one more creation buys a launch that must then be scored as
    // not-bonded, because its curve was never read. That deflates the completion rate the walk
    // exists to widen — a correction that makes the number worse is not a correction.
    const page = Array.from({ length: 20 }, (_, i) => ({
      signature: `s${i}`,
      blockTime: 1_700_000_000 + i,
      err: null,
    }));
    const tx = {
      blockTime: 1_700_000_000,
      meta: { err: null, logMessages: ['Program log: Instruction: CreateV2'] },
      transaction: {
        signatures: ['sig'],
        message: {
          accountKeys: [
            { pubkey: DEV, signer: true, writable: true },
            { pubkey: MINT, signer: true, writable: true },
          ],
          instructions: [{ programId: PUMP_PROGRAM_ID, accounts: [MINT, 'meta', CURVE, DEV] }],
        },
      },
    };

    let sawGetMultipleAccounts = false;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const one = Array.isArray(body) ? body[0] : body;
      if (one.method === 'getSignaturesForAddress') {
        return { ok: true, status: 200, json: async () => ({ id: 0, result: page }) };
      }
      if (one.method === 'getMultipleAccounts') {
        sawGetMultipleAccounts = true;
        return { ok: true, status: 200, json: async () => ({ id: 0, result: { value: [] } }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: one.id ?? 0, result: tx }) };
    }) as unknown as typeof fetch;

    const rpc = new SolanaRpcClient({ maxRequests: 6, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistory(rpc, DEV, {
      maxSignaturePages: 5,
      maxTransactions: 100,
      txBatchSize: 1,
    });

    expect(walk.stopReason).toBe('request-ceiling');
    expect(walk.creates.length).toBeGreaterThan(0);
    expect(sawGetMultipleAccounts, 'the curve read must still have been affordable').toBe(true);
  });
});

describe('the indexed creation walk is the same measurement under a credit ceiling', () => {
  /**
   * A fake `getTransactionsForAddress`, shaped from the real 2026-08-03 responses: a
   * `{ data, paginationToken }` result, `paginationToken: null` as the ONLY end-of-index signal,
   * and JSON-RPC errors arriving on HTTP 200.
   */
  function fakeIndexed(
    pages: { data: unknown[]; paginationToken: string | null }[],
    opts: { error?: { code: number; message: string }; nullResult?: boolean } = {},
  ) {
    const seen: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const one = Array.isArray(body) ? body[0] : body;
      if (one.method === 'getMultipleAccounts') {
        return { ok: true, status: 200, json: async () => ({ id: 0, result: { value: [] } }) };
      }
      seen.push(one.params[1]);
      if (opts.error !== undefined) {
        return { ok: true, status: 200, json: async () => ({ id: 0, error: opts.error }) };
      }
      if (opts.nullResult === true) return { ok: true, status: 200, json: async () => ({ id: 0, result: null }) };
      const token = one.params[1]?.paginationToken;
      const idx = token === undefined ? 0 : pages.findIndex((p) => p.paginationToken === token) + 1;
      const page = pages[idx] ?? { data: [], paginationToken: null };
      return { ok: true, status: 200, json: async () => ({ id: 0, result: page }) };
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  const BOUNDS = { maxPages: 50, pageLimit: 1000, maxTransactions: 50_000, maxCredits: 5_000 };

  it('asks for exactly the query the measurement was taken against', async () => {
    const { fetchImpl, seen } = fakeIndexed([{ data: [createTx()], paginationToken: null }]);
    const rpc = new SolanaRpcClient({ maxRequests: 50, maxCredits: 5_000, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    await readCreatedHistoryIndexed(rpc, DEV, BOUNDS);
    // Every one of these is load-bearing: `full` + `jsonParsed` is what makes the response
    // `getTransaction`-shaped so the parsers work unchanged, `status: succeeded` is the
    // server-side form of the err===null filter the keyless walk pays for client-side, and `asc`
    // is what makes a truncated window grow forwards from genesis.
    expect(seen[0]).toMatchObject({
      transactionDetails: 'full',
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0,
      sortOrder: 'asc',
      limit: 1000,
      filters: { status: 'succeeded' },
    });
    expect(seen[0]).not.toHaveProperty('paginationToken');
  });

  it('parses creates out of full-mode rows with the UNCHANGED parser', async () => {
    // The whole premise of the replacement: gTFA `full` returns getTransaction's own envelope, so
    // `parseCreateTransaction` is not adapted, forked or wrapped. Verified live on the `maxxing`
    // create transaction, where both routes agree field for field (CREATION-DERIVED.md §7).
    const { fetchImpl } = fakeIndexed([
      {
        data: [
          createTx({ blockTime: 1_700_000_100 }),
          createTx({ blockTime: 1_700_000_150, logs: ['Program log: Instruction: Buy'] }),
        ],
        paginationToken: 'p1',
      },
      { data: [createTx({ blockTime: 1_700_000_200 })], paginationToken: null },
    ]);
    const rpc = new SolanaRpcClient({ maxRequests: 50, maxCredits: 5_000, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistoryIndexed(rpc, DEV, BOUNDS);

    expect(walk.creates).toHaveLength(2);
    expect(walk.creates[0]?.creator).toBe(DEV);
    expect(walk.pages).toBe(2);
    expect(walk.transactionsInspected).toBe(3);
    expect(walk.stopReason).toBe('index-exhausted');
    expect(walk.covered.exhausted).toBe(true);
    // Ascending order, so the floor is genesis and the ceiling is the newest row seen.
    expect(walk.covered.fromMs).toBe(1_700_000_100_000);
    expect(walk.covered.toMs).toBe(1_700_000_200_000);
    // Structurally zero on this route — a page arrives whole or not at all — which is what lets
    // `mergeHistories` treat the covered window as exact.
    expect(walk.unresolvedTransactions).toBe(0);
  });

  it('proves exhaustion from the provider\'s own token, never from an empty page', async () => {
    // A page that is empty but still carries a token is NOT the end of the index. Reading it as one
    // is the exact failure the keyless walk's null-is-retry rule exists to prevent, arriving in a
    // different shape.
    const { fetchImpl } = fakeIndexed([
      { data: [], paginationToken: 'still-more' },
      { data: [createTx()], paginationToken: null },
    ]);
    const rpc = new SolanaRpcClient({ maxRequests: 50, maxCredits: 5_000, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistoryIndexed(rpc, DEV, BOUNDS);
    expect(walk.pages).toBe(2);
    expect(walk.creates).toHaveLength(1);
    expect(walk.stopReason).toBe('index-exhausted');
  });

  it('an error envelope stops the walk and is never read as an exhausted index', async () => {
    // Measured shape: HTTP 200 carrying {"error":{"code":-32603,"message":"Bad request: Invalid
    // pagination token"}}. A walk that read that as "nothing older exists" would record page 2 of
    // 200 as a wallet's whole history — a ceiling presented as a measurement.
    const { fetchImpl } = fakeIndexed([], { error: { code: -32603, message: 'Bad request: Invalid pagination token' } });
    const rpc = new SolanaRpcClient({ maxRequests: 50, maxCredits: 5_000, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistoryIndexed(rpc, DEV, BOUNDS);
    expect(walk.stopReason).toBe('upstream-error');
    expect(walk.covered.exhausted).toBe(false);
    expect(walk.covered.fromMs).toBeNull();
    expect(walk.stopDetail).toMatch(/considered answer/);
    expect(walk.stopDetail).toMatch(/NOT known to have ended/);
  });

  it('an absent result is load-shedding, and still not an exhausted index', async () => {
    const { fetchImpl } = fakeIndexed([], { nullResult: true });
    const rpc = new SolanaRpcClient({ maxRequests: 50, maxCredits: 5_000, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistoryIndexed(rpc, DEV, BOUNDS);
    expect(walk.stopReason).toBe('upstream-error');
    expect(walk.covered.exhausted).toBe(false);
    // NULL, not 0. `0` reads as "covered since the epoch", which deleted 29 of one wallet's 30
    // launches in a live run.
    expect(walk.covered.fromMs).toBeNull();
    expect(walk.stopDetail).toMatch(/load-shedding/);
  });

  it('bills what the provider bills, and never starts a page it cannot pay for', async () => {
    // 10 credits per 100 transactions returned, rounded up, 10 minimum — so a full page of 1,000
    // costs exactly 100 and a page of 7 costs 10.
    expect(creditsForTransactions(1000)).toBe(100);
    expect(creditsForTransactions(101)).toBe(20);
    expect(creditsForTransactions(7)).toBe(10);
    expect(creditsForTransactions(0)).toBe(10);

    const page = (token: string | null) => ({ data: Array.from({ length: 1000 }, () => ({})), paginationToken: token });
    const { fetchImpl } = fakeIndexed([page('a'), page('b'), page('c'), page(null)]);
    // 250 credits buys two whole pages (100 each) and refuses to start a third, because a page's
    // WORST case must fit before it is started — plus the curve pass's own reservation.
    const rpc = new SolanaRpcClient({ maxRequests: 50, maxCredits: 250, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistoryIndexed(rpc, DEV, { ...BOUNDS, maxCredits: 250 });

    expect(walk.stopReason).toBe('credit-ceiling');
    expect(walk.pages).toBe(2);
    expect(rpc.creditsSpent()).toBe(200);
    // THE CEILING IS EXACT, never overshot: that is the whole point of reserving a page's worst
    // case rather than checking after it arrives.
    expect(rpc.creditsSpent()).toBeLessThanOrEqual(250);
    expect(walk.covered.exhausted).toBe(false);
  });

  it('stops at the page cap and reports the window as a window', async () => {
    const page = (token: string | null) => ({ data: [createTx()], paginationToken: token });
    const { fetchImpl } = fakeIndexed([page('a'), page('b'), page('c'), page(null)]);
    const rpc = new SolanaRpcClient({ maxRequests: 50, maxCredits: 5_000, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistoryIndexed(rpc, DEV, { ...BOUNDS, maxPages: 2 });
    expect(walk.stopReason).toBe('page-cap');
    expect(walk.pages).toBe(2);
    expect(walk.covered.exhausted).toBe(false);
    // A create found IS a create, ceiling or no ceiling — the walk keeps what it paid for.
    expect(walk.creates).toHaveLength(2);
  });

  it('keeps budget to CLASSIFY what it found, exactly as the keyless walk does', async () => {
    // CREATION-DERIVED.md §4: a walk that spends its last unit finding one more creation has bought
    // a launch it must then score as not-bonded, deflating the very rate it was widening.
    let sawCurveRead = false;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const one = JSON.parse(String(init.body));
      if (one.method === 'getMultipleAccounts') {
        sawCurveRead = true;
        return { ok: true, status: 200, json: async () => ({ id: 0, result: { value: [] } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 0, result: { data: [createTx()], paginationToken: 'more' } }),
      };
    }) as unknown as typeof fetch;
    const rpc = new SolanaRpcClient({ maxRequests: 50, maxCredits: 120, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistoryIndexed(rpc, DEV, { ...BOUNDS, maxCredits: 120 });
    expect(walk.creates.length).toBeGreaterThan(0);
    expect(sawCurveRead, 'the curve read must still have been affordable').toBe(true);
  });

  it('a REFUSED CREDENTIAL propagates instead of becoming this wallet\'s reading', async () => {
    // The failure this forbids is silent and expensive. A revoked key 401s every candidate; if the
    // walk absorbed that into `stopReason: upstream-error`, all 195 candidates would fall back to
    // the ownership listing while the record still said `historySource: creation-derived`, and the
    // whole shared MadeOnSol daily allowance would be spent one profile at a time to learn nothing.
    // A refused credential is not a property of the wallet being screened, so it must not be able
    // to produce a per-candidate reading at all.
    const fetchImpl = vi.fn(
      async () => new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
    ) as unknown as typeof fetch;
    const rpc = new SolanaRpcClient({
      maxRequests: 50,
      maxCredits: 5_000,
      minIntervalMs: 0,
      backoffMs: 0,
      fetchImpl,
      sleepImpl: async () => {},
    });
    await expect(readCreatedHistoryIndexed(rpc, DEV, BOUNDS)).rejects.toThrow(RpcCredentialRejected);

    // And the same on the curve-classification pass, whose catch is otherwise deliberately silent:
    // absorbed there, a mid-walk revocation would score every launch it found as NOT bonded.
    let calls = 0;
    const failingCurves = vi.fn(async (_url: unknown, init: RequestInit) => {
      const one = JSON.parse(String(init.body));
      calls += 1;
      if (one.method === 'getMultipleAccounts') {
        return new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(JSON.stringify({ id: 0, result: { data: [createTx()], paginationToken: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const rpc2 = new SolanaRpcClient({
      maxRequests: 50,
      maxCredits: 5_000,
      minIntervalMs: 0,
      backoffMs: 0,
      fetchImpl: failingCurves,
      sleepImpl: async () => {},
    });
    await expect(readCreatedHistoryIndexed(rpc2, DEV, BOUNDS)).rejects.toThrow(RpcCredentialRejected);
    expect(calls).toBeGreaterThan(1);
  });

  it('the screen treats a refused RPC credential as TERMINAL, not as a candidate outcome', () => {
    // The other half of the fail-fast, and it is structural because the alternative — a live run
    // against a revoked key — is exactly what this must never cost. The walk is deliberately NOT
    // wrapped in the per-candidate guard the ownership listing has, so it reaches the outer catch;
    // that catch has to map it to `credentialRejected` rather than to the generic upstream code,
    // because the screen's standing rule is that a rejected credential is NOT a negative result.
    const source = readFileSync(join(TOOL_DIR, 'screen.mjs'), 'utf8');
    expect(source).toMatch(/import \{[^}]*RpcCredentialRejected/s);
    const outer = source.slice(source.indexOf('const code ='), source.indexOf('emit(code);'));
    expect(outer).toMatch(/cause instanceof RpcCredentialRejected\s*\?\s*EXIT\.credentialRejected/);
    // Non-zero, and distinct from every other terminal code so an operator can tell "rotate the
    // key" from "wait for the window" and from "the walk hit its ceiling".
    const exits = /const EXIT = \{([^}]*)\}/.exec(source)?.[1] ?? '';
    expect(Number(/credentialRejected: (\d+)/.exec(exits)?.[1])).toBeGreaterThan(0);
    // And the walk call itself must stay OUTSIDE a try that would swallow it back into a reading.
    const walkCall = source.slice(source.indexOf('const walk = usingIndexedWalk'), source.indexOf('rpcRequests += rpc.issued()'));
    expect(walkCall, 'the indexed walk must not be re-guarded per candidate').not.toMatch(/catch\s*[({]/);
  });

  it('feeds mergeHistories a window it can read, including the empty one', async () => {
    // The merge is the consumer that a covered-window bug actually hurts, so the two are checked
    // together rather than the walk's fields being checked in isolation.
    const { fetchImpl } = fakeIndexed([], { nullResult: true });
    const rpc = new SolanaRpcClient({ maxRequests: 50, maxCredits: 5_000, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreatedHistoryIndexed(rpc, DEV, BOUNDS);
    const merged = mergeHistories({
      creates: walk.creates,
      wallet: DEV,
      curves: walk.curves,
      listed: [{ mint: 'm1', deployedAtMs: 1_700_000_000_000, completed: true }],
      covered: walk.covered,
      unresolvedTransactions: walk.unresolvedTransactions,
    });
    // An EMPTY window is the degenerate case of "outside", so the whole reading falls back to the
    // ownership listing rather than relabelling its rows "acquired".
    expect(merged.listedOutsideWindow).toBe(1);
    expect(merged.notCreatedByWallet).toBe(0);
    expect(merged.records).toHaveLength(1);
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
  minFieldHitRateNet: 0.5,
  maxEntryCostPerSolStaked: 0.12,
  minPricedFraction: 0.8,
};

// Read from the pinned file rather than restated, so a test can never quietly disagree with the
// parameter a real run uses.
const WINDOW_SLOT_SPAN = loadThresholds()['stage2_entry'].windowSlotSpan as number;
const SEEK_MARGIN_MS = loadThresholds()['stage2_entry'].seekMarginMs as number;

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

  it('EVERY P&L field names which side of fees it is on, so a caller cannot forget', () => {
    // Two suffixes and no third: `GrossOfFees` for anything computed from the fill tape alone, and
    // `NetOfMeasuredFees` for anything the on-chain cost leg corrected. An unsuffixed P&L field
    // would be a number whose fee treatment a reader has to guess, which is the whole failure this
    // naming rule exists to prevent.
    const e = measureLaunchEntry(openingWindow())!;
    const pnlish = Object.keys(e.field[0]!).filter((k) => /realised|return|pnl|profit/i.test(k));
    expect(pnlish.length).toBeGreaterThan(0);
    for (const k of pnlish) {
      expect(k, `${k} does not disclose which side of fees it is on`).toMatch(
        /(GrossOfFees|NetOfMeasuredFees)$/,
      );
    }

    const score = scoreEntry([e], ENTRY_T);
    for (const k of Object.keys(score).filter((k) => /realised|return|pnl|profit/i.test(k))) {
      expect(k).toMatch(/(GrossOfFees|NetOfMeasuredFees)$/);
    }
    // The field's hit rate is a P&L statement too, so it carries the same disclosure, on both
    // sides. `roomHitRate` deliberately does not: it is a share of launches leaving room, which
    // fees cannot touch.
    expect(Object.keys(score)).toContain('fieldHitRateGrossOfFees');
    expect(Object.keys(score)).toContain('fieldHitRateNetOfMeasuredFees');
    expect(Object.keys(score)).toContain('roomHitRate');
    // And the net figures are BESIDE the gross ones, never instead of them.
    expect(Object.keys(score)).toContain('fieldRealisedSolGrossOfFees');
    expect(Object.keys(score)).toContain('fieldRealisedSolNetOfMeasuredFees');
  });

  it('an OPEN position has no complete P&L and is counted, never marked to a price', () => {
    // The dataset's trap #2, on the live path: only closed pairs have a complete P&L, and an open
    // one contributes nothing to the distribution rather than a paper number.
    const fills = [
      // Bundled, so `scoreEntry` scores the launch at all — the open-position rule is what is
      // under test here, not the unproven-opening refusal.
      fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 6, tokens: 600 }),
      fill({ slot: 100, tx: 'devtx', wallet: 'devbook', sol: 4, tokens: 400 }),
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
   * `roomLeft` is (independent SOL) / (operation + independent), so an operation stake of
   * `10 * (1/room - 1)` against 10 SOL of outsider capital lands on the room asked for.
   *
   * **The operation's stake is split across a bundled transaction by default, and that is
   * load-bearing rather than incidental.** A create slot in which nothing is bundled gives the
   * co-ordination rule nothing to find, and `scoreEntry` refuses to score such a launch at all
   * (`measure.mjs` → `roomIsProven`, captain decision 134a). So the default fixture has the dev
   * share `devtx` with one of its own wallets — one bundled transaction, two wallets, the same
   * room figure — and `bundled: false` builds the unproven shape on purpose.
   */
  const windowFills = (room: number, outcomes: number[], bundled = true) => {
    const operationSol = 10 * (1 / room - 1);
    // Splitting the operation's stake across two wallets IN ONE TRANSACTION leaves every room
    // number identical: both halves land in the numerator either way, one as `devSol` and one as
    // `coordinatedSol`. Only `bundledTx` and `maxWalletsInOneTx` move.
    const fills = bundled
      ? [
          fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: operationSol * 0.6, tokens: 6e5 }),
          fill({ slot: 100, tx: 'devtx', wallet: 'devbook', sol: operationSol * 0.4, tokens: 4e5 }),
        ]
      : [fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: operationSol, tokens: 1e6 })];
    outcomes.forEach((realised, i) => {
      const stake = 10 / outcomes.length;
      fills.push(fill({ slot: 100, tx: `o${i}`, wallet: `w${i}`, sol: stake, tokens: 1000 }));
      fills.push(
        fill({ slot: 140, tx: `s${i}`, wallet: `w${i}`, sol: stake + realised, tokens: 1000, side: 'sell' }),
      );
    });
    return fills;
  };

  const launch = (room: number, outcomes: number[], bundled = true) =>
    measureLaunchEntry(windowFills(room, outcomes, bundled))!;

  /**
   * The same launch with its on-chain costs attached, synthesised so `costPerTx` SOL left every
   * entrant's wallet over and above the swap quote in every transaction it made.
   *
   * Built through the REAL pair — `entryCostTargets` names the transactions and `priceLaunchEntry`
   * attaches what came back — so a fixture cannot drift from the production path. Only the RPC
   * response is synthetic, and it is synthetic in exactly the shape `parseTransactionCosts` returns.
   */
  const pricedLaunch = (room: number, outcomes: number[], costPerTx: number, bundled = true) => {
    const fills = windowFills(room, outcomes, bundled);
    const entry = measureLaunchEntry(fills)!;
    const targets = entryCostTargets(fills, entry);
    const priced = new Map(
      targets.map((t) => [
        t.tx,
        {
          signature: t.tx,
          feeSol: costPerTx / 2,
          feePayer: t.wallets[0]!.wallet,
          solOutByWallet: new Map(t.wallets.map((w) => [w.wallet, w.quotedSol + costPerTx])),
        },
      ]),
    );
    return priceLaunchEntry(entry, targets, priced);
  };

  const many = (n: number, room: number, outcomes: number[]) =>
    Array.from({ length: n }, () => launch(room, outcomes));

  const manyPriced = (n: number, room: number, outcomes: number[], costPerTx = 0.01) =>
    Array.from({ length: n }, () => pricedLaunch(room, outcomes, costPerTx));

  const manyUnbundled = (n: number, room: number, outcomes: number[]) =>
    Array.from({ length: n }, () => launch(room, outcomes, false));

  it('says entry-open-after-costs only when ALL THREE legs allow it', () => {
    const s = scoreEntry(manyPriced(8, 0.7, [1, 1, -0.2]), ENTRY_T);
    expect(s.verdict).toBe('entry-open-after-costs');
    expect(s.roomLeft.median).toBeCloseTo(0.7, 6);
    expect(s.fieldHitRateGrossOfFees.rate).toBeCloseTo(2 / 3, 6);
    // The seat was priced and the field still clears after paying for it. Both are asserted,
    // because the verdict now rests on both.
    expect(s.entryCostPriced.rate).toBe(1);
    expect(s.fieldHitRateNetOfMeasuredFees.rate).toBeCloseTo(2 / 3, 6);
    expect(s.fieldRealisedSolNetOfMeasuredFees.median).toBeLessThan(s.fieldRealisedSolGrossOfFees.median);
  });

  it('THE RULING, AS ONE ASSERTION: the identical launches UNPRICED cannot earn that verdict', () => {
    // Captain's standing ruling, 2026-08-02: fees are part of the entry window, and "enterable"
    // means enterable AFTER what it costs to enter. So room plus a gross-positive field — which is
    // exactly what earned `entry-room-present` before this change — is now the ABSENCE of a
    // finding, not a weaker one. This is the same fixture as the test above with the cost leg
    // removed, so nothing but the pricing differs.
    const s = scoreEntry(many(8, 0.7, [1, 1, -0.2]), ENTRY_T);
    expect(s.verdict).toBe('entry-cost-unmeasured');
    expect(s.entryCostPriced.hits).toBe(0);
    expect(s.entryCostSol.n).toBe(0);
    expect(s.rationale).toMatch(/ruling of 2026-08-02/);
    expect(s.rationale).toMatch(/NOT a finding that the window is enterable/);
    // And it must not read as free. A caveat says so on the score itself.
    expect(s.caveats.join(' ')).toMatch(/NO ENTRY COST WAS MEASURED/);
    expect(s.caveats.join(' ')).toMatch(/not a finding that entry was cheap/);
  });

  it('a seat priced above the bar is prohibitive, however healthy the field looks gross', () => {
    // Cost per SOL staked is the price of the seat against the seat. Each outsider stakes 10/3 SOL
    // in the create slot, so a 0.5 SOL create-slot cost is 0.15 per SOL staked, above the 0.12 bar.
    const s = scoreEntry(manyPriced(8, 0.7, [1, 1, -0.2], 0.5), ENTRY_T);
    expect(s.entryCostPerSolStaked.median).toBeGreaterThan(ENTRY_T.maxEntryCostPerSolStaked);
    expect(s.verdict).toBe('entry-cost-prohibitive');
    expect(s.rationale).toMatch(/consumes the opening/);
    // The limit travels with the figure, on the verdict's own sentence.
    expect(s.rationale).toMatch(/LANDING TIP PAID IN A SEPARATE TRANSACTION/);
  });

  it('the cost bar is compared PER LAUNCH, so a busy launch cannot outvote the rest', () => {
    // Captain decision 140a. Five launches with ONE priced entrant apiece at 0.20 per SOL staked,
    // against three launches with TEN cheap entrants apiece at 0.02. Pooled over entries that is
    // 5 expensive against 30 cheap and the median reads 0.02 — comfortably under the bar. Taken one
    // figure per launch, which is the unit the bar is anchored on, the median is 0.20 and the seat
    // is prohibitive. Pooling is exactly the failure: entrant counts vary by an order of magnitude
    // between launches, so a pooled median describes whichever launch was busiest.
    const expensive = Array.from({ length: 5 }, () => pricedLaunch(0.7, [1], 2));
    const cheap = Array.from({ length: 3 }, () =>
      pricedLaunch(0.7, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 0.02),
    );
    const s = scoreEntry([...expensive, ...cheap], ENTRY_T);

    expect(s.entryCostPerSolStaked.n).toBe(35);
    expect(s.entryCostPerSolStaked.median).toBeLessThan(ENTRY_T.maxEntryCostPerSolStaked);
    expect(s.entryCostPerSolStakedByLaunch.n).toBe(8);
    expect(s.entryCostPerSolStakedByLaunch.median).toBeGreaterThanOrEqual(
      ENTRY_T.maxEntryCostPerSolStaked,
    );
    expect(s.verdict).toBe('entry-cost-prohibitive');
    // And the sentence must name the unit, so a reader of a saved rationale cannot mistake which
    // figure was gated.
    expect(s.rationale).toMatch(/PER LAUNCH/);
  });

  it('a field that only loses money AFTER costs is vetoed — the leg gross could not see', () => {
    // Gross this field is 3/3 positive at a median +0.05 SOL, which the gross bar waves through.
    // Each entrant makes two transactions and pays 0.04 SOL over the quote in each, so net of
    // measured fees every round trip is −0.03 and the veto fires. This is the whole of decision
    // 136b in one fixture: without it the run would report the gross reading and stop.
    const s = scoreEntry(manyPriced(8, 0.7, [0.05, 0.05, 0.05], 0.04), ENTRY_T);
    expect(s.fieldHitRateGrossOfFees.rate).toBe(1);
    expect(s.fieldRealisedSolGrossOfFees.median).toBeCloseTo(0.05, 6);
    expect(s.fieldHitRateNetOfMeasuredFees.rate).toBe(0);
    expect(s.fieldRealisedSolNetOfMeasuredFees.median).toBeCloseTo(-0.03, 6);
    expect(s.verdict).toBe('entry-field-loss-making');
    expect(s.rationale).toMatch(/NET OF MEASURED FEES/);
    expect(s.rationale).toMatch(/the leg the gross reading cannot see/i);
  });

  it('partial pricing is never a pass — the coverage floor is a gate, not a discount', () => {
    // Six launches priced, two not. 18 of 24 entries have a cost, which is 0.75 against the pinned
    // 0.8 floor. A run that scored the priced six and called the window enterable would be
    // reporting a distribution over the launches it happened to reach first.
    const s = scoreEntry([...manyPriced(6, 0.7, [1, 1, -0.2]), ...many(2, 0.7, [1, 1, -0.2])], ENTRY_T);
    expect(s.entryCostPriced.hits).toBe(18);
    expect(s.entryCostPriced.n).toBe(24);
    expect(s.verdict).toBe('entry-cost-unmeasured');
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
    const s = scoreEntry(manyPriced(8, 0.7, [1, 1, -0.2]), ENTRY_T);
    const numericFields = Object.entries(s).filter(([, v]) => typeof v === 'number' || (v && typeof v === 'object'));
    for (const [k] of numericFields) {
      expect(k, `${k} sounds like an exit measurement leaking into the entry score`).not.toMatch(
        /exit|dump|rug|ladder|sellPressure|trap/i,
      );
    }
    // And the caveats must say the omission out loud on every score, not only the negative ones.
    expect(s.caveats.join(' ')).toMatch(/ENTRY ONLY/);
    expect(s.caveats.join(' ')).toMatch(/UPPER BOUND/);
    expect(s.rationale).toMatch(/Exit feasibility is unmeasured/i);
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

  // -------------------------------------------------------------------------------------------
  // THE UNPROVEN OPENING. A create slot carrying no bundled transaction is observationally
  // identical to a create slot with no co-ordination: the rule found nothing either way. Reading
  // it as the second books the operation's own stake as outsider capital and INFLATES room, which
  // is the one direction the captain has ruled unacceptable (decision 134a). On the committed tape
  // that reading flipped 24 of 228 rolling windows, all 24 towards ENTRY-ROOM-PRESENT.
  //
  // These fixtures are the smallest possible statement of it: the SAME room figure, the SAME field,
  // differing only in whether the operation shared a transaction.

  it('THE UNBUNDLED CREATE SLOT: ample room and a healthy field still cannot earn a verdict', () => {
    // The defect, stated as a test. Every launch here reads roomLeft 0.7 with a field that clears
    // both bars — and every one of them is a launch on which the co-ordination rule recovered
    // nothing at all, so the room figure may be the operation's own stake counted as ours to take.
    const s = scoreEntry(manyUnbundled(8, 0.7, [1, 1, -0.2]), ENTRY_T);
    expect(s.verdict).toBe('entry-unmeasured');
    expect(s.verdict).not.toBe('entry-open-after-costs');
    // Not scored, not refused: NOTHING about these launches reaches a distribution.
    expect(s.launchesSampled).toBe(0);
    expect(s.launchesRoomUnproven).toBe(8);
    expect(s.roomLeft.median).toBeNaN();
    expect(s.fieldClosedRoundTrips).toBe(0);
    // And it must read as an absence of evidence rather than as a finding about the deployer.
    expect(s.rationale).toMatch(/UNPROVEN, not closed and not open/);
    expect(s.rationale).toMatch(/no answer about this wallet/);
  });

  it('the identical launches, bundled and priced, DO earn one — so the refusal is the bundling', () => {
    // The control for the test above. If this failed, the fixture would be proving something else.
    const s = scoreEntry(manyPriced(8, 0.7, [1, 1, -0.2]), ENTRY_T);
    expect(s.verdict).toBe('entry-open-after-costs');
    expect(s.roomLeft.median).toBeCloseTo(0.7, 6);
    expect(s.launchesRoomUnproven).toBe(0);
  });

  it('scores the proven half and refuses the rest — never a blend of the two', () => {
    const s = scoreEntry([...many(8, 0.2, [1, 1, -0.2]), ...manyUnbundled(8, 0.9, [1, 1, -0.2])], ENTRY_T);
    // The unproven launches are the roomy ones. A score that let them in would read 0.55+ and pass;
    // the honest reading is the 0.2 the proven half actually shows.
    expect(s.launchesSampled).toBe(8);
    expect(s.launchesRoomUnproven).toBe(8);
    expect(s.roomLeft.median).toBeCloseTo(0.2, 6);
    expect(s.roomLeft.p90).toBeCloseTo(0.2, 6);
    expect(s.verdict).toBe('entry-room-absent');
    // Every count that describes the scored population is over the scored population.
    expect(s.roomHitRate.n).toBe(8);
    expect(s.outsidersPerLaunch.n).toBe(8);
  });

  it('says out loud how many launches it refused, and why, on every score that has one', () => {
    const s = scoreEntry([...manyPriced(8, 0.7, [1, 1, -0.2]), ...manyUnbundled(3, 0.7, [1, 1, -0.2])], ENTRY_T);
    expect(s.verdict).toBe('entry-open-after-costs');
    expect(s.launchesRoomUnproven).toBe(3);
    const caveats = s.caveats.join(' ');
    expect(caveats).toMatch(/3 of 11 measured launch\(es\) had NO bundled transaction/);
    expect(caveats).toMatch(/UNPROVEN rather than open/);
    // The direction of the error it prevents is named, because that is what makes the refusal
    // legible as a safety property rather than as fussiness.
    expect(caveats).toMatch(/inflate room/);
    expect(caveats).toMatch(/134a/);
  });

  it('bundledTx and maxWalletsInOneTx span EVERY launch handed in, refused ones included', () => {
    // The audit trail. A distribution taken over the scored half could never contain a zero, and a
    // zero is exactly what an auditor reading a saved run is looking for. These two were computed
    // and thrown away before this change, which is why no committed record can be checked for it.
    const s = scoreEntry([...many(6, 0.7, [1, 1, -0.2]), ...manyUnbundled(6, 0.7, [1, 1, -0.2])], ENTRY_T);
    expect(s.bundledTx.n).toBe(12);
    expect(s.maxWalletsInOneTx.n).toBe(12);
    expect(s.bundledTx.min).toBe(0);
    expect(s.bundledTx.max).toBe(1);
    expect(s.maxWalletsInOneTx.min).toBe(1);
    expect(s.maxWalletsInOneTx.max).toBe(2);
    // And they are not an exit measurement smuggled in under a new name.
    expect(Object.keys(s)).toContain('launchesRoomUnproven');
  });

  it('roomIsProven is the floor of the evidence, not a threshold on its quality', () => {
    // One bundled transaction is the minimum evidence that the rule could see anything at all. It
    // does NOT mean recovery was complete — on the committed tape a bundled launch still misses
    // cohort wallets that bought alone — so a proven room figure stays an upper bound.
    expect(roomIsProven({ bundledTx: 0 })).toBe(false);
    expect(roomIsProven({ bundledTx: 1 })).toBe(true);
    expect(roomIsProven({ bundledTx: 7 })).toBe(true);
  });

  it('a refused launch is NOT a dropped one — the two say different things and are counted apart', () => {
    // A drop means the walk never saw the opening. A refusal means the walk saw it perfectly well
    // and the co-ordination rule found nothing in it. Collapsing them would hide which failed.
    const s = scoreEntry(manyUnbundled(8, 0.7, [1, 1]), ENTRY_T, { launchesDropped: 2 });
    expect(s.launchesRoomUnproven).toBe(8);
    const caveats = s.caveats.join(' ');
    expect(caveats).toMatch(/2 launch window\(s\) could not be walked back to the mint/);
    expect(caveats).toMatch(/8 of 8 measured launch\(es\) had NO bundled transaction/);
    expect(s.rationale).toMatch(/2 window\(s\) were dropped/);
    expect(s.rationale).toMatch(/8 further window\(s\) were measured but NOT SCORED/);
  });
});

describe('the rolling replay — the control that would have caught the unproven opening', () => {
  const T = { minRoomLeft: 0.55, minLaunchesSampled: 8, maxLaunchesPerCandidate: 8 };

  /**
   * A taped launch as `replayRollingRoom` reads one: what the STRUCTURAL rule measured, and what
   * the NAMED cohort says the truth was. On a stranger the second does not exist, which is the
   * whole reason the first is what a live run computes.
   */
  const taped = (i: number, screenRoom: number, truthRoom: number, bundledTx: number) => ({
    mint: `m${i}`,
    dateIso: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    createSlot: { roomLeft: screenRoom, bundledTx } as never,
    field: [],
    // The replay reads room and nothing else, so a window tape it never opens is empty here.
    fills: [],
    cohortRoomLeft: truthRoom,
  });

  it('fails on a window the screen calls enterable that the named cohort says was not', () => {
    // The exact shape of the 24 real ones: the rule found nothing (bundledTx 0), so the operation's
    // own stake landed in the outsider half and room read 0.65 where the truth was 0.24.
    const launches = Array.from({ length: 8 }, (_, i) => taped(i, 0.65, 0.24, 1));
    const r = replayRollingRoom(launches, T);
    expect(r.windows).toBe(1);
    expect(r.falsePositives).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.falsePositiveWindows[0]!.screenRoomMedian).toBeCloseTo(0.65, 6);
    expect(r.falsePositiveWindows[0]!.truthRoomMedian).toBeCloseTo(0.24, 6);
  });

  it('does NOT fail on a false negative — refusing to score is the ruling, not a defect', () => {
    // The screen sees no room, the named cohort says there was. That costs coverage on purpose.
    const launches = Array.from({ length: 8 }, (_, i) => taped(i, 0.2, 0.8, 1));
    const r = replayRollingRoom(launches, T);
    expect(r.falseNegatives).toBe(1);
    expect(r.falsePositives).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('an unmeasured window is never a false positive, however roomy its refused launches looked', () => {
    // The defect's own fingerprint: every launch unbundled and apparently wide open, against a
    // truth of nothing. Under decision 134a the window reports UNMEASURED and cannot flip.
    const launches = Array.from({ length: 8 }, (_, i) => taped(i, 0.9, 0.1, 0));
    const r = replayRollingRoom(launches, T);
    expect(r.unmeasured).toBe(1);
    expect(r.present).toBe(0);
    expect(r.falsePositives).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('takes the window truth over ALL its launches, not over the subset it agreed to score', () => {
    // Otherwise the answer key would inherit the screen's own blind spot, and the control would
    // grade the screen against itself.
    const launches = [
      ...Array.from({ length: 4 }, (_, i) => taped(i, 0.9, 0.9, 1)),
      ...Array.from({ length: 4 }, (_, i) => taped(i + 4, 0.9, 0.1, 0)),
    ];
    const r = replayRollingRoom(launches, { ...T, minLaunchesSampled: 4 });
    // Truth over all eight straddles the bar at 0.5 and reads ABSENT; over the four scored ones it
    // would have read 0.9 and agreed with the screen.
    expect(r.falsePositives).toBe(1);
    expect(r.falsePositiveWindows[0]!.truthRoomMedian).toBeCloseTo(0.5, 6);
    expect(r.falsePositiveWindows[0]!.scored).toBe(4);
  });

  it('evaluates one window per position and none at all below the trailing count', () => {
    expect(replayRollingRoom(Array.from({ length: 7 }, (_, i) => taped(i, 0.9, 0.9, 1)), T).windows).toBe(0);
    expect(replayRollingRoom(Array.from({ length: 20 }, (_, i) => taped(i, 0.9, 0.9, 1)), T).windows).toBe(13);
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

  /**
   * Slots at the chain's own ~400ms cadence, because the measured window is anchored on the SLOT of
   * the earliest curve buy and not on the vendor's wall clock. `slotIndexId`'s first 12 digits are
   * the slot; the remainder orders fills inside it.
   */
  const SLOT0 = 400_000_000;
  const sidAt = (ms: number, seq: number) =>
    String(SLOT0 + Math.floor((ms - CREATED) / 400)).padStart(12, '0') + String(seq).padStart(10, '0');

  const row = (o: { ms: number; wallet: string; sol: number; sid?: string; seq?: number; tx?: string; type?: string }) => {
    const sid = o.sid ?? sidAt(o.ms, o.seq ?? 1);
    return {
      slotIndexId: sid,
      tx: o.tx ?? `tx-${sid}`,
      timestamp: new Date(o.ms).toISOString(),
      userAddress: o.wallet,
      type: o.type ?? 'buy',
      program: 'pump',
      amountSol: String(o.sol),
      baseAmount: '1000',
      priceSol: '0.0000001',
    };
  };

  /** The pre-mint history a real token does not have, used to prove the walk stops on time. */
  const history = () => [
    row({ ms: CREATED, wallet: 'dev', sol: 10, seq: 1 }),
    row({ ms: CREATED + 1000, wallet: 'outsider', sol: 2, seq: 2 }),
    row({ ms: CREATED + 30_000, wallet: 'outsider', sol: 5, seq: 3, type: 'sell' }),
    // Outside the window, and therefore not part of the opening at all.
    row({ ms: CREATED + 120_000, wallet: 'latecomer', sol: 9, seq: 9 }),
  ];

  const client = (fetchImpl: typeof fetch, maxRequests = 10) =>
    new KeylessClient({ maxRequests, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });

  it('seeks straight to the window end by timestamp and walks back to the mint', async () => {
    const { fetchImpl, calls } = fakeEndpoint(history());
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED,
      windowMs: 60_000,
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
      pageLimit: 100,
    });
    expect(w.usable).toBe(true);
    expect(w.reachedCreateSlot).toBe(true);
    // The FIRST request already carries the cursor. That seek is what makes this affordable: it
    // turns walking a token's whole history into a handful of requests.
    expect(calls[0]).toContain(`cursor=0-${CREATED + 60_000 + SEEK_MARGIN_MS}`);
    expect(w.fills.map((f) => f.wallet).sort()).toEqual(['dev', 'outsider', 'outsider']);
    expect(w.dropReason).toBeNull();
    expect(w.mintTimeDisagreement).toBe(false);
    const e = measureLaunchEntry(w.fills)!;
    expect(e.createSlot.deployer).toBe('dev');
  });

  it('anchors the measured window on the earliest curve buy SLOT, not on the vendor clock', async () => {
    // A row inside the timestamp window but hundreds of slots past the create slot. Slots are the
    // chain's own monotonic sequence; the vendor's wall clock is a second opinion we cannot
    // reconcile, so membership is decided by the first one and never by the second.
    const wayLater = row({ ms: CREATED + 59_000, wallet: 'latecomer', sol: 9, sid: '000400000900' + '0000000001' });
    const { fetchImpl } = fakeEndpoint([...history(), wayLater]);
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED,
      windowMs: 60_000,
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
      pageLimit: 100,
    });
    expect(w.usable).toBe(true);
    expect(w.fills.map((f) => f.wallet)).not.toContain('latecomer');
  });

  it('seeks past the nominal window end, so an EARLY vendor mint time cannot truncate the tail', async () => {
    // Negative skew: the vendor's creation time precedes the truth, so a seek from exactly
    // createdAtMs + windowMs would start early and never fetch the end of the window. That trips no
    // tripwire — there are no pre-mint rows — so the margin has to design the failure out rather
    // than detect it. A detector could not have discriminated anyway: launches routinely stop
    // trading before the nominal end, so it would have fired on nearly all of them.
    const skewMs = 4_000; // inside the pinned 5s margin
    const { fetchImpl, calls } = fakeEndpoint([
      ...history(),
      row({ ms: CREATED + 58_000, wallet: 'lateseller', sol: 3, seq: 4, type: 'sell' }),
    ]);
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED - skewMs,
      windowMs: 60_000,
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
      pageLimit: 100,
    });
    expect(calls[0]).toContain(`cursor=0-${CREATED - skewMs + 60_000 + SEEK_MARGIN_MS}`);
    expect(w.usable).toBe(true);
    // The late sell is the fill that matters: dropping one flips a wallet from closed to open and
    // shrinks fieldClosedRoundTrips, which is itself a gate.
    expect(w.fills.map((f) => f.wallet)).toContain('lateseller');
    expect(measureLaunchEntry(w.fills)!.createSlot.deployer).toBe('dev');
  });

  it('the seek margin is a CURSOR HINT and never a tolerance on the pre-mint tripwire', async () => {
    // The two mechanisms sit next to each other and must not be mistaken for one. A row one
    // millisecond older than the recorded mint is still a hard drop, however wide the margin is.
    const { fetchImpl } = fakeEndpoint(history());
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED + 1,
      windowMs: 60_000,
      seekMarginMs: 600_000,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
      pageLimit: 100,
    });
    expect(w.dropReason).toBe('mint-time-disagreement');
    expect(w.usable).toBe(false);
  });

  it('measures a 160-SLOT window, not ceil(windowMs / 400) = 150', async () => {
    // Measured on the 210 committed 60-second launches: observed slot span p50 151, p90 155, max
    // 158, with 51% holding a fill beyond createSlot + 150. Those trailing fills are
    // disproportionately late sells, so a 150-slot span silently moves closure verdicts.
    const at155 = row({ ms: CREATED + 59_000, wallet: 'tail155', sol: 1, sid: String(SLOT0 + 155).padStart(12, '0') + '0000000001' });
    const at161 = row({ ms: CREATED + 59_500, wallet: 'tail161', sol: 1, sid: String(SLOT0 + 161).padStart(12, '0') + '0000000001' });
    const { fetchImpl } = fakeEndpoint([...history(), at155, at161]);
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED,
      windowMs: 60_000,
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
      pageLimit: 100,
    });
    expect(w.fills.map((f) => f.wallet)).toContain('tail155');
    expect(w.fills.map((f) => f.wallet)).not.toContain('tail161');
  });

  it('DROPS a launch whose fills predate the recorded mint — the two clocks disagree', async () => {
    // On the committed tape the gap between the vendor's creation time and the first fill is exactly
    // 0 on all 235 covered launches, so this branch is dead code on correct data and fires ONLY when
    // the clocks come apart. Continuing past the row would delete the create slot — whose rows share
    // the mint's exact millisecond — and leave the walk anchored on a mid-window sniper.
    const { fetchImpl } = fakeEndpoint(history());
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED + 1, // one millisecond of positive skew is enough
      windowMs: 60_000,
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
      pageLimit: 100,
    });
    expect(w.mintTimeDisagreement).toBe(true);
    expect(w.usable).toBe(false);
    expect(w.dropReason).toBe('mint-time-disagreement');
    expect(w.reachedCreateSlot).toBe(false);
    expect(w.fills).toEqual([]);
    expect(w.note).toMatch(/REPORTABLE EVENT/);
  });

  it('refuses to read a MISSING pagination object as proof that nothing older exists', async () => {
    // The subtlest failure in the module: a bare array and the data/items/results wrappers carry no
    // pagination at all, and reading the absent `hasMore` as `false` would stop the walk after page
    // one and mark a partial window usable.
    for (const body of [
      [row({ ms: CREATED + 30_000, wallet: 'sniper', sol: 1, seq: 1 })],
      { data: [row({ ms: CREATED + 30_000, wallet: 'sniper', sol: 1, seq: 1 })] },
      { trades: [row({ ms: CREATED + 30_000, wallet: 'sniper', sol: 1, seq: 1 })], pagination: { nextCursor: 'x' } },
    ]) {
      const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
      const w = await readLaunchWindow(client(fetchImpl), {
        mint: MINT,
        createdAtMs: CREATED,
        windowMs: 60_000,
        seekMarginMs: SEEK_MARGIN_MS,
        windowSlotSpan: WINDOW_SLOT_SPAN,
        maxRequests: 50,
        pageLimit: 100,
      });
      expect(w.usable).toBe(false);
      expect(w.dropReason).toBe('coverage-unproven');
      expect(w.reachedCreateSlot).toBe(false);
      expect(w.note).toMatch(/UNPROVEN/);
      // One page, then a drop: an unprovable walk is not worth more requests.
      expect(w.pages).toBe(1);
    }
  });

  it('refuses to read an UNRECOGNISED body as proof either, on any page', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            trades: [row({ ms: CREATED + 30_000, wallet: 'sniper', sol: 1, seq: 1 })],
            pagination: { hasMore: true, nextCursor: `0-${CREATED + 20_000}` },
          }),
        };
      }
      // Page 2 is a shape we do not understand. `extractTradeRows` would hand back `[]`, and an
      // empty list used to mean "nothing older exists" — so a partial window would have been marked
      // usable by a response we could not even read.
      return { ok: true, status: 200, json: async () => ({ unexpected: 'shape' }) };
    }) as unknown as typeof fetch;

    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED,
      windowMs: 60_000,
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
      pageLimit: 100,
    });
    expect(w.usable).toBe(false);
    expect(w.dropReason).toBe('unrecognised-body');
    expect(w.reachedCreateSlot).toBe(false);
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
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 3,
      pageLimit: 1,
    });
    expect(w.hitRequestCap).toBe(true);
    expect(w.reachedCreateSlot).toBe(false);
    expect(w.usable).toBe(false);
    expect(w.dropReason).toBe('request-cap');
    expect(w.note).toMatch(/DROPPED/);
    expect(w.note).toMatch(/NOT the create slot/);
    // One page, then a stop: the walk reserves the WHOLE cost of a page (one attempt plus two
    // backoffs) before starting it, so a 3-request cap can only afford one page.
    expect(w.pages).toBe(1);
    expect(w.requests).toBeLessThanOrEqual(3);
  });

  it('DROPS a window whose cursor stops advancing, and says so specifically', async () => {
    // A stalled cursor would otherwise burn the whole page cap and then be misdiagnosed as a
    // busy launch, which is the wrong thing to go and look at.
    const { fetchImpl } = fakeEndpoint(history(), { lieAboutHasMore: true, stall: true });
    const w = await readLaunchWindow(client(fetchImpl), {
      mint: MINT,
      createdAtMs: CREATED + 500,
      windowMs: 60_000,
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
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
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
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
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 50,
      pageLimit: 100,
    });
    expect(w.unparsedRows).toBe(1);
    expect(w.usable).toBe(false);
    expect(w.note).toMatch(/shape may have changed/);
  });

  it('never issues more requests than its cap, whatever the endpoint says or sheds', async () => {
    // The bound has to be EXACT, not approximate: the stage arithmetic (3 x 8 x 18 = 432) is printed
    // by the dry run as the entire exposure, and a walk that overshot by a retry would make the
    // printed plan a lie and surface as a mid-walk CeilingReached and a dropped launch.
    for (const cap of [1, 2, 3, 4, 5, 6, 7, 8, 17, 18]) {
      for (const shedEvery of [0, 2, 3]) {
        let calls = 0;
        const fetchImpl = (async () => {
          calls += 1;
          if (shedEvery !== 0 && calls % shedEvery !== 0) return { ok: false, status: 429, json: async () => ({}) };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              trades: [row({ ms: CREATED + 30_000, wallet: `w${calls}`, sol: 1, seq: calls })],
              pagination: { hasMore: true, nextCursor: `0-${CREATED + 30_000 - calls}`, limit: 1 },
            }),
          };
        }) as unknown as typeof fetch;

        const w = await readLaunchWindow(client(fetchImpl, 1000), {
          mint: MINT,
          createdAtMs: CREATED,
          windowMs: 60_000,
          seekMarginMs: SEEK_MARGIN_MS,
          windowSlotSpan: WINDOW_SLOT_SPAN,
          maxRequests: cap,
          pageLimit: 1,
        });
        expect(calls, `cap ${cap} shedEvery ${shedEvery}`).toBeLessThanOrEqual(cap);
        expect(w.requests, `cap ${cap} shedEvery ${shedEvery}`).toBeLessThanOrEqual(cap);
      }
    }
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
    // The drops are attributed, not lumped: this endpoint is simply busier than the cap allows for,
    // which is a different event from the clocks disagreeing.
    expect(coverage.dropsByReason.requestCap).toBe(T.maxLaunchesPerCandidate);
    expect(coverage.dropsByReason.mintTimeDisagreement).toBe(0);
    expect(score.verdict).toBe('entry-unmeasured');
  });

  /**
   * A fill endpoint that serves ONE complete window per launch and then says nothing is older, so
   * coverage is discharged and every launch is usable. `roomLeft` is chosen by how much the
   * operation takes; the outsiders round-trip for `gain` SOL each.
   */
  const walkableWindow = (operationSol: number, gain: number) => {
    const rows = (createdMs: number) => {
      const at = (ms: number) => new Date(ms).toISOString();
      const row = (sid: string, tx: string, u: string, ms: number, type: string, sol: number, base: number) => ({
        slotIndexId: sid,
        tx,
        timestamp: at(ms),
        userAddress: u,
        type,
        program: 'pump',
        amountSol: String(sol),
        baseAmount: String(base),
        priceSol: '0.0000001',
      });
      // Newest first, as the live endpoint serves them.
      return [
        row('000000000140000000009', 'sellB', 'B', createdMs + 40_000, 'sell', 5 + gain, 500),
        row('000000000140000000008', 'sellA', 'A', createdMs + 40_000, 'sell', 5 + gain, 500),
        row('000000000100000000003', 'buyB', 'B', createdMs, 'buy', 5, 500),
        row('000000000100000000002', 'buyA', 'A', createdMs, 'buy', 5, 500),
        // Bundled: two operation wallets in one transaction, so the opening is PROVEN.
        row('000000000100000000001', 'devtx', 'devbook', createdMs, 'buy', operationSol / 2, 100),
        row('000000000100000000000', 'devtx', 'dev', createdMs, 'buy', operationSol / 2, 100),
      ];
    };
    return (async (url: string | URL) => {
      const cursorMs = Number(String(new URL(String(url)).searchParams.get('cursor')).split('-')[1]);
      const createdMs = cursorMs - 65_000;
      return {
        ok: true,
        status: 200,
        json: async () => ({ trades: rows(createdMs), pagination: { hasMore: false } }),
      };
    }) as unknown as typeof fetch;
  };

  /** An RPC client that fails loudly if anything asks it for a request. */
  const forbiddenRpc = () =>
    new SolanaRpcClient({
      maxRequests: 100,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        throw new Error('the cost leg must not spend a request here');
      }) as unknown as typeof fetch,
    });

  /** The run envelope the Stage 1 legend is read out of; only `candidates` varies below. */
  const LEGEND_RUN = {
    keyedRequests: 1,
    keylessRequests: 10,
    rpcRequests: 4,
    rpcLoadShedEvents: 0,
    historySource: 'creation-derived' as const,
    elapsedMs: 1000,
    startedAtIso: '2026-08-02T00:00:00.000Z',
    completed: true,
    truncationReason: null,
    prefiltered: 0,
    coverage: {
      seeds: [],
      inertSeeds: [],
      distinctWalletsSeeded: 1,
      prefilteredOut: 0,
      worthARequest: 1,
      candidateCap: 195,
      droppedByCandidateCap: 0,
      gated: 1,
      coverageTruncated: false,
    },
    thresholds: {},
  };

  /** A gate-passing candidate carrying a real Stage 2 score, so the legend block renders. */
  const passedCandidateWith = (score: EntryScore, coverage: unknown) => {
    const completion = measureCompletion(
      Array.from({ length: 40 }, (_, i) => ({ deployedAtMs: T0 + i * DAY, completed: i < 20 })),
    );
    return {
      wallet: 'dev',
      seededBy: ['leaderboard:total_bonded'],
      completion,
      completionCapped: false,
      gate: { passed: true, reasons: [] as string[] },
      verdict: 'gate-passed' as const,
      rationale: '',
      consistency: null,
      historySource: 'creation-derived' as const,
      vendorCompletion: completion,
      vendorVerdict: 'gate-passed' as const,
      vendorPageCapped: false,
      creation: null,
      entry: score,
      entryCoverage: coverage,
    };
  };

  it('THE FREE LEGS RUN FIRST: a closed window costs ZERO Solana RPC requests', async () => {
    // The whole cost model of decision 136b. Room and the gross field are arithmetic over fills
    // already in hand, so a deployer that fails either is refused before the expensive leg starts —
    // which is what makes ~19 requests per launch for the after-cost result affordable at all.
    // The operation takes 90 SOL against 10 of outsider capital, so room is 0.1 against a 0.55 bar.
    const client = new KeylessClient({
      maxRequests: 400,
      minIntervalMs: 0,
      fetchImpl: walkableWindow(90, 1),
      sleepImpl: async () => {},
    });
    const rpc = forbiddenRpc();
    const { score, coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: profile(8),
      nowMs: NOW,
      thresholds: T as never,
      rpc,
    });
    expect(coverage.launchesUsable).toBe(8);
    expect(score.verdict).toBe('entry-room-absent');
    expect(coverage.cost.ran).toBe(false);
    expect(rpc.issued()).toBe(0);
    // And the rendered line says the leg did not run, rather than going quiet and reading as
    // "priced, and it was free".
    expect(renderEntry(score, coverage).join('\n')).toMatch(/cost walk: NOT RUN/);
  });

  it('a window that survives them IS priced, and the record carries what it cost', async () => {
    // Room 0.55 exactly at the bar with a gross-positive field, so the free legs pass it through
    // and the cost leg runs. Each entrant paid 0.02 SOL over its quote in each of its two
    // transactions: 0.02 to get in, and 0.04 across the round trip.
    const client = new KeylessClient({
      maxRequests: 400,
      minIntervalMs: 0,
      fetchImpl: walkableWindow(10 * (1 / 0.6 - 1), 1),
      sleepImpl: async () => {},
    });
    const rpcFetch = (async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      if (req.method === 'getBlock') {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result: null }) };
      }
      const sig = String((req.params as string[])[0]);
      const wallet = sig.endsWith('A') ? 'A' : 'B';
      // Buys move SOL out, sells move it in; either way 0.02 SOL more left the wallet than the
      // quote says, which is the fee, the venue fee and the rent.
      const quoted = sig.startsWith('buy') ? 5 : -6;
      const out = quoted + 0.02;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: wallet }, { pubkey: 'C' }] } },
            meta: {
              err: null,
              fee: 5_000,
              preBalances: [100 * LAMPORTS_PER_SOL, 0],
              postBalances: [(100 - out) * LAMPORTS_PER_SOL, 0],
            },
          },
        }),
      };
    }) as unknown as typeof fetch;
    const rpc = new SolanaRpcClient({
      maxRequests: 200,
      minIntervalMs: 0,
      fetchImpl: rpcFetch,
      sleepImpl: async () => {},
    });

    const { score, coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: profile(8),
      nowMs: NOW,
      thresholds: T as never,
      rpc,
    });

    expect(coverage.cost.ran).toBe(true);
    expect(coverage.cost.transactionsPriced).toBe(coverage.cost.transactionsTargeted);
    expect(coverage.cost.rpcRequests).toBeGreaterThan(0);
    // The block route was probed and refused, and the record says which route paid.
    expect(coverage.cost.viaBlock).toBe(0);
    expect(coverage.cost.viaTransaction).toBe(coverage.cost.transactionsPriced);
    expect(coverage.cost.notes.join(' ')).toMatch(/did not serve a full block/);

    expect(score.entryCostPriced.rate).toBe(1);
    expect(score.entryCostSol.median).toBeCloseTo(0.02, 6);
    expect(score.fieldRealisedSolNetOfMeasuredFees.median).toBeCloseTo(
      score.fieldRealisedSolGrossOfFees.median - 0.04,
      6,
    );
    expect(score.verdict).toBe('entry-open-after-costs');

    // THE LIMIT TRAVELS WITH THE NUMBER. Not only in a document: on the score's caveats, in the
    // persisted record, on the verdict's own sentence, and in the rendered block.
    expect(score.caveats.join(' ')).toContain(LANDING_TIP_CAVEAT);
    expect(score.rationale).toContain(LANDING_TIP_CAVEAT);
    const row = toEntryRecordRow(score, coverage);
    expect(JSON.stringify(row)).toContain('LANDING TIP PAID IN A SEPARATE TRANSACTION');
    expect(row.entryCostSol.median).toBeCloseTo(0.02, 6);
    expect(row.fieldHitRateNetOfMeasuredFees.n).toBe(score.fieldClosedRoundTripsPriced);
    expect(renderEntry(score, coverage).join('\n')).toMatch(/LANDING TIP PAID IN A SEPARATE TRANSACTION/);

    // THE STAGE 1 LEGEND SPEAKS THE VOCABULARY THE RUN EMITTED, AND STATES THE GROSS-ONLY LIMIT
    // ONLY WHERE IT IS TRUE. It printed `ENTRY-ROOM-PRESENT` — a verdict this tool can no longer
    // emit — beside candidates scored `entry-open-after-costs`, and asserted unconditionally that
    // every realised figure above was gross of fees, next to a NET reading that had in fact run.
    // Nothing covered the string, so nothing caught it.
    const legend = renderStage1({
      ...LEGEND_RUN,
      candidates: [passedCandidateWith(score, coverage)],
    } as never);
    for (const removed of ['entry-room-present', 'ENTRY-ROOM-PRESENT']) {
      expect(legend).not.toContain(removed);
    }
    // Every verdict it does name is one the vocabulary still holds.
    for (const named of legend.match(/\bENTRY-[A-Z-]+\b/g) ?? []) {
      expect(ENTRY_VERDICTS).toContain(named.toLowerCase());
    }
    expect(legend).toMatch(/ENTRY-OPEN-AFTER-COSTS is the strongest/);
    expect(legend).toMatch(/ENTRY-COST-PROHIBITIVE and ENTRY-COST-UNMEASURED are both REFUSALS/);
    expect(legend).toMatch(/absence of a finding rather than a finding of absence/);
    expect(legend).toMatch(/NO VERDICT HERE MEANS "BEATABLE"/);
    // The blanket claim is GONE on a rendering that carries a priced reading, and what replaces it
    // says the net figures are themselves an upper bound.
    expect(legend).not.toMatch(/every\s+realised figure above is gross/);
    expect(legend).toMatch(/\*NET\* figures above are the on-chain correction/);
    expect(legend).toMatch(/UPPER bound themselves/);

    // And it IS still stated, unchanged in force, where the cost leg never ran.
    const unpricedScore = { ...score, entryCostPriced: { ...score.entryCostPriced, hits: 0 } };
    const unpriced = renderStage1({
      ...LEGEND_RUN,
      candidates: [passedCandidateWith(unpricedScore as never, coverage)],
    } as never);
    expect(unpriced).toMatch(/every realised figure above is gross\s+of fees and therefore an upper bound/);
    expect(unpriced).not.toContain('ENTRY-ROOM-PRESENT');
  });

  it('a dead RPC leaves the candidate UNMEASURED and never aborts the run', async () => {
    // The public endpoint sheds about a quarter of what it is asked for, so a walk that exhausts
    // its retries is the ordinary case rather than an incident. Before this guard the error
    // propagated out of scoreCandidateEntry and killed a run whose keyed MadeOnSol allowance was
    // already spent — one wallet's bad luck throwing away every measurement paid for before it.
    // The degradation must land on `entry-cost-unmeasured`, which is terminal and never a pass.
    const client = new KeylessClient({
      maxRequests: 400,
      minIntervalMs: 0,
      fetchImpl: walkableWindow(10 * (1 / 0.6 - 1), 1),
      sleepImpl: async () => {},
    });
    // The first launch prices cleanly and the endpoint dies on the second, so this also covers the
    // rollback: pricing that was PAID FOR but no longer backs the score must not stay in
    // `transactionsPriced`, or a record reads `launchesPriced: 1` beside `entryCostPriced.hits: 0`.
    let served = 0;
    const rpc = new SolanaRpcClient({
      maxRequests: 200,
      minIntervalMs: 0,
      fetchImpl: (async (_url: string, init: { body: string }) => {
        const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
        if (req.method === 'getBlock') {
          return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result: null }) };
        }
        served += 1;
        if (served > 4) return { ok: false, status: 503, json: async () => ({}) };
        const sig = String((req.params as string[])[0]);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              transaction: {
                signatures: [sig],
                message: { accountKeys: [{ pubkey: sig.endsWith('A') ? 'A' : 'B' }, { pubkey: 'C' }] },
              },
              meta: {
                err: null,
                fee: 5_000,
                preBalances: [100 * LAMPORTS_PER_SOL, 0],
                postBalances: [(100 - ((sig.startsWith('buy') ? 5 : -6) + 0.02)) * LAMPORTS_PER_SOL, 0],
              },
            },
          }),
        };
      }) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    const { score, coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: profile(8),
      nowMs: NOW,
      thresholds: T as never,
      rpc,
    });

    expect(coverage.cost.ran).toBe(true);
    expect(coverage.cost.notes.join(' ')).toMatch(/ABANDONED for this candidate after a transport failure/);
    // Nothing partial was attached, so the verdict is the absence of a cost reading rather than a
    // priced one of unknown coverage.
    expect(score.verdict).toBe('entry-cost-unmeasured');
    expect(score.entryCostPriced.hits).toBe(0);
    expect(score.entryCostSol.n).toBe(0);
    expect(score.entryCostPerSolStakedByLaunch.n).toBe(0);

    // And the coverage block agrees with it rather than contradicting it. The four transactions the
    // first launch priced are real spend and are still reported — as DISCARDED, which is what they
    // are once the score no longer rests on them.
    expect(coverage.cost.launchesPriced).toBe(0);
    expect(coverage.cost.transactionsPriced).toBe(0);
    expect(coverage.cost.launchesDiscarded).toBe(2);
    expect(coverage.cost.transactionsDiscarded).toBe(4);
    expect(coverage.cost.rpcRequests).toBeGreaterThan(0);

    // AND THE SAME ROLLBACK WITH AN ATTACHED-BUT-PARTIAL LAUNCH IN FRONT OF IT. A launch that came
    // back SHORT for a non-budget reason — one signature the endpoint never resolved — is still
    // attached, still contributed its transactions, and is still dropped when the score is not
    // recomputed; but it is not a `launchesPriced` launch. Reconstructing the rollback total from
    // `launchesPriced` therefore lost it from launch-level accounting entirely, contradicting the
    // JSDoc on `launchesDiscarded`. Every launch whose walk was paid for lands in exactly one of the
    // two, so a reader can reconcile this block arithmetically without reading the prose.
    const client2 = new KeylessClient({
      maxRequests: 400,
      minIntervalMs: 0,
      fetchImpl: walkableWindow(10 * (1 / 0.6 - 1), 1),
      sleepImpl: async () => {},
    });
    let served2 = 0;
    let unresolvable: string | null = null;
    const rpc2 = new SolanaRpcClient({
      maxRequests: 200,
      minIntervalMs: 0,
      fetchImpl: (async (_url: string, init: { body: string }) => {
        const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
        if (req.method === 'getBlock') {
          return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result: null }) };
        }
        const sig = String((req.params as string[])[0]);
        // The first transaction of the first launch never resolves, however often it is asked.
        if (unresolvable === null) unresolvable = sig;
        if (sig === unresolvable) {
          return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result: null }) };
        }
        served2 += 1;
        // The other three of that launch price; the endpoint then dies on the second launch.
        if (served2 > 3) return { ok: false, status: 503, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              transaction: {
                signatures: [sig],
                message: { accountKeys: [{ pubkey: sig.endsWith('A') ? 'A' : 'B' }, { pubkey: 'C' }] },
              },
              meta: {
                err: null,
                fee: 5_000,
                preBalances: [100 * LAMPORTS_PER_SOL, 0],
                postBalances: [(100 - ((sig.startsWith('buy') ? 5 : -6) + 0.02)) * LAMPORTS_PER_SOL, 0],
              },
            },
          }),
        };
      }) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    const partial = await scoreCandidateEntry(client2, {
      wallet: 'dev',
      profile: profile(8),
      nowMs: NOW,
      thresholds: T as never,
      rpc: rpc2,
    });

    expect(partial.coverage.cost.ran).toBe(true);
    expect(partial.coverage.cost.notes.join(' ')).toMatch(/ABANDONED for this candidate/);
    expect(partial.coverage.cost.transactionsUnresolved).toBeGreaterThan(0);
    expect(partial.score.verdict).toBe('entry-cost-unmeasured');
    // The partial launch was NEVER a `launchesPriced` launch, so the old reconstruction booked one
    // discarded launch here and the short launch vanished. It is two: the short one and the one the
    // transport failure killed.
    expect(partial.coverage.cost.launchesPriced).toBe(0);
    expect(partial.coverage.cost.transactionsPriced).toBe(0);
    expect(partial.coverage.cost.launchesDiscarded).toBe(2);
    expect(partial.coverage.cost.transactionsDiscarded).toBe(3);
  });

  it('a ceiling that bites MID-WALK discards that launch whole and does not count it', async () => {
    // The invariant thresholds.json -> minPricedFraction states as enforced at both ends. The
    // reservation before a launch is a floor, not the worst case: every request may be retried and a
    // null getTransaction is asked again, so the ceiling can still run out part-way through a
    // launch. Here the ceiling is exactly one launch's four transactions and every signature is
    // load-shed once, so the walk pays two requests per transaction and gets through two of four.
    // A truncated walk holds the EARLIEST entrants by slot, which is a biased sample rather than a
    // short one, so what it managed must be thrown away rather than attached.
    const client = new KeylessClient({
      maxRequests: 400,
      minIntervalMs: 0,
      fetchImpl: walkableWindow(10 * (1 / 0.6 - 1), 1),
      sleepImpl: async () => {},
    });
    const shed = new Set<string>();
    const rpc = new SolanaRpcClient({
      maxRequests: 4,
      minIntervalMs: 0,
      fetchImpl: (async (_url: string, init: { body: string }) => {
        const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
        const sig = String((req.params as string[])[0]);
        // A null result is load-shedding, so the walk asks again — which is exactly the retry the
        // per-launch reservation cannot see.
        if (!shed.has(sig)) {
          shed.add(sig);
          return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result: null }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              transaction: {
                signatures: [sig],
                message: { accountKeys: [{ pubkey: sig.endsWith('A') ? 'A' : 'B' }, { pubkey: 'C' }] },
              },
              meta: {
                err: null,
                fee: 5_000,
                preBalances: [100 * LAMPORTS_PER_SOL, 0],
                postBalances: [(100 - ((sig.startsWith('buy') ? 5 : -6) + 0.02)) * LAMPORTS_PER_SOL, 0],
              },
            },
          }),
        };
      }) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    const { score, coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: profile(8),
      nowMs: NOW,
      thresholds: T as never,
      rpc,
      preferBlockRoute: false,
    });

    expect(coverage.cost.ran).toBe(true);
    expect(coverage.cost.stoppedForBudget).toBe(true);
    expect(coverage.cost.notes.join(' ')).toMatch(/partial reading was DISCARDED/);
    // Discarded, not priced — and the launches the exhausted ceiling never started are counted
    // apart from it, because those cost nothing at all.
    expect(coverage.cost.launchesDiscarded).toBe(1);
    expect(coverage.cost.transactionsDiscarded).toBeGreaterThan(0);
    expect(coverage.cost.launchesPriced).toBe(0);
    expect(coverage.cost.transactionsPriced).toBe(0);
    expect(coverage.cost.launchesSkippedForBudget).toBe(7);
    // Nothing was attached, so the candidate is unmeasured — which is terminal and never a pass.
    expect(score.verdict).toBe('entry-cost-unmeasured');
    expect(score.entryCostPriced.hits).toBe(0);
  });

  it('counts a mint-time disagreement separately and reports it as an event, per wallet', async () => {
    // The assumption under test is that the vendor's creation time and pump.fun's fills agree. It
    // holds to the millisecond on all 235 of our own launches, and has NEVER been checked on a
    // stranger — this lane has held no vendor key. A visible per-run count is what stops it being
    // untested forever, and stops the tripwire from silently discarding real launches at scale.
    const fetchImpl = (async (url: string | URL) => {
      // The cursor is `0-<windowEnd>`, so this serves a row five seconds before whichever launch's
      // mint time the walk is currently seeking from.
      const cursorMs = Number(String(new URL(String(url)).searchParams.get('cursor')).split('-')[1]);
      return {
      ok: true,
      status: 200,
      json: async () => ({
        trades: [
          {
            slotIndexId: '0004000000000000000001',
            tx: 'tx1',
            // Older than the mint time the profile records. A real token has no pre-mint trade.
            timestamp: new Date(cursorMs - 60_000 - 5_000).toISOString(),
            userAddress: 'w',
            type: 'buy',
            program: 'pump',
            amountSol: '1',
            baseAmount: '1000',
            priceSol: '0.0000001',
          },
        ],
        pagination: { hasMore: true, nextCursor: '0-1', limit: 1 },
      }),
      };
    }) as unknown as typeof fetch;

    const client = new KeylessClient({ maxRequests: 400, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const { score, coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: profile(8),
      nowMs: NOW,
      thresholds: T as never,
    });
    expect(coverage.launchesUsable).toBe(0);
    expect(coverage.dropsByReason.mintTimeDisagreement).toBe(8);
    expect(coverage.launchesDropped).toBe(8);
    expect(score.caveats.join(' ')).toMatch(/REPORTABLE: 8 of those 8/);
    expect(score.caveats.join(' ')).toMatch(/DISAGREED/);
    expect(score.verdict).toBe('entry-unmeasured');

    // And the same count reaches the rendered output, where a human sees it.
    const rendered = renderEntry(score, coverage).join('\n');
    expect(rendered).toMatch(/8 mint-time disagreement/);
    expect(rendered).toMatch(/!! REPORTABLE/);
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
    // Each launch stops one page short of its own cap, because it reserves the full three-request
    // cost of a page before starting one. Under the cap is the only side of it that is safe.
    expect(count()).toBeLessThanOrEqual((T.maxRequestsPerLaunch as number) * 2);
    // The remainder is left unspent rather than half-walking a third launch for nothing.
    expect(client.remaining()).toBeGreaterThanOrEqual(3);
    expect(client.remaining()).toBeLessThan(T.maxRequestsPerLaunch as number);
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

  it('THE ELIGIBILITY FILTER IS READABLE FROM THE RECORD, not only from a log', async () => {
    // Before schema 6 a record carried `launchRefsAvailable` and `launchesAttempted` and nothing
    // between them, so three different reasons a launch went unmeasured — too young, dropped by our
    // own per-candidate cap, or never reached — were indistinguishable, and the 65s gate was
    // observable ONLY by reading seek cursors out of a live run's log. Here the profile offers 12
    // launches, one of which is too young; 11 are eligible and the cap of 8 takes the rest.
    const { fetchImpl } = insatiable();
    const client = new KeylessClient({ maxRequests: 400, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const { coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: profile(12),
      nowMs: CREATED + (T.windowMs as number) + (T.seekMarginMs as number) - 1,
      thresholds: T as never,
    });

    expect(coverage.minAgeMs).toBe((T.windowMs as number) + (T.seekMarginMs as number));
    expect(coverage.launchRefsAvailable).toBe(12);
    expect(coverage.launchesTooYoung).toBe(1);
    expect(coverage.launchesEligible).toBe(11);
    expect(coverage.launchesPlanned).toBe(T.maxLaunchesPerCandidate as number);
    expect(coverage.launchesDroppedByCap).toBe(11 - (T.maxLaunchesPerCandidate as number));
    // The whole filter reconciles, which is the property the record now proves.
    expect(coverage.launchesTooYoung + coverage.launchesEligible).toBe(coverage.launchRefsAvailable);
    expect(coverage.launchesPlanned + coverage.launchesDroppedByCap).toBe(coverage.launchesEligible);
    expect(coverage.launchesAttempted).toBe(coverage.launchesPlanned);

    // And the two ages say whether the run EXERCISED the boundary or sat far above it. The
    // committed live run sat about five hours above it and so could not discriminate the gate from
    // its absence; a reader of that record could not have known.
    expect(coverage.youngestRefAgeMs).toBe(coverage.minAgeMs - 1);
    // The launches are an hour apart, so the youngest one that PASSED is an hour older than the
    // one that did not — a run nowhere near the boundary, and the record now says so.
    expect(coverage.youngestEligibleAgeMs).toBe(coverage.minAgeMs - 1 + 3_600_000);

    // All of it survives the projection, or it is not readable from a record at all.
    const row = toEntryRecordRow(scoreEntry([], ENTRY_T), coverage);
    expect(row.coverage.minAgeMs).toBe(coverage.minAgeMs);
    expect(row.coverage.launchesTooYoung).toBe(1);
    expect(row.coverage.launchesDroppedByCap).toBe(3);
    expect(row.coverage.youngestEligibleAgeMs).toBe(coverage.youngestEligibleAgeMs);
  });

  it('and younger than the CURSOR it seeks from, which is the bound that actually binds', async () => {
    // The gap this closes. The walk seeks from `createdAtMs + windowMs + seekMarginMs` and measures
    // `windowSlotSpan` slots from the create slot, but eligibility asked only for `windowMs`. So a
    // launch aged 60-65s passed "has finished happening" while part of its measured window had not
    // happened yet — the same tail truncation `seekMarginMs` exists to prevent, arriving from the
    // future side, and silent in the worst way: an absent tail reads as a quiet one.
    const { fetchImpl } = insatiable();
    const client = () =>
      new KeylessClient({ maxRequests: 200, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const cursorMs = (T.windowMs as number) + (T.seekMarginMs as number);

    const cases: [number, number][] = [
      [T.windowMs as number, 0], // exactly the old bound, which used to admit it
      [cursorMs - 1, 0], // one millisecond short of the cursor
      [cursorMs, 1], // the cursor is in the past, so the walk may start
    ];
    for (const [ageMs, attempted] of cases) {
      const { coverage } = await scoreCandidateEntry(client(), {
        wallet: 'dev',
        profile: profile(1),
        nowMs: CREATED + ageMs,
        thresholds: T as never,
      });
      expect(coverage.launchRefsAvailable, `age ${ageMs}ms`).toBe(1);
      expect(coverage.launchesAttempted, `age ${ageMs}ms`).toBe(attempted);
    }
  });

  it('that one bound covers the measured span too, so widening the span cannot reopen the gap', () => {
    // Two quantities reach forward from the mint: the seek cursor at `windowMs + seekMarginMs`
    // (65s), and the measured window at `windowSlotSpan` slots — 64.0s at this repo's nominal
    // 400ms/slot, ~63.5s at the tape's observed ~397ms. The cursor dominates, which is why ONE gate
    // suffices. That domination is a property of the pinned values, not a law: a span past 162
    // slots would put the tail of the measured window back beyond the gate.
    const NOMINAL_MS_PER_SLOT = 400;
    expect((T.windowSlotSpan as number) * NOMINAL_MS_PER_SLOT).toBeLessThanOrEqual(
      (T.windowMs as number) + (T.seekMarginMs as number),
    );
    // And the gate is the sum, asserted on the source so it cannot drift back to `windowMs` alone.
    expect(readFileSync(join(TOOL_DIR, 'stage2.mjs'), 'utf8')).toMatch(
      /const minAgeMs = t\.windowMs \+ t\.seekMarginMs;/,
    );
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

// =============================================================================================
// THE PRICE OF THE SEAT — the on-chain cost leg.
//
// Captain's standing ruling, 2026-08-02: fees are part of the entry window, and "enterable" means
// enterable AFTER what it costs to enter. Captain decision 136b adds the field's after-cost result.
//
// The two failure modes these cover are both silent and both optimistic: a transaction priced at
// the wrong account index attributes a stranger's lamport change to our entrant, and an unpriced
// entrant read as a free one books a seat that cost something as a seat that cost nothing.

describe('the transactions a launch must be priced from', () => {
  const window = () => [
    fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 6, tokens: 600 }),
    fill({ slot: 100, tx: 'devtx', wallet: 'devbook', sol: 4, tokens: 400 }),
    fill({ slot: 100, tx: 'buyA', wallet: 'A', sol: 3, tokens: 200 }),
    fill({ slot: 100, tx: 'buyB', wallet: 'B', sol: 2, tokens: 150 }),
    fill({ slot: 130, tx: 'topupA', wallet: 'A', sol: 1, tokens: 40 }),
    fill({ slot: 140, tx: 'sellA', wallet: 'A', sol: 5, tokens: 240, side: 'sell' }),
  ];

  it('groups fills by transaction and nets each wallet\'s quoted flow inside it', () => {
    const t = walletTransactions(window(), new Set(['dev', 'devbook']), 100);
    expect(t).toHaveLength(1);
    expect(t[0]!.tx).toBe('devtx');
    // Two wallets, one transaction — the bundle case. One RPC request prices both, which is why
    // the walk's cost is distinct transactions and not entrants.
    expect(t[0]!.wallets.map((w) => w.wallet).sort()).toEqual(['dev', 'devbook']);
    expect(t[0]!.wallets.find((w) => w.wallet === 'dev')!.quotedSol).toBe(6);
  });

  it('nets a sell against a buy in the SAME transaction, so the baseline is what moved', () => {
    const fills = [
      fill({ slot: 100, tx: 'both', wallet: 'A', sol: 3, tokens: 200 }),
      fill({ slot: 100, tx: 'both', wallet: 'A', sol: 1, tokens: 50, side: 'sell' }),
    ];
    expect(walletTransactions(fills, new Set(['A']), 100)[0]!.wallets[0]!.quotedSol).toBe(2);
  });

  it('UNIONS the two scopes, so a closed entrant\'s create-slot transaction is paid for ONCE', () => {
    // A is closed and has three transactions across the window; B is open and has only its
    // create-slot buy. Scope A alone is 2 signatures and scope B alone is 3, and the union is 4 —
    // not 5, which is what pricing the two scopes separately would cost.
    const fills = window();
    const entry = measureLaunchEntry(fills)!;
    const targets = entryCostTargets(fills, entry);
    expect(targets.map((t) => t.tx).sort()).toEqual(['buyA', 'buyB', 'sellA', 'topupA']);
    // The deployer's own transaction is NOT in it. We are pricing what it costs an outsider to
    // enter, and the operation's own cost is not that.
    expect(targets.map((t) => t.tx)).not.toContain('devtx');
  });

  it('leaves an OPEN entrant\'s later transactions out — only a closed round trip has a P&L', () => {
    const fills = [
      fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 6, tokens: 600 }),
      fill({ slot: 100, tx: 'devtx', wallet: 'devbook', sol: 4, tokens: 400 }),
      fill({ slot: 100, tx: 'buyB', wallet: 'B', sol: 2, tokens: 150 }),
      fill({ slot: 140, tx: 'partB', wallet: 'B', sol: 1, tokens: 40, side: 'sell' }),
    ];
    const entry = measureLaunchEntry(fills)!;
    expect(entry.field[0]!.closedInWindow).toBe(false);
    expect(entryCostTargets(fills, entry).map((t) => t.tx)).toEqual(['buyB']);
  });
});

describe('reading a transaction\'s exact cost off the chain', () => {
  const tx = (o: Partial<{ fee: number; pre: number[]; post: number[]; keys: unknown[]; err: unknown }> = {}) => ({
    blockTime: 1,
    transaction: {
      signatures: ['SIG'],
      message: {
        accountKeys: o.keys ?? [
          { pubkey: 'PAYER', signer: true, writable: true },
          { pubkey: 'CURVE', signer: false, writable: true },
        ],
      },
    },
    meta: {
      err: o.err ?? null,
      fee: o.fee ?? 5_000,
      preBalances: o.pre ?? [10 * LAMPORTS_PER_SOL, 0],
      postBalances: o.post ?? [7 * LAMPORTS_PER_SOL, 3 * LAMPORTS_PER_SOL],
    },
  });

  it('pulls the fee and every account\'s real lamport change out of ONE response', () => {
    const c = parseTransactionCosts(tx())!;
    expect(c.signature).toBe('SIG');
    // base + priority, exact, and charged to accountKeys[0].
    expect(c.feeSol).toBeCloseTo(0.000005, 12);
    expect(c.feePayer).toBe('PAYER');
    // Positive means SOL LEFT the account.
    expect(c.solOutByWallet.get('PAYER')).toBeCloseTo(3, 12);
    expect(c.solOutByWallet.get('CURVE')).toBeCloseTo(-3, 12);
  });

  it('REFUSES a response whose key list does not cover its balances — the mis-indexing trap', () => {
    // preBalances/postBalances are indexed over the transaction\'s WHOLE account list, which for a
    // versioned transaction includes the addresses loaded from a lookup table. A shorter key list
    // means a plainer encoding served only the static half, and reading a balance at an index the
    // keys do not cover would attribute a STRANGER\'S lamport change to our entrant — a wrong
    // number, not a missing one, and wrong in whichever direction the stranger happened to move.
    expect(parseTransactionCosts(tx({ pre: [1, 2, 3], post: [1, 2, 3] }))).toBeNull();
    expect(parseTransactionCosts(tx({ post: [1] }))).toBeNull();
  });

  it('accepts a plain string key list as well as a parsed one', () => {
    const c = parseTransactionCosts(tx({ keys: ['PAYER', 'CURVE'] }))!;
    expect(c.feePayer).toBe('PAYER');
    expect(c.solOutByWallet.get('PAYER')).toBeCloseTo(3, 12);
  });

  it('refuses a FAILED transaction rather than pricing it', () => {
    // Every transaction this walk is pointed at came from a fill, so it succeeded. An `err` means
    // the row is not what we think it is.
    expect(parseTransactionCosts(tx({ err: { InstructionError: [0, 'X'] } }))).toBeNull();
  });

  it('refuses a duplicate account key, whose delta would be ambiguous', () => {
    expect(parseTransactionCosts(tx({ keys: ['PAYER', 'PAYER'] }))).toBeNull();
  });
});

describe('the cost walk, and the route it took', () => {
  const targets = [
    { tx: 'T1', slot: 100, wallets: [{ wallet: 'A', quotedSol: 3 }] },
    { tx: 'T2', slot: 100, wallets: [{ wallet: 'B', quotedSol: 2 }] },
    { tx: 'T3', slot: 140, wallets: [{ wallet: 'A', quotedSol: -5 }] },
  ];

  const txBody = (sig: string, wallet: string, outSol: number) => ({
    transaction: {
      signatures: [sig],
      message: { accountKeys: [{ pubkey: wallet }, { pubkey: 'CURVE' }] },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [100 * LAMPORTS_PER_SOL, 0],
      postBalances: [(100 - outSol) * LAMPORTS_PER_SOL, 0],
    },
  });

  const rpcOver = (handler: (method: string, params: unknown[]) => unknown) => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      calls.push(req.method);
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: req.id, result: handler(req.method, req.params) }),
      };
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('collapses the create slot to ONE request when the block route serves it', async () => {
    const { calls, fetchImpl } = rpcOver((method) =>
      method === 'getBlock'
        ? { transactions: [txBody('T1', 'A', 3.1), txBody('T2', 'B', 2.2), txBody('OTHER', 'Z', 9)] }
        : txBody('T3', 'A', -4.9),
    );
    const rpc = new SolanaRpcClient({ maxRequests: 20, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreateSlotCosts(rpc, { transactions: targets, createSlot: 100 });

    expect(walk.viaBlock).toBe(2);
    expect(walk.viaTransaction).toBe(1);
    // One getBlock for the whole create slot plus one getTransaction for the launch\'s later
    // window, against three getTransaction calls without it.
    expect(calls).toEqual(['getBlock', 'getTransaction']);
    expect(walk.priced.size).toBe(3);
    expect(walk.unresolved).toBe(0);
  });

  it('falls back to per-signature reads when the block route serves nothing, and RECORDS it', async () => {
    // The route is UNTESTED against this endpoint, so it is probed behind a fallback and the run
    // record says which one paid for its numbers.
    const { calls, fetchImpl } = rpcOver((method, params) =>
      method === 'getBlock' ? null : txBody(String((params as string[])[0]), 'A', 1),
    );
    const rpc = new SolanaRpcClient({ maxRequests: 20, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreateSlotCosts(rpc, { transactions: targets, createSlot: 100 });

    expect(walk.blockRouteTried).toBe(true);
    expect(walk.viaBlock).toBe(0);
    expect(walk.viaTransaction).toBe(3);
    expect(walk.blockRouteNote).toMatch(/did not serve a full block/);
    expect(walk.blockRouteNote).toMatch(/never evidence that the slot was empty/);
    expect(calls.filter((c) => c === 'getTransaction')).toHaveLength(3);
  });

  it('an unresolved transaction is UNRESOLVED, never a transaction that cost nothing', async () => {
    // The public RPC sheds load with a null result rather than an error. Reading one as "free"
    // would book a zero into a distribution about what entry costs.
    const { fetchImpl } = rpcOver(() => null);
    const rpc = new SolanaRpcClient({ maxRequests: 20, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreateSlotCosts(rpc, { transactions: targets, createSlot: 100, preferBlock: false });
    expect(walk.priced.size).toBe(0);
    expect(walk.unresolved).toBe(3);
  });

  it('stops at the ceiling and says so, rather than throwing away what it paid for', async () => {
    const { fetchImpl } = rpcOver((_m, params) => txBody(String((params as string[])[0]), 'A', 1));
    const rpc = new SolanaRpcClient({ maxRequests: 1, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const walk = await readCreateSlotCosts(rpc, { transactions: targets, createSlot: 100, preferBlock: false });
    expect(walk.priced.size).toBe(1);
    expect(walk.stoppedForBudget).toBe(true);
  });
});

describe('attaching a measured cost to a launch\'s field', () => {
  const fills = [
    fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 6, tokens: 600 }),
    fill({ slot: 100, tx: 'devtx', wallet: 'devbook', sol: 4, tokens: 400 }),
    fill({ slot: 100, tx: 'buyA', wallet: 'A', sol: 3, tokens: 200 }),
    fill({ slot: 140, tx: 'sellA', wallet: 'A', sol: 4, tokens: 200, side: 'sell' }),
  ];
  const costs = (sig: string, wallet: string, solOut: number, feeSol = 0) => [
    sig,
    { signature: sig, feeSol, feePayer: wallet, solOutByWallet: new Map([[wallet, solOut]]) },
  ] as const;

  it('measures the seat as what LEFT the wallet beyond what the quote says it committed', () => {
    const entry = measureLaunchEntry(fills)!;
    const targets = entryCostTargets(fills, entry);
    // 3.25 SOL actually left the wallet against a 3.00 quoted buy: 0.25 of fee, venue fee, rent and
    // any tip paid inside the same transaction. The sell returned 3.95 against a 4.00 quote.
    const priced = priceLaunchEntry(
      entry,
      targets,
      new Map([costs('buyA', 'A', 0.25 + 3, 0.05), costs('sellA', 'A', -3.95)]),
    );
    const e = priced.field[0]!;
    expect(e.entryCostSol).toBeCloseTo(0.25, 9);
    expect(e.entryCostPerSolStaked).toBeCloseTo(0.25 / 3, 9);
    expect(e.entryTxFeeSol).toBeCloseTo(0.05, 9);
    // Gross says +1.00. Net of what actually moved it is 3.95 - 3.25 = +0.70.
    expect(e.realisedSolGrossOfFees).toBeCloseTo(1, 9);
    expect(e.realisedSolNetOfMeasuredFees).toBeCloseTo(0.7, 9);
    expect(e.returnPerSolNetOfMeasuredFees).toBeCloseTo(0.7 / 3, 9);
  });

  it('ALL OR NOTHING per scope: a half-priced wallet has no figure, not a cheap one', () => {
    // The create slot priced, the sell did not. There is still an entry cost — that scope is
    // complete — and there is no after-cost result, because the round trip is missing a leg.
    const entry = measureLaunchEntry(fills)!;
    const targets = entryCostTargets(fills, entry);
    const priced = priceLaunchEntry(entry, targets, new Map([costs('buyA', 'A', 3.25)]));
    expect(priced.field[0]!.entryCostSol).toBeCloseTo(0.25, 9);
    expect(priced.field[0]!.realisedSolNetOfMeasuredFees).toBeNaN();
  });

  it('refuses an entrant the priced transaction does not carry', () => {
    const entry = measureLaunchEntry(fills)!;
    const targets = entryCostTargets(fills, entry);
    const wrongWallet = new Map([costs('buyA', 'SOMEONE_ELSE', 3.25), costs('sellA', 'SOMEONE_ELSE', -3.95)]);
    const priced = priceLaunchEntry(entry, targets, wrongWallet);
    expect(priced.field[0]!.entryCostSol).toBeNaN();
    expect(priced.field[0]!.realisedSolNetOfMeasuredFees).toBeNaN();
  });

  it('does not mutate the launch it was given', () => {
    const entry = measureLaunchEntry(fills)!;
    priceLaunchEntry(entry, entryCostTargets(fills, entry), new Map([costs('buyA', 'A', 3.25)]));
    expect(entry.field[0]!.entryCostSol).toBeNaN();
  });
});

describe('what a Stage 2 run record may persist', () => {
  const score = (): EntryScore => {
    const fills = [
      // Bundled — dev plus one of its own wallets in one transaction. Without that the create slot
      // is UNPROVEN and `scoreEntry` refuses it, which is a different test than this one.
      fill({ slot: 100, tx: 'devtx', wallet: 'dev', sol: 2, tokens: 700 }),
      fill({ slot: 100, tx: 'devtx', wallet: 'devbook', sol: 1, tokens: 300 }),
      fill({ slot: 100, tx: 'o1', wallet: 'SoMeCounterpartyWalletAddress1111111111111', sol: 3.5, tokens: 250 }),
      fill({ slot: 100, tx: 'o2', wallet: 'SoMeCounterpartyWalletAddress2222222222222', sol: 3.5, tokens: 250 }),
      fill({ slot: 140, tx: 's1', wallet: 'SoMeCounterpartyWalletAddress1111111111111', sol: 4.5, tokens: 250, side: 'sell' }),
      fill({ slot: 141, tx: 's2', wallet: 'SoMeCounterpartyWalletAddress2222222222222', sol: 4.5, tokens: 250, side: 'sell' }),
    ];
    return scoreEntry(Array.from({ length: 8 }, () => measureLaunchEntry(fills)!), ENTRY_T);
  };

  it('persists quantiles and counts — never a mint, never a counterparty address', () => {
    const row = toEntryRecordRow(score(), {
      ...emptyEntryCoverage(),
      launchRefsAvailable: 20,
      launchesTooYoung: 12,
      launchesEligible: 8,
      launchesPlanned: 8,
      launchesAttempted: 8,
      launchesUsable: 8,
      requestsIssued: 34,
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
    // Unpriced, so the strongest thing the record may carry is the absence of a cost reading —
    // and the record says that on its own face rather than leaving a reader to infer it from an
    // empty distribution.
    expect(row.verdict).toBe('entry-cost-unmeasured');
    expect(row.caveats.join(' ')).toMatch(/NO ENTRY COST WAS MEASURED/);
    expect(row.entryCostSol.median).toBeNull();
  });

  it('renders NaN as null rather than as a number a consumer would believe', () => {
    const empty = scoreEntry([], ENTRY_T);
    const row = toEntryRecordRow(empty, {
      ...emptyEntryCoverage(),
    });
    expect(row.roomLeft.median).toBeNull();
    expect(row.fieldHitRateGrossOfFees.rate).toBeNull();
    expect(row.verdict).toBe('entry-unmeasured');
  });

  it('persists NO mint when a launch walk fails at the transport — the path that used to leak', async () => {
    // The containment test above only ever exercised the happy path, which is exactly how this got
    // through: `KeylessClient` throws `HTTP 400 on https://swap-api.pump.fun/v2/coins/<MINT>/trades`,
    // and a note built from that message carried a vendor-derived token address into the record.
    const CREATED_AT = Date.parse('2026-07-28T12:00:00Z');
    const fetchImpl = (async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof fetch;
    const client = new KeylessClient({ maxRequests: 400, minIntervalMs: 0, fetchImpl, sleepImpl: async () => {} });
    const T = loadThresholds()['stage2_entry'] as Record<string, number>;

    const { score, coverage } = await scoreCandidateEntry(client, {
      wallet: 'dev',
      profile: {
        pump_tokens: [
          { mint: 'MINTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaapump', created_timestamp: CREATED_AT, complete: true },
        ],
      },
      nowMs: CREATED_AT + 3_600_000,
      thresholds: T as never,
    });

    expect(coverage.dropsByReason.transportError).toBe(1);
    // The status is what identifies the failure, and it is the only part that cannot carry an
    // identifier. It comes off the error as a FIELD, not out of its message.
    expect(coverage.dropNotes.join(' ')).toMatch(/transport error\): HTTP 400/);
    expect(coverage.dropNotes.join(' ')).not.toMatch(/MINT[0-9a-zA-Z]*pump/);

    const json = JSON.stringify(toEntryRecordRow(score, coverage));
    expect(json).not.toMatch(/MINT[0-9a-zA-Z]*pump/);
    expect(json).not.toMatch(/swap-api/);
  });

  it('redacts a URL or an address that reaches a persisted string by any other route', () => {
    // The boundary half of the fix. Building notes without identifiers is the first line; this is
    // what stops the claim resting on every future note-writer remembering to.
    const leaky = 'HTTP 400 on https://swap-api.pump.fun/v2/coins/MINTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaapump/trades?limit=100';
    expect(redactVendorIdentifiers(leaky)).not.toMatch(/MINT[0-9a-zA-Z]*pump/);
    expect(redactVendorIdentifiers(leaky)).not.toMatch(/swap-api/);
    expect(redactVendorIdentifiers(leaky)).toMatch(/HTTP 400/);
    expect(redactVendorIdentifiers('7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL bought first')).toBe(
      '[address redacted] bought first',
    );
    // Ordinary prose is left alone — a redactor that mangled the caveats would hide the reporting
    // this record exists to carry.
    const caveat = 'Every P&L above is GROSS OF FEES and is therefore an UPPER BOUND.';
    expect(redactVendorIdentifiers(caveat)).toBe(caveat);
  });

  it('the GATE half of the record routes its free text through the same boundary', () => {
    // The boundary was applied to the Stage 2 projection only, so `toRecordRow`'s own free text —
    // `rationale`, `gateReasons`, `consistency.note` — reached the record verbatim. All three are
    // template-generated from counts and rates today, so nothing leaked; the point is that
    // containment for that half was back to depending on every future writer remembering, which is
    // exactly how a mint reached `coverage.dropNotes`.
    const projection = readFileSync(join(TOOL_DIR, 'screen.mjs'), 'utf8');
    const row = projection.slice(projection.indexOf('function toRecordRow'));
    expect(row).toMatch(/rationale: redactVendorIdentifiers\(c\.rationale\)/);
    expect(row).toMatch(/gateReasons: redactAll\(c\.gate\.reasons\)/);
    expect(row).toMatch(/note: redactVendorIdentifiers\(c\.consistency\.note\)/);
    // NOT a blanket sweep, and this is why: `wallet` is base58 of exactly the shape the redactor
    // strikes, and it is the one identifier the record exists to carry.
    expect(row).toMatch(/\bwallet: c\.wallet,/);
    expect(redactVendorIdentifiers('7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL')).toBe('[address redacted]');
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
      seekMarginMs: SEEK_MARGIN_MS,
      windowSlotSpan: WINDOW_SLOT_SPAN,
      maxRequests: 6,
      pageLimit: 1,
    });
    // A page can cost up to three requests, so the walk reserves three before starting one. From
    // four spent it stops rather than starting a fifth page that could take it to seven — the
    // overshoot that would have broken the stage's declared worst case.
    expect(calls).toBe(4);
    expect(w.requests).toBe(4);
    expect(w.pages).toBe(2); // half of them were shed and retried
    expect(c.shed()).toBe(2);
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

  it('THE ROLLING REPLAY: the live recipe, at every point in the tape, with no false positive', () => {
    // The control the two slices above structurally could not be. Both of them sample months where
    // the co-ordination rule recovers 97-100% of the known cohort; over Dec 2025 - Feb 2026 it
    // recovered 0%, and the screen read median room 0.62-0.66 against a true 0.20-0.33 in a regime
    // whose measured per-launch prize to outsiders was about zero. Every error that rule can make
    // runs towards "enterable", so a false positive here is the failure and a false negative is the
    // accepted price of decision 134a.
    expect(result.rollingRoom.windows).toBeGreaterThan(200);
    expect(result.rollingRoom.falsePositives).toBe(0);
    expect(result.rollingRoom.falsePositiveWindows).toEqual([]);
    expect(result.rollingRoom.ok).toBe(true);
    // The check is not vacuous: it does evaluate real verdicts on both sides of the bar, and it
    // does refuse windows rather than scoring everything.
    expect(result.rollingRoom.present).toBeGreaterThan(0);
    expect(result.rollingRoom.absent).toBeGreaterThan(0);
    expect(result.rollingRoom.unmeasured).toBeGreaterThan(0);
    // And the coverage cost is real and visible rather than quietly absorbed — it lands in
    // `unmeasured`, which is NOT the same state as a false negative and is not counted as one. A
    // refused window carries no verdict for the cohort to contradict, so on this tape the screen
    // never once measured a window, said ABSENT, and was wrong about it.
    expect(result.rollingRoom.falseNegatives).toBe(0);
  });

  it('refuses the launches whose opening is unproven, and says how many in each era', () => {
    // 60 of the 235 covered launches carry no bundled create-slot transaction at all. Three of them
    // fall inside the published era-2 bucket, which is where the -0.0115 the tolerance used to
    // absorb came from.
    const era2 = result.eraSplit.find((e) => e.era.startsWith('2026-06-04'))!;
    expect(era2.nRoomUnproven).toBe(3);
    expect(era2.n).toBe(86);
    // Era 1 bundled throughout, so the re-pinning is the only thing that moves it: 0.451 either way.
    const era1 = result.eraSplit.find((e) => e.era.startsWith('2026-05-01'))!;
    expect(era1.nRoomUnproven).toBe(0);
    expect(era1.n).toBe(45);
  });

  it('reproduces the published §5.1 era split and the dataset\'s own P&L table', () => {
    for (const era of result.eraSplit) {
      expect(era.n).toBeGreaterThanOrEqual(era.minN);
      expect(Math.abs(era.operationShareMedian - era.publishedOperationShare)).toBeLessThan(0.02);
    }
    // The era-2 constant is PINNED at the median of its own 89-launch population, not at the
    // published cell's rank-43/44 order statistic (captain decision 135c; the decomposition is in
    // data/population-tape-2026-07-29/IMPORT.md -> Corrections). Asserted so a future lane cannot
    // quietly restore 0.768 — or widen the tolerance, which is what would hide the next defect the
    // way it hid this one.
    const era2 = result.eraSplit.find((e) => e.era.startsWith('2026-06-04'))!;
    expect(era2.publishedOperationShare).toBeCloseTo(0.771, 6);
    expect(era2.published).toMatch(/§5\.1 printed 0\.768 — corrected, see IMPORT\.md/);
    const importMd = readFileSync(
      join(TOOL_DIR, '..', '..', 'data', 'population-tape-2026-07-29', 'IMPORT.md'),
      'utf8',
    );
    expect(importMd, 'the correction lives in IMPORT.md, never in the primary record itself')
      .toMatch(/rank-43\/44/);
    expect(importMd).toMatch(/0\.7708/);
    expect(result.fieldCheck.ok).toBe(true);
    expect(result.fieldCheck.pairs).toBeGreaterThan(1000);
    expect(result.fieldCheck.closureMismatches).toBe(0);
    expect(result.fieldCheck.maxRealisedErrorSol).toBeLessThan(1e-6);
  });

  it('and it FAILS if the unproven openings are ever let back in — the control, demonstrated', () => {
    // A control nobody has seen fail is a control nobody has tested. This reverts decision 134a in
    // the only way that matters to the replay — every launch declared proven, which is what the
    // screen did before this change — and the replay must light up rather than stay quiet.
    //
    // `bundledTx: 1` is exactly the "no bundled transaction means no co-ordination" reading, so the
    // 24 below are the real ones off the committed tape, not a synthetic number.
    const launches = measureSubjectLaunches(DATA_DIR).map((l) => ({
      ...l,
      createSlot: { ...l.createSlot, bundledTx: Math.max(l.createSlot.bundledTx, 1) },
    }));
    const reverted = replayRollingRoom(launches, T['stage2_entry']);
    expect(reverted.ok).toBe(false);
    expect(reverted.falsePositives).toBe(24);
    // All 24 in the same direction. That one-sidedness is the reason the ruling is "refuse to
    // score" rather than "carry a bound": there is no compensating error to trade it against.
    expect(reverted.falseNegatives).toBe(0);
    expect(reverted.unmeasured).toBe(0);
    // 60 of the 235 covered launches are the ones being let back in.
    expect(launches.filter((l) => !roomIsProven(l.createSlot)).length).toBe(0);
    expect(measureSubjectLaunches(DATA_DIR).filter((l) => !roomIsProven(l.createSlot)).length).toBe(60);
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
    expect(loosened.failures.join(' ')).toMatch(/SCORED OUR SUBJECT DEPLOYER AS ENTERABLE AFTER COSTS/);
    // And the failure message points at the leg most likely to be the culprit.
    expect(loosened.failures.join(' ')).toMatch(/field leg/);
    // AND IT IS THE COST-ATTACHED READING THAT FIRES, which is the point of adding it. With the bar
    // loosened, the two UNPRICED readings of the control degrade to `entry-cost-unmeasured` — a
    // refusal, correctly, because unmeasured cost is never a pass — and go quiet. Only the reading
    // carrying real on-chain costs can reach `entry-open-after-costs`, so without Stage 0's cost
    // check a loosened room bar would no longer be caught by this control at all.
    expect(loosened.failures.join(' ')).toMatch(/WITH its on-chain costs attached/);
    expect(loosened.subjectEntryRecent.verdict).toBe('entry-cost-unmeasured');
    expect(loosened.subjectEntryPostBreak.verdict).toBe('entry-cost-unmeasured');
    expect(loosened.costCheck.postBreakScore.verdict).toBe('entry-open-after-costs');
    // On this wallet the after-cost field is still 0.64 positive at a median +0.05 SOL net, so the
    // net leg does NOT veto it. The refusal at the pinned bar is ROOM's, and only room's.
    expect(loosened.costCheck.netHitRate).toBeGreaterThan(0.5);
  });
});
