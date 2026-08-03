/**
 * Tests for the BUNDLING CENSUS — `tools/deployer-screen/bundling.mjs`, captain decision 173a.
 *
 * **Nothing here reaches the network.** Every client is constructed with a `fetchImpl` seam, and
 * every fixture is synthetic. The census's own structural guarantees — no `fetch` outside the two
 * declared client modules, no credential environment variable named outside `credential.mjs`, no
 * key-shaped string, no import across the `src/`↔`tools/` boundary — are already asserted over the
 * whole directory by `test/deployer-screen.test.ts`, which reads `tools/deployer-screen/`
 * recursively. This file therefore covers what is specific to the census: that it is bounded, that
 * it never scores anything, and that its headline number is defined over the population it claims.
 *
 * The file is deliberately separate from `test/deployer-screen.test.ts` rather than appended to it.
 * Another lane is editing that file concurrently, and a new pass's tests do not need to share a
 * 7,000-line file to be found.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DROPPED_WINDOW_CAVEAT,
  MINT_TIME_BACKDATE_CAVEAT,
  OWNERSHIP_LIST_CAVEAT,
  buildCohort,
  censusCandidate,
  loadThresholds,
  parseArgs,
  renderDryRun,
  renderSubjectEraTrend,
  renderSummary,
  subjectEraTrend,
  summariseCensus,
} from '../tools/deployer-screen/bundling.mjs';
import type { CandidateBundling } from '../tools/deployer-screen/bundling.mjs';
import { KeylessClient } from '../tools/deployer-screen/pumpfun.mjs';
import type { Stage2Thresholds } from '../tools/deployer-screen/stage2.mjs';

const CENSUS_SOURCE = readFileSync(
  fileURLToPath(new URL('../tools/deployer-screen/bundling.mjs', import.meta.url)),
  'utf8',
);

/**
 * The census source with every comment removed.
 *
 * The same distinction `test/deployer-screen.test.ts` draws when it asserts `entry.mjs` contains no
 * mean "in its executable half": a module that DOCUMENTS what it deliberately does not do has to be
 * allowed to name the thing it does not do. Matching the raw text would make the docblock the
 * failure.
 */
const CENSUS_CODE = CENSUS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const T = loadThresholds();
const ENTRY: Stage2Thresholds = { ...T['stage2_entry'] };
const BACKDATE: number = T['bundling_census'].mintTimeBackdateMs;

const NOW = Date.parse('2026-08-03T12:00:00Z');
const DAY = 86_400_000;

/**
 * A synthetic trade row in the endpoint's own field names.
 *
 * `ts` is not optional: `readLaunchWindow` parses it on every row, counts a row it cannot read as
 * `unparsedRows`, and a non-zero count makes the whole window unusable. A fixture without it walks
 * cleanly and then drops — which is exactly the failure the walk is designed to make loud, and it
 * is loud here too.
 */
const row = (o: { slot: number; sid: string; tx: string; wallet: string; tsMs: number; sol?: number }) => ({
  slot: o.slot,
  sid: o.sid,
  tx: o.tx,
  u: o.wallet,
  k: 'buy',
  p: 'pump',
  ts: new Date(o.tsMs).toISOString(),
  sol: o.sol ?? 1,
  base: (o.sol ?? 1) * 1e7,
  psol: 1e-7,
});

/**
 * A client whose every response is scripted, so a walk is deterministic and no socket is opened.
 * `hasMore: false` on the last page is what discharges the coverage obligation — the same proof
 * `readLaunchWindow` demands of the live endpoint.
 */
function scriptedClient(pages: Record<string, unknown>[][], maxRequests = 1000) {
  let i = 0;
  const urls: string[] = [];
  const client = new KeylessClient({
    maxRequests,
    minIntervalMs: 0,
    retryBackoffMs: [],
    sleepImpl: async () => {},
    fetchImpl: (async (url: string) => {
      urls.push(String(url));
      const page = pages[Math.min(i, pages.length - 1)] ?? [];
      i += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ trades: page, pagination: { hasMore: false } }),
        text: async () => '',
      };
    }) as unknown as typeof fetch,
  });
  return { client, urls };
}

