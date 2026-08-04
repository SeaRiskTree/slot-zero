/**
 * The per-launch series, computed offline from the persisted fills. No network, no credential.
 *
 * ## The definition, and it is §2.1's
 *
 * `analysis/window-population/README.md` §2.1: **a launch pays if the outsiders who reached its
 * create slot, taken together, closed their round trips for more than they staked.** Four choices
 * inside that, each load-bearing and each reproduced here rather than re-argued:
 *
 * - **The create slot, and only the create slot.** Pooled over the committed tape the median closed
 *   round trip is +0.283 SOL in slot 0, +0.011 in slot 1, and within half a hundredth of zero in
 *   every slot after. A definition spanning all entrants averages a real edge against a crowd that
 *   never had one.
 * - **Closed round trips only.** An open position has no complete P&L by construction, and summing
 *   the open half of the committed tape fabricates a loss of over 5,000 SOL.
 * - **The whole outsider population per launch, not the best wallet**, which is a maximum over ~6
 *   draws and rises with attendance.
 * - **Gross of fees.** Everything derived from a fill tape alone is gross, so every figure here is
 *   an **upper bound** and every field name says so.
 *
 * ## The all-entrant series is produced too, and it is a FLOOR — captain decision 164c
 *
 * The walk persists every fill in the window, so both readings come out of one pass and the
 * definitional choice is settled against real numbers. But the two are not equally sound, and the
 * weaker one is labelled at the point of use rather than in a document a reader may never open:
 * {@link ALL_ENTRANT_FLOOR_CAVEAT} is attached to every row that carries an all-entrant number, and
 * the field name itself carries `Floor`.
 *
 * **Why it is a floor.** Closure is measured inside a bounded window, and an entrant who arrives at
 * second 55 of a 60-second window has five seconds to close. Over 626 create-slot outsider pairs the
 * closure curve rises 0.588 at 10 s → 0.754 at 40 s → 0.784 at 65 s → 0.858 at 300 s → 0.947 at one
 * hour, so a window cut at any of those instants leaves real round trips uncounted, and they are
 * disproportionately the *late* entrants — precisely the population an all-entrant series is about.
 * The create-slot series is far less exposed: create-slot outsiders close early, which is why 65 s
 * sits in the flattest part of that curve.
 *
 * **What is NOT a reason, and must not be quoted as one here.** The blast report measured a second
 * shortfall — 69 pairs and 17.1 SOL on an all-entrant reading — caused by `readLaunchWindow`'s
 * cursor reaching a shorter distance than its own membership filter. `walk.mjs` has one bound in one
 * unit, so that shortfall is **structurally absent from this tape** and its figures do not describe
 * this data. The floor label survives on the window-boundedness argument alone.
 */

/**
 * A position counts as closed when the residual is within 0.1% of the tokens bought.
 *
 * Not a choice — it is the committed dataset's own `closed_in_window` rule, and matching it is what
 * makes a series measured here comparable to the published one. The test suite reproduces it against
 * `wallet_launch_pnl.csv` rather than trusting it: **1,057 (wallet, launch) pairs over five walked
 * launches, max realised difference 5e-7 SOL, and exactly two closure differences.**
 *
 * **Those two are a deliberate difference and it runs one way.** Both are wallets that SOLD inside
 * the window having bought nothing in it. The dataset reads residual 0 as closed, which gives them
 * `realised = sol_out - 0`: a positive P&L on a position that was never opened here. {@link
 * walletTotals} requires `tokensBought > 0`, exactly as `tools/deployer-screen/entry.mjs` does, so
 * such a wallet is reported **open** and contributes nothing. It cannot reach the create-slot series
 * at all — that population is drawn from create-slot *buys* — so the difference lands only on the
 * all-entrant reading, and it lands in the direction that refuses to book free money.
 */
export const RESIDUAL_TOLERANCE = 0.001;

/**
 * The one sentence that must travel with every all-entrant figure. It reaches the row, the CSV and
 * the report — not just a doc.
 */
