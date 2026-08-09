/**
 * Stage 2's memory — WHICH SURVIVORS THIS SCREEN HAS ALREADY SPENT ITS SCORING CAP ON.
 *
 * Captain decision 336a. Before it, `screen.mjs` took `survivors.slice(0, maxScored)`: the first
 * seven gate survivors in `mergeSeeds` order, which is deterministic, so a daily run scored the
 * SAME seven wallets every day. That is not a cheap repeat, it is a wasted run — the median
 * survivor needs about 21.5 days for its ten windows to refresh and **0 of 27 refresh within a
 * day**, so a same-day re-measure re-answers a question already answered. Distinct yield was about
 * 168 windows a month against roughly 2,571 of available supply, and the captain's floor is 1,000
 * window measurements a month.
 *
 * So the cap now spends itself on the **least-recently-scored** survivors and cycles through the
 * population instead of repeating its head.
 *
 * ## What this module is NOT
 *
 * It is not a capacity change. `stage2_entry.maxCandidatesScored` does not move — captain decision
 * 339a keeps it at 7 per run, because raising it means moving the scoring cap and the request
 * budget together and that is a separate decision. This module changes WHICH seven, and nothing
 * else. It reads no vendor, opens no socket and costs zero in every currency.
 *
 * It is also not `ledger.mjs`, which is the discovery feed's memory: that one records which wallets
 * this project has ever SEEN, so a scheduled feed does not re-offer them as new. This one records
 * which wallets Stage 2 has ever SCORED, so a scheduled screen does not re-measure them. Two
 * different questions over two different populations — the feed's ledger holds every wallet the
 * vendor ever surfaced, this holds only gate survivors that reached the scoring loop — and one file
 * answering both would make either question's answer depend on the other's cadence. What IS reused
 * is {@link ledgerRunRecords}, and the SHAPE of `nextGateBatch`: oldest first, with a deterministic
 * tiebreak, because a rotation that drains freshest-first starves its own tail permanently while
 * reporting healthy yield every run.
 *
 * ## An UNMEASURED verdict still counts as scored, and that does not breach 174b
 *
 * A candidate that reached `entry-unmeasured` consumed the cap and the keyless walk that goes with
 * it, so it is recorded here exactly as a measured one is — otherwise the cap would re-spend itself
 * on the same unanswerable wallets forever, which is the defect this module removes wearing a
 * different hat. Captain decision 174b forbids a later stage FILTERING on an unmeasured verdict;
 * this drops nobody. The wallet keeps its place in the cycle and comes back round with the rest,
 * and the run record still surfaces and counts its unmeasured verdict.
 *
 * ## THE PROPERTY BEING TRADED, AND WHAT PAYS FOR IT
 *
 * Before 336a the screen was stateless: same inputs, same output, and anyone could re-run it and
 * reproduce a published result. Rotation makes a run's output depend on every run before it, and
 * the captain accepted that trade **on the condition that reproducibility is preserved another
 * way**. Three things buy it back, and they are acceptance criteria rather than niceties:
 *
 * 1. **The state is committed evidence.** It is a JSON file in this tree, written in sorted key
 *    order so two runs over the same state produce byte-identical bytes and a diff shows the lines
 *    that changed rather than a reshuffle.
 * 2. **The run record NAMES the state it read** — its path, its schema version and the SHA-256 of
 *    the bytes as read, plus the digest of the bytes the run then wrote. Run N's `after` is run
 *    N+1's `before`, so the chain of runs is checkable end to end from committed artefacts.
 * 3. **The selection is re-derivable from the record alone.** The record carries the whole ranked
 *    `order` the rotation produced, not just the slice it took, and {@link verifySelection} — the
 *    same ranking rule the live selection uses — recomputes the slice from it. A reader who never
 *    saw the state file can still check that the run scored the wallets its own rule says it should
 *    have.
 *
 * {@link REPRODUCIBILITY_RULE} is that condition in one sentence and it travels on the state file,
 * on the run record and on the rendered Stage 2 block, for the reason `LANDING_TIP_CAVEAT` does:
 * a caveat that lives only in a document is one a reader of the number never sees.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { readRunRecords as ledgerRunRecords } from './ledger.mjs';

export { ledgerRunRecords };

/**
 * Rotation state format version.
 *
 * Bumped, never retro-fitted, for the same reason `LEDGER_SCHEMA_VERSION` is: this file is the only
 * record of which survivors have already had the cap spent on them, and a reader that quietly
 * started over would put the rotation back at the head of the list — the exact behaviour 336a
 * removed, restored silently and with the record still claiming a rotation happened.
 */
