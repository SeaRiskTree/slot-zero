/**
 * The opening-window walk: every fill of a launch from its create slot to a fixed instant after it.
 *
 * ## ONE bound, in ONE unit — and that is the whole design
 *
 * `tools/deployer-screen/pumpfun.mjs` → `readLaunchWindow` reaches forward from the mint with **two**
 * bounds in **two units**: a seek cursor in milliseconds and a membership filter at
 * `createSlot + windowSlotSpan` (slots). For a long time nothing reconciled them but a hardcoded
 * nominal 400 ms/slot with about a second of headroom, and the chain has been slowing all year, so
 * the walk stopped fetching the last few seconds of the window it said it measured while reporting
 * `usable: true`, `reachedCreateSlot: true` and a note true in every clause.
 * `data/slot-zero-cursor-gap-walk-blast/report.md` §1 measured the consequence: 354 in-window fills
 * never fetched across 102 launches, 161 of them sells. Captain decision 144a re-denominated that
 * cursor in a measured worst-case slot rate — `pumpfun.mjs` → `windowReachMs` owns the fix — but the
 * two bounds are still two, kept in step by a pinned constant that has to be re-measured.
 *
 * This walk copies `tools/graduated-life-tape/walk.mjs` instead. **{@link seekCursor}(endMs) is the
 * seek AND `tsMs <= endMs` is the membership test**, so there is no conversion for a drifting slot
 * rate to invalidate. The class of defect is removed rather than bounded, and it cost nothing to
 * remove because this is new code in a new directory.
 *
 * ## The other end: a mint instant this walk does not trust to the millisecond
 *
 * The floor is `mintMs - mintFloorSlackMs`, not `mintMs`. The declared creation instant comes from
 * Dune's `created_at`, which is the **chain's block time**; the fills' `ts` comes from the vendor's
 * own clock at second resolution. `readLaunchWindow`'s pre-mint tripwire compares the two with
 * **zero slack** and its own comment warns that a positive skew of one millisecond would delete the
 * entire create slot — silently, and on a non-random subset. `preflight.mjs` measures the skew
 * before a collection is contemplated; the slack is what makes a residual skew survivable, and
 * `preMintFills` is what makes it *visible* rather than merely survived.
 *
 * ## Coverage is proved at the oldest end, never inferred
 *
 * Rows come back newest-first, so this walk runs backwards and reaches the create slot LAST. A walk
 * that stops early does not fail — it returns a plausible pile of fills whose earliest slot is
 * merely the earliest it saw, and a create-slot measure over that crowns a mid-window sniper as the
 * deployer. An opening window sits at the very start of a token's history, so the proof available
 * here is the strong one: the endpoint saying it holds nothing older. See `provesOlderThan`.
 *
 * ## What it persists, and why that is a captain decision
 *
 * Everything inside `[floorMs, endMs]`, every wallet, not only the create slot's. Captain decision
 * 164c: the create-slot-only series and the all-window-entrant series are both computed from **one**
 * pass, so the definitional choice is settled against real numbers rather than in advance. See
 * `series.mjs` for what that does and does not buy — the all-entrant reading is a **floor** and is
 * labelled one wherever it is produced.
 */

import { seekCursor, tradesUrl, parseTradePage, provesOlderThan, sortAscending, dedupeBySid } from './trades.mjs';
import { CeilingReached } from './client.mjs';

/**
 * @typedef {object} WalkResult
 * @property {string} mint
 * @property {import('./trades.mjs').Fill[]} fills Ascending by `sid`, deduplicated, window-filtered.
 * @property {number} pages        Pages successfully read.
 * @property {number} requests     Attempts issued for this launch, retries included.
 * @property {boolean} reachedMint Proved, never assumed.
 * @property {boolean} truncated   A ceiling stopped the walk before the proof arrived.
 * @property {number} floorMs      The membership floor actually applied, slack included.
 * @property {number} endMs        The single bound: the seek instant AND the membership ceiling.
 * @property {number | null} oldestFillMs
 * @property {number | null} newestFillMs
 * @property {number | null} createSlot  Oldest slot, and **only** on a proved walk.
 * @property {number} preMintFills Fills older than the DECLARED mint instant. Zero on a launch whose
 *   two clocks agree; non-zero is the skew `preflight.mjs` measures, arriving per launch.
 * @property {string | null} stopReason
 */

