/**
 * The FILL SOURCE CONTRACT — and nothing else. Captain decision 260a, 2026-08-05.
 *
 * ## Why this module exists, stated before the types
 *
 * Stage 2's entry measurement used to know how to fetch its own fills: `stage2.mjs` imported
 * `readLaunchWindow` and `windowReachMs` from `pumpfun.mjs`, so the swap-api was a **compile-time
 * property of a scoring module**. The captain's programme moves that measurement's raw fills to
 * Dune, and under the import shape that means a branch on vendor kind *inside* the module that
 * computes `roomLeft` — which is precisely the thing that later grows into "if Dune, use this bar".
 *
 * So the seam moves one notch: **inject the source, not just the socket.** `screen.mjs` selects a
 * {@link FillSource} and hands it to Stage 2, and Stage 2 asks it for windows without ever learning
 * which vendor answered. What crosses is a capability to fetch raw fills — never a measured
 * quantity, in either direction.
 *
 * **What that does and does not preserve, said plainly.** It does NOT make the claim "no Dune value
 * reaches a Stage 2 entry number" true — that claim is false by design the day the cutover happens,
 * because a Dune fill reaching `entry.roomLeft` is the whole programme. What it preserves is the
 * property that claim was protecting: **no module that decides anything may know which vendor
 * produced the fills it decides on.** A module that can tell is one refactor away from a bar that
 * differs by source, and that failure is invisible — a wrongly refused deployer is filed and never
 * offered again.
 *
 * ## This module imports NOTHING at runtime, and that is what makes it safe to import
 *
 * A scoring module may import this because there is no value here that could have come from a
 * vendor: two frozen string lists, a typedef set and one assertion over a plain object. The type
 * references in the JSDoc below erase at runtime and cannot carry a value.
 * `test/deployer-screen.test.ts` asserts the no-runtime-import property rather than trusting it,
 * because the whole allow-list rests on it.
 *
 * ## The window contract lives here, not in the vendor that first wrote it
 *
 * {@link LaunchWindow} and {@link LaunchWindowDropReason} moved here from `pumpfun.mjs`. Nothing in
 * either is pump.fun-specific: they are the vocabulary of **proved coverage** — did the walk get
 * back past the mint, did the two clocks agree, were any rows unreadable, and if the answer is no,
 * which of those it was. Every source fills the same contract in, and a source that cannot fill it
 * in honestly must return `usable: false` with a sentence. That obligation is the reason
 * {@link FillSource.readWindow} returns a window rather than a bare `Fill[]`: the hazard on any new
 * fill route is not that a row means something different, it is that a **short** result is
 * well-formed, complete-looking and silently wrong in the same direction a truncated backwards walk
 * is.
 */

/**
 * @typedef {'swap-api' | 'dune'} FillSourceKind
 */

/**
 * Every provenance a fill may carry. **Exhaustive**: a third source means coming back here on
 * purpose, which is the same discipline `credential.mjs`'s key list is held to.
 *
 * @type {readonly FillSourceKind[]}
 */
export const FILL_SOURCE_KINDS = Object.freeze(['swap-api', 'dune']);

/**
 * Why a launch window was dropped. One value per cause, never a lump total, because the causes call
 * for different actions: a request cap means the launch was busy, a `mint-time-disagreement` means
 * the vendor's clock and the fill tape have come apart and the measurement is no longer resting on
 * what we think it is.
 *
 * @typedef {'mint-time-disagreement' | 'coverage-unproven' | 'unrecognised-body' | 'request-cap'
 *   | 'stalled-cursor' | 'unparsed-rows' | 'no-fills'} LaunchWindowDropReason
 */

/**
 * @typedef {object} LaunchWindow
 * @property {string} mint
 * @property {number} seekFromMs      The NEWEST instant the source could reach, absolute. Reported
 *   because a walk's coverage proof is about the OLDEST end only: nothing else in this record says
 *   whether the newest end was requested at all, and that silence is the defect captain decision
 *   144a names.
 * @property {import('./measure.mjs').Fill[]} fills Fills inside the opening window, **anchored on
 *   the earliest curve buy's own slot** rather than on the supplied mint time.
 * @property {number} pages           Pages the read consumed.
 * @property {number} requests        Requests it cost, **including retries of shed ones**.
 * @property {number} rowsSeen        Rows the source returned, before window filtering.
 * @property {number} unparsedRows    Rows we could not read. Non-zero makes the launch unusable.
 * @property {boolean} reachedCreateSlot Whether the read provably got back past the mint.
 * @property {boolean} hitRequestCap  Whether it stopped because of a per-launch cap.
 * @property {boolean} mintTimeDisagreement Whether a row older than the supplied mint time came
 *   back — proof the two clocks disagree, and a hard drop.
 * @property {boolean} usable         Whether this window may be measured at all.
 * @property {LaunchWindowDropReason | null} dropReason `null` exactly when `usable`.
 * @property {string} note            Why, in one sentence. Always populated.
 */

