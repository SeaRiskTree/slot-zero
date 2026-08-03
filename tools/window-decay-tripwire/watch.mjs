/**
 * The tripwire's command line. **`--dry-run` is the default and issues nothing.**
 *
 *     node tools/window-decay-tripwire/watch.mjs --wallet <deployer> --state <file>          # plan only
 *     node tools/window-decay-tripwire/watch.mjs --wallet <deployer> --state <file> --live   # spend
 *
 * It watches ONE wallet — the one the operator is currently trading — and answers one question:
 * has that window closed? It does not find candidates, does not score entry, and never re-polls a
 * wallet it has stopped on. When it says `stop-and-rotate` the lane is over for that wallet:
 * a competent deployer does not loosen a launch bot it has just tightened (captain, 2026-08-02).
 *
 * ## Spend
 *
 * **Zero-token.** Both hosts it can reach are keyless and free, and the list is `HOSTS` in
 * `client.mjs`. There is no credential path in this directory at all — no environment read, no
 * header hook — and `test/window-decay-tripwire.test.ts` asserts it structurally rather than
 * trusting this paragraph.
 *
 * Bounded twice over. `thresholds.json` → `bounds` pins the per-run request ceiling, the per-launch
 * page cap and the number of launches one run will read; the client checks the ceiling before every
 * attempt including retries; and a dry run prints the exact plan — how many launches are new, how
 * many requests that is worst case, and whether it fits — before anything is spent.
 *
 * ## State, and why there is a file
 *
 * The decision needs two consecutive readings, and a run sees one launch at a time, so the streak
 * has to survive between runs. `--state` is that memory and it is the only thing this tool writes.
 * Without it every run starts from `watching` and the tripwire can never confirm — so the CLI
 * refuses a live run that has no state file rather than quietly becoming a single-launch alarm,
 * which is the design this lane measured and rejected.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CeilingReached, HttpRefused, KeylessClient } from './client.mjs';
import { Tripwire, classifyCreateSlot } from './detector.mjs';
import { creatorLaunchesUrl, isReadableMint, parseLaunchListing, readCreateSlot } from './createslot.mjs';

/** @type {{ detector: { shareBar: number, confirmLaunches: number }, bounds: Record<string, number> }} */
export const THRESHOLDS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./thresholds.json', import.meta.url)), 'utf8'),
);

/**
 * The caveat every verdict this tool prints must carry.
 *
 * It is not decoration and it is not only in a README: the whole latency result rests on ONE close,
 * of ONE window, on ONE deployer. `analysis/window-population/README.md` §8 states what would give
 * it a second observation and what that costs.
 */
export const SAMPLE_CAVEAT =
  'n = 1: this detector is calibrated on the single window the local tape contains and the single ' +
  'close it observed. Nothing measured here says another window would close the same way.';

/**
 * The second caveat, and it runs the other way from the first.
 *
 * A stop is one-way. The measured cost of stopping a window that was still running is about 380x
 * the cost of a launch of latency, so this instrument is deliberately built to be late rather than
 * wrong — and a `watching` verdict is therefore weaker evidence than a `stop-and-rotate` one.
 */
export const ASYMMETRY_CAVEAT =
  'A false stop is one-way and was measured at ~380x the cost of a launch of latency, so this ' +
  'tool is tuned to be late rather than wrong: "watching" is weaker evidence than "stop-and-rotate".';

/**
 * @typedef {object} StoredReading One settled launch, as the state file keeps it.
 * @property {string} mint
 * @property {string} at
 * @property {number | null} share
 * @property {import('./detector.mjs').Unread | null} unread
 * @property {string | null} [prevMint] The launch immediately BEFORE this one in the deployer's
 *   listing when it was read, or `null` when this run could not see one — the oldest launch the
 *   listing carries has no visible predecessor, and inventing adjacency there is the one error this
 *   field exists to refuse. `undefined` marks a reading written before the field existed, when the
 *   queue was strictly oldest-first and every reading was adjacent by construction.
 */

