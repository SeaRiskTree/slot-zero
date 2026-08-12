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

import { POPULATION_TAPE_DIR } from '../config/data-root.mjs';
import { MADEONSOL_DAILY_REQUESTS } from '../tools/deployer-screen/client.mjs';
import {
  ALL_UNMEASURED_MIN_GATED,
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
import {
  FEED_LIMITATIONS,
  FEED_RECORD_SCHEMA_VERSION,
  main,
  parseFeedArgs,
  planFeedRun,
  renderLedgerState,
  triage,
  unmeasuredAlarmDisabledWarning,
  wrap,
} from '../tools/deployer-screen/feed.mjs';
import { subGateBounds } from '../tools/deployer-screen/admission.mjs';
import { KEY_ENV_VAR } from '../tools/deployer-screen/credential.mjs';

const TOOL_DIR = fileURLToPath(new URL('../tools/deployer-screen/', import.meta.url));
const COMMITTED_LEDGER = join(TOOL_DIR, 'feed', 'ledger.json');
const RUNS_DIR = join(TOOL_DIR, 'runs');
const DATA_DIR = POPULATION_TAPE_DIR;

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
    // Schema-451's second arm. Present on every FeedRunRow; these fixtures stand for runs that
    // admitted nobody through it.
    queuedSubGate: 0,
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

  it('says out loud that the unreadable-profile alarm cannot fire below the floor', () => {
    // At a batch of 1 the condition is not merely slow, it is unsatisfiable — and nothing else
    // covers it, because a shape move leaves enumeration healthy and the dry streak never
    // accumulates. The floor stays at 2; the configuration is what has to be audible.
    expect(unmeasuredAlarmDisabledWarning(1)).toMatch(/ALARM DISABLED AT THIS SETTING/);
    expect(unmeasuredAlarmDisabledWarning(1)).toMatch(/CANNOT fire/);
    expect(unmeasuredAlarmDisabledWarning(ALL_UNMEASURED_MIN_GATED)).toBeNull();
    expect(unmeasuredAlarmDisabledWarning(6)).toBeNull();
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
    expect(alarm.reasons.join(' ')).toMatch(/no readable launch record/);
    expect(alarm.reasons.join(' ')).toMatch(/profile shape having moved/);
  });

  it('does not claim "no readable launch record" when the wallets plainly had them', () => {
    // Captain decision 352b routes a wallet to unmeasured whenever the completion criterion could
    // not be read on PART of its history, so a profile with 29 readable records and one missing
    // `complete` now reaches this alarm. Claiming it carried nothing readable — and sending the
    // operator to `toTokenRecords` or to a wider source — is wrong on both counts, and the feed run
    // record is never retro-edited. The TRIGGER is unchanged; only the claim is.
    const all = feedAlarm({
      seeds: healthySeeds,
      dryStreak: 0,
      dryStreakAlarm: 3,
      gated: 3,
      unmeasured: 3,
      unmeasuredWithRecords: 3,
    });
    expect(all.alarmed).toBe(true);
    const allText = all.reasons.join(' ');
    expect(allText).toMatch(/DID carry launch records that parsed/);
    expect(allText).toMatch(/completion criterion \(RAISE-85/);
    expect(allText).toMatch(/'complete'/);
    expect(allText).not.toMatch(/came back with no readable launch record/);
    expect(allText).not.toMatch(/profile shape having moved/);

    // Mixed: both faults are named and neither count is overstated.
    const mixed = feedAlarm({
      seeds: healthySeeds,
      dryStreak: 0,
      dryStreakAlarm: 3,
      gated: 5,
      unmeasured: 5,
      unmeasuredWithRecords: 2,
    });
    const mixedText = mixed.reasons.join(' ');
    expect(mixedText).toMatch(/2 DID carry launch records that parsed/);
    expect(mixedText).toMatch(/other 3 carried no readable launch record at all/);
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
          queuedSubGate: 0,
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

  it('a partly-unreadable profile is UNMEASURED, never HELD on the count bars', () => {
    // 352b option B, on the leg where a wrong answer is permanent: `held` files the wallet in
    // feed/ledger.json and it is never offered as new again. 30 vendor rows, 6 of them carrying no
    // readable `complete` field, leaves 24 against a minTokens of 25 — a rejection produced by our
    // own coverage rather than by anything in the deployer's record.
    const readable = profile(24, 10, 160).pump_tokens;
    const unreadable = Array.from({ length: 6 }, (_, i) => ({
      created_timestamp: T0 - DAY + (i + 1) * DAY,
    }));
    const t = triage({ pump_tokens: [...readable, ...unreadable] }, GATE);
    expect(t.completion.tokens).toBe(24);
    expect(t.completion.criterionUnreadable).toBe(6);
    expect(t.state).toBe('unmeasured');
    expect(t.gateVerdict).toBe('gate-unmeasured');
    expect(t.rationale).toMatch(/could not be read on 6 of the launch\(es\)/);

    // The same page with every `complete` readable is still triaged the ordinary way.
    const allReadable = triage(profile(30, 12, 160), GATE);
    expect(allReadable.completion.criterionUnreadable).toBe(0);
    expect(allReadable.state).toBe('queued');
  });

  it('names the exclusion that actually emptied the reading, not the deploy time', () => {
    // Captain decision 352b: a missing or malformed `complete` field folds to UNREADABLE, so a
    // profile whose rows all carry a perfectly usable `created_timestamp` can still reach zero
    // tokens through the criterion. The rationale is persisted in the feed run record and this
    // repo never retro-edits one, so blaming the deploy time there is permanently wrong and sends
    // an operator looking for a gap that is not there.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      created_timestamp: T0 - DAY - (29 - i) * 5 * DAY,
    }));
    const t = triage({ pump_tokens: rows }, GATE);
    expect(t.state).toBe('unmeasured');
    expect(t.gateVerdict).toBe('gate-unmeasured');
    expect(t.completion.tokens).toBe(0);
    expect(t.completion.droppedNoTimestamp).toBe(0);
    expect(t.completion.criterionUnreadable).toBe(30);
    expect(t.rationale).toMatch(/completion criterion could not be read/);
    expect(t.rationale).toMatch(/RAISE-85/);
    expect(t.rationale).toMatch(/30/);
    expect(t.rationale).not.toMatch(/no launch record with a usable deploy time/);
    expect(t.rationale).not.toMatch(/carried no usable deploy time/);

    // And the deploy-time cause is still named where it IS the cause.
    const noTimes = triage({ pump_tokens: [{ complete: true }, { complete: false }] }, GATE);
    expect(noTimes.state).toBe('unmeasured');
    expect(noTimes.completion.droppedNoTimestamp).toBe(2);
    expect(noTimes.rationale).toMatch(/2 carried no usable deploy time/);
    expect(noTimes.rationale).not.toMatch(/completion criterion/);
  });

  it('states the criterion count ONCE in a persisted rationale, as the gate reasons do', () => {
    // The house rule, third application: `verdictFor`'s own branch names the criterion count, so
    // triage's `notMeasured` entry may not restate it. These rationales are persisted in the feed
    // run record and this repo never retro-edits one.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      created_timestamp: T0 - DAY - (29 - i) * 5 * DAY,
    }));
    const t = triage({ pump_tokens: rows }, GATE);
    expect(t.state).toBe('unmeasured');
    expect(t.rationale.match(/completion criterion/g) ?? []).toHaveLength(1);
    expect(t.rationale.match(/30/g) ?? []).toHaveLength(1);
    expect(t.rationale).not.toMatch(/The reading was also incomplete/);

    // A cause the verdict does NOT state still travels: deploy time beside an unreadable criterion.
    const mixed = triage(
      { pump_tokens: [...rows, { complete: true }, { complete: false }] },
      GATE,
    );
    expect(mixed.completion.droppedNoTimestamp).toBe(2);
    expect(mixed.state).toBe('unmeasured');
    expect(mixed.rationale).toMatch(/2 carried no usable deploy time/);
    expect(mixed.rationale.match(/completion criterion/g) ?? []).toHaveLength(1);
    // ...and it travels as an ADDITIONAL cause, never as the emptying one. 30 more launches left
    // through the criterion, so "the gate was left no launch record to read: 2 carried no usable
    // deploy time" would assert a complete cause the counts do not support.
    expect(mixed.rationale).toMatch(/a further 2 carried no usable deploy time/);
    expect(mixed.rationale).not.toMatch(/left no launch record to read: 2 carried/);
    // The deploy-time-only case still states it as the cause, because there it is one.
    const noTimesOnly = triage({ pump_tokens: [{ complete: true }, { complete: false }] }, GATE);
    expect(noTimesOnly.rationale).toMatch(/left no launch record to read: 2 carried/);

    // And an empty profile is STILL unmeasured — the entry that produces that state is not
    // suppressed, because no other branch would fire.
    expect(triage({ pump_tokens: [] }, GATE).state).toBe('unmeasured');
    expect(triage({ pump_tokens: [] }, GATE).rationale).toMatch(/no launch record at all/);
  });
});