export const ALL_ENTRANT_FLOOR_CAVEAT =
  'THE ALL-ENTRANT FIGURE IS A FLOOR. Closure is measured inside a bounded window, so an entrant ' +
  'who arrived near its end had almost no time to close and is counted as open. The loss falls ' +
  'disproportionately on late entrants, which is the population this reading is about. The ' +
  'create-slot reading beside it is far less exposed, because create-slot outsiders close early.';

/**
 * The one sentence that must travel with the zero-closed-pair exclusion count.
 *
 * **It scopes the published magnitude to the population that magnitude was measured over**, for the
 * same reason {@link ALL_ENTRANT_FLOOR_CAVEAT} refuses to attach the blast report's 69-pairs figure
 * to this tape: a number measured over one population does not describe another merely because the
 * two overlap. It is one string, quoted verbatim by `arrival.json` and by this tool's README, so the
 * three copies of the claim cannot drift.
 */
export const ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT =
  'A measured launch with NO closed create-slot outsider round trip is EXCLUDED from the rank test ' +
  'rather than entered as a 0, which is the exclusion the published measurement makes; 0 is a real ' +
  'level in this series. THE PUBLISHED MAGNITUDE FOR THAT CHOICE WAS MEASURED OVER A NARROWER ' +
  'POPULATION: section 11 reads it over the 25 launches with no outsider in the create slot AT ALL, ' +
  'where imputing zeros lowers the window\'s median prize by roughly a fifth and moves neither ' +
  'break. What is excluded here is wider — every launch with no CLOSED create-slot round trip, ' +
  'which on the committed tape is 42: those 25 plus 17 that had outsiders and closed none. Over ' +
  'that wider set the imputation is not harmless, and this lane\'s own reproduction test measures ' +
  'it: the imputed zeros flatten the level enough that no break is detected and the published ' +
  'window disappears entirely. Both readings are true of their own population, and neither figure ' +
  'may be quoted as the other. The excluded launches stay rows in series.csv, because attendance is ' +
  'evidence even when P&L is not.';

/** The one sentence that must travel with every figure derived from a fill tape alone. */
export const GROSS_OF_FEES_CAVEAT =
  'EVERY FIGURE HERE IS GROSS OF FEES and is therefore an UPPER BOUND. Only on-chain pricing is ' +
  'fee-inclusive, and this lane does none. On the committed tape the same population read +0.396 ' +
  'per SOL gross inside the window and 0.540 of that once priced.';

/** @param {string} v @returns {number} */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * @typedef {object} CreateSlotGroups
 * @property {number} slot
 * @property {string} firstBuyer          The wallet that buys first in the create slot.
 * @property {Set<string>} operation      Wallets attributed to the operation: the declared deployer,
 *   the first create-slot buyer, and everyone the co-ordination rule marks.
 * @property {Set<string>} coordinated    What the co-ordination rule alone marked.
 * @property {import('./trades.mjs').Fill[]} inSlot Create-slot curve buys, ordered by `sid`.
 * @property {number} bundledTx           Create-slot transactions carrying 2+ distinct wallets.
 * @property {number} maxWalletsInOneTx
 */

/**
 * Partition a launch's create slot into the operation and everyone else.
 *
 * **The co-ordination rule**: a create-slot transaction carrying 2+ distinct wallets marks all of
 * them as the operation's. It is what makes this method work on a stranger, where no cohort is known
 * — and it is a **floor on the evidence**, not a guarantee: a create slot where two unrelated
 * wallets share an aggregator route also qualifies, and one where the operation bundled nothing at
 * all recovers none of it.
 *
 * **The declared deployer is excluded as well as the first buyer, and the union is deliberate.** The
 * declared deployer is the signer of the create transaction, which is what Dune attributes on; the
 * first create-slot buyer is what the committed tape's own method reads as the deployer. They are
 * normally the same wallet. When they are not, excluding both counts one extra wallet as the
 * operation, which pushes the measured prize **down** — the direction that fails to detect a window
 * rather than the direction that manufactures one.
 *
 * @param {readonly import('./trades.mjs').Fill[]} fills
 * @param {string | null} declaredDeployer The create's signer, from the Dune launch list.
 * @returns {CreateSlotGroups | null} `null` when there is no curve buy to anchor on.
 */
