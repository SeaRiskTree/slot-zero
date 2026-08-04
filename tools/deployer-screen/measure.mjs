/**
 * The pure measurement core of the deployer screen. No I/O, no network, no clock.
 *
 * Everything a verdict rests on is computed here, from plain data, so that the same functions
 * serve three callers that must never disagree:
 *
 *  1. **Stage 0** feeds them the committed population tape under `data/`, where the answer is
 *     already known and published. That is the regression test for the whole method.
 *  2. **The unit tests** feed them synthetic fixtures.
 *  3. **A live run** feeds them fills from `swap-api.pump.fun`.
 *
 * That works because the tape's `window/*.jsonl.gz` rows *are* the trade endpoint's rows —
 * the tape was built by paging that endpoint — so a fill is a fill and there is one parser.
 */

/**
 * pump.fun bonding-curve invariant: initial virtual SOL x initial virtual token reserves.
 *
 * `src/index.ts` carries the same parameters for the analysis core. They are repeated rather
 * than imported because this directory is deliberately outside the keyless boundary that
 * `src/` lives inside, and a one-way dependency from the network tool into the keyless core
 * would blur exactly the line `test/deployer-screen.test.ts` exists to keep sharp.
 */
export const CURVE_K = 30 * 1_073_000_000;

/** SOL per token at the very start of the curve, before any buy. */
export const CURVE_INITIAL_PRICE_SOL = 30 / 1_073_000_000;

/**
 * SOL that must enter the bonding curve to move its price from `from` to `to`.
 *
 * The curve is a constant product, so reserves are recoverable from a price alone:
 * `virtualSol = sqrt(k * price)`. The SOL added between two prices is the difference of those
 * reserves. This is exact, not fitted — validated against the dataset's own
 * `control_create_slot.csv`, where it reproduces all 70 recorded `dev_sol` values from `p0`
 * to within 6e-10 SOL.
 *
 * @param {number} from Price per token in SOL.
 * @param {number} to   Price per token in SOL.
 * @returns {number} SOL added. Negative if `to < from`.
 */
export function solBetweenPrices(from, to) {
  return Math.sqrt(CURVE_K) * (Math.sqrt(to) - Math.sqrt(from));
}

/**
 * @typedef {object} Fill
 * A single swap, in the shape both `window/*.jsonl.gz` and `swap-api.pump.fun` use.
 * @property {number} slot   Solana slot.
 * @property {string} sid    pump.fun's within-slot ordering key (`sid` stored, `slotIndexId`
 *   live). Slots hold many fills and a slot number cannot order them; this can, and it is what
 *   "who was queued ahead of whom" is computed from — the June report §5.2 metric.
 * @property {string} tx     Transaction signature. The co-ordination key — see
 *   {@link measureCreateSlot}.
 * @property {string} wallet The **swapping** wallet. In a bundled transaction this is not the
 *   fee payer, which is why it and not the fee payer is the unit of "who traded".
 * @property {'buy' | 'sell'} side
 * @property {'pump' | 'pump_amm'} venue `pump` is the bonding curve.
 * @property {number} sol    Swap-quote SOL, **gross of the venue fee and of priority fees**.
 *   Every figure derived from it inherits that, which is why the P&L field names in `entry.mjs`
 *   all carry `GrossOfFees`.
 * @property {number} tokens Base-token amount moved by this fill. Required to decide whether a
 *   wallet's position closed inside the window, which is the only condition under which its P&L
 *   is complete at all.
 * @property {number} priceSol Price per token in SOL at this fill.
 */

/**
 * Parse one raw fill object — a line of a window tape, or an element of the trade endpoint's
 * array — into a {@link Fill}.
 *
 * Unknown enum values throw rather than default. Defaulting `k` to `buy` or `p` to the
 * bonding curve would silently reclassify a fill, which is a corruption rather than a crash;
 * `src/window.ts` makes the same choice for the same reason.
 *
 * @param {Record<string, unknown>} raw
 * @returns {Fill}
 */
export function parseFill(raw) {
  const side = raw['k'];
  const venue = raw['p'];
  if (side !== 'buy' && side !== 'sell') {
    throw new Error(`fill field 'k' is ${JSON.stringify(side)}, expected 'buy' or 'sell'`);
  }
  if (venue !== 'pump' && venue !== 'pump_amm') {
    throw new Error(`fill field 'p' is ${JSON.stringify(venue)}, expected 'pump' or 'pump_amm'`);
  }
  return {
    slot: Number(raw['slot']),
    sid: String(raw['sid']),
    tx: String(raw['tx']),
    wallet: String(raw['u']),
    side,
    venue,
    sol: Number(raw['sol']),
    tokens: Number(raw['base']),
    priceSol: Number(raw['psol']),
  };
}

