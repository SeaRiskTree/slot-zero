/**
 * The clock pre-flight. **Run before any paced fetching, and cheap enough that skipping it is never
 * the economical choice.**
 *
 * ## The failure it exists to catch
 *
 * This walk's mint instant comes from Dune's `created_at`, which is the **chain's block time**.
 * Every fill's `ts` comes from the vendor's own clock at second resolution. `readLaunchWindow`'s
 * pre-mint tripwire compares the two with **zero slack**, and its own comment warns that a positive
 * skew of one millisecond would delete the entire create slot. `data/slot-zero-cursor-gap-walk-blast/report.md`
 * §7.7 ranks the clock swap seventh of the biases it found and says why it is worth a pre-flight
 * anyway: the evidence that it is fine is n = 5 and was never checked against the Dune column, and
 * the failure is silent, systematic and would land on a non-random subset of launches.
 *
 * ## Two legs, and only one of them needs anything this repo does not already hold
 *
 * - **Leg A — chain block time against the vendor's creation instant.** Keyless, bounded, runnable
 *   with nothing but this repository. For a handful of the committed 239 launches, ask
 *   `api.mainnet-beta.solana.com` for `getBlockTime(createSlot)` and compare it against the window
 *   sidecar's `created_timestamp`. Dune's `evt_block_time` **is** the block time of the block the
 *   creation landed in, so this measures the same difference from the same side of it. That the two
 *   are the same quantity is an inference from Dune's decoded-table schema rather than a
 *   measurement, which is exactly why leg B exists and is not optional before a real collection.
 * - **Leg B — Dune's `created_at` against the same vendor instants.** Pure arithmetic over the
 *   launch-list export `cohort.mjs` already requires, so it costs **no request and no execution**.
 *   It is the direct form of the check and it runs the moment that file exists.
 *
 * ## What a result means
 *
 * The number that matters is the **positive** skew — the declared mint instant landing *after* the
 * create-slot fills. That is the direction that deletes a create slot. `walk.mjs` backdates its
 * membership floor by `mintFloorSlackMs` precisely so a residual skew is survivable; this module
 * decides whether the pinned slack is large enough, and refuses rather than shrugging if it is not.
 *
 * Both clocks are **second-resolution**, so a measured skew of 0 ms means "within one second", never
 * "identical". {@link SECOND_RESOLUTION_MS} is carried into the verdict's own arithmetic rather than
 * left for a reader to remember.
 */

import { CeilingReached } from './client.mjs';

/** Both clocks in play are second-resolution, so every comparison carries this much granularity. */
export const SECOND_RESOLUTION_MS = 1_000;

/**
 * Read one block's time, in ms.
 *
 * **A `null` result is load-shedding, never "this block has no time".** The public RPC sheds inside
 * a response rather than erroring, and reading a null as a verdict is how a shed request becomes a
 * measurement of zero. Retried within a bounded attempt count and reported as unmeasured if it never
 * answers.
 *
 * @param {import('./client.mjs').KeylessClient} client
 * @param {number} slot
 * @param {number} attempts Bounded by the caller; each attempt is one request against the ceiling.
 * @throws {CeilingReached} The run's own request ceiling, propagated exactly as `walk.mjs` does. It
 *   is not a failure of this launch: swallowing it would burn the whole attempt budget of every
 *   remaining launch against a client that throws immediately, and would report them as merely
 *   unread rather than as "the ceiling stopped the pre-flight".
 * @returns {Promise<{ blockTimeMs: number | null, note: string | null }>}
 */
