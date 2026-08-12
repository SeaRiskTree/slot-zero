# The arrival-rate walk

**How often does a profitable opening window arrive, and how long does it last?**

`analysis/window-population/README.md` §8 asks the question and says why the committed tape cannot
answer it: **every one of its 239 launches is the same deployer**, and the 70-deployer control holds
one launch per creator with no dates and no P&L — **zero window observations**. The tape contains
one window, lasting 83 days. *n = 1*, and no further work on that tape produces a second one.

This tool builds the missing series: **the same per-launch measurement, for a cohort of prolific
deployers, over seven months each.** Captain decision 154d authorised it; decisions 164c and 165b fix
its shape.

**It is keyless throughout.** Its credential allow-list is empty and `test/arrival-rate-walk.test.ts`
enforces that, so the collector — which runs for days — structurally cannot spend money. Two Dune
executions stand behind a whole collection and **neither is issued from here**: the cohort's is
`tools/creation-census/`'s, and since captain decision 457a the launch list is a **by-product of a
deployer-screen run** rather than a statement anybody executes for this lane. Both statements are
committed; the count is unchanged and what moved is who issues the second one and under whose budget.

---

## The two decisions that shape it

### Persist the raw fills — decision 164c

The walk saves **every fill inside each window, every wallet**, not only the create slot's. Both the
create-slot-only series and the all-window-entrant series then come out of **one pass**, so the
definitional choice is settled against real numbers rather than in advance.

**Persisting the fills preserves the option; it does not repair the data.** The all-entrant reading
is a **floor** and is labelled one at the point of use: `series.mjs` → `ALL_ENTRANT_FLOOR_CAVEAT`
reaches the row, the CSV header (`all_entrant_prize_floor_sol_gross_of_fees`), `arrival.json` and the
plan. Closure is measured inside a bounded window, so an entrant arriving at second 55 of 60 has five
seconds to close; the loss falls disproportionately on **late** entrants, which is the population an
all-entrant reading is about. Over 626 create-slot outsider pairs the closure curve reads 0.588 at
10 s, 0.754 at 40 s, 0.776 at 60 s, 0.858 at 300 s and 0.947 at one hour.

One figure that does **not** apply here, and must not be quoted as though it did: the blast report's
69 pairs / 17.1 SOL all-entrant shortfall is caused by `readLaunchWindow` seeking a shorter distance
than its own membership filter. This walk has one bound (below), so that shortfall is structurally
absent from this tape. The floor label rests on window-boundedness alone.

### Seed from history, not from success — decision 165b

The cohort is **every deployer who created a launch in January 2026, above a stated threshold, taken
whole**, followed forward to today **with no filter on whether they are still active**.

Every seed this repository already has — MadeOnSol `recent-bonds`, `alerts`, the `bonding_rate` and
`total_bonded` leaderboards, a Dune `total_bonded` ranking — selects on current or lifetime
**success**. A deployer whose window opened, paid, closed and who then quit is in none of them. §8
asks *how often does a window arrive*; a sample drawn from wallets still going answers *how often
does a window arrive, given the operator is still going*. **Arrival rate biased up, duration biased
up, close rate biased down** — on the exact estimand, with nothing in the output revealing it. The
repo has already measured the neighbouring fact: `FEED.md` records that a wallet had been deploying
for a median of **≥132.7 days (max ≥857, n = 74)** before this project first saw it.

`COHORT_SQL` reads one month and nothing after it. That is asserted structurally over its executable
half — no join to the completion surface, no bonding term, no recency term — rather than promised.

**The threshold is chosen by a rule stated in advance**: the *lowest* threshold at or above the
pinned floor of 20 January launches whose cohort fits 20 deployers, and the set at that threshold is
taken whole. The ladder of every threshold considered is published with the result. That tunes the
**sample size**, which is legitimate and disclosed; it does not tune the finding, and segmentation
has no knob that could. **If January yields too few deployers the widening is backwards, into
December 2025 — never forwards.** Forward observation time is the scarcer resource.

---

## The cursor has ONE bound, in ONE unit

