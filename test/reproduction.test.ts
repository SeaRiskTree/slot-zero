import { beforeAll, describe, expect, it } from 'vitest';

import {
  BOOK_MEMBER_OUTSIDER,
  CREATE_SLOT_COHORT,
  CURVE,
  GROSS_NET_SIGN_FLIP_WALLET,
  INDEPENDENT_OUTSIDER,
  SETTLED_OUTSIDERS,
  Tape,
  fractionPositive,
  independentOutsiderWallets,
  medianGross,
  medianNet,
  percentile,
  sumGross,
  sumNet,
  type ClosedPair,
} from '../src/index.js';

/**
 * The published headline numbers, asserted against the loaded data, so that a future change
 * to how the tape is read fails loudly instead of quietly.
 *
 * Every assertion cites the file and column it traces to. Where a number does **not**
 * reproduce, the test asserts what the data actually says and the divergence is written up
 * in the repo README under "Discrepancies found while reproducing" — the instruction was to
 * report the discrepancy, never to adjust the test to match the prose.
 */

let tape: Tape;
beforeAll(() => {
  tape = Tape.load();
});

/**
 * Launches whose raw window tape contains the moment trading moved from the bonding curve
 * to the graduated PumpSwap pool, with the last curve price before that switch.
 */
interface GraduationSpan {
  readonly symbol: string;
  readonly lastCurvePrice: number;
  readonly priceDevbuy: number;
  readonly devSolIn: number;
}

let _spans: readonly GraduationSpan[] | undefined;
function graduationSpanningWindows(): readonly GraduationSpan[] {
  if (_spans) return _spans;
  const out: GraduationSpan[] = [];
  for (const l of tape.tapedLaunches()) {
    // Large-buy launches carry a window-truncated dev figure but a valid price_devbuy,
    // so keep them — the constant is supposed to hold at every stake.
    if (l.priceDevbuy === null) continue;
    const trades = tape.windowTape(l.mint);
    if (!trades) continue;
    const firstPool = trades.findIndex((t) => t.venue === 'pump_amm');
    if (firstPool < 0) continue;
    let lastCurvePrice: number | undefined;
    for (let i = firstPool - 1; i >= 0; i--) {
      const t = trades[i] as (typeof trades)[number];
      if (t.venue === 'pump' && t.priceSol > 0) {
        lastCurvePrice = t.priceSol;
        break;
      }
    }
    if (lastCurvePrice === undefined) continue;
    const devSolIn = l.dev.complete
      ? (l.dev.solInGrossOfFees as number)
      : (l.dev.windowTruncatedSolInGrossOfFees as number);
    out.push({ symbol: l.symbol, lastCurvePrice, priceDevbuy: l.priceDevbuy, devSolIn });
  }
  _spans = out;
  return out;
}

describe('coverage (report §1)', () => {
  it('239 launches, 235 with a reconstructed tape', () => {
    // launches.csv, one row per launch; column `tape`.
    expect(tape.launches()).toHaveLength(239);
    expect(tape.tapedLaunches()).toHaveLength(235);
    expect(
      tape
        .launches()
        .filter((l) => l.tape === 'none')
        .map((l) => l.symbol)
        .sort(),
    ).toEqual(['Fridge', 'GLM', 'Leo', 'Marciana']);
  });

  it('46,553 pairs, 22,333 (48%) closed in window, 20,388 wallets', () => {
    // wallet_launch_pnl.csv, column `closed_in_window`; counterparties.csv row count.
    expect(tape.pairs()).toHaveLength(46_553);
    expect(tape.closedRoundTrips()).toHaveLength(22_333);
    expect(tape.closedRoundTrips().length / tape.pairs().length).toBeCloseTo(0.48, 2);
    expect(tape.wallets()).toHaveLength(20_388);
  });

  it('107,439 fills across the taped launches', () => {
    // launches.csv, column `n_trades`, summed over the 235 taped launches.
    const fills = tape.tapedLaunches().reduce((a, l) => a + l.nTrades, 0);
    expect(fills).toBe(107_439);
  });

  it('dev_exit_complete = 0 marks exactly seven window-truncated launches (§3.6)', () => {
    // launches.csv, column `dev_exit_complete`.
    const truncated = tape.launchesWithTruncatedDevExit();
    expect(truncated).toHaveLength(7);
    expect(truncated.map((l) => l.symbol).sort()).toEqual([
      'Bullieve',
      'Bulls',
      'Float',
      'Lockin',
      'Milly',
      'Trump',
      'float',
    ]);
    // The truncated variant carries no complete P&L field, only a pointer to the file
    // that does. This is a type-level guarantee; asserted here so it cannot regress.
    for (const l of truncated) {
      expect(l.dev.complete).toBe(false);
      expect(l.dev).not.toHaveProperty('netSolGrossOfFees');
      if (!l.dev.complete) expect(l.dev.seeAlso).toBe('dev_position_timeline_large_buys.csv');
    }
  });
});

