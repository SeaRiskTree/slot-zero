/**
 * Stage 0 — validate the screen against data we already hold, before spending any quota.
 *
 * A screen that cannot reproduce the answers we already know is not ready to judge strangers. So
 * before the tool is pointed at anybody it is pointed at the committed population tape, where the
 * truth is published, and it checks four things:
 *
 *  1. **The gate passes our subject deployer** — and that is the *point*, not a bug. `7ufmve7Z…`
 *     completes 103 of 239 launches (0.4310) over eight months, which clears every Stage 1
 *     threshold comfortably. Its opening window has also been unprofitable for outsiders since
 *     2026-06-04, because its own group takes 97% of the profit available there. So Stage 0
 *     demonstrates empirically, on the one wallet where we hold ground truth, that **passing the
 *     gate does not mean a deployer is worth the time.** If the gate ever *fails* this wallet, the
 *     thresholds have drifted somewhere indefensible.
 *  2. **Three different completion rates come out of the same vendor payload**, and only one of
 *     them is the truth. Their `deployer.bonding_rate` is a trailing ~7.5-day window; their
 *     `pump_stats` is one 70-token page; our tape is the record. Stage 0 prints all three so the
 *     size of the artefact is visible rather than asserted.
 *  3. **The curve inversion is exact**, checked against the dataset's own 70 recorded `dev_sol`
 *     values.
 *  4. **The create-slot measurement reproduces the published §5.1 era split.**
 *  5. **The field measurement reproduces `wallet_launch_pnl.csv`** — computed from raw tape fills,
 *     checked against the dataset's own committed columns on every create-slot outsider pair. The
 *     live measurement runs the same code over the same shape of rows, so agreement here is what
 *     licenses believing it on a stranger.
 *  6. **THE KNOWN-NEGATIVE CONTROL: Stage 2 must NOT score `7ufmve7Z…` as beatable.** This is the
 *     load-bearing assertion of the entry stage, and it is the counterpart of (1). The gate passes
 *     that wallet because it is competent; Stage 2 must refuse it because its opening window has
 *     been unprofitable for outsiders since 2026-06-04 — measured, in
 *     `data/slot-zero-june-regime-change/report.md`, not assumed. Any design that scores it as
 *     beatable is wrong, so a design that starts to is failed here rather than shipped.
 *
 *     The trap this specifically catches: the field leg, read on its own, **says the wallet is
 *     beatable.** Gross of fees its post-break field is 76.3% of closed round trips positive at a
 *     median +0.12 SOL, while the fee-inclusive record is +0.54 SOL per launch shared by 106
 *     wallets with 51 of them negative. So the check is not that some number is below some bar —
 *     it is that the composite verdict resists a leg that points the wrong way.
 *  7. **THE ROLLING REPLAY — the same question, asked at every point in the tape's history.** (6)
 *     samples two slices, and both of them sit inside the months where the co-ordination rule
 *     recovers 97–100% of the known cohort, so **neither could ever have caught the rule finding
 *     nothing at all**. This replays the live recipe at all 228 trailing windows and fails on a
 *     single window where the screen says there was room and the named cohort says there was not.
 *     See {@link replayRollingRoom}; it is offline, free and deterministic like the rest.
 *  8. **THE COST LEG, against the committed on-chain table.** The captain's ruling of 2026-08-02
 *     put fees inside the entry window, so a live run now spends Solana RPC requests pricing what it
 *     costs to land. That leg is regression-tested offline first, on the launches
 *     `onchain_create_slot_pnl.csv` prices, using the same `priceLaunchEntry` a live run uses. It
 *     asserts the two things a wiring error breaks silently — that netting measured fees moves the
 *     field DOWN, and that the seat is not free — and re-runs the known-negative control with costs
 *     attached. See {@link verifyOnChainCostReproduction}.
 *
 * All of it reads committed files. No network, no key, no quota.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { entryCostTargets, measureLaunchEntry, priceLaunchEntry, scoreEntry } from './entry.mjs';
import {
  CURVE_INITIAL_PRICE_SOL,
  CURVE_K,
  createSlotGroups,
  measureCompletion,
  median,
  parseFill,
  percentile,
  roomIsProven,
  solBetweenPrices,
} from './measure.mjs';
import { LAMPORTS_PER_SOL } from './pumpfun.mjs';
import { applyGate, verdictFor } from './rank.mjs';

/** The deployer the whole dataset is about. `src/cohort.ts` carries the same constant. */
export const SUBJECT_DEPLOYER = '7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL';

/**
 * The six wallets established as the subject operation's own, by name.
 *
 * `src/cohort.ts` → `CREATE_SLOT_COHORT` carries the same list; it is repeated here rather than
 * imported for the reason `measure.mjs`'s curve constants are — this directory sits outside the
 * keyless boundary `test/deployer-screen.test.ts` keeps sharp, and a dependency across it would
 * blur the line. The list was established from presence, fill price, fee bill and later the funding
 * graph (June report §5.1, `kol-cohort-vs-outsider-funding/report.md`).
 *
 * **This is GROUND TRUTH and nothing else may use it.** It is the answer key for
 * {@link replayRollingRoom}, which asks whether the screen's *structural* rule — the only one
 * available on a stranger — ever calls a window enterable that the named cohort says was not. No
 * scoring path may consult it, or Stage 0 would stop being a test of the method a live run runs.
 */
export const CREATE_SLOT_COHORT = [
  '2CHrnc2LyagAbMaMFgthiDWh7ZZ9zT9TF8WEJf7MNE71',
  'Atgx1JXsp8pTQ9Qsi74wF5pLMVwHwyQc6jJCu84evN7c',
  '8kzFH4rgFzy4ccz97AhgqRT7Qbt7HnD5oJCDK1Sxdarb',
  'GfJA84gwT9LpeyzeckeXkCsf8vdQuA64ZYQ91xoBawvt',
  '5P8A9bGUhroskpuA4hhRbybgt37TcTz7ft5zLAh8orpn',
  '43x1zWzjVWJbQErWM78m3Acx83FFuGSQEhmgyxUrPdQs',
];

const COHORT_SET = new Set(CREATE_SLOT_COHORT);

/** The published era boundary. June report §5.1: everything moved on this date. */
export const REGIME_BOUNDARY = '2026-06-04';

/**
 * What the vendor reported for the subject on 2026-07-29, recorded so Stage 0 can show the size
 * of the artefact without spending a request to re-fetch it.
 *
 * Two readings two hours apart, which is the evidence that the window *slides*: a count window
 * would have grown as the deployer launched again, and this one shrank.
 */
export const VENDOR_READINGS = [
  { atUtc: '2026-07-29T15:00Z', deployed: 22, bonded: 15, rate: 0.6818 },
  { atUtc: '2026-07-29T17:00Z', deployed: 20, bonded: 13, rate: 0.65 },
];

