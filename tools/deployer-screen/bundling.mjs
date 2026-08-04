/**
 * THE BUNDLING CENSUS — a windows-only pass that walks create-slot windows and reports **only**
 * what the co-ordination rule could see in each one. Captain decisions 173a and 183a, 2026-08-03.
 *
 * ## The question, and why it needed its own pass
 *
 * When this pass ran, `thresholds.json` → `stage2_entry` pinned `maxLaunchesPerCandidate: 8` and
 * `minLaunchesSampled: 8`, **deliberately equal** — a candidate was either scored on a full sample
 * or reported UNMEASURED. Since #17 a launch whose create slot the co-ordination rule marks nothing
 * in is refused as unproven (`measure.mjs` → `roomIsProven`, captain decision 134a). Those two
 * facts multiplied: **Stage 2 could only reach a verdict for a candidate whose most recent 8
 * eligible launches were EVERY ONE marked, and one unmarked launch in eight silenced the whole
 * candidate.** That was arithmetic, not observation.
 *
 * **THAT PREMISE HAS SINCE MOVED, AND THIS PASS HAS NOT BEEN RE-RUN UNDER IT.** Captain decision
 * 190a (2026-08-04) raised the cap to 10 against the same floor of 8, so the live rule is 8 proven
 * of 10 planned and this census's all-of-8 headline is **stricter than what Stage 2 requires** — it
 * understates how many candidates are scoreable, which is the safe direction for a finding of this
 * shape. A census record is never retro-edited; re-running it under the new cap is a separate
 * decision.
 *
 * **A re-run would follow the cap but NOT the rule, and that is deliberate here.** This file re-pins
 * no window parameter, so a re-run would plan the 10 launches Stage 2 plans — but {@link fullSample}
 * would still demand 10 of 10 proven, where Stage 2 requires only 8 proven of 10 planned. The launch
 * COUNT follows `maxLaunchesPerCandidate`; the PREDICATE does not follow `minLaunchesSampled`. So the
 * census's headline stays **stricter than the live scoreability rule**, which understates how many
 * candidates are scoreable — the safe direction for a finding of this shape. Reconciling the two is
 * a separate decision this lane does not take.
 *
 * ## The predicate this pass measures under, which has moved once
 *
 * The first run (173a, `census/2026-08-03-bundling-census.md` as first committed) measured under the
 * **shared-transaction half alone** — `bundledTx >= 1` — because that was the shipped predicate on
 * the day. Captain decision 182a then widened `roomIsProven` to the **UNION** of that half and the
 * deployer-anchored contiguous block-index run, and captain decision 183a ordered this pass re-run
 * under it, reporting `runTx` alongside `bundledTx` so the two halves stay readable apart.
 *
 * **This file now tracks `measure.mjs` → `roomIsProven` rather than carrying its own copy of the
 * rule**, which is the whole point: a census whose predicate can drift from the screen's stops being
 * a statement about the screen. {@link LaunchBundling} reports both halves per launch, so a reader
 * can recover the older reading from the new record without re-running anything.
 *
 * What was *not* known is how large a population that silences. The live evidence was **two
 * strangers** (`data/slot-zero-stage2-reverify/report.md` §2a): one lost 4 of 8 windows, one lost
 * 8 of 8 with `maxWalletsInOneTx == 1` at min, median and max — a deployer that never bundles and
 * therefore can never be scored, however often it is screened. Two of two is a signal and it is not
 * a rate. This pass turns it into one.
 *
 * The Stage 2 scoring cap is 3 (`maxCandidatesScored`), which is why the reverification could not
 * answer this itself. **This pass does not raise that cap and does not touch it**: it is not
 * Stage 2. It runs no entry scoring, computes no room figure, prices no entry cost, reaches no
 * verdict and produces no number that could be read as one. It walks the same windows Stage 2 would
 * walk, with the same pinned window parameters, and reports six measures per launch — `bundledTx`,
 * `runTx`, `adjacencyMarks`, `coordinatedWallets`, `maxWalletsInOneTx` and `createSlotWallets` —
 * plus the two flags (`bundled`, `proven`) those measures decide.
 *
 * **It measures; it does not tune.** No threshold moves on the strength of what it finds — the
 * pinning decision returns to the captain with the number.
 *
 * ## It spends NO keyed request, and that is structural rather than careful
 *
 * Stage 2 gets its launch list from the MadeOnSol profile Stage 1 already paid for. This pass has no
 * Stage 1, so it needs a keyless route to both halves of the population:
 *
 * - **Which wallets** — the cohort is read from this repository's own committed records
 *   ({@link buildCohort}): the feed ledger and every saved screen run. Those wallets were surfaced
 *   and graded by runs whose keyed allowance is already spent, so re-reading them costs nothing.
 *   **This pass's own record therefore lives in `census/`, never in `runs/`**, for two reasons that
 *   both matter: `runs/` is the SCREEN's versioned contract and `test/deployer-screen.test.ts`
 *   asserts every file there against `RECORD_SCHEMA_VERSION`'s key set, which this record is not;
 *   and a census record dropped into `runs/` would be read back by {@link buildCohort} as a cohort
 *   source, making the next run's population depend on the last one's.
 * - **Which launches** — `pumpfun.mjs` → `readCreatorHistory` on `frontend-api-v3.pump.fun`, the
 *   keyless ownership listing the gate already merges against and the `--consistency` pass already
 *   walks. It carries `created_timestamp` and `complete` per row, which is exactly what
 *   `measureCompletion` needs and exactly what `toLaunchRefs` would have taken from the profile.
 *
 * So the gate applied here is the **ownership** reading, and its bias is the one `FEED.md` states:
 * ownership understates a wallet's launches and understates its bonded count by more, so it is
 * **biased towards rejection**. A cohort member that fails this gate is `gate-failed` on a
 * conservative reading, not proven incompetent, and a survivor of it is a survivor on the harder of
 * the two readings. That direction is the safe one for this measurement: the surveyed population is
 * a subset of what a keyed Stage 1 would have passed, not a superset.
 *
 * ## The two contaminations the ownership launch list carries, stated rather than hidden
 *
 * `README.md` → "Which history the gate counts" owns the general form; two specific consequences
 * bind a bundling number built on it:
 *
 * - **A listed token was not necessarily created by the listed wallet.** Ownership moves, so an
 *   acquired token's create slot is somebody else's bundling habit counted against this wallet.
 *   Measured size of the whole ownership-vs-creation gap so far: **nil** — five wallets have both
 *   readings, four gaps of exactly zero and one of 1 launch in 239
 *   (`CREATION-DERIVED.md`). It is a limit on the reading, not a known error in it.
 * - **A handed-on token is missing, and the ones handed on are the winners.** So the sample skews
 *   towards launches the operator kept. Nothing here can correct that; it is reported.
 *
 * Neither contamination is repaired by spending a keyed request — the profile is an ownership
 * reading too. Only the creation-derived walk separates them, and it costs ~100 keyless RPC or
 * Helius credits per candidate, which this pass does not carry (the same bound `FEED.md` states
 * for the feed, for the same reason).
 *
 * ## Bounds, declared before the code
 *
 * | bound | where | value |
 * |---|---|---|
 * | keyed requests | — | **0. There is no keyed client in this file.** |
 * | cohort wallets gated | `thresholds.json` → `bundling_census.maxCohortSize` | 120 |
 * | listing pages per wallet | `bundling_census.maxListingPagesPerCandidate` | 4 |
 * | listing requests, whole run | `bundling_census.maxListingRequests` | 480 |
 * | candidates surveyed | `bundling_census.maxCandidatesSurveyed` | 30 |
 * | launches per candidate | `stage2_entry.maxLaunchesPerCandidate`, **reused** | 10 |
 * | requests per launch | `stage2_entry.maxRequestsPerLaunch`, **reused** | 18 |
 * | fill requests, whole run | `bundling_census.maxKeylessRequests` | 5400 |
 * | pacing, listing host | `budget.keylessMinIntervalMs`, **reused** | 2s |
 * | pacing, fill host | `stage2_entry.keylessMinIntervalMs`, **reused** | 7s |
 *
 * **Every window parameter is Stage 2's own, read from `stage2_entry` rather than re-pinned here.**
 * A second copy of `windowMs` or `windowSlotSpan` would let the census measure a window Stage 2 does
 * not, and the whole point of the number is that it describes the launches Stage 2 refuses. The
 * block this file adds pins only what is genuinely new: how many wallets it may read and how many
 * requests the two legs may spend.
 *
 * `30 × 10 × 18 = 5,400` — the declared worst case and the fill ceiling are the same number, so the
 * dry run's plan is the whole exposure, exactly as `stage2.mjs` arranges it. A launch is started
 * only when a full per-launch cap of headroom remains.
 *
 * ## The `readLaunchWindow` bound-mismatch is CLOSED — and this pass inherited its PRICE
 *
 * `pumpfun.mjs` → `readLaunchWindow` used to seek in milliseconds and decide membership in slots
 * with nothing between the two units but a nominal 400 ms/slot, so at 2026 slot times it could fail
 * to fetch the **tail** of a window. Captain decision 144a closed it: the seek is now derived from
 * `windowSlotSpan` in the span's own unit at a measured worst-case slot rate — `pumpfun.mjs` →
 * {@link windowReachMs}, **85,000 ms at the pinned values against the 65,000 ms it replaced**.
 *
 * It never reached this pass's measures in either state, and that is still worth stating so nobody
 * re-derives it: this pass reads the **create slot** — the oldest end of the walk, reached last and
 * proved by the coverage obligation — so a missing tail could not move any measure on the launch
 * row. That covers `runTx`, `adjacencyMarks` and `coordinatedWallets` as well as `bundledTx` and
 * `maxWalletsInOneTx`: every one of them is computed from create-slot fills alone, and fills the
 * walk never fetched are all NEWER than the create slot.
 *
 * **WHAT IT DID CHANGE IS WHAT A RE-RUN COSTS, AND WHOEVER RE-RUNS THIS MUST SIZE FOR IT.** The
 * wider reach buys about a fifth more pages per launch; `pumpfun.mjs` → {@link windowReachMs} owns
 * that distribution, the population it was measured over and the drop rate it implies, and this file
 * quotes it rather than keeping a copy. Two consequences land here. (1) `census/2026-08-03-bundling-census.md`
 * was walked at the superseded 65,000 ms reach, so its recorded SPEND is an underestimate of what
 * re-running the same census costs — its measures are unaffected, per the paragraph above. (2) The
 * `maxRequestsPerLaunch` cap this pass reuses from Stage 2 did not move, so the busiest launches now
 * exhaust it and arrive as `request-cap` drops. Here that is {@link DROPPED_WINDOW_CAVEAT} rather
 * than a wrong number — counted, denominator-shrinking, never read as an unbundled window — but it
 * biases the surviving denominator towards the QUIETER launches, which is a new sampling caveat on
 * any rate this pass publishes and not merely a bigger bill.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CeilingReached } from './client.mjs';
import { measureCompletion, measureCreateSlot, median, percentile, roomIsProven } from './measure.mjs';
// `windowReachMs` is IMPORTED, never re-derived: the dry run below prints the reach and the cost of
// the walk it authorises, and a plan that keeps its own copy of the walk's arithmetic is a plan that
// drifts from the walk. Captain decision 144a moved the reach and left both operator-facing plans
// quoting the old walk — `render.mjs`, caught in PR #38's own review, and this one. See
// {@link MEASURED_PAGE_COST}.
import { KeylessClient, readCreatorHistory, readLaunchWindow, windowReachMs } from './pumpfun.mjs';
import { applyGate, verdictFor } from './rank.mjs';
import { measureSubjectLaunches } from './stage0.mjs';
import { describeTransportFailure } from './stage2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_DATA_DIR = join(REPO_ROOT, 'data', 'population-tape-2026-07-29');

/**
 * The one caveat that must travel with every number this pass produces, into the printed report,
 * the record and the summary line — not only into this file's header.
 *
 * The same requirement `entry.mjs` → `LANDING_TIP_CAVEAT` carries, for the same reason: a limit
 * documented only in prose is a limit the next reader of the CSV does not have.
 */
