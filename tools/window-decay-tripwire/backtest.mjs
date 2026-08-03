/**
 * Replaying the one close on record through the **production** detector, and pricing both kinds of
 * error it can make. **Offline: no socket, no credential, no clock.**
 *
 * Run it with `node tools/window-decay-tripwire/backtest.mjs`. Every number in `README.md` comes
 * from that one command, and the headline ones are asserted in
 * `test/window-decay-tripwire.test.ts`.
 *
 * It replays through `detector.mjs` rather than through a second implementation of the same rule,
 * for the reason `tools/deployer-screen/stage0.mjs` gives for running the production
 * `priceLaunchEntry` over the committed tape: a regression guard over a neighbouring population, or
 * over a re-derivation of the same arithmetic, is the defect shape it exists to catch.
 *
 * **What it can and cannot establish.** n = 1. This tape holds exactly one profitable window, so
 * every latency and every false-alarm count below is one observation of one close on one deployer,
 * measured well. Nothing here says another window would close the same way, and
 * `analysis/window-population/README.md` §8 states what data would settle that and what it costs.
 */

import { CONFIRM_LAUNCHES, Tripwire, classifyCreateSlot } from './detector.mjs';
import {
  SUBJECT_COHORT, SUBJECT_DEPLOYER, WINDOW_OPEN,
  readOutsiderPrize, readTapedLaunches, regimeOf,
} from './tape.mjs';

// ---------------------------------------------------------------------------------------------
// distribution helpers

/** @param {readonly number[]} xs */
export const asc = (xs) => [...xs].sort((a, b) => a - b);
/** @param {readonly number[]} sorted @param {number} p */
export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  const a = sorted[lo], b = sorted[hi];
  if (a === undefined || b === undefined) return NaN;
  return lo === hi ? a : a + (b - a) * (idx - lo);
}
/** @param {readonly number[]} xs */
export const median = (xs) => percentile(asc(xs), 0.5);
/** @param {readonly number[]} xs */
export const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------------------------
// the replay

/**
 * @typedef {object} ReplayStep
 * @property {string} mint
 * @property {string} symbol
 * @property {string} date
 * @property {'before' | 'open' | 'after'} regime
 * @property {import('./detector.mjs').CreateSlotReading} reading
 * @property {import('./detector.mjs').TripwireStep} step
 * @property {boolean} fired The stop was raised **at** this launch. See {@link firedAt}.
 */

/**
 * Feed the taped launches, in time order, to one {@link Tripwire}.
 *
 * **The replay starts at the window's open, not at the tape's.** This tool watches a window an
 * operator is *currently trading*; nobody points it at a wallet before they have a position in it.
 * Starting it earlier would feed it the "before" regime, whose share reads as high as the closed
 * one for the opposite reason (`analysis/window-population/README.md` §9, second caveat), and would
 * measure a question nobody is asking. Because the confirmation rule only ever shortens a streak, a
 * later start cannot produce an alarm an earlier one would not — so opening day is the
 * maximum-exposure start and the false-alarm count below is the worst case over every start date.
 *
 * @param {object} [options]
 * @param {number} [options.bar]
 * @param {number} [options.confirmLaunches]
 * @param {boolean} [options.deriveCohort] Use the co-ordination rule instead of the known cohort.
 * @param {boolean} [options.countUnreadAsMax] The naive reading this tool refuses: treat a create
 *   slot with no outsider as a share of 1.0. Reported to show what it costs.
 * @param {string} [options.from] ISO date the watch starts on. Default {@link WINDOW_OPEN}.
 * @param {readonly import('./tape.mjs').TapedLaunch[]} [launches]
 * @returns {{ steps: ReplayStep[], tripwire: Tripwire }}
 */
