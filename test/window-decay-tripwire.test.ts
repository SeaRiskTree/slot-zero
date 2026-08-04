/**
 * Tests for the window-decay tripwire. **Nothing here reaches the network.**
 *
 * Every endpoint fixture is synthetic — hand-written to the shape `swap-api.pump.fun` returned on
 * 2026-08-02, never a captured payload — except where a test deliberately reads the repo's own
 * committed tape, which is ours and is the point.
 *
 * The `fetchImpl`, `sleepImpl` and `nowImpl` seams on `KeylessClient` exist for these tests. No test
 * constructs a client without them, so a regression that starts issuing real requests fails here
 * rather than quietly hammering a shared public endpoint.
 *
 * Three kinds of assertion live here and they are not interchangeable:
 *
 * - **Decision boundary** — what makes this instrument raise a STOP AND ROTATE, and what does not.
 *   The one close on record, 2026-06-04, is replayed through the production detector; so are the
 *   three open-window readings that reach `armed` and must never reach a stop.
 * - **Bound** — every provider call this tool can make, and the exactness of the ceiling. An
 *   unbounded provider call is a blocking finding in this project, so it is a failing test here.
 * - **Boundary** — this is the repo's third network-capable directory and, like
 *   `tools/graduated-life-tape/`, it is keyless throughout: its credential allow-list is empty and
 *   its host allow-list is two. The scans below are what make "zero token" a property of the tree.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATTEMPTS_PER_REQUEST, BACKOFF, CeilingReached, HOSTS, HostRefused, HttpRefused, KeylessClient,
  DEFAULT_MIN_INTERVAL_MS, FRONTEND_API, RETRY_BACKOFF_MS, SWAP_API,
} from '../tools/window-decay-tripwire/client.mjs';
import type { Fill } from '../tools/window-decay-tripwire/detector.mjs';
import {
  CONFIRM_LAUNCHES, SHARE_BAR, Tripwire, bundledWallets, classifyCreateSlot, createSlotOf,
} from '../tools/window-decay-tripwire/detector.mjs';
import {
  MAX_PAGES_PER_LAUNCH, PAGE_LIMIT, SEEK_PAD_MS, creatorLaunchesUrl, dedupeBySid, parseFill,
  isReadableMint, parseRowTimestamp,
  parseLaunchListing, parseTradePage, readCreateSlot, reachedTheBeginning, seekCursor, slotOf,
  sortAscending, tradesUrl,
} from '../tools/window-decay-tripwire/createslot.mjs';
import {
  alternatives, errorCost, exposure, falseAlarms, latency, replay, sensitivity, zeroEventUpperBound,
} from '../tools/window-decay-tripwire/backtest.mjs';
import { SUBJECT_COHORT, SUBJECT_DEPLOYER, readWindowFills } from '../tools/window-decay-tripwire/tape.mjs';
import {
  MAX_ADJACENT_GAP_MS, THRESHOLDS, chainsOf, emptyState, loadState, orderReadings, parseArgs,
  planCost, positiveFinite, positiveInteger, resume, run,
} from '../tools/window-decay-tripwire/watch.mjs';
import { CREDENTIAL_PATTERNS, KEY_SHAPED } from './offline-guard.js';

// ---------------------------------------------------------------------------------------------
// Fixtures

const DEPLOYER = 'deployer-wallet';

/** `slotIndexId` for a slot and intra-slot ordinal, in the endpoint's fixed-width form. */
const sid = (slot: number, ordinal = 0): string =>
  String(slot).padStart(12, '0') + String(ordinal).padStart(10, '0');

function fill(overrides: Partial<Fill> = {}): Fill {
  const slot = overrides.slot ?? 100;
  return { slot, sid: sid(slot), tx: 'tx-a', u: 'wallet-a', k: 'buy', sol: 1, ...overrides };
}

/**
 * A create slot in the shape the tape actually shows: the deployer first, then the operation's
 * wallets sharing one bundled transaction, then outsiders in transactions of their own.
 */
function createSlot(opts: { dev: number; operation: number[]; outsiders: number[]; slot?: number }): Fill[] {
  const slot = opts.slot ?? 100;
  let n = 0;
  const out: Fill[] = [fill({ slot, sid: sid(slot, n++), tx: 'tx-dev', u: DEPLOYER, sol: opts.dev })];
  opts.operation.forEach((sol, i) =>
    out.push(fill({ slot, sid: sid(slot, n++), tx: 'tx-bundle', u: `cohort-${i}`, sol })));
  opts.outsiders.forEach((sol, i) =>
    out.push(fill({ slot, sid: sid(slot, n++), tx: `tx-out-${i}`, u: `outsider-${i}`, sol })));
  return out;
}

const KNOWN_COHORT = new Set(['cohort-0', 'cohort-1', 'cohort-2']);

/** Base58-shaped mints, because a mint that is not one never reaches a URL. */
const MINT = 'FaEXgcaRekBgQ6aVFDK2PuVX7ps9K9xn2JvfuTbEpump';
const MINT_2 = 'DkPmMBHZUQqbCPbjmVCkfSbFGpEbQoLZTKPnJLGXpump';