/**
 * One window: a create slot with `bundles` transactions carrying two wallets each.
 *
 * `tsMs` must be at or after the launch's own mint time, or the pre-mint tripwire fires with zero
 * slack and the window is dropped as a clock disagreement. The fixtures put every fill one second
 * after the mint, which is what the committed tape shows (the measured gap is exactly 0 on all 235
 * covered launches, so a fixture in the past would be testing the tripwire rather than the census).
 */
function windowPage(opts: { createSlot: number; bundles: number; loneWallets: number; tsMs: number }) {
  const rows: Record<string, unknown>[] = [];
  let n = 0;
  const sid = () => String(++n).padStart(22, '0');
  const ts = opts.tsMs;
  // The deployer's own buy, alone in its transaction — the shape our subject shows on every launch.
  rows.push(row({ slot: opts.createSlot, sid: sid(), tx: 'dev', wallet: 'DEV', tsMs: ts }));
  for (let b = 0; b < opts.bundles; b++) {
    rows.push(row({ slot: opts.createSlot, sid: sid(), tx: `bundle${b}`, wallet: `A${b}`, tsMs: ts }));
    rows.push(row({ slot: opts.createSlot, sid: sid(), tx: `bundle${b}`, wallet: `B${b}`, tsMs: ts }));
  }
  for (let l = 0; l < opts.loneWallets; l++) {
    rows.push(row({ slot: opts.createSlot, sid: sid(), tx: `lone${l}`, wallet: `L${l}`, tsMs: ts }));
  }
  // Newest first, as the live endpoint serves them.
  return rows.reverse();
}

/**
 * `n` launches, all old enough to be eligible, newest first — and all sharing ONE mint time, so a
 * single scripted page is a valid window for every one of them.
 */
const OLDEST_MINT_MS = NOW - 30 * DAY;
const refs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ mint: `MINT${i}`, deployedAtMs: OLDEST_MINT_MS - i }));

/** A page whose fills all sit inside every ref's window. */
const page = (o: { createSlot: number; bundles: number; loneWallets: number }) =>
  windowPage({ ...o, tsMs: OLDEST_MINT_MS + 1_000 });

/** A census row with everything zeroed, for summary tests about arithmetic rather than walking. */
const candidate = (o: Partial<CandidateBundling>): CandidateBundling => ({
  wallet: 'W',
  cohortSources: [],
  recordedGateVerdict: null,
  gateVerdict: 'gate-passed',
  listingRows: 0,
  listingPageCapped: false,
  gateTokens: 0,
  gateCompletionRate: 0,
  gateSpanDays: 0,
  launchesEligible: 0,
  launchesPlanned: 0,
  launchesAttempted: 0,
  launchesUsable: 0,
  launchesDropped: 0,
  dropsByReason: {},
  dropNotes: [],
  bundledLaunches: 0,
  fullSample: false,
  allBundled: null,
  neverBundles: false,
  launches: [],
  ...o,
});

/** `n` launches, `bundled` of which carried a bundle. */
const launches = (n: number, bundled: number) =>
  Array.from({ length: n }, (_, i) => ({
    ageDays: i + 1,
    bundledTx: i < bundled ? 1 : 0,
    maxWalletsInOneTx: i < bundled ? 2 : 1,
    createSlotWallets: 3,
    proven: i < bundled,
  }));

/** A full-sample candidate at the pinned cap, `bundled` of whose windows carried a bundle. */
const full = (bundled: number, extra: Partial<CandidateBundling> = {}) => {
  const n = ENTRY.maxLaunchesPerCandidate;
  const ls = launches(n, bundled);
  return candidate({
    launchesUsable: n,
    launchesPlanned: n,
    bundledLaunches: bundled,
    fullSample: true,
    allBundled: bundled === n,
    neverBundles: ls.every((l) => l.maxWalletsInOneTx <= 1),
    launches: ls,
    ...extra,
  });
};

// ---------------------------------------------------------------------------------------------