export function createSlotGroups(fills, declaredDeployer = null) {
  const curveBuys = fills.filter((f) => f.k === 'buy' && f.p === 'pump');
  if (curveBuys.length === 0) return null;

  let slot = Infinity;
  for (const f of curveBuys) if (f.slot < slot) slot = f.slot;
  const inSlot = curveBuys.filter((f) => f.slot === slot).sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
  const first = inSlot[0];
  if (first === undefined) return null;

  /** @type {Map<string, Set<string>>} */
  const walletsByTx = new Map();
  for (const f of inSlot) {
    let set = walletsByTx.get(f.tx);
    if (set === undefined) {
      set = new Set();
      walletsByTx.set(f.tx, set);
    }
    set.add(f.u);
  }

  /** @type {Set<string>} */
  const coordinated = new Set();
  let bundledTx = 0;
  let maxWalletsInOneTx = 0;
  for (const set of walletsByTx.values()) {
    if (set.size > maxWalletsInOneTx) maxWalletsInOneTx = set.size;
    if (set.size >= 2) {
      bundledTx += 1;
      for (const w of set) coordinated.add(w);
    }
  }

  const operation = new Set(coordinated);
  operation.add(first.u);
  if (declaredDeployer !== null && declaredDeployer !== '') operation.add(declaredDeployer);
  coordinated.delete(first.u);

  return { slot, firstBuyer: first.u, operation, coordinated, inSlot, bundledTx, maxWalletsInOneTx };
}

/**
 * Whether this launch's create slot carries enough evidence to be scored at all.
 *
 * Captain decision 134a. Without a bundled transaction the co-ordination rule cannot see anything,
 * and finding nothing is indistinguishable from there being nothing — reading it as the second books
 * the operation's own stake as outsider capital. On the committed tape that removed 24 of 24
 * false-positive rolling windows for 0 true positives.
 *
 * **The refusal has a steep time gradient and that is a limit of the method, not a defect of the
 * rule**: on the graduated 102, proven launches run 0.000 in 2025-12, 0.375 in 2026-03, 1.000 from
 * 2026-05. A six-month backwards series is therefore systematically less measurable at its OLD end,
 * so a window that opened early is less visible than one that opened late. Unproven launches are
 * counted as **unmeasured**, never as zero.
 *
 * **THIS IS THE SHARED-TRANSACTION HALF ONLY, AND IT HAS DIVERGED FROM THE SCREEN'S.** Captain
 * decision 182a widened `tools/deployer-screen/measure.mjs` → `roomIsProven` to the UNION of that
 * rule and a deployer-anchored contiguous block-index run, which on the committed tape takes the
 * refusal from 60 of 235 launches to 0. This lane keeps the narrower predicate on purpose: 182a's
 * room readings were verified against the ONE deployer whose cohort is named, and this tool's whole
 * point is a cohort of strangers for whom no answer key exists — so adopting it here would change
 * every published series with nothing to check the change against. Widening it is a decision of its
 * own, and the time gradient above is exactly the thing it would move. The duplication with
 * `measure.mjs` is this directory boundary's deliberate cost (see the repo `CLAUDE.md`); the
 * divergence in the RULE is now a second, separate cost and is recorded here so nobody reconciles
 * the two by accident.
 *
 * @param {Pick<CreateSlotGroups, 'bundledTx'>} groups
 * @returns {boolean}
 */
export function roomIsProven(groups) {
  return groups.bundledTx >= 1;
}

/**
 * @typedef {object} WalletTotals
 * @property {number} solIn
 * @property {number} solOut
 * @property {number} tokensBought
 * @property {number} tokensSold
 * @property {boolean} closed
 * @property {number} realisedSolGrossOfFees `NaN` when the position never closed.
 */

