/**
 * Creation enumeration over Dune — **the primary answer to "which mints did this wallet create"**
 * since captain decision 156a (`data/decisions/156-slot-zero-dune-vs-helius-creation-walk.md`).
 *
 * ## What this replaces, and what it deliberately does not
 *
 * `creation.mjs` states the defect: every pump.fun and reseller surface answers *"which tokens does
 * this wallet OWN NOW"*, ownership is a sellable position, and the ones worth handing on are the
 * winners — so the ownership reading scores the better dev worse and a false rejection is invisible.
 * The route out of that was a Solana signature walk, keyless or (from 2026-08-03) indexed through
 * Helius. Dune answers the same question from the decoded creation event, in ONE query for a whole
 * candidate batch, for a fraction of a free monthly allowance.
 *
 * **The walk is not deleted; it is the fallback.** It runs when there is no Dune key, when Dune
 * fails, or when the coverage probe below refuses a wallet's reading. And **Helius stays primary and
 * necessary for every transaction-level measurement** — Stage 2's entry-cost leg reads `meta.fee`
 * and pre/post balances per transaction, which no decoded table serves. Nothing in this module may
 * reach a Stage 2 entry number or Stage 3: room to enter is not room to leave, and an enumeration
 * source is neither.
 *
 * ## The two traps, both of which return a confident wrong answer
 *
 * 1. **Table choice.** Dune decodes `Create` and `CreateV2` into SEPARATE tables, with a third for
 *    the `CreateEvent` both emit. `pump_call_create` alone returns **zero rows** for our subject,
 *    which launches with CreateV2. `pump_call_create_v2` alone is not backfilled before roughly
 *    2026-04-28 and silently misses **101 of our 239 launches, `maxxing` included**. Only
 *    `pump_evt_createevent` UNION `pump_call_create` spans both boundaries — on a straddling
 *    third-party wallet it recovers 53 launches where either table alone recovers 31 or 35.
 *    {@link CREATION_SQL} is that union and nothing else may be substituted for it.
 * 2. **Attribution.** `creator` is a settable `CreateV2` ARGUMENT, not proof of authorship: six
 *    mints declare our subject as `creator` while being signed by six different bot-shaped wallets,
 *    inflating the count 247 → 253. Authorship keys on `"user"` / `account_user`, the signer.
 *
 * ## The binding condition: no count without its own coverage probe
 *
 * Decoded tables have **silent start dates**. They return a confident, well-formed, complete-looking
 * answer that is simply wrong before their first row, and nothing in the response says so. It is the
 * same failure shape as a truncated backwards walk in `pumpfun.mjs` — `meta.reached_mint` exists for
 * exactly this — and it fails in the same direction: plausible and silent.
 *
 * So every Dune-derived count here ships with {@link CoverageProbe}: `min(block_time)`,
 * `max(block_time)` and monthly row counts for the exact tables the enumeration reads.
 * {@link assessCoverage} refuses a reading that reaches outside it, and a refused reading falls back
 * to the walk rather than being published. The probe also reads `pump_call_create_v2`, which the
 * enumeration does NOT use, so the tool demonstrates the boundary that disqualifies it rather than
 * asserting it in prose.
 *
 * ## The same rule applied past coverage: a reading that cannot vouch for itself falls back
 *
 * Coverage is one way a Dune answer stops being able to account for itself, and it is not the only
 * one. Four more, each of which produces a complete-LOOKING answer that is short, and each of which
 * therefore refuses rather than publishes:
 *
 * - **A row the parser could not read**, INCLUDING one whose `bonded` is not a boolean.
 *   `unreadableRows > 0` refuses the WHOLE batch, not the wallet the row belonged to — a row that
 *   fails to parse commonly has no readable `deployer`, so the wallet whose history went short is
 *   exactly the wallet that cannot be named, and a shifted column shifts for every row at once.
 * - **A wallet the enumeration returned NO row for.** That is an absence of evidence, not evidence
 *   of absence, and gating a wallet on a zero-launch history built from it is the invisible false
 *   rejection this whole lane exists to remove. See {@link toWalletEnumeration}.
 * - **A wallet whose address is not base58-shaped.** Every wallet here is vendor-supplied and lands
 *   inside a single-quoted SQL literal, so {@link isEnumerableWallet} is checked before the batch is
 *   sent and anything failing it is dropped from the parameter and counted.
 * - **A result read that cannot prove it is whole** — no declared total, a total over the ceiling,
 *   rows sitting exactly on the `?limit=`, or rows disagreeing with the declared total, which is
 *   Dune paging on response size rather than on ours. See {@link DuneResultSet}'s reader.
 * - **A wallet whose rows the per-deployer cap TRUNCATED.** {@link CREATION_SQL} returns at most
 *   {@link launchCapPerWallet} rows per deployer and carries each deployer's TRUE count beside them,
 *   so a truncated history is detected exactly — rows returned below `launches_total` — and refused.
 *   The cap is deliberate truncation rather than a vendor failure, and the two must not be confused:
 *   see {@link toWalletEnumeration} for why a capped wallet is never a short-but-complete history.
 *
 * Every one of them leaves `usable: false` with a whole-sentence reason, and the candidate takes the
 * walk. Falling back costs wall clock; publishing a count the evidence does not support costs a
 * verdict, and that is the expensive side of the trade.
 *
 * ## The refusal's GRANULARITY is the wallet, not the batch, wherever the wallet can be named
 *
 * One execution answers for a whole batch, so a batch-wide refusal is expensive in a way a
 * per-wallet one is not: every OTHER candidate loses a ~1-credit Dune answer and takes a walk
 * measured in hours. The result-row ceiling used to be exactly that — one industrial-spam deployer
 * (`README.md` records an 8,518-deploy wallet reachable from the `total_bonded` leaderboard, which
 * is one of the three seeds) carried the whole batch past `maxResultRows` and sent EVERY candidate
 * to the walk. {@link CREATION_SQL}'s per-deployer cap moves that refusal onto the one wallet that
 * earned it. The batch-level ceiling in {@link DuneResultSet}'s reader is NOT deleted: it stays as
 * the backstop, and under {@link LAUNCH_CAP_FLOOR} it is genuinely reachable rather than
 * unreachable-by-a-bug — roughly 80 wallets of 500+ launches in one batch put a result past it, and
 * the run then falls back exactly as it did before the cap existed. Two bounds hold and they are
 * different bounds: BYTES at `?limit=maxResultRows` (<=40,000 rows at <=121 bytes/row, ~4.84 MB),
 * and ROWS from the SQL at `max(`{@link SQL_ROW_CEILING}`, <deployers> × 500)` with the ceiling
 * refusing anything above `maxResultRows` rather than publishing it.
 *
 * **THE BACKSTOP HAS FIRED ON A REAL RUN, WHICH IS WHY IT IS 40,000 AND NOT 20,000** (captain
 * decision 264a, 2026-08-05). A 76-deployer batch returned 27,731 rows against the old 20,000 and
 * was refused WHOLE; all 76 candidates walked instead, at 232,937 Helius credits against 1,924 for
 * a 69-deployer leg that kept its Dune answer, and the mayhem flag went UNMEASURED on every one of
 * them. `thresholds.json` → `dune.justification.maxResultRows` owns that record and the raise.
 *
 * ## Spend
 *
 * **A FAILED EXECUTION IS STILL BILLED AND IT IS TERMINAL** — `client.mjs` → {@link
 * import('./client.mjs').DuneClient} never retries one, and nothing here may add a retry around it.
 * Budget from *billed* credits, not `execution_cost_credits`, which understates by about 3.5×
 * because retrieving results is ~71% of the bill at ~20 credits/MB. Hence: aggregate server-side,
 * select only the columns the tool reads, and fetch each execution's results exactly once. The
 * coverage probe is parameterless, so it defaults to a CACHED read that costs no execution at all.
 *
 * **`derive and discard`, as for MadeOnSol.** Per-launch rows live in memory for one run; only
 * derived counts are ever written, and only with `--out`. Nothing here caches a result between runs.
 */

import {
  DuneExecutionAbandoned,
  DuneRefused,
  abandonExecution,
  cancelExecutionQuietly,
  decideAllowance,
  estimatePlanCredits,
  executionDeadlineCredits,
  parseUsageResponse,
} from './client.mjs';

/**
 * The row ceiling {@link CREATION_SQL} divides between the batch's deployers, written as a literal
 * inside that SQL because a saved query cannot read `thresholds.json`.
 *
 * It must stay STRICTLY UNDER `dune.maxResultRows`, so a result honouring the derived half of the
 * cap can never sit ON its own `?limit=` either. That relation is guarded —
 * `test/deployer-screen.test.ts` → "the SQL's per-deployer cap is derived from the pinned row
 * ceiling" fails if this number reaches the pinned threshold, because the saved query would then be
 * able to bound a run at a size the reader no longer accepts.
 *
 * **IT USED TO BE PINNED AT EXACTLY `maxResultRows - 1` AND IS NOW ONLY BOUNDED BY IT** — captain
 * decision 264a, 2026-08-05, which raised the reader's ceiling 20,000 → 40,000 and deliberately left
 * this literal at 19,999. The equality was a DERIVATION; the safety property is the inequality, and
 * `19,999 < 40,000` satisfies it more strongly than `19,999 < 20,000` did. Two reasons for freezing
 * it. **It binds nothing**: the share-out is only consulted below 40 deployers, and the largest
 * per-wallet history this repo has measured is 247 against an industrial-spam extreme of 8,518, both
 * far under 19,999 — so a one-wallet batch keeping a 19,999-row cap rather than a 39,999-row one is
 * invisible on every batch a real run makes. And **moving it is half a change**: this literal lives
 * in {@link CREATION_SQL}, which {@link assertSavedQueryMatches} compares against saved query
 * `8204672` BEFORE an execution is spent, so a repo-side edit not deployed in place refuses the
 * whole Dune leg terminally on every run until they agree. Re-coupling the two is a separate change
 * that carries that deploy step and buys nothing measurable.
 *
 * **It does NOT bound a run's rows on its own.** {@link LAUNCH_CAP_FLOOR} is a floor under the
 * share-out, so above 39 deployers the floor binds and the rows bound is `<deployers> × 500`. See
 * {@link launchCapPerWallet} for the bound that actually holds and why the batch-level ceiling is
 * kept as the backstop that refuses anything past `maxResultRows`.
 */
export const SQL_ROW_CEILING = 19999;

/**
 * The floor under the per-deployer cap, mirrored as a literal in {@link CREATION_SQL}'s `cap` CTE.
 *
 * **It exists so that no deployer this repo has ever measured is capped at any batch size.** A
 * purely derived cap makes the truncation threshold a function of batch size, and at the tool's own
 * 195-candidate cap the share-out is 102 rows — which would refuse the subject deployer (247
 * launches, the reproduction control) and `4q4GKBpV…` (152) on every full run, biasing the fallback
 * towards exactly the largest and most gate-relevant wallets.
 *
 * 500 is anchored on the only per-wallet counts this repo holds: 8, 10, 65, 152 and 247
 * (`CREATION-DERIVED.md` §8.3). It is ~2× the largest of them, so the whole measured population
 * enumerates whole at any batch size, and ~17× below the industrial-spam extreme the `total_bonded`
 * leaderboard serves (8,518 deploys), so a spam wallet is still contained to 500 rows rather than
 * pricing the batch at 8,518.
 */
export const LAUNCH_CAP_FLOOR = 500;

/**
 * How many rows one deployer may contribute to a batch of `walletCount` deployers.
 *
 * The same arithmetic {@link CREATION_SQL} performs server-side, mirrored here so the tool can name
 * the cap in a refusal reason. It is `max(`{@link LAUNCH_CAP_FLOOR}`, ceiling shared out)`: the
 * share-out is what keeps a small batch's bill bounded by the pinned ceiling, and the floor is what
 * keeps an ordinary deployer whole in a large one.
 *
 * **The bound this produces, stated as it actually holds** — because the share-out alone would have
 * bounded a run at {@link SQL_ROW_CEILING} rows and the floor breaks that above 39 deployers:
 *
 * - **BYTES, unchanged and provable.** Every result read is issued with `?limit=maxResultRows`, so
 *   no read returns more than 40,000 rows at <=121 bytes/row, i.e. <=~4.84 MB.
 * - **ROWS from the SQL: at most `max(`{@link SQL_ROW_CEILING}`, <deployers> × 500)`.** Above 39
 *   deployers the FLOOR binds and the share-out stops governing; above **80** deployers the product
 *   exceeds `maxResultRows`, and the batch-level ceiling in {@link DuneResultSet}'s reader REFUSES
 *   such a result rather than publishing it — the whole-batch fallback merged `main` already had.
 *   (It was above 40 until captain decision 264a raised the reader's ceiling to 40,000; note the two
 *   crossovers are now different numbers and only the second one refuses anything.) It takes roughly
 *   80 wallets of 500+ launches in one batch to get there, which the `total_bonded` leaderboard seed
 *   can serve; that is the accepted trade for never truncating a measured wallet.
 *
 * A wallet above its run's cap falls back to the walk, which is the slow answer rather than a wrong
 * one — and the record carries enough to recompute the cap exactly
 * (`thresholds.dune.maxResultRows`, the gated candidate count and `dune.walletsRefusedByShape`), so
 * what a run applied is auditable after the fact. **Since captain decision 196a it is not the first
 * answer either**: {@link planOversizedSplit} re-asks for the capped wallets in their own, smaller
 * execution, where the same arithmetic hands them a far larger cap. See {@link OVERSIZED_SPLIT}.
 *
 * The share-out reads {@link SQL_ROW_CEILING} itself — the literal the SQL contains — rather than
 * re-deriving it from the pinned threshold, so this mirror cannot name a cap the vendor did not
 * apply. That the ceiling and the threshold agree is a separate, guarded assertion.
 *
 * @param {number} walletCount How many deployers went into the query parameter.
 * @returns {number} Rows per deployer, never below {@link LAUNCH_CAP_FLOOR}.
 */
export function launchCapPerWallet(walletCount) {
  return Math.max(LAUNCH_CAP_FLOOR, Math.floor(SQL_ROW_CEILING / Math.max(1, walletCount)));
}

// --- the oversized split (captain decision 196a) ------------------------------------------------

/**
 * The one sentence that says what the split is and what it is not. It reaches a refusal reason and
 * this module's own documentation, because a reader meeting a still-refused oversized wallet needs
 * to know the split ran and did not reach it, rather than that it does not exist.
 */
export const OVERSIZED_SPLIT =
  'CAPTAIN DECISION 196a: a wallet the per-deployer cap truncates is re-asked for in its own, ' +
  'smaller execution, where the same arithmetic hands it a much larger cap. The cap was not raised: ' +
  'raising it trades one arbitrary bound for another and leaves the bias towards the largest ' +
  'histories exactly where it was, one notch further out. It is OPT-IN per caller and it spends a ' +
  'BILLED execution per group, so a caller enabling it is stating a budget, and what it does NOT ' +
  'reach is counted rather than left to be inferred from the wallets that came back.';

/**
 * @typedef {object} OversizedGroup
 * @property {string[]} wallets       The deployers this follow-up execution asks about, largest
 *   declared history first.
 * @property {number} launchCap       The per-deployer cap this group's own execution will apply —
 *   {@link launchCapPerWallet} over the group's size, not the original batch's.
 * @property {number} expectedRows    Sum of the group's declared histories, i.e. how many rows the
 *   execution should return if every wallet enumerates whole.
 */

/**
 * @typedef {object} OversizedSplitPlan
 * @property {OversizedGroup[]} groups Follow-up executions to issue, in the order they are issued.
 *   **Largest history first**, which is the whole point: the refusal this fixes is biased towards
 *   the largest wallets, so a budget that binds must bind on the smallest ones instead of
 *   reinstating the bias it removed.
 * @property {{ wallet: string, declaredLaunches: number | null, reason: string }[]} unplaced
 *   Wallets the plan could not seat, each with the whole sentence saying why. These stay refused and
 *   take the creation walk, and the count of them is what a report must state rather than implying
 *   the split closed the blackout.
 * @property {number} rowsPlanned     Rows every planned group expects to return, summed.
 */

/**
 * Pack cap-truncated wallets into follow-up executions that will not truncate them.
 *
 * **Why this is a split rather than a bigger cap.** {@link LAUNCH_CAP_FLOOR} is sized against the
 * histories this repo had measured (8/10/65/152/247) and refuses **604 of the 3,036 wallets in the
 * 2026-07 creation census — 19.9%**, biased towards the largest histories, which are the wallets
 * most worth finding (`slot-zero-census-wallet-gate-validation` → `report.md` finding 2, held in
 * firstmate's records, not in this repo). Raising
 * the floor moves that boundary without removing the bias. Splitting removes it at its cause: the
 * cap is `max(500, floor(19999 / <deployers in the batch>))`, so the SAME committed SQL hands a
 * two-wallet batch 9,999 rows per deployer and a one-wallet batch 19,999. **No SQL changes, so saved
 * query `8204672` is untouched** — the deploy step this repo warns about is not part of this change.
 *
 * The sizes are free: {@link CREATION_SQL} returns `launches_total` beside every row, so the first
 * execution already said exactly how big each truncated wallet is. The plan is arithmetic over
 * numbers already paid for, not a discovery step.
 *
 * Two constraints decide a group, and both are the vendor's rather than this module's:
 *
 * 1. **The cap must clear the group's largest wallet.** With `k` wallets the cap is
 *    {@link launchCapPerWallet}`(k)`, so a 6,694-launch wallet fixes `k <= 2`. Wallets are sorted
 *    descending and grouped contiguously, so the group's first member is its largest and the
 *    constraint is checked once per admission.
 * 2. **The rows must stay inside what {@link DuneResultSet}'s reader will accept**, which is
 *    `maxRowsPerExecution` and defaults to {@link SQL_ROW_CEILING} — the largest result that reader
 *    does not refuse outright. It is the vendor-facing bound rather than an invented one. **A
 *    tighter value is an operator's to pass**: `/results` also pages on RESPONSE SIZE, and a group
 *    Dune pages is refused whole by the reader's own wholeness check, so a big group risks a billed
 *    execution for no answer. The largest single-page read this repo has measured is 944,347 bytes
 *    (~8,200 rows); anything above that is untested rather than known-bad.
 *
 * A wallet bigger than one whole execution can hold is not seatable at any batch size and is said so
 * explicitly, because that residual is permanent and belongs in a report rather than in silence.
 *
 * @param {object} input
 * @param {readonly { wallet: string, declaredLaunches: number | null }[]} input.wallets The
 *   cap-truncated wallets and the totals their own rows declared.
 * @param {number} input.maxExecutions How many follow-up executions this run may still spend. See
 *   {@link enumerateCreations} for why that is the run's already-pinned ceiling and not a new number.
 * @param {number} [input.maxRowsPerExecution] Defaults to {@link SQL_ROW_CEILING}.
 * @returns {OversizedSplitPlan}
 */
