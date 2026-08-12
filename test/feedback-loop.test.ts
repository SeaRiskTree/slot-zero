/**
 * The screen's feedback loop — `tools/deployer-screen/prediction.mjs`, `outcome.mjs` and
 * `grade.mjs`.
 *
 * The lane exists to satisfy the captain's requirement that the research repeat itself and improve:
 * *"we do the same research in a repeatable way … then loop the process continuous getting better"*.
 * Four claims carry the whole thing, and every one of them rots silently if it is only described:
 *
 * 1. **A run records what it PREDICTED, and an unmeasured verdict is not a prediction.** Reading one
 *    as "not beatable" would let the screen score itself right whenever its own budget ran out —
 *    captain decision 174b's failure mode wearing a hit rate. Asserted on the mapping and on the
 *    exhaustiveness of the verdict table, so a verdict added later cannot acquire a claim by default.
 * 2. **The grade is OUT OF SAMPLE.** Only launches created after the claim are measured. Without
 *    this the outcome agrees with the prediction by construction and the hit rate means nothing, so
 *    it is asserted against a stub that records which launches were actually walked.
 * 3. **The loop is idempotent and a settled grade is never revised.** A lane that rewrote its own
 *    past grades would be marking its own homework twice.
 * 4. **Every provider call is bounded and the plan is refused BEFORE spending.** The keys are shared
 *    with production; an unbounded call here is not a nit.
 *
 * Nothing here reaches the network: the clients take injected `fetchImpl`/`sleepImpl` seams, exactly
 * as the rest of this suite does.
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENTRY_VERDICTS, UNMEASURED_VERDICTS } from '../tools/deployer-screen/entry.mjs';
import {
  loadGradeLedger,
  createKeylessClientPool,
  main as gradeMain,
  measureOutcome,
  parseArgs,
  planFits,
  priceClaim,
  REQUIRED_ENTRY_RECIPE,
  REQUIRED_ENTRY_RECIPE_SCHEDULES,
  saveGradeLedger,
} from '../tools/deployer-screen/grade.mjs';
import {
  dueForMeasurement,
  emptyGradeLedger,
  gradeKeyOf,
  gradeOne,
  GRADE_LEDGER_VERSION,
  mergeGrades,
  summariseGrades,
  UNGRADED_REASONS,
} from '../tools/deployer-screen/outcome.mjs';
import {
  DEFERRED_SUBJECTS,
  ENTRY_CLAIM_BY_VERDICT,
  MIN_GRADEABLE_SCHEMA,
  PREDICTION_CLAIMS,
  buildPredictionBlock,
  entryPredictionClaim,
  extractPredictions,
  summarisePredictions,
} from '../tools/deployer-screen/prediction.mjs';
import { KeylessClient, SolanaRpcClient } from '../tools/deployer-screen/pumpfun.mjs';
import { loadThresholds } from '../tools/deployer-screen/screen.mjs';

const T = loadThresholds();
const S2 = T['stage2_entry'] as Record<string, number>;
const S2COST = T['stage2_cost'] as Record<string, number>;
const F = T['feedback_loop'] as Record<string, number>;
const MS_PER_DAY = 86_400_000;

const MADE_AT = '2026-06-01T00:00:00.000Z';
const MADE_AT_MS = Date.parse(MADE_AT);

/** A claim as `extractPredictions` hands one over. */
function claimFixture(over: Record<string, unknown> = {}) {
  return {
    source: 'run-a.json',
    wallet: 'Wa11etaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    subject: 'entry',
    claim: 'not-beatable' as const,
    verdict: 'entry-room-absent',
    madeAtIso: MADE_AT,
    outOfSampleAfterMs: MADE_AT_MS,
    gateReading: 'creation-derived',
    entryReading: 'stage 2, over swap-api fills',
    thresholdsVersion: '5.5.0',
    stage2Entry: { ...S2 },
    stage2Cost: { ...S2COST },
    ...over,
  };
}

/** A synthetic outcome measurement. */
function outcomeFixture(verdict: string, over: Record<string, unknown> = {}) {
  return {
    verdict,
    unmeasuredCause: (UNMEASURED_VERDICTS as readonly string[]).includes(verdict)
      ? 'too-few-windows-available'
      : null,
    launchesOffered: 20,
    launchesAfterBoundary: 12,
    launchesScored: 10,
    launchesDropped: 0,
    roomLeftMedian: 0.1,
    coverageProvenBackToBoundary: true,
    keylessRequests: 40,
    rpcRequests: 0,
    ...over,
  } as never;
}

describe('the prediction a run records — the half without which nothing can ever be graded', () => {
  it('maps every MEASURED verdict to a claim, and the table is exhaustive over the vocabulary', () => {
    // Exhaustiveness is the assertion that matters: a verdict added later must come to the mapping
    // ON PURPOSE rather than acquiring `null` by default, because a defaulted `null` reads as "no
    // prediction" and would silently make a whole class of finding unfalsifiable again.
    expect(Object.keys(ENTRY_CLAIM_BY_VERDICT).sort()).toEqual([...ENTRY_VERDICTS].sort());
    expect(entryPredictionClaim({ verdict: 'entry-open-after-costs' }).claim).toBe('beatable');
    for (const v of ['entry-room-absent', 'entry-cost-prohibitive', 'entry-field-loss-making']) {
      expect(entryPredictionClaim({ verdict: v }).claim, v).toBe('not-beatable');
    }
    // And nothing outside the two-value vocabulary can be produced.
    for (const v of ENTRY_VERDICTS) {
      const c = entryPredictionClaim({ verdict: v, unmeasuredCause: 'too-few-windows-available' }).claim;
      expect(c === null || (PREDICTION_CLAIMS as readonly string[]).includes(c)).toBe(true);
    }
  });

  it('an UNMEASURED verdict yields NO claim — never a prediction of "not beatable"', () => {
    // The load-bearing one. Both unmeasured verdicts describe OUR coverage, so predicting from them
    // would let the screen be graded correct whenever its own walk ran out of budget.
    for (const v of UNMEASURED_VERDICTS) {
      const r = entryPredictionClaim({ verdict: v, unmeasuredCause: 'too-few-proven-windows' });
      expect(r.claim, v).toBeNull();
      expect(r.measured, v).toBe(false);
      expect(r.noClaimReason, v).toBe('entry-unmeasured');
      expect(r.unmeasuredCause, v).toBe('too-few-proven-windows');
      expect(r.reason).toMatch(/174b/);
    }
    // A schema-≤9 record carries no cause at all, and that is still not a prediction: the predicate
    // fails safe rather than guessing which producer fired.
    expect(entryPredictionClaim({ verdict: 'entry-unmeasured' }).claim).toBeNull();
  });

  it('a candidate Stage 2 never scored is `not-scored`, which is NOT `entry-unmeasured`', () => {
    // Two states of the world that both produce no claim, kept apart because they mean opposite
    // things about spend: the first cost nothing, the second cost a full Stage 2 walk each.
    const notScored = entryPredictionClaim(null);
    expect(notScored.claim).toBeNull();
    expect(notScored.noClaimReason).toBe('not-scored');
    expect(notScored.verdict).toBeNull();
    expect(notScored.noClaimReason).not.toBe(
      entryPredictionClaim({ verdict: 'entry-unmeasured', unmeasuredCause: 'windows-dropped' }).noClaimReason,
    );
  });

  it('an unrecognised verdict fails SAFE rather than being mapped by guesswork', () => {
    const r = entryPredictionClaim({ verdict: 'entry-room-present' });
    expect(r.claim).toBeNull();
    expect(r.measured).toBe(false);
    expect(r.noClaimReason).toBe('verdict-unrecognised');
  });

  it('the block RESTATES the verdict beside it and invents nothing — no measurement moves', () => {
    // The scope limit of the whole lane, asserted on the shape: every field of a claim is derived
    // from the finding handed in, so a run's verdicts are what they were with the block present.
    for (const v of ENTRY_VERDICTS) {
      const entry = { verdict: v, unmeasuredCause: 'windows-dropped' };
      const block = buildPredictionBlock({
        entry,
        madeAtIso: MADE_AT,
        gateReading: 'creation-derived',
        thresholdsVersion: '5.5.0',
      });
      expect(block.claims).toHaveLength(1);
      expect(block.claims[0]!.verdict, v).toBe(v);
      expect(block.madeAtIso).toBe(MADE_AT);
      // Same inputs, same block — it holds no clock, no counter and no state of its own.
      expect(
        JSON.stringify(
          buildPredictionBlock({ entry, madeAtIso: MADE_AT, gateReading: 'creation-derived', thresholdsVersion: '5.5.0' }),
        ),
      ).toBe(JSON.stringify(block));
    }
  });

  it('every claim names BOTH readings, and they are different surfaces', () => {
    // The defect three lanes have just finished correcting is two quantities wearing one name, and
    // a new record format is exactly where it would be reintroduced. The GATE reading and the ENTRY
    // reading are different surfaces and the block says so separately.
    const block = buildPredictionBlock({
      entry: { verdict: 'entry-room-absent' },
      madeAtIso: MADE_AT,
      gateReading: 'ownership-only',
      thresholdsVersion: '5.5.0',
    });
    expect(block.gateReading).toBe('ownership-only');
    expect(block.entryReading).toMatch(/STAGE 2 ENTRY/);
    expect(block.entryReading).not.toBe(block.gateReading);
    // And it says out loud that the two must not be pooled, on the record rather than in a README.
    expect(block.entryReading).toMatch(/never be pooled/i);
  });

  it('Stage 3\'s absence is RECORDED, and claims are a list so adding it invalidates nothing', () => {
    // Captain decision 237a defers Stage 3. A record that simply omitted an exit claim would be
    // indistinguishable from one that tried and failed, so the absence is declared — and because
    // claims are keyed by subject, a later build appends rather than resets.
    const deferred = DEFERRED_SUBJECTS.map((d) => d.subject);
    expect(deferred).toContain('exit');
    expect(DEFERRED_SUBJECTS[0]!.reason).toMatch(/237a/);
    const summary = summarisePredictions([]) as Record<string, any>;
    expect(summary.subjects).toEqual(['entry']);
    expect(summary.subjectsDeferred.map((d: { subject: string }) => d.subject)).toContain('exit');
    // The list shape is the forward-compatibility contract: an appended subject changes no existing
    // entry, so a schema-16 record stays gradeable on `entry` forever.
    expect(
      Array.isArray(
        buildPredictionBlock({ entry: null, madeAtIso: MADE_AT, gateReading: 'x', thresholdsVersion: null }).claims,
      ),
    ).toBe(true);
  });

  it('the run summary breaks no-claim out BY REASON rather than as a total', () => {
    const rows = [
      { prediction: buildPredictionBlock({ entry: { verdict: 'entry-open-after-costs' }, madeAtIso: MADE_AT, gateReading: 'g', thresholdsVersion: null }) },
      { prediction: buildPredictionBlock({ entry: { verdict: 'entry-room-absent' }, madeAtIso: MADE_AT, gateReading: 'g', thresholdsVersion: null }) },
      { prediction: buildPredictionBlock({ entry: { verdict: 'entry-unmeasured', unmeasuredCause: 'windows-dropped' }, madeAtIso: MADE_AT, gateReading: 'g', thresholdsVersion: null }) },
      { prediction: buildPredictionBlock({ entry: null, madeAtIso: MADE_AT, gateReading: 'g', thresholdsVersion: null }) },
    ];
    const s = summarisePredictions(rows) as Record<string, any>;
    // Every row here is gate-arm (no `admissionArm`, which is exactly what a schema-<=25 record
    // carries), so the gate arm holds all of it and the sub-gate arm reads a true zero.
    expect(s.byArm.gate).toEqual({ withClaim: 2, beatable: 1, notBeatable: 1 });
    expect(s.byArm['sub-gate']).toEqual({ withClaim: 0, beatable: 0, notBeatable: 0 });
    expect(s.noClaim).toBe(2);
    // A run with two `not-scored` and a run with two `entry-unmeasured` are in completely different
    // states, and a lump total could not tell them apart.
    expect(s.noClaimByReason).toEqual({ 'entry-unmeasured': 1, 'not-scored': 1 });
    expect(s.caveat).toMatch(/CLAIMS, NOT RESULTS/);
  });
});