export const OWNERSHIP_LIST_CAVEAT =
  'THE LAUNCH LIST IS THE OWNERSHIP READING, not a creation-derived one: a listed token may have ' +
  'been acquired rather than created by this wallet (its create slot is then somebody else\'s ' +
  'bundling habit), and a token handed on is missing entirely — and the ones handed on are the ' +
  'winners. The measured size of that gap on the five wallets holding both readings is nil ' +
  '(four gaps of exactly zero, one of 1 launch in 239; CREATION-DERIVED.md), which bounds it ' +
  'without removing it.';

/**
 * The second standing caveat: what this pass is a census OF.
 *
 * The rate is per LAUNCH-WINDOW-AS-WALKED, and a window that could not be walked back to its own
 * create slot is dropped rather than counted as unbundled — otherwise every busy launch would read
 * as a deployer that does not bundle, which is the exact direction that would overstate the problem
 * this pass exists to size.
 */
export const DROPPED_WINDOW_CAVEAT =
  'A window that could not be walked back past the mint is DROPPED, never counted as unbundled. ' +
  'Counting an unreachable create slot as "no bundle" would manufacture the very finding this pass ' +
  'is measuring, so the denominator is windows PROVED to reach their create slot.';

/**
 * The fourth standing caveat, and the one this re-run exists to make impossible to lose: WHICH
 * PREDICATE produced the number.
 *
 * The census has now been taken under two different co-ordination rules. Its first run measured the
 * shared-transaction half alone; this one measures the union that `measure.mjs` → `roomIsProven`
 * actually applies. Every rate on this page is a statement about a rule, not about deployers, and a
 * rate quoted without its rule is the same failure as a fraction quoted without its denominator.
 */
export const PREDICATE_CAVEAT =
  'THE PREDICATE IS THE UNION (captain decision 182a): a launch is PROVEN when measure.mjs -> ' +
  'roomIsProven marks at least one non-deployer wallet, by the shared-transaction rule OR by the ' +
  'deployer-anchored contiguous block-index run. The FIRST run of this census (173a) measured the ' +
  'shared-transaction half ALONE, so every figure in that superseded record is a LOWER bound on ' +
  'what the screen can now prove. Both halves are reported per launch (bundledTx, runTx) so the ' +
  'older reading is recoverable from this record without re-walking anything. WHAT IT MEASURES IS ' +
  'STILL THE RULE, NOT THE DEPLOYERS: an unproven launch means the rule saw nothing, which is ' +
  'observationally identical to there being nothing to see.';

/**
 * The third standing caveat: the two vendors' clocks do not agree to the millisecond, and this pass
 * backdates the mint instant rather than losing a create slot to that.
 *
 * MEASURED ON THIS ROUTE (`thresholds.json` → `bundling_census.justification.mintTimeBackdateMs`
 * holds the sample): `frontend-api-v3`'s `created_timestamp` carries millisecond precision on older
 * listing rows while `swap-api`'s fill `ts` is whole seconds and floored, so the declared mint lands
 * up to two seconds AFTER the launch's own first fill — the exact direction `readLaunchWindow`'s
 * zero-slack pre-mint tripwire deletes a whole launch for. The first live run measured it firing on
 * 5 of 8 launches of the first candidate walked.
 *
 * Backdating cannot reach the number: the create slot is the OLDEST end of the walk, so a wider
 * floor admits more of this launch and nothing of any other — a token has no fill before its own
 * create transaction. What it costs is that a genuine disagreement under 5 s is no longer seen.
 *
 * IT IS NOT A ONE-ENDED WIDENING, AND ANYTHING COPYING IT MUST KNOW THAT. `readLaunchWindow` seeks
 * at `createdAtMs` plus `pumpfun.mjs` → {@link windowReachMs}, so a backdated `createdAtMs` also
 * pulls the NEWEST instant the walk reaches 5 s earlier. What that costs has changed with captain
 * decision 144a and the arithmetic is worth having in front of you: the reach is 85,000 ms at the
 * pinned values — `windowSlotSpan × MAX_MS_PER_SLOT` (160 × 500 = 80,000) plus `seekMarginMs`
 * (5,000) — so backdating by 5,000 spends the WHOLE of `seekMarginMs` and leaves the walk reaching
 * exactly the 80,000 ms the span is worth at the pinned worst-case slot rate, with no clock slack
 * left over (8,552 ms of headroom survives against the 71,448 ms the span is worth at the MEASURED
 * 446.55 ms/slot maximum, which is the margin actually in hand today). Before 144a the seek was
 * `createdAtMs + windowMs + seekMarginMs` and the same backdating reinstated outright tail
 * truncation. It is safe in THIS pass either way because the tail is not read here; in a full-window
 * walk it spends the margin that exists to stop an early vendor mint time cutting the tail off.
 */
export const MINT_TIME_BACKDATE_CAVEAT =
  'THE MINT INSTANT IS BACKDATED BY A PINNED MARGIN before the window is walked, because the two ' +
  'vendors disagree: frontend-api-v3 gives millisecond-precision creation times on older rows while ' +
  'swap-api gives whole-second fill times, floored, so the declared mint lands up to ~2s AFTER the ' +
  'launch\'s own first fill and the zero-slack pre-mint tripwire would delete the whole launch. ' +
  'A disagreement LARGER than the margin still drops the launch and is still counted; one SMALLER ' +
  'than it is no longer detected.';

/**
 * The per-launch page cost the dry-run plan quotes, and **the reach it was measured at**.
 *
 * `pumpfun.mjs` → {@link windowReachMs} OWNS this measurement, its population and the drop rate it
 * implies; this pass does not carry a second copy of the distribution and must not grow one. What it
 * carries is the reach that distribution belongs to, so {@link renderDryRun} can CHECK the figure
 * against the walk it is about to authorise rather than assert it: if the reach ever moves off
 * `atReachMs`, the plan says the cost is unknown instead of printing a number measured somewhere
 * else. A quoted figure that cannot invalidate itself is exactly what went stale here — this plan
 * went on printing `p50 4 / p90 8 pages` after captain decision 144a widened the reach from
 * `supersededReachMs` to `atReachMs`, and a dry run is what an operator reads to authorise a run.
 *
 * `p50Requests` is `p50Pages` at the ~1.33 requests a page costs against this host's measured ~25%
 * shed rate (`thresholds.json` → `stage2_entry.justification.maxRequestsPerLaunch`), because the
 * pacing this plan multiplies by is per REQUEST and quoting pages there under-reads the wall clock
 * by a third. `supersededP50Pages` is the same owner's before-reading and is here for one job: the
 * plan derives the rise from the two rather than describing it.
 */
const MEASURED_PAGE_COST = Object.freeze({
  atReachMs: 85_000,
  p50Pages: 6,
  p50Requests: 8,
  supersededReachMs: 65_000,
  supersededP50Pages: 5,
});

/** @typedef {{ wallet: string, sources: string[], recordedGateVerdict: string | null }} CohortMember */

/**
 * Read the cohort out of this repository's own committed records.
 *
 * Two sources, unioned by wallet and sorted so a run is reproducible byte for byte:
 *
 * - `feed/ledger.json` — every wallet the discovery feed has ever surfaced, with the verdict it
 *   graded them on. `queued` means gate-passed and never screened; `held` means gate-failed on the
 *   ownership reading, which `FEED.md` is explicit is a **triage** outcome rather than a rejection.
 * - `runs/*.json` — every candidate of every saved screen run, with its recorded verdict.
 *
 * **Every cohort member is re-gated by this pass rather than trusted**, because the two sources
 * graded on readings taken days apart and on a keyed surface this pass does not hold. The recorded
 * verdict is carried alongside so a reader can see where the two disagree, and it decides nothing.
 *
 * @param {string} [toolDir]
 * @returns {CohortMember[]}
 */
