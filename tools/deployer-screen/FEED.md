# The candidate discovery feed

`tools/deployer-screen/feed.mjs` — a scheduled lane that surfaces deployer wallets this project has
**not seen before**, triages them on the Stage 1 competence gate, and queues the survivors for the
beatability screen.

It **supersedes the re-open monitor** (captain decision 116a), whose premise the captain corrected on
2026-08-02:

> *"It would not sit and watch wallet already deemed closed window, a dev that is competent will not
> reopen a window. Instead we need to keep search for new dev wallets ideally in different operations
> but for now just a constant feed of high quality candidate is good start."*

A competent dev that tightened its own launch bot has no reason to loosen it again, so re-polling
wallets already graded "closed window" watches the one place a window will not reopen. **The
opportunity is in the population, not in the graveyard.** So there is no re-open poll here, no expiry
that reintroduces one, and no schedule that re-grades a wallet: a graded wallet is simply never
offered as new again.

## Run it

```bash
# The DEFAULT is a dry run. Prints the plan and the ledger's state; requests nothing, writes nothing.
node tools/deployer-screen/feed.mjs

# Once, when standing the lane up: build the ledger from the committed screen run records so the
# first live run does not offer 82 already-graded wallets back as discoveries. Offline, no key.
node tools/deployer-screen/feed.mjs --bootstrap

# A live run. Needs MADEONSOL_API_KEY (see README.md -> The credential).
node tools/deployer-screen/feed.mjs --live --out tools/deployer-screen/feed/runs/$(date +%F-%H).json

# Narrower and cheaper.
node tools/deployer-screen/feed.mjs --live --tier good --gate 3

node tools/deployer-screen/feed.mjs --help
```

## What one run costs — the whole quota story

**Keyed (MadeOnSol, Ultra and exclusive to slot-zero): 6 enumeration requests + at most `--gate`
profile requests. Nothing else in this lane is keyed.**

| leg | cost | bound |
|---|---|---|
| enumeration | **6** requests — `recent-bonds`, `alerts`, `leaderboard`, once per tier for `good` and `elite` | the seed plan's own length |
| triage | **1 per new wallet gated**, at most `--gate` | `feed.gateBatch`, capped by `feed.maxGateBatch` |
| **per run** | **6 + `--gate`; default 12, worst case 18** | `feed.maxKeyedRequestsPerRun`, refused before the first request |

Enumeration costs 6 and not 3 because **captain decision 262a made the seeding tiered by default**
(`seed.mjs` → `DEFAULT_TIERS`); `feed.maxKeyedRequestsPerRun` moved 15 → 18 with it, or every run
would be refused before its first request at `6 + 12 = 18 > 15`.