export const ROTATION_SCHEMA_VERSION = 1;

/**
 * The condition captain decision 336a attached to giving up statelessness.
 *
 * One string, asserted onto three surfaces rather than described in a document: the state file, the
 * run record's own block and the rendered Stage 2 header. A rotation whose selection cannot be
 * checked from committed artefacts is not acceptable in this lab, and the place a reader meets that
 * claim has to be the place they meet the selection.
 */
export const REPRODUCIBILITY_RULE =
  'ROTATION STATE IS COMMITTED EVIDENCE: this run scored the least-recently-scored survivors, so ' +
  'its output depends on every run before it. The run record names the state it read (path, schema ' +
  'version, SHA-256 before and after) and carries the whole ranked order, so the selection is ' +
  're-derivable from committed artefacts alone — rotation.mjs -> verifySelection.';

/**
 * @typedef {object} RotationEntry
 * @property {string} wallet
 * @property {string} firstScoredAtIso The first run that spent the cap on this wallet.
 * @property {string} lastScoredAtIso  The most recent one. THE SORT KEY — see {@link rotationOrder}.
 * @property {number} timesScored How many runs have spent the cap on it. Operator context and
 *   nothing reads it for the selection; a wallet that has come round three times is not owed more
 *   or less than one that has come round once, which is what makes the cycle a cycle.
 * @property {'screen' | 'run-record'} origin Whether a live run recorded it or
 *   {@link importScoredFromRunRecords} recovered it from a committed record. A recovered entry is
 *   evidence about a run that happened, not about this state file having been kept.
 */

/**
 * @typedef {object} Rotation
 * @property {string} tool
 * @property {number} schemaVersion
 * @property {string} updatedAtIso
 * @property {string} reproducibility
 * @property {Record<string, RotationEntry>} wallets
 */

/**
 * A survivor's place in the rotation, as the record persists it.
 *
 * `lastScoredAtIso` is `null` for a survivor this screen has never scored — never an epoch
 * sentinel. The same rule `covered.fromMs` learnt the hard way one tool over: a `0` there read as a
 * 56-year window, and a `1970-01-01` here would read as "scored, a very long time ago" and sort
 * identically to one that genuinely was.
 *
 * @typedef {object} RotationRow
 * @property {string} wallet
 * @property {string | null} lastScoredAtIso
 * @property {number} timesScored
 */

/** @returns {Rotation} */
export function emptyRotation() {
  return {
    tool: 'deployer-screen-stage2-rotation',
    schemaVersion: ROTATION_SCHEMA_VERSION,
    updatedAtIso: new Date(0).toISOString(),
    reproducibility: REPRODUCIBILITY_RULE,
    wallets: {},
  };
}

/**
 * Read the rotation state, or start one, and hand back the digest of the bytes as read.
 *
 * A missing file is a first run: an empty rotation, `digest: null`, and every survivor never-scored,
 * which is the one configuration in which this module's selection is byte-identical to the
 * `slice(0, maxScored)` it replaced. That equivalence is deliberate — it makes the first run after
 * this change provably inert.
 *
 * A file we cannot parse, or one written by a schema we do not know, **throws**. Starting over is
 * not the safe default here: it silently returns the rotation to the head of the list, which is the
 * defect 336a exists to remove, and it breaks the digest chain that makes a published selection
 * checkable. Both failures are invisible in the output — the run would report a rotation and
 * perform a repeat.
 *
 * @param {string} path
 * @returns {{ rotation: Rotation, digest: string | null, present: boolean }}
 */