export function planOversizedSplit(input) {
  const maxRows = Math.max(1, Math.min(input.maxRowsPerExecution ?? SQL_ROW_CEILING, SQL_ROW_CEILING));
  const maxExecutions = Math.max(0, input.maxExecutions);
  /** @type {{ wallet: string, declaredLaunches: number | null, reason: string }[]} */
  const unplaced = [];
  /** @type {{ wallet: string, declared: number }[]} */
  const seatable = [];

  for (const w of input.wallets) {
    const declared = w.declaredLaunches;
    if (declared === null || !Number.isSafeInteger(declared) || declared <= 0) {
      // Nothing to pack against. This cannot arise from a cap truncation — that refusal is DEFINED
      // by a declared total above the rows returned — but a planner that quietly assumed a size
      // would be inventing the one number the whole design rests on.
      unplaced.push({
        wallet: w.wallet,
        declaredLaunches: declared,
        reason:
          `this wallet's own rows declared no usable creation total, so there is no size to plan a ` +
          `follow-up execution against and one cannot be sized rather than guessed. The creation ` +
          `walk answers for it.`,
      });
      continue;
    }
    if (declared > SQL_ROW_CEILING) {
      unplaced.push({
        wallet: w.wallet,
        declaredLaunches: declared,
        reason:
          `this wallet declares ${declared} creation(s), more than the ${SQL_ROW_CEILING} rows one ` +
          `whole execution may return, so it does not fit even in an execution of its own — a batch ` +
          `of one is capped at ${launchCapPerWallet(1)} rows and the result reader refuses anything ` +
          `larger. It is not seatable at ANY batch size and the creation walk is the only route to ` +
          `its whole history.`,
      });
      continue;
    }
    if (declared > maxRows) {
      unplaced.push({
        wallet: w.wallet,
        declaredLaunches: declared,
        reason:
          `this wallet declares ${declared} creation(s), more than the ${maxRows} rows per execution ` +
          `THIS caller budgeted, so the split leaves it where it was. It is not unseatable: the ` +
          `vendor's own ceiling is ${SQL_ROW_CEILING} rows and ${declared} sits inside it, so a ` +
          `caller passing a larger \`maxOversizedRowsPerExecution\`, up to ${SQL_ROW_CEILING}, would ` +
          `seat this wallet in an execution of its own. Under the budget in force the creation walk ` +
          `answers for it.`,
      });
      continue;
    }
    seatable.push({ wallet: w.wallet, declared });
  }

  // Descending, so a group's FIRST member is its largest and the cap constraint is a single check.
  // It is also the order the budget should bind in: the refusal being fixed is biased towards the
  // largest histories, so a run that runs out of executions must drop the smallest wallets.
  seatable.sort((a, b) => b.declared - a.declared || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));

  /** @type {{ wallets: string[], largest: number, rows: number }[]} */
  const packed = [];
  for (const w of seatable) {
    const open = packed[packed.length - 1];
    if (open !== undefined) {
      const k = open.wallets.length + 1;
      // `open.largest` is the group's first member because the list is sorted descending, so the
      // admission test is "does the cap a group of k gets still clear the biggest wallet in it".
      if (launchCapPerWallet(k) >= open.largest && open.rows + w.declared <= maxRows) {
        open.wallets.push(w.wallet);
        open.rows += w.declared;
        continue;
      }
    }
    packed.push({ wallets: [w.wallet], largest: w.declared, rows: w.declared });
  }

  const groups = packed.slice(0, maxExecutions).map((g) => ({
    wallets: g.wallets,
    launchCap: launchCapPerWallet(g.wallets.length),
    expectedRows: g.rows,
  }));
  for (const dropped of packed.slice(maxExecutions)) {
    for (const wallet of dropped.wallets) {
      const declared = seatable.find((s) => s.wallet === wallet)?.declared ?? null;
      unplaced.push({
        wallet,
        declaredLaunches: declared,
        reason:
          `the oversized split had ${maxExecutions} follow-up execution(s) of budget left this run ` +
          `and this wallet did not fit inside them. An execution is billed whether or not it ` +
          `succeeds, so the split spends only the budget already pinned rather than raising it, and ` +
          `the largest histories are seated first — a budget that binds must bind on the smallest ` +
          `oversized wallets, not reinstate the bias this split removes. The creation walk answers ` +
          `for it, and a later run with more execution budget reaches it.`,
      });
    }
  }

  return { groups, unplaced, rowsPlanned: groups.reduce((n, g) => n + g.expectedRows, 0) };
}

/**
 * The enumeration query's SQL, committed byte for byte.
 *
 * A saved Dune query is editable from a browser and its answer is a gate input, so
 * {@link assertSavedQueryMatches} compares this text against the saved query before an execution is
 * spent. Drift fails loudly instead of returning a different measurement under the same name.
 *
 * **DEPLOY STEP: changing this text means updating saved query `8204672` in place.** The comparison
 * runs BEFORE the execution, so a mismatch is not a wrong answer — it is a terminal refusal of the
 * whole Dune leg on every run until the saved query is restored to this text. The saved query is
 * edited IN PLACE — the id is pinned here and a new one would have to be pinned, deployed and
 * proved. **Do not restate the account's private-query count here**: it has moved in both
 * directions inside a single day, and `ENTRY_SQL` was deployed as a fourth saved query rather than
 * by displacing one. `README.md` → "Deploying a change to the committed SQL" owns the step and is
 * the one place that names ids and counts.
 *
 * **THE SIXTH COLUMN'S OWN COMMENT INSIDE THIS TEXT IS STALE, AND DELIBERATELY SO.** It states
 * captain decision 227a — the flag is recorded and reported and "reaches no bar, no rate and no
 * verdict" — which stopped being true at **captain decision 351 (2026-08-07)**: `is_mayhem_mode` is
 * READ now, and a launch it marks is excluded from BOTH the numerator and the denominator of
 * `stage1_gate.minCompletionRate`. **227c — dropping a mayhem-heavy DEPLOYER outright — is NOT
 * reversed and remains DECLINED**, which is why the denominator moves with the numerator. The rule
 * and every figure behind it are {@link MAYHEM_NOT_COMPETENCE}'s and `measure.mjs` →
 * `measureCompletion`'s.
 *
 * The comment inside the literal is left at its pre-351 bytes because this text and saved query
 * `8204672` must stay byte-identical and 351's lane made no deploy — editing it would refuse the
 * whole Dune leg terminally on the next real run, for a sentence. So a reader meeting that query in
 * Dune's own browser meets the 227a wording, and THIS paragraph is where they find out it is stale.
 * Correcting it in place is a deploy step and a captain decision, not a passing fix.
 */
export const CREATION_SQL = `-- slot-zero: ORIGINAL-CREATOR launch enumeration. One execution per candidate batch.
--
-- Committed byte for byte as CREATION_SQL in tools/deployer-screen/dune.mjs, and that module
-- refuses to spend an execution unless the saved query still matches it. A saved query is
-- editable from a browser; the answer it returns is a gate input, so drift must fail loudly.
--
-- UNION of two surfaces, deduped by mint, because NEITHER spans both coverage boundaries:
--   pump_evt_createevent  decodes the CreateEvent that BOTH Create and CreateV2 emit, from 2024-04
--   pump_call_create      decodes the original Create instruction only, from 2024-01
-- pump_call_create_v2 is deliberately ABSENT: it is not backfilled before ~2026-04-28 and
-- silently misses 101 of our subject's 239 launches, \`maxxing\` among them.
--
-- Attribution is "user" / account_user, the SIGNER of the creation. \`creator\` is a settable
-- CreateV2 argument and is NOT proof of authorship: six mints declare our subject as \`creator\`
-- while being signed by six different bot-shaped wallets.
--
-- SIX COLUMNS AND NO MORE, because retrieving results is ~71% of the bill at ~20 credits/MB.
-- The create transaction and the graduation timestamp were both dropped once the tool was shown
-- not to read them; that halves the bytes of every production run. The fifth, launches_total, is
-- a bigint and it is what makes the cap below DETECTABLE rather than silent. The sixth,
-- is_mayhem_mode, is captain decision 227a: pump.fun's mayhem-mode flag, RECORDED per launch and
-- REPORTED as a per-candidate share. It reaches no bar, no rate and no verdict, and dropping the
-- launches it marks or weighting them were the options the captain declined (227b, 227c).
--
-- is_mayhem_mode IS NULLABLE AND THE NULL MEANS "NOT MEASURED", NEVER "not a mayhem launch".
-- Only pump_evt_createevent carries the column; pump_call_create has no such field, so a mint
-- only that older surface knows about comes back NULL. bool_or takes the known value wherever
-- either surface has one and yields NULL only when neither does — the same absence-of-evidence
-- rule the rest of this module runs on, one column down.
--
-- THE CAP IS PER DEPLOYER, NOT PER BATCH, and that is the whole point of this shape. Each
-- deployer contributes at most greatest(500, floor(19999 / <deployers in the batch>)) rows.
-- Without it a single industrial-spam wallet (8,518 deploys is a real row on the total_bonded
-- leaderboard this tool seeds from) pushes the whole batch past dune.maxResultRows and EVERY
-- candidate in the run loses its Dune answer to a walk measured in hours.
--
-- THE 500 IS A FLOOR, NOT A SECOND SHARE-OUT, and it is why the rows bound is
-- max(19999, <deployers> x 500) rather than 19,999 flat: the share-out alone is 102 rows at the
-- tool's 195-candidate cap, which would truncate the subject deployer (247 launches) and
-- 4q4GKBpV (152) on every full run. 500 is ~2x the largest history this repo has measured, so no
-- measured deployer is ever capped, and ~17x below the spam extreme. Above ~40 deployers of 500+
-- launches the result can exceed the reader's ceiling, and the reader then refuses the whole
-- batch exactly as it did before this cap existed. That backstop is kept, not loosened.
--
-- launches_total is each deployer's TRUE count, computed BEFORE the cap. So truncation is
-- detected exactly — rows returned below launches_total — and only the truncated deployer falls
-- back to the walk. A capped deployer must never be read as a short-but-complete history, which
-- is why the count travels with the rows rather than being inferred from them.
--
-- THE SURVIVING PREFIX IS THE MOST RECENT LAUNCHES, so row_number() ranks created_at DESC. This
-- tool asks what a wallet is creating NOW; a capped deployer's oldest launches are the least
-- informative rows it could keep.
WITH deployers AS (
  SELECT trim(w) AS wallet FROM unnest(split('{{deployers}}', ',')) AS t(w)
), ev AS (
  SELECT e."user" AS deployer, e.mint AS mint, e.evt_block_time AS created_at,
         e.is_mayhem_mode AS mayhem
  FROM pumpdotfun_solana.pump_evt_createevent e
  JOIN deployers d ON d.wallet = e."user"
), cl AS (
  SELECT c.account_user AS deployer, c.account_mint AS mint, c.call_block_time AS created_at,
         cast(NULL AS boolean) AS mayhem
  FROM pumpdotfun_solana.pump_call_create c
  JOIN deployers d ON d.wallet = c.account_user
), deduped AS (
  SELECT deployer, mint, min(created_at) AS created_at, bool_or(mayhem) AS mayhem
  FROM (SELECT * FROM ev UNION ALL SELECT * FROM cl)
  GROUP BY 1, 2
), ranked AS (
  SELECT b.deployer, b.mint, b.created_at, b.mayhem,
         row_number() OVER (PARTITION BY b.deployer ORDER BY b.created_at DESC, b.mint DESC) AS rn,
         count(*) OVER (PARTITION BY b.deployer) AS launches_total
  FROM deduped b
), cap AS (
  SELECT greatest(500, cast(floor(19999.0 / greatest(count(DISTINCT wallet), 1)) AS bigint)) AS max_rows
  FROM deployers
)
SELECT r.deployer, r.mint, r.created_at, (c.mint IS NOT NULL) AS bonded, r.launches_total,
       r.mayhem AS is_mayhem_mode
FROM ranked r
LEFT JOIN (SELECT DISTINCT mint FROM pumpdotfun_solana.pump_evt_completeevent) c ON c.mint = r.mint
WHERE r.rn <= (SELECT max_rows FROM cap)
ORDER BY r.deployer, r.created_at
`;

/**
 * The coverage probe's SQL, committed byte for byte. See {@link CREATION_SQL} for why the text
 * lives here rather than only on Dune.
 */
export const COVERAGE_SQL = `-- slot-zero: COVERAGE PROBE for the create surfaces the enumeration reads.
--
-- Committed byte for byte as COVERAGE_SQL in tools/deployer-screen/dune.mjs, which refuses to
-- read a result unless the saved query still matches it.
--
-- WHY EVERY DUNE-DERIVED COUNT SHIPS WITH THIS: decoded tables have SILENT START DATES. They
-- return a confident, well-formed, complete-looking answer that is simply wrong before their
-- first row, and nothing in the response says so. Same failure shape as a truncated backwards
-- walk in pumpfun.mjs, and it fails in the same direction: plausible and silent.
--
-- pump_call_create_v2 is probed but NOT read by the enumeration. It is here so the probe itself
-- demonstrates the boundary that disqualifies it, rather than the repo asserting it in prose.
SELECT 'evt_createevent' AS tbl, 'first_row' AS metric, min(evt_block_time) AS at, count(*) AS n
FROM pumpdotfun_solana.pump_evt_createevent
UNION ALL
SELECT 'evt_createevent', 'last_row', max(evt_block_time), count(*)
FROM pumpdotfun_solana.pump_evt_createevent
UNION ALL
SELECT 'evt_createevent', 'month', date_trunc('month', evt_block_time), count(*)
FROM pumpdotfun_solana.pump_evt_createevent GROUP BY 1, 2, 3
UNION ALL
SELECT 'call_create', 'first_row', min(call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create
UNION ALL
SELECT 'call_create', 'last_row', max(call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create
UNION ALL
SELECT 'call_create', 'month', date_trunc('month', call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create GROUP BY 1, 2, 3
UNION ALL
SELECT 'call_create_v2', 'first_row', min(call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create_v2
UNION ALL
SELECT 'call_create_v2', 'last_row', max(call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create_v2
UNION ALL
SELECT 'call_create_v2', 'month', date_trunc('month', call_block_time), count(*)
FROM pumpdotfun_solana.pump_call_create_v2 GROUP BY 1, 2, 3
ORDER BY 1, 2, 3
`;

/**
 * The tables the enumeration actually READS, in the order {@link CREATION_SQL} unions them.
 *
 * `call_create_v2` is deliberately not here even though the probe returns it. That asymmetry is the
 * point: the probe is wider than the read so its own output demonstrates why the third table is
 * refused. A future change that adds a table to the SQL must add it here, or {@link assessCoverage}
 * will be probing a surface the query no longer matches — which is the silent failure this module
 * exists to make loud.
 */
export const ENUMERATION_TABLES = ['evt_createevent', 'call_create'];

/**
 * The parameter name {@link CREATION_SQL} declares. Named once so a rename cannot half-happen.
 */
export const DEPLOYERS_PARAM = 'deployers';

/**
 * The base58 wallet shape, and the ONLY strings {@link enumerateCreations} will put in a Dune query
 * parameter.
 *
 * **This is the first path in this repository where a vendor-supplied string reaches a query
 * language.** Every other consumer neutralises it — `encodeURIComponent` for the MadeOnSol URL, a
 * JSON parameter for the RPC walk — but Dune substitutes text parameters into the query TEXT, and
 * {@link CREATION_SQL} interpolates `{{deployers}}` inside the single-quoted literal
 * `split('{{deployers}}', ',')`. A wallet carrying a quote would close that literal and alter a
 * statement that is executed and billed on this account. Nothing upstream validates the shape:
 * `seed.mjs` → `extractWallets` accepts any non-empty string a MadeOnSol payload puts in
 * `wallet_address` / `wallet` / `address` / `deployer_wallet` / `creator`.
 *
 * A comma is excluded by the alphabet rather than by a separate rule, which matters because the
 * parameter is comma-joined: a wallet containing one would silently become two filter entries.
 */
export const WALLET_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Whether a candidate's address may be sent to Dune at all. See {@link WALLET_SHAPE}.
 *
 * @param {unknown} wallet
 * @returns {boolean}
 */
export function isEnumerableWallet(wallet) {
  return typeof wallet === 'string' && WALLET_SHAPE.test(wallet);
}

/**
 * Parse one of Dune's timestamps to epoch milliseconds.
 *
 * **TWO SPELLINGS, and both have to work.** Result rows carry `2025-12-01 19:37:59.000 UTC` — a
 * space, three fractional digits and a trailing zone word. The execution envelope carries
 * `2026-08-03T09:12:21.429632Z` — a `T`, SIX fractional digits and a `Z`. A parser accepting only
 * the first returns `null` for the second, which is how `probedAtIso` reads `null` on a probe that
 * plainly has a timestamp. Sub-millisecond digits are truncated rather than rounded, because this
 * value is compared against a coverage bound and rounding up would claim coverage of an instant the
 * table does not hold.
 *
 * Hand-parsed rather than handed to `Date`, because `new Date('2025-12-01 19:37:59.000 UTC')` is not
 * a format any standard requires an engine to accept: V8 takes it, another runtime may return
 * `Invalid Date`, and a silently-NaN creation time would flow straight into a covered-window
 * comparison that then admits or refuses the wrong launches. A strict parser returns `null` and the
 * caller refuses the row.
 *
 * @param {unknown} value
 * @returns {number | null} Epoch ms, or `null` when the value is not a timestamp this understands.
 */
