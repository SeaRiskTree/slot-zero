/**
 * Stage 2 — ENTRY, the I/O half. Walks pump.fun's keyless fill tape and hands the fills to
 * `entry.mjs`, which does all the deciding.
 *
 * ## The bound, stated before the code
 *
 * Every provider call this makes is bounded three times over, and none of the bounds has a flag
 * that disables it:
 *
 * | bound | where | value |
 * |---|---|---|
 * | candidates scored | `thresholds.json` → `stage2_entry.maxCandidatesScored` | 3 |
 * | launches per candidate | `stage2_entry.maxLaunchesPerCandidate` | 8 |
 * | requests per launch, RETRIES INCLUDED | `stage2_entry.maxRequestsPerLaunch` | 18 |
 * | requests for the whole stage | `stage2_entry.maxKeylessRequests`, on its own client | 432 |
 * | pacing, this host only | `stage2_entry.keylessMinIntervalMs` | 7s |
 * | Solana RPC, the cost leg | `thresholds.json` → `stage2_cost.maxRpcRequestsPerCandidate` | 400 |
 * | pacing, the cost leg | `stage2_cost.rpcMinIntervalMs`, inherited from `creation_walk` | 2.5s |
 *
 * That pacing is pinned **per host**. swap-api sheds about a quarter of what it is asked for, and at
 * the 2s the general keyless client uses it shed half of a real run's launches past all their
 * retries — which does not announce itself, it just degrades the verdict to `entry-unmeasured`. The
 * `--consistency` walk on frontend-api-v3 keeps 2s; it has shed nothing and is not slowed for this.
 * The request arithmetic below is unchanged by it, but the wall clock is: **a typical run takes
 * about 17 minutes and the worst case about 50**, which `--dry-run` prints so that a slow walk is
 * not mistaken for a hang.
 *
 * `3 × 8 × 18 = 432` — the declared worst case and the stage ceiling are **the same number**, so no
 * plan-level truncation is possible and the printed plan is the whole exposure. A launch is only
 * started when a full per-launch cap of headroom remains, so a run never abandons a launch
 * half-walked and never spends requests on a window it cannot finish. `--dry-run` prints this plan
 * and fetches nothing.
 *
 * The per-launch cap counts **requests, not pages**, because this endpoint sheds about a quarter of
 * what it is asked for and the client retries. A cap on successful pages would have let a launch
 * cost three times the printed number. The walk also reserves the *whole* cost of a page — one
 * attempt plus its backoffs — before starting one, so 18 is an exact bound rather than an
 * approximate one and the `3 × 8 × 18` arithmetic above is true rather than nearly true.
 *
 * ## Drops are attributed, never lumped
 *
 * Every launch that leaves the sample is counted **by cause** ({@link Stage2DropReasons}), carried
 * into the run record and rendered. The cause that matters is `mintTimeDisagreement`: it says the
 * vendor's mint time and pump.fun's fill tape contradicted each other, which never happens on the
 * committed tape and has never been checked on a stranger, because this lane has held no vendor key.
 * A lump total could not be read for it, so there is no lump total.
 *
 * **No keyed request is issued here, ever.** The mint list comes from the profile Stage 1 already
 * paid for. The shared vendor allowance — which production also draws on — is untouched by this
 * stage, and the endpoints it does reach are pump.fun's free ones and Solana's public RPC.
 *
 * ## The cost leg's bound is separate, and it only spends on a candidate still alive
 *
 * Pricing what it cost to land runs on `api.mainnet-beta`, not on swap-api, so it draws on its own
 * per-candidate ceiling and on the creation walk's pacing — that host rate-limits **globally across
 * methods**, so the two legs share one limiter and are serialised rather than run beside each other.
 * It starts only after room and the gross field have both failed to refuse the candidate, which is
 * what keeps the expensive scope (every window transaction of every CLOSED create-slot outsider)
 * affordable. See {@link scoreCandidateEntry}.
 *
 * ## What it will not do
 *
 * It does not measure exit. Not partially, not as an input, not as a tiebreak. See `entry.mjs`.
 */

import { CeilingReached } from './client.mjs';
import { entryCostTargets, measureLaunchEntry, priceLaunchEntry, scoreEntry } from './entry.mjs';
import { toLaunchRefs } from './measure.mjs';
import { KeylessHttpError, readCreateSlotCosts, readLaunchWindow } from './pumpfun.mjs';
import { redactAll, redactVendorIdentifiers } from './record.mjs';

