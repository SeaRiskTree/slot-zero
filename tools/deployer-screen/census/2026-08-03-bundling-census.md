# The bundling census — how often can the co-ordination rule see anything in a create slot?

**Captain decision 173a (the pass) and 183a (this re-run), 2026-08-03/04.** Run record:
`2026-08-03-bundling-census.json`, beside this file, **schema 2**.
Tool: `node tools/deployer-screen/bundling.mjs`. Bounds: `thresholds.json` → `bundling_census`.

**THE PREDICATE IS THE UNION, AND THAT IS WHAT MAKES THIS RECORD A REPLACEMENT RATHER THAN A SECOND
DOCUMENT.** Every figure here is taken under `measure.mjs` → `roomIsProven` as captain decision 182a
widened it: a launch is **proven** when at least one non-deployer wallet is marked, either by the
**shared-transaction** rule (a create-slot transaction carrying 2+ distinct wallets) or by the
**deployer-anchored contiguous block-index run**. The first run of this census, committed at this
same path under schema 1, measured the **shared-transaction half alone** — so every figure it
published was a **lower bound**, and it is superseded here rather than annotated. Both halves are
reported per launch (`bundledTx`, `runTx`), so that older reading is recoverable from this record
without walking a window again, and it is printed beside the new one throughout.

**Read the sample size before any rate on this page.** Every fraction below is stated with its own
denominator, and the largest denominator here is **14 candidates**. That is not a rounding of 20–30;
it is the entire gate-survivor population this repository can currently reach. §1 says why.

---

## Verdict

**The union roughly two-and-a-half times the per-launch evidence and moves the headline by nothing.**

- **Per-launch proven rate: 44 of 112 windows = 0.3929**, against **18 of 112 = 0.1607** under the
  superseded shared-transaction half. The union added **26 windows by adjacency alone**.
- **Headline — candidates proven on all eight of their most recent eligible launches: 1 of 14 =
  0.0714.** That is the **same 1 of 14** the shared-transaction half reached, and **it is still our
  own control deployer.** Among the thirteen strangers the rate is **0 of 13**, unchanged.

**A smaller number than the expected ceiling is the result, not a broken run.** Captain decision
183a sized this at "about 1-in-14 to about 3-in-14", from a 3-launch probe, and said in the same
breath that an **8-of-8 requirement is harsher than a 3-of-3 proxy, not kinder**. It measured 1 in
14. The ceiling was optimistic and the pass was bounded, keyless, complete, and dropped nothing:
**112 of 112 windows walked back past their own mint, 0 dropped for any cause, exit 0.**

**What the union DID change is the composition of the silence, and that is a real finding.** The
first run reported **11 of 14 "never bundles — permanently unscoreable"**. Under the union:

- **6 of 14 are permanently unscoreable** — neither half marks anything on any of their 8 windows.
- **5 of the 11 are rescued on at least one window**, and they are **exactly the five the bounded
  live probe named** (`data/slot-zero-bundling-predicate-question/report.md` §4.1). §2.4 lists them.
  So "5 of 11" was a shape measured on 3 launches each; it is now a rate measured on 8 each, and it
  reproduced wallet for wallet.
- **3 candidates are now one window short of a verdict** (7 of 8): `3FiWnNDT…`, `5KTX7LZy…`,
  `AbVkRUfy…`. Two of those three were in the first run's "permanently unscoreable" group.

**So the binding constraint has changed hands, exactly as §4.3 predicted.** It is no longer the
predicate. It is the all-or-nothing sampling rule: `minLaunchesSampled == maxLaunchesPerCandidate
== 8`, so a candidate proven on seven of eight windows is silenced by the eighth. **This report does
not re-open that question** — decision 141a owns it and no threshold moved in this lane's diff.

---

## 0. Bounds declared before the first request, and what was actually spent

