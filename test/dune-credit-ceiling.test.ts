/**
 * **The Dune monthly credit ceiling: a thing this project can SEE and REFUSE against.**
 *
 * Dune bills a monthly allowance per ACCOUNT — capped again by the operator's own configured
 * number since captain decision 322a, and the smaller of the two binds — and a FAILED execution is
 * billed exactly like a successful one. Before the guard these tests pin, both keyed tools discovered that
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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  ALLOWANCE_ACCOUNT_WIDE_CAVEAT,
  ALLOWANCE_LAG_CAVEAT,
  describeMonthlyCapCredits,
  LOCAL_ESTIMATE_CAVEAT,
  MONTHLY_CAP_PIN,
  bindingCreditCeiling,
  CREDITS_PER_ENGINE_MINUTE,
  ENGINE_TIMEOUT_MS,
  EXECUTION_DEADLINE_CAVEAT,
  EXPORT_CREDITS_PER_MB,
  MEASURED_TIMEOUT_FLOOR_CREDITS,
  USAGE_PATH,
  describeExecutionDeadline,
  executionDeadlineCredits,
} from '../tools/deployer-screen/client.mjs';
import {
  DuneClient as CensusDuneClient,
  DUNE_API_BASE,
  decideAllowance as censusDecideAllowance,
  parseUsageResponse as censusParseUsageResponse,
  estimatePlanCredits as censusEstimatePlanCredits,
  executionDeadlineCredits as censusExecutionDeadlineCredits,
  EXECUTION_DEADLINE_CAVEAT as CENSUS_DEADLINE_CAVEAT,
} from '../tools/creation-census/client.mjs';
import {
  DUNE_LEG_ORDER,
  checkDuneAllowance,
  duneSpendPlan,
  enumerateCreations,
  executeAndRead as screenExecuteAndRead,
  openDuneCreditLedger,
} from '../tools/deployer-screen/dune.mjs';
import type { DuneCreditLedger } from '../tools/deployer-screen/dune.mjs';
import { ENTRY_QUERY_ID, agreementExecutionsFor, tradeFillSpendPlan } from '../tools/deployer-screen/dune-fills.mjs';
import {
  ENTRY_FILL_SOURCE_KIND,
  buildDuneEntryFillSource,
  duneFillSourceContradiction,
  duneFillSourceCredentialRefusal,
  entrySourceKindsRead,
  loadThresholds as screenLoadThresholds,
  main as screenMain,
  parseArgs as screenParseArgs,
} from '../tools/deployer-screen/screen.mjs';
import { BASE_URL as MADEONSOL_BASE_URL } from '../tools/deployer-screen/client.mjs';
import {
  EXIT,
  checkDuneAllowance as censusCheckDuneAllowance,
  executeAndRead as censusExecuteAndRead,
  main as censusMain,
  readBounds,
} from '../tools/creation-census/run.mjs';
import {
  ALLOWANCE_RESERVE_CREDITS as REPRODUCTION_RESERVE,
  WORST_CASE_CREDITS_PER_EXECUTION as REPRODUCTION_CREDITS_PER_EXECUTION,
  checkReproductionAllowance,
  estimateReproductionCredits,
  monthlyCreditCapCredits as reproductionCapCredits,
  recordCustody,
} from '../tools/deployer-screen/dune-reproduction.mjs';
import { CENSUS_SQL } from '../tools/creation-census/census.mjs';

const SCREEN_CLIENT = fileURLToPath(new URL('../tools/deployer-screen/client.mjs', import.meta.url));
const CENSUS_CLIENT = fileURLToPath(new URL('../tools/creation-census/client.mjs', import.meta.url));
const THRESHOLDS = fileURLToPath(new URL('../tools/deployer-screen/thresholds.json', import.meta.url));
const SCREEN_MAIN = fileURLToPath(new URL('../tools/deployer-screen/screen.mjs', import.meta.url));

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

/**
 * The operator's configured monthly cap, as the two keyed lanes pin it. Above the vendor's 2,500
 * plan, so the VENDOR figure binds in every case that does not deliberately say otherwise — which is
 * what keeps the cases below comparable with what this guard did before captain decision 322a.
 */
const CAP = 4000;

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
        monthlyCapCredits: CAP,
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
      monthlyCapCredits: CAP,
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
      monthlyCapCredits: CAP,
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
        monthlyCapCredits: CAP,
        tightMultiple: 2,
        allowanceRequired: true,
      } as never);
      expect(broken.verdict).toBe('unreadable');
      expect(broken.ok).toBe(false);
      expect(broken.reasons.join(' ')).toMatch(/not a finite positive number of credits/);
      // AND IT NAMES THE BOUND THAT ACTUALLY BROKE. This branch fires for three different causes,
      // so an operator whose plan or reserve is unpriceable must not be sent to the cap — the one
      // bound that read fine, and the one whose lever (raise it) would change nothing here.
      expect(broken.reasons.join(' ')).toMatch(/the plan's worst case priced to/);
      expect(broken.reasons.join(' ')).not.toContain(MONTHLY_CAP_PIN);

      // A non-finite RESERVE is the same failure from the other side: it makes `spendable` NaN.
      const noReserve = decideOne({
        plan: PLAN,
        estimate,
        allowance: rich,
        reserveCredits: Number.NaN,
        monthlyCapCredits: CAP,
        tightMultiple: 2,
        allowanceRequired: true,
      } as never);
      expect(noReserve.verdict).toBe('unreadable');
      expect(noReserve.ok).toBe(false);
      expect(noReserve.reasons.join(' ')).toMatch(/the reserve priced to/);
      expect(noReserve.reasons.join(' ')).not.toContain(MONTHLY_CAP_PIN);

      // And `allowanceRequired: false` does NOT waive it — that flag waives an unread BALANCE, and
      // here the plan's own cost is what could not be established, so there is nothing to waive.
      const unguarded = decideOne({
        plan: PLAN,
        estimate: estimatePlanCredits({ ...PLAN, bytesPerRow: 'many' } as never),
        allowance: rich,
        reserveCredits: 25,
        monthlyCapCredits: CAP,
        tightMultiple: 2,
        allowanceRequired: false,
      } as never);
      expect(unguarded.ok).toBe(false);
    }
  });

  it('always carries what it cannot see — the lag, and one account many lanes', () => {
    // These two are the honest limits of the whole guard and they are not optional on any verdict,
    // including the passing ones. A guard whose limitations only appear on failure reads as
    // authoritative exactly when it is being trusted.
    //
    // THE SECOND ONE WAS CORRECTED BY CAPTAIN DECISION 322a AND NOT REMOVED. The key is the
    // captain's alone, so "another holder can spend it between this reading and this run" stopped
    // being true; every lane and run of this fleet still draws on one monthly total and nothing
    // tracks it between runs, so a reading is still evidence and never a reservation.
    for (const allowance of [parseUsageResponse(usageBody([period(0)]), NOW_MS).allowance, null]) {
      const d = decide(allowance);
      expect(d.caveats).toEqual([ALLOWANCE_LAG_CAVEAT, ALLOWANCE_ACCOUNT_WIDE_CAVEAT]);
    }
    expect(ALLOWANCE_LAG_CAVEAT).toMatch(/\+6\.0 credits while/);
    expect(ALLOWANCE_ACCOUNT_WIDE_CAVEAT).toMatch(/A sufficient reading is evidence, never a reservation/);
    // And the operator-facing rendering carries both, so they reach a terminal and not only a doc.
    const lines = describeAllowanceDecision(decide(null)).join('\n');
    expect(lines).toContain(ALLOWANCE_LAG_CAVEAT);
    expect(lines).toContain(ALLOWANCE_ACCOUNT_WIDE_CAVEAT);
    // "Unshared" and "the counter is exact" are different claims and only the first one changed.
    // The reserve is still held back, and the lag caveat still says why.
    expect(ALLOWANCE_ACCOUNT_WIDE_CAVEAT).toMatch(/UNSHARED/);
    expect(ALLOWANCE_LAG_CAVEAT).toMatch(/subtracts a pinned reserve before comparing/);
    expect(decide(parseUsageResponse(usageBody([period(0)]), NOW_MS).allowance).reserveCredits).toBe(25);
  });
});

// ---------------------------------------------------------------------------------------------
// CAPTAIN DECISION 322a: the captain's own monthly cap BINDS, and the vendor's plan is only one half
// of the comparison.
//
// The defect: `decideAllowance` compared a plan against `creditsRemaining`, derived from whatever
// the vendor reported as `credits_included`. Nothing anywhere knew the captain's cap existed. At a
// plan of 2,500 under a cap of 4,000 that was invisible — and on an account upgraded past the cap it
// would have spent straight through the captain's number without noticing.
//
// BOTH HALVES OF THE REQUIREMENT ARE TESTED, because they fail in opposite directions and a guard
// that only ever exercises one side of a `min()` has not been tested at all: a cap that can be
// exceeded fails "I do not want to exceed it", and a cap that needlessly refuses runs fails "still
// use it all in a smart way".