/**
 * @typedef {object} CreateSlotMeasurement
 * @property {number} slot              The create slot itself.
 * @property {string} deployer          Wallet credited with the launch (first curve buyer).
 * @property {number} devSol            The deployer's own buy inside the create slot.
 * @property {number} coordinatedSol    Stake of non-deployer wallets provably co-ordinated.
 * @property {number} independentSol    Stake of the remaining create-slot wallets.
 * @property {number} totalOtherSol     `coordinatedSol + independentSol`.
 * @property {number} coordinatedWallets Distinct co-ordinated non-deployer wallets.
 * @property {number} independentWallets Distinct wallets left unattributed.
 * @property {number} bundledTx         Create-slot transactions carrying 2+ distinct wallets. The
 *   SHARED-TRANSACTION half of the co-ordination rule, reported on its own so a saved run can be
 *   read back apart — see {@link createSlotGroups}.
 * @property {number} maxWalletsInOneTx Largest wallet count in a single create-slot transaction.
 * @property {number} runTx             Create-slot transactions in the deployer-anchored contiguous
 *   block-index run, the anchor itself included. `1` means the deployer's own transaction sat alone
 *   between two gaps; `0` means no run could be read at all, which is what a `sid` whose format has
 *   moved looks like.
 * @property {number} adjacencyMarks    Wallets the adjacency half marked that the shared-transaction
 *   half did NOT. The size of what the union added on this launch, and the only observable that
 *   separates the two halves after the fact.
 * @property {number} operationShare    (devSol + coordinatedSol) / (devSol + totalOtherSol).
 * @property {number} roomLeft          `1 - operationShare`.
 */

/**
 * Measure how much of a launch's opening window the deployer and its own wallets take.
 *
 * This is the method of `slot-zero-june-regime-change/report.md` §5.1 — *the operation's
 * share of the curve's bottom* — and the reason it can be pointed at a stranger is the
 * co-ordination rule, which since captain decision 182a is the UNION of two structural tests:
 *
 * > **(a)** A single transaction carrying two or more distinct swapping wallets is a bundle, and
 * > every wallet in it is co-ordinated.
 * > **(b)** Sorted by block transaction index, the create-slot transactions that form a contiguous
 * > run at step 1 through the deployer's own are one submission, and every wallet in that run is
 * > co-ordinated.
 *
 * Sharing a transaction or an atomically-landed run is something traders acting alone do not
 * arrange for themselves — a third party has to do it for them — and no outsider can insert a
 * transaction into a bundle already landed. So this identifies a deployer's own book structurally,
 * from nothing but
 * the fills, with no wallet list and no prior knowledge — which is what makes the method applicable
 * to a stranger at all. {@link createSlotGroups} owns both halves and the evidence behind (b).
 *
 * **What half (a) recovers on its own is a property of the operator's submission habit on the day,
 * not of the rule, and the range is the whole tape.** Measured against the known six-wallet cohort
 * on our own subject: **0% of cohort wallets recovered in December 2025 – February 2026, 41.6% in
 * March, 69.9% in April, 97–100% from May onwards.** The claim this comment used to make — that the
 * rule recovers the cohort, full stop — is true of the May–July slice it was written against and
 * false of the tape as a whole (`slot-zero-stage2-correctness-and-fees/report.md` §3.2). That range
 * is what half (b) exists to close: over the same 235 launches the union recovers **1,140 of 1,140**
 * cohort wallet-instances, against 960 for half (a) alone and 1,083 for half (b) alone. **The two
 * halves are complementary rather than nested, which is why neither replaces the other** — (a)
 * catches a second bundle the operation sends later in the same block, which an anchored run cannot
 * reach (57 instances over 14 launches); (b) catches the months when the operation co-ordinated by
 * adjacency and never shared a transaction at all, which is all of December 2025 – February 2026.
 *
 * **The rule's errors run in one direction, and it is the direction that manufactures an edge.**
 * A co-ordinated wallet the rule misses moves out of the numerator and into `independentSol`, so it
 * lowers the operation's share and raises `roomLeft` — twice over, once in each term. **The opposite
 * error is RARE AND ERA-DEPENDENT rather than impossible, and an earlier version of this note said
 * impossible.** Half (a) marks a wallet on nothing but a shared transaction, and a third party can
 * put two strangers in one: measured over the 123 launches of
 * `data/population-tape-2026-07-29/onchain_create_slot_pnl.csv`, half (a) marks 11 non-cohort
 * wallet-instances across 3 era-1 launches, including both wallets `src/cohort.ts` names as settled
 * unaffiliated outsiders, and all 11 run through one wallet that shares create-slot transactions
 * with cohort members and with those outsiders alike — a shared bundling service is the reading
 * that fits, but it is an INFERENCE from the fills and not something this evidence establishes.
 * `census/2026-08-04-proof-coverage-probe.md` → "Incidental finding" owns the figures. The
 * era-2 reading is unaffected and stands (`nonCohortMarkedCoord = 0` on every era-2 launch).
 * **The DIRECTION is what decision 134a rests on and it is unchanged**: a mis-marked outsider moves
 * stake INTO the numerator, so it raises `operationShare` and lowers `roomLeft` — it makes a
 * deployer look LESS enterable, never more. So **every error this rule makes in the direction that
 * matters makes a deployer look more enterable than it is**, and the
 * earlier note here — that its conservatisms make a positive verdict "harder to earn, not easier" —
 * had the sign backwards. The two under-recovering cases are:
 *
 * - A co-ordinated wallet that buys **alone** in the create slot, sharing neither a transaction nor
 *   the deployer's block-index run, is counted as independent. Its stake inflates `independentSol`.
 * - Only the create slot is examined. A book that accumulates in the next few slots is missed.
 *
 * **Widening the rule by UNION preserves that direction structurally rather than empirically.**
 * Half (a)'s marked set is a subset of the union's by construction, so for every launch half (a)
 * scores, the union's `operationShare` is ≥ and its `roomLeft` is ≤ the older reading. A wider rule
 * cannot manufacture a false accept on a launch that was already being scored; the only thing it
 * can do is refuse fewer of them. `test/deployer-screen.test.ts` pins that direction as a property
 * over the whole committed tape rather than as a claim in this comment.
 *
 * The degenerate case of the first — a create slot in which **neither half of the rule marks
 * anything** — is not a conservatism but a blind spot, and {@link roomIsProven} is where the screen
 * refuses it. See that function; it is the load-bearing half of this rule.
 *
 * @param {readonly Fill[]} fills All fills for one launch, any order.
 * @returns {CreateSlotMeasurement | null} `null` when there is no bonding-curve buy to anchor
 *   the create slot on, which is the honest answer for a launch we cannot see the start of.
 */
