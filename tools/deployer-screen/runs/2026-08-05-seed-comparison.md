# The seeding comparison — untiered against `--tier` good/elite

Captain decision 232c. Run the widened screen on **both** seedings at
`stage1_gate.minCompletionRate = 0.25` (held, decision 231a) and report the comparison; the choice
of seeding returns to the captain.

**STATUS: INCOMPLETE — one leg started and was stopped, two never started.** This document records
what was measured before the stop, the ceiling that caused it, and what the measurement costs. It is
not the comparison, and nothing in it answers questions 1–5 of the brief.

**CAPTAIN DECISION 239a, 2026-08-05: run it across two allowance days, TRIMMING NOTHING.** Leg B
first — `--tier good` (~68) plus `--tier elite` (62) = **130 keyed** — then leg A untiered (**85**)
on the following allowance day. Capping the legs with `--candidates` to fit one day, and dropping one
tiered half, were both **refused**: *a comparison sampled by a quota rather than by the question is
the same defect in smaller form.* That is the same rule the screen already applies to its own
verdicts — an unmeasured candidate is not a measured one — applied a level up, to the population.

**And the hard rule 239a attaches to both legs: read `x-ratelimit-remaining` before beginning, and
refuse to start a leg that cannot finish inside what is actually left.** Never start what cannot
complete. The cap is **shared**, so the figure can fall between two runs with this lane doing
nothing — which is exactly what produced the stop recorded below. A full 200 is never to be assumed
at a reset; it is to be read.

## The stop, and it is not the ceiling this repo already enforces

The `--tier elite` leg was started first — deliberately the cheapest of the three, as an end-to-end
check before spending the pool on the two larger ones. It enumerated, passed its Dune coverage
probe, and gated 11 of its 59 candidates before it was stopped.

It was stopped because **MadeOnSol's shared daily allowance was already 85% spent by another holder
of the key, and this tool cannot see that.**

MadeOnSol returns the counter on every response, and nothing in this repository reads it:

```
x-ratelimit-limit: 200
x-ratelimit-used: 170
x-ratelimit-remaining: 30
x-ratelimit-reset: 1785974400      # 2026-08-06T00:00:00Z — a calendar UTC day
```

**Of those 170, this lane spent 17** — 3 enumeration + 11 profiles from the stopped run, and 3
direct header reads. The other **153 were spent by another holder between 00:00Z and 04:50Z today**.
`thresholds.json` → `budget` is explicit that the allowance is shared; what is new is that the share
this lane got was under a fifth of it, with nothing in the run able to say so.

The gap is structural, and it is the one failure shape this tool refuses everywhere else. Every
other ceiling here is checked **before** the first request — the keyed plan, the keyless plan, the
Helius credit plan, and since schema 13 the Dune monthly balance, which is read from `POST /usage`
precisely so a run refuses rather than half-runs. `budget.maxKeyedRequests` is **200 per RUN**, and
the tool is stateless between runs, so three runs of 62–85 requests each pass the check
individually and collectively exceed the day. **The one budget with a free, authoritative, live
reading is the one nothing consults.**

Reading `x-ratelimit-remaining` and refusing a plan that does not fit the DAY would close it, at the
cost of one header read the client already receives. That is a change to spend behaviour and
therefore a captain decision, not a fix to make in passing — it is filed here rather than made.

## What the comparison costs, measured rather than estimated

| leg | keyed requests | basis |
|---|---|---|
| untiered default | **~85** (3 + 82) | `runs/2026-08-04.json`, exact: 128 distinct seeded, 46 prefiltered, 82 gated, cap never bound |
| `--tier good` | **~68** (3 + 65) | `runs/2026-08-02-good.json`, 65 gated — and today's pools are **larger**, so read it as a floor |
| `--tier elite` | **62** (3 + 59) | measured today: three full 50-row pages, **59 distinct**, **0 prefiltered** |
| **total** | **≥ 215** | against a **200/day** allowance that is **shared** |

**Three complete legs do not fit inside one UTC day's allowance even on a completely idle key**, and
that is a fact about the measurement rather than about today's contention. Today's contention is a
second, independent problem: 153 of 200 went elsewhere before this lane issued its first request.

The elite pool is also **2.7× the size it was on 2026-07-29** (59 distinct against 22), which is
consistent with the standing finding that vendor tier membership is a trailing window and not a
property of a wallet — and it means the prior records understate what a tiered leg costs today.

## What the stopped leg did establish, at no further cost

- **The Dune leg works from `main`.** The brief said the saved query is deployed to the six-column
  SQL; it is. `assertSavedQueryMatches` passed against the committed `CREATION_SQL`, the coverage
  probe passed on 3 tables covering **2024-01-14 → 2026-08-05 with 0 empty months**, and one
  execution of query `8204672` returned **2,652 launch rows for 59 deployers, 0 unreadable**. This
  is the leg that failed whole on 2026-08-04, so predictions `U8` / `G8` / `E7` are already carried
  on the evidence rather than on the brief's assurance.
