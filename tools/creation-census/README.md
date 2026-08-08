# The creation census

**Every pump.fun deployer that created in one past month, taken whole above a stated count.** One
Dune execution per month, keyed, zero MadeOnSol and zero Helius. It is the answer to a ceiling this
project has carried since discovery existed: `tools/deployer-screen/FEED.md`'s first line is that
**discovery is 100% vendor-selected**, so a deployer MadeOnSol never profiled is invisible rather
than rare.

Captain decision 187a, 2026-08-04. The measurement behind it is
`data/slot-zero-discovery-widen-operations/report.md` §§2.1, 4.1, 5 and 6.

---

## What it buys, measured

| | current feed sees | this census reaches |
|---|---|---|
| deployers creating in **2026-07** at ≥30 launches | 5 of the whole 82-wallet ledger | **3,036** |
| deployers creating in 2026-07 at ≥8 launches (scout) | 25 | 10,280 |
| …**clearing the Stage 1 competence gate**, one seed month (scout) | **8** | **35** |

### 3,036 and 10,280 are ONE census at two floors

The figure that authorised this lane is **10,280** and the committed run reports **3,036**. They do
not disagree: the investigation's own ladder for 2026-07 reads 176,200 at ≥1, 22,620 at ≥4, **10,280
at ≥8**, 5,416 at ≥15 and **3,036 at ≥30**, and this run used a floor of **30**. Same month, same two
surfaces, same signer attribution, same dedup by mint — **the only difference is `min_launches`**.

That reconciliation is not left to a reader. `PUBLISHED_LADDER` carries the investigation's whole
ladder, every record carries a `reconciliation` block naming the cut in full and comparing the count
against the published figure **at the same floor**, and the committed run reconciles at 3,036 = 3,036
— the same number, not a close one. A future run of a closed month that disagrees at the same floor
says `agrees: false` and names the two things that could have changed, instead of shipping a
different number under the same name.

One limit the block states rather than implies: **the record's own ladder starts at the floor the run
used, so it cannot re-derive the lower rungs.** Reproducing 10,280 costs another execution.

A second, independent cross-check from the same execution: the probe's in-month `evt_createevent` row
count is **857,288**, identical to the investigation's "total mints created" for 2026-07.

The third row is the one that decides it. It is not "more wallets" — it is about **27 named wallets
that pass this repository's own competence bar and that the project structurally could not see**.
Under the run committed here, **3,031 of the 3,036 are absent from the committed ledger**, and the
census's own top wallet by July volume is not in it either.

Two sanity checks that the census is finding real operators rather than only noise:

- **`7ufmve7Z…` falls out of it unprompted, at 62 launches in July** — the one deployer this
  repository independently knows is competent, arriving without being asked for.
- **`2E94st2NZnzA943HBceijgkw75gXTTxch39yquMBfeQk` is present at 432 July launches and is NOT in
  the ledger.** The scout measured its lifetime history at 481 launches / 0.6029 bonded, against our
  own subject deployer's 0.4360.

**Neither of those is a verdict.** A census answers *who created*, and nothing else — no bonding
rate reaches a candidate from here, and gating discovery on a census-derived competence measure is a
separate captain decision (188a), not something this lane does.

---

## Running it

```bash
node tools/creation-census/run.mjs                        # dry run. Issues NOTHING. The default.
node tools/creation-census/run.mjs --verify --live        # 1 request, 0 executions
node tools/creation-census/run.mjs --month 2026-07 --live # 1 execution
```

`--live` is required to spend anything and **the dry run is the default**, because the binding unit
cannot be taken back: a Dune execution is billed whether or not it succeeds and is never retried.
The dry run prints the query id, the month bounds, every parameter and every ceiling, and issues no
request at all.

A run writes two files to `runs/`:

- **`<month>-cohort.json`** — the raw result rows, one per line, in the envelope
  `tools/arrival-rate-walk/cohort.mjs` → `readDuneResultFile` already accepts. **The coverage rows
  are in this file too**: the count and the evidence for the count are one artefact, not two.
- **`<month>-census.json`** — the reading of it. A versioned contract (`RECORD_SCHEMA_VERSION`):
  bump, never retro-edit, because committed records are evidence that a census ran and what it saw.

