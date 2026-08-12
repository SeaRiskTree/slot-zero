/**
 * Stage 2's memory — WHICH SURVIVORS THIS SCREEN HAS ALREADY SPENT ITS SCORING CAP ON.
 *
 * Captain decision 336a. Before it, `screen.mjs` took `survivors.slice(0, maxScored)`: the first
 * seven gate survivors in `mergeSeeds` order, which is deterministic, so a daily run scored the
 * SAME seven wallets every day. That is not a cheap repeat, it is a wasted run — the median
 * survivor needs about 21.5 days for its ten windows to refresh and **0 of 27 refresh within a
 * day**, so a same-day re-measure re-answers a question already answered. Distinct yield was about
 * 168 windows a month against roughly 2,571 of available supply, and the captain's floor is 1,000
 * window measurements a month.
 *
 * So the cap now spends itself on the survivors a visit covers the most NEW GROUND on, and cycles
 * through the population instead of repeating its head.
 *
 * ## WHICH survivors, and why recency alone was not it — captain decision 399a
 *
 * 336a ordered survivors on `lastScoredAtIso` alone. That is correct for its own purpose and it is
 * BLIND to how much new ground a visit actually covers: a round robin gives every survivor the same
 * number of visits whatever its launch tempo, and a deployer creating forty tokens a month gets the
 * same three-and-a-bit visits as one creating six. Measured over the 58 census July gate-passers and
 * their real July launch counts, the same 210 monthly scorings harvest **1,067** distinct windows
 * round-robin against **1,963** allocated by remaining unharvested flow. The tail is what is
 * stranded: 58 wallets against 210 scorings is 3.62 visits each, i.e. 36.2 windows of allowance, and
 * **17 of the 58 launched more than that in July, stranding 935 windows between them**. Fully
 * harvesting all 58 needs 231 visits against 210 available — the population is only 10%
 * oversubscribed, so the loss is ALLOCATION and not capacity.
 * (`slot-zero-discovery-beyond-madeonsol` §5.2, held in firstmate's records, not in this repo — so
 * every figure in this paragraph is evidence from elsewhere and is asserted by no test here. What
 * `test/deployer-screen.test.ts` → "CHANGES THE HARVEST on a heavy tail" does assert is that a
 * population of the same SHAPE harvests materially more through this selector; it does not
 * reproduce those counts and must not be read as doing so.)
 *
 * The rank key is therefore {@link newGroundWindows}: how many DISTINCT windows a visit would cover
 * now, which is the wallet's launch flow multiplied by how long it has waited, **saturating at the
 * per-visit window cap** — a visit harvests `stage2_entry.maxLaunchesPerCandidate` launches and no
 * more, so ground beyond that is not reachable by this visit and must not earn priority.
 *
 * **Three costs, all accepted knowingly.**
 *
 * 1. **It is a selection-quality trade, not a free win.** Visiting the highest-tempo wallets most
 *    often concentrates the cap on the busiest launches, which are exactly the ones
 *    `stage2_entry.justification.maxLaunchesPerCandidate` records the request cap dropping most
 *    often. The one stranger leg on record read a 0.1333 usable fraction, and this change points
 *    capacity at the population that reading came from. Nothing here makes a dropped window
 *    reachable; it makes more windows be attempted.
 *    **THAT COST IS NOW MEASURED ON THE WIDENED POPULATION AND IT IS A REVERSAL, NOT A DISCOUNT.**
 *    The usable fraction FALLS as flow rises — 0.0333 for survivors at >= 1 launch/day against
 *    0.2917 below it (Spearman -0.4719, t -2.333 on 19 df, n = 21 wallets) — so weighting the
 *    harvest by flow raises the DISTINCT window count (1,067 -> 1,963) and LOWERS the usable one
 *    (193 -> 91 a month). `measurements/2026-08-09-widened-usable-fraction/` owns the figures, the
 *    restated ladder and the n = 21 limit; cite it rather than restating them. This changes no
 *    behaviour here — re-deciding 399a on that evidence is the captain's.
 * 2. **The tempo is LIFETIME, so a wallet that has gone quiet is still visited on it.** Clamping
 *    flow by the wallet's last deploy would park a dormant wallet forever, which is the starvation
 *    the saturation ceiling exists to prevent — see below. A visit spent on stale ground is the
 *    price of the guarantee.
 * 3. **A MAYHEM-HEAVY SURVIVOR IS RANKED ON LESS FLOW THAN IT HAS, so it is UNDER-VISITED.** The
 *    tempo is the gate's own reading and that reading excludes mayhem launches (captain decision
 *    351) while a visit harvests every launch, so such a wallet saturates late and comes round less
 *    often than its real flow merits. It is UNDER-SERVICE AND NEVER STARVATION — the key still
 *    saturates and the FIFO tiebreak below still brings that wallet round, it simply waits longer
 *    than its flow warrants. {@link RotationRow.launchesPerDay} owns the argument and the
 *    alternatives declined.
 *
 * ## HOW A LOW-FLOW WALLET IS NOT PARKED FOREVER
 *
 * Pure greed by flow would park one, so the rule is deliberately not pure greed. Three clauses, and
 * the guarantee is a consequence of the second:
 *
 * 1. A survivor this screen has never scored ranks first, ahead of every measured one whatever its
 *    flow. Newcomers are never outbid.
 * 2. Then descending {@link RotationRow.newGroundWindows} — and it **SATURATES**. A wallet's ground
 *    grows with the time it has waited, so a low-flow wallet's key rises every day and reaches the
 *    ceiling after `windowCap / launchesPerDay` days, which is exactly how long that wallet takes to
 *    produce a full visit's worth of new launches. EVERY ADMITTED CANDIDATE HAS A STRICTLY POSITIVE
 *    TEMPO, ON EITHER ARM, so every one of them saturates in bounded time: clearing the competence
 *    gate requires `stage1_gate.minTokens` launches over a finite span, and captain decision 451's
 *    second arm re-checks that same sample-size bar as its condition 1 — it loosens the completion
 *    RATE and nothing else — so a sub-gate admission carries the same floor a gate survivor does.
 * 3. Once saturated, rows tie on flow and the tiebreak is 336a's own: ascending `lastScoredAtIso`,
 *    least recently measured first. That is a strict FIFO queue — anything scored after a saturated
 *    wallet sorts BEHIND it forever — so the set ahead of a saturated wallet only shrinks, and it is
 *    selected within a bounded number of runs.
 *
 * An UNREADABLE tempo is treated as SATURATED, never as no flow. That is this repo's standing
 * direction for a missing measurement one lane over (`measure.mjs` → `measureCompletion`'s unreadable
 * flag) applied here: reading absence as zero would park the wallet on evidence about our own
 * coverage, and the failure would be permanent and invisible. Treating it as saturated costs at
 * worst one keyless walk.
 *
 * With no tempo readable ANYWHERE the rule degenerates to exactly 336a's — every row saturated,
 * every flow comparison a tie, recency deciding — which is how the superseded allocation stays
 * reachable and testable without a second comparator to drift from this one.
 *
 * ## What this module is NOT
 *
 * It is not a capacity change. `stage2_entry.maxCandidatesScored` does not move — captain decision
 * 339a keeps it at 7 per run, because raising it means moving the scoring cap and the request
 * budget together and that is a separate decision. This module changes WHICH seven, and nothing
 * else. It reads no vendor, opens no socket and costs zero in every currency.
 *
 * It is also not `ledger.mjs`, which is the discovery feed's memory: that one records which wallets
 * this project has ever SEEN, so a scheduled feed does not re-offer them as new. This one records
 * which wallets Stage 2 has ever SCORED, so a scheduled screen does not re-measure them. Two
 * different questions over two different populations — the feed's ledger holds every wallet the
 * vendor ever surfaced, this holds every wallet STAGE 2 HAS SCORED, whichever arm admitted it (captain decision 451;
 * `screen.mjs` selects on `admission.mjs` -> `admittedToStage2`, so a sub-gate admission is stamped
 * here exactly as a gate survivor is, and a reader splits the file by arm through the candidate rows
 * of the run records that produced it) — and one file
 * answering both would make either question's answer depend on the other's cadence. What IS reused
 * is {@link ledgerRunRecords}, and the SHAPE of `nextGateBatch`: oldest first, with a deterministic
 * tiebreak, because a rotation that drains freshest-first starves its own tail permanently while
 * reporting healthy yield every run.
 *
 * ## An UNMEASURED verdict still counts as scored, and that does not breach 174b
 *
 * A candidate that reached `entry-unmeasured` consumed the cap and the keyless walk that goes with
 * it, so it is recorded here exactly as a measured one is — otherwise the cap would re-spend itself
 * on the same unanswerable wallets forever, which is the defect this module removes wearing a
 * different hat. Captain decision 174b forbids a later stage FILTERING on an unmeasured verdict;
 * this drops nobody. The wallet keeps its place in the cycle and comes back round with the rest,
 * and the run record still surfaces and counts its unmeasured verdict.
 *
 * ## THE PROPERTY BEING TRADED, AND WHAT PAYS FOR IT
 *
 * Before 336a the screen was stateless: same inputs, same output, and anyone could re-run it and
 * reproduce a published result. Rotation makes a run's output depend on every run before it, and
 * the captain accepted that trade **on the condition that reproducibility is preserved another
 * way**. Three things buy it back, and they are acceptance criteria rather than niceties:
 *
 * 1. **The state is committed evidence.** It is a JSON file in this tree, written in sorted key
 *    order so two runs over the same state produce byte-identical bytes and a diff shows the lines
 *    that changed rather than a reshuffle.
 * 2. **The run record NAMES the state it read** — its path, its schema version and the SHA-256 of
 *    the bytes as read, plus the digest of the bytes the run then wrote. Run N's `after` is run
 *    N+1's `before`, so the chain of runs is checkable end to end from committed artefacts.
 * 3. **The selection is re-derivable from the record alone.** The record carries the whole ranked
 *    `order` the rotation produced, not just the slice it took, and {@link verifySelection} — the
 *    same ranking rule the live selection uses — recomputes the slice from it. A reader who never
 *    saw the state file can still check that the run scored the wallets its own rule says it should
 *    have. **399a's flow term is subject to that condition rather than exempt from it**: a
 *    comparator reading anything the record does not carry would break it, so every input the
 *    ranking uses — the tempo AND the saturating ground it produced — is persisted on the row, and
 *    {@link verifySelection} will re-derive the second from the first when handed the run's own
 *    instant and window cap, both of which the record already states.
 *
 * {@link REPRODUCIBILITY_RULE} is that condition in one sentence and it travels on the state file,
 * on the run record and on the rendered Stage 2 block, for the reason `LANDING_TIP_CAVEAT` does:
 * a caveat that lives only in a document is one a reader of the number never sees.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { readRunRecords as ledgerRunRecords } from './ledger.mjs';

export { ledgerRunRecords };

/**
 * Rotation state format version.
 *
 * Bumped, never retro-fitted, for the same reason `LEDGER_SCHEMA_VERSION` is: this file is the only
 * record of which survivors have already had the cap spent on them, and a reader that quietly
 * started over would put the rotation back at the head of the list — the exact behaviour 336a
 * removed, restored silently and with the record still claiming a rotation happened.
 */
