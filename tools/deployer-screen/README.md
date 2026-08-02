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

## Run it

No agent, no build step, no dependencies. Node 20+.

```bash
# Local validation only. No network, no key, no quota. Always safe to run.
node tools/deployer-screen/screen.mjs --stage0

# Show exactly what a real run would fetch, and fetch nothing.
node tools/deployer-screen/screen.mjs --dry-run

# A real run. Needs a key (see below). Stage 2 is ON by default. Leave --candidates unset: the
# default grades everything enumeration surfaces, up to the budget. Passing a number below the
# ceiling silently truncates coverage, which is exactly how the first elite run graded 12 of the
# 22 wallets it seeded. Budget HOURS, not minutes — up to about 15 at the candidate cap: the
# creation-derived history is walked from on-chain create transactions, and at the pinned bounds
# that walk alone is ~13.5 hours worst case. --dry-run prints the arithmetic for your own flags.
node tools/deployer-screen/screen.mjs --tier elite \
  --consistency --out tools/deployer-screen/runs/$(date +%F).json

# Bound the run instead. The RPC walk is N x 100 x 2.5s, so this is ~40 minutes, not ~13.5 hours.
# It truncates coverage, and the record says so.
node tools/deployer-screen/screen.mjs --tier elite --candidates 12

# The competence gate alone, which answers nothing about whether a window is enterable.
node tools/deployer-screen/screen.mjs --no-stage2

# The old, fast, BIASED reading — it skips the creation walk, so under an hour rather than ~15.
# Stamped historySource: "ownership-only" in the record, because the bias must travel with it.
node tools/deployer-screen/screen.mjs --tier elite --ownership-only

node tools/deployer-screen/screen.mjs --help
```

Exit codes are distinct because the worst failure mode for a screen is an empty result that reads
like a real negative: `0` ran (possibly with zero survivors — a measured outcome), `2` usage,
`3` no credential, `4` credential rejected (401/403), `5` quota (429), `6` ceiling reached,
`7` upstream, `8` Stage 0 failed.

An **HTTP 400 exits `7`, not `4`.** A 400 is our query shape, not the vendor's verdict on the
credential; on a tier where keys expire every 30 days, reporting it as a rejected key would send an
operator to rotate one that works.

A run that stops early still records what it paid for and still exits non-zero. A ceiling hit after
fifteen profiles must not discard fifteen paid-for measurements — re-spending a shared allowance to
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
least gets caught by the beatability screen later. The bias runs the wrong way.

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

So creation is only recoverable from the create transaction, and the only keyless index that
reaches one is the wallet's own signature index. `pumpfun.mjs` → `readCreatedHistory` walks it;
`creation.mjs` parses it.

### What that costs, measured

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

Four rules keep that window from claiming more than it covers.

- **A walk that finished no page covered NOTHING, and an empty window is not a wide one.** The floor
  only advances once a signature page has been inspected whole, so a walk stopped by the
  per-candidate request ceiling part-way through page 1 — the normal outcome for a busy deployer,
  100 requests against 1,000-entry pages — has no floor at all. The record says so with
  `coveredFromIso: null` and `coveredDays: 0`, and the merge then treats **every** listed row as
  outside the window and carries it over unchanged. The whole reading falls back to the ownership
  listing, which is biased towards rejection by a measured ~0 launches (`CREATION-DERIVED.md`) and
  honest. The creates the walk did prove are still counted; what an empty window withdraws is only
  the right to call a listed token the walk never saw *acquired*. This encoding replaces a `0` floor
  that read as 1970: a 56-year window containing every timestamp, under which one live wallet's
  30 launches / 20 bonded / `gate-passed` became 2 / 0 / `gate-failed` with an ordinary rationale.
- **A null page is a retry, never an end of index.** `getSignaturesForAddress` returns `null` both
  when the public RPC sheds load and when the JSON-RPC envelope carries an `error` — neither means
  the wallet's index ran out. The page is retried once, and a page that still does not resolve ends
  the walk on `upstream-error` with `wholeHistory: false`. Reading one as an empty page would have
  recorded page 2 of 200 as the wallet's whole history under `index-exhausted`: a ceiling presented
  as a measurement. Only a genuinely **empty array** is an exhausted index.
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
  quietly scored as a failure.

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

