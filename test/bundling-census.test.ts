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
  CENSUS_FILL_CONSTRUCTION,
  DROPPED_WINDOW_CAVEAT,
  MINT_TIME_BACKDATE_CAVEAT,
  OWNERSHIP_LIST_CAVEAT,
  PREDICATE_CAVEAT,
  buildCohort,
  censusCandidate,
  censusFillSource,
  loadThresholds,
  parseArgs,
  renderDryRun,
  renderSubjectEraTrend,
  renderSummary,
  subjectEraTrend,
  summariseCensus,
} from '../tools/deployer-screen/bundling.mjs';
import type { CandidateBundling } from '../tools/deployer-screen/bundling.mjs';
import { KeylessClient, windowReachMs } from '../tools/deployer-screen/pumpfun.mjs';
import { ENTRY_FILL_SOURCE_KIND, selectEntryFillSource } from '../tools/deployer-screen/screen.mjs';
import { planEligibility } from '../tools/deployer-screen/plan-source.mjs';
import { swapApiFillSource } from '../tools/deployer-screen/swapapi-fills.mjs';
import { entryFillBounds } from '../tools/deployer-screen/stage2.mjs';
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
 * pump.fun's within-slot ordering key, built the way `measure.mjs` → `blockTxIndex` reads it:
 * `slot(12) + blockTxIndex(6) + innerInstructionIndex(4)`.
 *
 * **The block index has to be real in a fixture now.** Since captain decision 182a the co-ordination
 * rule's second half is the deployer-anchored contiguous run over exactly this field, and
 * `createSlotGroups` refuses adjacency outright when two transactions in one create slot share an
 * index. A fixture that padded a counter into the whole 22 characters put every transaction at index
 * 0, which is not "no run" — it is the inconsistency guard firing, and it would have made every
 * union assertion below pass for the wrong reason.
 */
const sidAt = (slot: number, blockIndex: number, inner = 0) =>
  String(slot).padStart(12, '0') + String(blockIndex).padStart(6, '0') + String(inner).padStart(4, '0');

/** Where each kind of transaction sits in the block, so a run is deliberate rather than accidental. */
const DEV_INDEX = 100;
/** Far enough from the deployer's own index that neither can join its run by accident. */
const BUNDLE_INDEX = 400;
const LONE_INDEX = 700;

/**
 * One window: a create slot laid out so each half of the co-ordination rule can be driven alone.
 *
 * - `bundles` — transactions carrying two wallets each, at indices far from the deployer's. Half (a).
 * - `runNeighbours` — single-wallet transactions at the deployer's index + 1, + 2, … Half (b), and
 *   the shape the live probe found on 5 of the first census run's 11 `neverBundles` wallets.
 * - `loneWallets` — single-wallet transactions scattered well away from everything. Neither half.
 *
 * `tsMs` must be at or after the launch's own mint time, or the pre-mint tripwire fires with zero
 * slack and the window is dropped as a clock disagreement. The fixtures put every fill one second
 * after the mint, which is what the committed tape shows (the measured gap is exactly 0 on all 235
 * covered launches, so a fixture in the past would be testing the tripwire rather than the census).
 */
function windowPage(opts: {
  createSlot: number;
  bundles: number;
  loneWallets: number;
  tsMs: number;
  runNeighbours?: number;
}) {
  const rows: Record<string, unknown>[] = [];
  const ts = opts.tsMs;
  const slot = opts.createSlot;
  // The deployer's own buy, alone in its transaction — the shape our subject shows on every launch.
  rows.push(row({ slot, sid: sidAt(slot, DEV_INDEX), tx: 'dev', wallet: 'DEV', tsMs: ts }));
  for (let r = 0; r < (opts.runNeighbours ?? 0); r++) {
    rows.push(row({ slot, sid: sidAt(slot, DEV_INDEX + 1 + r), tx: `run${r}`, wallet: `R${r}`, tsMs: ts }));
  }
  for (let b = 0; b < opts.bundles; b++) {
    // Both wallets in ONE transaction: same block index, different inner-instruction index.
    rows.push(row({ slot, sid: sidAt(slot, BUNDLE_INDEX + 10 * b, 0), tx: `bundle${b}`, wallet: `A${b}`, tsMs: ts }));
    rows.push(row({ slot, sid: sidAt(slot, BUNDLE_INDEX + 10 * b, 1), tx: `bundle${b}`, wallet: `B${b}`, tsMs: ts }));
  }
  for (let l = 0; l < opts.loneWallets; l++) {
    rows.push(row({ slot, sid: sidAt(slot, LONE_INDEX + 10 * l), tx: `lone${l}`, wallet: `L${l}`, tsMs: ts }));
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
const page = (o: { createSlot: number; bundles: number; loneWallets: number; runNeighbours?: number }) =>
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
  provenLaunches: 0,
  bundledLaunches: 0,
  fullSample: false,
  allProven: null,
  allBundled: null,
  neverProven: false,
  neverBundles: false,
  launches: [],
  ...o,
});

