/**
 * The decision half of the window-decay tripwire. **Pure: no network, no clock, no filesystem.**
 *
 * The question this answers is narrow and it is the lane's whole point: *the window we are
 * currently trading — has it closed?* It never asks whether a window is worth opening, never
 * scores a stranger, and never re-polls a wallet it has already stopped on. `README.md` beside
 * this file owns the measurement, the achieved latency and the false-alarm cost; this module is
 * the arithmetic and the state machine.
 *
 * ## What it watches, and why that and not P&L
 *
 * The one close on record was **one parameter change by the deployer**, atomic, between two
 * launches 24.7 hours apart (`analysis/window-population/README.md` §6.1). It was not erosion.
 * So the series to watch is not the outsiders' realised P&L — which needs round trips to close
 * before it says anything, and which the same measurement showed takes 2–3 days and 2–4 launches
 * to separate from ordinary variance — but the **operation's share of the bottom of the curve**:
 *
 *     share = (deployer's own buy + the operation's other create-slot stake)
 *             ÷ (that, plus every other wallet's create-slot stake)
 *
 * This is the June report's **T1** (`slot-zero-june-regime-change` §10.2, held in firstmate's
 * records, not in this repo). It is readable from the create slot itself — one Solana slot, seconds
 * after the mint — so it does not wait for anybody's position to close.
 *
 * ## The two caveats T1 carries, and what this module does about each
 *
 * `analysis/window-population/README.md` §9 records both, and neither is decorative:
 *
 * 1. **T1 is not fully exogenous.** Its denominator holds the outsiders' own stake, so "the
 *    outsiders happened not to turn up" pushes it up on its own, with the operation unchanged.
 *    Handled by {@link classifyCreateSlot}: a create slot with no outsider stake yields **no
 *    reading at all** — not a reading of 1.0. On the committed tape that is 25 of the open
 *    window's 129 launches, and reading them as 1.0 instead is what takes the single-launch false
 *    alarm count from 3 to 28.
 * 2. **The same reading has two different causes** — high before the window because outsiders were
 *    absent, high after the close because the operation crowded them out. Handled by
 *    {@link CONFIRM_LAUNCHES}: absence is a per-launch accident that does not repeat, a parameter
 *    change is a level that does. Requiring two consecutive readings is what separates them, and it
 *    is what takes the false alarm count from 3 in 104 to 0 in 104.
 *
 * ## The bar is inherited, not fitted
 *
 * {@link SHARE_BAR} is 0.55 because the June report published `T1 < 0.55 sustained` as the
 * condition that would *re-open* the question — written before anyone looked at where the closing
 * launch sat. Its complement is the close condition. See `thresholds.json` for the sensitivity, and
 * `README.md` for the honest note that the first launch of the closed regime clears it by 0.003.
 */

/**
 * The operation's share of the bottom of the curve at which the window is treated as closed.
 *
 * Inherited from `slot-zero-june-regime-change` §10.2 (T1), whose re-open condition is
 * `T1 < 0.55 sustained over 10 consecutive launches`. This is that same bar read the other way.
 * It is NOT calibrated on the close it detects; `README.md` → "Why 0.55, and what it costs" shows
 * what happens at 0.50, 0.60 and 0.65 and states where the reading is thin.
 */
export const SHARE_BAR = 0.55;

/**
 * Consecutive readings at or above {@link SHARE_BAR} before the tripwire stops.
 *
 * Two, and the second one is the whole design. One reading is fast and wrong three times in 104
 * open-window launches; two is one launch slower and wrong zero times, and a false stop is
 * measured at ~380× the cost of a launch of latency (`README.md` → "The asymmetry that decides the
 * design"). Launches that yield no reading neither advance nor reset the count — see
 * {@link Tripwire#observe}.
 */
export const CONFIRM_LAUNCHES = 2;

/**
 * Why a create slot produced no usable reading. Every one of these is *silence*, never a low or a
 * high reading, and the distinction is the point: an unread launch must not be able to disarm a
 * real alarm, and must not be able to raise a false one.
 *
 * @typedef {'no-create-slot' | 'no-deployer-buy' | 'no-outsider-stake' | 'no-cohort-evidence'} Unread
 */

