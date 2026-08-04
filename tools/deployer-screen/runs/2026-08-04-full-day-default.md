# The full-day default run — and why it does not answer the question

Run record: `2026-08-04.json` (schema 12, `completed: true`).
Prior runs: `2026-08-02-good.json` (schema 3), `2026-07-29-elite.json` (schema 1, completeness
**UNKNOWN**). See the README's completeness contract before comparing any of the three.

Invocation, verbatim:

```
node tools/deployer-screen/screen.mjs --out tools/deployer-screen/runs/2026-08-04.json
```

**No flag was passed that changes a parameter.** No tier filter, no candidate cap, nothing retuned.
`--consistency` was deliberately not passed: it measures long-horizon steadiness, which is a Stage 1
adjunct and not what this run asks, so every survivor's `consistency` reads UNMEASURED. All three
credentials were present and shape-valid; the plan fit every ceiling before the first request.

## The question, and the answer

> **Does any deployer have an opening window that is still enterable AFTER what it costs to enter?**

**This run cannot answer the captain's question because too much was refused.**

Stage 2 reached three candidates and returned **`entry-unmeasured` on all three**. Zero measured
verdicts of any kind — no `entry-open-after-costs`, no `entry-room-absent`, no
`entry-cost-prohibitive`, no `entry-field-loss-making`. Not one candidate got far enough for the
entry-cost leg to run at all: `entry.coverage.cost.ran` is `false` on all three, 0 RPC requests
spent on pricing.

So the honest statement of the result is that **the screen returned no answer**, in either
direction, for every deployer it reached. That is not a negative result about any of them, and it
must not be quoted as one.

## Verdicts and refusals, separately

### Stage 1 — the competence gate

| outcome | n |
|---|---|
| gated | **82** |
| `gate-passed` | **4** |
| `gate-unmeasured` | **4** |
| `gate-failed` | **74** |

128 distinct wallets seeded, 46 prefiltered before spending a request, 82 worth one, **0 dropped by
the candidate cap** — `coverage.coverageTruncated: false`, a full screen of everything enumeration
surfaced. No seed was inert; all three returned a full 50-row page.

The 74 rejections (a wallet can fail on several bars): **60 completion rate**, **13 sample too
small**, **7 span under 14 days**, 1 undefined rate. The rate failures are overwhelmingly industrial
spam — **50 of the 60 read under 4%**, and the highest of them is 0.2105 — which is what an untiered
default pool looks like.

The 4 `gate-unmeasured` wallets are large (1,671 to 6,858 creation-derived launches) with launches
whose bonded status neither the curve account nor the ownership listing could answer. `kind:
"no-source"` — every request was served, so a plain rerun reaches the same silence.

### Stage 2 — entry

Three of the four survivors were scored (pinned `maxCandidatesScored: 3`); the fourth,
`DAEdBmTP…`, has no `entry` block at all and the record is flagged `truncated: true` for exactly
that reason.

| wallet | launches / rate / tempi | planned | walked | **proven** | unproven | walk drops | verdict | cause |
|---|---|---|---|---|---|---|---|---|
| `yHCxHBEa…` | 749 / 30.7% / 7.10 a day | 10 | 10 | **4** | 6 | 0 | `entry-unmeasured` | `too-few-proven-windows` |
| `2N7qg9a3…` | 60 / 58.3% / 0.10 a day | 10 | 3 | **0** | 3 | 7 | `entry-unmeasured` | `windows-dropped` (+ `too-few-proven-windows`) |
| `BXAWg4Jb…` | 48 / 27.1% / 0.06 a day | 10 | 9 | **0** | 9 | 1 | `entry-unmeasured` | `windows-dropped` (+ `too-few-proven-windows`) |
| `DAEdBmTP…` | 37 / 54.1% / 0.04 a day | — | — | — | — | — | **not scored** — scoring cap | — |

**Every cause is `our-coverage`.** Nothing here is attributable to a deployer, so a later stage must
carry all three forward as *no answer* and may not filter on them.