/**
 * `n` launches: the first `bundled` proven by a shared transaction, the next `runOnly` proven by the
 * deployer-anchored run alone, the rest proven by neither.
 *
 * The middle group is the population captain decision 183a exists to size, so the summary fixtures
 * have to be able to produce it — a helper that only knew "bundled or not" could not tell the union's
 * headline from the shared-transaction half's.
 */
const launches = (n: number, bundled: number, runOnly = 0) =>
  Array.from({ length: n }, (_, i) => {
    const isBundled = i < bundled;
    const isRunOnly = !isBundled && i < bundled + runOnly;
    return {
      ageDays: i + 1,
      bundledTx: isBundled ? 1 : 0,
      maxWalletsInOneTx: isBundled ? 2 : 1,
      runTx: isRunOnly ? 3 : 1,
      adjacencyMarks: isRunOnly ? 2 : 0,
      coordinatedWallets: isBundled ? 2 : isRunOnly ? 2 : 0,
      createSlotWallets: 3,
      bundled: isBundled,
      proven: isBundled || isRunOnly,
    };
  });

/** A full-sample candidate at the pinned cap, `bundled` bundled windows and `runOnly` union-only ones. */
const full = (bundled: number, runOnly = 0, extra: Partial<CandidateBundling> = {}) => {
  const n = ENTRY.maxLaunchesPerCandidate;
  const ls = launches(n, bundled, runOnly);
  const proven = ls.filter((l) => l.proven).length;
  return candidate({
    launchesUsable: n,
    launchesPlanned: n,
    provenLaunches: proven,
    bundledLaunches: bundled,
    fullSample: true,
    allProven: proven === n,
    allBundled: bundled === n,
    neverProven: ls.every((l) => l.coordinatedWallets === 0),
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
      entryEligibility: { known: true, kind: 'swap-api', minAgeMs: windowReachMs(ENTRY), billed: false } as const,
      listingIntervalMs: T['budget'].keylessMinIntervalMs,
    });
    expect(text).toContain('KEYED SPEND: 0');
    expect(text).toContain(`ceiling ${T['bundling_census'].maxListingRequests}`);
    expect(text).toContain(`ceiling ${T['bundling_census'].maxKeylessRequests}`);
    expect(text).toContain('no entry score, no room figure, no field, no entry cost, no verdict');
    // Every standing caveat reaches the plan, not only the report — the requirement `entry.mjs`
    // states for `LANDING_TIP_CAVEAT` and the reason it is a constant rather than a doc line.
    // `PREDICATE_CAVEAT` is here for a sharper reason: this census has now been taken under two
    // different co-ordination rules, and a rate quoted without its rule is the same failure as a
    // fraction quoted without its denominator.
    expect(text).toContain(PREDICATE_CAVEAT);
    expect(text).toContain('measure.mjs -> roomIsProven');
    expect(text).toContain(OWNERSHIP_LIST_CAVEAT);
    expect(text).toContain(DROPPED_WINDOW_CAVEAT);
    expect(text).toContain(MINT_TIME_BACKDATE_CAVEAT);

    // THE PLAN STATES THE FLOOR ITS OWN SOURCE ANSWERS, and the reach stays the walk's. They are
    // one number for the swap-api source this census reads, so proving the plan is not deriving the
    // floor itself takes a source that answers something else — the run path's pin below could not
    // see this printer, which is how a stale claim survived a round here.
    const lagged = renderDryRun({
      cohortSize: 82,
      cohortCap: T['bundling_census'].maxCohortSize,
      maxCandidates: T['bundling_census'].maxCandidatesSurveyed,
      census: T['bundling_census'],
      entry: ENTRY,
      entryEligibility: { known: true, kind: 'swap-api', minAgeMs: windowReachMs(ENTRY) + 240_000, billed: false } as const,
      listingIntervalMs: T['budget'].keylessMinIntervalMs,
    });
    expect(text).toContain(`eligibility floor ${windowReachMs(ENTRY)}ms, seek reach ${windowReachMs(ENTRY)}ms.`);
    expect(lagged).toContain(
      `eligibility floor ${windowReachMs(ENTRY) + 240_000}ms, seek reach ${windowReachMs(ENTRY)}ms.`,
    );
    // And the plan no longer claims the two are one call, because for a lagging source they are not.
    expect(lagged).not.toContain('THE LAST TWO ARE ONE BOUND');
    expect(lagged).toContain('THE FLOOR IS THE GATE THE FILL SOURCE ITSELF APPLIES');
  });

  it('a floor this plan could not have for free prints UNAVAILABLE with its reason', async () => {
    // Captain decision 286c, on the census's own plan surface. This pass is keyless throughout —
    // captain decision 173a's "zero keyed requests" is a property of the tree — so its source
    // DECLARES itself free and nothing here can print the unavailable form today. What the
    // declaration buys is that a future source which bills to be built cannot make a census dry run
    // spend by accident: it would print UNAVAILABLE, and this is what that looks like.
    expect(CENSUS_FILL_CONSTRUCTION.cost).toBe('free');
    expect(CENSUS_FILL_CONSTRUCTION.kind).toBe(ENTRY_FILL_SOURCE_KIND);

    const text = renderDryRun({
      cohortSize: 82,
      cohortCap: T['bundling_census'].maxCohortSize,
      maxCandidates: T['bundling_census'].maxCandidatesSurveyed,
      census: T['bundling_census'],
      entry: ENTRY,
      entryEligibility: {
        known: false,
        kind: 'dune',
        why: 'building it runs the trade tables\' coverage probe, whose result read is billed.',
        authorisedBy: null,
      },
      listingIntervalMs: T['budget'].keylessMinIntervalMs,
    });
    // The word alone is not the requirement — the REASON is, and the source that owes the answer.
    expect(text).toContain('eligibility floor UNAVAILABLE');
    expect(text).toContain('NOT MEASURED, NOT ZERO');
    expect(text).toContain('dune fill source');
    expect(text).toContain('coverage probe');
    // NEVER A BLANK AND NEVER A ZERO in that slot, and every other parameter still printed.
    expect(text).not.toMatch(/eligibility floor (?:0|NaN|undefined|null|)ms/);
    expect(text).toContain(`seek reach ${windowReachMs(ENTRY)}ms.`);
    expect(text).toContain('KEYED SPEND: 0');
    expect(text).toContain(PREDICATE_CAVEAT);

    // AND THE PLAN PATH REFUSES TO BUILD A BILLED SOURCE, which is what makes that line reachable
    // by anything other than a hand-built argument. The census ships no spending opt-in, so its
    // plan passes `spendAuthorised: false` unconditionally and a constructor that would spend is
    // never called — asserted with a constructor that fails the test if it ever is.
    let constructed = 0;
    const eligibility = await planEligibility({
      registration: {
        construction: {
          kind: 'dune',
          cost: 'billed',
          why: 'building it runs a billed coverage probe.',
          bound: 'at most 1 execution',
          actual: () => 'nothing',
        },
        build: () => {
          constructed += 1;
          throw new Error('the census plan must never construct a billed fill source');
        },
      },
      bounds: entryFillBounds(ENTRY, NOW),
      spendAuthorised: false,
      authorisedBy: null,
      announce: () => {},
    });
    expect(constructed).toBe(0);
    expect(eligibility.known).toBe(false);
    // And the census's own plan path is the one that passes `false`, not a caller that might not.
    expect(CENSUS_SOURCE).toContain('spendAuthorised: false');
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

  it('reads both halves of the co-ordination rule off a walked window', async () => {
    const { client } = scriptedClient([page({ createSlot: 500, bundles: 2, loneWallets: 3 })]);
    const result = await censusCandidate(client, {
      refs: refs(1),
      nowMs: NOW,
      entry: ENTRY,
      mintTimeBackdateMs: BACKDATE,
    });
    expect(result.launchesUsable).toBe(1);
    expect(result.launches[0]).toMatchObject({
      bundledTx: 2,
      maxWalletsInOneTx: 2,
      // The deployer sits alone between two gaps, so half (b) marks nothing here.
      runTx: 1,
      adjacencyMarks: 0,
      coordinatedWallets: 4,
      // DEV + 2 bundles x 2 wallets + 3 lone = 8 distinct wallets in the create slot.
      createSlotWallets: 8,
      bundled: true,
      proven: true,
    });
    expect(result.provenLaunches).toBe(1);
    expect(result.bundledLaunches).toBe(1);
  });

  it('THE UNION: a window with NO bundle but a deployer-anchored run is PROVEN', async () => {
    // Captain decision 183a's whole subject. The live probe found this shape on 5 of the first
    // census run's 11 `neverBundles` wallets, and under the shared-transaction half alone it read
    // as a deployer that never co-ordinates. The census must now score it exactly as the screen
    // does — `roomIsProven`, not a local copy of the rule.
    const { client } = scriptedClient([
      page({ createSlot: 600, bundles: 0, loneWallets: 3, runNeighbours: 2 }),
    ]);
    const result = await censusCandidate(client, { refs: refs(1), nowMs: NOW, entry: ENTRY, mintTimeBackdateMs: BACKDATE });
    expect(result.launches[0]).toMatchObject({
      bundledTx: 0,
      maxWalletsInOneTx: 1,
      runTx: 3,
      adjacencyMarks: 2,
      coordinatedWallets: 2,
      bundled: false,
      proven: true,
    });
    expect(result.provenLaunches).toBe(1);
    expect(result.bundledLaunches).toBe(0);
    // The superseded flag still reads TRUE here, and it no longer means unscoreable. Keeping it is
    // what lets the two census records be compared; reading it as permanence is the error this
    // re-run removes.
    expect(result.neverBundles).toBe(true);
    expect(result.neverProven).toBe(false);
  });

  it('THE `GeBJSHK4…` SHAPE: a create slot NEITHER half marks is unproven, not unmeasured', async () => {
    // A busy create slot with every wallet in its own transaction and nothing beside the deployer.
    // The co-ordination rule found nothing, which is observationally identical to there being
    // nothing — `measure.mjs` → `roomIsProven` is the refusal, and this pass reports the input to
    // it rather than the verdict.
    const { client } = scriptedClient([page({ createSlot: 700, bundles: 0, loneWallets: 9 })]);
    const result = await censusCandidate(client, { refs: refs(1), nowMs: NOW, entry: ENTRY, mintTimeBackdateMs: BACKDATE });
    expect(result.launches[0]).toMatchObject({
      bundledTx: 0,
      maxWalletsInOneTx: 1,
      runTx: 1,
      adjacencyMarks: 0,
      coordinatedWallets: 0,
      bundled: false,
      proven: false,
    });
    expect(result.provenLaunches).toBe(0);
    expect(result.bundledLaunches).toBe(0);
    expect(result.neverProven).toBe(true);
    expect(result.neverBundles).toBe(true);
    // And it is not a drop: the window was walked and measured perfectly well.
    expect(result.launchesDropped).toBe(0);
    expect(result.launchesUsable).toBe(1);
  });

  it('tracks the screen\'s predicate rather than restating it', () => {
    // The first run froze a local copy at `bundledTx >= 1`, which then drifted from `roomIsProven`
    // when decision 182a widened it — and the record had to carry a caveat saying so. Calling the
    // function is what makes that class of drift impossible rather than merely noticed.
    expect(CENSUS_CODE).toMatch(/roomIsProven\(measurement\)/);
    expect(CENSUS_CODE).not.toMatch(/proven:\s*measurement\.bundledTx/);
  });

  it('applies Stage 2\'s own eligibility floor, so a launch too young to have finished is skipped', async () => {
    // DERIVED from `windowReachMs`, exactly as `censusCandidate` derives it, because the floor is no
    // longer a duration either side may hand-write. It used to be `windowMs + seekMarginMs` in both
    // files; the screen's moved to the span-derived reach and a local copy here would have left this
    // census measuring a different set of launches than the pass it is a finding about.
    const floor = windowReachMs(ENTRY);
    const at = async (ageMs: number) =>
      censusCandidate(scriptedClient([page({ createSlot: 500, bundles: 1, loneWallets: 1 })]).client, {
        refs: [{ mint: 'YOUNG', deployedAtMs: NOW - ageMs }],
        nowMs: NOW,
        entry: ENTRY,
        mintTimeBackdateMs: BACKDATE,
      });

    const { client, urls } = scriptedClient([page({ createSlot: 500, bundles: 1, loneWallets: 1 })]);
    const result = await censusCandidate(client, {
      refs: [{ mint: 'YOUNG', deployedAtMs: NOW - (floor - 1) }],
      nowMs: NOW,
      entry: ENTRY,
      mintTimeBackdateMs: BACKDATE,
    });
    expect(result.launchesEligible).toBe(0);
    expect(result.launchesAttempted).toBe(0);
    expect(urls).toEqual([]);

    // And the floor really is the screen's, not merely at least as strict: the old sum is now
    // REFUSED here, which is the assertion that fails if either file grows its own copy again.
    expect(floor).toBeGreaterThan(ENTRY.windowMs + ENTRY.seekMarginMs);
    expect((await at(ENTRY.windowMs + ENTRY.seekMarginMs)).launchesEligible).toBe(0);
    expect((await at(floor)).launchesEligible).toBe(1);
  });

  it('ASKS a fill source for that floor, and it is the kind the screen selects', async () => {
    // The census's whole value is that it cannot drift from the pass it reports on, and captain
    // decision 257a moved "has this launch finished happening" out of the arithmetic and into the
    // VENDOR. So a `windowReachMs` call here would no longer be the screen's gate — it would be the
    // duration one particular source happens to answer with.
    //
    // Proven by making the two disagree: a source answering an hour refuses a launch the reach
    // admits, so a re-derivation in `bundling.mjs` fails this.
    const floor = windowReachMs(ENTRY);
    const stub = {
      ...censusFillSource(new KeylessClient({ maxRequests: 1, minIntervalMs: 0 })),
      minAgeMs: async () => floor + 3_600_000,
    };
    const { client, urls } = scriptedClient([page({ createSlot: 500, bundles: 1, loneWallets: 1 })]);
    const refused = await censusCandidate(client, {
      refs: [{ mint: 'YOUNG', deployedAtMs: NOW - floor }],
      nowMs: NOW,
      entry: ENTRY,
      mintTimeBackdateMs: BACKDATE,
      fillSource: stub,
    });
    expect(refused.launchesEligible).toBe(0);
    expect(urls).toEqual([]);

    // AND THE TIE TO THE SCREEN, which is what stops the two answering to different vendors. The
    // census builds its source rather than importing `selectEntryFillSource` — that module carries
    // the Dune client and the credential reader, and this pass spends zero keyed requests — so the
    // agreement is asserted here instead: same provenance, same answer, on the same bounds.
    const keyless = () => new KeylessClient({ maxRequests: 1, minIntervalMs: 0 });
    const census = censusFillSource(keyless());
    const screen = selectEntryFillSource(ENTRY_FILL_SOURCE_KIND, {
      'swap-api': () => swapApiFillSource(keyless()),
    });
    expect(census.kind).toBe(ENTRY_FILL_SOURCE_KIND);
    const bounds = entryFillBounds(ENTRY, NOW);
    expect(await census.minAgeMs(bounds)).toBe(await screen.minAgeMs(bounds));
    expect(census.issued()).toBe(0);
  });

  it('REFUSES a source whose floor is not a duration, rather than counting zero eligible launches', async () => {
    // The consequence here is worse than the bad printed line the same guard stops on the screen's
    // plan. This floor is used as a FILTER: a non-finite answer makes every launch fail
    // `age >= minAgeMs`, so the census would report `launchesEligible: 0` for every candidate — a
    // census of nothing, indistinguishable from a cohort that genuinely had no eligible launch, and
    // wrong in the direction that publishes a finding rather than refusing to. `assertMinAgeUsable`
    // is documented as the backstop for a source that forgets; a call site that skipped it was a
    // place that claim was not true.
    const { client, urls } = scriptedClient([page({ createSlot: 500, bundles: 1, loneWallets: 1 })]);
    const refs = [{ mint: 'OLD', deployedAtMs: NOW - 86_400_000 }];
    const withFloor = async (minAgeMs: number) =>
      censusCandidate(client, {
        refs,
        nowMs: NOW,
        entry: ENTRY,
        mintTimeBackdateMs: BACKDATE,
        fillSource: {
          ...censusFillSource(new KeylessClient({ maxRequests: 1, minIntervalMs: 0 })),
          minAgeMs: async () => minAgeMs,
        },
      });

    await expect(withFloor(Number.POSITIVE_INFINITY)).rejects.toThrow(/not a duration/);
    await expect(withFloor(Number.NaN)).rejects.toThrow(/not a duration/);
    // It throws INSTEAD of measuring, so the silent zero-eligible reading is unreachable and the
    // walk never starts.
    expect(urls).toEqual([]);
    // A real duration still measures, so the guard refuses nothing it should not.
    expect((await withFloor(windowReachMs(ENTRY))).launchesEligible).toBe(1);
  });

  it('caps the sample at Stage 2\'s own per-candidate launch cap', async () => {
    const { client } = scriptedClient([page({ createSlot: 500, bundles: 1, loneWallets: 1 })]);
    const result = await censusCandidate(client, {
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
    const result = await censusCandidate(client, { refs: refs(1), nowMs: NOW, entry: ENTRY, mintTimeBackdateMs: BACKDATE });
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
    const result = await censusCandidate(client, { refs: refs(4), nowMs: NOW, entry: ENTRY, mintTimeBackdateMs: BACKDATE });
    expect(result.launchesAttempted).toBe(1);
    expect(result.dropNotes.some((n) => n.includes('census ceiling'))).toBe(true);
    expect(client.issued()).toBeLessThanOrEqual(ENTRY.maxRequestsPerLaunch);
  });
});

describe('the headline number is defined over the population it names', () => {
  const CAP = ENTRY.maxLaunchesPerCandidate;

  it('counts 8-of-8 PROVEN candidates ONLY among those that produced a full sample', () => {
    const s = summariseCensus([
      full(CAP), // 8 of 8 by shared transaction — scoreable
      full(0, CAP), // 8 of 8 by the deployer-anchored run alone — scoreable ONLY under the union
      full(CAP - 1), // 7 of 8 — silenced by one launch
      full(0), // neither half sees anything, full sample
      // Six usable windows, every one proven. Stage 2 would call this UNMEASURED anyway, for a
      // reason that is not co-ordination evidence, so it must not be counted either side of the
      // headline.
      candidate({
        launchesUsable: 6,
        provenLaunches: 6,
        bundledLaunches: 6,
        fullSample: false,
        launches: launches(6, 6),
      }),
    ]);
    expect(s.headline.candidatesWithFullSample).toBe(4);
    expect(s.headline.candidatesProvenOnAllOfThem).toBe(2);
    expect(s.headline.fraction).toBe(0.5);
    expect(s.headline.silencedByOneUnprovenLaunch).toBe(2);
    expect(s.headline.candidatesShortOfAFullSample).toBe(1);
    // AND THE SUPERSEDED READING IS IN THE SAME OBJECT: under the shared-transaction half alone the
    // run-only candidate disappears, which is exactly the gap decision 183a asked this pass to size.
    expect(s.headline.candidatesBundlingOnAllOfThem).toBe(1);
    expect(s.headline.sharedTxFraction).toBe(0.25);
  });

  it('counts the permanently unscoreable APART from the near-misses, and never sums them', () => {
    const s = summariseCensus([
      full(0), // neither half marks anything on any window — the GeBJSHK4 shape
      full(0, CAP), // never bundles, but the union proves every window — NOT permanent
      full(CAP - 1), // a near-miss, and NOT permanently anything
      candidate({ launchesUsable: 3, provenLaunches: 3, bundledLaunches: 3, launches: launches(3, 3) }),
    ]);
    expect(s.unscoreable.neverProven).toBe(1);
    expect(s.unscoreable.neverProvenWithFullSample).toBe(1);
    expect(s.unscoreable.shortOfAFullSampleButAllProven).toBe(1);
    // The superseded count is larger, and the difference is named rather than left to be inferred.
    expect(s.unscoreable.neverBundles).toBe(2);
    expect(s.unscoreable.neverBundlesButProvenSomewhere).toBe(1);
    // The categories are reported as distinct fields; nothing in the summary adds them.
    expect(s.headline.silencedByOneUnprovenLaunch).toBe(2);
  });

  it('every rate ships beside its own denominator, and beside the predicate that produced it', () => {
    // This lane exists because a finding was correctly labelled "n = 2, a signal not a rate". A
    // summary that separated a fraction from its n is how the next reader loses that, so each rate
    // and its denominator live in the same object — and since this census has now been taken under
    // two predicates, both readings do too.
    const s = summariseCensus([full(CAP), full(0, 4), full(0)]);
    // Derived from the pinned cap rather than written out, because the fixture IS three candidates
    // at that cap: hardcoding 24 meant this test went stale the moment captain decision 190a moved
    // `stage2_entry.maxLaunchesPerCandidate`, which is the one number this block deliberately reads
    // instead of re-pinning.
    const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
    expect(s.perLaunch).toMatchObject({
      launchesMeasured: 3 * CAP,
      proven: CAP + 4,
      rate: round4((CAP + 4) / (3 * CAP)),
      bundledBySharedTxAlone: CAP,
      sharedTxRate: round4(1 / 3),
      provenByAdjacencyOnly: 4,
      candidatesContributing: 3,
    });
    expect(s.headline).toMatchObject({
      candidatesWithFullSample: 3,
      candidatesProvenOnAllOfThem: 1,
      candidatesBundlingOnAllOfThem: 1,
    });
  });

  it('reports an undefined rate rather than a zero when there is nothing to divide', () => {
    const s = summariseCensus([]);
    expect(s.perLaunch.rate).toBeNull();
    expect(s.perLaunch.sharedTxRate).toBeNull();
    expect(s.headline.fraction).toBeNull();
    expect(s.headline.sharedTxFraction).toBeNull();
    expect(s.perLaunch.launchesMeasured).toBe(0);
    expect(s.headline.candidatesWithFullSample).toBe(0);
  });

  it('reports distributions rather than a mean — the standing captain bar for this class', () => {
    const s = summariseCensus([full(CAP), full(2, 2)]);
    for (const d of Object.values(s.perCandidate)) {
      if (typeof d !== 'object' || d === null) continue;
      expect(Object.keys(d as object)).toEqual(['n', 'min', 'p25', 'median', 'p75', 'max']);
    }
    expect(JSON.stringify(s)).not.toMatch(/"mean"|"average"/i);
  });

  it('the printed summary states the sample size on every one of the four answers', () => {
    const rendered = renderSummary({
      summary: summariseCensus([full(CAP), full(3, 2)]),
      windowParameters: { maxLaunchesPerCandidate: CAP },
      cohort: { found: 82, gated: 82, gatePassed: 2, surveyed: 2 },
      caveats: [PREDICATE_CAVEAT, OWNERSHIP_LIST_CAVEAT, DROPPED_WINDOW_CAVEAT],
    });
    expect(rendered).toMatch(/1\. PER-LAUNCH PROVEN RATE \(union\):.*\(n = \d+ windows over \d+ candidates\)/s);
    expect(rendered).toMatch(/3\. HEADLINE.*\(n = \d+ candidates with a full sample\)/s);
    expect(rendered).toContain('4. PERMANENTLY UNSCOREABLE');
    // The superseded reading is on the page beside the live one, never instead of it.
    expect(rendered).toContain('Shared-transaction half ALONE');
    expect(rendered).toContain(PREDICATE_CAVEAT);
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
    expect(t.provenRate).toBeCloseTo(t.proven / t.launches, 3);
    // Months are ordered and every bucket's arithmetic closes, on both halves.
    expect(t.byMonth.map((m) => m.month)).toEqual([...t.byMonth.map((m) => m.month)].sort());
    expect(t.byMonth.reduce((n, m) => n + m.launches, 0)).toBe(t.launches);
    expect(t.byMonth.reduce((n, m) => n + m.bundled, 0)).toBe(t.bundled);
    expect(t.byMonth.reduce((n, m) => n + m.proven, 0)).toBe(t.proven);
    // THE FINDING THIS TABLE EXISTS FOR: the shared-transaction rate is not stationary for this
    // operator. The earliest month bundles on nothing and the latest on nearly everything, which is
    // the tape's own 0% (Dec-Feb) -> 41.6% (Mar) -> 97-100% (from May) progression.
    const first = t.byMonth[0];
    const last = t.byMonth[t.byMonth.length - 1];
    expect(first?.rate).toBe(0);
    expect(last?.rate).toBeGreaterThan(0.9);
    // AND THE UNION'S COLUMN IS WHY THAT MUST NOT BE READ AS A HABIT. Decision 182a's measurement:
    // the union proves all 235 taped launches, including the pre-March months the shared-transaction
    // half reads as zero. The first run of the live census reported the left-hand column alone.
    expect(t.proven).toBe(t.launches);
    expect(first?.provenRate).toBe(1);
    expect(t.proven).toBeGreaterThan(t.bundled);
  });

  it('replays the headline over that history, and the trailing windows close arithmetically', () => {
    const t = subjectEraTrend();
    expect(t.trailingWindows).toBe(t.launches - 7);
    expect(t.trailingAllBundled).toBeLessThanOrEqual(t.trailingWindows);
    expect(t.trailingAllProven).toBeLessThanOrEqual(t.trailingWindows);
    expect(t.trailingByMonth.reduce((n, m) => n + m.windows, 0)).toBe(t.trailingWindows);
    expect(t.trailingByMonth.reduce((n, m) => n + m.allBundled, 0)).toBe(t.trailingAllBundled);
    expect(t.trailingByMonth.reduce((n, m) => n + m.allProven, 0)).toBe(t.trailingAllProven);
    // UNION >= SHARED-TRANSACTION HALF, ALWAYS AND STRUCTURALLY — (a)'s marked set is a subset of
    // the union's, so a window the older half proved cannot become unproven. The direction is the
    // whole safety property of decision 182a and it is asserted, not argued.
    expect(t.trailingAllProven).toBeGreaterThanOrEqual(t.trailingAllBundled);
    // The live analogue: a census run today walks the NEWEST 8, and on this deployer they are all
    // proven — which is why our own subject is not the wallet the pinning silences.
    expect(t.newestWindowAllProven).toBe(true);
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
    // And it names which column is which, because the two now disagree by 60 launches.
    expect(text).toContain('SHARED-TRANSACTION half alone');
    expect(text).toContain('PROVEN by the union');
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
      expect(parsed.caveats, file).toContain(PREDICATE_CAVEAT);
      expect(parsed.caveats, file).toContain(OWNERSHIP_LIST_CAVEAT);
      expect(parsed.caveats, file).toContain(DROPPED_WINDOW_CAVEAT);
      expect(parsed.caveats, file).toContain(MINT_TIME_BACKDATE_CAVEAT);
      // And no verdict of any kind was produced — this pass does not score.
      expect(JSON.stringify(parsed), file).not.toMatch(/entry-room|entry-open|entry-cost|roomLeft/);
    }
  });

  it('NAMES THE PREDICATE THAT PRODUCED IT, in the record and not only in the report beside it', () => {
    // The first run's record did not, and it could not have: the predicate was the only one there
    // was. It has since moved, so a census record that does not say which rule it was taken under
    // is a rate without its denominator — the failure this whole lane is built to refuse.
    // THE VERSION DECIDES WHETHER TO ASSERT, never the block's presence — the same rule
    // `test/deployer-screen.test.ts` states beside its `spend` pin. Pinning schema 2 as a global
    // invariant would make a schema-3 record uncommittable beside this one, which is the opposite
    // of the "bump, never retro-edit" rule the bump itself cites.
    const census = fileURLToPath(new URL('../tools/deployer-screen/census/', import.meta.url));
    let schema2Records = 0;
    for (const file of readdirSync(census).filter((f) => f.endsWith('.json'))) {
      const parsed = JSON.parse(readFileSync(join(census, file), 'utf8'));
      expect(typeof parsed.schemaVersion, file).toBe('number');
      if (parsed.schemaVersion !== 2) continue;
      schema2Records += 1;
      expect(parsed.predicate, file).toMatchObject({
        name: 'union',
        source: 'measure.mjs -> roomIsProven',
        decision: '182a',
      });
      expect(parsed.predicate.supersedes, file).toMatch(/shared-transaction/);
      // Both halves reach every launch row, so the superseded reading is recoverable from this
      // record without walking a window again — which is what makes it a replacement rather than a
      // second, non-comparable document.
      for (const c of parsed.candidates) {
        for (const l of c.launches) {
          expect(Object.keys(l).sort(), file).toEqual(
            [
              'adjacencyMarks',
              'ageDays',
              'bundled',
              'bundledTx',
              'coordinatedWallets',
              'createSlotWallets',
              'maxWalletsInOneTx',
              'proven',
              'runTx',
            ].sort(),
          );
          // UNION >= SHARED-TRANSACTION HALF on every committed row. Half (a)'s marked set is a
          // subset of the union's by construction, so a bundled window that read as unproven would
          // mean the implementation had inverted the safety property decision 182a rests on.
          expect(l.bundled && !l.proven, `${file} ${c.wallet}`).toBe(false);
        }
      }
    }
    // And the pin is not vacuous: this run's own record is schema 2.
    expect(schema2Records, 'no schema-2 census record was checked').toBeGreaterThan(0);
  });

  it('the committed record\'s own arithmetic closes', () => {
    // A summary that disagrees with the rows it was computed from is how a headline outlives its
    // evidence. Recomputing it from `candidates` is cheap and it is the whole audit.
    const census = fileURLToPath(new URL('../tools/deployer-screen/census/', import.meta.url));
    for (const file of readdirSync(census).filter((f) => f.endsWith('.json'))) {
      const parsed = JSON.parse(readFileSync(join(census, file), 'utf8'));
      // `summariseCensus` computes the CURRENT schema's summary, so it can only be held against a
      // record written at that schema; an older or newer record is audited by its own lane's test.
      if (parsed.schemaVersion === 2) {
        expect(summariseCensus(parsed.candidates), file).toEqual(parsed.summary);
      }
      // And the cohort accounting adds up: everything gated either passed or is named as not surveyed.
      expect(parsed.cohort.gatePassed + parsed.cohort.notSurveyed.length, file).toBe(parsed.cohort.gated);
      expect(parsed.cohort.surveyed + parsed.cohort.leftUnsurveyedByCap, file).toBe(parsed.cohort.gatePassed);
      expect(parsed.candidates.length, file).toBe(parsed.cohort.surveyed);
    }
  });
});