/**
 * @typedef {object} Fill
 * One create-slot buy. The field names are the committed window tape's, which is also the shape
 * `tools/window-decay-tripwire/createslot.mjs` normalises the live endpoint into.
 * @property {number} slot
 * @property {string} sid   Fixed-width `slotIndexId`; the only key that orders fills inside a slot.
 * @property {string} tx    Transaction signature. Two wallets sharing one is the co-ordination rule.
 * @property {string} u     The swapping wallet.
 * @property {'buy' | 'sell'} k
 * @property {number} sol   Absolute SOL moved on this fill.
 */

/**
 * @typedef {object} CreateSlotReading
 * @property {string} mint
 * @property {string} at              ISO timestamp of the create slot.
 * @property {number | null} share    T1, or `null` when `unread` is set.
 * @property {Unread | null} unread   Why there is no reading. `null` on a good reading.
 * @property {number} slot            The create slot itself, or 0 when it could not be identified.
 * @property {number} deployerStake   SOL the deployer bought with in its own create slot.
 * @property {number} operationStake  SOL the rest of the operation bought with there.
 * @property {number} outsiderStake   SOL everybody else bought with there.
 * @property {number} outsiderWallets Distinct non-operation wallets in the create slot.
 * @property {string[]} operationWallets Non-deployer wallets counted as the operation, sorted.
 * @property {boolean} cohortDerived  True when the operation's wallets came from the co-ordination
 *   rule rather than from a supplied cohort.
 */

/**
 * The wallets a launch's create slot shows acting together, by the repo's co-ordination rule: any
 * create-slot transaction carrying **two or more distinct wallets** is one submission, so every
 * wallet in it is part of one operation.
 *
 * This was `tools/deployer-screen/measure.mjs` → `roomIsProven`'s predicate, and **since captain
 * decision 182a it is only HALF of it** — that rule now also marks the deployer-anchored contiguous
 * block-index run, and this lane deliberately still does not. Widening it here would move every
 * figure in this tool's backtest, including the published +24.1 h latency and the 0-false-stops-in-104
 * result, and the tripwire's own README is what those numbers are pinned in. That is a separate
 * decision, not a side effect of the screen's. Until it is taken, this lane inherits the
 * shared-transaction rule's limit exactly: how much of an operation it recovers is the operator's
 * submission habit on the day, not a property of the rule. On this deployer it recovers **nothing** before 2026-04 and
 * the whole cohort stake from 2026-04 on (`README.md` → "Deriving the cohort at runtime"). A create
 * slot with no bundled transaction therefore yields `no-cohort-evidence`, never an empty cohort —
 * captain decision 134a's shape, for the same reason: finding nothing is indistinguishable from
 * there being nothing, and reading it as the second inflates the outsiders' share.
 *
 * @param {readonly Fill[]} createSlotFills Buys in the create slot, deployer included.
 * @returns {Set<string>} Wallets that shared a transaction with another wallet. Empty means the
 *   rule found no evidence, which the caller must not read as "there is no cohort".
 */
export function bundledWallets(createSlotFills) {
  /** @type {Map<string, Set<string>>} */ const byTx = new Map();
  for (const f of createSlotFills) {
    let seen = byTx.get(f.tx);
    if (seen === undefined) { seen = new Set(); byTx.set(f.tx, seen); }
    seen.add(f.u);
  }
  /** @type {Set<string>} */ const out = new Set();
  for (const wallets of byTx.values()) {
    if (wallets.size < 2) continue;
    for (const w of wallets) out.add(w);
  }
  return out;
}

/**
 * The create slot of a launch: the slot of the deployer's own buy.
 *
 * Taken from the deployer rather than from the oldest fill on purpose. A walk that stopped short
 * returns a plausible pile of fills whose earliest slot is merely the earliest it saw, and reading
 * that as the create slot crowns a mid-window sniper as the deployer — the trap
 * `data/population-tape-2026-07-29/report.md` §9.2 records and `createslot.mjs` refuses. If the
 * deployer's buy is not in the fills at all, there is no create slot to read.
 *
 * @param {readonly Fill[]} fills Any fills of one launch, in any order.
 * @param {string} deployer
 * @returns {number | null}
 */