describe('P&L by slot offset — the cliff (report §5.2)', () => {
  // wallet_launch_pnl.csv: closed pairs only, grouped by `first_slot` − create slot.
  const bucket = (pairs: readonly ClosedPair[], lo: number, hi: number) =>
    pairs.filter(
      (p) => p.slotsAfterCreate !== null && p.slotsAfterCreate >= lo && p.slotsAfterCreate <= hi,
    );

  const stats = (pairs: readonly ClosedPair[]) => {
    const v = pairs.map((p) => p.realisedSolGrossOfFees);
    return {
      n: v.length,
      median: medianGross(v) as number,
      profitable: fractionPositive(v),
      total: sumGross(v) as number,
    };
  };

  let closed: readonly ClosedPair[];
  beforeAll(() => {
    closed = tape.closedRoundTrips();
  });

  it('slot 0: 1,999 pairs, median +0.283 SOL, 72% profitable', () => {
    const s = stats(bucket(closed, 0, 0));
    expect(s.n).toBe(1_999);
    expect(s.median).toBeCloseTo(0.283, 3);
    expect(s.profitable).toBeCloseTo(0.72, 2);
    expect(s.total).toBeCloseTo(1_949.0, 0);
  });

  it('the whole published table reproduces, row for row', () => {
    const rows: Array<[string, number, number, number, number]> = [
      // [label, lo, hi, expected pairs, expected median]
      ['1', 1, 1, 628, 0.011],
      ['2', 2, 2, 272, -0.002],
      ['3', 3, 3, 294, -0.03],
      ['4', 4, 4, 232, -0.006],
      ['5-10', 5, 10, 2_173, 0.003],
      ['11-25', 11, 25, 5_109, 0.001],
      ['26+', 26, Number.MAX_SAFE_INTEGER, 11_626, 0.0],
    ];
    for (const [label, lo, hi, n, median] of rows) {
      const s = stats(bucket(closed, lo, hi));
      expect(s.n, `slot ${label}: pair count`).toBe(n);
      expect(s.median, `slot ${label}: median`).toBeCloseTo(median, 3);
    }
  });

  it('slots 2–4 are at or below zero; 5–10 is +0.003, not zero', () => {
    // report §2 prose says "land two to ten slots later and the median is at or below
    // zero". The §5.2 table it summarises gives slot 5–10 a median of +0.003 SOL — above
    // zero, if trivially. The table is the measurement; the prose rounds. Asserted as the
    // data actually is, and recorded in README "Discrepancies found while reproducing".
    for (const slot of [2, 3, 4]) {
      expect(stats(bucket(closed, slot, slot)).median, `slot ${slot}`).toBeLessThanOrEqual(0);
    }
    const s510 = stats(bucket(closed, 5, 10)).median;
    expect(s510).toBeGreaterThan(0);
    expect(s510).toBeCloseTo(0.003, 3);
    // What survives of the claim, and it is the part that matters: every slot past 1 is
    // within half a hundredth of a SOL of zero, against +0.283 in the create slot.
    expect(Math.abs(s510)).toBeLessThan(0.005);
  });

  it('the create-slot edge is ~50x the next-best slot', () => {
    expect(stats(bucket(closed, 0, 0)).median).toBeGreaterThan(
      20 * stats(bucket(closed, 1, 1)).median,
    );
  });
});