describe('extracting claims from committed records', () => {
  const recordFixture = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 16,
    finishedAtIso: MADE_AT,
    thresholdsVersion: '5.5.0',
    thresholds: { stage2_entry: { ...S2 }, stage2_cost: { ...S2COST } },
    candidates: [
      {
        wallet: 'Wa11etaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        prediction: buildPredictionBlock({
          entry: { verdict: 'entry-room-absent' },
          madeAtIso: MADE_AT,
          gateReading: 'creation-derived',
          thresholdsVersion: '5.5.0',
        }),
      },
    ],
    ...over,
  });

  it('refuses a record older than the entry-cost vocabulary, WHOLE and by version', () => {
    // The boundary is the record's version and not the verdict's. `entry-room-present` has no
    // modern equivalent at all, and its sibling `entry-room-absent` survived the rename while the
    // question around it changed — so cherry-picking the surviving label would be the same-name /
    // different-quantity conflation this lane was released to avoid reintroducing.
    const { predictions, refused } = extractPredictions([
      { file: 'old.json', body: recordFixture({ schemaVersion: MIN_GRADEABLE_SCHEMA - 1 }) },
    ]);
    expect(predictions).toHaveLength(0);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatch(/predates the entry-cost verdict vocabulary/);
  });

  it('refuses a gradeable-schema record that carries no claim, and says it is PERMANENTLY so', () => {
    const { predictions, refused } = extractPredictions([
      { file: 'nopred.json', body: recordFixture({ candidates: [{ wallet: 'W', verdict: 'gate-failed' }] }) },
    ]);
    expect(predictions).toHaveLength(0);
    expect(refused[0]!.reason).toMatch(/PERMANENTLY unfalsifiable/);
  });

  it('takes the boundary from finishedAtIso and the recipe from the RUN, never from today', () => {
    // A claim graded at bars it never saw is not graded — it is compared to a different screen. So
    // the recipe travels with the claim, and a record that cannot supply one is refused rather than
    // defaulted.
    const { predictions } = extractPredictions([{ file: 'run.json', body: recordFixture() }]);
    expect(predictions).toHaveLength(1);
    expect(predictions[0]!.outOfSampleAfterMs).toBe(MADE_AT_MS);
    expect(predictions[0]!.stage2Entry['minRoomLeft']).toBe(S2['minRoomLeft']);

    const { predictions: none, refused } = extractPredictions([
      { file: 'nothresh.json', body: recordFixture({ thresholds: { stage2_entry: { ...S2 } } }) },
    ]);
    expect(none).toHaveLength(0);
    expect(refused[0]!.reason).toMatch(/bars its claims were made under are unknown/);
  });

  it('carries a claim about a subject this build cannot measure forward, rather than refusing it', () => {
    // A record written by a newer build (one that predicts EXIT) must not read as broken here.
    const body = recordFixture();
    (body.candidates[0]!.prediction.claims as unknown[]).push({
      subject: 'exit',
      claim: 'beatable',
      verdict: 'exit-open',
    });
    const { predictions, refused } = extractPredictions([{ file: 'newer.json', body }]);
    expect(predictions).toHaveLength(1);
    expect(predictions[0]!.subject).toBe('entry');
    expect(refused).toHaveLength(0);
  });

  it('THE STATE OF THE COMMITTED RECORDS TODAY: not one of them can be graded', () => {
    // Asserted rather than described, because it is the finding that justifies the whole lane: every
    // run committed before schema 16 is PERMANENTLY unfalsifiable. If a future record makes this
    // fail, that is the loop starting to work and the assertion is the place to record it.
    const dir = join(__dirname, '..', 'tools', 'deployer-screen', 'runs');
    const files = ['2026-07-29-elite.json', '2026-08-02-good.json', '2026-08-04.json'].map((f) => ({
      file: f,
      body: JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown,
    }));
    const { predictions, refused } = extractPredictions(files);
    expect(predictions).toHaveLength(0);
    expect(refused).toHaveLength(3);
    // Two are refused by vocabulary, one is a modern record whose every scored candidate reached an
    // unmeasured verdict — a run that could not answer, and now cannot be shown to have been wrong.
    expect(refused.filter((r) => /predates the entry-cost verdict vocabulary/.test(r.reason))).toHaveLength(2);
    expect(refused.filter((r) => /carries no claim/.test(r.reason))).toHaveLength(1);
  });
});