Exit codes: `0` ran, `2` refused (a real answer about our own evidence, not a fault), `3` credential,
`4` vendor refused — and on `4` the execution may already have been billed — and **`5` WE STOPPED
IT**: the execution was still running at `bounds.json` → `dune.executionDeadlineMs` and this run
cancelled it rather than keep paying (captain decision 381). `5` is deliberately not folded into `4`.
A `4` sends an operator to look at Dune or at the SQL; a `5` is a statement that has outgrown its
deadline, and the fix is a decision about how much engine time `COHORT_SQL` is worth.

### Deploying, and the claim that was false for a month

`COHORT_SQL` lives in `tools/arrival-rate-walk/cohort.mjs`, which is **keyless throughout** — its
credential allow-list is empty and a test enforces it — so it commits the statement and cannot run
it. This directory is that statement's keyed half. It is deployed as saved query **`8214953`**
(2026-08-04) and `bounds.json` → `census.queryId` pins it.

Both files recorded, for a month, that this could not be deployed because *"the free tier's ten
private query slots are full"*. **The account held eight**, six of them retired scratch probes, and
that one sentence is why the widening sat undone. So the fix is not a better number in a comment —
a number in a comment is a claim, and the next reader has to take it on faith exactly as this one
was taken:

```bash
# The slot count, re-checkable at any time. `total` is the figure.
curl -sS -H "X-Dune-API-Key: $DUNE_API_KEY" 'https://api.dune.com/api/v1/queries?limit=100'
```

`run.mjs --deploy` calls exactly that itself, immediately before creating anything, and **refuses**
if the slots are full. It never deletes or archives an existing query to make room — which of them
is retired is not this tool's call.

**AND ON THE KEY THIS FLEET IS USING TODAY THE PRIVATE ALLOWANCE IS ZERO, WHICH `--deploy` CANNOT
SATISFY AT ALL.** Measured 2026-08-08: `GET /queries` reports `total: 0` and `POST /usage` reports
`private_queries: 0`, yet `POST /api/v1/query` with `is_private: true` returns
`402 Max number of private queries reached` — while the same create as a **public** query succeeds
(`slot-zero-venue-gradeability-inventory` → `report.md` §0, held in firstmate's records, not in this
repo). So a local count of zero-in-use passes this check and the vendor refuses anyway.
`deploySavedQuery` still sends `is_private: true` and is **left that way**: publishing the statement
is a custody decision for the captain, not a passing fix, and nothing is blocked meanwhile because
`8214953` is already deployed and every run VERIFIES rather than creates. A lane that needs a
scratch slot on this key must create a public query or it cannot run at all.

**Deploying the committed SQL is half a change.** If `COHORT_SQL` is edited, the saved query must be
updated in place in the same commit: `run.mjs` compares the two before every execution and refuses
the whole leg, terminally, when they differ. A saved query is editable from a browser and this one
decides which deployers a whole lane is about.

---

## Bounds

Pinned in `bounds.json`, every value with a stated reason (a test enforces that, and *"no
measurement backs this, and here is what would"* is an acceptable reason — inventing an anchor is
not).

| | |
|---|---|
| executions | **1 per run**, which is one census month. The coverage probe rides in the same result. |
| requests | **48**, covering the credit-guard `POST /usage`, the verification, the execution, up to 40 polls and the one read, plus one retry of headroom. It is `maxPollAttempts + 5` and must stay there: below it the request ceiling binds first, and a run that exhausts its budget between the execution and the read has burned a billed, unrecoverable execution and thrown its answer away. **The cancel is exempt from it** — a ceiling that could refuse the one request that stops a spend would be the wrong way round — so a run that had to cancel reports one request above this figure. |
| execution deadline | **120,000 ms**, the give-up point at which a still-running execution is CANCELLED rather than abandoned. Exactly `maxPollAttempts × pollIntervalMs`, so nothing about *when* this lane gives up moved; what moved is that it now stops the engine. Worth at most **13 credits** of compute if cancelling stops Dune's clock, against the **200** the guard reserves in case it does not. |
| result rows | **5,000** deployer rows, ceiling 20,000; read at `?limit=` rows + 64 |
| pacing | **250 ms** between request starts |
| measured cost | **1 execution, 5 requests, 188,232 result bytes, ~3.8 export credits** (estimate) |
| worst case reserved | **224.51 credits** at the default `--max-rows` — 1 execution at 200 plus 2 reads of 5,064 rows at 121 B. It is what a plan is REFUSED on, not what a run costs; the gap between it and the measured ~5 above is the point of captain decision 381 and is explained under "The monthly credit ceiling". |

