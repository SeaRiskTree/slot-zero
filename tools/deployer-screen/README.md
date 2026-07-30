# deployer-screen

A rerunnable **completion-rate gate** over MadeOnSol's free Deployer Hunter endpoints, plus a local
validation harness that runs with no key and no network.

**This tool gates. It does not recommend.** It answers one question — *does this deployer complete
bonding curves?* — and that question measures competence, not opportunity. The measurement that
would turn a gate result into a candidate worth money is Stage 2, and it is deliberately not built
here. See [Scope](#scope-what-is-and-is-not-built).

## Run it

No agent, no build step, no dependencies. Node 20+.

```bash
# Local validation only. No network, no key, no quota. Always safe to run.
node tools/deployer-screen/screen.mjs --stage0

# Show exactly what a real run would fetch, and fetch nothing.
node tools/deployer-screen/screen.mjs --dry-run

# A real run. Needs a key (see below).
node tools/deployer-screen/screen.mjs --tier elite --candidates 12 \
  --consistency --out tools/deployer-screen/runs/$(date +%F).json

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
> side observation was ruled out under the quota bound. So this paragraph is a recollection, not
> evidence: nothing committed backs it, and it should not be cited as though something did.

**The elite-tier recent-bond feed is `recent-bonds?tier=elite` — a tier filter on the shared feed,
not a distinct endpoint.** Their OpenAPI v1.17.0 exposes no separate elite path; `tier` is a query
parameter with enum `elite|good|moderate|rising|cold`, and `--tier elite` threads it through every
seed. The committed run under `runs/` exercises it and records its own wallet count.

### Two of the three seeds used to yield nothing, silently

Measured and fixed. `recent-bonds` and `alerts` nest their deployer block under **`deployers`** —
plural — and `recent-bonds` wraps its rows in `tokens`, not `bonds`. The reader looked only for the
singular `deployer`, so both seeds extracted **zero wallets** while still costing a keyed request
each. Nothing surfaced it: the run printed one merged total, and the record carried no per-query
figure. Both committed runs were therefore leaderboard-only pools — indistinguishable, from their
output, from properly seeded ones.

Two changes, because the shape bug alone would have left the class of defect in place:

- `extractWallets` accepts either nesting (`seed.mjs` → `BLOCK_KEYS`).
- **Every seed now reports its row count *and* its wallet count**, printed and persisted under
  `coverage.seeds` in the run record, with zero-yield seeds named in `coverage.inertSeeds`. Rows
  present and wallets zero is the fingerprint of *our reader* being wrong rather than the vendor being
  empty, and the two are now distinguishable at a glance.

The run record also carries the full coverage chain — wallets seeded, prefiltered out, worth a
request, **dropped by the candidate cap**, gated — and sets `truncated` when the cap dropped anyone.
Run records are the future grading lane's input, so a capped run must not read as a screen of
everything enumeration found.

The superseded untiered run record (`runs/2026-07-29-stage1.json`) was **deleted rather than
re-run**: its numbers came from the inert seeds, and reproducing that configuration would cost
another ~15 keyed requests against a shared allowance the captain has declared unaffordable.

### The committed run, with all three seeds working

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

## Retention — MadeOnSol terms §5a(d)

> *(d) you may not cache, store, or accumulate API Data beyond what is reasonably necessary to
> operate your application, or in any manner that reconstructs a substantial part of the MadeOnSol
> database.*

**Derive and discard, implemented rather than promised.**

- Per-token records are held **in memory only**, for the duration of one run, and dropped when the
  process exits. There is no cache, no database, and no backfill.
- Nothing is written to disk unless `--out` is passed. Persistence is opt-in.
- What a run record contains, per wallet — **thirteen fields, all of them ours**: `wallet`,
  `seededBy`, `tokens`, `completed`, `completionRate`, `spanDays`, `windowFirstDeploy`,
  `windowLastDeploy`, `vendorPageCapped`, `verdict`, `rationale`, `gateReasons`, `consistency`. The
  exact key set is asserted by `test/deployer-screen.test.ts` → *"a committed run record persists
  derived fields only"*, against the committed records themselves, so this ToS-facing claim cannot
  drift from the code.
- What it does **not** contain: any mint, token name, symbol, market cap, bond timestamp,
  time-to-bond, or per-token row of any kind. Roughly 70 vendor records per wallet are read, reduced
  to one row of derived counts, and discarded. Verified on the committed run records — none of
  `mint`, `token_mint`, `token_name`, `symbol`, `peak_market_cap`, `bonded_at`, `ath_market_cap` or
  `pool_address` appears anywhere in a candidate row.
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
| 1 (absent) | no `completed`. `truncated` and `truncationReason` only. |
| 2 | `completed`, plus `coverage` separating candidate-cap truncation from an abort. |

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

## Bounds

Enforced in code, with no flag that disables one. Pinned in `thresholds.json` → `budget`.

| bound | value | why |
|---|---|---|
| keyed request ceiling | 45 | 3 enumeration + 20 candidates = 23; headroom for a retry. Under a quarter of the shared 200/day. |
| candidate cap | 20 | |
| keyed pacing | 6.5s between request starts | Free tier bursts at ~10/min, and the allowance is **shared** with whatever else holds this key. |
| keyless pacing | 2.0s | The June report measured sustainable pump.fun throughput at ~0.5 req/s with one request in flight; batching and concurrency were both measured harmful. |
| requests in flight | **1**, serialised | Not a pool of one — a queue, so two callers cannot race. |
| retries | 1, and each attempt counts against the ceiling | A retry spends a shared allowance. |

Every run prints its request count and elapsed time. There is no poller, sweep, daemon, cron, or
cache-warmer, and adding one would be a policy breach rather than an optimisation.

## Scope: what is and is not built

**Built — Stage 0**, local validation, no network. Asserts that the gate **passes** our own subject
deployer (0.4310 over 239 launches), which is the point: that wallet's opening window has been
unprofitable for outsiders since 2026-06-04 because its own group takes 97% of the profit there. A
gate that passes it is a gate that measures competence, and Stage 0 makes that concrete instead of
claiming it. Also checks ground truth has not moved, that the curve inversion is exact (max error
1.4e-14 SOL over 70 control launches), and that the Stage 2 seam still reproduces the published
§5.1 era split.

That last check now asserts a **minimum n per era and a finite median** before comparing. It has to:
`median([])` is `NaN`, `Math.abs(NaN - published) > 0.02` is `false`, so an era bucket matching no
launches used to record no failure and report **PASSED** — and a passing Stage 0 is what authorises
spending keyed quota on strangers. Anything that empties the filter (renamed window files, every
`reached_mint` false, a `--data-dir` pointing at a differently dated tape, a shifted date range) hit
exactly that case. The buckets hold 45 and 89 launches as committed; the floor is 20.

**Built — Stage 1**, the keyed gate: enumerate, compute the rate ourselves, apply pinned thresholds.

**Not built — Stage 2**, the score: how much of its opening window a deployer and its own wallets
take, and therefore how much room is left. Reserved for a fresh lane. **The interface it will consume
is built, validated and regression-tested here:**

| seam | contract |
|---|---|
| `measure.mjs` `measureCreateSlot(fills)` | → `CreateSlotMeasurement` (`devSol`, `coordinatedSol`, `independentSol`, `operationShare`, `roomLeft`, …) |
| `measure.mjs` `solBetweenPrices(from, to)` | SOL added to the curve between two prices; exact |
| `measure.mjs` `parseFill` / `pumpfun.mjs` `parseFillLoose` | → `Fill` |
| `pumpfun.mjs` `windowFilter`, `extractTradeRows`, `slotFromSlotIndexId` | opening-window filtering and live-row field handling |
| `pumpfun.mjs` `KeylessClient` | bounded, paced, serialised keyless access |
| `stage0.mjs` `measureSubjectLaunches(dataDir)` | per-launch `CreateSlotMeasurement` from the committed tape |

The fill-tape **pager** is deliberately absent. A `readLaunchWindow` existed here with no caller and
no test, so its coverage logic was never exercised; rather than leave a half-validated function
described above as tested, it was deleted. Stage 2's lane writes it against a real caller.

The co-ordination rule that makes it work on a stranger: **a create-slot transaction carrying two or
more distinct swapping wallets is a bundle, and every wallet in it is co-ordinated** — independent
traders cannot share a transaction. On our subject this recovers the known six-wallet cohort *without
being told who it is*, reproducing the published era split (operation share 0.451 → 0.759 against a
published 0.451 → 0.768; co-ordinated stake 6.91 → 19.75 SOL; 5 → 6 wallets).

**Not built — the exit trap.** Room to enter is not room to leave. When the dev sells relative to
mint and to outsider inflow, whether the trigger is a **size** (which would cap our position size,
because our own buy counts towards it), and whether an outsider could have exited first. Entry room
and exit feasibility must be scored **separately and never collapsed**. Its own lane.

**Not built — the prediction-grading loop.** A dated immutable record per run so a later run can
grade the screen's own hit rate. Its own lane. Run records under `runs/` are the input it will read.

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
rate. **This tool measures none of the last three.** A high completion rate does not imply a
profitable entry, and we hold the counterexample rather than the worry: our subject deployer
completes 43% of its launches and its create-slot window has been unprofitable for outsiders since
2026-06-04 (`data/slot-zero-june-regime-change/report.md` §5, §6.1).

The rate is computed over roughly 35 days and about 70 tokens. It is a **recency** measure, not a
lifetime record. Long-horizon consistency is reported **UNMEASURED** unless `--consistency` is
passed, because manufacturing a multi-month claim from a 35-day window is precisely the defect we
found in the vendor's own aggregate.
