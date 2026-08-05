# The seeding comparison — untiered against `--tier` good/elite

Captain decision 232c. Run the widened screen on **both** seedings at
`stage1_gate.minCompletionRate = 0.25` (held by decision 231a — not moved, not tuned, nothing fitted
to an output) and report the comparison. **Choosing the seeding is the captain's and is not done
here.**

Three run records, all **schema 16**, all `completed: true`, all on 2026-08-05 within 166 minutes of
each other:

| leg | invocation | record |
|---|---|---|
| A — untiered | `screen.mjs` (no flag that changes a parameter) | `2026-08-05-untiered.json` |
| B1 — tiered | `screen.mjs --tier good` | `2026-08-05-tier-good.json` |
| B2 — tiered | `screen.mjs --tier elite` | `2026-08-05-tier-elite.json` |

Each carries the predictions it was made to test, embedded verbatim from a document committed
**before** it ran. Leg B is B1 ∪ B2; the two halves are one seeding and are reported together
wherever the comparison is A against B.

---

## The answers, in the order the brief asks them

### 1. How many candidates each leg admits at 0.25, and who they are

| leg | seeded | prefiltered | gated | **admitted** | gate-unmeasured | gate-failed |
|---|---|---|---|---|---|---|
| A untiered | 119 | 43 | 76 | **2** | 5 | 69 |
| B1 `--tier good` | 81 | 12 | 69 | **14** | 0 | 55 |
| B2 `--tier elite` | 59 | 0 | 59 | **13** | 0 | 46 |
| **B union** | — | — | 128 | **27** | 0 | 101 |

No leg was truncated by the candidate cap (`coverageTruncated: false` on all three), so each graded
everything its enumeration surfaced.

**Leg A admitted 2 of 76.** Both on the gate reading, both seeded by `alerts`:

| wallet | gate reading | vendor page | span | source |
|---|---|---|---|---|
| `AbVkRUfy…` | **0.3514** (26/74) | 0.3286 (23/70) | 727.1 d | helius |
| `BK2ciybp…` | **0.3704** (10/27) | 0.3704 (10/27) | 19.6 d | helius |

**Leg B admitted 27** — 14 from good, 13 from elite, and the two tier pools are **disjoint** today,
so the union is a sum rather than a merge. The full rows with both readings, the page-cap flag, the
enumeration source and the mayhem share are in §1 of the harness output reproduced below; the ones
that carry the rest of this report are:

| wallet | leg | gate reading | vendor page | gap | note |
|---|---|---|---|---|---|
| `7ufmve7Z…` | good | **0.4325** (109/252) | 0.5429 (38/70) | +0.1103 | **known-negative control**, page-capped |
| `yHCxHBEa…` | elite | **0.3089** (232/751) | **1.0000** (70/70) | **+0.6911** | regime artefact, page-capped |
| `GeBJSHK4…` | elite | **0.3303** (108/327) | **0.9429** (66/70) | **+0.6126** | regime artefact, page-capped |
| `ARW9Nzhp…` | good | 0.5776 (67/116) | 0.4429 (31/70) | **−0.1347** | page **understates** by 13 points |
| `2syzfo53…` | elite | 0.7813 (25/32) | 0.7813 (25/32) | 0.0000 | highest gate reading admitted |

### 2. How much the two admitted sets overlap

**Pools:** A ∩ B = **10 of 76**, Jaccard **0.0515**. Within leg B, `good ∩ elite = 0` — the two tiers
were completely disjoint on the day, which is a stronger separation than the committed prior records
show (they shared 2) and is consistent with tier membership being a trailing window rather than a
property of a wallet.

**Admitted:** A ∩ B = **2**, Jaccard **0.0741**. The two wallets are `AbVkRUfy…` and `BK2ciybp…` —
which is to say **every wallet leg A admitted, leg B also admitted, and leg B admitted 25 more that
leg A never saw.** Leg A's admitted set is a strict subset of leg B's.

That is the single most decision-relevant number in this report, and it is not symmetric: the
seedings do not disagree about these wallets, they differ in **reach**. On this day, choosing
untiered over tiered forfeits 25 admitted candidates and gains none.

### 3. Where each leg's admitted population sits on the completion-rate distribution

**Both readings are reported for every leg and never combined.** `gate` is the creation-derived
merged history `screen.mjs` gates on; `page` is MadeOnSol's 70-record `profile.pump_tokens` listing,
which `--ownership-only` and `feed.mjs` read and which this bar is **not** measured on.

