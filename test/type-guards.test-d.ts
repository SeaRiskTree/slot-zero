/**
 * Compile-time proof that the four guards bite.
 *
 * Every `@ts-expect-error` below is an assertion: if the mistake it describes ever becomes
 * legal, `tsc --noEmit` fails with "Unused '@ts-expect-error' directive". This file is
 * type-checked (it is inside `tsconfig.json`'s `include`) and never executed — it is the
 * only place in the repo where wrong code is written on purpose.
 *
 * Run it with `npm run typecheck`.
 */

import {
  Tape,
  grossSol,
  medianGross,
  medianNet,
  netSol,
  sumGross,
  sumNet,
  type BookMemberOutsider,
  type ClosedPair,
  type GrossSol,
  type IndependentOutsider,
  type Launch,
  type NetSol,
  type OpenPair,
  type Outsider,
  type WalletLaunchPair,
} from '../src/index.js';

declare const tape: Tape;
declare const gross: GrossSol;
declare const net: NetSol;

// -- 1. gross-of-fees SOL cannot be mistaken for real money ------------------------

// @ts-expect-error a tape amount is not a chain amount
const _a: NetSol = gross;

// @ts-expect-error a chain amount is not a tape amount
const _b: GrossSol = net;

// @ts-expect-error you cannot total a gross column as if fees were in it
const _c: NetSol = sumGross([gross, gross]);

// @ts-expect-error you cannot feed gross amounts to the fee-inclusive aggregator
const _d = sumNet([gross]);

// @ts-expect-error you cannot feed chain amounts to the tape aggregator
const _e = medianGross([net]);

// @ts-expect-error a raw number is neither, and cannot be laundered into one
const _f = sumGross([1.5]);

// @ts-expect-error mixing the two in one array is the corruption itself
const _g = medianNet([net, gross]);

// The escape hatches exist, and they are explicit at the call site.
const _ok1: GrossSol = grossSol(1.5);
const _ok2: NetSol = netSol(1.5);
const _ok3: NetSol = sumNet([net, net]);

// -- 2. an open pair has no complete P&L -------------------------------------------

declare const pair: WalletLaunchPair;
declare const open: OpenPair;
declare const closed: ClosedPair;

// @ts-expect-error an open pair has no realised P&L; only a truncated, unusable figure
const _h = open.realisedSolGrossOfFees;

// @ts-expect-error and you cannot reach it through the union without discriminating
const _i = pair.realisedSolGrossOfFees;

// @ts-expect-error nor can you sum the union as if every row were complete
const _j = sumGross([pair.realisedSolGrossOfFees]);

// Discriminating is the only route, and it is one line.
if (pair.closedInWindow) {
  const _ok4: GrossSol = pair.realisedSolGrossOfFees;
}
const _ok5: GrossSol = closed.realisedSolGrossOfFees;
const _ok6: readonly ClosedPair[] = tape.closedRoundTrips();

// The open pair's truncated figure is reachable, under a name nobody misreads.
const _ok7: GrossSol = open.incompleteRealisedSolGrossOfFees;

// -- 3. a window-truncated dev exit has no complete net figure ----------------------

declare const launch: Launch;

if (launch.tape !== 'none') {
  // @ts-expect-error the dev exit may be truncated; the field is not on both variants
  const _k = launch.dev.netSolGrossOfFees;

  if (launch.dev.complete) {
    const _ok8: GrossSol = launch.dev.netSolGrossOfFees;
    const _ok9: number | null = launch.dev.zeroS;
  } else {
    // @ts-expect-error a truncated exit never reached zero inside the window
    const _l = launch.dev.zeroS;
    const _ok10: GrossSol = launch.dev.windowTruncatedNetSolGrossOfFees;
    const _ok11: 'dev_position_timeline_large_buys.csv' = launch.dev.seeAlso;
  }
}

// @ts-expect-error an un-taped launch has no trade-derived fields at all
const _m = launch.nTrades;

// -- 4. a book member is not an independent observation -----------------------------
//
// `EgQX9R3Q…` is a settled outsider (kol-cohort-vs-outsider-funding §4) and one wallet of a
// sniping book of at least five whose total this repo does not hold (its §8.1) — the book has
// since been measured by slot-zero-bankroll-book-pnl/report.md, whose figures are another lane's
// to import. Its +47.1 SOL and its book-mate `2CQgjcdN…`'s −12.2 SOL are the same operator's, so
// reading its address off the union and filtering a P&L table by it produces a number that is one
// leg of a total this dataset cannot see. That filter must not be writable by accident.

declare const outsider: Outsider;
declare const book: BookMemberOutsider;
declare const independent: IndependentOutsider;
declare const onchainWallet: string;

// @ts-expect-error one of the two settled outsiders is one leg of an unmeasured book, so the
// union has no `wallet` to filter a P&L table by
const _n = outsider.wallet;

// @ts-expect-error nor has the book member itself — its address is under a name that says so
const _o = book.wallet;

// @ts-expect-error and the comparison that would build the filter cannot be written either
const _p = onchainWallet === outsider.wallet;

// @ts-expect-error a book member cannot stand in where an independent observation is wanted
const _q: IndependentOutsider = book;

// Discriminating is the only route, and it is one line.
if (outsider.unit === 'wallet') {
  const _ok12: string = outsider.wallet;
} else {
  const _ok13: string = outsider.oneWalletOfAnUnmeasuredBook;
  // The book it belongs to, and a pointer to the measurement this repo does not hold, are right
  // beside it.
  const _ok14: readonly string[] = outsider.bookMates;
  const _ok15: string = outsider.seeAlso;
}
const _ok16: string = independent.wallet;
const _ok17: string = book.oneWalletOfAnUnmeasuredBook;

// Silence "declared but never read" for the intentional bindings above.
export type _Unused = [
  typeof _a, typeof _b, typeof _c, typeof _d, typeof _e, typeof _f, typeof _g,
  typeof _h, typeof _i, typeof _j, typeof _m,
  typeof _n, typeof _o, typeof _p, typeof _q,
  typeof _ok1, typeof _ok2, typeof _ok3, typeof _ok5, typeof _ok6, typeof _ok7,
  typeof _ok16, typeof _ok17,
];