export const ROTATION_SCHEMA_VERSION = 1;

/**
 * The condition captain decision 336a attached to giving up statelessness.
 *
 * One string, asserted onto three surfaces rather than described in a document: the state file, the
 * run record's own block and the rendered Stage 2 header. A rotation whose selection cannot be
 * checked from committed artefacts is not acceptable in this lab, and the place a reader meets that
 * claim has to be the place they meet the selection.
 */
export const REPRODUCIBILITY_RULE =
  'ROTATION STATE IS COMMITTED EVIDENCE: this run spent its scoring cap where a visit covers the ' +
  'most NEW GROUND — remaining unharvested launch flow, saturating at the per-visit window cap, ' +
  'with least-recently-scored breaking ties — so its output depends on every run before it. The ' +
  'run record names the state it read (path, schema version, SHA-256 before and after) and carries ' +
  'the whole ranked order with the flow term on every row, so the selection is re-derivable from ' +
  'committed artefacts alone — rotation.mjs -> verifySelection.';

/**
 * What the rank key means, in one sentence, for the surfaces that print a selection.
 *
 * Kept apart from {@link REPRODUCIBILITY_RULE} because they answer different questions — that one
 * says the selection can be CHECKED, this one says what it OPTIMISES — and a reader deciding whether
 * a run's wallet list looks right needs the second.
 */
