# The dual-source agreement run: what it would cost, priced before anything spends

**2026-08-06. Gate 3 precondition 4, phase 1.** This directory is the ESTIMATE and nothing else. **No
Dune execution has been billed by the lane that wrote it** — the only Dune call made was
`POST /usage`, which Dune documents as a metadata endpoint that consumes no credits, and which was
made through this repo's own `client.mjs` → `readUsage`.

Captain decision 298a is why this exists as a committed artefact rather than as a run: a Dune spend
of this shape is reviewed **before** it is paid, and the lane that proposes a spend is not the lane
that makes it. A separate worker executes the run once the captain approves a shape below.

## The balance this is priced against, and when it was read

| | |
|---|---|
| read at | **2026-08-06T11:23:27Z** |
| `credits_used` | 2,044.357 |
| `credits_included` | 2,500 |
| **`credits_remaining`** | **455.643** |
| billing period | 2026-07-29 → **2026-08-29** |
| private queries in use | **4 of 10** |

**THE BALANCE MOVES AND THIS FIGURE IS A READING, NEVER A RESERVATION.** Three limits travel with
it, all of them the `dune` block's own and none of them new here: the counter **LAGS** (measured
rising +6.0 credits while the evaluator was idle, in whole-credit jumps, so a reading over-states
what remains — hence the pinned `allowanceReserveCredits` of 25); the key is **SHARED** across every
lane in this repo, so a sufficient reading is evidence and not an allocation; and the period is a
**subscription anniversary**, not a calendar month. Anyone acting on this document must re-read
`POST /usage` at the moment of the run — `client.mjs` → `checkDuneAllowance` does exactly that
before the first billed request, and refuses rather than half-running.

**The private-query count is the one number here that unblocks something.** `CLAUDE.md` records this
account hitting the 10-slot cap on 2026-08-05, which would have meant no slot for the coverage probe
this run needs. It reads **4** today, so there are six free. That is the standing instruction
working — *re-list rather than quote it* — and this reading is itself now stale for the next reader.

## The run shape being proposed

`node tools/deployer-screen/screen.mjs --entry-source-agreement --out <path>`

| | |
|---|---|
| primary fill source | **Dune** (`dune-fills.mjs` → `ENTRY_SQL`, saved query 8235460) |
| cross-check fill source | **swap-api** (what every run reads today) |
| recipe **both** sources score at | `thresholds.json` → `stage2_entry` — 8 scored of 10 planned |
| candidates scored | **7** (`stage2_entry.maxCandidatesScored`, no flag needed) |
| windows per candidate | **10** (`stage2_entry.maxLaunchesPerCandidate`) |
| Dune windows | **70** |
| Dune executions | **71** — one per window, plus one coverage probe |

Each candidate is scored through **both** sources; the Dune reading is the one RECORDED where it
answered and the swap-api reading is recorded where it did not, with the reason on the candidate
(`entrySourceFallbackReasons`). That is `enumerationSource`'s pattern one stage over — captain
decisions 156a and 191a — rather than a second pattern invented beside it. The comparison is
recorded PER CANDIDATE on `candidates[].entryAgreement`; the run level carries **counts by class and
no rate**, because captain decision 143a established on this project that the aggregate form of this
question is untrustworthy.

**BOTH SOURCES SCORE AT ONE RECIPE, AND THAT IS THE LOAD-BEARING DESIGN CHOICE.** The two sources
carry deliberately different sampling caps — `stage2_entry` is sized on request arithmetic,
`stage2_entry_dune` on a credit bound — so scoring each at its own would make a verdict difference
uninterpretable: a candidate could differ because the fills differ, or because one reading needed 20
scored launches and the other 8. `stage2_entry` is the only one of the two the swap-api source can
afford, which makes the choice forced rather than picked. **The consequence runs against this lane
and is stated rather than buried: the Dune source is exercised at a sample SMALLER than
`stage2_entry_dune` sizes it for, so this run says nothing about whether 20-of-22 is affordable or
reachable, and no later lane may read it as evidence either way.**

## The arithmetic

### Per window

