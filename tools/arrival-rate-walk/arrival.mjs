/**
 * From a per-launch series to windows: how many arrived, how long they lasted, and which ends were
 * actually observed. No network, no credential.
 *
 * ## Why segmentation and not a threshold
 *
 * `analysis/window-population/README.md` §2.2 settles this and the reasoning is not re-opened here:
 * **two windows are distinct when the level of the per-launch prize changes and stays changed**, not
 * when a rolling average crosses a bar. The obvious alternative — count maximal runs above a
 * threshold — answers whatever you ask it: on the committed tape, same series and same code, it
 * finds 2 windows at a bar of 0.05, 3 at 0.10, 7 at 0.15 and 4 at 0.30. **A window count produced by
 * threshold-tuning is a statement about the analyst.** Binary segmentation has no equivalent knob: it
 * asks whether the level differs either side of a point, never whether it clears a bar.
 *
 * The implementation mirrors `analysis/window-population/measure.mjs` deliberately, because the whole
 * value of this lane is that its answer for a stranger is the *same measurement* as the published
 * n = 1. It is duplicated rather than imported: `analysis/` may not import `tools/` and vice versa,
 * asserted in both directions. The test suite reproduces the published break dates through **this**
 * code, so the two copies cannot drift silently.
 *
 * ## What "profitable" adds, and why it is not a tuned bar
 *
 * Segmentation finds level changes; it does not know which side is the good one. A segment is a
 * window here when it is a **local maximum among the segments** AND its median per-launch return per
 * SOL is **above zero** — which is §2.1's definition of a launch paying, not a threshold chosen to
 * fit an output. Segments that are local maxima but not profitable are reported separately, so a
 * reader can see the shape rather than only the count.
 *
 * ## Censoring is reported, never assumed away
 *
 * §5 of the published measurement makes a specific point that for n = 1 **both ends of the window
 * were observed** — 91 days of no window before and 54 days after — which is why 83 days is a
 * measurement rather than a bound. A multi-deployer series inherits neither property for free: a
 * window that is the first segment may have opened before the observation began, and one that is the
 * last may still be open. Both are flagged per window, and a duration on a censored end is a
 * **lower bound** and is named one.
 */

/**
 * Mid-ranks of `values`, ties averaged.
 *
 * @param {readonly number[]} values
 * @returns {number[]} 1-based mid-ranks, in the input's order.
 */
export function rankVector(values) {
  const order = values.map((v, i) => /** @type {[number, number]} */ ([v, i])).sort((a, b) => a[0] - b[0]);
  /** @type {number[]} */ const rank = new Array(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && (order[j + 1]?.[0] ?? NaN) === (order[i]?.[0] ?? NaN)) j++;
    const r = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) rank[order[t]?.[1] ?? 0] = r;
    i = j + 1;
  }
  return rank;
}

/**
 * Running sums of a rank vector, so every split of one series costs O(1) once this is built.
 *
 * @param {readonly number[]} rank
 * @returns {number[]} Length `rank.length + 1`.
 */
export function rankPrefix(rank) {
  /** @type {number[]} */ const prefix = new Array(rank.length + 1).fill(0);
  for (let i = 0; i < rank.length; i++) prefix[i + 1] = (prefix[i] ?? 0) + (rank[i] ?? 0);
  return prefix;
}

/**
 * Standardised Mann–Whitney rank-sum statistic for the split `[0…k) | [k…n)`.
 *
 * Rank-based on purpose: the per-launch prize is heavy-tailed — one launch in the committed window
 * paid +27 SOL — and a mean-shift test would chase single launches instead of level changes.
 *
 * @param {readonly number[]} prefix
 * @param {number} k
 * @param {number} minSegment
 * @returns {number} z. 0 when either side is shorter than `minSegment`.
 */
export function rankSumZFromPrefix(prefix, k, minSegment) {
  const n = prefix.length - 1;
  const n1 = k;
  const n2 = n - k;
  if (n1 < minSegment || n2 < minSegment) return 0;
  const r1 = prefix[k] ?? 0;
  const mu = (n1 * (n + 1)) / 2;
  const sd = Math.sqrt((n1 * n2 * (n + 1)) / 12);
  return (r1 - mu) / sd;
}

/**
 * @typedef {object} Break
 * @property {number} index First index of the segment **after** the break.
 * @property {number} z Absolute rank-sum z at that split.
 * @property {number} depth Recursion depth it was found at.
 */

/**
 * Binary segmentation: recursively split wherever the rank-sum statistic exceeds `minZ`.
 *
 * @param {readonly number[]} values
 * @param {number} [minZ]
 * @param {number} [minSegment]
 * @returns {Break[]} Ascending by index.
 */