- **Both per-wallet refusals fired, and both are the designed behaviour.** One candidate exceeded
  the batch's per-deployer cap of 500 rows, so its Dune history is a prefix and it takes the walk
  alone while every other candidate keeps its answer. One was refused by coverage — its newest
  enumerated launch (`2026-08-05T04:38:56Z`) is newer than the probed surfaces' own last row
  (`2026-08-05T03:03:42Z`) — and fell back to the walk rather than being published. Neither cost the
  batch its answer.
- **The allowance guard did its job on the budget it can see.** `checkDuneAllowance` read
  `670.475 of 2500` used in the period `2026-07-29 → 2026-08-29`, priced the run's worst case at
  195.2 credits and returned `sufficient` before the first billed request.

## Spend actually incurred

| budget | spent | note |
|---|---|---|
| MadeOnSol, keyed | **17** | 3 enumeration + 11 profiles (stopped run) + 3 header reads. 30 of the day's 200 remained at the stop |
| Dune | **1 execution, 10 requests** | `670.475 → 677.982` credits over the period = **7.507 billed**, of which the execution is one and the rest is the 2,652-row result read |
| Helius | a partial walk on 11 candidates | not separately metered; the run wrote no record |
| wall clock | ~4 min | |

**No run record was written.** The stopped run produced neither `2026-08-05-tier-elite.json` nor a
`.partial.json`, so nothing incomplete is committed and no reader can mistake a fragment for a
measurement. The three predictions documents under `predictions/` were committed **before** the run
and stand unchanged; they are the input the legs will be graded against whenever they are run.

## Exactly what the elite leg completed before it was stopped

**No gate verdict exists for any candidate.** The screen renders verdicts after gating finishes, so
the stopped run produced history readings and nothing downstream of them. Nothing below is a gate
result, a completion rate or a rank, and none of it may be read as one — the standing rule is that a
ceiling hit is never recordable as a measured result, and an aborted run is that.

What it did reach:

| stage | reached |
|---|---|
| enumeration | **complete** — 3 seeds, 50 rows / 50 wallets each, **59 distinct**, **0 prefiltered** |
| Dune allowance guard | **complete** — `sufficient`, worst case 195.2 credits against 1,804.525 spendable |
| Dune coverage probe | **complete** — 3 tables, PASSED, 2024-01-14 → 2026-08-05, 0 empty months |
| Dune enumeration | **complete for all 59** — one execution, 2,652 rows, 0 unreadable |
| per-candidate history reading | **10 of 59** finished; an 11th profile was paid for and its walk interrupted |
| gate, Stage 2, record | **not reached at all** |

Of the 10 finished readings, **7 were answered by Dune and 3 fell back to the Helius walk**. That is
the first 10 of a deterministic rank order, not a random sample of the 59, so it is an observation
and not a rate.

### The three fallbacks are all worth knowing, and two of them are new

- **Two of the three were refused for RECENCY, not for depth.** Both wallets' newest enumerated
  launch (`04:38:56Z` and `03:37:49Z`) was newer than the probed surfaces' own last row
  (`03:03:42Z`), so the probe could not vouch for the period the count was read over and the reading
  fell back to the walk. The mechanism is documented; the shape it takes on a live pool is not. **It
  bites hardest on exactly the wallets a discovery lane most wants** — a deployer that launched in
  the last hour is the one a recency-seeded feed just surfaced, and it is the one whose Dune answer
  gets refused. The probe defaults to a **cached** read (`refreshProbeByDefault: false`), so its last
  row is as old as the cache; `--dune-refresh-probe` moves it forward for one billed execution
  (measured 0.751 credits) and is the lever, at the cost this file's resume plan carries.
- **The third is the per-deployer row cap firing on a real batch for the first time.**
  `yHCxHBEa…` declared 751 creations and the batch's cap returned its most recent 500 — a prefix,
  not a short history — so it walked **alone** while the other 58 kept their Dune answer. This is
  precisely the failure the cap was introduced to stop being batch-wide, demonstrated live rather
  than argued. Its walk then read 751 created against an ownership listing of 280 (471 hidden, 324
  creator moved), consistent with the 749 / 280 the same wallet read on 2026-08-04.

### 227a's mayhem flag populates, and its denominator trap is now measured live

All 7 Dune-sourced readings carried a mayhem share; all 3 Helius-sourced ones correctly read
**UNMEASURED — NOT a reading of 0%**. Every share read **0.0%**, and the denominators are the point:

| launches enumerated | flag readable on | unreadable |
|---|---|---|
| 458 | **5** | 453 |
| 177 | 114 | 63 |
| 32 | 28 | 4 |
| 29 | 29 | 0 |
| 17 | 17 | 0 |
| 11 | 9 | 2 |
| 10 | 10 | 0 |

`mayhemFlagReadable` is **not** `duneLaunches`, and on the worst of these it is **5 of 458** — a
history reaching back through the `pump_call_create` half of the union, which carries no such
column. A reader who used the launch count as the denominator would have reported that wallet at
0.0% of 458 with the same confidence as the wallet where all 29 were readable. The warning was
written from the subject deployer's 101-of-252 split; **1.1% readable is an order of magnitude worse
than the case it was written from.**

