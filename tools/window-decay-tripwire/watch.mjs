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

import { CeilingReached, KeylessClient } from './client.mjs';
import { Tripwire, classifyCreateSlot } from './detector.mjs';
import { creatorLaunchesUrl, parseLaunchListing, readCreateSlot } from './createslot.mjs';

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
 * @typedef {object} WatchState What survives between runs. The only thing this tool writes.
 * @property {string} wallet
 * @property {'watching' | 'armed' | 'stop-and-rotate'} verdict
 * @property {number} streak Consecutive readings at or above the bar.
 * @property {string[]} readMints Mints already read, so a run never pays for one twice.
 * @property {Array<{ mint: string, at: string, share: number | null, unread: string | null }>} readings
 * @property {string | null} stoppedAt ISO timestamp of the launch that raised the stop.
 */

/** @param {string} wallet @returns {WatchState} */
export const emptyState = (wallet) => ({
  wallet, verdict: 'watching', streak: 0, readMints: [], readings: [], stoppedAt: null,
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
 * Rebuild a {@link Tripwire} at the streak a previous run left it at.
 *
 * @param {WatchState} state
 * @param {{ bar: number, confirmLaunches: number }} settings
 */
export function resume(state, settings) {
  const tripwire = new Tripwire(settings);
  tripwire.streak = state.streak;
  tripwire.verdict = state.verdict;
  return tripwire;
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
    maxRequests: Number(flags['max-requests'] ?? THRESHOLDS.bounds['maxRequestsPerRun']),
    maxLaunches: Number(flags['max-launches'] ?? THRESHOLDS.bounds['maxLaunchesPerRun']),
  };
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
 * @returns {Promise<{ state: WatchState, issued: number, plannedAttempts: number, read: number }>}
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
    return { state, issued: 0, plannedAttempts: 0, read: 0 };
  }

  const needsListing = args.mints.length === 0;
  const client = new KeylessClient({
    maxRequests: args.maxRequests,
    minIntervalMs: Number(THRESHOLDS.bounds['minIntervalMs']),
    fetchImpl: seams.fetchImpl,
    sleepImpl: seams.sleepImpl,
    nowImpl: seams.nowImpl,
  });

  if (!args.live) {
    const worst = planCost(args.maxLaunches, needsListing, client.attemptsPerRequest());
    log('DRY RUN — nothing was requested.');
    log(`  plan: ${needsListing ? '1 launch listing + ' : ''}up to ${args.maxLaunches} launches x ` +
      `${THRESHOLDS.bounds['maxPagesPerLaunch']} pages = ${worst.requests} requests, ` +
      `${worst.attempts} attempts worst case against a ceiling of ${args.maxRequests}` +
      `  — ${worst.attempts <= args.maxRequests ? 'FITS' : 'DOES NOT FIT'}`);
    log(`  hosts: both keyless, zero token. Pacing floor ${THRESHOLDS.bounds['minIntervalMs']} ms.`);
    log(`  ${SAMPLE_CAVEAT}`);
    log(`  ${ASYMMETRY_CAVEAT}`);
    return { state, issued: 0, plannedAttempts: worst.attempts, read: 0 };
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

  const already = new Set(state.readMints);
  const fresh = queue.filter((l) => !already.has(l.mint)).sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  if (fresh.length > args.maxLaunches) {
    // Silently reading the newest few and calling the series covered is how a watcher reports
    // "watching" over a gap it never looked at.
    log(`  ${fresh.length} unread launches against a per-run bound of ${args.maxLaunches}: reading the OLDEST ` +
      `${args.maxLaunches} so the series stays contiguous. Run again to catch up.`);
  }

  const tripwire = resume(state, settings);
  let read = 0;
  for (const l of fresh.slice(0, args.maxLaunches)) {
    /** @type {import('./createslot.mjs').CreateSlotWalk} */ let walk;
    try {
      walk = await readCreateSlot(client, l.mint, {
        deployer: args.wallet,
        createdAtMs: l.createdAtMs,
        maxPages: Number(THRESHOLDS.bounds['maxPagesPerLaunch']),
      });
    } catch (cause) {
      if (cause instanceof CeilingReached) { log(`  ${cause.message} — stopping this run early`); break; }
      throw cause;
    }
    const at = l.createdAtMs === null ? '' : new Date(l.createdAtMs).toISOString();
    // A walk that could not prove it reached the create slot holds the earliest fills it happened
    // to see, which is a different launch's evidence in all but name. No fills reach the detector.
    const reading = classifyCreateSlot(l.mint, at, walk.proven ? walk.fills : [], {
      deployer: args.wallet, cohort: args.cohort,
    });
    const step = tripwire.observe(reading);
    read += 1;
    state.readMints.push(l.mint);
    state.readings.push({ mint: l.mint, at, share: reading.share, unread: reading.unread });
    log(`  ${at.slice(0, 16) || l.mint.slice(0, 12)} ${(l.symbol || '').padEnd(12)} ` +
      (reading.unread === null
        ? `share ${(reading.share ?? 0).toFixed(3)}  outsiders ${reading.outsiderStake.toFixed(2)} SOL` +
          ` in ${reading.outsiderWallets} wallets   streak ${step.streak}   ${step.verdict}`
        : `no reading (${reading.unread}) — skipped, neither advances nor resets the streak`));
    if (step.verdict === 'stop-and-rotate') { state.stoppedAt = at; break; }
  }

  state.verdict = tripwire.verdict;
  state.streak = tripwire.streak;

  log('');
  log(`VERDICT: ${state.verdict.toUpperCase()}`);
  if (state.verdict === 'stop-and-rotate') {
    log('  the window this wallet was paying is closed. Rotate. This lane will not re-poll it.');
    log('  evidence: ' + tripwire.evidence.map((e) => `${e.at.slice(0, 10)} share ${(e.share ?? 0).toFixed(3)}`).join(' then '));
  } else if (state.verdict === 'armed') {
    log('  ONE reading at or above the bar. Fast and uncertain — measured wrong 3 times in 104 open-window');
    log('  launches, so it is deliberately not a stop. The next reading decides.');
  }
  log(`  requests issued ${client.issued()}, shed ${client.shed()}, transport failures ${client.transportFailures()}`);
  log(`  ${SAMPLE_CAVEAT}`);
  log(`  ${ASYMMETRY_CAVEAT}`);

  if (args.state !== null) writeFileSync(args.state, `${JSON.stringify(state, null, 2)}\n`);
  return { state, issued: client.issued(), plannedAttempts: 0, read };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