## The credential

The tool reads `MADEONSOL_API_KEY` from the environment. **Nothing in this repository holds a key,
and nothing here ever will.** The value is never printed, logged, or written to disk; presence is
verified by length and prefix shape only.

```bash
export MADEONSOL_API_KEY="$(your-secret-manager read madeonsol)"
# or, from a dotenv file kept OUTSIDE this repo:
set -a; . /path/to/your/.env; set +a
```

Free-tier keys expire every 30 days. An expired key exits `4` with a message that says so, rather
than producing an empty ranking. Get one at <https://madeonsol.com/developer>.

**Free tier only.** Paid tiers are refused standing policy, so nothing here may need Pro, Ultra or
Business. A `403` is treated as a bug to report, not as a prompt to upgrade.

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
That, and only that, is what the rate is computed from.

Two further sharp edges, both measured 2026-07-29:

- `/{wallet}/tokens?limit=100` returns **HTTP 400**. The OpenAPI document says `max=100`; the server
  rejects anything above **50**.
- The live `swap-api` fill rows and the stored tape rows **do not share field names**, and the live
  rows carry no `slot` field at all — only `slotIndexId`, whose first 12 digits are the slot. See
  `pumpfun.mjs` → `parseFillLoose`.

## The seed is theirs; the measurement is ours

A deployer MadeOnSol does not rank cannot be surfaced by this tool at all. That is a real
limitation, and the enumeration is shaped around what their endpoints actually return:

- `sort=bonding_rate` DESC is a wall of wallets with **1 deploy, 1 bond, rate 1.0** — their `rising`
  tier by definition — and the ones we sampled last deployed in **May 2024**. This sort is never
  used.
- `sort=total_bonded` DESC is industrial spam: **8,518 deployed / 127 bonded = 0.0149**, then
  2,660/100, then 4,324/89. All graded `cold`.

So enumeration runs over `recent-bonds` (best seed — a deployer there is bonding curves *now*),
`alerts`, and `leaderboard?sort=total_bonded`, and a `--tier` filter is how you reach the population
the gate is designed for.

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
Run records are the future grading lane's input, so a capped run must not read as a screen of
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

## Retention — MadeOnSol terms §5a(d)

> *(d) you may not cache, store, or accumulate API Data beyond what is reasonably necessary to
> operate your application, or in any manner that reconstructs a substantial part of the MadeOnSol
> database.*

**Derive and discard, implemented rather than promised.**

- Per-token records are held **in memory only**, for the duration of one run, and dropped when the
  process exits. There is no cache, no database, and no backfill.
- Nothing is written to disk unless `--out` is passed. Persistence is opt-in.
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

**§5a(b)** — internal research only. No publishing, no outbound feed, no shared surface, no
third-party display. The output is a text report and an optional local JSON file in a private
research repo.

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

Each entry carries a wallet-independent `summary` and a per-wallet `detail`. **The summary is the
grouping key**: keying on the detail would give every wallet its own line, since the client's message
embeds the request URL, and a grouping that groups nothing is just a longer list.

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

Two measurements per candidate, over that candidate's own most recent launches.

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
knowledge**: a create-slot transaction carrying two or more distinct swapping wallets is a bundle,
and every wallet in it is co-ordinated — independent traders cannot share a transaction. Needing no
wallet list is what makes the method applicable to a stranger at all.

**How much of the operation it recovers is the operator's submission habit on the day, not a
property of the rule.** Measured against the known six-wallet cohort on our own subject, by month:
**0% in December 2025 – February 2026, 41.6% in March, 69.9% in April, 97–100% from May onwards.**
The earlier claim here — that the rule recovers the cohort, full stop — is true of the May–July
slice it was written against and false of the tape as a whole.

#### An unbundled create slot is UNPROVEN, and unproven launches are not scored