`tools/deployer-screen/pumpfun.mjs` → `readLaunchWindow` reaches forward from the mint with **two**
bounds in **two units**: a seek cursor in milliseconds and a membership filter at
`createSlot + windowSlotSpan` (slots). Until captain decision 144a nothing reconciled them but a
hardcoded nominal 400 ms/slot with about a second of headroom — and the chain has been slowing all
year, p50 389.0 ms/slot in 2025-12 against 418.0 in 2026-07, max observed 446.55. At that maximum the
declared 160-slot window is 71.4 s wide against the 65 s reach that cursor then had. The walk
reported `usable: true`, `reachedCreateSlot: true` and a note true in every clause, and never fetched
the tail.

**That instance is fixed and this section is not retired by the fix.** The cursor is now
`pumpfun.mjs` → `windowReachMs`, which converts the span in the span's own unit at a measured
worst-case slot rate (85,000 ms at the pinned values) and is re-derived from the committed tapes by a
test on every run. It owns the reach, the pages the wider reach costs and the launches it drops —
cite it rather than repeating any of those numbers here. But it is still a **conversion between two
units**, so it still has to hold each time the chain's slot rate moves.

`walk.mjs` copies `tools/graduated-life-tape/walk.mjs` instead: **`seekCursor(endMs)` is the seek and
`tsMs <= endMs` is the membership test.** One number, one unit, nothing for a drifting slot rate to
invalidate and nothing to re-check when it does. This was free — the walk is new code in a new
directory either way.

The other end carries **5,000 ms of floor slack**, because the declared mint instant is a different
clock from the fills' timestamps. See the pre-flight.

---

## The clock pre-flight — run it before anything long

Dune's `created_at` is the **chain's block time**; every fill's `ts` is the **vendor's**, at second
resolution. `readLaunchWindow`'s pre-mint tripwire compares the two with **zero slack** and its own
comment warns that a positive skew of one millisecond deletes the entire create slot — silently, and
on a non-random subset.

```bash
node tools/arrival-rate-walk/collect.mjs --phase preflight --out <dir>                      # leg A
node tools/arrival-rate-walk/collect.mjs --phase preflight --out <dir> --launch-list <file> # + leg B
```

**Result, 2026-08-03: the two clocks agree exactly on 12 of 12 launches spread across the committed
tape's whole range.** Twelve keyless requests, all answered 200. `preflight-2026-08-03.md` holds the
sample, the spend and the limits — chiefly that leg A infers Dune's column from its schema, while
**leg B reads that column directly, costs no request and no execution, and has not run** because no
launch-list export has been produced yet. Since captain decision 457a there is a route to one that
costs this lane nothing — a deployer-screen run over the cohort, see "Where the launch list comes
from" below — so leg B is now reachable rather than blocked. Run it before the collection.

The CLI exits **2** on a failing pre-flight. A collection is days long and this failure is silent.

---

## Running it

```bash
# 1. The cohort. One Dune execution, run by the census tool — nothing executes from this directory.
node tools/creation-census/run.mjs --month 2026-01 --min-launches 20 --max-rows 2000 --live

# 2. The launch list, as a BY-PRODUCT of a deployer-screen run over that cohort (decision 457a).
#    The screen gates the wallets it is given; the launch list falls out of the enumeration it was
#    going to do anyway. No execution belongs to this lane and none is added for it.
node tools/deployer-screen/screen.mjs --wallets <cohort-wallets.txt> --no-stage2 \
    --launch-list --out <record>

# 3. Cost the run. Issues NOTHING.
node tools/arrival-rate-walk/collect.mjs --phase plan --cohort <file> \
    --launch-list <file|dir> --launch-list-max-age-days <n>

# 4. Collect. Checkpoints every launch; re-running resumes.
node tools/arrival-rate-walk/collect.mjs --phase walk \
    --launch-list <file|dir> --launch-list-max-age-days <n> --out <dir> [--dry-run]

# 5. Derive both series and the windows. Offline.
node tools/arrival-rate-walk/collect.mjs --phase series --out <dir>
```

A cohort export may be handed over as the API's JSON envelope, a bare row array, or the browser's CSV
export — whichever the operator produced. `--launch-list` takes the same three for a raw export, or
the screen's by-product, or a DIRECTORY of by-products, in which case the newest is read.

### Where the launch list comes from, and why not from here