/**
 * @typedef {object} Stage2Thresholds
 * @property {number} minRoomLeft
 * @property {number} minLaunchesSampled
 * @property {number} minFieldRoundTrips
 * @property {number} minFieldHitRateGross
 * @property {number} minFieldHitRateNet
 * @property {number} maxEntryCostPerSolStaked
 * @property {number} minPricedFraction
 * @property {number} maxCandidatesScored
 * @property {number} maxLaunchesPerCandidate
 * @property {number} maxRequestsPerLaunch
 * @property {number} tradePageLimit
 * @property {number} windowMs
 * @property {number} seekMarginMs
 * @property {number} windowSlotSpan
 * @property {number} maxKeylessRequests
 * @property {number} keylessMinIntervalMs Pacing for the FILL host only; see the module header.
 * @property {readonly number[]} [keylessRetryBackoffMs]
 */

/**
 * Every way a launch can leave the sample. A lump total would hide the one that matters: a
 * `mintTimeDisagreement` says the vendor's clock and the fill tape have come apart, which is a
 * different event from a launch simply being too busy to walk inside the request cap.
 *
 * @typedef {object} Stage2DropReasons
 * @property {number} mintTimeDisagreement Pre-mint rows came back. **A reportable event.**
 * @property {number} coverageUnproven     The endpoint never said whether anything older exists.
 * @property {number} unrecognisedBody     A body with no readable row list.
 * @property {number} requestCap           Busier than the per-launch request cap allows for.
 * @property {number} stalledCursor
 * @property {number} unparsedRows
 * @property {number} noFills
 * @property {number} noCreateSlot         Walked, but with no bonding-curve buy to anchor on.
 * @property {number} transportError
 * @property {number} stageCeiling         The stage ceiling was reached mid-walk.
 */

/**
 * @typedef {object} Stage2CostCoverage
 * What the on-chain cost leg did, and what it could not do.
 *
 * @property {boolean} ran                 Whether the leg ran at all. It does not when the free
 *   legs already refused the candidate, and that is a saving rather than a gap.
 * @property {number} rpcRequests          Solana RPC requests, retries included. **What the run
 *   PAID**, which is a different question from what backs the score: work that was paid for and then
 *   dropped is still spend, so this counts it and the `*Discarded` fields say how much of it there
 *   was.
 * @property {number} launchesPriced       Launches EVERY target transaction of which came back AND
 *   whose pricing is attached to the score. A launch missing one is not counted here even though its
 *   complete entrants still are, and neither is one that was priced and then discarded.
 * @property {number} launchesDiscarded    Launches whose walk was PAID FOR and then dropped whole:
 *   cut short mid-walk by the ceiling, or abandoned with the candidate on a transport failure.
 *   Beside `launchesPriced` rather than inside it, so a record can be reconciled arithmetically —
 *   `launchesPriced` never disagrees with `entry.entryCostPriced`, and this says what the disagreement
 *   would have been.
 * @property {number} launchesSkippedForBudget Launches NEVER STARTED, because the per-candidate
 *   ceiling could not cover them whole. Zero requests were spent on them; a launch the ceiling cut
 *   short after starting is `launchesDiscarded`. Either way no launch contributes a half-priced cost
 *   figure, because a truncated walk holds the earliest entrants and that is a biased sample rather
 *   than a short one.
 * @property {number} transactionsTargeted Distinct signatures the two scopes asked for.
 * @property {number} transactionsPriced   Signatures that came back AND back the score.
 * @property {number} transactionsDiscarded Signatures that came back and were then dropped with the
 *   launch or the candidate that asked for them. Paid for, and backing nothing.
 * @property {number} transactionsUnresolved The endpoint never resolved them, or their shape could
 *   not be priced exactly. **Not "cost zero".**
 * @property {number} viaBlock             Priced from a whole-block read (the §5.4 optimisation).
 * @property {number} viaTransaction       Priced one `getTransaction` at a time.
 * @property {boolean} stoppedForBudget
 * @property {string[]} notes              Why a route or a launch went the way it did.
 */