/**
 * Minimal CSV reader. Quoted fields matter: two token names in `launches.csv` contain a comma, and
 * a naive `split(',')` shifts every later column on those rows — a silent corruption rather than a
 * crash. `src/csv.ts` makes the same point for the keyless core.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Index a header row by name, failing loudly on a missing column.
 *
 * @param {readonly string[]} header
 * @param {string} file
 * @returns {(name: string) => number}
 */
function columnIndexer(header, file) {
  return (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${file} has no '${name}' column`);
    return i;
  };
}

/**
 * Read the subject's ground-truth completion record straight from `launches.csv`.
 *
 * This is the number every vendor aggregate is measured against: **239 launches, 103 bonded,
 * 0.4310**, spanning 2025-12-01 to 2026-07-28.
 *
 * @param {string} dataDir
 * @returns {import('./measure.mjs').CompletionMeasurement}
 */
export function readGroundTruthCompletion(dataDir) {
  const rows = parseCsv(readFileSync(join(dataDir, 'launches.csv'), 'utf8'));
  const header = rows[0];
  if (header === undefined) throw new Error('launches.csv is empty');
  const col = columnIndexer(header, 'launches.csv');
  const iCreated = col('created_utc');
  const iGrad = col('graduated');

  /** @type {import('./measure.mjs').TokenRecord[]} */
  const records = [];
  for (const r of rows.slice(1)) {
    if (r.length <= Math.max(iCreated, iGrad)) continue;
    records.push({
      deployedAtMs: Date.parse(String(r[iCreated])),
      completed: r[iGrad] === '1',
    });
  }
  return measureCompletion(records);
}

/**
 * @typedef {object} TapedLaunch
 * @property {string} mint
 * @property {string} dateIso
 * @property {import('./measure.mjs').CreateSlotMeasurement} createSlot
 * @property {import('./entry.mjs').FieldEntrant[]} field
 * @property {import('./measure.mjs').Fill[]} fills The launch's whole stored window. Kept because
 *   the cost leg's targets are transactions, and a transaction is only recoverable from the fills —
 *   see {@link verifyOnChainCostReproduction}.
 * @property {number} cohortRoomLeft GROUND TRUTH room, from the NAMED six-wallet cohort rather than
 *   the structural bundle rule. Available only because this is our own subject; a stranger has no
 *   such answer, which is the whole reason the structural rule exists. Used by
 *   {@link replayRollingRoom} and by nothing else.
 */

/**
 * The room a launch left, with the operation identified BY NAME.
 *
 * The same arithmetic as `tallyCreateSlot`, over the same create slot, differing only in who counts
 * as the operation: `SUBJECT_DEPLOYER` plus {@link CREATE_SLOT_COHORT} instead of whoever shared a
 * transaction. It is duplicated rather than parameterised so that the scoring path cannot acquire a
 * "pass me the cohort" seam — on a stranger there is nothing to pass.
 *
 * @param {import('./measure.mjs').CreateSlotGroups} groups
 * @returns {number}
 */
export function cohortRoomLeft(groups) {
  let operation = 0;
  let outsiders = 0;
  for (const f of groups.inSlot) {
    if (f.wallet === SUBJECT_DEPLOYER || COHORT_SET.has(f.wallet)) operation += f.sol;
    else outsiders += f.sol;
  }
  const denominator = operation + outsiders;
  // Same convention as `tallyCreateSlot`: an empty create slot is fully occupied, not wide open.
  return denominator > 0 ? outsiders / denominator : 0;
}

/**
 * Measure every taped launch of the subject deployer from the committed window tapes.
 *
 * Gated on `reached_mint`, not on file existence. All 239 mints have a `window/*.jsonl.gz` but
 * four never reached the mint, and those four files are truncated at the *oldest* end — their rows
 * sit inside the launch's own window but the create slot is missing, so a reader that trusted the
 * filename would crown a mid-window sniper as the deployer. The live
 * walk in `pumpfun.mjs` → `readLaunchWindow` reproduces that gate as a *proof obligation*, since
 * on a stranger's launch there is no committed `reached_mint` to consult.
 *
 * **This is where Stage 2's method meets ground truth.** The same `measureLaunchEntry` runs here
 * over committed fills and, in a live run, over `swap-api` rows — one implementation, two callers,
 * because the tape's rows *are* the endpoint's rows.
 *
 * **ONE DELIBERATE ASYMMETRY, AND IT MUST NOT BE TIDIED AWAY.** This function measures each launch
 * over the launch's OWN STORED WINDOW — every fill in the tape file — while a live run trims to
 * `thresholds.json` → `stage2_entry.windowSlotSpan` slots from the create slot. That is not an
 * oversight and the two paths must not be made to agree. `wallet_launch_pnl.csv`, which
 * {@link verifyFieldReproduction} checks against on 1,502 create-slot outsider pairs with zero
 * closure mismatches, is itself computed over each launch's stored window. Imposing a slot span here
 * would move closure verdicts at the tail and break that reproduction — which is the regression guard
 * that makes the live recipe trustworthy in the first place. A live run has no stored window to use,
 * which is exactly why it needs a pinned span; this one does, so it uses it.
 *
 * @param {string} dataDir Path to `data/population-tape-2026-07-29`.
 * @returns {TapedLaunch[]} Oldest first.
 */
export function measureSubjectLaunches(dataDir) {
  const windowDir = join(dataDir, 'window');
  /** @type {TapedLaunch[]} */
  const out = [];

  for (const file of readdirSync(windowDir)) {
    if (!file.endsWith('.jsonl.gz')) continue;
    const mint = file.slice(0, -'.jsonl.gz'.length);

    const meta = /** @type {Record<string, unknown>} */ (
      JSON.parse(readFileSync(join(windowDir, `${mint}.meta.json`), 'utf8'))
    );
    if (meta['reached_mint'] !== true) continue;

    const text = gunzipSync(readFileSync(join(windowDir, file))).toString('utf8');
    /** @type {import('./measure.mjs').Fill[]} */
    const fills = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      fills.push(parseFill(/** @type {Record<string, unknown>} */ (JSON.parse(line))));
    }

    const entry = measureLaunchEntry(fills);
    if (entry === null) continue;
    const groups = createSlotGroups(fills);
    if (groups === null) continue;

    out.push({
      mint,
      dateIso: new Date(Number(meta['created_timestamp'])).toISOString(),
      createSlot: entry.createSlot,
      field: entry.field,
      fills,
      cohortRoomLeft: cohortRoomLeft(groups),
    });
  }

  out.sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0));
  return out;
}