/**
 * Walk one launch's opening window.
 *
 * @param {object} args
 * @param {import('./client.mjs').KeylessClient} args.client
 * @param {string} args.mint
 * @param {number} args.mintMs          Declared creation instant — Dune's chain block time.
 * @param {number} args.windowMs        Width of the opening window, measured from `mintMs`.
 * @param {number} args.mintFloorSlackMs Backdating of the membership floor. See the module note.
 * @param {number} args.maxRequests     Attempts this launch may cost, retries included. **Requests,
 *   not pages**: the endpoint sheds about a quarter of every request when pushed, so a page budget
 *   understates the true cost by roughly threefold.
 * @param {(message: string) => void} [args.log]
 * @returns {Promise<WalkResult>}
 */
export async function walkOpeningWindow({
  client,
  mint,
  mintMs,
  windowMs,
  mintFloorSlackMs,
  maxRequests,
  log,
}) {
  const before = client.issued();
  const floorMs = mintMs - mintFloorSlackMs;
  const endMs = mintMs + windowMs;

  /** @type {import('./trades.mjs').Fill[]} */
  const collected = [];
  let pages = 0;
  let reachedMint = false;
  let truncated = false;
  /** @type {string | null} */
  let stopReason = null;
  /** @type {string | null} */
  let cursor = seekCursor(endMs);

  for (;;) {
    // Reserved BEFORE the request rather than checked after it, because one logical request may
    // cost up to `attemptsPerRequest()` attempts against the shared endpoint. A budget discovered
    // after the fact is a nominal budget, and the shed rate is exactly what makes the difference.
    if (client.issued() - before + client.attemptsPerRequest() > maxRequests) {
      truncated = true;
      stopReason = `per-launch request budget of ${maxRequests} would be exceeded before the mint was proved`;
      break;
    }

    /** @type {import('./trades.mjs').TradePage} */
    let page;
    try {
      page = parseTradePage(await client.getJson(tradesUrl(mint, cursor)));
    } catch (cause) {
      // A run ceiling is the run's own bound and must stop everything; anything else is this
      // launch's problem and is recorded as a gap rather than propagated into the run.
      if (cause instanceof CeilingReached) throw cause;
      stopReason = `request failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      break;
    }

    if (!page.recognised) {
      // Not "there is nothing older" — "we do not understand the answer". Collapsing the two is what
      // would let an unreadable body read as proof the walk had reached the create slot.
      stopReason = 'the endpoint returned a body no rows could be read from';
      break;
    }

    pages += 1;
    for (const f of page.fills) collected.push(f);

    if (provesOlderThan(page, floorMs)) {
      reachedMint = true;
      stopReason = page.hasMore === false ? 'the endpoint holds nothing older' : 'reached past the mint floor';
      break;
    }
    if (page.nextCursor === null) {
      // The endpoint offered no way forward but never said it had nothing more. That is not proof.
      stopReason = 'the endpoint offered no next cursor and did not say it was done';
      break;
    }
    cursor = page.nextCursor;
  }

  // ONE bound decides membership at the new end and it is the same number the seek used. The old end
  // carries the slack, so a create slot the two clocks disagree about by a second is kept and
  // counted rather than deleted.
  const kept = sortAscending(dedupeBySid(collected)).filter((f) => f.tsMs >= floorMs && f.tsMs <= endMs);

  let oldestFillMs = null;
  let newestFillMs = null;
  let oldestSlot = null;
  let preMintFills = 0;
  for (const f of kept) {
    if (oldestFillMs === null || f.tsMs < oldestFillMs) oldestFillMs = f.tsMs;
    if (newestFillMs === null || f.tsMs > newestFillMs) newestFillMs = f.tsMs;
    if (oldestSlot === null || f.slot < oldestSlot) oldestSlot = f.slot;
    if (f.tsMs < mintMs) preMintFills += 1;
  }

  log?.(`${mint}: ${kept.length} fills over ${pages} pages, reachedMint=${reachedMint}`);

  return {
    mint,
    fills: kept,
    pages,
    requests: client.issued() - before,
    reachedMint,
    truncated,
    floorMs,
    endMs,
    oldestFillMs,
    newestFillMs,
    // Only a *proved* walk's oldest slot is the create slot. On an unproved one it is merely the
    // oldest this walk happened to reach, which is precisely the mistake that would crown a
    // mid-window sniper as the deployer.
    createSlot: reachedMint ? oldestSlot : null,
    preMintFills,
    stopReason,
  };
}
