# The seeding comparison — untiered against `--tier` good/elite

Captain decision 232c. Run the widened screen on **both** seedings at
`stage1_gate.minCompletionRate = 0.25` (held, decision 231a) and report the comparison; the choice
of seeding returns to the captain.

**STATUS: INCOMPLETE — one leg started and was stopped, two never started.** This document records
what was measured before the stop, the ceiling that caused it, and what the measurement costs, so
that whatever the captain decides is decided against numbers rather than against an estimate. It is
not the comparison, and nothing in it answers questions 1–5 of the brief.

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
