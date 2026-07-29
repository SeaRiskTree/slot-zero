import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bool, num, numOrNull, readCsv, str, type CsvRow } from './csv.js';
import { isCohort } from './cohort.js';
import { grossSol, lamportsToNetSol, netSol, type GrossSol, type NetSol } from './units.js';
import { readWindowMeta, readWindowTape, type WindowMeta, type WindowTrade } from './window.js';
import type {
  ClosedPair,
  DevExit,
  Launch,
  LaunchCore,
  OnchainRoundTrip,
  OnchainRow,
  OpenPair,
  WalletAggregate,
  WalletLaunchPair,
} from './types.js';

/** The imported dataset. Everything is on disk; nothing here opens a socket. */
export const DEFAULT_DATA_DIR = fileURLToPath(
  new URL('../data/population-tape-2026-07-29/', import.meta.url),
);

const g = (row: CsvRow, col: string): GrossSol => grossSol(num(row, col));
const gOrNull = (row: CsvRow, col: string): GrossSol | null => {
  const v = numOrNull(row, col);
  return v === null ? null : grossSol(v);
};

// ---------------------------------------------------------------------------------

function readLaunch(row: CsvRow): Launch {
  const core: LaunchCore = {
    mint: str(row, 'mint'),
    symbol: str(row, 'symbol'),
    name: str(row, 'name'),
    createdUtc: str(row, 'created_utc'),
    graduated: bool(row, 'graduated'),
    athMcapUsd: numOrNull(row, 'ath_mcap_usd'),
    athTS: numOrNull(row, 'ath_t_s'),
    mcapNowUsd: numOrNull(row, 'mcap_now_usd'),
    twitter: str(row, 'twitter'),
    listedCreator: str(row, 'listed_creator'),
    creatorFieldMoved: bool(row, 'creator_field_moved'),
    chainTxTotal: numOrNull(row, 'chain_tx_total'),
    chainTxOk: numOrNull(row, 'chain_tx_ok'),
    chainTxFailed: numOrNull(row, 'chain_tx_failed'),
    chainTxOkFirst30s: numOrNull(row, 'chain_tx_ok_first30s'),
    chainTxAllFirst30s: numOrNull(row, 'chain_tx_all_first30s'),
    curveLastTxS: numOrNull(row, 'curve_last_tx_s'),
  };

  const tape = str(row, 'tape');
  if (tape === 'none') return { ...core, tape: 'none', tapeWindowS: null, dev: null };
  if (tape !== 'window' && tape !== 'full') throw new Error(`unknown tape coverage '${tape}'`);

  const sells = num(row, 'dev_sells');
  const solIn = g(row, 'dev_sol_in');
  const solOut = g(row, 'dev_sol_out');
  const net = g(row, 'dev_net_sol');
  const firstSellS = numOrNull(row, 'dev_first_sell_s');

  // `dev_exit_complete = 0` marks the seven large-buy launches (report §3.6) whose
  // deployer figures are window-truncated. The two variants are not interchangeable.
  const dev: DevExit = bool(row, 'dev_exit_complete')
    ? {
        complete: true,
        sells,
        solInGrossOfFees: solIn,
        solOutGrossOfFees: solOut,
        netSolGrossOfFees: net,
        firstSellS,
        zeroS: numOrNull(row, 'dev_zero_s'),
      }
    : {
        complete: false,
        sells,
        windowTruncatedSolInGrossOfFees: solIn,
        windowTruncatedSolOutGrossOfFees: solOut,
        windowTruncatedNetSolGrossOfFees: net,
        firstSellS,
        seeAlso: 'dev_position_timeline_large_buys.csv',
      };

  return {
    ...core,
    tape,
    tapeWindowS: num(row, 'tape_window_s'),
    nTrades: num(row, 'n_trades'),
    nWallets: num(row, 'n_wallets'),
    dev,
    priceDevbuy: numOrNull(row, 'price_devbuy'),
    priceDevZero: numOrNull(row, 'price_dev_zero'),
    priceT60: numOrNull(row, 'price_t60'),
    windowPeakPrice: numOrNull(row, 'window_peak_price'),
    windowPeakTS: numOrNull(row, 'window_peak_t_s'),
    windowPeakMult: numOrNull(row, 'window_peak_mult'),
    solUsd: numOrNull(row, 'sol_usd'),
    nCreateslotWallets: numOrNull(row, 'n_createslot_wallets'),
    nWallets30s: numOrNull(row, 'n_wallets_30s'),
    nWinners30s: numOrNull(row, 'n_winners_30s'),
    nWinnersAll: numOrNull(row, 'n_winners_all'),
    bestWallet: str(row, 'best_wallet'),
    bestWalletSolGrossOfFees: gOrNull(row, 'best_wallet_sol'),
    best30sWallet: str(row, 'best_30s_wallet'),
    best30sSolGrossOfFees: gOrNull(row, 'best_30s_sol'),
  };
}