export async function readBlockTimeMs(client, slot, attempts) {
  /** @type {string | null} */
  let note = null;
  for (let i = 0; i < attempts; i++) {
    /** @type {unknown} */
    let body;
    try {
      body = await client.rpc('getBlockTime', [slot]);
    } catch (cause) {
      if (cause instanceof CeilingReached) throw cause;
      note = `request failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      continue;
    }
    const envelope = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
    if (envelope['error'] !== undefined) {
      // A JSON-RPC error envelope is the endpoint's considered answer about our question. Asking
      // again buys the same answer, so it stops here rather than spending the attempt budget.
      return { blockTimeMs: null, note: `rpc error: ${JSON.stringify(envelope['error'])}` };
    }
    const result = envelope['result'];
    if (typeof result === 'number' && Number.isFinite(result)) return { blockTimeMs: result * 1000, note: null };
    note = 'the endpoint returned a null result, which is load-shedding rather than an absent block time';
  }
  return { blockTimeMs: null, note };
}

/**
 * Choose the pre-flight's launches: spread across the tape's own time range, deterministically.
 *
 * Spread rather than sampled at random, and spread rather than taken from one end, because the
 * quantity under test is a *systematic* skew between two clocks and both clocks have been running
 * for the whole tape. A handful from one week would answer for one week.
 *
 * Only launches with a **proved** create slot are eligible: on an uncovered window the oldest slot
 * is merely the oldest the builder reached, and asking the chain what time that block was produced
 * would compare the vendor's creation instant against some mid-window sniper's block.
 *
 * @param {readonly import('./tape.mjs').LaunchRow[]} launches
 * @param {(mint: string) => import('./tape.mjs').WindowTape | null} readTape
 * @param {number} n
 * @returns {{ mint: string, symbol: string, createSlot: number, vendorMs: number }[]}
 */
export function selectPreflightLaunches(launches, readTape, n) {
  /** @type {{ mint: string, symbol: string, createSlot: number, vendorMs: number }[]} */
  const eligible = [];
  for (const l of launches) {
    const tape = readTape(l.mint);
    if (tape === null || !tape.reachedMint || tape.createSlot === null) continue;
    const vendorMs = tape.createdTimestamp ?? l.mintMs;
    if (!Number.isFinite(vendorMs)) continue;
    eligible.push({ mint: l.mint, symbol: l.symbol, createSlot: tape.createSlot, vendorMs });
  }
  eligible.sort((a, b) => a.vendorMs - b.vendorMs || (a.mint < b.mint ? -1 : 1));
  if (eligible.length <= n) return eligible;
  /** @type {{ mint: string, symbol: string, createSlot: number, vendorMs: number }[]} */
  const picked = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (eligible.length - 1)) / (n - 1 || 1));
    const row = eligible[idx];
    if (row !== undefined && !picked.some((p) => p.mint === row.mint)) picked.push(row);
  }
  return picked;
}

/**
 * @typedef {object} SkewSample
 * @property {string} mint
 * @property {string} symbol
 * @property {number} vendorMs   The vendor's creation instant.
 * @property {number | null} chainMs The other clock's, or `null` when it could not be read.
 * @property {number | null} skewMs `chainMs - vendorMs`. **Positive means the chain clock is LATER**,
 *   which is the direction that deletes a create slot.
 * @property {string | null} note
 */

/**
 * Leg A: chain block time against the vendor's creation instant, over a bounded sample.
 *
 * **The run's request ceiling stops the leg; it does not fail a launch.** Once the client refuses,
 * every further attempt would throw without issuing anything, so continuing would spend the whole
 * attempt budget of every remaining launch on nothing and report them as merely unread. The launch
 * in flight is recorded with the ceiling named in its note, and the rest are simply not attempted —
 * so a reader of `preflight.json` sees a stopped pre-flight rather than a partly unreadable chain.
 *
 * @param {object} args
 * @param {import('./client.mjs').KeylessClient} args.client
 * @param {ReturnType<typeof selectPreflightLaunches>} args.launches
 * @param {number} args.attemptsPerLaunch
 * @param {(message: string) => void} [args.log]
 * @returns {Promise<SkewSample[]>}
 */
export async function measureBlockTimeSkew({ client, launches, attemptsPerLaunch, log }) {
  /** @type {SkewSample[]} */
  const out = [];
  for (const l of launches) {
    /** @type {{ blockTimeMs: number | null, note: string | null }} */
    let read;
    try {
      read = await readBlockTimeMs(client, l.createSlot, attemptsPerLaunch);
    } catch (cause) {
      if (!(cause instanceof CeilingReached)) throw cause;
      out.push({
        mint: l.mint,
        symbol: l.symbol,
        vendorMs: l.vendorMs,
        chainMs: null,
        skewMs: null,
        note: `the pre-flight's own request ceiling stopped it here: ${cause.message}. ` +
          `${launches.length - out.length - 1} launch(es) after this one were never attempted.`,
      });
      log?.(`preflight leg A stopped at its request ceiling after ${out.length - 1} launch(es): ${cause.message}`);
      break;
    }
    const { blockTimeMs, note } = read;
    out.push({
      mint: l.mint,
      symbol: l.symbol,
      vendorMs: l.vendorMs,
      chainMs: blockTimeMs,
      skewMs: blockTimeMs === null ? null : blockTimeMs - l.vendorMs,
      note,
    });
    log?.(
      `${l.symbol} ${l.mint}: slot ${l.createSlot} chain=${blockTimeMs ?? '?'} vendor=${l.vendorMs} ` +
        `skew=${blockTimeMs === null ? '?' : blockTimeMs - l.vendorMs}ms`,
    );
  }
  return out;
}

