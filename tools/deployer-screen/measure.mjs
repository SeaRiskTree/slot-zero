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
 * Lamports in one SOL. Named so the conversion is never a bare literal in an arithmetic line.
 *
 * It lives in the pure core rather than beside the RPC reader that consumes it (captain decision
 * 260a). It is a property of Solana's unit, not of any vendor, and it was `stage0.mjs`'s ONLY
 * reason to import `pumpfun.mjs` — i.e. the last edge by which a scoring module reached a fill
 * source at all. Keeping a unit constant in a transport module is what made that edge look
 * necessary; it is not.
 */
export const LAMPORTS_PER_SOL = 1_000_000_000;

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
 * `population-tape-2026-07-29/onchain_create_slot_pnl.csv`, half (a) marks 11 non-cohort
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
 * @typedef {object} WindowFill
 * The minimum a fill must carry for {@link measureWindowParticipation} to read it.
 *
 * **It is deliberately SMALLER than {@link Fill}, and every field it drops was dropped on purpose.**
 * No `sid`: pump.fun's within-slot ordering key is a pump.fun key, and half (b) of the create-slot
 * rule is the only thing that needs one. No `tx`: the shared-transaction half is the only thing that
 * needs one, and on the population this measure exists for it fires on 0.00% of launches. No `venue`
 * and no `priceSol`: the venue enum names two pump.fun programs, and neither the enum nor a price is
 * something this measure reads. {@link Fill} is structurally assignable to this, so a pump.fun window
 * can be handed in unchanged — but a walk over a venue this repo does not yet read only has to
 * produce these four fields, which is the whole point of stating them apart.
 *
 * @property {number} slot   Solana slot.
 * @property {string} wallet The **swapping** wallet, never the fee payer — {@link Fill} owns why on
 *   pump.fun, and the distinction is native rather than reconstructed on Meteora DBC, where
 *   `call_swap.account_payer` is the trader and `call_tx_signer` is the fee payer.
 * @property {'buy' | 'sell'} side
 * @property {number} sol    Swap-quote SOL, **gross of the venue fee and of priority fees**, exactly
 *   as {@link Fill.sol} is.
 */

/**
 * @typedef {object} WindowParticipation
 * What {@link measureWindowParticipation} saw in one window, kept in halves a later reader can
 * recompose without re-running the walk.
 *
 * **The two halves are the create slot and everything after it**, reported apart for the same reason
 * {@link CreateSlotMeasurement} reports `bundledTx` and `runTx` apart: the narrow reading and the
 * wide one are then both recoverable from a saved record, and the size of what the wide framing ADDS
 * is a number rather than an argument. `windowOnlyOutsiderWallets` is that size — the exact analogue
 * of `adjacencyMarks` one framing over.
 *
 * @property {string | null} deployer   The wallet credited with the launch, as the CALLER
 *   established it — `null` when nobody did. It is an input here and not a derivation, which is a
 *   real difference from {@link createSlotGroups}: reading the deployer off the fills works on
 *   pump.fun because the deployer's own buy opens every curve, and it does NOT work on a venue where
 *   the creator buys its own launch on 60.59% of the band and not at all on the rest.
 * @property {number | null} createSlot The window's opening slot, as the caller established it.
 *   `null` leaves the two halves UNREAD rather than guessed — see the `null` fields below.
 * @property {number} fills             Fills handed in, whoever made them.
 * @property {number} outsiderWallets   Distinct wallets that are neither the deployer nor one of the
 *   caller's supplied operation wallets. **This is the quantity the predicate reads.**
 * @property {number} outsiderFills
 * @property {number} outsiderBuySol    Buy-side SOL from those wallets, gross of fees.
 * @property {number} outsiderSellSol   Sell-side SOL from those wallets, gross of fees. Kept apart
 *   from the buy side rather than netted: a net figure cannot be told from a small gross one, and
 *   the two are what a later deployer-take-versus-field series would be built from.
 * @property {number} operationWallets  Distinct supplied operation wallets that actually filled —
 *   never the size of the supplied set, which would count wallets that never traded.
 * @property {number} operationFills
 * @property {number} operationBuySol
 * @property {number} operationSellSol
 * @property {number | null} createSlotOutsiderWallets     Half one, on its own. `null` when no
 *   create slot was supplied.
 * @property {number | null} createSlotOutsiderFills
 * @property {number | null} afterCreateSlotOutsiderWallets Half two, on its own.
 * @property {number | null} afterCreateSlotOutsiderFills
 * @property {number | null} windowOnlyOutsiderWallets     Wallets half two shows that half one did
 *   NOT. The size of what the whole-window framing adds over a create-slot-only one, and the number
 *   that reads 134 on this venue's median launch and 0 on a launch whose whole contest is in the
 *   create slot. **The halves do not sum to `outsiderWallets`** — a wallet present in both is
 *   counted in both — which is exactly why this field exists rather than a subtraction.
 * @property {number} preCreateSlotFills Fills at a slot EARLIER than the supplied create slot. A
 *   tripwire, and it should be 0: a non-zero value means the caller's window bounds and its create
 *   slot disagree, which is the same shape as a backwards walk that overshot its own mint. Those
 *   fills are in `fills` and in the outsider/operation totals; they are in NEITHER half.
 * @property {number | null} firstFillSlot
 * @property {number | null} lastFillSlot Both `null` on an empty window. **Their difference is not a
 *   duration** — slot time is not constant and this repo has already paid for treating it as though
 *   it were (`pumpfun.mjs` → `windowReachMs`) — so a window length in seconds is the caller's to
 *   establish from the venue's own timestamps, not this measure's to infer.
 */

/**
 * The statement of what a proven whole-window reading claims, and what it does not.
 *
 * It is a constant rather than a paragraph in a document because a caller can print it, a record can
 * carry it, and a reader who never opened this file still gets it — the same reason
 * {@link RAISE_85_IS_THE_COMPLETION_MEASURE} and `dune.mjs` → `MAYHEM_NOT_COMPETENCE` are constants.
 *
 * **The distinction it protects is the reason a second predicate exists at all.**
 * {@link roomIsProven} asks whether the co-ordination rule could see ANYTHING in the create slot,
 * and a launch that passes it is one whose `roomLeft` may be read as measured rather than as the
 * absence of evidence. This asks something else entirely: whether the window was CONTESTED — whether
 * wallets outside the launch operation traded in it at all. A window can be heavily contested and
 * carry no co-ordination evidence whatever, which is precisely the population this measure was built
 * for, and a create slot can carry co-ordination evidence in a window nobody else entered.
 * **Neither predicate implies the other, and this one is NOT a loosened {@link roomIsProven}.**
 */
