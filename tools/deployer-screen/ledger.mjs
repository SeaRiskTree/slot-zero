/**
 * The discovery feed's memory.
 *
 * The feed's whole job is to keep surfacing deployers we have **not seen before**. That is only a
 * feed if something remembers; without memory it is a re-poll of the same vendor page under a
 * different name, and it would spend the shared allowance re-grading wallets we already graded.
 *
 * ## What a wallet's presence here means, and what it does not
 *
 * A wallet in this ledger is **not offered again as new** — that is the entire contract, and it is
 * the one the captain's correction of 2026-08-02 asked for: *"It would not sit and watch wallet
 * already deemed closed window, a dev that is competent will not reopen a window."* So there is no
 * re-open poll here and no expiry that would quietly reintroduce one. A wallet graded `held` is not
 * re-offered, not re-polled, and not re-graded on a schedule.
 *
 * ## The states, and why `held` is not `rejected`
 *
 * The feed grades on the **ownership reading** — one keyed profile request, no Solana RPC walk. That
 * reading is documented as biased **towards rejection** (`README.md` → "Which history the gate
 * counts": ownership understates a wallet's launches, understates its bonded launches by more, and
 * so scores the better deployer worse). A feed that recorded its failures as `gate-failed` would be
 * manufacturing exactly the invisible false rejection the creation-derived lane exists to remove,
 * once per scheduled run, forever.
 *
 * So the failing state is named {@link FeedState} `held`: *this wallet did not clear the gate on the
 * cheap, biased reading*. It is a triage outcome, never a verdict on the wallet. The authority is
 * `screen.mjs`, which reads the creation-derived history. {@link summariseLedger} reports the held
 * population and the near-misses inside it, so the cost of the cheap reading is a number in every
 * run's output rather than a caveat in a document.
 *
 * ## Why run records are imported every run
 *
 * `tools/deployer-screen/runs/*.json` already hold 84 wallets this project has seen and graded. A
 * feed that started empty would offer all 84 back as "new" on its first run and spend ~84 keyed
 * requests re-learning them. {@link importRunRecords} folds them in, offline and free, on **every**
 * run rather than once at bootstrap — so a lost or hand-deleted ledger degrades to a slower feed
 * instead of to a wrong one.
 *
 * Note `prefilteredOut` is imported too. Those wallets were *seen* — the pre-filter skipped them to
 * save a request. Treating them as unseen would re-offer them every run and the cadence filter would
 * skip them every run, which is a duplicate that never converges.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Ledger format version.
 *
 * Bumped, never retro-fitted: the ledger is a durable record of what this project has already spent
 * quota to see, and an unreadable one costs real requests to rebuild. A reader that does not
 * recognise the version refuses rather than guesses — see {@link loadLedger}.
 */
export const LEDGER_SCHEMA_VERSION = 1;

/**
 * Where a wallet sits in the feed.
 *
 * - `deferred` — surfaced, recorded, **not yet gated**. The per-run gate batch is a hard quota bound,
 *   so a run that surfaces 40 new wallets and gates 6 must put the other 34 somewhere. Dropping them
 *   would starve them forever (they are no longer "new" next run); leaving them unrecorded would
 *   re-offer them as new every run. They queue, and the next run drains the backlog first.
 * - `queued` — cleared the gate on the ownership reading. Worth putting through the beatability
 *   screen. This is the feed's product.
 * - `held` — did not clear it. **NOT a rejection** — see the module comment.
 * - `unmeasured` — the gate could not decide: no usable per-token record to read.
 * - `prefiltered` — never gated at all, because the vendor's trailing-window deploy count was below
 *   the pre-filter floor. That floor is a **cadence** filter, so this state is where a slow-but-steady
 *   deployer lands. Counted and reported rather than silently dropped.
 *
 * @typedef {'deferred' | 'queued' | 'held' | 'unmeasured' | 'prefiltered'} FeedState
 */