describe('grading a claim, out of sample', () => {
  const NOW_ISO = '2026-07-01T00:00:00.000Z';

  it('scores a hit and a miss on the CLAIM, not on the verdict', () => {
    // `entry-room-absent` and `entry-cost-prohibitive` are different verdicts and the SAME
    // prediction. A screen that said "not beatable" for one reason and was right for another is
    // right; grading verdict-against-verdict would score it on a question it never asked.
    const p = claimFixture();
    const hit = gradeOne(p as never, outcomeFixture('entry-cost-prohibitive'), null, NOW_ISO);
    expect(hit.state).toBe('hit');
    expect(hit.outcomeClaim).toBe('not-beatable');
    expect(hit.outcomeVerdict).toBe('entry-cost-prohibitive');
    expect(hit.gradedAtIso).toBe(NOW_ISO);

    const miss = gradeOne(p as never, outcomeFixture('entry-open-after-costs'), null, NOW_ISO);
    expect(miss.state).toBe('miss');
    expect(miss.outcomeClaim).toBe('beatable');
  });

  it('an UNMEASURED outcome grades NOTHING and stays out of the denominator', () => {
    // Captain decision 174b on the outcome side. Counting it as a miss would make the screen score
    // worse the flakier pump.fun's endpoint was on the day the grader happened to run.
    const row = gradeOne(claimFixture() as never, outcomeFixture('entry-unmeasured'), null, NOW_ISO);
    expect(row.state).toBe('ungraded');
    expect(row.ungradedReason).toBe('outcome-unmeasured');
    expect(row.outcomeClaim).toBeNull();
    expect(row.gradedAtIso).toBeNull();
    // The measurement is still kept — it is evidence about coverage even when it grades nothing.
    expect(row.outcome).not.toBeNull();
    const { ledger } = mergeGrades(emptyGradeLedger(), [row], NOW_ISO);
    expect((summariseGrades(ledger) as Record<string, any>).byArm.gate.overall).toEqual({ n: 0, hits: 0, rate: null });
  });

  it('names the reading on every row, so an outcome figure can never be pooled with another', () => {
    const row = gradeOne(claimFixture() as never, outcomeFixture('entry-room-absent'), null, NOW_ISO);
    expect(row.outcomeReading).toMatch(/OUT OF SAMPLE/);
    expect(row.outcomeReading).toMatch(/PREDICTING run recorded/);
    expect(row.gateReading).toBe('creation-derived');
  });
});

describe('THE OUT-OF-SAMPLE FILTER — without it the hit rate means nothing', () => {
  const MINT = (i: number) => `MINT${String(i).padStart(38, '0')}pump`;
  const BOUNDARY = Date.parse('2026-06-01T00:00:00.000Z');
  const NOW = BOUNDARY + 60 * MS_PER_DAY;

  /**
   * A fill endpoint that serves ONE complete window per launch and then says nothing is older, so
   * coverage is discharged and every launch is usable. Copied in shape from the Stage 2 suite's own
   * fixture; the create slot carries a bundled transaction so the opening is PROVEN.
   */
  const walkableWindow = (operationSol: number) => {
    const mints: string[] = [];
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
      return [
        row('000000000140000000009', 'sellB', 'B', createdMs + 40_000, 'sell', 6, 500),
        row('000000000140000000008', 'sellA', 'A', createdMs + 40_000, 'sell', 6, 500),
        row('000000000100000000003', 'buyB', 'B', createdMs, 'buy', 5, 500),
        row('000000000100000000002', 'buyA', 'A', createdMs, 'buy', 5, 500),
        row('000000000100000000001', 'devtx', 'devbook', createdMs, 'buy', operationSol / 2, 100),
        row('000000000100000000000', 'devtx', 'dev', createdMs, 'buy', operationSol / 2, 100),
      ];
    };
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url));
      mints.push(u.pathname.split('/')[3] ?? '');
      const cursorMs = Number(String(u.searchParams.get('cursor')).split('-')[1]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ trades: rows(cursorMs - 65_000), pagination: { hasMore: false } }),
      };
    }) as unknown as typeof fetch;
    return { fetchImpl, mints };
  };

  /** A vendor profile straddling the boundary: `before` launches under it, `after` launches over. */
  const straddlingProfile = (before: number, after: number) => ({
    pump_tokens: [
      ...Array.from({ length: before }, (_, i) => ({
        mint: MINT(i),
        created_timestamp: BOUNDARY - (i + 1) * MS_PER_DAY,
        complete: true,
      })),
      ...Array.from({ length: after }, (_, i) => ({
        mint: MINT(100 + i),
        created_timestamp: BOUNDARY + (i + 1) * MS_PER_DAY,
        complete: true,
      })),
    ],
  });

  const clientsFor = (fetchImpl: typeof fetch, profile: unknown) => ({
    keyed: { getJson: async () => profile } as never,
    keylessFor: (retryBackoffMs: readonly number[]) =>
      new KeylessClient({
        maxRequests: F['maxKeylessRequests']!,
        minIntervalMs: 0,
        retryBackoffMs,
        fetchImpl,
        sleepImpl: async () => {},
      }),
    rpcFor: () =>
      new SolanaRpcClient({
        maxRequests: 10,
        minIntervalMs: 0,
        sleepImpl: async () => {},
        fetchImpl: (async () => {
          throw new Error('the cost leg must not spend a request in this test');
        }) as unknown as typeof fetch,
      }),
  });

  it('measures ONLY launches created after the claim, and every one of them', async () => {
    // The single property the whole lane rests on. Re-measuring the launches the prediction was made
    // from would agree with itself by construction and report a hit rate near 1.0 meaning nothing.
    const { fetchImpl, mints } = walkableWindow(90);
    const recipe = priceClaim(claimFixture() as never, F['keylessMinIntervalMs']!);
    expect(recipe.usable).toBe(true);
    const { outcome } = await measureOutcome(
      clientsFor(fetchImpl, straddlingProfile(20, 12)) as never,
      claimFixture({ outOfSampleAfterMs: BOUNDARY }) as never,
      recipe as never,
      NOW,
    );
    expect(outcome).not.toBeNull();
    expect(outcome!.launchesOffered).toBe(32);
    expect(outcome!.launchesAfterBoundary).toBe(12);
    // Not one pre-boundary mint was ever fetched — asserted against the URLs, not inferred.
    const walked = new Set(mints);
    expect(walked.size).toBeGreaterThan(0);
    for (const m of walked) {
      const index = Number(m.replace(/^MINT0*/, '').replace(/pump$/, '') || '0');
      expect(index, `${m} is a pre-boundary launch and must never have been walked`).toBeGreaterThanOrEqual(100);
    }
    // And the page reached back past the boundary, so the post-prediction period is covered whole.
    expect(outcome!.coverageProvenBackToBoundary).toBe(true);
    // The room the operation left is 10 of 100, well under the bar — a real Stage 2 verdict from a
    // real Stage 2 walk, which is what makes the outcome comparable with the claim.
    expect(outcome!.verdict).toBe('entry-room-absent');
  });

  it('reports when the vendor page did NOT reach back past the boundary', async () => {
    // Not a defect in the grade — every launch measured is still out of sample — but a bound on
    // what the outcome saw, and a page cap is exactly the kind of limit that reads as a measurement
    // when it is left unstated.
    const { fetchImpl } = walkableWindow(90);
    const recipe = priceClaim(claimFixture() as never, F['keylessMinIntervalMs']!);
    const { outcome } = await measureOutcome(
      clientsFor(fetchImpl, straddlingProfile(0, 12)) as never,
      claimFixture({ outOfSampleAfterMs: BOUNDARY }) as never,
      recipe as never,
      NOW,
    );
    expect(outcome!.coverageProvenBackToBoundary).toBe(false);
  });

  it('a deployer with no post-boundary launch is UNGRADED, never a miss', async () => {
    // Absence of evidence. It is also not evidence the deployer stopped launching — the profile is
    // a 70-record page and this reading is bounded by it, which the reason says.
    const { fetchImpl, mints } = walkableWindow(90);
    const recipe = priceClaim(claimFixture() as never, F['keylessMinIntervalMs']!);
    const { outcome, refusal } = await measureOutcome(
      clientsFor(fetchImpl, straddlingProfile(20, 0)) as never,
      claimFixture({ outOfSampleAfterMs: BOUNDARY }) as never,
      recipe as never,
      NOW,
    );
    expect(outcome).toBeNull();
    expect(refusal!.reason).toBe('no-post-prediction-launches');
    // Nothing was walked, so nothing was spent on a claim that could not be scored.
    expect(mints).toHaveLength(0);
    const row = gradeOne(claimFixture() as never, outcome, refusal, '2026-08-01T00:00:00.000Z');
    expect(row.state).toBe('ungraded');
  });

  it('walks at the RETRY SCHEDULE the predicting run recorded, not at this build`s default', async () => {
    // Same-recipe-same-bars reaches the retry schedule too: its length is what each request reserves
    // against `maxRequestsPerLaunch`, so a claim walked at a schedule its own run never used is
    // walked over a different sample of launches — and nothing in the output would say so.
    const attempts = async (schedule: readonly number[]) => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        throw new Error('shed');
      }) as unknown as typeof fetch;
      const recipe = priceClaim(
        claimFixture({ stage2Entry: { ...S2, keylessRetryBackoffMs: schedule } }) as never,
        F['keylessMinIntervalMs']!,
      );
      const clients = {
        keyed: { getJson: async () => straddlingProfile(0, 1) } as never,
        keylessFor: (retryBackoffMs: readonly number[]) =>
          new KeylessClient({ maxRequests: 100, minIntervalMs: 0, retryBackoffMs, fetchImpl, sleepImpl: async () => {} }),
        rpcFor: () => null,
      };
      await measureOutcome(clients as never, claimFixture({ outOfSampleAfterMs: BOUNDARY }) as never, recipe as never, NOW);
      return calls;
    };
    expect(await attempts([])).toBe(1);
    expect(await attempts([1, 1])).toBe(3);
  });
});