/**
 * @typedef {object} FieldReproduction
 * @property {number} pairs                Create-slot outsider (wallet, launch) pairs compared.
 * @property {number} closureMismatches    Where our closed/open verdict differs from the dataset's.
 * @property {number} maxRealisedErrorSol  Largest disagreement on a closed pair's realised SOL.
 * @property {number} missingFromCsv       Pairs we found that the dataset does not carry.
 * @property {boolean} ok
 */

/**
 * Check the field measurement against the dataset's own committed P&L table.
 *
 * `wallet_launch_pnl.csv` is a projection of the very tapes {@link measureSubjectLaunches} reads,
 * so agreement is not circular — it is a check that our recomputation from raw fills lands on the
 * published columns, over **every** create-slot outsider pair rather than a sample. Two things are
 * compared, and they are the two the live measurement can get quietly wrong:
 *
 * - **`closed_in_window`.** The dataset's rule is that the residual is within 0.1% of tokens
 *   bought, and only those rows have a complete P&L at all. Getting this wrong does not produce a
 *   visible error; it produces a distribution silently contaminated with half-finished positions.
 * - **`realised_sol`.** `sol_out − sol_in` on the closed pairs.
 *
 * The dataset also marks a handful of *sell-only* wallets closed — wallets that bought nothing
 * inside the window, so their residual is trivially zero. Those are not round trips and cannot be
 * create-slot entrants, so they never enter this comparison; the population here is exactly the one
 * the field leg measures.
 *
 * @param {string} dataDir
 * @param {readonly TapedLaunch[]} launches
 * @returns {FieldReproduction}
 */
export function verifyFieldReproduction(dataDir, launches) {
  const rows = parseCsv(readFileSync(join(dataDir, 'wallet_launch_pnl.csv'), 'utf8'));
  const header = rows[0];
  if (header === undefined) throw new Error('wallet_launch_pnl.csv is empty');
  const col = columnIndexer(header, 'wallet_launch_pnl.csv');
  const iMint = col('mint');
  const iWallet = col('wallet');
  const iClosed = col('closed_in_window');
  const iRealised = col('realised_sol');
  const iCreateSlot = col('in_create_slot');

  /** @type {Map<string, { closed: boolean, realised: number, inCreateSlot: boolean }>} */
  const published = new Map();
  for (const r of rows.slice(1)) {
    if (r.length <= Math.max(iRealised, iCreateSlot)) continue;
    published.set(`${String(r[iMint])}|${String(r[iWallet])}`, {
      closed: r[iClosed] === '1',
      realised: Number(r[iRealised]),
      inCreateSlot: r[iCreateSlot] === '1',
    });
  }

  let pairs = 0;
  let closureMismatches = 0;
  let maxRealisedErrorSol = 0;
  let missingFromCsv = 0;

  for (const launch of launches) {
    for (const e of launch.field) {
      const row = published.get(`${launch.mint}|${e.wallet}`);
      if (row === undefined) {
        missingFromCsv += 1;
        continue;
      }
      pairs += 1;
      if (e.closedInWindow !== row.closed) closureMismatches += 1;
      if (e.closedInWindow && row.closed) {
        maxRealisedErrorSol = Math.max(maxRealisedErrorSol, Math.abs(e.realisedSolGrossOfFees - row.realised));
      }
    }
  }

  // 1e-6 SOL is a thousandth of a lamport-scale rounding: the dataset stores SOL to six decimals,
  // so anything at or below this is representation and anything above it is a different sum.
  const ok = pairs > 0 && closureMismatches === 0 && missingFromCsv === 0 && maxRealisedErrorSol < 1e-6;
  return { pairs, closureMismatches, maxRealisedErrorSol, missingFromCsv, ok };
}

/**
 * Read the committed on-chain cost table into the exact shape a LIVE cost walk produces.
 *
 * `onchain_create_slot_pnl.csv` is `api.mainnet-beta`'s answer, recorded: per (mint, transaction,
 * wallet) it carries the transaction's whole fee attributed to its payer and the named wallet's real
 * lamport change. That is the same pair of quantities `pumpfun.mjs` → `parseTransactionCosts` pulls
 * out of a `getTransaction` response, so projecting the table onto {@link
 * import('./pumpfun.mjs').TransactionCosts} lets **the live attach function run over committed
 * ground truth** rather than over a re-implementation of it. One code path, two sources — the same
 * arrangement that makes the room and field legs testable offline.
 *
 * Note the one shape difference, and it is harmless: the table lists only the create-slot entrants'
 * accounts, not every account in the transaction, so `solOutByWallet` is a subset. `priceLaunchEntry`
 * looks up exactly the wallet it is pricing and refuses the entrant when it is absent, so a subset
 * costs coverage and can never fabricate a figure.
 *
 * @param {string} dataDir
 * @returns {Map<string, import('./pumpfun.mjs').TransactionCosts>} By transaction signature.
 */
export function readOnChainCosts(dataDir) {
  const rows = parseCsv(readFileSync(join(dataDir, 'onchain_create_slot_pnl.csv'), 'utf8'));
  const header = rows[0];
  if (header === undefined) throw new Error('onchain_create_slot_pnl.csv is empty');
  const col = columnIndexer(header, 'onchain_create_slot_pnl.csv');
  const iTx = col('tx');
  const iWallet = col('wallet');
  const iFeePayer = col('is_fee_payer');
  const iFee = col('fee_lamports');
  const iDelta = col('sol_delta_lamports');

  /** @type {Map<string, import('./pumpfun.mjs').TransactionCosts>} */
  const byTx = new Map();
  for (const r of rows.slice(1)) {
    if (r.length <= Math.max(iFee, iDelta)) continue;
    const signature = String(r[iTx]);
    const wallet = String(r[iWallet]);
    let costs = byTx.get(signature);
    if (costs === undefined) {
      costs = { signature, feeSol: Number(r[iFee]) / LAMPORTS_PER_SOL, feePayer: null, solOutByWallet: new Map() };
      byTx.set(signature, costs);
    }
    // The fee is a property of the transaction and appears on every one of its rows; the payer is
    // named only where one of the listed wallets happens to be it. A bundled transaction's payer
    // may be an account the table does not carry, which is why this is nullable rather than
    // defaulted to the first wallet seen — CLAUDE.md's fee-payer counter-trap.
    if (r[iFeePayer] === '1') costs.feePayer = wallet;
    costs.solOutByWallet.set(wallet, -Number(r[iDelta]) / LAMPORTS_PER_SOL);
  }
  return byTx;
}