| leg | reading | p25 | median | p75 | max | clear 0.25 |
|---|---|---|---|---|---|---|
| A untiered | **gate** | 0.0125 | **0.0201** | 0.0891 | 1.0000 | 11 / 75 |
| A untiered | page | 0.0143 | 0.0429 | 0.1000 | 1.0000 | 12 / 75 |
| B1 good | **gate** | 0.3038 | **0.3750** | 0.4246 | 0.6842 | 62 / 67 |
| B1 good | page | 0.3077 | 0.3750 | 0.4226 | 0.6842 | 62 / 67 |
| B2 elite | **gate** | 0.5590 | **0.7273** | 0.8819 | 1.0000 | 55 / 55 |
| B2 elite | page | 0.5888 | 0.7273 | 0.8750 | 1.0000 | 55 / 55 |

The pools are an order of magnitude apart on the gate reading — **0.0201 against 0.3750 against
0.7273** — which is the brief's premise, now measured on one day with one code path instead of
inferred across records written under three schemas.

**And here is what the bar actually does, which the pool medians hide. The binding constraint
inverts between the seedings:**

| leg | eligible on `minTokens` + `minSpanDays` | of those, clear 0.25 | what filters |
|---|---|---|---|
| A untiered | **59 of 76** | **2 of 59** (3.4%) | **the rate bar** |
| B1 good | **18 of 69** | **14 of 18** (77.8%) | **the sample-size bars** |
| B2 elite | **13 of 59** | **13 of 13** (100%) | **the sample-size bars** |

On the untiered pool, 0.25 is doing the work and `minTokens`/`minSpanDays` barely bind. On the
tiered pools it is the reverse: almost everything that reaches the rate bar clears it, and on elite
**the rate bar rejects nobody at all** — the 46 elite rejections are every one of them a sample-size
rejection. So *"a bar means a different thing on each seeding"* is not a figure of speech here:
**on leg B, `minCompletionRate` is very nearly inert, and the population is chosen by `minTokens` and
`minSpanDays` instead.** Any argument about where to set 0.25 is an argument about leg A.

### 4. Is either leg importing the vendor's popularity ranking?

**This splits into two questions that answer differently, and conflating them would have produced
the wrong answer.**

**(a) Rate flattery — does the vendor's surface overstate what these wallets actually did? No.**
Median (page − gate) is **0.0000** on all three pools *and* all three admitted sets:

| leg | pool median gap | pool p75 | pool max | admitted median gap | admitted range |
|---|---|---|---|---|---|
| A untiered | 0.0000 | 0.0147 | 0.2125 | −0.0114 | −0.0228 … 0.0000 |
| B1 good | 0.0000 | 0.0000 | 0.1111 | 0.0000 | −0.1347 … +0.1103 |
| B2 elite | 0.0000 | 0.0000 | **0.6911** | 0.0000 | −0.0824 … **+0.6911** |

For most wallets the two readings are **identical**, because the ownership page only diverges once a
history exceeds its 70-record cap — 5 of 69 wallets on good, 7 of 59 on elite. Where it does diverge
it runs **both ways**: `ARW9Nzhp…` reads 0.5776 on the gate against 0.4429 on the page, the page
understating a good deployer by 13 points, which is the ownership bias in its documented direction.
So the tiered seeding is **not** inheriting an inflated view of its wallets.

**(b) Selection — does the leg's admitted set ride the vendor's volume ranking? Yes, on leg B; no,
on leg A. Completely.**

| leg | pool provenance | **admitted provenance** |
|---|---|---|
| A untiered | leaderboard 50, recent-bonds 18, alerts 10 | **alerts 2, leaderboard 0, recent-bonds 0** |
| B1 good | leaderboard 50, alerts 19, recent-bonds 17 | **leaderboard 14 of 14**, alerts 5, recent-bonds 3 |
| B2 elite | leaderboard 50, recent-bonds 18, alerts 17 | **leaderboard 13 of 13**, recent-bonds 6, alerts 3 |

*(a wallet can be seeded by more than one query, so rows exceed the pool size)*

**Every one of leg B's 27 admissions was reachable through `leaderboard:total_bonded` — the vendor's
volume ranking. None of leg A's 2 were; both came through `alerts`, the activity feed.** The
leaderboard supplied 50 candidates to leg A as well and got **zero** of them admitted, because
untiered it serves the industrial-spam tail the gate then rejects.

**So the answer to the captain's question is: the tiered seeding imports the vendor's ranking through
SELECTION, not through inflated claims.** The tier filter restricts three seeds to wallets the vendor
already grades well, and what survives the gate is then whatever that ranking put in front of it. The
untiered seeding's admissions come from the one seed that is not a ranking at all.