export function measureCreateSlot(fills) {
  const groups = createSlotGroups(fills);
  if (groups === null) return null;
  return tallyCreateSlot(groups).measurement;
}

/**
 * Whether a launch's room figure rests on evidence, or on the absence of it.
 *
 * **A create slot the co-ordination rule marks nothing in is observationally identical to a create
 * slot with no co-ordination.** The rule found nothing either way, and nothing in the fill tape
 * separates the two. Reading the second — which is what the screen used to do implicitly — books
 * the operation's own stake as independent capital and inflates `roomLeft`; on our own tape that is
 * ~9.6–10.0 SOL per affected launch, and replaying the live recipe at every point in the tape's
 * history it flips **22 of 22 rolling windows towards `ENTRY-ROOM-PRESENT` where the truth is
 * `ABSENT`, with zero flips the other way**. The count is a property of the replay's window width,
 * which is `maxLaunchesPerCandidate`: it read 24 of 228 at the cap of 8 the cited report measured
 * under, and 22 of 226 at the 10 captain decision 190a pinned
 * (`slot-zero-stage2-correctness-and-fees/report.md` §3.3).
 *
 * Captain decision 134a: **do not score those launches — call the opening unproven rather than
 * measured.** A null result is acceptable; a false positive is not. `entry.mjs` → `scoreEntry`
 * applies this, and Stage 0's rolling replay fails loudly if it stops being applied.
 *
 * **The predicate is `coordinationEvidence >= 1` — the UNION's marked set being non-empty**
 * (captain decision 182a), where it used to be `bundledTx >= 1`. `coordinatedWallets` IS that
 * evidence count: {@link createSlotGroups} marks a wallet when it shared a transaction (half a) or
 * when it rode the deployer's contiguous block-index run (half b), and a launch is scored when
 * either half saw anything at all. Under half (a) alone the two predicates were the same in
 * practice — a bundled transaction always leaves at least one non-deployer wallet marked — so this
 * is a widening of the marked SET, not a loosening of the bar on it. On the committed tape it takes
 * the unproven count from **60 of 235 to 0**, and the rolling replay's unmeasured windows from
 * **62 of 226 to 0**, with false positives 0 before and after (81 of 228 at the launch cap of 8
 * this was first measured under — the replay's window is `maxLaunchesPerCandidate` wide).
 *
 * This is deliberately a statement about the *measurement*, not a threshold: one mark is the
 * minimum evidence that the rule was able to see anything at all. **It does not make the recovery
 * complete.** The union happens to recover every cohort wallet-instance on our own tape, but that
 * is a measurement on the one deployer whose cohort is named, not a property of the rule: a wallet
 * that neither shares a transaction nor rides the deployer's run is still counted as independent,
 * and a book that accumulates in the slots after the create slot is still invisible. A proven room
 * figure remains an **upper bound**, exactly as before.
 *
 * **The predicate is CREATE-SLOT-SCOPED, not operation-scoped, and it is not proof that the
 * operation co-ordinated.** Half (a) asks only whether *some* transaction in the create slot
 * carried 2+ distinct wallets: a create slot in which the deployer buys entirely alone while two
 * unrelated wallets happen to share one transaction — a shared aggregator or copy-trade route —
 * qualifies, and on such a launch the operation's own stake is still booked outside the numerator.
 * So this is a **floor on the evidence**, not a guarantee of recovery, which is the other reason a
 * proven room figure is an upper bound.
 *
 * **No tighter predicate is available, and that was measured rather than assumed** (captain
 * decision 139a). The obvious tightening — require a bundle containing the deployer — matches
 * **0 of 235** covered launches: this deployer never shares its own create-slot transaction, the
 * dev buy is a 1-wallet transaction every time, and the operation's cohort bundles among *itself*
 * (typically two 3-wallet transactions). Adopting it would refuse every launch, leave Stage 2 with
 * nothing to score for any wallet, and hard-fail Stage 0 twice — the era buckets go to `n = 0` and
 * trip their own `minN` vacuity guard, and the known-negative control becomes `entry-unmeasured`.
 *
 * **What was measured and REFUSED as the widening, so it is not re-proposed:** a recurrence rule
 * marking a wallet that appears in k of the candidate's trailing 8 create slots. At k = 8 it missed
 * 112 cohort instances and falsely marked 4 outsiders; it is behavioural inference where every
 * other rule here is a structural fact, and it is contaminated by general-purpose snipers who
 * appear across many unrelated deployers
 * (`slot-zero-bundling-predicate-question/report.md` §6).
 *
 * @param {Pick<CreateSlotMeasurement, 'coordinatedWallets'>} m
 * @returns {boolean}
 */
