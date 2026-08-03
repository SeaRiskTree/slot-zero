/**
 * Creation-derived launch history. Pure: parsers and a merge, no I/O and no clock.
 *
 * ## The defect this exists to fix
 *
 * Every launch-history surface pump.fun and its resellers publish answers *"which tokens does this
 * wallet OWN NOW"*. On pump.fun the owner collects the token's creator fees, so ownership is a live
 * economic position that can be sold, handed to a community takeover, or migrated into a fee-sharing
 * config — and **the ones worth handing on are the winners**. The question a competence gate means to
 * ask is *"which tokens did this wallet CREATE"*, and the two answers are not the same set.
 *
 * The bias has a direction and it is the bad one. A dev that creates 20, bonds 9 and then hands on 3
 * of the winners reads as 17 launches / 6 bonded — 35% instead of 45%. A gate at 40% rejects a good
 * dev, and **a false rejection is invisible**: the wallet is dropped, never researched, and nothing
 * downstream ever contradicts it.
 *
 * The premise is not inherited from a comment. It was observed on-chain 2026-08-02:
 * mint `32CdQdBU…pump` (`maxxing`, ATH $7.72M) was created by our subject deployer
 * `7ufmve7Z…` in transaction
 * `64pCziaL1tpcXKNtamcrryukkZjpY37tJoWEcLj8Emao4Gp7GQraReGVSJYJXYK4x1EEeAp1oQzBq433JZTviSEU`
 * (slot 383821204, pump.fun `CreateV2`), and its creator record has since moved twice — to a
 * community-takeover wallet, and then, in transaction
 * `5fjZDdFQFpn69AhXnXg3WdKFFqeLUFeBbwxnQxz4paaYcbG1AoxggMFZPbM8ZKf4eBS2VYWBuvDtPHnxc9H1yryr`
 * (slot 398086225, `CreateFeeSharingConfig` + `MigrateBondingCurveCreator`), to a fee-sharing config
 * account that is not a wallet at all. `?creator=7ufmve7Z…` cannot return that mint, and it is the
 * single best launch in the deployer's 239-launch record.
 *
 * ## Why the on-chain route, and what it costs
 *
 * There is no keyless surface indexed by *original* creator. Probed 2026-08-02:
 * `frontend-api-v3/coins?creator=` is by current creator; `frontend-api-v3/coins/{mint}.creator` and
 * `.cto_address` are current; `advanced-api-v2/coins/metadata/{mint}.dev` is current too — it reads
 * the takeover wallet for `maxxing`, not the deployer. `coins/user-created-coins/{w}`,
 * `coins/created-by/{w}` and `swap-api/v2/creators/{w}/coins` are 404, and `coins/list` silently
 * ignores `dev=` / `devAddress=` filters rather than applying them.
 *
 * So creation is only recoverable from the create transaction itself, and the only keyless index
 * that reaches it is the wallet's own signature index. That walk is expensive and its ceilings are
 * declared in `thresholds.json` → `creation_walk`; {@link mergeHistories} makes what the walk did
 * *not* cover an explicit, recorded fallback rather than a silent one.
 */

/** pump.fun's bonding-curve program. */
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * Layout of the `BondingCurve` account, validated 2026-08-02 rather than assumed.
 *
 * `report.md` records offset 49 for the creator; the account is 151 bytes and the fields after it
 * are not documented here because nothing reads them. The offset was checked against a control token
 * whose creator has never moved (`EijM3FJm…pump`, curve `Xeka4UrE…`), where it reads the deployer
 * exactly — CLAUDE.md's instruction to validate the offset on a known token before trusting it.
 *
 * `complete` sits one byte earlier and survives graduation: it still reads 1 on a token that has
 * long since migrated to PumpSwap and had its reserves zeroed.
 */