/**
 * @typedef {object} LedgerEntry
 * @property {string} wallet
 * @property {string} firstSeenIso First time anything in this project saw the address.
 * @property {string} lastSeenIso  Most recent run that surfaced it.
 * @property {number} timesSeen    Runs that surfaced it. A wallet the seeds keep re-serving is not
 *   more interesting than one they served once; this exists so a dry feed can be told apart from a
 *   feed that is churning the same names.
 * @property {string[]} seededBy   Every enumeration query that has ever surfaced it, sorted.
 * @property {FeedState} state
 * @property {string | null} gateVerdict `gate-passed` | `gate-failed` | `gate-unmeasured`, verbatim
 *   from `rank.mjs`. Kept beside `state` rather than folded into it: `state` is the feed's own
 *   triage word and `gateVerdict` is what the shared gate actually returned, and collapsing the two
 *   would make `held` read as a measured rejection.
 * @property {'ownership-only' | 'creation-derived' | null} gateReading Which history the grade was
 *   computed over. `ownership-only` is biased towards rejection; the summary counts them.
 * @property {string | null} gradedAtIso
 * @property {string} origin `feed` or `run-record`. A wallet we learned from a committed screen run
 *   was never surfaced by this feed and must not be counted as its yield.
 * @property {number | null} tokens
 * @property {number | null} completionRate
 * @property {number | null} spanDays
 * @property {string | null} firstDeployIso Oldest deploy the vendor's own records show.
 * @property {number | null} discoveryLagDaysAtLeast How long the wallet had **already** been
 *   deploying when we first saw it. A LOWER BOUND — see {@link discoveryLagDays}.
 * @property {boolean} screened Whether a committed screen run already carries an entry score for it.
 * @property {string[]} shortfalls Which gate legs a `held` wallet missed, so the near-misses — the
 *   plausible false negatives of the cheap reading — can be counted rather than described.
 */

/**
 * @typedef {object} FeedRunRow
 * @property {string} startedAtIso
 * @property {boolean} live Never counted towards the dry streak when false: a preview that surfaced
 *   nothing surfaced nothing because it asked for nothing. A dry run writes no ledger at all today,
 *   so this is a guard rather than a live filter — it exists so that a future path which does record
 *   a preview cannot silently corrupt the streak the alarm reads.
 * @property {boolean} completed False when the run aborted — a credential, quota, ceiling or
 *   transport failure. Never counted towards the dry streak either, and for the same reason as
 *   `live`: a run that stopped surfaced nothing because it stopped, not because the population is
 *   saturated. Without this, two runs dying on a 429 followed by one ordinary dry run reaches the
 *   streak alarm and tells the operator to find a wider source when the fault was the credential.
 * @property {number} distinctWalletsSeeded
 * @property {number} alreadyKnown
 * @property {number} newlySurfaced
 * @property {number} gated
 * @property {number} queued
 * @property {number} held
 * @property {number} unmeasured
 * @property {number} prefiltered
 * @property {number} backlog
 * @property {number} keyedRequests
 * @property {string[]} inertSeeds
 */

/**
 * @typedef {object} Ledger
 * @property {string} tool
 * @property {number} schemaVersion
 * @property {string} updatedAtIso
 * @property {Record<string, LedgerEntry>} wallets
 * @property {FeedRunRow[]} runs Newest LAST. Bounded by `keepRuns` in {@link appendRun}.
 */

/** @returns {Ledger} */
export function emptyLedger() {
  return {
    tool: 'deployer-screen-feed',
    schemaVersion: LEDGER_SCHEMA_VERSION,
    updatedAtIso: new Date(0).toISOString(),
    wallets: {},
    runs: [],
  };
}

/**
 * Read a ledger, or start one.
 *
 * A missing file is a first run and yields an empty ledger. A file we cannot parse, or one written
 * by a schema we do not know, **throws**: silently starting over would re-offer every known wallet as
 * new and spend the shared allowance re-learning them, which is the one failure this module exists
 * to prevent.
 *
 * @param {string} path
 * @returns {Ledger}
 */