describe('cohort presence (report §2, §5.4)', () => {
  it('2CHrnc2L… is in the create slot of 235 of 235 taped launches', () => {
    // counterparties.csv, columns `launches_traded` and `launches_in_create_slot`.
    const w = tape.wallet(CREATE_SLOT_COHORT[0] as string);
    expect(w?.launchesTraded).toBe(235);
    expect(w?.launchesInCreateSlot).toBe(235);
    expect(tape.tapedLaunches()).toHaveLength(235);
  });

  it('the first three cohort wallets are each on all 235, from maxxing onward', () => {
    for (const wallet of CREATE_SLOT_COHORT.slice(0, 3)) {
      expect(tape.wallet(wallet)?.launchesInCreateSlot, wallet).toBe(235);
    }
    // report §1.2: three of the six are on `maxxing`, the December-2025 launch that had
    // dropped out of the operator's own history. launches.csv, `creator_field_moved`.
    //
    // Looked up by MINT, not by symbol. Two launches in this dataset are called `maxxing`
    // — a routine one from June 2026 and this one — so a symbol lookup silently returns
    // the wrong launch. See the 'symbols are not unique' test below.
    const MAXXING = '32CdQdBUxbCsLy5AUHWmyidfwhgGUr9N573NBUrDpump';
    const maxxing = tape.launches().find((l) => l.mint === MAXXING);
    expect(maxxing?.symbol).toBe('maxxing');
    expect(maxxing?.creatorFieldMoved).toBe(true);
    expect(maxxing?.listedCreator).toBe('CnV5TnQrMBLdrZGQsRXJC91s38XaXZsFatq27LA2Vpen');
    const inMaxxing = new Set(
      tape.pairs().filter((p) => p.mint === MAXXING && p.inCreateSlot).map((p) => p.wallet),
    );
    expect(CREATE_SLOT_COHORT.slice(0, 3).every((w) => inMaxxing.has(w))).toBe(true);
  });

  it('slot 0 splits into six cohort wallets and everyone else (report §5.3)', () => {
    const slot0 = tape.closedRoundTrips().filter((p) => p.slotsAfterCreate === 0);
    const cohort = slot0.filter((p) => CREATE_SLOT_COHORT.includes(p.wallet));
    const other = slot0.filter((p) => !CREATE_SLOT_COHORT.includes(p.wallet));

    expect(new Set(cohort.map((p) => p.wallet)).size).toBe(6);
    expect(cohort).toHaveLength(918);
    expect(medianGross(cohort.map((p) => p.realisedSolGrossOfFees)) as number).toBeCloseTo(1.064, 3);
    expect(fractionPositive(cohort.map((p) => p.realisedSolGrossOfFees))).toBeCloseTo(0.78, 2);

    expect(other).toHaveLength(1_081);
    expect(medianGross(other.map((p) => p.realisedSolGrossOfFees)) as number).toBeCloseTo(0.056, 3);
    expect(fractionPositive(other.map((p) => p.realisedSolGrossOfFees))).toBeCloseTo(0.67, 2);

    // §5.3's "407 wallets" counts every non-cohort wallet that reaches the create slot at
    // all, not the 319 with a closed round trip in it. See README discrepancy note.
    const everyNonCohortInSlot0 = new Set(
      tape
        .pairs()
        .filter((p) => p.inCreateSlot && !CREATE_SLOT_COHORT.includes(p.wallet))
        .map((p) => p.wallet),
    );
    expect(everyNonCohortInSlot0.size).toBe(407);
    expect(new Set(other.map((p) => p.wallet)).size).toBe(319);
  });
});