| provider | metered in | **bound declared** | **actually spent** |
|---|---|---|---|
| **MadeOnSol** | requests | **0** | **0** |
| **Helius** | credits | **0** | **0** |
| **Dune** | executions | **0** | **0** |
| `frontend-api-v3.pump.fun` | requests | 480 (`maxListingRequests`) | **101**, 0 shed |
| `swap-api.pump.fun` | requests | 4,320 (`maxKeylessRequests`) | **490**, 0 shed |
| `api.mainnet-beta.solana.com` | requests | 0 | **0** |

Wall clock **60.4 minutes**, exit 0, run completed. Zero load-shed events on either host.
`--dry-run` printed the whole exposure before the first request, as it must.

**The same cost profile as the first run, which decision 183a required**: 101 listing requests then
against 101 now, 484 fill requests then against 490 now. The 6-request difference is live pagination
on wallets that have launched again, not a change of method.

**The keyed zero is structural, not careful.** There is no keyed client in `bundling.mjs` — a test
asserts `BoundedClient`, `DuneClient`, `SolanaRpcClient`, `credential.mjs` and `process.env` are all
absent from it. The pass could not spend a vendor request if it were told to. **The union half costs
nothing extra**: `sid` is already on every fill the walk fetches, so half (b) adds no request, no
host and no new parse.

---

## 1. The sample is 14, it is under the brief's 20–30, and the reason is not budget

| | |
|---|---|
| cohort found in committed records | **82** wallets |
| gated by this pass, keylessly | **82** |
| cleared the pinned `stage1_gate` bars | **14** |
| surveyed | **14** (the cap is 30; nothing was truncated) |
| gate-failed, not surveyed | 68 |

**14 is the whole population, not a sample of it.** The census cap is 30 and `leftUnsurveyedByCap`
is 0 — every wallet that passed the gate was walked. Reaching 20–30 would require *new* MadeOnSol
discovery, which is keyed and which this environment cannot do.

**It is the same 14 wallets the first run surveyed**, which is what makes the two records
comparable at all: the population did not move under us, so the difference between them is the
predicate and nothing else.

**The gate applied is the OWNERSHIP reading**, which `FEED.md` establishes is biased *towards
rejection*. So these 14 are survivors on the harder of the two readings, and the surveyed population
is a subset of what a keyed Stage 1 would have passed rather than a superset. It agrees with this
repository's own recorded keyed verdicts on **80 of 82** wallets — 73 agreements plus 7 cohort
members carrying no recorded verdict to disagree with — and the two disagreements are the first
run's two, unchanged: `8KYMfXzp…` passes here and was recorded `gate-failed`, `9LUgfzet…` fails here
and was recorded `gate-passed`.

**What a denominator of 14 can and cannot settle.** Its granularity is 1/14 = 7.1 points, and a
95% interval around the headline is roughly ±20 points. It separates *"almost none"* from *"most"*
and settles nothing finer. Do not quote 0.0714 to three figures as though it were a population
parameter.

---

## 2. The four answers

### 2.1 Per-launch proven rate — **44 of 112 = 0.3929** (shared-tx half alone: 18 = 0.1607)

n = **112 launch windows** over **14 candidates**. Every window was walked back past its own mint
and proved: **0 dropped, for any cause**, so the denominator is windows whose create slot was
actually seen. A window that could not be walked is dropped rather than counted as unproven —
counting an unreachable create slot as "the rule saw nothing" would manufacture this very finding.

| reading | windows proven | rate |
|---|---|---|
| **union** (`roomIsProven`, shipped) | **44** | **0.3929** |
| shared-transaction half alone (superseded) | 18 | 0.1607 |
| **added by adjacency alone** | **26** | — |

**The two halves overlap heavily and are still not nested.** Of the 18 bundled windows, **17 also
sit in a deployer-anchored run of 2+ transactions**, but on only **5** of them did that run mark a
wallet the shared-transaction rule had not already marked (`adjacencyMarks > 0`). Meanwhile **26**
windows are proven by adjacency where no transaction was shared at all. So half (b) is mostly
*redundant* where half (a) fires and *load-bearing* where it does not — which is exactly why the
union keeps both and replaces neither.