export function parseDuneTimestamp(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(?:UTC|Z)?$/.exec(value.trim());
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    frac === undefined ? 0 : Number(frac.padEnd(3, '0').slice(0, 3)),
  );
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @typedef {object} TableCoverage
 * @property {string} table       Table name as the probe labels it.
 * @property {number} firstRowMs  Oldest block time the table holds. **The silent start date.**
 * @property {number} lastRowMs   Newest block time the table holds.
 * @property {number} rowsTotal   Rows in the whole table.
 * @property {{ monthMs: number, rows: number }[]} months Monthly row counts, ascending.
 */

/**
 * @typedef {object} CoverageProbe
 * @property {TableCoverage[]} tables   Every table probed, INCLUDING ones the enumeration does not
 *   read — see {@link ENUMERATION_TABLES}.
 * @property {number | null} probedAtMs When the probe's execution finished, or `null` when the
 *   vendor did not say. Freshness is a coverage property here: a cached probe whose newest row
 *   predates the enumeration cannot vouch for the enumeration's recent end.
 * @property {boolean} fromCache        True when the probe came from Dune's cached results rather
 *   than a fresh execution. Recorded because it changes what the probe can claim, not because it
 *   changes what it says.
 */

/**
 * Turn the probe query's rows into {@link CoverageProbe}.
 *
 * @param {readonly unknown[]} rows
 * @param {{ probedAtMs?: number | null, fromCache?: boolean }} [meta]
 * @returns {CoverageProbe}
 */
export function parseCoverageProbe(rows, meta) {
  /** @type {Map<string, { first: number | null, last: number | null, rowsTotal: number, months: { monthMs: number, rows: number }[] }>} */
  const byTable = new Map();
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const table = row['tbl'];
    const metric = row['metric'];
    if (typeof table !== 'string' || typeof metric !== 'string') continue;
    const at = parseDuneTimestamp(row['at']);
    const n = typeof row['n'] === 'number' ? row['n'] : Number(row['n']);
    if (at === null || !Number.isFinite(n)) continue;
    let entry = byTable.get(table);
    if (entry === undefined) {
      entry = { first: null, last: null, rowsTotal: 0, months: [] };
      byTable.set(table, entry);
    }
    if (metric === 'first_row') {
      entry.first = at;
      entry.rowsTotal = n;
    } else if (metric === 'last_row') {
      entry.last = at;
      entry.rowsTotal = n;
    } else if (metric === 'month') {
      entry.months.push({ monthMs: at, rows: n });
    }
  }

  /** @type {TableCoverage[]} */
  const tables = [];
  for (const [table, e] of byTable) {
    if (e.first === null || e.last === null) continue;
    tables.push({
      table,
      firstRowMs: e.first,
      lastRowMs: e.last,
      rowsTotal: e.rowsTotal,
      months: e.months.sort((a, b) => a.monthMs - b.monthMs),
    });
  }
  tables.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
  return {
    tables,
    probedAtMs: meta?.probedAtMs ?? null,
    fromCache: meta?.fromCache ?? false,
  };
}