/**
 * Per-wallet totals over a window's fills, and the closure test on top of them.
 *
 * An unreadable token amount makes closure undecidable, and undecidable is reported as **open**,
 * never as closed: a wrongly-closed pair contributes a fabricated P&L, whereas a wrongly-open one
 * only shrinks the sample and says so.
 *
 * @param {readonly import('./trades.mjs').Fill[]} fills
 * @returns {Map<string, WalletTotals>}
 */
export function walletTotals(fills) {
  /** @type {Map<string, WalletTotals>} */
  const totals = new Map();
  for (const f of fills) {
    let t = totals.get(f.u);
    if (t === undefined) {
      t = { solIn: 0, solOut: 0, tokensBought: 0, tokensSold: 0, closed: false, realisedSolGrossOfFees: Number.NaN };
      totals.set(f.u, t);
    }
    const sol = num(f.sol);
    const tokens = num(f.base);
    if (f.k === 'buy') {
      t.solIn += sol;
      t.tokensBought += tokens;
    } else {
      t.solOut += sol;
      t.tokensSold += tokens;
    }
  }
  for (const t of totals.values()) {
    const decidable = Number.isFinite(t.tokensBought) && Number.isFinite(t.tokensSold);
    t.closed = decidable && t.tokensBought > 0 && t.tokensBought - t.tokensSold <= RESIDUAL_TOLERANCE * t.tokensBought;
    t.realisedSolGrossOfFees = t.closed ? t.solOut - t.solIn : Number.NaN;
  }
  return totals;
}

/**
 * @typedef {object} LaunchMeasurement
 * @property {string} mint
 * @property {string} deployer          The declared deployer, as asked about.
 * @property {number} mintMs
 * @property {boolean} measured         False when the launch is UNMEASURED — no fills, an unproved
 *   walk, or no bundled create-slot transaction. **Never read as a zero prize.**
 * @property {string | null} unmeasuredReason
 * @property {number | null} createSlot
 * @property {boolean} deployerIsFirstBuyer Whether the create's signer is also the first curve buyer.
 * @property {number} bundledTx
 * @property {number} maxWalletsInOneTx
 * @property {number} createSlotOutsiders            Distinct non-operation wallets in the create slot.
 * @property {number} createSlotClosedPairs
 * @property {number} createSlotStakeSol             `sol_in` over the closed create-slot outsider pairs.
 * @property {number} createSlotPrizeSolGrossOfFees  §2.1's per-launch prize.
 * @property {number} createSlotReturnPerSolGrossOfFees `NaN` when nothing was staked.
 * @property {number} allEntrantClosedPairsFloor
 * @property {number} allEntrantStakeSolFloor
 * @property {number} allEntrantPrizeFloorSolGrossOfFees  **A FLOOR** — see {@link ALL_ENTRANT_FLOOR_CAVEAT}.
 * @property {number} allEntrantReturnPerSolFloorGrossOfFees
 * @property {number} fills
 * @property {number} wallets
 * @property {string[]} caveats
 */

/**
 * Measure one launch from its persisted fills.
 *
 * @param {object} input
 * @param {string} input.mint
 * @param {string} input.deployer      The create's signer.
 * @param {number} input.mintMs
 * @param {readonly import('./trades.mjs').Fill[]} input.fills
 * @param {boolean} input.reachedMint  Whether the walk PROVED it reached the create slot.
 * @returns {LaunchMeasurement}
 */