export const CURVE_COMPLETE_OFFSET = 48;
/** @see CURVE_COMPLETE_OFFSET */
export const CURVE_CREATOR_OFFSET = 49;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Base58-encode 32 bytes, so an account field can be compared with a wallet address.
 *
 * Hand-rolled because this repo has no runtime dependencies and is not about to grow one to read a
 * public key. Leading zero bytes become leading `1`s, which is the part a naive big-integer
 * implementation drops.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    const r = Number(n % 58n);
    s = BASE58[r] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s === '' ? '1' : s;
}

/**
 * @typedef {object} CreateRecord
 * A launch, as the create transaction itself reports it.
 * @property {string} mint
 * @property {string} bondingCurve  Read out of the create instruction, so no PDA derivation is
 *   needed and no seed convention can drift.
 * @property {string} creator       The wallet that created the token, forever.
 * @property {number} createdAtMs
 * @property {string} signature
 */

/**
 * Recognise a pump.fun token creation and pull the launch out of it.
 *
 * Two identification rules, both structural:
 *
 * 1. **The log line, not the instruction data.** `Instruction: Create` / `CreateV2` is emitted by
 *    the program itself, so it survives the discriminator changing between program versions.
 * 2. **The creator is the create instruction's non-mint signer, not the fee payer.** These come
 *    apart: `report.md` §9.3 records that in a bundled transaction `accountKeys[0]` is one cohort
 *    wallet paying for three wallets' instructions, so fee-payer attribution merges distinct actors.
 *    A pump.fun create needs the mint keypair's signature (it initialises the mint) and the
 *    creator's (it pays the curve's rent), so "the signer that is not the mint" names the creator
 *    even when somebody else pays. If that leaves anything other than exactly one candidate the
 *    transaction is refused rather than guessed at.
 *
 * @param {unknown} tx A `getTransaction` result in `jsonParsed` encoding.
 * @returns {CreateRecord | null} `null` when this is not a pump.fun creation.
 */
export function parseCreateTransaction(tx) {
  if (typeof tx !== 'object' || tx === null) return null;
  const root = /** @type {Record<string, unknown>} */ (tx);

  const meta = /** @type {Record<string, unknown> | undefined} */ (root['meta']);
  if (meta === undefined || meta === null) return null;
  if (meta['err'] !== null && meta['err'] !== undefined) return null;

  const logs = meta['logMessages'];
  if (!Array.isArray(logs)) return null;
  if (!logs.some((l) => typeof l === 'string' && /^Program log: Instruction: Create(V\d+)?$/.test(l))) {
    return null;
  }

  const transaction = /** @type {Record<string, unknown> | undefined} */ (root['transaction']);
  if (transaction === undefined || transaction === null) return null;
  const message = /** @type {Record<string, unknown> | undefined} */ (transaction['message']);
  if (message === undefined || message === null) return null;

  const accountKeys = message['accountKeys'];
  if (!Array.isArray(accountKeys)) return null;
  /** @type {Set<string>} */
  const signers = new Set();
  for (const entry of accountKeys) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = /** @type {Record<string, unknown>} */ (entry);
    if (row['signer'] === true && typeof row['pubkey'] === 'string') signers.add(row['pubkey']);
  }

  const instructions = message['instructions'];
  if (!Array.isArray(instructions)) return null;

  for (const entry of instructions) {
    if (typeof entry !== 'object' || entry === null) continue;
    const ix = /** @type {Record<string, unknown>} */ (entry);
    if (ix['programId'] !== PUMP_PROGRAM_ID) continue;
    const accounts = ix['accounts'];
    if (!Array.isArray(accounts) || accounts.length < 3) continue;

    const mint = accounts[0];
    const bondingCurve = accounts[2];
    if (typeof mint !== 'string' || typeof bondingCurve !== 'string') continue;
    // The mint keypair signs its own initialisation. An instruction whose first account is not a
    // signer is a buy or a sell that happens to share the transaction, not the create.
    if (!signers.has(mint)) continue;

    const creators = accounts.filter((a) => typeof a === 'string' && a !== mint && signers.has(a));
    if (creators.length !== 1) return null;
    const creator = creators[0];
    if (typeof creator !== 'string') return null;

    const blockTime = root['blockTime'];
    if (typeof blockTime !== 'number' || !Number.isFinite(blockTime)) return null;

    const signatures = transaction['signatures'];
    const signature = Array.isArray(signatures) && typeof signatures[0] === 'string' ? signatures[0] : '';

    return { mint, bondingCurve, creator, createdAtMs: blockTime * 1000, signature };
  }

  return null;
}