/**
 * @typedef {object} Stage2Coverage
 * @property {number} launchRefsAvailable  Launches the vendor profile offered.
 * @property {number} minAgeMs             The eligibility gate itself, `windowMs + seekMarginMs`,
 *   persisted so a record PROVES the property rather than leaving it to be reconstructed from a
 *   log's seek cursors. See {@link scoreCandidateEntry}.
 * @property {number} launchesTooYoung     Refs refused by that gate: their window had not finished
 *   happening at the moment the walk would have placed its cursor.
 * @property {number} launchesEligible     `launchRefsAvailable − launchesTooYoung`.
 * @property {number} launchesPlanned      Eligible launches inside `maxLaunchesPerCandidate`.
 * @property {number} launchesDroppedByCap `launchesEligible − launchesPlanned`. A bound of ours,
 *   not a property of the deployer — and the count nothing in the record could previously separate
 *   from the two above it.
 * @property {number | null} youngestRefAgeMs Age of the newest launch the profile offered, at the
 *   moment eligibility was decided. `null` when it offered none.
 * @property {number | null} youngestEligibleAgeMs Age of the newest launch that PASSED. Read beside
 *   `minAgeMs` this is what says whether a run exercised the boundary or sat far above it — the
 *   committed live run sat ~5 hours above it and could not discriminate the gate from its absence.
 * @property {number} launchesAttempted    Windows we started walking.
 * @property {number} launchesUsable       Windows walked back past the mint.
 * @property {number} launchesDropped      Windows dropped for incomplete coverage.
 * @property {Stage2DropReasons} dropsByReason  The same total, broken out by cause.
 * @property {number} requestsIssued
 * @property {boolean} stoppedForBudget    Whether the stage ceiling ended the walk early.
 * @property {string[]} dropNotes          One line per dropped window, so a drop is never silent.
 * @property {Stage2CostCoverage} cost     The on-chain cost leg's own coverage and spend.
 */

/** @returns {Stage2DropReasons} */
function noDrops() {
  return {
    mintTimeDisagreement: 0,
    coverageUnproven: 0,
    unrecognisedBody: 0,
    requestCap: 0,
    stalledCursor: 0,
    unparsedRows: 0,
    noFills: 0,
    noCreateSlot: 0,
    transportError: 0,
    stageCeiling: 0,
  };
}

/** @type {Record<import('./pumpfun.mjs').LaunchWindowDropReason, keyof Stage2DropReasons>} */
const DROP_REASON_KEY = {
  'mint-time-disagreement': 'mintTimeDisagreement',
  'coverage-unproven': 'coverageUnproven',
  'unrecognised-body': 'unrecognisedBody',
  'request-cap': 'requestCap',
  'stalled-cursor': 'stalledCursor',
  'unparsed-rows': 'unparsedRows',
  'no-fills': 'noFills',
};

/**
 * Add two drop tallies. Used to roll per-wallet counts up to a run total, which is the level at
 * which a clock disagreement stops looking like one odd launch and starts looking like a broken
 * assumption.
 *
 * @param {Stage2DropReasons} a
 * @param {Stage2DropReasons} b
 * @returns {Stage2DropReasons}
 */
export function addDropReasons(a, b) {
  const sum = noDrops();
  for (const key of /** @type {(keyof Stage2DropReasons)[]} */ (Object.keys(sum))) {
    sum[key] = a[key] + b[key];
  }
  return sum;
}

/** @param {Stage2DropReasons} d @returns {number} */
export function totalDrops(d) {
  let n = 0;
  for (const key of /** @type {(keyof Stage2DropReasons)[]} */ (Object.keys(d))) n += d[key];
  return n;
}

/** @returns {Stage2DropReasons} */
export function emptyDropReasons() {
  return noDrops();
}

/**
 * Describe a failed launch walk **without repeating anything the vendor told us.**
 *
 * A drop note is persisted, and this client's URLs carry the mint, so `cause.message` is not
 * usable here: `HTTP 400 on https://swap-api.pump.fun/v2/coins/<MINT>/trades?…` would put a
 * vendor-derived token address into a run record and break the containment
 * {@link toEntryRecordRow} claims. {@link KeylessHttpError} carries its status as a field for
 * exactly this reason, and anything else is reduced to its constructor name — which is the part
 * that identifies the failure, and the only part that cannot be carrying an identifier.
 *
 * @param {unknown} cause
 * @returns {string}
 */
export function describeTransportFailure(cause) {
  if (cause instanceof KeylessHttpError) return `HTTP ${cause.status}`;
  if (cause instanceof Error) return cause.name === '' ? 'an unnamed error' : cause.name;
  return 'a non-Error throw';
}