export const WINDOW_PARTICIPATION_IS_A_DIFFERENT_CLAIM =
  'CONTESTED PARTICIPATION OVER A WINDOW IS NOT OPERATOR CO-ORDINATION. A proven reading here says ' +
  'that wallets outside the launch operation traded inside the window, and says NOTHING about ' +
  'whether the operation co-ordinated a book of its own, nor about how much of the window it took. ' +
  'It is therefore a DIFFERENT CLAIM from measure.mjs -> roomIsProven and not a looser version of ' +
  'it: roomIsProven licenses a room SHARE to be read as measured, this licenses only the statement ' +
  'that the window had a field in it. Neither implies the other. NO roomLeft, operationShare, ' +
  'entry verdict or spend may be computed from a reading proven under this predicate alone — ' +
  'wiring it to anything that decides is a captain decision, not an implementation step.';

/**
 * The outsider-wallet counts the evidence was measured at, ASCENDING — and this is not a bar.
 *
 * `slot-zero-meteora-dbc-venue-scope` → `report.md` §4 (held in firstmate's records, not in this
 * repo — see `CLAUDE.md` → "Citing a report this repo does not hold") counts supply at exactly these
 * three, over SOL-quoted Meteora DBC launches on configs whose migration threshold is ≥ 10 SOL:
 *
 * | bar | usable, 2026-06 | usable, 2026-07 | repeat-deployer slice, 2026-06 |
 * |---:|---:|---:|---:|
 * | ≥ 5  | 17,657 | 21,139 | 3,626 |
 * | ≥ 20 | 13,459 | 19,062 | 1,778 |
 * | ≥ 50 | 11,260 | 17,590 | — |
 *
 * So the range where evidence exists is **5 to 50**, and inside it the supply question is already
 * answered in both directions: even the weakest month at the strictest measured bar clears the
 * captain's 1,000-window floor by 1.8x, so **a bar in this range is not chosen to buy supply.** What
 * a higher bar buys is a stronger claim about the window having been contested; what it costs is the
 * thinner launches — and that trade is MOOT rather than open, because the venue line is CLOSED
 * (captain decision 413a, 2026-08-10). Net-of-fees profitability on this band HAS since been
 * measured: `slot-zero-dbc-netfees-profitability` → `report.md` (held in firstmate's records, not in
 * this repo) finds it loses 13.6–29.5% of deployed capital on every sampled day, negative BEFORE
 * fees rather than after. See `CLAUDE.md` → "Meteora DBC: the venue line is CLOSED".
 *
 * **This module pins NO bar and must not acquire one.** {@link windowParticipationIsProven} takes it
 * as a required parameter and refuses without it, because a default IS a pin and this pass measures
 * rather than tunes. Picking the number returns to the captain.
 *
 * @type {readonly number[]}
 */
export const WINDOW_OUTSIDER_BAR_MEASURED_AT = Object.freeze([5, 20, 50]);

/**
 * Measure who, other than the launch operation, traded inside one window.
 *
 * ## Why this exists beside {@link roomIsProven} rather than replacing it
 *
 * {@link roomIsProven} is create-slot-scoped by construction — it reads
 * {@link CreateSlotMeasurement.coordinatedWallets}, which {@link createSlotGroups} computes over the
 * create slot alone. On pump.fun that is where the contest is, and the hard part is telling the
 * operator's own wallets from strangers: the evidence exists and is ambiguous, and captain decision
 * 203a established that the disambiguating evidence cannot be got.
 *
 * **On Meteora DBC the difficulty is the opposite one, and it was measured rather than predicted.**
 * Over July 2026's SOL-quoted launches on 10–30 SOL migration-threshold configs — 19,826 pools with
 * any create-slot fill — the co-ordination rule fires on **0.00%**, with a **maximum of one wallet
 * per transaction across the entire month**, computed twice by independent routes. The create slot
 * holds **one wallet and one fill at the median**. There is no co-ordination evidence there because
 * at the create slot there is nothing to co-ordinate: the contest runs over the following window,
 * which on that band is a median **134 seconds, 134 distinct outsider wallets and 181 fills**, with
 * the first outsider fill a median 0.9 s in. So porting {@link roomIsProven} unchanged refuses ~100%
 * of that band — **which is a measurement of the wrong instrument being pointed at it, not a
 * measurement that the band is unprovable.** Captain decision 408a settled the direction: the
 * create-slot framing is replaced by a whole-window one for that venue.
 * `slot-zero-meteora-dbc-venue-scope` → `report.md` §§2 and 3 owns every figure above and is held in
 * firstmate's records, not in this repo.
 *
 * ## What it claims
 *
 * {@link WINDOW_PARTICIPATION_IS_A_DIFFERENT_CLAIM}, and that constant is the statement rather than
 * this paragraph. In one line: **contested participation, not operator co-ordination.**
 *
 * ## The three things it takes as INPUTS rather than deriving, and why each has to be
 *
 * 1. **The window.** The fills handed in ARE the window; this function does not bound one and could
 *    not. On the venue it was built for the window ends at curve completion, which is an event in a
 *    different table and is not in the fill stream at all. Handing in an unbounded fill list
 *    measures participation over whatever was handed in, and says so honestly.
 * 2. **The deployer.** {@link createSlotGroups} reads it off the fills — the first curve buyer in the
 *    earliest slot — and that works on pump.fun because the deployer's own buy is what opens every
 *    curve. It does NOT work here: the creator buys its own launch on **60.59%** of that band, so on
 *    the rest the first filling wallet is a stranger, and crediting them would attribute the whole
 *    window's opening to the wrong side. `null` is a supported answer and means the caller
 *    established nobody; then nothing is attributed to the operation from the deployer side, and
 *    every filling wallet is an outsider. That reads participation HIGH, which is the direction that
 *    manufactures an instrument where there is none, so a caller that can name the deployer must.
 * 3. **The operation's other wallets.** There is no structural rule here to recover them with — that
 *    is the whole finding above. Whatever the caller knows (a supplied cohort, the create-slot rule's
 *    own marks on a venue where it fires, nothing at all) is what gets excluded, and the same
 *    asymmetry applies: an operation wallet the caller cannot name is counted as an outsider and
 *    reads participation HIGH. `tools/window-decay-tripwire/` takes a cohort on the same terms and
 *    for the same reason.
 *
 * ## What it is not
 *
 * Not a room figure, not a share, not a verdict, and not evidence that entering the window is
 * profitable — every wallet in any window this ever reads is a wallet that already won, which is
 * `entry.mjs` → `WINNERS_ONLY_CAVEAT` one venue over. It is pure, reads no clock and no vendor, and
 * nothing in this repository calls it.
 *
 * @param {object} input
 * @param {readonly WindowFill[]} input.fills One window's fills, bounded by the caller, any order.
 * @param {string | null} [input.deployer] The wallet credited with the launch, or `null`/absent when
 *   nobody established one.
 * @param {Iterable<string> | null} [input.operationWallets] Wallets already known to belong to the
 *   launch operation. The deployer is added to this set when it is known, so a caller never has to
 *   remember to include it.
 * @param {number | null} [input.createSlot] The window's opening slot, or `null`/absent to leave the
 *   two halves unread rather than guess them from the earliest fill.
 * @returns {WindowParticipation}
 */
