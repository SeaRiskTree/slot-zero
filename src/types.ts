import type { GrossSol, NetSol } from './units.js';

/**
 * The three views the dataset supports, typed so that the three mistakes documented in
 * `population-tape-2026-07-29/IMPORT.md` are compile errors rather than silently
 * wrong numbers.
 *
 * Naming rule, applied without exception: **any field carrying a tape-derived SOL amount
 * ends in `GrossOfFees` and is typed {@link GrossSol}.** If a name does not say
 * `GrossOfFees`, it is either not SOL or it came off the chain.
 */

// ---------------------------------------------------------------------------------
// Per launch
// ---------------------------------------------------------------------------------

/** Identity and on-chain census — present on all 239 launches, tape or no tape. */
export interface LaunchCore {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly createdUtc: string;
  readonly graduated: boolean;
  /** pump.fun's own ATH market cap. **A provider claim, single-sourced** (`report.md` §3.1). */
  readonly athMcapUsd: number | null;
  readonly athTS: number | null;
  /** pump.fun market cap at the 2026-07-29 01:30 UTC snapshot. Provider claim. */
  readonly mcapNowUsd: number | null;
  readonly twitter: string;
  /** pump.fun's *current* creator for this mint — it can move; see {@link creatorFieldMoved}. */
  readonly listedCreator: string;
  /** 1 when the listed creator is no longer the subject wallet (`report.md` §1.2). */
  readonly creatorFieldMoved: boolean;

  /** Bonding-curve transaction census over the token's whole life. Independent of the tape. */
  readonly chainTxTotal: number | null;
  readonly chainTxOk: number | null;
  readonly chainTxFailed: number | null;
  readonly chainTxOkFirst30s: number | null;
  readonly chainTxAllFirst30s: number | null;
  /**
   * Seconds to the last transaction the curve ever sees.
   *
   * **A bound on graduation, never a timing.** The curve keeps receiving *referencing*
   * transactions — bot sweeps moving no tokens — for months after the migration, so this
   * overshoots the real graduation by a median 8.85× and by up to a millionfold (`Bullieve`:
   * +1 s real, +1,036,042 s here). It is a true upper bound and useless as an estimate; do
   * not difference it against anything. `IMPORT.md` correction 4.
   */
  readonly curveLastTxS: number | null;
}

/**
 * The deployer's exit ladder, when it completed inside the tape window (228 of 235).
 * `dev_exit_complete = 1`.
 */
export interface DevExitComplete {
  readonly complete: true;
  readonly sells: number;
  readonly solInGrossOfFees: GrossSol;
  readonly solOutGrossOfFees: GrossSol;
  readonly netSolGrossOfFees: GrossSol;
  readonly firstSellS: number | null;
  /** Seconds from mint to the sell that takes the position to zero. */
  readonly zeroS: number | null;
}

/**
 * `dev_exit_complete = 0` — the seven large-buy launches (`report.md` §3.6) whose deployer
 * figures are **window-truncated and therefore wrong as whole-launch numbers**. The exit
 * happens at +91 s to +898 s, outside the tape window.
 *
 * There is deliberately no `netSolGrossOfFees` on this variant. The correct source is
 * `dev_position_timeline_large_buys.csv`, reconstructed from the deployer's own Token-2022
 * account — see {@link seeAlso}.
 */
export interface DevExitTruncated {
  readonly complete: false;
  readonly sells: number;
  readonly windowTruncatedSolInGrossOfFees: GrossSol;
  readonly windowTruncatedSolOutGrossOfFees: GrossSol;
  readonly windowTruncatedNetSolGrossOfFees: GrossSol;
  readonly firstSellS: number | null;
  readonly seeAlso: 'dev_position_timeline_large_buys.csv';
}

export type DevExit = DevExitComplete | DevExitTruncated;

/** A launch whose trade tape could not be reconstructed: `tape = none`. Four of them. */
export interface LaunchWithoutTape extends LaunchCore {
  readonly tape: 'none';
  readonly tapeWindowS: null;
  readonly dev: null;
}