export const NEW_GROUND_RULE =
  'FLOW-WEIGHTED (captain decision 399a): the cap goes where a visit covers the most windows it has ' +
  'not already covered — launch flow times time waited, capped at the per-visit window cap — and ' +
  'never-scored first, least-recently-scored breaking ties. Recency alone gave every survivor the ' +
  'same number of visits whatever its tempo, which stranded the tail.';

/**
 * The RECIPROCAL of the unit the flow term is quantised to — quanta per window, so the grid itself
 * is `1 / GROUND_QUANTA_PER_WINDOW` = 1e-6 of a window. RAISING this number makes the grid FINER.
 *
 * A rank key that is a product of two floats has ties that exist in the arithmetic and not in the
 * evidence, and a comparator that separates two rows by 1e-15 makes a published selection turn on a
 * rounding difference nobody can reproduce. Rounding to a fixed grid is a TOTAL order — an epsilon
 * comparison is not transitive and would sort differently depending on the input order — and 1e-6 of
 * a window is far below anything this measurement can distinguish.
 */
const GROUND_QUANTA_PER_WINDOW = 1e6;

/**
 * @param {number} value
 * @returns {number}
 */
function quantise(value) {
  return Math.round(value * GROUND_QUANTA_PER_WINDOW) / GROUND_QUANTA_PER_WINDOW;
}

/**
 * @typedef {object} RotationEntry
 * @property {string} wallet
 * @property {string} firstScoredAtIso The first run that spent the cap on this wallet.
 * @property {string} lastScoredAtIso  The most recent one. THE SORT KEY — see {@link rotationOrder}.
 * @property {number} timesScored How many runs have spent the cap on it. Operator context and
 *   nothing reads it for the selection; a wallet that has come round three times is not owed more
 *   or less than one that has come round once, which is what makes the cycle a cycle.
 * @property {'screen' | 'run-record'} origin Whether a live run recorded it or
 *   {@link importScoredFromRunRecords} recovered it from a committed record. A recovered entry is
 *   evidence about a run that happened, not about this state file having been kept.
 */

/**
 * @typedef {object} Rotation
 * @property {string} tool
 * @property {number} schemaVersion
 * @property {string} updatedAtIso
 * @property {string} reproducibility
 * @property {Record<string, RotationEntry>} wallets
 */