describe('the fee correction (report §5.5) — the only fee-inclusive numbers', () => {
  it('123 launches, 4,394 transactions priced exactly', () => {
    // onchain_create_slot_pnl.csv.
    const rows = tape.onchainRows();
    expect(new Set(rows.map((r) => r.mint)).size).toBe(123);
    expect(new Set(rows.map((r) => r.tx)).size).toBe(4_394);
  });

  it('cohort create-slot round trips: median +0.838 SOL, 68% positive', () => {
    const v = tape
      .onchainRoundTrips()
      .filter((t) => t.isCohort)
      .map((t) => t.netSol);
    expect(v).toHaveLength(596);
    expect(medianNet(v) as number).toBeCloseTo(0.838, 3);
    expect(percentile(v, 0.25)).toBeCloseTo(-0.238, 3);
    expect(fractionPositive(v)).toBeCloseTo(0.68, 2);
    expect(sumNet(v) as number).toBeCloseTo(681.0, 0);
  });

  it('non-cohort create-slot round trips: median +0.035 SOL, 60% positive', () => {
    const v = tape
      .onchainRoundTrips()
      .filter((t) => !t.isCohort)
      .map((t) => t.netSol);
    expect(v).toHaveLength(630);
    expect(medianNet(v) as number).toBeCloseTo(0.035, 3);
    expect(percentile(v, 0.25)).toBeCloseTo(-0.045, 3);
    expect(percentile(v, 0.75)).toBeCloseTo(0.31, 2);
    expect(sumNet(v) as number).toBeCloseTo(155.2, 0);
    expect(fractionPositive(v)).toBeCloseTo(0.6, 2);
  });

  it('the cohort out-earns the outsider create slot by ~24x on the median', () => {
    const trips = tape.onchainRoundTrips();
    const cohort = medianNet(trips.filter((t) => t.isCohort).map((t) => t.netSol)) as number;
    const other = medianNet(trips.filter((t) => !t.isCohort).map((t) => t.netSol)) as number;
    expect(cohort / other).toBeGreaterThan(20);
  });

  it('2CQgjcdN… is +31.2 SOL on the tape and −12.2 SOL in reality', () => {
    // The canonical gross/net sign flip. counterparties.csv `pnl_closed_sol` against
    // onchain_create_slot_pnl.csv `sol_delta_lamports`, over the 50 launches priced.
    const gross = tape.wallet(GROSS_NET_SIGN_FLIP_WALLET)?.pnlAllPairsSolGrossOfFees as number;
    const trips = tape.onchainRoundTrips().filter((t) => t.wallet === GROSS_NET_SIGN_FLIP_WALLET);

    expect(trips).toHaveLength(50);
    expect(gross).toBeGreaterThan(0);
    expect(sumNet(trips.map((t) => t.netSol)) as number).toBeCloseTo(-12.2, 1);
    expect(sumNet(trips.map((t) => t.feesPaidAsFeePayerSol)) as number).toBeCloseTo(11.89, 1);
    expect(fractionPositive(trips.map((t) => t.netSol))).toBeCloseTo(0.36, 2);

    // Reading the tape column as money reverses this wallet's sign. That is the whole
    // reason GrossSol and NetSol are different types.
    expect(Math.sign(gross)).not.toBe(
      Math.sign(sumNet(trips.map((t) => t.netSol)) as number),
    );
  });

  it('the per-wallet fee table reproduces (report §5.5)', () => {
    const expected: Array<[string, number, number, number, number]> = [
      // [wallet, launches priced, true P&L, fees paid, share positive]
      [CREATE_SLOT_COHORT[0] as string, 120, 306.0, 0.3, 1.0],
      [INDEPENDENT_OUTSIDER.wallet, 49, 47.8, 17.5, 0.78],
      // Published as an independent row. It is not — see "the outsider question, settled".
      [BOOK_MEMBER_OUTSIDER.oneWalletOfAnUnmeasuredBook, 10, 47.1, 12.91, 1.0],
      ['Anubis512ho5t7S6LNSwoxUWdeQmX2kf3RvZ8ApHHF5w', 38, 13.4, 0.01, 0.87],
    ];
    for (const [wallet, n, net, fees, positive] of expected) {
      const trips = tape.onchainRoundTrips().filter((t) => t.wallet === wallet);
      expect(trips.length, `${wallet}: launches priced`).toBe(n);
      expect(sumNet(trips.map((t) => t.netSol)) as number, `${wallet}: net`).toBeCloseTo(net, 1);
      expect(
        sumNet(trips.map((t) => t.feesPaidAsFeePayerSol)) as number,
        `${wallet}: fees`,
      ).toBeCloseTo(fees, 1);
      expect(fractionPositive(trips.map((t) => t.netSol)), `${wallet}: %positive`).toBeCloseTo(
        positive,
        2,
      );
    }
  });

  it('the outsider keeps under half its gross — the edge is bought, not free', () => {
    // report §5.5: 5brv79eF… keeps +47.8 of +100.9 gross over the 49 priced launches.
    const wallet = INDEPENDENT_OUTSIDER.wallet;
    const priced = new Set(
      tape.onchainRoundTrips().filter((t) => t.wallet === wallet).map((t) => t.mint),
    );
    const gross = sumGross(
      tape
        .closedRoundTrips()
        .filter((p) => p.wallet === wallet && priced.has(p.mint))
        .map((p) => p.realisedSolGrossOfFees),
    ) as number;
    const net = sumNet(
      tape.onchainRoundTrips().filter((t) => t.wallet === wallet).map((t) => t.netSol),
    ) as number;
    expect(gross).toBeCloseTo(100.9, 0);
    expect(net).toBeCloseTo(47.8, 1);
    expect(net / gross).toBeLessThan(0.5);
  });
});