export function roomIsProven(m) {
  return m.coordinatedWallets >= 1;
}

/**
 * The support of {@link CreateSlotMeasurement.roomLeft}, and it is ALGEBRAIC rather than measured.
 *
 * {@link tallyCreateSlot} builds `operationShare` as `(devSol + coordinatedSol) / (devSol +
 * coordinatedSol + independentSol)` over {@link createSlotGroups}' `inSlot`, which is filtered to
 * `side === 'buy'` — so every term is a non-negative amount of SOL paid, the ratio is in [0, 1], and
 * `roomLeft = 1 - operationShare` is too. The empty create slot takes the `denominator > 0` fallback
 * and lands at `operationShare = 1`, `roomLeft = 0`, inside the same interval.
 *
 * **Why this is exported rather than left implicit.** `entry.mjs` → `roomBarRobustness` bounds what
 * an UNMEASURED launch's room could have been, and the only thing it may assume about a launch
 * nobody walked is the arithmetic range of the quantity. A bound taken from the committed tape's
 * observed spread would be an n = 1 empirical claim wearing an algebraic one's clothes; this is not
 * that. Widening these numbers is not a tuning knob — it would mean `roomLeft` had stopped being a
 * share, and the assertion `every roomLeft on the committed tape lies inside its algebraic support`
 * in `test/deployer-screen.test.ts` is what would say so.
 *
 * @type {Readonly<{ min: number, max: number }>}
 */
export const ROOM_LEFT_RANGE = Object.freeze({ min: 0, max: 1 });

/**
 * @typedef {object} CreateSlotTally
 * @property {CreateSlotMeasurement} measurement
 * @property {Set<string>} outsiders Create-slot wallets left unattributed to the operation — the
 *   exact population `measurement.independentWallets` counts, handed over rather than recounted.
 */

/**
 * The create-slot arithmetic, over {@link createSlotGroups}' partition.
 *
 * Separated from {@link measureCreateSlot} so that it and `entry.mjs`'s field measurement share
 * **one** definition of who the operation is *and* one definition of the arithmetic on top of it.
 * The two numbers are read side by side, so a change to either has to move both or neither.
 *
 * @param {CreateSlotGroups} groups
 * @returns {CreateSlotTally}
 */
export function tallyCreateSlot(groups) {
  const { slot, deployer, coordinated, inSlot, bundledTx, maxWalletsInOneTx, runTx, adjacencyMarks } =
    groups;

  let devSol = 0;
  let coordinatedSol = 0;
  let independentSol = 0;
  /** @type {Set<string>} */
  const outsiders = new Set();
  for (const f of inSlot) {
    if (f.wallet === deployer) devSol += f.sol;
    else if (coordinated.has(f.wallet)) coordinatedSol += f.sol;
    else {
      independentSol += f.sol;
      outsiders.add(f.wallet);
    }
  }

  const totalOtherSol = coordinatedSol + independentSol;
  const denominator = devSol + totalOtherSol;
  // A create slot with no capital in it at all carries no information about room. Treat it as
  // fully occupied rather than dividing by zero and calling it wide open.
  const operationShare = denominator > 0 ? (devSol + coordinatedSol) / denominator : 1;

  return {
    measurement: {
      slot,
      deployer,
      devSol,
      coordinatedSol,
      independentSol,
      totalOtherSol,
      coordinatedWallets: coordinated.size,
      independentWallets: outsiders.size,
      bundledTx,
      maxWalletsInOneTx,
      runTx,
      adjacencyMarks,
      operationShare,
      roomLeft: 1 - operationShare,
    },
    outsiders,
  };
}

/**
 * The block transaction index pump.fun's within-slot ordering key encodes.
 *
 * `sid` (`slotIndexId` live) is a fixed-width decimal key, `slot(12) + blockTxIndex(6) +
 * innerInstructionIndex(4)`. That decomposition was **validated, not assumed**: over all 2,699
 * create-slot fills of the committed 235-launch tape, the leading field equals the fill's own slot
 * on every row, no transaction ever carries two different block indices, and the largest index seen
 * is 2,788 — consistent with Solana block sizes
 * (`slot-zero-bundling-predicate-question/report.md` §3.1).
 *
 * **It returns `NaN` rather than a guess when the key is not that shape**, and that matters: if
 * pump.fun changes the format, every run collapses and every launch that depended on adjacency
 * becomes unproven again. That is the safe direction — a return to the pre-182a behaviour — but it
 * is silent, which is why Stage 0 asserts that the subject's pre-March launches still produce runs.
 *
 * @param {string} sid
 * @returns {number} `NaN` when the key does not carry a readable six-digit index.
 */