/**
 * @typedef {object} CostReproduction
 * @property {number} launchesPriced       Launches the committed table can price at all.
 * @property {number} minLaunches          Launches this check needs to mean anything.
 * @property {number} entriesPriced        Create-slot entries with a measured entry cost.
 * @property {number} entries              Create-slot entries in the priced launches.
 * @property {number} pairsPriced          Closed round trips priced across their whole window.
 * @property {number} minPairs             Pairs this check needs to mean anything.
 * @property {number} entryCostMedianSol
 * @property {number} entryCostPerSolStakedMedian
 * @property {number} entryCostPositiveShare Share of priced entries whose cost is above zero.
 * @property {number} grossHitRate
 * @property {number} netHitRate
 * @property {number} grossMedianSol
 * @property {number} netMedianSol
 * @property {number} flipsPositiveToNegative Round trips positive gross and negative net.
 * @property {import('./entry.mjs').EntryScore} postBreakScore The post-break regime scored WITH its
 *   measured costs attached — the known-negative control, run through the whole new ladder.
 * @property {boolean} ok
 */

/**
 * **STAGE 0's FIFTH REPRODUCTION, AND IT COSTS NOTHING.** Price the subject's own create slots from
 * the committed on-chain table and check the cost leg end to end, offline, before it is ever pointed
 * at a stranger.
 *
 * What it establishes, in the order the failures below assert it:
 *
 * 1. **The leg is wired the right way round.** Netting measured fees onto the field must LOWER its
 *    hit rate and its median. A sign error in the lamport delta, or a `priceLaunchEntry` that
 *    subtracted the quote from the wrong side, would raise them — silently, and in the one
 *    direction the captain's tiebreaker forbids.
 * 2. **The cost is real and positive.** A median at or below zero would mean the seat is free,
 *    which it is not: on this tape the median create-slot entry pays about 0.03 SOL, and the
 *    transaction fee alone spans 0.00001 to 3.15 SOL on the same deployer.
 * 3. **The known-negative control survives the new ladder.** `7ufmve7Z…` scored WITH its costs
 *    attached must still not read `entry-open-after-costs`.
 *
 * **What it deliberately does NOT assert, because it is not true:** that the net field leg vetoes
 * our subject. Post-break its priced round trips are still 0.64 positive at a median +0.05 SOL net,
 * so the after-cost field would pass — the wallet is refused by ROOM, which is exactly why room is
 * the gate and the field is only ever a veto. Asserting otherwise here would pin a property the
 * evidence does not support.
 *
 * The coverage this runs over is a property of the committed table rather than of the method: it
 * priced 113 of the 235 covered launches, so `minLaunches`/`minPairs` exist for the same reason the
 * era buckets have a `minN` — an empty comparison passes vacuously, and a passing Stage 0 is what
 * authorises spending quota on strangers.
 *
 * @param {string} dataDir
 * @param {readonly TapedLaunch[]} launches
 * @param {import('./entry.mjs').EntryThresholds & { maxLaunchesPerCandidate: number }} t
 * @returns {CostReproduction}
 */
export function verifyOnChainCostReproduction(dataDir, launches, t) {
  const onChain = readOnChainCosts(dataDir);

  /** @type {import('./entry.mjs').LaunchEntry[]} */
  const pricedPostBreak = [];
  /** @type {import('./entry.mjs').FieldEntrant[]} */
  const allEntries = [];
  let launchesPriced = 0;

  for (const l of launches) {
    /** @type {import('./entry.mjs').LaunchEntry} */
    const entry = { createSlot: l.createSlot, field: l.field };
    const targets = entryCostTargets(l.fills, entry);
    if (targets.length === 0) continue;
    // The same all-or-nothing rule a live walk applies, one level up: only the transactions the
    // table actually carries are handed over, and `priceLaunchEntry` refuses any wallet whose set
    // is incomplete.
    /** @type {Map<string, import('./pumpfun.mjs').TransactionCosts>} */
    const available = new Map();
    for (const target of targets) {
      const costs = onChain.get(target.tx);
      if (costs !== undefined) available.set(target.tx, costs);
    }
    if (available.size === 0) continue;
    launchesPriced += 1;
    const priced = priceLaunchEntry(entry, targets, available);
    allEntries.push(...priced.field);
    if (l.dateIso.slice(0, 10) >= REGIME_BOUNDARY) pricedPostBreak.push(priced);
  }

  const costed = allEntries.filter((e) => Number.isFinite(e.entryCostSol));
  const closed = allEntries.filter((e) => e.closedInWindow);
  const pairs = closed.filter((e) => Number.isFinite(e.realisedSolNetOfMeasuredFees));
  const positive = (/** @type {readonly number[]} */ v) =>
    v.length === 0 ? Number.NaN : v.filter((x) => x > 0).length / v.length;

  const grossOfPairs = pairs.map((e) => e.realisedSolGrossOfFees);
  const netOfPairs = pairs.map((e) => e.realisedSolNetOfMeasuredFees);
  const postBreakScore = scoreEntry(pricedPostBreak, t, { candidateWallet: SUBJECT_DEPLOYER });

  const minLaunches = 40;
  const minPairs = 200;
  const grossHitRate = positive(grossOfPairs);
  const netHitRate = positive(netOfPairs);
  const grossMedianSol = median(grossOfPairs);
  const netMedianSol = median(netOfPairs);
  const entryCostMedianSol = median(costed.map((e) => e.entryCostSol));

  return {
    launchesPriced,
    minLaunches,
    entriesPriced: costed.length,
    entries: allEntries.length,
    pairsPriced: pairs.length,
    minPairs,
    entryCostMedianSol,
    entryCostPerSolStakedMedian: median(costed.map((e) => e.entryCostPerSolStaked)),
    entryCostPositiveShare: positive(costed.map((e) => e.entryCostSol)),
    grossHitRate,
    netHitRate,
    grossMedianSol,
    netMedianSol,
    flipsPositiveToNegative: pairs.filter(
      (e) => e.realisedSolGrossOfFees > 0 && e.realisedSolNetOfMeasuredFees <= 0,
    ).length,
    postBreakScore,
    ok:
      launchesPriced >= minLaunches &&
      pairs.length >= minPairs &&
      entryCostMedianSol > 0 &&
      positive(costed.map((e) => e.entryCostSol)) >= 0.9 &&
      netHitRate < grossHitRate &&
      netMedianSol < grossMedianSol &&
      postBreakScore.verdict !== 'entry-open-after-costs',
  };
}

/**
 * @typedef {object} RollingRoomWindow
 * One trailing window of the replay.
 * @property {string} atIso            Creation time of the newest launch in the window.
 * @property {number} scored           Launches in it the screen would actually score.
 * @property {number} screenRoomMedian Median room over those, or `NaN` when too few to score.
 * @property {number} truthRoomMedian  Median room over ALL launches in the window, by name.
 * @property {boolean} screenPresent   What the screen's structural rule concludes.
 * @property {boolean} truthPresent    What the named cohort concludes.
 */