export function loadLedger(path) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return emptyLedger();
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `The feed ledger at ${path} is not readable JSON (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Refusing to start over: an empty ledger would re-offer every known wallet as new and spend ` +
        `the shared MadeOnSol allowance re-grading them. Restore the file or point --ledger elsewhere.`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`The feed ledger at ${path} is not an object.`);
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const version = obj['schemaVersion'];
  if (version !== LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `The feed ledger at ${path} declares schemaVersion ${String(version)}; this build reads ` +
        `${LEDGER_SCHEMA_VERSION}. Ledgers are never retro-fitted — migrate it deliberately rather ` +
        `than letting a run rebuild it from nothing.`,
    );
  }

  const wallets = obj['wallets'];
  const runs = obj['runs'];
  return {
    tool: typeof obj['tool'] === 'string' ? obj['tool'] : 'deployer-screen-feed',
    schemaVersion: LEDGER_SCHEMA_VERSION,
    updatedAtIso: typeof obj['updatedAtIso'] === 'string' ? obj['updatedAtIso'] : new Date(0).toISOString(),
    wallets:
      typeof wallets === 'object' && wallets !== null
        ? /** @type {Record<string, LedgerEntry>} */ (wallets)
        : {},
    runs: Array.isArray(runs) ? /** @type {FeedRunRow[]} */ (runs) : [],
  };
}

/**
 * Persist a ledger.
 *
 * Wallet keys are written in sorted order so two runs over the same state produce a byte-identical
 * file — the ledger is committed, and a diff that reorders 90 lines every run hides the one line
 * that changed.
 *
 * @param {string} path
 * @param {Ledger} ledger
 * @param {string} nowIso
 */