export function blockTxIndex(sid) {
  if (sid.length < 10) return Number.NaN;
  const digits = sid.slice(-10, -4);
  if (!/^[0-9]{6}$/.test(digits)) return Number.NaN;
  return Number(digits);
}

/**
 * @typedef {object} CreateSlotGroups
 * @property {number} slot                 The create slot.
 * @property {string} deployer             Wallet credited with the launch (first curve buyer).
 * @property {Set<string>} coordinated     Non-deployer wallets the co-ordination rule marks as the
 *   operation's own — the UNION of both halves. Never contains `deployer`.
 * @property {Set<string>} coordinatedBySharedTx The SHARED-TRANSACTION half's marks on their own, a
 *   subset of `coordinated` by construction. Kept so the union's direction of error is checkable
 *   against the older reading rather than argued for in a comment.
 * @property {Fill[]} inSlot               Create-slot bonding-curve buys, **ordered by `sid`** —
 *   pump.fun's own within-slot ordering key, so the sequence is the fill queue as the venue saw
 *   it, not the order the tape happened to arrive in.
 * @property {number} bundledTx            Create-slot transactions carrying 2+ distinct wallets.
 * @property {number} maxWalletsInOneTx    Largest wallet count in a single create-slot transaction.
 * @property {number} runTx                Transactions in the deployer-anchored contiguous run,
 *   anchor included. `0` when no run could be read.
 * @property {number} adjacencyMarks       Wallets half (b) marked that half (a) did not.
 */

/**
 * Partition a launch's create slot into deployer / co-ordinated / everyone else.
 *
 * Extracted so {@link measureCreateSlot} and `entry.mjs`'s field measurement share **one**
 * definition of who the operation is. If they each derived it, a change to the co-ordination rule
 * could move the room figure without moving the population it is a statement about — and the two
 * numbers are read side by side.
 *
 * ## The co-ordination rule is a UNION of two structural tests (captain decision 182a)
 *
 * **(a) Shared transaction.** A create-slot transaction carrying 2+ distinct swapping wallets marks
 * all of them. Traders acting alone do not arrange to share a transaction; a third party can put two
 * strangers in one, which is rare and biases towards refusal — {@link roomIsProven} owns that
 * qualification and its measurement. Unchanged, and never relaxed.
 *
 * **(b) The deployer-anchored contiguous block-index run.** Sort the create slot's transactions by
 * {@link blockTxIndex}; start at the one carrying the deployer's own curve buy and walk outwards in
 * both directions while the step is **exactly 1**. Every wallet in that run is marked. A Jito
 * bundle executes as an atomic contiguous sequence and no outsider can insert a transaction into
 * it, so a transaction at the deployer's index ± 1 is either inside the deployer's own submission
 * or the very next thing the leader packed. The second case is possible, which makes (b) weaker
 * than (a) — empirical where (a) is structural — so it was disconfirmed rather than assumed:
 * adjacency among create-slot transactions OUTSIDE the run runs at **12.35%**, which predicts ~25
 * of the tape's 201 runs-with-a-boundary should have swept an outsider in; **one did**, and the
 * shipped shared-transaction rule already marks the same two wallets for sharing a transaction with
 * each other. The run also does not end at an arbitrary cut — the gap to the next create-slot
 * transaction is a median of 108 indices, and only 2 of 201 launches have a boundary as close as it
 * can come to moving (`slot-zero-bundling-predicate-question/report.md` §3.2, §3.5).
 *
 * **Step 1 and not 2 or 3.** Widening the tolerance buys almost nothing and costs precision:
 * recall over cohort wallet-instances goes 1,083 → 1,092 at step ≤ 2 and → 1,098 at step ≤ 3, where
 * false marks go 2 → 4. Strict contiguity is the setting the evidence supports.
 *
 * **UNION, NEVER REPLACEMENT — this is the safety property the whole change rests on.** (a)'s
 * marked set is a subset of the union's, so `operationShare` can only rise and `roomLeft` can only
 * fall relative to the older reading. Decision 134a's asymmetry — that every error this rule makes
 * must run towards refusing a deployer, never towards accepting one — becomes structural rather
 * than empirical. An implementation of (b) that could ever RAISE a room reading is wrong.
 *
 * **What (b) costs: nothing.** `sid` is already on every fill {@link parseFill} reads. No request,
 * no host, no vendor quota, no new parse of a new field.
 *
 * **Two limits that travel with it.** The union's room readings equal ground truth on the ONE
 * deployer whose cohort is named, and there is no second answer key in this repository. And whether
 * an adjacent transaction is a true Jito bundle or merely the leader's packing order is an
 * *inference*: nothing keyless exposes a bundle id. The arithmetic is unaffected either way — the
 * seat next to the deployer's went to whoever the deployer wanted it to, or to a coincidence the
 * null model above says is rare — but this marks adjacency, not a decoded bundle.
 *
 * @param {readonly Fill[]} fills All fills for one launch, any order.
 * @returns {CreateSlotGroups | null} `null` when there is no bonding-curve buy to anchor on.
 */