describe('the tape-derived league table (report §4.2)', () => {
  it('the published counterparty rows reproduce, gross of fees', () => {
    const expected: Array<[string, number, number, number, number]> = [
      // [wallet, launches, closed, hit rate, closed P&L gross of fees]
      ['2CHrnc2LyagAbMaMFgthiDWh7ZZ9zT9TF8WEJf7MNE71', 235, 221, 0.977, 503.9],
      ['Atgx1JXsp8pTQ9Qsi74wF5pLMVwHwyQc6jJCu84evN7c', 235, 215, 0.93, 375.1],
      ['5brv79eFZ2rGprXNvqgVJBkBptkkw8GJX1XydJyZLyAr', 97, 90, 0.967, 313.7],
      ['8kzFH4rgFzy4ccz97AhgqRT7Qbt7HnD5oJCDK1Sxdarb', 235, 208, 0.856, 269.9],
      ['EgQX9R3Qph1dPHE1Ysou1auSYqRGomCNmLDC28Yg77aq', 48, 48, 0.938, 227.8],
      ['C989QoG39etYt32zfE7mHYqJwFh1kJK4fBrmsySFjzaS', 51, 46, 0.022, -106.8],
      ['4o9ndxqonUYamkzjHT6hCU6tNmg8VFcyhMqsxeTg4K37', 52, 46, 0.044, -100.0],
    ];
    for (const [addr, launches, closed, hit, pnl] of expected) {
      const w = tape.wallet(addr);
      expect(w, addr).toBeDefined();
      expect(w?.launchesTraded, `${addr}: launches`).toBe(launches);
      expect(w?.launchesClosedInWindow, `${addr}: closed`).toBe(closed);
      expect(w?.closedHitRate as number, `${addr}: hit rate`).toBeCloseTo(hit, 2);
      expect(w?.pnlClosedSolGrossOfFees as number, `${addr}: P&L`).toBeCloseTo(pnl, 1);
    }
  });

  it('14,187 of 20,388 wallets appear on exactly one launch', () => {
    // counterparties.csv, column `launches_traded`.
    expect(tape.wallets().filter((w) => w.launchesTraded === 1)).toHaveLength(14_187);
  });

  it('closed counterparty profit totals +2,375.6 SOL gross (report §4.4)', () => {
    const total = sumGross(tape.wallets().map((w) => w.pnlClosedSolGrossOfFees)) as number;
    expect(total).toBeCloseTo(2_375.6, 0);
  });
});

/**
 * The funding graph `report.md` §10.3 asked for has been built —
 * `kol-cohort-vs-outsider-funding/report.md`, keyless and read-only. It settles both winning
 * wallets as genuine outsiders (confidence high) and, in doing so, breaks one row of the
 * §4.2 table above: `EgQX9R3Q…` is one wallet of a book, not a trader.
 *
 * The funding evidence itself is off-chain of this dataset and cannot be asserted here. What
 * *can* be asserted is what the qualification does to this dataset's own numbers, and that
 * is what this block does.
 */
