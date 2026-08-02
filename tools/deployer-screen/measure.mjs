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
 * @property {number} bundledTx         Create-slot transactions carrying 2+ distinct wallets.
 * @property {number} maxWalletsInOneTx Largest wallet count in a single create-slot transaction.
 * @property {number} operationShare    (devSol + coordinatedSol) / (devSol + totalOtherSol).
 * @property {number} roomLeft          `1 - operationShare`.
 */

/**
 * Measure how much of a launch's opening window the deployer and its own wallets take.
 *
 * This is the method of `slot-zero-june-regime-change/report.md` §5.1 — *the operation's
 * share of the curve's bottom* — and the reason it can be pointed at a stranger is the
 * co-ordination rule:
 *
 * > A single transaction carrying two or more distinct swapping wallets is a bundle, and every
 * > wallet in it is co-ordinated.
 *
 * Independent traders cannot share a transaction. So this identifies a deployer's own book
 * structurally, from nothing but the fills, with no wallet list and no prior knowledge. On our
 * subject deployer it recovers the known six-wallet cohort and reproduces the report's
 * published operation share — see SCREEN.md, Stage 0.
 *
 * Two deliberate conservatisms, both of which push the measurement *towards* "there is room
 * here" and therefore make a `worth-the-time` verdict harder to earn, not easier:
 *
 * - A co-ordinated wallet that buys **alone** in the create slot, never sharing a transaction,
 *   is counted as independent. Its stake inflates `independentSol`.
 * - Only the create slot is examined. A book that accumulates in the next few slots is missed.
 *
 * @param {readonly Fill[]} fills All fills for one launch, any order.
 * @returns {CreateSlotMeasurement | null} `null` when there is no bonding-curve buy to anchor
 *   the create slot on, which is the honest answer for a launch we cannot see the start of.
 */
export function measureCreateSlot(fills) {
  const groups = createSlotGroups(fills);
  if (groups === null) return null;
  const { slot, deployer, coordinated, inSlot, bundledTx, maxWalletsInOneTx } = groups;

  let devSol = 0;
  let coordinatedSol = 0;
  let independentSol = 0;
  /** @type {Set<string>} */
  const independentWallets = new Set();
  for (const f of inSlot) {
    if (f.wallet === deployer) devSol += f.sol;
    else if (coordinated.has(f.wallet)) coordinatedSol += f.sol;
    else {
      independentSol += f.sol;
      independentWallets.add(f.wallet);
    }
  }

  const totalOtherSol = coordinatedSol + independentSol;
  const denominator = devSol + totalOtherSol;
  // A create slot with no capital in it at all carries no information about room. Treat it as
  // fully occupied rather than dividing by zero and calling it wide open.
  const operationShare = denominator > 0 ? (devSol + coordinatedSol) / denominator : 1;

  return {
    slot,
    deployer,
    devSol,
    coordinatedSol,
    independentSol,
    totalOtherSol,
    coordinatedWallets: coordinated.size,
    independentWallets: independentWallets.size,
    bundledTx,
    maxWalletsInOneTx,
    operationShare,
    roomLeft: 1 - operationShare,
  };
}

/**
 * @typedef {object} CreateSlotGroups
 * @property {number} slot                 The create slot.
 * @property {string} deployer             Wallet credited with the launch (first curve buyer).
 * @property {Set<string>} coordinated     Non-deployer wallets the bundle rule marks as the
 *   operation's own. Never contains `deployer`.
 * @property {Fill[]} inSlot               Create-slot bonding-curve buys, **ordered by `sid`** —
 *   pump.fun's own within-slot ordering key, so the sequence is the fill queue as the venue saw
 *   it, not the order the tape happened to arrive in.
 * @property {number} bundledTx            Create-slot transactions carrying 2+ distinct wallets.
 * @property {number} maxWalletsInOneTx    Largest wallet count in a single create-slot transaction.
 */

/**
 * Partition a launch's create slot into deployer / co-ordinated / everyone else.
 *
 * Extracted so {@link measureCreateSlot} and `entry.mjs`'s field measurement share **one**
 * definition of who the operation is. If they each derived it, a change to the co-ordination rule
 * could move the room figure without moving the population it is a statement about — and the two
 * numbers are read side by side.
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

  // Group by transaction. A transaction with 2+ distinct wallets marks all of them.
  /** @type {Map<string, Set<string>>} */
  const walletsByTx = new Map();
  for (const f of inSlot) {
    let set = walletsByTx.get(f.tx);
    if (set === undefined) {
      set = new Set();
      walletsByTx.set(f.tx, set);
    }
    set.add(f.wallet);
  }

  /** @type {Set<string>} */
  const coordinated = new Set();
  let bundledTx = 0;
  let maxWalletsInOneTx = 0;
  for (const set of walletsByTx.values()) {
    if (set.size > maxWalletsInOneTx) maxWalletsInOneTx = set.size;
    if (set.size >= 2) {
      bundledTx += 1;
      for (const w of set) coordinated.add(w);
    }
  }
  coordinated.delete(deployer);

  return { slot, deployer, coordinated, inSlot, bundledTx, maxWalletsInOneTx };
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