### The monthly credit ceiling — checked, not discovered by hitting

**The ceiling is credits per BILLING PERIOD, the period is not a calendar month, and it is not the
same period on every key.** One of this fleet's Dune accounts was measured running **2026-07-29 →
2026-08-29** and another runs **2026-08-06 → 2026-09-06** — they reset on subscription anniversaries.
**A separate key is a separate ACCOUNT** with its own quota and its own period; read both out of the
`POST /usage` response the key in use returned, and pin neither. Three units are involved and they are not interchangeable: credits are the allowance,
**executions** are billed whether or not they succeed, and result **bytes** are billed separately at
~20 credits/MB.

**TWO CEILINGS APPLY AND THE SMALLER ONE BINDS** (captain decision 322a, 2026-08-06). One is the
**vendor's** `credits_included` for the current period — 2,500 on the Free tier. The other is the
**operator's own monthly cap**, `bounds.json` → `dune.monthlyCreditCapCredits`, which is where an
operator changes it. That cap is a **GLOBAL policy number**: one fleet-wide monthly total
across every lane and project that touches Dune, so `tools/deployer-screen/thresholds.json` carries
the same key with the same value and `test/dune-credit-ceiling.test.ts` pins the two equal — neither
keyed tool may import the other, so one number across both is a duplicated value held together by a
test, exactly as the credit guard's own text is. **An operator changing the cap changes both files.**
**What is ENFORCED is per account-period**, because that is the only counter that exists: the fleet
holds more than one Dune key, and two keys each honouring the cap spend twice it between them with
neither run wrong. One key, or a smaller cap on each, is the captain's call.

It binds despite this lane holding no state between runs, because `client.mjs` →
`bindingCreditCeiling` takes the `min()` and the comparison is against the PERIOD's own
`credits_used`, which is the account's running total rather than a run's. Both figures and the name
of the one that bound reach every verdict, so a refusal says whether to raise the cap or wait for the
period to roll. A cap **above** the vendor's figure changes no verdict at all — which is the point:
a cap that needlessly deferred a census would fail the requirement as surely as an overspend would.

**Consumption is read from `POST /api/v1/usage`** — free, consumes no credits, reporting
`credits_used` / `credits_included` per period. `client.mjs` → `readUsage` fetches it,
`parseUsageResponse` reads it, `run.mjs` → `checkDuneAllowance` decides, and it runs **first**:
ahead of the saved-query verification and long ahead of the execution.

**What a run does when it does not fit.** `run.mjs` → `duneSpendPlan` prices the CEILINGS — one
execution at `worstCaseCreditsPerExecution`, plus reads at this month's own `?limit=` of at most
`resultBytesPerRowCeiling` bytes a row:

| verdict | what happens |
|---|---|
| `sufficient` | the run proceeds |
| `tight` | it proceeds and **says this may be the last run the period can afford** |
| `insufficient` | **refused, exit 2, nothing issued but the free read.** No execution, not even the saved-query GET |
| `unreadable` | **refused** — an unreadable balance is not headroom |

`unreadable` has three causes and all three refuse. The vendor's body could not be read; **no
returned billing period contains the instant of the reading**, so the CURRENT period was never
established (we POST an empty body, which is documented to return exactly that period, so a
non-bracketing answer means something is wrong and the newest listed period is *not* a substitute);
or **the plan itself did not price to a finite number of credits**, which a missing or non-numeric
pinned bound produces — **and the operator's cap is checked in that same place and by that same
rule**, so a cap that is missing, zero or non-numeric refuses rather than leaving this lane silently
uncapped. The last two refuse even under `allowanceRequired: false`, because that flag waives an
unread *balance* and here it is the run's own cost, or its own ceiling, that is unknown.

**This lane has no fallback** — unlike the screen, which walks the Solana RPC when Dune refuses, a
census with no Dune answer is no census. So refusing costs one deferred run, while proceeding blind
costs a billed execution that returns nothing and cannot be retried this period. `--dry-run`, the
default, prints the worst case with **no key at all** — and where the cap pin itself is missing or
non-numeric it prints that named refusal in place of a figure, in the same wording a live run refuses
in (`client.mjs` → `describeMonthlyCapCredits`, the one renderer for both keyed lanes), so a typoed
cap reads as the named state rather than as `undefined`.