/**
 * A launch with a reconstructed trade tape. **Every field below is bounded by
 * {@link tapeWindowS}** — 60 s on 210 launches, 120 s on 4, 300 s on 21 — and is wrong if
 * read as a whole-life figure.
 */
export interface LaunchWithTape extends LaunchCore {
  readonly tape: 'window' | 'full';
  readonly tapeWindowS: number;
  readonly nTrades: number;
  readonly nWallets: number;
  readonly dev: DevExit;

  /** SOL per token at the dev buy — the denominator of every `mult_vs_devbuy` in the data. */
  readonly priceDevbuy: number | null;
  readonly priceDevZero: number | null;
  readonly priceT60: number | null;
  readonly windowPeakPrice: number | null;
  readonly windowPeakTS: number | null;
  /** Highest in-window price as a multiple of the dev-buy price. **Not** the lifetime peak. */
  readonly windowPeakMult: number | null;
  /** Median SOL/USD implied by the tape's own paired `priceUsd`/`priceSol` on this launch. */
  readonly solUsd: number | null;

  readonly nCreateslotWallets: number | null;
  readonly nWallets30s: number | null;
  readonly nWinners30s: number | null;
  readonly nWinnersAll: number | null;
  readonly bestWallet: string;
  readonly bestWalletSolGrossOfFees: GrossSol | null;
  readonly best30sWallet: string;
  readonly best30sSolGrossOfFees: GrossSol | null;
}

export type Launch = LaunchWithoutTape | LaunchWithTape;

// ---------------------------------------------------------------------------------
// Per (wallet, launch)
// ---------------------------------------------------------------------------------

export interface PairCore {
  readonly mint: string;
  readonly symbol: string;
  readonly wallet: string;
  readonly tapeWindowS: number;
  readonly firstTS: number;
  readonly lastTS: number;
  readonly firstSlot: number;
  /** True when the wallet's first trade is in the same slot as the create transaction. */
  readonly inCreateSlot: boolean;
  /**
   * Slots between the create transaction and this wallet's first trade; 0 is the create
   * slot itself. One slot ≈ 400 ms. Derived — see {@link Tape.createSlot}.
   */
  readonly slotsAfterCreate: number | null;
  readonly nBuys: number;
  readonly nSells: number;
  readonly solInGrossOfFees: GrossSol;
  readonly solOutGrossOfFees: GrossSol;
  readonly tokensBought: number;
  readonly tokensSold: number;
  readonly residualTokens: number;
}

/**
 * A (wallet, launch) pair that is **flat by the end of the tape window** — 22,333 of 46,553
 * (48%). These are the only rows with a complete P&L, and the only rows the headline tables
 * in `report.md` §4 and §5 are computed over.
 */
export interface ClosedPair extends PairCore {
  readonly closedInWindow: true;
  /** `sol_out − sol_in`. Exact and complete. Still **gross of fees** (`report.md` §5.5). */
  readonly realisedSolGrossOfFees: GrossSol;
  readonly residualMarkWindowSolGrossOfFees: GrossSol;
  readonly residualMarkNowSolGrossOfFees: GrossSol;
  readonly pnlSolGrossOfFees: GrossSol;
  readonly pnlWindowMarkedSolGrossOfFees: GrossSol;
}

/**
 * A (wallet, launch) pair still holding at the end of the window — 24,220 of 46,553 (52%).
 * The wallet may have sold outside the window, so **its P&L is not known**: summing these
 * fabricates losses (`report.md` §4.1). As a population they are late, small and holding —
 * median stake 0.244 SOL, median entry +30 s, 89% never sell at all inside the window.
 *
 * There is no `realisedSolGrossOfFees` here. {@link incompleteRealisedSolGrossOfFees} is
 * the same CSV cell under a name that cannot be mistaken for a result, and the two residual
 * marks are the bounds the dataset offers instead — read both, per `report.md` §4.1.
 */