/**
 * @typedef {object} RollingRoomReplay
 * @property {number} windows          Trailing windows evaluated.
 * @property {number} present
 * @property {number} absent
 * @property {number} unmeasured       Too few scoreable launches to report a distribution. A window
 *   refused this way is NOT a false negative — the screen returned no verdict at all, and the two
 *   states are counted apart on purpose.
 * @property {number} falsePositives   Screen says room, the named cohort says none. **The failure.**
 * @property {number} falseNegatives   Screen MEASURED the window and said none, the named cohort
 *   says room. The cost. Requires a finite median: an unmeasured window never lands here.
 * @property {RollingRoomWindow[]} falsePositiveWindows Every one of them, for the failure message.
 * @property {boolean} ok
 */

/**
 * **THE CONTROL THAT WOULD HAVE CAUGHT THE UNPROVEN-OPENING DEFECT.** Replay the exact live entry
 * recipe at every point in the subject's history and compare its verdict with the one the named
 * cohort gives.
 *
 * Stage 0's other known-negative check samples two slices — the most recent 8 launches (July) and
 * the whole post-break regime (June–July). Both sit inside the period where the co-ordination rule
 * happens to recover 97–100% of the cohort, so **neither could ever see the defect**: the rule
 * recovered **0%** of the cohort in December 2025 – February 2026 and 41.6% in March, and over that
 * stretch the screen reported median room 0.62–0.66 against a true 0.20–0.33 in a regime whose
 * measured per-launch prize to outsiders was ≈0. This asks the same question at all 228 windows
 * instead of 2, and it is offline, free and deterministic.
 *
 * The recipe is the live one, not an approximation of it: median `roomLeft` over the trailing
 * `maxLaunchesPerCandidate` launches against `minRoomLeft`, and a window with fewer than
 * `minLaunchesSampled` scoreable launches is UNMEASURED, exactly as `scoreEntry` would have it.
 *
 * **Only false positives fail.** A false negative is the accepted price of decision 134a — refusing
 * to score an unproven opening costs real coverage, and on this tape it turns windows that truly
 * had room into `unmeasured`. A null result is acceptable; a false positive is not. `unmeasured`
 * and `falseNegatives` are counted apart: a refused window has no verdict to be wrong, so it is
 * never booked as the screen having said ABSENT.
 *
 * The window's truth is taken over **all** its launches, refused ones included, because the
 * question is what the deployer's opening actually was — not what it was over the subset the screen
 * was willing to look at.
 *
 * @param {readonly TapedLaunch[]} launches Oldest first.
 * @param {{ minRoomLeft: number, minLaunchesSampled: number, maxLaunchesPerCandidate: number }} t
 * @returns {RollingRoomReplay}
 */
export function replayRollingRoom(launches, t) {
  /** @type {RollingRoomWindow[]} */
  const falsePositiveWindows = [];
  let present = 0;
  let absent = 0;
  let unmeasured = 0;
  let falseNegatives = 0;
  let windows = 0;

  for (let end = t.maxLaunchesPerCandidate; end <= launches.length; end++) {
    const w = launches.slice(end - t.maxLaunchesPerCandidate, end);
    const newest = w[w.length - 1];
    if (newest === undefined) continue;
    windows += 1;

    const scored = w.filter((l) => roomIsProven(l.createSlot));
    const screenRoomMedian =
      scored.length >= t.minLaunchesSampled ? median(scored.map((l) => l.createSlot.roomLeft)) : Number.NaN;
    const truthRoomMedian = median(w.map((l) => l.cohortRoomLeft));
    const measured = Number.isFinite(screenRoomMedian);
    const screenPresent = screenRoomMedian >= t.minRoomLeft;
    const truthPresent = truthRoomMedian >= t.minRoomLeft;

    if (!measured) unmeasured += 1;
    else if (screenPresent) present += 1;
    else absent += 1;

    if (screenPresent && !truthPresent) {
      falsePositiveWindows.push({
        atIso: newest.dateIso,
        scored: scored.length,
        screenRoomMedian,
        truthRoomMedian,
        screenPresent,
        truthPresent,
      });
    } else if (measured && !screenPresent && truthPresent) falseNegatives += 1;
  }

  return {
    windows,
    present,
    absent,
    unmeasured,
    falsePositives: falsePositiveWindows.length,
    falseNegatives,
    falsePositiveWindows,
    ok: falsePositiveWindows.length === 0,
  };
}

/**
 * @typedef {object} ControlDeployer
 * @property {string} creator
 * @property {string} mint
 * @property {string} group
 * @property {number} devSol
 * @property {number} createSlotSol Non-deployer create-slot capital, recovered from the curve.
 * @property {number} walletsInSlot
 * @property {number} bundledTx
 * @property {number} operationShareLowerBound
 * @property {number} roomLeftUpperBound
 */

/**
 * Read the 70 control launches — a different creator on every row — and recover each one's
 * create-slot capital from the curve.
 *
 * `control_create_slot.csv` records `p0` (the price after the deployer's own buy) and
 * `last_create_slot_price`, and the bonding curve is a constant product, so the SOL that entered
 * between them is exact. It does **not** record which of those wallets were co-ordinated with each
 * other, so the honest output is a *bound* rather than a point: `operationShareLowerBound` credits
 * the deployer with its own buy only and treats every other create-slot wallet as independent, so
 * the true share can only be higher and the room can only be smaller.
 *
 * Reported by Stage 0 as population context. Nothing gates on it.
 *
 * @param {string} dataDir
 * @returns {ControlDeployer[]}
 */
export function readControlDeployers(dataDir) {
  const rows = parseCsv(readFileSync(join(dataDir, 'control_create_slot.csv'), 'utf8'));
  const header = rows[0];
  if (header === undefined) throw new Error('control_create_slot.csv is empty');
  const col = columnIndexer(header, 'control_create_slot.csv');
  const iMint = col('mint');
  const iCreator = col('creator');
  const iGrp = col('grp');
  const iDev = col('dev_sol');
  const iWallets = col('n_create_slot_wallets');
  const iMulti = col('multi_wallet_tx');
  const iP0 = col('p0');
  const iPLast = col('last_create_slot_price');

  /** @type {ControlDeployer[]} */
  const out = [];
  for (const r of rows.slice(1)) {
    if (r.length <= iPLast) continue;
    const devSol = Number(r[iDev]);
    const createSlotSol = Math.max(0, solBetweenPrices(Number(r[iP0]), Number(r[iPLast])));
    const denominator = devSol + createSlotSol;
    const share = denominator > 0 ? devSol / denominator : 1;
    out.push({
      creator: String(r[iCreator]),
      mint: String(r[iMint]),
      group: String(r[iGrp]),
      devSol,
      createSlotSol,
      walletsInSlot: Number(r[iWallets]),
      bundledTx: Number(r[iMulti]),
      operationShareLowerBound: share,
      roomLeftUpperBound: 1 - share,
    });
  }
  return out;
}