export function createSlotGroups(fills) {
  const curveBuys = fills.filter((f) => f.side === 'buy' && f.venue === 'pump');
  if (curveBuys.length === 0) return null;

  // The create slot is the earliest slot carrying a curve buy, and the deployer is the wallet
  // that buys first within it. Reading the deployer off the fills rather than trusting a
  // `creator` field matters: pump.fun's creator record can move on-chain (CLAUDE.md), and the
  // token that goes missing is exactly the good one.
  let slot = Infinity;
  for (const f of curveBuys) if (f.slot < slot) slot = f.slot;
  const inSlot = curveBuys
    .filter((f) => f.slot === slot)
    .sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));

  const first = inSlot[0];
  if (first === undefined) return null;
  const deployer = first.wallet;

  // Group by transaction, keeping each one's block index alongside its wallets. `inSlot` is already
  // in `sid` order, so the first fill of a transaction carries that transaction's index.
  //
  // `indexesAreConsistent` is the guard on half (b)'s premise, and it is deliberately strict. A
  // block transaction index identifies a transaction WITHIN one block, so within one create slot it
  // must be unique per transaction and constant across that transaction's fills. Both were verified
  // over the committed tape's 2,699 create-slot fills. If either stops holding, the decomposition is
  // reading something other than a block index — and the resulting run would not be short, it would
  // be WRONG: a whole create slot at one apparent index would be swallowed whole, marking every
  // outsider as the operation. That is the one direction this rule's errors must never run in
  // (see {@link measureCreateSlot}), so an inconsistent slot gets no adjacency at all and falls back
  // to half (a) alone — the reading the screen had before decision 182a.
  /** @type {Map<string, { index: number, wallets: Set<string> }>} */
  const byTx = new Map();
  /** @type {Set<number>} */
  const indexesSeen = new Set();
  let indexesAreConsistent = true;
  for (const f of inSlot) {
    const index = blockTxIndex(f.sid);
    let entry = byTx.get(f.tx);
    if (entry === undefined) {
      entry = { index, wallets: new Set() };
      byTx.set(f.tx, entry);
      if (!Number.isFinite(index) || indexesSeen.has(index)) indexesAreConsistent = false;
      indexesSeen.add(index);
    } else if (entry.index !== index) {
      indexesAreConsistent = false;
    }
    entry.wallets.add(f.wallet);
  }

  // --- (a) the shared-transaction rule. A transaction with 2+ distinct wallets marks all of them.
  /** @type {Set<string>} */
  const coordinatedBySharedTx = new Set();
  let bundledTx = 0;
  let maxWalletsInOneTx = 0;
  for (const { wallets } of byTx.values()) {
    if (wallets.size > maxWalletsInOneTx) maxWalletsInOneTx = wallets.size;
    if (wallets.size >= 2) {
      bundledTx += 1;
      for (const w of wallets) coordinatedBySharedTx.add(w);
    }
  }
  coordinatedBySharedTx.delete(deployer);

  // --- (b) the deployer-anchored contiguous block-index run. The step must be EXACTLY 1 in each
  // direction; anything else ends the run there. Widening it was measured and rejected (see the
  // block comment above), and narrowing is not possible.
  const ordered = indexesAreConsistent
    ? [...byTx.values()].sort((a, b) => a.index - b.index)
    : [];
  const anchor = ordered.findIndex((e) => e.wallets.has(deployer));
  /** @type {Set<string>} */
  const coordinatedByAdjacency = new Set();
  let runTx = 0;
  if (anchor >= 0) {
    const start = /** @type {{ index: number, wallets: Set<string> }} */ (ordered[anchor]);
    runTx = 1;
    for (let i = anchor + 1, prev = start.index; i < ordered.length; i++) {
      const e = /** @type {{ index: number, wallets: Set<string> }} */ (ordered[i]);
      if (e.index - prev !== 1) break;
      prev = e.index;
      runTx += 1;
      for (const w of e.wallets) coordinatedByAdjacency.add(w);
    }
    for (let i = anchor - 1, prev = start.index; i >= 0; i--) {
      const e = /** @type {{ index: number, wallets: Set<string> }} */ (ordered[i]);
      if (prev - e.index !== 1) break;
      prev = e.index;
      runTx += 1;
      for (const w of e.wallets) coordinatedByAdjacency.add(w);
    }
  }
  coordinatedByAdjacency.delete(deployer);

  // --- the union. Never a replacement: (a)'s set goes in whole, so `coordinated` can only grow.
  const coordinated = new Set([...coordinatedBySharedTx, ...coordinatedByAdjacency]);
  let adjacencyMarks = 0;
  for (const w of coordinatedByAdjacency) if (!coordinatedBySharedTx.has(w)) adjacencyMarks += 1;

  return {
    slot,
    deployer,
    coordinated,
    coordinatedBySharedTx,
    inSlot,
    bundledTx,
    maxWalletsInOneTx,
    runTx,
    adjacencyMarks,
  };
}