export interface OpenPair extends PairCore {
  readonly closedInWindow: false;
  /** `sol_out − sol_in` **truncated at the window edge**. Not a P&L. Do not aggregate. */
  readonly incompleteRealisedSolGrossOfFees: GrossSol;
  /** Residual marked at the last price seen inside the window. A bound, not a value. */
  readonly residualMarkWindowSolGrossOfFees: GrossSol;
  /** Residual marked at the token's latest known price. The other bound. */
  readonly residualMarkNowSolGrossOfFees: GrossSol;
}

export type WalletLaunchPair = ClosedPair | OpenPair;

// ---------------------------------------------------------------------------------
// Per wallet
// ---------------------------------------------------------------------------------

/**
 * One row per counterparty wallet, aggregated across launches (`counterparties.csv`,
 * 20,388 rows). All amounts **gross of fees**.
 *
 * The honest measure is {@link pnlClosedSolGrossOfFees}: the sum of `realised_sol` over
 * closed pairs only. The `…AllPairs…` fields include marked residuals and are conditional
 * on a mark holding.
 */
export interface WalletAggregate {
  readonly wallet: string;
  readonly launchesTraded: number;
  readonly launchesClosedInWindow: number;
  readonly launchesOpenAtWindowEnd: number;

  /** Sum of `realised_sol` over closed round trips only. The headline measure. */
  readonly pnlClosedSolGrossOfFees: GrossSol;
  readonly closedWins: number;
  /** `null` for the wallets that never closed a round trip — there is no rate to state. */
  readonly closedHitRate: number | null;
  readonly medianClosedPnlSolGrossOfFees: GrossSol | null;

  readonly launchesProfitable: number;
  readonly hitRate: number;
  /** Over **all** pairs, residuals marked. Conditional on the mark. */
  readonly pnlAllPairsSolGrossOfFees: GrossSol;
  readonly realisedAllPairsSolGrossOfFees: GrossSol;
  readonly pnlAllPairsUsdGrossOfFees: number;

  readonly solDeployedGrossOfFees: GrossSol;
  readonly solReturnedGrossOfFees: GrossSol;
  readonly nBuys: number;
  readonly nSells: number;
  readonly medianFirstTradeS: number | null;
  readonly medianPnlPerLaunchSolGrossOfFees: GrossSol | null;
  readonly launchesEnteredWithin30s: number;
  readonly launchesInCreateSlot: number;
}

// ---------------------------------------------------------------------------------
// Fee-inclusive: the only place NetSol comes from
// ---------------------------------------------------------------------------------

/** One row of `onchain_*.csv`: a (transaction, create-slot wallet) pair. */
export interface OnchainRow {
  readonly mint: string;
  readonly symbol: string;
  readonly tx: string;
  readonly slot: number;
  readonly wallet: string;
  readonly isFeePayer: boolean;
  /**
   * The transaction's **whole** fee (base + priority), attributed to its fee payer.
   * For a bundled transaction the fee payer is **not** the trader — see AGENTS.md.
   */
  readonly feeSol: NetSol;
  /** This wallet's true lamport change: fees, swap and rent already netted. */
  readonly netSol: NetSol;
  readonly tokenDelta: number;
}

/**
 * A (wallet, launch) create-slot round trip priced exactly on-chain — the only
 * fee-inclusive P&L in the dataset (`report.md` §5.5). 123 launches, 4,394 transactions.
 *
 * "Round trip" means the same thing here as `closed_in_window` does on the tape: the
 * wallet's net token delta over the launch is within 0.1% of what it bought.
 */
export interface OnchainRoundTrip {
  readonly mint: string;
  readonly wallet: string;
  /** True fee-inclusive P&L for this wallet on this launch. */
  readonly netSol: NetSol;
  /** Fees this wallet paid **as fee payer**. Zero when someone else paid for its bundle. */
  readonly feesPaidAsFeePayerSol: NetSol;
  readonly nTransactions: number;
  readonly tokensBought: number;
  readonly netTokenDelta: number;
  /** Membership of the six-wallet create-slot cohort (`report.md` §4.3). */
  readonly isCohort: boolean;
}