**A create slot carrying no bundled transaction is observationally identical to a create slot with
no co-ordination.** The rule found nothing either way, and nothing in the fill tape separates the
two. Reading it as the second — which the screen used to do implicitly — books the operation's own
stake as outsider capital, and on the affected launches of our own tape that is **9.6–10.0 SOL per
launch** moved out of the numerator and into `independentSol`. It lowers the operation's share and
raises room twice over, once in each term.

**The rule's errors therefore run in exactly one direction: every one of them makes a deployer look
more enterable than it is.** The opposite error is structurally impossible — only wallets that
*provably* shared a transaction are ever marked, and independent traders cannot do that.

Captain **decision 134a**: do not score those launches. Call the opening **unproven** rather than
measured. A launch whose create slot carried no bundled transaction contributes **no room figure, no
field entrant and no round trip**; `measure.mjs` → `roomIsProven` is the predicate and
`entry.mjs` → `scoreEntry` applies it before anything is computed. A candidate left with fewer
proven launches than `minLaunchesSampled` scores `entry-unmeasured` — never `entry-room-present`,
and never folded in with a refusal, which are different findings.

**The cost is real and it is accepted.** Replaying the live recipe — median room over the trailing 8
launches against the 0.55 bar — at all 228 points of our own tape's history: refusing removes **24
of 24 false-positive windows and creates none in the other direction**, at a price of **81 windows
that become unmeasured** rather than wrong. On a stranger the same trade applies and cannot be
priced, because there is no ground truth to price it against. `bundledTx` and `maxWalletsInOneTx`
reach the score, the record and the rendered line for exactly that reason: they are the only
observable that exposes the condition, so a saved run can be audited for it after the fact.

A proven room figure is **still an upper bound**, and one bundled transaction is not evidence of
complete recovery: on our own tape a launch that bundles can still miss three cohort wallets that
bought alone. `roomIsProven` is the floor of the evidence, not a threshold on its quality.

**The predicate is create-slot-scoped, not operation-scoped, and no tighter one is available.** It
asks only whether *some* create-slot transaction carried 2+ distinct wallets — so a create slot in
which the deployer buys entirely alone while two unrelated wallets share one transaction (a shared
aggregator or copy-trade route) qualifies, and on that launch the operation's stake is still booked
outside the numerator. The obvious tightening — require a bundle containing the deployer — was
measured against the committed tape and matches **0 of 235** launches: this deployer never shares its
own create-slot transaction, the dev buy is a 1-wallet transaction every time, and the cohort bundles
among *itself* (typically two 3-wallet transactions). Adopting it would refuse every launch, leave
Stage 2 scoring nothing for any wallet, and hard-fail Stage 0 twice — the era buckets go to `n = 0`
and trip their own `minN` vacuity guard, and the known-negative control becomes `entry-unmeasured`.
`coordinated.size >= 1` is the same predicate in practice (identical 175/235). Captain **decision
139a**: `bundledTx >= 1` stands, and `measure.mjs` → `roomIsProven` owns the reasoning.

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

### The two legs are not symmetric, and that is the design

| leg | can it earn `entry-room-present`? | can it deny it? |
|---|---|---|
| room, on a launch whose opening is **proven** | **yes** | yes |
| room, on a launch whose opening is **unproven** | **never — the launch is not scored at all** | no: it is removed, not counted against |
| the field | **never** | yes |

Because **everything Stage 2 measures is gross of fees.** The fill tape carries swap-quote SOL and
no priority fee, landing tip, venue fee or rent, so every P&L is an upper bound. A field that loses
money before costs certainly loses money after them — conclusive. A field that *makes* money before
costs has established nothing at all.

The size of that gap is measured rather than feared, on the one wallet where we hold the answer:

| our subject `7ufmve7Z…`, post-2026-06-04 | reading |
|---|---|
| the field, **gross of fees**, as Stage 2 measures it | **351 / 460 closed round trips positive (76.3%)**, median **+0.116 SOL** |
| the regime, **fee-inclusive**, from `onchain_create_slot_pnl.csv` | **+0.54 SOL per launch across 106 wallets, 51 of them negative** |

