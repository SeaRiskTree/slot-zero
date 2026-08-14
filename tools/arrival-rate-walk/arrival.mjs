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
 *
 * ## The bar is doing more work than it can carry — captain decision 496a
 *
 * Of the five distinct level changes this project's cohort has ever produced, **four sit within
 * ±0.5 of the pinned bar** and only one clears it comfortably; two readings 0.2 apart — 3.91 and
 * 4.13 — received opposite verdicts, one *window* and one *no window*
 * (`slot-zero-flat-positive-earlier-start` → `report.md` §12 item 4, held in firstmate's records,
 * not in this repo). A pass/fail at 4 therefore reports a coin-flip as a finding, and reports it
 * silently, because nothing beside the verdict said how close the reading was.
 *
 * 496a is a **REPORTING** change and nothing else:
 *
 * - **The bar does not move.** {@link findWindows} still splits at `minZ`, still defaults to 4, and
 *   `bounds.json` → `series.minZ` is still 4, for comparability with the published n = 1. The
 *   segments, the windows and every measured quantity are byte-identical to what they were.
 * - **Every window carries its own strength.** {@link Window.detection} rides on each one and
 *   {@link formatWindow} is the ONE formatter, so a window cannot be printed without it.
 * - **`3.5 ≤ |z| < 4.5` is a third verdict, `unresolved`** ({@link UNRESOLVED_BAND},
 *   {@link detectionVerdict}), and it straddles the bar deliberately, so it arrives from both
 *   sides. Above the bar a window still FORMS and is reported `unresolved` rather than `window`.
 *   Below it the recursion stops exactly where it always did — the split is **not** taken — and the
 *   near-miss is reported as {@link DeployerWindows.unresolvedBreaks} instead of vanishing.
 * - **Unresolved is never pooled into either neighbour.** {@link summariseArrival} splits the
 *   windows three ways on the verdict — resolved, unresolved, below the band — so the classification
 *   is TOTAL rather than resting on the bar happening to sit inside the band; it counts the three
 *   apart and publishes the arrival rate as a RANGE, and the old ambiguous `windows` /
 *   `windowsPerDeployerYear` keys are **gone** rather than quietly redefined, so a consumer that
 *   collapses the classes fails loudly instead of reading a pooled figure as resolved.
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
 * The band in which a detection is **UNRESOLVED**: neither a window nor no window.
 *
 * It straddles the pinned bar rather than sitting under it, because the evidence 496a rests on runs
 * both ways — 3.91 was called *no window* and 4.13 *window*, and neither reading can carry that
 * verdict. `lo` is inclusive and `hi` exclusive, so exactly one verdict applies to any `|z|`.
 *
 * **This is not a second threshold.** Nothing splits, merges, gates or is excluded on it; it decides
 * only which of three words a detection is reported under. The bar that decides what the
 * segmentation DOES is `minZ`, and 496a leaves it at 4.
 */
export const UNRESOLVED_BAND = Object.freeze({ lo: 3.5, hi: 4.5 });

/**
 * The sentence that travels with every unresolved reading, on every surface — the summary's
 * caveats, the run record, and {@link formatWindow}'s line. A caveat that lives only in a document
 * is one a reader of the number never sees.
 */
export const MARGINAL_DETECTION_CAVEAT =
  `A detection with |z| in [${UNRESOLVED_BAND.lo}, ${UNRESOLVED_BAND.hi}) is reported UNRESOLVED — ` +
  'neither a window nor no window. Four of the five level changes this project has ever produced ' +
  'sit within 0.5 of the bar, and two readings 0.2 apart got opposite verdicts, so a pass/fail at ' +
  'the bar there is a coin flip reported as a finding. The bar itself is UNMOVED (captain decision ' +
  '496a): an unresolved reading above it still segments exactly as before, one below it still does ' +
  'not split. Never pool an unresolved count into either neighbour.';

/**
 * @typedef {'window' | 'unresolved' | 'no-window'} DetectionVerdict
 *   `window` — the level change is resolved and clears the bar. `unresolved` — inside
 *   {@link UNRESOLVED_BAND}, whichever side of the bar it falls; a real third answer, never a
 *   formatting label. `no-window` — resolved the other way, below the band.
 */

/**
 * Which of the three a strength earns. Reporting only; see {@link UNRESOLVED_BAND}.
 *
 * @param {number} z Absolute rank-sum statistic. `NaN` is UNRESOLVED, never `no-window` — an
 *   unreadable strength is no answer, and reading it as one manufactures a refusal.
 * @returns {DetectionVerdict}
 */