export function saveLedger(path, ledger, nowIso) {
  /** @type {Record<string, LedgerEntry>} */
  const sorted = {};
  for (const wallet of Object.keys(ledger.wallets).sort()) {
    const entry = ledger.wallets[wallet];
    if (entry !== undefined) sorted[wallet] = entry;
  }
  const out = { ...ledger, schemaVersion: LEDGER_SCHEMA_VERSION, updatedAtIso: nowIso, wallets: sorted };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

/**
 * How long a wallet had already been deploying when we first saw it.
 *
 * **This is the discovery lag, and it is a LOWER BOUND on it.** Two reasons, both structural:
 *
 * 1. `firstDeployIso` comes from the vendor's own per-token records, which are a capped page of a
 *    trailing window. A wallet that deployed for a year before the page's oldest row reads as
 *    younger than it is.
 * 2. It measures lag only for wallets the vendor **has profiled**. A deployer the vendor has never
 *    tracked contributes no observation at all, so no amount of this statistic bounds the lag on the
 *    population we cannot see. That ceiling is stated in `FEED.md` and it is permanent.
 *
 * @param {number} nowMs The instant we FIRST SAW the wallet, not the instant we graded it.
 * @param {string | null} firstDeployIso
 * @returns {number | null} Days, or `null` when the vendor gave no usable deploy time.
 */
export function discoveryLagDays(nowMs, firstDeployIso) {
  if (firstDeployIso === null || !Number.isFinite(nowMs)) return null;
  const then = Date.parse(firstDeployIso);
  if (!Number.isFinite(then)) return null;
  return Number(((nowMs - then) / 86_400_000).toFixed(2));
}

/**
 * @param {string} wallet
 * @param {string} nowIso
 * @param {string} origin
 * @returns {LedgerEntry}
 */
function blankEntry(wallet, nowIso, origin) {
  return {
    wallet,
    firstSeenIso: nowIso,
    lastSeenIso: nowIso,
    timesSeen: 0,
    seededBy: [],
    state: 'deferred',
    gateVerdict: null,
    gateReading: null,
    gradedAtIso: null,
    origin,
    tokens: null,
    completionRate: null,
    spanDays: null,
    firstDeployIso: null,
    discoveryLagDaysAtLeast: null,
    screened: false,
    shortfalls: [],
  };
}

/**
 * Record that this run surfaced a wallet.
 *
 * Returns whether the wallet was **new to the ledger**, which is the feed's headline yield figure and
 * the input to the dryness alarm. Everything else here is bookkeeping.
 *
 * @param {Ledger} ledger
 * @param {string} wallet
 * @param {readonly string[]} seededBy
 * @param {string} nowIso
 * @returns {boolean} True when this is the first time the wallet has ever been seen.
 */
export function recordSeen(ledger, wallet, seededBy, nowIso) {
  const existing = ledger.wallets[wallet];
  const entry = existing ?? blankEntry(wallet, nowIso, 'feed');
  const isNew = existing === undefined;
  entry.lastSeenIso = nowIso;
  entry.timesSeen += 1;
  entry.seededBy = [...new Set([...entry.seededBy, ...seededBy])].sort();
  ledger.wallets[wallet] = entry;
  return isNew;
}

/**
 * @typedef {object} Grade
 * @property {FeedState} state
 * @property {string} gateVerdict
 * @property {'ownership-only' | 'creation-derived'} gateReading
 * @property {number} tokens
 * @property {number} completionRate `NaN` is stored as `null` — a rate over zero records is not a
 *   number and must not round-trip through JSON as one.
 * @property {number} spanDays
 * @property {string | null} firstDeployIso
 * @property {readonly string[]} shortfalls
 */

/**
 * Attach a grade to a wallet already recorded as seen.
 *
 * @param {Ledger} ledger
 * @param {string} wallet
 * @param {Grade} grade
 * @param {string} nowIso
 * @returns {LedgerEntry} The graded entry, so a caller reporting this run's lag reads the one figure
 *   that was stored rather than recomputing it against a different instant.
 */
export function gradeWallet(ledger, wallet, grade, nowIso) {
  const entry = ledger.wallets[wallet] ?? blankEntry(wallet, nowIso, 'feed');
  entry.state = grade.state;
  entry.gateVerdict = grade.gateVerdict;
  entry.gateReading = grade.gateReading;
  entry.gradedAtIso = nowIso;
  entry.tokens = grade.tokens;
  entry.completionRate = Number.isFinite(grade.completionRate) ? Number(grade.completionRate.toFixed(6)) : null;
  entry.spanDays = Number(grade.spanDays.toFixed(2));
  entry.firstDeployIso = grade.firstDeployIso;
  // Lag is measured against WHEN WE FIRST SAW IT, never against when we got round to grading it —
  // the same basis {@link importRunRecords} uses, and the one FEED.md documents. The gate batch is a
  // hard quota bound, so a wallet surfaced today is routinely gated days later out of the backlog;
  // measuring at grading time would add that queue latency to every backlog wallet's lag and inflate
  // the ledger-wide median the docs quote.
  const firstSeenMs = Date.parse(entry.firstSeenIso);
  entry.discoveryLagDaysAtLeast = discoveryLagDays(
    Number.isFinite(firstSeenMs) ? firstSeenMs : Date.parse(nowIso),
    grade.firstDeployIso,
  );
  entry.shortfalls = [...grade.shortfalls];
  ledger.wallets[wallet] = entry;
  return entry;
}

/**
 * Mark a wallet as skipped by the vendor-count pre-filter.
 *
 * It is recorded rather than forgotten for the reason the module comment gives: an unrecorded skip
 * is re-offered as new on every subsequent run and skipped again every time, so the feed's "new
 * wallets" figure would never converge and the cadence filter's cost would never be visible.
 *
 * @param {Ledger} ledger
 * @param {string} wallet
 * @param {string} nowIso
 */
export function markPrefiltered(ledger, wallet, nowIso) {
  const entry = ledger.wallets[wallet] ?? blankEntry(wallet, nowIso, 'feed');
  // Never downgrade a graded wallet. A wallet the feed already gated can reappear with a lower
  // trailing count on a quiet week, and re-marking it `prefiltered` would erase a grade we paid for.
  if (entry.state === 'deferred') entry.state = 'prefiltered';
  ledger.wallets[wallet] = entry;
}

/**
 * Restore a wallet the pre-filter had set aside once its trailing count clears the floor again.
 *
 * The vendor's counters are a trailing ~7.5-day window, so a steady deployer can drop below the
 * pre-filter floor on a quiet week and climb back the next. Without this, the first quiet week would
 * park it in `prefiltered` permanently — a cadence filter that latches is strictly worse than one
 * that does not, and this feed's whole complaint about the pre-filter is that it is a cadence filter.
 *
 * Only `prefiltered` is restored. A graded wallet is never reopened: that would be the re-poll this
 * lane exists to replace.
 *
 * @param {Ledger} ledger
 * @param {string} wallet
 */
export function markWorthARequest(ledger, wallet) {
  const entry = ledger.wallets[wallet];
  if (entry !== undefined && entry.state === 'prefiltered') entry.state = 'deferred';
}

/**
 * The wallets the next gate batch should spend its requests on, in a deterministic order.
 *
 * **Backlog first, oldest first.** A run's gate batch is a hard quota bound, so wallets surfaced
 * above it are deferred; draining freshest-first would leave the oldest deferred wallets starved
 * permanently while the feed reported healthy yield every run. FIFO by `firstSeenIso`, then address,
 * so two runs over the same ledger spend the allowance on the same wallets.
 *
 * @param {Ledger} ledger
 * @param {number} batch
 * @returns {string[]}
 */
export function nextGateBatch(ledger, batch) {
  const waiting = Object.values(ledger.wallets).filter((e) => e.state === 'deferred');
  waiting.sort((a, b) => {
    if (a.firstSeenIso !== b.firstSeenIso) return a.firstSeenIso < b.firstSeenIso ? -1 : 1;
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });
  return waiting.slice(0, Math.max(0, batch)).map((e) => e.wallet);
}

/** @param {Ledger} ledger @returns {number} */
export function backlogDepth(ledger) {
  return Object.values(ledger.wallets).filter((e) => e.state === 'deferred').length;
}

/**
 * Fold committed screen run records into the ledger.
 *
 * Offline and free. Every candidate a committed run graded, and every wallet its pre-filter skipped,
 * is a wallet this project has already seen — so the feed must never present one as a discovery.
 *
 * Shape is read defensively rather than assumed: the two committed records are schema 1 (no
 * `schemaVersion` field at all, no `historySource`) and schema 3, and this must keep working across
 * the next bump without a migration. Unreadable rows are skipped, not guessed at.
 *
 * @param {Ledger} ledger
 * @param {readonly { file: string, body: unknown }[]} records
 * @returns {{ imported: number }} Counts wallets this call ADDED.
 */
export function importRunRecords(ledger, records) {
  let imported = 0;

  for (const { body } of records) {
    if (typeof body !== 'object' || body === null) continue;
    const rec = /** @type {Record<string, unknown>} */ (body);
    const seenAt = typeof rec['startedAtIso'] === 'string' ? rec['startedAtIso'] : new Date(0).toISOString();
    const historySource = rec['historySource'];
    /** @type {'ownership-only' | 'creation-derived'} */
    const reading = historySource === 'creation-derived' ? 'creation-derived' : 'ownership-only';

    const candidates = rec['candidates'];
    if (Array.isArray(candidates)) {
      for (const raw of candidates) {
        if (typeof raw !== 'object' || raw === null) continue;
        const row = /** @type {Record<string, unknown>} */ (raw);
        const wallet = row['wallet'];
        if (typeof wallet !== 'string' || wallet.length === 0) continue;

        const existing = ledger.wallets[wallet];
        const entry = existing ?? blankEntry(wallet, seenAt, 'run-record');
        if (existing === undefined) {
          imported += 1;
          // A committed run surfaced it once. Left at zero, a wallet the feed has never re-surfaced
          // would read as never seen at all, next to a `firstSeenIso` saying otherwise.
          entry.timesSeen = 1;
        }
        if (seenAt < entry.firstSeenIso) entry.firstSeenIso = seenAt;
        if (seenAt > entry.lastSeenIso) entry.lastSeenIso = seenAt;

        const seededBy = row['seededBy'];
        if (Array.isArray(seededBy)) {
          entry.seededBy = [
            ...new Set([...entry.seededBy, ...seededBy.filter((s) => typeof s === 'string')]),
          ].sort();
        }

        // A committed run's grade is authoritative over anything this feed produced: it may have
        // read the creation-derived history, which the feed never does. Never overwrite it with a
        // cheaper reading.
        const verdict = row['verdict'];
        if (typeof verdict === 'string' && (entry.gradedAtIso === null || entry.gradedAtIso <= seenAt)) {
          entry.gateVerdict = verdict;
          entry.gateReading = typeof row['historySource'] === 'string'
            ? (row['historySource'] === 'creation-derived' ? 'creation-derived' : 'ownership-only')
            : reading;
          entry.gradedAtIso = seenAt;
          entry.state = verdict === 'gate-passed' ? 'queued' : verdict === 'gate-failed' ? 'held' : 'unmeasured';
          const tokens = row['tokens'];
          entry.tokens = typeof tokens === 'number' ? tokens : entry.tokens;
          const rate = row['completionRate'];
          entry.completionRate = typeof rate === 'number' ? rate : entry.completionRate;
          const span = row['spanDays'];
          entry.spanDays = typeof span === 'number' ? span : entry.spanDays;
          const first = row['windowFirstDeploy'];
          entry.firstDeployIso = typeof first === 'string' ? first : entry.firstDeployIso;
          // Lag is measured against WHEN WE FIRST SAW IT, which for an imported wallet is the run
          // that graded it — not now. Computing it at import time against the clock would grow the
          // lag of every historical wallet by a day for every day that passes.
          const firstSeenMs = Date.parse(entry.firstSeenIso);
          entry.discoveryLagDaysAtLeast = Number.isFinite(firstSeenMs)
            ? discoveryLagDays(firstSeenMs, entry.firstDeployIso)
            : entry.discoveryLagDaysAtLeast;
          const reasons = row['gateReasons'];
          entry.shortfalls = Array.isArray(reasons) ? reasons.filter((r) => typeof r === 'string') : entry.shortfalls;
        }
        // An entry score means the beatability screen has already run on this wallet. The feed's
        // product is wallets that have NOT been through it, so this flag keeps the queue honest.
        if (row['entry'] !== undefined && row['entry'] !== null) entry.screened = true;

        ledger.wallets[wallet] = entry;
      }
    }

    const prefiltered = rec['prefilteredOut'];
    if (Array.isArray(prefiltered)) {
      for (const raw of prefiltered) {
        if (typeof raw !== 'object' || raw === null) continue;
        const wallet = /** @type {Record<string, unknown>} */ (raw)['wallet'];
        if (typeof wallet !== 'string' || wallet.length === 0) continue;
        const existing = ledger.wallets[wallet];
        if (existing === undefined) {
          const entry = blankEntry(wallet, seenAt, 'run-record');
          entry.state = 'prefiltered';
          ledger.wallets[wallet] = entry;
          imported += 1;
        }
      }
    }
  }

  return { imported };
}

/**
 * Read every committed screen run record under a directory.
 *
 * `.partial.json` files are read too, deliberately: an aborted run still paid for the profiles it
 * fetched, and the wallets it graded are just as known as a complete run's.
 *
 * @param {string} dir
 * @returns {{ file: string, body: unknown }[]}
 */
export function readRunRecords(dir) {
  /** @type {{ file: string, body: unknown }[]} */
  const out = [];
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
      out.push({ file: name, body: JSON.parse(readFileSync(full, 'utf8')) });
    } catch {
      // A record we cannot read is not a reason to refuse the run — it is a reason to gate one more
      // wallet than we otherwise would. Skipped silently here and counted by the caller.
      continue;
    }
  }
  return out;
}

