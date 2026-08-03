/**
 * THE BUNDLING CENSUS — a windows-only pass that walks create-slot windows and reports **only**
 * whether each one carried a bundled transaction. Captain decision 173a, 2026-08-03.
 *
 * ## The question, and why it needed its own pass
 *
 * `thresholds.json` → `stage2_entry` pins `maxLaunchesPerCandidate: 8` and `minLaunchesSampled: 8`,
 * **deliberately equal** — a candidate is either scored on a full sample or reported UNMEASURED.
 * Since #17 a launch whose create slot carried no bundled transaction is refused as unproven
 * (`measure.mjs` → `roomIsProven`, captain decision 134a). Those two facts multiply: **Stage 2 can
 * only reach a verdict for a candidate whose most recent 8 eligible launches were EVERY ONE
 * bundled, and one unbundled launch in eight silences the whole candidate.** That is arithmetic,
 * not observation.
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
 * walk, with the same pinned window parameters, and reports two integers per launch.
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
 * | launches per candidate | `stage2_entry.maxLaunchesPerCandidate`, **reused** | 8 |
 * | requests per launch | `stage2_entry.maxRequestsPerLaunch`, **reused** | 18 |
 * | fill requests, whole run | `bundling_census.maxKeylessRequests` | 4320 |
 * | pacing, listing host | `budget.keylessMinIntervalMs`, **reused** | 2s |
 * | pacing, fill host | `stage2_entry.keylessMinIntervalMs`, **reused** | 7s |
 *
 * **Every window parameter is Stage 2's own, read from `stage2_entry` rather than re-pinned here.**
 * A second copy of `windowMs` or `windowSlotSpan` would let the census measure a window Stage 2 does
 * not, and the whole point of the number is that it describes the launches Stage 2 refuses. The
 * block this file adds pins only what is genuinely new: how many wallets it may read and how many
 * requests the two legs may spend.
 *
 * `30 × 8 × 18 = 4,320` — the declared worst case and the fill ceiling are the same number, so the
 * dry run's plan is the whole exposure, exactly as `stage2.mjs` arranges it. A launch is started
 * only when a full per-launch cap of headroom remains.
 *
 * ## The known bound-mismatch in `readLaunchWindow`, and why it cannot reach this number
 *
 * `pumpfun.mjs` → `readLaunchWindow` seeks in milliseconds and decides membership in slots, so at
 * 2026 slot times it can fail to fetch the **tail** of a window (`CLAUDE.md`, "the two-bound
 * cursor"). This pass reads the **create slot** — the oldest end of the walk, reached last and
 * proved by the coverage obligation — so a missing tail cannot move `bundledTx` or
 * `maxWalletsInOneTx`. It is stated here so nobody has to re-derive that it does not apply.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CeilingReached } from './client.mjs';
import { measureCompletion, measureCreateSlot, median, percentile } from './measure.mjs';
import { KeylessClient, readCreatorHistory, readLaunchWindow } from './pumpfun.mjs';
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
 */