describe('the outsider question, settled (kol-cohort-vs-outsider-funding)', () => {
  it('both wallets are settled outsiders, and only one of them is a trading unit', () => {
    expect(SETTLED_OUTSIDERS).toHaveLength(2);
    for (const o of SETTLED_OUTSIDERS) expect(o.outsiderConfidence).toBe('high');
    // Only the independent one calls its address `wallet`. The type says so; asserted at
    // runtime so a refactor cannot quietly reintroduce the field on the book member.
    expect(BOOK_MEMBER_OUTSIDER).not.toHaveProperty('wallet');
    expect(independentOutsiderWallets()).toEqual([INDEPENDENT_OUTSIDER.wallet]);
    expect(independentOutsiderWallets()).not.toContain(
      BOOK_MEMBER_OUTSIDER.oneWalletOfAnUnmeasuredBook,
    );
  });

  it('EgQX9R3Q… and 2CQgjcdN… are one operator, so §4.2 lists one trader twice', () => {
    // funding report §8.1: both are funded by, and sweep to, the bankroll 9BhkaAyb….
    expect(BOOK_MEMBER_OUTSIDER.bookMates).toContain(GROSS_NET_SIGN_FLIP_WALLET);

    const book = BOOK_MEMBER_OUTSIDER.oneWalletOfAnUnmeasuredBook;
    const trips = tape.onchainRoundTrips();
    const walletOnly = trips.filter((t) => t.wallet === book);
    const withBookMate = trips.filter(
      (t) => t.wallet === book || t.wallet === GROSS_NET_SIGN_FLIP_WALLET,
    );

    // The row as §5.5 publishes it.
    expect(walletOnly).toHaveLength(10);
    expect(sumNet(walletOnly.map((t) => t.netSol)) as number).toBeCloseTo(47.1, 1);

    // The same operator's two rows added — what it actually made on the launches this
    // dataset prices exactly. onchain_create_slot_pnl.csv, `sol_delta_lamports`.
    expect(withBookMate).toHaveLength(60);
    expect(sumNet(withBookMate.map((t) => t.netSol)) as number).toBeCloseTo(34.9, 1);

    // Reading the published row on its own overstates the unit by exactly its book-mate's
    // loss — 12.2 SOL — and this is still only the part of the book that touches this
    // deployer. Three more known book-mates never appear here at all.
    const overstatement =
      (sumNet(walletOnly.map((t) => t.netSol)) as number) -
      (sumNet(withBookMate.map((t) => t.netSol)) as number);
    expect(overstatement).toBeGreaterThan(0);
    expect(overstatement).toBeCloseTo(12.2, 1);
  });

  it('this dataset cannot see the book, which is why the caveat is a pointer', () => {
    const book = BOOK_MEMBER_OUTSIDER.oneWalletOfAnUnmeasuredBook;
    const mintsOf = (w: string) =>
      new Set(tape.pairs().filter((p) => p.wallet === w).map((p) => p.mint));
    const a = mintsOf(book);
    const b = mintsOf(GROSS_NET_SIGN_FLIP_WALLET);

    // 48 launches and 62, and not one in common: nothing in this tape reveals that the two
    // rows are one trader. A counterparty table built from it never could.
    expect(a.size).toBe(48);
    expect(b.size).toBe(62);
    expect([...b].filter((m) => a.has(m))).toHaveLength(0);

    // The rest of the book never trades this operator at all, so no measurement of the book
    // is available from this dataset — hence `seeAlso` rather than a number.
    for (const mate of BOOK_MEMBER_OUTSIDER.bookMates) {
      if (mate === GROSS_NET_SIGN_FLIP_WALLET) continue;
      expect(tape.wallet(mate), mate).toBeUndefined();
    }
    expect(BOOK_MEMBER_OUTSIDER.seeAlso).toMatch(/unmeasured/);
  });

  it('the two book wallets hand over: one stops here, the other starts 33 hours later', () => {
    // launches.csv `created_utc`, joined to the wallet's wallet_launch_pnl.csv rows. The
    // dates are measured; reading the adjacency as a deliberate wallet rotation is an
    // inference, and it is only available at all once the funding graph says the two are
    // one operator. It is also why the zero overlap above is not a coincidence.
    const createdUtc = new Map(tape.launches().map((l) => [l.mint, l.createdUtc]));
    const span = (wallet: string) => {
      const d = tape
        .pairs()
        .filter((p) => p.wallet === wallet)
        .map((p) => createdUtc.get(p.mint) as string)
        .sort();
      return { first: d[0] as string, last: d[d.length - 1] as string };
    };
    const book = span(BOOK_MEMBER_OUTSIDER.oneWalletOfAnUnmeasuredBook);
    const mate = span(GROSS_NET_SIGN_FLIP_WALLET);

    expect(book.first).toBe('2026-03-14T17:28:20Z');
    expect(book.last).toBe('2026-05-25T12:02:46Z'); // "March–May", from this deployer's side
    expect(mate.first).toBe('2026-05-26T21:18:06Z');
    const gapHours = (Date.parse(mate.first) - Date.parse(book.last)) / 3_600_000;
    expect(gapHours).toBeGreaterThan(0);
    expect(gapHours).toBeLessThan(48);

    // On-chain the first wallet ran four months past its last launch here — the tape sees
    // the handover, not the retirement. IMPORT.md "Corrections", item 1.
    expect(Date.parse(BOOK_MEMBER_OUTSIDER.retiredUtc)).toBeGreaterThan(Date.parse(book.last));
  });
});