/** A client whose every response is scripted. Never touches the network. */
function scriptedClient(responses: Array<unknown | Error>, opts: { maxRequests?: number } = {}) {
  const urls: string[] = [];
  let i = 0;
  const client = new KeylessClient({
    maxRequests: opts.maxRequests ?? 50,
    minIntervalMs: 0,
    retryBackoffMs: [],
    sleepImpl: async () => undefined,
    nowImpl: () => 0,
    fetchImpl: (async (url: string) => {
      urls.push(url);
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return { ok: true, status: 200, json: async () => next } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  return { client, urls };
}

const page = (rows: unknown[], hasMore = true, nextCursor: string | null = 'next') =>
  ({ trades: rows, pagination: { hasMore, nextCursor, limit: PAGE_LIMIT } });

const rawRow = (overrides: Record<string, unknown> = {}) => ({
  slotIndexId: sid(100, 0), tx: 'tx-a', timestamp: '2026-06-04T12:08:52.000Z',
  userAddress: 'wallet-a', type: 'buy', program: 'pump', amountSol: '1.5', ...overrides,
});

// ---------------------------------------------------------------------------------------------

describe('the share is read from the create slot, and silence is never a reading', () => {
  it('takes the create slot from the deployer’s own buy, not from the oldest fill it happens to see', () => {
    // The trap this exists for: a backwards walk that stopped short returns a plausible pile of
    // fills whose earliest slot is merely the earliest it saw, and reading THAT as the create slot
    // crowns a mid-window sniper as the deployer.
    const fills = [
      fill({ slot: 98, sid: sid(98), u: 'sniper', sol: 9 }),
      ...createSlot({ dev: 10, operation: [5], outsiders: [5], slot: 100 }),
    ];
    expect(createSlotOf(fills, DEPLOYER)).toBe(100);
    const reading = classifyCreateSlot('m', 'at', fills, { deployer: DEPLOYER, cohort: KNOWN_COHORT });
    // The 9 SOL in slot 98 is outside the create slot and must not reach the denominator.
    expect(reading.slot).toBe(100);
    expect(reading.outsiderStake).toBe(5);
    expect(reading.share).toBeCloseTo(15 / 20, 10);
  });

  it('gives no reading when the deployer’s buy is absent, and says which of the two silences it is', () => {
    expect(classifyCreateSlot('m', 'at', [], { deployer: DEPLOYER, cohort: KNOWN_COHORT }).unread)
      .toBe('no-create-slot');
    expect(classifyCreateSlot('m', 'at', [fill({ u: 'someone-else' })], { deployer: DEPLOYER, cohort: KNOWN_COHORT }).unread)
      .toBe('no-deployer-buy');
  });

  it('NEVER produces a share of 1: a create slot nobody bid into is silence, not a maximum', () => {
    // T1's first recorded caveat (analysis/window-population/README.md §9) in code. 25 of the open
    // window's 129 launches had no outsider in the create slot at all, and reading them as 1.0 is
    // what takes this tool from 0 false stops to 7.
    const reading = classifyCreateSlot('m', 'at', createSlot({ dev: 10, operation: [5], outsiders: [] }),
      { deployer: DEPLOYER, cohort: KNOWN_COHORT });
    expect(reading.unread).toBe('no-outsider-stake');
    expect(reading.share).toBeNull();
    // And the stakes are still reported, so a reader can see WHY there is no reading.
    expect(reading.operationStake).toBe(5);
    expect(reading.outsiderStake).toBe(0);
  });

  it('derives the operation from bundled transactions when it is not told the cohort', () => {
    const fills = createSlot({ dev: 10, operation: [3, 2], outsiders: [5] });
    expect([...bundledWallets(fills)].sort()).toEqual(['cohort-0', 'cohort-1']);
    const reading = classifyCreateSlot('m', 'at', fills, { deployer: DEPLOYER });
    expect(reading.cohortDerived).toBe(true);
    expect(reading.operationWallets).toEqual(['cohort-0', 'cohort-1']);
    expect(reading.share).toBeCloseTo(15 / 20, 10);
  });

  it('refuses to read a create slot with no bundled transaction rather than calling the cohort empty', () => {
    // Captain decision 134a's shape. Finding no co-ordination is indistinguishable from there being
    // none, and reading it as the second credits the operation's helpers to the outsiders — which
    // pushes the share DOWN, towards "still open", the direction this instrument must never fail in.
    const unbundled = [
      fill({ sid: sid(100, 0), tx: 'tx-dev', u: DEPLOYER, sol: 10 }),
      fill({ sid: sid(100, 1), tx: 'tx-1', u: 'cohort-0', sol: 5 }),
      fill({ sid: sid(100, 2), tx: 'tx-2', u: 'outsider-0', sol: 5 }),
    ];
    const derived = classifyCreateSlot('m', 'at', unbundled, { deployer: DEPLOYER });
    expect(derived.unread).toBe('no-cohort-evidence');
    expect(derived.share).toBeNull();
    // Told the cohort, the same slot reads fine — the silence is about the evidence, not the slot.
    expect(classifyCreateSlot('m', 'at', unbundled, { deployer: DEPLOYER, cohort: KNOWN_COHORT }).share)
      .toBeCloseTo(0.75, 10);
  });

  it('counts only buys, and only in the create slot', () => {
    const fills = [
      ...createSlot({ dev: 10, operation: [5], outsiders: [5] }),
      fill({ slot: 100, sid: sid(100, 9), tx: 'tx-sell', u: 'outsider-9', k: 'sell', sol: 100 }),
      fill({ slot: 101, sid: sid(101, 0), tx: 'tx-late', u: 'outsider-8', sol: 100 }),
    ];
    const reading = classifyCreateSlot('m', 'at', fills, { deployer: DEPLOYER, cohort: KNOWN_COHORT });
    expect(reading.outsiderStake).toBe(5);
    expect(reading.outsiderWallets).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the decision boundary', () => {
  const read = (share: number) => ({
    mint: 'm', at: '2026-01-01T00:00:00Z', share, unread: null, slot: 1,
    deployerStake: 0, operationStake: 0, outsiderStake: 1, outsiderWallets: 1,
    operationWallets: [], cohortDerived: false,
  });
  const silent = () => ({ ...read(0), share: null, unread: 'no-outsider-stake' as const });

  it('needs two consecutive readings at or above the bar, and the bar is inclusive', () => {
    const t = new Tripwire();
    expect(t.observe(read(SHARE_BAR - 0.001)).verdict).toBe('watching');
    expect(t.observe(read(SHARE_BAR)).verdict).toBe('armed');
    expect(t.observe(read(SHARE_BAR)).verdict).toBe('stop-and-rotate');
  });

  it('resets on a reading below the bar — one high launch is not a close', () => {
    const t = new Tripwire();
    t.observe(read(0.9));
    expect(t.observe(read(0.2)).verdict).toBe('watching');
    expect(t.observe(read(0.9)).verdict).toBe('armed');
  });

  it('skips an unread launch: it neither advances the streak nor resets it', () => {
    // Advancing on it would be T1's first caveat in code; resetting on it would let a one-in-five
    // accident — 25 of 129 open-window launches — disarm a real alarm.
    const t = new Tripwire();
    expect(t.observe(read(0.9)).verdict).toBe('armed');
    expect(t.observe(silent()).verdict).toBe('armed');
    expect(t.observe(silent()).streak).toBe(1);
    expect(t.observe(read(0.9)).verdict).toBe('stop-and-rotate');
  });

  it('latches: this lane never un-stops and never re-polls a wallet it has stopped on', () => {
    const t = new Tripwire();
    t.observe(read(0.9));
    t.observe(read(0.9));
    expect(t.observe(read(0.01)).verdict).toBe('stop-and-rotate');
    expect(t.observe(silent()).verdict).toBe('stop-and-rotate');
  });

  it('carries the readings the stop rests on, so a saved verdict stays auditable', () => {
    const t = new Tripwire();
    t.observe(read(0.2));
    t.observe(read(0.71));
    t.observe(silent());
    t.observe(read(0.72));
    expect(t.evidence.map((e) => e.share)).toEqual([0.71, 0.72]);
  });

  it('at a confirmation count of one, the evidence is the single reading and not the whole history', () => {
    // `slice(-(k - 1))` is `slice(-0)` — i.e. the whole array — at k = 1, which would make a saved
    // verdict claim every breach the watch ever saw as part of one stop.
    const t = new Tripwire({ confirmLaunches: 1 });
    t.observe(read(0.9));
    t.observe(read(0.2));
    const again = new Tripwire({ confirmLaunches: 1 });
    again.observe(read(0.6));
    again.observe(read(0.95));
    expect(again.evidence.map((e) => e.share)).toEqual([0.6]);
  });

  it('reports coverage by reason, so "watching" over launches it never read is visible', () => {
    const t = new Tripwire();
    t.observe(read(0.2));
    t.observe(silent());
    t.observe({ ...silent(), unread: 'no-cohort-evidence' });
    expect(t.coverage()).toEqual({ observed: 3, read: 1, unread: { 'no-outsider-stake': 1, 'no-cohort-evidence': 1 } });
  });

  it('refuses a nonsense configuration rather than silently behaving like a different instrument', () => {
    expect(() => new Tripwire({ bar: 0 })).toThrow(RangeError);
    expect(() => new Tripwire({ bar: 1.5 })).toThrow(RangeError);
    expect(() => new Tripwire({ confirmLaunches: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the known close of 2026-06-04, replayed through the production detector', () => {
  const { steps, tripwire } = replay();
  const l = latency(steps);

  it('reads the tape it claims to: one deployer, from the window’s open to the tape’s end', () => {
    expect(steps).toHaveLength(222);
    expect(steps[0]?.date.slice(0, 10)).toBe('2026-03-12');
    expect(steps[steps.length - 1]?.date.slice(0, 10)).toBe('2026-07-28');
    // Coverage, not size: 25 open-window launches had no outsider in the create slot and 4 launches
    // never reached the mint, and both are silences rather than readings.
    expect(tripwire.coverage()).toEqual({
      observed: 222, read: 184, unread: { 'no-outsider-stake': 34, 'no-create-slot': 4 },
    });
  });

  it('measures the close at 24.7 hours — the number every latency here is quoted against', () => {
    expect(l.lastOpen.symbol).toBe('Banknote');
    expect(l.firstClosed.symbol).toBe('Peque');
    expect(l.closeSpeedHours).toBeCloseTo(24.7, 1);
  });

  it('raises STOP AND ROTATE 24.1 hours after the regime changed, at PvE', () => {
    expect(l.alarm?.symbol).toBe('PvE');
    expect(l.alarm?.date).toBe('2026-06-05T12:12:55Z');
    expect(l.alarmHours).toBeCloseTo(24.1, 1);
    // The two readings it rests on, and the thin one is the first: Peque clears 0.55 by 0.003.
    expect(tripwire.evidence.map((e) => Number((e.share ?? 0).toFixed(4)))).toEqual([0.5527, 0.8821]);
    expect(tripwire.evidence[0]?.share).toBeGreaterThanOrEqual(SHARE_BAR);
  });

  it('names the first launch the operator would not have entered, which is a later instant', () => {
    // An entrant is already in a launch by the time its create slot can be read, so the alarm and
    // the first avoided launch are different numbers and the second is what sizing turns on.
    expect(l.firstAvoided?.date).toBe('2026-06-05T14:09:46Z');
    expect(l.avoidedHours).toBeCloseTo(26.0, 1);
    expect(l.entered.map((s) => s.symbol)).toEqual(['Peque', 'PvE']);
  });

  it('raises no stop anywhere inside the 83-day open window', () => {
    const fa = falseAlarms(steps);
    expect(fa.fired).toEqual([]);
    expect(fa.read).toBe(104);
    expect(fa.launches).toBe(129);
  });

  it('reaches `armed` exactly three times inside the window, and never confirms any of them', () => {
    const fa = falseAlarms(steps);
    expect(fa.armed.map((s) => `${s.date.slice(0, 10)} ${s.symbol}`)).toEqual([
      '2026-04-16 Doggo', '2026-04-28 TruthGPT', '2026-05-20 Universal',
    ]);
    // Isolated, every one: that is WHY the second reading separates the two causes of a high
    // reading, and it is a measurement rather than an argument.
    for (const s of fa.armed) expect(s.step.streak).toBe(1);
  });

  it('does not report zero false alarms as a rate of zero', () => {
    const ex = exposure(steps);
    expect(zeroEventUpperBound(104)).toBeCloseTo(0.0284, 4);
    expect(ex.stopProbabilityAtUpperBound).toBeGreaterThan(0.9);
    // The lane's real ceiling: at the top of the range this sample allows, the instrument costs
    // more than half the window it protects, and one window cannot distinguish that from zero.
    expect(ex.expectedCostAtUpperBoundSol).toBeGreaterThan(ex.windowPrizeSol / 2);
    expect(ex.measuredCostSol).toBeLessThan(2);
  });

  it('prices both errors, and the asymmetry is the reason the second reading exists', () => {
    const cost = errorCost(steps);
    expect(cost.medianFalseStopSol).toBeCloseTo(389.9, 1);
    expect(cost.latencyCostSol).toBeCloseTo(-1.02, 2);
    // Fee-inclusive is the LARGER loss, always — gross overstates what a participant kept.
    expect(cost.latencyCostNetOfMeasuredFeesSol).toBeCloseTo(-1.37, 2);
    expect(cost.latencyCostNetOfMeasuredFeesSol).toBeLessThan(cost.latencyCostSol);
    expect(cost.latencyPricedTrips).toBe(cost.latencyTrips);
    expect(Math.abs(cost.medianFalseStopSol / cost.latencyCostSol)).toBeGreaterThan(300);
  });

  it('excluding the create slots nobody bid into is worth seven false stops', () => {
    const naive = alternatives(steps).find((a) => a.name.startsWith('T1 naive'));
    expect(naive?.falseAlarms).toBe(7);
    expect(naive?.hoursAfterBreak).toBeCloseTo(24.1, 1);
  });

  it('beats the P&L variance route on BOTH axes, which is the evidence for the choice', () => {
    const alts = alternatives(steps);
    const chosen = alts.find((a) => a.name === 'T1 share >= 0.55, 2 consecutive');
    const pnl = alts.filter((a) => a.name.startsWith('P&L'));
    expect(chosen?.falseAlarms).toBe(0);
    expect(chosen?.hoursAfterBreak).toBeCloseTo(24.1, 1);
    for (const p of pnl) {
      expect(p.hoursAfterBreak ?? 0).toBeGreaterThan(chosen?.hoursAfterBreak ?? 0);
      expect(p.falseAlarms).toBeGreaterThan(chosen?.falseAlarms ?? 0);
    }
    // Nothing on the board is both faster and quieter.
    for (const a of alts) {
      const faster = (a.hoursAfterBreak ?? Infinity) < (chosen?.hoursAfterBreak ?? 0);
      const quieter = a.falseAlarms < (chosen?.falseAlarms ?? 0);
      expect(faster && quieter).toBe(false);
    }
  });

  it('rejects the deployer’s own stake alone, which is the most exogenous signal available', () => {
    // §9's first caveat, read the other way: the numerator the operation fully controls rises
    // repeatedly while the window stays open, so a step test on it is unusable on its own.
    for (const a of alternatives(steps).filter((x) => x.name.startsWith("deployer's own buy"))) {
      expect(a.falseAlarms).toBeGreaterThanOrEqual(5);
    }
  });

  it('is not balanced on the exact pinned bar: two independent settings give the same answer', () => {
    const grid = sensitivity(latency(replay().steps).firstClosed);
    const at = (name: string) => grid.find((a) => a.name === name);
    expect(at('bar 0.55 x2')).toMatchObject({ falseAlarms: 0 });
    expect(at('bar 0.55 x2')?.hoursAfterBreak).toBeCloseTo(24.1, 1);
    expect(at('bar 0.50 x3')).toMatchObject({ falseAlarms: 0 });
    expect(at('bar 0.50 x3')?.hoursAfterBreak).toBeCloseTo(24.1, 1);
    // Everything in 0.55–0.65 with two confirmations is silent inside the window; the cost of
    // raising the bar is latency, not false alarms.
    for (const bar of ['0.55', '0.60', '0.65']) expect(at(`bar ${bar} x2`)?.falseAlarms).toBe(0);
  });

  it('reaches the same verdict with the cohort derived from bundled transactions', () => {
    const derived = replay({ deriveCohort: true });
    const dl = latency(derived.steps);
    expect(dl.alarm?.symbol).toBe('PvE');
    expect(dl.alarmHours).toBeCloseTo(24.1, 1);
    expect(falseAlarms(derived.steps).fired).toEqual([]);
    // It reads fewer launches, and the shortfall is where this deployer did not bundle. Before
    // April the co-ordination rule recovers nothing at all, which is why a slot with no bundled
    // transaction must be silence rather than an empty cohort.
    expect(derived.tripwire.coverage().read).toBe(156);
    const march = derived.steps.filter((s) => s.date.slice(0, 7) === '2026-03');
    expect(march.filter((s) => s.step.counted)).toHaveLength(4);
  });

  it('reads the committed tape’s own create slot for Peque, and agrees with the published parameters', () => {
    // A cross-check against the June report §5.1, which arrived at these two numbers by a different
    // route: the dev buy stepped to 14.814814813 and the cohort's stake to 10.86 on this launch.
    const fills = readWindowFills('FaEXgcaRekBgQ6aVFDK2PuVX7ps9K9xn2JvfuTbEpump');
    const reading = classifyCreateSlot('peque', '2026-06-04T12:08:52Z', fills, {
      deployer: SUBJECT_DEPLOYER, cohort: new Set(SUBJECT_COHORT),
    });
    expect(reading.deployerStake).toBeCloseTo(14.814814814, 6);
    expect(reading.operationStake).toBeCloseTo(10.86, 2);
    expect(reading.share).toBeCloseTo(0.5527, 4);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the trade endpoint is read, never assumed', () => {
  it('seeks by the timestamp half of the cursor, with a slot half that cannot narrow the seek', () => {
    expect(seekCursor(1_700_000_000_000)).toBe('9999999999990000000000-1700000000000');
    expect(seekCursor(1_700_000_000_000.9)).toBe('9999999999990000000000-1700000000000');
  });

  it('builds keyless URLs on the two allowed hosts and nowhere else', () => {
    expect(tradesUrl('MINT')).toBe(`${SWAP_API}/v2/coins/MINT/trades?limit=100`);
    expect(tradesUrl('MINT', 'abc-1')).toContain('cursor=abc-1');
    expect(creatorLaunchesUrl('WALLET', 50)).toContain(`${FRONTEND_API}/coins?`);
    for (const url of [tradesUrl('M'), creatorLaunchesUrl('W', 1)]) {
      expect(HOSTS.some((h) => url.startsWith(`${h}/`))).toBe(true);
    }
  });

  it('derives the slot from the fixed-width slotIndexId, and agrees with the committed tape', () => {
    // Not self-consistency: the committed tape stores BOTH `sid` and `slot`, written by a different
    // builder from a different code path. A wrong split would disagree on every row.
    const fills = readWindowFills('FaEXgcaRekBgQ6aVFDK2PuVX7ps9K9xn2JvfuTbEpump');
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(slotOf(f.sid)).toBe(f.slot);
  });

  it('tells "we cannot read this" apart from "there is nothing"', () => {
    expect(parseTradePage({ error: 'nope' }).recognised).toBe(false);
    const empty = parseTradePage(page([], false, null));
    expect(empty.recognised).toBe(true);
    expect(empty.fills).toEqual([]);
    // A bare array carries no pagination, so it makes no statement about there being more.
    expect(parseTradePage([rawRow()]).hasMore).toBeNull();
  });

  it('drops a row it cannot size rather than summing it as zero, and counts what it dropped', () => {
    // A zero would understate the denominator, i.e. push the share UP — towards a stop.
    const parsed = parseTradePage(page([rawRow(), rawRow({ amountSol: 'not-a-number' }), rawRow({ type: 'transfer' })]));
    expect(parsed.rawRows).toBe(3);
    expect(parsed.fills).toHaveLength(1);
    expect(parseFill(null)).toBeNull();
    expect(parseFill({ slotIndexId: 'short' })).toBeNull();
  });

  it('sorts ascending by sid and dedupes by it, because a create slot is one slot', () => {
    const fills = parseTradePage(page([
      rawRow({ slotIndexId: sid(500, 9) }), rawRow({ slotIndexId: sid(500, 1) }), rawRow({ slotIndexId: sid(499, 3) }),
    ])).fills;
    expect(sortAscending(fills).map((f) => f.sid)).toEqual([sid(499, 3), sid(500, 1), sid(500, 9)]);
    expect(dedupeBySid([...fills, ...fills])).toHaveLength(3);
  });

  it('proves it reached the create slot from the deployer’s own buy, never from running out of pages', () => {
    const reached = [fill({ sid: sid(100, 0), u: DEPLOYER }), fill({ sid: sid(100, 1), u: 'x' })];
    expect(reachedTheBeginning(reached, DEPLOYER)).toBe(true);
    // A pile whose oldest row is somebody else's is a truncated walk, whatever its size.
    expect(reachedTheBeginning([fill({ sid: sid(99, 0), u: 'sniper' }), ...reached], DEPLOYER)).toBe(false);
    expect(reachedTheBeginning([], DEPLOYER)).toBe(false);
  });

  it('reads the create slot in one request when the launch’s mint instant is known', () => {
    const { client, urls } = scriptedClient([page([
      rawRow({ slotIndexId: sid(100, 1), userAddress: 'outsider', amountSol: '5' }),
      rawRow({ slotIndexId: sid(100, 0), userAddress: DEPLOYER, amountSol: '10' }),
    ], true, 'more')]);
    return readCreateSlot(client, MINT, { deployer: DEPLOYER, createdAtMs: 1_000_000 }).then((walk) => {
      expect(walk.pages).toBe(1);
      expect(walk.proven).toBe(true);
      expect(walk.decided).toBe(true);
      expect(walk.undecidedReason).toBeNull();
      expect(urls[0]).toContain(`cursor=${encodeURIComponent(seekCursor(1_000_000 + SEEK_PAD_MS))}`);
      // Ascending, so the deployer's buy leads — the shape `classifyCreateSlot` reads.
      expect(walk.fills[0]?.u).toBe(DEPLOYER);
    });
  });

  it('returns proven:false rather than a create slot it merely stopped at', async () => {
    // Every page is somebody else's fills. Running out of pages proves nothing, and the caller
    // turns `proven: false` into "no reading from this launch".
    const { client } = scriptedClient([page([rawRow({ slotIndexId: sid(200, 0), userAddress: 'sniper' })], true, 'c')]);
    const walk = await readCreateSlot(client, MINT, { deployer: DEPLOYER, createdAtMs: null });
    expect(walk.proven).toBe(false);
    expect(walk.pages).toBe(MAX_PAGES_PER_LAUNCH);
    // Out of pages is not an answer about the launch, so the caller must come back to it.
    expect(walk.decided).toBe(false);
    expect(walk.undecidedReason).toBe('pages');
  });

  it('stops on a body it cannot read, without treating it as an empty create slot', async () => {
    const { client } = scriptedClient([{ error: 'nope' }]);
    const walk = await readCreateSlot(client, MINT, { deployer: DEPLOYER, createdAtMs: 1 });
    expect(walk.proven).toBe(false);
    expect(walk.pages).toBe(1);
    expect(walk.decided).toBe(false);
    expect(walk.undecidedReason).toBe('unreadable');
  });

  it('pages only on the endpoint’s own nextCursor, because a second-resolution seek cannot go backwards inside one second', async () => {
    // There is no second paging route to fall back on. A cursor built from the oldest row seen
    // carries that row's own second, so it re-requests the page just read — which on the exact case
    // the page bound exists for (a create slot larger than one page) would spend all three pages on
    // identical rows. Stopping at one page and reporting UNDECIDED is the honest outcome.
    const { client, urls } = scriptedClient([
      { trades: [rawRow({ slotIndexId: sid(300, 0), userAddress: 'sniper', timestamp: '2026-06-04T12:08:52.000Z' })] },
    ]);
    const walk = await readCreateSlot(client, MINT, { deployer: DEPLOYER, createdAtMs: null });
    expect(urls).toHaveLength(1);
    expect(walk.pages).toBe(1);
    expect(walk.decided).toBe(false);
    expect(walk.undecidedReason).toBe('no-cursor');
  });

  it('walks on while the endpoint keeps supplying cursors, and stops when it stops', async () => {
    const { client, urls } = scriptedClient([
      page([rawRow({ slotIndexId: sid(302, 0), userAddress: 'sniper' })], true, 'older-1'),
      page([rawRow({ slotIndexId: sid(301, 0), userAddress: 'sniper' })], true, 'older-2'),
      page([rawRow({ slotIndexId: sid(300, 0), userAddress: DEPLOYER })], true, 'older-3'),
    ]);
    const walk = await readCreateSlot(client, MINT, { deployer: DEPLOYER, createdAtMs: null });
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain('cursor=older-1');
    expect(urls[2]).toContain('cursor=older-2');
    expect(walk.proven).toBe(true);
    expect(walk.decided).toBe(true);
  });

  it('settles a launch the endpoint itself says there is nothing older for', async () => {
    // The one silence that IS an answer: hasMore false. Everything else is "come back to it".
    const { client } = scriptedClient([page([rawRow({ slotIndexId: sid(300, 0), userAddress: 'sniper' })], false, null)]);
    const walk = await readCreateSlot(client, MINT, { deployer: DEPLOYER, createdAtMs: 1 });
    expect(walk.proven).toBe(false);
    expect(walk.decided).toBe(true);
    expect(walk.undecidedReason).toBeNull();
  });

  it('does not read an empty CURSORED page as silence — a wrong seek looks exactly the same', async () => {
    // A seek that landed in the wrong place and a token with no such fills return the identical
    // body. The walk cannot tell them apart, so it does not get to settle the launch on it.
    const { client } = scriptedClient([page([], false, null)]);
    const walk = await readCreateSlot(client, MINT, { deployer: DEPLOYER, createdAtMs: 1_780_000_000_000 });
    expect(walk.decided).toBe(false);
    expect(walk.undecidedReason).toBe('empty-page');
  });

  it('does settle an empty UNCURSORED page the endpoint says there is nothing more after', async () => {
    // The other half of that rule: without a cursor there is no seek to be wrong, so `hasMore:
    // false` on the newest-fills-of-all page IS the endpoint stating the token has nothing. Left
    // undecided, a launch that genuinely never traded would be re-read on every run forever.
    const { client } = scriptedClient([page([], false, null)]);
    const walk = await readCreateSlot(client, MINT, { deployer: DEPLOYER, createdAtMs: null });
    expect(walk.decided).toBe(true);
    expect(walk.undecidedReason).toBeNull();
  });

  it('reads a seconds-resolution created_timestamp the same way it reads a row’s, so no seek lands in 1970', () => {
    // Two parsers in one file disagreeing about the unit of the same vendor field is how a launch's
    // seek aims at the epoch and comes back empty.
    expect(parseRowTimestamp(1_780_000_000)).toBe(1_780_000_000_000);
    expect(parseRowTimestamp(1_780_000_000_000)).toBe(1_780_000_000_000);
    expect(parseRowTimestamp('nope')).toBeNull();
    const listing = parseLaunchListing({ coins: [{ mint: MINT, created_timestamp: 1_780_000_000 }] });
    expect(listing.launches[0]?.createdAtMs).toBe(1_780_000_000_000);
    // And a row whose timestamp cannot be read is dropped, not seeked from as zero.
    expect(parseLaunchListing({ coins: [{ mint: MINT, created_timestamp: 'nope' }] }).launches).toEqual([]);
  });

  it('refuses a mint that is not base58-shaped before it reaches a URL, and encodes the ones that are', () => {
    // Same rule as `dune.mjs` → WALLET_SHAPE: the mint lands in a URL PATH, which `..`, `?` and `#`
    // rewrite, and the client's host allow-list checks the host prefix and cannot catch that.
    expect(isReadableMint(MINT)).toBe(true);
    expect(isReadableMint('../../../etc/passwd')).toBe(false);
    expect(isReadableMint('MINT?x=1')).toBe(false);
    expect(isReadableMint(42)).toBe(false);
    expect(tradesUrl('a/../b')).toContain('coins/a%2F..%2Fb/trades');
    const { client } = scriptedClient([page([])]);
    return expect(readCreateSlot(client, '../evil', { deployer: DEPLOYER, createdAtMs: 1 })).rejects.toThrow(/base58/);
  });

  it('refuses an unreadable launch listing rather than reading it as "this wallet launched nothing"', () => {
    // The failure that would leave a watcher sitting on `watching` forever while the window closed.
    expect(parseLaunchListing({ message: 'rate limited' }).recognised).toBe(false);
    expect(parseLaunchListing({ coins: [] })).toMatchObject({ recognised: true, launches: [] });
    const listing = parseLaunchListing({
      coins: [
        { mint: 'b', created_timestamp: 2000, symbol: 'B' },
        { mint: 'a', created_timestamp: 1000, symbol: 'A' },
        { mint: 'c' },
      ],
    });
    expect(listing.rawRows).toBe(3);
    expect(listing.launches.map((l) => l.mint)).toEqual(['b', 'a']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('every provider call is bounded, and a dry run spends nothing', () => {
  it('counts the ceiling against attempts, not logical requests, so a retry cannot exceed it', async () => {
    const client = new KeylessClient({
      maxRequests: 2, minIntervalMs: 0, retryBackoffMs: [0, 0, 0],
      sleepImpl: async () => undefined, nowImpl: () => 0,
      fetchImpl: (async () => ({ ok: false, status: 429, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch,
    });
    await expect(client.getJson(`${SWAP_API}/x`)).rejects.toBeInstanceOf(CeilingReached);
    expect(client.issued()).toBe(2);
  });

  it('refuses a URL outside the keyless host allow-list before it reaches the network', async () => {
    const { client } = scriptedClient([{}]);
    await expect(client.getJson('https://api.madeonsol.com/anything')).rejects.toBeInstanceOf(HostRefused);
    await expect(client.getJson('https://solana-rpc.publicnode.com/')).rejects.toBeInstanceOf(HostRefused);
    expect(client.issued()).toBe(0);
    expect(HOSTS).toEqual([SWAP_API, FRONTEND_API]);
  });

  it('does not retry a considered refusal, and does retry load-shedding', async () => {
    const four = new KeylessClient({
      maxRequests: 9, minIntervalMs: 0, retryBackoffMs: [0], sleepImpl: async () => undefined, nowImpl: () => 0,
      fetchImpl: (async () => ({ ok: false, status: 400, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch,
    });
    await expect(four.getJson(`${SWAP_API}/x`)).rejects.toBeInstanceOf(HttpRefused);
    expect(four.issued()).toBe(1);
    expect(BACKOFF.growth).toBeGreaterThan(1);
    expect(DEFAULT_MIN_INTERVAL_MS).toBe(4000);
  });

  it('the pinned worst case is exactly the pinned ceiling — an exact bound, not a nominal one', () => {
    // Derived from the client's own retry ladder, never a literal: the identity is what makes the
    // ceiling exact, so a rung added to the ladder must break this test rather than silently raise
    // the real worst case while every plan keeps reporting the old one.
    expect(ATTEMPTS_PER_REQUEST).toBe(RETRY_BACKOFF_MS.length + 1);
    expect(new KeylessClient({ maxRequests: 1 }).attemptsPerRequest()).toBe(ATTEMPTS_PER_REQUEST);
    const worst = planCost(Number(THRESHOLDS.bounds['maxLaunchesPerRun']), true);
    expect(worst.attempts).toBe(Number(THRESHOLDS.bounds['maxRequestsPerRun']));
  });

  it('is dry by default and issues nothing', async () => {
    const lines: string[] = [];
    const fetchImpl = (() => { throw new Error('a dry run must not fetch'); }) as unknown as typeof fetch;
    const result = await run(parseArgs(['--wallet', 'W']), { log: (l) => lines.push(l), fetchImpl });
    expect(result.issued).toBe(0);
    expect(lines.join('\n')).toContain('DRY RUN');
    expect(lines.join('\n')).toContain('FITS');
    // Every verdict, dry or live, carries the n = 1 caveat and the asymmetry caveat.
    expect(lines.join('\n')).toContain('n = 1');
    expect(lines.join('\n')).toContain('380x');
  });

  it('refuses a live run with no state file, rather than becoming a single-launch alarm', async () => {
    await expect(run({ ...parseArgs(['--wallet', 'W', '--live']) }, { log: () => undefined }))
      .rejects.toThrow(/--state/);
  });

  it('refuses a state file belonging to a different wallet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      writeFileSync(path, JSON.stringify(emptyState('OTHER')));
      // Two unrelated launches must never be able to confirm each other into a stop.
      expect(() => loadState(path, 'W')).toThrow(/OTHER/);
      expect(loadState(join(dir, 'missing.json'), 'W')).toEqual(emptyState('W'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries the streak between runs, which is what makes two consecutive readings possible', () => {
    const state = { ...emptyState('W'), streak: 1, verdict: 'armed' as const };
    const t = resume(state, { bar: SHARE_BAR, confirmLaunches: CONFIRM_LAUNCHES });
    expect(t.streak).toBe(1);
    const step = t.observe({
      mint: 'm', at: 'x', share: 0.9, unread: null, slot: 1, deployerStake: 1, operationStake: 1,
      outsiderStake: 1, outsiderWallets: 1, operationWallets: [], cohortDerived: false,
    });
    expect(step.verdict).toBe('stop-and-rotate');
  });

  it('spends nothing at all on a wallet it has already stopped on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      writeFileSync(path, JSON.stringify({ ...emptyState('W'), verdict: 'stop-and-rotate', stoppedAt: '2026-06-05T12:12:55Z' }));
      const lines: string[] = [];
      const result = await run(parseArgs(['--wallet', 'W', '--state', path, '--live']), {
        log: (l) => lines.push(l),
        fetchImpl: (() => { throw new Error('must not re-poll a stopped wallet'); }) as unknown as typeof fetch,
      });
      expect(result.issued).toBe(0);
      expect(lines.join('\n')).toContain('does not re-poll');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs live inside its bounds and reaches a verdict from the endpoint’s own rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      const slotPage = (slot: number, outsider: string) => page([
        rawRow({ slotIndexId: sid(slot, 2), userAddress: outsider, amountSol: '1' }),
        rawRow({ slotIndexId: sid(slot, 1), userAddress: 'cohort-a', tx: 'bundle', amountSol: '9' }),
        rawRow({ slotIndexId: sid(slot, 0), userAddress: 'W', amountSol: '10' }),
      ], false, null);
      const responses = [
        { coins: [{ mint: MINT, created_timestamp: 1000 }, { mint: MINT_2, created_timestamp: 2000 }] },
        slotPage(100, 'out-1'),
        slotPage(101, 'out-2'),
      ];
      let i = 0;
      const lines: string[] = [];
      const result = await run(parseArgs(['--wallet', 'W', '--cohort', 'cohort-a', '--state', path, '--live']), {
        log: (l) => lines.push(l),
        sleepImpl: async () => undefined,
        nowImpl: () => 0,
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => responses[Math.min(i++, responses.length - 1)] } as unknown as Response)) as unknown as typeof fetch,
      });
      // 19 of 20 SOL is the operation on both launches — two consecutive readings, so a stop.
      expect(result.state.verdict).toBe('stop-and-rotate');
      expect(result.read).toBe(2);
      expect(result.issued).toBe(3);
      expect(result.issued).toBeLessThanOrEqual(Number(THRESHOLDS.bounds['maxRequestsPerRun']));
      expect(JSON.parse(readFileSync(path, 'utf8')).verdict).toBe('stop-and-rotate');
      expect(lines.join('\n')).toContain('STOP-AND-ROTATE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a plan that does not fit BEFORE its first request, not by exhausting the budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      await expect(run(parseArgs(['--wallet', 'W', '--state', path, '--live', '--max-launches', '20']), {
        log: () => undefined,
        fetchImpl: (() => { throw new Error('a refused plan must not fetch'); }) as unknown as typeof fetch,
      })).rejects.toThrow(/does not fit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sizes the plan from the mints it was given, not from the bound, when the queue is already known', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      // One mint can cost at most 3 pages x 4 attempts = 12, so this run demonstrably fits inside 20
      // and must not be refused on the strength of a bound it cannot reach.
      const result = await run(parseArgs([
        '--wallet', 'W', '--cohort', 'cohort-a', '--mints', MINT, '--state', path, '--live', '--max-requests', '20',
      ]), {
        log: () => undefined, sleepImpl: async () => undefined, nowImpl: () => 0,
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => page([
          rawRow({ slotIndexId: sid(100, 2), userAddress: 'out-1', amountSol: '1' }),
          rawRow({ slotIndexId: sid(100, 1), userAddress: 'cohort-a', tx: 'bundle', amountSol: '9' }),
          rawRow({ slotIndexId: sid(100, 0), userAddress: 'W', amountSol: '10' }),
        ], false, null) } as unknown as Response)) as unknown as typeof fetch,
      });
      expect(result.read).toBe(1);
      expect(result.state.readMints).toEqual([MINT]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a bound that is not a positive integer rather than reading nothing and saying "watching"', () => {
    // `Number('eight')` is NaN, `fresh.slice(0, NaN)` is empty, and the run then reports WATCHING
    // over launches it never looked at — the one outcome this tool must never produce quietly.
    expect(() => parseArgs(['--wallet', 'W', '--max-launches', 'eight'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--wallet', 'W', '--max-launches', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--wallet', 'W', '--max-requests', '2.5'])).toThrow(/positive integer/);
    expect(parseArgs(['--wallet', 'W', '--max-launches', '3']).maxLaunches).toBe(3);
  });

  it('keeps a launch it could not settle OUT of the read set, so the next run retries it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      // Page one is somebody else's fills and the endpoint makes no statement about there being
      // more, so the walk runs out of pages without proving coverage: undecided, not "no create slot".
      const responses: unknown[] = [
        { coins: [{ mint: MINT, created_timestamp: 1000 }] },
        { trades: [rawRow({ slotIndexId: sid(300, 0), userAddress: 'sniper', timestamp: 'not-a-time' })] },
      ];
      let i = 0;
      const lines: string[] = [];
      const result = await run(parseArgs(['--wallet', 'W', '--cohort', 'cohort-a', '--state', path, '--live']), {
        log: (l) => lines.push(l), sleepImpl: async () => undefined, nowImpl: () => 0,
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => responses[Math.min(i++, responses.length - 1)] } as unknown as Response)) as unknown as typeof fetch,
      });
      expect(result.read).toBe(0);
      expect(result.undecided).toBe(1);
      expect(result.state.readMints).toEqual([]);
      expect(result.state.readings).toEqual([]);
      expect(JSON.parse(readFileSync(path, 'utf8')).readMints).toEqual([]);
      expect(lines.join('\n')).toContain('undecided');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saves the readings it already took when the endpoint refuses a later launch mid-series', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      const slotPage = (slot: number) => page([
        rawRow({ slotIndexId: sid(slot, 2), userAddress: 'out-1', amountSol: '10' }),
        rawRow({ slotIndexId: sid(slot, 1), userAddress: 'cohort-a', tx: 'bundle', amountSol: '1' }),
        rawRow({ slotIndexId: sid(slot, 0), userAddress: 'W', amountSol: '1' }),
      ], false, null);
      let call = 0;
      const lines: string[] = [];
      const result = await run(parseArgs(['--wallet', 'W', '--cohort', 'cohort-a', '--state', path, '--live']), {
        log: (l) => lines.push(l), sleepImpl: async () => undefined, nowImpl: () => 0,
        fetchImpl: (async () => {
          call += 1;
          if (call === 1) {
            return { ok: true, status: 200, json: async () => ({
              coins: [{ mint: MINT, created_timestamp: 1000 }, { mint: MINT_2, created_timestamp: 2000 }],
            }) } as unknown as Response;
          }
          if (call === 2) return { ok: true, status: 200, json: async () => slotPage(100) } as unknown as Response;
          // A 404 on a mint the listing still carries: the endpoint's considered answer, not retried.
          return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
        }) as unknown as typeof fetch,
      });
      // Launch one was read and is saved; launch two is neither read nor recorded, so it is retried.
      expect(result.read).toBe(1);
      expect(result.undecided).toBe(1);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(saved.readMints).toEqual([MINT]);
      expect(saved.readings).toHaveLength(1);
      expect(lines.join('\n')).toContain('HTTP 404');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints BOTH readings a stop confirmed across two runs rests on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      // The normal case: a run sees one launch, so the first breach is in the state file and the
      // second arrives now. The evidence line must show the pair, not the half it observed itself.
      writeFileSync(path, JSON.stringify({
        ...emptyState('W'), verdict: 'armed', streak: 1, readMints: [MINT],
        readings: [{ mint: MINT, at: '2026-06-04T12:08:52.000Z', share: 0.9, unread: null }],
      }));
      const lines: string[] = [];
      const responses: unknown[] = [
        // The listing carries both, which is how the second launch knows the first is its neighbour.
        // Its timestamp for the launch already in the state file is the one that reading was
        // recorded under, and the two are a day apart — inside the gap a real adjacency can span.
        { coins: [
          { mint: MINT, created_timestamp: Date.parse('2026-06-04T12:08:52.000Z') },
          { mint: MINT_2, created_timestamp: Date.parse('2026-06-05T12:08:52.000Z') },
        ] },
        page([
          rawRow({ slotIndexId: sid(101, 2), userAddress: 'out-2', amountSol: '1' }),
          rawRow({ slotIndexId: sid(101, 1), userAddress: 'cohort-a', tx: 'bundle', amountSol: '9' }),
          rawRow({ slotIndexId: sid(101, 0), userAddress: 'W', amountSol: '10' }),
        ], false, null),
      ];
      let i = 0;
      const result = await run(parseArgs(['--wallet', 'W', '--cohort', 'cohort-a', '--state', path, '--live']), {
        log: (l) => lines.push(l), sleepImpl: async () => undefined, nowImpl: () => 0,
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => responses[Math.min(i++, responses.length - 1)] } as unknown as Response)) as unknown as typeof fetch,
      });
      expect(result.state.verdict).toBe('stop-and-rotate');
      const evidence = lines.find((l) => l.includes('evidence:')) ?? '';
      expect(evidence).toContain('2026-06-04 share 0.900');
      expect(evidence).toContain('then');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reserves slots for the NEWEST launches, so a tail it cannot settle never stops it watching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      // Twelve unread launches, and the oldest ten are permanently unsettleable. Oldest-first alone
      // would spend the whole slice on them and never look at where the window actually is.
      const mints = Array.from({ length: 12 }, (_, i) => `${'M'.repeat(43 - String(i).length)}${i}`);
      const newest = mints[11] as string;
      const decided = page([
        rawRow({ slotIndexId: sid(400, 2), userAddress: 'out-1', amountSol: '1' }),
        rawRow({ slotIndexId: sid(400, 1), userAddress: 'cohort-a', tx: 'bundle', amountSol: '9' }),
        rawRow({ slotIndexId: sid(400, 0), userAddress: 'W', amountSol: '10' }),
      ], false, null);
      const stuck = { trades: [rawRow({ slotIndexId: sid(300, 0), userAddress: 'sniper' })] };
      const lines: string[] = [];
      const result = await run(parseArgs(['--wallet', 'W', '--cohort', 'cohort-a', '--state', path, '--live']), {
        log: (l) => lines.push(l), sleepImpl: async () => undefined, nowImpl: () => 0,
        fetchImpl: (async (url: string) => ({
          ok: true, status: 200,
          json: async () => (url.includes('/coins?')
            ? { coins: mints.map((mint, i) => ({ mint, created_timestamp: 1_780_000_000 + i })) }
            : url.includes(`/coins/${newest}/`) ? decided : stuck),
        } as unknown as Response)) as unknown as typeof fetch,
      });
      // The newest launch was reached despite ten unsettleable launches ahead of it in the queue.
      expect(result.state.readMints).toEqual([newest]);
      expect(result.read).toBe(1);
      expect(result.state.quarantine).toHaveLength(Number(THRESHOLDS.bounds['maxLaunchesPerRun']) - 1);
      // And the quarantine is legible rather than a count to infer from.
      const printed = lines.join('\n');
      expect(printed).toContain('QUARANTINE');
      expect(printed).toContain('no-cursor');
      expect(JSON.parse(readFileSync(path, 'utf8')).quarantine[0].reason).toBe('no-cursor');
      // The split never spends more than the pinned per-run bound.
      expect(result.read + result.undecided).toBeLessThanOrEqual(Number(THRESHOLDS.bounds['maxLaunchesPerRun']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never confirms a stop out of two readings that were not adjacent launches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      const mints = [MINT, MINT_2, 'HxwVtPmMBqbCPbjmVCkfSbFGpEbQoLZTKPnJLGXYpump'];
      const gap = mints[1] as string;
      const high = (slot: number) => page([
        rawRow({ slotIndexId: sid(slot, 2), userAddress: 'out-1', amountSol: '1' }),
        rawRow({ slotIndexId: sid(slot, 1), userAddress: 'cohort-a', tx: 'bundle', amountSol: '9' }),
        rawRow({ slotIndexId: sid(slot, 0), userAddress: 'W', amountSol: '10' }),
      ], false, null);
      const stuck = { trades: [rawRow({ slotIndexId: sid(300, 0), userAddress: 'sniper' })] };
      const listing = { coins: mints.map((mint, i) => ({ mint, created_timestamp: 1_780_000_000 + i })) };
      const args = ['--wallet', 'W', '--cohort', 'cohort-a', '--state', path, '--live'];
      const seams = (middle: unknown) => ({
        log: () => undefined, sleepImpl: async () => undefined, nowImpl: () => 0,
        fetchImpl: (async (url: string) => ({
          ok: true, status: 200,
          json: async () => (url.includes('/coins?') ? listing
            : url.includes(`/coins/${gap}/`) ? middle : high(500)),
        } as unknown as Response)) as unknown as typeof fetch,
      });

      // The first and third launches both read far above the bar, but the launch BETWEEN them could
      // not be settled — so they were never neighbours and must not confirm each other.
      const first = await run(parseArgs(args), seams(stuck));
      expect(first.read).toBe(2);
      expect(first.state.verdict).not.toBe('stop-and-rotate');
      expect(first.state.streak).toBe(1);

      // Closing the gap with a launch that is also above the bar makes them adjacent, and the stop
      // that was always there is raised — the rule suppresses nothing, it only refuses to invent.
      const second = await run(parseArgs(args), seams(high(501)));
      expect(second.state.verdict).toBe('stop-and-rotate');
      expect(second.state.stoppedAt).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a gap-closing reading that is BELOW the bar from being ignored', async () => {
    // The mirror of the test above: once the gap is closed by a low reading the two high readings
    // are still not consecutive, so the streak must reset rather than confirm.
    const readings = [
      { mint: 'a', at: '2026-06-01T00:00:00.000Z', share: 0.9, unread: null, prevMint: null },
      { mint: 'b', at: '2026-06-02T00:00:00.000Z', share: 0.1, unread: null, prevMint: 'a' },
      { mint: 'c', at: '2026-06-03T00:00:00.000Z', share: 0.9, unread: null, prevMint: 'b' },
    ];
    const settings = { bar: SHARE_BAR, confirmLaunches: CONFIRM_LAUNCHES };
    expect(chainsOf(orderReadings(readings))).toHaveLength(1);
    expect(resume({ ...emptyState('W'), readings }, settings).verdict).toBe('armed');
    // Drop the middle launch and the two highs are in different chains — still no stop.
    const split = [readings[0]!, readings[2]!];
    expect(chainsOf(orderReadings(split))).toHaveLength(2);
    expect(resume({ ...emptyState('W'), readings: split }, settings).verdict).toBe('armed');
  });

  it('refuses an adjacency the listing could only be claiming because a launch is missing from it', () => {
    // The listing lists by CURRENT creator, so a launch whose creator record has moved is absent and
    // its two neighbours name each other. Corroborate against the time between them: 4.04 days is
    // the widest gap the one open window on record contains between consecutive launches.
    const settings = { bar: SHARE_BAR, confirmLaunches: CONFIRM_LAUNCHES };
    const pair = (days: number) => [
      { mint: 'a', at: '2026-06-01T00:00:00.000Z', share: 0.9, unread: null, prevMint: null },
      { mint: 'b', at: new Date(Date.parse('2026-06-01T00:00:00.000Z') + days * 86_400_000).toISOString(),
        share: 0.9, unread: null, prevMint: 'a' },
    ];
    expect(chainsOf(orderReadings(pair(1)))).toHaveLength(1);
    expect(resume({ ...emptyState('W'), readings: pair(1) }, settings).verdict).toBe('stop-and-rotate');
    const wide = pair(Number(THRESHOLDS.detector.maxAdjacentGapDays) + 0.5);
    expect(chainsOf(orderReadings(wide))).toHaveLength(2);
    expect(resume({ ...emptyState('W'), readings: wide }, settings).verdict).toBe('armed');
  });

  it('orders readings without a non-transitive comparator, so untimestamped ones keep their order', () => {
    const readings = [
      { mint: 'x', at: '', share: 0.9, unread: null, prevMint: null },
      { mint: 'b', at: '2026-06-02T00:00:00.000Z', share: 0.9, unread: null, prevMint: 'a' },
      { mint: 'y', at: '', share: 0.9, unread: null, prevMint: null },
      { mint: 'a', at: '2026-06-01T00:00:00.000Z', share: 0.9, unread: null, prevMint: null },
    ];
    expect(orderReadings(readings).map((r) => r.mint)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('records NO adjacency on the --mints path, so argument order can never confirm a stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      const lines: string[] = [];
      const high = (slot: number) => page([
        rawRow({ slotIndexId: sid(slot, 2), userAddress: 'out-1', amountSol: '1' }),
        rawRow({ slotIndexId: sid(slot, 1), userAddress: 'cohort-a', tx: 'bundle', amountSol: '9' }),
        rawRow({ slotIndexId: sid(slot, 0), userAddress: 'W', amountSol: '10' }),
      ], false, null);
      const result = await run(parseArgs([
        '--wallet', 'W', '--cohort', 'cohort-a', '--mints', `${MINT},${MINT_2}`, '--state', path, '--live',
      ]), {
        log: (l) => lines.push(l), sleepImpl: async () => undefined, nowImpl: () => 0,
        fetchImpl: (async (url: string) => ({
          ok: true, status: 200, json: async () => high(url.includes(MINT_2) ? 501 : 500),
        } as unknown as Response)) as unknown as typeof fetch,
      });
      // Two readings well above the bar, and still no stop: nothing here says they were neighbours.
      expect(result.read).toBe(2);
      expect(result.state.readings.every((r) => r.prevMint === null)).toBe(true);
      expect(result.state.verdict).toBe('armed');
      // And the operator is told, in the run output, that this run cannot confirm one.
      expect(lines.join('\n')).toContain('can NEVER confirm a stop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an empty --cohort rather than crediting the whole create slot to outsiders', () => {
    // An empty Set is still a supplied cohort, so it would skip both the no-cohort-evidence guard
    // and the co-ordination fallback and push the share DOWN — towards "still open".
    expect(() => parseArgs(['--wallet', 'W', '--cohort', ','])).toThrow(/names no wallet/);
    expect(parseArgs(['--wallet', 'W', '--cohort', 'a,b']).cohort?.size).toBe(2);
  });

  it('validates the pinned fallback bound the same way it validates the flag', () => {
    expect(() => positiveInteger('--max-launches', undefined, undefined)).toThrow(/positive integer/);
    expect(positiveInteger('--max-launches', undefined, 8)).toBe(8);
  });

  it('drops a mint that is not base58-shaped and says so, rather than building a URL out of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      const lines: string[] = [];
      const result = await run(parseArgs(['--wallet', 'W', '--state', path, '--live']), {
        log: (l) => lines.push(l), sleepImpl: async () => undefined, nowImpl: () => 0,
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({
          coins: [{ mint: '../../evil', created_timestamp: 1000 }],
        }) } as unknown as Response)) as unknown as typeof fetch,
      });
      // One request — the listing — and nothing built out of the mint it could not read.
      expect(result.issued).toBe(1);
      expect(result.read).toBe(0);
      expect(lines.join('\n')).toContain('refused by shape');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops the run rather than reading an unreadable listing as an empty one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
    try {
      const path = join(dir, 's.json');
      await expect(run(parseArgs(['--wallet', 'W', '--state', path, '--live']), {
        log: () => undefined, sleepImpl: async () => undefined, nowImpl: () => 0,
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ message: 'nope' }) } as unknown as Response)) as unknown as typeof fetch,
      })).rejects.toThrow(/launch listing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------

const TOOL_DIR = fileURLToPath(new URL('../tools/window-decay-tripwire/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const ANALYSIS_DIR = fileURLToPath(new URL('../analysis/', import.meta.url));

function readAll(dir: string, prefix: string, pattern = /\.(ts|mjs|js)$/): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const [k, v] of readAll(full, `${prefix}${entry}/`, pattern)) out.set(k, v);
    } else if (pattern.test(entry)) out.set(`${prefix}${entry}`, readFileSync(full, 'utf8'));
  }
  return out;
}

describe('the keyless boundary holds around this tool', () => {
  it('opens a socket in exactly one file', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/window-decay-tripwire/')) {
      if (file === 'tools/window-decay-tripwire/client.mjs') continue;
      expect(/\bfetch\s*\(/.test(text), `${file} must not call fetch directly`).toBe(false);
    }
  });

  it('names no credential and contains no key-shaped string', () => {
    // Like `tools/graduated-life-tape/` and unlike `tools/deployer-screen/`, this tool has no keyed
    // half at all: the allowed list is EMPTY, and that is the guarantee — no request from this
    // directory can ever be metered, whatever a future edit does.
    for (const [file, text] of readAll(TOOL_DIR, 'tools/window-decay-tripwire/', /./)) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
      }
      expect(KEY_SHAPED.test(text), `${file} may contain a real key`).toBe(false);
    }
  });

  it('reaches no metered host, and never builds a URL for the endpoint that 403s this client', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/window-decay-tripwire/', /\.(mjs|js|md|json)$/)) {
      expect(/https?:\/\/[^\s'"]*publicnode/.test(text), `${file} must not build a publicnode URL`).toBe(false);
      expect(/https?:\/\/[^\s'"]*madeonsol/i.test(text), `${file} must not reach MadeOnSol`).toBe(false);
      expect(/https?:\/\/[^\s'"]*(helius|dune\.com)/i.test(text), `${file} must not reach a keyed provider`).toBe(false);
    }
    // The complete host list, in one place, both keyless.
    for (const host of HOSTS) expect(host.startsWith('https://')).toBe(true);
    expect(HOSTS).toHaveLength(2);
  });

  it('does not import src/, analysis/ or another tool, and is not imported by them', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/window-decay-tripwire/')) {
      expect(text, `${file} must not import from src/`).not.toMatch(/from\s+['"](\.\.\/)+src\//);
      expect(text, `${file} must not import from analysis/`).not.toMatch(/from\s+['"].*analysis\//);
      // The screen and tape lanes edit their own modules; a watcher that must run unchanged for
      // weeks does not couple itself to a moving file. The duplication is the deliberate cost.
      expect(text, `${file} must not import from another tool`).not.toMatch(
        /from\s+['"][^'"]*(deployer-screen|graduated-life-tape)/,
      );
    }
    for (const [file, text] of readAll(SRC_DIR, 'src/')) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
    for (const [file, text] of readAll(ANALYSIS_DIR, 'analysis/')) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
  });
});

describe('the pinned parameters and the README state the same thing', () => {
  const thresholds = JSON.parse(readFileSync(join(TOOL_DIR, 'thresholds.json'), 'utf8'));
  const readme = readFileSync(join(TOOL_DIR, 'README.md'), 'utf8');

  it('ships its method and its limits next to its code', () => {
    expect(existsSync(join(TOOL_DIR, 'README.md'))).toBe(true);
    expect(readme).toMatch(/## 10\. What this tool is not/);
    // The ceiling is not optional prose: it is the lane's result.
    expect(readme).toMatch(/n = 1/);
    expect(readme).toMatch(/gradual close/);
  });

  it('carries a stated reason for every pinned parameter', () => {
    // The standard `tools/deployer-screen/thresholds.json` sets: a value with no named anchor is a
    // value someone will move to fit an output.
    for (const block of ['detector', 'bounds'] as const) {
      const section = thresholds[block] as Record<string, unknown>;
      const justification = section['justification'] as Record<string, string>;
      expect(justification, `${block} must carry justifications`).toBeTypeOf('object');
      for (const key of Object.keys(section)) {
        if (key === '$comment' || key === 'justification') continue;
        expect(justification[key], `${block}.${key} has no stated reason`).toBeTypeOf('string');
        expect((justification[key] ?? '').length).toBeGreaterThan(80);
      }
    }
  });

  it('pins the same decision boundary the detector compiles in', () => {
    expect(thresholds.detector.shareBar).toBe(SHARE_BAR);
    expect(thresholds.detector.confirmLaunches).toBe(CONFIRM_LAUNCHES);
    expect(thresholds.bounds.maxPagesPerLaunch).toBe(MAX_PAGES_PER_LAUNCH);
    expect(thresholds.bounds.minIntervalMs).toBe(DEFAULT_MIN_INTERVAL_MS);
  });

  it('publishes the headline latency as a machine-checkable marker, so the README cannot drift', () => {
    const { steps } = replay();
    const l = latency(steps);
    const marker = (name: string) => {
      const found = readme.match(new RegExp(`<!-- ${name}:([0-9.]+) -->`));
      expect(found, `README must carry the ${name} marker`).not.toBeNull();
      return Number(found![1]);
    };
    expect(marker('close-speed-hours')).toBeCloseTo(l.closeSpeedHours, 1);
    expect(marker('alarm-hours')).toBeCloseTo(l.alarmHours ?? NaN, 1);
    expect(marker('avoided-hours')).toBeCloseTo(l.avoidedHours ?? NaN, 1);
    expect(marker('false-stops')).toBe(falseAlarms(steps).fired.length);
    expect(marker('open-window-population')).toBe(falseAlarms(steps).read);
    // The adjacency bound is prose in the README and a value in thresholds.json; pinned together so
    // moving the threshold cannot leave the README quietly wrong.
    expect(marker('max-adjacent-gap-days')).toBe(Number(THRESHOLDS.detector.maxAdjacentGapDays));
  });

  it('refuses an unusable adjacency bound rather than becoming a tripwire that can never fire', () => {
    // NaN would make every `gap <= NaN` false, break every chain at every step, and leave the tool
    // printing "watching" forever with nothing saying it had been disarmed.
    for (const bad of [undefined, 'four', NaN, Infinity, 0, -1]) {
      expect(() => positiveFinite(bad)).toThrow(/positive finite number/);
    }
    expect(positiveFinite(4.04)).toBe(4.04);
    expect(MAX_ADJACENT_GAP_MS).toBe(Number(THRESHOLDS.detector.maxAdjacentGapDays) * 86_400_000);
  });
});