export const MINT_TIME_BACKDATE_CAVEAT =
  'THE MINT INSTANT IS BACKDATED BY A PINNED MARGIN before the window is walked, because the two ' +
  'vendors disagree: frontend-api-v3 gives millisecond-precision creation times on older rows while ' +
  'swap-api gives whole-second fill times, floored, so the declared mint lands up to ~2s AFTER the ' +
  'launch\'s own first fill and the zero-slack pre-mint tripwire would delete the whole launch. ' +
  'A disagreement LARGER than the margin still drops the launch and is still counted; one SMALLER ' +
  'than it is no longer detected.';

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
 * @property {number} createSlotWallets Distinct wallets in the create slot at all — the context that
 *   separates "a quiet create slot" from "a busy one that nobody bundled in".
 * @property {boolean} proven          `bundledTx >= 1`, i.e. what `measure.mjs` → `roomIsProven`
 *   returns. Recomputed here from the same field rather than imported as a verdict.
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
 * @property {number} bundledLaunches
 * @property {boolean} fullSample      `launchesUsable === launchesPlanned === the Stage 2 cap`.
 * @property {boolean | null} allBundled `null` unless `fullSample` — the headline is only defined
 *   over a candidate that actually produced the full sample Stage 2 requires.
 * @property {boolean} neverBundles    Every usable window had `maxWalletsInOneTx <= 1`. The
 *   `GeBJSHK4…` shape: permanently unscoreable rather than unlucky.
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
 * @param {string} input.wallet
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
        // BACKDATED. Not the declared instant — see `MINT_TIME_BACKDATE_CAVEAT`. It widens the walk
        // at the OLD end only, which is the end the create slot sits at, so it can only admit more
        // of this launch's own opening and never any of another token's.
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
      createSlotWallets,
      proven: measurement.bundledTx >= 1,
    });
    input.log?.(
      `    ${window.pages} page(s) / ${window.requests} request(s), ${window.fills.length} fill(s), ` +
        `bundledTx ${measurement.bundledTx}, maxWalletsInOneTx ${measurement.maxWalletsInOneTx}, ` +
        `${createSlotWallets} wallet(s) in the create slot`,
    );
  }

  const bundledLaunches = launches.filter((l) => l.proven).length;
  const fullSample = launches.length === t.maxLaunchesPerCandidate;

  return {
    launchesEligible: eligible.length,
    launchesPlanned: planned.length,
    launchesAttempted: attempted,
    launchesUsable: launches.length,
    launchesDropped: dropped,
    dropsByReason,
    dropNotes,
    bundledLaunches,
    fullSample,
    // THE HEADLINE IS ONLY DEFINED OVER A FULL SAMPLE. A candidate that produced 6 usable windows,
    // all bundled, is not a candidate Stage 2 would have scored — `minLaunchesSampled` is 8 — so
    // reporting it as "bundles on all of them" would answer a different question from the one the
    // pinning decision asks. `null` says the census could not decide it, which is a third state
    // and not a failure.
    allBundled: fullSample ? bundledLaunches === launches.length : null,
    // Deliberately NOT `bundledLaunches === 0`: a candidate with one usable window and no bundle in
    // it is unlucky, and this flag claims something stronger — that the rule found no bundle in any
    // window at all, which is the `GeBJSHK4…` shape.
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
  const allLaunches = rows.flatMap((r) => r.launches);
  const bundledLaunches = allLaunches.filter((l) => l.proven).length;
  const withFullSample = rows.filter((r) => r.fullSample);
  const allBundled = withFullSample.filter((r) => r.allBundled === true);
  const surveyed = rows.filter((r) => r.launchesUsable > 0);

  return {
    // (1) the per-launch rate
    perLaunch: {
      launchesMeasured: allLaunches.length,
      bundled: bundledLaunches,
      rate: allLaunches.length === 0 ? null : Number((bundledLaunches / allLaunches.length).toFixed(4)),
      candidatesContributing: surveyed.length,
    },
    // (2) the per-candidate distributions
    perCandidate: {
      candidatesWithAnyWindow: surveyed.length,
      bundledTxPerLaunch: distribution(allLaunches.map((l) => l.bundledTx)),
      maxWalletsInOneTxPerLaunch: distribution(allLaunches.map((l) => l.maxWalletsInOneTx)),
      medianBundledTxByCandidate: distribution(
        surveyed.map((r) => median(r.launches.map((l) => l.bundledTx))),
      ),
      medianMaxWalletsByCandidate: distribution(
        surveyed.map((r) => median(r.launches.map((l) => l.maxWalletsInOneTx))),
      ),
      bundledShareByCandidate: distribution(
        surveyed.map((r) => Number((r.bundledLaunches / r.launchesUsable).toFixed(4))),
      ),
    },
    // (3) THE HEADLINE — the population Stage 2 can currently reach a verdict for
    headline: {
      candidatesWithFullSample: withFullSample.length,
      candidatesBundlingOnAllOfThem: allBundled.length,
      fraction:
        withFullSample.length === 0
          ? null
          : Number((allBundled.length / withFullSample.length).toFixed(4)),
      // Its complement, named, because that is what the current pinning silences.
      silencedByOneUnbundledLaunch: withFullSample.length - allBundled.length,
      note:
        'DEFINED ONLY OVER CANDIDATES THAT PRODUCED THE FULL SAMPLE. `minLaunchesSampled` is 8 and ' +
        '`maxLaunchesPerCandidate` is 8, so a candidate with fewer usable windows is already ' +
        'UNMEASURED for a reason that is not bundling, and folding it in either way would answer a ' +
        'different question. `candidatesShortOfAFullSample` counts those separately.',
      candidatesShortOfAFullSample: surveyed.length - withFullSample.length,
    },
    // (4) permanently unscoreable, kept apart from near-misses
    unscoreable: {
      neverBundles: rows.filter((r) => r.neverBundles).length,
      neverBundlesWithFullSample: withFullSample.filter((r) => r.neverBundles).length,
      shortOfAFullSampleButAllBundled: surveyed.filter(
        (r) => !r.fullSample && r.launchesUsable > 0 && r.bundledLaunches === r.launchesUsable,
      ).length,
      note:
        'A `neverBundles` candidate has `maxWalletsInOneTx <= 1` on every window it produced: the ' +
        'co-ordination rule can never see a bundle there, so re-screening it produces the same ' +
        'silence forever. That is a different finding from a candidate that merely fell short of ' +
        '8 of 8 on this reading, and the two are never summed.',
    },
  };
}

