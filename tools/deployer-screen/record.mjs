/**
 * The run-record schema contract.
 *
 * Run records under `runs/` are **evidence**: the prediction-grading lane's declared input, and the
 * only durable trace of what a run measured. That makes them append-only in spirit — a committed
 * record is never retro-edited to fit a newer schema, because a lane whose whole purpose is grading
 * what past runs predicted cannot also be rewriting them.
 *
 * The cost of that is version skew, and this module owns it.
 *
 * ## Why `completed` is three-state and not a boolean
 *
 * `completed` was added in schema version 2. The first record we committed
 * (`runs/2026-07-29-elite.json`) predates it, so it has no such key — and it is a run that
 * **finished**, whose candidate cap merely dropped wallets it never gated.
 *
 * A consumer reading `record.completed` on that file gets `undefined`, which is falsy, which is
 * indistinguishable from `false` — so the naive read turns a completed run into an aborted one, and
 * grades a real measurement as a failure. The record cannot be fixed, so the *reader* is what has to
 * be correct.
 *
 * Hence {@link completenessOf}, which returns one of three values and never a boolean. A caller
 * cannot write `if (completed)` and be accidentally right; it has to say which of the three states
 * it is handling. **`unknown` must not be collapsed into `true` or `false`** — not by defaulting, and
 * in particular not by inferring from `truncated` or `truncationReason`, which describe *what is
 * missing* and not *whether the run reached the end*. The committed record is the proof of why:
 * `truncated: true` there means the cap bit, not that anything failed.
 *
 * ## The standing rule this module also enforces
 *
 * **A ceiling hit, an exhausted budget or a failed walk must never be recordable as a measured
 * result.** If the tool could not look, the record has to say it could not look. {@link
 * unmeasuredBecause} and {@link deriveTruncation} are the general form of that: any measurement pass
 * that draws on a budget routes its failures through them and inherits the truncation, rather than
 * each new budget needing its own special case that someone remembers to add.
 */

import { CeilingReached, RequestFailed, UnparseableResponse } from './client.mjs';