/**
 * A survivor's place in the rotation, as the record persists it.
 *
 * `lastScoredAtIso` is `null` for a survivor this screen has never scored — never an epoch
 * sentinel. The same rule `covered.fromMs` learnt the hard way one tool over: a `0` there read as a
 * 56-year window, and a `1970-01-01` here would read as "scored, a very long time ago" and sort
 * identically to one that genuinely was.
 *
 * `launchesPerDay` and `newGroundWindows` are captain decision 399a's rank key and BOTH are
 * persisted, not just the second. The comparator needs only `newGroundWindows`, so recording the
 * tempo beside it is redundant for re-deriving the ORDER and is what lets a reader re-derive the KEY
 * — the difference between checking that a run obeyed its own numbers and checking that its numbers
 * were the right ones.
 *
 * @typedef {object} RotationRow
 * @property {string} wallet
 * @property {string | null} lastScoredAtIso
 * @property {number} timesScored
 * @property {number | null} launchesPerDay The survivor's launch tempo on the reading THE GATE read
 *   — `completion.tokens / completion.spanDays`, so it is that reading's population and carries its
 *   limits (post-mayhem-exclusion and criterion-readable since thresholds 6.8.0/6.9.0, and a vendor
 *   page rather than a merged history under `--ownership-only`). `null` when it cannot be read,
 *   which is never the same as no flow — see {@link newGroundWindows}.
 *
 *   **A MAYHEM-HEAVY SURVIVOR'S FLOW IS SYSTEMATICALLY UNDERSTATED HERE, and that is a known,
 *   accepted limit of this tempo source rather than a defect.** `measure.mjs` → `measureCompletion`
 *   computes `tokens` and `spanDays` over the mayhem-EXCLUDED set (captain decision 351) while
 *   Stage 2 harvests from `toLaunchRefs`, which includes every launch — so a deployer launching
 *   ~1.0/day of which only ~0.3/day is non-mayhem is ranked on the 0.3, saturates in ~33 days
 *   instead of ~10, and is visited roughly 3x less often than its real harvestable flow merits.
 *   That is exactly the 13-of-58 population 351 exists to stop penalising. **The bound that makes
 *   it survivable is that it is UNDER-SERVICE AND NEVER STARVATION**: the key still saturates and
 *   336a's FIFO tiebreak still brings that wallet round — it simply waits longer than its real flow
 *   warrants. The alternatives are worse readings, not better ones: a mayhem-inclusive enumerated
 *   count is `null`/UNMEASURED on every walk-sourced candidate, and `toLaunchRefs` is the vendor's
 *   capped, success-biased 70-record page.
 * @property {number} newGroundWindows THE SORT KEY: how many distinct windows a visit would cover
 *   now, saturating at the per-visit window cap.
 */

/**
 * What the ranking needs that a rotation state does not hold.
 *
 * Passed in rather than read here, for the reason the eligibility gate asks its fill source one
 * module over: the window cap is `stage2_entry`'s and is source-scoped, the tempo is the gate's own
 * reading, and the instant is the run's. A module that reached for any of the three itself would be
 * a second derivation of a number that already has one.
 *
 * @typedef {object} RotationFlow
 * @property {string} nowIso The RUN's instant — the same one `markScored` stamps, so the ground a
 *   row is ranked on and the instant that row will carry afterwards are one clock.
 * @property {number} windowCap `stage2_entry.maxLaunchesPerCandidate`: how many launches ONE visit
 *   harvests. The saturation ceiling, because ground beyond what a visit can reach is ground this
 *   visit does not cover.
 * @property {Readonly<Record<string, number | null>>} launchesPerDay Per survivor. An absent or
 *   `null` entry is UNREADABLE, never zero.
 */

/**
 * A survivor's launch tempo, from the completion measurement the gate judged it on.
 *
 * Refuses rather than guesses, and every refusal lands on the visit-favouring side: a zero or
 * negative span (every launch on one day) would give an infinite tempo and a zero token count would
 * give none, and both come back `null`, which {@link newGroundWindows} reads as saturated.
 *
 * @param {{ tokens: number, spanDays: number }} completion
 * @returns {number | null}
 */
export function launchesPerDayOf(completion) {
  const { tokens, spanDays } = completion;
  if (!Number.isFinite(tokens) || !Number.isFinite(spanDays)) return null;
  if (tokens <= 0 || spanDays <= 0) return null;
  return quantise(tokens / spanDays);
}

/**
 * How many DISTINCT windows a visit to this survivor would cover now — captain decision 399a.
 *
 * `launchesPerDay × days waited`, capped at the per-visit window cap. Three readings return the cap
 * flat, and they are three different facts that happen to share an answer:
 *
 * - **Never scored.** Nothing about this wallet has been harvested, so a visit covers as much as a
 *   visit can. It is the cap EXACTLY rather than approximately, because an ADMITTED CANDIDATE ON
 *   EITHER ARM carries at least `stage1_gate.minTokens` launches — the second arm re-checks that bar
 *   too — and that floor is above the window cap; a test pins the
 *   inequality, so a lane that lowered the floor below the cap is told rather than left with a value
 *   that quietly overstates.
 * - **An unreadable tempo.** Absence of evidence, and reading it as no flow would park the wallet
 *   permanently and invisibly on a failure of OUR coverage.
 * - **An unusable instant.** Same direction, same reason.
 *
 * @param {{ lastScoredAtIso: string | null, launchesPerDay?: number | null }} row
 * @param {{ nowIso: string, windowCap: number }} flow
 * @returns {number}
 */
export function newGroundWindows(row, flow) {
  const cap = Number.isFinite(flow.windowCap) && flow.windowCap > 0 ? quantise(flow.windowCap) : 0;
  if (row.lastScoredAtIso === null) return cap;
  const tempo = row.launchesPerDay;
  if (typeof tempo !== 'number' || !Number.isFinite(tempo) || tempo <= 0) return cap;
  const now = Date.parse(flow.nowIso);
  const last = Date.parse(row.lastScoredAtIso);
  if (!Number.isFinite(now) || !Number.isFinite(last)) return cap;
  const days = Math.max(0, now - last) / 86_400_000;
  return Math.min(quantise(tempo * days), cap);
}