/**
 * The ERA question, answered where it CAN be answered: offline, over this repository's own tape,
 * for exactly one deployer.
 *
 * The live census walks each candidate's most recent 8 launches, which for an active deployer span
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
 * day? That is the headline number replayed against a real history.
 *
 * @param {string} [dataDir]
 * @returns {{ launches: number, bundled: number, rate: number,
 *   byMonth: { month: string, launches: number, bundled: number, rate: number, medianMaxWalletsInOneTx: number }[],
 *   trailingWindows: number, trailingAllBundled: number, trailingRate: number,
 *   trailingByMonth: { month: string, windows: number, allBundled: number, rate: number }[],
 *   newestWindowAllBundled: boolean | null }}
 */
export function subjectEraTrend(dataDir = DEFAULT_DATA_DIR) {
  const launches = measureSubjectLaunches(dataDir);
  /** @type {Map<string, { launches: number, bundled: number, maxWallets: number[] }>} */
  const months = new Map();
  for (const l of launches) {
    const key = l.dateIso.slice(0, 7);
    const bucket = months.get(key) ?? { launches: 0, bundled: 0, maxWallets: [] };
    bucket.launches += 1;
    if (l.createSlot.bundledTx >= 1) bucket.bundled += 1;
    bucket.maxWallets.push(l.createSlot.maxWalletsInOneTx);
    months.set(key, bucket);
  }

  const span = 8;
  /** @type {Map<string, { windows: number, allBundled: number }>} */
  const trailingMonths = new Map();
  let trailingWindows = 0;
  let trailingAllBundled = 0;
  for (let i = span - 1; i < launches.length; i++) {
    const window = launches.slice(i - span + 1, i + 1);
    const ok = window.every((l) => l.createSlot.bundledTx >= 1);
    trailingWindows += 1;
    if (ok) trailingAllBundled += 1;
    const key = (launches[i]?.dateIso ?? '').slice(0, 7);
    const bucket = trailingMonths.get(key) ?? { windows: 0, allBundled: 0 };
    bucket.windows += 1;
    if (ok) bucket.allBundled += 1;
    trailingMonths.set(key, bucket);
  }

  const bundled = launches.filter((l) => l.createSlot.bundledTx >= 1).length;
  return {
    launches: launches.length,
    bundled,
    rate: launches.length === 0 ? Number.NaN : Number((bundled / launches.length).toFixed(4)),
    byMonth: [...months.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, b]) => ({
        month,
        launches: b.launches,
        bundled: b.bundled,
        rate: Number((b.bundled / b.launches).toFixed(4)),
        medianMaxWalletsInOneTx: median(b.maxWallets),
      })),
    trailingWindows,
    trailingAllBundled,
    trailingRate: trailingWindows === 0 ? Number.NaN : Number((trailingAllBundled / trailingWindows).toFixed(4)),
    trailingByMonth: [...trailingMonths.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, b]) => ({
        month,
        windows: b.windows,
        allBundled: b.allBundled,
        rate: Number((b.allBundled / b.windows).toFixed(4)),
      })),
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
  L.push(`  ${t.bundled} of ${t.launches} taped launches carried a bundled create-slot transaction (${t.rate}).`);
  L.push('');
  L.push('  month     launches  bundled     rate   median maxWalletsInOneTx');
  for (const m of t.byMonth) {
    L.push(
      `  ${m.month}   ${String(m.launches).padStart(8)}  ${String(m.bundled).padStart(7)}  ` +
        `${m.rate.toFixed(4).padStart(7)}   ${m.medianMaxWalletsInOneTx}`,
    );
  }
  L.push('');
  L.push('  THE HEADLINE NUMBER REPLAYED: would the trailing 8 launches ALL have been bundled —');
  L.push('  i.e. would Stage 2 have reached a verdict on this wallet that day?');
  L.push(`    ${t.trailingAllBundled} of ${t.trailingWindows} trailing windows (${t.trailingRate}).`);
  L.push('  month     windows  all bundled     rate');
  for (const m of t.trailingByMonth) {
    L.push(
      `  ${m.month}   ${String(m.windows).padStart(7)}  ${String(m.allBundled).padStart(11)}  ` +
        `${m.rate.toFixed(4).padStart(7)}`,
    );
  }
  L.push(`    newest window all bundled: ${t.newestWindowAllBundled}`);
  L.push('');
  L.push('  READ IT AS ONE DEPLOYER. A second window series does not exist in this repository and');
  L.push('  cannot be produced from this tape. It says the rate is NOT stationary for this operator;');
  L.push('  it says nothing about how many other deployers moved the same way.');
  return L.join('\n');
}

