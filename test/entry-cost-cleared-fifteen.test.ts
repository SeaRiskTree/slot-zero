/**
 * The entry-cost lane's own arithmetic — the parts of it that decide a published figure.
 *
 * **Nothing here reaches the network and nothing reads a credential.** The lane's spending half
 * (`price-entry.mjs`) is imported for its exported pure functions only; its `main()` runs behind an
 * exact invoked-directly guard, so importing the module opens no socket.
 *
 * Three things are pinned:
 *
 * 1. **The confidence intervals are hand-rolled numerics, and their validation was prose.** The
 *    report claims `clopperPearson` reproduces the census's five published intervals; that claim is
 *    asserted here over those five (k, n) pairs plus the degenerate ends, so a regression in the
 *    continued fraction, the lgamma or the bisection fails a test rather than moving a published
 *    interval silently.
 * 2. **The lane ceiling is a bound by construction**, not by projection: per-candidate grants sum to
 *    the lane's own ceiling whatever the endpoint does.
 * 3. **A lane-caused unmeasured verdict is machine-distinguishable from a provider one**, which is
 *    the distinction captain decision 174b turns on, and it must not claim a leg the lane did not
 *    bound.
 */

import { describe, expect, it } from 'vitest';

import {
  LANE_RPC_CEILING,
  assertResultPathWritable,
  censusLaunchRefs,
  costCeilingFor,
  laneUnmeasuredCauseFor,
  resultPathFor,
} from '../tools/deployer-screen/measurements/2026-08-10-entry-cost-cleared-fifteen/price-entry.mjs';
import {
  clopperPearson,
  summarise,
} from '../tools/deployer-screen/measurements/2026-08-10-entry-cost-cleared-fifteen/summarise.mjs';

describe('the exact interval, against the census’s own published five', () => {
  // Published to four decimal places in `slot-zero-july-stage3-census` → `report.md` (held in
  // firstmate's records, not in this repo), which is what the lane's report cites as its validation.
  const PUBLISHED: [number, number, number, number][] = [
    [15, 369, 0.0229, 0.0662],
    [0, 6, 0.0, 0.4593],
    [0, 22, 0.0, 0.1544],
    [353, 5399, 0.0589, 0.0723],
    [7, 101, 0.0283, 0.1376],
  ];

  for (const [k, n, lo, hi] of PUBLISHED) {
    it(`reproduces ${k}/${n} as [${lo.toFixed(4)}, ${hi.toFixed(4)}]`, () => {
      const ci = clopperPearson(k, n);
      expect(ci).not.toBeNull();
      expect(ci!.k).toBe(k);
      expect(ci!.n).toBe(n);
      expect(ci!.rate).toBeCloseTo(k / n, 12);
      expect(Number(ci!.lo.toFixed(4))).toBe(lo);
      expect(Number(ci!.hi.toFixed(4))).toBe(hi);
    });
  }

  it('pins the two ends exactly rather than approximately — k = 0 has lower bound 0, k = n upper bound 1', () => {
    expect(clopperPearson(0, 22)!.lo).toBe(0);
    expect(clopperPearson(9, 9)!.hi).toBe(1);
    // ...and the other end of each is a real bound, not the degenerate one.
    expect(clopperPearson(9, 9)!.lo).toBeGreaterThan(0.6);
    expect(clopperPearson(9, 9)!.lo).toBeLessThan(1);
  });

  it('returns null for n = 0 — an interval over nothing is not an interval', () => {
    expect(clopperPearson(0, 0)).toBeNull();
  });

  it('brackets the point estimate and never leaves [0, 1]', () => {
    for (const [k, n] of [
      [6, 15],
      [6, 12],
      [1, 3],
      [2, 2],
    ]) {
      const ci = clopperPearson(k!, n!)!;
      expect(ci.lo).toBeGreaterThanOrEqual(0);
      expect(ci.hi).toBeLessThanOrEqual(1);
      expect(ci.lo).toBeLessThanOrEqual(ci.rate);
      expect(ci.hi).toBeGreaterThanOrEqual(ci.rate);
    }
  });

  it('reproduces the two headline Stage 3 intervals the report states', () => {
    const attempted = clopperPearson(6, 15)!;
    expect(Number(attempted.lo.toFixed(4))).toBe(0.1634);
    expect(Number(attempted.hi.toFixed(4))).toBe(0.6771);
    const decided = clopperPearson(6, 12)!;
    expect(Number(decided.lo.toFixed(4))).toBe(0.2109);
    expect(Number(decided.hi.toFixed(4))).toBe(0.7891);
  });
});