/**
 * Score one candidate's entry room and field.
 *
 * The unusable-window rule is the load-bearing one: a window that could not be walked back to the
 * mint is **dropped and counted**, never measured. Measuring a partial window would anchor the
 * create slot on whatever fill the walk happened to stop at, credit some mid-window sniper as the
 * deployer, and produce a confident room figure for a launch whose opening was never seen. A
 * dropped launch merely shrinks `n` — visibly, and towards `entry-unmeasured`.
 *
 * A launch whose create slot carried no bundled transaction is a **different** case and is not a
 * drop: the window was walked and measured perfectly well, and it is the co-ordination rule that
 * found nothing. `entry.mjs` → `scoreEntry` refuses to score those, counts them in
 * `launchesRoomUnproven`, and says so in a caveat. They are still counted here as usable windows,
 * because the walk did what it was asked to.
 *
 * ## The cost leg runs SECOND, and only when the free legs have not already refused
 *
 * Room and the gross field cost nothing — they are arithmetic over fills already in hand — so they
 * are scored first and a candidate that fails either never costs a Solana RPC request. Only a
 * candidate still alive after both is priced, which is what makes captain decision 136b affordable:
 * the expensive scope is every window transaction of every CLOSED create-slot outsider, ~19 requests
 * per launch at the median against ~7 for the create slot alone.
 *
 * The first scoring pass is never reported. Its only job is to answer "is this worth pricing", and
 * `entry-cost-unmeasured` is exactly that answer — the free legs passed and the cost leg has
 * nothing yet.
 *
 * @param {import('./pumpfun.mjs').KeylessClient} client
 * @param {object} input
 * @param {string} input.wallet
 * @param {unknown} input.profile A parsed `/deployer-hunter/{wallet}` response from Stage 1.
 * @param {number} input.nowMs    Clock, injected so a run is reproducible in a test.
 * @param {Stage2Thresholds} input.thresholds
 * @param {import('./pumpfun.mjs').SolanaRpcClient | null} [input.rpc] The cost leg's client, with
 *   its own per-candidate ceiling. `null` or absent disables the leg, and the verdict then cannot
 *   be better than `entry-cost-unmeasured` — which is the intended consequence, not a degradation.
 * @param {boolean} [input.preferBlockRoute] `thresholds.json` → `stage2_cost.preferBlockRoute`.
 * @param {(line: string) => void} [input.log]
 * @returns {Promise<{ score: import('./entry.mjs').EntryScore, coverage: Stage2Coverage }>}
 */