export function detectionVerdict(z) {
  if (!Number.isFinite(z)) return 'unresolved';
  if (z >= UNRESOLVED_BAND.hi) return 'window';
  if (z >= UNRESOLVED_BAND.lo) return 'unresolved';
  return 'no-window';
}

/**
 * @typedef {object} Break
 * @property {number} index First index of the segment **after** the break.
 * @property {number} z Absolute rank-sum z at that split.
 * @property {number} depth Recursion depth it was found at.
 */

/**
 * @typedef {object} Segmentation
 * @property {Break[]} breaks The splits that were TAKEN, ascending by index — `|z| >= minZ`, exactly
 *   as before 496a.
 * @property {Break[]} unresolvedBreaks The best split of a segment the recursion declined, where its
 *   strength still landed in {@link UNRESOLVED_BAND} — i.e. `[lo, minZ)`. **Reported, never acted
 *   on:** the recursion stopped at each of these exactly as it did before, so the segments either
 *   side are still reported as one level. Ascending by index.
 */

/**
 * Binary segmentation, plus the near-misses it declined.
 *
 * The splitting rule is untouched: a segment is cut when and only when its best split reaches
 * `minZ`. The addition is that a segment whose best split lands in the unresolved band *below* the
 * bar is recorded before the recursion returns, so "no split here" can be told apart from "a level
 * change the evidence cannot resolve". Both come out of ONE traversal, so the reported near-miss
 * cannot drift from the recursion that produced it.
 *
 * @param {readonly number[]} values
 * @param {number} [minZ]
 * @param {number} [minSegment]
 * @returns {Segmentation}
 */
export function segmentation(values, minZ = 4, minSegment = 8) {
  /** @type {Break[]} */ const out = [];
  /** @type {Break[]} */ const unresolved = [];
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
    if (best.k < 0 || best.z < minZ) {
      // The only line 496a adds to the traversal, and it sits AFTER the decision not to split, so
      // the segmentation it reports on is provably the one that ran.
      // `!== 'no-window'` rather than `=== 'unresolved'`: with the pinned bar of 4 the two are the
      // same set, and under a bar raised ABOVE the band they are not — a declined split at 4.6 is
      // then reported rather than dropped, which is the direction that keeps evidence visible.
      if (best.k >= 0 && detectionVerdict(best.z) !== 'no-window') {
        unresolved.push({ index: lo + best.k, z: best.z, depth });
      }
      return;
    }
    const at = lo + best.k;
    out.push({ index: at, z: best.z, depth });
    recurse(lo, at, depth + 1);
    recurse(at, hi, depth + 1);
  };
  recurse(0, values.length, 0);
  return {
    breaks: out.sort((a, b) => a.index - b.index),
    unresolvedBreaks: unresolved.sort((a, b) => a.index - b.index),
  };
}

/**
 * Binary segmentation: recursively split wherever the rank-sum statistic exceeds `minZ`.
 *
 * The splits alone. {@link segmentation} is the same traversal and also reports the near-misses.
 *
 * @param {readonly number[]} values
 * @param {number} [minZ]
 * @param {number} [minSegment]
 * @returns {Break[]} Ascending by index.
 */