/**
 * Append this run's yield row and bound the history.
 *
 * @param {Ledger} ledger
 * @param {FeedRunRow} row
 * @param {number} keepRuns
 */
export function appendRun(ledger, row, keepRuns) {
  ledger.runs.push(row);
  if (ledger.runs.length > keepRuns) ledger.runs = ledger.runs.slice(-keepRuns);
}

/**
 * Consecutive LIVE, COMPLETED runs, newest first, that surfaced no new wallet.
 *
 * Dry runs are skipped rather than counted as dry: a preview that requested nothing surfaced nothing
 * for a reason that says nothing about the population. Aborted runs are skipped for the same reason
 * — they surfaced nothing because they stopped. Counting either would let a credential or transport
 * fault reach the streak alarm, whose remedy ("a wider source") is the wrong thing to point an
 * operator at. A row that predates the `completed` field is counted rather than skipped: the
 * conservative direction here is the one that keeps a dry feed audibly dry.
 *
 * @param {Ledger} ledger
 * @returns {number}
 */
export function dryStreak(ledger) {
  let streak = 0;
  for (let i = ledger.runs.length - 1; i >= 0; i--) {
    const row = ledger.runs[i];
    if (row === undefined || !row.live) continue;
    if (row.completed === false) continue;
    if (row.newlySurfaced > 0) break;
    streak += 1;
  }
  return streak;
}