/** First instant of the UTC month containing `ms`. @param {number} ms @returns {number} */
function monthFloor(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** The UTC month after `monthMs`. @param {number} monthMs @returns {number} */
function nextMonth(monthMs) {
  const d = new Date(monthMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * @typedef {object} CoverageAssessment
 * @property {boolean} ok         Whether the probed surfaces may be read at all this run.
 * @property {number | null} fromMs Oldest instant the UNION of the read tables covers, `null` when
 *   the probe could not establish one. **`null` means covered NOTHING**, never "since the epoch" —
 *   the same rule `creation.mjs` → `coveredBoundMs` states for the walk's window, and for the same
 *   reason: a `0` sentinel there reads as a 56-year window that contains every timestamp.
 * @property {number | null} toMs Newest instant the union covers.
 * @property {string[]} reasons   Why the probe refuses, empty when it does not. Every entry is a
 *   whole sentence, because these reach a run record and a rendered line.
 * @property {{ monthIso: string }[]} holes Months inside the covered span where the union of read
 *   tables holds NO row at all. A hole is the `create_v2` failure arriving in the middle rather than
 *   at the start, and it is what stops this probe from being a start-date check wearing a longer name.
 * @property {boolean} staleOnly True when staleness is the ONLY thing wrong. That case is
 *   repairable by re-executing the probe, which {@link enumerateCreations} does once; a hole or a
 *   missing table is not repairable by asking again and falls straight through to the walk.
 */

/**
 * Decide whether the probed coverage lets a Dune count be published at all.
 *
 * Three refusals, and each one is a way a confident wrong answer gets out:
 *
 * 1. **A read table is missing from the probe, or holds no rows.** The enumeration would then be
 *    reading a surface nothing vouched for.
 * 2. **A hole inside the covered span.** Any month between the union's first and last row where
 *    both read tables return zero. This is the `pump_call_create_v2` defect stated mechanically:
 *    had that table been the one read, every month from 2025-12 to 2026-03 would be empty here.
 * 3. **Staleness.** The union's newest row is older than `maxCoverageLagMs`. The probe cannot vouch
 *    for a period it does not reach, and the recent end is exactly where a live screen looks.
 *
 * @param {object} input
 * @param {CoverageProbe} input.probe
 * @param {number} input.nowMs
 * @param {{ maxCoverageLagMs: number }} input.bounds
 * @param {readonly string[]} [input.tables] Defaults to {@link ENUMERATION_TABLES}.
 * @returns {CoverageAssessment}
 */
export function assessCoverage(input) {
  const wanted = input.tables ?? ENUMERATION_TABLES;
  /** @type {string[]} */
  const reasons = [];
  /** @type {TableCoverage[]} */
  const read = [];

  for (const name of wanted) {
    const t = input.probe.tables.find((x) => x.table === name);
    if (t === undefined) {
      reasons.push(
        `the coverage probe returned nothing for \`${name}\`, which the enumeration reads — so no ` +
          `count from it is bounded and none may be published.`,
      );
      continue;
    }
    if (t.rowsTotal <= 0) {
      reasons.push(
        `\`${name}\` holds no rows at all, so the enumeration would be reading an empty surface and ` +
          `reporting the result as a launch history.`,
      );
      continue;
    }
    read.push(t);
  }

  if (read.length === 0) {
    return { ok: false, fromMs: null, toMs: null, reasons, holes: [], staleOnly: false };
  }

  const fromMs = Math.min(...read.map((t) => t.firstRowMs));
  const toMs = Math.max(...read.map((t) => t.lastRowMs));

  // Monthly union across the read tables. A month absent from every one of them is a hole.
  /** @type {Map<number, number>} */
  const unionMonths = new Map();
  for (const t of read) {
    for (const m of t.months) unionMonths.set(m.monthMs, (unionMonths.get(m.monthMs) ?? 0) + m.rows);
  }
  /** @type {{ monthIso: string }[]} */
  const holes = [];
  for (let m = monthFloor(fromMs); m <= monthFloor(toMs); m = nextMonth(m)) {
    if ((unionMonths.get(m) ?? 0) <= 0) holes.push({ monthIso: new Date(m).toISOString().slice(0, 7) });
  }
  if (holes.length > 0) {
    reasons.push(
      `the probed surfaces hold NO row at all in ${holes.length} month(s) inside their own covered ` +
        `span (${holes.map((h) => h.monthIso).join(', ')}). A decoded table with a gap returns a ` +
        `complete-looking answer that is simply missing those launches, so no count over this span ` +
        `may be published.`,
    );
  }

  const structuralReasons = reasons.length;
  const lagMs = input.nowMs - toMs;
  if (lagMs > input.bounds.maxCoverageLagMs) {
    reasons.push(
      `the probed surfaces' newest row is ${(lagMs / 3_600_000).toFixed(1)} h old, past the pinned ` +
        `${(input.bounds.maxCoverageLagMs / 3_600_000).toFixed(1)} h. The probe cannot vouch for a ` +
        `period it does not reach, and the recent end is where a live screen looks.`,
    );
  }

  return {
    ok: reasons.length === 0,
    fromMs,
    toMs,
    reasons,
    holes,
    staleOnly: structuralReasons === 0 && reasons.length > 0,
  };
}

/**
 * @typedef {object} DuneLaunch
 * @property {string} mint
 * @property {number} createdAtMs
 * @property {boolean} bonded Whether `pump_evt_completeevent` holds this mint — the chain's own
 *   statement that the curve completed, and the same transition the on-chain `complete` byte records.
 * @property {boolean | null} mayhem pump.fun's `is_mayhem_mode` on the create event, or `null`
 *   when this launch's row could not say. **`null` is "not measured", never "not a mayhem
 *   launch"** — `pump_call_create` has no such column, so a mint only that surface knows about
 *   reaches here with nothing to read. See {@link MAYHEM_NOT_COMPETENCE} for why an unreadable
 *   value is folded to `null` here rather than refusing the row the way `bonded` does.
 */

/**
 * The one sentence that says what the mayhem flag is FOR, and what it is still forbidden to do.
 *
 * WHERE IT ACTUALLY GOES, and it claims nothing beyond this: it is the rule this module's reading
 * of `is_mayhem_mode`, {@link summariseMayhem} and {@link WalletEnumeration.mayhemByMint} are
 * written to, and it is printed VERBATIM once per run in `render.mjs` → `renderStage1`'s legend,
 * because a count sitting beside a gate's inputs has to say which of them it is. It is NOT persisted
 * on the run record: the per-candidate `creation` block carries the enumeration-wide numbers, the
 * candidate row carries the competence measure's own two counts, and the sentence is stated once for
 * a reader rather than repeated on every row.
 *
 * **The evidence, in two decisions.** `slot-zero-graduation-regime-remeasure` → `report.md` §1.4 and
 * §3 established the flag as a first-order confounder: 27.1% of pump.fun's 2026-07 launches carried
 * `is_mayhem_mode`, they graduated at 4.1–4.7% against 1.8–2.1% for the rest, and they supplied
 * 46.3% of that month's graduations. **Captain decision 227a** answered that with the cheapest move
 * that changed nothing — RECORD it and REPORT it, and leave what the screen should DO about it to a
 * later decision on evidence that lane had yet to produce. `slot-zero-offlaunchpad-graduation-criterion`
 * → `report.md` §4 and §8.2 is that evidence: a mayhem graduation is preceded by a median net quote
 * inflow of **0.291 SOL** against **85.005 SOL** for a classic curve graduation — **292x cheaper**,
 * and not separable in trade data from a token that churned about $1,700 and died. (Both reports are
 * held in firstmate's records, not in this repo — see `CLAUDE.md` → "Citing a report this repo does
 * not hold".)
 *
 * **Captain decision 351 (2026-08-07) therefore REVERSES 227b**: a mayhem-mode graduation is not
 * competence evidence, so a known-mayhem launch is excluded from the numerator AND the denominator
 * of `minCompletionRate`. `measure.mjs` → `measureCompletion` is the one reader and owns the whole
 * argument, including what an unreadable flag does.
 *
 * **227c is NOT reversed and remains DECLINED.** No deployer is dropped, weighted or refused for
 * HAVING a mayhem record; they are judged on their non-mayhem one. That is why the exclusion had to
 * take the denominator with it — a numerator-only exclusion drives a mayhem-heavy deployer's rate
 * towards 0.0000 and removes them from the gate, which is 227c arriving by arithmetic.
 *
 * The rest of the posture is unchanged: nothing but the competence measure reads the flag, no
 * STAGE 2 bar, verdict or field takes it as an input, and a `null` share still means the route did
 * not measure it rather than that the candidate has no mayhem launches.
 */
export const MAYHEM_NOT_COMPETENCE =
  'CAPTAIN DECISION 351 (which REVERSES 227b): a mayhem-mode graduation is not competence ' +
  'evidence — it raises a median 0.291 SOL against 85.005 for a classic curve graduation — so a ' +
  'launch pump.fun\'s mayhem-mode flag marks is excluded from BOTH the numerator and the ' +
  'denominator of the completion gate, and a deployer is judged on their non-mayhem record. ' +
  'CAPTAIN DECISION 227c IS NOT REVERSED AND REMAINS DECLINED: no deployer is dropped, weighted ' +
  'or refused for having a mayhem record, which is exactly why the denominator moves with the ' +
  'numerator. Nothing else reads the flag — no Stage 2 bar, no entry verdict — and the ' +
  'per-candidate share beside these counts is still 227a\'s REPORTED observation. A null share ' +
  'means the enumeration route did not measure the flag, never that the candidate has no mayhem ' +
  'launches; an UNREADABLE flag is counted and kept in the competence reading rather than being ' +
  'read as non-mayhem or silently dropped.';

/**
 * @typedef {object} MayhemExposure
 * @property {number} launches How many of this wallet's enumerated launches the flag could be read
 *   on — the share's DENOMINATOR, and not the same as the launch count beside it.
 * @property {number} mayhem   Of those, how many carry `is_mayhem_mode = true`.
 * @property {number} unknown  Launches enumerated whose flag could not be read at all. Counted
 *   rather than folded into the `false` bucket, because folding it there would report a confident
 *   low share for a wallet nothing looked at.
 * @property {number | null} share `mayhem / launches`, or `null` when the denominator is 0 —
 *   which is the answer "this reading measured the flag on nothing", not "0%".
 */

/**
 * Count a wallet's mayhem exposure over the launches one enumeration returned for it.
 *
 * **The denominator is the launches the flag was READABLE on, not the launches enumerated**, and
 * the two are reported apart. A wallet whose history reaches back past `pump_evt_createevent` picks
 * up rows from `pump_call_create`, which has no such column; dividing by the whole history would
 * quietly dilute its share towards zero in exactly the era the flag did not exist to be set.
 *
 * @param {readonly DuneLaunch[]} launches
 * @returns {MayhemExposure}
 */
export function summariseMayhem(launches) {
  let mayhem = 0;
  let known = 0;
  let unknown = 0;
  for (const l of launches) {
    if (l.mayhem === null) unknown += 1;
    else {
      known += 1;
      if (l.mayhem) mayhem += 1;
    }
  }
  return { launches: known, mayhem, unknown, share: known === 0 ? null : mayhem / known };
}

/**
 * Group the enumeration query's rows by deployer.
 *
 * Rows whose timestamp will not parse, whose mint or deployer is missing, or whose `bonded` is not a
 * BOOLEAN are counted rather than dropped silently: a partly-unreadable answer is not a shorter
 * answer, and a wallet whose rows went unread must fall back to the walk rather than be gated on
 * what survived.
 *
 * **`bonded` is type-checked, not truth-checked, and it is the column that most needs it.** `false`
 * is a legitimate value there, so `=== true` would collapse "the column is gone" into "this launch
 * did not bond" — a `LEFT JOIN pump_evt_completeevent` whose spelling shifts would make every
 * candidate in the batch read 0% bonded and gate-FAIL, on a run reporting itself fully measured.
 * Absent and legitimately-false must not be indistinguishable, so an absent one takes the same route
 * a bad timestamp already does rather than a second, weaker one of its own.
 *
 * **`launches_total` is checked exactly as hard as `bonded`, and for the same reason.** It is the
 * deployer's true count before {@link CREATION_SQL}'s per-deployer cap, and it is the ONLY thing
 * that distinguishes a capped history from a whole one. A missing or non-numeric value therefore
 * counts the row unreadable rather than defaulting to "not capped": a default would delete the cap's
 * detection the day the column is renamed, and every capped wallet would be gated on a prefix of its
 * history reported as a total — silently, on a run reporting itself fully measured.
 *
 * **`is_mayhem_mode` is read exactly the OPPOSITE way, and captain decision 351 makes the asymmetry
 * MORE load-bearing rather than less.** A value that is not a boolean folds to `null` — "not
 * measured" — and the row is kept. Since 351 the flag does reach a gate (`measure.mjs` →
 * `measureCompletion` excludes a known-mayhem launch from both sides of the completion rate), so
 * the old justification — *an observation cannot move a verdict* — no longer holds and the rule is
 * now held by the DIRECTION of each failure instead:
 *
 * - **Refusing the row is the worse failure, and it is worse now than it was.** An unreadable row
 *   refuses the WHOLE batch, every candidate in it falls back to the creation walk, and the walk
 *   cannot see this column at all — so a shifted or renamed `is_mayhem_mode` would cost every
 *   candidate its Dune answer AND its mayhem reading, in one move, on a run reporting itself
 *   measured.
 * - **Folding to `null` degrades to the pre-351 reading and nothing worse.** An unreadable flag is
 *   KEPT in the competence measure and counted (`CompletionMeasurement.mayhemUnreadable`), so a
 *   column that vanishes returns this gate to exactly the rate it computed before 351 — visibly, on
 *   a count a reader can check — rather than to a different one. Critically, folding to `null` can
 *   never REMOVE a launch: only a flag that positively read `true` excludes anything, so junk in
 *   this column cannot shrink a deployer's evidence towards the invisible false rejection.
 *
 * `bonded` and `launches_total` stay in the other bucket for the reason they always were: an absent
 * one silently SHORTENS a history, which no count on the record could show.
 * See {@link MAYHEM_NOT_COMPETENCE}.
 *
 * `declaredByWallet` carries that count per wallet, or `null` when the wallet's own rows disagreed
 * about it. A disagreement is nameable per wallet, unlike a parse failure, so it refuses that wallet
 * rather than the batch — see {@link toWalletEnumeration}.
 *
 * **`unreadableRows > 0` refuses the WHOLE batch**, in {@link enumerateCreations}, and the blast
 * radius is deliberate rather than lazy. A row that fails to parse commonly has no readable
 * `deployer` — that is one of the ways it fails to parse — so the wallet whose history came
 * back short is exactly the wallet that cannot be named. Attributing the damage per wallet would
 * leave the affected one gated on a silently short history, which is the confident-wrong-answer
 * shape this module exists to refuse, arriving through the parser instead of through coverage.
 *
 * @param {readonly unknown[]} rows
 * @returns {{ byWallet: Map<string, DuneLaunch[]>, declaredByWallet: Map<string, number | null>, unreadableRows: number }}
 */
export function parseCreationRows(rows) {
  /** @type {Map<string, DuneLaunch[]>} */
  const byWallet = new Map();
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  /** @type {Map<string, number | null>} */
  const declaredByWallet = new Map();
  let unreadableRows = 0;

  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) {
      unreadableRows += 1;
      continue;
    }
    const row = /** @type {Record<string, unknown>} */ (raw);
    const deployer = row['deployer'];
    const mint = row['mint'];
    const createdAtMs = parseDuneTimestamp(row['created_at']);
    // `bonded` is TYPE-checked rather than read as `=== true`, and it is the one column where that
    // distinction is the whole point: `false` is a legitimate value, so a truthiness test collapses
    // "the column is gone" into "this launch did not bond". A LEFT JOIN whose column shifts would
    // then make every candidate in the batch read 0% bonded and gate-fail, with `unreadableRows: 0`
    // and a clean coverage probe reporting the run as fully measured.
    const bonded = row['bonded'];
    // The deployer's TRUE launch count, before CREATION_SQL's per-deployer cap. Read as strictly as
    // `bonded` and for the same reason: it is the only signal that says the rows are a prefix, so
    // treating an absent one as "not capped" would silently reinstate the very failure the cap
    // exists to make visible. A numeric STRING is accepted because a bigint column may arrive as
    // one; a boolean is not, so a shifted column cannot be read as the count 1.
    const declared = readRowCount(row['launches_total']);
    // 227a's observation column, and it is deliberately NOT part of the refusal test below. Anything
    // that is not a boolean — the column absent, renamed, or arriving as a string — reads as `null`,
    // "nobody measured this launch's flag", and the row survives. Refusing here would refuse the
    // batch, send every candidate to the creation walk, and let a reporting field change a verdict.
    const mayhem = typeof row['is_mayhem_mode'] === 'boolean' ? row['is_mayhem_mode'] : null;
    if (
      typeof deployer !== 'string' ||
      deployer === '' ||
      typeof mint !== 'string' ||
      mint === '' ||
      createdAtMs === null ||
      typeof bonded !== 'boolean' ||
      declared === null
    ) {
      unreadableRows += 1;
      continue;
    }
    let mints = seen.get(deployer);
    if (mints === undefined) {
      mints = new Set();
      seen.set(deployer, mints);
      byWallet.set(deployer, []);
      declaredByWallet.set(deployer, declared);
    } else if (declaredByWallet.get(deployer) !== declared) {
      // One deployer, two answers about its own size. Nameable, so it refuses this wallet only.
      declaredByWallet.set(deployer, null);
    }
    // The SQL already dedupes by (deployer, mint); this is the belt to that braces, because a
    // duplicated mint would double-count a launch on both sides of the gate's fraction.
    if (mints.has(mint)) continue;
    mints.add(mint);
    byWallet.get(deployer)?.push({ mint, createdAtMs, bonded, mayhem });
  }

  for (const list of byWallet.values()) list.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return { byWallet, declaredByWallet, unreadableRows };
}

/**
 * Read a positive whole-number count out of a result cell, or `null` when the cell is not one.
 *
 * Deliberately narrower than `Number`: `true`, `null`, `''` and `'12abc'` all become numbers under
 * it, and a shifted column read as the count 1 or 0 is exactly the silent shortening this module
 * refuses. A numeric string IS accepted, because a bigint may arrive as one.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function readRowCount(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * @typedef {object} WalletEnumeration
 * @property {boolean} usable      Whether this wallet's reading may be gated on. `false` means fall
 *   back to the creation walk — never "this wallet has no launches".
 * @property {string[]} reasons    Why it is not usable, empty when it is.
 * @property {import('./creation.mjs').CreateRecord[]} creates
 * @property {Map<string, import('./creation.mjs').CurveState>} curves
 * @property {import('./creation.mjs').CoveredWindow} covered
 * @property {number} launches     Distinct mints the enumeration RETURNED for this wallet. On a
 *   usable reading that is its whole history; on one the per-deployer cap truncated it is a prefix,
 *   which is why `usable` is false there and `declaredLaunches` says how much was left behind.
 * @property {number | null} declaredLaunches The count the answer declared for this wallet
 *   (`launches_total`), before {@link CREATION_SQL}'s cap. `null` when the wallet had no row at all,
 *   or when its rows disagreed about it.
 * @property {boolean} truncatedByLaunchCap Whether this wallet was refused because the per-deployer
 *   cap cut its history. Counted at run level so a batch that lost one wallet to the cap does not
 *   look like a batch that lost nothing.
 * @property {number} bonded       How many of them the chain says completed.
 * @property {MayhemExposure} mayhem What share of them pump.fun's mayhem-mode flag marks — captain
 *   decision 227a's REPORTED figure, and still reported rather than read: no bar takes this SHARE
 *   as an input. It is computed over whatever rows came back, INCLUDING on a reading that is
 *   `usable: false`, because a refused reading is still the only mayhem evidence this run holds for
 *   the wallet and the alternative is a blank where the answer "we saw N and could read the flag on
 *   none" belongs. See {@link MAYHEM_NOT_COMPETENCE}.
 * @property {Map<string, boolean>} mayhemByMint The PER-LAUNCH flag, for the one consumer captain
 *   decision 351 licensed: `creation.mjs` → `mergeHistories`, which hands it to the competence
 *   measure so a mayhem launch leaves both sides of `minCompletionRate`. **Only launches the flag
 *   was READABLE on have an entry** — an absent mint is unreadable, never non-mayhem, which is the
 *   same three-state rule {@link MayhemExposure} keeps apart as `launches` against `unknown`.
 *   Distinct from `creates`/`curves` on purpose: those are the walk's own shape and the walk cannot
 *   see this column, so the flag travels beside them rather than inside them.
 * @property {number | null} firstLaunchMs
 * @property {number | null} lastLaunchMs
 */

/**
 * Turn one wallet's rows into the shape `creation.mjs` → `mergeHistories` already consumes, and
 * decide whether that shape may be used at all.
 *
 * **The per-wallet refusal is the launch-level half of the coverage condition**, and it is the one a
 * run-level probe cannot make: a wallet whose earliest launch sits at or before the union's first
 * row may have launched before the tables begin, and there is nothing in the answer that would say
 * so. That wallet falls back to the walk. A launch NEWER than the probed ceiling is the same failure
 * from the other end, and it is reachable in practice — the probe defaults to a cached read, so an
 * enumeration executed after it can return a launch the probe never covered.
 *
 * **A wallet the enumeration returned NO row for is refused too, and that is not a reading of "this
 * wallet created nothing".** It is an absence of evidence, and treating it as evidence of absence is
 * the worst failure available here: `mergeHistories` would read `covered.exhausted` over the probe's
 * whole multi-year span, count every in-window row of that wallet's ownership listing
 * `notCreatedByWallet`, drop them, and apply the gate to a history of zero created launches. That is
 * precisely the invisible false rejection the creation-derived lane exists to remove, manufactured
 * out of nothing. It falls back to the walk, which CAN tell the two apart.
 *
 * `covered.exhausted` therefore tracks THIS wallet's usability rather than the run-level probe: a
 * refused reading must not carry a claim of exhaustive coverage into the merge even if nothing
 * downstream reads it today.
 *
 * **A wallet the per-deployer cap TRUNCATED is refused, and it is not the same thing as the vendor
 * handing back a page.** {@link CREATION_SQL} returns at most {@link launchCapPerWallet} rows per
 * deployer and carries each deployer's true `launches_total` beside them, so this is DELIBERATE
 * truncation and the tool knows its exact size. The distinction from `/results` paging on response
 * size matters and the two checks stay separate: that one compares `rows.length` against the result
 * set's own `total_row_count` and lives in {@link DuneResultSet}'s reader, where a mismatch means
 * bytes went missing in transit; this one compares the rows returned FOR ONE WALLET against the
 * count that wallet's own rows declare, where a shortfall means the query cut the history on
 * purpose. A capped wallet must never be read as a short-but-complete launch history — that is
 * precisely the invisible false rejection this lane exists to remove — so it takes the walk, which
 * enumerates the whole thing, while every other candidate in the batch keeps its Dune answer.
 *
 * A shortfall the cap does NOT explain is refused too, under its own sentence. Nothing measured
 * produces it; it is the shape a future defect would arrive in, and a reading that cannot account
 * for its own row count may not be gated on.
 *
 * `curves` carries `creator: null` on every entry, deliberately. Dune says who created a mint and
 * whether it completed; it does not say who the curve's creator is NOW, so
 * `mergeHistories.movedCreator` must not be allowed to report 0 as though it had measured one.
 *
 * @param {object} input
 * @param {string} input.wallet
 * @param {readonly DuneLaunch[]} input.launches
 * @param {CoverageAssessment} input.coverage
 * @param {number | null} [input.declaredLaunches] `launches_total` for this wallet, `null` when its
 *   rows disagreed about it. OMITTED means the caller declares nothing and the row-count check is
 *   skipped; `null` is a refusal. Only {@link enumerateCreations} is in a position to supply it.
 * @param {number | null} [input.launchCap] The per-deployer cap this run applied, for the reason's
 *   own arithmetic. See {@link launchCapPerWallet}.
 * @param {number | null} [input.batchWallets] How many deployers shared that cap.
 * @param {readonly string[]} [input.priorReasons] Batch-level refusals already established for this
 *   wallet — an unreadable row anywhere in the answer, or an address never sent. They are carried
 *   here so every refusal reaches `reasons` by one route.
 * @returns {WalletEnumeration}
 */
export function toWalletEnumeration(input) {
  const { wallet, launches, coverage } = input;
  /** @type {string[]} */
  const reasons = [...(input.priorReasons ?? [])];
  // `undefined` means the caller declared nothing — the shape check below is skipped. `null` means
  // the answer declared something that could not be reconciled, which is a refusal. The two are
  // deliberately not collapsed, and the strictness that matters lives where the absence actually
  // arrives from the network: `parseCreationRows` counts a row with no `launches_total` unreadable,
  // so a vendor omission never reaches here wearing a caller's "nothing to declare".
  const declaredSupplied = input.declaredLaunches !== undefined;
  const declaredLaunches = launches.length === 0 ? null : (input.declaredLaunches ?? null);
  const launchCap = input.launchCap ?? null;
  let truncatedByLaunchCap = false;

  const firstLaunchMs = launches.length === 0 ? null : Math.min(...launches.map((l) => l.createdAtMs));
  const lastLaunchMs = launches.length === 0 ? null : Math.max(...launches.map((l) => l.createdAtMs));

  if (!coverage.ok || coverage.fromMs === null || coverage.toMs === null) {
    reasons.push('the run-level coverage probe refused these surfaces, so no count over them is bounded.');
  } else {
    if (firstLaunchMs !== null && firstLaunchMs <= coverage.fromMs) {
      reasons.push(
        `this wallet's earliest enumerated launch (${new Date(firstLaunchMs).toISOString()}) is at or ` +
          `before the probed surfaces' own first row (${new Date(coverage.fromMs).toISOString()}), so ` +
          `its history may reach outside the probed coverage and the count would be a lower bound ` +
          `presented as a total.`,
      );
    }
    if (lastLaunchMs !== null && lastLaunchMs > coverage.toMs) {
      reasons.push(
        `this wallet's newest enumerated launch (${new Date(lastLaunchMs).toISOString()}) is newer than ` +
          `the probed surfaces' own last row (${new Date(coverage.toMs).toISOString()}), so the probe ` +
          `does not cover the period the count was read over.`,
      );
    }
  }

  // What the answer says about this wallet's SIZE, against what it handed over for it. The cap is
  // deliberate truncation and it is checked here rather than in the reader, because the reader's
  // `rows.length !== total_row_count` check is about the RESULT SET losing bytes in transit and
  // this one is about the QUERY cutting one wallet's history on purpose. Conflating them would
  // either refuse every capped batch wholesale or, far worse, let a prefix pass as a total.
  if (launches.length > 0 && declaredSupplied) {
    if (declaredLaunches === null) {
      reasons.push(
        `the Dune answer gave this wallet more than one value for its own creation total, so its ` +
          `rows cannot be reconciled with the history they claim to be. A reading that cannot ` +
          `account for its own size is refused rather than published, and the creation walk answers ` +
          `for this wallet.`,
      );
    } else if (declaredLaunches > launches.length && launchCap !== null && launches.length === launchCap) {
      truncatedByLaunchCap = true;
      reasons.push(
        `the Dune answer declares ${declaredLaunches} creation(s) for this wallet and returned ` +
          `${launches.length} of them — exactly the per-deployer cap this run applied, which is the ` +
          `greater of the pinned floor of ${LAUNCH_CAP_FLOOR} and the pinned result-row ceiling ` +
          `shared between the ${input.batchWallets ?? '?'} candidate(s) in the batch. What came back ` +
          `is its most recent ${launches.length}, a PREFIX of this wallet's history, not a short history, and ` +
          `gating on it would read a truncated count as a total. The creation walk enumerates this ` +
          `wallet instead — and only this wallet: every other candidate in the batch keeps its Dune ` +
          `answer, which is the whole reason the cap is per deployer rather than per batch.`,
      );
    } else if (declaredLaunches !== launches.length) {
      reasons.push(
        `the Dune answer declares ${declaredLaunches} creation(s) for this wallet and returned ` +
          `${launches.length} distinct mint(s), which is neither its whole history nor the ` +
          `per-deployer cap of ${launchCap ?? 'unknown'} this run applied. A reading that cannot ` +
          `account for its own row count is refused rather than published, and the creation walk ` +
          `answers for this wallet.`,
      );
    }
  }

  if (reasons.length === 0 && launches.length === 0) {
    reasons.push(
      `the enumeration returned no creation row at all for this wallet, which is an absence of ` +
        `evidence rather than evidence of absence. Reading it as a launch history of zero would let ` +
        `the merge reclassify this wallet's whole ownership listing as acquired and gate it on ` +
        `nothing, so the creation walk answers for it instead.`,
    );
  }

  /** @type {import('./creation.mjs').CreateRecord[]} */
  const creates = [];
  /** @type {Map<string, import('./creation.mjs').CurveState>} */
  const curves = new Map();
  // Captain decision 351's one channel out of this module. Only a launch whose flag positively READ
  // as a boolean gets an entry: an unreadable one is left out, so a consumer that asks the map gets
  // `undefined` — the same "nobody looked" the `null` on the row means — rather than a `false` this
  // reading never established.
  /** @type {Map<string, boolean>} */
  const mayhemByMint = new Map();
  let bonded = 0;
  for (const l of launches) {
    if (typeof l.mayhem === 'boolean') mayhemByMint.set(l.mint, l.mayhem);
    creates.push({
      mint: l.mint,
      // Neither is recoverable from a decoded creation event, and neither is read by the merge. They
      // are empty rather than invented; `enumerationSource` on the record says which route produced
      // the reading, so an empty signature cannot be mistaken for a walk that lost one.
      bondingCurve: '',
      signature: '',
      creator: wallet,
      createdAtMs: l.createdAtMs,
    });
    curves.set(l.mint, { complete: l.bonded, creator: null });
    if (l.bonded) bonded += 1;
  }

  const usable = reasons.length === 0;
  return {
    usable,
    reasons,
    creates,
    curves,
    covered: {
      fromMs: coverage.fromMs,
      toMs: coverage.toMs ?? 0,
      // Inside probed coverage the enumeration is EXHAUSTIVE — it is an index of creation events,
      // not a window walked backwards until a budget bit. That is the whole difference from the
      // signature walk, and it is what lets the merge label a listed-but-not-created token
      // "acquired" instead of carrying it over. It is THIS WALLET's usability rather than the
      // run-level probe: a refused reading claims no coverage it can be held to.
      exhausted: usable,
    },
    launches: launches.length,
    declaredLaunches,
    truncatedByLaunchCap,
    bonded,
    // Computed from the same rows and touching none of the fields above it. Deliberately placed
    // AFTER `usable` is decided rather than before: the flag decides what a reading MEASURES
    // (captain decision 351, one module over in `measureCompletion`) and never whether the reading
    // may be gated on at all. A wallet does not fall back to the walk for anything mayhem-shaped.
    mayhem: summariseMayhem(launches),
    mayhemByMint,
    firstLaunchMs,
    lastLaunchMs,
  };
}

// --- the API calls -----------------------------------------------------------------------------

/**
 * Read a JSON object field without trusting the payload's shape.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return typeof value === 'object' && value !== null ? /** @type {Record<string, unknown>} */ (value)[key] : undefined;
}

/**
 * Normalise SQL for comparison: line endings and trailing whitespace only.
 *
 * Deliberately NOT a semantic comparison. Two texts that differ by a comment are two different
 * statements of intent, and this check exists to catch the case where somebody edited the saved
 * query — including its comments, which are where the traps are written down.
 *
 * @param {string} sql
 * @returns {string}
 */