export function changepoints(values, minZ = 4, minSegment = 8) {
  return segmentation(values, minZ, minSegment).breaks;
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
 * How strongly a window is separated from what is either side of it — captain decision 496a.
 *
 * @typedef {object} Detection
 * @property {number} z The **BINDING** strength: the weaker of the window's two bounding breaks,
 *   because a window is only as well separated as its worse edge. `NaN` only if a window somehow has
 *   neither edge, which {@link findWindows} cannot produce (a window needs two segments).
 * @property {number | null} openZ  Strength of the break at the window's open. `null` when that end
 *   is the series' own start — a censored end is **not a weak detection**, it is no detection, and
 *   it is already reported as {@link Window.openObserved}.
 * @property {number | null} closeZ Likewise at the close.
 * @property {DetectionVerdict} verdict Of `z`. `unresolved` here means the window WAS segmented —
 *   the bar is unmoved — and its separation is inside the band, so the finding is a coin flip.
 * @property {number} minZ The bar this run segmented at, carried so a saved reading can be read back
 *   without the bounds file it was produced under.
 * @property {{ lo: number, hi: number }} unresolvedBand
 */

/**
 * @typedef {object} Window
 * @property {Segment} segment
 * @property {Detection} detection    Never optional: 496a's whole point is that a window cannot be
 *   reported without its strength beside it.
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
 * @property {number} minZ            The bar this deployer's series was segmented at. Carried even
 *   when nothing was found, because "no window at |z| >= 4" and "no window at |z| >= 3" are
 *   different findings and a reader of a saved record cannot tell them apart otherwise.
 * @property {Segment[]} segments
 * @property {Window[]} windows        Profitable local maxima only. **Both verdicts, kept apart by
 *   {@link Window.detection}.** They share a list because they are the same measurement, differing
 *   only in how well the evidence separates them; a caller counting windows must read the verdict.
 * @property {Break[]} unresolvedBreaks Level changes this series shows at a strength inside
 *   {@link UNRESOLVED_BAND} but **below** the bar, so the segmentation did not act on them and the
 *   segments either side are reported as one. They are not windows and never become windows here —
 *   they are the answer *"there may be a level change here and this series cannot resolve it"*,
 *   which 496a reports rather than filing as absence.
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
      minZ,
      segments: [],
      windows: [],
      unresolvedBreaks: [],
      unprofitablePeaks: [],
      tooShortReason:
        `${points.length} measured launch(es) is below the ${minSegment * 2 + 4} a split needs at a ` +
        `minimum segment of ${minSegment}. No window can be detected here, which is NOT the same ` +
        `finding as no window having arrived.`,
    };
  }

  const { breaks, unresolvedBreaks } = segmentation(
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
    // Segment i sits between break i-1 and break i, so its two edges are exactly those. A censored
    // edge has no break and contributes NO strength — it is absent evidence, not weak evidence.
    const openZ = prev === undefined ? null : (breaks[i - 1]?.z ?? null);
    const closeZ = next === undefined ? null : (breaks[i]?.z ?? null);
    const edges = [openZ, closeZ].filter((z) => /** @type {number | null} */ (z) !== null);
    // The WEAKER edge binds: a window separated by |z| = 6 at one end and 4.1 at the other is only
    // resolved to 4.1, and quoting the stronger edge would be picking the flattering half.
    const z = edges.length === 0 ? Number.NaN : Math.min(.../** @type {number[]} */ (edges));
    windows.push({
      segment: seg,
      detection: {
        z,
        openZ,
        closeZ,
        verdict: detectionVerdict(z),
        minZ,
        unresolvedBand: { lo: UNRESOLVED_BAND.lo, hi: UNRESOLVED_BAND.hi },
      },
      profitable: true,
      openObserved: prev !== undefined,
      closeObserved: next !== undefined,
      durationDays: (seg.toMs - seg.fromMs) / 86_400_000,
      gapToNextRegimeDays: next === undefined ? Number.NaN : (next.fromMs - seg.toMs) / 86_400_000,
      launchesMeasured: seg.launches,
    });
  }

  return {
    deployer,
    launchesMeasured: points.length,
    observationDays,
    minZ,
    segments,
    windows,
    unresolvedBreaks,
    unprofitablePeaks,
    tooShortReason: null,
  };
}

/**
 * The ONE human-readable form of a window, and it always carries the strength.
 *
 * Every printed surface goes through this rather than composing its own line, which is what makes
 * "strength beside every window" a property of the code instead of a convention a later printer can
 * forget. A test asserts the strength and the verdict are in the output on all three verdicts.
 *
 * @param {Window} window
 * @returns {string}
 */
export function formatWindow(window) {
  const d = window.detection;
  const open = new Date(window.segment.fromMs).toISOString().slice(0, 10);
  const close = new Date(window.segment.toMs).toISOString().slice(0, 10);
  const ends =
    window.openObserved && window.closeObserved
      ? 'both ends observed'
      : `CENSORED (${window.openObserved ? 'open observed' : 'open censored'}, ` +
        `${window.closeObserved ? 'close observed' : 'close censored'}) — the duration is a LOWER BOUND`;
  const edge = (/** @type {number | null} */ v) => (v === null ? 'censored' : v.toFixed(2));
  const line =
    `${d.verdict.toUpperCase()} ${open} → ${close}  ${window.durationDays.toFixed(1)} d, ` +
    `${window.launchesMeasured} measured launches, median return per SOL ` +
    `${window.segment.medianReturnPerSol.toFixed(3)}  |  detection |z|=${d.z.toFixed(2)} ` +
    `(open ${edge(d.openZ)}, close ${edge(d.closeZ)}; bar ${d.minZ}, unresolved band ` +
    `${d.unresolvedBand.lo}–${d.unresolvedBand.hi})  |  ${ends}`;
  return d.verdict === 'unresolved' ? `${line}\n    ${MARGINAL_DETECTION_CAVEAT}` : line;
}