export function buildCohort(toolDir = HERE) {
  /** @type {Map<string, CohortMember>} */
  const seen = new Map();

  /** @param {string} wallet @param {string} source @param {string | null} verdict */
  const add = (wallet, source, verdict) => {
    if (typeof wallet !== 'string' || wallet === '') return;
    const prior = seen.get(wallet);
    if (prior === undefined) {
      seen.set(wallet, { wallet, sources: [source], recordedGateVerdict: verdict });
      return;
    }
    if (!prior.sources.includes(source)) prior.sources.push(source);
    // A recorded pass anywhere is what a reader wants to see beside a fresh reading, so it wins
    // over an older fail. It still decides nothing here.
    if (verdict === 'gate-passed') prior.recordedGateVerdict = 'gate-passed';
    else prior.recordedGateVerdict ??= verdict;
  };

  try {
    const ledger = JSON.parse(readFileSync(join(toolDir, 'feed', 'ledger.json'), 'utf8'));
    const wallets = ledger?.['wallets'];
    if (typeof wallets === 'object' && wallets !== null) {
      for (const row of Object.values(/** @type {Record<string, any>} */ (wallets))) {
        add(row?.['wallet'], `ledger:${row?.['state'] ?? 'unknown'}`, row?.['gateVerdict'] ?? null);
      }
    }
  } catch {
    // A missing ledger is a smaller cohort, not a failure: the run records alone are a valid cohort
    // and the record reports what the cohort was built from.
  }

  const runsDir = join(toolDir, 'runs');
  /** @type {string[]} */
  let runFiles = [];
  try {
    runFiles = readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    runFiles = [];
  }
  for (const file of runFiles) {
    try {
      const record = JSON.parse(readFileSync(join(runsDir, file), 'utf8'));
      for (const c of record?.['candidates'] ?? []) add(c?.['wallet'], `run:${file}`, c?.['verdict'] ?? null);
    } catch {
      // Same rule: an unreadable run record shrinks the cohort visibly rather than aborting.
    }
  }

  return [...seen.values()].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
}

/**
 * @typedef {object} LaunchBundling
 * @property {number} ageDays          Age of the launch at the moment the walk decided eligibility.
 *   An AGE and not an instant, the same containment `stage2.mjs` applies to `youngestRefAgeMs`: a
 *   wallet plus a timestamp identifies a launch, and no per-token row may be persisted.
 * @property {number} bundledTx        Create-slot transactions carrying 2+ distinct wallets.
 * @property {number} maxWalletsInOneTx Largest wallet count in a single create-slot transaction.
 * @property {number} runTx           Transactions in the DEPLOYER-ANCHORED CONTIGUOUS BLOCK-INDEX
 *   RUN, the anchor itself included — half (b) of the co-ordination rule. `1` means the deployer's
 *   own transaction sat alone between two gaps and half (b) marked nothing; `0` means no run could
 *   be read at all, which is what a `sid` whose format has moved looks like. Reported alongside
 *   `bundledTx` on captain decision 183a's instruction, so the two halves stay readable apart and
 *   the superseded shared-transaction-only reading is recoverable from this record.
 * @property {number} adjacencyMarks  Wallets half (b) marked that half (a) did NOT. The size of what
 *   the union added on this launch — the only observable that separates the two halves after the
 *   fact, and the one that turns "5 of 11" into a rate.
 * @property {number} coordinatedWallets The UNION's evidence count: distinct non-deployer wallets
 *   marked by either half. This is exactly what `roomIsProven` reads.
 * @property {number} createSlotWallets Distinct wallets in the create slot at all — the context that
 *   separates "a quiet create slot" from "a busy one the rule saw nothing in".
 * @property {boolean} bundled        `bundledTx >= 1` — the SHARED-TRANSACTION half on its own, the
 *   predicate the FIRST run of this census was taken under (captain decision 173a). Kept, and kept
 *   named for what it is, so the superseded record's figures can be compared against this one
 *   without re-walking a window. It is **not** what the screen scores on.
 * @property {boolean} proven         `measure.mjs` → `roomIsProven` — the UNION, and what the screen
 *   actually refuses a launch on since captain decision 182a. **This field tracks that function
 *   rather than restating it**: a census carrying its own copy of the rule can drift from the screen
 *   it is a finding about, which is how the first run's numbers came to need a caveat.
 *
 *   `bundled` implies `proven` by construction — half (a)'s marked set is a subset of the union's —
 *   so `proven && !bundled` is exactly the population decision 183a was sizing.
 */

/**
 * @typedef {object} CandidateGate
 * This pass's own gate reading, taken keylessly off the ownership listing with the PINNED
 * `stage1_gate` thresholds. Carried into the record so a reader can see what the census admitted
 * and on which reading — and can compare it against `recordedGateVerdict`, which is what this
 * repository's own keyed runs concluded about the same wallet.
 * @property {string} gateVerdict      This pass's own keyless ownership-reading verdict.
 * @property {number} listingRows
 * @property {boolean} listingPageCapped
 * @property {number} gateTokens
 * @property {number} gateCompletionRate
 * @property {number} gateSpanDays
 */

/**
 * @typedef {object} CandidateIdentity
 * @property {string} wallet
 * @property {string[]} cohortSources Which committed record(s) offered this wallet.
 * @property {string | null} recordedGateVerdict What this repository's own keyed runs concluded.
 *   Carried for comparison and it decides nothing — see {@link buildCohort}.
 */

/**
 * @typedef {object} BundlingWalk
 * @property {number} launchesEligible
 * @property {number} launchesPlanned
 * @property {number} launchesAttempted
 * @property {number} launchesUsable   Windows walked back past the mint. **The denominator.**
 * @property {number} launchesDropped
 * @property {Record<string, number>} dropsByReason Drops BY CAUSE. `mint-time-disagreement` is the
 *   one that matters: it says the two vendors' clocks came apart by more than the backdate, which is
 *   a reportable event rather than a busy launch. See {@link MINT_TIME_BACKDATE_CAVEAT}.
 * @property {string[]} dropNotes
 * @property {number} provenLaunches   Windows the UNION proved — what Stage 2 would score.
 * @property {number} bundledLaunches  Windows the SHARED-TRANSACTION half alone proved. A subset of
 *   `provenLaunches` by construction, kept so the first run's reading survives in this record.
 * @property {boolean} fullSample      `launchesUsable === launchesPlanned === the Stage 2 cap`.
 * @property {boolean | null} allProven `null` unless `fullSample` — the headline is only defined
 *   over a candidate that actually produced the full sample Stage 2 requires. THE HEADLINE FIELD.
 * @property {boolean | null} allBundled The same question under the superseded shared-transaction
 *   half, for comparison with the first run. Decides nothing.
 * @property {boolean} neverProven     Every usable window had `coordinatedWallets === 0`: NEITHER
 *   half of the rule saw anything, on any window. Permanently unscoreable rather than unlucky, and
 *   the successor to `neverBundles` as the count that means it.
 * @property {boolean} neverBundles    Every usable window had `maxWalletsInOneTx <= 1` — the first
 *   run's `neverBundles`, unchanged in meaning so the two records compare. Under the union this is
 *   no longer a claim of permanent unscoreability: 5 of the first run's 11 were later shown to carry
 *   a deployer-anchored run.
 * @property {LaunchBundling[]} launches
 */

/**
 * One row of the census: who the wallet is, what gate reading admitted it, and what its windows
 * showed. Assembled as an intersection so each half is defined exactly once and the walk half is
 * what {@link censusCandidate} returns on its own.
 *
 * @typedef {CandidateIdentity & CandidateGate & BundlingWalk} CandidateBundling
 */

/**
 * Walk one candidate's most recent eligible launches and report only their bundling.
 *
 * The eligibility gate, the window parameters and the per-launch request cap are Stage 2's own
 * (`stage2.mjs` → `scoreCandidateEntry`), reused so that "the launches Stage 2 would have scored"
 * and "the launches this pass measured" are the same set. The one thing that is deliberately NOT
 * reused is the scoring: `measureCreateSlot` is called instead of `measureLaunchEntry`, so no room
 * figure, no field and no P&L is computed at all.
 *
 * @param {KeylessClient} client
 * @param {object} input
 * @param {readonly { mint: string, deployedAtMs: number }[]} input.refs Newest first.
 * @param {number} input.nowMs
 * @param {import('./stage2.mjs').Stage2Thresholds} input.entry
 * @param {number} input.mintTimeBackdateMs `thresholds.json` → `bundling_census`. See
 *   {@link MINT_TIME_BACKDATE_CAVEAT}: the two vendors' clocks disagree by up to ~2s in the one
 *   direction that deletes a create slot, and this is what makes that survivable.
 * @param {(line: string) => void} [input.log]
 * @returns {Promise<BundlingWalk>}
 */