### 2.2 Per-candidate distributions

Distributions, never a mean — the standing captain bar for this class.

| statistic | n | min | p25 | median | p75 | max |
|---|---|---|---|---|---|---|
| `bundledTx`, per launch | 112 | 0 | 0 | **0** | 0 | 3 |
| `runTx`, per launch | 112 | 1 | 1 | **1** | 4 | 5 |
| `maxWalletsInOneTx`, per launch | 112 | 1 | 1 | **1** | 1 | 3 |
| `coordinatedWallets`, per launch | 112 | 0 | 0 | **0** | 3 | 9 |
| `adjacencyMarks`, per launch | 112 | 0 | 0 | **0** | 2 | 3 |
| create-slot wallets, per launch | 112 | 1 | 3 | **5** | 10.25 | 35 |
| median `runTx`, per candidate | 14 | 1 | 1 | **1** | 3.375 | 5 |
| proven share, per candidate | 14 | 0 | 0 | **0.3125** | 0.8438 | 1 |
| bundled share, per candidate | 14 | 0 | 0 | **0** | 0 | 1 |

**The shape of the distribution changed even though the headline did not.** Under the
shared-transaction half the median candidate's proven share was 0; under the union it is 0.3125, and
the p75 is 0.8438. The evidence per launch is real and it is substantial — it simply does not clear
an 8-of-8 bar.

Per candidate, `usable` is 8 and `dropped` is 0 on every row:

| wallet | listed | rate | span d | **proven / 8** | bundled / 8 | all 8 | never proven | med `runTx` | med create-slot wallets |
|---|---|---|---|---|---|---|---|---|---|
| `7ufmve7Z…` **(our control)** | 249 | 0.4337 | 244.0 | **8** | 8 | **yes** | no | 3 | 13.5 |
| `3FiWnNDT…` | 65 | 0.3846 | 38.5 | **7** | 0 | no | no | 4 | 10.5 |
| `5KTX7LZy…` | 32 | 0.6563 | 42.1 | **7** | 0 | no | no | 4 | 7.5 |
| `AbVkRUfy…` | 73 | 0.3288 | 706.9 | **7** | 6 | no | no | 5 | 10.5 |
| `3yKebvka…` | 29 | 0.3448 | 117.0 | 6 | 0 | no | no | 3.5 | 7 |
| `yHCxHBEa…` | 280 | 0.6714 | 50.4 | 4 | 4 | no | no | 2.5 | 16.5 |
| `GeBJSHK4…` | 280 | 0.3750 | 77.8 | 3 | 0 | no | no | 1 | 4.5 |
| `3jBzE4c9…` | 56 | 0.2679 | 297.0 | 2 | 0 | no | no | 1 | 8.5 |
| `2N7qg9a3…` | 61 | 0.5410 | 581.6 | 0 | 0 | no | **yes** | 1 | 1 |
| `4J54atPc…` | 26 | 0.3077 | 216.4 | 0 | 0 | no | **yes** | 1 | 4 |
| `8KYMfXzp…` | 82 | 0.2927 | 120.5 | 0 | 0 | no | **yes** | 1 | 2 |
| `ALJ4P5QN…` | 162 | 0.3395 | 290.2 | 0 | 0 | no | **yes** | 1 | 4.5 |
| `AQdBYZNy…` | 90 | 0.3667 | 780.6 | 0 | 0 | no | **yes** | 1 | 2.5 |
| `B6QvkTWS…` | 39 | 0.3077 | 789.9 | 0 | 0 | no | **yes** | 1 | 5.5 |

### 2.3 THE HEADLINE — **1 of 14 = 0.0714** proven on all eight, and it did not move

n = **14 candidates with a full 8-window sample** (all 14 produced one, so nothing was excluded for
a reason that is not co-ordination evidence).