**Read against the captain's stated edge — devs whose own launch bot is badly configured — that
matters, but it does not settle the choice, and it should not be quoted as though it did.** Being on
a vendor's volume leaderboard is not evidence that a deployer's opening window is tight; nothing here
measures a correlation between vendor rank and `roomLeft`, and n = 2 on the untiered side is far too
thin to claim the alerts route finds under-picked deployers *better*. What is established is
narrower and still useful: **leg B's admissions are, without exception, wallets the vendor's own
ranking surfaced, and leg A's are not.**

### 5. Any candidate a high bar would keep while excluding the control — and whether the artefact still reads higher

The control `7ufmve7Z…` appeared in **leg B1 only** (absent from both the untiered and the elite
pools), reading **0.4325 on the gate reading** — exactly the figure `thresholds.json` records — and
**0.5429 on the vendor page**, page-capped at 70 of its 252 creations.

**Within leg B1, a bar set just above the control keeps:**

- **on the gate reading** (the reading the bar is measured on): **16 wallets read above 0.4325**, of
  which **3 are admitted** — `5KTX7LZy…` 0.6563, `2N7qg9a3…` 0.5833, `ARW9Nzhp…` 0.5776. The other 13
  are already gate-failed on `minTokens` or `minSpanDays` (most read 9–19 tokens), so they are not
  candidates a higher bar would "keep" in any useful sense.
- **on the vendor page**: **5 read above 0.5429**, of which **1 is admitted** — `5KTX7LZy…` 0.6563.

**And the prior finding REVERSES between the readings. This is the most consequential result in the
report.**

`thresholds.json` → `minCompletionRate` records that a rate bar cannot separate skill from the
post-break short-window artefact *because the artefact reads higher*, and concludes: **"RAISING THIS
NUMBER REMOVES THE OPERATOR AND KEEPS THE ARTEFACTS."** Both named artefacts were admitted by leg B2
today, so the claim is directly testable for the first time:

| wallet | vendor page | gate reading |
|---|---|---|
| `yHCxHBEa…` (artefact) | **1.0000** | **0.3089** |
| `GeBJSHK4…` (artefact) | **0.9429** | **0.3303** |
| `7ufmve7Z…` (control) | 0.5429 | **0.4325** |

**On the vendor page the claim holds exactly as written** — both artefacts outrank the control, and
any bar removing them removes the operator first.

**On the gate reading it inverts.** Both artefacts read **below** the control. A bar anywhere in
**(0.3303, 0.4325]** removes both artefacts and keeps the control — the separation 231a states does
not exist. The reason is visible in the denominators: the artefacts' page readings are computed over
70 records of a 751- and a 327-creation history, and the creation-derived denominator is what
collapses them.

**What this does and does not license.** It is `n` = 2 artefacts against 1 control, read on one day,
with the control's figure from leg B1 and the artefacts' from leg B2 about an hour apart under the
same build. It is **not** an argument to raise the bar, and nothing here was changed:
`minCompletionRate` stays 0.25 and `thresholds.json` was not touched. What it does establish is that
**231a's asymmetry argument is a property of the VENDOR-PAGE reading and does not transfer to the
reading the bar is actually measured on** — which is the same class of defect 231a itself was raised
to fix, one level in. That belongs to the captain, and it is filed rather than acted on.

---

## Stage 2, which the brief did not ask for and which answered anyway

The 2026-08-04 untiered run reached **zero** measured entry verdicts. These three legs reached
**ten**, all `entry-room-absent`:

| leg | survivors | scored (cap 7) | unscored for cap | `entry-room-absent` | `entry-unmeasured` |
|---|---|---|---|---|---|
| A untiered | 2 | 2 | **0** | **2** | 0 |
| B1 good | 14 | 7 | **7** | **4** | 3 |
| B2 elite | 13 | 7 | **6** | **4** | 3 |

**No candidate on any leg returned `entry-open-after-costs`, and the entry-cost leg never ran** —
`coverage.cost.ran` is `false` on all 16 scored candidates, because room refused first and the free
legs run first by design. So the screen's answer to *"is any of these windows enterable"* is a
measured **no** on 10 candidates and *no answer* on 6, rather than the *no answer at all* of the
previous run.

**The known-negative control was refused live, on a stranger run, for the first time.**
`7ufmve7Z…` scored `entry-room-absent` at room **0.2805 over 10 launches with 0 unproven windows** —
Stage 0 asserts this offline on every run, and here the live path reproduced it end to end.