export async function censusCandidate(client, input) {
  const t = input.entry;
  const minAgeMs = t.windowMs + t.seekMarginMs;
  const eligible = input.refs.filter((r) => input.nowMs - r.deployedAtMs >= minAgeMs);
  const planned = eligible.slice(0, t.maxLaunchesPerCandidate);

  /** @type {LaunchBundling[]} */
  const launches = [];
  /** @type {string[]} */
  const dropNotes = [];
  // Broken out BY CAUSE, never as a lump, for the reason `stage2.mjs` gives: a `mint-time-disagreement`
  // says the two clocks have come apart and is a reportable event, while a `request-cap` just says
  // the launch was busy. A total cannot be read for either.
  /** @type {Record<string, number>} */
  const dropsByReason = {};
  let attempted = 0;
  let dropped = 0;

  for (const ref of planned) {
    // The same reservation rule `stage2.mjs` applies: never start a walk that cannot be finished,
    // because a half-walked window is unusable by construction and the requests are spent anyway.
    if (client.remaining() < t.maxRequestsPerLaunch) {
      dropNotes.push(
        `stopped before ${planned.length - attempted} further launch(es): fewer than ` +
          `${t.maxRequestsPerLaunch} request(s) of the census ceiling remain`,
      );
      break;
    }
    attempted += 1;

    /** @type {import('./pumpfun.mjs').LaunchWindow} */
    let window;
    try {
      window = await readLaunchWindow(client, {
        mint: ref.mint,
        // BACKDATED. Not the declared instant — see `MINT_TIME_BACKDATE_CAVEAT`. At the OLD end it
        // widens the walk, which is the end the create slot sits at, so it can only admit more of
        // this launch's own opening and never any of another token's — a token has no fill before
        // its own create transaction. BUT IT MOVES THE NEW END TOO, AND A COPY OF THIS LINE INTO A
        // FULL-WINDOW WALK IS A BUG: `readLaunchWindow` seeks at `createdAtMs` plus
        // `windowReachMs`, so backdating by 5,000 ms pulls the newest instant reached 5 s earlier
        // and spends the whole of the pinned `seekMarginMs` of 5,000 — leaving the reach exactly
        // equal to the span at the pinned worst-case slot rate, with no clock slack left. Harmless
        // HERE only because this pass reads the create slot and nothing else.
        createdAtMs: ref.deployedAtMs - input.mintTimeBackdateMs,
        windowMs: t.windowMs,
        seekMarginMs: t.seekMarginMs,
        windowSlotSpan: t.windowSlotSpan,
        maxRequests: t.maxRequestsPerLaunch,
        pageLimit: t.tradePageLimit,
      });
    } catch (cause) {
      if (cause instanceof CeilingReached) {
        dropped += 1;
        dropsByReason['census-ceiling'] = (dropsByReason['census-ceiling'] ?? 0) + 1;
        dropNotes.push('the census request ceiling was reached mid-walk');
        break;
      }
      dropped += 1;
      dropsByReason['transport-error'] = (dropsByReason['transport-error'] ?? 0) + 1;
      dropNotes.push(`DROPPED (transport error): ${describeTransportFailure(cause)}`);
      continue;
    }

    if (!window.usable) {
      dropped += 1;
      if (window.dropReason !== null) dropsByReason[window.dropReason] = (dropsByReason[window.dropReason] ?? 0) + 1;
      dropNotes.push(window.note);
      input.log?.(`    ${window.note}`);
      continue;
    }

    const measurement = measureCreateSlot(window.fills);
    if (measurement === null) {
      dropped += 1;
      dropsByReason['no-create-slot'] = (dropsByReason['no-create-slot'] ?? 0) + 1;
      dropNotes.push('DROPPED: no bonding-curve buy in the window, so there is no create slot to read');
      continue;
    }

    // Distinct wallets in the create slot, recomputed here rather than taken off the measurement,
    // because `CreateSlotMeasurement` reports co-ordinated and independent counts and the deployer
    // is in neither. It is context for a zero: a create slot of one wallet cannot bundle.
    const createSlotWallets = new Set(
      window.fills.filter((f) => f.slot === measurement.slot).map((f) => f.wallet),
    ).size;

    launches.push({
      ageDays: Number(((input.nowMs - ref.deployedAtMs) / 86_400_000).toFixed(3)),
      bundledTx: measurement.bundledTx,
      maxWalletsInOneTx: measurement.maxWalletsInOneTx,
      runTx: measurement.runTx,
      adjacencyMarks: measurement.adjacencyMarks,
      coordinatedWallets: measurement.coordinatedWallets,
      createSlotWallets,
      // The superseded half, kept named for what it is so the first run's record still compares.
      bundled: measurement.bundledTx >= 1,
      // CALLED, NOT RESTATED. `roomIsProven` is the screen's own predicate (the union, decision
      // 182a); a census that carried its own copy of the rule could drift away from the pass it is
      // a finding about, which is exactly how the first run's numbers came to need a caveat.
      proven: roomIsProven(measurement),
    });
    input.log?.(
      `    ${window.pages} page(s) / ${window.requests} request(s), ${window.fills.length} fill(s), ` +
        `bundledTx ${measurement.bundledTx}, runTx ${measurement.runTx}, ` +
        `maxWalletsInOneTx ${measurement.maxWalletsInOneTx}, ` +
        `${measurement.coordinatedWallets} co-ordinated (+${measurement.adjacencyMarks} by adjacency), ` +
        `${createSlotWallets} wallet(s) in the create slot`,
    );
  }

  const provenLaunches = launches.filter((l) => l.proven).length;
  const bundledLaunches = launches.filter((l) => l.bundled).length;
  const fullSample = launches.length === t.maxLaunchesPerCandidate;

  return {
    launchesEligible: eligible.length,
    launchesPlanned: planned.length,
    launchesAttempted: attempted,
    launchesUsable: launches.length,
    launchesDropped: dropped,
    dropsByReason,
    dropNotes,
    provenLaunches,
    bundledLaunches,
    fullSample,
    // THE HEADLINE IS ONLY DEFINED OVER A FULL SAMPLE. A candidate that produced 6 usable windows,
    // all proven, is not a candidate Stage 2 would have scored — `minLaunchesSampled` is 8 — so
    // reporting it as "proven on all of them" would answer a different question from the one the
    // pinning decision asks. `null` says the census could not decide it, which is a third state
    // and not a failure.
    allProven: fullSample ? provenLaunches === launches.length : null,
    allBundled: fullSample ? bundledLaunches === launches.length : null,
    // Under the union `roomIsProven` is exactly `coordinatedWallets >= 1`, so this agrees with
    // `provenLaunches === 0` row for row. What the expression buys over it is the `length > 0`
    // guard: a candidate that produced NO usable window has proved nothing either way and must
    // never be counted as permanently unscoreable, which is a claim about what re-screening
    // cannot change.
    neverProven: launches.length > 0 && launches.every((l) => l.coordinatedWallets === 0),
    neverBundles: launches.length > 0 && launches.every((l) => l.maxWalletsInOneTx <= 1),
    launches,
  };
}