function readPair(row: CsvRow, createSlot: ReadonlyMap<string, number>): WalletLaunchPair {
  const mint = str(row, 'mint');
  const firstSlot = num(row, 'first_slot');
  const cs = createSlot.get(mint);
  const core = {
    mint,
    symbol: str(row, 'symbol'),
    wallet: str(row, 'wallet'),
    tapeWindowS: num(row, 'tape_window_s'),
    firstTS: num(row, 'first_t_s'),
    lastTS: num(row, 'last_t_s'),
    firstSlot,
    inCreateSlot: bool(row, 'in_create_slot'),
    slotsAfterCreate: cs === undefined ? null : firstSlot - cs,
    nBuys: num(row, 'n_buys'),
    nSells: num(row, 'n_sells'),
    solInGrossOfFees: g(row, 'sol_in'),
    solOutGrossOfFees: g(row, 'sol_out'),
    tokensBought: num(row, 'tokens_bought'),
    tokensSold: num(row, 'tokens_sold'),
    residualTokens: num(row, 'residual_tokens'),
  } as const;

  const markWindow = g(row, 'residual_mark_window_sol');
  const markNow = g(row, 'residual_mark_now_sol');

  if (bool(row, 'closed_in_window')) {
    const closed: ClosedPair = {
      ...core,
      closedInWindow: true,
      realisedSolGrossOfFees: g(row, 'realised_sol'),
      residualMarkWindowSolGrossOfFees: markWindow,
      residualMarkNowSolGrossOfFees: markNow,
      pnlSolGrossOfFees: g(row, 'pnl_sol_gross_of_fees'),
      pnlWindowMarkedSolGrossOfFees: g(row, 'pnl_window_marked_sol'),
    };
    return closed;
  }
  const open: OpenPair = {
    ...core,
    closedInWindow: false,
    incompleteRealisedSolGrossOfFees: g(row, 'realised_sol'),
    residualMarkWindowSolGrossOfFees: markWindow,
    residualMarkNowSolGrossOfFees: markNow,
  };
  return open;
}

function readWallet(row: CsvRow): WalletAggregate {
  return {
    wallet: str(row, 'wallet'),
    launchesTraded: num(row, 'launches_traded'),
    launchesClosedInWindow: num(row, 'launches_closed_in_window'),
    launchesOpenAtWindowEnd: num(row, 'launches_open_at_window_end'),
    pnlClosedSolGrossOfFees: g(row, 'pnl_closed_sol'),
    closedWins: num(row, 'closed_wins'),
    closedHitRate: numOrNull(row, 'closed_hit_rate'),
    medianClosedPnlSolGrossOfFees: gOrNull(row, 'median_closed_pnl_sol'),
    launchesProfitable: num(row, 'launches_profitable'),
    hitRate: num(row, 'hit_rate'),
    pnlAllPairsSolGrossOfFees: g(row, 'pnl_sol_gross_of_fees'),
    realisedAllPairsSolGrossOfFees: g(row, 'realised_sol'),
    pnlAllPairsUsdGrossOfFees: num(row, 'pnl_usd_gross_of_fees'),
    solDeployedGrossOfFees: g(row, 'sol_deployed'),
    solReturnedGrossOfFees: g(row, 'sol_returned'),
    nBuys: num(row, 'n_buys'),
    nSells: num(row, 'n_sells'),
    medianFirstTradeS: numOrNull(row, 'median_first_trade_s'),
    medianPnlPerLaunchSolGrossOfFees: gOrNull(row, 'median_pnl_per_launch_sol'),
    launchesEnteredWithin30s: num(row, 'launches_entered_within_30s'),
    launchesInCreateSlot: num(row, 'launches_in_create_slot'),
  };
}