describe('the grade ledger is the only copy of a latched grade, so it is never silently replaced', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slot-zero-grade-ledger-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const settled = () =>
    mergeGrades(
      emptyGradeLedger(),
      [gradeOne(claimFixture() as never, outcomeFixture('entry-room-absent'), null, '2026-07-01T00:00:00.000Z')],
      '2026-07-01T00:00:00.000Z',
    ).ledger;

  it('an ABSENT ledger is a first run and proceeds', () => {
    expect(loadGradeLedger(join(dir, 'nope.json')).grades).toEqual({});
  });

  it('a CORRUPT ledger refuses, naming the file, rather than starting over', () => {
    // The failure this closes: a hit or a miss is latched and never revised, so an empty ledger
    // returned here is written straight back over every settled grade by the next --live run.
    const path = join(dir, 'grades.json');
    writeFileSync(path, '{"schemaVersion": 1, "grades": {', 'utf8');
    expect(() => loadGradeLedger(path)).toThrow(new RegExp(path.replace(/[.\\/]/g, '\\$&')));
    expect(() => loadGradeLedger(path)).toThrow(/Refusing to start over/);
    // Not an object, and no readable grades block, are the same refusal.
    writeFileSync(path, '"a ledger this is not"', 'utf8');
    expect(() => loadGradeLedger(path)).toThrow(/not an object/);
    writeFileSync(path, JSON.stringify({ schemaVersion: GRADE_LEDGER_VERSION }), 'utf8');
    expect(() => loadGradeLedger(path)).toThrow(/no readable "grades" block/);
  });

  it('a ledger from a schema this build does not know refuses', () => {
    const path = join(dir, 'grades.json');
    writeFileSync(path, JSON.stringify({ ...settled(), schemaVersion: GRADE_LEDGER_VERSION + 1 }), 'utf8');
    expect(() => loadGradeLedger(path)).toThrow(/never retro-fitted/);
  });

  it('a corrupt ledger is TERMINAL for the run, and the run writes nothing', async () => {
    const path = join(dir, 'grades.json');
    const corrupt = '{"schemaVersion": 1, "grades": {';
    writeFileSync(path, corrupt, 'utf8');
    mkdirSync(join(dir, 'runs'), { recursive: true });
    const err: string[] = [];
    const code = await gradeMain(
      { help: false, live: true, runsDir: join(dir, 'runs'), ledgerPath: path, claims: null, json: false },
      { MADEONSOL_API_KEY: 'msk_feedbackloopfixture0000000000' },
      () => {},
      (l) => err.push(l),
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/Refusing to start over/);
    // Untouched, byte for byte — the whole point of the refusal.
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
  });

  it('writes ATOMICALLY, so a run killed mid-write cannot leave a truncated ledger', () => {
    // Temp file in the same directory, then rename over the target: within one directory rename is
    // atomic, so the target is either the old ledger or the new one and never half of either.
    const path = join(dir, 'nested', 'grades.json');
    saveGradeLedger(path, settled());
    expect(Object.keys(loadGradeLedger(path).grades)).toHaveLength(1);
    // No temp file survives a completed write.
    expect(readdirSync(join(dir, 'nested'))).toEqual(['grades.json']);
    const source = readFileSync(join(__dirname, '..', 'tools', 'deployer-screen', 'grade.mjs'), 'utf8');
    expect(source).toMatch(/renameSync\(tmp, path\)/);
    expect(source).not.toMatch(/writeFileSync\(path,/);
  });
});

describe('the loop is idempotent, and a settled grade is never revised', () => {
  const NOW_ISO = '2026-07-01T00:00:00.000Z';

  it('merging the same rows twice writes the same bytes', () => {
    const rows = [
      gradeOne(claimFixture() as never, outcomeFixture('entry-room-absent'), null, NOW_ISO),
      gradeOne(claimFixture({ source: 'run-b.json' }) as never, outcomeFixture('entry-open-after-costs'), null, NOW_ISO),
    ];
    const once = mergeGrades(emptyGradeLedger(), rows, NOW_ISO);
    const twice = mergeGrades(once.ledger, rows, NOW_ISO);
    expect(JSON.stringify(twice.ledger)).toBe(JSON.stringify(once.ledger));
    // The second pass changed nothing and SAID so, rather than silently rewriting.
    expect(twice.added).toBe(0);
    expect(twice.updated).toBe(0);
    expect(twice.latched).toBe(2);
  });

  it('a settled grade is never overwritten, even by a later disagreeing measurement', () => {
    const p = claimFixture();
    const first = mergeGrades(emptyGradeLedger(), [gradeOne(p as never, outcomeFixture('entry-room-absent'), null, NOW_ISO)], NOW_ISO);
    const key = gradeKeyOf(p as never);
    expect(first.ledger.grades[key]!.state).toBe('hit');
    const later = mergeGrades(
      first.ledger,
      [gradeOne(p as never, outcomeFixture('entry-open-after-costs'), null, '2026-09-01T00:00:00.000Z')],
      '2026-09-01T00:00:00.000Z',
    );
    expect(later.ledger.grades[key]!.state).toBe('hit');
    expect(later.latched).toBe(1);
  });

  it('an ungraded row IS updated, so the loop converges without a flag', () => {
    const p = claimFixture();
    const first = mergeGrades(emptyGradeLedger(), [gradeOne(p as never, outcomeFixture('entry-unmeasured'), null, NOW_ISO)], NOW_ISO);
    const second = mergeGrades(first.ledger, [gradeOne(p as never, outcomeFixture('entry-room-absent'), null, '2026-08-01T00:00:00.000Z')], '2026-08-01T00:00:00.000Z');
    expect(second.ledger.grades[gradeKeyOf(p as never)]!.state).toBe('hit');
    expect(second.updated).toBe(1);
  });

  it('the same wallet predicted by two runs is TWO claims, not one', () => {
    // Two distinct falsifiable statements made at two instants over two samples. Merging them would
    // let a later run's claim silently overwrite an earlier one's grade.
    const a = claimFixture({ source: 'run-a.json' });
    const b = claimFixture({ source: 'run-b.json' });
    expect(gradeKeyOf(a as never)).not.toBe(gradeKeyOf(b as never));
    const { ledger } = mergeGrades(
      emptyGradeLedger(),
      [gradeOne(a as never, outcomeFixture('entry-room-absent'), null, NOW_ISO), gradeOne(b as never, outcomeFixture('entry-open-after-costs'), null, NOW_ISO)],
      NOW_ISO,
    );
    expect(Object.keys(ledger.grades)).toHaveLength(2);
    expect((summariseGrades(ledger) as Record<string, any>).byArm.gate.overall).toEqual({ n: 2, hits: 1, rate: 0.5 });
  });

  it('never re-offers a settled claim, and a too-soon claim does not advance the retry clock', () => {
    const bounds = { minOutcomeAgeMs: 21 * MS_PER_DAY, retryAfterMs: 14 * MS_PER_DAY, maxClaimsPerRun: 3 };
    const p = claimFixture();
    const settledLedger = mergeGrades(emptyGradeLedger(), [gradeOne(p as never, outcomeFixture('entry-room-absent'), null, '2026-07-01T00:00:00.000Z')], '2026-07-01T00:00:00.000Z').ledger;
    const ripe = MADE_AT_MS + 30 * MS_PER_DAY;
    expect(dueForMeasurement([p as never], settledLedger, ripe, bounds).due).toHaveLength(0);
    expect(dueForMeasurement([p as never], settledLedger, ripe, bounds).settled).toBe(1);

    // Too soon: skipped, and no attempt is stamped — stamping one would push the retry window
    // forward on a row nobody looked at and stall the loop rather than pace it.
    const early = MADE_AT_MS + 3 * MS_PER_DAY;
    const tooSoon = dueForMeasurement([p as never], emptyGradeLedger(), early, bounds);
    expect(tooSoon.due).toHaveLength(0);
    expect(tooSoon.skipped[0]!.reason).toBe('too-soon');
    const row = gradeOne(p as never, null, { reason: 'too-soon', detail: null }, '2026-06-04T00:00:00.000Z');
    expect(row.lastAttemptIso).toBeNull();
    expect(row.attempts).toBe(0);
  });

  it('waits out the retry window, so a rerun the same day spends nothing', () => {
    const bounds = { minOutcomeAgeMs: 21 * MS_PER_DAY, retryAfterMs: 14 * MS_PER_DAY, maxClaimsPerRun: 3 };
    const p = claimFixture();
    const attemptedAt = MADE_AT_MS + 30 * MS_PER_DAY;
    const ledger = mergeGrades(
      emptyGradeLedger(),
      [gradeOne(p as never, outcomeFixture('entry-unmeasured'), null, new Date(attemptedAt).toISOString())],
      new Date(attemptedAt).toISOString(),
    ).ledger;
    expect(dueForMeasurement([p as never], ledger, attemptedAt + MS_PER_DAY, bounds).due).toHaveLength(0);
    expect(dueForMeasurement([p as never], ledger, attemptedAt + 15 * MS_PER_DAY, bounds).due).toHaveLength(1);
  });

  it('says COOLING OFF and says CAPPED with two different reasons, never one', () => {
    // The same conflation this lane refuses one level up between `not-scored` and
    // `entry-unmeasured`: reporting a cap that bound nothing tells the operator to raise a ceiling
    // that was never reached, and hides a backlog that is merely waiting.
    const bounds = { minOutcomeAgeMs: 21 * MS_PER_DAY, retryAfterMs: 14 * MS_PER_DAY, maxClaimsPerRun: 3 };
    const p = claimFixture();
    const attemptedAt = MADE_AT_MS + 30 * MS_PER_DAY;
    const ledger = mergeGrades(
      emptyGradeLedger(),
      [gradeOne(p as never, outcomeFixture('entry-unmeasured'), null, new Date(attemptedAt).toISOString())],
      new Date(attemptedAt).toISOString(),
    ).ledger;
    const cooling = dueForMeasurement([p as never], ledger, attemptedAt + MS_PER_DAY, bounds);
    expect(cooling.skipped.map((s) => s.reason)).toEqual(['awaiting-retry']);

    // Past the cap, with nothing cooling off: that IS the cap, and it keeps the other name.
    const capped = dueForMeasurement(
      [30, 10, 20].map((d) => claimFixture({ source: `run-${d}.json`, outOfSampleAfterMs: MADE_AT_MS + d * MS_PER_DAY })) as never,
      emptyGradeLedger(),
      MADE_AT_MS + 100 * MS_PER_DAY,
      { ...bounds, maxClaimsPerRun: 2 },
    );
    expect(capped.skipped.map((s) => s.reason)).toEqual(['not-attempted']);
    expect(UNGRADED_REASONS['awaiting-retry']).not.toBe(UNGRADED_REASONS['not-attempted']);
    // Each sentence asserts only its own cause.
    expect(UNGRADED_REASONS['awaiting-retry']).toMatch(/NO cap bound this run/);
    expect(UNGRADED_REASONS['not-attempted']).toMatch(/ONLY that cap/);
    // And neither is an attempt: a scheduling refusal must not stamp the retry clock on a row
    // nobody looked at.
    for (const reason of ['awaiting-retry', 'not-attempted', 'too-soon'] as const) {
      const row = gradeOne(p as never, null, { reason, detail: null }, '2026-08-01T00:00:00.000Z');
      expect(row.attempts, reason).toBe(0);
      expect(row.lastAttemptIso, reason).toBeNull();
    }
  });

  it('caps the work per run, reports the excess, and drains oldest first', () => {
    // An invisible cap reads as "there was nothing to do", so the excess is returned rather than
    // dropped — and the order is deterministic so two runs over the same ledger pick the same work.
    const bounds = { minOutcomeAgeMs: 0, retryAfterMs: 0, maxClaimsPerRun: 2 };
    const claims = [30, 10, 20].map((d) =>
      claimFixture({ source: `run-${d}.json`, outOfSampleAfterMs: MADE_AT_MS + d * MS_PER_DAY }),
    );
    const { due, skipped } = dueForMeasurement(claims as never, emptyGradeLedger(), MADE_AT_MS + 100 * MS_PER_DAY, bounds);
    expect(due.map((d) => d.source)).toEqual(['run-10.json', 'run-20.json']);
    expect(skipped.map((s) => s.reason)).toEqual(['not-attempted']);
    expect(skipped[0]!.prediction.source).toBe('run-30.json');
  });
});