**Where the hole came from, in aggregate: 30 windows planned, 22 walked, 8 dropped, and 18 of the
22 that walked cleanly were refused as UNPROVEN.** That is the answer to the question the brief
flagged in advance: **unproven windows, not walk drops, are the dominant hole — 18 against 8, and
they are 82% of everything successfully walked.**

**Nothing tripped the 198b near-bar guard.** `room-verdict-not-robust-to-missing-launches` appears
**zero times** in this record. All three refusals fired at the sample-size gate, upstream of it.
That matters for the follow-up and is picked up below.

### The co-ordination evidence, which is what produced the unproven windows

| wallet | `maxWalletsInOneTx` median / max | `runTx` median / max | `adjacencyMarks` max |
|---|---|---|---|
| `yHCxHBEa…` | 1 / 3 | 1 / 4 | **0** |
| `2N7qg9a3…` | 1 / **1** | 1 / **1** | **0** |
| `BXAWg4Jb…` | 1 / **1** | 1 / **1** | **0** |

Two of the three strangers show **no co-ordination evidence of any kind on any window walked** —
every create slot is single-wallet transactions with no anchored run. The third bundles on 4 of its
10 and not on the other 6.

**Decision 182a's adjacency half marked zero extra wallets across all 22 stranger windows.** On our
own subject that half is what carries the pre-March era single-handedly (Stage 0's tripwire: 45 of
45 cohort wallet-instances in launches before 2026-03-01, where the shared-transaction rule recovers
nothing). On strangers, in this run, the union collapsed to the shared-transaction rule alone. n = 3
deployers; this is an observation, not a rate.

## Was any of this predictable, and did the two changes that landed today do what they were for?

Both PRs landed before this run and both are visible in it.

- **PR 45 / decision 190a (cap 10 against a floor of 8) did work, on one candidate.** `yHCxHBEa…`
  reached 4 proven of 10 planned — short of the floor of 8, so refused. **How many of those 4 an
  8-cap would have reached is not derivable from this record**: it persists distributions and
  counts, with no per-launch ordering, so which of the 10 planned windows the proven ones were is
  unknown. Refused either way — 4 is below 8 and any subset of it is too — but the headroom is what
  let a tenth window be attempted at all. On the other two it changed nothing: at 0 proven, no
  headroom is enough.
- **PR 46 / decision 198b (the near-bar guard) fired zero times.** It is a guard on candidates that
  *clear* `minLaunchesSampled`, and no candidate in this run did.

**The measured refusal rate is 3 of 3 scored candidates, 100%.** There was no reliable prior for it
and there is now one data point: a full untiered default run, 82 gated, 4 competent, 3 scored, 0
answered. Do not carry the pre-existing "roughly one candidate in four" figure anywhere; it predates
both changes and this run does not support it.

**This reproduces the bundling census's shape, and it is worth saying directly.** The census read
1 of 14 candidates proven on all eight windows and **0 of 13 strangers**. Here, 0 of 3 strangers
reached even the 8-window floor, and our own known-negative control was not in the pool at all —
`7ufmve7Z…` was surfaced by no seed on the untiered default, so this run carries **no live control**.
Stage 0 exercised it offline as usual and passed, including both halves of the known-negative check
(`ENTRY-ROOM-ABSENT`, room 0.278 over its most recent 10 launches).

## What this implies for `slot-zero-guard-unproven-upper-bound`

The filed follow-up asks whether padding unproven windows to the worst case should be tightened,
since a launch refused as unproven still has a *measured* `roomLeft` that is a strict upper bound
(unrecovered co-ordination can only inflate room — `measure.mjs` → `roomIsProven`).

**The number the captain asked for: the guard fired 0 times in 82 gated / 4 competent / 3 scored
candidates, and the sample-size gate fired 3 times. Tightening the guard's padding, on its own,
would have changed nothing in this run.**

That is the first-order finding and it points somewhere specific. Working the arithmetic on the one
candidate that produced any room figures at all, `yHCxHBEa…` — 4 proven readings (min 0.153, median
0.289, max 0.372) with 6 missing, against `minRoomLeft` 0.55:

- Under `roomBarRobustness` as shipped, padding the 6 to `ROOM_LEFT_RANGE` (0, 1): the interval is
  **[0.000, 1.000]** — undecided. Even had this candidate cleared the sample-size floor, the guard
  would have refused it.
- Substituting each unproven launch's own measured `roomLeft` as its upper bound instead: `hi`
  becomes the median of the 4 proven readings and 6 upper bounds. **If those six sit anywhere below
  0.55, `hi < minRoomLeft` and the verdict is decided** — a measured `entry-room-absent`, which is
  one of the four verdicts a later stage may filter on. All four proven readings on this wallet sit
  at or below 0.372, and an unproven reading is inflated relative to a proven one, so this is
  plausible rather than established. **This run does not persist the unproven launches' room
  figures, so the substitution cannot be evaluated from the record.** Do not read the arithmetic
  above as a measurement of what would have happened.

So the concrete recommendation this run supports, stated at the strength the evidence carries:

1. **The binding constraint is not the guard's padding — it is the sample-size floor over PROVEN
   windows.** A change confined to `roomBarRobustness` would not have converted a single refusal
   here. If the upper-bound argument is to buy coverage, it has to reach the place unproven windows
   are excluded from the *sample*, not only the place missing launches are padded. That is a wider
   change than the follow-up as filed, and it is a captain decision, not an inference from this run.
2. **The substitution is NOT direction-safe, and an earlier draft of this section said it was.**
   Substituting a measured upper bound for `ROOM_LEFT_RANGE.max` can only narrow `hi` — but
   **deciding is separate from the verdict**. `roomBarRobustness` returns
   `decided = hi < minRoomLeft || lo >= minRoomLeft`, and once decided the verdict is taken from
   `roomLeft.median` over the **scored** launches alone (`entry.mjs`, the
   `!(roomLeft.median >= t.minRoomLeft)` branch), never from `hi`. So a narrowed `hi` can flip an
   undecided candidate to decided while its scored median still clears `minRoomLeft` — carrying it
   onward toward `entry-open-after-costs`, a pass the shipped guard refuses today. The change can
   therefore admit as well as refuse, and any decision on it must be argued on both directions.
3. **Persist the unproven windows' `roomLeft` before deciding.** The evaluation above is blocked on
   exactly one missing field. A schema bump carrying the unproven launches' own room readings costs
   no request and no quota (the fills are already walked and parsed) and would let the next run
   measure the tightening instead of arguing it.

`needs-decision:` items 1 and 3 are the captain's; nothing was changed here.

## Is Stage 3 worth building? — answered only from this run

**No, and this run gives no evidence either way about the exit trap, which is itself the answer for
now.**

Stage 3 is motivated by a candidate whose window is open after costs — that is what makes "could you
get back out?" a question worth spending on. **This run produced no such candidate.** It produced no
measured entry verdict at all, and the entry-cost leg never ran, so nothing here says any deployer's
window is worth asking an exit question about.

The thing this run does say is where the marginal effort belongs: **the screen's coverage, not its
next stage.** Three scored candidates, zero answers, 18 of 22 walked windows refused for want of
co-ordination evidence. Building Stage 3 now would add a lane downstream of a lane that is currently
returning nothing.

Per the brief, this is answered from this run's measurements alone. Stage 3 was not built, not
scoped, and nothing above should be read as authorisation to start it.

## Two things that went wrong in the plumbing, both recorded and neither fatal

### 1. The Dune enumeration leg failed and the whole run fell back to the walk

`dune.unusableNote`: the cached coverage probe was past the 6 h staleness bound, the one permitted
re-execution of query **8204603** ended `QUERY_STATE_FAILED`, and a failed execution is billed and
never retried. All 82 candidates therefore took the creation walk. With `HELIUS_API_KEY` present
that was the indexed route, so the cost was wall clock rather than a stopped run:
`enumerationSource: "helius"` on every candidate, `dune.rowsReturned: 0`, `dune.coverage: null`.

This is the designed per-run fallback behaving exactly as documented, and the record says so in
place. **The Dune bill for the run is 1 billed execution that returned nothing** —
`estimatedCredits: 0.049` covers only the 2,470 result bytes read; the failed execution's compute is
billed on top and is not in that figure. Why the probe execution failed is not visible from here and
is worth a look before the next run, since a second consecutive failure would make Dune's primary
role nominal.