/**
 * A {@link LaunchWindow} that says who produced it.
 *
 * **`kind` is RECORDED AND REPORTED AND READ BY NOTHING** — captain decision 227a's posture for
 * `is_mayhem_mode`, applied one layer down. No bar, gate, rate or verdict reads it, and
 * `test/deployer-screen.test.ts` pins that no scoring module branches on it. Provenance becoming an
 * input is the failure the injection exists to prevent; the import graph alone cannot prevent it,
 * so it is asserted separately.
 *
 * @typedef {LaunchWindow & { kind: FillSourceKind }} SourcedLaunchWindow
 */

/**
 * What a source needs to know about the launch window it is being asked for.
 *
 * These are Stage 2's own pinned bounds plus its injected clock. They arrive per call rather than at
 * construction so that a source is built from its transport alone, and so the thresholds keep
 * travelling from the one place that loads them.
 *
 * @typedef {object} FillSourceBounds
 * @property {number} windowMs        Nominal opening-window length.
 * @property {number} seekMarginMs    Clock slack against an early vendor mint time.
 * @property {number} windowSlotSpan  Slots after the create slot that count as inside the window.
 * @property {number} maxRequestsPerLaunch Hard per-launch request cap, retries included.
 * @property {number} tradePageLimit  Rows per request, where the source pages.
 * @property {number} nowMs           Stage 2's injected clock, so eligibility is reproducible.
 */

/**
 * A source of raw fills for one launch's opening window.
 *
 * @typedef {object} FillSource
 * @property {FillSourceKind} kind
 *   Provenance. Stamped on every window this returns; see {@link SourcedLaunchWindow}.
 * @property {(bounds: FillSourceBounds) => Promise<number>} minAgeMs
 *   **ELIGIBILITY, ASKED OF THE SOURCE.** How old a launch must be before this source can answer
 *   for it — i.e. *has this launch finished happening, as far as this vendor can see?*
 *
 *   It is a method rather than a constant on purpose, and captain decision 144a is the reason:
 *   that gate has now failed the same way twice, and both times the defect was **writing a DURATION
 *   for something someone else controls**. The swap-api answers from its own cursor reach; the Dune
 *   route must answer from an observed vendor watermark (captain decision 257a), which is the same
 *   question asked of a vendor whose tables lag. Neither answer is written down at the call site.
 *
 *   **It must be TOTAL and FINITE** — see {@link assertMinAgeUsable}. A source that cannot answer
 *   refuses to be BUILT, at the one selection site, rather than answering `Infinity` and letting a
 *   non-number travel into a record field the contract declares as a number.
 * @property {(ref: import('./measure.mjs').LaunchRef, bounds: FillSourceBounds)
 *   => Promise<SourcedLaunchWindow>} readWindow
 *   Fetch one launch's window. Returns the coverage contract, never a bare fill array.
 * @property {() => number} issued    Requests spent so far, retries included.
 * @property {() => number} remaining Requests left under this source's own ceiling. Stage 2 reserves
 *   a whole launch's worth before starting one, so a window is never walked half-way.
 */