describe('the census is bounded before it spends, and it spends nothing keyed', () => {
  it('holds no keyed client at all — the zero is structural, not careful', () => {
    // The bound this pass had to declare in advance is the keyed one, and the honest way to declare
    // a zero is to make it unreachable. A `BoundedClient` or a `DuneClient` here would be a keyed
    // request one refactor away; `credential.mjs` likewise.
    expect(CENSUS_CODE).not.toMatch(/BoundedClient|DuneClient|SolanaRpcClient/);
    expect(CENSUS_CODE).not.toMatch(/from\s+['"]\.\/credential\.mjs['"]/);
    expect(CENSUS_CODE).not.toMatch(/process\.env/);
  });

  it('pins a ceiling equal to its own declared worst case, so the dry run IS the exposure', () => {
    const c = T['bundling_census'];
    expect(c.maxCandidatesSurveyed * ENTRY.maxLaunchesPerCandidate * ENTRY.maxRequestsPerLaunch).toBe(
      c.maxKeylessRequests,
    );
    expect(c.maxCohortSize * c.maxListingPagesPerCandidate).toBe(c.maxListingRequests);
  });

  it('re-pins NO window parameter — it reads Stage 2\'s, so it measures Stage 2\'s launches', () => {
    // A second copy of windowMs or windowSlotSpan would let the census drift away from the pass it
    // is a finding about, and the finding would stop describing the tool. The census block must not
    // carry any of them.
    const c = T['bundling_census'];
    for (const key of [
      'windowMs',
      'seekMarginMs',
      'windowSlotSpan',
      'tradePageLimit',
      'maxLaunchesPerCandidate',
      'maxRequestsPerLaunch',
      'minLaunchesSampled',
      'keylessMinIntervalMs',
    ]) {
      expect(c[key], `bundling_census must not re-pin ${key}`).toBeUndefined();
    }
    expect(CENSUS_SOURCE).toContain("T['stage2_entry']");
  });

  it('every pinned census parameter carries a stated reason', () => {
    // The same contract every other block in the file holds. Asserted here too so the census's own
    // block cannot be added without one, independently of the whole-file sweep.
    const c = T['bundling_census'] as Record<string, unknown>;
    const params = Object.keys(c).filter((k) => !k.startsWith('$') && k !== 'justification');
    const justification = c['justification'] as Record<string, unknown>;
    expect(params.length).toBeGreaterThan(0);
    for (const key of params) expect(justification[key], `${key} has no justification`).toBeTruthy();
    expect(Object.keys(justification).sort()).toEqual(params.sort());
  });

  it('the dry run prints the whole plan, in both units, and fetches nothing', () => {
    const text = renderDryRun({
      cohortSize: 82,
      cohortCap: T['bundling_census'].maxCohortSize,
      maxCandidates: T['bundling_census'].maxCandidatesSurveyed,
      census: T['bundling_census'],
      entry: ENTRY,
      listingIntervalMs: T['budget'].keylessMinIntervalMs,
    });
    expect(text).toContain('KEYED SPEND: 0');
    expect(text).toContain(`ceiling ${T['bundling_census'].maxListingRequests}`);
    expect(text).toContain(`ceiling ${T['bundling_census'].maxKeylessRequests}`);
    expect(text).toContain('no entry score, no room figure, no field, no entry cost, no verdict');
    // Both standing caveats reach the plan, not only the report — the requirement `entry.mjs`
    // states for `LANDING_TIP_CAVEAT` and the reason it is a constant rather than a doc line.
    expect(text).toContain(OWNERSHIP_LIST_CAVEAT);
    expect(text).toContain(DROPPED_WINDOW_CAVEAT);
    expect(text).toContain(MINT_TIME_BACKDATE_CAVEAT);
  });

  it('rejects bad input rather than guessing, and the caps can only be lowered', () => {
    expect(parseArgs(['--candidates', '0'])).toEqual({
      ok: false,
      message: '--candidates needs a positive integer',
    });
    expect(parseArgs(['--nonsense'])).toEqual({ ok: false, message: "unknown option '--nonsense'" });
    const parsed = parseArgs(['--dry-run', '--candidates', '4', '--cohort', '10', '--out', 'x.json']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.opts).toEqual({
        dryRun: true,
        subjectEra: false,
        candidates: 4,
        cohort: 10,
        out: 'x.json',
        json: false,
        help: false,
      });
    }
    // And the source applies Math.min to both, so a flag above the pin cannot widen it.
    expect(CENSUS_SOURCE).toMatch(/Math\.min\(opts\.cohort \?\? census\.maxCohortSize/);
    expect(CENSUS_SOURCE).toMatch(/Math\.min\(opts\.candidates \?\? census\.maxCandidatesSurveyed/);
  });
});

describe('it measures bundling and nothing else', () => {
  it('never computes a room figure, a field, an entry cost or a verdict', () => {
    // The census walks the same windows Stage 2 walks. What separates the two is what it does with
    // the fills, and that boundary is asserted rather than reviewed for: `measureLaunchEntry`,
    // `scoreEntry` and the cost leg must not appear.
    expect(CENSUS_CODE).not.toMatch(/measureLaunchEntry|scoreEntry|priceLaunchEntry|entryCostTargets/);
    expect(CENSUS_CODE).not.toMatch(/readCreateSlotCosts|roomLeft|operationShare/);
  });

  it('reads bundledTx and maxWalletsInOneTx off a walked window', async () => {
    const { client } = scriptedClient([page({ createSlot: 500, bundles: 2, loneWallets: 3 })]);
    const result = await censusCandidate(client, {
      wallet: 'W',
      refs: refs(1),
      nowMs: NOW,
      entry: ENTRY,
      mintTimeBackdateMs: BACKDATE,
    });
    expect(result.launchesUsable).toBe(1);
    expect(result.launches[0]).toMatchObject({
      bundledTx: 2,
      maxWalletsInOneTx: 2,
      // DEV + 2 bundles x 2 wallets + 3 lone = 8 distinct wallets in the create slot.
      createSlotWallets: 8,
      proven: true,
    });
    expect(result.bundledLaunches).toBe(1);
  });

  it('THE `GeBJSHK4…` SHAPE: a create slot nobody bundled in is unproven, not unmeasured', async () => {
    // A busy create slot with every wallet in its own transaction. The co-ordination rule found
    // nothing, which is observationally identical to there being nothing — `measure.mjs` →
    // `roomIsProven` is the refusal, and this pass reports the input to it rather than the verdict.
    const { client } = scriptedClient([page({ createSlot: 700, bundles: 0, loneWallets: 9 })]);
    const result = await censusCandidate(client, { wallet: 'W', refs: refs(1), nowMs: NOW, entry: ENTRY, mintTimeBackdateMs: BACKDATE });
    expect(result.launches[0]).toMatchObject({ bundledTx: 0, maxWalletsInOneTx: 1, proven: false });
    expect(result.bundledLaunches).toBe(0);
    expect(result.neverBundles).toBe(true);
    // And it is not a drop: the window was walked and measured perfectly well.
    expect(result.launchesDropped).toBe(0);
    expect(result.launchesUsable).toBe(1);
  });

  it('applies Stage 2\'s own eligibility floor, so a launch too young to have finished is skipped', async () => {
    const { client, urls } = scriptedClient([page({ createSlot: 500, bundles: 1, loneWallets: 1 })]);
    const tooYoung = [{ mint: 'YOUNG', deployedAtMs: NOW - (ENTRY.windowMs + ENTRY.seekMarginMs - 1) }];
    const result = await censusCandidate(client, { wallet: 'W', refs: tooYoung, nowMs: NOW, entry: ENTRY, mintTimeBackdateMs: BACKDATE });
    expect(result.launchesEligible).toBe(0);
    expect(result.launchesAttempted).toBe(0);
    expect(urls).toEqual([]);
  });

  it('caps the sample at Stage 2\'s own per-candidate launch cap', async () => {
    const { client } = scriptedClient([page({ createSlot: 500, bundles: 1, loneWallets: 1 })]);
    const result = await censusCandidate(client, {
      wallet: 'W',
      refs: refs(ENTRY.maxLaunchesPerCandidate + 5),
      nowMs: NOW,
      entry: ENTRY,
      mintTimeBackdateMs: BACKDATE,
    });
    expect(result.launchesEligible).toBe(ENTRY.maxLaunchesPerCandidate + 5);
    expect(result.launchesPlanned).toBe(ENTRY.maxLaunchesPerCandidate);
    expect(result.launchesUsable).toBe(ENTRY.maxLaunchesPerCandidate);
  });

  it('BACKDATES the mint instant, so a two-vendor clock difference cannot delete a create slot', async () => {
    // MEASURED ON THIS ROUTE: frontend-api-v3's `created_timestamp` carries millisecond precision on
    // older listing rows while swap-api's fill `ts` is whole seconds, floored, so the declared mint
    // lands up to ~2s AFTER the launch's own first fill — and `readLaunchWindow` compares
    // `ts < createdAtMs` with ZERO slack, which deletes the whole launch. The first live run
    // measured that on 5 of 8 launches of the first candidate walked.
    const declaredMintMs = OLDEST_MINT_MS + 1_900;
    const fillsAt = OLDEST_MINT_MS; // the fill tape's floored second — 1.9s BEFORE the declared mint
    const { client } = scriptedClient([
      windowPage({ createSlot: 900, bundles: 1, loneWallets: 2, tsMs: fillsAt }),
    ]);
    const result = await censusCandidate(client, {
      wallet: 'W',
      refs: [{ mint: 'SKEWED', deployedAtMs: declaredMintMs }],
      nowMs: NOW,
      entry: ENTRY,
      mintTimeBackdateMs: BACKDATE,
    });
    expect(result.launchesUsable).toBe(1);
    expect(result.launchesDropped).toBe(0);
    expect(result.launches[0]).toMatchObject({ bundledTx: 1, maxWalletsInOneTx: 2 });

    // AND THE TRIPWIRE IS NARROWED, NOT DISARMED: a disagreement LARGER than the backdate still
    // drops the launch, and it is still counted by cause rather than lumped.
    const { client: far } = scriptedClient([
      windowPage({ createSlot: 900, bundles: 1, loneWallets: 2, tsMs: OLDEST_MINT_MS - BACKDATE - 5_000 }),
    ]);
    const dropped = await censusCandidate(far, {
      wallet: 'W',
      refs: [{ mint: 'SKEWED', deployedAtMs: OLDEST_MINT_MS }],
      nowMs: NOW,
      entry: ENTRY,
      mintTimeBackdateMs: BACKDATE,
    });
    expect(dropped.launchesUsable).toBe(0);
    expect(dropped.dropsByReason['mint-time-disagreement']).toBe(1);
  });

  it('a window it could not walk is DROPPED, never counted as unbundled', async () => {
    // The direction matters more than the count: reading an unreachable create slot as "no bundle"
    // would manufacture exactly the finding this pass is measuring. A page carrying `hasMore: true`
    // and no proof of the oldest end is the live shape of that failure.
    let calls = 0;
    const client = new KeylessClient({
      maxRequests: 100,
      minIntervalMs: 0,
      retryBackoffMs: [],
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ trades: [], pagination: { hasMore: true } }),
          text: async () => '',
        };
      }) as unknown as typeof fetch,
    });
    const result = await censusCandidate(client, { wallet: 'W', refs: refs(1), nowMs: NOW, entry: ENTRY, mintTimeBackdateMs: BACKDATE });
    expect(calls).toBeGreaterThan(0);
    expect(result.launchesUsable).toBe(0);
    expect(result.launchesDropped).toBe(1);
    expect(Object.values(result.dropsByReason).reduce((a, b) => a + b, 0)).toBe(1);
    expect(result.bundledLaunches).toBe(0);
    // A dropped window contributes to NEITHER side of the rate.
    expect(result.launches).toEqual([]);
    expect(result.dropNotes.length).toBe(1);
    // And with no window at all, "never bundles" is not claimed.
    expect(result.neverBundles).toBe(false);
  });

  it('never starts a launch it cannot finish', async () => {
    // The same reservation rule `stage2.mjs` applies. A ceiling of one per-launch cap plus one
    // affords exactly one launch; the second is refused before a request is spent on it.
    const { client } = scriptedClient(
      [page({ createSlot: 500, bundles: 1, loneWallets: 1 })],
      ENTRY.maxRequestsPerLaunch,
    );
    const result = await censusCandidate(client, { wallet: 'W', refs: refs(4), nowMs: NOW, entry: ENTRY, mintTimeBackdateMs: BACKDATE });
    expect(result.launchesAttempted).toBe(1);
    expect(result.dropNotes.some((n) => n.includes('census ceiling'))).toBe(true);
    expect(client.issued()).toBeLessThanOrEqual(ENTRY.maxRequestsPerLaunch);
  });
});

