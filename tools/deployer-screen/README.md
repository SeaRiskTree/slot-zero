# deployer-screen

A rerunnable **competence gate** over MadeOnSol's free Deployer Hunter endpoints, plus an **entry
score** measured keyless from pump.fun's fill tape, plus a local validation harness that runs with
no key and no network.

**This tool gates and scores ENTRY. It does not recommend, and it does not score EXIT.**

The question it serves is the captain's, verbatim (2026-07-29):

> *"Can I beat the dev and all other wallets sniping the same tokens created by the dev currently?"*

That splits in two, and only the first half is here:

| stage | question | answer |
|---|---|---|
| 1 | Does this deployer complete bonding curves? | competence. Necessary, nowhere near sufficient. |
| 2 | **Is there room in its opening window, and what does the field there actually achieve?** | **ENTRY.** |
| 3 | Could you get back *out*? | **not built here.** Its own lane. |

Room to enter is not room to leave, and the two are scored **separately and never collapsed** — no
exit signal reaches any number Stage 2 produces. See [Scope](#scope-what-is-and-is-not-built).

The denominator of that question is **launches the wallet created**, not tokens it owns now. Those
are different sets and the difference is not neutral — see
[Which history the gate counts](#which-history-the-gate-counts).

**Where the wallets come from is a separate lane.** `feed.mjs` is a scheduled discovery feed that
surfaces deployers this project has not seen before, triages them on the Stage 1 gate over the cheap
ownership reading, and queues the survivors for this screen — 3 + `--gate` keyed requests a run, no
keyless requests at all, dry by default. It remembers what it has seen so a known wallet is never
offered as new again, and it exits non-zero when its own yield goes dry. **[FEED.md](FEED.md) owns
it**, including the measured discovery lag and the ceiling that vendor-selected discovery imposes on
both lanes.

## Run it

No agent, no build step, no dependencies. Node 20+.

```bash
# Local validation only. No network, no key, no quota. Always safe to run.
node tools/deployer-screen/screen.mjs --stage0

# Show exactly what a real run would fetch, and fetch nothing. FREE, and it ALWAYS prints the plan:
# a figure that could only be had by BUILDING a fill source whose construction is billed is printed
# as UNAVAILABLE with the reason, never thrown and never replaced by another source's number.
node tools/deployer-screen/screen.mjs --dry-run

# The same plan, authorised to BUILD a billed fill source so it can state those figures. It prints
# the bounded spend before spending and the actual after. Today's source is free to build, so this
# buys nothing and says so; it exists for the Gate 3 cutover. See "The dry run is SPLIT" below.
node tools/deployer-screen/screen.mjs --dry-run --dry-run-spend

# A real run. Needs a key (see below). Stage 2 is ON by default. Leave --candidates unset: the
# default grades everything enumeration surfaces, up to the budget. Passing a number below the
# ceiling silently truncates coverage, which is exactly how the first elite run graded 12 of the
# 22 wallets it seeded. With DUNE_API_KEY set the creation-derived history is ENUMERATED on Dune,
# one execution for the whole batch, seconds rather than hours. Budget for the FALLBACK anyway,
# because every candidate may take it: HOURS, not minutes — up to about 15 at the candidate cap,
# since at the pinned bounds the KEYLESS walk alone is ~13.5 hours worst case. With HELIUS_API_KEY
# set that fallback leg is the indexed walk, ~46 minutes, bounded in credits (see Bounds).
# --dry-run prints the arithmetic for your own flags, on whichever route your key selects.
node tools/deployer-screen/screen.mjs --tier elite \
  --consistency --out tools/deployer-screen/runs/$(date +%F).json

# Bound the run instead. The keyless RPC walk is N x 100 x 2.5s, so this is ~40 minutes, not ~13.5 hours.
# It truncates coverage, and the record says so.
node tools/deployer-screen/screen.mjs --tier elite --candidates 12

# Gate the addresses in a FILE instead of enumerating candidates from MadeOnSol — one per line,
# '#' comments, and a malformed entry, a duplicate or an empty list refuses the run (exit 2) using
# none of the file. A supplied list is a SEED, never a substitute for the gate: every listed wallet
# is measured by the same Stage 1 bars. Refused beside --tier and --candidates. See "The vendor
# gatekeeps ENUMERATION, not measurement" below for the rule, the arithmetic and what does not move.
node tools/deployer-screen/screen.mjs --wallets path/to/wallets.txt

# The competence gate alone, which answers nothing about whether a window is enterable.
node tools/deployer-screen/screen.mjs --no-stage2

# A run whose Dune leg answers for NOBODY stops (exit 2) before the first walk request, printing the
# new worst case: that fallback costs roughly two orders of magnitude more per candidate, and the
# credit ceiling cannot catch it. This takes it anyway, deliberately. See "A WHOLE-LEG Dune failure
# is a spend cliff" below; --no-dune plans for the walk from the start instead.
node tools/deployer-screen/screen.mjs --allow-walk-fallback

# The old, fast, BIASED reading — it skips every creation-derived reading, Dune enumeration and
# walk alike, so under an hour rather than ~15.
# Stamped historySource: "ownership-only" in the record, because the bias must travel with it.
node tools/deployer-screen/screen.mjs --tier elite --ownership-only

node tools/deployer-screen/screen.mjs --help

# A separate, KEYLESS measurement pass: how often does a deployer bundle its create-slot
# transaction? It scores nothing and reaches no verdict — see "The bundling census" below.
# --subject-era needs no network at all; --dry-run prints the whole keyless exposure.
node tools/deployer-screen/bundling.mjs --dry-run
node tools/deployer-screen/bundling.mjs --out tools/deployer-screen/census/$(date +%F)-bundling-census.json
node tools/deployer-screen/bundling.mjs --help

# THE FEEDBACK LOOP — how often was the screen right? A bare invocation is a DRY RUN: it reads the
# committed run records and the grade ledger, prints the hit rate and the plan a live run would
# spend, and opens no socket. --live is the only way to reach a provider. See "The feedback loop".
node tools/deployer-screen/grade.mjs
node tools/deployer-screen/grade.mjs --live
node tools/deployer-screen/grade.mjs --help

# THE DUNE ENTRY STATEMENT, RUN AGAINST THE COMMITTED TAPE. Also a DRY RUN by default: it prints
# the batch plan and its credit estimate and opens no socket. --live SPENDS, and it is the most
# expensive thing in this directory — a 1269.195-credit planned worst case against a 2,500-credit
# shared month (657.195 when the record below was written, before captain decision 381 moved this
# lane's per-execution pin 10 -> 61), ~495 spent in fact, almost all of it result bytes. The
# measurement record owns the SPENT figures; read "The reproduction" below before running it,
# because the committed answer is already in measurements/2026-08-05-dune-entry-reproduction/ and a
# test asserts it.
node tools/deployer-screen/dune-reproduction.mjs
node tools/deployer-screen/dune-reproduction.mjs --mints <mint>          # price a change cheaply first
node tools/deployer-screen/dune-reproduction.mjs --live --out <path> --rows <cache>
```

`screen.mjs`'s exit codes are distinct because the worst failure mode for a screen is an empty
result that reads like a real negative (`bundling.mjs` has its own smaller set — `--help`): `0` ran (possibly with zero survivors — a measured outcome), `2` usage,
`3` no credential, `4` credential rejected (401/403), `5` quota (429), `6` ceiling reached,
`7` upstream, `8` Stage 0 failed.

An **HTTP 400 exits `7`, not `4`.** A 400 is our query shape, not the vendor's verdict on the
credential; on a tier where keys expire every 30 days, reporting it as a rejected key would send an
operator to rotate one that works.

A run that stops early still records what it paid for and still exits non-zero. A ceiling hit after
fifteen profiles must not discard fifteen paid-for measurements — re-spending a keyed allowance to
learn the same thing is the cost being avoided. Two rules keep that from doing damage of its own:

- **An incomplete run is never rendered as a measured outcome.** The record carries `completed:
  false`, and the report leads with `!! RUN STOPPED EARLY`. In particular it does **not** print "no
  candidate cleared the gate … the run completed and every candidate was evaluated" — candidates that
  were never requested cannot have failed, and an empty ranking that reads as a real negative is the
  one output this tool exists to make impossible. `completed: true` with
  `coverage.coverageTruncated: true` is the different, benign case: the run finished, and the
  candidate cap simply meant it did not gate everything enumeration surfaced.
- **An incomplete run writes to `<--out>.partial.json`, leaving `<--out>` untouched.** The documented
  invocation is `--out runs/$(date +%F).json`, so a same-day retry that hits a 401 or a 429 would
  otherwise overwrite that day's good record with `candidates: []`. Both artefacts survive, because
  run records are the grading lane's declared input.

## Which history the gate counts

Every surface pump.fun and its resellers publish answers **"which tokens does this wallet OWN
NOW"**. The gate needs **"which tokens did this wallet CREATE"**. They come apart because on
pump.fun the owner collects the token's creator fees, so ownership is a live economic position that
can be sold, handed to a community takeover, or migrated into a fee-sharing config.

**The ones worth handing on are the winners.** So the ownership reading understates a dev's launch
count, understates its *bonded* count by more, and therefore **scores the better dev worse**. A dev
that creates 20, bonds 9, then hands on 3 of the winners reads as 17 launches / 6 bonded = 35%
instead of the true 45%. A gate set at 40% rejects it — and **a false rejection is invisible**: the
wallet is dropped, never researched, and nothing downstream contradicts it. A false *acceptance* at
least gets caught by the beatability screen later. That direction of the bias runs the wrong way.

**It is not the only direction, and the reading is not a one-way conservative filter.** Measured
over one run's 82 candidates, the vendor page's *rate* reads **higher** than the creation-derived
gate's more often than lower, because the page is a success-biased short window rather than merely a
short one. `FEED.md` → "It is biased in BOTH directions at once" is the owner of both directions and
their measured counts; read it before calling this reading conservative.

### The premise, observed rather than inherited

Mint `32CdQdBUxbCsLy5AUHWmyidfwhgGUr9N573NBUrDpump` — `maxxing`, ATH $7.72M, the single best launch
in our subject deployer's 239-launch record — was created by `7ufmve7Z…` in transaction
`64pCziaL…` (slot 383821204, 2025-12-01, pump.fun `CreateV2`, sole non-mint signer `7ufmve7Z…`).
Today `frontend-api-v3/coins/{mint}` reports `creator` and `cto_address` as `CnV5TnQr…`, and the
bonding curve's own `creator` field reads `9v45QaQt…`, a fee-sharing config that is not a wallet at
all. The second move is transaction `5fjZDdFQ…` (slot 398086225, 2026-02-04,
`CreateFeeSharingConfig` → `MigrateBondingCurveCreator` → `MigratePoolCoinCreator`).

`?creator=7ufmve7Z…` cannot return that mint. It is 1 of 239 launches — and it is number 1 by ATH,
by a factor of 8 over the next.

### There is no keyless index by original creator

Probed 2026-08-02, all of these answer *current* owner or do not exist:

| surface | result |
|---|---|
| `frontend-api-v3/coins?creator=` | current creator |
| `frontend-api-v3/coins/{mint}` → `creator`, `cto_address` | current |
| `advanced-api-v2/coins/metadata/{mint}` → `dev` | current — reads the takeover wallet for `maxxing` |
| `advanced-api-v2/coins/list?dev=` / `?devAddress=` | filter silently **ignored**, not applied |
| `frontend-api-v3/coins/user-created-coins/{w}`, `/coins/created-by/{w}`, `swap-api/v2/creators/{w}/coins` | 404 |

So creation is only recoverable **from pump.fun's own surfaces** from the create transaction, and
the only keyless index that reaches one is the wallet's own signature index. `pumpfun.mjs` →
`readCreatedHistory` walks it; `creation.mjs` parses it. A THIRD-PARTY index of the same creation
events exists, and since 2026-08-03 it is what runs first — below.

### The PRIMARY surface: Dune's decoded creation events

Captain decision 156a, 2026-08-03. Creation enumeration reads
`pumpdotfun_solana.pump_evt_createevent` **UNION** `pump_call_create`, deduped by mint, one
execution for a whole candidate batch. `dune.mjs` owns it, `thresholds.json` → `dune` bounds it, and
[CREATION-DERIVED.md §8](./CREATION-DERIVED.md) records what it reproduces and what it costs.

**The walk below is the FALLBACK**, taken when there is no `DUNE_API_KEY`, when Dune fails, or when
the coverage probe refuses a reading — per WALLET, so one run can carry both sources and every
candidate row's `enumerationSource` says which answered it. **Helius is not demoted for
transaction-level work**: Stage 2's entry-cost leg reads `meta.fee` and pre/post balances per
transaction, which no decoded table serves.

Three things about this source that a reader has to hold, because each is a way it returns a
confident wrong answer:

1. **The union is not negotiable.** `pump_call_create` alone returns **zero rows** for our subject,
   which launches with `CreateV2`. `pump_call_create_v2` alone is **not backfilled before
   2026-04-30** and silently misses **101 of our 239 launches, `maxxing` included**. Only the union
   spans both boundaries.
2. **Attribution is `"user"` / `account_user`, the signer — never `creator`**, which is a settable
   `CreateV2` argument: six mints declare our subject as `creator` while being signed by six
   different bot-shaped wallets, inflating the count 247 → 253.
3. **Every count ships with its own coverage probe, and a count reaching outside it is refused
   rather than published.** Decoded tables have silent start dates. The probe reads `min(block_time)`,
   `max(block_time)` and monthly row counts for the exact tables read — and deliberately for one
   table the enumeration does *not* read, so its own output demonstrates why. It refuses a missing
   or empty table, **a month inside the covered span where every read table is empty**, staleness
   past 6 h (re-executed once, since that is the one refusal asking again can fix), and per wallet a
   history reaching the probed floor or past the probed ceiling.

4. **One deployer may not price the whole batch.** Enumeration is ONE execution for every candidate,
   so a refusal at the RESULT level is an all-or-nothing failure: before the per-deployer cap, a
   single industrial-spam wallet — the `total_bonded` leaderboard this tool seeds from serves an
   **8,518-deploy** one — carried the result past `dune.maxResultRows` and sent **every** candidate
   in the run to the walk, trading ~13 hours of walking for ~1 credit of Dune. The SQL now returns at
   most `greatest(500, floor(19999 / <deployers in the batch>))` rows per deployer — most recent
   first, since the question is what a wallet is creating *now* — and carries each deployer's
   **true** count beside them, so a truncated history is detected exactly. The oversized wallet is
   refused with a reason and takes the walk **alone**; everyone else keeps their Dune answer.
   **The 500 is a floor, and it is what keeps an ordinary deployer whole at any batch size**: the
   share-out alone is 102 rows at the 195-candidate cap, which would truncate the subject deployer
   (247 launches) and `4q4GKBpV…` (152) on every full run. 500 is ~2× the largest per-wallet history
   this repo has measured (8, 10, 65, 152, 247 — `CREATION-DERIVED.md` §8.3) and ~17× below the
   8,518-deploy extreme. So the rows bound is `max(19,999, <deployers> × 500)`, **not** 19,999 by
   construction: above 39 deployers the floor binds and the bound is `<deployers> × 500`, which
   exceeds `dune.maxResultRows` above **80** deployers since captain decision 264a raised that
   ceiling 20,000 → 40,000. **The result-row ceiling is kept as the backstop** that refuses such a
   result whole — the same fallback as before the cap existed. It takes roughly 80 wallets of 500+
   launches in one batch to get there.

**And the same rule past coverage: a reading that cannot vouch for itself falls back to the walk
rather than being gated on.** A result read that cannot prove it is whole (no `total_row_count`, a
total above the ceiling, exactly the `?limit=` many rows, or rows disagreeing with the declared
total — `/results` pages on response size independently of our limit) is refused. **A wallet the
per-deployer cap truncated is refused too, and it is NOT the same check**: that one compares
`rows.length` against the result set's own `total_row_count`, where a mismatch means the vendor
paged on response size; this one compares the rows returned for ONE wallet against the count that
wallet's own rows declare, where a shortfall means the query cut the history on purpose. A capped
wallet is a **prefix**, never a short-but-complete launch history, and reading it as the second
would gate a deployer on a truncated count presented as a total. **Any unreadable
row refuses the whole batch** — a row that fails to parse commonly has no readable `deployer`, so the
wallet whose history came back short is exactly the one that cannot be named. **`bonded` is
type-checked, not truth-checked**: `false` is legitimate there, so `=== true` would collapse "the
column is gone" into "this launch did not bond" and gate-fail every candidate in the batch at 0%
bonded on a run reporting itself fully measured. **A wallet the enumeration
returned no row for is refused too**: that is an absence of evidence, not evidence of absence, and
reading it as a launch history of zero would let the merge reclassify that wallet's whole ownership
listing as acquired and gate it on nothing. **A candidate whose address is not base58-shaped is never
sent** — wallets are vendor-supplied and land inside a single-quoted SQL literal — and the count of
dropped candidates is on the record so a narrowed batch is visible.
[CREATION-DERIVED.md §8.2](./CREATION-DERIVED.md) lists all nine.

### Deploying a change to the committed SQL

**Every statement in the table below is committed byte for byte, and `assertSavedQueryMatches`
compares each against the SAVED query before an execution is spent.** So editing one of those texts
in this repo is only half the change: **the saved Dune query must be updated in place to match, or
the next real run refuses the whole Dune leg terminally** — before spending anything, on every run, until they
agree. The failure is loud and costs no credits, which is the design; it is still a run with no Dune
answer for anybody.

| what changed | saved query to update, in place, **in the workspace that holds it** |
|---|---|
| `CREATION_SQL` (`dune.mjs`) | **`8204672`** — the enumeration |
| `COVERAGE_SQL` (`dune.mjs`) | **`8204603`** — the coverage probe |
| `ENTRY_SQL` (`dune-fills.mjs`) | **`8235460`** — the opening-window fill tape |
| `TRADE_COVERAGE_SQL` (`dune-fills.mjs`) | **none — `TRADE_COVERAGE_QUERY_ID` is `null`.** DEPLOY it (see below) |

The first two ids are pinned in `thresholds.json` → `dune`; `ENTRY_SQL`'s is pinned beside the text
it belongs to, as `dune-fills.mjs` → `ENTRY_QUERY_ID`. Paste the committed text verbatim — comments
included, since `normaliseSql` compares everything but line endings and trailing whitespace, and the
comments are where the traps are written down.

**A SAVED-QUERY ID IS SCOPED TO A WORKSPACE, NOT TO A LOGIN — and a key that cannot see these
queries does not fail cheaply.** The ids above are not account-independent and not portable: a
SECOND key belonging to the same person, on the same login, may list **none** of them, because it is
a different account with its own private-query slots. What that costs is availability rather than
money, and it is the same failure shape the rest of this section is about — the coverage probe 404s,
the enumeration leg then answers for **nobody**, and the run exits 2 at
[the walk-fallback spend cliff](#a-whole-leg-dune-failure-is-a-spend-cliff-and-it-is-refused-before-it-is-paid)
*after* the MadeOnSol seed allowance has already been spent. So the key a run uses and the workspace holding these queries
are one choice, not two. **Do not treat any specific id above as authoritative** — the set is being
reissued under captain decision 326a, and the standing discipline applies: re-list with
`GET /api/v1/queries?limit=100` under the key you are actually going to run with, rather than
quoting a number from prose.

*Evidence, and no test in this repo asserts it:* enumerated 2026-08-07 under both keys — the older
key lists all four production queries, the newer (paid) key lists **zero**, and that key's own
`POST /usage` reports `privateQueries 0`. An incidental HTTP 404 (`Query not found`) on
`/query/8204603` under the newer key corroborates it. The enumeration is held in firstmate's
records, outside this repo; nothing here reproduces it offline.

**The fourth row is the one that is not deployed at all, and deploying it is a captain decision.**
`TRADE_COVERAGE_SQL` is the coverage probe for the TRADE tables `ENTRY_SQL` reads — the observed
watermark captain decision 257a requires, which the enumeration's own probe cannot serve because it
bounds the CREATE tables and the two surfaces lag differently. It is committed here and held in no
saved query, so `TRADE_COVERAGE_QUERY_ID` is `null` and **`null` REFUSES rather than skipping the
probe**: the Dune fill source cannot be built without it, and pointing it at an existing id would
run a statement the saved query does not match and refuse the leg terminally *after* the probe was
billed. The step is: take one of the account's free private-query slots (re-list them first — see
the next paragraph), create a query holding this text byte for byte, and set
`TRADE_COVERAGE_QUERY_ID` to its id
in the same commit. `dune-fills.mjs` → `TRADE_COVERAGE_QUERY_ID` owns the reasoning; the run that
needs it is [the dual-source agreement mode](#one-run-two-fill-sources-and-it-agrees-with-itself-per-candidate).

**The private-query slots are NOT full, and the claim that they were is what this line used to
say.** The free tier allows 10 and this section stated the account held 10, so a new statement had
to displace an existing one. Re-listed 2026-08-05 with `GET /api/v1/queries?limit=100` — free of
credits, though not of the key — and the account held **three**: the two above and the creation
census's `8214953`. A sibling lane's retired scratch probes had been archived since the count was
last written down. `ENTRY_SQL` was therefore created as a **fourth** query rather than displacing
one. The number moves in both directions, which is exactly why `AGENTS.md` says re-list rather than
quote it; treat the figure in this paragraph the same way.

**Spend.** The vendor's plan figure is read live per key (2,500 on the Free tier), capped by the
operator at `dune.monthlyCreditCapCredits`, and a run is bound by whichever is smaller; the key is
**unshared**, a second key is a second account, and there are only 10 private queries. **A failed
execution is still billed and is terminal — `DuneClient.execute` is the one call in this repository
that is never retried.** Budget from *billed* credits, not `execution_cost_credits`, which
understates by ~3.5× because retrieving results is ~71% of the bill at ~20 credits/MB. Measured
2026-08-03: five deployers' whole histories cost **8 requests, 1 execution, 1.75 credits**; at the
195-candidate cap ~20 credits, i.e. roughly 125 full-cap runs a month. **The allowance is checked
before the leg's first request** and a run that does not fit is refused into the RPC walk — see
[The monthly credit ceiling](#the-monthly-credit-ceiling--what-it-is-and-what-it-cannot-see), which
owns the verdicts and what the guard cannot see. `--no-dune` takes
the walk instead; `--dune-refresh-probe` re-executes the probe rather than reading its free cache.

**What Dune does NOT measure:** who owns a curve *now*. So on a Dune-sourced candidate
`creation.movedCreator` is **not zero, it is unmeasured**, and `creatorMovementUnmeasured` carries
the size of it. A schema-≤8 record's `movedCreator: 0` means the walk read every curve and none had
moved; do not read the two as one series.

### The mayhem-mode flag — a reported share that reads nothing, and a per-launch exclusion that decides the gate

**Captain decision 227a.** `pump_evt_createevent` carries an `is_mayhem_mode` boolean and this repo
did not read it until now. `slot-zero-graduation-regime-remeasure` §§1.4 and 3 (held in firstmate's
records, not in this repo) measured what it is worth: **27.1% of 2026-07's pump.fun launches carried
it, they graduated at 4.1–4.7% against 1.8–2.1% for the rest, and they supplied 46.3% of that
month's graduations** — roughly two-thirds of the whole graduation-rate regime change traces to this
one flag.

It is a first-order confounder for **both** halves of this screen. A completion rate that cannot
tell the two buckets apart is measuring two things through one number. And pump.fun documents the
mode as one in which **an AI agent trades the token** and unsold supply is burned at 24 hours —
**vendor documentation, which this project has NOT verified on-chain and does not assert** — which
would put a house agent in a create slot that Stage 2's entry model assumes holds independent
snipers. That is the `SETTLED_OUTSIDERS` shape: two rows that are not two traders.

**What the lane RECORDS.** `CREATION_SQL` selects the flag as a sixth column, every candidate's
`creation` block carries `mayhemLaunches` / `mayhemFlagReadable` / `mayhemShare`, and every surface
that summarises a candidate prints the share beside the existing numbers. That share is still
227a's **observation**: no bar, gate or verdict reads it.

**What the lane now EXCLUDES — captain decision 351 (2026-08-07), which REVERSES 227b.** A
mayhem-mode graduation is not competence evidence, so a launch the flag marks is removed from
**both the numerator and the denominator** of `minCompletionRate`, and a deployer is judged on their
non-mayhem record. The evidence that changed between the two decisions is economic rather than
statistical: a mayhem graduation is preceded by a median net quote inflow of **0.291 SOL** against
**85.005 SOL** for a classic curve graduation — **292x cheaper**, and not separable in trade data
from a token that churned about $1,700 and died — while mayhem supplied **46.41%** of 2026-07's
pump.fun graduations (`slot-zero-offlaunchpad-graduation-criterion` → `report.md` §4 and §8.2, held
in firstmate's records, not in this repo). `measure.mjs` → `measureCompletion` owns the rule;
`dune.mjs` → `MAYHEM_NOT_COMPETENCE` is the one sentence that states it.

**Captain decision 227c — excluding mayhem-heavy DEPLOYERS outright — is NOT reversed and remains
declined**, and that is exactly why the denominator had to move with the numerator. A
numerator-only exclusion drives a mayhem-heavy deployer's rate towards 0.0000 and removes them from
the gate, which is 227c arriving by arithmetic. Nothing here drops, weights or refuses a deployer
for HAVING a mayhem record.

**Three consequences, and the third is the one that decides how a rate reads.**

- **The gate's four numbers are now a NON-MAYHEM reading.** `tokens`, `completed`, `completionRate`
  and `spanDays` describe the launches that survived the exclusion — three statements about one
  sample, because a rate over one set with a count over another is the defect 351 fixes. A
  schema-≤18 record's rate is the pooled, pre-351 quantity and must not be compared with a
  schema-19 one.
- **An UNREADABLE flag is kept and counted, not read as non-mayhem and not dropped.** The flag's
  readability is a property of the enumeration ROUTE — only `pump_evt_createevent` carries the
  column — so dropping unreadable launches would empty the denominator of every walk-sourced
  candidate on evidence about the surface rather than about the deployer, and a false rejection here
  is permanent and invisible. The candidate row's `competenceMayhemUnreadable` is what makes the
  choice auditable: equal to `tokens` **with `competenceMayhemExcluded` 0** means no mayhem
  evidence touched that rate at all. Both halves — a row whose excluded count is non-zero while
  every surviving launch is unreadable satisfies the second and is not that reading.
- **An all-mayhem deployer ends UNMEASURED, never at 0.0000.** Zero of zero is an absent
  measurement, and `rank.mjs` → `competenceEmptiedByMayhem` routes it to `gate-unmeasured` — not a
  rejection and not a pass — rather than to a `gate-failed` computed on a reading nobody took.

`test/deployer-screen.test.ts` → *"the flag DECIDES the competence measure and nothing else"* is
what holds all of it, including that a malformed column still changes no verdict.

## The completion measure is RAISE-85, on every venue including pump.fun

**Captain decision 352b (2026-08-09).** `completed` no longer means *pump.fun said this graduated*.
It means **RAISE-85**: *net quote inflow into a token's own primary market, over its first 24 hours,
reaching 85 SOL-equivalent*. One yardstick for every deployer, replacing pump.fun's native reading
rather than sitting beside it — the two halves of that decision cannot be separated, because
adopting a venue-agnostic criterion off-launchpad while pump.fun kept its own flag would leave
pump.fun deployers a ~46% graduation credit no off-launchpad deployer could earn.

`measure.mjs` → `RAISE_85_IS_THE_COMPLETION_MEASURE` is the one sentence, printed once per run
beside the gate's inputs.

**The bar does not move, and that is the whole safety argument.** The 85 was read off the data
rather than fitted — graduating non-mayhem tokens read 85.005 SOL at p50 *and* p99 over 157,259
launches, so the distribution has no shoulder to place a bar on. It has **zero token-level false
positives** against 108,310 non-graduating tokens, which makes a rate computed from it a **lower
bound** on the real one, which is in turn why adoption can only ever refuse a deployer and never
promote one: measured over 176,200 July-active deployers it **promoted zero** over the 0.25 bar and
demoted 1,417. At 50 SOL that property is already gone (42 promotions), so **do not lower the bar to
buy recall** — the safety argument goes with it. `measure.mjs` → `RAISE_85_SOL_BAR` owns this.

**The denomination is recorded per launch, because one of the two readings is exact and the other is
not.** A SOL-quoted market is judged in SOL against an exact constant (`raise-85-quote-sol`); a
market quoted in anything else falls back to USD (`raise-85-usd-equivalent`), where 85 SOL was worth
between **$6,236 and $7,004 across five days**, so two launches a week apart are judged at bars 12%
apart and neither reading is wrong. `measure.mjs` → `raise85FromQuoteInflow` refuses to read a SOL
figure at all unless the quote asset is **known** to be SOL: a pump.fun launch can be quoted in
something else — `maxxing` `97nnzgv9…` is USDC-quoted and all 384 of its fills return `sol_raw = 0`
**legitimately** — and a reader taking that zero at face value would score it a 0-SOL raise with
total confidence. That is captain decision 295b's guard, implemented here.

### THE SEAM WITH 351, and it is the thing not to get wrong

RAISE-85 as a *definition* only ever touches the **numerator**: it simply never registers a mayhem
graduation, which raises a median 0.291 SOL. So if mayhem **launches** stayed in the denominator
while the criterion decided the numerator, a mayhem-heavy deployer's rate would run to 0.0000 and
the gate would drop them — **which is captain decision 227c, and 227c remains DECLINED.**

The order of operations is the whole of what prevents it, and it is one order only: **the mayhem
exclusion runs FIRST, over the whole history, and the criterion is applied only to what it leaves.**
A mayhem launch is counted in `competenceMayhemExcluded` and *never* in
`competenceCriterionUnreadable`, whatever its own reading says, because it left before the criterion
could be asked. A deployer is judged on their non-mayhem record, exactly as 351 requires.

The two counts stay nameable apart on every row and are **never additive in meaning**: *not
competence evidence* (351) and *nothing could measure this* (352b) answer different questions, and
one merged "unknown" would make a post-352b rate unauditable in exactly the way a pre-351 one was.

### The third state, and how much of a rate is actually measured

- **A launch RAISE-85 cannot be READ on leaves BOTH sides and is never scored as a failure.** It
  used to be written `completed: false` where neither the curve nor the listing could answer —
  "understating the rate" — which is a coverage gap wearing a measurement's clothes, and understating
  is the permanent, invisible direction. `competenceCriterionUnreadable` counts it. A candidate whose
  whole history reads that way is **`gate-unmeasured`, never 0.0000** (`rank.mjs` →
  `competenceEmptiedByCriterion`), the same rule 351 established one exclusion over.
- **AND SO IS A CANDIDATE WITH *ANY* UNREADABLE LAUNCH, on every leg** (`rank.mjs` →
  `competenceCriterionIncomplete`). Leaving both sides of the rate also means leaving `tokens` and
  `spanDays`, and those are what `minTokens` and `minSpanDays` are compared against — so a history of
  30 launches with 6 unreadable is judged at 24 and can fail a sample-size or span bar over launches
  that left for OUR coverage reason. That would be `gate-failed`, and a graded wallet is filed in
  `feed/ledger.json` and never offered again. The check sits in `verdictFor` rather than in each
  caller, so the vendor reading, `--ownership-only`, `feed.mjs` and the bundling census all get it by
  construction. It is deliberately not a bar-by-bar repair: `tokens`, `rate` and `spanDays` are three
  statements about one sample.
- **THE CONSEQUENCE IS BLUNT, AND IT IS THE INTENDED DIRECTION.** One missing or malformed `complete`
  field anywhere in a candidate's history withholds that candidate's whole verdict. If MadeOnSol or
  pump.fun ever stopped serving `complete` on ungraduated rows, no wallet would be queued at all and
  the feed would report itself DRY rather than rejecting anybody. **What that buys is (i) no
  rejection computed on OUR OWN COVERAGE through the count and span bars, and (ii) VISIBILITY** — the
  run stops rather than quietly filing a population of ordinary rejections, the tell being **exit 9
  firing on wallets that plainly have launch records**, and `ledger.mjs` → `feedAlarm` names which
  fault it is. On this tool it also buys **(iii) a wallet a later run can still judge**, because
  `screen.mjs` is stateless between runs. **It does NOT buy re-offerability in the feed**: there an
  unmeasured wallet is graded, written into `feed/ledger.json` and never offered again, exactly like
  a `held` one — `ledger.mjs` → `markWorthARequest` owns that rule, and what the widening changes on
  that lane is the label and the alarm, not the permanence.
  `rank.mjs` → `competenceCriterionIncomplete` owns the rule.
- **`competenceCriterionEstimated` says how much of the rate is an upper bound.** Every route this
  repo has today reads RAISE-85 through pump.fun's own graduation flag, which is an **estimator**:
  every token that reached 85 SOL graduated (precision 1.0000), so a *not*-graduated launch is proof
  the bar was not reached and the estimator's negative is **exact** — while 0.82% of graduations did
  not reach it (recall 0.9918), so its positive is an **upper bound**. A rate resting on it therefore
  errs towards ACCEPTANCE, which is the direction this gate is deliberately set to fail in.
  `competenceCriterionEstimated === tokens` means the whole rate is that bound.
  `measure.mjs` → `PUMPFUN_GRADUATION_ESTIMATOR` owns it, including the one place the estimator is
  *not* an upper bound — a mayhem launch, where it is 292x wrong rather than 0.82% wrong, which is
  why it is only ever asked about launches the mayhem exclusion has already kept.

### What this does NOT establish

**Equivalent strictness across venues is not established.** The same 85-SOL bar is reached by
**0.80%** of new pump.fun tokens, **0.25%** on Meteora DBC and **46.71%** on Meteora CPAMM, and
nothing measured here separates a venue that attracts more capital per token from a venue whose
tokens are counted differently. What 352b adopts is *one bar applied identically everywhere*;
cross-venue **comparability** is not claimed by it and must not be claimed from it.
`slot-zero-cross-venue-strictness-measure` owns the question (held in firstmate's records, not in
this repo). `measure.mjs` → `CROSS_VENUE_STRICTNESS_UNESTABLISHED` is the text and a test asserts it
reaches the run record.

**And it moved no bar and no committed verdict.** `minCompletionRate` stays 0.25; the estimator's
disagreement with pump.fun's own flag is nil by construction, so Stage 0's committed-tape
regressions are byte-identical. Re-deriving the 112 all-time gate-passers, the 58 active in July and
the monthly gate populations under the adopted measure is
`slot-zero-rederive-gate-population-post-351` and is deliberately **not** done here — those figures
rest on the pre-351 pooled reading and must be re-derived rather than adjusted.

**Three things a reader has to know before quoting the share.**

- **`null` is UNMEASURED, never 0%.** All three fields are `null` on a candidate the creation **walk**
  answered, because the flag is a column on Dune's decoded create event and the walk reads
  transactions and curve accounts. Read `enumerationSource` beside it — this is
  `creatorMovementUnmeasured`'s trap running the other way.
- **The denominator is `mayhemFlagReadable`, not the launch count.** Only `pump_evt_createevent` has
  the column, so a history reaching back through `pump_call_create` holds launches with nothing to
  read. On the subject deployer that is **101 of 252 launches**: the share is `0/151`, and dividing
  by 252 would dilute it towards zero in exactly the era the flag did not exist to be set. The gap
  between `duneLaunches` and `mayhemFlagReadable` is how many.
- **A malformed flag never refuses a row**, unlike `bonded` and `launches_total`. Those are gate
  inputs, where an absent column silently shortens a history; this is an observation, where refusing
  would refuse the whole batch, send every candidate to the walk, and let a reporting field change a
  verdict — and since 351 it would also silently return the gate to its pre-351 rate. `dune.mjs`
  → `MAYHEM_NOT_COMPETENCE` is the one sentence that says so.

The sixth column's byte cost was **re-measured rather than assumed** — see
[CREATION-DERIVED.md §8.2c](./CREATION-DERIVED.md), which owns the figures and what a *seventh*
column must do before it is added.

### Two FALLBACK routes to the same reading, and which one runs

When the Dune route is absent or refuses, the gate asks the same question — *which tokens did this
wallet CREATE* — of the chain, and there are two ways to answer it. **Which one runs is decided by
whether a Helius key is present, and nothing else.**

| | keyless (`api.mainnet-beta`) | indexed (Helius, `HELIUS_API_KEY` set) |
|---|---|---|
| method | `getSignaturesForAddress` + one `getTransaction` per succeeded signature | `getTransactionsForAddress`, `full` mode, `status: succeeded` |
| cost unit | requests | **credits** (10 per 100 transactions returned) |
| subject deployer, whole history | 7,166 requests, **~287 min** | 12 requests, 793 credits, **5.7 s** |
| all twelve elite wallets | ~153 hours | 136 pages, **12,660 credits** |
| pacing | 2,500 ms (endpoint sheds ~25%) | 200 ms (zero shed measured at every rung) |
| bound that bites | `creation_walk` | `creation_walk_helius` |

Both produce a `CreationWalkResult` with the same fields and the same coverage rules, and
**`parseCreateTransaction` and `readCurveState` are shared unchanged** — `full` + `jsonParsed`
returns `getTransaction`'s own envelope, verified field for field on a known create
([CREATION-DERIVED.md § The indexed route](./CREATION-DERIVED.md)). The indexed route is faster and
reaches *further*; it is not a different measurement, and the section below still describes what
the walk means in either case.

The keyless route is not deprecated and is not a degraded mode. With no key the tool runs exactly
as it did before Helius existed — same endpoint, same pacing, same ceilings, same numbers — and it
says so in the dry run and on the gating line. The same is true one level up: with no Dune key the
tool runs exactly as it did before decision 156a, and says that too.

**The Helius worst case is not reduced by Dune being primary, and that is deliberate.** Every
candidate can fall back, so the credit reservation `screen.mjs` refuses a plan against still covers
every candidate falling back. What Dune changes is the *expected* spend, not the admissible plan.

### A WHOLE-LEG Dune failure is a spend cliff, and it is refused before it is paid

Captain decision 298a, 2026-08-06. The per-wallet fallback above is a gradient; a leg that answers
for **nobody** is not. Measured, from records committed in this repository:

| leg | candidates | Dune answered | Helius credits | RPC requests |
|---|---|---|---|---|
| `runs/2026-08-04.json` — probe execution `QUERY_STATE_FAILED` | 82 | **0** | **221,731** | 3,941 |
| `measurements/2026-08-05-seed-comparison/` untiered — row ceiling | 76 | **0** | **232,937** | 4,105 |
| same day, `--tier good` — leg kept its answer | 69 | 63 | 1,924 | 33 |
| same day, `--tier elite` — leg kept its answer | 59 | 48 | 21,733 | 243 |

`creation_walk_helius.maxCreditsPerRun` catches none of them and cannot: it is sized for the walk
being the *intended* route, so it already reserves every candidate walking and passes a run whose
plan has silently changed underneath it.

**Three things close that, and none of them distrusts the walk.** The walk is the correct answer to a
Dune refusal and is the only surface that can say who holds a curve today — what is refused is taking
a decision of that size silently.

1. **Every affected candidate carries a reason.** `dune.mjs` → `walkFallbackReasons` is the one rule:
   while the Dune leg was *asked*, a candidate the walk answered for always has a sentence, and a
   whole-leg failure's sentence starts with the marker `dune-leg-failed:` so it can be told apart
   from a per-wallet refusal. `duneFallbackReasons` stays empty in exactly two cases — Dune answered,
   or Dune was never asked (`--no-dune`, `--ownership-only`, no key). Before this, all 82 candidates
   of `runs/2026-08-04.json` read empty and a cost model built from that record described the
   degraded route while looking like the normal one, by roughly three orders of magnitude. **That
   record is evidence and is not retro-edited**, so its emptiness stays.
2. **The new worst case is priced and refused before the first walk request.**
   `dune.mjs` → `priceWalkFallbackCliff` prices the whole-batch fallback against the plan that was
   made — the same expression evaluated twice, with only the candidate count changed — in whichever
   unit *this* run's walk bills in. Past `dune.legFallbackCliffMultiple`, and on a batch no smaller
   than the magnitude floor `dune.legFallbackMinCandidates`, the run stops (exit 2) with the figure
   printed, unless `--allow-walk-fallback` says otherwise. It stops *having filed its record*: the
   refusal is an abort reason, so the run it already paid for — the seeds and the run-level `dune`
   block — is written as `completed: false` carrying that reason as its `truncationReason`, under the
   incomplete-run rules above, rather than discarded so a rerun spends the shared allowance again to
   learn the same thing. Each of those two thresholds carries its own
   derivation in `thresholds.json` → `dune.justification`, including why the guard first bites at 9
   candidates and does nothing below that; the baseline share is re-derived from the two committed
   legs above by a test rather than quoted.
3. **A failed coverage-probe *execution* no longer takes the leg down with it.** `readCoverageProbe`
   falls back to Dune's **cached** result, which costs no execution. It is a read and never a retry:
   `DuneClient.execute` is the one call in this repository that is never retried, a failed execution
   is billed either way, and `dune.maxExecutionsPerRun` is 2 — so a retry would spend the
   enumeration's own remaining execution to buy the same answer and leave nothing to enumerate with.
   On `runs/2026-08-04.json`'s shape the leg survives and costs ~20 credits instead of 221,731.
   Afterwards the record reads `dune.executions` ≥ 1 with `dune.coverage.fromCache: true`, which is
   that fallback's signature; the vendor's own sentence is announced on the run, not persisted.
   **At most one probe execution is issued per run, in whichever order the two paths are reached.**
   A failed refresh hands back a cached probe, and if that cache is *also* stale — the ordinary reason
   an operator asked for a refresh — the staleness re-execution below it does not fire, because it
   would be a retry of the statement that just failed and would spend the enumeration's own remaining
   execution. That run ends at one billed execution with coverage refused and every candidate carrying
   its own fallback reason. `enumerateCreations` records the failure from `onRefreshFailure` rather
   than from `probe.fromCache`, which cannot tell a failed refresh from an ordinary cached read.

### What the keyless route costs, measured

`getSignaturesForAddress` returns *referencing* transactions, and for a pump.fun deployer the index
is dominated by strangers' **failed** trades — the buy and sell instructions take the creator
account. Creations always succeed, so filtering `err === null` discards most of the index for free.
The **success fraction is the entire cost model, and it is not a constant**: across the twelve
wallets of `runs/2026-07-29-elite.json` it ranged from **1.7% to 99.7%**, putting a full history
between **170 requests (~7 minutes)** and **127,000 (~84 hours)**. All twelve would be ~153 hours.

Sustained throughput is **0.42 requests/second**, and **batching is actively harmful** — the same
transactions took 58s at batch=1 with *zero* load-shed events, 76s at batch=4 with 7, and 110s at
batch=8 with 11. The endpoint weights each batch entry against its limiter. This corrects
`report.md` §9.4's "batches of 5–8 sustainable"; the measurement lives in `thresholds.json` →
`creation_walk.txBatchSize`.

Because of that, the walk covers a **bounded window backwards from now**. Inside it every creation
is found; outside it the ownership listing is carried over unchanged and the record says how many
rows that is. `stopReason: "index-exhausted"` is the only value under which the window is the
wallet's whole history.

On the indexed route the window runs the other way — the walk pages **ascending**, so a truncated
one covers from the wallet's genesis forwards and leaves the *recent* end to the ownership listing.
That is the better end to lose: ownership is least wrong about tokens the wallet has not yet had
time to hand on. Everything else below is identical, including what an empty window means.

Four rules keep that window from claiming more than it covers.

- **A walk that finished no page covered NOTHING, and an empty window is not a wide one.** The floor
  only advances once a signature page has been inspected whole, so a walk stopped by the
  per-candidate request ceiling part-way through page 1 — the normal outcome for a busy deployer,
  100 requests against 1,000-entry pages — has no floor at all. The record says so with
  `coveredFromIso: null` and `coveredDays: 0`, and the merge then treats **every** listed row as
  outside the window and carries it over unchanged. The whole reading falls back to the ownership
  listing, whose launch COUNT is biased towards rejection by a measured ~0 launches
  (`CREATION-DERIVED.md`) and honest — its *rate* is biased the other way, see `FEED.md` → "It is
  biased in BOTH directions at once". The creates the walk did prove are still counted; what an empty window withdraws is only
  the right to call a listed token the walk never saw *acquired*. This encoding replaces a `0` floor
  that read as 1970: a 56-year window containing every timestamp, under which one live wallet's
  30 launches / 20 bonded / `gate-passed` became 2 / 0 / `gate-failed` with an ordinary rationale.
- **A null page is a retry, never an end of index.** `getSignaturesForAddress` returns `null` both
  when the public RPC sheds load and when the JSON-RPC envelope carries an `error` — neither means
  the wallet's index ran out. The page is retried once, and a page that still does not resolve ends
  the walk on `upstream-error` with `wholeHistory: false`. Reading one as an empty page would have
  recorded page 2 of 200 as the wallet's whole history under `index-exhausted`: a ceiling presented
  as a measurement. Only a genuinely **empty array** is an exhausted index.
  **On the indexed route the same rule holds against different shapes, re-measured rather than
  assumed** (2026-08-03). Helius distinguishes the two cases the public endpoint conflates: a bad
  parameter comes back as **HTTP 200 carrying `{"error":{"code":-32602,…}}`** — an invalid address,
  a limit above 1,000 and a corrupt pagination token all take that form — while load-shedding is an
  absent result. So an error envelope stops the walk on `upstream-error` and is *not* retried
  (asking again spends credits to be told the same thing), an absent result is retried by the
  client, and **neither is ever read as an exhausted index**. Exhaustion is proved only by
  `paginationToken: null` on a page that succeeded; an empty page that still carries a token is not
  the end, and a query over an empty slot range returns `{"data":[],"paginationToken":null}`
  correctly. A wrong or missing key is **HTTP 401 with a plain-text body**, which is a credential
  failure rather than a measurement and stops immediately without retrying.
- **"Inside the window the walk is authoritative" holds only when `unresolvedTransactions` is 0.**
  A `getTransaction` that never came back may have been a create, so under a non-zero count an
  in-window listing row the walk did not see is **carried over as a launch** rather than relabelled
  acquired and dropped — dropping it would delete a real launch, and its bonded flag, from both
  sides of the gate's fraction. `creation.windowExact` says which case a row is,
  `listedInWindowCarried` says how many rows it moved.
- **An unread bonding curve is not a failed launch.** Bonded status resolves in a stated order and
  the record counts which source answered: `bondedFromCurve` (the on-chain `complete` byte,
  authoritative), then `bondedFromListing` (the ownership listing's own `complete` flag — the same
  field a vendor mirror of agreed with our tape 67/67), then `bondedUndecidable`. The three sum to
  the launch count. A launch **hidden from the ownership listing has no row by definition**, so a
  failed curve read on exactly the launch this route exists to find is undecidable rather than
  quietly scored as a failure. **Since captain decision 352b the provenance follows the ANSWER
  rather than the source**: a listing row whose own `complete` flag is missing or malformed decided
  nothing, so it counts as `bondedUndecidable` and not as `bondedFromListing`, and the launch leaves
  both sides of the rate as `competenceCriterionUnreadable` — see *"The completion measure is
  RAISE-85"* above, which owns the third state.

**Any undecidable launch makes the whole reading unmeasured**, and so does an ownership listing that
could not be read at all. The verdict is then `gate-unmeasured` — a third value in the gate's
vocabulary, printed under its own `GATE UNMEASURED — THIS IS NOT A NEGATIVE RESULT` heading and
never folded in with the rejections. A `gate-failed` carrying an ordinary rationale over a history
that was never actually measured is precisely the invisible false rejection this whole reading
exists to remove, so the state lives in the verdict and not only in the wording beside it.

### What it turned out to be worth

**A measured zero, on every wallet that could be checked.** Five wallets have both readings: four
show a gap of exactly zero launches, one — our subject deployer, where the answer is exact and
complete — shows one launch in 239. No verdict changed. The reason is that creator records move
*often* but almost always into a fee-sharing config pump.fun still attributes to the wallet; only a
genuine handover removes the token, and that is rare. Numbers, distribution and per-wallet costs
are in [CREATION-DERIVED.md](./CREATION-DERIVED.md).

The correction is kept because it turns an unbounded unknown into a bounded, recorded one — not
because it moved a rate. The day it stops being zero, the run record will show it.

### Reading the record

Every candidate row carries both readings and the verdict each produced: `tokens`/`completionRate`
(what the gate read), `vendorTokens`/`vendorCompletionRate`/`vendorVerdict` (the old
ownership-derived reading, kept whole), `verdictChanged`, and `creation` with the walk's coverage,
bounds and per-direction counts. Findings from the first measurement are in
[CREATION-DERIVED.md](./CREATION-DERIVED.md).

`verdictChanged` compares two **results**, so it is false whenever `verdict` is `gate-unmeasured`:
the absence of an answer is not a different answer, and counting it as one would corrupt the very
gap figure the row exists to keep honest. The state is in `verdict`.

One field is easy to misread. `creation.movedCreator` counts launches whose **on-chain** curve
creator is no longer the wallet. That is **not** the same as being absent from the ownership
listing: a fee-sharing migration moves the on-chain field to a config PDA while pump.fun still
lists the token under the wallet. `hiddenByOwnership` is the count that matters for the bias, and
it is measured directly rather than inferred from `movedCreator`.

## The credentials

Three, and they are unrelated to each other. All are read from the environment. **Nothing in this
repository holds a key and nothing here ever will**; no value is printed, logged or written to
disk, presence is verified by length and shape only, and `credential.mjs` is the only module
permitted to name any of the three variables — a test enforces that, the allow-list is exhaustive
and is asserted for ownership as well as exclusion, a committed file carrying a MadeOnSol or Helius
key's shape fails the build, and a committed file that assigns a value to a credential variable or
hard-codes the auth header fails it too. That second scan is what covers the Dune key, whose 32
alphanumeric characters are structurally a Solana address and so cannot be shape-scanned without
firing on every mint in the tree.

```bash
export MADEONSOL_API_KEY="$(your-secret-manager read madeonsol)"
export HELIUS_API_KEY="$(your-secret-manager read helius)"
export DUNE_API_KEY="$(your-secret-manager read dune)"
# or, from a dotenv file kept OUTSIDE this repo:
set -a; . /path/to/your/.env; set +a
```

### `MADEONSOL_API_KEY` — required

**As of 2026-08-05 this key is ULTRA and EXCLUSIVE to slot-zero — 100,000 requests/day, resetting
at 00:00Z, read off `x-ratelimit-limit` rather than off a pricing page.** Captain decision **267a**
re-derived every bound that used to be sized against the old Free tier of ~200/day shared; the
[Bounds](#bounds) table below carries the results and each `thresholds.json` → `budget`
justification names the constraint that now fixes its value.

**The 30-day Free-tier key expiry is UNVERIFIED on Ultra and is neither assumed nor deleted.** It is
stated as unverified wherever it is stated at all, including in the `401` message itself, which now
puts the cheap check (re-export) ahead of the expensive one (reissue). Either way a rejected key
exits `4` with a message saying so, rather than producing an empty ranking. Get one at
<https://madeonsol.com/developer>.

**This credential is on Ultra by captain decision (2026-08-05) and is this research lane's alone.**
The standing policy of refusing paid tiers still governs every *other* credential this tool reads —
none of them may need a paid plan — but it no longer describes this one. A `403` here is still
treated as a bug to report, not as a prompt to upgrade: no endpoint this tool calls needs a paid
tier, so a 403 means the key was downgraded or the vendor gated something that was free.

**One endpoint changed status and the reason it is skipped changed with it.**
`/deployer-hunter/{wallet}/history` was PRO+ and unreachable; the Ultra key answers it `200`
(measured 2026-08-05). It is still **not requested**, now for a design reason rather than an
entitlement one: it returns daily snapshots of `bonding_rate` / `total_deployed` /
`recent_bond_rate`, the trailing-window aggregates this tool refuses to read at any single instant.

### `HELIUS_API_KEY` — optional, and its absence is a supported configuration

It selects the indexed creation walk. With it unset the tool runs the keyless route and is slower
rather than different; there is no exit code for its absence, because absence is not a fault. A key
that is present but **malformed** falls back to the keyless endpoint and says why — running
silently would leave a slow run and a `provider: "public"` record with no reason in it.

The address is composed in code as the host plus the key in a query parameter, in exactly one place.
**Store the bare key, never the composed URL** — a URL in an environment variable is a credential
that leaks the moment anything formats it into a message. A value that looks like one (it contains
`://` or a query parameter) is **refused on shape**, because the length band structurally cannot
catch it: this host plus a UUID key is 76 characters, comfortably inside 24-128. It falls back to
the keyless endpoint and says why, naming the shape and never the value.

**A credential the endpoint refuses is TERMINAL for the run, and exits `4`.** It says nothing about
the deployer being screened, so it may not become that deployer's reading. Absorbed into one
candidate's `stopReason`, a revoked key would give every candidate after it a silent ownership-only
history while the record still claimed `historySource: "creation-derived"`, and the whole
MadeOnSol daily allowance would drain one paid-for profile at a time. Stopping on the first one
leaves the rest of that allowance unspent; the partial-record rules above apply unchanged.

**Plan: Developer — $49/month, 10,000,000 credits, 50 requests/second** (their pricing page, read
2026-08-03). `getTransactionsForAddress` in `full` mode bills **10 credits per 100 transactions
returned**, rounded up, 10 minimum; `getSignaturesForAddress`, `getTransaction`, `getBlock` and
`getMultipleAccounts` are 1 credit each. The key is **unshared** — it belongs to this research lane
alone (captain, 2026-08-03), so the whole allowance is this tool's and no other consumer can be
starved by a heavy run. Credits, not wall clock, are therefore what bounds this leg; see
[Bounds](#bounds) and `thresholds.json` → `creation_walk_helius`.

**Nothing here tracks the month.** The tool holds no state between runs, so it can bound one run
and no more. `--dry-run` prints that run's worst case and its share of a month; the monthly
arithmetic is the operator's.

### `DUNE_API_KEY` — optional, and it selects the PRIMARY creation-enumeration surface

With it set, "which mints did this wallet create" is answered by Dune; with it unset the tool runs
exactly as it did before decision 156a and every number is what it was. A key that is present but
**malformed** — a pasted URL, or a length outside 16–128 — is refused on shape, falls back to the
walk and says why, naming the shape and never the value. There is no exit code for its absence.

The key is stored bare and sent as the `X-Dune-API-Key` **header**, never `Bearer` and never a query
parameter, so no URL this client builds can carry a credential. Free tier, and the allowance is
**shared**: what a run may spend, and what it refuses rather than publish, is
[The PRIMARY surface](#the-primary-surface-dunes-decoded-creation-events) and [Bounds](#bounds).

## Why we never inherit their aggregate

Every completion figure MadeOnSol publishes is unusable, and this is measured rather than assumed.
Against our own ground truth for `7ufmve7Z…` — **239 launches, 103 bonded, 0.4310**, from the
committed population tape:

| surface | reading | vs ground truth |
|---|---|---|
| `deployer.bonding_rate` @ 15:00Z | 22 deployed / 15 bonded / **0.6818** | **+58.2%** relative |
| `deployer.bonding_rate` @ 17:00Z | 20 deployed / 13 bonded / **0.6500** | **+50.8%** relative |
| our tape | 239 / 103 / **0.4310** | — |

The window **slid and shrank** between those two readings while the deployer launched again. A count
window would have grown. It is a trailing **~7.5-day** window whose own alert text says "lifetime".

**And the endpoint that looks like the right raw material is worse.**
`GET /deployer-hunter/{wallet}/tokens` is **bonded-only**: of 100 records fetched for our subject,
98 are in our graduated set and **zero** are among the 136 launches our tape records as failures.
Its `total` reads 101 against our 103 bonded, and `only_bonded=true` returns the identical total, so
the flag is a no-op. `bonded / total` from that endpoint is **1.0000 for every deployer alive**. It
has no denominator, and the gate never touches it.

The one surface of theirs that carries both outcomes is `profile.pump_tokens`, verified at **67/67
exact agreement** with our tape on the completion flag, with zero of our in-window launches missing.
That, and only that, is what the rate is computed from **on the vendor reading** — the leg
`--ownership-only` runs and `feed.mjs` grade on. It is not `screen.mjs`'s default, which gates on
the creation-derived merged history ([Which history the gate
counts](#which-history-the-gate-counts)); `thresholds.json` → `stage1_gate.justification.minCompletionRate`
owns which reading each bar is measured on.

Two further sharp edges, both measured 2026-07-29:

- `/{wallet}/tokens?limit=100` returns **HTTP 400**. The OpenAPI document says `max=100`; the server
  rejects anything above **50**.
- The live `swap-api` fill rows and the stored tape rows **do not share field names**, and the live
  rows carry no `slot` field at all — only `slotIndexId`, whose first 12 digits are the slot. See
  `pumpfun.mjs` → `parseFillLoose`.

## The seed is theirs; the measurement is ours

A deployer MadeOnSol does not rank cannot be **enumerated** by this tool at all. That is a real
limitation of the enumeration, and since captain decision 398a it is a limitation of the enumeration
alone: such a deployer can still be MEASURED by handing the screen its address with `--wallets` —
see "The vendor gatekeeps ENUMERATION, not measurement" below. The enumeration is shaped around what
their endpoints actually return:

- `sort=bonding_rate` DESC is a wall of wallets with **1 deploy, 1 bond, rate 1.0** — their `rising`
  tier by definition — and the ones we sampled last deployed in **May 2024**. This sort is never
  used.
- `sort=total_bonded` DESC is industrial spam: **8,518 deployed / 127 bonded = 0.0149**, then
  2,660/100, then 4,324/89. All graded `cold`.

So enumeration runs over `recent-bonds` (best seed — a deployer there is bonding curves *now*),
`alerts`, and `leaderboard?sort=total_bonded`.

### The seeding is TIERED by default — captain decision 262a

**Since 2026-08-05 a default run issues each of those three endpoints once per tier for `good` and
`elite`** — six enumeration requests, not three (`seed.mjs` → `DEFAULT_TIERS`). It was untiered.
The evidence is `runs/2026-08-05-seed-comparison.md`, which ran both seedings the same day, on the
same code, at an unmoved `minCompletionRate` of 0.25:

| | untiered | tiered (`good` + `elite`) |
|---|---|---|
| candidates gated | 76 | 69 + 59, pools **disjoint** that day |
| **admitted** | **2** | **27** (14 + 13) |
| admitted-set relation | a strict **subset** of the tiered one | ⊇ untiered, plus 25 more |
| median (vendor page − gate reading) | 0.0000 | 0.0000 |

So untiered **forfeited 25 candidates and gained none** — a dominance relation rather than a
trade-off, which is why this is a default and not a flag.

**It is NOT rate flattery, and reading it that way gets the mechanism wrong.** Tiering does not
admit more wallets by inflating the number the bar reads: the page-minus-gate median is `0.0000` on
all three pools and all three admitted sets, because the two readings are *identical* below the
70-record page cap and diverge in both directions above it. What tiering changes is **selection** —
**27 of 27** tiered admissions were reachable through `leaderboard:total_bonded` against **0 of 2**
untiered ones, which came through `alerts`. That imports the vendor's own ranking into the pool, and
**nothing measures whether vendor rank predicts `roomLeft`**. That correlation is the obvious next
question and has not been run.

**What the default forfeits, stated because no count in a run will show it.** `tier` is another
trailing window, like `bonding_rate`: membership is unstable and the tiers are not disjoint, so a
deployer worth screening but graded `moderate` today is invisible to a default run. It is reachable
with `--tier moderate`. **The untiered seeding itself is no longer reachable from the CLI** — it
takes `tiers: null` passed to `buildSeedPlan`, which no flag does — so the untiered pool of
2026-08-05 is reproducible from the committed records under
`measurements/2026-08-05-seed-comparison/` and not from a flag.

`--tier <t>` still overrides the pair with a single tier, and it is how you reach a population the
default does not cover.

> **Superseded observation, no committed artefact.** An untiered run was seen to surface active spam
> deployers launching 70 tokens in under four days at 1–7% completion, all of which the gate
> rejected. That reading came from `runs/2026-07-29-stage1.json`, whose record was **deleted** — its
> figures were produced by the inert seeds described below, and re-running untiered to re-evidence a
> side observation is exactly what the *"if it gets results"* conditional in [Bounds](#bounds) does
> not license — the allowance is now spendable in full, but not on this. So this paragraph is a
> recollection, not evidence: nothing committed backs it, and it should not be cited as though
> something did.

**The elite-tier recent-bond feed is `recent-bonds?tier=elite` — a tier filter on the shared feed,
not a distinct endpoint.** Their OpenAPI v1.17.0 exposes no separate elite path; `tier` is a query
parameter with enum `elite|good|moderate|rising|cold`, and `--tier elite` threads it through every
seed. The committed runs under `runs/` exercise it — `2026-07-29-elite.json` on `elite`,
`2026-08-02-good.json` on `good` — and each records its own wallet count.

**The tiers are not disjoint and membership is not stable**, so `--tier` selects a population, it
does not partition one: a wallet seen under `elite` can come back under `good` days later with its
own numbers unchanged. `runs/2026-08-02-good-vs-elite.md` → *"Two findings about the vendor's tiers"*
owns that measurement. Nothing here may treat "outside elite" as a property of a wallet.

### Two of the three seeds used to yield nothing, silently

Measured and fixed. `recent-bonds` and `alerts` nest their deployer block under **`deployers`** —
plural — and `recent-bonds` wraps its rows in `tokens`, not `bonds`. The reader looked only for the
singular `deployer`, so both seeds extracted **zero wallets** while still costing a keyed request
each. Nothing surfaced it: the run printed one merged total, and the record carried no per-query
figure. Both runs committed at the time were therefore leaderboard-only pools — indistinguishable,
from their output, from properly seeded ones.

Two changes, because the shape bug alone would have left the class of defect in place:

- `extractWallets` accepts either nesting (`seed.mjs` → `BLOCK_KEYS`).
- **Every seed now reports its row count *and* its wallet count**, printed and persisted under
  `coverage.seeds` in the run record, with zero-yield seeds named in `coverage.inertSeeds`. Rows
  present and wallets zero is the fingerprint of *our reader* being wrong rather than the vendor being
  empty, and the two are now distinguishable at a glance. **`walletsReturned` is a per-row count —
  rows we could read a wallet out of — never a distinct-deployer count**, and it is not a yield:
  `recent-bonds:good` read `50 rows / 50 wallets` and contributed 19 distinct deployers. Distinct
  per-seed yield has to be recomputed from `candidates[].seededBy`, which only gated wallets carry
  (prefiltered entries record a reason and no provenance).

The run record also carries the full coverage chain — wallets seeded, prefiltered out, worth a
request, **dropped by the candidate cap**, gated — and sets `truncated` when the cap dropped anyone.
Run records are the grading lane's input, so a capped run must not read as a screen of
everything enumeration found.

The superseded untiered run record (`runs/2026-07-29-stage1.json`) was **deleted rather than
re-run**: its numbers came from the inert seeds, and re-running that configuration would only
re-evidence a side observation, which the *"if it gets results"* conditional in [Bounds](#bounds)
does not license however much allowance is left.

### The first committed run, with all three seeds working

`runs/2026-07-29-elite.json`, one `--tier elite --candidates 12 --max-requests 20 --consistency`
invocation, 15 keyed and 11 keyless requests. These figures **replace** the earlier leaderboard-only
elite result:

| | before (inert seeds) | after |
|---|---|---|
| wallets from `recent-bonds:elite` | 0 | 12 |
| wallets from `alerts:elite` | 0 | 50 |
| wallets from `leaderboard:total_bonded:elite` | 12 | 12 |
| distinct wallets seeded | 12 | **22** |
| gate passed / gated | 8 of 12 | **5 of 12** |

Fewer survivors, from a pool nearly twice as large and drawn from three orderings instead of one. The
seven rejections are six samples under 25 tokens and one 3-day burst. Ten of the 22 seeded wallets
were dropped by the candidate cap and never measured, which is why the record is flagged `truncated`.
**That truncation was a bug in the invocation, not a judgement**: the run asked for 12 while the
pinned ceiling already allowed 20. The candidate cap now defaults to whatever the request ceiling
leaves, so an unstated `--candidates` grades everything enumeration surfaces and a conservative
invocation cannot silently discard wallets again.
Our own subject deployer `7ufmve7Z…` was surfaced by all three seeds and passed at 38/70 over 35
days — the wallet Stage 0 exists to show this gate passing.

`prefilterReason` in `seed.mjs` is the **only** place a vendor aggregate is read, and it can only
ever cause the tool to *skip a request*. It never reaches a rate, a verdict, or an output number.
Its bias is stated there: because their counters are a trailing window, a floor on them is a
cadence filter, so it is set low.

`mergeSeeds`'s comparator deliberately does **not** consult `vendorDeployed`. The sorted list is
truncated by the candidate cap, so anything the comparator reads decides which wallets get gated and
therefore which appear in the output at all — an aggregate there would be an aggregate reaching an
output. Ordering is provenance count, then first-seen rank, then address, and a test asserts that two
wallets identical but for `vendorDeployed` order by address.

### The second committed run, on `--tier good`

`runs/2026-08-02-good.json` (schema 3, `completed: true`), the first run to grade its whole seeded
pool — 72 seeded, 7 prefiltered, **65 gated, 0 dropped by the candidate cap** — and the first with a
Stage 2 entry score in it. Read it through `runs/2026-08-02-good-vs-elite.md`, which owns the
comparison against the elite baseline, the spend accounting, and the reasons the two gate hit rates
are **not** like-for-like. Do not re-derive those figures here.

### The third committed run — the full-day default, and it returned no entry verdict

`runs/2026-08-04.json` (schema 12, `completed: true`), the first run at the pinned defaults with no
tier filter and no candidate cap: **128 seeded, 46 prefiltered, 82 gated, 0 dropped by the candidate
cap**. It is also the first run under captain decisions 190a and 198b.

**Stage 2 scored 3 of the 4 gate survivors and returned `entry-unmeasured` on all three**, so it
answers nothing about whether any window is enterable after costs — which is a legitimate outcome
and is recorded as one. **18 of the 22 windows that walked cleanly were refused as unproven**,
against 8 walk drops; the 198b near-bar guard fired **zero** times, every refusal coming from the
sample-size floor upstream of it. Read it through `runs/2026-08-04-full-day-default.md`, which owns
the refusal-cause split, the spend, the two plumbing failures (a billed Dune probe execution that
failed over to the walk, and six mint-time drops against MadeOnSol's creation timestamps) and what
the refusal rate does and does not imply for tightening the unproven-window padding. Do not
re-derive those figures here.

### The 2026-08-05 seeding comparison — three legs, and records that are not under `runs/`

Captain decision 232c ran the screen on the untiered default seeds and on `--tier good`/`--tier
elite` the same day, at unmoved bars, to compare the two seedings; **choosing one is the captain's
and was not done there.** Read it through `runs/2026-08-05-seed-comparison.md`, which owns every
figure, the spend and the decisions it leaves open. Do not re-derive them here.

Its three records are held at `measurements/2026-08-05-seed-comparison/` rather than under `runs/`,
because **no schema version describes them** — schema-15 candidate rows plus a run-level block that
only exists at 17. That directory's own `README.md` owns the statement and is the one place it is
made; `runs/` stays exactly the set of records the per-version key assertions below hold.

### The vendor gatekeeps ENUMERATION, not measurement — `--wallets`, captain decision 398a

**`node tools/deployer-screen/screen.mjs --wallets <file>` gates the addresses in a file instead of
enumerating candidates from MadeOnSol.** One address per line, `#` starts a comment, blank lines are
skipped.

**Why it exists.** Supply, not measuring capacity, is what binds the captain's floor of 1,000
distinct usable windows a month: the reachable population yields ~309 a month against a capacity of
~1,160, and **37 of the 58 pump.fun deployers that passed this gate in 2026-07 — 64% of them — are
invisible to every discovery source this repo has**, worth 1,442 distinct windows a month between
them. Worth of this change: **309 → 590** distinct usable windows a month.

**The finding it rests on, measured 2026-08-09.** `/deployer-hunter/{wallet}` returned a full
70-record `pump_tokens` profile for two wallets the vendor's own hunter feeds have never surfaced,
identical in shape to a known tier wallet's — so Stage 2 already has everything it needs for such a
wallet the moment Stage 1 has paid for its profile, and what was missing was only a way to hand the
screen a list. **n=2 plus one control: an observation, not a rate**, and it is the observation the
whole input rests on. `slot-zero-discovery-beyond-madeonsol` → `report.md` §5.1 owns it, held in
firstmate's records, not in this repo.

**A SUPPLIED LIST IS A SEED, NEVER A SUBSTITUTE FOR THE GATE.** 398a chose the UNRESTRICTED input
over an offered variant that would have accepted only addresses this project's own enumeration
produced, which makes this a hard requirement of the implementation rather than a principle. It is
enforced by the control flow: a listed address becomes an ordinary `SeedCandidate` and enters the
ONE gate loop, so there is no second path and no bar it can skip, and
`test/deployer-screen.test.ts` → "a LISTED wallet still has to pass the gate — 398a" drives a wallet
that fails the bars end to end and asserts `gate-failed` **and** `entry: null`. The concrete reason
rather than the general one: the creation census measured its own bonding reading and this screen's
creation-derived merged history agreeing on 488 of 490 wallets, but **not robustly on the
high-volume wallets the gate actually admits** — precisely the population a supplied list adds.
`wallet-list.mjs` → `WALLET_LIST_IS_A_SEED` is the sentence; the run prints it and the record
carries it verbatim.

**Why a FILE and not a repeatable flag.** The lists this exists for are produced by other lanes as
files — a census export, a queue — and are dozens to hundreds of addresses long, which no repeatable
flag survives; and one input shape means one validation path, one provenance label and one term in
the plan arithmetic. A one-off spot check is `--wallets` over a one-line file.

**Every failure is loud.** A malformed entry, two tokens on a line, a duplicate or an empty list
REFUSES the run (exit 2) naming every bad line at once, and **nothing partial is used**. The file is
read before Stage 0, so a bad list costs not even the local CSV work. A silently dropped address is
a deployer that was never measured and never reported as unmeasured — the invisible false rejection
this tool exists to remove, arriving one stage before the gate and invisible to the operator who
typed the list.

**Refused beside two flags, and neither is a preference this could resolve.** `--tier` narrows an
enumeration that does not happen; `--candidates` is a CAP, and capping a supplied list is dropping
addresses off the end of it. A list too long for the pinned ceilings refuses with the arithmetic
stated, and the remedy is a shorter file — visible in a way a truncated run is not.

**The plan arithmetic.** A listed run issues **no enumeration request**: the list IS the
enumeration. So the keyed worst case is `0 + <addresses>` rather than `6 + <candidate cap>`, and the
candidate cap is the list's own length. At the 58 wallets 398a is sized for that is **58 of
100,000 MadeOnSol requests a day, 0.058%**. `budget.maxCandidates` still binds — it is the largest
the pinned KEYLESS ceiling admits, so it binds a listed run exactly as it binds a seeded one.

**What does NOT move.** Zero Dune executions and zero Helius credits that a seeded run would not
spend — the enumeration and the walk are byte-identical, and where an address came from reaches
neither. Keyless traffic per candidate is unchanged (the ownership listing's
`LISTING_PAGES_FOR_MERGE` pages), and its run-level worst case is the same
`maxCandidates × pages` bounded by the same pinned `budget.maxKeylessRequests`. **Stage 2's keyless
swap-api ceiling cannot move at all**: it is `maxCandidatesScored × maxLaunchesPerCandidate ×
maxRequestsPerLaunch` and none of those three is a function of how many candidates a run gates or of
where their addresses came from. That matters because the keyless hosts have no purchased quota and
their tolerance is unmeasured.

**What the record says.** Every candidate row carries `candidateSource` (`"vendor-seed"` or
`"wallet-list"`) and a listed one's `seededBy` is `["wallet-list:<file>"]`; the run-level
`walletList` block names the file, its SHA-256, the counts and `seedsIssued: 0`. Record schema 22 —
see the schema table below for what a reader of an older record may and may not assume.

**Not built here, deliberately.** The flow-weighted scoring allocation (captain decision 399a,
`slot-zero-rotation-tempo-weighted-slots`) is its own lane and blocked on this one — `rotation.mjs`'s
comparator is untouched. The recurring chain-wide enumeration that would PRODUCE these lists (350a)
is its own lane. And nothing here tries to establish who anyone is: captain decision 370a closed
that question permanently.

## Retention — MadeOnSol terms §5a(d)

> *(d) you may not cache, store, or accumulate API Data beyond what is reasonably necessary to
> operate your application, or in any manner that reconstructs a substantial part of the MadeOnSol
> database.*

**Derive and discard, implemented rather than promised.**

- Per-token records are held **in memory only**, for the duration of one run, and dropped when the
  process exits. There is no cache, no database, and no backfill.
- No **vendor-derived** record is written to disk unless `--out` is passed; persisting the run
  record is opt-in. The one file a run writes without it is the Stage 2 rotation state,
  `rotation/stage2-scored.json`, and only when the run actually scored a wallet — see "WHICH
  survivors the cap is spent on". It holds no vendor data: a wallet address, which is public
  on-chain data, the instants this tool scored it, and how many times.
- What a run record contains, per wallet — **twenty-three fields at schema 4 and at schema 5, all
  of them ours** (schema 5 adds no candidate field; its three new fields live inside `entry`):
  the thirteen of schema 1 (`wallet`, `seededBy`, `tokens`, `completed`, `completionRate`,
  `spanDays`, `windowFirstDeploy`, `windowLastDeploy`, `vendorPageCapped`, `verdict`, `rationale`,
  `gateReasons`, `consistency`), plus `entry` from schema 3, plus `historySource`,
  `gateReadingPageCapped`, `vendorTokens`, `vendorCompleted`, `vendorCompletionRate`,
  `vendorSpanDays`, `vendorVerdict`, `verdictChanged` and `creation`. The exact key set **per schema
  version** is asserted by `test/deployer-screen.test.ts` → *"a committed run record persists
  derived fields only"*, against the committed records themselves, and a second assertion checks the
  projection this build writes matches the schema it declares — so this ToS-facing claim cannot
  drift from the code, and a committed record is never retro-edited to fit a newer schema. The
  schema-1 record legitimately predates `entry` and the creation fields; the claim being made is
  that nothing *outside* each schema's set is ever written.
- `creation` is counts and bounds only. The creation walk reads **mints** — it must, to reconcile
  the two histories by identity rather than by counting — and they are held in memory for one run
  and never written. They are also not vendor data: they come from the create transaction and from
  pump.fun's own keyless endpoint, not from MadeOnSol.
- What it does **not** contain: any mint, token name, symbol, market cap, bond timestamp,
  time-to-bond, or per-token row of any kind. Roughly 70 vendor records per wallet are read, reduced
  to one row of derived counts, and discarded. Verified on the committed run records — none of
  `mint`, `token_mint`, `token_name`, `symbol`, `peak_market_cap`, `bonded_at`, `ath_market_cap` or
  `pool_address` appears anywhere in a candidate row.
- **Stage 2 holds a mint list in memory and writes none of it.** It needs mints to seek the keyless
  fill tape at all, and they come from the profile Stage 1 already fetched — `toLaunchRefs` in
  `measure.mjs`. What survives is `entry`: quantiles, counts, a hit rate and a verdict, computed by
  us from pump.fun's public fills. **Counterparty wallet addresses are also dropped**, because the
  field is reported as a distribution and a list of who was in it would be an accumulation with no
  question attached to it.
- The wallet address is public on-chain data, not vendor data. The counts and the rate are our own
  computation from records we did not keep. Nothing persisted can reconstruct any part of their
  database.

**The same posture covers Dune**, whose own terms were read before the first committed run and
neither address caching nor derived data — its per-launch rows live in memory for one run, and the
record keeps the coverage *bound* rather than the vendor's monthly counts.
[CREATION-DERIVED.md §8.7](./CREATION-DERIVED.md) owns that reading.

**§5a(b)** — internal research only. No publishing, no outbound feed, no shared surface, no
third-party display. The output is a text report and an optional local JSON file.

**THAT SENTENCE USED TO END "in a private research repo", AND THE REPOSITORY IS NOW PUBLIC**
(captain decision 377a), so the clause is struck rather than left asserting something untrue. What
the argument above actually rests on is unchanged and is the paragraph before this one: **no vendor
per-token record is ever written** — they live in memory for one run, and what a committed record
holds is our own counts, quantiles, rate and verdict, with counterparty addresses dropped. That is
what makes the persisted output not an accumulation and not a re-display of their data, whoever can
read it. **What the repository's visibility does change is the audience for the derived output, and
whether §5a(b) is satisfied on those terms is the captain's reading and not this file's** — it is
recorded here as an open question, not answered. Nothing in this lane's behaviour moved for it.

Test fixtures are **synthetic**, hand-written to the observed shape and never captured payloads:
committing real per-token records would be the accumulation (d) prohibits, in a git history that
cannot be un-published.

## The run-record schema, and the completeness contract

**Read this before consuming a record.** It is a contract, not advice: the prediction-grading lane
reads these files, and the naive read of one of them is wrong.

Records carry `schemaVersion`. **A record with no `schemaVersion` is version 1.**

| version | what it carries |
|---|---|
| 1 (absent) | no `completed`. `truncated`, `truncationReason` — and `coverage`, which was already present here. |
| 2 | adds `completed`, and only `completed`. |
| 3 | `spend` (the keyed ceiling, the unspent remainder, the planned worst case, and every endpoint called with its per-call cost) and `unmeasured` (every measurement the run could not take, and why). |
| 4 | the creation-derived launch history beside the ownership one: `creation`, `historySource`, `gateReadingPageCapped`, `vendorTokens`, `vendorCompleted`, `vendorCompletionRate`, `vendorSpanDays`, `vendorVerdict`, `verdictChanged`. |
| 5 | no new candidate field — the candidate-row change is **inside `entry`**, which gains `launchesRoomUnproven`, `bundledTx` and `maxWalletsInOneTx`. The **`stage0` block also changed**, and it is not comparable across the boundary — below. Consequences for a reader of an older record, below. |
| 6 | no new candidate field either. **The fee moved inside the entry window** and the eligibility filter became observable, both inside `entry`. **The verdict vocabulary changed and `entry-room-present` no longer exists** — below. `entry` gains `entryCostSol`, `entryCostPerSolStaked` (pooled over ENTRIES), `entryCostPerSolStakedByLaunch` (one figure per LAUNCH, and the one `entry-cost-prohibitive` is compared against), `entryTxFeeSol`, `entryCostPriced`, `fieldRealisedSolNetOfMeasuredFees`, `fieldReturnPerSolNetOfMeasuredFees`, `fieldHitRateNetOfMeasuredFees` and `fieldClosedRoundTripsPriced`; `entry.coverage` gains `minAgeMs`, `launchesTooYoung`, `launchesEligible`, `launchesPlanned`, `launchesDroppedByCap`, `youngestRefAgeMs`, `youngestEligibleAgeMs` and a `cost` block whose `launchesPriced`/`transactionsPriced` count only pricing that BACKS the score, with `launchesDiscarded`/`transactionsDiscarded` beside them for work paid for and then dropped whole and `rpcRequests` spanning both. The **`stage0` block gains `onChainCostReproduction`** — Stage 0's offline cost regression, carried in full (`launchesPriced`, `entriesPriced`, `pairsPriced`, the gross and net medians and hit rates, `flipsPositiveToNegative`, the known-negative wallet's `postBreakVerdict`, `ok`) so a saved run says by how much and over what the fee correction moved the field, not only that it passed — and `thresholds` gains `stage2_cost`, the bounds the cost leg ran under. Those figures are over the **unfiltered** population — every taped launch the committed table can price — which schema 7 changes without renaming a single key. |
| 7 | no new candidate field, no new `entry` field and no new `entry.coverage` field: `PERSISTED_BY_SCHEMA[7]`, `ENTRY_KEYS_BY_SCHEMA[7]` and `ENTRY_COVERAGE_KEYS_BY_SCHEMA[7]` all equal `[6]`. **What changed is a POPULATION, under unchanged key names.** `stage0.onChainCostReproduction`'s `launchesPriced`, `entriesPriced`, `entries`, `pairsPriced`, the entry-cost medians, `entryCostPositiveShare`, the gross/net hit rates and medians and `flipsPositiveToNegative` are now measured over the **GATED** population — launches whose create-slot opening is proven (`measure.mjs` → `roomIsProven`), which is the population `entry-cost-prohibitive` is itself computed from — where a schema-6 record's identically named keys meant the unfiltered one. So a schema-6 `launchesPriced: 113 / pairsPriced: 631` and a schema-7 `110 / 618` are not one series; version-detect before comparing them. Three new keys carry the unfiltered reading so the record is self-describing rather than needing external context: `includingUnprovenLaunchesPriced`, `includingUnprovenPairsPriced` and `includingUnprovenEntryCostPerSolStakedMedianByLaunch` (on the committed tape 113, 631 and 0.0388 against the gated 110, 618 and 0.0389 — the unfiltered reading is the CHEAPER one, i.e. the optimistic direction, which is why it is not what the bar reads). The block also gains `minEntryCostPositiveShare`, the floor `entryCostPositiveShare` is compared against, beside the `minLaunches`/`minPairs` bars already there. |
| 8 | no new candidate field, no new `entry` field and no new `entry.coverage` field: `PERSISTED_BY_SCHEMA[8]`, `ENTRY_KEYS_BY_SCHEMA[8]` and `ENTRY_COVERAGE_KEYS_BY_SCHEMA[8]` all equal `[7]`. **What changed is the `spend` block: it now reports THREE budgets separately**, because the creation walk can take a keyed indexed route. It gains `rpcProvider` (`helius` or `public`), `rpcEndpoint`, `heliusCredits`, `heliusCreditCeilingPerCandidate` and `plannedWorstCaseHeliusCredits`. They are five new keys rather than additions to the existing totals because the three budgets have three units and no exchange rate between them: MadeOnSol is metered in **requests** against a daily allowance, Helius in **credits** against an unshared monthly one, and the keyless hosts in neither — a single "requests" total would hide which allowance a heavy run actually spent. `rpcEndpoint` holds the endpoint's **label** and never the composed URL, which on the keyed route carries the credential in a query parameter. On a schema-≤7 record all five are genuinely absent and must not be reconstructed: those runs predate the indexed route, so the walk was the keyless one and the record cannot say which host answered it. `heliusCredits: 0` beside `rpcProvider: "public"` is a keyless run that spent no credit; `heliusCreditCeilingPerCandidate: null` means the indexed walk did not run at all. |
| 9 | no new candidate ROW field, no new `entry` field, no new `entry.coverage` field and no new `spend` field: `PERSISTED_BY_SCHEMA[9]`, `ENTRY_KEYS_BY_SCHEMA[9]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[9]` and `SPEND_KEYS_BY_SCHEMA[9]` all equal `[8]`. **What changed is where the launch history comes from: creation ENUMERATION is primary on Dune** (captain decision 156a). A new run-level `dune` block carries the coverage probe's own bounds and the Dune spend in its own units — `used`, `reason`, `rejected`, `unusableNote`, `endpoint`, `creationQueryId`, `coverageQueryId`, `executions`, `executionCeiling`, `requests`, `resultBytes`, `estimatedCredits`, `rowsReturned`, `unreadableRows`, `walletsRefusedByShape` and `coverage` (which tables were probed, from when to when, which are READ by the enumeration, months with no row, and why a probe refused). It is a block of its own rather than five more `spend` keys because Dune is a fourth vendor in a fourth unit — executions plus bytes against an ACCOUNT-wide monthly allowance, where a FAILED execution is billed exactly like a successful one — and `estimatedCredits` is an **estimate**, the published 20 credits/MB applied to the bytes the vendor's own metadata declared, with compute billed on top. Each candidate's `creation` block gains `enumerationSource` (`dune` | `helius` | `keyless-rpc`), `duneLaunches`, `duneFallbackReasons` and `creatorMovementUnmeasured`. **The one that will bite: on a schema-≤8 record `creation.movedCreator: 0` means the walk read every curve and none had moved. On a schema-9 record whose `enumerationSource` is `dune` it means nothing was looked at** — Dune says who created a mint and whether it completed, and nothing about who owns the curve today — and `creatorMovementUnmeasured` is the size of what went unmeasured. Do not add the two, and do not read a Dune-sourced 0 as the walk's 0. On a Dune-sourced candidate `rpcRequests`, `loadShedEvents`, `signaturesScanned`, `signaturesSucceeded`, `transactionsInspected` and `curvesUnread` all read 0 because no walk happened, and `stopReason` is `dune-enumerated`, which is not a stop at all; `coveredFromIso`/`coveredToIso` are the PROBE's bound rather than a walk's window and `wholeHistory` is true inside it. **A single run may carry both sources**: the coverage probe refuses a wallet at a time, so a wallet whose earliest launch sits at or before the probed surfaces' own first row falls back to the walk while the rest of the batch does not. `duneFallbackReasons` is why a candidate fell back, and it is not only coverage — an unreadable row anywhere in the answer refuses the whole batch, a wallet the enumeration returned no row for is refused as an absence of evidence rather than read as zero launches, and a candidate whose address is not base58-shaped is never sent at all (`walletsRefusedByShape` counts those). |
| 10 | no new candidate ROW field, no new `entry.coverage` field, no new `spend` field, no new `dune` field and no new `creation` field: `PERSISTED_BY_SCHEMA[10]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[10]`, `SPEND_KEYS_BY_SCHEMA[10]`, `DUNE_KEYS_BY_SCHEMA[10]` and `CREATION_KEYS_BY_SCHEMA[10]` all equal `[9]`. **What changed is that an UNMEASURED verdict now says which of its six producers reached it, and whose fact that is** (captain decision 174b). `entry` gains `unmeasuredCause` (one of `entry.mjs` → `UNMEASURED_CAUSES`, or `null` on a measured verdict), `unmeasuredCauseAttribution` (`our-coverage` | `deployer` | `null`) and `unmeasuredContributingCauses` (every producer that applied, primary first — the three sample-size causes can co-occur). **The verdict vocabulary is UNCHANGED**, so unlike the schema-6 boundary a schema-9 verdict and a schema-10 verdict are the same six values and are directly comparable; what an older record cannot do is say WHY an unmeasured one was reached. **The one that will bite:** all six producers are facts about OUR coverage — the walk was never offered `minLaunchesSampled` windows, windows were dropped, windows were REFUSED as unproven openings (decision 134a), the field closed too few round trips inside a window whose tail our own walk truncates, too little of the field priced, too few round trips priced end to end. So `verdict !== 'entry-unmeasured'` is a filter on our own budget and evidence wearing a measurement's clothes, and a later stage may filter only on a MEASURED verdict at any schema version. On a schema-≤9 record the cause is genuinely absent and **must not be reconstructed**: `entry.mjs` → `isDeployerAttributable` answers `false` for the whole unmeasured family there, which is the safe direction. See “What a later stage may filter on” below. |
| 11 | no new candidate ROW field, no new `entry.coverage` field, no new `spend` field and no new `dune` field: `PERSISTED_BY_SCHEMA[11]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[11]`, `SPEND_KEYS_BY_SCHEMA[11]` and `DUNE_KEYS_BY_SCHEMA[11]` all equal `[10]`. **What changed is the CO-ORDINATION RULE: it became a UNION** (captain decision 182a) of the existing shared-transaction rule, unchanged, and the deployer-anchored contiguous block-index run at step 1. `entry` gains `runTx` (transactions in that run, anchor included) and `adjacencyMarks` (wallets the run marked that the shared-transaction rule did not) beside `bundledTx` and `maxWalletsInOneTx`. It costs no request, no host and no vendor quota — `sid` is already on every fill the walk fetched. **THE ONE THAT WILL BITE: a schema-≤10 `entry.roomLeft` is not comparable with a schema-11 one, and the older figure is the HIGHER of the two.** A wallet that rode the deployer's bundle without ever sharing a transaction used to be counted as an outsider, so its stake sat in `independentSol` and inflated `roomLeft`; `sharedTx ⊆ union` by construction, so the correction can only move a room reading DOWN. `adjacencyMarks` is the size of what the union added per launch, and therefore the measure of what an older record's room figure was carrying. On the committed tape it removes **180 create-slot wallet-instances from the field** (1,502 → 1,322) and **every one of the 180 is a NAMED cohort wallet** — so a schema-≤10 record's field figures, `outsidersPerLaunch`, `fieldEntrants` and every P&L distribution built on them were partly measuring the operation's own wallets as competitors. `launchesRoomUnproven` changes meaning the same way — it counts launches NEITHER half marked anything in, and on the committed tape the refusal falls from 60 of 235 launches to 0. **No bar was relaxed**: decision 134a's refusal is untouched and `minLaunchesSampled`/`maxLaunchesPerCandidate` are unmoved (decision 141a stands); the rule sees more, so it refuses less. **The `stage0` block is not comparable across the boundary either, and a published constant moved**: `stage2SeamReproduction`'s era-2 entry reads `n: 89, nRoomUnproven: 0` at a measured share of **0.770796** where a schema-5..10 record reads `n: 86, nRoomUnproven: 3` at **0.769153** — the published `0.771` it is compared against is UNCHANGED and the measured figure moved towards it, the structural and named-cohort estimators becoming the same number to six decimals over the full 89. `rollingRoom` goes from `unmeasured: 81, present: 53, absent: 94` to `unmeasured: 0, present: 88, absent: 140`, `falsePositives: 0` on both sides. The block gains `adjacencyRuns`, the tripwire on the `sid` block-index signal, persisted because that signal fails SILENTLY and towards refusal. The correction is recorded in `population-tape-2026-07-29/IMPORT.md` → "Corrections"; `report.md` and the dataset README are a primary record and are not edited. |
| 12 | no new key ANYWHERE: `PERSISTED_BY_SCHEMA[12]`, `ENTRY_KEYS_BY_SCHEMA[12]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[12]`, `SPEND_KEYS_BY_SCHEMA[12]`, `DUNE_KEYS_BY_SCHEMA[12]` and `CREATION_KEYS_BY_SCHEMA[12]` all equal `[11]`. **What changed is the DOMAIN of an existing field: `entry.unmeasuredCause` gains a seventh value, `room-verdict-not-robust-to-missing-launches`** (captain decision 198b). The version is bumped precisely because no key-set assertion can see this — a consumer that enumerated the six causes would otherwise meet a seventh with nothing saying so, which is the same hole schema 10 exists to close one level up. **What it means.** Decision 190a decoupled `maxLaunchesPerCandidate` (10) from `minLaunchesSampled` (8), so a candidate keeps its verdict after losing up to two launches — and the missing ones are chosen by DROP CAUSE, not at random: the request cap takes the busiest windows and `roomIsProven` takes the ones with no co-ordination evidence. `entry.mjs` → `roomBarRobustness` now refuses a room verdict whenever completing that hole could have put the median on the other side of `minRoomLeft`, in EITHER direction, because the direction of the bias is unmeasured. **No `thresholds.json` value moved and no new one was pinned** — the interval is the sample's own reachable median range under `measure.mjs` → `ROOM_LEFT_RANGE`, which is algebraic. **Two ways to misread it.** (1) It is NOT a sample-size cause: `entry.launchesSampled` on such a record is at or ABOVE `minLaunchesSampled`, where every `too-few-*` record sits below it — the candidate had enough windows and was refused anyway. (2) A schema-≤11 record's *absence* of this cause is not evidence its sample was robust; the guard did not exist, so a schema-11 `entry-room-absent` or `entry-open-after-costs` reached over 8 of 10 launches is exactly the shape 198b refuses today and is not comparable with a schema-12 one. Committed records are never retro-edited, so the older reading stays legal — what it cannot do is stand in for a guarded one. |
| 13 | no new candidate ROW field, no new `entry` field, no new `entry.coverage` field, no new `spend` field and no new `creation` field: `PERSISTED_BY_SCHEMA[13]`, `ENTRY_KEYS_BY_SCHEMA[13]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[13]`, `SPEND_KEYS_BY_SCHEMA[13]` and `CREATION_KEYS_BY_SCHEMA[13]` all equal `[12]`. **What changed is that the Dune MONTHLY CREDIT CEILING is now something a run checks before it spends, rather than something it discovers by hitting.** The run-level `dune` block gains two keys. `allowance` is the verdict of `dune.mjs` → `checkDuneAllowance`, read from `POST /usage` **before the leg's first billed request** — the coverage probe included, because a result read is billed by bytes — and it carries the plan's worst case in credits, the period's `credits_used`/`credits_included` and dates, what remained, the reserve held back for the counter's lag, the verdict (`sufficient` | `tight` | `insufficient` | `unreadable`) and the reasons. `localEstimate` is what the run believes it spent, from its OWN counters at the pinned worst case per execution, and it carries a caveat string saying it is not the bill. **`allowance: null` means the run never reached Dune at all** (no key, `--no-dune`, `--ownership-only`, or nothing to gate) — it does NOT mean the check passed. **The one that will bite:** on a schema-≤12 record the absence of this block is not evidence a run had headroom; nothing checked, and a run reporting two executions may have been the one that emptied the period. That gap is what this version closes, not a defect in the older records, which are never retro-edited. |
| 14 | no new candidate ROW field, no new `entry.coverage` field, no new `spend` field, no new `dune` field and no new `creation` field: `PERSISTED_BY_SCHEMA[14]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[14]`, `SPEND_KEYS_BY_SCHEMA[14]`, `DUNE_KEYS_BY_SCHEMA[14]` and `CREATION_KEYS_BY_SCHEMA[14]` all equal `[13]`. **`entry` gains ONE key, `roomLeftBound`, and with it the room median stops being quotable without its own incompleteness** (captain decision 208b). `entry.roomLeft.median` is taken over the launches Stage 2 SCORED, and the ones it did not score did not go missing at random — `roomIsProven` refuses create slots with no co-ordination evidence, the request cap drops the busiest windows, and the stage ceiling leaves the oldest of a plan unattempted. `roomLeftBound` is the interval the median would lie in if that hole were filled: `lo`, `hi`, `overstatementMax` (`median - lo`, the headline), `understatementMax`, `provablyOverstated` (true when `hi < median`, i.e. when completing the sample MUST lower it), the hole split into `launchesRefusedMeasured` and `launchesUnmeasured`, the refused windows' own measured room in `refusedRoomLeft`, and the sentence in `caveat`. The `stage0` block's per-control summary gains a `roomLeftBound` beside its `roomLeftMedian` for the same reason. **It is REPORTING and nothing reads it** — no verdict, bar or guard takes it as an input, `roomIsProven` is untouched and no sample-size floor moved; decisions 203c and 203d stay declined. **The one that will bite:** a schema-≤13 `entry.roomLeft.median` has NO bound and one cannot be reconstructed from the record, because `launchesRoomUnproven` says how many windows were refused and nothing about what they measured. Read an older median as a figure of unknown incompleteness rather than as a complete one — on the committed schema-12 `runs/2026-08-04.json` the difference is `0.288940` reported against `0.0008` completed. |
| 15 | no new candidate ROW field, no new `entry` field, no new `entry.coverage` field, no new `spend` field and no new `dune` field: `PERSISTED_BY_SCHEMA[15]`, `ENTRY_KEYS_BY_SCHEMA[15]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[15]`, `SPEND_KEYS_BY_SCHEMA[15]` and `DUNE_KEYS_BY_SCHEMA[15]` all equal `[14]`. **`creation` gains THREE keys — `mayhemLaunches`, `mayhemFlagReadable` and `mayhemShare` — and with them pump.fun's mayhem-mode flag becomes something this screen records** (captain decision 227a). `pump_evt_createevent` has always carried an `is_mayhem_mode` boolean and this repo never selected it; `slot-zero-graduation-regime-remeasure` §§1.4 and 3 (held in firstmate's records, not in this repo) measured what it is worth: **27.1% of 2026-07's pump.fun launches carried it, they graduated at 4.1–4.7% against 1.8–2.1% for the rest, and they supplied 46.3% of that month's graduations** — so roughly two-thirds of the graduation-rate regime change traces to this one flag. It matters to both halves of this screen: a completion rate that cannot tell the buckets apart measures two things through one number, and pump.fun documents the mode as one in which **an AI agent trades the token** (vendor documentation, NOT verified on-chain here), which would put a house agent in a create slot Stage 2's entry model assumes holds independent snipers. `CREATION_SQL` now selects the flag as a SIXTH column. `mayhemLaunches` counts the enumerated launches carrying it; **`mayhemFlagReadable` is the share's DENOMINATOR and is not `duneLaunches`** — `pump_call_create` has no such column, so a history reaching back past `pump_evt_createevent` holds launches the flag cannot be read on, and the difference between the two fields is how many; `mayhemShare` is the quotient. **It is REPORTING and nothing reads it**: no bar, gate, rate or verdict takes it as an input, no launch is dropped or weighted for carrying it, and a test pins that verdicts are identical with the column populated, absent and malformed. Excluding mayhem launches from the competence measure (227b) and excluding mayhem-heavy deployers outright (227c) were both declined — do not read this version as a step towards either. **CORRECTION, and the row above is the record of what schema 15 DID rather than of what still holds: 227b is now REVERSED by captain decision 351 (2026-08-07) and the exclusion is live at schema 19** — a mayhem-mode graduation raises a median 0.291 SOL against 85.005 for a classic curve one, so it is not competence evidence, and a mayhem launch is excluded from BOTH sides of `minCompletionRate`. **227c is NOT reversed and remains declined**: no deployer is dropped or weighted for having a mayhem record, which is precisely why the denominator moves with the numerator. So schema 15's own "nothing reads it" is true OF SCHEMA 15 and of every record written at 15–18, and false of this build; the `creation` block's three fields are still the 227a observation nothing reads, and 351's own two counts are candidate ROW fields added at 19. **The one that will bite: all three are `null` on a candidate the creation walk answered, and that null is UNMEASURED, never 0%.** The flag is a column on Dune's decoded create event and the walk reads transactions and curve accounts, so read `enumerationSource` beside it — the same trap `creatorMovementUnmeasured` carries in the other direction. A schema-≤14 record carries no mayhem reading at all and one cannot be reconstructed from it. |
| 16 | no new `entry`, `entry.coverage`, `spend`, `dune` or `creation` field: `ENTRY_KEYS_BY_SCHEMA[16]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[16]`, `SPEND_KEYS_BY_SCHEMA[16]`, `DUNE_KEYS_BY_SCHEMA[16]` and `CREATION_KEYS_BY_SCHEMA[16]` all equal `[15]`. **A run states what it PREDICTED, in a form a later run can score.** Every candidate row gains `prediction` and the record gains a run-level `predictions` block. **Why a version for something that measures nothing: a run that did not record what it predicted can NEVER be graded** — not "gradeable later", never, because neither the claim nor the instant it stops being in-sample survives anywhere else — so every record at schema <=15 is permanently unfalsifiable, and that is a property of those records rather than a shortcoming of their measurements. `prediction.claims` is a LIST keyed by `subject`, each entry holding the beatable / not-beatable call, the verdict it was read off, whether that verdict was MEASURED (`entry.mjs` -> `isDeployerAttributable`) and why there is no claim when there is none. `prediction.madeAtIso` is the run's own `finishedAtIso` and is the **out-of-sample boundary**, copied onto every row so one row is a self-contained claim; `prediction.gateReading` copies `historySource` and `prediction.entryReading` names Stage 2's surface, because the two readings behind a claim are different surfaces and this record is not where they get pooled. **Two ways to misread it.** (1) A claim is absent for two different reasons and the block keeps them apart -- `not-scored` (Stage 2 never ran on this candidate) and `entry-unmeasured` (it ran and could not answer); **neither is a prediction of "not beatable"**, because reading an unmeasured verdict as a claim would let the screen grade itself right whenever its own budget ran out, which is captain decision 174b's failure mode wearing a hit rate. (2) The counts are CLAIMS, not results -- nothing in a run record is ever graded, and a committed record is never retro-edited to carry a grade; `feedback/grades.json` holds those. **Stage 3 is deferred, not cancelled** (captain decision 237a): `predictions.subjectsDeferred` records `exit` as a subject this build deliberately did not predict, so a later build appending an exit claim to the same list invalidates no record written under 16. |
| 17 | no new candidate ROW field, no new `entry` field, no new `entry.coverage` field, no new `spend` field, no new `dune` field and no new `creation` field: `PERSISTED_BY_SCHEMA[17]`, `ENTRY_KEYS_BY_SCHEMA[17]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[17]`, `SPEND_KEYS_BY_SCHEMA[17]`, `DUNE_KEYS_BY_SCHEMA[17]` and `CREATION_KEYS_BY_SCHEMA[17]` all equal `[16]`. **A run can now carry the PREDICTIONS it was made to test, in a new run-level `declaredPredictions` block** (captain decision 232c). Until this version there was nowhere in a record to say what a run expected before it looked, so every prediction lived in a companion document that could be written, revised or lost independently of the measurement it was about — and a sidecar is a second copy of a claim, which drifts until whichever one a reader opens becomes the truth. This section's own opening line has always declared these files the grading lane's input; schema 17 is what makes that true of predictions as well as outcomes. `--predict <path>` reads a document, `record.mjs` → `readPredictions` validates its SHAPE, and it is embedded **verbatim**: `documentVersion`, `lane`, `leg`, `madeAtIso`, `basis`, `source` (the path it came from) and `predictions`, each row being `{id, statement, reading, metric, comparator, value, rationale}`. `metric` is **either** a dotted path into this record **or** a `derived:` name from `record.mjs` → `DERIVED_PREDICTION_METRICS`, and `resolvePredictionMetric` is the single resolver for both, so a grader reads the field the prediction named rather than one it re-derived; a path that does not resolve is UNGRADEABLE, never a miss. The derived half exists because the questions worth predicting are mostly **counts over `candidates[]`** rather than scalars the record holds — *how many did this leg admit* is not a field — and every rate metric in that vocabulary names its READING in its own name (`medianGateCompletionRate` against `medianVendorPageCompletionRate`), because a metric called `medianCompletionRate` would be exactly the ambiguity 231a removed. **`reading` is required and refusing to default it is the point**: a completion rate is two different quantities here — the creation-derived merged history the gate reads and the vendor 70-record page — differing by an order of magnitude on the same wallets, and captain decision 231a exists because a bar was once stated without naming which, so a prediction that does not say which rate it is about is refused rather than guessed. `metric: null` is legitimate and means the claim is not resolvable from a record alone; it then carries no comparator and no value. **Nothing here is evaluated by the screen, deliberately** — it records the claim and measures the run, and scoring one against the other belongs to the lane that grades; a tool marking its own paper is not a hit rate. **It is NOT schema 16's `predictions`, and the two names are kept apart on purpose:** schema 16's `predictions` is what the SCREEN predicted about its candidates, emitted from its own verdicts, while `declaredPredictions` is what the LANE predicted about the run before it looked — operator-supplied, carried verbatim and graded elsewhere. **The one that will bite:** `declaredPredictions: null` is the normal state of a run made without `--predict` and means *nothing was predicted*, never *the predictions failed*; and the block is shape-checked but **not content-checked** — a document written after the run would look identical to one written before it, so what makes these predictions rather than postdictions is that the document is committed in its own commit ahead of the run, exactly as `thresholds.json` is. The record cannot prove that and does not claim to. |
| 18 | **A run can carry BOTH Stage 2 entry fill sources and say, PER CANDIDATE, which one answered it** — Gate 3 precondition 4, and it is EVIDENCE FOR that gate rather than the cutover: `ENTRY_FILL_SOURCE_KIND` is unmoved, a default run still reads the swap-api, and every field below is `null`/empty on one. Three new candidate ROW fields — `PERSISTED_BY_SCHEMA[18]` — and one new run-level block; `ENTRY_KEYS_BY_SCHEMA[18]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[18]`, `SPEND_KEYS_BY_SCHEMA[18]`, `DUNE_KEYS_BY_SCHEMA[18]` and `CREATION_KEYS_BY_SCHEMA[18]` all equal `[17]`, because both sources score at ONE recipe and a finding's shape does not depend on which transport produced it. `entrySource` names which fill source produced this candidate's `entry` (`swap-api` | `dune`), and it is **`enumerationSource`'s shape one stage over** (captain decisions 156a and 191a) — per candidate for the same reason, since a primary source can fail to answer for one wallet while answering for the rest. `null` there means Stage 2 produced NO score at all (no gate pass, `--no-stage2`, or the scoring cap), never "a source that was not named"; on a record at schema ≤17 its ABSENCE is unambiguous, because every such run read the swap-api and nothing else. `entrySourceFallbackReasons` says why a candidate's recorded reading came from the cross-check source instead of the primary. `entryAgreement` carries that candidate's comparison class. **The run-level `entrySourceAgreement` block carries COUNTS BY CLASS AND NEVER A RATE, and that is the contract rather than a preference:** captain decision 143a, because a 98.4% whole-window agreement figure on this project hid a total failure confined to the create slot — an aggregate is dominated by the easy majority, and the unit that can be wrong is the candidate. So `byClass` counts `agreed`, `disagreed`, `only-<kind>-answered` and `neither-answered` apart, `noAggregateRate` travels with them, and the class lives on the row. **`only-<kind>-answered` is a COVERAGE difference and not a disagreement** — captain decision 174b one level up: an unmeasured verdict is no answer, not a wrong one, and every producer of one is our own coverage. The block also carries `recipeBlock` (both sources scored at `stage2_entry`, so a verdict difference is attributable to the TRANSPORT rather than to the caps) and `duneSpend`, the entry leg's own Dune meter — kept out of the run-level `dune` block because that one bounds an enumeration answering a whole batch in ONE execution and this one bounds a leg executing per window. **`duneSpend` states the PERMISSION and the APPLICATION side by side and the two must not be pooled:** `executionCeiling`/`windowCeiling` are the pins, what this tool allows any run of this leg, while `executionBoundApplied` (the `maxExecutions` this run's `DuneClient` was constructed with) and `windowsPlanned` (the window count its credit plan was priced and approved at) are what THIS RUN could have cost — a plan is derived from the windows it plans, so a block carrying only the pins would describe a bound no run applied, and one carrying only the application would lose the limit a reader judges it against. A record is never retro-edited, so either half-truth would be permanent. Finally, `prediction.entryReading` became **source-aware** at this version: it named the swap-api gate specifically, which was true only while one source was ever selected, and a Dune-sourced claim filed under that sentence would describe a gate it did not use — permanently, since a record is never retro-edited. `prediction.mjs` → `entryReadingFor` refuses an unknown source rather than defaulting to another's. |
| 19 | **A MAYHEM-MODE GRADUATION IS NOT COMPETENCE EVIDENCE, so a mayhem launch leaves BOTH sides of `minCompletionRate`** — captain decision 351 (2026-08-07), which **REVERSES 227b**. Two new candidate ROW fields, `competenceMayhemExcluded` and `competenceMayhemUnreadable` (`PERSISTED_BY_SCHEMA[19]`); `ENTRY_KEYS_BY_SCHEMA[19]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[19]`, `SPEND_KEYS_BY_SCHEMA[19]`, `DUNE_KEYS_BY_SCHEMA[19]` and `CREATION_KEYS_BY_SCHEMA[19]` all equal `[18]`. **The evidence:** a mayhem graduation is preceded by a median net quote inflow of **0.291 SOL** against **85.005 SOL** for a classic curve graduation — 292x cheaper, and not separable in trade data from a token that churned about $1,700 and died — while in 2026-07 mayhem was **27.15% of pump.fun launches and 46.41% of its graduations** (`slot-zero-offlaunchpad-graduation-criterion` → `report.md` §4 and §8.2, held in firstmate's records, not in this repo). So the bar that IS the gate had been measuring two very different achievements through one number. **Why the DENOMINATOR moves too, and it is not optional:** a numerator-only exclusion drives a mayhem-heavy deployer's rate towards 0.0000 and removes them from the gate, which is captain decision **227c** — *excluding mayhem-heavy deployers outright* — and **227c is NOT reversed and remains declined**. A deployer is judged on their non-mayhem record, not removed for having a mayhem one. **`competenceMayhemExcluded`** is what the exclusion removed from both sides; **`competenceMayhemUnreadable`** is how many of the launches that REMAIN carry no readable flag — they are counted in `tokens` and `completed`, which is a stated decision rather than a default, and this field is what makes it auditable (equal to `tokens` AND `competenceMayhemExcluded` 0 means no mayhem evidence touched the rate at all, i.e. the pre-351 reading — both conjuncts, since a row with launches excluded can still have nothing readable left among those that remain). Dropping them instead would empty the denominator of every walk-sourced candidate on evidence about the SURFACE rather than about the deployer, and a false rejection here is permanent and invisible. **An all-mayhem deployer reads UNMEASURED, never 0.0000** — `rank.mjs` → `competenceEmptiedByMayhem` routes zero-of-zero to `gate-unmeasured`, which is neither a rejection nor a pass. **The one that will bite:** `tokens`, `completed`, `completionRate` and `spanDays` now describe the NON-MAYHEM record, so **a schema-≤18 rate and a schema-19 rate are not the same quantity and must not be pooled**; a schema-≤18 record carries neither new field and one cannot be reconstructed from it, because `creation.mayhemLaunches` is a share of what the ENUMERATION returned — a different denominator from the merged history the gate read — and is `null` on every walk-sourced candidate. There are deliberately no `vendor*` twins: the MadeOnSol profile page has no such column, so `vendorCompletionRate` is unmovable by 351 by construction. |
| 20 | **Stage 2 scoring has a MEMORY, so the cap goes to the LEAST-RECENTLY-SCORED survivors** — captain decision 336a. No new candidate ROW field, no new `entry` field, no new `entry.coverage` field, no new `spend` field, no new `dune` field and no new `creation` field: `PERSISTED_BY_SCHEMA[20]`, `ENTRY_KEYS_BY_SCHEMA[20]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[20]`, `SPEND_KEYS_BY_SCHEMA[20]`, `DUNE_KEYS_BY_SCHEMA[20]` and `CREATION_KEYS_BY_SCHEMA[20]` all equal `[19]`. One new run-level block, `scoringRotation`. **What changed:** until this version `screen.mjs` took `survivors.slice(0, maxScored)` — the first seven gate survivors in `mergeSeeds` order, which is deterministic — so a daily run re-measured the same seven wallets every day, while the median survivor needs about **21.5 days** for its ten windows to refresh and **0 of 27** refresh within a day. Distinct yield was about **168 windows a month** against roughly **2,571** of available supply, against the captain's floor of **1,000 window measurements a month**. `maxScored` itself does **not** move — captain decision **339a** keeps capacity at 7 per run, and raising it means moving the scoring cap and the request budget together, which is a separate decision. This version changes WHICH seven. **Why it needs a version at all: a pre-20 run was STATELESS** — same inputs, same output, and anyone could re-run it and reproduce a published result — and rotation makes a run's output depend on every run before it. The captain accepted that trade only on condition that reproducibility be preserved another way, and `scoringRotation` is that condition implemented rather than promised. It NAMES the state it read: `statePath` (repo-relative), `stateSchemaVersion`, and `stateDigestBefore`/`stateDigestAfter`, the SHA-256 of the bytes read and of the bytes written — so run N's `after` is run N+1's `before` and the whole chain of runs is checkable from committed artefacts. It carries `order`, **the WHOLE ranked survivor list rather than the slice taken from it**, which is what lets `rotation.mjs` → `verifySelection` re-derive the selection from the record ALONE, with no state file, no survivor list and no clock; `selected`, `deferred`, `walletsScored`, `scoredAtIso` (one instant per run, stamped on every wallet it scored), `neverScoredBefore` and `importedFromRunRecords` are the counts a reader judges it by, and `reproducibility` carries the condition in one sentence. **`enabled: false` is a real state and is not the block's absence:** a run made with `--no-rotation`, or one where Stage 2 selected nobody, records the block with a `reason`, so a stateless run is never read as a rotated one that happened to repeat. **An UNMEASURED verdict advances the rotation**, because it consumed the cap and the keyless walk that goes with it — that is not captain decision 174b's forbidden filter, since nobody is dropped, the wallet keeps its place in the cycle and the record still surfaces and counts its verdict. **The one that will bite:** on a schema-≤19 record the absence of this block means the run took the HEAD of the survivor list, so **two such records scoring the same wallets are not evidence about those wallets** — they are evidence that the seed order did not move; and `scoringCap.survivorsUnscored` means the same thing across the boundary while the wallets behind it do not, being the list's tail before 20 and whichever were measured most recently after it. |
| 21 | **THE COMPLETION MEASURE IS RAISE-85 ON EVERY VENUE, pump.fun INCLUDED** — captain decision 352b (2026-08-09). `completed` and `completionRate` no longer mean *pump.fun said these graduated*; they mean *this many of these tokens' own primary markets took in 85 SOL-equivalent in their first 24 hours*. **So a schema-≤20 rate and a schema-21 one are not the same quantity either** — that is now true at two of the last three versions (19 moved the same quantity, 20 left it alone), so read `schemaVersion` before pooling any two `completionRate` values from this tool, ever. Four new candidate ROW fields — `competenceCriterionUnreadable` and `competenceCriterionEstimated` for the gate reading, plus their vendor twins `vendorCompetenceCriterionUnreadable` and `vendorCompetenceCriterionEstimated` (`PERSISTED_BY_SCHEMA[21]`); `ENTRY_KEYS_BY_SCHEMA[21]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[21]`, `SPEND_KEYS_BY_SCHEMA[21]`, `DUNE_KEYS_BY_SCHEMA[21]` and `CREATION_KEYS_BY_SCHEMA[21]` all equal `[20]`. **The evidence:** the 85 was read off the data rather than fitted — graduating non-mayhem tokens read 85.005 SOL at p50 *and* p99 over 157,259 launches — and it has **zero token-level false positives** against 108,310 non-graduating tokens, so a rate computed from it is a LOWER BOUND: measured over 176,200 July-active deployers the proxy **promoted zero** deployers over the 0.25 bar and demoted 1,417. The bar is not lowered to buy recall, because at 50 SOL that zero-false-positive property is already gone (42 promotions) and the safety argument goes with it. **THE SEAM WITH 351, and it is what these two fields exist to make auditable:** RAISE-85 as a definition only touches the NUMERATOR — it simply never registers a mayhem graduation, which raises a median 0.291 SOL — so had mayhem LAUNCHES stayed in the denominator a mayhem-heavy deployer would run to 0.0000 and be dropped, **which is captain decision 227c and 227c REMAINS DECLINED**. The mayhem exclusion therefore runs FIRST, over the whole history, and the criterion is applied only to what it leaves; a mayhem launch is counted in `competenceMayhemExcluded` and NEVER in `competenceCriterionUnreadable`, and **the two pairs are not additive in meaning** — *not competence evidence* and *nothing could measure this* answer different questions. **`competenceCriterionUnreadable`** is how many launches left BOTH sides because the criterion could not be read on them at all; they are never scored as failures, because defaulting our own coverage gap into a rejection is permanent and invisible, and a candidate whose whole history reads that way is `gate-unmeasured` rather than 0.0000 (`rank.mjs` → `competenceEmptiedByCriterion`) — **as is a candidate with ANY unreadable launch** (`rank.mjs` → `competenceCriterionIncomplete`), because those launches leave `tokens` and `spanDays` too, so `minTokens`/`minSpanDays` would otherwise reject a wallet over OUR coverage; **a schema-21 row with `competenceCriterionUnreadable > 0` therefore carries `verdict: "gate-unmeasured"`**. **AND THE VENDOR PAIR MOVED, which schema 19's note said 351 could not do:** `vendorCompleted`/`vendorCompletionRate` are a THIRD quantity here — 352b reads the criterion off the MadeOnSol page's own `complete` field and `toTokenRecords` folds a missing or malformed one to unreadable, so a schema-21 vendor reading drops those rows from both sides where a schema-≤20 one counted them as failures. That pair is a GATE INPUT on `--ownership-only` runs and in `feed.mjs`, so a schema-≤20 `vendorCompletionRate` must not be pooled with a schema-21 one either — which is why it gets the two companion counts the gate rate has. **There is still no vendor twin of the MAYHEM pair and that is not an inconsistency**: schema 19's reasoning (the page carries no mayhem column, so 351 cannot move that rate by construction) holds unchanged; what does not survive 352b is applying it to the criterion, which IS read off that page's own `complete` field. **`competenceCriterionEstimated`** is how many of the `tokens` that REMAIN had RAISE-85 read through pump.fun's own graduation flag rather than measured from trade data — an ESTIMATOR whose negative is exact (every token reaching 85 SOL graduated, precision 1.0000) and whose positive is an upper bound (0.82% of graduations did not reach it, recall 0.9918) — so **`competenceCriterionEstimated === tokens` means the whole rate is an upper bound on the RAISE-85 rate**, which is every route this repo has today. **What it does NOT claim:** equivalent strictness across venues is not established — the same bar is reached by 0.80% of new pump.fun tokens, 0.25% on Meteora DBC and 46.71% on Meteora CPAMM — and no record or doc here may read as cross-venue comparability (`slot-zero-cross-venue-strictness-measure` owns it, held in firstmate's records, not in this repo). **AND THE `consistency` BLOCK MOVED TOO, INDEPENDENTLY OF THE GATE READING** — `rank.mjs` → `measureConsistency` drops a criterion-unreadable launch instead of reading it as a FAILED one (which would manufacture dispersion out of a coverage gap and could mark a deployer STREAKY for a walk that came back short), so `epochs`, `minEpochRate`, `maxEpochRate`, `dispersion` and `streaky` are a different quantity here and **a schema-≤20 `dispersion` must not be pooled with a schema-21 one**. The independence is the trap: consistency walks its OWN creator history rather than the gate's reading, so a gate reading with no unreadable launch does not imply a consistency reading with none, and this block can move on a wallet that PASSED. No key was added for it — the count that left rides on the block's own `note`. **The one that will bite:** a schema-≤20 record carries neither field and one cannot be reconstructed from it; and the one behaviour that genuinely moved is the launch NEITHER source could answer for, which was written `completed: false` (understating the rate) and is `null` now, so it leaves both sides instead. No bar moved and no committed verdict moved — re-deriving the 112, the 58 and the monthly gate populations under the adopted measure is `slot-zero-rederive-gate-population-post-351`. |
| 22 | **THE SCREEN CAN BE HANDED A WALLET LIST, so a candidate no longer has to have come from the vendor** — captain decision 398a (2026-08-09). ONE new candidate ROW field, `candidateSource` (`"vendor-seed"` or `"wallet-list"`), and ONE new run-level block, `walletList`; `ENTRY_KEYS_BY_SCHEMA[22]`, `ENTRY_COVERAGE_KEYS_BY_SCHEMA[22]`, `SPEND_KEYS_BY_SCHEMA[22]`, `DUNE_KEYS_BY_SCHEMA[22]`, `CREATION_KEYS_BY_SCHEMA[22]` and `ROTATION_BLOCK_KEYS_BY_SCHEMA[22]` all equal `[21]`. **No measured quantity moves at all** — unlike the 19 and 21 boundaries, a schema-21 `completionRate` and a schema-22 one are the same quantity and may be pooled. **Why it needs a version:** until this one every candidate in every record came from a MadeOnSol enumeration endpoint, so *where a candidate came from* was a property of the tool rather than of the row and nothing had to say it. `--wallets` ends that, and the two populations are not interchangeable — the listed one is by construction the part the vendor never surfaced, and 37 of the 58 deployers that passed this gate in 2026-07 (64%) are invisible to every discovery source this repo has. A reader pooling them without version-detecting would describe a discovery surface that measured neither. **On a schema-≤21 record the field's absence is unambiguous:** nothing before this version could supply a list, so every candidate in one is `vendor-seed`. **What it does NOT change, and this is the load-bearing half:** a supplied list is a SEED and never a substitute for the gate. A listed address becomes an ordinary `SeedCandidate` and enters the ONE gate loop, so there is no second path and no bar it can skip; `candidateSource` is provenance and is read by nothing — no bar, no verdict, no stage, no rotation comparator, and a test scans the scoring modules' executable half for it. A listed wallet failing the competence bars carries `verdict: "gate-failed"` and `entry: null` exactly as a seeded one does. **The run-level block** is `null` on every enumerated run; when present it carries `path`, `digest` (SHA-256 of the file's bytes), `label` (the `wallet-list:<file>` value on every listed candidate's `seededBy`), `entriesRead`, `wallets`, `seedsIssued` and `isASeed`, the constraint verbatim. The digest is there for the reason `scoringRotation` names its own: this file IS the run's whole population, so a record carrying only a path would stay reproducible exactly as long as nobody edited it — and `seedsIssued: 0` is STATED rather than inferred from an empty `coverage.seeds`, because an empty seed table also describes a run whose enumeration failed. **The plan arithmetic moved with it:** a listed run issues NO enumeration request, so `spend.plannedWorstCaseKeyed` is `0 + <addresses>` rather than `6 + <cap>` and `spend.candidateCap` is the list's own length rather than a ceiling the run was allowed to fall short of. Nothing else in the cost model moves — the keyless and Helius ceilings are per candidate and unchanged, Stage 2's keyless ceiling is `maxCandidatesScored x maxLaunchesPerCandidate x maxRequestsPerLaunch` and none of those three moved, and no Dune execution or Helius credit is spent that a seeded run would not spend. |

**Reading a verdict across the schema-6 boundary — this is the one that will bite.**
`entry-room-present` is gone. A schema-≤5 `entry-room-present` means *room was present and the price
of the seat was never measured*; a schema-6 `entry-open-after-costs` means room was present, the seat
was priced, and the field still cleared after paying for it. **They are not the same verdict and the
older one must not be read as the newer.** Two schema-6 verdicts have no older equivalent at all —
`entry-cost-unmeasured` (the free legs passed and the cost leg could not price enough of the field;
terminal, and never a pass) and `entry-cost-prohibitive`. `entry-field-loss-making` survives but is
now reachable from two places: gross, as before, and **net of measured fees**, which no older record
could compute.

**Every cost figure is a LOWER bound**, and the record says so on the number rather than only here:
a landing tip paid in a separate transaction of the same bundle is not recoverable from the
entrant's own transaction, so `entry.caveats` carries that sentence on every priced score.

**Eligibility counts are not reconstructable from an older record.** On schema ≤5,
`launchRefsAvailable` and `launchesAttempted` could not be told apart from the
`maxLaunchesPerCandidate` cap, so **do not infer one** — the numbers are not in there. From schema 6
the filter's whole arithmetic is: `launchesTooYoung + launchesEligible = launchRefsAvailable`, and
`launchesPlanned + launchesDroppedByCap = launchesEligible`. `youngestEligibleAgeMs` read beside
`minAgeMs` says whether the run exercised the eligibility boundary or sat hours above it, which the
committed live run did and could not report. **`minAgeMs` IS THE FILL SOURCE'S OWN ANSWER, and on
the swap-api source it is derived from pinned inputs** — the declared slot span at a pinned
worst-case slot rate, see "It does bound one other thing" below — so a record carries what that
derivation was worth on the day it was written. The committed schema-6 records read `65000` where a run today reads `85000` because the bound was re-derived and its pinned
rate raised between them, **not** because the chain moved under a live reading.

**Reading `entry` across the schema-5 boundary.** `entry.launchesSampled` on schema 3 and 4 counts
every measured window, including ones whose opening was unproven; on schema 5 it counts only the
**scored** ones, and the refused ones are the new field beside it. More importantly, a schema-3 or
schema-4 `entry.roomLeft` **may be inflated by the operation's own stake booked as outsider
capital**, and the record carries nothing that could say by how much — which is precisely why the
three fields were added. Do not compare a schema-≤4 room figure with a schema-5 one as though they
answered the same question. The two committed live records both sit in the post-break regime where
the co-ordination rule recovers 97–100% of our subject's cohort, so the exposure on them is small,
but it is not measurable from the records themselves.

**Reading `stage0` across the schema-5 boundary — the block changed meaning too.** Stage 0 now
filters its era buckets on the same `roomIsProven` rule, so `stage0.stage2SeamReproduction[].n` for
era 2 moved **89 → 86** between schema 4 and schema 5 **with no change to the tape**: a schema-4 `n`
counts every launch in the era, a schema-5 `n` counts only the scored ones. Each entry now carries
`nRoomUnproven`, the refused remainder, so the older figure can be reconstructed. The block also
gains `rollingRoom` — `windows`, `present`, `absent`, `unmeasured`, `falsePositives`,
`falseNegatives`, `ok` — so a saved run carries evidence that the control ran and what it found,
rather than only that Stage 0 exited 0. A schema-≤4 record holds neither field. **Do not compare a
schema-4 and a schema-5 `stage2SeamReproduction` as though they answered the same question.**

**`coverage` is not a version signal.** The committed schema-1 record
`runs/2026-07-29-elite.json` already carries it, including `coverage.coverageTruncated` and
`droppedByCandidateCap: 10`. Read `coverage` on every record and version-detect on `completed`.

Committed records are **evidence and are never retro-edited** to fit a newer schema — a lane whose
purpose is grading what past runs predicted cannot also be rewriting them. So version skew is real
and permanent, and the reader is what has to be correct.

### `completed` is three-state: `true`, `false`, or absent-and-UNKNOWN

**A record without `completed` predates the field. It MUST be read as UNKNOWN — never as `false`.**

`runs/2026-07-29-elite.json` is exactly this case, and it is why the rule matters rather than being
pedantry. That run **finished**; its `truncated: true` means only that the candidate cap dropped
wallets it never gated. A consumer that reads `record.completed` gets `undefined`, which is falsy,
which reads as `false` — so the naive read turns a completed run into an aborted one and grades a
real measurement as a failure.

Two things are therefore forbidden:

- **Do not collapse unknown into `true` or `false`**, by defaulting or otherwise. Propagate it, or
  refuse to grade the record, but do not pick a side.
- **Do not infer completeness from `truncated` or `truncationReason`.** Those describe *what is
  missing*, not *whether the run reached the end*. The committed record is the counterexample: its
  truncation is a benign cap, not a failure.

### A ceiling hit is never a measured result

**If the tool could not look, the record says it could not look.** A request ceiling or a failed walk
contributes an entry to `unmeasured` — what was not measured, for which wallet, and why — and
`renderStage1` prints it as its own block, not only as a per-candidate note. The affected candidate
reads `UNMEASURED` and never as a measured negative.

Entries carry a `kind` classified from **what actually happened** — the client attaches the HTTP
status and whether it really retried, so the sentence is evidence rather than a guess — and **only
one kind truncates the run**:

| kind | means | truncates? |
|---|---|---|
| `budget-exhausted` | a request ceiling — a wall. The tool stopped looking, and a rerun stops in the same place, so the reason names the setting to change. | **yes** |
| `page-failure` | the request was retried once and the retry failed too (a 5xx, a transport failure, a timeout). Only this kind says it was retried, and only this kind suggests a rerun may succeed. | no |
| `not-retried-failure` | the same class of failure, but this client was configured not to retry. The cause is known; only the retry is absent. Reachable only with `maxRetriesPerRequest: 0`. | no |
| `vendor-refusal` | a 4xx: the endpoint answered on the first attempt and we deliberately did not retry it. Says so, and points at "did the endpoint move" rather than at a rerun. | no |
| `unparseable-body` | the request **was served** but the body was not JSON. Blame is deliberately not assigned — the likeliest cause is an edge interstitial behind a 200, which is the vendor's, and a bug in our handling is the other, and nothing available distinguishes them. | no |
| `local-error` | it failed in our own code having never reached the endpoint — a bug thrown inside the measurement. Never claims a request was retried, or even made. Our bug. | no |
| `unclassified` | the cause could not be identified, so nothing is claimed about it. | no |
| *(unrecognised)* | an entry written by a newer build. Shown rather than dropped, and it does not truncate: inventing a wall from a label this build cannot read would be asserting a cause we do not have. | no |

**Asserting an inaccurate cause is worse than asserting none.** A record that says "we retried" when
no retry happened is the same class of defect as a record that says "measured" when nothing was
looked at, so an unidentifiable cause is reported as unidentified rather than rounded to the
likeliest story. `record.mjs` → `UNMEASURED_KINDS` is the authority on which kinds truncate, and
`classifyUnmeasured` reads the client's evidence rather than guessing from the exception type alone.

Each entry carries a wallet-independent `summary` and a per-failure `detail` — the cause's own
message, with vendor identifiers struck at construction (see "Nothing vendor-derived survives in a
note, either" below), so the request URL the client's message embeds no longer reaches the record.
**The summary is the grouping key**: the detail still varies with the cause, so keying on it would
give near-identical failures a group each, and a grouping that groups nothing is just a longer list.

The split is what keeps the flag worth reading. A keyless walk issues up to 585 requests against the
flakiest surface in the tool; if one retried-and-failed page set `truncated: true`, the flag would be
on for nearly every run, and **a flag that is always on carries no information and teaches its reader
to skip it**. An operator has to be able to tell *"we ran out of allowance and stopped looking"* from
*"one page hiccuped"*.

`completed` is untouched by any of this: it stays "did the run reach the end", so a run that finishes
having hit the keyless ceiling is `completed: true, truncated: true`. `record.mjs` →
`unmeasuredBecause`, `partitionUnmeasured` and `deriveTruncation` are the general form, so a future
budget with the same failure mode inherits the behaviour rather than needing its own special case.

Use `record.mjs` → `completenessOf(record)`, which returns `'complete' | 'incomplete' | 'unknown'`
and never a boolean, so `if (completed)` cannot be accidentally right. `schemaVersionOf(record)` and
`describeCompleteness(state)` are alongside it. The contract is pinned by
`test/deployer-screen.test.ts` → *"the run-record completeness contract"*, including against a
synthetic schema-1 fixture.

For version 2 onwards the pairing to read is:

- `completed: false` — the run aborted. Nothing in it is a measured negative.
- `completed: true` with `coverage.coverageTruncated: true` — the run finished; it simply did not gate
  everything enumeration surfaced.
- `completed: true` with `coverage.coverageTruncated: false` — a full run over its whole seeded pool.

## Stage 2 — ENTRY

Three measurements per candidate, over that candidate's own most recent launches. The first two are
free — arithmetic over fills already in hand — and the third is not, so the first two run first and
a deployer that fails either is refused before one Solana RPC request is spent on it.

### WHICH survivors the cap is spent on — the rotation, and what it traded

**Captain decision 336a.** Stage 2 scores at most `stage2_entry.maxCandidatesScored` gate survivors
a run. It used to take `survivors.slice(0, maxScored)` — the first seven in `mergeSeeds` order, which
is deterministic — so **a daily run re-measured the same seven wallets every day.** That is not a
cheap repeat, it is a wasted run: the median survivor needs about **21.5 days** for its ten windows
to refresh and **0 of 27** refresh within a day, so a same-day re-measure re-answers a question
already answered. Distinct yield was about **168 windows a month** against roughly **2,571** of
available supply, against the captain's floor of **1,000 window measurements a month**.

The cap now goes to the **least-recently-scored** survivors, so the population cycles.

**Capacity did not move and this is not a capacity change.** `maxScored` is still 7 a run — captain
decision **339a** — because raising it means moving the scoring cap and the request budget together,
and that is a separate decision. Nor did any Stage 1 bar move; loosening the minimum-launches bar is
captain decision **337a** and is its own lane. This changes *which* seven and nothing else, and it
costs **zero in every currency**: `rotation.mjs` reads one local file and the committed run records,
and reaches no vendor.

**The rule, and all three clauses matter** (`rotation.mjs` → `rotationOrder`):

1. A survivor never scored comes first — there is no measurement to refresh, so nothing to wait for.
2. Among the rest, ascending `lastScoredAtIso`. That is `ledger.mjs` → `nextGateBatch`'s shape one
   lane over, chosen for the same reason: draining freshest-first starves the tail permanently while
   every run reports a healthy count.
3. Ties break on the survivor list's own order. So with **no state at all the ranking IS that
   order**, which makes the first run after this change byte-identical to the slice it replaced.

A survivor set that **shrank** costs nothing: rows for wallets this run's gate did not return are
kept and unread, so a wallet that drops out for a day and comes back **resumes its place** rather
than arriving as a stranger and jumping the queue. And an **unmeasured verdict advances the
rotation**, because it consumed the cap and the keyless walk that goes with it — that is not captain
decision 174b's forbidden filter, since nobody is dropped, the wallet keeps its place in the cycle,
and the record still surfaces and counts its verdict.

#### The property this traded, and what buys it back

Before 336a the screen was **stateless**: same inputs, same output, and anyone could re-run it and
reproduce a published result. Rotation makes a run's output depend on every run before it. **The
captain accepted that only on condition that reproducibility be preserved another way**, and that
condition is an acceptance criterion rather than a nicety — a rotation that cannot be reproduced from
committed evidence is not acceptable in this lab. Three things pay for it:

- **The state is committed evidence** — `tools/deployer-screen/rotation/stage2-scored.json`, written
  in sorted key order so two runs over the same state produce byte-identical bytes and a diff shows
  the rows that changed. A file we cannot parse, or one at an unknown `schemaVersion`, **refuses the
  run** rather than starting over: starting over silently returns the cap to the head of the list —
  the repeat this decision removed — while the record still reports a rotation.
- **The run record NAMES the state it read.** Schema 20's `scoringRotation` block carries `statePath`
  (repo-relative), `stateSchemaVersion`, and `stateDigestBefore` / `stateDigestAfter` — the SHA-256 of
  the bytes read and of the bytes written. **Run N's `after` is run N+1's `before`**, so a sequence of
  committed records is checkable end to end.
- **The selection is re-derivable from the record alone.** The block carries `order`, the WHOLE ranked
  survivor list rather than the slice taken from it, and `rotation.mjs` → `verifySelection` replays the
  ranking rule over it — no state file, no survivor list, no clock. Selector and verifier share ONE
  comparator (`compareRotationRows`) so they cannot drift into two rules that merely agree. **The cap
  to hand it is the record's own `scoringCap.max`, the cap that run APPLIED, never
  `thresholds.stage2_entry.maxCandidatesScored`**: a run made with `--score` applies the `min()` of
  the two, so the pinned ceiling would report a perfectly correct run as having selected the wrong
  wallets.

`rotation.mjs` → `REPRODUCIBILITY_RULE` is that condition in one sentence, and it rides on the state
file, the run record and the rendered Stage 2 block for the reason `LANDING_TIP_CAVEAT` rides on a
cost: a caveat that lives only in a document is one a reader of the number never sees.

**The committed state is not hand-written.** `importScoredFromRunRecords` recovers it from
`runs/*.json` — a candidate carrying an `entry` block is one Stage 2 spent its cap on, and the run's
own `startedAtIso` is when — and it runs on **every** invocation rather than once at bootstrap, so a
lost or hand-deleted state file degrades to a slower rotation instead of to a wrong one. It only
ADDS: the state and a run record are two accounts of the same event, and merging them would
double-count on every run.

**`--no-rotation`** keeps the pre-336a behaviour reachable, and the record says so — `enabled: false`
with a `reason`, never the block's absence, so a stateless run can never be read as a rotated one
that happened to repeat.

### Where the fills come from is INJECTED, and Stage 2 names no vendor

Captain decision 260a, 2026-08-05. `stage2.mjs` used to import `readLaunchWindow` and
`windowReachMs` from `pumpfun.mjs` and `readCreateSlotCosts` beside them, which made the swap-api
and the Solana RPC **compile-time properties of a scoring module**. They arrive as a `FillSource`
and a `CostSource` now:

| module | role |
|---|---|
| `fill-source.mjs` | the CONTRACT — `FillSource`, `FILL_SOURCE_KINDS`, the `LaunchWindow` coverage vocabulary, `assertWindowUsable` and `assertMinAgeUsable`. **Imports nothing at runtime**, which is what makes it safe for a scoring module to import, and a test asserts that rather than trusting it. The eligibility guard is the reason a source that cannot read its watermark refuses to be BUILT, at `screen.mjs` → `selectEntryFillSource`: `entry.coverage.minAgeMs` is persisted and rendered as a number, so a non-finite answer would reach a saved record as `null` — a missing gate rather than a refusal — and a written constant would be captain decision 144a's defect verbatim. |
| `cost-source.mjs` | the same for the cost leg — `CostSource`, `TransactionCosts`, `CostWalkResult`, `assertCostWalkAccounted`. |
| `swapapi-fills.mjs` | pump.fun's keyless trade endpoint wearing the contract. **This is what every run reads**, unchanged in every bound, cursor, tripwire and drop rule. |
| `rpc-costs.mjs` | `api.mainnet-beta`/Helius wearing the cost contract. The whole-block probe and its per-candidate latch moved in here, because which route is worth a request is a property of that endpoint. |
| `dune-fills.mjs` | the Dune source. Committed, and **nothing routes through it in a run** — see below. |
| `plan-source.mjs` | the PLAN path's half of the contract (captain decision 286c) — what building a source costs, declared before anything is built, and how a dry run asks for a figure it may not pay for. Reachable from no scoring module. See "The dry run is SPLIT so it can be both free and honest" below. |
| `screen.mjs` | `ENTRY_FILL_SOURCE_KIND`, `resolveEntryFillSource` and `selectEntryFillSource` — the ONE selection site, which 156a already names as the one place both sides meet. |

`stage2.mjs`, `entry.mjs`, `measure.mjs`, `stage0.mjs` and `rank.mjs` import **no source
implementation at all**, directly or transitively, and none of them may read a source kind.

Two consequences are worth stating in full.

**The eligibility gate is now a question asked of the source, and captain decision 257a forces
that independently.** "Has this launch finished happening?" is the vendor's to answer: the swap-api
answers with its own cursor reach (`windowReachMs`, to the millisecond, exactly as before), and a
source whose tables LAG must answer from an observed watermark. This is the third time that
expression has moved and the second time the lesson was the same one — captain decision 144a's
*the defect is writing a DURATION for something someone else controls* — so it is not written down
in a scoring module any more at all.

**Provenance is recorded and read by nothing.** Every window carries `kind`; no bar, gate, rate or
verdict reads it, and the added boundary assertion pins that no scoring module branches on it. This
is captain decision 227a's posture one layer down — the posture `creation.mayhemShare` still holds,
and NOT the per-launch flag itself, which captain decision 351 made an input to the gate's
completion rate (see *"The mayhem-mode flag"* above). Persisting `kind` to the run
record is the schema-bump lane's, not this one's: nothing in a committed record moved.

**What this does NOT claim.** After the cutover a Dune value WILL reach `entry.roomLeft` — that is
the programme, and any account of this change that says otherwise is describing the import graph and
calling it the architecture. What survives is the narrower and stronger property: **no module that
decides anything knows which vendor produced the fills it decides on.** That is the property whose
loss lets a bar drift toward a source, silently and in the invisible direction, since a graded
wallet is filed and never offered again.

### The Dune fill source is committed and nothing routes through it

`ENTRY_FILL_SOURCE_KIND` is `'swap-api'` on every run. The cutover is **Gate 3**, which has not been
convened, and a committed path nobody calls is the correct resting state — the same posture captain
decision 258b states for its committed SQL. `selectEntryFillSource` **refuses** a kind it has no
constructor for rather than falling back, because a run that quietly measured on a different vendor
than it was asked to would report itself complete and be wrong in the one direction nothing
observes.

What `dune-fills.mjs` holds is the row → window assembly and its coverage proof: the boundary is
**observed** by scanning wider than the window at both ends, a scan that never looked older than the
declared mint is refused `coverage-unproven`, the pre-mint tripwire keeps the swap-api walk's zero
slack, ordering is recovered as `tx_index` then `outer_instruction_index` (Gate 1 §5.2 — the obvious
mapping onto `inner_instruction_index` is wrong), rows are sorted by the key before anything is
summed, the venue column is mandatory rather than defaulted, and `priceSol` is **NaN, meaning
unmeasured**, never `0`. It does NOT hold any price or ceiling (255b).

**It now DOES hold the statement.** `ENTRY_SQL` and `ENTRY_QUERY_ID` (saved query **`8235460`**) are
committed there, with `committedEntryQuery()` assembling them into the `DuneEntryQuery` this module
already knew how to read. Committing the text did **not** wire it: `screen.mjs` selects the swap-api
source on every run it can perform today, so `opts.query` is still injected and **absent still
refuses every window**. The one caller that assembles the statement —
`screen.mjs` → `buildDuneEntryFillSource` — is reachable only from the dual-source agreement mode,
which is [gated off](#one-run-two-fill-sources-and-it-agrees-with-itself-per-candidate) and cannot
run. What changed is that the statement has been run against every launch
on the committed tape and now carries the same custody `CREATION_SQL` does — see
[the reproduction](#the-reproduction--the-statement-run-against-every-launch-on-the-tape).

**The three sampling caps are source-scoped, and the Dune source's live in `thresholds.json` →
`stage2_entry_dune`** (6.1.0, the captain's ruling of 2026-08-05). The swap-api walk pays in
**requests** per launch page and the Dune source pays **credits** for windows **scanned**, so one
shared set would have been justified by one cost model and merely *carried* on the other source.
That block holds `maxCandidatesScored` **14** (captain decision 289b), `minLaunchesSampled` 20 and
`maxLaunchesPerCandidate` 22
and nothing else — every evidence bar stays in `stage2_entry` and governs both sources — and, like
`dune-fills.mjs` itself, **nothing reads it until Gate 3**. Its `justification` entries own each
derivation, including why 14 is an **interim** size — it serves the largest per-run survivor count
measured so far (14 of leg B1's, 13 of B2's), while the pooled 27 is sized to today's population and
the terminal size gets derived against the widened discovery pool — and why the floor of 20 makes a
verdict **harder** to reach, not easier. `stage2_entry_dune` is the **single owner** of those three
values: `stage2_entry`'s own justifications point at it and restate none of them, so when 289b's
interim size is superseded that block is the one edit site. A test asserts that neither block's
justification NAMES the other's cost parameters **nor states a QUANTITY in the other's unit** — a
credit figure on the swap-api side, a request figure on the Dune side — while a bare mention of the
other unit, used to disclaim it, is deliberately allowed on both sides. That is vocabulary and
cross-unit figures, not the arithmetic itself — a borrow phrased with neither a banned parameter
name nor a quantity in the other unit would still pass, and the test names that residual itself.

`grade.mjs` builds the same two sources the screen does, so there is still exactly one Stage 2 and
the grader cannot drift from the screen it grades.

### ONE run, TWO fill sources, and it agrees with itself PER CANDIDATE

**Gate 3 precondition 4, 2026-08-06. It is EVIDENCE FOR the cutover and not the cutover** — a
default run is unchanged: `ENTRY_FILL_SOURCE_KIND` is still `swap-api`, `screen.mjs` still selects
it on every run, and every field this section describes is `null` or empty on one.

`--entry-source-agreement` scores every candidate through **both** entry fill sources and records,
per candidate, which one answered it. The shape is the ENUMERATION lane's, reused rather than
reinvented (captain decisions 156a and 191a): a **PRIMARY** source — Dune — whose reading is
recorded where it answered, a **per-candidate fallback** to the swap-api where it did not, and a
sentence on the candidate saying why. `entrySource` is the field, and it is `enumerationSource` one
stage over. `null` there means Stage 2 produced **no score at all**, never "a source that was not
named".

**PER CANDIDATE IS THE WHOLE POINT, AND A PERCENTAGE WOULD NOT SATISFY THE BAR.** Captain decision
143a established on this project that the aggregate form of this question is untrustworthy: **98.4%
whole-window agreement hid a total failure confined to the create slot**, because an aggregate is
dominated by the easy majority. So `entry-agreement.mjs` emits **counts by class and no rate at
all**, the class that can be wrong lives on `candidates[].entryAgreement`, and the run level carries
only the totals with `noAggregateRate` attached to them.

| class | what it means |
|---|---|
| `agreed` | both sources reached a MEASURED verdict and it is the same one |
| `disagreed` | both reached a measured verdict and they differ. **The finding** |
| `only-<kind>-answered` | exactly one reached a measured verdict. **A COVERAGE difference, NOT a disagreement** |
| `neither-answered` | neither did. Says nothing about either source and nothing about the deployer |

"Answered" is `entry.mjs` → `isDeployerAttributable`, which is captain decision 174b's predicate
rather than a second expression that merely agrees with it. **A source that returned
`entry-unmeasured` did not disagree — it said nothing**, and every producer of an unmeasured verdict
is our own coverage. Counting one as a disagreement would make the comparison read worse the more of
our own budget ran out; counting it as agreement would make it read better. The classifier therefore
checks the answered COUNT before it compares verdicts at all: the other order reports `agreed` for
two identical `entry-unmeasured` values, which is a screen agreeing with itself about having
measured nothing.

**BOTH SOURCES SCORE AT ONE RECIPE — `thresholds.json` → `entry_source_agreement.recipeBlock`, which
is `stage2_entry`.** The two sources carry deliberately different sampling caps, so scoring each at
its own would make a disagreement uninterpretable: a candidate could differ because the fills
differ, or because one reading needed 20 scored launches and the other 8. That is a comparison of
two RECIPES wearing the clothes of a comparison of two TRANSPORTS. `stage2_entry` is the only one of
the two blocks the swap-api source can afford, which makes the choice forced rather than picked —
and holding it fixed is also what keeps `grade.mjs` → `REQUIRED_ENTRY_RECIPE` reading back the caps
that were actually applied, which is the hazard `stage2_entry_dune`'s block comment files against a
Gate 3 wiring. **The cost of that choice runs against this lane and is stated rather than buried:
the Dune source is exercised at a sample SMALLER than `stage2_entry_dune` sizes it for, so this run
says nothing about whether 20-of-22 is affordable or reachable.**

**The entry-cost leg runs once PER SOURCE, and that is deliberate.** Sharing a priced-transaction
cache between the two readings would make their costs identical by construction and hide a cost-leg
divergence inside a result that looks like agreement. It roughly doubles this leg's Solana RPC,
which costs wall clock against a keyless host and nothing else.

**It spends Dune credits inside Stage 2, which no other mode does, so the flag is not enough on its
own.** `entry_source_agreement.active` must also be true and it is **false** today — captain
decision 298a puts a Dune spend behind an explicit approval rather than behind one flag. Two further
things must land before any such run can start, and both are captain decisions:

1. **`dune-fills.mjs` → `TRADE_COVERAGE_QUERY_ID` is `null`.** `TRADE_COVERAGE_SQL` is committed and
   the saved query holding the identical text has not been deployed. The Dune fill source **cannot
   be built without it**: eligibility on that route is an OBSERVED watermark (captain decision 257a),
   the enumeration's probe bounds the CREATE tables and says nothing about when the TRADE tables hold
   a launch's fills, and writing a lag constant instead is captain decision 144a's defect verbatim.
   See "Deploying a change to the committed SQL" for the step.
2. **The spend is approved.** `measurements/2026-08-06-dual-source-agreement-estimate/` prices the
   run against a balance read from `POST /usage`, states the arithmetic term by term, and records
   that the proposed 7-candidate shape does **not** fit in what was left of the 2026-07-29 →
   2026-08-29 period. Cite that document rather than restating its figures; the balance moves and it
   says so itself.

Until all three land the mode refuses with a sentence naming which one is missing, and **nothing is
requested and nothing is billed**.

**AND TWO GUARDS RUN BEFORE THE FIRST BILLED REQUEST, because neither did when this mode was first
committed** (captain decisions 317a and 318a, 2026-08-06):

1. **THE MONTHLY CREDIT ALLOWANCE, read LIVE, and RESERVED for the whole run.** `screen.mjs` →
   `buildDuneEntryFillSource` prices this leg through `dune-fills.mjs` → `tradeFillSpendPlan` and
   refuses through the **same** `client.mjs` → `decideAllowance` every other keyed lane uses,
   **before the trade-table coverage probe**, which is this leg's first billed request. As first
   committed it built its client and went straight to that probe, and the run's only allowance check
   belonged to the enumeration leg, downstream and priced against a different plan.

   **The balance is read ONCE PER RUN and every spending leg draws on one reservation** (captain
   decision 320a). `dune.mjs` → `openDuneCreditLedger` holds what each cleared leg may spend, so the
   Stage 1 enumeration is priced against what is left after Stage 2's entry source was approved.
   Before it, the two legs each read `POST /usage` and each decided alone — two verdicts from the
   same reading can both say "this fits" while their combined worst case does not, which is
   time-of-check-to-time-of-use and is the thing this tool's own rule (*a balance reading is never a
   reservation*) warns against. One mechanism, not two guards taught to subtract each other.

   **A run is charged for the windows it PLANS, not for the ceiling it is permitted** (captain
   decision 321a). `agreementExecutionsFor` derives `windowsPlanned + probe + headroom` executions,
   capped by `maxExecutionsPerRun`, and the same figure bounds the client — so what the leg may issue
   and what it was approved for are one number. Priced at the ceiling instead, `--score 2` was
   refused identically to a full run, which is the reduced-scale option the estimate artefact
   recommends; under a fixed monthly Dune budget that is the normal operating mode rather than a
   fallback. The error still runs toward refusal: every window is charged the busiest window this
   repo has ever measured.

   **AND THE MANDATORY LEG RESERVES FIRST, BY RULE RATHER THAN BY CONTROL FLOW** (the pre-Gate-3
   hazard round of 2026-08-06, closing a finding of PR 65's review). 320a made both legs draw on one
   reservation; it did not change which of them reserved FIRST, and the control flow had the wrong
   one there — this leg was built whole inside `runEntrySourcePlan`, which runs before Stage 1
   enumerates.
   So the EXPENSIVE OPTIONAL leg billed its coverage probe, the CHEAP MANDATORY enumeration was then
   priced against what was left, fell back to the RPC walk, and `priceWalkFallbackCliff` refused the
   whole run at exit 2 **before its first walk request** — billed, and with nothing produced. Under
   the captain's Dune account controls (extra credits capped at $0, so the vendor refuses at the
   ceiling rather than billing past it) that is an **availability** loss rather than a money one, and
   a consumed period is candidates that cannot be checked at all. `dune.mjs` → `DUNE_LEG_ORDER`
   states the order — `enumeration`, then `entry` — and `openDuneCreditLedger` refuses a leg whose
   predecessors have not SETTLED, **before the free balance read**, let alone a billed one. A leg
   that will not spend (`--no-dune`, `--ownership-only`, no credential, or a dry run, which
   enumerates nothing) must say so with `declineToSpend`: being quietly skipped leaves the legs
   behind it blocked, which fails towards refusing. A leg handed no ledger is the SOLE leg by
   definition and queues behind nothing, so every single-leg path is byte-identical.

   **AND `--no-dune` / `--ownership-only` NOW BIND THE FILL SOURCE TOO, WHICH IS THE SAME DEFECT ONE
   FLAG OVER.** Those two declare something about the WHOLE RUN, but they were only ever checked
   against `--entry-source-agreement` — the one thing the Gate 3 cutover does not touch. Move
   `ENTRY_FILL_SOURCE_KIND` to `dune` and a `--no-dune` run with a usable credential proceeds, builds
   its own Dune client inside the registry, bills the trade-coverage result read and then one
   execution per window, having declared it would reach no Dune surface — and files a record saying
   `dune.used: false`. `screen.mjs` → `duneFillSourceContradiction` asks the SAME
   `entrySourceKindsRead` derivation and **refuses rather than suppressing**: dropping the fill
   source would silently discard the source Stage 2 was configured with, while honouring it would
   spend credits the operator believes they have forbidden, so the message names both asks and says
   which to drop. It is checked in TWO places for the reason the agreement flag already is —
   `parseArgs` holds the CLI contract and can answer the cutover's single-source case from a module
   constant without reading `thresholds.json`, and `main` holds the half that can see the pinned
   `primarySource`/`crossCheckSource`. **`--no-dune`, `--ownership-only` and `--no-stage2 --no-dune`
   are unchanged and still valid**: at today's `swap-api` kind the derivation never names Dune, and
   with Stage 2 off it returns no source at all, so the guard is inert on every configuration
   reachable today and arms itself at the cutover.

   **`--stage0` IS FOLDED INTO THE DERIVATION, AND THAT FOLD IS A CORRECTION TO THIS GUARD'S FIRST
   CUT RATHER THAN A REFINEMENT OF IT.** `--stage0` sets only `stage0Only` and leaves `stage2` true,
   so as first written the guard would have refused `--stage0 --no-dune` and `--stage0
   --ownership-only` at the cutover — a mode whose own usage text promises "No network, no key, no
   quota. Always safe." — while `main`'s copy of the same guard, which sits below the `stage0Only`
   return, let the combination through. Two places, one rule, two answers. The fix is in
   `entryFillSourceIsRead`, so a Stage 0 run reads no source and the guard is inert for it with no
   special case at either call site; putting the exemption at the call site instead would have
   reintroduced exactly the beside-a-flag duplication this whole section exists to remove.
   **`--dry-run` is deliberately NOT folded, and the difference is structural**: a `--stage0` run
   returns before the plan is built, while a dry run reads no source but PLANS one — `planEligibility`
   gates on the same predicate, so folding `--dry-run` in would stop the plan describing its own
   source and regress captain decision 286c. A test pins that the dry-run plan still names it.

   **AND ORDERING THE RESERVATIONS DOES NOT ORDER THE SPEND, SO THE CONSTRUCTION IS SPLIT IN TWO —
   TWO PROPERTIES, AND NEITHER MAY LOSE.** A ledger can hold a leg until its predecessors have
   *settled*; it cannot hold one until they have *answered*. With the whole construction still above
   Stage 1, a run could clear both legs against one balance, bill this leg's coverage probe, watch
   the enumeration come back empty for any of the four reasons the cliff treats alike — a refused
   coverage probe, an unreadable row, a failed execution, a refused allowance — and be refused whole
   at exit 2 anyway. So `screen.mjs` builds the entry source in two phases:

   - **PROPERTY 1, and it is what the early phase buys**: a run whose Stage 2 fill source cannot be
     RESOLVED refuses BEFORE the MadeOnSol seed enumeration is spent, and so does a plan that does
     not fit the window ceiling. `runEntrySourcePlan(..., { constructionPhase: 'free-only' })`
     resolves every kind the run will read — so an unknown kind, or a registration disagreeing with
     its own key, still refuses there, and resolution touches no vendor — checks the ceiling, and
     builds only the constructions the registry DECLARES free. On a default run that is the swap-api
     and therefore all of them, which is why a default run is byte-identical and still proves its
     eligibility gate before Stage 1.

     **The Dune CREDENTIAL is checked in this phase too, precisely because the answer costs
     nothing.** That construction is declared billed, so the free phase would otherwise defer it
     wholesale and a run with no usable `DUNE_API_KEY` would spend the entire seed enumeration
     before refusing — on a configuration where the seeds buy nothing at all, since `usingDune` is
     false there too and the enumeration is skipped with no leg attempted and no cliff priced.
     `screen.mjs` → `duneFillSourceCredentialRefusal` is that rule, written once and asked twice:
     the free phase asks it, and the constructor keeps asking it as the backstop for a caller that
     never went through the free phase. The free phase does not re-derive *which* sources a run
     reads either — it reads the same `entrySourceKindsRead` answer the window ceiling and the
     `--no-dune` refusal use, so `--stage0`'s fold reaches it for free.

     **READ THE SCOPE, NOT THE HEADLINE: what remains is NARROWER than what the unsplit construction
     gave, and the narrowing is the trade.** The three failures that can only be learnt by REACHING
     the vendor — an undeployed coverage probe, a refused allowance, an unreadable watermark — now
     refuse at `completeEntrySourcePlan` with the seed requests already sunk, where before the split
     they refused ahead of them. That construction also BILLED the coverage probe ahead of them,
     which is exactly the hazard PROPERTY 2 removes, so the two cannot both be had. What was traded
     away is a few seed requests on an already-doomed run; what was bought is that the billing period
     is not consumed by a run that then produces nothing.
   - **PROPERTY 2, and it is what the late phase buys**: the OPTIONAL BILLED leg only bills once the
     MANDATORY leg has ANSWERED. `completeEntrySourcePlan` builds whatever the early phase deferred —
     the billed constructions, and the UNDECLARED ones, which are treated as billed for captain
     decision 286c's fail-safe reason — after the enumeration and after `priceWalkFallbackCliff`, and
     still ahead of the gate loop and Stage 2. Its refusal reads *"Refusing to score"* and does NOT
     claim that nothing was spent, because by then the seeds are sunk and the enumeration has been
     billed for its probe read; the record is written for the same reason the cliff's is.

   **`DUNE_LEG_ORDER` IS KEPT BESIDE THIS DELIBERATELY.** It is now belt-and-braces with the control
   flow rather than the only thing holding the order, and it is the half that survives a future
   reordering of these blocks. Both directions of both properties are driven through `main` over a
   stubbed transport in `test/dune-credit-ceiling.test.ts`; `main`'s `seam.entryFillSourceKind` is
   what makes a Dune-selected run reachable from a test at all, since the constant is Gate 3's own
   edit.

   The balance itself is pinned nowhere, and the three limits that travel with it — the counter lags,
   the key is shared, the period is a subscription anniversary — are the `dune` block's and
   unchanged. A ledger makes one RUN self-consistent; it reserves nothing against a sibling lane.
2. **THE WINDOW CEILING now binds.** `entry_source_agreement.maxWindowsPerRun` was reported by the
   run record as a ceiling and enforced by nothing; the only thing that stopped a window was the
   client's `maxExecutionsPerRun`, and a cached coverage probe costs no execution, so 82 windows
   could run against a ceiling a saved record called 80. `screen.mjs` → `assertAgreementWindowsFit`
   refuses a plan whose `stage2_entry` `maxCandidatesScored × maxLaunchesPerCandidate` exceeds it, on
   both the plan and the run path, before a source is constructed. **The 80 and the 82 stay
   deliberately unequal** — `82 = 80 windows + 1 probe + 1 headroom`, and that inequality is the
   derivation; the block's `justification` owns it. At today's caps (7 × 10 = 70) it is inert, which
   is what a backstop is: it bites the moment a sampling cap is raised without re-pricing this leg.

   **AND IT GATES ON READING THE DUNE SOURCE, NOT ON THE AGREEMENT FLAG** (the same 2026-08-06 hazard
   round; no value moved). Both the ceiling check and the window count the leg is PRICED on were
   gated on `--entry-source-agreement`, which is the one thing the Gate 3 cutover does not touch: it
   moves `ENTRY_FILL_SOURCE_KIND` to `dune` and arms this leg with no flag in sight. The count would
   have stayed **0**, so `agreementExecutionsFor` would have bounded the client and priced the
   allowance at *the probe plus headroom* for a leg intending `maxScored × maxLaunchesPerCandidate`
   windows — the allowance clears the small plan, the probe is billed, and the run then dies on
   `CeilingReached` mid-flight. That is captain decision 144a's defect in the place it costs most: a
   guard denominated in the variable that does not move at the moment the thing it guards starts
   happening. `screen.mjs` → `entrySourceKindsRead` is now the ONE derivation of which sources a run
   reads — built on `entryFillSourceIsRead`, so "no source at all" and "no Dune source" cannot
   disagree — and the ceiling check, the priced count and the run's own construction all read it.

### What is still open here, and is Gate 3's

Neither of the two guards above can fire on a default run today, and that is the resting state: all
three gates named at the top of this section stay shut and this round opened none of them. What has
**never been exercised against the real vendor** is the Dune fill source itself — the probe, the
per-window executions, the ordering under a live balance. The tests prove the guards through stubbed
transports and committed fixtures; the first run that ever reaches Dune inside Stage 2 is Gate 3's,
and it is the run these guards were closed ahead of.

### The reproduction — the statement run against every launch on the tape

**Gate 3 precondition 1, 2026-08-05.** `node tools/deployer-screen/dune-reproduction.mjs` runs
`ENTRY_SQL` against all **235** launches the committed population tape proved coverage for and
compares the result — through `duneRowsToWindow` → `measureLaunchEntry` → `verifyFieldReproduction`,
the production functions, not a re-implementation — against the dataset's own `wallet_launch_pnl.csv`.
That is what promotes the statement from a claim to **the measurement**, which is why it also gains
the custody `CREATION_SQL` has. The record and the long form are
[`measurements/2026-08-05-dune-entry-reproduction/`](measurements/2026-08-05-dune-entry-reproduction/README.md);
`test/dune-entry-reproduction.test.ts` asserts it. Cite them rather than restating the figures.

**235 of 235 measured, 0 create-slot disagreements, 0 launches short, 10,476 PumpSwap fills across
the 18 graduation-spanning launches — exactly the tape's own — 0 closure mismatches over all 1,322
pairs, and a max realised error of 5.000e-7 SOL, which is the IDENTICAL figure the tape-sourced leg
produces.** Not "inside the bar": the same number.

Four things a lane touching this should know, and the last two are the expensive ones:

- **Custody precedes the spend, and the assertion that says so is shown FAILING.**
  `custodyOrderVerdict` is a predicate over a recorded call log, and the test drives it twice — over
  the production runner, and over a deliberately execute-first runner built from the same two
  primitives, where it must refuse. An assertion that cannot fail is the defect this repo keeps
  finding.
- **The AMM half reads the decoded program events, and that was MEASURED rather than chosen.** The
  first whole-tape run read `pumpswap_solana.base_trades` — dex_solana's model, a view over a
  backfill that inner-joins each swap to a matching SPL transfer and drops the ones that do not
  match — and got **5,444 of 10,476** AMM fills, 48% short, on all 18 launches, while missing zero
  curve fills. `pumpdotfun_solana.pump_amm_evt_buyevent`/`sellevent` have no such join. The quote
  column is the `user_` one: it matched the tape on 198 of 198 fills of one launch where
  `quote_amount_in` and `quote_amount_in_with_lp_fee` matched none.
- **The tape is what the chain disagrees with, on 658 of 107,439 fills.** Twenty-two of them reach a
  graded pair; all twenty-two were arbitrated with `getTransaction`, and the wallet's own balance
  change agrees with the statement on 22 of 22. **Captain decision 293a judges the bar over the
  1,310 pairs the chain does not refute**, on three standing conditions this suite already meets:
  the exclusions stay enumerated by transaction in `REFUTED_REFERENCE_PAIRS`, the unexcluded reading
  (1.842 SOL) stays printed beside them, and closure stays checked over the whole 1,322 — where it
  is 0, so no exclusion does any work on that half of the bar. **294a ratifies correction 11 in that
  dataset's `IMPORT.md` as filed; no dataset row was edited.**
- **A pump.fun launch can be quoted in something other than SOL, and this repo had not met one.**
  `maxxing` `97nnzgv9…` — the second of the two launches sharing that symbol — is USDC-quoted: all
  384 of its fills return `sol_raw = 0` because the `SwapEvent`'s SOL amount is genuinely zero, while
  the trade endpoint reports a SOL-equivalent valuation. Neither source is wrong; they are different
  quantities. It contributes no closed create-slot outsider pair, so nothing published rests on it —
  **luck, not design**, and a lane scoring such a launch through the Dune source would read those
  zeros as free entries. **Captain decision 295b files that guard against the Gate 3 CUTOVER rather
  than against the statement or this suite**, so it is recorded here and enforced nowhere: do not add
  a quote-mint filter on the way past.

**Spend.** The whole-tape run costs **~495 credits** of a 2,500-credit shared month, and **~95% of it
is result bytes** rather than compute — which inverts the assumption `stage2_entry_dune` reasons
from, without contradicting it: that block returns one aggregated row per launch and this statement
returns every fill. `--rows` caches what was paid for and `--from-rows` recomputes the comparison
offline, because the first run threw its rows away and a correction then cost a second full fetch.

### The dry run is SPLIT so it can be both free and honest

Captain decision 286c, 2026-08-05. Captain decisions 281a/284a/285a made the plan report the
eligibility bound the **selected** fill source actually applies, rather than re-deriving it locally
and claiming the two were one number. That is what makes the plan honest, and its cost arrives with
it: asking a source anything means the source must EXIST, and `dune-fills.mjs` cannot be built
without the trade tables' own coverage assessment — captain decision 257a's observed watermark —
whose result read is **billed**. So from the Gate 3 cutover a Dune dry run could only

- **spend**, and `--dry-run` stops costing nothing, which is the one thing an operator runs it to
  find out; or
- **throw**, and `--dry-run` stops always showing the plan, withholding a page of free and correct
  figures because one line needs a purchase.

The captain refused both. `plan-source.mjs` is the split:

| what | where |
|---|---|
| SELECTION, with no network call | `screen.mjs` → `resolveEntryFillSource`. It resolves a registration — data — and refuses an unsupplied kind exactly as `selectEntryFillSource` always did. `selectEntryFillSource` is now that plus the `build()` a run wants whenever it will READ the source — see "AND THE RUN PATH NOW GATES ON THE SAME CONDITION" below for when it does not. |
| CONSTRUCTION, only where it is free or authorised | `plan-source.mjs` → `planEligibility`. The default plan never calls a billed constructor, and a test drives it with a stub whose constructor fails the test if it is ever reached. |
| the figure it could not have | printed as **UNAVAILABLE**, naming the source and the reason, by `plan-source.mjs` → `eligibilityUnavailableNote` — one wording, used by both plan surfaces, so they cannot drift and so a change degrading it into a blank or a zero has to delete the function. It hands out **PRE-WRAPPED LINES** at `PLAN_NOTE_WIDTH`, and the wrapper is not exported: a consumer indents what it is given and cannot choose a second width, so a printer added later inherits the layout instead of enumerating itself into a guard. |
| the spending plan | `--dry-run-spend`, with `--dry-run` only. It states the **bounded** spend before spending and the **actual** after; the order is a property of `planEligibility` rather than of the caller's memory, and the actual is reported in a `finally`, because a construction that failed half-way still spent. **A cost that cannot be READ is a stated absence, never a propagation** — a real billed source reads its actual out of the transport's own counters (Dune's credit accounting), and a rejection thrown from that `finally` would replace the whole plan's outcome and hand the caller a refusal, i.e. the money gone AND the page withheld. So `actualSpend` never throws: it prints that the spend was made and what it cost could not be read, which is an UNKNOWN and not a zero. |

**Every claim on that page that was measured on ONE source is labelled with it, and is UNAVAILABLE
under another** (standing ruling 285a). The request line was only the first: the host name in the
Stage 2 header, the pages-per-launch distribution (p50 6 / p90 8 / p95 9 / max 17 over the 127
committed launches), the ~25% shed rate the pacing floor was sized against, the typical wall clock
that multiplies that median, and the cursor reach are **all swap-api measurements**. Under another
source each prints through `plan-source.mjs` → `sourceFigureUnavailableNote` — the same vocabulary,
the same three refusals and the same **PRE-WRAPPED LINES** at `PLAN_NOTE_WIDTH` as the eligibility
note, naming the source the figure was measured on, so here too a printer indents what it is given
and cannot choose a width — and **none is replaced by an invented figure for the selected source**: no Dune pacing, shed rate or
page cost has been measured, and a plausible number is worse than an absence. The ceilings, worst
cases and caveats are arithmetic over pinned thresholds and print in both cases, because withholding
them is the failure the split exists to avoid.

**KNOWN RESIDUAL, recorded rather than rewired — trigger: the Gate 3 cutover.** The Stage 2 figures
that keep printing under every source — the stage keyless ceiling, the pacing floor, the request
worst case and the wall clock derived from that floor — are bounds this stage enforces on its **own
keyless client**. They are correct today only because the fills come from a keyless HTTP client; a
Dune fill source would issue executions and credits and would not be governed by that client at all.
They must stay on the page regardless (a plan must always be complete), so what is owed at the
cutover is the same `measuredOn` labelling the page distribution, shed rate, pacing justification and
typical wall clock already received, plus whatever bound the Dune source's own transport enforces in
their place. Owner: whoever lands Gate 3. `render.mjs` → `renderDryRun`'s Stage 2 block carries the
same note in place. `sourceFigureUnavailableNote`'s closing sentence was narrowed for exactly this
reason: it used to claim those bounds "bind whichever source answers", which is more than it can
know.

**WHICH REFUSALS SURVIVE, AND THE DISCRIMINATOR IS WHETHER MONEY WAS SPENT.** A construction can
fail, and what that failure already cost decides whether it stops the plan:

- **Nothing was spent** — the kind is unsupplied and this run carries no constructor for it, a FREE
  construction could not be built, or a billed one had no authorisation and so was never built at
  all. The refusal STANDS: `screen.mjs` prints `Refusing to plan: Stage 2 has no usable fill source`
  and exits `7`. It cost nothing, and a plan that quietly omitted its own subject would be worse
  than a stated refusal.
- **An authorised spend was MADE and the construction then failed** — the refusal does NOT stand.
  Propagating it would take the money *and* withhold the page, which is both of the outcomes 286c
  refused arriving together, so the promise that a dry run always shows the plan binds harder.
  `planEligibility` degrades to `known: false` carrying the failure as its `why` and marked
  `spent: true`; the `finally` still announces what it cost — or that the cost itself could not be
  read — the banner says the spend was made and the construction failed, and the eligibility line
  prints UNAVAILABLE naming the failure.

**Only a plan that will PRINT the figure may buy it.** The eligibility floor is rendered inside the
Stage 2 block and nowhere else, so `--no-stage2` consults no source at all and `entryEligibility`
arrives as `null` — a third state meaning *not asked*, distinct from *asked and refused*. The banner
says so in those words rather than claiming the construction was free, which is not something that
page found out. Otherwise the `--no-stage2` plan is unchanged.

**AND THE RUN PATH NOW GATES ON THE SAME CONDITION — the residual 286c filed against the cutover is
CLOSED, and it is closed BEFORE the cutover on purpose.** 286c's review found the identical exposure
one level over: the run path built its source unconditionally, outside any `--no-stage2` guard, while
the source and its floor were consumed only inside the block that scores candidates. Under a billed
construction `screen.mjs --no-stage2` would have run the billed coverage probe for a source it never
reads, and would have refused the whole run (exit `7`) — gate, enumeration and record all lost — for
an unbuildable source Stage 2 was never going to use. It was correctly **not** fixed in that lane,
whose intent had frozen the run path; the reason it is fixed now rather than at the cutover is that
**nothing routes through the Dune fill source today, so the first run that ever exercises it is the
one that would pay.**

**One mechanism, not two patterns.** `screen.mjs` → `entryFillSourceIsRead` is the single predicate
both paths ask — *will this run read an entry fill source at all* — written once because two
expressions that merely agree is captain decision 144a's defect and is exactly how the run path came
to sit outside a guard the plan path already had. The run path's half is `screen.mjs` →
`runEntrySourcePlan` (with `runEntryFillSource` the single-call form of both of its phases, kept as
the seam a test substitutes a registry through): it returns `null` when Stage 2 is off, having
touched no constructor, and otherwise builds, asks and guards exactly as before — since the
2026-08-06 hazard round, across the two phases described under "AND ORDERING THE RESERVATIONS DOES
NOT ORDER THE SPEND" above. It is **not** `planEligibility` and must never
become it — a plan refuses to build a billed or undeclared construction, a run builds both, and the
existing source-text pins say so. Stage 2's own block is then guarded by `entryFillSource !== null`
rather than by a second reading of `opts.stage2`, so constructing and scoring are one decision.
Stage 2 enabled is byte-for-byte unchanged, and it still reads the swap-api: **this is not the
cutover.**

**AND THE CONSTRUCTION SITS BELOW THE CREDENTIAL REFUSAL, WHICH IS THE SAME INVARIANT ONE CONDITION
OVER.** Only a run that will actually READ the source may build it — and a run whose MadeOnSol
credential does not resolve screens nothing, so it reads nothing. Built above that refusal, a Stage 2
run with no credential would pay the billed coverage probe and then return `EXIT.credentialMissing`
having measured nothing, or refuse with `EXIT.upstream` and hide the credential message behind a
complaint about a source it was never going to reach. No source consumer sits between the two points,
so the fix is the ORDER, and the order is what a test pins: `--no-stage2` is the flag half of the
invariant and the credential is the state half. Unreachable today for exactly the reason the
unconditional construction was — every registered construction is free while `ENTRY_FILL_SOURCE_KIND`
is `swap-api` — which is the same pre-cutover window and the same reason to close it now.

**An undeclared construction is treated as billed, never as free.** A registry entry that says
nothing about what building it costs is an absence, and reading an absence as a benign value is the
failure this repo names in three other places (`covered.fromMs` of `0` read as a 56-year window;
`bonded` absent read as "did not bond"; a wallet with no enumeration row read as zero launches). It
is never built by a plan, **including under the opt-in** — there is no bound to state first, and a
spend that cannot be bounded first is not an authorised spend. **The banner reads UNKNOWN there, not
"costs nothing"**: under the opt-in it is split by what the figure itself records rather than by the
flag — the authorised spend that was made, the billed construction that was not authorised, and the
undeclared one, which says in place that nothing can be said about what building it would have cost.
A benign default in that last branch would be the same absence-read-as-a-value one line above,
contradicting the UNAVAILABLE the eligibility line on the same page prints.

**286c left the RUN path alone; it has since gated on the same condition** — "AND THE RUN PATH NOW
GATES ON THE SAME CONDITION" above owns that, and what survives from 286c is the other half: a run
that READS its source builds it and pays whatever that costs, because it was always going to reach
that vendor and the eligibility answer is an input to a measurement rather than a line on a preview.
The census (`bundling.mjs`) routes its plan through the same helper and declares its source free — it
is keyless throughout, captain decision 173a's property of the tree — so it ships **no** spending opt-in rather than one that could only ever be inert. That declaration
is a second copy of `screen.mjs` → `SWAP_API_CONSTRUCTION` and **must stay one claim**: the census
may not import the screen (that would put the Dune client and the credential reader in its import
graph), so `test/bundling-census.test.ts` imports both and fails the build if they ever differ. A
stale copy still claiming "free" would silently permit a plan-time spend, which is the one door a
declaration cannot close.

**What the split does NOT claim.** Nothing routes through the Dune fill source until Gate 3, so no
part of this has been exercised against the real source and it must not be. The default free path is
proven with a stub constructor; the opt-in path is proven by what it announces, not by letting it
spend.

### 1. Entry room

How much of the opening window the deployer and its own wallets take before anybody else is filled:
`(dev buy + co-ordinated stake) ÷ (dev buy + all create-slot stake)`, and `1 −` that is the room.
This is the method of `slot-zero-june-regime-change/report.md` §5.1, the quantity that decided the
2026-06-04 finding.

**The framing to keep is the captain's, because they arrived at it independently: this measures how
badly configured the dev's own launch bot is.** A bot that leaves the bottom of its own curve to
strangers is a bot with room in it. A bot that takes it all has won the race before anyone else has
had a chance to run it, and there is nothing to enter.

Who counts as "the operation" is derived **structurally, with no wallet list and no prior
knowledge**, by the **union of two tests** (captain **decision 182a**):

- **(a) shared transaction** — a create-slot transaction carrying two or more distinct swapping
  wallets is a bundle, and every wallet in it is co-ordinated. Independent traders cannot share a
  transaction.
- **(b) the deployer-anchored contiguous block-index run** — sorted by the block transaction index
  pump.fun's `sid` encodes, the transactions forming a run at step exactly 1 through the deployer's
  own curve buy are one submission, and every wallet in that run is co-ordinated. A Jito bundle
  lands as an atomic contiguous sequence and no outsider can insert a transaction into it.

Needing no wallet list is what makes the method applicable to a stranger at all. **Half (b) costs
nothing** — `sid` is already on every fill the walk parses, so there is no request, no host and no
vendor quota behind it.

**How much of the operation half (a) recovers on its own is the operator's submission habit on the
day, not a property of the rule.** Measured against the known six-wallet cohort on our own subject,
by month: **0% in December 2025 – February 2026, 41.6% in March, 69.9% in April, 97–100% from May
onwards.** The earlier claim here — that the rule recovers the cohort, full stop — is true of the
May–July slice it was written against and false of the tape as a whole. **That range is what half
(b) closes**: over the whole tape the union recovers **1,140 of 1,140** cohort wallet-instances,
against 960 for (a) alone and 1,083 for (b) alone. The two are **complementary, not nested** —
(a) catches a second bundle sent later in the same block that an anchored run cannot reach (57
instances over 14 launches), (b) catches the months when the operation co-ordinated by adjacency
and never shared a transaction.

**Half (b) was disconfirmed before it was believed.** Adjacency between create-slot transactions
*outside* the run runs at **12.35%**, which predicts ~25 of the tape's 201 runs-with-a-boundary
should have swept in an outsider; **one did**, and half (a) already marks the same two wallets for
sharing a transaction with each other. The run does not end at an arbitrary cut either — the gap to
the next create-slot transaction is a median of **108** indices. Widening the step to ≤ 2 or ≤ 3 buys
9 and 15 more marks and doubles the false marks, so strict contiguity is what ships.

**UNION, NEVER REPLACEMENT — and that is the safety property, not a preference.** (a)'s marked set
is a subset of the union's by construction, so `operationShare` can only rise and `roomLeft` can only
fall against the older reading. A wider rule cannot manufacture a false accept on a launch that was
already being scored. The direction is pinned as a property test over the whole committed tape
rather than argued for in prose.

**What it does NOT do.** It does not rescue a deployer that co-ordinates without Jito, or one that
accumulates in the slots after the create slot — 6 of the census's 11 never-bundling candidates stay
correctly unproven, which the union re-run has since measured rather than projected: `runTx` 1 on
48 of 48 of their windows. That figure is
[`census/2026-08-03-bundling-census.md`](./census/2026-08-03-bundling-census.md) §2.4, recomputable
from the committed record `census/2026-08-03-bundling-census.json` (schema 2) by reading `runTx` off
the `launches[]` rows of those 6 candidates. And whether an adjacent transaction is a true bundle or merely the leader's
packing order is an **inference**: nothing keyless exposes a bundle id. The arithmetic is unaffected
either way, but this marks adjacency, not a decoded bundle.

#### A create slot NEITHER half marks is UNPROVEN, and unproven launches are not scored

**A create slot the co-ordination rule marks nothing in is observationally identical to a create slot
with no co-ordination.** The rule found nothing either way, and nothing in the fill tape separates
the two. Reading it as the second — which the screen used to do implicitly — books the operation's own
stake as outsider capital, and on the affected launches of our own tape that is **9.6–10.0 SOL per
launch** moved out of the numerator and into `independentSol`. It lowers the operation's share and
raises room twice over, once in each term.

**The rule's errors therefore run, in the direction that matters, exactly one way: a mark it misses
makes a deployer look more enterable than it is.** The opposite error — marking a wallet that is not
the operation's — stands differently on each half of the union, and conflating the two is the mistake
to avoid:

- **Half (a) — rare and era-dependent, not impossible.** Only wallets that *provably* shared a
  create-slot transaction are ever marked here, and traders acting alone do not arrange that for
  themselves — but a third party can put two strangers in one transaction, and on this tape one
  bundling-shaped wallet does: **11 non-cohort marks over 3 era-1 launches**, the settled outsiders
  among them. `measure.mjs` → `roomIsProven` owns the claim and
  [`census/2026-08-04-proof-coverage-probe.md`](./census/2026-08-04-proof-coverage-probe.md) →
  "Incidental finding" owns the figures. The direction is the safe one: a mis-marked outsider raises
  `operationShare` and lowers `roomLeft`.
- **Half (b) — empirically bounded, not structural.** The deployer-anchored block-index run is an
  **inference**: whether an adjacent transaction is a true Jito bundle or merely the leader's packing
  order is not observable, because nothing keyless exposes a bundle id. What bounds it is
  measurement, quoted here at the point of the claim rather than only in the section above:
  coincidental adjacency among create-slot transactions *outside* the run runs at **12.35%**, which
  predicts ~25 of the tape's 201 runs-with-a-boundary should have swept an outsider in; exactly
  **one** did, and half (a) already marks those same two wallets for sharing a transaction with each
  other.

**The direction of error stays structural, and that is why an empirically-bounded half is acceptable
inside this union.** (a)'s marked set is a subset of the union's by construction, so `operationShare`
can only rise and `roomLeft` can only fall — pinned as a property test over all 235 committed
launches. A false mark from half (b) therefore costs a launch its room reading in the
**conservative** direction only: it can lower room, never raise it.

Captain **decision 134a**: do not score those launches. Call the opening **unproven** rather than
measured. A launch neither half marks anything in contributes **no room figure, no
field entrant and no round trip**; `measure.mjs` → `roomIsProven` is the predicate and
`entry.mjs` → `scoreEntry` applies it before anything is computed. A candidate left with fewer
proven launches than `minLaunchesSampled` scores `entry-unmeasured` — never `entry-open-after-costs`,
and never folded in with a refusal, which are different findings.

**What the refusal cost, and what decision 182a bought back.** Replaying the live recipe — median
room over the trailing `maxLaunchesPerCandidate` launches against the 0.55 bar — at all **226**
points of our own tape's history: refusing removes **22 of 22 false-positive windows and creates
none in the other direction**. Under half (a) alone that cost **62 windows that became unmeasured**
rather than wrong, and per launch it took **60 of the 235 covered launches (25.5%)** out of every
score. Under the union it costs **0 windows and 0 launches**, with false positives still **0**.
Nothing was relaxed to get there — decision 134a's refusal and every evidence bar are untouched —
the rule simply sees more, so it refuses less. (Every one of those counts is a property of the
replay's window width, which is `maxLaunchesPerCandidate` — see
[the rolling replay](#the-rolling-replay--the-same-question-asked-at-every-point-in-the-tape).) On a stranger the trade
still applies and still cannot be priced, because there is no ground truth to price it against.
**How often it fires on strangers is measured under BOTH halves** — the census was re-run under the
union on captain decision 183a, and **1 candidate in 14 survives it either way**: per-launch proof
went 0.1607 → 0.3929 while the 8-of-8 headline did not move. See "The bundling census" below.
`bundledTx`, `maxWalletsInOneTx`, `runTx` and `adjacencyMarks` reach the
score, the record and the rendered line for exactly that reason: they are the only observable that
exposes the condition and says which half carried each launch, so a saved run can be audited after
the fact.

A proven room figure is **still an upper bound**, and one mark is not evidence of complete recovery.
The union happens to recover every cohort wallet-instance on our own tape, but that is a measurement
on the one deployer whose cohort is named, not a property of the rule: a wallet that neither shares
a transaction nor rides the deployer's run is still counted as independent, and a book that
accumulates in the slots after the create slot is still invisible. `roomIsProven` is the floor of the
evidence, not a threshold on its quality.

**The predicate is create-slot-scoped, not operation-scoped, and no tighter one is available.** Half
(a) asks only whether *some* create-slot transaction carried 2+ distinct wallets — so a create slot
in which the deployer buys entirely alone while two unrelated wallets share one transaction (a shared
aggregator or copy-trade route) qualifies, and on that launch the operation's stake is still booked
outside the numerator. The obvious tightening — require a bundle containing the deployer — was
measured against the committed tape and matches **0 of 235** launches: this deployer never shares its
own create-slot transaction, the dev buy is a 1-wallet transaction every time, and the cohort bundles
among *itself* (typically two 3-wallet transactions). Adopting it would refuse every launch, leave
Stage 2 scoring nothing for any wallet, and hard-fail Stage 0 twice — the era buckets go to `n = 0`
and trip their own `minN` vacuity guard, and the known-negative control becomes `entry-unmeasured`.
Captain **decision 139a** settled that, and it is untouched.

**The widening that was measured and REFUSED**, so nobody re-proposes it: a *recurrence* rule marking
a wallet appearing in k of the candidate's trailing 8 create slots. At k = 8 it missed 112 cohort
instances and falsely marked 4 outsiders; it is behavioural inference where every other rule here is
a structural fact, and it is contaminated by general-purpose snipers who turn up across many
unrelated deployers, which separating needs a cross-deployer denominator the screen does not build.

#### A sample two launches short does not get to decide a bar it cannot reach

Captain **decision 190a** decoupled `maxLaunchesPerCandidate` (10) from `minLaunchesSampled` (8), so
a candidate keeps its verdict after losing up to two launches. That bought a real thing — the
no-verdict rate on request-cap drops — and it made reachable a verdict shape that was **structurally
impossible at 8-and-8**: a candidate scored on 8 of 10 launches where **the two missing ones were
selected by drop cause, not at random.** Request-cap drops fall on the busiest launches;
`roomIsProven` refusals fall on launches with no co-ordination evidence. Neither is a coin toss over
the deployer's history, and this repository already discards *whole* for exactly that shape twice —
the cost leg's truncated walk ("a truncated walk holds the earliest entrants by slot, which is a
biased sample rather than a short one") and `minPricedFraction`.

Captain **decision 198b** answers it with a guard rather than a revert: `entry.mjs` →
`roomBarRobustness`, which **refuses to score a candidate when a launch went missing AND completing
the sample could have put the median on the other side of `minRoomLeft`.** The headroom is kept
wherever it is safe and declined where it is not.

**The argument for the margin — and the statistics behind it — live with the code.** `entry.mjs` →
`roomBarRobustness`'s doc is the owner: what the band is anchored to, why the direction of the bias
is **UNMEASURED** (the attempt is on record as having failed, two statistics opposite in sign on
**n = 1 deployer**), and why **no number is pinned for it in `thresholds.json`** — the band is the
candidate's own reachable median range, derived from `measure.mjs` → `ROOM_LEFT_RANGE` and the
candidate's own order statistics. Read it there rather than here; the consequences are below.

**Five consequences, all deliberate.**

- **It refuses in BOTH directions**, which follows from the direction being unmeasured rather than
  from taste. `entry-room-absent` is a *measured* verdict a later stage may filter on, so shipping
  one off a subsample that could equally have cleared the bar is the invisible false rejection this
  screen exists to remove — the same harm as a false pass, pointing the other way.
- **It is a worst case, not an estimate**, and therefore wider than the only displacement magnitude
  anyone has measured (that figure is with the argument, in `roomBarRobustness`). It will refuse
  candidates whose true median would not in fact have moved. That is the accepted direction: the
  standing bar is that a false positive is not an acceptable result, and a refusal is.
- **Over-refusing is cheap because of how the refusal is labelled.** It is
  `room-verdict-not-robust-to-missing-launches`, attribution `our-coverage`, so a later stage must
  carry the candidate forward as *no answer* rather than drop it. The candidate is unanswered, not
  lost, and a later walk can answer it.
- **A complete sample is untouched.** With nothing missing the interval collapses to the reported
  median, so a 10-of-10 candidate cannot trip it and nothing before 190a is retro-graded.
- **It covers the ROOM bar only.** The field legs and the cost leg run over the same incomplete set
  of launches and are *not* guarded here. That is the scope 198b authorised; a pooled statistic would
  need a different construction and its own decision.

**What the committed tape can and cannot say about it.** Our subject deployer is proven 235/235 under
the union rule and its tape carries no walk drops, so the hole is 0 at every window and **this tape
cannot exercise the guard at all**. Stage 0 staying green — both halves of the known-negative control
included — is a consequence of that, not evidence the guard was checked against it. The behaviour is
pinned by unit fixtures instead, and the limit is asserted rather than left to be assumed
(`test/deployer-screen.test.ts` → *"the committed tape CANNOT exercise this guard"*).

#### The room median states its own incompleteness — the bound beside it

Captain **decision 208b**, with 208d folded in as its first step. The guard above refuses a verdict
the hole could have flipped. This is the other half of the same problem, and it applies to **every**
score rather than only the near-bar ones: the median is reported over the launches that were
**scored**, and the ones that were not did not go missing at random. `roomIsProven` refuses the
create slots with no co-ordination evidence, the request cap drops the busiest windows, and the stage
ceiling leaves the oldest of a plan unattempted. On the 2026-08-04 full-day run **18 of the 22
cleanly-walked windows were refused**; the bundling census separately reports **0 of 13 stranger
candidates proven on all eight**. On the stranger population this is the ordinary case.

`entry.mjs` → `roomMedianBound` is the owner — the construction, the direction argument and the
committed-data measurement are all in its doc, and the figures should be read there rather than
restated here. What the reader needs from this file is the shape and the four rules.

**It is a REPORT and no gate reads it.** No verdict, bar or guard takes it as an input; `roomIsProven`
is untouched and no sample-size floor moved. Captain decision 203 declined **203c** (lower the floor)
and **203d** (pad a refused launch's room and use it), and 208b was chosen because it does neither.
The refusals stay, and what changes is that the figure says what they cost it. A sibling lane has
since established that the missing evidence **does not exist to be got** — those create slots are
participant-poor rather than evidence-poor (`census/2026-08-04-proof-coverage-probe.md`) — so the
refusals are correct answers, and this describes their consequence rather than trying to remove them.

**The bound is narrower than the guard's, and must never be handed to it.** A refused launch was
walked and measured, so its own reading replaces the algebraic ceiling `roomBarRobustness` is obliged
to use. Feeding this interval to the guard would make the guard refuse *less* — loosening a guard by
the back door. A refusal and a report read the same hole and are entitled to different assumptions
about it; `test/deployer-screen.test.ts` → *"IT IS A REPORT AND NEVER A GATE"* pins the two apart.

**It appears beside the figure, not near it.** The run record's `entry.roomLeftBound` sits next to
`entry.roomLeft`; the rendered block prints it on the line immediately under `room left`; every
rationale that states a room median states the bound in the same sentence; and it is in
`entry.caveats`. That is the whole point of 208b over 208a — a bound in surrounding prose is a bound
the figure can be quoted without.

**A complete sample gets a sentence too.** Silence is not a way to say "nothing is missing", because
a reader cannot tell it from a field that was never computed. A whole sample reports a degenerate
`[median, median]` and says so — which is what Stage 0's controls print, our subject being proven
235/235 with no walk drops.

**What the committed data says about the size of it, and about its DIRECTION.** Both readings are on
record because the direction is *not* universal, and a one-directional correction would have been
wrong:

- **On the stranger windows the direction is UP, and large.** `runs/2026-08-04.json`'s scored
  candidate reports a median `0.288940` over 4 windows with 6 refused;
  `census/2026-08-04-proof-coverage-probe.md` walked those six and measured their room at
  `0.0000`–`0.0008`. Completing the sample puts the median at `0.0008`. The reported figure is
  roughly 360× the completed one, and it provably overstates.
- **On our own tape it runs the other way.** The union rule refuses nothing here, so the only source
  of real refusals is the superseded shared-transaction half (60 of 235). Over its 63 ten-launch
  windows with a hole, completing at the refused windows' own measurements **raises** the median on
  52 and lowers it on 8. The reason is worth knowing: there the rule found nothing because the
  operation co-ordinated by *adjacency*, so the refused windows carry its own stake booked as
  outsider capital and read high. **Refusal means no evidence, not near-zero room** — what it costs
  depends on why.
- **And the bound contains the better reading on 63 of 63 of those windows.** The union's own median
  over the same launches falls inside `[lo, hi]` every time, which is the validation that the
  "measured room on a refused launch is an upper bound on its true room" claim rests on. All of it is
  re-derived from the tape on every test run rather than pinned as prose
  (`test/deployer-screen.test.ts` → *"MEASURED ON THE COMMITTED TAPE"*).

### 2. The field

What every **other** sniping wallet on those same launches achieved: what it was filled for, how much
SOL was queued ahead of it by pump.fun's own within-slot ordering key, and what it realised. The
question is whether *we* beat them, so the competition is measured rather than assumed.

**Only closed round trips have a P&L.** A position still open at the window's end is counted and
reported, never marked to a price — the committed dataset's own `closed_in_window` rule (residual
within 0.1% of tokens bought), reproduced exactly.

### Distributions plus a hit rate, never a mean

A standing bar from the captain for this class of claim, and it is a correctness rule rather than a
presentational one. Sniper outcomes are heavy-tailed on both sides — on our subject's post-break
launches the p90 outsider round trip is roughly twenty times the median — so a mean is carried by
whichever tail is fatter and describes nobody. **A mean here is a wrong answer, not a rough one.**
Nothing in `entry.mjs` computes one, and a test asserts the word does not appear in its executable
half.

### 3. The price of the seat, and what the field cleared after paying it

**Captain's standing ruling, 2026-08-02: fees are part of the entry window, and "enterable" means
enterable AFTER what it costs to enter.** Captain decision 136b adds the field's after-cost result,
which is what stops the field leg being veto-only. So Stage 2 has a third leg.

**The signatures are free.** Every fill Stage 2 parses carries its transaction, so the transactions
that bought a stranger's create slot are a by-product of a walk that has already happened — no
discovery step, no vendor request, no extra `swap-api` page. `measure.mjs` → `walletTransactions`
names them and `entry.mjs` → `entryCostTargets` unions the two scopes so a signature is never paid
for twice. What is *not* free is the reading: one `getTransaction` per transaction, on
`api.mainnet-beta`, at the creation walk's own 2.5s pacing.

Two exact quantities come out of one response, and `pumpfun.mjs` → `parseTransactionCosts` reads
both: the **transaction fee**, base plus priority, from `meta.fee`; and the **entrant's real lamport
change**, from `preBalances`/`postBalances`. Against the fill tape's swap quote that gives what an
entrant paid over and above the position it took — fee, venue fee, rent, execution difference, and
any tip paid inside its own transaction. This is the route the committed
`onchain_create_slot_pnl.csv` was built by, which is why Stage 0 can regression-test the whole leg
offline before it is pointed at a stranger.

**Two limits travel with every number, in the score's caveats, the rendered block, the run record
and the dry-run plan — not only here.** Both run in the same direction:

- **A landing tip paid in a SEPARATE transaction of the same bundle is not in any of it.** It is not
  recoverable from the entrant's own transaction and it is not measured anywhere in this repo's
  ground truth either, so every cost is a **lower** bound and every after-cost result an **upper**
  bound. Entry looks cheaper, and the field more profitable, than either was.
- **The cost is the cost paid by WINNERS.** Every fill belongs to a wallet that won the auction;
  post-break our own subject saw a median 41.6 attempts per landed transaction, and a wallet that
  paid and did not land is invisible. So this understates the cost of *trying*.

Under the captain's tiebreaker — a null beats a false positive — that is exactly why the cost leg is
a **gate and never a pass**: unmeasured cost yields `entry-cost-unmeasured`, which is terminal.

**The free legs run first, and that is the cost model.** Room and the gross field are arithmetic over
fills already in hand, so a deployer failing either is refused before one RPC request is spent on
pricing it. Only a candidate still alive after both is walked.

**Measured on the committed tape, 2026-08-02** (`population-tape-2026-07-29` →
`onchain_create_slot_pnl.csv`), over the **gated population** — the launches whose create-slot
opening is *proven*, which is the population `scoreEntry` builds the bar's own unit from: **112
launches, 766 create-slot entries, 627 closed round trips priced end to end** (re-measured under the
union co-ordination rule of decision 182a; under the shared-transaction rule alone it read 110 / 757
/ 618).

| | reading |
|---|---|
| entry cost, per create-slot entry | median **0.0308 SOL**, and **99.7%** of entries pay something |
| entry cost, per SOL staked, pooled over **entries** | median **0.0371** (p75 0.0818, p90 0.1972; post-break 0.0292) |
| entry cost, per SOL staked, one figure per **launch** — *the figure the bar is compared against* | median **0.0391** (p90 0.0983; post-break 0.0361) and the **worst launch on the tape is 0.3311** (post-break 0.1361) |
| the field, hit rate | **0.7384 gross** against **0.6045 net of measured fees** |
| the field, median round trip | **+0.107 SOL gross** against **+0.036 SOL net** |
| round trips that flip sign | **87** positive-gross → negative-net |

**Why "gated" is stated rather than assumed.** This check used to price *every* taped launch the
table could reach, while the live bar reads the proven-only population, and a regression guard
measuring a neighbouring quantity is the shape of the defect decision 140 caught. So the filter is
applied here too and **both readings are printed on every run**, the unfiltered one on its own line,
so the difference stays visible instead of being taken on trust. Under half (a) alone the two
populations differed — 113 launches, 775 entries, 631 pairs, per-launch median **0.0388** against the
gated 0.0389, i.e. *cheaper*, the optimistic direction. Under the union nothing on this tape is
unproven, so the two coincide (112 / 627 / 0.0391 either way); they will separate again on any tape
carrying a launch neither half of the rule marks, which is the case the keys exist for.

Whole-block reads (`getBlock(slot, transactionDetails='full')`) would collapse the create-slot scope
from ~7 requests a launch to one. That route is **untested against this endpoint**, so it is probed
behind a fallback to per-signature reads and the record says which one paid for its numbers. It buys
request count and nothing else — in particular it does **not** reach out-of-transaction tips, because
attributing a sibling transaction in the same slot to the same bundle is an inference the chain does
not support.

### The legs are not symmetric, and that is the design

| leg | can it earn `entry-open-after-costs`? | can it deny it? |
|---|---|---|
| room, on a launch whose opening is **proven** | **yes** | yes |
| room, on a launch whose opening is **unproven** | **never — the launch is not scored at all** | no: it is removed, not counted against |
| the field, gross of fees | **never** | yes |
| the field, net of measured fees | **never** | yes |
| the price of the seat | **never** — an unmeasured one is not a pass either | yes |

Because **everything the fill tape can say is gross of fees.** It carries swap-quote SOL and no
priority fee, landing tip, venue fee or rent, so every P&L computed from it alone is an upper bound.
A field that loses money before costs certainly loses money after them — conclusive. A field that
*makes* money before costs has established nothing at all. Netting the measured cost onto it
sharpens the veto without changing its direction: measured cost is itself a lower bound, so the net
figure is still an upper bound on what anyone took.

The size of that gap is measured rather than feared, on the one wallet where we hold the answer:

| our subject `7ufmve7Z…`, post-2026-06-04 | reading |
|---|---|
| the field, **gross of fees**, as Stage 2 measures it | **358 / 469 closed round trips positive (76.3%)**, median **+0.1169 SOL** |
| the regime, **fee-inclusive**, from `onchain_create_slot_pnl.csv` | **+0.54 SOL per launch across 106 wallets, 51 of them negative** |

(The gross row is over all 89 post-break launches, none of which the union co-ordination rule leaves
unproven — the three the older shared-transaction rule refused are back in the population, and their
round trips with them. The fee-inclusive row is the regime's published figure over the same 89 and is
quoted unchanged; it moves the argument not at all, since the point is the sign of the gap, not its
third digit.)

Read naively, the field says this wallet is beatable. It is not. So the field can only ever veto.

### Verdicts

`entry-open-after-costs` · `entry-room-absent` · `entry-cost-prohibitive` · `entry-cost-unmeasured` ·
`entry-field-loss-making` · `entry-unmeasured`

Nothing in that vocabulary says beatable, profitable, or worth trading. **`entry-open-after-costs`
means the opening window is not already closed AND what it costs to land there does not consume it,
so the exit question is worth asking** — and nothing more.

| verdict | what it means | costs an RPC request? |
|---|---|---|
| `entry-room-absent` | median room below the bar. The enquiry ends before anything is priced. | no |
| `entry-field-loss-making` | the field loses money — **before** costs (conclusive on its own), or **net of measured fees** (the leg the gross reading cannot see). | only the second |
| `entry-cost-unmeasured` | the free legs passed and the cost leg could not price enough of the field. **Terminal for that candidate in that run, and never a pass. Two distinct producers — see below.** | yes, and it ran out |
| `entry-cost-prohibitive` | room present and priced, and the price of the seat consumes the opening. | yes |
| `entry-open-after-costs` | all three legs allow it. | yes |
| `entry-unmeasured` | too few usable launches for any distribution, too few closed round trips to read the field, or **enough** launches with a hole in them the room bar sits inside (decision 198b). **Five distinct producers — see below.** | no |

**`entry-room-present` was removed, not renamed.** Under the captain's ruling of 2026-08-02 fees are
part of the entry window and "enterable" means enterable *after what it costs to enter*, so a verdict
that spoke only of room could no longer be the strongest thing this stage says. A schema-≤5 record's
`entry-room-present` is not the same finding as a schema-6 `entry-open-after-costs`; see the schema
table above.

**`entry-unmeasured` and `entry-room-absent` are deliberately not the same verdict**, and unproven
openings land on the first. "We could not measure this" is not "we measured it and there was
nothing there": the second is a finding about a deployer, the first is a finding about our evidence,
and folding them together would let a coverage failure read as a judgement. The score carries
`launchesRoomUnproven` beside `launchesSampled` so the two populations can always be told apart, and
a caveat names the count and the reason on every score that has one.

### What a later stage may filter on

**Captain decision 174b, 2026-08-03. Read this before writing any filter over a Stage 2 outcome.
THIS SECTION IS THE AUTHORITATIVE STATEMENT OF THE RULE** — the `AGENTS.md` bullet carries the
operative invariant and points here for the table, the attribution and the rest. The
attribution question inside 174b was settled during review, after the split had already been
committed: the earlier commit on this branch and its message describe the PRE-DECISION rule, under
which `too-few-closed-round-trips` was attributed to the deployer and was the one thing a later
stage could filter an unmeasured candidate on. That rule is superseded — history is not rewritten,
so a reader who finds only the old message must be led here. What follows is what the code does.

The two unmeasured verdicts are not one finding each. Between them they have **seven distinct
producers**, enumerated from `entry.mjs` → `scoreEntry` rather than from intent, and they do not
describe the same kind of thing:

| `unmeasuredCause` | verdict | attribution | what actually happened |
|---|---|---|---|
| `too-few-windows-available` | `entry-unmeasured` | **our-coverage** | the walk was never offered `minLaunchesSampled` windows — a short or too-young history, or our own `maxLaunchesPerCandidate` cap. |
| `windows-dropped` | `entry-unmeasured` | **our-coverage** | windows were reached and could not be walked back to the mint. `entry.coverage.dropsByReason` says which. |
| `too-few-proven-windows` | `entry-unmeasured` | **our-coverage** | windows were measured perfectly well and **refused**: no bundled transaction in the create slot, so the co-ordination rule recovered nothing (decision 134a). |
| `room-verdict-not-robust-to-missing-launches` | `entry-unmeasured` | **our-coverage** | **enough** windows scored, and the launches that went missing — dropped, refused as unproven, or never started — could have moved the median across `minRoomLeft` either way, so the bar is not decided by the evidence (captain decision 198b, `entry.mjs` → `roomBarRobustness`). Read it beside `entry.launchesSampled`: this one is at or above the floor, the three above it are below it. |
| `too-few-closed-round-trips` | `entry-unmeasured` | **our-coverage** | room was measured on a full sample and clears the bar, and the field around those launches produced fewer than `minFieldRoundTrips` complete round trips — read inside a window whose tail our own walk truncates (see below). |
| `too-little-of-the-field-priced` | `entry-cost-unmeasured` | **our-coverage** | below `minPricedFraction` of the create-slot field priced on-chain, or the cost leg never ran. |
| `too-few-priced-round-trips` | `entry-cost-unmeasured` | **our-coverage** | entries priced, but too few round trips priced across their **whole** window. |

**All seven are facts about us. None is a fact about the deployer.** So:

> **A later stage may filter on a MEASURED verdict — `entry-open-after-costs`, `entry-room-absent`,
> `entry-cost-prohibitive`, `entry-field-loss-making` — and never on an unmeasured one, whatever
> its cause.**
> An unmeasured outcome must be carried forward as **no answer** — surfaced and counted — not
> dropped. `verdict !== 'entry-unmeasured'` is a filter on our own budget and evidence wearing a
> measurement's clothes, and it is the same invisible false rejection this whole screen exists to
> remove, one layer down.

`entry.mjs` → **`isDeployerAttributable(finding)`** is the predicate that owns the rule; do not
rebuild the table above in a consumer. It takes the in-process `EntryScore` and a persisted `entry`
row alike, which matters because **Stage 3 is a second consumer of Stage 2's fill walk, not a reader
of `runs/*.json`** — the entry block is distributions and hit rates with no per-launch row and no
wallet identity, and Stage 3's questions are per-launch and per-wallet
(`slot-zero-stage2-reverify/report.md` §5). It fails safe three ways: a verdict it does not
recognise answers `false`, a record older than schema 10 has no `unmeasuredCause` and answers
`false` for the whole unmeasured family, and an unrecognised cause answers `false` too.

**Why `too-few-closed-round-trips` is `our-coverage` and not the deployer's.** *(This paragraph is
the OWNER of the evidence for that classification. `entry.mjs` → `UNMEASURED_CAUSE_ATTRIBUTION` and
`record.mjs`'s schema-10 note both point here rather than carrying their own copy — three parallel
copies of one argument is how the last version of it went stale.)*

It was the one row attributed to the deployer, on the ground that closure is read inside the pinned
entry window and that window is the same for every candidate. **It is not a fixed instrument, and the
evidence for that has been REPLACED rather than withdrawn — the classification is unchanged and is
the captain's** (decision 174b). The original evidence was `readLaunchWindow`'s two-bound cursor:
it sought in milliseconds and decided membership in slots, so slot drift left the window's tail
unfetched and the fills it lost were disproportionately late **sells**, each one flipping a wallet
from closed to open. Captain decision 144a closed that defect — the seek is now derived from the span
at a measured worst-case slot rate (`pumpfun.mjs` → `windowReachMs`), so the tail is requested.

What replaced it is the **price** of that fix, and it points the same way:

- The walk that produces `closed` is bounded by `maxRequestsPerLaunch`, and **what that cap affords
  moved under the launches without anything about any deployer moving.** At the wider reach the same
  pinned cap drops **4 of the 127 committed launches** as `request-cap`, where it dropped **0 of
  127**. `pumpfun.mjs` → `windowReachMs` owns those figures and the population.
- **The drops fall on the busiest launches**, so the sample that survives to the field gate is
  censored towards the *quieter* ones — and quieter launches carry fewer round trips of every kind.
  `closed.length` is therefore read off a sample our own budget selected.
- **Whether a candidate reaches this gate at all is decided by our sampling rule**, not by the
  deployer. Those two thresholds were the same value, 8, so ONE drop left 7 sampled and voided the
  **whole candidate**; captain decision 190a raised the cap to 10 against the same floor of 8
  precisely because that equality made our own cap fatal, so a candidate now absorbs two drops and
  loses its verdict on the third. Both the old rate and the new one are properties of our request
  budget and our luck against an endpoint that sheds ~25% of what it is asked for on the day.

The honest note beside it: that 4-in-127 rate is measured on one deployer's long-window launches,
which are also the busiest on the tape, so it is the right order of magnitude and not a bound for a
stranger — which is precisely why the conservative attribution is the captain's call. The field, the
type and the table all stay: a future producer **can** be deployer-attributable, and it has to come
to the table on purpose to become one.

Two things this does **not** do. It does not retune anything — `minPricedFraction`, decision 134a's
refusal and every other bar are untouched, and #17's asymmetry (false rejections possible, false
accepts impossible) is deliberate and unchanged. And it does not build any part of Stage 3.

How often the `our-coverage` half fires is measured, not assumed: `too-few-proven-windows` alone
silences **13 candidates in 14** on the current gate population, and the figure holds under the
union predicate **and** under the superseded shared-transaction half alike.

**Correction.** This paragraph previously read "**1 candidate in 14**", which was wrong by an order
of magnitude: 1 in 14 is the count that *survives* the filter, and the count it silences is the
complement, 13. The evidence is the committed record
`census/2026-08-03-bundling-census.json` (schema 2) and its report
[`census/2026-08-03-bundling-census.md`](./census/2026-08-03-bundling-census.md) §2.3 — 1 of 14
proven on all eight, complement 13 of 14 — with §2.4 breaking that 13 into **6** permanently
unscoreable, **3** one window short at 7 of 8 and **4** partially proven. The same 13 falls out of
the record's `candidates[].allBundled` for the superseded half. See `--subject-era`
in [`bundling.mjs`](./bundling.mjs) for the same question on our own subject.

## Bounds

Enforced in code, with no flag that disables one. Pinned in `thresholds.json`.

**The MadeOnSol rows below are RE-DERIVED against the Ultra tier — captain decision 267a,
2026-08-05.** The key is 100,000 requests/day and exclusive to slot-zero, so the daily allowance has
stopped being what binds this tool, and each row names the constraint that replaced it. **The
upgrade on its own widened nothing**: the candidate cap did not move, and the two ceilings that did
move were forced by arithmetic rather than chosen.

| bound | value | why |
|---|---|---|
| keyed request ceiling | 402 | **No longer an allowance figure.** 2 × (6 enumeration + 195 candidates) — the plan's **one-retry worst case**, since a keyed request is retried at most once and every attempt counts. It was 200, the whole Free-tier day; at 100,000 exclusive an allowance-derived ceiling would refuse nothing, and a bound that cannot refuse is not a bound. It **had** to move: a default plan now costs 6 + 195 = 201 and would have been refused at 200. The old 2-request headroom could not absorb three transport failures at the end of a full run; this cannot be breached by a plan the tool admitted. |
| candidate cap | 195 | **Unchanged in value, completely re-derived — the coincidence is worth saying out loud.** It was `200 − 3 − 2`, what the keyed day left over; that derivation is void. It is now the largest cap fitting the ceilings already pinned without moving a second threshold: the keyless `frontend-api-v3` ceiling binds at `floor(1,365 / 7 pages a candidate) = 195` exactly, the Helius run ceiling allows 211, and enumeration can reach at most 300 rows. The highest distinct yield ever observed is **128** (2026-08-05, good 69 + elite 59, disjoint pools), so a **default run still grades everything it surfaces**. |
| over-budget plan | refused before the first request | `6 + candidates > ceiling` — `0 + <addresses>` on a `--wallets` run, which issues no enumeration request — exits 2 having spent nothing, rather than running until the ceiling bites and reporting an incomplete screen. **The keyless plan is refused the same way**, and it matters more: the keyless work happens *after* the keyed requests are spent, so a ceiling discovered half-way through wastes what was already paid. |
| keyed pacing | 250ms between request starts | **Re-measured on Ultra rather than carried across, and the measurement retired the old constraint.** 6.5s existed for a ~10/min Free-tier burst limit. A ladder at 6,500 / 2,000 / 500 / **0** ms shed **nothing at any rung**, and 60 back-to-back requests (≈183/min sustained) shed nothing either — which a 10/min limiter refuses at request 11. The gate's own endpoint behaved the same (30 back-to-back, 0 shed). What binds is **response latency**: p50 312ms leaderboard, 182ms profile. So 250ms is a courtesy floor, not a shed-avoidance figure, and the keyed leg of a full run goes from ~21 minutes to **~50 seconds**. Limits: one day, ~150 requests, serial only — nothing here probed concurrency. |
| feed per-run keyed ceiling | 18 | 6 enumeration + `maxGateBatch` 12. Forced by the tiered default; it was 15 at 3 enumeration requests. The daily arithmetic is 18 × 6 runs = **108 of 100,000 (0.108%)**, where it used to be 90 of ~200. **The bound is kept anyway**: a cron is the one caller no human reviews before each spend, and an unbounded lane against a 100,000-request day is still unbounded. |
| keyless request ceiling, `frontend-api-v3` only | 1,400 | One client serves **two** passes on this host and the ceiling has to cover both. The gate reads the ownership listing it merges the creation window with, up to 4 pages **per candidate** — 195 × 4 = 780 — and `--consistency` then costs up to 3 pages per gate survivor, of which every candidate can be one: 195 × 3 = 585. So 1,365 worst case, and the remaining 35 are retry headroom. The earlier 600 was justified on the consistency pass alone and was already exceeded by gating at the default candidate cap. It does not lean harder on pump.fun — the pacing below is unchanged, so what it buys is wall clock. |
| keyless pacing, `frontend-api-v3` only | 2.0s | A **conservative carry-over, not a measurement of this host**: the ~0.5 req/s figure it was originally justified by was measured on `api.mainnet-beta.solana.com`, and the June report's own spend table records both pump.fun hosts as *not contacted*. It is kept because `frontend-api-v3` has shed nothing here, and it bounds a shared public resource rather than expressing our own caution, so the MadeOnSol relaxation does not touch it. The fill host is paced separately — see below. |
| requests in flight | **1**, serialised | Not a pool of one — a queue, so two callers cannot race. |
| retries | 1 keyed / 2 keyless, and **every attempt counts against the ceiling** | A retry spends a shared resource exactly as a first try does — but a 429, a 5xx or a timeout means the request was not served, so re-issuing it is nearer to one successful request than to two. Without it the caller re-runs the whole walk, which is worse for pump.fun too. A 4xx that is not a 429 is never retried: it is the endpoint's considered answer. |
| Dune executions, creation enumeration | **2 per run** (1 enumeration + at most 1 probe refresh) | `thresholds.json` → `dune`, and the unit is the point: **an execution is billed whether or not it succeeds and is never retried**, so this is the bound on the only unrecoverable Dune spend. ONE execution serves the whole candidate batch — the table scan costs nearly the same for 5 wallets as for 20, so what scales is bytes returned, not wallets. |
| Dune requests, creation enumeration | 100 per run | Separate from the execution ceiling because it bounds a different thing: polling and result reads bound the wall clock and the polite use of a shared free-tier host, not the money. 2 × (1 SQL verification + 1 execute + 40 status polls + 1 results read) = 86, plus the credit guard's one `POST /usage` and its single retry = 88, leaving 12 of retry headroom. A real run spends about **8**. |
| Dune result rows | 40,000 per read, and **at most `greatest(500, floor(19999 / <deployers in the batch>))` rows per deployer inside the SQL** | Results are billed at ~20 credits/MB and that is ~71% of the bill. The **~97 bytes/row** measurement was taken at FOUR columns; `CREATION_SQL` selects **six** today, and captain decision 227a's sixth column was the occasion to **re-measure rather than assume the ceiling survived it** — **105.92 bytes/row** batch-shaped (488 rows, five wallets) and **105.91** for one wallet (252 rows), so ≤121 bytes/row still holds and the pin does not move. This ceiling is ≤~4.84 MB (~97 credits) since captain decision **264a** raised it 20,000 → 40,000, and it is **no longer unobserved** — but its headroom is now 15.08 bytes, less than one more boolean column is worth (~23), so **a seventh column must re-measure and raise it** rather than lean on a margin that is gone. A 195-candidate run at a median ~50-launch history is ~0.95 MB (~20 credits), i.e. roughly 125 full-cap runs against the free 2,500/month, unchanged by the cap. The read ceiling **refuses rather than pages** and is now the **backstop** behind the per-deployer cap, not the first line of defence; it stays reachable at roughly **80** wallets of 500+ launches in one batch, since the rows bound is `max(19,999, <deployers> × 500)` rather than 19,999 by construction. **264a raised it because the backstop fired on a real run**: 76 deployers returned **27,731** rows against the old 20,000 and were refused whole, costing that leg **232,937 Helius credits and 4,105 RPC requests** against 1,924 and 33 for the leg that kept its Dune answer — and its mayhem reading entirely, `mayhemShare` null on 76 of 76, which is UNMEASURED and never 0%. **The SQL is untouched**: `SQL_ROW_CEILING` stays 19,999 and the two are now pinned as an INEQUALITY rather than an equality, so **no saved-query deploy is needed** and this raise cannot leave the Dune leg refusing terminally. What a run may spend is checked before the first request, against the smaller of the vendor's figure and the operator's own monthly cap — see [The monthly credit ceiling](#the-monthly-credit-ceiling--what-it-is-and-what-it-cannot-see). `thresholds.json` → `dune.justification.maxResultRows` and [CREATION-DERIVED.md §8.2b](./CREATION-DERIVED.md) own the rows arithmetic; [§8.2c](./CREATION-DERIVED.md) owns the byte re-measurement above. |
| Dune coverage staleness | 6 h | The probe cannot vouch for a period it does not reach, and the recent end is where a live screen looks. Dune's own freshness is ~3–4 minutes, so this bounds OUR cache, not the vendor: the probe defaults to a free cached read. Staleness is the one refusal asking again can fix, so it re-executes the probe **once**; a structural refusal (a missing table, a month with no rows) is not retried. |
| Solana RPC ceiling, keyless creation walk | 100 requests **per candidate** | `thresholds.json` → `creation_walk`. Governs the creation-derived walk **when no Helius key is present**. Whichever bound bites is recorded per candidate. |
| Helius credit ceiling, indexed creation walk | **5,200 credits per candidate**, 1,100,000 per run | `thresholds.json` → `creation_walk_helius`, and the unit is the point — this provider bills by transactions **returned**, so a request ceiling cannot bound it. 5,200 clears the largest complete history measured (49,367 succeeded transactions = 4,940 credits) **plus the per-page guard**, which demands 100 credits for the page and 11 more reserved for the curve-classification pass — at 5,000 that guard stopped the walk after 49 pages, truncating the very wallet the ceiling was sized against. The per-candidate median is 320. The run ceiling makes the default plan admissible at 195 × 5,200 = 1,014,000 and is 11% of the monthly allowance, so **nine worst-case full-cap runs fit in a month** and the expected cost of one is ~0.62%. **The two move together**: the run ceiling is checked before the first request, so raising the per-candidate one alone would refuse every default plan. A plan that does not fit is **refused before the first request**, exactly like the keyed and keyless plans. A page is only started when a whole page's worst case still fits, so the ceiling is exact and never overshot. |
| Helius pacing | 200ms | Measured 2026-08-03 on this endpoint and plan: a ladder at 1000/500/250/100/0 ms (full mode) and 500/200/100/50/0 ms (signatures mode) shed **nothing at any rung, including 0 ms**, and 150 concurrent requests were all answered 200 at an observed 161 req/s. The walk is latency-bound rather than limit-bound — throughput was 3.98 req/s at 100 ms against 3.89 at 0 ms — so 200 ms is a courtesy floor with an order of magnitude of headroom under the documented 50 req/s, not a shed-avoidance figure. |
| Solana RPC ceiling, cost leg | 500 requests **per candidate** | `thresholds.json` → `stage2_cost`, which owns this measurement. Measured on our own tape: the create-slot scope is p50 7 / p90 13 / max 20 transactions per launch and the whole-window scope over CLOSED create-slot outsiders is p50 18 / p90 35 / max 70, unioned so none is paid for twice — **and the union is what the walk pays for: p50 19, p90 35, p95 41, max 74 distinct transactions per launch**, so ~190 requests per candidate at the median and ~350 at p90 over 10 launches (an earlier version of this row said ~200 / ~380, which is the same arithmetic with the union left out). It was **400** until captain decision 197b: 400 covered the median and the p90 at a launch cap of 10 too, but what decision 190a's cap consumed is the **per-launch headroom** above them — 50 union transactions a launch at 400/8, only 40 at 400/10 — and a launch the ceiling cannot cover is skipped **whole**, which drags `minPricedFraction` 0.8 (a hit rate over field *entrants*) into `entry-cost-unmeasured` on exactly the busiest candidates. 500/10 = 400/8 holds that headroom constant. Worst case 7 × 500 = 3,500 requests, about 146 minutes at the scoring cap of 7 (it was 3 × 500 = 1,500 and about 62.5 minutes at the cap of 3), which `--dry-run` prints. **It runs only on a candidate the free legs have not already refused**, so the realistic cost is far lower. |
| Solana RPC pacing | 2.5s | Measured: the nominally faster 1.4s was *slower* in wall-clock once 429 backoff is counted. Rate limiting is global across `getSignaturesForAddress` and `getTransaction`. |
| `getTransaction` batch size | **1** | Measured harmful above 1 on `api.mainnet-beta` — see [Which history the gate counts](#which-history-the-gate-counts). It does not arise on the indexed route, which issues one request per 1,000 transactions and so has nothing left to batch. |
| RPC retries | 3 with exponential backoff, each attempt counted against the ceiling | Unlike the keyed client, a 429 here is load-shedding and not a verdict — but a 429 storm still cannot outlast the ceiling. |

### How long a run takes, and how to bound it

**A full default run at the 195-candidate cap is worst-cased in HOURS, not minutes — about 19.2 —
and the creation walk is essentially all of it.** With `DUNE_API_KEY` set the walk is the fallback
and a typical run does not take it at all, finishing far inside this figure; the worst case does not
move, because every candidate may still fall back. The arithmetic is `renderDryRun`'s, so `--dry-run`
prints these same figures for whatever flags you actually pass:

**With a Helius key that leg is ~46 minutes instead of ~13.5 hours**, and the run's worst case falls
to roughly 6.4 hours end to end (21 + 46 + 26 + 147 + 146 minutes) — at which point Stage 2 and its
cost leg, not the creation walk, are the largest terms. `--dry-run` prints whichever route your
environment actually selects.

| leg | worst case | at its pinned pacing |
|---|---|---|
| keyed MadeOnSol | 3 + 195 = 198 requests | 6.5s → **~21 min** |
| **Solana RPC, the creation walk — keyless** | 195 × 100 = **19,500** requests | 2.5s → **~13.5 hours** |
| **Solana RPC, the creation walk — indexed (Helius)** | 195 × 50 pages = 9,750 requests, 1,014,000 credits | 200ms floor, ~280ms measured cycle → **~46 min** |
| keyless `frontend-api-v3`, the gate's ownership listing | 195 × 4 = 780 requests | 2.0s → ~26 min |
| keyless `frontend-api-v3`, `--consistency` | 195 × 3 = 585 requests | 2.0s → ~19.5 min |
| keyless `swap-api`, Stage 2 | 7 × 10 × 18 = 1,260 requests | 7.0s → ~147 min |
| **Solana RPC, Stage 2's cost leg** | 7 × 500 = **3,500** requests | 2.5s → **~146 min** |

So: **~19.2 hours** for a default run, **~19.5** with `--consistency`. The cost leg's ~146 minutes is
a worst case at the scoring cap of 7 (7 × 500 = 3,500 requests); it runs only on candidates the free
legs have not already refused, so a run in which few candidates survive both free legs costs a
fraction of it — nearer ~8 minutes **per surviving candidate** at the measured median (~190 requests
at 2.5s over 10 launches; it was ~6 at the ~152 a launch cap of 8
cost, and an earlier version of this sentence said ~8 for the wrong reason — the un-unioned 200). It shares the creation walk's limiter and is serialised after it, never beside it. The earlier "about 47 minutes"
predated the creation walk and counted only the keyed and `frontend-api-v3` legs; it is wrong by a
factor of twenty and is withdrawn. **Do not kill a default run because it is still going after an
hour.**

**How to tell a live run from a hung one.** The keyed and `frontend-api-v3` legs print `→ GET …`
once per request. The creation walk does not — at up to 100 requests per candidate across up to 195
candidates that would be some twenty thousand lines — so it prints a **periodic heartbeat instead**:

```
    · 7ufmve7Z…: 1/100 RPC request(s) — getSignaturesForAddress
    · 7ufmve7Z…: 10/100 RPC request(s) — batch:getTransaction
    · 7ufmve7Z…: 20/100 RPC request(s) — batch:getTransaction
```

The first request of each candidate, then **every tenth** — so at the pinned 2.5s pacing a line
roughly **every 25 seconds**, carrying that candidate's spend against its per-candidate ceiling.
Stage 2's cost leg prints the same heartbeat, against its own `stage2_cost` ceiling.
That counter, not a per-request one, is the liveness signal to watch. It is suppressed under
`--json` so machine-readable output stays machine-readable.

Typical is far below worst case and is not predictable from the wallet address: the walk's cost
scales with the fraction of a wallet's signature index that *succeeded*, measured between 1.7% and
99.7% (see [What that costs, measured](#what-that-costs-measured)), so one candidate can finish in
seconds and the next can spend the whole per-candidate ceiling — a cheap candidate may print only
its first heartbeat line before moving on. A run is not hung merely because it has been quiet for
half a minute, and a candidate whose walk is retrying through a 429 storm can be quiet for longer.

Two levers already exist, and this is what they are for:

- **`--candidates N`** bounds the whole run — the RPC leg is `N × 100 × 2.5s`, so `--candidates 12`
  is ~40 minutes of walking rather than ~13.5 hours. It truncates coverage, and the record says so.
- **`--ownership-only`** skips every creation-derived reading — Dune enumeration and walk alike, and
  the walk is the ~13.5 hours — leaving a run
  of well under an hour. Its reading is **biased in BOTH directions at once** — it rejects through
  the count bars (**20 of 82** clear `minTokens`+`minSpanDays` on the vendor page against **66 of
  82** on the creation-derived reading) and inflates through the rate (higher than the gate's on
  **37 of 81** wallets, lower on 29, median difference 0.0000, by up to **+0.6929**), which is the
  defect this whole lane exists to fix — and the record is stamped
  `historySource: "ownership-only"` so the bias travels with the numbers rather than being
  forgotten. `FEED.md` → "It is biased in BOTH directions at once" is the long form; the figures are
  `slot-zero-gate-bar-measure-own-population` §2.1/§2.3, held in firstmate's records, not in this
  repo.

Every figure above is in `thresholds.json` → `justification`, and `--dry-run` prints the plan
without fetching anything.

The conditional in the instruction binds: ***"if it gets results"***. It licenses sizing a run by
what the question needs. It does **not** license sweeping, idle retrying, or re-running to
re-evidence a side observation — a run that cannot say in advance what it will answer does not get
the allowance. And the relaxation is **MadeOnSol only**: the SolanaTracker / CoinGecko keys
are shared with production and the standing *"do not waste the quota that is production quota too"*
is unchanged, as is the keyless pump.fun pacing, which bounds a shared public resource for a
different reason. **Helius is no longer in that list** (captain, 2026-08-03) — its key is unshared
and belongs to this research lane alone, so it is budgeted against the whole monthly allowance and
metered on its own terms, in credits, by `thresholds.json` → `creation_walk_helius`.

Every run reports its spend **concretely**, not as one number: the record's `spend` block (schema 3)
carries the ceiling, what went unspent, the planned worst case, and every endpoint called with its
per-call cost; `renderStage1` prints the same table. Per-seed yields live in `coverage.seeds` and are
deliberately not repeated there — two projections of the same facts drift, and then whichever one a
reader opens becomes the truth. There is no poller,
sweep, daemon, cron, or cache-warmer, and adding one would be a policy breach rather than an
optimisation.

### The keyed endpoint list

| endpoint | cost | role |
|---|---|---|
| `/deployer-hunter/recent-bonds` | 1 **per tier** | enumeration; carries the `tier` filter |
| `/deployer-hunter/alerts` | 1 **per tier** | enumeration |
| `/deployer-hunter/leaderboard?sort=total_bonded` | 1 **per tier** | enumeration |
| `/deployer-hunter/{wallet}` | **1 per candidate** | the gate — the only cost that scales |

Since captain decision 262a the default tier set is `good` + `elite`, so a default run issues **six**
enumeration requests — see [The seeding is TIERED by default](#the-seeding-is-tiered-by-default--captain-decision-262a).

`client.mjs` → `ENDPOINT_ROLES` is the authority; `--dry-run` prints it. Not used, deliberately:
`/deployer-hunter/{wallet}/tokens` is bonded-only and rejects `limit` above 50, and
`/deployer-hunter/{wallet}/history` is reachable on this key but serves trailing-window aggregates
this tool refuses to read — see [`MADEONSOL_API_KEY`](#madeonsol_api_key--required).

**Dune is a second keyed vendor and is metered separately**, because there is no exchange rate
between the two: MadeOnSol is requests against a daily allowance, Dune is executions plus
result bytes against a shared monthly one.

| endpoint | cost | role |
|---|---|---|
| `POST /usage` | 1 request, **no execution, no credits** | **the monthly credit ceiling** — read before every other Dune call of the run |
| `GET /query/{id}` | 1 request, **no execution** | verify the saved SQL against the text committed in `dune.mjs`, before anything is spent |
| `GET /query/{coverageQueryId}/results` | 1 request, **no execution** | the coverage probe, from Dune's cache — the default |
| `POST /query/{creationQueryId}/execute` | 1 request, **1 EXECUTION** | the enumeration, once for the whole candidate batch |
| `GET /execution/{id}/status` | 1 request each | polling; retried, unlike the execution |
| `GET /execution/{id}/results` | 1 request, **billed by bytes** | ~20 credits/MB, ~71% of the bill |

Authentication is the `X-Dune-API-Key` **header**, never `Bearer` and never a query parameter, so no
URL this client builds can carry a credential.

### The monthly credit ceiling — what it is, and what it cannot see

**The ceiling is credits per BILLING PERIOD, the period is not a calendar month, and it is not the
same period on every key.** One of this fleet's Dune accounts was measured running **2026-07-29 →
2026-08-29** and another runs **2026-08-06 → 2026-09-06** — they reset on subscription anniversaries.
**A separate key is a separate ACCOUNT** with its own quota and its own period, so read both out of
the `POST /usage` response the key in use returned; nothing here pins either, and neither should
anything else. Three units are involved and they are not interchangeable: credits are the allowance,
**executions** are billed whether or not they succeed, and result **bytes** are billed separately at
~20 credits/MB (~71% of a typical bill).

**TWO CEILINGS APPLY AND THE SMALLER ONE BINDS** (captain decision 322a, 2026-08-06). One is the
**vendor's** — `credits_included` for the current period, 2,500 on the Free tier. The other is the
**operator's own monthly cap**, `thresholds.json` → `dune.monthlyCreditCapCredits`, which is where an
operator changes it; `tools/creation-census/bounds.json` carries the same key and
`test/dune-credit-ceiling.test.ts` pins the two equal, because neither keyed tool may import the
other and a cap binding one lane is not a fleet-wide total. `client.mjs` → `bindingCreditCeiling`
takes the `min()` and `decideAllowance` measures the period's own `credits_used` against it.

Four things follow, and each of them is why it is built this way:

- **The cap is a GLOBAL policy number, and it is ENFORCED PER ACCOUNT-PERIOD.** It binds even though
  nothing here holds state between runs, because it is applied to the PERIOD's spend rather than to a
  run, and the vendor's counter is that account's own running total. **The gap is real and is stated
  rather than papered over:** the fleet holds more than one Dune key, each counter sees only its own
  account, so two keys each honouring a 4,000-credit cap spend 8,000 between them with neither run
  wrong. Only one key, or a smaller cap on each, closes it — a captain's decision, not a guard's.
- **Neither figure is rewritten into the other.** Both, and the NAME of the one that bound, are on
  every verdict (`monthlyCapCredits`, `creditsIncludedVendor`, `bindingCeiling`) and in the sentences
  a refusal prints, so an operator can tell whether to **raise the cap** or **wait for the period to
  roll** — the refusal says which.
- **It is a `min()` rather than a chosen number because both sides move**, and this fleet's own
  figures moved while the guard was being written: one key read `credits_included: 2500` with
  2,044.357 used over 2026-07-29 → 2026-08-29 (live `POST /usage`, 2026-08-07T01:42:32Z) while a
  second key reported 4,000 included and 0 used over 2026-08-06 → 2026-09-06. A plan that grows, a
  cap the captain changes, a second account, and a vendor figure that moves mid-period are then one
  code path with no edit — **provided nothing quotes a figure instead of reading it.**
- **The cap costs a run NOTHING while it is the larger number.** On the key whose plan is 2,500 the
  vendor is what binds and every verdict is arithmetically what it was before 322a; on a key whose
  plan equals the cap, the two are the same number and a tie is reported as the vendor's, because
  raising the cap then buys nothing. A cap that needlessly refused affordable runs would fail the
  requirement as surely as an overspend would.

**Consumption is read from `POST /api/v1/usage`** — free, consumes no credits, and it reports
`credits_used` / `credits_included` per billing period. `client.mjs` → `readUsage` is the call and
`parseUsageResponse` is the reader; `dune.mjs` → `checkDuneAllowance` is the decision, and it runs
**before the coverage probe**, because the probe is itself a billed read.

**What a run does when the allowance is insufficient.** `dune.mjs` → `duneSpendPlan` prices the
CEILINGS this leg admits — `maxExecutionsPerRun` executions at
`worstCaseCreditsPerExecution`, plus one result read each and one of headroom, every read at
`?limit=maxResultRows` rows of at most `resultBytesPerRowCeiling` bytes. Four outcomes:

| verdict | when | what happens |
|---|---|---|
| `sufficient` | the worst case fits at least `allowanceTightMultiple` times over | the leg runs |
| `tight` | it fits once but not twice | **the leg runs and says so** — this run may be the last one the period can afford |
| `insufficient` | `remaining − reserve` is below the worst case, under whichever ceiling binds | **refused before the first request**, naming the ceiling that bound; creation enumeration falls back to the Solana RPC walk |
| `unreadable` | `POST /usage` failed or returned something this will not read | **refused** — an unreadable balance is not headroom |

`unreadable` has three causes and all three refuse. The vendor's body could not be read; **no
returned billing period contains the instant of the reading**, so the CURRENT period was never
established (we POST an empty body, which is documented to return exactly that period, so a
non-bracketing answer means something is wrong and the newest listed period is *not* a substitute);
or **the plan itself did not price to a finite number of credits**, which a missing or non-numeric
pinned bound produces — **and the operator's cap is checked in that same place and by that same
rule**, so a cap that is missing, zero or non-numeric refuses rather than leaving the lane silently
uncapped. The last two refuse even under `allowanceRequired: false`, because that flag waives an
unread *balance* and here it is the run's own cost, or its own ceiling, that is unknown.

A refusal here is the ordinary Dune fallback: slower, never wrong. `--dry-run` prints the worst case
and the balance below which the leg refuses, and needs no credential to do it. **A plan whose cap pin
is itself missing or non-numeric prints that named refusal rather than a figure** — the same wording
a live run refuses in, naming `dune.monthlyCreditCapCredits` and saying the run refuses rather than
falling back to the vendor's figure; `client.mjs` → `describeMonthlyCapCredits` is the one renderer,
so a typoed cap is legible on the surface an operator reads before authorising a run instead of a
crash there.

**What the guard cannot see, and both caveats travel on every verdict including the passing ones:**

- **The counter LAGS.** Measured on this account: `credits_used` rose **+6.0 while completely idle**,
  and it lands in whole-credit jumps. A reading is therefore a *floor* on spend and a *ceiling* on
  what remains. `allowanceReserveCredits` is held back before any comparison; no measurement fixes
  the multiple, and its justification says so.
- **A reading is ONE ACCOUNT's, and the lanes are many.** The key is the captain's alone and is
  **not shared** with another holder (captain, 2026-08-06), which is what makes a configured cap
  enforceable rather than a wish. But the screen, the census, the reproduction lane and any browser
  session all draw on that account's total and nothing tracks it between runs, so a sibling run can
  take the remainder between our reading and our execution — and a reading says nothing at all about
  a **different key's** account. *A sufficient reading is evidence, never
  a reservation.* **This is not the lag caveat above and neither stands in for the other**: unshared
  says no stranger is spending the balance; the counter is still behind the truth, and the reserve
  still comes off before any comparison.
- **IT CANNOT BOUND WHAT AN EXECUTION ACTUALLY COSTS — only what this run is allowed to PLAN.** The
  spend happens after the check passes, and Dune caps a single execution's cost nowhere, so the
  protection is only ever as good as the pin. That is measured, not hypothetical: a lane running
  behind this exact code path, with the counter re-read before every execution, printed
  `verdict: sufficient (ok=true)` against a pinned worst case of 6 credits and was billed **180.002**
  for an execution that returned nothing. **"A failed execution is free" is true only of a statement
  that fails to COMPILE** — Dune bills compute by engine time, so one that compiles and then runs to
  the vendor's 30-minute limit consumes the whole limit and is billed for it, and both come back as
  "failed". Captain decision 381 is both halves of the answer.
  `dune.worstCaseCreditsPerExecution` is re-derived against that engine floor, **25 → 200**, so this
  leg's worst case goes 340.4 → **690.4** and a run is refused once the period's `credits_used`
  passes ~3,285 rather than ~3,635 — headroom reserved, not credits spent, since a real leg costs
  single-digit credits. And `dune.executionDeadlineMs` (120,000 ms) makes `executeAndRead`
  **cancel** an execution still running at the deadline instead of walking away from a live engine;
  no path leaves one running, a request ceiling or transport failure mid-poll included. **Cancelling
  bounds the WAIT for certain and the BILL only if Dune stops the engine on cancel** — undocumented,
  and settling it would cost a runaway execution — which is exactly why the pin sits at the engine
  floor rather than at the deadline's own 13 credits. An abandoned execution is a distinct outcome
  (`DuneExecutionAbandoned`) that is still a terminal `DuneRefused`, so every fallback is unchanged
  while a reader can tell *we stopped this* from *this broke*. Both pins' `justification` entries own
  the arithmetic; cite them rather than restating it. **Two per-execution pins were deliberately NOT
  moved and say so in place**: `entry_source_agreement.worstCaseComputeCreditsPerExecution` cannot
  take the engine floor and stay plannable at 82 executions, so repricing it belongs with Gate 3;
  `dune-reproduction.mjs` → `WORST_CASE_CREDITS_PER_EXECUTION` moved 10 → 61, the floor its own 600 s
  deadline buys.
- **Execution compute is not predictable from the vendor.** Dune publishes no price table for it, so
  `worstCaseCreditsPerExecution` is pinned per lane. A statement that grew a `dex_solana.trades`
  join would need it re-measured — and the ~9× figure on record is a SUCCESSFUL execution, which
  says nothing about where a joined statement's own timeout floor sits.
- **Nothing tracks the period across runs.** The tool carries no spend state between runs — the only
  state it does keep is the Stage 2 rotation, which reaches no vendor; what a run carries is the
  reading it took plus `dune.localEstimate`, an estimate of its own spend from its own counters,
  labelled as one. Re-reading `/usage` after a run would report the balance from *before* it.
- **ONE FIELD NAME IS AN ASSUMPTION.** Dune's docs contradict themselves — the response schema names
  the array `billing_periods`, the example beside it names it `billingPeriods` — and no live
  response has been seen from this repository. Both spellings are accepted. If a live response ever
  settles it, narrow the reader; do not widen it further.

### Stage 2's own bounds — and it spends no vendor quota at all

**Stage 2 issues zero keyed requests.** The mint list comes from the `/deployer-hunter/{wallet}`
profile Stage 1 has already paid for, so the MadeOnSol daily allowance is untouched by the entire
entry measurement. Everything it fetches is pump.fun's free tape.

**The one mode that would make this false is gated off and prices itself separately:** the
[dual-source agreement run](#one-run-two-fill-sources-and-it-agrees-with-itself-per-candidate) reads
a second fill source and so spends Dune credits *inside* Stage 2, metered by
`entry_source_agreement` and recorded as its own `duneSpend` rather than pooled with the
enumeration's. It cannot run today, and this table is what every run applies.

| bound | value |
|---|---|
| gate survivors scored | 7 (`--score` can lower it, never raise it) |
| launches per survivor, PLANNED | 10 |
| launches that must be SCORED (`minLaunchesSampled`) | 8 |
| **requests per launch, retries included** | 18 |
| stage ceiling, on its own client | **1,260** |
| pacing, `swap-api` only | **7.0s** |

**The first three rows are the SWAP-API fill source's own caps and are pinned as such** —
`thresholds.json` **6.1.0** source-scoped the three sampling caps, so `stage2_entry`'s 7 / 8 / 10 are
derived from this source's request arithmetic and the Dune source carries its own three in
`stage2_entry_dune` (see [The Dune fill source is committed and nothing routes through
it](#the-dune-fill-source-is-committed-and-nothing-routes-through-it)). Every **evidence** bar —
`minRoomLeft`, the field bars, the cost bar — stays in `stage2_entry` and governs both sources.
`ENTRY_FILL_SOURCE_KIND` is `'swap-api'` on every run, so this table is what every run applies.

The two launch bounds are **deliberately unequal** — captain decision 190a, 2026-08-04. The stage
plans 10 launches and needs 8 of them scored, so a candidate absorbs **two** dropped launches before
it loses its verdict outright; at the 8-and-8 that preceded it, one drop cost the whole candidate.
See “What a dropped launch costs” below.

`7 × 10 × 18 = 1,260` — **the declared worst case and the ceiling are the same number**, so the plan
`--dry-run` prints is the whole exposure and no plan-level truncation is possible. A launch is only
started when a full per-launch cap of headroom remains, so a run never abandons one half-walked.
Typical cost is far lower: at the measured median of 4 pages plus shedding, about 6 requests a launch
and ~420 for a full run. **In wall-clock terms that is about 49 minutes typical and about 147 minutes
worst case**, and `--dry-run` prints both — a run this long must not be mistaken for a hang.

**The survivor cap was 3 until 2026-08-04.** The full-day default run of that day recorded
`scoringCap: {max: 3, survivorsUnscored: 1}` — a gate-passed wallet with 37 tokens over an 874-day
span was never scored for cap reasons alone, which is a cap and not a refusal and is invisible in the
verdict counts unless a reader opens `scoringCap`. 7 is the **largest** cap that fits the ceilings
already pinned without moving a second threshold: `7 × 10 × 18 = 1,260` stays under `budget`'s 1,400,
where 8 would be 1,440. It is a **budget bound and not a statistical one** — the two committed runs
disagree about the gate-pass rate by nearly an order of magnitude (4 of 82 on the full-day run
against 5 of 12 on the elite run), so no cap derived from a survivor count would mean anything.
`thresholds.json` → `stage2_entry.justification.maxCandidatesScored` owns the arithmetic and the
cost; it does **not** guarantee every survivor is scored, and `scoringCap.survivorsUnscored` stays
the reader's recourse.

### Why the fill host is paced at 7s and the other keyless host is not

Pacing is pinned **per host**, because the two keyless hosts do not behave alike. Two independent
readings of `swap-api` set 7s:

1. **Live.** At 2.0s, two consecutive Stage 2 runs against `swap-api` each lost 4 of the subject's 8
   launches to HTTP 429 *after all three attempts*. The drop path did exactly what it is built to do
   — dropped, counted, reported, never truncated — so the run reported `entry-unmeasured` where the
   truth is `entry-room-absent`. The same code at 7.0s walked all 8 and produced
   `entry-room-absent`. **A fast wrong answer is worth nothing**, and this failure is quiet: it
   degrades a verdict rather than announcing that the pacing is wrong.
2. **The tape builder's own record against this same endpoint.** The committed
   `window/*.meta.json` `delay` field — the adaptive delay each build settled on — reads p50 4.92s,
   p75 15s, p90 15.5s, max 40s, with only p10–p25 near 1.2s. Its shed share by delay quartile is
   **24.2% / 24.8% / 28.5% / 23.8%** across the 238 builds carrying a `stats` block — 23.8–28.5%,
   with the slowest quartile no better than the fastest — so backing off buys no immunity and there
   is no cheap corner to sit in.

7s therefore sits deliberately between that p50 and p75 rather than at the bottom of the range. The
`--consistency` walk on `frontend-api-v3` stays at 2.0s: it has shed nothing in this tool's use of
it, and it is not slowed for a fault on a host it is not.

The per-launch cap counts **requests, not pages**, and that is load-bearing — see the shed rate
below. A cap on successful pages would have let a launch cost three times the printed number.

The bound is **exact, not approximate**. One page can cost up to three requests (one attempt plus two
backoffs), so the walk reserves the whole per-page cost *before* starting a page. Checking the cap
only between pages would let a walk sitting at 17 spent requests start a page that sheds twice and
finish at 20, and `7 × 10 × 20 = 1,400` overruns the 1,260 ceiling the dry run prints as the entire
exposure — surfacing as a mid-walk ceiling error and a dropped launch.

Note also that the **1,400 keyless ceiling in `budget` is a per-client ceiling, not a run total**:
`screen.mjs` builds two independent keyless clients, and Stage 2's 1,260 sits on its own. The
enforced combined worst case is 2,660. The 1,400 is **derived from the candidate cap**, not chosen, and it is
derived over both passes that share the `frontend-api-v3` client: the gate's ownership listing at 4
pages per candidate (780) plus `--consistency` at 3 pages per gate survivor (585) is 1,365 worst
case. The previous 600 counted only the consistency pass, so gating at the default candidate cap
already overran it — and because the keyless work runs *after* the keyed allowance is spent, that
overrun would have thrown away a paid-for run. Keeping Stage 2's ceiling separate is what stops it
eating this budget, or the reverse; a plan that does not fit either one is refused up front.

Every run prints its request count, shed count and elapsed time.

### Nothing vendor-derived survives in a note, either

The retention claim is about free text as much as fields. A drop note built from a thrown error used
to carry `swap-api.pump.fun/v2/coins/<MINT>/trades` into `coverage.dropNotes` and out through
`--out`, because `KeylessClient` formats the URL into its message — and the committed-record test
only forbade mint-shaped *keys*, so a mint inside a sentence passed it. Two changes, both kept:

- `RequestFailed` carries its **status as a field** — `KeylessHttpError` is one of its subclasses —
  so `stage2.mjs` → `describeTransportFailure` can report `HTTP 400` without repeating anything the
  vendor sent, and without importing the source that threw. Anything that is not one is reduced to
  its constructor name.
- `record.mjs` → `redactVendorIdentifiers` scrubs named free-text fields on the way into a record,
  stripping URLs and base58 address runs, so containment for those fields does not rest on every
  future note-writer remembering. **Covered today, and only these:** the entry half's `rationale`,
  `caveats` and `dropNotes` (`stage2.mjs` → `toEntryRecordRow`); the gate half's `rationale`,
  `gateReasons` and `consistency.note` (`screen.mjs` → `toRecordRow`); the run-level
  `truncationReason`; the creation half's `stopDetail` and `listingUnmeasuredNote` (`screen.mjs` →
  `toRecordRow`, via `record.mjs` → `redactCreationNotes`); and every run-level `unmeasured[]`
  entry's `detail`, redacted at construction inside `unmeasuredBecause` / `unmeasuredNoSource`
  because that is where a caller's exception becomes record text.

  The three error-derived paths that used to reach `--out` verbatim — `creation.stopDetail` (a raw
  `cause.message` under `upstream-error`), `creation.listingUnmeasuredNote` (built from one) and
  `unmeasured[].detail` (documented as embedding a per-wallet URL) — are the ones the last two
  entries close. The enumeration is still a list of NAMED fields, not a property of the record: a
  new free-text field is uncovered until it is routed and listed here.

  It is applied **field by field and never as a sweep of the record**, because `wallet` is a 44-char
  base58 string that is deliberately kept — public on-chain data, and the one identifier a record
  exists to carry — and a blanket pass would strike exactly it.

## What walking the fill tape actually costs — measured, not estimated

Every `window/*.meta.json` in the committed tape records the request stats of the walk that produced
it. Across the 235 covered launches:

| quantity | measured |
|---|---|
| pages per launch, **pooled over all window lengths** | p50 **4**, p90 **8**, p95 **13**, max **24** |
| pages per launch, **the 210 launches taped over a 60s window** — *the window a live walk reads* | p50 **4**, p90 **6**, p95 **6**, max **13** |
| fills per launch | p50 381, p90 736, p95 1,222, max 2,321 (p50 **362** over the 60s launches) |
| **HTTP 429 shed rate** | **16,960 of 68,675 requests — 24.7%** |
| launches that shed at least once | **221 of 235** |

Two consequences, both of which corrected a first pass at this tool:

- **A 429 on this endpoint is the normal case, not an incident.** The tape's own builder backed off
  adaptively (its recorded `delay` ranges from 0.75s to 40s) and retried through them. A client that
  treats a 429 as terminal cannot walk a launch window at all — the first live check of the pager
  died on one, three launches in. `KeylessClient` now retries twice, at 3s and 9s.
- **A 10-request cap was too small and its stated justification was wrong.** It had been anchored on
  a single sampled window of 385 fills; the real distribution above shows 20 of 235 launches need 10
  pages or more. The cap is 18 requests — at the measured shed rate a page costs ~1.33 requests and
  is only *started* while 3 requests of headroom remain, so 18 starts about **11–12** pages. Against
  the population a live walk actually faces (the 60s launches) that is roughly double the p95 of 6
  pages, and it does **not** reach that population's observed max of 13: the **2 launches in 210
  (1.0%)** needing 13 pages would be dropped at the mean shed rate — reported, as below, never
  silently truncated. An earlier version of this paragraph claimed 13–14 pages covering "roughly the
  95th percentile", quoting the *pooled* p95 of 13; both halves came from a distribution inflated by
  the 21 launches taped over 300s. **The tail is dropped, not silently truncated:** a launch
  that spends its cap without reaching the mint is reported `DROPPED` with its own note, and the
  sampling bias is stated, because the launches too busy to walk are exactly the interesting ones.

### Coverage is a proof obligation, not an assumption

Rows come back newest-first, so the create slot is the **last** thing a backwards walk reaches. A
walk that stops early still returns a plausible-looking pile of fills whose earliest slot is simply
the earliest one it happened to see — and `measureCreateSlot` would then anchor on that slot, call
some mid-window sniper "the deployer", and report a confident room figure for a launch whose opening
it never saw. Nothing about the output would look wrong.

So `readLaunchWindow` sets `reachedCreateSlot` **only** when the endpoint explicitly said there was
nothing older: a `pagination.hasMore` of exactly `false`, or a readable page with no rows on it.
Anything else is `usable: false` with a specific `dropReason`, and an unusable window is **dropped
and counted**, never measured. This is the same distinction the population tape draws with
`meta.reached_mint`, which the repo's loader gates on because all 239 mints have a window file and
four of them never reached the mint.

Two shapes that are explicitly **not** proof, because both used to be read as if they were:

- **A missing `pagination` object.** The endpoint has served a bare array and `data`/`items`/
  `results` wrappers across versions, none of which carry one. Treating an absent `hasMore` as
  `false` would have stopped the walk after page one and marked a partial window usable.
- **A body we cannot read at all.** "We do not understand the answer" is not "there is nothing
  older", and collapsing the two would let an unparseable page on page 2+ certify the fills already
  in hand.

### The mint time is a seek hint, not a boundary — and a pre-mint row is a DISAGREEMENT

`createdAtMs` comes from MadeOnSol's `pump_tokens[].created_timestamp`; the fills come from pump.fun.
A real token has no pre-mint trade, so a row older than the recorded mint means **the two clocks have
come apart**, not that the walk arrived. Measured on the committed tape: **0 of 235 covered launches
has a fill older than its recorded creation, and the gap to the first fill is exactly 0 on every one
of them.** There is no slack for a tolerance — one millisecond of positive skew would delete the
entire create slot, whose rows share the mint's exact millisecond, leaving the walk anchored on a
mid-window slot with the wrong deployer, a near-zero dev buy and an inflated room figure. So such a
launch is **dropped**, with `dropReason: 'mint-time-disagreement'`.

Separately, the measured window is trimmed by `windowFilter` — **`windowSlotSpan` slots from the
earliest curve buy** — so the vendor timestamp never decides which fills are in it. Slots are the
chain's own monotonic sequence; the wall clock is a second opinion with nothing to reconcile it
against.

The span is **pinned at 160 slots and is deliberately not `ceil(60000 / 400) = 150`.** Measured over
the 210 committed 60-second launches, the observed slot span is p50 151, p90 155, max 158, and 51% of
them hold at least one fill beyond `createSlot + 150`. Those trailing fills are disproportionately
late sells, and dropping one flips a wallet from closed to open — which shrinks
`fieldClosedRoundTrips`, itself a gate at `minFieldRoundTrips: 10`. A too-narrow span therefore moves
gate outcomes silently. 160 covers 100% of observed windows with margin over the observed max.

**The other direction, on the record rather than as an objection:** at the observed rate 160 slots is
~63.5s, so the live window is up to ~3.5s *wider* than the tape's 60s windows, and the extra late
sells make realised P&L read better than the ground-truth recipe would. Because the field leg is
veto-only that **loosens rather than tightens** — a too-generous field can only fail to veto, never
earn a verdict — and the magnitude is small. That last claim is **cited, not measured here**: the
figure that carries it (the margin sits at the thinnest part of the window, p50 18 / p95 52 fills in
the last 5s) comes from the PR #7 review comment that recorded this tradeoff, which supplied it
without naming a population, and it is not reproduced anywhere in this repo — unlike the span
figures above, which name theirs. 160 was chosen on measurement, so no change is implied.

**Which of the two conversions of 160 slots to read.** The ~63.5s above is the **tape's own observed
rate** (~397ms/slot, from 60s ↔ p50 151 slots), and it is **superseded** by the 71,448ms figure
below, which converts the same 160 slots at the **measured worst-case** 446.55ms/slot. Both describe
the same span; they differ only in the rate, and the chain's rate rose between them. Re-deriving the
~63.5s conversion and the ~3.5s-wider claim that rests on it is **a separate lane's**, so the older
number is left standing here rather than silently updated — read it as history, and read 71,448ms as
the bound anything in force is measured against.

**Stage 0 deliberately does not use the span**, and the two paths must not be reconciled: it measures
each committed launch over that launch's own stored window, because `wallet_launch_pnl.csv` — the
1,322-pair reproduction that licenses believing the live recipe at all — is computed that way. The
comment at `stage0.mjs` → `measureSubjectLaunches` says so at the point of divergence.

### The mirror case: a mint time that seeks EARLY

A vendor mint time running *early* trips no tripwire — there are no pre-mint rows — and instead
truncates the **tail** of the window, because the seek never asks for the last rows. It is not
detectable after the fact: launches routinely stop trading before the nominal window end (observed
p50 span 151 against a 160-slot window), so any tail detector fires on nearly every launch and
carries no information at all.

So it is designed out rather than reported. The walk seeks from `createdAtMs + windowReachMs(...)` —
`max(windowMs, ceil(windowSlotSpan × MAX_MS_PER_SLOT)) + seekMarginMs`, **85,000ms** at the pinned
values — i.e. a reach derived from the SPAN at a measured worst-case slot rate
(`MEASURED_MAX_MS_PER_SLOT` 446.55 × `SLOT_RATE_MARGIN` 1.1 → `MAX_MS_PER_SLOT` 500), with `windowMs`
surviving there only as a floor. **This margin is added on top of that reach and it no longer places
the cursor**; its own job is unchanged, clock slack of **5s** against a vendor mint time running
early, so an early skew smaller than that cannot cut the tail off before the slot trim ever sees it.

The cost is bounded and it is no longer one page. Reaching 85,000ms rather than 65,000ms moves the
page cost over the 127 committed launches that can show the effect from p50 5 / p90 7 /
p95 8 / max 14 to p50 6 / p90 8 / p95 9 / max 17, so **4 of 127 = 3.1%** now exceed the ~16 pages
the cap affords and are dropped as `request-cap`, where it was **0 of 127**. `pumpfun.mjs` →
`windowReachMs` owns the page-cost story and `test/deployer-screen.test.ts` pins these same figures.

#### What a dropped launch costs

The consequence is the candidate's, not the launch's — and how much it costs is the gap between
`maxLaunchesPerCandidate` (how many launches the stage **plans**) and `minLaunchesSampled` (how many
it must **score**). **Captain decision 190a, 2026-08-04, made that gap two**: the stage plans 10 and
needs 8, so a candidate absorbs two dropped launches — to the request cap above, to an unproven
create slot, to any cause — before it returns `entry-unmeasured` outright.

When the widened reach landed, the two were the same pinned value of 8 and the gap was **zero**: one
drop among a candidate's 8 planned launches left 7 sampled and silenced the whole candidate. Naive
independent-launches **estimates**, not measurements, at the tape's 4-in-127 cap-hit rate: **22.6%**
of candidates lost their verdict at zero slack, **3.1%** at one spare launch, **0.32%** at two. One
spare launch was not enough because drops **cluster** — a launch is dropped for being busy, and busy
launches cluster on busy deployers — so the binomial understates the real rate exactly where it
matters. That is why the gap is two and not one. The base rate itself comes from one deployer's
long-window launches, so none of these is an answer rate for a stranger.

**Those three figures are the request-cap component only, and 0.32% is not the full-day run's
expected no-verdict rate.** They are computed from the 4-in-127 page-cost drop rate and nothing else.
The dominant cause for a stranger is the other one: `census/2026-08-03-bundling-census.md` measures
per-launch proven at **44 of 112 = 0.3929** under the union predicate, and **0 of 13 strangers**
proven on all eight (1 of 14 counting our own control, which is the one). At ~39% proven per launch,
8-of-10 proven is not reachable for a typical stranger, so the run's no-verdict rate is governed by
`roomIsProven`, not by anything pinned here. The raise **does** help that dominant cause — the same
census recorded 3 candidates sitting at 7 of 8, which a two-launch gap now reaches — but this lane
does not quantify it, and the pinned figure must not be read as if it had.

**A ceiling this lane does not close.** Decoupling the cap from the floor creates a verdict shape
that was structurally impossible at 8-and-8: a candidate scored on 8 of 10 launches whose 2 missing
launches were selected **by drop cause** rather than at random — request-cap drops fall on the
busiest launches, `roomIsProven` drops on launches with no co-ordination evidence. At 8-and-8 such a
candidate returned `entry-unmeasured`; it now returns a verdict computed over a non-random
subsample. That is the same shape this tool refuses to read elsewhere — the cost leg discards a
ceiling-truncated launch *whole* because a truncated walk holds the earliest entrants by slot, and
`minPricedFraction` exists for the same reason.

**The direction of that bias is unmeasured**, and the attempt that failed to settle it is the
evidence: over the 235 committed launches the rank correlation between per-launch fill count and
`roomLeft` is **0.0250**, i.e. negligible; the busiest quartile's median `roomLeft` is **0.3032**
against the quietest quartile's **0.2771**, which points one way; but dropping the busiest 7 of 235
(the 3.1% request-cap rate) moves the median `roomLeft` **0.3146 → 0.3314**, i.e. *up*, toward
enterable, which points the other way. Two statistics, opposite in sign, on n = 1 deployer. On this
tape it changes no verdict, because that 0.3146 median sits 0.24 **below** the `minRoomLeft` bar of
0.55 — but n = 1 says nothing about a stranger sitting near the bar. So the standing bar (*a null
result is an acceptable result, a false positive is not*) is **not discharged** for this new sample
shape by this lane. Captain decision 198b accepted that knowingly and split the work: a
refuse-near-the-bar guard is a separate filed lane blocked on this one, and the full-day screen run
blocks on **both**, so the unguarded shape is never what that run uses.

**How those four figures were derived, and the limit on them.** The population is the 235 committed
launches as returned by `stage0.mjs` → `measureSubjectLaunches` over
`population-tape-2026-07-29`. The two per-launch quantities are its **fill count** (busyness)
and its `createSlot.roomLeft`. The correlation is a **rank** correlation over those two; the
quartiles are cut **by fill count**; and the median shift is the median `roomLeft` over all 235
against the median with the **7 busiest removed**, 7 being the 3.1% request-cap rate applied to that
population. **This was a one-off derivation by this lane and no committed check reproduces it**, so
unlike the page-cost model beside it these numbers can go stale silently. That is part of the honest
record rather than a footnote: the follow-up guard lane should land them as a check if it needs to
depend on them.

The floor was **not** the adjustable half: closing the gap by lowering `minLaunchesSampled` would
weaken the evidence a verdict rests on rather than give it headroom, and 190a names the direction.
**No bar moved** — every scored launch clears exactly what it cleared before; two more are offered.
The cost is requests: the stage arithmetic went `3 × 8 × 18 = 432` to `3 × 10 × 18 = 540` (and to
`7 × 10 × 18 = 1,260` when the survivor cap rose on 2026-08-04), and the
ceiling moved with it so the dry run is still the whole exposure. An unmeasured verdict remains *no
answer* and never a rejection, and a drop is counted and reported where the truncated tail was
silent. `thresholds.json` → `stage2_entry.justification.maxLaunchesPerCandidate` owns the arithmetic
and `test/deployer-screen.test.ts` → “THE SAMPLING RULE HAS HEADROOM, and the REQUEST-CAP unmeasured
rate it buys is PINNED” pins the **request-cap component** of that rate, so neither threshold can
move that component silently again. It is not the total: what the full-day run answers nothing at is
governed by `roomIsProven`, and no committed check pins that.

**The margin is a cursor hint and never a proof tolerance.** The pre-mint tripwire still compares
`ts < createdAtMs` with zero slack, and coverage is still discharged only by an explicit
`hasMore === false` or a readable empty page. Widening the margin cannot soften either.

**It does bound one other thing, and it has to: which launches are old enough to measure. Neither
`stage2.mjs` nor `bundling.mjs` derives that bound any more — they ASK their fill source
(`fillSource.minAgeMs`), and the swap-api source answers with this same `windowReachMs` call, so on
every run today the gate is still 85,000ms at the pinned values and still the same call the seek
cursor is placed with.** The gate has to cover the newest instant the walk reaches for, and a launch
has finished happening exactly when that instant is in the past, so making them two expressions is
what let them come apart — and captain decision 260a removed the second expression from the scoring
modules altogether, because a source whose tables LAG must answer a larger floor than its cursor
reach. See "Where the fills come from is INJECTED, and Stage 2 names no vendor" above.

**The tense matters, because this bound has now failed the same way twice.** It was once `windowMs`
alone, which admitted a launch aged 60–65s whose tail had not happened yet — the same truncation this
margin exists to prevent, arriving from the future side, and silent in the same way, because an
absent tail reads as a quiet one. It then became the hand-written sum `windowMs + seekMarginMs` =
65,000ms, correct only while the cursor was also 65,000ms and the 160-slot span was reckoned at a
nominal 400ms/slot (64.0s). Captain decision 144a moved the cursor to `windowReachMs` and left the
sum behind, and the chain drifted past the nominal rate unaided: at the measured 446.55ms/slot
maximum the span alone is 71,448ms, so the sum ran **6,448ms short of the span and 20,000ms short of
the reach** — a launch could be admitted 20s before the cursor's own bound was in the past.

**Raising the constant to 71,448 would have re-armed the identical trap**, because the defect was
never the number: it was writing a *duration* for something the chain controls. The gate derives from
`windowSlotSpan` at a measured worst-case slot rate now — a **pinned** rate, so the gate moves only
when that rate is re-measured against a newer committed tape and the pin is raised. What the
derivation buys is that a chain slowing past the pin **fails the tape-derived guard loudly** rather
than silently widening the gap again, and that raising the pin moves the gate and the seek cursor
together, because they are one call. That shortfall's direction of error was the safe one — an early-admitted launch loses its
late sells, so its field reads *worse*, and the field leg is veto-only — but it is the class of false
rejection that is permanent and invisible, since a graded wallet is filed and never offered again.

**What the correction cost in eligible launches: nothing, on every committed observation.** A
stricter gate admits fewer launches, so the question is which ones it takes away, and the answer is
checked against the records rather than asserted. `runs/2026-08-04.json` — the only committed record
carrying the eligibility block — holds **3 candidates and 178 launch refs, `launchesTooYoung` 0**,
with `youngestRefAgeMs` of 1.95 h, 12.12 h and 61.7 days: the youngest launch any candidate offered
was ~82× the new 85,000ms gate, so **0 of 178 change status**. The bundling census
(`census/2026-08-03-bundling-census.md`, 14 candidates / 112 windows) samples ages with a **minimum
of 0.27 days ≈ 6.5 h**, so its eligible set is unchanged too. The 20,000ms the gate moves only ever
binds on a launch between 65.000s and 85.000s old at the moment it is judged, which nothing observed
here has been. A test pins the run-record half of that; the committed records themselves are **not**
retro-edited, and their `minAgeMs: 65000` is what those runs actually applied.

The old assertion `windowSlotSpan × 400ms ≤ windowMs + seekMarginMs` **no longer exists**: it was
denominated in the variable that did not move — the span never changed, the chain's slot rate did —
so it stayed true and went out of validity with nothing failing. That is this repo's recurring
defect, a claim outrunning its enforcement. Coverage is enforced by the describe block `the seek
cursor reaches the whole declared slot window, at a MEASURED slot rate` in
`test/deployer-screen.test.ts`, which re-derives the slot rate from the committed tapes on every run,
asserts the reach covers the whole declared span, and asserts the eligibility gate **is** that reach —
read out of a live `scoreCandidateEntry` rather than off the source text. Widening the span still
fails loudly, through that block rather than through the nominal-400 inequality.

**And from schema 6 the filter is readable from the record itself, not only from a log.**
`entry.coverage` carries `minAgeMs` (the derived gate, **85,000ms today and `65000` on the committed
schema-6 records**, which is the derivation working rather than a disagreement), `launchesTooYoung`,
`launchesEligible`,
`launchesPlanned` and `launchesDroppedByCap`, so the three quite different reasons a launch went
unmeasured — too young, dropped by our own per-candidate cap, or never reached — are separate
numbers rather than one gap between `launchRefsAvailable` and `launchesAttempted`. It also carries
`youngestRefAgeMs` and `youngestEligibleAgeMs`: read beside `minAgeMs` those say whether a run
**exercised** the boundary or sat hours above it. The committed live run sat about five hours above
it, which meant it confirmed the property without discriminating the gate from its absence — and a
reader of that record had no way to know.

**Every run reports its drops per cause, per wallet and in total**, in the record (`entry.coverage.dropsByReason`
and the run-level `entryDrops`) and in the rendered output. A non-zero
`mintTimeDisagreement` is treated as a **reportable event, not a footnote**: all 235 clock
observations come from our own tape, where the gap is exactly 0, so whether MadeOnSol's
clock agrees with the fill tape on *stranger* wallets was an open question. If they routinely disagree, the
tripwire stops being free and starts discarding real launches at scale — and a visible per-run count
is what stops that happening silently. **The first full-day default run fired it: 6 windows on one
stranger candidate, the drops that took it from 10 planned windows to 3 walked.**
`runs/2026-08-04-full-day-default.md` → *"Two things that went wrong in the plumbing"* owns that
observation, what it does and does not prove about the cause, and the open question of whether
Stage 2 should backdate as the census does. Nothing about this tripwire changed.

**On the other vendor pair that has now been walked, they routinely DO disagree.** Driven from
`frontend-api-v3`'s millisecond-precision `created_timestamp` instead of MadeOnSol's, the tripwire
dropped 5 of 8 launches on the first candidate the bundling census walked — which is why that pass
backdates the declared mint by `bundling_census.mintTimeBackdateMs` before calling this walk. The
measurement, what the backdate costs and why it cannot reach a create slot are in
"The bundling census" below; nothing about this tripwire changed.



### The live path, checked against ground truth

`readLaunchWindow` + `measureLaunchEntry` were run against the **live** `swap-api` endpoint for
committed launches and compared with the same measurement computed from the stored tape:

| launch | pages / requests | fills live vs tape | deployer | create slot | room left Δ | field set | closed RTs | max realised Δ | max queued-ahead Δ |
|---|---|---|---|---|---|---|---|---|---|
| `Restoration` 2026-07-28 (the busiest committed window) | 12 / 12 | 1,105 vs 1,106 | match | match | **0.00** | match | 8 vs 8 | **8.9e-16 SOL** | **0.0** |
| `Shiro` 2026-05-12 | 5 / 5 | 481 vs 481 | match | match | **0.00** | match | 10 vs 10 | **1.8e-15 SOL** | **0.0** |

A third, much older launch shed persistently through all three attempts and the walk correctly
failed — which in a real run is a *dropped launch with a note*, not a corrupted measurement. That is
the drop path working.

**One comparability caveat.** A live run measures a fixed **160-slot** window from the create slot,
not a wall-clock one. Stage 0's control measures over each launch's own stored window. Against the
210 committed launches whose stored `window_ms` is 60000 — the tape's modal value — a 160-slot span
covers **100% of the observed spans** (p50 151, p90 155, max 158), so the live window is at least as
wide as the stored one on every one of them. The remaining 25 launches store 120s or 300s windows,
which are wider still. Longer windows give a position more time to close, so Stage 0's
closed-round-trip count is if anything *more* generous than a live run — which strengthens the
known-negative control rather than weakening it.

## Scope: what is and is not built

**Built — Stage 0**, local validation, no network. Asserts that the gate **passes** our own subject
deployer (0.4310 over 239 launches), which is the point: that wallet's opening window has been
unprofitable for outsiders since 2026-06-04 because its own group takes 97% of the profit there. A
gate that passes it is a gate that measures competence, and Stage 0 makes that concrete instead of
claiming it. Also checks ground truth has not moved, that the curve inversion is exact (max error
1.4e-14 SOL over 70 control launches), that Stage 2's create-slot primitive still reproduces the
published §5.1 era split, that its field measurement still reproduces `wallet_launch_pnl.csv`, and
that Stage 2 still **refuses** the wallet the gate passes.

That last check now asserts a **minimum n per era and a finite median** before comparing. It has to:
`median([])` is `NaN`, `Math.abs(NaN - published) > 0.02` is `false`, so an era bucket matching no
launches used to record no failure and report **PASSED** — and a passing Stage 0 is what authorises
spending keyed quota on strangers. Anything that empties the filter (renamed window files, every
`reached_mint` false, a `--data-dir` pointing at a differently dated tape, a shifted date range) hit
exactly that case. The buckets hold 45 and 89 launches as committed. Era 2 read 86 until captain decision 182a,
because the split is filtered on `roomIsProven` and three era-2 launches carried no bundled
create-slot transaction; the union rule marks all three by the deployer-anchored block-index run, so
the era is whole again. The floor is 20.

**Built — Stage 1**, the keyed gate: enumerate, compute the rate ourselves, apply pinned thresholds.

**Built — Stage 2**, the ENTRY score. Room in the opening window, what the field there achieved,
and what it cost them to land. Keyless throughout, and it spends no vendor quota. Stage 0 validates
it five ways before a single request is issued:

| check | result on the committed tape |
|---|---|
| the create-slot primitive reproduces the published §5.1 era split | operation share 0.4508 → **0.7708** against a published 0.451 → **0.771** (see below) |
| the **field** measurement reproduces `wallet_launch_pnl.csv` | **1,322 create-slot outsider pairs, 0 closure mismatches, max realised error 5.0e-7 SOL** (1,502 before decision 182a — the 180 it drops are the operation's own wallets) |
| **the known-negative control**, at two points in time and once more with costs attached | see below |
| **the rolling replay**, at every point in time | **226 trailing windows, 0 false positives and 0 false negatives**, **0** refused as unmeasured (62 before decision 182a) — see below |
| **the adjacency tripwire**, on the `sid` block-index signal | **15 pre-March launches, all 15 producing a run of 2+ transactions** (shortest 4), 122 create-slot fills decomposed with 0 unreadable indices and 0 prefix mismatches, **45/45 cohort wallet-instances recovered, 0 non-cohort marked** — see below |
| **the cost leg**, against `onchain_create_slot_pnl.csv`, over the population the gate itself scores | **112 launches, 766 create-slot entries, 627 round trips priced end to end**; median entry cost **0.0308 SOL**; hit rate **0.7384 gross → 0.6045 net**, **87** round trips flipping sign — see below |

Note one consequence of the union for that last row: on **this** tape nothing is unproven, so the
gated and unfiltered readings coincide (`includingUnprovenLaunchesPriced` 112 = `launchesPriced` 112).
The keys stay, and they will separate again on any tape carrying a launch neither half of the rule
marks — which is the case they exist for.

#### The adjacency tripwire, and why Stage 0 needs one

Half (b) of the co-ordination rule reads a block transaction index out of pump.fun's `sid`. **If that
format moves, the signal does not error — it evaporates**: every deployer-anchored run collapses to
length 1 and every launch that depended on adjacency silently goes back to UNPROVEN. That is the safe
direction, which is exactly the problem, because nothing else in the screen would report it and
Stage 2 would just start answering less often for a reason no output names.

The population is the subject's **pre-2026-03** launches, and that choice is load-bearing: over that
stretch the shared-transaction rule recovers **0 of 45** cohort wallet-instances, so adjacency is the
only thing carrying the result and a collapse cannot hide behind half (a). `stage0.mjs` →
`verifyAdjacencyRuns` asserts four things — every launch still produces a run of 2+ transactions; the
`sid` decomposition still holds (its leading field is the fill's own slot, no transaction carries two
indices); the recovery is still 45 of 45; and it still marks **nobody else**. The last one is the
opposite failure — indexes colliding rather than vanishing would sweep the whole create slot into the
run — and that one is *not* in the safe direction.

#### The cost leg is regression-tested offline, using the live attach function

The committed on-chain table is `api.mainnet-beta`'s answer, recorded: per (mint, transaction,
wallet) it carries the transaction's whole fee attributed to its payer and the named wallet's real
lamport change. `stage0.mjs` → `readOnChainCosts` projects it onto exactly the shape
`parseTransactionCosts` returns from a live `getTransaction`, so **`priceLaunchEntry` — the
production attach — runs over committed ground truth**. One code path, two sources, as for the room
and field legs.

It asserts the two things a wiring error breaks silently: that netting measured fees moves the field
**down**, and that the seat is not free. A sign error in the lamport delta would raise them instead —
silently, and in the one direction the captain's tiebreaker forbids.

**What it deliberately does not assert, because it is not true:** that the net field leg vetoes our
subject. Post-break its priced round trips are still 0.64 positive at a median +0.05 SOL net, so the
after-cost field would pass it. `7ufmve7Z…` is refused by **room**, which is exactly why room is the
gate and the field is only ever a veto — and pinning a property the evidence does not support would
make the control a decoration.

#### The era-2 constant is pinned at 0.771, and the tolerance is not the fix

The published era-2 share `0.768` is **not the median of its own stated population**: the 89-launch
series has median `0.7708`, and `0.768` is its rank-43/44 order statistic. Three independent recipes
read `0.771`, one of them this repo's own committed
`node analysis/window-population/measure.mjs`. The full decomposition, including what population
*does* produce `0.768` and why that population is internally inconsistent, is recorded in
`population-tape-2026-07-29/IMPORT.md` → "Corrections" — the primary record's report is not
edited, per this project's own rule.

Why re-pin rather than widen the ±0.02 tolerance (captain **decision 135c**): the tolerance had been
absorbing **two errors of opposite sign that partially cancelled** —

```
published                                              0.768
+ the published cell is 1-2 ranks below its own median   +0.0028  ->  0.7708   the true value
- the co-ordination rule found nothing on 3 of 89        -0.0115  ->  0.7593   what Stage 0 printed
                                                        --------
net                                                     -0.0087  =  the gap that used to be observed
```

So the check was passing for the wrong reason. Refusing to score an unproven opening removed the
first term; re-pinning removed the second. **Captain decision 182a closed the residual.** Era 2 now
reproduces at **0.770796 over all 89 launches** against a `0.771` that has not moved:

| estimator | population | share |
|---|---|---|
| shared-transaction rule | all 89 era-2 launches | 0.759250 |
| shared-transaction rule | the 86 it could prove | 0.769153 — what Stage 0 printed until 182a |
| **union rule** | **all 89, all provable** | **0.770796** — what Stage 0 prints now |
| named-cohort rule | all 89 | 0.770796 — what `0.771` is |

The union recovers every cohort wallet-instance the named-cohort rule knows about on this tape, so
the structural estimator and the cohort estimator become the **same number to six decimals**, over
the full 89 rather than the 86 the older rule could see. The 0.002 that used to be explained away is
gone rather than tolerated, and the tolerance was never touched. The era-1 agreement that confirms it
(0.450771 every way) is in `stage0.mjs` beside the check itself. **Widening the tolerance would have
hidden all of it.**

The `readLaunchWindow` that the previous lane deleted rather than ship half-validated is written
here, against a real caller and against ground truth — see [the live path](#the-live-path-checked-against-ground-truth).

### The known-negative control

Stage 0 asserts the *counterpart* of the gate assertion, on the same wallet:

> **The gate must PASS `7ufmve7Z…`, and Stage 2 must REFUSE it.**

That wallet is competent — 103 of 239 launches bonded — and it is **not beatable**. That is measured,
in `data/slot-zero-june-regime-change/report.md`, not assumed: since 2026-06-04 its own group takes
97% of the profit available in its opening window, and the entire outsider population there has made
+0.54 SOL per launch with 51 of 106 wallets losing money.

It is scored two ways, because both readings have to come out negative and they can fail apart:

| slice | verdict | median room |
|---|---|---|
| the most recent `maxLaunchesPerCandidate` launches (10) — exactly what a live run would score today | `entry-room-absent` | **0.278** |
| the whole post-2026-06-04 regime, 89 proven launches | `entry-room-absent` | **0.229** |

**And this is why it is an assertion rather than a threshold comparison:** on that same wallet the
field leg reads 358/469 closed round trips positive. Followed on its own it would call the wallet
beatable. The verdict has to survive a leg pointing the wrong way, and Stage 0 fails loudly if it
ever stops doing so — including if a future lane quietly loosens `minRoomLeft` to fit an output.

#### The rolling replay — the same question, asked at every point in the tape

**The two slices above could not have caught the unproven-opening defect, and that is a fact about
where they sample, not about how they are written.** Both sit inside the months where the
co-ordination rule's half (a) happens to recover 97–100% of our subject's cohort. Over December 2025
– February 2026 half (a) recovered **0%**, and across that stretch the screen reported median room
0.62–0.66 against a true 0.20–0.33 — in a regime whose measured per-launch prize to outsiders was ≈0
(`analysis/window-population/`). That stretch is what half (b) now carries, and the adjacency
tripwire above exists because it carries it alone.

So Stage 0 asks the same question at **all 226 trailing windows** instead of two. The recipe is the
live one, not an approximation of it: median `roomLeft` over the trailing
`maxLaunchesPerCandidate` launches against `minRoomLeft`, a window with fewer than
`minLaunchesSampled` proven launches being unmeasured, exactly as `scoreEntry` would have it. Each
window's verdict is compared with the one the **named** six-wallet cohort gives — ground truth we
hold only because this is our own subject, which is the whole reason the structural rule exists.

| | before decision 134a | with it, half (a) only | with it, under the union (decision 182a) |
|---|---:|---:|---:|
| windows evaluated | 226 | 226 | 226 |
| **false positives** — screen says room, the named cohort says none | **22** | **0** | **0** |
| false negatives — screen MEASURED the window and said none, the named cohort says room | 0 | 0 | 0 |
| windows reported unmeasured — refused, so the screen gave no verdict at all | 0 | 62 | **0** |

**Every count in that table is a property of the window's width**, which is
`maxLaunchesPerCandidate` — so it moves whenever the cap does, and what the check is here to
establish does not. At the 8 that preceded captain decision 190a the same replay slid **228** windows
and read **24** false positives before 134a and **81** refusals under half (a) alone. The zero that
matters is unchanged at either cap.

The last column is what the screen prints today: the refusal is untouched and the rule simply sees
more, so on this tape it never fires (92 windows room-present, 134 room-absent).

**A refused window is counted as `unmeasured`, never as a false negative.** The two are exactly the
distinction the ruling exists to keep apart: a window with too few proven launches carries no
verdict, so there is nothing in it for the cohort to contradict. `falseNegatives` therefore requires
a *finite* median — the screen looked, and said ABSENT — and on this tape there are none of those.
The coverage the ruling costs shows up in the `unmeasured` row, which is where it belongs.

**Only false positives fail the check.** A false negative would not fail either, for the same reason
the refusals do not: a null result is acceptable, a false positive is not. The failure message names
the worst window and points at `roomIsProven`, so a future change that reopens the defect gets told
what it did rather than a bare number. Offline, free and deterministic like the rest of Stage 0.

**Not built — the exit trap (stage 3).** Room to enter is not room to leave. When the dev sells
relative to mint and to outsider inflow, whether the trigger is a **size** (which would cap our
position size, because our own buy counts towards it), and whether an outsider could have exited
first. Entry room and exit feasibility are scored **separately and never collapsed**, and no exit
signal reaches any number Stage 2 produces. Its own lane, and it is blocked on this one.

**Built — the prediction-grading loop.** Every run records what it predicted, and `grade.mjs` scores
those claims against launches the wallets made afterwards. See
[The feedback loop](#the-feedback-loop--the-screen-grading-its-own-predictions).

**A Stage 2 run record is committed**: `runs/2026-08-02-good.json` scored 3 gate survivors on live
fills, and `runs/2026-08-02-good-vs-elite.md` reads it. It is a **schema-3** record and it carries
this tool's first `entry-room-present` verdict on a stranger wallet; that document states the five
reasons the verdict is marginal — it is one candidate worth a closer look, not a finding. **Read
that verdict as its schema means it**: room was present and the price of the seat was never
measured, which is not what a schema-6 `entry-open-after-costs` says. It is committed evidence and
is never retro-edited, so the reader is what has to be correct. The `--dry-run` output
and the live-vs-tape check above remain the keyless evidence that the walk is the same code path.
**A second Stage 2 record is committed and it carries no verdict at all**: `runs/2026-08-04.json`
(schema 12) returned `entry-unmeasured` on all three candidates it scored — see *"The third
committed run"* above and `runs/2026-08-04-full-day-default.md`.

## The feedback loop — the screen grading its own predictions

`node tools/deployer-screen/grade.mjs`. The captain's requirement, in his own words: *"we do the
same research in a repeatable way … then loop the process continuous getting better"*. Bounds are
`thresholds.json` → `feedback_loop`; the shape of a claim is `prediction.mjs`, the grading arithmetic
is `outcome.mjs`, and the ledger it keeps is `feedback/grades.json`.

**Why it is an accuracy property and not a feature.** A run that did not record what it predicted can
**never** be graded — not "gradeable later", never — because neither the claim nor the instant it
stops being in-sample survives anywhere else. Every run committed before record schema 16 is
therefore permanently unfalsifiable, and that is a property of those records rather than a
shortcoming of their measurements. Run `grade.mjs` today and it says so: **zero gradeable claims
across all three committed records**, two refused by verdict vocabulary and one — `runs/2026-08-04.json`
— a modern record whose every scored candidate reached an unmeasured verdict.

**The default costs nothing.** A bare invocation is a dry run: it reads the committed records and the
ledger, prints the hit rate so far and the exact plan a live run would spend, and opens no socket.
`--live` is the only way to reach a provider. So the thing a captain reruns — *is the screen getting
better* — is free, and only measuring a new outcome costs.

**What "what actually happened" means.** This repo does not trade, so the only available ground truth
is the same instrument pointed at launches the prediction did not see: `grade.mjs` re-measures
**Stage 2** over the deployer's post-prediction launches and compares the verdict it reaches with the
verdict the screen predicted. Three properties keep that honest and all three are structural:

- **Strictly out of sample.** Only launches created after the claim's `madeAtIso` are measured, and
  the boundary is a *proof* rather than a convention — Stage 2 refused every launch younger than its
  fill source's own eligibility gate at the instant it chose its sample, and that instant precedes
  the run's `finishedAtIso`. A test asserts against the fetched URLs that no pre-boundary launch is ever walked.
- **Same recipe, same bars.** The outcome is scored at the `stage2_entry` / `stage2_cost` values the
  **predicting** run recorded, never at today's. A record that cannot supply them leaves its claims
  `recipe-unusable` rather than being graded against a screen it never was. `scoreCandidateEntry` and
  the grader are one implementation — `stage2.mjs` → `scoreLaunchRefsEntry` — because a grader with
  its own copy of the walk would drift from the screen it grades and the drift would surface as a hit
  rate rather than as a failure.
- **An unmeasured outcome grades NOTHING.** Captain decision 174b applies on this side too: an
  unmeasured verdict is a fact about our coverage, so the claim stays ungraded and stays **out of the
  denominator**. Counting it as a miss would make the screen score worse the flakier pump.fun's
  endpoint was on the day the grader happened to run. The ungraded tally is published beside the rate.

**An unmeasured verdict is not a prediction either.** `prediction.mjs` routes every claim through
`entry.mjs` → `isDeployerAttributable`, so only the four MEASURED verdicts become one. Reading
`entry-unmeasured` as "not beatable" would let the screen score itself right whenever its own budget
ran out — 174b's failure mode wearing a hit rate. The two ways a claim can be absent are kept apart:
`not-scored` (Stage 2 never ran on this candidate) and `entry-unmeasured` (it ran and could not
answer).

**Idempotence, stated as the property it has to have.** Every grade has one identity — *(source
record, wallet, subject)*, so the same wallet predicted by two runs is two claims. A `hit` or a `miss`
is **latched** and never revised: a lane that rewrote its own past grades would be marking its own
homework twice. An `ungraded` row is retried only after `feedback_loop.retryAfterDays` — reported as
`awaiting-retry`, which is a **different** reason from `not-attempted` (the per-run claim cap), so a
report never announces a ceiling that bound nothing. Two runs over the same inputs write the same
bytes, and the ledger is written atomically through a temp file and a rename: a run killed mid-write
leaves the old ledger intact rather than a truncated one. A ledger that exists and cannot be read —
corrupt, or from a schema this build does not know — **refuses the run** rather than starting over,
because a latched grade has no other copy and an empty ledger would be written straight back over it.

**Every provider call is bounded, and the plan is refused before the first request.** One keyed
MadeOnSol profile per claim (ceiling 6 — 3 claims × the client's one retry), the keyless fill walk
against 540, and the entry-cost leg against 1,500 Solana RPC requests. The plan is priced from each
claim's **own** recorded recipe, and a plan that does not fit is refused **whole** — never truncated
to fit, because a Stage 2 walk cut short holds the earliest entrants by slot, which is a biased sample
rather than a short one. `thresholds.json` → `feedback_loop.justification` owns every value, including
the daily arithmetic (6 keyed requests of the 100,000/day allowance) and the fact that this lane
is operator-run rather than scheduled.

**It re-tunes nothing.** No bar in `thresholds.json` moves for it — `minCompletionRate` is still 0.25,
`minTokens` 25, `minSpanDays` 14, `minRoomLeft` 0.55 — and a test pins that a run's verdicts are
identical with the prediction block present and absent. A lane that adjusted the screen it grades
could not be read as evidence about that screen.

**Stage 3 is deferred, not cancelled** (captain decision 237a). No exit claim is made or graded, and
the record *declares* that absence: `predictions.subjectsDeferred` names `exit` as a subject this
build deliberately did not predict, so a grader can tell "the stage did not exist" from "the stage
could not measure it". Claims are a list keyed by subject, so a later build appending an exit claim
invalidates no record written under schema 16 — a schema that forced a reset would waste every run
recorded in between.


## The bundling census — a windows-only pass, and what it is sizing

`node tools/deployer-screen/bundling.mjs` (captain decision 173a, 2026-08-03). Full method in that
file's header; the pinned bounds are `thresholds.json` → `bundling_census`; the committed run is
`census/2026-08-03-bundling-census.json` and its report is
`census/2026-08-03-bundling-census.md`. **The census writes to `census/`, never to `runs/`**: that
directory is the screen's own versioned contract, asserted per schema version, and `buildCohort`
reads it back as a cohort source.

**Its predicate is `measure.mjs` → `roomIsProven` — the UNION — and it CALLS that function rather
than copying it.** Captain decision 183a re-ran the census under decision 182a's widened rule, which
is what schema 2 of the record is. The first run (173a, schema 1) measured the **shared-transaction
half alone** and froze a local copy of that predicate, and the freeze is exactly how the record came
to need a caveat: a census carrying its own copy of the rule can drift from the screen it is a
finding about. Both halves are now reported per launch — `bundledTx` and `runTx` — so **the
superseded reading is recoverable from the new record without re-walking a window**, and
`PREDICATE_CAVEAT` puts the rule beside the rate everywhere the rate goes.

**The problem it measures, which is arithmetic before it is observation.** `stage2_entry` pins
When this pass ran, `maxLaunchesPerCandidate: 8` and `minLaunchesSampled: 8` were deliberately
equal, and since #17 a launch whose create slot the co-ordination rule marks nothing in is refused as
unproven (`measure.mjs` → `roomIsProven`, captain decision 134a). Multiplied out: **Stage 2 could
only reach a verdict for a candidate whose most recent 8 eligible launches were every one marked, and
one unmarked launch in eight silenced the whole candidate.** The live evidence for how large a
population that silences was **two strangers**, because `maxCandidatesScored` was 3 at the time and one of the
three was our own control.

**That premise has since moved and this pass has not been re-run under it.** Captain decision 190a
raised the cap to 10 against the same floor of 8, so the live rule is 8 proven of 10 planned and this
census's all-of-8 headline is **stricter than what Stage 2 requires** — it understates how many
candidates are scoreable, the safe direction for a finding of this shape. A census record is never
retro-edited; re-running it under the new cap is a separate decision.

A re-run would follow the cap but **not** the rule. `bundling.mjs` re-pins no window parameter, so it
would plan the 10 launches Stage 2 plans — but its `fullSample` headline would still demand 10 of 10
proven, where Stage 2 requires only 8 proven of 10 planned. The launch **count** follows
`maxLaunchesPerCandidate`; the **predicate** does not follow `minLaunchesSampled`. The census's
re-run predicate is therefore deliberately stricter than the live rule, in the same understating
direction, and reconciling the two is a separate decision.

**What the pass does, and what it deliberately does not.** It walks create-slot windows with Stage
2's own pinned window parameters and reports only `bundledTx`, `runTx`, `maxWalletsInOneTx`,
`adjacencyMarks` and the union's mark count per launch. No entry score, no room figure, no field, no
entry cost, no verdict — a test asserts that `measureLaunchEntry`, `scoreEntry` and the cost leg do
not appear in its executable half. **It measures and it does not tune:** no threshold moves on the
strength of what it finds, and the pinning decision returns to the captain with the number.

**It re-pins no window parameter.** `windowMs`, `seekMarginMs`, `windowSlotSpan`, `tradePageLimit`,
`maxLaunchesPerCandidate`, `maxRequestsPerLaunch` and the swap-api pacing are read from
`stage2_entry` unchanged, because the number only means something if the census measures the same
launches Stage 2 would have refused. A test asserts the census block carries none of them.

**It spends no keyed request, and that is structural.** There is no keyed client in the file — a
test asserts `BoundedClient`, `DuneClient`, `SolanaRpcClient`, `credential.mjs` and `process.env`
are all absent. Its two inputs are keyless: the cohort is read off disk from `feed/ledger.json` and
`runs/*.json` (wallets whose keyed cost was already paid), and each candidate's launch list comes
from `readCreatorHistory` on `frontend-api-v3.pump.fun`. So the MadeOnSol, Helius and Dune
allowances are untouched by it and the bound it declares in advance is a zero.

**The gate it applies is the OWNERSHIP reading, and that reading is biased in BOTH directions at
once** — the same bias `FEED.md` → "It is biased in BOTH directions at once" states for the feed,
and the same reason this pass does not carry the creation-derived walk (~100 keyless RPC per
candidate). It **rejects** through the count bars — **20 of 82** wallets clear
`minTokens`+`minSpanDays` on the vendor page against **66 of 82** on the creation-derived reading —
and it **inflates** through the rate, which reads *higher* than the gate's on **37 of 81** wallets
(lower on 29, median difference 0.0000) and by up to **+0.6929**
(`slot-zero-gate-bar-measure-own-population` §2.1/§2.3, held in firstmate's records, not in this
repo).

So a census survivor is **not** a survivor on "the harder of the two readings": the vendor reading
is harder on the count bars and *easier* on the rate, and the surveyed population is **neither a
subset nor a superset** of what a keyed Stage 1 would have passed — it overlaps both ways. The
disproof is in this repository: in `runs/2026-08-04.json`, `FnW6MLyu…` and `DxQ1iNid…` are both
`vendorVerdict: "gate-passed"` while `gate-failed` on the creation-derived reading. Every cohort
member is re-gated by the pass; the verdict this repository's own keyed runs recorded travels
beside it for comparison and decides nothing.

**Four caveats travel with every number**, into the dry-run plan, the record and the rendered
summary — the requirement `LANDING_TIP_CAVEAT` set, for the same reason:

- `PREDICATE_CAVEAT` — **which co-ordination rule produced the number.** This census has now been
  taken under two, and a rate quoted without its rule is the same failure as a fraction quoted
  without its denominator. It also states the direction: half (a)'s marked set is a subset of the
  union's, so every schema-1 figure is a **lower bound** on what the screen can now prove.
- `OWNERSHIP_LIST_CAVEAT` — a listed token may have been **acquired** rather than created (its
  create slot is then somebody else's bundling habit), and a token **handed on is missing**, and the
  ones handed on are the winners. Measured size of that gap on the five wallets holding both
  readings: nil (`CREATION-DERIVED.md`).
- `DROPPED_WINDOW_CAVEAT` — a window that could not be walked back past the mint is **dropped, never
  counted as unbundled**. Counting an unreachable create slot as "no bundle" would manufacture the
  very finding the pass is measuring.

**`--subject-era` answers the era question where it can be answered, and refuses it where it
cannot.** The live census walks each candidate's most recent `maxLaunchesPerCandidate` launches
(10 since captain decision 190a; the committed run walked 8), which span days to weeks
and cannot carry a trend. The committed population tape can: 235 launches of **one** deployer over
2025-12 → 2026-07, bucketed offline with no request of any kind. That table is a **within-deployer**
trend at n = 1 and the rendered output says so three times, because a within-deployer trend read as
a population one is the "n = 2, a signal not a rate" failure one level up. **It buckets both halves,
and the gap between the columns is the point**: pre-March this operator bundles 0 of 15 while the
union proves 15 of 15, so a shared-transaction-only column reads a rule's blind spot as a deployer's
habit. Whole tape: **235 of 235 proven, 175 bundled**; trailing-8 replay **228 of 228 against 147**.
That replay's span is pinned at 8 and so asks all-of-8 where the live rule now asks 8 proven of 10 —
the stricter question, which understates scoreability; `bundling.mjs` owns why it is left that way.

**The `readLaunchWindow` two-bound cursor never reached this number, and captain decision 144a has
since closed it anyway** — but the wider reach it installed does reach what a **re-run costs**, and
it adds a sampling caveat to any rate this pass publishes. `bundling.mjs`'s header section "The
`readLaunchWindow` bound-mismatch is CLOSED — and this pass inherited its PRICE" owns both halves;
`pumpfun.mjs` → `windowReachMs` owns the reach and the page cost itself.

**The mint instant is BACKDATED by `mintTimeBackdateMs`, and that is a measurement rather than a
habit.** `frontend-api-v3`'s `created_timestamp` is millisecond-precision on older listing rows
while `swap-api`'s fill `ts` is whole seconds, floored, so the declared mint lands up to ~2 s
*after* the launch's own first fill and the zero-slack pre-mint tripwire deletes it — measured live
at 5 of 8 launches on the first candidate walked. `MINT_TIME_BACKDATE_CAVEAT` states what the fix
costs. See the run report §5 and `thresholds.json` for the six-launch skew sample.

### What the union re-run measured, 2026-08-04 (captain decision 183a)

Full report: `census/2026-08-03-bundling-census.md`, record schema 2. **14 gate survivors — the same
14 — 112 windows, 0 dropped, 0 keyed requests, 591 keyless, 0 shed, 60.4 minutes.** The first run
spent 585 keyless over the same shape, so this is the same cost profile, as the decision required.

- **Per-launch proven rate: 44 of 112 = 0.3929** under the union, against **18 = 0.1607** under the
  superseded shared-transaction half. The union added **26 windows by adjacency alone**.
- **Headline — candidates proven on all 8 of their most recent eligible launches: 1 of 14 = 0.0714,
  UNCHANGED**, and **the one is still our own control**. Among the 13 strangers it is **0 of 13**.
- **6 of 14 are permanently unscoreable** — `runTx` 1 and `maxWalletsInOneTx` 1 on all 48 of their
  windows, so **neither** half can ever mark anything. That is down from the first run's 11.
- **5 of those 11 are rescued on at least one window, and they are exactly the five the bounded live
  probe named** (`data/slot-zero-bundling-predicate-question/report.md` §4.1) — an 8-launch sample
  reproducing a 3-launch one wallet for wallet.
- **3 candidates are now one window short** (7 of 8): `3FiWnNDT…`, `5KTX7LZy…`, `AbVkRUfy…`.

**A smaller number than the expected ceiling is the result, not a broken run.** Decision 183a sized
this at "about 1-in-14 to about 3-in-14" from a 3-launch probe and said in the same breath that an
8-of-8 requirement is **harsher** than a 3-of-3 proxy. It measured 1 in 14.

**The binding constraint has changed hands.** Per-launch evidence went 0.1607 → 0.3929 while the
headline went 0.0714 → 0.0714: everything the union bought was absorbed by the all-or-nothing
sampling rule. The predicate was no longer what silenced this population — `minLaunchesSampled ==
maxLaunchesPerCandidate == 8` was. **That question is decision 141a's and nothing here re-opened
it** — and captain decision 190a has since answered the half of it that was answerable without
touching the floor, by raising the cap to 10. The three near-misses this census records at 7 of 8
are exactly the candidates that gap now reaches; what that does to the headline is measurable only
by re-running the pass, which is a separate decision.

**14 is the whole gate-survivor population this repository can reach, not a truncated 20–30** —
the census cap is 30 and nothing was left unsurveyed. Reaching more needs fresh keyed discovery.

**Three cross-checks make the zeros believable**: our own subject reads 8 of 8 with
`maxWalletsInOneTx 3` on every window, matching its tape; the probe partition reproduced wallet for
wallet from an independent sample; and `blockTxIndex` fails **safe** — a `sid` format change or a
duplicated index removes adjacency entirely and falls back to the pre-182a reading, so it can only
ever collapse this number towards the old one.

**No threshold moved on the strength of any of it.** The pinning decision is the captain's; §6 of
the report states what the number implies and stops there.

## The keyless boundary

slot-zero's analysis core under `src/` is keyless by construction, and
`test/loader.test.ts` → *"this repo does not reach the network and reads no credential"* proves it
by scanning the sources for sockets, `process.env` and key-shaped strings. **That guard was not
weakened.** `src/` is untouched by this tool, so it passes unmodified; the one change was to make its
file scan **recursive**, which is a strengthening — it previously scanned only the top level of
`src/`, so a future `src/net/client.ts` would have gone unread.

The boundary is the directory, and `test/deployer-screen.test.ts` asserts the other half of it:

- `src/` may not import from `tools/`, and `tools/` may not import from `src/`. The duplicated curve
  constants in `measure.mjs` are this boundary's cost, paid deliberately.
- Only `client.mjs` and `pumpfun.mjs` may call `fetch`.
- Only `credential.mjs` and `screen.mjs` may name `MADEONSOL_API_KEY`, `HELIUS_API_KEY` or
  `DUNE_API_KEY`, and the allow-list is asserted for **ownership** too: those files must name them,
  so the guard cannot pass by the variables quietly disappearing.
- **No committed file under the tool may contain a key-shaped string** — every file, not only the
  sources. `runs/*.json`, `thresholds.json` and this README are where an accidental paste would most
  plausibly land, and a source-only filter never read any of them.
- **No committed file may assign a value to a credential variable or hard-code the auth header.**
  This is what covers the Dune key: 32 alphanumeric characters is structurally a Solana address, so
  adding it to the shape scan would fire on every mint in the tree, while this scan catches the
  realistic paste with no false positives.

## What the output does not claim

Every rendered surface carries the limitation block, and it is not boilerplate — a table read out of
context is exactly how a gate becomes a recommendation.

Completion rate alone establishes no tradeable edge. The standing bar for a signal of this class is
real lead time, independence of the actors, and realised profit reported as a distribution plus a hit
rate. **Stage 2 clears the last of those three gross of fees only, and clears neither of the first
two.**

A high completion rate does not imply a profitable entry, and **a profitable-looking field does not
imply one either.** We hold the counterexample to both, on the same wallet: our subject deployer
completes 43% of its launches, gross of fees 76.3% of the closed round trips in its opening window
are positive, and fee-inclusive that window has been unprofitable for outsiders since 2026-06-04
(`slot-zero-june-regime-change/report.md` §5, §6.1). Stage 0 shows the gate passing it and Stage 2
refusing it.

**Everything Stage 2 reports about profit is an upper bound.** The fill tape has no priority fee, no
landing tip, no venue fee and no rent in it. And exit is not measured at all — an entry with room in
it can still be a position you cannot leave.

The rate is computed over roughly 35 days and about 70 tokens. It is a **recency** measure, not a
lifetime record. Long-horizon consistency is reported **UNMEASURED** unless `--consistency` is
passed, because manufacturing a multi-month claim from a 35-day window is precisely the defect we
found in the vendor's own aggregate.