export function replay(options = {}, launches = readTapedLaunches()) {
  const { bar, confirmLaunches, deriveCohort = false, countUnreadAsMax = false, from = WINDOW_OPEN } = options;
  const cohort = deriveCohort ? undefined : new Set(SUBJECT_COHORT);
  const tripwire = new Tripwire({ bar, confirmLaunches });
  /** @type {ReplayStep[]} */ const steps = [];
  for (const l of launches) {
    if (l.date < from) continue;
    let reading = classifyCreateSlot(l.mint, l.date, l.fills, { deployer: SUBJECT_DEPLOYER, cohort });
    if (countUnreadAsMax && reading.unread === 'no-outsider-stake') {
      reading = { ...reading, share: 1, unread: null };
    }
    const step = tripwire.observe(reading);
    steps.push({ mint: l.mint, symbol: l.symbol, date: l.date, regime: regimeOf(l.date),
      reading, step, fired: firedAt(step, tripwire.confirmLaunches) });
  }
  return { steps, tripwire };
}

/**
 * Did the tripwire fire *at* this launch?
 *
 * The verdict latches — that is the product behaviour, since a competent deployer does not reopen a
 * window it has just closed — so reading `verdict === 'stop-and-rotate'` counts every launch after
 * the first as another stop. The streak reaching the confirmation count is the **event**, and it is
 * what every count below is built on.
 *
 * @param {import('./detector.mjs').TripwireStep} step
 * @param {number} [confirmLaunches]
 */
export const firedAt = (step, confirmLaunches = CONFIRM_LAUNCHES) => step.streak === confirmLaunches;

/**
 * @typedef {object} Latency
 * @property {ReplayStep} lastOpen      Last launch of the open window.
 * @property {ReplayStep} firstClosed   First launch of the closed regime — the moment the regime changed.
 * @property {number} closeSpeedHours   Between those two. The number every latency is quoted against.
 * @property {ReplayStep | null} alarm  Where the tripwire stopped.
 * @property {number | null} alarmHours From the regime change to the alarm.
 * @property {ReplayStep | null} firstAvoided First launch the operator would not have entered.
 * @property {number | null} avoidedHours From the regime change to that launch.
 * @property {ReplayStep[]} entered     Launches entered under the new regime before the stop.
 */

/**
 * When the tripwire fired, measured against the speed of the thing it is detecting.
 *
 * Two latencies, and the difference between them is not pedantry. The **alarm** is raised from a
 * launch's own create slot, and an entrant is already in that launch by the time its create slot
 * can be read — a sniper submits before it can see the slot it is submitting into. So the first
 * launch the operator actually avoids is the NEXT one, and that is the number a position-sizing
 * decision turns on.
 *
 * @param {readonly ReplayStep[]} steps
 * @returns {Latency}
 */
export function latency(steps) {
  const open = steps.filter((s) => s.regime === 'open');
  const closed = steps.filter((s) => s.regime === 'after');
  const lastOpen = /** @type {ReplayStep} */ (open[open.length - 1]);
  const firstClosed = /** @type {ReplayStep} */ (closed[0]);
  const t = (/** @type {ReplayStep} */ s) => Date.parse(s.date);
  const alarm = closed.find((s) => s.fired) ?? null;
  const firstAvoided = alarm === null ? null : steps.find((s) => t(s) > t(alarm)) ?? null;
  return {
    lastOpen, firstClosed,
    closeSpeedHours: (t(firstClosed) - t(lastOpen)) / HOUR_MS,
    alarm,
    alarmHours: alarm === null ? null : (t(alarm) - t(firstClosed)) / HOUR_MS,
    firstAvoided,
    avoidedHours: firstAvoided === null ? null : (t(firstAvoided) - t(firstClosed)) / HOUR_MS,
    entered: alarm === null ? closed : closed.filter((s) => t(s) <= t(alarm)),
  };
}

/**
 * Launches inside the open window at which the tripwire would have stopped. These are the false
 * alarms: the window demonstrably had weeks left to run at every one of them.
 *
 * @param {readonly ReplayStep[]} steps
 */
export function falseAlarms(steps) {
  const open = steps.filter((s) => s.regime === 'open');
  return {
    fired: open.filter((s) => s.fired),
    armed: open.filter((s) => s.step.breach),
    read: open.filter((s) => s.step.counted).length,
    launches: open.length,
  };
}