/**
 * Schema version of records this build writes.
 *
 * - **absent** — schema 1. Predates `completed`; completeness is unknowable from the record. It
 *   does carry `coverage`, so the presence of `coverage` is NOT evidence of schema 2 — the
 *   committed `runs/2026-07-29-elite.json` holds `coverageTruncated` and `droppedByCandidateCap`
 *   under schema 1. Read `coverage` on every record; version-detect on `completed`.
 * - **2** — adds `completed`, and only `completed`.
 * - **3** — adds `spend`: the keyed ceiling, what was left unspent, the planned worst case, and the
 *   endpoints actually called with each one's per-call cost. A schema-2 record carries only the
 *   `keyedRequests` total, so on those `spend` is genuinely absent and must not be reconstructed —
 *   the total cannot say which endpoint the requests went to. Also adds `unmeasured`: every
 *   measurement the run could not take and why, which `truncated` and `truncationReason` now
 *   account for. Its absence on an older record means unknown, not none.
 * - **4** — the gate reads a CREATION-derived launch history rather than an ownership-derived one.
 *   Candidate rows gain `historySource`, the `vendor*` fields holding the old reading whole, and
 *   `creation` holding the walk's coverage and bounds. A schema-1, schema-2 or schema-3 record's
 *   `tokens` and `completionRate` are the OWNERSHIP reading, which is biased in BOTH directions at
 *   once: its COUNTS reject (understating launches, and understating a bonded count by more) while
 *   its RATE inflates. **Do not compare them with a schema-4 `completionRate` as though they
 *   answered the same question**; compare against `vendorCompletionRate`, which is the same
 *   measurement the older records hold.
 * - **5** — Stage 2 stops scoring launches whose create slot carried no bundled transaction, and
 *   the `entry` block gains the three fields that make that visible: `launchesRoomUnproven`,
 *   `bundledTx` and `maxWalletsInOneTx`. **Two consequences for a reader of an older record.**
 *   First, `entry.launchesSampled` on schema 3 and 4 counts every measured window, including ones
 *   whose opening was unproven; on schema 5 it counts only the SCORED ones, and the refused ones
 *   are the new field beside it. Second, and this is the one that matters: a schema-3 or schema-4
 *   `entry.roomLeft` may be **inflated by the operation's own stake booked as outsider capital**,
 *   and the record carries nothing that could say by how much — which is precisely why the fields
 *   were added. No candidate row is a candidate row of a different shape, so
 *   `PERSISTED_BY_SCHEMA[5]` equals `[4]`; the candidate-row change is confined to `entry`.
 *   **The `stage0` block also changed, and it is not comparable across the boundary.** Stage 0 now
 *   filters its era buckets on the same rule, so `stage2SeamReproduction[].n` for era 2 moved
 *   **89 → 86** between schema 4 and schema 5 with no change to the tape — a schema-4 `n` counts
 *   every launch in the era, a schema-5 `n` counts only the scored ones. Each entry now carries
 *   `nRoomUnproven` for the refused remainder, and the block gains `rollingRoom`, the replay of the
 *   live entry recipe at every trailing window against the named cohort. Do not read a schema-4 and
 *   a schema-5 `stage2SeamReproduction` as answering the same question.
 * - **6** — **the fee is inside the entry window** (captain's ruling of 2026-08-02 and decision
 *   136b), and the eligibility filter became observable. Again no candidate field changes, so
 *   `PERSISTED_BY_SCHEMA[6]` equals `[5]`; everything is inside `entry`.
 *   **THE VERDICT VOCABULARY CHANGED, AND THIS IS THE ONE THAT WILL BITE A READER.**
 *   `entry-room-present` no longer exists. A schema-≤5 record's `entry-room-present` means *room
 *   was present and the price of the seat was never measured*; a schema-6 `entry-open-after-costs`
 *   means room was present, the seat was priced, and the field still cleared after paying for it.
 *   **They are not the same verdict and the older one must not be read as the newer.** Two new
 *   verdicts have no schema-≤5 equivalent at all: `entry-cost-unmeasured` (the free legs passed and
 *   the cost leg could not price enough of the field — terminal, and never a pass) and
 *   `entry-cost-prohibitive`. `entry-field-loss-making` survives but is now reachable from two
 *   places: gross, as before, and net of measured fees, which the older records could not compute.
 *   The `entry` block gains the cost distributions (`entryCostSol`, `entryCostPerSolStaked`,
 *   `entryCostPerSolStakedByLaunch`, `entryTxFeeSol`, `entryCostPriced`), the after-cost field
 *   figures
 *   (`fieldRealisedSolNetOfMeasuredFees`, `fieldReturnPerSolNetOfMeasuredFees`,
 *   `fieldHitRateNetOfMeasuredFees`, `fieldClosedRoundTripsPriced`) and, in `entry.coverage`, the
 *   eligibility counts (`minAgeMs`, `launchesTooYoung`, `launchesEligible`, `launchesPlanned`,
 *   `launchesDroppedByCap`, `youngestRefAgeMs`, `youngestEligibleAgeMs`) plus a `cost` block. That
 *   block separates what backs the score from what the run merely PAID FOR: `launchesPriced` and
 *   `transactionsPriced` count only pricing that reached the score, `launchesDiscarded` and
 *   `transactionsDiscarded` count work that was bought and then dropped whole (a launch the RPC
 *   ceiling cut short mid-walk, or the whole candidate on a transport failure), and `rpcRequests`
 *   spans both because it is the spend. So `launchesPriced > 0` beside an `entryCostPriced.hits` of
 *   `0` is a contradiction the record cannot express. On a
 *   schema-≤5 record `launchRefsAvailable` and `launchesAttempted` could not be told apart from the
 *   `maxLaunchesPerCandidate` cap, so **do not infer an eligibility count from an older record** —
 *   it is not in there. Every cost figure is a LOWER bound: an out-of-transaction landing tip is
 *   not recoverable from the entrant's own transaction, which the record states on the number
 *   itself in `entry.caveats`, not only here. **The `stage0` block gains
 *   `onChainCostReproduction`** — the offline cost regression in full, so a saved run says by how
 *   much and over what netting the measured fees moved the field, not only that it passed; the
 *   README's schema table lists its fields. **Its figures are over the UNFILTERED population** —
 *   every taped launch the committed table can price, proven opening or not. Schema 7 changes that
 *   and keeps the same key names, so the version is the only thing that tells the two apart.
 * - **7** — **`stage0.onChainCostReproduction`'s figures move to the GATED population**: launches
 *   whose create-slot opening is proven (`measure.mjs` → `roomIsProven`), which is the population
 *   `entry-cost-prohibitive` is itself computed from, so the regression guard now measures the
 *   quantity the bar reads rather than a neighbouring one. **The key names did not change**, so a
 *   schema-6 `launchesPriced: 113 / pairsPriced: 631` and a schema-7 `110 / 618` are the same keys
 *   over different populations and must not be compared as one series. Three new keys carry the
 *   unfiltered reading beside it — `includingUnprovenLaunchesPriced`, `includingUnprovenPairsPriced`
 *   and `includingUnprovenEntryCostPerSolStakedMedianByLaunch` — so a schema-7 record is
 *   self-describing rather than needing external context for which population it means; on the
 *   committed tape they read 113, 631 and 0.0388 against the gated 110, 618 and 0.0389, i.e. the
 *   unfiltered reading is the CHEAPER one, which is the optimistic direction. The block also gains
 *   `minEntryCostPositiveShare`, the floor `entryCostPositiveShare` is compared against, beside the
 *   `minLaunches`/`minPairs` bars already there — a saved figure with no stated bar cannot be
 *   audited. No candidate row, `entry` or `entry.coverage` key changes, so `PERSISTED_BY_SCHEMA[7]`,
 *   `ENTRY_KEYS_BY_SCHEMA[7]` and `ENTRY_COVERAGE_KEYS_BY_SCHEMA[7]` all equal `[6]`.
 * - **8** — **the `spend` block reports THREE budgets separately**, because the creation walk can now
 *   take a keyed indexed route. It gains `rpcProvider`, `rpcEndpoint`, `heliusCredits`,
 *   `heliusCreditCeilingPerCandidate` and `plannedWorstCaseHeliusCredits`. The reason they are five
 *   new keys rather than folded into the existing totals: MadeOnSol is metered in REQUESTS against a
 *   shared daily allowance, Helius in CREDITS against an unshared monthly one, and the keyless hosts
 *   in neither, and there is no exchange rate between them — a single "requests" total would hide
 *   which allowance a heavy run actually spent. `rpcEndpoint` holds the endpoint's LABEL and never
 *   the composed URL, which on the keyed route carries the credential in a query parameter;
 *   `credential.mjs` → `SolanaRpcEndpoint` owns that split and a test drives a sentinel-bearing URL
 *   through every failure path. On a schema-≤7 record these five keys are genuinely absent and must
 *   not be reconstructed: those runs predate the indexed route, so the walk was the keyless one and
 *   the record cannot say which host answered it. `heliusCredits: 0` with `rpcProvider: "public"` is
 *   a keyless run that spent no credit; `heliusCreditCeilingPerCandidate: null` means the indexed
 *   walk did not run at all. No candidate row, `entry` or `entry.coverage` key changes, so
 *   `PERSISTED_BY_SCHEMA[8]`, `ENTRY_KEYS_BY_SCHEMA[8]` and `ENTRY_COVERAGE_KEYS_BY_SCHEMA[8]` all
 *   equal `[7]`.
 * - **9** — **creation ENUMERATION is primary on Dune** (captain decision 156a). The record gains a
 *   run-level `dune` block — the coverage probe's own bounds, what it refused, and the Dune spend in
 *   executions, requests and estimated credits — and every candidate's `creation` block gains
 *   `enumerationSource`, `duneLaunches`, `duneFallbackReasons` and `creatorMovementUnmeasured`.
 *   **The one that will bite a reader: on a schema-≤8 record, `creation.movedCreator: 0` means the
 *   walk read every curve and none had moved.** On a schema-9 record with
 *   `enumerationSource: "dune"` it means nothing was looked at — Dune says who created a mint and
 *   whether it completed, and says nothing about who owns the curve today — and
 *   `creatorMovementUnmeasured` carries the size of what went unmeasured. Do not add the two, and do
 *   not read a Dune-sourced 0 as the walk's 0.
 *   `creation.rpcRequests` and `creation.loadShedEvents` read 0 on a Dune-sourced candidate because
 *   no walk happened, and so do `signaturesScanned`, `signaturesSucceeded`, `transactionsInspected`
 *   and `curvesUnread`; `stopReason` is `dune-enumerated`, which is not a stop at all. **A run may
 *   carry BOTH sources**: the coverage probe refuses a wallet at a time, so a wallet whose earliest
 *   launch sits at or before the probed surfaces' own first row falls back to the walk while the
 *   rest of the batch does not. Coverage is not the only refusal `duneFallbackReasons` carries — an
 *   unreadable row anywhere in the answer refuses the WHOLE batch, a wallet the enumeration returned
 *   no row for is refused as an absence of evidence rather than read as zero launches, a candidate
 *   whose address is not base58-shaped is never sent to Dune at all, which the `dune` block's
 *   `walletsRefusedByShape` counts, and a candidate whose history the PER-DEPLOYER ROW CAP truncated
 *   is refused so that it alone walks while the rest of the batch keeps its Dune answer. **That last
 *   one changes how `creation.duneLaunches` reads on that candidate: it is the truncated PREFIX the
 *   cap returned, not the count the answer declared**, and the declared total is only in the
 *   `duneFallbackReasons` sentence. Do not read the two surfaces disagreeing there as a broken one.
 *   `creation.coveredFrom/ToIso` on a Dune candidate is the PROBE's
 *   bound rather than a walk's window, and `wholeHistory` is true inside it because the enumeration
 *   is an index of creation events, not a window walked backwards until a budget bit.
 *   No candidate ROW key changes, so `PERSISTED_BY_SCHEMA[9]` equals `[8]`, and nothing about
 *   `entry`, `entry.coverage` or `spend` moves — Dune is metered in its own units in its own block,
 *   because a fourth budget folded into `spend` would imply an exchange rate that does not exist.
 * - **10** — **the unmeasured verdicts say WHICH producer reached them and WHOSE fact it is**
 *   (captain decision 174b). No candidate ROW key changes and no `entry.coverage`, `spend`, `dune`
 *   or `creation` key changes; `entry` gains `unmeasuredCause`, `unmeasuredCauseAttribution` and
 *   `unmeasuredContributingCauses`. **The verdict vocabulary is UNCHANGED** — this is a split of the
 *   cause, not of the label, so a schema-9 verdict and a schema-10 verdict are the same six values
 *   and directly comparable.
 *   **What a reader of an older record must not do: infer the cause.** `entry-unmeasured` and
 *   `entry-cost-unmeasured` have six distinct producers between them (`entry.mjs` →
 *   `UNMEASURED_CAUSES`), and on a schema-≤9 record the label cannot say which fired. **All six are
 *   facts about OUR coverage** — `too-few-windows-available` (the walk was never offered enough
 *   windows), `windows-dropped`, `too-few-proven-windows` (REFUSED as unproven openings, decision
 *   134a), `too-few-closed-round-trips`, `too-little-of-the-field-priced` and
 *   `too-few-priced-round-trips`. **`too-few-closed-round-trips` is the one that reads like a fact
 *   about the deployer and is not**: the walk that produces `closed` is bounded by our own
 *   `maxRequestsPerLaunch`, which drops the busiest launches, so `closed.length` is read off a
 *   sample our budget selected. **The evidence for that classification lives in ONE place and this
 *   is a pointer to it** — `tools/deployer-screen/README.md` → "Why `too-few-closed-round-trips` is
 *   `our-coverage` and not the deployer's", which has already been swapped once (captain decision
 *   144a superseded the two-bound-cursor argument it originally rested on) without the
 *   classification moving. So a consumer filtering on
 *   `verdict !== 'entry-unmeasured'` against
 *   an older record is filtering on its own budget and evidence while believing it is filtering on a
 *   measurement — and the rule at ANY schema version is that a later stage filters only on a
 *   MEASURED verdict, never on an unmeasured one whatever its cause. That attribution was settled
 *   during review, after the split had been committed; `tools/deployer-screen/README.md` → "What a
 *   later stage may filter on" is the authoritative record. `entry.mjs` →
 *   `isDeployerAttributable` is the predicate that owns this rule, and on a schema-≤9 record it
 *   answers `false` for the whole unmeasured family — the safe direction, and the reason the field
 *   must not be reconstructed. Every such score also carries the rule in `entry.caveats`
 *   (`COVERAGE_ATTRIBUTION_CAVEAT`), so the limit travels with the number.
 * - **11** — **the co-ordination rule became a UNION** (captain decision 182a): the existing
 *   shared-transaction rule, unchanged, OR the deployer-anchored contiguous block-index run at
 *   step 1. `entry` gains `runTx` and `adjacencyMarks` beside `bundledTx` and `maxWalletsInOneTx`;
 *   `PERSISTED_BY_SCHEMA[11]` and `ENTRY_COVERAGE_KEYS_BY_SCHEMA[11]` equal `[10]`, and nothing
 *   about `spend`, `creation` or `dune` moves — the signal is already in every fill the walk
 *   fetched, so the change costs no request, no host and no vendor quota.
 *
 *   **THE ONE THAT WILL BITE A READER: a schema-≤10 `entry.roomLeft` IS NOT COMPARABLE WITH A
 *   SCHEMA-11 ONE, and the older figure is the higher of the two.** Under the older rule a wallet
 *   that co-ordinated with the deployer by riding its bundle — without ever sharing a transaction —
 *   was counted as an OUTSIDER, so its stake sat in `independentSol` and inflated `roomLeft`. The
 *   union moves it into the operation's numerator. `sharedTx ⊆ union` by construction, so the
 *   correction can only ever move a room reading DOWN, never up; `adjacencyMarks` is how much the
 *   union added on each launch and is therefore the measure of what an older record's room figure
 *   was carrying. On the committed tape this removes **180 create-slot wallet-instances from the
 *   field** (1,502 → 1,322), and every one of the 180 is a NAMED cohort wallet — so a schema-≤10
 *   `entry`'s field figures, `outsidersPerLaunch`, `fieldEntrants` and every P&L distribution
 *   built on them were partly measuring the operation's own wallets as competitors.
 *
 *   **`launchesRoomUnproven` changes meaning in the same way** — it now counts launches NEITHER
 *   half marked anything in, where a schema-5..10 record counted launches with no bundled
 *   transaction. It falls sharply as a result: on the committed tape the refusal goes from 60 of
 *   235 launches to 0. No bar was relaxed and the refusal itself is untouched (decision 134a
 *   stands); the rule simply sees more, so it refuses less.
 *
 *   **The `stage0` block is not comparable across the boundary either, and this is a PUBLISHED
 *   CONSTANT MOVING.** `stage2SeamReproduction`'s era-2 entry reads `n: 89, nRoomUnproven: 0` and a
 *   measured share of **0.770796** where a schema-5..10 record reads `n: 86, nRoomUnproven: 3` and
 *   **0.769153**; the published `0.771` it is compared against is UNCHANGED, and the measured
 *   figure moved towards it — under the union the structural estimator and the named-cohort
 *   estimator become the same number to six decimals over the full 89. `rollingRoom` moves from
 *   `unmeasured: 81, present: 53, absent: 94` to `unmeasured: 0, present: 88, absent: 140`, with
 *   `falsePositives: 0` on both sides. The block also gains `adjacencyRuns`, the tripwire on the
 *   `sid` block-index signal, which is persisted because that signal's failure mode is silent.
 *   The correction is recorded in `population-tape-2026-07-29/IMPORT.md` → "Corrections";
 *   the report and the dataset README are a primary record and are not edited.
 * - **12** — **the unmeasured CAUSE VOCABULARY gains a seventh value** (captain decision 198b). No
 *   key moves anywhere: `PERSISTED_BY_SCHEMA[12]`, `ENTRY_KEYS_BY_SCHEMA[12]`,
 *   `ENTRY_COVERAGE_KEYS_BY_SCHEMA[12]`, `SPEND_KEYS_BY_SCHEMA[12]`, `DUNE_KEYS_BY_SCHEMA[12]` and
 *   `CREATION_KEYS_BY_SCHEMA[12]` all equal `[11]`. What changes is what `entry.unmeasuredCause` may
 *   contain: `room-verdict-not-robust-to-missing-launches`, which no schema-≤11 record can carry
 *   because the producer did not exist. **The version is what tells a consumer the domain widened**
 *   — the field's own shape did not — and it is bumped for the same reason schema 10 exists: a
 *   reader that enumerated the six causes would otherwise meet a seventh with nothing saying so.
 *
 *   **What it means.** Captain decision 190a decoupled `maxLaunchesPerCandidate` (10) from
 *   `minLaunchesSampled` (8), so a candidate keeps its verdict after losing up to two launches — and
 *   the missing ones are selected by DROP CAUSE, not at random (the request cap takes the busiest
 *   windows, `roomIsProven` takes the ones with no co-ordination evidence). `entry.mjs` →
 *   `roomBarRobustness` now refuses a room verdict whenever completing that hole could have put the
 *   median on the other side of `minRoomLeft`. It refuses in BOTH directions, because the direction
 *   of the bias is UNMEASURED; the interval is exact rather than tuned, and **no `thresholds.json`
 *   value moved for it — there is no new pinned number**.
 *
 *   **The two ways to misread it.** (1) It is NOT one of the three sample-size causes: the candidate
 *   cleared `minLaunchesSampled` and was refused anyway, so `launchesSampled` on such a record is at
 *   or above the floor while `too-few-*` records sit below it. (2) A schema-≤11 record's absence of
 *   this cause is NOT evidence its sample was robust — the guard did not exist, so a schema-11
 *   `entry-room-absent` or `entry-open-after-costs` reached over 8 of 10 launches is exactly the
 *   shape 198b refuses today and is not comparable with a schema-12 one. Committed records are never
 *   retro-edited, so the older reading stays legal; what it cannot do is stand in for a guarded one.
 * - **13** — **the Dune MONTHLY CREDIT CEILING becomes a thing a run checked rather than something
 *   it discovered by hitting.** The only key set that moves is the run-level `dune` block, which
 *   gains `allowance` and `localEstimate`: `PERSISTED_BY_SCHEMA[13]`, `ENTRY_KEYS_BY_SCHEMA[13]`,
 *   `ENTRY_COVERAGE_KEYS_BY_SCHEMA[13]`, `SPEND_KEYS_BY_SCHEMA[13]` and
 *   `CREATION_KEYS_BY_SCHEMA[13]` all equal `[12]`.
 *
 *   **What it carries.** `allowance` is the verdict of `dune.mjs` → `checkDuneAllowance`, taken
 *   from `POST /usage` BEFORE the leg's first billed request — the coverage probe included, since a
 *   result read is billed by bytes. It holds the plan's worst case in credits, the period's
 *   `credits_used`/`credits_included`, what remained, the reserve held back for the counter's lag,
 *   and the reasons. `null` means the run never reached Dune at all (no key, `--no-dune`,
 *   `--ownership-only`, or no candidate to gate) — **not** that the check passed. `localEstimate`
 *   is what the run believes it spent, computed from its own execution and byte counters at this
 *   lane's pinned worst case per execution, and it carries its own caveat string saying it is not
 *   the bill.
 *
 *   **Why a local estimate at all, when the vendor reports the real figure.** The vendor's counter
 *   lags minutes and lands in whole-credit jumps — measured rising +6.0 while the account was idle
 *   — so re-reading it after a run reports the balance from before the run. A record therefore
 *   cannot carry its own true cost, only a reading taken before it and an estimate of what it added.
 *
 *   **The one that will bite:** on a schema-≤12 record the absence of `dune.allowance` is not
 *   evidence that a run had headroom. Nothing checked. A schema-12 run that reports two executions
 *   may have been the run that emptied the period, and no committed record can say — which is
 *   exactly the gap this version closes rather than a shortcoming of the older ones.
 *
 *   **AND THE SECOND ONE, since captain decision 322a:** the verdict now names WHICH ceiling it was
 *   measured against — `bindingCeiling`, beside `monthlyCapCredits` (the operator's fleet-wide cap)
 *   and `creditsIncludedVendor` (the vendor's plan), with `creditsIncluded` holding the smaller of
 *   the two. **This is NOT a schema bump**: no version pins the key set of `allowance` itself, which
 *   is the verdict object `client.mjs` owns, and the block-level `dune` keys are unchanged. What it
 *   means for an older record is narrow and worth knowing: a `creditsIncluded` written before 322a
 *   is the VENDOR's figure alone, because that is the only ceiling that existed to be compared
 *   against — never evidence that an operator cap was checked and cleared.
 * - **14** — **the room median states its own incompleteness** (captain decision 208b). `entry` gains
 *   one key, `roomLeftBound`; `PERSISTED_BY_SCHEMA[14]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[14]`,
 *   `SPEND_KEYS_BY_SCHEMA[14]`, `DUNE_KEYS_BY_SCHEMA[14]` and `CREATION_KEYS_BY_SCHEMA[14]` all
 *   equal `[13]`. The `stage0` block's per-control summary also gains a `roomLeftBound` beside its
 *   `roomLeftMedian`.
 *
 *   **What it carries and why.** `entry.roomLeft.median` is taken over the launches Stage 2 SCORED,
 *   and the ones it did not score did not go missing at random: `roomIsProven` refuses the create
 *   slots with no co-ordination evidence, the request cap drops the busiest windows, and the stage
 *   ceiling leaves the oldest of a plan unattempted. `roomLeftBound` is the interval the median
 *   would lie in if the hole were filled — `lo`/`hi`, with `overstatementMax` (`median - lo`) as the
 *   headline, `provablyOverstated` when `hi < median`, the split of the hole into
 *   `launchesRefusedMeasured` and `launchesUnmeasured`, the refused windows' OWN measured room in
 *   `refusedRoomLeft`, and the sentence in `caveat`. `entry.mjs` → `roomMedianBound` owns the
 *   construction, the direction argument and the committed-data measurement behind it.
 *
 *   **It is REPORTING and nothing reads it.** No verdict, bar or guard takes it as an input;
 *   `roomIsProven` is untouched and no sample-size floor moved. Captain decision 203 declined both
 *   of those (203c, 203d) and 208b was chosen because it does neither.
 *
 *   **The one that will bite a reader: a schema-≤13 `entry.roomLeft.median` has no bound and one
 *   cannot be reconstructed from the record.** `launchesRoomUnproven` says how MANY windows were
 *   refused and nothing at all about what they measured, which is exactly the gap this closes — so
 *   an older record's median must be read as a figure of unknown incompleteness, not as a complete
 *   one. On the committed schema-12 `runs/2026-08-04.json` that is not hypothetical: its scored
 *   candidate reports a median `0.288940` over 4 windows with 6 refused, and the six were separately
 *   walked in `census/2026-08-04-proof-coverage-probe.md` at a room of `0.0000`–`0.0008`, which puts
 *   the completed median at `0.0008`. The record could not say so; a schema-14 one does.
 * - **15** — **pump.fun's mayhem-mode flag is recorded per launch and reported per candidate**
 *   (captain decision 227a). The `creation` block gains three keys — `mayhemLaunches`,
 *   `mayhemFlagReadable` and `mayhemShare`; `PERSISTED_BY_SCHEMA[15]`, `ENTRY_KEYS_BY_SCHEMA[15]`,
 *   `ENTRY_COVERAGE_KEYS_BY_SCHEMA[15]`, `SPEND_KEYS_BY_SCHEMA[15]` and `DUNE_KEYS_BY_SCHEMA[15]`
 *   all equal `[14]`.
 *
 *   **What it carries and why.** `pump_evt_createevent` has always had an `is_mayhem_mode` boolean
 *   and this repo never read it. `slot-zero-graduation-regime-remeasure` → `report.md` §1.4 and §3
 *   (held in firstmate's records, not in this repo) measured what it is worth: 27.1% of 2026-07's
 *   pump.fun launches carried it, those launches graduated at 4.1–4.7% against 1.8–2.1% for the
 *   rest, and they supplied 46.3% of the month's graduations. `CREATION_SQL` now selects it as a
 *   sixth column; `mayhemLaunches` is how many of the enumerated launches carry it,
 *   `mayhemFlagReadable` is the share's DENOMINATOR — the launches the flag was readable on, which
 *   is NOT `duneLaunches`, since `pump_call_create` has no such column — and `mayhemShare` is the
 *   quotient.
 *
 *   **It is REPORTING and nothing reads it**, exactly as schema 14 is. No bar, gate, rate or
 *   verdict takes it as an input, no launch is dropped or weighted for carrying it, and a test pins
 *   that a run's verdicts are identical with the column populated, absent and malformed. Excluding
 *   mayhem launches from the competence measure (227b) and excluding mayhem-heavy deployers (227c)
 *   were both declined; this version must not be read as a step towards either.
 *
 *   **CORRECTION — that last sentence describes SCHEMA 15 and every record written at 15–18, and it
 *   is no longer true of this build.** Captain decision **351** (2026-08-07) REVERSES 227b: a
 *   mayhem launch is now excluded from both sides of `minCompletionRate`, and schema **19** carries
 *   the two counts that say so. **227c is NOT reversed and remains declined.** The three `creation`
 *   keys this version added are unchanged and are still the observation nothing reads — 351's own
 *   counts are candidate ROW fields over a different denominator. See schema 19 below.
 *
 *   **The one that will bite a reader: all three are `null` on a candidate the creation walk
 *   answered, and `null` is UNMEASURED rather than 0%.** The flag lives on Dune's decoded create
 *   event, and the walk reads transactions and curve accounts — so a walk-sourced candidate has no
 *   mayhem reading at all, in the same way a Dune-sourced one has no `movedCreator`. Read
 *   `enumerationSource` beside it. A schema-≤14 record carries no mayhem reading of any kind and
 *   one cannot be reconstructed from it: the flag was never selected, so the absence says nothing
 *   about the launches.
 * - **16** — **a run states what it PREDICTED, in a form a later run can score.** Every candidate row
 *   gains `prediction`, and the record gains a run-level `predictions` block;
 *   `ENTRY_KEYS_BY_SCHEMA[16]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[16]`, `SPEND_KEYS_BY_SCHEMA[16]`,
 *   `DUNE_KEYS_BY_SCHEMA[16]` and `CREATION_KEYS_BY_SCHEMA[16]` all equal `[15]` — no measurement
 *   moves, and a test pins that verdicts are identical with the block present and absent.
 *
 *   **Why it is a version at all, when nothing measured changed.** This module's opening line already
 *   calls run records "the prediction-grading lane's declared input", and until now no record
 *   contained a prediction. **A run that did not record what it predicted can never be graded** —
 *   not "gradeable later", never, because the claim and the instant it stops being in-sample cannot
 *   be reconstructed after the fact. So every record at schema ≤15 is PERMANENTLY unfalsifiable, and
 *   that is a property of those records rather than a shortcoming of their measurements.
 *
 *   **What it carries.** Per candidate: `prediction.claims`, a LIST keyed by `subject`, each entry
 *   holding the beatable / not-beatable call, the verdict it was read off, whether that verdict was
 *   MEASURED (`entry.mjs` → `isDeployerAttributable`), and why there is no claim when there is none.
 *   `prediction.madeAtIso` is the run's own `finishedAtIso` and is the out-of-sample boundary; it is
 *   copied onto every row on purpose, so one row is a self-contained claim. `prediction.gateReading`
 *   copies `historySource` and `prediction.entryReading` names Stage 2's surface, because the two
 *   readings behind a claim are different surfaces and this record may not be the place they get
 *   pooled. Run level: `predictions` counts the claims, breaks the no-claim tally out BY REASON, and
 *   declares `subjects` and `subjectsDeferred`.
 *
 *   **Two ways to misread it.** (1) A claim is absent for two quite different reasons and the block
 *   keeps them apart: `not-scored` (Stage 2 never ran on this candidate) and `entry-unmeasured`
 *   (it ran and could not answer). **Neither is a prediction of "not beatable"** — reading an
 *   unmeasured verdict as a claim would let the screen grade itself right whenever its own budget
 *   ran out, which is captain decision 174b's failure mode wearing a hit rate. (2) The counts are
 *   CLAIMS, not results: nothing in a run record is ever graded. `outcome.mjs` and the ledger under
 *   `feedback/` hold grades, and a run record is never retro-edited to carry one.
 *
 *   **Stage 3 is DEFERRED, not cancelled (captain decision 237a), and the shape is built for it.**
 *   `subjectsDeferred` records `exit` as a subject this build deliberately did not predict, so a
 *   grader can tell "the stage did not exist" from "the stage could not measure it". A later build
 *   appends an `exit` claim to the same list and moves the subject across; **no record written under
 *   schema 16 is invalidated by that**, which is the whole reason claims are a list rather than a
 *   scalar. A schema that forced a reset would waste every run recorded in between.
 * - **17** — **a run can now carry the predictions it was made to test**, so the grading lane has an
 *   input rather than a plan. The run-level block `declaredPredictions` is new;
 *   `PERSISTED_BY_SCHEMA[17]`,
 *   `ENTRY_KEYS_BY_SCHEMA[17]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[17]`, `SPEND_KEYS_BY_SCHEMA[17]`,
 *   `DUNE_KEYS_BY_SCHEMA[17]` and `CREATION_KEYS_BY_SCHEMA[17]` all equal `[16]`.
 *
 *   **`declaredPredictions` is NOT schema 16's `predictions` and the two names are kept apart on
 *   purpose:** `predictions` is what the SCREEN predicted about its candidates, emitted by the tool
 *   from its own verdicts, while `declaredPredictions` is what the LANE predicted about the run
 *   before it looked, supplied by the operator, carried verbatim and graded elsewhere.
 *
 *   **Why it belongs in the record and not beside it.** This module's own opening sentence declares
 *   run records the prediction-grading lane's input, and until this version there was nowhere in one
 *   to say what a run predicted — so every prediction lived in a companion document that could be
 *   written, revised or lost independently of the measurement it was about. A sidecar is a second
 *   copy of a claim, and the two drift until whichever one a reader opens becomes the truth.
 *
 *   **What it carries.** `--predict <path>` reads a document, {@link readPredictions} validates it,
 *   and it is embedded VERBATIM: `documentVersion`, `lane`, `leg`, `madeAtIso`, `basis`, `source`
 *   (the path it was read from) and `predictions`, each of which is `{id, statement, reading,
 *   metric, comparator, value, rationale}`. `metric` is EITHER a dotted path into this record OR a
 *   `derived:` name from {@link DERIVED_PREDICTION_METRICS}, and {@link resolvePredictionMetric} is
 *   the one resolver for both, so a grader reads the field the prediction named rather than one it
 *   inferred. The derived half exists because the questions worth predicting are mostly COUNTS over
 *   `candidates[]` rather than scalars a record holds — *how many did this leg admit* is not a
 *   field — and leaving those to prose would have made the interesting half of every prediction
 *   ungradeable, while letting a document carry its own expression would have made a grader an
 *   interpreter. `metric: null` is legitimate and means the claim is not resolvable from a record at
 *   all; it still carries `statement` and `rationale`, and it may then carry no comparator.
 *
 *   **`reading` is REQUIRED and is the point of the block.** A completion rate is two different
 *   quantities here — the creation-derived merged history the gate reads, and the vendor's
 *   70-record page — differing by an order of magnitude on the same wallets, and captain decision
 *   231a exists because a bar was once stated without naming which. A prediction about a rate that
 *   does not say which rate is not gradeable, so the reader REFUSES one rather than defaulting.
 *
 *   **Nothing here is evaluated by the screen, deliberately.** The tool carries the claim and
 *   measures the run; scoring the first against the second is the grading lane's job, and a screen
 *   that graded its own predictions would be marking its own paper. `declaredPredictions: null` is
 *   the normal state of a run made without `--predict` and means *nothing was predicted*, never *the
 *   predictions failed*.
 *
 *   **The one that will bite a reader: the document is the RUN's, not the tool's, and it is
 *   unvalidated as to CONTENT.** {@link readPredictions} checks shape, not truth — it cannot know
 *   whether a stated `value` was reasonable, and a document written after the run would look
 *   identical to one written before it. What makes these predictions rather than postdictions is
 *   that the document is committed in its own commit before the run, exactly as `thresholds.json`
 *   is; the record cannot prove that and does not claim to.
 *
 * - **18** — THE DUAL-SOURCE STAGE 2 RUN. Gate 3 precondition 4, and it is EVIDENCE FOR that gate
 *   rather than the cutover: a default run still selects the swap-api fill source, still reads it,
 *   and every field below is `null`/empty on one.
 *
 *   Three per-candidate fields and one run-level block. `entrySource` names WHICH fill source
 *   produced this candidate's `entry` — `enumerationSource`'s shape one stage over (captain
 *   decisions 156a and 191a), per candidate for the same reason: a primary source can fail to
 *   answer for one wallet while answering for the rest, and a run-level field could not say which.
 *   `null` there means Stage 2 produced NO score (no gate pass, `--no-stage2`, or the scoring cap),
 *   never "a source that was not named". `entrySourceFallbackReasons` says why a candidate's
 *   recorded reading came from the cross-check source instead of the primary, and is empty on every
 *   single-source run. `entryAgreement` carries the per-candidate comparison class.
 *
 *   **THE RUN-LEVEL BLOCK CARRIES COUNTS AND NEVER A RATE, AND THAT IS THE CONTRACT RATHER THAN A
 *   PREFERENCE.** Captain decision 143a: a 98.4% whole-window agreement figure on this project hid
 *   a total failure confined to the create slot, because an aggregate is dominated by the easy
 *   majority. So `entrySourceAgreement.byClass` counts `agreed`, `disagreed`, `only-<kind>-answered`
 *   and `neither-answered` apart, `noAggregateRate` travels with them, and the class that can be
 *   wrong lives on the candidate. **`only-<kind>-answered` is a COVERAGE difference and not a
 *   disagreement** — captain decision 174b, one level up: an unmeasured verdict is no answer, and
 *   every producer of one is our own coverage.
 *
 *   **`entrySourceAgreement.duneSpend` STATES THE PERMISSION AND THE APPLICATION SIDE BY SIDE**
 *   (captain decision 323a). `executionCeiling` and `windowCeiling` are the PINS — what the tool
 *   allows any run of this leg — while `executionBoundApplied` (the `maxExecutions` this run's
 *   `DuneClient` was constructed with) and `windowsPlanned` (the window count its credit plan was
 *   priced and approved at) are what THIS RUN could have cost. Since the plan is derived from the
 *   windows a run plans, a block carrying only the pins would describe a bound no run applied, and
 *   one carrying only the application would lose the limit a reader judges it against. A record is
 *   never retro-edited, so either half-truth would be permanent. Do not pool the two.
 *
 *   `prediction.entryReading` became SOURCE-AWARE at this version. It named the swap-api gate
 *   specifically, which was true only while one source was ever selected; a Dune-sourced claim filed
 *   under that sentence would describe a gate it did not use, permanently, since a record is never
 *   retro-edited. `prediction.mjs` → `entryReadingFor` refuses an unknown source rather than
 *   defaulting to another's.
 * - **19** — **A MAYHEM-MODE GRADUATION IS NOT COMPETENCE EVIDENCE, so a mayhem launch leaves BOTH
 *   sides of `minCompletionRate`** (captain decision 351, 2026-08-07, which REVERSES 227b). This is
 *   the first version at which `tokens`, `completed`, `completionRate` and `spanDays` describe
 *   something narrower than the history the gate read, so **a schema-≤18 rate and a schema-19 one
 *   are not the same quantity and must not be pooled or compared.** Two candidate row keys —
 *   `competenceMayhemExcluded` and `competenceMayhemUnreadable`; `ENTRY_KEYS_BY_SCHEMA[19]`,
 *   `ENTRY_COVERAGE_KEYS_BY_SCHEMA[19]`, `SPEND_KEYS_BY_SCHEMA[19]`, `DUNE_KEYS_BY_SCHEMA[19]` and
 *   `CREATION_KEYS_BY_SCHEMA[19]` all equal `[18]`.
 *
 *   **The evidence.** A mayhem graduation is preceded by a median net quote inflow of **0.291 SOL**
 *   against **85.005 SOL** for a classic curve graduation — 292x cheaper, and not separable in trade
 *   data from a token that churned about $1,700 and died — while in 2026-07 mayhem was **27.15% of
 *   pump.fun launches and 46.41% of its graduations**
 *   (`slot-zero-offlaunchpad-graduation-criterion` → `report.md` §4 and §8.2, held in firstmate's
 *   records, not in this repo). So the bar that IS the gate was measuring two very different
 *   achievements through one number.
 *
 *   **Why the DENOMINATOR moves too, and it is not optional.** Excluding mayhem graduations from
 *   the numerator alone drives a mayhem-heavy deployer's rate towards 0.0000 and removes them from
 *   the gate — which is captain decision **227c**, *excluding mayhem-heavy deployers outright*, and
 *   **227c is NOT reversed and remains DECLINED**. A deployer is judged on their non-mayhem record,
 *   not removed for having a mayhem one.
 *
 *   **What the two new keys are for.** `competenceMayhemExcluded` is how many launches the
 *   exclusion removed from both sides. `competenceMayhemUnreadable` is how many of the launches
 *   that REMAIN carry no readable flag — they are counted in `tokens` and `completed`, which is a
 *   stated decision rather than a default, and this key is what makes it auditable:
 *   `competenceMayhemExcluded === 0 && competenceMayhemUnreadable === tokens` is a rate no mayhem
 *   evidence touched, i.e. the pre-351 reading. **A reader of a persisted row must apply BOTH
 *   conjuncts**: a row carrying excluded launches whose remainder is entirely unreadable
 *   satisfies the second alone, and is a rate the exclusion did move. `measure.mjs` → `measureCompletion` owns the argument, including why dropping those
 *   launches instead would empty the denominator of every walk-sourced candidate on evidence about
 *   the SURFACE rather than about the deployer.
 *
 *   **Both counts are over the MERGED history the gate read, which is a different denominator from
 *   `creation.mayhemLaunches`/`mayhemFlagReadable` and the two legitimately differ.** That block is
 *   227a's share of what the ENUMERATION returned; these two are what the exclusion did to the
 *   reading the rate beside them was computed on, and the merge both adds launches the enumeration
 *   never returned (ownership-listed ones) and drops ones it did.
 *
 *   **The one that will bite a reader: a schema-≤18 record carries neither key and one cannot be
 *   reconstructed from it.** `creation.mayhemLaunches` is not a substitute — different denominator,
 *   and `null` on every walk-sourced candidate. Read a schema-≤18 `completionRate` as the pre-351
 *   quantity: mayhem and non-mayhem graduations pooled.
 *
 *   **There are deliberately no `vendor*` twins.** The MadeOnSol profile page has no such column, so
 *   `vendorCompletionRate` is unmovable by 351 by construction, and a pair of zeroes beside it would
 *   imply a measurement nobody took.
 *
 * - **20** — **STAGE 2 SCORING HAS A MEMORY, so the cap goes to the LEAST-RECENTLY-SCORED
 *   survivors** (captain decision 336a). No new candidate ROW field, no new `entry`, `entry.coverage`,
 *   `spend`, `dune` or `creation` field; one new run-level block, `scoringRotation`.
 *
 *   Until this version `screen.mjs` took `survivors.slice(0, maxScored)` — the first seven in
 *   `mergeSeeds` order, which is deterministic — so a daily run re-measured the same seven wallets
 *   every day while the median survivor needs about 21.5 days for its ten windows to refresh and 0
 *   of 27 refresh within a day. `maxScored` does NOT move (captain decision 339a keeps capacity at 7
 *   a run); what moves is which seven.
 *
 *   **The version exists because the trade has to be visible in the record.** A pre-20 run was
 *   stateless — same inputs, same output, anyone could re-run it and reproduce a published result —
 *   and rotation makes a run's output depend on every run before it. `scoringRotation` is what buys
 *   that back: `statePath`, `stateSchemaVersion` and `stateDigestBefore`/`stateDigestAfter` NAME the
 *   bytes the run read and wrote, so run N's `after` is run N+1's `before` and the chain is
 *   checkable from committed artefacts; and `order` carries the WHOLE ranked survivor list rather
 *   than the slice taken from it, so `rotation.mjs` → `verifySelection` re-derives the selection
 *   from the record alone, with no state file and no clock. `selected`/`deferred`/`walletsScored`/
 *   `scoredAtIso`/`neverScoredBefore`/`importedFromRunRecords` are the counts a reader judges it by,
 *   and `reproducibility` carries the condition in one sentence.
 *
 *   **`enabled: false` is a real state and is not the block's absence.** A run made with
 *   `--no-rotation`, or one where Stage 2 selected nobody, records the block with a `reason`, so a
 *   stateless run is never read as a rotated one that happened to repeat.
 *
 *   **The one that will bite:** on a schema-≤19 record the absence of this block means the run took
 *   the HEAD of the survivor list, so **two such records scoring the same wallets are not evidence
 *   of anything about those wallets** — they are evidence that the seed order did not move. And
 *   `scoringCap.survivorsUnscored` means the same thing across the boundary while the wallets behind
 *   it do not: before 20 the unscored are the list's tail, after it they are whichever were measured
 *   most recently.
 *
 * - **21** — **THE COMPLETION MEASURE IS RAISE-85 ON EVERY VENUE, pump.fun INCLUDED** (captain
 *   decision 352b). `completed` / `completionRate` no longer mean *pump.fun said these graduated*;
 *   they mean *this many of these tokens' own primary markets took in 85 SOL-equivalent in their
 *   first 24 hours*. **So a schema-≤20 rate and a schema-21 one are not the same quantity either**,
 *   and that is now true at two of the last three versions — 19 moved the same quantity and 20 left
 *   it alone — so read `schemaVersion` before
 *   pooling any two `completionRate` values from this tool, ever. FOUR candidate row keys —
 *   `competenceCriterionUnreadable`, `competenceCriterionEstimated`,
 *   `vendorCompetenceCriterionUnreadable` and `vendorCompetenceCriterionEstimated`;
 *   `ENTRY_KEYS_BY_SCHEMA[21]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[21]`, `SPEND_KEYS_BY_SCHEMA[21]`,
 *   `DUNE_KEYS_BY_SCHEMA[21]` and `CREATION_KEYS_BY_SCHEMA[21]` all equal `[20]`.
 *
 *   **The measure.** Net quote inflow into a token's own primary market, over its first 24 hours,
 *   reaching **85 SOL-equivalent**. The constant was read off the data rather than fitted —
 *   graduating non-mayhem tokens read 85.005 SOL at p50 AND p99 over 157,259 launches — and it has
 *   **zero token-level false positives**, which is what makes a rate computed from it a LOWER BOUND
 *   and adoption therefore safe in one direction: measured over 176,200 July-active deployers it
 *   **promoted zero** deployers over the 0.25 bar and demoted 1,417. `measure.mjs` →
 *   `RAISE_85_SOL_BAR` owns why the bar is not lowered to buy recall.
 *
 *   **THE SEAM WITH 351, which is what these two keys exist to make auditable.** RAISE-85 as a
 *   definition only ever touches the NUMERATOR — it simply never registers a mayhem graduation,
 *   which raises a median 0.291 SOL. Had mayhem LAUNCHES stayed in the denominator, a mayhem-heavy
 *   deployer would run to 0.0000 and be dropped, **which is captain decision 227c and 227c REMAINS
 *   DECLINED**. So the mayhem exclusion runs FIRST, over the whole history, and the criterion is
 *   applied only to what it leaves. A row therefore reports the two exclusions apart and they are
 *   never additive in meaning: `competenceMayhemExcluded` is *not competence evidence*,
 *   `competenceCriterionUnreadable` is *nothing could measure this*.
 *
 *   **What the two new keys are for.** `competenceCriterionUnreadable` is how many launches left
 *   BOTH sides because RAISE-85 could not be read on them at all — never scored as failures,
 *   because defaulting our own coverage gap into a rejection is permanent and invisible here. A
 *   candidate whose whole history reads that way is `gate-unmeasured`, never 0.0000 (`rank.mjs` →
 *   `competenceEmptiedByCriterion`) — and **so is a candidate with ANY unreadable launch, whatever
 *   the rest of the history says** (`rank.mjs` → `competenceCriterionIncomplete`), because those
 *   launches leave `tokens` and `spanDays` as well as the rate, so `minTokens` and `minSpanDays`
 *   would otherwise reject a wallet over OUR coverage. **A schema-21 row with
 *   `competenceCriterionUnreadable > 0` therefore carries `verdict: "gate-unmeasured"` and a
 *   `completionRate` nothing was decided on.** `competenceCriterionEstimated` is how many of the `tokens` that
 *   REMAIN had RAISE-85 read through pump.fun's own graduation flag rather than measured from trade
 *   data: **`competenceCriterionEstimated === tokens` means the whole rate is an UPPER BOUND on the
 *   RAISE-85 rate**, which is what every route this repo has today produces, and without it a reader
 *   would take an estimate for the measure. `measure.mjs` → `PUMPFUN_GRADUATION_ESTIMATOR` owns what
 *   that estimator is worth in each direction — its negative is exact, its positive is the bound.
 *
 *   **AND THE VENDOR PAIR MOVED TOO, WHICH SCHEMA 19'S NOTE ABOVE SPECIFICALLY SAID 351 COULD NOT
 *   DO.** `vendorCompleted` / `vendorCompletionRate` are a THIRD quantity at this version: 351 could
 *   not touch them because the MadeOnSol page carries no mayhem column, but 352b reads the criterion
 *   off that page's own `complete` field, and `measure.mjs` → `toTokenRecords` folds a missing or
 *   malformed one to UNREADABLE — so a schema-21 vendor reading drops those rows from both sides
 *   where a schema-≤20 one counted them as failures. That pair is a GATE INPUT on `--ownership-only`
 *   runs and in `feed.mjs`, not a bystander field, so **a schema-≤20 `vendorCompletionRate` must not
 *   be pooled with a schema-21 one either** — and it therefore GETS the two companion counts the
 *   gate rate has, `vendorCompetenceCriterionUnreadable` and `vendorCompetenceCriterionEstimated`,
 *   so a reader can see how many vendor rows left both sides and how much of that rate rests on the
 *   estimator. **There is still no vendor twin of the MAYHEM pair, and that is not an
 *   inconsistency**: schema 19's reasoning — the page carries no mayhem column, so 351 cannot move
 *   that rate by construction — holds unchanged; what does not survive 352b is applying it to the
 *   criterion, which IS read off that page's own `complete` field.
 *
 *   **AND THE `consistency` BLOCK MOVED TOO, INDEPENDENTLY OF THE GATE READING.**
 *   `rank.mjs` → `measureConsistency` drops a criterion-unreadable launch rather than letting `if
 *   (r.completed)` read it as a FAILED one, which would manufacture dispersion out of a coverage gap
 *   and could mark a deployer STREAKY for a walk that came back short. So `epochs`, `minEpochRate`,
 *   `maxEpochRate`, `dispersion` and `streaky` are a different quantity at this version, and **a
 *   schema-≤20 `dispersion` must not be pooled with a schema-21 one** — the same rule this note
 *   applies to `completionRate`. **The independence is the trap**: consistency is computed over its
 *   OWN fresh creator walk, not over the gate's reading, so a gate reading with no unreadable launch
 *   does NOT imply a consistency reading with none, and this block can move on a wallet that passed.
 *   No key was added for it: the count that left travels on the block's own `note`, so a consumer's
 *   key set does not move for a disclosure.
 *
 *   **What this version does NOT claim.** Nothing here establishes that the bar is equally strict
 *   across venues: the same 85 SOL is reached by 0.80% of new pump.fun tokens, 0.25% on Meteora DBC
 *   and 46.71% on Meteora CPAMM. `measure.mjs` → `CROSS_VENUE_STRICTNESS_UNESTABLISHED` carries
 *   that, and no record, doc or rendered line here may read as cross-venue comparability.
 *
 *   **And it moved no bar and no committed verdict.** `minCompletionRate` stays 0.25; every route
 *   this repo has reads the criterion through the estimator, whose disagreement with pump.fun's own
 *   flag is nil by construction, so Stage 0's committed-tape regressions are byte-identical. The
 *   one behaviour that DID move is the launch neither source could answer for: it was written
 *   `completed: false` and is `null` now, so it leaves both sides instead of understating the rate.
 *   Re-deriving the 112, the 58 and the monthly gate populations under the adopted measure is
 *   `slot-zero-rederive-gate-population-post-351` and is deliberately not done here.
 *
 * - **22** — **THE SCREEN CAN BE HANDED A WALLET LIST, so a candidate no longer has to have come
 *   from the vendor** (captain decision 398a, 2026-08-09). ONE new candidate ROW key,
 *   `candidateSource` — `'vendor-seed'` or `'wallet-list'` — and ONE new run-level block,
 *   `walletList`. `ENTRY_KEYS_BY_SCHEMA[22]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[22]`,
 *   `SPEND_KEYS_BY_SCHEMA[22]`, `DUNE_KEYS_BY_SCHEMA[22]`, `CREATION_KEYS_BY_SCHEMA[22]` and
 *   `ROTATION_BLOCK_KEYS_BY_SCHEMA[22]` all equal `[21]`, and **no measured quantity moves at all**
 *   — unlike 19 and 21, a schema-21 `completionRate` and a schema-22 one are the same quantity and
 *   may be pooled.
 *
 *   **Why it needs a version.** Until this one, every candidate in every record came from a
 *   MadeOnSol enumeration endpoint, so *where a candidate came from* was a property of the tool
 *   rather than of the row and nothing had to say it. That stops being true here: 64% of the
 *   deployers that passed this gate in 2026-07 are invisible to every discovery source this repo
 *   has, and the two populations are **not interchangeable** — the listed one is by construction the
 *   part the vendor never surfaced. A reader pooling them without version-detecting would describe a
 *   discovery surface that measured neither. **On a schema-≤21 record the field's absence is
 *   unambiguous: every candidate there is `vendor-seed`, because nothing before this version could
 *   supply a list.**
 *
 *   **What it does NOT change, and this is the load-bearing half.** A supplied list is a SEED and
 *   never a substitute for the gate: a listed address becomes an ordinary `SeedCandidate` and enters
 *   the ONE gate loop, so there is no second path and no bar it can skip. `candidateSource` is
 *   provenance and is read by nothing — no bar, no verdict, no stage, no rotation comparator. A
 *   listed wallet failing the competence bars carries `verdict: "gate-failed"` exactly as a seeded
 *   one does, and `test/deployer-screen.test.ts` → "398a: a LISTED wallet still has to pass the
 *   gate" drives that end to end. `wallet-list.mjs` → `WALLET_LIST_IS_A_SEED` is the sentence, and
 *   the run-level block carries it verbatim as `isASeed` so a record states its own constraint.
 *
 *   **The run-level block, and why it names a digest.** `walletList` is `null` on every enumerated
 *   run, which is every default run. When present it carries `path`, `digest` (SHA-256 of the file's
 *   bytes), `label` (the `wallet-list:<file>` value on every listed candidate's `seededBy`),
 *   `entriesRead`, `wallets` and `seedsIssued`. The digest is there for the reason `scoringRotation`
 *   names its own: this file IS the run's whole population, so a record carrying only a path would
 *   stay reproducible exactly as long as nobody edited it. **`seedsIssued: 0` is stated rather than
 *   inferred** from an empty `coverage.seeds`, because an empty seed table also describes a run
 *   whose enumeration failed — two opposite facts under one shape.
 *
 *   **The plan arithmetic moved with it, and a reader of `spend` should know how.** A listed run
 *   issues NO enumeration request, so `spend.plannedWorstCaseKeyed` is `0 + <addresses>` rather than
 *   `6 + <cap>`, and `spend.candidateCap` is the list's own length rather than a ceiling it was
 *   allowed to fall short of. Nothing else in the cost model moves: the keyless and Helius ceilings
 *   are per candidate and unchanged, Stage 2's keyless ceiling is `maxCandidatesScored ×
 *   maxLaunchesPerCandidate × maxRequestsPerLaunch` and none of those three moved, and no Dune
 *   execution or Helius credit is spent that a seeded run would not spend.
 *
 * - **23** — **THE SCORING CAP IS ALLOCATED BY LAUNCH FLOW, not by recency alone** (captain decision
 *   399a, 2026-08-09). NO new candidate row key and no new block. TWO new keys on the
 *   `scoringRotation` block — `windowCap` and `newGroundRule` — and TWO new keys on every row of its
 *   `order`: `launchesPerDay` and `newGroundWindows`. `ENTRY_KEYS_BY_SCHEMA[23]`,
 *   `ENTRY_COVERAGE_KEYS_BY_SCHEMA[23]`, `SPEND_KEYS_BY_SCHEMA[23]`, `DUNE_KEYS_BY_SCHEMA[23]` and
 *   `CREATION_KEYS_BY_SCHEMA[23]` all equal `[22]`, and **no measured quantity moves**: a schema-22
 *   `completionRate`, `entry` block or `spend` figure and a schema-23 one are the same quantities
 *   and may be pooled.
 *
 *   **Why it needs a version.** Schema 20 made the selection re-derivable from the record alone, and
 *   that guarantee is only as good as the record carrying everything the comparator reads. 399a's
 *   comparator reads a flow term, so the record has to carry it — `launchesPerDay` (the survivor's
 *   launch tempo on the reading THE GATE read, `completion.tokens / completion.spanDays`) and
 *   `newGroundWindows` (that tempo times the days waited, saturating at `windowCap`). A schema-22
 *   record's `order` rows carry neither, and `rotation.mjs` → `compareRotationRows` reads their
 *   absence as *this row states no flow term* rather than as zero flow, so `verifySelection` still
 *   passes on a pre-399a record by 336a's own recency rule. **`windowCap` is on the block rather
 *   than looked up from the filed recipe** so a reader can re-derive every row's key from the block
 *   plus the run's `startedAtIso` and nothing else.
 *
 *   **The one that will bite a reader: two schema-≤22 records scoring the same wallets, and two
 *   schema-23 ones, do not mean the same thing.** Before this version the cap was a round robin, so
 *   which wallets a run scored says only how long ago each was last seen; from 23 it also says which
 *   have the most unharvested launch flow. A rate computed over "wallets this tool scored" is
 *   therefore drawn from a differently-weighted sample either side of the boundary — deliberately
 *   weighted towards the busiest deployers, which is the selection-quality cost captain decision
 *   399a accepted knowingly and which `rotation.mjs`'s module comment states in full.
 *
 *   **What it does NOT change.** `maxCandidatesScored` stays 7 (captain decision 339a),
 *   `maxLaunchesPerCandidate` stays 10 and `maxRequestsPerLaunch` stays 18, so Stage 2's keyless
 *   ceiling — their product — is untouched and no threshold moved at all. It costs zero in every
 *   currency: no vendor is reached, the tempo is a field the gate already measured, and the ranking
 *   is arithmetic over one local file. Every clause of schema 20's reproducibility contract holds
 *   unchanged, including that `enabled: false` is a state rather than the block's absence.
 *
 * - **24 — THE ENTRANTS ARE KEPT.** Captain decision 459 (2026-08-11), increment 1 of the pivot to
 *   scoring entrants. ONE new key inside `entry`: `windows`, an array with one row per WALKED window
 *   — refused windows INCLUDED — each carrying that window's create-slot summary, `roomIsProven`,
 *   and an `entrants` array of one row per create-slot outsider wallet. No candidate ROW field and
 *   no run-level block; `PERSISTED_BY_SCHEMA[24]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[24]`,
 *   `SPEND_KEYS_BY_SCHEMA[24]`, `DUNE_KEYS_BY_SCHEMA[24]`, `CREATION_KEYS_BY_SCHEMA[24]` and
 *   `ROTATION_BLOCK_KEYS_BY_SCHEMA[24]` all equal `[23]`. **No measured quantity moves and no
 *   threshold moves**, so a schema-23 `completionRate`, `entry` aggregate or `spend` figure and a
 *   schema-24 one are the same quantities and may be pooled.
 *
 *   **Why it needs a version.** Every `entry` field before this one is an AGGREGATE. Two committed
 *   measurements walked **353 stranger windows across 36 scored deployers** and counted **1,058
 *   field entrants**, and persisted not one address and not one `sid` — the evidence was computed
 *   and discarded, and it is unrecoverable without re-walking. A consumer must be able to tell a
 *   record that holds the evidence from one that holds only its summary, and no aggregate says
 *   which.
 *
 *   **What it costs: nothing, in every currency.** Every byte was already in the fill walk's own
 *   response. No vendor request, no credit, no wall clock, and Stage 2's keyless ceiling
 *   (`maxCandidatesScored` × `maxLaunchesPerCandidate` × `maxRequestsPerLaunch`) cannot move,
 *   because none of the three is a function of what is recorded.
 *
 *   **The population is every WALKED window, not every SCORED one, and that is deliberate.**
 *   Observing who filled a create slot needs no proof of co-ordination; only claiming they were
 *   independent does. On the widened measurement 209 of 210 windows walked cleanly while 38 produced
 *   a room reading, so the scored half is roughly a fifth of what the walk paid for. `roomIsProven`
 *   is on every window row, so the two claims can never be conflated: on a `false` row the entrant
 *   list says truthfully WHO filled, while `roomLeft` and `operationShare` beside it are the
 *   unproven readings captain decision 134a refuses to score.
 *
 *   **It decides NOTHING.** No bar, gate, threshold, predicate or verdict reads it, and a test pins
 *   that — the shape captain decision 208b established for `entry.roomLeftBound`. A schema-23 run
 *   and a schema-24 run over the same inputs reach byte-identical verdicts.
 *
 *   **Two things a reader must not get wrong.** `sid` is a STRING and never a number — 22 decimal
 *   digits is past `Number.MAX_SAFE_INTEGER` and arithmetic on it rounds a fill into the previous
 *   slot (`measure.mjs` → `blockTxIndex`). And `entrantUnitIsProven` reads `false` on every row this
 *   version can write, **by construction rather than by measurement**: the co-ordination rule's
 *   half (a) reclassifies any two wallets sharing a create-slot transaction as the operation's own
 *   before the entrant set exists, so the collapse rule has nothing left to collapse. It therefore
 *   says the question was asked and found no evidence — never that the wallet is an independent
 *   trader, which captain decision 114a made permanently unprovable.
 *
 *   **The retention posture moved with it and the ToS argument did not.** Counterparty addresses
 *   were dropped before this version because *"a list of who was in it would be an accumulation with
 *   no question attached to it"*; 459 supplies the question. An entrant address, its `sid` and its
 *   transaction come from pump.fun's keyless public endpoint and from the chain, not from MadeOnSol,
 *   exactly as the creation walk's mints do, and no vendor per-token record is persisted at any
 *   version. What genuinely changes is that a screened LAUNCH becomes identifiable from a record,
 *   since a create slot plus an entrant address recovers the mint from the chain.
 *   `tools/deployer-screen/README.md` → "Retention" owns the whole claim.
 *
 * - **25 — EVERY POSITION TAKEN IS COUNTED, NOT ONLY THE ONES THAT EXITED.** Captain decision 461
 *   (2026-08-11), the realization correction. **This is the version boundary at which a headline
 *   figure changes sign**, and it changes sign because of a counting choice rather than because of
 *   new data. Nine new keys inside `entry` —
 *   `fieldRealisedSolOverAllPositionsGrossOfFees`, `fieldReturnPerSolOverAllPositionsGrossOfFees`,
 *   `fieldHitRateOverAllPositionsGrossOfFees`, `fieldRealisedSolOverAllPositionsNetOfMeasuredFees`,
 *   `fieldReturnPerSolOverAllPositionsNetOfMeasuredFees`, `fieldHitRateOverAllPositionsNetOfMeasuredFees`,
 *   `fieldResidualMarkedSolAtWindowLastPriceGrossOfFees`, `positionsStillHeldAtHorizon` and
 *   `positionsHorizonNotObserved` on the block itself, plus eight on every `entry.windows[].entrants`
 *   row (`positionOutcome`, `windowTxCount`, `residualTokens`,
 *   `residualMarkedSolAtWindowLastPriceGrossOfFees`, `realisedSolAtZeroRecoveryGrossOfFees`,
 *   `returnPerSolAtZeroRecoveryGrossOfFees`, `realisedSolAtZeroRecoveryNetOfMeasuredFees`,
 *   `returnPerSolAtZeroRecoveryNetOfMeasuredFees`). No candidate ROW field and no run-level block:
 *   `PERSISTED_BY_SCHEMA[25]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[25]`, `SPEND_KEYS_BY_SCHEMA[25]`,
 *   `DUNE_KEYS_BY_SCHEMA[25]`, `CREATION_KEYS_BY_SCHEMA[25]`, `ROTATION_BLOCK_KEYS_BY_SCHEMA[25]`
 *   and `ENTRY_WINDOW_KEYS_BY_SCHEMA[25]` all equal `[24]`.
 *
 *   **NO EXISTING FIELD MOVES.** Every `…OfFees` figure is the identical quantity it was at schema
 *   24 and may be pooled across the boundary, `closedInWindow` is unchanged and is exactly
 *   `positionOutcome === 'exited'`, and no threshold moved — a schema-24 and a schema-25 run over
 *   the same inputs reach byte-identical verdicts. What is added sits BESIDE them.
 *
 *   **Why it needs a version.** Every field figure through schema 24 is computed only over positions
 *   that GOT OUT: a position entered and never exited was dropped from the denominator rather than
 *   resolved. Over the same 32 launches and the same 265 create-slot outsider positions of the
 *   committed tape, fee-inclusive, conditioning on exiting reads 80/158 positive and **+108.28 SOL**
 *   while counting every position taken reads 86/265 and **−8.12 SOL** — a nested-subset comparison,
 *   not two pooled populations, and the 107 that never got out are worth −116.40 SOL between them.
 *   **And they are not unknowns: 7 of 140 priced unexited entries are above water even marked at the
 *   token's LATEST known price**, so the schema-≤24 denominator deletes losers rather than
 *   unknowns and is OPTIMISTIC rather than conservative. A consumer must be able to tell a record
 *   that carries both constructions from one that carries only the flattering one, and no schema-24
 *   field says which. (`slot-zero-stage3-exit-design` → `report.md` §§5.3, 5.4, held in firstmate's
 *   records, not in this repo.)
 *
 *   **The three outcomes, and the two that used to be one value.** `entry.mjs` → `POSITION_OUTCOMES`
 *   owns the rule. `exited` is a realized figure; `still-held-at-horizon` is resolved at **zero
 *   recovery** — the worst case for the part we cannot see, which is what the captain's standing
 *   evidence bar asks a figure to survive — with `residualMarkedSolAtWindowLastPriceGrossOfFees` reported
 *   BESIDE it and never instead of it; `horizon-not-observed` is OUR COVERAGE, resolved neither way,
 *   counted and surfaced and **not filterable** under captain decision 174b. `fieldOpenPositions` is
 *   the sum of the last two, which is precisely the conflation this version splits.
 *
 *   **Two denominators that are not the same and are never pooled.** The gross all-positions figures
 *   are over every resolvable position; the NET ones are over the subset whose WHOLE window the cost
 *   leg priced — every transaction the wallet appears in across the window was already in the priced
 *   target set, which admits the create slot and any transaction carrying a wallet that closed, so a
 *   wallet that sold INSIDE its create slot is in scope and a wallet bundled with a closed one is
 *   priced whole. The selection is non-random and its direction is UNMEASURED
 *   (`entry.mjs` → `NET_ALL_POSITIONS_SELECTION_CAVEAT`), so the gap between the two readings is not
 *   a fee cost. `entryCostTargets` was deliberately NOT widened — that would spend RPC requests this correction
 *   is not authorised to spend — so the shortfall is stated by `fieldHitRateOverAllPositionsNetOfMeasuredFees.n`
 *   rather than being closed.
 *
 *   **Every rate added here carries its exact (Clopper–Pearson) interval** as `lo`/`hi` beside
 *   `rate`; `tools/deployer-screen/stats.mjs` is the one implementation, shared with the
 *   2026-08-10 measurement that first needed it. The pre-existing three-key `HitRate` shape is
 *   untouched, because four earlier versions pin it and a consumer version-detects on it.
 *
 *   **What it costs: nothing, in every currency**, on the same terms as schema 24 — every input was
 *   already in the fill walk's response and in the cost leg's output, and Stage 2's keyless ceiling
 *   (`maxCandidatesScored` × `maxLaunchesPerCandidate` × `maxRequestsPerLaunch`) cannot move.
 *
 *   **It decides NOTHING, and that is what makes it safe to land.** No bar, gate, threshold,
 *   predicate or verdict reads one of these fields and a test pins that — the shape captain decision
 *   208b established for `entry.roomLeftBound`. **And it is NOT a profit verdict**: two cost terms
 *   are still unbounded (the separate-transaction landing tip, and what it costs to try and fail to
 *   land), and under the captain's evidence bar an unbounded cost forbids one. This version produces
 *   the number; making it rulable is a later increment.
 *
 * - **26** — captain decision 466, Stage 3 increment 2: **the subtraction ledger, and a
 *   realized-profit verdict that is a FUNCTION of it.** Two keys on the `entry` block, `costLedger`
 *   and `exitVerdict`, plus four counters inside `entry.coverage.cost` (`launchesSlotObserved`,
 *   `slotFailedAttempts`, `slotFailedAttemptFeeSol`, `slotTipSol`). No candidate ROW field and no
 *   run-level block: `PERSISTED_BY_SCHEMA[26]`, `SPEND_KEYS_BY_SCHEMA[26]`, `DUNE_KEYS_BY_SCHEMA[26]`,
 *   `CREATION_KEYS_BY_SCHEMA[26]`, `ROTATION_BLOCK_KEYS_BY_SCHEMA[26]`, `ENTRY_WINDOW_KEYS_BY_SCHEMA[26]`
 *   and `ENTRY_ENTRANT_KEYS_BY_SCHEMA[26]` all equal `[25]`.
 *
 *   **NO EXISTING FIELD MOVES AND NOTHING GATES ON THE NEW ONES.** A schema-25 and a schema-26 run
 *   over the same inputs reach byte-identical `entry.verdict`s, no threshold moved, and a test pins
 *   both — the shape 208b established and 461 repeated. `exitVerdict` is Stage 3's vocabulary
 *   (`bounds.mjs` → `EXIT_VERDICTS`) and is never `entry.verdict`'s: every value of that one is a
 *   statement about ENTRY.
 *
 *   **Why it needs a version.** *"No profit verdict may be issued while a cost term is unbounded"*
 *   was a sentence in a doc comment and a clause inside a caveat string — a hand-maintained
 *   condition, the shape this tree has watched go stale twice. It is arithmetic now: one typed row
 *   per component, and `bounds.mjs` → `exitVerdict` returns `exit-unbounded` whenever any `cost` row
 *   has `worstCaseSol === null`. A record carrying the rows can be audited for WHICH terms were
 *   unbounded when it was written; a schema-≤25 one cannot, and its absence of a ledger is not the
 *   same statement as an empty one.
 *
 *   **What became a number, and what did not.** The create slot's own failed-attempt fee bill (exact
 *   `meta.fee`, base plus priority, over every landed-but-FAILED transaction touching the launch's
 *   mint — Solana charges fees on inclusion rather than on success) and the SOL arriving at a
 *   published Jito tip account in that slot. Both come out of the `getBlock` response the cost leg
 *   already fetched, so this costs **zero vendor requests, zero credits and zero wall clock**, and
 *   Stage 2's keyless ceiling cannot move. Both are **whole-slot totals used as per-position
 *   CEILINGS** — they over-attribute grossly on purpose, which is what a worst case is for, and they
 *   are not attributions of anything to anybody.
 *
 *   **THREE cost rows stay `null`**, so a profit verdict is still not issuable for a general
 *   deployer: tips outside the create-slot bound, attempts outside the create slot (captain decision
 *   466 declined to raise `stage2_cost.maxRpcRequestsPerCandidate`, so this one is deliberate and
 *   not an oversight), and exit-side fees outside the walked horizon. Hence the verdict names its own
 *   scope — `…-create-slot-costs-only` — so a reader who sees only the verdict string cannot mistake
 *   it for a whole-window cost accounting. And it fails towards refusal: where the cost walk falls
 *   back to per-signature reads there is no observation, the create-slot rows go back to `null`, and
 *   the verdict stays `exit-unbounded`.
 *
 * ## Schema 27 — WHICH ARM ADMITTED THIS CANDIDATE (captain decision 451, 2026-08-11)
 *
 * A deployer the competence gate REFUSES can now reach Stage 2 through a second admission arm
 * (`admission.mjs`), because all six `entry-open-after-costs` verdicts this project has produced
 * come from that population while every population the gate admits has returned zero. The version
 * exists because the record has to be able to keep the two apart:
 *
 * - **A fourth `verdict` value, `sub-gate-admitted`**, and it is a value rather than a flag so that
 *   nothing already counting `gate-passed` can pick these up. **`gateFailedCount` is therefore not
 *   the same quantity at 26 and 27** — a wallet the second arm admits was `gate-failed` before and
 *   is not now — and `subGateAdmittedCount` beside it is what a reader compares across the boundary.
 * - **`admissionArm` on the candidate row**, derived from the verdict so the two cannot disagree.
 * - **`subGate` on the candidate row**, `null` unless the arm decided something: whether it
 *   admitted, why not when it did not, the two quantities it read (launch tempo, days since the
 *   last launch) and THE BOUNDS IT WAS JUDGED UNDER — the arm is sized against a population, so a
 *   record that quoted only today's `thresholds.json` could not say what a past run applied.
 *
 * ### THE FIELDS WHOSE POPULATION WIDENED, AND THIS LIST IS THE WHOLE OF THEM
 *
 * Stage 2 now walks whoever EITHER arm admitted, so **every field computed over the SCORED set is
 * over the ADMITTED UNION at 27 where it was over `verdict === 'gate-passed'` ALONE at ≤26.** Their
 * names, shapes and key sets are untouched, which is exactly why the change is easy to miss: a rise
 * in one of these across the boundary may be the second arm rather than a larger gate population,
 * and reading it as the latter is the misreading. The list was assembled by walking every run-level
 * and candidate-row field rather than by patching the ones review found, and it is:
 *
 * - **`scoringRotation.survivors` / `.order` / `.selected` / `.neverScoredBefore`, and
 *   `scoringCap.survivorsUnscored`** — the rotation ALLOCATES one cap over both arms.
 * - **`entryDrops.total` and every `entryDrops.byReason.*`**, and the rendered `STAGE 2 DROPS` block
 *   that shares the reduce — a tally of what the WALK refused, over whatever it walked.
 * - **`keylessRequests`, `keylessRequestsStage2`, `keylessShed`, `rpcRequests`,
 *   `rpcLoadShedEvents`** and the `spend` counters derived from them — what the run SPENT, on the
 *   population it scored.
 * - **`truncationReason`**, when the scoring cap contributed a sentence to it: the shortfall it
 *   names is admitted candidates left unscored, not gate survivors.
 * - **`entrySourceAgreement.candidates` / `.byClass`** — over the candidates carrying an agreement
 *   row, which is the scored set. `null` on every run to date, the mode being unactivated, so no
 *   committed record shows it; it is listed because the version boundary is the same one.
 *
 * **NONE OF THESE BREACHES THE NEVER-POOL RULE, and the reason is the same for all of them:** each
 * counts what the WALK did — allocation, coverage, spend — rather than what either population
 * ACHIEVED, and none is a rate. The split also stays recoverable, because every one of them is
 * decomposable through the candidate rows, each of which carries `admissionArm`. A figure about
 * outcomes is per arm at source: the run-level `predictions` block reports `byArm` and carries no
 * pooled `withClaim` / `beatable` / `notBeatable`, `measuredEntryVerdictCount` is the gate arm's
 * with `subGateMeasuredEntryVerdictCount` beside it, and `gatePassedCount` /
 * `subGateAdmittedCount` are counted apart (captain decisions 451 and 480a).
 *
 * **THIS ENUMERATION IS NOT SELF-MAINTAINING, and it has now been found incomplete twice.** A field
 * added later whose population is the scored set will not appear here by itself. What guards it is
 * `test/deployer-screen.test.ts` → "451: admitting a sub-gate candidate moves exactly the
 * documented run-level fields", which runs the screen twice over the SAME wallet — admitted by the
 * second arm once, refused by its inflow floor once — and pins the SET of run-level keys whose
 * value differs. A new field over the scored set moves in that diff and fails the pin until it is
 * listed here. **`scoringRotation` is INSIDE that pin, compared field by field** — it is the first
 * block this enumeration was found to have missed and it holds five of the fields above, so a guard
 * that skipped it could not fail on what it was built for; only `scoredAtIso` and the two state
 * digests are dropped, each an instant or a hash over one rather than a population.
 *
 * **Its reach is still a SUBSET of this list and the test says which**: on two candidates and one
 * refused window each, `keylessShed`, `rpcRequests`, `rpcLoadShedEvents`,
 * `scoringCap.survivorsUnscored`, `truncationReason` and `entrySourceAgreement` do not move at all,
 * so a regression confined to them passes. Nothing expressible closes that gap — a field can only
 * be observed to widen where the fixture makes it non-zero — and stating the residue is why this
 * paragraph exists rather than a claim that the list maintains itself.
 *
 * **Every field NOT listed above is the same quantity at 26 and 27 and may be pooled** — the
 * whole-population counts (`gated`, `prefilteredOut`, `coverage.*`) never depended on the gate's
 * verdict, and every per-candidate measurement means what it always did. No bar moved,
 * `stage1_gate.minCompletionRate` is still 0.25 and Stage 2's ceilings are untouched, since none of
 * them is a function of how many candidates were ADMITTED. **What may never be pooled is the two
 * arms** (`admission.mjs` → `ARMS_ARE_NEVER_POOLED`): they are two populations with two
 * denominators, and a figure over one of them says nothing about the other.
 *
 * **It is not a finding that the sub-gate population is profitable and must not be read as one.**
 * `thresholds.json` → `stage2_entry.justification.minFieldHitRateNet` records that measured cost is
 * a LOWER bound, so an after-cost result above a bar is an upper bound on itself.
 */