describe('the hit rate, and what is kept out of its denominator', () => {
  const NOW_ISO = '2026-07-01T00:00:00.000Z';

  it('reports no observations rather than 0%, and publishes the ungraded tally beside the rate', () => {
    const rows = [
      gradeOne(claimFixture({ source: 'a.json' }) as never, outcomeFixture('entry-room-absent'), null, NOW_ISO),
      gradeOne(claimFixture({ source: 'b.json' }) as never, outcomeFixture('entry-unmeasured'), null, NOW_ISO),
      gradeOne(claimFixture({ source: 'c.json' }) as never, null, { reason: 'no-post-prediction-launches' }, NOW_ISO),
    ];
    const { ledger } = mergeGrades(emptyGradeLedger(), rows, NOW_ISO);
    const s = summariseGrades(ledger) as Record<string, any>;
    expect(s.byArm.gate.overall).toEqual({ n: 1, hits: 1, rate: 1 });
    expect(s.graded).toBe(1);
    expect(s.ungraded).toBe(2);
    expect(s.ungradedByReason).toEqual({ 'outcome-unmeasured': 1, 'no-post-prediction-launches': 1 });
    // Nothing beatable was ever claimed here, and that reads as no observations — not as 0%.
    expect(s.byArm.gate.byClaim.beatable).toEqual({ n: 0, hits: 0, rate: null });
    expect(s.caveat).toMatch(/ONLY AS GOOD AS ITS `n`/);
  });

  it('splits by what was CLAIMED, because a pooled rate hides a useless screen', () => {
    // A screen that says "not beatable" about everything scores well on a population of unbeatable
    // deployers while being worthless, and only the split shows it.
    const rows = [
      gradeOne(claimFixture({ source: 'a.json', claim: 'not-beatable' }) as never, outcomeFixture('entry-room-absent'), null, NOW_ISO),
      gradeOne(claimFixture({ source: 'b.json', claim: 'not-beatable' }) as never, outcomeFixture('entry-room-absent'), null, NOW_ISO),
      gradeOne(claimFixture({ source: 'c.json', claim: 'beatable' }) as never, outcomeFixture('entry-room-absent'), null, NOW_ISO),
    ];
    const s = summariseGrades(mergeGrades(emptyGradeLedger(), rows, NOW_ISO).ledger) as Record<string, any>;
    expect(s.byArm.gate.overall).toEqual({ n: 3, hits: 2, rate: 0.6667 });
    expect(s.byArm.gate.byClaim['not-beatable']).toEqual({ n: 2, hits: 2, rate: 1 });
    expect(s.byArm.gate.byClaim.beatable).toEqual({ n: 1, hits: 0, rate: 0 });
  });
});