export function createSlotOf(fills, deployer) {
  let slot = null;
  for (const f of fills) {
    if (f.u !== deployer || f.k !== 'buy') continue;
    if (slot === null || f.slot < slot) slot = f.slot;
  }
  return slot;
}

/**
 * @typedef {object} ClassifyOptions
 * @property {string} deployer
 * @property {ReadonlySet<string> | undefined} [cohort] The operation's known other wallets. When
 *   absent the co-ordination rule derives them, and a slot with no bundled transaction goes unread.
 */

/**
 * Read one launch's create slot into a {@link CreateSlotReading}.
 *
 * Every path that cannot produce an honest number returns `unread` with a reason instead of a
 * number. There is deliberately no code path here that returns a share of exactly 1: that value
 * can only arise from an empty denominator, which is the first of the two T1 caveats.
 *
 * @param {string} mint
 * @param {string} at ISO timestamp of the launch.
 * @param {readonly Fill[]} fills Fills of this launch. Only create-slot buys are read.
 * @param {ClassifyOptions} options
 * @returns {CreateSlotReading}
 */
export function classifyCreateSlot(mint, at, fills, options) {
  const { deployer, cohort } = options;
  /** @param {Unread} unread @param {Partial<CreateSlotReading>} [extra] */
  const silent = (unread, extra = {}) => ({
    mint, at, share: null, unread, slot: 0,
    deployerStake: 0, operationStake: 0, outsiderStake: 0, outsiderWallets: 0,
    operationWallets: /** @type {string[]} */ ([]), cohortDerived: cohort === undefined,
    ...extra,
  });

  const slot = createSlotOf(fills, deployer);
  if (slot === null) return silent(fills.length === 0 ? 'no-create-slot' : 'no-deployer-buy');

  const inSlot = fills.filter((f) => f.slot === slot && f.k === 'buy');
  const operation = cohort ?? bundledWallets(inSlot);
  // The co-ordination rule found no submission carrying two wallets. That is silence about the
  // operation's helpers, not evidence they are absent, and crediting their stake to the outsiders
  // would push the share DOWN — i.e. towards "the window is still open", the direction this tool
  // must never fail in.
  if (cohort === undefined && operation.size === 0) return silent('no-cohort-evidence', { slot });

  let deployerStake = 0, operationStake = 0, outsiderStake = 0;
  /** @type {Set<string>} */ const outsiders = new Set();
  /** @type {Set<string>} */ const opWallets = new Set();
  for (const f of inSlot) {
    if (f.u === deployer) { deployerStake += f.sol; continue; }
    if (operation.has(f.u)) { operationStake += f.sol; opWallets.add(f.u); continue; }
    outsiderStake += f.sol;
    outsiders.add(f.u);
  }

  const base = { mint, at, slot, deployerStake, operationStake, outsiderStake,
    outsiderWallets: outsiders.size, operationWallets: [...opWallets].sort(),
    cohortDerived: cohort === undefined };
  // Caveat 1. Nobody outside the operation bid into this slot, so the ratio is 1 by construction
  // whatever the operation did, and it says nothing about crowding. Silence, not a maximum.
  if (outsiderStake <= 0) return { ...base, share: null, unread: 'no-outsider-stake' };

  const total = deployerStake + operationStake + outsiderStake;
  return { ...base, share: (deployerStake + operationStake) / total, unread: null };
}

/**
 * @typedef {'watching' | 'armed' | 'stop-and-rotate'} Verdict
 *
 * - `watching` — the window is open on the evidence so far.
 * - `armed` — ONE reading at or above the bar. Fast and uncertain: on the committed tape this
 *   state is entered three times inside an open window and once at the real close. It is surfaced
 *   because it is the earliest honest signal, and it is deliberately **not** a stop.
 * - `stop-and-rotate` — {@link CONFIRM_LAUNCHES} consecutive readings at or above the bar. Latched:
 *   a competent deployer does not loosen a launch bot it has just tightened (captain,
 *   2026-08-02), so this lane never un-stops and never re-polls a wallet it has stopped on.
 */

