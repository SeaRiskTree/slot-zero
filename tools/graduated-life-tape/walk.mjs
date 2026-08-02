/**
 * The bounded backwards walk: every fill from a launch's mint to one hour after it graduated.
 *
 * ## Why this window and not another
 *
 * The committed population tape covers the first **60 seconds** of each launch. That was the right
 * window for the question it was built for and it is the wrong window for what is left, because the
 * median bond in this population lands at **+17 minutes** — so the 60-second window ends at roughly
 * 27% of the bond price, **52% of (wallet, launch) pairs are still open when it ends**, and every
 * counterparty who held past a minute currently has a P&L that is an artefact of where the window
 * stopped rather than of what they did. One hour past graduation covers the median peak (1.21× the
 * bond) and closes the great majority of those positions.
 *
 * ## Why it is bounded at all
 *
 * Because a whole-life walk on all 239 launches is ~9,500 requests and would spend most of them on
 * nothing. Three bounds cut it to roughly a quarter for the great majority of the information:
 *
 * - **Graduated launches only.** 98 of the 136 non-graduated sit within 1% of the empty curve with
 *   under 0.1 SOL of reserves and a median 42 days since their last trade. There is no price path
 *   left to reconstruct and the interesting part of their life is already inside the 60-second
 *   window. That alone is ~57% of the token count.
 * - **Stop at graduation + 1 hour**, which is knowable in advance because `graduation.mjs` pins it
 *   first. That is what makes this a bounded walk rather than an open-ended one.
 * - **Stop at the last trade.** Median idle time is 3.7 days for graduated tokens; walking past the
 *   point where a token goes quiet is strictly more expensive and returns nothing.
 *
 * ## The trap this module exists to refuse
 *
 * Rows come back newest-first, so this walk runs backwards and reaches the create slot **last**. A
 * walk that stops early does not fail — it returns a plausible pile of fills whose earliest slot is
 * merely the earliest it saw. Coverage is therefore never inferred from "we ran out of pages"; it
 * is `provesOlderThan`, the same standard as the committed tape's `meta.reached_mint`. When the
 * proof is absent the result says so in `reachedMint: false` and the caller must treat the oldest
 * end as missing, not as the beginning.
 */

import { tradesUrl, seekCursor, parseTradePage, provesOlderThan, sortAscending, dedupeBySid, VENUE_AMM } from './trades.mjs';
import { CeilingReached } from './client.mjs';

/** One hour past graduation, in ms. The widening this whole lane is for. */
export const POST_GRADUATION_MS = 3_600_000;

/**
 * Successful pages one launch may cost before the walk gives up on it.
 *
 * Set from the endpoint's own measured shape rather than from taste: per-launch page budgets on the
 * committed tape ran p50 4 / p90 8 / p95 13 / max 24 for a 60-second window, and the scout costed
 * this wider window at 10–40 pages. One hundred pages is 10,000 fills, four times the widest
 * launch in the tape, so a launch that hits it is genuinely enormous rather than merely busy — and
 * it is recorded as truncated rather than quietly short.
 *
 * **A truncated walk loses its OLDEST end**, which is the mint end — the most valuable part. That
 * is why the ceiling is generous and why `reachedMint` is reported per launch rather than summed.
 */
export const MAX_PAGES_PER_LAUNCH = 100;

/**
 * @typedef {object} WalkResult
 * @property {string} mint
 * @property {import('./trades.mjs').Fill[]} fills Ascending by `sid`, deduplicated, window-filtered.
 * @property {number} pages       Pages successfully read.
 * @property {number} requests    Attempts issued for this launch, retries included.
 * @property {boolean} reachedMint Proved, never assumed. See {@link provesOlderThan}.
 * @property {boolean} truncated  The page ceiling stopped the walk before the mint.
 * @property {number} fromMs      Oldest fill kept, or the bound if none.
 * @property {number} toMs        Newest fill kept, or the bound if none.
 * @property {number | null} oldestSlot
 * @property {number} ammFills    Fills on PumpSwap — the part no 60-second window could hold.
 * @property {string | null} stopReason
 */

/**
 * Walk one launch from `graduation + 1 hour` back to its mint.
 *
 * @param {object} args
 * @param {import('./client.mjs').KeylessClient} args.client
 * @param {string} args.mint
 * @param {number} args.mintMs
 * @param {number} args.endMs   Inclusive upper bound — normally `gradMs + POST_GRADUATION_MS`.
 * @param {number} [args.maxPages]
 * @param {(message: string) => void} [args.log]
 * @returns {Promise<WalkResult>}
 */
export async function walkLife({ client, mint, mintMs, endMs, maxPages = MAX_PAGES_PER_LAUNCH, log }) {
  const before = client.issued();
  /** @type {import('./trades.mjs').Fill[]} */
  const collected = [];
  let pages = 0;
  let reachedMint = false;
  let truncated = false;
  /** @type {string | null} */
  let stopReason = null;
  /** @type {string | null} */
  let cursor = seekCursor(endMs);

  while (pages < maxPages) {
    /** @type {import('./trades.mjs').TradePage} */
    let page;
    try {
      page = parseTradePage(await client.getJson(tradesUrl(mint, cursor)));
    } catch (cause) {
      // A ceiling is the run's own bound and must stop everything; anything else is this launch's
      // problem and is recorded as a gap rather than propagated into the run.
      if (cause instanceof CeilingReached) throw cause;
      stopReason = `request failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      break;
    }

    if (!page.recognised) {
      // Not "there is nothing older" — "we do not understand the answer". Collapsing the two is
      // what would let an unreadable body read as proof the walk had reached the mint.
      stopReason = 'the endpoint returned a body no rows could be read from';
      break;
    }

    pages += 1;
    for (const f of page.fills) collected.push(f);

    if (provesOlderThan(page, mintMs)) {
      reachedMint = true;
      stopReason = page.hasMore === false ? 'the endpoint holds nothing older' : 'reached past the mint';
      break;
    }
    if (page.nextCursor === null) {
      // The endpoint offered no way forward but never said it had nothing more. That is not proof.
      stopReason = 'the endpoint offered no next cursor and did not say it was done';
      break;
    }
    cursor = page.nextCursor;
  }

  if (pages >= maxPages && !reachedMint) {
    truncated = true;
    stopReason = `page ceiling of ${maxPages} reached before the mint`;
  }

  // Keep only what the declared window covers. The walk starts at a seek and the endpoint may hand
  // back a fill or two on the far side of it; a tape whose rows fall outside its own stated window
  // is a tape a reader cannot bound anything by.
  const kept = sortAscending(dedupeBySid(collected)).filter((f) => f.tsMs >= mintMs && f.tsMs <= endMs);

  let oldestSlot = null;
  for (const f of kept) if (oldestSlot === null || f.slot < oldestSlot) oldestSlot = f.slot;

  log?.(`${mint}: ${kept.length} fills over ${pages} pages, reachedMint=${reachedMint}`);

  return {
    mint,
    fills: kept,
    pages,
    requests: client.issued() - before,
    reachedMint,
    truncated,
    fromMs: kept.length > 0 ? /** @type {import('./trades.mjs').Fill} */ (kept[0]).tsMs : endMs,
    toMs: kept.length > 0 ? /** @type {import('./trades.mjs').Fill} */ (kept[kept.length - 1]).tsMs : endMs,
    oldestSlot,
    ammFills: kept.filter((f) => f.p === VENUE_AMM).length,
    stopReason,
  };
}