describe('every provider call is bounded, and the plan is refused BEFORE anything is spent', () => {
  it('prices a claim from ITS OWN recorded recipe and refuses one it cannot apply', () => {
    // Defaulting a missing bar would grade the claim at today's threshold while the ledger said
    // nothing — the exact substitution this lane exists to avoid.
    const ok = priceClaim(claimFixture() as never, F['keylessMinIntervalMs']!);
    expect(ok.usable).toBe(true);
    if (ok.usable) {
      expect(ok.keyless).toBe(S2['maxLaunchesPerCandidate']! * S2['maxRequestsPerLaunch']!);
      expect(ok.rpc).toBe(S2COST['maxRpcRequestsPerCandidate']);
      expect(ok.keyed).toBe(2);
    }
    for (const key of REQUIRED_ENTRY_RECIPE) {
      const partial = { ...S2 } as Record<string, unknown>;
      delete partial[key];
      const bad = priceClaim(claimFixture({ stage2Entry: partial }) as never, 0);
      expect(bad.usable, key).toBe(false);
      if (!bad.usable) expect(bad.reason).toMatch(/NOT substituted/);
    }
  });

  it('carries the recorded RETRY SCHEDULE through, and refuses a claim that cannot supply one', () => {
    // The schedule is not a bar but it is part of the walk's arithmetic: its length is what each
    // request reserves against `maxRequestsPerLaunch`, so grading under a different one walks a
    // different number of pages per launch. It is an ARRAY, so the typeof-number check above does
    // not cover it and would have let a missing one default silently.
    const ok = priceClaim(claimFixture() as never, F['keylessMinIntervalMs']!);
    expect(ok.usable).toBe(true);
    if (ok.usable) expect(ok.keylessRetryBackoffMs).toEqual(S2['keylessRetryBackoffMs']);
    for (const key of REQUIRED_ENTRY_RECIPE_SCHEDULES) {
      for (const value of [undefined, 3_000, 'nope', [3_000, 'nope'], [-1]]) {
        const entry = { ...S2 } as Record<string, unknown>;
        if (value === undefined) delete entry[key];
        else entry[key] = value;
        const bad = priceClaim(claimFixture({ stage2Entry: entry }) as never, 0);
        expect(bad.usable, `${key}=${JSON.stringify(value)}`).toBe(false);
        if (!bad.usable) expect(bad.reason).toMatch(new RegExp(key));
      }
    }
    // And it is not covered by the number list, which is what would have hidden it.
    expect(REQUIRED_ENTRY_RECIPE).not.toContain('keylessRetryBackoffMs');
  });

  it('never runs faster than either pacing pin, whichever is slower', () => {
    // A record written under a faster pin must not make this lane outrun a host that sheds a
    // quarter of what it is asked for, and a pin raised here must not be undone by an old record.
    const slowRecord = priceClaim(claimFixture({ stage2Entry: { ...S2, keylessMinIntervalMs: 99_000 } }) as never, F['keylessMinIntervalMs']!);
    const fastRecord = priceClaim(claimFixture({ stage2Entry: { ...S2, keylessMinIntervalMs: 10 } }) as never, F['keylessMinIntervalMs']!);
    if (slowRecord.usable) expect(slowRecord.keylessMinIntervalMs).toBe(99_000);
    if (fastRecord.usable) expect(fastRecord.keylessMinIntervalMs).toBe(F['keylessMinIntervalMs']);
  });

  it('refuses a plan that does not fit, on each leg separately', () => {
    const bounds = { maxKeyedRequests: 6, maxKeylessRequests: 540, maxRpcRequests: 1500 };
    const one = priceClaim(claimFixture() as never, 0);
    expect(planFits([one, one, one], bounds).fits).toBe(true);
    const four = planFits([one, one, one, one], bounds);
    expect(four.fits).toBe(false);
    expect(four.reasons.join(' ')).toMatch(/keyed worst case/);
    expect(four.reasons.join(' ')).toMatch(/keyless worst case/);
    expect(four.reasons.join(' ')).toMatch(/Solana RPC worst case/);
  });

  it('the pinned arithmetic ties the ceilings to the caps, so the dry run IS the exposure', () => {
    // The same property Stage 2 has: the declared worst case and the ceiling are the SAME number,
    // so no plan-level truncation is possible and the printed plan is the whole exposure.
    expect(F['maxClaimsPerRun']! * S2['maxLaunchesPerCandidate']! * S2['maxRequestsPerLaunch']!).toBe(
      F['maxKeylessRequests'],
    );
    expect(F['maxClaimsPerRun']! * S2COST['maxRpcRequestsPerCandidate']!).toBe(F['maxRpcRequests']);
    // One profile per claim, and the keyed client retries once against the same ceiling.
    expect(F['maxClaimsPerRun']! * 2).toBe(F['maxKeyedRequests']);
    // It cannot outpace the host Stage 2 already paces for, and it stays inside the run budget.
    expect(F['keylessMinIntervalMs']).toBeGreaterThanOrEqual(S2['keylessMinIntervalMs']!);
    expect(F['maxKeylessRequests']).toBeLessThanOrEqual(T['budget'].maxKeylessRequests);
    // The daily keyed arithmetic is a minority share of the ~200/day allowance, beside the feed's.
    expect(F['maxKeyedRequests']! * F['runsPerDayAssumed']!).toBeLessThan(20);
  });

  it('--claims can only LOWER the pinned cap, and the default is a DRY RUN', () => {
    expect(parseArgs([]).ok).toBe(true);
    const parsed = parseArgs([]);
    if (parsed.ok) expect(parsed.opts.live).toBe(false);
    const raised = parseArgs(['--claims', '999']);
    if (raised.ok) expect(Math.min(raised.opts.claims!, F['maxClaimsPerRun']!)).toBe(F['maxClaimsPerRun']);
    expect(parseArgs(['--claims', '0']).ok).toBe(false);
    expect(parseArgs(['--nope']).ok).toBe(false);
  });
});

describe('the free report — a dry run answers without touching a provider or a file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slot-zero-grade-'));
    mkdirSync(join(dir, 'runs'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports the plan and the hit rate, writes nothing, and reaches no provider', async () => {
    writeFileSync(
      join(dir, 'runs', 'r.json'),
      JSON.stringify({
        schemaVersion: 16,
        finishedAtIso: MADE_AT,
        thresholdsVersion: '5.5.0',
        thresholds: { stage2_entry: { ...S2 }, stage2_cost: { ...S2COST } },
        candidates: [
          {
            wallet: 'Wa11etaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            prediction: buildPredictionBlock({
              entry: { verdict: 'entry-open-after-costs' },
              madeAtIso: MADE_AT,
              gateReading: 'creation-derived',
              thresholdsVersion: '5.5.0',
            }),
          },
        ],
      }),
      'utf8',
    );
    const lines: string[] = [];
    const ledgerPath = join(dir, 'grades.json');
    const code = await gradeMain(
      { help: false, live: false, runsDir: join(dir, 'runs'), ledgerPath, claims: null, json: true },
      {},
      (l) => lines.push(l),
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    const report = JSON.parse(lines.join('\n')) as Record<string, any>;
    expect(report.mode).toBe('dry-run');
    expect(report.claimsFound).toBe(1);
    // The claim is 60+ days old against a 21-day ripeness bar, so it IS due — and the dry run
    // prices it rather than measuring it.
    expect(report.due).toBe(1);
    expect(report.plan.keylessWorstCase).toBe(S2['maxLaunchesPerCandidate']! * S2['maxRequestsPerLaunch']!);
    expect(report.plan.fits).toBe(true);
    // Nothing was written: the ledger is opt-in through --live, so a free report can never clobber
    // a record of what was already graded.
    expect(loadGradeLedger(ledgerPath).grades).toEqual({});
    expect(() => readFileSync(ledgerPath, 'utf8')).toThrow();
  });

  it('refuses an over-budget plan before spending, and says nothing was spent', async () => {
    // A recipe far larger than this lane's ceilings — the shape a record from a future, heavier
    // screen would have. It must refuse WHOLE rather than measure a truncated sample.
    writeFileSync(
      join(dir, 'runs', 'big.json'),
      JSON.stringify({
        schemaVersion: 16,
        finishedAtIso: MADE_AT,
        thresholdsVersion: '9.9.9',
        thresholds: {
          stage2_entry: { ...S2, maxLaunchesPerCandidate: 400, maxRequestsPerLaunch: 40 },
          stage2_cost: { ...S2COST, maxRpcRequestsPerCandidate: 50_000 },
        },
        candidates: [
          {
            wallet: 'Wa11etaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            prediction: buildPredictionBlock({
              entry: { verdict: 'entry-room-absent' },
              madeAtIso: MADE_AT,
              gateReading: 'creation-derived',
              thresholdsVersion: '9.9.9',
            }),
          },
        ],
      }),
      'utf8',
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = await gradeMain(
      { help: false, live: true, runsDir: join(dir, 'runs'), ledgerPath: join(dir, 'grades.json'), claims: null, json: false },
      // No credential is even reached: the plan is refused first, which is the point — a run must
      // not discover it cannot afford itself after it has started spending.
      {},
      (l) => out.push(l),
      (l) => err.push(l),
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/PLAN REFUSED — nothing was spent/);
    expect(err.join('\n')).toMatch(/never truncated to fit/);
    expect(() => readFileSync(join(dir, 'grades.json'), 'utf8')).toThrow();
  });
});