// ---------------------------------------------------------------------------------------------
// Captain decision 451's second arm, on the half whose failure mode is permanent: `ledger.mjs`
// grades a wallet ONCE and never offers it again, so a sub-gate deployer wrongly filed as `held`
// here is unrecoverable and invisible. Everything below drives the real functions; nothing is
// asserted by reading source.

describe('451: the second admission arm reaches the discovery feed', () => {
  const T = JSON.parse(readFileSync(join(TOOL_DIR, 'thresholds.json'), 'utf8')) as {
    stage1_gate: {
      minTokens: number;
      minCompletionRate: number;
      minSpanDays: number;
      subGateAdmission: { minCompletionRate: number; visitRefreshDays: number };
    };
    stage2_entry: { maxLaunchesPerCandidate: number };
  };
  const BOUNDS = subGateBounds(T.stage1_gate, T.stage2_entry.maxLaunchesPerCandidate);
  const REAL_GATE = {
    minTokens: T.stage1_gate.minTokens,
    minCompletionRate: T.stage1_gate.minCompletionRate,
    minSpanDays: T.stage1_gate.minSpanDays,
  };
  const NOW = T0;
  const ARM = { bounds: BOUNDS, nowMs: NOW };

  /**
   * A wallet whose rate sits strictly between the arm's inflow floor and the gate's bar, launching
   * often enough to fill one Stage 2 visit inside the refresh horizon and still launching today —
   * so the ONLY thing between it and the queue is captain decision 451.
   */
  const subGateProfile = () => profile(40, 4, 60, NOW);

  it('queues a sub-gate wallet in ITS OWN state, and holds the same wallet when the arm is not asked', () => {
    const rate = 4 / 40;
    expect(rate).toBeLessThan(T.stage1_gate.minCompletionRate);
    expect(rate).toBeGreaterThanOrEqual(T.stage1_gate.subGateAdmission.minCompletionRate);

    const admitted = triage(subGateProfile(), REAL_GATE, ARM);
    expect(admitted.state).toBe('queued-sub-gate');
    expect(admitted.gateVerdict).toBe('sub-gate-admitted');
    expect(admitted.rationale).toMatch(/FAILED the competence gate/);

    // THE PRE-451 BEHAVIOUR IS STILL REACHABLE, and it is the same code path with the arm absent —
    // not a second implementation that could drift from this one.
    const notAsked = triage(subGateProfile(), REAL_GATE);
    expect(notAsked.state).toBe('held');
    expect(notAsked.gateVerdict).toBe('gate-failed');

    // The arm is a LOOSENING and not a bypass: a wallet failing on anything but the rate is still
    // held, whether or not the arm is consulted.
    expect(triage(profile(10, 1, 60, NOW), REAL_GATE, ARM).state).toBe('held');
    expect(triage(profile(40, 4, 3, NOW), REAL_GATE, ARM).state).toBe('held');
    // And a wallet that has stopped launching is refused on the arm's own window-supply bound.
    expect(triage(profile(40, 4, 60, NOW - 400 * DAY), REAL_GATE, ARM).state).toBe('held');
  });

  it('counts the two arms APART and serves both to the screen', () => {
    const ledger = emptyLedger();
    const grade = (
      wallet: string,
      state: 'queued' | 'queued-sub-gate' | 'held',
      verdict: string,
      at: string,
    ) => {
      recordSeen(ledger, wallet, ['alerts'], at);
      gradeWallet(
        ledger,
        wallet,
        {
          state,
          gateVerdict: verdict,
          gateReading: 'ownership-only',
          tokens: 40,
          completionRate: state === 'queued' ? 0.5 : 0.1,
          spanDays: 60,
          firstDeployIso: '2026-06-01T00:00:00.000Z',
          shortfalls: [],
        },
        at,
      );
    };
    grade('GATE_A', 'queued', 'gate-passed', '2026-08-01T00:00:00.000Z');
    grade('SUB_A', 'queued-sub-gate', 'sub-gate-admitted', '2026-08-02T00:00:00.000Z');
    grade('SUB_B', 'queued-sub-gate', 'sub-gate-admitted', '2026-08-03T00:00:00.000Z');
    grade('HELD_A', 'held', 'gate-failed', '2026-08-04T00:00:00.000Z');

    const s = summariseLedger(ledger);
    expect(s.queued).toBe(1);
    expect(s.queuedSubGate).toBe(2);
    expect(s.queuedUnscreened).toBe(1);
    expect(s.queuedSubGateUnscreened).toBe(2);
    expect(s.held).toBe(1);
    expect(s.wallets).toBe(4);
    // THE ACCEPTANCE CRITERION: no figure this summary publishes is the two arms added together.
    const pooled = s.queued + s.queuedSubGate;
    for (const [key, value] of Object.entries(s)) {
      if (typeof value !== 'number') continue;
      expect(value, `${key} reads as the two arms pooled`).not.toBe(pooled);
    }

    // The QUEUE is a spend decision rather than a statistic, so it serves both — oldest first, and
    // every row still carries the state that says which arm put it there.
    const queue = queuedForScreen(ledger);
    expect(queue.map((e) => e.wallet)).toEqual(['GATE_A', 'SUB_A', 'SUB_B']);
    expect(queue.map((e) => e.state)).toEqual(['queued', 'queued-sub-gate', 'queued-sub-gate']);

    // And the rendered state prints the second arm on its own line, with its own denominator.
    const text = renderLedgerState(ledger);
    expect(text).toMatch(/1 cleared the gate and have not been through the beatability screen/);
    expect(text).toMatch(/2 FAILED the gate and are queued anyway by the sub-gate arm/);
    expect(text).toMatch(/never pooled with the line above/);
    expect(text).not.toMatch(/3 cleared the gate/);
  });

  it('imports a committed sub-gate verdict as queued, never as unmeasured', () => {
    // A record carrying `sub-gate-admitted` describes a wallet the screen MEASURED. Folding it into
    // `unmeasured` would file an admitted wallet as unjudged and drop it out of the queue.
    const ledger = emptyLedger();
    const { imported } = importRunRecords(ledger, [
      {
        file: 'r.json',
        body: {
          startedAtIso: '2026-08-11T00:00:00.000Z',
          schemaVersion: 26,
          candidates: [
            { wallet: 'PASSED', verdict: 'gate-passed', tokens: 61, completionRate: 0.54, spanDays: 581 },
            { wallet: 'SUBGATE', verdict: 'sub-gate-admitted', tokens: 40, completionRate: 0.1, spanDays: 60 },
            { wallet: 'FAILED', verdict: 'gate-failed', tokens: 14 },
          ],
        },
      },
    ]);
    expect(imported).toBe(3);
    expect(ledger.wallets['SUBGATE']!.state).toBe('queued-sub-gate');
    expect(ledger.wallets['SUBGATE']!.gateVerdict).toBe('sub-gate-admitted');
    expect(ledger.wallets['PASSED']!.state).toBe('queued');
    expect(ledger.wallets['FAILED']!.state).toBe('held');
    expect(queuedForScreen(ledger).map((e) => e.wallet).sort()).toEqual(['PASSED', 'SUBGATE']);
    expect(summariseLedger(ledger)).toMatchObject({ queued: 1, queuedSubGate: 1, unmeasured: 0 });
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
    expect(lines.join('\n')).toMatch(/6 enumeration \+ up to 3 gate = 9 request\(s\)/);
    // The daily share is printed against the VENDOR'S DAY, not against budget.maxKeyedRequests.
    // It read the latter until captain decision 267a, which was right only while that ceiling
    // happened to BE the daily allowance; at Ultra it is a per-run ceiling of 402 and a share
    // computed against it would understate this lane's headroom by ~250x while looking authoritative.
    expect(lines.join('\n')).toMatch(/= 54 of the 100,000\/day allowance \(0\.054%/);
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
    // 6 enumeration (three endpoints x the two default tiers) + exactly the batch of 3, and not
    // one request more.
    expect(calls).toHaveLength(9);
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
    // Enumeration still costs 6. Gating costs NOTHING, because every wallet is already graded —
    // which is the quota saving the memory buys, stated as a number.
    expect(second.calls).toHaveLength(6);
    const text = lines.join('\n');
    expect(text).toMatch(/NEW wallets this run\s+0\s+<< none\. This run discovered nothing\./);
    expect(text).toMatch(/already known \(duplicates\) 3 of 3 surfaced/);
  });

  it('warns on BOTH the dry and the live path when the batch is too small to arm the alarm', async () => {
    // The dry run is the default and is where an operator reads what a setting will do, so a
    // warning only on the live path would be seen last rather than first.
    const dry = vendor({ 'recent-bonds': ['Wa'] }, { Wa: profile(40, 20, 200) });
    const dryLines: string[] = [];
    await main(opts({ live: false, gate: 1 }), env, (l) => dryLines.push(l), () => {}, {
      fetchImpl: dry.fetchImpl,
      sleepImpl,
    });
    expect(dryLines.join('\n')).toMatch(/ALARM DISABLED AT THIS SETTING/);

    const live = vendor({ 'recent-bonds': ['Wa'] }, { Wa: profile(40, 20, 200) });
    const liveLines: string[] = [];
    await main(opts({ gate: 1 }), env, (l) => liveLines.push(l), () => {}, {
      fetchImpl: live.fetchImpl,
      sleepImpl,
    });
    expect(liveLines.join('\n')).toMatch(/ALARM DISABLED AT THIS SETTING/);

    // Armed at the floor, so the warning must be gone rather than merely quieter.
    const armed = vendor({ 'recent-bonds': ['Wb', 'Wc'] }, { Wb: profile(40, 20, 200), Wc: profile(40, 20, 200) });
    const armedLines: string[] = [];
    await main(opts({ gate: 2 }), env, (l) => armedLines.push(l), () => {}, {
      fetchImpl: armed.fetchImpl,
      sleepImpl,
    });
    expect(armedLines.join('\n')).not.toMatch(/ALARM DISABLED/);
  });

  it('records whether the unreadable-profile alarm was armed, in BOTH states', async () => {
    // --json and a saved --out record are what a scheduler reads, and the rendered warning never
    // reaches either. Without this marker an `alarmed: false` from a batch below the floor is
    // indistinguishable there from one that actually had the alarm armed.
    const disarmedPath = join(dir, 'disarmed.json');
    const one = vendor({ 'recent-bonds': ['Wa'] }, { Wa: profile(40, 20, 200) });
    await main(opts({ gate: 1, out: disarmedPath, json: true }), env, () => {}, () => {}, {
      fetchImpl: one.fetchImpl,
      sleepImpl,
    });

    const armedPath = join(dir, 'armed.json');
    const two = vendor({ 'recent-bonds': ['Wb', 'Wc'] }, { Wb: profile(40, 20, 200), Wc: profile(40, 20, 200) });
    await main(opts({ gate: 2, out: armedPath, json: true }), env, () => {}, () => {}, {
      fetchImpl: two.fetchImpl,
      sleepImpl,
    });

    const read = (p: string) =>
      JSON.parse(readFileSync(p, 'utf8')) as {
        schemaVersion: number;
        alarm: { alarmed: boolean; unmeasuredConditionArmed: boolean };
        spend: { gateBatch: number };
      };
    expect(read(disarmedPath).alarm.unmeasuredConditionArmed).toBe(false);
    expect(read(armedPath).alarm.unmeasuredConditionArmed).toBe(true);
    // A reader with no version cannot tell a disarmed run from a record written before the field.
    expect(read(disarmedPath).schemaVersion).toBe(FEED_RECORD_SCHEMA_VERSION);
    expect(FEED_RECORD_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('blames the vendor field, not our parser, when every profile parsed and no `complete` did', async () => {
    // The scenario FEED.md, README.md and `competenceCriterionIncomplete` all name as the tell: the
    // vendor stops serving `complete`, so every deployer's whole readable history is
    // criterion-unreadable and lands at `tokens === 0`. The rows PARSED and the deploy times were
    // fine, so blaming `toTokenRecords` or a wider source sends an operator to the wrong place —
    // and the alarm reason is persisted in the feed run record, which is never retro-edited.
    const noFlag = (n: number) => ({
      pump_tokens: Array.from({ length: n }, (_, i) => ({
        created_timestamp: T0 - DAY - (n - 1 - i) * 5 * DAY,
      })),
    });
    const outPath = join(dir, 'criterion.json');
    const { fetchImpl } = vendor(
      { 'recent-bonds': ['Wa', 'Wb'] },
      { Wa: noFlag(30), Wb: noFlag(30) },
    );
    const code = await main(opts({ gate: 2, out: outPath, json: true }), env, () => {}, () => {}, {
      fetchImpl,
      sleepImpl,
    });

    // The TRIGGER is unchanged: every gated wallet unmeasured still exits 9.
    expect(code).toBe(9);
    const record = JSON.parse(readFileSync(outPath, 'utf8')) as {
      alarm: { alarmed: boolean; reasons: string[] };
    };
    expect(record.alarm.alarmed).toBe(true);
    const text = record.alarm.reasons.join(' ');
    expect(text).toMatch(/DID carry launch records that parsed/);
    expect(text).toMatch(/'complete'/);
    expect(text).not.toMatch(/came back with no readable launch record/);
    expect(text).not.toMatch(/profile shape having moved/);
    expect(text).not.toMatch(/toTokenRecords/);
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
    expect(record.spend.plannedWorstCaseKeyed).toBe(9);
    expect(record.spend.assumedDailyWorstCaseKeyed).toBe(record.spend.plannedWorstCaseKeyed! * record.spend.assumedRunsPerDay!);
    expect(record.spend.dailyAllowance).toBe(MADEONSOL_DAILY_REQUESTS);
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
      // 6 enumeration (three endpoints x the two default tiers) + one profile, then the vendor
      // breaks. It must break AFTER enumeration, or nothing is ever recorded as seen.
      if (n > 7) return new Response('upstream on fire', { status: 500 });
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

  it('the run loop asks the second arm, so a sub-gate wallet is queued rather than held forever', async () => {
    // THE CLAUSE `triage`'s OWN DOC MAKES, ASSERTED THROUGH THE RUN LOOP: the arm is passed on every
    // gated wallet. Dropping the argument would restore the pre-451 behaviour silently, and this
    // lane's mistakes are permanent — `ledger.mjs` grades a wallet once and never offers it again.
    // The profile is anchored on the run's own clock rather than on a fixture date, because the
    // arm's recency bound is measured against `Date.now()` inside `main`.
    const now = Date.now();
    const { fetchImpl } = vendor(
      { 'recent-bonds': ['Wsub', 'Wgate'], alerts: [], leaderboard: [] },
      // 4 of 40 bonded = 0.10: below the gate's 0.25 and above the arm's 0.05 floor, over a 60-day
      // span that fills a Stage 2 visit inside the refresh horizon.
      { Wsub: profile(40, 4, 60, now), Wgate: profile(40, 20, 60, now) },
    );
    const lines: string[] = [];
    const code = await main(opts(), env, (l) => lines.push(l), () => {}, { fetchImpl, sleepImpl });

    expect(code).toBe(0);
    const ledger = loadLedger(ledgerPath) as Ledger;
    expect(ledger.wallets['Wsub']!.state).toBe('queued-sub-gate');
    expect(ledger.wallets['Wsub']!.gateVerdict).toBe('sub-gate-admitted');
    expect(ledger.wallets['Wgate']!.state).toBe('queued');
    // Both are the feed's product, and the run reports them as two populations rather than one.
    expect(queuedForScreen(ledger).map((e) => e.wallet).sort()).toEqual(['Wgate', 'Wsub']);
    expect(summariseLedger(ledger)).toMatchObject({ queued: 1, queuedSubGate: 1, held: 0 });
    const run = ledger.runs[ledger.runs.length - 1]!;
    expect(run.queued).toBe(1);
    expect(run.queuedSubGate).toBe(1);
    expect(lines.join('\n')).toMatch(/FAILED the gate and are queued anyway by the sub-gate arm/);
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
    // reviewer of the schedule reads. It is 6 since captain decision 262a made the seeding tiered.
    expect(doc).toMatch(/6 enumeration/);
    // And the daily share has to be stated against the VENDOR'S day. The document said "~200/day"
    // while the key was Ultra at 100,000, which is the exact shape of defect captain decision 267a
    // closed: a denominator that moved by 500x while the argument resting on it did not.
    expect(doc).toMatch(/of the 100,000\/day allowance/);
    // Scoped to the SHARE, not to the string: naming ~200/day as history is correct and is what
    // makes the restatement legible. Presenting it as the denominator is the regression.
    expect(doc).not.toMatch(/of the ~200\/day/);
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