**Keyless: none.** This lane does not walk the fill tape and does not touch Solana RPC. That is not
an oversight — see [Why the gate here reads ownership](#why-the-gate-here-reads-ownership-and-what-that-costs).

**The daily arithmetic**, which is the reason a forever-schedule is allowed at all:

```
maxKeyedRequestsPerRun 18  x  runsPerDayAssumed 6  =  108 of the 100,000/day allowance  (0.108%)
default gateBatch 6 -> 12  x  6                    =   72                               (0.072%)
```

**The denominator moved by 500× and the arithmetic is restated against it** — captain decision
**267a**, 2026-08-05: the MadeOnSol key is ULTRA and EXCLUSIVE to slot-zero, 100,000 requests/day
resetting at 00:00Z, where it was ~200/day and shared. So this lane's worst case is **0.108% of the
day** where it used to be 45% of it, and `screen.mjs` is left ≥99,892 requests rather than ≥110.

**The bounds are kept anyway, and that is the point rather than an oversight.** The argument for
bounding a forever-lane was never only the size of the allowance: a scheduled consumer must state
its cost in advance and be refused when it exceeds it, because a cron is the one caller no human
reviews before each spend. An unbounded lane against a 100,000-request day is still unbounded. The
ceiling therefore moved **only where the tiered plan forced it** (15 → 18) and nowhere else — the
upgrade bought no widening. `runsPerDayAssumed` is **not enforced** — nothing here can read a cron
table — so it is recorded in `thresholds.json` → `feed` precisely so that a schedule contradicting it
is contradicting a written figure. **Raising the cadence without lowering the per-run ceiling is
still how this lane silently becomes the largest consumer of a day nothing here tracks across runs.**

Three structural guarantees back the numbers rather than describing them:

- **The default path is a dry run.** `--live` is required to spend. A scheduled lane — the one caller
  no human reviews before each spend — does not get to have its spending path be the one you reach by
  forgetting a flag.
- **A plan that does not fit is refused before the first request**, with nothing spent
  (`planFeedRun`). `--gate` can only ever *lower* the pinned batch.
- **One `BoundedClient`, one ceiling.** Every provider call in this lane goes through it, and
  `test/candidate-feed.test.ts` asserts the request count end to end against a stub rather than
  computing it in a comment.

## The ceiling this feed inherits

**Discovery here is entirely vendor-selected, and that ceiling is not reducible by anything in this
file.** Every wallet comes from a MadeOnSol enumeration endpoint (`seed.mjs`), so:

- **We can only ever surface deployers MadeOnSol already tracks and profiles.** A deployer they have
  never profiled is not rare here, it is *invisible* here, and **no count this lane prints bounds how
  many there are.** Nothing in the feed's own output may be read as coverage of the population.
- **The pre-filter is a cadence filter.** It reads the vendor's trailing ~7.5-day deploy count
  (`PREFILTER_MIN_DEPLOYED`), so a slow-but-steady deployer is skipped before a request is spent on
  it. Every run reports how many were skipped and the min/median/max of their trailing counts, so the
  cost is a number rather than a caveat — it is **visible, not eliminated**. That count is the
  filter's *cost*, so it counts only wallets still awaiting the gate: the vendor re-serves the same
  pages every run, and an already-graded wallet below the floor was never going to be gated anyway.
- **Tier is another trailing window.** `README.md` records that tier membership is not stable — the
  same wallet came back `elite` and, four days later, `good`, with its own numbers essentially
  unchanged. `--tier` narrows the pool; it does not partition the population.

Widening discovery to other venues or operations is the captain's stated end state and is a **later
lane**. The existing sources are explicitly accepted as a good start.

### The discovery lag, quantified

We cannot see how late the vendor is to a deployer. We *can* see how late **we** are to the ones it
did profile, and it is worth knowing before treating this feed as an edge:

> **A wallet in the committed ledger had already been deploying for a median of ≥ 132.7 days — and up
> to ≥ 857 days — before this project first saw it** (n = 74 of 82; the rest carry no usable deploy
> time). Measured 2026-08-02 from the two committed screen runs.

The measurement is `firstSeen − firstDeploy`, where `firstDeploy` is the oldest launch in the
vendor's own profile page. It is a **lower bound**, twice over:

1. That page is a **capped** page of a **trailing** window, so a wallet that deployed for a year
   before its oldest visible row reads as younger than it is.
2. It exists **only for wallets the vendor profiled at all**. No amount of this statistic bounds the
   lag on the population we cannot see.

So: it says how late we were to the wallets we found. It says nothing about the ones we did not.
`feed.mjs` prints it every run and stores it per wallet, and `FEED_LIMITATIONS` carries the same
sentence into every record.

## Why the gate here reads ownership, and what that costs

The Stage 1 gate can be applied to either of two histories, and `README.md` →
"Which history the gate counts" owns the difference:

- **creation-derived** — which tokens the wallet *created*. Correct, and metered: with `DUNE_API_KEY`
  set the enumeration is one Dune execution for a whole batch, billed against an account-wide monthly
  credit allowance that the operator's own cap narrows further (`README.md` → "The monthly credit
  ceiling"); the fallback is the Solana RPC walk — keyless ~100 requests per candidate at 2.5s apart,
  so one default `screen.mjs` run is budgeted in *hours*, or with `HELIUS_API_KEY` set the indexed
  walk, fast but metered in credits (`README.md` → "Bounds"). **This lane carries none of them**: its
  bounds pin zero keyless requests, no Solana RPC spend and no Dune execution at all.
- **ownership** — which tokens the wallet *owns now*. One keyed request, already paid for.

This lane reads ownership. That reading **understates** a wallet's launches and understates its
bonded launches by more, and therefore **scores the better deployer worse** — a false rejection, and
an invisible one.

### It is biased in BOTH directions at once, and only one of them was written down

Captain decision 233a. The lane keeps reading ownership — moving it would break the pinned
zero-Solana-RPC bound above — but the one-directional description it used to carry was wrong.
`slot-zero-gate-bar-measure-own-population` §2.1/§2.3 (held in firstmate's records, not in this
repo) measured both readings over the same 82 candidates, from the screen's last real run, which
records each candidate's vendor reading beside its gate reading:

| direction | how it bites | measured |
|---|---|---|
| **rejects**, through the **count** bars | a 70-record page for a wallet creating ~9/day spans three days, so `minTokens` + `minSpanDays` fail on evidence length rather than on the deployer | **20 of 82** clear both bars on the vendor page against **66 of 82** on the gate reading |
| **inflates**, through the **rate** | the page holds what the wallet still *owns*, and the ones that move on are the winners — a success-biased short window, not merely a short one | the vendor rate reads **higher** on **37 of 81** wallets (lower on 29, median difference 0.0000), by up to **+0.6929** |

So the `held` pile is over-populated *and* the `queued` pile is over-generous, from the same
surface, on the same run. Do not reason about this reading as a one-way conservative filter, and do
not treat a `queued` wallet as pre-validated.

### The two `completionRate`s are different quantities

`feed.mjs`'s `completionRate` and `screen.mjs`'s are **not the same number** and can differ by
**0.69** on one wallet. What keeps that legible rather than silently conflated — and what makes
keeping this lane on the vendor page defensible — is that **every ledger row records
`gateReading`**: `ownership-only` here, `creation-derived` under `screen.mjs`'s default. Read that
field before comparing, pooling or ranking rates across the two sources.

Captain decision 351 widened that gap rather than narrowing it: `screen.mjs`'s gate reading now
excludes a mayhem-mode launch from both sides of its rate, and this lane's cannot — the vendor
profile page carries no such column, so every launch here is unreadable for it and this rate is the
pre-351 pooled quantity by construction. `README.md` → *"The mayhem-mode flag"* owns the rule.

Captain decision 352b then changed what **both** rates COUNT, and it changes this lane's number by
nothing. The completion measure is now **RAISE-85** — net quote inflow into a token's own primary
market reaching 85 SOL-equivalent in its first 24 hours — on every venue including pump.fun, and
`profile.pump_tokens[].complete` is no longer the definition: it is an **estimator** of it, whose
negative is exact and whose positive is an upper bound, so a rate here errs towards acceptance
exactly as it did before. One thing did move: a `complete` field that is **missing or malformed**
used to read `false`, and is UNREADABLE now — so a vendor schema change makes this lane's wallets
`unmeasured` rather than driving every rate to 0.0000 with nothing saying so.
`README.md` → *"The completion measure is RAISE-85"* owns the rule and the seam with 351.

The design follows from that, and it is the single most important thing to understand about this
lane's output:

| feed state | meaning |
|---|---|
| `queued` | Cleared the gate on the ownership reading. **The feed's product**: worth putting through the beatability screen. **Not a pass** — the rate that cleared it may read up to +0.6929 above the gate's on the same wallet. |
| `held` | Did **not** clear it. **This is NOT a rejection.** It is a triage outcome on a reading whose count bars fail 46 more of 82 wallets than the gate reading does. |
| `unmeasured` | The vendor's profile carried no readable launch record. An empty deployer and a moved response shape are indistinguishable from here, so neither is recorded as a finding. |
| `prefiltered` | Never gated: the vendor's trailing deploy count was below the floor. The cadence filter. |
| `deferred` | Surfaced and recorded, waiting for a gate batch. |

`screen.mjs` remains the authority. Every run prints the standing count of `held` wallets **and** how
many of them missed on exactly one gate leg — the plausible false negatives, and the shortlist worth a
deliberate creation-derived re-read. They are **not re-polled**: re-reading one is a `screen.mjs` run
and a decision, never a schedule.

## Yield, and why a dead feed cannot read as a healthy one

The failure this lane was told to make impossible is on the record: the screen's first two committed
runs read as healthy while **two of three seeds returned zero wallets**, because nothing compared rows
against wallets. On a schedule that failure repeats silently forever, and "0 new candidates" is
exactly what a saturated population *and* a broken reader both look like.

So every run reports, in this order — alarm first, then the new count, then the duplicates:

- **New wallets this run.** The headline. A report that led with "61 wallets surfaced" would read as a
  good day even when every one of them was already known.
- **Duplicates**, as `already known N of M surfaced`.
- **Per seed: rows, wallets, and how many of those wallets were new.** Rows present with wallets zero
  means *our reader is wrong*, not that the vendor is empty. (A wallet two seeds both surfaced counts
  as new under both, so per-seed novelty does not sum to the run total.)
- **Gated / cleared / held / unmeasured**, and the backlog still waiting.
- **Discovery lag** and the **cadence filter's** cost, as above.
- **Spend**, against the per-run ceiling and the assumed daily figure.
- **The queue**: wallets that cleared the gate and have not been screened.

**Four conditions exit 9** (`ledger.mjs` → `feedAlarm`), because they need four different fixes:

1. **A seed returned rows we read no wallet from.** Our bug — the 2026-07-29 defect recurring. Loud on
   the *first* occurrence, never after a streak.
2. **Every seed inert.** No input at all: check the tier filter, the credential's scope, the vendor.
3. **Every gated wallet unreadable.** The profile shape moved. Requires **at least 2 gated wallets**
   (`ALL_UNMEASURED_MIN_GATED`): this condition *asserts* a move at the vendor, and its own message
   says one empty deployer is not evidence of that, so it must not be assertable from a sample of
   one. **What that floor actually costs, exactly:**
   - At `--gate 2` **and above there is no latency at all.** `gated >= 2 && unmeasured === gated` is
     satisfied on the **first** run in which every gated profile comes back unreadable.
   - At `--gate 1`, `gated` can never exceed 1, so the condition is **never satisfiable** and this
     alarm is **structurally unreachable** for the entire lifetime of that configuration. **Nothing
     else covers the gap:** a profile-shape move leaves enumeration healthy, so `newlySurfaced > 0`
     and the dry-streak alarm never fires either — which is precisely the *"the feed dies quietly"*
     failure the `unmeasured` state was introduced to prevent.

   That hole is an **accepted, deliberate bound**, not an oversight. The remedy is not to lower the
   floor — a floor of 1 reinstates the sample-of-one assertion this decision exists to prevent — so
   `feed.mjs` instead prints a standing warning, on the **dry** path as well as the live one,
   whenever the resolved gate batch is below the floor, saying this alarm cannot fire at that
   setting. Run `--gate 2` or higher if you want it armed. The same fact is in the record as
   **`alarm.unmeasuredConditionArmed`** (added at feed record **schema 2**), derived from the same constant,
   because `--json` and a saved `--out` record are what a scheduler reads — and there `alarmed:
   false` from a batch below the floor is weaker evidence of health than one above it.
4. **A dry streak** — `feed.dryStreakAlarm` (3) consecutive *live, completed* runs with no new
   wallet. One dry run is ordinary; the vendor's pages overlap heavily between runs. Three is
   saturation, and the remedy is a wider source, not a longer wait. An **aborted** run is skipped
   like a preview is: it surfaced nothing because it stopped, so a credential or transport fault
   cannot accumulate into a diagnosis of saturation.

Exit 9 means *it ran, it spent quota, and its yield is not usable*. A scheduler must not treat it as a
quiet day.

## The ledger

`tools/deployer-screen/feed/ledger.json`, committed. It is the memory that makes "never re-offer a
known wallet as new" true, and it is the reason a live run costs 3 keyed requests instead of ~85 on a
day when nothing new appears.

- **Seeded from the committed screen run records on every run**, not once at bootstrap — so a lost or
  hand-deleted ledger degrades to a slower feed rather than to a wrong one. Both graded candidates
  *and* `prefilteredOut` wallets are folded in: a pre-filtered wallet was *seen*, and treating it as
  unseen would re-offer it every run and skip it every run, a duplicate that never converges.
- **An unreadable or unknown-schema ledger throws.** Silently starting over would re-offer every known
  wallet as new and spend a keyed request per wallet re-grading them for verdicts already held.
- **Gate batches drain backlog-first, FIFO by first-seen.** A run that always gated the freshest
  wallets would starve the oldest deferred ones permanently while reporting healthy yield every time.
- **Retention is the screen's, unchanged (MadeOnSol ToS §5a(d)).** Per-token vendor records live in
  memory for one wallet's triage and are dropped; what survives is derived — counts, a rate, a span, a
  state — beside a wallet address, which is public on-chain data and ours to keep. Asserted in
  `test/candidate-feed.test.ts`, against the committed ledger itself.

Committed state, 2026-08-02 (`--bootstrap` over the two committed screen runs): **82 wallets — 14
queued (11 of them not yet screened), 61 held, 7 pre-filtered.** All 61 held on the ownership reading;
**48 of them missed on exactly one gate leg.**

## Known gap: the queue is not yet wired into the screen

The feed produces a queue of gate-clearing wallets. `screen.mjs` enumerates its own candidates from
the seeds and has no flag that accepts a wallet list, so handing the queue over is currently an
operator step: read `queue[].wallet` from the feed record (or the rendered block) and screen those
wallets. **A `--wallets` flag on the screen is the obvious follow-up** and was deliberately left out
of this lane — it changes the screen's plan arithmetic and coverage semantics, and that belongs in a
change that owns those.

## Scope boundaries

- **Not a window-decay tripwire.** Detecting a window *closing* on a wallet we are currently trading is
  a different deliverable and it is built: `tools/window-decay-tripwire/`. Discovery finds the next wallet;
  the tripwire says leave the current one. The two must not be merged.
- **Not a recommendation.** Clearing this gate means *competent enough to be worth measuring*. Whether
  a deployer leaves an outsider any room, and whether that room is profitable, is **unmeasured here** —
  that is Stage 2, in `screen.mjs`, and it refuses our own subject deployer.
- **Zero-token.** Plain Node on the 20 floor, no build step, no agent, no model call anywhere in the
  lane.