describe('the loop closes — a live run, end to end, against a counting stub', () => {
  const FAKE_KEY = 'msk_feedbackloopfixture0000000000';
  const BOUNDARY = Date.parse('2026-06-01T00:00:00.000Z');
  const NOW = BOUNDARY + 60 * MS_PER_DAY;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slot-zero-grade-live-'));
    mkdirSync(join(dir, 'runs'), { recursive: true });
    writeFileSync(
      join(dir, 'runs', 'r.json'),
      JSON.stringify({
        schemaVersion: 16,
        finishedAtIso: new Date(BOUNDARY).toISOString(),
        thresholdsVersion: '5.5.0',
        thresholds: { stage2_entry: { ...S2 }, stage2_cost: { ...S2COST } },
        candidates: [
          {
            wallet: 'Wa11etaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            // The screen said this wallet's windows are NOT enterable after costs. The stub below
            // makes that true out of sample too, so the loop should score a HIT.
            prediction: buildPredictionBlock({
              entry: { verdict: 'entry-room-absent' },
              madeAtIso: new Date(BOUNDARY).toISOString(),
              gateReading: 'creation-derived',
              thresholdsVersion: '5.5.0',
            }),
          },
        ],
      }),
      'utf8',
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Post-boundary launches only, so the walk has a full out-of-sample sample to score. */
  const profileBody = {
    pump_tokens: Array.from({ length: 12 }, (_, i) => ({
      mint: `MINT${String(100 + i).padStart(38, '0')}pump`,
      created_timestamp: BOUNDARY + (i + 1) * MS_PER_DAY,
      complete: true,
    })),
  };

  const stubs = () => {
    let keyedCalls = 0;
    let keylessCalls = 0;
    const fetchImpl = (async () => {
      keyedCalls += 1;
      return { ok: true, status: 200, json: async () => profileBody };
    }) as unknown as typeof fetch;
    const keylessFetchImpl = (async (url: string | URL) => {
      keylessCalls += 1;
      const cursorMs = Number(String(new URL(String(url)).searchParams.get('cursor')).split('-')[1]);
      const createdMs = cursorMs - 65_000;
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
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trades: [
            row('000000000140000000009', 'sellB', 'B', createdMs + 40_000, 'sell', 6, 500),
            row('000000000140000000008', 'sellA', 'A', createdMs + 40_000, 'sell', 6, 500),
            row('000000000100000000003', 'buyB', 'B', createdMs, 'buy', 5, 500),
            row('000000000100000000002', 'buyA', 'A', createdMs, 'buy', 5, 500),
            // Bundled, so the create slot's opening is PROVEN and the launch is scoreable.
            row('000000000100000000001', 'devtx', 'devbook', createdMs, 'buy', 45, 100),
            row('000000000100000000000', 'devtx', 'dev', createdMs, 'buy', 45, 100),
          ],
          pagination: { hasMore: false },
        }),
      };
    }) as unknown as typeof fetch;
    const rpcFetchImpl = (async () => {
      throw new Error('the cost leg must not spend here — room is refused first');
    }) as unknown as typeof fetch;
    return { fetchImpl, keylessFetchImpl, rpcFetchImpl, keyed: () => keyedCalls, keyless: () => keylessCalls };
  };

  const run = async () => {
    const s = stubs();
    const out: string[] = [];
    const code = await gradeMain(
      { help: false, live: true, runsDir: join(dir, 'runs'), ledgerPath: join(dir, 'grades.json'), claims: null, json: true },
      { MADEONSOL_API_KEY: FAKE_KEY },
      (l) => out.push(l),
      (l) => out.push(l),
      { fetchImpl: s.fetchImpl, keylessFetchImpl: s.keylessFetchImpl, rpcFetchImpl: s.rpcFetchImpl, sleepImpl: async () => {}, nowMs: NOW },
    );
    return { code, report: JSON.parse(out.join('\n')) as Record<string, any>, stubs: s };
  };

  it('measures the outcome, scores the claim, writes the ledger, and stays inside every ceiling', async () => {
    const { code, report, stubs: s } = await run();
    expect(code).toBe(0);
    expect(report.measured).toBe(1);
    // The screen said not-beatable; out of sample the operation still takes 90 of 100 SOL, so room
    // is 0.1 against a 0.55 bar and the outcome agrees. The loop has scored the screen.
    expect(report.grades.byArm.gate.overall).toEqual({ n: 1, hits: 1, rate: 1 });
    expect(report.grades.byArm.gate.byClaim['not-beatable']).toEqual({ n: 1, hits: 1, rate: 1 });
    // Spend, against the pinned ceilings — counted at the stub, not computed in a comment.
    expect(s.keyed()).toBe(1);
    expect(report.spend.keyed).toBeLessThanOrEqual(F['maxKeyedRequests']!);
    expect(report.spend.keyless).toBe(s.keyless());
    expect(report.spend.keyless).toBeLessThanOrEqual(F['maxKeylessRequests']!);
    // Room refused the candidate, so the expensive leg never started — the same cost model Stage 2
    // has, inherited rather than reimplemented.
    expect(report.spend.rpc).toBe(0);
    const ledger = loadGradeLedger(join(dir, 'grades.json'));
    const row = Object.values(ledger.grades)[0]!;
    expect(row.state).toBe('hit');
    expect(row.outcomeVerdict).toBe('entry-room-absent');
    expect(row.outcome!.launchesAfterBoundary).toBe(12);
  });

  it('a second run the same day spends NOTHING and reports the same rate', async () => {
    // Idempotence end to end, which is the property that makes this safe to rerun on a whim: the
    // report is free and a settled grade is never re-measured.
    const first = await run();
    const before = readFileSync(join(dir, 'grades.json'), 'utf8');
    const second = await run();
    expect(second.code).toBe(0);
    expect(second.stubs.keyed()).toBe(0);
    expect(second.stubs.keyless()).toBe(0);
    expect(second.report.measured).toBe(0);
    expect(second.report.settled).toBe(1);
    expect(second.report.grades.byArm).toEqual(first.report.grades.byArm);
    // And the ledger itself is unchanged apart from its own timestamp.
    const after = readFileSync(join(dir, 'grades.json'), 'utf8');
    expect(JSON.parse(after).grades).toEqual(JSON.parse(before).grades);
  });

  it('scores a MISS when the outcome contradicts the claim, rather than quietly agreeing', () => {
    // The mirror of the hit above, at the arithmetic rather than through the walk: a screen that
    // could only ever record hits would be measuring nothing.
    const p = claimFixture({ claim: 'beatable', verdict: 'entry-open-after-costs' });
    const row = gradeOne(p as never, outcomeFixture('entry-room-absent'), null, '2026-08-01T00:00:00.000Z');
    expect(row.state).toBe('miss');
  });
});

describe('this lane grades the screen and never re-tunes it', () => {
  it('leaves every gate and Stage 2 bar exactly where it found them', () => {
    // Stated as an assertion because it is the condition under which a grade is evidence at all: a
    // lane that adjusted the screen it grades could not be read as a measurement of that screen.
    expect(T['stage1_gate'].minCompletionRate).toBe(0.25);
    expect(T['stage1_gate'].minTokens).toBe(25);
    expect(T['stage1_gate'].minSpanDays).toBe(14);
    expect(S2['minRoomLeft']).toBe(0.55);
    expect(S2['minLaunchesSampled']).toBe(8);
  });

  it('the ledger carries our arithmetic and no vendor identifier, the same containment a record has', () => {
    // MadeOnSol terms §5a(d): derive and discard. The grade ledger is persisted, so it is subject to
    // the same boundary `screen.mjs` → `toRecordRow` implements — and free text is how that boundary
    // leaks, by accident, through an error message. So the one place a caller-supplied exception
    // becomes ledger text uses the error's NAME and never its message, which is where a client's URL
    // (mint and all) would arrive.
    const grade = readFileSync(join(__dirname, '..', 'tools', 'deployer-screen', 'grade.mjs'), 'utf8');
    expect(grade).toMatch(/cause instanceof Error \? cause\.name : 'a non-Error throw'/);
    // And the shape itself holds no mint and no counterparty wallet — only the candidate's own
    // address, which is public on-chain data this ledger deliberately keeps, plus our own counts.
    const row = gradeOne(claimFixture() as never, outcomeFixture('entry-room-absent'), null, '2026-08-01T00:00:00.000Z');
    expect(Object.keys(row.outcome!).sort()).toEqual(
      [
        'coverageProvenBackToBoundary',
        'keylessRequests',
        'launchesAfterBoundary',
        'launchesDropped',
        'launchesOffered',
        'launchesScored',
        'roomLeftMedian',
        'rpcRequests',
        'unmeasuredCause',
        'verdict',
      ].sort(),
    );
    // A pump.fun mint is a base58 run ending `pump`, which is the shape that must never appear. The
    // prose naming the vendor is not one, and testing for the word alone would have said so wrongly.
    expect(JSON.stringify(row)).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}pump\b/);
    // The only base58 address in the row is the candidate's own wallet, once.
    expect((JSON.stringify(row).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? []).length).toBe(1);
  });

  it('no module in the lane writes a threshold, a run record or a verdict', () => {
    const root = join(__dirname, '..', 'tools', 'deployer-screen');
    for (const file of ['prediction.mjs', 'outcome.mjs', 'grade.mjs']) {
      const text = readFileSync(join(root, file), 'utf8');
      const code = text
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.includes('/**'))
        .join('\n');
      // It may READ thresholds.json (through `loadThresholds`); it may never write one, and it may
      // never write into `runs/` — committed run records are evidence and are never retro-edited to
      // carry a grade.
      expect(code, `${file} must not write a threshold file`).not.toMatch(/writeFileSync\([^)]*thresholds/);
      expect(code, `${file} must not write into runs/`).not.toMatch(/writeFileSync\([^)]*runs/);
      // And it must not recompute a gate: the verdict it grades is the one the screen recorded.
      expect(code, `${file} must not import the gate`).not.toMatch(/from\s+['"]\.\/rank\.mjs['"]/);
    }
  });

  it('grades on the screen\'s OWN Stage 2, not on a second copy of it', () => {
    // A grader with its own walk would drift from the screen it grades, and the drift would surface
    // as a hit rate rather than as a failure. So there is exactly one Stage 2, and `grade.mjs`
    // reaches it through the same module `screen.mjs` does.
    const grade = readFileSync(join(__dirname, '..', 'tools', 'deployer-screen', 'grade.mjs'), 'utf8');
    expect(grade).toMatch(/import \{ scoreLaunchRefsEntry \} from '\.\/stage2\.mjs'/);
    const stage2 = readFileSync(join(__dirname, '..', 'tools', 'deployer-screen', 'stage2.mjs'), 'utf8');
    // `scoreCandidateEntry` is now a wrapper over the shared implementation rather than a twin.
    // The first argument became the injected fill source rather than a transport client (captain
    // decision 260a); the property this pins — one Stage 2, reached through one module — is
    // unchanged, and the wrapper still forwards everything it was given.
    expect(stage2).toMatch(
      /return scoreLaunchRefsEntry\(fillSource, \{ \.\.\.input, refs: toLaunchRefs\(input\.profile\) \}\)/,
    );
    // And the grader builds the same sources the screen does, rather than reaching for a walk. These
    // two source-text pins are DELIBERATE and captain-reviewed on 2026-08-05; the behavioural
    // coverage of the shared Stage 2 sits alongside them rather than instead of them.
    expect(grade).toMatch(/from '\.\/swapapi-fills\.mjs'/);
    expect(grade).toMatch(/from '\.\/rpc-costs\.mjs'/);
  });

  it('THE TWO SOURCES DISAGREE ON EXACTLY THE KEYS THE GRADER READS BACK, and that is the hazard', () => {
    // Not reachable today and deliberately pinned anyway. `screen.mjs` records `thresholds.stage2_entry`
    // into every run record UNCONDITIONALLY, and `grade.mjs` -> REQUIRED_ENTRY_RECIPE reads the sampling
    // rule back out of that recorded block. `minLaunchesSampled` and `maxLaunchesPerCandidate` are in
    // that required list AND are exactly the two keys that differ between the sources — so a Gate 3
    // wiring that scored through the Dune source while still recording `stage2_entry` would file a
    // recipe of 8-of-10 against a verdict computed at 20-of-22. A MISSING key is refused loudly as
    // `recipe-unusable`; a key belonging to the other source is not refused at all.
    //
    // This test's job is to keep that disagreement REAL. If a later lane "fixes" the drift by making the
    // two blocks agree rather than by fixing the recorder, this fails and says so.
    const swap = (T as Record<string, Record<string, number>>)['stage2_entry']!;
    const dune = (T as Record<string, Record<string, number>>)['stage2_entry_dune']!;
    const readBack = REQUIRED_ENTRY_RECIPE.filter((k) => k in dune);
    expect(readBack.sort()).toEqual(['maxLaunchesPerCandidate', 'minLaunchesSampled']);
    for (const k of readBack) {
      expect(dune[k], `stage2_entry_dune.${k} must differ from the block the recorder files`).not.toBe(swap[k]);
    }
  });
});