export const RECORD_SCHEMA_VERSION = 27;

/**
 * The predictions-document contract version, carried inside the document itself.
 *
 * Separate from {@link RECORD_SCHEMA_VERSION} because the two move for different reasons: a record
 * schema changes when a run measures something new, and this changes when what a prediction has to
 * say about itself changes. A grader reads both.
 */
export const PREDICTIONS_DOCUMENT_VERSION = 1;

/**
 * The comparators a prediction may use, and the only ones a grader has to implement.
 *
 * Deliberately small. Every one is decidable from a single resolved value, so a grader is a lookup
 * and a comparison rather than an expression evaluator — which is what keeps the claim auditable by
 * reading it. `between` reads `value` as a two-element `[lo, hi]`, inclusive at both ends.
 */
export const PREDICTION_COMPARATORS = ['<', '<=', '>', '>=', '==', 'between', 'includes'];

/**
 * The readings a prediction may be about.
 *
 * `gate` is the creation-derived merged history `screen.mjs` gates on by default; `vendor-page` is
 * MadeOnSol's 70-record `profile.pump_tokens` listing, which `--ownership-only` and `feed.mjs` read.
 * `not-a-rate` is for a prediction about something that is not a completion rate at all — a count, a
 * spend, an overlap — and it is spelled out rather than left implicit so that omitting `reading`
 * stays an error.
 *
 * **`gate` NARROWED at record schema 19 and the name did not move** (captain decision 351): it is
 * now the NON-MAYHEM slice of that merged history, since a mayhem-mode launch is excluded from both
 * sides of the rate. The name stays because the reading it distinguishes itself from — the vendor
 * page — is unchanged, and a fourth value would imply the two eras are separately predictable when
 * a record already dates itself. A grader comparing a claim made against a schema-≤18 record with
 * one made against a schema-19 record is comparing two quantities: read `schemaVersion` beside
 * `reading`.
 */