export async function scoreCandidateEntry(client, input) {
  const t = input.thresholds;
  const refs = toLaunchRefs(input.profile);

  // A launch younger than this has not finished happening. Measuring it would read a truncated
  // opening as a quiet one.
  //
  // THE BOUND IS `windowMs + seekMarginMs`, NOT `windowMs`, and the difference is a real defect
  // rather than tidiness. The gate has to cover the NEWEST INSTANT THE WALK REACHES FOR, and two
  // quantities reach forward from the mint: the seek cursor, placed at
  // `createdAtMs + windowMs + seekMarginMs` (65s at the pinned values), and the measured span, which
  // `windowSlotSpan` fixes at 160 slots — 64.0s at this repo's nominal 400ms/slot and ~63.5s at the
  // tape's observed ~397ms. The cursor dominates, so `windowMs + seekMarginMs` covers both. Gating
  // on `windowMs` alone admitted a launch aged 60–65s whose tail had not happened yet: exactly the
  // truncation `seekMarginMs` exists to prevent, arriving from the other side, and silent, because
  // an absent tail reads as a quiet one.
  //
  // This does not give `windowMs` a third job or move membership off `windowSlotSpan` — see
  // `thresholds.json` → `stage2_entry.justification.windowMs`. It makes the two jobs it already had
  // agree: a launch is old enough exactly when the cursor the same numbers place is in the past.
  // A test pins `windowSlotSpan × 400ms <= windowMs + seekMarginMs`, so widening the span past this
  // bound fails loudly instead of quietly reopening the gap.
  //
  // **The counts below are persisted, and that is the point of computing them here.** Before
  // schema 6 a record carried `launchRefsAvailable` and `launchesAttempted` and nothing between
  // them, so three quite different reasons a launch went unmeasured — too young, dropped by our own
  // per-candidate cap, or never reached because the budget ran out — were indistinguishable, and
  // the gate above was observable only by reading seek cursors out of a run log. `minAgeMs`,
  // `launchesTooYoung`, `launchesEligible`, `launchesPlanned` and `launchesDroppedByCap` make the
  // filter's whole arithmetic readable from the record itself.
  const minAgeMs = t.windowMs + t.seekMarginMs;
  const ages = refs.map((r) => input.nowMs - r.deployedAtMs);
  const eligible = refs.filter((r) => input.nowMs - r.deployedAtMs >= minAgeMs);
  const planned = eligible.slice(0, t.maxLaunchesPerCandidate);
  // `toLaunchRefs` returns newest first, so the youngest is the head of each list. Both are ages
  // rather than instants so the record stays free of anything that could identify a launch.
  const youngestRefAgeMs = ages.length === 0 ? null : Math.min(...ages);
  const youngestEligibleAgeMs =
    eligible.length === 0 ? null : Math.min(...eligible.map((r) => input.nowMs - r.deployedAtMs));

  /** @type {{ entry: import('./entry.mjs').LaunchEntry, fills: readonly import('./measure.mjs').Fill[] }[]} */
  const measured = [];
  /** @type {string[]} */
  const dropNotes = [];
  const dropsByReason = noDrops();
  let attempted = 0;
  let dropped = 0;
  let stoppedForBudget = false;
  const requestsBefore = client.issued();

  for (const ref of planned) {
    // Reserve the whole per-launch cost before starting. Beginning a walk we cannot finish would
    // spend requests to produce a window that is unusable by construction.
    if (client.remaining() < t.maxRequestsPerLaunch) {
      stoppedForBudget = true;
      dropNotes.push(
        `stopped before ${planned.length - attempted} further launch(es): fewer than ` +
          `${t.maxRequestsPerLaunch} request(s) of the ${t.maxKeylessRequests} stage ceiling remain, and a ` +
          `launch is never started unless it can be finished`,
      );
      break;
    }

    attempted += 1;
    /** @type {import('./pumpfun.mjs').LaunchWindow} */
    let window;
    try {
      window = await readLaunchWindow(client, {
        mint: ref.mint,
        createdAtMs: ref.deployedAtMs,
        windowMs: t.windowMs,
        seekMarginMs: t.seekMarginMs,
        windowSlotSpan: t.windowSlotSpan,
        maxRequests: t.maxRequestsPerLaunch,
        pageLimit: t.tradePageLimit,
      });
    } catch (cause) {
      if (cause instanceof CeilingReached) {
        stoppedForBudget = true;
        dropped += 1;
        dropsByReason.stageCeiling += 1;
        dropNotes.push('the stage request ceiling was reached mid-walk');
        break;
      }
      dropped += 1;
      dropsByReason.transportError += 1;
      dropNotes.push(`DROPPED (transport error): ${describeTransportFailure(cause)}`);
      continue;
    }

    if (!window.usable) {
      dropped += 1;
      if (window.dropReason !== null) dropsByReason[DROP_REASON_KEY[window.dropReason]] += 1;
      dropNotes.push(window.note);
      input.log?.(`    ${window.note}`);
      continue;
    }

    const entry = measureLaunchEntry(window.fills);
    if (entry === null) {
      dropped += 1;
      dropsByReason.noCreateSlot += 1;
      dropNotes.push('DROPPED: no bonding-curve buy in the window, so there is no create slot to anchor on');
      continue;
    }
    measured.push({ entry, fills: window.fills });
    input.log?.(
      `    ${window.pages} page(s) / ${window.requests} request(s), ${window.fills.length} fill(s), room ` +
        `${entry.createSlot.roomLeft.toFixed(3)}, ${entry.field.length} competing wallet(s)`,
    );
  }

  const context = {
    candidateWallet: input.wallet,
    launchesDropped: dropped,
    mintTimeDisagreements: dropsByReason.mintTimeDisagreement,
  };
  let score = scoreEntry(
    measured.map((m) => m.entry),
    t,
    context,
  );
  const cost = emptyCostCoverage();

  // The free legs have spoken. `entry-cost-unmeasured` here means they did not refuse the candidate
  // and the cost leg has nothing yet — the one state worth spending a Solana RPC request on.
  if (input.rpc != null && score.verdict === 'entry-cost-unmeasured') {
    cost.ran = true;
    const rpc = input.rpc;
    const rpcBefore = rpc.issued();
    /** @type {import('./entry.mjs').LaunchEntry[]} */
    const pricedLaunches = [];
    // Latched per candidate rather than per launch: the whole-block route is UNTESTED against this
    // endpoint, so the first launch pays one request to find out and the rest of the candidate
    // inherits the answer. Bounded waste, and the answer reaches the record.
    let preferBlock = input.preferBlockRoute ?? true;
    // A transport failure abandons the cost leg for THIS CANDIDATE and nothing else. It must never
    // reach the outer catch: a run that has already spent its keyed MadeOnSol allowance cannot be
    // thrown away over one wallet's bad luck on a public endpoint that sheds a quarter of what it
    // is asked for. The same degradation the creation walk and the consistency pass already apply.
    let transportFailed = false;
    // Every launch whose walk was PAID FOR and whose pricing was attached, counted AS IT HAPPENS.
    // `launchesPriced` is the wrong basis to reconstruct this from on rollback: it counts only
    // launches where every target came back, so a launch that came back short for a non-budget
    // reason would land in neither counter and vanish from launch-level accounting entirely.
    let launchesAttached = 0;

    for (const { entry, fills } of measured) {
      const targets = entryCostTargets(fills, entry);
      cost.transactionsTargeted += targets.length;
      // Never start what cannot be finished, the same rule the fill walk applies. A launch priced
      // half-way yields a cost figure for whichever entrants happened to come first, which is a
      // biased sample rather than a short one. This reservation is a FLOOR, not the worst case —
      // every request may be retried and a null `getTransaction` is asked again — so the invariant
      // is also enforced on the way out, where a walk truncated by the ceiling has its partial
      // pricing DISCARDED rather than attached.
      if (targets.length > 0 && rpc.remaining() < targets.length) {
        cost.launchesSkippedForBudget += 1;
        cost.stoppedForBudget = true;
        cost.notes.push(
          `a launch needing ${targets.length} transaction(s) was not started: fewer remain of the ` +
            `per-candidate RPC ceiling, and a launch is never priced half-way`,
        );
        pricedLaunches.push(entry);
        continue;
      }

      /** @type {Awaited<ReturnType<typeof readCreateSlotCosts>>} */
      let walk;
      try {
        walk = await readCreateSlotCosts(rpc, {
          transactions: targets,
          createSlot: entry.createSlot.slot,
          preferBlock,
        });
      } catch (cause) {
        transportFailed = true;
        // Nothing this candidate priced backs the score any more, because the score is not recomputed
        // below. The counters follow the attachment rather than the spend: everything earlier
        // launches priced moves across to DISCARDED, and this launch is one more of them.
        cost.transactionsDiscarded += cost.transactionsPriced;
        cost.launchesDiscarded += launchesAttached + 1;
        cost.transactionsPriced = 0;
        cost.launchesPriced = 0;
        cost.notes.push(
          `the cost walk was ABANDONED for this candidate after a transport failure: ` +
            `${describeTransportFailure(cause)}. Nothing it had priced is attached, so the entry ` +
            `cost is UNMEASURED rather than partial — which is terminal for this candidate in this ` +
            `run and is never a pass. The rest of the run is unaffected.`,
        );
        break;
      }
      cost.transactionsUnresolved += walk.unresolved;
      cost.viaBlock += walk.viaBlock;
      cost.viaTransaction += walk.viaTransaction;
      if (walk.stoppedForBudget) cost.stoppedForBudget = true;
      if (walk.blockRouteNote !== null && !cost.notes.includes(walk.blockRouteNote)) {
        cost.notes.push(walk.blockRouteNote);
      }
      // One probe decides the route for the candidate. `blockRouteTried` with nothing to show for
      // it is the failure; a route that was never applicable leaves the probe available.
      if (walk.blockRouteTried && walk.viaBlock === 0) preferBlock = false;
      // A LAUNCH THE CEILING CUT SHORT IS DISCARDED WHOLE. The reservation above cannot see
      // retries, so the ceiling can still bite mid-launch; keeping what it managed would attach a
      // cost figure for whichever entrants `walletTransactions` sorted first — the earliest slots —
      // which is the biased sample `minPricedFraction` exists to refuse, and a biased fifth can
      // still clear an 0.8 coverage bar. Short is acceptable; skewed is not.
      if (walk.stoppedForBudget && walk.priced.size < targets.length) {
        cost.launchesDiscarded += 1;
        cost.transactionsDiscarded += walk.priced.size;
        cost.stoppedForBudget = true;
        cost.notes.push(
          `a launch was priced ${walk.priced.size} of ${targets.length} transaction(s) before the ` +
            `per-candidate RPC ceiling bit, and the partial reading was DISCARDED: what a truncated ` +
            `walk holds is the earliest entrants, which is a biased sample of the cost rather than ` +
            `a short one`,
        );
        pricedLaunches.push(entry);
        continue;
      }
      // Priced means EVERY target came back. A launch missing one transaction still contributes
      // whatever entrants it could complete — `priceLaunchEntry` is all-or-nothing per wallet — but
      // it is not a priced launch, and counting it as one would overstate coverage.
      if (targets.length > 0 && walk.priced.size === targets.length) cost.launchesPriced += 1;
      if (walk.priced.size > 0) launchesAttached += 1;
      cost.transactionsPriced += walk.priced.size;
      pricedLaunches.push(priceLaunchEntry(entry, targets, walk.priced));
    }

    cost.rpcRequests = rpc.issued() - rpcBefore;
    // A candidate whose walk died mid-flight keeps the pre-cost score, which is already
    // `entry-cost-unmeasured`. Rescoring on a partial attachment is the one thing that must not
    // happen: it would turn a failed measurement into a priced reading of unknown coverage.
    if (!transportFailed) score = scoreEntry(pricedLaunches, t, context);
    input.log?.(
      `    entry cost: ${cost.transactionsPriced} of ${cost.transactionsTargeted} transaction(s) ` +
        `priced in ${cost.rpcRequests} RPC request(s)` +
        (cost.viaBlock > 0 ? `, ${cost.viaBlock} from a whole-block read` : '') +
        (transportFailed ? ' — ABANDONED on a transport failure, cost left unmeasured' : ''),
    );
  }

  return {
    score,
    coverage: {
      launchRefsAvailable: refs.length,
      minAgeMs,
      launchesTooYoung: refs.length - eligible.length,
      launchesEligible: eligible.length,
      launchesPlanned: planned.length,
      launchesDroppedByCap: eligible.length - planned.length,
      youngestRefAgeMs,
      youngestEligibleAgeMs,
      launchesAttempted: attempted,
      launchesUsable: measured.length,
      launchesDropped: dropped,
      dropsByReason,
      requestsIssued: client.issued() - requestsBefore,
      stoppedForBudget,
      dropNotes,
      cost,
    },
  };
}

