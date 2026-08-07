/**
 * **The Dune monthly credit ceiling: a thing this project can SEE and REFUSE against.**
 *
 * Dune bills a SHARED monthly allowance (Free tier: 2,500 credits) and a FAILED execution is billed
 * exactly like a successful one. Before the guard these tests pin, both keyed tools discovered that
 * ceiling by hitting it — the shape being an HTTP 402 partway through a multi-execution run that
 * leaves neither a result nor the credits to retry. The measured case that motivated the work: one
 * venue-research investigation spent ~350 credits, about 14% of a month, in a single sitting
 * (`slot-zero-launch-venue-daily-rates` §7, held in firstmate's records, not in this repo).
 *
 * **The spine of this file is "refuses rather than proceeds".** Everything else — the parser, the
 * arithmetic, the two copies agreeing — exists to make that refusal trustworthy.
 *
 * ## Why the guard is DUPLICATED and pinned rather than shared
 *
 * The boundary in this repository is the DIRECTORY: `tools/deployer-screen/` and
 * `tools/creation-census/` are the two keyed tools, neither may import the other, and a third
 * vendor goes into `client.mjs` rather than into a new file. So one rule reaching both tools means
 * one TEXT duplicated across the boundary and pinned by a test — the remedy `COHORT_SQL` already
 * uses for the same reason. The first `describe` below is that pin.
 *
 * ## What is an ASSUMPTION here, and it is marked in the code too
 *
 * `DUNE_API_KEY` is not available to the lane that built this, so no live response was ever seen.
 * Dune's published documentation contradicts itself about ONE field name — the response schema calls
 * the array `billing_periods` and the example beside it calls it `billingPeriods` — so
 * `parseUsageResponse` accepts both spellings and both are exercised here. Everything else in the
 * shape is documented consistently: `POST /api/v1/usage`, optional `{start_date, end_date}` body,
 * `credits_used`/`credits_included` per billing period, and no credits consumed by the call.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DuneClient as ScreenDuneClient,
  decideAllowance as screenDecideAllowance,
  describeAllowanceDecision,
  estimatePlanCredits,
  localCreditEstimate,
  parseUsageResponse,
  ALLOWANCE_LAG_CAVEAT,
  ALLOWANCE_SHARED_CAVEAT,
  LOCAL_ESTIMATE_CAVEAT,
  EXPORT_CREDITS_PER_MB,
  USAGE_PATH,
} from '../tools/deployer-screen/client.mjs';
import {
  DuneClient as CensusDuneClient,
  DUNE_API_BASE,
  decideAllowance as censusDecideAllowance,
  parseUsageResponse as censusParseUsageResponse,
  estimatePlanCredits as censusEstimatePlanCredits,
} from '../tools/creation-census/client.mjs';
import {
  checkDuneAllowance,
  duneSpendPlan,
  enumerateCreations,
  openDuneCreditLedger,
} from '../tools/deployer-screen/dune.mjs';
import type { DuneCreditLedger } from '../tools/deployer-screen/dune.mjs';
import { agreementExecutionsFor, tradeFillSpendPlan } from '../tools/deployer-screen/dune-fills.mjs';
import { buildDuneEntryFillSource } from '../tools/deployer-screen/screen.mjs';
import { EXIT, main as censusMain, readBounds } from '../tools/creation-census/run.mjs';

const SCREEN_CLIENT = fileURLToPath(new URL('../tools/deployer-screen/client.mjs', import.meta.url));
const CENSUS_CLIENT = fileURLToPath(new URL('../tools/creation-census/client.mjs', import.meta.url));
const THRESHOLDS = fileURLToPath(new URL('../tools/deployer-screen/thresholds.json', import.meta.url));

/** Never a real key. Every failure path below is driven through it and it may reach no output. */
const SENTINEL_KEY = 'SENTINELsentinelSENTINELsentinel';
const NOW_MS = Date.parse('2026-08-04T12:00:00.000Z');
const WALLET = '7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL';

const BEGIN = '// --- BEGIN SHARED REGION: the Dune monthly credit ceiling guard';
const END = '// --- END SHARED REGION: the Dune monthly credit ceiling guard';

function sharedRegion(file: string): string {
  const text = readFileSync(file, 'utf8');
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END);
  expect(from, `${file} has no shared-region start marker`).toBeGreaterThan(-1);
  expect(to, `${file} has no shared-region end marker`).toBeGreaterThan(from);
  return text.slice(from, to);
}

/** A usage response in the documented shape. `key` selects which of the two spellings to use. */
function usageBody(
  periods: Record<string, unknown>[],
  key: 'billing_periods' | 'billingPeriods' = 'billing_periods',
  extra: Record<string, unknown> = {},
): unknown {
  return { private_queries: 9, private_dashboards: 0, bytes_used: 1, bytes_allowed: 2, [key]: periods, ...extra };
}

function period(used: number, included = 2500, start = '2026-07-29', end = '2026-08-29') {
  return { start_date: start, end_date: end, credits_used: used, credits_included: included };
}

const PLAN = {
  lane: 'test',
  executions: 2,
  creditsPerExecution: 25,
  resultReads: 3,
  rowsPerRead: 20_000,
  bytesPerRow: 121,
};

// ---------------------------------------------------------------------------------------------