export const PREDICTION_READINGS = ['gate', 'vendor-page', 'not-a-rate'];

/**
 * The DERIVED quantities a prediction may name, and the only ones a grader has to compute.
 *
 * A dotted path reaches any scalar the record already holds, and the questions worth predicting are
 * mostly not scalars the record holds: *how many candidates did this leg admit* is a count over
 * `candidates[]`, not a field. Leaving those to prose would have made the interesting half of every
 * prediction ungradeable, and letting a document carry its own expression would have made a grader
 * an interpreter. So the vocabulary is fixed here, named `derived:` at the call site, and each entry
 * is one line of arithmetic a reader can check.
 *
 * **Every rate metric names its READING in its own name** — `Gate` for the creation-derived merged
 * history `screen.mjs` gates on, `VendorPage` for MadeOnSol's 70-record listing. The two differ by
 * an order of magnitude on the same wallets, so a metric called `medianCompletionRate` would be the
 * exact ambiguity captain decision 231a was taken to remove.
 *
 * `VendorMinusGate` is the one that is a comparison rather than a count: per candidate, the vendor
 * page's rate minus the gate reading's. It is POSITIVE when the vendor's own surface flatters a
 * wallet relative to what it created — which is the observable that says whether a screen is
 * importing the vendor's ranking or finding deployers that ranking has passed over.
 *
 * @type {Record<string, (record: Record<string, unknown>) => number | null>}
 */