/**
 * @typedef {object} WalletTransaction
 * One on-chain transaction a set of wallets traded in, and what the fill tape says each of them
 * committed inside it.
 *
 * @property {string} tx        Transaction signature — the thing an RPC call is spent on.
 * @property {number} slot
 * @property {{ wallet: string, quotedSol: number }[]} wallets `quotedSol` is buys minus sells for
 *   that wallet **in this transaction**, in swap-quote SOL. It is the baseline the entry cost is
 *   measured against: what the wallet's real lamport change exceeds this by is the fee, the venue
 *   fee, the rent, any tip paid inside the same transaction, and execution difference.
 */

/**
 * Group a launch's fills into the distinct TRANSACTIONS a named set of wallets traded in.
 *
 * **This is why pricing entry costs a walk and not a search.** Every fill Stage 2 already parses
 * carries `tx` ({@link Fill}), so the signatures that bought a stranger's create slot are a
 * by-product of a walk that has already happened — no discovery step, no vendor request, no extra
 * `swap-api` page. The cost of the walk is then **distinct transactions, not entrants**: one
 * bundled transaction prices every wallet in it, which is the same fee-payer asymmetry
 * `onchain_*.csv` carries `is_fee_payer` for.
 *
 * Pure, and deliberately so — the network stays out of the measurement core, exactly as it does for
 * the room and field legs. `pumpfun.mjs` → `readCreateSlotCosts` is what spends requests on the
 * result.
 *
 * @param {readonly Fill[]} fills All fills for one launch's opening window.
 * @param {ReadonlySet<string>} wallets Whose transactions to collect.
 * @param {number | null} slot Restrict to this slot — the create slot, for the entry-cost scope —
 *   or `null` for every transaction in the window, which is what a round trip's true P&L needs.
 * @returns {WalletTransaction[]} Ascending by slot, then by signature, so a walk is deterministic.
 */
export function walletTransactions(fills, wallets, slot) {
  /** @type {Map<string, { tx: string, slot: number, byWallet: Map<string, number> }>} */
  const byTx = new Map();
  for (const f of fills) {
    if (!wallets.has(f.wallet)) continue;
    let entry = byTx.get(f.tx);
    if (entry === undefined) {
      entry = { tx: f.tx, slot: f.slot, byWallet: new Map() };
      byTx.set(f.tx, entry);
    }
    // A transaction sits in one slot; the earliest fill's slot is that slot, and taking the minimum
    // rather than the first-seen keeps this independent of the order the tape arrived in.
    if (f.slot < entry.slot) entry.slot = f.slot;
    entry.byWallet.set(f.wallet, (entry.byWallet.get(f.wallet) ?? 0) + (f.side === 'buy' ? f.sol : -f.sol));
  }

  /** @type {WalletTransaction[]} */
  const out = [];
  for (const entry of byTx.values()) {
    if (slot !== null && entry.slot !== slot) continue;
    out.push({
      tx: entry.tx,
      slot: entry.slot,
      wallets: [...entry.byWallet].map(([wallet, quotedSol]) => ({ wallet, quotedSol })),
    });
  }
  out.sort((a, b) => a.slot - b.slot || (a.tx < b.tx ? -1 : a.tx > b.tx ? 1 : 0));
  return out;
}

/**
 * @typedef {object} CompletionMeasurement
 * @property {number} tokens        Denominator: token records seen.
 * @property {number} completed     Numerator: records whose curve completed.
 * @property {number} rate          `completed / tokens`, or `NaN` when `tokens === 0`.
 * @property {number} spanDays      First to last deploy, in days.
 * @property {string | null} firstDeployIso
 * @property {string | null} lastDeployIso
 * @property {number} droppedNoTimestamp Records excluded for an unusable deploy time.
 */

/**
 * @typedef {object} TokenRecord
 * @property {number} deployedAtMs
 * @property {boolean} completed
 */

/**
 * Compute a completion rate from denominator-complete per-token records.
 *
 * **The denominator is the whole point.** MadeOnSol publishes four aggregate completion
 * figures and every one of them is unusable: `bonding_rate`, `total_bonded` and
 * `total_tokens_deployed` are a trailing window of roughly 7.5 days that slides and shrinks
 * (measured 22/15/0.6818 and then 20/13/0.6500 two hours later, against a ground truth of
 * 239/103/0.4310), and `/deployer-hunter/{wallet}/tokens` is **bonded-only**, so its
 * `bonded / total` is 1.0000 for every deployer alive. The only surface of theirs that carries
 * both outcomes is `profile.pump_tokens`, which is why {@link toTokenRecords} reads that and
 * nothing else.
 *
 * @param {readonly TokenRecord[]} records
 * @returns {CompletionMeasurement}
 */
export function measureCompletion(records) {
  const usable = records.filter((r) => Number.isFinite(r.deployedAtMs) && r.deployedAtMs > 0);
  const dropped = records.length - usable.length;

  if (usable.length === 0) {
    return {
      tokens: 0,
      completed: 0,
      rate: Number.NaN,
      spanDays: 0,
      firstDeployIso: null,
      lastDeployIso: null,
      droppedNoTimestamp: dropped,
    };
  }

  const times = usable.map((r) => r.deployedAtMs).sort((a, b) => a - b);
  const lo = times[0];
  const hi = times[times.length - 1];
  if (lo === undefined || hi === undefined) throw new Error('unreachable: non-empty array has no bounds');

  const completed = usable.filter((r) => r.completed).length;
  return {
    tokens: usable.length,
    completed,
    rate: completed / usable.length,
    spanDays: (hi - lo) / 86_400_000,
    firstDeployIso: new Date(lo).toISOString(),
    lastDeployIso: new Date(hi).toISOString(),
    droppedNoTimestamp: dropped,
  };
}