/** @returns {Stage2CostCoverage} */
export function emptyCostCoverage() {
  return {
    ran: false,
    rpcRequests: 0,
    launchesPriced: 0,
    launchesDiscarded: 0,
    launchesSkippedForBudget: 0,
    transactionsTargeted: 0,
    transactionsPriced: 0,
    transactionsDiscarded: 0,
    transactionsUnresolved: 0,
    viaBlock: 0,
    viaTransaction: 0,
    stoppedForBudget: false,
    notes: [],
  };
}

/**
 * Project an entry score onto the fields a run record may persist.
 *
 * Same containment as `screen.mjs` → `toRecordRow`, for the same reason: what survives a run is our
 * arithmetic over pump.fun's public fills, and never a vendor per-token record. In particular **no
 * mint appears here**, although Stage 2 held a list of them in memory to do the walk at all.
 *
 * Wallet addresses are also dropped. The field is reported as a distribution and a hit rate — which
 * is the whole point of the leg — and a list of who was in it would be an accumulation with no
 * question attached to it.
 *
 * Every FREE-TEXT field is passed through `record.mjs` → `redactVendorIdentifiers` on the way out.
 * The structured fields cannot leak — they are numbers — but a sentence can, and one did: a
 * transport failure's message carried the trade URL, mint and all, into `dropNotes`. Notes are now
 * built without it (see {@link describeTransportFailure}) AND scrubbed here, because the containment
 * claim should not rest on every future note-writer remembering.
 *
 * @param {import('./entry.mjs').EntryScore} s
 * @param {Stage2Coverage} coverage
 */