/**
 * Price after adding `sol` to a curve currently at `price`. The inverse of
 * {@link solBetweenPrices}.
 *
 * @param {number} price
 * @param {number} sol
 * @returns {number}
 */
export function priceAfterAdding(price, sol) {
  const root = Math.sqrt(price) + sol / Math.sqrt(CURVE_K);
  return root * root;
}

/**
 * Verify the curve inversion round-trips against the dataset's own recorded `dev_sol` values.
 *
 * If this drifts, every capital figure derived from a price is wrong, so it is checked rather than
 * assumed.
 *
 * @param {readonly ControlDeployer[]} controls
 * @returns {{ ok: boolean, maxAbsErrorSol: number, n: number }}
 */
export function verifyCurveInversion(controls) {
  let maxAbsErrorSol = 0;
  for (const c of controls) {
    const implied = solBetweenPrices(
      CURVE_INITIAL_PRICE_SOL,
      priceAfterAdding(CURVE_INITIAL_PRICE_SOL, c.devSol),
    );
    maxAbsErrorSol = Math.max(maxAbsErrorSol, Math.abs(implied - c.devSol));
  }
  return { ok: maxAbsErrorSol < 1e-6, maxAbsErrorSol, n: controls.length };
}

/**
 * @typedef {object} EraReproduction
 * @property {string} era
 * @property {number} n     Launches in the era whose opening is PROVEN, and therefore scored.
 * @property {number} nRoomUnproven Launches in the era excluded for carrying no bundled
 *   transaction. Reported so the era's population can be reconciled with the published one.
 * @property {number} minN Launches this bucket must hold for the comparison to mean anything.
 * @property {number} devSolMedian
 * @property {number} coordinatedSolMedian
 * @property {number} coordinatedWalletsMedian
 * @property {number} independentSolMedian
 * @property {number} operationShareMedian
 * @property {number} publishedOperationShare
 * @property {string} published
 */

/**
 * @typedef {object} Stage0Result
 * @property {{ ok: boolean, maxAbsErrorSol: number, n: number }} curveCheck
 * @property {EraReproduction[]} eraSplit
 * @property {import('./measure.mjs').CompletionMeasurement} groundTruth
 * @property {import('./rank.mjs').GateResult} subjectGate
 * @property {{ verdict: import('./rank.mjs').Verdict, rationale: string }} subjectVerdict
 * @property {FieldReproduction} fieldCheck
 * @property {import('./entry.mjs').EntryScore} subjectEntryRecent Scored exactly as a live run would
 *   score a stranger: the most recent `maxLaunchesPerCandidate` launches, no era filter.
 * @property {import('./entry.mjs').EntryScore} subjectEntryPostBreak Scored over the whole
 *   post-2026-06-04 regime, which is the population the June report measured.
 * @property {RollingRoomReplay} rollingRoom The same known-negative question asked at EVERY point
 *   in the tape's history, against the named cohort. See {@link replayRollingRoom}.
 * @property {CostReproduction} costCheck The entry-cost and after-cost legs, run over the committed
 *   on-chain table. See {@link verifyOnChainCostReproduction}.
 * @property {{ n: number, roomP25: number, roomMedian: number, roomP75: number }} controlPopulation
 * @property {{ n: number, groupedPreset15: number }} controlPresets
 * @property {boolean} passed
 * @property {string[]} failures
 */

/**
 * Run the whole of Stage 0 and report whether the screen is fit to be pointed at strangers.
 *
 * @param {string} dataDir Path to `data/population-tape-2026-07-29`.
 * @param {{ minTokens: number, minCompletionRate: number, minSpanDays: number }} gateThresholds
 * @param {import('./entry.mjs').EntryThresholds & { maxLaunchesPerCandidate: number }} entryThresholds
 * @returns {Stage0Result}
 */