export function changepoints(values, minZ = 4, minSegment = 8) {
  /** @type {Break[]} */ const out = [];
  /** @param {number} lo @param {number} hi @param {number} depth */
  const recurse = (lo, hi, depth) => {
    const slice = values.slice(lo, hi);
    if (slice.length < minSegment * 2 + 4) return;
    const prefix = rankPrefix(rankVector(slice));
    let best = { z: 0, k: -1 };
    for (let k = minSegment; k <= slice.length - minSegment; k++) {
      const z = Math.abs(rankSumZFromPrefix(prefix, k, minSegment));
      if (z > best.z) best = { z, k };
    }
    if (best.k < 0 || best.z < minZ) return;
    const at = lo + best.k;
    out.push({ index: at, z: best.z, depth });
    recurse(lo, at, depth + 1);
    recurse(at, hi, depth + 1);
  };
  recurse(0, values.length, 0);
  return out.sort((a, b) => a.index - b.index);
}

/**
 * @param {readonly number[]} values
 * @returns {number} `NaN` for an empty sample — never 0, which is a real level here.
 */
export function median(values) {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? /** @type {number} */ (s[mid])
    : (/** @type {number} */ (s[mid - 1]) + /** @type {number} */ (s[mid])) / 2;
}

/**
 * @typedef {object} SeriesPoint
 * @property {string} mint
 * @property {number} mintMs
 * @property {number} returnPerSol
 * @property {number} prizeSol
 */

/**
 * @typedef {object} Segment
 * @property {number} from       First index, inclusive.
 * @property {number} to         Last index, inclusive.
 * @property {number} launches
 * @property {number} fromMs
 * @property {number} toMs
 * @property {number} medianReturnPerSol
 * @property {number} medianPrizeSol
 */

/**
 * @typedef {object} Window
 * @property {Segment} segment
 * @property {boolean} profitable      Median return per SOL above zero. §2.1's definition of paying.
 * @property {boolean} openObserved    False when the window is the FIRST segment — it may have opened
 *   before the observation began, so its duration is a lower bound.
 * @property {boolean} closeObserved   False when it is the LAST segment — it may still be open.
 * @property {number} durationDays     **First to LAST launch inside the window**, which is the
 *   convention the published n = 1 uses (§5: 2026-03-12T18:09:24Z to 2026-06-03T11:25:20Z, 82.7
 *   days) and the conservative of the two available. The true close sits somewhere between that last
 *   launch and the first of the next regime; {@link Window.gapToNextRegimeDays} is that interval, so
 *   a reader can see the width of the uncertainty rather than have it absorbed into the duration.
 *   The same formula serves a censored close, where the last observed launch is the only end there is.
 * @property {number} gapToNextRegimeDays `NaN` when the close is censored.
 * @property {number} launchesMeasured **Measured** launches only, so it is smaller than the calendar
 *   count of launches in the same span — on the published window, 102 of 129.
 */

/**
 * @typedef {object} DeployerWindows
 * @property {string} deployer
 * @property {number} launchesMeasured
 * @property {number} observationDays  First to last MEASURED launch. Not the calendar span of the
 *   collection: a deployer that stopped launching in February is observed until February, and
 *   pretending otherwise inflates the denominator of every arrival rate computed from it.
 * @property {Segment[]} segments
 * @property {Window[]} windows        Profitable local maxima only.
 * @property {Segment[]} unprofitablePeaks Local maxima whose level is at or below zero. Reported so
 *   a reader sees the shape rather than only the count.
 * @property {string | null} tooShortReason Set when the series cannot be segmented at all.
 */

/**
 * Find a deployer's windows.
 *
 * @param {readonly SeriesPoint[]} series Ascending by `mintMs`. **Measured launches only** — an
 *   unmeasured launch is not a zero and must not enter a rank test as one.
 * @param {object} [opts]
 * @param {number} [opts.minZ]
 * @param {number} [opts.minSegment]
 * @param {string} [opts.deployer]
 * @returns {DeployerWindows}
 */