/**
 * @typedef {object} QuarantinedLaunch A launch this tool could not settle. Kept, never retired.
 * @property {string} mint
 * @property {string} at
 * @property {string} reason The walk's own `undecidedReason`, or the endpoint's refusal.
 */

/**
 * @typedef {object} WatchState What survives between runs. The only thing this tool writes.
 * @property {string} wallet
 * @property {'watching' | 'armed' | 'stop-and-rotate'} verdict
 * @property {number} streak Consecutive readings at or above the bar, over ADJACENT launches.
 * @property {string[]} readMints Mints already read, so a run never pays for one twice.
 * @property {StoredReading[]} readings
 * @property {QuarantinedLaunch[]} quarantine Launches read attempts could not settle. They are not
 *   in `readMints`, so every run retries them; they are listed here and printed so a growing tail
 *   is legible rather than something a reader has to infer from a count.
 * @property {string | null} stoppedAt ISO timestamp of the launch that raised the stop.
 */

/** @param {string} wallet @returns {WatchState} */
export const emptyState = (wallet) => ({
  wallet, verdict: 'watching', streak: 0, readMints: [], readings: [], quarantine: [], stoppedAt: null,
});

/**
 * Read a state file, refusing one that belongs to a different wallet.
 *
 * A state file carrying another wallet's streak would confirm a stop out of two unrelated launches,
 * which is the one way this design can produce a false stop from correct readings.
 *
 * @param {string | null} path
 * @param {string} wallet
 * @returns {WatchState}
 */
export function loadState(path, wallet) {
  if (path === null || !existsSync(path)) return emptyState(wallet);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw?.wallet !== wallet) throw new Error(`state file is for ${raw?.wallet}, not ${wallet}`);
  return { ...emptyState(wallet), ...raw };
}

/**
 * The saved readings in the deployer's launch order.
 *
 * Runs no longer record strictly oldest-first — a run reserves slots for the newest unread launches
 * so a tail of launches it cannot settle can never crowd the current end of the series out — so the
 * order readings were APPENDED in is not the order the launches happened in. Everything downstream
 * of here reasons about adjacency, and adjacency is a fact about launch order.
 *
 * Stable, and readings with no timestamp (the `--mints` path) therefore keep the order they were
 * recorded in rather than being sorted against a value they do not have.
 *
 * @param {readonly StoredReading[]} readings
 * @returns {StoredReading[]}
 */