describe('the headline number is defined over the population it names', () => {
  it('counts 8-of-8 bundlers ONLY among candidates that produced a full sample', () => {
    const s = summariseCensus([
      full(ENTRY.maxLaunchesPerCandidate), // 8 of 8 bundled — scoreable
      full(ENTRY.maxLaunchesPerCandidate - 1), // 7 of 8 — silenced by one launch
      full(0), // never bundles, full sample
      // Six usable windows, every one bundled. Stage 2 would call this UNMEASURED anyway, for a
      // reason that is not bundling, so it must not be counted on either side of the headline.
      candidate({ launchesUsable: 6, bundledLaunches: 6, fullSample: false, launches: launches(6, 6) }),
    ]);
    expect(s.headline.candidatesWithFullSample).toBe(3);
    expect(s.headline.candidatesBundlingOnAllOfThem).toBe(1);
    expect(s.headline.fraction).toBeCloseTo(1 / 3, 3);
    expect(s.headline.silencedByOneUnbundledLaunch).toBe(2);
    expect(s.headline.candidatesShortOfAFullSample).toBe(1);
  });

  it('counts the permanently unscoreable APART from the near-misses, and never sums them', () => {
    const s = summariseCensus([
      full(0), // maxWalletsInOneTx 1 on every window — the GeBJSHK4 shape
      full(ENTRY.maxLaunchesPerCandidate - 1), // a near-miss, and NOT permanently anything
      candidate({ launchesUsable: 3, bundledLaunches: 3, launches: launches(3, 3) }),
    ]);
    expect(s.unscoreable.neverBundles).toBe(1);
    expect(s.unscoreable.neverBundlesWithFullSample).toBe(1);
    expect(s.unscoreable.shortOfAFullSampleButAllBundled).toBe(1);
    // The two are reported as distinct fields; nothing in the summary adds them.
    expect(s.headline.silencedByOneUnbundledLaunch).toBe(2);
  });

  it('every rate ships beside its own denominator', () => {
    // This lane exists because a finding was correctly labelled "n = 2, a signal not a rate". A
    // summary that separated a fraction from its n is how the next reader loses that, so each rate
    // and its denominator live in the same object.
    const s = summariseCensus([full(ENTRY.maxLaunchesPerCandidate), full(0)]);
    expect(s.perLaunch).toMatchObject({ launchesMeasured: 16, bundled: 8, rate: 0.5, candidatesContributing: 2 });
    expect(s.headline).toMatchObject({ candidatesWithFullSample: 2, candidatesBundlingOnAllOfThem: 1, fraction: 0.5 });
  });

  it('reports an undefined rate rather than a zero when there is nothing to divide', () => {
    const s = summariseCensus([]);
    expect(s.perLaunch.rate).toBeNull();
    expect(s.headline.fraction).toBeNull();
    expect(s.perLaunch.launchesMeasured).toBe(0);
    expect(s.headline.candidatesWithFullSample).toBe(0);
  });

  it('reports distributions rather than a mean — the standing captain bar for this class', () => {
    const s = summariseCensus([full(ENTRY.maxLaunchesPerCandidate), full(2)]);
    for (const d of Object.values(s.perCandidate)) {
      if (typeof d !== 'object' || d === null) continue;
      expect(Object.keys(d as object)).toEqual(['n', 'min', 'p25', 'median', 'p75', 'max']);
    }
    expect(JSON.stringify(s)).not.toMatch(/"mean"|"average"/i);
  });

  it('the printed summary states the sample size on every one of the four answers', () => {
    const rendered = renderSummary({
      summary: summariseCensus([full(ENTRY.maxLaunchesPerCandidate), full(3)]),
      windowParameters: { maxLaunchesPerCandidate: ENTRY.maxLaunchesPerCandidate },
      cohort: { found: 82, gated: 82, gatePassed: 2, surveyed: 2 },
      caveats: [OWNERSHIP_LIST_CAVEAT, DROPPED_WINDOW_CAVEAT],
    });
    expect(rendered).toMatch(/1\. PER-LAUNCH BUNDLING RATE:.*\(n = \d+ windows over \d+ candidates\)/s);
    expect(rendered).toMatch(/3\. HEADLINE.*\(n = \d+ candidates with a full sample\)/s);
    expect(rendered).toContain('4. PERMANENTLY UNSCOREABLE');
    expect(rendered).toContain(OWNERSHIP_LIST_CAVEAT);
  });
});

