/**
 * Fixtures for the lane budget every Dune execution now passes through (captain decision 437(a)).
 *
 * Two things a test that drives a Dune execution needs, and both are deliberately here rather than
 * copied into six suites:
 *
 * - **A cleared pre-flight verdict.** `dune.mjs` → `openLaneBudget` takes its ceiling and its policy
 *   from the decision the lane was ADMITTED on, so a caller has to hand one over. The default is a
 *   comfortably sufficient one; a test that wants the ceiling to bite narrows it.
 * - **A `POST /usage` answer.** The budget re-reads the live balance before EVERY execution — that
 *   re-read is the whole of what a once-only pre-flight lacked — so a fetch stub that does not serve
 *   `/usage` makes the balance unreadable and the lane refuses. That refusal is correct behaviour
 *   and is asserted in its own test; here the point is to let the other suites exercise what they
 *   are about.
 *
 * These are synthetic, exactly like every other fixture in this repository. Nothing here is a
 * captured vendor payload.
 */

import type { AllowanceDecision, DuneLaneBudget, DuneSpendPlan } from '../tools/deployer-screen/client.mjs';
import { openLaneBudget } from '../tools/deployer-screen/dune.mjs';

/** A `POST /usage` body in the documented shape, reporting `used` of `included` for the period. */
export function usageResponseBody(used = 0, included = 4_000): unknown {
  return {
    billing_periods: [
      {
        start_date: '2026-07-29T00:00:00Z',
        end_date: '2026-08-29T00:00:00Z',
        credits_used: used,
        credits_included: included,
      },
    ],
  };
}

/**
 * True when a fetched URL is the free usage endpoint. Written as a predicate rather than a string
 * compare so a stub matches whichever base the client under test was built with.
 */
export function isUsagePath(path: string): boolean {
  return path.replace(/\?.*$/, '').endsWith('/usage');
}

/**
 * A pre-flight verdict that cleared. `worstCaseCredits` is what the lane's stop is taken from, so a
 * test that wants a lane refused mid-run passes a small one — the budget floors the ceiling at ONE
 * engine-priced execution regardless, which is why a lane cannot be starved below its own first
 * execution however small this is.
 */
export function clearedAllowance(over: Partial<AllowanceDecision> = {}): AllowanceDecision {
  return {
    verdict: 'sufficient',
    ok: true,
    worstCaseCredits: 1_000,
    creditsUsed: 0,
    creditsIncluded: 4_000,
    monthlyCapCredits: 4_000,
    creditsIncludedVendor: 4_000,
    bindingCeiling: 'vendor-plan',
    creditsRemaining: 4_000,
    reserveCredits: 25,
    spendableCredits: 3_975,
    shortfallCredits: 0,
    periodStart: '2026-07-29',
    periodEnd: '2026-08-29',
    readAtUtc: '2026-08-10T00:00:00.000Z',
    reasons: [],
    caveats: ['synthetic test fixture'],
    ...over,
  };
}

/**
 * A bounds object with a lane budget attached, for a test driving `executeAndRead` directly.
 *
 * The budget is a real one built by the production opener, not a stub: a fixture that faked the
 * budget would let a wiring defect pass, which is the failure this whole change is about. It is
 * opened against a comfortably cleared verdict, so it refuses nothing and the suite under it stays
 * about its own subject.
 */
export function budgetedBounds<T extends { maxPollAttempts: number; pollIntervalMs: number }>(
  bounds: T,
  allowance: AllowanceDecision = clearedAllowance(),
): T & { laneBudget: DuneLaneBudget; executionPlan: DuneSpendPlan } {
  const executionPlan: DuneSpendPlan = {
    lane: 'test fixture',
    executions: 1,
    creditsPerExecution: 0,
    resultReads: 1,
    rowsPerRead: 0,
    bytesPerRow: 0,
  };
  return {
    ...bounds,
    laneBudget: openLaneBudget({
      lane: 'test fixture',
      allowance,
      executionPlan,
      executionDeadlineMs: bounds.maxPollAttempts * bounds.pollIntervalMs,
    }),
    executionPlan,
  };
}