export function runStage0(dataDir, gateThresholds, entryThresholds) {
  const controls = readControlDeployers(dataDir);
  const curveCheck = verifyCurveInversion(controls);
  const groundTruth = readGroundTruthCompletion(dataDir);
  const launches = measureSubjectLaunches(dataDir);

  // --- (1) the gate, applied to ground truth -------------------------------------------------
  const subjectGate = applyGate({ completion: groundTruth }, gateThresholds);
  const subjectVerdict = verdictFor({
    gate: subjectGate,
    completion: groundTruth,
    capped: false,
  });

  // --- (4) the Stage 2 seam, reproduced against the published §5.1 split ---------------------
  // `minN` is what stops this check passing vacuously. `median([])` is `NaN` and
  // `Math.abs(NaN - published) > 0.02` is FALSE, so an era bucket that matched no launches used to
  // report PASSED and then authorise keyed spending. Anything that empties the filter — renamed
  // window files, every `reached_mint` false, a `--data-dir` pointing at a differently dated tape, a
  // shifted date range — is exactly that case. The buckets hold 45 and 86 launches as committed —
  // 86 and not 89 because this split is filtered on `roomIsProven` and three era-2 launches carry
  // no bundled create-slot transaction — so a floor of 20 leaves room for ordinary variation while
  // refusing a hollowed-out bucket.
  //
  // THE ERA-2 CONSTANT IS RE-PINNED, AND THE TOLERANCE IS NOT THE FIX (captain decision 135c).
  // The June report's §5.1 table prints `0.768` for era 2, and that cell is **not the median of its
  // own stated population**: the 89-launch series has median `0.7708`, and `0.768` is its rank-43/44
  // order statistic. The repo's own committed, offline
  // `analysis/window-population/measure.mjs` reads the same regime independently at **0.771**, as
  // does a recomputation from raw fills and one from `wallet_launch_pnl.csv` — three recipes, one
  // answer. So the constant compared against here is `0.771`, and the correction is recorded in
  // `data/population-tape-2026-07-29/IMPORT.md` → "Corrections", which is where a contradiction of
  // the imported prose goes; the report and the dataset README are a primary record and are not
  // edited.
  //
  // Why this matters more than 0.003 of a share: until now the 0.02 tolerance was absorbing a real
  // **−0.0115** defect (the co-ordination rule finding nothing on 3 of the 89 launches, so ~9.6–10.0
  // SOL of the operation's own stake was booked as outsider capital) and a **+0.0028** documentation
  // error, which partially cancelled. The check passed for the wrong reason. Refusing to score an
  // unproven opening removes the first; re-pinning removes the second.
  //
  /** @type {{ era: string, lo: string, hi: string, share: number, minN: number, published: string }[]} */
  const eras = [
    {
      era: '2026-05-01 … 06-03',
      lo: '2026-05-01',
      hi: '2026-06-03',
      share: 0.451,
      minN: 20,
      published: 'dev 9.876543209 · co-ord 6.91 SOL · 5 wallets · independent 21.18 · share 0.451',
    },
    {
      era: '2026-06-04 … 07-29',
      lo: REGIME_BOUNDARY,
      hi: '2026-07-30',
      share: 0.771,
      minN: 20,
      published:
        'dev 14.814814813 · co-ord 19.75 SOL · 6 wallets · independent 10.84 · share 0.771 ' +
        '(§5.1 printed 0.768 — corrected, see IMPORT.md)',
    },
  ];

  // Measured over the launches the screen would actually SCORE, which is the point of the check:
  // this reproduces the room primitive as a live run computes it, and a live run no longer computes
  // it on a launch whose create slot carried no bundled transaction. Era 1 is unaffected (all 45 of
  // its launches bundled); era 2 loses the 3 that did not, leaving 86 and a median share of 0.769
  // — the remaining 0.002 from 0.771 is the order statistic moving when three launches leave an
  // 89-launch series, not a residual defect.
  const eraSplit = eras.map((e) => {
    const all = launches.filter((l) => {
      const d = l.dateIso.slice(0, 10);
      return d >= e.lo && d <= e.hi;
    });
    const inEra = all.filter((l) => roomIsProven(l.createSlot));
    const cs = inEra.map((l) => l.createSlot);
    return {
      era: e.era,
      n: inEra.length,
      nRoomUnproven: all.length - inEra.length,
      minN: e.minN,
      devSolMedian: median(cs.map((m) => m.devSol)),
      coordinatedSolMedian: median(cs.map((m) => m.coordinatedSol)),
      coordinatedWalletsMedian: median(cs.map((m) => m.coordinatedWallets)),
      independentSolMedian: median(cs.map((m) => m.independentSol)),
      operationShareMedian: median(cs.map((m) => m.operationShare)),
      publishedOperationShare: e.share,
      published: e.published,
    };
  });

  // --- (5) the field measurement, against the dataset's own committed P&L table ---------------
  const fieldCheck = verifyFieldReproduction(dataDir, launches);

  // --- (6) THE KNOWN-NEGATIVE CONTROL -------------------------------------------------------
  // Scored two ways, because both readings have to come out negative and they can fail apart:
  //
  //   `subjectEntryRecent`    — the most recent N launches, no era filter. This is EXACTLY what a
  //                             live run does to a stranger, so it is the reading that would
  //                             actually be produced today.
  //   `subjectEntryPostBreak` — the whole 2026-06-04 → regime, which is the population the June
  //                             report measured and therefore the one whose answer is published.
  //
  // If the recent slice ever drifts positive while the era slice stays negative, the sampling
  // window has become the thing carrying the verdict, which is precisely the artefact this project
  // caught the vendor committing with its own trailing-window "lifetime" rate.
  const recentLaunches = launches.slice(-entryThresholds.maxLaunchesPerCandidate);
  const subjectEntryRecent = scoreEntry(recentLaunches, entryThresholds, {
    candidateWallet: SUBJECT_DEPLOYER,
  });
  const postBreak = launches.filter((l) => l.dateIso.slice(0, 10) >= REGIME_BOUNDARY);
  const subjectEntryPostBreak = scoreEntry(postBreak, entryThresholds, {
    candidateWallet: SUBJECT_DEPLOYER,
  });

  // --- (7) THE ROLLING REPLAY -----------------------------------------------------------------
  // The same question as (6), asked at every point in the tape's history rather than at two. See
  // `replayRollingRoom`: (6) samples only the months where the co-ordination rule works.
  const rollingRoom = replayRollingRoom(launches, entryThresholds);

  // --- (8) THE COST LEG, against the committed on-chain table ---------------------------------
  // Free, offline and deterministic like the rest, and it is the only check that exercises what a
  // live run now spends Solana RPC requests on. See `verifyOnChainCostReproduction`.
  const costCheck = verifyOnChainCostReproduction(dataDir, launches, entryThresholds);

  const room = controls.map((c) => c.roomLeftUpperBound);
  const controlPopulation = {
    n: controls.length,
    roomP25: percentile(room, 0.25),
    roomMedian: median(room),
    roomP75: percentile(room, 0.75),
  };
  const controlPresets = {
    n: controls.length,
    groupedPreset15: controls.filter((c) => c.group === 'preset15').length,
  };

  /** @type {string[]} */
  const failures = [];

  if (!curveCheck.ok) {
    failures.push(
      `curve inversion drifted: max error ${curveCheck.maxAbsErrorSol.toExponential(3)} SOL ` +
        `over ${curveCheck.n} control launches`,
    );
  }

  // Ground truth must not have moved. These are the numbers every vendor claim is measured
  // against, so a change here means the dataset changed under us.
  if (groundTruth.tokens !== 239 || groundTruth.completed !== 103) {
    failures.push(
      `ground truth moved: launches.csv now reads ${groundTruth.completed}/${groundTruth.tokens}, ` +
        `expected 103/239`,
    );
  }

  // The load-bearing assertion. The gate MUST pass this wallet — that is what makes Stage 0 a
  // demonstration that the gate is not a recommendation.
  if (!subjectGate.passed) {
    failures.push(
      `the gate REJECTED our subject deployer (${subjectGate.reasons.join('; ')}). It completes ` +
        `${groundTruth.completed}/${groundTruth.tokens} launches over ` +
        `${groundTruth.spanDays.toFixed(0)} days and is a genuinely competent operator, so a ` +
        `threshold that excludes it is indefensible.`,
    );
  }

  // The seam must still reproduce the published figures, or the primitive the next lane inherits
  // is not the one that was validated. The n and finiteness checks come FIRST and are not
  // decoration: without them an empty bucket makes the comparison below a no-op that reports
  // PASSED, and a PASSED Stage 0 is what authorises spending keyed quota on strangers.
  for (const e of eraSplit) {
    if (e.n < e.minN) {
      failures.push(
        `era ${e.era}: only ${e.n} launches matched, below the ${e.minN} this check needs to mean ` +
          `anything. An empty or hollowed-out bucket makes the operation-share comparison vacuous ` +
          `rather than failing it, so it is failed here instead — check the tape and --data-dir.`,
      );
      continue;
    }
    if (!Number.isFinite(e.operationShareMedian)) {
      failures.push(
        `era ${e.era}: operation share is not a finite number (${String(e.operationShareMedian)}) ` +
          `over ${e.n} launches, so the seam did not reproduce anything`,
      );
      continue;
    }
    if (Math.abs(e.operationShareMedian - e.publishedOperationShare) > 0.02) {
      failures.push(
        `era ${e.era}: operation share ${e.operationShareMedian.toFixed(3)} does not reproduce the ` +
          `published ${e.publishedOperationShare} within 0.02 — the co-ordination rule may have drifted`,
      );
    }
  }

  // The field measurement must land on the dataset's own columns, or the live measurement is
  // running a recipe that was never checked against anything.
  if (!fieldCheck.ok) {
    failures.push(
      `the field measurement no longer reproduces wallet_launch_pnl.csv: ${fieldCheck.pairs} pair(s) ` +
        `compared, ${fieldCheck.closureMismatches} closure mismatch(es), ` +
        `${fieldCheck.missingFromCsv} pair(s) absent from the table, max realised error ` +
        `${fieldCheck.maxRealisedErrorSol.toExponential(3)} SOL. Every realised figure Stage 2 ` +
        `reports is computed by that recipe, so a drift here invalidates all of them.`,
    );
  }

  // THE KNOWN-NEGATIVE CONTROL, and it is the counterpart of the gate assertion above. The gate
  // MUST pass this wallet; Stage 2 MUST refuse it. `7ufmve7Z…` is competent and it is not beatable
  // — measured in data/slot-zero-june-regime-change/report.md §5, §6, not assumed — so a Stage 2
  // that scores it as having room is a Stage 2 that is wrong, whatever else it gets right.
  //
  // Note which leg would produce the wrong answer if it were allowed to: the FIELD leg, read on its
  // own, is positive here. Gross of fees this wallet's post-break field is ~77% of closed round
  // trips above zero, because the fill tape carries no priority fee, no landing tip and no venue
  // fee. The verdict has to survive a leg pointing the wrong way, which is why the field can only
  // ever veto and never pass.
  for (const [label, score] of /** @type {[string, import('./entry.mjs').EntryScore][]} */ ([
    ['the most recent launches (what a live run would score today)', subjectEntryRecent],
    ['the whole post-2026-06-04 regime', subjectEntryPostBreak],
    ['the post-2026-06-04 regime WITH its on-chain costs attached', costCheck.postBreakScore],
  ])) {
    if (score.verdict === 'entry-open-after-costs') {
      failures.push(
        `STAGE 2 SCORED OUR SUBJECT DEPLOYER AS ENTERABLE AFTER COSTS, over ${label}. That wallet is ` +
          `the known negative: its opening window has been unprofitable for outsiders since ` +
          `2026-06-04 because its own group takes 97% of the profit available there ` +
          `(slot-zero-june-regime-change/report.md §6.1). Measured room here is ` +
          `${score.roomLeft.median.toFixed(3)} against a ${entryThresholds.minRoomLeft} bar. ` +
          `Something in the entry score has drifted — check first whether the field leg has been ` +
          `allowed to carry a positive verdict, because gross of fees it reads ` +
          `${score.fieldHitRateGrossOfFees.hits}/${score.fieldHitRateGrossOfFees.n} positive and ` +
          `says the opposite of the truth.`,
      );
    }
    if (score.verdict === 'entry-unmeasured') {
      failures.push(
        `Stage 2 could not measure our subject deployer over ${label} (${score.rationale}). The ` +
          `known-negative control is only a control if it actually runs, and an UNMEASURED result ` +
          `is not a negative one.`,
      );
    }
  }

  // THE COST LEG. It is checked for the two things a wiring error would break silently: that
  // netting measured fees moves the field DOWN, and that the seat is not free. The direction is the
  // point — an error that raised the net figure above the gross one would manufacture exactly the
  // after-cost edge the captain's ruling exists to test for.
  if (!costCheck.ok) {
    failures.push(
      `THE ON-CHAIN COST REPRODUCTION FAILED. ${costCheck.launchesPriced} launch(es) priced ` +
        `(needs ${costCheck.minLaunches}), ${costCheck.entriesPriced}/${costCheck.entries} ` +
        `create-slot entries costed, ${costCheck.pairsPriced} closed round trips priced end to end ` +
        `(needs ${costCheck.minPairs}); median entry cost ${costCheck.entryCostMedianSol.toFixed(4)} SOL ` +
        `and ${(costCheck.entryCostPositiveShare * 100).toFixed(1)}% of entries above zero; field hit ` +
        `rate ${costCheck.grossHitRate.toFixed(4)} gross against ${costCheck.netHitRate.toFixed(4)} NET, ` +
        `median ${costCheck.grossMedianSol.toFixed(4)} against ${costCheck.netMedianSol.toFixed(4)} SOL. ` +
        `Netting measured fees must move the field DOWN and the seat must cost something; a reading ` +
        `that says otherwise is a sign error in the cost leg, not a discovery. Post-break verdict with ` +
        `costs attached: ${costCheck.postBreakScore.verdict.toUpperCase()}.`,
    );
  }

  // THE ROLLING REPLAY. A false positive here is a window in which the screen would have called our
  // own known-negative wallet enterable when the named cohort says it was not — the exact defect
  // this control was added for, and the direction the captain has ruled unacceptable. False
  // negatives are NOT failed: refusing to score an unproven opening costs coverage on purpose.
  if (!rollingRoom.ok) {
    const worst = [...rollingRoom.falsePositiveWindows].sort(
      (a, b) => b.screenRoomMedian - b.truthRoomMedian - (a.screenRoomMedian - a.truthRoomMedian),
    )[0];
    failures.push(
      `THE ROLLING REPLAY FOUND ${rollingRoom.falsePositives} FALSE POSITIVE(S) of ` +
        `${rollingRoom.windows} trailing windows: the screen scores ENTRY ROOM where the named ` +
        `six-wallet cohort says there was none. Every error the co-ordination rule can make runs in ` +
        `this direction — a co-ordinated wallet it misses moves into the outsider half and INFLATES ` +
        `room — so this is the failure mode the whole control exists for.` +
        (worst === undefined
          ? ''
          : ` Worst window ends ${worst.atIso.slice(0, 10)}: screen ` +
            `${worst.screenRoomMedian.toFixed(3)} against a true ${worst.truthRoomMedian.toFixed(3)} ` +
            `over ${worst.scored} scored launch(es).`) +
        ` Check first whether launches with NO bundled create-slot transaction have been allowed ` +
        `back into the score (measure.mjs -> roomIsProven, captain decision 134a).`,
    );
  }

  return {
    curveCheck,
    eraSplit,
    groundTruth,
    subjectGate,
    subjectVerdict,
    fieldCheck,
    subjectEntryRecent,
    subjectEntryPostBreak,
    rollingRoom,
    costCheck,
    controlPopulation,
    controlPresets,
    passed: failures.length === 0,
    failures,
  };
}
