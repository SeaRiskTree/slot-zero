# Entry cost for the 15 that cleared the room bar — and this project's first Stage 3 count

**Date: 2026-08-10/11. Repo `slot-zero` @ `011f5cf`, thresholds 6.9.0.**

---

## THE ANSWER

> **Six candidates reach Stage 3** — `entry-open-after-costs`, the strongest verdict this stage can
> reach — out of **15 attempted** and **12 whose verdict the lane could measure**.
>
> | statement | k / n | rate | exact 95% interval |
> |---|---:|---:|---|
> | Stage 3, over the 15 the census handed this lane | **6 / 15** | 0.4000 | **[0.1634, 0.6771]** |
> | Stage 3, over the candidates whose verdict was MEASURED | **6 / 12** | 0.5000 | **[0.2109, 0.7891]** |
>
> **The two denominators are different questions and are never pooled.** Three candidates have no
> verdict because THIS LANE's Helius ceiling ran out, which is our coverage and not a fact about
> them; they are in the first denominator and not the second.

**THE CAVEAT BELONGS BESIDE THE NUMBER, NOT UNDER IT.** A landing tip paid in a *separate*
transaction of the same bundle is not recoverable from the entrant's own transaction and is in no
figure here, so **every entry cost this project can measure is a LOWER bound and every after-cost
result is an UPPER bound**. That asymmetry is the whole reading of the six:

- **A candidate that FAILS is a firm negative.** True cost is at least what was measured, so a field
  that is loss-making at the measured cost is loss-making at the real one. The six refusals below
  hold *a fortiori*.
- **A candidate that PASSES is optimistic by construction.** The six are the candidates that survive
  an upper bound on their own result. **This is not a finding that they are profitable**, and it must
  not be reported as one. `entry.mjs` → `LANDING_TIP_CAVEAT` and `WINNERS_ONLY_CAVEAT` (the fill tape
  holds only wallets that won the auction) travel on every row of `result.json`.

---

## The cost gate refused NOBODY, and the field is what binds

This is the finding the captain should act on, so it is not in a table.

`maxEntryCostPerSolStaked` is **0.12**. Of the nine candidates whose cost leg priced enough of the
field for production to gate on it (`minPricedFraction` 0.8), **all nine came in below the bar**, in
a tight band of **0.028580 to 0.042928 SOL per SOL staked per launch** — the nearest, `Dzp1SrZ4…` at
0.042928, was **2.8× under**. **`entry-cost-prohibitive` fired zero times.**

**That band is the nine GATEABLE readings and nothing else.** The three thin readings — the ones
below `minPricedFraction`, italicised in the table below — are excluded from it, from every count in
this section and from every superlative in this document. Including them would let a median of one
priced entry set the endpoint of a range, which is the reading `minPricedFraction` exists to refuse.

What refused six of the twelve was the **field**, on both sides of the cost leg:

| refusal | n | what it means |
|---|---:|---|
| gross field, before any cost | 3 | the field loses money before fees; no RPC request was spent (by design) |
| net field, after measured cost | 3 | positive gross, negative once the measured seat price is netted |

So the shape of the answer is: **on this population the price of the seat is not the obstacle — who
is already in the seat is.** Room exists, entry is cheap, and roughly half the fields do not convert
it. Cite `thresholds.json` → `stage2_entry.justification.maxEntryCostPerSolStaked` for what the bar
is, not this document; **no bar, predicate or threshold moved for this lane.**

---

## Status and cost

