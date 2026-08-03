/**
 * Pin the graduation instant of one launch, by geometric bisection on the venue field.
 *
 * This is a re-derivation of the method in `kol-bond-timing-vs-dev-exit` §2.1, which measured all
 * 103 graduation timestamps and then left them in that task's `/tmp`. It is re-derived rather than
 * transcribed on purpose: a number this whole collection is *bounded by* has to be reproducible
 * from committed code and committed data, and a table pasted out of an uncommitted report is not.
 *
 * ## Why bisection is legitimate here
 *
 * The venue sequence of a token is monotone: every fill before the migration is on the bonding
 * curve (`pump`), every fill after it is on PumpSwap (`pump_amm`), and a token never goes back. So
 * "had this token graduated by instant T" is a monotone predicate, and a monotone predicate over a
 * seekable index can be bisected. The scout verified monotonicity on 18 on-disk tapes with zero
 * violations, and verified the venue field itself on-chain against the two program ids.
 *
 * ## Why *geometric* bisection
 *
 * The unknown is the age from mint, and it ranges over five orders of magnitude in this population
 * — `Lockin` bonded in under a second, `Moonbase` took weeks. Arithmetic bisection over that range
 * spends most of its probes resolving the top decade and lands with useless absolute precision at
 * the bottom of it. Bisecting the **logarithm** reaches a fixed *relative* precision in a fixed
 * number of probes regardless of scale: ~9 probes for ~2%, whether the answer is 5 seconds or
 * 30 days.
 *
 * ## Two accelerations, and why they are exact rather than approximate
 *
 * - **A page holding both venues brackets the migration between two adjacent fills.** Rows come
 *   back newest-first and the venue sequence is monotone, so such a page reads
 *   `[AMM … AMM, curve … curve]` and the migration sits in the gap. That is an *exact* answer, not
 *   a converged one, and it terminates the search wherever it happens.
 * - **The on-disk committed window tape is free.** Eighteen launches bonded inside their own
 *   opening window, so their migration is already bracketed in committed data at **zero requests**.
 *
 * ## What "the graduation instant" means here, exactly
 *
 * The timestamp of the **first PumpSwap trade**, not of the migration instruction. Those differ by
 * 0–3 seconds where both are visible. At a median bond of +17 minutes that is immaterial; it would
 * matter to anyone who needs sub-second precision, and this tape cannot give it to them.
 */

import { tradesUrl, seekCursor, parseTradePage, VENUE_AMM, VENUE_CURVE } from './trades.mjs';

/** Relative bracket width at which the bisection stops. ~2%, the scout's setting. */
export const RELATIVE_TOLERANCE = 0.02;

/** Absolute bracket width at which the bisection stops regardless of relative width, in ms. */
export const ABSOLUTE_TOLERANCE_MS = 1_000;

/**
 * Probe ceiling per launch.
 *
 * Geometric bisection over the widest range in this population (1 s to ~40 days, ~21.8 doublings)
 * needs `log2(21.8 / log2(1.02))` ≈ 10 probes to reach the tolerance. Fourteen leaves margin for
 * the pathological case without letting one launch eat the run's budget.
 */
export const MAX_PROBES = 14;

/**
 * The floor of the search, in ms of age from mint.
 *
 * Geometric bisection cannot start at zero. One second is below the resolution of the endpoint's
 * timestamps anyway, so a launch that graduates "at" or before it is reported as bracket `[0, 1s]`
 * rather than bisected further — which is the honest answer, not a shortcut.
 */
export const MIN_AGE_MS = 1_000;