**What the guard cannot see** — and both caveats travel on every verdict, passing ones included:

- **The counter LAGS.** Measured: `credits_used` rose **+6.0 while the account was idle**, in
  whole-credit jumps. A reading is a *floor* on spend and a *ceiling* on what remains, so
  `allowanceReserveCredits` is held back before any comparison.
- **A reading is ONE ACCOUNT's, and the lanes are many.** The key is the captain's alone and is
  **not shared** with another holder (captain, 2026-08-06) — which is what makes a configured cap
  enforceable at all — but every lane and run of this fleet draws on that account's total and nothing
  tracks it between runs, so a sibling run can spend the remainder between our reading and our
  execution, and a **different key** is a different account this reading cannot see. *A sufficient reading is evidence, never a reservation.* **Unshared is not the same
  claim as "the counter is exact"**: only the first changed, and the reserve above still comes off.
- **IT CANNOT BOUND WHAT AN EXECUTION ACTUALLY COSTS — only what this run is allowed to PLAN.** The
  spend happens after the check passes, and Dune caps a single execution's cost nowhere. That is not
  hypothetical: a lane running behind this exact code path, with the counter re-read before every
  execution, printed `verdict: sufficient (ok=true)` against a pinned worst case of 6 credits and was
  billed **180.002**. Dune bills compute by engine time, so **"a failed execution is free" is true
  only of a statement that fails to COMPILE** — one that compiles and then runs to the vendor's
  30-minute limit consumes the whole limit and is billed for it, and both come back as "failed".
  Captain decision 381 is both halves of the answer: `worstCaseCreditsPerExecution` is re-derived
  against that engine floor (25 → **200**, so a default census now reserves 224.51 credits rather
  than 49.51 and a 4,000-credit period affords ~17 reserved runs rather than ~80), and
  `executionDeadlineMs` **cancels** an execution still running at 120 s rather than walking away from
  a live engine. **Cancelling bounds the WAIT for certain and the BILL only if Dune stops the engine
  on cancel** — undocumented, and settling it would cost a runaway execution — which is exactly why
  the pin sits at the engine floor rather than at the deadline's own 13 credits. A cancelled run is
  its own outcome, **exit 5**, never folded into the vendor's exit 4. Both pins' `justification`
  entries own the arithmetic; cite them rather than restating it.
- **Execution compute is not predictable from the vendor** — Dune publishes no price table — so
  `worstCaseCreditsPerExecution` is a per-lane pin. `COHORT_SQL` growing a trade-tape join would
  need it re-measured, and the trade-join figures on record are SUCCESSFUL executions that say
  nothing about where a joined statement's own timeout floor sits.
- **Nothing tracks the period across runs.** The record carries the reading it took plus
  `dune.localEstimate`, this run's own estimate of its own spend, labelled as one — re-reading
  `/usage` afterwards would report the balance from *before* the run.
- **ONE FIELD NAME IS AN ASSUMPTION.** Dune's docs contradict themselves — response schema
  `billing_periods`, example `billingPeriods` — and no live response has been seen from this
  repository. Both spellings are accepted; narrow it if one is ever settled.

---

## The bias, named

A census carries **no survivorship bias and no cadence bias**: it holds every creation in the month,
attributed to the **signer** (`"user"` / `account_user` — `creator` is a settable `CreateV2` argument
and is not proof of authorship), with no vendor in the loop and no "still active" term. It carries
two others, and both are in the output rather than only here.

### 1. Silent table start dates — and the probe that refuses them

Decoded tables answer confidently and wrongly before their first row, with nothing in the response
saying so. It is the same failure shape as a truncated backwards walk in `pumpfun.mjs`, failing in
the same direction: plausible and silent. So **the count travels with the probe that proves its
table coverage**, `assessCensusCoverage` refuses a result whose surfaces do not bracket the month,
and there is **no fallback** — nothing else enumerates strangers by creation month, so a refused
census stops the lane rather than shrinking it.

Re-asserted by the committed run rather than assumed:

```
evt_createevent  2024-04-26 -> 2026-08-04   857,288 rows in month   brackets=true
call_create      2024-01-14 -> 2026-08-04     2,851 rows in month   brackets=true
```