/** @param {readonly number[]} values */
function distribution(values) {
  if (values.length === 0) {
    return { n: 0, min: null, p25: null, median: null, p75: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    min: sorted[0] ?? null,
    p25: Number(percentile(sorted, 0.25).toFixed(4)),
    median: Number(median(sorted).toFixed(4)),
    p75: Number(percentile(sorted, 0.75).toFixed(4)),
    max: sorted[sorted.length - 1] ?? null,
  };
}

/**
 * Reduce the per-candidate rows to the four numbers captain decision 173a asked for, plus the
 * denominators every one of them has to be read against.
 *
 * Each rate carries its own `n` in the same object rather than in a sentence beside it. This lane
 * exists because a finding was correctly labelled "n = 2, a signal not a rate"; a summary that
 * separates a fraction from its denominator is how the next reader loses that.
 *
 * @param {readonly CandidateBundling[]} rows
 * @returns {Record<string, any>}
 */
export function summariseCensus(rows) {
  const allLaunches = rows.flatMap((l) => l.launches);
  const provenLaunches = allLaunches.filter((l) => l.proven).length;
  const bundledLaunches = allLaunches.filter((l) => l.bundled).length;
  const withFullSample = rows.filter((r) => r.fullSample);
  const allProven = withFullSample.filter((r) => r.allProven === true);
  const allBundled = withFullSample.filter((r) => r.allBundled === true);
  const surveyed = rows.filter((r) => r.launchesUsable > 0);

  return {
    // (1) the per-launch rate, under BOTH halves — the union is the live number and the
    // shared-transaction half is what the superseded record reported.
    perLaunch: {
      launchesMeasured: allLaunches.length,
      proven: provenLaunches,
      rate: allLaunches.length === 0 ? null : Number((provenLaunches / allLaunches.length).toFixed(4)),
      // The first run's predicate, carried so the two records compare without a re-walk.
      bundledBySharedTxAlone: bundledLaunches,
      sharedTxRate:
        allLaunches.length === 0 ? null : Number((bundledLaunches / allLaunches.length).toFixed(4)),
      // Exactly what the union added. `bundled` implies `proven`, so this subtraction is total.
      provenByAdjacencyOnly: provenLaunches - bundledLaunches,
      candidatesContributing: surveyed.length,
    },
    // (2) the per-candidate distributions
    perCandidate: {
      candidatesWithAnyWindow: surveyed.length,
      bundledTxPerLaunch: distribution(allLaunches.map((l) => l.bundledTx)),
      runTxPerLaunch: distribution(allLaunches.map((l) => l.runTx)),
      maxWalletsInOneTxPerLaunch: distribution(allLaunches.map((l) => l.maxWalletsInOneTx)),
      coordinatedWalletsPerLaunch: distribution(allLaunches.map((l) => l.coordinatedWallets)),
      adjacencyMarksPerLaunch: distribution(allLaunches.map((l) => l.adjacencyMarks)),
      createSlotWalletsPerLaunch: distribution(allLaunches.map((l) => l.createSlotWallets)),
      medianBundledTxByCandidate: distribution(
        surveyed.map((r) => median(r.launches.map((l) => l.bundledTx))),
      ),
      medianRunTxByCandidate: distribution(surveyed.map((r) => median(r.launches.map((l) => l.runTx)))),
      medianMaxWalletsByCandidate: distribution(
        surveyed.map((r) => median(r.launches.map((l) => l.maxWalletsInOneTx))),
      ),
      provenShareByCandidate: distribution(
        surveyed.map((r) => Number((r.provenLaunches / r.launchesUsable).toFixed(4))),
      ),
      bundledShareByCandidate: distribution(
        surveyed.map((r) => Number((r.bundledLaunches / r.launchesUsable).toFixed(4))),
      ),
    },
    // (3) THE HEADLINE — the population Stage 2 can currently reach a verdict for
    headline: {
      candidatesWithFullSample: withFullSample.length,
      candidatesProvenOnAllOfThem: allProven.length,
      fraction:
        withFullSample.length === 0
          ? null
          : Number((allProven.length / withFullSample.length).toFixed(4)),
      // Its complement, named, because that is what the current pinning silences.
      silencedByOneUnprovenLaunch: withFullSample.length - allProven.length,
      // The same headline under the superseded shared-transaction half, so the gain the union
      // actually bought is visible in the record rather than inferred across two files.
      candidatesBundlingOnAllOfThem: allBundled.length,
      sharedTxFraction:
        withFullSample.length === 0
          ? null
          : Number((allBundled.length / withFullSample.length).toFixed(4)),
      note:
        'DEFINED ONLY OVER CANDIDATES THAT PRODUCED THE FULL SAMPLE, AND UNDER THE UNION PREDICATE ' +
        '(measure.mjs -> roomIsProven, decision 182a). `minLaunchesSampled` is 8 and ' +
        '`maxLaunchesPerCandidate` is 8, so a candidate with fewer usable windows is already ' +
        'UNMEASURED for a reason that is not co-ordination evidence, and folding it in either way ' +
        'would answer a different question. `candidatesShortOfAFullSample` counts those separately. ' +
        '`candidatesBundlingOnAllOfThem` is the same count under the SUPERSEDED shared-transaction ' +
        'half and decides nothing; it is here so the first run of this census still compares.',
      candidatesShortOfAFullSample: surveyed.length - withFullSample.length,
    },
    // (4) permanently unscoreable, kept apart from near-misses
    unscoreable: {
      neverProven: rows.filter((r) => r.neverProven).length,
      neverProvenWithFullSample: withFullSample.filter((r) => r.neverProven).length,
      // The first run's count, unchanged in meaning. Under the union it no longer implies permanent
      // unscoreability, which is the whole finding of this re-run.
      neverBundles: rows.filter((r) => r.neverBundles).length,
      neverBundlesButProvenSomewhere: rows.filter((r) => r.neverBundles && r.provenLaunches > 0).length,
      shortOfAFullSampleButAllProven: surveyed.filter(
        (r) => !r.fullSample && r.launchesUsable > 0 && r.provenLaunches === r.launchesUsable,
      ).length,
      note:
        'A `neverProven` candidate has `coordinatedWallets === 0` on every window it produced: ' +
        'NEITHER half of the co-ordination rule saw anything, so re-screening it produces the same ' +
        'silence forever. That is a different finding from a candidate that merely fell short of ' +
        '8 of 8 on this reading, and the two are never summed. `neverBundles` is the SUPERSEDED ' +
        'shared-transaction-half count and no longer means permanent: ' +
        '`neverBundlesButProvenSomewhere` is how many of it the union rescued.',
    },
  };
}

/**
 * The ERA question, answered where it CAN be answered: offline, over this repository's own tape,
 * for exactly one deployer.
 *
 * The live census walks each candidate's most recent `maxLaunchesPerCandidate` launches — 10 since
 * captain decision 190a, 8 when the committed record was written — which for an active deployer span
 * days to weeks. **That sample cannot carry a trend and must not be asked to.** What can is the
 * committed population tape: 235 launches of one deployer over 2025-12 → 2026-07, every one with a
 * proved create slot, already parsed by `stage0.mjs` → `measureSubjectLaunches` for the rolling
 * replay. Bucketing its `bundledTx` by month is free, offline and reproducible.
 *
 * **It is n = 1 deployer and it is a within-deployer trend, not a population one.** A second one
 * does not exist and cannot be produced from this tape (`CLAUDE.md`: "how many windows are there"
 * is n = 1 here). It is reported because the alternative — saying nothing about era — would leave
 * the reader to assume the live rate is stationary, and this deployer's own history is the one
 * piece of evidence that it is not.
 *
 * The second table is the live analogue: for every point in that history, would the trailing
 * 8 launches ALL have been bundled — i.e. would Stage 2 have reached a verdict on this wallet that
 * day? That is the headline number replayed against a real history. **Its span is pinned at 8 and
 * no longer matches the live rule**: captain decision 190a took `maxLaunchesPerCandidate` to 10
 * against a floor of 8, so this replay asks all-of-8 where Stage 2 now asks 8-proven-of-10. Like
 * the census headline it is therefore the STRICTER question, which understates scoreability — the
 * safe direction — and re-cutting it is part of the same re-run decision.
 *
 * **Both halves are bucketed, and the difference between them is the point of the table now.** The
 * subject bundles nothing at all before March 2026 while the union proves every one of those
 * launches, so a shared-transaction-only column reads as "this operator did not co-ordinate" where
 * the truth is "this rule could not see it". That is the same confusion this re-run exists to remove
 * from the live census, one deployer down.
 *
 * @param {string} [dataDir]
 * @returns {{ launches: number, proven: number, provenRate: number, bundled: number, rate: number,
 *   byMonth: { month: string, launches: number, proven: number, provenRate: number, bundled: number,
 *     rate: number, medianMaxWalletsInOneTx: number, medianRunTx: number }[],
 *   trailingWindows: number, trailingAllProven: number, trailingProvenRate: number,
 *   trailingAllBundled: number, trailingRate: number,
 *   trailingByMonth: { month: string, windows: number, allProven: number, provenRate: number,
 *     allBundled: number, rate: number }[],
 *   newestWindowAllProven: boolean | null, newestWindowAllBundled: boolean | null }}
 */
export function subjectEraTrend(dataDir = DEFAULT_DATA_DIR) {
  const launches = measureSubjectLaunches(dataDir);
  /** @type {Map<string, { launches: number, proven: number, bundled: number, maxWallets: number[], runTx: number[] }>} */
  const months = new Map();
  for (const l of launches) {
    const key = l.dateIso.slice(0, 7);
    const bucket = months.get(key) ?? { launches: 0, proven: 0, bundled: 0, maxWallets: [], runTx: [] };
    bucket.launches += 1;
    if (roomIsProven(l.createSlot)) bucket.proven += 1;
    if (l.createSlot.bundledTx >= 1) bucket.bundled += 1;
    bucket.maxWallets.push(l.createSlot.maxWalletsInOneTx);
    bucket.runTx.push(l.createSlot.runTx);
    months.set(key, bucket);
  }

  const span = 8;
  /** @type {Map<string, { windows: number, allProven: number, allBundled: number }>} */
  const trailingMonths = new Map();
  let trailingWindows = 0;
  let trailingAllProven = 0;
  let trailingAllBundled = 0;
  for (let i = span - 1; i < launches.length; i++) {
    const window = launches.slice(i - span + 1, i + 1);
    const provenOk = window.every((l) => roomIsProven(l.createSlot));
    const bundledOk = window.every((l) => l.createSlot.bundledTx >= 1);
    trailingWindows += 1;
    if (provenOk) trailingAllProven += 1;
    if (bundledOk) trailingAllBundled += 1;
    const key = (launches[i]?.dateIso ?? '').slice(0, 7);
    const bucket = trailingMonths.get(key) ?? { windows: 0, allProven: 0, allBundled: 0 };
    bucket.windows += 1;
    if (provenOk) bucket.allProven += 1;
    if (bundledOk) bucket.allBundled += 1;
    trailingMonths.set(key, bucket);
  }

  const proven = launches.filter((l) => roomIsProven(l.createSlot)).length;
  const bundled = launches.filter((l) => l.createSlot.bundledTx >= 1).length;
  return {
    launches: launches.length,
    proven,
    provenRate: launches.length === 0 ? Number.NaN : Number((proven / launches.length).toFixed(4)),
    bundled,
    rate: launches.length === 0 ? Number.NaN : Number((bundled / launches.length).toFixed(4)),
    byMonth: [...months.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, b]) => ({
        month,
        launches: b.launches,
        proven: b.proven,
        provenRate: Number((b.proven / b.launches).toFixed(4)),
        bundled: b.bundled,
        rate: Number((b.bundled / b.launches).toFixed(4)),
        medianMaxWalletsInOneTx: median(b.maxWallets),
        medianRunTx: median(b.runTx),
      })),
    trailingWindows,
    trailingAllProven,
    trailingProvenRate:
      trailingWindows === 0 ? Number.NaN : Number((trailingAllProven / trailingWindows).toFixed(4)),
    trailingAllBundled,
    trailingRate: trailingWindows === 0 ? Number.NaN : Number((trailingAllBundled / trailingWindows).toFixed(4)),
    trailingByMonth: [...trailingMonths.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, b]) => ({
        month,
        windows: b.windows,
        allProven: b.allProven,
        provenRate: Number((b.allProven / b.windows).toFixed(4)),
        allBundled: b.allBundled,
        rate: Number((b.allBundled / b.windows).toFixed(4)),
      })),
    newestWindowAllProven:
      launches.length < span ? null : launches.slice(-span).every((l) => roomIsProven(l.createSlot)),
    newestWindowAllBundled:
      launches.length < span ? null : launches.slice(-span).every((l) => l.createSlot.bundledTx >= 1),
  };
}