export function measureWindowParticipation(input) {
  const deployer = input.deployer ?? null;
  const createSlot = input.createSlot ?? null;
  /** @type {Set<string>} */
  const operation = new Set(input.operationWallets ?? []);
  if (deployer !== null) operation.add(deployer);

  /** @type {Set<string>} */
  const outsiders = new Set();
  /** @type {Set<string>} */
  const outsidersInCreateSlot = new Set();
  /** @type {Set<string>} */
  const outsidersAfterCreateSlot = new Set();
  /** @type {Set<string>} */
  const operationSeen = new Set();

  let fillCount = 0;
  let outsiderFills = 0;
  let outsiderBuySol = 0;
  let outsiderSellSol = 0;
  let operationFills = 0;
  let operationBuySol = 0;
  let operationSellSol = 0;
  let createSlotOutsiderFills = 0;
  let afterCreateSlotOutsiderFills = 0;
  let preCreateSlotFills = 0;
  /** @type {number | null} */
  let firstFillSlot = null;
  /** @type {number | null} */
  let lastFillSlot = null;

  for (const f of input.fills) {
    fillCount += 1;
    if (firstFillSlot === null || f.slot < firstFillSlot) firstFillSlot = f.slot;
    if (lastFillSlot === null || f.slot > lastFillSlot) lastFillSlot = f.slot;
    if (createSlot !== null && f.slot < createSlot) preCreateSlotFills += 1;

    if (operation.has(f.wallet)) {
      operationSeen.add(f.wallet);
      operationFills += 1;
      if (f.side === 'buy') operationBuySol += f.sol;
      else operationSellSol += f.sol;
      continue;
    }

    outsiders.add(f.wallet);
    outsiderFills += 1;
    if (f.side === 'buy') outsiderBuySol += f.sol;
    else outsiderSellSol += f.sol;
    // The halves are computed only where a create slot was established, and a fill EARLIER than it
    // goes in neither: it is already counted by `preCreateSlotFills`, and filing it under "after"
    // would let a caller whose bounds disagree with its own create slot read the window half high.
    if (createSlot === null) continue;
    if (f.slot === createSlot) {
      outsidersInCreateSlot.add(f.wallet);
      createSlotOutsiderFills += 1;
    } else if (f.slot > createSlot) {
      outsidersAfterCreateSlot.add(f.wallet);
      afterCreateSlotOutsiderFills += 1;
    }
  }

  let windowOnlyOutsiderWallets = 0;
  for (const w of outsidersAfterCreateSlot) if (!outsidersInCreateSlot.has(w)) windowOnlyOutsiderWallets += 1;

  return {
    deployer,
    createSlot,
    fills: fillCount,
    outsiderWallets: outsiders.size,
    outsiderFills,
    outsiderBuySol,
    outsiderSellSol,
    operationWallets: operationSeen.size,
    operationFills,
    operationBuySol,
    operationSellSol,
    createSlotOutsiderWallets: createSlot === null ? null : outsidersInCreateSlot.size,
    createSlotOutsiderFills: createSlot === null ? null : createSlotOutsiderFills,
    afterCreateSlotOutsiderWallets: createSlot === null ? null : outsidersAfterCreateSlot.size,
    afterCreateSlotOutsiderFills: createSlot === null ? null : afterCreateSlotOutsiderFills,
    windowOnlyOutsiderWallets: createSlot === null ? null : windowOnlyOutsiderWallets,
    preCreateSlotFills,
    firstFillSlot,
    lastFillSlot,
  };
}

/**
 * Whether a window's participation reading rests on evidence, at a bar the CALLER states.
 *
 * The shape is {@link roomIsProven}'s — a floor on the evidence, expressed as a count — and the
 * claim is not; {@link WINDOW_PARTICIPATION_IS_A_DIFFERENT_CLAIM} is the statement of the
 * difference and is why this is not named `windowRoomIsProven`.
 *
 * **`minOutsiderWallets` is REQUIRED and there is deliberately no default.** {@link roomIsProven}'s
 * `>= 1` is not a threshold at all — one mark is the minimum evidence that a structural rule saw
 * anything — but a count of distinct outsider wallets IS a threshold, and picking it decides which
 * launches a venue supplies. This repo's standing rule is that a measurement pass measures and does
 * not tune, so this function refuses rather than defaulting: a default would be a pinned bar wearing
 * a convenience's clothes, and it would be pinned by whoever wrote this line rather than by the
 * captain. {@link WINDOW_OUTSIDER_BAR_MEASURED_AT} carries the three counts the supply evidence
 * exists at and the argument for the 5–50 range; the number itself is the captain's.
 *
 * The second reason it stays a parameter was a pending measurement, and that contingency has
 * RESOLVED — in the narrow-slice direction: fewer than 1,000 wallets of ~11,000 hold 99%+ of all
 * gains on that band (`slot-zero-dbc-netfees-profitability` → `report.md`, held in firstmate's
 * records, not in this repo). Captain decision 413a then CLOSED the venue line, so NO bar is pinned
 * either way and this function's conclusion is unchanged: it still takes the bar from the caller and
 * still refuses without one. The instrument stays able to take either answer without being
 * rewritten, and stays DORMANT — unwired, not orphaned or retired. See `CLAUDE.md` → "Meteora DBC:
 * the venue line is CLOSED".
 *
 * @param {Pick<WindowParticipation, 'outsiderWallets'>} m
 * @param {{ minOutsiderWallets?: number | null }} [options] Optional in the TYPE so the refusal
 *   below is reachable from a caller and a test; required in FACT.
 * @returns {boolean}
 * @throws {Error} When no usable bar was supplied. Never a silent `>= 1`.
 */