/**
 * @typedef {object} Graduation
 * @property {string} mint
 * @property {boolean} graduated
 * @property {number | null} gradMs      Best estimate: the earliest instant *known* to be post-migration.
 * @property {number | null} lowerMs     Latest instant known to be pre-migration. The bracket's floor.
 * @property {number | null} bracketMs   `gradMs - lowerMs`. **Zero is a real and common value**, not
 *   a missing one: the endpoint's timestamps are second-resolution, so a migration bracketed
 *   between two adjacent fills in the same second reads as a zero-width bracket. It means "exact to
 *   the resolution the endpoint has", never "unmeasured".
 * @property {'tape' | 'page' | 'bisect' | 'unresolved'} source
 * @property {number} probes             Requests this launch cost. `tape` costs zero.
 * @property {number | null} lastTradeMs The newest fill the endpoint holds. The walk's outer bound.
 * @property {string | null} note
 */

/**
 * Bracket the migration from an already-in-hand, newest-first run of fills.
 *
 * Used twice: on the committed window tape (zero requests) and on any fetched page that
 * happens to straddle the boundary. The caller supplies fills in **any** order; monotonicity in
 * time is what makes the bracket exact, not the array's order.
 *
 * @param {readonly import('./trades.mjs').Fill[]} fills
 * @returns {{ lowerMs: number, gradMs: number } | null} `null` when the run does not straddle it.
 */
export function bracketFromFills(fills) {
  let lastCurveMs = -Infinity;
  let firstAmmMs = Infinity;
  for (const f of fills) {
    if (f.p === VENUE_CURVE && f.tsMs > lastCurveMs) lastCurveMs = f.tsMs;
    if (f.p === VENUE_AMM && f.tsMs < firstAmmMs) firstAmmMs = f.tsMs;
  }
  if (lastCurveMs === -Infinity || firstAmmMs === Infinity) return null;
  // A straddle with the AMM fill *older* than the last curve fill would mean the venue sequence is
  // not monotone, which would invalidate the bisection outright. Refused rather than averaged.
  if (firstAmmMs < lastCurveMs) return null;
  return { lowerMs: lastCurveMs, gradMs: firstAmmMs };
}

/**
 * The venue in force at the instant a page was seeked to.
 *
 * The page holds fills at or older than the seek, newest first, so the newest row's venue is the
 * venue then in force. An empty page means the seek landed before the token's first fill, which is
 * pre-migration by construction.
 *
 * @param {import('./trades.mjs').TradePage} page
 * @returns {boolean | null} `true` graduated by then, `false` not, `null` unreadable.
 */
export function graduatedByPage(page) {
  if (!page.recognised) return null;
  if (page.fills.length === 0) return false;
  let newest = page.fills[0];
  for (const f of page.fills) if (f.sid > /** @type {import('./trades.mjs').Fill} */ (newest).sid) newest = f;
  return /** @type {import('./trades.mjs').Fill} */ (newest).p === VENUE_AMM;
}

/**
 * Find the graduation instant of one launch.
 *
 * @param {object} args
 * @param {import('./client.mjs').KeylessClient} args.client
 * @param {string} args.mint
 * @param {number} args.mintMs
 * @param {readonly import('./trades.mjs').Fill[]} [args.tapeFills] The committed 60 s window, if held.
 * @param {(message: string) => void} [args.log]
 * @returns {Promise<Graduation>}
 */