export const DERIVED_PREDICTION_METRICS = {
  gatePassedCount: (r) => countVerdict(r, 'gate-passed'),
  gateFailedCount: (r) => countVerdict(r, 'gate-failed'),
  gateUnmeasuredCount: (r) => countVerdict(r, 'gate-unmeasured'),
  /**
   * Candidates the SECOND ADMISSION ARM admitted — captain decision 451, record schema 27.
   *
   * **Its own metric and never added to `gatePassedCount`.** The two arms are two populations with
   * two denominators (`admission.mjs` → `ARMS_ARE_NEVER_POOLED`), so a prediction about one says
   * nothing about the other and there is deliberately no metric here that sums them. It reads 0 on
   * every schema-≤26 record, which is exact rather than a default: nothing before 27 could admit
   * through this arm — but note the mirror image, that a schema-≤26 `gateFailedCount` counts
   * wallets a schema-27 run files under this metric instead.
   */
  subGateAdmittedCount: (r) => countVerdict(r, 'sub-gate-admitted'),
  /** Candidates clearing `minTokens` and `minSpanDays` — the population the rate bar then judges. */
  gateEligibleCount: (r) => {
    const t = gateThresholdsOf(r);
    if (t === null) return null;
    return candidatesOf(r).filter(
      (c) => numberOr(c['tokens']) >= t.minTokens && numberOr(c['spanDays']) >= t.minSpanDays,
    ).length;
  },
  /** Candidates whose GATE-reading rate clears the pinned bar, whatever the other two bars did. */
  gateReadingClearingBarCount: (r) => {
    const t = gateThresholdsOf(r);
    if (t === null) return null;
    return candidatesOf(r).filter((c) => numberOr(c['completionRate']) >= t.minCompletionRate).length;
  },
  /** The same bar applied to the VENDOR PAGE rate. A different quantity, deliberately named as one. */
  vendorPageClearingBarCount: (r) => {
    const t = gateThresholdsOf(r);
    if (t === null) return null;
    return candidatesOf(r).filter((c) => numberOr(c['vendorCompletionRate']) >= t.minCompletionRate).length;
  },
  medianGateCompletionRate: (r) => median(candidatesOf(r).map((c) => c['completionRate'])),
  medianVendorPageCompletionRate: (r) => median(candidatesOf(r).map((c) => c['vendorCompletionRate'])),
  medianVendorMinusGateRate: (r) => median(vendorMinusGate(candidatesOf(r))),
  /**
   * **THE GATE ARM'S ONLY, despite the name, and the name is deliberately not changed.** It
   * predates captain decision 451's second arm, and a metric name is a contract a committed
   * predictions document holds this tool to — renaming it would silently invalidate documents
   * written against it. What matters is that it stays over ONE population: pooling the sub-gate arm
   * in here would give this median two denominators, which is the one thing 451 forbids. A sub-gate
   * reading of the same comparison would be a new metric, not a widening of this one.
   */
  admittedMedianVendorMinusGateRate: (r) =>
    median(vendorMinusGate(candidatesOf(r).filter((c) => c['verdict'] === 'gate-passed'))),
  /** Candidates the two readings disagreed about — the size of what the gate reading changed. */
  verdictChangedCount: (r) => candidatesOf(r).filter((c) => c['verdictChanged'] === true).length,
  /**
   * Scored candidates carrying a MEASURED entry verdict. `entry-unmeasured` is no answer, never one.
   *
   * **THE GATE ARM'S ONLY, despite the name, and the name is deliberately not changed** — captain
   * decision 480a, the same reasoning as `admittedMedianVendorMinusGateRate` above. It predates
   * captain decision 451's second arm, and a metric name is a contract a committed predictions
   * document holds this tool to, so renaming it would silently invalidate documents written against
   * it. `subGateMeasuredEntryVerdictCount` below is the second arm's, and there is deliberately no
   * metric that sums the two.
   */
  measuredEntryVerdictCount: (r) => measuredEntryVerdicts(r, 'gate'),
  /**
   * The same count over the SECOND ADMISSION ARM — captain decision 451, split out by 480a.
   *
   * Reads 0 on every schema-≤25 record, which is exact rather than a default: nothing before 26
   * could admit through this arm, so a row carrying no `admissionArm` is the gate arm's and never an
   * unknown one.
   */
  subGateMeasuredEntryVerdictCount: (r) => measuredEntryVerdicts(r, 'sub-gate'),
};