| term | expected | worst case | anchor |
|---|---|---|---|
| compute | 0.25 | 1 | the entry-statement reproduction measured **0.25 credits at a 65-second scan hull** and 1.91 at 16.1 days; one opening window's hull is **~90 s** (`seekMarginMs` 5,000 + `windowReachMs` 85,000), so the worst case is ~4x the measured figure at a comparable hull |
| retrieval | 1.753 | 15.6 | `rows x bytes/row x 20 credits/MB`. **Expected**: 381 rows (the committed tape's **median** opening window) x **230 B/row** (measured: 24.7 MB over 107,439 rows, `measurements/2026-08-05-dune-entry-reproduction/`) = 87,630 B = 1.753. **Worst**: 3,000 rows (`maxResultRowsPerWindow`) x 260 B (`resultBytesPerRowCeiling`, the measured 230 at a 1.13 margin) = 780,000 B = 15.6 |
| **per window** | **~2.0** | **17** (pinned) | |

**Retrieval is ~95% of this bill, not compute.** That is the reproduction's own finding, and it
inverts `stage2_entry_dune`'s "the lever is windows scanned" without contradicting it: that block's
statement returns one aggregated row per launch, and this one returns every fill.

**The expected figure errs HIGH, deliberately.** 381 fills is the median window of *our subject* — a
deployer whose create slot carries an ~85 SOL dev buy. The strangers this run scores are far
quieter: the 2026-08-04 proof-coverage probe found their create slots holding 1–10 buy transactions
with the whole non-deployer stake at 0.067 SOL or nothing. A stranger's opening window plausibly
holds tens of fills rather than hundreds, so the real bill should come in **below** the expected
column, not above it.

### Per run

| | expected | worst case |
|---|---|---|
| 70 windows | 70 x 2.0 = **140.1** | 70 x 17 = **1,190** |
| trade coverage probe, 1 execution | ~5 | 25 |
| **total** | **~145 credits** | **1,215 credits** |

**THE PROBE IS THE WEAKEST-ANCHORED NUMBER IN THIS DOCUMENT AND IT IS FLAGGED RATHER THAN DRESSED
UP.** `TRADE_COVERAGE_SQL` aggregates three whole decoded trade tables plus the pool-mapping table,
and **Dune publishes no price table for execution compute** — so 25 is the enumeration probe's own
`dune.worstCaseCreditsPerExecution` carried across, against tables that are orders of magnitude
larger than the create tables it was pinned for. The first execution measures it. Two things make
that acceptable: it is **one execution per billing period, not per run** (the default read is Dune's
cached result, which costs no execution), and it is bounded above by the guard like everything else.
**It cannot be a cached read the first time**, because a newly-deployed saved query has no cached
result — so whoever runs this pays one refresh execution and should record what it actually cost.

## What the guard does with these numbers TODAY, and it refuses the proposed shape

`client.mjs` → `decideAllowance` prices the **worst case**, subtracts the pinned reserve, and refuses
before the first billed request. At the balance read above:

- spendable = 455.643 − 25 reserve = **430.643**
- per candidate, worst case = 10 windows x 17 = **170**

| candidates | windows | worst case | verdict at today's balance |
|---|---|---|---|
| 7 (proposed) | 70 | 1,215 | **REFUSED** |
| 4 | 40 | 705 | **REFUSED** |
| 3 | 30 | 535 | **REFUSED** |
| 2 | 20 | 365 | fits — `tight`, since 2x does not fit |

**So the proposed 7-candidate run does not fit in what is left of this period, and the honest options
are three.** They are stated as options because the choice is the captain's, not this lane's:

1. **RUN IT AFTER THE PERIOD ROLLS on 2026-08-29.** At a fresh 2,500 the 7-candidate worst case of
   1,215 fits with room to run it twice, so `decideAllowance` returns `sufficient` rather than
   `tight`. This is the recommendation: it is the only option that buys the full per-candidate
   evidence the gate asked for, and the expected bill (~145) leaves the period essentially intact.
2. **RUN TWO CANDIDATES NOW.** It fits, at `tight`. Two candidates is a thin basis for a
   per-candidate finding — and a run that reaches `entry-unmeasured` on both would produce **no
   comparison at all**, which the 2026-08-04 full-day run shows is the likely outcome rather than a
   remote one: 3 of 3 scored candidates reached an unmeasured verdict there, and the dominant hole
   was `roomIsProven` refusing windows, which this run does not change.
3. **LOWER `worstCaseCreditsPerWindow`.** 17 charges every window the busiest window this repo has
   ever measured. A defensible re-derivation would need a measurement of what a *stranger's* window
   actually returns — which costs an execution, so it cannot be had without spending, and pinning a
   lower number without one would be the anchor-fabrication this repo's justification bar exists to
   catch. Not recommended as a way to make the arithmetic fit.

## Two things must land before ANY of those shapes can run

Both are captain decisions, and neither is this lane's to take:

1. **`TRADE_COVERAGE_QUERY_ID` is `null` — the trade-table coverage probe is committed and NOT
   DEPLOYED.** `TRADE_COVERAGE_SQL` is in `dune-fills.mjs`; the saved query holding the identical
   text does not exist, and `assertSavedQueryMatches` compares the two before an execution is billed.
   Deploying it takes one of the six free private-query slots. **The Dune fill source cannot be built
   without it**: eligibility on that route is an OBSERVED watermark (captain decision 257a), the
   enumeration's probe bounds the CREATE tables and says nothing about when the TRADE tables hold a
   launch's fills, and writing a lag constant instead is captain decision 144a's defect verbatim.
   `tools/deployer-screen/README.md` → "Deploying a change to the committed SQL" owns the step.
2. **`thresholds.json` → `entry_source_agreement.active` is `false`.** The CLI flag alone cannot arm
   a leg that spends Dune credits inside Stage 2; the flag and the pinned bounds must both say so.

Until both land, `--entry-source-agreement` refuses with a sentence naming which one is missing, and
**nothing is requested and nothing is billed**. A test drives that refusal.

## What this run costs in units that are not credits

- **Solana RPC roughly doubles**, because the entry-cost leg runs once per source. Worst case
  7 candidates x 2 sources x `stage2_cost.maxRpcRequestsPerCandidate` 500 = **7,000 requests**, at
  the pinned ~2.5 s pacing ≈ **4.9 hours**. That is wall clock against a keyless host and costs no
  money. **It is not an accident of the implementation and must not be "optimised" by sharing a
  priced-transaction cache between the two readings**: that would make the two costs identical by
  construction and hide a cost-leg divergence inside a result that looks like agreement, which is
  one of the failures a two-source check exists to catch.
- **The swap-api walk is unchanged** — keyless, bounded by `stage2_entry.maxKeylessRequests`.
- **The MadeOnSol keyed leg is unchanged.** Stage 2 spends no keyed request on either source.

## What this run does NOT do

It is **not the Gate 3 cutover.** `ENTRY_FILL_SOURCE_KIND` is unmoved, `screen.mjs` selects the
swap-api on every default run, and every field this capability adds is `null` or empty on one. The
deliverable is evidence FOR the gate, and the cutover is the captain's.