**This lane cannot fetch one, by construction.** It is keyless throughout, its credential allow-list
is empty and `test/arrival-rate-walk.test.ts` enforces both. PR 87 / decision 437a then required a
lane budget on every code path that spends a Dune credit, which left this leg with no guarded
execution path at all — it could not run. **Captain decision 457a closed that by having the deployer
screen's already-approved enumeration leg (`dune.mjs` → `enumerateCreations`) write its rows down**
rather than discard them, and by keeping this lane a reader of a file. The alternative — a second
guarded caller here — is the option the captain did not choose, and `test/launch-list-handover.test.ts`
is what keeps the implementation on the side that was chosen.

The by-product goes to `<data root>/screen-launch-lists/`, off-tree for the same reason `--out` is
(`config/data-root.mjs` owns the location), and `--launch-list` is what asks for it — **opt-in, on
retention grounds rather than cost grounds**, since the rows are already in the screen's memory when
it writes them and the write reaches no vendor. It costs **zero** in every currency.

`--wallets` (captain decision 398a) is what points the screen at THIS lane's cohort, and it matters
that the seed survives it: enumeration happens before the gate reads anything, so **a cohort wallet
the screen's own competence gate fails still has its launches enumerated** and decision 165b's
"take the month whole, no filter on success" is not narrowed by the screen's bar. What the list does
narrow on is our own coverage — a wallet the screen could not vouch for, which is a refusal below.

### The staleness rule, and what an absent list does

`launch-list.mjs` → `LAUNCH_LIST_STALENESS_RULE` is the text and it travels into `plan.json`. Cite it
rather than restating it; the shape is:

- **`generatedAtIso` is the observation ceiling.** Nothing after it was looked for, so a deployer that
  appears to have gone quiet at the ceiling may simply be beyond the list's reach. `arrival.mjs`
  measures observation from the first to the last MEASURED launch rather than from a wall clock, so an
  old list yields a **shorter** observation rather than the same one over fewer launches — but the
  last segment of every deployer is then censored by OUR file's age rather than by the deployer's
  behaviour, and nothing in the series itself can tell those apart.
- **The age is reported on every read**, and a list generated after the reading clock is REFUSED
  rather than given a negative age.
- **Past a maximum age the run STATES, the list is refused.** `--launch-list-max-age-days` is
  required for a by-product and **no default is pinned**: nothing measured here says how fast a
  screened deployer population goes stale, and a default would be a pin nobody chose. What the run
  applied is recorded in `plan.json` beside the result.
- **An absent or empty handover directory refuses**, with a sentence naming the screen invocation
  that fills it. `--launch-list` itself is still REQUIRED and is deliberately not defaulted to the
  handover directory: it names the POPULATION this run measures, and a walk that picked up whichever
  list happened to be newest would choose its own population silently.

Three refusals come from the screen's own reading of its answer and are adopted whole, because a list
that cannot vouch for itself is not a shorter list: a **failed enumeration leg**, an **unreadable
row** anywhere in the batch (which refuses the batch there, for the reason `parseCreationRows`
gives), and a **coverage probe that would not vouch for the create surfaces**. A fourth is
per-deployer: a wallet the screen marked `usable: false` — a capped prefix, a history reaching
outside the probed coverage — refuses the plan **only where this run means to walk it**, since one
screen batch is not this lane's cohort.

Two more are the DOCUMENT'S own integrity, and both are refusals rather than skips because the
`deployers` block is the only thing that says which wallets were asked about and which of them the
screen would gate on: an **entry that carries no readable wallet and status**, and a **wallet whose
rows are in `launches` with no entry of its own**. Either one leaves rows that nothing vouches for
while making them look vouched for — the invisible direction — so the reader refuses, matching the
writer-side rule that one unreadable row refuses the whole batch.

**The pre-flight is held to the same refusals the walk is, and LEG A IS MEASURED ANYWAY** (captain
decision 485). Leg B's clock check has no plan to carry them into, so `collect.mjs` →
`launchListRefusalReason` states the refusal and `runPreflight` refuses leg B with it: otherwise the
clock check could measure skew against a list whose enumeration leg failed, whose coverage probe
refused, or that is past the maximum age the run itself stated, and report `ok` from it. **Leg A
compares the chain clock against the vendor clock and opens no launch list at all**, so it runs first
and its verdict reaches `preflight.json` either way — a problem with a file leg A never reads may not
cost that measurement. `preflight.json` records leg B as `refused` with the reason rather than
`skipped`, which is the opposite finding. A refused list stops the phase on **exit 2**, the same code
a failing verdict uses, because the collection it gates runs for days and a wrapper should read one
number for one meaning.

