/**
 * The candidate discovery feed — `tools/deployer-screen/feed.mjs` and `ledger.mjs`.
 *
 * The lane's acceptance criteria are three claims about behaviour, and every one of them is a claim
 * that can rot silently, so every one is asserted here rather than described in a README:
 *
 * 1. **A known wallet is never re-offered as new.** The memory is `ledger.mjs`, and it is folded in
 *    from committed screen run records as well as from its own history — so the feed starts warm
 *    rather than spending ~82 keyed requests re-learning wallets the screen already graded.
 * 2. **A dead feed cannot read as a healthy one.** Three conditions exit non-zero: our reader
 *    failing on a live response, every seed inert, and a dry streak. The first of those is not
 *    hypothetical — it is the 2026-07-29 defect, where two of three seeds returned zero wallets for
 *    two committed runs while the report read fine.
 * 3. **Every provider call is bounded.** This lane runs on a schedule forever against a credential
 *    shared with production, so the ceiling is asserted end to end against a stub that counts
 *    requests, not merely computed in a comment.
 *
 * The E2E tests drive `main()` through an injected `fetchImpl`, exactly as `client.mjs`'s own tests
 * do. Nothing here reaches the network.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendRun,
  backlogDepth,
  discoveryLagDays,
  dryStreak,
  emptyLedger,
  feedAlarm,
  gradeWallet,
  importRunRecords,
  loadLedger,
  markPrefiltered,
  markWorthARequest,
  nextGateBatch,
  queuedForScreen,
  recordSeen,
  saveLedger,
  summariseLedger,
} from '../tools/deployer-screen/ledger.mjs';
import type { Ledger } from '../tools/deployer-screen/ledger.mjs';
import { FEED_LIMITATIONS, main, parseFeedArgs, planFeedRun, triage, wrap } from '../tools/deployer-screen/feed.mjs';
import { KEY_ENV_VAR } from '../tools/deployer-screen/credential.mjs';

const TOOL_DIR = fileURLToPath(new URL('../tools/deployer-screen/', import.meta.url));
const COMMITTED_LEDGER = join(TOOL_DIR, 'feed', 'ledger.json');
const RUNS_DIR = join(TOOL_DIR, 'runs');
const DATA_DIR = fileURLToPath(new URL('../data/population-tape-2026-07-29/', import.meta.url));

const GATE = { minTokens: 25, minCompletionRate: 0.25, minSpanDays: 14 };
const FAKE_KEY = 'msk_test_key_value_padded_to_length_ok_1234';

const DAY = 86_400_000;
const T0 = Date.parse('2026-08-02T00:00:00.000Z');

/** A vendor profile with `n` launches over `spanDays`, `bonded` of them complete. */
function profile(n: number, bonded: number, spanDays: number, endMs = T0 - DAY) {
  const step = n <= 1 ? 0 : (spanDays * DAY) / (n - 1);
  return {
    pump_tokens: Array.from({ length: n }, (_, i) => ({
      created_timestamp: endMs - (n - 1 - i) * step,
      complete: i < bonded,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// The memory. Everything else rests on it: a feed without one is a re-poll of the same page.

describe('the ledger never lets a known wallet be offered as new twice', () => {
  it('reports a wallet as new exactly once, however often the seeds re-serve it', () => {
    const ledger = emptyLedger();
    expect(recordSeen(ledger, 'W1', ['recent-bonds'], '2026-08-02T00:00:00.000Z')).toBe(true);
    expect(recordSeen(ledger, 'W1', ['alerts'], '2026-08-02T04:00:00.000Z')).toBe(false);
    expect(recordSeen(ledger, 'W1', ['alerts'], '2026-08-02T08:00:00.000Z')).toBe(false);

    const entry = ledger.wallets['W1']!;
    expect(entry.timesSeen).toBe(3);
    // Provenance accumulates, so a name recurring across endpoints can be told from a one-list one.
    expect(entry.seededBy).toEqual(['alerts', 'recent-bonds']);
    expect(entry.firstSeenIso).toBe('2026-08-02T00:00:00.000Z');
    expect(entry.lastSeenIso).toBe('2026-08-02T08:00:00.000Z');
  });

  it('a graded wallet keeps its grade and is never reopened by being seen again', () => {
    // This is the captain's correction, asserted: a wallet already graded is not re-polled for a
    // re-open. Seeing it again updates provenance and nothing else.
    const ledger = emptyLedger();
    recordSeen(ledger, 'W1', ['recent-bonds'], '2026-08-02T00:00:00.000Z');
    gradeWallet(
      ledger,
      'W1',
      {
        state: 'held',
        gateVerdict: 'gate-failed',
        gateReading: 'ownership-only',
        tokens: 14,
        completionRate: 0.35,
        spanDays: 66,
        firstDeployIso: '2026-05-24T00:00:00.000Z',
        shortfalls: ['sample too small: 14 tokens < 25 required'],
      },
      '2026-08-02T00:00:00.000Z',
    );

    recordSeen(ledger, 'W1', ['alerts'], '2026-08-03T00:00:00.000Z');
    const entry = ledger.wallets['W1']!;
    expect(entry.state).toBe('held');
    expect(entry.gateVerdict).toBe('gate-failed');
    expect(entry.gradedAtIso).toBe('2026-08-02T00:00:00.000Z');
    // And it is not waiting for the gate, so no later batch spends a request on it.
    expect(nextGateBatch(ledger, 10)).not.toContain('W1');
  });

  it('measures the discovery lag from FIRST SIGHT, not from the run that got round to grading', () => {
    // The gate batch is a hard quota bound, so a wallet surfaced today is routinely gated days later
    // out of the backlog. Measuring at grading time would add that queue latency to the lag of every
    // backlog wallet and inflate the ledger-wide median the docs quote.
    const ledger = emptyLedger();
    recordSeen(ledger, 'W1', ['recent-bonds'], '2026-08-02T00:00:00.000Z');
    // Surfaced again, and only gated, ten days later.
    recordSeen(ledger, 'W1', ['recent-bonds'], '2026-08-12T00:00:00.000Z');
    gradeWallet(
      ledger,
      'W1',
      {
        state: 'queued',
        gateVerdict: 'gate-passed',
        gateReading: 'ownership-only',
        tokens: 40,
        completionRate: 0.5,
        spanDays: 100,
        firstDeployIso: '2026-07-03T00:00:00.000Z',
        shortfalls: [],
      },
      '2026-08-12T00:00:00.000Z',
    );
    // 2026-07-03 -> 2026-08-02 is 30 days. Graded on the 12th, it must not read as 40.
    expect(ledger.wallets['W1']!.discoveryLagDaysAtLeast).toBe(30);
  });

  it('a NaN completion rate is stored as null, never as a number', () => {
    // A rate over zero records is not a number and must not round-trip through JSON as one:
    // `JSON.stringify(NaN)` is `null` anyway, so storing it unguarded would make the ledger's own
    // reader disagree with the writer about the type.
    const ledger = emptyLedger();
    recordSeen(ledger, 'W1', [], '2026-08-02T00:00:00.000Z');
    gradeWallet(
      ledger,
      'W1',
      {
        state: 'unmeasured',
        gateVerdict: 'gate-failed',
        gateReading: 'ownership-only',
        tokens: 0,
        completionRate: Number.NaN,
        spanDays: 0,
        firstDeployIso: null,
        shortfalls: [],
      },
      '2026-08-02T00:00:00.000Z',
    );
    expect(ledger.wallets['W1']!.completionRate).toBeNull();
    expect(ledger.wallets['W1']!.discoveryLagDaysAtLeast).toBeNull();
  });

  it('the pre-filter sets a wallet aside without latching it there forever', () => {
    // The vendor's counters are a trailing ~7.5-day window, so a steady deployer drops below the
    // floor on a quiet week. A cadence filter that LATCHES is strictly worse than one that does not.
    const ledger = emptyLedger();
    recordSeen(ledger, 'W1', ['alerts'], '2026-08-02T00:00:00.000Z');
    markPrefiltered(ledger, 'W1', '2026-08-02T00:00:00.000Z');
    expect(ledger.wallets['W1']!.state).toBe('prefiltered');
    expect(nextGateBatch(ledger, 10)).not.toContain('W1');

    markWorthARequest(ledger, 'W1');
    expect(nextGateBatch(ledger, 10)).toContain('W1');
  });

  it('the pre-filter never downgrades a wallet that already carries a grade', () => {
    const ledger = emptyLedger();
    recordSeen(ledger, 'W1', [], '2026-08-02T00:00:00.000Z');
    gradeWallet(
      ledger,
      'W1',
      {
        state: 'queued',
        gateVerdict: 'gate-passed',
        gateReading: 'ownership-only',
        tokens: 40,
        completionRate: 0.5,
        spanDays: 100,
        firstDeployIso: '2026-01-01T00:00:00.000Z',
        shortfalls: [],
      },
      '2026-08-02T00:00:00.000Z',
    );
    markPrefiltered(ledger, 'W1', '2026-08-03T00:00:00.000Z');
    expect(ledger.wallets['W1']!.state).toBe('queued');
  });
});

describe('the gate batch drains the backlog before it drains the new', () => {
  it('is FIFO by first-seen, then address, and bounded by the batch size', () => {
    const ledger = emptyLedger();
    recordSeen(ledger, 'Wc', [], '2026-08-01T00:00:00.000Z');
    recordSeen(ledger, 'Wa', [], '2026-08-01T00:00:00.000Z');
    recordSeen(ledger, 'Wb', [], '2026-07-30T00:00:00.000Z');
    recordSeen(ledger, 'Wd', [], '2026-08-02T00:00:00.000Z');

    expect(nextGateBatch(ledger, 3)).toEqual(['Wb', 'Wa', 'Wc']);
    expect(backlogDepth(ledger)).toBe(4);
    // A run that always gated the freshest would starve `Wb` permanently while reporting healthy
    // yield every time, which is the failure mode this ordering exists to prevent.
    expect(nextGateBatch(ledger, 1)).toEqual(['Wb']);
    expect(nextGateBatch(ledger, 0)).toEqual([]);
  });
});

describe('committed screen run records are folded in, so the feed starts warm', () => {
  it('imports both graded candidates and pre-filtered wallets as ALREADY SEEN', () => {
    const ledger = emptyLedger();
    const { imported } = importRunRecords(ledger, [
      {
        file: 'r.json',
        body: {
          startedAtIso: '2026-08-02T08:35:14.567Z',
          candidates: [
            {
              wallet: 'PASSED',
              verdict: 'gate-passed',
              seededBy: ['alerts:good'],
              tokens: 61,
              completionRate: 0.54,
              spanDays: 581.59,
              windowFirstDeploy: '2024-10-30T04:11:10.486Z',
              gateReasons: [],
            },
            {
              wallet: 'FAILED',
              verdict: 'gate-failed',
              tokens: 14,
              gateReasons: ['sample too small: 14 tokens < 25 required'],
            },
            { wallet: 'SCORED', verdict: 'gate-passed', entry: { verdict: 'entry-room-present' } },
          ],
          // A pre-filtered wallet was SEEN. Treating it as unseen would re-offer it every run and
          // the cadence filter would skip it again every run — a duplicate that never converges.
          prefilteredOut: [{ wallet: 'SKIPPED', reason: 'trailing count too low' }],
        },
      },
    ]);

    expect(imported).toBe(4);
    expect(recordSeen(ledger, 'PASSED', [], '2026-08-03T00:00:00.000Z')).toBe(false);
    expect(recordSeen(ledger, 'SKIPPED', [], '2026-08-03T00:00:00.000Z')).toBe(false);
    expect(ledger.wallets['PASSED']!.state).toBe('queued');
    expect(ledger.wallets['FAILED']!.state).toBe('held');
    expect(ledger.wallets['SKIPPED']!.state).toBe('prefiltered');
    // An entry score means the beatability screen already ran on it, so it is not the feed's product.
    expect(ledger.wallets['SCORED']!.screened).toBe(true);
    expect(ledger.wallets['PASSED']!.screened).toBe(false);
    expect(queuedForScreen(ledger).map((e) => e.wallet)).toEqual(['PASSED']);
  });

  it('reads the two committed records — including the one with no schemaVersion at all', () => {
    // The elite record predates `schemaVersion` and `historySource`. A reader that assumed either
    // would drop 12 known wallets and re-spend 12 keyed requests learning them again.
    const ledger = emptyLedger();
    const elite = JSON.parse(readFileSync(join(RUNS_DIR, '2026-07-29-elite.json'), 'utf8')) as {
      schemaVersion?: number;
      candidates: { wallet: string }[];
    };
    expect(elite.schemaVersion).toBeUndefined();
    const { imported } = importRunRecords(ledger, [{ file: 'elite', body: elite }]);
    expect(imported).toBe(elite.candidates.length);
    for (const c of elite.candidates) {
      expect(recordSeen(ledger, c.wallet, [], '2026-08-03T00:00:00.000Z')).toBe(false);
    }
  });

  it('is idempotent — importing the same record twice imports nothing the second time', () => {
    const ledger = emptyLedger();
    const body = JSON.parse(readFileSync(join(RUNS_DIR, '2026-08-02-good.json'), 'utf8')) as unknown;
    const first = importRunRecords(ledger, [{ file: 'a', body }]);
    const second = importRunRecords(ledger, [{ file: 'a', body }]);
    expect(first.imported).toBeGreaterThan(0);
    expect(second.imported).toBe(0);
  });

  it('survives a record it cannot read rather than refusing the run', () => {
    const ledger = emptyLedger();
    const { imported } = importRunRecords(ledger, [
      { file: 'junk', body: null },
      { file: 'junk2', body: 'not an object' },
      { file: 'junk3', body: { candidates: [{ noWallet: true }, 'string', null] } },
    ]);
    expect(imported).toBe(0);
  });
});

describe('the committed ledger is consistent with the committed run records', () => {
  const ledger = loadLedger(COMMITTED_LEDGER);

  it('holds every wallet the two committed screen runs touched', () => {
    // If this drifts, the next live feed run offers already-graded wallets back as discoveries and
    // spends the shared allowance re-learning them. Cheap to assert, expensive to miss.
    const fresh = emptyLedger();
    importRunRecords(fresh, [
      { file: 'a', body: JSON.parse(readFileSync(join(RUNS_DIR, '2026-07-29-elite.json'), 'utf8')) },
      { file: 'b', body: JSON.parse(readFileSync(join(RUNS_DIR, '2026-08-02-good.json'), 'utf8')) },
    ]);
    for (const wallet of Object.keys(fresh.wallets)) {
      expect(Object.keys(ledger.wallets), `${wallet} is missing from the committed ledger`).toContain(wallet);
    }
  });

  it('persists derived fields only — the same ToS §5a(d) containment the run record makes', () => {
    // No mint, no token name, no symbol, no market cap, no bond time. The wallet address is public
    // on-chain data and ours to keep; everything beside it is our own computation.
    const FORBIDDEN =
      /"(mint|token_mint|token_name|token_symbol|symbol|name|peak_market_cap|mc_at_bond|bonded_at|deployed_at|time_to_bond_minutes|ath_market_cap|pool_address|token_image_url)"/;
    const text = readFileSync(COMMITTED_LEDGER, 'utf8');
    expect(FORBIDDEN.test(text)).toBe(false);
    expect(/msk_[A-Za-z0-9_-]{20,}/.test(text)).toBe(false);

    const ALLOWED = [
      'completionRate',
      'discoveryLagDaysAtLeast',
      'firstDeployIso',
      'firstSeenIso',
      'gateReading',
      'gateVerdict',
      'gradedAtIso',
      'lastSeenIso',
      'origin',
      'screened',
      'seededBy',
      'shortfalls',
      'spanDays',
      'state',
      'timesSeen',
      'tokens',
      'wallet',
    ];
    for (const entry of Object.values(ledger.wallets)) {
      expect(Object.keys(entry).sort()).toEqual(ALLOWED);
    }
  });

  it('carries the quantified discovery lag, which is the answer to "how late are we"', () => {
    // The lane was asked to state the discovery lag and quantify it if it can be quantified. It can,
    // for the wallets the vendor profiled: this is their age at the moment we first saw them.
    const s = summariseLedger(ledger);
    expect(s.lagObservations).toBeGreaterThan(50);
    expect(s.lagMedianDaysAtLeast).not.toBeNull();
    // Months, not days. A feed that believed it was early would be wrong by a wide margin.
    expect(s.lagMedianDaysAtLeast!).toBeGreaterThan(30);
    expect(s.lagMaxDaysAtLeast!).toBeGreaterThanOrEqual(s.lagMedianDaysAtLeast!);
  });

  it('counts the cost of grading cheaply rather than describing it', () => {
    const s = summariseLedger(ledger);
    // Every grade in the committed ledger came from the ownership reading, which is biased towards
    // REJECTION. So the held population is a standing count of possible false negatives, and the
    // near-misses inside it are the shortlist worth a creation-derived re-read.
    expect(s.heldOnOwnershipReading).toBe(s.held);
    expect(s.heldNearMiss).toBeGreaterThan(0);
    expect(s.heldNearMiss).toBeLessThanOrEqual(s.heldOnOwnershipReading);
  });
});

// ---------------------------------------------------------------------------------------------
// Dryness. The failure this lane was explicitly told to make impossible.

describe('a dead feed cannot read as a healthy quiet one', () => {
  const healthySeeds = [
    { label: 'recent-bonds', rowsReturned: 50, walletsReturned: 50 },
    { label: 'alerts', rowsReturned: 50, walletsReturned: 50 },
  ];

  it('does not alarm on an ordinary run that found something', () => {
    expect(feedAlarm({ seeds: healthySeeds, dryStreak: 0, dryStreakAlarm: 3 }).alarmed).toBe(false);
  });

  it('does not alarm on ONE dry run — the vendor pages overlap heavily between runs', () => {
    expect(feedAlarm({ seeds: healthySeeds, dryStreak: 1, dryStreakAlarm: 3 }).alarmed).toBe(false);
  });

  it('alarms the moment a seed returns rows we read no wallet from — OUR bug, not theirs', () => {
    // The 2026-07-29 defect, recurring: the deployer block moved to `deployers` (plural) and two of
    // three seeds yielded nothing for two committed runs while the report read fine. Loud on the
    // FIRST occurrence, never after a streak — a streak would mean waiting three runs to be told
    // our own reader is broken.
    const alarm = feedAlarm({
      seeds: [{ label: 'alerts', rowsReturned: 50, walletsReturned: 0 }, ...healthySeeds],
      dryStreak: 0,
      dryStreakAlarm: 3,
    });
    expect(alarm.alarmed).toBe(true);
    expect(alarm.reasons.join(' ')).toMatch(/OUR READER IS WRONG/);
    expect(alarm.reasons.join(' ')).toContain('alerts');
  });

  it('alarms when every seed is inert, separately from the dry streak', () => {
    const alarm = feedAlarm({
      seeds: [
        { label: 'recent-bonds', rowsReturned: 0, walletsReturned: 0 },
        { label: 'alerts', rowsReturned: 0, walletsReturned: 0 },
      ],
      dryStreak: 0,
      dryStreakAlarm: 3,
    });
    expect(alarm.alarmed).toBe(true);
    expect(alarm.reasons.join(' ')).toMatch(/EVERY seed yielded zero wallets/);
  });

  it('alarms on the dry streak, and names the remedy as a wider source rather than more waiting', () => {
    const alarm = feedAlarm({ seeds: healthySeeds, dryStreak: 3, dryStreakAlarm: 3 });
    expect(alarm.alarmed).toBe(true);
    expect(alarm.reasons.join(' ')).toMatch(/DRY: 3 consecutive live run/);
    expect(alarm.reasons.join(' ')).toMatch(/a wider source does/);
  });

  const row = (live: boolean, newlySurfaced: number, completed = true) => ({
    startedAtIso: '2026-08-02T00:00:00.000Z',
    live,
    completed,
    distinctWalletsSeeded: 10,
    alreadyKnown: 10 - newlySurfaced,
    newlySurfaced,
    gated: 0,
    queued: 0,
    held: 0,
    unmeasured: 0,
    prefiltered: 0,
    backlog: 0,
    keyedRequests: 3,
    inertSeeds: [],
  });

  it('does not assert a moved profile shape from a sample of ONE gated wallet', () => {
    // The condition ASSERTS a vendor-shape move, and its own message says one empty deployer is not
    // evidence of that. At --gate 1 a genuinely empty deployer satisfied `1 === 1` and exited 9
    // claiming the vendor had moved — a false alarm on the exit code a scheduler acts on.
    const alarm = feedAlarm({
      seeds: healthySeeds,
      dryStreak: 0,
      dryStreakAlarm: 3,
      gated: 1,
      unmeasured: 1,
    });
    expect(alarm.alarmed).toBe(false);
  });

  it('alarms once TWO gated wallets in a row come back unreadable', () => {
    const alarm = feedAlarm({
      seeds: healthySeeds,
      dryStreak: 0,
      dryStreakAlarm: 3,
      gated: 2,
      unmeasured: 2,
    });
    expect(alarm.alarmed).toBe(true);
    expect(alarm.reasons.join(' ')).toMatch(/ALL 2 wallet\(s\) gated this run/);
  });

  it('counts the streak over LIVE runs only', () => {
    const ledger = emptyLedger();

    appendRun(ledger, row(true, 5), 60);
    appendRun(ledger, row(true, 0), 60);
    // A dry run requested nothing, so it surfaced nothing for a reason that says nothing about the
    // population. Counting it would alarm a feed that is merely being previewed.
    appendRun(ledger, row(false, 0), 60);
    appendRun(ledger, row(true, 0), 60);
    expect(dryStreak(ledger)).toBe(2);

    appendRun(ledger, row(true, 1), 60);
    expect(dryStreak(ledger)).toBe(0);
  });

  it('an ABORTED live run does not accumulate into the dry streak', () => {
    // Two runs dying on a 429 followed by one ordinary dry run must not reach the streak alarm and
    // blame discovery breadth ("a wider source") for what was a credential or transport fault. An
    // aborted run surfaced nothing because it stopped.
    const ledger = emptyLedger();
    appendRun(ledger, row(true, 5), 60);
    appendRun(ledger, row(true, 0, false), 60);
    appendRun(ledger, row(true, 0, false), 60);
    appendRun(ledger, row(true, 0), 60);
    expect(dryStreak(ledger)).toBe(1);
  });

  it('bounds the run history so a committed ledger does not grow without limit', () => {
    const ledger = emptyLedger();
    for (let i = 0; i < 10; i++) {
      appendRun(
        ledger,
        {
          startedAtIso: `2026-08-0${i}T00:00:00.000Z`,
          live: true,
          completed: true,
          distinctWalletsSeeded: i,
          alreadyKnown: 0,
          newlySurfaced: i,
          gated: 0,
          queued: 0,
          held: 0,
          unmeasured: 0,
          prefiltered: 0,
          backlog: 0,
          keyedRequests: 3,
          inertSeeds: [],
        },
        3,
      );
    }
    expect(ledger.runs).toHaveLength(3);
    expect(ledger.runs[2]!.newlySurfaced).toBe(9);
  });
});

// ---------------------------------------------------------------------------------------------
// Triage, and the one word that keeps the cheap reading honest.

describe('a failure on the cheap reading is HELD, never rejected', () => {
  it('queues a wallet that clears the gate', () => {
    const t = triage(profile(40, 20, 200), GATE);
    expect(t.state).toBe('queued');
    expect(t.gateVerdict).toBe('gate-passed');
    expect(t.shortfalls).toEqual([]);
  });

  it('holds a wallet that misses, and keeps WHICH leg it missed', () => {
    // The shortfall list is what makes a near-miss countable. A wallet 3 launches short of the
    // sample floor on a reading that structurally under-counts launches is the most plausible false
    // negative this lane produces, and it has to be findable without re-reading every wallet.
    const t = triage(profile(22, 12, 200), GATE);
    expect(t.state).toBe('held');
    expect(t.gateVerdict).toBe('gate-failed');
    expect(t.shortfalls).toHaveLength(1);
    expect(t.shortfalls[0]).toMatch(/sample too small: 22 tokens < 25 required/);
  });

  it('holds a burst — a rate earned inside a few days is not a record', () => {
    const t = triage(profile(30, 20, 3), GATE);
    expect(t.state).toBe('held');
    expect(t.shortfalls.join(' ')).toMatch(/history spans/);
  });

  it('marks a profile with no usable record UNMEASURED, not held', () => {
    // An empty reading is the absence of an answer, not a low one. Recording it as `held` would put
    // a wallet nobody judged into the population of wallets that were judged and missed.
    const t = triage({ pump_tokens: [] }, GATE);
    expect(t.state).toBe('unmeasured');
    expect(t.gateVerdict).toBe('gate-unmeasured');
    expect(triage(null, GATE).state).toBe('unmeasured');
    expect(triage({ unexpected: 'shape' }, GATE).state).toBe('unmeasured');
  });
});

// ---------------------------------------------------------------------------------------------
// The quota bound. This lane runs forever against a shared credential.

describe('every provider call is bounded before the first one is made', () => {
  const feedT = { gateBatch: 6, maxGateBatch: 12, maxKeyedRequestsPerRun: 15 };
  const budgetT = { maxKeyedRequests: 200 };

  it('the pinned batch cap can be lowered by a flag and never raised', () => {
    expect(planFeedRun(feedT, budgetT, null, 3)).toMatchObject({ ok: true, gateBatch: 6, worstCaseKeyed: 9 });
    expect(planFeedRun(feedT, budgetT, 2, 3)).toMatchObject({ ok: true, gateBatch: 2, worstCaseKeyed: 5 });
    // A bound a flag can widen is not a bound.
    expect(planFeedRun(feedT, budgetT, 100, 3)).toMatchObject({ ok: true, gateBatch: 12, worstCaseKeyed: 15 });
  });

  it('refuses a plan that does not fit, before anything is requested', () => {
    const tight = { gateBatch: 6, maxGateBatch: 12, maxKeyedRequestsPerRun: 8 };
    const refusal = planFeedRun(tight, budgetT, 12, 3);
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.message).toMatch(/no quota was spent/);
  });

  it('never exceeds the daily allowance even at the assumed cadence', () => {
    const t = JSON.parse(readFileSync(join(TOOL_DIR, 'thresholds.json'), 'utf8')) as {
      feed: {
        gateBatch: number;
        maxGateBatch: number;
        maxKeyedRequestsPerRun: number;
        runsPerDayAssumed: number;
        dryStreakAlarm: number;
        runHistoryKept: number;
        seedLimit: number;
      };
      budget: { maxKeyedRequests: number };
    };
    // Three enumeration queries plus the batch. If a fourth seed is ever added, this fails rather
    // than quietly overrunning the per-run ceiling on the first live run.
    expect(3 + t.feed.maxGateBatch).toBeLessThanOrEqual(t.feed.maxKeyedRequestsPerRun);
    expect(t.feed.gateBatch).toBeLessThanOrEqual(t.feed.maxGateBatch);
    // The daily arithmetic, which is the whole reason this lane is allowed to run on a schedule at
    // all: a MINORITY share of the allowance, leaving the screen the majority.
    const dailyWorstCase = t.feed.maxKeyedRequestsPerRun * t.feed.runsPerDayAssumed;
    expect(dailyWorstCase).toBeLessThan(t.budget.maxKeyedRequests / 2);
    expect(t.feed.dryStreakAlarm).toBeGreaterThan(1);
    expect(t.feed.runHistoryKept).toBeGreaterThan(t.feed.runsPerDayAssumed);
    // 50 is the real cap; the vendor's own spec claims 100 and answers HTTP 400 to it.
    expect(t.feed.seedLimit).toBe(50);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end, against a stub. No network is reached by any of this.

describe('the feed end to end', () => {
  let dir: string;
  let ledgerPath: string;
  let runsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slot-zero-feed-'));
    ledgerPath = join(dir, 'ledger.json');
    runsDir = join(dir, 'runs');
    mkdirSync(runsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stub vendor. Counts every request so the ceiling can be asserted rather than assumed. */
  function vendor(
    walletsByLabel: Record<string, string[]>,
    profiles: Record<string, unknown>,
    trailingDeploys: Record<string, number> = {},
  ) {
    const calls: string[] = [];
    const deployed = (w: string) => trailingDeploys[w] ?? 20;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      const path = url.slice(url.indexOf('/api/v1') + '/api/v1'.length);
      const block = (w: string) => ({
        deployers: { wallet_address: w, total_tokens_deployed: deployed(w), total_bonded: 9 },
      });
      if (path.startsWith('/deployer-hunter/recent-bonds')) {
        return new Response(JSON.stringify({ tokens: (walletsByLabel['recent-bonds'] ?? []).map(block) }));
      }
      if (path.startsWith('/deployer-hunter/alerts')) {
        return new Response(JSON.stringify({ alerts: (walletsByLabel['alerts'] ?? []).map(block) }));
      }
      if (path.startsWith('/deployer-hunter/leaderboard')) {
        return new Response(
          JSON.stringify({
            deployers: (walletsByLabel['leaderboard'] ?? []).map((w) => ({
              wallet_address: w,
              total_tokens_deployed: deployed(w),
              total_bonded: 9,
            })),
          }),
        );
      }
      const wallet = decodeURIComponent(path.slice('/deployer-hunter/'.length));
      return new Response(JSON.stringify(profiles[wallet] ?? { pump_tokens: [] }));
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  function opts(overrides: Partial<Parameters<typeof main>[0]> = {}) {
    return {
      live: true,
      bootstrap: false,
      gate: 3,
      tier: undefined,
      ledger: ledgerPath,
      runsDir,
      out: null,
      json: false,
      dataDir: DATA_DIR,
      help: false,
      ...overrides,
    };
  }

  const env = { [KEY_ENV_VAR]: FAKE_KEY };
  const sleepImpl = async () => {};

  it('the DEFAULT path requests nothing and writes nothing', async () => {
    // A scheduled lane against a credential shared with production does not get to have its
    // spending path be the one an operator reaches by forgetting a flag.
    const parsed = parseFeedArgs([]);
    expect(parsed.ok === true && parsed.opts.live).toBe(false);

    const { calls, fetchImpl } = vendor({}, {});
    const lines: string[] = [];
    const code = await main(opts({ live: false }), env, (l) => lines.push(l), () => {}, { fetchImpl, sleepImpl });

    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(() => readFileSync(ledgerPath, 'utf8')).toThrow();
    expect(lines.join('\n')).toMatch(/DRY RUN — this is the default/);
    // The dry run's arithmetic must be the arithmetic a live run would use, or it is a guess.
    expect(lines.join('\n')).toMatch(/3 enumeration \+ up to 3 gate = 6 request\(s\)/);
  });

  it('surfaces new wallets, gates a bounded batch, and never exceeds the plan', async () => {
    const wallets = ['Wa', 'Wb', 'Wc', 'Wd', 'We'];
    const { calls, fetchImpl } = vendor(
      { 'recent-bonds': wallets, alerts: [], leaderboard: [] },
      {
        Wa: profile(40, 20, 200),
        Wb: profile(40, 20, 200),
        Wc: profile(10, 9, 200),
      },
    );
    const lines: string[] = [];
    const code = await main(opts(), env, (l) => lines.push(l), () => {}, { fetchImpl, sleepImpl });

    expect(code).toBe(0);
    // 3 enumeration + exactly the batch of 3, and not one request more.
    expect(calls).toHaveLength(6);
    expect(calls.filter((c) => /\/deployer-hunter\/W/.test(c))).toHaveLength(3);

    const ledger = loadLedger(ledgerPath) as Ledger;
    expect(Object.keys(ledger.wallets).sort()).toEqual(wallets);
    // Two were gated into the queue, one held, and two are still waiting — the backlog is explicit
    // rather than lost.
    expect(summariseLedger(ledger)).toMatchObject({ queued: 2, held: 1, deferred: 2 });
    expect(backlogDepth(ledger)).toBe(2);
    expect(lines.join('\n')).toMatch(/NEW wallets this run\s+5/);
    expect(lines.join('\n')).toMatch(/cleared the gate\s+2/);
  });

  it('the second run over the same ledger reports duplicates, not discoveries', async () => {
    const wallets = ['Wa', 'Wb', 'Wc'];
    const profiles = { Wa: profile(40, 20, 200), Wb: profile(40, 20, 200), Wc: profile(40, 20, 200) };
    const first = vendor({ 'recent-bonds': wallets }, profiles);
    await main(opts({ gate: 3 }), env, () => {}, () => {}, { fetchImpl: first.fetchImpl, sleepImpl });

    const second = vendor({ 'recent-bonds': wallets }, profiles);
    const lines: string[] = [];
    const code = await main(opts({ gate: 3 }), env, (l) => lines.push(l), () => {}, {
      fetchImpl: second.fetchImpl,
      sleepImpl,
    });

    expect(code).toBe(0);
    // Enumeration still costs 3. Gating costs NOTHING, because every wallet is already graded —
    // which is the quota saving the memory buys, stated as a number.
    expect(second.calls).toHaveLength(3);
    const text = lines.join('\n');
    expect(text).toMatch(/NEW wallets this run\s+0\s+<< none\. This run discovered nothing\./);
    expect(text).toMatch(/already known \(duplicates\) 3 of 3 surfaced/);
  });

  it("the cadence filter's reported cost counts only wallets the gate could still have spent on", async () => {
    // The vendor re-serves the same pages every run, so an already-graded wallet reappearing below
    // the floor would otherwise be counted as a request the filter denied — every run, forever.
    const profiles = { Wa: profile(40, 20, 200) };
    const first = vendor({ 'recent-bonds': ['Wa'] }, profiles);
    await main(opts({ gate: 1 }), env, () => {}, () => {}, { fetchImpl: first.fetchImpl, sleepImpl });
    expect(loadLedger(ledgerPath).wallets['Wa']!.state).toBe('queued');

    // Quiet week: Wa's trailing count drops below the floor. Wb is new and also below it.
    const second = vendor({ 'recent-bonds': ['Wa', 'Wb'] }, profiles, { Wa: 1, Wb: 1 });
    const outPath = join(dir, 'feed-run.json');
    await main(opts({ gate: 1, out: outPath, json: true }), env, () => {}, () => {}, {
      fetchImpl: second.fetchImpl,
      sleepImpl,
    });

    const record = JSON.parse(readFileSync(outPath, 'utf8')) as {
      cadenceFilter: { skipped: number; skippedAndNew: number };
    };
    expect(record.cadenceFilter.skipped).toBe(1);
    expect(record.cadenceFilter.skippedAndNew).toBe(1);
    // And the grade is untouched: the pre-filter never downgrades a wallet we already paid for.
    expect(loadLedger(ledgerPath).wallets['Wa']!.state).toBe('queued');
  });

  it('exits 9 once the dry streak is reached — a scheduler must not read it as a quiet day', async () => {
    const wallets = ['Wa'];
    const profiles = { Wa: profile(40, 20, 200) };
    for (let run = 0; run < 3; run++) {
      const v = vendor({ 'recent-bonds': wallets }, profiles);
      const code = await main(opts({ gate: 1 }), env, () => {}, () => {}, { fetchImpl: v.fetchImpl, sleepImpl });
      // Run 0 discovers Wa. Runs 1 and 2 are dry, which is still tolerable at an alarm of 3.
      expect(code).toBe(0);
    }
    const v = vendor({ 'recent-bonds': wallets }, profiles);
    const lines: string[] = [];
    const code = await main(opts({ gate: 1 }), env, (l) => lines.push(l), () => {}, {
      fetchImpl: v.fetchImpl,
      sleepImpl,
    });
    expect(code).toBe(9);
    expect(lines.join('\n')).toMatch(/THE FEED IS NOT HEALTHY/);
    expect(lines.join('\n')).toMatch(/DRY: 3 consecutive live run/);
  });

  it('exits 9 on the FIRST run whose seeds serve rows we read no wallet from', async () => {
    const fetchImpl = (async () =>
      // Rows present, wallets zero. This is the vendor answering and our reader failing.
      new Response(JSON.stringify({ tokens: [{ nothing: 'we recognise' }] }))) as unknown as typeof fetch;
    const lines: string[] = [];
    const code = await main(opts(), env, (l) => lines.push(l), () => {}, { fetchImpl, sleepImpl });
    expect(code).toBe(9);
    expect(lines.join('\n')).toMatch(/OUR READER IS WRONG/);
  });

  it('writes a record whose yield accounting adds up, and persists no per-token vendor data', async () => {
    const outPath = join(dir, 'feed-run.json');
    const { fetchImpl } = vendor(
      { 'recent-bonds': ['Wa', 'Wb'], alerts: ['Wb', 'Wc'] },
      { Wa: profile(40, 20, 200), Wb: profile(10, 9, 200), Wc: profile(40, 20, 200) },
    );
    const code = await main(opts({ gate: 3, out: outPath, json: true }), env, () => {}, () => {}, {
      fetchImpl,
      sleepImpl,
    });
    expect(code).toBe(0);

    const record = JSON.parse(readFileSync(outPath, 'utf8')) as {
      yield: Record<string, number>;
      seeds: { label: string; newWallets: number }[];
      spend: Record<string, number>;
      discoveryLag: { medianDaysAtLeast: number | null; observations: number };
      cadenceFilter: { skipped: number; floor: number };
      queue: { wallet: string }[];
      limitations: string[];
      keylessRequests: number;
    };

    expect(record.yield.distinctWalletsSeeded).toBe(3);
    expect(record.yield.newlySurfaced).toBe(3);
    expect(record.yield.alreadyKnown).toBe(0);
    expect(record.yield.gated).toBe(3);
    expect(record.yield.clearedTheGate! + record.yield.held! + record.yield.unmeasured!).toBe(record.yield.gated);
    expect(record.yield.backlog).toBe(0);
    // A wallet two seeds both surfaced is new under both, so per-seed novelty does not sum to the
    // run total — the rendered block says so and the record must be consistent with it.
    expect(record.seeds.reduce((a, s) => a + s.newWallets, 0)).toBeGreaterThanOrEqual(record.yield.newlySurfaced!);
    // This lane spends no keyless request at all.
    expect(record.keylessRequests).toBe(0);
    expect(record.spend.plannedWorstCaseKeyed).toBe(6);
    expect(record.spend.assumedDailyWorstCaseKeyed).toBe(record.spend.plannedWorstCaseKeyed! * record.spend.assumedRunsPerDay!);
    expect(record.discoveryLag.observations).toBe(3);
    expect(record.discoveryLag.medianDaysAtLeast).toBeGreaterThan(0);
    expect(record.cadenceFilter.floor).toBeGreaterThan(0);
    expect(record.queue.map((q) => q.wallet).sort()).toEqual(['Wa', 'Wc']);
    expect(record.limitations).toEqual(FEED_LIMITATIONS);

    const FORBIDDEN = /"(mint|token_name|token_symbol|peak_market_cap|created_timestamp|pump_tokens)"/;
    expect(FORBIDDEN.test(readFileSync(outPath, 'utf8'))).toBe(false);
  });

  it('a run that dies mid-flight still persists what it paid for, and exits non-zero', async () => {
    // A ceiling hit or a 500 after two profiles must not discard those two: re-learning them spends
    // the shared allowance a second time to reach the same answer.
    let n = 0;
    const { fetchImpl: good } = vendor(
      { 'recent-bonds': ['Wa', 'Wb', 'Wc'] },
      { Wa: profile(40, 20, 200), Wb: profile(40, 20, 200), Wc: profile(40, 20, 200) },
    );
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      n += 1;
      // 3 enumeration + one profile, then the vendor breaks.
      if (n > 4) return new Response('upstream on fire', { status: 500 });
      return good(input, init);
    }) as unknown as typeof fetch;

    const errs: string[] = [];
    const code = await main(opts({ gate: 3 }), env, () => {}, (l) => errs.push(l), { fetchImpl, sleepImpl });
    expect(code).toBe(7);

    const ledger = loadLedger(ledgerPath) as Ledger;
    // All three were recorded as seen — so none is offered as new again — and the one that was
    // gated before the failure kept its grade.
    expect(Object.keys(ledger.wallets).sort()).toEqual(['Wa', 'Wb', 'Wc']);
    expect(summariseLedger(ledger).queued).toBe(1);
    expect(backlogDepth(ledger)).toBe(2);
    expect(errs.join('\n')).toMatch(/500/);
  });

  it('an incomplete run writes to <out>.partial.json and leaves a good record untouched', async () => {
    const outPath = join(dir, 'feed-run.json');
    writeFileSync(outPath, '{"kept":true}\n', 'utf8');
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const code = await main(opts({ out: outPath }), env, () => {}, () => {}, { fetchImpl, sleepImpl });
    expect(code).toBe(7);
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual({ kept: true });
    expect(JSON.parse(readFileSync(join(dir, 'feed-run.partial.json'), 'utf8'))).toMatchObject({ completed: false });
  });

  it('refuses to run without a credential, and says it is NOT a dry feed', async () => {
    const { calls, fetchImpl } = vendor({}, {});
    const errs: string[] = [];
    const code = await main(opts(), {}, () => {}, (l) => errs.push(l), { fetchImpl, sleepImpl });
    expect(code).toBe(3);
    expect(calls).toHaveLength(0);
    expect(errs.join('\n')).toMatch(/NOT a dry feed/);
  });

  it('bootstrap writes the ledger from run records and requests nothing', async () => {
    writeFileSync(
      join(runsDir, 'a.json'),
      JSON.stringify({ startedAtIso: '2026-08-02T00:00:00.000Z', candidates: [{ wallet: 'Wz', verdict: 'gate-passed' }] }),
      'utf8',
    );
    const { calls, fetchImpl } = vendor({}, {});
    const code = await main(opts({ bootstrap: true, live: false }), env, () => {}, () => {}, { fetchImpl, sleepImpl });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(Object.keys((loadLedger(ledgerPath) as Ledger).wallets)).toEqual(['Wz']);
  });

  it('refuses an unreadable ledger rather than silently starting over', async () => {
    // Starting over would re-offer every known wallet as new and spend the shared allowance
    // re-grading them, which is the one failure the memory exists to prevent.
    writeFileSync(ledgerPath, 'not json', 'utf8');
    const { calls, fetchImpl } = vendor({}, {});
    const errs: string[] = [];
    const code = await main(opts(), env, () => {}, (l) => errs.push(l), { fetchImpl, sleepImpl });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(errs.join('\n')).toMatch(/Refusing to start over/);
  });

  it('refuses a ledger from a schema it does not know', async () => {
    writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: 99, wallets: {}, runs: [] }), 'utf8');
    const errs: string[] = [];
    const code = await main(opts(), env, () => {}, (l) => errs.push(l), { sleepImpl });
    expect(code).toBe(2);
    expect(errs.join('\n')).toMatch(/never retro-fitted/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the lane states the ceiling it cannot see past', () => {
  it('every run prints that discovery is vendor-selected and the lag is a lower bound', () => {
    const text = FEED_LIMITATIONS.join(' ');
    expect(text).toMatch(/DISCOVERY IS ENTIRELY VENDOR-SELECTED/);
    expect(text).toMatch(/INVISIBLE here/);
    expect(text).toMatch(/LOWER BOUND/);
    expect(text).toMatch(/CADENCE FILTER/);
    expect(text).toMatch(/BIASED TOWARDS REJECTION/);
  });

  it('FEED.md owns the long form and does not overclaim coverage', () => {
    const doc = readFileSync(join(TOOL_DIR, 'FEED.md'), 'utf8');
    expect(doc).toMatch(/vendor-selected/i);
    expect(doc).toMatch(/discovery lag/i);
    // The per-run call budget has to be in the document, not only in the code: this is the number a
    // reviewer of the schedule reads.
    expect(doc).toMatch(/3 enumeration/);
    expect(doc).toMatch(/never re-polled|not re-polled/i);
  });

  it('wraps its prose so the caveats are readable rather than running off the edge', () => {
    const lines = wrap(FEED_LIMITATIONS[0]!, 90);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(90);
    expect(lines.join(' ')).toBe(FEED_LIMITATIONS[0]!.replace(/\s+/g, ' '));
  });

  it('discovery lag is measured from first sight, not from now', () => {
    // Computing it against the clock would grow every historical wallet's lag by a day for every day
    // that passes, turning a fixed observation into a drifting one.
    expect(discoveryLagDays(T0, new Date(T0 - 10 * DAY).toISOString())).toBe(10);
    expect(discoveryLagDays(T0, null)).toBeNull();
    expect(discoveryLagDays(T0, 'not a date')).toBeNull();
  });

  it('a saved ledger round-trips and is written in a stable key order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-zero-ledger-'));
    try {
      const path = join(dir, 'l.json');
      const ledger = emptyLedger();
      for (const w of ['Wz', 'Wa', 'Wm']) recordSeen(ledger, w, [], '2026-08-02T00:00:00.000Z');
      saveLedger(path, ledger, '2026-08-02T00:00:00.000Z');
      const text = readFileSync(path, 'utf8');
      expect(text.indexOf('"Wa"')).toBeLessThan(text.indexOf('"Wm"'));
      expect(text.indexOf('"Wm"')).toBeLessThan(text.indexOf('"Wz"'));
      expect(Object.keys((loadLedger(path) as Ledger).wallets)).toEqual(['Wa', 'Wm', 'Wz']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing ledger is a first run, not an error', () => {
    expect(loadLedger(join(tmpdir(), 'definitely-not-here-slot-zero.json')).wallets).toEqual({});
  });

  it('--bootstrap and --live are refused together', () => {
    const parsed = parseFeedArgs(['--bootstrap', '--live']);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/contradictory/);
  });

  it('rejects flag values the shared bounds depend on', () => {
    expect(parseFeedArgs(['--gate', '0']).ok).toBe(false);
    expect(parseFeedArgs(['--gate', 'many']).ok).toBe(false);
    expect(parseFeedArgs(['--tier', 'platinum']).ok).toBe(false);
    expect(parseFeedArgs(['--nope']).ok).toBe(false);
    expect(parseFeedArgs(['--tier', 'elite', '--gate', '4', '--live']).ok).toBe(true);
  });
});