/**
 * Candidates of ONE admission arm whose `entry` block carries a measured verdict.
 *
 * Written once and taken twice rather than as two filters, so the two arms' counts cannot drift into
 * measuring different things — which is the failure a split by arm exists to prevent.
 *
 * @param {Record<string, unknown>} record
 * @param {'gate' | 'sub-gate'} arm
 * @returns {number}
 */
function measuredEntryVerdicts(record, arm) {
  return candidatesOf(record).filter((c) => {
    // An ABSENT `admissionArm` is the gate arm, exactly (see the metric docs above), so the
    // comparison is against `'sub-gate'` alone rather than against both spellings.
    const rowArm = c['admissionArm'] === 'sub-gate' ? 'sub-gate' : 'gate';
    if (rowArm !== arm) return false;
    const e = c['entry'];
    if (typeof e !== 'object' || e === null) return false;
    const v = /** @type {Record<string, unknown>} */ (e)['verdict'];
    return typeof v === 'string' && v !== 'entry-unmeasured';
  }).length;
}

/** @param {Record<string, unknown>} record @returns {Record<string, unknown>[]} */
function candidatesOf(record) {
  const cs = record['candidates'];
  return Array.isArray(cs) ? /** @type {Record<string, unknown>[]} */ (cs.filter((c) => typeof c === 'object' && c !== null)) : [];
}

/** @param {Record<string, unknown>} record @param {string} verdict @returns {number} */
function countVerdict(record, verdict) {
  return candidatesOf(record).filter((c) => c['verdict'] === verdict).length;
}

/**
 * The gate's own pinned bars, as the record carries them.
 *
 * Read from the record rather than from `thresholds.json`, because a prediction is graded against
 * the run that made it and a later build's bars are a different question.
 *
 * @param {Record<string, unknown>} record
 * @returns {{ minTokens: number, minCompletionRate: number, minSpanDays: number } | null}
 */
function gateThresholdsOf(record) {
  const t = record['thresholds'];
  if (typeof t !== 'object' || t === null) return null;
  const g = /** @type {Record<string, unknown>} */ (t)['stage1_gate'];
  if (typeof g !== 'object' || g === null) return null;
  const gate = /** @type {Record<string, unknown>} */ (g);
  const [minTokens, minCompletionRate, minSpanDays] = ['minTokens', 'minCompletionRate', 'minSpanDays'].map(
    (k) => gate[k],
  );
  if (typeof minTokens !== 'number' || typeof minCompletionRate !== 'number' || typeof minSpanDays !== 'number') {
    return null;
  }
  return { minTokens, minCompletionRate, minSpanDays };
}