describe('the lane ceiling bounds the spend by construction', () => {
  it('never grants more than the pinned per-candidate ceiling, nor more than remains', () => {
    expect(costCeilingFor(500, 0, 1400)).toBe(500);
    expect(costCeilingFor(500, 1100, 1400)).toBe(300);
    expect(costCeilingFor(500, 1400, 1400)).toBe(0);
    // A ceiling already overrun cannot hand out a negative — or, worse, wrap into a fresh budget.
    expect(costCeilingFor(500, 1600, 1400)).toBe(0);
  });

  it('sums to the lane ceiling however many candidates ask for it', () => {
    let spent = 0;
    for (let i = 0; i < 50; i++) {
      const granted = costCeilingFor(500, spent);
      // The worst case is a candidate spending every request it was granted.
      spent += granted;
    }
    expect(spent).toBe(LANE_RPC_CEILING);
  });
});

describe('a lane-caused unmeasured verdict says so, and only when the lane caused it', () => {
  const truncated = { stoppedForBudget: true, launchesSkippedForBudget: 1 };

  it('fires on a leg the lane truncated mid-walk, which is the case it exists for', () => {
    // The three real ones: granted 122 / 17 / 8 against the pinned 500, all stopped for budget.
    for (const granted of [122, 17, 8]) {
      expect(
        laneUnmeasuredCauseFor({
          verdict: 'entry-cost-unmeasured',
          ceilingGranted: granted,
          pinnedPerCandidate: 500,
          cost: truncated,
        }),
      ).toBe('lane-rpc-ceiling');
    }
  });

  it('fires when the lane granted nothing at all', () => {
    expect(
      laneUnmeasuredCauseFor({
        verdict: 'entry-cost-unmeasured',
        ceilingGranted: 0,
        pinnedPerCandidate: 500,
        cost: { stoppedForBudget: false, launchesSkippedForBudget: 0 },
      }),
    ).toBe('lane-rpc-ceiling');
  });

  it('does NOT claim a leg the lane bounded but never bit', () => {
    // A reduced grant that finished its work is the vendor's or the chain's story, not the lane's.
    expect(
      laneUnmeasuredCauseFor({
        verdict: 'entry-cost-unmeasured',
        ceilingGranted: 386,
        pinnedPerCandidate: 500,
        cost: { stoppedForBudget: false, launchesSkippedForBudget: 0 },
      }),
    ).toBeNull();
  });

  it('does NOT claim a leg run at the full pinned ceiling', () => {
    expect(
      laneUnmeasuredCauseFor({
        verdict: 'entry-cost-unmeasured',
        ceilingGranted: 500,
        pinnedPerCandidate: 500,
        cost: truncated,
      }),
    ).toBeNull();
  });

  it('is null on every candidate that reached a verdict', () => {
    for (const verdict of [
      'entry-open-after-costs',
      'entry-field-loss-making',
      'entry-room-absent',
      'entry-cost-prohibitive',
    ]) {
      expect(
        laneUnmeasuredCauseFor({ verdict, ceilingGranted: 8, pinnedPerCandidate: 500, cost: truncated }),
      ).toBeNull();
    }
  });
});

