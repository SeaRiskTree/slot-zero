/**
 * The re-sized keyed envelope, the tiered default seeding, and the raised Dune row ceiling —
 * captain decisions **267a**, **262a**, **264a** and **263b**, all 2026-08-05.
 *
 * Deliberately its own file rather than additions to `test/deployer-screen.test.ts`. What it asserts
 * is a set of claims about **derivations**, and the whole failure mode these four decisions exist to
 * close is a derivation outliving the fact it rested on: a ceiling that used to be a daily allowance
 * and is quoted as one after the allowance moved by 500x, a share printed against the wrong
 * denominator, a bar argued on a reading it is not measured against. So each test here pins the
 * ARITHMETIC that fixes a value, not the value — a future lane that moves a number for a reason must
 * move the reason with it, and a lane that moves the number alone fails here.
 *
 * Nothing in this file opens a socket. The pacing and tier facts it cites were measured live on
 * 2026-08-05 and the measurement is committed under
 * `tools/deployer-screen/measurements/2026-08-05-ultra-keyed-envelope/`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MADEONSOL_DAILY_REQUESTS } from '../tools/deployer-screen/client.mjs';
import {
  CREATION_SQL,
  LAUNCH_CAP_FLOOR,
  SQL_ROW_CEILING,
  launchCapPerWallet,
} from '../tools/deployer-screen/dune.mjs';
import { DEFAULT_TIERS, buildSeedPlan } from '../tools/deployer-screen/seed.mjs';

const TOOL_DIR = fileURLToPath(new URL('../tools/deployer-screen/', import.meta.url));

const T = JSON.parse(readFileSync(`${TOOL_DIR}thresholds.json`, 'utf8')) as Record<string, any>;
const budget = T['budget'] as {
  maxKeyedRequests: number;
  maxKeylessRequests: number;
  maxCandidates: number;
  keyedMinIntervalMs: number;
  justification: Record<string, string>;
};
const feed = T['feed'] as {
  maxKeyedRequestsPerRun: number;
  maxGateBatch: number;
  gateBatch: number;
  runsPerDayAssumed: number;
  justification: Record<string, string>;
};
const dune = T['dune'] as { maxResultRows: number; justification: Record<string, string> };

// ---------------------------------------------------------------------------------------------
// 267a — the keyed envelope. Every value below used to be derived from a ~200/day shared allowance.

describe('267a — the keyed envelope is derived from what binds it, not from the allowance', () => {
  it('derives the keyed ceiling from the PLAN and its retry rule, not from the vendor day', () => {
    const enumerationCost = buildSeedPlan({ limit: 50 }).length;
    // The declared worst case counts FIRST ATTEMPTS (screen.mjs -> worstCaseKeyed); the ceiling is
    // twice it, because a keyed request is retried at most once and every attempt is counted.
    const declared = enumerationCost + budget.maxCandidates;
    expect(budget.maxKeyedRequests).toBe(2 * declared);
    // Therefore the ceiling can never stop a run the tool already agreed to start — which the old
    // 200-against-198 headroom of 2 could not promise: three transport failures near the end of a
    // full run breached it.
    expect(budget.maxKeyedRequests - declared).toBeGreaterThanOrEqual(declared);
  });

  it('keeps the ceiling a ceiling: far below a day, and above the plan it must admit', () => {
    // A bound four orders of magnitude above any plan refuses nothing, and this file's standing rule
    // is that such a bound is not a bound. 402 of 100,000 is 0.402%.
    expect(budget.maxKeyedRequests).toBeLessThan(MADEONSOL_DAILY_REQUESTS / 100);
    expect(budget.maxKeyedRequests).toBeGreaterThan(buildSeedPlan({ limit: 50 }).length + budget.maxCandidates);
  });

  it('fixes the candidate cap at the TIGHTEST pinned ceiling, which is the keyless one', () => {
    // The re-derivation: 195 is no longer "what the keyed day leaves" but the largest cap fitting
    // the ceilings already pinned without moving a second threshold. A candidate costs up to 4 gate
    // listing pages + 3 --consistency pages on frontend-api-v3.
    const PAGES_PER_CANDIDATE = 4 + 3;
    const RETRY_HEADROOM = 35;
    expect(Math.floor((budget.maxKeylessRequests - RETRY_HEADROOM) / PAGES_PER_CANDIDATE)).toBe(budget.maxCandidates);
    // And the plan it produces genuinely fits that ceiling, which is the property the division is
    // standing in for.
    expect(budget.maxCandidates * PAGES_PER_CANDIDATE).toBeLessThanOrEqual(budget.maxKeylessRequests);
  });

  it('cannot exceed what enumeration can physically surface', () => {
    // The third bound on the cap. 6 queries x the vendor's 50-row page maximum is the most distinct
    // wallets one plan can hand the gate at all; a cap above it would be describing wallets that
    // cannot arrive.
    const VENDOR_PAGE_MAX = 50;
    expect(budget.maxCandidates).toBeLessThanOrEqual(buildSeedPlan({ limit: 50 }).length * VENDOR_PAGE_MAX);
    // It is still comfortably above the highest distinct yield ever observed (128, on 2026-08-05),
    // so a default run grades everything it surfaces.
    expect(budget.maxCandidates).toBeGreaterThan(128);
  });

  it('states the pacing as a re-measurement and not as the inherited burst limit', () => {
    // 6.5s existed for a ~10/min Free-tier burst limit. On Ultra a ladder shed nothing at any rung
    // including 0ms, and 60 back-to-back requests (~183/min) shed nothing either.
    expect(budget.keyedMinIntervalMs).toBe(250);
    const why = budget.justification['keyedMinIntervalMs']!;
    expect(why).toMatch(/RE-MEASURED ON ULTRA/);
    expect(why).toMatch(/ZERO shed events .* at EVERY RUNG INCLUDING 0 ms/);
    // A courtesy floor, not a shed-avoidance figure — the distinction the Helius pin already makes.
    expect(why).toMatch(/COURTESY FLOOR AND NOT A SHED-AVOIDANCE FIGURE/);
    // And it declares what the measurement cannot see, which is what stops it being quoted wider
    // than it reaches.
    expect(why).toMatch(/ONE DAY/);
    expect(why).toMatch(/CONCURRENCY/);
  });

  it('does not let a re-derived value keep its retired reason', () => {
    // The specific defect 267a closes. Every one of these justifications used to derive its value
    // from a ~200/day shared allowance; none may still present that as the live constraint.
    for (const key of ['maxKeyedRequests', 'maxCandidates', 'keyedMinIntervalMs']) {
      const why = budget.justification[key]!;
      expect(why).toMatch(/267a/);
      // Each names the tier change in the form that matters to ITS constraint — the two ceilings
      // against the size of the day, the pacing against the burst limit and the key being exclusive.
      expect(why).toMatch(/100,000|EXCLUSIVE/);
    }
    // The two that were literally derived from the old allowance must price the new one.
    expect(budget.justification['maxKeyedRequests']).toMatch(/100,000/);
    expect(budget.justification['maxCandidates']).toMatch(/100,000/);
    // maxCandidates did NOT move, so it has to say so out loud or a reader will assume continuity.
    expect(budget.justification['maxCandidates']).toMatch(/coincidence of integers/);
  });

  it('restates the feed lane share against the vendor day, and keeps the bound anyway', () => {
    // The ceiling moved only where the tiered plan forced it.
    expect(feed.maxKeyedRequestsPerRun).toBe(buildSeedPlan({ limit: 50 }).length + feed.maxGateBatch);
    // 18 x 6 = 108 of 100,000. The point of asserting the SHARE is that the denominator is the one
    // that moved: printing it against budget.maxKeyedRequests read correctly only while that ceiling
    // happened to be the daily allowance.
    const dailyWorstCase = feed.maxKeyedRequestsPerRun * feed.runsPerDayAssumed;
    expect(dailyWorstCase / MADEONSOL_DAILY_REQUESTS).toBeLessThan(0.002);
    expect(feed.justification['maxKeyedRequestsPerRun']).toMatch(/262a/);
    // And the argument for bounding a forever-lane survives the allowance getting bigger.
    expect(feed.justification['maxGateBatch']).toMatch(/UNMOVED BY THE ULTRA UPGRADE/);
  });
});

// ---------------------------------------------------------------------------------------------
// 262a — tiered seeding by default.

describe('262a — the seeding is tiered by default and says what it forfeits', () => {
  it('issues every endpoint once per default tier, ordered seed-first and tier-second', () => {
    const plan = buildSeedPlan({ limit: 50 });
    expect(DEFAULT_TIERS).toEqual(['good', 'elite']);
    expect(plan).toHaveLength(3 * DEFAULT_TIERS.length);
    // Tier-second ordering: if a lowered --max-requests cuts the plan short it takes the worse
    // SEEDS first, never one tier at the other's expense.
    expect(plan.slice(0, 2).every((p) => p.path.endsWith('recent-bonds'))).toBe(true);
    expect(new Set(plan.slice(0, 2).map((p) => p.query['tier']))).toEqual(new Set(DEFAULT_TIERS));
    // Every query carries a tier, and every label records which — provenance is per (seed, tier).
    expect(plan.every((p) => typeof p.query['tier'] === 'string')).toBe(true);
    expect(new Set(plan.map((p) => p.label)).size).toBe(plan.length);
  });

  it('lets `--tier` narrow to one tier, which is how a population outside the pair is reached', () => {
    const plan = buildSeedPlan({ limit: 50, tier: 'moderate' });
    expect(plan).toHaveLength(3);
    expect(plan.every((p) => p.query['tier'] === 'moderate')).toBe(true);
  });

  it('keeps the superseded untiered seeding constructible, and only on an explicit ask', () => {
    // `undefined` and `null` mean different things here on purpose: unstated is the pinned pair,
    // and only an explicit null asks for the seeding 262a superseded. No CLI reaches it, so this is
    // the one place that shape is exercised at all.
    const untiered = buildSeedPlan({ limit: 50, tiers: null });
    expect(untiered).toHaveLength(3);
    expect(untiered.every((p) => p.query['tier'] === undefined)).toBe(true);
    expect(untiered.map((p) => p.label)).toEqual(['recent-bonds', 'alerts', 'leaderboard:total_bonded']);
    // An empty tier set is ONE untiered pass and never zero passes: a plan of no requests would
    // surface no wallets and read as an exhausted feed rather than as a misconfiguration.
    expect(buildSeedPlan({ limit: 50, tiers: [] })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// 264a — the raised Dune row ceiling.

describe('264a — the row ceiling is raised, still reachable, and needs no saved-query deploy', () => {
  it('covers the batch that was refused whole, with margin', () => {
    // The measured breach: 27,731 rows at 76 deployers, refused whole, all 76 walking instead.
    const REFUSED_ROWS = 27_731;
    expect(dune.maxResultRows).toBeGreaterThan(REFUSED_ROWS);
    expect(dune.justification['maxResultRows']).toMatch(/27,731/);
    expect(dune.justification['maxResultRows']).toMatch(/232,937/);
    // And it still refuses rather than pages, which is the property the raise had to preserve.
    expect(dune.justification['maxResultRows']).toMatch(/REFUSES rather than pages/);
  });

  it('leaves the ceiling REACHABLE, so it is still a backstop and not decoration', () => {
    // The rows bound is max(SQL_ROW_CEILING, deployers x 500). Above 80 deployers of 500+ launches
    // the product exceeds the reader's ceiling and the result is refused whole, exactly as before.
    const crossover = Math.ceil(dune.maxResultRows / LAUNCH_CAP_FLOOR);
    expect(crossover).toBe(80);
    expect(crossover).toBeLessThan(budget.maxCandidates); // reachable inside the tool's own cap
    expect(crossover * launchCapPerWallet(crossover)).toBeGreaterThanOrEqual(dune.maxResultRows);
  });

  it('does NOT move the SQL literal, so this raise cannot leave the Dune leg refusing terminally', () => {
    // THE OPERATIONAL POINT. CREATION_SQL is compared against saved query 8204672 before an
    // execution is spent, so editing it here without deploying there refuses the WHOLE Dune leg on
    // every run until they agree. Freezing the literal means the raise is a one-file change.
    expect(SQL_ROW_CEILING).toBe(19_999);
    expect(CREATION_SQL).toContain('floor(19999.0 / greatest(count(DISTINCT wallet), 1))');
    // The relation is now an INEQUALITY. The equality was a derivation; the safety property is that
    // a result honouring the derived cap can never sit ON its own `?limit=`.
    expect(SQL_ROW_CEILING).toBeLessThan(dune.maxResultRows);
    // Freezing it binds nothing measurable: the share-out is only consulted below the floor's own
    // crossover, and every history this repo has measured is far under the frozen literal.
    const LARGEST_MEASURED_HISTORY = 247;
    const SPAM_EXTREME = 8_518;
    expect(SQL_ROW_CEILING).toBeGreaterThan(SPAM_EXTREME);
    expect(launchCapPerWallet(1)).toBeGreaterThan(LARGEST_MEASURED_HISTORY);
  });

  it('re-prices the credit guard rather than leaving the old worst case standing', () => {
    // The guard converts the plan to credits before the first request; doubling the rows doubles
    // the export half. Stated so a reader can see it still clears a fresh period at tightMultiple 2.
    const EXPORT_CREDITS_PER_MB = 20;
    const exportHalf =
      (((T['dune'].maxExecutionsPerRun as number) + 1) *
        dune.maxResultRows *
        (T['dune'].resultBytesPerRowCeiling as number) *
        EXPORT_CREDITS_PER_MB) /
      1_000_000;
    const worstCase =
      (T['dune'].maxExecutionsPerRun as number) * (T['dune'].worstCaseCreditsPerExecution as number) + exportHalf;
    // THE EXPORT HALF IS WHAT 264a MOVED and it is what this test is about: 3 reads x 40,000 rows x
    // 121 B at 20 credits/MB. It was pinned here as the whole worst case (340.4 = 2 x 25 + 290.4)
    // until captain decision 381 re-derived the COMPUTE half against Dune's engine timeout and took
    // worstCaseCreditsPerExecution 25 -> 200. Asserting the two halves apart is what keeps this
    // test measuring the raise it was written for rather than tracking a pin it has no opinion on.
    expect(Math.round(exportHalf * 10) / 10).toBe(290.4);
    expect(Math.round(worstCase)).toBe(690);
    const FREE_TIER_CREDITS = 2_500;
    const needed = worstCase * (T['dune'].allowanceTightMultiple as number) + (T['dune'].allowanceReserveCredits as number);
    expect(needed).toBeLessThan(FREE_TIER_CREDITS);
    expect(dune.justification['maxResultRows']).toMatch(/290\.4/);
    // And the justification says, in place, that its own worked figures predate 381 — so a reader
    // arriving at "340.4" does not take it for the live number.
    expect(dune.justification['maxResultRows']).toMatch(/690\.4/);
  });
});

// ---------------------------------------------------------------------------------------------
// 263b — text only. The bar is HELD, and the correction is that the reading is named.

describe('263b — the completion-rate bar is held at 0.25 and its two readings are taken apart', () => {
  const gate = T['stage1_gate'] as { minCompletionRate: number; justification: Record<string, string> };

  it('does not move the bar', () => {
    expect(gate.minCompletionRate).toBe(0.25);
  });

  it('names the reading the bar is compared against, before quoting any figure on it', () => {
    const why = gate.justification['minCompletionRate']!;
    expect(why).toMatch(/NAME THE READING FIRST/);
    expect(why).toMatch(/CREATION-DERIVED MERGED HISTORY/);
  });

  it('records that the artefact asymmetry REVERSES on the gate reading, and does not act on it', () => {
    const why = gate.justification['minCompletionRate']!;
    expect(why).toMatch(/263b/);
    // Both readings stated apart, with the band the gate reading admits.
    expect(why).toMatch(/\(0\.3303, 0\.4325\]/);
    expect(why).toMatch(/ON THE VENDOR 70-RECORD PAGE/);
    expect(why).toMatch(/ON THE GATE READING/);
    // And the limits travel with it: n = 2 artefacts, 1 control, one day — which is why the value
    // is recorded rather than applied.
    expect(why).toMatch(/n = 2 ARTEFACTS AND ONE CONTROL, ON ONE DAY/);
    expect(why).toMatch(/this bar stays at 0\.25/);
  });

  it('no longer asserts the claim that was true of neither reading on its own', () => {
    // The defect: "There is no bar that removes those two and keeps the control" was stated
    // unqualified while quoting the artefacts on the page and the control on both readings.
    const why = gate.justification['minCompletionRate']!;
    expect(why).not.toMatch(/There is no bar that removes those two and keeps the control:/);
  });
});

// ---------------------------------------------------------------------------------------------
// 264a, END TO END — the batch that was actually refused, driven through the production reader.
//
// The tests above pin the ARITHMETIC. This one reproduces the 2026-08-05 failure itself: an
// enumeration of 76 deployers returning 27,731 rows was refused WHOLE at the old 20,000 ceiling
// and every candidate fell back to the walk. It is driven through `enumerateCreations` at the
// bounds `thresholds.json` actually ships, with a stubbed transport and no socket, and asserts
// the reading now SURVIVES — and, at the superseded ceiling, still refuses, so the test fails
// before the raise and passes after it.

describe('264a end to end — the 27,731-row batch is read at the shipped ceiling', () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  /** 76 distinct base58-shaped deployers — the candidate count that breached the old ceiling. */
  const WALLETS = Array.from(
    { length: 76 },
    (_, i) => `${B58[Math.floor(i / B58.length) + 1]}${B58[i % B58.length]}${'W'.repeat(42)}`,
  );
  const TOTAL_ROWS = 27_731;

  const probeRows = () => {
    const rows: unknown[] = [];
    for (const tbl of ['evt_createevent', 'call_create']) {
      rows.push({ tbl, metric: 'first_row', at: '2024-04-01 00:00:00.000 UTC', n: 20_571_130 });
      rows.push({ tbl, metric: 'last_row', at: '2026-08-05 09:00:00.000 UTC', n: 20_571_130 });
      for (let y = 2024, m = 4; y < 2026 || m <= 8; m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
        rows.push({ tbl, metric: 'month', at: `${y}-${String(m).padStart(2, '0')}-01 00:00:00.000 UTC`, n: 1000 });
      }
    }
    return rows;
  };

  /** 27,731 creation rows spread over the 76 wallets, none of them capped. */
  const creationRows = () => {
    const per = Math.floor(TOTAL_ROWS / WALLETS.length);
    const counts = WALLETS.map((_, i) => per + (i < TOTAL_ROWS - per * WALLETS.length ? 1 : 0));
    const rows: unknown[] = [];
    WALLETS.forEach((w, i) => {
      for (let k = 0; k < counts[i]!; k++) {
        rows.push({
          deployer: w,
          mint: `${w.slice(0, 20)}${String(k).padStart(10, '0')}pump`,
          created_at: '2026-07-01 00:00:00.000 UTC',
          bonded: k % 5 === 0,
          launches_total: counts[i],
          is_mayhem_mode: null,
        });
      }
    });
    return rows;
  };

  const run = async (maxResultRows: number) => {
    const { DuneClient } = await import('../tools/deployer-screen/client.mjs');
    const { COVERAGE_SQL, enumerateCreations } = await import('../tools/deployer-screen/dune.mjs');
    const rows = creationRows();
    const body = (r: unknown[]) =>
      new Response(
        JSON.stringify({ result: { rows: r, metadata: { total_row_count: r.length, total_result_set_bytes: 1 } } }),
        { status: 200 },
      );
    const fetchImpl = async (url: unknown) => {
      const path = String(url).replace('https://api.dune.com/api/v1', '');
      if (path.startsWith('/query/8204603/results')) return body(probeRows());
      if (path.startsWith('/query/8204603')) return new Response(JSON.stringify({ query_sql: COVERAGE_SQL }), { status: 200 });
      if (path.startsWith('/query/8204672/execute')) return new Response(JSON.stringify({ execution_id: 'e1' }), { status: 200 });
      if (path.startsWith('/query/8204672')) return new Response(JSON.stringify({ query_sql: CREATION_SQL }), { status: 200 });
      if (path.startsWith('/execution/e1/status'))
        return new Response(JSON.stringify({ state: 'QUERY_STATE_COMPLETED' }), { status: 200 });
      if (path.startsWith('/execution/e1/results')) return body(rows);
      throw new Error(`unstubbed ${path}`);
    };
    const client = new DuneClient({
      key: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      maxExecutions: T['dune'].maxExecutionsPerRun as number,
      maxRequests: T['dune'].maxRequestsPerRun as number,
      minIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => {},
    });
    return enumerateCreations(client, {
      wallets: WALLETS,
      creationQueryId: T['dune'].creationQueryId as number,
      coverageQueryId: T['dune'].coverageQueryId as number,
      refreshProbe: false,
      nowMs: Date.parse('2026-08-05T12:00:00Z'),
      bounds: {
        pollIntervalMs: 0,
        maxPollAttempts: T['dune'].maxPollAttempts as number,
        maxResultRows,
        maxCoverageLagMs: T['dune'].maxCoverageLagMs as number,
      },
      allowance: {
        verdict: 'sufficient' as const,
        ok: true,
        worstCaseCredits: 1,
        creditsUsed: 0,
        creditsIncluded: 2500,
        monthlyCapCredits: 4000,
        creditsIncludedVendor: 2500,
        bindingCeiling: 'vendor-plan' as const,
        creditsRemaining: 2500,
        reserveCredits: 25,
        spendableCredits: 2475,
        shortfallCredits: 0,
        periodStart: '2026-07-29',
        periodEnd: '2026-08-29',
        readAtUtc: '2026-08-05T12:00:00.000Z',
        reasons: [],
        caveats: ['test fixture'],
      },
    });
  };

  it('keeps its Dune answer for all 76 deployers at the shipped ceiling', async () => {
    const e = await run(dune.maxResultRows);
    expect(e.coverage.ok).toBe(true);
    expect(e.byWallet.size).toBe(WALLETS.length);
    expect([...e.byWallet.values()].reduce((n, w: any) => n + w.launches, 0)).toBe(TOTAL_ROWS);
  }, 60_000);

  it('and the SAME batch is still refused whole at the superseded 20,000 ceiling', async () => {
    // The failure this raise closed: refused whole, every candidate walking, mayhem unmeasured.
    await expect(run(20_000)).rejects.toThrow(/above the pinned ceiling/);
  }, 60_000);
});