Note the second table's 2,851 rows against the first's 857,288: `pump_call_create` decodes only the
original `Create` and nearly everything is `CreateV2` now. It stays in the union because it is the
half that reaches back before 2024-04, and neither table alone spans both boundaries.
`pump_call_create_v2` is deliberately absent — not backfilled before ~2026-04-28, so it would
silently return nothing for an early-2026 month.

### 2. `min_launches` is a PROLIFIC-NESS cut, not a competence one

`census.mjs` → `PROLIFIC_CUT_CAVEAT` is the sentence, and it travels to the run record, the rendered
summary and this file — a test pins all three, because a caveat that lives only in a doc is one a
consumer never meets.

> THE min_launches FLOOR IS A PROLIFIC-NESS CUT, NOT A COMPETENCE ONE. It selects deployers by how
> much they created in the seed month and by nothing else — no bonding rate, no completion, no
> "still active" term — so it is the same species of filter as the vendor feed's, which looked like
> quality and was tempo. It is weaker in three ways that matter (historical rather than trailing,
> per calendar month rather than per 7.5 days, and conditioning on volume rather than on success)
> and it introduces no survivorship bias at all. What it DOES miss is the low-cadence deployer: a
> wallet launching three times a month for two years is absent at any floor above three, and nothing
> in the output reveals that. Raising this floor narrows the census on prolific-ness alone; whoever
> raises it must say so here.

The pinned value of **30** is chosen for **result size**, not for meaning: the measured ladder for
2026-07 is 10,280 deployers at ≥8, 5,416 at ≥15 and 3,036 at ≥30, and 3,036 rows is ~0.19 MB and
~3.8 export credits where a floor of 8 would be ~17. Tuning the sample *size* is legitimate and is
disclosed; tuning it to reach a finding is not, and nothing in this lane reads the result before
choosing the floor.

The record publishes a **ladder** — the lowest threshold whose cohort fits each of several target
sizes — so a later reader can see what a different floor would have produced without another
execution.

---

## Reading the census's largest deployers — the oversized split

**`OVERSIZED-SPLIT.md` owns it, with its evidence in `runs/2026-08-04-oversized-split.json`.** The
census names deployers; the deployer screen's Dune leg then enumerates each one's whole creation
history, and `CREATION_SQL`'s per-deployer row cap **refused 604 of these 3,036 wallets (19.9%),
biased towards the largest histories**. Captain decision 196a splits those wallets into their own
execution rather than raising the cap. Measured on a 40-wallet draw from this cohort: cap refusals
**9/40 → 0/40**, overall refusals **12/40 → 5/40**, for 3 extra executions and ~43 estimated export
credits.

**The remaining refusals are a different cause** — a wallet whose newest launch post-dates the cached
coverage probe — and the split cannot touch it. Do not read the after figure as a closed blackout.

## What this tool cannot answer

- **Whether any of these wallets is beatable.** That is the deployer screen's question and its
  stages; nothing here produces an entry number, a room reading or a P&L.
- **Whether any of these wallets is competent.** The census carries creation counts and nothing
  else. Gating discovery on a census-derived competence measure is captain decision 188a and a
  different lane; this one deliberately does not pre-empt it.
- **Who created a mint whose creator record has since moved.** It does not need to: attribution is
  the signer of the creation, which is exactly the field a fee-sharing migration or a CTO does not
  touch. That is why the census finds `maxxing` under `7ufmve7Z…` where every ownership surface does
  not.
- **Anything before a read surface's first row.** See the probe above. The refusal is the answer.
- **Deployers below the floor.** See the caveat above. That absence is invisible in the output,
  which is why the sentence is in the output.

---

## Why the SQL and the reader are duplicated

`CENSUS_SQL` is a byte-for-byte copy of `COHORT_SQL`, and `parseCensusRows` /
`assessCensusCoverage` are copies of that module's readers. The boundary in this repository is the
**directory** (`CLAUDE.md`), and the duplicated keyless client across the existing tools is that
boundary's stated cost; this lane pays the same cost so that a keyless, days-long collector and a
keyed, scheduled census cannot break each other.

**The duplication is pinned, not promised.** `test/creation-census.test.ts` asserts the two SQL texts
are identical and drives both readers over one set of fixtures requiring the same verdict, so a
divergence fails a test rather than producing two different censuses.