| reading | candidates at 8 of 8 | fraction |
|---|---|---|
| **union** | **1** | **0.0714** |
| shared-transaction half alone (superseded) | 1 | 0.0714 |

**That fraction is exactly the population Stage 2 can currently reach a verdict for.** Its
complement — **13 of 14** — is what the current pinning silences.

**And the one is still our own control.** `7ufmve7Z…` is the deployer this repository already holds
239 launches of, and Stage 0 asserts Stage 2 must *refuse* it. **Among the 13 strangers the fraction
is 0 of 13.** On this sample the screen would still produce an entry verdict for nobody it did not
already know.

**Three candidates are one window short.** `3FiWnNDT…`, `5KTX7LZy…` and `AbVkRUfy…` are each proven
on 7 of 8. Under the shared-transaction half the corresponding near-miss group was 2, and neither of
its members was one window short. The population is closer to the bar than it was; it is not over it.

### 2.4 Permanently unscoreable — **6 of 14** — and the other 5 were rescued

| category | count | meaning |
|---|---|---|
| **never proven** | **6** | `coordinatedWallets == 0` on all 8 windows. **NEITHER** half of the rule marks anything, so re-screening produces the same silence forever. |
| one window short (7/8) | **3** | `3FiWnNDT…`, `5KTX7LZy…`, `AbVkRUfy…`. Reachable only by the sampling rule, not by the predicate. |
| partially proven (2–6 of 8) | **4** | `3yKebvka…` 6, `yHCxHBEa…` 4, `GeBJSHK4…` 3, `3jBzE4c9…` 2. |
| scoreable | **1** | our own control. |

The categories are never summed.

**THE SUPERSEDED COUNT WAS 11, AND 5 OF THOSE 11 ARE NOW PROVEN SOMEWHERE.** They are, with their
proven counts: `3FiWnNDT…` 7/8, `5KTX7LZy…` 7/8, `3yKebvka…` 6/8, `GeBJSHK4…` 3/8, `3jBzE4c9…` 2/8.

**These are exactly the five wallets the bounded live probe named**
(`data/slot-zero-bundling-predicate-question/report.md` §4.1, 14 candidates × 3 launches, 195
keyless requests), and the six that stay unproven are exactly its six. The probe measured a shape on
3 launches per wallet and said it could not measure a rate; this run measured 8 launches per wallet
and reproduced the partition wallet for wallet. **That is an independent confirmation at 2.67× the
depth, not a restatement.**

**`GeBJSHK4…` is the case worth naming.** `data/slot-zero-stage2-reverify/report.md` §2a called it
*"the permanent case, not the unlucky one"* — `maxWalletsInOneTx` 1 at min, median and max across
all 8 windows, *"re-running the screen will produce the same silence forever."* That was true of the
shared-transaction half and it is false of the shipped rule: it is proven on **3 of 8** windows. The
sentence should now read that it is unlucky *and* under-sampled, not permanent.

**The 6 that remain are not quiet launches, and their silence is total rather than short.** Pooled
over their own 48 windows their create slots hold a median of **3 wallets**, up to 12, and **33 of
the 48 held 2+**. But `runTx` is **1 on all 48** — the deployer's own transaction sits alone between
two gaps every single time. It is not that the run is short; there is no run at all. Decision 182a
anticipated this group and its "6 of the census's 11 stay correctly unproven" is now measured.

---

## 3. Era and trend — **the live sample cannot carry it, and here is what can**

**It cannot, and I am not going to pretend otherwise.** Each candidate contributes its eight most
recent *contiguous* eligible launches; the sampled ages run median 10.98 days (min 0.27, max 465.2).
Bucketing the 112 windows by age gives this —

| age bucket | launches | proven | rate | bundled | distinct candidates |
|---|---|---|---|---|---|
| 0–7 d | 45 | 30 | 0.6667 | 12 | 9 |
| 7–30 d | 27 | 6 | 0.2222 | 1 | 7 |
| 30–90 d | 26 | 8 | 0.3077 | 5 | 5 |
| 90 d+ | 14 | 0 | 0.0000 | 0 | 2 |