export function normaliseSql(sql) {
  return sql.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/**
 * Verify a saved Dune query still holds the SQL this repo committed.
 *
 * Costs one request and NO execution, and it runs before the execution rather than after: the whole
 * point is to not spend a billed, unrecoverable execution on a query that no longer asks what this
 * module documents.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {number} queryId
 * @param {string} expectedSql
 * @returns {Promise<void>} Resolves when they match; throws {@link DuneRefused} when they do not.
 */
export async function assertSavedQueryMatches(client, queryId, expectedSql) {
  const body = await client.getJson(`/query/${queryId}`);
  const actual = field(body, 'query_sql');
  if (typeof actual !== 'string') {
    throw new DuneRefused(
      `Dune query ${queryId} returned no SQL, so it cannot be verified against the text this repo ` +
        `commits for that query id. Nothing was executed.`,
      { status: null, terminal: true },
    );
  }
  if (normaliseSql(actual) !== normaliseSql(expectedSql)) {
    throw new DuneRefused(
      `Dune query ${queryId} no longer matches the SQL committed in this repo for that query id. ` +
        `A saved query is editable from a browser and its answer is a gate input, so this run refuses ` +
        `to spend an execution on it. Restore the saved query from the committed text, or update the ` +
        `committed text on purpose. Nothing was executed.`,
      { status: null, terminal: true },
    );
  }
}

/**
 * @typedef {object} DuneResultSet
 * @property {unknown[]} rows
 * @property {number} resultBytes
 * @property {number | null} endedAtMs
 */

/**
 * Pull an execution's — or a saved query's cached — result, exactly once, and account its bytes.
 *
 * **A read that cannot prove it is whole is refused, never published.** Four ways it fails to:
 * no `total_row_count` (so nothing bounds it), a declared total above `maxResultRows` (an unbounded
 * read is an unbounded bill), rows sitting exactly on the `?limit=` it was issued with, and rows
 * DISAGREEING with the declared total — `/results` pages on response size independently of our
 * limit, so a page read as a whole answer is a launch history that is simply short.
 *
 * **The row ceiling is a BACKSTOP now, not the first line — but it is still REACHABLE.** {@link
 * CREATION_SQL} bounds the enumeration at `max(`{@link SQL_ROW_CEILING}`, <deployers> × `{@link
 * LAUNCH_CAP_FLOOR}`)` rows, so a median-shaped batch cannot come near `maxResultRows`, while
 * roughly 80 wallets of 500+ launches in one batch can still exceed it. Reaching it means either
 * that genuinely oversized batch — which falls back whole, as it did before the cap existed — or a
 * cap that did not apply, i.e. a saved query edited past the pinned text or a shape this reader does
 * not understand. **It was RAISED once, 20,000 → 40,000, and only after it refused a real 76-deployer
 * batch of 27,731 rows whole** (captain decision 264a); it was not loosened to fit an output, and a
 * soft bound on a
 * billed read is not a bound. Note also that the
 * per-deployer cap does NOT interact with the `rows.length !== total` check below: `total_row_count`
 * describes the RESULT SET the query produced, which is the capped one, so a capped enumeration
 * still returns exactly as many rows as it declares. Deliberate truncation is caught one level up,
 * per wallet, against `launches_total` — see {@link toWalletEnumeration}.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {string} path
 * @param {{ maxResultRows: number }} bounds
 * @returns {Promise<DuneResultSet>}
 */
async function readResult(client, path, bounds) {
  const body = await client.getJson(path);
  const result = field(body, 'result');
  const rows = field(result, 'rows');
  if (!Array.isArray(rows)) {
    throw new DuneRefused(`Dune returned no result rows for ${path}.`, { status: null, terminal: false });
  }
  const metadata = field(result, 'metadata');
  const bytes = Number(field(metadata, 'total_result_set_bytes') ?? field(metadata, 'result_set_bytes') ?? 0);
  client.noteResultBytes(bytes);
  // The request carries `?limit=maxResultRows`, so `rows.length` is NOT a substitute for the
  // declared total: a result truncated at exactly the limit would read as a complete result of that
  // size and sail through the ceiling check below. That is the same complete-looking-but-short
  // failure this module refuses everywhere else, so a missing total refuses rather than guesses.
  const declared = field(metadata, 'total_row_count');
  const total = Number(declared);
  if (declared === undefined || declared === null || !Number.isFinite(total)) {
    throw new DuneRefused(
      `Dune returned no \`total_row_count\` for ${path}, so this read cannot say whether it was ` +
        `truncated at the \`?limit=${bounds.maxResultRows}\` it was issued with. A result cut at the ` +
        `limit is indistinguishable from a complete one of that size, so it is refused rather than ` +
        `read as a launch history.`,
      { status: null, terminal: false },
    );
  }
  if (total > bounds.maxResultRows) {
    throw new DuneRefused(
      `Dune returned ${total} rows for ${path}, above the pinned ceiling of ${bounds.maxResultRows}. ` +
        `Results are billed by bytes, so an unbounded read is an unbounded bill; the reading is ` +
        `refused rather than paged.`,
      { status: null, terminal: false },
    );
  }
  if (rows.length >= bounds.maxResultRows) {
    throw new DuneRefused(
      `Dune returned exactly the ${bounds.maxResultRows} rows requested for ${path}, so this read ` +
        `sits on its own limit and cannot prove it is whole. It is refused rather than published.`,
      { status: null, terminal: false },
    );
  }
  // Our `?limit=` is not the only cut Dune makes: `/results` also pages on RESPONSE SIZE, in which
  // case `total_row_count` describes the whole result set while `rows` carries one page. A response
  // declaring 5,000 and handing back 1,200 clears every check above and reads as a complete launch
  // history 3,800 rows short — the same complete-looking-but-short failure, arriving from the
  // vendor's own paging rather than from ours. It also settles `total_row_count: ""`, which
  // `Number` makes a finite 0.
  if (rows.length !== total) {
    throw new DuneRefused(
      `Dune declared ${total} rows for ${path} and handed back ${rows.length}, so this read is a ` +
        `PAGE rather than the whole result — /results pages on response size independently of the ` +
        `\`?limit=\` it was issued with. A page read as a whole answer is a launch history that is ` +
        `simply short, so it is refused rather than published.`,
      { status: null, terminal: false },
    );
  }
  const endedAt = parseDuneTimestamp(field(body, 'execution_ended_at'));
  return { rows, resultBytes: Number.isFinite(bytes) ? bytes : 0, endedAtMs: endedAt };
}

/**
 * What Dune said went wrong with an execution, in one clause, from its own status body.
 *
 * Defensive on every field for the reason the rest of this module is: the shape is discovered rather
 * than documented, and a reader that assumed `error.message` was a string would throw a TypeError
 * from inside the reporting path and replace a billed execution's reason with a stack trace. An
 * absent reason is SAID, never elided — "Dune gave no reason" is itself information about a bill.
 *
 * @param {unknown} status The `/execution/{id}/status` body.
 * @returns {string} A sentence, always non-empty.
 */
export function describeExecutionError(status) {
  const error = field(status, 'error');
  const message = field(error, 'message');
  const type = field(error, 'type');
  const parts = [];
  if (typeof type === 'string' && type !== '') parts.push(type);
  if (typeof message === 'string' && message !== '') parts.push(message);
  if (parts.length === 0) return 'Dune returned no reason for the failure.';
  return `${parts.join(' — ')}.`;
}

/**
 * Run a saved query and wait for it.
 *
 * **The execution is issued exactly once.** A failed or cancelled execution is reported, never
 * retried: it is billed either way, and a second one buys a second bill for the same answer.
 * Polling is retried, because a poll is a read and a failed read costs nothing.
 *
 * **AND WHEN IT FAILS, THE VENDOR'S OWN REASON TRAVELS WITH THE REFUSAL.** It used to be dropped:
 * the throw named the state and nothing else, so an operator who had just paid for a failed
 * execution had to go and ask Dune separately what it had objected to — money spent and the result
 * withheld, which is exactly the shape captain ruling 292a names. Dune puts a `{type, message}`
 * under `error` on the status body, and it is the difference between "your statement overflowed an
 * integer" and a state name. It is read defensively and its absence is said rather than papered
 * over, because a failure whose reason is missing is still a failure that must be reportable.
 *
 * **AND GIVING UP NOW CANCELS, WHICH IS THE WHOLE OF CAPTAIN DECISION 381's SECOND HALF.** This loop
 * used to walk away when the poll budget ran out and say so — and that sentence was a lie about the
 * money: the engine kept running on Dune's side, to its own 30-minute limit, and billed the full
 * limit for a result nobody read. Measured at 180.002 credits on 2026-08-08, against a guard that had
 * cleared the plan at a pinned 6. Both give-up paths now go through `client.mjs` →
 * {@link abandonExecution}, which issues `POST /execution/{id}/cancel` before it refuses and hands
 * back `DuneExecutionAbandoned` — a DISTINCT outcome, so a reader can tell "we stopped this" from
 * "this broke". It is still a `DuneRefused` and still `terminal`, so every caller's fallback to the
 * RPC walk is unchanged. What the cancel bounds for certain is the wait; whether it stops the BILL is
 * the vendor's to say and they do not — `EXECUTION_DEADLINE_CAVEAT` carries that and rides on the
 * refusal.
 *
 * **THE DEADLINE AND THE POLL BUDGET ARE ONE BOUND IN TWO UNITS, and the duration is the authority.**
 * Captain decision 144a's rule applied here: a bound the vendor controls must not be written as two
 * numbers that can drift. `executionDeadlineMs` is the give-up point; `maxPollAttempts` is the
 * request budget that has to COVER it, and `test/dune-credit-ceiling.test.ts` pins
 * `maxPollAttempts × pollIntervalMs >= executionDeadlineMs`. It defaults to exactly that product, so
 * a caller that pins nothing keeps the give-up point it already had and gains only the cancel.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {number} queryId
 * @param {Record<string, string>} parameters
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, maxResultRows: number,
 *   executionDeadlineMs?: number | undefined, clock?: () => number }} bounds `clock` is injected
 *   only so a test can reach the deadline without waiting for it; a run reads the wall clock.
 * @returns {Promise<DuneResultSet>}
 */
export async function executeAndRead(client, queryId, parameters, bounds) {
  const clock = bounds.clock ?? Date.now;
  const deadlineMs = bounds.executionDeadlineMs ?? bounds.maxPollAttempts * bounds.pollIntervalMs;
  const executionId = await client.execute(queryId, parameters);
  const startedAtMs = clock();
  // A LIVE EXECUTION IS NEVER LEFT RUNNING, WHATEVER TOOK US OUT OF THIS LOOP. The deadline and
  // the poll budget cancel themselves through `abandonExecution`; this catches every OTHER way
  // out with the engine still going — a request ceiling reached mid-poll, a transport failure,
  // a result read this repo refuses — and cancels before rethrowing the error unchanged. Two
  // things it deliberately does not do: it does not replace the caller's error (a
  // `CeilingReached` must keep its own remedy), and it does not cancel a SETTLED execution,
  // because there is nothing to stop and the result has already been paid for.
  let settled = false;
  try {
    for (let attempt = 0; attempt < bounds.maxPollAttempts; attempt++) {
      await client.wait(bounds.pollIntervalMs);
      const status = await client.getJson(`/execution/${executionId}/status`);
      const state = field(status, 'state');
      if (state === 'QUERY_STATE_COMPLETED') {
        // SETTLED: the engine has stopped on its own. A read this repository then refuses is a
        // refusal about the ANSWER, and cancelling a finished execution would neither save money
        // nor be true.
        settled = true;
        return readResult(client, `/execution/${executionId}/results?limit=${bounds.maxResultRows}`, bounds);
      }
      if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED' || state === 'QUERY_STATE_EXPIRED') {
        // SETTLED the other way: the vendor stopped it. Nothing to cancel, and a cancel here would
        // spend a request to tell Dune something it just told us.
        settled = true;
        throw new DuneRefused(
          `Dune execution of query ${queryId} ended ${String(state)}: ${describeExecutionError(status)} It is ` +
            `billed either way and it is NOT retried — the creation enumeration falls back to the Solana ` +
            `RPC walk for this run. A statement that fails to COMPILE costs nothing; one that ran and then ` +
            `failed is billed for the engine time it consumed.`,
          { status: null, terminal: true },
        );
      }
      // The deadline is checked AFTER the poll, so a state the vendor has already settled is read
      // rather than cancelled: there is nothing to stop, and cancelling a finished execution would
      // discard a result this run has already paid for.
      if (clock() - startedAtMs >= deadlineMs) {
        await abandonExecution(client, {
          executionId,
          reason: 'deadline',
          elapsedMs: clock() - startedAtMs,
          deadlineMs,
          detail:
            `The creation enumeration falls back to the Solana RPC walk for this run, which is slower ` +
            `and costs Helius credits rather than Dune ones. Raising thresholds.json ` +
            `dune.executionDeadlineMs buys this statement more engine time and costs up to ` +
            `${executionDeadlineCredits(deadlineMs)} more credits per execution at the measured rate; ` +
            `it is a spend decision and dune.worstCaseCreditsPerExecution has to move with it.`,
        });
      }
    }
    await abandonExecution(client, {
      executionId,
      reason: 'poll-budget',
      elapsedMs: clock() - startedAtMs,
      deadlineMs,
      detail:
        `The poll budget of ${bounds.maxPollAttempts} × ${bounds.pollIntervalMs} ms expired before the ` +
        `deadline did, which means thresholds.json dune.maxPollAttempts no longer covers ` +
        `dune.executionDeadlineMs — the two are meant to be one bound in two units. The creation ` +
        `enumeration falls back to the Solana RPC walk for this run.`,
    });
  } catch (cause) {
    if (!settled && !(cause instanceof DuneExecutionAbandoned)) await cancelExecutionQuietly(client, executionId);
    throw cause;
  }
  /* c8 ignore next -- `abandonExecution` always throws; this satisfies the return type. */
  throw new Error('unreachable');
}

/**
 * Read the coverage probe.
 *
 * **Defaults to Dune's CACHED results, which cost no execution at all** — the probe is
 * parameterless, so the last execution's answer is the answer, and re-executing it every run would
 * spend the binding budget on a figure that moves by one row per second. Re-execution is an explicit
 * flag, and a cached probe that is too old to vouch for the enumeration's recent end is refused by
 * {@link assessCoverage}'s staleness rule rather than used.
 *
 * ## A FAILED PROBE EXECUTION DOES NOT TAKE THE WHOLE LEG DOWN — it falls back to the CACHE
 *
 * The recorded incident: `runs/2026-08-04.json`, where an execution of the coverage probe ended
 * `QUERY_STATE_FAILED`, the exception escaped the whole Dune leg, and all 82 candidates walked —
 * **221,731 Helius credits against roughly 20 Dune credits for the same measurement**, on a run whose
 * enumeration still had a full execution of budget left and would have answered.
 *
 * The repair is a READ, never a second execution. `client.mjs` → `DuneClient.execute` is the one call
 * in this repository that is never retried on any failure for any reason — a failed execution is
 * billed exactly like a successful one, and `dune.maxExecutionsPerRun` is 2, so a retry here would
 * both break that rule and spend the enumeration's only remaining execution to buy the same answer.
 * The cached result costs no execution at all, so a refresh that fails falls back to it and the leg
 * carries on. `assessCoverage` then decides on the merits: a fresh-enough cache lets the enumeration
 * run, a stale one refuses exactly as it does today, and the refusal reaches every candidate.
 *
 * **What the record shows afterwards, since no field was added for it:** `dune.executions` counts the
 * billed execution and `dune.coverage.fromCache` reads `true`. That pair — an execution spent AND a
 * cached probe — is the signature of this fallback, and it is distinct from both an ordinary cached
 * read (no execution) and a successful refresh (`fromCache: false`). The failure's own sentence is
 * announced rather than persisted; `opts.onRefreshFailure` is how a caller prints it.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {object} opts
 * @param {number} opts.queryId
 * @param {string} [opts.sql] The committed text this saved query must still match. Defaults to
 *   {@link COVERAGE_SQL}, the create surfaces the enumeration reads. **It is a parameter because
 *   there is now a SECOND probe of the same shape** — `dune-fills.mjs` → `TRADE_COVERAGE_SQL`, which
 *   bounds the TRADE tables Stage 2's entry statement reads. The two surfaces lag differently and a
 *   create-table watermark read as a trade-table one admits launches against tables that do not yet
 *   hold their fills, so they must be probed apart. What must NOT be duplicated is the machinery
 *   around them — the custody check, the refresh-then-cache order, the billed-execution fallback of
 *   captain decision 298a — because two copies of that is two answers to "may this surface be read".
 * @param {boolean} opts.refresh Execute instead of reading the cache.
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, executionDeadlineMs?: number | undefined,
 *   maxResultRows: number }} opts.bounds `executionDeadlineMs` is the give-up point an execution is
 *   cancelled at; absent, it defaults to the poll budget's own product. See `dune.mjs` ->
 *   `executeAndRead` and captain decision 381.
 * @param {CoverageProbe | null} [opts.fallbackProbe] A cached probe the caller ALREADY holds. Supplied
 *   on the staleness path, where re-reading the cache would spend a billed read to be handed back the
 *   very probe that was judged stale a moment ago. One rule, one code path: a refresh that fails
 *   yields a cached probe, and this only decides whether that probe has to be fetched again.
 * @param {(note: string) => void} [opts.onRefreshFailure] Called with the vendor's own sentence when a
 *   refresh execution fails and the cache answers instead. The spend is real and the operator is told.
 *   **It is also the only signal that the failure happened**, and a caller that may execute this probe
 *   again must consume it as one: the returned probe reads `fromCache: true` on a failed refresh and on
 *   an ordinary cached read alike, so `fromCache` cannot tell those apart and a caller inferring the
 *   failure from it would re-execute a statement that just failed. {@link enumerateCreations} is the
 *   caller that does exactly this.
 * @returns {Promise<CoverageProbe>}
 */
export async function readCoverageProbe(client, opts) {
  await assertSavedQueryMatches(client, opts.queryId, opts.sql ?? COVERAGE_SQL);
  if (opts.refresh) {
    try {
      const executed = await executeAndRead(client, opts.queryId, {}, opts.bounds);
      return parseCoverageProbe(executed.rows, { probedAtMs: executed.endedAtMs, fromCache: false });
    } catch (cause) {
      // The execution is billed and is NOT retried. What IS repairable for free is the answer: the
      // probe is parameterless, so Dune's cached result for it is the same shape and costs no
      // execution. Falling through to the walk here would trade ~1 Dune credit for a whole-batch
      // signature walk, which is the cliff this path exists to refuse.
      opts.onRefreshFailure?.(cause instanceof Error ? cause.message : String(cause));
      if (opts.fallbackProbe != null) return opts.fallbackProbe;
    }
  }
  const result = await readResult(
    client,
    `/query/${opts.queryId}/results?limit=${opts.bounds.maxResultRows}`,
    opts.bounds,
  );
  return parseCoverageProbe(result.rows, { probedAtMs: result.endedAtMs, fromCache: true });
}