**The scoring cap is now the binding constraint on leg B, and it was not before.** 13 of leg B's 27
survivors went unscored for cap reasons alone. On leg A the cap did not bind at all. A reader
comparing measured-verdict counts across the legs must divide by what was *scored*, not by what was
admitted.

---

## Prediction grading

27 predictions were committed before the runs. **22 graded mechanically** by resolving each
prediction's `metric` against the record it is embedded in; **5 needed reading a wallet row.**

**Mechanical: 14 hit / 8 miss. Manual: 4 hit / 1 miss. Overall 18 / 27 = 0.667.**

| leg | hits | misses |
|---|---|---|
| A untiered | U1, U2, U3, U4, U5, U6, U8, U9, U10 — **9** | U7 — **1** |
| B1 good | G1, G3, G4, G7, G8 — **5** | G2, G5, G6, G9 — **4** |
| B2 elite | E3, E4, E7, E8 — **4** | E1, E2, E5, E6 — **4** |

**The misses cluster, and they falsify one belief rather than nine.** G5 and E5 predicted the tiered
legs' admissions would be vendor-flattered (gap > +0.05 and > +0.15); both read **0.0000**. G2 and E2
predicted the creation-derived denominator would admit *fewer* than the vendor page had; it admitted
**more** (14 against a predicted ≤ 8; 13 against ≤ 12). G6 predicted the two readings would disagree
more often on a tiered pool; it read 1, the same as untiered. All four rest on the same assumption —
*the vendor page systematically flatters, and the gate reading corrects it downward* — and that
assumption is **wrong for most wallets**, because the two readings are identical below the 70-record
page cap. It holds only for page-capped wallets, and even there it runs both ways.

The other misses are separate: **E1** (elite pool ≤ 45) read 59, because the elite pool is 2.7× its
2026-07-29 size; **E6** (control admitted in elite) missed because the control was not in the elite
pool at all, which is tier drift and not a fact about the wallet; **U7** and **G9** both underestimated
measured entry verdicts, for the good reason recorded above.

**A prediction that was right for the wrong reason is recorded as such: U9.** It predicted the
control would be absent from the untiered pool and it was — but the reasoning was that the untiered
seeds had never surfaced it, and this run shows the control moving between tier feeds day to day, so
the absence is drift rather than a stable property of the untiered seeding.

---

## Spend

**MadeOnSol** — the cap premise changed mid-task. The key was Free-tier (200/day, shared) and is now
Ultra and exclusive to slot-zero, which is what let all three legs run in one sitting instead of
across two allowance days under decision 239a.

| leg | keyed | wall clock |
|---|---|---|
| A untiered | 79 | 52.5 min |
| B1 good | 72 | 44.1 min |
| B2 elite | 62 | 69.9 min |
| **three legs** | **213** | **166.5 min** |

Day total on the key: **388 of 100,000 used**, 99,612 remaining at the last read. Of that 388, ~153
was another holder's spend from before the upgrade, 14 was the leg stopped earlier in the day, 213 is
these three legs, and 8 is the mandated pre-flight and verification header reads. **The pre-flight
ran before every leg** and every leg's worst case (198) fitted the remainder with four orders of
magnitude to spare, so no leg was started that could not finish.

**Dune** — 3 executions, one per leg, all `sufficient` at their own pre-spend allowance check.

| leg | executions | requests | result bytes | export estimate |
|---|---|---|---|---|
| A untiered | 1 | 10 | 2,937,602 | ~58.75 cr |
| B1 good | 1 | 9 | 200,869 | ~4.02 cr |
| B2 elite | 1 | 9 | 282,958 | ~5.66 cr |