/**
 * How many wallets a run must have gated before "every one came back unreadable" may be read as the
 * vendor's profile shape having moved.
 *
 * A fixed floor, deliberately not scaled with the batch: the alarm makes an assertion about the
 * vendor, and one empty deployer is an ordinary observation rather than evidence of a shape move —
 * the alarm's own text says so. The cost is one run of latency at `--gate 2`, and that is a bound
 * this lane accepts rather than an oversight; see `FEED.md` → "Yield, and why a dead feed cannot
 * read as a healthy one".
 */
export const ALL_UNMEASURED_MIN_GATED = 2;

/**
 * @typedef {object} FeedAlarm
 * @property {boolean} alarmed
 * @property {string[]} reasons Loud, specific, and non-empty exactly when `alarmed`.
 */

/**
 * Decide whether this run's yield is a failure that must be audible.
 *
 * **The defect this exists to prevent is on the record.** The screen's first two committed runs read
 * as healthy while two of its three seeds returned zero wallets, because nothing compared rows
 * against wallets and nothing tracked yield across runs. A scheduled feed makes that failure worse:
 * it repeats silently forever, and an operator reading "0 new candidates" cannot tell a saturated
 * population from a dead reader.
 *
 * Three separate conditions, because they need three different fixes:
 *
 * 1. **Reader wrong.** A seed returned rows and we read no wallet from them. That is our bug, and it
 *    is the exact 2026-07-29 defect. Loud on the FIRST occurrence — never after a streak.
 * 2. **All seeds inert.** Every seed returned nothing at all. Either the vendor is down, the tier
 *    filter matches nobody, or the key is scoped differently than we think.
 * 3. **Dry streak.** `dryStreakAlarm` consecutive live runs surfaced no new wallet. One dry run is
 *    ordinary — the vendor's pages overlap heavily between runs. A streak means the feed has
 *    saturated what this vendor exposes, and the answer is a wider source, not a longer wait.
 * 4. **Every gated wallet came back unreadable.** The profile shape moved, or the endpoint is
 *    answering with an envelope we do not parse. Same class as (1), one endpoint further in: the
 *    vendor answered and we learned nothing, which must never be recorded as a population of
 *    ordinary rejections. Requires at least {@link ALL_UNMEASURED_MIN_GATED} gated wallets: this
 *    condition ASSERTS a vendor-shape move, and its own message says one empty deployer is not
 *    evidence of that — so it must not be assertable from a sample of one. At `--gate 1` a genuine
 *    empty deployer would otherwise satisfy `1 === 1` and exit 9 claiming the vendor moved.
 *
 * @param {object} input
 * @param {readonly { label: string, rowsReturned: number, walletsReturned: number }[]} input.seeds
 * @param {number} input.dryStreak
 * @param {number} input.dryStreakAlarm
 * @param {number} [input.gated] Wallets a profile request was spent on this run.
 * @param {number} [input.unmeasured] Of those, the ones whose profile carried no usable record.
 * @returns {FeedAlarm}
 */