/**
 * @typedef {object} DuneEnumeration
 * @property {CoverageProbe} probe
 * @property {CoverageAssessment} coverage
 * @property {Map<string, WalletEnumeration>} byWallet Keyed on the wallet, for every wallet the
 *   caller asked about — including ones never sent because their address was not base58-shaped, and
 *   ones the enumeration returned no row for. Neither is a reading of "this wallet created
 *   nothing": both are `usable: false`, and the walk answers for them.
 * @property {number} unreadableRows Rows the parser could not read. **Any non-zero value refuses the
 *   whole batch** — see {@link parseCreationRows}.
 * @property {number} rowsReturned
 * @property {number} walletsRefusedByShape How many candidates were dropped from the query parameter
 *   for not matching {@link WALLET_SHAPE}. Counted rather than silently narrowing the batch.
 * @property {number} launchCap The per-deployer row cap this batch applied — {@link
 *   launchCapPerWallet} over the wallets actually sent. `0` when nothing was sent.
 * @property {number} walletsRefusedByLaunchCap How many candidates the cap truncated and are STILL
 *   refused once the oversized split has run. The number that says the batch-level ceiling did NOT
 *   fire: these wallets take the walk and everyone else keeps their Dune answer. Read it beside
 *   {@link OversizedSplitOutcome}`.walletsRecovered` — before decision 196a the two were the same
 *   count by construction, and they no longer are.
 * @property {OversizedSplitOutcome} oversizedSplit What the split did, what it cost and what it did
 *   NOT reach. Present on every run, `attempted: false` when nothing was truncated.
 */

/**
 * @typedef {object} OversizedSplitOutcome
 * @property {boolean} attempted   Whether any wallet was cap-truncated at all.
 * @property {number} executions   Follow-up executions actually spent. Each is billed.
 * @property {number} rowsReturned Rows those executions returned, summed.
 * @property {number} resultBytes  Bytes those executions returned, summed — the split's own marginal
 *   share of the bill, separable from the first execution's rather than apportioned from a run total.
 * @property {number} walletsTruncated How many the first execution's cap truncated — the "before".
 * @property {number} walletsRecovered How many of them a follow-up execution then enumerated whole
 *   AND that are usable afterwards.
 * @property {number} walletsStillRefused How many remain refused. **State this number**: the split
 *   removes one refusal class and cannot remove any other, and a report quoting only the recovery
 *   would read as though the blackout had closed.
 * @property {{ wallet: string, declaredLaunches: number | null, reason: string }[]} unplaced Wallets
 *   no follow-up execution was issued for, each with its whole sentence.
 * @property {{ wallets: string[], launchCap: number, expectedRows: number, rowsReturned: number | null,
 *   resultBytes: number | null, refused: string | null }[]} groups One entry per planned follow-up
 *   execution, in issue order, naming the wallets it asked about — the same granularity `unplaced`
 *   carries, so a reader can see which billed execution answered for which wallet rather than only
 *   how many there were. `resultBytes` is that execution's own share of the bill: results are ~71% of
 *   it at ~20 credits/MB, so a split's marginal cost is readable per execution rather than only as a
 *   run total apportioned after the fact.
 * @property {string | null} stopped Why the split stopped early, or `null`. A follow-up execution
 *   that fails is billed and is NOT retried, exactly like the first one.
 * @property {string} note {@link OVERSIZED_SPLIT} — carried on the outcome so a reader meeting a
 *   still-refused oversized wallet learns the split ran and did not reach it, rather than that no
 *   such thing exists.
 */

/**
 * A whole batch refused before a single request, in the shape a caller already knows how to read.
 *
 * Every wallet comes back `usable: false` with the reason, because "fall back to the walk" is one of
 * this module's answers and a wallet must never be reported as having created nothing. The synthetic
 * probe says what it is: nothing was probed, so `fromMs`/`toMs` are `null` — which means covered
 * NOTHING, never "since the epoch".
 *
 * @param {readonly string[]} wallets
 * @param {readonly string[]} reasons
 * @returns {DuneEnumeration}
 */
function refusedEnumeration(wallets, reasons) {
  /** @type {CoverageProbe} */
  const probe = { tables: [], probedAtMs: null, fromCache: false };
  /** @type {CoverageAssessment} */
  const coverage = { ok: false, fromMs: null, toMs: null, reasons: [...reasons], holes: [], staleOnly: false };
  /** @type {Map<string, WalletEnumeration>} */
  const byWallet = new Map();
  for (const wallet of wallets) {
    byWallet.set(
      wallet,
      toWalletEnumeration({
        wallet,
        launches: [],
        declaredLaunches: null,
        launchCap: null,
        batchWallets: 0,
        coverage,
        priorReasons: [...reasons],
      }),
    );
  }
  return {
    probe,
    coverage,
    byWallet,
    unreadableRows: 0,
    rowsReturned: 0,
    walletsRefusedByShape: 0,
    launchCap: 0,
    walletsRefusedByLaunchCap: 0,
    oversizedSplit: {
      attempted: false,
      executions: 0,
      rowsReturned: 0,
      resultBytes: 0,
      walletsTruncated: 0,
      walletsRecovered: 0,
      walletsStillRefused: 0,
      unplaced: [],
      groups: [],
      stopped: null,
      note: OVERSIZED_SPLIT,
    },
  };
}

/**
 * This leg's spend, stated in the unit the monthly credit ceiling is denominated in.
 *
 * It prices the CEILINGS, not the expected run — `dune.maxExecutionsPerRun` executions at the pinned
 * worst case, plus one result read each and one of headroom, every read at `?limit=maxResultRows`
 * rows of at most `resultBytesPerRowCeiling` bytes. Expected and worst case differ by more than an
 * order of magnitude here (a measured run is ~20 credits against a worst case near 200), and pricing
 * the worst case is the same discipline the Helius leg already applies: a plan is admissible when
 * its worst case fits, so the ceiling is exact rather than usually-right. Refusing a run that would
 * have cost 20 credits because it COULD have cost 200 falls back to the RPC walk, which is slower
 * rather than wrong; the alternative is dying at the second execution with the month gone.
 *
 * @param {{ maxExecutionsPerRun: number, maxResultRows: number, worstCaseCreditsPerExecution: number,
 *   resultBytesPerRowCeiling: number }} bounds
 * @returns {import('./client.mjs').DuneSpendPlan}
 */
export function duneSpendPlan(bounds) {
  return {
    lane: 'tools/deployer-screen',
    executions: bounds.maxExecutionsPerRun,
    creditsPerExecution: bounds.worstCaseCreditsPerExecution,
    // One result read per execution plus the cached coverage probe, which is a read and no execution.
    resultReads: bounds.maxExecutionsPerRun + 1,
    rowsPerRead: bounds.maxResultRows,
    bytesPerRow: bounds.resultBytesPerRowCeiling,
  };
}

/**
 * @typedef {'enumeration' | 'entry'} DuneLeg A leg of one run that may spend Dune credits.
 */

/**
 * THE ORDER THE RUN'S DUNE LEGS RESERVE IN — **cheapest and most necessary first.**
 *
 * `enumeration` is Stage 1's creation history: ONE execution for the whole candidate batch, and the
 * thing a run exists to do. `entry` is Stage 2's fill source: billed PER WINDOW, optional, and dark
 * until the Gate 3 cutover. Spending the second before the first has reserved is how a run comes to
 * consume the period on the leg it could have gone without and then refuse over the leg it could
 * not — which the RPC-walk spend cliff turns into a refusal AFTER the bill.
 *
 * It is an ARRAY rather than two booleans because the order is the property: a third spending leg
 * gets a position in it, and everything downstream keeps working without learning its name.
 *
 * @type {readonly DuneLeg[]}
 */
export const DUNE_LEG_ORDER = ['enumeration', 'entry'];

/**
 * ONE RESERVATION FOR THE WHOLE RUN, DRAWN ON BY EVERY LEG THAT SPENDS DUNE CREDITS (captain
 * decision 320a), **IN A DECLARED ORDER**.
 *
 * **The defect it closes is time-of-check-to-time-of-use, and it arrived the moment a second leg
 * started spending.** Stage 2's entry fill source and the Stage 1 enumeration each read `POST /usage`
 * and each decided alone, so two verdicts computed from the SAME balance could both say "this fits"
 * while their COMBINED worst case did not — at ~1,500 credits remaining, a ~1,211-credit entry leg
 * and a ~292-credit enumeration both pass and together overrun. The estimate artefact already states
 * the principle that breaks: **a balance reading is never a reservation.**
 *
 * **So the balance is read ONCE and every subsequent leg is priced against what is left AFTER the
 * ones already approved.** A cleared plan's worst case is held immediately — before it has spent
 * anything — because the question is whether the run as a whole can afford itself, and a leg that
 * has been told it may spend is a leg that will. That is one mechanism rather than two guards taught
 * to subtract each other's worst case, which is captain decision 144a's defect wearing an
 * arithmetic's clothes.
 *
 * **The reading is cached even when it FAILED.** A second read after a transport failure would be a
 * second answer to one question, and the run would then hold two different beliefs about a balance
 * it could not see. An unreadable balance refuses every leg, once.
 *
 * **RESERVATION ORDER IS A RULE THIS LEDGER ENFORCES, NOT WHATEVER THE CONTROL FLOW HAPPENED TO DO:
 * the CHEAP MANDATORY leg reserves before the EXPENSIVE OPTIONAL one spends.** 320a made both legs
 * draw on one reservation; it did not change which of them reserved FIRST, and the control flow put
 * the wrong one there. Stage 2's entry fill source was built before Stage 1 enumerated, so it
 * reserved first, BILLED its trade-coverage result read, and only then was the enumeration priced
 * against what was left. An enumeration priced out there falls back to the RPC walk, and
 * `priceWalkFallbackCliff` refuses the whole run before its first walk request — so the run ended
 * having paid the OPTIONAL leg and produced nothing at all. Under the captain's Dune account
 * controls that is not a money loss: extra credits are capped at $0, so the vendor REFUSES at the
 * ceiling rather than billing past it, and a period consumed by a leg whose run then refused is a
 * period that cannot check candidates. **{@link DUNE_LEG_ORDER} states the order**, and a leg whose
 * predecessors have not SETTLED — reserved, whatever the verdict, or declared not to spend — is
 * refused before the free balance read, let alone a billed one.
 *
 * **A PRIVATE LEDGER HAS NO PREDECESSORS TO WAIT FOR, by definition.** `checkDuneAllowance` opens
 * one when a caller hands in none, and that means "this is the only leg of this run that spends" —
 * so it is opened with every earlier leg already settled and the single-leg behaviour is exactly
 * what it was. The order can only bind a run that actually has two legs.
 *
 * **WHAT IT STILL CANNOT DO, and the three caveats travel with every verdict unchanged:** the
 * vendor's counter LAGS, so a reading over-states what remains and `allowanceReserveCredits` is held
 * back for it; the key is UNSHARED but the ACCOUNT is one and every lane of this fleet draws on the
 * same monthly total, so a sufficient reading is evidence and never a guarantee; and the period is a
 * subscription ANNIVERSARY rather than a calendar month. The operator's own fleet-wide cap (captain
 * decision 322a) narrows the ceiling a leg is priced against; it does not make a reading firmer. A ledger
 * makes ONE RUN self-consistent. It cannot reserve against a sibling lane, and nothing here pretends
 * otherwise.
 *
 * @param {{ soleLeg?: DuneLeg }} [opts] `soleLeg` opens the ledger with every leg BEFORE that one
 *   already settled, which is what "this is the only leg of this run that spends" means. Absent, no
 *   leg is settled and the order below binds from the first reservation.
 * @returns {DuneCreditLedger}
 */
export function openDuneCreditLedger(opts = {}) {
  /** @type {import('./client.mjs').UsageReading | null} */
  let reading = null;
  let reserved = 0;
  /** @type {Set<DuneLeg>} */
  const settled = new Set(
    opts.soleLeg === undefined ? [] : DUNE_LEG_ORDER.slice(0, DUNE_LEG_ORDER.indexOf(opts.soleLeg)),
  );

  /**
   * IS IT THIS LEG'S TURN? Refused BEFORE the free balance read, so a leg jumping the queue costs
   * not one request of any kind.
   *
   * @param {DuneLeg} leg
   */
  const assertItsTurn = (leg) => {
    const at = DUNE_LEG_ORDER.indexOf(leg);
    if (at === -1) {
      throw new Error(
        `a Dune spending leg declared itself "${String(leg)}", which is not one of this run's known ` +
          `legs (${DUNE_LEG_ORDER.join(', ')}). A leg the reservation order does not know cannot be ` +
          `placed in it, and placing it anyway would be a guess about which leg may spend first. ` +
          `Nothing was requested and nothing was billed.`,
      );
    }
    const pending = DUNE_LEG_ORDER.slice(0, at).filter((l) => !settled.has(l));
    if (pending.length === 0) return;
    throw new Error(
      `the "${leg}" leg tried to reserve Dune credits before ${pending.map((l) => `"${l}"`).join(' and ')} ` +
        `had settled. The mandatory leg reserves FIRST BY RULE: building the entry fill source bills ` +
        `a trade-coverage result read, and a run that paid it and then priced the enumeration out ` +
        `falls back to the RPC walk, where the spend cliff refuses the whole run — leaving the ` +
        `period consumed and nothing produced. A leg that will not spend must say so ` +
        `(declineToSpend) rather than being skipped. Nothing was requested and nothing was billed.`,
    );
  };

  return {
    reservedCredits: () => reserved,
    settledLegs: () => [...settled],
    declineToSpend(leg) {
      assertItsTurn(leg);
      settled.add(leg);
    },
    async reserve(client, input) {
      assertItsTurn(input.leg);
      // SETTLED BY ASKING, not by being cleared. A refused leg has had its answer, and the leg
      // behind it must not be held up waiting for a verdict that will never change.
      settled.add(input.leg);
      const plan = input.plan;
      const estimate = estimatePlanCredits(plan);
      if (reading === null) reading = await readUsageOnce(client, input.nowMs);
      const held = reserved;
      const decision = decideAllowance({
        plan,
        estimate,
        // THE RESERVATION ITSELF: what an earlier leg was cleared to spend is subtracted before this
        // one is compared, so the balance a second leg sees is the balance a second leg may have.
        allowance: reading.allowance === null ? null : netOfReservations(reading.allowance, held),
        unreadableReasons: reading.reasons,
        reserveCredits: input.bounds.allowanceReserveCredits,
        // Passed straight through rather than defaulted: an absent pin arrives as `undefined` and
        // `decideAllowance` refuses it, which is captain decision 322a's whole point. A `?? null`
        // here would turn a config the operator forgot to write into a lane with no cap at all.
        monthlyCapCredits: input.bounds.monthlyCreditCapCredits,
        tightMultiple: input.bounds.allowanceTightMultiple,
        allowanceRequired: input.bounds.allowanceRequired,
      });
      if (decision.ok) reserved = round3(held + estimate.worstCaseCredits);
      return {
        plan,
        estimate,
        allowance: reading.allowance,
        decision:
          held === 0
            ? decision
            : {
                ...decision,
                reasons: [
                  ...decision.reasons,
                  `${held} credit(s) of this period's balance are already held by an earlier leg of ` +
                    `this same run and were subtracted before the comparison above. The vendor has ` +
                    `not been billed for them yet; a run that cleared two legs against one unreduced ` +
                    `reading could overrun the balance both were approved on.`,
                ],
              },
      };
    },
  };
}

/**
 * @typedef {object} DuneCreditLedger
 * @property {(client: import('./client.mjs').DuneClient, input: { plan: import('./client.mjs').DuneSpendPlan,
 *   bounds: { allowanceReserveCredits: number, monthlyCreditCapCredits: number,
 *     allowanceTightMultiple: number, allowanceRequired: boolean },
 *   nowMs: number, leg: DuneLeg }) => Promise<{ plan: import('./client.mjs').DuneSpendPlan,
 *   estimate: import('./client.mjs').DuneSpendEstimate,
 *   allowance: import('./client.mjs').DuneAllowance | null,
 *   decision: import('./client.mjs').AllowanceDecision }>} reserve
 * @property {() => number} reservedCredits What this run has already been cleared to spend.
 * @property {() => DuneLeg[]} settledLegs Which legs have had their answer, in no particular order.
 * @property {(leg: DuneLeg) => void} declineToSpend This leg will spend NO Dune credit on this run,
 *   so the legs behind it may go. It is the only way past the order other than reserving, and it is
 *   deliberately explicit: a leg that is simply skipped leaves the ones behind it blocked, which
 *   fails towards refusing rather than towards spending.
 */

/**
 * The free balance read, with every failure yielding NO allowance rather than an optimistic one.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {number} nowMs
 * @returns {Promise<import('./client.mjs').UsageReading>}
 */