export function toEntryRecordRow(s, coverage) {
  /** @param {import('./entry.mjs').Distribution} d */
  const dist = (d) => ({
    n: d.n,
    min: round(d.min),
    p10: round(d.p10),
    p25: round(d.p25),
    median: round(d.median),
    p75: round(d.p75),
    p90: round(d.p90),
    max: round(d.max),
  });
  /** @param {import('./entry.mjs').HitRate} h */
  const hit = (h) => ({ n: h.n, hits: h.hits, rate: round(h.rate) });

  return {
    verdict: s.verdict,
    rationale: redactVendorIdentifiers(s.rationale),
    launchesSampled: s.launchesSampled,
    // Schema 5. Without these three a saved run cannot be audited for the unproven-opening
    // condition after the fact — `bundledTx` and `maxWalletsInOneTx` were computed and thrown away
    // until now, and they are the only observable that exposes it. `record.mjs` owns the version.
    launchesRoomUnproven: s.launchesRoomUnproven,
    bundledTx: dist(s.bundledTx),
    maxWalletsInOneTx: dist(s.maxWalletsInOneTx),
    launchesWithNoOutsider: s.launchesWithNoOutsider,
    roomLeft: dist(s.roomLeft),
    roomHitRate: hit(s.roomHitRate),
    operationShare: dist(s.operationShare),
    devSol: dist(s.devSol),
    coordinatedSol: dist(s.coordinatedSol),
    outsidersPerLaunch: dist(s.outsidersPerLaunch),
    fieldFillSol: dist(s.fieldFillSol),
    fieldSolQueuedAhead: dist(s.fieldSolQueuedAhead),
    fieldRealisedSolGrossOfFees: dist(s.fieldRealisedSolGrossOfFees),
    fieldReturnPerSolGrossOfFees: dist(s.fieldReturnPerSolGrossOfFees),
    fieldHitRateGrossOfFees: hit(s.fieldHitRateGrossOfFees),
    // Schema 6. The price of the seat, and what the field cleared after paying it. Every one of
    // these carries `entry.mjs` → `LANDING_TIP_CAVEAT` in `caveats`, which is the requirement: the
    // limit travels with the number, not only with the documentation.
    entryCostSol: dist(s.entryCostSol),
    entryCostPerSolStaked: dist(s.entryCostPerSolStaked),
    // Beside the pooled per-entry figure above, never instead of it, and it is THIS one the
    // `entry-cost-prohibitive` bar is compared against — one observation per launch (decision 140a).
    entryCostPerSolStakedByLaunch: dist(s.entryCostPerSolStakedByLaunch),
    entryTxFeeSol: dist(s.entryTxFeeSol),
    entryCostPriced: hit(s.entryCostPriced),
    fieldRealisedSolNetOfMeasuredFees: dist(s.fieldRealisedSolNetOfMeasuredFees),
    fieldReturnPerSolNetOfMeasuredFees: dist(s.fieldReturnPerSolNetOfMeasuredFees),
    fieldHitRateNetOfMeasuredFees: hit(s.fieldHitRateNetOfMeasuredFees),
    fieldClosedRoundTripsPriced: s.fieldClosedRoundTripsPriced,
    fieldEntrants: s.fieldEntrants,
    fieldClosedRoundTrips: s.fieldClosedRoundTrips,
    fieldOpenPositions: s.fieldOpenPositions,
    deployerMismatches: s.deployerMismatches,
    caveats: redactAll(s.caveats),
    coverage: {
      launchRefsAvailable: coverage.launchRefsAvailable,
      // Schema 6. The eligibility filter's own arithmetic, so the gate is a property of the record
      // rather than something a person reconstructs from a log's seek cursors.
      minAgeMs: coverage.minAgeMs,
      launchesTooYoung: coverage.launchesTooYoung,
      launchesEligible: coverage.launchesEligible,
      launchesPlanned: coverage.launchesPlanned,
      launchesDroppedByCap: coverage.launchesDroppedByCap,
      youngestRefAgeMs: coverage.youngestRefAgeMs,
      youngestEligibleAgeMs: coverage.youngestEligibleAgeMs,
      launchesAttempted: coverage.launchesAttempted,
      launchesUsable: coverage.launchesUsable,
      launchesDropped: coverage.launchesDropped,
      // Broken out by cause, not a lump total: the whole point of the mint-time tripwire is that a
      // run can be read for whether it fired, and a total cannot be.
      dropsByReason: { ...coverage.dropsByReason },
      requestsIssued: coverage.requestsIssued,
      stoppedForBudget: coverage.stoppedForBudget,
      dropNotes: redactAll(coverage.dropNotes),
      cost: { ...coverage.cost, notes: redactAll(coverage.cost.notes) },
    },
  };
}

/** @param {number} n @returns {number | null} */
function round(n) {
  return Number.isFinite(n) ? Number(n.toFixed(6)) : null;
}