/**
 * The same for a near-miss the segmentation declined to act on.
 *
 * @param {Break} unresolved
 * @param {number} minZ
 * @returns {string}
 */
export function formatUnresolvedBreak(unresolved, minZ) {
  return (
    `UNRESOLVED level change at measured launch ${unresolved.index}, depth ${unresolved.depth}  |  ` +
    `detection |z|=${unresolved.z.toFixed(2)} — below the bar of ${minZ}, so NOT split: the levels ` +
    `either side are reported as one segment. Reported rather than filed as absence.\n    ` +
    MARGINAL_DETECTION_CAVEAT
  );
}

/**
 * @typedef {object} ArrivalSummary
 * @property {number} deployers
 * @property {number} deployersSegmentable  How many had enough measured launches to detect anything.
 * @property {{ minZ: number | null, unresolvedLo: number, unresolvedHi: number }} detectionBand The
 *   bar the cohort segmented at — `null` if no deployer was segmentable, so nothing was measured at
 *   any bar — and the band the verdicts were read against. Carried so a saved summary can be read
 *   back without the bounds file it was produced under.
 * @property {number} windowsResolved   Windows whose binding strength clears the band.
 * @property {number} windowsUnresolved Windows inside the band. **A third class, not a footnote on
 *   either neighbour.**
 * @property {number} windowsBelowBand Windows whose binding strength resolves the OTHER way — below
 *   the band. **Unreachable at the pinned bar** (a taken break has `|z| >= minZ = 4`, above the
 *   band's `lo`), and present anyway so the classification is TOTAL: the three counts are a
 *   partition of `windowsDetectedIncludingUnresolved` rather than two named classes and a
 *   catch-all. A caller passing `opts.minZ` below {@link UNRESOLVED_BAND}`.lo` is the reachable
 *   route, and without this field such a window would be absorbed into `windowsUnresolved` — this
 *   change's own rule broken in the other direction.
 * @property {number} windowsDetectedIncludingUnresolved Every window {@link findWindows} produced,
 *   named so it cannot be mistaken for the resolved one, and equal to the three classes summed so
 *   no window is silently dropped either. There is deliberately no bare `windows` key: 496a removed
 *   it rather than redefining it, so a consumer that pooled the classes fails loudly.
 * @property {number} unresolvedBreaksNotSplit Level changes inside the band but below the bar,
 *   summed over the cohort. The segmentation did not act on any of them and this changes no
 *   measured quantity; it is the count of places the evidence ran out.
 * @property {number} windowsResolvedWithBothEndsObserved The only ones whose duration is a
 *   measurement — and, being resolved, the only ones whose EXISTENCE is a measurement too.
 * @property {number} windowsUnresolvedWithBothEndsObserved
 * @property {number} windowsBelowBandWithBothEndsObserved See `windowsBelowBand`.
 * @property {number} observationDeployerDays Summed over segmentable deployers only.
 * @property {number} windowsPerDeployerYearResolved The arrival rate's **LOWER** bound: unresolved
 *   windows counted as none. `NaN` when nothing was observed.
 * @property {number} windowsPerDeployerYearIncludingUnresolved Its **UPPER** bound: resolved plus
 *   unresolved windows. A below-band window is NOT in it — that class resolved the other way, and
 *   counting it here would be pooling a `no-window` reading into the upper bound. The two are
 *   published as a range and never averaged into one figure; there is no bare
 *   `windowsPerDeployerYear`, for the same reason there is no bare `windows`.
 * @property {number[]} durationsDaysBothEndsObserved **Resolved** windows only.
 * @property {number[]} durationsDaysCensored **Lower bounds**, kept apart from the measurements.
 *   Resolved windows only.
 * @property {number[]} unresolvedDurationsDaysBothEndsObserved Never pooled with the resolved
 *   durations: a duration is a measurement of a window, and whether there is a window is exactly
 *   what is unresolved here.
 * @property {number[]} unresolvedDurationsDaysCensored
 * @property {number[]} belowBandDurationsDaysBothEndsObserved Kept apart for the same reason and
 *   present for the same one: see `windowsBelowBand`.
 * @property {number[]} belowBandDurationsDaysCensored
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
  // An EXPLICIT three-way split on the verdict rather than a `!== 'window'` catch-all. The
  // catch-all is only correct while the bar sits inside the band, and `findWindows` takes `opts.minZ`
  // — a caller below the band's `lo` would have had its `no-window` windows counted as unresolved,
  // which is 496a's own rule broken in the other direction. `byVerdict` is total by construction, so
  // a fourth verdict word would land nowhere silently rather than being absorbed.
  /** @type {Record<DetectionVerdict, Window[]>} */
  const byVerdict = { window: [], unresolved: [], 'no-window': [] };
  for (const w of allWindows) byVerdict[w.detection.verdict].push(w);
  const resolved = byVerdict.window;
  const unresolved = byVerdict.unresolved;
  const belowBand = byVerdict['no-window'];
  const observationDeployerDays = segmentable.reduce((a, d) => a + d.observationDays, 0);
  const tooShort = perDeployer.length - segmentable.length;
  const perYear = (/** @type {number} */ n) =>
    observationDeployerDays > 0 ? (n * 365.25) / observationDeployerDays : Number.NaN;
  const bothEnds = (/** @type {readonly Window[]} */ ws) => ws.filter((w) => w.openObserved && w.closeObserved);
  const censored = (/** @type {readonly Window[]} */ ws) => ws.filter((w) => !w.openObserved || !w.closeObserved);
  const days = (/** @type {readonly Window[]} */ ws) => ws.map((w) => w.durationDays).sort((a, b) => a - b);
  const unresolvedBreaks = segmentable.reduce((a, d) => a + d.unresolvedBreaks.length, 0);
  // One bar per cohort: `runSeries` passes `BOUNDS.series.minZ` to every `findWindows` call, so
  // there is nothing to choose between here. `null` means NOTHING WAS SEGMENTABLE — no bar was
  // applied to anything — and is not the same reading as a bar of 0.
  const minZ = segmentable[0]?.minZ ?? null;
  return {
    deployers: perDeployer.length,
    deployersSegmentable: segmentable.length,
    detectionBand: { minZ, unresolvedLo: UNRESOLVED_BAND.lo, unresolvedHi: UNRESOLVED_BAND.hi },
    windowsResolved: resolved.length,
    windowsUnresolved: unresolved.length,
    windowsBelowBand: belowBand.length,
    windowsDetectedIncludingUnresolved: allWindows.length,
    unresolvedBreaksNotSplit: unresolvedBreaks,
    windowsResolvedWithBothEndsObserved: bothEnds(resolved).length,
    windowsUnresolvedWithBothEndsObserved: bothEnds(unresolved).length,
    windowsBelowBandWithBothEndsObserved: bothEnds(belowBand).length,
    observationDeployerDays,
    windowsPerDeployerYearResolved: perYear(resolved.length),
    windowsPerDeployerYearIncludingUnresolved: perYear(resolved.length + unresolved.length),
    durationsDaysBothEndsObserved: days(bothEnds(resolved)),
    durationsDaysCensored: days(censored(resolved)),
    unresolvedDurationsDaysBothEndsObserved: days(bothEnds(unresolved)),
    unresolvedDurationsDaysCensored: days(censored(unresolved)),
    belowBandDurationsDaysBothEndsObserved: days(bothEnds(belowBand)),
    belowBandDurationsDaysCensored: days(censored(belowBand)),
    caveats: [
      `${tooShort} of ${perDeployer.length} deployer(s) had too few MEASURED launches to segment at ` +
        `all and are excluded from the denominator. That is not evidence no window arrived for them, ` +
        `and it drops the shortest-lived deployers — which the historical seed exists to include.`,
      'A duration on a censored end is a LOWER BOUND, and the two are reported apart rather than pooled.',
      'Measured launches only. An unmeasured launch is not a zero and never enters the rank test as one.',
      MARGINAL_DETECTION_CAVEAT,
      `${unresolved.length} of ${allWindows.length} detected window(s) are UNRESOLVED, ` +
        `${belowBand.length} resolved BELOW the band, and ${unresolvedBreaks} further level change(s) ` +
        `fell inside the band below the bar and were not split. The arrival rate is therefore a ` +
        `RANGE — ${perYear(resolved.length)} per deployer-year counting only resolved windows, ` +
        `${perYear(resolved.length + unresolved.length)} counting the unresolved ones too — and ` +
        `neither end is the answer on its own.`,
    ],
  };
}