describe('the cohort comes off disk, and every member is re-gated rather than trusted', () => {
  it('reads the committed ledger and run records, deterministically', () => {
    const cohort = buildCohort();
    expect(cohort.length).toBeGreaterThan(0);
    // Sorted, so two runs over the same tree gate the same wallets in the same order.
    expect(cohort.map((c) => c.wallet)).toEqual([...cohort.map((c) => c.wallet)].sort());
    // Every member names where it came from, and the recorded verdict travels for comparison.
    for (const member of cohort) expect(member.sources.length).toBeGreaterThan(0);
    expect(cohort.some((c) => c.sources.some((s) => s.startsWith('ledger:')))).toBe(true);
    expect(cohort.some((c) => c.recordedGateVerdict === 'gate-passed')).toBe(true);
  });

  it('a missing cohort file shrinks the cohort visibly rather than aborting', () => {
    expect(buildCohort('/nonexistent/path/for/this/test')).toEqual([]);
  });

  it('the recorded verdict is carried but never gated on — the census re-gates every member', () => {
    // The two committed sources graded on readings taken days apart and on a KEYED surface this
    // pass does not hold, so trusting them would publish a gate decision nothing in this run made.
    expect(CENSUS_SOURCE).toMatch(/recordedGateVerdict/);
    expect(CENSUS_SOURCE).not.toMatch(/recordedGateVerdict\s*===\s*'gate-passed'\s*\)\s*\{?\s*survivors/);
    // What decides membership is this pass's own reading, and it is the OWNERSHIP one.
    expect(CENSUS_SOURCE).toMatch(/applyGate\(\{ completion, historySource: 'ownership-only' \}/);
  });
});

describe('the era question, answered where it can be and refused where it cannot', () => {
  it('reproduces the within-deployer trend offline, from the committed tape', () => {
    // Offline: no client, no seam, no request. `measureSubjectLaunches` reads the committed window
    // files, which is the same source Stage 0's rolling replay runs over.
    const t = subjectEraTrend();
    expect(t.launches).toBeGreaterThan(200);
    expect(t.bundled).toBeLessThanOrEqual(t.launches);
    expect(t.rate).toBeCloseTo(t.bundled / t.launches, 3);
    // Months are ordered and every bucket's arithmetic closes.
    expect(t.byMonth.map((m) => m.month)).toEqual([...t.byMonth.map((m) => m.month)].sort());
    expect(t.byMonth.reduce((n, m) => n + m.launches, 0)).toBe(t.launches);
    expect(t.byMonth.reduce((n, m) => n + m.bundled, 0)).toBe(t.bundled);
    // THE FINDING THIS TABLE EXISTS FOR: the rate is not stationary for this operator. The earliest
    // month bundles on nothing and the latest on nearly everything, which is the tape's own
    // 0% (Dec-Feb) -> 41.6% (Mar) -> 97-100% (from May) progression seen through this predicate.
    const first = t.byMonth[0];
    const last = t.byMonth[t.byMonth.length - 1];
    expect(first?.rate).toBe(0);
    expect(last?.rate).toBeGreaterThan(0.9);
  });

  it('replays the headline over that history, and the trailing windows close arithmetically', () => {
    const t = subjectEraTrend();
    expect(t.trailingWindows).toBe(t.launches - 7);
    expect(t.trailingAllBundled).toBeLessThanOrEqual(t.trailingWindows);
    expect(t.trailingByMonth.reduce((n, m) => n + m.windows, 0)).toBe(t.trailingWindows);
    expect(t.trailingByMonth.reduce((n, m) => n + m.allBundled, 0)).toBe(t.trailingAllBundled);
    // The live analogue: a census run today walks the NEWEST 8, and on this deployer they are all
    // bundled — which is why our own subject is not the wallet the pinning silences.
    expect(t.newestWindowAllBundled).toBe(true);
  });

  it('the rendered table says n = 1 deployer in the text a reader actually sees', () => {
    // The label has to travel with the number, not sit in a docblock. A within-deployer trend read
    // as a population one is exactly the "n = 2, a signal not a rate" failure, one level up.
    const text = renderSubjectEraTrend(subjectEraTrend());
    expect(text).toContain('n = 1 DEPLOYER');
    expect(text).toContain('WITHIN-DEPLOYER trend');
    expect(text).toContain('READ IT AS ONE DEPLOYER');
    expect(text).toContain('No request of any kind was issued');
  });

  it('is a mode of its own, so a real run cannot be mistaken for it', () => {
    const parsed = parseArgs(['--subject-era']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.opts.subjectEra).toBe(true);
    // And the default is off: the census's own job is the live measurement.
    const plain = parseArgs([]);
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.opts.subjectEra).toBe(false);
  });
});