async function readUsageOnce(client, nowMs) {
  try {
    return parseUsageResponse(await client.readUsage(), nowMs);
  } catch (cause) {
    // The message carries a path and a body excerpt and never a credential — the key is a HEADER,
    // interpolated in exactly one place, so no URL or message this client builds can hold it.
    return {
      ok: false,
      allowance: null,
      reasons: [`POST /usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }
}

/**
 * One reading, net of what this run has already been cleared to spend.
 *
 * `creditsUsed` moves with `creditsRemaining` on purpose: `decideAllowance` prints the balance as a
 * sentence, and a reading whose two halves disagreed would report a period that does not add up. The
 * ledger's own reason line beside it is what says the difference is a HOLD rather than a bill.
 *
 * @param {import('./client.mjs').DuneAllowance} allowance
 * @param {number} held
 * @returns {import('./client.mjs').DuneAllowance}
 */
function netOfReservations(allowance, held) {
  return {
    ...allowance,
    creditsUsed: round3(allowance.creditsUsed + held),
    creditsRemaining: Math.max(0, round3(allowance.creditsRemaining - held)),
  };
}

/** @param {number} n @returns {number} */
function round3(n) {
  return Number(n.toFixed(3));
}

/**
 * Read the account's credit allowance and decide whether this leg may spend — **before the coverage
 * probe, which is itself a billed read**, and long before the execution.
 *
 * **Every failure yields no allowance rather than an optimistic one.** A transport failure, a vendor
 * refusal, a body this cannot parse: each means the balance is unknown, and {@link decideAllowance}
 * refuses an unknown balance while `dune.allowanceRequired` is true. The reading is free (Dune
 * documents `/usage` as a metadata endpoint consuming no credits) and is retried once inside the
 * client, so one hiccup does not decide a run cannot afford itself.
 *
 * **A SECOND LEG MAY SUPPLY ITS OWN PLAN, AND IT STILL GETS THIS ONE VERDICT.** Stage 2's entry fill
 * source executes per WINDOW where the enumeration answers a whole batch in one execution, so its
 * ceilings are different numbers in different keys — but "may this run spend" must have exactly one
 * answer, and a second reader of `POST /usage` beside a second `decideAllowance` would be two.
 * `dune-fills.mjs` → `tradeFillSpendPlan` builds that plan; everything below is shared unchanged,
 * and `input.bounds` then supplies only the three allowance policies.
 *
 * **AND A RUN WITH TWO SPENDING LEGS HANDS IN ITS LEDGER** (captain decision 320a). This function is
 * one reservation against {@link openDuneCreditLedger} — the whole of it, so there is ONE mechanism
 * and not two that agree. Without a ledger it opens a private one, which is the single-leg case and
 * is byte-identical to what it did before: one balance read, one verdict, nothing held. With one, the
 * legs share a reading and each is priced against what the earlier ones were cleared to spend — **in
 * {@link DUNE_LEG_ORDER}, which the ledger enforces**, so the optional leg cannot bill ahead of the
 * mandatory one's reservation.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {object} input
 * @param {{ maxExecutionsPerRun?: number, maxResultRows?: number, worstCaseCreditsPerExecution?: number,
 *   resultBytesPerRowCeiling?: number, allowanceReserveCredits: number, monthlyCreditCapCredits: number,
 *   allowanceTightMultiple: number, allowanceRequired: boolean }} input.bounds
 * @param {number} input.nowMs
 * @param {import('./client.mjs').DuneSpendPlan} [input.plan] The asking leg's own ceilings. Absent
 *   means the ENUMERATION's, priced from `input.bounds` by {@link duneSpendPlan} exactly as before.
 * @param {DuneCreditLedger} [input.ledger] The RUN's reservation. Absent means this is the only leg
 *   that spends, and a private ledger is opened for it — with every earlier leg already settled,
 *   because a sole leg has nothing to queue behind.
 * @param {DuneLeg} input.leg WHICH leg is asking. It is REQUIRED and has no default: the ledger
 *   enforces {@link DUNE_LEG_ORDER}, and a default would let a leg that forgot to name itself take
 *   another's place in the queue — which is the one direction this guard exists to refuse.
 * @returns {Promise<{ plan: import('./client.mjs').DuneSpendPlan,
 *   estimate: import('./client.mjs').DuneSpendEstimate,
 *   allowance: import('./client.mjs').DuneAllowance | null,
 *   decision: import('./client.mjs').AllowanceDecision }>}
 */
export async function checkDuneAllowance(client, input) {
  const plan =
    input.plan ??
    duneSpendPlan(
      /** @type {{ maxExecutionsPerRun: number, maxResultRows: number, worstCaseCreditsPerExecution: number,
       *   resultBytesPerRowCeiling: number }} */ (input.bounds),
    );
  const ledger = input.ledger ?? openDuneCreditLedger({ soleLeg: input.leg });
  return ledger.reserve(client, { plan, bounds: input.bounds, nowMs: input.nowMs, leg: input.leg });
}

/**
 * Enumerate a whole candidate batch's creation histories in ONE execution.
 *
 * Batching is the cost model rather than a convenience: the scan cost is nearly independent of how
 * many wallets are in the filter — measured, 5 wallets and 20 wallets cost the same table scan — so
 * the per-deployer price falls as the batch grows. What scales is the bytes returned, which is why
 * the SQL selects six columns and no more, and why {@link CREATION_SQL} caps the rows ONE DEPLOYER
 * may contribute rather than letting a single spam wallet's history price the batch.
 *
 * **Every wallet asked about comes back with an answer, and "fall back to the walk" is one of the
 * answers.** A refused coverage probe, an unreadable row anywhere in the batch, an address that is
 * not base58-shaped, a history the per-deployer cap truncated, or no row for that wallet at all each
 * leave `usable: false` with a reason. None of them is ever reported as a launch history of zero.
 *
 * @param {import('./client.mjs').DuneClient} client
 * @param {object} opts
 * @param {readonly string[]} opts.wallets
 * @param {number} opts.creationQueryId
 * @param {number} opts.coverageQueryId
 * @param {boolean} opts.refreshProbe
 * @param {number} opts.nowMs
 * @param {import('./client.mjs').AllowanceDecision | null} [opts.allowance] The monthly credit
 *   ceiling's verdict from {@link checkDuneAllowance}. **A missing or refusing decision stops this
 *   function before its first request**, coverage probe included — the probe is a billed read, so
 *   "check the balance first" has to bind here and not only at the call site. `undefined` is treated
 *   exactly like a refusal: a caller that forgot to check has not established that it can afford
 *   this, which is the same evidence as an empty allowance.
 * @param {(note: string) => void} [opts.onProbeRefreshFailure] Announce a probe REFRESH execution that
 *   failed and was answered from the cache instead. See {@link readCoverageProbe}: the execution is
 *   billed and is never retried, and the free cached read is what keeps one failed probe from sending
 *   a whole batch to the walk. **At most ONE probe execution is ever issued per run, whichever order
 *   the two paths are reached in.** The staleness re-execution below is the one that could otherwise
 *   double-bill: `--dune-refresh-probe` that fails hands back a CACHED probe, and if that cache is also
 *   stale the staleness branch would re-execute the statement that just failed. It does not, because
 *   this function records the failure from the callback rather than reading `probe.fromCache`, which
 *   cannot distinguish a failed refresh from an ordinary cached read. That run ends at one billed
 *   execution, coverage refused, and every candidate carrying its own fallback reason.
 * @param {{ pollIntervalMs: number, maxPollAttempts: number, executionDeadlineMs?: number | undefined,
 *   maxResultRows: number,
 *   maxCoverageLagMs: number, maxOversizedExecutions?: number, maxOversizedRowsPerExecution?: number }} opts.bounds
 * @param {boolean} [opts.splitOversized] **Opt-IN, and deliberately so.** Captain decision 196a
 *   authorises the split; wiring it into `screen.mjs` also moves `thresholds.json` →
 *   `dune.maxExecutionsPerRun`, whose justification currently reads "one execution for the
 *   enumeration, and at most one more to re-execute the coverage probe … nothing else in a run may
 *   execute". A default that quietly spent that reserve would contradict a pinned reason rather than
 *   change it, so the caller says so and states its own budget. See {@link OVERSIZED_SPLIT}.
 * @returns {Promise<DuneEnumeration>}
 */
export async function enumerateCreations(client, opts) {
  // ---- THE MONTHLY CREDIT CEILING, AHEAD OF EVERY REQUEST THIS FUNCTION MAKES. ----------------
  // Before the probe, because the probe is a billed READ — results are ~71% of the bill at ~20
  // credits/MB — and a run that cannot afford its execution should not pay for the evidence that it
  // was allowed to try. `undefined` refuses exactly like a refusal does: not having checked is not
  // the same as having checked and been cleared, and the failure this whole guard exists to prevent
  // is a billed leg that dies partway with neither an answer nor the credits to retry.
  if (opts.allowance == null || !opts.allowance.ok) {
    const reasons =
      opts.allowance == null
        ? [
            'the Dune monthly credit allowance was never checked for this run, so this leg refused ' +
              'to spend. dune.mjs -> checkDuneAllowance is the check, and it runs before the ' +
              'coverage probe because the probe is itself a billed read.',
          ]
        : opts.allowance.reasons;
    return refusedEnumeration(opts.wallets, reasons);
  }

  // The probe FIRST, and its cost is a cached read. An enumeration executed against surfaces nobody
  // has bounded is the thing this module exists to refuse, so it is not spent before the bound is in
  // hand — and if the probe refuses, the execution is never issued at all.
  // Whether a REFRESH execution of the probe has already been issued and failed in this run. It is
  // recorded here rather than inferred from `probe.fromCache`, which cannot tell "cached because the
  // caller asked for the cache" apart from "cached because the refresh died" — and those two owe the
  // staleness branch opposite answers.
  let refreshExecutionFailed = false;
  /** @param {string} note */
  const onRefreshFailure = (note) => {
    refreshExecutionFailed = true;
    opts.onProbeRefreshFailure?.(note);
  };

  let probe = await readCoverageProbe(client, {
    queryId: opts.coverageQueryId,
    refresh: opts.refreshProbe,
    bounds: opts.bounds,
    onRefreshFailure,
  });
  let coverage = assessCoverage({ probe, nowMs: opts.nowMs, bounds: opts.bounds });

  // A cached probe that has simply gone cold is the ONE refusal asking again can fix, and it is the
  // ordinary consequence of defaulting to the cache. Re-executing it costs the second of the two
  // budgeted executions and keeps the default path self-healing; degrading a whole run to the RPC
  // walk because a free cached read was six hours old would trade ~1 credit for ~13 hours. Every
  // other refusal — a missing table, a month with no rows — asks the same question and gets the same
  // answer, so it is not retried.
  //
  // `!refreshExecutionFailed` is the load-bearing clause. `--dune-refresh-probe` whose execution
  // failed lands here holding a CACHED probe, and if that cache is also stale — the ordinary reason
  // an operator asks for a refresh in the first place — re-executing would be a RETRY of the failed
  // `DuneClient.execute`, which is the one call in this repository that is never retried on any
  // failure for any reason (`thresholds.json` -> `dune.$comment`). It would also spend the second of
  // the two budgeted executions, so the enumeration itself would then hit the ceiling and the whole
  // leg would die anyway, at two bills instead of one.
  if (!coverage.ok && coverage.staleOnly && probe.fromCache && !refreshExecutionFailed) {
    probe = await readCoverageProbe(client, {
      queryId: opts.coverageQueryId,
      refresh: true,
      bounds: opts.bounds,
      // The probe already in hand, so a FAILED re-execution does not spend a second billed read to
      // be handed back the very result that was judged stale a moment ago. It stays stale, the
      // coverage stays refused, and every candidate gets that refusal as its own reason.
      fallbackProbe: probe,
      onRefreshFailure,
    });
    coverage = assessCoverage({ probe, nowMs: opts.nowMs, bounds: opts.bounds });
  }

  // Shape-check BEFORE anything is spent. These addresses are vendor-supplied and land inside a
  // single-quoted SQL literal; see WALLET_SHAPE. A wallet that fails is dropped from the parameter
  // and refused like any other unusable reading — it does not vanish from the run, and it does not
  // narrow the batch silently.
  /** @type {string[]} */
  const askable = [];
  /** @type {Map<string, string[]>} */
  const priorReasons = new Map();
  for (const w of opts.wallets) {
    if (isEnumerableWallet(w)) askable.push(w);
    else {
      priorReasons.set(w, [
        `this candidate's address is not the base58 shape a Solana wallet has, so it was never put ` +
          `in the Dune query parameter — a vendor-supplied string is not allowed to reach a query ` +
          `language unchecked. The creation walk answers for it instead.`,
      ]);
    }
  }
  const walletsRefusedByShape = opts.wallets.length - askable.length;

  // The cap the SQL will apply, mirrored here so a refusal can name it. It is derived from the
  // DISTINCT wallets sent, because that is what the query's own `count(DISTINCT wallet)` counts —
  // the two arithmetics have to agree or the tool would report a cap the vendor did not apply.
  const batchWallets = new Set(askable).size;
  const launchCap = batchWallets === 0 ? 0 : launchCapPerWallet(batchWallets);

  /** @type {Map<string, WalletEnumeration>} */
  const byWallet = new Map();
  /** @type {(rowsByWallet: Map<string, DuneLaunch[]>, declaredByWallet: Map<string, number | null>, batchReasons: readonly string[]) => void} */
  const fill = (rowsByWallet, declaredByWallet, batchReasons) => {
    for (const w of opts.wallets) {
      byWallet.set(
        w,
        toWalletEnumeration({
          wallet: w,
          launches: rowsByWallet.get(w) ?? [],
          declaredLaunches: declaredByWallet.get(w) ?? null,
          launchCap: launchCap === 0 ? null : launchCap,
          batchWallets,
          coverage,
          priorReasons: [...(priorReasons.get(w) ?? []), ...batchReasons],
        }),
      );
    }
  };

  /** @type {OversizedSplitOutcome} */
  const oversizedSplit = {
    attempted: false,
    executions: 0,
    rowsReturned: 0,
    resultBytes: 0,
    walletsTruncated: 0,
    walletsRecovered: 0,
    walletsStillRefused: 0,
    unplaced: [],
    groups: [],
    stopped: null,
    note: OVERSIZED_SPLIT,
  };

  if (!coverage.ok || askable.length === 0) {
    fill(new Map(), new Map(), []);
    return {
      probe,
      coverage,
      byWallet,
      unreadableRows: 0,
      rowsReturned: 0,
      walletsRefusedByShape,
      launchCap,
      walletsRefusedByLaunchCap: 0,
      oversizedSplit,
    };
  }

  await assertSavedQueryMatches(client, opts.creationQueryId, CREATION_SQL);
  const result = await executeAndRead(
    client,
    opts.creationQueryId,
    { [DEPLOYERS_PARAM]: askable.join(',') },
    opts.bounds,
  );
  const { byWallet: rowsByWallet, declaredByWallet, unreadableRows } = parseCreationRows(result.rows);

  // A row that would not parse refuses the WHOLE batch. Not the wallet it belonged to: a row that
  // fails to parse commonly has no readable `deployer`, so the wallet whose history came back short
  // is exactly the one that cannot be named, and partial attribution would leave it gated on a
  // silently short history. See parseCreationRows.
  const batchReasons =
    unreadableRows === 0
      ? []
      : [
          `${unreadableRows} row(s) of the Dune answer could not be read, and a row that fails to ` +
            `parse commonly has no readable deployer — so the wallet whose history came back short ` +
            `cannot be named and the whole batch is refused. Every candidate in it takes the ` +
            `creation walk rather than being gated on what survived the parser.`,
        ];

  fill(rowsByWallet, declaredByWallet, batchReasons);

  // --- the oversized split, captain decision 196a ------------------------------------------------
  //
  // Everything needed to plan it was already paid for: `launches_total` says exactly how big each
  // truncated wallet is. What follows spends executions, so it is bounded by the budget the run
  // ALREADY has — `client.stats()` reports the ceiling `thresholds.dune.maxExecutionsPerRun` pins
  // and how much of it is gone — rather than by a new number of this module's invention. That
  // ceiling's own justification asks for a stated monthly arithmetic before it moves; the split
  // deliberately does not move it, so a run that wants deeper coverage raises it on purpose.
  /** @type {{ wallet: string, declaredLaunches: number | null }[]} */
  const truncated = [];
  for (const [w, e] of byWallet) if (e.truncatedByLaunchCap) truncated.push({ wallet: w, declaredLaunches: e.declaredLaunches });
  oversizedSplit.walletsTruncated = truncated.length;

  if (truncated.length > 0 && opts.splitOversized === true && unreadableRows > 0) {
    // A batch whose rows would not parse is already refused whole, and a follow-up execution asks
    // the same query the same way — it would very probably meet the same shape and buy a second
    // bill for it. The split does not spend into a run that cannot read its own answer.
    oversizedSplit.attempted = true;
    oversizedSplit.stopped =
      `the oversized split was not attempted: ${unreadableRows} row(s) of the first execution's ` +
      `answer could not be read, so the whole batch is already refused and a follow-up execution ` +
      `would ask the same query the same way. An execution is billed whether or not it succeeds.`;
  } else if (truncated.length > 0 && opts.splitOversized === true) {
    oversizedSplit.attempted = true;
    const spent = client.stats();
    const budget = Math.max(0, spent.executionCeiling - spent.executions);
    const allowed = Math.min(budget, opts.bounds.maxOversizedExecutions ?? budget);
    const plan = planOversizedSplit({
      wallets: truncated,
      maxExecutions: allowed,
      maxRowsPerExecution: opts.bounds.maxOversizedRowsPerExecution,
    });
    oversizedSplit.unplaced = plan.unplaced;

    const declaredByTruncated = new Map(truncated.map((t) => [t.wallet, t.declaredLaunches]));

    for (const [groupIndex, group] of plan.groups.entries()) {
      /** @type {{ wallets: string[], launchCap: number, expectedRows: number, rowsReturned: number | null, resultBytes: number | null, refused: string | null }} */
      const entry = {
        wallets: [...group.wallets],
        launchCap: group.launchCap,
        expectedRows: group.expectedRows,
        rowsReturned: null,
        resultBytes: null,
        refused: null,
      };
      oversizedSplit.groups.push(entry);
      let groupResult;
      try {
        // The saved query was verified against the committed text before the first execution of
        // this run and cannot have changed since, so it is not re-verified per group: that would
        // buy one request per group and prove nothing new.
        oversizedSplit.executions += 1;
        groupResult = await executeAndRead(
          client,
          opts.creationQueryId,
          { [DEPLOYERS_PARAM]: group.wallets.join(',') },
          opts.bounds,
        );
      } catch (cause) {
        // A follow-up execution is billed whether or not it succeeds and is NOT retried, exactly
        // like the first one. It refuses this group and stops the split; the wallets it would have
        // answered for keep the refusal they already had and take the walk, and every wallet the
        // first execution DID answer for keeps its Dune answer. Nothing here may abort the run:
        // the batch's own reading is already in hand and is not made worse by a follow-up failing.
        entry.refused = cause instanceof Error ? cause.message : String(cause);
        oversizedSplit.stopped =
          `the oversized split stopped after ${oversizedSplit.executions} follow-up execution(s): ` +
          `${entry.refused}`;
        // Every wallet the plan had seated in a LATER group is named here rather than left to be
        // inferred from a count: its execution was never issued, so it holds no answer of its own
        // and nothing else in this record would say so.
        for (const unissued of plan.groups.slice(groupIndex + 1)) {
          for (const wallet of unissued.wallets) {
            oversizedSplit.unplaced.push({
              wallet,
              declaredLaunches: declaredByTruncated.get(wallet) ?? null,
              reason:
                `this wallet's follow-up execution was planned but never issued, because an earlier ` +
                `follow-up execution of this split failed and a failed execution is billed and is ` +
                `never retried — so the split stopped rather than spending further. The creation ` +
                `walk answers for it.`,
            });
          }
        }
        break;
      }
      entry.rowsReturned = groupResult.rows.length;
      entry.resultBytes = groupResult.resultBytes;
      oversizedSplit.rowsReturned += groupResult.rows.length;
      oversizedSplit.resultBytes += groupResult.resultBytes;
      const parsed = parseCreationRows(groupResult.rows);
      // The whole-batch rule applies inside a group exactly as it does to the first execution, and
      // its blast radius is this group rather than the run: a row that will not parse commonly has
      // no readable deployer, so the wallet that came back short cannot be named.
      const groupReasons =
        parsed.unreadableRows === 0
          ? []
          : [
              `${parsed.unreadableRows} row(s) of this wallet's follow-up (oversized-split) Dune ` +
                `answer could not be read, and a row that fails to parse commonly has no readable ` +
                `deployer — so the wallet whose history came back short cannot be named and the ` +
                `whole follow-up execution is refused. The creation walk answers for it.`,
            ];
      for (const w of group.wallets) {
        byWallet.set(
          w,
          toWalletEnumeration({
            wallet: w,
            launches: parsed.byWallet.get(w) ?? [],
            declaredLaunches: parsed.declaredByWallet.get(w) ?? null,
            launchCap: group.launchCap,
            batchWallets: group.wallets.length,
            coverage,
            priorReasons: [...(priorReasons.get(w) ?? []), ...groupReasons],
          }),
        );
      }
    }
  }

  let walletsRefusedByLaunchCap = 0;
  for (const e of byWallet.values()) if (e.truncatedByLaunchCap) walletsRefusedByLaunchCap += 1;
  for (const w of truncated) {
    const after = byWallet.get(w.wallet);
    if (after !== undefined && after.usable) oversizedSplit.walletsRecovered += 1;
    else oversizedSplit.walletsStillRefused += 1;
  }
  return {
    probe,
    coverage,
    byWallet,
    unreadableRows,
    rowsReturned: result.rows.length,
    walletsRefusedByShape,
    launchCap,
    walletsRefusedByLaunchCap,
    oversizedSplit,
  };
}