/**
 * Refuse an eligibility answer that is not a duration.
 *
 * **A source that cannot say how old a launch must be must refuse to EXIST, not answer `Infinity`.**
 * There is no honest finite answer to "has this launch finished happening" when the vendor cannot
 * say, and there is no honest non-finite one either: `minAgeMs` is reported as
 * `entry.coverage.minAgeMs`, which the versioned run record declares a number and `render.mjs`
 * prints. `JSON.stringify(Infinity)` is `null`, so an unreadable watermark would reach a saved
 * record as a MISSING gate and a rendered line as `younger than Infinityms` — an unknown wearing a
 * measurement's clothes, which is the shape this repo refuses everywhere else (`covered.fromMs ===
 * null` means covered nothing, never since-the-epoch). Substituting a large constant is worse
 * still: that is captain decision 144a's defect exactly, a written duration for something the
 * vendor controls.
 *
 * So the refusal happens where it can be stated — a source whose eligibility is unanswerable throws
 * from its own constructor, at `screen.mjs` → `selectEntryFillSource`, the one place a source is
 * chosen and already the one place a missing source is refused. This guard is what makes that
 * structural rather than remembered: it fails on a FUTURE source that reintroduces a non-finite
 * answer, in the same spirit as {@link assertWindowUsable}, and a guard that cannot fail is not a
 * guard.
 *
 * **It is therefore applied at every point the answer is CONSUMED, not only at construction**, as
 * the backstop for a source that forgets: `stage2.mjs` before it filters a run, `screen.mjs` and
 * `bundling.mjs` before their dry-run plans print the floor, and `bundling.mjs` again before the
 * census filters on it. The census case is the one that shows why a printed line is not the worst
 * outcome: there the floor is a FILTER, so a non-finite answer makes every launch fail `age >=
 * minAgeMs` and the pass reports zero eligible launches for every candidate — a census of nothing,
 * indistinguishable from a cohort that genuinely had none, and wrong in the direction that
 * publishes a finding rather than refusing to.
 *
 * @param {{ kind: FillSourceKind }} source The source itself, so the message can name it. The
 *   consumer therefore never spells a provenance: reading `kind` for a sentence belongs here, in the
 *   contract, exactly as {@link assertWindowUsable} reads it.
 * @param {number} minAgeMs
 * @returns {void}
 */
export function assertMinAgeUsable(source, minAgeMs) {
  if (typeof minAgeMs === 'number' && Number.isFinite(minAgeMs) && minAgeMs >= 0) return;
  throw new Error(
    `the ${source.kind} fill source answered eligibility with ${String(minAgeMs)}, ` +
      `which is not a duration. "How old must a launch be before this source can answer for it" has ` +
      `no honest non-finite answer: the figure is persisted as \`entry.coverage.minAgeMs\` and ` +
      `rendered, so a non-finite one reaches a saved record as a missing gate. A source that cannot ` +
      `read what it needs must refuse to be built at all, so nothing is ever measured on it.`,
  );
}

/**
 * Refuse a window that claims coverage it has not proved.
 *
 * **This is a contract guard, not a vendor guard, and it throws.** A source's own bad luck — a shed
 * page, a stalled cursor, a clock disagreement — is reported as `usable: false` with a
 * {@link LaunchWindowDropReason}; that is the normal path and Stage 2 counts it. What this catches
 * is a source asserting `usable: true` while one of the proof obligations is unmet, which is a
 * programming error in the source and must be loud rather than counted: a window measured from an
 * unproved walk anchors the create slot on whatever fill the read happened to stop at, crowns a
 * mid-window sniper as the deployer, and produces a confident room figure for a launch whose
 * opening was never seen. Nothing about the output would look wrong.
 *
 * It is what stops "return a `LaunchWindow`" from being a shape a new source can satisfy by filling
 * the fields in optimistically.
 *
 * @param {SourcedLaunchWindow} window
 * @returns {void}
 */
export function assertWindowUsable(window) {
  if (!FILL_SOURCE_KINDS.includes(window.kind)) {
    throw new Error(`a fill source returned an unknown provenance ${JSON.stringify(window.kind)}`);
  }
  if (window.note === '') {
    throw new Error('a fill source returned a window with no note, and a drop is never silent');
  }
  if (!window.usable) {
    if (window.dropReason === null) {
      throw new Error('a fill source returned an unusable window with no drop reason');
    }
    return;
  }
  if (window.dropReason !== null) {
    throw new Error(`a usable window may not carry the drop reason ${JSON.stringify(window.dropReason)}`);
  }
  /** @type {[boolean, string][]} */
  const obligations = [
    [window.reachedCreateSlot, 'it never proved it reached the create slot'],
    [!window.mintTimeDisagreement, 'a row older than the declared mint came back'],
    [!window.hitRequestCap, 'it stopped on its own request cap'],
    [window.unparsedRows === 0, `${window.unparsedRows} row(s) could not be read`],
    [window.fills.length > 0, 'it holds no fills'],
  ];
  for (const [held, why] of obligations) {
    if (held) continue;
    throw new Error(
      `a ${window.kind} fill source claimed a usable window while ${why}. Coverage is a proof ` +
        `obligation, not an assumption: an unproved window is measurable-looking and silently ` +
        `wrong, so it must come back \`usable: false\` with a reason instead.`,
    );
  }
}