(The gross row is over the 86 post-break launches whose opening is proven — the three that Stage 2
now refuses take 13 round trips with them. The fee-inclusive row is the regime's published figure
over all 89 and is quoted unchanged; it moves the argument not at all, since the point is the sign
of the gap, not its third digit.)

Read naively, the field says this wallet is beatable. It is not. So the field can only ever veto.

### Verdicts

`entry-room-present` · `entry-room-absent` · `entry-field-loss-making` · `entry-unmeasured`

Nothing in that vocabulary says beatable, profitable, or worth trading. **`entry-room-present` means
the opening window is not already closed, so the exit question is worth asking** — and nothing more.

**`entry-unmeasured` and `entry-room-absent` are deliberately not the same verdict**, and unproven
openings land on the first. "We could not measure this" is not "we measured it and there was
nothing there": the second is a finding about a deployer, the first is a finding about our evidence,
and folding them together would let a coverage failure read as a judgement. The score carries
`launchesRoomUnproven` beside `launchesSampled` so the two populations can always be told apart, and
a caveat names the count and the reason on every score that has one.

## Bounds

Enforced in code, with no flag that disables one. Pinned in `thresholds.json`.

| bound | value | why |
|---|---|---|
| keyed request ceiling | 200 | The **whole** MadeOnSol Free-tier daily allowance. Captain's instruction, 2026-08-02: there is no free substitute for this data, so spend the allowance when spending it gets results. The earlier ceiling of 45 was this tool's own quarter-allowance caution and is **withdrawn** — do not re-derive it. |
| candidate cap | 195 | 200 − 3 enumeration − 2 retry headroom. It is what the allowance leaves, not a judgement about how many deployers are worth grading, and it is above what the three seeds can surface — so a **default run grades everything it surfaces**. |
| over-budget plan | refused before the first request | `3 + candidates > ceiling` exits 2 having spent nothing, rather than running until the ceiling bites and reporting an incomplete screen. **The keyless plan is refused the same way**, and it matters more: the keyless work happens *after* the keyed allowance is spent, so a ceiling discovered half-way through wastes quota that was already paid. |
| keyed pacing | 6.5s between request starts | Free tier bursts at ~10/min, and the allowance is **shared** with whatever else holds this key. |
| keyless request ceiling, `frontend-api-v3` only | 1,400 | One client serves **two** passes on this host and the ceiling has to cover both. The gate reads the ownership listing it merges the creation window with, up to 4 pages **per candidate** — 195 × 4 = 780 — and `--consistency` then costs up to 3 pages per gate survivor, of which every candidate can be one: 195 × 3 = 585. So 1,365 worst case, and the remaining 35 are retry headroom. The earlier 600 was justified on the consistency pass alone and was already exceeded by gating at the default candidate cap. It does not lean harder on pump.fun — the pacing below is unchanged, so what it buys is wall clock. |
| keyless pacing, `frontend-api-v3` only | 2.0s | A **conservative carry-over, not a measurement of this host**: the ~0.5 req/s figure it was originally justified by was measured on `api.mainnet-beta.solana.com`, and the June report's own spend table records both pump.fun hosts as *not contacted*. It is kept because `frontend-api-v3` has shed nothing here, and it bounds a shared public resource rather than expressing our own caution, so the MadeOnSol relaxation does not touch it. The fill host is paced separately — see below. |
| requests in flight | **1**, serialised | Not a pool of one — a queue, so two callers cannot race. |
| retries | 1 keyed / 2 keyless, and **every attempt counts against the ceiling** | A retry spends a shared resource exactly as a first try does — but a 429, a 5xx or a timeout means the request was not served, so re-issuing it is nearer to one successful request than to two. Without it the caller re-runs the whole walk, which is worse for pump.fun too. A 4xx that is not a 429 is never retried: it is the endpoint's considered answer. |
| Solana RPC ceiling | 100 requests **per candidate** | `thresholds.json` → `creation_walk`. The creation-derived walk. Whichever bound bites is recorded per candidate. |
| Solana RPC pacing | 2.5s | Measured: the nominally faster 1.4s was *slower* in wall-clock once 429 backoff is counted. Rate limiting is global across `getSignaturesForAddress` and `getTransaction`. |
| `getTransaction` batch size | **1** | Measured harmful above 1 — see [Which history the gate counts](#which-history-the-gate-counts). |
| RPC retries | 3 with exponential backoff, each attempt counted against the ceiling | Unlike the keyed client, a 429 here is load-shedding and not a verdict — but a 429 storm still cannot outlast the ceiling. |

### How long a run takes, and how to bound it

**A full default run at the 195-candidate cap is worst-cased in HOURS, not minutes — about 15 —
and the creation walk is essentially all of it.** The arithmetic is `renderDryRun`'s, so `--dry-run`
prints these same figures for whatever flags you actually pass:

| leg | worst case | at its pinned pacing |
|---|---|---|
| keyed MadeOnSol | 3 + 195 = 198 requests | 6.5s → **~21 min** |
| **Solana RPC, the creation walk** | 195 × 100 = **19,500** requests | 2.5s → **~13.5 hours** |
| keyless `frontend-api-v3`, the gate's ownership listing | 195 × 4 = 780 requests | 2.0s → ~26 min |
| keyless `frontend-api-v3`, `--consistency` | 195 × 3 = 585 requests | 2.0s → ~19.5 min |
| keyless `swap-api`, Stage 2 | 3 × 8 × 18 = 432 requests | 7.0s → ~50 min |

So: **~15 hours** for a default run, **~15.5** with `--consistency`. The earlier "about 47 minutes"
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
- **`--ownership-only`** skips the creation walk entirely, which is the ~13.5 hours, leaving a run
  of well under an hour. Its reading is **biased towards rejection** — that is the defect this whole
  lane exists to fix — and the record is stamped `historySource: "ownership-only"` so the bias
  travels with the numbers rather than being forgotten.

Every figure above is in `thresholds.json` → `justification`, and `--dry-run` prints the plan
without fetching anything.

The conditional in the instruction binds: ***"if it gets results"***. It licenses sizing a run by
what the question needs. It does **not** license sweeping, idle retrying, or re-running to
re-evidence a side observation — a run that cannot say in advance what it will answer does not get
the allowance. And the relaxation is **MadeOnSol only**: the Helius / SolanaTracker / CoinGecko keys
are shared with production and the standing *"do not waste the quota that is production quota too"*
is unchanged, as is the keyless pump.fun pacing, which bounds a shared public resource for a
different reason.

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
| `/deployer-hunter/recent-bonds` | 1 per run | enumeration; carries the `tier` filter |
| `/deployer-hunter/alerts` | 1 per run | enumeration |
| `/deployer-hunter/leaderboard?sort=total_bonded` | 1 per run | enumeration |
| `/deployer-hunter/{wallet}` | **1 per candidate** | the gate — the only cost that scales |

`client.mjs` → `ENDPOINT_ROLES` is the authority; `--dry-run` prints it. Not used, deliberately:
`/deployer-hunter/{wallet}/tokens` is bonded-only and rejects `limit` above 50, and
`/deployer-hunter/{wallet}/history` is PRO+, which standing policy refuses.

### Stage 2's own bounds — and it spends no vendor quota at all

**Stage 2 issues zero keyed requests.** The mint list comes from the `/deployer-hunter/{wallet}`
profile Stage 1 has already paid for, so the shared vendor allowance — which production also draws on
— is untouched by the entire entry measurement. Everything it fetches is pump.fun's free tape.

| bound | value |
|---|---|
| gate survivors scored | 3 (`--score` can lower it, never raise it) |
| launches per survivor | 8 |
| **requests per launch, retries included** | 18 |
| stage ceiling, on its own client | **432** |
| pacing, `swap-api` only | **7.0s** |

`3 × 8 × 18 = 432` — **the declared worst case and the ceiling are the same number**, so the plan
`--dry-run` prints is the whole exposure and no plan-level truncation is possible. A launch is only
started when a full per-launch cap of headroom remains, so a run never abandons one half-walked.
Typical cost is far lower: at the measured median of 4 pages plus shedding, about 6 requests a launch
and ~144 for a full run. **In wall-clock terms that is about 17 minutes typical and about 50 minutes
worst case**, and `--dry-run` prints both — a run this long must not be mistaken for a hang.

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
   p75 15s, p90 15.5s, max 40s, with only p10–p25 near 1.2s. Its shed share is ~24–25% **flat across
   every delay bucket**, so backing off buys no immunity and there is no cheap corner to sit in.

7s therefore sits deliberately between that p50 and p75 rather than at the bottom of the range. The
`--consistency` walk on `frontend-api-v3` stays at 2.0s: it has shed nothing in this tool's use of
it, and it is not slowed for a fault on a host it is not.

The per-launch cap counts **requests, not pages**, and that is load-bearing — see the shed rate
below. A cap on successful pages would have let a launch cost three times the printed number.

The bound is **exact, not approximate**. One page can cost up to three requests (one attempt plus two
backoffs), so the walk reserves the whole per-page cost *before* starting a page. Checking the cap
only between pages would let a walk sitting at 17 spent requests start a page that sheds twice and
finish at 20, and `3 × 8 × 20 = 480` overruns the 432 ceiling the dry run prints as the entire
exposure — surfacing as a mid-walk ceiling error and a dropped launch.

Note also that the **1,400 keyless ceiling in `budget` is a per-client ceiling, not a run total**:
`screen.mjs` builds two independent keyless clients, and Stage 2's 432 sits on its own. The enforced
combined worst case is 1,832. The 1,400 is **derived from the candidate cap**, not chosen, and it is
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

- `KeylessHttpError` carries its **status as a field**, so `stage2.mjs` → `describeTransportFailure`
  can report `HTTP 400` without repeating anything the vendor sent. Anything that is not one is
  reduced to its constructor name.
- `record.mjs` → `redactVendorIdentifiers` scrubs named free-text fields on the way into a record,
  stripping URLs and base58 address runs, so containment for those fields does not rest on every
  future note-writer remembering. **Covered today, and only these:** the entry half's `rationale`,
  `caveats` and `dropNotes` (`stage2.mjs` → `toEntryRecordRow`); the gate half's `rationale`,
  `gateReasons` and `consistency.note` (`screen.mjs` → `toRecordRow`); and the run-level
  `truncationReason`.

  **Not covered, and the enumeration above is not full coverage of the record.** Three error-derived
  paths still reach `--out` verbatim: `creation.listingUnmeasuredNote` (`screen.mjs` →
  `describeUnmeasured`, whose `summary` is a raw `Error.message`), `creation.stopDetail`
  (`pumpfun.mjs`, a raw `cause.message` under `upstream-error`; under `request-ceiling` it is that
  client's own fixed ceiling wording, which names no vendor data), and the run-level `unmeasured[]` array, whose `detail`
  field `record.mjs` itself documents as embedding a per-wallet URL — so a keyless listing failure
  can persist a URL containing the wallet, which is the exact leak class this boundary exists for.
  That is a known open gap, deliberately left to a separate lane rather than an oversight; do not
  read the covered list as the whole record.

  It is applied **field by field and never as a sweep of the record**, because `wallet` is a 44-char
  base58 string that is deliberately kept — public on-chain data, and the one identifier a record
  exists to carry — and a blanket pass would strike exactly it.

## What walking the fill tape actually costs — measured, not estimated

Every `window/*.meta.json` in the committed tape records the request stats of the walk that produced
it. Across the 235 covered launches:

| quantity | measured |
|---|---|
| pages per launch | p50 **4**, p90 **8**, p95 **13**, max **24** |
| fills per launch | p50 381, p90 736, p95 1,222, max 2,321 |
| **HTTP 429 shed rate** | **16,960 of 68,675 requests — 24.7%** |
| launches that shed at least once | **221 of 235** |

Two consequences, both of which corrected a first pass at this tool:

- **A 429 on this endpoint is the normal case, not an incident.** The tape's own builder backed off
  adaptively (its recorded `delay` ranges from 0.75s to 40s) and retried through them. A client that
  treats a 429 as terminal cannot walk a launch window at all — the first live check of the pager
  died on one, three launches in. `KeylessClient` now retries twice, at 3s and 9s.
- **A 10-request cap was too small and its stated justification was wrong.** It had been anchored on
  a single sampled window of 385 fills; the real distribution above shows 20 of 235 launches need 10
  pages or more. The cap is 18 requests — about 13–14 successful pages at the measured shed rate,
  covering roughly the 95th percentile. **The tail is dropped, not silently truncated:** a launch
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

**Stage 0 deliberately does not use the span**, and the two paths must not be reconciled: it measures
each committed launch over that launch's own stored window, because `wallet_launch_pnl.csv` — the
1,502-pair reproduction that licenses believing the live recipe at all — is computed that way. The
comment at `stage0.mjs` → `measureSubjectLaunches` says so at the point of divergence.

### The mirror case: a mint time that seeks EARLY

A vendor mint time running *early* trips no tripwire — there are no pre-mint rows — and instead
truncates the **tail** of the window, because the seek never asks for the last rows. It is not
detectable after the fact: launches routinely stop trading before the nominal window end (observed
p50 span 151 against a 160-slot window), so any tail detector fires on nearly every launch and
carries no information at all.

So it is designed out rather than reported. The walk seeks from `createdAtMs + windowMs +
seekMarginMs`, with the margin pinned at **5s**, so an early skew smaller than that cannot cut the
tail off before the slot trim ever sees it. The cost is bounded: the walk still pages *backwards* to
the mint and still trims by slot afterwards, so the margin only adds rows at the newest end — about
5s of trading, roughly 32 fills at the tape's p50 of 381 fills per 60s, i.e. at most one extra page.
That fits inside the 18-request per-launch cap and the `3 × 8 × 18 = 432` arithmetic is unchanged.

**The margin is a cursor hint and never a proof tolerance.** The pre-mint tripwire still compares
`ts < createdAtMs` with zero slack, and coverage is still discharged only by an explicit
`hasMore === false` or a readable empty page. Widening the margin cannot soften either.

**It does bound one other thing, and it has to: which launches are old enough to measure.**
`stage2.mjs` skips a launch younger than `windowMs + seekMarginMs` — **65s**, not 60s. The gate has
to cover the newest instant the walk reaches for, and two quantities reach forward from the mint: the
seek cursor at 65s, and the measured window at `windowSlotSpan` slots (64.0s at the nominal
400ms/slot, ~63.5s at the tape's observed ~397ms). The cursor dominates, so one bound covers both.
Gating on `windowMs` alone admitted a launch aged 60–65s whose tail had not happened yet — the same
truncation this margin exists to prevent, arriving from the future side, and silent in the same way,
because an absent tail reads as a quiet one. A test pins both the behaviour and the relation
`windowSlotSpan × 400ms ≤ windowMs + seekMarginMs`, so widening the span past the gate fails loudly.

**Every run reports its drops per cause, per wallet and in total**, in the record (`entry.coverage.dropsByReason`
and the run-level `entryDrops`) and in the rendered output. A non-zero
`mintTimeDisagreement` is treated as a **reportable event, not a footnote**: all 235 clock
observations come from our own tape and this lane has never held a vendor key, so whether the two
clocks agree on *stranger* wallets is untested. If they routinely disagree, the tripwire stops being
free and starts discarding real launches at scale — and a visible per-run count is what stops that
happening silently.



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
exactly that case. The buckets hold 45 and 89 launches as committed; the floor is 20.

**Built — Stage 1**, the keyed gate: enumerate, compute the rate ourselves, apply pinned thresholds.

**Built — Stage 2**, the ENTRY score. Room in the opening window, and what the field there achieved.
Keyless, and it spends no vendor quota. Stage 0 validates it four ways before a single request is
issued:

| check | result on the committed tape |
|---|---|
| the create-slot primitive reproduces the published §5.1 era split | operation share 0.451 → 0.769 against a published 0.451 → **0.771** (see below) |
| the **field** measurement reproduces `wallet_launch_pnl.csv` | **1,502 create-slot outsider pairs, 0 closure mismatches, max realised error 5.0e-7 SOL** |
| **the known-negative control**, at two points in time | see below |
| **the rolling replay**, at every point in time | **228 trailing windows, 0 false positives and 0 false negatives**, 81 refused as unmeasured — see below |

#### The era-2 constant is pinned at 0.771, and the tolerance is not the fix

The published era-2 share `0.768` is **not the median of its own stated population**: the 89-launch
series has median `0.7708`, and `0.768` is its rank-43/44 order statistic. Three independent recipes
read `0.771`, one of them this repo's own committed
`node analysis/window-population/measure.mjs`. The full decomposition, including what population
*does* produce `0.768` and why that population is internally inconsistent, is recorded in
`data/population-tape-2026-07-29/IMPORT.md` → "Corrections" — the primary record's report is not
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

So the check was passing for the wrong reason. Refusing to score an unproven opening removes the
first term; re-pinning removes the second. Era 2 now reproduces at **0.769 over its 86 proven
launches** against `0.771` — the residual is three launches leaving an 89-member series and moving
the order statistic, not a defect. **Widening the tolerance would have hidden both.**

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
| the most recent 8 launches — exactly what a live run would score today | `entry-room-absent` | **0.284** |
| the whole post-2026-06-04 regime, 86 proven launches | `entry-room-absent` | **0.231** |

**And this is why it is an assertion rather than a threshold comparison:** on that same wallet the
field leg reads 351/460 closed round trips positive. Followed on its own it would call the wallet
beatable. The verdict has to survive a leg pointing the wrong way, and Stage 0 fails loudly if it
ever stops doing so — including if a future lane quietly loosens `minRoomLeft` to fit an output.

#### The rolling replay — the same question, asked at every point in the tape

**The two slices above could not have caught the unproven-opening defect, and that is a fact about
where they sample, not about how they are written.** Both sit inside the months where the
co-ordination rule happens to recover 97–100% of our subject's cohort. Over December 2025 –
February 2026 it recovered **0%**, and across that stretch the screen reported median room 0.62–0.66
against a true 0.20–0.33 — in a regime whose measured per-launch prize to outsiders was ≈0
(`analysis/window-population/`).

So Stage 0 asks the same question at **all 228 trailing windows** instead of two. The recipe is the
live one, not an approximation of it: median `roomLeft` over the trailing
`maxLaunchesPerCandidate` launches against `minRoomLeft`, a window with fewer than
`minLaunchesSampled` proven launches being unmeasured, exactly as `scoreEntry` would have it. Each
window's verdict is compared with the one the **named** six-wallet cohort gives — ground truth we
hold only because this is our own subject, which is the whole reason the structural rule exists.

| | before decision 134a | with it |
|---|---:|---:|
| windows evaluated | 228 | 228 |
| **false positives** — screen says room, the named cohort says none | **24** | **0** |
| false negatives — screen MEASURED the window and said none, the named cohort says room | 0 | 0 |
| windows reported unmeasured — refused, so the screen gave no verdict at all | 0 | 81 |

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

**Not built — the prediction-grading loop.** A dated immutable record per run so a later run can
grade the screen's own hit rate. Its own lane. Run records under `runs/` are the input it will read.

**A Stage 2 run record is committed**: `runs/2026-08-02-good.json` scored 3 gate survivors on live
fills, and `runs/2026-08-02-good-vs-elite.md` reads it. It carries this tool's first
`entry-room-present` verdict on a stranger wallet, and that document states the five reasons the
verdict is marginal — it is one candidate worth a closer look, not a finding. The `--dry-run` output
and the live-vs-tape check above remain the keyless evidence that the walk is the same code path.

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
- Only `credential.mjs` and `screen.mjs` may name `MADEONSOL_API_KEY`.
- **No committed file under the tool may contain a key-shaped string** — every file, not only the
  sources. `runs/*.json`, `thresholds.json` and this README are where an accidental paste would most
  plausibly land, and a source-only filter never read any of them.

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