function readOnchainRow(row: CsvRow, hasSymbol: boolean): OnchainRow {
  return {
    mint: str(row, 'mint'),
    symbol: hasSymbol ? str(row, 'symbol') : '',
    tx: str(row, 'tx'),
    slot: num(row, 'slot'),
    wallet: str(row, 'wallet'),
    isFeePayer: bool(row, 'is_fee_payer'),
    feeSol: lamportsToNetSol(num(row, 'fee_lamports')),
    netSol: lamportsToNetSol(num(row, 'sol_delta_lamports')),
    tokenDelta: num(row, 'token_delta'),
  };
}

/**
 * "Flat" for the on-chain pass, matching the tape's `closed_in_window` rule: net token
 * delta within 0.1% of tokens bought. This tolerance is what reproduces `report.md` §5.5
 * exactly (630 non-cohort round trips, median +0.035 SOL); a stricter `=== 0` gives 627 and
 * +0.036, which is how the loader's own test caught the difference.
 */
const FLAT_TOLERANCE = 0.001;

function foldOnchain(rows: readonly OnchainRow[]): OnchainRoundTrip[] {
  type Acc = { net: number; fees: number; n: number; bought: number; delta: number };
  const acc = new Map<string, Acc>();
  const keyed = new Map<string, { mint: string; wallet: string }>();

  for (const r of rows) {
    const key = `${r.mint} ${r.wallet}`;
    let a = acc.get(key);
    if (!a) {
      a = { net: 0, fees: 0, n: 0, bought: 0, delta: 0 };
      acc.set(key, a);
      keyed.set(key, { mint: r.mint, wallet: r.wallet });
    }
    a.net += r.netSol as number;
    if (r.isFeePayer) a.fees += r.feeSol as number;
    a.n += 1;
    a.delta += r.tokenDelta;
    if (r.tokenDelta > 0) a.bought += r.tokenDelta;
  }

  const out: OnchainRoundTrip[] = [];
  for (const [key, a] of acc) {
    const k = keyed.get(key) as { mint: string; wallet: string };
    out.push({
      mint: k.mint,
      wallet: k.wallet,
      netSol: netSol(a.net),
      feesPaidAsFeePayerSol: netSol(a.fees),
      nTransactions: a.n,
      tokensBought: a.bought,
      netTokenDelta: a.delta,
      isCohort: isCohort(k.wallet),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------

export interface TapeOptions {
  /** Override the dataset directory. Defaults to the copy committed in this repo. */
  readonly dataDir?: string;
}

/**
 * The loaded population tape. Files are parsed lazily and memoised, so reading only
 * `launches` does not pay for the 46,553-row pair table.
 *
 * ```ts
 * const tape = Tape.load();
 * const slot0 = tape.closedRoundTrips().filter((p) => p.slotsAfterCreate === 0);
 * medianGross(slot0.map((p) => p.realisedSolGrossOfFees));   // +0.283 — gross of fees
 * ```
 */
export class Tape {
  readonly dataDir: string;

  private _launches?: readonly Launch[];
  private _pairs?: readonly WalletLaunchPair[];
  private _wallets?: readonly WalletAggregate[];
  private _createSlot?: ReadonlyMap<string, number>;
  private _onchainRows?: readonly OnchainRow[];
  private _onchainRoundTrips?: readonly OnchainRoundTrip[];

  private constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  static load(options: TapeOptions = {}): Tape {
    const dir = options.dataDir ?? DEFAULT_DATA_DIR;
    if (!existsSync(join(dir, 'launches.csv'))) {
      throw new Error(`no population tape at ${dir} (expected launches.csv)`);
    }
    return new Tape(dir);
  }

  private path(file: string): string {
    return join(this.dataDir, file);
  }

  // -- per launch ------------------------------------------------------------------

  /** All 239 launches, tape or no tape. `launches.csv`. */
  launches(): readonly Launch[] {
    this._launches ??= readCsv(this.path('launches.csv')).map(readLaunch);
    return this._launches;
  }

  /** The 235 launches with a reconstructed trade tape. */
  tapedLaunches(): readonly Extract<Launch, { tape: 'window' | 'full' }>[] {
    return this.launches().filter(
      (l): l is Extract<Launch, { tape: 'window' | 'full' }> => l.tape !== 'none',
    );
  }

  /**
   * The seven launches with `dev_exit_complete = 0` — deployer figures window-truncated,
   * correct source `dev_position_timeline_large_buys.csv` (`report.md` §3.6).
   */
  launchesWithTruncatedDevExit(): readonly Extract<Launch, { tape: 'window' | 'full' }>[] {
    return this.tapedLaunches().filter((l) => !l.dev.complete);
  }

  /**
   * The create slot of each launch, derived as the slot of the pairs flagged
   * `in_create_slot`. `launches.csv` carries no create-slot column, so this is the only
   * route to `slotsAfterCreate` — the axis `report.md` §5.2's cliff is measured on.
   */
  createSlotByMint(): ReadonlyMap<string, number> {
    if (!this._createSlot) {
      const m = new Map<string, number>();
      for (const row of readCsv(this.path('wallet_launch_pnl.csv'))) {
        if (str(row, 'in_create_slot') !== '1') continue;
        const mint = str(row, 'mint');
        const slot = num(row, 'first_slot');
        const seen = m.get(mint);
        if (seen === undefined) m.set(mint, slot);
        else if (seen !== slot) {
          throw new Error(`${mint}: create slot ambiguous (${seen} vs ${slot})`);
        }
      }
      this._createSlot = m;
    }
    return this._createSlot;
  }

  // -- per (wallet, launch) --------------------------------------------------------

  /** All 46,553 (wallet, launch) pairs. Discriminate on `closedInWindow` before using P&L. */
  pairs(): readonly WalletLaunchPair[] {
    if (!this._pairs) {
      const cs = this.createSlotByMint();
      this._pairs = readCsv(this.path('wallet_launch_pnl.csv')).map((r) => readPair(r, cs));
    }
    return this._pairs;
  }

  /**
   * The 22,333 pairs (48%) that are flat by the end of the window — **the only rows with a
   * complete P&L**, and the population every headline table in `report.md` is computed
   * over. Still gross of fees; see {@link onchainRoundTrips} for the fee-inclusive view.
   */
  closedRoundTrips(): readonly ClosedPair[] {
    return this.pairs().filter((p): p is ClosedPair => p.closedInWindow);
  }

  /**
   * The 24,220 pairs still holding at the end of the window. Their P&L is **not known**;
   * this accessor exists so that characterising them is easy and aggregating them is not.
   */
  openPairs(): readonly OpenPair[] {
    return this.pairs().filter((p): p is OpenPair => !p.closedInWindow);
  }

  // -- per wallet ------------------------------------------------------------------

  /** All 20,388 counterparty wallets. `counterparties.csv`. Gross of fees. */
  wallets(): readonly WalletAggregate[] {
    this._wallets ??= readCsv(this.path('counterparties.csv')).map(readWallet);
    return this._wallets;
  }

  wallet(address: string): WalletAggregate | undefined {
    return this.wallets().find((w) => w.wallet === address);
  }

  // -- fee-inclusive ---------------------------------------------------------------

  /**
   * Raw `onchain_create_slot_pnl.csv` rows — one per (transaction, create-slot wallet),
   * 123 launches and 4,394 transactions. **The only fee-inclusive data in the dataset.**
   *
   * `onchain_fee_sample.csv` is an earlier 6-launch pass over the same launches and is
   * *not* merged in: its mints are a subset, so merging double-counts. Read it separately
   * with {@link onchainFeeSample} if you want the first pass.
   */
  onchainRows(): readonly OnchainRow[] {
    this._onchainRows ??= readCsv(this.path('onchain_create_slot_pnl.csv')).map((r) =>
      readOnchainRow(r, false),
    );
    return this._onchainRows;
  }

  /** The earlier 6-launch pass. Overlaps {@link onchainRows}; do not sum the two. */
  onchainFeeSample(): readonly OnchainRow[] {
    return readCsv(this.path('onchain_fee_sample.csv')).map((r) => readOnchainRow(r, true));
  }

  /**
   * Fee-inclusive create-slot round trips: `onchain_create_slot_pnl.csv` folded to one row
   * per (wallet, launch), keeping only pairs that are flat within {@link FLAT_TOLERANCE}.
   * This is what `report.md` §5.5 is computed over — 596 cohort and 630 non-cohort.
   */
  onchainRoundTrips(): readonly OnchainRoundTrip[] {
    if (!this._onchainRoundTrips) {
      this._onchainRoundTrips = foldOnchain(this.onchainRows()).filter(
        (t) => t.tokensBought > 0 && Math.abs(t.netTokenDelta) <= FLAT_TOLERANCE * t.tokensBought,
      );
    }
    return this._onchainRoundTrips;
  }

  /** Every (wallet, launch) in the on-chain pass, flat or not. Mostly a diagnostic. */
  onchainPositions(): readonly OnchainRoundTrip[] {
    return foldOnchain(this.onchainRows());
  }

  // -- the raw tape ----------------------------------------------------------------

  /**
   * The raw per-fill trade tape for one launch, `window/{mint}.jsonl.gz`, oldest first.
   * Every derived table in the dataset is a projection of these files; this is the route
   * back to the primary record when a derived column is not enough.
   *
   * Returns `undefined` for the four launches with `tape = none`.
   *
   * **Gated on `reached_mint`, and it has to be.** All 239 mints have a `.jsonl.gz`, but
   * the four with `tape = none` hold a partial walk that never got back as far as the
   * mint — `Marciana`'s 1,000 rows are PumpSwap fills from six days after its launch. A
   * reader that only checked for the file's existence would hand those back as if they
   * were launch windows.
   */
  windowTape(mint: string): readonly WindowTrade[] | undefined {
    const meta = this.windowMeta(mint);
    if (!meta?.reachedMint) return undefined;
    const path = this.path(join('window', `${mint}.jsonl.gz`));
    return existsSync(path) ? readWindowTape(path) : undefined;
  }

  /**
   * `window/{mint}.meta.json`. `reachedMint` is what makes a launch count as covered —
   * note that the meta file exists for all 239 mints, including the four where it is
   * false, so its presence alone is not the coverage test.
   */
  windowMeta(mint: string): WindowMeta | undefined {
    const path = this.path(join('window', `${mint}.meta.json`));
    return existsSync(path) ? readWindowMeta(path) : undefined;
  }

  /** The partial walk behind a `tape = none` launch. A diagnostic, never a launch window. */
  incompleteWindowTape(mint: string): readonly WindowTrade[] | undefined {
    const meta = this.windowMeta(mint);
    if (meta?.reachedMint !== false) return undefined;
    const path = this.path(join('window', `${mint}.jsonl.gz`));
    return existsSync(path) ? readWindowTape(path) : undefined;
  }
}

export type { NetSol, GrossSol };