export function windowParticipationIsProven(m, options) {
  const bar = options?.minOutsiderWallets;
  if (typeof bar !== 'number' || !Number.isInteger(bar) || bar < 1) {
    throw new Error(
      'windowParticipationIsProven requires an explicit integer minOutsiderWallets >= 1; there is ' +
        'no default, because a default is a pinned bar. See measure.mjs -> ' +
        `WINDOW_OUTSIDER_BAR_MEASURED_AT (${WINDOW_OUTSIDER_BAR_MEASURED_AT.join(', ')}) for the ` +
        'counts the supply evidence exists at. Pinning one is a captain decision.',
    );
  }
  return m.outsiderWallets >= bar;
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
 * The bar, in SOL, and it is exact in that unit.
 *
 * **RAISE-85** — *net quote inflow into a token's own primary market, over its first
 * {@link RAISE_85_WINDOW_HOURS} hours, reaching this many SOL-equivalent* — is what
 * {@link TokenRecord.completed} means since captain decision 352b. The constant was READ OFF THE
 * DATA rather than fitted: over the 157,259 pump.fun launches created 2026-07-01→05, graduating
 * non-mayhem tokens read **85.005 SOL at p50 AND at p99, to three decimals**, so the distribution
 * has no shoulder to place a bar on — 85 is the edge of a step.
 *
 * **DO NOT LOWER IT TO BUY RECALL.** The property that makes this measure usable is that it has
 * **zero token-level false positives** against 108,310 non-graduating tokens, which is what makes
 * a rate computed from it a LOWER BOUND on the real one, which is in turn why adopting it can only
 * ever refuse a deployer and never promote one. At 50 SOL that property is already gone — 42
 * promotions — and a measure that can promote is no longer a lower bound, so the safety argument
 * for adopting it at all evaporates with it. (Captain decision 352b, and
 * `slot-zero-offlaunchpad-graduation-criterion` → `report.md` §§2.2, 3 and 8.2, held in firstmate's
 * records, not in this repo — see `CLAUDE.md` → "Citing a report this repo does not hold".)
 */
export const RAISE_85_SOL_BAR = 85;

/** The window the inflow is accumulated over, from the token's own mint. */
export const RAISE_85_WINDOW_HOURS = 24;

/**
 * The one sentence that says what the completion measure IS, and it is printed once per run.
 *
 * Captain decision 352b adopts RAISE-85 as **the** completion measure on every venue **including
 * pump.fun**, replacing pump.fun's own graduation flag as the definition. One yardstick for every
 * deployer: the two halves of that decision cannot be separated, because adopting a venue-agnostic
 * criterion off-launchpad while pump.fun kept its native reading would leave pump.fun deployers a
 * ~46% graduation credit no off-launchpad deployer could earn.
 *
 * `render.mjs` prints this verbatim beside the gate's inputs, the same way
 * `dune.mjs` → `MAYHEM_NOT_COMPETENCE` is printed, because a rate sitting next to a bar has to say
 * which quantity it is.
 */
export const RAISE_85_IS_THE_COMPLETION_MEASURE =
  'CAPTAIN DECISION 352b: the completion measure is RAISE-85 — net quote inflow into a token\'s ' +
  `own primary market, over its first ${RAISE_85_WINDOW_HOURS} hours, reaching ` +
  `${RAISE_85_SOL_BAR} SOL-equivalent — on EVERY venue, pump.fun included, replacing pump.fun's ` +
  'own graduation flag as the definition. One yardstick for every deployer. It has zero ' +
  'token-level false positives, so a rate computed from it is a LOWER BOUND and adopting it can ' +
  'only ever refuse a deployer, never promote one; the bar is not to be lowered to buy recall, ' +
  'because at 50 SOL that property is already gone. THE MAYHEM EXCLUSION RUNS FIRST AND IS ' +
  'UNCHANGED (captain decision 351): a mayhem launch leaves BOTH sides of the rate before this ' +
  'criterion is applied to anything, because RAISE-85 never registers a mayhem graduation and ' +
  'leaving those launches in the denominator would drive a mayhem-heavy deployer to 0.0000 — ' +
  'which is captain decision 227c, and 227c REMAINS DECLINED. A launch this criterion cannot be ' +
  'READ on leaves both sides too and is counted apart, because a criterion no surface could ' +
  'apply is not a failed launch.';

/**
 * What this measure does NOT establish, and it travels with every reading rather than living in a
 * document.
 *
 * The same 85-SOL bar is reached by **0.80%** of new pump.fun tokens, **0.25%** on Meteora DBC and
 * **46.71%** on Meteora CPAMM. Those three numbers are not a ranking of the venues' deployers; they
 * are three different populations of token meeting one absolute capital bar, and nothing here
 * separates "this venue attracts more capital per token" from "this venue's tokens are counted
 * differently". So **equivalent strictness across venues is NOT established** and no document,
 * record or rendered line this repo writes may claim cross-venue comparability.
 * `slot-zero-cross-venue-strictness-measure` owns that question (held in firstmate's records, not
 * in this repo).
 *
 * What IS established is narrower and is the whole of what 352b rests on: one bar, applied
 * identically everywhere, with zero token-level false positives on the venue it was measured on.
 */
export const CROSS_VENUE_STRICTNESS_UNESTABLISHED =
  'EQUIVALENT STRICTNESS ACROSS VENUES IS NOT ESTABLISHED: the same 85-SOL bar is reached by ' +
  '0.80% of new pump.fun tokens, 0.25% on Meteora DBC and 46.71% on Meteora CPAMM, and nothing ' +
  'measured here separates a venue that attracts more capital per token from a venue whose tokens ' +
  'are counted differently. One bar applied identically everywhere is what 352b adopts; ' +
  'cross-venue COMPARABILITY is not claimed by it and must not be claimed from it. ' +
  '(slot-zero-cross-venue-strictness-measure owns the question; it is held in firstmate\'s ' +
  'records, not in this repo.)';

/**
 * What pump.fun's own graduation flag is worth as a stand-in for RAISE-85, in both directions.
 *
 * Measured over the 157,259 pump.fun launches created 2026-07-01→05: RAISE-85 predicts classic
 * curve graduation at **precision 1.0000** (zero false positives against 108,310 non-graduating
 * tokens) and **recall 0.9918**. Read that as a set relation and it is exact:
 *
 * - **Every token that reached 85 SOL graduated.** So `graduated === false` is a PROOF that
 *   RAISE-85 was not reached — the estimator's negative is exact, not an estimate.
 * - **0.82% of graduations did not reach 85 SOL.** So `graduated === true` is an UPPER BOUND on
 *   RAISE-85 — the estimator's positive can be wrong, and only in the direction that reads a rate
 *   HIGH.
 *
 * A rate resting on it is therefore an upper bound on the RAISE-85 rate, which errs towards
 * ACCEPTANCE — the direction this gate is deliberately set to fail in, because a false rejection
 * here is permanent and invisible (the wallet is graded, filed in `feed/ledger.json` and never
 * offered again) while a false acceptance costs Stage 2 keyless requests and is then refused by
 * `stage2_entry.minRoomLeft`. {@link CompletionMeasurement.criterionEstimated} is how a reader sees
 * how much of a rate rests on it.
 *
 * **THE ONE PLACE IT IS NOT AN UPPER BOUND IS A MAYHEM LAUNCH, AND THAT IS WHY THE ORDER OF
 * OPERATIONS IS LOAD-BEARING.** A mayhem graduation is preceded by a median **0.291 SOL**, so
 * `graduated === true` there is not 0.82% wrong, it is 292x wrong. Captain decision 351 removes a
 * known-mayhem launch from both sides *before* {@link measureCompletion} applies any criterion, so
 * the estimator is only ever asked about launches the measurement above was taken on. Where the
 * mayhem flag itself is UNREADABLE the estimator can still be asked about a mayhem launch and read
 * it high — that is a stated residual, it runs towards acceptance, and
 * {@link CompletionMeasurement.mayhemUnreadable} is what makes it visible.
 */
export const PUMPFUN_GRADUATION_ESTIMATOR =
  'READ THROUGH pump.fun\'s own graduation flag, which is an ESTIMATOR of RAISE-85 and not the ' +
  'measure itself: every token that reached 85 SOL graduated (precision 1.0000 against 108,310 ' +
  'non-graduating tokens), so a NOT-graduated launch is proof the bar was not reached, while ' +
  '0.82% of graduations did not reach it (recall 0.9918), so a graduated launch is an UPPER BOUND. ' +
  'A rate resting on this estimator is therefore an upper bound on the RAISE-85 rate and errs ' +
  'towards ACCEPTANCE, which is the direction this gate is deliberately set to fail in. It is ' +
  'asked only about launches the mayhem exclusion has already kept, because on a mayhem launch it ' +
  'is not 0.82% wrong but 292x wrong.';

/**
 * How a launch's RAISE-85 reading was arrived at, and in which unit the bar was applied.
 *
 * Recorded per launch rather than inferred per run, because a single history legitimately mixes
 * them: a SOL-quoted launch is judged in SOL against an exact constant, a USDC-quoted one has to be
 * judged in USD against a constant that MOVES, and a launch nothing could read is judged not at all.
 *
 * - `'raise-85-quote-sol'` — the token's primary market is quoted in SOL and the inflow was
 *   compared against {@link RAISE_85_SOL_BAR} directly. **Exact**, and the only reading that is.
 * - `'raise-85-usd-equivalent'` — the quote asset is not SOL, so the bar was converted through a
 *   SOL price. **Inexact by construction**: 85 SOL was worth between **$6,236 and $7,004 across
 *   five days**, so two launches a week apart are judged at bars 12% apart and neither reading is
 *   wrong. It is a fallback and never a preference.
 * - `'pumpfun-graduation-estimator'` — no trade reading was available and pump.fun's own graduation
 *   flag stood in. See {@link PUMPFUN_GRADUATION_ESTIMATOR} for what that is worth in each
 *   direction.
 *
 * @typedef {'raise-85-quote-sol' | 'raise-85-usd-equivalent' | 'pumpfun-graduation-estimator'} CompletionCriterion
 */

/**
 * @typedef {object} Raise85Reading
 * @property {boolean | null} reached `null` when nothing could read this launch — never `false`.
 * @property {CompletionCriterion | null} criterion Which reading answered, `null` when none did.
 */

/**
 * Apply RAISE-85 to one launch's measured net quote inflow.
 *
 * **`quoteIsSol` is REQUIRED and an unknown quote asset is UNREADABLE, which is the whole guard.**
 * A pump.fun launch can be quoted in something other than SOL — `maxxing` `97nnzgv9…`, the second
 * launch of that name, is USDC-quoted, and all 384 of its fills return `sol_raw = 0` **legitimately**
 * (`CLAUDE.md` → the Dune entry-statement bullet, trap 3; captain decision 295b filed the guard
 * against a cutover, which is this one). A reader that took a bare SOL figure would score every
 * such launch as a 0-SOL raise and call it a failure with total confidence. So a zero is only ever
 * believed where the quote asset is KNOWN to be SOL, and where the quote asset is unknown this
 * function refuses rather than guessing — `null`, which leaves the launch out of both sides of the
 * rate and is counted as {@link CompletionMeasurement.criterionUnreadable}.
 *
 * @param {object} input
 * @param {boolean | null | undefined} input.quoteIsSol Whether the token's own primary market is
 *   quoted in SOL. `null`/absent means nobody established it, which is not `false`.
 * @param {number | null | undefined} [input.netQuoteInflowSol] Net quote inflow over the window, in
 *   SOL. Read ONLY when `quoteIsSol` is `true`.
 * @param {number | null | undefined} [input.netQuoteInflowUsd] The same inflow in USD, for a market
 *   quoted in anything else.
 * @param {number | null | undefined} [input.usdPerSol] The SOL price the bar is converted through.
 *   Required for the USD leg, and its own inexactness is the reason the denomination is recorded.
 * @returns {Raise85Reading}
 */
export function raise85FromQuoteInflow(input) {
  const finite = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
  if (input.quoteIsSol === true) {
    return finite(input.netQuoteInflowSol)
      ? { reached: /** @type {number} */ (input.netQuoteInflowSol) >= RAISE_85_SOL_BAR, criterion: 'raise-85-quote-sol' }
      : { reached: null, criterion: null };
  }
  // The USD leg is reachable ONLY on a market positively established as not-SOL-quoted. An unknown
  // quote asset falls through to `null` below with the SOL figure deliberately unread: a USD reading
  // built on a spurious zero is the same defect one currency over.
  if (input.quoteIsSol === false && finite(input.netQuoteInflowUsd) && finite(input.usdPerSol)) {
    const usdPerSol = /** @type {number} */ (input.usdPerSol);
    if (usdPerSol > 0) {
      return {
        reached: /** @type {number} */ (input.netQuoteInflowUsd) >= RAISE_85_SOL_BAR * usdPerSol,
        criterion: 'raise-85-usd-equivalent',
      };
    }
  }
  return { reached: null, criterion: null };
}

/**
 * Read RAISE-85 through pump.fun's own graduation flag, which is what every route this repo has
 * can actually answer today.
 *
 * {@link PUMPFUN_GRADUATION_ESTIMATOR} owns what the estimator is worth in each direction and why
 * it is only ever asked about launches the mayhem exclusion has already kept. What this function
 * adds is the three-state fold: a flag that is not a boolean is a flag NOBODY READ, and it becomes
 * `null` rather than `false`. That is the difference between *this launch did not raise 85 SOL* and
 * *nothing here could say whether it did*, and defaulting the second to the first is the invisible
 * false rejection this whole tool exists to remove.
 *
 * @param {boolean | null | undefined} graduated pump.fun's own completion flag — the curve's
 *   `complete` byte, the `CompleteEvent` the same transition emits, or the ownership listing's
 *   mirror of it.
 * @returns {Raise85Reading}
 */
export function raise85FromPumpfunGraduation(graduated) {
  return typeof graduated === 'boolean'
    ? { reached: graduated, criterion: 'pumpfun-graduation-estimator' }
    : { reached: null, criterion: null };
}

/**
 * @typedef {object} CompletionMeasurement
 * @property {number} tokens        Denominator: token records seen, AFTER the mayhem exclusion and
 *   after the criterion-unreadable exclusion.
 * @property {number} completed     Numerator: records that met RAISE-85, over the same set.
 * @property {number} rate          `completed / tokens`, or `NaN` when `tokens === 0`.
 * @property {number} spanDays      First to last deploy, in days, over the same set.
 * @property {string | null} firstDeployIso
 * @property {string | null} lastDeployIso
 * @property {number} droppedNoTimestamp Records excluded for an unusable deploy time.
 * @property {number} mayhemExcluded Records removed from BOTH sides of the fraction because
 *   pump.fun's `is_mayhem_mode` read `true` on them — captain decision 351, and see
 *   {@link measureCompletion} for the argument. Counted rather than left implicit: `tokens`
 *   is smaller than the history the reading was taken over by exactly this many launches, and a
 *   reader who cannot see that cannot tell a short history from an excluded one.
 * @property {number} mayhemUnreadable Records COUNTED in the reading whose flag could not be read
 *   at all. **They are in `tokens` and in `completed`, and that is the stated decision, not an
 *   oversight** — {@link measureCompletion} owns why, and this count is what makes it auditable:
 *   `mayhemExcluded === 0 && mayhemUnreadable === tokens` is a reading no mayhem evidence
 *   touched. **Both conjuncts, and the first is the one that is easy to drop**: a candidate
 *   whose enumerated creates were all mayhem while the launches that survived came from the
 *   ownership listing reads `mayhemUnreadable === tokens` with launches genuinely excluded.
 * @property {number} criterionUnreadable Records removed from BOTH sides of the fraction because
 *   RAISE-85 could not be READ on them at all — captain decision 352b, and see
 *   {@link measureCompletion} for why they leave rather than being scored as failures. **Nameable
 *   apart from `mayhemExcluded` on purpose**: the two answer different questions (*this launch is
 *   not competence evidence* against *nothing here could measure this launch*) and merging them
 *   into one "unknown" would make a post-352b rate unauditable in exactly the way a pre-351 one was.
 * @property {number} criterionEstimated Of the `tokens` that remain, how many had RAISE-85 read
 *   through pump.fun's own graduation flag rather than measured from trade data —
 *   {@link PUMPFUN_GRADUATION_ESTIMATOR}. **`criterionEstimated === tokens` means the whole rate is
 *   an UPPER BOUND on the RAISE-85 rate**, which is the state every route this repo has today
 *   produces, and a reader who cannot see that would take an estimate for the measure.
 */

/**
 * @typedef {object} TokenRecord
 * @property {number} deployedAtMs
 * @property {boolean | null} completed Whether this launch met **RAISE-85** — net quote inflow into
 *   its own primary market reaching {@link RAISE_85_SOL_BAR} SOL-equivalent over its first
 *   {@link RAISE_85_WINDOW_HOURS} hours. Captain decision 352b: that is the completion measure on
 *   every venue, pump.fun included, and pump.fun's own graduation flag is no longer the definition —
 *   it is an ESTIMATOR of this, with a measured error in each direction
 *   ({@link raise85FromPumpfunGraduation}).
 *
 *   **`null` is UNREADABLE and is never the same claim as `false`.** A launch nothing could apply
 *   the criterion to leaves BOTH sides of the rate and is counted as
 *   {@link CompletionMeasurement.criterionUnreadable}; scoring it as a failure would be defaulting
 *   a coverage gap into a rejection, which is permanent and invisible here. Producers must therefore
 *   go through {@link raise85FromQuoteInflow} or {@link raise85FromPumpfunGraduation} rather than
 *   writing a boolean, because both of those refuse where a bare `=== true` would fabricate.
 * @property {CompletionCriterion | null} [criterion] Which reading answered {@link TokenRecord.completed}
 *   and in which unit the bar was applied. Absent or `null` alongside a non-null `completed` is a
 *   producer that has not been brought through 352b's readers; the measurement counts it as
 *   estimated rather than as measured, which is the direction that cannot overstate what was read.
 * @property {boolean | null} [mayhem] pump.fun's `is_mayhem_mode` for this launch. `true` excludes
 *   it from the competence measure entirely; `false` is a launch PROVEN ordinary; **`null` or
 *   absent is UNREADABLE — the surface this record came from does not carry the column — and is
 *   never the same claim as `false`.** Optional because most producers of this type cannot see the
 *   flag at all (the MadeOnSol profile page, the ownership listing, the committed tape), and an
 *   absent field there is the honest reading rather than a defaulted one.
 */

/**
 * Read a token record's mayhem flag as one of three states, never two.
 *
 * The whole hazard captain decision 351 has to avoid lives in this coercion. `undefined` (a
 * producer with no such column) and `null` (a producer whose column would not parse) are the SAME
 * state — *nobody could read this launch's flag* — and neither is `false`, which is the positive
 * claim that a launch was an ordinary curve launch. Writing `r.mayhem === true` at each call site
 * would work today and would quietly acquire a fourth reading the first time someone wrote
 * `!r.mayhem`, so the fold happens once, here.
 *
 * @param {TokenRecord} record
 * @returns {boolean | null} `null` when the flag was not readable on this launch.
 */
export function mayhemFlagOf(record) {
  return typeof record.mayhem === 'boolean' ? record.mayhem : null;
}

/**
 * Read a token record's RAISE-85 result as one of three states, never two.
 *
 * The sibling of {@link mayhemFlagOf}, and it exists for the identical reason one column over:
 * `undefined` (a producer written before captain decision 352b) and `null` (a producer that looked
 * and could not tell) are the SAME state — *nobody could apply the criterion to this launch* — and
 * neither of them is `false`, which is the positive claim that a token's own primary market took in
 * less than {@link RAISE_85_SOL_BAR} SOL-equivalent in its first day.
 *
 * Writing `r.completed === true` at each call site would work today and would quietly acquire a
 * fourth reading the first time someone wrote `!r.completed` — which is precisely how a coverage gap
 * becomes a rejection — so the fold happens once, here.
 *
 * @param {TokenRecord} record
 * @returns {boolean | null} `null` when RAISE-85 was not readable on this launch.
 */
export function completionFlagOf(record) {
  return typeof record.completed === 'boolean' ? record.completed : null;
}

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
 * ## A mayhem launch is not competence evidence — captain decision 351
 *
 * pump.fun graduates tokens two different ways and the capital between them differs by **292x**: a
 * classic curve graduation is preceded by a median net quote inflow of **85.005 SOL** into the
 * token's own primary market, a mayhem-mode graduation by **0.291 SOL** — a figure not separable in
 * trade data from a token that churned about $1,700 and died. In 2026-07 mayhem was **27.15% of
 * pump.fun launches and 46.41% of its graduations**. So this rate — the bar that IS the gate — was
 * measuring two very different achievements through one number, and nearly half of what it counted
 * was the cheap one. (`slot-zero-offlaunchpad-graduation-criterion` → `report.md` §4 and §8.2, and
 * its `decision-351-mayhem-not-competence.md`, both held in firstmate's records, not in this repo —
 * see `CLAUDE.md` → "Citing a report this repo does not hold".)
 *
 * **A known-mayhem launch leaves BOTH sides of the fraction, and the denominator half is not
 * optional.** Dropping mayhem graduations from the numerator alone would drive a mayhem-heavy
 * deployer's rate towards 0.0000 and remove them from the gate — which is captain decision **227c**,
 * *excluding mayhem-heavy deployers outright*, and 227c is **NOT** reversed and remains **declined**.
 * 351 is about competence and not about removing anyone: a mayhem launch is no more evidence of
 * failure than of success, so a deployer is judged **on their non-mayhem record**.
 *
 * ## The unreadable flag: an explicit decision, and it points the same way as every other bar here
 *
 * A launch whose flag could not be read is **kept in the reading** and counted in
 * {@link CompletionMeasurement.mayhemUnreadable}. It is neither relabelled non-mayhem nor dropped,
 * and both halves of that matter:
 *
 * - **It is not silently non-mayhem.** The count is on the measurement, on the candidate row and on
 *   the rendered line, so a reader can see exactly how much of a rate rests on launches no mayhem
 *   evidence touched. `mayhemExcluded === 0 && mayhemUnreadable === tokens` is the pre-351
 *   reading, stated as such — the unreadable count ALONE does not establish it, because a
 *   reading can have had launches excluded and still have nothing readable left in it.
 * - **It does not silently vanish.** Dropping it was the other candidate and it fails on the
 *   repo's own asymmetry. The flag's readability is a property of the ENUMERATION ROUTE, not of the
 *   launch: `is_mayhem_mode` is a column on Dune's `pump_evt_createevent` and nowhere else, so the
 *   creation walk reads it on nothing, `pump_call_create` rows carry it on nothing, and the
 *   ownership listing carries it on nothing. Dropping unreadable launches would therefore empty the
 *   denominator of **every walk-sourced candidate and every pre-`pump_evt_createevent` era**, on
 *   evidence about the surface rather than about the deployer. A false REJECTION here is permanent
 *   and invisible — the wallet is graded, filed in `feed/ledger.json` and never offered again — while
 *   a false acceptance is visible and cheap, refused downstream by `stage2_entry.minRoomLeft`
 *   (`thresholds.json` → `justification.minCompletionRate`, which owns that asymmetry). Keeping the
 *   launch errs towards acceptance; dropping it errs towards the permanent direction.
 *
 * The consequence worth stating plainly: **this function is byte-identical to its pre-351 self on
 * every producer that cannot see the flag**, which is every caller except the Dune-enumerated
 * creation-derived history. It is not inert there by accident — it is inert because those readings
 * hold no mayhem evidence to act on.
 *
 * **A reading left with NO non-mayhem launch is UNDEFINED, not 0.0000.** `tokens === 0` yields
 * `rate: NaN` exactly as an empty history always has, and `rank.mjs` → `verdictFor` routes that
 * case to `gate-unmeasured` rather than `gate-failed` whenever the exclusion is what emptied it.
 * Zero-of-zero is an absent measurement and not a failing rate, and conflating the two is 227c
 * arriving through the back door.
 *
 * ## The measure itself is RAISE-85 now — captain decision 352b
 *
 * `TokenRecord.completed` no longer means *pump.fun said this graduated*; it means *this token's own
 * primary market took in {@link RAISE_85_SOL_BAR} SOL-equivalent in its first
 * {@link RAISE_85_WINDOW_HOURS} hours*, on every venue including pump.fun.
 * {@link RAISE_85_IS_THE_COMPLETION_MEASURE} is the sentence; {@link RAISE_85_SOL_BAR} owns why the
 * bar does not move and {@link CROSS_VENUE_STRICTNESS_UNESTABLISHED} owns what it does not
 * establish. This function's arithmetic did not change for it — what changed is what the numerator
 * counts, and the third state below.
 *
 * ## THE SEAM: 351 AND 352b COMPOSE IN ONE ORDER AND ONLY ONE
 *
 * **The mayhem exclusion runs FIRST, over the whole history, before any launch is asked whether it
 * raised 85 SOL.** RAISE-85 as a *definition* only ever touches the numerator: it simply never
 * registers a mayhem graduation, which is preceded by a median 0.291 SOL against 85.005 for a
 * classic curve one. So if mayhem LAUNCHES were left in the denominator while the criterion decided
 * the numerator, a mayhem-heavy deployer's rate would run to 0.0000 and the gate would drop them —
 * **which is captain decision 227c, *excluding mayhem-heavy deployers outright*, and 227c is NOT
 * reversed and REMAINS DECLINED.** The two changes must not be allowed to compose into an outcome
 * the captain declined, and the order of the two filters below is the whole of what prevents it: a
 * mayhem launch is gone from both sides before the criterion is consulted, so a deployer is judged
 * on their non-mayhem record exactly as 351 requires.
 *
 * A consequence worth stating rather than leaving to be rediscovered: a mayhem launch is counted in
 * {@link CompletionMeasurement.mayhemExcluded} and NEVER in
 * {@link CompletionMeasurement.criterionUnreadable}, whatever its `completed` field says, because it
 * left the reading before the criterion could fail to read it.
 *
 * ## The unreadable criterion: the third state, and it leaves both sides
 *
 * A launch RAISE-85 cannot be READ on — no trade reading, and no graduation flag either — is
 * removed from BOTH sides and counted in {@link CompletionMeasurement.criterionUnreadable}. It is
 * **never scored as a failure**, and that is the same rule the mayhem exclusion runs on, for the
 * same reason in the same direction: a criterion no surface could apply is not a failed launch, and
 * defaulting a coverage gap into a rejection is permanent and invisible here — the wallet is
 * graded, filed in `feed/ledger.json` and never offered again.
 *
 * Note the deliberate asymmetry with the unreadable MAYHEM flag, which is *kept* in the reading.
 * The two are not the same case and treating them alike would be wrong both ways round. An
 * unreadable mayhem flag costs the measurement nothing, because the launch's own criterion is known
 * independently and the launch can still be judged; an unreadable criterion leaves nothing to judge
 * at all, so keeping it would mean counting it as a failure under another name.
 *
 * **A reading left with NO judgeable launch is UNDEFINED, not 0.0000.** `tokens === 0` yields
 * `rate: NaN` exactly as an empty history always has, and `rank.mjs` → `verdictFor` routes that
 * case to `gate-unmeasured` rather than `gate-failed` whenever an exclusion is what emptied it —
 * `competenceEmptiedByMayhem` and `competenceEmptiedByCriterion` are the two predicates. Zero of
 * zero is an absent measurement and not a failing rate, whichever exclusion produced it, and
 * conflating the two is 227c arriving through the back door.
 *
 * **AND A PARTLY-UNREADABLE READING IS UNMEASURED TOO** (`rank.mjs` →
 * `competenceCriterionIncomplete`). The criterion exclusion does not only shrink the rate's two
 * sides: `tokens`, `spanDays` and the two deploy instants below are all taken over `usable`, so
 * `minTokens` and `minSpanDays` are compared against a count the unreadable launches have already
 * left. Judging on that would reject a wallet over OUR coverage — the same defect one bar over —
 * so the verdict is withheld rather than the count repaired, because `tokens`, `rate` and
 * `spanDays` are three statements about ONE sample.
 *
 * @param {readonly TokenRecord[]} records
 * @returns {CompletionMeasurement}
 */
export function measureCompletion(records) {
  const timestamped = records.filter((r) => Number.isFinite(r.deployedAtMs) && r.deployedAtMs > 0);
  const dropped = records.length - timestamped.length;

  // Captain decision 351, and IT RUNS FIRST — see this function's doc, "THE SEAM". `=== true` and
  // not truthiness: `mayhemFlagOf` has already folded the two unreadable spellings to `null`, and
  // only a flag that positively READ true may remove a launch.
  const nonMayhem = timestamped.filter((r) => mayhemFlagOf(r) !== true);
  const mayhemExcluded = timestamped.length - nonMayhem.length;

  // Captain decision 352b, and it runs SECOND, over what 351 left. A launch nothing could apply
  // RAISE-85 to leaves both sides rather than being scored as a failure; `completionFlagOf` is the
  // same three-state fold one column over, so `null` and a missing field are one state and neither
  // is `false`.
  const usable = nonMayhem.filter((r) => completionFlagOf(r) !== null);
  const criterionUnreadable = nonMayhem.length - usable.length;

  // Over `usable`, NOT over `nonMayhem`, and the difference is load-bearing: this count's whole job
  // is the documented conjunct `mayhemExcluded === 0 && mayhemUnreadable === tokens`, i.e. "no
  // mayhem evidence touched this rate". `tokens` is the post-criterion set, so counting over the
  // pre-criterion one would break that test the moment a launch went criterion-unreadable, and it
  // would break it silently, in the direction that overstates how much of the rate was checked.
  const mayhemUnreadable = usable.filter((r) => mayhemFlagOf(r) === null).length;
  // A producer that has not been brought through 352b's readers supplies no `criterion` at all.
  // Counting that as ESTIMATED rather than as measured is the direction that cannot overstate what
  // was read: it can only make a rate look more provisional than it is, never less.
  const measuredCriteria = new Set(['raise-85-quote-sol', 'raise-85-usd-equivalent']);
  const criterionEstimated = usable.filter((r) => !measuredCriteria.has(r.criterion ?? '')).length;

  if (usable.length === 0) {
    return {
      tokens: 0,
      completed: 0,
      rate: Number.NaN,
      spanDays: 0,
      firstDeployIso: null,
      lastDeployIso: null,
      droppedNoTimestamp: dropped,
      mayhemExcluded,
      mayhemUnreadable,
      criterionUnreadable,
      criterionEstimated: 0,
    };
  }

  const times = usable.map((r) => r.deployedAtMs).sort((a, b) => a - b);
  const lo = times[0];
  const hi = times[times.length - 1];
  if (lo === undefined || hi === undefined) throw new Error('unreachable: non-empty array has no bounds');

  const completed = usable.filter((r) => completionFlagOf(r) === true).length;
  return {
    tokens: usable.length,
    completed,
    rate: completed / usable.length,
    spanDays: (hi - lo) / 86_400_000,
    firstDeployIso: new Date(lo).toISOString(),
    lastDeployIso: new Date(hi).toISOString(),
    droppedNoTimestamp: dropped,
    mayhemExcluded,
    mayhemUnreadable,
    criterionUnreadable,
    criterionEstimated,
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
    // Captain decision 352b. `complete` is pump.fun's own graduation flag mirrored by this vendor,
    // which is an ESTIMATOR of RAISE-85 and no longer the measure itself, so it goes through the
    // reader rather than being coerced here. `=== true` used to read a MISSING or malformed field
    // as a failed launch — a vendor schema change would have driven every rate on this leg to
    // 0.0000 with nothing saying so — and the reader makes that state UNREADABLE instead, which
    // leaves the launch out of both sides and counts it.
    const graduated = row['complete'];
    const reading = raise85FromPumpfunGraduation(typeof graduated === 'boolean' ? graduated : null);
    records.push({
      deployedAtMs: Number(row['created_timestamp']),
      completed: reading.reached,
      criterion: reading.criterion,
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