describe('the census record is not a screen run record, and must not be filed as one', () => {
  it('lives under census/, never under runs/', () => {
    // Found the hard way: `runs/` is the SCREEN's versioned contract and
    // `test/deployer-screen.test.ts` asserts every .json under it against `RECORD_SCHEMA_VERSION`'s
    // key set, recursively — so a census record there fails two assertions that are about a
    // different document. Worse, `buildCohort` reads `runs/*.json` back as a cohort source, so a
    // census record filed there would make the next run's population depend on the last run's.
    const runs = fileURLToPath(new URL('../tools/deployer-screen/runs/', import.meta.url));
    for (const entry of readdirSync(runs)) {
      expect(entry, 'a census record must not be filed under runs/').not.toMatch(/bundling-census/);
    }
    const census = fileURLToPath(new URL('../tools/deployer-screen/census/', import.meta.url));
    const records = readdirSync(census).filter((f) => f.endsWith('.json'));
    expect(records.length).toBeGreaterThan(0);
    for (const file of records) {
      const parsed = JSON.parse(readFileSync(join(census, file), 'utf8'));
      // It names itself, so a reader that finds one cannot mistake it for the screen's.
      expect(parsed.tool, file).toBe('deployer-screen/bundling-census');
      expect(parsed.scope, file).toMatch(/WINDOWS ONLY/);
      // The declared keyed spend is a zero and it is IN the record, not only in the prose.
      expect(parsed.spend.keyedRequests, file).toBe(0);
      expect(parsed.spend.keyedCeilingDeclared, file).toBe(0);
      expect(parsed.spend.heliusCredits, file).toBe(0);
      expect(parsed.spend.duneExecutions, file).toBe(0);
      expect(parsed.spend.solanaRpcRequests, file).toBe(0);
      // Both ceilings held.
      expect(parsed.spend.listingRequests, file).toBeLessThanOrEqual(parsed.spend.listingCeiling);
      expect(parsed.spend.fillRequests, file).toBeLessThanOrEqual(parsed.spend.fillCeiling);
      // Every caveat travels with the numbers.
      expect(parsed.caveats, file).toContain(OWNERSHIP_LIST_CAVEAT);
      expect(parsed.caveats, file).toContain(DROPPED_WINDOW_CAVEAT);
      expect(parsed.caveats, file).toContain(MINT_TIME_BACKDATE_CAVEAT);
      // And no verdict of any kind was produced — this pass does not score.
      expect(JSON.stringify(parsed), file).not.toMatch(/entry-room|entry-open|entry-cost|roomLeft/);
    }
  });

  it('the committed record\'s own arithmetic closes', () => {
    // A summary that disagrees with the rows it was computed from is how a headline outlives its
    // evidence. Recomputing it from `candidates` is cheap and it is the whole audit.
    const census = fileURLToPath(new URL('../tools/deployer-screen/census/', import.meta.url));
    for (const file of readdirSync(census).filter((f) => f.endsWith('.json'))) {
      const parsed = JSON.parse(readFileSync(join(census, file), 'utf8'));
      const recomputed = summariseCensus(parsed.candidates);
      expect(recomputed, file).toEqual(parsed.summary);
      // And the cohort accounting adds up: everything gated either passed or is named as not surveyed.
      expect(parsed.cohort.gatePassed + parsed.cohort.notSurveyed.length, file).toBe(parsed.cohort.gated);
      expect(parsed.cohort.surveyed + parsed.cohort.leftUnsurveyedByCap, file).toBe(parsed.cohort.gatePassed);
      expect(parsed.candidates.length, file).toBe(parsed.cohort.surveyed);
    }
  });
});