**A list the pre-flight cannot read AT ALL goes down that same channel** (captain decision 486) —
no such directory, an empty handover directory, a by-product supplied with no
`--launch-list-max-age-days`, unreadable JSON, the wrong `kind` or `schemaVersion`, a name that
disagrees with the instant it declares, no `launches` array. Those used to throw past the phase for
exit 1, discarding leg A and writing no `preflight.json` at all, which is the same failure 485 named
one class over. `collect.mjs` → `launchListUnreadableReason` folds them in and carries the original
sentence verbatim, so *"this is not a launch list"* and *"we read it and refuse to walk it"* stay
legible apart. **The pre-flight alone gets this**: the plan and walk phases have nowhere to put a
verdict, so a list they cannot read still stops them.

### Bounds

Pinned in `bounds.json`, every value with a stated reason (a test enforces that, and *"no measurement
backs this, and here is what would"* is an acceptable reason — inventing an anchor is not).

| | |
|---|---|
| window | **60 s** from the mint, chosen for **comparability** with the published n = 1, not for coverage |
| pacing | **4 s** floor against `swap-api.pump.fun`, raisable and never undercuttable; **2.5 s** against `api.mainnet-beta.solana.com` |
| per launch | **40 attempts**, retries included — requests, not pages, because the endpoint sheds ~25% when pushed |
| per run | **20,000 attempts**, ~22 h of wall clock; the collector checkpoints, so this stops a run rather than losing one |
| per deployer | **600 launches**, above which the deployer is **refused from the plan rather than truncated** |
| pre-flight | **12 launches, 3 attempts each, 60 requests** |
| Dune | **2 executions, ~15 credits** of a 2,500/month free tier — one the census tool's, one a deployer-screen run's, **none this directory's** |

**Credits are not the binding constraint here; wall clock is.** A 15-deployer cohort at ~140 launches
each is ~2,100 launches, which at the measured p50 of 4 pages is ~8,400 requests and **days** of paced
fetching. §8 costed the same shape at 6,000–12,000 requests for ten deployers.

**A collection larger than one sitting is the shape, not a failure.** A p95 estimate above the run
ceiling is an **advisory** in the plan — it names how many sittings to expect and clears nothing;
refusing it would make this lane's own target cohort unwalkable. Only `plan.refusals` stops a run,
and the run's real bound is the client's per-run ceiling, which stops a sitting exactly and leaves it
resumable. **Resume re-attempts an unproved walk**: a sidecar is skipped only when `reached_mint` is
`true`, so a truncation or a transport failure costs that launch one more sitting rather than
permanently marking it unmeasured — and the loss would not have been random, since a busy launch
issues more requests and busy launches are the high-prize tail. The failed attempt's own evidence
(`stop_reason`, `requests`, `pages`) is carried forward in the sidecar's `previous_attempts`.

### The census that runs this statement

**`COHORT_SQL` is deployed as saved Dune query `8214953`** (2026-08-04, captain decision 187a) and
`bounds.json` → `dune.cohortQueryId` pins it. This directory still executes nothing — it is keyless
throughout and a test keeps it that way — so the statement's keyed half is
**`tools/creation-census/`**, which verifies the saved query against the committed text before every
execution and writes a result `cohort.mjs` → `readDuneResultFile` reads unchanged:

```bash
node tools/creation-census/run.mjs --month 2026-01 --min-launches 20 --max-rows 2000 --live
```

**This section used to say the opposite, and the opposite was false.** It recorded the cohort stage
as blocked because the free tier's ten private query slots were full and the account held ten. The
account held **eight**, six of them retired scratch probes, and that sentence is why the stage sat
blocked for a month (`data/slot-zero-discovery-widen-operations/report.md` §2.1). Do not take the
replacement on faith either: the slot usage is **re-checkable** with a keyed
`GET https://api.dune.com/api/v1/queries?limit=100` (header `X-Dune-API-Key`), whose `total` field is
the figure, and `tools/creation-census/run.mjs` → `readSavedQueries` reads it live immediately before
creating anything rather than asserting a count a reader has to trust.

The census tool's **default month is 2026-07, not this lane's 2026-01** — discovery wants deployers
that are screenable today, a walk wants forward observation time — so this lane's month is passed
explicitly, as above. One census month is one execution.

Everything else in the lane is deployed and exercised: the launch list comes off the screen's own
enumeration of that same saved query `8204672`, **unchanged**, and the walk, the series and the
arrival measurement are proven on a bounded sample (below).

**Deploying the committed SQL is half a change.** If `COHORT_SQL` is edited here, the saved query must
be updated in place in the same commit, and whatever executes it must compare the two first — exactly
as `dune.mjs` → `assertSavedQueryMatches` does for the screen's two. A saved query is editable from a
browser and this one decides which deployers the whole measurement is about.

---

## Proven on a bounded sample, 2026-08-03

Not a full run — the collection is a separate step. What was proven, and with what spend:

| check | result | spend |
|---|---|---|
| Clock pre-flight, leg A | **12 / 12 launches, skew 0 ms**, 2025-12 to 2026-07 | 12 keyless requests |
| Walk against the primary record | **5 / 5 create slots agree** with the committed window tape, and the fill count inside the same bounds matches **exactly** on all five (263, 539, 600, 471, 447) | 25 keyless requests, **0 shed**, 0 truncated |
| P&L arithmetic | **1,057 (wallet, launch) pairs**, max realised difference **5e-7 SOL**, **2** closure differences | offline |
| Segmentation | reproduces §4.1's **both** break dates on **both** metrics, §4.3's three regimes and §5's **82.7-day** window and 24.7-hour close | offline |

**Total network spend across the whole proof: 37 keyless requests. Zero keyed requests, zero Dune
executions.**

The two closure differences are a **deliberate** divergence from the committed dataset and they run
one way: both are wallets that **sold inside the window having bought nothing in it**. The dataset
reads residual 0 as closed, giving them `realised = sol_out − 0` — a positive P&L on a position never
opened. This tool requires `tokensBought > 0`, exactly as `tools/deployer-screen/entry.mjs` does, and
reports them **open**. They cannot reach the create-slot series at all (that population is drawn from
create-slot *buys*), so the difference lands only on the all-entrant reading, in the direction that
refuses to book free money.

---

## What this tool cannot answer

The honest list, in the order that matters.

- **It cannot see a deployer Dune's decoded surfaces do not hold.** Discovery is 100% Dune-derived, so
  a creation neither `pump_evt_createevent` nor `pump_call_create` decoded is **invisible, not
  absent**. The cohort ships with its own coverage evidence and a reading that cannot vouch for
  itself is refused rather than published — but a surface that is silently *incomplete* within its
  own declared span is not something any probe here would catch.
- **Dune attributes on the SIGNER, so an operation that rotates signers becomes several deployers.**
  That is the right call against `creator`, a settable `CreateV2` argument that six bot-signed mints
  use to name our own subject. It cuts the other way here: a fragmented operation appears as several
  rows with a fraction of the launches each, and at a minimum segment of 8 a sufficiently fragmented
  one **can never show a window at all**.
- **Everything is GROSS OF FEES and is therefore an upper bound.** No leg of this lane prices a
  transaction. On the committed tape the same population read +0.396 per SOL gross inside the window
  and **0.540 of that** once priced. A window that is marginal gross is not a window net.
- **`roomIsProven` has a steep time gradient, so the OLD end of every series is less measurable.** A
  launch whose create slot carries no 2+ wallet transaction is **unmeasured, never zero** (decision
  134a). This lane keeps that shared-transaction predicate on purpose where the screen's has since
  widened to a union (decision 182a); `series.mjs` → `roomIsProven` owns why. On the graduated 102 the proven rate runs 0.000 in 2025-12, 0.375 in 2026-03 and 1.000 from
  2026-05. If that gradient is venue-wide rather than one operator's submission habit, **a window that
  opened early is systematically less visible than one that opened late** — which is a bias on
  exactly the quantity this lane measures, and this lane does not measure the gradient.
- **A measured launch with no closed create-slot round trip is EXCLUDED from the rank test, not read
  as a zero.** Its stake is zero, so §2.1's return per SOL does not exist for it. The exclusion is
  exactly the published measurement's (`analysis/window-population/measure.mjs` segments over
  launches with at least one closed create-slot round trip). `series.mjs` → `toSeriesPoints` is the
  one place it happens, `arrival.json` carries the count as
  `launchesExcludedNoClosedCreateSlotPair`, and the reproduction test drives the published series
  through **that** function. The sentence that travels with the count is one string —
  `series.mjs` → `ZERO_CLOSED_PAIR_EXCLUSION_CAVEAT` — quoted here verbatim, and a test pins the two
  copies together so they cannot drift:

  > A measured launch with NO closed create-slot outsider round trip is EXCLUDED from the rank test rather than entered as a 0, which is the exclusion the published measurement makes; 0 is a real level in this series. THE PUBLISHED MAGNITUDE FOR THAT CHOICE WAS MEASURED OVER A NARROWER POPULATION: section 11 reads it over the 25 launches with no outsider in the create slot AT ALL, where imputing zeros lowers the window's median prize by roughly a fifth and moves neither break. What is excluded here is wider — every launch with no CLOSED create-slot round trip, which on the committed tape is 42: those 25 plus 17 that had outsiders and closed none. Over that wider set the imputation is not harmless, and this lane's own reproduction test measures it: the imputed zeros flatten the level enough that no break is detected and the published window disappears entirely. Both readings are true of their own population, and neither figure may be quoted as the other. The excluded launches stay rows in series.csv, because attendance is evidence even when P&L is not.