— and **that table is confounded, not a trend.** The 0–7 d bucket is where the heaviest-proving
wallets' launches land, so it is measuring *which deployers launch often*, not *when co-ordination
happens*. With 14 deployers and no within-deployer time depth, deployer identity and calendar time
cannot be separated. **No trend claim is made from this run.**

**Where the era question CAN be answered is offline, at n = 1 deployer.** `--subject-era` buckets the
committed population tape's 235 proved create slots (no request of any kind), under **both** halves:

| month | launches | proven | proven rate | bundled | shared-tx rate | med `runTx` |
|---|---|---|---|---|---|---|
| 2025-12 | 11 | 11 | 1.0000 | 0 | 0.0000 | 4 |
| 2026-01 | 3 | 3 | 1.0000 | 0 | 0.0000 | 4 |
| 2026-02 | 1 | 1 | 1.0000 | 0 | 0.0000 | 4 |
| 2026-03 | 21 | 21 | 1.0000 | 6 | 0.2857 | 4 |
| 2026-04 | 65 | 65 | 1.0000 | 38 | 0.5846 | 3 |
| 2026-05 | 41 | 41 | 1.0000 | 41 | 1.0000 | 3 |
| 2026-06 | 41 | 41 | 1.0000 | 39 | 0.9512 | 3 |
| 2026-07 | 52 | 52 | 1.0000 | 51 | 0.9808 | 3 |
| **whole tape** | **235** | **235** | **1.0000** | **175** | **0.7447** | |

**The gap between the two columns is the whole reason this re-run existed.** Before March 2026 this
operator bundles **0 of 15** and the union proves **15 of 15**. A shared-transaction-only column was
reading *a rule's blind spot* as *a deployer's habit* — which is the same misreading the live census
was making about the 5 wallets of §2.4, one deployer down and with an answer key.

Replaying the headline over that history — would the trailing 8 launches all have been proven, i.e.
would Stage 2 have reached a verdict that day? — gives **228 of 228 trailing windows = 1.0000** under
the union, against **147 of 228 = 0.6447** under the shared-transaction half. Both readings are
**true** for the newest window.

**Read that as one deployer.** It is a within-deployer trend and a second window series does not
exist in this repository. What the shared-transaction column establishes is that **the bundling rate
is not stationary for an operator who changes its submission habit**. What the proven column
establishes is that on the one deployer whose cohort is named, the union never lost a launch.

---

## 4. Three independent cross-checks, and why the zeros are believed

A finding of "almost nobody clears the bar" is exactly the shape a silent parsing bug would produce.
That was checked **before** the zeros were believed, not after.

1. **Our own control, walked live through the production functions.** `7ufmve7Z…` reads **8 of 8
   proven with `bundledTx` 2–3 and `maxWalletsInOneTx` 3 on every window**, agreeing with the
   offline tape's 0.9808 July rate. A run that read every deployer as unproven would have read this
   one that way too.
2. **The probe partition reproduced wallet for wallet.** The same 5 of 11 rescued and the same 6 of
   11 unproven, from an 8-launch sample against the probe's 3-launch one, four days of launches
   apart. Two independent samples, same partition.
3. **`sid` decomposition is validated, not assumed, and it fails safe.** `blockTxIndex` returns
   `NaN` rather than a guess when the key is not the expected shape, and `createSlotGroups` refuses
   adjacency outright when two create-slot transactions share an index — falling back to the
   pre-182a reading. So a format change collapses this measurement towards the *old* number, never
   towards a larger one. The 6 never-proven candidates read `runTx` 1 on 48 of 48 windows, which is
   a live run being read successfully and finding nothing beside the deployer — not a parse failure,
   which would have produced `runTx` 0.

---

## 5. What this measurement does NOT establish