export function loadRotation(path) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { rotation: emptyRotation(), digest: null, present: false };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `The Stage 2 rotation state at ${path} is not readable JSON ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). Refusing to start over: an ` +
        `empty rotation puts the scoring cap back on the head of the survivor list, which is the ` +
        `repeat captain decision 336a removed, and it breaks the digest chain a published ` +
        `selection is checked against. Restore the file or point --rotation elsewhere.`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The Stage 2 rotation state at ${path} is not an object.`);
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const version = obj['schemaVersion'];
  if (version !== ROTATION_SCHEMA_VERSION) {
    throw new Error(
      `The Stage 2 rotation state at ${path} declares schemaVersion ${String(version)}; this build ` +
        `reads ${ROTATION_SCHEMA_VERSION}. Rotation state is never retro-fitted — migrate it ` +
        `deliberately rather than letting a run rebuild it from nothing.`,
    );
  }

  const rotation = emptyRotation();
  rotation.updatedAtIso =
    typeof obj['updatedAtIso'] === 'string' ? obj['updatedAtIso'] : new Date(0).toISOString();
  const wallets = obj['wallets'];
  if (typeof wallets === 'object' && wallets !== null && !Array.isArray(wallets)) {
    for (const [wallet, raw] of Object.entries(/** @type {Record<string, unknown>} */ (wallets))) {
      const entry = readEntry(wallet, raw);
      if (entry !== null) rotation.wallets[wallet] = entry;
    }
  }
  return { rotation, digest: digestOf(text), present: true };
}

/**
 * One spelling of an instant, or `null` for anything that is not one.
 *
 * The rotation's whole selection turns on `lastScoredAtIso`, and the values reaching it come from
 * two places this module does not own: a state file on disk and a committed run record's
 * `startedAtIso`. Every producer emits `toISOString()` today, so a lexical order and a chronological
 * one coincide — but they coincide only by that coincidence, and a single row spelled
 * `2026-08-04T10:49:14+00:00` or `2026-08-04T10:49:14Z` would sort against the millisecond form as
 * text and land in the wrong place in the cycle, starving or re-measuring that wallet with nothing
 * in the output saying so. Normalising at the boundary removes the class rather than the instance,
 * and it is byte-neutral on state a `toISOString()` producer wrote.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function canonicalInstant(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Read one persisted row, or refuse it.
 *
 * A row without a usable `lastScoredAtIso` is DROPPED rather than repaired, and that direction is
 * the safe one: the wallet reverts to never-scored and is scored sooner than it needs to be, which
 * costs a keyless walk. Guessing a timestamp for it would push it to a place in the cycle nothing
 * measured, and could starve it.
 *
 * A row that IS usable is normalised to {@link canonicalInstant}'s single spelling, so the state
 * this module persists carries one representation of an instant rather than whichever the producer
 * happened to emit — a second-resolution or offset-bearing timestamp is the same moment and has to
 * take the same place in the cycle.
 *
 * @param {string} wallet
 * @param {unknown} raw
 * @returns {RotationEntry | null}
 */
function readEntry(wallet, raw) {
  if (wallet.length === 0 || typeof raw !== 'object' || raw === null) return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const last = canonicalInstant(row['lastScoredAtIso']);
  if (last === null) return null;
  const first = canonicalInstant(row['firstScoredAtIso']);
  const times = row['timesScored'];
  return {
    wallet,
    firstScoredAtIso: first ?? last,
    lastScoredAtIso: last,
    timesScored: typeof times === 'number' && Number.isFinite(times) && times > 0 ? Math.floor(times) : 1,
    origin: row['origin'] === 'run-record' ? 'run-record' : 'screen',
  };
}

/**
 * Record that a run spent the scoring cap on a wallet.
 *
 * Called as each candidate finishes scoring rather than once for the whole batch, so a run that
 * dies half way through advances the rotation for the wallets it paid for and for no others. The
 * wallets it never reached cost nothing and come up again next time, which is the same argument
 * `screen.mjs` makes for writing an incomplete record instead of discarding it.
 *
 * @param {Rotation} rotation
 * @param {string} wallet
 * @param {string} scoredAtIso The RUN's instant, shared by every wallet it scores — so a state file
 *   diff shows one timestamp per run rather than one per wallet, and so the record's own
 *   `scoredAtIso` identifies exactly the rows this run wrote.
 */
export function markScored(rotation, wallet, scoredAtIso) {
  const existing = rotation.wallets[wallet];
  if (existing === undefined) {
    rotation.wallets[wallet] = {
      wallet,
      firstScoredAtIso: scoredAtIso,
      lastScoredAtIso: scoredAtIso,
      timesScored: 1,
      origin: 'screen',
    };
    return;
  }
  existing.lastScoredAtIso = scoredAtIso;
  existing.timesScored += 1;
  existing.origin = 'screen';
}

/**
 * Rank survivors least-recently-scored first.
 *
 * **The rule, and all three clauses matter.**
 *
 * 1. A survivor this screen has never scored comes before one it has. There is no measurement to
 *    refresh, so there is nothing to wait for.
 * 2. Among scored survivors, ascending `lastScoredAtIso` — least recently measured first. That is
 *    `nextGateBatch`'s shape one lane over and it is chosen for the same reason: draining
 *    freshest-first leaves the oldest permanently starved while every run reports a healthy count.
 * 3. Ties break on the survivor's position in the list the caller passed, which `mergeSeeds` makes
 *    deterministic. So two runs over the same state and the same population rank identically, and
 *    with no state at all the ranking IS the caller's order — which is what makes the first run
 *    after 336a byte-identical to the `slice(0, maxScored)` it replaced.
 *
 * **A survivor set that shrank costs nothing.** Wallets the rotation knows and this run's gate did
 * not return simply do not appear; their rows are kept, so a wallet that drops out for a day and
 * comes back resumes its place in the cycle rather than jumping to the front as a stranger. The
 * file therefore grows by at most `maxScored` rows a run, which at the pinned cap of 7 is the whole
 * bound on its size.
 *
 * @param {Rotation} rotation
 * @param {readonly string[]} wallets Gate survivors, in the order the screen would have sliced.
 * @returns {RotationRow[]}
 */
export function rotationOrder(rotation, wallets) {
  const rows = wallets.map((wallet, index) => {
    const entry = rotation.wallets[wallet];
    return {
      index,
      row: /** @type {RotationRow} */ ({
        wallet,
        lastScoredAtIso: entry?.lastScoredAtIso ?? null,
        timesScored: entry?.timesScored ?? 0,
      }),
    };
  });
  rows.sort((a, b) => {
    const c = compareRotationRows(a.row, b.row);
    return c !== 0 ? c : a.index - b.index;
  });
  return rows.map((r) => r.row);
}

/**
 * The ranking rule, as a comparator over what a run record persists.
 *
 * Split out so the live selection and {@link verifySelection} apply ONE rule rather than two
 * expressions that merely agree — captain decision 144a's defect, and the reason the eligibility
 * gate and the cursor bound are one derivation one module over. A verifier that re-implemented this
 * would drift, and the drift would surface as a published selection nobody could reproduce.
 *
 * Returns 0 for rows the rule does not separate; the caller supplies the positional tiebreak,
 * which a record cannot carry and a verifier therefore must not demand.
 *
 * @param {RotationRow} a
 * @param {RotationRow} b
 * @returns {number}
 */
export function compareRotationRows(a, b) {
  const an = a.lastScoredAtIso === null;
  const bn = b.lastScoredAtIso === null;
  if (an !== bn) return an ? -1 : 1;
  if (an || bn) return 0;
  const sx = /** @type {string} */ (a.lastScoredAtIso);
  const sy = /** @type {string} */ (b.lastScoredAtIso);
  const x = Date.parse(sx);
  const y = Date.parse(sy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return sx < sy ? -1 : sx > sy ? 1 : 0;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Choose the survivors this run's scoring cap is spent on.
 *
 * @param {Rotation} rotation
 * @param {readonly string[]} wallets
 * @param {number} max
 * @returns {{ order: RotationRow[], selected: string[], deferred: string[], neverScored: number }}
 */
export function selectForScoring(rotation, wallets, max) {
  const order = rotationOrder(rotation, wallets);
  const take = Math.max(0, Math.min(max, order.length));
  return {
    order,
    selected: order.slice(0, take).map((r) => r.wallet),
    deferred: order.slice(take).map((r) => r.wallet),
    neverScored: order.filter((r) => r.lastScoredAtIso === null).length,
  };
}

/**
 * Re-derive a run's selection from the block it persisted, and say what does not hold.
 *
 * **This is acceptance criterion 3 made checkable rather than asserted.** It takes only what a
 * committed run record carries — no state file, no survivor list, no clock — and answers whether
 * that run scored the wallets its own stated rule says it should have. Reported as problems rather
 * than a boolean so a reader is told WHICH clause failed; an empty list is the pass.
 *
 * @param {{ order: readonly RotationRow[], selected: readonly string[], deferred: readonly string[] }} block
 * @param {number} max The scoring cap the run APPLIED, which is its own recorded `scoringCap.max`
 *   and never `thresholds.stage2_entry.maxCandidatesScored`. The two differ whenever `--score` was
 *   passed — the applied cap is the `min()` of the two — and a reader who reaches for the pinned
 *   recipe instead would be told a correct `--score 3` run selected the wrong wallets.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifySelection(block, max) {
  /** @type {string[]} */
  const problems = [];
  const order = [...block.order];

  for (let i = 1; i < order.length; i += 1) {
    const prev = /** @type {RotationRow} */ (order[i - 1]);
    const here = /** @type {RotationRow} */ (order[i]);
    if (compareRotationRows(prev, here) > 0) {
      problems.push(
        `order is not least-recently-scored first at position ${i}: ${prev.wallet} ` +
          `(${prev.lastScoredAtIso ?? 'never scored'}) before ${here.wallet} ` +
          `(${here.lastScoredAtIso ?? 'never scored'})`,
      );
    }
  }

  const take = Math.max(0, Math.min(max, order.length));
  const expectedSelected = order.slice(0, take).map((r) => r.wallet);
  const expectedDeferred = order.slice(take).map((r) => r.wallet);
  if (!sameList(block.selected, expectedSelected)) {
    problems.push(
      `selected is not the first ${take} of order — recorded [${block.selected.join(', ')}], ` +
        `the rule gives [${expectedSelected.join(', ')}]`,
    );
  }
  if (!sameList(block.deferred, expectedDeferred)) {
    problems.push(
      `deferred is not the remainder of order — recorded [${block.deferred.join(', ')}], ` +
        `the rule gives [${expectedDeferred.join(', ')}]`,
    );
  }
  if (new Set(order.map((r) => r.wallet)).size !== order.length) {
    problems.push('order names the same wallet more than once');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Fold committed screen run records into the rotation.
 *
 * Offline and free, and run on **every** invocation rather than once at bootstrap — the same
 * discipline `ledger.mjs` → `importRunRecords` applies to the feed's memory, and for the same
 * reason: a lost or hand-deleted state file then degrades to a slower rotation instead of to a
 * wrong one. A candidate carrying an `entry` block is one Stage 2 spent its cap on, and the run's
 * own `startedAtIso` is when.
 *
 * **It only ADDS.** A wallet the state already knows is left exactly as it is, because a run record
 * and the state file are two accounts of the same event and merging them would double-count
 * `timesScored` on every invocation. Shape is read defensively rather than assumed: the committed
 * records span schema 1 (no `schemaVersion` field at all) to 19, and this has to keep working
 * across the next bump without a migration.
 *
 * @param {Rotation} rotation
 * @param {readonly { file: string, body: unknown }[]} records
 * @returns {{ imported: number }} Wallets this call ADDED.
 */
export function importScoredFromRunRecords(rotation, records) {
  let imported = 0;
  for (const { body } of records) {
    if (typeof body !== 'object' || body === null) continue;
    const rec = /** @type {Record<string, unknown>} */ (body);
    const startedAtIso = canonicalInstant(rec['startedAtIso']);
    if (startedAtIso === null) continue;
    const candidates = rec['candidates'];
    if (!Array.isArray(candidates)) continue;

    for (const raw of candidates) {
      if (typeof raw !== 'object' || raw === null) continue;
      const row = /** @type {Record<string, unknown>} */ (raw);
      const wallet = row['wallet'];
      // `entry: null` is a candidate Stage 2 produced no score for — it did not clear the gate,
      // `--no-stage2` was passed, or the cap dropped it. None of those spent the cap on it.
      if (typeof wallet !== 'string' || wallet.length === 0) continue;
      if (typeof row['entry'] !== 'object' || row['entry'] === null) continue;
      if (rotation.wallets[wallet] !== undefined) continue;
      rotation.wallets[wallet] = {
        wallet,
        firstScoredAtIso: startedAtIso,
        lastScoredAtIso: startedAtIso,
        timesScored: 1,
        origin: 'run-record',
      };
      imported += 1;
    }
  }
  return { imported };
}

/**
 * The exact bytes a rotation state is persisted as.
 *
 * Separate from writing them because the run record carries this file's digest, so the text has to
 * exist before the record is assembled and be the same text that lands on disk. Two serialisations
 * would put a digest in the record that names bytes nobody wrote.
 *
 * Wallet keys are sorted so two runs over the same state produce a byte-identical file — the state
 * is committed, and a diff that reorders every line hides the seven that changed.
 *
 * @param {Rotation} rotation
 * @param {string} nowIso
 * @returns {string}
 */
export function serialiseRotation(rotation, nowIso) {
  /** @type {Record<string, RotationEntry>} */
  const sorted = {};
  for (const wallet of Object.keys(rotation.wallets).sort()) {
    const entry = rotation.wallets[wallet];
    if (entry !== undefined) sorted[wallet] = entry;
  }
  return `${JSON.stringify(
    {
      tool: 'deployer-screen-stage2-rotation',
      schemaVersion: ROTATION_SCHEMA_VERSION,
      updatedAtIso: nowIso,
      reproducibility: REPRODUCIBILITY_RULE,
      wallets: sorted,
    },
    null,
    2,
  )}\n`;
}

/**
 * @param {string} path
 * @param {string} text The output of {@link serialiseRotation}, already digested into the record.
 */
export function saveRotationText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * The digest a run record names its state by.
 *
 * Prefixed with the algorithm because an unlabelled hex string in a record is a value nobody can
 * re-derive without guessing which function produced it.
 *
 * @param {string} text
 * @returns {string}
 */
export function digestOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