export async function findGraduation({ client, mint, mintMs, tapeFills = [], log }) {
  // Free first. Eighteen launches bonded inside their own opening window and are already bracketed
  // in committed data; spending a request to rediscover that would be spending a shared public
  // resource on something we already own.
  const fromTape = bracketFromFills(tapeFills);
  if (fromTape !== null) {
    return {
      mint,
      graduated: true,
      gradMs: fromTape.gradMs,
      lowerMs: fromTape.lowerMs,
      bracketMs: fromTape.gradMs - fromTape.lowerMs,
      source: 'tape',
      probes: 0,
      lastTradeMs: null,
      note: 'bracketed inside the committed 60-second window tape; zero requests',
    };
  }

  let probes = 0;
  /** @param {string | null} cursor */
  const probe = async (cursor) => {
    probes += 1;
    return parseTradePage(await client.getJson(tradesUrl(mint, cursor)));
  };

  // The uncursored page does three jobs for one request: it says whether the token ever graduated,
  // it fixes the outer bound of every later walk (`lastTradeMs`), and it can terminate the search
  // outright on a token that bonded within its final hundred fills.
  const head = await probe(null);
  if (!head.recognised) {
    return blank(mint, probes, 'the endpoint returned a body no rows could be read from');
  }
  if (head.fills.length === 0) {
    return blank(mint, probes, 'the endpoint holds no fills for this mint');
  }
  let lastTradeMs = -Infinity;
  for (const f of head.fills) if (f.tsMs > lastTradeMs) lastTradeMs = f.tsMs;

  const headBracket = bracketFromFills(head.fills);
  if (headBracket !== null) {
    return {
      mint,
      graduated: true,
      gradMs: headBracket.gradMs,
      lowerMs: headBracket.lowerMs,
      bracketMs: headBracket.gradMs - headBracket.lowerMs,
      source: 'page',
      probes,
      lastTradeMs,
      note: 'the newest page straddled the migration',
    };
  }

  if (graduatedByPage(head) !== true) {
    // Monotone: if the newest fill of all is still on the curve, the token has not migrated. For a
    // launch the committed tape marks `graduated=1` this is a contradiction, not a measurement, and
    // it is reported as one rather than folded into a number.
    return {
      mint,
      graduated: false,
      gradMs: null,
      lowerMs: null,
      bracketMs: null,
      source: 'unresolved',
      probes,
      lastTradeMs,
      note: 'the newest fill is still on the bonding curve — this token has not migrated',
    };
  }

  // Invariant from here: G(lowerAge) is false, G(upperAge) is true.
  let lowerAge = 0;
  let upperAge = Math.max(MIN_AGE_MS, lastTradeMs - mintMs);

  while (probes < MAX_PROBES) {
    const lo = Math.max(MIN_AGE_MS, lowerAge);
    if (upperAge - lowerAge <= ABSOLUTE_TOLERANCE_MS) break;
    if (upperAge / lo - 1 <= RELATIVE_TOLERANCE) break;

    // Geometric mean of the bracket. Rounded to the second the endpoint actually resolves, and
    // nudged inside the bracket so a rounding tie cannot re-probe an endpoint we already know.
    let midAge = Math.round(Math.sqrt(lo * upperAge) / 1000) * 1000;
    if (midAge <= lowerAge) midAge = lowerAge + 1000;
    if (midAge >= upperAge) midAge = upperAge - 1000;
    if (midAge <= lowerAge) break;

    const page = await probe(seekCursor(mintMs + midAge));
    if (!page.recognised) break;

    const straddle = bracketFromFills(page.fills);
    if (straddle !== null) {
      return {
        mint,
        graduated: true,
        gradMs: straddle.gradMs,
        lowerMs: straddle.lowerMs,
        bracketMs: straddle.gradMs - straddle.lowerMs,
        source: 'page',
        probes,
        lastTradeMs,
        note: `a probe page at +${Math.round(midAge / 1000)}s straddled the migration`,
      };
    }

    if (graduatedByPage(page) === true) upperAge = midAge;
    else lowerAge = midAge;
  }

  log?.(`${mint}: bisection converged in ${probes} probes`);
  return {
    mint,
    graduated: true,
    gradMs: mintMs + upperAge,
    lowerMs: mintMs + lowerAge,
    bracketMs: upperAge - lowerAge,
    source: 'bisect',
    probes,
    lastTradeMs,
    note:
      probes >= MAX_PROBES
        ? `probe ceiling of ${MAX_PROBES} reached; the bracket is as narrow as this run made it`
        : null,
  };
}

/**
 * @param {string} mint
 * @param {number} probes
 * @param {string} note
 * @returns {Graduation}
 */
function blank(mint, probes, note) {
  return {
    mint,
    graduated: false,
    gradMs: null,
    lowerMs: null,
    bracketMs: null,
    source: 'unresolved',
    probes,
    lastTradeMs: null,
    note,
  };
}