/** @returns {Rotation} */
export function emptyRotation() {
  return {
    tool: 'deployer-screen-stage2-rotation',
    schemaVersion: ROTATION_SCHEMA_VERSION,
    updatedAtIso: new Date(0).toISOString(),
    reproducibility: REPRODUCIBILITY_RULE,
    wallets: {},
  };
}

/**
 * Read the rotation state, or start one, and hand back the digest of the bytes as read.
 *
 * A missing file is a first run: an empty rotation, `digest: null`, and every survivor never-scored,
 * which is the one configuration in which this module's selection is byte-identical to the
 * `slice(0, maxScored)` it replaced. That equivalence is deliberate — it makes the first run after
 * this change provably inert.
 *
 * A file we cannot parse, or one written by a schema we do not know, **throws**. Starting over is
 * not the safe default here: it silently returns the rotation to the head of the list, which is the
 * defect 336a exists to remove, and it breaks the digest chain that makes a published selection
 * checkable. Both failures are invisible in the output — the run would report a rotation and
 * perform a repeat.
 *
 * @param {string} path
 * @returns {{ rotation: Rotation, digest: string | null, present: boolean }}
 */
export function loadRotation(path) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { rotation: emptyRotation(), digest: null, present: false };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `The Stage 2 rotation state at ${path} is not readable JSON ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). Refusing to start over: an ` +
        `empty rotation puts the scoring cap back on the head of the survivor list, which is the ` +
        `repeat captain decision 336a removed, and it breaks the digest chain a published ` +
        `selection is checked against. Restore the file or point --rotation elsewhere.`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The Stage 2 rotation state at ${path} is not an object.`);
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const version = obj['schemaVersion'];
  if (version !== ROTATION_SCHEMA_VERSION) {
    throw new Error(
      `The Stage 2 rotation state at ${path} declares schemaVersion ${String(version)}; this build ` +
        `reads ${ROTATION_SCHEMA_VERSION}. Rotation state is never retro-fitted — migrate it ` +
        `deliberately rather than letting a run rebuild it from nothing.`,
    );
  }

  const rotation = emptyRotation();
  rotation.updatedAtIso =
    typeof obj['updatedAtIso'] === 'string' ? obj['updatedAtIso'] : new Date(0).toISOString();
  const wallets = obj['wallets'];
  if (typeof wallets === 'object' && wallets !== null && !Array.isArray(wallets)) {
    for (const [wallet, raw] of Object.entries(/** @type {Record<string, unknown>} */ (wallets))) {
      const entry = readEntry(wallet, raw);
      if (entry !== null) rotation.wallets[wallet] = entry;
    }
  }
  return { rotation, digest: digestOf(text), present: true };
}

/**
 * One spelling of an instant, or `null` for anything that is not one.
 *
 * The rotation's whole selection turns on `lastScoredAtIso`, and the values reaching it come from
 * two places this module does not own: a state file on disk and a committed run record's
 * `startedAtIso`. Every producer emits `toISOString()` today, so a lexical order and a chronological
 * one coincide — but they coincide only by that coincidence, and a single row spelled
 * `2026-08-04T10:49:14+00:00` or `2026-08-04T10:49:14Z` would sort against the millisecond form as
 * text and land in the wrong place in the cycle, starving or re-measuring that wallet with nothing
 * in the output saying so. Normalising at the boundary removes the class rather than the instance,
 * and it is byte-neutral on state a `toISOString()` producer wrote.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function canonicalInstant(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Read one persisted row, or refuse it.
 *
 * A row without a usable `lastScoredAtIso` is DROPPED rather than repaired, and that direction is
 * the safe one: the wallet reverts to never-scored and is scored sooner than it needs to be, which
 * costs a keyless walk. Guessing a timestamp for it would push it to a place in the cycle nothing
 * measured, and could starve it.
 *
 * A row that IS usable is normalised to {@link canonicalInstant}'s single spelling, so the state
 * this module persists carries one representation of an instant rather than whichever the producer
 * happened to emit — a second-resolution or offset-bearing timestamp is the same moment and has to
 * take the same place in the cycle.
 *
 * @param {string} wallet
 * @param {unknown} raw
 * @returns {RotationEntry | null}
 */
function readEntry(wallet, raw) {
  if (wallet.length === 0 || typeof raw !== 'object' || raw === null) return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const last = canonicalInstant(row['lastScoredAtIso']);
  if (last === null) return null;
  const first = canonicalInstant(row['firstScoredAtIso']);
  const times = row['timesScored'];
  return {
    wallet,
    firstScoredAtIso: first ?? last,
    lastScoredAtIso: last,
    timesScored: typeof times === 'number' && Number.isFinite(times) && times > 0 ? Math.floor(times) : 1,
    origin: row['origin'] === 'run-record' ? 'run-record' : 'screen',
  };
}

/**
 * Record that a run spent the scoring cap on a wallet.
 *
 * Called as each candidate finishes scoring rather than once for the whole batch, so a run that
 * dies half way through advances the rotation for the wallets it paid for and for no others. The
 * wallets it never reached cost nothing and come up again next time, which is the same argument
 * `screen.mjs` makes for writing an incomplete record instead of discarding it.
 *
 * @param {Rotation} rotation
 * @param {string} wallet
 * @param {string} scoredAtIso The RUN's instant, shared by every wallet it scores — so a state file
 *   diff shows one timestamp per run rather than one per wallet, and so the record's own
 *   `scoredAtIso` identifies exactly the rows this run wrote.
 */
export function markScored(rotation, wallet, scoredAtIso) {
  const existing = rotation.wallets[wallet];
  if (existing === undefined) {
    rotation.wallets[wallet] = {
      wallet,
      firstScoredAtIso: scoredAtIso,
      lastScoredAtIso: scoredAtIso,
      timesScored: 1,
      origin: 'screen',
    };
    return;
  }
  existing.lastScoredAtIso = scoredAtIso;
  existing.timesScored += 1;
  existing.origin = 'screen';
}

/**
 * Rank survivors by the ground a visit covers, least-recently-scored breaking ties.
 *
 * **The rule, and all four clauses matter.**
 *
 * 1. A survivor this screen has never scored comes before one it has. There is no measurement to
 *    refresh, so there is nothing to wait for — and it is a clause rather than a consequence of the
 *    next one, so a newcomer's priority does not depend on the flow arithmetic agreeing.
 * 2. Then descending {@link newGroundWindows} — captain decision 399a. Recency alone gave every
 *    survivor the same number of visits whatever its tempo, which strands the tail; the module
 *    comment carries the measurement and the two costs.
 * 3. Among rows the flow term does not separate — which is every row once they saturate, and every
 *    row at all when no tempo is readable — ascending `lastScoredAtIso`, least recently measured
 *    first. That is `nextGateBatch`'s shape one lane over and it is chosen for the same reason:
 *    draining freshest-first leaves the oldest permanently starved while every run reports a healthy
 *    count. Here it does second duty as the anti-starvation guarantee — see the module comment.
 * 4. Ties break on the survivor's position in the list the caller passed, which `mergeSeeds` makes
 *    deterministic. So two runs over the same state and the same population rank identically, and
 *    with no state at all every row is never-scored and saturated, so the ranking IS the caller's
 *    order — which is what keeps the first run after 336a byte-identical to the
 *    `slice(0, maxScored)` it replaced, 399a included.
 *
 * **A survivor set that shrank costs nothing.** Wallets the rotation knows and this run's gate did
 * not return simply do not appear; their rows are kept, so a wallet that drops out for a day and
 * comes back resumes its place in the cycle rather than jumping to the front as a stranger. The
 * file therefore grows by at most `maxScored` rows a run, which at the pinned cap of 7 is the whole
 * bound on its size.
 *
 * @param {Rotation} rotation
 * @param {readonly string[]} wallets The candidates Stage 2 ADMITTED, on either arm, in the order
 *   the screen would have sliced.
 * @param {RotationFlow} flow What the flow term is computed from. Required rather than defaulted:
 *   a caller that forgot it would get 336a's allocation while the record claimed 399a's.
 * @returns {RotationRow[]}
 */
export function rotationOrder(rotation, wallets, flow) {
  const rows = wallets.map((wallet, index) => {
    const entry = rotation.wallets[wallet];
    const lastScoredAtIso = entry?.lastScoredAtIso ?? null;
    const tempo = flow.launchesPerDay[wallet];
    const launchesPerDay =
      typeof tempo === 'number' && Number.isFinite(tempo) && tempo > 0 ? quantise(tempo) : null;
    return {
      index,
      row: /** @type {RotationRow} */ ({
        wallet,
        lastScoredAtIso,
        timesScored: entry?.timesScored ?? 0,
        launchesPerDay,
        // Computed from the QUANTISED tempo, which is the number the record carries, so a reader
        // re-deriving the key from the row gets this figure back exactly rather than nearly.
        newGroundWindows: newGroundWindows({ lastScoredAtIso, launchesPerDay }, flow),
      }),
    };
  });
  rows.sort((a, b) => {
    const c = compareRotationRows(a.row, b.row);
    return c !== 0 ? c : a.index - b.index;
  });
  return rows.map((r) => r.row);
}

/**
 * The ranking rule, as a comparator over what a run record persists.
 *
 * Split out so the live selection and {@link verifySelection} apply ONE rule rather than two
 * expressions that merely agree — captain decision 144a's defect, and the reason the eligibility
 * gate and the cursor bound are one derivation one module over. A verifier that re-implemented this
 * would drift, and the drift would surface as a published selection nobody could reproduce.
 *
 * Returns 0 for rows the rule does not separate; the caller supplies the positional tiebreak,
 * which a record cannot carry and a verifier therefore must not demand.
 *
 * **A row that states no flow term does not lose to one that does.** Records written before captain
 * decision 399a carry `order` rows with no `newGroundWindows` at all, and they were produced under a
 * rule that had none — so the flow clause simply does not separate such a pair and the comparator
 * falls through to 336a's recency, which is the rule those rows were ranked by. Scoring an absent
 * key as zero would report every pre-399a record as having ranked its own survivors wrongly.
 *
 * @param {RotationRow} a
 * @param {RotationRow} b
 * @returns {number}
 */
export function compareRotationRows(a, b) {
  const an = a.lastScoredAtIso === null;
  const bn = b.lastScoredAtIso === null;
  if (an !== bn) return an ? -1 : 1;
  const ag = statedGround(a);
  const bg = statedGround(b);
  if (ag !== null && bg !== null && ag !== bg) return ag > bg ? -1 : 1;
  if (an || bn) return 0;
  const sx = /** @type {string} */ (a.lastScoredAtIso);
  const sy = /** @type {string} */ (b.lastScoredAtIso);
  const x = Date.parse(sx);
  const y = Date.parse(sy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return sx < sy ? -1 : sx > sy ? 1 : 0;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The flow term a row STATES, or `null` for a row that states none.
 *
 * @param {RotationRow} row
 * @returns {number | null}
 */
function statedGround(row) {
  const g = row.newGroundWindows;
  return typeof g === 'number' && Number.isFinite(g) ? g : null;
}

/**
 * Choose the survivors this run's scoring cap is spent on.
 *
 * @param {Rotation} rotation
 * @param {readonly string[]} wallets
 * @param {number} max
 * @param {RotationFlow} flow
 * @returns {{ order: RotationRow[], selected: string[], deferred: string[], neverScored: number }}
 */
export function selectForScoring(rotation, wallets, max, flow) {
  const order = rotationOrder(rotation, wallets, flow);
  const take = Math.max(0, Math.min(max, order.length));
  return {
    order,
    selected: order.slice(0, take).map((r) => r.wallet),
    deferred: order.slice(take).map((r) => r.wallet),
    neverScored: order.filter((r) => r.lastScoredAtIso === null).length,
  };
}

/**
 * Re-derive a run's selection from the block it persisted, and say what does not hold.
 *
 * **This is acceptance criterion 3 made checkable rather than asserted.** It takes only what a
 * committed run record carries — no state file, no survivor list, no clock — and answers whether
 * that run scored the wallets its own stated rule says it should have. Reported as problems rather
 * than a boolean so a reader is told WHICH clause failed; an empty list is the pass.
 *
 * **The flow term is checked at two depths, and the second is optional because it needs two more
 * fields off the record.** Replaying the comparator checks that the run obeyed the numbers it wrote
 * down. Handing in `expected` — the run's own `startedAtIso` and the `maxLaunchesPerCandidate` of
 * the recipe it recorded — additionally re-derives each row's `newGroundWindows` from its
 * `launchesPerDay`, which checks that those numbers were the right ones. A record cannot be trusted
 * to grade its own key without it, so a reader with the whole record should pass it.
 *
 * @param {{ order: readonly RotationRow[], selected: readonly string[], deferred: readonly string[] }} block
 * @param {number} max The scoring cap the run APPLIED, which is its own recorded `scoringCap.max`
 *   and never `thresholds.stage2_entry.maxCandidatesScored`. The two differ whenever `--score` was
 *   passed — the applied cap is the `min()` of the two — and a reader who reaches for the pinned
 *   recipe instead would be told a correct `--score 3` run selected the wrong wallets.
 * @param {{ nowIso: string, windowCap: number }} [expected] The run's own instant and per-visit
 *   window cap, for re-deriving the flow term. Omit for a pre-399a record, whose rows carry none.
 *   A cap handed in that is not a positive number of launches — an absent one off a pre-399a
 *   record, or the `null` a schema-23 record carries when its selection was null — REFUSES the
 *   re-derivation with ONE problem naming the cap, rather than folding to a cap of zero and
 *   accusing every row of stating a key its own inputs do not give. Same reading discipline
 *   {@link compareRotationRows} applies to a row that states no flow term.
 *
 *   **That refusal binds only when there is SOMETHING TO RE-DERIVE.** An EMPTY `order` holds no row
 *   key, so the cap cannot be unusable FOR ANYTHING and an absent or `null` one is simply
 *   irrelevant — the block passes. That is the shape `screen.mjs` → `rotationRecordBlock` files on
 *   every run where the selection was null (`--no-rotation`, a run that scores nothing, a run that
 *   stopped before Stage 2 chose): `order: []` beside `windowCap: null`. A reader walking committed
 *   records uniformly must not be told those correct runs failed — absence is not a failure, the
 *   same discipline one function over.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifySelection(block, max, expected) {
  /** @type {string[]} */
  const problems = [];
  const order = [...block.order];

  for (let i = 1; i < order.length; i += 1) {
    const prev = /** @type {RotationRow} */ (order[i - 1]);
    const here = /** @type {RotationRow} */ (order[i]);
    if (compareRotationRows(prev, here) > 0) {
      problems.push(
        `order is not new-ground-first, least-recently-scored breaking ties, at position ${i}: ` +
          `${prev.wallet} (${prev.lastScoredAtIso ?? 'never scored'}, ` +
          `${statedGround(prev) ?? 'no flow term'}) before ${here.wallet} ` +
          `(${here.lastScoredAtIso ?? 'never scored'}, ${statedGround(here) ?? 'no flow term'})`,
      );
    }
  }

  if (expected !== undefined && order.length > 0) {
    if (!Number.isFinite(expected.windowCap) || expected.windowCap <= 0) {
      problems.push(
        `cannot re-derive the flow term: the window cap handed in is ${String(expected.windowCap)}, ` +
          'which is not a positive number of launches — a pre-399a record carries none, and a ' +
          'schema-23 record whose selection was null records it as null. Omit `expected` to check ' +
          'the order alone rather than reading an unusable cap as a cap of zero, which would report ' +
          'every row as having stated a key its own inputs do not give',
      );
    } else {
      for (const row of order) {
        const want = newGroundWindows(row, expected);
        if (statedGround(row) !== want) {
          problems.push(
            `${row.wallet} states newGroundWindows ${String(row.newGroundWindows)}; its own ` +
              `launchesPerDay ${String(row.launchesPerDay)} and lastScoredAtIso ` +
              `${row.lastScoredAtIso ?? 'never scored'} give ${want} at a window cap of ` +
              `${expected.windowCap}`,
          );
        }
      }
    }
  }

  const take = Math.max(0, Math.min(max, order.length));
  const expectedSelected = order.slice(0, take).map((r) => r.wallet);
  const expectedDeferred = order.slice(take).map((r) => r.wallet);
  if (!sameList(block.selected, expectedSelected)) {
    problems.push(
      `selected is not the first ${take} of order — recorded [${block.selected.join(', ')}], ` +
        `the rule gives [${expectedSelected.join(', ')}]`,
    );
  }
  if (!sameList(block.deferred, expectedDeferred)) {
    problems.push(
      `deferred is not the remainder of order — recorded [${block.deferred.join(', ')}], ` +
        `the rule gives [${expectedDeferred.join(', ')}]`,
    );
  }
  if (new Set(order.map((r) => r.wallet)).size !== order.length) {
    problems.push('order names the same wallet more than once');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Fold committed screen run records into the rotation.
 *
 * Offline and free, and run on **every** invocation rather than once at bootstrap — the same
 * discipline `ledger.mjs` → `importRunRecords` applies to the feed's memory, and for the same
 * reason: a lost or hand-deleted state file then degrades to a slower rotation instead of to a
 * wrong one. A candidate carrying an `entry` block is one Stage 2 spent its cap on, and the run's
 * own `startedAtIso` is when.
 *
 * **It only ADDS.** A wallet the state already knows is left exactly as it is, because a run record
 * and the state file are two accounts of the same event and merging them would double-count
 * `timesScored` on every invocation. Shape is read defensively rather than assumed: the committed
 * records span schema 1 (no `schemaVersion` field at all) to 19, and this has to keep working
 * across the next bump without a migration.
 *
 * @param {Rotation} rotation
 * @param {readonly { file: string, body: unknown }[]} records
 * @returns {{ imported: number }} Wallets this call ADDED.
 */
export function importScoredFromRunRecords(rotation, records) {
  let imported = 0;
  for (const { body } of records) {
    if (typeof body !== 'object' || body === null) continue;
    const rec = /** @type {Record<string, unknown>} */ (body);
    const startedAtIso = canonicalInstant(rec['startedAtIso']);
    if (startedAtIso === null) continue;
    const candidates = rec['candidates'];
    if (!Array.isArray(candidates)) continue;

    for (const raw of candidates) {
      if (typeof raw !== 'object' || raw === null) continue;
      const row = /** @type {Record<string, unknown>} */ (raw);
      const wallet = row['wallet'];
      // `entry: null` is a candidate Stage 2 produced no score for — it did not clear the gate,
      // `--no-stage2` was passed, or the cap dropped it. None of those spent the cap on it.
      if (typeof wallet !== 'string' || wallet.length === 0) continue;
      if (typeof row['entry'] !== 'object' || row['entry'] === null) continue;
      if (rotation.wallets[wallet] !== undefined) continue;
      rotation.wallets[wallet] = {
        wallet,
        firstScoredAtIso: startedAtIso,
        lastScoredAtIso: startedAtIso,
        timesScored: 1,
        origin: 'run-record',
      };
      imported += 1;
    }
  }
  return { imported };
}

/**
 * The exact bytes a rotation state is persisted as.
 *
 * Separate from writing them because the run record carries this file's digest, so the text has to
 * exist before the record is assembled and be the same text that lands on disk. Two serialisations
 * would put a digest in the record that names bytes nobody wrote.
 *
 * Wallet keys are sorted so two runs over the same state produce a byte-identical file — the state
 * is committed, and a diff that reorders every line hides the seven that changed.
 *
 * @param {Rotation} rotation
 * @param {string} nowIso
 * @returns {string}
 */
export function serialiseRotation(rotation, nowIso) {
  /** @type {Record<string, RotationEntry>} */
  const sorted = {};
  for (const wallet of Object.keys(rotation.wallets).sort()) {
    const entry = rotation.wallets[wallet];
    if (entry !== undefined) sorted[wallet] = entry;
  }
  return `${JSON.stringify(
    {
      tool: 'deployer-screen-stage2-rotation',
      schemaVersion: ROTATION_SCHEMA_VERSION,
      updatedAtIso: nowIso,
      reproducibility: REPRODUCIBILITY_RULE,
      wallets: sorted,
    },
    null,
    2,
  )}\n`;
}

/**
 * @param {string} path
 * @param {string} text The output of {@link serialiseRotation}, already digested into the record.
 */
export function saveRotationText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * The digest a run record names its state by.
 *
 * Prefixed with the algorithm because an unlabelled hex string in a record is a value nobody can
 * re-derive without guessing which function produced it.
 *
 * @param {string} text
 * @returns {string}
 */
export function digestOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