describe('TWO CEILINGS, AND THE SMALLER ONE BINDS', () => {
  const estimate = estimatePlanCredits(PLAN);
  const decide = (allowance: unknown, monthlyCapCredits: unknown = CAP) =>
    screenDecideAllowance({
      plan: PLAN,
      estimate,
      allowance,
      reserveCredits: 25,
      monthlyCapCredits,
      tightMultiple: 2,
      allowanceRequired: true,
    } as never);

  /** A vendor plan LARGER than the operator's cap — the configuration this guard exists for. */
  const upgraded = (used: number) => parseUsageResponse(usageBody([period(used, 10_000)]), NOW_MS).allowance;
  /** A vendor plan SMALLER than the cap — today's account, where the vendor is what binds. */
  const freeTier = (used: number) => parseUsageResponse(usageBody([period(used, 2_500)]), NOW_MS).allowance;

  it('resolves the two into the smaller, with a tie going to the vendor', () => {
    expect(bindingCreditCeiling(4_000, 10_000)).toEqual({
      ceilingCredits: 4_000,
      binding: 'operator-cap',
      monthlyCapCredits: 4_000,
      vendorCreditsIncluded: 10_000,
    });
    expect(bindingCreditCeiling(4_000, 2_500).ceilingCredits).toBe(2_500);
    expect(bindingCreditCeiling(4_000, 2_500).binding).toBe('vendor-plan');
    // At equality either label is arithmetically honest, so it goes to the externally-imposed one:
    // raising the cap then buys nothing, which is what `vendor-plan` tells an operator to expect.
    expect(bindingCreditCeiling(4_000, 4_000).binding).toBe('vendor-plan');
  });

  it('THE CAP BINDS when the cap is the smaller number, and the vendor still had room', () => {
    // 10,000 included, 6,500 used: the vendor says 3,500 remain and would clear this plan easily.
    // The captain's 4,000 cap says 4,000 - 6,500 is nothing left at all, and the cap is what refuses.
    const d = decide(upgraded(6_500));
    expect(d.verdict).toBe('insufficient');
    expect(d.ok).toBe(false);
    expect(d.bindingCeiling).toBe('operator-cap');
    expect(d.creditsIncluded).toBe(4_000);
    expect(d.creditsRemaining).toBe(0);
    // NEITHER FIGURE IS SILENTLY REWRITTEN INTO THE OTHER: both survive on the decision and in the
    // sentences, so an operator can tell a cap they set from a plan they were sold.
    expect(d.monthlyCapCredits).toBe(4_000);
    expect(d.creditsIncludedVendor).toBe(10_000);
    const said = d.reasons.join(' ');
    expect(said).toMatch(/THE OPERATOR CAP is what refused this run/);
    expect(said).toContain('4000');
    expect(said).toContain('10000');
    expect(said).toContain(MONTHLY_CAP_PIN);
    // And which lever clears it: raise the cap, or wait. Both are named, and the reserve is stated.
    expect(said).toMatch(/raising dune\.monthlyCreditCapCredits clears it now/);
    expect(said).toMatch(/The period rolls on 2026-08-29/);
    expect(said).toMatch(/25-credit reserve/);
  });

  it('THE VENDOR FIGURE BINDS when it is the smaller number, and says the cap is not the fix', () => {
    // The mirror, and the case a `min()` that only ever consulted the cap would get wrong: at the
    // Free tier the vendor's 2,500 is below the captain's 4,000, so the vendor is what refuses and
    // raising the cap would change nothing. An operator has to be able to tell these apart.
    const d = decide(freeTier(2_500 - (estimate.worstCaseCredits - 1)));
    expect(d.verdict).toBe('insufficient');
    expect(d.bindingCeiling).toBe('vendor-plan');
    expect(d.creditsIncluded).toBe(2_500);
    expect(d.monthlyCapCredits).toBe(4_000);
    expect(d.creditsIncludedVendor).toBe(2_500);
    const said = d.reasons.join(' ');
    expect(said).toMatch(/THE VENDOR'S PLAN is what refused this run/);
    expect(said).toMatch(/raising dune\.monthlyCreditCapCredits would change nothing/);
    expect(said).toContain('4000');
    expect(said).toMatch(/The period rolls on 2026-08-29/);
  });

  it('THE NEGATIVE CONTROL: the same balance CLEARS once the cap alone is raised', () => {
    // Without this the refusal above is consistent with a guard that refuses everything, which is a
    // different kind of broken. One input moves — the operator's own number — and the identical
    // balance that was refused now passes, so the cap is provably what bound it.
    const balance = upgraded(6_500);
    expect(decide(balance, 4_000).ok).toBe(false);
    const raised = decide(balance, 9_000);
    expect(raised.ok).toBe(true);
    expect(raised.bindingCeiling).toBe('operator-cap');
    expect(raised.creditsRemaining).toBe(2_500);
    // And raised ABOVE the vendor's plan, the vendor takes over as the binding ceiling — the same
    // balance, a third verdict, and every one of them names which number produced it.
    const uncapped = decide(balance, 12_000);
    expect(uncapped.bindingCeiling).toBe('vendor-plan');
    expect(uncapped.creditsIncluded).toBe(10_000);
    expect(uncapped.creditsRemaining).toBe(3_500);
  });

  it('COSTS A RUN NOTHING when it is not the smaller number — the second half of the requirement', () => {
    // "I do not want to exceed it but still use it all in a smart way." A cap that refused runs the
    // account could afford would fail that as surely as an overspend fails the first half. Above the
    // vendor's plan the decision is arithmetically what it was before this guard existed, and this
    // pins it field by field against a cap so large it can never bind.
    for (const used of [0, 1_000, 2_400]) {
      const at4000 = decide(freeTier(used), 4_000);
      const atAbsurd = decide(freeTier(used), 1_000_000);
      expect(at4000.verdict).toBe(atAbsurd.verdict);
      expect(at4000.creditsRemaining).toBe(atAbsurd.creditsRemaining);
      expect(at4000.spendableCredits).toBe(atAbsurd.spendableCredits);
      expect(at4000.creditsIncluded).toBe(2_500);
      expect(at4000.bindingCeiling).toBe('vendor-plan');
    }
    expect(decide(freeTier(0)).verdict).toBe('sufficient');
  });

  it('states BOTH ceilings on a PASSING verdict too, not only on a refusal', () => {
    // A figure quoted without the other one is the silent rewrite this decision forbids, and a
    // guard that only explains itself when it says no is read as authoritative exactly when it is
    // being trusted.
    for (const d of [decide(freeTier(0)), decide(upgraded(0)), decide(freeTier(2_000))]) {
      expect(d.ok).toBe(true);
      const said = d.reasons.join(' ');
      expect(said).toMatch(/Two ceilings apply and the SMALLER binds/);
      expect(said).toContain(String(d.monthlyCapCredits));
      expect(said).toContain(String(d.creditsIncludedVendor));
      expect(said).toContain(MONTHLY_CAP_PIN);
    }
    // The `tight` warning keeps its own sentence AND both ceilings.
    const tight = decide(freeTier(2_500 - (estimate.worstCaseCredits * 1.5 + 25)));
    expect(tight.verdict).toBe('tight');
    expect(tight.reasons.join(' ')).toMatch(/may be the last one this period can afford/);
    expect(tight.reasons.join(' ')).toMatch(/Two ceilings apply/);
  });

  it('REFUSES a cap it cannot read, rather than treating the vendor figure as the only ceiling', () => {
    // The cap is read from the same untyped JSON as every other pinned bound, so a missing or
    // non-numeric one reaches here as `undefined` or worse. Falling back to the vendor's figure
    // would leave a lane silently uncapped — the state this decision exists to end — so an
    // unreadable cap refuses in the same place, and by the same rule, as an unpriceable plan.
    const rich = parseUsageResponse(usageBody([period(0)]), NOW_MS).allowance;
    for (const bad of [undefined, null, 0, -1, Number.NaN, '4000', {}]) {
      for (const decideOne of [screenDecideAllowance, censusDecideAllowance]) {
        const d = decideOne({
          plan: PLAN,
          estimate,
          allowance: rich,
          reserveCredits: 25,
          monthlyCapCredits: bad,
          tightMultiple: 2,
          // And `allowanceRequired: false` does NOT waive it: that flag waives an unread BALANCE,
          // and here it is the operator's own ceiling that could not be established.
          allowanceRequired: false,
        } as never);
        expect(d.verdict, JSON.stringify(bad)).toBe('unreadable');
        expect(d.ok, JSON.stringify(bad)).toBe(false);
        expect(d.reasons.join(' ')).toMatch(/not a finite positive number of credits/);
        expect(d.reasons.join(' ')).toContain(MONTHLY_CAP_PIN);
      }
    }
  });

  it('keeps the configured cap visible when the BALANCE is what could not be read', () => {
    // Two different unknowns, and conflating them would hide which one to go and fix.
    const d = decide(null);
    expect(d.verdict).toBe('unreadable');
    expect(d.monthlyCapCredits).toBe(4_000);
    expect(d.creditsIncludedVendor).toBeNull();
    expect(d.bindingCeiling).toBeNull();
    expect(d.reasons.join(' ')).toMatch(/is configured and applies/);
  });

  it('reads the plan AND the period out of the response, so two keys do not share either', () => {
    // MEASURED FACT, 2026-08-06/07: this fleet holds more than one Dune key, and separate keys are
    // separate ACCOUNTS — one reported credits_included 2500 over 2026-07-29 -> 2026-08-29, another
    // 4000 over 2026-08-06 -> 2026-09-06. Nothing may carry a figure or a period from one to the
    // other, so the same cap has to reach a different verdict per key with no code change: on the
    // free account the vendor binds, on the larger one the two are equal and the tie goes to the
    // vendor. The dates here are FIXTURES exercising that, not pins.
    const free = parseUsageResponse(
      usageBody([period(2_044.357, 2_500, '2026-07-29', '2026-08-29')]),
      NOW_MS,
    ).allowance;
    const other = parseUsageResponse(
      usageBody([period(0, 4_000, '2026-08-06', '2026-09-06')]),
      Date.parse('2026-08-20T12:00:00.000Z'),
    ).allowance;

    const onFree = decide(free);
    expect(onFree.bindingCeiling).toBe('vendor-plan');
    expect(onFree.creditsIncluded).toBe(2_500);
    expect(onFree.periodEnd).toBe('2026-08-29');

    const onOther = decide(other);
    expect(onOther.bindingCeiling).toBe('vendor-plan');
    expect(onOther.creditsIncluded).toBe(4_000);
    expect(onOther.periodEnd).toBe('2026-09-06');
    expect(onOther.creditsRemaining).toBe(4_000);
    // The cap is the same number on both, and it is the only thing that is.
    expect(onFree.monthlyCapCredits).toBe(onOther.monthlyCapCredits);
    // AND THE LIMIT THIS CANNOT FIX, pinned as a property rather than left in prose: each verdict is
    // computed from ONE account's counter, so both of these clear their own cap independently and
    // the fleet's combined spend can reach twice it. Only one key, or a smaller cap on each, closes
    // that — a captain's decision, and the reason the guard says which account it read.
    expect(onFree.ok && onOther.ok).toBe(true);
  });

  it("320a's ONE reservation still holds, and it holds against the CAP when the cap is what binds", async () => {
    // The two decisions compose or neither is worth much: a run's second leg must be priced against
    // what the first was cleared to spend, AND that arithmetic must happen under the operator's
    // ceiling rather than the vendor's whenever the operator's is smaller. Here the vendor's plan is
    // three times the cap and has room for both legs; the cap has room for one.
    const BOUNDS = {
      maxExecutionsPerRun: 2,
      maxResultRows: 20_000,
      worstCaseCreditsPerExecution: 25,
      resultBytesPerRowCeiling: 121,
      allowanceReserveCredits: 25,
      monthlyCreditCapCredits: CAP,
      allowanceTightMultiple: 1,
      allowanceRequired: true,
    };
    const legWorstCase = estimatePlanCredits(duneSpendPlan(BOUNDS)).worstCaseCredits;
    // Spent so that ONE leg fits under the cap and two do not, while the vendor's own remaining
    // balance is far above both.
    const used = CAP - (legWorstCase * 2 - 1) - BOUNDS.allowanceReserveCredits;
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(usageBody([period(used, CAP * 3)])), { status: 200 }),
    );
    const c = new ScreenDuneClient({
      key: SENTINEL_KEY,
      maxExecutions: 2,
      maxRequests: 20,
      minIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    const ledger = openDuneCreditLedger();
    const first = await checkDuneAllowance(c, { bounds: BOUNDS, nowMs: NOW_MS, ledger, leg: 'enumeration' });
    expect(first.decision.ok).toBe(true);
    expect(first.decision.bindingCeiling).toBe('operator-cap');
    expect(ledger.reservedCredits()).toBe(legWorstCase);

    const second = await checkDuneAllowance(c, { bounds: BOUNDS, nowMs: NOW_MS, ledger, leg: 'enumeration' });
    expect(second.decision.ok).toBe(false);
    expect(second.decision.bindingCeiling).toBe('operator-cap');
    expect(second.decision.reasons.join(' ')).toMatch(/already held by an earlier leg/);
    // The vendor never refused either of them — the cap did, after the hold.
    expect(second.decision.creditsIncludedVendor).toBe(CAP * 3);
    // And the balance is still read exactly once for the whole run.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a PLAN that cannot read the cap says so in the live path\'s words, and never crashes', () => {
    // The two plan printers reach the SAME operator state decideAllowance answers with a named
    // refusal - a cap just edited and typoed - and used to answer it with a bare TypeError
    // (`undefined.toLocaleString`) and with the literal text `operator cap undefined`. That is the
    // failure 322a's naming requirement exists to prevent, on the one config surface 322a adds.
    for (const bad of [undefined, null, 0, -1, Number.NaN, '4000', {}]) {
      const said = describeMonthlyCapCredits(bad);
      expect(said, JSON.stringify(bad)).toContain(MONTHLY_CAP_PIN);
      expect(said, JSON.stringify(bad)).toMatch(/UNREADABLE/);
      // It must not imply the vendor's figure takes over - that is exactly what decideAllowance
      // refuses to do, and a plan saying otherwise would describe a run that cannot happen.
      expect(said).toMatch(/REFUSES before spending anything/);
    }
    // And the usable case is the figure, unchanged in meaning and formatted for a human.
    expect(describeMonthlyCapCredits(4000)).toBe('4,000 credits/month');
    // It RENDERS and never decides: the same value still reaches a verdict through decideAllowance,
    // which is the only thing that refuses.
    expect(screenDecideAllowance({
      plan: PLAN,
      estimate: estimatePlanCredits(PLAN),
      allowance: parseUsageResponse(usageBody([period(0)]), NOW_MS).allowance,
      reserveCredits: 25,
      monthlyCapCredits: undefined,
      tightMultiple: 2,
      allowanceRequired: true,
    } as never).verdict).toBe('unreadable');
  });

  it('the SCREEN dry run renders the named refusal instead of throwing, on a real plan', async () => {
    // End to end through the production renderer rather than the helper alone, because the defect
    // was at the interpolation site. No file is touched: renderDryRun takes the plan object, so the
    // absent pin is supplied rather than written to the committed thresholds.json - the isolation
    // rule the previous round established.
    const { renderDryRun } = await import('../tools/deployer-screen/render.mjs');
    const { windowReachMs } = await import('../tools/deployer-screen/pumpfun.mjs');
    const { resolveDuneCredential, resolveSolanaRpcEndpoint } = await import(
      '../tools/deployer-screen/credential.mjs'
    );
    const T = JSON.parse(readFileSync(THRESHOLDS, 'utf8'));
    const plan = (over: Record<string, unknown>) => ({
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
      entryEligibility: {
        known: true,
        kind: 'swap-api',
        minAgeMs: windowReachMs(T['stage2_entry']),
        billed: false,
      } as const,
      spendAuthorised: false,
      keyDescription: null,
      rpcEndpoint: resolveSolanaRpcEndpoint({}),
      indexedWalk: T['creation_walk_helius'],
      worstCaseCredits: 0,
      dune: { ...T['dune'], ...over },
      duneCredential: resolveDuneCredential({ DUNE_API_KEY: SENTINEL_KEY }),
      usingDune: true,
      duneRefreshProbe: false,
      allowWalkFallback: false,
    });
    for (const over of [{ monthlyCreditCapCredits: undefined }, { monthlyCreditCapCredits: 'lots' }]) {
      let text = '';
      expect(() => {
        text = renderDryRun(plan(over) as never);
      }, JSON.stringify(over)).not.toThrow();
      expect(text).toContain(MONTHLY_CAP_PIN);
      expect(text).toMatch(/operator cap\s+UNREADABLE/);
      // `undefined` must not survive into anything an operator reads as a number.
      expect(text).not.toMatch(/operator cap\s+undefined/);
    }
    // The control: with the real pin the line is the figure, so the guard is not swallowing it.
    expect(renderDryRun(plan({}) as never)).toContain(
      `operator cap                  ${describeMonthlyCapCredits(T['dune'].monthlyCreditCapCredits)}`,
    );
  });

  it('the CENSUS plan line renders through the same helper, not by raw interpolation', async () => {
    // The census reads its bounds from a fixed path, so its absent-pin path is covered by the helper
    // above rather than by rewriting the committed bounds.json. What is pinned here is that the site
    // USES the helper: reverting it to raw interpolation prints `4000 credit(s)/month` where the
    // shared renderer prints `4,000 credits/month`, and this fails.
    const lines: string[] = [];
    const code = await censusMain([], {}, (l) => lines.push(l));
    expect(code).toBe(EXIT.ok);
    const cap = readBounds().dune.monthlyCreditCapCredits;
    expect(lines.join('\n')).toContain(`operator cap   ${describeMonthlyCapCredits(cap)}`);
  });

  it('is ONE fleet-wide number: both keyed lanes pin the same cap, in configuration', () => {
    // GLOBAL means one monthly total across every lane that touches Dune. Neither keyed tool may
    // import the other, so the only way one cap governs both is the same remedy the guard's own
    // text uses: a duplicated value pinned here. A cap binding one lane and not the other would not
    // be a fleet-wide total, and the drift would be invisible until an overspend.
    const screen = JSON.parse(readFileSync(THRESHOLDS, 'utf8')).dune;
    const census = readBounds().dune;
    expect(screen.monthlyCreditCapCredits).toBeTypeOf('number');
    expect(screen.monthlyCreditCapCredits).toBeGreaterThan(0);
    expect(census.monthlyCreditCapCredits).toBe(screen.monthlyCreditCapCredits);
    // Both lanes must also carry a stated reason for it, like every other pinned bound.
    const j = JSON.parse(readFileSync(THRESHOLDS, 'utf8')).dune.justification;
    expect(j.monthlyCreditCapCredits).toBeTruthy();
    expect(readBounds().justification?.['dune.monthlyCreditCapCredits']).toBeTruthy();
  });

  it('NO LANE HOLDS A CAP OF ITS OWN: the ceiling applied is whatever configuration says, and only that', async () => {
    // Captain decision 321a's rule — the cap lives in configuration and never in code — TESTED AS
    // THE PROPERTY IT IS, rather than by looking for its digits in a source file. A numeric grep is
    // both too weak and too strong here: it read only the two `client.mjs` files while the lanes
    // that reach the cap are `dune.mjs`, `run.mjs` and `dune-reproduction.mjs`, and it would have
    // failed on an unrelated line the moment the captain lowered the cap to a number that already
    // appears somewhere (`status >= 500`, the 250 ms pacing floor). The cap is a CONFIG value the
    // captain is expected to change, so the guard must hold at ANY value they choose.
    //
    // THE PROPERTY, in two halves, at every wired call site: (1) move the configured number and the
    // ceiling the lane applies moves with it, in both directions; (2) TAKE THE KEY AWAY and the lane
    // REFUSES. A lane holding a literal of its own fails half (1) by ignoring the config, and fails
    // half (2) by clearing a run with no cap configured at all — which is the state 322a exists to
    // end. That is the guard shown failing rather than asserted, in this file's own idiom.
    const usage = (used: number, included: number) =>
      vi.fn(
        async () => new Response(JSON.stringify(usageBody([period(used, included)])), { status: 200 }),
      ) as unknown as typeof fetch;
    /** The three allowance policies both lanes read, with the cap left to each case. */
    const POLICY = { allowanceReserveCredits: 25, allowanceTightMultiple: 1, allowanceRequired: true };
    const worstCase = estimatePlanCredits(PLAN).worstCaseCredits;
    // A balance with plenty of vendor headroom, so the OPERATOR's number is the only thing that can
    // decide these runs: the vendor plan is far above either configured cap.
    const USED = 0;
    const VENDOR_INCLUDED = worstCase * 100;
    /** Below the run's worst case, so a lane honouring it must refuse. */
    const TIGHT = worstCase - 1 + POLICY.allowanceReserveCredits;
    /** Above it, so a lane honouring it must clear. */
    const ROOMY = worstCase * 10;

    // The reproduction lane prices its own plan, so its two caps are sized against ITS worst case
    // rather than against the shared one — the property under test is the same at either size.
    const BATCHES = [{ month: '2026-07', launches: [], plannedRows: 1_000 }];
    const reproductionWorst = estimateReproductionCredits(BATCHES).worstCaseCredits;
    const REPRODUCTION_TIGHT = reproductionWorst - 1 + REPRODUCTION_RESERVE;
    const REPRODUCTION_ROOMY = reproductionWorst * 10 + REPRODUCTION_RESERVE;

    /** Every lane that decides whether Dune may be spent, driven through its own public entry. */
    type LaneCase = {
      decide: (cap: unknown) => Promise<{ ok: boolean; cap: unknown; reasons: string }>;
      tight: number;
      roomy: number;
    };
    const lane = (
      tight: number,
      roomy: number,
      decide: LaneCase['decide'],
    ): LaneCase => ({ decide, tight, roomy });
    const LANES: Record<string, LaneCase> = {
      'deployer-screen/dune.mjs': lane(TIGHT, ROOMY, async (cap) => {
        const client = new ScreenDuneClient({
          key: SENTINEL_KEY,
          maxExecutions: 2,
          maxRequests: 20,
          minIntervalMs: 0,
          fetchImpl: usage(USED, VENDOR_INCLUDED),
          sleepImpl: async () => undefined,
        });
        const { decision } = await checkDuneAllowance(client, {
          bounds: { ...POLICY, monthlyCreditCapCredits: cap } as never,
          plan: PLAN,
          nowMs: NOW_MS,
          leg: 'enumeration',
        });
        return { ok: decision.ok, cap: decision.monthlyCapCredits, reasons: decision.reasons.join(' ') };
      }),
      'creation-census/run.mjs': lane(TIGHT, ROOMY, async (cap) => {
        const client = new CensusDuneClient({
          key: SENTINEL_KEY,
          maxExecutions: 2,
          maxRequests: 20,
          minIntervalMs: 0,
          fetchImpl: usage(USED, VENDOR_INCLUDED),
          sleepImpl: async () => undefined,
        });
        const { decision } = await censusCheckDuneAllowance(client, {
          bounds: { dune: { ...POLICY, monthlyCreditCapCredits: cap } },
          spendPlan: PLAN,
          nowMs: NOW_MS,
        });
        return { ok: decision.ok, cap: decision.monthlyCapCredits, reasons: decision.reasons.join(' ') };
      }),
      // THE THIRD SPENDING LANE, whose cap is not a parameter at all: it reads a `thresholds.json`
      // on every call, so a CONFIGURATION FILE is what moves here. The one it is pointed at is this
      // test's own copy under a tmpdir — the committed file is never written, because other test
      // files and `screen.mjs` read it at run time and vitest runs files in parallel. What is
      // injected selects a file and never a value, so a literal at the call site still fails below.
      // The transport answers `POST /usage` and nothing else — a billed call is a second path.
      'deployer-screen/dune-reproduction.mjs': lane(REPRODUCTION_TIGHT, REPRODUCTION_ROOMY, async (cap) => {
        const paths: string[] = [];
        const client = new ScreenDuneClient({
          key: SENTINEL_KEY,
          maxExecutions: 2,
          maxRequests: 20,
          minIntervalMs: 0,
          fetchImpl: (async (url: unknown) => {
            paths.push(String(url).slice(DUNE_API_BASE.length));
            return new Response(JSON.stringify(usageBody([period(USED, REPRODUCTION_ROOMY * 100)])), {
              status: 200,
            });
          }) as unknown as typeof fetch,
          sleepImpl: async () => undefined,
        });
        const doc = JSON.parse(readFileSync(THRESHOLDS, 'utf8'));
        if (cap === undefined) delete doc.dune.monthlyCreditCapCredits;
        else doc.dune.monthlyCreditCapCredits = cap;
        const configured = join(mkdtempSync(join(tmpdir(), 'slot-zero-cap-')), 'thresholds.json');
        writeFileSync(configured, JSON.stringify(doc, null, 2));
        const { decision } = await checkReproductionAllowance(client, BATCHES, NOW_MS, configured);
        expect(paths, 'the reproduction lane may read the balance and spend nothing').toEqual([USAGE_PATH]);
        return { ok: decision.ok, cap: decision.monthlyCapCredits, reasons: decision.reasons.join(' ') };
      }),
    };

    for (const [name, spec] of Object.entries(LANES)) {
      // (1) THE CONFIGURED NUMBER IS THE ONE APPLIED, and moving it moves the verdict — on the same
      // balance, with the vendor's plan untouched and never the thing that bound.
      const tight = await spec.decide(spec.tight);
      expect(tight.cap, `${name} must apply the configured cap`).toBe(spec.tight);
      expect(tight.ok, `${name} must refuse under a cap below its worst case`).toBe(false);
      const roomy = await spec.decide(spec.roomy);
      expect(roomy.cap, `${name} must apply the configured cap`).toBe(spec.roomy);
      expect(roomy.ok, `${name} must clear under a cap above its worst case`).toBe(true);
      // (2) AND THE KEY IS LOAD-BEARING: remove it and the lane has no cap to fall back on, so it
      // refuses as unreadable rather than proceeding on the vendor's figure or on one of its own.
      const absent = await spec.decide(undefined);
      expect(absent.ok, `${name} must refuse with no cap configured`).toBe(false);
      expect(absent.cap, `${name} has no cap of its own to report`).toBeNull();
      expect(absent.reasons, `${name} must name the config key`).toContain(MONTHLY_CAP_PIN);
    }

    // AND WITH NOTHING SUPPLIED, the reproduction lane reads the COMMITTED configuration — the file
    // selector above is a test seam and not a second place the cap could come from.
    expect(reproductionCapCredits()).toBe(
      JSON.parse(readFileSync(THRESHOLDS, 'utf8')).dune.monthlyCreditCapCredits,
    );
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

  it("refuses a run the VENDOR would have allowed, because the captain's cap is smaller", async () => {
    // Captain decision 322a end to end, through the real CLI: an account whose plan includes 12,000
    // credits with 9,000 spent has 3,000 left as far as the vendor is concerned, and this run costs
    // a fraction of that. The captain's configured cap is 4,000 for the whole month and 9,000 of it
    // is gone, so the run is refused before the first billed request — a refusal that could not
    // happen at all before this decision, since nothing anywhere knew the cap existed.
    const cap = readBounds().dune.monthlyCreditCapCredits as number;
    const { code, paths, lines } = await run(usageBody([period(cap + 5_000, cap * 3)]));

    expect(code).toBe(EXIT.refused);
    // ONE request, and it is the free one: no saved-query GET, no execution, no billed result read.
    expect(paths).toEqual([USAGE_PATH]);
    expect(lines).toMatch(/dune allowance: INSUFFICIENT/);
    expect(lines).toMatch(/THE OPERATOR CAP is what refused this run/);
    // BOTH FIGURES REACH THE OPERATOR'S TERMINAL. Neither is rewritten into the other, so a reader
    // can see the vendor had room and the cap did not.
    expect(lines).toContain(String(cap));
    expect(lines).toContain(String(cap * 3));
    expect(lines).toMatch(/raising dune\.monthlyCreditCapCredits clears it now/);

    // THE NEGATIVE CONTROL, same shape as 320a's: identical vendor answer, spend moved BELOW the
    // cap, and the same CLI walks straight past the guard. Without this the refusal above is
    // consistent with a census that refuses everything.
    const cleared = await run(usageBody([period(0, cap * 3)]));
    expect(cleared.lines).toMatch(/dune allowance: (SUFFICIENT|TIGHT)/);
    expect(cleared.paths.length).toBeGreaterThan(1);
  });

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
    monthlyCreditCapCredits: CAP,
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
    const checked = await checkDuneAllowance(c, { bounds: BOUNDS, nowMs: NOW_MS, leg: 'enumeration' });
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
    const checked = await checkDuneAllowance(c, { bounds: BOUNDS, nowMs: NOW_MS, leg: 'enumeration' });
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
    const checked = await checkDuneAllowance(c, { bounds: BOUNDS, nowMs: NOW_MS, leg: 'enumeration' });
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
    monthlyCreditCapCredits: CAP,
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
    monthlyCreditCapCredits: CAP,
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

    // THE ORDER IS NOW THE RULE'S, NOT THE CONTROL FLOW'S, and this test reserves in it: the
    // MANDATORY enumeration first, the OPTIONAL entry leg behind it. It used to be written the other
    // way round because `screen.mjs` did it that way — the entry fill source was built before Stage
    // 1 enumerated — and that ordering is the second hazard this round closes. 320a's property is
    // untouched and is what is asserted below: a cleared leg is HELD against the next one.
    const first = await checkDuneAllowance(c, {
      bounds: ENUMERATION_BOUNDS,
      nowMs: NOW_MS,
      ledger,
      leg: 'enumeration',
    });
    expect(first.decision.ok).toBe(true);
    expect(ledger.reservedCredits()).toBe(enumerationWorstCase);

    const second = await checkDuneAllowance(c, {
      bounds: DUNE_BOUNDS,
      nowMs: NOW_MS,
      plan: entryPlan,
      ledger,
      leg: 'entry',
    });
    expect(second.decision.ok).toBe(false);
    expect(second.decision.reasons.join(' ')).toMatch(/already held by an earlier leg/);
    // The reading is taken ONCE and cached: a second read would be a second answer to one question,
    // and the run would hold two beliefs about a balance that moves under it.
    expect(paths).toEqual([USAGE_PATH]);

    // And WITHOUT the shared ledger both legs pass — which is the defect, reproduced. Each opens a
    // PRIVATE ledger, which is by definition a sole leg with nothing to queue behind, so the order
    // rule is inert here and the only thing under test is the missing reservation.
    const solo = client((path) =>
      path === USAGE_PATH
        ? new Response(JSON.stringify(usageBody([period(2_500 - remaining)])), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 }),
    );
    const a = await checkDuneAllowance(solo.c, {
      bounds: DUNE_BOUNDS,
      nowMs: NOW_MS,
      plan: entryPlan,
      leg: 'entry',
    });
    const b = await checkDuneAllowance(solo.c, {
      bounds: ENUMERATION_BOUNDS,
      nowMs: NOW_MS,
      leg: 'enumeration',
    });
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
      leg: 'enumeration',
    });
    const without = await checkDuneAllowance(client(usage).c, {
      bounds: ENUMERATION_BOUNDS,
      nowMs: NOW_MS,
      leg: 'enumeration',
    });
    expect(withLedger.decision).toEqual(without.decision);
  });

  it('an UNREADABLE balance is read once and refuses every leg', async () => {
    // A second read after a failure would be a second answer, and the run would then hold two
    // beliefs about a balance it could not see at all.
    const ledger = openDuneCreditLedger();
    const { c } = client(() => {
      throw new Error('socket hang up');
    });
    const first = await checkDuneAllowance(c, {
      bounds: ENUMERATION_BOUNDS,
      nowMs: NOW_MS,
      ledger,
      leg: 'enumeration',
    });
    const second = await checkDuneAllowance(c, {
      bounds: ENUMERATION_BOUNDS,
      nowMs: NOW_MS,
      ledger,
      leg: 'enumeration',
    });
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

  describe('AND IT RESERVES SECOND — the mandatory leg goes first, by rule', () => {
    // THE HAZARD, found by the review of PR 65 and open on `main` when this round started. Captain
    // decision 320a made both legs draw on ONE reservation; it did not change which of them reserved
    // FIRST, and the control flow had the wrong one there. `buildDuneEntryFillSource` is called from
    // `runEntrySourcePlan`, which runs before Stage 1 enumerates — so the EXPENSIVE OPTIONAL leg
    // billed its trade-coverage result read, the CHEAP MANDATORY enumeration was then priced against
    // what was left, fell back to the RPC walk, and `priceWalkFallbackCliff` refused the whole run
    // at exit 2 before its first walk request.
    //
    // THE COST IS AVAILABILITY, NOT MONEY. The captain has capped Dune's extra credits at $0, so
    // the vendor refuses at the ceiling rather than billing past it — which makes a period consumed
    // by a leg whose run then refused strictly worse than an overspend: it is candidates that
    // cannot be checked at all, against a goal of checking as many as possible. And with the
    // vendor's per-query and per-read throttles turned off, this repo's own guard is the only thing
    // bounding a run.
    //
    // Everything here drives a stubbed transport. No billed Dune call is made by this lane, and the
    // only endpoint any of it reaches is the free `POST /usage`.

    it('THE NEGATIVE CONTROL: the entry leg reserving first is REFUSED, and asks for nothing at all', async () => {
      // This is the ordering, reproduced. Regress `screen.mjs` back to building the entry fill
      // source before the enumeration reserves and this is the path a real run takes — so this
      // assertion is what would go red, rather than a comment going stale.
      const { c, paths } = client((path) =>
        path === USAGE_PATH
          ? new Response(JSON.stringify(usageBody([period(0)])), { status: 200 })
          : new Response(JSON.stringify({}), { status: 200 }),
      );
      await expect(build(c, { ledger: openDuneCreditLedger() })).rejects.toThrow(
        /"entry" leg tried to reserve Dune credits before "enumeration" had settled/,
      );
      // REFUSED BEFORE THE FREE BALANCE READ, let alone a billed one: not one request of any kind.
      // The balance here is deliberately ROOMY — `period(0)` spends nothing — so the refusal cannot
      // be the allowance's, which is what makes the order the thing under test.
      expect(paths).toEqual([]);
      expect(c.executions()).toBe(0);
    });

    it('and it PROCEEDS once the mandatory leg has reserved — same balance, same client', async () => {
      // The control that makes the refusal above mean something: without it a guard that refused
      // everything would pass. Reaching the undeployed probe is how far this configuration can get,
      // and it is the next gate rather than this one.
      const ledger = openDuneCreditLedger();
      const { c, paths } = client((path) =>
        path === USAGE_PATH
          ? new Response(JSON.stringify(usageBody([period(0)])), { status: 200 })
          : new Response(JSON.stringify({}), { status: 200 }),
      );
      const enumeration = await checkDuneAllowance(c, {
        bounds: ENUMERATION_BOUNDS,
        nowMs: NOW_MS,
        ledger,
        leg: 'enumeration',
      });
      expect(enumeration.decision.ok).toBe(true);
      await expect(build(c, { ledger })).rejects.toThrow(/no deployed saved query/);
      // Still nothing billed, and the balance still read exactly once for the whole run.
      expect(paths).toEqual([USAGE_PATH]);
      expect(c.executions()).toBe(0);
    });

    it('a mandatory leg that will NOT spend must SAY so, and saying so is what unblocks the rest', async () => {
      // A run with no Dune client — `--no-dune`, `--ownership-only`, no usable credential — and the
      // dry run, which enumerates nothing. Being quietly skipped leaves the legs behind it blocked,
      // which fails towards refusing; declaring it is what makes the free preview honest rather than
      // merely unblocked.
      const declared = openDuneCreditLedger();
      declared.declineToSpend('enumeration');
      expect(declared.settledLegs()).toEqual(['enumeration']);
      expect(declared.reservedCredits()).toBe(0);
      const { c } = client((path) =>
        path === USAGE_PATH
          ? new Response(JSON.stringify(usageBody([period(0)])), { status: 200 })
          : new Response(JSON.stringify({}), { status: 200 }),
      );
      await expect(build(c, { ledger: declared })).rejects.toThrow(/no deployed saved query/);
    });

    it('a REFUSED mandatory leg still settles — it asked, and the answer will not change', async () => {
      // The enumeration being priced out is a verdict, not a pending question. Holding the leg
      // behind it would turn one leg's refusal into the whole run's, which is the failure this
      // ordering exists to prevent rather than to relocate.
      const ledger = openDuneCreditLedger();
      const { c } = client((path) =>
        path === USAGE_PATH
          ? new Response(JSON.stringify(usageBody([period(2_499)])), { status: 200 })
          : new Response(JSON.stringify({}), { status: 200 }),
      );
      const enumeration = await checkDuneAllowance(c, {
        bounds: ENUMERATION_BOUNDS,
        nowMs: NOW_MS,
        ledger,
        leg: 'enumeration',
      });
      expect(enumeration.decision.ok).toBe(false);
      expect(ledger.settledLegs()).toEqual(['enumeration']);
      // Nothing was held by a refused leg, so the entry leg is priced against the whole balance —
      // and refused by that balance rather than by the order.
      expect(ledger.reservedCredits()).toBe(0);
      await expect(build(c, { ledger })).rejects.toThrow(/refuses to spend/);
    });

    it('a SOLE leg queues behind nothing, so a single-leg run is byte-identical', async () => {
      // `checkDuneAllowance` opens a private ledger when it is handed none, and that means "this is
      // the only leg of this run that spends". The order can only bind a run that has two legs, so
      // every existing single-leg path — every test above, and every default run — is untouched.
      const { c } = client((path) =>
        path === USAGE_PATH
          ? new Response(JSON.stringify(usageBody([period(0)])), { status: 200 })
          : new Response(JSON.stringify({}), { status: 200 }),
      );
      await expect(build(c)).rejects.toThrow(/no deployed saved query/);
    });

    it('the order is DATA, and the entry leg is behind the enumeration in it', () => {
      // An array rather than two booleans: a third spending leg gets a position in it and everything
      // downstream keeps working. What must not change silently is which end the billed optional leg
      // sits at.
      expect([...DUNE_LEG_ORDER]).toEqual(['enumeration', 'entry']);
      expect(DUNE_LEG_ORDER.indexOf('entry')).toBeGreaterThan(DUNE_LEG_ORDER.indexOf('enumeration'));
      // A leg the order does not know is refused rather than placed by guesswork.
      expect(() => openDuneCreditLedger().declineToSpend('stage3' as never)).toThrow(/not one of this run's known legs/);
    });

    it("`main` reserves the mandatory leg ABOVE the construction that bills, on both paths", () => {
      // The seam proves the rule; this proves `screen.mjs` satisfies it. It is a POSITIONAL pin
      // because the defect was positional: both call sites already existed and were already correct
      // in isolation, and only their order in the file was wrong.
      const screen = readFileSync(SCREEN_MAIN, 'utf8');
      const reserved = screen.indexOf("leg: 'enumeration',");
      const built = screen.indexOf('entrySourcePlan = await runEntrySourcePlan(');
      expect(reserved).toBeGreaterThan(-1);
      expect(built).toBeGreaterThan(-1);
      expect(reserved).toBeLessThan(built);
      // The enumeration site downstream REPORTS that verdict rather than taking a second one, which
      // would put this leg back behind the optional one it must precede.
      expect(screen).toContain('const checked = enumerationReservation;');
      expect(screen.match(/checkDuneAllowance\(duneClient, \{/g)).toHaveLength(1);
      // And the dry run, which enumerates nothing, declares that rather than being skipped —
      // otherwise `--dry-run-spend` would refuse with an ordering message post-cutover.
      expect(screen).toContain("duneCreditLedger.declineToSpend('enumeration');");
      expect(screen.match(/declineToSpend\('enumeration'\)/g)).toHaveLength(2);
    });
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

/**
 * **THE TWO PROPERTIES THE FILL SOURCE'S TWO-PHASE CONSTRUCTION CARRIES, DRIVEN THROUGH `main`.**
 *
 * The ordering pins above are POSITIONAL and stand where `main` offered no seam. These stand beside
 * them and observe the run instead: a stubbed transport records every URL, and the exit code plus
 * the refusal wording say which phase refused. Both directions of both properties are here, and each
 * negative control was confirmed to go RED against the construction sitting in the other phase.
 *
 * `main`'s `seam.entryFillSourceKind` is what makes any of this reachable. `ENTRY_FILL_SOURCE_KIND`
 * is the Gate 3 cutover's own edit and this lane may not make it, so a run that SELECTS the Dune
 * source — the case both spend hazards are about — cannot otherwise be produced from a test.
 * Nothing here opens a gate: the constant, `TRADE_COVERAGE_QUERY_ID` and
 * `entry_source_agreement.active` are all untouched, and the Dune source still refuses to be built
 * because its coverage probe is undeployed, which is exactly the refusal these tests observe.
 */
describe('the entry fill source is constructed in two phases, and each phase carries one property', () => {
  /** Screen exit codes. `EXIT` in `screen.mjs` is module-private, so they are named here. */
  const SCREEN_EXIT = { usage: 2, upstream: 7 };

  /** Distinct, base58-shaped, and never a wallet this project has measured. */
  const seedWallet = (i: number) => `${WALLET.slice(0, -2)}${'abcdefghijkmnpqrstuv'[i]}L`;

  function seedBody(count: number): unknown {
    return {
      deployers: Array.from({ length: count }, (_, i) => ({
        wallet_address: seedWallet(i),
        total_tokens_deployed: 60,
        total_bonded: 20,
      })),
    };
  }

  /**
   * Every URL the run reaches, in order, with nothing leaving the process.
   *
   * The clients read `globalThis.fetch` at construction and `main` constructs its own, so stubbing
   * the global is the whole injection. A URL this handler does not recognise answers 404 — the
   * status the live Dune account actually returned for these saved queries — which is terminal and
   * unretried, so a failing leg fails fast rather than backing off.
   */
  function stubTransport(handler: (url: string) => Response): string[] {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      return handler(url);
    });
    return seen;
  }

  const KEYED_ENV = { MADEONSOL_API_KEY: SENTINEL_KEY, DUNE_API_KEY: SENTINEL_KEY };

  /**
   * THE ORDER PROPERTY, AND IT IS THE ONE THAT SURVIVES THE CUTOVER.
   *
   * Asserting an exit code or a refusal sentence discriminates only while `TRADE_COVERAGE_QUERY_ID`
   * is null, because that is what makes an early build THROW. Deploy the probe id — which is exactly
   * what Gate 3 does — and a regressed early build would SUCCEED, bill its coverage probe and let
   * the run reach the same cliff with the same stderr, so the guard would go green against the
   * regression at the moment the hazard becomes real.
   *
   * What does not expire is WHICH Dune request came first. `POST /usage` is free — Dune documents it
   * as a metadata endpoint consuming no credits — so the first BILLED Dune request of a run must
   * belong to the enumeration's own saved queries. The entry fill source reads different ids
   * (`ENTRY_QUERY_ID` and the trade coverage probe), so a build that ran ahead of the enumeration
   * puts one of those first and fails this whatever the exit code turns out to be.
   */
  function assertNoBilledDuneRequestBeforeEnumeration(seen: string[]): void {
    const bounds = screenLoadThresholds()['dune'] as { creationQueryId: number; coverageQueryId: number };
    const enumerationIds = [bounds.creationQueryId, bounds.coverageQueryId].map(String);
    const billed = seen.filter((u) => u.startsWith(DUNE_API_BASE) && !u.endsWith(USAGE_PATH));
    for (const url of billed) {
      // The entry leg's own surfaces, named so a future reader sees what is being excluded.
      expect(url).not.toContain(String(ENTRY_QUERY_ID));
      if (enumerationIds.some((id) => url.includes(id))) return;
      throw new Error(`a Dune request that is neither free nor the enumeration's came first: ${url}`);
    }
  }

  function run(argv: string[], env: Record<string, string>, kind: string) {
    const parsed = screenParseArgs(argv);
    if (!parsed.ok) throw new Error('unreachable');
    const errs: string[] = [];
    return screenMain(parsed.opts, env, () => {}, (l: string) => errs.push(l), {
      entryFillSourceKind: kind as never,
    }).then((code: number) => ({ code, err: errs.join('\n') }));
  }

  it('PROPERTY 1: an unusable Stage 2 source refuses before ONE seed request is spent', async () => {
    // The keyed-allowance protection the early construction buys, and the reason the billed build
    // could not simply be moved down. A kind this run carries no constructor for is refused by
    // RESOLUTION, which touches no vendor.
    try {
      const seen = stubTransport(() => new Response('{}', { status: 200 }));
      const { code, err } = await run([], KEYED_ENV, 'no-such-source');
      expect(code).toBe(SCREEN_EXIT.upstream);
      expect(err).toContain('Refusing to start: Stage 2 has no usable fill source.');
      // THE CLAIM IS THE CREDIT ONE AND IT IS THE ONLY ONE THAT SURVIVES INSPECTION. The
      // enumeration's reservation was hoisted ABOVE this refusal, so a run with a Dune client HAS
      // issued the free `POST /usage` by now — "nothing was requested" would be false, and the
      // transport below is what proves it. What is true is that no metered quota went anywhere.
      expect(err).toContain('No quota was spent');
      expect(err).not.toContain('Nothing was requested, so no quota was spent.');
      // NO SEED REQUEST, and nothing billed: the only URL a refusing run reaches is that free
      // balance read, which Dune documents as a metadata endpoint consuming no credits.
      expect(seen.filter((u) => u.startsWith(MADEONSOL_BASE_URL))).toEqual([]);
      expect(seen.filter((u) => !u.endsWith(USAGE_PATH))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('PROPERTY 1 covers the CREDENTIAL too: a Dune-reading run with no usable key spends no seed request', async () => {
    // THE WORST INSTANCE OF THE NARROWING, AND IT IS CLOSED RATHER THAN DOCUMENTED. The Dune
    // construction is declared BILLED, so the free phase defers it wholesale — which at the cutover
    // meant a run with no usable `DUNE_API_KEY` spent the entire MadeOnSol seed enumeration and only
    // then refused, for an answer that is free to obtain. Worse, that configuration buys nothing
    // with those seeds: `usingDune` is false, so the enumeration leg is skipped, no leg is attempted
    // and no cliff is priced.
    try {
      const seen = stubTransport(() => new Response('{}', { status: 200 }));
      const { code, err } = await run([], { MADEONSOL_API_KEY: SENTINEL_KEY }, 'dune');
      expect(code).toBe(SCREEN_EXIT.upstream);
      expect(err).toContain('Refusing to start: Stage 2 has no usable fill source.');
      expect(err).toContain('DUNE_API_KEY');
      // The property, and the transport is what asserts it: not one request of any kind, keyed or
      // free — with no Dune credential there is no client to read a balance through either.
      expect(seen).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('the credential rule is ONE rule, and it is inert wherever the Dune source is not read', () => {
    // Written once and evaluated twice — the free phase asks it, and the constructor keeps asking it
    // as the backstop for a caller that never went through the free phase. Both call the function
    // asserted here, so there is no second predicate and no second message to drift.
    expect(duneFillSourceCredentialRefusal({ available: true } as never)).toBeNull();
    expect(duneFillSourceCredentialRefusal({ available: false } as never)).toContain('DUNE_API_KEY');

    // AND IT IS GATED ON THE SHARED DERIVATION, not on a second reading of the kind — so every
    // configuration that reads NO Dune source is untouched by it. `--stage0` (folded into
    // `entryFillSourceIsRead` last round) and `--no-stage2` both read nothing at all, at the
    // cutover's kind; and at today's `swap-api` a default run does not read Dune either.
    for (const argv of [['--stage0'], ['--stage0', '--no-dune'], ['--no-stage2']]) {
      const parsed = screenParseArgs(argv);
      if (!parsed.ok) throw new Error('unreachable');
      expect(entrySourceKindsRead(parsed.opts, undefined, 'dune'), argv.join(' ')).toEqual([]);
    }
    const plain = screenParseArgs([]);
    if (!plain.ok) throw new Error('unreachable');
    expect(entrySourceKindsRead(plain.opts, undefined)).toEqual([ENTRY_FILL_SOURCE_KIND]);
    expect(entrySourceKindsRead(plain.opts, undefined).includes('dune')).toBe(false);
  });

  it('a run with NO Dune credential is unaffected at TODAY’s kind, which is what keeps this inert', async () => {
    // The inertness control for the check above: the same empty-Dune environment at the shipped
    // `swap-api` kind reaches the credential refusal it has always reached instead — the MadeOnSol
    // one — rather than being stopped by a Stage 2 source it never reads.
    try {
      const seen = stubTransport(() => new Response('{}', { status: 200 }));
      const { code, err } = await run([], {}, ENTRY_FILL_SOURCE_KIND);
      expect(code).toBe(3);
      expect(err).toContain('CREDENTIAL PROBLEM');
      expect(err).not.toContain('usable fill source');
      expect(seen).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('PROPERTY 2: a Dune enumeration that answers for NOBODY reaches the cliff with the entry source unbuilt', async () => {
    // THE HAZARD ITSELF. The ledger orders the two RESERVATIONS and cannot order their SPEND, so
    // with the billed construction above Stage 1 this run would bill the entry leg's trade-coverage
    // read, watch the enumeration come back empty, and be refused whole — period consumed, nothing
    // produced. Here the enumeration's saved query 404s (the live failure shape), the leg answers
    // for nobody, and the walk-fallback cliff is what the operator gets.
    try {
      const seen = stubTransport((url) => {
        if (url.startsWith(MADEONSOL_BASE_URL)) return new Response(JSON.stringify(seedBody(12)), { status: 200 });
        if (url.endsWith(USAGE_PATH)) {
          return new Response(JSON.stringify(usageBody([period(0, 4_000)])), { status: 200 });
        }
        return new Response('Query not found', { status: 404 });
      });
      const { code, err } = await run([], KEYED_ENV, 'dune');
      expect(code).toBe(SCREEN_EXIT.usage);
      expect(err).toContain('the Dune enumeration leg answered for NO candidate');
      // THE NEGATIVE CONTROL, and it is the finding: with the construction in the early phase this
      // run exits 7 with the fill-source refusal instead, having never enumerated at all.
      expect(err).not.toContain('has no usable fill source');
      // And the seeds WERE spent before the cliff, so this is the degraded path rather than an
      // early refusal wearing a different exit code.
      expect(seen.filter((u) => u.startsWith(MADEONSOL_BASE_URL)).length).toBeGreaterThan(0);
      // THE ASSERTION THAT DOES NOT EXPIRE AT THE CUTOVER — see the helper for why the two above do.
      assertNoBilledDuneRequestBeforeEnumeration(seen);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('PROPERTY 2, the other direction: a run that gets past the enumeration DOES build the billed source', async () => {
    // Without this the property above would be satisfied by never building the source at all. The
    // seeds return NO wallet, so there is no batch for the enumeration leg to be attempted on and no
    // cliff to price; the run reaches the late phase, the Dune source refuses to be built — its
    // coverage probe is undeployed, which is the resting state Gate 3 changes — and the refusal
    // lands with the seed requests already sunk. Its wording says "score" rather than "start" and,
    // deliberately, makes no claim that nothing was spent.
    //
    // IT DOES NOT USE `--no-dune` TO GET HERE, and that is not incidental: that combination is now
    // refused outright, because "reach no Dune surface" and "score Stage 2 through Dune" contradict.
    try {
      const seen = stubTransport((url) => {
        if (url.startsWith(MADEONSOL_BASE_URL)) return new Response(JSON.stringify(seedBody(0)), { status: 200 });
        if (url.endsWith(USAGE_PATH)) {
          return new Response(JSON.stringify(usageBody([period(0, 4_000)])), { status: 200 });
        }
        return new Response('Query not found', { status: 404 });
      });
      const { code, err } = await run([], KEYED_ENV, 'dune');
      expect(code).toBe(SCREEN_EXIT.upstream);
      expect(err).toContain('Refusing to score: Stage 2 has no usable fill source.');
      expect(err).not.toContain('Nothing was requested, so no quota was spent.');
      // THE ORDER, not just the wording: whatever the entry source's construction goes on to cost
      // once Gate 3 deploys the probe, it happens AFTER the seed enumeration is spent. That is what
      // "the billed leg builds late" means observably, and it keeps discriminating past the cutover.
      // The free `POST /usage` is excluded deliberately — the mandatory leg reserves above Stage 1,
      // so it legitimately precedes the seeds and costs no credit.
      const lastSeed = seen.map((u) => u.startsWith(MADEONSOL_BASE_URL)).lastIndexOf(true);
      expect(lastSeed).toBeGreaterThan(-1);
      const firstBilledDune = seen.findIndex((u) => u.startsWith(DUNE_API_BASE) && !u.endsWith(USAGE_PATH));
      expect(firstBilledDune === -1 || firstBilledDune > lastSeed).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('REFUSES a run told both to reach no Dune surface and to score Stage 2 through Dune', async () => {
    // The two instructions contradict, and the tool names that rather than picking one. Honouring
    // the flag would silently discard the configured fill source; honouring the source would bill a
    // vendor the flag forbade — the run would reach Dune having declared it would not, and file a
    // record saying `dune.used: false`. Driven through the `entryFillSourceKind` seam because
    // `ENTRY_FILL_SOURCE_KIND` is Gate 3's own edit and this lane may not make it.
    for (const flag of ['--no-dune', '--ownership-only']) {
      try {
        const seen = stubTransport(() => new Response('{}', { status: 200 }));
        const { code, err } = await run([flag], KEYED_ENV, 'dune');
        expect(code).toBe(SCREEN_EXIT.usage);
        expect(err).toContain('reach no Dune surface');
        // It names BOTH asks and says which to drop, rather than reporting a bare rejection.
        expect(err).toContain(flag);
        expect(err).toContain('ENTRY_FILL_SOURCE_KIND');
        // And it refuses before ANYTHING is reached — not one seed request, not the free balance
        // read the mandatory leg would otherwise take.
        expect(seen).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  }, 60_000);

  it('is INERT on every configuration reachable today, which is what makes it a fix and not a regression', () => {
    // `ENTRY_FILL_SOURCE_KIND` is `swap-api`, so no CLI a captain can type today produces the
    // contradiction — the guard arms itself at the cutover and changes nothing before it. Asserted
    // through `parseArgs`, which is the surface an operator meets, and at the default kind rather
    // than the seam's.
    expect(ENTRY_FILL_SOURCE_KIND).toBe('swap-api');
    for (const argv of [['--no-dune'], ['--ownership-only'], ['--no-stage2', '--no-dune'], ['--no-stage2']]) {
      expect(screenParseArgs(argv).ok, argv.join(' ')).toBe(true);
    }
    // And `--no-stage2` is not merely tolerated by luck: Stage 2 reads NO source, so the shared
    // derivation returns nothing and there is no contradiction to refuse — it falls out of asking
    // the one derivation rather than out of a special case. It holds at the cutover's kind too.
    const off = { stage2: false, noDune: true, ownershipOnly: false };
    expect(duneFillSourceContradiction(off, undefined, 'dune')).toBeNull();
    // The pre-existing refusal of the agreement flag beside these two is untouched.
    expect(screenParseArgs(['--entry-source-agreement', '--no-dune']).ok).toBe(false);
    // And a run that asked for neither flag is never refused, whatever source it reads.
    const on = { stage2: true, noDune: false, ownershipOnly: false };
    expect(duneFillSourceContradiction(on, undefined, 'dune')).toBeNull();
    // THE ARMED CASE, which is the derivation `parseArgs` consumes with no bounds to read: at the
    // cutover's kind the same inputs that pass today are refused, and the message names both asks.
    const armed = duneFillSourceContradiction({ stage2: true, noDune: true, ownershipOnly: false }, undefined, 'dune');
    expect(armed).toContain('--no-dune');
    expect(armed).toContain('reaches no Dune surface');
    expect(armed).toContain('ENTRY_FILL_SOURCE_KIND');
  });

  it('leaves `--stage0` FREE at the cutover, in both places, because the mode is folded into the derivation', async () => {
    // A REGRESSION THE CONTRADICTION GUARD ITSELF INTRODUCED, and this is the guard against it
    // coming back. `--stage0` sets only `stage0Only` and leaves `stage2` true, so as first written
    // the guard refused `--stage0 --no-dune` at the cutover — a mode whose usage text promises "No
    // network, no key, no quota. Always safe." — while `main`'s copy, which sits BELOW the
    // `stage0Only` return, let the same combination through. Two places, one rule, two answers.
    //
    // The fix is in `entryFillSourceIsRead`, so a Stage 0 run reads no source and both copies are
    // inert for it by construction rather than by two call sites agreeing to be.
    for (const argv of [['--stage0'], ['--stage0', '--no-dune'], ['--stage0', '--ownership-only']]) {
      // The CLI half, at the CUTOVER's kind — the case that was broken, reachable only through the
      // seam because `ENTRY_FILL_SOURCE_KIND` is Gate 3's own edit.
      const parsed = screenParseArgs(argv);
      expect(parsed.ok, argv.join(' ')).toBe(true);
      if (!parsed.ok) throw new Error('unreachable');
      expect(duneFillSourceContradiction(parsed.opts, undefined, 'dune'), argv.join(' ')).toBeNull();
      expect(entrySourceKindsRead(parsed.opts, undefined, 'dune')).toEqual([]);

      // And `main` AGREES, observably and at the same kind: Stage 0 runs offline over the committed
      // tape, exits ok and reaches no vendor at all. An empty environment is deliberate — this mode
      // needs no key, which is half of what makes it the safe smoke test.
      try {
        const seen = stubTransport(() => new Response('{}', { status: 200 }));
        const errs: string[] = [];
        const code = await screenMain(parsed.opts, {}, () => {}, (l: string) => errs.push(l), {
          entryFillSourceKind: 'dune' as never,
        });
        expect(code, `${argv.join(' ')}: ${errs.join('\n')}`).toBe(0);
        expect(errs.join('\n')).not.toContain('reach no Dune surface');
        expect(seen).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  }, 120_000);

  it('does NOT fold `--dry-run` the same way: the plan still describes the source it would read', async () => {
    // THE LOAD-BEARING HALF OF THE ASYMMETRY. A dry run reads no source but PLANS one, and
    // `planEligibility` gates on the same predicate `--stage0` was folded into — so folding
    // `dryRun` in beside it would silently stop the plan describing its own source and regress
    // captain decision 286c. The difference is structural rather than a judgement: a `--stage0` run
    // RETURNS before the plan is built, a dry run does not.
    const parsed = screenParseArgs(['--dry-run']);
    if (!parsed.ok) throw new Error('unreachable');
    expect(entrySourceKindsRead(parsed.opts, undefined)).toEqual([ENTRY_FILL_SOURCE_KIND]);
    try {
      const seen = stubTransport(() => new Response('{}', { status: 200 }));
      const lines: string[] = [];
      const code = await screenMain(parsed.opts, {}, (l: string) => lines.push(l), () => {});
      expect(code).toBe(0);
      // The eligibility floor is the figure only a BUILT source can answer, and the free swap-api
      // construction answers it — so its presence is the plan describing its source. A fold of
      // `dryRun` into the predicate would remove this line entirely.
      expect(lines.join('\n')).toMatch(/A launch is not walked until it is/);
      expect(seen).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('the DEFAULT run is unchanged: the one source it reads is free, so both phases still build it once', async () => {
    // The regression guard on "a default run is byte-identical". The swap-api construction is
    // DECLARED free, so the early phase builds it and the late phase finds nothing left to do — and
    // the run goes on to fail on the credential it has always failed on, rather than on a source.
    try {
      const seen = stubTransport(() => new Response('{}', { status: 200 }));
      const parsed = screenParseArgs([]);
      if (!parsed.ok) throw new Error('unreachable');
      const errs: string[] = [];
      const code = await screenMain(parsed.opts, {}, () => {}, (l: string) => errs.push(l));
      expect(code).toBe(3);
      expect(errs.join('\n')).toContain('CREDENTIAL PROBLEM');
      expect(errs.join('\n')).not.toContain('usable fill source');
      expect(seen).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// CAPTAIN DECISION 381 — bounding what ONE execution can cost, for real.
//
// The guard above refuses a plan whose PINNED worst case does not fit. It cannot bound what an
// execution actually costs, because the spend happens after the check passes and Dune caps a single
// execution's cost nowhere. Measured 2026-08-08: a lane running behind this exact code path, with
// the live counter re-read before every execution, printed `verdict: sufficient (ok=true)` against a
// pinned worst case of 6 credits and was billed 180.002 for an execution that returned nothing
// (`slot-zero-venue-gradeability-inventory` → `report.md` §0, held in firstmate's records).
//
// Two halves, and neither works alone. The PIN makes the guard's arithmetic honest; the DEADLINE is
// the only thing that actually caps a single execution. Both are pinned below.

describe('THE TIMEOUT FLOOR, and the two keyed pins that must sit above it', () => {
  const screen = JSON.parse(readFileSync(THRESHOLDS, 'utf8')).dune;
  const census = readBounds().dune;

  it('prices the engine timeout from the one reading there is, and says it is one reading', () => {
    // 180.002 credits over Dune's own 30-minute limit. The per-minute rate is DERIVED from that and
    // is an inference — the vendor publishes no rate — which is why every pin taken from it carries
    // a stated margin rather than sitting on it.
    expect(ENGINE_TIMEOUT_MS).toBe(30 * 60_000);
    expect(MEASURED_TIMEOUT_FLOOR_CREDITS).toBe(180.002);
    expect(CREDITS_PER_ENGINE_MINUTE).toBeCloseTo(6.0, 3);
    // Whole credits, rounded UP, because the vendor's counter advances in whole-credit jumps and
    // sub-credit precision on a worst case is precision the account cannot resolve.
    expect(executionDeadlineCredits(ENGINE_TIMEOUT_MS)).toBe(181);
    expect(executionDeadlineCredits(120_000)).toBe(13);
    expect(executionDeadlineCredits(60_000)).toBe(7);
    expect(executionDeadlineCredits(0)).toBe(0);
    // A deadline past the vendor's own limit buys nothing: the engine stops first, so the price
    // stops there too rather than running off linearly.
    expect(executionDeadlineCredits(ENGINE_TIMEOUT_MS * 10)).toBe(executionDeadlineCredits(ENGINE_TIMEOUT_MS));
    expect(executionDeadlineCredits(-1)).toBe(0);
  });

  it('BOTH KEYED PINS SIT AT OR ABOVE THAT FLOOR — this is the assertion the incident bought', () => {
    // The defect in one line: a guard that clears a plan at 25 credits and is then billed 180 does
    // not bound the month it exists to bound. `executionDeadlineCredits(ENGINE_TIMEOUT_MS)` is the
    // floor and it is derived rather than typed, so a later lane cannot drift back under it by
    // editing a literal.
    const floor = executionDeadlineCredits(ENGINE_TIMEOUT_MS);
    expect(screen.worstCaseCreditsPerExecution).toBeGreaterThanOrEqual(floor);
    expect(census.worstCaseCreditsPerExecution).toBeGreaterThanOrEqual(floor);
    // AND THEY ARE EQUAL, for the same reason the monthly cap is: both keyed lanes read the same
    // account and the same vendor ceiling, so a floor that binds one of them is not a floor.
    expect(screen.worstCaseCreditsPerExecution).toBe(census.worstCaseCreditsPerExecution);
    // The reproduction lane prices per BATCH and cannot afford the engine floor outright, so it is
    // pinned at the floor its own deadline buys. That is honest only because the deadline exists —
    // and the relation is pinned so the two cannot come apart.
    expect(REPRODUCTION_CREDITS_PER_EXECUTION).toBeGreaterThanOrEqual(executionDeadlineCredits(600_000));
  });

  it('says in the justification what the raise DOES, not merely that it happened', () => {
    // Every pinned value in this repository carries a stated reason; this one has to state the
    // consequence too, because the census's ceiling arithmetic changes character rather than degree.
    for (const reason of [
      screen.justification.worstCaseCreditsPerExecution as string,
      census.justification === undefined
        ? (readBounds().justification['dune.worstCaseCreditsPerExecution'] as string)
        : '',
    ].filter(Boolean)) {
      expect(reason).toMatch(/180\.002/);
      expect(reason).toMatch(/30-minute engine limit/);
      expect(reason).toMatch(/executionDeadlineMs/);
    }
    const censusReason = readBounds().justification['dune.worstCaseCreditsPerExecution'] as string;
    // The worked arithmetic an operator plans against, stated in place rather than left to be
    // recomputed: what a default census now reserves, and where the refusal moved to.
    expect(censusReason).toMatch(/49\.51 -> 224\.51/);
    expect(censusReason).toMatch(/~17 reserved default runs/);
  });

  it('re-prices both lanes and still clears a fresh period, which is what keeps the guard usable', () => {
    // A worst case at or above the allowance would make the guard unsatisfiable on a fresh period:
    // it would refuse every run and the ceiling would be a wall rather than a bound. The pin more
    // than quadrupled, so this is checked rather than assumed.
    const screenWorst = estimatePlanCredits(duneSpendPlan(screen)).worstCaseCredits;
    expect(screenWorst).toBeCloseTo(2 * 200 + (3 * 40_000 * 121 * EXPORT_CREDITS_PER_MB) / 1_000_000, 3);
    const b = readBounds();
    const censusWorst = censusEstimatePlanCredits({
      lane: 'census',
      executions: b.dune.maxExecutionsPerRun,
      creditsPerExecution: b.dune.worstCaseCreditsPerExecution,
      resultReads: b.dune.maxExecutionsPerRun + 1,
      rowsPerRead: b.census.maxRows + b.census.resultLimitHeadroom,
      bytesPerRow: b.dune.resultBytesPerRowCeiling,
    }).worstCaseCredits;
    expect(censusWorst).toBeCloseTo(224.51, 2);
    // Both must fit the operator's own cap with the tight multiple and the reserve on top, or the
    // raise would have made every run refuse itself.
    for (const [worst, bounds] of [
      [screenWorst, screen],
      [censusWorst, b.dune],
    ] as [number, { allowanceTightMultiple: number; allowanceReserveCredits: number; monthlyCreditCapCredits: number }][]) {
      expect(worst * bounds.allowanceTightMultiple + bounds.allowanceReserveCredits).toBeLessThan(
        bounds.monthlyCreditCapCredits,
      );
    }
  });

  it('THE DEADLINE IS COVERED BY THE POLL BUDGET IN BOTH LANES — one bound, two units', () => {
    // Captain decision 144a's rule: never write two numbers for a duration someone else controls.
    // The deadline is the authority and the poll budget must cover it, or the request budget would
    // silently be the thing that ends the wait and the deadline would decide nothing.
    for (const d of [screen, census]) {
      expect(d.executionDeadlineMs).toBeGreaterThan(0);
      expect(d.maxPollAttempts * d.pollIntervalMs).toBeGreaterThanOrEqual(d.executionDeadlineMs);
      // Conservative by construction: far inside the vendor's own limit.
      expect(d.executionDeadlineMs).toBeLessThan(ENGINE_TIMEOUT_MS / 10);
    }
    // Pinned EQUAL across the two keyed lanes, so an operator sizing a month reasons about one
    // deadline rather than two.
    expect(screen.executionDeadlineMs).toBe(census.executionDeadlineMs);
    // And the default's price is stated where a budget is sized from it.
    expect(describeExecutionDeadline(census.executionDeadlineMs)).toMatch(/120s execution deadline/);
    expect(describeExecutionDeadline(census.executionDeadlineMs)).toMatch(/at most 13 credit\(s\) of compute/);
    expect(describeExecutionDeadline(census.executionDeadlineMs)).toMatch(/cancels rather than waits/);
  });

  it('carries the deadline machinery in BOTH client copies, byte for byte', () => {
    // The shared region is pinned whole by the first describe in this file; this is the narrower
    // statement that the new half is IN it rather than beside it, and that the two copies compute
    // the same numbers when driven independently.
    for (const file of [SCREEN_CLIENT, CENSUS_CLIENT]) {
      const region = sharedRegion(file);
      expect(region).toContain('export const MEASURED_TIMEOUT_FLOOR_CREDITS = 180.002;');
      expect(region).toContain('export function executionDeadlineCredits(');
      expect(region).toContain('export class DuneExecutionAbandoned extends DuneRefused {');
      expect(region).toContain('export async function cancelExecutionQuietly(');
    }
    expect(censusExecutionDeadlineCredits(ENGINE_TIMEOUT_MS)).toBe(executionDeadlineCredits(ENGINE_TIMEOUT_MS));
    expect(censusExecutionDeadlineCredits(120_000)).toBe(executionDeadlineCredits(120_000));
    expect(CENSUS_DEADLINE_CAVEAT).toBe(EXECUTION_DEADLINE_CAVEAT);
    // What the caveat may not do is claim more than was bought. Cancelling bounds the WAIT; whether
    // it stops the BILL is unverified and settling it would cost a deliberately-runaway execution.
    expect(EXECUTION_DEADLINE_CAVEAT).toMatch(/bounds the WAIT for certain and the BILL only if/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('AN EXECUTION WE ARE NO LONGER WILLING TO PAY FOR IS CANCELLED, AND IT IS ITS OWN OUTCOME', () => {
  /**
   * Drive a real `executeAndRead` over a scripted transport and a scripted clock.
   *
   * `elapsedPerPoll` is what the injected clock advances by each time it is read, so a test reaches
   * a two-minute deadline in microseconds. Sleeping is a no-op for the same reason.
   */
  function harness(
    which: 'screen' | 'census',
    opts: {
      status: (poll: number) => unknown;
      elapsedPerPoll?: number;
      maxRequests?: number;
      cancelResponds?: () => Response;
      bounds?: Partial<{ pollIntervalMs: number; maxPollAttempts: number; executionDeadlineMs: number }>;
    },
  ) {
    const paths: string[] = [];
    let polls = 0;
    let elapsed = 0;
    const fetchImpl = vi.fn(async (url: unknown) => {
      const path = String(url).slice(DUNE_API_BASE.length);
      paths.push(path);
      if (path.endsWith('/execute')) return new Response(JSON.stringify({ execution_id: 'exec-1' }), { status: 200 });
      if (path.endsWith('/cancel')) return (opts.cancelResponds ?? (() => new Response('{}', { status: 200 })))();
      if (path.endsWith('/status')) return new Response(JSON.stringify(opts.status(polls++)), { status: 200 });
      return new Response(JSON.stringify({ result: { rows: [], metadata: { total_row_count: 0 } } }), { status: 200 });
    });
    const Ctor = which === 'screen' ? ScreenDuneClient : CensusDuneClient;
    const client = new Ctor({
      key: SENTINEL_KEY,
      maxExecutions: 1,
      maxRequests: opts.maxRequests ?? 50,
      minIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => {},
    });
    const clock = () => {
      const now = elapsed;
      elapsed += opts.elapsedPerPoll ?? 0;
      return now;
    };
    const bounds = { pollIntervalMs: 0, maxPollAttempts: 5, executionDeadlineMs: 120_000, ...(opts.bounds ?? {}) };
    const go =
      which === 'screen'
        ? screenExecuteAndRead(client as never, 7, {}, { ...bounds, maxResultRows: 100, clock })
        : censusExecuteAndRead(client as never, 7, {}, { ...bounds, resultLimit: 100, clock });
    return { go, paths, client };
  }

  const RUNNING = () => ({ state: 'QUERY_STATE_PENDING' });

  /**
   * Drive the real census CLI to its execution, with the vendor pinned in one state throughout.
   *
   * The poll loop sleeps on real timers, so the clock is faked and advanced by hand — the run's own
   * two-minute deadline is then reached in milliseconds without any seam being added to the tool.
   */
  async function runCensusAgainstVendorState(state: string) {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      const path = String(url).slice(DUNE_API_BASE.length);
      paths.push(path);
      if (path === USAGE_PATH) return new Response(JSON.stringify(usageBody([period(0, 100_000)])), { status: 200 });
      if (path.endsWith('/execute')) return new Response(JSON.stringify({ execution_id: 'exec-1' }), { status: 200 });
      if (path.endsWith('/cancel')) return new Response('{}', { status: 200 });
      if (path.endsWith('/status')) return new Response(JSON.stringify({ state }), { status: 200 });
      if (path.startsWith('/query/')) return new Response(JSON.stringify({ query_sql: CENSUS_SQL }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as unknown as typeof fetch);
    const lines: string[] = [];
    vi.useFakeTimers();
    try {
      const out = mkdtempSync(join(tmpdir(), 'slot-zero-deadline-'));
      let settled = false;
      const run = censusMain(
        ['--live', '--month', '2026-07', '--out', out],
        { DUNE_API_KEY: SENTINEL_KEY },
        (l) => lines.push(l),
      ).finally(() => {
        settled = true;
      });
      for (let i = 0; i < 400 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000);
      const code = await run;
      return { code, paths, lines: lines.join('\n') };
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  }

  for (const which of ['screen', 'census'] as const) {
    it(`${which}: an execution still running at the deadline is CANCELLED, not merely abandoned`, async () => {
      // The measured failure, and the fix. Before this, the loop walked away and said the execution
      // "is billed and is not retried" — true, and silent about the engine still running to Dune's
      // own 30-minute limit on our money.
      const { go, paths } = harness(which, { status: RUNNING, elapsedPerPoll: 100_000 });
      const err = await go.then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.name).toBe('DuneExecutionAbandoned');
      expect(paths).toContain('/execution/exec-1/cancel');
      const abandoned = err as unknown as { reason: string; terminal: boolean; worstCaseCredits: number; cancelAcknowledged: boolean };
      expect(abandoned.reason).toBe('deadline');
      // Still terminal, so every existing catch site keeps falling back exactly as it did.
      expect(abandoned.terminal).toBe(true);
      expect(abandoned.cancelAcknowledged).toBe(true);
      expect(abandoned.worstCaseCredits).toBe(13);
      // "WE STOPPED THIS" has to be readable off the message, not inferred from a state name.
      expect(err?.message).toMatch(/ABANDONED BY US, not failed by Dune/);
      expect(err?.message).toMatch(/execution deadline expired/);
      expect(err?.message).toMatch(/bounds the WAIT for certain/);
      expect(err?.message).not.toContain(SENTINEL_KEY);
    });

    it(`${which}: a VENDOR failure stays a vendor failure — no cancel, and not this outcome`, async () => {
      // The distinction the whole outcome exists for. Dune stopped this one, so there is nothing to
      // cancel and a run must not report it as something we did.
      const { go, paths } = harness(which, { status: () => ({ state: 'QUERY_STATE_FAILED' }) });
      const err = await go.then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.name).toBe('DuneRefused');
      expect(paths.some((p) => p.endsWith('/cancel'))).toBe(false);
      // And the corrected costing premise travels on it, because this is where a reader meets it.
      expect(err?.message).toMatch(/fails to COMPILE costs nothing/);
    });

    it(`${which}: a COMPLETED execution is never cancelled`, async () => {
      const { go, paths } = harness(which, { status: () => ({ state: 'QUERY_STATE_COMPLETED' }) });
      await go.catch(() => undefined);
      expect(paths.some((p) => p.endsWith('/cancel'))).toBe(false);
      expect(paths.some((p) => p.includes('/results'))).toBe(true);
    });

    it(`${which}: running out of POLLS cancels too, and says which bound ran out`, async () => {
      // The poll budget and the deadline are one bound in two units, so both give-up paths are the
      // same event and both must stop the engine. Reaching this one means the two pins have come
      // apart, which the message says rather than leaving it to be inferred.
      const { go, paths } = harness(which, { status: RUNNING, elapsedPerPoll: 0 });
      const err = await go.then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.name).toBe('DuneExecutionAbandoned');
      expect((err as unknown as { reason: string }).reason).toBe('poll-budget');
      expect(paths).toContain('/execution/exec-1/cancel');
      expect(err?.message).toMatch(/no longer covers/);
    });

    it(`${which}: the REQUEST CEILING cannot stop the cancel — that is the whole point of the exemption`, async () => {
      // An abandonment happens with the request budget at or near its limit by construction. A
      // ceiling that refused the cancel would turn a bounded bill into an unbounded one at exactly
      // the moment the bound is needed. The original error survives unchanged: a `CeilingReached`
      // must keep its own remedy rather than be replaced by ours.
      const { go, paths, client } = harness(which, { status: RUNNING, elapsedPerPoll: 0, maxRequests: 3 });
      const err = await go.then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.name).toBe('CeilingReached');
      expect(paths).toContain('/execution/exec-1/cancel');
      // It still COUNTS as issued, so the run's own tally does not quietly under-report.
      expect(client.issued()).toBeGreaterThan(3);
    });

    it(`${which}: a cancel that does NOT land is reported, never swallowed and never thrown`, async () => {
      // A failing cancel means the execution may still be running and the bill may still be
      // growing. That is worse news than the abandonment, so it travels ON the refusal — replacing
      // the refusal with it would lose the deadline, the elapsed time and the execution id at once.
      const { go } = harness(which, {
        status: RUNNING,
        elapsedPerPoll: 100_000,
        cancelResponds: () => new Response('nope', { status: 500 }),
      });
      const err = await go.then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.name).toBe('DuneExecutionAbandoned');
      expect((err as unknown as { cancelAcknowledged: boolean }).cancelAcknowledged).toBe(false);
      expect(err?.message).toMatch(/Cancel was NOT acknowledged/);
      expect(err?.message).not.toContain(SENTINEL_KEY);
    });
  }

  it('the CENSUS gives it its own exit code, ahead of the generic vendor branch', async () => {
    // `DuneExecutionAbandoned` IS a `DuneRefused`, so ORDER is the guard: checked second it would be
    // swallowed and reported as exit 4, and an operator could not tell "we stopped this" from "this
    // broke" — which is how the 180-credit incident stayed invisible in the first place. Driven
    // through the REAL CLI over a scripted transport, so a refactor that keeps the behaviour keeps
    // the test and one that loses the distinction fails it.
    expect(new Set(Object.values(EXIT)).size).toBe(Object.values(EXIT).length);
    expect(EXIT.deadline).not.toBe(EXIT.vendor);

    // WE stopped it: the vendor never settles, so the run reaches its own deadline.
    const stopped = await runCensusAgainstVendorState('QUERY_STATE_PENDING');
    expect(stopped.code).toBe(EXIT.deadline);
    expect(stopped.paths).toContain('/execution/exec-1/cancel');
    expect(stopped.lines).toMatch(/^stopped: /m);

    // DUNE stopped it: the same catch, one branch further down, and the outcome must not collapse
    // into the one above.
    const broke = await runCensusAgainstVendorState('QUERY_STATE_FAILED');
    expect(broke.code).toBe(EXIT.vendor);
    expect(broke.paths.some((p) => p.endsWith('/cancel'))).toBe(false);
    expect(broke.lines).toMatch(/^refused: /m);
  });

  it('the REPRODUCTION lane cancels too — a custody wrapper may not drop the one request that stops a spend', async () => {
    // `recordCustody` decorates the client the whole reproduction run is driven with. A decorator
    // that forwards everything EXCEPT `cancelExecution` turns "no path leaves a live execution
    // running" into a TypeError swallowed as `cancelAcknowledged: false`, and the engine bills to
    // Dune's 30-minute limit — which is exactly the failure this lane's own 600 s deadline is
    // priced against.
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      const path = String(url).slice(DUNE_API_BASE.length);
      paths.push(path);
      if (path.endsWith('/execute')) return new Response(JSON.stringify({ execution_id: 'exec-1' }), { status: 200 });
      if (path.endsWith('/cancel')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ state: 'QUERY_STATE_PENDING' }), { status: 200 });
    });
    const inner = new ScreenDuneClient({
      key: SENTINEL_KEY,
      maxExecutions: 1,
      maxRequests: 50,
      minIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => {},
    });
    const { client: wrapped, log } = recordCustody(inner as never);
    let elapsed = 0;
    const err = await screenExecuteAndRead(
      wrapped as never,
      7,
      {},
      {
        pollIntervalMs: 0,
        maxPollAttempts: 5,
        executionDeadlineMs: 120_000,
        maxResultRows: 100,
        clock: () => {
          const now = elapsed;
          elapsed += 100_000;
          return now;
        },
      },
    ).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.name).toBe('DuneExecutionAbandoned');
    expect((err as unknown as { cancelAcknowledged: boolean }).cancelAcknowledged).toBe(true);
    expect(paths).toContain('/execution/exec-1/cancel');
    // And the custody log still says what it is a statement about: the cancel is not an execution.
    expect(log.filter((c) => c.kind === 'execute')).toHaveLength(1);
  });

  it('the CENSUS dry run states the deadline beside the ceilings, free and with no key', () => {
    // A worst case is what a plan is REFUSED on; the deadline is what the run will actually do about
    // an execution that will not finish. An operator sizing a month needs both, and needs them
    // without spending anything to see them.
    const lines: string[] = [];
    return censusMain([], {}, (l) => lines.push(l)).then((code) => {
      expect(code).toBe(EXIT.ok);
      const out = lines.join('\n');
      expect(out).toMatch(/deadline\s+120s execution deadline/);
      expect(out).toMatch(/at most 13 credit\(s\) of compute/);
      expect(out).toMatch(/worst case\s+224\.51 credit\(s\)/);
    });
  });
});