/**
 * @typedef {object} TripwireStep One observation and what it did to the state.
 * @property {CreateSlotReading} reading
 * @property {boolean} counted   False when the launch went unread and was skipped.
 * @property {boolean} breach    The reading was at or above the bar.
 * @property {number} streak     Consecutive breaches after this step.
 * @property {Verdict} verdict   The verdict after this step.
 * @property {boolean} [seeded]  True on a step rebuilt from a saved run rather than observed in
 *   this one. Its `reading` is whatever the state file kept, and its `streak`/`verdict` are the
 *   resumed values, not the historical ones — only `breach` and `reading` are load-bearing, and
 *   they are what lets a stop confirmed across two runs print both readings it rests on.
 */

/**
 * The state machine. One instance watches one wallet's series.
 *
 * Feed it launches in time order. It is deliberately incremental rather than a pass over a series:
 * the live tool sees one new launch at a time, and the backtest replaying the committed tape must
 * exercise the same code, not a second implementation of the same rule.
 */
export class Tripwire {
  /**
   * @param {object} [options]
   * @param {number} [options.bar] Default {@link SHARE_BAR}.
   * @param {number} [options.confirmLaunches] Default {@link CONFIRM_LAUNCHES}.
   */
  constructor(options = {}) {
    this.bar = options.bar ?? SHARE_BAR;
    this.confirmLaunches = options.confirmLaunches ?? CONFIRM_LAUNCHES;
    if (!(this.bar > 0 && this.bar <= 1)) throw new RangeError('bar must be in (0, 1]');
    if (!Number.isInteger(this.confirmLaunches) || this.confirmLaunches < 1) {
      throw new RangeError('confirmLaunches must be a positive integer');
    }
    /** @type {number} Consecutive readings at or above the bar. */
    this.streak = 0;
    /** @type {Verdict} */
    this.verdict = 'watching';
    /** @type {TripwireStep[]} */
    this.steps = [];
    /** @type {CreateSlotReading[]} The readings that raised the stop, in order. */
    this.evidence = [];
  }

  /**
   * Observe one launch.
   *
   * An **unread** launch is skipped: it neither advances the streak nor resets it. Resetting on it
   * would let a one-in-five accident — 25 of the open window's 129 launches had no outsider in the
   * create slot at all — disarm a real alarm, and advancing on it would be caveat 1 in code.
   *
   * @param {CreateSlotReading} reading
   * @returns {TripwireStep}
   */
  observe(reading) {
    const counted = reading.unread === null && reading.share !== null;
    const breach = counted && (reading.share ?? 0) >= this.bar;
    if (counted) this.streak = breach ? this.streak + 1 : 0;
    if (this.verdict !== 'stop-and-rotate') {
      if (this.streak >= this.confirmLaunches) {
        this.verdict = 'stop-and-rotate';
        // The readings behind this launch that are part of the same streak. Written out rather than
        // `slice(-(k - 1))` because at k = 1 that is `slice(-0)`, which is `slice(0)` — the whole
        // history — and the evidence would then claim every breach the watch ever saw.
        const priorBreaches = this.steps.filter((s) => s.breach).map((s) => s.reading);
        const prior = this.confirmLaunches > 1 ? priorBreaches.slice(1 - this.confirmLaunches) : [];
        this.evidence = [...prior, reading];
      } else this.verdict = this.streak > 0 ? 'armed' : 'watching';
    }
    const step = { reading, counted, breach, streak: this.streak, verdict: this.verdict };
    this.steps.push(step);
    return step;
  }

  /** Launches that produced a reading, and launches that did not, by reason. */
  coverage() {
    /** @type {Record<string, number>} */ const unread = {};
    let read = 0;
    for (const s of this.steps) {
      if (s.counted) { read += 1; continue; }
      const key = s.reading.unread ?? 'unknown';
      unread[key] = (unread[key] ?? 0) + 1;
    }
    return { observed: this.steps.length, read, unread };
  }
}