| | |
|---|---|
| Population | the **15** candidates that cleared `stage2_entry.minRoomLeft` 0.55 in `slot-zero-july-stage3-census` → `report.md` §"The 15, with the 208b bound on each" (held in firstmate's records, not in this repo) |
| Windows | the census's own pinned selection, **145** planned, copied verbatim to `census-input.json` |
| Fill source | **swap-api**, keyless, production `swapapi-fills.mjs` at the pinned 7,000 ms pacing |
| Cost source | **Helius**, production `rpc-costs.mjs` → `readCreateSlotCosts` over `SolanaRpcClient` |
| **Dune spend** | **0 credits, 0 executions, 0 saved queries created, read or archived** |
| **Helius spend** | **1,398 requests of a 1,500-credit hard stop**, 0 shed |
| MadeOnSol spend | **0 keyed requests** |
| swap-api spend | **710 keyless requests across the LANE**, 0 shed — 611 in the run this record reports, plus **99 in the abandoned first attempt** (`run-abandoned-2026-08-10.log`). `result.json` → `spend.keylessRequests` records the 611 correctly: it is that run's own counter, not the lane's total |
| Windows walked | **144 of 145**; 1 dropped at the pinned per-launch request cap |
| Code, thresholds, bars, committed records, census artifacts changed | **none** |

Every figure below is reproducible from `result.json` by `node summarise.mjs`, which opens no socket.

### Reading live usage — one constraint this lane could not meet

The brief asked for credits read from live usage before and after. **Dune's was read and is exact**
(free `POST /usage`, no credits consumed): **915.853 used of 4,000 included**, period 2026-08-06 →
2026-09-06, **3,084.147 remaining, unchanged** — this lane spent none of it.

**Helius publishes no usage or credit-balance endpoint reachable with this key**, probed 2026-08-10
(`/v0/usage`, `/v0/account-usage`, `/v0/credits`, `/v0/usage-stats` all 404) and it returns no credit
header on an RPC response. So the Helius figure is the production client's own `issued()` counter,
which increments **immediately before every attempt, retries included** and is checked against the
ceiling at the same point. On this provider every method this leg calls (`getTransaction`,
`getBlock`) is a 1-credit standard method, so **1,398 is an exact upper bound on credits billed**,
not an estimate. It is stated as a bound because that is what it is.

---

## Every one of the 15, measured today

`census room` is carried from the census (Dune source, 2026-08-10). Everything else was measured
today through production `stage2.mjs` → `scoreLaunchRefsEntry`.

| deployer | census room | today room | n | closed RT | gross hit | cost/SOL by launch | priced | net hit | net median SOL | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `Dzp1SrZ474xw…` | 0.747664 | 0.747664 | 9/10 | 75 | 56/75 | 0.042928 | 78/78 | 52/75 | 0.102845 | `entry-open-after-costs` |
| `ARB8KYfnnUwh…` | 0.745176 | 0.745176 | 9/10 | 45 | 22/45 | — | 0/50 | — | — | `entry-field-loss-making` |
| `6MAmqJ7aGtTR…` | 0.699780 | 0.699780 | 9/10 | 49 | 39/49 | 0.034830 | 49/49 | 35/49 | 0.048822 | `entry-open-after-costs` |
| `F9Jgf14YKQnc…` | 0.670494 | 0.670494 | 10/10 | 82 | 48/82 | 0.031259 | 83/83 | 43/82 | 0.006863 | `entry-open-after-costs` |
| `C2TFeiRyzzAp…` | 0.670427 | 0.653463 | 10/10 | 50 | 41/50 | 0.030604 | 65/65 | 34/50 | 0.052265 | `entry-open-after-costs` |
| `68SJZt8q5Bye…` | 0.658049 | 0.646814 | 10/10 | 45 | 28/45 | 0.028580 | 46/46 | 15/45 | -0.010939 | `entry-field-loss-making` |
| `BWoZVgNjTg5u…` | 0.657898 | 0.657898 | 10/10 | 42 | 24/42 | 0.029662 | 48/48 | 18/42 | -0.003981 | `entry-field-loss-making` |
| `FVZRwUp6E4m9…` | 0.653073 | 0.653073 | 10/10 | 37 | 26/37 | 0.035698 | 39/39 | 24/37 | 0.098645 | `entry-open-after-costs` |
| `DxQ1iNidsGap…` | 0.651029 | 0.651029 | 10/10 | 55 | 31/55 | 0.031015 | 71/71 | 27/55 | -0.003190 | `entry-field-loss-making` |
| `H6hPTUg73GDs…` | 0.649350 | 0.649350 | 10/10 | 59 | 38/59 | 0.036930 | 88/88 | 34/59 | 0.015955 | `entry-open-after-costs` |
| `7F4sTCyUqN33…` | 0.622445 | 0.622445 | 8/8 | 77 | 36/77 | — | 0/79 | — | — | `entry-field-loss-making` |
| `DJGm2u3ZRJJa…` | 0.620131 | 0.620131 | 9/9 | 44 | 30/44 | *0.026582* | 35/45 | 18/35 | 0.002852 | `entry-cost-unmeasured` |
| `4cXnf2z85UiZ…` | 0.610553 | 0.610553 | 8/8 | 48 | 40/48 | *0.048472* | 7/48 | 1/7 | -0.064861 | `entry-cost-unmeasured` |
| `4QwJ4AXMtSjn…` | 0.582555 | 0.582555 | 10/10 | 90 | 43/90 | — | 0/96 | — | — | `entry-field-loss-making` |
| `3kpjBEboLyD3…` | 0.555943 | 0.555943 | 10/10 | 51 | 31/51 | *0.265452* | 1/53 | 0/1 | -0.790938 | `entry-cost-unmeasured` |

A `—` in the cost column means the **cost leg never ran**: the gross field refused the candidate
first and no RPC request was spent on it, which is the ordering the cost model is built on and a
saving rather than a gap. An *italic* cost is a reading **below `minPricedFraction` 0.8** — too thin
for production to gate on, printed so a reader can see it exists, and **it decides nothing**.
`3kpjBEboLyD3…`'s 0.265452 is the median of a single priced entry and must not be read as that
deployer's entry cost.

### The ladder, as counts

```
15 attempted  (the census's 15)
 └─ 15 walked, 144 of 145 windows usable, 15 of 15 still clear minRoomLeft 0.55
     ├─  3 refused at the GROSS field bar        → entry-field-loss-making  (MEASURED, firm)
     └─ 12 cost leg ran, 2,024 of 2,389 transactions priced across 90 launches
         ├─  3 UNMEASURED — this lane's Helius ceiling (ours, never theirs)
         └─  9 cost read at or above minPricedFraction — ALL NINE below the 0.12 bar
             ├─  3 refused NET of measured fees   → entry-field-loss-making  (MEASURED, firm)
             └─  6 entry-open-after-costs         → STAGE 3
```

---

## The three the lane could not price, and why that is our fault and not theirs

`DJGm2u3ZRJJa…`, `4cXnf2z85UiZ…` and `3kpjBEboLyD3…` returned `entry-cost-unmeasured` /
`too-little-of-the-field-priced`. **They did not fail the cost gate — the gate was never reached**,
and captain decision 174b binds: a later stage may filter on a MEASURED verdict and never on an
unmeasured one whatever its cause. Two of the three carry a cost reading *below* 0.12 on the sliver
that priced, which is suggestive and is not evidence.

**TWO CAUSES ARE RECORDED ON EACH OF THE THREE, AND THEY ARE SEPARATE FIELDS THAT SAY DIFFERENT
THINGS.** Production's `unmeasuredCause` / `unmeasuredCauseAttribution` say
`too-little-of-the-field-priced` / `our-coverage` and are untouched — that is the ladder's own answer
and it is what 174b binds a later stage to. Beside them, `laneUnmeasuredCause` is `lane-rpc-ceiling`,
which refines *whose* coverage failed: THIS LANE's spend ceiling truncated the leg, not the vendor
and not the chain. A reader taking the recorded cause rather than this prose can therefore tell the
two apart; `price-entry.mjs` → `laneUnmeasuredCauseFor` derives it from the granted ceiling and the
leg's own budget outcome, so it cannot say "the lane" about a leg the lane did not bound.

**PROVENANCE, AND IT MATTERS MORE THAN THE VALUES DO: `result.json` CARRIES TWO POST-RUN AMENDMENTS,
AND HERE IS BOTH OF THEM.** The alternative — a derived value sitting in an artifact that reads as
measured — is exactly what this repo's measured-versus-inferred discipline exists to prevent.

**(1) The three lane causes were derived after the run, not emitted by it.** The generator that
produced this record set the lane cause only when the granted ceiling was exactly 0, and the lane
never reached 0 — it granted 122, 17 and 8 requests and was truncated mid-leg — so **the run wrote
`laneUnmeasuredCause: null` into all fifteen rows**, and those nulls are what the three values
replaced. `run.log` is the run's own console output and **predates the derivation**; it prints the
plan header and one verdict line per candidate and never prints this field at all, so it neither
shows nor contradicts the amendment.

**(2) The top-level `thresholdsMinPricedFraction` was added out of band, before this write-up's
review began.** The generator that produced the record never emitted it; the value (0.8) is
`thresholds.json` → `stage2_entry.minPricedFraction` and no published figure rests on its having
been written by the run. `price-entry.mjs` → `recordOf()` emits it now, so a future run reproduces
it — but **in the committed artifact it is the LAST key, after `candidates`, where the generator
places it between `laneCreditHardStop` and `spend`.** That ordering is the amendment's own
fingerprint and is why this record is value-reproducible but not byte-reproducible.

**What that list rests on, since a completeness claim is worth only the check behind it.** Every
top-level key in `result.json` was compared against the set `recordOf()` emits, read statically from
`price-entry.mjs` rather than by running it: the two sets are **identical**, differing only in the
position of `thresholdsMinPricedFraction` above, and all fifteen candidate rows carry exactly the key
list `rows.push()` builds. So no third key was added or removed. That check bounds the SHAPE of the
record and not the VALUE of every field in it, and this note claims no more than that.

The three lane-cause values were computed by `price-entry.mjs` → `laneUnmeasuredCauseFor` over
`spend.rpcCeilingGranted` and `coverage.cost.stoppedForBudget` /
`coverage.cost.launchesSkippedForBudget` **as the run itself recorded them**. So the amendment is
**checkable rather than asserted, and here is the check**: read those three fields off each row of
`result.json` and re-derive
`laneUnmeasuredCauseFor` over them — it returns `lane-rpc-ceiling` on exactly the three rows that
carry it (granted 122/17/8 against the pinned 500, all three `stoppedForBudget: true`) and `null` on
the other twelve. Every input to that derivation is in the record, so a reader who disagrees with it
can recover the run's original nulls and re-decide. Production's `unmeasuredCause` /
`unmeasuredCauseAttribution` were emitted by the run and are untouched.

**The cause is this lane's spend ceiling and it is stated exactly.** Candidates were priced in
descending **census** room-median order, so the hole sits at the TAIL of that order rather than
falling at random: the three that ran out are 12th, 13th and 15th of the fifteen priced.
**They are NOT the three lowest room medians**, and the difference is worth stating precisely. The
three lowest are `3kpjBEboLyD3…` (0.555943), `4QwJ4AXMtSjn…` (0.582555) and `4cXnf2z85UiZ…`
(0.610553); the three truncated are `3kpjBEboLyD3…` (0.555943), `4cXnf2z85UiZ…` (0.610553) and
`DJGm2u3ZRJJa…` (0.620131). `4QwJ4AXMtSjn…` escaped the ceiling only because the **gross field
refused it before its cost leg ever ran** — `rpcRequests: 0` against a granted ceiling of 8 — so it
is a candidate the ceiling never got to rather than one it spared. `7F4sTCyUqN33…`, 11th, escaped
the same way (`rpcRequests: 0`, granted 122).

But **re-ordering could not have fixed it**: the 15 targeted **2,389** distinct transactions, and
1,398 requests priced 2,024 of them (the whole-block route covered 713). The 365 that went unpriced
would have cost **at most 365 more** — the transaction route is one request each and the block route
only ever replaces several with one — putting this run at **≤1,765 against a 1,500-credit stop**, so
no allocation of the 1,500 reaches all fifteen. That ceiling holds only for THIS run continuing,
where the 2,024 already priced are not paid for twice; the cost of a fresh re-run is a different and
larger quantity, and the recommendation below states it separately. **~1,800** as the stop that would
have finished the job is a projection from that arithmetic, not a bound. I stopped at 1,398 with 102
credits of the authorised stop unspent rather than push at it, per the brief.

---

## What was measured today versus what is carried from the census

**Measured today, by this lane, through production code**

- Every fill: the swap-api walk, 611 keyless requests, 0 shed, 144 usable windows of 145 planned.
  That 611 is THIS run's counter and is what `result.json` records; the lane issued **710** at that
  endpoint once the abandoned first attempt's 99 are counted (Status table above).
- Every room figure in the `today room` column, through `measure.mjs` → `roomIsProven` and
  `entry.mjs` → `scoreEntry`, unmodified.
- Every entry cost: `entry.mjs` → `entryCostTargets` → `rpc-costs.mjs` → `pumpfun.mjs` →
  `readCreateSlotCosts` (`meta.fee` plus the real lamport deltas), over Helius.
- Every verdict, from the production ladder at the pinned bars.
- The intervals, by exact Clopper–Pearson in `summarise.mjs` — **validated against the census's own
  published intervals**, which it reproduces on all five (15/369, 0/6, 0/22, 353/5,399, 7/101).
  That validation is an assertion rather than a claim: `test/entry-cost-cleared-fifteen.test.ts`
  drives the exported `clopperPearson` over those five pairs and over the `k = 0`, `k = n` and
  `n = 0` edges, offline.

**DERIVED after the run, and never to be read as measured**

- `measuredToday.laneUnmeasuredCause` on all fifteen rows — `lane-rpc-ceiling` on three, `null` on
  twelve. The run emitted `null` on all fifteen; these were computed afterwards by
  `price-entry.mjs` → `laneUnmeasuredCauseFor` from `spend.rpcCeilingGranted` and `coverage.cost`,
  both of which the run DID record. `run.log` predates it.
- The top-level `thresholdsMinPricedFraction`, added out of band. Its value is `thresholds.json` →
  `stage2_entry.minPricedFraction` and it is where the roll-up reads the coverage floor from; the
  generator emits it now, but not in the position the committed artifact holds it.

  Both are the provenance note above, which also states the key-set check those two items rest on
  and what that check does and does not bound.

**Carried from the census, not re-derived**

- The 15 themselves, their arms, their lifetime completion rates, their 208b bounds, and the 145
  windows. `census-input.json` is a verbatim copy; nothing in the census was edited.
- Every claim about the wider population — 3,921 candidates, 24,708 windows, the 0.7604 refusal
  rate, the floor-free ceiling of 54.

### An unplanned cross-source result: the two sources agree on room for 13 of 15

The census read these windows through **Dune**; this lane re-read them through **swap-api**. The room
medians are **identical to six decimal places on 13 of the 15**. The two that differ —
`C2TFeiRyzzAp…` 0.670427 → 0.653463 and `68SJZt8q5Bye…` 0.658049 → 0.646814 — both moved **down**,
the direction the census's §5 predicts for the swap-api `BuyExactSolIn` understatement, and both
still clear 0.55. This is a stronger check than the census's own V2 (which was Dune against Dune) and
it issued **no request of its own** — it reads the fills the keyless swap-api **fill walk** had
already fetched. It is not the cost leg's doing: the cost leg is the Helius RPC one and it never ran
at all on three of the fifteen (`ARB8KYfnnUwh…`, `7F4sTCyUqN33…`, `4QwJ4AXMtSjn…`, `rpcRequests: 0`),
which this comparison covers regardless. It is **n = 15 on one population** and is offered as an
observation, not a rate.

---

## Disconfirming evidence, and what this does not say

- **Room is still an upper bound.** `roomIsProven` is a floor on the evidence, so a cohort wallet
  that neither shares a transaction nor rides the deployer's block-index run is counted as
  independent. The census records that **13 of the 15 lean on 182a's adjacency half on at least one
  window**; if those operations submit cohort buys non-adjacently on some launches, that window's
  room is overstated. This bears more weight here than it ever has, because the measurement has now
  said yes twice.
- **The two dust-dev-buy candidates do NOT reach Stage 3, and they are not pooled with the rest.**
  `ARB8KYfnnUwh…` and `BWoZVgNjTg5u…` show a 0.0010 SOL dev buy on most windows, so their room is
  high because the operation did not stake rather than because outsiders were large. `ARB8…` is
  refused on the gross field, `BWoZ…` on the net field. Neither is in the six, so **no Stage 3 count
  here rests on a dust-buy launch** — that is how it fell out, not something this lane arranged.
- **One of the six was already rejected by this repo — and it is not in the six.**
  `DxQ1iNidsGap…` is `gate-failed` in `runs/2026-08-04.json` with `entry: null`; it is refused here
  too, on the net field. The one candidate with a prior record agrees with its prior record.
- **All 15 are sub-gate** — they fail `minCompletionRate` 0.25 — so every figure here is about the
  population the Stage 1 gate rejects. The census's `subgate-population-admission` decision is
  untouched and is the captain's.
- **`entry-open-after-costs` is not "profitable".** It is: room clears 0.55, the seat prices under
  0.12 per SOL staked, and the field's *measured* net result is positive on a *lower-bound* cost.
  Stage 3 — exit — has not run and no exit signal reached any number here (decision 237a).
- **One month, one venue, one rule, and a 14-day window.** These are the census's own windows,
  2026-07-27 → 2026-08-10, all pump.fun bonding curve. Nothing here says these deployers were
  enterable in June or will be next week.
- **A schema note for anyone pooling this.** These are not run records; `result.json` is this lane's
  own shape and carries no `RECORD_SCHEMA_VERSION`. It is not the grading lane's input and
  `runs/` is untouched.

---

## What I recommend, and what I do not

**The one thing that would finish this count.** Raising the Helius stop prices the remaining three
and turns 6-of-12 into 6-to-9 of 15. It is the cheapest outstanding measurement in this project.
**What it costs is an ESTIMATE, and the distinction is the one this lane's own brief warned about
before the work started**: a figure is a bound only when something structurally enforces it, and a
projection from a measured ratio — even one measured on these very candidates — is not.

- **The work is 532 transactions, not 365.** This lane has no resume and no cache, so re-running the
  three re-prices their WHOLE target list (`coverage.cost.transactionsTargeted` 177 + 156 + 199).
  The 365 quoted earlier is the UNPRICED REMAINDER of this run — a different quantity, correct where
  it appears above as a single-run counterfactual and wrong as the price of a re-run.
- **~370 Helius requests is a PROJECTION**, from the block route's observed 0.6907 requests per
  priced transaction on this run (1,398 over 2,024). Nothing holds the next run to that ratio: the
  block route's saving depends on how the create-slot transactions cluster.
- **What IS bounded, and by what:** at most 1,500 Helius requests per candidate-share by
  `costCeilingFor` and the raised lane ceiling, because `SolanaRpcClient` checks its ceiling
  immediately before every attempt, retries included; and at most 486 keyless swap-api requests for
  the re-walk of 27 windows (27 × the pinned 18-per-launch cap), enforced the same way by the
  per-launch client. Those two are ceilings the code applies, not sizings from this run.

Wall-clock is dominated by the pinned 7,000 ms fill pacing. **I have not run it.**

**What I do not recommend.** Nothing here argues for moving `maxEntryCostPerSolStaked`: it refused
nobody, so there is no evidence about where it should sit. Nothing here argues for moving
`minRoomLeft` or loosening `roomIsProven`. And the six are not a trading recommendation — they are an
upper bound that survived.

---

## Files

| file | what |
|---|---|
| `census-input.json` | the 15 and their 145 census windows, copied verbatim; the pinned population |
| `price-entry.mjs` | the harness — clients, population and lane ceiling only; it re-implements no rule |
| `summarise.mjs` | the roll-up and the exact intervals; offline, and it reproduces the census's five published intervals |
| `result.json` | every candidate's full score, coverage and spend — **carrying two post-run amendments, `laneUnmeasuredCause` and the top-level `thresholdsMinPricedFraction`**, both enumerated in the provenance note above, which also states the key-set check behind that list |
| `summary.json` | the machine-readable roll-up, regenerated offline from `result.json` after that derivation |
| `run.log` | **the run's own console output, verbatim — and it PREDATES the lane-cause derivation.** It prints the plan header and one verdict line per candidate; it never prints `laneUnmeasuredCause`, so look to `result.json` and the provenance note above for that field's history. Nothing in it was superseded |
| `run-abandoned-2026-08-10.log` | a first attempt on one candidate, stopped when the fill route was reconsidered: **ten windows attempted — nine walked and one dropped at the per-launch request cap — for 99 keyless swap-api requests and no metered credit of any kind.** It produced no result. Its 99 are NOT in the 611 above and ARE in the lane total of 710; kept so the record is not silent about it |