/**
 * The one-sided upper bound on a rate when nothing was observed.
 *
 * Zero false alarms in `n` launches is not a rate of zero, and quoting it as one would be the
 * single most misleading number this lane could publish. This is the rule of three's exact form:
 * the largest per-launch probability under which observing none in `n` still has probability
 * `alpha`.
 *
 * @param {number} n
 * @param {number} [alpha]
 */
export const zeroEventUpperBound = (n, alpha = 0.05) => (n <= 0 ? 1 : 1 - Math.pow(alpha, 1 / n));

/**
 * What the instrument could cost over a window, at the top of the range its own sample allows.
 *
 * This is the number that decides whether the tripwire is worth running, and it is NOT the measured
 * false-alarm count. Zero events in 104 launches is consistent with a per-launch rate anywhere from
 * 0 to {@link zeroEventUpperBound}, and at the top of that range a window of this length is more
 * likely than not to be stopped early — at the mean cost of a false stop, which is most of what the
 * window is worth. The sample cannot distinguish the two, and saying so is the lane's result.
 *
 * @param {readonly ReplayStep[]} steps
 */
export function exposure(steps) {
  const cost = errorCost(steps);
  const open = steps.filter((s) => s.regime === 'open');
  const read = open.filter((s) => s.step.counted).length;
  const prize = readOutsiderPrize();
  const upperRate = zeroEventUpperBound(read);
  const meanFalseStopSol = sum(open.map((_, i) => cost.forfeitAt(i).grossSol)) / open.length;
  return {
    read,
    upperRate,
    stopProbabilityAtUpperBound: 1 - Math.pow(1 - upperRate, read),
    meanFalseStopSol,
    expectedCostAtUpperBoundSol: (1 - Math.pow(1 - upperRate, read)) * meanFalseStopSol,
    windowPrizeSol: sum(open.map((s) => prize.get(s.mint)?.gross ?? 0)),
    measuredCostSol: Math.abs(cost.latencyCostNetOfMeasuredFeesSol),
  };
}

// ---------------------------------------------------------------------------------------------
// what each kind of error costs

/**
 * The asymmetry the design turns on, priced from the tape.
 *
 * - **A false stop** is one-way — a competent deployer does not reopen a window it has just closed
 *   (captain, 2026-08-02), so this lane never un-stops. Its cost is therefore the whole remainder
 *   of a window that was still running.
 * - **A launch of latency** costs whatever the launches entered under the new regime lost.
 *
 * Both are quoted as the WHOLE outsider population's gross prize, because that is what the tape
 * measures; a single seat takes a fraction of each. The ratio between them is what the design turns
 * on, and it is scale-free.
 *
 * @param {readonly ReplayStep[]} steps
 */
export function errorCost(steps) {
  const prize = readOutsiderPrize();
  /** @param {ReplayStep} s */
  const grossOf = (s) => prize.get(s.mint)?.gross ?? 0;
  const open = steps.filter((s) => s.regime === 'open');

  /** What stopping at open-window index `i` forfeits: every later open-window launch. */
  const forfeitAt = (/** @type {number} */ i) => ({
    launches: open.length - 1 - i,
    days: (Date.parse(/** @type {ReplayStep} */ (open[open.length - 1]).date) - Date.parse(/** @type {ReplayStep} */ (open[i]).date)) / 86_400_000,
    grossSol: sum(open.slice(i + 1).map(grossOf)),
  });

  const l = latency(steps);
  return {
    forfeitAt,
    /** Median over every open-window launch: the cost of one false stop, placed at random. */
    medianFalseStopSol: median(open.map((_, i) => forfeitAt(i).grossSol)),
    /** The three launches a single-launch alarm would have stopped on, priced. */
    nearMisses: open.filter((s) => s.step.breach).map((s) => ({
      date: s.date, symbol: s.symbol, share: s.reading.share,
      ...forfeitAt(open.indexOf(s)),
    })),
    /** What the launches entered under the new regime cost, gross. */
    latencyCostSol: sum(l.entered.map(grossOf)),
    /**
     * The same, fee-inclusive. Both are reported because they are not the same number and the
     * difference runs one way: gross OVERSTATES what a participant kept, so the fee-inclusive
     * figure is the larger loss. Every P&L name in this repo ends `GrossOfFees` or
     * `NetOfMeasuredFees`, never neither.
     */
    latencyCostNetOfMeasuredFeesSol: sum(l.entered.map((s) => prize.get(s.mint)?.netOfMeasuredFees ?? 0)),
    latencyPricedTrips: sum(l.entered.map((s) => prize.get(s.mint)?.pricedTrips ?? 0)),
    latencyTrips: sum(l.entered.map((s) => prize.get(s.mint)?.trips ?? 0)),
    entered: l.entered.map((s) => ({ date: s.date, symbol: s.symbol, grossSol: grossOf(s) })),
  };
}