// --- the whole-leg failure, and the spend cliff behind it (captain decision 298a) ---------------

/**
 * The marker every whole-LEG fallback reason starts with, so a reader — or a script — can separate
 * "Dune answered and refused THIS wallet" from "Dune answered for nobody".
 *
 * The two are different findings about different things and they were indistinguishable in a record
 * until now: a per-wallet refusal is evidence about that wallet, and a leg failure is evidence about
 * the run. See {@link walkFallbackReasons}.
 *
 * **IT KEYS ON THE LEG ANSWERING FOR NOBODY, NEVER ON THIS WALLET BEING UNUSABLE, AND EVERY
 * WHOLE-BATCH CLASS CARRIES IT** (captain decision 312a). A thrown execution leaves no per-wallet
 * sentence, but a refused coverage probe, a refused credit allowance and an unreadable row each
 * refuse the WHOLE batch while giving every wallet the same run-level sentence — so keying on "this
 * wallet produced no reason of its own" would have marked the thrown class alone and left a script
 * counting whole-leg failures short by every other one. Where a wallet has its own sentence too, the
 * marker is PREPENDED rather than substituted: the leg answering for nobody and the specific refusal
 * are both true, and a reader needs both.
 *
 * **THE TOKEN SAYS "FAILED"; THE PROSE AROUND IT DOES NOT** (captain decision 313a). Two of the
 * classes it now covers — a coverage probe that would not vouch for its surfaces, a credit allowance
 * that refused before the first request — are deliberate, correct refusals rather than failures, so
 * the sentence states what is true of every class: the leg answered for NO candidate in this batch.
 * The token itself is unchanged, because it is the machine-readable key a script filters on.
 */
export const DUNE_LEG_FAILED = 'dune-leg-failed';

/**
 * Why a candidate took the creation walk, as sentences that reach the run record.
 *
 * **THE DEFECT THIS CLOSES, from `runs/2026-08-04.json`.** The Dune leg died whole — the coverage
 * probe's execution ended `QUERY_STATE_FAILED` — and every one of the 82 candidates walked. The
 * failure was recorded ONCE, at run level, in a prose note; every candidate's `duneFallbackReasons`
 * read **empty**, which is also exactly what a candidate looks like when Dune was never consulted at
 * all. A reader scanning that record sees 82 unexplained walks, and a per-candidate cost model built
 * from it describes the DEGRADED path while looking like the normal one — which is what happened, at
 * roughly three orders of magnitude.
 *
 * So the rule is: **while the Dune leg was ATTEMPTED, a candidate that did not get a usable Dune
 * reading always carries a reason.** `attempted: false` — no key, `--no-dune`, `--ownership-only` —
 * is the one case that yields an empty list, and there the walk is the route the operator chose
 * rather than a fallback anything took.
 *
 * **WHICH FACT THE MARKER KEYS ON** (captain decision 312a): `legAnsweredForNobody`, which the caller
 * computes ONCE from the leg's own result and hands to every candidate. Not "this wallet has no
 * sentence of its own" — that is true only of a thrown execution, and a coverage refusal, an
 * allowance refusal and an unreadable row are equally whole-batch while each giving every wallet the
 * same run-level sentence. Not "this wallet is unusable" either: a wallet the probe refused while the
 * leg ANSWERED for others is a per-WALLET refusal and gets its own reasons with no marker. Where both
 * are true the marker is PREPENDED to the wallet's own reasons rather than replacing them.
 *
 * **AND NO SENTENCE APPEARS TWICE IN THE RETURNED LIST** (captain decision 313a). `legFailure` is
 * embedded in the marker only where the wallet carries no reason of its own — the thrown-execution
 * shape, where the vendor's message exists nowhere else. Where the wallet does carry one, the marker
 * points at it instead of restating it, because every non-thrown whole-batch class hands the SAME
 * run-level sentence to every wallet and duplicating it scales with the batch.
 *
 * @param {object} input
 * @param {boolean} input.attempted Whether this run reached the Dune leg for this batch at all.
 * @param {{ usable: boolean, reasons: readonly string[] } | null} input.reading This wallet's own
 *   enumeration, or `null` when the leg produced none for it.
 * @param {string | null} input.legFailure The whole-leg failure's own sentence, or `null`.
 * @param {boolean} [input.legAnsweredForNobody] Whether the leg produced a usable reading for NO
 *   candidate in the batch. Defaults to `true` when the wallet has no reason of its own, which is the
 *   thrown-execution shape and the only one that can be inferred here.
 * @returns {string[]}
 */
export function walkFallbackReasons(input) {
  if (!input.attempted) return [];
  if (input.reading !== null && input.reading.usable) return [];
  const own = input.reading === null ? [] : [...input.reading.reasons];
  const wholeLeg = input.legAnsweredForNobody ?? own.length === 0;
  if (!wholeLeg) return own;
  // The leg answered for nobody. Everything below is one sentence rather than a blank, because a
  // blank here is the whole defect: it is indistinguishable from a run that never asked Dune.
  //
  // NO SENTENCE IS WRITTEN TWICE (captain decision 313a). The vendor's own words are embedded only
  // when the wallet does NOT already carry them: a thrown execution leaves `own` empty and its
  // message nowhere else, so an operator who paid for a failed execution must not have to go and ask
  // Dune what it objected to. Every other whole-batch class puts the same run-level sentence on every
  // wallet, so splicing the first one in here as well duplicated it in `own` — ~390 copies of one
  // paragraph in a 195-candidate record, and twice per candidate on the console.
  const closing =
    input.legFailure !== null && input.legFailure.trim() !== ''
      ? `The failure: ${input.legFailure.trim()}`
      : own.length > 0
        ? `Why it answered for nobody: see this candidate's own reason below.`
        : `No reason survived from the leg itself.`;
  return [
    `${DUNE_LEG_FAILED}: the Dune enumeration leg answered for NO candidate in this batch, so this ` +
      `wallet's history was walked from the Solana signature index instead. That is the correct ` +
      `answer to a Dune refusal and it is not a weaker measurement — it is a far more expensive one, ` +
      `and it is recorded per candidate so a cost model built from this record cannot read the ` +
      `degraded route as the normal one. ${closing}`,
    ...own,
  ];
}

/**
 * @typedef {object} WalkFallbackCliff
 * @property {number} candidates      Candidates that must now take the walk.
 * @property {number} baselineCandidates How many of them a HEALTHY Dune leg would have sent to the
 *   walk anyway, at the pinned share. Never below 1, so the multiple is always defined.
 * @property {number} minCandidates   The magnitude floor this pricing applied. Below it `cliff` is
 *   `false` whatever `multiple` reads, so the two must be read together.
 * @property {number} projected       This run's new worst case, in {@link WalkFallbackCliff.unit}.
 * @property {number} baseline        The worst case the Dune-primary plan was made against.
 * @property {number} multiple        `projected / baseline`, i.e. `candidates / baselineCandidates`.
 * @property {boolean} cliff          Whether the multiple is past the pinned one.
 * @property {string} unit            Singular name of the unit both figures are in.
 * @property {number} perCandidate    The per-candidate ceiling both figures were priced at.
 */

/**
 * Price what a WHOLE-BATCH Dune fallback does to this run's worst case, in the walk's own unit.
 *
 * **Why this exists as a refusal rather than a log line.** The Dune path is primary (captain decision
 * 156a) and is roughly two orders of magnitude cheaper per candidate than its own fallback, so a
 * whole-batch fallback is a CLIFF and not a gradient — measured, from records committed in this repo:
 * the 2026-08-05 untiered leg lost its Dune answer and spent **232,937 Helius credits over 76
 * candidates**, against **1,924 over 69** and **21,733 over 59** for the two legs that kept theirs.
 * The tool's design intent — a Dune refusal is "slower, never wrong" — is true about correctness and
 * false about spend, and the pre-flight credit ceiling does not fire, because it was sized for the
 * walk being the INTENDED route and therefore already reserves every candidate walking.
 *
 * **The arithmetic is one expression evaluated twice, and only the candidate count differs.** The
 * baseline is what the plan was made against: a healthy Dune leg still sends some candidates to the
 * walk, one wallet at a time, at `healthyWalkShare` — so the baseline is that share of the batch and
 * the projection is the whole batch. Both are priced at the same per-candidate ceiling, so the
 * multiple is a ratio of candidate counts and the unit cancels; what the unit decides is only what
 * the printed figures MEAN, which is why it is named on the result.
 *
 * **A CLIFF IS A MAGNITUDE AS WELL AS A RATIO, AND THE MAGNITUDE IS ITS OWN PINNED FLOOR RATHER THAN
 * SOMETHING `ceil` IMPLIES.** The baseline rounds up to at least one candidate, which makes the
 * multiple move in bands as the batch grows — and those bands are NOT monotone near the bottom: at the
 * pinned share and multiple a batch of 5, 6 or 7 would read 5.0x, 6.0x and 7.0x and fire, while a
 * batch of 8 reads exactly 4.0x and would not, so the smaller and cheaper run would be the one
 * refused. `minCandidates` removes that band outright: below it the answer is no cliff, whatever the
 * ratio says. Captain decision 308a, and it introduces NO new anchor — the value is the one
 * `thresholds.json` → `dune.justification.legFallbackCliffMultiple` already publishes, "a batch of 8 or
 * fewer is at most 4x and proceeds, and the guard first bites at 9 candidates". From the floor up the
 * guard IS monotone: the smallest multiple in each band is 16/3, 23/4, 31/5 … rising towards
 * `1 / healthyWalkShare`, so once it fires it fires at every larger batch.
 *
 * @param {object} input
 * @param {number} input.candidates       Candidates that must now walk.
 * @param {number} input.healthyWalkShare `thresholds.json` → `dune.legFallbackHealthyWalkShare`.
 * @param {number} input.cliffMultiple    `thresholds.json` → `dune.legFallbackCliffMultiple`.
 * @param {number} input.minCandidates    `thresholds.json` → `dune.legFallbackMinCandidates`. The
 *   magnitude floor: a batch smaller than this is never a cliff, however large its ratio.
 * @param {number} input.perCandidate     The walk's own per-candidate ceiling, in `unit`.
 * @param {string} input.unit             Singular unit name, e.g. `'Helius credit'`.
 * @returns {WalkFallbackCliff}
 */
export function priceWalkFallbackCliff(input) {
  const candidates = Math.max(0, Math.floor(input.candidates));
  const perCandidate = Math.max(0, input.perCandidate);
  const minCandidates = Math.max(0, Math.floor(input.minCandidates));
  const baselineCandidates = Math.max(1, Math.ceil(candidates * Math.max(0, input.healthyWalkShare)));
  const multiple = candidates === 0 ? 0 : candidates / baselineCandidates;
  return {
    candidates,
    baselineCandidates,
    minCandidates,
    projected: candidates * perCandidate,
    baseline: baselineCandidates * perCandidate,
    multiple,
    cliff: candidates >= minCandidates && candidates > 0 && multiple > input.cliffMultiple,
    unit: input.unit,
    perCandidate,
  };
}

/**
 * The refusal an operator reads, or the authorisation they already gave, as whole lines.
 *
 * It states the NEW worst case before anything is spent — that is the point of refusing here rather
 * than reporting afterwards — and it names the flag rather than describing it, so the next invocation
 * is a copy rather than a guess.
 *
 * @param {WalkFallbackCliff} cliff
 * @param {object} opts
 * @param {boolean} opts.authorised Whether `--allow-walk-fallback` was passed.
 * @param {number} opts.cliffMultiple The pinned multiple, for the sentence.
 * @param {string} opts.flag The opt-in flag's own spelling.
 * @returns {string[]}
 */
export function describeWalkFallbackCliff(cliff, opts) {
  const head = `${cliff.candidates} candidate(s) now take the creation walk, where a run whose Dune leg answered would have sent about ${cliff.baselineCandidates}.`;
  const money =
    `Worst case for this run's enumeration: ${cliff.projected.toLocaleString('en-US')} ${cliff.unit}(s), ` +
    `against ${cliff.baseline.toLocaleString('en-US')} for the plan that was made — ` +
    `${cliff.multiple.toFixed(1)}x, past the pinned ${opts.cliffMultiple}x ` +
    `(thresholds.json -> dune.legFallbackCliffMultiple).`;
  if (opts.authorised) {
    return [
      `THE DUNE LEG ANSWERED FOR NOBODY AND ${opts.flag} AUTHORISED THE WALK.`,
      `  ${head}`,
      `  ${money}`,
      '  The walk is the CORRECT answer to a Dune refusal — it is the only surface that can say who ' +
        'holds a curve today — so this is a spend decision, not a correctness one.',
    ];
  }
  return [
    'Refusing to continue: the Dune enumeration leg answered for NO candidate, and the fallback is a',
    'spend cliff rather than a slower road.',
    `  ${head}`,
    `  ${money}`,
    '  The walk is the CORRECT answer to a Dune refusal and nothing here distrusts it. What is refused',
    '  is taking a decision of this size silently, on a plan the operator approved for a different route.',
    `  Re-run with ${opts.flag} to take the walk anyway, or with --no-dune to plan for it from the start.`,
    '  The seed enumeration requests are already spent and the Dune leg was billed for whatever it',
    '  reached. The gate loop had not started, so no candidate profile was fetched and no Helius credit',
    '  and no Solana RPC request was spent — which is the whole reason this is asked here.',
  ];
}

/**
 * The one sentence a REFUSED whole-batch fallback puts on the run record, as an abort reason.
 *
 * **The refusal files an incomplete record rather than exiting bare** (captain decision 310a), for
 * the reason `screen.mjs`'s own catch block states: a terminal path reached after vendor spend must
 * not discard paid-for measurements, or re-running just spends the shared allowance a second time to
 * learn the same thing. By this point the seed enumeration is sunk and the Dune leg has been billed
 * for its probe read — and, on `--dune-refresh-probe`, for a failed execution — so the run-level Dune
 * block and the seed coverage are exactly the state worth keeping.
 *
 * It is an ABORT reason and not a new record field: `record.mjs` → `deriveTruncation` turns it into
 * the run's `truncationReason` and the run reports `completed: false`, which is what keeps a
 * zero-candidate record from reading as a screen that found nothing. `RECORD_SCHEMA_VERSION` does not
 * move — a refusal is not a new contract.
 *
 * @param {WalkFallbackCliff} cliff
 * @param {object} opts
 * @param {number} opts.cliffMultiple The pinned multiple, for the sentence.
 * @param {string} opts.flag The opt-in flag's own spelling.
 * @returns {string}
 */
export function walkFallbackRefusalReason(cliff, opts) {
  return (
    `the whole-batch Dune fallback was REFUSED before the first walk request: the Dune enumeration ` +
    `leg answered for no candidate, and the creation walk's worst case of ${cliff.projected.toLocaleString('en-US')} ` +
    `${cliff.unit}(s) over ${cliff.candidates} candidate(s) is ${cliff.multiple.toFixed(1)}x the plan ` +
    `that was made, past the pinned ${opts.cliffMultiple}x. No candidate was gated and no walk request ` +
    `was issued. Re-run with ${opts.flag} to take the walk anyway, or with --no-dune to plan for it ` +
    `from the start.`
  );
}

/**
 * Project a coverage probe onto the derived figures a run record may carry.
 *
 * `derive and discard`: the probe holds table-wide monthly counts, which are the vendor's data. What
 * a record keeps is the BOUND — which tables, from when, to when, how many months, and whether the
 * span had holes — because that is what a reader needs to know what the count was allowed to claim.
 *
 * @param {CoverageProbe} probe
 * @param {CoverageAssessment} coverage
 * @returns {object}
 */
export function coverageRecordRow(probe, coverage) {
  return {
    ok: coverage.ok,
    fromIso: coverage.fromMs === null ? null : new Date(coverage.fromMs).toISOString(),
    toIso: coverage.toMs === null ? null : new Date(coverage.toMs).toISOString(),
    probedAtIso: probe.probedAtMs === null ? null : new Date(probe.probedAtMs).toISOString(),
    fromCache: probe.fromCache,
    monthsWithNoRow: coverage.holes.map((h) => h.monthIso),
    reasons: coverage.reasons,
    // Every table the probe read, including the one the enumeration refuses. A reader who wants to
    // know WHY `call_create_v2` is not in the union can see its first row here rather than take the
    // module's word for it.
    tables: probe.tables.map((t) => ({
      table: t.table,
      read: ENUMERATION_TABLES.includes(t.table),
      firstRowIso: new Date(t.firstRowMs).toISOString(),
      lastRowIso: new Date(t.lastRowMs).toISOString(),
      rowsTotal: t.rowsTotal,
      months: t.months.length,
    })),
  };
}