- **A launch the collector cannot prove is retried, but only so many times.** An unproved sidecar is
  re-offered on the next sitting; at `walk.maxWalkAttemptsPerLaunch` recorded attempts the launch is
  done and its sidecar's `given_up_reason` says *we stopped trying*, not *we never tried*. Without
  that cap a permanently-unwalkable launch — a mint the endpoint 404s, or one whose pages never say
  nothing is older — re-spends a whole per-launch budget on every sitting, ahead of launches never
  attempted. Capped launches are counted in `arrival.json` as `launchesGivenUpAtAttemptCap`. **The
  cap changes when we stop spending, not what the launch means**: still unproved at series time is
  UNMEASURED, and never a zero.
- **A deployer with too few measured launches is UNSEGMENTABLE, and that is not "no window
  arrived".** A split needs 20 measured launches at the pinned minimum segment of 8. Those deployers
  are excluded from the arrival-rate denominator and counted in the output — and the exclusion drops
  the **shortest-lived** deployers, which the historical seed exists to include. The seed removes the
  survivorship conditioning at discovery; this reintroduces a weaker form of it at measurement, and
  no amount of care in the seed fixes it.
- **Censoring is flagged, not corrected.** A window that is the first segment may have opened before
  observation began; one that is the last may still be open. Their durations are **lower bounds** and
  are reported apart from the measurements rather than pooled with them.
- **The window's closure is bounded at 60 s, so roughly a fifth of create-slot round trips are still
  open when it ends.** The published series has the same property, which is why it was chosen — but it
  means "profitable" is measured on the pairs that closed fast.
- **Neither the cohort nor the series says anything about *unaffiliated*.** "No on-chain relationship
  on complete sets" is not "provably unrelated": shared custodial venues are invisible to on-chain
  evidence. `README.md` → "The ceiling of the method: shared custodial venues" owns that claim and
  this tool does not widen it.
- **The one-bound cursor removes a defect class; it does not make the tape complete.** Coverage at the
  oldest end is *proved* per launch (`reached_mint`) and a launch the request ceiling cuts short is
  discarded whole — because a truncated walk holds the earliest entrants by slot, which is a biased
  sample rather than a short one.

### And one with a shelf life

The 2026-07 slot rate is the newest thing the blast report measured and the trend is upward. Nothing
in *this* tool depends on a nominal slot rate — that is the point of the single bound — but anything
that reads its output alongside the deployer screen's is comparing against a walk that does.