// ---------------------------------------------------------------------------------------------
// the alternatives this design was chosen over

/**
 * @typedef {object} Alternative
 * @property {string} name
 * @property {number} falseAlarms   Open-window launches at which it would have stopped.
 * @property {number} population    Open-window launches it read.
 * @property {string | null} firesAt
 * @property {number | null} hoursAfterBreak
 */

/**
 * Score a per-launch boolean over the series, the same way for every candidate: how often it fires
 * inside a window that demonstrably had weeks left, and how long after the regime changed it first
 * fires. `read` marks the launches a detector produced a reading on, so a detector that reads fewer
 * launches is not flattered by the ones it skipped.
 *
 * @param {string} name
 * @param {readonly ReplayStep[]} steps
 * @param {ReadonlyArray<{ read: boolean, fire: boolean }>} flags Parallel to `steps`.
 * @param {ReplayStep} firstClosed
 * @returns {Alternative}
 */
export function score(name, steps, flags, firstClosed) {
  let falseCount = 0, population = 0, previous = false;
  /** @type {ReplayStep | null} */ let firesAt = null;
  for (let i = 0; i < steps.length; i++) {
    const s = /** @type {ReplayStep} */ (steps[i]), f = /** @type {{read: boolean, fire: boolean}} */ (flags[i]);
    // Rising edges only. A stop is one-way, so a detector that stays fired for the rest of the
    // series has raised ONE alarm, not one per launch — counting the latch would flatter the slow
    // detectors and bury the fast ones. The edge tracker deliberately runs UNBROKEN across the
    // regime boundary: only the false-alarm count reads edges, and the latency below reads the
    // signal as a level, which is what keeps the two properties separable without a reset.
    const edge = f.fire && !previous;
    previous = f.fire;
    if (s.regime === 'open') { if (f.read) population += 1; if (edge) falseCount += 1; }
    // The latency is read as a LEVEL, not an edge: a rule that was already firing on the window's
    // last launch has raised a false alarm AND is still entitled to whatever latency it achieves on
    // the close. Reading it as an edge would time it from whenever its stuck signal next blinked,
    // which is a fact about the blink and not about the detector.
    if (s.regime === 'after' && f.fire && firesAt === null) firesAt = s;
  }
  return {
    name, falseAlarms: falseCount, population,
    firesAt: firesAt === null ? null : `${firesAt.date.slice(0, 16)} ${firesAt.symbol}`,
    hoursAfterBreak: firesAt === null ? null : (Date.parse(firesAt.date) - Date.parse(firstClosed.date)) / HOUR_MS,
  };
}

/**
 * Every candidate detector considered for this lane, scored on the same series.
 *
 * The four rejected ones are here because "we chose T1" is not evidence — what each of the others
 * costs is. Each is the strongest form of its idea that the tape supports, not a straw version.
 *
 * @param {readonly ReplayStep[]} steps
 * @returns {Alternative[]}
 */
