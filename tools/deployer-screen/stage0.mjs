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
 *     beatable.** Gross of fees its post-break field is 76.5% of closed round trips positive at a
 *     median +0.12 SOL, while the fee-inclusive record is +0.54 SOL per launch shared by 106
 *     wallets with 51 of them negative. So the check is not that some number is below some bar —
 *     it is that the composite verdict resists a leg that points the wrong way.
 *
 * All of it reads committed files. No network, no key, no quota.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { measureLaunchEntry, scoreEntry } from './entry.mjs';
import {
  CURVE_INITIAL_PRICE_SOL,
  CURVE_K,
  measureCompletion,
  median,
  parseFill,
  percentile,
  solBetweenPrices,
} from './measure.mjs';
import { applyGate, verdictFor } from './rank.mjs';

/** The deployer the whole dataset is about. `src/cohort.ts` carries the same constant. */
export const SUBJECT_DEPLOYER = '7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL';

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
 */

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

    out.push({
      mint,
      dateIso: new Date(Number(meta['created_timestamp'])).toISOString(),
      createSlot: entry.createSlot,
      field: entry.field,
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
 * @property {number} n
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
  // shifted date range — is exactly that case. The buckets hold 45 and 89 launches as committed, so
  // a floor of 20 leaves room for ordinary variation while refusing a hollowed-out bucket.
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
      share: 0.768,
      minN: 20,
      published: 'dev 14.814814813 · co-ord 19.75 SOL · 6 wallets · independent 10.84 · share 0.768',
    },
  ];

  const eraSplit = eras.map((e) => {
    const inEra = launches.filter((l) => {
      const d = l.dateIso.slice(0, 10);
      return d >= e.lo && d <= e.hi;
    });
    const cs = inEra.map((l) => l.createSlot);
    return {
      era: e.era,
      n: inEra.length,
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
  ])) {
    if (score.verdict === 'entry-room-present') {
      failures.push(
        `STAGE 2 SCORED OUR SUBJECT DEPLOYER AS HAVING ENTRY ROOM, over ${label}. That wallet is ` +
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

  return {
    curveCheck,
    eraSplit,
    groundTruth,
    subjectGate,
    subjectVerdict,
    fieldCheck,
    subjectEntryRecent,
    subjectEntryPostBreak,
    controlPopulation,
    controlPresets,
    passed: failures.length === 0,
    failures,
  };
}