export function feedAlarm(input) {
  /** @type {string[]} */
  const reasons = [];

  const readerWrong = input.seeds.filter((s) => s.rowsReturned > 0 && s.walletsReturned === 0);
  if (readerWrong.length > 0) {
    reasons.push(
      `OUR READER IS WRONG, not the vendor: ${readerWrong.map((s) => s.label).join(', ')} returned rows ` +
        `and we extracted no wallet from them. This is the 2026-07-29 defect (the deployer block moved ` +
        `to 'deployers', plural) recurring — check seed.mjs BLOCK_KEYS against a live response.`,
    );
  }

  if (input.seeds.length > 0 && input.seeds.every((s) => s.walletsReturned === 0)) {
    reasons.push(
      `EVERY seed yielded zero wallets. The feed has no input at all — this is not a quiet run, it is ` +
        `a dead one. Check the tier filter, the credential's scope, and the vendor's status before ` +
        `reading any downstream count as a measurement.`,
    );
  }

  const gated = input.gated ?? 0;
  if (gated >= ALL_UNMEASURED_MIN_GATED && (input.unmeasured ?? 0) === gated) {
    reasons.push(
      `ALL ${gated} wallet(s) gated this run came back with no readable launch record. One such wallet ` +
        `is an empty deployer; all of them is the profile shape having moved — check ` +
        `measure.mjs -> toTokenRecords against a live /deployer-hunter/{wallet} response before ` +
        `reading a single verdict from this run.`,
    );
  }

  if (input.dryStreak >= input.dryStreakAlarm) {
    reasons.push(
      `DRY: ${input.dryStreak} consecutive live run(s) surfaced no wallet this project had not already ` +
        `seen, at a tolerance of ${input.dryStreakAlarm}. The feed has saturated what this vendor ` +
        `exposes. Waiting longer does not fix that — a wider source does; see FEED.md, "The ceiling ` +
        `this feed inherits".`,
    );
  }

  return { alarmed: reasons.length > 0, reasons };
}

