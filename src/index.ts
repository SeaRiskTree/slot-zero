/**
 * slot-zero — the pump.fun launch-microstructure research lab.
 *
 * This package reads the `population-tape-2026-07-29` dataset — wherever
 * `config/data-root.mjs` says it lives, which defaults to the copy committed here — and exposes
 * it as three views: per launch, per wallet, and per (wallet, launch). It reaches the network
 * never, and reads no credential of any kind: every source behind this dataset is keyless and
 * public.
 *
 * Three things it makes hard to get wrong, because each of them silently corrupted an
 * analysis during the research:
 *
 * 1. **Tape-derived P&L is gross of fees.** Those amounts are {@link GrossSol}, a brand
 *    that cannot be added to the fee-inclusive {@link NetSol}, and every field carrying one
 *    is named `…GrossOfFees`. Only `onchain_*.csv` — {@link Tape.onchainRoundTrips} — is
 *    fee-inclusive. `report.md` §5.5: one wallet is +31.2 SOL on the tape and −12.2 SOL in
 *    reality after 11.9 SOL of priority fees.
 * 2. **Only `closed_in_window` rows have a complete P&L** (48%). A {@link ClosedPair} has
 *    `realisedSolGrossOfFees`; an {@link OpenPair} does not have the field at all.
 * 3. **`dev_exit_complete = 0`** marks seven window-truncated launches. A
 *    {@link DevExitTruncated} has no `netSolGrossOfFees` — only a `windowTruncated…` field
 *    and a pointer to the file that has the real number.
 *
 * A fourth guard came from the funding graph rather than from the tape: `EgQX9R3Q…`, one of
 * the two winning outsiders, is **one wallet of a book** whose total this repo does not hold —
 * the book has since been measured by `slot-zero-bankroll-book-pnl/report.md`, whose figures are
 * another lane's to import — so a {@link BookMemberOutsider} has no `wallet` field to filter a
 * P&L table by. See {@link SETTLED_OUTSIDERS}.
 */

export { Tape, DEFAULT_DATA_DIR, type TapeOptions } from './tape.js';

export {
  parseWindowTape,
  readWindowMeta,
  readWindowTape,
  type WindowMeta,
  type WindowTrade,
} from './window.js';

/**
 * pump.fun bonding-curve constants (`report.md` §3.5). Graduation is not a measurement —
 * it is a fixed point on the curve, and the loader carries the parameters so that "did it
 * graduate" and "what was its peak" are the same question.
 */
export const CURVE = {
  /** Initial virtual SOL reserves. */
  initialVirtualSol: 30,
  /** Initial virtual token reserves. */
  initialVirtualTokens: 1_073_000_000,
  /** Tokens the curve will sell before graduating. */
  sellableTokens: 793_100_000,
  /** SOL per token at the very start of the curve. */
  get initialPriceSol(): number {
    return this.initialVirtualSol / this.initialVirtualTokens;
  },
  /**
   * Graduation price as a multiple of the initial price — **14.70×, a constant**,
   * independent of the deployer's stake. Confirmed empirically on 18 launches whose tape
   * window spans graduation; see test/reproduction.test.ts.
   */
  get graduationMultOfInitialPrice(): number {
    const k = this.initialVirtualSol * this.initialVirtualTokens;
    const tokensLeft = this.initialVirtualTokens - this.sellableTokens;
    return k / tokensLeft / tokensLeft / this.initialPriceSol;
  },
} as const;

export {
  BOOK_MEMBER_OUTSIDER,
  CREATE_SLOT_COHORT,
  DEPLOYER,
  GROSS_NET_SIGN_FLIP_WALLET,
  INDEPENDENT_OUTSIDER,
  REPEAT_LOSERS,
  SETTLED_OUTSIDERS,
  independentOutsiderWallets,
  isCohort,
  type BookMemberOutsider,
  type IndependentOutsider,
  type Outsider,
} from './cohort.js';

export {
  fractionPositive,
  grossSol,
  lamportsToNetSol,
  medianGross,
  medianNet,
  netSol,
  percentile,
  sumGross,
  sumNet,
  unsafeUnbrand,
  type GrossSol,
  type NetSol,
  type Sol,
} from './units.js';

export type {
  ClosedPair,
  DevExit,
  DevExitComplete,
  DevExitTruncated,
  Launch,
  LaunchCore,
  LaunchWithTape,
  LaunchWithoutTape,
  OnchainRoundTrip,
  OnchainRow,
  OpenPair,
  PairCore,
  WalletAggregate,
  WalletLaunchPair,
} from './types.js';