export function alternatives(steps) {
  const firstClosed = /** @type {ReplayStep} */ (steps.filter((s) => s.regime === 'after')[0]);
  /** @type {Alternative[]} */ const out = [];
  const openRead = steps.filter((s) => s.regime === 'open' && s.step.counted);

  // 1. The chosen detector, and the single-launch version of it.
  for (const k of [1, 2, 3]) {
    const r = replay({ confirmLaunches: k });
    out.push(score(`T1 share >= 0.55, ${k} consecutive`, r.steps,
      r.steps.map((s) => ({ read: s.step.counted, fire: s.step.streak >= k })), firstClosed));
  }

  // 2. The naive T1 — no exclusion of create slots nobody bid into. T1's first recorded caveat,
  //    left in, to show what the exclusion is worth.
  {
    const r = replay({ countUnreadAsMax: true });
    out.push(score('T1 naive (no-outsider read as 1.0), 2 consecutive', r.steps,
      r.steps.map((s) => ({ read: s.step.counted, fire: s.step.streak >= CONFIRM_LAUNCHES })), firstClosed));
  }

  // 3. The P&L variance test — the approach `analysis/window-population/README.md` §6.2
  //    characterised, rebuilt here so the comparison is like for like. Trailing-k median of the
  //    outsiders' gross return per SOL, against the level the OPEN window itself crossed one launch
  //    in twenty.
  {
    const prize = readOutsiderPrize();
    const rows = steps.map((s) => ({ s, p: prize.get(s.mint) })).filter((x) => (x.p?.trips ?? 0) > 0);
    const roi = rows.map((x) => /** @type {number} */ (x.p?.gross) / /** @type {number} */ (x.p?.stake));
    const openIdx = rows.map((x, i) => ({ x, i })).filter((y) => y.x.s.regime === 'open').map((y) => y.i);
    for (const k of [3, 5, 7]) {
      const trail = (/** @type {number} */ i) => median(roi.slice(Math.max(0, i - k + 1), i + 1));
      const start = (openIdx[0] ?? 0) + k;
      const alarm = percentile(asc(openIdx.filter((i) => i >= start).map(trail)), 0.05);
      const flags = rows.map((_, i) => ({ read: true, fire: trail(i) < alarm }));
      out.push(score(`P&L: trailing-${k} median return per SOL < ${alarm.toFixed(3)}`,
        rows.map((x) => x.s), flags, firstClosed));
    }
  }

  // 4. The deployer's own stake alone — the fully exogenous half of T1. The one thing that
  //    literally changed on the day, and on its own it is unusable: the operation raised its own
  //    stake repeatedly while the window stayed open.
  {
    const dev = steps.map((s) => s.reading.deployerStake);
    for (const mult of [1.2, 1.4]) {
      const flags = steps.map((_, i) => {
        const prev = dev.slice(Math.max(0, i - 8), i).filter((v) => v > 0);
        return { read: prev.length >= 8, fire: prev.length >= 8 && (dev[i] ?? 0) > mult * median(prev) };
      });
      out.push(score(`deployer's own buy > ${mult}x its trailing-8 median`, steps, flags, firstClosed));
    }
  }

  // 5. Outsider room alone — the consequence rather than the cause.
  {
    const bar = percentile(asc(openRead.map((s) => s.reading.outsiderStake)), 0.05);
    let streak = 0;
    const flags = steps.map((s) => {
      const read = s.step.counted || s.reading.unread === 'no-outsider-stake';
      if (read) streak = s.reading.outsiderStake <= bar ? streak + 1 : 0;
      return { read, fire: streak >= 2 };
    });
    out.push(score(`outsider create-slot room <= ${bar.toFixed(2)} SOL, 2 consecutive`, steps, flags, firstClosed));
  }

  // 6. CUSUM on the same share — the classical fast step detector, calibrated on the open window's
  //    own 95th percentile. Included because it is the obvious answer and it loses.
  {
    const kRef = percentile(asc(openRead.map((s) => /** @type {number} */ (s.reading.share))), 0.95);
    for (const h of [0.2, 0.5]) {
      let S = 0;
      const flags = steps.map((s) => {
        if (!s.step.counted) return { read: false, fire: false };
        S = Math.max(0, S + (/** @type {number} */ (s.reading.share) - kRef));
        return { read: true, fire: S > h };
      });
      out.push(score(`CUSUM on the share, k=${kRef.toFixed(3)} h=${h}`, steps, flags, firstClosed));
    }
  }

  return out;
}