- **It is not a population rate for pump.fun deployers.** It is 14 wallets, every one of them
  surfaced by MadeOnSol enumeration and then gated on competence. Captain decision 165b's warning
  binds: every seed this repository has conditions on current or lifetime success.
- **The launch list is the OWNERSHIP reading.** A listed token may have been **acquired** rather than
  created — its create slot is then somebody else's habit — and a token handed on is missing
  entirely, and the ones handed on are the winners. Measured size of that gap on the five wallets
  holding both readings: nil (`CREATION-DERIVED.md`), which bounds it without removing it.
- **Half (b) marks adjacency, not a decoded bundle, and on a stranger there is no answer key.**
  Whether a transaction at the deployer's index ± 1 is inside its own Jito submission or merely the
  next thing the leader packed is an **inference**; nothing keyless exposes a bundle id. Decision
  182a's null model bounds the coincidence rate on our own tape (adjacency outside the run runs at
  12.35%, predicting ~25 false sweeps against **1** observed) and there is no equivalent bound for a
  denser stranger create slot. **The direction of error is still safe** — the union can only ever
  *lower* a room reading relative to the shared-transaction half — but "proven" here means *the rule
  saw something*, never *this deployer provably co-ordinated*.
- **A proven window is not an enterable one.** No room figure, no field, no entry cost, no verdict
  was computed. Room to enter is a Stage 2 question and this pass is not Stage 2.
- **It does not measure how often deployers co-ordinate.** It measures how often the rule can see
  anything. An unproven create slot is observationally identical to an uncoordinated one.

---

## 6. What the number implies — **and every choice here is the captain's**

Stated as implications, not as recommendations. No threshold moved in this lane's diff, and
lowering `minLaunchesSampled` is separately refused by captain decision 141a and asserted against by
Stage 0.

- **The predicate is no longer the binding constraint; the sampling rule is.** Per-launch evidence
  went 0.1607 → 0.3929 and the headline went 0.0714 → 0.0714. Everything the union bought was
  absorbed by the requirement that all eight windows be proven. §4.3 of the predicate report
  predicted exactly this and it is now measured rather than projected.
- **The reachable population is 3 candidates, not 11, and only by the sampling lever.** Three
  wallets sit at 7 of 8. They are reachable by lowering `minLaunchesSampled` below
  `maxLaunchesPerCandidate` and by nothing else — no predicate reaches them, because they *are*
  proven, just not eight times. That is a genuinely different situation from the first run, where
  the near-miss group was 2 and the barrier was the rule.
- **6 of 14 remain beyond any predicate available.** `runTx` 1 and `maxWalletsInOneTx` 1 on 48 of 48
  windows. No rule that reads a create slot can mark a deployer that buys alone in it, and decision
  139a already measured that the obvious tightening in the other direction matches 0 of 235 launches.
- **The direction of error is unchanged and still correct.** Half (a)'s marked set is a subset of the
  union's by construction, so a room reading can only move **down** — the false-rejection direction.
  Decision 134a's asymmetry is now structural rather than empirical. What this run establishes is the
  *magnitude* of the refusal on the population the screen actually meets: still the common case.
- **Stage 3 is unblocked in correctness, not in volume**, which is what decision 183a already
  concluded before this ran. This run is the evidence for the volume half of that sentence.

---

## 7. Reproduction

```
node tools/deployer-screen/bundling.mjs --dry-run       # the whole exposure, fetches nothing
node tools/deployer-screen/bundling.mjs --subject-era   # §3's offline table, zero requests
node tools/deployer-screen/bundling.mjs --out tools/deployer-screen/census/2026-08-03-bundling-census.json
npm test                                                # tsc clean, vitest green
```

The cohort is read off disk, so the wallet list is reproducible from the tree. The gate readings and
the windows are live and will move as those wallets launch again; the record pins what was seen at
`startedAtIso`. The `--subject-era` table is offline over the committed tape and reproduces exactly.