/**
 * @typedef {object} CurveState
 * @property {boolean} complete Whether the curve bonded. Survives migration to PumpSwap.
 * @property {string | null} creator The curve's creator **now**, which is the field that moves —
 *   and `null` when the enumeration route that produced this state does not measure it. The Dune
 *   enumeration (`dune.mjs`) is the case that exists: it says who created a mint and whether it
 *   completed, and says nothing about who owns the curve today. **The nullability is the point.**
 *   Folding "not measured" into "did not move" would make {@link MergedHistory.movedCreator} report
 *   a confident 0 for a quantity nothing looked at, which is the silent-wrong-answer shape this
 *   whole lane exists to refuse.
 */

/**
 * Read the two bytes of a bonding-curve account that matter here.
 *
 * Both come out of the same account, so the batch that establishes whether a launch bonded also
 * establishes whether its creator record has moved since — the movement measurement is free.
 *
 * @param {string} base64Data Account data, base64.
 * @returns {CurveState | null} `null` when the account is absent or too short to trust.
 */
export function readCurveState(base64Data) {
  if (typeof base64Data !== 'string' || base64Data === '') return null;
  const raw = Buffer.from(base64Data, 'base64');
  if (raw.length < CURVE_CREATOR_OFFSET + 32) return null;
  const complete = raw[CURVE_COMPLETE_OFFSET];
  if (complete === undefined) return null;
  return {
    complete: complete === 1,
    creator: base58Encode(raw.subarray(CURVE_CREATOR_OFFSET, CURVE_CREATOR_OFFSET + 32)),
  };
}

/**
 * @typedef {object} CoveredWindow
 * @property {number | null} fromMs Oldest block time the signature scan actually reached, or
 *   **`null` when it reached none** — a walk stopped part-way through its first signature page
 *   covered nothing, and that is the normal outcome under a per-candidate request ceiling. The
 *   nullability is the point: `0` was the old encoding of this state and it reads as 1970, i.e. as
 *   a 56-year window that contains every timestamp, which made the merge below delete real
 *   launches. Anything comparing against this must handle `null` — {@link mergeHistories} treats an
 *   absent floor as an EMPTY window, never an infinite one.
 * @property {number} toMs   Newest block time the signature scan started from, and `0` when it
 *   never reached one — a walk that resolved no page has no ceiling either. It is a `number` only
 *   because the walk seeds it that way; put it through {@link coveredBoundMs} like the floor rather
 *   than formatting it, or an empty window reports 1970 at both ends.
 * @property {boolean} exhausted True when the walk reached the end of the wallet's index, so
 *   `fromMs` is the wallet's genesis rather than a ceiling.
 */

/**
 * The one test for "this bound is a real block time" — a covered window's edge, or `null` when the
 * walk never reached one. `null` is what the current walk stores; `0` is what an older producer, an
 * already-saved run record and a missing `blockTime` all still carry, and it means the same thing,
 * because no Solana block time is at or before the epoch.
 *
 * Every consumer of {@link CoveredWindow} has to apply the SAME test or they disagree about the
 * same walk: {@link mergeHistories} treating a `0` floor as an empty window while the run record
 * writes `1970-01-01T00:00:00.000Z` and a 20,600-day span is a record that contradicts the reading
 * it was produced from. Hence one exported function rather than a repeated comparison.
 *
 * @param {number | null | undefined} ms
 * @returns {number | null} `ms` when it is a real block time, `null` when it covers nothing.
 */