/**
 * Project a MadeOnSol deployer profile onto the only field pair of theirs we trust for a
 * completion rate.
 *
 * Reads `pump_tokens[].created_timestamp` and `pump_tokens[].complete`, and deliberately
 * ignores every aggregate in the payload. `pump_tokens` was verified against our own tape at
 * **67/67 exact agreement** on the completion flag with zero launches missing, so the records
 * are trustworthy; it is the summaries built on top of them that are not.
 *
 * Note what is *not* retained: no mint, no name, no symbol, no market cap, no bond time. Two
 * fields per token, reduced to seven numbers per wallet, and the records are dropped when the
 * process exits. That is the ToS clause 5a(d) containment, implemented rather than promised —
 * see README.md, "Retention".
 *
 * @param {unknown} profile A parsed `/deployer-hunter/{wallet}` response.
 * @returns {{ records: TokenRecord[], capped: boolean }} `capped` is true when the vendor
 *   returned a full page, meaning older tokens exist that this surface will not show.
 */
export function toTokenRecords(profile) {
  if (typeof profile !== 'object' || profile === null) return { records: [], capped: false };
  const raw = /** @type {Record<string, unknown>} */ (profile)['pump_tokens'];
  if (!Array.isArray(raw)) return { records: [], capped: false };

  /** @type {TokenRecord[]} */
  const records = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = /** @type {Record<string, unknown>} */ (entry);
    records.push({
      deployedAtMs: Number(row['created_timestamp']),
      completed: row['complete'] === true,
    });
  }
  // 70 is the page pump.fun's creator listing serves regardless of the limit asked for, and
  // MadeOnSol mirrors one page. A full page means the history is truncated, not that it ended.
  return { records, capped: records.length >= 70 };
}

/**
 * @typedef {object} LaunchRef
 * @property {string} mint
 * @property {number} deployedAtMs
 */

/**
 * Project a vendor profile onto the launches Stage 2 will walk the keyless fill tape for.
 *
 * **This is why Stage 2 costs no keyed request at all.** Stage 1 has already paid for
 * `/deployer-hunter/{wallet}`; the mint and deploy time it carries are enough to seek straight to
 * each launch's opening window on pump.fun's free trade endpoint. Nothing here issues a request,
 * and no second vendor surface is consulted.
 *
 * **Retention, MadeOnSol terms §5a(d).** These mints live in memory for the duration of one run and
 * are dropped when the process exits. They are never written — not to `--out`, not to a cache, not
 * to a log. What survives a run is the derived distribution computed from the *fills*, which are
 * pump.fun's public data and not the vendor's. `screen.mjs` → `toRecordRow` is where that is
 * enforced, and `test/deployer-screen.test.ts` asserts the persisted key set against the committed
 * records so the claim cannot drift from the code.
 *
 * Returned newest first, because a run samples the most recent launches and "recent" is the only
 * horizon this vendor surface can honestly speak to.
 *
 * @param {unknown} profile A parsed `/deployer-hunter/{wallet}` response.
 * @returns {LaunchRef[]}
 */
export function toLaunchRefs(profile) {
  if (typeof profile !== 'object' || profile === null) return [];
  const raw = /** @type {Record<string, unknown>} */ (profile)['pump_tokens'];
  if (!Array.isArray(raw)) return [];

  /** @type {LaunchRef[]} */
  const refs = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = /** @type {Record<string, unknown>} */ (entry);
    const mint = row['mint'] ?? row['token_mint'] ?? row['address'];
    const deployedAtMs = Number(row['created_timestamp']);
    // A record without a usable mint or deploy time cannot be seeked to, and guessing either would
    // point the walk at the wrong window rather than at no window.
    if (typeof mint !== 'string' || mint === '' || !Number.isFinite(deployedAtMs) || deployedAtMs <= 0) {
      continue;
    }
    refs.push({ mint, deployedAtMs });
  }
  refs.sort((a, b) => b.deployedAtMs - a.deployedAtMs);
  return refs;
}

/**
 * Linear-interpolated percentile, matching the convention the population tape's own report
 * used. `src/units.ts` carries the same function for the keyless core; see the note in
 * {@link CURVE_K} on why it is not imported.
 *
 * @param {readonly number[]} values
 * @param {number} p 0..1
 * @returns {number} `NaN` for an empty input.
 */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const v = [...values].sort((a, b) => a - b);
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = v[lo];
  const b = v[hi];
  if (a === undefined || b === undefined) return Number.NaN;
  return lo === hi ? a : a + (b - a) * (idx - lo);
}

/** @param {readonly number[]} values @returns {number} */
export function median(values) {
  return percentile(values, 0.5);
}