export function measureLaunch({ mint, deployer, mintMs, fills, reachedMint }) {
  /** @type {LaunchMeasurement} */
  const base = {
    mint,
    deployer,
    mintMs,
    measured: false,
    unmeasuredReason: null,
    createSlot: null,
    deployerIsFirstBuyer: false,
    bundledTx: 0,
    maxWalletsInOneTx: 0,
    createSlotOutsiders: 0,
    createSlotClosedPairs: 0,
    createSlotStakeSol: 0,
    createSlotPrizeSolGrossOfFees: 0,
    createSlotReturnPerSolGrossOfFees: Number.NaN,
    allEntrantClosedPairsFloor: 0,
    allEntrantStakeSolFloor: 0,
    allEntrantPrizeFloorSolGrossOfFees: 0,
    allEntrantReturnPerSolFloorGrossOfFees: Number.NaN,
    fills: fills.length,
    wallets: new Set(fills.map((f) => f.u)).size,
    caveats: [GROSS_OF_FEES_CAVEAT, ALL_ENTRANT_FLOOR_CAVEAT],
  };

  if (!reachedMint) {
    // An unproved walk's oldest slot is merely the oldest it reached, so a create-slot measure over
    // it would crown a mid-window sniper as the deployer. Unmeasured, never zero.
    return { ...base, unmeasuredReason: 'the walk did not prove it reached the create slot' };
  }
  const groups = createSlotGroups(fills, deployer);
  if (groups === null) {
    return { ...base, unmeasuredReason: 'the window holds no bonding-curve buy to anchor a create slot on' };
  }

  const totals = walletTotals(fills);
  let outsiders = 0;
  let closedPairs = 0;
  let stake = 0;
  let prize = 0;
  /** @type {Set<string>} */
  const createSlotWallets = new Set();
  for (const f of groups.inSlot) if (!groups.operation.has(f.u)) createSlotWallets.add(f.u);
  for (const wallet of createSlotWallets) {
    outsiders += 1;
    const t = totals.get(wallet);
    if (t === undefined || !t.closed) continue;
    closedPairs += 1;
    stake += t.solIn;
    prize += t.realisedSolGrossOfFees;
  }

  let allClosed = 0;
  let allStake = 0;
  let allPrize = 0;
  for (const [wallet, t] of totals) {
    if (groups.operation.has(wallet) || !t.closed) continue;
    allClosed += 1;
    allStake += t.solIn;
    allPrize += t.realisedSolGrossOfFees;
  }

  const measured = roomIsProven(groups);
  return {
    ...base,
    measured,
    unmeasuredReason: measured
      ? null
      : 'no create-slot transaction carried 2+ distinct wallets, so the co-ordination rule saw ' +
        'nothing and the operation\'s own stake cannot be told from outsider capital',
    createSlot: groups.slot,
    deployerIsFirstBuyer: groups.firstBuyer === deployer,
    bundledTx: groups.bundledTx,
    maxWalletsInOneTx: groups.maxWalletsInOneTx,
    createSlotOutsiders: outsiders,
    createSlotClosedPairs: closedPairs,
    createSlotStakeSol: stake,
    createSlotPrizeSolGrossOfFees: prize,
    createSlotReturnPerSolGrossOfFees: stake > 0 ? prize / stake : Number.NaN,
    allEntrantClosedPairsFloor: allClosed,
    allEntrantStakeSolFloor: allStake,
    allEntrantPrizeFloorSolGrossOfFees: allPrize,
    allEntrantReturnPerSolFloorGrossOfFees: allStake > 0 ? allPrize / allStake : Number.NaN,
  };
}

/**
 * @typedef {object} RankInput
 * @property {Map<string, import('./arrival.mjs').SeriesPoint[]>} byDeployer Ascending by `mintMs`.
 * @property {number} launchesInRankTest        Points that actually reach the segmentation.
 * @property {number} launchesUnmeasured        Launches with no complete create-slot reading at all.
 * @property {number} launchesNoClosedCreateSlotPair Measured launches DROPPED for having no closed
 *   create-slot outsider round trip — see {@link toSeriesPoints}.
 */

/**
 * Turn per-launch measurements into the per-deployer input the rank test reads.
 *
 * **A measured launch with no closed create-slot outsider round trip is DROPPED, never imputed as
 * 0.** Its stake is zero, so §2.1's return per SOL does not exist for it — and 0 is a real level in
 * this series, not a null one: it is exactly what a launch whose outsiders broke even reads. The
 * published measurement excludes these launches for the same reason (`analysis/window-population/
 * measure.mjs` segments over `series.filter((r) => r.trips > 0)`).
 * {@link import('./arrival.mjs').findWindows} says the same thing from the other side — an
 * unmeasured launch must not enter a rank test as one.
 *
 * They are not discarded: every one of them is a row in `series.csv`, because attendance is evidence
 * even when P&L is not, and the count is reported so the exclusion is visible rather than silent.
 * {@link ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT} is the sentence that travels with the count, and it is
 * careful about **which population** the published magnitude was measured over.
 *
 * @param {readonly LaunchMeasurement[]} rows
 * @returns {RankInput}
 */