export function findWindows(series, opts = {}) {
  const minZ = opts.minZ ?? 4;
  const minSegment = opts.minSegment ?? 8;
  const deployer = opts.deployer ?? '';
  const points = [...series].sort((a, b) => a.mintMs - b.mintMs);
  const observationDays =
    points.length < 2
      ? 0
      : (/** @type {SeriesPoint} */ (points[points.length - 1]).mintMs - /** @type {SeriesPoint} */ (points[0]).mintMs) /
        86_400_000;

  if (points.length < minSegment * 2 + 4) {
    return {
      deployer,
      launchesMeasured: points.length,
      observationDays,
      segments: [],
      windows: [],
      unprofitablePeaks: [],
      tooShortReason:
        `${points.length} measured launch(es) is below the ${minSegment * 2 + 4} a split needs at a ` +
        `minimum segment of ${minSegment}. No window can be detected here, which is NOT the same ` +
        `finding as no window having arrived.`,
    };
  }

  const breaks = changepoints(
    points.map((p) => p.returnPerSol),
    minZ,
    minSegment,
  );
  const cuts = [0, ...breaks.map((b) => b.index), points.length];
  /** @type {Segment[]} */
  const segments = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = /** @type {number} */ (cuts[i]);
    const to = /** @type {number} */ (cuts[i + 1]) - 1;
    const slice = points.slice(from, to + 1);
    segments.push({
      from,
      to,
      launches: slice.length,
      fromMs: /** @type {SeriesPoint} */ (slice[0]).mintMs,
      toMs: /** @type {SeriesPoint} */ (slice[slice.length - 1]).mintMs,
      medianReturnPerSol: median(slice.map((p) => p.returnPerSol)),
      medianPrizeSol: median(slice.map((p) => p.prizeSol)),
    });
  }

  /** @type {Window[]} */
  const windows = [];
  /** @type {Segment[]} */
  const unprofitablePeaks = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = /** @type {Segment} */ (segments[i]);
    const prev = segments[i - 1];
    const next = segments[i + 1];
    const higherThanNeighbours =
      (prev === undefined || seg.medianReturnPerSol > prev.medianReturnPerSol) &&
      (next === undefined || seg.medianReturnPerSol > next.medianReturnPerSol);
    // A single segment is nothing's local maximum: one level over the whole observation is "no
    // level change was detected", not "the whole observation was a window".
    if (!higherThanNeighbours || segments.length < 2) continue;
    if (!(seg.medianReturnPerSol > 0)) {
      unprofitablePeaks.push(seg);
      continue;
    }
    windows.push({
      segment: seg,
      profitable: true,
      openObserved: prev !== undefined,
      closeObserved: next !== undefined,
      durationDays: (seg.toMs - seg.fromMs) / 86_400_000,
      gapToNextRegimeDays: next === undefined ? Number.NaN : (next.fromMs - seg.toMs) / 86_400_000,
      launchesMeasured: seg.launches,
    });
  }

  return { deployer, launchesMeasured: points.length, observationDays, segments, windows, unprofitablePeaks, tooShortReason: null };
}

/**
 * @typedef {object} ArrivalSummary
 * @property {number} deployers
 * @property {number} deployersSegmentable  How many had enough measured launches to detect anything.
 * @property {number} windows
 * @property {number} windowsWithBothEndsObserved The only ones whose duration is a measurement.
 * @property {number} observationDeployerDays Summed over segmentable deployers only.
 * @property {number} windowsPerDeployerYear `NaN` when nothing was observed.
 * @property {number[]} durationsDaysBothEndsObserved
 * @property {number[]} durationsDaysCensored **Lower bounds**, kept apart from the measurements.
 * @property {string[]} caveats
 */

/**
 * Aggregate windows across the cohort.
 *
 * Deployers whose series is too short to segment are counted and **excluded from the denominator**,
 * because a deployer that cannot show a window is not evidence that none arrived. That exclusion is
 * itself a bias — it drops the shortest-lived deployers, which are exactly the ones the historical
 * seed was chosen to include — so it is reported rather than absorbed.
 *
 * @param {readonly DeployerWindows[]} perDeployer
 * @returns {ArrivalSummary}
 */
export function summariseArrival(perDeployer) {
  const segmentable = perDeployer.filter((d) => d.tooShortReason === null);
  const allWindows = segmentable.flatMap((d) => d.windows);
  const both = allWindows.filter((w) => w.openObserved && w.closeObserved);
  const observationDeployerDays = segmentable.reduce((a, d) => a + d.observationDays, 0);
  const tooShort = perDeployer.length - segmentable.length;
  return {
    deployers: perDeployer.length,
    deployersSegmentable: segmentable.length,
    windows: allWindows.length,
    windowsWithBothEndsObserved: both.length,
    observationDeployerDays,
    windowsPerDeployerYear: observationDeployerDays > 0 ? (allWindows.length * 365.25) / observationDeployerDays : Number.NaN,
    durationsDaysBothEndsObserved: both.map((w) => w.durationDays).sort((a, b) => a - b),
    durationsDaysCensored: allWindows
      .filter((w) => !w.openObserved || !w.closeObserved)
      .map((w) => w.durationDays)
      .sort((a, b) => a - b),
    caveats: [
      `${tooShort} of ${perDeployer.length} deployer(s) had too few MEASURED launches to segment at ` +
        `all and are excluded from the denominator. That is not evidence no window arrived for them, ` +
        `and it drops the shortest-lived deployers — which the historical seed exists to include.`,
      'A duration on a censored end is a LOWER BOUND, and the two are reported apart rather than pooled.',
      'Measured launches only. An unmeasured launch is not a zero and never enters the rank test as one.',
    ],
  };
}