describe('one rule, two keyed tools, and the copies cannot drift', () => {
  it('carries the guard byte for byte in both client.mjs files', () => {
    // Not a style preference: `tools/creation-census/` may not import `tools/deployer-screen/` and a
    // test in each directory enforces that, so the only way one credit rule governs both tools is a
    // duplicated text pinned here. A divergence fails here rather than producing two different
    // ideas of what the account can afford under one name.
    expect(sharedRegion(SCREEN_CLIENT)).toBe(sharedRegion(CENSUS_CLIENT));
  });

  it('reaches the same verdict from both copies over one set of cases', () => {
    // Behavioural parity for the half a textual pin cannot see: the two copies are separate module
    // instances with separate constants, so a copy that parsed the same bytes into a different
    // number would still pass the test above.
    const cases = [
      usageBody([period(0)]),
      usageBody([period(2_400)]),
      usageBody([period(2_499.9)]),
      usageBody([period(2_400)], 'billingPeriods'),
      usageBody([]),
      { nonsense: true },
    ];
    for (const body of cases) {
      const a = parseUsageResponse(body, NOW_MS);
      const b = censusParseUsageResponse(body, NOW_MS);
      expect(b).toEqual(a);
      const estA = estimatePlanCredits(PLAN);
      const estB = censusEstimatePlanCredits(PLAN);
      expect(estB).toEqual(estA);
      const input = {
        plan: PLAN,
        estimate: estA,
        allowance: a.allowance,
        unreadableReasons: a.reasons,
        reserveCredits: 25,
        tightMultiple: 2,
        allowanceRequired: true,
      };
      expect(censusDecideAllowance(input)).toEqual(screenDecideAllowance(input));
    }
  });

  it('reads the allowance from the same free endpoint, the same way, on both clients', async () => {
    // `POST /usage` — not GET, which is the shape that catches a reader out — with an empty body,
    // and it is the ONE POST this repository retries. `execute` buys a billed execution and
    // `postJson` consumes an irreplaceable private-query slot; this one creates nothing and costs
    // nothing, so a transport hiccup must not be what decides a run cannot afford itself.
    for (const Client of [ScreenDuneClient, CensusDuneClient]) {
      const seen: { path: string; method: string; body: unknown }[] = [];
      let attempt = 0;
      const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
        seen.push({
          path: String(url).slice(DUNE_API_BASE.length),
          method: String(init.method),
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        attempt += 1;
        if (attempt === 1) return new Response('upstream', { status: 503 });
        return new Response(JSON.stringify(usageBody([period(10)])), { status: 200 });
      });
      const c = new Client({
        key: SENTINEL_KEY,
        maxExecutions: 1,
        maxRequests: 10,
        minIntervalMs: 0,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: async () => undefined,
      });
      const body = await c.readUsage();
      expect(parseUsageResponse(body, NOW_MS).allowance?.creditsUsed).toBe(10);
      expect(seen.map((s) => s.path)).toEqual([USAGE_PATH, USAGE_PATH]);
      expect(new Set(seen.map((s) => s.method))).toEqual(new Set(['POST']));
      expect(seen[0]!.body).toEqual({});
      // It is a request, so it counts against the request ceiling — but it is NOT an execution,
      // because it buys no compute. Conflating the two is how a poll loop ends up billed.
      expect(c.executions()).toBe(0);
      expect(c.issued()).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('what the vendor says, and what this refuses to read into it', () => {
  it('reads the documented shape under BOTH field spellings the docs give', () => {
    // Dune's own documentation contradicts itself here: the response schema says `billing_periods`
    // and the example beside it says `billingPeriods`. No live response was available to settle it,
    // so both are accepted — being wrong refuses a run that could have proceeded, and accepting
    // both costs nothing. If a live response ever settles it, NARROW this; do not widen it further.
    for (const key of ['billing_periods', 'billingPeriods'] as const) {
      const r = parseUsageResponse(usageBody([period(336.3)], key), NOW_MS);
      expect(r.ok).toBe(true);
      expect(r.allowance).toMatchObject({
        creditsUsed: 336.3,
        creditsIncluded: 2500,
        creditsRemaining: 2163.7,
        periodStart: '2026-07-29',
        periodEnd: '2026-08-29',
        privateQueries: 9,
      });
    }
  });

  it('takes the period that BRACKETS the reading, not the first one listed', () => {
    // The billing period is NOT a calendar month — this account's was measured running
    // 2026-07-29 → 2026-08-29, i.e. it resets on a subscription anniversary. A guard reporting a
    // previous period's headroom as today's is worse than one reporting nothing.
    const r = parseUsageResponse(
      usageBody([period(5, 2500, '2026-06-29', '2026-07-29'), period(2_450)]),
      NOW_MS,
    );
    expect(r.allowance?.creditsUsed).toBe(2_450);
    expect(r.allowance?.periodsReturned).toBe(2);
  });

  it('REFUSES when no returned period brackets the reading, rather than reading the newest', () => {
    // We always POST an empty body, which the vendor documents as returning the CURRENT period, so
    // an answer that contains no period covering now means something is wrong — the vendor, the
    // clock, or our reading of the shape. Substituting the newest period would report a stale (or
    // future-dated) balance as today's headroom, and a low `credits_used` there would clear a run
    // whose real balance was never established. An unestablished balance is not headroom, the same
    // rule `decideAllowance` applies to a null allowance.
    const stale = parseUsageResponse(
      usageBody([period(5, 2500, '2026-01-01', '2026-02-01'), period(9, 2500, '2026-02-01', '2026-03-01')]),
      NOW_MS,
    );
    expect(stale.ok).toBe(false);
    expect(stale.allowance).toBeNull();
    // The refusal names what the vendor DID return, so an operator can diagnose it without a second
    // billed call — the reading itself is free, but the diagnosis is what costs a person time.
    expect(stale.reasons.join(' ')).toContain('2026-02-01 -> 2026-03-01');
    // And the screen falls back to the RPC walk / the census defers, rather than either proceeding.
    const decision = screenDecideAllowance({
      plan: PLAN,
      estimate: estimatePlanCredits(PLAN),
      allowance: stale.allowance,
      unreadableReasons: stale.reasons,
      reserveCredits: 25,
      tightMultiple: 2,
      allowanceRequired: true,
    });
    expect(decision.verdict).toBe('unreadable');
    expect(decision.ok).toBe(false);
  });

  it('reads a bare date and a full ISO timestamp to the SAME allowance', () => {
    // The documented shape is bare `YYYY-MM-DD`, but no live response has ever been seen from this
    // repository. Appending `T00:00:00Z` to a full ISO timestamp yields `...ZT00:00:00Z`, which
    // parses to NaN, drops every period and reads as unreadable — sending the screen to the ~13 h
    // RPC walk on every run and refusing the census permanently, since it has no fallback. So the
    // bare parse is tried first and the suffix is only a fallback.
    for (const parse of [parseUsageResponse, censusParseUsageResponse]) {
      const bare = parse(usageBody([period(336.3)]), NOW_MS);
      const iso = parse(
        usageBody([period(336.3, 2500, '2026-07-29T00:00:00Z', '2026-08-29T00:00:00Z')]),
        NOW_MS,
      );
      expect(iso.ok).toBe(true);
      expect(iso.allowance?.creditsRemaining).toBe(bare.allowance?.creditsRemaining);
      expect(iso.allowance?.creditsUsed).toBe(bare.allowance?.creditsUsed);
    }
  });

  it('refuses a body it cannot read rather than inventing headroom', () => {
    // Absence of evidence is not evidence of headroom. Each of these yields NO allowance, and the
    // decision below turns no allowance into a refusal.
    const bad: unknown[] = [
      null,
      'not json',
      [],
      {},
      usageBody([]),
      usageBody([{ start_date: '2026-07-29', end_date: '2026-08-29', credits_included: 2500 }]),
      usageBody([{ start_date: '2026-07-29', end_date: '2026-08-29', credits_used: '10', credits_included: 2500 }]),
      usageBody([period(Number.NaN)]),
      usageBody([period(-1)]),
      usageBody([period(10, 0)]),
      usageBody([{ ...period(10), start_date: 'not-a-date' }]),
    ];
    for (const body of bad) {
      const r = parseUsageResponse(body, NOW_MS);
      expect(r.ok, JSON.stringify(body)).toBe(false);
      expect(r.allowance).toBeNull();
      expect(r.reasons.join(' ').length).toBeGreaterThan(0);
    }
  });

  it('TYPE-checks `credits_used`, so a legitimate zero is not read as a missing column', () => {
    // The same rule the Dune enumeration already applies to `bonded`: `=== 0` would collapse "the
    // field is gone" into "nothing has been spent", which is the most dangerous possible reading of
    // a spend counter. Zero at the start of a period is legitimate and must survive.
    const r = parseUsageResponse(usageBody([period(0)]), NOW_MS);
    expect(r.ok).toBe(true);
    expect(r.allowance?.creditsUsed).toBe(0);
    expect(r.allowance?.creditsRemaining).toBe(2500);
  });
});

// ---------------------------------------------------------------------------------------------

describe('pricing a plan before it spends', () => {
  it('prices the CEILINGS, in the unit the allowance is denominated in', () => {
    const e = estimatePlanCredits(PLAN);
    expect(e.executionCredits).toBe(50);
    expect(e.exportBytes).toBe(3 * 20_000 * 121);
    expect(e.exportCredits).toBeCloseTo((3 * 20_000 * 121 * EXPORT_CREDITS_PER_MB) / 1_000_000, 6);
    expect(e.worstCaseCredits).toBeCloseTo(e.executionCredits + e.exportCredits, 6);
  });

  it('is the screen leg\'s own arithmetic, read off the pinned bounds', () => {
    // The dry run prints this and a live run compares the account balance against it, so it must
    // come from `thresholds.json` rather than from a number typed twice.
    const d = JSON.parse(readFileSync(THRESHOLDS, 'utf8')).dune;
    const plan = duneSpendPlan(d);
    expect(plan.executions).toBe(d.maxExecutionsPerRun);
    expect(plan.resultReads).toBe(d.maxExecutionsPerRun + 1);
    expect(plan.rowsPerRead).toBe(d.maxResultRows);
    expect(estimatePlanCredits(plan).worstCaseCredits).toBeGreaterThan(0);
    // The pinned worst case per execution has to sit above every execution this repository has
    // measured for these two statements (0.919 enumeration, 0.751 coverage probe) with real room,
    // and the reserve has to be positive or the counter's lag is unabsorbed.
    expect(d.worstCaseCreditsPerExecution).toBeGreaterThan(1);
    expect(d.allowanceReserveCredits).toBeGreaterThan(0);
    expect(d.allowanceRequired).toBe(true);
  });

  it('bounds a run below the whole free tier, so the guard can never be the thing that empties it', () => {
    // A worst case at or above the monthly allowance would make the guard unsatisfiable on a fresh
    // period: it would refuse every run and the ceiling would be a wall. Both lanes must sit well
    // under 2,500 with the reserve on top.
    const FREE_TIER = 2500;
    const screen = JSON.parse(readFileSync(THRESHOLDS, 'utf8')).dune;
    const screenWorst = estimatePlanCredits(duneSpendPlan(screen)).worstCaseCredits;
    expect(screenWorst + screen.allowanceReserveCredits).toBeLessThan(FREE_TIER / 2);

    const census = readBounds().dune;
    const censusWorst = estimatePlanCredits({
      lane: 'census',
      executions: census.maxExecutionsPerRun,
      creditsPerExecution: census.worstCaseCreditsPerExecution,
      resultReads: census.maxExecutionsPerRun + 1,
      rowsPerRead: readBounds().census.maxRows + readBounds().census.resultLimitHeadroom,
      bytesPerRow: census.resultBytesPerRowCeiling,
    }).worstCaseCredits;
    expect(censusWorst + census.allowanceReserveCredits).toBeLessThan(FREE_TIER / 2);
  });

  it('labels a local tally as an estimate everywhere it surfaces', () => {
    // The vendor's counter lags by longer than a run lasts, so a record cannot carry its own true
    // cost. What it carries instead is this, and the caveat is INSIDE the object rather than beside
    // it, so a consumer that reads the number cannot miss the label.
    const local = localCreditEstimate({ executions: 2, creditsPerExecution: 25, resultBytes: 500_000 });
    expect(local.executionCredits).toBe(50);
    expect(local.exportCredits).toBe(10);
    expect(local.estimatedCredits).toBe(60);
    expect(local.caveat).toBe(LOCAL_ESTIMATE_CAVEAT);
    expect(LOCAL_ESTIMATE_CAVEAT).toMatch(/LOCAL ESTIMATE, not the bill/);
    expect(LOCAL_ESTIMATE_CAVEAT).toMatch(/only POST \/usage is authoritative/i);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the decision, and the two things it cannot see', () => {
  const estimate = estimatePlanCredits(PLAN);
  const decide = (allowance: unknown, over: Record<string, unknown> = {}) =>
    screenDecideAllowance({
      plan: PLAN,
      estimate,
      allowance,
      unreadableReasons: ['stub'],
      reserveCredits: 25,
      tightMultiple: 2,
      allowanceRequired: true,
      ...over,
    } as never);

  it('passes a plan that fits twice over', () => {
    const d = decide(parseUsageResponse(usageBody([period(0)]), NOW_MS).allowance);
    expect(d.verdict).toBe('sufficient');
    expect(d.ok).toBe(true);
    expect(d.spendableCredits).toBe(2475);
    expect(d.shortfallCredits).toBe(0);
  });

  it('WARNS but proceeds when the plan fits once and not twice', () => {
    // A run that cannot be repeated is a run whose failure cannot be retried. That is worth saying
    // out loud before the period rolls, and it is not worth refusing over.
    const used = 2500 - (estimate.worstCaseCredits * 1.5 + 25);
    const d = decide(parseUsageResponse(usageBody([period(used)]), NOW_MS).allowance);
    expect(d.verdict).toBe('tight');
    expect(d.ok).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/may be the last one this period can afford/);
  });

  it('REFUSES before the first execution when the plan does not fit', () => {
    const used = 2500 - (estimate.worstCaseCredits - 1);
    const d = decide(parseUsageResponse(usageBody([period(used)]), NOW_MS).allowance);
    expect(d.verdict).toBe('insufficient');
    expect(d.ok).toBe(false);
    expect(d.shortfallCredits).toBeGreaterThan(0);
    expect(d.reasons.join(' ')).toMatch(/REFUSED before the first execution/);
    expect(d.reasons.join(' ')).toMatch(/billed whether or not it succeeds/);
  });

  it('holds the reserve back, because a reading is a FLOOR on spend and not a measurement', () => {
    // Measured on this account: the counter rose +6.0 credits while the evaluator was idle, and it
    // lands in whole-credit jumps. So `remaining` OVERSTATES what is there. A balance that clears
    // the plan by less than the reserve must still refuse.
    const used = 2500 - (estimate.worstCaseCredits + 10);
    const withReserve = decide(parseUsageResponse(usageBody([period(used)]), NOW_MS).allowance);
    expect(withReserve.verdict).toBe('insufficient');
    const withoutReserve = decide(parseUsageResponse(usageBody([period(used)]), NOW_MS).allowance, {
      reserveCredits: 0,
    });
    expect(withoutReserve.ok).toBe(true);
  });

  it('refuses an UNREADABLE allowance by default, and says it is refusing rather than passing', () => {
    const d = decide(null);
    expect(d.verdict).toBe('unreadable');
    expect(d.ok).toBe(false);
    expect(d.creditsRemaining).toBeNull();
    expect(d.reasons.join(' ')).toMatch(/an unreadable balance is not headroom/);
    expect(d.reasons).toContain('stub');

    // A lane may opt out, and then the fact that it did travels with the run.
    const unguarded = decide(null, { allowanceRequired: false });
    expect(unguarded.verdict).toBe('unreadable');
    expect(unguarded.ok).toBe(true);
    expect(unguarded.reasons.join(' ')).toMatch(/Proceeding UNGUARDED/);
  });

  it('refuses a plan that does not PRICE, instead of clearing it through the `sufficient` door', () => {
    // The pinned bounds both lanes price against are read from JSON at runtime through an untyped
    // object, so a missing or non-numeric bound reaches `estimatePlanCredits` and comes back NaN.
    // Every `<` against NaN is FALSE, so before this guard a run priced at nothing sailed past both
    // comparisons and was returned as `sufficient` — the exact inversion of the module's own rule
    // that every unknown refuses. A fat balance must not rescue an unpriceable plan.
    const rich = parseUsageResponse(usageBody([period(0)]), NOW_MS).allowance;
    for (const decideOne of [screenDecideAllowance, censusDecideAllowance]) {
      const broken = decideOne({
        plan: PLAN,
        estimate: estimatePlanCredits({ ...PLAN, creditsPerExecution: undefined } as never),
        allowance: rich,
        reserveCredits: 25,
        tightMultiple: 2,
        allowanceRequired: true,
      } as never);
      expect(broken.verdict).toBe('unreadable');
      expect(broken.ok).toBe(false);
      expect(broken.reasons.join(' ')).toMatch(/not a finite number of credits/);

      // A non-finite RESERVE is the same failure from the other side: it makes `spendable` NaN.
      const noReserve = decideOne({
        plan: PLAN,
        estimate,
        allowance: rich,
        reserveCredits: Number.NaN,
        tightMultiple: 2,
        allowanceRequired: true,
      } as never);
      expect(noReserve.verdict).toBe('unreadable');
      expect(noReserve.ok).toBe(false);

      // And `allowanceRequired: false` does NOT waive it — that flag waives an unread BALANCE, and
      // here the plan's own cost is what could not be established, so there is nothing to waive.
      const unguarded = decideOne({
        plan: PLAN,
        estimate: estimatePlanCredits({ ...PLAN, bytesPerRow: 'many' } as never),
        allowance: rich,
        reserveCredits: 25,
        tightMultiple: 2,
        allowanceRequired: false,
      } as never);
      expect(unguarded.ok).toBe(false);
    }
  });

  it('always carries what it cannot see — the lag and the shared key', () => {
    // These two are the honest limits of the whole guard and they are not optional on any verdict,
    // including the passing ones. A guard whose limitations only appear on failure reads as
    // authoritative exactly when it is being trusted.
    for (const allowance of [parseUsageResponse(usageBody([period(0)]), NOW_MS).allowance, null]) {
      const d = decide(allowance);
      expect(d.caveats).toEqual([ALLOWANCE_LAG_CAVEAT, ALLOWANCE_SHARED_CAVEAT]);
    }
    expect(ALLOWANCE_LAG_CAVEAT).toMatch(/\+6\.0 credits while/);
    expect(ALLOWANCE_SHARED_CAVEAT).toMatch(/A sufficient reading is evidence, never a reservation/);
    // And the operator-facing rendering carries both, so they reach a terminal and not only a doc.
    const lines = describeAllowanceDecision(decide(null)).join('\n');
    expect(lines).toContain(ALLOWANCE_LAG_CAVEAT);
    expect(lines).toContain(ALLOWANCE_SHARED_CAVEAT);
  });
});

// ---------------------------------------------------------------------------------------------
// THE SPINE: a run refuses rather than proceeding when the remaining allowance cannot cover it.

describe('THE CENSUS REFUSES BEFORE IT SPENDS, END TO END', () => {
  /**
   * Drive the real CLI with a scripted transport. `POST /usage` is the only call it should reach.
   */
  async function run(usage: unknown, argv: readonly string[] = ['--live', '--month', '2026-07']) {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      const path = String(url).slice(DUNE_API_BASE.length);
      paths.push(path);
      if (path === USAGE_PATH) return new Response(JSON.stringify(usage), { status: 200 });
      // Anything else means the guard let the run through. Answering plausibly rather than throwing
      // keeps the assertion about WHAT WAS CALLED rather than about how a stub blew up.
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as unknown as typeof fetch);
    const lines: string[] = [];
    try {
      const out = mkdtempSync(join(tmpdir(), 'slot-zero-credit-'));
      const code = await censusMain([...argv, '--out', out], { DUNE_API_KEY: SENTINEL_KEY }, (l) => lines.push(l));
      return { code, paths, lines: lines.join('\n') };
    } finally {
      spy.mockRestore();
    }
  }

  it('refuses, spends NO execution, and never even verifies the saved query', async () => {
    // The failure this whole task exists to prevent: a multi-query run that burns most of the month,
    // dies partway, and leaves neither a result nor the credits to retry. Stopping here — before the
    // saved-query GET, before the execution POST, before the billed result read — is the deliverable.
    const bounds = readBounds();
    const worst = 25 * bounds.dune.maxExecutionsPerRun + 100; // comfortably above any real plan
    const { code, paths, lines } = await run(usageBody([period(2500 - worst / 4)]));

    expect(code).toBe(EXIT.refused);
    // ONE request, and it is the free one.
    expect(paths).toEqual([USAGE_PATH]);
    expect(paths.some((p) => p.includes('/execute'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/query/'))).toBe(false);
    expect(lines).toMatch(/dune allowance: INSUFFICIENT/);
    expect(lines).toMatch(/REFUSED before the first execution/);
    expect(lines).toMatch(/credit\(s\) short/);
    // And it names the period, so an operator knows whether waiting fixes it.
    expect(lines).toMatch(/The period rolls on 2026-08-29/);
  });

  it('refuses when the allowance cannot be read at all', async () => {
    const { code, paths, lines } = await run({ nothing: 'useful' });
    expect(code).toBe(EXIT.refused);
    expect(paths).toEqual([USAGE_PATH]);
    expect(lines).toMatch(/dune allowance: UNREADABLE/);
    expect(lines).toMatch(/an unreadable balance is not headroom/);
  });

  it('proceeds past the guard when the allowance covers the plan', async () => {
    // The control. Without it the two refusals above are consistent with a guard that refuses
    // everything, which would be a different kind of broken.
    const { code, paths, lines } = await run(usageBody([period(0)]));
    expect(paths[0]).toBe(USAGE_PATH);
    expect(paths.length).toBeGreaterThan(1);
    expect(lines).toMatch(/dune allowance: SUFFICIENT/);
    // It goes on to fail on the stubbed saved-query comparison, which is the NEXT gate and not
    // this one's business. What matters is that it got there.
    expect(code).not.toBe(EXIT.ok);
  });

  it('prints the worst case with no key at all, on the dry run', async () => {
    // Estimating before spending must not itself need a credential, or the cheapest way to learn
    // what a run costs would be to start one.
    const lines: string[] = [];
    const code = await censusMain([], {}, (l) => lines.push(l));
    expect(code).toBe(EXIT.ok);
    expect(lines.join('\n')).toMatch(/worst case\s+[\d.]+ credit\(s\)/);
    expect(lines.join('\n')).toMatch(/the allowance itself is NOT read here/);
  });

  it('never puts the credential in anything it prints', async () => {
    // Every failure path above is driven through a sentinel key. It may reach no line of output —
    // the key is sent as a HEADER, interpolated in exactly one place, so nothing this client builds
    // can carry it.
    const refused = await run(usageBody([period(2499)]));
    const unreadable = await run(null);
    for (const out of [refused.lines, unreadable.lines]) {
      expect(out).not.toContain(SENTINEL_KEY);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('THE SCREEN REFUSES BEFORE ITS FIRST BILLED READ', () => {
  function client(onFetch: (path: string) => Response) {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      const path = String(url).slice(DUNE_API_BASE.length);
      paths.push(path);
      return onFetch(path);
    });
    const c = new ScreenDuneClient({
      key: SENTINEL_KEY,
      maxExecutions: 2,
      maxRequests: 20,
      minIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    return { c, paths };
  }

  const BOUNDS = {
    maxExecutionsPerRun: 2,
    maxResultRows: 20_000,
    worstCaseCreditsPerExecution: 25,
    resultBytesPerRowCeiling: 121,
    allowanceReserveCredits: 25,
    allowanceTightMultiple: 2,
    allowanceRequired: true,
    pollIntervalMs: 0,
    maxPollAttempts: 5,
    maxCoverageLagMs: 21_600_000,
  };

  it('checks the allowance BEFORE the coverage probe, which is itself a billed read', async () => {
    const { c, paths } = await Promise.resolve(
      client((path) =>
        path === USAGE_PATH
          ? new Response(JSON.stringify(usageBody([period(2_499)])), { status: 200 })
          : new Response(JSON.stringify({}), { status: 200 }),
      ),
    );
    const checked = await checkDuneAllowance(c, { bounds: BOUNDS, nowMs: NOW_MS });
    expect(checked.decision.verdict).toBe('insufficient');

    const e = await enumerateCreations(c, {
      wallets: [WALLET],
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      allowance: checked.decision,
    });
    // Nothing beyond the free usage read was issued: no probe, no SQL verification, no execution.
    expect(paths).toEqual([USAGE_PATH]);
    expect(c.executions()).toBe(0);
    // And every wallet falls back to the RPC walk with the reason — never reported as having
    // created nothing, which is the reading this whole module exists to refuse.
    const w = e.byWallet.get(WALLET)!;
    expect(w.usable).toBe(false);
    expect(w.launches).toBe(0);
    expect(w.reasons.join(' ')).toMatch(/REFUSED before the first execution/);
    expect(e.coverage.ok).toBe(false);
    expect(e.coverage.fromMs).toBeNull();
  });

  it('refuses outright when the caller never checked at all', async () => {
    // Not having checked is not the same as having checked and been cleared. A caller that forgets
    // must get the refusal, not the enumeration — the guard has to bind where the requests are
    // issued and not only at the one call site that remembers it today.
    const { c, paths } = client(() => new Response(JSON.stringify({}), { status: 200 }));
    const e = await enumerateCreations(c, {
      wallets: [WALLET],
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
    } as never);
    expect(paths).toEqual([]);
    expect(c.executions()).toBe(0);
    expect(e.byWallet.get(WALLET)!.reasons.join(' ')).toMatch(/never checked for this run/);
  });

  it('treats a transport failure on the free read as an unknown balance, not as headroom', async () => {
    const { c } = client(() => {
      throw new Error('socket hang up');
    });
    const checked = await checkDuneAllowance(c, { bounds: BOUNDS, nowMs: NOW_MS });
    expect(checked.decision.verdict).toBe('unreadable');
    expect(checked.decision.ok).toBe(false);
    expect(checked.decision.reasons.join(' ')).not.toContain(SENTINEL_KEY);
  });

  it('lets a cleared allowance through to the probe', async () => {
    // The control for this half: the guard must not be refusing on something other than the balance.
    const { c, paths } = client((path) =>
      path === USAGE_PATH
        ? new Response(JSON.stringify(usageBody([period(0)])), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 }),
    );
    const checked = await checkDuneAllowance(c, { bounds: BOUNDS, nowMs: NOW_MS });
    expect(checked.decision.ok).toBe(true);
    await enumerateCreations(c, {
      wallets: [WALLET],
      creationQueryId: 1,
      coverageQueryId: 2,
      refreshProbe: false,
      nowMs: NOW_MS,
      bounds: BOUNDS,
      allowance: checked.decision,
    }).catch(() => undefined);
    expect(paths.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("STAGE 2's ENTRY FILL SOURCE REFUSES BEFORE ITS FIRST BILLED READ", () => {
  // Captain decision 317a, 2026-08-06. The dual-source Stage 2 leg is the first path on which this
  // screen spends a Dune credit INSIDE Stage 2, and as first committed it built its client and went
  // straight to the trade-table coverage probe — a billed result read — with the balance never
  // examined. The enumeration's own check sits far downstream and prices a different plan, so it
  // could not have caught this. Everything here drives a stubbed transport: this lane executes no
  // billed Dune call, and `POST /usage` is free by Dune's own documentation.
  const AGREEMENT = JSON.parse(readFileSync(THRESHOLDS, 'utf8')).entry_source_agreement as {
    maxExecutionsPerRun: number;
    maxRequestsPerRun: number;
    maxResultRowsPerWindow: number;
    resultBytesPerRowCeiling: number;
    worstCaseCreditsPerWindow: number;
    worstCaseComputeCreditsPerExecution: number;
  };
  const DUNE_BOUNDS = {
    pollIntervalMs: 0,
    maxPollAttempts: 5,
    maxResultRows: 20_000,
    maxCoverageLagMs: 21_600_000,
    allowanceReserveCredits: 25,
    allowanceTightMultiple: 2,
    allowanceRequired: true,
  };
  /** The ENUMERATION leg's own ceilings — the second spender on the same balance. */
  const ENUMERATION_BOUNDS = {
    maxExecutionsPerRun: 2,
    maxResultRows: 20_000,
    worstCaseCreditsPerExecution: 25,
    resultBytesPerRowCeiling: 121,
    allowanceReserveCredits: 25,
    allowanceTightMultiple: 2,
    allowanceRequired: true,
  };

  function client(onFetch: (path: string) => Response) {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      const path = String(url).slice(DUNE_API_BASE.length);
      paths.push(path);
      return onFetch(path);
    });
    const c = new ScreenDuneClient({
      key: SENTINEL_KEY,
      maxExecutions: AGREEMENT.maxExecutionsPerRun,
      maxRequests: AGREEMENT.maxRequestsPerRun,
      minIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    return { c, paths };
  }

  /** Windows a FULL-SIZE plan carries: the pinned ceiling, which is what 318a's derivation sizes. */
  const FULL_WINDOWS = (
    JSON.parse(readFileSync(THRESHOLDS, 'utf8')).entry_source_agreement as { maxWindowsPerRun: number }
  ).maxWindowsPerRun;

  const build = (
    c: ScreenDuneClient,
    over: { announce?: (l: string) => void; windowsPlanned?: number; ledger?: DuneCreditLedger } = {},
  ) =>
    buildDuneEntryFillSource(c, {
      agreementBounds: AGREEMENT as never,
      duneBounds: DUNE_BOUNDS,
      windowsPlanned: over.windowsPlanned ?? FULL_WINDOWS,
      ledger: over.ledger,
      refreshProbe: false,
      nowMs: NOW_MS,
      announce: over.announce,
    });

  it('prices its OWN ceilings, with retrieval counted exactly once', () => {
    // `estimatePlanCredits` derives retrieval from `resultReads x rowsPerRead x bytesPerRow`, so the
    // per-execution figure it is handed must be COMPUTE ONLY. `worstCaseCreditsPerWindow` is a
    // composite (1 compute + 16 retrieval by its own justification) and handing it over would charge
    // retrieval twice — roughly doubling a figure a spend approval is read from.
    const plan = tradeFillSpendPlan(AGREEMENT, FULL_WINDOWS);
    const estimate = estimatePlanCredits(plan);
    expect(plan.creditsPerExecution).toBe(AGREEMENT.worstCaseComputeCreditsPerExecution);
    expect(plan.creditsPerExecution).toBeLessThan(AGREEMENT.worstCaseCreditsPerWindow);
    expect(estimate.executionCredits).toBe(
      AGREEMENT.maxExecutionsPerRun * AGREEMENT.worstCaseComputeCreditsPerExecution,
    );
    // Retrieval is the dominant term and it is derived, not carried.
    expect(estimate.exportCredits).toBeGreaterThan(estimate.executionCredits);
    expect(estimate.exportBytes).toBe(
      (AGREEMENT.maxExecutionsPerRun + 1) * AGREEMENT.maxResultRowsPerWindow * AGREEMENT.resultBytesPerRowCeiling,
    );
    // And the probe's own result read is inside the plan: it is billed by bytes whether or not it
    // cost an execution, and it is this leg's FIRST billed request.
    expect(plan.resultReads).toBe(AGREEMENT.maxExecutionsPerRun + 1);
    // 318a's derivation, computed rather than restated: a FULL-SIZE plan is the windows plus the
    // probe plus one of headroom, which is exactly the pinned execution ceiling.
    expect(agreementExecutionsFor(AGREEMENT, FULL_WINDOWS)).toBe(AGREEMENT.maxExecutionsPerRun);
  });

  it('prices the windows the run PLANS, so a reduced-scale run is judged on its own arithmetic', () => {
    // Captain decision 321a. Priced at the ceiling instead, a 2-candidate run — the reduced-scale
    // option the committed estimate artefact recommends — was refused identically to a full one.
    const small = tradeFillSpendPlan(AGREEMENT, 20);
    const full = tradeFillSpendPlan(AGREEMENT, FULL_WINDOWS);
    expect(small.executions).toBe(22);
    expect(small.resultReads).toBe(23);
    expect(estimatePlanCredits(small).worstCaseCredits).toBeLessThan(
      estimatePlanCredits(full).worstCaseCredits,
    );
    // THE CEILING IS STILL A CEILING: a plan larger than the pins admit cannot price itself higher.
    expect(agreementExecutionsFor(AGREEMENT, FULL_WINDOWS * 10)).toBe(AGREEMENT.maxExecutionsPerRun);
    expect(tradeFillSpendPlan(AGREEMENT, FULL_WINDOWS * 10).executions).toBe(AGREEMENT.maxExecutionsPerRun);
  });

  it('a reduced-scale plan CLEARS a balance the full-size one does not', async () => {
    // The consequence stated end to end, through the real guard: at a balance that refuses the full
    // plan, the smaller one this document recommends actually gets through.
    const usage = (path: string) =>
      path === USAGE_PATH
        ? new Response(JSON.stringify(usageBody([period(2_500 - 600)])), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 });
    const full = client(usage);
    await expect(build(full.c)).rejects.toThrow(/refuses to spend/);
    expect(full.c.executions()).toBe(0);

    const small = client(usage);
    // It gets past the allowance and is stopped by the UNDEPLOYED probe instead, which is the next
    // gate and not this one — and still bills nothing.
    await expect(build(small.c, { windowsPlanned: 20 })).rejects.toThrow(/no deployed saved query/);
    expect(small.paths).toEqual([USAGE_PATH]);
    expect(small.c.executions()).toBe(0);
  });

  it('ONE reservation for the run: a cleared leg is held against the next one', async () => {
    // Captain decision 320a. Two legs reading the same balance and each deciding alone can both pass
    // while their COMBINED worst case overruns it — time-of-check-to-time-of-use, against the rule
    // the estimate artefact itself states: a balance reading is never a reservation.
    const ledger = openDuneCreditLedger();
    const entryPlan = tradeFillSpendPlan(AGREEMENT, 20);
    const entryWorstCase = estimatePlanCredits(entryPlan).worstCaseCredits;
    const enumerationWorstCase = estimatePlanCredits(duneSpendPlan(ENUMERATION_BOUNDS)).worstCaseCredits;
    // A balance that fits EITHER leg alone but not BOTH, which is the whole hazard.
    const remaining = entryWorstCase + enumerationWorstCase - 1 + DUNE_BOUNDS.allowanceReserveCredits;
    const { c, paths } = client((path) =>
      path === USAGE_PATH
        ? new Response(JSON.stringify(usageBody([period(2_500 - remaining)])), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 }),
    );

    const first = await checkDuneAllowance(c, {
      bounds: DUNE_BOUNDS,
      nowMs: NOW_MS,
      plan: entryPlan,
      ledger,
    });
    expect(first.decision.ok).toBe(true);
    expect(ledger.reservedCredits()).toBe(entryWorstCase);

    const second = await checkDuneAllowance(c, { bounds: ENUMERATION_BOUNDS, nowMs: NOW_MS, ledger });
    expect(second.decision.ok).toBe(false);
    expect(second.decision.reasons.join(' ')).toMatch(/already held by an earlier leg/);
    // The reading is taken ONCE and cached: a second read would be a second answer to one question,
    // and the run would hold two beliefs about a balance that moves under it.
    expect(paths).toEqual([USAGE_PATH]);

    // And WITHOUT the shared ledger both legs pass — which is the defect, reproduced.
    const solo = client((path) =>
      path === USAGE_PATH
        ? new Response(JSON.stringify(usageBody([period(2_500 - remaining)])), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 }),
    );
    const a = await checkDuneAllowance(solo.c, { bounds: DUNE_BOUNDS, nowMs: NOW_MS, plan: entryPlan });
    const b = await checkDuneAllowance(solo.c, { bounds: ENUMERATION_BOUNDS, nowMs: NOW_MS });
    expect(a.decision.ok && b.decision.ok).toBe(true);
    // Both cleared, and together they exceed what either was compared against — the spendable
    // balance, i.e. the reading less the reserve held back for the counter's lag.
    expect(a.estimate.worstCaseCredits + b.estimate.worstCaseCredits).toBeGreaterThan(
      remaining - DUNE_BOUNDS.allowanceReserveCredits,
    );
  });

  it('a single-leg run is unchanged: nothing is held and the verdict is what it always was', async () => {
    // The control for 320a. A default run has ONE spending leg, so the ledger holds nothing before
    // it and its verdict must be identical to the ledgerless one.
    const usage = (path: string) =>
      path === USAGE_PATH
        ? new Response(JSON.stringify(usageBody([period(1_000)])), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 });
    const withLedger = await checkDuneAllowance(client(usage).c, {
      bounds: ENUMERATION_BOUNDS,
      nowMs: NOW_MS,
      ledger: openDuneCreditLedger(),
    });
    const without = await checkDuneAllowance(client(usage).c, { bounds: ENUMERATION_BOUNDS, nowMs: NOW_MS });
    expect(withLedger.decision).toEqual(without.decision);
  });

  it('an UNREADABLE balance is read once and refuses every leg', async () => {
    // A second read after a failure would be a second answer, and the run would then hold two
    // beliefs about a balance it could not see at all.
    const ledger = openDuneCreditLedger();
    const { c } = client(() => {
      throw new Error('socket hang up');
    });
    const first = await checkDuneAllowance(c, { bounds: ENUMERATION_BOUNDS, nowMs: NOW_MS, ledger });
    const second = await checkDuneAllowance(c, { bounds: ENUMERATION_BOUNDS, nowMs: NOW_MS, ledger });
    expect(first.decision.verdict).toBe('unreadable');
    expect(second.decision.verdict).toBe('unreadable');
    expect(ledger.reservedCredits()).toBe(0);
  });

  it('reads the balance and REFUSES before the coverage probe, having billed nothing', async () => {
    const { c, paths } = client((path) =>
      path === USAGE_PATH
        ? new Response(JSON.stringify(usageBody([period(2_499)])), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 }),
    );
    const lines: string[] = [];
    await expect(build(c, { announce: (l) => void lines.push(l) })).rejects.toThrow(/refuses to spend/);
    // The free usage read and nothing else: no saved-query comparison, no probe, no execution.
    expect(paths).toEqual([USAGE_PATH]);
    expect(c.executions()).toBe(0);
    // And the refusal is a reported outcome rather than a stack trace: it says what it could not
    // afford and that nothing was taken.
    expect(lines.join('\n')).toMatch(/dune allowance: INSUFFICIENT/);
    await expect(build(c)).rejects.toThrow(/NOTHING WAS REQUESTED AND NOTHING WAS BILLED/);
    expect(lines.join('\n')).not.toContain(SENTINEL_KEY);
  });

  it('refuses on an UNREADABLE balance too — that is not headroom', async () => {
    const { c, paths } = client(() => {
      throw new Error('socket hang up');
    });
    await expect(build(c)).rejects.toThrow(/refuses to spend/);
    expect(c.executions()).toBe(0);
    // The client retries the free read once; nothing beyond it was ever attempted.
    expect(new Set(paths)).toEqual(new Set([USAGE_PATH]));
  });

  it('a CLEARED balance goes on to the probe, which is the next gate and not this one', async () => {
    // The control: the refusal above must be the BALANCE and not something else failing first. With
    // credits available the guard passes and the undeployed trade-coverage probe refuses instead —
    // which is also the proof of ORDER, since only one of the two can be the message.
    const { c, paths } = client((path) =>
      path === USAGE_PATH
        ? new Response(JSON.stringify(usageBody([period(0)])), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 }),
    );
    const lines: string[] = [];
    await expect(build(c, { announce: (l) => void lines.push(l) })).rejects.toThrow(/no deployed saved query/);
    expect(lines.join('\n')).toMatch(/dune allowance: (SUFFICIENT|TIGHT)/);
    // Still nothing billed — the probe refuses before it reaches the vendor at all.
    expect(paths).toEqual([USAGE_PATH]);
    expect(c.executions()).toBe(0);
  });
});