/**
 * Leg B: Dune's `created_at` against the vendor's creation instant. Offline, no request.
 *
 * @param {readonly {mint: string, createdAtMs: number}[]} duneLaunches
 * @param {(mint: string) => import('./tape.mjs').WindowTape | null} readTape
 * @returns {SkewSample[]}
 */
export function measureDuneClockSkew(duneLaunches, readTape) {
  /** @type {SkewSample[]} */
  const out = [];
  for (const l of duneLaunches) {
    const tape = readTape(l.mint);
    const vendorMs = tape?.createdTimestamp ?? null;
    if (vendorMs === null) continue;
    out.push({
      mint: l.mint,
      symbol: '',
      vendorMs,
      chainMs: l.createdAtMs,
      skewMs: l.createdAtMs - vendorMs,
      note: null,
    });
  }
  return out;
}

/**
 * @typedef {object} SkewVerdict
 * @property {boolean} ok         Whether a collection may proceed on the pinned slack.
 * @property {number} measured    Samples with a skew.
 * @property {number} unmeasured  Samples whose other clock could not be read.
 * @property {number | null} medianSkewMs
 * @property {number | null} maxPositiveSkewMs The one that matters: the declared mint landing after
 *   the create-slot fills.
 * @property {number | null} maxNegativeSkewMs
 * @property {number} worstCaseMs `maxPositiveSkewMs` plus one second of shared clock granularity.
 * @property {string[]} reasons   Whole sentences, because these reach a report and a run record.
 */

/**
 * Decide whether the pinned floor slack survives the measured skew.
 *
 * Two ways this refuses, and neither is "the numbers looked odd":
 *
 * 1. **The worst positive skew, plus one second of shared second-resolution granularity, reaches the
 *    pinned slack.** At that point a create slot is one rounding away from being filtered out of its
 *    own window, silently, on whichever launches happen to sit at the bad end.
 * 2. **Nothing was measured at all.** An empty verdict is not a passing one. A pre-flight that
 *    could not read a single clock has established nothing, and the collection it would authorise is
 *    days long.
 *
 * @param {readonly SkewSample[]} samples
 * @param {number} slackMs The floor backdating `walk.mjs` will apply.
 * @returns {SkewVerdict}
 */
export function assessSkew(samples, slackMs) {
  const measured = samples.filter((s) => s.skewMs !== null).map((s) => /** @type {number} */ (s.skewMs));
  const unmeasured = samples.length - measured.length;
  /** @type {string[]} */
  const reasons = [];

  if (measured.length === 0) {
    reasons.push(
      'the pre-flight read no clock at all, so it has established nothing. An unmeasured skew is not ' +
        'a measured zero, and the collection it would authorise is days of paced fetching.',
    );
    return {
      ok: false,
      measured: 0,
      unmeasured,
      medianSkewMs: null,
      maxPositiveSkewMs: null,
      maxNegativeSkewMs: null,
      worstCaseMs: SECOND_RESOLUTION_MS,
      reasons,
    };
  }

  const sorted = [...measured].sort((a, b) => a - b);
  const medianSkewMs = /** @type {number} */ (sorted[Math.floor((sorted.length - 1) / 2)]);
  const maxPositiveSkewMs = Math.max(0, /** @type {number} */ (sorted[sorted.length - 1]));
  const maxNegativeSkewMs = Math.min(0, /** @type {number} */ (sorted[0]));
  const worstCaseMs = maxPositiveSkewMs + SECOND_RESOLUTION_MS;

  if (worstCaseMs >= slackMs) {
    reasons.push(
      `the worst measured positive skew is ${maxPositiveSkewMs} ms and both clocks are ` +
        `second-resolution, so a create slot can sit up to ${worstCaseMs} ms after the declared mint ` +
        `instant — at or past the ${slackMs} ms floor slack this walk applies. On those launches the ` +
        `create slot would be filtered out of its own window, silently and on a non-random subset. ` +
        `Raise the slack against this measurement or stop.`,
    );
  }
  if (unmeasured > 0 && measured.length < 3) {
    reasons.push(
      `only ${measured.length} sample(s) produced a skew, with ${unmeasured} unread. That is too few ` +
        `to say anything about a systematic difference between two clocks.`,
    );
  }

  return {
    ok: reasons.length === 0,
    measured: measured.length,
    unmeasured,
    medianSkewMs,
    maxPositiveSkewMs,
    maxNegativeSkewMs,
    worstCaseMs,
    reasons,
  };
}