/** @param {ReturnType<typeof subjectEraTrend>} t @returns {string} */
export function renderSubjectEraTrend(t) {
  const L = [];
  L.push('SUBJECT ERA TREND — OFFLINE, n = 1 DEPLOYER, and it is a WITHIN-DEPLOYER trend');
  L.push('');
  L.push('  Source: data/population-tape-2026-07-29, every taped launch whose create slot is proved.');
  L.push('  No request of any kind was issued to produce this table.');
  L.push('');
  L.push(`  ${t.proven} of ${t.launches} taped launches are PROVEN by the union (${t.provenRate}),`);
  L.push(`  of which ${t.bundled} carried a bundled create-slot transaction (${t.rate}) — the`);
  L.push('  SHARED-TRANSACTION half alone, which is the predicate the first census run used.');
  L.push('');
  L.push('  month     launches   proven  provenRate  bundled  sharedTxRate   med maxWallets  med runTx');
  for (const m of t.byMonth) {
    L.push(
      `  ${m.month}   ${String(m.launches).padStart(8)}  ${String(m.proven).padStart(7)}  ` +
        `${m.provenRate.toFixed(4).padStart(10)}  ${String(m.bundled).padStart(7)}  ` +
        `${m.rate.toFixed(4).padStart(12)}   ${String(m.medianMaxWalletsInOneTx).padStart(11)}  ` +
        `${m.medianRunTx}`,
    );
  }
  L.push('');
  L.push('  THE GAP BETWEEN THE TWO COLUMNS IS THE FINDING. Before 2026-03 this operator bundles');
  L.push('  NOTHING and the union proves EVERYTHING: the shared-transaction half was reading a rule\'s');
  L.push('  blind spot as a deployer\'s habit. That is the same confusion the live census re-run removes.');
  L.push('');
  L.push('  THE HEADLINE NUMBER REPLAYED: would the trailing 8 launches ALL have been proven?');
  L.push('  Its span is pinned at 8 and is now STRICTER than the live rule (decision 190a: 8 proven');
  L.push('  of 10 planned), so it understates scoreability — the safe direction.');
  L.push(
    `    union: ${t.trailingAllProven} of ${t.trailingWindows} trailing windows (${t.trailingProvenRate}); ` +
      `shared-tx half alone: ${t.trailingAllBundled} (${t.trailingRate}).`,
  );
  L.push('  month     windows  all proven  provenRate  all bundled  sharedTxRate');
  for (const m of t.trailingByMonth) {
    L.push(
      `  ${m.month}   ${String(m.windows).padStart(7)}  ${String(m.allProven).padStart(10)}  ` +
        `${m.provenRate.toFixed(4).padStart(10)}  ${String(m.allBundled).padStart(11)}  ` +
        `${m.rate.toFixed(4).padStart(12)}`,
    );
  }
  L.push(`    newest window all proven: ${t.newestWindowAllProven} (all bundled: ${t.newestWindowAllBundled})`);
  L.push('');
  L.push('  READ IT AS ONE DEPLOYER. A second window series does not exist in this repository and');
  L.push('  cannot be produced from this tape. It says the rate is NOT stationary for this operator;');
  L.push('  it says nothing about how many other deployers moved the same way.');
  return L.join('\n');
}

const USAGE = `bundling-census — how often can the co-ordination rule see anything in a create slot?

  node tools/deployer-screen/bundling.mjs [options]

WHAT IT IS
  A WINDOWS-ONLY pass. It walks create-slot windows with Stage 2's own pinned window parameters and
  reports ONLY bundledTx, runTx, maxWalletsInOneTx and the union's mark count per launch. It runs no
  entry scoring, computes no room figure, prices no entry cost and reaches no verdict. Captain
  decision 173a; re-run under the UNION predicate on captain decision 183a.

  IT SPENDS NO KEYED REQUEST. There is no keyed client in this file. The cohort comes from this
  repository's own committed records and the launch list from the keyless ownership listing.

OPTIONS
  --dry-run           Print exactly what a real run would fetch, and fetch nothing.
  --subject-era       Print the OFFLINE era trend over the committed population tape and stop.
                      One deployer, 235 taped launches, zero requests. The live census walks only
                      the most recent 10 launches per candidate, which cannot carry a trend.
  --candidates <n>    Max gate survivors to survey. Cannot exceed the pinned cap.
  --cohort <n>        Max cohort wallets to gate. Cannot exceed the pinned cap.
  --out <path>        Write the census record as JSON. Default: nothing is written. Write it under
                      census/, NOT runs/ — see the module header.
  --json              Print the record as JSON instead of text.
  --help              This text.

EXIT CODES
  0 ok    2 usage    6 a keyless ceiling was reached mid-run (the record is still written)
`;

/**
 * @param {readonly string[]} argv
 * @returns {{ ok: true, opts: CensusOptions } | { ok: false, message: string }}
 */
export function parseArgs(argv) {
  /** @type {CensusOptions} */
  const opts = {
    dryRun: false,
    subjectEra: false,
    candidates: null,
    cohort: null,
    out: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    /** @returns {string | null} */
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return null;
      i += 1;
      return v;
    };
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--subject-era':
        opts.subjectEra = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--candidates': {
        const v = next();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isInteger(n) || n < 1) return { ok: false, message: '--candidates needs a positive integer' };
        opts.candidates = n;
        break;
      }
      case '--cohort': {
        const v = next();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isInteger(n) || n < 1) return { ok: false, message: '--cohort needs a positive integer' };
        opts.cohort = n;
        break;
      }
      case '--out': {
        const v = next();
        if (v === null) return { ok: false, message: '--out needs a path' };
        opts.out = v;
        break;
      }
      default:
        return { ok: false, message: `unknown option '${String(arg)}'` };
    }
  }
  return { ok: true, opts };
}

/**
 * @typedef {object} CensusOptions
 * @property {boolean} dryRun
 * @property {boolean} subjectEra Print the offline within-deployer era trend and stop. Offline,
 *   n = 1, and it answers a question the live sample structurally cannot — see
 *   {@link subjectEraTrend}.
 * @property {number | null} candidates
 * @property {number | null} cohort
 * @property {string | null} out
 * @property {boolean} json
 * @property {boolean} help
 */

/** @returns {Record<string, any>} */
export function loadThresholds() {
  return JSON.parse(readFileSync(join(HERE, 'thresholds.json'), 'utf8'));
}

/**
 * Print the plan, in the units each leg is actually bounded in, before anything is fetched.
 *
 * The same contract `screen.mjs` → `renderDryRun` holds: the worst case printed here is the whole
 * exposure, because both ceilings are enforced and no launch is started without a full per-launch
 * cap of headroom.
 *
 * @param {object} plan
 * @param {number} plan.cohortSize
 * @param {number} plan.cohortCap
 * @param {number} plan.maxCandidates
 * @param {Record<string, any>} plan.census
 * @param {import('./stage2.mjs').Stage2Thresholds} plan.entry
 * @param {number} plan.listingIntervalMs
 * @returns {string}
 */
export function renderDryRun(plan) {
  const gated = Math.min(plan.cohortSize, plan.cohortCap);
  const listingWorst = gated * plan.census.maxListingPagesPerCandidate;
  const fillWorst = plan.maxCandidates * plan.entry.maxLaunchesPerCandidate * plan.entry.maxRequestsPerLaunch;
  const listingMin = Math.round((listingWorst * plan.listingIntervalMs) / 60_000);
  const fillMin = Math.round((fillWorst * plan.entry.keylessMinIntervalMs) / 60_000);
  // DERIVED FROM THE WALK, NOT DESCRIBED. `readLaunchWindow` will seek exactly this far, because
  // this is the function it calls to decide that. See {@link MEASURED_PAGE_COST} for why the page
  // cost beside it is checked against the reach rather than simply printed.
  const reachMs = windowReachMs(plan.entry);
  const pageCostIsCurrent = reachMs === MEASURED_PAGE_COST.atReachMs;
  const pageCostRisePct = Math.round(
    (MEASURED_PAGE_COST.p50Pages / MEASURED_PAGE_COST.supersededP50Pages - 1) * 100,
  );
  const expectedMin = Math.round(
    (plan.maxCandidates * plan.entry.maxLaunchesPerCandidate * MEASURED_PAGE_COST.p50Requests *
      plan.entry.keylessMinIntervalMs) /
      60_000,
  );
  const L = [];
  L.push('DRY RUN — nothing was fetched.');
  L.push('');
  L.push('KEYED SPEND: 0. There is no keyed client in this pass, so no MadeOnSol, Helius or Dune');
  L.push('  allowance can be touched by it. The cohort is read from committed records on disk.');
  L.push('');
  L.push(`COHORT (committed records): ${plan.cohortSize} wallet(s) found, gating ${gated} ` +
    `(cap ${plan.cohortCap}).`);
  L.push(
    `  LEG 1 — keyless ownership listing, frontend-api-v3.pump.fun, up to ` +
      `${plan.census.maxListingPagesPerCandidate} page(s) per wallet at ${plan.listingIntervalMs}ms:`,
  );
  L.push(
    `    worst case ${gated} x ${plan.census.maxListingPagesPerCandidate} = ${listingWorst} request(s), ` +
      `ceiling ${plan.census.maxListingRequests}, about ${listingMin} minute(s).`,
  );
  L.push('    This applies the PINNED stage1_gate thresholds to the OWNERSHIP reading, which is');
  L.push('    biased towards rejection — a survivor of it is a survivor on the harder reading.');
  L.push('');
  L.push(
    `  LEG 2 — keyless fill walk, swap-api.pump.fun, surveying up to ${plan.maxCandidates} gate ` +
      `survivor(s) at ${plan.entry.keylessMinIntervalMs}ms:`,
  );
  L.push(
    `    worst case ${plan.maxCandidates} x ${plan.entry.maxLaunchesPerCandidate} launch(es) x ` +
      `${plan.entry.maxRequestsPerLaunch} request(s) = ${fillWorst}, ceiling ` +
      `${plan.census.maxKeylessRequests}, about ${fillMin} minute(s) worst case.`,
  );
  L.push(
    `    The walk seeks ${reachMs / 1000}s past each mint: ${plan.entry.windowSlotSpan} slots at a measured worst-case slot ` +
      `rate, plus`,
  );
  L.push(
    `    ${plan.entry.seekMarginMs / 1000}s of clock slack. pumpfun.mjs -> windowReachMs derives that reach AND owns the ` +
      `page cost`,
  );
  L.push('    measured at it; this plan quotes the owner rather than keeping a copy of it.');
  if (pageCostIsCurrent) {
    L.push(
      `    At that owner's p50 of ${MEASURED_PAGE_COST.p50Pages} page(s) — about ${MEASURED_PAGE_COST.p50Requests} request(s) once this host's ~25% shed ` +
        `rate is`,
    );
    L.push(`    paid — the EXPECTED cost is nearer ${expectedMin} minute(s) than the worst case above.`);
    L.push(
      `    THAT IS ~${pageCostRisePct}% MORE PAGES PER LAUNCH than the 2026-08-03 census paid ` +
        `(p50 ${MEASURED_PAGE_COST.supersededP50Pages} -> ${MEASURED_PAGE_COST.p50Pages} on`,
    );
    L.push(
      `    that owner's population), because captain decision 144a widened the reach from ` +
        `${MEASURED_PAGE_COST.supersededReachMs / 1000}s to ${reachMs / 1000}s.`,
    );
    L.push('    THAT RECORD\'S SPEND UNDERSTATES A RE-RUN by roughly this share; its measures are');
    L.push('    unaffected. The per-launch cap did not move with the reach, so the busiest launches now');
    L.push('    exhaust it and are dropped as request-cap — counted, and shrinking the denominator');
    L.push('    towards the quieter launches.');
  } else {
    L.push(
      `    !! NO EXPECTED COST IS PRINTED: the page cost this plan can quote was measured at a ` +
        `${MEASURED_PAGE_COST.atReachMs / 1000}s`,
    );
    L.push(
      `    reach and the walk now reaches ${reachMs / 1000}s. Plan against the worst case above until ` +
        `pumpfun.mjs`,
    );
    L.push('    -> windowReachMs is re-measured at the reach in force.');
  }
  L.push('');
  L.push('WINDOW PARAMETERS ARE STAGE 2\'S OWN, reused rather than re-pinned:');
  L.push(
    `    windowMs ${plan.entry.windowMs}, seekMarginMs ${plan.entry.seekMarginMs}, ` +
      `windowSlotSpan ${plan.entry.windowSlotSpan}, tradePageLimit ${plan.entry.tradePageLimit}, ` +
      `eligibility floor ${plan.entry.windowMs + plan.entry.seekMarginMs}ms, seek reach ${reachMs}ms.`,
  );
  L.push('    THE LAST TWO ARE DIFFERENT BOUNDS AND THE GAP IS KNOWN: eligibility still asks');
  L.push('    windowMs + seekMarginMs, which is shorter than the reach and shorter than the span it');
  L.push('    gates on. That residual is stage2.mjs\'s and another lane\'s; it is stated here so the');
  L.push('    two numbers above are not read as one.');
  L.push('');
  L.push('WHAT IT WILL NOT DO: no entry score, no room figure, no field, no entry cost, no verdict.');
  L.push('');
  L.push('PREDICATE: measure.mjs -> roomIsProven, the UNION (decision 182a). Both halves are reported');
  L.push('  per launch — bundledTx (shared transaction) and runTx (deployer-anchored block-index run).');
  L.push('');
  L.push(`CAVEAT CARRIED BY EVERY NUMBER: ${PREDICATE_CAVEAT}`);
  L.push(`CAVEAT CARRIED BY EVERY NUMBER: ${OWNERSHIP_LIST_CAVEAT}`);
  L.push(`CAVEAT CARRIED BY EVERY NUMBER: ${DROPPED_WINDOW_CAVEAT}`);
  L.push(`CAVEAT CARRIED BY EVERY NUMBER: ${MINT_TIME_BACKDATE_CAVEAT}`);
  return L.join('\n');
}