## What a clean resume takes

**There is nothing to resume into.** The screen is stateless between runs by design and caches
nothing: no record was written, so a resumed leg re-issues its 3 enumeration requests, re-fetches
every profile, and re-executes the Dune enumeration. The 17 keyed requests and 7.507 credits already
spent buy no head start and are not recoverable — what they bought is the cost model below and the
findings above.

**A resume is therefore a fresh run of each leg, and the only question is how the three fit.**

```
node tools/deployer-screen/screen.mjs --tier elite \
  --predict tools/deployer-screen/predictions/2026-08-05-seed-comparison-tier-elite.json \
  --out    tools/deployer-screen/runs/<date>-tier-elite.json
node tools/deployer-screen/screen.mjs --tier good \
  --predict tools/deployer-screen/predictions/2026-08-05-seed-comparison-tier-good.json \
  --out    tools/deployer-screen/runs/<date>-tier-good.json
node tools/deployer-screen/screen.mjs \
  --predict tools/deployer-screen/predictions/2026-08-05-seed-comparison-untiered.json \
  --out    tools/deployer-screen/runs/<date>-untiered.json
```

The predictions documents are already committed and are **not** rewritten for a later date — that is
the whole point of committing them ahead of the run, and a resumed leg graded against a re-dated
document would be graded against a postdiction.

**Check the counter before each leg, and only start one whose worst case fits the remainder.** The
reading is free of credits and costs one keyed request:

```
curl -sD - -o /dev/null -H "authorization: Bearer $MADEONSOL_API_KEY" \
  https://madeonsol.com/api/v1/deployer-hunter/leaderboard?sort=total_bonded'&'limit=1 \
  | grep -i x-ratelimit
```

### The ordering 239a settled, and the one thing it costs

- **Leg B first, both halves on the same allowance day.** They are one leg of the comparison, and
  tier membership is a trailing window — `7ufmve7Z…` read elite on 2026-07-29 and good four days
  later with its own numbers essentially unchanged. Splitting them across a reset would make leg B
  two populations rather than one. At 62 + ~68 = ~130 they fit one day with ~70 to spare, which is
  under leg A's ~85 — which is why leg A goes to the next day rather than the same one.
- **Leg A on the following allowance day, untrimmed at ~85.**
- **Start each leg EARLY in its day rather than late.** An earlier draft of this file recommended
  straddling the 00:00Z reset — leg B late in one day, leg A minutes after the reset — because it
  puts the two legs hours apart instead of a day apart, which is better for comparability. **That is
  superseded, and deliberately.** It optimises the wrong risk: the shared key drained 153 of 200
  between 00:00Z and 04:50Z on 2026-08-05 with this lane doing nothing, so a leg held back until late
  in its day is a leg that may find nothing left to run on. Under 239a's hard rule that leg does not
  start at all, and a leg that cannot run is worse than two legs a day apart.
- **The cost of that ordering, stated rather than buried:** the two legs are measured about a day
  apart, so between them the vendor's pools slide, tier membership moves, and any wallet that
  launched in between changes its own reading. Both legs still run at the same bar
  (`minCompletionRate` 0.25, unmoved) against the same code, so the comparison is sound; what it
  cannot claim is that the two populations were photographed at the same instant. The report must say
  so where it states the overlap figure, since a shared wallet that moved tiers overnight is a real
  way the overlap can read low for a reason that is not about seeding.

Also worth passing to whoever runs it: consider `--dune-refresh-probe` on the **first** leg only. It
costs one billed execution (~0.75 credits) and moves the probe's last row up to the run, which is
what the two recency fallbacks above needed; the legs that follow within the 6 h staleness bound
inherit the fresher cached probe for nothing.

## What is committed and works, independent of the stop

Captain decision 232c's standing requirement — *each run records what it predicted, so a later run
can grade its own hit rate* — is built and tested rather than deferred:

- Record **schema 15 → 16**, adding a run-level `predictions` block carried verbatim from
  `--predict <path>`, validated for shape **before** the first request and evaluated by nothing.
- `record.mjs` → `readPredictions`, `resolvePredictionMetric` and `DERIVED_PREDICTION_METRICS`. A
  prediction's `metric` is a dotted path into the record or a `derived:` count over `candidates[]`,
  so *how many did this leg admit* is gradeable rather than prose.
- **Every rate metric names its reading in its own name** — `medianGateCompletionRate` against
  `medianVendorPageCompletionRate`, `gateReadingClearingBarCount` against
  `vendorPageClearingBarCount` — and a prediction that does not name its `reading` is **refused**,
  never defaulted. That is decision 231a's rule one level down. On the committed
  `runs/2026-08-04.json` the two readings admit **17** and **19** of the same 82 wallets and their
  medians differ by a factor of two, which is why the distinction is enforced rather than noted.
- 27 predictions across the three legs, 22 of them mechanically resolvable against the record the
  leg will write, committed in their own commit ahead of the runs — the same audit trail
  `thresholds.json` keeps for its pinned values, and the only thing that distinguishes a prediction
  from a postdiction, since the reader checks shape and cannot check chronology.