export function toSeriesPoints(rows) {
  /** @type {Map<string, import('./arrival.mjs').SeriesPoint[]>} */
  const byDeployer = new Map();
  let launchesInRankTest = 0;
  let launchesUnmeasured = 0;
  let launchesNoClosedCreateSlotPair = 0;
  for (const r of rows) {
    if (!r.measured) {
      launchesUnmeasured += 1;
      continue;
    }
    if (!Number.isFinite(r.createSlotReturnPerSolGrossOfFees)) {
      launchesNoClosedCreateSlotPair += 1;
      continue;
    }
    const list = byDeployer.get(r.deployer) ?? [];
    list.push({
      mint: r.mint,
      mintMs: r.mintMs,
      returnPerSol: r.createSlotReturnPerSolGrossOfFees,
      prizeSol: r.createSlotPrizeSolGrossOfFees,
    });
    byDeployer.set(r.deployer, list);
    launchesInRankTest += 1;
  }
  for (const list of byDeployer.values()) list.sort((a, b) => a.mintMs - b.mintMs);
  return { byDeployer, launchesInRankTest, launchesUnmeasured, launchesNoClosedCreateSlotPair };
}

/**
 * The header a series CSV is written with. **The all-entrant columns carry `floor` in their own
 * names**, so a reader who never opens the README still cannot mistake one for a total.
 */
export const SERIES_COLUMNS = Object.freeze([
  'deployer',
  'mint',
  'created_utc',
  'measured',
  'unmeasured_reason',
  'create_slot',
  'deployer_is_first_buyer',
  'bundled_tx',
  'max_wallets_in_one_tx',
  'create_slot_outsiders',
  'create_slot_closed_pairs',
  'create_slot_stake_sol',
  'create_slot_prize_sol_gross_of_fees',
  'create_slot_return_per_sol_gross_of_fees',
  'all_entrant_closed_pairs_floor',
  'all_entrant_stake_sol_floor',
  'all_entrant_prize_floor_sol_gross_of_fees',
  'all_entrant_return_per_sol_floor_gross_of_fees',
  'fills',
  'wallets',
]);

/**
 * One series row, in {@link SERIES_COLUMNS} order.
 *
 * @param {LaunchMeasurement} m
 * @returns {(string | number)[]}
 */
export function seriesRow(m) {
  const f = (/** @type {number} */ v) => (Number.isFinite(v) ? v : '');
  // The same treatment `f` gives a number, for the one field that is a DATE. A torn sidecar leaves
  // no readable `created_timestamp`, and `new Date(NaN).toISOString()` throws — which would abort
  // the whole offline series phase over one launch's interrupted write, exactly what reporting an
  // unreadable checkpoint as a counted refusal exists to prevent.
  const at = (/** @type {number} */ v) => (Number.isFinite(v) ? new Date(v).toISOString() : '');
  return [
    m.deployer,
    m.mint,
    at(m.mintMs),
    m.measured ? 1 : 0,
    m.unmeasuredReason ?? '',
    m.createSlot ?? '',
    m.deployerIsFirstBuyer ? 1 : 0,
    m.bundledTx,
    m.maxWalletsInOneTx,
    m.createSlotOutsiders,
    m.createSlotClosedPairs,
    f(m.createSlotStakeSol),
    f(m.createSlotPrizeSolGrossOfFees),
    f(m.createSlotReturnPerSolGrossOfFees),
    m.allEntrantClosedPairsFloor,
    f(m.allEntrantStakeSolFloor),
    f(m.allEntrantPrizeFloorSolGrossOfFees),
    f(m.allEntrantReturnPerSolFloorGrossOfFees),
    m.fills,
    m.wallets,
  ];
}