/** A missing or non-numeric field is `-Infinity`, so it fails a floor rather than passing one. */
function numberOr(/** @type {unknown} */ v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
}

/** Per candidate, vendor-page rate minus gate-reading rate; candidates missing either are dropped. */
function vendorMinusGate(/** @type {Record<string, unknown>[]} */ candidates) {
  return candidates
    .filter((c) => typeof c['vendorCompletionRate'] === 'number' && typeof c['completionRate'] === 'number')
    .map((c) => /** @type {number} */ (c['vendorCompletionRate']) - /** @type {number} */ (c['completionRate']));
}

/**
 * Linear-interpolated median. `null` on an empty sample — never 0, which is a reading.
 *
 * Spelled out because a grader has to reproduce it exactly: sort ascending, take the midpoint, and
 * on an even count average the two around it.
 *
 * @param {readonly unknown[]} values
 * @returns {number | null}
 */
function median(values) {
  /** @type {number[]} */
  const xs = [];
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) xs.push(v);
  xs.sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = (xs.length - 1) / 2;
  const lo = xs[Math.floor(mid)];
  const hi = xs[Math.ceil(mid)];
  if (lo === undefined || hi === undefined) return null;
  return (lo + hi) / 2;
}

/**
 * Resolve a prediction's `metric` against a run record.
 *
 * Two forms, one resolver. A dotted path with `[n]` for array indices reaches a scalar the record
 * already holds — `coverage.gated`, `candidates[0].completionRate`. A `derived:` name reaches one of
 * {@link DERIVED_PREDICTION_METRICS}, which is where the counts and medians live that a record
 * carries the ingredients for but not the answer to.
 *
 * Either way this is the ONE resolver, so a grader reads the field the prediction named and not one
 * it re-derived. A path that does not resolve returns `undefined`, which a grader must treat as
 * UNGRADEABLE rather than as a miss — the same distinction the whole record keeps everywhere else:
 * not looking is not a measured negative. `null` is different again and is a reading: an empty
 * median, an absent block.
 *
 * @param {unknown} record
 * @param {string} path
 * @returns {unknown}
 */
export function resolvePredictionMetric(record, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  if (path.startsWith('derived:')) {
    const fn = Object.prototype.hasOwnProperty.call(DERIVED_PREDICTION_METRICS, path.slice('derived:'.length))
      ? DERIVED_PREDICTION_METRICS[path.slice('derived:'.length)]
      : undefined;
    if (fn === undefined) return undefined;
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
    return fn(/** @type {Record<string, unknown>} */ (record));
  }
  /** @type {unknown} */
  let node = record;
  for (const step of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(step);
    if (match === null) return undefined;
    const [, name = '', indices = ''] = match;
    if (name !== '') {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(node, name)) return undefined;
      node = /** @type {Record<string, unknown>} */ (node)[name];
    }
    for (const raw of indices.match(/\d+/g) ?? []) {
      if (!Array.isArray(node)) return undefined;
      node = node[Number(raw)];
    }
  }
  return node;
}

/**
 * Read and validate a predictions document.
 *
 * **Shape only.** It cannot tell a prediction from a postdiction and does not pretend to — see the
 * schema-17 note above. What it does refuse is a document that could not be graded at all, and it
 * refuses BEFORE the run spends anything, because a run that discovered its own predictions were
 * unreadable after burning the keyed allowance would have to be re-run to get them back.
 *
 * @param {string} text Raw file contents.
 * @param {string} source Path it came from, recorded so the record names its own provenance.
 * @returns {{ ok: true, predictions: Record<string, unknown> } | { ok: false, message: string }}
 */
export function readPredictions(text, source) {
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (cause) {
    return { ok: false, message: `${source} is not valid JSON: ${cause instanceof Error ? cause.message : cause}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, message: `${source} must hold a JSON object` };
  }
  const d = /** @type {Record<string, unknown>} */ (doc);

  // The block is carried verbatim, so the reader may not overwrite a field the document declares.
  // `source` is the one field it supplies itself, from the path — a document declaring its own would
  // be silently replaced, which is the single place "verbatim" would stop being literally true.
  if (Object.prototype.hasOwnProperty.call(d, 'source')) {
    return {
      ok: false,
      message: `${source} declares \`source\`, which is set by the reader from the path it was read from and may not be declared`,
    };
  }

  if (d['documentVersion'] !== PREDICTIONS_DOCUMENT_VERSION) {
    return {
      ok: false,
      message: `${source} declares documentVersion ${JSON.stringify(d['documentVersion'])}; this build writes ${PREDICTIONS_DOCUMENT_VERSION}`,
    };
  }
  for (const key of ['lane', 'leg', 'madeAtIso', 'basis']) {
    if (typeof d[key] !== 'string' || /** @type {string} */ (d[key]).length === 0) {
      return { ok: false, message: `${source} needs a non-empty string \`${key}\`` };
    }
  }
  if (Number.isNaN(Date.parse(/** @type {string} */ (d['madeAtIso'])))) {
    return { ok: false, message: `${source} has an unparseable madeAtIso` };
  }

  const rows = d['predictions'];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, message: `${source} needs a non-empty \`predictions\` array` };
  }

  /** @type {Set<string>} */
  const ids = new Set();
  for (const [i, row] of rows.entries()) {
    const at = `${source} predictions[${i}]`;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return { ok: false, message: `${at} must be an object` };
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    for (const key of ['id', 'statement', 'rationale']) {
      if (typeof r[key] !== 'string' || /** @type {string} */ (r[key]).length === 0) {
        return { ok: false, message: `${at} needs a non-empty string \`${key}\`` };
      }
    }
    const id = /** @type {string} */ (r['id']);
    if (ids.has(id)) return { ok: false, message: `${at} repeats the id ${JSON.stringify(id)}` };
    ids.add(id);

    // The 231a rule, enforced rather than documented: a prediction about a completion rate that
    // does not name the reading is not gradeable, and defaulting one would reintroduce exactly the
    // ambiguity that decision was taken to remove.
    if (!PREDICTION_READINGS.includes(/** @type {string} */ (r['reading']))) {
      return { ok: false, message: `${at} needs \`reading\` to be one of ${PREDICTION_READINGS.join(' | ')}` };
    }

    const metric = r['metric'];
    if (metric === null) {
      // A claim no record can resolve is legitimate and stays in the document — but it must not
      // carry a comparator, or a grader would try to evaluate what it cannot read.
      if (r['comparator'] !== null || r['value'] !== null) {
        return { ok: false, message: `${at} has metric: null, so comparator and value must be null too` };
      }
      continue;
    }
    if (typeof metric !== 'string' || metric.length === 0) {
      return { ok: false, message: `${at} needs \`metric\` to be a dotted record path, a derived: name, or null` };
    }
    // A `derived:` name a grader cannot compute is refused HERE rather than at grading time, where
    // it would be indistinguishable from a path that simply did not resolve — i.e. from ungradeable
    // — and a typo would quietly become "we could not tell" instead of "this document is wrong".
    if (metric.startsWith('derived:')) {
      const name = metric.slice('derived:'.length);
      if (!Object.prototype.hasOwnProperty.call(DERIVED_PREDICTION_METRICS, name)) {
        return {
          ok: false,
          message: `${at} names an unknown derived metric ${JSON.stringify(name)}; known: ${Object.keys(DERIVED_PREDICTION_METRICS).join(', ')}`,
        };
      }
    }
    const comparator = r['comparator'];
    if (!PREDICTION_COMPARATORS.includes(/** @type {string} */ (comparator))) {
      return { ok: false, message: `${at} needs \`comparator\` to be one of ${PREDICTION_COMPARATORS.join(' ')}` };
    }
    if (comparator === 'between') {
      const v = r['value'];
      if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== 'number')) {
        return { ok: false, message: `${at} uses \`between\`, so \`value\` must be [lo, hi] numbers` };
      }
      if (/** @type {number} */ (v[0]) > /** @type {number} */ (v[1])) {
        return { ok: false, message: `${at} has a \`between\` range whose lo exceeds its hi` };
      }
      continue;
    }
    const value = r['value'];
    if (value === undefined || (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')) {
      return { ok: false, message: `${at} needs a number, string or boolean \`value\`` };
    }
  }

  return { ok: true, predictions: { ...d, source } };
}

/**
 * Completeness of a run, as the record can actually support.
 *
 * `unknown` is a first-class answer, not an error and not a default.
 *
 * @typedef {'complete' | 'incomplete' | 'unknown'} Completeness
 */

/**
 * Resolve whether a run reached the end, honouring the three-state contract.
 *
 * Deliberately reads **only** `completed`. Every other field that hints at incompleteness describes
 * coverage rather than termination, so inferring from one would be the silent collapse this contract
 * exists to forbid.
 *
 * @param {unknown} record A parsed run record of any schema version.
 * @returns {Completeness}
 */
export function completenessOf(record) {
  if (typeof record !== 'object' || record === null) return 'unknown';
  const completed = /** @type {Record<string, unknown>} */ (record)['completed'];
  if (completed === true) return 'complete';
  if (completed === false) return 'incomplete';
  return 'unknown';
}

/**
 * Schema version of a record, with absence meaning 1.
 *
 * @param {unknown} record
 * @returns {number}
 */
export function schemaVersionOf(record) {
  if (typeof record !== 'object' || record === null) return 1;
  const v = /** @type {Record<string, unknown>} */ (record)['schemaVersion'];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 1;
}

/**
 * A sentence a human or a log line can carry, for each of the three states.
 *
 * Exists so the `unknown` case has somewhere honest to go instead of being rounded off at the point
 * of use.
 *
 * @param {Completeness} c
 * @returns {string}
 */
export function describeCompleteness(c) {
  switch (c) {
    case 'complete':
      return 'the run reached the end; every candidate it gated was evaluated';
    case 'incomplete':
      return 'the run stopped early, so nothing in it is a measured negative';
    default:
      return (
        'UNKNOWN — this record predates the `completed` field (schema 1). Whether the run finished ' +
        'cannot be recovered from it, and must not be guessed from `truncated`'
      );
  }
}

/** A whole URL. This client's trade URLs embed the mint, so a URL in free text is a leak. */
const URL_SHAPED = /\bhttps?:\/\/\S+/gi;

/**
 * A Solana-style base58 run. Mints and wallets are 32–44 characters from this alphabet, which
 * excludes `0`, `O`, `I` and `l` — so ordinary English prose does not match it.
 */
const BASE58_SHAPED = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/**
 * Strip vendor-derived identifiers out of a free-text string bound for a run record.
 *
 * **The retention boundary, enforced in one place rather than at each call site.** MadeOnSol terms
 * §5a(d) and this tool's own containment claim say a run record carries our derived arithmetic and
 * no per-token vendor record — but free text is how that leaks, and it leaks by accident: an error
 * message, a note built from one, a URL in a stack. The concrete case this exists for is a
 * transport failure on a launch walk, where the thrown message carried
 * `swap-api.pump.fun/v2/coins/<MINT>/trades` straight into `coverage.dropNotes` and out to `--out`.
 * The committed-record test only forbade mint-shaped *keys*, so a mint inside a sentence passed it.
 *
 * **Applied to named fields, not to every free-text field a record persists.** Covered today: the
 * entry half's `rationale`, `caveats` and `dropNotes` (`stage2.mjs` → `toEntryRecordRow`); the gate
 * half's `rationale`, `gateReasons` and `consistency.note` (`screen.mjs` → `toRecordRow`); and the
 * run-level `truncationReason`; the creation half's `stopDetail` and `listingUnmeasuredNote`
 * (`screen.mjs` → `toRecordRow`, via {@link redactCreationNotes}); and every run-level
 * `unmeasured[]` entry's `detail`, redacted at construction in {@link unmeasuredBecause} and
 * {@link unmeasuredNoSource} because that is where a raw `Error.message` — the shape that carries
 * `HTTP <status> on <url>` out of a client — enters the record. `README.md` → "Nothing
 * vendor-derived survives in a note, either" owns the long form, so read it before adding a note
 * field. Structured fields are not passed through it —
 * a candidate's own `wallet` is public on-chain data we deliberately keep, and it is stored as a
 * field precisely so it is never confused with an incidental one.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactVendorIdentifiers(text) {
  return String(text).replace(URL_SHAPED, '[url redacted]').replace(BASE58_SHAPED, '[address redacted]');
}

/**
 * {@link redactVendorIdentifiers} over a list of free-text lines.
 *
 * @param {readonly string[]} lines
 * @returns {string[]}
 */
export function redactAll(lines) {
  return lines.map((l) => redactVendorIdentifiers(l));
}

/**
 * {@link redactVendorIdentifiers} over the creation block's two FREE-TEXT fields, on the way into a
 * record.
 *
 * `stopDetail` is a raw upstream `Error.message` and is therefore the dangerous one: it carries
 * whatever the transport put in it, and `pumpfun.mjs` → `KeylessHttpError` formats
 * `HTTP <status> on <url>` — which is precisely how a per-wallet URL reached a committed record.
 * `listingUnmeasuredNote` is built from an {@link Unmeasured} entry's summary and detail, so it
 * inherits the same exposure one hop further along.
 *
 * **NOT A BLANKET SWEEP over the block.** Every other field here is structured — counts, ISO
 * timestamps, an enum `stopReason` — and the record's `wallet` one level up is a 44-character
 * base58 string this record deliberately keeps, of exactly the shape
 * {@link redactVendorIdentifiers} strikes. Only the two free-text fields are routed, by name.
 *
 * @template {{ stopDetail: string | null, listingUnmeasuredNote: string | null }} T
 * @param {T | null} creation
 * @returns {T | null}
 */
export function redactCreationNotes(creation) {
  if (creation === null) return null;
  return {
    ...creation,
    stopDetail: creation.stopDetail == null ? null : redactVendorIdentifiers(creation.stopDetail),
    listingUnmeasuredNote:
      creation.listingUnmeasuredNote == null
        ? null
        : redactVendorIdentifiers(creation.listingUnmeasuredNote),
  };
}

/**
 * Why a measurement could not be taken.
 *
 * These are not interchangeable and the record keeps them apart, because each one tells an operator
 * to do something different. **Asserting an inaccurate cause is worse than asserting none**: a
 * record that says "we retried" when no retry was made is exactly the class of defect the honesty
 * rule above exists to prevent, so a cause that cannot be identified is reported as unidentified
 * rather than rounded to the likeliest story.
 *
 * Not every unmeasured thing is a failed request. `no-source` is the case where every request
 * succeeded and no surface we are entitled to read carries the fact — a limit of the evidence
 * rather than of the run. It is still unmeasured, and it still must not read as a measured
 * negative, which is exactly why it belongs in this vocabulary rather than being rounded into
 * `local-error` (it is not our bug) or `unclassified` (the cause is known precisely).
 *
 * @typedef {'budget-exhausted' | 'page-failure' | 'not-retried-failure' | 'vendor-refusal'
 *   | 'unparseable-body' | 'local-error' | 'no-source' | 'unclassified'} UnmeasuredKind
 */