describe('a partial run cannot replace the published artifact', () => {
  it('writes a --only run beside result.json, never over it', () => {
    expect(resultPathFor(null).endsWith('/result.json')).toBe(true);
    expect(resultPathFor('WALLET1').endsWith('/result-only-WALLET1.json')).toBe(true);
    expect(resultPathFor('WALLET1')).not.toBe(resultPathFor(null));
    // Two partial runs of different wallets do not collide either.
    expect(resultPathFor('WALLET2')).not.toBe(resultPathFor('WALLET1'));
  });

  it('refuses to replace a wider record with a narrower one', () => {
    const fifteen = JSON.stringify({ candidates: new Array(15).fill({}) });
    expect(() => assertResultPathWritable('/x/result.json', 1, () => fifteen)).toThrow(/15/);
    expect(() => assertResultPathWritable('/x/result.json', 1, () => fifteen)).toThrow(
      /Refusing to replace a wider record/,
    );
  });

  it('allows re-running the same population, and allows a wider one', () => {
    const fifteen = JSON.stringify({ candidates: new Array(15).fill({}) });
    expect(() => assertResultPathWritable('/x/result.json', 15, () => fifteen)).not.toThrow();
    expect(() => assertResultPathWritable('/x/result.json', 20, () => fifteen)).not.toThrow();
  });

  it('allows a first write, and refuses an unreadable artifact rather than clobbering it', () => {
    expect(() => assertResultPathWritable('/x/result.json', 1, () => null)).not.toThrow();
    expect(() => assertResultPathWritable('/x/result.json', 1, () => 'not json')).toThrow(/not readable JSON/);
  });
});

describe('the roll-up says whether it covers the whole census', () => {
  const partial = {
    thresholdsMinPricedFraction: 0.8,
    candidates: [
      {
        measuredToday: {
          verdict: 'entry-open-after-costs',
          unmeasuredCause: null,
          entryCostPerSolStakedByLaunch: { median: 0.03, n: 3 },
          entryCostPriced: { rate: 1, hits: 3, n: 3 },
        },
        coverage: {
          cost: { ran: true, launchesPriced: 3, transactionsTargeted: 9, transactionsPriced: 9 },
        },
      },
    ],
  };

  it('flags a one-candidate record as NOT the published population', () => {
    const s = summarise(partial, { maxEntryCostPerSolStaked: 0.12, censusCandidates: 15 });
    expect(s.attempted).toBe(1);
    expect(s.censusCandidates).toBe(15);
    expect(s.coversWholeCensus).toBe(false);
  });

  it('reports a whole-population record as covering the census', () => {
    const s = summarise(partial, { maxEntryCostPerSolStaked: 0.12, censusCandidates: 1 });
    expect(s.coversWholeCensus).toBe(true);
  });

  it('refuses a record that does not state the priced-fraction bar it applied', () => {
    expect(() =>
      summarise({ ...partial, thresholdsMinPricedFraction: undefined }, { censusCandidates: 1 }),
    ).toThrow(/thresholdsMinPricedFraction/);
  });
});

describe('the pinned population is refused rather than quietly reshaped', () => {
  it('refuses an unparsable mint instant, naming the window', () => {
    expect(() =>
      censusLaunchRefs({
        deployer: 'DEPLOYER1',
        windows: [{ mint: 'MINT1', mintedUtc: 'not-a-date' }],
      } as never),
    ).toThrow(/MINT1/);
  });

  it('returns the census windows newest first when they all parse', () => {
    const refs = censusLaunchRefs({
      deployer: 'DEPLOYER1',
      windows: [
        { mint: 'OLD', mintedUtc: '2026-07-28T00:00:00.000Z' },
        { mint: 'NEW', mintedUtc: '2026-08-09T00:00:00.000Z' },
      ],
    } as never);
    expect(refs.map((r) => r.mint)).toEqual(['NEW', 'OLD']);
  });
});