export function orderReadings(readings) {
  return [...readings].sort((a, b) =>
    (a.at === '' || b.at === '' ? 0 : a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Split ordered readings into runs of launches that are **adjacent in the deployer's launch order**.
 *
 * A chain breaks wherever a reading's recorded predecessor is not the reading before it — i.e.
 * wherever a launch between the two has not been settled. It is self-healing: when that launch is
 * finally read, its own `prevMint` links the two halves and they become one chain.
 *
 * @param {readonly StoredReading[]} ordered
 * @returns {StoredReading[][]}
 */
export function chainsOf(ordered) {
  /** @type {StoredReading[][]} */ const chains = [];
  /** @type {StoredReading[]} */ let current = [];
  for (const reading of ordered) {
    const previous = current[current.length - 1];
    // `undefined` is a reading written before gaps were possible; it cannot break a chain.
    if (previous !== undefined && reading.prevMint !== undefined && reading.prevMint !== previous.mint) {
      chains.push(current);
      current = [];
    }
    current.push(reading);
  }
  if (current.length > 0) chains.push(current);
  return chains;
}

/** A latched stop outranks any streak; otherwise the longer run of adjacent breaches wins. */
const rank = (/** @type {Tripwire} */ tripwire) =>
  (tripwire.verdict === 'stop-and-rotate' ? Number.POSITIVE_INFINITY : tripwire.streak);

/**
 * Rebuild a {@link Tripwire} from the saved readings, **deriving** the streak rather than trusting
 * the scalar a previous run left behind.
 *
 * ## The design tension this resolves, and the choice made
 *
 * The instrument's correctness rests on TWO CONSECUTIVE readings, and "consecutive" means adjacent
 * in the deployer's launch order. Reserving part of each run's slice for the newest unread launches
 * — which is what stops a tail of unsettleable launches from crowding the current end of the series
 * out — means a run can read launch N+5 while N+1..N+4 are still unread. Readings therefore arrive
 * out of launch order, and an incremental streak counted in ARRIVAL order would be a statement
 * about nothing: it could confirm a stop out of two launches that were never neighbours.
 *
 * The choice: **the streak is derived, every run, from the record.** Readings are put back in launch
 * order, split into chains of adjacent launches ({@link chainsOf}), each chain replayed through the
 * production {@link Tripwire}, and the strongest result taken. That gives both halves of the
 * requirement at once:
 *
 * - It cannot MANUFACTURE a stop. Two breaches on non-adjacent launches sit in different chains and
 *   are never observed in sequence, so they cannot confirm each other.
 * - It cannot SUPPRESS one. The strongest chain wins rather than the newest, so a reading taken out
 *   of order never discards an armed chain elsewhere in the record; and when the gap between two
 *   chains is finally read, they merge and the streak that was always there is counted.
 *
 * A state file with no readings at all — one written before readings were recorded, or built by
 * hand — has nothing to derive from, so the saved scalar is used as-is. A latched stop is never
 * un-latched by a replay.
 *
 * @param {WatchState} state
 * @param {{ bar: number, confirmLaunches: number }} settings
 */
export function resume(state, settings) {
  /** @type {Tripwire | null} */ let strongest = null;
  for (const chain of chainsOf(orderReadings(state.readings))) {
    const tripwire = new Tripwire(settings);
    for (const r of chain) {
      tripwire.observe({
        mint: r.mint, at: r.at, share: r.share, unread: r.unread, slot: 0,
        deployerStake: 0, operationStake: 0, outsiderStake: 0, outsiderWallets: 0,
        operationWallets: [], cohortDerived: false,
      });
    }
    if (strongest === null || rank(tripwire) > rank(strongest)) strongest = tripwire;
  }
  if (strongest === null) {
    strongest = new Tripwire(settings);
    strongest.streak = state.streak;
    strongest.verdict = state.verdict;
  }
  if (state.verdict === 'stop-and-rotate') strongest.verdict = 'stop-and-rotate';
  return strongest;
}

/**
 * @typedef {object} Args
 * @property {string} wallet
 * @property {Set<string> | undefined} cohort
 * @property {string[]} mints Explicit mints. Empty means "list them from the wallet".
 * @property {string | null} state
 * @property {boolean} live
 * @property {number} maxRequests
 * @property {number} maxLaunches
 */

/**
 * @param {readonly string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */ const flags = {};
  let live = false;
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    if (a === '--live') { live = true; continue; }
    if (a === '--dry-run') { live = false; continue; }
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${a} needs a value`);
    flags[a.slice(2)] = next;
    i++;
  }
  const wallet = flags['wallet'];
  if (wallet === undefined || wallet === '') throw new Error('--wallet is required');
  const cohortRaw = flags['cohort'];
  return {
    wallet,
    cohort: cohortRaw === undefined ? undefined : new Set(cohortRaw.split(',').filter((w) => w !== '')),
    mints: (flags['mints'] ?? '').split(',').filter((m) => m !== ''),
    state: flags['state'] ?? null,
    live,
    maxRequests: positiveInteger('--max-requests', flags['max-requests'], THRESHOLDS.bounds['maxRequestsPerRun']),
    maxLaunches: positiveInteger('--max-launches', flags['max-launches'], THRESHOLDS.bounds['maxLaunchesPerRun']),
  };
}

/**
 * A bound the operator may lower, read strictly.
 *
 * `Number('eight')` is `NaN`, and every comparison a bound is used in is false against `NaN` —
 * `fresh.slice(0, NaN)` is empty — so a mistyped flag produced a run that read nothing and then
 * reported `WATCHING` over launches it never looked at. That is the one outcome this tool must
 * never produce quietly, so a value that is not a positive integer is refused here.
 *
 * @param {string} flag
 * @param {string | undefined} raw
 * @param {number | undefined} fallback
 * @returns {number}
 */
export function positiveInteger(flag, raw, fallback) {
  if (raw === undefined) return Number(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer, not "${raw}"`);
  return value;
}

/**
 * The worst-case request cost of a run, before it starts.
 *
 * Worst case, not expected: the ceiling has to be exact, and a plan that merely usually fits is a
 * plan that spends past its bound on the day it does not.
 *
 * @param {number} newLaunches
 * @param {boolean} needsListing
 * @param {number} [attemptsPerRequest]
 */
export function planCost(newLaunches, needsListing, attemptsPerRequest = 4) {
  const requests = (needsListing ? 1 : 0) + newLaunches * Number(THRESHOLDS.bounds['maxPagesPerLaunch']);
  return { requests, attempts: requests * attemptsPerRequest };
}

/**
 * One run: list, read the create slot of every launch not yet read, feed the detector, save.
 *
 * @param {Args} args
 * @param {object} [seams]
 * @param {typeof fetch} [seams.fetchImpl]
 * @param {(ms: number) => Promise<void>} [seams.sleepImpl]
 * @param {() => number} [seams.nowImpl]
 * @param {(line: string) => void} [seams.log]
 * @returns {Promise<{ state: WatchState, issued: number, plannedAttempts: number, read: number,
 *   undecided: number, abandoned: string | null }>} `undecided` counts launches this run could not
 *   settle — they are deliberately absent from `state.readMints` so the next run retries them.
 */
export async function run(args, seams = {}) {
  const log = seams.log ?? ((/** @type {string} */ line) => console.log(line));
  const settings = {
    bar: THRESHOLDS.detector.shareBar,
    confirmLaunches: THRESHOLDS.detector.confirmLaunches,
  };
  if (args.live && args.state === null) {
    throw new Error(
      '--live needs --state: the stop needs two consecutive readings and a run sees one launch, ' +
      'so without a state file this would silently become the single-launch alarm this lane rejected',
    );
  }
  const state = loadState(args.state, args.wallet);

  log(`wallet ${args.wallet}   verdict on entry: ${state.verdict} (streak ${state.streak}/${settings.confirmLaunches})`);
  if (state.verdict === 'stop-and-rotate') {
    // Latched. Re-reading a wallet this lane has already stopped on watches the one place a
    // competent deployer will not change its mind, and spends a request to do it.
    log(`STOP AND ROTATE already raised at ${state.stoppedAt}. This lane does not re-poll a stopped wallet.`);
    log(`  ${SAMPLE_CAVEAT}`);
    return { state, issued: 0, plannedAttempts: 0, read: 0, undecided: 0, abandoned: null };
  }

  const needsListing = args.mints.length === 0;
  const client = new KeylessClient({
    maxRequests: args.maxRequests,
    minIntervalMs: Number(THRESHOLDS.bounds['minIntervalMs']),
    fetchImpl: seams.fetchImpl,
    sleepImpl: seams.sleepImpl,
    nowImpl: seams.nowImpl,
  });

  // With `--mints` the number of launches is known before the first request, so the worst case is
  // that number rather than the bound. On the listing path the count genuinely is not known in
  // advance and the bound is the only honest worst case.
  const plannedLaunches = needsListing ? args.maxLaunches : Math.min(args.mints.length, args.maxLaunches);
  const worstCase = planCost(plannedLaunches, needsListing, client.attemptsPerRequest());

  if (!args.live) {
    const worst = worstCase;
    log('DRY RUN — nothing was requested.');
    log(`  plan: ${needsListing ? '1 launch listing + ' : ''}up to ${plannedLaunches} launches x ` +
      `${THRESHOLDS.bounds['maxPagesPerLaunch']} pages = ${worst.requests} requests, ` +
      `${worst.attempts} attempts worst case against a ceiling of ${args.maxRequests}` +
      `  — ${worst.attempts <= args.maxRequests ? 'FITS' : 'DOES NOT FIT'}`);
    log(`  hosts: both keyless, zero token. Pacing floor ${THRESHOLDS.bounds['minIntervalMs']} ms.`);
    log(`  ${SAMPLE_CAVEAT}`);
    log(`  ${ASYMMETRY_CAVEAT}`);
    return { state, issued: 0, plannedAttempts: worst.attempts, read: 0, undecided: 0, abandoned: null };
  }

  // Refused BEFORE the first request, not discovered by exhausting the budget half way through a
  // series. A run whose worst case does not fit inside the ceiling would abandon mid-series, and a
  // ceiling that is only enforced once it has been breached is a nominal one.
  if (worstCase.attempts > args.maxRequests) {
    throw new Error(
      `this plan does not fit: ${plannedLaunches} launches x ${THRESHOLDS.bounds['maxPagesPerLaunch']} pages` +
      `${needsListing ? ' + 1 listing' : ''} is ${worstCase.attempts} attempts worst case against a ceiling of ` +
      `${args.maxRequests}. Lower --max-launches or raise --max-requests; do not start a run that cannot finish.`,
    );
  }

  /** @type {Array<{ mint: string, createdAtMs: number | null, symbol: string }>} */ let queue = [];
  if (needsListing) {
    const listing = parseLaunchListing(
      await client.getJson(creatorLaunchesUrl(args.wallet, Number(THRESHOLDS.bounds['listingLimit']))),
    );
    // Unreadable is not empty. Reading it as "this wallet has launched nothing" would leave a
    // watcher sitting on `watching` forever while the window closed underneath it.
    if (!listing.recognised) throw new Error('could not read the launch listing — refusing to treat it as "no launches"');
    queue = listing.launches.map((l) => ({ mint: l.mint, createdAtMs: l.createdAtMs, symbol: l.symbol }));
    log(`  listing: ${listing.rawRows} rows, ${listing.launches.length} launches read`);
  } else {
    queue = args.mints.map((m) => ({ mint: m, createdAtMs: null, symbol: '' }));
  }

  // Mints are vendor-supplied or operator-supplied and land in a URL PATH, which `..`, `?` or `#`
  // rewrite; the host allow-list checks the host and cannot catch that. Dropped and counted, the
  // way `dune.mjs` handles a vendor-supplied wallet reaching a query surface — never narrowed away
  // silently, because a mint this tool cannot read is a launch it is not watching.
  const shaped = queue.filter((l) => isReadableMint(l.mint));
  const refusedByShape = queue.length - shaped.length;
  if (refusedByShape > 0) {
    log(`  ${refusedByShape} mint(s) refused by shape and dropped before any URL was built — this run does not cover them`);
  }
  queue = shaped;

  const ordered = [...queue].sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  // Every launch's immediate predecessor in the deployer's own series, read or unread. This is what
  // a reading records so that adjacency can be re-derived later; the oldest launch the listing
  // carries has no visible predecessor and gets `null` rather than an invented one.
  /** @type {Map<string, string | null>} */ const predecessor = new Map();
  ordered.forEach((l, i) => predecessor.set(l.mint, i === 0 ? null : /** @type {{mint: string}} */ (ordered[i - 1]).mint));

  const already = new Set(state.readMints);
  const fresh = ordered.filter((l) => !already.has(l.mint));

  // The slice is split. The OLDEST unread launches come first, because the streak is a statement
  // about adjacent launches and closing the gap behind us is what makes readings adjacent. But a
  // launch this tool cannot settle is never recorded as read, so it comes back at the head of that
  // queue on every future run — and enough of them would fill the whole slice and leave the watcher
  // re-reading dead mints while the current end of the series went unwatched. Reserving slots for
  // the NEWEST unread launches makes that impossible: whatever the tail does, every run still looks
  // at where the window actually is. Head + reserved never exceeds the bound, so the pinned worst
  // case is unchanged.
  const reserved = Math.min(Number(THRESHOLDS.bounds['reservedNewestPerRun']), Math.max(0, args.maxLaunches - 1));
  const headSlots = args.maxLaunches - reserved;
  const selected = fresh.slice(0, headSlots);
  const chosen = new Set(selected.map((l) => l.mint));
  /** @type {typeof selected} */ const newest = [];
  for (let i = fresh.length - 1; i >= 0 && newest.length < reserved; i--) {
    const l = /** @type {{ mint: string, createdAtMs: number | null, symbol: string }} */ (fresh[i]);
    if (chosen.has(l.mint)) continue;
    newest.unshift(l);
    chosen.add(l.mint);
  }
  selected.push(...newest);
  if (fresh.length > selected.length) {
    // Silently reading a few and calling the series covered is how a watcher reports "watching"
    // over a gap it never looked at.
    log(`  ${fresh.length} unread launches against a per-run bound of ${args.maxLaunches}: reading the OLDEST ` +
      `${headSlots} so the series closes up, plus the NEWEST ${newest.length} so the current end of the ` +
      'series is watched whatever the backlog does. Run again to catch up.');
  }

  let read = 0, undecided = 0;
  /** @type {string | null} */ let abandoned = null;
  /** @type {Map<string, QuarantinedLaunch>} */ const quarantinedNow = new Map();
  /** @type {Set<string>} */ const settledNow = new Set();
  let tripwire = resume(state, settings);
  for (const l of selected) {
    const at = l.createdAtMs === null ? '' : new Date(l.createdAtMs).toISOString();
    const label = `  ${at.slice(0, 16) || l.mint.slice(0, 12)} ${(l.symbol || '').padEnd(12)} `;
    /** @type {import('./createslot.mjs').CreateSlotWalk} */ let walk;
    try {
      walk = await readCreateSlot(client, l.mint, {
        deployer: args.wallet,
        createdAtMs: l.createdAtMs,
        maxPages: Number(THRESHOLDS.bounds['maxPagesPerLaunch']),
      });
    } catch (cause) {
      // Everything already read this run is kept and saved below. Abandoning a run is recoverable —
      // the next one picks the series up where this one stopped — but discarding readings is not,
      // and neither is recording a launch nobody managed to read as read.
      if (cause instanceof CeilingReached) {
        undecided += 1;
        quarantinedNow.set(l.mint, { mint: l.mint, at, reason: 'ceiling' });
        abandoned = cause.message;
        log(`${label}undecided (ceiling) — ${cause.message}, stopping this run early. Not recorded as read.`);
        break;
      }
      if (cause instanceof HttpRefused) {
        undecided += 1;
        quarantinedNow.set(l.mint, { mint: l.mint, at, reason: `refused: ${cause.message}` });
        log(`${label}undecided (${cause.message}) — not recorded as read; the next run retries it.`);
        continue;
      }
      throw cause;
    }
    // "We could not settle this launch" is not "this launch has nothing to read". Feeding the second
    // to the detector and then storing the mint as read destroys the evidence permanently, because a
    // mint in `readMints` is never fetched again — and an unread launch neither advances nor resets
    // the streak, so the close could pass with nothing in the state file saying it was missed.
    if (!walk.decided) {
      undecided += 1;
      quarantinedNow.set(l.mint, { mint: l.mint, at, reason: String(walk.undecidedReason) });
      log(`${label}undecided (${walk.undecidedReason}) — not recorded as read; the next run retries it.`);
      if (walk.undecidedReason === 'ceiling') { abandoned = 'the per-run request ceiling was reached'; break; }
      continue;
    }
    // A walk that could not prove it reached the create slot holds the earliest fills it happened
    // to see, which is a different launch's evidence in all but name. No fills reach the detector.
    const reading = classifyCreateSlot(l.mint, at, walk.proven ? walk.fills : [], {
      deployer: args.wallet, cohort: args.cohort,
    });
    read += 1;
    settledNow.add(l.mint);
    already.add(l.mint);
    state.readMints.push(l.mint);
    const prevMint = predecessor.get(l.mint) ?? null;
    state.readings.push({ mint: l.mint, at, share: reading.share, unread: reading.unread, prevMint });
    // Derived from the whole record rather than from arrival order, so a launch read out of order
    // cannot confirm a stop with a launch it was never adjacent to.
    tripwire = resume(state, settings);
    const adjacent = prevMint === null ? state.readings.length === 1 : already.has(prevMint);
    log(label +
      (reading.unread === null
        ? `share ${(reading.share ?? 0).toFixed(3)}  outsiders ${reading.outsiderStake.toFixed(2)} SOL` +
          ` in ${reading.outsiderWallets} wallets   streak ${tripwire.streak}   ${tripwire.verdict}`
        : `no reading (${reading.unread}) — skipped, neither advances nor resets the streak`) +
      (adjacent ? '' : '   [out of series order — recorded, and it joins the streak when the gap is read]'));
    if (tripwire.verdict === 'stop-and-rotate') break;
  }

  state.verdict = tripwire.verdict;
  state.streak = tripwire.streak;
  state.quarantine = [
    ...state.quarantine.filter((q) => !settledNow.has(q.mint) && !quarantinedNow.has(q.mint)),
    ...quarantinedNow.values(),
  ];
  if (state.verdict === 'stop-and-rotate' && state.stoppedAt === null) {
    state.stoppedAt = tripwire.evidence[tripwire.evidence.length - 1]?.at ?? null;
  }

  log('');
  log(`VERDICT: ${state.verdict.toUpperCase()}`);
  if (state.verdict === 'stop-and-rotate') {
    log('  the window this wallet was paying is closed. Rotate. This lane will not re-poll it.');
    log('  evidence: ' + tripwire.evidence.map((e) => `${e.at.slice(0, 10)} share ${(e.share ?? 0).toFixed(3)}`).join(' then '));
  } else if (state.verdict === 'armed') {
    log('  ONE reading at or above the bar. Fast and uncertain — measured wrong 3 times in 104 open-window');
    log('  launches, so it is deliberately not a stop. The next reading decides.');
  }
  if (undecided > 0) {
    log(`  ${undecided} launch(es) left UNDECIDED and NOT recorded as read — this verdict does not cover them,`);
    log('  and the next run retries them. Run again before treating "watching" as a reading of the series.');
  }
  if (state.quarantine.length > 0) {
    log(`  QUARANTINE — ${state.quarantine.length} launch(es) this tool has not been able to settle. They are`);
    log('  retried every run and never recorded as read, and every run reserves slots for the newest');
    log('  launches so this list cannot crowd the current end of the series out:');
    for (const q of state.quarantine) log(`    ${q.at.slice(0, 16) || '(no timestamp)'}  ${q.mint}  ${q.reason}`);
  }
  if (abandoned !== null) log(`  run abandoned early: ${abandoned}. Everything read before that point is saved.`);
  log(`  requests issued ${client.issued()}, shed ${client.shed()}, transport failures ${client.transportFailures()}`);
  log(`  ${SAMPLE_CAVEAT}`);
  log(`  ${ASYMMETRY_CAVEAT}`);

  if (args.state !== null) writeFileSync(args.state, `${JSON.stringify(state, null, 2)}\n`);
  return { state, issued: client.issued(), plannedAttempts: 0, read, undecided, abandoned };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