/**
 * What each kind means, and whether it truncates the run.
 *
 * **Only the budget wall truncates.** The other kinds are still unmeasured, still recorded, and
 * still forbidden from reading as a measured negative — but the run did not stop looking, and a
 * flag that fires on every run carries no information and teaches its reader to skip it.
 *
 * @type {Record<UnmeasuredKind, { truncates: boolean, heading: string, advice: string }>}
 */
export const UNMEASURED_KINDS = {
  'budget-exhausted': {
    truncates: true,
    heading: 'BUDGET EXHAUSTED — a wall. The run stopped looking, and a rerun stops in the same place.',
    advice: 'This IS truncation and it is named in truncationReason.',
  },
  'page-failure': {
    truncates: false,
    heading: 'PAGE FAILURE — the request was retried once and the retry failed too.',
    advice: 'The run continued. A rerun may well succeed.',
  },
  'not-retried-failure': {
    truncates: false,
    heading: 'NOT RETRIED — the request failed and this client was configured not to retry it.',
    advice: 'The cause is known; only the retry is missing. Reachable only with retries disabled.',
  },
  'vendor-refusal': {
    truncates: false,
    heading: 'VENDOR REFUSAL — the endpoint answered on the first attempt and we did NOT retry it.',
    advice: 'A plain rerun is not expected to change it; check whether the endpoint moved.',
  },
  'unparseable-body': {
    truncates: false,
    heading: 'UNPARSEABLE BODY — the request was served, but the body was not JSON.',
    advice: 'Blame is NOT assigned: check first for an edge interstitial or error page behind a 200.',
  },
  'local-error': {
    truncates: false,
    heading: 'LOCAL ERROR — this failed in our own code, having never reached the endpoint.',
    advice: 'No request was retried and one may never have been made. This is our bug to fix.',
  },
  'no-source': {
    truncates: false,
    heading: 'NO SOURCE COULD ANSWER — every request succeeded and no surface carries the fact.',
    advice: 'A limit of the evidence, not of the run. A plain rerun reaches the same silence.',
  },
  unclassified: {
    truncates: false,
    heading: 'UNCLASSIFIED — the cause could not be identified.',
    advice: 'Nothing is claimed about it, deliberately: a guessed cause is worse than none.',
  },
};

/**
 * What an entry means when its `kind` is not in {@link UNMEASURED_KINDS}.
 *
 * This module is the one that has to survive version skew — `completenessOf` and `schemaVersionOf`
 * already degrade rather than throw on records they do not recognise — and a record written by a
 * newer build, or a kind added later, must not take the whole record build down with a TypeError.
 * It does not truncate: inventing a wall from a label this build cannot read would be asserting a
 * cause we do not have.
 */
export const UNRECOGNISED_KIND = {
  truncates: false,
  heading: 'UNRECOGNISED KIND — written by a build that knew something this one does not.',
  advice: 'Shown rather than dropped, and nothing is claimed about it beyond its own summary.',
};

/**
 * The meaning of a kind, falling back to {@link UNRECOGNISED_KIND} rather than throwing.
 *
 * @param {string} kind
 * @returns {{ truncates: boolean, heading: string, advice: string }}
 */
export function kindMetaOf(kind) {
  return Object.prototype.hasOwnProperty.call(UNMEASURED_KINDS, kind)
    ? UNMEASURED_KINDS[/** @type {UnmeasuredKind} */ (kind)]
    : UNRECOGNISED_KIND;
}

/**
 * One measurement the run could not take, and why.
 *
 * `summary` and `detail` are split on purpose. The summary is **wallet-independent** — it names the
 * kind, the measurement and the status class and nothing else — so it is safe to group on. The
 * detail is the cause's own message, routed through {@link redactVendorIdentifiers} at construction
 * in {@link unmeasuredBecause} / {@link unmeasuredNoSource}, so the URL that used to sit in it is
 * struck. It still varies with the cause rather than with the kind, so it must never become a
 * grouping key: keying on it gives near-identical failures their own lines and buries the one
 * sentence that matters.
 *
 * @typedef {object} Unmeasured
 * @property {string} measurement       What was not measured, named as the record names it.
 * @property {string} subject           The wallet it was not measured for.
 * @property {UnmeasuredKind} kind      What actually happened.
 * @property {string} summary           Stable across wallets. The grouping key.
 * @property {string | null} detail     The redacted cause. Varies per failure; never a grouping key.
 */

/**
 * Classify a failed measurement pass by **what actually happened**, from the evidence the client
 * attached to the exception rather than from a guess about it.
 *
 * @param {unknown} cause
 * @returns {UnmeasuredKind}
 */
export function classifyUnmeasured(cause) {
  if (cause instanceof CeilingReached) return 'budget-exhausted';
  // Served, but unreadable. Neither side is established — the likeliest cause is an edge
  // interstitial behind a 200, which is the vendor's, and a bug in our handling is the other — so
  // this is its own kind rather than blame pinned on whichever we happened to guess.
  if (cause instanceof UnparseableResponse) return 'unparseable-body';
  if (cause instanceof RequestFailed) {
    // `retried` is the client's own record of what it did, so this branch can say "retried" and be
    // right. A 4xx that arrived after a retried 5xx is still a request we retried.
    if (cause.retried) return 'page-failure';
    if (cause.status !== null && cause.status >= 400 && cause.status < 500) return 'vendor-refusal';
    // Known cause, no retry. Only reachable with retries disabled, and calling it unidentifiable
    // would be inaccurate in the other direction — we know exactly what happened.
    return 'not-retried-failure';
  }
  // Every client failure leaves as a RequestFailed or an UnparseableResponse, so an Error that is
  // neither never reached the endpoint: a bug thrown inside the measurement itself.
  if (cause instanceof Error) return 'local-error';
  return 'unclassified';
}

/**
 * Record that a measurement pass could not run.
 *
 * Each kind gets its own sentence and they are not interchangeable. Only the retried kind may say
 * it was retried; only the wall may tell an operator to change a threshold; a local error says it
 * is ours. An operator acts on these sentences, and the wrong one sends them to rotate a key, raise
 * a bound, or rerun a forty-minute job for no reason.
 *
 * @param {string} measurement
 * @param {string} subject
 * @param {unknown} cause
 * @param {{ budget: string, ceiling: number, setting: string }} spent The budget the pass drew on.
 * @returns {Unmeasured}
 */
export function unmeasuredBecause(measurement, subject, cause, spent) {
  const kind = classifyUnmeasured(cause);
  const status =
    cause instanceof RequestFailed || cause instanceof UnparseableResponse ? cause.status : null;
  // A RAW `Error.message`, and therefore the one field here that can be carrying anything at all:
  // `pumpfun.mjs` → `KeylessHttpError` formats `HTTP <status> on <url>`, and this client's URLs
  // embed a wallet or a mint. Redacted at construction rather than at each persisting call site,
  // because this is the only place a caller-supplied exception becomes record text.
  const detail = redactVendorIdentifiers(cause instanceof Error ? cause.message : String(cause));

  let summary;
  switch (kind) {
    case 'budget-exhausted':
      summary =
        `the ${spent.budget} request ceiling of ${spent.ceiling} was reached, so ${measurement} ` +
        `was never looked up. Raise ${spent.setting} or lower the candidate cap; rerunning alone ` +
        `reaches the same wall`;
      break;
    case 'page-failure':
      summary =
        `a ${spent.budget} request failed with ${status === null ? 'a transport failure or timeout' : `HTTP ${status}`} ` +
        `and the one retry failed too, so ${measurement} is missing. The run continued and later ` +
        `candidates were measured normally; a rerun may well succeed`;
      break;
    case 'not-retried-failure':
      summary =
        `a ${spent.budget} request failed with ${status === null ? 'a transport failure or timeout' : `HTTP ${status}`} ` +
        `and this client was configured not to retry it, so ${measurement} is missing. The cause is ` +
        `known; only the retry is absent`;
      break;
    case 'vendor-refusal':
      summary =
        `the ${spent.budget} endpoint answered HTTP ${status} on the first attempt and we did not ` +
        `retry it, so ${measurement} is missing. That is its considered answer, so a plain rerun ` +
        `is not expected to change it — check whether the endpoint moved`;
      break;
    case 'unparseable-body':
      summary =
        `the ${spent.budget} endpoint answered HTTP ${status} but the body was not JSON, so ` +
        `${measurement} is missing. The request WAS served, so this is not attributed to either ` +
        `side: check first for an edge interstitial or error page returned behind a success status`;
      break;
    case 'local-error':
      summary =
        `${measurement} failed inside our own code, having never reached the ${spent.budget} ` +
        `endpoint, so no request was retried and one may never have been made. This is our bug, ` +
        `not the vendor's`;
      break;
    default:
      summary =
        `${measurement} is missing and the cause could not be classified, so nothing is claimed ` +
        `about why it failed or whether a rerun would help`;
  }

  return { measurement, subject, kind, summary, detail };
}

/**
 * Record that a measurement could not be taken even though nothing failed.
 *
 * The companion to {@link unmeasuredBecause}, for the case that has no exception to classify: every
 * request was served and no surface we may read carries the answer. It exists so such a case still
 * reaches the run-level `unmeasured` collection, because the rule this module enforces is about the
 * RECORD and not about the cause — a run that reports a candidate it could not judge, while its own
 * `unmeasured` reads empty and `truncated` reads false, has told its reader it measured everything.
 *
 * `sources` is the wallet-independent half and belongs in the summary; anything per-candidate goes
 * in `detail`, which is never a grouping key.
 *
 * @param {string} measurement
 * @param {string} subject
 * @param {string} sources What was asked and came back silent, stated the same way every time.
 * @param {string | null} [detail]
 * @returns {Unmeasured}
 */
export function unmeasuredNoSource(measurement, subject, sources, detail = null) {
  return {
    measurement,
    subject,
    kind: 'no-source',
    summary:
      `${measurement} could not be established: every request was served, and ${sources}. This is ` +
      `a limit of the evidence rather than of the run — no budget was reached and nothing failed, ` +
      `so a plain rerun reaches the same silence. It is NOT a negative result about this wallet`,
    // Free text supplied by a caller, so it goes through the same boundary `unmeasuredBecause`
    // applies to its own detail — the callers build it from counts today, and containment must not
    // depend on every future one remembering that.
    detail: detail === null ? null : redactVendorIdentifiers(detail),
  };
}

/**
 * The one-line reading of an unmeasured entry, detail included.
 *
 * @param {Unmeasured} u
 * @returns {string}
 */
export function describeUnmeasured(u) {
  return u.detail === null ? u.summary : `${u.summary}: ${u.detail}`;
}

/**
 * Collapse unmeasured entries onto their distinct summaries, preserving first-seen order.
 *
 * Grouped rather than listed per wallet because sixty identical lines bury the one sentence that
 * matters. The key is the wallet-independent {@link Unmeasured.summary} and never the detail. The
 * detail is redacted at construction, so it no longer embeds the per-wallet URL — but it still
 * carries whatever else the cause's message held, so it remains per-failure and keying on it would
 * still give near-identical failures a group each. Grouping that groups nothing is just a longer
 * list.
 *
 * @param {readonly Unmeasured[]} unmeasured
 * @returns {Map<string, number>}
 */
export function groupUnmeasured(unmeasured) {
  /** @type {Map<string, number>} */
  const groups = new Map();
  for (const u of unmeasured) groups.set(u.summary, (groups.get(u.summary) ?? 0) + 1);
  return groups;
}

/**
 * Bucket unmeasured entries by kind, in {@link UNMEASURED_KINDS} order, omitting empty kinds.
 *
 * A kind this build does not recognise gets its own trailing bucket rather than being filtered out.
 * Dropping it would be the same defect as mislabelling it: the entry exists because something went
 * unmeasured, and a reader who cannot see it reads the run as more complete than it was.
 *
 * @param {readonly Unmeasured[]} unmeasured
 * @returns {Map<string, Unmeasured[]>}
 */
export function partitionUnmeasured(unmeasured) {
  /** @type {Map<string, Unmeasured[]>} */
  const byKind = new Map();
  for (const kind of Object.keys(UNMEASURED_KINDS)) {
    const of = unmeasured.filter((u) => u.kind === kind);
    if (of.length > 0) byKind.set(kind, of);
  }
  for (const u of unmeasured) {
    if (Object.prototype.hasOwnProperty.call(UNMEASURED_KINDS, u.kind)) continue;
    byKind.set(u.kind, [...(byKind.get(u.kind) ?? []), u]);
  }
  return byKind;
}

/**
 * Fold everything missing from a run into one truncation verdict and one sentence.
 *
 * `truncated` is "is anything missing, for any reason". `completed` — "did the run reach the end" —
 * is deliberately NOT an input and is not derivable from this: the three-state contract above turns
 * on keeping them apart. What this adds is the third source of missingness. A run can reach the end,
 * gate every candidate it planned to, and still have failed to measure something; before this, that
 * was visible only in the affected candidate's own note, so the record read `completed: true,
 * truncated: false` — a screen claiming to have measured what it had not.
 *
 * Which kinds truncate is {@link UNMEASURED_KINDS}'s to say, not this function's — only the budget
 * wall does. Everything else is still unmeasured, still recorded with its own reason, and still
 * forbidden from reading as a measured negative, but it does not declare the run truncated, because
 * the run did not stop looking. That distinction is what keeps the flag worth reading: on the
 * flakiest surface in the tool, one failed page out of up to 585 would otherwise set
 * `truncated: true` on nearly every run.
 *
 * @param {object} input
 * @param {string | null} input.abortReason  Why the run died, or null if it did not.
 * @param {{ coverageTruncated: boolean, candidateCap: number, droppedByCandidateCap: number }} input.coverage
 * @param {readonly Unmeasured[]} input.unmeasured
 * @returns {{ truncated: boolean, truncationReason: string | null }}
 */
export function deriveTruncation({ abortReason, coverage, unmeasured }) {
  /** @type {string[]} */
  const reasons = [];
  if (abortReason !== null) reasons.push(abortReason);
  if (coverage.coverageTruncated) {
    reasons.push(
      `the candidate cap of ${coverage.candidateCap} dropped ${coverage.droppedByCandidateCap} ` +
        `seeded wallet(s) before they were measured`,
    );
  }
  const truncating = unmeasured.filter((u) => kindMetaOf(u.kind).truncates === true);
  for (const [summary, n] of groupUnmeasured(truncating)) {
    reasons.push(`${n} candidate(s) went unmeasured — ${summary}`);
  }
  return {
    truncated: reasons.length > 0,
    truncationReason: reasons.length === 0 ? null : reasons.join('; '),
  };
}