### 2. Six windows dropped on a MINT-TIME DISAGREEMENT — the run's own reportable event

`entryDrops.byReason.mintTimeDisagreement: 6`, all on `2N7qg9a3…`, which is what took it from 10
planned windows to 3 walked. The tool flags this itself:

> `!! REPORTABLE: 6 drop(s) were a MINT-TIME DISAGREEMENT` … *on our own tape that gap is exactly 0
> on all 235 launches, so this is not a footnote.*

Worth naming precisely, because the vendor pair is **not** the one already written down. Stage 2's
mint times come from **MadeOnSol**'s `profile.pump_tokens[].created_timestamp` (`measure.mjs` →
`toLaunchRefs`), compared against `swap-api` fill timestamps, which are whole seconds floored. That
is the same *shape* as the documented `frontend-api-v3` ↔ `swap-api` disagreement — a
millisecond-precision creation time landing after the launch's own first fill — but a different
vendor pair, and it is not proven to be the same cause from this record alone.

The consequence is concrete and already visible in the ratios: `bundling.mjs` and
`tools/arrival-rate-walk/` both backdate their creation time by a pinned 5,000 ms before driving
`readLaunchWindow`, whose pre-mint tripwire has **zero slack**. **`screen.mjs`'s Stage 2 does not
backdate.** Whether it should is a decision, not a bug fix to make in passing, and nothing was
changed here.

## Spend

| budget | spent | ceiling | note |
|---|---|---|---|
| MadeOnSol, keyed | **85** (3 enumeration + 82 gate) | 200 | 115 unspent against a planned worst case of 198 |
| Helius, credits | **221,731** | 5,200/candidate, 1,100,000/run | ~2.2% of the unshared 10M monthly allowance |
| Solana RPC (Helius), requests | 3,941 | — | **0 load-shed events** |
| Dune | 1 execution, 5 requests, 2,470 bytes | 2 executions, 100 requests | the execution failed and is billed |
| keyless `frontend-api-v3` | 431 | 1,400 | the gate's ownership listing |
| keyless `swap-api`, Stage 2 | **168** | 540 | **0 shed** |
| wall clock | **54.8 min** | — | far inside the ~3.6 h worst case with a Helius key |

The run cost **less than half the MadeOnSol daily allowance**, so a second run today is affordable.

## One incidental finding worth keeping

`yHCxHBEa…` is the clearest demonstration yet of why the creation-derived reading exists, running
the *opposite* way to the usual argument. The ownership listing page-capped at **70 tokens, all
complete — a 100% rate**. The creation walk found **749 launches, 230 bonded, 30.7%**, with **469
hidden by ownership** and 324 creator movements. The wallet passes the gate on both readings
(`verdictChanged: false`), so no verdict moved, but the rate the gate actually judged is a third of
what the vendor surface showed. The standing claim is that ownership *understates* a good dev; here
a page cap made it wildly *overstate* one, and only the creation-derived denominator caught it.

## What this does and does not settle

- **Not settled, and this is the headline: whether any deployer has a window enterable after entry
  cost.** Three candidates scored, three refusals, zero measured verdicts. The run is inconclusive
  and no reading of it should be dressed up otherwise.
- **Settled: the refusal rate on an untiered default pool, measured for the first time under both
  190a and 198b — 3 of 3, and the dominant cause is unproven windows, not walk drops (18 against 8).**
- **Settled: the 198b guard is not currently the binding constraint.** It fired zero times. The
  sample-size floor over proven windows fired three times.
- **Not settled: whether an unproven window's measured `roomLeft` would convert refusals into
  `entry-room-absent` verdicts.** The record does not persist the figure the evaluation needs.
- **Not answered: the fourth gate survivor.** `DAEdBmTP…` cleared the gate at 20/37 over 874 days
  and the scoring cap of 3 left it unmeasured. Scoring it costs no keyed quota, but a rerun spends
  82 keyed requests re-fetching profiles, since nothing is cached by design.