**Billing period `2026-07-29 → 2026-08-29`: `credits_used` moved 670.475 → 909.111 across this
lane's whole day, i.e. +238.636, against 2,500 included — 1,590.889 remain.** That delta covers four
executions (the stopped leg's included) and their result reads. It is **~3.1× the sum of the export
estimates** (~75.9), which is compute billed on top exactly as `thresholds.json` warns; and the Dune
key is **shared**, unlike MadeOnSol's, so not all of the delta is provably this lane's. Report the
period figure, not the estimate.

**Helius** — 256,594 credits and 4,381 RPC requests across the three legs, **232,937 of it on leg A
alone** for the reason in the next section. ~2.6% of the unshared 10M monthly allowance.

**Keyless** — 1,369 requests, **0 shed** on every leg.

---

## Three operational findings this run produced, none of them the question asked

### 1. The untiered leg's Dune reading was refused WHOLE, and the row ceiling is why

`dune.unusableNote` on leg A:

> Dune returned **27,731** rows for `…/results?limit=20000`, above the pinned ceiling of 20,000.
> Results are billed by bytes, so an unbounded read is an unbounded bill; the reading is refused
> rather than paged.

This is the arithmetic `thresholds.json` → `maxResultRows` states in advance — the rows bound is
`max(19,999, deployers × 500)`, so **above 39 deployers it can exceed the ceiling** — biting for the
first time. At 76 deployers the per-deployer cap of 500 permits 38,000 rows and the batch returned
27,731. **All 76 candidates fell back to the Helius walk**: `enumerationSource: "helius"` on every
one, `dune.rowsReturned: 0`, `dune.coverage: null`.

Two consequences the report has to carry rather than bury:

- **Leg A has no mayhem reading at all.** `mayhemShare` is `null` on 76 of 76 — UNMEASURED, never
  0%. Captain decision 227a's flag is a Dune column, so a walk-sourced leg cannot report it. Across
  the two tiered legs the flag *was* read, and **every readable share was 0.000** — on a population
  where 27.1% of 2026-07 launches carried the flag, that is worth a second look by whoever owns 227a,
  though it may simply be that these deployers do not use the mode.
- **The gate reading behind leg A came from a different surface than leg B's.** Both are
  "creation-derived" and decision 156a treats them as the same measurement — `CREATION-DERIVED.md`
  reproduces 239 of 239 launches through both — so the comparison stands. But it is a difference
  between the legs that nobody chose, and it cost leg A 232,937 Helius credits and 4,105 RPC
  requests where leg B1 spent 1,924 and 33.

**The cheap mitigation, if a future untiered run wants its Dune answer: `--candidates` below ~39, or
raise the ceiling.** Neither is this lane's call and neither was done.

### 2. The screen cannot see a vendor's daily counter, and this task discovered it by nearly hitting it

Recorded in full in the commit that stopped the first attempt. MadeOnSol returns
`x-ratelimit-remaining` and `x-ratelimit-reset` on **every** response and nothing in this repository
reads them; `budget.maxKeyedRequests` is 200 **per run** and the tool is stateless between runs, so
three legs of 62–85 requests each pass the check individually and exceeded the day together. Every
other ceiling here refuses before the first request — including the Dune monthly balance since schema
13. The Ultra upgrade removed the urgency, not the gap.

### 3. The saved-query count moved again, in the direction the docs say to expect

`POST /usage` reported `private_queries: 9` at the start of this task and **3** at the end. `CLAUDE.md`
says to re-list rather than quote that number and gives two corrections one day apart as the reason;
this is a third. Nothing this lane did creates or archives a query.

---

## What this settles, and what it does not

- **Settled: how many each seeding admits at 0.25, and who.** 2 of 76 untiered; 27 across the tiered
  pair (14 + 13, disjoint pools).
- **Settled: the admitted sets barely overlap, and asymmetrically.** 2 wallets, Jaccard 0.0741, with
  leg A's admitted set a strict **subset** of leg B's.
- **Settled: the bar's role inverts between the seedings.** Untiered, 0.25 rejects 57 of 59 eligible
  wallets; on elite it rejects none, and `minTokens`/`minSpanDays` choose the population instead.
- **Settled: the tiered seeding imports the vendor's ranking by SELECTION, not by rate inflation.**
  27 of 27 tiered admissions were leaderboard-reachable; 0 of 2 untiered ones were. The rate-flattery
  gap is 0.0000 everywhere.
- **Settled, and it corrects a live justification: the "artefact reads higher than the control"
  asymmetry holds on the vendor page and REVERSES on the gate reading.** A bar in (0.3303, 0.4325]
  removes both artefacts and keeps the control.
- **Not settled — and out of scope by the brief: which seeding to use.** The captain's stated edge is
  deployers whose own launch bot is badly configured, and **nothing here measures whether vendor rank
  predicts `roomLeft`.** That correlation is computable from these three records plus a Stage 2 pass
  and is the obvious next question; it was not run.
- **Not settled: whether leg A's `alerts`-only admissions are better candidates.** n = 2. Both were
  also admitted by leg B, and both scored `entry-room-absent`.
- **Not answered: 13 of leg B's 27 survivors.** The scoring cap of 7 left them unscored, which is a
  cap and not a refusal, and it costs no keyed quota to score them — only wall clock.