export function coveredBoundMs(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * @typedef {object} MergedHistory
 * @property {import('./measure.mjs').TokenRecord[]} records The history the gate reads.
 * @property {number} createdInWindow    Launches the create transactions prove, inside the window.
 *   `records` may hold more than this: a walk that abandoned a page part-way can prove a launch
 *   below `covered.fromMs`, and that is still a launch even though it is outside the range the two
 *   readings may be compared over.
 * @property {number} listedInWindow     Launches the ownership surface shows, inside the window.
 * @property {number} hiddenByOwnership  Created inside the window and ABSENT from the ownership
 *   surface. This is the under-count, measured rather than assumed.
 * @property {number} notCreatedByWallet Listed inside the window but created by somebody else —
 *   the opposite error, an over-count from tokens the wallet acquired rather than launched.
 * @property {number} listedOutsideWindow Launches carried over from the ownership surface because
 *   the walk never reached them. **These are still a lower bound** and are counted as one.
 * @property {number} listedInWindowCarried Launches carried over from the ownership surface from
 *   INSIDE the window, which only happens when the walk left transactions unresolved and is
 *   therefore not authoritative there. Zero whenever {@link MergedHistory.windowExact} is true.
 * @property {boolean} windowExact True when the walk resolved every transaction it inspected, so
 *   the set of creates inside `covered` is exact and a listed token it never saw was acquired
 *   rather than missed. False means the walk may have missed a real create, and the listing's
 *   in-window rows are carried rather than reclassified.
 * @property {number} movedCreator       Launches inside the window whose on-chain creator is no
 *   longer the wallet that created them. **Counted only where the route MEASURED it** — see
 *   {@link MergedHistory.creatorMovementUnmeasured}.
 * @property {number} creatorMovementUnmeasured Launches whose curve state came from a route that
 *   does not report a current creator (the Dune enumeration). `movedCreator` says nothing about
 *   these, and a reader must not add the two: the first is a measured count, the second is the size
 *   of what was not looked at.
 * @property {number} bondedFromCurve    Launches whose bonded status was decided by **the chain's
 *   own statement** — the bonding-curve `complete` byte read directly by the signature walk, or the
 *   `CompleteEvent` that same transition emits, which is what the Dune enumeration reads. One
 *   counter rather than two because they are one fact from one source; the record's
 *   `enumerationSource` says which route read it.
 * @property {number} bondedFromListing  Launches whose bonded status was decided by the ownership
 *   listing's own `complete` flag, because the curve account could not be read. A weaker source but
 *   a well-founded one: it is the same field a vendor mirror of agreed with our own tape 67/67.
 * @property {number} bondedUndecidable  Launches NEITHER source can answer for. Counted as
 *   not-bonded so the rate can only be understated, but the reading is then UNMEASURED and no
 *   verdict may be read off it. Not hypothetical: a launch hidden from the ownership listing — the
 *   very thing this route exists to find — has no listing row by definition.
 *
 * `bondedFromCurve + bondedFromListing + bondedUndecidable === records.length`, always.
 */

/**
 * Merge a bounded creation walk with the ownership listing into the history the gate reads.
 *
 * The merge is windowed on purpose, and the window is the walk's actual coverage:
 *
 * - **Inside** `covered`, the signature scan saw every transaction the wallet took part in, so the
 *   set of creates is exact. Ownership is not consulted there at all: it can only be wrong, in
 *   either direction.
 * - **Outside** it, there is nothing but the ownership listing, so its rows are carried over
 *   unchanged and {@link MergedHistory.listedOutsideWindow} says how many. That part of the history
 *   is still a lower bound and the record has to keep saying so.
 * - **An EMPTY window** — `covered.fromMs === null`, a walk that stopped before finishing one
 *   signature page — is the degenerate case of "outside", not a special case: every listed row is
 *   outside it, so the reading falls all the way back to the ownership listing. Biased towards
 *   rejection, by a measured ~0 launches (`CREATION-DERIVED.md`), and honest. The creates the walk
 *   *did* prove are still in `records`; what an empty window withdraws is only the right to call a
 *   listed token the walk never saw "acquired".
 *
 * Merging rather than replacing is what keeps this honest under a truncated walk: a walk that
 * covered two days would otherwise turn a 200-launch history into a 4-launch one and fail the
 * deployer on sample size — which is the same invisible false rejection, just from the other end.
 *
 * ## Two claims the merge refuses to make
 *
 * - **"Inside the window the walk is authoritative" holds only when the walk resolved everything it
 *   inspected.** `readCreatedHistory` retries an unresolved `getTransaction` once and then gives up
 *   on it, so `unresolvedTransactions > 0` means a create may simply never have come back. Under
 *   that, an in-window listed token the walk did not see is carried over as a launch rather than
 *   relabelled "acquired" and dropped — dropping it would delete a real launch, and its bonded
 *   flag, from both sides of the gate's fraction.
 * - **A launch whose curve went unread is not automatically a launch that failed.** Bonded status
 *   is resolved curve → listing flag → undecidable, and which source answered is counted, so a
 *   completion rate computed over undecidable launches can be recognised as unmeasured rather than
 *   read as a rejection.
 *
 * @param {object} input
 * @param {readonly CreateRecord[]} input.creates Creations found by the walk, any creator.
 * @param {string} input.wallet
 * @param {ReadonlyMap<string, CurveState>} input.curves Curve state by mint, where known.
 * @param {readonly { mint: string, deployedAtMs: number, completed: boolean }[]} input.listed
 *   The ownership listing, with mints so the two sets can be reconciled by identity.
 * @param {CoveredWindow} input.covered
 * @param {number} [input.unresolvedTransactions] Transactions the walk asked for and never got.
 *   Defaults to 0, which is the claim that the window is exact — pass the walk's own count.
 * @returns {MergedHistory}
 */
export function mergeHistories(input) {
  const { creates, wallet, curves, listed, covered } = input;
  const unresolvedTransactions = input.unresolvedTransactions ?? 0;
  const windowExact = unresolvedTransactions === 0;

  // A walk that never finished a page covered NOTHING, and the window has to be empty rather than
  // unbounded. `null` is how the walk says so; `<= 0` is the same claim from an older or
  // hand-built caller, and it is safe to fold in because no Solana block time is at or before the
  // epoch. Getting this wrong is not cosmetic: under an epoch floor every listed row counts as
  // in-window, `windowExact` then relabels every launch the walk did not personally see as
  // "acquired", and a 30-launch deployer is rejected on a 2-launch history with an ordinary-looking
  // rationale. That is the invisible false rejection this whole lane exists to remove, arriving
  // from the other end.
  const fromMs = coveredBoundMs(covered.fromMs);
  /** @param {number} ms */
  const inWindow = (ms) => fromMs !== null && Number.isFinite(ms) && ms >= fromMs && ms <= covered.toMs;

  // The listing is deduplicated by mint FIRST. `overlap` below counts listing rows against a set of
  // distinct created mints, so a mint the endpoint served twice — the same row reached from two
  // offsets while the deployer launched again mid-walk — would make `overlap` exceed
  // `createdInWindow` and drive `hiddenByOwnership` negative. This measurement sizes a bias, so it
  // is the one measurement that cannot carry one. Rows with no mint cannot collide and are kept.
  /** @type {{ mint: string, deployedAtMs: number, completed: boolean }[]} */
  const listedRows = [];
  /** @type {Set<string>} */
  const seenListedMints = new Set();
  for (const row of listed) {
    if (row.mint !== '') {
      if (seenListedMints.has(row.mint)) continue;
      seenListedMints.add(row.mint);
    }
    listedRows.push(row);
  }
  /** The listing's own `complete` flag, the fallback source for a launch whose curve went unread. */
  /** @type {Map<string, boolean>} */
  const listedCompletion = new Map();
  for (const row of listedRows) if (row.mint !== '') listedCompletion.set(row.mint, row.completed);

  /** @type {Map<string, import('./measure.mjs').TokenRecord>} */
  const byMint = new Map();
  /** Mints this wallet created **inside** the window — the only set comparable to the listing. */
  const createdInWindowMints = new Set();
  let movedCreator = 0;
  let creatorMovementUnmeasured = 0;
  let bondedFromCurve = 0;
  let bondedFromListing = 0;
  let bondedUndecidable = 0;

  for (const c of creates) {
    if (c.creator !== wallet) continue;
    if (byMint.has(c.mint)) continue;
    const curve = curves.get(c.mint);
    let completed = false;
    if (curve !== undefined) {
      completed = curve.complete;
      bondedFromCurve += 1;
    } else if (listedCompletion.has(c.mint)) {
      completed = listedCompletion.get(c.mint) === true;
      bondedFromListing += 1;
    } else {
      bondedUndecidable += 1;
    }
    byMint.set(c.mint, { deployedAtMs: c.createdAtMs, completed });
    // `null` is "nobody looked", not "it did not move". See CurveState.creator.
    if (curve !== undefined && curve.creator === null) creatorMovementUnmeasured += 1;
    else if (curve !== undefined && curve.creator !== wallet) movedCreator += 1;
    // Every create found is a proven launch and belongs in `records` — but only those inside the
    // covered window may be COMPARED against the listing. The walk abandons a page part-way when a
    // bound bites, so the last few creates can sit below `covered.fromMs`; counting one of those as
    // hidden while its listing row counts as outside-window would invent a gap that is not there.
    if (inWindow(c.createdAtMs)) createdInWindowMints.add(c.mint);
  }

  let listedInWindow = 0;
  let overlap = 0;
  let listedOutsideWindow = 0;
  let listedInWindowCarried = 0;
  let notCreatedByWallet = 0;
  for (const row of listedRows) {
    if (inWindow(row.deployedAtMs)) {
      listedInWindow += 1;
      if (createdInWindowMints.has(row.mint)) {
        overlap += 1;
        continue;
      }
      if (windowExact) {
        // The walk saw every transaction inside the window, so a listed token it never saw was not
        // created by this wallet — it was acquired. Unless the walk holds its create transaction:
        // a create proven below `covered.fromMs` by an abandoned page is a launch this wallet
        // demonstrably made, and its listing row's `created_timestamp` can still land inside the
        // window because the two sides are timestamped by different sources. Calling that one
        // "acquired by somebody else" would contradict evidence already in hand.
        if (!byMint.has(row.mint)) notCreatedByWallet += 1;
        continue;
      }
      if (!byMint.has(row.mint)) {
        byMint.set(row.mint, { deployedAtMs: row.deployedAtMs, completed: row.completed });
        bondedFromListing += 1;
        listedInWindowCarried += 1;
      }
      continue;
    }
    listedOutsideWindow += 1;
    if (!byMint.has(row.mint)) {
      byMint.set(row.mint, { deployedAtMs: row.deployedAtMs, completed: row.completed });
      bondedFromListing += 1;
    }
  }

  // Both gaps are the two set differences, counted directly. Deriving one by subtracting the other
  // from a total looks equivalent and is not: the two sides are timestamped by different sources
  // (a create's `blockTime`, a listing row's `created_timestamp`), so a launch landing on the
  // window boundary can be in-window on one side and out on the other, and the subtraction would
  // then report a NEGATIVE under-count. This measurement exists to size a bias; it cannot have one.
  // The same clock mismatch is why `notCreatedByWallet` above is gated on the create set rather
  // than on the window alone — both counts have to survive a launch the two sources date apart.
  const createdInWindow = createdInWindowMints.size;
  return {
    records: [...byMint.values()],
    createdInWindow,
    listedInWindow,
    hiddenByOwnership: createdInWindow - overlap,
    notCreatedByWallet,
    listedOutsideWindow,
    listedInWindowCarried,
    windowExact,
    movedCreator,
    creatorMovementUnmeasured,
    bondedFromCurve,
    bondedFromListing,
    bondedUndecidable,
  };
}