/**
 * The bar and confirmation grid, so a reader can see how much of the result rests on the exact
 * values pinned in `thresholds.json`.
 *
 * @param {ReplayStep} firstClosed
 * @returns {Alternative[]}
 */
export function sensitivity(firstClosed) {
  /** @type {Alternative[]} */ const out = [];
  for (const bar of [0.50, 0.55, 0.60, 0.65]) {
    for (const k of [1, 2, 3]) {
      const r = replay({ bar, confirmLaunches: k });
      out.push(score(`bar ${bar.toFixed(2)} x${k}`, r.steps,
        r.steps.map((s) => ({ read: s.step.counted, fire: s.step.streak >= k })), firstClosed));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// report

/** @param {number} x @param {number} d */
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
/** @param {Alternative} a */
const altLine = (a) => `  ${a.name.padEnd(52)} false alarms ${String(a.falseAlarms).padStart(2)}/${String(a.population).padStart(3)}` +
  `   ${a.firesAt === null ? 'never fires' : `fires ${a.firesAt.padEnd(22)} +${f(a.hoursAfterBreak ?? NaN, 1)} h`}`;

export function main() {
  const { steps, tripwire } = replay();
  const l = latency(steps);
  const fa = falseAlarms(steps);
  const cost = errorCost(steps);
  const cov = tripwire.coverage();

  console.log(`population tape: ${steps.length} launches, ${steps[0]?.date.slice(0, 10)} → ${steps[steps.length - 1]?.date.slice(0, 10)}, one deployer`);
  console.log(`readings: ${cov.read} of ${cov.observed} launches produced one; unread ` +
    Object.entries(cov.unread).map(([k, v]) => `${k}=${v}`).join(' ') + '\n');

  console.log('THE SERIES THE DETECTOR WATCHES — the operation\'s share of the bottom of the curve');
  for (const regime of /** @type {const} */ (['open', 'after'])) {
    const v = asc(steps.filter((s) => s.regime === regime && s.step.counted).map((s) => /** @type {number} */ (s.reading.share)));
    console.log(`  ${regime.padEnd(5)} n=${String(v.length).padStart(3)}   ` +
      [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => `p${(q * 100).toFixed(0)} ${f(percentile(v, q), 3)}`).join('  '));
  }

  console.log('\nTHE HEADLINE — detection latency against the speed of the close');
  console.log(`  the window closed between ${l.lastOpen.date.slice(0, 16)} ${l.lastOpen.symbol} and ` +
    `${l.firstClosed.date.slice(0, 16)} ${l.firstClosed.symbol}: ${f(l.closeSpeedHours, 1)} HOURS, one launch`);
  console.log(`  STOP AND ROTATE raised at ${l.alarm?.date.slice(0, 16)} ${l.alarm?.symbol}` +
    `  =  +${f(l.alarmHours ?? NaN, 1)} h after the regime changed`);
  console.log(`  first launch not entered:  ${l.firstAvoided?.date.slice(0, 16)} ${l.firstAvoided?.symbol}` +
    `  =  +${f(l.avoidedHours ?? NaN, 1)} h`);
  console.log(`  launches entered under the new regime: ${l.entered.length} — ` +
    cost.entered.map((e) => `${e.symbol} ${f(e.grossSol, 2)} SOL`).join(', '));
  console.log(`  evidence the stop rests on: ` +
    tripwire.evidence.map((e) => `${e.at.slice(0, 10)} share ${f(e.share ?? NaN, 3)}`).join(' then '));

  console.log('\nFALSE ALARMS — open-window launches at which this would have stopped a running window');
  console.log(`  stops: ${fa.fired.length} of ${fa.read} launches read (${fa.launches} in the window)`);
  console.log(`  single readings at or above the bar (the "armed" state, not a stop): ${fa.armed.length} — ` +
    fa.armed.map((s) => `${s.date.slice(0, 10)} ${s.symbol} ${f(s.reading.share ?? NaN, 3)}`).join(', '));
  console.log(`  0 in ${fa.read} is NOT a rate of zero: 95% one-sided upper bound on the per-launch` +
    ` false-stop probability is ${f(100 * zeroEventUpperBound(fa.read), 2)}%,`);
  const ex = exposure(steps);
  console.log(`  AT THE TOP OF THAT RANGE THIS INSTRUMENT COSTS MORE THAN IT SAVES, and the sample cannot rule it out:`);
  console.log(`    P(at least one false stop in a ${ex.read}-launch window) = ${f(100 * ex.stopProbabilityAtUpperBound, 0)}%,` +
    ` mean cost of one ${f(ex.meanFalseStopSol, 1)} SOL`);
  console.log(`    expected cost at the upper bound ${f(ex.expectedCostAtUpperBoundSol, 0)} SOL, against a window worth` +
    ` ${f(ex.windowPrizeSol, 1)} SOL and a measured cost of ${f(ex.measuredCostSol, 2)} SOL`);

  console.log('\nTHE ASYMMETRY THAT DECIDES THE DESIGN — both errors priced, gross, whole outsider population');
  console.log(`  a false stop at a uniformly random open-window launch forfeits a median of ` +
    `${f(cost.medianFalseStopSol, 1)} SOL of remaining window prize`);
  for (const n of cost.nearMisses) {
    console.log(`    a single-launch alarm would have stopped at ${n.date.slice(0, 10)} ${String(n.symbol).padEnd(10)}` +
      ` share ${f(n.share ?? NaN, 3)} — forfeiting ${n.launches} launches / ${f(n.days, 1)} days / ${f(n.grossSol, 1)} SOL`);
  }
  console.log(`  the ${l.entered.length} launches this detector eats at the real close cost ${f(cost.latencyCostSol, 2)} SOL gross,` +
    ` ${f(cost.latencyCostNetOfMeasuredFeesSol, 2)} SOL fee-inclusive (${cost.latencyPricedTrips} of ${cost.latencyTrips} round trips priced)`);
  console.log(`  ratio: a false stop costs about ${f(Math.abs(cost.medianFalseStopSol / cost.latencyCostSol), 0)}x a launch of latency`);

  console.log('\nWHY THIS DETECTOR AND NOT THE ALTERNATIVES');
  for (const a of alternatives(steps)) console.log(altLine(a));

  console.log('\nSENSITIVITY — how much rests on the pinned bar and confirmation count');
  for (const a of sensitivity(l.firstClosed)) console.log(altLine(a));

  console.log('\nDERIVING THE COHORT AT RUNTIME instead of being told it');
  const derived = replay({ deriveCohort: true });
  const dl = latency(derived.steps), dfa = falseAlarms(derived.steps);
  console.log(`  co-ordination rule: ${derived.tripwire.coverage().read} launches read, ` +
    `${dfa.fired.length} false stops, alarm at ${dl.alarm?.date.slice(0, 16)} ${dl.alarm?.symbol} (+${f(dl.alarmHours ?? NaN, 1)} h)`);
  /** @type {Record<string, {read: number, launches: number}>} */ const byMonth = {};
  for (const s of derived.steps) {
    const m = s.date.slice(0, 7);
    const e = byMonth[m] ?? { read: 0, launches: 0 };
    e.launches += 1;
    if (s.step.counted) e.read += 1;
    byMonth[m] = e;
  }
  console.log('  launches it can read a cohort from, by month: ' +
    Object.entries(byMonth).map(([m, v]) => `${m} ${v.read}/${v.launches}`).join('  '));
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main();