/**
 * @typedef {object} LedgerSummary
 * @property {number} wallets
 * @property {number} queued
 * @property {number} held
 * @property {number} unmeasured
 * @property {number} prefiltered
 * @property {number} deferred
 * @property {number} screened
 * @property {number} queuedUnscreened The feed's actual product: cleared the gate, not yet screened.
 * @property {number} heldOnOwnershipReading Held wallets graded on the biased reading. The standing
 *   count of possible false negatives this lane creates by being cheap.
 * @property {number} heldNearMiss Of those, the ones that missed on exactly one gate leg. The most
 *   plausible false negatives, and the shortlist worth a creation-derived re-read.
 * @property {number} lagObservations Wallets with a usable first-deploy time.
 * @property {number | null} lagMedianDaysAtLeast How long a wallet here had ALREADY been deploying
 *   when this project first saw it, median. A LOWER BOUND — see {@link discoveryLagDays}.
 * @property {number | null} lagMaxDaysAtLeast
 */

/**
 * Count what the ledger holds.
 *
 * `heldOnOwnershipReading` and `heldNearMiss` are the two figures that keep the cheap reading honest.
 * The feed grades on a history that is biased towards rejection, so the population it has quietly
 * set aside has to be a number in every run's report — otherwise the bias is a sentence in a
 * document and the wallets are simply gone.
 *
 * @param {Ledger} ledger
 * @returns {LedgerSummary}
 */
export function summariseLedger(ledger) {
  const entries = Object.values(ledger.wallets);
  const held = entries.filter((e) => e.state === 'held');
  const heldCheap = held.filter((e) => e.gateReading === 'ownership-only');
  /** @type {number[]} */
  const lags = [];
  for (const e of entries) if (e.discoveryLagDaysAtLeast !== null) lags.push(e.discoveryLagDaysAtLeast);
  return {
    lagObservations: lags.length,
    lagMedianDaysAtLeast: lags.length === 0 ? null : Number(medianOf(lags).toFixed(2)),
    lagMaxDaysAtLeast: lags.length === 0 ? null : Number(Math.max(...lags).toFixed(2)),
    wallets: entries.length,
    queued: entries.filter((e) => e.state === 'queued').length,
    held: held.length,
    unmeasured: entries.filter((e) => e.state === 'unmeasured').length,
    prefiltered: entries.filter((e) => e.state === 'prefiltered').length,
    deferred: entries.filter((e) => e.state === 'deferred').length,
    screened: entries.filter((e) => e.screened).length,
    queuedUnscreened: entries.filter((e) => e.state === 'queued' && !e.screened).length,
    heldOnOwnershipReading: heldCheap.length,
    heldNearMiss: heldCheap.filter((e) => e.shortfalls.length === 1).length,
  };
}

/**
 * The feed's product: wallets that cleared the gate and have not been through the screen.
 *
 * Ordered oldest-queued first so a queue that is drained slowly is drained fairly, and so the
 * printed list is stable between runs.
 *
 * @param {Ledger} ledger
 * @returns {LedgerEntry[]}
 */
export function queuedForScreen(ledger) {
  return Object.values(ledger.wallets)
    .filter((e) => e.state === 'queued' && !e.screened)
    .sort((a, b) => {
      const ga = a.gradedAtIso ?? a.firstSeenIso;
      const gb = b.gradedAtIso ?? b.firstSeenIso;
      if (ga !== gb) return ga < gb ? -1 : 1;
      return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
    });
}

/**
 * Median of a numeric sample. `NaN` for an empty one, which every caller here reports as "no
 * observation" rather than as a zero.
 *
 * @param {readonly number[]} values
 * @returns {number}
 */
export function medianOf(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? Number.NaN;
  return ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2;
}