const EXIT = { ok: 0, usage: 2, ceiling: 6 };

/**
 * @param {CensusOptions} opts
 * @param {(line: string) => void} out
 * @param {(line: string) => void} err
 * @returns {Promise<number>}
 */
export async function main(opts, out, err) {
  if (opts.help) {
    out(USAGE);
    return EXIT.ok;
  }

  if (opts.subjectEra) {
    const trend = subjectEraTrend();
    out(opts.json ? JSON.stringify(trend, null, 2) : renderSubjectEraTrend(trend));
    return EXIT.ok;
  }

  const T = loadThresholds();
  const census = T['bundling_census'];
  /** @type {import('./stage2.mjs').Stage2Thresholds} */
  const entry = { ...T['stage2_entry'] };
  const gateThresholds = {
    minTokens: T['stage1_gate'].minTokens,
    minCompletionRate: T['stage1_gate'].minCompletionRate,
    minSpanDays: T['stage1_gate'].minSpanDays,
  };
  const listingIntervalMs = T['budget'].keylessMinIntervalMs;

  // Both caps can only ever be LOWERED from the command line, the same rule every other bound in
  // this tool follows. A bound a flag can widen is not a bound.
  const cohortCap = Math.min(opts.cohort ?? census.maxCohortSize, census.maxCohortSize);
  const maxCandidates = Math.min(opts.candidates ?? census.maxCandidatesSurveyed, census.maxCandidatesSurveyed);

  const cohort = buildCohort();

  // **Over budget fails BEFORE spending**, exactly as `screen.mjs` refuses an over-budget plan.
  const listingWorst = Math.min(cohort.length, cohortCap) * census.maxListingPagesPerCandidate;
  if (listingWorst > census.maxListingRequests) {
    err(
      `Refusing to start: the listing leg's worst case is ${listingWorst} request(s), above the ` +
        `pinned ceiling of ${census.maxListingRequests}. Lower --cohort.`,
    );
    return EXIT.usage;
  }
  const fillWorst = maxCandidates * entry.maxLaunchesPerCandidate * entry.maxRequestsPerLaunch;
  if (fillWorst > census.maxKeylessRequests) {
    err(
      `Refusing to start: the fill leg's worst case is ${fillWorst} request(s), above the pinned ` +
        `ceiling of ${census.maxKeylessRequests}. Lower --candidates.`,
    );
    return EXIT.usage;
  }

  if (opts.dryRun) {
    out(renderDryRun({ cohortSize: cohort.length, cohortCap, maxCandidates, census, entry, listingIntervalMs }));
    return EXIT.ok;
  }

  const startedAtIso = new Date().toISOString();
  const listingClient = new KeylessClient({
    maxRequests: census.maxListingRequests,
    minIntervalMs: listingIntervalMs,
    onRequest: (url) => {
      if (!opts.json) out(`  → GET ${url}`);
    },
  });
  // Its OWN client and its OWN ceiling, for the reason `screen.mjs` gives for Stage 2's: a different
  // host with different pacing, and neither leg may eat the other's budget or exceed what the dry
  // run printed.
  const fillClient = new KeylessClient({
    maxRequests: census.maxKeylessRequests,
    minIntervalMs: entry.keylessMinIntervalMs,
    retryBackoffMs: entry.keylessRetryBackoffMs ?? [],
    onRequest: (url) => {
      if (!opts.json) out(`  → GET ${url}`);
    },
  });

  /** @type {CandidateBundling[]} */
  const rows = [];
  /** @type {{ wallet: string, verdict: string, reason: string }[]} */
  const notSurveyed = [];
  let completed = true;
  /** @type {string | null} */
  let abortReason = null;

  const gating = cohort.slice(0, cohortCap);
  /** @type {{ member: CohortMember, refs: { mint: string, deployedAtMs: number }[], gate: CandidateGate }[]} */
  const survivors = [];

  try {
    if (!opts.json) {
      out('');
      out(
        `GATE — pinned stage1_gate thresholds over the KEYLESS ownership listing, ` +
          `${gating.length} cohort wallet(s) of ${cohort.length}. Zero keyed requests.`,
      );
    }

    for (const member of gating) {
      // A listing that cannot be read degrades THIS candidate and never the run: the same rule
      // `screen.mjs` applies per candidate, and for the same reason — a wallet that could not be
      // read is unmeasured, not rejected.
      /** @type {{ records: import('./pumpfun.mjs').ListedToken[], truncated: boolean }} */
      let listing;
      try {
        listing = await readCreatorHistory(listingClient, member.wallet, census.maxListingPagesPerCandidate);
      } catch (cause) {
        if (cause instanceof CeilingReached) throw cause;
        notSurveyed.push({
          wallet: member.wallet,
          verdict: 'gate-unmeasured',
          reason: `the ownership listing could not be read: ${describeTransportFailure(cause)}`,
        });
        continue;
      }

      const completion = measureCompletion(listing.records);
      const gate = applyGate({ completion, historySource: 'ownership-only' }, gateThresholds);
      const { verdict } = verdictFor({ gate, completion, capped: listing.truncated });
      const refs = listing.records
        .filter((r) => r.mint !== '' && Number.isFinite(r.deployedAtMs) && r.deployedAtMs > 0)
        .map((r) => ({ mint: r.mint, deployedAtMs: r.deployedAtMs }))
        .sort((a, b) => b.deployedAtMs - a.deployedAtMs);

      if (!opts.json) {
        out(
          `  ${member.wallet}: ${completion.tokens} listed, rate ` +
            `${Number.isFinite(completion.rate) ? completion.rate.toFixed(4) : 'undefined'}, span ` +
            `${completion.spanDays.toFixed(1)}d → ${verdict.toUpperCase()}` +
            (member.recordedGateVerdict !== null && member.recordedGateVerdict !== verdict
              ? `  (this repo recorded ${member.recordedGateVerdict})`
              : ''),
        );
      }

      const gateBlock = {
        listingRows: listing.records.length,
        listingPageCapped: listing.truncated,
        gateTokens: completion.tokens,
        gateCompletionRate: Number.isFinite(completion.rate) ? Number(completion.rate.toFixed(4)) : 0,
        gateSpanDays: Number(completion.spanDays.toFixed(2)),
        gateVerdict: verdict,
      };
      if (verdict !== 'gate-passed') {
        notSurveyed.push({ wallet: member.wallet, verdict, reason: gate.reasons.join('; ') });
        continue;
      }
      survivors.push({ member, refs, gate: gateBlock });
    }

    const toSurvey = survivors.slice(0, maxCandidates);
    if (!opts.json) {
      out('');
      out(
        `CENSUS — create-slot windows only, ${toSurvey.length} of ${survivors.length} gate ` +
          `survivor(s), ceiling ${census.maxKeylessRequests} request(s) at ` +
          `${entry.keylessMinIntervalMs}ms.`,
      );
      if (survivors.length > toSurvey.length) {
        out(`  !! ${survivors.length - toSurvey.length} survivor(s) left unsurveyed by the pinned cap`);
      }
    }

    for (const s of toSurvey) {
      if (!opts.json) out(`  ${s.member.wallet}`);
      const result = await censusCandidate(fillClient, {
        refs: s.refs,
        nowMs: Date.now(),
        entry,
        mintTimeBackdateMs: census.mintTimeBackdateMs,
        log: opts.json ? undefined : (line) => out(line),
      });
      rows.push({
        wallet: s.member.wallet,
        cohortSources: s.member.sources,
        recordedGateVerdict: s.member.recordedGateVerdict,
        ...s.gate,
        ...result,
      });
      if (!opts.json) {
        out(
          `    → ${result.provenLaunches}/${result.launchesUsable} window(s) PROVEN ` +
            `(${result.bundledLaunches} by shared transaction)` +
            (result.allProven === true
              ? `, ALL OF A FULL ${entry.maxLaunchesPerCandidate}-SAMPLE`
              : '') +
            (result.neverProven ? ', NEVER PROVEN — permanently unscoreable' : '') +
            (result.neverBundles && result.provenLaunches > 0
              ? ', never bundles but the union proves it'
              : '') +
            (result.launchesDropped > 0 ? `, ${result.launchesDropped} dropped` : ''),
        );
      }
    }
  } catch (cause) {
    completed = false;
    abortReason = cause instanceof Error ? cause.message : String(cause);
    err('');
    err(abortReason);
  }

  const summary = summariseCensus(rows);
  const record = {
    tool: 'deployer-screen/bundling-census',
    // SCHEMA 2 — captain decision 183a. `proven` is now the UNION (`measure.mjs` -> `roomIsProven`)
    // where schema 1 froze it at the shared-transaction half, and every launch carries `runTx`,
    // `adjacencyMarks`, `coordinatedWallets` and a separate `bundled` flag. A schema-1 record's
    // `proven` / `neverBundles` figures are a LOWER bound on what the screen can prove and are not
    // comparable field-for-field; bump, never retro-edit, the same rule `record.mjs` holds.
    schemaVersion: 2,
    scope:
      'WINDOWS ONLY. Walks create-slot windows with Stage 2\'s pinned window parameters and reports ' +
      'ONLY bundledTx, runTx, maxWalletsInOneTx and the union\'s mark count per launch. No entry ' +
      'score, no room figure, no field, no entry cost, no verdict, and no threshold is moved by it. ' +
      'Captain decision 173a; re-run under the union predicate on captain decision 183a.',
    // THE PREDICATE THAT PRODUCED EVERY NUMBER BELOW, in the record itself rather than only in the
    // report beside it. The first run of this census was taken under a different one.
    predicate: {
      name: 'union',
      source: 'measure.mjs -> roomIsProven',
      decision: '182a',
      halves: {
        sharedTransaction: 'a create-slot transaction carrying 2+ distinct wallets marks all of them',
        blockIndexAdjacency:
          'the deployer-anchored contiguous block-index run at step exactly 1 marks every wallet in it',
      },
      supersedes: 'bundledTx >= 1 (the shared-transaction half alone), schema 1',
    },
    thresholdsVersion: T['version'],
    startedAtIso,
    finishedAtIso: new Date().toISOString(),
    completed,
    abortReason,
    spend: {
      // Stated first and stated as a zero, because the bound this pass had to declare in advance
      // was the keyed one and the honest report of it is that there is no keyed client here.
      keyedRequests: 0,
      keyedCeilingDeclared: 0,
      listingRequests: listingClient.issued(),
      listingShed: listingClient.shed(),
      listingCeiling: census.maxListingRequests,
      fillRequests: fillClient.issued(),
      fillShed: fillClient.shed(),
      fillCeiling: census.maxKeylessRequests,
      solanaRpcRequests: 0,
      heliusCredits: 0,
      duneExecutions: 0,
    },
    cohort: {
      source: 'tools/deployer-screen/feed/ledger.json + tools/deployer-screen/runs/*.json',
      found: cohort.length,
      gated: gating.length,
      gatePassed: survivors.length,
      surveyed: rows.length,
      leftUnsurveyedByCap: Math.max(0, survivors.length - rows.length),
      notSurveyed,
    },
    windowParameters: {
      sourceBlock: 'stage2_entry',
      windowMs: entry.windowMs,
      seekMarginMs: entry.seekMarginMs,
      windowSlotSpan: entry.windowSlotSpan,
      tradePageLimit: entry.tradePageLimit,
      maxLaunchesPerCandidate: entry.maxLaunchesPerCandidate,
      maxRequestsPerLaunch: entry.maxRequestsPerLaunch,
      minLaunchesSampled: entry.minLaunchesSampled,
      // The one window-adjacent value this pass pins itself, and it is pinned because the CLOCK is
      // different here, not the window. `bundling_census.justification` holds the measurement.
      mintTimeBackdateMs: census.mintTimeBackdateMs,
    },
    summary,
    candidates: rows,
    caveats: [PREDICATE_CAVEAT, OWNERSHIP_LIST_CAVEAT, DROPPED_WINDOW_CAVEAT, MINT_TIME_BACKDATE_CAVEAT],
  };

  if (opts.out !== null) {
    const path = completed ? opts.out : `${opts.out.replace(/\.json$/, '')}.partial.json`;
    writeFileSync(resolve(path), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    if (!opts.json) out(`\nwrote ${path}`);
  }
  if (opts.json) out(JSON.stringify(record, null, 2));
  else out(renderSummary(record));

  return completed ? EXIT.ok : EXIT.ceiling;
}

/**
 * @param {Record<string, any>} record
 * @returns {string}
 */
export function renderSummary(record) {
  const s = record.summary;
  const L = [];
  L.push('');
  L.push('BUNDLING CENSUS — captain decisions 173a and 183a, under the UNION predicate');
  L.push('');
  L.push(
    `SAMPLE: ${s.perLaunch.candidatesContributing} candidate(s) produced at least one usable ` +
      `window; ${s.perLaunch.launchesMeasured} launch window(s) measured in total. ` +
      `Cohort ${record.cohort.found} wallet(s), ${record.cohort.gated} gated, ` +
      `${record.cohort.gatePassed} passed, ${record.cohort.surveyed} surveyed.`,
  );
  L.push('');
  L.push(
    `1. PER-LAUNCH PROVEN RATE (union): ${s.perLaunch.proven} of ${s.perLaunch.launchesMeasured} = ` +
      `${s.perLaunch.rate === null ? 'undefined' : s.perLaunch.rate} ` +
      `(n = ${s.perLaunch.launchesMeasured} windows over ${s.perLaunch.candidatesContributing} candidates).`,
  );
  L.push(
    `   Shared-transaction half ALONE — the superseded predicate: ` +
      `${s.perLaunch.bundledBySharedTxAlone} = ` +
      `${s.perLaunch.sharedTxRate === null ? 'undefined' : s.perLaunch.sharedTxRate}. ` +
      `The union added ${s.perLaunch.provenByAdjacencyOnly} window(s) by adjacency alone.`,
  );
  L.push('');
  L.push('2. PER-CANDIDATE DISTRIBUTIONS');
  const d = s.perCandidate;
  const fmt = (/** @type {Record<string, any>} */ x) =>
    `n=${x.n} min ${x.min} p25 ${x.p25} med ${x.median} p75 ${x.p75} max ${x.max}`;
  L.push(`   bundledTx, per launch            ${fmt(d.bundledTxPerLaunch)}`);
  L.push(`   runTx, per launch                ${fmt(d.runTxPerLaunch)}`);
  L.push(`   maxWalletsInOneTx, per launch    ${fmt(d.maxWalletsInOneTxPerLaunch)}`);
  L.push(`   coordinatedWallets, per launch   ${fmt(d.coordinatedWalletsPerLaunch)}`);
  L.push(`   adjacencyMarks, per launch       ${fmt(d.adjacencyMarksPerLaunch)}`);
  L.push(`   create-slot wallets, per launch  ${fmt(d.createSlotWalletsPerLaunch)}`);
  L.push(`   median bundledTx, per candidate  ${fmt(d.medianBundledTxByCandidate)}`);
  L.push(`   median runTx, per candidate      ${fmt(d.medianRunTxByCandidate)}`);
  L.push(`   median maxWallets, per candidate ${fmt(d.medianMaxWalletsByCandidate)}`);
  L.push(`   proven share, per candidate      ${fmt(d.provenShareByCandidate)}`);
  L.push(`   bundled share, per candidate     ${fmt(d.bundledShareByCandidate)}`);
  L.push('');
  L.push(
    `3. HEADLINE — candidates PROVEN on ALL of their most recent ` +
      `${record.windowParameters.maxLaunchesPerCandidate} eligible launches: ` +
      `${s.headline.candidatesProvenOnAllOfThem} of ${s.headline.candidatesWithFullSample} = ` +
      `${s.headline.fraction === null ? 'undefined' : s.headline.fraction} ` +
      `(n = ${s.headline.candidatesWithFullSample} candidates with a full sample).`,
  );
  L.push(
    `   Under the superseded shared-transaction half: ${s.headline.candidatesBundlingOnAllOfThem} = ` +
      `${s.headline.sharedTxFraction === null ? 'undefined' : s.headline.sharedTxFraction}.`,
  );
  L.push(
    `   Its complement — silenced by at least one unproven launch in eight: ` +
      `${s.headline.silencedByOneUnprovenLaunch}. ` +
      `${s.headline.candidatesShortOfAFullSample} candidate(s) never produced a full sample and are ` +
      `already UNMEASURED for a reason that is not co-ordination evidence.`,
  );
  L.push('');
  L.push(
    `4. PERMANENTLY UNSCOREABLE (NEITHER half marked anything on any window): ` +
      `${s.unscoreable.neverProven}, of which ${s.unscoreable.neverProvenWithFullSample} produced ` +
      `a full sample. Counted APART from near-misses; the two are never summed.`,
  );
  L.push(
    `   The superseded neverBundles count is ${s.unscoreable.neverBundles}, of which ` +
      `${s.unscoreable.neverBundlesButProvenSomewhere} the union proves on at least one window — ` +
      `so that flag no longer means permanent.`,
  );
  L.push('');
  for (const c of record.caveats) L.push(`CAVEAT: ${c}`);
  return L.join('\n');
}

/* c8 ignore start */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    process.exit(EXIT.usage);
  }
  const code = await main(
    parsed.opts,
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  );
  process.exit(code);
}
/* c8 ignore stop */