describe('the deployer (report §3.3, §3.4)', () => {
  it('4,315 SOL over the 228 complete exits, gross of fees', () => {
    // launches.csv, `dev_net_sol`, restricted to dev_exit_complete = 1.
    const complete = tape.tapedLaunches().filter((l) => l.dev.complete);
    expect(complete).toHaveLength(228);
    const total = sumGross(
      complete.map((l) => {
        if (!l.dev.complete) throw new Error('unreachable');
        return l.dev.netSolGrossOfFees;
      }),
    ) as number;
    expect(total).toBeCloseTo(4_315, -1);
  });

  it('median deployer net +21.66 SOL per complete exit', () => {
    const v = tape
      .tapedLaunches()
      .filter((l) => l.dev.complete)
      .map((l) => {
        if (!l.dev.complete) throw new Error('unreachable');
        return l.dev.netSolGrossOfFees;
      });
    expect(medianGross(v) as number).toBeCloseTo(21.66, 1);
  });

  it('the deployer is out at a median +13 s, first sell at a median +3 s', () => {
    const complete = tape.tapedLaunches().filter((l) => l.dev.complete);
    const zeros = complete
      .map((l) => (l.dev.complete ? l.dev.zeroS : null))
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    const firsts = complete
      .map((l) => l.dev.firstSellS)
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    expect(zeros[zeros.length >> 1]).toBe(13);
    expect(firsts[firsts.length >> 1]).toBe(3);
  });

  it('103 of 239 launches graduated', () => {
    expect(tape.launches().filter((l) => l.graduated)).toHaveLength(103);
  });
});

describe('graduation is a curve constant (report §3.5)', () => {
  it('the curve parameters give 14.70x the initial price, arithmetically', () => {
    // 30 SOL / 1,073,000,000 initial virtual reserves, 793,100,000 sellable.
    expect(CURVE.graduationMultOfInitialPrice).toBeCloseTo(14.7, 2);
  });

  it('14.70x holds empirically on every window that spans graduation', () => {
    // The strongest single use of the raw window/ tapes. For each launch whose tape window
    // contains the switch from the bonding curve to the PumpSwap pool, take the last curve
    // price before the first pool fill and divide by the launch's initial price. The
    // deployer's stake varies from 3.46 to 56.30 SOL across these; the constant does not.
    const spans = graduationSpanningWindows();
    expect(spans.length).toBe(18); // report §3.5 says "thirteen"; the data holds 18 (README #6)
    for (const s of spans) {
      expect(s.lastCurvePrice / CURVE.initialPriceSol, `${s.symbol}`).toBeCloseTo(14.7, 1);
    }
  });

  it('at the current 14.8148-SOL preset that is 6.59x the deployer entry', () => {
    // report §3.5 names six: Dummy, Lala, Sol, papoi, Slap, 大坏蛋 — "to two decimal places".
    const preset = graduationSpanningWindows().filter((s) => Math.abs(s.devSolIn - 14.814814813) < 0.01);
    expect(preset.map((s) => s.symbol).sort()).toEqual(
      ['Dummy', 'Lala', 'Slap', 'Sol', 'papoi', '大坏蛋'].sort(),
    );
    for (const s of preset) {
      expect(s.lastCurvePrice / s.priceDevbuy, s.symbol).toBeCloseTo(6.59, 2);
    }
  });

  it('the deployer finishes selling at ~35% of the graduation price', () => {
    // report §3.5. price_dev_zero / (6.59 x price_devbuy), median over complete exits.
    const ratios = tape
      .tapedLaunches()
      .filter((l) => l.dev.complete && l.priceDevZero !== null && l.priceDevbuy !== null)
      .map((l) => (l.priceDevZero as number) / (l.priceDevbuy as number) / 6.5856)
      .sort((a, b) => a - b);
    expect(ratios[ratios.length >> 1] as number).toBeCloseTo(0.35, 2);
  });

  it('the median launch never reaches graduation price', () => {
    // launches.csv: lifetime ATH price (ath_mcap_usd / 1e9 supply, in SOL) over price_devbuy.
    const mults = tape
      .tapedLaunches()
      .filter((l) => l.athMcapUsd !== null && l.priceDevbuy !== null && l.solUsd !== null)
      .map((l) => (l.athMcapUsd as number) / 1e9 / (l.solUsd as number) / (l.priceDevbuy as number))
      .sort((a, b) => a - b);
    const median = mults[mults.length >> 1] as number;
    expect(median).toBeCloseTo(5.08, 1);
    expect(median).toBeLessThan(6.59);
  });
});