describe('the keyless ceiling is EXACT BY CONSTRUCTION, however the batch is composed', () => {
  /**
   * A per-schedule client CACHE cannot hold that property, and the composition that breaks it is
   * A(schedule X), B(schedule Y), C(schedule X): the client for X is built at spend 0 with the whole
   * budget and then REUSED for C after B has already spent, so the live clients are between them
   * permitted to issue more than `maxKeylessRequests`.
   *
   * **This is defence in depth, not a live budget hole.** Per-claim spend is independently capped by
   * the recipe's own `maxLaunchesPerCandidate x maxRequestsPerLaunch`, and `planFits` caps the batch
   * sum before the first request — so no reachable run overruns either way. What was wrong was that
   * the ceiling was enforced by two collaborating bounds instead of by construction, while the
   * comment beside it claimed the construction property outright. Every other ceiling in this lane
   * is exact; this one is now too.
   */
  const okResponse = () =>
    ({ ok: true, status: 200, json: async () => ({ trades: [] }) }) as unknown as Response;

  const poolFor = (max: number, over: Record<string, unknown> = {}) =>
    createKeylessClientPool({
      maxKeylessRequests: max,
      minIntervalMs: 0,
      fetchImpl: (async () => okResponse()) as unknown as typeof fetch,
      sleepImpl: async () => {},
      ...over,
    });

  const X = [1] as const;
  const Y = [2] as const;

  it('A(X) B(Y) C(X): the third claim gets a NEW client bounded by what is LEFT', async () => {
    // Against the superseded cache this fails twice over: two clients are created rather than three,
    // and the third acquire returns X's original client, whose ceiling was the whole 6.
    const pool = poolFor(6);
    const a = await pool.acquire(X);
    await a.getJson('https://swap-api.pump.fun/a1');
    await a.getJson('https://swap-api.pump.fun/a2');
    const b = await pool.acquire(Y);
    await b.getJson('https://swap-api.pump.fun/b1');
    await b.getJson('https://swap-api.pump.fun/b2');
    const c = await pool.acquire(X);

    expect(pool.clients).toHaveLength(3);
    expect(c).not.toBe(a);
    expect(pool.spent()).toBe(4);
    // Ceiling === issued + remaining. C was built with exactly the 2 left, not with the 6 A was
    // built with.
    expect(c.issued() + c.remaining()).toBe(2);
    // And the schedule is still honoured per claim: C is walked at X's, not at Y's.
    expect(c.attemptsPerRequest()).toBe(X.length + 1);
    expect(b.attemptsPerRequest()).toBe(Y.length + 1);
  });

  it('the RUN cannot issue more than the ceiling, whatever the schedules do', async () => {
    // The behavioural half of the same property, driven to exhaustion. Under the cache the run
    // reaches 8 issued requests against a ceiling of 6.
    const pool = poolFor(6);
    const a = await pool.acquire(X);
    await a.getJson('https://swap-api.pump.fun/a1');
    await a.getJson('https://swap-api.pump.fun/a2');
    const b = await pool.acquire(Y);
    await b.getJson('https://swap-api.pump.fun/b1');
    await b.getJson('https://swap-api.pump.fun/b2');
    const c = await pool.acquire(X);
    await c.getJson('https://swap-api.pump.fun/c1');
    await c.getJson('https://swap-api.pump.fun/c2');

    expect(pool.spent()).toBe(6);
    await expect(c.getJson('https://swap-api.pump.fun/c3')).rejects.toThrow(/Request ceiling of 2 reached/);
    expect(pool.spent()).toBe(6);
  });

  it('an exhausted budget REFUSES the next claim rather than handing back a client that cannot spend', async () => {
    // A hard floor of zero, exactly as `rpcFor` has: a client built with "at least one" request
    // would let a run overrun by one per remaining claim. `CeilingReached` is what `main` already
    // catches — the run stops at EXIT.ceiling and every grade already paid for is kept.
    const pool = poolFor(2);
    const a = await pool.acquire(X);
    await a.getJson('https://swap-api.pump.fun/a1');
    await a.getJson('https://swap-api.pump.fun/a2');
    await expect(pool.acquire(Y)).rejects.toThrow(/Request ceiling of 2 reached/);
    expect(pool.clients).toHaveLength(1);
  });

  it('PACING SURVIVES THE CLIENT BOUNDARY — one client per claim does not buy a free request', async () => {
    // The one thing a fresh client per claim could have cost. `KeylessClient` starts its own
    // interval clock at zero, so without this the first request of claim N+1 would follow the last
    // of claim N with no gap at all — a loosening of the courtesy owed a shared keyless endpoint,
    // smuggled in as a refactor. The pool holds the instant of the last request issued through ANY
    // of its clients and waits out the remainder before handing over the next one.
    const slept: number[] = [];
    let clock = 1_000_000;
    const pool = createKeylessClientPool({
      maxKeylessRequests: 10,
      minIntervalMs: 7_000,
      fetchImpl: (async () => okResponse()) as unknown as typeof fetch,
      sleepImpl: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
      nowImpl: () => clock,
    });

    const a = await pool.acquire(X);
    // The FIRST client waits for nothing — there is no earlier request to be paced against.
    expect(slept).toEqual([]);
    await a.getJson('https://swap-api.pump.fun/a1');
    expect(slept).toEqual([]);

    clock += 1_000;
    const b = await pool.acquire(Y);
    // 7,000 owed, 1,000 elapsed: the handover pays the remaining 6,000 before b issues anything.
    expect(slept).toEqual([6_000]);
    await b.getJson('https://swap-api.pump.fun/b1');
    expect(slept).toEqual([6_000]);

    // And a claim that arrives after the interval has already elapsed waits for nothing.
    clock += 20_000;
    await pool.acquire(X);
    expect(slept).toEqual([6_000]);
  });
});
