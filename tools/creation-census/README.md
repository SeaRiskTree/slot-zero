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
`4` vendor refused — and on `4` the execution may already have been billed.

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
| requests | **40**, covering the verification, the execution, the polls and the one read |
| result rows | **5,000** deployer rows, ceiling 20,000; read at `?limit=` rows + 64 |
| pacing | **250 ms** between request starts |
| measured cost | **1 execution, 5 requests, 188,232 result bytes, ~3.8 export credits** (estimate) |

**Nothing here tracks the month.** The tool is stateless between runs, so the free tier's 2,500
credits a month — shared with whatever else holds this key — are the operator's arithmetic, not the
tool's.

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