const USAGE = `bundling-census — how often do deployers bundle their create-slot transaction?

  node tools/deployer-screen/bundling.mjs [options]

WHAT IT IS
  A WINDOWS-ONLY pass. It walks create-slot windows with Stage 2's own pinned window parameters and
  reports ONLY bundledTx and maxWalletsInOneTx per launch. It runs no entry scoring, computes no
  room figure, prices no entry cost and reaches no verdict. Captain decision 173a.

  IT SPENDS NO KEYED REQUEST. There is no keyed client in this file. The cohort comes from this
  repository's own committed records and the launch list from the keyless ownership listing.

OPTIONS
  --dry-run           Print exactly what a real run would fetch, and fetch nothing.
  --subject-era       Print the OFFLINE era trend over the committed population tape and stop.
                      One deployer, 235 taped launches, zero requests. The live census walks only
                      the most recent 8 launches per candidate, which cannot carry a trend.
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
    `    Measured per-launch cost on the committed tape is p50 4 / p90 8 pages, so the EXPECTED ` +
      `cost is nearer ${Math.round((plan.maxCandidates * plan.entry.maxLaunchesPerCandidate * 5 * plan.entry.keylessMinIntervalMs) / 60_000)} minute(s).`,
  );
  L.push('');
  L.push('WINDOW PARAMETERS ARE STAGE 2\'S OWN, reused rather than re-pinned:');
  L.push(
    `    windowMs ${plan.entry.windowMs}, seekMarginMs ${plan.entry.seekMarginMs}, ` +
      `windowSlotSpan ${plan.entry.windowSlotSpan}, tradePageLimit ${plan.entry.tradePageLimit}, ` +
      `eligibility floor ${plan.entry.windowMs + plan.entry.seekMarginMs}ms.`,
  );
  L.push('');
  L.push('WHAT IT WILL NOT DO: no entry score, no room figure, no field, no entry cost, no verdict.');
  L.push('');
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
        wallet: s.member.wallet,
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
          `    → ${result.bundledLaunches}/${result.launchesUsable} window(s) bundled` +
            (result.allBundled === true ? ', ALL OF A FULL 8-SAMPLE' : '') +
            (result.neverBundles ? ', NEVER BUNDLES — permanently unscoreable' : '') +
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
    schemaVersion: 1,
    scope:
      'WINDOWS ONLY. Walks create-slot windows with Stage 2\'s pinned window parameters and reports ' +
      'ONLY bundledTx and maxWalletsInOneTx per launch. No entry score, no room figure, no field, ' +
      'no entry cost, no verdict, and no threshold is moved by it. Captain decision 173a.',
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
    caveats: [OWNERSHIP_LIST_CAVEAT, DROPPED_WINDOW_CAVEAT, MINT_TIME_BACKDATE_CAVEAT],
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
  L.push('BUNDLING CENSUS — captain decision 173a');
  L.push('');
  L.push(
    `SAMPLE: ${s.perLaunch.candidatesContributing} candidate(s) produced at least one usable ` +
      `window; ${s.perLaunch.launchesMeasured} launch window(s) measured in total. ` +
      `Cohort ${record.cohort.found} wallet(s), ${record.cohort.gated} gated, ` +
      `${record.cohort.gatePassed} passed, ${record.cohort.surveyed} surveyed.`,
  );
  L.push('');
  L.push(
    `1. PER-LAUNCH BUNDLING RATE: ${s.perLaunch.bundled} of ${s.perLaunch.launchesMeasured} = ` +
      `${s.perLaunch.rate === null ? 'undefined' : s.perLaunch.rate} ` +
      `(n = ${s.perLaunch.launchesMeasured} windows over ${s.perLaunch.candidatesContributing} candidates).`,
  );
  L.push('');
  L.push('2. PER-CANDIDATE DISTRIBUTIONS');
  const d = s.perCandidate;
  const fmt = (/** @type {Record<string, any>} */ x) =>
    `n=${x.n} min ${x.min} p25 ${x.p25} med ${x.median} p75 ${x.p75} max ${x.max}`;
  L.push(`   bundledTx, per launch            ${fmt(d.bundledTxPerLaunch)}`);
  L.push(`   maxWalletsInOneTx, per launch    ${fmt(d.maxWalletsInOneTxPerLaunch)}`);
  L.push(`   median bundledTx, per candidate  ${fmt(d.medianBundledTxByCandidate)}`);
  L.push(`   median maxWallets, per candidate ${fmt(d.medianMaxWalletsByCandidate)}`);
  L.push(`   bundled share, per candidate     ${fmt(d.bundledShareByCandidate)}`);
  L.push('');
  L.push(
    `3. HEADLINE — candidates bundling on ALL of their most recent ` +
      `${record.windowParameters.maxLaunchesPerCandidate} eligible launches: ` +
      `${s.headline.candidatesBundlingOnAllOfThem} of ${s.headline.candidatesWithFullSample} = ` +
      `${s.headline.fraction === null ? 'undefined' : s.headline.fraction} ` +
      `(n = ${s.headline.candidatesWithFullSample} candidates with a full sample).`,
  );
  L.push(
    `   Its complement — silenced by at least one unbundled launch in eight: ` +
      `${s.headline.silencedByOneUnbundledLaunch}. ` +
      `${s.headline.candidatesShortOfAFullSample} candidate(s) never produced a full sample and are ` +
      `already UNMEASURED for a reason that is not bundling.`,
  );
  L.push('');
  L.push(
    `4. PERMANENTLY UNSCOREABLE (maxWalletsInOneTx <= 1 on every window): ` +
      `${s.unscoreable.neverBundles}, of which ${s.unscoreable.neverBundlesWithFullSample} produced ` +
      `a full sample. Counted APART from near-misses; the two are never summed.`,
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
